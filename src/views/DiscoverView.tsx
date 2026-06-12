// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview } from "../types";
import type { CatalogInfo } from "../CatalogPicker";
import ImageLoader from "../ImageLoader";
import ErrorBoundary from "../ErrorBoundary";
import WatchedBadge from "../WatchedBadge";
import { FilterMenu, applyFilters, DEFAULT_FILTERS, type FilterState } from "../FilterBar";
import { useHoverCardActivation } from "../useHoverCardActivation";
import { closeHoverNow } from "../catalogHoverStore";
import { useRowWindow } from "../useRowWindow";

// ---------------------------------------------------------------------------
// DiscoverView — browse any addon's catalogs, including ones the addon has
// flagged "enabled but hidden from home" (the AIOMetadata convention plus
// every Stremio Discover-only catalog: required-without-default extras).
//
// Two pill dropdowns (Addon → Catalog) drive a Library-style poster grid.
// Selecting a catalog fans out a single fetch_catalog call for the maximum
// list the addon will produce. Filter & sort sit in the same FilterBar
// sidebar that CatalogPageView uses, so any tweak there flows through here.
// ---------------------------------------------------------------------------

interface AddonManifest {
  name: string;
  catalogs: CatalogInfo[];
  has_search: boolean;
}

/** Composite key for a catalog: the bare `id` is NOT unique (Cinemeta
 *  exposes "top" / "year" / "imdbRating" for both movies and series),
 *  so combining `media_type` + `id` gives the disambiguator React needs
 *  for stable reconciliation in the dropdown options list. */
function catalogKey(c: { media_type: string; id: string }): string {
  return `${c.media_type}:${c.id}`;
}

interface Props {
  addons: AddonEntry[];
  onSelectMeta?: (meta: MetaPreview) => void;
}

export default function DiscoverView(props: Props) {
  return (
    <ErrorBoundary scope="Discover">
      <DiscoverBody {...props} />
    </ErrorBoundary>
  );
}

