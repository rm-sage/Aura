// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AddonEntry,
  MetaPreview,
  MetaDetail,
  StreamEntry,
  StreamFetchResult,
  StreamMessage,
  StreamMetadata,
  VideoEntry,
} from "../types";
import { isVideoAired } from "../types";
import { loadAuraSettings } from "../auraSettings";
import { useReleaseSignal } from "../releaseSignalStore";
import { fetchReleaseSignal } from "../releaseSearch";
import { resolveDefaultMetaUrl } from "../addonDefaults";
import { findAIOMetadataAddon, isAnimeMeta, markAnimeId, typeLabel } from "../aiometadata";
import { dedupedInvoke } from "../invokeDedupe";
import { PersistentCache } from "../persistentCache";

// 7-day cache for the aggregate ratings. RT/Metacritic values shift on
// the order of weeks for theatrical releases and never for older
// titles, so a week between refreshes is safe and saves ~1 invoke per
// detail open across re-uses of the same library.
const ratingsCache = new PersistentCache<{ source: string; value: string }[]>({
  storageKey: "aura:ratings-cache:v1",
  ttlMs:      7 * 24 * 60 * 60 * 1000,
  maxEntries: 800,
});

// Short-lived in-memory cache for fetch_streams results, keyed by the
// same composite that drives the dedupedInvoke key (addon URL set +
// media_type + targetId). Survives DetailView remounts so the user
// closing and reopening the same episode within a couple of minutes
// doesn't pay another 5-30s multi-addon stream fan-out — that's the
// #1 perceived-latency hit on the Detail flow per the audit.
//
// In-memory only (no localStorage persistence): debrid CDN URLs
// expire on the order of hours/days, so a session restart should
// re-validate. 3 minutes is short enough that the link the user
// clicks on the second open is still valid; long enough to cover
// natural navigate-back behavior.
interface CachedStreams {
  result: StreamFetchResult;
  ts: number;
}
const STREAM_CACHE_TTL_MS = 3 * 60 * 1000;
const STREAM_CACHE_MAX = 32;
const streamCache = new Map<string, CachedStreams>();
function streamCachePut(key: string, result: StreamFetchResult): void {
  // Soft cap: drop the oldest entry when full so we don't grow
  // unboundedly across a long session of clicking around.
  if (streamCache.size >= STREAM_CACHE_MAX) {
    const oldestKey = streamCache.keys().next().value;
    if (oldestKey != null) streamCache.delete(oldestKey);
  }
  streamCache.set(key, { result, ts: Date.now() });
}
function streamCacheGet(key: string): StreamFetchResult | null {
  const hit = streamCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > STREAM_CACHE_TTL_MS) {
    streamCache.delete(key);
    return null;
  }
  return hit.result;
}
// Drop a single entry — the "Refresh streams" button forces this for
// the active query so the next read misses the cache and pays a fresh
// multi-addon fan-out instead of replaying the stale snapshot.
function streamCacheDelete(key: string): void {
  streamCache.delete(key);
}
import { useEpisodeProgress, useResumeVideoId } from "../LibraryContext";
import SpectralPulse from "../SpectralPulse";
import WatchedBadge, { useWatchedVariant } from "../WatchedBadge";
import { openContextMenu } from "../ContextMenu";
import {
  getManualWatchedState,
  setManualWatchedState,
  setManualWatchedMany,
} from "../manualWatched";
import { recheckSeriesWatchedFlag } from "../autoAdvance";
import { getSortedEpisodes } from "../episodeSort";
import { showFlyUpToast } from "../FlyUpToast";
import ImageLoader from "../ImageLoader";
import ErrorBoundary from "../ErrorBoundary";
import { parseStream, chipStyleFor, type ChipKind } from "../streamMeta";
import Tooltip from "../Tooltip";
import { BrandLogo, ratingDomain } from "../logodev";

// ---------------------------------------------------------------------------
// DetailView — full-bleed cinematic detail page with a "Command Center" feel.
//
// Layout:
//   • Background  — backdrop image at `absolute inset-0` (object-cover,
//                   center-top). No scaling. Heavy gradient overlays carry
//                   the legibility weight.
//   • LEFT (flex-1)  — ALL metadata: logo, dense meta strip, ratings, cast,
//                       crew, country, genre chips, synopsis. Typography
//                       ~30% larger than 5.6 for "Command Center" presence.
//   • RIGHT (max-w-md compact column) — single Unified Panel that swaps
//                       between Episodes and Streams modes.
//                         Movies: starts in Streams mode.
//                         Series/Anime: starts in Episodes; clicking an episode
//                         transitions to Streams (with Back button).
// ---------------------------------------------------------------------------

interface Props {
  meta: MetaPreview;
  addons: AddonEntry[];
  fromRect?: DOMRect | null;
  onClose: () => void;
  onPlayStream: (
    stream: StreamEntry,
    target: {
      id: string;
      media_type: string;
      name: string;
      episode?: string;
      episode_title?: string;
      /** AIOMetadata-sourced inputs for the audio scoring algorithm.
       *  All four fields are optional — the resolver in audioScoring
       *  falls through them in priority order. */
      scoring?: {
        original_language: string | null;
        production_countries: string[];
        genres?: string[];
        country?: string | null;
      };
    },
  ) => void;
  /** Cast / crew name click handler. Wired by App to flip to Home + queue
   *  the name as the search query. DetailView calls this BEFORE onClose so
   *  the deep-link state is set before the unmount runs. */
  onSearchByName?: (name: string) => void;
  /** True if the user already has this title in their Stremio library. Drives
   *  the Add/Remove button label + tone. */
  inLibrary?: boolean;
  /** Toggle library membership. App.tsx wires this through libraryToggle /
   *  libraryRemoveAll, syncs the change to Stremio cloud, fires a fly-up
   *  toast originating at `originPoint`, and re-fetches the library so
   *  this view's `inLibrary` flips. */
  onLibraryToggle?: (originPoint?: { x: number; y: number }) => void;
  /** When set, DetailView opens in episodes mode (instead of streams),
   *  selects the season containing this episode id, and scrolls the
   *  matching row to the top of the list. Used after exiting playback
   *  for series/anime so the user lands back on the next-episode row. */
  openOnEpisodeId?: string | null;
  /** Called once after `openOnEpisodeId` has been consumed (after the
   *  initial mount effect runs). Lets the parent clear the hint so a
   *  later open from an unrelated card doesn't inherit it. */
  onConsumeOpenHint?: () => void;
  /** When true, suppress the "resume from CW" auto-route to streams
   *  mode. Used by the Library tab's series-click path: clicking a
   *  series in the Library should drop the user on the episode list
   *  starting at the first episode regardless of any state.video_id
   *  resume hint stamped from previous CW interactions. */
  ignoreResumeHint?: boolean;
}

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);
const ArrowBackIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
  </svg>
);
const ArrowBackSm = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
  </svg>
);
const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" />
  </svg>
);

type PanelMode = "episodes" | "streams";

/** Resolve a (possibly stale-shape) episode id to the matching VideoEntry
 *  in the current `videos` array. Three layers of matching cover the
 *  shapes Aura library state may carry after addon migrations:
 *
 *    1. Direct id equality — the current path.
 *    2. (season, episode) tuple match for tt-prefixed ids whose shape
 *       still matches AIOMetadata's emitted ids (`tt…:S:E`) but whose
 *       VALUES no longer match because cour-aggregation changed the
 *       canonical id. Example: pre-cour-split `tt…:2:6` against a new
 *       `kitsu:49240:6` with `v.season=2`, `v.episode=6` — direct
 *       match fails, tuple match succeeds.
 *    3. Absolute-episode fallback for pre-cour-split merged ids
 *       (`tt…:1:34` where 34 is the absolute episode count, not
 *       cour-relative). Walks the main-run videos in `(season,
 *       episode)` order and returns the Nth entry. Imperfect — for
 *       users with shape-2 state-ids whose tuple match fails, this
 *       returns a different episode — but the next playback writes
 *       a current-shape id so the heuristic only matters during the
 *       single migration window per library entry.
 *
 *  Returns null when nothing plausible matches. Callers should treat
 *  that as "no resume hint" and fall through to the first-episode
 *  default. */
function resolveResumeEpisode(
  targetId: string | null | undefined,
  videos: VideoEntry[] | null | undefined,
): VideoEntry | null {
  if (!targetId || !videos || videos.length === 0) return null;
  // Direct.
  const direct = videos.find((v) => v.id === targetId);
  if (direct) return direct;
  // Tuple — tt-prefixed only since anime-prefix ids have a provider
  // show id in their middle slot, not a season number.
  const parts = targetId.split(":");
  if (parts.length >= 3 && targetId.startsWith("tt")) {
    const season = Number(parts[parts.length - 2]);
    const episode = Number(parts[parts.length - 1]);
    if (Number.isFinite(season) && Number.isFinite(episode)) {
      const tuple = videos.find(
        (v) => (v.season ?? 0) === season && (v.episode ?? 0) === episode,
      );
      if (tuple) return tuple;
      // Absolute fallback — pre-cour-split shape where season is the
      // collapsed "1" and episode is the absolute count. Walk the
      // main-run list in canonical (season, episode) order and pick
      // the Nth entry (1-indexed).
      const mainRun = videos
        .filter((v) => (v.season ?? 0) > 0)
        .slice()
        .sort((a, b) => {
          const sa = a.season ?? 0;
          const sb = b.season ?? 0;
          if (sa !== sb) return sa - sb;
          return (a.episode ?? 0) - (b.episode ?? 0);
        });
      const absolute = mainRun[episode - 1];
      if (absolute) return absolute;
    }
  }
  return null;
}

export default function DetailView(props: Props) {
  return (
    <ErrorBoundary scope="DetailView">
      <DetailViewBody {...props} />
    </ErrorBoundary>
  );
}

