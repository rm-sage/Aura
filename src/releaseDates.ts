// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// releaseDates — accurate movie Digital + Theatrical dates from MDBList.
//
// Aura used to estimate a film's digital release as "theatrical + 45 days",
// which routinely drifted 20–40+ days off the real date. MDBList (whose key
// Aura already bakes in) returns the authoritative `released` (theatrical)
// and `released_digital` (digital/PVOD) per IMDb id. This module fetches
// those once per movie id (session-cached + single-flight) and exposes a
// tiny hook the detail page and the catalog hover panel both consume.
//
// Consumers feed the result into `computeReleaseCountdowns` (accurate Digital
// countdown, estimate only as a labeled fallback) and `isInTheaters` (the new
// "In Theaters" tag). See releaseCountdown.ts.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dedupedInvoke } from "./invokeDedupe";

export interface ReleaseDates {
  /** Theatrical release date `YYYY-MM-DD`, or null when unknown. */
  theatrical: string | null;
  /** Digital / streaming (PVOD/EST) date `YYYY-MM-DD`, or null when not
   *  yet announced (the caller then falls back to the +45-day estimate). */
  digital: string | null;
}

// Session cache keyed by IMDb id. `undefined` = never fetched; a stored
// value (possibly all-null) = fetched, so a movie with no MDBList record
// isn't re-requested every hover. In-memory only — these are tiny and the
// metaCache already covers warm re-opens of the heavier detail payload.
const cache = new Map<string, ReleaseDates>();

/** Whether a meta id + type denotes a movie we can date via MDBList (IMDb
 *  `tt`-keyed, non-episodic). Series/anime use the per-episode air dates. */
export function isDatableMovie(
  id: string | null | undefined,
  mediaType: string | null | undefined,
): boolean {
  if (!id || !id.startsWith("tt")) return false;
  const mt = (mediaType ?? "").toLowerCase();
  return mt !== "series" && mt !== "anime";
}

/** Fetch (and cache) accurate release dates for a movie by IMDb id.
 *  Best-effort: any failure resolves to all-null rather than throwing. */
export async function getMovieReleaseDates(imdbId: string): Promise<ReleaseDates> {
  const hit = cache.get(imdbId);
  if (hit) return hit;
  const res = await dedupedInvoke(`release-dates:${imdbId}`, () =>
    invoke<{ theatrical?: string | null; digital?: string | null }>(
      "fetch_movie_release_dates",
      { imdbId },
    ).catch(() => null),
  );
  const dates: ReleaseDates = {
    theatrical: res?.theatrical ?? null,
    digital: res?.digital ?? null,
  };
  cache.set(imdbId, dates);
  return dates;
}

/** Accurate release dates for a movie, or null for non-movies / before the
 *  fetch lands. Pass to `computeReleaseCountdowns` + `isInTheaters`. */
export function useMovieReleaseDates(
  id: string | null | undefined,
  mediaType: string | null | undefined,
): ReleaseDates | null {
  const datable = isDatableMovie(id, mediaType);
  const [dates, setDates] = useState<ReleaseDates | null>(
    () => (datable && id ? cache.get(id) ?? null : null),
  );
  useEffect(() => {
    if (!datable || !id) {
      setDates(null);
      return;
    }
    const cached = cache.get(id);
    if (cached) {
      setDates(cached);
      return;
    }
    let cancelled = false;
    getMovieReleaseDates(id)
      .then((d) => { if (!cancelled) setDates(d); })
      .catch(() => { if (!cancelled) setDates(null); });
    return () => { cancelled = true; };
  }, [id, datable]);
  return dates;
}
