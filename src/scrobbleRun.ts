// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { markIneligible, markScrobbledMany, type ScrobbleService } from "./scrobbledStore";
import type { HistoryEntry } from "./historyStore";

// ---------------------------------------------------------------------------
// scrobbleRun — the ONE in-flight bulk-scrobble job, held at module scope.
//
// WHY THIS IS NOT COMPONENT STATE. The runner used to live inside HistoryView.
// Navigating away unmounted the view, so the progress bar vanished while the
// async loop carried on firing requests in the background: invisible, and with
// nothing left rendered to disable the buttons that could start a SECOND run on
// top of it. Hoisting the job here means:
//   • the run survives navigation (the bar is rendered globally from App),
//   • `isScrobbleRunning()` is a single source of truth every surface can gate
//     on, so Scrobble All and the per-row buttons all go inert during a run,
//   • only one job can exist at a time, full stop.
//
// PACING + BACKOFF. Requests are sequential and spaced per-service. On a
// transient failure the item is retried with exponential backoff, and the run
// permanently slows down for the rest of the job (see `throttle`) so a rate limit
// is backed away from rather than hammered.
// ---------------------------------------------------------------------------

export interface ScrobbleRunState {
  running: boolean;
  /** Pushes completed (succeeded or permanently failed). */
  done: number;
  total: number;
  ok: number;
  failed: number;
  /** True while sleeping off a backoff — the UI says "retrying" not "stuck". */
  backingOff: boolean;
  /** What is being scrobbled, for the bar's label. */
  label: string;
}

export interface ScrobbleRunSummary {
  ok: number;
  failed: number;
  cancelled: boolean;
  firstError: string;
}

export interface ScrobbleWorkItem {
  entry: HistoryEntry;
  service: ScrobbleService;
  /** History rows this single push SUBSUMES. They are marked scrobbled alongside
   *  it on success, and never pushed themselves.
   *
   *  AniList stores one high-water `progress` number per entry, not a per-episode
   *  log. So pushing episodes 1..12 of a season individually is one real write and
   *  ELEVEN guaranteed no-ops ("progress already 12 (>= clamped 5); skipping
   *  save") -- each still costing a GraphQL round trip against a ~90/min limit.
   *  Sending only the highest episode of the season sets exactly the same final
   *  state, backdates `completedAt` to the same play, and collapses the whole
   *  season into one call. Trakt is NOT collapsed: it records each play
   *  separately, keyed on watched_at, so every row there is a real write. */
  covers?: Array<{ id: string; playedAt: string }>;
}

/** Base spacing between pushes. Trakt's budget is roughly 1000 calls / 5 min.
 *
 *  AniList's is far tighter (~90/min) AND one "push" there is not one call: the
 *  resolve query, then the save mutation, and on a cold cache a search + a SEQUEL
 *  walk on top. Pacing at AniList's nominal one-per-670ms therefore still
 *  overruns it by 2x or worse, which is how a long run rate-limited itself even
 *  after the Trakt refresh storm was fixed. 1200 ms leaves real headroom, and
 *  since the AniList side is now collapsed to one push per season (see
 *  ScrobbleWorkItem.covers) there are far fewer of them to pace anyway.
 *
 *  These are the FLOOR: `throttle` only ever widens them. */
const BASE_DELAY_MS: Record<ScrobbleService, number> = {
  trakt: 350,
  anilist: 1200,
};

/** Attempts per push, including the first. */
const MAX_ATTEMPTS = 3;
/** Backoff before retry N (1-indexed), plus jitter. */
const BACKOFF_MS = [1500, 5000];
/** Every rate-limit-looking failure multiplies the run's spacing by this, so a
 *  job that starts tripping limits backs off for good instead of re-hitting them. */
const THROTTLE_STEP = 1.6;
const THROTTLE_MAX = 8;

const IDLE: ScrobbleRunState = {
  running: false, done: 0, total: 0, ok: 0, failed: 0, backingOff: false, label: "",
};

let state: ScrobbleRunState = IDLE;
const subscribers = new Set<() => void>();
let cancelRequested = false;

