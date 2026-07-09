// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { LibraryItem, MetaPreview } from "../types";
import type { UserSession } from "../LoginView";
import ImageLoader from "../ImageLoader";
import { shrinkPoster } from "../posterSize";
import ErrorBoundary from "../ErrorBoundary";
import Tooltip from "../Tooltip";
import { isAnimeMeta, typeLabel } from "../aiometadata";
import WatchedBadge from "../WatchedBadge";
import { useHoverCardActivation } from "../useHoverCardActivation";
import { closeHoverNow } from "../catalogHoverStore";
import {
  FilterMenu, applyFilters, DEFAULT_FILTERS,
  type FilterState, type SortOption, type StatusOption,
} from "../FilterBar";
import ListSearchInput, { looseMatch } from "../ListSearchInput";
import { PAGE_CONTENT_MAX_W } from "../pageLayout";
import { getManualWatchedState, useManualWatchedVersion } from "../manualWatched";
import { getReleaseSignal, useReleaseSignalsVersion } from "../releaseSignalStore";
import { episodeIsBeforeResume } from "../LibraryContext";
import { loadAuraSettings, saveAuraSettings } from "../auraSettings";

// ---------------------------------------------------------------------------
// LibraryView — full grid of saved Stremio library items.
//
// Defensive shell: the header (title, sort, filters) ALWAYS renders even when
// the library is undefined or empty. The data region picks one of:
//   • Skeleton grid (library === undefined → still loading)
//   • "Library is empty" message (signed in, library === [])
//   • "Sign in" prompt (no session)
//   • "No matches" (filter excludes everything)
//   • The actual grid (one or more items match)
//
// An <ErrorBoundary> wraps the whole tree — any render-time crash falls back
// to a small diagnostic card instead of returning a blank view.
// ---------------------------------------------------------------------------

type SortMode = "alpha" | "alpha-desc" | "added" | "played";
type Filter   = "all" | "movie" | "series" | "anime";

// Library's Sort By choices, now surfaced inside the header Filter &
// Sort panel (the standalone <select> was removed). `value` maps to
// SortMode; the ordering itself is applied in `sorted` below.
const LIBRARY_SORT_OPTIONS: SortOption[] = [
  { value: "added",      label: "Recently Added" },
  { value: "played",     label: "Recently Watched" },
  { value: "alpha",      label: "A → Z" },
  { value: "alpha-desc", label: "Z → A" },
];

// Status filter - a coarse cut across the library by watch state, surfaced in
// the Filter & Sort panel. "all" is the no-filter default (grid behaves exactly
// as before). The other values narrow to a derived status; picking any of them
// also pulls in auto-tracked (temp) Continue-Watching entries the grid normally
// hides, so "In Progress" / "Watched" surface content the user never explicitly
// added. See `filtered` below.
type LibraryStatusFilter =
  | "all" | "watched" | "unwatched" | "in-progress" | "in-queue" | "new-episodes";

const LIBRARY_STATUS_OPTIONS: StatusOption[] = [
  { value: "all",          label: "All" },
  { value: "watched",      label: "Watched" },
  { value: "unwatched",    label: "Unwatched" },
  { value: "in-progress",  label: "In Progress" },
  { value: "in-queue",     label: "In Queue" },
  { value: "new-episodes", label: "New Episodes" },
];

/** The auto-remove-watched toggles are split by media kind. */
type AutoRemoveKind = "movie" | "series";

/** The mutually-exclusive watch status of a library item. Mirrors
 *  WatchedBadge's `useWatchedVariant` precedence EXACTLY so the filter and the
 *  on-poster badge never disagree: a manual mark wins; an auto-derived >=90%
 *  signal is "watched" for movies but DEMOTED to "in-progress" for series/anime
 *  (Stremio only stores the last-episode offset, not a series-level completion,
 *  so a series is "watched" only when manually / auto-advance marked). */
type ExclusiveStatus = "watched" | "unwatched" | "in-progress" | "in-queue";

function libraryItemStatus(item: LibraryItem): ExclusiveStatus {
  const manual = getManualWatchedState(item.id);
  if (manual === "watched")     return "watched";
  if (manual === "planned")     return "in-queue";
  if (manual === "in-progress") return "in-progress";
  const off = typeof item.state?.timeOffset === "number" ? item.state.timeOffset : 0;
  const dur = typeof item.state?.duration   === "number" ? item.state.duration   : 0;
  const ratio = dur > 0 ? Math.min(1, off / dur) : 0;
  const mt = (item.media_type ?? "").toLowerCase();
  const isSeriesLike = mt === "series" || mt === "anime";
  if (ratio >= 0.9) return isSeriesLike ? "in-progress" : "watched";
  if (ratio > 0)    return "in-progress";
  return "unwatched";
}

/** Does this library item match the active media-type pill? Mirrors the
 *  single-pass partition's bucket rules (anime detected via state.genres). */
