// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
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
import type { LibraryItem, MetaPreview } from "../types";
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
import { typeLabel } from "../aiometadata";
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "../FilterBar";
import { isAiring } from "../airing";
import { useReleaseSignalsVersion } from "../releaseSignalStore";
import ListSearchInput, { looseMatch } from "../ListSearchInput";
import { PAGE_CONTENT_MAX_W } from "../pageLayout";
import { closeHoverNow } from "../catalogHoverStore";
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
// Items are looked up against the library (which the user's "planned"
// items are auto-added to). When an id isn't in the library we render
// a minimal stub so removed/orphaned entries are still removable from
// the queue.
// ---------------------------------------------------------------------------

interface Props {
  library: LibraryItem[];
  onSelectMeta?: (meta: MetaPreview) => void;
}

export default function QueueView(props: Props) {
  return (
    <ErrorBoundary scope="Queue">
      <QueueViewBody {...props} />
    </ErrorBoundary>
  );
}

function QueueViewBody({ library, onSelectMeta }: Props) {
  const [orderedIds, setOrderedIds] = useState<string[]>(() => getPlannedQueue());
  // Year / genre / rating refinement layered on top of the manual
  // queue order. Default sort = "default" preserves the user's
  // drag-reorder; switching to year/rating/name re-sorts inside the
  // filtered subset, which is fine since the filter is opt-in.
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  // Always-visible name filter beside the queue's Filter & Sort controls.
  const [search, setSearch] = useState("");
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

  // Build the MetaPreview projection used by the FilterBar — same
  // shape every browseable view uses so the filter behaves identically
  // (year / rating / genre gates).
  const queuedAsMeta: MetaPreview[] = useMemo(() => {
    const out: MetaPreview[] = [];
    for (const id of orderedIds) {
      const it = libIndex.get(id);
      if (!it) continue;
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
  }, [orderedIds, libIndex]);
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
    // Airing-only narrow (cheap: cloud next_aired via the shared predicate).
    if (filters.airingOnly) {
      ids = ids.filter((id) => { const it = libIndex.get(id); return it ? isAiring(it) : false; });
    }
    return ids;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedIds, filterApplied, filters.sort, filters.airingOnly, libIndex, signalsVersion]);

  // Lenient name filter on top of the filter/sort pass (see looseMatch).
  const searchedOrderedIds = useMemo(() => {
    const q = search.trim();
    if (!q) return filteredOrderedIds;
    return filteredOrderedIds.filter((id) => looseMatch(q, libIndex.get(id)?.name ?? id));
  }, [filteredOrderedIds, search, libIndex]);

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

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
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
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="mx-auto px-6 py-6 space-y-5" style={{ maxWidth: PAGE_CONTENT_MAX_W }}>
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="aura-row-title text-3xl font-semibold tracking-tight">Queue</h1>
              <p className="text-white/35 text-sm mt-1">
                {orderedIds.length === 0
                  ? "Your queue is empty. Right-click anything in the catalog and choose 'Mark as Planned' to add it here."
                  : `${orderedIds.length} planned · drag tiles to reorder.`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {orderedIds.length > 0 && (
                <ListSearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="Filter queue…"
                  ariaLabel="Filter queue by name"
                  className="w-48"
                />
              )}
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

          {orderedIds.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                Items you mark as Planned appear here in the order you queue
                them. Drag a tile up or down to change its position.
              </p>
            </div>
          ) : searchedOrderedIds.length === 0 ? (
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
              <SortableContext items={searchedOrderedIds} strategy={rectSortingStrategy}>
                <div
                  className="grid gap-5 pb-6"
                  style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}
                >
                  {searchedOrderedIds.map((id) => {
                    const lib = libIndex.get(id);
                    return (
                      <QueueCard
                        key={id}
                        id={id}
                        item={lib ?? null}
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
  id, item, onSelect,
}: {
  id: string;
  item: LibraryItem | null;
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

  // Defensive stub for items removed from library while still in queue.
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
    : {
        id, name: id, media_type: "other",
        poster: null, background: null, fanart: null, backdrop: null,
        logo: null, release_info: null, description: null,
        imdb_rating: null, genres: [],
      };

  const hover = useHoverCardActivation(meta);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...hover}
      className="group relative flex flex-col gap-2 card-contain"
      data-meta-card={`${meta.media_type}:${meta.id}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        onClick={() => { closeHoverNow(); onSelect?.(meta); }}
        onContextMenu={(e) => {
          e.preventDefault();
          window.dispatchEvent(new CustomEvent("aura:card-context", {
            detail: { meta, x: e.clientX, y: e.clientY, source: "queue" },
          }));
        }}
        className="flex flex-col gap-2 text-left
                   focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60 rounded-xl
                   cursor-grab active:cursor-grabbing"
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
