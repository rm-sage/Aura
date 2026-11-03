// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DndContext,
  pointerWithin,
  rectIntersection,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { AddonEntry, LibraryItem, MetaPreview } from "../types";
import {
  getPlannedQueue,
  setManualWatchedOrder,
  setManualWatchedState,
  onManualWatchedChange,
} from "../manualWatched";
import ImageLoader from "../ImageLoader";
import { shrinkPoster } from "../posterSize";
import ErrorBoundary from "../ErrorBoundary";
import WatchedBadge from "../WatchedBadge";
import { showAppToast } from "../AppToast";
import { typeLabel, useAnimeCacheVersion } from "../aiometadata";
import {
  MediaTypePills, classifyMediaKinds, facetCounts, kindMatches,
  type MediaKinds, type MediaTypeFilter,
} from "../mediaTypePills";
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "../FilterBar";
import { isAiring } from "../airing";
import { useReleaseSignalsVersion } from "../releaseSignalStore";
import ListSearchInput, { looseMatch } from "../ListSearchInput";
import { PAGE_CONTENT_MAX_W } from "../pageLayout";
import { closeHoverNow } from "../catalogHoverStore";
import {
  getMetaCacheVersion, getMetaDetailFallback, peekCachedDetailById, peekRichestCachedDetailById,
  subscribeMetaCache,
} from "../metaCache";
import { useHoverCardActivation } from "../useHoverCardActivation";
import { loadAuraSettings, saveAuraSettings } from "../auraSettings";

// ---------------------------------------------------------------------------
// QueueView — ordered list of items the user has marked as "planned".
//
// Differences from the Library:
//   • Order is intentional. Drag-to-reorder via @dnd-kit; persisted
//     via setManualWatchedOrder.
//   • Watched / in-progress / planned indicators visible per tile —
//     same WatchedBadge component the rest of the app uses, so the
//     state colour scheme reads consistently.
//   • Keyboard-accessible: focus a tile, press Space to lift, arrow
//     keys to move, Space to drop. Standard dnd-kit keyboard sensor.
//   • Empty-state hint that explains how items get here (right-click →
//     Mark as Planned anywhere in the app).
//
// Items are looked up against the library (which a signed-in user's
// "planned" items are auto-added to). An id that isn't in the library (a
// guest's queue, a title removed in another client) renders as a stub built
// from the meta cache, so it stays readable and removable from the queue.
// ---------------------------------------------------------------------------

/** Kinds for an id not in the projection (a stub while the library loads): All only. */
const NO_KINDS: MediaKinds = { movie: false, series: false, anime: false };

/** Stubs with nothing cached that one visit looks up, and how many at a time.
 *  What it finds stays in the meta cache, so a longer queue fills in over visits. */
const STUB_LOOKUPS_PER_VISIT = 40;
const STUB_LOOKUP_CONCURRENCY = 3;

/** The tile for a queued id with no library record. The planned store holds
 *  only id -> state, so name, poster and type come from the meta cache; with
 *  nothing cached it is the bare id, typed "other". No year, so the year gate
 *  cannot judge it; its genres are the cached detail's, when there is one. */
function queueStubMeta(id: string): MetaPreview {
  const d = peekRichestCachedDetailById(id) ?? peekCachedDetailById(id);
  return {
    id,
    name:         d?.name || id,
    media_type:   d?.media_type || "other",
    poster:       d?.poster ?? null,
    background:   d?.background ?? null,
    fanart:       null,
    backdrop:     null,
    logo:         d?.logo ?? null,
    release_info: null,
    description:  null,
    imdb_rating:  null,
    genres:       d?.genres ?? [],
  };
}

interface Props {
  library: LibraryItem[];
  /** False until the first library answer, while a missing record proves
   *  nothing: no stubs and no empty message then. A failed fetch is no answer,
   *  so App passes `libraryKnown && !libraryLoadFailed` (its own flag turns true
   *  after a failure, and never for a guest, since no loadLibrary runs). */
  libraryLoaded: boolean;
  /** The library could not be fetched and nothing is known about it. */
  loadFailed: boolean;
  onRetryLoad: () => void;
  /** The list stub lookups ask: the account's, or a guest's local one. */
  addons: AddonEntry[];
  onSelectMeta?: (meta: MetaPreview) => void;
}

export default function QueueView(props: Props) {
  return (
    <ErrorBoundary scope="Queue">
      <QueueViewBody {...props} />
    </ErrorBoundary>
  );
}