function DetailViewBody({ meta, addons, fromRect, onClose, onPlayStream, onSearchByName, inLibrary, onLibraryToggle, openOnEpisodeId, onConsumeOpenHint, ignoreResumeHint }: Props) {
  const [detail, setDetail]                 = useState<MetaDetail | null>(null);
  const [streams, setStreams]               = useState<StreamEntry[]>([]);
  const [streamMeta, setStreamMeta]         = useState<StreamMetadata>({
    errors: [], warnings: [], info: [], stats: [],
  });
  const [streamsLoading, setStreamsLoading] = useState(false);
  const [opening, setOpening]               = useState(true);
  // Flips true once the entrance transform has finished settling.
  // StreamMetaBadges must NOT measure its anchor while the root is
  // still mid-transform — getBoundingClientRect() returns the animating
  // (scaled-toward-center) rect. On a cached re-entry the streams render
  // synchronously, so the badges mount DURING the 380 ms open
  // transition; without this gate the cluster froze near screen centre
  // because no resize/scroll/ResizeObserver event re-fires once the
  // transform lands (an ancestor transform doesn't resize the aside).
  // The root's onTransitionEnd flips this the instant the transform
  // settles; this timeout is the belt-and-braces fallback for the
  // cases where that event never fires — prefers-reduced-motion
  // stripping the transition, or openTransform equalling the resting
  // transform so no transition runs at all.
  const [entered, setEntered]               = useState(false);
  useEffect(() => {
    if (entered) return;
    const t = setTimeout(() => setEntered(true), 480);
    return () => clearTimeout(t);
  }, [entered]);
  const [activeVideo, setActiveVideo]       = useState<VideoEntry | null>(null);
  // Per-episode "user has clicked through the spoiler blur" set. Keyed
  // by VideoEntry.id; non-persisted (resets when DetailView unmounts).
  // Cleared when activeVideo changes so each newly-selected episode
  // starts blurred again on a fresh selection — matches the user's
  // minimum-friction spoiler contract (protect by default, easy to
  // bypass per-episode for the current session).
  const [revealedSynopses, setRevealedSynopses] = useState<Set<string>>(new Set());
  useEffect(() => {
    setRevealedSynopses(new Set());
  }, [activeVideo?.id]);
  // Ref to the streams-panel aside — used by StreamMetaBadges to anchor
  // its portal-rendered badge cluster in the gutter outside the panel.
  const asideRef = useRef<HTMLElement>(null);

  // Re-evaluate the series-level "watched" flag whenever a fresh meta
  // detail lands. Addons can add new aired episodes to the videos
  // array between visits — if the series was previously fully watched
  // and a new episode has now aired, recheckSeriesWatchedFlag flips
  // the series back to in-progress and bumps the new ep into CW.
  // Cheap (synchronous, idempotent on subsequent renders).
  useEffect(() => {
    if (!detail) return;
    recheckSeriesWatchedFlag(meta.id, detail);
  }, [detail, meta.id]);

  // Currently-selected season — synchronized from EpisodesPanel via a
  // custom event so the cast block can swap to the season-specific
  // roster without prop-drilling through UnifiedPanel. Seeded null
  // until EpisodesPanel mounts and emits its initial pick.
  const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<{ season: number }>).detail;
      if (typeof detail?.season === "number") setSelectedSeason(detail.season);
    };
    window.addEventListener("aura:detail-season-changed", onChange);
    return () => window.removeEventListener("aura:detail-season-changed", onChange);
  }, []);

  const isEpisodic = useMemo(
    () => ["series", "anime"].includes((meta.media_type ?? "").toLowerCase()),
    [meta.media_type],
  );

  // Auto-resume: if the user has watched an episode of this series before,
  // Stremio stamps the LibraryItem's state.video_id with the last episode
  // they touched. We surface that here so we can:
  //   1. Pre-select activeVideo (no manual episode pick required)
  //   2. Open straight to the streams panel
  //   3. Use it as the stream-fetch target even if the metadata addon
  //      doesn't ship a videos array — that's what was causing the
  //      "Continue Watching opens a blank page" complaint.
  const rawResumeVideoId = useResumeVideoId(meta.id);
  // Library-tab clicks pass `ignoreResumeHint`, which suppresses the
  // CW resume behaviour: from Library, opening a series should drop
  // the user on the episode list at S01E01 regardless of where they
  // last paused. CW tile clicks (and other surfaces) still get the
  // resume jump.
  //
  // Effective walk: if state.video_id points at an episode the user
  // has manually marked watched (or that auto-advance just marked
  // watched on 90 % completion), skip forward through the sorted
  // videos list to the first non-watched aired episode. The CW card
  // badge already does this via CinemaRows.useEffectiveResumeVideoId;
  // without the matching walk here, the CW tile said "S01E13" but
  // clicking the same tile opened E12 because the cloud library's
  // state.video_id hadn't moved yet.
  const effectiveResumeVideoId = useMemo(() => {
    if (!rawResumeVideoId) return null;
    if (!isEpisodic) return rawResumeVideoId;
    if (!detail || !detail.videos || detail.videos.length === 0) return rawResumeVideoId;
    if (getManualWatchedState(rawResumeVideoId) !== "watched") return rawResumeVideoId;
    const sorted = getSortedEpisodes(detail);
    const idx = sorted.findIndex((v) => v.id === rawResumeVideoId);
    if (idx < 0) return rawResumeVideoId;
    for (let i = idx + 1; i < sorted.length; i += 1) {
      if (getManualWatchedState(sorted[i].id) === "watched") continue;
      return sorted[i].id;
    }
    return rawResumeVideoId;
  }, [rawResumeVideoId, isEpisodic, detail]);
  const resumeVideoId = ignoreResumeHint ? null : effectiveResumeVideoId;

  // For movies, the unified panel starts in "streams" mode (no episode picker).
  // For series/anime, "episodes" first; activating one flips to "streams".
  // For a CW resume, jump straight to streams even on series.
  // EXCEPTION: when `openOnEpisodeId` is set (i.e. we're remounting right
  // after the user exited playback), force episodes mode so they land on
  // the list with the just-played episode anchored at the top.
  const [panelMode, setPanelMode] = useState<PanelMode>(
    isEpisodic && (openOnEpisodeId || !resumeVideoId) ? "episodes" : "streams"
  );

  // Snapshot the open hint into a local state at mount so we can clear
  // the parent's prop immediately (next renders pass null) without
  // losing track of WHICH episode to scroll to. Earlier code consumed
  // the prop on mount and then used the now-null prop for scrolling —
  // by the time the addon's videos array resolved, scrollToVideoId was
  // null and the EpisodesPanel landed on the top of the list instead
  // of the just-played episode.
  const [scrollOnceTo, setScrollOnceTo] = useState<string | null>(openOnEpisodeId ?? null);
  useEffect(() => {
    if (openOnEpisodeId) onConsumeOpenHint?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Clear the local hint AFTER the EpisodesPanel has had a chance to
  // honour it — the panel calls back via onScrollHandled when its
  // scroll routine finds the row and scrolls to it. Until then,
  // changing seasons or videos arriving doesn't lose the target.
  const handleScrollHandled = useCallback(() => setScrollOnceTo(null), []);

  // Open animation
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setOpening(false)),
    );
    return () => cancelAnimationFrame(id);
  }, []);

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Release-search single-fetch on detail open — pulls the cloud
  // signal for this series so EpisodeRow's filler/recap banner
  // render (consumed via useReleaseSignal) gets the freshest data
  // even if the library-level batch reconciler hasn't run for this
  // session yet. Fire-and-forget; releaseSearch.ts handles the cache
  // + If-None-Match revalidation internally. Errors are logged in
  // the module, not surfaced here — the existing per-episode
  // VideoEntry flags from extract_videos remain the fallback. See
  // docs/release-search-spec.md §6.2 path 2.
  useEffect(() => {
    if (!meta.id) return;
    if (!meta.id.startsWith("tt")) return;
    if (!loadAuraSettings().releaseSearchEnabled) return;
    fetchReleaseSignal(meta.id).catch(() => {
      // Already logged inside releaseSearch.ts; swallow here so the
      // detail page doesn't spawn an error toast for a soft-fail
      // enrichment path.
    });
  }, [meta.id]);

  // ── Metadata addon resolution ─────────────────────────────────────
  // Pick order:
  //   1. AIOMetadata if installed — richest data (originalLanguage,
  //      productionCountries, anime IDs). This was previously gated on
  //      anime-prefixed IDs, but Continue Watching items often arrive
  //      with `tt`-prefixed series IDs that AIOMetadata still resolves
  //      better than Cinemeta. Defaulting to AIOMetadata first
  //      eliminates the "CW opens an empty page" symptom.
  //   2. The user-pinned default metadata addon.
  //   3. The first addon that advertises the "meta" resource.
  //   4. Plain addons[0] as last-ditch fallback.
  const metaAddon = useMemo(() => {
    const { defaultMetadataAddonUrl } = loadAuraSettings();
    const aio = findAIOMetadataAddon(addons);
    if (aio) return aio;
    if (defaultMetadataAddonUrl) {
      const pinned = addons.find((a) => a.url === defaultMetadataAddonUrl);
      if (pinned) return pinned;
    }
    // Manifest-id default — picks Cinemeta when AIOMetadata wasn't
    // found above and no explicit pin exists. Stays inside the meta
    // ordering list (AIOMetadata → Cinemeta) so we don't accidentally
    // grab a less-capable addon.
    const defaultUrl = resolveDefaultMetaUrl(addons);
    if (defaultUrl) {
      const m = addons.find((a) => a.url === defaultUrl);
      if (m) return m;
    }
    return (
      addons.find((a) => a.resources?.includes("meta")) ??
      addons[0] ??
      null
    );
  }, [addons, meta.id, meta.media_type]);

  // Fetch full meta detail. If the chosen addon errors or returns a
  // truly empty response, fall back through the remaining addons.
  //
  // Acceptance rule: a response counts as "real" the moment it has a
  // name. We do NOT require `videos.length > 0` — many addons return
  // valid series meta with an empty videos array on the first tier
  // (the next request fills them in), and rejecting those was leaving
  // anime / Cinemeta-resolved CW items stuck on a blank detail page.
  useEffect(() => {
    if (!metaAddon || addons.length === 0) return;
    let cancelled = false;
    const ordered: AddonEntry[] = [
      metaAddon,
      ...addons.filter((a) => a.url !== metaAddon.url),
    ];
    (async () => {
      let bestSoFar: MetaDetail | null = null;
      for (const a of ordered) {
        try {
          // Single-flight via the addon URL + meta type/id triplet so
          // StrictMode's double-mount doesn't fire twice for the same
          // call. Dedupe key MUST match across mount cycles — using
          // primitive values directly keeps it stable.
          const d = await dedupedInvoke(
            `meta:${a.url}:${meta.media_type}:${meta.id}`,
            () => invoke<MetaDetail>("fetch_meta_detail", {
              addonUrl:  a.url,
              mediaType: meta.media_type,
              id:        meta.id,
            }),
          );
          if (cancelled) return;
          if (!d || !d.name) continue;
          // Surface what we got immediately so the page isn't blank
          // while we keep looking for a better source.
          if (!bestSoFar) {
            bestSoFar = d;
            setDetail(d);
          }
          // Diagnostic — surfaces what the addon returned for cast /
          // crew so a "no cast showing" report can be triaged from the
          // DevConsole without instrumenting further.
          console.info(
            `[meta] resolved id=${d.id} cast=${d.cast?.length ?? 0} ` +
              `director=${d.director?.length ?? 0} writer=${d.writer?.length ?? 0} ` +
              `producer=${d.producer?.length ?? 0} composer=${d.composer?.length ?? 0} ` +
              `voice_actors=${d.voice_actors?.length ?? 0} studios=${d.studios?.length ?? 0}`,
          );
          // Stamp the anime cache when the addon's genres list flags
          // this title as anime. Two qualifying signals:
          //   • literal "Anime" genre (precise — addon explicitly
          //     classified it)
          //   • "Animation" genre + media_type is series/anime —
          //     covers the AIOMetadata / TMDB-source path that emits
          //     "Animation" instead of "Anime" for anime series.
          // Future right-clicks on this id (CW cards, library grid,
          // catalog cards, search results) will route to the anime-
          // only source list even after the genres get stripped.
          if (Array.isArray(d.genres)) {
            const hasAnime = d.genres.some(
              (g) => typeof g === "string" && /^anime$/i.test(g.trim()),
            );
            const t = (d.media_type ?? "").toLowerCase();
            const hasAnimationSeries = (t === "series" || t === "anime") && d.genres.some(
              (g) => typeof g === "string" && /^animation$/i.test(g.trim()),
            );
            if (hasAnime || hasAnimationSeries) markAnimeId(d.id);
          }
          // For series, prefer a response with a populated videos
          // array — otherwise the episode list stays empty. Keep
          // probing addons until one delivers episodes.
          const isEpisodicMeta = ["series", "anime"].includes(
            (meta.media_type ?? "").toLowerCase(),
          );
          const hasVideos = !!(d.videos && d.videos.length);
          if (!isEpisodicMeta || hasVideos) {
            setDetail(d);
            return;
          }
        } catch { /* try next addon */ }
      }
    })();
    return () => { cancelled = true; };
  }, [metaAddon, addons, meta.id, meta.media_type]);

  // ── Multi-source ratings enrichment ──
  // Hits a Rust aggregator (fetch_aggregate_ratings) that fans out to
  // every available source — MDBList (IMDb / RT / Metacritic / TMDB /
  // Trakt / Letterboxd by IMDb id) plus Jikan (MyAnimeList score / rank
  // / popularity) and AniList (averageScore) for anime.
  // Empty array on failure / no record — never throws.
  //
  // Anime detection: the meta detail's anime IDs (mal_id / kitsu_id /
  // anilist_id / anidb_id) are passed through to let Jikan resolve
  // even when the surface id is an IMDb tt-prefix (Frieren via
  // Stremio's tt22248376 still resolves to MAL #52991 via the
  // resolver chain).
  type AggregateRating = {
    source: string;
    value: string;
    kind: string;
    weight: number;
  };
  const [aggregateRatings, setAggregateRatings] = useState<AggregateRating[]>([]);
  useEffect(() => {
    setAggregateRatings([]);
    if (!meta.id) return;
    const cached = ratingsCache.get(meta.id);
    if (cached && cached.length > 0) {
      // Re-shape legacy cache entries (pre-aggregator) into the new
      // format so existing cached values still render. Once the cache
      // refills with aggregator results these will be overwritten.
      setAggregateRatings(
        cached.map((r) => ({
          source: r.source,
          value: r.value,
          kind: "critic",
          weight: 50,
        })),
      );
    }
    let cancelled = false;
    const isAnime =
      (meta.media_type ?? "").toLowerCase() === "anime" ||
      detail?.mal_id != null ||
      detail?.kitsu_id != null ||
      detail?.anidb_id != null;
    const input = {
      imdb_id:    meta.id.startsWith("tt") ? meta.id : null,
      mal_id:     detail?.mal_id     ?? null,
      kitsu_id:   detail?.kitsu_id   ?? null,
      anilist_id: null,                       // not in current MetaDetail
      anidb_id:   detail?.anidb_id   ?? null,
      title:      meta.name,
      year:       meta.release_info ? Number(meta.release_info.slice(0, 4)) || null : null,
      is_anime:   isAnime,
    };
    dedupedInvoke(
      `ratings:${meta.id}:${isAnime ? "anime" : "std"}`,
      () => invoke<AggregateRating[]>("fetch_aggregate_ratings", { input }),
    )
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r) ? r : [];
        setAggregateRatings(list);
        // Persist as the legacy { source, value }[] shape so existing
        // cache infrastructure keeps working without a schema bump.
        ratingsCache.set(
          meta.id,
          list.map((row) => ({ source: row.source, value: row.value })),
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // detail's anime ids land async after the meta-detail fetch, so we
    // re-fire when those resolve. Same id space ⇒ dedup key keeps the
    // network call to one per (id, anime?) tuple per session.
  }, [meta.id, meta.media_type, detail?.mal_id, detail?.kitsu_id, detail?.anidb_id]);

  /** Merged rating list — `detail.ratings` (addon-supplied) deduplicated
   *  by source and overlaid with the aggregator's results. Aggregator
   *  values win on collision because they go through the explicit
   *  source-label normalization in ratings.rs. */
  const mergedRatings = useMemo(() => {
    type RatingRow = { source: string; value: string; kind?: string; weight?: number };
    const map = new Map<string, RatingRow>();
    for (const r of detail?.ratings ?? []) {
      map.set(r.source.toLowerCase(), { source: r.source, value: r.value });
    }
    for (const r of aggregateRatings) {
      map.set(r.source.toLowerCase(), r);
    }
    // Sort by aggregator weight DESC (IMDb 100, MAL 95, RT 90,
    // Metacritic 80, MAL Rank 60, MAL Popularity 55, others 50).
    // Addon-supplied ratings without an aggregator counterpart get
    // weight 50 so they slot after the well-known sources but before
    // the niche ones.
    return [...map.values()].sort((a, b) => {
      const aw = a.weight ?? 50;
      const bw = b.weight ?? 50;
      return bw - aw;
    });
  }, [detail?.ratings, aggregateRatings]);

  // Fetch streams: movies use parent id; series/anime use the picked video
  // id, falling back to the resume video id from the library if the user
  // hasn't picked an episode yet (Continue Watching path).
  //
  // The user's Stream Providers setting filters which addons are queried.
  // While streamAddonUrls is null (default), every addon is forwarded to
  // fetch_streams; an explicit array limits the query to just those URLs
  // (preserving the user's chosen order). Non-stream addons (subtitles,
  // catalog-only, etc.) are gated by the manifest check on the Rust side
  // anyway, so leaving them in the list when null is harmless.
  // Extracted so the "Refresh streams" button can re-invoke it with
  // `force` to bypass the in-memory cache. The wrapper effect below
  // drives the automatic fetch on target / addon change exactly as
  // before; `force` only matters for the manual refresh path.
  const runStreamFetch = useCallback((force = false): (() => void) | void => {
    let cancelled = false;
    const episodicId = activeVideo?.id ?? resumeVideoId;
    if (isEpisodic && !episodicId) {
      setStreams([]);
      setStreamsLoading(false);
      return;
    }
    const targetId = isEpisodic ? episodicId! : meta.id;
    setStreamsLoading(true);
    setStreams([]);
    setStreamMeta({ errors: [], warnings: [], info: [], stats: [] });
    const { streamAddonUrls } = loadAuraSettings();
    const queryAddons = streamAddonUrls === null
      ? addons
      : streamAddonUrls
          .map((url) => addons.find((a) => a.url === url))
          .filter((a): a is AddonEntry => !!a);
    // Dedupe key: addon-url set + media_type + targetId. The set is
    // hashed via JSON to keep it stable; addon order doesn't change
    // within a render batch so JSON.stringify is sufficient.
    const queryKey = `streams:${meta.media_type}:${targetId}:${queryAddons.map((a) => a.url).join("|")}`;

    // 3-minute in-memory cache — closing and reopening the same
    // episode shouldn't refetch from every addon. Skips both the
    // network fanout and the spinner. A manual refresh (`force`)
    // drops the cached snapshot so the next read misses and we pay a
    // fresh fan-out; the button is disabled while loading so there's
    // never a concurrent in-flight call to dedupe into.
    if (force) {
      streamCacheDelete(queryKey);
    } else {
      const cached = streamCacheGet(queryKey);
      if (cached) {
        if (Array.isArray(cached)) {
          setStreams(cached as unknown as StreamEntry[]);
          setStreamMeta({ errors: [], warnings: [], info: [], stats: [] });
        } else {
          setStreams(cached.streams ?? []);
          setStreamMeta(cached.metadata ?? { errors: [], warnings: [], info: [], stats: [] });
        }
        setStreamsLoading(false);
        return () => { cancelled = true; };
      }
    }

    dedupedInvoke(queryKey, () => invoke<StreamFetchResult>("fetch_streams", {
      addons:    queryAddons,
      mediaType: meta.media_type,
      id:        targetId,
    }))
      .then((r) => {
        if (cancelled) return;
        streamCachePut(queryKey, r);
        // Tauri may emit either the new `{ streams, metadata }` envelope or
        // (for the brief moment a stale dev build is running) the legacy
        // `StreamEntry[]` array. Defensive-decode either shape so a hot
        // reload mid-edit doesn't strand the panel with `undefined`.
        if (Array.isArray(r)) {
          setStreams(r as unknown as StreamEntry[]);
          setStreamMeta({ errors: [], warnings: [], info: [], stats: [] });
        } else {
          setStreams(r.streams ?? []);
          setStreamMeta(r.metadata ?? { errors: [], warnings: [], info: [], stats: [] });
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setStreamsLoading(false); });
    return () => { cancelled = true; };
  }, [addons, meta.id, meta.media_type, activeVideo, resumeVideoId, isEpisodic]);

  useEffect(() => runStreamFetch(), [runStreamFetch]);

  // Manual "Refresh streams" — StreamsPanel's header button dispatches
  // this window event (decoupled the same way as
  // aura:detail-season-changed rather than threading a callback through
  // UnifiedPanel's prop list). Re-bound whenever runStreamFetch's
  // identity changes so it always refetches the CURRENT target, and
  // `force` skips the in-memory cache.
  useEffect(() => {
    const onRefresh = () => runStreamFetch(true);
    window.addEventListener("aura:streams-refresh", onRefresh);
    return () => window.removeEventListener("aura:streams-refresh", onRefresh);
  }, [runStreamFetch]);

  // When `detail.videos` arrives AND the user has a resume target AND no
  // active episode yet, snap the active episode to the resume one. This
  // makes the streams panel "Now playing: S01E05" caption render properly
  // and the metadata-display logic light up downstream.
  //
  // Routed through resolveResumeEpisode so a stale-shape id from the
  // library state (e.g. `tt22248376:1:34` written before cour
  // aggregation) still anchors to the right VideoEntry in the new
  // multi-cour shape. Without this fallback the streams pane caption
  // stayed blank for users whose CW entries pre-date the AIOMetadata
  // patch.
  useEffect(() => {
    if (activeVideo) return;
    if (!isEpisodic) return;
    if (!resumeVideoId) return;
    const v = resolveResumeEpisode(resumeVideoId, detail?.videos);
    if (v) setActiveVideo(v);
  }, [detail?.videos, resumeVideoId, isEpisodic, activeVideo]);

  const groupedStreams = useMemo(() => {
    const map = new Map<string, StreamEntry[]>();
    for (const s of streams) {
      const list = map.get(s.addon_name) ?? [];
      list.push(s);
      map.set(s.addon_name, list);
    }
    return [...map.entries()];
  }, [streams]);

  // Background art priority
  const heroArt =
    detail?.background ?? meta.background ??
    meta.fanart ?? meta.backdrop ?? meta.poster ?? null;
  const logoArt = detail?.logo ?? meta.logo ?? null;

  const openTransform = fromRect
    ? (() => {
        const w = window.innerWidth, h = window.innerHeight;
        const sx = fromRect.width / w;
        const sy = fromRect.height / h;
        const tx = fromRect.left + fromRect.width  / 2 - w / 2;
        const ty = fromRect.top  + fromRect.height / 2 - h / 2;
        return `translate3d(${tx}px, ${ty}px, 0) scale(${sx}, ${sy})`;
      })()
    : "scale(0.96)";

  const targetForPlay = (video?: VideoEntry | null) => ({
    id:         video?.id ?? meta.id,
    // For series we ALWAYS want the library record keyed at the series
    // root, regardless of which episode is playing — that matches
    // Stremio's official client (state.video_id stores the episode).
    // Movies and other non-episodic content use the same id for both.
    series_id:  isEpisodic ? meta.id : (video?.id ?? meta.id),
    media_type: meta.media_type,
    name:       detail?.name ?? meta.name,
    // AIOMetadata-supplied scoring inputs — drives the Original Language
    // Audio algorithm in PlayerOverlay. Falls back through genres /
    // country when the structured fields aren't populated (e.g. when
    // AIOMetadata's Redis cache still holds a pre-update blob).
    scoring: {
      original_language:    detail?.original_language ?? null,
      production_countries: detail?.production_countries ?? [],
      genres:               detail?.genres ?? [],
      country:              detail?.country ?? null,
    },
    episode:    video
      ? (video.season != null && video.episode != null
        ? `S${String(video.season).padStart(2, "0")}E${String(video.episode).padStart(2, "0")}`
        : undefined)
      : undefined,
    episode_title: video?.title ?? undefined,
    // Numeric pass-through for scrobble.rs's dual-numbering Trakt
    // payload. The picker's VideoEntry numbers are authoritative —
    // they're what the user selected and what the toast displays.
    season:      video?.season ?? undefined,
    episode_num: video?.episode ?? undefined,
  });

  // When user picks an episode → flip the panel to streams.
  const handlePickEpisode = (v: VideoEntry) => {
    setActiveVideo(v);
    setPanelMode("streams");
  };

  return (
    <div
      className="fixed left-0 right-0 bottom-0 z-[60] overflow-hidden"
      onTransitionEnd={(e) => {
        // Only the transform settle matters for badge anchoring (the
        // opacity transition finishes earlier, at a different time).
        // `e.target === e.currentTarget` rejects bubbled transitionend
        // events from descendants (e.g. a badge's hover-scale, which
        // also has propertyName "transform").
        if (e.propertyName === "transform" && e.target === e.currentTarget) {
          setEntered(true);
        }
      }}
      style={{
        // top: 36 px — leave the custom Tauri title bar uncovered so the user
        // can still drag / minimise / close the window while a detail page
        // is open. The title bar is `h-9` (36 px).
        top: 36,
        opacity:        opening ? 0 : 1,
        transform:      opening ? openTransform : "translate3d(0,0,0) scale(1)",
        transition:     "opacity 320ms ease-out, transform 380ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        transformOrigin: "center center",
      }}
    >
      {/* Full-bleed backdrop */}
      {heroArt && (
        <ImageLoader
          src={heroArt}
          alt=""
          decoding="async"
          draggable={false}
          className="absolute inset-0 w-full h-full"
          imgClassName="w-full h-full object-cover"
          imgStyle={{ objectPosition: "center top" }}
          skeletonClassName="detail-backdrop-skeleton"
        />
      )}
      {/* Layered overlays — heaviest on the right where the panel sits */}
      <div aria-hidden className="absolute inset-0 pointer-events-none"
           style={{ background: "radial-gradient(ellipse at 25% 50%, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.92) 100%)" }} />
      <div aria-hidden className="absolute inset-y-0 right-0 w-3/5 pointer-events-none"
           style={{ background: "linear-gradient(to right, rgba(0,0,0,0) 0%, rgba(0,0,0,0.55) 45%, rgba(0,0,0,0.85) 100%)" }} />
      <div aria-hidden className="absolute inset-x-0 bottom-0 h-2/3 pointer-events-none"
           style={{ background: "linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0) 100%)" }} />

      {/* Top action bar — sits inside the detail-view zone, below the
          window title bar. */}
      <div className="absolute top-4 left-4 right-4 z-30 flex items-center justify-between pointer-events-none">
        <button
          onClick={onClose}
          aria-label="Back"
          className="pointer-events-auto flex items-center gap-2 px-3 h-9 rounded-full
                     bg-black/60 backdrop-blur-xl border border-white/10
                     text-white/85 hover:text-white text-xs font-medium tracking-wide
                     transition-colors"
        >
          <ArrowBackIcon /> Back
        </button>
        <button
          onClick={onClose}
          aria-label="Close"
          className="pointer-events-auto w-9 h-9 rounded-full
                     bg-black/60 backdrop-blur-xl border border-white/10
                     flex items-center justify-center text-white/85 hover:text-white
                     transition-colors"
        >
          <CloseIcon />
        </button>
      </div>

      {/* ── Layout: LEFT (all metadata) + RIGHT (compact unified panel) ──
          Using CSS Grid with explicit columns: a flexible left column plus a
          fixed 28-rem right column. Grid sidesteps the flex-shrink-0 +
          w-full + max-w-md interaction that previously made the right panel
          stretch to the full viewport width. */}
      <div
        className="absolute inset-0 grid"
        style={{ gridTemplateColumns: "minmax(0, 1fr) min(32rem, 42%)" }}
      >
        {/* LEFT — scrollable inner if it overflows */}
        <section className="min-w-0 h-full px-12 pt-24 pb-10 flex flex-col justify-end overflow-y-auto"
                 style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}>
          {/* Cap the inner content at a comfortable reading width so on
              ultrawide displays the synopsis and credit rows wrap instead
              of stretching across half the screen. */}
          <div className="space-y-7" style={{ maxWidth: "min(720px, 100%)" }}>
            {/* Logo or title — bumped ~30% bigger */}
            {logoArt ? (
              <img
                src={logoArt}
                alt={detail?.name ?? meta.name}
                draggable={false}
                className="max-h-44 object-contain object-left"
                style={{
                  maxWidth: "min(580px, 100%)",
                  filter:
                    "drop-shadow(0 6px 18px rgba(0,0,0,0.85)) drop-shadow(0 0 28px rgba(0,0,0,0.5))",
                }}
              />
            ) : (
              <h1
                className="text-white text-[64px] font-light tracking-tight leading-[0.98]"
                style={{ textShadow: "0 4px 16px rgba(0,0,0,0.95), 0 0 30px rgba(0,0,0,0.55)" }}
              >
                {detail?.name ?? meta.name}
              </h1>
            )}

            {/* Dense meta strip */}
            <div className="flex items-center gap-3 flex-wrap text-[14px] font-mono uppercase tracking-[0.14em]">
              {/* Anime chip leads the strip when applicable so the
                  classification reads first; the type chip (Movies /
                  Series) follows. Detection now folds in the meta-
                  detail's originalLanguage + productionCountries, which
                  catches IMDb-id'd anime films that lack mal/kitsu/
                  anidb anchors (Chainsaw Man, Jujutsu Kaisen, etc.). */}
              {isAnimeMeta({
                media_type:           detail?.media_type ?? meta.media_type,
                id:                   meta.id,
                genres:               detail?.genres ?? meta.genres ?? null,
                original_language:    detail?.original_language ?? null,
                production_countries: detail?.production_countries ?? null,
              }) && (
                <span className="px-2.5 py-1 rounded-sm bg-pink-500/15 border border-pink-400/30
                                 text-pink-300 text-[12px] font-semibold">Anime</span>
              )}
              <span className="px-2.5 py-1 rounded-sm bg-white/12 border border-white/18
                               text-white/85 text-[12px] font-semibold">
                {typeLabel(detail?.media_type ?? meta.media_type)}
              </span>
              {(detail?.release_info ?? meta.release_info) && (
                <Stat label="Year"    value={detail?.release_info ?? meta.release_info!} />
              )}
              {(() => {
                // Release date display:
                //   • Movies / non-episodic → use detail.released (full
                //     date) when present, formatted as "Mar 12, 2024".
                //   • Series / anime → derive a range from the
                //     currently-selected season's episode list. Picks
                //     min and max `released` across that season's videos.
                //     Updates whenever selectedSeason changes (the cast
                //     block uses the same signal). Hidden when no
                //     dates are parseable.
                const isEpisodicNow = ["series", "anime"].includes(
                  (detail?.media_type ?? meta.media_type ?? "").toLowerCase(),
                );
                if (!isEpisodicNow) {
                  const iso = detail?.released ?? null;
                  if (!iso) return null;
                  const ts = Date.parse(iso);
                  if (!Number.isFinite(ts)) return null;
                  const formatted = new Date(ts).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                  });
                  return <Stat label="Released" value={formatted} />;
                }
                if (selectedSeason == null || !detail?.videos) return null;
                const eps = detail.videos.filter(
                  (v) => (v.season ?? 0) === selectedSeason,
                );
                const ts: number[] = [];
                for (const v of eps) {
                  if (!v.released) continue;
                  const t = Date.parse(v.released);
                  if (Number.isFinite(t)) ts.push(t);
                }
                if (ts.length === 0) return null;
                ts.sort((a, b) => a - b);
                const fmt = (t: number) =>
                  new Date(t).toLocaleDateString(undefined, {
                    month: "short", year: "numeric",
                  });
                const fmtFull = (t: number) =>
                  new Date(t).toLocaleDateString(undefined, {
                    month: "short", day: "numeric", year: "numeric",
                  });
                const first = ts[0];
                const last  = ts[ts.length - 1];
                // Single-date season (only one episode aired so far,
                // or all dated identically) → show the full date.
                if (first === last) {
                  return <Stat label={`S${String(selectedSeason).padStart(2, "0")} air`} value={fmtFull(first)} />;
                }
                return (
                  <Stat
                    label={`S${String(selectedSeason).padStart(2, "0")} air`}
                    value={`${fmt(first)} – ${fmt(last)}`}
                  />
                );
              })()}
              {detail?.runtime && <Stat label="Runtime" value={detail.runtime} />}
            </div>

            {/* Ratings row — surfaced as its own tile band below the
                metadata strip so source + value have room to read at
                a glance instead of being squeezed inline next to year
                / runtime. Each tile is brand-coloured (IMDb yellow,
                Rotten Tomatoes red, Metacritic teal, MyAnimeList
                indigo, etc.); see ratingPalette below. The Rust
                aggregator (`fetch_aggregate_ratings`) returns the
                MDBList-sourced rows plus MAL/AniList rows for anime,
                merged with whatever the addon shipped. We render at
                most six. */}
            {mergedRatings.length > 0 && (
              <div className="flex items-center gap-2.5 flex-wrap -mt-1">
                {mergedRatings.slice(0, 6).map((r) => (
                  <RatingTile
                    key={r.source}
                    source={r.source}
                    value={r.value}
                    kind={r.kind}
                  />
                ))}
              </div>
            )}

            {/* Action row — currently just Library add/remove. Sits below
                the meta strip so it never moves around when ratings or
                runtime fields appear/disappear. */}
            {onLibraryToggle && (
              <div className="flex items-center gap-3 -mt-2">
                <button
                  type="button"
                  onClick={(e) => onLibraryToggle({ x: e.clientX, y: e.clientY })}
                  className={`group/lib flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium
                              border transition-colors duration-150
                              ${inLibrary
                                ? "bg-ln-accent/20 text-ln-accent border-ln-accent/40 hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-300/40"
                                : "bg-white/8 text-white/85 border-white/15 hover:bg-ln-accent/20 hover:text-ln-accent hover:border-ln-accent/40"
                              }`}
                >
                  {inLibrary ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden
                           className="transition-transform duration-150 group-hover/lib:hidden">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                      </svg>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden
                           className="hidden group-hover/lib:block">
                        <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
                      </svg>
                      <span className="group-hover/lib:hidden">In Library</span>
                      <span className="hidden group-hover/lib:inline">Remove from Library</span>
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />
                      </svg>
                      <span>Add to Library</span>
                    </>
                  )}
                </button>
              </div>
            )}

            <div className="h-px w-20 bg-ln-accent/65" aria-hidden />

            {/* Synopsis — larger size + weight for "Command Center" presence */}
            {(detail?.description ?? meta.description) && (
              <p
                className="text-white/95 text-[18px] leading-[1.55] font-normal tracking-[0.005em]
                           max-w-prose selectable"
                style={{ textShadow: "0 1px 6px rgba(0,0,0,0.85)" }}
              >
                {detail?.description ?? meta.description}
              </p>
            )}

            {/* Per-episode synopsis — surfaces below the show synopsis
                whenever the user has selected an episode in EpisodePane
                AND that episode carries an `overview`. Optionally
                blurred behind a "Click to reveal" gate (user setting in
                Detail Page section). Watched episodes auto-bypass the
                blur. Unmounts cleanly when nothing is selected or the
                episode has no overview text. */}
            <EpisodeSynopsisSection
              activeVideo={activeVideo}
              isWatched={
                activeVideo
                  ? getManualWatchedState(activeVideo.id) === "watched"
                  : false
              }
              revealed={
                activeVideo ? revealedSynopses.has(activeVideo.id) : false
              }
              onReveal={(id) => {
                setRevealedSynopses((prev) => {
                  const next = new Set(prev);
                  next.add(id);
                  return next;
                });
              }}
            />

            {/* Genre chips */}
            {detail?.genres && detail.genres.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {detail.genres.map((g) => (
                  <span key={g}
                    className="px-3 py-1 rounded-sm text-[12px] font-mono uppercase tracking-[0.12em]
                               bg-white/8 text-white/85 border border-white/12">
                    {g}
                  </span>
                ))}
              </div>
            )}

            {/* Crew & cast — moved from the right column. Each row a wide
                "About" line. Names are clickable — they fire onSearchByName
                to flip to Home and queue the name as the deep-link query.
                Section order: Cast → Directors → Writers → Producers →
                Composers → Creators. Country is non-clickable text. */}
            <div className="space-y-3 pt-1">
              <SeasonAwareCastBlock
                detail={detail}
                meta={meta}
                selectedSeason={selectedSeason}
                onClickName={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined}
              />

              {detail?.voice_actors && detail.voice_actors.length > 0 &&
                <CreditRow label={detail.voice_actors.length > 1 ? "Voice Actors" : "Voice Actor"}
                  values={plainCredits(detail.voice_actors)}
                  onClickName={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined} />}
              {detail?.director && detail.director.length > 0 &&
                <CreditRow label={detail.director.length > 1 ? "Directors" : "Director"}
                  values={plainCredits(detail.director)}
                  onClickName={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined} />}
              {detail?.writer && detail.writer.length > 0 &&
                <CreditRow label={detail.writer.length > 1 ? "Writers" : "Writer"}
                  values={plainCredits(detail.writer)}
                  onClickName={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined} />}
              {(() => {
                const producerEntries = (detail?.producer_detailed && detail.producer_detailed.length > 0)
                  ? detail.producer_detailed
                  : plainCredits(detail?.producer ?? []);
                return producerEntries.length > 0
                  ? (
                    <CreditRow label={producerEntries.length > 1 ? "Producers" : "Producer"}
                      values={producerEntries}
                      onClickName={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined} />
                  )
                  : null;
              })()}
              {detail?.composer && detail.composer.length > 0 &&
                <CreditRow label={detail.composer.length > 1 ? "Composers" : "Composer"}
                  values={plainCredits(detail.composer)}
                  onClickName={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined} />}
              {detail?.creator && detail.creator.length > 0 &&
                <CreditRow label={detail.creator.length > 1 ? "Creators" : "Creator"}
                  values={plainCredits(detail.creator)}
                  onClickName={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined} />}
              {detail?.studios && detail.studios.length > 0 &&
                <CreditRow label={detail.studios.length > 1 ? "Studios" : "Studio"}
                  values={plainCredits(detail.studios)} />}
              {detail?.country && (
                <CreditRow label="Country" values={plainCredits([detail.country])} />
              )}
            </div>
          </div>
        </section>

        {/* RIGHT — fixed grid column. Width is controlled entirely by the
            grid template above; the aside just fills its assigned cell.
            X-overflow is `visible` (instead of `hidden`) so the
            StreamMetaBadges cluster — anchored at -left-12 to sit in
            the gutter between the left column and the streams panel —
            isn't clipped at the aside's edge. Y-stays-hidden so vertical
            scroll containment still works the same as before. */}
        <aside
          ref={asideRef}
          className="h-full flex flex-col pt-20 pb-6 pr-5 pl-3 min-w-0 relative"
          style={{ overflowY: "hidden", overflowX: "visible" }}
        >
          <UnifiedPanel
            mode={panelMode}
            isEpisodic={isEpisodic}
            seriesId={meta.id}
            seriesMediaType={meta.media_type}
            videos={detail?.videos ?? []}
            activeVideo={activeVideo}
            streams={streams}
            streamMeta={streamMeta}
            streamsLoading={streamsLoading}
            groupedStreams={groupedStreams}
            // Cour-specific catalog entries carry the season in their
            // title ("Dorohedoro Season 2", "… 2nd Season", "… Part 2",
            // "… Cour 2", "… Season II"). Parse an EXPLICIT ordinal only
            // — bare trailing numbers are skipped so "Mob Psycho 100" /
            // "86" / "Steins;Gate 0" never misfire. EpisodesPanel
            // ignores this unless that season exists in the aggregated
            // videos, and a resume / just-played target still wins.
            seasonHint={isEpisodic
              ? (() => {
                  const t = (meta.name ?? "").trim();
                  if (!t) return null;
                  const ROMAN: Record<string, number> = {
                    i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8,
                  };
                  let m =
                    t.match(/\b(?:season|cour|part)\s+(\d{1,2})\b/i) ??
                    t.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+(?:season|cour)\b/i);
                  if (m) {
                    const s = parseInt(m[1], 10);
                    return s >= 1 && s <= 50 ? s : null;
                  }
                  m = t.match(/\b(?:season|cour|part)\s+([ivx]{1,5})\b/i);
                  if (m) return ROMAN[m[1].toLowerCase()] ?? null;
                  return null;
                })()
              : null}
            // detail===null is the only signal Aura has for "meta
            // fetch still in flight". As soon as ANY addon returns,
            // detail flips to a value and the shimmer collapses;
            // even an empty videos[] then reads as "addon genuinely
            // returned no episodes" (the existing message) rather
            // than "still loading".
            metaLoading={detail === null}
            onPickEpisode={handlePickEpisode}
            onBackToEpisodes={() => {
              // Re-arm the same scroll target the EpisodesPanel uses when
              // the user is returning from playback — going back from
              // streams via the back arrow should also anchor the list
              // on whichever episode they had selected. activeVideo is
              // the row that drove the streams view; falling back to
              // the prop hint covers the rare case where streams was
              // entered via a CW resume rather than an episode pick.
              const target = activeVideo?.id ?? openOnEpisodeId ?? null;
              if (target) setScrollOnceTo(target);
              setPanelMode("episodes");
            }}
            onPlay={(s) => onPlayStream(s, targetForPlay(activeVideo))}
            onCopy={(text) => navigator.clipboard.writeText(text).catch(() => {})}
            onPlayExternal={(url) => openUrl(url).catch(() => {})}
            scrollToVideoId={scrollOnceTo}
            onScrollHandled={handleScrollHandled}
          />
          {/* AIOStreams notice badges — portal-rendered into the document
              body and anchored to the aside's left edge via getBoundingClientRect.
              The aside has `overflowY:hidden`, which (per CSS spec) silently
              forces overflowX to `auto` even when it's set to `visible`,
              clipping badges that sit in the gutter. Portaling sidesteps
              that whole overflow chain — the cluster lives in viewport
              coordinates, immune to any ancestor's overflow rules. */}
          {panelMode === "streams" && streams.length > 0 && (
            <StreamMetaBadges metadata={streamMeta} anchorRef={asideRef} entered={entered} />
          )}
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LEFT-column helpers
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-white/45 text-[11px] tracking-[0.2em]">{label}</span>
      <span className="text-white/95 text-[14px] font-medium">{value}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// RatingTile — brand-coloured pill for one source's rating.
