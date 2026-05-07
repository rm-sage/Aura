// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AddonEntry, MetaPreview, LibraryItem } from "./types";

// ---------------------------------------------------------------------------
// AIOMetadata helpers
//
// Stremio + AIOMetadata addons expose `type` strings that don't always read
// well in UI: "movie" → "Movies", "series" → "Series", "anime" → "Anime",
// "channels"/"tv" → "Channels", etc.
//
// `typeLabel(t)` produces the title-case suffix; `withTypeSuffix(name, t)`
// appends it to a catalog name with a space (no hyphens), e.g.
// "Trending Movies", "New Anime", "Top Rated Series".
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<string, string> = {
  movie:    "Movies",
  movies:   "Movies",
  series:   "Series",
  show:     "Series",
  tv:       "Channels",
  channel:  "Channels",
  channels: "Channels",
  anime:    "Anime",
  manga:    "Manga",
  music:    "Music",
  podcast:  "Podcasts",
  book:     "Books",
  game:     "Games",
  other:    "Other",
};

export function typeLabel(rawType: string): string {
  const key = (rawType ?? "").toLowerCase().trim();
  if (TYPE_LABELS[key]) return TYPE_LABELS[key];
  // Fallback: title-case the raw type
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "Other";
}

/**
 * Append a content-type suffix to a row title without a hyphen.
 *
 *   withTypeSuffix("Trending", "movie")          → "Trending Movies"
 *   withTypeSuffix("Top - Series", "series")     → "Top - Series" (already includes label)
 *   withTypeSuffix("Anime Catalog", "anime")     → "Anime Catalog"  (avoids dup)
 */
export function withTypeSuffix(name: string, rawType: string): string {
  const label = typeLabel(rawType);
  if (!label) return name;
  // Don't double-tag if the catalog name already ends with (or contains) the label.
  if (new RegExp(`\\b${label}\\b`, "i").test(name)) return name;
  return `${name} ${label}`;
}

// ---------------------------------------------------------------------------
// isAnime — used to pick anime-specific defaults (audio/subs language)
// AND to gate the anime-only external-source list (AniList / MAL / Kitsu).
//
// Heuristics, in order of strength:
//   1. media_type === "anime"
//   2. id begins with "kitsu:" / "anilist:" / "mal:" / "anidb:" — common
//      AIOMetadata addon prefixes
//   3. genres includes "Anime" (case-insensitive). Many anime are
//      surfaced from catalogs that tag their media_type as "series" or
//      "movie" but stamp the "Anime" genre — without this branch we'd
//      mis-classify them as live-action and offer IMDb / RT / Letterboxd
//      menu options that have no useful results.
//   4. localStorage anime-id cache (populated once DetailView resolves
//      meta detail for an item with the Anime genre). Backfills the gap
//      for items already in the library that pre-date Aura writing
//      genres into state — without it, an IMDb-id'd Frieren entry whose
//      catalog meta has been stripped down to the Stremio library
//      record can't tell us it's anime, so the right-click menu would
//      keep offering live-action sources.
// ---------------------------------------------------------------------------

const ANIME_ID_PREFIXES = ["kitsu:", "anilist:", "mal:", "anidb:"];
const ANIME_CACHE_KEY = "aura:anime-id-cache:v1";

let _animeCache: Set<string> | null = null;

function loadAnimeCache(): Set<string> {
  if (_animeCache) return _animeCache;
  try {
    const raw = localStorage.getItem(ANIME_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        _animeCache = new Set(parsed.filter((s): s is string => typeof s === "string"));
        return _animeCache;
      }
    }
  } catch { /* corrupted — fall through to empty */ }
  _animeCache = new Set();
  return _animeCache;
}

function saveAnimeCache(): void {
  if (!_animeCache) return;
  try {
    localStorage.setItem(ANIME_CACHE_KEY, JSON.stringify([..._animeCache]));
  } catch { /* quota exceeded — non-fatal */ }
}

/** Stamp an id as anime in the persistent cache. Called by DetailView /
 *  Calendar / anywhere meta detail resolves with the Anime genre, so
 *  the next time a CW card or library entry references this id we can
 *  classify it correctly without needing a fresh meta fetch. */
export function markAnimeId(id: string): void {
  if (!id) return;
  const cache = loadAnimeCache();
  if (cache.has(id)) return;
  cache.add(id);
  saveAnimeCache();
}

/** Inverse: stamp as definitively NOT anime so we don't keep checking
 *  for live-action items the user has visited. */
export function markNotAnimeId(_id: string): void {
  // Intentional no-op: we never want to convert a true → false in the
  // cache because catalog metadata is sometimes incomplete (genres
  // missing on first response, present on a re-fetch). A false negative
  // here just means we miss the anime-only menu once; a false positive
  // from clearing the cache would leak across many sessions.
}

export function isAnimeMeta(
  meta: { media_type: string; id: string; genres?: string[] | null }
): boolean {
  if ((meta.media_type ?? "").toLowerCase() === "anime") return true;
  const id = (meta.id ?? "").toLowerCase();
  if (ANIME_ID_PREFIXES.some((p) => id.startsWith(p))) return true;
  const genres = meta.genres;
  if (Array.isArray(genres)) {
    for (const g of genres) {
      if (typeof g !== "string") continue;
      const trimmed = g.trim();
      if (/^anime$/i.test(trimmed)) return true;
      // Many addons (AIOMetadata included) tag anime under the canonical
      // Stremio "Animation" genre, not "Anime" — that's the umbrella
      // genre the spec inherits from TMDB. We treat Animation as anime
      // ONLY when the media_type is series-shaped: Western animated
      // films (Pixar, Dreamworks, Disney) skip into this branch as
      // movies and would mis-classify, but the vast majority of
      // animated SERIES on the user's installed addons IS anime.
      // Imperfect, but the alternative is missing every IMDb-id'd
      // anime in catalogs / search / library.
      if (/^animation$/i.test(trimmed)) {
        const t = (meta.media_type ?? "").toLowerCase();
        if (t === "series" || t === "anime") return true;
      }
    }
  }
  // Last-resort fallback: the localStorage cache populated by
  // DetailView whenever it resolves a meta detail with the Anime
  // genre. Covers items in the library whose catalog metadata has
  // been stripped down to the Stremio library record (no genres).
  if (meta.id && loadAnimeCache().has(meta.id)) return true;
  return false;
}

export function isAnimePreview(p: MetaPreview): boolean {
  return isAnimeMeta(p);
}

export function isAnimeLibraryItem(i: LibraryItem): boolean {
  return isAnimeMeta(i);
}

// ---------------------------------------------------------------------------
// AIOMetadata addon detection — used by SettingsView's scrobble lock.
//
// Match heuristic: addon name OR URL contains "aiometadata" / "aio-metadata"
// (case-insensitive). Returns the first match in the user's installed list.
// ---------------------------------------------------------------------------

export function findAIOMetadataAddon(addons: AddonEntry[]): AddonEntry | null {
  const isAIO = (s: string) => /aio[\s-]?metadata/i.test(s);
  for (const a of addons) {
    if (isAIO(a.name) || isAIO(a.url)) return a;
  }
  return null;
}

