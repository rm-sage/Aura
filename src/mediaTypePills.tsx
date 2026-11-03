// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isAnimeMeta, typeLabel } from "./aiometadata";

// ---------------------------------------------------------------------------
// Media-type pills (All / Movies / Series / Anime) shared by the Library and
// Queue pages, plus the ONE classification both the pill counts and the grid
// filter read.
//
// The counts are FACETED: a pill's number is how many items the page would
// show if that pill were selected with every other active filter (status,
// airing, year / genre, name search) unchanged. That is why the caller hands
// `facetCounts` the TYPE-AGNOSTIC result of its other filters and narrows the
// grid with `kindMatches` over the very same list: the count on a pill and
// the grid it opens can never disagree, and picking Movies does not zero the
// other pills (they are counted against the same type-agnostic list).
// ---------------------------------------------------------------------------

export type MediaTypeFilter = "all" | "movie" | "series" | "anime";

export const MEDIA_TYPE_FILTERS: MediaTypeFilter[] = ["all", "movie", "series", "anime"];

const LABELS: Record<MediaTypeFilter, string> = {
  all: "All",
  movie: "Movies",
  series: "Series",
  anime: "Anime",
};

/** Which non-"all" pills an item belongs to. Movie and anime can both be
 *  true (an anime movie shows under Movies AND Anime, as it always has);
 *  series is LIVE-ACTION only, anime has its own pill. */
export interface MediaKinds {
  movie: boolean;
  series: boolean;
  anime: boolean;
}

/** Classify a library-shaped record. `rawGenres` is the record's
 *  `state.genres` (written by libraryActions on every add / progress write),
 *  which is what lets an IMDb-id'd anime (Frieren via tt...) land under Anime
 *  even though the bare Stremio record carries no anime id prefix. */
export function classifyMediaKinds(
  mediaType: string | null | undefined,
  id: string,
  rawGenres: unknown,
): MediaKinds {
  // typeLabel's aliases ("show", "movies"), so the pill agrees with the tile.
  const label = typeLabel(mediaType ?? "");
  const genres = Array.isArray(rawGenres)
    ? rawGenres.filter((g): g is string => typeof g === "string")
    : [];
  const anime = isAnimeMeta({ media_type: mediaType ?? "", id, genres });
  return {
    movie: label === "Movies",
    series: label === "Series" && !anime,
    anime,
  };
}

export function kindMatches(kinds: MediaKinds, filter: MediaTypeFilter): boolean {
  return filter === "all" ? true : kinds[filter];
}

/** One pass over the type-agnostic list. "all" is the list's length, i.e. the
 *  number the grid shows under All (types with no pill of their own, such as
 *  `tv` / `channel`, count there and nowhere else, exactly as the grid does). */
export function facetCounts<T>(
  list: readonly T[],
  kindsOf: (item: T) => MediaKinds,
): Record<MediaTypeFilter, number> {
  let movie = 0;
  let series = 0;
  let anime = 0;
  for (const it of list) {
    const k = kindsOf(it);
    if (k.movie) movie++;
    if (k.series) series++;
    if (k.anime) anime++;
  }
  return { all: list.length, movie, series, anime };
}

export function MediaTypePills({
  value, onChange, counts, disabled = false,
}: {
  value: MediaTypeFilter;
  onChange: (next: MediaTypeFilter) => void;
  counts: Record<MediaTypeFilter, number>;
  disabled?: boolean;
}) {
  return (
    <>
      {MEDIA_TYPE_FILTERS.map((f) => {
        const isActive = value === f;
        return (
          <button
            key={f}
            type="button"
            onClick={() => onChange(f)}
            disabled={disabled}
            aria-pressed={isActive}
            className={`nav-tap flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium
                        border transition-colors disabled:opacity-40
                        ${isActive
                          ? "bg-ln-accent/20 text-ln-accent border-ln-accent/30"
                          : "bg-white/5 text-white/55 border-white/10 hover:text-white/80 hover:bg-white/8"
                        }`}
          >
            {LABELS[f]}
            <span className="text-[10px] tabular-nums opacity-70">
              {counts[f]}
            </span>
          </button>
        );
      })}
    </>
  );
}
