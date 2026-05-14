// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface AddonEntry {
  url: string;
  name: string;
  /** Manifest-level `id` (e.g. "com.linvo.cinemeta", "community.aiometadata").
   *  Stable across deployments of the same addon — used by the default
   *  ordering logic so a user's preferred ordering survives an addon
   *  hostname change. May be empty for addons whose manifest predates
   *  this field being captured (back-compat with old addons.json). */
  manifest_id: string;
  has_search: boolean;
  /** Distinct media types covered by this addon's catalogs (movie, series, anime, …). */
  types: string[];
  /** Stremio resources this addon exposes (catalog, meta, stream, subtitles, …). */
  resources: string[];
  /** Optional per-resource override for the stream resource's `types`. */
  stream_types?: string[];
  /** Manifest-level `idPrefixes` array. */
  id_prefixes?: string[];
  /** Per-resource override of `idPrefixes` for the stream resource. */
  stream_id_prefixes?: string[];
}

/** One cast / producer entry with optional character pairing + photo.
 *  Sourced from AIOMetadata's `app_extras.cast` shape. The frontend
 *  pairs name with character ("Actor as Role") when both are present
 *  and shows the photo on hover when available. */
export interface CastMember {
  name: string;
  character: string | null;
  photo: string | null;
}

/** Crew entry — same `name`/`photo` as cast plus a job and optional
 *  department. Sourced from `app_extras.seasonCredits[s].crew` on
 *  TMDB / TVDB series. */
export interface CrewMember {
  name: string;
  job: string;
  department: string | null;
  photo: string | null;
}

/** Per-season cast/crew roster from `app_extras.seasonCredits[<n>]`.
 *  TMDB / TVDB series only — empty on movies + MAL-meta anime. */
export interface SeasonCredits {
  name: string | null;
  overview: string | null;
  air_date: string | null;
  poster: string | null;
  cast: CastMember[];
  crew: CrewMember[];
}

/** Show-level aggregate credits from `app_extras.aggregateCredits`.
 *  TMDB-only. Powers the cast hover overlay's tier classification. */
export interface AggregateCredits {
  cast: AggCast[];
  crew: AggCrew[];
}

export interface AggCast {
  name: string;
  character: string | null;
  photo: string | null;
  total_episode_count: number;
  roles: { character: string; episode_count: number }[];
}

export interface AggCrew {
  name: string;
  department: string | null;
  jobs: { job: string; episode_count: number }[];
  total_episode_count: number;
  photo: string | null;
}

export interface ExternalSubtitle {
  url: string;
  lang: string;
  addon_name: string;
  label: string | null;
}

/** MPV track-list entry — one row per audio / video / subtitle track. */
export interface TrackEntry {
  id: number;
  type: "video" | "audio" | "sub" | string;
  title: string | null;
  lang: string | null;
  selected: boolean;
  external: boolean;
  codec: string | null;
}

/** Per-addon-catalog search results — drives the Search view's per-addon
 *  discrete sections (Stremio-style). */
export interface SearchGroup {
  addon_name:   string;
  addon_url:    string;
  catalog_id:   string;
  catalog_name: string;
  media_type:   string;
  items:        MetaPreview[];
}

export interface MetaPreview {
  id: string;
  name: string;
  media_type: string;
  /** Portrait poster — primary card art. */
  poster: string | null;
  /** Landscape art (Stremio canonical "background"). */
  background: string | null;
  /** Community/AIOMetadata "fanart" field — landscape hero art. */
  fanart: string | null;
  /** Community/AIOMetadata "backdrop" field — alt landscape art. */
  backdrop: string | null;
  logo: string | null;
  release_info: string | null;
  description: string | null;
  imdb_rating: string | null;
  genres: string[];
}

