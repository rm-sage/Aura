// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState, memo } from "react";
import type { MetaPreview } from "./types";

// ---------------------------------------------------------------------------
// FilterBar / FilterMenu — client-side filter & sort over an in-memory
// MetaPreview list.
//
// All filtering happens in pure JS over an already-fetched array. Rendering
// 50+ items through these predicates is sub-millisecond; we never re-fetch
// from the addon when filters change.
//
// State shape is owned by the parent so the filtered output can be passed
// down to whatever renderer consumes it (Discovery rows, search grid, …).
//
// FilterMenu is the single shell (FilterControls / useFilterModel do the
// work): a header dropdown used by every browseable surface — Library,
// Queue, Discover, Search, the view-all catalog page, and the
// CatalogOverlay popup. It expands on hover, pins on click, and renders
// ABOVE the grid (absolute / z-50) rather than beside it.
//
// The rating filter + "Rating" sort were intentionally removed: with RPDB
// the posters carry several rating sources and the meta panel shows several
// more, so a single "minimum rating" was ambiguous about which number it
// referred to.
// ---------------------------------------------------------------------------

export type SortMode = "default" | "year" | "name";

export interface FilterState {
  yearMin: number;
  yearMax: number;
  /** Selected genre names — match is OR (any selected must intersect item.genres). */
  genres: string[];
  sort: SortMode;
  /** Currently-airing-only narrow. Meta/signal-aware, so applyFilters (which
   *  only sees MetaPreview) can't evaluate it — the consuming view applies the
   *  shared `isAiring` predicate to its library items when this is set. */
  airingOnly?: boolean;
}

// The slider's range for a list with no years at all.
const YEAR_FALLBACK_MIN = 1900;
const YEAR_FALLBACK_MAX = new Date().getFullYear() + 1;

// Unbounded, so an untouched year filter never hides a title (an announced 2028
// film, a pre-1900 one). A thumb dragged back to its edge returns to unbounded.
export const DEFAULT_FILTERS: FilterState = {
  yearMin: -Infinity,
  yearMax: Infinity,
  genres:  [],
  sort:    "default",
  airingOnly: false,
};

// ---------------------------------------------------------------------------
// Pure helpers — exported so callers can use them without mounting the bar
// ---------------------------------------------------------------------------

/** Extract a 4-digit year from a `release_info` string. Handles plain years
 *  ("2023") and ranges ("2020-2024" / "2020-"). Returns null when ambiguous. */
export function parseYear(info: string | null): number | null {
  if (!info) return null;
  const m = /\b(\d{4})\b/.exec(info);
  if (!m) return null;
  const y = parseInt(m[1], 10);
  return y >= 1800 && y <= 2200 ? y : null;
}

/** The year / genre gate of applyFilters for ONE item. Exported so a view
 *  that runs its own single-pass pipeline (Library's faceted type counts)
 *  applies exactly the predicate the grid would, rather than a copy of it. */
export function matchesFilterState(
  it: Pick<MetaPreview, "release_info" | "genres">,
  f: FilterState,
): boolean {
  // Year
  const y = parseYear(it.release_info);
  if (y !== null && (y < f.yearMin || y > f.yearMax)) return false;

  // Genres (OR match)
  if (f.genres.length > 0) {
    const hits = it.genres ?? [];
    if (!hits.some((g) => f.genres.includes(g))) return false;
  }

  return true;
}

export function applyFilters(items: MetaPreview[], f: FilterState): MetaPreview[] {
  const filtered = items.filter((it) => matchesFilterState(it, f));

  switch (f.sort) {
    case "year":
      return [...filtered].sort((a, b) =>
        (parseYear(b.release_info) ?? 0) - (parseYear(a.release_info) ?? 0)
      );
    case "name":
      return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    default:
      return filtered;
  }
}

