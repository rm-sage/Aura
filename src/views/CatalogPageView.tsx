// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MetaPreview } from "../types";
import ImageLoader from "../ImageLoader";
import ErrorBoundary from "../ErrorBoundary";
import { withTypeSuffix } from "../aiometadata";
import { useRowWindow } from "../useRowWindow";
import {
  FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState,
} from "../FilterBar";
import { PAGE_CONTENT_MAX_W } from "../pageLayout";

// ---------------------------------------------------------------------------
// CatalogPageView — the "/catalog/:id" deep view.
//
// Triggered by clicking "View All" on a DiscoveryRow. Fetches the full 100-
// item catalog (no slicing), renders a flexible grid, and exposes the same
// FilterBar that Home uses. Esc / Back returns to the previous view.
// ---------------------------------------------------------------------------

const ArrowBackIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z" />
  </svg>
);

export interface CatalogTarget {
  addonUrl:    string;
  addonName:   string;
  mediaType:   string;
  catalogId:   string;
  catalogName: string;
}

interface Props {
  target: CatalogTarget;
  onBack: () => void;
  onSelectMeta?: (meta: MetaPreview) => void;
}

export default function CatalogPageView(props: Props) {
  return (
    <ErrorBoundary scope="Catalog">
      <CatalogPageBody {...props} />
    </ErrorBoundary>
  );
}

function CatalogPageBody({ target, onBack, onSelectMeta }: Props) {
  const [items, setItems]   = useState<MetaPreview[] | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [error, setError]    = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    invoke<MetaPreview[]>("fetch_catalog", {
      addonUrl:    target.addonUrl,
      catalogType: target.mediaType,
      catalogId:   target.catalogId,
    })
      .then((r) => { if (!cancelled) setItems(r); })
      .catch((e) => { if (!cancelled) { setItems([]); setError(String(e)); } });
    return () => { cancelled = true; };
  }, [target.addonUrl, target.mediaType, target.catalogId]);

  // Esc returns to home
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onBack(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const filtered = useMemo(() => {
    if (!items) return [];
    return applyFilters(items, filters);
  }, [items, filters]);

  const title = withTypeSuffix(target.catalogName, target.mediaType);

  // Row-virtualization: only mount viewport rows of the (up to 100-item) grid.
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridWrapperRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const win = useRowWindow(scrollRef, gridWrapperRef, gridRef, filtered.length, {
    gap: 20, minCardW: 180, estRowStride: 320,
  });
  const visible = filtered.slice(win.start, win.end);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [target.catalogId, target.addonUrl, filters]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="mx-auto px-6 py-6 space-y-5" style={{ maxWidth: PAGE_CONTENT_MAX_W }}>
          {/* Header */}
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <button
                onClick={onBack}
                aria-label="Back"
                className="nav-tap flex items-center gap-2 px-3 h-9 rounded-full
                           bg-black/40 backdrop-blur-xl border border-white/10
                           text-white/85 hover:text-white text-xs font-medium tracking-wide"
              >
                <ArrowBackIcon /> Back
              </button>
              <div>
                <h1 className="aura-row-title text-3xl font-semibold tracking-tight">
                  {title}
                </h1>
                <p className="text-white/35 text-sm mt-1">
                  {target.addonName}
                  {items ? ` · ${items.length} items` : " · loading…"}
                </p>
              </div>
            </div>
            {items && items.length > 0 && (
              <FilterMenu items={items} state={filters} onChange={setFilters} />
            )}
          </div>

          {error && (
            <div className="glass-panel rounded-2xl px-5 py-4 border-red-400/25 border">
              <p className="text-red-300/85 text-xs font-mono break-all">{error}</p>
            </div>
          )}

          {/* Grid */}
          {items === null ? (
            <SkeletonGrid />
          ) : filtered.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                {items.length === 0
                  ? "No items returned by the addon."
                  : "No items match the current filter."}
              </p>
            </div>
          ) : (
            <div ref={gridWrapperRef} style={{ position: "relative", height: win.totalHeight }}>
              <div
                ref={gridRef}
                className="grid gap-5"
                style={{
                  position: "absolute",
                  top: win.offsetY,
                  left: 0,
                  right: 0,
                  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
                }}
              >
                {visible.map((m) => (
                  <CatalogPosterCard key={`${m.media_type}:${m.id}`} meta={m} onSelect={onSelectMeta} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-5 pb-6"
         style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
      {Array.from({ length: 24 }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div className="rounded-xl image-loader-skeleton" style={{ aspectRatio: "2 / 3" }} />
          <div className="h-3 mx-3 rounded image-loader-skeleton" />
        </div>
      ))}
    </div>
  );
}

function CatalogPosterCard({
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
            imgClassName="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        ) : null}
      </div>
      {/* Fixed-height label block so every card is the SAME total height —
          the windowing hook derives row stride from one measured card. The
          parent button's `gap-2` already spaces it from the poster. */}
      <div className="px-0.5 h-14 overflow-hidden">
        <p className="text-white/85 text-[13px] font-medium leading-tight line-clamp-2 text-center">
          {meta.name}
        </p>
        {meta.release_info && (
          <p className="text-white/40 text-xs mt-0.5 text-center font-mono">{meta.release_info}</p>
        )}
      </div>
    </button>
  );
}
