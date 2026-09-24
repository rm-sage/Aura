// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback,
  type ReactElement, type RefObject,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, LibraryItem } from "../types";
import { getMetaDetail } from "../metaCache";
import type { CatalogInfo } from "../CatalogPicker";
import type { UserSession } from "../LoginView";
import HeroCarousel, { HERO_MAX_WIDTH } from "../HeroCarousel";
import { isManuallyWatched, onManualWatchedChange } from "../manualWatched";
import { isAutoBumped, onAutoBumpedChange } from "../autoBumped";
import { ContinueWatchingRow, DiscoveryRow, HOME_VISIBLE } from "../CinemaRows";
import NoProvidersWarning from "../NoProvidersWarning";
import ErrorBoundary from "../ErrorBoundary";
import { useRowWindow } from "../useRowWindow";

/** Per-row cap on the initial home payload. Matches the home grid's
 *  visible-cell count: at ultrawide we render 10 cells per row, at
 *  1080p the CSS hides cells 9-10 so 8 are visible — but we still
 *  fetch HOME_VISIBLE because the cells exist in the React tree (CSS
 *  hides them, doesn't remove them). View-all expansion is handled by
 *  DiscoveryRow's own pagination call. */
const HOME_VISIBLE_CAP = HOME_VISIBLE;

/** Catalog requests Home keeps in flight at once. Home carries every
 *  catalog of every catalog addon, 30 to 80 rows and often 20 or more of
 *  them on one self-hosted addon, each with a 20 s timeout, so rows are
 *  fetched a few at a time in row order, window first, never all at once. */
const HOME_FETCH_CONCURRENCY = 4;

/** Rows past the end of the row window that are fetched ahead, so a row
 *  usually has its items by the time it scrolls into view. */
const HOME_FETCH_AHEAD = 2;

/** Rows mounted, and wanted by the fetch queue, before the row window has
 *  measured anything. About one 1080p viewport of catalog rows. */
const HOME_INITIAL_ROWS = 4;

/** Vertical gap between catalog rows in px (the `space-y-8` the rows used
 *  before windowing). The row window's stride arithmetic needs a number. */
const HOME_ROW_GAP = 32;

/** Row-stride fallback until the first row is measured: a 1080p row
 *  (header + poster + title block) plus the gap. */
const HOME_EST_ROW_STRIDE = 479;

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
import { loadAuraSettings, HOME_RELEVANT_SETTING_KEYS, SEARCH_RELEVANT_SETTING_KEYS, settingsChangeIncludes } from "../auraSettings";
import { electHomeAddons, electSearchAddons } from "../addonElection";
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

/** Where a row's catalog request stands. `pending` is both "queued" (the
 *  window has not come near it yet) and "in flight"; both draw the
 *  skeleton. `failed` is kept apart from an `ok` row with no items: an empty
 *  catalog hides its row as it always has, a failed one keeps its place and
 *  offers Retry instead of silently vanishing. */
type RowStatus = "pending" | "ok" | "failed";

interface CatalogRow {
  /** `${addonUrl}|${type}-${id}`: the React key, and what the fetch queue
   *  tracks a row by. */
  key: string;
  /** addon URL the catalog belongs to (used for the row key + future click handlers). */
  addonUrl: string;
  /** addon display name — prefixed onto the row title to disambiguate sources. */
  addonName: string;
  catalog: CatalogInfo;
  items: MetaPreview[];
  status: RowStatus;
  /** The build generation this row belongs to. The queue starts only rows
   *  of the current generation: the build effect bumps it one render before
   *  the new list lands, and a queue pass in between must not start the OLD
   *  list's rows under the new generation (their keys would be marked
   *  started, and the same keys in the new list then never fetched). */
  gen: number;
  /** The hero walk (see the fetch queue) requested this row outside the row
   *  window and it failed. That try was speculative, so the row went back to
   *  `pending` rather than to a Retry the user would have to click: the
   *  window fetches it once, as usual, when it gets near. The walk itself
   *  skips it, which is what keeps the walk to one pass over the list. */
  walked?: boolean;
  /** Set by Retry: this row's next request passes `force`, skipping Rust's
   *  per-catalog soft-fail cooldown, because the user asked for the
   *  network. Window-driven requests leave it off, so scrolling never
   *  re-pays a 20 s timeout on a catalog that just timed out. */
  retry?: boolean;
}

