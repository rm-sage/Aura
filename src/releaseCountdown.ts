// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// releaseCountdown — shared "time until release" logic for the detail page
// meta strip and the catalog hover panel. Both surfaces call
// `computeReleaseCountdowns(detail)` and render the result with
// `formatCountdown`, so the rules live in exactly one place.
//
// Rules:
//   • Series / anime → ONE countdown to the earliest episode whose air
//     date is still in the future (across every season). This single rule
//     covers both cases the product spec calls out:
//       – currently airing  → counts down to the next unaired episode
//       – announced/first season not yet started → counts down to the
//         premiere (the first episode's date)
//     The label distinguishes them ("Next Episode" vs "Premieres") based
//     on whether ANY episode has already aired.
//   • Movies → up to TWO countdowns:
//       – cinematic: counts down to `detail.released` while that date is
//         still in the future ("In Theaters").
//       – digital:   counts down to `released + DIGITAL_WINDOW_DAYS`
//         ("Digital"). Stremio meta carries no authoritative digital /
//         streaming date, so we estimate with the modern PVOD window
//         (~45 days post-theatrical — the Universal/WB-era industry norm).
//         Shown whenever that estimated date is still in the future, so a
//         film already in theaters still shows a digital countdown.
//
// Everything is pure + timestamp-driven so it's trivially unit-testable and
// the UI can pass a ticking `now` for a live display.
// ---------------------------------------------------------------------------

import type { MetaDetail, VideoEntry } from "./types";

export type CountdownKind = "premiere" | "next-episode" | "cinematic" | "digital";

export interface ReleaseCountdown {
  kind: CountdownKind;
  /** Short UI label, e.g. "Next Episode", "Premieres", "In Theaters", "Digital". */
  label: string;
  /** Target release timestamp (ms since epoch). */
  targetMs: number;
  /** True when this target is the PVOD-window ESTIMATE (no authoritative
   *  date was available) rather than a real date. Only ever set on the
   *  `digital` kind; the UI marks estimated values (e.g. a "~" prefix). */
  estimated?: boolean;
}

/** Authoritative release dates resolved from MDBList (see releaseDates.ts).
 *  Both `YYYY-MM-DD`; either may be absent. Passed into
 *  `computeReleaseCountdowns` / `isInTheaters` to replace the estimate. */
export interface AccurateReleaseDates {
  theatrical?: string | null;
  digital?: string | null;
}

/** Days after theatrical release a film is assumed to hit digital when no
 *  authoritative digital date exists. The post-2021 PVOD / 45-day window is
 *  the industry norm; this is only an estimate (see module comment). */
export const DIGITAL_WINDOW_DAYS = 45;

/** Days after theatrical release a film is still treated as "in theaters"
 *  when no digital date has landed. Guards old catalog titles (which often
 *  carry a theatrical date but no recorded digital date) from reading as
 *  "In Theaters" indefinitely. ~120 days covers a typical wide + limited
 *  theatrical run. Only used by `isInTheaters`. */
export const IN_THEATERS_WINDOW_DAYS = 120;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Earliest future episode air date + whether anything has aired yet. */
function nextEpisodeRelease(
  videos: VideoEntry[] | undefined,
  nowMs: number,
): { targetMs: number | null; anyAired: boolean } {
  let earliestFuture: number | null = null;
  let anyAired = false;
  for (const v of videos ?? []) {
    const t = parseMs(v.released);
    if (t == null) continue;
    if (t <= nowMs) {
      anyAired = true;
      continue;
    }
    if (earliestFuture == null || t < earliestFuture) earliestFuture = t;
  }
  return { targetMs: earliestFuture, anyAired };
}

/**
 * Compute the release countdown(s) for a meta detail, relative to `nowMs`.
 * Returns 0, 1, or 2 entries (movies can carry both cinematic + digital).
 * Entries are returned in display order (cinematic before digital).
 */