function itemMatchesTypeFilter(item: LibraryItem, filter: Filter): boolean {
  if (filter === "all") return true;
  const mt = (item.media_type ?? "").toLowerCase();
  if (filter === "movie")  return mt === "movie";
  if (filter === "series") return mt === "series";
  // anime
  const stateGenres = (item.state ?? {}).genres;
  const genres = Array.isArray(stateGenres)
    ? stateGenres.filter((g): g is string => typeof g === "string")
    : [];
  return isAnimeMeta({ media_type: item.media_type, id: item.id, genres });
}

/** True when a series in the library has an AIRED, unwatched episode past the
 *  user's watch frontier - "you're following this and it dropped something new
 *  you haven't seen." Requires engagement (a resume pointer or a watched aired
 *  episode) so a never-started series isn't flagged, mirroring
 *  `useEpisodesBehind`'s "not started" suppression. Backed by the cloud
 *  release-signal store, so it's naturally empty for guests / opted-out users /
 *  non-imdb ids (the filter just shows nothing for them). */
function hasNewUnwatchedEpisode(item: LibraryItem): boolean {
  const sig = getReleaseSignal(item.id);
  if (!sig) return false;
  const recent = Array.isArray(sig.recent_aired) ? sig.recent_aired : [];
  if (recent.length === 0) return false;
  const now = Date.now();
  const resumeId =
    typeof item.state?.video_id === "string" && item.state.video_id
      ? item.state.video_id
      : null;
  let engaged = !!resumeId;
  let hasNew = false;
  for (const ep of recent) {
    const t = Date.parse(ep.aired_at);
    if (!Number.isFinite(t) || t > now) continue; // not yet aired
    if (ep.season === 0) continue;                // specials air out-of-band
    const epId = ep.id;
    if (!epId) continue;
    if (getManualWatchedState(epId) === "watched") { engaged = true; continue; }
    if (resumeId) {
      if (epId === resumeId) { engaged = true; continue; }
      if (episodeIsBeforeResume(epId, resumeId)) { engaged = true; continue; }
    }
    hasNew = true; // aired, unwatched, at/after the frontier
  }
  return engaged && hasNew;
}

/** Watched items of a given media kind - the backlog an auto-remove toggle
 *  offers to clear on enable. "series" covers series + anime; "movie" covers
 *  movies (incl. anime movies). Uses libraryItemStatus so a "watched" series
 *  means a genuine completion mark, not a lingering last-episode offset. */
function watchedItemsOfKind(items: LibraryItem[], kind: AutoRemoveKind): LibraryItem[] {
  const out: LibraryItem[] = [];
  for (const i of items) {
    if (!i || i.removed) continue;
    const mt = (i.media_type ?? "").toLowerCase();
    const isSeriesLike = mt === "series" || mt === "anime";
    const kindMatch = kind === "movie" ? mt === "movie" : isSeriesLike;
    if (!kindMatch) continue;
    if (libraryItemStatus(i) === "watched") out.push(i);
  }
  return out;
}

interface Props {
  /** Undefined while the initial library_get is in flight. */
  library?: LibraryItem[];
  session: UserSession | null;
  onSelectMeta?: (meta: MetaPreview) => void;
  /** Soft-delete a library item. Implementer is responsible for syncing
   *  the change to Stremio (datastorePut with `removed: true`).
   *  `originPoint` lets the implementer spawn a positional fly-up toast
   *  from the click. */
  onRemoveItem?: (item: LibraryItem, originPoint?: { x: number; y: number }) => void;
  /** Bulk-remove the existing watched backlog when an auto-remove toggle is
   *  first enabled and the user confirms the one-time sweep. The implementer
   *  (App) owns the cloud write + optimistic state, same path as onRemoveItem. */
  onAutoRemoveSweep?: (kind: AutoRemoveKind, items: LibraryItem[]) => void;
}

