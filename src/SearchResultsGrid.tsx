// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useMemo, memo } from "react";
import type { MetaPreview } from "./CatalogGrid";
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "./FilterBar";
import ImageLoader from "./ImageLoader";

const PosterCard = memo(function PosterCard({
  meta, onSelect,
}: {
  meta: MetaPreview;
  onSelect?: (m: MetaPreview) => void;
}) {
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
      className="group flex flex-col gap-2 card-contain text-left
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
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
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
      </div>
      <div className="px-0.5">
        <p className="text-white/85 text-sm font-medium leading-tight line-clamp-2 text-center">{meta.name}</p>
        {meta.release_info && (
          <p className="text-white/40 text-xs mt-0.5 text-center">{meta.release_info}</p>
        )}
      </div>
    </button>
  );
});

interface Props {
  query: string;
  results: MetaPreview[];
  loading: boolean;
  onSelectMeta?: (m: MetaPreview) => void;
}

export default function SearchResultsGrid({ query, results, loading, onSelectMeta }: Props) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const filtered = useMemo(() => applyFilters(results, filters), [results, filters]);

  const headerLabel = loading
    ? `Searching for "${query}"…`
    : filtered.length === results.length
      ? `${results.length} result${results.length !== 1 ? "s" : ""} for "${query}"`
      : `${filtered.length} of ${results.length} for "${query}"`;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {loading && (
        <div className="h-px flex-shrink-0 bg-gradient-to-r from-transparent via-ln-accent to-transparent animate-pulse" />
      )}

      <div className="flex-shrink-0 px-5 pt-4 pb-2 flex items-center justify-between gap-4">
        <p className="text-white/40 text-xs">{headerLabel}</p>
        {results.length > 0 && (
          <FilterMenu items={results} state={filters} onChange={setFilters} />
        )}
      </div>

      {/* flex-1 + min-h-0 + overflow-y-auto = robust column scroll.
          Do NOT use h-full here: a % height vs a flex item sized only
          by its parent is unreliable in WebView2 — same bug class that
          broke the search View-all popup. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-5 pb-5"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}
      >
        {filtered.length > 0 ? (
          <div
            className="grid gap-5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
          >
            {filtered.map((meta) => (
              <PosterCard key={meta.id} meta={meta} onSelect={onSelectMeta} />
            ))}
          </div>
        ) : !loading ? (
          <div className="h-full flex items-center justify-center text-white/25 text-sm">
            {results.length === 0 ? "No results found." : "No results match the current filter."}
          </div>
        ) : null}
      </div>
    </div>
  );
}
