// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, SearchCatalogPlan, SearchGroup, SearchProgress } from "../types";
import { DiscoveryRow } from "../CinemaRows";
import { withTypeSuffix } from "../aiometadata";
import ErrorBoundary from "../ErrorBoundary";
import NoProvidersWarning from "../NoProvidersWarning";
import { PAGE_CONTENT_MAX_W } from "../pageLayout";
import { sheet } from "../glassSheet";

// Module-level in-flight dedupe. React StrictMode (and any other transient
// remount) was double-invoking the search effect, which fired TWO identical
// addon round-trips for every query. Keying live searches by
// `<addon_url>::<trimmed-query>` lets both effect runs share one: the SECOND
// gets the in-flight search back, so only one HTTP request per catalog hits
// the addon. A search clears itself on settle, so a fresh search of the same
// term still re-fetches.
//
// Progress (the catalog plan, then each catalog as it lands) arrives through
// a Tauri Channel bound to the FIRST caller, so every message is kept on the
// entry and replayed to a later subscriber: the effect run that renders is
// usually the second one.
interface InflightSearch {
  promise:   Promise<SearchGroup[]>;
  events:    SearchProgress[];
  listeners: Set<(e: SearchProgress) => void>;
}
const inflightSearches = new Map<string, InflightSearch>();

function runDedupedAddonSearch(
  addon: AddonEntry,
  query: string,
  onProgress: (e: SearchProgress) => void,
): { promise: Promise<SearchGroup[]>; unsubscribe: () => void } {
  const key = `${addon.url}::${query}`;
  let entry = inflightSearches.get(key);
  if (!entry) {
    const events: SearchProgress[] = [];
    const listeners = new Set<(e: SearchProgress) => void>();
    const channel = new Channel<SearchProgress>();
    channel.onmessage = (e) => {
      events.push(e);
      listeners.forEach((l) => l(e));
    };
    const promise = invoke<SearchGroup[]>("search_addon_grouped", { addon, query, onProgress: channel })
      .finally(() => {
        if (inflightSearches.get(key)?.promise === promise) {
          inflightSearches.delete(key);
        }
      });
    entry = { promise, events, listeners };
    inflightSearches.set(key, entry);
  }
  const { events, listeners } = entry;
  events.forEach(onProgress);
  listeners.add(onProgress);
  return { promise: entry.promise, unsubscribe: () => { listeners.delete(onProgress); } };
}

// ---------------------------------------------------------------------------
// SearchView — Stremio-style per-addon-catalog grouped search.
//
// Fans out one `search_addon_grouped` call per search-enabled addon in
// parallel, and each addon searches its catalogs concurrently. Every
// catalog's row populates the view as it lands, so neither the slowest
// addon nor an addon's slowest catalog holds back the rest. Once an addon
// has announced its catalogs, each one holds its manifest-order place
// with a ONE-LINE placeholder until it lands, so rows never reorder
// mid-search and a catalog with no results collapses by about a line. A
// catalog that did not answer (or an addon whose manifest could not be
// read) keeps a one-line "did not answer" row with a Retry that asks only
// that catalog (or addon) again.
// ---------------------------------------------------------------------------

