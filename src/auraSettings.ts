// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Aura UI settings (localStorage)
//
// Frontend-only preferences that don't need to round-trip through the backend
// (the backend `settings.json` covers system-level concerns: theme, RPC,
// language defaults, scrobble URL).
//
// Whenever the UI mutates settings via `saveAuraSettings`, an
// `aura:settings-changed` event is dispatched so other components in the same
// window can react without a manual prop chain.
// ---------------------------------------------------------------------------

import { safeSetItem } from "./storageQuota";
import type { AddonEntry } from "./types";

const SETTINGS_KEY = "aura:settings:v1";
const CHANGE_EVENT = "aura:settings-changed";
/** Persistent "this user last modified settings at" stamp.
 *
 *  Used as `updated_at` on the cloud-sync `settings` blob so the
 *  last-writer-wins merger has a real anchor point. Previously the
 *  blob was stamped to Date.now() inside readSettingsBlob, which
 *  meant local always won the merge — the cloud's settings were
 *  pulled successfully then silently discarded.
 *
 *  Bumped by `bumpSettingsUpdatedAt()` (called from saveAuraSettings
 *  and from a sync-side listener on backend changes); replaced
 *  verbatim by the cloud-pull path so future readLocal calls reflect
 *  the cloud's authoritative timestamp. */
const SETTINGS_UPDATED_AT_KEY = "aura:settings-updated-at";

