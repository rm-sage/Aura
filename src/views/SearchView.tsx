// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, SearchGroup } from "../types";
import { DiscoveryRow } from "../CinemaRows";
import { withTypeSuffix } from "../aiometadata";
import ErrorBoundary from "../ErrorBoundary";

// Module-level in-flight promise dedupe. React StrictMode (and any
// other transient remount) was double-invoking the search effect, which
// fired TWO identical addon round-trips for every query — visible in
// the rust:search logs as exact-duplicate GETs. Keying live promises by
// the trimmed query lets both effect runs share the same promise: the
// SECOND invocation gets the in-flight one back, so only one HTTP
// request hits the addon network. Promises clear themselves on
// settle so a fresh search of the same term still re-fetches.
const inflightSearches = new Map<string, Promise<SearchGroup[]>>();

function runDedupedSearch(addons: AddonEntry[], query: string): Promise<SearchGroup[]> {
  const existing = inflightSearches.get(query);
  if (existing) return existing;
  const p = invoke<SearchGroup[]>("global_search_grouped", { addons, query })
    .finally(() => {
      // Drop the entry only if it still references THIS promise — a
      // newer search of the same string would have replaced it, and
      // we don't want a still-in-flight one cleared.
      if (inflightSearches.get(query) === p) {
        inflightSearches.delete(query);
      }
    });
  inflightSearches.set(query, p);
  return p;
}

// ---------------------------------------------------------------------------
// SearchView — Stremio-style per-addon-catalog grouped search.
//
// Calls `global_search_grouped`, which returns one entry per (addon, catalog)
// in installed-addon order + manifest order. Each group renders as its own
// 10-column DiscoveryRow with a "View All" card that opens the dedicated
// catalog deep-view scoped to that search.
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

function SearchViewBody({ addons, query, onSelectMeta }: Props) {
  const [groups, setGroups]   = useState<SearchGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  const lastQueryRef = useRef<string>("");

  useEffect(() => {
    const trimmed = query.trim();
    lastQueryRef.current = trimmed;
    if (!trimmed) { setGroups(null); return; }
    let cancelled = false;
    setLoading(true);
    // Goes through the dedupe layer above so a doubled effect fires only
    // ONE network round-trip even though both effect bodies await the
    // result. The cancelled flag still gates state writes from the
    // pre-cleanup invocation so we don't end up with stale results.
    runDedupedSearch(addons, trimmed)
      .then((g) => { if (!cancelled && lastQueryRef.current === trimmed) setGroups(g); })
      .catch(() => { if (!cancelled && lastQueryRef.current === trimmed) setGroups([]); })
      .finally(() => { if (!cancelled && lastQueryRef.current === trimmed) setLoading(false); });
    return () => { cancelled = true; };
  }, [addons, query]);

  // Total result count across all groups (for header).
  const totalItems = useMemo(
    () => (groups ?? []).reduce((s, g) => s + g.items.length, 0),
    [groups],
  );

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
              {!loading && groups && (
                <span className="text-white/30 ml-2">
                  · {totalItems} result{totalItems === 1 ? "" : "s"} across {groups.length} catalog{groups.length === 1 ? "" : "s"}
                </span>
              )}
              {loading && <span className="text-white/30 ml-2">· searching…</span>}
            </p>
          </div>

          {loading && (groups === null || groups.length === 0) && (
            <div className="px-6">
              <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/60 to-transparent animate-pulse" />
            </div>
          )}

          {!loading && groups && groups.length === 0 && (
            <div className="mx-6 my-6 glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                No results from any installed search-capable addon.
              </p>
            </div>
          )}

          {/* Sections — DiscoveryRow per (addon, catalog), in native order */}
          {groups && groups.length > 0 && (
            <div className="pt-2 pb-10 space-y-8">
              {groups.map((g) => (
                <DiscoveryRow
                  key={`${g.addon_url}|${g.media_type}-${g.catalog_id}`}
                  title={withTypeSuffix(g.catalog_name, g.media_type)}
                  items={g.items}
                  loading={false}
                  onSelectMeta={onSelectMeta}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
