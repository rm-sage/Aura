// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import { loadAuraSettings, saveAuraSettings, getSettingsUpdatedAt, setSettingsUpdatedAt, bumpSettingsUpdatedAt, setSettingsStampScope, clearSettingsUpdatedAt, type AuraSettings, DEFAULT_AURA_SETTINGS } from "./auraSettings";
import { encryptForCloud, decryptFromCloud, isEncryptedBlob, type EncryptedBlob } from "./syncCrypto";
import {
  encodeHistoryForCloud, mergeHistoryFromCloud, historyChangeReason, getHistoryScope,
  historyNeedsCloudMerge, noteHistoryCloudAbsent, noteHistoryCloudPushed,
} from "./historyStore";
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
//         skip-marks      - union of episode ids (a skip made on one
//                           device applies everywhere)
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
// Sync keeps running during playback: nothing here is on the playback path,
// and a hidden or occluded window is what pauses the background pull.
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
  // `skip-marks` sits immediately after `manual-state` on purpose: a skip is
  // an ANNOTATION over a watched mark (see skipMarks.ts), so the two blobs are
  // pulled in this order and applied in this order, and an episode's skip
  // never lands before the watched mark it annotates.
  "manual-state",
  "skip-marks",
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
//
// The history etag is stored under its own field, never `history`. v2.2.4 reads
// `history` from this same key, so after a downgrade it sent our etag, got a
// 304, merged nothing (its localStorage copy is gone) and its first play replaced
// the whole cloud copy with one row. Without the field it takes a 200 and merges
// the plain head. It rewrites this blob without our field, and a `history` it
// wrote is never adopted, so a re-upgrade takes a 200 too and `pullHistory`
// republishes. The cost is one full history pull after upgrading.

const lastEtag: Map<SyncNamespace, string> = new Map();
const ETAG_STORAGE_PREFIX = "aura:sync:etags:";
const HISTORY_ETAG_FIELD = "history:v2";

function etagField(ns: SyncNamespace): string {
  return ns === "history" ? HISTORY_ETAG_FIELD : ns;
}

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
    const rec = parsed as Record<string, unknown>;
    for (const ns of SYNC_NAMESPACES) {
      const val = rec[etagField(ns)];
      if (typeof val === "string" && val.length > 0) {
        lastEtag.set(ns, val);
      }
    }
    // Stripped NOW, not at the next persistEtags: a launch where everything
    // answers 304 never persists, and a downgrade right after it would 304.
    if ("history" in rec) {
      delete rec.history;
      if (Object.keys(rec).length === 0) localStorage.removeItem(etagStorageKey());
      else safeSetItem(etagStorageKey(), JSON.stringify(rec));
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
  for (const [ns, etag] of lastEtag) obj[etagField(ns)] = etag;
  if (Object.keys(obj).length === 0) {
    try { localStorage.removeItem(etagStorageKey()); } catch { /* ignore */ }
    return;
  }
  // Via safeSetItem so a full origin evicts a disposable cache and retries: a
  // silently-dropped etag blob defeats the If-None-Match 304 short-circuit, so
  // EVERY sync namespace re-pulls in full on the next launch (slow cold start).
  safeSetItem(etagStorageKey(), JSON.stringify(obj));
}

/** The scope clearSyncEtags left, until the setSyncActiveScope paired with it says
 *  where it went. Only a real change drops what is stored: re-applying the SAME
 *  scope (React.StrictMode runs the startup effect twice in `tauri dev`) would lose
 *  the etags, stamp and marker, so the next pull is a 200 the cloud wins over an
 *  unpublished edit. */
let scopeBeingLeft: string | null = null;

/** Forget the active scope's stored etags, settings stamp and marker. */
function dropStoredScopeState(): void {
  try {
    localStorage.removeItem(etagStorageKey());
    localStorage.removeItem(settingsUnpushedKey());
  } catch {}
  clearSettingsUpdatedAt();
}

/** Always paired, in one tick, with a following setSyncActiveScope. */
export function clearSyncEtags(): void {
  scopeBeingLeft = activeScope();
  resetSyncSession();
}