interface Props {
  /** The addons to search, in order: electSearchAddons' output. */
  addons: AddonEntry[];
  /** Every installed addon. Read only by the no-providers warning, which has
   *  to know what the Search Providers override left out. */
  installedAddons: AddonEntry[];
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

/** What one catalog of an addon came back with. `failed` is a catalog that
 *  did not answer (no reply, an HTTP error, bad JSON, still rate limited
 *  after its one retry), which is shown; `empty` answered with nothing and
 *  collapses; `retrying` is a per-catalog Retry in flight. */
type CatalogOutcome =
  | { kind: "group"; group: SearchGroup }
  | { kind: "empty" }
  | { kind: "failed" }
  | { kind: "retrying" };

/** Tracks one search-capable addon's contribution to the result set.
 *  `state` advances pending → settled, or pending → failed when the addon
 *  itself did not answer (its manifest could not be read). The `addon`
 *  field carries the installed-order anchor so the rendered list preserves
 *  manifest order regardless of arrival order. `plan` lists the addon's
 *  search catalogs (once announced) and `landed` holds each one's outcome
 *  by its plan order. `retry` marks an addon being searched again after it
 *  failed, so it keeps a compact placeholder until its plan arrives. */
interface AddonSearchSlot {
  addon:  AddonEntry;
  state:  "pending" | "settled" | "failed";
  groups: SearchGroup[];
  plan:   SearchCatalogPlan[] | null;
  landed: Record<number, CatalogOutcome>;
  retry?: boolean;
}

/** One row of the results: a landed group, a catalog still searching, a
 *  catalog that did not answer, or a whole addon that did not answer (or is
 *  being searched again). */
type SearchRow =
  | { kind: "group"; group: SearchGroup }
  | { kind: "pending"; plan: SearchCatalogPlan }
  | { kind: "failed"; plan: SearchCatalogPlan; addon: AddonEntry }
  | { kind: "addon-pending"; addon: AddonEntry }
  | { kind: "addon-failed"; addon: AddonEntry };

const rowKey = (addonUrl: string, mediaType: string, catalogId: string) =>
  `${addonUrl}|${mediaType}-${catalogId}`;

const outcomeOf = (e: { group: SearchGroup | null; failed: boolean }): CatalogOutcome =>
  e.failed ? { kind: "failed" } : e.group ? { kind: "group", group: e.group } : { kind: "empty" };

/** The rows one addon contributes, in its plan order. */
function slotRows(s: AddonSearchSlot): SearchRow[] {
  if (s.state === "failed") return [{ kind: "addon-failed", addon: s.addon }];
  if (!s.plan) {
    if (s.state === "pending") return s.retry ? [{ kind: "addon-pending", addon: s.addon }] : [];
    return s.groups.map((group) => ({ kind: "group", group }));
  }
  return s.plan.flatMap((plan): SearchRow[] => {
    const out = s.landed[plan.order];
    if (!out) {
      if (s.state === "pending") return [{ kind: "pending", plan }];
      // Settled before this catalog's progress message arrived: fall back
      // to the returned groups (which cannot tell empty from failed).
      const group = s.groups.find(
        (g) => g.media_type === plan.media_type && g.catalog_id === plan.catalog_id,
      );
      return group ? [{ kind: "group", group }] : [];
    }
    switch (out.kind) {
      case "group":    return [{ kind: "group", group: out.group }];
      case "empty":    return [];
      case "failed":   return [{ kind: "failed", plan, addon: s.addon }];
      case "retrying": return [{ kind: "pending", plan }];
    }
  });
}

function SearchViewBody({ addons, installedAddons, query, onSelectMeta }: Props) {
  const [slots, setSlots] = useState<AddonSearchSlot[] | null>(null);
  const lastQueryRef = useRef<string>("");
  // Bumped by every new search (and its cleanup): a result from an older
  // query, a per-catalog Retry included, checks it and is dropped.
  const genRef = useRef(0);
  // Progress listeners of the current search, its retries included.
  const subsRef = useRef<Set<() => void>>(new Set());

  // Update only the slot of the addon a result is about, leaving every
  // other slot untouched (keyed by addon.url so identity is stable).
  const patchSlot = (gen: number, addon: AddonEntry, f: (s: AddonSearchSlot) => AddonSearchSlot) => {
    if (genRef.current !== gen) return;
    setSlots((prev) => prev && prev.map((s) => (s.addon.url === addon.url ? f(s) : s)));
  };

  // Search one addon; it reports each catalog as it lands.
  const startAddon = (addon: AddonEntry, trimmed: string, gen: number) => {
    const { promise, unsubscribe } = runDedupedAddonSearch(addon, trimmed, (e) => {
      patchSlot(gen, addon, (s) => {
        if (s.state === "failed") return s;
        if (e.kind === "plan") return { ...s, plan: e.catalogs };
        return { ...s, landed: { ...s.landed, [e.order]: outcomeOf(e) } };
      });
    });
    subsRef.current.add(unsubscribe);
    promise
      .then((groups) => patchSlot(gen, addon, (s) => ({ ...s, state: "settled", groups, retry: false })))
      .catch(() => patchSlot(gen, addon, (s) => ({ ...s, state: "failed", groups: [], retry: false })));
  };

  useEffect(() => {
    const trimmed = query.trim();
    lastQueryRef.current = trimmed;
    const gen = ++genRef.current;
    if (!trimmed) { setSlots(null); return; }
    // `addons` IS the search election (electSearchAddons: has_search, then
    // the user's Search Providers list). No second has_search filter here:
    // it would make a caller passing the raw addon list look correct while
    // silently ignoring the Search Providers list.
    if (addons.length === 0) { setSlots([]); return; }

    // Seed every addon as pending so the user sees the row count
    // immediately, in installed-addon order regardless of
    // which addon finishes first.
    setSlots(addons.map((a) => ({ addon: a, state: "pending", groups: [], plan: null, landed: {} })));

    // Fan out: one call per addon. Each settles independently, and each
    // reports its catalogs as they land.
    addons.forEach((addon) => startAddon(addon, trimmed, gen));

    const subs = subsRef.current;
    return () => {
      genRef.current++;
      subs.forEach((u) => u());
      subs.clear();
    };
    // startAddon / patchSlot read only refs and the state setter.
  }, [addons, query]);

  /** Ask ONE catalog again (the failed row's Retry), paced like a full
   *  search. A newer query drops the answer. */
  const retryCatalog = (addon: AddonEntry, plan: SearchCatalogPlan) => {
    const gen = genRef.current;
    const trimmed = lastQueryRef.current;
    if (!trimmed) return;
    const settle = (out: CatalogOutcome) =>
      patchSlot(gen, addon, (s) => ({ ...s, landed: { ...s.landed, [plan.order]: out } }));
    settle({ kind: "retrying" });
    invoke<SearchGroup[]>("search_addon_grouped", {
      addon,
      query: trimmed,
      onProgress: new Channel<SearchProgress>(),
      only: { media_type: plan.media_type, catalog_id: plan.catalog_id },
    })
      .then((groups) => settle(groups[0] ? { kind: "group", group: groups[0] } : { kind: "empty" }))
      .catch(() => settle({ kind: "failed" }));
  };

  /** Search a whole addon again (its manifest could not be read). */
  const retryAddon = (addon: AddonEntry) => {
    const gen = genRef.current;
    const trimmed = lastQueryRef.current;
    if (!trimmed) return;
    patchSlot(gen, addon, (s) => ({ ...s, state: "pending", groups: [], plan: null, landed: {}, retry: true }));
    startAddon(addon, trimmed, gen);
  };

  // Derived view of the addon→groups map. Walks slots in installed
  // order, and each addon's catalogs in plan order, so rows always
  // render in the same position no matter which finished first.
  const rows = useMemo<SearchRow[]>(() => (slots ?? []).flatMap(slotRows), [slots]);
  const orderedGroups = useMemo<SearchGroup[]>(
    () => rows.flatMap((r) => (r.kind === "group" ? [r.group] : [])),
    [rows],
  );
  const totalItems = useMemo(
    () => orderedGroups.reduce((s, g) => s + g.items.length, 0),
    [orderedGroups],
  );
  const failedCount = rows.filter((r) => r.kind === "failed" || r.kind === "addon-failed").length;
  const anyRowBusy = rows.some((r) => r.kind === "pending" || r.kind === "addon-pending");
  const pendingCount = (slots ?? []).filter((s) => s.state === "pending").length;
  const settledCount = (slots ?? []).filter((s) => s.state !== "pending").length;
  const totalAddons = (slots ?? []).length;
  const stillSearching = pendingCount > 0;

  const trimmedQuery = query.trim();

  // One polite announcement when a search finishes (screen readers): the
  // rows themselves arrive silently while the list is aria-busy.
  const summary = slots && totalAddons > 0 && !stillSearching && !anyRowBusy
    ? `${totalItems} result${totalItems === 1 ? "" : "s"} across ${orderedGroups.length} catalog${orderedGroups.length === 1 ? "" : "s"}${
        failedCount > 0 ? `, ${failedCount} did not answer` : ""}`
    : "";

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="aura-page-scroller flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="mx-auto px-2 py-4 space-y-2" style={{ maxWidth: PAGE_CONTENT_MAX_W }}>
          {/* Header: query summary */}
          <div className="px-7 pb-2 flex items-baseline gap-3">
            <h1 data-glass-light="text" className="aura-row-title text-2xl font-semibold tracking-tight">
              Search
            </h1>
            <p className="text-white/45 text-xs font-mono tracking-wider truncate">
              “{query}”
              {slots && totalAddons > 0 && (
                <span className="text-white/30 ml-2">
                  {stillSearching
                    ? `· ${settledCount}/${totalAddons} addon${totalAddons === 1 ? "" : "s"} searched`
                    : `· ${summary || `${totalItems} result${totalItems === 1 ? "" : "s"}`}`
                  }
                </span>
              )}
            </p>
            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{summary}</span>
          </div>

          {/* Top-of-list shimmer while at least one addon hasn't
              landed AND no rows have arrived yet. Once even one row
              shows, the shimmer collapses: the user sees a partial
              result instead of an opaque skeleton. */}
          {stillSearching && rows.length === 0 && (
            <div className="px-6 space-y-3">
              <div className="h-px bg-gradient-to-r from-transparent via-ln-accent/60 to-transparent animate-pulse" />
              <p className="text-white/40 text-xs px-1">
                Searching across {totalAddons} addon{totalAddons === 1 ? "" : "s"}…
              </p>
            </div>
          )}

          {/* No search providers active (the resolved set is empty: no
              search-capable addon is installed, or the Search Providers
              override leaves every one out). The warning points at the
              Addons page, or at Search Providers when the override is why. */}
          {slots && slots.length === 0 && (
            <div className="px-6 pt-8">
              <NoProvidersWarning job="search" addons={installedAddons} />
            </div>
          )}

          {/* Empty state: providers searched and every one answered with
              nothing. A catalog that did not answer keeps its own row, so
              this shows only when nothing at all is left to show. */}
          {slots && slots.length > 0 && !stillSearching && rows.length === 0 && (
            <div {...sheet("mx-6 my-6 rounded-[20px] px-6 py-10 text-center")}>
              <p className="text-white/55 text-sm">
                No results from any active search provider.
              </p>
            </div>
          )}

          {/* Results: one DiscoveryRow per (addon, catalog), in addon
              order then catalog order. A catalog still searching holds its
              place with a ONE-LINE placeholder (not a poster row), so one
              that comes back empty collapses by about a line; a catalog
              that did not answer keeps a one-line row with Retry. */}
          {rows.length > 0 && (
            <div className="pt-2 pb-10 flex flex-col" aria-busy={stillSearching || anyRowBusy || undefined}>
              {rows.map((r, i) => {
                // Poster rows sit 2rem apart; a compact row only 0.5rem
                // below what precedes it, so it costs little when it goes.
                const gap = i === 0 ? "" : r.kind === "group" ? "mt-8" : "mt-2";
                if (r.kind === "pending" || r.kind === "addon-pending") {
                  const key = r.kind === "pending"
                    ? rowKey(r.plan.addon_url, r.plan.media_type, r.plan.catalog_id)
                    : `addon:${r.addon.url}`;
                  const label = r.kind === "pending"
                    ? withTypeSuffix(r.plan.catalog_name, r.plan.media_type)
                    : r.addon.name;
                  return (
                    <div key={key} className={gap}>
                      <CompactSearchRow title={label} />
                    </div>
                  );
                }
                if (r.kind === "failed" || r.kind === "addon-failed") {
                  const p = r.kind === "failed" ? r.plan : null;
                  const key = p
                    ? rowKey(p.addon_url, p.media_type, p.catalog_id)
                    : `addon:${r.addon.url}`;
                  return (
                    <div key={key} className={gap}>
                      <CompactSearchRow
                        title={p ? withTypeSuffix(p.catalog_name, p.media_type) : r.addon.name}
                        addonName={p ? r.addon.name : undefined}
                        onRetry={() => (p ? retryCatalog(r.addon, p) : retryAddon(r.addon))}
                      />
                    </div>
                  );
                }
                const g = r.group;
                return (
                  <SearchGroupRow
                    key={rowKey(g.addon_url, g.media_type, g.catalog_id)}
                    className={gap}
                    group={g}
                    query={trimmedQuery}
                    onSelectMeta={onSelectMeta}
                  />
                );
              })}
              {/* Trailing shimmer when at least one addon is still
                  pending: signals "more results may still arrive
                  below" instead of leaving the user wondering whether
                  the visible groups are everything. */}
              {stillSearching && (
                <div className="px-6 mt-8">
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

/** One landed catalog's poster row. Memoized, with its `searchExpand` built
 *  once per group: an inline object literal there defeated DiscoveryRow's
 *  memo, so every catalog that landed re-rendered (and re-deduped) every
 *  poster row already on the page. Now a landing renders only its own row;
 *  the landed group objects keep their identity across slot patches. */
const SearchGroupRow = memo(function SearchGroupRow({ group: g, query, className, onSelectMeta }: {
  group: SearchGroup;
  query: string;
  className: string;
  onSelectMeta?: (meta: MetaPreview) => void;
}) {
  const searchExpand = useMemo(() => ({
    addonUrl:  g.addon_url,
    mediaType: g.media_type,
    catalogId: g.catalog_id,
    query,
  }), [g.addon_url, g.media_type, g.catalog_id, query]);
  return (
    <div className={className}>
      <DiscoveryRow
        title={withTypeSuffix(g.catalog_name, g.media_type)}
        items={g.items}
        loading={false}
        onSelectMeta={onSelectMeta}
        searchExpand={searchExpand}
      />
    </div>
  );
});

/** A one-line search row: a catalog (or addon) still searching, or, with
 *  `onRetry`, one that did not answer. Title height, so a placeholder that
 *  comes back empty and collapses moves the rows below by about a line. */
function CompactSearchRow({ title, addonName, onRetry }: {
  title: string;
  addonName?: string;
  onRetry?: () => void;
}) {
  const failed = !!onRetry;
  // A Retry swaps the button for the placeholder, which would drop keyboard
  // focus on <body>; the row (kept across that swap, same key) takes it.
  const sectionRef = useRef<HTMLElement>(null);
  const retry = () => {
    sectionRef.current?.focus();
    onRetry?.();
  };
  return (
    <section ref={sectionRef} tabIndex={-1} className="px-6">
      <div className="flex items-center gap-3 px-1 h-8 min-w-0">
        <p className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-white/60" title={addonName ? `${title} (${addonName})` : title}>
          {title}
          {failed && <span className="font-normal text-white/55"> did not answer</span>}
          {!failed && <span className="sr-only">, searching</span>}
        </p>
        {failed ? (
          <button
            type="button"
            onClick={retry}
            aria-label={`Retry ${title}`}
            className="aura-glass-flat aura-glass-press shrink-0 px-3 h-7 rounded-full text-white/85 hover:text-white text-xs font-medium"
          >
            Retry
          </button>
        ) : (
          <span aria-hidden className="h-1.5 w-full max-w-[12rem] shrink rounded-full image-loader-skeleton" />
        )}
      </div>
    </section>
  );
}