/** A half-open range of row indexes, `end` exclusive. */
interface RowRange {
  start: number;
  end: number;
}

const INITIAL_WANT: RowRange = { start: 0, end: HOME_INITIAL_ROWS };

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
// HomeView - Cinema Flow
//
// Which addons feed Home, and in what order, is electHomeAddons' call
// (addonElection.ts): every catalog addon in Addons-page order, or the
// Settings "Home Catalog Sources" override when one is set. Each elected
// addon contributes every home-eligible catalog in its manifest's order.
//
// An <ErrorBoundary> wraps the whole view, so a row that throws while
// rendering falls back to a small diagnostic card instead of a blank Home.
// ---------------------------------------------------------------------------

export default function HomeView(props: Props) {
  return (
    <ErrorBoundary scope="Home">
      <HomeViewBody {...props} />
    </ErrorBoundary>
  );
}

function HomeViewBody({
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
  /** Every home-eligible catalog of every elected source, in row order,
   *  including rows whose catalog came back empty. `shownRows` below is
   *  what renders. */
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [bootstrapped, setBootstrapped] = useState(false);
  /** The row window (the rows in or near the viewport), as indexes into
   *  `shownRows`. The fetch queue works through these (plus
   *  HOME_FETCH_AHEAD) first. A row pinned by its open View-all popup can
   *  be mounted outside the window; it is not part of this range. */
  const [want, setWant] = useState<RowRange>(INITIAL_WANT);
  /** Bumped whenever the row list is rebuilt, so a catalog answer that
   *  arrives for a superseded list is dropped instead of written into
   *  whichever row now sits at its key. */
  const fetchGenRef = useRef(0);
  /** Row keys requested in this generation and not failed: queued rows are
   *  never requested twice, and a row that scrolled away keeps its answer,
   *  so scrolling back never refetches. A failure leaves the set, so the
   *  row's Retry is the one way back into the queue (or, for a walked row,
   *  the window reaching it; see CatalogRow.walked). */
  const fetchStartedRef = useRef<Set<string>>(new Set());
  /** Requests of this generation still in flight. */
  const fetchInflightRef = useRef(0);
  /** Fires `aura:home-ready` exactly once per HomeView mount, after the first
   *  `bootstrapped` transition, so App.tsx can lower the boot splash only when
   *  catalog data has actually settled. */
  const homeReadyFiredRef = useRef(false);
  /** Lets us re-derive the active source list when settings change in another tab. */
  const [settingsTick, setSettingsTick] = useState(0);
  /** Bumped only by a Search Providers change; see the listener below. */
  const [searchTick, setSearchTick] = useState(0);
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

  // Listen for cross-component settings changes. Only home-relevant
  // setting keys (default-home-addon, additional-home-addons, hero
  // catalog override, stream addon list) bump settingsTick — flips
  // like subtitle styling, loudness normalization, reduce motion,
  // theme, etc. all dispatch `aura:settings-changed` too, and without
  // this filter every unrelated flip caused a full re-fetch of the
  // entire home grid (visible as the AIOMetadata "AI Recommendations"
  // catalog re-firing on subtitle-style saves and similar idle
  // events). Legacy emitters that don't carry detail.keys still
  // trigger via the settingsChangeIncludes default-to-true guard.
  // Search Providers bumps its own searchTick instead, so a cloud pull
  // that changes only the search list leaves the grid and hero alone.
  useEffect(() => {
    const onChange = (e: Event) => {
      if (e.type === "aura:settings-changed"
          && settingsChangeIncludes(e, SEARCH_RELEVANT_SETTING_KEYS)) {
        setSearchTick((t) => t + 1);
      }
      if (e.type === "aura:settings-changed"
          && !settingsChangeIncludes(e, HOME_RELEVANT_SETTING_KEYS)) {
        return;
      }
      setSettingsTick((t) => t + 1);
    };
    // Same path as a settings change, but triggered when an addon's
    // manifest is refreshed (post-configure auto-refresh, or the user
    // clicking the Refresh icon) so home rows reflect newly-enabled
    // catalogs without waiting for an unrelated setting flip.
    const onManifestRefresh = () => setSettingsTick((t) => t + 1);
    window.addEventListener("aura:settings-changed", onChange);
    window.addEventListener("storage", onChange);
    window.addEventListener("aura:addon-manifest-refreshed", onManifestRefresh);
    return () => {
      window.removeEventListener("aura:settings-changed", onChange);
      window.removeEventListener("storage", onChange);
      window.removeEventListener("aura:addon-manifest-refreshed", onManifestRefresh);
    };
  }, []);

  // `bootstrapped` flips as soon as the FIRST row resolves (or 1.5 s
  // elapses, whichever comes first). Earlier this awaited every catalog,
  // which let one slow addon (debrid mirror under load → 10 s reqwest
  // timeout) hold the splash for the full timeout. The 8 s safety valve in
  // App.tsx::aura:home-ready still catches the absolute worst case but is
  // no longer the primary gate. Setting it again is a no-op.
  const markBootstrapped = () => setBootstrapped(true);

  // Build the row list from the elected sources' manifests. Only the
  // manifests are fetched here (24 h cached on the Rust side, so in
  // parallel); the catalogs themselves go through the queue below.
  useEffect(() => {
    // A new list: drop whatever the previous one still has in flight.
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    fetchStartedRef.current = new Set();
    fetchInflightRef.current = 0;
    setWant(INITIAL_WANT);
    if (addons.length === 0) {
      setRows([]);
      setBootstrapped(true);
      return;
    }
    let cancelled = false;
    let bootstrapFallback: number | undefined;
    const sources = electHomeAddons(addons);
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
      // First occurrence wins: the same catalog declared twice in one
      // manifest (or one addon URL listed twice) would otherwise mint two
      // rows with one key.
      const seen = new Set<string>();
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
          const key = `${addon.url}|${c.media_type}-${c.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          initial.push({
            key,
            addonUrl:  addon.url,
            addonName: manifest.name || addon.name,
            catalog:   c,
            items:     [],
            status:    "pending",
            gen,
          });
        }
      }
      setRows(initial);
      if (initial.length === 0) {
        // No catalog rows at all: nothing will ever settle, so the
        // splash must not wait for one.
        setBootstrapped(true);
        return;
      }
      bootstrapFallback = window.setTimeout(markBootstrapped, 1500);
    })();

    return () => {
      cancelled = true;
      if (bootstrapFallback !== undefined) window.clearTimeout(bootstrapFallback);
    };
  }, [addons, settingsTick]);

  // User-chosen hero catalog override. When set, the hero band fetches
  // its OWN copy of the catalog (independent of the home grid's row
  // pipeline) so the user can pin a Discover-only / hidden-from-home
  // catalog as the hero source without surfacing it in the grid below.
  // `null` means "fall back to first row" (the default since 0.6.x).
  // Declared ahead of the fetch queue, which reads both: the default hero
  // is what makes it look past the row window.
  const heroCatalogPref = useMemo(
    () => loadAuraSettings().heroCatalog,
    [settingsTick],
  );
  // Hero entirely disabled by the user (the "Disable" picker item). When true
  // the banner is hidden AND none of its catalog / logo fetches run.
  const heroDisabled = useMemo(
    () => loadAuraSettings().heroDisabled,
    [settingsTick],
  );

  // The rows that render: an `ok` row whose catalog came back empty hides
  // itself, as it always has. A failed row stays, with its Retry.
  const shownRows = useMemo(
    () => rows.filter((r) => r.status !== "ok" || r.items.length > 0),
    [rows],
  );

  const handleWindowChange = useCallback((start: number, end: number) => {
    setWant((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  // Answer one row. A superseded generation's answer is dropped, and does
  // not free a slot: the counter was reset along with the list. The write
  // matches the generation as well as the key, so it lands on the row it
  // was requested for or nowhere. Settling ends a Retry's `force`. Anything
  // but `ok` (a failure, or a walked row sent back to pending) leaves the
  // started set, so the row can be requested again.
  const settleRow = (
    key: string,
    gen: number,
    patch: Pick<CatalogRow, "items" | "status" | "walked">,
  ) => {
    if (gen !== fetchGenRef.current) return;
    fetchInflightRef.current -= 1;
    if (patch.status !== "ok") fetchStartedRef.current.delete(key);
    setRows((prev) => prev.map((r) => (
      r.key === key && r.gen === gen ? { ...r, ...patch, retry: false } : r
    )));
    markBootstrapped();
  };

  // The fetch queue. Walks the wanted rows (the row window, plus
  // HOME_FETCH_AHEAD past its end) in row order and starts pending ones
  // until HOME_FETCH_CONCURRENCY are in flight. It re-runs whenever a row
  // settles or the window moves, which is what keeps it draining. Only rows
  // of the current generation start (see CatalogRow.gen).
  //
  // The default hero is the one reason to look past the window. With no
  // hero catalog pinned, the hero is the first row with items, and that must
  // not depend on where the window sits: if the rows near it produce nothing
  // (the first addon's catalogs all failing, say), the hero would never
  // appear. So while no row has items, a slot the rows near the window do
  // not need goes to the next pending row past it, in row order, at the same
  // concurrency, until one row has items or every row has been tried. After
  // that, a row the window never reaches is never requested. A walked row
  // that fails is not failed for good: the user never asked for it, and its
  // addon may well be back by the time they scroll there. It returns to
  // `pending` as `walked`, the walk passes over it from then on, and the
  // window fetches it the ordinary way when it comes near.
  //
  // Each catalog is fetched with `limit = HOME_VISIBLE_CAP` so the home
  // payload only carries enough items for the visible row cells. Wire
  // bytes are unchanged (Stremio addons return one page = up to 100 items
  // regardless), but Rust's per-meta sanitisation runs only on the kept
  // slice, and the React tree holds 10 items per row instead of 100. The
  // remaining items come in lazily via `fetch_catalog_paginated` when the
  // user opens View all on a specific row.
  useEffect(() => {
    const gen = fetchGenRef.current;
    const near = shownRows.slice(want.start, want.end + HOME_FETCH_AHEAD);
    const heroWaiting = !heroDisabled && !heroCatalogPref
      && !shownRows.some((r) => r.items.length > 0);
    const candidates = near.map((row) => ({ row, walk: false }));
    if (heroWaiting) {
      for (const row of shownRows) {
        if (!row.walked) candidates.push({ row, walk: true });
      }
    }
    const starting: typeof candidates = [];
    for (const c of candidates) {
      if (fetchInflightRef.current + starting.length >= HOME_FETCH_CONCURRENCY) break;
      const { row } = c;
      if (row.gen !== gen || row.status !== "pending" || fetchStartedRef.current.has(row.key)) {
        continue;
      }
      // Recorded before any request goes out, so a second pass of this
      // effect before the answers land (StrictMode, or a window change)
      // cannot start the same row again, and the hero walk, which meets
      // the rows near the window twice, starts each once (as `walk: false`,
      // since the near rows come first).
      fetchStartedRef.current.add(row.key);
      starting.push(c);
    }
    fetchInflightRef.current += starting.length;
    for (const { row, walk } of starting) {
      invoke<MetaPreview[]>("fetch_catalog", {
        addonUrl:    row.addonUrl,
        catalogType: row.catalog.media_type,
        catalogId:   row.catalog.id,
        limit:       HOME_VISIBLE_CAP,
        // A walked row the window now reaches skips Rust's per-catalog
        // soft-fail cooldown once: its walk request may have failed moments
        // ago, and without this the cooldown refuses it unsent and it lands
        // on Retry although the addon may be back. The user scrolling to it
        // is as deliberate as pressing Retry, and it happens once per row
        // (it settles ok or failed, never back to pending, from here).
        force:       row.retry === true || (!walk && row.walked === true),
      })
        .then((items) => settleRow(row.key, gen, { items, status: "ok" }))
        .catch(() => settleRow(row.key, gen, walk
          ? { items: [], status: "pending", walked: true }
          : { items: [], status: "failed" }));
    }
  }, [shownRows, want, heroCatalogPref, heroDisabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // Retry one failed row: back to pending, so the queue picks it up on its
  // next pass (it is in the window, since its Retry button was just
  // clicked), flagged `retry` so that request really goes to the network:
  // a timeout or connect failure arms Rust's 30 s per-catalog cooldown, and
  // without `force` the retry would be refused by that cooldown unsent.
  // Only a FAILED row moves, so a repeat call while the retry is in flight
  // cannot queue it twice.
  const retryRow = useCallback((key: string) => {
    setRows((prev) => prev.map((r) => (
      r.key === key && r.status === "failed" ? { ...r, status: "pending", retry: true } : r
    )));
  }, []);

  // Memoize search-addon resolution. electSearchAddons() builds a fresh
  // array every call, and these were previously inlined into the JSX
  // (passed straight to SearchBar / SearchView). Each parent render produced
  // a new array reference, which retriggered SearchView's
  // `useEffect(..., [addons, query])` → setState → re-render → loop. In
  // production this manifested as `global_search_grouped` firing in a tight
  // loop AFTER a stream was already playing (HomeView stayed mounted under
  // the player overlay), eventually crashing with React's
  // "Maximum update depth exceeded". Recompute only when the addon list
  // actually changes or the user mutates search-provider settings
  // (searchTick; settingsTick still covers storage and key-less events).
  const submitSearchAddons = useMemo(
    () => electSearchAddons(addons),
    [addons, settingsTick, searchTick],
  );

  const [heroOverrideItems, setHeroOverrideItems] = useState<MetaPreview[] | null>(null);
  const [heroOverrideLabel, setHeroOverrideLabel] = useState<string | null>(null);
  useEffect(() => {
    // Hero off, or no override catalog pinned → nothing to fetch.
    if (heroDisabled || !heroCatalogPref) {
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
  }, [heroCatalogPref, heroDisabled]);

  // The first row with items: the hero's default source. The fetch queue
  // walks past the row window until one exists, so it does not wait on the
  // window's rows loading. Rows now settle one by one as the window moves,
  // long after the hero is filled, so the two memos below key on this row
  // rather than on `rows`. A settled row is never rewritten, so it keeps
  // its identity until an EARLIER row gains items and takes its place.
  const firstFilledRow = useMemo(() => rows.find((r) => r.items.length > 0), [rows]);

  // Source for the hero — override catalog when configured, otherwise
  // the first browseable row's first ~5 art-bearing items. Empty when the
  // hero is disabled, which both hides the banner and skips the per-item
  // logo fetches below.
  const heroItemsRaw: MetaPreview[] = useMemo(() => {
    if (heroDisabled) return [];
    const source = heroOverrideItems ?? firstFilledRow?.items ?? [];
    return source
      .filter((it) => it.background ?? it.fanart ?? it.backdrop ?? it.poster)
      .slice(0, 10);
  }, [heroDisabled, heroOverrideItems, firstFilledRow]);

  /** Display name of the catalog the hero is pulled from — surfaces
   *  as a subtle top-left chip on the hero card so the user knows
   *  which row contributed the current selection. Empty when there's
   *  no resolved source row. */
  /** Identity of the hero's source, for keying the carousel: the pinned
   *  catalog when one is set, else the default source row. */
  const heroSourceKey = heroOverrideItems
    ? "pinned-hero"
    : (firstFilledRow?.key ?? "no-hero-source");

  const heroSourceLabel: string | null = useMemo(() => {
    if (heroOverrideLabel) return heroOverrideLabel;
    if (!firstFilledRow) return null;
    return withTypeSuffix(firstFilledRow.catalog.name, firstFilledRow.catalog.media_type);
  }, [heroOverrideLabel, firstFilledRow]);

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
  // bar moved to per-view sidebars, so Home applies no user filter. The
  // grid renders `shownRows` (`rows` minus catalogs that answered empty)
  // through the windowed HomeRowList, so the row window's indexes, and the
  // fetch queue's `want`, refer to `shownRows`, not `rows`.

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

  // The scroll container is held as state, not a plain ref: it unmounts
  // while a search is showing, and the row window's effects must re-run
  // against the new element when it comes back. The hook lists its refs as
  // dependencies, so a fresh ref object per element is what re-runs them.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const scrollRef = useMemo(() => ({ current: scrollEl }), [scrollEl]);
  /** Everything above the catalog rows (hero + Continue Watching). */
  const leadRef = useRef<HTMLDivElement>(null);

  return (
    <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Centered search bar. The filter & sort button used to live in
          this bar; it's now scoped to the surfaces where filtering a
          finite list actually makes sense — view-all catalog page,
          Library, Queue, Discover. The home grid is a curated mix of
          catalogs the user already chose to surface, so layering a
          global filter on top blurred the distinction between
          "browsing what an addon offers" and "narrowing my own list". */}
      {/* FLOATING, not a header band. The strip used to reserve its own row
          above the scroller, so the bar had nothing behind it but the app
          background and there was nothing to refract. Overlaying it on the
          catalog is what makes the glass mean something: the art moves under
          it as the page scrolls.
          The scroller below compensates with matching top padding, so no
          content is permanently parked underneath. */}
      <div className="absolute inset-x-0 top-0 z-30 pt-4 pb-2 px-6 pointer-events-none">
        <div
          className="mx-auto relative w-full pointer-events-auto"
          style={{ maxWidth: HERO_MAX_WIDTH }}
        >
          <SearchBar
            committedQuery={activeQuery}
            onSubmit={handleSubmitSearch}
            onClear={handleClearSearch}
          />
        </div>
      </div>

      {activeQuery ? (
        // Same top inset as the scroller: the floating bar overlays this
        // branch too, and results starting underneath it would be unreachable
        // at the top of the list.
        <div className="flex-1 min-h-0 flex flex-col pt-[66px]">
          <SearchView
            addons={submitSearchAddons}
            query={activeQuery}
            onSelectMeta={onSelectMeta}
          />
        </div>
      ) : (
        <div
          ref={setScrollEl}
          // `px-3` is NOT cosmetic padding: this scroll container is the
          // horizontal clip box (overflow-y-auto forces overflow-x to
          // compute to clip). Without inner padding, the leftmost catalog
          // card's hover `drop-shadow` (~24px reach) is sliced into a hard
          // vertical line at the column edge adjacent to the sidebar. The
          // 12px inset lets the shadow fade naturally inside the clip box;
          // rows already self-pad (px-6) so net layout shift is minor and
          // uniform, and the symmetrical right inset softens the (latent)
          // identical clip on the rightmost card.
          className="flex-1 min-h-0 overflow-y-auto px-3 pt-[66px]"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          {/* Empty state when no addons */}
          {addons.length === 0 && bootstrapped && (
            <div className="h-full flex flex-col items-center justify-center gap-3 text-white/35">
              <p className="text-sm">No addons installed yet.</p>
              <p className="text-xs text-white/25">Open the Addons tab to add one.</p>
            </div>
          )}

          {/* Everything above the catalog rows, in ONE element so the row
              window can watch its height: the hero lands after the first
              row does and pushes every row down by its own height. */}
          <div ref={leadRef}>
            {/* Hero carousel */}
            {heroItems.length > 0 && (
              <div className="px-6 pt-2 pb-4">
                <HeroCarousel
                  // Keyed on the SOURCE so a change of source (a pinned hero
                  // catalog, or an earlier row filling and becoming the first
                  // row with items) starts at slide 0 rather than keeping a
                  // slide index that belongs to the old list.
                  key={heroSourceKey}
                  items={heroItems}
                  onSelect={onSelectMeta}
                  sourceLabel={heroSourceLabel ?? undefined}
                />
              </div>
            )}

            {/* Continue Watching: 16:9 row */}
            {continueWatching.length > 0 && (
              <div className="pt-2 pb-2">
                <ContinueWatchingRow items={continueWatching} onSelectMeta={onSelectFromCW ?? onSelectMeta} addons={addons} />
              </div>
            )}
          </div>

          {/* Discovery rows — preserve native Stremio manifest order. We
              deliberately don't prefix rows with the addon name; the catalog's
              own name is sufficient and the prefix added visual noise on
              multi-source setups. */}
          {shownRows.length > 0 && (
            <HomeRowList
              rows={shownRows}
              scrollRef={scrollRef}
              leadRef={leadRef}
              onWindowChange={handleWindowChange}
              onSelectMeta={onSelectMeta}
              onRetry={retryRow}
            />
          )}

          {/* Manifests still loading */}
          {rows.length === 0 && addons.length > 0 && !bootstrapped && (
            <div className="px-6 pt-6">
              <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/60 to-transparent animate-pulse" />
            </div>
          )}

          {/* No catalog provider feeds Home — addons are installed but none
              produce catalog rows. Point the user at Catalog Providers. (Rows
              are created per-catalog before items load, so an empty rows list
              after bootstrap means no catalog provider, not a slow fetch.) */}
          {rows.length === 0 && addons.length > 0 && bootstrapped && (
            <div className="px-6 pt-10">
              <NoProvidersWarning
                section="sec-catalog"
                message="No catalog providers are active, so Home has nothing to show."
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// HomeRowList: the catalog rows, windowed.
//
// Only the rows in or near the viewport mount (and, while its View-all popup
// is open, the row that owns it; see below). That is what frees posters:
// ImageLoader disconnects its observer on first intersect and never unmounts
// its <img>, so with every row mounted, one scroll to the bottom of 40 rows
// kept ~400 decoded posters alive for as long as Home was, the same GPU and
// decode cost Library already hit. One catalog row per window row (cols: 1),
// and every row state is exactly one stride tall (DiscoveryRow's
// `uniformHeight`), which is what lets the hook place them all from a single
// measured row.
// ---------------------------------------------------------------------------

/** One catalog row per window row. Module-level because the hook's layout
 *  effect lists it as a dependency, like the View-all popup's options. */
const ONE_ROW_PER_WINDOW_ROW = () => 1;

function HomeRowList({
  rows, scrollRef, leadRef, onWindowChange, onSelectMeta, onRetry,
}: {
  rows: CatalogRow[];
  scrollRef: RefObject<HTMLDivElement | null>;
  leadRef: RefObject<HTMLDivElement | null>;
  /** The row window (the rows in or near the viewport), which is the fetch
   *  queue's priority. A row pinned by its open View-all popup can mount
   *  outside it and is not reported. */
  onWindowChange: (start: number, end: number) => void;
  onSelectMeta?: (meta: MetaPreview) => void;
  onRetry: (key: string) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const win = useRowWindow(scrollRef, wrapperRef, gridRef, rows.length, {
    gap:          HOME_ROW_GAP,
    estRowStride: HOME_EST_ROW_STRIDE,
    resolveCols:  ONE_ROW_PER_WINDOW_ROW,
    initialItems: HOME_INITIAL_ROWS,
    leadRef,
  });

  useEffect(() => {
    onWindowChange(win.start, win.end);
  }, [win.start, win.end, onWindowChange]);

  // A row whose View-all popup is open stays mounted wherever the window
  // goes. The popup, with its loaded page and filters, lives in the row, and
  // Home can move underneath it: the View-all button keeps focus, so End or
  // PageDown scroll Home, and a resize re-measures the stride. Either would
  // unmount the row mid-use. Only that ONE row is added: stretching the
  // mounted range to reach it would mount every row in between, which after
  // an End is most of Home, posters and all, for as long as the popup is
  // open. The pinned row goes in the same keyed list as the window's rows
  // (so React keeps its state as it leaves the window), with one spacer
  // standing in for the rows it skips: `k * rowStride - gap` tall, since the
  // flex gap on either side of the spacer supplies the rest, which puts the
  // pinned row at exactly its own `index * rowStride`. The spacer only ever
  // sits between the pin and the window's rows, so the grid's first child,
  // which the hook measures the stride from, is always a row. The fetch
  // queue follows the window alone (`onWindowChange` above).
  const [popupKey, setPopupKey] = useState<string | null>(null);
  const handleOverflowChange = useCallback((key: string, open: boolean) => {
    setPopupKey((prev) => (open ? key : prev === key ? null : prev));
  }, []);
  const popupIdx = popupKey == null ? -1 : rows.findIndex((r) => r.key === popupKey);
  const pinnedAbove = popupIdx >= 0 && popupIdx < win.start;
  const pinnedBelow = popupIdx >= win.end;

  // Scroll offset before the current commit. The listener sees every frame's
  // offset before any later task can commit, and the effect below refreshes
  // it after each commit of its own.
  const scrollTopRef = useRef(0);
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const note = () => { scrollTopRef.current = scroll.scrollTop; };
    note();
    scroll.addEventListener("scroll", note, { passive: true });
    return () => scroll.removeEventListener("scroll", note);
  }, [scrollRef]);

  // Keep the viewport still when rows above it leave the list. A row whose
  // catalog comes back empty hides itself, and one above the viewport (the
  // window's overscan, or rows met again after a jump down the scrollbar)
  // would otherwise shift everything on screen up by a stride. The offset is
  // restored from the pre-commit value, not nudged from the current one:
  // near the bottom the shorter spacer has already clamped scrollTop, and a
  // relative nudge would then move the page twice.
  const keysRef = useRef<string[]>([]);
  useLayoutEffect(() => {
    const prev = keysRef.current;
    const keys = rows.map((r) => r.key);
    keysRef.current = keys;
    const scroll = scrollRef.current;
    const wrapper = wrapperRef.current;
    if (!scroll || !wrapper) return;
    const kept = new Set(keys);
    const prevSet = new Set(prev);
    // Only a pure removal; a rebuilt list has nothing to keep still.
    if (keys.length < prev.length && keys.every((k) => prevSet.has(k))) {
      const gridTop = wrapper.getBoundingClientRect().top
        - scroll.getBoundingClientRect().top + scroll.scrollTop;
      const within = scrollTopRef.current - gridTop;
      let removedAbove = 0;
      prev.forEach((k, i) => {
        if (!kept.has(k) && i * win.rowStride < within) removedAbove += 1;
      });
      if (removedAbove > 0) {
        scroll.scrollTop = Math.max(0, scrollTopRef.current - removedAbove * win.rowStride);
      }
    }
    scrollTopRef.current = scroll.scrollTop;
  }, [rows, scrollRef, win.rowStride]);

  const renderRow = (row: CatalogRow) => (
    <DiscoveryRow
      key={row.key}
      title={withTypeSuffix(row.catalog.name, row.catalog.media_type)}
      items={row.items}
      loading={row.status === "pending"}
      failed={row.status === "failed"}
      onRetry={row.status === "failed" ? () => onRetry(row.key) : undefined}
      onSelectMeta={onSelectMeta}
      addonUrl={row.addonUrl}
      catalogType={row.catalog.media_type}
      catalogId={row.catalog.id}
      uniformHeight
      rowKey={row.key}
      onOverflowChange={handleOverflowChange}
    />
  );
  const mounted: ReactElement[] = rows.slice(win.start, win.end).map(renderRow);
  if (pinnedAbove || pinnedBelow) {
    const skipped = pinnedAbove ? win.start - popupIdx - 1 : popupIdx - win.end;
    const pin: ReactElement[] = [renderRow(rows[popupIdx])];
    const spacer = skipped > 0 ? [
      <div
        // One key per SIDE. A shared key survives a jump from pinned-above
        // to pinned-below, and React then MOVES the pinned row's DOM past
        // it, which resets the open View-all popup's scroll and blanks its
        // virtualized grid. Distinct keys leave the pin as the only matched
        // node, so React inserts around it instead.
        key={pinnedAbove ? "pinned-spacer-above" : "pinned-spacer-below"}
        aria-hidden
        style={{ height: skipped * win.rowStride - HOME_ROW_GAP }}
      />,
    ] : [];
    if (pinnedAbove) mounted.unshift(...pin, ...spacer);
    else mounted.push(...spacer, ...pin);
  }

  return (
    <div className="pt-2 pb-10">
      <div ref={wrapperRef} style={{ position: "relative", height: win.totalHeight }}>
        <div
          ref={gridRef}
          className="flex flex-col"
          style={{
            position: "absolute",
            // One row per window row, so row i sits at i * rowStride; with
            // no popup pinned above the window this is exactly `win.offsetY`.
            top: (pinnedAbove ? popupIdx : win.start) * win.rowStride,
            left: 0,
            right: 0,
            gap: HOME_ROW_GAP,
            // Out of the browser's own scroll anchoring. The effect above is
            // the one adjustment for a row leaving; a second one from the
            // browser would move the page twice.
            overflowAnchor: "none",
          }}
        >
          {mounted}
        </div>
      </div>
    </div>
  );
}
