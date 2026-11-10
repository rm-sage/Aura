// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// releaseDates: a movie's theatrical + digital dates for the user's region.
//
// Rust `fetch_movie_release_dates` reads TMDB's per-country release dates
// (the user's Windows "Country or region" first, then the US, then the
// earliest country), falling back to MDBList, and says for each date where
// it came from (`*_source`: "tmdb" | "mdblist") and which country's row it
// is (`*_region`). MDBList alone proved wrong (The Odyssey's digital date),
// which is why the source travels with the date: the UI marks a TMDB date
// Confirmed and an MDBList one Reported (movieRelease.ts).
//
// Fetched once per movie id (cached, single-flight) and exposed as a hook the
// detail page and the catalog hover panel both consume; they feed it to
// `computeReleaseCountdowns` and `isInTheaters` (releaseCountdown.ts). Rust
// looks the film up on TMDB by its IMDb id only: the addon meta's tmdb_id can
// be a SERIES id (externalSources.ts), and `/movie/{that id}` would then
// answer an unrelated film's dates as Confirmed.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { dedupedInvoke } from "./invokeDedupe";

export interface ReleaseDates {
  /** Theatrical release date `YYYY-MM-DD`, or null when unknown. */
  theatrical: string | null;
  /** "tmdb" | "mdblist", or null with no theatrical date. */
  theatricalSource: string | null;
  /** Alpha-2 country of the TMDB row the theatrical date came from. */
  theatricalRegion: string | null;
  /** Digital / streaming (PVOD/EST) date `YYYY-MM-DD`, or null when not
   *  yet announced (the caller then falls back to the +45-day estimate). */
  digital: string | null;
  /** "tmdb" | "mdblist", or null with no digital date. */
  digitalSource: string | null;
  /** Alpha-2 country of the TMDB row the digital date came from. */
  digitalRegion: string | null;
  /** The user's region the dates were asked for (alpha-2). */
  region: string | null;
  /** How Rust's TMDB lookup went: "ok" (TMDB answered, with or without
   *  dates), "none" (TMDB has no such film), "failed", "nokey"; null when
   *  the invoke itself failed. */
  tmdbStatus: string | null;
}

/** The command's reply, field names as Rust serialises them. */
interface WireReleaseDates {
  theatrical?: string | null;
  theatrical_source?: string | null;
  theatrical_region?: string | null;
  digital?: string | null;
  digital_source?: string | null;
  digital_region?: string | null;
  region?: string | null;
  tmdb?: string | null;
}

// Cache keyed by IMDb id. `undefined` = never fetched; a stored
// value (possibly all-null) = fetched, so a movie with no record isn't
// re-requested every hover. In-memory only: these are tiny and the
// metaCache already covers warm re-opens of the heavier detail payload.
// Two lifetimes:
//   - MISS_TTL_MS for an all-null answer AND for one whose TMDB lookup
//     failed. Rust answers a TMDB failure from MDBList alone, and MDBList is
//     exactly the source that was wrong (The Odyssey's Nov 7): holding that
//     for the session after one TMDB blip brought the original bug back.
//   - HIT_TTL_MS for everything else, so a date TMDB adds or corrects, or a
//     change of the Windows region, shows within hours rather than at the
//     next launch.
// Capped at CACHE_MAX, oldest first (Map keeps insertion order).
interface CacheEntry { dates: ReleaseDates; at: number }
const cache = new Map<string, CacheEntry>();
const MISS_TTL_MS = 5 * 60_000;
const HIT_TTL_MS = 6 * 60 * 60_000;
const CACHE_MAX = 500;

function ttlFor(d: ReleaseDates): number {
  const empty = d.theatrical === null && d.digital === null;
  return empty || d.tmdbStatus === "failed" ? MISS_TTL_MS : HIT_TTL_MS;
}

function cachedDates(imdbId: string): ReleaseDates | undefined {
  const hit = cache.get(imdbId);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlFor(hit.dates)) {
    cache.delete(imdbId);
    return undefined;
  }
  return hit.dates;
}

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

/** Fetch (and cache) a movie's release dates by IMDb id. Best-effort: any
 *  failure resolves to all-null rather than throwing. */
export async function getMovieReleaseDates(imdbId: string): Promise<ReleaseDates> {
  const hit = cachedDates(imdbId);
  if (hit) return hit;
  const res = await dedupedInvoke(`release-dates:${imdbId}`, () =>
    invoke<WireReleaseDates>("fetch_movie_release_dates", { imdbId }).catch(() => null),
  );
  const dates: ReleaseDates = {
    theatrical: res?.theatrical ?? null,
    theatricalSource: res?.theatrical ? res.theatrical_source ?? null : null,
    theatricalRegion: res?.theatrical ? res.theatrical_region ?? null : null,
    digital: res?.digital ?? null,
    digitalSource: res?.digital ? res.digital_source ?? null : null,
    digitalRegion: res?.digital ? res.digital_region ?? null : null,
    region: res?.region ?? null,
    tmdbStatus: res?.tmdb ?? null,
  };
  // A rejected invoke is not an answer: leave it uncached.
  if (res) {
    cache.delete(imdbId);
    cache.set(imdbId, { dates, at: Date.now() });
    while (cache.size > CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }
  return dates;
}

/** A movie's release dates, or null for non-movies / before the fetch
 *  lands. Pass to `computeReleaseCountdowns` + `isInTheaters`. */
export function useMovieReleaseDates(
  id: string | null | undefined,
  mediaType: string | null | undefined,
): ReleaseDates | null {
  const datable = isDatableMovie(id, mediaType);
  const [dates, setDates] = useState<ReleaseDates | null>(
    () => (datable && id ? cachedDates(id) ?? null : null),
  );
  useEffect(() => {
    if (!datable || !id) {
      setDates(null);
      return;
    }
    let cancelled = false;
    let retry: number | undefined;
    // A short-lived answer (TMDB failed, or nothing at all) is asked again
    // once its cache entry has expired, for as long as the page stays open:
    // otherwise a page left open keeps MDBList's word for it, which is the
    // wrong-date case this module exists to avoid. That holds for an answer
    // found in the cache too (the hover panel asked a minute ago): it is
    // asked again when the entry runs out, not never.
    const retryWhenExpired = (d: ReleaseDates) => {
      if (ttlFor(d) !== MISS_TTL_MS) return;
      const at = cache.get(id)?.at ?? Date.now();
      retry = window.setTimeout(load, Math.max(1_000, at + MISS_TTL_MS + 1_000 - Date.now()));
    };
    const load = () => {
      getMovieReleaseDates(id)
        .then((d) => {
          if (cancelled) return;
          setDates(d);
          retryWhenExpired(d);
        })
        .catch(() => { if (!cancelled) setDates(null); });
    };
    const cached = cachedDates(id);
    if (cached) {
      setDates(cached);
      retryWhenExpired(cached);
    } else {
      load();
    }
    return () => {
      cancelled = true;
      if (retry !== undefined) window.clearTimeout(retry);
    };
  }, [id, datable]);
  return dates;
}