export function getSettingsUpdatedAt(): number {
  try {
    const raw = localStorage.getItem(SETTINGS_UPDATED_AT_KEY);
    if (!raw) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function setSettingsUpdatedAt(unixSeconds: number): void {
  // Via safeSetItem so a full origin evicts a disposable cache and retries: a
  // dropped timestamp would let the cloud silently win the next settings merge.
  // Still non-fatal if it ultimately fails (merger degrades to "treat local 0").
  safeSetItem(SETTINGS_UPDATED_AT_KEY, String(Math.floor(unixSeconds)));
}

export function bumpSettingsUpdatedAt(): void {
  setSettingsUpdatedAt(Math.floor(Date.now() / 1000));
}

export interface AuraSettings {
  /** URL of the addon whose catalogs lead the Home view. */
  defaultHomeAddonUrl: string | null;
  /** Optional metadata-provider override used for detail/calendar fetches. */
  defaultMetadataAddonUrl: string | null;
  /** Extra addons whose catalogs render *alongside* the primary on Home. */
  additionalHomeAddonUrls: string[];
  /** Stream providers — URLs of addons queried by fetch_streams. `null` =
   *  default = every installed addon with the stream resource is queried.
   *  An explicit array overrides that and limits stream lookups to only
   *  the listed URLs (in array order). User-managed via the Stream
   *  Providers section in Settings. */
  streamAddonUrls: string[] | null;
  /** Search providers used for FULL searches (Enter / submit). `null` =
   *  default = every search-capable installed addon is queried. Array =
   *  only the listed URLs (in order). Separate from suggestions so the
   *  user can keep e.g. AI-search out of every keystroke but still hit
   *  it on a deliberate Enter-search. User-managed via the Search
   *  Providers section in Settings. */
  searchAddonUrls: string[] | null;
  /** Hide the cast-card hover overlay that surfaces episode counts +
   *  Main/Recurring/Guest tier. Some shows lean on regular vs. guest
   *  billing as a plot beat (deaths, returns, cameos), so the count
   *  alone can spoil. Default false (overlay visible). */
  hideCastSpoilers: boolean;
  /** Blur the per-episode thumbnail until that episode is marked
   *  watched (manually OR auto-derived from playback progress).
   *  Anti-spoiler aid for thrillers / mystery / anime where the
   *  thumbnail itself reveals plot beats. Default false. */
  blurUnwatchedThumbnails: boolean;
  /** Catalog source for the Home hero carousel. `null` = use the
   *  first browseable catalog row (the default since 0.6.x). When set,
   *  this catalog drives the hero rotation regardless of whether it's
   *  hidden from the home grid — letting the user surface a curated
   *  list (AIOMetadata's "AI Recommendations", a custom mdblist, etc.)
   *  in the hero band without cluttering the home grid below. */
  heroCatalog: { addonUrl: string; mediaType: string; catalogId: string } | null;
  /** When true, the Home hero carousel is hidden entirely — no banner, and
   *  none of its catalog / logo fetches run. Selected via the "Disable" item in
   *  the Hero Carousel Source picker. Default false (hero shown). */
  heroDisabled: boolean;
  /** Reduced-motion policy. `"auto"` (default) honours the OS-level
   *  `prefers-reduced-motion` media query — most users get exactly the
   *  experience they configured at the OS level. `"always"` forces
   *  decorative loops off regardless of OS pref (useful on platforms
   *  where the OS toggle is too coarse — Windows ties it to "Show
   *  animations in Windows" which also disables useful UI affordances
   *  the user might want to keep). `"never"` forces motion on even
   *  when the OS asked for reduce (useful for users who set OS reduce
   *  for a specific app but want Aura's atmosphere). */
  reduceMotion: "auto" | "always" | "never";
  /** When true, the Next-Up CTA auto-fires `playNext` after
   *  `autoAdvanceDelaySeconds` of inactivity once the card surfaces.
   *  Default false — auto-advance is opt-in to avoid the "I was
   *  reading the credits and it skipped" friction class. Mouse
   *  movement inside the player, the Escape key, or explicit dismiss
   *  cancels the countdown. */
  autoAdvanceNextEpisode: boolean;
  /** Countdown in seconds before silent auto-advance fires (when
   *  `autoAdvanceNextEpisode === true`). Clamped to [5, 30] on load
   *  to guarantee the user always has a window to cancel. */
  autoAdvanceDelaySeconds: number;
  /** How far one press of Seek Back / Seek Forward moves the playhead, in
   *  seconds. Drives BOTH the arrow keys (or whatever those actions are bound
   *  to) and the two skip buttons either side of Play, because they are the
   *  same action and two different step sizes for it would be incoherent. The
   *  buttons' labels and tooltips read the value, so they always name what
   *  they actually do.
   *
   *  Default 5, down from the flat 10 this replaced: 10 s overshoots a line of
   *  dialogue you missed, which is the thing people seek backwards for.
   *  Clamped to [1, 60] on load. */
  seekStepSeconds: number;
  /** "Still watching?" binge gate. After 2 CONSECUTIVE unattended auto-
   *  advances (i.e. once the 3rd episode in a row finishes via auto-advance),
   *  the next end-of-stream shows a confirm instead of auto-playing, and the
   *  chain stops until the user continues. Counter resets on any manual
   *  continue / exit. Default true (opt-out). Only meaningful when
   *  autoAdvanceNextEpisode is on. */
  stillWatchingGate: boolean;
  /** Automatic skip detection (Hybrid). When AniSkip + chapters miss the OP
   *  and/or ED for a series, run a bounded ffmpeg silencedetect fallback that
   *  infers ONLY the missing segment. ffmpeg is fetched on demand (a one-time
   *  ~97 MB download) the first time a series needs it. Default true; turn off
   *  to avoid that download / the background scan. (Per-kind auto vs prompt vs
   *  off is still governed by the Skip OP/ED/Recap mode settings.) */
  autoSkipDetect: boolean;
  /** Blur the selected episode's per-episode synopsis on the detail
   *  page until the user clicks to reveal. Spoiler protection for
   *  per-episode overview text. Watched episodes are NEVER blurred
   *  (the user has already seen the content — no spoiler risk by
   *  definition) regardless of this toggle. Default false so the
   *  synopsis shows by default on a fresh install; users who care
   *  about spoilers flip this on. Mirrors the opt-in shape of
   *  `blurUnwatchedThumbnails`. */
  blurEpisodeSynopsis: boolean;
  /** Blur the episode ranges in an anime's Songs tab until
   *  clicked. The song title and artist are never blurred: the name is not
   *  the spoiler, "this opening only runs to episode 14" is, because it
   *  gives away where a cour or arc boundary falls. Default false, matching
   *  the opt-in shape of the other blur toggles. */
  blurThemeEpisodeRanges: boolean;
  /** Blur character portraits and names in the anime Cast tab until clicked.
   *  Character art is a routine spoiler: it shows a later form, a redesign or
   *  a reveal, and a name can give away that someone exists at all. Default
   *  false, matching the other blur toggles. */
  blurCharacterArt: boolean;
  /** Use story-arc key art for Continue Watching tiles and the detail hero,
   *  matching the latest arc you have progress in.
   *
   *  NOTE the inverted polarity relative to its neighbours in the Spoilers
   *  section: the blur toggles ADD protection when on, this one ADDS
   *  exposure, because arc art can depict a character or event you have not
   *  reached. Default false, so it is opt-in like the rest.
   *
   *  Only engages when the arc has real Fandom key art (`image_source ===
   *  "fandom"`). Everything else in the arc-image chain is a TMDB episode
   *  still or an addon thumbnail, and swapping designed landscape art for a
   *  random frame is a downgrade. */
  arcAwareArt: boolean;
  /** Audio loudness normalization. When on, MPV's `af` property holds
   *  `@loudnorm:dynaudnorm=f=200:g=15` so streams from different sources
   *  level to a consistent perceived volume. (dynaudnorm, not EBU R128
   *  `loudnorm`: the latter resets its gating window on a seek and blasts
   *  a few seconds of unleveled audio after an OP/ED skip — dynaudnorm is
   *  frame-local and survives skips.) Auto-disabled (UI-side) when audio
   *  passthrough is active — bitstream output bypasses the audio filter
   *  graph. Default false (opt-in). Installed at engine init AND on toggle
   *  change; both the Settings panel and the in-player three-dots menu
   *  surface the same setting. */
  loudnessNormalization: boolean;
  /** Motion interpolation — mpv's built-in GPU frame interpolation
   *  (`video-sync=display-resample` + `interpolation` + `tscale`).
   *  GPU-cheap (Aura already uses `vo=gpu-next`), opt-in and anime-gated
   *  (it adds judder on live-action). Default TRUE: the off-focus frame drops
   *  once blamed on `display-resample` were root-caused to the NVIDIA
   *  "Background Application Max Frame Rate" driver setting capping aura.exe
   *  when unfocused (a per-machine config, fixed in the NVIDIA profile), NOT to
   *  the `--wid` embedding, so interpolation no longer drops off-focus and is on
   *  by default again. Still anime-gated at apply time. Re-applies on every
   *  stream load AND on toggle; surfaced in both Settings and the in-player
   *  three-dots menu. Optional in the type only so incremental edits type-check;
   *  defaults + parse always populate it. */
  motionInterpolation?: boolean;
  /** The `tscale` (temporal scaler) kernel mpv interpolation uses —
   *  THE quality dial. mpv lists kernels in increasing smoothness:
   *  `oversample` (sharpest — judder-fix only, synthesises NO
   *  intermediate motion) → `catmull_rom` → `mitchell` → `gaussian`
   *  → `bicubic` (softest). Default `mitchell` (a balanced blending kernel -
   *  visibly smoother motion without the heaviest softening); `oversample` is
   *  judder-fix-only and the softer kernels push the SVP-like look. Whitelisted
   *  Rust-side. Optional in the type only; defaults + parse always populate it. */
  interpolationTscale?: string;
  /** Next-Up CTA: skip filler / recap episodes when computing the
   *  next-up target. Source field: AIOMetadata's per-episode
   *  `episodeKind`. Default `"none"` so users on non-anime content
   *  (or who explicitly want every episode) get the unchanged
   *  behaviour. Modes:
   *    • `"none"`    — never skip (default).
   *    • `"filler"`  — skip filler, keep recap.
   *    • `"recap"`   — skip recap, keep filler.
   *    • `"both"`    — skip both kinds; resume on the next
   *                    canon/normal/mixed episode.
   *  Sits near the AniSkip OP/ED controls in the player section of
   *  Settings since it's a stylistic cousin of "skip the boring
   *  bits".
   *
   *  SCOPE: this decides WHICH BUTTON AN UNATTENDED COUNTDOWN PRESSES, and
   *  nothing else. It used to be fed to `resolveNextEpisode`, where it changed
   *  what "the next episode" was: the card said "Play next episode" and played
   *  a different one, the user could not see what was being jumped or opt out
   *  for a single episode, and because the walk happened inside the resolver
   *  nothing downstream knew a skip had occurred, so the run was never marked.
   *  The card now always shows the true next episode with both buttons on it.
   *
   *  Skipping marks every episode it jumped, logs them to History, and, when
   *  the user pressed Skip themselves and auto-scrobble is on, sends them to
   *  Trakt / AniList as watched. An unattended skip marks locally and sends
   *  nothing. See skipActions.ts for the rule set. */
  nextUpSkipFillerRecap: "none" | "filler" | "recap" | "both";
  /** Use Aura Cloud's shared release-search feed for library /
   *  calendar reconciliation instead of probing addons per-user.
   *  Phase 9 — cloud-side poller computes the signal once per imdb-id
   *  globally; clients fan in. Default `true` for signed-in users;
   *  ignored for guests (always fall back to addon probes). When
   *  false, the desktop uses only the per-user addon probe path —
   *  same code as pre-Phase 9. See docs/release-search-spec.md. */
  releaseSearchEnabled: boolean;
  /** How the mini-meta hover panel is triggered on a catalog card:
   *   - "hover"  — opens on mouse-over (hover-intent). Default.
   *   - "button" — hover never opens; the configured mouse button
   *                (`metaPanelBindButton`) opens / toggles it.
   *   - "hold"   — hover never opens; a press-and-hold (~0.4 s) on a card
   *                opens it (a quick click still selects). Trackpad-friendly.
   *  Migrated from the legacy boolean `metaPanelBindEnabled` (true → "button"). */
  metaPanelActivation: "hover" | "button" | "hold";
  /** Mouse button that opens the meta panel in "button" activation mode.
   *  DOM `MouseEvent.button`: 1 = middle (default), 3 = back, 4 =
   *  forward. 0 (left) and 2 (right) are intentionally not selectable —
   *  left is select/navigate, right is the card context menu. */
  metaPanelBindButton: 1 | 3 | 4;
  /** "Open in…" external-source links open in the user's default system
   *  browser instead of Aura's in-app popup webview. Default false =
   *  the in-app popup (unchanged behaviour). */
  openLinksExternally: boolean;
  /** Auto-remove a SERIES from the Queue once it goes in-progress (any
   *  episode played). Movies are ALWAYS removed from the Queue once
   *  watched (≥90%), regardless of this toggle — a movie is a single
   *  unit, so "watched" means done. For series it's preference: the
   *  Queue semantic is "haven't started yet", so default true graduates
   *  a show out the moment you begin it. Flip false to keep in-progress
   *  shows pinned in the Queue. Surfaced as a toggle in the Queue page. */
  queueRemoveSeriesInProgress: boolean;
  /** When true (default), Aura parses addon stream details into tidy chips —
   *  built for AIOStreams' "TamTaro" glyph format. When false, the stream list
   *  shows the addon's raw title/description text, like base Stremio. The
   *  escape hatch for addons that emit a format Aura can't parse cleanly; the
   *  stream panel auto-detects non-TamTaro output and offers to switch. */
  useAuraStreamFormatter: boolean;
  /** Auto-remove a MOVIE from the Library once it's watched (played to
   *  completion or manually marked watched). Off by default. Applies going
   *  forward only; enabling prompts once about clearing the existing watched
   *  backlog (declining keeps it). Surfaced as a toggle in the Library page's
   *  options popover. Exported / sync-shared via PORTABLE_AURA_FIELDS. */
  libraryAutoRemoveWatchedMovies: boolean;
  /** Auto-remove a SERIES from the Library once every AIRED episode is watched
   *  and nothing further is scheduled - the same gate that flips the
   *  series-root "watched" flag (advanceWatchedAfter). A show still airing new
   *  episodes is never removed. Off by default; enabling prompts once about
   *  clearing the existing fully-watched backlog. */
  libraryAutoRemoveWatchedSeries: boolean;
  /** Airing-page grouping + sort. Device-local view prefs — deliberately NOT in
   *  PORTABLE_AURA_FIELDS / cloud sync (each device keeps its own view state). */
  airingGroupBy: "type" | "airwindow" | "none";
  airingSort: "recent" | "soonest" | "behind" | "alpha";
  /** Airing-page tile size. Unlike the grouping/sort above this DOES cloud-sync
   *  + is portable (a display-scale preference the user wants to carry across
   *  devices). "small" is the compact scaling; "medium" (default) is 50% larger;
   *  "large" is 100% larger. */
  airingTileSize: "small" | "medium" | "large";
}

export const DEFAULT_AURA_SETTINGS: AuraSettings = {
  defaultHomeAddonUrl: null,
  defaultMetadataAddonUrl: null,
  additionalHomeAddonUrls: [],
  streamAddonUrls: null,
  searchAddonUrls: null,
  hideCastSpoilers: false,
  blurUnwatchedThumbnails: false,
  blurThemeEpisodeRanges: false,
  blurCharacterArt: false,
  arcAwareArt: false,
  heroCatalog: null,
  heroDisabled: false,
  reduceMotion: "auto",
  autoAdvanceNextEpisode: false,
  autoAdvanceDelaySeconds: 10,
  seekStepSeconds: 5,
  stillWatchingGate: true,
  autoSkipDetect: true,
  blurEpisodeSynopsis: false,
  loudnessNormalization: false,
  motionInterpolation: true,
  interpolationTscale: "mitchell",
  nextUpSkipFillerRecap: "none",
  releaseSearchEnabled: true,
  metaPanelActivation: "hover",
  metaPanelBindButton: 1,
  openLinksExternally: false,
  queueRemoveSeriesInProgress: true,
  useAuraStreamFormatter: true,
  libraryAutoRemoveWatchedMovies: false,
  libraryAutoRemoveWatchedSeries: false,
  airingGroupBy: "type",
  airingSort: "recent",
  airingTileSize: "medium",
};

// Module-level memoization snapshot. loadAuraSettings is called many
// times per render in DetailView (6+ reads) and HomeView (3-4 reads),
// each one synchronously hitting localStorage + JSON.parse + a
// defensive object copy. The cost is small (sub-ms each) but is paid
// on every component render, including the heavy DetailView.
//
// Cache invariants:
//   • `cached` is null on cold start; first read populates it.
//   • Any saveAuraSettings() call invalidates by setting cached=null
//     AND dispatches the CHANGE_EVENT so subscribers re-render.
//   • The `aura:settings-changed` listener is also armed at module
//     load so that programmatic settings changes from other modules
//     (which may write to localStorage directly during a Restore /
//     Backup operation) properly bust this cache too.
let cached: AuraSettings | null = null;

function readFromStorage(): AuraSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AURA_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AuraSettings>;
    return {
      ...DEFAULT_AURA_SETTINGS,
      ...parsed,
      // Defensive: ensure the array is always present and well-typed
      additionalHomeAddonUrls: Array.isArray(parsed.additionalHomeAddonUrls)
        ? parsed.additionalHomeAddonUrls.filter((u): u is string => typeof u === "string")
        : [],
      // streamAddonUrls: null means "no override, query all". Array means
      // "only these URLs". Anything else (missing field, wrong type) falls
      // back to null so behaviour is backward-compatible with existing
      // settings blobs.
      streamAddonUrls: Array.isArray(parsed.streamAddonUrls)
        ? parsed.streamAddonUrls.filter((u): u is string => typeof u === "string")
        : null,
      searchAddonUrls: Array.isArray(parsed.searchAddonUrls)
        ? parsed.searchAddonUrls.filter((u): u is string => typeof u === "string")
        : null,
      hideCastSpoilers: typeof parsed.hideCastSpoilers === "boolean"
        ? parsed.hideCastSpoilers
        : false,
      blurUnwatchedThumbnails: typeof parsed.blurUnwatchedThumbnails === "boolean"
        ? parsed.blurUnwatchedThumbnails
        : false,
      blurThemeEpisodeRanges: typeof parsed.blurThemeEpisodeRanges === "boolean"
        ? parsed.blurThemeEpisodeRanges
        : false,
      blurCharacterArt: typeof parsed.blurCharacterArt === "boolean"
        ? parsed.blurCharacterArt
        : false,
      arcAwareArt: typeof parsed.arcAwareArt === "boolean"
        ? parsed.arcAwareArt
        : false,
      reduceMotion:
        parsed.reduceMotion === "always" || parsed.reduceMotion === "never"
          ? parsed.reduceMotion
          : "auto",
      autoAdvanceNextEpisode: typeof parsed.autoAdvanceNextEpisode === "boolean"
        ? parsed.autoAdvanceNextEpisode
        : false,
      autoAdvanceDelaySeconds: typeof parsed.autoAdvanceDelaySeconds === "number"
        && Number.isFinite(parsed.autoAdvanceDelaySeconds)
        ? Math.max(5, Math.min(30, Math.round(parsed.autoAdvanceDelaySeconds)))
        : 10,
      seekStepSeconds: typeof parsed.seekStepSeconds === "number"
        && Number.isFinite(parsed.seekStepSeconds)
        ? Math.max(1, Math.min(60, Math.round(parsed.seekStepSeconds)))
        : 5,
      stillWatchingGate: typeof parsed.stillWatchingGate === "boolean"
        ? parsed.stillWatchingGate
        : true,
      autoSkipDetect: typeof parsed.autoSkipDetect === "boolean"
        ? parsed.autoSkipDetect
        : true,
      blurEpisodeSynopsis: typeof parsed.blurEpisodeSynopsis === "boolean"
        ? parsed.blurEpisodeSynopsis
        : false,
      loudnessNormalization: typeof parsed.loudnessNormalization === "boolean"
        ? parsed.loudnessNormalization
        : false,
      // Default OFF until the deferred mpv_render_context rewrite is
      // sorted — under the current --wid child-HWND embedding,
      // display-resample makes off-focus frame drops catastrophic.
      // An explicitly-stored value (either way) is respected; absent falls back
      // to the default-on value, so users who never touched it get it enabled.
      motionInterpolation: typeof parsed.motionInterpolation === "boolean"
        ? parsed.motionInterpolation
        : true,
      interpolationTscale: typeof parsed.interpolationTscale === "string"
        ? parsed.interpolationTscale
        : "mitchell",
      nextUpSkipFillerRecap:
        parsed.nextUpSkipFillerRecap === "filler"
          || parsed.nextUpSkipFillerRecap === "recap"
          || parsed.nextUpSkipFillerRecap === "both"
          ? parsed.nextUpSkipFillerRecap
          : "none",
      releaseSearchEnabled: typeof parsed.releaseSearchEnabled === "boolean"
        ? parsed.releaseSearchEnabled
        : true,
      metaPanelActivation:
        parsed.metaPanelActivation === "button" || parsed.metaPanelActivation === "hold" || parsed.metaPanelActivation === "hover"
          ? parsed.metaPanelActivation
          // Migrate the legacy boolean: bind-enabled → "button", else "hover".
          : ((parsed as Record<string, unknown>).metaPanelBindEnabled === true ? "button" : "hover"),
      // Only the three non-conflicting buttons are valid; anything else
      // (legacy / garbage / left / right) falls back to middle.
      metaPanelBindButton:
        parsed.metaPanelBindButton === 3 || parsed.metaPanelBindButton === 4
          ? parsed.metaPanelBindButton
          : 1,
      openLinksExternally: typeof parsed.openLinksExternally === "boolean"
        ? parsed.openLinksExternally
        : false,
      queueRemoveSeriesInProgress: typeof parsed.queueRemoveSeriesInProgress === "boolean"
        ? parsed.queueRemoveSeriesInProgress
        : true,
      useAuraStreamFormatter: typeof parsed.useAuraStreamFormatter === "boolean"
        ? parsed.useAuraStreamFormatter
        : true,
      libraryAutoRemoveWatchedMovies: typeof parsed.libraryAutoRemoveWatchedMovies === "boolean"
        ? parsed.libraryAutoRemoveWatchedMovies
        : false,
      libraryAutoRemoveWatchedSeries: typeof parsed.libraryAutoRemoveWatchedSeries === "boolean"
        ? parsed.libraryAutoRemoveWatchedSeries
        : false,
      heroCatalog: parsed.heroCatalog
        && typeof parsed.heroCatalog === "object"
        && typeof (parsed.heroCatalog as Record<string, unknown>).addonUrl === "string"
        && typeof (parsed.heroCatalog as Record<string, unknown>).mediaType === "string"
        && typeof (parsed.heroCatalog as Record<string, unknown>).catalogId === "string"
        ? (parsed.heroCatalog as AuraSettings["heroCatalog"])
        : null,
      heroDisabled: typeof parsed.heroDisabled === "boolean" ? parsed.heroDisabled : false,
    };
  } catch {
    return { ...DEFAULT_AURA_SETTINGS };
  }
}

