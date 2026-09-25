// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { markIneligible, markIneligibleMany, markScrobbledMany } from "./scrobbledStore";
import {
  HISTORY_COMMAND,
  isRowHistoryService,
  type RowHistoryService,
  type ScrobbleService,
} from "./scrobbleConn";
import { pushSimklHistory, simklItemFromEntry } from "./scrobbleSimkl";
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
//
// SIMKL IS ONE STEP, after the per-row loop. Its command takes every Simkl row
// of the run in a single call and paces the requests itself on the Rust side
// (chunks of 100, at least 1.1 s apart), so the loop's per-row spacing, retry
// and throttle do not apply to it. The call is one long await with no progress
// of its own to report, so the run shows it as one labelled step (`step`) and
// credits its rows only when the answer arrives, rather than inventing ticks.
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
  /** A single long step in flight (Simkl's batch), shown in place of the
   *  count while it runs. Empty otherwise. */
  step: string;
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
  /** A batched service (Simkl) is gathered out of the list and sent in one
   *  call; every other item is one push of the per-row loop. */
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

/** Base spacing between per-row pushes. Trakt's budget is roughly 1000 calls / 5 min.
 *
 *  AniList's is far tighter (~90/min) AND one "push" there is not one call: the
 *  resolve query, then the save mutation, and on a cold cache a search + a SEQUEL
 *  walk on top. Pacing at AniList's nominal one-per-670ms therefore still
 *  overruns it by 2x or worse, which is how a long run rate-limited itself even
 *  after the Trakt refresh storm was fixed. 1200 ms leaves real headroom, and
 *  since the AniList side is now collapsed to one push per season (see
 *  ScrobbleWorkItem.covers) there are far fewer of them to pace anyway.
 *
 *  These are the FLOOR: `throttle` only ever widens them. Simkl has no entry
 *  because it is not paced here: its one batched call is paced in Rust. */
const BASE_DELAY_MS: Record<RowHistoryService, number> = {
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
  running: false, done: 0, total: 0, ok: 0, failed: 0, backingOff: false, step: "", label: "",
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
 * same commands the single-row buttons call, and Trakt (idempotent on
 * `watched_at`), AniList (`AlreadyAhead`) and Simkl (a re-sent row is a no-op)
 * are the real gates.
 */
export async function startScrobbleRun(
  scope: string,
  work: ScrobbleWorkItem[],
  label: string,
): Promise<ScrobbleRunSummary | null> {
  if (state.running || work.length === 0) return null;

  // Per-row pushes and Simkl's batch, split once up front. The loop below only
  // ever sees per-row services, so it cannot invoke the batched command with
  // the per-row argument shape.
  const rowWork: Array<ScrobbleWorkItem & { service: RowHistoryService }> = [];
  const simklWork: Array<ScrobbleWorkItem & { service: "simkl" }> = [];
  for (const item of work) {
    const { service } = item;
    // A second batched service would not type-check here: it needs its own step.
    if (isRowHistoryService(service)) rowWork.push({ ...item, service });
    else simklWork.push({ ...item, service });
  }

  cancelRequested = false;
  setState({
    running: true, done: 0, total: work.length, ok: 0, failed: 0, backingOff: false, step: "", label,
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
    for (let i = 0; i < rowWork.length; i++) {
      if (cancelRequested) break;
      const { entry, service } = rowWork[i];

      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        if (cancelRequested) break;
        try {
          // Tauri maps these camelCase keys onto the Rust command's snake_case
          // params (parent_id, media_type, played_at, ...).
          await invoke<string>(
            HISTORY_COMMAND[service],
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
          for (const c of rowWork[i].covers ?? []) {
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
      if (i < rowWork.length - 1 && !cancelRequested) {
        await sleep(BASE_DELAY_MS[service] * throttle);
      }
    }

    // The last point a cancel can still leave work unsent, so the summary's
    // `cancelled` is read HERE and not after the step below: a press during
    // that step changes nothing, and must not be reported as a cancel.
    cancelled = cancelRequested;

    // Simkl: every row in ONE call, answers mapped back by index. Not started
    // after a cancel; once started it cannot be recalled (the bar hides its
    // Cancel meanwhile), so its answers are still recorded, since those
    // writes did happen.
    if (simklWork.length > 0 && !cancelled) {
      const n = simklWork.length;
      setState({ step: `Simkl: sending ${n} item${n === 1 ? "" : "s"}` });
      try {
        const results = await pushSimklHistory(
          scope, simklWork.map((w) => simklItemFromEntry(w.entry)),
        );
        const refused: string[] = [];
        results.forEach((r, i) => {
          const { entry } = simklWork[i];
          if (r.status === "added") {
            pending.push({ service: "simkl", id: entry.id, playedAt: entry.played_at });
            ok++;
            return;
          }
          // Same rule as a PERMANENT_PREFIX failure: a verdict about the item
          // retires it, so it is not re-sent and re-reported on every run.
          if (r.status === "not_found" || r.status === "skipped") refused.push(entry.id);
          failed++;
          if (!firstError) firstError = `${entry.name}: ${r.message}`;
        });
        markIneligibleMany(scope, "simkl", refused);
      } catch (err) {
        // Whole-batch refusal (not set up, not connected, sign-in gone): every
        // row stays unmarked for the next run.
        failed += n;
        if (!firstError) firstError = String(err);
      }
      setState({ step: "", done: rowWork.length + n, ok, failed });
    }
  } finally {
    // Cancelled, threw, or ran to completion: keep the marks we earned and ALWAYS
    // release the lock, or every future run would be blocked by `running`. No
    // `return` in here -- that would swallow a genuine throw.
    flush();
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