//
// Source label format: "ROTTEN TOMATOES · CRITIC" / "IMDB" / "MYANIMELIST".
// The kind suffix only appears when it adds information (a MAL "aggregate"
// score doesn't need a tag, RT "critic" does because the audience score is
// distinct enough that the user benefits from the disambiguation even when
// audience isn't shown).
//
// Colour palette is loosely brand-faithful but desaturated so a row of
// six tiles doesn't read as a circus — IMDb yellow stays yellow, RT
// stays red, Metacritic shifts to teal so it doesn't clash with the
// anime chip, MAL takes Aura's accent blue / indigo. Anything we don't
// recognise (addon-supplied "TheMovieDB" et al.) gets a neutral white-
// glass tile.
// ---------------------------------------------------------------------------

interface RatingPaletteEntry {
  /** Background tint. Soft enough to layer over the hero blur without
   *  blowing out, strong enough that the brand colour reads. */
  bg: string;
  /** Border / outline. Same hue, slightly stronger. */
  border: string;
  /** Source-label colour. */
  label: string;
  /** Value colour. Slightly brighter than the label so the number
   *  catches the eye first. */
  value: string;
}

const RATING_PALETTE: Record<string, RatingPaletteEntry> = {
  imdb: {
    bg:     "bg-amber-400/15",
    border: "border-amber-300/40",
    label:  "text-amber-200/85",
    value:  "text-amber-100",
  },
  "rotten tomatoes": {
    bg:     "bg-red-500/15",
    border: "border-red-400/40",
    label:  "text-red-200/85",
    value:  "text-red-100",
  },
  metacritic: {
    bg:     "bg-teal-500/15",
    border: "border-teal-300/40",
    label:  "text-teal-200/85",
    value:  "text-teal-100",
  },
  myanimelist: {
    bg:     "bg-indigo-500/18",
    border: "border-indigo-300/40",
    label:  "text-indigo-200/85",
    value:  "text-indigo-50",
  },
  "mal rank": {
    bg:     "bg-indigo-500/10",
    border: "border-indigo-300/25",
    label:  "text-indigo-200/65",
    value:  "text-indigo-100",
  },
  "mal popularity": {
    bg:     "bg-indigo-500/10",
    border: "border-indigo-300/25",
    label:  "text-indigo-200/65",
    value:  "text-indigo-100",
  },
};

const NEUTRAL_RATING_PALETTE: RatingPaletteEntry = {
  bg:     "bg-white/8",
  border: "border-white/15",
  label:  "text-white/55",
  value:  "text-white/95",
};