export function loadAuraSettings(): AuraSettings {
  if (cached !== null) return cached;
  cached = readFromStorage();
  return cached;
}

if (typeof window !== "undefined") {
  // Bust the cache on:
  //   • Same-window saves (saveAuraSettings dispatches CHANGE_EVENT).
  //   • Cross-tab `storage` events when another tab writes to the
  //     same key (rare for Aura — single-window app — but cheap to
  //     handle, and a future profile / multi-window flow would rely
  //     on it.
  const invalidate = () => { cached = null; };
  window.addEventListener(CHANGE_EVENT, invalidate);
  window.addEventListener("storage", (e) => {
    if (e.key === SETTINGS_KEY) invalidate();
  });
}

/** Diff two AuraSettings shallowly. Used by saveAuraSettings to emit a
 *  keyed change event so listeners can ignore irrelevant flips —
 *  e.g. HomeView shouldn't re-fetch all home catalogs when the user
 *  toggles subtitle styling or loudness normalization. Returns the
 *  list of top-level keys whose values differ. Deep objects (like
 *  `heroCatalog`) are compared via JSON serialization since shallow
 *  reference inequality after a save is the common case. */
function diffSettings(prev: AuraSettings | null, next: AuraSettings): string[] {
  if (!prev) return Object.keys(next);
  const changed: string[] = [];
  for (const key of Object.keys(next) as (keyof AuraSettings)[]) {
    const a = prev[key];
    const b = next[key];
    if (a === b) continue;
    // Arrays + objects → JSON compare (cheap for the small shapes
    // Aura's settings carry). Doesn't handle Date / Map / Set, but
    // none of AuraSettings's fields use those.
    if (typeof a === "object" || typeof b === "object") {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    }
    changed.push(key);
  }
  return changed;
}