function DiscoverBody({ addons, onSelectMeta }: Props) {
  // Only addons whose `resources` advertise `catalog` belong in the picker.
  // Stream-only addons (Torrentio etc.) have no catalogs to discover.
  const catalogAddons = useMemo(
    () => addons.filter((a) => (a.resources ?? []).includes("catalog")),
    [addons],
  );

  const [selectedAddonUrl, setSelectedAddonUrl] = useState<string | null>(
    catalogAddons[0]?.url ?? null,
  );
  const [manifest, setManifest] = useState<AddonManifest | null>(null);
  const [manifestErr, setManifestErr] = useState<string | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(null);
  const [items, setItems] = useState<MetaPreview[] | null>(null);
  const [itemsErr, setItemsErr] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);

  // Re-pick the first available addon if the previous selection got
  // uninstalled, or if the user signs out and the catalog list shrinks.
  useEffect(() => {
    if (!selectedAddonUrl) {
      setSelectedAddonUrl(catalogAddons[0]?.url ?? null);
      return;
    }
    if (!catalogAddons.some((a) => a.url === selectedAddonUrl)) {
      setSelectedAddonUrl(catalogAddons[0]?.url ?? null);
    }
  }, [catalogAddons, selectedAddonUrl]);

  // Fetch the manifest whenever the addon changes. Cached on the Rust
  // side (5 min TTL via stremio.rs::MANIFEST_CACHE) so flipping back
  // between two addons within the cache window never re-hits the wire.
  useEffect(() => {
    if (!selectedAddonUrl) {
      setManifest(null);
      setManifestErr(null);
      return;
    }
    let cancelled = false;
    setManifest(null);
    setManifestErr(null);
    invoke<AddonManifest>("get_addon_manifest", { addonUrl: selectedAddonUrl })
      .then((m) => {
        if (cancelled) return;
        setManifest(m);
        // Auto-pick the first browseable catalog (excluding the
        // is_search_only family — there's no point loading a row that
        // requires a query). Hidden-from-home catalogs ARE valid here,
        // which is the whole reason this view exists.
        const firstCatalog = m.catalogs.find((c) => !c.is_search_only);
        setSelectedCatalogId(firstCatalog ? catalogKey(firstCatalog) : null);
      })
      .catch((e) => {
        if (cancelled) return;
        setManifest(null);
        setManifestErr(String(e));
      });
    return () => { cancelled = true; };
  }, [selectedAddonUrl]);

  const selectedAddon = catalogAddons.find((a) => a.url === selectedAddonUrl) ?? null;
  // selectedCatalogId is `${media_type}:${id}` so two catalogs that
  // share the bare id (e.g. Cinemeta's "top" exposed for both movies
  // and series) round-trip distinctly through React's reconciler. Use
  // `catalogKey` to encode and decode at the lookup boundary.
  const selectedCatalog =
    manifest?.catalogs.find((c) => catalogKey(c) === selectedCatalogId) ?? null;

  // Fetch the catalog whenever a new (addon, catalog) pair settles.
  useEffect(() => {
    // Switching catalog/addon unmounts every card in the current grid.
    // Closing the hover panel here guarantees a stale anchor (left over
    // from a brief hover that armed the open just before the click)
    // can't survive into the new grid as a stuck panel in the corner.
    closeHoverNow();
    if (!selectedAddon || !selectedCatalog) {
      setItems(null);
      setItemsErr(null);
      return;
    }
    let cancelled = false;
    setItems(null);
    setItemsErr(null);
    setFilters(DEFAULT_FILTERS);
    // Use the paginated fetch with target=100 so the Discover view shows
    // every item the addon will produce, up to a sane cap. The previous
    // single-page fetch was returning whatever the addon's natural page
    // size was — 10 for AI Search, 14-47 for Cinemeta, etc. — which felt
    // half-empty even though the catalog had more behind it.
    invoke<MetaPreview[]>("fetch_catalog_paginated", {
      addonUrl:    selectedAddon.url,
      catalogType: selectedCatalog.media_type,
      catalogId:   selectedCatalog.id,
      target:      100,
    })
      .then((r) => { if (!cancelled) setItems(r); })
      .catch((e) => {
        if (cancelled) return;
        setItems([]);
        setItemsErr(String(e));
      });
    return () => { cancelled = true; };
  }, [selectedAddon, selectedCatalog]);

  const filtered = useMemo(() => {
    if (!items) return [];
    return applyFilters(items, filters);
  }, [items, filters]);

  // Row-virtualization: only mount viewport rows of the (up to 100-item) grid.
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridWrapperRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const win = useRowWindow(scrollRef, gridWrapperRef, gridRef, filtered.length, {
    gap: 20, minCardW: 180, estRowStride: 320,
  });
  const visible = filtered.slice(win.start, win.end);
  // Reset scroll when the visible set changes (new catalog / filter), or a deep
  // scroll position would leave the window pointing past the shorter new list.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [selectedAddonUrl, selectedCatalogId, filters]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-[1800px] mx-auto px-6 py-6 space-y-5">
          {/* Header */}
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="aura-row-title text-3xl font-semibold tracking-tight">
                Discover
              </h1>
              <p className="text-white/35 text-sm mt-1">
                Browse every catalog your addons expose, including the ones
                hidden from your home page.
              </p>
            </div>
            {items && items.length > 0 && (
              <FilterMenu items={items} state={filters} onChange={setFilters} />
            )}
          </div>

          {/* Pill dropdowns — addon then catalog. Catalog list updates as
              soon as the manifest resolves, so the selection chain feels
              continuous without a "loading…" placeholder for short waits. */}
          <div className="flex items-center gap-3 flex-wrap">
            <PillDropdown
              label="Addon"
              value={selectedAddon?.name ?? "No addons with catalogs"}
              disabled={catalogAddons.length === 0}
              options={catalogAddons.map((a) => ({
                id:    a.url,
                label: a.name,
                hint:  hostnameOf(a.url),
              }))}
              activeId={selectedAddonUrl}
              onPick={(id) => setSelectedAddonUrl(id)}
            />
            <PillDropdown
              label="Catalog"
              value={selectedCatalog?.name ?? (manifest ? "Pick a catalog" : "Loading…")}
              disabled={!manifest || manifest.catalogs.length === 0}
              options={(manifest?.catalogs ?? [])
                .filter((c) => !c.is_search_only)
                .map((c) => ({
                  // Composite key disambiguates same-id catalogs across
                  // media types (Cinemeta's "top" appears for both
                  // movies and series — bare-id keying made React warn
                  // about duplicate keys).
                  id:    catalogKey(c),
                  label: c.name,
                  hint:  c.media_type,
                  badge: c.is_hidden_from_home ? "hidden from home" : undefined,
                }))}
              activeId={selectedCatalogId}
              onPick={(id) => setSelectedCatalogId(id)}
            />
          </div>

          {manifestErr && (
            <div className="glass-panel rounded-2xl px-5 py-4 border border-red-400/25">
              <p className="text-red-300/85 text-xs font-mono break-all">
                Couldn't load addon manifest: {manifestErr}
              </p>
            </div>
          )}
          {itemsErr && (
            <div className="glass-panel rounded-2xl px-5 py-4 border border-red-400/25">
              <p className="text-red-300/85 text-xs font-mono break-all">
                Couldn't load catalog: {itemsErr}
              </p>
            </div>
          )}

          {/* Grid */}
          {!selectedAddon || !selectedCatalog ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                Pick an addon and a catalog to browse its full list.
              </p>
            </div>
          ) : items === null ? (
            <SkeletonGrid />
          ) : filtered.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                {items.length === 0
                  ? "No items returned by the addon for this catalog."
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
                  <DiscoverPosterCard
                    key={`${m.media_type}:${m.id}`}
                    meta={m}
                    onSelect={onSelectMeta}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// PillDropdown — the round-pill style from HomeView's source picker, scaled
// up slightly. Renders the active label, opens to a vertical option list
// on click, closes on outside click or Esc. The chevron flips on open.
// ---------------------------------------------------------------------------

interface PillOption {
  id: string;
  label: string;
  hint?: string;
  badge?: string;
}

function PillDropdown({
  label, value, disabled, options, activeId, onPick,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  options: PillOption[];
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        className={`flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-full
                    border transition-colors min-w-[180px]
                    ${disabled
                      ? "bg-white/3 border-white/8 text-white/30 cursor-not-allowed"
                      : open
                        ? "bg-white/12 border-white/25 text-white"
                        : "bg-white/5 border-white/12 hover:bg-white/10 text-white/85"
                    }`}
      >
        <span className="text-[10px] font-semibold tracking-[0.18em] uppercase text-white/40">
          {label}
        </span>
        <span className="text-[12.5px] font-medium truncate max-w-[260px]">{value}</span>
        <span className="ml-auto text-white/40 text-[10px] leading-none"
              style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform 150ms" }}>
          ▾
        </span>
      </button>

      {open && options.length > 0 && (
        <div
          role="listbox"
          className="absolute left-0 mt-1 w-[320px] max-h-[60vh] overflow-y-auto z-30
                     aura-glass-menu rounded-xl p-1.5"
        >
          {options.map((o) => {
            const active = o.id === activeId;
            return (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => { onPick(o.id); setOpen(false); }}
                className={`w-full text-left px-3 py-2 rounded-md flex items-center gap-2
                            transition-colors
                            ${active
                              ? "bg-ln-accent/15 text-ln-accent"
                              : "text-white/85 hover:text-white hover:bg-white/[0.16]"}`}
              >
                <span className="text-[13px] font-medium truncate flex-1 min-w-0">{o.label}</span>
                {o.badge && (
                  <span className="text-[9px] font-semibold tracking-wider uppercase
                                   px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-200/85
                                   border border-amber-300/30">
                    {o.badge}
                  </span>
                )}
                {o.hint && (
                  <span className="text-[10.5px] font-mono text-white/40 truncate max-w-[120px]">
                    {o.hint}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiscoverPosterCard — same poster shape LibraryView uses, minus the in-
// library quick-remove affordance. Click selects the meta and routes to
// DetailView.
// ---------------------------------------------------------------------------

const DiscoverPosterCard = memo(function DiscoverPosterCard({
  meta, onSelect,
}: {
  meta: MetaPreview;
  onSelect?: (meta: MetaPreview) => void;
}) {
  const handleClick = useCallback(() => { closeHoverNow(); onSelect?.(meta); }, [meta, onSelect]);
  const hover = useHoverCardActivation(meta);

  return (
    <button
      type="button"
      onClick={handleClick}
      // Same right-click → context-menu plumbing every other catalog
      // surface uses (Home / Library / Calendar / Search / Catalog
      // page). The `data-meta-card` attribute is used by the global
      // capture-phase contextmenu listener installed in main.tsx for
      // diagnostic logging; the dispatch is what actually opens the
      // menu via App.tsx's card-context handler.
      onContextMenu={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("aura:card-context", {
          detail: { meta, x: e.clientX, y: e.clientY },
        }));
      }}
      {...hover}
      data-meta-card={`${meta.media_type}:${meta.id}`}
      className="aura-poster-card group relative block w-full text-left rounded-xl
                 transition-transform"
    >
      <div className="relative rounded-xl overflow-hidden bg-white/4"
           style={{ aspectRatio: "2 / 3" }}>
        {meta.poster ? (
          <ImageLoader
            src={meta.poster}
            alt={meta.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/30 text-xs">
            No poster
          </div>
        )}
        <WatchedBadge metaId={meta.id} mediaType={meta.media_type}
          className="absolute top-1.5 left-1.5" />
      </div>
      {/* Fixed-height label block so every card is the SAME total height —
          the windowing hook derives row stride from one measured card. */}
      <div className="px-0.5 h-14 overflow-hidden mt-2">
        <p className="text-white/85 text-[13px] mx-1 line-clamp-2 leading-snug">
          {meta.name}
        </p>
        {meta.release_info && (
          <p className="text-white/40 text-[11px] font-mono mx-1">{meta.release_info}</p>
        )}
      </div>
    </button>
  );
});

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