export function computeReleaseCountdowns(
  detail: Pick<MetaDetail, "media_type" | "released" | "videos">,
  nowMs: number = Date.now(),
  dates?: AccurateReleaseDates | null,
): ReleaseCountdown[] {
  const mediaType = (detail.media_type ?? "").toLowerCase();
  const isEpisodic = mediaType === "series" || mediaType === "anime";

  if (isEpisodic) {
    const { targetMs, anyAired } = nextEpisodeRelease(detail.videos, nowMs);
    if (targetMs == null) return [];
    return [
      {
        kind: anyAired ? "next-episode" : "premiere",
        label: anyAired ? "Next Episode" : "Premieres",
        targetMs,
      },
    ];
  }

  // Movies (and any other non-episodic single-release content). Prefer
  // MDBList's authoritative theatrical date when resolved, else the addon's
  // `released` (usually the same value).
  const cinematicMs = parseMs(dates?.theatrical) ?? parseMs(detail.released);
  if (cinematicMs == null) return [];

  const out: ReleaseCountdown[] = [];
  if (cinematicMs > nowMs) {
    out.push({ kind: "cinematic", label: "In Theaters", targetMs: cinematicMs });
  }
  // Accurate digital date from MDBList when known; otherwise fall back to
  // the PVOD-window estimate and flag it so the UI can mark it. The old
  // fixed estimate routinely drifted 20–40+ days off the real date.
  const accurateDigitalMs = parseMs(dates?.digital);
  const digitalMs = accurateDigitalMs ?? cinematicMs + DIGITAL_WINDOW_DAYS * DAY_MS;
  if (digitalMs > nowMs) {
    out.push({
      kind: "digital",
      label: "Digital",
      targetMs: digitalMs,
      estimated: accurateDigitalMs == null,
    });
  }
  return out;
}

/**
 * Whether a movie is currently in theaters, from accurate MDBList dates.
 * True when its theatrical date has passed, it hasn't reached digital yet
 * (or digital is still unknown), AND the theatrical date is within the
 * freshness window. Returns false for series/anime and whenever accurate
 * dates aren't available — so the persistent "In Theaters" tag only shows
 * on real data, never on the +45-day guess.
 *
 * The digital cutoff is the key discriminator: once the digital date
 * passes, the film has entered the home window and drops out of "In
 * Theaters" even if technically still on some screens.
 */
export function isInTheaters(
  mediaType: string | null | undefined,
  dates: AccurateReleaseDates | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const mt = (mediaType ?? "").toLowerCase();
  if (mt === "series" || mt === "anime") return false;
  if (!dates) return false;
  const theatrical = parseMs(dates.theatrical);
  if (theatrical == null || theatrical > nowMs) return false;
  if (nowMs - theatrical > IN_THEATERS_WINDOW_DAYS * DAY_MS) return false;
  const digital = parseMs(dates.digital);
  if (digital != null && digital <= nowMs) return false;
  return true;
}

/**
 * The earliest future-dated episode across every season (the one airing
 * next) and its target timestamp, or null when nothing is upcoming. Single
 * source of truth for "which episode is next to air" — shared by the
 * episode-list "next airing" highlight (DetailView + the in-player drawer)
 * and the EOS caught-up countdown, so all three agree. Mirrors the future-
 * date scan `computeReleaseCountdowns` uses for series, but returns the id
 * so a specific row can light up.
 */
export function nextAiringEpisode(
  videos: VideoEntry[] | undefined,
  nowMs: number = Date.now(),
  opts?: { mainRunOnly?: boolean },
): { id: string; targetMs: number } | null {
  // `mainRunOnly` skips specials (season 0). Callers deciding "when does the
  // SHOW air next" (CW countdown, Airing page) pass it so a lone upcoming
  // special can't stand in for a real next episode; the episode-list "next to
  // air" highlight leaves it off so it still flags whatever airs next in the
  // full list.
  const mainRunOnly = opts?.mainRunOnly === true;
  let best: { id: string; targetMs: number } | null = null;
  for (const v of videos ?? []) {
    if (mainRunOnly && v.season === 0) continue;
    const t = parseMs(v.released);
    if (t == null || t <= nowMs) continue;
    if (best == null || t < best.targetMs) best = { id: v.id, targetMs: t };
  }
  return best;
}