export function saveAuraSettings(s: AuraSettings, opts?: { fromCloud?: boolean }) {
  // Snapshot prior state BEFORE the write so we can compute a
  // meaningful diff for the CHANGE_EVENT. Without this, the event
  // would always fire with the "everything maybe changed" semantic
  // and every HomeView mount would re-fetch the entire grid on every
  // unrelated setting flip (subtitle styling, loudness, motion, etc.).
  const prior = cached ?? readFromStorage();
  // Via safeSetItem: on a full origin, evict a disposable cache and retry so a
  // user settings change is not silently dropped (and the bare setItem here used
  // to THROW on quota, propagating up through every save call site).
  safeSetItem(SETTINGS_KEY, JSON.stringify(s));
  cached = null; // bust cache before listeners run so they read fresh values
  const changed = diffSettings(prior, s);
  // Stamp the user-modified timestamp for cloud-sync last-writer-wins.
  // Skip when the write originates from a cloud pull — those carry the
  // server's authoritative updated_at, applied separately by sync.ts.
  // Without the skip, every pull-and-save would re-stamp the local
  // blob with Date.now() and the merger would always pick local on the
  // very next pull (the original "settings never sync" symptom).
  if (!opts?.fromCloud && changed.length > 0) {
    bumpSettingsUpdatedAt();
  }
  // Same-window components don't see `storage` events; emit a custom one.
  // `detail.keys` is an array of top-level field names that actually
  // changed. Listeners can early-return when no field they care about
  // is in the array; absence of `detail` falls back to the legacy
  // "everything changed" semantic so older listeners keep working.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { keys: changed, fromCloud: opts?.fromCloud ?? false } }));
}

