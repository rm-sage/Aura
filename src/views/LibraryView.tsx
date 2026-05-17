// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryItem, MetaPreview } from "../types";
import type { UserSession } from "../LoginView";
import ImageLoader from "../ImageLoader";
import ErrorBoundary from "../ErrorBoundary";
import { isAnimeMeta, typeLabel } from "../aiometadata";
import WatchedBadge from "../WatchedBadge";
import {
  FilterMenu, applyFilters, DEFAULT_FILTERS,
  type FilterState, type SortOption,
} from "../FilterBar";

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

export default function LibraryView(props: Props) {
  return (
    <ErrorBoundary scope="Library">
      <LibraryViewBody {...props} />
    </ErrorBoundary>
  );
}

function LibraryViewBody({ library, session, onSelectMeta, onRemoveItem }: Props) {
  const [sort, setSort]     = useState<SortMode>("added");
  const [filter, setFilter] = useState<Filter>("all");
  // Year / genre refinement plus the Sort By choice, both surfaced in
  // the header Filter & Sort panel (FilterMenu) — the same affordance
  // every other browseable surface uses. `sort` drives the ordering;
  // this FilterState only carries the year / genre filter.
  const [extraFilters, setExtraFilters] = useState<FilterState>(DEFAULT_FILTERS);

  // Scroll-debounced "is the user actively scrolling" flag. The
  // wrapper's class flips on while scroll events are firing and 150 ms
  // after the last one, the class drops back off. CSS uses this to
  // freeze per-card transitions during a scroll burst — without that,
  // every card's `transition-transform` / `transition-opacity` set up
  // GPU layers on every frame, and on a 45+ visible-card ultrawide
  // layout the layer count alone tanks scroll perf.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrolling, setScrolling] = useState(false);
  useEffect(() => {
    const node = scrollContainerRef.current;
    if (!node) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (!scrolling) setScrolling(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setScrolling(false), 150);
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      node.removeEventListener("scroll", onScroll);
      if (timer) clearTimeout(timer);
    };
  }, [scrolling]);

  // Defensive: library prop may be undefined while the initial fetch is in
  // flight. Treat that distinctly from "explicitly empty".
  const items: LibraryItem[] = Array.isArray(library) ? library : [];
  const isLoading = library === undefined;

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

  const filtered = buckets[filter];

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

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">
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
              <FilterMenu
                items={aggregateMeta}
                state={extraFilters}
                onChange={setExtraFilters}
                sortOptions={LIBRARY_SORT_OPTIONS}
                sortValue={sort}
                onSortChange={(v) => setSort(v as SortMode)}
              />
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
          </div>

          {/* ── Data region ── */}
          {isLoading ? (
            <SkeletonGrid />
          ) : !session ? (
            <EmptyCard message="Sign in to your Stremio account in the Addons tab to load your library." />
          ) : counts.all === 0 ? (
            <EmptyCard message='Your library is empty. Right-click any catalog poster and choose "Add to Library" to start curating.' />
          ) : sorted.length === 0 ? (
            <EmptyCard message="No items match this filter." />
          ) : (
            <div
              className={`grid gap-5 pb-6 aura-lib-grid${scrolling ? " aura-scrolling" : ""}`}
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
            >
              {sorted.map((item) => (
                <LibraryCard
                  key={item.id ?? Math.random()}
                  item={item}
                  onSelect={onSelectMeta}
                  onRemove={onRemoveItem ? (origin) => onRemoveItem(item, origin) : undefined}
                />
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonGrid — shown while library is undefined (initial fetch in flight).
// ---------------------------------------------------------------------------

function SkeletonGrid() {
  return (
    <div
      className="grid gap-5 pb-6"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
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
  onRemove?: (origin: { x: number; y: number }) => void;
}) {
  const meta = libraryItemToMeta(item);

  return (
    <div
      className="group relative flex flex-col gap-2 card-contain aura-lib-card"
      data-meta-card={`${item.media_type}:${item.id}`}
    >
      <button
        type="button"
        onClick={() => onSelect?.(meta)}
        onContextMenu={(e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("aura:card-context", {
            detail: { meta, x: e.clientX, y: e.clientY },
          }));
        }}
        className="flex flex-col gap-2 text-left
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl"
      >
        <div
          className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
          style={{ aspectRatio: "2 / 3" }}
        >
          {item.poster ? (
            <ImageLoader
              src={item.poster}
              alt={item.name ?? ""}
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
        <div className="px-0.5">
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
            onRemove({ x: e.clientX, y: e.clientY });
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
