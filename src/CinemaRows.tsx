// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useMemo, useState } from "react";
import { FilterBar, applyFilters, DEFAULT_FILTERS, type FilterState } from "./FilterBar";
import { invoke } from "@tauri-apps/api/core";
import type { MetaPreview, LibraryItem, AddonEntry, VideoEntry } from "./types";
import ImageLoader from "./ImageLoader";
import { useLibraryProgress } from "./LibraryContext";
import WatchedBadge, { useWatchedVariant, WatchedBadgeStatic } from "./WatchedBadge";
import { getManualWatchedState, useManualWatchedVersion } from "./manualWatched";
import { getMetaDetailFallback } from "./metaCache";

/** Per-catalog cache for the View-all popup. Keyed by
 *  `${addonUrl}|${type}|${id}`. Persists across DiscoveryRow remounts
 *  (e.g. settings tick re-bootstrapping the home rows) so a user who
 *  has already loaded a row's full list doesn't re-trigger pagination
 *  on subsequent clicks. Module-level Map; never cleared — cleared
 *  state is unnecessary since up to ~100 items × handful of catalogs
 *  is well under any sensible memory ceiling. */
const catalogPaginationCache = new Map<string, MetaPreview[]>();
/** Max items the View-all popup paginates to, mirroring the user's
 *  spec ("up to 100 per catalog"). */
const VIEW_ALL_TARGET = 100;

// ---------------------------------------------------------------------------
// Cinema rows.
//
// DiscoveryRow uses a 10-column CSS Grid: exactly 10 cells per row regardless
// of viewport. `HOME_VISIBLE - 1` catalog items + 1 "View All" card = a clean
// 10-cell row. CardCount > 10 is impossible by construction.
//
// ContinueWatchingRow keeps a horizontal-scroll layout because 10 16:9
// thumbnails per row would each be tiny on 1080p. CW thumbnails are
// EXCLUSIVELY 16:9 background art (no portrait poster fallback).
// ---------------------------------------------------------------------------

/** Discovery rows render exactly this many cells per row (9 items + ViewAll). */
export const HOME_VISIBLE = 10;
/** Continue Watching renders this many cells per row — auto-scales like
 *  the discovery grid so cards always fill the available width regardless
 *  of viewport. Capped at 8 because 16:9 thumbnails get illegibly small
 *  past that on 1080p. */
const CONTINUE_VISIBLE = 8;

// ---------------------------------------------------------------------------
// Continue Watching — 16:9 backdrop cards with progress bar.
// Filters out items lacking a 16:9 background.
// ---------------------------------------------------------------------------

// libraryNormalize() in App's loadLibrary already collapses episode-level
// rows into series-rooted entries — `item.id` here is canonical.
//
// Genres are pulled out of `state.genres` when present — Aura now writes
// them on every library_put (libraryActions.buildChange /
// libraryWriteProgress) so the anime gate downstream (right-click menus,
// audio language defaults) keeps working even after the meta has been
// stripped down to the Stremio library record. Historical entries
// without state.genres pick them up the next time the user plays / re-
// adds them.
function libraryItemToMeta(item: LibraryItem): MetaPreview {
  const stateGenres = (item.state ?? {}).genres;
  const genres = Array.isArray(stateGenres)
    ? stateGenres.filter((g): g is string => typeof g === "string")
    : [];
  return {
    id:           item.id,
    name:         item.name,
    media_type:   item.media_type,
    poster:       item.poster,
    background:   item.background,
    fanart:       null,
    backdrop:     null,
    logo:         item.logo,
    release_info: item.year,
    description:  null,
    imdb_rating:  null,
    genres,
  };
}

interface ContinueWatchingCardProps {
  item: LibraryItem;
  onSelect?: (meta: MetaPreview) => void;
  /** Required for the segmented per-season progress bar — CW card
   *  fetches its meta detail via the addon list to know how many
   *  episodes the current season has. */
  addons?: AddonEntry[];
}

// ---------------------------------------------------------------------------
// SegmentedSeasonBar — for series / anime CW cards. Renders one segment
// per episode in the resume episode's season; segments are colored:
//   • emerald  — watched (manual mark OR position-implied)
//   • amber    — currently watching (state.video_id resume hint)
//   • white/15 — unwatched
//
// The "position-implied" rule: episodes earlier in the season than the
// resume episode are treated as watched. Stremio doesn't track per-
// episode timestamps in cloud library — this is the best signal we
// have without forcing the user to manually mark every episode.
// Manual marks always win, in either direction.
// ---------------------------------------------------------------------------

/** Past this episode count the per-episode segments become slivers
 *  too thin to visually parse — at 50 eps on a typical CW tile each
 *  segment renders at ~3-4 px wide, and the gap-between-segments
 *  eats most of that. Switch to a continuous gradient bar at this
 *  threshold; everything below remains segmented since each segment
 *  is wide enough to communicate per-episode state cleanly. */
const SEGMENTED_BAR_EPISODE_CAP = 50;