/** Home-relevant AuraSettings keys. Listeners that drive expensive
 *  fetches (catalog grid, hero override) early-return when the
 *  CHANGE_EVENT's `detail.keys` doesn't include any of these. */
export const HOME_RELEVANT_SETTING_KEYS = new Set<keyof AuraSettings>([
  "defaultHomeAddonUrl",
  "defaultMetadataAddonUrl",
  "additionalHomeAddonUrls",
  "streamAddonUrls",
  "heroCatalog",
  "heroDisabled",
]);

/** Helper: does a CHANGE_EVENT carry at least one key from the supplied
 *  whitelist? When `detail.keys` is missing (legacy emitters), defaults
 *  to true so we don't silently break unrelated paths. */
export function settingsChangeIncludes(
  event: Event,
  whitelist: Set<keyof AuraSettings>,
): boolean {
  const detail = (event as CustomEvent<{ keys?: string[] }>).detail;
  if (!detail || !Array.isArray(detail.keys)) return true;
  return detail.keys.some((k) => whitelist.has(k as keyof AuraSettings));
}

// ---------------------------------------------------------------------------
// Reduced-motion runtime gate
//
// Centralises the policy that translates `auraSettings.reduceMotion` +
// the OS `prefers-reduced-motion` media query into a boolean the CSS
// can act on. `applyReducedMotionAttribute()` writes `<html
// data-reduced-motion="true|false">` so the CSS selectors in App.css
// only need to look at one source of truth. Mounted from main.tsx
// (synchronous, before React paints — eliminates the BootSplash flash
// for OS-pref users) AND re-fired by App.tsx on `aura:settings-changed`
// + `matchMedia` change events so live toggles take effect immediately.
// ---------------------------------------------------------------------------

export function effectiveReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  const pref = loadAuraSettings().reduceMotion;
  if (pref === "always") return true;
  if (pref === "never")  return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function applyReducedMotionAttribute(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute(
    "data-reduced-motion",
    effectiveReducedMotion() ? "true" : "false",
  );
}

/**
 * The addons a stream query should actually be sent to, honouring the user's
 * `streamAddonUrls` choice in Settings. `null` (the default) means "all of
 * them"; a list means "only these, in the order they were installed".
 *
 * Exists because this scoping was open-coded at each fetch site and the
 * Next-Up pre-resolve was missing it, so auto-advance queried addons the user
 * had explicitly excluded from stream lookups and could advance into a source
 * that would never appear in the switcher. One helper, one behaviour.
 */
export function streamQueryAddons(addons: AddonEntry[]): AddonEntry[] {
  const { streamAddonUrls } = loadAuraSettings();
  if (streamAddonUrls === null) return addons;
  return streamAddonUrls
    .map((url) => addons.find((a) => a.url === url))
    .filter((a): a is AddonEntry => !!a);
}