/** Distinct genre names found across the input list, sorted alpha. */
export function collectGenres(items: MetaPreview[]): string[] {
  const set = new Set<string>();
  for (const it of items) {
    for (const g of it.genres ?? []) set.add(g);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Bar UI
// ---------------------------------------------------------------------------

/** A surface-specific Sort By choice. When a caller passes `sortOptions`
 *  these REPLACE the generic Default / Year / Name buttons and are driven
 *  by `sortValue` / `onSortChange`, independent of FilterState.sort — the
 *  caller applies the ordering itself (Library sorts by ctime / mtime,
 *  which a MetaPreview can't express). */
export interface SortOption {
  value: string;
  label: string;
}

/** A surface-specific status filter choice (Library only for now). Shares the
 *  SortOption shape. When a caller passes `statusOptions` a "Status" section
 *  renders at the top of the panel, driven by `statusValue` / `onStatusChange`
 *  - the caller applies the actual filtering itself (status is derived from
 *  library / manual-watched state a MetaPreview can't express). */
export type StatusOption = SortOption;

interface Props {
  /** Full unfiltered list — used to derive available genres + bound the
      year range slider so we never offer "1900–2026" when items are recent. */
  items: MetaPreview[];
  state: FilterState;
  onChange: (next: FilterState) => void;
  /** Optional custom Sort By list. Omit for the generic Default / Year /
   *  Name sort bound to FilterState.sort (every surface except Library). */
  sortOptions?: SortOption[];
  sortValue?: string;
  onSortChange?: (value: string) => void;
  /** Optional status filter (Library). First entry is treated as the
   *  "no filter" default (value should be "all"). Omit on other surfaces. */
  statusOptions?: StatusOption[];
  statusValue?: string;
  onStatusChange?: (value: string) => void;
  /** Show the "Currently airing only" toggle. Only Library / Queue apply
   *  `airingOnly`, so it stays hidden elsewhere (Discover / Search / Catalog /
   *  View-all) where it would be an inert control. */
  showAiringToggle?: boolean;
  /** Reports the panel's open state (hover OR pinned) to the caller. Library
   *  uses it to slide its Options panel aside so both stay visible; every
   *  other surface omits it and nothing changes there. Pass a stable function
   *  (a state setter): it is called on every open change and with `false` on
   *  unmount, so a caller is never left believing a gone panel is open. */
  onOpenChange?: (open: boolean) => void;
}

const FilterIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M10 18h4v-2h-4v2zM3 6v2h18V6H3zm3 7h12v-2H6v2z" />
  </svg>
);

const ChevronIcon = ({ open }: { open: boolean }) => (
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
    style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 150ms" }}
  >
    <path d="M7 10l5 5 5-5z" />
  </svg>
);

/** Derives genres + year bounds from the list and bundles the mutation
 *  helpers so both shells (sidebar bar, header menu) stay in lockstep. */
function useFilterModel({
  items, state, onChange,
  sortOptions, sortValue, onSortChange,
  statusOptions, statusValue, onStatusChange,
  showAiringToggle = false,
}: Props) {
  // A selected genre stays listed after its last title leaves, or it would keep
  // filtering with no chip to untick.
  const genres = useMemo(
    () => [...new Set([...collectGenres(items), ...state.genres])].sort((a, b) => a.localeCompare(b)),
    [items, state.genres],
  );

  // Bounds for the year slider — clamp to actual data when present
  const yearBounds = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const it of items) {
      const y = parseYear(it.release_info);
      if (y === null) continue;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    if (min > max) { min = YEAR_FALLBACK_MIN; max = YEAR_FALLBACK_MAX; }
    return { min, max };
  }, [items]);

  const set = (patch: Partial<FilterState>) => onChange({ ...state, ...patch });

  const toggleGenre = (g: string) => {
    const exists = state.genres.includes(g);
    set({ genres: exists ? state.genres.filter((x) => x !== g) : [...state.genres, g] });
  };

  // Sort: a caller-supplied list (Library) overrides the generic axis
  // bound to FilterState.sort. Either way the model exposes one uniform
  // { choices, active, set } so FilterControls stays presentational.
  const GENERIC_SORT: SortOption[] = [
    { value: "default", label: "Default" },
    { value: "year",    label: "Year" },
    { value: "name",    label: "A → Z" },
  ];
  const sortChoices = sortOptions ?? GENERIC_SORT;
  const sortDefault = sortChoices[0]?.value ?? "default";
  const activeSort  = sortOptions ? (sortValue ?? sortDefault) : state.sort;
  const setSort = (value: string) => {
    if (sortOptions) onSortChange?.(value);
    else set({ sort: value as SortMode });
  };

  // Status filter (Library). The first option is the "no filter" default.
  const statusChoices = statusOptions ?? null;
  const statusDefault = statusChoices?.[0]?.value ?? "all";
  const activeStatus  = statusValue ?? statusDefault;
  const setStatus = (value: string) => onStatusChange?.(value);

  const reset = () => {
    onChange(DEFAULT_FILTERS);
    if (sortOptions) onSortChange?.(sortDefault);
    if (statusChoices) onStatusChange?.(statusDefault);
  };

  const isDirty =
    // Any stored bound, not only one that narrows the current data: bounds
    // move as titles come and go, and a stored bound still hides what has no
    // year to test (a Queue stub), so Reset has to stay available.
    Number.isFinite(state.yearMin) ||
    Number.isFinite(state.yearMax) ||
    state.genres.length > 0 ||
    activeSort !== sortDefault ||
    (showAiringToggle && (state.airingOnly ?? false)) ||
    (statusChoices ? activeStatus !== statusDefault : false);

  return {
    genres, yearBounds, set, toggleGenre, reset, isDirty,
    sortChoices, activeSort, setSort,
    statusChoices, activeStatus, setStatus,
    showAiringToggle,
  };
}