function libraryItemToMeta(item: LibraryItem): MetaPreview {
  // Surface state.genres back into the MetaPreview's genres field so
  // anime detection downstream (right-click menus picking AniList /
  // MAL / Kitsu vs IMDb / RT / Letterboxd) keeps working when the
  // catalog's genres got persisted into the library record. Mirrors
  // what CinemaRows.libraryItemToMeta does for CW cards.
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

// ---------------------------------------------------------------------------
// Row windowing for the responsive Library grid.
//
// The grid is `repeat(auto-fill, minmax(180px, 1fr))` + a 20px gap, so the
// column count + card width vary with viewport width. Rendering all N cards
// (100s for heavy users) keeps every poster + its observers/subscriptions in
// the DOM; the transparent WebView2 then composites the lot slowly on scroll.
// This hook mounts only the rows in (or near) the viewport.
//
//   • COLUMNS — the standard CSS auto-fill count from the wrapper's measured
//     width: floor((W + gap) / (minCardW + gap)).
//   • ROW STRIDE — MEASURED from a real rendered card's height + the gap
//     (cards are uniform height — see the fixed title block in LibraryCard),
//     so we track the actual layout instead of guessing. Re-measured on
//     column change (card width → height changes). Estimate until first paint.
//   • RANGE — scrollTop (offset by the grid's position within the scroll
//     content) ± a row buffer to avoid blank flashes during fast scrolls.
//
// The grid is absolutely positioned at `offsetY` inside a full-height spacer
// so the scrollbar reflects the whole list while only ~viewport rows mount.
// ---------------------------------------------------------------------------
const LIB_GRID_GAP = 20;     // gap-5 (1.25rem)
const LIB_MIN_CARD_W = 200;  // minmax(200px, 1fr) — bigger posters (was 180)
// Cap the grid width so the column count stops scaling with the window.
// `max-w-6xl` on the content wrapper is a NO-OP here — tailwind.config
// strips the maxWidth scale ("fluid ultrawide layouts"), so the grid ran
// full-width: ~15 columns maximized on a 3440px panel → ~15 ×
// (visible + overscan rows) ≈ 150 mounted cards, each carrying its own
// IntersectionObserver / hover listener / progress subscription. That
// per-scroll mount-and-subscribe churn (NOT GPU compositing) was the
// ultrawide lag. Capping to ~8 big posters roughly halves both the
// mounted-card count and the painted poster area. Tunable — raise for
// more columns.
const LIB_MAX_GRID_W = PAGE_CONTENT_MAX_W; // px width cap for the centered grid (~8 cols); shared across pages
const LIB_BUFFER_ROWS = 2;   // overscan rows above + below (trimmed from 3)
const LIB_EST_ROW_STRIDE = 380; // pre-measure fallback: ~200px poster + h-14 title + gap

interface RowWindow {
  start: number;
  end: number;
  totalHeight: number;
  offsetY: number;
  cols: number;
}

function useLibraryRowWindow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  wrapperRef: React.RefObject<HTMLDivElement | null>,
  gridRef: React.RefObject<HTMLDivElement | null>,
  itemCount: number,
): RowWindow {
  const [cols, setCols] = useState(1);
  const [rowStride, setRowStride] = useState(LIB_EST_ROW_STRIDE);
  // Seed a first-chunk window so the initial paint shows cards immediately
  // (effects refine start/end after mount). Avoids a one-frame empty grid.
  const [range, setRange] = useState({ start: 0, end: 40 });
  // The grid's top within the scroll content (≈ header height). Cached here
  // and refreshed on resize so the scroll handler never pays a
  // getBoundingClientRect (forced reflow) per scroll event.
  const gridTopRef = useRef(0);

  // Measure layout BEFORE paint (useLayoutEffect, not useEffect) so the
  // first frame already has the right column count + row stride — otherwise
  // the grid flashes (giant 1-column scrollbar → correct) on mount. Also
  // re-measures on container/grid resize via ResizeObserver.
  //
  // NOTE: the CSS grid is `auto-fill`, so cards are ALWAYS laid out at the
  // true column count from the container width regardless of `cols` state —
  // which means the measured card height is correct immediately. `cols` only
  // needs to match that count for the windowing MATH (slice + offset).
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const wrapper = wrapperRef.current;
    if (!scroll || !wrapper) return;
    const measure = () => {
      const w = wrapper.clientWidth;
      if (w > 0) {
        const c = Math.max(1, Math.floor((w + LIB_GRID_GAP) / (LIB_MIN_CARD_W + LIB_GRID_GAP)));
        setCols((prev) => (prev === c ? prev : c));
      }
      const card = gridRef.current?.firstElementChild as HTMLElement | null;
      const h = card?.offsetHeight ?? 0;
      if (h > 0) {
        const s = h + LIB_GRID_GAP;
        setRowStride((prev) => (Math.abs(prev - s) < 0.5 ? prev : s));
      }
      const wrapRect = wrapper.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      gridTopRef.current = wrapRect.top - scrollRect.top + scroll.scrollTop;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [scrollRef, wrapperRef, gridRef, itemCount]);

  // Recompute the visible range on scroll. Cheap: reads scrollTop +
  // clientHeight + the cached gridTop — no getBoundingClientRect per event.
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const compute = () => {
      if (rowStride <= 0) return;
      const within = scroll.scrollTop - gridTopRef.current;
      const viewportH = scroll.clientHeight;
      const totalRows = Math.ceil(itemCount / cols);
      const firstRow = Math.max(0, Math.floor(within / rowStride) - LIB_BUFFER_ROWS);
      const rowsInView = Math.ceil(viewportH / rowStride) + LIB_BUFFER_ROWS * 2;
      const lastRow = Math.min(totalRows, firstRow + rowsInView);
      const nextStart = firstRow * cols;
      const nextEnd = Math.min(itemCount, lastRow * cols);
      setRange((prev) =>
        prev.start === nextStart && prev.end === nextEnd ? prev : { start: nextStart, end: nextEnd },
      );
    };
    compute();
    scroll.addEventListener("scroll", compute, { passive: true });
    return () => scroll.removeEventListener("scroll", compute);
  }, [scrollRef, cols, rowStride, itemCount]);

  const totalRows = Math.ceil(itemCount / cols);
  const totalHeight = totalRows > 0 ? totalRows * rowStride - LIB_GRID_GAP : 0;
  const offsetY = Math.floor(range.start / cols) * rowStride;
  return { start: range.start, end: range.end, totalHeight, offsetY, cols };
}

