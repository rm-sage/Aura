import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, LibraryItem } from "../types";
import type { CatalogInfo } from "../CatalogPicker";
import type { UserSession } from "../LoginView";
import HeroCarousel from "../HeroCarousel";
import { ContinueWatchingRow, DiscoveryRow } from "../CinemaRows";
import SearchBar from "../SearchBar";
import SearchResultsGrid from "../SearchResultsGrid";
import { withTypeSuffix } from "../aiometadata";
import { loadAuraSettings, type AuraSettings } from "../auraSettings";

// ---------------------------------------------------------------------------
// Cinema Flow data shape
// ---------------------------------------------------------------------------

interface ManifestCache {
  name: string;
  catalogs: CatalogInfo[];
  has_search: boolean;
}

interface CatalogRow {
  /** addon URL the catalog belongs to (used for the row key + future click handlers). */
  addonUrl: string;
  /** addon display name — prefixed onto the row title to disambiguate sources. */
  addonName: string;
  catalog: CatalogInfo;
  items: MetaPreview[];
  loading: boolean;
}

interface SearchState {
  query: string;
  results: MetaPreview[];
  loading: boolean;
}

interface Props {
  addons: AddonEntry[];
  session: UserSession | null;
  library: LibraryItem[];
}

// ---------------------------------------------------------------------------
// Resolve which addons should fuel Home, in order:
//   1. Primary (defaultHomeAddonUrl) or first installed if unset
//   2. Any URL in additionalHomeAddonUrls that's still installed
// Duplicates filtered, preserving order.
// ---------------------------------------------------------------------------

function resolveHomeAddons(addons: AddonEntry[], settings: AuraSettings): AddonEntry[] {
  if (addons.length === 0) return [];
  const primary =
    (settings.defaultHomeAddonUrl &&
      addons.find((a) => a.url === settings.defaultHomeAddonUrl)) ||
    addons[0];

  const result: AddonEntry[] = [primary];
  for (const extra of settings.additionalHomeAddonUrls ?? []) {
    if (extra === primary.url) continue;
    const found = addons.find((a) => a.url === extra);
    if (found && !result.some((r) => r.url === found.url)) result.push(found);
  }
  return result;
}

// ---------------------------------------------------------------------------
// HomeView — Cinema Flow
// ---------------------------------------------------------------------------

