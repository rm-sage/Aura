// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, LibraryItem } from "../types";
import { getMetaDetail } from "../metaCache";
import type { CatalogInfo } from "../CatalogPicker";
import type { UserSession } from "../LoginView";
import HeroCarousel, { HERO_MAX_WIDTH } from "../HeroCarousel";
import { isManuallyWatched, onManualWatchedChange } from "../manualWatched";
import { isAutoBumped, onAutoBumpedChange } from "../autoBumped";
import { ContinueWatchingRow, DiscoveryRow, HOME_VISIBLE } from "../CinemaRows";

/** Per-row cap on the initial home payload. Matches the home grid's
 *  visible-cell count: at ultrawide we render 10 cells per row, at
 *  1080p the CSS hides cells 9-10 so 8 are visible — but we still
 *  fetch HOME_VISIBLE because the cells exist in the React tree (CSS
 *  hides them, doesn't remove them). View-all expansion is handled by
 *  DiscoveryRow's own pagination call. */
const HOME_VISIBLE_CAP = HOME_VISIBLE;

/** Module-level cache of resolved hero-logo URLs keyed by
 *  `${media_type}:${id}`. Survives HomeView remounts (which happen when
 *  the user navigates away to Library / Search / Settings and back) so
 *  the carousel renders with logos on first paint instead of flashing
 *  the bare h2 fallback while the meta-detail re-derivation runs. The
 *  underlying meta details are already cached in metaCache (24 h TTL,
 *  persisted to localStorage), but the per-item logo extraction was
 *  React-state-only and reset on unmount. */
const HERO_LOGO_MEMO = new Map<string, string | null>();

/** Catalog ids that an addon's manifest declares but its catalog
 *  handler doesn't recognise. AIOMetadata ships `calendar-videos` in
 *  its manifest yet logs `[Catalog] WARN Received request for unknown
 *  catalog prefix: calendar-videos` for every fetch, then caches an
 *  empty result. Skipping the request locally avoids the round-trip
 *  AND stops flooding the addon's logs. Set kept tight (single id) so
 *  legitimate catalog ids don't get filtered out by a heuristic match. */
const CATALOG_ID_DENYLIST = new Set<string>([
  "calendar-videos",
]);
import SearchBar from "../SearchBar";
import SearchView from "./SearchView";
import { findAIOMetadataAddon, withTypeSuffix } from "../aiometadata";
import { loadAuraSettings, type AuraSettings } from "../auraSettings";
import {
  resolveDefaultUrls,
  DEFAULT_HOME_ORDER,
  DEFAULT_SEARCH_ORDER,
  DEFAULT_SUGGESTION_ORDER,
} from "../addonDefaults";
// FilterBar moved to per-view sidebars (CatalogPageView, LibraryView,
// QueueView, DiscoverView) — Home now only emits the unfiltered row list.

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

interface Props {
  addons: AddonEntry[];
  session: UserSession | null;
  library: LibraryItem[];
  /** Click handler for any catalog poster — opens the DetailView in
   *  the default "ignore resume hint" mode (episodes-list-first for
   *  series, streams for movies). */
  onSelectMeta?: (meta: MetaPreview) => void;
  /** CW-specific click handler — preserves the resume hint so the
   *  user lands directly on the streams panel for their last-watched
   *  episode. CW tiles use this; everything else uses onSelectMeta. */
  onSelectFromCW?: (meta: MetaPreview) => void;
  /** Increment to clear the active search (Home re-clicked while on Home). */
  resetKey?: number;
  /** When set, immediately activates this search (from a deep-link). Cleared
   *  by calling onExternalQueryConsumed after the query is picked up. */
  externalQuery?: string | null;
  onExternalQueryConsumed?: () => void;
}

// ---------------------------------------------------------------------------
// Resolve which addons should fuel Home, in order:
//   1. Primary (defaultHomeAddonUrl) or first installed if unset
//   2. Any URL in additionalHomeAddonUrls that's still installed
// Duplicates filtered, preserving order.
// ---------------------------------------------------------------------------