type FilterModel = ReturnType<typeof useFilterModel>;

// The controls (Sort / Year / Genres / Reset). Presentational — all
// derivation lives in useFilterModel so the sidebar and the popup menu
// can never drift apart. Both reach here, so removing rating + the
// single dual-thumb year track applies to every Filter & Sort surface.
function FilterControls({ state, model }: { state: FilterState; model: FilterModel }) {
  const {
    genres, yearBounds, set, toggleGenre, reset, isDirty,
    sortChoices, activeSort, setSort,
    statusChoices, activeStatus, setStatus,
    showAiringToggle,
  } = model;

  // The committed range can sit outside the data-derived bounds (the default
  // is unbounded), so the label, thumbs and fill all read it clamped.
  const clampYear = (y: number) => Math.max(yearBounds.min, Math.min(yearBounds.max, y));
  const shownMin = clampYear(state.yearMin);
  const shownMax = clampYear(state.yearMax);

  // Highlighted span between the two thumbs, as track percentages.
  const span = yearBounds.max - yearBounds.min;
  const pctMin = span <= 0 ? 0   : ((shownMin - yearBounds.min) / span) * 100;
  const pctMax = span <= 0 ? 100 : ((shownMax - yearBounds.min) / span) * 100;

  return (
    <div className="space-y-5">
      {/* Status (Library only - omitted elsewhere). Sits at the top since
          it's the coarsest cut of the list. */}
      {statusChoices && statusChoices.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
            Status
          </label>
          <div className="flex flex-wrap gap-1.5">
            {statusChoices.map(({ value, label }) => {
              const active = activeStatus === value;
              return (
                <button
                  key={value}
                  onClick={() => setStatus(value)}
                  className={`px-2.5 py-1 rounded-full text-[11px] transition-colors
                              ${active
                                ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/40"
                                : "bg-white/5 text-white/55 border border-white/10 hover:bg-white/10"
                              }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Airing-only toggle — meta/signal-aware, applied by the consuming view
          (Library / Queue), not by applyFilters. Hidden on surfaces that don't
          honor it so it can't render as an inert control. */}
      {showAiringToggle && (
      <div className="space-y-1.5">
        <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
          Airing
        </label>
        <button
          type="button"
          role="switch"
          aria-checked={state.airingOnly ?? false}
          onClick={() => set({ airingOnly: !(state.airingOnly ?? false) })}
          className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg text-[11px] transition-colors
                      ${state.airingOnly
                        ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/40"
                        : "bg-white/5 text-white/55 border border-white/10 hover:bg-white/10"}`}
        >
          <span>Currently airing only</span>
          <span className={`relative w-8 h-4 rounded-full transition-colors ${state.airingOnly ? "bg-ln-accent/60" : "bg-white/15"}`}>
            <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${state.airingOnly ? "left-4" : "left-0.5"}`} />
          </span>
        </button>
      </div>
      )}

      {/* Sort */}
      <div className="space-y-1.5">
        <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
          Sort By
        </label>
        <div className={`grid gap-1 ${sortChoices.length === 4 ? "grid-cols-2" : "grid-cols-3"}`}>
          {sortChoices.map(({ value, label }) => {
            const active = activeSort === value;
            return (
              <button
                key={value}
                onClick={() => setSort(value)}
                className={`px-2 py-1.5 rounded-lg text-xs transition-colors
                            ${active
                              ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/35"
                              : "bg-white/5 text-white/55 border border-white/8 hover:bg-white/10"
                            }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Release year — one track, two thumbs (min / max) */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
            Release Year
          </label>
          <span className="text-white/55 text-xs font-mono tabular-nums">
            {shownMin}-{shownMax}
          </span>
        </div>
        <div
          className="aura-range-dual mt-2"
          style={{
            ["--range-min" as string]: `${pctMin}%`,
            ["--range-max" as string]: `${pctMax}%`,
          }}
        >
          <div className="aura-range-dual-track" />
          <div className="aura-range-dual-fill" />
          <input
            type="range"
            min={yearBounds.min}
            max={yearBounds.max}
            value={shownMin}
            // At the right edge both thumbs share a pixel and Latest cannot move
            // left, so Earliest must be the one on top to be grabbed.
            style={shownMin >= yearBounds.max ? { zIndex: 4 } : undefined}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              set({ yearMin: v <= yearBounds.min ? -Infinity : Math.min(v, shownMax) });
            }}
            aria-label="Earliest year"
          />
          <input
            type="range"
            min={yearBounds.min}
            max={yearBounds.max}
            value={shownMax}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              set({ yearMax: v >= yearBounds.max ? Infinity : Math.max(v, shownMin) });
            }}
            aria-label="Latest year"
          />
        </div>
      </div>

      {/* Genres */}
      {genres.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
            Genres
          </label>
          <div className="flex flex-wrap gap-1.5">
            {genres.map((g) => {
              const active = state.genres.includes(g);
              return (
                <button
                  key={g}
                  onClick={() => toggleGenre(g)}
                  className={`px-2.5 py-1 rounded-full text-[11px] transition-colors
                              ${active
                                ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/40"
                                : "bg-white/5 text-white/55 border border-white/10 hover:bg-white/10"
                              }`}
                >
                  {g}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Reset */}
      <button
        onClick={reset}
        disabled={!isDirty}
        className="w-full py-1.5 rounded-lg text-xs transition-all
                   bg-white/5 hover:bg-white/10 border border-white/10
                   text-white/55 hover:text-white/85
                   disabled:opacity-30 disabled:cursor-not-allowed"
      >
        Reset filters
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header dropdown shell — used by every browseable surface.
//
// • Lives in the header/title row, not beside the grid.
// • Expands on hover; the open panel is absolute + z-50 so it renders
//   OVER the poster grid and never pushes the header down or clips.
// • Clicking the trigger row pins it open (stays open when the mouse
//   leaves); clicking again unpins (reverts to hover).
// • Unmounting (e.g. closing the popup) resets pin/hover for free.
//
// pointerenter / pointerleave treat an element + its descendants as one
// region. The open panel is an absolutely-positioned DESCENDANT of the
// wrapper, and the visual gap above the card is transparent padding
// inside that same descendant — so travelling trigger → card never
// leaves the wrapper subtree and no grace timer is needed.
// ---------------------------------------------------------------------------

function FilterMenuInner(props: Props) {
  const model = useFilterModel(props);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const open = pinned || hovered;

  const { onOpenChange } = props;
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  // Separate unmount report through a ref, so a new callback identity does
  // not fire a spurious `false` between two `true`s.
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => () => onOpenChangeRef.current?.(false), []);

  return (
    <div
      className="relative"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((p) => !p)}
        aria-expanded={open}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs font-semibold tracking-[0.1em] uppercase transition-colors
                    ${pinned
                      ? "bg-ln-accent/25 border-ln-accent/35 text-ln-accent"
                      : "bg-white/5 border-white/8 text-white/75 hover:bg-white/10"
                    }`}
      >
        <FilterIcon />
        Filter &amp; Sort
        {model.isDirty && (
          <span className="w-1.5 h-1.5 rounded-full bg-ln-accent" aria-label="active" />
        )}
        <span className="text-white/40 ml-0.5">
          <ChevronIcon open={open} />
        </span>
      </button>

      {open && (
        // Outer wrapper is flush under the trigger (top-full, no offset);
        // the visible gap is transparent pt-2 so the hover region stays
        // continuous. right-0 anchors it under the pill so the card can't
        // overflow the popup's right edge. z-50 floats it over the grid.
        <div className="absolute right-0 top-full z-50 pt-2">
          <div
            className="w-72 aura-glass-menu rounded-2xl p-4 max-h-[70vh] overflow-y-auto shadow-2xl"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
          >
            <FilterControls state={props.state} model={model} />
          </div>
        </div>
      )}
    </div>
  );
}

export const FilterMenu = memo(FilterMenuInner);