export default function HomeView({ addons, library }: Props) {
  const [searchState, setSearchState] = useState<SearchState | null>(null);
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);
  /** Lets us re-derive the active source list when settings change in another tab. */
  const [settingsTick, setSettingsTick] = useState(0);

  // Listen for cross-component settings changes (storage events fire from
  // other windows; we also re-load when SettingsView mutates by tagging a
  // custom event in auraSettings).
  useEffect(() => {
    const onChange = () => setSettingsTick((t) => t + 1);
    window.addEventListener("aura:settings-changed", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener("aura:settings-changed", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // Fan out across the resolved source list. Each addon is fetched in
  // parallel; rows update as they trickle in.
  useEffect(() => {
    if (addons.length === 0) {
      setRows([]);
      setBootstrapped(true);
      return;
    }
    let cancelled = false;
    const sources = resolveHomeAddons(addons, loadAuraSettings());
    if (sources.length === 0) {
      setRows([]);
      setBootstrapped(true);
      return;
    }

    setRows([]); // reset for the new source list

    (async () => {
      // Manifests in parallel
      const manifests = await Promise.all(
        sources.map(async (a) => {
          try {
            const m = await invoke<ManifestCache>("get_addon_manifest", { addonUrl: a.url });
            return { addon: a, manifest: m };
          } catch {
            return { addon: a, manifest: null };
          }
        })
      );
      if (cancelled) return;

      // Build initial loading rows preserving source order
      const initial: CatalogRow[] = [];
      for (const { addon, manifest } of manifests) {
        if (!manifest) continue;
        for (const c of manifest.catalogs) {
          initial.push({
            addonUrl:  addon.url,
            addonName: manifest.name || addon.name,
            catalog:   c,
            items:     [],
            loading:   true,
          });
        }
      }
      setRows(initial);

      // Fetch each catalog; mutate just that row when it lands
      await Promise.all(
        initial.map(async (row, idx) => {
          try {
            const items = await invoke<MetaPreview[]>("fetch_catalog", {
              addonUrl:    row.addonUrl,
              catalogType: row.catalog.media_type,
              catalogId:   row.catalog.id,
            });
            if (cancelled) return;
            setRows((prev) => {
              const next = [...prev];
              if (next[idx]) next[idx] = { ...next[idx], items, loading: false };
              return next;
            });
          } catch {
            if (cancelled) return;
            setRows((prev) => {
              const next = [...prev];
              if (next[idx]) next[idx] = { ...next[idx], items: [], loading: false };
              return next;
            });
          }
        })
      );
      if (!cancelled) setBootstrapped(true);
    })();

    return () => { cancelled = true; };
  }, [addons, settingsTick]);

  // Source for the hero — first row's first ~5 items that have any landscape art
  const heroItems: MetaPreview[] = (() => {
    const first = rows.find((r) => r.items.length > 0);
    if (!first) return [];
    return first.items
      .filter((it) => it.background ?? it.fanart ?? it.backdrop ?? it.poster)
      .slice(0, 5);
  })();

  // Continue Watching = library items with playback progress, newest first
  const continueWatching: LibraryItem[] = library
    .filter((i) => {
      const off = typeof i.state?.timeOffset === "number" ? i.state.timeOffset : 0;
      return !i.removed && off > 0;
    })
    .sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""))
    .slice(0, 12);

  // Search handlers
  const handleSearchResults = (results: MetaPreview[], query: string) =>
    setSearchState((prev) => ({ query, results, loading: prev?.loading ?? false }));
  const handleSearching = (loading: boolean) =>
    setSearchState((prev) => (prev ? { ...prev, loading } : null));
  const handleSearchClear = () => setSearchState(null);

  // Group rows by source to label each source band
  const sourceCount = new Set(rows.map((r) => r.addonUrl)).size;
  const showSourceLabels = sourceCount > 1;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Search bar — pinned top */}
      <div className="flex-shrink-0 px-6 pt-4 pb-2">
        <SearchBar
          addons={addons}
          onResults={handleSearchResults}
          onSearching={handleSearching}
          onClear={handleSearchClear}
        />
      </div>

      {searchState ? (
        <div className="flex-1 min-h-0 glass-panel rounded-none">
          <SearchResultsGrid
            query={searchState.query}
            results={searchState.results}
            loading={searchState.loading}
          />
        </div>
      ) : (
        <div
          className="flex-1 min-h-0 overflow-y-auto"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          {/* Empty state when no addons */}
          {addons.length === 0 && bootstrapped && (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-white/35">
              <p className="text-sm">No addons installed yet.</p>
              <p className="text-xs text-white/25">Open the Addons tab to add one.</p>
            </div>
          )}

          {/* Hero carousel */}
          {heroItems.length > 0 && (
            <div className="px-6 pt-2 pb-4">
              <HeroCarousel items={heroItems} />
            </div>
          )}

          {/* Continue Watching — 16:9 row */}
          {continueWatching.length > 0 && (
            <div className="pt-2 pb-2">
              <ContinueWatchingRow items={continueWatching} />
            </div>
          )}

          {/* Discovery rows — labelled with the source name when >1 active */}
          {rows.length > 0 && (
            <div className="pt-2 pb-10 space-y-8">
              {rows.map((row, i) => {
                const prev = i > 0 ? rows[i - 1] : null;
                const isFirstFromSource = !prev || prev.addonUrl !== row.addonUrl;
                return (
                  <div key={`${row.addonUrl}|${row.catalog.media_type}-${row.catalog.id}`}>
                    {showSourceLabels && isFirstFromSource && (
                      <p className="px-7 pb-1 text-white/35 text-[10px] font-semibold tracking-[0.18em] uppercase">
                        {row.addonName}
                      </p>
                    )}
                    <DiscoveryRow
                      title={withTypeSuffix(row.catalog.name, row.catalog.media_type)}
                      items={row.items}
                      loading={row.loading}
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* Manifests still loading */}
          {rows.length === 0 && addons.length > 0 && !bootstrapped && (
            <div className="px-6 pt-6">
              <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/60 to-transparent animate-pulse" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
