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
