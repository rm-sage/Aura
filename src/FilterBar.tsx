// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState, memo } from "react";
import type { MetaPreview } from "./types";

// ---------------------------------------------------------------------------
// FilterBar — client-side filter & sort over an in-memory MetaPreview list.
//
// All filtering happens in pure JS over an already-fetched array. Rendering
// 50+ items through these predicates is sub-millisecond; we never re-fetch
// from the addon when filters change.
//
// State shape is owned by the parent so the filtered output can be passed
// down to whatever renderer consumes it (Discovery rows, search grid, …).
// ---------------------------------------------------------------------------

export type SortMode = "default" | "rating" | "year" | "name";

export interface FilterState {
  yearMin: number;
  yearMax: number;
  /** Inclusive lower bound on imdb_rating, parsed as a float (0..10). */
  ratingMin: number;
  /** Selected genre names — match is OR (any selected must intersect item.genres). */
  genres: string[];
  sort: SortMode;
}

const YEAR_MIN_DEFAULT = 1900;
const YEAR_MAX_DEFAULT = new Date().getFullYear() + 1; // allow next year

export const DEFAULT_FILTERS: FilterState = {
  yearMin:   YEAR_MIN_DEFAULT,
  yearMax:   YEAR_MAX_DEFAULT,
  ratingMin: 0,
  genres:    [],
  sort:      "default",
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

    // Rating
    if (f.ratingMin > 0) {
      const r = it.imdb_rating ? parseFloat(it.imdb_rating) : NaN;
      if (Number.isFinite(r) && r < f.ratingMin) return false;
      // Items without a rating pass when ratingMin > 0 only if user opted to
      // include them — for now we exclude them to keep the filter strict.
      if (!Number.isFinite(r)) return false;
    }

    // Genres (OR match)
    if (f.genres.length > 0) {
      const hits = it.genres ?? [];
      if (!hits.some((g) => f.genres.includes(g))) return false;
    }

    return true;
  });

  switch (f.sort) {
    case "rating":
      return [...filtered].sort((a, b) =>
        (parseFloat(b.imdb_rating ?? "0") || 0) - (parseFloat(a.imdb_rating ?? "0") || 0)
      );
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

interface Props {
  /** Full unfiltered list — used to derive available genres + bound the
      year range slider so we never offer "1900–2026" when items are recent. */
  items: MetaPreview[];
  state: FilterState;
  onChange: (next: FilterState) => void;
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

function FilterBarInner({ items, state, onChange }: Props) {
  // Default to collapsed so the panel doesn't overlap nearby controls
  // (Library's Sort dropdown, Queue's drag affordance) until the user
  // explicitly opens it. The chevron + "Filter & Sort" label still
  // signals it's there.
  const [open, setOpen] = useState(false);
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

  const reset = () =>
    onChange({ ...DEFAULT_FILTERS, yearMin: yearBounds.min, yearMax: yearBounds.max });

  const isDirty =
    state.yearMin !== yearBounds.min ||
    state.yearMax !== yearBounds.max ||
    state.ratingMin > 0 ||
    state.genres.length > 0 ||
    state.sort !== "default";

  return (
    <aside
      className="flex-shrink-0 w-72 aura-glass-menu rounded-2xl p-4 self-start"
      style={{ position: "sticky", top: 0 }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 mb-3"
      >
        <span className="flex items-center gap-2 text-white/75 text-xs font-semibold tracking-[0.1em] uppercase">
          <FilterIcon />
          Filter & Sort
          {isDirty && (
            <span className="ml-1 w-1.5 h-1.5 rounded-full bg-ln-accent" aria-label="active" />
          )}
        </span>
        <span className="text-white/40">
          <ChevronIcon open={open} />
        </span>
      </button>

      {open && (
        <div className="space-y-5">
          {/* Sort */}
          <div className="space-y-1.5">
            <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
              Sort By
            </label>
            <div className="grid grid-cols-2 gap-1">
              {([
                ["default", "Default"],
                ["rating",  "Rating"],
                ["year",    "Year"],
                ["name",    "A → Z"],
              ] as const).map(([id, label]) => {
                const active = state.sort === id;
                return (
                  <button
                    key={id}
                    onClick={() => set({ sort: id })}
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

          {/* Year range */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
                Release Year
              </label>
              <span className="text-white/55 text-xs font-mono tabular-nums">
                {state.yearMin}–{state.yearMax}
              </span>
            </div>
            <div className="space-y-1.5 pt-1">
              <input
                type="range"
                min={yearBounds.min}
                max={yearBounds.max}
                value={state.yearMin}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  set({ yearMin: Math.min(v, state.yearMax) });
                }}
                className="aura-filter-slider w-full"
                style={{
                  ["--filter-progress" as string]: `${
                    yearBounds.max === yearBounds.min ? 0
                    : ((state.yearMin - yearBounds.min) / (yearBounds.max - yearBounds.min)) * 100
                  }%`,
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
                className="aura-filter-slider w-full"
                style={{
                  ["--filter-progress" as string]: `${
                    yearBounds.max === yearBounds.min ? 0
                    : ((state.yearMax - yearBounds.min) / (yearBounds.max - yearBounds.min)) * 100
                  }%`,
                }}
                aria-label="Latest year"
              />
            </div>
          </div>

          {/* Rating */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-white/40 text-[10px] font-semibold tracking-wider uppercase">
                Min Rating
              </label>
              <span className="text-white/55 text-xs font-mono tabular-nums">
                {state.ratingMin > 0 ? `${state.ratingMin.toFixed(1)} / 10` : "Any"}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={9.5}
              step={0.5}
              value={state.ratingMin}
              onChange={(e) => set({ ratingMin: parseFloat(e.target.value) })}
              className="aura-filter-slider w-full"
              style={{
                ["--filter-progress" as string]: `${(state.ratingMin / 9.5) * 100}%`,
              }}
              aria-label="Minimum rating"
            />
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
      )}
    </aside>
  );
}

export const FilterBar = memo(FilterBarInner);