/** Airing snapshot for a series' episode list. Single source of truth for the
 *  CW latest-aired marker (4a) and the "episodes behind" count (4c).
 *  - isAiring: at least one aired episode AND at least one not-yet-aired
 *    episode (has content out, not finished).
 *  - latestAiredId / latestAiredEpisode: the highest-released episode with
 *    released <= now.
 *  - airedCount: episodes whose air date is in the past.
 *
 *  MAIN-RUN ONLY: specials (season 0) are excluded from every field. A finished
 *  show with an upcoming special (My Hero Academia after its final season) must
 *  NOT read as airing just because a season-0 episode is dated in the future;
 *  specials are a separate track (see findNextEpisode / episodeIsBeforeResume).*/
export function airingInfo(
  videos: VideoEntry[] | undefined,
  nowMs: number = Date.now(),
): { isAiring: boolean; latestAiredId: string | null; latestAiredEpisode: number | null; airedCount: number } {
  let airedCount = 0;
  let anyFuture = false;
  let latestAiredId: string | null = null;
  let latestAiredEpisode: number | null = null;
  let latestAiredMs = -Infinity;
  for (const v of videos ?? []) {
    if (v.season === 0) continue; // specials never count as the show airing
    const t = parseMs(v.released);
    if (t == null) continue;
    if (t <= nowMs) {
      airedCount += 1;
      if (t > latestAiredMs) {
        latestAiredMs = t;
        latestAiredId = v.id;
        latestAiredEpisode = v.episode ?? null;
      }
    } else {
      anyFuture = true;
    }
  }
  return { isAiring: airedCount > 0 && anyFuture, latestAiredId, latestAiredEpisode, airedCount };
}

/** Whether `formatCountdown(target, now, opts)` will print a seconds field.
 *
 *  SINGLE SOURCE OF TRUTH, read by the formatter below AND by
 *  `useCountdownNow` to pick its tick period. Keeping both on this one
 *  predicate is the entire point: they drifted apart once already (the hook
 *  assumed "no seconds are shown more than an hour out" while the formatter
 *  only ever drops seconds past a DAY, and only in compact mode), which left
 *  the Continue-Watching pill printing a live seconds digit that advanced in
 *  30-second jumps. If you add a new seconds-suppression rule to
 *  formatCountdown, add it HERE, not inline. */
function showsSeconds(remainingMs: number, opts?: { compactDays?: boolean }): boolean {
  return !(opts?.compactDays === true && remainingMs >= DAY_MS);
}

/**
 * Full-precision countdown string, down to the second:
 * "30d 16h 05m 30s", "16h 05m 30s", "5m 30s", or "30s". Lower units are
 * zero-padded once a larger unit is present so the ticking display doesn't
 * jitter in width. Returns "Released" once the target is in the past
 * (callers usually filter those out via computeReleaseCountdowns, but this
 * keeps the formatter total).
 *
 * Seconds are shown in every case except compact mode at day scale (see
 * `showsSeconds`). Whatever you pass as `opts` here, pass the SAME opts to
 * `useCountdownNow` so the tick cadence matches the precision on screen.
 */
