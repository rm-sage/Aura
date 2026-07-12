// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import { loadAuraSettings, saveAuraSettings, getSettingsUpdatedAt, setSettingsUpdatedAt, bumpSettingsUpdatedAt, type AuraSettings, DEFAULT_AURA_SETTINGS } from "./auraSettings";
import { encryptForCloud, decryptFromCloud, isEncryptedBlob, type EncryptedBlob } from "./syncCrypto";
import { getHistory, setAllHistory, type HistoryEntry } from "./historyStore";
import { isWindowHidden, subscribeWindowVisibility } from "./windowVisibility";
import { safeSetItem } from "./storageQuota";

// ---------------------------------------------------------------------------
// Aura Cloud sync orchestrator (frontend)
//
// Round-trips per-account state through the proxy under a sha256-derived
// scope hash that the Rust side derives from the active Stremio
// auth_key. The Rust commands (sync_pull / sync_push / sync_pull_all /
// sync_status / sync_delete / sync_purge) are namespace-agnostic; this
// module owns:
//
//   1. Mapping each namespace to the local store it shadows
//      (localStorage key, Tauri command, in-memory module, etc.).
//   2. Per-namespace merge semantics. Different stores need different
//      strategies on conflict (see ROADMAP §7.5):
//
//         settings        — last-writer-wins per top-level key
//         manual-state    — union with tombstone-aware deletions
//         auto-bumped     — union of IDs (a finished series is finished
//                           on every device)
//         notifications   — union dedup'd on (kind, id, ts), capped 100
//         recent-searches — server-wins (cheap, not worth merging)
//         title-state     — per-title last-writer-wins
//         anilist-id-map  — union; on per-id conflict, the entry with
//                           more episodes wins (multi-season disambig)
//
//   3. Debounced push triggers wired to the existing change events
//      (`aura:settings-changed`, `aura:manual-state-changed`, etc.).
//
//   4. Pull-on-login orchestration triggered from App.tsx when
//      `session?.auth_key` flips from null to set, OR when the
//      active session changes.
//
// Sync is paused while playback is active so the per-frame work stays
// clear of network I/O. Pushes that fire during playback queue and
// flush on the first pause OR on `aura:playback-ended`.
// ---------------------------------------------------------------------------

// ── Wire types (mirror sync.rs) ──────────────────────────────────────────

export interface SyncBlob {
  namespace: string;
  data: unknown;
  etag: string;
  updated_at: number;
}

export interface PushResult {
  etag: string;
  updated_at: number;
}

export type PushOutcome =
  | { status: "ok"; etag: string; updated_at: number }
  | { status: "conflict"; server: SyncBlob };

/** Mirror of `sync.rs::PullOutcome`. Carries per-namespace pull results
 *  with 304 short-circuit information distinguished from 200 / 404. */
export type PullOutcome =
  | { status: "fresh"; blob: SyncBlob }
  | { status: "not_modified"; namespace: string; etag: string }
  | { status: "missing"; namespace: string };

export interface NamespaceStatus {
  name: string;
  etag: string | null;
  updated_at: number | null;
  size: number | null;
}

export interface SyncStatus {
  connected: boolean;
  namespaces: NamespaceStatus[];
  total_size: number;
  quota: number;
}

// ── Namespace registry ───────────────────────────────────────────────────

export const SYNC_NAMESPACES = [
  "settings",
  "manual-state",
  "auto-bumped",
  "notifications",
  "recent-searches",
  "title-state",
  "anilist-id-map",
  "history",
] as const;

export type SyncNamespace = (typeof SYNC_NAMESPACES)[number];

// localStorage keys for namespaces that shadow a JS-side store.
// `settings` is special: it merges the backend AppSettings (Tauri-side)
// AND the frontend auraSettings (localStorage) into one blob. `title-
// state` and `anilist-id-map` live entirely on the Rust side.
const LOCAL_KEYS: Partial<Record<SyncNamespace, string>> = {
  "auto-bumped":     "aura:auto-bumped-series:v1",
  notifications:     "aura:notifications:v1",
  "recent-searches": "aura:recent-searches",
};

// ── ETag tracker ─────────────────────────────────────────────────────────
//
// Per-namespace ETag of the last successful pull or push. Two roles:
//
//   1. PUSH: passed as If-Match so the proxy rejects concurrent writes
//      from another device with 412 Precondition Failed.
//   2. PULL: passed as If-None-Match so the proxy short-circuits with
//      304 Not Modified when the blob hasn't changed. Cuts read-side
//      bandwidth to near-zero on the steady-state 5-min background tick
//      (was ~6 KB/h per scope on history alone).
//
// Persisted to localStorage under a per-account key so the short-circuit
// survives app restarts — without persistence the first pull after every
// launch refetches every namespace even when nothing changed. Cleared on
// account switch (clearSyncEtags) so a new account doesn't carry forward
// the previous one's etags.

const lastEtag: Map<SyncNamespace, string> = new Map();
const ETAG_STORAGE_PREFIX = "aura:sync:etags:";

function etagStorageKey(): string {
  return `${ETAG_STORAGE_PREFIX}${activeScope()}`;
}

/** Pull persisted etags for the active scope into the in-memory Map.
 *  Idempotent — clears the Map first so a scope switch always starts
 *  from a clean slate. */
function loadEtagsForActiveScope(): void {
  lastEtag.clear();
  try {
    const raw = localStorage.getItem(etagStorageKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const ns of SYNC_NAMESPACES) {
      const val = (parsed as Record<string, unknown>)[ns];
      if (typeof val === "string" && val.length > 0) {
        lastEtag.set(ns, val);
      }
    }
  } catch {
    // Corrupt JSON / quota error — fall through with an empty Map; the
    // next pull just fetches everything fresh and re-stamps the entry.
  }
}

