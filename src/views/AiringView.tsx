// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// AiringView — a Library sub-page (below Queue) listing the user's currently
// airing series/anime as Continue-Watching landscape tiles.
//
// "Airing" = the shared `isAiring` rule (meta airingInfo OR cloud next_aired).
// Loading is fast because we pre-filter to a candidate subset from the already
// loaded release signals and only fetch meta for those (progressive, mirroring
// CalendarView). Group-by (Type / Air-window / None) + Sort persist as
// device-local AuraSettings prefs.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import type { AddonEntry, LibraryItem, MetaDetail, MetaPreview } from "../types";
import { loadAuraSettings, saveAuraSettings } from "../auraSettings";
import { resolveDefaultMetaUrl } from "../addonDefaults";
import { getMetaDetail } from "../metaCache";
import { PAGE_CONTENT_MAX_W } from "../pageLayout";
import { LANDSCAPE_CARD_WIDTH } from "../landscapeArt";
import { ContinueWatchingCard } from "../CinemaRows";
import { useEpisodesBehind } from "../LibraryContext";
import { libraryItemSeriesId } from "../libraryNormalize";
import { useReleaseSignalsVersion, hasAnyReleaseSignal } from "../releaseSignalStore";
import { useManualWatchedVersion } from "../manualWatched";
import {
  isAiring, isAiringSeriesLike, isAnimeItem,
  airingNextMs, airingLastAiredMs, airWindow, episodesBehind,
  type AirWindow,
} from "../airing";

interface Props {
  library: LibraryItem[];
  addons: AddonEntry[];
  onSelectMeta: (meta: MetaPreview) => void;
}

type GroupBy = "type" | "airwindow" | "none";
type SortMode = "recent" | "soonest" | "behind" | "alpha";

const GROUP_OPTIONS: { id: GroupBy; label: string }[] = [
  { id: "type",      label: "Series / Anime" },
  { id: "airwindow", label: "Air window" },
  { id: "none",      label: "Flat" },
];
const SORT_OPTIONS: { id: SortMode; label: string }[] = [
  { id: "recent",  label: "Most recently aired" },
  { id: "soonest", label: "Soonest next episode" },
  { id: "behind",  label: "Most episodes behind" },
  { id: "alpha",   label: "A - Z" },
];

const resumeOf = (i: LibraryItem): string | null => {
  const v = (i.state ?? {}).video_id;
  return typeof v === "string" && v.length > 0 ? v : null;
};