function SegmentedSeasonBar({
  episodes, currentId,
}: {
  episodes: VideoEntry[];
  currentId: string | null;
}) {
  // Subscribe to manual-watched changes so the bar repaints
  // immediately when the user toggles a per-episode mark from the
  // EpisodeRow context menu. useSyncExternalStore (via the
  // useManualWatchedVersion helper) deduplicates the subscription
  // bookkeeping vs. the previous useState+useEffect+tick combo,
  // which mattered when 50 CW cards each carried their own bar.
  void useManualWatchedVersion();

  if (episodes.length === 0) return null;

  // Beyond the segment-count cap, hand off to the continuous bar.
  // Avoids visual mush from 60+ slivers on long-runners (One Piece,
  // Naruto, Detective Conan).
  if (episodes.length > SEGMENTED_BAR_EPISODE_CAP) {
    return <ContinuousProgressBar episodes={episodes} currentId={currentId} />;
  }

  const currentIdx = currentId
    ? episodes.findIndex((v) => v.id === currentId)
    : -1;

  // Inset the bar from each side by the card's corner radius (rounded-xl
  // = 12 px). Without this, the leftmost and rightmost segments get
  // visually swallowed by the parent's curved corner — for a season
  // with many episodes (segments only ~6-10 px wide), the first/last
  // segment ends up rendering as a sliver or disappearing entirely.
  // The 8 px inset is enough to clear the curvature on a 5 px-tall
  // bar without leaving an obvious gap.
  return (
    <div className="absolute left-2 right-2 bottom-1 h-[5px] flex gap-[1.5px] rounded-full overflow-hidden">
      {episodes.map((ep, i) => {
        const manual = getManualWatchedState(ep.id);
        let cls: string;
        if (manual === "watched") {
          cls = "bg-emerald-400";
        } else if (manual === "in-progress" || i === currentIdx) {
          cls = "bg-amber-400";
        } else if (currentIdx >= 0 && i < currentIdx) {
          cls = "bg-emerald-400/85"; // implied-watched (earlier in season)
        } else {
          cls = "bg-white/15";
        }
        return <div key={ep.id} className={`flex-1 h-full ${cls}`} />;
      })}
    </div>
  );
}

/** Long-runner alternative to SegmentedSeasonBar. Renders one continuous
 *  bar with a green-to-amber gradient ending at the in-progress
 *  episode's position. Watched-only ranges (no current in-progress) get
 *  a solid green fill; the gradient is only painted when there's a real
 *  "you are here" position to mark. The unwatched remainder uses the
 *  same white/15 background colour the segmented version's empty
 *  segments use, so the visual language stays consistent.
 *
 *  Position math walks the episode list once to find the rightmost
 *  "engaged" episode (watched / in-progress / implied-watched). The
 *  gradient's amber tip sits at the in-progress episode's right edge
 *  when one exists — that's the "yellow at the end of the green bar"
 *  the user asked for. */
function ContinuousProgressBar({
  episodes, currentId,
}: {
  episodes: VideoEntry[];
  currentId: string | null;
}) {
  void useManualWatchedVersion();
  if (episodes.length === 0) return null;
  const total = episodes.length;
  const currentIdx = currentId
    ? episodes.findIndex((v) => v.id === currentId)
    : -1;

  // Walk forward — for each episode, count it as "engaged" when it's
  // manually watched, manually in-progress, OR earlier than the
  // current-resume index (implied watched, mirrors the segmented
  // bar's tinted-emerald slot). engagedThroughIdx tracks the
  // rightmost engaged episode; the bar fills up to (idx + 1) / total.
  let engagedThroughIdx = -1;
  for (let i = 0; i < total; i += 1) {
    const manual = getManualWatchedState(episodes[i].id);
    const engaged =
      manual === "watched"
      || manual === "in-progress"
      || (currentIdx >= 0 && i <= currentIdx);
    if (engaged) engagedThroughIdx = i;
  }
  if (engagedThroughIdx < 0) {
    // Nothing engaged yet — render the empty track only so the bar
    // height stays consistent with the segmented version.
    return (
      <div className="absolute left-2 right-2 bottom-1 h-[5px] rounded-full overflow-hidden bg-white/15" />
    );
  }

  // Fill width in percent — round to one decimal to avoid sub-pixel
  // jitter on resize while still tracking per-episode granularity on
  // shows up to ~1000 eps.
  const fillPct = Math.min(100, ((engagedThroughIdx + 1) / total) * 100);
  // Gradient stop where amber begins. The amber band represents
  // "in-progress" and sits at the rightmost ~12% of the green fill —
  // enough to read as a distinct yellow tip without looking like a
  // separate segment. When there's no in-progress (every engaged
  // episode is manually watched, no resume position), use a flat
  // green so the bar reads "fully consumed" rather than "still
  // watching".
  const hasInProgress = currentIdx >= 0
    || episodes.some((ep) => getManualWatchedState(ep.id) === "in-progress");
  const fillStyle: React.CSSProperties = hasInProgress
    ? {
        width: `${fillPct}%`,
        background:
          "linear-gradient(to right, rgb(52,211,153) 0%, rgb(52,211,153) 88%, rgb(251,191,36) 100%)",
      }
    : {
        width: `${fillPct}%`,
        background: "rgb(52,211,153)",
      };

  return (
    <div className="absolute left-2 right-2 bottom-1 h-[5px] rounded-full overflow-hidden bg-white/15">
      <div aria-hidden className="h-full" style={fillStyle} />
    </div>
  );
}

/** Pull the current season's episode list from the meta cache.
 *  Returns null while fetching, returns [] for non-episodic items. */