/** Drop a "Critic" / "Audience" tag onto sources where the
 *  distinction matters. RT is the canonical case — even when only
 *  the critic score is present, the user benefits from knowing
 *  which axis they're reading. MAL / IMDb scores are aggregate by
 *  nature, so the suffix would be noise. */
function ratingLabelFor(source: string, kind?: string): string {
  const upper = source.toUpperCase();
  const suffix =
    kind === "critic"   ? " · CRITIC"
  : kind === "audience" ? " · AUDIENCE"
  : "";
  // Only RT gets the suffix today; expand the allowlist as more
  // sources start surfacing both axes.
  if (suffix && /rotten tomatoes/i.test(source)) return upper + suffix;
  if (suffix && /metacritic/i.test(source))      return upper + suffix;
  return upper;
}

function RatingTile({
  source, value, kind,
}: { source: string; value: string; kind?: string }) {
  const key = source.toLowerCase();
  const palette = RATING_PALETTE[key] ?? NEUTRAL_RATING_PALETTE;
  return (
    <span
      title={ratingLabelFor(source, kind)}
      className={`inline-flex items-center gap-2 px-2.5 py-1.5 rounded-md border
                  ${palette.bg} ${palette.border}`}
    >
      <BrandLogo
        domain={ratingDomain(source)}
        alt={ratingLabelFor(source, kind)}
        size={64}
        className="h-4 w-auto max-w-[72px] object-contain"
        fallback={
          <span className={`text-[10.5px] font-semibold tracking-[0.16em] ${palette.label}`}>
            {ratingLabelFor(source, kind)}
          </span>
        }
      />
      <span className={`text-[13px] font-semibold tabular-nums ${palette.value}`}>
        {value}
      </span>
    </span>
  );
}

/** One enriched credit. `character` and `photo` are populated when the
 *  meta source supplied them (AIOMetadata's `app_extras.cast`/
 *  `app_extras.producers`); otherwise null and we render just the
 *  name. The trailing `episode_count` / `total_show_episodes` /
 *  `tier` fields are TMDB-only — they fuel the cast hover overlay's
 *  Main / Recurring / Guest classification, gated by the
 *  `hideCastSpoilers` setting. Optional everywhere; CreditHoverCard
 *  silently omits the tier overlay when they aren't set. */
interface CreditEntry {
  name: string;
  character: string | null;
  photo: string | null;
  episode_count?: number;
  total_show_episodes?: number;
}

type CastTier = "main" | "recurring" | "guest";

/** Tier classifier per the spec. Ratio of an actor's episodes to the
 *  show's total — ≥50 % = main, ≥5 % or 3+ episodes = recurring,
 *  everything else = guest. Edge case for short prestige series
 *  (≤6 episodes): guest tier won't surface, which is fine.  */
function classifyCastTier(episodeCount: number, totalShowEpisodes: number): CastTier {
  if (totalShowEpisodes <= 0) return "guest";
  const ratio = episodeCount / totalShowEpisodes;
  if (ratio >= 0.5) return "main";
  if (ratio >= 0.05 || episodeCount >= 3) return "recurring";
  return "guest";
}

function castTierLabel(tier: CastTier): string {
  return tier === "main" ? "Main cast" : tier === "recurring" ? "Recurring" : "Guest";
}

/** Renders the per-episode synopsis section that lives below the show
 *  synopsis on the detail page. Surfaces only when the user has
 *  selected an episode in EpisodePane AND that episode has a non-empty
 *  `overview`. Optionally blurred behind a "Click to reveal" gate
 *  (per `auraSettings.blurEpisodeSynopsis`). Watched episodes bypass
 *  the blur — the content's no longer a spoiler by definition. */