/** Persist the current Map state for the active scope. Called whenever
 *  we mutate `lastEtag` from a successful pull or push. Guard for guest
 *  scope: persisting under "guest" is fine because clearSyncEtags will
 *  wipe it on sign-in anyway, and a guest can still see 304 benefits
 *  within a single session. */
function persistEtags(): void {
  const obj: Record<string, string> = {};
  for (const [ns, etag] of lastEtag) obj[ns] = etag;
  if (Object.keys(obj).length === 0) {
    try { localStorage.removeItem(etagStorageKey()); } catch { /* ignore */ }
    return;
  }
  // Via safeSetItem so a full origin evicts a disposable cache and retries: a
  // silently-dropped etag blob defeats the If-None-Match 304 short-circuit, so
  // EVERY sync namespace re-pulls in full on the next launch (slow cold start).
  safeSetItem(etagStorageKey(), JSON.stringify(obj));
}

export function clearSyncEtags(): void {
  // Drop the persisted blob for the OUTGOING scope before we mutate
  // _activeScope — otherwise the removeItem in persistEtags would land
  // on the wrong key. Callers typically pair clearSyncEtags with a
  // following setSyncActiveScope, so the order matters.
  try { localStorage.removeItem(etagStorageKey()); } catch {}
  lastEtag.clear();
  // Reset the pull min-interval guard too — a fresh account swap
  // should pull immediately, not wait out a 30s floor that was set
  // by the previous account's pull.
  lastPullCompletedAt = 0;
  // ALSO drop any pending debounced pushes. Otherwise a 5s push timer
  // armed under account A can fire after the user signed into B,
  // which would force-overwrite B's cloud blob with A's local data
  // (the if_match was just cleared, so the proxy accepts it without
  // a conflict). Clearing the timers here keeps the auth-transition
  // boundary clean.
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
}

// ── Active scope tracker ─────────────────────────────────────────────────
//
// The Rust side derives the per-account scope hash from the current
// Stremio session for sync requests, but the JS side ALSO needs the
// scope prefix to pick the right `aura:manual-state:user-<hex>`
// localStorage entry to write inbound merged data into. On a fresh
// device first login there is no existing manual-state entry, so a
// previous "scan localStorage for any matching key" approach silently
// dropped the pulled blob.
//
// `setSyncActiveScope` is called from App.tsx::applySettingsScope
// whenever the active session changes. Mode here is "user-<hex>" or
// "guest" (matching the existing manualWatched scope convention) so
// downstream code can construct the storage key directly.

let _activeScope: string = "guest";

export function setSyncActiveScope(scope: string | null): void {
  const next = scope && scope.trim() ? scope : "guest";
  if (next === _activeScope) return;
  _activeScope = next;
  // Rehydrate the per-namespace etag Map from this scope's persisted
  // entry so an app restart can immediately use If-None-Match on the
  // first pull. clearSyncEtags wipes the previous scope's storage
  // before this point on a real account switch; on a same-scope
  // re-call (no-op guarded above) we'd skip the reload to avoid
  // clobbering in-memory etags freshly written by a just-completed
  // pull or push.
  loadEtagsForActiveScope();
}

function activeScope(): string { return _activeScope; }

// ── Per-namespace merge strategies ───────────────────────────────────────
//
// Each merge function takes (local, server) and returns the merged
// result. On a clean pull-on-login (no local divergence), local equals
// the deserialized stored value at module load time and server is what
// the proxy returned; the merger picks the right side per namespace.
//
// On a 412 conflict from a push, local is the in-memory state we tried
// to push, server is the proxy's current version. The merger produces
// the value to retry the push with.

type MergeFn<T = unknown> = (local: T, server: T) => T;

// Defensive shape guards used by individual mergers. The proxy is a
// trusted endpoint, but a corrupted blob (rare but possible after a
// schema-incompatible sync between two Aura builds, or a manual API
// poke) could otherwise be propagated into local state and persist
// forever. Mergers fall back to LOCAL when the server value fails its
// shape check; the next push will overwrite the server with the
// client's known-good shape.

