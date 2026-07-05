// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState, memo } from "react";
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
}

const YEAR_MIN_DEFAULT = 1900;
const YEAR_MAX_DEFAULT = new Date().getFullYear() + 1; // allow next year

export const DEFAULT_FILTERS: FilterState = {
  yearMin: YEAR_MIN_DEFAULT,
  yearMax: YEAR_MAX_DEFAULT,
  genres:  [],
  sort:    "default",
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

export function applyFilters(items: MetaPreview[], f: FilterState): MetaPreview[] {
  const filtered = items.filter((it) => {
    // Year
    const y = parseYear(it.release_info);
    if (y !== null && (y < f.yearMin || y > f.yearMax)) return false;

    // Genres (OR match)
    if (f.genres.length > 0) {
      const hits = it.genres ?? [];
      if (!hits.some((g) => f.genres.includes(g))) return false;
    }

    return true;
  });

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
}: Props) {
  const genres = useMemo(() => collectGenres(items), [items]);

  // Bounds for the year slider — clamp to actual data when present
  const yearBounds = useMemo(() => {
    let min = YEAR_MAX_DEFAULT;
    let max = YEAR_MIN_DEFAULT;
    for (const it of items) {
      const y = parseYear(it.release_info);
      if (y === null) continue;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    if (min > max) { min = YEAR_MIN_DEFAULT; max = YEAR_MAX_DEFAULT; }
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
    onChange({ ...DEFAULT_FILTERS, yearMin: yearBounds.min, yearMax: yearBounds.max });
    if (sortOptions) onSortChange?.(sortDefault);
    if (statusChoices) onStatusChange?.(statusDefault);
  };

  const isDirty =
    state.yearMin !== yearBounds.min ||
    state.yearMax !== yearBounds.max ||
    state.genres.length > 0 ||
    activeSort !== sortDefault ||
    (statusChoices ? activeStatus !== statusDefault : false);

  return {
    genres, yearBounds, set, toggleGenre, reset, isDirty,
    sortChoices, activeSort, setSort,
    statusChoices, activeStatus, setStatus,
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
  } = model;

  // Highlighted span between the two thumbs, as track percentages. The
  // committed state can sit outside the data-derived bounds (defaults
  // are 1900…next year) so clamp before painting the fill.
  const span = yearBounds.max - yearBounds.min;
  const clampPct = (n: number) => Math.max(0, Math.min(100, n));
  const pctMin = span <= 0 ? 0   : clampPct(((state.yearMin - yearBounds.min) / span) * 100);
  const pctMax = span <= 0 ? 100 : clampPct(((state.yearMax - yearBounds.min) / span) * 100);

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
            {state.yearMin}–{state.yearMax}
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
            value={state.yearMin}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              set({ yearMin: Math.min(v, state.yearMax) });
            }}
            aria-label="Earliest year"
          />
          <input
            type="range"
            min={yearBounds.min}
            max={yearBounds.max}
            value={state.yearMax}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              set({ yearMax: Math.max(v, state.yearMin) });
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