function resetSyncSession(): void {
  lastEtag.clear();
  historyCloudAbsent = false;
  settingsCloudAbsent = false;
  // A pull or push already in flight belongs to the account being left: it
  // must not merge into, or stamp etags for, the next one (see accountGen).
  accountGen++;
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
  const left = scopeBeingLeft;
  scopeBeingLeft = null;
  // Before _activeScope moves: these keys are per scope.
  if (left !== null && left !== next) dropStoredScopeState();
  // Etags still stored for the scope being entered prove it is the one the last
  // run ended in: every account change removes them. Before the same-scope return,
  // because a guest launch never changes scope.
  let restored = false;
  try { restored = localStorage.getItem(`${ETAG_STORAGE_PREFIX}${next}`) !== null; } catch { /* no */ }
  setSettingsStampScope(next, restored);
  if (next === _activeScope) {
    // clearSyncEtags emptied the Map, and this scope's stored entry still holds.
    // A same-scope call without it keeps the Map: it may hold etags freshly
    // written by a just-completed pull or push.
    if (left !== null) loadEtagsForActiveScope();
    return;
  }
  _activeScope = next;
  // Rehydrate the per-namespace etag Map from this scope's persisted
  // entry so an app restart can immediately use If-None-Match on the
  // first pull.
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

/** Skip marks - union of episode ids, same rule as auto-bumped.
 *
 *  A skip is a deliberate user mark ("I did not watch this, and I do not want
 *  to be asked again"), so a skip made on either device should hold on both.
 *  Union therefore, NOT last-writer-wins: a device that has not seen the newer
 *  marks yet must not be able to erase them by pushing its shorter list.
 *
 *  The known limitation, shared with every other namespace today: UNSKIPPING
 *  does not propagate, because an absent id is indistinguishable from an id
 *  the other device has never heard of. Un-skipping locally also clears the
 *  watched mark through `setManualWatchedState`, and manual-state is union
 *  too, so the pair stays consistent, just not deletable cross-device.
 *  Tombstones are the fix for both and belong in one change, not this one. */
const mergeSkipMarks: MergeFn<string[]> = (local, server) => {
  const safeServer = isStringArray(server) ? server : [];
  return Array.from(new Set<string>([...(local ?? []), ...safeServer]));
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

// History never reaches MERGERS: its merge runs in Rust over the whole on-disk
// history (history_store.rs `apply_cloud_merge`, the same server-wins union by
// (id, played_at), now uncapped) and only the delta comes back, so a pull no
// longer ships the full list through the webview twice. See pullHistory /
// pushHistoryNow below. The entry here only satisfies the Record type.
const mergeHistory: MergeFn<unknown> = (local) => local;

// Per-namespace merge wiring. recent-searches and title-state use
// shape-validating server-wins (the previous unconditional server-wins
// could clobber local state when the server returned garbage).
const MERGERS: Record<SyncNamespace, MergeFn<any>> = {
  "settings":        mergeSettings as MergeFn<any>,
  "manual-state":    mergeManualState as MergeFn<any>,
  "skip-marks":      mergeSkipMarks as MergeFn<any>,
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
const SYNCED_API_KEYS = ["opensubtitles", "tmdb", "introdb"] as const;
type SyncedApiKeyName = typeof SYNCED_API_KEYS[number];

interface ApiKeysPlaintext {
  opensubtitles?: string;
  /** Optional TMDB key backing the story-arc grouping. Aura bakes its own key,
   *  so this is only set when the user chose to spend their own quota; syncing
   *  it means they set it once, not once per device. */
  tmdb?: string;
  /** Optional personal IntroDB key, used only to submit skip times the user
   *  entered. Synced for the same reason as the TMDB key. */
  introdb?: string;
  /** Every key name the SENDING build syncs. A key absent from the bundle is
   *  cleared locally only when the sender knew it (see writeApiKeyBundle);
   *  a bundle with no list comes from a build that knew only the two
   *  original keys. */
  _keys?: string[];
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
  const out: ApiKeysPlaintext = { _keys: [...SYNCED_API_KEYS] };
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

/** The keys a bundle without `_keys` (an older build's) can speak for. */
const LEGACY_SYNCED_API_KEYS: readonly string[] = ["opensubtitles", "tmdb"];

async function writeApiKeyBundle(plain: ApiKeysPlaintext): Promise<void> {
  const senderKnows = Array.isArray(plain._keys) ? plain._keys : LEGACY_SYNCED_API_KEYS;
  for (const name of SYNCED_API_KEYS) {
    const v = plain[name as SyncedApiKeyName];
    // Empty / undefined clears the local keyring entry so a cross-device
    // "deleted on the other side" survives the round-trip, but ONLY for a
    // key the sender syncs: a bundle from a build that has never heard of a
    // key says nothing about it, and treating its absence as a deletion
    // wiped that key here on every push from the older device.
    if (!v && !senderKnows.includes(name)) continue;
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
    // `update_settings` accepts a partial JSON patch. NOTE: it does NOT
    // whitelist - it shallow-merges every key of the patch into the current
    // settings object and deserializes the result (settings.rs). An unknown
    // key is dropped by serde, but a KNOWN key is applied whatever it is.
    // That is why machine-local paths have to be stripped explicitly below
    // rather than merely left out of the portable field lists, which gate
    // file export/import only.
    //
    // The retired `scrobble_enabled` master is dropped too: a device still on
    // 2.2.3 pushes its untouched default (false) with every blob, and
    // update_settings would fold that into auto_scrobble_enabled = false, so
    // this device could never keep automatic scrobbling on. Its meaning was
    // already applied here by the local load() migration.
    const { scrobble_enabled: _retired, ...patch } = s;
    if (Object.keys(patch).length === 0) return;
    await invoke("update_settings", { patch });
    // scrobbleConn caches the automatic-scrobbling switch.
    if ("auto_scrobble_enabled" in patch) {
      window.dispatchEvent(new Event("aura:scrobble-settings-changed"));
    }
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
  if (userId && SYNCED_API_KEYS.some((k) => apiKeys[k])) {
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
  // Machine-local PATHS never leave this device. A `D:\Media` root synced to
  // a laptop with no D drive would fail every download against a folder the
  // user never chose, and a screenshot folder is the same problem. Stripping
  // outbound as well as inbound means the cloud blob never even carries them,
  // so an older client that predates the inbound guard cannot apply one either.
  // `gpu_acceleration` is machine-local too: it is a per-machine GPU
  // workaround (Rust keeps it in render.json), and a laptop's "off" synced to
  // a desktop would silently drop that machine to software rendering.
  const backendShared: BackendSettingsLite = { ...backend };
  delete (backendShared as Record<string, unknown>).download_dir;
  delete (backendShared as Record<string, unknown>).screenshot_dir;
  delete (backendShared as Record<string, unknown>).gpu_acceleration;
  return { backend: backendShared, frontend, updated_at: getSettingsUpdatedAt(), api_keys };
}

async function writeSettingsBlob(blob: Partial<SettingsSyncBlob>): Promise<void> {
  const gen = accountGen;
  // The backend half goes FIRST: the frontend save below raises the fromCloud
  // `aura:settings-changed`, and everything that reads get_settings on it (App's
  // bindings and audio prefs, the skip re-stamp, subtitle style) must see these.
  if (blob.backend) {
    // Same carve-out on the way in. Re-reading the local values and pinning
    // them into the patch is what makes this safe against the shallow merge
    // described in applyBackendSettings: omitting a key is not enough if the
    // incoming blob still has it.
    const localBackend = await readBackendSettings();
    // That read can span an account change, and the write would land in the new
    // scope's file.
    if (gen !== accountGen) return;
    await applyBackendSettings({
      ...blob.backend,
      download_dir: localBackend.download_dir,
      screenshot_dir: localBackend.screenshot_dir,
      gpu_acceleration: localBackend.gpu_acceleration,
    });
    if (gen !== accountGen) return;
    // After the write landed, and never a local edit (see installSyncTriggers).
    window.dispatchEvent(new CustomEvent("aura:backend-settings-changed", { detail: { fromCloud: true } }));
  }
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
  } else if (blob.backend) {
    // keys: an event with no list reads as "everything changed" and refetches
    // the Home grid.
    window.dispatchEvent(new CustomEvent("aura:settings-changed", { detail: { keys: [], fromCloud: true } }));
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
    if (userId && gen === accountGen) {
      try {
        const pt = await decryptFromCloud(blob.api_keys, userId);
        const parsed = JSON.parse(pt) as ApiKeysPlaintext;
        if (gen === accountGen) await writeApiKeyBundle(parsed);
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
  if (gen === accountGen && typeof blob.updated_at === "number" && blob.updated_at > 0) {
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
  if (namespace === "skip-marks") {
    // skipMarks owns the scoped localStorage entry; its in-memory set is the
    // authoritative read and is already the wire shape (a string array).
    // Dynamic import for the same reason manualWatched uses one below: that
    // module registers a listener at module scope, and sync.ts deliberately
    // touches no browser global until it is called.
    try {
      const m = await import("./skipMarks");
      return m.getSkippedIds();
    } catch { return []; }
  }
  // "history" is handled by pullHistory / pushHistoryNow and never read here.
  if (namespace === "history") return null;

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
  if (namespace === "skip-marks") {
    // silent: true for the same reason as history - the change event is what
    // schedules a debounced push, so notifying here would make every pull
    // immediately schedule a push of the blob it just merged.
    const ids = isStringArray(value) ? value : [];
    try {
      const m = await import("./skipMarks");
      m.replaceSkipMarks(ids, { silent: true });
    } catch (e) {
      console.warn("[sync] writeLocal skip-marks failed:", e);
    }
    return;
  }
  // "history" merges in Rust (mergeHistoryFromCloud); nothing to write here.
  if (namespace === "history") return;

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
/** Bumped by clearSyncEtags, i.e. on every account change. A pull or push
 *  compares the value it started with: Rust answered it with the session of
 *  that moment, so once the account changed its blobs belong to the previous
 *  account and are dropped rather than merged into the new one. */
let accountGen = 0;
/** accountGen of the pull in `pullAllInflight`. */
let pullAllGen = 0;
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
  if (pullAllInflight) {
    // A pull for the PREVIOUS account is still running: run this account's
    // own pull after it, instead of handing back one that will discard
    // everything it fetched.
    if (pullAllGen !== accountGen) return pullAllInflight.then(() => syncPullAll());
    return pullAllInflight;
  }
  // Min-interval guard: if a successful pull completed less than
  // PULL_MIN_INTERVAL_MS ago (and the account hasn't changed since,
  // which would have called clearSyncEtags and reset the timestamp),
  // skip. This prevents auth-churn (logout/login, session-expired
  // refresh) from kicking back-to-back pulls.
  if (Date.now() - lastPullCompletedAt < PULL_MIN_INTERVAL_MS) {
    return Promise.resolve();
  }
  pullInFlight = true;
  const gen = accountGen;
  pullAllGen = gen;
  // Captured BEFORE the fetch: the history blob is merged into this scope
  // or not at all (mergeHistoryFromCloud).
  const historyScope = getHistoryScope();
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
        // A history file set aside as unreadable, or missing, needs the cloud
        // copy itself, and a 304 would skip the merge it is waiting for.
        if (ns === "history" && historyNeedsCloudMerge()) continue;
        if (etag) etagMap[ns] = etag;
      }
      const outcomes = await invoke<PullOutcome[]>("sync_pull_all", {
        ifNoneMatch: etagMap,
      });
      let etagsMutated = false;
      for (const outcome of outcomes) {
        // The account changed while this was in flight: what is left belongs
        // to the previous one (the chained pull fetches the new account's).
        if (gen !== accountGen) break;
        // Any outcome at all (200 / 304 / 404) means the proxy now accepts
        // this name, so release a latch set while it did not. Lets a proxy
        // deploy take effect on the next sweep instead of needing a restart.
        const answered = (outcome as { namespace?: string; blob?: { namespace?: string } });
        const answeredNs = (answered.namespace ?? answered.blob?.namespace) as SyncNamespace | undefined;
        if (answeredNs && unsupportedNamespaces.delete(answeredNs)) {
          console.info(`[sync] proxy now accepts "${answeredNs}" - resuming sync for it`);
        }
        if (answeredNs === "history") historyCloudAbsent = outcome.status === "missing";
        if (answeredNs === "settings") settingsCloudAbsent = outcome.status === "missing";
        if (outcome.status === "fresh") {
          const blob = outcome.blob;
          const ns = blob.namespace as SyncNamespace;
          if (!SYNC_NAMESPACES.includes(ns)) continue;
          try {
            if (ns === "history") {
              // Not hydrated yet: leave the etag alone so the next pull
              // fetches this blob again instead of 304-ing past it.
              if (!(await pullHistory(blob.data, historyScope))) continue;
            } else {
              const seenSettingsEdit = ns === "settings" ? readSettingsUnpushed() : null;
              const local  = await readLocal(ns);
              if (gen !== accountGen) break;
              const merger = MERGERS[ns];
              // No etag: this device has never merged this account's settings, so
              // what it holds came from the previous scope (Rust's cache, the
              // device-wide frontend blob). An edit on top of that, made while the
              // first pull failed, must not beat the cloud copy.
              const merged = ns === "settings" && !lastEtag.has("settings")
                ? blob.data
                : merger(local, blob.data);
              // A kept local blob has nothing to apply, and writing it back would
              // revert an edit made during the read: the blob's stamp is read last,
              // so it carries that edit's stamp over the values from before it.
              if (ns !== "settings" || merged !== local) await writeLocal(ns, merged);
              if (gen !== accountGen) break;
              // The settings write is fromCloud and schedules no push. When a 200's
              // merge KEPT this device's newer blob, push it here, or it would wait
              // for the next local change. A 304 never gets here: see the
              // not_modified branch.
              if (ns === "settings") {
                if (merged === local) debouncedPush("settings");
                else clearSettingsUnpushed(seenSettingsEdit);
              }
            }
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
          // The cloud is the copy this device merged, so an edit still marked
          // never landed: publish it. Armed here, not at the end of the pull: a
          // pull that did not answer for settings proves nothing about the etag.
          if (ns === "settings" && readSettingsUnpushed() !== null) debouncedPush("settings");
        } else if (outcome.status === "missing") {
          // 404 — server has no blob for this namespace. Drop any
          // local etag pointing at a vanished blob so the next pull
          // doesn't send a stale If-None-Match that the server would
          // ignore anyway, and a subsequent push can force-overwrite
          // without an If-Match round-trip.
          const ns = outcome.namespace as SyncNamespace;
          // No cloud history at all: a set-aside file has nothing to wait for.
          if (ns === "history" && getHistoryScope() === historyScope) noteHistoryCloudAbsent(historyScope);
          if (SYNC_NAMESPACES.includes(ns) && lastEtag.has(ns)) {
            lastEtag.delete(ns);
            etagsMutated = true;
          }
          // Nothing in the cloud to overwrite, so the null If-Match is safe.
          if (ns === "settings" && readSettingsUnpushed() !== null) debouncedPush("settings");
        }
      }
      if (etagsMutated && gen === accountGen) persistEtags();
    } catch (e) {
      console.warn("[sync] pull_all failed:", e);
    } finally {
      pullInFlight = false;
      pullAllInflight = null;
      // Only a pull for the CURRENT account arms the min-interval floor;
      // a discarded one must not hold the new account's pull off.
      if (gen === accountGen) lastPullCompletedAt = Date.now();
      // Flush any pushes that were deferred while the pull held the
      // gate. We schedule them through the normal debounce so the
      // 5s rate-limiting still applies (otherwise a flurry of marks
      // during a pull would all push at once).
      const flushed = Array.from(deferredPushes);
      deferredPushes.clear();
      for (const ns of flushed) debouncedPush(ns);
      // A history edit whose push never landed (app closed inside the
      // debounce, a failed push, one dropped while a set-aside file waited
      // for this merge): republish now that the cloud copy is merged. See
      // "History: unpublished-change marker". Never for a guest (no cloud),
      // and never while the set-aside latch still holds the push back. A pull
      // that did not answer for history is stopped by pushHistoryNow's own gate.
      if (
        gen === accountGen &&
        activeScope() !== "guest" &&
        getHistoryScope() === historyScope &&
        !historyNeedsCloudMerge() &&
        readHistoryUnpushed(historyScope) !== null
      ) {
        debouncedPush("history");
      }
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
/** Namespaces the proxy rejected with 400 for this session.
 *
 *  The allowlist is enforced on BOTH sides (proxy spec section 5), so a
 *  namespace that ships in the client before the proxy is redeployed gets a
 *  400 `unknown_namespace` on every attempt. Without this latch a background
 *  namespace would log once per user action forever - a bulk "skip these
 *  episodes" is one warning per push - which buries real sync errors.
 *
 *  Latched per session and per namespace, and released as soon as the proxy
 *  answers for it again (see the pull sweep), so deploying the proxy fixes it
 *  without an app restart. Everything else keeps syncing normally throughout:
 *  `sync_pull_all` already logs-and-continues per namespace. */
const unsupportedNamespaces = new Set<SyncNamespace>();

/** The proxy's rejection for a name that is not on its allowlist. Matched on
 *  the status because that is all `sync.rs` puts in the error string
 *  ("sync_push <ns> http 400"); a malformed-JSON body is the only other 400
 *  the spec defines and we never send one. */
function isUnknownNamespaceError(e: unknown): boolean {
  const msg = typeof e === "string" ? e : String((e as { message?: string })?.message ?? e);
  return msg.includes("http 400");
}

export async function syncPush(namespace: SyncNamespace): Promise<void> {
  if (unsupportedNamespaces.has(namespace)) return;
  try {
    await syncPushNow(namespace);
  } catch (e) {
    if (isUnknownNamespaceError(e)) {
      unsupportedNamespaces.add(namespace);
      console.warn(
        `[sync] the proxy does not know the "${namespace}" namespace (400). `
        + `Add it to the proxy allowlist (spec section 5) and redeploy; `
        + `until then this namespace stays local and every other one syncs normally.`,
      );
      return;
    }
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
  if (namespace === "history") {
    if (!(await pushHistoryNow())) {
      throw new Error("held until the cloud copy has been merged here; it publishes after the next pull");
    }
    return;
  }
  if (namespace === "settings") {
    if (activeScope() === "guest") return;
    if (!lastEtag.has("settings") && !settingsCloudAbsent) {
      throw new Error("held until a pull has answered for this account's settings; it publishes after the next pull");
    }
  }
  // Rust answers with the session of the moment it runs: once the account
  // changed, an answer must not stamp its etag on the new account, and a 412's
  // server blob must not be merged into the new account's store.
  const gen = accountGen;
  // Read BEFORE the blob: an edit after this point changes the marker, so a
  // successful push of the older blob does not clear it.
  const seenSettingsEdit = namespace === "settings" ? readSettingsUnpushed() : null;
  const local = await readLocal(namespace);
  if (local == null || gen !== accountGen) return; // nothing to push yet
  const ifMatch = lastEtag.get(namespace) ?? null;
  const result = await invoke<PushOutcome>("sync_push", {
    namespace,
    data: sanitizeForPush(namespace, local),
    ifMatch,
  });
  if (gen !== accountGen) return;
  if (result.status === "ok") {
    lastEtag.set(namespace, result.etag);
    persistEtags();
    if (namespace === "settings") noteSettingsPushLanded(seenSettingsEdit);
    return;
  }
  // 412 conflict: merge server into local, retry push with the
  // server's etag so the proxy accepts the merged result.
  const merger = MERGERS[namespace];
  const merged = merger(local, result.server.data);
  if (namespace === "settings") {
    // An edit since the read makes `local` stale, and the merge above never saw its
    // stamp (the round trip is the window). Its own armed push takes this 412 with
    // the edit in it. A kept local blob has nothing to apply, as in the pull.
    if (readSettingsUnpushed() !== seenSettingsEdit) return;
    if (merged !== local) await writeLocal(namespace, merged);
  } else {
    await writeLocal(namespace, merged);
  }
  if (gen !== accountGen) return;
  const retry = await invoke<PushOutcome>("sync_push", {
    namespace,
    data: sanitizeForPush(namespace, merged),
    ifMatch: result.server.etag,
  });
  if (gen !== accountGen) return;
  if (retry.status === "ok") {
    lastEtag.set(namespace, retry.etag);
    persistEtags();
    if (namespace === "settings") noteSettingsPushLanded(seenSettingsEdit);
  } else if (namespace === "settings") {
    // Keep the etag of the copy just merged, as history does: the next pull takes
    // a 200 and the merge decides, with the edit still marked. No etag would hold
    // the push and read as "never merged", which hands the cloud the win.
    lastEtag.set(namespace, result.server.etag);
    persistEtags();
    console.warn("[sync] push settings conflicted twice; the next pull merges again");
  } else {
    // Two consecutive conflicts is rare (third device writing
    // mid-merge). Drop the etag so the next attempt force-overwrites;
    // the user's local state wins.
    lastEtag.delete(namespace);
    persistEtags();
    console.warn(`[sync] push ${namespace} conflicted twice; force-overwrite next attempt`);
  }
}

// ── Settings: unpublished-change marker ────────────────────────────────────
//
// Same hole as history's marker below: an edit whose push never landed (app
// closed inside the debounce, a failed push) has no way out once the next pull
// is a 304. Set on every local edit, cleared by a push that landed with no edit
// after it or by a pull whose blob won. One key per sync scope, removed when
// clean and on an account change, so it stays bounded.

const SETTINGS_UNPUSHED_PREFIX = "aura:sync:settings-unpushed:";

function settingsUnpushedKey(): string {
  return `${SETTINGS_UNPUSHED_PREFIX}${activeScope()}`;
}

function readSettingsUnpushed(): string | null {
  try { return localStorage.getItem(settingsUnpushedKey()); } catch { return null; }
}

/** Cleared only when no edit came after `seen`, so one made mid-push stays marked. */
function clearSettingsUnpushed(seen: string | null): void {
  if (seen === null) return;
  try {
    if (localStorage.getItem(settingsUnpushedKey()) === seen) localStorage.removeItem(settingsUnpushedKey());
  } catch { /* best effort */ }
}

/** Last pull's answer for settings was 404. With no etag held, the only state
 *  that may push: a null If-Match overwrites unconditionally, and anything else
 *  means this device has not merged the cloud copy (its pull failed). Same rule
 *  as historyCloudAbsent. A device holding an etag does not need it (a 412 merges). */
let settingsCloudAbsent = false;

function noteSettingsPushLanded(seen: string | null): void {
  settingsCloudAbsent = false;
  clearSettingsUnpushed(seen);
}

// ── History: compact cloud encoding ─────────────────────────────────────────
//
// WIRE. The `history` blob is a JSON array: the newest rows in plain form (at
// most 500 / 256 KiB), then ONE trailing element
// `{"v":2,"enc":"gzip-b64","n":N,"data":"..."}` holding the next N rows as
// base64 of the same gzip compact form the local file uses (history_store.rs
// "WIRE SHAPE"), built and read in Rust. The proxy needs no change: it stores
// any JSON body under an allowlisted name, and "history" already is one. A
// local history whose blob would pass the 1 MiB limit is TRIMMED IN THE CLOUD
// COPY ONLY to the newest rows that fit (roughly 24k rows of a measured real
// history; every row of a 10k one fits); the local file keeps everything.
//
// MIXED VERSIONS (read from v2.2.4's sync.ts, historyStore.ts and App.tsx).
// v2.2.4 PUSHES ITS WHOLE LOCAL LIST ON ITS FIRST LOCAL EDIT, whatever that
// list holds, made with the etag its login pull took (so the proxy accepts it).
// Its launch push never leaves: setHistoryScope arms the debounce and
// clearSyncEtags cancels it in the same tick. Its merge,
// mergeHistory(local, server), reads only an array and keeps elements with a
// string `id` and `played_at`. That is why the blob is an ARRAY whose head is
// the newest rows in plain form (up to 500, history_store.rs "WIRE SHAPE")
// with the compact envelope as one trailing element its merge skips. A bare
// envelope object gave it nothing to merge, so a fresh v2.2.4 install (or a
// downgrade, whose localStorage copy the migration removed) replaced the cloud
// copy with its next play alone. That also needs it to take a 200, which is
// why the history etag is out of its sight (see the ETag tracker above).
//
// With the array, the old client's push is its own rows (at most 1000) plus
// the newest head: the cloud copy is never emptied, but it does lose the
// envelope's older rows until a newer client syncs. Any newer client then
// pulls the plain array, reads it as legacy, unions it into its file (nothing
// lost locally), and because it holds rows that array lacks it pushes the full
// blob back at once (pullHistory). Rows whose ONLY copy was the envelope (their
// device gone) and which are older than the head can be lost by such an
// overwrite: an old client cannot preserve what it cannot read. No ping-pong:
// the old client pushes only on its own changes.

/** Merge a pulled history blob into `scope` (the history scope the pull was
 *  made for). False when the store is not hydrated or the scope changed. */
async function pullHistory(data: unknown, scope: string): Promise<boolean> {
  const out = await mergeHistoryFromCloud(data, { scope });
  if (!out) return false;
  if (out.legacy && out.localOnly > 0) {
    // An older Aura overwrote the envelope with its own array (see above).
    console.info(`[sync] history: cloud copy is a legacy array missing ${out.localOnly} local row(s); re-publishing`);
    debouncedPush("history");
  }
  return true;
}

// ── History: unpublished-change marker ─────────────────────────────────────
//
// Only a LOCAL edit pushes history (a hydration or a cloud merge would just
// re-upload what was pulled). So an edit whose push never landed had no other
// way out: the 5 s debounce dies with the page when the app is closed from the
// end screen, a push can fail on the network or 412 twice, and one made while
// a set-aside file waits for its cloud merge is dropped. The next launch's
// pull is then a 304 and nothing pushes, and other devices miss those plays
// until some later edit on THIS device. The marker records "this history scope has a local change
// the cloud has not taken" in localStorage, set on every local edit and
// cleared only by a push that landed with no edit after it; every completed
// pull republishes while it is set (`syncPullAll`). One key per history scope,
// removed when clean, so it stays bounded.

const HISTORY_UNPUSHED_PREFIX = "aura:sync:history-unpushed:";

function historyUnpushedKey(historyScope: string): string {
  return `${HISTORY_UNPUSHED_PREFIX}${historyScope}`;
}

function readHistoryUnpushed(historyScope: string): string | null {
  try { return localStorage.getItem(historyUnpushedKey(historyScope)); } catch { return null; }
}

/** A local history edit in `historyScope` that the cloud has not taken yet.
 *  The value only has to change per edit (the push compares it). */
function markHistoryUnpushed(historyScope: string): void {
  try { localStorage.setItem(historyUnpushedKey(historyScope), String(Date.now())); } catch { /* best effort */ }
}

/** A push of `historyScope` landed. Cleared only when no edit came after the
 *  value read before the encode, so a play made mid-push stays marked. */
function clearHistoryUnpushed(historyScope: string, seen: string | null): void {
  if (seen === null) return;
  try {
    if (localStorage.getItem(historyUnpushedKey(historyScope)) === seen) {
      localStorage.removeItem(historyUnpushedKey(historyScope));
    }
  } catch { /* best effort */ }
}

/** Last pull's answer for history was 404. The ONLY state that may push with a
 *  null If-Match: the proxy accepts that unconditionally, so anything else would
 *  overwrite a cloud copy this device has never merged, the only copy left when
 *  no other device is alive. Etag-less + not absent means the pull failed or its
 *  merge threw (a future envelope version), and pushHistoryNow waits. Reset by
 *  clearSyncEtags; a device holding an etag does not need it (a 412 merges). */
let historyCloudAbsent = false;

/** A history push answered: the new etag, unless the account changed while it
 *  was in flight (it belongs to the account just left). */
function stampHistoryEtag(gen: number, etag: string, landed: boolean): void {
  if (gen !== accountGen) return;
  lastEtag.set("history", etag);
  if (landed) historyCloudAbsent = false;
  persistEtags();
}

/** True when the push landed (or a guest has nothing to push to); false when it
 *  is held, with the unpushed marker still set so the next pull retries it. */
async function pushHistoryNow(): Promise<boolean> {
  // Checked when the debounce fires, before the encode: sync_push refuses a
  // guest anyway, after a full gzip and a round trip of the blob.
  if (activeScope() === "guest") return true;
  if (!lastEtag.has("history") && !historyCloudAbsent) return false;
  const gen = accountGen;
  // Read BEFORE the encode: an edit after this point changes the marker, so
  // a successful push of the older list does not clear it.
  const seenUnpushed = readHistoryUnpushed(getHistoryScope());
  // Null when not hydrated, or when a set-aside file still waits for its
  // cloud merge: in both cases the list is not the whole history.
  const first = await encodeHistoryForCloud();
  if (!first) return false;
  if (gen !== accountGen) return false; // encoded for the account just left
  const result = await invoke<PushOutcome>("sync_push", {
    namespace: "history",
    data: first.payload,
    ifMatch: lastEtag.get("history") ?? null,
  });
  if (result.status === "ok") {
    stampHistoryEtag(gen, result.etag, true);
    clearHistoryUnpushed(first.scope, seenUnpushed);
    noteHistoryCloudPushed(first);
    return true;
  }
  // 412: union the server copy into the file, then publish the union. A blob
  // this build cannot read (a future envelope version) throws here, and we
  // stop rather than overwrite what a newer client wrote.
  if (gen !== accountGen) return false;
  if (!(await mergeHistoryFromCloud(result.server.data, { scope: first.scope }))) return false;
  const merged = await encodeHistoryForCloud();
  if (!merged || merged.scope !== first.scope || gen !== accountGen) return false;
  const retry = await invoke<PushOutcome>("sync_push", {
    namespace: "history",
    data: merged.payload,
    ifMatch: result.server.etag,
  });
  if (retry.status === "ok") {
    stampHistoryEtag(gen, retry.etag, true);
    clearHistoryUnpushed(merged.scope, seenUnpushed);
    noteHistoryCloudPushed(merged);
    return true;
  }
  // Keep the etag of the copy just merged, which is now stale: the next attempt
  // takes a 412 and merges again. The retry's own etag names rows not merged
  // here, and no etag at all would be a blind overwrite.
  stampHistoryEtag(gen, result.server.etag, false);
  console.warn("[sync] push history conflicted twice; the next attempt merges again");
  return false;
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
  dropStoredScopeState();
  resetSyncSession();
}

/** Query the proxy for the current per-namespace status. */
export async function syncStatus(): Promise<SyncStatus> {
  return invoke<SyncStatus>("sync_status");
}

// ── Auto-push triggers ───────────────────────────────────────────────────

const PUSH_DEBOUNCE_MS = 5000;
const debounceTimers: Map<SyncNamespace, ReturnType<typeof setTimeout>> = new Map();

/** Drop a push armed but not yet sent. Settings > Storage reloads a store it
 *  just cleared (manual-state, skip-marks, notifications), and that reload's
 *  change event must not publish the emptied blob: their clear is local (the
 *  proxy would take it as an overwrite). A HISTORY clear is published on purpose
 *  (see clearHistoryChecked) and does not come through here. */
export function dropPendingPush(namespace: SyncNamespace): void {
  const existing = debounceTimers.get(namespace);
  if (existing) clearTimeout(existing);
  debounceTimers.delete(namespace);
}

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

/** Machine-local backend fields, stripped from the blob both ways (see
 *  readSettingsBlob): changing only these must not make this device's blob win. */
const MACHINE_LOCAL_BACKEND_KEYS = ["download_dir", "screenshot_dir", "gpu_acceleration"];

/** Is this settings event a local edit worth a stamp and a push? Not a cloud
 *  pull's own write, and not a save that changed nothing: SettingsView saves on
 *  mount, and stamping that would let a device overwrite another's edit just by
 *  opening Settings. No detail at all still counts: the manual dispatch sites
 *  send none. */
function isLocalSettingsEdit(e: Event): boolean {
  const detail = (e as CustomEvent<{ fromCloud?: boolean; keys?: string[] }>).detail;
  if (detail?.fromCloud) return false;
  return !(Array.isArray(detail?.keys) && detail.keys.length === 0);
}

/** A local settings edit: stamp it, mark it unpublished, schedule the push. A
 *  guest has no cloud, and an edit there must not reach the next account. */
function noteLocalSettingsEdit(): void {
  if (activeScope() === "guest") return;
  bumpSettingsUpdatedAt();
  try { localStorage.setItem(settingsUnpushedKey(), String(Date.now())); } catch { /* best effort */ }
  debouncedPush("settings");
}

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
  // event: covers manual-dispatch sites (AniSkipMenu, PlayerOverlay,
  // userDataBackup restore) that don't route through saveAuraSettings.
  // Skipped when detail.fromCloud is true so the cloud-pull write
  // path doesn't fight the merger. Pushing that write back would also
  // re-upload the blob just merged (new etag, so the other device pulls
  // and pushes it again). Same rule as history / skip-marks' silent writes.
  window.addEventListener("aura:settings-changed", (e) => {
    if (isLocalSettingsEdit(e)) noteLocalSettingsEdit();
  });
  // A backend write landed (Settings' update_settings, set_theme). Its own event,
  // not `aura:settings-changed`: that one drives the skip re-stamp and many
  // re-reads, and a text field patches on every keystroke. A keybinding edit comes
  // through here too; `aura:keybindings-changed` also fires for a patch that
  // changed nothing, so it is not listened to.
  window.addEventListener("aura:backend-settings-changed", (e) => {
    if (!isLocalSettingsEdit(e)) return;
    const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
    if (keys?.every((k) => MACHINE_LOCAL_BACKEND_KEYS.includes(k))) return;
    noteLocalSettingsEdit();
  });
  // Only a LOCAL edit pushes: hydration and a cloud merge also fire this
  // event (so the view re-renders), and pushing on those would re-upload the
  // blob just pulled.
  window.addEventListener("aura:history-changed", (e) => {
    const reason = historyChangeReason(e);
    if (reason === "mutation") {
      // Signed in only: a guest's edits have no cloud to reach.
      if (activeScope() !== "guest") markHistoryUnpushed(getHistoryScope());
      debouncedPush("history");
    }
    // A history file set aside as unreadable, or missing, waits for the cloud
    // copy before anything may be pushed: pull now rather than at the next tick.
    if (reason === "hydrated" && historyNeedsCloudMerge() && activeScope() !== "guest") {
      const repull = () => {
        if (!historyNeedsCloudMerge() || activeScope() === "guest") return;
        lastPullCompletedAt = 0;
        void syncPullAll();
      };
      // At launch the sweep started in the same tick as the load, BEFORE the
      // load reported the file set aside, so it sent the history etag and
      // gets a 304 that merges nothing. syncPullAll would hand back that very
      // sweep, so run a fresh one AFTER it; repull re-checks the latch, so a
      // sweep that did merge (or found no cloud copy) costs nothing more.
      const inflight = pullAllInflight;
      if (inflight) void inflight.then(repull, repull);
      else repull();
    }
  });
  // API-key changes ride along with the settings blob (the
  // encrypted api_keys field is built inside readSettingsBlob).
  // Treat as a settings change for both timestamp + push purposes.
  window.addEventListener("aura:api-keys-changed", noteLocalSettingsEdit);
  window.addEventListener("aura:manual-watched-changed",  () => debouncedPush("manual-state"));
  window.addEventListener("aura:skip-marks-changed",      () => debouncedPush("skip-marks"));
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
 * land without requiring a sign-out/sign-in cycle. Returns a teardown
 * function.
 */
export function startBackgroundPull(): () => void {
  const INTERVAL_MS = 5 * 60 * 1000;
  let timer: ReturnType<typeof setInterval> | null = null;

  // Skip the 5-minute pull while the window is minimized / occluded (nothing is
  // showing the synced state; a catch-up fires on restore below). This is the
  // only ungated cloud call in the tray: the release/notification keep-alive
  // is separate (NotificationsScanner) and intentionally stays running.
  const tick = () => {
    if (isWindowHidden()) return;
    void syncPullAll();
  };

  // One catch-up pull the instant the window is restored from hidden, so a
  // change made on another device while Aura sat in the tray lands promptly
  // instead of waiting up to 5 minutes. syncPullAll's own PULL_MIN_INTERVAL_MS
  // guard collapses this with any near-simultaneous interval tick, so a rapid
  // minimize -> restore flap can't spam the proxy.
  let wasHidden = isWindowHidden();
  const unsubVisibility = subscribeWindowVisibility(() => {
    const nowHidden = isWindowHidden();
    if (wasHidden && !nowHidden) void syncPullAll();
    wasHidden = nowHidden;
  });

  timer = setInterval(tick, INTERVAL_MS);
  return () => {
    if (timer) clearInterval(timer);
    unsubVisibility();
  };
}
