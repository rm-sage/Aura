// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// scrobbleConn — "can we scrobble right now, and to what?"
//
// Extracted from HistoryView, which resolved this inline. Skips push through
// the same commands from a different surface, and two copies of this logic
// would drift the moment either changed.
//
// Answers three things together because they are always needed together: the
// active account scope (the key the scrobble commands are stored under), which
// services actually have a live token, and whether the user has auto-scrobble
// switched on at all.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// The provider list, and everything keyed by it.
//
// ONE tuple, and the union is derived from it. Per-provider CONSTANTS (the
// labels and history command below, the alert and Settings copy, the sign-in
// flow choice, the bulk runner's pacing) are Records keyed by ScrobbleService
// rather than a `service === "trakt" ? a : b` ternary: with a ternary, a third
// member compiled clean and silently took the AniList branch, whereas a Record
// missing a key is a tsc error.
//
// That does NOT cover per-provider BEHAVIOUR. It is still written out by hand
// because it genuinely differs, and a new member compiles clean there and is
// then silently left out. Extend each of these explicitly:
//   - HistoryView: `servicesFor` (eligibility; AniList is anime-only, Simkl
//     needs an id `simklCanIdentify` accepts), the bulk runner's `work`
//     merge, and HistoryCard's per-service row buttons (Simkl's sends a
//     batch of one).
//   - scrobbleRun: the Simkl step after the per-row loop (one batched call
//     for every Simkl row of the run, results mapped back by index).
//   - skipActions: `markEpisodesSkipped` (Trakt is pushed per episode, AniList
//     collapsed per media, Simkl per episode but in one batched call).
//   - SettingsView: one hand-placed ScrobbleAuthRow per service.
//   - NotificationsPanel: the reconnect button (AniList and Simkl; Trakt's
//     device flow needs the Settings row to show its code).
//   - App.tsx: the DevConsole test fire's per-service `*_fired` flags.
// Mirrors `SCROBBLE_SERVICES` in scrobble_auth.rs, in the same order.
// ---------------------------------------------------------------------------

export const SCROBBLE_SERVICES = ["trakt", "anilist", "simkl"] as const;
export type ScrobbleService = typeof SCROBBLE_SERVICES[number];

/** Narrow an untrusted string (a deep-link path, say) to a known service. */
export function isScrobbleService(value: string): value is ScrobbleService {
  return (SCROBBLE_SERVICES as readonly string[]).includes(value);
}

/** Display name per service. */
export const SCROBBLE_LABELS: Record<ScrobbleService, string> = {
  trakt: "Trakt",
  anilist: "AniList",
  simkl: "Simkl",
};

/** The Tauri command that pushes History rows to a service. Every caller
 *  (the History tab's row buttons, the bulk runner, skip actions) looks it up
 *  here, so they cannot disagree about which command a service maps to. */
export const HISTORY_COMMAND: Record<ScrobbleService, string> = {
  trakt: "scrobble_history_trakt",
  anilist: "scrobble_history_anilist",
  simkl: "scrobble_history_simkl",
};

/** What each service's History command takes. "row" is ONE row per call, as
 *  named params (`id`, `parentId`, `playedAt`, ...). "batch" is
 *  `{ scope, items }` with one result per item back: Simkl allows about one
 *  POST per second, so a call per row is unsafe for a bulk run, and its
 *  command only has the batch shape (see scrobbleSimkl.ts). */
export const HISTORY_SHAPE = {
  trakt: "row",
  anilist: "row",
  simkl: "batch",
} as const satisfies Record<ScrobbleService, "row" | "batch">;

/** A service whose History command takes one row per call. The per-row call
 *  sites (the runner's loop, the row buttons, skip pushes) are typed to this,
 *  so a batched service cannot reach them with the per-row argument shape. */
export type RowHistoryService = {
  [S in ScrobbleService]: (typeof HISTORY_SHAPE)[S] extends "row" ? S : never;
}[ScrobbleService];

export function isRowHistoryService(service: ScrobbleService): service is RowHistoryService {
  return HISTORY_SHAPE[service] === "row";
}

