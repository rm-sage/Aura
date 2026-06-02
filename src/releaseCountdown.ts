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
}

/** Days after theatrical release a film is assumed to hit digital when no
 *  authoritative digital date exists. The post-2021 PVOD / 45-day window is
 *  the industry norm; this is only an estimate (see module comment). */
export const DIGITAL_WINDOW_DAYS = 45;

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

  // Movies (and any other non-episodic single-release content).
  const cinematicMs = parseMs(detail.released);
  if (cinematicMs == null) return [];

  const out: ReleaseCountdown[] = [];
  if (cinematicMs > nowMs) {
    out.push({ kind: "cinematic", label: "In Theaters", targetMs: cinematicMs });
  }
  const digitalMs = cinematicMs + DIGITAL_WINDOW_DAYS * DAY_MS;
  if (digitalMs > nowMs) {
    out.push({ kind: "digital", label: "Digital", targetMs: digitalMs });
  }
  return out;
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
): { id: string; targetMs: number } | null {
  let best: { id: string; targetMs: number } | null = null;
  for (const v of videos ?? []) {
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
 *  - airedCount: episodes whose air date is in the past. */
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

/**
 * Full-precision countdown string, always down to the second:
 * "30d 16h 05m 30s", "16h 05m 30s", "5m 30s", or "30s". Lower units are
 * zero-padded once a larger unit is present so the ticking display doesn't
 * jitter in width. Returns "Released" once the target is in the past
 * (callers usually filter those out via computeReleaseCountdowns, but this
 * keeps the formatter total). Seconds are included everywhere by design —
 * consumers pair this with a 1 s tick (see useCountdownNow) so it advances
 * live.
 */
export function formatCountdown(
  targetMs: number,
  nowMs: number = Date.now(),
  opts?: { compactDays?: boolean },
): string {
  let delta = targetMs - nowMs;
  if (delta <= 0) return "Released";
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
  // cell, so drop them — "13d 12h 13m" instead of "13d 12h 13m 19s".
  if (days > 0 && opts?.compactDays) return `${days}d ${pad(hours)}h ${pad(mins)}m`;
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
// React tick hook — re-renders the caller every `intervalMs` so countdowns
// advance live. Defaults to 1 s now that formatCountdown shows seconds.
//
// IMPORTANT: call this in the SMALLEST component that actually shows the
// countdown text (a leaf display component), never in a heavy parent like
// DetailViewBody or a Continue-Watching row — otherwise the whole subtree
// re-renders every second. The set of countdowns (computeReleaseCountdowns)
// rarely changes, so compute that in the parent and let each leaf tick its
// own value.
// ---------------------------------------------------------------------------

import { useState, useEffect } from "react";

export function useCountdownNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
