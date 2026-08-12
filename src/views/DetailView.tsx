// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { openExternalUrl } from "../externalUrl";
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
import { computeReleaseCountdowns, formatCountdown, formatTargetDate, isInTheaters, nextAiringEpisode, useCountdownNow } from "../releaseCountdown";
import { useMovieReleaseDates } from "../releaseDates";
import EpisodeAirChip from "../EpisodeAirChip";
import { loadAuraSettings, saveAuraSettings } from "../auraSettings";
import { useReleaseSignal } from "../releaseSignalStore";
import { fetchReleaseSignal } from "../releaseSearch";
import { resolveDefaultMetaUrl } from "../addonDefaults";
import { findAIOMetadataAddon, isAnimeMeta, markAnimeId, typeLabel } from "../aiometadata";
import { dedupedInvoke } from "../invokeDedupe";
import { peekRichestCachedDetailById } from "../metaCache";
import DetailHud from "../DetailHud";
import { FactList, FactsBlock } from "../AnimeExtrasOverlay";
import { resolveCourMalIds, type CourRef } from "../animeExtras";
import { PersistentCache } from "../persistentCache";
import SeasonSelect from "../SeasonSelect";
import FillerRecapTags from "../FillerRecapTags";

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
// Soft cap on cached stream-fetch results. 12 covers rapid back-and-forth
// between a handful of titles; the 3-min TTL reclaims the rest. (Lowered from
// 32 — each entry holds a full stream list, so the smaller cap trims the
// steady-state working set with no correctness impact, only eviction timing.)
const STREAM_CACHE_MAX = 12;
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
import { useEpisodeProgress, useLibraryMap, useResumeVideoId, useEpisodesBehind } from "../LibraryContext";
import { isEpisodeWatched } from "../episodeSpoilers";
import { isSkipped } from "../skipMarks";
import { clearEpisodesSkipped, markEpisodesSkipped, type SkipTarget } from "../skipActions";
import SpectralPulse from "../SpectralPulse";
import WatchedBadge, { useWatchedVariant } from "../WatchedBadge";
import { openContextMenu } from "../ContextMenu";
import {
  getManualWatchedState,
  setManualWatchedState,
  setManualWatchedMany,
  useManualWatchedVersion,
} from "../manualWatched";
import { recheckSeriesWatchedFlag } from "../autoAdvance";
import { getSortedEpisodes } from "../episodeSort";
import { showFlyUpToast } from "../FlyUpToast";
import ImageLoader from "../ImageLoader";
import { shrinkPoster, screenWidthHint } from "../posterSize";
import ErrorBoundary from "../ErrorBoundary";
import { parseStream, chipStyleFor, looksLikeTamTaro, type ChipKind } from "../streamMeta";
import NoProvidersWarning from "../NoProvidersWarning";
import { streamMatchKey } from "../watchTogether/streamMatch";
import Tooltip from "../Tooltip";
import { BrandLogo, ratingDomain, groupRatingsByBrand } from "../logodev";
import { hasUsableRating } from "../ratingValue";
import ArcGrid, { ArcGridSkeleton } from "../ArcGrid";
import GroupingToggle from "../EpisodeGroupingToggle";
import {
  absoluteEpisodeMap, arcArtFor, arcPositionOf, arcsLikelyAvailable, arcYearRange, formatAbsoluteEpisode, loadArcMode, peekCachedArcs, preferredGroupingId, saveArcMode, useStoryArcs,
  type EpisodeGrouping,
} from "../storyArcs";

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
  /** Watch-party: the leader's chosen stream match-key — highlights the
   *  matching row so a member can one-tap the same stream. */
  partyStreamKey?: string | null;
  /** Open a different title's detail page in place. Used by the Related tab so
   *  a sequel or a recommendation is one click away rather than a search. */
  onOpenTitle?: (id: string, mediaType: string, name: string) => void;
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
  /** Queue add/remove. Wired by App to the same "planned" toggle the catalog
   *  context menu uses, so both routes share one rule set. */
  onQueueToggle?: (originPoint?: { x: number; y: number }) => void;
  /** Play the title's trailer in Aura's MPV player. `ytId` comes from
   *  `detail.trailer_yt_id`; `title` is the display name. App.tsx resolves the
   *  id to a direct CDN URL via yt-dlp and plays it as a `trailer:<id>` target
   *  (no scrobble / history / Continue-Watching). Absent ⇒ button hidden. */
  onPlayTrailer?: (ytId: string, title: string) => void;
  /** When set, DetailView opens in episodes mode (instead of streams),
   *  selects the season containing this episode id, and scrolls the
   *  matching row to the top of the list. Used after exiting playback
   *  for series/anime so the user lands back on the next-episode row. */
  openOnEpisodeId?: string | null;
  /** Called once after `openOnEpisodeId` has been consumed (after the
   *  initial mount effect runs). Lets the parent clear the hint so a
   *  later open from an unrelated card doesn't inherit it. */
  onConsumeOpenHint?: () => void;
  /** When set, the episode row matching this id gets a persistent selection
   *  ring (notification deep-link). Distinct from openOnEpisodeId, which only
   *  selects the season + scrolls. */
  highlightEpisodeId?: string | null;
  onConsumeHighlight?: () => void;
  /** When true, suppress the "resume from CW" auto-route to streams
   *  mode. Used by the Library tab's series-click path: clicking a
   *  series in the Library should drop the user on the episode list
   *  starting at the first episode regardless of any state.video_id
   *  resume hint stamped from previous CW interactions. */
  ignoreResumeHint?: boolean;
  /** When true, force the initial panelMode to "streams" for the
   *  episode pointed to by `openOnEpisodeId`, skipping the episodes-
   *  list intermediate step. Highest precedence over the
   *  openOnEpisodeId / resumeVideoId branches. Used by the EOS
   *  Spotlight's EpisodePanel single-click flow (2026-05-20) so a user
   *  who picks an episode from the in-player panel lands directly on
   *  the streams picker for that episode. Consumed once via
   *  `onConsumeOpenInStreamsMode` so the hint can't bleed into a
   *  later unrelated open. */
  openInStreamsMode?: boolean;
  /** Called once after `openInStreamsMode` has been consumed (after
   *  the initial mount effect runs). Lets the parent clear the hint
   *  so a later open from an unrelated card doesn't inherit it. */
  onConsumeOpenInStreamsMode?: () => void;
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

// ---------------------------------------------------------------------------
// Hero art latch
//
// INVARIANT: the hero's backdrop + logo are resolved EXACTLY ONCE per detail
// open and are immutable for the rest of it. Everything else on the page —
// title text, chips, synopsis, cast, episodes — keeps filling in progressively
// as sources land, but the ART does not, because a backdrop that changes
// under the user reads as a glitch rather than as progress.
//
// It used to change from three independent directions, and patching them one
// at a time would have left the fourth:
//   1. the pre-meta catalog `meta.background` being replaced by the addon's
//      `detail.background` (the reported Bleach swap),
//   2. the first-answering addon's setDetail being replaced by the later
//      with-videos one further down the probe loop,
//   3. a metaCache write landing after mount.
// One write-once latch closes all of them.
// ---------------------------------------------------------------------------

/** Length of the single hero reveal beat. The backdrop fade, the
 *  title→logo crossfade and the title slot's height travel all run on this
 *  so the hero settles once instead of popping a piece at a time. */
const HERO_REVEAL_MS = 400;

interface HeroArt {
  background: string | null;
  logo:       string | null;
}

/** Resolve hero art from a meta detail, falling back through the catalog
 *  preview's landscape fields. Always returns an object: `{ background: null,
 *  logo: null }` is the legitimate "this item has no art anywhere" answer and
 *  still counts as settled, so the reveal isn't left waiting forever. */
function heroArtFrom(
  d: MetaDetail | null,
  preview: MetaPreview,
  /** Story-arc key art for the arc the user has progress in. Takes precedence
   *  over every backdrop below it when present, which is the whole point of
   *  the feature; null (the overwhelmingly common case) leaves the chain
   *  exactly as it was. */
  arcArt?: string | null,
): HeroArt {
  return {
    background:
      arcArt ?? d?.background ?? preview.background ?? preview.fanart ?? preview.backdrop ?? preview.poster ?? null,
    logo: d?.logo ?? preview.logo ?? null,
  };
}

/** Arc key art for the hero, from the CACHE ONLY.
 *
 *  See peekCachedArcs for why this cannot fetch: the hero latch is write-once
 *  and arcs resolve far later than the meta probe, so a live fetch would
 *  either delay the reveal for every anime or break the invariant. The warm
 *  path is the deal: first open shows normal art, and arc art appears from the
 *  next visit once the arcs view has populated the cache.
 *
 *  Returns null unless the user opted in, since this ADDS spoiler exposure. */
function arcHeroArt(seriesId: string, resumeVideoId: string | null): string | null {
  if (!resumeVideoId) return null;
  if (!loadAuraSettings().arcAwareArt) return null;
  return arcArtFor(peekCachedArcs(seriesId), resumeVideoId);
}

/** Hero title slot — the text title and the logo stacked in a single grid
 *  cell, crossfading on the SAME beat as the backdrop so the hero settles
 *  once instead of popping twice (words, then logo a moment later).
 *
 *  The slot's height is animated rather than left to `auto`. A grid cell
 *  sizes to its tallest child, so the instant a logo faded in the slot would
 *  snap from one line of 64px text to as much as 176px of artwork. The left
 *  column is `justify-end`, so that snap travels UPWARD — the title lurches
 *  away from the chips instead of pushing them down — which is exactly the
 *  kind of unexplained jump the reveal is supposed to remove. Measuring both
 *  children lets the container travel that distance on the reveal curve.
 *
 *  Height stays `auto` until the relevant child has actually been measured;
 *  animating toward an unmeasured 0 would collapse the slot. */