export interface MetaDetail {
  id: string;
  name: string;
  media_type: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  description: string | null;
  release_info: string | null;
  released: string | null;
  runtime: string | null;
  imdb_rating: string | null;
  genres: string[];
  cast: string[];
  /** Rich cast entries from `meta.app_extras.cast` ({ name, character,
   *  photo }). Empty for Cinemeta / Kitsu-anime / older cached entries
   *  — UI falls back to the plain `cast` name array in that case.
   *  For MAL-anime meta this also doubles as the voice-actor pairings
   *  (MAL's "cast" is the voice ensemble paired to characters). */
  cast_detailed: CastMember[];
  director: string[];
  writer: string[];
  /** Producers (executive / line / co-producer mixed). Capped to 20 entries. */
  producer: string[];
  /** Rich producer entries — same shape as cast_detailed, populated
   *  from `app_extras.producers` on TVmaze series. Empty otherwise. */
  producer_detailed: CastMember[];
  /** Music composers / score artists. Capped to 4 entries. */
  composer: string[];
  /** Show or story creators. Capped to 4 entries. */
  creator: string[];
  /** Voice actors — empty for live-action. Sourced from anime-aware
   *  addons under voiceActors / voice_actors / voiceCast. */
  voice_actors: string[];
  /** Production studios — anime / animated content. Capped to 6. */
  studios: string[];
  /** MyAnimeList numeric id when the addon stamps one. Drives AniSkip
   *  lookups for the OP/ED auto-skip feature. */
  mal_id: number | null;
  /** Kitsu numeric id (future kitsu→mal AniSkip fallback). */
  kitsu_id: number | null;
  /** AniDB numeric id (future anidb→mal AniSkip fallback). */
  anidb_id: number | null;
  country: string | null;
  /** ISO 639-1 (e.g. "ko", "ja", "en") — drives the "original" token in
   *  the audio_priority preference list. Null when the addon doesn't
   *  expose `originalLanguage`. */
  original_language: string | null;
  /** ISO 3166-1 alpha-2 (["KR"], ["DE","GB","US"]) — used as a regional
   *  tiebreak when the language code matches multiple variants. */
  production_countries: string[];
  ratings: { source: string; value: string }[];
  videos: VideoEntry[];
  /** Per-season cast/crew rosters keyed by season number. Empty on
   *  movies / MAL-meta anime / older cached entries — UI falls back
   *  to `cast_detailed` (show-level) when this is empty. Note: Tauri
   *  serialises Rust's BTreeMap<u32, _> as `{ "1": …, "2": … }`, so
   *  the key here is a string at the wire level even though the
   *  numeric semantics are preserved. */
  season_credits: { [seasonNumber: string]: SeasonCredits };
  /** Show-level credits with episode counts (TMDB-only). Null on
   *  TVDB / IMDb / Kitsu / MAL meta. Used by the cast hover overlay
   *  for Main / Recurring / Guest tier classification. */
  aggregate_credits: AggregateCredits | null;
}

export interface VideoEntry {
  /** Exact addon id — passed verbatim to fetch_streams. Forms like
   *  `kitsu:12345:1`, `tt0903747:1:5` are common; do not mangle. */
  id: string;
  title: string;
  season: number | null;
  episode: number | null;
  released: string | null;
  thumbnail: string | null;
  overview: string | null;
  /** AIOMetadata's per-episode kind classification for anime:
   *  `"filler"` / `"recap"` / `"normal"` / `"canon"` / `"mixed"`. Aura
   *  paints a banner on the episode row in DetailView and the
   *  next-up auto-advance can be configured to skip filler/recap.
   *  `null` = upstream didn't emit the field (movies, non-anime
   *  series, older addons without the patch). Kept for back-compat
   *  with downstream surfaces that branch on single-value shape;
   *  for the dual-flag case see `is_filler` / `is_recap` below. */
  episode_kind: string | null;
  /** Independent filler flag — true when AIOMetadata flagged the
   *  episode as filler. Can coexist with `is_recap=true` per the
   *  release-search-spec §6.3 contract (one episode can be both). */
  is_filler?: boolean;
  /** Independent recap flag — see `is_filler`. */
  is_recap?: boolean;
}