function useSeasonEpisodes(item: LibraryItem, addons: AddonEntry[] | undefined): VideoEntry[] | null {
  const [eps, setEps] = useState<VideoEntry[] | null>(null);
  const mediaType = (item.media_type ?? "").toLowerCase();
  const isEpisodic = mediaType === "series" || mediaType === "anime";

  useEffect(() => {
    if (!isEpisodic || !addons || addons.length === 0) {
      setEps([]);
      return;
    }
    let cancelled = false;
    (async () => {
      // Some library items get added under one media_type but only
      // resolve their episode list under the other (the dual-indexed
      // anime case: an IMDb-id'd anime saved under media_type=series
      // via Cinemeta, but its episode list lives on a Kitsu/AniList
      // addon that only responds to type=anime). The first attempt
      // uses the stored type; if that returns no videos, retry with
      // the alternate. Without this, the CW card silently falls
      // through to the thin progress-bar render path because the
      // segmented bar requires a video list to draw the segments.
      let detail = await getMetaDetailFallback(addons, item.media_type, item.id);
      if (cancelled) return;
      const altType = mediaType === "series" ? "anime"
                    : mediaType === "anime"  ? "series"
                    : null;
      if ((!detail || !detail.videos || detail.videos.length === 0) && altType) {
        detail = await getMetaDetailFallback(addons, altType, item.id);
        if (cancelled) return;
      }
      if (!detail || !detail.videos || detail.videos.length === 0) {
        setEps([]);
        return;
      }
      // Determine which season's episodes the bar should represent.
      // Resolution order:
      //   1. VideoEntry-authoritative: find the video in detail.videos
      //      whose id matches state.video_id. Works uniformly for both
      //      tt-style ids (`tt22248376:2:9`) and anime-prefix ids
      //      (`kitsu:49240:9`) — the latter carries the kitsu show id
      //      in its middle slot, not a season number, so id-parsing
      //      would mis-read it as season 49240.
      //   2. (season, episode) tuple match for legacy library entries
      //      whose state.video_id shape no longer matches videos[].id.
      //   3. Id-string parse fallback (tt-only) when neither matches —
      //      covers in-flight meta where videos[] hasn't loaded yet.
      // Cour-aggregated anime: AIOMetadata now emits one season per
      // cour, so v.season carries the cour position (1, 2, 3, …) and
      // the bar correctly represents the user's current cour.
      const videoId = (item.state ?? {}).video_id;
      let season: number | null = null;
      if (typeof videoId === "string" && videoId.length > 0) {
        const directMatch = detail.videos.find((v) => v.id === videoId);
        if (directMatch?.season != null) {
          season = directMatch.season;
        } else {
          // Tuple-match fallback for ids that don't equal any current
          // video id (legacy shape after addon-side renaming, e.g.
          // tt22248376:1:5 against new kitsu:46474:5 videos).
          const parts = videoId.split(":");
          if (parts.length >= 3 && videoId.startsWith("tt")) {
            const s = Number(parts[parts.length - 2]);
            const e = Number(parts[parts.length - 1]);
            if (Number.isFinite(s) && Number.isFinite(e)) {
              const tupleMatch = detail.videos.find(
                (v) => (v.season ?? 0) === s && (v.episode ?? 0) === e,
              );
              if (tupleMatch?.season != null) season = tupleMatch.season;
            }
          }
        }
      }
      // Filter to the resolved season. When season is null (initial
      // load / unrecognised id / single-season show), fall through to
      // the full list so the bar still draws — the strip-specials
      // filter below collapses it to a sensible single-bar render for
      // flat shows.
      let seasonEps = season != null
        ? detail.videos.filter((v) => v.season === season)
        : detail.videos;
      if (seasonEps.length === 0 && detail.videos.length > 0) {
        seasonEps = detail.videos;
      }
      // Always strip season 0 (specials / OVAs / extras). The CW
      // segmented bar represents the user's main watch arc — specials
      // air out-of-band and inflating the segment count with them
      // makes the bar misrepresent main-run progress (e.g. Frieren's
      // 28 main-run episodes balloon to 38 when 10 specials are
      // included). The detail page's EpisodesPanel still shows the
      // specials season explicitly via the dropdown.
      seasonEps = seasonEps.filter((v) => (v.season ?? 0) !== 0);
      seasonEps.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
      setEps(seasonEps);
    })();
    return () => { cancelled = true; };
  }, [item.id, item.media_type, item.state?.video_id, isEpisodic, addons]);

  return eps;
}

/** Inline title-suffix indicator for CW cards. Renders a small green
 *  check (watched) or yellow dot (in-progress) next to the card title
 *  when the meta has a manual mark or library-derived progress state.
 *  The full poster overlay would be visually noisy on a 16:9 CW card,
 *  so we use this slimmer text-aligned variant instead. */
function CWTitleIndicator({ metaId, mediaType }: { metaId: string; mediaType: string }) {
  const variant = useWatchedVariant(metaId, mediaType);
  if (!variant) return null;
  return (
    <span className="inline-flex items-center align-middle ml-1.5">
      <WatchedBadgeStatic variant={variant} />
    </span>
  );
}

/** Format an episode id as the SxxEyy / EPxx badge text. Pure
 *  function over the wire-format id strings used by Stremio's library
 *  state.video_id (tt-style, kitsu-style, mal-style). */
