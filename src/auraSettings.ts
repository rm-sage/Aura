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

const SETTINGS_KEY = "aura:settings:v1";
const CHANGE_EVENT = "aura:settings-changed";

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
  /** Search providers used for LIVE SUGGESTIONS while typing. Same
   *  shape + semantics as `searchAddonUrls` but queried on the
   *  debounced suggestion path instead of submit. Common pattern:
   *  exclude expensive/AI addons here while keeping them in
   *  searchAddonUrls. `null` = query all search-capable addons. */
  searchSuggestionAddonUrls: string[] | null;
  /** Hide the cast-card hover overlay that surfaces episode counts +
   *  Main/Recurring/Guest tier. Some shows lean on regular vs. guest
   *  billing as a plot beat (deaths, returns, cameos), so the count
   *  alone can spoil. Default false (overlay visible). */
  hideCastSpoilers: boolean;
  /** Show AIOStreams notices (filter / timing / scrape-summary stats
   *  + addon errors) as badges over the streams panel. When off, only
   *  notices flagged `forced=true` by the addon (Digital Release
   *  Filter, disabled-stream-types removal reasons) still surface —
   *  user toggles never silently swallow those. Default true. */
  showAioStreamsNotices: boolean;
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
  /** Episode-notification gate: when true, the bell only fires for a
   *  new episode if NotificationsScanner can confirm at least one
   *  stream exists for it (via fetch_streams against the user's
   *  installed addons). Off by default because it adds a per-episode
   *  HTTP fanout to every scan; on for users whose addon mix
   *  occasionally publishes "released" episodes that have no
   *  scrapable source for hours/days, who'd rather hear about it
   *  later than have the bell light up with a dead-end notification.
   *  Result of the stream check is cached locally (12h TTL) so a
   *  re-scan over the same episode doesn't refire the network call. */
  notifyOnlyWithStreams: boolean;
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
  /** Blur the selected episode's per-episode synopsis on the detail
   *  page until the user clicks to reveal. Spoiler protection for
   *  per-episode overview text. Watched episodes are NEVER blurred
   *  (the user has already seen the content — no spoiler risk by
   *  definition) regardless of this toggle. Default false so the
   *  synopsis shows by default on a fresh install; users who care
   *  about spoilers flip this on. Mirrors the opt-in shape of
   *  `blurUnwatchedThumbnails`. */
  blurEpisodeSynopsis: boolean;
  /** EBU R128 audio loudness normalization. When on, MPV's `af`
   *  property holds `@loudnorm:loudnorm=I=-23:LRA=7:TP=-2:dynamic=true`
   *  so streams from different sources level to a consistent
   *  perceived volume. Auto-disabled (UI-side) when audio passthrough
   *  is active — bitstream output bypasses the audio filter graph.
   *  Default false (opt-in). Re-applies on every stream load AND on
   *  toggle change; both the Settings panel and the in-player
   *  three-dots menu surface the same setting. */
  loudnessNormalization: boolean;
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
   *  bits". */
  nextUpSkipFillerRecap: "none" | "filler" | "recap" | "both";
}

export const DEFAULT_AURA_SETTINGS: AuraSettings = {
  defaultHomeAddonUrl: null,
  defaultMetadataAddonUrl: null,
  additionalHomeAddonUrls: [],
  streamAddonUrls: null,
  searchAddonUrls: null,
  searchSuggestionAddonUrls: null,
  hideCastSpoilers: false,
  showAioStreamsNotices: true,
  blurUnwatchedThumbnails: false,
  heroCatalog: null,
  notifyOnlyWithStreams: false,
  reduceMotion: "auto",
  autoAdvanceNextEpisode: false,
  autoAdvanceDelaySeconds: 10,
  blurEpisodeSynopsis: false,
  loudnessNormalization: false,
  nextUpSkipFillerRecap: "none",
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
      searchSuggestionAddonUrls: Array.isArray(parsed.searchSuggestionAddonUrls)
        ? parsed.searchSuggestionAddonUrls.filter((u): u is string => typeof u === "string")
        : null,
      hideCastSpoilers: typeof parsed.hideCastSpoilers === "boolean"
        ? parsed.hideCastSpoilers
        : false,
      showAioStreamsNotices: typeof parsed.showAioStreamsNotices === "boolean"
        ? parsed.showAioStreamsNotices
        : true,
      blurUnwatchedThumbnails: typeof parsed.blurUnwatchedThumbnails === "boolean"
        ? parsed.blurUnwatchedThumbnails
        : false,
      notifyOnlyWithStreams: typeof parsed.notifyOnlyWithStreams === "boolean"
        ? parsed.notifyOnlyWithStreams
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
      blurEpisodeSynopsis: typeof parsed.blurEpisodeSynopsis === "boolean"
        ? parsed.blurEpisodeSynopsis
        : false,
      loudnessNormalization: typeof parsed.loudnessNormalization === "boolean"
        ? parsed.loudnessNormalization
        : false,
      nextUpSkipFillerRecap:
        parsed.nextUpSkipFillerRecap === "filler"
          || parsed.nextUpSkipFillerRecap === "recap"
          || parsed.nextUpSkipFillerRecap === "both"
          ? parsed.nextUpSkipFillerRecap
          : "none",
      heroCatalog: parsed.heroCatalog
        && typeof parsed.heroCatalog === "object"
        && typeof (parsed.heroCatalog as Record<string, unknown>).addonUrl === "string"
        && typeof (parsed.heroCatalog as Record<string, unknown>).mediaType === "string"
        && typeof (parsed.heroCatalog as Record<string, unknown>).catalogId === "string"
        ? (parsed.heroCatalog as AuraSettings["heroCatalog"])
        : null,
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

export function saveAuraSettings(s: AuraSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  cached = null; // bust cache before listeners run so they read fresh values
  // Same-window components don't see `storage` events; emit a custom one.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
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