export default function AiringView({ library, addons, onSelectMeta }: Props) {
  const [details, setDetails] = useState<Map<string, MetaDetail | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupBy>(() => loadAuraSettings().airingGroupBy);
  const [sort, setSort] = useState<SortMode>(() => loadAuraSettings().airingSort);
  const signalsVersion = useReleaseSignalsVersion();
  const manualVersion = useManualWatchedVersion();

  const metaAddon = useMemo(() => {
    const { defaultMetadataAddonUrl } = loadAuraSettings();
    const override = defaultMetadataAddonUrl && addons.find((a) => a.url === defaultMetadataAddonUrl);
    if (override) return override;
    const defaultUrl = resolveDefaultMetaUrl(addons);
    if (defaultUrl) { const m = addons.find((a) => a.url === defaultUrl); if (m) return m; }
    return addons[0] ?? null;
  }, [addons]);

  // Cheap candidate pre-filter (no network). With cloud signals we trust
  // next_aired; without them (guest / release-search off) we scan every
  // series/anime and confirm via meta below.
  const candidates = useMemo(() => {
    void signalsVersion; // re-derive as signals land
    const seriesLike = library.filter(isAiringSeriesLike);
    return hasAnyReleaseSignal() ? seriesLike.filter((i) => isAiring(i)) : seriesLike;
  }, [library, signalsVersion]);

  // Progressive, soonest-first meta fetch for the candidate subset (mirrors
  // CalendarView: throttled batched flush, concurrency 8) so tiles paint as
  // they resolve and cached hits appear instantly.
  useEffect(() => {
    if (!metaAddon || candidates.length === 0) { setDetails(new Map()); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    const order = [...candidates].sort(
      (a, b) => (airingNextMs(a) ?? Infinity) - (airingNextMs(b) ?? Infinity),
    );
    const acc = new Map<string, MetaDetail | null>();
    let flushTimer: number | null = null;
    const scheduleFlush = () => {
      if (flushTimer != null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        if (!cancelled) setDetails(new Map(acc));
      }, 200);
    };
    (async () => {
      const concurrency = 8;
      let cursor = 0;
      const worker = async () => {
        while (!cancelled) {
          const i = cursor++;
          if (i >= order.length) return;
          const item = order[i];
          const d = await getMetaDetail(metaAddon, item.media_type, item.id).catch(() => null);
          acc.set(item.id, d);
          scheduleFlush();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (!cancelled) {
        if (flushTimer != null) { window.clearTimeout(flushTimer); flushTimer = null; }
        setDetails(new Map(acc));
        setLoading(false);
      }
    })();
    return () => { cancelled = true; if (flushTimer != null) window.clearTimeout(flushTimer); };
  }, [candidates, metaAddon]);

  // Confirm airing: cloud candidates pass immediately (next_aired); fallback-scan
  // candidates only appear once their fetched meta reports airingInfo.isAiring.
  const airingItems = useMemo(
    () => candidates.filter((i) => isAiring(i, details.get(i.id))),
    [candidates, details],
  );

  const now = Date.now();
  const sorted = useMemo(() => {
    void manualVersion; void signalsVersion;
    const arr = [...airingItems];
    const cmp: Record<SortMode, (a: LibraryItem, b: LibraryItem) => number> = {
      alpha:   (a, b) => (a.name ?? "").localeCompare(b.name ?? ""),
      soonest: (a, b) => (airingNextMs(a, details.get(a.id)) ?? Infinity) - (airingNextMs(b, details.get(b.id)) ?? Infinity),
      behind:  (a, b) => (episodesBehind(details.get(b.id)?.videos, resumeOf(b), now) ?? 0) - (episodesBehind(details.get(a.id)?.videos, resumeOf(a), now) ?? 0),
      recent:  (a, b) => (airingLastAiredMs(b, details.get(b.id)) ?? -Infinity) - (airingLastAiredMs(a, details.get(a.id)) ?? -Infinity),
    };
    arr.sort(cmp[sort]);
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [airingItems, sort, details, manualVersion, signalsVersion]);

  const sections = useMemo(() => {
    if (groupBy === "type") {
      const series: LibraryItem[] = [], anime: LibraryItem[] = [];
      for (const i of sorted) (isAnimeItem(i, details.get(i.id)) ? anime : series).push(i);
      return [
        { key: "series", label: "Series", items: series },
        { key: "anime",  label: "Anime",  items: anime },
      ].filter((s) => s.items.length > 0);
    }
    if (groupBy === "airwindow") {
      const b: Record<AirWindow, LibraryItem[]> = { today: [], week: [], later: [], none: [] };
      for (const i of sorted) b[airWindow(airingNextMs(i, details.get(i.id)), now)].push(i);
      return [
        { key: "today", label: "Today",     items: b.today },
        { key: "week",  label: "This week", items: b.week },
        { key: "later", label: "Later",     items: b.later },
        { key: "none",  label: "No date",   items: b.none },
      ].filter((s) => s.items.length > 0);
    }
    return [{ key: "all", label: "", items: sorted }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sorted, groupBy, details]);

  const setGroup = (g: GroupBy) => { setGroupBy(g); saveAuraSettings({ ...loadAuraSettings(), airingGroupBy: g }); };
  const setSortMode = (m: SortMode) => { setSort(m); saveAuraSettings({ ...loadAuraSettings(), airingSort: m }); };

  const total = airingItems.length;
  const signalsOff = !hasAnyReleaseSignal();

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}>
        <div className="mx-auto px-6 py-6 space-y-5" style={{ maxWidth: PAGE_CONTENT_MAX_W }}>
          {/* Header */}
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="aura-row-title text-3xl font-semibold tracking-tight">Airing</h1>
              <p className="text-white/35 text-sm mt-1">
                {loading && total === 0
                  ? "Finding what's currently airing…"
                  : `${total} currently airing series in your library.`}
              </p>
            </div>
            {total > 0 && (
              <div className="flex items-center gap-2 flex-wrap">
                {/* Group-by segmented control */}
                <div className="flex items-center rounded-full bg-white/5 border border-white/10 p-0.5">
                  {GROUP_OPTIONS.map((g) => (
                    <button
                      key={g.id}
                      onClick={() => setGroup(g.id)}
                      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors
                                  ${groupBy === g.id ? "bg-ln-accent/20 text-ln-accent" : "text-white/55 hover:text-white/85"}`}
                    >
                      {g.label}
                    </button>
                  ))}
                </div>
                {/* Sort dropdown */}
                <select
                  value={sort}
                  onChange={(e) => setSortMode(e.target.value as SortMode)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-white/5 border border-white/10
                             text-white/75 hover:text-white/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60"
                  aria-label="Sort airing shows"
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id} className="bg-zinc-900">{o.label}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* Loading bar */}
          {loading && (
            <div className="h-0.5 w-full overflow-hidden rounded-full bg-white/5">
              <div className="h-full w-1/3 bg-ln-accent/70" style={{ animation: "calendar-loading-bar 1.4s ease-in-out infinite" }} />
            </div>
          )}

          {/* Empty state */}
          {!loading && total === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/65 text-sm">
                {signalsOff
                  ? "Sign in to your Stremio account (and keep the shared release feed on in Settings > Scrobbling) so Aura can tell which of your shows are currently airing."
                  : "Nothing in your library is airing right now. Series with an upcoming or recently scheduled episode will show up here."}
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {sections.map((section) => (
                <div key={section.key} className="space-y-3">
                  {section.label && (
                    <h2 className="aura-row-title text-lg font-semibold tracking-tight text-white/85">
                      {section.label}
                      <span className="ml-2 text-white/35 text-xs font-normal tabular-nums">{section.items.length}</span>
                    </h2>
                  )}
                  <div
                    className="grid gap-4"
                    style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${LANDSCAPE_CARD_WIDTH}px, 1fr))` }}
                  >
                    {section.items.map((item) => (
                      <AiringTile
                        key={item.id}
                        item={item}
                        detail={details.get(item.id)}
                        addons={addons}
                        onSelect={onSelectMeta}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One airing show: the CW landscape tile plus a red "N behind" badge when
 *  there are unwatched aired episodes. */
function AiringTile({
  item, detail, addons, onSelect,
}: {
  item: LibraryItem;
  detail: MetaDetail | null | undefined;
  addons: AddonEntry[];
  onSelect: (meta: MetaPreview) => void;
}) {
  const root = libraryItemSeriesId(item.id) || item.id;
  const behind = useEpisodesBehind(detail?.videos, root);
  return (
    <div className="relative">
      <ContinueWatchingCard item={item} onSelect={onSelect} addons={addons} contextSource="library" />
      {behind != null && behind > 0 && (
        <span
          className="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded-md text-[10px] font-bold
                     bg-rose-600/90 text-white border border-rose-300/30 shadow-[0_2px_8px_rgba(0,0,0,0.5)]
                     pointer-events-none"
          title={`${behind} aired episode${behind === 1 ? "" : "s"} unwatched`}
        >
          {behind} behind
        </span>
      )}
    </div>
  );
}