const ANIME_ID_PREFIXES = new Set(["kitsu", "mal", "anidb", "anilist"]);
function badgeForVideoId(vid: string | null | undefined): string | null {
  if (typeof vid !== "string" || vid.length === 0) return null;
  const parts = vid.split(":");
  if (parts.length < 2) return null;
  const first  = parts[0];
  const last   = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  // Anime-provider prefix style: parts = [provider, seriesNum, ep].
  // CHECK THIS FIRST — without the prefix gate, the IMDb branch's
  // "both-segments-numeric" test would catch `kitsu:50023:6` and render
  // "S50023E06" (provider show id mis-treated as a season).
  if (parts.length >= 3 && ANIME_ID_PREFIXES.has(first.toLowerCase()) && /^\d+$/.test(last)) {
    return `EP${String(Number(last)).padStart(2, "0")}`;
  }
  // IMDb style: parts = [tt0903747, season, episode]; gated on the
  // tt-prefix so that the all-numeric check doesn't capture anime
  // ids whose first segment isn't a recognised provider name.
  if (first.startsWith("tt") && parts.length >= 3 && /^\d+$/.test(second) && /^\d+$/.test(last)) {
    const season = Number(second);
    const ep = Number(last);
    if (Number.isFinite(season) && Number.isFinite(ep)) {
      return `S${String(season).padStart(2, "0")}E${String(ep).padStart(2, "0")}`;
    }
  }
  return null;
}

/** Compute the effective "resume" episode id for a library item,
 *  accounting for manual watched marks. Stremio's library
 *  state.video_id only updates on real playback, so when the user
 *  manually marks the resume episode watched the CW tile would
 *  otherwise remain stuck pointing at the just-watched episode.
 *  Walks forward through the season's episode list to the next
 *  non-watched entry; falls back to state.video_id when no
 *  unwatched ep can be found OR the episode list isn't loaded yet.
 *  Subscribes to manual-watched changes so the calling card
 *  repaints the moment the user toggles a mark. */
/** Parse `<provider>:<a>:<b>` ids into (a, b) when both segments are
 *  numeric. For tt-prefixed IMDb episode ids that's (season, episode);
 *  for kitsu/mal/anidb-prefixed ids it's (showId, episode) — but for
 *  the CW segmented bar's tuple-match path we only care about the
 *  episode component, so the caller decides what to do with the pair. */
function parseLastTwoNumericSegments(id: string): { mid: number; last: number } | null {
  const parts = id.split(":");
  if (parts.length < 3) return null;
  const mid  = Number(parts[parts.length - 2]);
  const last = Number(parts[parts.length - 1]);
  if (!Number.isFinite(mid) || !Number.isFinite(last)) return null;
  return { mid, last };
}

/** Resolve a (possibly stale-shape) baseId to the matching episode in
 *  the current `episodes` list. Prefers direct id equality (the
 *  common path); falls back to (season, episode) tuple match for
 *  legacy library entries whose `state.video_id` shape no longer
 *  matches the current `videos[].id` shape — covers the
 *  AIOMetadata IMDb-anime transition where state was written under
 *  `tt22248376:1:5` but the new videos[] entries use
 *  `kitsu:46474:5`. Tuple match assumes `v.season === parsedSeason`
 *  and `v.episode === parsedEpisode` for tt-style ids; for non-tt
 *  ids the tuple may be (showId, episode), in which case the season
 *  filter falls through and we match purely by episode number
 *  within the current season list. */
function resolveCurrentEpisode(
  baseId: string,
  episodes: VideoEntry[],
): VideoEntry | null {
  if (episodes.length === 0) return null;
  const direct = episodes.find((v) => v.id === baseId);
  if (direct) return direct;
  const pair = parseLastTwoNumericSegments(baseId);
  if (!pair) return null;
  if (baseId.startsWith("tt")) {
    const found = episodes.find((v) => (v.season ?? 0) === pair.mid && (v.episode ?? 0) === pair.last);
    if (found) return found;
  }
  // Episode-only fallback (prefix-style ids whose middle slot is the
  // provider show id rather than a season). The episodes list is
  // already filtered to the current season by useSeasonEpisodes so
  // this is unambiguous in practice.
  return episodes.find((v) => (v.episode ?? 0) === pair.last) ?? null;
}

function useEffectiveResumeVideoId(
  item: LibraryItem,
  episodes: VideoEntry[] | null,
): string | null {
  void useManualWatchedVersion();
  const baseId = (item.state ?? {}).video_id;
  if (typeof baseId !== "string" || baseId.length === 0) return null;
  if (getManualWatchedState(baseId) !== "watched") {
    // Even when the user isn't manually-watched here, the baseId may
    // not directly match the current videos[] shape (post AIOMetadata
    // IMDb-anime patch transition). Resolve to the current-shape id
    // via the tuple fallback so the badge + bar paint correctly.
    if (!episodes || episodes.length === 0) return baseId;
    const resolved = resolveCurrentEpisode(baseId, episodes);
    return resolved?.id ?? baseId;
  }
  // Resume ep is manually-watched. Walk the season to find the next
  // non-watched episode — that's where the user would resume.
  if (!episodes || episodes.length === 0) return baseId;
  const startEp = resolveCurrentEpisode(baseId, episodes);
  if (!startEp) return baseId;
  const idx = episodes.findIndex((v) => v.id === startEp.id);
  if (idx < 0) return startEp.id;
  for (let i = idx + 1; i < episodes.length; i += 1) {
    const ep = episodes[i];
    if (getManualWatchedState(ep.id) === "watched") continue;
    return ep.id;
  }
  return startEp.id;
}

