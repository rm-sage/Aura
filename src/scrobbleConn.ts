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
//   - HistoryView: `servicesFor` (eligibility; AniList is anime-only), the
//     bulk runner's `work` merge, and HistoryCard's per-service row buttons.
//   - skipActions: `markEpisodesSkipped` (Trakt is pushed per episode, AniList
//     collapsed per media).
//   - SettingsView: one hand-placed ScrobbleAuthRow per service.
//   - NotificationsPanel: the reconnect button (AniList only).
// Mirrors `SCROBBLE_SERVICES` in scrobble_auth.rs, in the same order.
// ---------------------------------------------------------------------------

export const SCROBBLE_SERVICES = ["trakt", "anilist"] as const;
export type ScrobbleService = typeof SCROBBLE_SERVICES[number];

/** Narrow an untrusted string (a deep-link path, say) to a known service. */
export function isScrobbleService(value: string): value is ScrobbleService {
  return (SCROBBLE_SERVICES as readonly string[]).includes(value);
}

/** Display name per service. */
export const SCROBBLE_LABELS: Record<ScrobbleService, string> = {
  trakt: "Trakt",
  anilist: "AniList",
};

/** The Tauri command that pushes ONE History row to a service. Every caller
 *  (the History tab's row buttons, the bulk runner, skip actions) looks it up
 *  here, so they cannot disagree about which command a service maps to. */
export const HISTORY_COMMAND: Record<ScrobbleService, string> = {
  trakt: "scrobble_history_trakt",
  anilist: "scrobble_history_anilist",
};

/** One connected service's token summary, as `get_scrobble_auth_status`
 *  returns it. */
export interface ScrobbleAuthSummary {
  username: string | null;
  expires_at: number | null;
  /** Token is approaching expiry (provider-specific window: 7d for
   *  AniList, 24h for Trakt). Soft warning. */
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

/** One flag per service ("has a live token"), plus the account context. */
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

  try {
    const status = await invoke<ScrobbleAuthStatus>("get_scrobble_auth_status", { scope });
    commit({
      scope,
      ...perService((service) => summaryFor(status, service) !== null),
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