/** Disconnect (which revokes the grant on the provider) before a Reconnect.
 *  Simkl mints a fresh grant on every sign-in without retiring the previous
 *  one, and its loopback callback cannot revoke the old one there because it
 *  does not know which account scope the flow belongs to. Without this, every
 *  reconnect would leave one more live grant on the user's Simkl account.
 *  Applied by the Settings row's Reconnect only. The bell's Reconnect skips
 *  it: clearing the token first would dismiss that notice before any sign-in
 *  had happened (see NotificationsPanel). */
export const REVOKE_BEFORE_RECONNECT: Record<ScrobbleService, boolean> = {
  trakt: false,
  anilist: false,
  simkl: true,
};

/** The provider redirects STRAIGHT to Aura's loopback listener (Simkl, a
 *  public PKCE client with no proxy in between) rather than through the proxy.
 *  Such a sign-in has no `aura://oauth/<svc>` hop for the in-app popup to
 *  intercept (the popup just follows the redirect to the listener, like any
 *  browser), and nothing to fall back to when the listener is down: the
 *  authorize URL itself fails then, inside Aura or out. Its sign-in state
 *  lives in Rust for 15 minutes, so the Settings row keeps its scope stash
 *  past the row's own 2-minute waiting timeout. */
export const LOOPBACK_ONLY_SIGN_IN: Record<ScrobbleService, boolean> = {
  trakt: false,
  anilist: false,
  simkl: true,
};

/** One connected service's token summary, as `get_scrobble_auth_status`
 *  returns it. */
export interface ScrobbleAuthSummary {
  username: string | null;
  /** When the connection lapses, unix seconds. For Simkl this is the
   *  RENEWAL DEADLINE (180 days after the last silent refresh), not the
   *  7-day access token, which renews itself on the next push. */
  expires_at: number | null;
  /** Token is approaching expiry (provider-specific window: 7d for
   *  AniList, 24h for Trakt, the last 7d before Simkl's renewal
   *  deadline). Soft warning. */
  stale: boolean;
  /** Token has already lapsed. Rendered as a hard "reconnect now"
   *  prompt (AniList cannot refresh at all). */
  expired: boolean;
}

/** `get_scrobble_auth_status`'s payload: a map keyed by service name holding
 *  an entry ONLY for a connected service. Earlier builds sent a disconnected
 *  service as an explicit `null` instead of omitting it, so the value type
 *  admits both. Read it through `summaryFor`, never by `Object.keys`: an
 *  unknown key from a newer backend must be ignored, not rendered. */
export type ScrobbleAuthStatus = Partial<Record<string, ScrobbleAuthSummary | null>>;

/** The summary for one service, with absent and `null` both meaning "not
 *  connected". */
export function summaryFor(
  status: ScrobbleAuthStatus | null | undefined,
  service: ScrobbleService,
): ScrobbleAuthSummary | null {
  return status?.[service] ?? null;
}

/** Build a per-service Record by asking `pick` about each service in turn. */
function perService<T>(pick: (service: ScrobbleService) => T): Record<ScrobbleService, T> {
  const out = {} as Record<ScrobbleService, T>;
  for (const service of SCROBBLE_SERVICES) out[service] = pick(service);
  return out;
}

// ---------------------------------------------------------------------------
// Which services THIS BUILD can sign in to.
//
// Not the same question as "connected". Simkl is in SCROBBLE_SERVICES even in a
// build with no Simkl client_id, where every Simkl path is inert, so a surface
// that offered it there would offer a Connect button that can only fail and a
// History button that can only error. `scrobble_services_available` answers
// this; the answer is fixed for the life of the process, so it is asked once
// and kept (one small Set, never grows). A FAILED ask is not kept, and reads
// as "everything available" meanwhile: an IPC hiccup must never hide Trakt or
// AniList, and an unconfigured Simkl then just says so when Connect is pressed.
// ---------------------------------------------------------------------------