function EpisodeSynopsisSection({
  activeVideo, isWatched, revealed, onReveal,
}: {
  activeVideo: VideoEntry | null;
  isWatched: boolean;
  revealed: boolean;
  onReveal: (id: string) => void;
}) {
  // Subscribe to the settings toggle so flipping it in the Settings
  // panel takes effect without a refresh.
  const [blurOn, setBlurOn] = useState(() => loadAuraSettings().blurEpisodeSynopsis);
  useEffect(() => {
    const sync = () => setBlurOn(loadAuraSettings().blurEpisodeSynopsis);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  if (!activeVideo) return null;
  const overview = (activeVideo.overview ?? "").trim();
  if (!overview) return null;

  // Heading sub-line — "S02E03 — Title" so the user can confirm which
  // episode they selected when they're looking at the synopsis (the
  // EpisodePane may have scrolled or the user navigated via NextUp).
  const s = activeVideo.season;
  const e = activeVideo.episode;
  const seCode =
    s != null && e != null
      ? `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`
      : null;
  const title = (activeVideo.title ?? "").trim();
  const subLine = seCode && title ? `${seCode} — ${title}` : seCode ?? title;

  const shouldBlur = blurOn && !isWatched && !revealed;

  return (
    <section className="space-y-2 pt-1" aria-label="Selected episode synopsis">
      <div>
        <p className="text-white/45 text-[10px] font-mono uppercase tracking-[0.22em]">
          Episode synopsis
        </p>
        {subLine && (
          <p className="text-white/55 text-[12px] mt-0.5 font-mono">
            {subLine}
          </p>
        )}
      </div>
      <div className="relative max-w-prose">
        <p
          className={[
            "text-white/75 text-[15px] leading-relaxed transition-[filter] duration-200",
            shouldBlur ? "select-none" : "selectable",
          ].join(" ")}
          style={{
            filter: shouldBlur ? "blur(8px) saturate(120%)" : "none",
            // user-select: none defence against highlight-to-bypass when
            // blurred. The Tailwind `select-none` class handles it; the
            // inline `userSelect` mirror is for browsers that ignore the
            // class on text inside :is() selectors.
            userSelect: shouldBlur ? "none" : "text",
          }}
        >
          {overview}
        </p>
        {shouldBlur && (
          <button
            type="button"
            onClick={() => onReveal(activeVideo.id)}
            aria-label="Reveal episode synopsis"
            // No always-visible chip — the blurred text itself is the
            // affordance. Hovering surfaces a small tooltip above the
            // pointer with the "Click to reveal spoilers" prompt, so
            // the chip doesn't obscure the synopsis while the user is
            // deciding. `peer` doesn't help here (the tooltip is a
            // child) so we use `group` + `group-hover:` to keep the
            // tooltip CSS-only.
            className="absolute inset-0 cursor-pointer group"
          >
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                         opacity-0 group-hover:opacity-100
                         pointer-events-none whitespace-nowrap
                         px-2.5 py-1 rounded-md
                         bg-black/80 backdrop-blur-sm
                         border border-white/20 text-white/90
                         text-[11.5px] font-medium tracking-wide
                         shadow-[0_2px_12px_rgba(0,0,0,0.55)]
                         transition-opacity duration-150"
            >
              Click to reveal spoilers
            </span>
          </button>
        )}
      </div>
    </section>
  );
}

/** Promote a string-only credit list to enriched entries (no character /
 *  photo). Used when the addon doesn't ship the rich shape. */
function plainCredits(values: string[]): CreditEntry[] {
  return values
    .filter((v): v is string => !!v && v.trim().length > 0)
    .map((name) => ({ name, character: null, photo: null }));
}

/** Default visible-entry cap per credit row. Anything beyond this hides
 *  behind a "View all" toggle so dense TMDB / TVDB titles don't dump
 *  20+ names into a single row by default — keeps the page scannable
 *  while leaving the long-tail accessible to anyone curious about the
 *  full ensemble. The Rust extractor's hard cap of 20 still applies,
 *  so the toggle reveals up to 10 more entries. */
const CREDIT_ROW_VISIBLE_CAP = 10;

function CreditRow({
  label,
  values,
  onClickName,
}: {
  label: string;
  values: CreditEntry[];
  /** When provided, each name renders as an inline button that invokes this
   *  callback. Falls back to plain comma-joined text otherwise (used for the
   *  Country row, which is not a person). */
  onClickName?: (name: string) => void;
}) {
  const cleaned = values.filter((v) => !!v.name && v.name.trim().length > 0);
  const [expanded, setExpanded] = useState(false);
  if (cleaned.length === 0) return null;

  // If any entry carries a character, switch the row to a flex-wrap
  // grid so each cast member can render as `Name` over `as Character`.
  // Pure-name rows (Director / Writer / Country / etc.) keep the
  // compact inline `·`-separated layout.
  const hasAnyCharacter = cleaned.some((e) => !!e.character);

  // Slice down to the visible cap unless the user has expanded the
  // row. The toggle button is rendered as the LAST item in the same
  // flow so it reads as part of the row rather than a separate
  // control. When expanded, we render every entry and the toggle
  // flips to "Show less".
  const overflowCount = cleaned.length - CREDIT_ROW_VISIBLE_CAP;
  const visible = expanded || overflowCount <= 0
    ? cleaned
    : cleaned.slice(0, CREDIT_ROW_VISIBLE_CAP);

  const toggleButton = overflowCount > 0 ? (
    <button
      type="button"
      onClick={() => setExpanded((e) => !e)}
      className="text-ln-accent/85 hover:text-ln-accent transition-colors cursor-pointer
                 bg-transparent p-0 border-0 text-[12.5px] leading-snug font-inherit
                 focus:outline-none focus-visible:underline whitespace-nowrap"
    >
      {expanded ? "Show less" : `View all (${cleaned.length})`}
    </button>
  ) : null;

  return (
    <div className="flex items-baseline gap-3">
      <span className="text-white/45 text-[11px] font-mono font-semibold tracking-[0.18em] uppercase
                       w-20 flex-shrink-0">
        {label}
      </span>
      {hasAnyCharacter ? (
        <div
          className="flex-1 flex flex-wrap gap-x-5 gap-y-2 selectable"
          style={{ textShadow: "0 1px 4px rgba(0,0,0,0.85)" }}
        >
          {visible.map((entry, i) => (
            <CreditName
              key={`${entry.name}-${i}`}
              entry={entry}
              showCharacterBelow
              onClick={onClickName ? () => onClickName(entry.name) : undefined}
            />
          ))}
          {toggleButton && (
            <span className="inline-flex items-center self-center">{toggleButton}</span>
          )}
        </div>
      ) : (
        <p className="text-white/90 text-[14.5px] leading-snug selectable"
           style={{ textShadow: "0 1px 4px rgba(0,0,0,0.85)" }}>
          {visible.map((entry, i) => (
            <span key={`${entry.name}-${i}`}>
              <CreditName
                entry={entry}
                onClick={onClickName ? () => onClickName(entry.name) : undefined}
              />
              {i < visible.length - 1 && <span className="text-white/50"> · </span>}
            </span>
          ))}
          {toggleButton && (
            <>
              <span className="text-white/50"> · </span>
              {toggleButton}
            </>
          )}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreditName — renders one credit entry's name as either a clickable
// "search for this person" button or static text. When the entry has a
// character (role / voiced character) and/or a photo, hovering exposes
// a small floating card with both. Photo is rendered with a contained
// fixed-size box so addons that ship oversized headshots don't blow
// out the row.
// ---------------------------------------------------------------------------

function CreditName({
  entry, onClick, showCharacterBelow,
}: {
  entry: CreditEntry;
  onClick?: () => void;
  /** When true, the character pairing renders as a small line BELOW
   *  the actor's name (used by the cast / voice-cast / producer rows
   *  where the character is meaningful). When false (the inline
   *  `·`-separated rows like Director / Writer), the character only
   *  appears in the hover photo card — keeps those rows compact. */
  showCharacterBelow?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const hasTierInfo =
    typeof entry.episode_count === "number" &&
    typeof entry.total_show_episodes === "number" &&
    entry.total_show_episodes > 0;
  const hasExtras = !!entry.character || !!entry.photo || hasTierInfo;

  const nameEl = onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="text-white/95 hover:text-ln-accent transition-colors cursor-pointer
                 bg-transparent p-0 border-0 text-[14.5px] leading-snug font-inherit text-left
                 focus:outline-none focus-visible:underline"
      title={entry.character ? `${entry.name} as ${entry.character}` : `Search for "${entry.name}"`}
    >
      {entry.name}
    </button>
  ) : (
    <span className="text-white/95 text-[14.5px] leading-snug">{entry.name}</span>
  );

  // Inline mode (no character below) — just the name, with optional
  // hover photo card. Used for crew credits where character pairing
  // doesn't apply.
  if (!showCharacterBelow) {
    if (!hasExtras) return nameEl;
    return (
      <span
        className="relative inline-block"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {nameEl}
        {hovered && <CreditHoverCard entry={entry} />}
      </span>
    );
  }

  // Stacked mode — name on top, "as Character" beneath in a smaller,
  // dimmer line. Each entry is a self-contained inline-flex column so
  // the parent can flex-wrap them across the row without inline-text
  // alignment artifacts.
  return (
    <span
      className="relative inline-flex flex-col items-start min-w-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {nameEl}
      {entry.character && (
        <span className="text-white/45 text-[11.5px] leading-tight italic mt-0.5">
          as {entry.character}
        </span>
      )}
      {hovered && hasExtras && <CreditHoverCard entry={entry} />}
    </span>
  );
}

/** Floating card shown above a hovered credit when the entry has a
 *  photo and/or character pairing. Centred over the trigger; uses
 *  pointer-events: none so the hover stays on the trigger element.
 *  When the entry carries `episode_count` + `total_show_episodes`
 *  (TMDB series only, gated by the hideCastSpoilers setting), a tier
 *  + count line is appended to the bottom of the card. */
function CreditHoverCard({ entry }: { entry: CreditEntry }) {
  const showTier =
    typeof entry.episode_count === "number" &&
    typeof entry.total_show_episodes === "number" &&
    entry.total_show_episodes > 0;
  const tier = showTier
    ? classifyCastTier(entry.episode_count!, entry.total_show_episodes!)
    : null;
  return (
    <span
      aria-hidden
      className="absolute z-50 left-1/2 -translate-x-1/2 bottom-full mb-2
                 pointer-events-none
                 px-3 py-2 rounded-lg
                 bg-black/92 backdrop-blur-xl border border-white/15
                 shadow-[0_18px_42px_-12px_rgba(0,0,0,0.85)]
                 flex flex-col items-center gap-2 min-w-[140px]"
      style={{ whiteSpace: "nowrap" }}
    >
      {entry.photo && (
        <span
          className="block rounded-md overflow-hidden bg-white/5 border border-white/10"
          style={{ width: 96, height: 128 }}
        >
          <img
            src={entry.photo}
            alt={entry.name}
            className="w-full h-full object-cover"
            draggable={false}
          />
        </span>
      )}
      <span className="text-white/95 text-[12.5px] font-medium leading-tight">
        {entry.name}
      </span>
      {entry.character && (
        <span className="text-white/55 text-[11px] leading-tight italic">
          as {entry.character}
        </span>
      )}
      {tier && (
        <span className="flex flex-col items-center gap-0.5 mt-1 pt-2
                         border-t border-white/12 self-stretch">
          <span className="text-white/65 text-[10px] uppercase tracking-[0.16em]">
            {castTierLabel(tier)}
          </span>
          <span className="text-white/85 text-[11px] font-mono tabular-nums">
            {entry.episode_count} of {entry.total_show_episodes} eps
          </span>
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// SeasonAwareCastBlock — renders the detail-page cast row, swapping
// to the currently-selected season's roster when the meta carries
// `app_extras.seasonCredits`. Cross-fades on season change via a
// key + CSS opacity transition (no framer-motion dep). Each cast
// entry is enriched with `episode_count` + `total_show_episodes`
// when `aggregate_credits` is available, fueling the hover overlay's
// Main / Recurring / Guest classifier — gated by the
// `hideCastSpoilers` setting because some shows treat regular vs.
// guest billing as a plot beat.
// ---------------------------------------------------------------------------

function SeasonAwareCastBlock({
  detail, meta, selectedSeason, onClickName,
}: {
  detail: MetaDetail | null;
  meta: MetaPreview;
  selectedSeason: number | null;
  onClickName?: (name: string) => void;
}) {
  // Subscribe to settings changes so the spoiler toggle takes effect
  // immediately without remounting the detail page.
  const [hideTier, setHideTier] = useState(() => loadAuraSettings().hideCastSpoilers);
  useEffect(() => {
    const sync = () => setHideTier(loadAuraSettings().hideCastSpoilers);
    window.addEventListener("aura:settings-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("aura:settings-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const animeLike = isAnimeMeta(meta) || (detail?.media_type ?? "").toLowerCase() === "anime";
  const castLabel = animeLike && (detail?.voice_actors?.length ?? 0) === 0 ? "Voice Cast" : "Cast";

  // Diagnostic — surfaces what the React side actually got, so a
  // "cast doesn't swap on season change" report can be triaged from
  // the DevConsole. Logs once per detail change. If the addon
  // shipped seasonCredits and Rust parsed it, we'll see N keys
  // here; if N=0 the swap will be a no-op (fallback chain takes
  // over) and the bug is upstream.
  useEffect(() => {
    if (!detail) return;
    const keys = detail.season_credits ? Object.keys(detail.season_credits) : [];
    const aggCount = detail.aggregate_credits?.cast?.length ?? 0;
    console.info(
      `[meta] season_credits keys=${JSON.stringify(keys)} ` +
      `aggregate_credits cast_count=${aggCount} ` +
      `cast_detailed=${detail.cast_detailed?.length ?? 0}`,
    );
  }, [detail]);

  // Per-season fallback chain:
  //   1. seasonCredits[selectedSeason]?.cast (TMDB / TVDB)
  //   2. cast_detailed (show-level rich cast)
  //   3. plain cast names
  // Empty seasonCredits collapses straight to step 2 so the season
  // dropdown still controls episodes only.
  const seasonKey = selectedSeason != null ? String(selectedSeason) : null;
  const seasonCast =
    seasonKey != null && detail?.season_credits
      ? detail.season_credits[seasonKey]?.cast
      : undefined;
  const hasSeasonCredits = !!detail?.season_credits
    && Object.keys(detail.season_credits).length > 0;
  const baseCast: CreditEntry[] =
    (seasonCast && seasonCast.length > 0)
      ? seasonCast.map((c) => ({ name: c.name, character: c.character, photo: c.photo }))
      : (detail?.cast_detailed && detail.cast_detailed.length > 0)
        ? detail.cast_detailed.map((c) => ({ name: c.name, character: c.character, photo: c.photo }))
        : plainCredits(detail?.cast ?? []);

  // Build the aggregate-credit lookup for tier overlay. Only
  // populated when the addon shipped aggregateCredits AND the user
  // hasn't enabled hideCastSpoilers.
  const aggIndex = useMemo(() => {
    if (hideTier) return null;
    const aggCast = detail?.aggregate_credits?.cast;
    if (!aggCast || aggCast.length === 0) return null;
    const m = new Map<string, number>();
    for (const c of aggCast) m.set(c.name, c.total_episode_count);
    return m;
  }, [detail?.aggregate_credits, hideTier]);

  // Total show episodes excluding season 0 (specials). aggregate
  // credits is keyed at the show level so this is the right
  // denominator for the Main / Recurring / Guest classifier.
  const totalShowEpisodes = useMemo(() => {
    return (detail?.videos ?? [])
      .filter((v) => (v.season ?? 0) > 0)
      .length;
  }, [detail?.videos]);

  const enrichedCast: CreditEntry[] = useMemo(() => {
    if (!aggIndex || totalShowEpisodes <= 0) return baseCast;
    return baseCast.map((entry) => {
      const ep = aggIndex.get(entry.name);
      if (typeof ep !== "number" || ep <= 0) return entry;
      return { ...entry, episode_count: ep, total_show_episodes: totalShowEpisodes };
    });
  }, [baseCast, aggIndex, totalShowEpisodes]);

  if (enrichedCast.length === 0) return null;

  // Key the inner div on the season so a season change triggers a
  // remount → re-runs the CSS keyframe for the cross-fade. When
  // there are no seasonCredits we don't key by season (the cast
  // never changes — keying would still trigger spurious fades).
  const fadeKey = hasSeasonCredits ? (seasonKey ?? "default") : "static";
  return (
    <div key={fadeKey} className="aura-cast-fade">
      <CreditRow
        label={castLabel}
        values={enrichedCast}
        onClickName={onClickName}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SeasonSelect — custom popover dropdown for the episode panel's season
// picker. Replaces a native <select> for two reasons:
//
//   1. Direction control. Windows native combo-boxes open upward when
//      the trigger is near the bottom of the screen, which on a multi-
//      monitor setup with the app at the bottom of the primary display
//      stretches the popup onto a different monitor (or off-screen).
//      We always prefer downward and only flip up when there's no room
//      below (rare; the popover is short).
//   2. Visible-count cap. Native <select> shows ~30 items by default
//      on Windows; the user wants up to 10 visible with scroll for
//      anime / long-running shows. A custom list trivially caps via
//      max-height + overflow-y: auto.
//
// Behaviour:
//   • Click trigger → open popover positioned just below the trigger
//     button. Width matches the trigger.
//   • Click outside / press Escape / pick a season → close.
//   • Up/Down keys move highlight; Enter selects.
//   • Highlights the current season; clicking the same one is a no-op
//     close.
// ---------------------------------------------------------------------------

const SEASON_VISIBLE_CAP = 10;

function SeasonSelect({
  seasons, value, onChange,
}: {
  seasons: number[];
  value: number;
  onChange: (s: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(value);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<Map<number, HTMLButtonElement>>(new Map());

  const label = (s: number) => (s === 0 ? "Specials" : `Season ${s}`);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popoverRef.current?.contains(e.target as Node)) return;
      if (triggerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => {
          const idx = seasons.indexOf(h);
          const next = seasons[(idx + 1) % seasons.length];
          itemsRef.current.get(next)?.scrollIntoView({ block: "nearest" });
          return next;
        });
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => {
          const idx = seasons.indexOf(h);
          const prev = seasons[(idx - 1 + seasons.length) % seasons.length];
          itemsRef.current.get(prev)?.scrollIntoView({ block: "nearest" });
          return prev;
        });
      }
      if (e.key === "Enter") {
        e.preventDefault();
        onChange(highlight);
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, seasons, highlight, onChange]);

  // Reset highlight when opening so the cursor lands on the current season.
  useEffect(() => {
    if (!open) return;
    setHighlight(value);
    // Defer the scroll until the popover has actually mounted with the
    // current item visible — without this, scrollIntoView runs against
    // the just-mounted container before its height is final.
    requestAnimationFrame(() => {
      itemsRef.current.get(value)?.scrollIntoView({ block: "nearest" });
    });
  }, [open, value]);

  // Decide direction: prefer downward. Flip upward only when there's
  // genuinely no room below (rare given the popover caps at ~10 rows).
  // Recomputed every time the popover opens so a different season
  // count or window resize doesn't keep a stale orientation.
  const [direction, setDirection] = useState<"down" | "up">("down");
  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const itemH = 36;
    const padding = 12;
    const wantH = Math.min(seasons.length, SEASON_VISIBLE_CAP) * itemH + padding;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    if (spaceBelow >= wantH || spaceBelow >= spaceAbove) {
      setDirection("down");
    } else {
      setDirection("up");
    }
  }, [open, seasons.length]);

  const popoverStyle: React.CSSProperties = {
    maxHeight: `${SEASON_VISIBLE_CAP * 36 + 8}px`,
    minWidth: triggerRef.current?.offsetWidth ?? 160,
    ...(direction === "down" ? { top: "100%", marginTop: 4 } : { bottom: "100%", marginBottom: 4 }),
  };

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="bg-black/45 border border-white/16 rounded-lg px-5 py-2.5
                   text-[16px] font-mono tracking-wide outline-none
                   focus:border-ln-accent/45 transition-colors cursor-pointer
                   appearance-none pr-10 inline-flex items-center"
        style={{
          color: "var(--text-primary)",
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='rgba(255,255,255,0.55)'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 10px center",
        }}
      >
        {label(value)}
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="listbox"
          className="absolute left-0 z-40 overflow-y-auto
                     bg-black/85 backdrop-blur-2xl
                     border border-white/15 rounded-lg
                     shadow-[0_18px_48px_-12px_rgba(0,0,0,0.85)]
                     py-1"
          style={{ ...popoverStyle, scrollbarWidth: "thin",
                   scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          {seasons.map((s) => {
            const isActive    = s === value;
            const isHighlight = s === highlight;
            return (
              <button
                key={s}
                ref={(el) => {
                  if (el) itemsRef.current.set(s, el);
                  else    itemsRef.current.delete(s);
                }}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onChange(s);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                onMouseEnter={() => setHighlight(s)}
                className={`block w-full text-left px-4 py-2 text-[14px] font-mono tracking-wide
                            transition-colors
                            ${isActive ? "text-ln-accent" : "text-white/85"}
                            ${isHighlight ? "bg-white/10" : "hover:bg-white/8"}`}
              >
                {label(s)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// UnifiedPanel — the compact RIGHT column. Swaps between Episodes and Streams.
// ---------------------------------------------------------------------------

interface PanelProps {
  mode: PanelMode;
  isEpisodic: boolean;
  seriesId: string;
  /** "series" / "anime" — drives the meta-cache URL lookup that
   *  EpisodeRow's auto-advance uses to find the next episode. */
  seriesMediaType: string;
  videos: VideoEntry[];
  activeVideo: VideoEntry | null;
  streams: StreamEntry[];
  streamMeta: StreamMetadata;
  streamsLoading: boolean;
  groupedStreams: [string, StreamEntry[]][];
  /** True while the parent's meta-detail fetch is still in flight
   *  with no addon having returned yet. Lets the EpisodesPanel
   *  render a shimmer skeleton instead of the "No episode list
   *  returned" message — cold-cache anime with 1000+ episodes can
   *  take 10-30 s to resolve on the first open and the previous
   *  empty-state read as "broken". */
  metaLoading: boolean;
  onPickEpisode: (v: VideoEntry) => void;
  onBackToEpisodes: () => void;
  onPlay: (s: StreamEntry) => void;
  onCopy: (text: string) => void;
  onPlayExternal: (url: string) => void;
  /** When provided, the EpisodesPanel scrolls this id to the top of the
   *  list on mount and pre-selects the matching season. */
  scrollToVideoId?: string | null;
  /** Fires once the EpisodesPanel actually anchored the requested row.
   *  Lets the parent clear `scrollToVideoId` so a later season change
   *  (or videos arriving asynchronously) doesn't keep re-scrolling. */
  onScrollHandled?: () => void;
  /** Season parsed from the catalog entry's title — forwarded to
   *  EpisodesPanel so e.g. "Dorohedoro Season 2" opens on season 2. */
  seasonHint?: number | null;
}

function UnifiedPanel({
  mode, isEpisodic, seriesId, seriesMediaType, videos, activeVideo, streams, streamMeta, streamsLoading,
  groupedStreams, metaLoading, onPickEpisode, onBackToEpisodes, onPlay, onCopy, onPlayExternal,
  scrollToVideoId, onScrollHandled, seasonHint,
}: PanelProps) {
  // The streams panel needs `position: relative` so the floating AIOStreams
  // status icons (rendered with `absolute -top-3 -left-3`) anchor to its
  // top-left edge instead of escaping the entire detail view.
  return (
    // Border replaced with a soft alpha-fade mask so the panel's outer
    // edges blend into the page background rather than stamping a hard
    // rectangle. Fades are kept small (1-1.5 %) so the header text and
    // bottom chip row sit in the fully-opaque region — earlier 4 % top
    // fade was clipping the EPISODES title underneath the blur. The
    // shadow handles most of the elevation feel against bright backdrops.
    <div
      className="relative flex flex-col h-full rounded-xl
                 bg-black/60 backdrop-blur-2xl
                 shadow-[0_24px_48px_-18px_rgba(0,0,0,0.7)]
                 [overflow:visible]"
      style={{
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, black 1.5%, black 98.5%, transparent 100%), " +
          "linear-gradient(to right, transparent 0%, black 1%, black 99%, transparent 100%)",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, black 1.5%, black 98.5%, transparent 100%), " +
          "linear-gradient(to right, transparent 0%, black 1%, black 99%, transparent 100%)",
        WebkitMaskComposite: "source-in" as React.CSSProperties["WebkitMaskComposite"],
        maskComposite: "intersect",
      }}
    >
      {mode === "episodes" ? (
        <div className="flex flex-col h-full overflow-hidden rounded-xl">
          <EpisodesPanel
            seriesId={seriesId}
            seriesMediaType={seriesMediaType}
            videos={videos}
            activeVideo={activeVideo}
            onPick={onPickEpisode}
            scrollToVideoId={scrollToVideoId}
            onScrollHandled={onScrollHandled}
            metaLoading={metaLoading}
            seasonHint={seasonHint}
          />
        </div>
      ) : (
        <>
          <div className="flex flex-col h-full overflow-hidden rounded-xl">
            <StreamsPanel
              isEpisodic={isEpisodic}
              activeVideo={activeVideo}
              streams={streams}
              streamMeta={streamMeta}
              loading={streamsLoading}
              groups={groupedStreams}
              onBack={isEpisodic ? onBackToEpisodes : undefined}
              onPlay={onPlay}
              onCopy={onCopy}
              onPlayExternal={onPlayExternal}
            />
          </div>
          {/* Notice badges have moved OUT of UnifiedPanel — they're
              rendered at the aside level by the parent (DetailViewBody)
              because UnifiedPanel's CSS mask gradient was making
              negatively-positioned children invisible. See the
              corresponding render block in DetailViewBody. */}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EpisodeRow — single episode card. Shows thumbnail with optional progress
// overlay, episode number (no S## prefix per the redesign), release date,
// title, overview, and a watched check on the bottom-right of the thumb.
// ---------------------------------------------------------------------------

const EpisodeRow = ({
  video, seriesId, seriesMediaType, isActive, onPick, seasonVideos,
}: {
  video: VideoEntry;
  seriesId: string;
  /** "series" / "anime" — forwarded into the auto-advance event so the
   *  meta-cache lookup hits the right URL path. */
  seriesMediaType: string;
  isActive: boolean;
  onPick: (v: VideoEntry) => void;
  /** All episodes in the currently-displayed season, in episode order.
   *  Drives the "this & above / below / all" right-click bulk options. */
  seasonVideos: VideoEntry[];
}) => {
  const progress = useEpisodeProgress(seriesId, video.id);
  const watchedVariant = useWatchedVariant(video.id);
  // Release-search signal for this series — used to surface fresher
  // filler/recap flags than VideoEntry alone carries. Same hook
  // call shape across every EpisodeRow sibling; useSyncExternalStore
  // dedupes the subscription bookkeeping.
  const cloudSignal = useReleaseSignal(seriesId);

  // Anti-spoiler thumbnail blur. Subscribe to settings changes so the
  // toggle applies immediately without remounting the detail page.
  const [blurEnabled, setBlurEnabled] = useState(() => loadAuraSettings().blurUnwatchedThumbnails);
  useEffect(() => {
    const sync = () => setBlurEnabled(loadAuraSettings().blurUnwatchedThumbnails);
    window.addEventListener("aura:settings-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("aura:settings-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const isWatched = watchedVariant === "watched";
  // Blur lifts on watched (manual mark OR auto-derived from progress >= 0.9
  // via useWatchedVariant). The transition makes the un-blur feel
  // intentional when the user marks an episode watched.
  const shouldBlur = blurEnabled && !isWatched;

  return (
    <button
      onClick={() => onPick(video)}
      onContextMenu={(e) => {
        // Right-click an episode → mark/unmark menu. The mark stores
        // against the EPISODE id, so a series can have a mix of
        // watched + in-progress + unmarked episodes.
        //
        // Bulk options ("this & below", "this & above", "all") are
        // surfaced only when they would actually change the state of
        // at least one OTHER episode beyond the selected one — so
        // there's no redundant "Unmark this & below" sitting next to
        // a plain "Unmark watched" when no episodes below are watched.
        e.preventDefault();
        const x = e.clientX;
        const y = e.clientY;
        const manual = getManualWatchedState(video.id);
        const isWatched  = manual === "watched";
        const isProgress = manual === "in-progress";
        const epLabel = video.episode != null
          ? `Episode ${video.episode}`
          : video.title || "Episode";

        const idx       = seasonVideos.findIndex((v) => v.id === video.id);
        const aboveSet  = idx > 0
          ? seasonVideos.slice(0, idx + 1)              // includes selected
          : [];                                          // empty → no "above" options
        const belowSet  = idx >= 0 && idx < seasonVideos.length - 1
          ? seasonVideos.slice(idx)                     // includes selected
          : [];                                          // empty → no "below" options
        const allSet    = seasonVideos;
        const otherIds  = (set: VideoEntry[]) =>
          set.filter((v) => v.id !== video.id).map((v) => v.id);
        const anyOtherUnwatched = (set: VideoEntry[]) =>
          otherIds(set).some((id) => getManualWatchedState(id) !== "watched");
        const anyOtherWatched   = (set: VideoEntry[]) =>
          otherIds(set).some((id) => getManualWatchedState(id) === "watched");

        const checkIcon = (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        );

        const bulkAction = (
          set: VideoEntry[],
          state: "watched" | null,
          rangeLabel: string,
        ) => () => {
          // When marking watched, exclude episodes that haven't
          // aired yet — same rule as the catalog-level fan-out in
          // App.tsx. Un-marking passes the full set through so it
          // can reach any future-episode marks a previous build
          // wrote before this guard existed.
          const targets = state === "watched" ? set.filter(isVideoAired) : set;
          const ids = targets.map((v) => v.id);
          setManualWatchedMany(ids, state);
          showFlyUpToast(
            state ? `Marked watched · ${rangeLabel}` : `Unmarked · ${rangeLabel}`,
            { x, y, tone: state ? "success" : "default" },
          );
        };

        type Item = Parameters<typeof openContextMenu>[2][number];

        // Bulk "watched" variants — collected as a sub-list so they can
        // hang off "Mark as Watched" as a hover-submenu instead of
        // cluttering the parent menu. Each entry is gated on "does this
        // bulk operation actually change anything" so a fully-watched
        // season doesn't show "Mark all as watched" with no effect.
        const bulkItems: Item[] = [];
        if (belowSet.length > 0 && anyOtherUnwatched(belowSet)) {
          bulkItems.push({
            kind: "action",
            label: "Mark this & below as watched",
            tone: "success",
            icon: checkIcon,
            onClick: bulkAction(belowSet, "watched", "this & below"),
          });
        }
        if (belowSet.length > 0 && anyOtherWatched(belowSet)) {
          bulkItems.push({
            kind: "action",
            label: "Unmark this & below as watched",
            icon: checkIcon,
            onClick: bulkAction(belowSet, null, "this & below"),
          });
        }
        if (aboveSet.length > 0 && anyOtherUnwatched(aboveSet)) {
          bulkItems.push({
            kind: "action",
            label: "Mark this & above as watched",
            tone: "success",
            icon: checkIcon,
            onClick: bulkAction(aboveSet, "watched", "this & above"),
          });
        }
        if (aboveSet.length > 0 && anyOtherWatched(aboveSet)) {
          bulkItems.push({
            kind: "action",
            label: "Unmark this & above as watched",
            icon: checkIcon,
            onClick: bulkAction(aboveSet, null, "this & above"),
          });
        }
        if (allSet.length > 1 && allSet.some((v) => getManualWatchedState(v.id) !== "watched")) {
          bulkItems.push({
            kind: "action",
            label: "Mark all as watched",
            tone: "success",
            icon: checkIcon,
            onClick: bulkAction(allSet, "watched", "all in season"),
          });
        }
        if (allSet.length > 1 && allSet.some((v) => getManualWatchedState(v.id) === "watched")) {
          bulkItems.push({
            kind: "action",
            label: "Unmark all as watched",
            icon: checkIcon,
            onClick: bulkAction(allSet, null, "all in season"),
          });
        }

        const items: Item[] = [
          {
            kind: "action",
            label: isWatched ? "Unmark Watched" : "Mark as Watched",
            tone: "success",
            icon: checkIcon,
            onClick: () => {
              const next = isWatched ? null : "watched";
              setManualWatchedState(video.id, next);
              showFlyUpToast(
                next ? `Marked watched · ${epLabel}` : `Unmarked · ${epLabel}`,
                { x, y, tone: next ? "success" : "default" },
              );
              // Transition into "watched" → auto-advance to the next
              // episode (or mark series complete if this was the last).
              // Reverse direction (unmark) doesn't trigger advance.
              if (next === "watched") {
                window.dispatchEvent(new CustomEvent("aura:auto-advance-watched", {
                  detail: { seriesId, episodeId: video.id, mediaType: seriesMediaType },
                }));
              }
            },
            // Hover-submenu carries the bulk variants — click the parent
            // for the single-episode action, hover for the season-wide
            // operations. Omitted when no bulk operation would have an
            // effect (already-handled inside bulkItems gating).
            submenu: bulkItems.length > 0 ? bulkItems : undefined,
          },
          {
            kind: "action",
            label: isProgress ? "Unmark In Progress" : "Mark as In Progress",
            tone: "warning",
            icon: <span className="inline-block w-[10px] h-[10px] rounded-full bg-current" />,
            onClick: () => {
              const next = isProgress ? null : "in-progress";
              setManualWatchedState(video.id, next);
              showFlyUpToast(
                next ? `Marked in progress · ${epLabel}` : `Unmarked · ${epLabel}`,
                { x, y, tone: next ? "success" : "default" },
              );
            },
            // No bulk in-progress semantic exists today — keep the row
            // a flat action. If users start asking for "mark this & below
            // as in-progress" (rare for binge planning), add a submenu
            // shape here mirroring the Watched parent.
          },
        ];

        openContextMenu(x, y, items);
      }}
      className={`hover-glow w-full text-left flex items-stretch gap-4 px-3 py-3.5 rounded-md
                  border
                  ${isActive
                    ? "bg-ln-accent/15 border-ln-accent/40"
                    : "border-transparent hover:bg-white/6 border-white/0"}`}
    >
      <div
        className="relative flex-shrink-0 w-40 rounded overflow-hidden bg-white/5 border border-white/10"
        style={{ aspectRatio: "16 / 9" }}
      >
        {video.thumbnail ? (
          <ImageLoader
            src={video.thumbnail}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName={`w-full h-full object-cover transition-[filter] duration-300
                           ${shouldBlur ? "blur-md scale-110" : ""}`}
          />
        ) : null}
        {/* Anti-spoiler veil — slight darken under the blur so the rest
            of the row's text reads cleanly against bright thumbnails.
            Fades alongside the blur. */}
        {shouldBlur && video.thumbnail && (
          <div
            aria-hidden
            className="absolute inset-0 bg-black/30 transition-opacity duration-300"
          />
        )}

        {/* Watched / in-progress badge — top-LEFT, matches catalog
            card placement. Combines manual marks for THIS episode id
            with library-derived progress (state.timeOffset for the
            currently-tracked episode). */}
        <WatchedBadge
          metaId={video.id}
          className="absolute top-1.5 left-1.5"
        />

        {/* Filler / recap banners — top-RIGHT of the thumbnail. Two
            independent flags (an episode can be BOTH filler AND
            recap, per release-search-spec §6.3). Render up to two
            stacked badges. Sources merged in priority order so the
            freshest data wins:
              1. Aura Cloud release signal's `episode_kinds` for this
                 video id (the cloud's poll cadence is faster than the
                 user's library refresh, so it sees AIOMetadata
                 updates first).
              2. VideoEntry's `is_filler` / `is_recap` booleans
                 (canonical AIOMetadata wire shape).
              3. Legacy `episode_kind` single-string field (older
                 AIOMetadata responses pre-spec).
            Filler = rose (skip-worthy), recap = amber (informational).
            Canon / normal / mixed render nothing. */}
        {(() => {
          const cloudKinds = cloudSignal?.episode_kinds ?? [];
          const cloudForThis = cloudKinds.filter((k) => k.id === video.id);
          const cloudFiller = cloudForThis.some((k) => k.kind === "filler");
          const cloudRecap  = cloudForThis.some((k) => k.kind === "recap");
          const showFiller = cloudFiller || !!video.is_filler || video.episode_kind === "filler";
          const showRecap  = cloudRecap  || !!video.is_recap  || video.episode_kind === "recap";
          if (!showFiller && !showRecap) return null;
          return (
            <div className="absolute top-1.5 right-1.5 flex flex-col gap-1 items-end">
              {showFiller && (
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-[0.14em] uppercase
                             border bg-rose-500/85 text-white border-rose-300/30
                             shadow-[0_2px_6px_rgba(244,63,94,0.4)]"
                >
                  filler
                </span>
              )}
              {showRecap && (
                <span
                  className="px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-[0.14em] uppercase
                             border bg-amber-400/85 text-amber-950 border-amber-200/40
                             shadow-[0_2px_6px_rgba(251,191,36,0.4)]"
                >
                  recap
                </span>
              )}
            </div>
          );
        })()}

        {/* Progress overlay — bottom of the thumbnail when partially watched. */}
        {progress?.partial && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/55">
            <div
              className="h-full bg-ln-accent"
              style={{ width: `${progress.ratio * 100}%` }}
            />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col py-1 justify-center gap-1.5">
        <p className="flex items-baseline gap-3 font-mono text-[14px] tracking-[0.16em] uppercase">
          <span className={isActive ? "text-ln-accent" : "text-white/65"}>
            {video.episode != null
              ? `E${String(video.episode).padStart(2, "0")}`
              : "EP"}
          </span>
          {video.released && (
            <span className="text-white/45">
              {new Date(video.released).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </span>
          )}
        </p>
        <p className={`text-[19px] leading-snug font-medium line-clamp-2
                       ${isActive ? "text-white" : "text-white/95"}`}>
          {video.title}
        </p>
      </div>
    </button>
  );
};


// ---------------------------------------------------------------------------
// EpisodesPanel — season dropdown + scrollable episode list.
// ---------------------------------------------------------------------------

function EpisodesPanel({
  seriesId, seriesMediaType, videos, activeVideo, onPick, scrollToVideoId, onScrollHandled,
  metaLoading, seasonHint,
}: {
  seriesId: string;
  seriesMediaType: string;
  videos: VideoEntry[];
  metaLoading?: boolean;
  activeVideo: VideoEntry | null;
  onPick: (v: VideoEntry) => void;
  scrollToVideoId?: string | null;
  onScrollHandled?: () => void;
  /** Season parsed from the catalog entry's title (e.g. "Dorohedoro
   *  Season 2" → 2). Selected on open when that season actually exists
   *  in the cour-aggregated videos, UNLESS a resume / just-played
   *  target (scrollToVideoId) already pins a season — that wins. */
  seasonHint?: number | null;
}) {
  const seasons = useMemo(() => {
    const set = new Set<number>();
    for (const v of videos) if (v.season != null) set.add(v.season);
    return [...set].sort((a, b) => a - b);
  }, [videos]);

  // When the parent hands us a `scrollToVideoId`, prefer the season of
  // THAT video over the default "first non-special season" pick — the
  // user just exited playback on it; landing on a different season
  // would defeat the whole point.
  //
  // Routed through resolveResumeEpisode so stale-shape ids (legacy
  // library entries written before cour aggregation) still anchor to
  // the right cour. The resolved id is what the scroll DOM query
  // actually looks up below, so this matches the row in the rendered
  // list too.
  const resolvedScrollTarget = useMemo(
    () => resolveResumeEpisode(scrollToVideoId, videos),
    [videos, scrollToVideoId],
  );
  const targetSeason = resolvedScrollTarget?.season ?? null;
  const resolvedScrollId = resolvedScrollTarget?.id ?? null;

  // Priority: resume / just-played season (targetSeason) > catalog
  // title season (seasonHint, only if that cour actually exists in the
  // aggregated videos) > first non-special season.
  const [season, setSeason] = useState<number>(() => {
    if (targetSeason != null) return targetSeason;
    if (seasonHint != null && seasons.includes(seasonHint)) return seasonHint;
    const main = seasons.find((s) => s > 0);
    return main ?? seasons[0] ?? 1;
  });

  // Retarget when targetSeason becomes available AFTER mount. The
  // useState initializer above only sees what's available at the
  // moment EpisodesPanel mounts — if the parent's meta-detail fetch
  // is still in flight when we mount, `videos` is empty and
  // `targetSeason` evaluates to null. Without this effect we'd land
  // on S1 by default and stay there even when the just-played
  // episode belongs to S2 (visible with cour-aggregated anime like
  // Frieren returning from S2E09).
  //
  // The ref gates "consume once" so a later user-driven season pick
  // doesn't get clobbered by a stale targetSeason value when
  // scrollToVideoId hasn't been cleared yet.
  const hasAppliedTargetSeasonRef = useRef(false);
  useEffect(() => {
    if (hasAppliedTargetSeasonRef.current) return;
    if (targetSeason == null) return;
    hasAppliedTargetSeasonRef.current = true;
    if (season !== targetSeason) setSeason(targetSeason);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetSeason]);

  // Same late-arrival retarget for the catalog-title season. Cold-cache
  // anime resolve `videos` 10-30 s after mount, so the initializer
  // above saw an empty `seasons` and couldn't honour the hint yet.
  // Yields to a resume / just-played target (those flow through
  // targetSeason) so "open Dorohedoro Season 2" still defers to "you
  // were watching S1E5" when both are present. Consume-once via the
  // ref so a later user season pick isn't clobbered.
  const hasAppliedSeasonHintRef = useRef(false);
  useEffect(() => {
    if (hasAppliedSeasonHintRef.current) return;
    if (hasAppliedTargetSeasonRef.current) return;
    if (targetSeason != null) return;
    if (seasonHint == null) return;
    if (!seasons.includes(seasonHint)) return;
    hasAppliedSeasonHintRef.current = true;
    setSeason((cur) => (cur === seasonHint ? cur : seasonHint));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seasonHint, seasons, targetSeason]);

  useEffect(() => {
    if (seasons.length === 0) return;
    if (!seasons.includes(season)) {
      const main = seasons.find((s) => s > 0);
      setSeason(main ?? seasons[0]);
    }
  }, [seasons, season]);

  // Notify the detail-page cast block of the active season so it can
  // swap to seasonCredits[season].cast. Decoupled via a CustomEvent
  // (rather than prop-drilled callback) because the cast block lives
  // in DetailView's left column while the season state lives down
  // here in EpisodesPanel — wiring a callback through UnifiedPanel's
  // many props for a single boolean dispatch is more churn than it's
  // worth.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("aura:detail-season-changed", {
      detail: { season },
    }));
  }, [season]);

  const inSeason = useMemo(() => {
    const list = seasons.length === 0
      ? [...videos]
      : videos.filter((v) => (v.season ?? 0) === season);
    list.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    return list;
  }, [videos, season, seasons.length]);

  // Scroll the requested video to the top of the list once it's
  // present in the DOM. We retry on a short tick because `videos` may
  // be empty on first mount (meta hasn't resolved yet) and the row
  // appears a moment later.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Prefer the resolved id (handles stale-shape library entries via
    // the tuple / absolute fallback in resolveResumeEpisode). Falls
    // back to scrollToVideoId when no resolution is available — that
    // path is unlikely to find a row, but it preserves the original
    // behavior for current-shape ids the helper hasn't yet resolved
    // (e.g. before `videos` arrived).
    const targetId = resolvedScrollId ?? scrollToVideoId;
    if (!targetId) return;
    const list = listRef.current;
    if (!list) return;
    let done = false;
    const tryScroll = () => {
      if (done) return true;
      const row = list.querySelector<HTMLElement>(
        `[data-episode-id="${CSS.escape(targetId)}"]`,
      );
      if (!row) return false;
      // scrollTop math: anchor the row to the top of the scroll viewport.
      // If the row is past the natural bottom (last episode), the
      // scroll value clamps and the row stays highlighted — exactly the
      // "if can't scroll any further, keep highlighted" fallback the
      // user asked for.
      list.scrollTop = row.offsetTop - list.offsetTop;
      done = true;
      // Tell the parent we honoured the hint so it can clear it. We
      // schedule the callback in a microtask to avoid setting parent
      // state synchronously inside our own effect (React would warn).
      Promise.resolve().then(() => onScrollHandled?.());
      return true;
    };
    // Allow one paint cycle for the rows to mount, then start polling
    // every 80 ms in case meta is still streaming. Bounded at 3 s so a
    // missing-episode case doesn't leak the timer.
    const raf = requestAnimationFrame(() => { tryScroll(); });
    const interval = setInterval(() => {
      if (tryScroll()) clearInterval(interval);
    }, 80);
    const stop = setTimeout(() => clearInterval(interval), 3000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
      clearTimeout(stop);
    };
  }, [scrollToVideoId, resolvedScrollId, season, inSeason.length, onScrollHandled]);

  return (
    <>
      <PanelHeader
        title="Episodes"
        right={`${videos.length} total`}
      />
      <div className="pl-5 pr-4 py-3 flex-1 min-h-0 flex flex-col">
        {videos.length === 0 && metaLoading ? (
          // Cold-cache meta fetch in flight. AIOMetadata's cour-
          // aggregated walker can take 10-30 s on 1000+ ep shows
          // (One Piece, Naruto, Detective Conan) because it has to
          // hit each cour's kitsu-anime-* cache and merge. Surface
          // an animated skeleton so the user knows the page is
          // still loading instead of being broken — previously
          // this rendered "No episode list returned by the addon"
          // which was misleading.
          <div className="space-y-3" aria-label="Loading episodes" role="status">
            <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/55 to-transparent animate-pulse" />
            <p className="text-white/55 text-[12px] italic">
              Loading episodes — this can take a moment for long-running anime.
            </p>
            {/* Row-shaped skeleton placeholders. 5 rows is enough to
                signal "list is coming" without dominating the panel,
                and the pulse keeps the eye engaged so the wait
                doesn't feel hung. */}
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="flex items-stretch gap-4 px-3 py-3.5 rounded-md
                           border border-transparent"
              >
                <div
                  className="w-40 rounded bg-white/8 animate-pulse"
                  style={{ aspectRatio: "16 / 9" }}
                />
                <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
                  <div className="h-3 w-20 rounded bg-white/8 animate-pulse" />
                  <div className="h-4 w-3/4 rounded bg-white/8 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        ) : videos.length === 0 ? (
          <p className="text-white/50 text-[13px] italic">
            No episode list returned by the addon.
          </p>
        ) : (
          <>
            {/* Season dropdown — visually centred horizontally with the
                episode count anchored to its right. The wrapper is a
                relative-positioned row: the dropdown sits in the middle
                via flex centring, the count is absolutely positioned to
                the right edge so the dropdown stays optically centred
                regardless of how many episodes the season has. */}
            {seasons.length > 1 && (
              <div className="relative flex items-center justify-center mb-4">
                <SeasonSelect
                  seasons={seasons}
                  value={season}
                  onChange={setSeason}
                />
                <span className="absolute right-1 text-white/45 text-[13px] font-mono tracking-wider">
                  {inSeason.length} {inSeason.length === 1 ? "ep" : "eps"}
                </span>
              </div>
            )}

            {/* Episode list — typography +25 % vs previous, thumbs +25 %.
                Padding on every side gives the rotating hover-glow
                (~14 px blur + 6 px offset) full clearance from the
                panel edges, including above the first row and below
                the last so neither gets clipped. */}
            <div
              ref={listRef}
              className="flex-1 min-h-0 overflow-y-auto px-3 pt-3 pb-4 space-y-1.5"
              style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
            >
              {inSeason.map((v) => (
                <div key={v.id} data-episode-id={v.id}>
                  <EpisodeRow
                    video={v}
                    seriesId={seriesId}
                    seriesMediaType={seriesMediaType}
                    isActive={activeVideo?.id === v.id}
                    onPick={onPick}
                    seasonVideos={inSeason}
                  />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// StreamsPanel — full-info stream list with parsed chips. ~30% bigger than 5.6.
// ---------------------------------------------------------------------------

// AIOStreams' internal cap before it returns whatever it has accumulated:
//   • movies / anime movies   →  7 s
//   • series / anime series   → 12 s
// We mirror those so the loader's brightness ramp finishes right when
// streams should land, regardless of media type.
const CAP_MOVIE_SECONDS  = 7;
const CAP_SERIES_SECONDS = 12;

// ---------------------------------------------------------------------------
// AIOStreams metadata UI — floating status icons + empty-state message list.
//
// AIOStreams returns four optional arrays alongside `streams` (errors,
// warnings, info, statistics). When streams DO exist we render up to four
// small floating icons anchored at the panel's outside top-left edge —
// hovering one reveals the relevant messages in a glass tooltip. When
// streams.length === 0 the messages take over the panel's empty-state body
// so the user sees WHY the list is empty.
// ---------------------------------------------------------------------------

type MessageKind = "error" | "warning" | "info" | "stats";

interface MessageKindStyle {
  /** Tailwind classes for the floating icon button. */
  iconBtn: string;
  /** Tailwind classes for the inline empty-state badge. */
  inlineBg: string;
  inlineFg: string;
  inlineBorder: string;
  /** Human label for accessibility / tooltip header. */
  label: string;
}

const KIND_STYLES: Record<MessageKind, MessageKindStyle> = {
  error: {
    iconBtn:      "bg-red-500/25 border-red-400/55 text-red-200 shadow-[0_0_12px_rgba(248,113,113,0.35)]",
    inlineBg:     "bg-red-500/12",
    inlineFg:     "text-red-200",
    inlineBorder: "border-red-400/35",
    label:        "Error",
  },
  // The "warning" bucket on AIOStreams is overwhelmingly used for
  // filter / hidden-stream notices ("X streams hidden by your filter
  // settings"), not actual warnings — render it as a filter affordance
  // (magnifying glass + indigo) so users read it as informational
  // filtering metadata rather than as something needing attention.
  warning: {
    iconBtn:      "bg-indigo-500/25 border-indigo-300/55 text-indigo-100 shadow-[0_0_12px_rgba(129,140,248,0.35)]",
    inlineBg:     "bg-indigo-500/12",
    inlineFg:     "text-indigo-200",
    inlineBorder: "border-indigo-400/35",
    label:        "Filter",
  },
  info: {
    iconBtn:      "bg-sky-500/25 border-sky-300/55 text-sky-100 shadow-[0_0_12px_rgba(56,189,248,0.30)]",
    inlineBg:     "bg-sky-500/12",
    inlineFg:     "text-sky-200",
    inlineBorder: "border-sky-400/35",
    label:        "Info",
  },
  stats: {
    iconBtn:      "bg-white/12 border-white/30 text-white/85",
    inlineBg:     "bg-white/8",
    inlineFg:     "text-white/80",
    inlineBorder: "border-white/20",
    label:        "Stats",
  },
};

/** Heroicons-ish set, drawn inline so we don't pull a new dep. All sized
 *  16×16, currentColor — colour comes from the parent button. */
const ICONS: Record<MessageKind, ReactElement> = {
  error: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm.75 4.25a.75.75 0 00-1.5 0v4.5a.75.75 0 001.5 0v-4.5zM10 15a1 1 0 100-2 1 1 0 000 2z" />
    </svg>
  ),
  warning: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path fillRule="evenodd" clipRule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z" />
    </svg>
  ),
  info: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 5a1 1 0 110-2 1 1 0 010 2zm.75 2.5a.75.75 0 00-1.5 0v4.5a.75.75 0 001.5 0V9.5z" />
    </svg>
  ),
  stats: (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
      <path d="M3 3.5A1.5 1.5 0 014.5 2h11A1.5 1.5 0 0117 3.5v13a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 16.5v-13zM6 14a.75.75 0 001.5 0V9a.75.75 0 00-1.5 0v5zm3.25.75A.75.75 0 0010 14V6a.75.75 0 00-1.5 0v8a.75.75 0 00.75.75zM12 14a.75.75 0 001.5 0v-3a.75.75 0 00-1.5 0v3z" />
    </svg>
  ),
};

const KIND_ORDER: MessageKind[] = ["error", "warning", "info", "stats"];

/** Floating cluster of 1–4 status icons anchored OUTSIDE the panel's top-left
 *  corner. Each icon corresponds to a non-empty message kind and reveals the
 *  relevant rows in a hover tooltip. Honors the `showAioStreamsNotices`
 *  setting — when off, only entries flagged `forced=true` by the addon
 *  surface, so user toggles can never silently suppress the
 *  un-suppressible warnings (Digital Release Filter, disabled-stream-types
 *  removal reasons, etc.). */
function StreamMetaBadges({
  metadata,
  anchorRef,
  entered,
}: {
  metadata: StreamMetadata;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** True once DetailView's entrance transform has settled. Measuring
   *  the anchor before that captures the mid-animation (scaled toward
   *  centre) rect; on a cached re-entry the badges mount DURING that
   *  transition, so without this gate the cluster freezes near screen
   *  centre and never recovers (a parent transform doesn't resize the
   *  aside, so the ResizeObserver below never re-fires). */
  entered: boolean;
}) {
  // Subscribe to the visibility toggle so flipping it in Settings takes
  // effect without remounting the detail page.
  const [showAll, setShowAll] = useState(() => loadAuraSettings().showAioStreamsNotices);
  useEffect(() => {
    const sync = () => setShowAll(loadAuraSettings().showAioStreamsNotices);
    window.addEventListener("aura:settings-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("aura:settings-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Position relative to the streams-panel aside. Recomputed on resize
  // and on scroll bubbling (capture phase, so any ancestor scroll counts).
  // Bottom-left anchored: 48 px outside the panel's left edge (extra gap
  // beyond the panel's mask gradient so the cluster never crowds the
  // stream rows) and floating 16 px above the panel's bottom edge so the
  // cluster grows upward without colliding with the title/header band.
  const [pos, setPos] = useState<{ left: number; bottom: number; ready: boolean }>({
    left: 0, bottom: 0, ready: false,
  });

  const reposition = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left:   r.left - 48,
      bottom: window.innerHeight - r.bottom + 16,
      ready:  true,
    });
  }, [anchorRef]);

  useLayoutEffect(() => {
    // Don't anchor while the entrance transform is still running — the
    // measured rect would be the animating (centre-scaled) one, and
    // nothing re-fires once it settles (a parent transform doesn't
    // change the aside's border-box, so the ResizeObserver below stays
    // silent). `entered` flips after the root transform's transitionend
    // (or the fallback timeout in DetailViewBody).
    if (!entered) return;
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    // ResizeObserver — covers panel resizes that don't fire window resize
    // (e.g. layout shifts as detail content loads).
    const el = anchorRef.current;
    const ro = el ? new ResizeObserver(reposition) : null;
    if (ro && el) ro.observe(el);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      ro?.disconnect();
    };
  }, [entered, reposition, anchorRef]);

  const filterBucket = (rows: StreamMessage[]): StreamMessage[] =>
    showAll ? rows : rows.filter((r) => r.forced === true);

  const allBuckets: { kind: MessageKind; rows: StreamMessage[] }[] = [
    { kind: "error",   rows: filterBucket(metadata.errors)   },
    { kind: "warning", rows: filterBucket(metadata.warnings) },
    { kind: "info",    rows: filterBucket(metadata.info)     },
    { kind: "stats",   rows: filterBucket(metadata.stats)    },
  ];
  const buckets = allBuckets.filter((b) => b.rows.length > 0);

  if (buckets.length === 0) return null;

  return createPortal(
    <div
      className="fixed z-[290] pointer-events-auto flex flex-col gap-1.5"
      role="status"
      aria-label="Addon status messages"
      style={{
        left:    pos.left,
        bottom:  pos.bottom,
        opacity: pos.ready ? 1 : 0,
      }}
    >
      {buckets.map(({ kind, rows }) => (
        <StreamMetaBadge key={kind} kind={kind} rows={rows} />
      ))}
    </div>,
    document.body,
  );
}

function StreamMetaBadge({ kind, rows }: { kind: MessageKind; rows: StreamMessage[] }) {
  const style = KIND_STYLES[kind];
  const btnRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    // Small delay so the cursor can travel from the badge across the
    // gap into the popover without dismissing it.
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={`${rows.length} ${style.label.toLowerCase()}${rows.length === 1 ? "" : "s"} from addons`}
        aria-expanded={open}
        onMouseEnter={() => { cancelClose(); setOpen(true); }}
        onMouseLeave={scheduleClose}
        onFocus={() => { cancelClose(); setOpen(true); }}
        onBlur={scheduleClose}
        // Disable the parent <button> click — we don't want the badge to
        // bubble up as a "play stream" trigger if it's ever nested.
        onClick={(e) => e.stopPropagation()}
        className={`flex items-center gap-1 px-1.5 py-1 rounded-full
                    backdrop-blur-xl border transition-transform
                    hover:scale-110 focus:outline-none focus:ring-2 focus:ring-white/30
                    ${style.iconBtn}`}
      >
        {ICONS[kind]}
        <span className="text-[10px] font-mono font-bold leading-none pr-0.5 tabular-nums">
          {rows.length}
        </span>
      </button>
      {open && (
        <NoticePopover
          anchorRef={btnRef}
          kind={kind}
          rows={rows}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// NoticePopover — portal-based, fixed-position popover for an AIOStreams
// notice icon. Anchors to the LEFT of the trigger by default (stays in the
// gutter, doesn't intersect the streams list). Falls back to RIGHT if there
// isn't room on the left. Position is recomputed on scroll/resize.
//
// Why portal: the trigger lives inside an <aside> with overflowY:hidden and
// inside parents with CSS mask gradients (UnifiedPanel) that historically
// clipped the inline popover. Rendering into document.body escapes ALL of
// that — the popover is laid out in viewport coordinates and can't be cut
// off by ancestor overflow.
//
// Why pointer-events-auto + onWheel.stopPropagation: the user wanted scroll
// inside the popover to take priority when they're hovering it, rather than
// the underlying streams list scrolling under it. `overscroll-behavior:
// contain` keeps the inner scroll from chaining out once the inner content
// reaches its bounds.
// ---------------------------------------------------------------------------

interface NoticePopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  kind: MessageKind;
  rows: StreamMessage[];
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function NoticePopover({ anchorRef, kind, rows, onMouseEnter, onMouseLeave }: NoticePopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const style = KIND_STYLES[kind];
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0, top: 0, ready: false,
  });

  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const a  = anchor.getBoundingClientRect();
    const r  = pop.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 8;
    const PAD = 8;

    // Prefer LEFT of the anchor.
    let left = a.left - r.width - GAP;
    // Flip to RIGHT if there isn't room on the left.
    if (left < PAD) left = a.right + GAP;
    // Clamp horizontally if even the right side overflows.
    if (left + r.width + PAD > vw) left = Math.max(PAD, vw - r.width - PAD);

    // Vertically: align top with the anchor; clamp to viewport.
    let top = a.top;
    if (top + r.height + PAD > vh) top = vh - r.height - PAD;
    if (top < PAD) top = PAD;

    setPos({ left, top, ready: true });
  }, [anchorRef]);

  useLayoutEffect(() => { reposition(); }, [reposition, rows.length]);

  useEffect(() => {
    const onResize = () => reposition();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [reposition]);

  return createPortal(
    <div
      ref={popRef}
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      // Stop wheel events from chaining to the streams panel beneath.
      onWheel={(e) => e.stopPropagation()}
      className="fixed z-[300] pointer-events-auto
                 w-[340px] max-w-[80vw] max-h-[60vh] overflow-y-auto
                 p-3 rounded-lg
                 bg-black/85 backdrop-blur-2xl border border-white/15
                 shadow-[0_24px_48px_-18px_rgba(0,0,0,0.9)]
                 transition-opacity duration-150 ease-out"
      style={{
        left: pos.left,
        top:  pos.top,
        opacity: pos.ready ? 1 : 0,
        // overscroll-behavior keeps inner-scroll bounce from chaining to
        // the parent scroll container when the user's wheel hits a bound.
        overscrollBehavior: "contain",
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(255,255,255,0.18) transparent",
      }}
    >
      <p className="text-white/55 text-[10px] font-mono font-semibold uppercase tracking-[0.18em] mb-2">
        {style.label} · {rows.length}
      </p>
      <div className="flex flex-col gap-2">
        {rows.map((m, i) => (
          <StreamMessageRow key={`${kind}-${i}`} message={m} kind={kind} />
        ))}
      </div>
    </div>,
    document.body,
  );
}

/** Single message row — used in BOTH the floating tooltip and the panel
 *  empty state. Renders title (bold) + description with addon attribution. */
function StreamMessageRow({ message, kind }: { message: StreamMessage; kind: MessageKind }) {
  const style = KIND_STYLES[kind];
  return (
    <div
      className={`px-2.5 py-2 rounded-md border ${style.inlineBg} ${style.inlineBorder} ${style.inlineFg}`}
    >
      {message.title && (
        <p className="text-[12px] font-semibold leading-tight mb-0.5 break-words">
          {message.title}
        </p>
      )}
      {message.description && (
        <p className="text-[11.5px] leading-snug break-words selectable opacity-95">
          {message.description}
        </p>
      )}
      {message.addon_name && (
        <p className="text-white/45 text-[10px] font-mono uppercase tracking-[0.15em] mt-1">
          {message.addon_name}
        </p>
      )}
    </div>
  );
}

/** Empty-state body for the streams panel. Renders every message grouped by
 *  kind with a section header per group. Used when streams.length === 0 but
 *  AIOStreams returned status messages — replaces the "No streams found"
 *  fallback. */
function StreamMessagesEmptyState({ metadata }: { metadata: StreamMetadata }) {
  const allGroups: { kind: MessageKind; rows: StreamMessage[] }[] = [
    { kind: "error",   rows: metadata.errors   },
    { kind: "warning", rows: metadata.warnings },
    { kind: "info",    rows: metadata.info     },
    { kind: "stats",   rows: metadata.stats    },
  ];
  const groups = allGroups.filter((g) => g.rows.length > 0);

  // Stable order: errors first (most actionable) → warnings → info → stats.
  groups.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));

  return (
    <div className="px-2 py-3 flex flex-col gap-3" role="region" aria-label="Addon status messages">
      <p className="text-white/60 text-[13px] italic px-2">
        No streams found, but your addons returned messages:
      </p>
      {groups.map(({ kind, rows }) => (
        <div key={kind} className="flex flex-col gap-1.5 px-1">
          <div className="flex items-center gap-2 px-1">
            <span className={`flex items-center justify-center w-5 h-5 rounded-full
                              ${KIND_STYLES[kind].iconBtn} border`}>
              {ICONS[kind]}
            </span>
            <p className="text-white/55 text-[11px] font-mono font-semibold tracking-[0.18em] uppercase">
              {KIND_STYLES[kind].label}
            </p>
            <span className="text-white/35 text-[11px] font-mono">{rows.length}</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {rows.map((m, i) => (
              <StreamMessageRow key={`${kind}-${i}`} message={m} kind={kind} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function StreamsPanel({
  isEpisodic, activeVideo, streams, streamMeta, loading, groups, onBack, onPlay, onCopy, onPlayExternal,
}: {
  isEpisodic: boolean;
  activeVideo: VideoEntry | null;
  streams: StreamEntry[];
  streamMeta: StreamMetadata;
  loading: boolean;
  groups: [string, StreamEntry[]][];
  onBack?: () => void;
  onPlay: (s: StreamEntry) => void;
  onCopy: (text: string) => void;
  onPlayExternal: (url: string) => void;
}) {
  const subtitle = isEpisodic && activeVideo
    ? (activeVideo.season != null && activeVideo.episode != null
        ? `S${String(activeVideo.season).padStart(2, "0")} · E${String(activeVideo.episode).padStart(2, "0")} · ${activeVideo.title}`
        : activeVideo.title)
    : null;

  const totalMessages =
    streamMeta.errors.length +
    streamMeta.warnings.length +
    streamMeta.info.length +
    streamMeta.stats.length;

  return (
    <>
      <PanelHeader
        title="Streams"
        right={loading ? "Searching…" : `${streams.length} found`}
        backLabel={onBack ? "Episodes" : undefined}
        onBack={onBack}
        action={(
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:streams-refresh"))}
            disabled={loading}
            aria-label="Refresh streams"
            title="Refresh streams"
            className="flex items-center justify-center w-7 h-7 -my-1 rounded-md
                       text-white/55 hover:text-white hover:bg-white/8
                       disabled:opacity-40 disabled:hover:bg-transparent
                       disabled:cursor-default transition-colors"
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden
              className={loading ? "animate-spin" : undefined}
            >
              <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A5.99 5.99 0 0 1 12 18a6 6 0 1 1 0-12c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
            </svg>
          </button>
        )}
      />
      {subtitle && (
        <div className="px-4 py-3 border-b border-white/8">
          <p className="text-white/90 text-[16px] font-medium tracking-tight text-center break-words">
            {subtitle}
          </p>
        </div>
      )}
      <div
        className="relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2 py-3"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        {loading && streams.length === 0 ? (
          // Three orbiting discs, breathing in / out, centred in the
          // panel with a "Loading…" caption. Brightness ramps over the
          // AIOStreams cap (7 s movies, 12 s series).
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <SpectralPulse
              active
              capSeconds={isEpisodic ? CAP_SERIES_SECONDS : CAP_MOVIE_SECONDS}
            />
          </div>
        ) : streams.length === 0 ? (
          // Empty state — when AIOStreams (or any other addon) returned only
          // errors/warnings/info we surface ALL of them here in place of the
          // generic "no streams" message so the user can see why the list is
          // empty. When there's nothing at all we keep the legacy fallback.
          totalMessages > 0 ? (
            <StreamMessagesEmptyState metadata={streamMeta} />
          ) : (
            <p className="text-white/50 text-[13px] italic px-2 py-3">
              No streams found from your installed addons.
            </p>
          )
        ) : (
          <div className="space-y-3">
            {loading && (
              <div className="px-2 py-1">
                <SpectralPulse
                  small
                  active
                  capSeconds={isEpisodic ? CAP_SERIES_SECONDS : CAP_MOVIE_SECONDS}
                />
              </div>
            )}
            {groups.map(([provider, list]) => (
              <div key={provider} className="space-y-1.5">
                <div className="flex items-center gap-2 px-2">
                  <span className="w-px h-3 bg-white/15" aria-hidden />
                  <p className="text-white/50 text-[11px] font-mono font-semibold
                                tracking-[0.18em] uppercase">
                    {provider}
                  </p>
                  <span className="text-white/30 text-[11px] font-mono">
                    {list.length}
                  </span>
                </div>
                <div className="space-y-1">
                  {list.map((s, idx) => (
                    <StreamRow
                      key={`${s.url ?? s.info_hash ?? "x"}:${idx}`}
                      stream={s}
                      onPlay={() => onPlay(s)}
                      onCopy={onCopy}
                      onPlayExternal={onPlayExternal}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// PanelHeader — shared header bar for either mode of UnifiedPanel.
// ---------------------------------------------------------------------------

function PanelHeader({
  title, right, backLabel, onBack, action,
}: {
  title: string;
  right?: string | null;
  backLabel?: string;
  onBack?: () => void;
  /** Optional trailing control (e.g. the Streams "Refresh" button),
   *  rendered after the right-aligned status text. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1 px-2 py-1 rounded-md
                     text-white/60 hover:text-white hover:bg-white/8
                     text-[11px] font-mono tracking-[0.12em] uppercase transition-colors"
        >
          <ArrowBackSm />
          <span>{backLabel}</span>
        </button>
      )}
      <span className="w-1 h-3.5 bg-ln-accent rounded-sm" aria-hidden />
      <h3 className="text-white/95 text-[12.5px] font-mono font-semibold tracking-[0.22em] uppercase">
        {title}
      </h3>
      <div className="flex-1" />
      {right && (
        <span className="text-white/45 text-[11px] font-mono uppercase tracking-[0.15em]">
          {right}
        </span>
      )}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StreamRow v2 layout:
//
//   ┌────────────────────────────────────────────────────────────────────┐
//   │ ┌─────────┐  Frieren — S01E03 BluRay Remux 1080p [9volt]           │
//   │ │ 1080p   │  HEVC · DTS-HD MA · 5.1 · 4.2 GB · 👥 1.2K · ENG       │
//   │ │ Remux   │                                                        │
//   │ │ ★★★★☆   │                                                        │
//   │ │ Direct  │                                                        │
//   │ └─────────┘                                                        │
//   │ ─────────────────────────────────── faint divider ───────────────── │
//   │ [HEVC] [HDR] [DTS-HD MA] [4.2 GB] [ENG]                             │
//   └────────────────────────────────────────────────────────────────────┘
//
// LEFT  — quality summary box: resolution + rip type + cached/Direct-Magnet
//          + (optional) star bar.
// RIGHT — full title + AIOStreams release-note line.
// BOTTOM (under faint hr) — rectangular tag pills for the parsed meta.
// ---------------------------------------------------------------------------

function StreamRow({
  stream, onPlay, onCopy, onPlayExternal,
}: {
  stream: StreamEntry;
  onPlay: () => void;
  onCopy: (text: string) => void;
  onPlayExternal: (url: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const parsed = useMemo(() => parseStream(stream), [stream]);

  // The LEFT quality column prefers the AIOStreams `〈〉` quality string
  // (canonical) and falls back to the regex-extracted `ripType` for
  // legacy addons.
  const leftQuality = parsed.quality ?? parsed.ripType ?? null;
  // Direct vs Magnet — cosmetic on the box.
  const direct = !!stream.url;

  // Title-line content. Display title is preferred; fall back to the
  // legacy `primary` string if AIOStreams parsing didn't produce one.
  const headline = parsed.displayTitle ?? parsed.primary ?? "";
  // Top-right meta strip — release group / indexer. Service ([TB]) and
  // addon (Comet) live inside the quality box now, so they're omitted here.
  const topMeta: Array<{ kind: ChipKind; label: string }> = [];
  if (parsed.releaseGroup) topMeta.push({ kind: "group",   label: parsed.releaseGroup });
  if (parsed.indexer)      topMeta.push({ kind: "indexer", label: parsed.indexer });
  // Whether this row's badge slot is taken by Best/Alt Best — the stars
  // anchor below the badge in that case, otherwise to the top-right.
  const hasBadge = parsed.seadexBest || parsed.seadexAlt;

  return (
    <button
      ref={ref}
      onClick={onPlay}
      onContextMenu={(e) => {
        e.preventDefault();
        const items = [
          stream.url
            ? { label: "Copy stream link", onClick: () => onCopy(stream.url!) }
            : null,
          stream.info_hash
            ? { label: "Copy magnet link",
                onClick: () => onCopy(`magnet:?xt=urn:btih:${stream.info_hash}`) }
            : null,
          stream.url
            ? { label: "Play externally", icon: <ExternalIcon />,
                onClick: () => onPlayExternal(stream.url!) }
            : null,
        ].filter(Boolean) as Array<{
          label: string; icon?: React.ReactNode; onClick: () => void;
        }>;
        openContextMenu(e.clientX, e.clientY, items);
      }}
      className="relative hover-glow w-full text-left rounded-xl px-4 py-3
                 bg-white/[0.04] border border-white/10
                 hover:bg-white/[0.08] hover:border-white/18
                 flex flex-col gap-2.5"
    >
      {/* TOP — quality summary on left, title/details on right. */}
      <div className="flex items-stretch gap-3">
        {/* Quality summary box. Three slots:
              • main content (resolution / ripType / direct / cached) is
                centered vertically via the inner flex-1 + justify-center
              • service ([TB]) and scraper (Comet) anchor to the bottom,
                stacked with scraper underneath service
              • stars live at the top-right of the OUTER row (rendered
                further down) — no longer inside this box.
              Fixed width keeps the box visually consistent across all
              streams; long scraper names (e.g. "TorBox Search") shrink
              their font via addonFontClass instead of stretching the box. */}
        <div className="flex-shrink-0 flex flex-col items-center
                        px-3 py-2 rounded-lg bg-white/[0.05] border border-white/10
                        w-[100px]">
          {/* Centered main content. flex-1 absorbs whatever extra height
              the row gives the box (when the vertical chip stack stretches
              the row tall) so resolution / ripType / direct / cached stay
              centered relative to the box's interior, not the right column. */}
          <div className="flex-1 flex flex-col items-center justify-center gap-1 w-full">
            {parsed.resolution && (
              <span className="text-white text-[18px] font-bold tracking-tight font-mono">
                {parsed.resolution.toUpperCase()}
              </span>
            )}
            {leftQuality && (
              <span className="text-emerald-300/95 text-[10.5px] font-mono font-semibold tracking-wider uppercase text-center">
                {leftQuality}
              </span>
            )}
            <span
              className={`text-[9.5px] font-mono font-bold tracking-[0.18em] uppercase
                          ${direct ? "text-ln-accent/90" : "text-amber-300/85"}`}
            >
              {direct ? "Direct" : "Magnet"}
            </span>
            {parsed.cachedStatus === "cached" && (
              <span className="text-[9.5px] font-mono font-bold tracking-[0.18em] uppercase
                               text-orange-300/95">Cached</span>
            )}
            {parsed.cachedStatus === "uncached" && (
              <span className="text-[9.5px] font-mono font-bold tracking-[0.18em] uppercase
                               text-white/40">Uncached</span>
            )}
          </div>

          {/* Service tag ([TB] / [RD]) on top, scraper tag (Comet, TorBox
              Search) below. Both anchored to the bottom of the box. The
              scraper chip's font size scales down as its label grows so
              long names (e.g. "TorBox Search", "MediaFusion") still fit
              inside the fixed-width box. */}
          {(parsed.serviceShort || parsed.addonName) && (
            <div className="flex flex-col items-center gap-1 mt-2 font-mono">
              {parsed.serviceShort && (
                <div className="text-[10.5px]">
                  <ChipPill kind="service" label={`[${parsed.serviceShort}]`} />
                </div>
              )}
              {parsed.addonName && (
                <div className={addonFontClass(parsed.addonName)}>
                  <ChipPill kind="addon" label={parsed.addonName} tight />
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT — title at the top, then chip rows. Release group / indexer /
            private flag have moved out of here into the absolute bottom-right
            cluster (next to the seScore / VPS chips), so the right column
            now starts straight with the title. */}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5 py-0.5">
          {/* TITLE LINE — display title + library badge + episode. pr-24
              reserves horizontal clearance so the Best / Alt Best badge
              and the stars at top-right don't overlap a long title. */}
          {(headline || parsed.episode || parsed.year || parsed.library) && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-24">
              {parsed.library && (
                <span className="text-cyan-300/85 text-[12px] leading-none" aria-label="from library">☁</span>
              )}
              {headline && (
                <p className="text-white/95 text-[15px] leading-snug font-semibold break-words selectable line-clamp-2">
                  {headline}
                </p>
              )}
              {parsed.year && (
                <span className="text-white/55 text-[12px] font-mono">({parsed.year})</span>
              )}
              {parsed.episode && (
                <span className="text-emerald-300/90 text-[11px] font-mono font-semibold tracking-wider">
                  {parsed.episode}
                </span>
              )}
            </div>
          )}

          {/* CHIPS — vertical stack, one row per AIOStreams category. The
              category icon sits as a left rail at the start of each row.
              pb-7 reserves vertical clearance so the absolute VPS / score
              cluster never rides over the last row. mt-1.5 gives the
              title a little breathing room above the chip stack so the
              two visual blocks read separately. */}
          {hasAnyChip(parsed) && (
            <div className="flex flex-col gap-1 text-[11.5px] font-mono pb-7 mt-1.5">

              {/* ▣ Codec / bit-depth / HDR / visual tags */}
              {(parsed.encode || parsed.codec || parsed.bitDepth ||
                parsed.visualTagsPrimary.length > 0 || parsed.hdr ||
                parsed.visualTagsSecondary.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>▣</span>
                  {parsed.encode
                    ? <Tooltip text="Codec" pos="top"><ChipPill kind="encode" label={parsed.encode} /></Tooltip>
                    : parsed.codec
                      ? <Tooltip text="Codec" pos="top"><ChipPill kind="codec" label={parsed.codec} /></Tooltip>
                      : null
                  }
                  {parsed.bitDepth && (
                    <Tooltip text="Bit depth" pos="top">
                      <ChipPill kind="encode" label={`✦ ${parsed.bitDepth}`} />
                    </Tooltip>
                  )}
                  {parsed.visualTagsPrimary.map((t, i) => (
                    <Tooltip key={`vp-${i}`} text="HDR / Dolby Vision tag" pos="top">
                      <ChipPill kind="visual-pri" label={`✦ ${t}`} />
                    </Tooltip>
                  ))}
                  {parsed.visualTagsPrimary.length === 0 && parsed.hdr && (
                    <Tooltip text="HDR / Dolby Vision tag" pos="top">
                      <ChipPill kind="hdr" label={parsed.hdr} />
                    </Tooltip>
                  )}
                  {parsed.visualTagsSecondary.map((t, i) => (
                    <Tooltip key={`vs-${i}`} text="Visual tag" pos="top">
                      <ChipPill kind="visual-sec" label={`✧ ${t}`} />
                    </Tooltip>
                  ))}
                </div>
              )}

              {/* ♬ Audio codec */}
              {(parsed.audioTags.length > 0 || parsed.audio) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>♬</span>
                  {parsed.audioTags.length > 0
                    ? parsed.audioTags.map((t, i) => (
                        <Tooltip key={`a-${i}`} text="Audio codec" pos="top">
                          <ChipPill kind="audio" label={t} />
                        </Tooltip>
                      ))
                    : parsed.audio && (
                        <Tooltip text="Audio codec" pos="top">
                          <ChipPill kind="audio" label={parsed.audio} />
                        </Tooltip>
                      )
                  }
                </div>
              )}

              {/* ♯ Audio channels */}
              {parsed.audioChannels.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>♯</span>
                  {parsed.audioChannels.map((c, i) => (
                    <Tooltip key={`ch-${i}`} text="Audio channels" pos="top">
                      <ChipPill kind="channels" label={c} />
                    </Tooltip>
                  ))}
                </div>
              )}

              {/* ◈ Size / folder size / bitrate */}
              {(parsed.size || parsed.folderSize || parsed.bitrate) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>◈</span>
                  {parsed.size && (
                    <Tooltip text={parsed.seasonPack ? "Season pack size" : "File size"} pos="top">
                      <ChipPill kind="size" label={parsed.seasonPack ? `❖ ${parsed.size}` : parsed.size} />
                    </Tooltip>
                  )}
                  {parsed.folderSize && (
                    <Tooltip text="Folder / total size" pos="top">
                      <ChipPill kind="folder" label={`/ ${parsed.folderSize}`} />
                    </Tooltip>
                  )}
                  {parsed.bitrate && (
                    <Tooltip text="Bit rate" pos="top">
                      <ChipPill kind="bitrate" label={parsed.bitrate} />
                    </Tooltip>
                  )}
                </div>
              )}

              {/* ⇄ Seeders / age */}
              {(parsed.seeders != null || parsed.age) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>⇄</span>
                  {parsed.seeders != null && (
                    <Tooltip text="Seeders" pos="top">
                      <ChipPill kind="seeders" label={formatSeeders(parsed.seeders)} />
                    </Tooltip>
                  )}
                  {parsed.age && (
                    <Tooltip text="Stream age" pos="top">
                      <ChipPill kind="age" label={parsed.age} />
                    </Tooltip>
                  )}
                </div>
              )}

              {/* ⛿ Languages / sub / subtitle codes */}
              {(parsed.languages.length > 0 || parsed.language ||
                parsed.subbed || parsed.subtitles.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>⛿</span>
                  {parsed.languages.length > 0
                    ? parsed.languages.map((l, i) => (
                        <Tooltip key={`l-${i}`} text="Audio language" pos="top">
                          <ChipPill kind="lang" label={l} />
                        </Tooltip>
                      ))
                    : parsed.language && (
                        <Tooltip text="Audio language" pos="top">
                          <ChipPill kind="lang" label={parsed.language} />
                        </Tooltip>
                      )
                  }
                  {parsed.subbed && (
                    <Tooltip text="Subtitled" pos="top">
                      <ChipPill kind="sub" label="SUB" />
                    </Tooltip>
                  )}
                  {parsed.subtitles.map((sub, i) => (
                    <Tooltip key={`sub-${i}`} text="Subtitle languages" pos="top">
                      <ChipPill kind="sub" label={sub} />
                    </Tooltip>
                  ))}
                </div>
              )}

              {/* Provenance: NZB health (its own row, no rail icon).
                  Indexer used to live here too but moved to the absolute
                  bottom-right cluster alongside seScore / VPS, so we don't
                  render it twice. */}
              {parsed.nzbHealth && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="w-4 shrink-0" aria-hidden />
                  {parsed.nzbHealth === "verified" && (
                    <Tooltip text="NZB health: verified" pos="top">
                      <ChipPill kind="nzb-verified" label="☑ NZB" />
                    </Tooltip>
                  )}
                  {parsed.nzbHealth === "elf" && (
                    <Tooltip text="NZB health: elf" pos="top">
                      <ChipPill kind="nzb-elf" label="ELF NZB" />
                    </Tooltip>
                  )}
                  {parsed.nzbHealth === "unverified" && (
                    <Tooltip text="NZB health: unverified" pos="top">
                      <ChipPill kind="nzb-unverified" label="Unverified NZB" />
                    </Tooltip>
                  )}
                  {parsed.nzbHealth === "broken" && (
                    <Tooltip text="NZB health: broken" pos="top">
                      <ChipPill kind="nzb-broken" label="✘ NZB" />
                    </Tooltip>
                  )}
                </div>
              )}

            </div>
          )}

          {/* RESIDUE — anything the parser couldn't classify gets shown
              dim so we never silently drop addon content. */}
          {parsed.extra.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {parsed.extra.map((line, i) => (
                <p key={i} className="text-white/55 text-[12.5px] leading-snug break-words selectable">
                  {line}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* BEST / ALT BEST badge — absolute top-right of the outer button.
          Only one of these renders at a time; seadexBest takes priority. */}
      {parsed.seadexBest && (
        <span
          className="absolute top-2 right-2
                     text-[11px] font-semibold uppercase tracking-wider px-2 py-1 rounded
                     bg-amber-400/20 text-amber-200 border border-amber-300/40
                     shadow-[0_0_12px_rgba(251,191,36,0.3)]"
          aria-label="Best Release"
        >
          ★ Best Release
        </span>
      )}
      {!parsed.seadexBest && parsed.seadexAlt && (
        <span
          className="absolute top-2 right-2
                     text-[11px] font-semibold uppercase tracking-wider px-2 py-1 rounded
                     bg-amber-500/15 text-amber-300/90 border border-amber-400/30"
          aria-label="Alt Best Release"
        >
          ★ ALT BEST
        </span>
      )}

      {/* Stars — anchored to the top-right of the row. When a Best /
          Alt Best badge is present in the same corner, the stars sit
          directly below it (top-10 ≈ 40 px clears the badge's height).
          When there's no badge, stars take the corner slot (top-2). */}
      {parsed.stars > 0 && (
        <div className={`absolute right-2 ${hasBadge ? "top-10" : "top-2"}`}>
          <Stars value={parsed.stars} />
        </div>
      )}

      {/* Bottom-right cluster — release-group / indexer / private flag,
          then the seScore chip, then the VPS chip. Order left-to-right is:
          provenance tags, score, VPS (rightmost). Anchored absolute so the
          chip strip in the right column never bumps into them; pb-7 on the
          chip strip reserves the vertical clearance. */}
      {(topMeta.length > 0 || parsed.private || parsed.proxyState != null || parsed.seScore != null) && (
        <div className="absolute bottom-2 right-2 flex items-center gap-1.5 text-[11.5px] font-mono">
          {topMeta.map((m, i) => (
            <ChipPill key={i} kind={m.kind} label={m.label} />
          ))}
          {parsed.private && <ChipPill kind="private" label="⚿ Private" />}
          {parsed.seScore != null && (
            <Tooltip text="Stremio Enhanced score" pos="top">
              <ChipPill
                kind="score"
                label={parsed.seScore >= 0 ? `S+${parsed.seScore}` : `S${parsed.seScore}`}
              />
            </Tooltip>
          )}
          {parsed.proxyState === "on" && (
            <Tooltip text="Routed through addon's proxy" pos="top">
              <ChipPill kind="proxy" label="⛊" />
            </Tooltip>
          )}
          {parsed.proxyState === "off" && (
            <Tooltip text="Direct delivery; addon's proxy is off for this stream" pos="top">
              <ChipPill kind="proxy-off" label="⛉" />
            </Tooltip>
          )}
        </div>
      )}
    </button>
  );
}

/** True when the parsed result has at least one chip to show in the
 *  vertical chip stack. seadexBest/seadexAlt are excluded (absolute badge).
 *  proxied/seScore/indexer/releaseGroup/private are excluded — they all
 *  render in the absolute bottom-right cluster. */
function hasAnyChip(p: ReturnType<typeof parseStream>): boolean {
  return !!(
    p.encode || p.codec || p.hdr || p.bitDepth ||
    p.visualTagsPrimary.length > 0 || p.visualTagsSecondary.length > 0 ||
    p.audio || p.audioTags.length > 0 || p.audioChannels.length > 0 ||
    p.size || p.folderSize || p.bitrate ||
    p.seeders != null || p.age ||
    p.language || p.languages.length > 0 || p.subbed || p.subtitles.length > 0 ||
    p.nzbHealth
  );
}

/** Single rectangular tag pill — minimal type, coloured per kind via
 *  `chipStyleFor`.
 *  - inline-block keeps the chip's border around ALL of its content as
 *    a single rounded rectangle when the label wraps (the auto-shrunk
 *    scraper-name chip in the quality box). Without inline-block, the
 *    default `display: inline` splits the border across lines.
 *  - text-center keeps wrapped lines centred inside the chip box;
 *    single-line chips are unaffected because they fill their span.
 *  - tight ⇒ width:min-content. The chip shrinks to the widest
 *    unbreakable word (rather than the full available width), so a
 *    wrapped two-line scraper chip is only as wide as it needs to be.
 *    Default chips use max-w-full so they never blow past their parent. */
function ChipPill({ kind, label, tight }: { kind: ChipKind; label: string; tight?: boolean }) {
  const s = chipStyleFor(kind);
  const widthClass = tight ? "w-min max-w-full" : "max-w-full";
  return (
    <span className={`inline-block ${widthClass} px-2 py-0.5 rounded border ${s.bg} ${s.fg} ${s.border} font-medium tracking-wide text-center`}>
      {label}
    </span>
  );
}

/** 5-star rating bar with half-star granularity. */
function Stars({ value }: { value: number }) {
  return (
    <div className="flex items-center gap-[1px]" aria-label={`${value} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((i) => {
        const filled = value >= i;
        const half   = !filled && value >= i - 0.5;
        return (
          <span
            key={i}
            className={`text-[14px] leading-none ${
              filled ? "text-amber-300/95" : half ? "text-amber-300/55" : "text-white/15"
            }`}
            style={{ textShadow: filled ? "0 0 4px rgba(252, 211, 77, 0.45)" : undefined }}
            aria-hidden
          >
            {filled || half ? "★" : "★"}
          </span>
        );
      })}
    </div>
  );
}

function formatSeeders(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

/** Pick a font-size class for the scraper / addon chip based on label
 *  length so long names (e.g. "TorBox Search", "MediaFusion") fit inside
 *  the fixed-width quality box without expanding it. The chip's `font-mono`
 *  parent gives ~0.6 ratio between font-size and char width; the box has
 *  ~58 px of usable inner width after accounting for box + chip padding. */
function addonFontClass(name: string): string {
  if (name.length > 10) return "text-[7.5px]";
  if (name.length > 6)  return "text-[10px]";
  return "text-[10.5px]";
}