const ContinueWatchingCard = memo(function ContinueWatchingCard(
  { item, onSelect, addons }: ContinueWatchingCardProps
) {
  const src = item.background ?? item.poster;

  const offset = typeof item.state?.timeOffset === "number" ? item.state.timeOffset : 0;
  const duration = typeof item.state?.duration === "number" ? item.state.duration : 0;
  const progress = duration > 0 ? Math.min(1, offset / duration) : 0;
  const seasonEpisodes = useSeasonEpisodes(item, addons);
  // Effective resume episode — falls forward across manually-watched
  // entries so a freshly-marked episode causes the SxxEyy badge AND
  // the segmented bar's "current" amber to advance to the next
  // unwatched ep. Without this, the CW card stayed visually stuck on
  // the just-marked episode.
  const effectiveVideoId = useEffectiveResumeVideoId(item, seasonEpisodes);
  // Prefer the VideoEntry's (season, episode) when the episode list has
  // resolved — this gives a uniform `S01E06` badge regardless of whether
  // the underlying id is IMDb-shape (`tt…:1:6`) or anime-prefix-shape
  // (`kitsu:50023:6`, which doesn't encode the season in the id at all).
  // Falls back to the id-string parse during the brief window before
  // the meta detail fetch completes.
  const currentEp = effectiveVideoId
    ? seasonEpisodes?.find((v) => v.id === effectiveVideoId)
    : null;
  const badge = (currentEp && currentEp.season != null && currentEp.episode != null)
    ? `S${String(currentEp.season).padStart(2, "0")}E${String(currentEp.episode).padStart(2, "0")}`
    : badgeForVideoId(effectiveVideoId);
  const useSegmented = seasonEpisodes != null && seasonEpisodes.length > 1;

  return (
    <div
      className="card-grow group relative cursor-pointer card-contain text-left
                 focus-within:ring-2 focus-within:ring-ln-accent/60 rounded-xl"
      data-meta-card={`${item.media_type}:${item.id}`}
    >
      <button
        type="button"
        onClick={() => onSelect?.(libraryItemToMeta(item))}
        onContextMenu={(e) => {
          e.preventDefault();
          // `source: "cw"` lets App.tsx tailor the menu — CW cards
          // show "Remove from Continue Watching" instead of "Remove
          // from Library" since the user typically just wants to drop
          // the row from their CW lineup.
          window.dispatchEvent(new CustomEvent("aura:card-context", {
            detail: { meta: libraryItemToMeta(item), x: e.clientX, y: e.clientY, source: "cw", item },
          }));
        }}
        className="block w-full text-left rounded-xl focus:outline-none"
      >
        <div
          className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
          style={{ aspectRatio: "16 / 9" }}
        >
          {src ? (
            <ImageLoader
              src={src}
              alt={item.name}
              draggable={false}
              className="absolute inset-0 w-full h-full"
              imgClassName="w-full h-full object-cover"
            />
          ) : null}

          {/* SxxEyy badge — top-left, denotes the episode that will
              actually be brought up when the card is clicked. Same
              style as the calendar but scaled +25 % (10.5 → 13 px font,
              padding bumped proportionally) so the SxxEyy reads
              cleanly at sofa distance. */}
          {badge && (
            <span
              className="absolute top-1.5 left-1.5 px-2 py-1 rounded
                         bg-black/75 backdrop-blur-sm border border-white/15
                         text-white/90 text-[13px] font-mono font-semibold
                         tracking-wider tabular-nums"
              aria-label={`Resume at ${badge}`}
            >
              {badge}
            </span>
          )}

          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-black/70 to-transparent" />
          {useSegmented ? (
            // Per-episode segmented bar for series/anime — each segment
            // is one episode in the current season. Falls back to the
            // smooth bar below for movies and for series whose meta
            // hasn't resolved yet (lazy fetch via metaCache).
            <SegmentedSeasonBar
              episodes={seasonEpisodes!}
              currentId={effectiveVideoId}
            />
          ) : progress > 0 && (
            <div className="absolute inset-x-0 bottom-0 h-[5px] bg-white/15">
              <div className="h-full bg-ln-accent" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
        <p className="text-white/90 text-[17px] font-medium mt-2 leading-tight line-clamp-1 text-center">
          {item.name}
          <CWTitleIndicator metaId={item.id} mediaType={item.media_type} />
        </p>
        {item.year && (
          <p className="text-white/35 text-[14px] mt-0.5 text-center font-mono">{item.year}</p>
        )}
      </button>

      {/* Clear-from-Continue-Watching button. Visible on hover only so it
          doesn't compete with the poster art at rest. App.tsx handles the
          cloud-side library write via the 'aura:cw-clear' event. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent("aura:cw-clear", { detail: { item } }));
        }}
        title="Remove from Continue Watching"
        aria-label="Remove from Continue Watching"
        className="absolute top-2 right-2 w-7 h-7 rounded-full
                   bg-black/70 text-white/85 hover:bg-black/90 hover:text-white
                   border border-white/20
                   opacity-0 group-hover:opacity-100 transition-opacity
                   flex items-center justify-center
                   focus:outline-none focus-visible:opacity-100"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
    </div>
  );
});

interface ContinueWatchingRowProps {
  items: LibraryItem[];
  onSelectMeta?: (meta: MetaPreview) => void;
  /** Forwarded to each card — needed for the segmented per-season
   *  progress bar's lazy meta fetch. */
  addons?: AddonEntry[];
}

export const ContinueWatchingRow = memo(function ContinueWatchingRow(
  { items, onSelectMeta, addons }: ContinueWatchingRowProps
) {
  const have16x9 = items.filter((i) => !!(i.background ?? i.poster));
  if (have16x9.length === 0) return null;

  // CONTINUE_VISIBLE caps the in-memory slice to the largest column
  // count any breakpoint will render (8 = ultrawide). Viewports under
  // 2400 px render 6 cards instead — the leftover slice is silently
  // dropped at the grid level since column count is driven by the
  // `--cw-cols` CSS var (set in App.css's media-query block).
  const visible = have16x9.slice(0, CONTINUE_VISIBLE);

  return (
    <section className="relative px-6">
      <div className="flex items-baseline gap-3 mb-3 px-1">
        <h3 className="aura-row-title text-2xl font-semibold tracking-tight">
          Continue Watching
        </h3>
        <p className="text-white/65 text-[13px] font-mono tabular-nums tracking-wide">
          <span className="text-white/85 font-semibold">{have16x9.length}</span>
          <span className="ml-1 text-white/40">in progress</span>
        </p>
      </div>
      <div
        className="grid gap-3.5"
        style={{ gridTemplateColumns: "repeat(var(--cw-cols, 8), minmax(0, 1fr))" }}
      >
        {visible.map((item) => (
          <ContinueWatchingCard key={item.id} item={item} onSelect={onSelectMeta} addons={addons} />
        ))}
      </div>
    </section>
  );
});

// ---------------------------------------------------------------------------
// Discovery row — 10-column CSS Grid. 9 catalog items + 1 "View All" cell.
// ---------------------------------------------------------------------------

interface CatalogCardProps {
  meta: MetaPreview;
  onSelect?: (meta: MetaPreview) => void;
}

export const CatalogCard = memo(function CatalogCard({ meta, onSelect }: CatalogCardProps) {
  // Pull progress from the library context — drives the bottom progress
  // bar (partial) and the corner check (watched). Both are rendered as
  // unobtrusive overlays so they don't compete with the poster art.
  const progress = useLibraryProgress(meta.id);

  return (
    <button
      type="button"
      onClick={() => onSelect?.(meta)}
      onContextMenu={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("aura:card-context", {
          detail: { meta, x: e.clientX, y: e.clientY },
        }));
      }}
      className="card-grow group flex flex-col gap-2 cursor-pointer card-contain text-left
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
      <div
        className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
        style={{ aspectRatio: "2 / 3" }}
      >
        {meta.poster ? (
          <ImageLoader
            src={meta.poster}
            alt={meta.name}
            draggable={false}
            className="absolute inset-0 w-full h-full"
            // `image-rendering: -webkit-optimize-contrast` nudges
            // Chromium / WebView2 to use a sharper resampling kernel
            // when downscaling. AIOMetadata's poster bitmaps bake the
            // % rating circles + IMDb tag onto the poster, so the
            // visible aliasing on those badges at 1080p is purely a
            // downscale artifact — this hint mitigates it without
            // changing the poster URL or asking for a higher-res
            // variant. No effect on hi-DPR / ultrawide where the
            // poster is rendered at or above its native resolution.
            imgClassName="w-full h-full object-cover [image-rendering:-webkit-optimize-contrast]"
            fallback={
              <div className="absolute inset-0 flex items-center justify-center text-white/20">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
                </svg>
              </div>
            }
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/20">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
            </svg>
          </div>
        )}

        {/* Watched / in-progress indicator — top-LEFT to avoid colliding
            with the quality badge (4K / HDR / 1080p) the addon stamps
            top-right and the rating tiles anchored bottom. Combines
            manual marks with library-derived progress (manualWatched
            wins when set). */}
        <WatchedBadge
          metaId={meta.id}
          mediaType={meta.media_type}
          className="absolute top-1.5 left-1.5"
        />

        {/* In-progress bar — bottom edge, only when partially watched
            via library state. The badge above gives the AT-A-GLANCE
            signal; this bar adds fine-grained position info. */}
        {progress?.partial && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-black/55">
            <div
              className="h-full bg-ln-accent"
              style={{ width: `${progress.ratio * 100}%` }}
            />
          </div>
        )}
      </div>
      <p className="text-white/90 text-[19px] font-medium leading-tight line-clamp-2 text-center">
        {meta.name}
      </p>
      {meta.release_info && (
        <p className="text-white/55 text-[15.5px] mt-0.5 text-center font-mono">{meta.release_info}</p>
      )}
    </button>
  );
});

interface DiscoveryRowProps {
  title: string;
  items: MetaPreview[];
  loading?: boolean;
  onSelectMeta?: (meta: MetaPreview) => void;
  /** Catalog identifiers — when set, View-all click triggers a
   *  paginated fetch up to VIEW_ALL_TARGET (=100) items for the popup.
   *  Search-result rows (which paginate via search-specific extras)
   *  omit these and render only the items they were given. */
  addonUrl?:    string;
  catalogType?: string;
  catalogId?:   string;
}

export const DiscoveryRow = memo(function DiscoveryRow(
  { title, items, loading, onSelectMeta, addonUrl, catalogType, catalogId }: DiscoveryRowProps
) {
  const [overflowOpen, setOverflowOpen]   = useState(false);
  const [overflowItems, setOverflowItems] = useState<MetaPreview[] | null>(null);
  const [overflowLoading, setOverflowLoading] = useState(false);

  // Skeleton — render exactly 10 placeholder cells.
  if (loading && items.length === 0) {
    return (
      <RowFrame title={title}>
        {Array.from({ length: HOME_VISIBLE }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl bg-white/5 image-loader-skeleton"
            style={{ aspectRatio: "2 / 3" }}
          />
        ))}
      </RowFrame>
    );
  }

  if (items.length === 0) return null;

  // Defensive dedupe by `${media_type}:${id}`. Some addons (notably AI
  // Search) occasionally return the same series twice in one catalog
  // response — observed in production for "jjk" → series:tt12343534 ×2,
  // which crashed React with "Encountered two children with the same
  // key". First occurrence wins, preserving native order.
  const seen = new Set<string>();
  const dedupedItems: MetaPreview[] = [];
  for (const m of items) {
    const k = `${m.media_type}:${m.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    dedupedItems.push(m);
  }

  // The home row renders up to HOME_VISIBLE = 10 items. At 1080p only
  // the first 8 are actually visible (CSS hides 9-10 via :nth-child),
  // so we offer the View-all popup whenever the catalog has at least
  // one item — the popup paginates up to 100 lazily on click. The
  // count we show in the subtitle is `home-visible cap or higher`
  // suffixed with `+` since we don't know the true total without
  // paginating, and showing a bare "View all" feels under-informative.
  const visible = dedupedItems.slice(0, HOME_VISIBLE);
  const canPaginate = !!(addonUrl && catalogType && catalogId);
  // A catalog row can still expand beyond what's loaded if it's wired
  // to fetch_catalog_paginated. If it isn't (search rows), only show
  // View all when the loaded items already exceed the visible cells.
  const hasOverflow = canPaginate
    ? dedupedItems.length > 0
    : dedupedItems.length > 8;

  const cacheKey = canPaginate
    ? `${addonUrl}|${catalogType}|${catalogId}`
    : null;

  const handleViewAll = async () => {
    setOverflowOpen(true);
    if (!canPaginate || !cacheKey) {
      // Search-style row — show the items already in hand.
      setOverflowItems(dedupedItems);
      return;
    }
    // Cached? Render immediately.
    const cached = catalogPaginationCache.get(cacheKey);
    if (cached) {
      setOverflowItems(cached);
      return;
    }
    setOverflowLoading(true);
    try {
      const more = await invoke<MetaPreview[]>("fetch_catalog_paginated", {
        addonUrl,
        catalogType,
        catalogId,
        target: VIEW_ALL_TARGET,
      });
      // Dedupe by id — fetch_catalog_paginated already does this in
      // Rust but a cross-page collision could still slip through if
      // items shifted upstream during pagination, so we re-check.
      const popupSeen = new Set<string>();
      const merged: MetaPreview[] = [];
      for (const m of more) {
        const k = `${m.media_type}:${m.id}`;
        if (popupSeen.has(k)) continue;
        popupSeen.add(k);
        merged.push(m);
      }
      catalogPaginationCache.set(cacheKey, merged);
      setOverflowItems(merged);
    } catch {
      // Fall back to the items we already have so the popup isn't
      // blank on a transient network error.
      setOverflowItems(dedupedItems);
    } finally {
      setOverflowLoading(false);
    }
  };

  const closeOverflow = () => {
    setOverflowOpen(false);
    setOverflowItems(null);
    setOverflowLoading(false);
  };

  return (
    <>
      <RowFrame
        title={title}
        subtitle={hasOverflow ? "View all" : undefined}
        onSubtitleClick={hasOverflow ? handleViewAll : undefined}
      >
        {visible.map((meta) => (
          <CatalogCard
            key={`${meta.media_type}:${meta.id}`}
            meta={meta}
            onSelect={onSelectMeta}
          />
        ))}
      </RowFrame>
      {overflowOpen && (
        <CatalogOverlay
          title={title}
          items={overflowItems ?? dedupedItems}
          loading={overflowLoading}
          onClose={closeOverflow}
          onSelectMeta={onSelectMeta}
        />
      )}
    </>
  );
});

// ---------------------------------------------------------------------------
// RowFrame — header + grid body. Subtitle becomes a clickable
// "View all N →" affordance when an onSubtitleClick is provided.
// ---------------------------------------------------------------------------

function RowFrame({
  title, subtitle, onSubtitleClick, children,
}: {
  title: string;
  subtitle?: string;
  onSubtitleClick?: () => void;
  children: React.ReactNode;
}) {
  // Pull the digits out of the subtitle ("View all 24" → "24") so we
  // can render the count in a brighter colour while keeping the
  // surrounding label muted — same emphasis pattern the previous
  // "<N> total" subtitle used.
  const m = subtitle ? /^(.*?)(\d[\d,]*)(.*)$/.exec(subtitle) : null;
  const subtitleContent = m ? (
    <>
      <span className="text-white/55">{m[1]}</span>
      <span className="text-white/95 font-semibold">{m[2]}</span>
      <span className="text-white/45">{m[3]}</span>
      {onSubtitleClick && <span className="text-ln-accent ml-1">→</span>}
    </>
  ) : (
    <>
      <span className={onSubtitleClick ? "text-white/85" : "text-white/55"}>{subtitle}</span>
      {onSubtitleClick && <span className="text-ln-accent ml-1">→</span>}
    </>
  );

  return (
    <section className="relative px-6">
      <div className="flex items-baseline justify-between mb-3 px-1">
        <h3 className="aura-row-title text-2xl font-semibold tracking-tight">{title}</h3>
        {subtitle && (
          onSubtitleClick ? (
            <button
              type="button"
              onClick={onSubtitleClick}
              className="text-[15px] font-mono tabular-nums tracking-wide
                         hover:opacity-90 transition-opacity cursor-pointer
                         bg-transparent p-0 border-0 focus:outline-none
                         focus-visible:underline"
            >
              {subtitleContent}
            </button>
          ) : (
            <p className="text-[15px] font-mono tabular-nums tracking-wide">
              {subtitleContent}
            </p>
          )
        )}
      </div>
      <div
        className="grid aura-catalog-row"
        // Column template + gap come from CSS vars in App.css. Ultrawide:
        // 10 equal columns / 14 px gap. < 2400 px: 8 equal columns / 8 px
        // gap with a :nth-child rule hiding items 9-10. Items beyond 8
        // still mount in the React tree so the View-all popup has access
        // to the full loaded list.
        style={{
          gridTemplateColumns: "var(--catalog-grid-template)",
          gap: "var(--catalog-gap)",
        }}
      >
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// CatalogOverlay — Stremio-style "View all" popup. Triggered from the
// clickable subtitle on a DiscoveryRow; shows every item currently
// loaded for that catalog in a multi-row poster grid. Sized larger on
// ultrawide via CSS vars (--catalog-popup-w / -h / -cols) so the user
// can see ~6 columns × 4-5 rows at once on a wide display, with a
// tighter 4-column layout at 1080p.
//
// Animation + backdrop pattern mirrors CalendarView's DayOverlay so
// the two surfaces feel consistent. ESC + click-outside both close.
// ---------------------------------------------------------------------------

function CatalogOverlay({
  title, items, loading, onClose, onSelectMeta,
}: {
  title: string;
  items: MetaPreview[];
  /** When true the overlay shows a skeleton grid + "Loading…" subtitle.
   *  Caller flips this on while the View-all paginated fetch is in
   *  flight; the items prop is the placeholder list shown if pagination
   *  fails. */
  loading?: boolean;
  onClose: () => void;
  onSelectMeta?: (meta: MetaPreview) => void;
}) {
  const [opening, setOpening] = useState(true);
  // Shared filter / sort state for the overlay grid. Mirrors the
  // pattern used by Library / Queue / Discover so the affordance feels
  // identical across browseable surfaces.
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const filteredItems = useMemo(
    () => applyFilters(items, filters),
    [items, filters],
  );

  // Two rAF ticks = one painted frame; lets the initial opacity/scale
  // commit before we transition to the entered state.
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setOpening(false))
    );
    return () => cancelAnimationFrame(id);
  }, []);

  // ESC closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-6"
      style={{
        backgroundColor: opening ? "transparent" : "rgba(0,0,0,0.80)",
        backdropFilter: opening ? "blur(0px)" : "blur(8px)",
        transition: "background-color 200ms ease, backdrop-filter 200ms ease",
      }}
      onClick={onClose}
    >
      <div
        className="glass-panel rounded-2xl flex flex-col overflow-hidden"
        style={{
          width:    "var(--catalog-popup-w)",
          maxHeight: "var(--catalog-popup-h)",
          opacity: opening ? 0 : 1,
          transform: opening ? "scale(0.92)" : "scale(1)",
          transition: "opacity 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 shrink-0
                        border-b border-white/8">
          <div>
            <h2 className="text-white/90 text-lg font-semibold tracking-tight">{title}</h2>
            <p className="text-white/40 text-sm mt-0.5">
              {loading
                ? "Loading…"
                : filteredItems.length === items.length
                  ? (items.length === 1 ? "1 item" : `${items.length} items`)
                  : `${filteredItems.length} of ${items.length} items`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full glass-panel flex items-center justify-center
                       text-white/50 hover:text-white transition-colors shrink-0 mt-0.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {/* Body — grid + filter sidebar. The grid column count comes
            from --catalog-popup-cols (6 ultrawide, 4 at 1080p). The
            FilterBar sits in a flex sibling so the grid reflows around
            it on narrower windows; on smaller windows we fall back to
            grid-only via the same xl:block pattern other views use. */}
        <div
          className="flex-1 min-h-0 flex overflow-hidden"
        >
          <div
            className="flex-1 overflow-y-auto p-6"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
          >
            <div
              className="grid gap-4"
              style={{ gridTemplateColumns: "repeat(var(--catalog-popup-cols), minmax(0, 1fr))" }}
            >
              {loading && items.length === 0
                ? Array.from({ length: 12 }).map((_, i) => (
                    <div
                      key={`skeleton-${i}`}
                      className="rounded-xl bg-white/5 image-loader-skeleton"
                      style={{ aspectRatio: "2 / 3" }}
                    />
                  ))
                : filteredItems.map((meta) => (
                    <CatalogCard
                      key={`${meta.media_type}:${meta.id}`}
                      meta={meta}
                      onSelect={onSelectMeta ? (m) => { onClose(); onSelectMeta(m); } : undefined}
                    />
                  ))}
            </div>
            {!loading && filteredItems.length === 0 && items.length > 0 && (
              <div className="text-center py-10 text-white/55 text-sm">
                No items match the current filter.
              </div>
            )}
          </div>
          {items.length > 0 && (
            <div className="hidden xl:flex flex-col p-4 pt-0 pl-0 shrink-0">
              <FilterBar items={items} state={filters} onChange={setFilters} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