let availableAsk: Promise<ReadonlySet<ScrobbleService>> | null = null;
let availableKnown: ReadonlySet<ScrobbleService> | null = null;

/** The services this build can sign in to, in a Set. */
export function scrobbleServicesAvailable(): Promise<ReadonlySet<ScrobbleService>> {
  if (!availableAsk) {
    availableAsk = invoke<string[]>("scrobble_services_available")
      .then((list) => {
        availableKnown = new Set(list.filter(isScrobbleService));
        return availableKnown;
      })
      .catch(() => {
        availableAsk = null;
        return new Set<ScrobbleService>(SCROBBLE_SERVICES);
      });
  }
  return availableAsk;
}

/** The same answer synchronously, once it has arrived (null before), so a
 *  surface mounted later can render the right state on its first frame. */
export function knownScrobbleServicesAvailable(): ReadonlySet<ScrobbleService> | null {
  return availableKnown;
}

/** One flag per service ("has a live token, in a build that can use it"),
 *  plus the account context. */
export interface ScrobbleConn extends Record<ScrobbleService, boolean> {
  scope: string;
  /** "Aura may scrobble automatically right now": the MASTER `scrobble_enabled`
   *  switch AND the `auto_scrobble_enabled` preference, not the latter alone.
   *  Gates every push the user did not explicitly ask for by pressing a
   *  scrobble button (the History tab's per-row buttons are that explicit ask
   *  and bypass this). */
  autoScrobbleEnabled: boolean;
}

const EMPTY: ScrobbleConn = {
  scope: "guest", ...perService(() => false), autoScrobbleEnabled: false,
};

/** Services with a live token, as the array `markEpisodesSkipped` expects.
 *  In SCROBBLE_SERVICES order. */
export function connectedServices(conn: ScrobbleConn): ScrobbleService[] {
  return SCROBBLE_SERVICES.filter((service) => conn[service]);
}

// ---------------------------------------------------------------------------
// ONE shared resolve, not one per caller.
//
// This used to be a plain useEffect, which made the answer per-COMPONENT. That
// is fine for the two page-level callers, and badly wrong for the third:
// EpisodeRow calls it, so a 366-episode season meant 366 components each firing
// `get_session` + `get_settings` + `get_scrobble_auth_status` on mount, and
// each of those `get_session` calls is an OS KEYRING round-trip on the Rust
// side. It re-ran the whole fan-out again, per row, on every
// `aura:settings-changed`, an event any settings write dispatches. The visible
// symptom was the log filling with `auth get_session -> found`; the real cost
// was the keyring traffic behind it.
//
// The answer is global state (which account, which tokens, which preference),
// so it lives in one module-level snapshot that every caller subscribes to.
// ---------------------------------------------------------------------------

let current: ScrobbleConn = EMPTY;
const listeners = new Set<() => void>();
/** Coalesces concurrent loads: three events in the same tick resolve once. */
let inFlight: Promise<void> | null = null;
/** Set when a refresh signal lands WHILE a resolve is already running. The
 *  answer in flight predates that signal, so dropping the signal would leave a
 *  token linked mid-resolve invisible until some unrelated event happened to
 *  fire. One more pass afterwards is the whole fix. */
let restage = false;
let everLoaded = false;

function emit(): void {
  for (const l of listeners) l();
}

/** Replace the snapshot only when something actually differs. Identity
 *  stability matters here: useSyncExternalStore compares snapshots by
 *  reference, so returning a fresh object each load would re-render every
 *  subscribed row on every unrelated settings write. */
function commit(next: ScrobbleConn): void {
  if (
    current.scope === next.scope
    && SCROBBLE_SERVICES.every((service) => current[service] === next[service])
    && current.autoScrobbleEnabled === next.autoScrobbleEnabled
  ) return;
  current = next;
  emit();
}