/** True when a video has aired (release date in the past) or its
 *  release date is unknown / unparseable. The "unknown date counts
 *  as aired" fallback is intentional — some addons don't ship dates
 *  on episodes that have clearly been out for years, and treating
 *  those as "not aired" would silently hide them from the bulk
 *  mark-as-watched fan-out and the CW continuous-bar threshold.
 *
 *  Used by:
 *    • App.tsx catalog-level "Mark as Watched" — avoids marking
 *      unaired future episodes that the user couldn't have watched.
 *    • DetailView bulk-mark actions — same reason.
 *    • CinemaRows segmented-vs-continuous bar pivot — the
 *      50-episode threshold should consider aired-only count so a
 *      show with 14 future eps still on the schedule doesn't pivot
 *      to the long-runner gradient prematurely. */
export function isVideoAired(v: { released?: string | null }): boolean {
  if (!v.released) return true;
  const t = Date.parse(v.released);
  return !Number.isFinite(t) || t <= Date.now();
}

export interface StreamEntry {
  title: string;
  addon_name: string;
  url: string | null;
  info_hash: string | null;
  file_idx: number | null;
  description: string | null;
}

/** AIOStreams emits structured payloads alongside the canonical `streams`
 *  array — errors, warnings, info notes, and per-fetch statistics. The Rust
 *  side aggregates them across every queried addon and tags each row with
 *  the originating addon name so the UI can route messages to floating
 *  status icons (when streams exist) or expand them into the panel's
 *  empty state (when there are zero streams). */
export interface StreamMessage {
  /** "error" | "warning" | "info" | "stats" — colour-coding hint. */
  kind: string;
  /** Optional short heading. */
  title: string | null;
  /** Body text. May be empty when the addon only ships a title. */
  description: string;
  /** Source addon's display name. */
  addon_name: string;
  /** AIOStreams `streamData.forced` — true when the addon owner has
   *  marked this notice as un-suppressible (Digital Release Filter,
   *  disabled-stream-types removal reasons, etc.). The "Show AIOStreams
   *  notices" Aura setting hides everything that ISN'T forced when off,
   *  so a user can mute routine timing/scrape stats while still seeing
   *  the warnings the addon explicitly wants surfaced. False on the
   *  named-array shape (older AIOStreams instances and pre-patch). */
  forced?: boolean;
}

export interface StreamMetadata {
  errors:   StreamMessage[];
  warnings: StreamMessage[];
  info:     StreamMessage[];
  stats:    StreamMessage[];
}

export interface StreamFetchResult {
  streams:  StreamEntry[];
  metadata: StreamMetadata;
}

export interface SubtitleEntry {
  file_id: number;
  release: string;
  language: string;
  feature_title: string;
  fps: number | null;
  download_count: number | null;
  hearing_impaired: boolean;
  /** OpenSubtitles flagged this entry as a MovieHash match against
   *  the supplied moviehash + moviebytesize. Frame-accurate to that
   *  release; surfaced in the picker as a "Hash match" badge and
   *  bubbled to the top of the results list. */
  moviehash_match?: boolean;
}

export interface LibraryState {
  /** Time offset of last playback in seconds. */
  timeOffset?: number;
  /** Optional resolved video / episode id. */
  video_id?: string;
  /** MPV duration captured at the time of save. */
  duration?: number;
  [k: string]: unknown;
}

export interface LibraryItem {
  id: string;
  media_type: string;
  name: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  year: string | null;
  removed: boolean;
  temp: boolean;
  ctime: string | null;
  mtime: string | null;
  state: LibraryState;
}