function setState(patch: Partial<ScrobbleRunState>): void {
  state = { ...state, ...patch };
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

const getSnapshot = () => state;

/** Live run state. Any surface can read this to render progress or go inert. */
export function useScrobbleRun(): ScrobbleRunState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True while a bulk job is in flight. Gate every scrobble affordance on this. */
export function isScrobbleRunning(): boolean {
  return state.running;
}

export function cancelScrobbleRun(): void {
  if (state.running) cancelRequested = true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Rust's marker for a verdict about the ITEM that no retry can change (Trakt has
 *  no catalog entry for it, no IMDb id, AniList cannot resolve it). Kept as an
 *  explicit sentinel rather than pattern-matching English error prose, which would
 *  break silently the moment a message was reworded. Mirrors
 *  `scrobble::PERMANENT_PREFIX`. */
const PERMANENT_PREFIX = "[permanent] ";

export function isPermanentFailure(message: string): boolean {
  return message.includes(PERMANENT_PREFIX);
}

/** The message with the marker stripped, for showing to a human. */
export function cleanFailureMessage(message: string): string {
  return message.replace(PERMANENT_PREFIX, "").trim();
}

/** Is this failure worth retrying? Permanent verdicts never are — retrying them
 *  only burns rate-limit budget and re-reports the same thing. The Rust commands
 *  word the transient class as "... request failed ... Try again." */
function isTransient(message: string): boolean {
  if (isPermanentFailure(message)) return false;
  return /try again|request failed|network|timed? ?out|429|too many|rate limit/i.test(message);
}

/** Does this failure look like a rate limit specifically? Those additionally
 *  widen the run's spacing for everything that follows. */
function isRateLimit(message: string): boolean {
  return /429|too many|rate limit/i.test(message);
}

/**
 * Run one bulk scrobble job. Rejects immediately (returns null) if a job is
 * already running -- callers should have gated on `isScrobbleRunning()`, but this
 * is the hard guarantee that two jobs can never overlap.
 *
 * Duplicate protection is unchanged and lives BELOW this layer: these are the
 * same two commands the single-row buttons call, and Trakt (idempotent on
 * `watched_at`) plus AniList (`AlreadyAhead`) are the real gates.
 */
export async function startScrobbleRun(
  scope: string,
  work: ScrobbleWorkItem[],
  label: string,
): Promise<ScrobbleRunSummary | null> {
  if (state.running || work.length === 0) return null;

  cancelRequested = false;
  setState({
    running: true, done: 0, total: work.length, ok: 0, failed: 0, backingOff: false, label,
  });
  // Mirror into Rust so the window-close handler knows to ask the user instead of
  // killing the run mid-flight. Cleared in the `finally` below, without which the
  // window could never be closed again.
  void invoke("set_scrobble_run_active", { active: true }).catch(() => {});

  let ok = 0;
  let failed = 0;
  let firstError = "";
  /** Multiplier applied to every delay, ratcheted up by rate-limit failures. */
  let throttle = 1;

  // Successes are buffered: marking each one re-serialises the key set and
  // re-renders the History grid, so a long run would do that hundreds of times.
  const CHUNK = 20;
  let pending: Array<{ service: ScrobbleService; id: string; playedAt: string }> = [];
  const flush = () => {
    if (pending.length === 0) return;
    markScrobbledMany(scope, pending);
    pending = [];
  };

  let cancelled = false;
  try {
    for (let i = 0; i < work.length; i++) {
      if (cancelRequested) break;
      const { entry, service } = work[i];

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (cancelRequested) break;
        try {
          // Tauri maps these camelCase keys onto the Rust command's snake_case
          // params (parent_id, media_type, played_at, ...).
          await invoke<string>(
            service === "trakt" ? "scrobble_history_trakt" : "scrobble_history_anilist",
            {
              id:        entry.id,
              parentId:  entry.parent_id ?? null,
              mediaType: entry.media_type,
              season:    entry.season ?? null,
              episode:   entry.episode ?? null,
              name:      entry.name,
              scope,
              playedAt:  entry.played_at,
              // The addon's AniList mapping, captured when the row was written.
              // Without it, split-cour anime resolve to the wrong entry.
              anilistId:      entry.anilist_id ?? null,
              anilistEpisode: entry.anilist_episode ?? null,
            },
          );
          // Only a resolved command marks the row; a failure stays un-marked and
          // is retried by the next run. Rows this push subsumes (see `covers`)
          // are marked with it -- their state IS now on the service.
          pending.push({ service, id: entry.id, playedAt: entry.played_at });
          for (const c of work[i].covers ?? []) {
            pending.push({ service, id: c.id, playedAt: c.playedAt });
          }
          if (pending.length >= CHUNK) flush();
          ok++;
          break;
        } catch (err) {
          const message = String(err);
          if (isRateLimit(message)) {
            throttle = Math.min(throttle * THROTTLE_STEP, THROTTLE_MAX);
          }
          // A verdict about the item, not the attempt: retire it so it is not
          // re-sent (and re-reported as a failure) on every future run. Reported
          // once, here, so the user still learns about it.
          if (isPermanentFailure(message)) {
            markIneligible(scope, service, entry.id);
          }
          const retryable = isTransient(message) && attempt < MAX_ATTEMPTS;
          if (!retryable) {
            failed++;
            if (!firstError) firstError = `${entry.name}: ${cleanFailureMessage(message)}`;
            break;
          }
          // Back off, then try this same push again.
          const wait = BACKOFF_MS[attempt - 1] ?? 5000;
          setState({ backingOff: true });
          await sleep(wait * throttle + Math.random() * 250);
          setState({ backingOff: false });
        }
      }

      setState({ done: i + 1, ok, failed });
      if (i < work.length - 1 && !cancelRequested) {
        await sleep(BASE_DELAY_MS[service] * throttle);
      }
    }
  } finally {
    // Cancelled, threw, or ran to completion: keep the marks we earned and ALWAYS
    // release the lock, or every future run would be blocked by `running`. No
    // `return` in here -- that would swallow a genuine throw.
    flush();
    cancelled = cancelRequested;
    cancelRequested = false;
    setState({ ...IDLE });
    void invoke("set_scrobble_run_active", { active: false }).catch(() => {});
  }

  return { ok, failed, cancelled, firstError };
}

// A run is bound to the account scope it was started with. If the user signs out
// or switches accounts mid-run, every remaining push would go to the WRONG
// account's Trakt/AniList (the scope is captured in the work loop, and the tokens
// it names may no longer be the active ones). Stop rather than mis-file someone
// else's watch history.
if (typeof window !== "undefined") {
  window.addEventListener("aura:session-changed", () => {
    if (state.running) cancelScrobbleRun();
  });

  // Clear the Rust-side run flag on load.
  //
  // The flag is what makes Rust refuse to close the window mid-scrobble. A webview
  // RELOAD (Ctrl+R / F5) destroys the JS run without ever reaching the `finally`
  // that clears it — so the flag would survive into the fresh page with no job
  // behind it, and the window could never be closed again. Module init only ever
  // runs when no run can possibly be in flight, so unconditionally clearing here
  // is both safe and the only place that can recover from it.
  void invoke("set_scrobble_run_active", { active: false }).catch(() => {});
}