function resolveHomeAddons(addons: AddonEntry[], settings: AuraSettings): AddonEntry[] {
  if (addons.length === 0) return [];

  // If the user has explicit settings, use them. Otherwise fall back to
  // the manifest-id default ordering (AIOMetadata → AISearch → Cinemeta).
  // This ensures fresh-install users with the same manifest.ids
  // installed get a meaningful primary + additional ordering rather
  // than just "whichever addon happened to install first".
  const hasExplicit =
    settings.defaultHomeAddonUrl != null
    || (settings.additionalHomeAddonUrls && settings.additionalHomeAddonUrls.length > 0);

  if (!hasExplicit) {
    const ranked = resolveDefaultUrls(addons, DEFAULT_HOME_ORDER);
    if (ranked.length > 0) {
      return ranked
        .map((u) => addons.find((a) => a.url === u))
        .filter((a): a is AddonEntry => !!a);
    }
    // No manifest-id matches at all — default to first installed.
    return [addons[0]];
  }

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

/** True when the addon advertises a search-capable catalog. The
 *  AddonEntry's `has_search` flag is precomputed at install/sync time
 *  by the manifest probe, so this is a flat boolean read rather than
 *  a deep walk. */
function isSearchProvider(addon: AddonEntry): boolean {
  return addon.has_search === true;
}

/** Filter the addon list down to those allowed for a given search
 *  surface. An explicit URL list (override) wins; null means
 *  "manifest-id defaults if a search-capable addon matches the
 *  ordering, otherwise all installed search-capable addons". The
 *  manifest-id pass lets fresh-install users get the user's preferred
 *  ordering automatically without having to re-pick in Settings. */
function resolveSearchAddons(
  addons: AddonEntry[],
  override: string[] | null,
  defaultOrder: readonly string[],
): AddonEntry[] {
  const searchable = addons.filter(isSearchProvider);
  if (override) {
    const byUrl = new Map(searchable.map((a) => [a.url, a]));
    const out: AddonEntry[] = [];
    for (const u of override) {
      const a = byUrl.get(u);
      if (a) out.push(a);
    }
    return out;
  }
  // No explicit override: try manifest-id defaults first.
  const ranked = resolveDefaultUrls(searchable, defaultOrder);
  if (ranked.length > 0) {
    return ranked
      .map((u) => searchable.find((a) => a.url === u))
      .filter((a): a is AddonEntry => !!a);
  }
  return searchable;
}

// ---------------------------------------------------------------------------
// HomeView — Cinema Flow
// ---------------------------------------------------------------------------

export default function HomeView({
  addons, library, onSelectMeta, onSelectFromCW, resetKey,
  externalQuery, onExternalQueryConsumed,
}: Props) {
  /** Active committed search query — set on Enter, cleared when input empties. */
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  // Force a re-render when the user marks/unmarks any item as watched
  // — the CW filter below reads through `isManuallyWatched(...)` and
  // we want the row to reflect the toggle without waiting for an
  // unrelated state change. The version counter is opaque; each change
  // bumps it and React reconciles. Same pattern for the auto-bumped
  // tracker so the CW row drops a series the moment its watched flag
  // gets recheck-flipped.
  const [manualVersion, setManualVersion] = useState(0);
  useEffect(
    () => onManualWatchedChange(() => setManualVersion((v) => v + 1)),
    [],
  );
  useEffect(
    () => onAutoBumpedChange(() => setManualVersion((v) => v + 1)),
    [],
  );
  void manualVersion; // used purely as a re-render trigger

  // Clear search whenever the parent signals a "Home" re-click.
  useEffect(() => { setActiveQuery(null); }, [resetKey]);

  // Consume an externally-pushed query (e.g. from a deep-link).
  useEffect(() => {
    if (!externalQuery) return;
    setActiveQuery(externalQuery);
    onExternalQueryConsumed?.();
  }, [externalQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Broadcast search activity so App.tsx can drive Discord RPC. Sent as a
  // custom event rather than a callback prop because the only consumer is the
  // top-level RPC hook — no need to thread state through every parent. The
  // cleanup intentionally does NOT clear: when the user navigates away from
  // Home, App's `activeView` change is what dictates the next RPC, not Home's
  // unmount; firing `null` here would race with that path.
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("aura:home-search-changed", {
        detail: { query: activeQuery ?? null },
      }),
    );
  }, [activeQuery]);
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);
  /** Fires `aura:home-ready` exactly once per HomeView mount, after the first
   *  `bootstrapped` transition, so App.tsx can lower the boot splash only when
   *  catalog data has actually settled. */
  const homeReadyFiredRef = useRef(false);
  /** Lets us re-derive the active source list when settings change in another tab. */
  const [settingsTick, setSettingsTick] = useState(0);
  // Per-row filtering moved off the home grid; see FilterBar comment above.

  // Signal App.tsx that the home view has fully settled so the boot splash
  // can fade.  Fires only on the FIRST bootstrapped transition per mount;
  // subsequent re-bootstraps (e.g. settings changes) are silent so navigating
  // away and back doesn't re-trigger the splash.
  useEffect(() => {
    if (!bootstrapped || homeReadyFiredRef.current) return;
    homeReadyFiredRef.current = true;
    // 800 ms gives the HeroCarousel its first stable frame AND the
    // poster images their first paint window (a 200 ms grace was too
    // short — splash faded WHILE images were still popping in,
    // visible as a flicker behind the cross-dissolve).
    const t = setTimeout(() => {
      window.dispatchEvent(new CustomEvent("aura:home-ready"));
    }, 800);
    return () => clearTimeout(t);
  }, [bootstrapped]);

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

      // Build initial loading rows preserving source order. Search-only
      // catalogs (Stremio extras: { name: "search", isRequired: true }) can't
      // be browsed without a query — skip them entirely on Home.
      // Also skip catalogs whose ids are in CATALOG_ID_DENYLIST below —
      // these are entries declared in the addon's manifest that the
      // addon's catalog handler doesn't actually serve. Fetching them
      // floods the addon's logs with `[Catalog] WARN Received request
      // for unknown catalog prefix` warnings while always returning
      // empty. AIOMetadata's `calendar-videos` is the canonical case;
      // extend this list as more addon manifest bugs are observed.
      const initial: CatalogRow[] = [];
      for (const { addon, manifest } of manifests) {
        if (!manifest) continue;
        for (const c of manifest.catalogs) {
          if (c.is_search_only) continue;
          // AIOMetadata's "enabled but hidden from home" toggle, plus
          // every Stremio Discover-only catalog convention, surfaces
          // as a required-without-default extra. The Rust manifest
          // parser computes is_hidden_from_home; we just skip those
          // rows here. The Discover tab still picks them up.
          if (c.is_hidden_from_home) continue;
          if (CATALOG_ID_DENYLIST.has(c.id)) continue;
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

      // Fetch each catalog with `limit = HOME_VISIBLE_CAP` so the
      // initial home payload only carries enough items for the visible
      // row cells. Wire bytes are unchanged (Stremio addons return one
      // page = up to 100 items regardless), but Rust's per-meta
      // sanitisation runs only on the kept slice — and the React tree
      // holds 10 items per row instead of 100. The remaining items
      // come in lazily via `fetch_catalog_paginated` when the user
      // opens View all on a specific row.
      await Promise.all(
        initial.map(async (row, idx) => {
          try {
            const items = await invoke<MetaPreview[]>("fetch_catalog", {
              addonUrl:    row.addonUrl,
              catalogType: row.catalog.media_type,
              catalogId:   row.catalog.id,
              limit:       HOME_VISIBLE_CAP,
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

  // Memoize search-addon resolution. resolveSearchAddons() builds a fresh
  // array every call, and these were previously inlined into the JSX
  // (passed straight to SearchBar / SearchView). Each parent render produced
  // a new array reference, which retriggered SearchView's
  // `useEffect(..., [addons, query])` → setState → re-render → loop. In
  // production this manifested as `global_search_grouped` firing in a tight
  // loop AFTER a stream was already playing (HomeView stayed mounted under
  // the player overlay), eventually crashing with React's
  // "Maximum update depth exceeded". Recompute only when the addon list
  // actually changes or the user mutates search-provider settings
  // (settingsTick).
  const submitSearchAddons = useMemo(
    () => resolveSearchAddons(
      addons,
      loadAuraSettings().searchAddonUrls,
      DEFAULT_SEARCH_ORDER,
    ),
    [addons, settingsTick],
  );
  const suggestionSearchAddons = useMemo(
    () => resolveSearchAddons(
      addons,
      loadAuraSettings().searchSuggestionAddonUrls,
      DEFAULT_SUGGESTION_ORDER,
    ),
    [addons, settingsTick],
  );

  // User-chosen hero catalog override. When set, the hero band fetches
  // its OWN copy of the catalog (independent of the home grid's row
  // pipeline) so the user can pin a Discover-only / hidden-from-home
  // catalog as the hero source without surfacing it in the grid below.
  // `null` means "fall back to first row" (the default since 0.6.x).
  const heroCatalogPref = useMemo(
    () => loadAuraSettings().heroCatalog,
    [settingsTick],
  );
  const [heroOverrideItems, setHeroOverrideItems] = useState<MetaPreview[] | null>(null);
  const [heroOverrideLabel, setHeroOverrideLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!heroCatalogPref) {
      setHeroOverrideItems(null);
      setHeroOverrideLabel(null);
      return;
    }
    let cancelled = false;
    invoke<MetaPreview[]>("fetch_catalog", {
      addonUrl:    heroCatalogPref.addonUrl,
      catalogType: heroCatalogPref.mediaType,
      catalogId:   heroCatalogPref.catalogId,
    })
      .then((items) => { if (!cancelled) setHeroOverrideItems(items); })
      .catch(() => { if (!cancelled) setHeroOverrideItems([]); });
    invoke<{ name: string; catalogs: { id: string; media_type: string; name: string }[] }>(
      "get_addon_manifest",
      { addonUrl: heroCatalogPref.addonUrl },
    )
      .then((m) => {
        if (cancelled) return;
        const cat = m.catalogs.find((c) =>
          c.id === heroCatalogPref.catalogId && c.media_type === heroCatalogPref.mediaType,
        );
        if (cat) setHeroOverrideLabel(withTypeSuffix(cat.name, cat.media_type));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [heroCatalogPref]);

  // Source for the hero — override catalog when configured, otherwise
  // the first browseable row's first ~5 art-bearing items.
  const heroItemsRaw: MetaPreview[] = useMemo(() => {
    const source = heroOverrideItems ?? rows.find((r) => r.items.length > 0)?.items ?? [];
    return source
      .filter((it) => it.background ?? it.fanart ?? it.backdrop ?? it.poster)
      .slice(0, 5);
  }, [heroOverrideItems, rows]);

  /** Display name of the catalog the hero is pulled from — surfaces
   *  as a subtle top-left chip on the hero card so the user knows
   *  which row contributed the current selection. Empty when there's
   *  no resolved source row. */
  const heroSourceLabel: string | null = useMemo(() => {
    if (heroOverrideLabel) return heroOverrideLabel;
    const first = rows.find((r) => r.items.length > 0);
    if (!first) return null;
    return withTypeSuffix(first.catalog.name, first.catalog.media_type);
  }, [heroOverrideLabel, rows]);

  // Catalog responses don't carry the `logo` field — only meta-detail does.
  // Without this, the hero falls back to plain `<h2>{name}</h2>` instead of
  // the stylized text-logo art for the title. Fetch detail per hero item
  // (capped at 5) and stash the resolved logo in a per-component cache.
  //
  // We route through `metaCache.getMetaDetail` rather than calling
  // `invoke("fetch_meta_detail")` directly — that gives us a 24 h
  // module-level cache (survives HomeView remounts) AND `dedupedInvoke`
  // dedupe for concurrent requests with the same key. Production logs
  // showed the OLD direct-invoke version firing 5 IDs × 8 times in
  // 700 ms because `heroLogoCache` was in the effect's deps and every
  // cache update re-ran the effect, re-firing every still-in-flight
  // fetch. Routing through metaCache short-circuits all of that — even
  // if our local effect somehow re-fires, the module cache returns the
  // already-resolved value with zero round-trips.
  // Hydrate the React-state mirror from the module-level cache so a
  // remount renders with logos on the very first paint instead of
  // waiting for the effect to refetch + setState. The state mirror
  // exists (rather than reading HERO_LOGO_MEMO directly in the
  // useMemo) because Maps don't trigger React re-renders on mutation;
  // we need a setState-driven dependency for the heroItems useMemo.
  const [heroLogoCache, setHeroLogoCache] = useState<Record<string, string | null>>(
    () => Object.fromEntries(HERO_LOGO_MEMO.entries()),
  );
  useEffect(() => {
    const metaAddon = findAIOMetadataAddon(addons);
    if (!metaAddon) return;
    let cancelled = false;
    const fetchOne = async (item: MetaPreview) => {
      const key = `${item.media_type}:${item.id}`;
      if (HERO_LOGO_MEMO.has(key)) return; // already resolved this session
      const d = await getMetaDetail(metaAddon, item.media_type, item.id);
      if (cancelled) return;
      const logo = d?.logo ?? null;
      HERO_LOGO_MEMO.set(key, logo);
      setHeroLogoCache((prev) => (key in prev ? prev : { ...prev, [key]: logo }));
    };
    for (const item of heroItemsRaw) {
      if (item.logo) continue; // already has one
      void fetchOne(item);
    }
    return () => { cancelled = true; };
  }, [heroItemsRaw, addons]);

  // Final hero items with cached logos merged in.
  const heroItems: MetaPreview[] = useMemo(
    () => heroItemsRaw.map((item) => {
      if (item.logo) return item;
      const key = `${item.media_type}:${item.id}`;
      const cached = heroLogoCache[key];
      return cached ? { ...item, logo: cached } : item;
    }),
    [heroItemsRaw, heroLogoCache],
  );

  // Filtered rows used to derive from the home FilterBar's state; that
  // bar moved to per-view sidebars, so the home grid now renders the
  // unfiltered `rows` list directly.

  // Continue Watching — match stremio-core's `is_in_continue_watching`
  // filter exactly: `time_offset > 0` is the ONLY required signal. The
  // earlier "also require duration > 0 && video_id set" rule was too
  // strict — movies without a populated video_id get filtered out, so
  // optimistically clearing one item visually wiped neighbours that
  // happened to have empty video_id while React re-rendered.
  //
  // The "new episode out" notifications stremio-core pushes have
  // `time_offset === 0`, so they fall out of this filter naturally.
  // Stremio also excludes `type === "other"` (custom non-meta items).
  const continueWatching: LibraryItem[] = library
    .filter((i) => {
      if (i.removed) return false;
      if ((i.media_type ?? "").toLowerCase() === "other") return false;
      // User-marked-watched items are excluded from CW per the
      // manualWatched contract (the user said "I've already seen
      // this, never want it in CW"). The mark is local + per-account.
      if (isManuallyWatched(i.id)) return false;
      // Series the recheck flow auto-bumped from "watched" to
      // "in-progress" because new aired episodes appeared — these
      // shouldn't suddenly re-enter CW just because the library
      // still has a stale state.timeOffset from the user's last
      // pre-watched-mark session. The flag clears as soon as the
      // user actually engages with the show again.
      if (isAutoBumped(i.id)) return false;
      const off = typeof i.state?.timeOffset === "number" ? i.state.timeOffset : 0;
      return off > 0;
    })
    .sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""))
    .slice(0, 12);

  // Search commit / clear handlers — feed the Stremio-style SearchView.
  const handleSubmitSearch = (q: string) => setActiveQuery(q);
  const handleClearSearch  = () => setActiveQuery(null);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Centered search bar. The filter & sort button used to live in
          this bar; it's now scoped to the surfaces where filtering a
          finite list actually makes sense — view-all catalog page,
          Library, Queue, Discover. The home grid is a curated mix of
          catalogs the user already chose to surface, so layering a
          global filter on top blurred the distinction between
          "browsing what an addon offers" and "narrowing my own list". */}
      <div className="flex-shrink-0 pt-4 pb-2 px-6 relative z-30">
        <div className="mx-auto relative w-full" style={{ maxWidth: HERO_MAX_WIDTH }}>
          <SearchBar
            addons={suggestionSearchAddons}
            committedQuery={activeQuery}
            onSubmit={handleSubmitSearch}
            onClear={handleClearSearch}
          />
        </div>
      </div>

      {activeQuery ? (
        <SearchView
          addons={submitSearchAddons}
          query={activeQuery}
          onSelectMeta={onSelectMeta}
        />
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
              <HeroCarousel
                items={heroItems}
                onSelect={onSelectMeta}
                sourceLabel={heroSourceLabel ?? undefined}
              />
            </div>
          )}

          {/* Continue Watching — 16:9 row */}
          {continueWatching.length > 0 && (
            <div className="pt-2 pb-2">
              <ContinueWatchingRow items={continueWatching} onSelectMeta={onSelectFromCW ?? onSelectMeta} addons={addons} />
            </div>
          )}

          {/* Discovery rows — preserve native Stremio manifest order. We
              deliberately don't prefix rows with the addon name; the catalog's
              own name is sufficient and the prefix added visual noise on
              multi-source setups. */}
          {rows.length > 0 && (
            <div className="pt-2 pb-10 space-y-8">
              {rows.map((row) => (
                <DiscoveryRow
                  key={`${row.addonUrl}|${row.catalog.media_type}-${row.catalog.id}`}
                  title={withTypeSuffix(row.catalog.name, row.catalog.media_type)}
                  items={row.items}
                  loading={row.loading}
                  onSelectMeta={onSelectMeta}
                  addonUrl={row.addonUrl}
                  catalogType={row.catalog.media_type}
                  catalogId={row.catalog.id}
                />
              ))}
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