export function formatCountdown(
  targetMs: number,
  nowMs: number = Date.now(),
  opts?: { compactDays?: boolean },
): string {
  const remaining = targetMs - nowMs;
  if (remaining <= 0) return "Released";
  let delta = remaining;
  const days = Math.floor(delta / DAY_MS);
  delta -= days * DAY_MS;
  const hours = Math.floor(delta / HOUR_MS);
  delta -= hours * HOUR_MS;
  const mins = Math.floor(delta / MIN_MS);
  delta -= mins * MIN_MS;
  const secs = Math.floor(delta / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  // Compact mode (opt-in, used by the narrow episode-drawer chip): at
  // day-scale the seconds are noise AND push the string past the 120px
  // cell, so drop them ("13d 12h 13m" instead of "13d 12h 13m 19s").
  if (!showsSeconds(remaining, opts)) return `${days}d ${pad(hours)}h ${pad(mins)}m`;
  if (days > 0) return `${days}d ${pad(hours)}h ${pad(mins)}m ${pad(secs)}s`;
  if (hours > 0) return `${hours}h ${pad(mins)}m ${pad(secs)}s`;
  if (mins > 0) return `${mins}m ${pad(secs)}s`;
  return `${secs}s`;
}

/** Full target date for tooltips, e.g. "Mar 12, 2026". */
export function formatTargetDate(targetMs: number): string {
  return new Date(targetMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// React tick hook — re-renders the caller so countdowns advance live.
//
// IMPORTANT: call this in the SMALLEST component that actually shows the
// countdown text (a leaf display component), never in a heavy parent like
// DetailViewBody or a Continue-Watching row — otherwise the whole subtree
// re-renders every second. The set of countdowns (computeReleaseCountdowns)
// rarely changes, so compute that in the parent and let each leaf tick its
// own value.
//
// CPU: two built-in economies, both invisible to the caller.
//   * Adaptive cadence. The tick period is derived from `showsSeconds`, i.e.
//     from what formatCountdown will ACTUALLY print for this target and these
//     opts: 1 s whenever a seconds field is on screen, COARSE_TICK_MS once the
//     smallest visible unit is minutes (compact mode at day scale). Pass the
//     SAME `opts` you pass to formatCountdown. Omitting them makes the hook
//     assume seconds are visible and tick at 1 s, which is the safe direction.
//
//     LANDMINE: do NOT coarsen on a plain "the target is far away" test. That
//     was the original rule and it was wrong, because formatCountdown prints
//     seconds at day scale too: the Continue-Watching pill sat frozen for 30 s
//     at a time and then jumped by 30, and the episode chip did the same for
//     the ~23 h before every episode. Cadence must follow the RENDERED
//     precision, never the distance to the target.
//   * Hidden gate. While the window is minimized no countdown text is visible,
//     so the interval is torn down entirely and `now` snaps forward the instant
//     the window is restored. Deliberately minimize-only, and deliberately the
//     only tier: a merely unfocused window keeps ticking, and there is no
//     "occluded" tier, because one tick is a single leaf re-render (well under
//     a millisecond even with every countdown on screen) and throttling it
//     further would not save measurable CPU. Occlusion is not detectable here
//     anyway (see windowVisibility.ts).
// ---------------------------------------------------------------------------

import { useState, useEffect } from "react";
import { useWindowHidden } from "./windowVisibility";

/** Tick used only when the smallest VISIBLE unit is minutes. 30 s is a 2x
 *  oversample of a 60 s display unit, so the minute is never more than ~30 s
 *  behind, at 1/30th the wakeups of the 1 s tick. */
const COARSE_TICK_MS = 30_000;

export function useCountdownNow(
  targetMs?: number,
  opts?: { compactDays?: boolean },
): number {
  const [now, setNow] = useState(() => Date.now());
  const hidden = useWindowHidden();
  // Recomputed from `now`, so the cadence sharpens on its own as the target
  // closes in and the formatter starts printing seconds. `intervalMs` is a
  // plain number, which keeps `opts` out of the dep array below: a fresh object
  // literal every render must not re-arm the interval.
  const intervalMs =
    targetMs != null && !showsSeconds(targetMs - now, opts) ? COARSE_TICK_MS : 1_000;
  useEffect(() => {
    if (hidden) return; // nothing visible to tick while minimized
    setNow(Date.now()); // snap on (re)mount and on resume from hidden
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, hidden]);
  return now;
}