function HeroTitle({
  name, logo, revealed, onLogoSettled,
}: {
  name:  string;
  logo:  string | null;
  revealed: boolean;
  /** Fired once the logo has decoded OR failed — the parent's reveal gate
   *  waits on this, so a broken logo URL must still resolve it. */
  onLogoSettled: () => void;
}) {
  const textRef = useRef<HTMLHeadingElement>(null);
  const logoRef = useRef<HTMLImageElement>(null);
  const [textH, setTextH] = useState(0);
  const [logoH, setLogoH] = useState(0);
  // A logo that fails to load still has to release the parent's reveal gate,
  // but it must not then be crossfaded IN over the text — that would trade a
  // readable title for a broken-image glyph. Tracked separately from the gate
  // for exactly that reason.
  const [logoBroken, setLogoBroken] = useState(false);
  useEffect(() => { setLogoBroken(false); }, [logo]);

  // Title height changes with wrapping, which changes with window width, so
  // observe rather than measure once.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => setTextH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [name]);

  // Logo height is driven by its intrinsic aspect ratio against the max-w /
  // max-h caps, so it too moves with the window.
  useLayoutEffect(() => {
    const el = logoRef.current;
    if (!el) { setLogoH(0); return; }
    // Cache-hit guard. An image already in the browser cache can reach
    // `complete` before React attaches onLoad, so the event never fires — and
    // since the parent's reveal gate waits on it, that would strand the whole
    // hero on the ambient base. ImageLoader carries the same guard for the
    // same reason (see its src-reset effect). `onLogoSettled` is deliberately
    // out of the dep list: it's an inline arrow, so including it would re-run
    // this on every parent render.
    if (el.complete && el.naturalWidth > 0) onLogoSettled();
    const measure = () => setLogoH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logo]);

  const showLogo = !!logo && !logoBroken && revealed;
  const target   = showLogo ? logoH : textH;

  return (
    <div
      className="grid aura-detail-title-slot"
      style={{
        // Both children occupy the one cell; bottom-aligned so the crossfade
        // is anchored where the words already were and any growth happens
        // upward, matching the column's justify-end flow.
        alignItems:   "end",
        justifyItems: "start",
        height:       target > 0 ? target : undefined,
        transition:   `height ${HERO_REVEAL_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
      }}
    >
      <h1
        ref={textRef}
        className="text-white text-[64px] font-light tracking-tight leading-[0.98]"
        style={{
          gridArea:   "1 / 1",
          textShadow: "0 4px 16px rgba(0,0,0,0.95), 0 0 30px rgba(0,0,0,0.55)",
          opacity:    showLogo ? 0 : 1,
          transition: `opacity ${HERO_REVEAL_MS}ms ease-out`,
        }}
      >
        {name}
      </h1>
      {logo && (
        <img
          ref={logoRef}
          src={logo}
          alt={name}
          draggable={false}
          className="max-h-44 object-contain object-left"
          onLoad={(e) => {
            // Measure HERE, not just from the ResizeObserver. The observer
            // delivers a frame late, and that frame would render with
            // showLogo already true but logoH still 0 — i.e. height:auto,
            // the grid cell snapping straight to the logo. React batches
            // this with the parent's gate update, so the reveal commit
            // already knows the target height and the travel animates.
            setLogoH(e.currentTarget.offsetHeight);
            onLogoSettled();
          }}
          onError={() => {
            setLogoBroken(true);
            onLogoSettled();
          }}
          style={{
            gridArea: "1 / 1",
            maxWidth: "min(580px, 100%)",
            filter:
              "drop-shadow(0 6px 18px rgba(0,0,0,0.85)) drop-shadow(0 0 28px rgba(0,0,0,0.5))",
            opacity:    showLogo ? 1 : 0,
            transition: `opacity ${HERO_REVEAL_MS}ms ease-out`,
          }}
        />
      )}
    </div>
  );
}

/** Synchronous warm-start. CatalogHoverCard already fetches full meta into the
 *  shared cache on hover, so hover → click can paint the FINAL art on the
 *  first frame with no wait at all.
 *
 *  A cached entry carrying NEITHER a backdrop nor a logo is deliberately
 *  treated as a miss: latching it would lock the hero to the catalog preview
 *  and then, per the invariant above, refuse the real art when the live probe
 *  returns it. Better to wait. */
function seedHeroArt(preview: MetaPreview, resumeVideoId: string | null): HeroArt | null {
  const seed = peekRichestCachedDetailById(preview.id);
  if (!seed || !(seed.background || seed.logo)) return null;
  return heroArtFrom(seed, preview, arcHeroArt(preview.id, resumeVideoId));
}

/** Section label inside the HUD. Every Overview block gets one: without them
 *  the tab was several paragraphs of different things running together with no
 *  indication of where one ended and the next began. Matches the mono-caps
 *  label convention used throughout the app. */
/** "Your progress" — the only thing in Overview that is about the VIEWER
 *  rather than the title. Everything here comes from the library Aura already
 *  holds, so it costs nothing and works for live action too.
 *
 *  Renders nothing at all when the user has watched none of it: a row of
 *  zeroes on a show you have not started is noise, not information. */
function ProgressBlock({
  videos, seriesId,
}: {
  videos: VideoEntry[];
  seriesId: string;
}) {
  const byId = useLibraryMap();
  // Re-derives on a manual mark as well as on a progress write, matching how
  // the episode rows stay in step.
  const manualVersion = useManualWatchedVersion();

  const stats = useMemo(() => {
    // Season 0 is specials, which are not part of "have I finished this".
    const main = videos.filter((v) => (v.season ?? 1) > 0);
    if (main.length === 0) return null;
    const watched = main.filter((v) => isEpisodeWatched(byId, v.id)).length;
    return { watched, total: main.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos, byId, seriesId, manualVersion]);

  if (!stats || stats.watched === 0) return null;
  const pct = Math.round((stats.watched / stats.total) * 100);
  const remaining = stats.total - stats.watched;

  return (
    <section>
      <HudSectionLabel>Your Progress</HudSectionLabel>
      <div className="flex items-center gap-3">
        <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden min-w-0">
          <div className="h-full rounded-full bg-ln-accent/80" style={{ width: `${pct}%` }} />
        </div>
        <span className="shrink-0 text-white/80 text-[12.5px] font-mono tabular-nums">
          {stats.watched}/{stats.total}
        </span>
      </div>
      <p className="text-white/40 text-[11.5px] mt-1.5">
        {remaining === 0
          ? "Completed"
          : `${pct}% watched · ${remaining} episode${remaining === 1 ? "" : "s"} left`}
      </p>
    </section>
  );
}

function HudSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="h-px flex-1 bg-white/10" aria-hidden />
      <span className="text-white/55 text-[10.5px] font-mono uppercase tracking-[0.22em] whitespace-nowrap">
        {children}
      </span>
      <span className="h-px flex-1 bg-white/10" aria-hidden />
    </div>
  );
}

function DetailViewBody({ meta, addons, fromRect, partyStreamKey, onClose, onPlayStream, onOpenTitle, onSearchByName, inLibrary, onLibraryToggle, onQueueToggle, onPlayTrailer, openOnEpisodeId, onConsumeOpenHint, highlightEpisodeId, onConsumeHighlight, ignoreResumeHint, openInStreamsMode, onConsumeOpenInStreamsMode }: Props) {
  const [detail, setDetail]                 = useState<MetaDetail | null>(null);
  // Resume pointer, read BEFORE the latch below because the latch's seed
  // needs it synchronously on the first render to pick the right arc's art.
  // This is a pure context read, and useResumeVideoId is called again further
  // down for the resume behaviour itself; two calls are free and keep that
  // logic where it belongs.
  const heroResumeVideoId = useResumeVideoId(meta.id);
  // Queue membership IS the manual "planned" mark. Read live rather than
  // mirrored into state, and re-derived on the manual-watched version so the
  // button stays correct when the context menu toggles it from elsewhere.
  const manualWatchedVersion = useManualWatchedVersion();
  const inQueue = useMemo(
    () => getManualWatchedState(meta.id) === "planned",
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta.id, manualWatchedVersion],
  );
  // Write-once hero art (see the latch notes above the component). `null`
  // means "not settled yet" — the hero shows its ambient base and waits.
  const [heroArtLatch, setHeroArtLatch]     = useState<HeroArt | null>(
    () => seedHeroArt(meta, heroResumeVideoId),
  );
  // Decode gates for the two latched assets. The reveal waits for BOTH so the
  // backdrop and the logo land on the same frame; an asset that errors counts
  // as ready (its layer just never appears) so one dead URL can't strand the
  // hero on the ambient base forever.
  const [bgReady, setBgReady]               = useState(false);
  const [logoReady, setLogoReady]           = useState(false);
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

  // Re-arm the hero latch when the page swaps to a different id WITHOUT
  // remounting (App renders <DetailView> unkeyed, so `selectedMeta` changing
  // reuses this instance — the same reason every fetch effect below is keyed
  // on meta.id). The ref guard skips the first run so the synchronous warm
  // seed above survives mount.
  const heroKeyRef = useRef(meta.id);
  useEffect(() => {
    if (heroKeyRef.current === meta.id) return;
    heroKeyRef.current = meta.id;
    setHeroArtLatch(seedHeroArt(meta, heroResumeVideoId));
    setBgReady(false);
    setLogoReady(false);
  }, [meta]);

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
  // "N episodes behind" for an airing series (red, meta strip below). null
  // when not airing or fully caught up.
  const episodesBehind = useEpisodesBehind(detail?.videos, meta.id);

  // ── Anime extras ("More info") ──
  // The MAL entries backing the overlay, one per cour. Resolved lazily and
  // ONLY for anime, because the resolver costs a round-trip per season and
  // there is nothing to show for live action. An empty result means the
  // trigger never renders, so the button is absent rather than dead.
  const [extrasCours, setExtrasCours] = useState<CourRef[]>([]);
  const isAnimeDetail =
    isAnimeMeta(meta) || (detail?.media_type ?? "").toLowerCase() === "anime";
  useEffect(() => {
    if (!isAnimeDetail || !detail) { setExtrasCours([]); return; }
    let cancelled = false;
    (async () => {
      const cours = await resolveCourMalIds(
        detail, detail.videos ?? [], detail.name ?? meta.name,
      );
      if (!cancelled) setExtrasCours(cours);
    })();
    return () => { cancelled = true; };
  }, [isAnimeDetail, detail, meta.name]);
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
  //
  // HIGHEST-PRECEDENCE EXCEPTION: when `openInStreamsMode` is set (the EOS
  // Spotlight's EpisodePanel single-click path, 2026-05-20), force STREAMS
  // mode for the chosen `openOnEpisodeId` — skips the episodes-list
  // intermediate step so the user lands one click from playable.
  const [panelMode, setPanelMode] = useState<PanelMode>(
    openInStreamsMode
      ? "streams"
      : isEpisodic && (openOnEpisodeId || !resumeVideoId) ? "episodes" : "streams"
  );

  // One-shot consume of the streams-mode hint. Runs once on mount (deps
  // intentionally minimal); the parent clears its state on the next
  // render so a later open from an unrelated surface starts clean.
  useEffect(() => {
    if (openInStreamsMode) onConsumeOpenInStreamsMode?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snapshot the open hint into a local state at mount so we can clear
  // the parent's prop immediately (next renders pass null) without
  // losing track of WHICH episode to scroll to. Earlier code consumed
  // the prop on mount and then used the now-null prop for scrolling —
  // by the time the addon's videos array resolved, scrollToVideoId was
  // null and the EpisodesPanel landed on the top of the list instead
  // of the just-played episode.
  const [scrollOnceTo, setScrollOnceTo] = useState<string | null>(openOnEpisodeId ?? null);
  // A NEVER-cleared mount snapshot of the open-episode hint. `scrollOnceTo`
  // gets nulled once the scroll lands, and the `openOnEpisodeId` PROP is
  // consumed on mount (onConsumeOpenHint → parent sets it null next tick), so
  // neither survives long enough to drive the stream fetch / activeVideo
  // resolution for a watch-party "Join & sync" (where the episode comes only
  // from this hint). This snapshot does.
  const [openEpisodeSnapshot] = useState<string | null>(openOnEpisodeId ?? null);
  useEffect(() => {
    if (openOnEpisodeId) onConsumeOpenHint?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Notification deep-link selection ring — snapshot at mount + consume the
  // parent hint (mirrors scrollOnceTo) so a later unrelated open doesn't
  // inherit it. Persists for this mount; only the matching row in its season
  // lights up.
  const [ringEpisodeId] = useState<string | null>(highlightEpisodeId ?? null);
  useEffect(() => {
    if (highlightEpisodeId) onConsumeHighlight?.();
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
    if (!metaAddon || addons.length === 0) {
      // No addon will ever answer — settle on the catalog preview's art
      // immediately rather than leaving the hero waiting on a probe that
      // is never going to run.
      setHeroArtLatch((prev) => prev ?? heroArtFrom(null, meta, arcHeroArt(meta.id, heroResumeVideoId)));
      return;
    }
    let cancelled = false;
    const ordered: AddonEntry[] = [
      metaAddon,
      // Only fall back to addons that can ACTUALLY serve meta for THIS id.
      // Previously this sprayed /meta/<id> at every installed addon, so any
      // id the primary source (AIOMetadata) returned empty for — e.g. a
      // `kitsu:` id it doesn't resolve — triggered a burst of 404s against
      // subtitle/stream-only addons (OpenSubtitles, SubDL, AIOStreams) that
      // expose no /meta endpoint at all. Gate on the declared `meta`
      // resource AND a matching id prefix, mirroring the backend stream
      // gate (addon_entry_supports_stream_for in stremio.rs). The empty
      // meta itself is upstream (AIOMetadata); this just stops Aura from
      // 404-spamming addons that were never going to answer.
      ...addons
        .filter((a) => a.url !== metaAddon.url)
        .filter((a) => {
          if (!a.resources?.includes("meta")) return false;
          const prefixes = a.id_prefixes;
          if (prefixes && prefixes.length > 0) {
            return prefixes.some((p) => meta.id.startsWith(p));
          }
          return true; // no declared idPrefixes → addon accepts any id
        }),
    ];
    // Resolves to the detail the page ACTUALLY ended up on (or null when no
    // addon answered). The hero art latch below settles off that resolution
    // rather than off the first setDetail — see the note at the tail.
    void (async () => {
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
            return d;
          }
        } catch { /* try next addon */ }
      }
      return bestSoFar;
    })()
      .catch(() => null)
      .then((finalDetail) => {
        // ── Hero art settles HERE, and only here ──
        // Keyed on the probe loop TERMINATING, not on the first addon
        // answering. `finalDetail` is whichever detail the page actually ended
        // up on — including the with-videos one further down the list that
        // used to replace the first answer's backdrop a beat later (swap
        // source 2 in the latch notes). `prev ??` keeps the write once-only,
        // which is what makes a StrictMode double mount harmless.
        if (cancelled) return;
        setHeroArtLatch((prev) => prev ?? heroArtFrom(
          finalDetail ?? null, meta, arcHeroArt(meta.id, heroResumeVideoId),
        ));
      });
    return () => { cancelled = true; };
  }, [metaAddon, addons, meta, meta.id, meta.media_type]);

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
  // Anime if the meta says so or the resolved detail carries an
  // anime-native id (mal/kitsu/anidb). detail ids land async after the
  // meta-detail fetch, so this re-derives each render as they resolve.
  const isAnime =
    (meta.media_type ?? "").toLowerCase() === "anime" ||
    detail?.mal_id != null ||
    detail?.kitsu_id != null ||
    detail?.anidb_id != null;
  // Accurate Digital + Theatrical dates (MDBList) — drives the accurate
  // Digital countdown (replacing the +45-day estimate) and the "In
  // Theaters" tag. null for non-movies / before the fetch lands, in which
  // case the countdown falls back to the labeled estimate and the tag hides.
  const releaseDates = useMovieReleaseDates(meta.id, detail?.media_type ?? meta.media_type);
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
    // Drop sources with no usable value (empty / "0.0" — the MDBList
    // Letterboxd row for series/anime is the canonical junk), and drop
    // Letterboxd entirely for anime since it's movie-only on MDBList.
    const accept = (r: { source: string; value: string }) =>
      hasUsableRating(r.value) &&
      !(isAnime && r.source.toLowerCase() === "letterboxd");
    const map = new Map<string, RatingRow>();
    for (const r of detail?.ratings ?? []) {
      if (accept(r)) map.set(r.source.toLowerCase(), { source: r.source, value: r.value });
    }
    for (const r of aggregateRatings) {
      if (accept(r)) map.set(r.source.toLowerCase(), r);
    }
    // For anime, surface the anime-native sources first — MAL score,
    // AniList, then MAL rank & popularity — so the detail page shows the
    // same MAL trio the hover card does instead of letting IMDb/RT/MC
    // crowd them past the six-tile cap. Otherwise sort by aggregator
    // weight DESC (IMDb 100, MAL 95, RT 90, …; addon-only sources 50).
    const ANIME_FIRST = ["myanimelist", "anilist", "mal rank", "mal popularity"];
    const sorted = [...map.values()].sort((a, b) => {
      if (isAnime) {
        const ai = ANIME_FIRST.indexOf(a.source.toLowerCase());
        const bi = ANIME_FIRST.indexOf(b.source.toLowerCase());
        if (ai !== bi) {
          if (ai === -1) return 1;
          if (bi === -1) return -1;
          return ai - bi;
        }
      }
      return (b.weight ?? 50) - (a.weight ?? 50);
    });
    return groupRatingsByBrand(sorted);
  }, [detail?.ratings, aggregateRatings, isAnime]);

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
    // `openEpisodeSnapshot` is the explicitly-requested episode (e.g. a
    // watch-party "Join & sync" lands here with the room's videoKey). Use the
    // mount-stable SNAPSHOT (not the live prop, which is consumed/nulled on
    // mount) as the final fallback so streams fetch for the RIGHT episode even
    // before the meta detail's `videos` array resolves (activeVideo null) and
    // when Stremio's library state.video_id (resumeVideoId) is stale/absent.
    const episodicId = activeVideo?.id ?? resumeVideoId ?? openEpisodeSnapshot;
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
  }, [addons, meta.id, meta.media_type, activeVideo, resumeVideoId, isEpisodic, openEpisodeSnapshot]);

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

  // EOS Spotlight EpisodePanel single-click path (2026-05-20): when
  // `openInStreamsMode` AND `openOnEpisodeId` are both set, snap
  // `activeVideo` to the CLICKED episode (not the last-played one
  // from state.video_id). Without this the streams panel would render
  // streams for whatever Stremio's state.video_id last stamped (the
  // just-finished episode), not the episode the user explicitly
  // picked in the in-player panel. Runs once when videos arrive; the
  // existing resume effect above is skipped because activeVideo is
  // already set after this fires. resolveResumeEpisode handles
  // legacy id-shape mismatches (cour-aggregation, etc.) — same
  // resilience the resume path gets.
  useEffect(() => {
    if (activeVideo) return;
    if (!isEpisodic) return;
    if (!openInStreamsMode) return;
    // Use the mount-stable snapshot — the live prop is nulled on mount, which
    // would otherwise leave activeVideo unset (and the streams panel empty)
    // once detail.videos finally resolve.
    if (!openEpisodeSnapshot) return;
    const v = resolveResumeEpisode(openEpisodeSnapshot, detail?.videos);
    if (v) setActiveVideo(v);
  }, [detail?.videos, openInStreamsMode, openEpisodeSnapshot, isEpisodic, activeVideo]);

  // Notification deep-link: populate the episode synopsis by selecting the
  // ringed episode — WITHOUT switching to streams mode (stay on the list so the
  // user sees the ring + scroll + synopsis together). Guarded on panelMode so it
  // never fights a real episode click (which routes to streams).
  useEffect(() => {
    if (!ringEpisodeId) return;
    if (activeVideo) return;
    if (panelMode === "streams") return;
    if (!isEpisodic) return;
    const v = resolveResumeEpisode(ringEpisodeId, detail?.videos);
    if (v) setActiveVideo(v);
  }, [ringEpisodeId, detail?.videos, panelMode, isEpisodic, activeVideo]);

  const groupedStreams = useMemo(() => {
    const map = new Map<string, StreamEntry[]>();
    for (const s of streams) {
      const list = map.get(s.addon_name) ?? [];
      list.push(s);
      map.set(s.addon_name, list);
    }
    return [...map.entries()];
  }, [streams]);

  // Hero art — read from the LATCH, never from `detail`. That indirection is
  // the whole fix: these two are null while the art is still resolving and
  // then take a value exactly once, so the <img> they feed never sees a second
  // src (which is what tripped ImageLoader's src-change reset back to a
  // skeleton mid-view).
  const heroArt = heroArtLatch?.background ?? null;
  const logoArt = heroArtLatch?.logo ?? null;

  // The single reveal beat: every latched asset has decoded. Both gates are
  // vacuously true when the corresponding art is absent, so an item with no
  // logo reveals as soon as its backdrop is ready, and an item with no art at
  // all reveals the moment it settles.
  const revealed =
    heroArtLatch !== null &&
    (!heroArt   || bgReady) &&
    (!logoArt   || logoReady);

  // Bounded wait on the logo only. Coupling the two assets is the point — it's
  // what makes the hero settle once — but an <img> whose request stalls fires
  // neither load nor error, and without a bound one hung logo would hold a
  // perfectly good backdrop off screen indefinitely. After this grace period
  // we let the reveal go; a logo that lands later simply fades in then. The
  // BACKDROP has no equivalent bound on purpose: if it never arrives there is
  // nothing to reveal, and the ambient base is already the correct resting
  // state.
  useEffect(() => {
    if (!logoArt || logoReady) return;
    const t = setTimeout(() => setLogoReady(true), 1200);
    return () => clearTimeout(t);
  }, [logoArt, logoReady]);
  // Series poster used as the thumbnail for UNAIRED episodes (instead of a
  // blurred frame) — portrait poster cropped to the 16:9 thumb.
  const episodeFallbackArt = detail?.poster ?? detail?.background ?? meta.poster ?? null;

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
    // EPISODE id mirrors the streams-fetch `episodicId` resolution: when
    // `video` hasn't resolved yet — a Watch-Together member joining the party's
    // episode (openVideo → streams mode, before detail.videos load), or an EOS
    // streams-mode open — fall back to the REQUESTED episode (resumeVideoId /
    // openEpisodeSnapshot) BEFORE meta.id. Without this the target was keyed at
    // the SERIES ROOT, so the played target didn't match the streams we fetched
    // (for the episode) and a joining party member's videoKey was the root and
    // never matched the leader's episode (party "stuck 1 of N", follower never
    // in-sync).
    id:         isEpisodic
                  ? (video?.id ?? resumeVideoId ?? openEpisodeSnapshot ?? meta.id)
                  : (video?.id ?? meta.id),
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
      {/* Ambient base — ALWAYS mounted and fully opaque. Three jobs:
            1. it's what the user looks at while the art resolves,
            2. it stops the page underneath (Home) bleeding through the
               semi-transparent overlay gradients below during the open
               animation — the overlays never had an opaque layer beneath
               them, which is why Aura flashed into view on a cold open,
            3. it's the resting state when an item has no art, or when the
               backdrop 404s after exhausting its retries.
          Two elements, not one: the ambient layer is `filter: blur(28px)`,
          and a blur has nothing beyond the element's own box to sample, so it
          fades its outermost ~28 px toward transparent — on its own it would
          still let a rim of Home through at the frame edge. The flat fill
          underneath makes the base opaque edge to edge. */}
      <div aria-hidden className="absolute inset-0" style={{ background: "rgb(8 10 14)" }} />
      <div aria-hidden className="detail-backdrop-skeleton" />
      {/* Full-bleed backdrop. Mounted only once the art has latched, so its
          `src` is fixed for the element's whole life. `loading="eager"`
          skips the IntersectionObserver round-trip — this fills the viewport
          by definition, there is nothing to defer. */}
      {heroArt && (
        <ImageLoader
          src={shrinkPoster(heroArt, screenWidthHint())}
          alt=""
          loading="eager"
          decoding="async"
          draggable={false}
          className="absolute inset-0 w-full h-full"
          imgClassName="w-full h-full object-cover"
          imgStyle={{
            objectPosition: "center top",
            // Overrides ImageLoader's own 300 ms `loaded` fade (imgStyle
            // spreads last) so the backdrop rides the SHARED reveal beat with
            // the title→logo crossfade instead of running on its own clock.
            opacity:    revealed ? 1 : 0,
            transition: `opacity ${HERO_REVEAL_MS}ms ease-out`,
          }}
          // The ambient base above already covers the box; a second opaque
          // skeleton stacked on top of it was the "blank screen" flash.
          skeletonClassName="detail-backdrop-idle"
          onLoad={() => setBgReady(true)}
          onError={() => setBgReady(true)}
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
        {/* `overflow-hidden`, NOT `overflow-y-auto`. The column used to scroll,
            which meant reaching the cast list scrolled the artwork off screen
            too. The HUD below owns its own overflow now, so nothing here needs
            to move and the hero is always on screen. `min-h-0` lets the HUD
            actually honour its height cap: a flex child refuses to shrink below
            its content without it, and the cap would silently do nothing. */}
        <section className="min-w-0 h-full px-12 pt-24 pb-10 flex flex-col justify-end
                            overflow-hidden gap-7 min-h-0">
          {/* Identity keeps a reading-width cap: a title, a meta line and two
              buttons stretched across half an ultrawide would look lost. The
              HUD below deliberately does NOT inherit it, because its whole job
              is to use that width in columns. */}
          <div className="space-y-7 shrink-0" style={{ maxWidth: "min(720px, 100%)" }}>
            {/* Logo or title — bumped ~30% bigger. Crossfades on the shared
                hero reveal beat; see HeroTitle. */}
            <HeroTitle
              name={detail?.name ?? meta.name}
              logo={logoArt}
              revealed={revealed}
              onLogoSettled={() => setLogoReady(true)}
            />

            {/* Dense meta strip.
                Readability over bright hero art (e.g. a light anime
                character face) is handled two ways:
                  1. A localized scrim "plate" — a left-anchored dark
                     gradient that fades to transparent on the right. It
                     bleeds horizontally (negative L/R margin) and adds a
                     little vertical padding, but deliberately sets NO
                     top/bottom margin so the parent `space-y-7` rhythm is
                     untouched. Unlike the hero's bottom gradient, this
                     travels WITH the strip, so it backs the text wherever
                     the content column places it (the strip sits mid-art,
                     not at the bottom edge).
                  2. text-shadow, which inherits to every chip / Stat /
                     countdown glyph for a dark halo on top of the plate.
                Together they keep the mid-tone mono text and the accent
                countdown legible on any backdrop. */}
            <div
              className="flex items-center gap-3 flex-wrap text-[14px] font-mono uppercase tracking-[0.14em]"
              style={{
                textShadow: "0 1px 4px rgba(0,0,0,0.92), 0 0 10px rgba(0,0,0,0.6)",
                background:
                  "linear-gradient(100deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.44) 50%, rgba(0,0,0,0) 100%)",
                paddingTop: "7px",
                paddingBottom: "7px",
                paddingLeft: "14px",
                paddingRight: "28px",
                marginLeft: "-14px",
                marginRight: "-28px",
                borderRadius: "10px",
              }}
            >
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
                <span className="px-2.5 py-1 rounded-sm bg-pink-500/25 border border-pink-400/40
                                 text-pink-100 text-[12px] font-semibold backdrop-blur-sm">Anime</span>
              )}
              <span className="px-2.5 py-1 rounded-sm bg-black/35 border border-white/25
                               text-white/90 text-[12px] font-semibold backdrop-blur-sm">
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
              {episodesBehind != null && (
                <span className="text-red-400 text-[13px] font-semibold">
                  {episodesBehind} episode{episodesBehind === 1 ? "" : "s"} behind
                </span>
              )}
              {/* Persistent "In Theaters" tag — shown while a film's
                  theatrical run is active (theatrical date passed, not yet
                  digital, within the freshness window) per MDBList dates.
                  Unlike the cinematic countdown (which vanishes once
                  `released` passes), this is a static badge, not a ticking
                  value. Movies only; hidden until accurate dates resolve. */}
              {detail && isInTheaters(detail.media_type ?? meta.media_type, releaseDates) && (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-sm
                             bg-amber-500/20 border border-amber-400/40 text-amber-100
                             text-[12px] font-semibold backdrop-blur-sm"
                  title="Currently in theaters"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M22 10V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2s.9-2 2-2z" />
                  </svg>
                  In Theaters
                </span>
              )}
              {/* Live release countdown(s) — MOVIES ONLY here. Series/anime
                  next-episode/premiere countdowns now live on the episode
                  list (the next-airing row's chip), so the meta strip carries
                  only a film's cinematic / digital dates. The Digital date is
                  the authoritative MDBList value when known; otherwise the
                  ~45-day PVOD estimate (rendered with a "~" prefix).
                  computeReleaseCountdowns returns only upcoming dates, so
                  nothing renders for fully-released content. */}
              {detail && computeReleaseCountdowns(detail, Date.now(), releaseDates)
                .filter((c) => c.kind === "cinematic" || c.kind === "digital")
                .map((c) => (
                <CountdownStat
                  key={c.kind}
                  label={c.label}
                  targetMs={c.targetMs}
                  estimated={c.estimated}
                  title={`${c.label}${c.estimated ? " (estimated)" : ""}: ${formatTargetDate(c.targetMs)}`}
                />
              ))}
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
              <div
                className="flex items-center gap-2.5 flex-wrap -mt-1"
                style={{ textShadow: "0 1px 3px rgba(0,0,0,0.85)" }}
              >
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

            {/* Action row — Library add/remove + Watch Trailer (when the addon
                emits one). Sits below the meta strip so it never moves around
                when ratings or runtime fields appear/disappear. */}
            {(onLibraryToggle || onQueueToggle || (detail?.trailer_yt_id && onPlayTrailer)) && (
              <div className="flex items-center gap-3 -mt-2">
                {onLibraryToggle && (
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
                )}
                {/* Queue — the same "planned" state the catalog context menu
                    sets, so both routes obey one rule set: marking planned
                    auto-adds to the library, and removing from the library
                    clears the planned mark. Reads through
                    getManualWatchedState rather than holding its own copy, and
                    re-renders on the manual-watched version so the two stay in
                    step when the other route is used. */}
                {onQueueToggle && (
                  <button
                    type="button"
                    onClick={(e) => onQueueToggle({ x: e.clientX, y: e.clientY })}
                    className={`group/queue flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium
                                border transition-colors duration-150
                                ${inQueue
                                  ? "bg-ln-accent/20 text-ln-accent border-ln-accent/40 hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-300/40"
                                  : "bg-white/8 text-white/85 border-white/15 hover:bg-ln-accent/20 hover:text-ln-accent hover:border-ln-accent/40"
                                }`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
                    </svg>
                    {inQueue ? (
                      <>
                        <span className="group-hover/queue:hidden">In Queue</span>
                        <span className="hidden group-hover/queue:inline">Remove from Queue</span>
                      </>
                    ) : (
                      <span>Add to Queue</span>
                    )}
                  </button>
                )}
                {/* Watch Trailer — plays the title's YouTube trailer in Aura's
                    own MPV player (yt-dlp resolves a direct CDN URL). Sits to
                    the RIGHT of the library button; only shown when the addon
                    meta carried a trailer id. */}
                {detail?.trailer_yt_id && onPlayTrailer && (
                  <button
                    type="button"
                    onClick={() => onPlayTrailer(detail.trailer_yt_id!, detail?.name ?? meta.name)}
                    className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-medium
                               border transition-colors duration-150
                               bg-white/8 text-white/85 border-white/15
                               hover:bg-ln-accent/20 hover:text-ln-accent hover:border-ln-accent/40"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5v14l11-7z" />
                    </svg>
                    <span>Watch Trailer</span>
                  </button>
                )}
              </div>
            )}


          </div>

          {/* ── Metadata HUD ──
                Everything that used to stack below the actions now lives in one
                height-capped panel behind a tab bar. That is what keeps the PAGE
                unscrollable: the panel scrolls its own content instead, so the
                artwork and the resume action never leave the screen, and a new
                field costs a tab rather than another 80px of column. */}
          <DetailHud
            resetKey={meta.id}
              cours={extrasCours}
              onPlayTrailer={onPlayTrailer}
              onOpenTitle={onOpenTitle}
              onSearchTitle={onSearchByName ? (n) => { onSearchByName(n); onClose(); } : undefined}
              overview={(
                // Two EXPLICIT columns rather than a flat grid of sections.
                // Auto-flow put one section per cell in source order, which
                // left the short blocks stranded beside the very tall Details
                // list. Assigning them by hand keeps the prose on the left and
                // stacks the fact-shaped blocks on the right, so the tall one
                // is balanced by two rather than by whitespace. Collapses to a
                // single flow below the breakpoint, where the source order is
                // the reading order.
                <div className="grid gap-x-8 gap-y-5 items-start
                                grid-cols-1 min-[1500px]:grid-cols-2
                                [&>*]:min-w-0">

                  {/* Synopsis — larger size + weight for "Command Center" presence.
                      Season-aware: when a season is selected and that season has
                      its own overview (season_credits[s].overview), show it
                      instead of the show-level description, falling back to the
                      show description when absent. Populated for TMDB/TVDB
                      live-action seasons; empty for MAL/Kitsu anime (it then
                      falls through to the show description until AIOMetadata
                      surfaces per-season overviews). */}
            {/* ── Synopsis ──
                ONE slot, not two. The show synopsis and the selected episode's
                synopsis were stacked, so picking an episode grew the column and
                left two blocks of prose competing. They now REPLACE each other:
                selecting an episode swaps this section to that episode, and
                deselecting swaps it back.

                The swap is animated because of where it happens. Episodes are
                picked at the far RIGHT of the page and this sits at the far
                LEFT, so a silent substitution is easy to miss entirely; the
                slide makes the cause and effect legible across that distance.
                Keyed on the source id so React remounts and replays it. */}
            <SynopsisSection
              showText={(() => {
                const seasonOverview =
                  selectedSeason != null && detail?.season_credits
                    ? detail.season_credits[String(selectedSeason)]?.overview
                    : null;
                return typeof seasonOverview === "string" && seasonOverview.trim()
                  ? seasonOverview
                  : (detail?.description ?? meta.description) ?? null;
              })()}
              activeVideo={activeVideo}
              isWatched={
                activeVideo ? getManualWatchedState(activeVideo.id) === "watched" : false
              }
              revealed={activeVideo ? revealedSynopses.has(activeVideo.id) : false}
              onReveal={(id) => {
                setRevealedSynopses((prev) => {
                  const next = new Set(prev);
                  next.add(id);
                  return next;
                });
              }}
            />

                  {/* Production, moved out of the Cast tab. Cast is people; this is
                the title. It also gives Overview's second column something to
                hold besides a genre strip, which is what made the panel read
                as mostly empty. */}
            {/* MAL facts: source, status, premiere, rating, demographic,
                studios, producers, licensors. All of it was already arriving in
                the cached /full payload and being discarded, so it costs no
                request, and none of it repeats another tab. */}

            {/* ── Details ──
                One list, not three. Genres come from the addon and the rest
                from MAL's cached /full payload, but they are all the same KIND
                of fact, so they share one label-value grid instead of sitting
                in separate blocks with different shapes. Rendered as rows
                rather than chips so they align with everything around them. */}
            {/* RIGHT column: the fact-shaped blocks, stacked. Progress sits
                UNDER Details rather than beside the synopsis, which is what
                fills the space the tall fact list leaves below itself. */}
            <div className="flex flex-col gap-5 min-w-0">
            {(() => {
              const leading: [string, string][] = [];
              if (detail?.genres?.length) {
                leading.push(["Genres", detail.genres.join(", ")]);
              }
              if (detail?.country) leading.push(["Country", detail.country]);
              // Studios only when MAL will not supply them; for anime the fact
              // list below carries a richer version.
              if (extrasCours.length === 0 && detail?.studios?.length) {
                leading.push([
                  detail.studios.length > 1 ? "Studios" : "Studio",
                  detail.studios.join(", "),
                ]);
              }
              if (!leading.length && extrasCours.length === 0) return null;
              return (
                <section>
                  <HudSectionLabel>Details</HudSectionLabel>
                  {extrasCours.length > 0
                    ? <FactsBlock cours={extrasCours} leading={leading} />
                    : <FactList items={leading} />}
                </section>
              );
            })()}
            <ProgressBlock videos={detail?.videos ?? []} seriesId={meta.id} />
            </div>


                </div>
              )}
              cast={(
                <div className="space-y-5">
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

                    {detail?.voice_actors && detail.voice_actors.length > 0 && !voiceActorsDuplicateCast(detail) &&
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
                  </div>
                </div>
            )}
          />
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
            partyStreamKey={partyStreamKey}
            isEpisodic={isEpisodic}
            seriesId={meta.id}
            seriesMediaType={meta.media_type}
            detail={detail}
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
            onPlayExternal={(url) => openExternalUrl(url)}
            scrollToVideoId={scrollOnceTo}
            highlightVideoId={ringEpisodeId}
            seriesArt={episodeFallbackArt}
            onScrollHandled={handleScrollHandled}
            // Per-season display names (e.g. anime cour titles like "Stone
            // Wars") keyed by season number, for the label under the season
            // dropdown. Populated for TMDB/TVDB live-action seasons; EMPTY
            // for MAL/Kitsu anime today (so nothing renders until
            // AIOMetadata surfaces season_credits[n].name for anime). Only
            // non-empty names are forwarded.
            seasonNames={(() => {
              const sc = detail?.season_credits;
              if (!sc) return undefined;
              const out: Record<string, string> = {};
              for (const [k, v] of Object.entries(sc)) {
                if (typeof v?.name === "string" && v.name.trim()) out[k] = v.name;
              }
              return Object.keys(out).length ? out : undefined;
            })()}
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

// Accent-coloured sibling of Stat for the live release countdown — same
// baseline layout as the surrounding meta tiles so it sits cleanly in the
// strip, but tinted with the theme accent + a clock glyph to read as a
// "time until" element rather than a static fact. `title` carries the full
// target date for hover.
//
// Owns its OWN 1 s tick via useCountdownNow so only this leaf re-renders
// every second — DetailViewBody (cast grid, episode list, ratings) must NOT
// tick. The parent computes the countdown SET once and passes targetMs.
function CountdownStat({ label, targetMs, title, estimated }: { label: string; targetMs: number; title?: string; estimated?: boolean }) {
  const now = useCountdownNow();
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" className="text-ln-accent/80" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="text-ln-accent/70 text-[11px] tracking-[0.2em]">{label}</span>
      <span className="text-ln-accent text-[14px] font-semibold tabular-nums">
        {/* "~" marks an estimated (PVOD-window) date vs an authoritative one. */}
        {estimated ? "~" : ""}{formatCountdown(targetMs, now)}
      </span>
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
/**
 * The Overview synopsis slot. Shows the series description, or the SELECTED
 * episode's description when one is picked, never both.
 *
 * Stacking them was the previous shape and it had two problems: the column
 * grew whenever an episode was chosen, and two blocks of prose sat competing
 * for the same attention. Replacement solves both, but replacement alone is
 * easy to MISS: episodes are selected at the far right of the page and this
 * lives at the far left, so the eye is nowhere near the thing that changed.
 * Hence the slide, which is loud enough to catch peripherally and short
 * enough not to be a nuisance on every episode click.
 */
function SynopsisSection({
  showText, activeVideo, isWatched, revealed, onReveal,
}: {
  showText: string | null;
  activeVideo: VideoEntry | null;
  isWatched: boolean;
  revealed: boolean;
  onReveal: (id: string) => void;
}) {
  const [blurOn, setBlurOn] = useState(() => loadAuraSettings().blurEpisodeSynopsis);
  useEffect(() => {
    const sync = () => setBlurOn(loadAuraSettings().blurEpisodeSynopsis);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  const epText = (activeVideo?.overview ?? "").trim();
  // An episode with no overview of its own falls back to the show, rather than
  // blanking the slot for the sake of consistency.
  const isEpisode = !!activeVideo && !!epText;
  const body = isEpisode ? epText : (showText ?? "");
  if (!body) return null;

  const s = activeVideo?.season;
  const e = activeVideo?.episode;
  const seCode =
    isEpisode && s != null && e != null
      ? `S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`
      : null;
  const title = (activeVideo?.title ?? "").trim();
  const subLine = isEpisode ? (seCode && title ? `${seCode} — ${title}` : seCode ?? title) : null;

  const shouldBlur = isEpisode && blurOn && !isWatched && !revealed;

  return (
    <section aria-label={isEpisode ? "Selected episode synopsis" : "Synopsis"}>
      <HudSectionLabel>{isEpisode ? "Episode Synopsis" : "Synopsis"}</HudSectionLabel>
      {/* `key` is the whole mechanism: changing it remounts the subtree, which
          replays the entrance animation. Without it React would reconcile the
          same node and silently swap the text with no transition at all. */}
      <div key={isEpisode ? activeVideo!.id : "__show__"} className="aura-synopsis-swap">
        {subLine && (
          <p className="text-white/55 text-[11.5px] mb-1.5 font-mono">{subLine}</p>
        )}
        <div className="relative max-w-[68ch]">
          <p
            className={[
              "text-white/90 text-[14px] leading-[1.62] tracking-[0.005em]",
              "transition-[filter] duration-200",
              shouldBlur ? "select-none" : "selectable",
            ].join(" ")}
            style={{
              filter: shouldBlur ? "blur(8px) saturate(120%)" : "none",
              userSelect: shouldBlur ? "none" : "text",
            }}
          >
            {body}
          </p>
          {shouldBlur && activeVideo && (
            <button
              type="button"
              onClick={() => onReveal(activeVideo.id)}
              aria-label="Reveal episode synopsis"
              className="absolute inset-0 cursor-pointer"
            />
          )}
        </div>
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

/** Collapse duplicate credit entries by (name, character). A voice actor
 *  legitimately voicing two characters ("Name as A" / "Name as B") is kept
 *  because the character differs; an exact repeat (a richer addon listing the
 *  same person+role twice, seen on some AIOMetadata anime rosters) is dropped.
 *  Applied inside CreditRow so every row (cast, voice actors, producers,
 *  studios, ...) is deduped uniformly. */
function dedupeCredits(entries: CreditEntry[]): CreditEntry[] {
  const byKey = new Map<string, CreditEntry>();
  const order: string[] = [];
  for (const e of entries) {
    const key = `${e.name.trim().toLowerCase()}|${(e.character ?? "").trim().toLowerCase()}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, e); order.push(key); continue; }
    // Same person+role listed twice: keep one, but backfill the richer fields
    // (portrait, episode tier) from whichever copy has them so a null-photo
    // first copy doesn't blank a headshot the second copy carried.
    if ((!existing.photo && e.photo) || (existing.episode_count == null && e.episode_count != null)) {
      byKey.set(key, {
        ...existing,
        photo: existing.photo ?? e.photo,
        episode_count: existing.episode_count ?? e.episode_count,
        total_show_episodes: existing.total_show_episodes ?? e.total_show_episodes,
      });
    }
  }
  return order.map((k) => byKey.get(k)!);
}