function isStringStateArray(v: unknown): v is Array<[string, string]> {
  return Array.isArray(v) && v.every(
    (e) => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string",
  );
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const mergeServerWinsRecentSearches: MergeFn = (local, server) => {
  // recent-searches is just an array of strings. If the server hands
  // us anything else we keep local rather than overwrite the user's
  // history with garbage (loadRecents() would reject the bad value
  // on read but the BAD value would still relay back on the next push).
  return isStringArray(server) ? server : local;
};

const mergeServerWinsTitleState: MergeFn = (local, server) => {
  // title-state is a HashMap<String, TitleState>. set_all_title_state
  // on the Rust side errors hard on type mismatch; that error gets
  // swallowed by writeLocal and the next push reads the now-empty map
  // and overwrites the cloud with empty. Validate before trusting.
  return isPlainObject(server) ? server : local;
};

const mergeSettings: MergeFn<{ backend: Record<string, unknown>; frontend: AuraSettings; updated_at: number }> = (local, server) => {
  // Last-writer-wins on the whole blob, since per-key timestamps are
  // not currently persisted. Acceptable trade-off for v1: the user
  // either changes settings on device A or device B, not both
  // simultaneously, and the 5s push debounce + scheduled background
  // pull means cross-device drift windows are small. Future work:
  // attach per-key updated_at to make this finer-grained.
  return (local.updated_at ?? 0) > (server.updated_at ?? 0) ? local : server;
};

const mergeAutoBumped: MergeFn<string[]> = (local, server) => {
  // A series the user finished on EITHER device should stay finished
  // everywhere. Union semantics: dedupe by string identity.
  const set = new Set<string>([...(local ?? []), ...(server ?? [])]);
  return Array.from(set);
};

interface NotificationEntry {
  kind?: string;
  id?: string;
  /** Persisted notifications carry `createdAt` (NotificationsContext shape).
   *  `ts` was the previous merger's expectation but no producer ever emits it,
   *  so reading from it here meant every entry collapsed to ts=0 and the
   *  sort + cap behaved as insertion-order with a silent 200→100 truncation
   *  on every cross-device pull. Use createdAt; fall back to 0. */
  createdAt?: number;
  /** User-action flags. Mirrored to the proxy so a dismiss on one
   *  device propagates to the others on next pull. Eviction during
   *  the merge cap respects `dismissed` the same way the local
   *  capItems does. */
  dismissed?: boolean;
  read?: boolean;
  [k: string]: unknown;
}

/** Match NotificationsContext::MAX_ITEMS so a sync round-trip can't
 *  silently halve the user's bell ring buffer. The two layers MUST
 *  agree on this number, AND the eviction policy must mirror — see
 *  the local capItems for the rationale. */
const NOTIFICATION_MAX = 200;
/** Hard ceiling on undismissed entries even within the sync merge.
 *  Above this we drop oldest undismissed too — matches the local
 *  ABSOLUTE_MAX guard against runaway growth from a misbehaving
 *  addon spam. */
const NOTIFICATION_ABSOLUTE_MAX = 1000;

/** Drop `kind: "update"` entries from a notifications blob in either
 *  direction. Update notifications announce the version of the local
 *  Aura install — Device A sitting on 0.6.6 should not advertise its
 *  pending 0.6.7 update to Device B (which might already be on 0.6.8
 *  or higher). The auto-updater on each device produces its own
 *  device-local update notification at the right time; nothing about
 *  cross-device sync helps here. The local store still keeps update
 *  entries (the persist effect writes the full list including them),
 *  this filter only gates the cloud round-trip. */
function stripUpdateKinds(blob: NotificationEntry[] | null | undefined): NotificationEntry[] {
  if (!Array.isArray(blob)) return [];
  return blob.filter((n) => n.kind !== "update");
}

const mergeNotifications: MergeFn<NotificationEntry[]> = (local, server) => {
  // Union with deduplication on (kind, id) — `createdAt` is excluded
  // from the key because the same logical notification can have
  // different timestamps on two devices that scanned the same episode
  // a few seconds apart. (kind, id) is the stable identity. On
  // conflict, prefer the newer-createdAt entry — that carries the
  // user's most recent read/dismissed flag state.
  //
  // Update notifications are filtered out before merging: the cloud
  // path doesn't carry them. Local update entries (held only in the
  // user's local store via the persist effect) are NOT included in
  // `local` here either — the wrapper around `mergeNotifications`
  // strips updates before the merger ever sees them.
  const all = [...stripUpdateKinds(server), ...stripUpdateKinds(local)];
  const byKey = new Map<string, NotificationEntry>();
  for (const entry of all) {
    const key = `${entry.kind ?? ""}::${entry.id ?? ""}`;
    const prev = byKey.get(key);
    if (!prev || (entry.createdAt ?? 0) > (prev.createdAt ?? 0)) {
      byKey.set(key, entry);
    }
  }
  const sorted = Array.from(byKey.values())
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (sorted.length <= NOTIFICATION_MAX) return sorted;

  // Eviction: undismissed items survive the soft cap (subject to the
  // absolute max). Dismissed items fill remaining slots newest-first.
  // Mirror of capItems in NotificationsContext — keeping these in
  // lock-step is the only way a cross-device merge doesn't silently
  // drop notifications the user hasn't acknowledged.
  const undismissed = sorted.filter((n) => !n.dismissed);
  const dismissed   = sorted.filter((n) =>  n.dismissed);
  const keptUndismissed = undismissed.slice(0, NOTIFICATION_ABSOLUTE_MAX);
  const slotsLeft = Math.max(0, NOTIFICATION_MAX - keptUndismissed.length);
  return [...keptUndismissed, ...dismissed.slice(0, slotsLeft)];
};

// manualWatched.ts persists as Array<[id, state]> pairs to preserve
// insertion order (the Queue tab depends on it). The shape doesn't
// carry per-entry timestamps, so we can't do real last-writer-wins
// at the entry level. Instead we union the two arrays, prefer the
// LOCAL state on per-id conflicts (the device the user is actively
// using is more likely to have the fresh value), and preserve LOCAL
// insertion order for any local-only entries before appending server-
// only entries at the tail. Future revision: attach per-entry
// timestamps and switch to true LWW.
type ManualMark = "watched" | "in-progress" | "planned";
type ManualState = Array<[string, ManualMark]>;

const mergeManualState: MergeFn<ManualState> = (local, server) => {
  // Defensive: bad server shape falls back to local. A push of the
  // local value will then replace the cloud's bad blob.
  const safeServer: ManualState = isStringStateArray(server) ? (server as ManualState) : [];
  const out: ManualState = [];
  const seen = new Set<string>();
  for (const [id, state] of local ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push([id, state]);
  }
  for (const [id, state] of safeServer) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push([id, state]);
  }
  return out;
};

interface AnilistMapEntry {
  anilist_id?: number;
  episodes?: number | null;
  fetched_at?: number;
}

const mergeAnilistIdMap: MergeFn<{ by_show?: Record<string, AnilistMapEntry> }> = (local, server) => {
  const a = local?.by_show ?? {};
  // Defensive: server might be missing or malformed; treat it as empty
  // so we don't blow up on `Object.entries(undefined)` and don't
  // propagate garbage downstream.
  const b = isPlainObject(server?.by_show) ? (server!.by_show as Record<string, AnilistMapEntry>) : {};
  const out: Record<string, AnilistMapEntry> = { ...b };
  for (const [showId, localEntry] of Object.entries(a)) {
    const serverEntry = out[showId];
    if (!serverEntry) {
      out[showId] = localEntry;
      continue;
    }
    // Per-id conflict: prefer the entry with more episodes (closer to
    // the canonical multi-season disambiguation). Ties go to whichever
    // was fetched more recently.
    const localEps  = localEntry.episodes  ?? 0;
    const serverEps = serverEntry.episodes ?? 0;
    if (localEps !== serverEps) {
      out[showId] = localEps > serverEps ? localEntry : serverEntry;
    } else {
      out[showId] = (localEntry.fetched_at ?? 0) >= (serverEntry.fetched_at ?? 0)
        ? localEntry
        : serverEntry;
    }
  }
  return { by_show: out };
};

