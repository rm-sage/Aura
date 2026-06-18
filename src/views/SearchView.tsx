// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, SearchGroup } from "../types";
import { DiscoveryRow } from "../CinemaRows";
import { withTypeSuffix } from "../aiometadata";
import ErrorBoundary from "../ErrorBoundary";
import NoProvidersWarning from "../NoProvidersWarning";

// Module-level in-flight promise dedupe. React StrictMode (and any
// other transient remount) was double-invoking the search effect, which
// fired TWO identical addon round-trips for every query — visible in
// the rust:search logs as exact-duplicate GETs. Keying live promises by
// `<addon_url>::<trimmed-query>` lets both effect runs share the same
// promise: the SECOND invocation gets the in-flight one back, so only
// one HTTP request hits the addon network. Promises clear themselves on
// settle so a fresh search of the same term still re-fetches.
const inflightSearches = new Map<string, Promise<SearchGroup[]>>();

function runDedupedAddonSearch(addon: AddonEntry, query: string): Promise<SearchGroup[]> {
  const key = `${addon.url}::${query}`;
  const existing = inflightSearches.get(key);
  if (existing) return existing;
  const p = invoke<SearchGroup[]>("search_addon_grouped", { addon, query })
    .finally(() => {
      if (inflightSearches.get(key) === p) {
        inflightSearches.delete(key);
      }
    });
  inflightSearches.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// SearchView — Stremio-style per-addon-catalog grouped search.
//
// Fans out one `search_addon_grouped` call per search-enabled addon in
// parallel. Each addon's rows arrive independently and populate the
// view as they land — the slowest addon no longer holds back the
// fastest. While an addon is still searching, its installed-order
// position is reserved by a `pending` placeholder so groups never
// reorder mid-search.
// ---------------------------------------------------------------------------

interface Props {
  addons: AddonEntry[];
  query: string;
  onSelectMeta?: (meta: MetaPreview) => void;
}

export default function SearchView(props: Props) {
  return (
    <ErrorBoundary scope="Search">
      <SearchViewBody {...props} />
    </ErrorBoundary>
  );
}

/** Tracks one search-capable addon's contribution to the result set.
 *  `state` advances pending → settled (either with groups or with an
 *  empty array on error / no matches). The `addon` field carries the
 *  installed-order anchor so the rendered list preserves manifest
 *  order regardless of arrival order. */
interface AddonSearchSlot {
  addon:  AddonEntry;
  state:  "pending" | "settled";
  groups: SearchGroup[];
}

function SearchViewBody({ addons, query, onSelectMeta }: Props) {
  const [slots, setSlots] = useState<AddonSearchSlot[] | null>(null);
  const lastQueryRef = useRef<string>("");

  useEffect(() => {
    const trimmed = query.trim();
    lastQueryRef.current = trimmed;
    if (!trimmed) { setSlots(null); return; }
    const searchAddons = addons.filter((a) => a.has_search);
    if (searchAddons.length === 0) { setSlots([]); return; }

    let cancelled = false;
    // Seed every addon as pending so the user sees the row count
    // immediately — preserves installed-addon order regardless of
    // which addon finishes first.
    setSlots(searchAddons.map((a) => ({ addon: a, state: "pending", groups: [] })));

    // Fan out — one call per addon. Each settles independently.
    // We update only the slot for the addon that just resolved,
    // leaving every other slot untouched (key by addon.url so
    // identity is stable across re-renders).
    searchAddons.forEach((addon) => {
      runDedupedAddonSearch(addon, trimmed)
        .then((groups) => {
          if (cancelled || lastQueryRef.current !== trimmed) return;
          setSlots((prev) => {
            if (!prev) return prev;
            const next = prev.map((s) =>
              s.addon.url === addon.url
                ? { ...s, state: "settled" as const, groups }
                : s,
            );
            return next;
          });
        })
        .catch(() => {
          if (cancelled || lastQueryRef.current !== trimmed) return;
          setSlots((prev) => {
            if (!prev) return prev;
            return prev.map((s) =>
              s.addon.url === addon.url
                ? { ...s, state: "settled" as const, groups: [] }
                : s,
            );
          });
        });
    });

    return () => { cancelled = true; };
  }, [addons, query]);

  // Derived view of the addon→groups map. Walks slots in installed
  // order so groups always render in the same per-addon position no
  // matter which addon finished first.
  const orderedGroups = useMemo<SearchGroup[]>(
    () => (slots ?? []).flatMap((s) => s.groups),
    [slots],
  );
  const totalItems = useMemo(
    () => orderedGroups.reduce((s, g) => s + g.items.length, 0),
    [orderedGroups],
  );
  const pendingCount = (slots ?? []).filter((s) => s.state === "pending").length;
  const settledCount = (slots ?? []).filter((s) => s.state === "settled").length;
  const totalAddons = (slots ?? []).length;
  const stillSearching = pendingCount > 0;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-[1800px] mx-auto px-2 py-4 space-y-2">
          {/* Header — query summary */}
          <div className="px-7 pb-2 flex items-baseline gap-3">
            <h1 className="aura-row-title text-2xl font-semibold tracking-tight">
              Search
            </h1>
            <p className="text-white/45 text-xs font-mono tracking-wider truncate">
              “{query}”
              {slots && totalAddons > 0 && (
                <span className="text-white/30 ml-2">
                  {stillSearching
                    ? `· ${settledCount}/${totalAddons} addon${totalAddons === 1 ? "" : "s"} searched`
                    : `· ${totalItems} result${totalItems === 1 ? "" : "s"} across ${orderedGroups.length} catalog${orderedGroups.length === 1 ? "" : "s"}`
                  }
                </span>
              )}
            </p>
          </div>

          {/* Top-of-list shimmer while at least one addon hasn't
              landed AND no groups have arrived yet. Once even one
              group has landed, the shimmer collapses — the user sees
              a partial result instead of an opaque skeleton. */}
          {stillSearching && orderedGroups.length === 0 && (
            <div className="px-6 space-y-3">
              <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/60 to-transparent animate-pulse" />
              <p className="text-white/40 text-xs px-1">
                Searching across {totalAddons} addon{totalAddons === 1 ? "" : "s"}…
              </p>
            </div>
          )}

          {/* No search providers active (the resolved set is empty — the
              user disabled all in Settings, or no search-capable addon is
              installed). Point them at Search Providers. */}
          {slots && slots.length === 0 && (
            <div className="px-6 pt-8">
              <NoProvidersWarning
                section="sec-search"
                message="No search providers are active, so nothing can be searched."
              />
            </div>
          )}

          {/* Empty state — providers searched but every one returned zero
              groups. Distinct from the no-providers case above. */}
          {slots && slots.length > 0 && !stillSearching && orderedGroups.length === 0 && (
            <div className="mx-6 my-6 glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                No results from any active search provider.
              </p>
            </div>
          )}

          {/* Results — one DiscoveryRow per (addon, catalog). Renders
              as soon as the matching addon's call resolves; pending
              addons leave a gap that fills in when they land. */}
          {orderedGroups.length > 0 && (
            <div className="pt-2 pb-10 space-y-8">
              {orderedGroups.map((g) => (
                <DiscoveryRow
                  key={`${g.addon_url}|${g.media_type}-${g.catalog_id}`}
                  title={withTypeSuffix(g.catalog_name, g.media_type)}
                  items={g.items}
                  loading={false}
                  onSelectMeta={onSelectMeta}
                  searchExpand={{
                    addonUrl:  g.addon_url,
                    mediaType: g.media_type,
                    catalogId: g.catalog_id,
                    query:     query.trim(),
                  }}
                />
              ))}
              {/* Trailing shimmer when at least one addon is still
                  pending — signals "more results may still arrive
                  below" instead of leaving the user wondering whether
                  the visible groups are everything. */}
              {stillSearching && (
                <div className="px-6">
                  <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/40 to-transparent animate-pulse" />
                  <p className="text-white/35 text-[11px] mt-2 text-center font-mono tracking-wider uppercase">
                    {pendingCount} addon{pendingCount === 1 ? "" : "s"} still searching…
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