export type ThemeId =
  | "mica"
  | "glass"
  | "midnight"
  | "ember"      // warm amber accent on charcoal
  | "forest"    // emerald accent on deep slate
  | "rose"      // rose / pink accent on plum-grey
  | "amethyst"  // violet accent on indigo-black
  | "ocean"     // teal accent on midnight blue
  | "solar";    // golden / sunburst on warm dark

export interface AppSettings {
  theme: ThemeId;
}

/** Stable identifiers for actions consumers can rebind. */
export type KeybindAction =
  | "toggle-pause"
  | "seek-back"
  | "seek-forward"
  | "volume-up"
  | "volume-down"
  | "toggle-osd"
  | "cycle-shader"
  | "toggle-subtitles"
  | "fullscreen"
  | "toggle-panscan"
  | "frame-step-forward"
  | "frame-step-back"
  // Anime4K v4 reference modes — bound to Ctrl+1..6 by default,
  // mirroring the Stremio Community v5 / canonical Anime4K bindings.
  // Ctrl+0 disables upscaling (sets profile 0 / "None").
  | "anime4k-a"     // Mode A   (Ctrl+1)
  | "anime4k-b"     // Mode B   (Ctrl+2)
  | "anime4k-c"     // Mode C   (Ctrl+3)
  | "anime4k-aa"    // Mode A+A (Ctrl+4)
  | "anime4k-bb"    // Mode B+B (Ctrl+5)
  | "anime4k-cc"    // Mode C+C (Ctrl+6)
  | "anime4k-none"; // Disable  (Ctrl+0)

export const KEYBIND_ACTIONS: { id: KeybindAction; label: string; description: string }[] = [
  { id: "toggle-pause",     label: "Toggle Play / Pause", description: "Resume or pause playback" },
  { id: "seek-back",        label: "Seek Back",            description: "Skip backward 10 seconds" },
  { id: "seek-forward",     label: "Seek Forward",         description: "Skip forward 10 seconds" },
  { id: "volume-up",        label: "Volume Up",            description: "Increase volume by 2%" },
  { id: "volume-down",      label: "Volume Down",          description: "Decrease volume by 2%" },
  { id: "toggle-osd",       label: "Toggle Performance OSD", description: "Show or hide the perf overlay" },
  { id: "cycle-shader",     label: "Cycle Shader Profile", description: "Step through upscaling profiles" },
  { id: "toggle-subtitles", label: "Toggle Subtitles",     description: "Open or close the subtitle picker" },
  { id: "fullscreen",       label: "Toggle Fullscreen",    description: "Maximize / restore the window" },
  { id: "toggle-panscan",   label: "Toggle Panscan (Fill Screen)", description: "Zoom-and-crop the video to fill the screen on its constrained axis — useful for 21:9 content on a 16:9 monitor (or vice-versa). Off = letterbox / pillarbox." },
  { id: "frame-step-back",    label: "Step One Frame Back",    description: "Nudge playback back by exactly one frame and pause. Useful for catching subtitle timing, screenshot precision, or anime sakuga inspection." },
  { id: "frame-step-forward", label: "Step One Frame Forward", description: "Advance playback by exactly one frame and pause. Pair with the back-step binding to scrub frame-by-frame." },
  { id: "anime4k-a",        label: "Anime4K · Mode A",     description: "High-quality restore + upscale" },
  { id: "anime4k-b",        label: "Anime4K · Mode B",     description: "Soft restore for noisy sources" },
  { id: "anime4k-c",        label: "Anime4K · Mode C",     description: "GAN-based restore — sharpest of the three" },
  { id: "anime4k-aa",       label: "Anime4K · Mode A+A",   description: "Double restore for very low-quality sources" },
  { id: "anime4k-bb",       label: "Anime4K · Mode B+B",   description: "Double soft-restore for heavy noise" },
  { id: "anime4k-cc",       label: "Anime4K · Mode C+C",   description: "Double GAN restore — heaviest GPU cost" },
  { id: "anime4k-none",     label: "Disable Upscaling",    description: "Clear shader chain — no upscaling" },
];