/** Every person name that the (season-aware) Cast row could show, across all
 *  cast sources. Used to detect a redundant Voice Actors row. */
function collectCastNames(detail: MetaDetail | null): Set<string> {
  const set = new Set<string>();
  if (!detail) return set;
  const add = (n: unknown) => {
    if (typeof n === "string") { const t = n.trim().toLowerCase(); if (t) set.add(t); }
  };
  for (const c of detail.cast_detailed ?? []) add(c.name);
  for (const n of detail.cast ?? []) add(n);
  for (const c of detail.aggregate_credits?.cast ?? []) add(c.name);
  for (const roster of Object.values(detail.season_credits ?? {})) {
    for (const c of roster?.cast ?? []) add(c.name);
  }
  return set;
}

/** Anime / animation report their voice ensemble twice: once as the richer
 *  Cast (voice actor paired to character, with portraits) and again as a bare
 *  Voice Actors name list. When the Voice Actors are substantially the same
 *  people we already show as Cast, the row is pure duplication, so suppress it
 *  and keep the richer Cast. Live-action + genuinely-separate dub casts overlap
 *  little and are unaffected (the row stays). Threshold: >= 60% of the voice
 *  actors already appear in the cast. */
function voiceActorsDuplicateCast(detail: MetaDetail | null): boolean {
  const rawVas = detail?.voice_actors ?? [];
  if (rawVas.length === 0) return false;
  const castNames = collectCastNames(detail);
  if (castNames.size === 0) return false;
  // Measure overlap on UNIQUE voice-actor names (the same list the row renders
  // after dedupeCredits). Anime rosters sometimes repeat a name; dividing by the
  // raw length would let those repeats inflate the ratio and hide a row that
  // still carries unique voice actors.
  const vaNames = new Set<string>();
  for (const v of rawVas) {
    if (typeof v === "string") { const t = v.trim().toLowerCase(); if (t) vaNames.add(t); }
  }
  if (vaNames.size === 0) return false;
  let dup = 0;
  for (const v of vaNames) if (castNames.has(v)) dup += 1;
  return dup / vaNames.size >= 0.6;
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
  const cleaned = dedupeCredits(values.filter((v) => !!v.name && v.name.trim().length > 0));
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
// SeasonSelect — EXTRACTED to ../SeasonSelect (EOS Spotlight spec
// 2026-05-19, Phase 3). The implementation moved VERBATIM so the EOS
// in-player EpisodePanel and this DetailView share one byte-identical
// dropdown; behaviour is unchanged. Imported at the top of this file.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// UnifiedPanel — the compact RIGHT column. Swaps between Episodes and Streams.
// ---------------------------------------------------------------------------

interface PanelProps {
  mode: PanelMode;
  partyStreamKey?: string | null;
  isEpisodic: boolean;
  seriesId: string;
  /** "series" / "anime" — drives the meta-cache URL lookup that
   *  EpisodeRow's auto-advance uses to find the next episode. */
  seriesMediaType: string;
  /** Full meta. Only the episodes panel uses it, to resolve story arcs (which
   *  need the anime signals + the TMDB id, not just the video list). */
  detail?: MetaDetail | null;
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
  /** Per-season display names keyed by season number (string), for the
   *  label under the season dropdown. Undefined when no named seasons. */
  seasonNames?: Record<string, string>;
  /** Notification deep-link: row matching this id gets a selection ring. */
  highlightVideoId?: string | null;
  /** Series poster shown as the thumbnail for unaired episodes. */
  seriesArt?: string | null;
}

function UnifiedPanel({
  mode, partyStreamKey, isEpisodic, seriesId, seriesMediaType, videos, activeVideo, streams, streamMeta, streamsLoading,
  groupedStreams, metaLoading, onPickEpisode, onBackToEpisodes, onPlay, onCopy, onPlayExternal,
  scrollToVideoId, onScrollHandled, seasonHint, seasonNames, highlightVideoId, seriesArt, detail,
}: PanelProps) {
  // Absolute-episode annotation for the streams header (e.g. "(E88)" next to
  // S04E30 on a saga show). Memoised on the episode list so a One-Piece-sized
  // list is not re-walked on every stream-panel re-render.
  const streamAbsoluteTag = useMemo(() => {
    if (!activeVideo) return "";
    const abs = absoluteEpisodeMap(videos).get(activeVideo.id);
    return formatAbsoluteEpisode(seriesId, activeVideo.episode, abs);
  }, [videos, activeVideo, seriesId]);

  // The streams panel needs `position: relative` so the floating AIOStreams
  // status icons (rendered with `absolute -top-3 -left-3`) anchor to its
  // top-left edge instead of escaping the entire detail view.
  return (
    // The panel reads as a defined card: a crisp 1px border (brighter along the
    // top edge for a lit-from-above feel) plus the elevation shadow — replacing
    // the old alpha-fade edge mask that left the outer edges undefined. overflow
    // stays visible so floating status icons can anchor just outside the corner.
    <div
      className="aura-hud-surface relative flex flex-col h-full rounded-xl
                 border-t-white/[0.16]
                 shadow-[0_24px_48px_-18px_rgba(0,0,0,0.7)]
                 [overflow:visible]"
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
            seasonNames={seasonNames}
            highlightVideoId={highlightVideoId}
            seriesArt={seriesArt}
            detail={detail}
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
              partyStreamKey={partyStreamKey}
              onBack={isEpisodic ? onBackToEpisodes : undefined}
              onPlay={onPlay}
              onCopy={onCopy}
              onPlayExternal={onPlayExternal}
              absoluteTag={streamAbsoluteTag}
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
  video, seriesId, seriesMediaType, isActive, onPick, seasonVideos, isNextAiring, isDeepLinked, seriesArt, seriesName, groupLabel = "season", absoluteNumber = null, absoluteTag = "",
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
  /** Whole-series absolute episode number, shown INSTEAD of the addon's
   *  per-season `video.episode` when in Arcs mode. A cross-season arc otherwise
   *  labels its rows with per-season numbers that jump around (E49, E03, ...) and
   *  contradict the arc card's absolute `E101-E208` range. Null in season mode,
   *  where the per-season number is the right thing to show. */
  absoluteNumber?: number | null;
  /** Absolute-episode annotation ("(E88)") shown AFTER the per-season number in
   *  season mode on a saga show; empty otherwise. In arc mode the row already
   *  shows the absolute number itself, so this is ignored there. */
  absoluteTag?: string;
  /** What `seasonVideos` actually IS, for the confirmation toast. In Arcs mode
   *  the visible list is a story arc, not a season, and "Marked watched · all in
   *  season" would be a lie about what the user just did. */
  groupLabel?: string;
  /** True for the single earliest-future-dated episode across the series
   *  (computed once by the panel). Drives the live "Airs in …" chip. */
  isNextAiring?: boolean;
  /** True for the notification deep-linked episode — adds a selection ring. */
  isDeepLinked?: boolean;
  /** Series poster — thumbnail fallback for unaired episodes. */
  seriesArt?: string | null;
  /** Series display name. Only used to label a skip's history row, which needs
   *  the show name rather than the episode's. */
  seriesName?: string | null;
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

  // Unaired = a parseable FUTURE air date. isVideoAired treats missing /
  // unparseable dates as aired, so undated specials stay untouched. The
  // next-airing row (flagged by the panel) shows the live countdown chip;
  // later unaired rows show a static "Airs <date>" + the same dim veil.
  const unaired = !isVideoAired(video);
  const airMs = unaired && video.released ? Date.parse(video.released) : null;

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
        // A skip IS a watched mark plus an annotation, so this is read from the
        // skip store rather than from `manual`.
        const isSkippedEp = isSkipped(video.id);
        const epLabel = video.episode != null
          ? `Episode ${video.episode}`
          : video.title || "Episode";

        // Everything the history row and a later manual scrobble need. Built
        // here because this is the only scope holding both the VideoEntry and
        // the series identity.
        const skipTargetFor = (v: VideoEntry): SkipTarget => ({
          id: v.id,
          parentId: seriesId,
          name: seriesName ?? seriesId,
          mediaType: seriesMediaType,
          season: v.season,
          episode: v.episode,
          episodeTitle: v.title ?? null,
          poster: seriesArt ?? null,
          background: null,
          anilistId: (v as { anilist_id?: number | null }).anilist_id ?? null,
          anilistEpisode: (v as { anilist_episode?: number | null }).anilist_episode ?? null,
        });

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
            label: `Mark all in this ${groupLabel} as watched`,
            tone: "success",
            icon: checkIcon,
            onClick: bulkAction(allSet, "watched", `all in ${groupLabel}`),
          });
        }
        if (allSet.length > 1 && allSet.some((v) => getManualWatchedState(v.id) === "watched")) {
          bulkItems.push({
            kind: "action",
            label: `Unmark all in this ${groupLabel} as watched`,
            icon: checkIcon,
            onClick: bulkAction(allSet, null, `all in ${groupLabel}`),
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
            label: isSkippedEp ? "Unmark Skipped" : "Mark as Skipped",
            icon: (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
              </svg>
            ),
            onClick: () => {
              if (isSkippedEp) {
                clearEpisodesSkipped([video.id]);
                showFlyUpToast(`Unmarked · ${epLabel}`, { x, y });
                return;
              }
              // MANUAL skip: marks and writes history, but never scrobbles.
              // Aura has never pushed a manual mark to Trakt or AniList and
              // this does not change that; the automatic skip paths are the
              // ones that scrobble. See skipActions.ts.
              void markEpisodesSkipped(
                [skipTargetFor(video)],
                { userInitiated: false, autoScrobbleEnabled: false, scrobbleScope: null },
              );
              showFlyUpToast(`Skipped · ${epLabel}`, { x, y, tone: "success" });
              window.dispatchEvent(new CustomEvent("aura:auto-advance-watched", {
                detail: { seriesId, episodeId: video.id, mediaType: seriesMediaType },
              }));
            },
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
                    : "border-transparent hover:bg-white/6 border-white/0"}${isDeepLinked ? " ring-2 ring-ln-accent/80" : ""}`}
    >
      <div
        className="relative flex-shrink-0 w-40 rounded overflow-hidden bg-white/5 border border-white/10"
        style={{ aspectRatio: "16 / 9" }}
      >
        {unaired && seriesArt ? (
          <ImageLoader
            src={seriesArt}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
          />
        ) : video.thumbnail ? (
          <ImageLoader
            src={shrinkPoster(video.thumbnail, 360)}
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

        {/* Unaired veil — dims upcoming episodes so they read as "not yet
            available" at a glance. Above the image, below the badges /
            progress bar so those stay legible. */}
        {unaired && (
          <div aria-hidden className="absolute inset-0 bg-black/45" />
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
          return (
            <FillerRecapTags
              filler={showFiller}
              recap={showRecap}
              className="absolute top-1.5 right-1.5"
            />
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

        {/* Next-to-air countdown — CW-tile-style pill overlaid on the art.
            Only the single next-airing episode renders it (one live tick). */}
        {isNextAiring && airMs != null && (
          <EpisodeAirChip targetMs={airMs} />
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col py-1 justify-center gap-1.5">
        <p className="flex items-baseline gap-3 font-mono text-[14px] tracking-[0.16em] uppercase">
          <span className={isActive ? "text-ln-accent" : "text-white/65"}>
            {absoluteNumber != null
              ? `E${String(absoluteNumber).padStart(2, "0")}`
              : video.episode != null
              ? `E${String(video.episode).padStart(2, "0")}`
              : "EP"}
          </span>
          {/* Absolute-episode annotation in season mode (arc mode already shows
              the absolute number itself). Empty for non-saga / already-absolute
              shows. */}
          {absoluteNumber == null && absoluteTag && (
            <span className="text-white/35 tracking-wide">{absoluteTag}</span>
          )}
          {unaired && airMs != null ? (
            <span className="text-white/45 tracking-wide whitespace-nowrap">
              Airs {new Date(airMs).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </span>
          ) : video.released ? (
            <span className="text-white/45 tracking-wide whitespace-nowrap">
              {new Date(video.released).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
            </span>
          ) : null}
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

/** Count filler / recap / canon episodes in a video list, using the SAME
 *  priority each EpisodeRow uses for its tags: cloud `episode_kinds` for this
 *  id, then the VideoEntry `is_filler`/`is_recap` booleans, then the legacy
 *  `episode_kind` string. Keeping this in lockstep is why the header +
 *  per-season counts always match the badges rendered on the rows.
 *
 *  `canon` = episodes that are NEITHER filler nor recap. Counted directly (not
 *  `total - filler - recap`) so an episode flagged as BOTH filler and recap is
 *  removed from canon exactly once, not twice. */
function countFillerRecap(
  list: VideoEntry[],
  kinds: { id: string; kind: string }[],
): { filler: number; recap: number; canon: number } {
  let filler = 0;
  let recap = 0;
  let canon = 0;
  for (const v of list) {
    const isFiller = kinds.some((k) => k.id === v.id && k.kind === "filler")
      || !!v.is_filler || v.episode_kind === "filler";
    const isRecap = kinds.some((k) => k.id === v.id && k.kind === "recap")
      || !!v.is_recap || v.episode_kind === "recap";
    if (isFiller) filler += 1;
    if (isRecap) recap += 1;
    if (!isFiller && !isRecap) canon += 1;
  }
  return { filler, recap, canon };
}

/** Accent episode-count chip with a hover breakdown. Shared by the header
 *  (absolute total) and the per-season chip so both behave identically: the
 *  count reads prominently; when the show has filler/recap, colour-matched
 *  presence dots (rose = filler, amber = recap) + a help cursor hint at a
 *  breakdown, and hovering reveals the canon / filler / recap counts (canon
 *  green, filler rose, recap amber). No filler/recap anywhere → plain chip. */
function EpisodeCountChip({
  label, showBreakdown, canon, filler, recap, scope,
}: {
  label: string;
  /** Wrap in the hover breakdown (true when the SHOW has any filler/recap). */
  showBreakdown: boolean;
  canon: number;
  filler: number;
  recap: number;
  /** Tooltip suffix, e.g. "this season". */
  scope?: string;
}) {
  const chip = (
    <span className="shrink-0 inline-flex items-center gap-1.5 rounded-md
                     bg-ln-accent/[0.12] border border-ln-accent/30
                     px-2.5 py-1 text-[11px] font-mono font-semibold uppercase
                     tracking-[0.14em] text-ln-accent tabular-nums">
      <span>{label}</span>
      {(filler > 0 || recap > 0) && (
        <span className="inline-flex items-center gap-1" aria-hidden>
          {filler > 0 && <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />}
          {recap > 0 && <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />}
        </span>
      )}
    </span>
  );
  if (!showBreakdown) return chip;

  const suffix = scope ? ` ${scope}` : "";
  const plain = [`${canon} canon`];
  if (filler > 0) plain.push(`${filler} filler`);
  if (recap > 0) plain.push(`${recap} recap`);
  return (
    <Tooltip
      pos="bottom"
      className="shrink-0 cursor-help"
      text={plain.join(", ") + suffix}
      content={(
        <span className="inline-flex items-center gap-2">
          <span className="text-emerald-300 font-semibold">{canon} canon</span>
          {filler > 0 && <span className="text-rose-300 font-semibold">{filler} filler</span>}
          {recap > 0 && <span className="text-amber-300 font-semibold">{recap} recap</span>}
          {scope && <span className="text-white/45">{scope}</span>}
        </span>
      )}
    >
      {chip}
    </Tooltip>
  );
}

function EpisodesPanel({
  seriesId, seriesMediaType, videos, activeVideo, onPick, scrollToVideoId, onScrollHandled,
  metaLoading, seasonHint, seasonNames, highlightVideoId, seriesArt, detail,
}: {
  seriesId: string;
  seriesMediaType: string;
  videos: VideoEntry[];
  metaLoading?: boolean;
  activeVideo: VideoEntry | null;
  onPick: (v: VideoEntry) => void;
  scrollToVideoId?: string | null;
  onScrollHandled?: () => void;
  /** The full meta, needed to resolve story arcs (anime detection + the TMDB
   *  id). Arcs are a progressive enhancement: no meta, no key, or no arc
   *  grouping simply means the Seasons/Arcs toggle never renders. */
  detail?: MetaDetail | null;
  /** Season parsed from the catalog entry's title (e.g. "Dorohedoro
   *  Season 2" → 2). Selected on open when that season actually exists
   *  in the cour-aggregated videos, UNLESS a resume / just-played
   *  target (scrollToVideoId) already pins a season — that wins. */
  seasonHint?: number | null;
  /** Per-season display names keyed by season number — shown under the
   *  dropdown (e.g. anime cour titles). Empty/undefined → nothing renders. */
  seasonNames?: Record<string, string>;
  /** Notification deep-link: the row matching this id gets a selection ring. */
  highlightVideoId?: string | null;
  /** Series poster shown as the thumbnail for unaired episodes. */
  seriesArt?: string | null;
}) {
  const seasons = useMemo(() => {
    const set = new Set<number>();
    for (const v of videos) if (v.season != null) set.add(v.season);
    return [...set].sort((a, b) => a - b);
  }, [videos]);

  // Filler / recap totals across the whole show, computed the SAME way each
  // EpisodeRow derives its tags (see countFillerRecap) so the header counts
  // always match the per-row badges. Zero for shows with none (the chips just
  // don't render), so live-action series show only the plain total.
  const cloudSignal = useReleaseSignal(seriesId);
  const { filler: fillerCount, recap: recapCount, canon: canonCount } = useMemo(
    () => countFillerRecap(videos, cloudSignal?.episode_kinds ?? []),
    [videos, cloudSignal],
  );

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
  // Resolve the deep-link ring target to the current videos shape (same path
  // as the scroll target) so the right row lights up across legacy/cour ids.
  const highlightId = useMemo(
    () => resolveResumeEpisode(highlightVideoId, videos)?.id ?? highlightVideoId ?? null,
    [videos, highlightVideoId],
  );

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

  // ── Story arcs ────────────────────────────────────────────────────────────
  // An orthogonal axis to `season`: the panel shows EITHER the season list OR
  // the arc list. Arcs resolve async and are absent for most shows, so nothing
  // below may assume they exist.
  const [grouping, setGrouping] = useState<EpisodeGrouping>(() => loadArcMode(seriesId).mode);
  const [groupingId, setGroupingId] = useState<string | undefined>(
    () => loadArcMode(seriesId).groupingId,
  );
  const [openArcId, setOpenArcId] = useState<string | null>(null);
  const { arcs: arcResult, loading: arcsLoading } = useStoryArcs(detail ?? null, seriesId, groupingId);

  // A remembered grouping always wins. Captured once at mount so the auto-default
  // below cannot fight a choice the user made in this same session.
  const storedGroupingIdRef = useRef(loadArcMode(seriesId).groupingId);

  // Default the grouping to Sagas (the first in display order) rather than to
  // whatever the backend scored highest. Only when the user has no remembered
  // choice, and only once they are actually in Arcs mode: a seasons-mode visitor
  // should not pay for a second TMDB round-trip they will never look at. The
  // refetch is skeletoned like any other grouping switch, and it settles after
  // one pass (the refetched result's grouping_id IS the preferred one).
  useEffect(() => {
    if (grouping !== "arcs") return;
    if (storedGroupingIdRef.current) return;
    if (!arcResult || arcResult.groupings.length < 2) return;
    const preferred = preferredGroupingId(arcResult.groupings);
    if (!preferred || preferred === arcResult.grouping_id) return;
    setGroupingId(preferred);
  }, [grouping, arcResult]);

  const arcAvailable = !!arcResult && arcResult.arcs.length > 0;
  // Guard every render path on availability, not just on the toggle: a user who
  // last left One Piece in Arcs mode must not get an empty panel when the TMDB
  // fetch fails or the key is missing.
  const arcMode = grouping === "arcs" && arcAvailable;
  // A revisit in SEASONS mode where a prior fetch knew this show has arcs, but
  // the 24 h result cache has since expired. Show the toggle right away in a
  // loading state so a long show like One Piece does not pop it in a few seconds
  // later. Distinct from `arcPending`, which only covers a remembered Arcs mode.
  const arcsLikelyPending =
    grouping === "seasons" && !arcAvailable && arcsLoading && arcsLikelyAvailable(seriesId);
  // First open (or a remembered Arcs mode) with nothing resolved yet: the TMDB
  // join is genuinely slow, so the panel owes the user a skeleton instead of
  // silently showing the season list.
  const arcPending = grouping === "arcs" && !arcAvailable && arcsLoading;
  const openArc = useMemo(
    () => (arcMode ? arcResult!.arcs.find((a) => a.id === openArcId) ?? null : null),
    [arcMode, arcResult, openArcId],
  );

  const switchGrouping = useCallback(
    (next: EpisodeGrouping) => {
      setGrouping(next);
      saveArcMode(seriesId, next, groupingId);
      // Entering Arcs mode: land the user on the arc holding the episode they
      // were about to resume, rather than dumping them at arc 1 of 55.
      if (next === "arcs" && arcResult) {
        const anchor = resolvedScrollId ?? activeVideo?.id ?? null;
        setOpenArcId(anchor ? arcPositionOf(arcResult, anchor)?.arc.id ?? null : null);
      }
    },
    [seriesId, groupingId, arcResult, resolvedScrollId, activeVideo?.id],
  );

  const switchArcGrouping = useCallback(
    (id: string) => {
      setGroupingId(id);
      setOpenArcId(null);
      saveArcMode(seriesId, "arcs", id);
      // An explicit pick becomes the remembered choice immediately, so the
      // Sagas-default effect above stops considering this series (it must not
      // yank the user back off a grouping they just chose).
      storedGroupingIdRef.current = id;
    },
    [seriesId],
  );

  // Seasons mode auto-selects the season holding the resume / deep-linked
  // episode. Arcs mode has to do the same, or a user whose remembered mode is
  // Arcs lands on the arc GRID and their resume row is nowhere on screen (the
  // scroll-to-episode effect below then hunts a row that is not rendered, and
  // a notification deep-link silently goes nowhere).
  //
  // Consume-once, like the season hint: it must not yank the user back to the
  // resume arc every time they navigate back out to the arc list.
  const hasAppliedArcAnchorRef = useRef(false);
  useEffect(() => {
    if (!arcMode || !arcResult || hasAppliedArcAnchorRef.current) return;
    const anchorId = highlightVideoId ?? resolvedScrollId ?? activeVideo?.id ?? null;
    if (!anchorId) return;
    const pos = arcPositionOf(arcResult, anchorId);
    if (!pos) return;
    hasAppliedArcAnchorRef.current = true;
    setOpenArcId(pos.arc.id);
  }, [arcMode, arcResult, highlightVideoId, resolvedScrollId, activeVideo?.id]);

  const inSeason = useMemo(() => {
    const list = seasons.length === 0
      ? [...videos]
      : videos.filter((v) => (v.season ?? 0) === season);
    list.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
    return list;
  }, [videos, season, seasons.length]);

  /** The episodes of the open arc, in ARC order (not season order): a
   *  cross-season arc renders as one flat list and the season boundary is
   *  invisible. Ids the addon no longer lists are dropped rather than rendered
   *  as holes. */
  const inArc = useMemo(() => {
    if (!openArc) return [];
    const byId = new Map(videos.map((v) => [v.id, v]));
    return openArc.episode_ids
      .map((id) => byId.get(id))
      .filter((v): v is VideoEntry => !!v);
  }, [openArc, videos]);

  /** Whole-series absolute episode numbers, so an arc's rows label with the same
   *  absolute count as the arc card's `E101-E208` range (a cross-season arc's
   *  per-season numbers would otherwise jump around and contradict it). Only used
   *  in arc mode; cheap enough to always compute. */
  const absoluteById = useMemo(() => absoluteEpisodeMap(videos), [videos]);

  /** Whichever list is actually on screen. Used for the row context menu's
   *  bulk "mark this and above/below" actions, which operate on the visible
   *  list. */
  const visibleEpisodes = arcMode ? (openArc ? inArc : []) : inSeason;

  // Filler / recap counts for the SELECTED season only (shown on hover of the
  // season episode-count chip), same source as the show-wide header totals.
  const { filler: seasonFiller, recap: seasonRecap, canon: seasonCanon } = useMemo(
    () => countFillerRecap(inSeason, cloudSignal?.episode_kinds ?? []),
    [inSeason, cloudSignal],
  );
  // Same breakdown, scoped to the open arc. Routed through the SAME helper so
  // the arc chip can never disagree with the badges on its own rows.
  const { filler: arcFiller, recap: arcRecap, canon: arcCanon } = useMemo(
    () => countFillerRecap(inArc, cloudSignal?.episode_kinds ?? []),
    [inArc, cloudSignal],
  );
  // Only anime with any filler/recap get the hover breakdown; live-action shows
  // (zero of both show-wide) render the plain chip with no tooltip.
  const showHasFillerRecap = fillerCount > 0 || recapCount > 0;

  // The single next-to-air episode across ALL seasons (not just the one
  // displayed) — its row gets the live countdown chip. Recomputed only
  // when the video list changes; no per-second tick here (the chip owns
  // its own tick) so the list never re-renders on the clock.
  const nextAiringId = useMemo(
    () => nextAiringEpisode(videos)?.id ?? null,
    [videos],
  );

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
    // `visibleEpisodes.length` + `openArcId`, not `inSeason.length`: in Arcs mode
    // the rendered list is the open arc, so the retry has to re-arm when the arc
    // changes or the row it is hunting is never in the DOM.
  }, [scrollToVideoId, resolvedScrollId, season, openArcId, visibleEpisodes.length, onScrollHandled]);

  return (
    <>
      <PanelHeader
        title="Episodes"
        right={(
          <div className="flex items-center gap-2.5">
            {/* Only offered when the show genuinely has arcs. Most of the
                library will never see this control. While arcs are still
                resolving (a remembered Arcs mode, or a known-arcs revisit whose
                cache expired) it shows in a loading state rather than popping in. */}
            {(arcAvailable || arcPending || arcsLikelyPending) && (
              <GroupingToggle
                mode={grouping}
                onChange={switchGrouping}
                loading={!arcAvailable}
              />
            )}
            <EpisodeCountChip
              label={`${videos.length} total`}
              showBreakdown={showHasFillerRecap}
              canon={canonCount}
              filler={fillerCount}
              recap={recapCount}
            />
          </div>
        )}
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
        ) : arcPending ? (
          // Arcs asked for, none resolved yet. The TMDB episode-group fetch plus
          // the sequence-alignment join takes a visible beat on a 1000-episode
          // show, and an empty panel read as "nothing happened".
          <div className="flex-1 min-h-0 overflow-y-auto px-1 pt-1 pb-4 space-y-3">
            <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/55 to-transparent animate-pulse" />
            <p className="text-white/55 text-[12px] italic">Loading story arcs…</p>
            <ArcGridSkeleton />
          </div>
        ) : arcMode && !openArc ? (
          // Arc picker. Scrolls on its own so a 55-arc show (One Piece) behaves
          // like the episode list does. `loading` covers a grouping SWITCH: the
          // grid keeps its header (so the newly selected segment lights up at
          // once) and swaps its tiles for skeletons while the refetch runs.
          <div
            className="flex-1 min-h-0 overflow-y-auto px-1 pt-1 pb-4"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
          >
            <ArcGrid
              result={arcResult!}
              seriesId={seriesId}
              videos={videos}
              loading={arcsLoading}
              activeGroupingId={groupingId ?? arcResult!.grouping_id}
              onSelect={(arc) => setOpenArcId(arc.id)}
              onGroupingChange={switchArcGrouping}
            />
          </div>
        ) : (
          <>
            {/* Arc breadcrumb, replacing the season dropdown while an arc is
                open. Same vertical rhythm so the list below does not shift. */}
            {arcMode && openArc && (
              <div className="flex items-center justify-center gap-3.5 mb-4">
                <button
                  type="button"
                  onClick={() => setOpenArcId(null)}
                  className="flex items-center gap-1.5 px-3 h-7 rounded-lg text-[12px] font-medium
                             text-white/70 hover:text-white bg-white/6 hover:bg-white/12 transition-colors"
                >
                  <span aria-hidden>&larr;</span>
                  <span className="truncate max-w-[22rem]">{openArc.name}</span>
                </button>
                <EpisodeCountChip
                  label={`${inArc.length} ${inArc.length === 1 ? "ep" : "eps"}`}
                  showBreakdown={showHasFillerRecap}
                  canon={arcCanon}
                  filler={arcFiller}
                  recap={arcRecap}
                  scope="this arc"
                />
                {arcYearRange(openArc) && (
                  <span className="text-[12px] text-white/40">{arcYearRange(openArc)}</span>
                )}
              </div>
            )}

            {/* Season dropdown + per-season episode count, centred as a
                group with a clear gap between them. The count is a standout
                accent chip (matching the absolute-total chip in the header)
                so the selected season's length reads at a glance. The
                dropdown truncates (min-w-0 in SeasonSelect) rather than
                shoving the chip on a narrow panel. */}
            {!arcMode && seasons.length > 1 && (
              <div className="flex items-center justify-center gap-3.5 mb-4">
                <SeasonSelect
                  seasons={seasons}
                  value={season}
                  onChange={setSeason}
                  names={seasonNames}
                />
                <EpisodeCountChip
                  label={`${inSeason.length} ${inSeason.length === 1 ? "ep" : "eps"}`}
                  showBreakdown={showHasFillerRecap}
                  canon={seasonCanon}
                  filler={seasonFiller}
                  recap={seasonRecap}
                  scope="this season"
                />
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
              {visibleEpisodes.map((v) => (
                <div key={v.id} data-episode-id={v.id}>
                  <EpisodeRow
                    video={v}
                    seriesId={seriesId}
                    seriesMediaType={seriesMediaType}
                    isActive={activeVideo?.id === v.id}
                    onPick={onPick}
                    seasonVideos={visibleEpisodes}
                    groupLabel={arcMode ? "arc" : "season"}
                    absoluteNumber={arcMode ? absoluteById.get(v.id) ?? null : null}
                    absoluteTag={arcMode ? "" : formatAbsoluteEpisode(seriesId, v.episode, absoluteById.get(v.id))}
                    isNextAiring={v.id === nextAiringId}
                    isDeepLinked={v.id === highlightId}
                    seriesArt={seriesArt}
                    seriesName={detail?.name ?? null}
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
 *  relevant rows in a hover tooltip. */
/** When AIOStreams returns a "Digital Release Filter" notice (no digital
 *  release available yet), the other notices (errors / stats / etc.) are just
 *  noise — keep ONLY the Digital-Release-Filter message(s). */
function suppressNoisyNotices(metadata: StreamMetadata): StreamMetadata {
  const isDrf = (m: StreamMessage) =>
    /digital release filter/i.test(m.title ?? "") ||
    /digital release filter/i.test(m.description);
  const all = [...metadata.errors, ...metadata.warnings, ...metadata.info, ...metadata.stats];
  if (!all.some(isDrf)) return metadata;
  const keep = (rows: StreamMessage[]) => rows.filter(isDrf);
  return {
    ...metadata,
    errors:   keep(metadata.errors),
    warnings: keep(metadata.warnings),
    info:     keep(metadata.info),
    stats:    keep(metadata.stats),
  };
}

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
    // The entrance transform can still be settling when `entered` flips via the
    // 480 ms fallback timeout (no transitionend fired) — the aside's rect is then
    // the centre-scaled one, and nothing re-measures afterward (a ResizeObserver
    // doesn't fire on an ancestor transform). Re-measure on a short cascade so the
    // FINAL position lands post-settle and the cluster can't freeze mid-screen.
    const raf = requestAnimationFrame(reposition);
    const t1 = setTimeout(reposition, 220);
    const t2 = setTimeout(reposition, 520);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    // ResizeObserver — covers panel resizes that don't fire window resize
    // (e.g. layout shifts as detail content loads).
    const el = anchorRef.current;
    const ro = el ? new ResizeObserver(reposition) : null;
    if (ro && el) ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      ro?.disconnect();
    };
  }, [entered, reposition, anchorRef]);

  const md = suppressNoisyNotices(metadata);
  const allBuckets: { kind: MessageKind; rows: StreamMessage[] }[] = [
    { kind: "error",   rows: md.errors   },
    { kind: "warning", rows: md.warnings },
    { kind: "info",    rows: md.info     },
    { kind: "stats",   rows: md.stats    },
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
  const md = suppressNoisyNotices(metadata);
  const allGroups: { kind: MessageKind; rows: StreamMessage[] }[] = [
    { kind: "error",   rows: md.errors   },
    { kind: "warning", rows: md.warnings },
    { kind: "info",    rows: md.info     },
    { kind: "stats",   rows: md.stats    },
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

/** localStorage flag — the non-TamTaro format hint shows once, then is
 *  dismissed for good (the cog stays available for toggling either way). */
const STREAM_FORMAT_HINT_KEY = "aura:stream-format-hint-dismissed";

function StreamsPanel({
  isEpisodic, activeVideo, streams, streamMeta, loading, groups, partyStreamKey, onBack, onPlay, onCopy, onPlayExternal, absoluteTag,
}: {
  isEpisodic: boolean;
  activeVideo: VideoEntry | null;
  streams: StreamEntry[];
  streamMeta: StreamMetadata;
  loading: boolean;
  groups: [string, StreamEntry[]][];
  partyStreamKey?: string | null;
  onBack?: () => void;
  onPlay: (s: StreamEntry) => void;
  onCopy: (text: string) => void;
  onPlayExternal: (url: string) => void;
  /** Absolute-episode annotation ("(E88)") when this show uses per-season
   *  numbering but has arcs; empty otherwise. Computed by the parent, which has
   *  the full episode list. Sits between the SxxEyy tag and the title so the
   *  saga-relative number is easy to follow. */
  absoluteTag?: string;
}) {
  const subtitle = isEpisodic && activeVideo
    ? (activeVideo.season != null && activeVideo.episode != null
        ? `S${String(activeVideo.season).padStart(2, "0")} · E${String(activeVideo.episode).padStart(2, "0")}${absoluteTag ? ` ${absoluteTag}` : ""} · ${activeVideo.title}`
        : activeVideo.title)
    : null;

  const totalMessages =
    streamMeta.errors.length +
    streamMeta.warnings.length +
    streamMeta.info.length +
    streamMeta.stats.length;

  // Aura stream formatter toggle (live). When OFF, rows show the addon's raw
  // title/description (like base Stremio) instead of parsed chips — the escape
  // hatch for addons that don't emit the TamTaro format the parser expects.
  const [formatterOn, setFormatterOn] = useState(() => loadAuraSettings().useAuraStreamFormatter);
  useEffect(() => {
    const sync = () => setFormatterOn(loadAuraSettings().useAuraStreamFormatter);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);
  const setFormatter = useCallback((v: boolean) => {
    saveAuraSettings({ ...loadAuraSettings(), useAuraStreamFormatter: v });
    setFormatterOn(v);
  }, []);

  // Auto-detect a non-TamTaro list (sample the first few rows). Drives the
  // one-time hint banner; only meaningful while the parser is ON.
  const nonTamTaro = useMemo(
    () => streams.length > 0 && !streams.slice(0, 8).some(looksLikeTamTaro),
    [streams],
  );
  const [hintDismissed, setHintDismissed] = useState(() => {
    try { return localStorage.getItem(STREAM_FORMAT_HINT_KEY) === "1"; } catch { return false; }
  });
  const dismissHint = useCallback(() => {
    setHintDismissed(true);
    try { localStorage.setItem(STREAM_FORMAT_HINT_KEY, "1"); } catch { /* ignore */ }
  }, []);
  const showHint = formatterOn && nonTamTaro && !hintDismissed;

  // No active stream providers — the user removed all in Settings, so streams
  // are fetched from zero addons. (Re-read each render; the formatter-state
  // subscription above re-renders on aura:settings-changed.)
  const streamProvidersEmpty = (() => {
    const u = loadAuraSettings().streamAddonUrls;
    return Array.isArray(u) && u.length === 0;
  })();

  return (
    <>
      <PanelHeader
        title="Streams"
        right={loading ? "Searching…" : `${streams.length} found`}
        backLabel={onBack ? "Episodes" : undefined}
        onBack={onBack}
        action={(
          <>
          <StreamFormatCog on={formatterOn} onToggle={setFormatter} />
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
          </>
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
          // Empty state. No active stream providers gets a settings-link
          // warning first; otherwise surface any addon errors/warnings/info,
          // then the legacy "nothing found" fallback.
          streamProvidersEmpty ? (
            <div className="px-2 pt-4">
              <NoProvidersWarning
                section="sec-streams"
                message="No stream providers are active, so no sources can be fetched."
              />
            </div>
          ) : totalMessages > 0 ? (
            <StreamMessagesEmptyState metadata={streamMeta} />
          ) : (
            <p className="text-white/50 text-[13px] italic px-2 py-3">
              No streams found from your installed addons.
            </p>
          )
        ) : (
          <div className="space-y-3">
            {showHint && (
              <StreamFormatHint
                onTurnOff={() => { setFormatter(false); dismissHint(); }}
                onDismiss={dismissHint}
              />
            )}
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
                  {list.map((s, idx) => {
                    const key = `${s.url ?? s.info_hash ?? "x"}:${idx}`;
                    const partyMatch = !!partyStreamKey && streamMatchKey(s) === partyStreamKey;
                    const rowProps = {
                      stream: s,
                      partyMatch,
                      onPlay: () => onPlay(s),
                      onCopy,
                      onPlayExternal,
                    };
                    return formatterOn
                      ? <StreamRow key={key} {...rowProps} />
                      : <RawStreamRow key={key} {...rowProps} />;
                  })}
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
  /** Right-aligned status. A plain string renders inside the dim count badge
   *  (streams "N found"); a ReactNode renders raw so the caller can supply its
   *  own styled chips (the episodes total + filler/recap counts). */
  right?: React.ReactNode;
  backLabel?: string;
  onBack?: () => void;
  /** Optional trailing control (e.g. the Streams "Refresh" button),
   *  rendered after the right-aligned status text. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5 border-b border-white/10 bg-white/[0.015]">
      {/* Left zone — back action as a defined chip, fenced off from the title. */}
      {onBack && (
        <>
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 pl-1.5 pr-2.5 h-7 rounded-lg shrink-0
                       text-white/55 hover:text-white bg-white/[0.04] hover:bg-white/[0.09]
                       border border-white/8 hover:border-white/15
                       text-[11px] font-mono tracking-[0.1em] uppercase transition-colors"
          >
            <ArrowBackSm />
            <span>{backLabel}</span>
          </button>
          <span className="w-px h-5 bg-white/10 shrink-0" aria-hidden />
        </>
      )}
      {/* Title zone. */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1 h-4 bg-ln-accent rounded-full shadow-accent-glow shrink-0" aria-hidden />
        <h3 className="text-white/95 text-[12.5px] font-mono font-semibold tracking-[0.22em] uppercase truncate">
          {title}
        </h3>
      </div>
      <div className="flex-1" />
      {/* Right zone — count badge + controls, grouped. */}
      {right && (
        typeof right === "string" ? (
          <span className="px-2 py-1 rounded-md shrink-0 bg-white/[0.05] border border-white/8
                           text-white/50 text-[10px] font-mono uppercase tracking-[0.14em]">
            {right}
          </span>
        ) : (
          right
        )
      )}
      {action && <div className="flex items-center gap-0.5 shrink-0">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stream-formatter controls — the cog popover, the auto-detect hint banner,
// and the raw (formatter-off) row.
// ---------------------------------------------------------------------------

/** Cog in the streams header → popover with the Aura stream-formatter toggle.
 *  Also reachable from main Settings; both write the same AuraSettings flag. */
function StreamFormatCog({ on, onToggle }: { on: boolean; onToggle: (v: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Stream formatting"
        title="Stream formatting"
        className="flex items-center justify-center w-7 h-7 -my-1 rounded-md
                   text-white/55 hover:text-white hover:bg-white/8 transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.62l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.27 8.86a.5.5 0 0 0 .12.62l2.03 1.58c-.04.31-.06.62-.06.94s.02.63.06.94l-2.03 1.58a.5.5 0 0 0-.12.62l1.92 3.32c.14.24.42.32.66.22l2.39-.96c.49.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.5.42h3.84c.25 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.24.1.52.02.66-.22l1.92-3.32a.5.5 0 0 0-.12-.62l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1.5 w-[262px] z-50 rounded-xl border border-white/12
                          bg-[rgba(14,14,18,0.97)] backdrop-blur-2xl shadow-glass-edge p-3 space-y-2">
            <button
              type="button"
              onClick={() => onToggle(!on)}
              className="w-full flex items-center justify-between gap-3"
            >
              <span className="text-[12.5px] text-white/90 font-medium font-sans normal-case tracking-normal">
                Aura stream formatting
              </span>
              <span className={`relative w-9 h-5 rounded-full flex-shrink-0 transition-colors
                                ${on ? "bg-ln-accent/80" : "bg-white/15"}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all
                                  ${on ? "left-[18px]" : "left-0.5"}`} />
              </span>
            </button>
            <p className="text-[11px] text-white/45 leading-snug font-sans normal-case tracking-normal">
              On: parse stream details into chips (built for AIOStreams' TamTaro format).
              Off: show the addon's raw output, like Stremio.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/** One-time banner above the stream list when the parser is on but the addon
 *  isn't emitting the TamTaro format Aura parses. */
function StreamFormatHint({ onTurnOff, onDismiss }: { onTurnOff: () => void; onDismiss: () => void }) {
  return (
    <div className="mx-1 rounded-lg border border-amber-400/25 bg-amber-500/[0.08] px-3 py-2.5">
      <p className="text-[12px] text-amber-100/85 leading-snug">
        These stream details aren't in Aura's expected format. Switch your AIOStreams output to
        the <span className="font-semibold">TamTaro</span> formatter, or turn off Aura's stream
        formatting to show the addon's raw text (also available under the cog above).
      </p>
      <div className="flex items-center gap-2 mt-2">
        <button
          type="button"
          onClick={onTurnOff}
          className="px-2.5 h-7 rounded-md text-[11.5px] font-medium
                     bg-amber-400/15 text-amber-100 border border-amber-300/30 hover:bg-amber-400/25 transition-colors"
        >
          Turn off formatting
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="px-2.5 h-7 rounded-md text-[11.5px] font-medium
                     text-white/55 hover:text-white/85 hover:bg-white/8 transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Raw stream row — shown when the Aura formatter is OFF. Renders the addon's
 *  title + description verbatim (line breaks preserved), like base Stremio, so
 *  no detail is lost when the parser can't read the format. Play + right-click
 *  actions mirror StreamRow. */
function RawStreamRow({
  stream, partyMatch, onPlay, onCopy, onPlayExternal,
}: {
  stream: StreamEntry;
  partyMatch?: boolean;
  onPlay: () => void;
  onCopy: (text: string) => void;
  onPlayExternal: (url: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={onPlay}
      onContextMenu={(e) => {
        e.preventDefault();
        const items = [
          stream.url ? { label: "Copy stream link", onClick: () => onCopy(stream.url!) } : null,
          stream.info_hash
            ? { label: "Copy magnet link", onClick: () => onCopy(`magnet:?xt=urn:btih:${stream.info_hash}`) }
            : null,
          stream.url
            ? { label: "Play externally", icon: <ExternalIcon />, onClick: () => onPlayExternal(stream.url!) }
            : null,
        ].filter(Boolean) as Array<{ label: string; icon?: React.ReactNode; onClick: () => void }>;
        openContextMenu(e.clientX, e.clientY, items);
      }}
      title={stream.filename ?? undefined}
      className={[
        "relative hover-glow w-full text-left rounded-xl px-4 py-3 flex flex-col gap-1",
        "hover:bg-white/[0.08] hover:border-white/18",
        partyMatch
          ? "bg-ln-accent/[0.10] border border-ln-accent/45 ring-1 ring-ln-accent/40"
          : "bg-white/[0.04] border border-white/10",
      ].join(" ")}
    >
      {partyMatch && (
        <span className="absolute -top-2 left-3 px-1.5 h-[15px] rounded-full bg-ln-accent text-black
                         text-[9px] font-bold uppercase tracking-wider flex items-center leading-none">
          Party pick
        </span>
      )}
      {stream.title && (
        <p className="text-white/90 text-[13.5px] font-medium leading-snug break-words selectable whitespace-pre-wrap">
          {stream.title}
        </p>
      )}
      {stream.description && (
        <p className="text-white/55 text-[12px] leading-snug break-words selectable whitespace-pre-wrap">
          {stream.description}
        </p>
      )}
      {!stream.title && !stream.description && (
        <p className="text-white/40 text-[12px] italic">{stream.addon_name || "Stream"}</p>
      )}
    </button>
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
  stream, partyMatch, onPlay, onCopy, onPlayExternal,
}: {
  stream: StreamEntry;
  partyMatch?: boolean;
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
  // AIOStreams flagged this as a multi-episode / season pack whose played
  // episode can't be verified for a single-episode request. Exactly `true`
  // only — `false`/undefined render the stars as normal. When set, a red
  // "Unreliable" badge takes the stars' top-right slot for this row.
  const unreliable = stream.episode_pack === true;

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
      className={[
        "relative hover-glow w-full text-left rounded-xl px-4 py-3",
        "hover:bg-white/[0.08] hover:border-white/18 flex flex-col gap-2.5",
        partyMatch
          ? "bg-ln-accent/[0.10] border border-ln-accent/45 ring-1 ring-ln-accent/40"
          : "bg-white/[0.04] border border-white/10",
      ].join(" ")}
    >
      {partyMatch && (
        <span className="absolute -top-2 left-3 px-1.5 h-[15px] rounded-full bg-ln-accent text-black
                         text-[9px] font-bold uppercase tracking-wider flex items-center leading-none">
          Party pick
        </span>
      )}
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
          {(headline || parsed.episode || parsed.year || parsed.date ||
            parsed.library || parsed.preloading) && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 pr-24">
              {parsed.library && (
                <Tooltip text="Already in your debrid library" pos="top">
                  <span className="text-cyan-300/85 text-[12px] leading-none" aria-label="already in your debrid library">☁</span>
                </Tooltip>
              )}
              {parsed.preloading && (
                <Tooltip text="Being preloaded to your debrid service" pos="top">
                  <span className="text-amber-300/85 text-[12px] leading-none" aria-label="preloading to debrid">➤</span>
                </Tooltip>
              )}
              {headline && (
                <p
                  className="text-white/95 text-[15px] leading-snug font-semibold break-words selectable line-clamp-2"
                  title={stream.filename ?? undefined}
                >
                  {headline}
                </p>
              )}
              {/* Newer AIOStreams sends a full air date in place of the bare
                  year, so prefer it: for an episode row the date is the more
                  useful of the two. Falls back to the year for addons (and
                  older formats) that only send that. */}
              {parsed.date
                ? <span className="text-white/55 text-[12px] font-mono">{parsed.date}</span>
                : parsed.year && (
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

              {/* ♬ Audio codec + ♯ channels - ONE row. A channel layout is a
                  single short chip and never justified a line of its own; the
                  distinct orange fill already separates it from the codecs.
                  Rail shows ♯ when there are channels but no codec to label. */}
              {(parsed.audioTags.length > 0 || parsed.audio || parsed.audioChannels.length > 0) && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>
                    {parsed.audioTags.length > 0 || parsed.audio ? "♬" : "♯"}
                  </span>
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

              {/* Release tags the addon sends after its ` » ` separator that
                  aren't seadex / NZB / score: release-scoring matches, and the
                  newer network + edition fields. Shown verbatim rather than
                  dropped, so an upstream addition surfaces instead of vanishing. */}
              {parsed.releaseFlags.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {/* » is the separator AIOStreams itself puts in front of
                      these, so it reads as the same rail vocabulary as ▣ / ♬. */}
                  <span className="text-white/35 text-[11px] font-mono w-4 shrink-0" aria-hidden>»</span>
                  {parsed.releaseFlags.map((f, i) => (
                    <Tooltip key={`rf-${i}`} text="Release tags from the addon" pos="top">
                      <ChipPill kind="default" label={f} />
                    </Tooltip>
                  ))}
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

      {/* Top-right rating slot. Normally the 5-star quality bar; for a
          stream AIOStreams flagged as an unverifiable season pack the stars
          are replaced by a red "Unreliable" badge occupying the same slot.
          When a Best / Alt Best badge owns the top-2 corner, this sits
          directly below it (top-10 ≈ 40 px clears the badge); otherwise it
          takes the corner slot (top-2). */}
      {unreliable ? (
        <div className={`absolute right-2 ${hasBadge ? "top-10" : "top-2"}`}>
          <Tooltip
            text="Season pack — the played episode can't be verified and may not be the one you requested."
            pos="left"
          >
            <span
              className="text-[11px] font-semibold uppercase tracking-wider px-2 py-1 rounded
                         bg-red-500/90 text-white border border-red-300/50
                         shadow-[0_0_10px_rgba(239,68,68,0.45)]"
              aria-label="Unreliable — season pack; the played episode can't be verified"
            >
              Unreliable
            </span>
          </Tooltip>
        </div>
      ) : parsed.stars > 0 ? (
        <div className={`absolute right-2 ${hasBadge ? "top-10" : "top-2"}`}>
          <Stars value={parsed.stars} />
        </div>
      ) : null}

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
          {parsed.proxyState === "self" && (
            <Tooltip text="Served by the addon host itself (AIOStreams' built-in usenet engine), so the connection stays on its IP. Not proxied." pos="top">
              <ChipPill kind="proxy-self" label="⛊" />
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
    p.nzbHealth || p.releaseFlags.length > 0
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
  // Never render a blank chip: a label that's empty or only whitespace /
  // zero-width / bidi characters would otherwise paint an empty box next to
  // its category icon (the "blank spot" symptom).
  if (!label || label.replace(/[\s ​-‏‪-‮⁠﻿]+/gu, "").length === 0) {
    return null;
  }
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