export default function LibraryView(props: Props) {
  return (
    <ErrorBoundary scope="Library">
      <LibraryViewBody {...props} />
    </ErrorBoundary>
  );
}

function LibraryViewBody({ library, session, onSelectMeta, onRemoveItem, onAutoRemoveSweep }: Props) {
  const [sort, setSort]     = useState<SortMode>("added");
  const [filter, setFilter] = useState<Filter>("all");
  // Coarse watch-status cut (All / Watched / Unwatched / In Progress / In Queue
  // / New Episodes), surfaced in the Filter & Sort panel. Combines with the
  // media-type pills + year/genre + name search below.
  const [status, setStatus] = useState<LibraryStatusFilter>("all");
  // Status is derived from manual-watched marks + release signals, neither of
  // which is React state - subscribe to both so the grid re-filters the moment
  // a mark flips or a new-episode signal lands.
  const manualVersion  = useManualWatchedVersion();
  const signalsVersion = useReleaseSignalsVersion();
  // Auto-remove-watched toggles, mirrored from auraSettings + kept live on the
  // settings-changed event. The going-forward removal runs in App (it owns the
  // cloud writes); here we only drive the toggle UI and the one-time
  // "clear existing backlog?" prompt.
  const [autoRemove, setAutoRemove] = useState(() => {
    const s = loadAuraSettings();
    return { movie: s.libraryAutoRemoveWatchedMovies, series: s.libraryAutoRemoveWatchedSeries };
  });
  useEffect(() => {
    const sync = () => {
      const s = loadAuraSettings();
      setAutoRemove({ movie: s.libraryAutoRemoveWatchedMovies, series: s.libraryAutoRemoveWatchedSeries });
    };
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);
  const [sweepPrompt, setSweepPrompt] = useState<{ kind: AutoRemoveKind; items: LibraryItem[] } | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  // Year / genre refinement plus the Sort By choice, both surfaced in
  // the header Filter & Sort panel (FilterMenu) — the same affordance
  // every other browseable surface uses. `sort` drives the ordering;
  // this FilterState only carries the year / genre filter.
  const [extraFilters, setExtraFilters] = useState<FilterState>(DEFAULT_FILTERS);
  // Always-visible name filter sitting next to the All/Movies/Series/Anime
  // pills. Lenient match (see looseMatch) applied AFTER the pill + Filter &
  // Sort pass, so it narrows whatever is currently displayed.
  const [search, setSearch] = useState("");

  // Scroll-burst class toggle. While scroll events fire (and for 150 ms
  // after the last one) the grid carries `aura-scrolling`, which CSS uses
  // to freeze per-card transitions — without that, every card's
  // `transition-transform` / `transition-opacity` sets up a GPU layer on
  // every frame and the layer count alone tanks scroll perf.
  //
  // CRITICAL: this is toggled via direct DOM (`classList`), NOT React
  // state. An earlier version held `scrolling` in useState and called
  // `setScrolling(true)` on scroll-start — that re-rendered LibraryViewBody
  // mid-scroll, which (because the card callbacks weren't referentially
  // stable) re-ran ALL ~N card component functions synchronously on the
  // main thread. On a 120+ item library that was a ~1s block: the
  // scrollbar (compositor thread) kept moving while the content (main
  // thread) stayed frozen until the re-render finished. content-visibility
  // skips off-screen PAINT but does nothing for React's JS reconciliation,
  // so the cost was paid regardless. Flipping a class imperatively keeps
  // the transition-freeze benefit with zero render cost.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Full-height spacer that owns the scrollbar extent; the grid is absolutely
  // positioned inside it at the windowed offset. See useLibraryRowWindow.
  const gridWrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = false;
    const onScroll = () => {
      if (!active) {
        active = true;
        gridRef.current?.classList.add("aura-scrolling");
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        active = false;
        gridRef.current?.classList.remove("aura-scrolling");
      }, 150);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Defensive: library prop may be undefined while the initial fetch is in
  // flight. Treat that distinctly from "explicitly empty".
  const items: LibraryItem[] = Array.isArray(library) ? library : [];
  const isLoading = library === undefined;

  // Flip an auto-remove toggle. On enable (off -> on), offer to clear the
  // existing watched backlog of that kind once; declining keeps it and only
  // future completions are auto-removed. Nothing to clear -> no prompt.
  const toggleAutoRemove = (kind: AutoRemoveKind) => {
    const s = loadAuraSettings();
    const key = kind === "movie"
      ? "libraryAutoRemoveWatchedMovies" as const
      : "libraryAutoRemoveWatchedSeries" as const;
    const next = !s[key];
    saveAuraSettings({ ...s, [key]: next });
    if (next) {
      const victims = watchedItemsOfKind(items, kind);
      if (victims.length > 0) setSweepPrompt({ kind, items: victims });
    }
  };

  // Single-pass partition: classify every live (non-removed) item into
  // its media-type buckets in ONE iteration. Previously this code did
  // 7 passes over `items` (one filter for `live`, four for counts, plus
  // the filtered+sorted derivations). On large libraries (1000+ items)
  // each filter callback re-evaluates `state.genres` parsing for the
  // anime check, which adds up.
  //
  // The anime check pulls `state.genres` (written by libraryActions on
  // every Add to Library / progress write) so anime items carry the
  // genre signal even after the catalog metadata is stripped down to
  // the bare Stremio library record. Without this, the anime filter
  // relies only on media_type / id-prefix / cache, missing every IMDb-
  // id'd anime (Frieren via tt..., etc.).
  const { buckets, counts } = useMemo(() => {
    const all: LibraryItem[] = [];
    const movie: LibraryItem[] = [];
    const series: LibraryItem[] = [];
    const anime: LibraryItem[] = [];
    for (const i of items) {
      if (!i || i.removed) continue;
      // Skip auto-tracked entries (Stremio's `temp: true` flag,
      // written by libraryWriteProgress after PROGRESS_WARMUP_S of
      // playback). These are how CW gets its "I never explicitly
      // saved this, but it remembers where I left off" behavior — they
      // belong in Continue Watching but NOT in the Library view, which
      // should reflect explicit user intent (Add to Library, Mark as
      // Planned). The CW row reads library directly with its own
      // filter so excluding temp here doesn't affect CW. Matches
      // Stremio's official client semantics.
      if (i.temp) continue;
      all.push(i);
      const mt = (i.media_type ?? "").toLowerCase();
      if (mt === "movie")  movie.push(i);
      if (mt === "series") series.push(i);
      const stateGenres = (i.state ?? {}).genres;
      const genres = Array.isArray(stateGenres)
        ? stateGenres.filter((g): g is string => typeof g === "string")
        : [];
      if (isAnimeMeta({ media_type: i.media_type, id: i.id, genres })) {
        anime.push(i);
      }
    }
    return {
      buckets: { all, movie, series, anime } as Record<Filter, LibraryItem[]>,
      counts:  { all: all.length, movie: movie.length, series: series.length, anime: anime.length } as Record<Filter, number>,
    };
  }, [items]);

  // When no status filter is active the grid is exactly as before: the
  // media-type bucket, which excludes auto-tracked (temp) entries. When a
  // status IS chosen we rebuild from ALL live items (temp included) so
  // "In Progress" / "Watched" surface Continue-Watching content the user never
  // explicitly added - then narrow to the chosen status. `manualVersion` /
  // `signalsVersion` are in the deps so the set re-derives when a mark flips or
  // a release signal lands.
  const filtered = useMemo(() => {
    if (status === "all") return buckets[filter];
    const out: LibraryItem[] = [];
    for (const i of items) {
      if (!i || i.removed) continue;
      if (!itemMatchesTypeFilter(i, filter)) continue;
      if (status === "new-episodes") {
        if (hasNewUnwatchedEpisode(i)) out.push(i);
      } else if (libraryItemStatus(i) === status) {
        out.push(i);
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, filter, buckets, items, manualVersion, signalsVersion]);

  // Project library items into MetaPreview shape so the panel's genre /
  // year filter can run uniformly across every browseable surface. The
  // conversion is cheap; library typically tops out around a few
  // hundred entries even for heavy users.
  const filteredAsMeta: MetaPreview[] = useMemo(
    () => filtered.map(libraryItemToMeta),
    [filtered],
  );
  const aggregateMeta: MetaPreview[] = useMemo(
    () => buckets.all.map(libraryItemToMeta),
    [buckets.all],
  );
  // The header Filter & Sort panel now owns BOTH axes for Library:
  // year / genre filtering via applyFilters, and the Sort By choice via
  // the panel's sortOptions (wired to `sort` / `setSort`). So we run
  // applyFilters purely for its FILTER pass (extraFilters.sort stays
  // "default") and apply Library's own ctime / mtime / alpha ordering
  // on top — no more dual-control override to reconcile.
  const filterApplied = useMemo(
    () => applyFilters(filteredAsMeta, extraFilters),
    [filteredAsMeta, extraFilters],
  );
  const filteredMetaIds = useMemo(
    () => new Set(filterApplied.map((m) => m.id)),
    [filterApplied],
  );

  const sorted = useMemo(() => {
    const arr = filtered.filter((it) => filteredMetaIds.has(it.id));
    switch (sort) {
      case "alpha":
        arr.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
        break;
      case "alpha-desc":
        arr.sort((a, b) => (b.name ?? "").localeCompare(a.name ?? ""));
        break;
      case "added":
        arr.sort((a, b) => (b.ctime ?? "").localeCompare(a.ctime ?? ""));
        break;
      case "played":
        arr.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""));
        break;
    }
    return arr;
  }, [filtered, sort, filteredMetaIds]);

  // Final name-filter pass over the already sorted/filtered list.
  const searched = useMemo(() => {
    const q = search.trim();
    if (!q) return sorted;
    return sorted.filter((it) => looseMatch(q, it.name ?? ""));
  }, [sorted, search]);

  // Windowing — only the cards in/near the viewport are mounted.
  const win = useLibraryRowWindow(scrollContainerRef, gridWrapperRef, gridRef, searched.length);
  const visible = searched.slice(win.start, win.end);

  // Reset scroll to the top when the visible set changes wholesale (filter
  // pill / sort / year-genre filter / search). Without this a deep scroll
  // position would survive into a now-shorter list and the window would
  // compute an out-of-range slice (blank grid until the user scrolls back up).
  useEffect(() => {
    scrollContainerRef.current?.scrollTo({ top: 0 });
  }, [filter, sort, extraFilters, search, status]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        {/* Width-capped, centered column. NOTE: `max-w-6xl` (or any
            `max-w-*`) emits no CSS in this project — tailwind.config
            removes the maxWidth scale — so the cap is an inline style
            keyed off LIB_MAX_GRID_W (which the row-windowing column math
            also reads, keeping CSS + JS in lockstep). */}
        <div className="mx-auto px-6 py-6 space-y-5" style={{ maxWidth: LIB_MAX_GRID_W }}>
          {/* ── Shell: header (always renders) ── */}
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="aura-row-title text-3xl font-semibold tracking-tight">Library</h1>
              <p className="text-white/35 text-sm mt-1">
                {isLoading
                  ? "Loading your synced library…"
                  : session
                    ? `${counts.all} item${counts.all === 1 ? "" : "s"} synced from your Stremio account.`
                    : "Sign in to your Stremio account to see your saved library here."}
              </p>
            </div>

            {aggregateMeta.length > 0 && (
              <div className="flex items-center gap-2">
                <LibraryOptionsMenu
                  open={optionsOpen}
                  onOpenChange={setOptionsOpen}
                  autoRemove={autoRemove}
                  onToggle={toggleAutoRemove}
                />
                <FilterMenu
                  items={aggregateMeta}
                  state={extraFilters}
                  onChange={setExtraFilters}
                  sortOptions={LIBRARY_SORT_OPTIONS}
                  sortValue={sort}
                  onSortChange={(v) => setSort(v as SortMode)}
                  statusOptions={LIBRARY_STATUS_OPTIONS}
                  statusValue={status}
                  onStatusChange={(v) => setStatus(v as LibraryStatusFilter)}
                />
              </div>
            )}
          </div>

          {/* ── Shell: filter pills (always render; counts may be 0) ── */}
          <div className="flex items-center gap-2 flex-wrap">
            {(["all", "movie", "series", "anime"] as Filter[]).map((f) => {
              const label =
                f === "all"   ? "All"   :
                f === "movie" ? "Movies" :
                f === "series"? "Series" : "Anime";
              const isActive = filter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  disabled={isLoading}
                  className={`nav-tap flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-medium
                              border transition-colors disabled:opacity-40
                              ${isActive
                                ? "bg-ln-accent/20 text-ln-accent border-ln-accent/30"
                                : "bg-white/5 text-white/55 border-white/10 hover:text-white/80 hover:bg-white/8"
                              }`}
                >
                  {label}
                  <span className="text-[10px] tabular-nums opacity-70">
                    {counts[f]}
                  </span>
                </button>
              );
            })}
            {counts.all > 0 && (
              <ListSearchInput
                value={search}
                onChange={setSearch}
                placeholder="Filter library…"
                ariaLabel="Filter library by name"
                className="ml-auto w-56"
              />
            )}
          </div>

          {/* ── Data region ── */}
          {isLoading ? (
            <SkeletonGrid />
          ) : !session ? (
            <EmptyCard message="Sign in to your Stremio account in the Addons tab to load your library." />
          ) : counts.all === 0 ? (
            <EmptyCard message='Your library is empty. Right-click any catalog poster and choose "Add to Library" to start curating.' />
          ) : searched.length === 0 ? (
            <EmptyCard
              message={search.trim()
                ? `No items match “${search.trim()}”.`
                : "No items match this filter."}
            />
          ) : (
            <div ref={gridWrapperRef} style={{ position: "relative", height: win.totalHeight }}>
              <div
                ref={gridRef}
                className="grid gap-5 aura-lib-grid"
                style={{
                  position: "absolute",
                  top: win.offsetY,
                  left: 0,
                  right: 0,
                  gridTemplateColumns: `repeat(auto-fill, minmax(${LIB_MIN_CARD_W}px, 1fr))`,
                }}
              >
                {visible.map((item) => (
                  <LibraryCard
                    key={item.id}
                    item={item}
                    onSelect={onSelectMeta}
                    onRemove={onRemoveItem}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {sweepPrompt && (
        <LibrarySweepConfirm
          kind={sweepPrompt.kind}
          count={sweepPrompt.items.length}
          onConfirm={() => {
            onAutoRemoveSweep?.(sweepPrompt.kind, sweepPrompt.items);
            setSweepPrompt(null);
          }}
          onCancel={() => setSweepPrompt(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LibraryOptionsMenu - gear popover holding the auto-remove-watched toggles.
// Sits beside the Filter & Sort menu. Uses aura-glass-menu (hardcoded-dark,
// theme-safe) so it stays legible on every theme. Each toggle carries a
// hover Tooltip explaining exactly when a removal fires (crucially, that an
// ongoing series is never touched).
// ---------------------------------------------------------------------------

function LibraryOptionsMenu({
  open, onOpenChange, autoRemove, onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  autoRemove: { movie: boolean; series: boolean };
  onToggle: (kind: AutoRemoveKind) => void;
}) {
  // Click-outside to close - the panel pins open on click (unlike FilterMenu's
  // hover model) since it holds toggles the user interacts with.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-label="Library options"
        title="Library options"
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold tracking-[0.1em] uppercase transition-colors
                    ${open
                      ? "bg-ln-accent/25 border-ln-accent/35 text-ln-accent"
                      : "bg-white/5 border-white/8 text-white/75 hover:bg-white/10"
                    }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M19.14 12.94a7.9 7.9 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7.3 7.3 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.58.24-1.12.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L2.68 8.84a.5.5 0 00.12.64l2.03 1.58a7.9 7.9 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.14.24.42.34.68.22l2.39-.96c.5.38 1.04.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54c.58-.24 1.12-.56 1.62-.94l2.39.96c.26.12.54.02.68-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z" />
        </svg>
        Options
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 pt-2">
          <div className="w-72 aura-glass-menu rounded-2xl p-4 shadow-2xl space-y-3">
            <div className="space-y-0.5">
              <p className="text-white/85 text-[13px] font-semibold">Auto-remove watched</p>
              <p className="text-white/45 text-[11px] leading-snug">
                Drop finished titles from your Library automatically.
              </p>
            </div>
            <AutoRemoveToggleRow
              label="Watched movies"
              tip="Removes a movie from your Library when you finish watching it (or mark it watched)."
              on={autoRemove.movie}
              onClick={() => onToggle("movie")}
            />
            <AutoRemoveToggleRow
              label="Watched series"
              tip="Removes a series from your Library once every aired episode is watched. Series still airing new episodes stay until they finish."
              on={autoRemove.series}
              onClick={() => onToggle("series")}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function AutoRemoveToggleRow({
  label, tip, on, onClick,
}: {
  label: string;
  tip: string;
  on: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip text={tip} pos="left" className="w-full">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={onClick}
        className="w-full flex items-center justify-between gap-3 px-2.5 py-2 rounded-lg
                   border border-white/10 bg-white/5 text-white/75
                   hover:text-white/95 hover:bg-white/10 transition-colors text-left"
      >
        <span className="text-[12px] font-medium">{label}</span>
        <span
          className={`relative flex-shrink-0 w-8 h-[18px] rounded-full transition-colors
                      ${on ? "bg-ln-accent/70" : "bg-white/15"}`}
        >
          <span
            className={`absolute top-0.5 w-[14px] h-[14px] rounded-full bg-white transition-all
                        ${on ? "left-[18px]" : "left-0.5"}`}
          />
        </span>
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// LibrarySweepConfirm - the one-time "clear the existing watched backlog?"
// prompt shown when an auto-remove toggle is first enabled. Opaque zinc panel
// (theme-independent) portal-rendered over a dim backdrop; Esc / click-outside
// cancel. Declining keeps the backlog; either way future completions are
// auto-removed.
// ---------------------------------------------------------------------------

function LibrarySweepConfirm({
  kind, count, onConfirm, onCancel,
}: {
  kind: AutoRemoveKind;
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const noun = kind === "movie"
    ? (count === 1 ? "movie" : "movies")
    : (count === 1 ? "series" : "series");
  const title = `Clear already-watched ${kind === "movie" ? "movies" : "series"}?`;

  const node = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm
                 animate-[fade-in_120ms_ease-out]"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="max-w-[400px] w-full rounded-2xl bg-zinc-900/95 border border-white/15 ring-1 ring-rose-400/40
                   shadow-2xl p-6 space-y-4"
      >
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 mt-0.5 text-2xl leading-none text-rose-300" aria-hidden>⚠</span>
          <div className="flex-1 min-w-0 space-y-1.5">
            <h3 className="text-white font-semibold text-[15px] leading-tight">{title}</h3>
            <p className="text-white/70 text-[13px] leading-relaxed">
              You have {count} watched {noun} already in your Library. Remove {count === 1 ? "it" : "them"} now?
              New watched {kind === "movie" ? "movies" : "series"} are auto-removed going forward either way.
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/80 text-[12px] font-medium hover:bg-white/10 transition-colors"
          >
            Keep them
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-1.5 rounded-lg border border-rose-300/60 bg-rose-500/30 text-rose-50
                       text-[12px] font-medium hover:bg-rose-500/45 transition-colors"
          >
            Remove {count}
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

// ---------------------------------------------------------------------------
// SkeletonGrid — shown while library is undefined (initial fetch in flight).
// ---------------------------------------------------------------------------

function SkeletonGrid() {
  return (
    <div
      className="grid gap-5 pb-6"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${LIB_MIN_CARD_W}px, 1fr))` }}
    >
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div
            className="rounded-xl image-loader-skeleton"
            style={{ aspectRatio: "2 / 3" }}
          />
          <div className="h-3 mx-4 rounded image-loader-skeleton" />
          <div className="h-2 mx-8 rounded image-loader-skeleton" />
        </div>
      ))}
    </div>
  );
}

function EmptyCard({ message }: { message: string }) {
  return (
    <div className="glass-panel rounded-2xl px-6 py-10 text-center">
      <p className="text-white/65 text-sm">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LibraryCard — poster + name + type pill, with right-click context menu.
// ---------------------------------------------------------------------------

const LibraryCard = memo(function LibraryCard({
  item, onSelect, onRemove,
}: {
  item: LibraryItem;
  onSelect?: (meta: MetaPreview) => void;
  // Takes `item` so the parent can pass ONE stable callback for every card
  // (a per-card `(origin) => onRemove(item, origin)` closure would change
  // identity each render and defeat this component's `memo`).
  onRemove?: (item: LibraryItem, origin: { x: number; y: number }) => void;
}) {
  const meta = libraryItemToMeta(item);
  const hover = useHoverCardActivation(meta);

  return (
    <div
      className="group relative flex flex-col gap-2 card-contain aura-lib-card"
      data-meta-card={`${item.media_type}:${item.id}`}
    >
      <button
        type="button"
        onClick={() => { closeHoverNow(); onSelect?.(meta); }}
        onContextMenu={(e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("aura:card-context", {
            detail: { meta, x: e.clientX, y: e.clientY },
          }));
        }}
        {...hover}
        className="flex flex-col gap-2 text-left
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl"
      >
        <div
          className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
          style={{ aspectRatio: "2 / 3" }}
        >
          {item.poster ? (
            <ImageLoader
              // Downsize oversized masters (TMDB original / metahub large) to
              // card width: a 2000x3000 poster decoded into a ~180px tile is
              // brutal for the compositor to re-raster on every scroll frame.
              // 360 = 2x a 180px card for hi-DPI crispness. `perfLabel` logs any
              // still-oversized poster to the DevConsole (filter `[lib-poster]`).
              src={shrinkPoster(item.poster, 360)}
              perfLabel={item.name ?? item.id}
              alt={item.name ?? ""}
              // Eager: the row-windowing already mounts only near-viewport
              // rows (+overscan), so ImageLoader's per-card
              // IntersectionObserver is redundant here — it just adds one
              // observer per mounted card (~80+) that churns on every
              // scroll. Eager loading drops the observer entirely and the
              // poster is fetched the moment its row enters the window.
              loading="eager"
              className="absolute inset-0 w-full h-full"
              imgClassName="w-full h-full object-cover"
              fallback={<PosterFallback />}
            />
          ) : (
            <PosterFallback />
          )}
          {/* Watched / in-progress / planned indicator — top-LEFT to
              avoid the addon-stamped quality badge top-right and the
              rating tiles bottom. mediaType is passed so series get
              the demotion rule (auto-watched on a series is read as
              in-progress because library state is per-LAST-episode,
              not series-level). */}
          <WatchedBadge
            metaId={item.id}
            mediaType={item.media_type}
            className="absolute top-1.5 left-1.5"
          />
        </div>
        {/* Fixed-height label block (h-14) so every card is the SAME total
            height regardless of whether the title wraps to 1 or 2 lines.
            Uniform card height is what lets the windowing hook derive an
            accurate per-row stride from a single measured card. */}
        <div className="px-0.5 h-14 overflow-hidden">
          <p className="text-white/85 text-sm font-medium leading-tight line-clamp-2 text-center">
            {item.name ?? "Unknown title"}
          </p>
          <div className="flex items-center justify-center gap-1.5 mt-1">
            <span className="text-white/40 text-[10px] uppercase tracking-wider">
              {typeLabel(item.media_type ?? "other")}
            </span>
          </div>
          {/* Year intentionally omitted from the card meta line: not
              every library item carries a parsed `year` (older Stremio
              cloud entries can land without `release_info` populated),
              and a sometimes-present sometimes-absent year reads as a
              data bug rather than design. The detail page meta strip
              still surfaces release info when it has it. */}
        </div>
      </button>

      {/* Hover-only remove button. Sits absolutely over the poster's
          top-right corner; pointer-events-none on the wrapper means it
          doesn't catch clicks meant for the underlying card unless the
          user explicitly hovers it. */}
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${item.name ?? "item"} from library`}
          title="Remove from library"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onRemove(item, { x: e.clientX, y: e.clientY });
          }}
          className="absolute top-2 right-2 w-7 h-7 rounded-full
                     bg-black/70 backdrop-blur-md border border-white/20
                     text-white/85 hover:text-white hover:bg-rose-500/40
                     hover:border-rose-300/50
                     flex items-center justify-center
                     opacity-0 group-hover:opacity-100 focus:opacity-100
                     transition-all duration-150 z-10"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      )}
    </div>
  );
});

function PosterFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-white/20">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
      </svg>
    </div>
  );
}