async function resolve(): Promise<void> {
  let scope = "guest";
  try {
    const sess = await invoke<{ auth_key?: string } | null>("get_session");
    scope = sess?.auth_key ? sess.auth_key.slice(0, 12) : "guest";
  } catch {
    scope = "guest";
  }

  let autoScrobbleEnabled = false;
  try {
    const settings = await invoke<{
      scrobble_enabled?: boolean;
      auto_scrobble_enabled?: boolean;
    }>("get_settings");
    // BOTH switches, ANDed, because `scrobble_enabled` is the MASTER over all
    // scrobbling and `auto_scrobble_enabled` only covers the automatic half.
    // Reading the second alone meant turning scrobbling off entirely still let
    // a user-initiated skip push plays to Trakt / AniList: skipActions.ts gates
    // on this one field, and the commands it calls
    // (`scrobble_history_trakt` / `_anilist`) deliberately do not re-check the
    // preference, because their other caller is the History tab's explicit
    // per-row button. Rust's automatic path already requires both
    // (scrobble.rs `!s.scrobble_enabled || !s.auto_scrobble_enabled`); this
    // makes the frontend gate agree with it.
    autoScrobbleEnabled =
      settings?.scrobble_enabled === true && settings?.auto_scrobble_enabled === true;
  } catch { /* treat unknown as OFF: never push on a guess */ }

  // A token for a service this build cannot use (a Simkl sign-in kept from a
  // build that had a client_id) is not a connection: every push to it would
  // fail with "not set up in this build".
  const available = await scrobbleServicesAvailable();

  try {
    const status = await invoke<ScrobbleAuthStatus>("get_scrobble_auth_status", { scope });
    commit({
      scope,
      ...perService((service) => available.has(service) && summaryFor(status, service) !== null),
      autoScrobbleEnabled,
    });
  } catch {
    commit({ ...EMPTY, scope, autoScrobbleEnabled });
  }
}

function reload(): void {
  if (inFlight) { restage = true; return; }
  inFlight = resolve().finally(() => {
    inFlight = null;
    if (restage) { restage = false; reload(); }
  });
}

const REFRESH_EVENTS = [
  "aura:session-changed",
  "aura:scrobble-auth-changed",
  "aura:settings-changed",
  // The two scrobble toggles are BACKEND settings, and `patchBackend` in
  // SettingsView dispatches `aura:settings-changed` for exactly one key
  // (minimize_to_tray_on_close) on purpose, to avoid churning the AuraSkip
  // re-stamp and the sync chip on every unrelated write. This store's comment
  // above was written assuming "any settings write dispatches" that event, so
  // in practice a toggle here never reached us: the snapshot resolved ONCE at
  // mount and kept its answer for the whole session, because the store's own
  // self-healing reset (everLoaded = false when the last subscriber leaves)
  // cannot fire either - App subscribes at top level, so the listener set is
  // never empty. Turning scrobbling off and then skipping a filler run still
  // pushed plays. A dedicated event keeps the narrow contract intact.
  "aura:scrobble-settings-changed",
] as const;

/** Window listeners are attached for as long as anyone is subscribed and torn
 *  down when the last subscriber leaves, so a session with no scrobble-aware
 *  surface mounted costs nothing. */
function subscribe(onChange: () => void): () => void {
  const first = listeners.size === 0;
  listeners.add(onChange);
  if (first) {
    for (const ev of REFRESH_EVENTS) window.addEventListener(ev, reload);
  }
  // First mount resolves; later mounts reuse the snapshot rather than
  // re-hitting the keyring for an answer that has not changed.
  if (!everLoaded) {
    everLoaded = true;
    reload();
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      for (const ev of REFRESH_EVENTS) window.removeEventListener(ev, reload);
      // Nobody is listening, so a token linked or an account switched in this
      // window would be missed. Arm the next mount to resolve again rather than
      // trusting a snapshot taken before a blind spot.
      everLoaded = false;
    }
  };
}

const getSnapshot = () => current;

/**
 * Live connection state. Re-resolves when the account changes or a token is
 * linked/unlinked in Settings, so a surface that offers scrobbling never
 * offers it against a token that has since been revoked.
 *
 * Safe to call from a list row: every caller shares one resolve and one
 * snapshot (see the note above).
 */
export function useScrobbleConnections(): ScrobbleConn {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