interface HistoryWireEntry {
  id: string;
  played_at: string;
  [k: string]: unknown;
}

/** History merger — union by (id, played_at) so the same play
 *  captured on multiple devices dedupes, sorted newest-first, capped
 *  at 1000. Server entries iterate first so a local re-watch with
 *  the exact same timestamp (vanishingly rare, but cheap to handle)
 *  keeps the server copy's enrichment (poster URL etc) over a
 *  potentially sparser local row. */
const mergeHistory: MergeFn<HistoryWireEntry[]> = (local, server) => {
  const list: HistoryWireEntry[] = [];
  const seen = new Set<string>();
  const push = (e: HistoryWireEntry | undefined | null) => {
    if (!e || typeof e !== "object") return;
    if (typeof e.id !== "string" || typeof e.played_at !== "string") return;
    const key = `${e.id}::${e.played_at}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push(e);
  };
  if (Array.isArray(server)) for (const e of server) push(e);
  if (Array.isArray(local))  for (const e of local)  push(e);
  list.sort((a, b) => b.played_at.localeCompare(a.played_at));
  return list.slice(0, 1000);
};

// Per-namespace merge wiring. recent-searches and title-state use
// shape-validating server-wins (the previous unconditional server-wins
// could clobber local state when the server returned garbage).
const MERGERS: Record<SyncNamespace, MergeFn<any>> = {
  "settings":        mergeSettings as MergeFn<any>,
  "manual-state":    mergeManualState as MergeFn<any>,
  "auto-bumped":     mergeAutoBumped as MergeFn<any>,
  notifications:     mergeNotifications as MergeFn<any>,
  "recent-searches": mergeServerWinsRecentSearches,
  "title-state":     mergeServerWinsTitleState,
  "anilist-id-map":  mergeAnilistIdMap as MergeFn<any>,
  history:           mergeHistory as MergeFn<any>,
};

// ── Settings blob shape ───────────────────────────────────────────────────

interface BackendSettingsLite {
  // The full backend AppSettings struct is large and evolving; we
  // round-trip it as an opaque object. The Rust side validates on
  // import, so we don't need to type every field here.
  [key: string]: unknown;
}

interface SettingsSyncBlob {
  backend: BackendSettingsLite;
  frontend: AuraSettings;
  updated_at: number;
  /** Encrypted third-party API keys (OpenSubtitles).
   *
   *  Carried INSIDE the settings blob rather than as its own
   *  namespace specifically to avoid a coordinated proxy deploy —
   *  the proxy enforces a namespace allow-list (see
   *  docs/AURA_PROXY_V2_SPEC.md §4) so a new namespace would
   *  require a server-side rollout. Piggy-backing keeps it desktop-
   *  only.
   *
   *  Plaintext shape under the AES-GCM ciphertext:
   *    { opensubtitles?: string }
   *
   *  Devices that haven't yet backfilled user_id (offline first
   *  launch, /getUser failure) can't decrypt and gracefully drop
   *  the field — the local keyring is the source of truth in that
   *  case. */
  api_keys?: EncryptedBlob;
}

/** Names of the API keys we sync. Mirror of `SUPPORTED_KEYS` in
 *  `src-tauri/src/api_keyring.rs`. If you add a key on the Rust side,
 *  list it here too — the encryption layer just sees the JSON shape
 *  but the read/write paths use this list explicitly. */
const SYNCED_API_KEYS = ["opensubtitles", "tmdb"] as const;
type SyncedApiKeyName = typeof SYNCED_API_KEYS[number];

interface ApiKeysPlaintext {
  opensubtitles?: string;
  /** Optional TMDB key backing the story-arc grouping. Aura bakes its own key,
   *  so this is only set when the user chose to spend their own quota; syncing
   *  it means they set it once, not once per device. */
  tmdb?: string;
}

/** Pull the user_id off the keyring-resident session. Returns null
 *  when the session isn't present (guest mode) or hasn't yet
 *  backfilled user_id (offline first launch after upgrade). */
async function activeUserId(): Promise<string | null> {
  try {
    const sess = await invoke<{ user_id?: string | null } | null>("get_session");
    const id = sess?.user_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

async function readApiKeyBundle(): Promise<ApiKeysPlaintext> {
  const out: ApiKeysPlaintext = {};
  for (const name of SYNCED_API_KEYS) {
    try {
      const v = await invoke<string>("get_api_key", { name });
      if (typeof v === "string" && v.length > 0) out[name as SyncedApiKeyName] = v;
    } catch {
      // Keyring miss / unsupported name — skip silently.
    }
  }
  return out;
}

async function writeApiKeyBundle(plain: ApiKeysPlaintext): Promise<void> {
  for (const name of SYNCED_API_KEYS) {
    const v = plain[name as SyncedApiKeyName];
    // Empty / undefined → clear the local keyring entry so a cross-
    // device "deleted on the other side" survives the round-trip.
    try {
      await invoke("set_api_key", { name, value: v ?? "" });
    } catch (e) {
      console.warn(`[sync] writeApiKeyBundle ${name} failed:`, e);
    }
  }
}

async function readBackendSettings(): Promise<BackendSettingsLite> {
  try {
    return await invoke<BackendSettingsLite>("get_settings");
  } catch {
    return {};
  }
}

async function applyBackendSettings(s: BackendSettingsLite): Promise<void> {
  if (!s || typeof s !== "object" || Object.keys(s).length === 0) return;
  try {
    // `update_settings` accepts a partial JSON patch; the Rust side
    // whitelists known fields and ignores anything outside that
    // surface, so feeding it a stale or unknown key is a no-op rather
    // than an error.
    await invoke("update_settings", { patch: s });
  } catch (e) {
    console.warn("[sync] applyBackendSettings failed:", e);
  }
}

async function readSettingsBlob(): Promise<SettingsSyncBlob> {
  const [backend, frontend, userId, apiKeys] = await Promise.all([
    readBackendSettings(),
    Promise.resolve(loadAuraSettings()),
    activeUserId(),
    readApiKeyBundle(),
  ]);
  let api_keys: EncryptedBlob | undefined;
  // Encrypt only when we have a user_id (cross-device-stable key
  // derivation input) AND at least one API key set locally. Guests
  // and pre-backfill sessions ride along with api_keys omitted —
  // the local keyring stays the source of truth on this device.
  if (userId && apiKeys.opensubtitles) {
    try {
      api_keys = await encryptForCloud(JSON.stringify(apiKeys), userId);
    } catch (e) {
      console.warn(`[sync] api-keys encrypt failed: ${String(e)}`);
    }
  }
  // updated_at is the persisted "last user-modified locally"
  // timestamp, NOT Date.now(). Stamping it on every read meant the
  // mergeSettings last-writer-wins comparison always picked local
  // (NOW > whatever the server pushed earlier), so the cloud's
  // settings were pulled, merged, then silently discarded. Bumps
  // happen in saveAuraSettings (frontend) and in the settings-
  // changed listener installed by installSyncTriggers (backend).
  return { backend, frontend, updated_at: getSettingsUpdatedAt(), api_keys };
}

async function writeSettingsBlob(blob: Partial<SettingsSyncBlob>): Promise<void> {
  if (blob.frontend) {
    // fromCloud: true suppresses the bumpSettingsUpdatedAt() inside
    // saveAuraSettings — we want the local stamp to inherit the
    // server's updated_at below, not re-stamp to "right now".
    //
    // Device-local view preferences are preserved across the pull instead of
    // being reset to the cloud blob's value: a stale/older server blob (or one
    // written before the field existed) would otherwise clobber the user's last
    // choice on this device, which read as "the grouping never remembers".
    // These are per-device UI prefs, not account data, so the local value wins.
    const local = loadAuraSettings();
    saveAuraSettings(
      {
        ...DEFAULT_AURA_SETTINGS,
        ...blob.frontend,
        airingGroupBy: local.airingGroupBy,
        airingSort: local.airingSort,
      },
      { fromCloud: true },
    );
  }
  if (blob.backend) {
    await applyBackendSettings(blob.backend);
  }
  // Decrypt the API-keys blob (if present) and persist the
  // contained values to the local OS keyring. Silently skips when
  // the blob is malformed, the schema version is unknown, or the
  // user_id isn't available locally — a fresh-device pull that
  // arrives before the user_id backfill completes can land
  // briefly in this state; the next pull (post-backfill) catches
  // up.
  if (blob.api_keys && isEncryptedBlob(blob.api_keys)) {
    const userId = await activeUserId();
    if (userId) {
      try {
        const pt = await decryptFromCloud(blob.api_keys, userId);
        const parsed = JSON.parse(pt) as ApiKeysPlaintext;
        await writeApiKeyBundle(parsed);
      } catch (e) {
        console.warn(`[sync] api-keys decrypt/apply failed: ${String(e)}`);
      }
    }
  }
  // Inherit the server's authoritative timestamp so the NEXT pull
  // sees `local.updated_at === server.updated_at` (tie → server
  // wins in the merger? No, equal returns server too because the
  // strict `>` check fails). Either way, subsequent pulls won't
  // re-clobber.
  if (typeof blob.updated_at === "number" && blob.updated_at > 0) {
    setSettingsUpdatedAt(blob.updated_at);
  }
}

// ── Local IO per namespace ────────────────────────────────────────────────

async function readLocal(namespace: SyncNamespace): Promise<unknown> {
  if (namespace === "settings") return readSettingsBlob();

  if (namespace === "title-state") {
    try { return await invoke("get_all_title_state"); } catch { return {}; }
  }
  if (namespace === "anilist-id-map") {
    try { return await invoke("get_anilist_id_map"); } catch { return { by_show: {} }; }
  }
  if (namespace === "manual-state") {
    return readManualStateAggregate();
  }
  if (namespace === "history") {
    // historyStore reads from its scoped localStorage entry — same
    // shape that flies on the wire (an array of HistoryEntry).
    return getHistory();
  }

  const lsKey = LOCAL_KEYS[namespace];
  if (!lsKey) return null;
  try {
    const raw = localStorage.getItem(lsKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeLocal(namespace: SyncNamespace, value: unknown): Promise<void> {
  if (value == null) return;

  if (namespace === "settings") {
    await writeSettingsBlob(value as Partial<SettingsSyncBlob>);
    return;
  }
  if (namespace === "title-state") {
    try { await invoke("set_all_title_state", { state: value }); } catch (e) {
      console.warn("[sync] writeLocal title-state failed:", e);
    }
    return;
  }
  if (namespace === "anilist-id-map") {
    try { await invoke("set_anilist_id_map", { map: value }); } catch (e) {
      console.warn("[sync] writeLocal anilist-id-map failed:", e);
    }
    return;
  }
  if (namespace === "manual-state") {
    writeManualStateAggregate(value as ManualState);
    return;
  }
  if (namespace === "history") {
    // silent: true keeps writeLocal off the aura:history-changed →
    // debouncedPush bus so a pull doesn't immediately schedule a
    // re-push of the same merged blob.
    setAllHistory(value as HistoryEntry[], { silent: true });
    return;
  }

  const lsKey = LOCAL_KEYS[namespace];
  if (!lsKey) return;
  try {
    // Notifications need an extra union step at write time. Between
    // the syncPullAll readLocal at the top of the merge and this
    // writeLocal here, the scanner can fire a fresh addNotification
    // (or an update can land via the dismiss-to-bell flow) which
    // persisted to localStorage AND rendered to React. Writing the
    // pre-add merged value would then clobber the freshly-written
    // disk row, AND the rehydrate event would push the clobbered
    // value back into React state. Re-reading current disk and
    // unioning closes the race. Other namespaces don't have
    // concurrent producers (settings/auto-bumped/recent-searches all
    // write in response to user actions, never autonomously while a
    // pull is in flight), so the extra read is targeted.
    if (namespace === "notifications") {
      const currentRaw = localStorage.getItem(lsKey);
      const current: unknown[] = currentRaw ? (JSON.parse(currentRaw) as unknown[]) : [];
      if (Array.isArray(current) && current.length > 0) {
        // Preserve local update notifications across the merge:
        // mergeNotifications strips kind:"update" by design (updates
        // are device-local, see stripUpdateKinds), so a naive merge
        // would silently drop the user's pending update banner the
        // moment a sync pull rehydrates the buffer.
        const localUpdates = (current as NotificationEntry[])
          .filter((n) => n.kind === "update");
        const merged = mergeNotifications(
          current as NotificationEntry[],
          value as NotificationEntry[],
        );
        // Re-attach local updates after the merge. Keep dedup-by-id
        // behavior so a repeat add isn't doubled (defensive — the
        // merge shouldn't have re-introduced any update entry given
        // stripUpdateKinds, but guard anyway).
        const seen = new Set(merged.map((n) => `${n.kind}::${n.id ?? ""}`));
        for (const u of localUpdates) {
          const key = `update::${u.id ?? ""}`;
          if (!seen.has(key)) merged.push(u);
        }
        merged.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        value = merged;
      }
    }
    localStorage.setItem(lsKey, JSON.stringify(value));
    // Notify in-window subscribers of the underlying store AND force
    // their in-memory mirrors to rehydrate from the freshly written
    // localStorage. Without the rehydrate, consumers that cache state
    // in module-scope variables (autoBumped's _cache, the
    // NotificationsContext React state) keep serving the pre-pull
    // values until reload. Dynamic imports keep this tree-shake-safe
    // and don't pull autoBumped/NotificationsContext into the test
    // surface for non-Tauri contexts.
    if (namespace === "auto-bumped") {
      import("./autoBumped").then((m) => m.reloadAutoBumpedFromStorage()).catch(() => {});
    } else if (namespace === "notifications") {
      window.dispatchEvent(new CustomEvent("aura:notifications-rehydrate"));
    }
  } catch (e) {
    console.warn(`[sync] writeLocal ${namespace} failed:`, e);
  }
}

// Manual-state lives under a per-account key (`aura:manual-state:<scope>`)
// where scope is the first 12 chars of the auth_key. We aggregate the
// active scope into the synced blob and unaggregate on write.

const MANUAL_STATE_PREFIX = "aura:manual-state:";

function activeManualStateKey(): string {
  // Always derive from the explicit active scope. The previous
  // "scan localStorage for any matching key" approach silently
  // returned null for fresh-device logins (no entry exists yet),
  // which made the pulled manual-state blob get dropped on the floor.
  return `${MANUAL_STATE_PREFIX}${activeScope()}`;
}

function readManualStateAggregate(): ManualState {
  const key = activeManualStateKey();
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ManualState) : [];
  } catch {
    return [];
  }
}

function writeManualStateAggregate(value: ManualState): void {
  const key = activeManualStateKey();
  try {
    localStorage.setItem(key, JSON.stringify(value));
    // Force the manualWatched.ts in-memory mirror to rehydrate. The
    // CHANGE_EVENT alone bumps the React re-render counter but
    // consumers re-read `_activeMap` which would still hold the
    // pre-pull contents. The dynamic import keeps sync.ts importable
    // from non-Tauri test contexts.
    import("./manualWatched").then((m) => m.reloadManualWatchedFromStorage()).catch(() => {});
  } catch (e) {
    console.warn("[sync] writeManualStateAggregate failed:", e);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

let pullAllInflight: Promise<void> | null = null;
/** True while a pull sweep is mid-merge. `syncPushNow` defers when set
 *  so a user mutation that fires DURING the pull doesn't get
 *  overwritten by the soon-to-land merged write. The push trigger
 *  fires again after the pull completes (either via a follow-up
 *  user action or via the next debounced push), so deferring here
 *  doesn't lose updates, only postpones them. */
let pullInFlight = false;
const deferredPushes: Set<SyncNamespace> = new Set();

/** Min interval between pulls of the SAME scope. The 5-min background
 *  tick is fine, but `applySettingsScope(authKey)` can fire repeatedly
 *  during auth churn (logout → login, session-expired retry, etc.)
 *  and each call kicks `syncPullAll` — without a guard you'd see
 *  back-to-back pulls within seconds. The coalesce-while-in-flight
 *  guard above only helps if calls overlap; this floor handles the
 *  back-to-back case. Cleared whenever `clearSyncEtags` runs (which
 *  is always paired with an account change), so a real account
 *  switch isn't deferred by a recent same-account pull. */
const PULL_MIN_INTERVAL_MS = 30_000;
let lastPullCompletedAt = 0;

/**
 * Pull every namespace and merge into local. Idempotent (concurrent
 * calls are coalesced into the same in-flight promise). Called from
 * App.tsx on session change and on the periodic background timer.
 *
 * Failures on individual namespaces are logged but don't abort the
 * sweep, matching the Rust side's best-effort intent.
 */
export function syncPullAll(): Promise<void> {
  if (pullAllInflight) return pullAllInflight;
  // Min-interval guard: if a successful pull completed less than
  // PULL_MIN_INTERVAL_MS ago (and the account hasn't changed since,
  // which would have called clearSyncEtags and reset the timestamp),
  // skip. This prevents auth-churn (logout/login, session-expired
  // refresh) from kicking back-to-back pulls.
  if (Date.now() - lastPullCompletedAt < PULL_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }
  pullInFlight = true;
  pullAllInflight = (async () => {
    try {
      // Snapshot the in-memory etag Map and forward as If-None-Match
      // per namespace so the proxy can short-circuit unchanged blobs
      // with 304. The Rust side maps each entry onto its namespace's
      // GET request and surfaces three outcomes: fresh (200 → merge
      // and re-stamp), not_modified (304 → keep cached state), missing
      // (404 → no server-side blob, drop any stale etag we hold).
      const etagMap: Record<string, string> = {};
      for (const [ns, etag] of lastEtag) {
        if (etag) etagMap[ns] = etag;
      }
      const outcomes = await invoke<PullOutcome[]>("sync_pull_all", {
        ifNoneMatch: etagMap,
      });
      let etagsMutated = false;
      for (const outcome of outcomes) {
        if (outcome.status === "fresh") {
          const blob = outcome.blob;
          const ns = blob.namespace as SyncNamespace;
          if (!SYNC_NAMESPACES.includes(ns)) continue;
          try {
            const local  = await readLocal(ns);
            const merger = MERGERS[ns];
            const merged = merger(local, blob.data);
            await writeLocal(ns, merged);
            if (lastEtag.get(ns) !== blob.etag) {
              lastEtag.set(ns, blob.etag);
              etagsMutated = true;
            }
          } catch (e) {
            console.warn(`[sync] merge ${ns} failed:`, e);
          }
        } else if (outcome.status === "not_modified") {
          // Cached blob is current. No merge, no write. Defensive: if
          // the server's echoed etag differs from what we sent (would
          // only happen on a header-rewriting intermediary canonical-
          // ising the form), align the stored value so the next
          // If-None-Match round-trips cleanly.
          const ns = outcome.namespace as SyncNamespace;
          if (SYNC_NAMESPACES.includes(ns) && outcome.etag && lastEtag.get(ns) !== outcome.etag) {
            lastEtag.set(ns, outcome.etag);
            etagsMutated = true;
          }
        } else if (outcome.status === "missing") {
          // 404 — server has no blob for this namespace. Drop any
          // local etag pointing at a vanished blob so the next pull
          // doesn't send a stale If-None-Match that the server would
          // ignore anyway, and a subsequent push can force-overwrite
          // without an If-Match round-trip.
          const ns = outcome.namespace as SyncNamespace;
          if (SYNC_NAMESPACES.includes(ns) && lastEtag.has(ns)) {
            lastEtag.delete(ns);
            etagsMutated = true;
          }
        }
      }
      if (etagsMutated) persistEtags();
    } catch (e) {
      console.warn("[sync] pull_all failed:", e);
    } finally {
      pullInFlight = false;
      pullAllInflight = null;
      lastPullCompletedAt = Date.now();
      // Flush any pushes that were deferred while the pull held the
      // gate. We schedule them through the normal debounce so the
      // 5s rate-limiting still applies (otherwise a flurry of marks
      // during a pull would all push at once).
      const flushed = Array.from(deferredPushes);
      deferredPushes.clear();
      for (const ns of flushed) debouncedPush(ns);
    }
  })();
  return pullAllInflight;
}

/**
 * Push a single namespace. On 412 conflict, fetches the server version,
 * merges per the namespace's strategy, and retries the push with the
 * new ETag. Returns void; failures are logged but not surfaced (sync
 * is best-effort). Intended for use from debounced change-event
 * listeners; immediate-write callers (e.g. user-triggered "Push now")
 * should call `syncPushNow` to surface errors instead.
 */
export async function syncPush(namespace: SyncNamespace): Promise<void> {
  try {
    await syncPushNow(namespace);
  } catch (e) {
    console.warn(`[sync] push ${namespace} failed:`, e);
  }
}

/** Sanitize a local blob before sending it to the cloud. The
 *  notifications namespace is the only one with device-local data
 *  the proxy must never see — `kind: "update"` entries announce the
 *  current device's pending Aura release and would surface stale
 *  banners on every other device on next pull. Strip them here so
 *  the wire blob is cross-device-portable; the local store keeps
 *  the full list including updates. */
function sanitizeForPush(namespace: SyncNamespace, local: unknown): unknown {
  if (namespace === "notifications" && Array.isArray(local)) {
    return (local as NotificationEntry[]).filter((n) => n.kind !== "update");
  }
  return local;
}

/** Push a namespace, surfacing errors to the caller. */
export async function syncPushNow(namespace: SyncNamespace): Promise<void> {
  // Defer if a pull sweep is mid-merge: pushing local state while
  // pull is about to overwrite it would either (a) race the merger
  // and lose the user's mutation, or (b) push pre-merge state and
  // get a 412 we'd then try to resolve against the in-progress pull.
  // Deferring queues the push for execution after the pull settles.
  if (pullInFlight) {
    deferredPushes.add(namespace);
    return;
  }
  const local = await readLocal(namespace);
  if (local == null) return; // nothing to push yet
  const ifMatch = lastEtag.get(namespace) ?? null;
  const result = await invoke<PushOutcome>("sync_push", {
    namespace,
    data: sanitizeForPush(namespace, local),
    ifMatch,
  });
  if (result.status === "ok") {
    lastEtag.set(namespace, result.etag);
    persistEtags();
    return;
  }
  // 412 conflict: merge server into local, retry push with the
  // server's etag so the proxy accepts the merged result.
  const merger = MERGERS[namespace];
  const merged = merger(local, result.server.data);
  await writeLocal(namespace, merged);
  const retry = await invoke<PushOutcome>("sync_push", {
    namespace,
    data: sanitizeForPush(namespace, merged),
    ifMatch: result.server.etag,
  });
  if (retry.status === "ok") {
    lastEtag.set(namespace, retry.etag);
    persistEtags();
  } else {
    // Two consecutive conflicts is rare (third device writing
    // mid-merge). Drop the etag so the next attempt force-overwrites;
    // the user's local state wins.
    lastEtag.delete(namespace);
    persistEtags();
    console.warn(`[sync] push ${namespace} conflicted twice; force-overwrite next attempt`);
  }
}

/** Drop one namespace from the proxy. */
export async function syncDelete(namespace: SyncNamespace): Promise<void> {
  await invoke("sync_delete", { namespace });
  lastEtag.delete(namespace);
  persistEtags();
}

/** Drop every blob for the active account and clear local etags. */
export async function syncPurge(): Promise<void> {
  await invoke("sync_purge");
  clearSyncEtags();
}

/** Query the proxy for the current per-namespace status. */
export async function syncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_status");
}

// ── Auto-push triggers ───────────────────────────────────────────────────

const PUSH_DEBOUNCE_MS = 5000;
const debounceTimers: Map<SyncNamespace, ReturnType<typeof setTimeout>> = new Map();

function debouncedPush(namespace: SyncNamespace): void {
  const existing = debounceTimers.get(namespace);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    debounceTimers.delete(namespace);
    void syncPush(namespace);
  }, PUSH_DEBOUNCE_MS);
  debounceTimers.set(namespace, t);
}

let triggersInstalled = false;

/**
 * Install change-event listeners that schedule debounced pushes for
 * each namespace. Idempotent. Call once from App.tsx after the first
 * `syncPullAll` completes so we don't push the local state back over
 * the version we just pulled.
 */
export function installSyncTriggers(): void {
  if (triggersInstalled) return;
  triggersInstalled = true;

  // Bump the persisted settings updated_at on every local change
  // event — covers manual-dispatch sites (SettingsView's
  // update_settings invoke, AniSkipMenu, PlayerOverlay,
  // userDataBackup restore) that don't route through saveAuraSettings.
  // Skipped when detail.fromCloud is true so the cloud-pull write
  // path doesn't fight the merger.
  window.addEventListener("aura:settings-changed", (e) => {
    const detail = (e as CustomEvent<{ fromCloud?: boolean }>).detail;
    if (!detail?.fromCloud) bumpSettingsUpdatedAt();
  });

  window.addEventListener("aura:settings-changed",        () => debouncedPush("settings"));
  window.addEventListener("aura:keybindings-changed",     () => debouncedPush("settings"));
  window.addEventListener("aura:history-changed",         () => debouncedPush("history"));
  // API-key changes ride along with the settings blob (the
  // encrypted api_keys field is built inside readSettingsBlob).
  // Treat as a settings change for both timestamp + push purposes.
  window.addEventListener("aura:api-keys-changed", () => {
    bumpSettingsUpdatedAt();
    debouncedPush("settings");
  });
  window.addEventListener("aura:manual-watched-changed",  () => debouncedPush("manual-state"));
  window.addEventListener("aura:auto-bumped-changed",     () => debouncedPush("auto-bumped"));
  window.addEventListener("aura:notifications-changed",   () => debouncedPush("notifications"));
  window.addEventListener("aura:recent-searches-changed", () => debouncedPush("recent-searches"));

  // Bulk Tauri-side changes round-trip through @tauri-apps/api/event,
  // not window CustomEvents. Wire them via a dynamic import so this
  // module stays usable from non-Tauri contexts (test harness etc.).
  import("@tauri-apps/api/event").then(({ listen }) => {
    listen("title-state-changed",    () => debouncedPush("title-state")).catch(() => {});
    listen("anilist-id-map-changed", () => debouncedPush("anilist-id-map")).catch(() => {});
  }).catch(() => {});
}

/**
 * Background pull on a 5-minute cadence so changes from another device
 * land without requiring a sign-out/sign-in cycle. Pauses while a
 * video is loaded so we don't compete with playback for bandwidth.
 * Returns a teardown function.
 */
export function startBackgroundPull(): () => void {
  const INTERVAL_MS = 5 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let paused = false;

  // Skip the 5-minute pull while a video is loaded (don't compete with playback
  // for bandwidth) AND while the window is minimized / occluded (nothing is
  // showing the synced state; a catch-up fires on restore below). This is the
  // only ungated cloud call in the tray — the release/notification keep-alive
  // is separate (NotificationsScanner) and intentionally stays running.
  const tick = () => {
    if (paused || isWindowHidden()) return;
    void syncPullAll();
  };

  const onPlay  = () => { paused = true;  };
  const onStop  = () => { paused = false; };

  window.addEventListener("aura:playback-started", onPlay);
  window.addEventListener("aura:playback-ended",   onStop);

  // One catch-up pull the instant the window is restored from hidden, so a
  // change made on another device while Aura sat in the tray lands promptly
  // instead of waiting up to 5 minutes. syncPullAll's own PULL_MIN_INTERVAL_MS
  // guard collapses this with any near-simultaneous interval tick, so a rapid
  // minimize -> restore flap can't spam the proxy.
  let wasHidden = isWindowHidden();
  const unsubVisibility = subscribeWindowVisibility(() => {
    const nowHidden = isWindowHidden();
    if (wasHidden && !nowHidden && !paused) void syncPullAll();
    wasHidden = nowHidden;
  });

  timer = setInterval(tick, INTERVAL_MS);
  return () => {
    if (timer) clearInterval(timer);
    unsubVisibility();
    window.removeEventListener("aura:playback-started", onPlay);
    window.removeEventListener("aura:playback-ended",   onStop);
  };
}