function QueueViewBody({ library, libraryLoaded, loadFailed, onRetryLoad, addons, onSelectMeta }: Props) {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => getPlannedQueue());
  // Year / genre / rating refinement layered on top of the manual
  // queue order. Default sort = "default" preserves the user's
  // drag-reorder; switching to year/rating/name re-sorts inside the
  // filtered subset, which is fine since the filter is opt-in.
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  // Always-visible name filter beside the queue's Filter & Sort controls.
  const [search, setSearch] = useState("");
  // All / Movies / Series / Anime pill, the same control (and the same
  // session-only state) as the Library page's.
  const [typeFilter, setTypeFilter] = useState<MediaTypeFilter>("all");
  // Re-classify the Series/Anime split when the background meta warm marks a
  // newly-resolved IMDb-id'd anime (App.tsx poster-warm effect).
  const animeCacheVersion = useAnimeCacheVersion();
  // "Remove series from Queue once started" toggle, mirrored from
  // auraSettings + synced on settings change (the reconciliation effect in
  // App.tsx reads the same setting and prunes accordingly). Movies always
  // leave once watched, regardless of this toggle.
  const [removeStartedSeries, setRemoveStartedSeries] = useState(
    () => loadAuraSettings().queueRemoveSeriesInProgress,
  );
  useEffect(() => {
    const sync = () =>
      setRemoveStartedSeries(loadAuraSettings().queueRemoveSeriesInProgress);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);
  const toggleRemoveStartedSeries = () => {
    const s = loadAuraSettings();
    saveAuraSettings({
      ...s,
      queueRemoveSeriesInProgress: !s.queueRemoveSeriesInProgress,
    });
  };

  useEffect(() => {
    const sync = () => setOrderedIds(getPlannedQueue());
    return onManualWatchedChange(sync);
  }, []);

  const libIndex = useMemo(() => {
    const map = new Map<string, LibraryItem>();
    for (const it of library) map.set(it.id, it);
    return map;
  }, [library]);

  // Re-derive the airing narrow when cloud release signals land.
  const signalsVersion = useReleaseSignalsVersion();

  // The ids with no library record. A key so a detail landing does not restart
  // the lookups below; it stays empty until a missing record means something.
  const stubIdsKey = useMemo(
    () => (libraryLoaded ? orderedIds.filter((id) => !libIndex.has(id)).join("\n") : ""),
    [orderedIds, libIndex, libraryLoaded],
  );

  // A stub re-reads the meta cache when a detail lands (a queue with none
  // ignores those writes). The cache's TTL drops a stub's detail, and nothing
  // else refetches it, so the lookups below heal the tile.
  const stubMetaSnapshot = () => (stubIdsKey ? getMetaCacheVersion() : 0);
  const stubMetaVersion = useSyncExternalStore(subscribeMetaCache, stubMetaSnapshot, stubMetaSnapshot);
  const stubs = useMemo(() => {
    void stubMetaVersion;
    const map = new Map<string, MetaPreview>();
    if (stubIdsKey) for (const id of stubIdsKey.split("\n")) map.set(id, queueStubMeta(id));
    return map;
  }, [stubIdsKey, stubMetaVersion]);

  // Look up stubs with no fresh detail. The store has no type, so probe in
  // advanceToQueueNext's order; keepThin so a series answer with no episodes
  // still names the tile. Each id once per visit (a miss is not retried here).
  const stubLookedUpRef = useRef(new Set<string>());
  useEffect(() => {
    if (!stubIdsKey || addons.length === 0) return;
    let cancelled = false;
    void (async () => {
      const tried = stubLookedUpRef.current;
      const pending = stubIdsKey.split("\n").filter(
        (id) => !tried.has(id) && !peekRichestCachedDetailById(id) && !peekCachedDetailById(id),
      );
      const worker = async () => {
        while (!cancelled && pending.length > 0 && tried.size < STUB_LOOKUPS_PER_VISIT) {
          const id = pending.shift()!;
          tried.add(id);
          for (const type of ["series", "anime", "movie"]) {
            if (cancelled) { tried.delete(id); return; }
            const d = await getMetaDetailFallback(addons, type, id, { keepThin: true }).catch(() => null);
            if (d) break;
          }
        }
      };
      await Promise.all(Array.from({ length: STUB_LOOKUP_CONCURRENCY }, worker));
    })();
    return () => { cancelled = true; };
  }, [stubIdsKey, addons]);

  // Build the MetaPreview projection used by the FilterBar — same
  // shape every browseable view uses so the filter behaves identically
  // (year / rating / genre gates).
  const queuedAsMeta: MetaPreview[] = useMemo(() => {
    const out: MetaPreview[] = [];
    for (const id of orderedIds) {
      const it = libIndex.get(id);
      if (!it) {
        const stub = stubs.get(id);
        if (stub) out.push(stub);
        continue;
      }
      const stateGenres = (it.state ?? {}).genres;
      const genres = Array.isArray(stateGenres)
        ? stateGenres.filter((g): g is string => typeof g === "string")
        : [];
      out.push({
        id:           it.id,
        name:         it.name,
        media_type:   it.media_type,
        poster:       it.poster,
        background:   it.background,
        fanart:       null,
        backdrop:     null,
        logo:         it.logo,
        release_info: it.year ?? null,
        description:  null,
        imdb_rating:  null,
        genres,
      });
    }
    return out;
  }, [orderedIds, libIndex, stubs]);
  // applyFilters returns the items in the panel's chosen sort order —
  // so we use THAT order when the sort axis is non-default, and fall
  // back to the user's manual drag order otherwise. The two modes
  // coexist: drag = "default", Filter & Sort "Sort By" = override.
  const filterApplied = useMemo(
    () => applyFilters(queuedAsMeta, filters),
    [queuedAsMeta, filters],
  );
  const filteredOrderedIds = useMemo(() => {
    void signalsVersion; // re-derive the airing narrow when signals land
    let ids: string[];
    if (filters.sort !== "default") {
      ids = filterApplied.map((m) => m.id);
    } else {
      const visible = new Set(filterApplied.map((m) => m.id));
      ids = orderedIds.filter((id) => visible.has(id));
    }
    // A stub has no year to test, so it shows only while the range is unbounded.
    // (The airing narrow rejects its missing record.)
    if (Number.isFinite(filters.yearMin) || Number.isFinite(filters.yearMax)) {
      ids = ids.filter((id) => libIndex.has(id));
    }
    // Airing-only narrow (cheap: cloud next_aired via the shared predicate).
    if (filters.airingOnly) {
      ids = ids.filter((id) => { const it = libIndex.get(id); return it ? isAiring(it) : false; });
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedIds, filterApplied, filters.sort, filters.yearMin, filters.yearMax, filters.airingOnly, libIndex, signalsVersion]);

  // Lenient name filter on top of the filter/sort pass (see looseMatch).
  const searchedOrderedIds = useMemo(() => {
    const q = search.trim();
    if (!q) return filteredOrderedIds;
    return filteredOrderedIds.filter((id) => looseMatch(q, libIndex.get(id)?.name ?? stubs.get(id)?.name ?? id));
  }, [filteredOrderedIds, search, libIndex, stubs]);

  // Media-type kinds per queued item, classified once per queue / library
  // change from the same projection the Filter & Sort panel reads (its
  // genres are the record's `state.genres`, which is what catches an
  // IMDb-id'd anime), with the Library's exact rules: Series is live-action
  // only, anime has its own pill. A stub reads the same way, from what the meta
  // cache gave it, so the pill agrees with its tile; a bare id is typed "other"
  // and lands under All only, unless its id prefix proves it anime.
  const kindsById = useMemo(() => {
    const map = new Map<string, MediaKinds>();
    for (const m of queuedAsMeta) {
      map.set(m.id, classifyMediaKinds(m.media_type, m.id, m.genres));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queuedAsMeta, animeCacheVersion]);

  // Faceted pill counts over everything the OTHER filters leave (year /
  // genre, airing, search), so each pill shows what selecting it would show
  // and picking one does not zero the rest. The grid is the pill's slice of
  // that same list, keeping the queue order (or the panel's sort).
  const typeCounts = useMemo(
    () => facetCounts(searchedOrderedIds, (id) => kindsById.get(id) ?? NO_KINDS),
    [searchedOrderedIds, kindsById],
  );
  const displayedIds = useMemo(() => {
    if (typeFilter === "all") return searchedOrderedIds;
    return searchedOrderedIds.filter((id) => kindMatches(kindsById.get(id) ?? NO_KINDS, typeFilter));
  }, [searchedOrderedIds, kindsById, typeFilter]);

  const sensors = useSensors(
    // 6 px activation distance — clicks under 6 px don't trigger a
    // drag, so tile clicks open the detail page reliably.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Hybrid collision: prefer the tile the pointer is actually inside —
  // this is what the user visually expects ("my mouse is over tile B
  // → swap with B"). Falls back to rectIntersection (most overlap)
  // when the pointer isn't inside any droppable, e.g. when dragging
  // through inter-tile gaps.
  //
  // Why not closestCenter / closestCorners: both measure DISTANCE
  // between rect anchors, so a half-tile drag toward a neighbor still
  // leaves the dragged tile's center "closer" to its origin slot than
  // to the neighbor's center, and the swap doesn't fire until the
  // dragged tile's center has crossed past the neighbor's center —
  // which feels like "I have to drag past two tiles before anything
  // happens" exactly as reported.
  const collisionDetectionStrategy: CollisionDetection = (args) => {
    const inside = pointerWithin(args);
    if (inside.length > 0) return inside;
    return rectIntersection(args);
  };

  // Sort By owns the display, so a drag there would rewrite the hidden manual
  // order behind a tile that snaps back.
  const reorderable = filters.sort === "default";

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!reorderable || !over || active.id === over.id) return;
    const oldIdx = orderedIds.indexOf(String(active.id));
    const newIdx = orderedIds.indexOf(String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(orderedIds, oldIdx, newIdx);
    // Both updates run as plain calls in this event handler — React 18
    // batches them. CRITICAL: setManualWatchedOrder is a side effect
    // (it dispatches a CHANGE_EVENT that synchronously calls
    // setOrderedIds again from the listener). Calling it from inside a
    // setOrderedIds(updater) treats it as "setState during render",
    // which React drops on the floor — that's exactly the symptom the
    // user reported (visual reorder fires via rectSortingStrategy, but
    // on drop the dragged tile snaps back because the state never
    // actually committed).
    setOrderedIds(next);
    setManualWatchedOrder(next);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="aura-page-scroller flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="mx-auto px-6 py-6 space-y-5" style={{ maxWidth: PAGE_CONTENT_MAX_W }}>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="aura-row-title text-3xl font-semibold tracking-tight">Queue</h1>
              <p className="text-white/35 text-sm mt-1">
                {orderedIds.length === 0
                  ? "Your queue is empty. Right-click anything in the catalog and choose 'Mark as Planned' to add it here."
                  : `${orderedIds.length} planned · ${reorderable ? "drag tiles to reorder" : "set Sort By to Default to reorder"}.`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={removeStartedSeries}
                onClick={toggleRemoveStartedSeries}
                title="When on, a series leaves the Queue once you start watching it (any episode). Movies always leave the Queue once watched."
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium
                           border border-white/10 bg-white/5 text-white/65
                           hover:text-white/90 hover:bg-white/8 transition-colors"
              >
                <span
                  className={`relative w-8 h-[18px] rounded-full transition-colors
                              ${removeStartedSeries ? "bg-ln-accent/70" : "bg-white/15"}`}
                >
                  <span
                    className={`absolute top-0.5 w-[14px] h-[14px] rounded-full bg-white transition-all
                                ${removeStartedSeries ? "left-[18px]" : "left-0.5"}`}
                  />
                </span>
                Remove started series
              </button>
              {queuedAsMeta.length > 0 && (
                <FilterMenu items={queuedAsMeta} state={filters} onChange={setFilters} showAiringToggle />
              )}
            </div>
          </div>

          {orderedIds.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <MediaTypePills value={typeFilter} onChange={setTypeFilter} counts={typeCounts} />
              {/* Same row and placement as Library's name filter. Keyed on
                  the whole queue (this row's gate), not the faceted count: a
                  search that matches nothing must not hide its own box. */}
              <ListSearchInput
                value={search}
                onChange={setSearch}
                placeholder="Filter queue…"
                ariaLabel="Filter queue by name"
                className="ml-auto w-56"
              />
            </div>
          )}

          {orderedIds.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                Items you mark as Planned appear here in the order you queue
                them. Drag a tile up or down to change its position.
              </p>
            </div>
          ) : displayedIds.length === 0 && loadFailed ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center space-y-3">
              <p className="text-white/65 text-sm">
                Could not load your queue. Check your connection and try again.
              </p>
              <button
                type="button"
                onClick={onRetryLoad}
                className="px-4 py-1.5 rounded-lg border border-white/15 bg-white/5
                           text-white/80 text-[12px] font-medium hover:bg-white/10 transition-colors"
              >
                Retry
              </button>
            </div>
          ) : displayedIds.length === 0 && !libraryLoaded ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">Loading your queue…</p>
            </div>
          ) : displayedIds.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                {search.trim()
                  ? `No queued items match “${search.trim()}”.`
                  : "No queued items match this filter."}
              </p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={collisionDetectionStrategy}
              onDragStart={() => closeHoverNow()}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={displayedIds} strategy={rectSortingStrategy} disabled={!reorderable}>
                <div
                  className="grid gap-5 pb-6"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
                >
                  {displayedIds.map((id) => {
                    const lib = libIndex.get(id);
                    return (
                      <QueueCard
                        key={id}
                        id={id}
                        item={lib ?? null}
                        stub={stubs.get(id) ?? null}
                        reorderable={reorderable}
                        onSelect={onSelectMeta}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

    </div>
  );
}

// ---------------------------------------------------------------------------
// QueueCard — sortable tile. Wraps the standard library-card styling
// with dnd-kit's transform binding. Click navigates to detail (drag
// distance gate prevents misfires).
// ---------------------------------------------------------------------------

function QueueCard({
  id, item, stub, reorderable, onSelect,
}: {
  id: string;
  item: LibraryItem | null;
  stub: MetaPreview | null;
  reorderable: boolean;
  onSelect?: (meta: MetaPreview) => void;
}) {
  const sortable = useSortable({ id });
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = sortable;

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
    zIndex:  isDragging ? 50 : undefined,
  };

  const meta: MetaPreview = item
    ? {
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
        genres:       Array.isArray((item.state ?? {}).genres)
          ? ((item.state ?? {}).genres as string[]).filter((g): g is string => typeof g === "string")
          : [],
      }
    : stub ?? queueStubMeta(id);

  // Nothing known but the id: its type is a guess no detail page or menu can
  // use, so the tile can only be dragged or removed.
  const bare = !item && meta.media_type === "other";

  const hover = useHoverCardActivation(meta);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(bare ? {} : hover)}
      className="group relative flex flex-col gap-2 card-contain"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-disabled={bare || undefined}
        onClick={() => { if (bare) return; closeHoverNow(); onSelect?.(meta); }}
        onContextMenu={(e) => {
          e.preventDefault();
          if (bare) return;
          window.dispatchEvent(new CustomEvent("aura:card-context", {
            detail: { meta, x: e.clientX, y: e.clientY, source: "queue" },
          }));
        }}
        className={`flex flex-col gap-2 text-left
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl
                   ${reorderable ? "cursor-grab active:cursor-grabbing" : bare ? "cursor-default" : "cursor-pointer"}`}
      >
        <div
          className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
          style={{ aspectRatio: "2 / 3" }}
        >
          {meta.poster ? (
            <ImageLoader
              src={shrinkPoster(meta.poster)}
              alt={meta.name ?? ""}
              className="absolute inset-0 w-full h-full"
              imgClassName="w-full h-full object-cover"
              fallback={<PosterFallback />}
            />
          ) : (
            <PosterFallback />
          )}

          {/* State indicator — top-left, same scheme as catalog cards. */}
          <WatchedBadge
            metaId={meta.id}
            mediaType={meta.media_type}
            className="absolute top-1.5 left-1.5"
          />
        </div>
        <div className="px-0.5">
          <p className="text-white/85 text-sm font-medium leading-tight line-clamp-2 text-center">
            {meta.name}
          </p>
          <div className="flex items-center justify-center gap-1.5 mt-1">
            {/* Match the Library tile chrome — media-type label only,
                no trailing year. Stremio's `year` field on library
                items is inconsistent (off-by-one, missing, or
                reporting first-aired-of-cour-2 instead of show
                start), which the user already removed from the
                Library grid; mirror that here so the two surfaces
                stay visually consistent. */}
            <span className="text-white/40 text-[10px] uppercase tracking-wider">
              {typeLabel(meta.media_type ?? "other")}
            </span>
          </div>
        </div>
      </button>

      {/* Quick-remove X — same affordance the Library grid uses. */}
      <button
        type="button"
        aria-label={`Remove ${meta.name ?? "item"} from queue`}
        title="Remove from queue"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setManualWatchedState(meta.id, null);
          showAppToast(`Removed from Queue · ${meta.name}`);
        }}
        className="absolute top-2 right-2 w-7 h-7 rounded-full
                   bg-black/70 border border-white/20
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
    </div>
  );
}

function PosterFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center text-white/20">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
      </svg>
    </div>
  );
}
