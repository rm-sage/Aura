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
//
// Heuristics, in order of strength:
//   1. media_type === "anime"
//   2. id begins with "kitsu:" / "anilist:" / "mal:" / "anidb:" — common
//      AIOMetadata addon prefixes
//   3. genres includes "Anime" (case-insensitive) — catalog metadata only
// ---------------------------------------------------------------------------

const ANIME_ID_PREFIXES = ["kitsu:", "anilist:", "mal:", "anidb:"];

export function isAnimeMeta(
  meta: { media_type: string; id: string }
): boolean {
  if ((meta.media_type ?? "").toLowerCase() === "anime") return true;
  const id = (meta.id ?? "").toLowerCase();
  return ANIME_ID_PREFIXES.some((p) => id.startsWith(p));
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

