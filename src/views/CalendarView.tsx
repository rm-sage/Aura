// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { LibraryItem, AddonEntry, MetaDetail, MetaPreview, VideoEntry } from "../types";
import { getMetaDetailFallback } from "../metaCache";
import ImageLoader from "../ImageLoader";
import { shrinkPoster } from "../posterSize";
import { formatEpLabel } from "../episodeLabel";
import { useHoverCardActivation } from "../useHoverCardActivation";
import { closeHoverNow } from "../catalogHoverStore";
import { getReleaseSignal } from "../releaseSignalStore";
import { useWindowHidden } from "../windowVisibility";
import { sheet } from "../glassSheet";

// ---------------------------------------------------------------------------
// CalendarView — full-viewport month grid + day-click overlay
//
// The calendar pulls each library item's full meta detail (concurrency 4) to
// resolve a release date. The grid groups every release into its day cell;
// clicking a cell with releases opens a glass overlay instead of an
// inline breakdown section (which ate vertical space and required scrolling).
//
// Grid rows use `minmax(0, 1fr)` so the 5- or 6-row grid fills all remaining
// height without overflow or wasted space at any viewport height.
//
// "Today" is highlighted with a multi-stop box-shadow built from the Aura
// spectral palette (see `.cal-today` in App.css).
// ---------------------------------------------------------------------------

const DAYS_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Date helpers ---------------------------------------------------------------

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeekMon(d: Date): Date {
  const x = startOfDay(d);
  const dow = x.getDay();              // 0..6, Sunday=0
  const diff = (dow + 6) % 7;          // shift Mon=0
  x.setDate(x.getDate() - diff);
  return x;
}

function startOfMonth(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth() &&
         a.getDate()     === b.getDate();
}

function parseReleaseDate(detail: MetaDetail | null, item: LibraryItem): Date | null {
  const candidates = [
    detail?.released,
    detail?.release_info,
    item.year,
  ].filter((x): x is string => !!x);

  for (const c of candidates) {
    const iso = Date.parse(c);
    if (!isNaN(iso)) return startOfDay(new Date(iso));
    if (/^\d{4}$/.test(c)) return startOfDay(new Date(parseInt(c, 10), 0, 1));
  }
  return null;
}

/** Each episode of a series detail with its local release day, parsed once per
 *  detail object. The progressive load re-buckets the whole library every
 *  200 ms flush, and a long-running series carries 1000+ episodes, so
 *  re-parsing every `released` string on every flush was most of the cost.
 *  Keyed weakly by the detail object (the flushed Maps keep the same objects),
 *  so it is bounded by what the calendar still holds and needs no eviction. */
const episodeDaysCache = new WeakMap<MetaDetail, { video: VideoEntry; day: Date; key: string }[]>();
function episodeDays(detail: MetaDetail): { video: VideoEntry; day: Date; key: string }[] {
  let out = episodeDaysCache.get(detail);
  if (out) return out;
  out = [];
  for (const v of detail.videos ?? []) {
    if (!v.released) continue;
    const ts = Date.parse(v.released);
    if (isNaN(ts)) continue;
    const day = startOfDay(new Date(ts));
    out.push({ video: v, day, key: dateKey(day) });
  }
  episodeDaysCache.set(detail, out);
  return out;
}

const NO_ENTRIES: CalendarEntry[] = [];

/** A day's entries with one per series (a day with 5 episodes of the same
 *  show shows ONE poster), in order. The cell's poster strip and the hover
 *  popout both read it. */
function dedupeBySeries(entries: CalendarEntry[]): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.item.id)) continue;
    seen.add(e.item.id);
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CalendarEntry & view shape
// ---------------------------------------------------------------------------

interface CalendarEntry {
  item: LibraryItem;
  detail: MetaDetail | null;
  /** Per-episode release for series items; null for movies (the whole
   *  movie's release date is the only release). */
  video: VideoEntry | null;
  releaseDate: Date;
}

// ---------------------------------------------------------------------------
// Hover popout: the posters a day cell has no room for
// ---------------------------------------------------------------------------

/** Poster height in the popout (2:3, so 100 px wide), shrunk only when the
 *  window is too short for the rows it needs. */
const POPOUT_POSTER_H = 150;
/** The floor: below it the posters stop shrinking and the popout widens. */
const POPOUT_MIN_POSTER_H = 60;
const POPOUT_PER_ROW = 5;
const POPOUT_GAP = 6;
const POPOUT_PAD = 8;
/** Distance kept from the window edges; the top one clears the title bar. */
const POPOUT_EDGE = 16;
const POPOUT_MIN_TOP = 44;
/** Space between the cell and the popout. */
const POPOUT_OFFSET = 8;

/**
 * The posters past a day cell's two, shown while the cell is hovered.
 *
 * Portalled to body with fixed positioning: inside the cell it was clipped by
 * the page (a top-row cell's popout ran off the window), nested its blur in
 * the cell's own glass blur (a pale rectangle bled around it), and scrolled
 * sideways with no way to reach the scroll bar. Here it wraps into rows, sizes
 * itself to fit the window, and opens above the cell, or below when there is
 * more room there. It never takes the pointer: the cell owns the click.
 */
function HiddenPostersPopout({ anchor, entries }: { anchor: DOMRect; entries: CalendarEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const [shown, setShown] = useState(false);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const n = entries.length;
  const fitW = vw - 2 * POPOUT_EDGE - 2 * POPOUT_PAD;
  // A busy day widens the popout before it shrinks the posters past the
  // floor, and what still does not fit becomes a "+N more" tile: the box
  // always fits between POPOUT_MIN_TOP and the bottom edge (it takes no
  // pointer and has no scroll, so an off-window row could never be reached).
  const maxRows = Math.max(1, Math.floor(
    (vh - POPOUT_MIN_TOP - POPOUT_EDGE - 2 * POPOUT_PAD + POPOUT_GAP) / (POPOUT_MIN_POSTER_H + POPOUT_GAP)));
  const maxCols = Math.max(1, Math.floor(
    (fitW + POPOUT_GAP) / (Math.round(POPOUT_MIN_POSTER_H * 2 / 3) + POPOUT_GAP)));
  const basePerRow = Math.max(1, Math.min(n, POPOUT_PER_ROW,
    Math.floor((fitW + POPOUT_GAP) / (POPOUT_POSTER_H * 2 / 3 + POPOUT_GAP))));
  const perRow = Math.max(1, Math.min(n, Math.max(basePerRow, Math.min(maxCols, Math.ceil(n / maxRows)))));
  const capacity = maxRows * perRow;
  const shownEntries = n > capacity ? entries.slice(0, Math.max(0, capacity - 1)) : entries;
  const moreCount = n - shownEntries.length;
  const slots = shownEntries.length + (moreCount > 0 ? 1 : 0);
  const rowCount = Math.max(1, Math.ceil(slots / perRow));
  const fitH = vh - POPOUT_MIN_TOP - POPOUT_EDGE - 2 * POPOUT_PAD - (rowCount - 1) * POPOUT_GAP;
  // Width bound too: a widened row must still fit the window.
  const maxHByW = Math.floor(((fitW - (perRow - 1) * POPOUT_GAP) / perRow) * 3 / 2);
  const posterH = Math.max(POPOUT_MIN_POSTER_H,
    Math.min(POPOUT_POSTER_H, Math.floor(fitH / rowCount), maxHByW));
  const posterW = Math.round(posterH * 2 / 3);
  const innerW = perRow * posterW + (perRow - 1) * POPOUT_GAP;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(
      Math.max(anchor.left + anchor.width / 2 - w / 2, POPOUT_EDGE),
      vw - POPOUT_EDGE - w,
    );
    const roomAbove = anchor.top - POPOUT_OFFSET - POPOUT_MIN_TOP;
    const roomBelow = vh - POPOUT_EDGE - anchor.bottom - POPOUT_OFFSET;
    const below = roomAbove < h && roomBelow > roomAbove;
    const wanted = below ? anchor.bottom + POPOUT_OFFSET : anchor.top - POPOUT_OFFSET - h;
    const top = Math.min(Math.max(wanted, POPOUT_MIN_TOP), vh - POPOUT_EDGE - h);
    setPos({ left, top, below });
  }, [anchor, vw, vh, innerW, posterH, rowCount]);

  // One frame at the start state, so the entry transition runs.
  useEffect(() => {
    if (!pos) return;
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  return createPortal(
    <div
      ref={ref}
      aria-hidden
      // The tooltip tier (aura-glass-tip): a pointer-events-none hover popout,
      // never refracted, so it costs one plain blur.
      className="aura-float-glass aura-glass-tip fixed z-[60] rounded-xl pointer-events-none
                 transition-[opacity,transform] duration-200 ease-out"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        padding: POPOUT_PAD,
        visibility: pos ? "visible" : "hidden",
        opacity: shown ? 1 : 0,
        transform: shown ? "none" : `translateY(${pos?.below ? -6 : 6}px) scale(0.96)`,
        transformOrigin: pos?.below ? "top center" : "bottom center",
      }}
    >
      <div className="flex flex-wrap" style={{ width: innerW, gap: POPOUT_GAP }}>
        {shownEntries.map(({ item, detail, video }) => {
          const src = detail?.poster ?? item.poster;
          const epLabel =
            video && video.season != null && video.episode != null
              ? formatEpLabel(video.season, video.episode)
              : null;
          return (
            <div
              key={item.id}
              className="relative flex-shrink-0 rounded-md overflow-hidden bg-white/5 border border-white/10"
              style={{ width: posterW, height: posterH }}
            >
              {src ? (
                <ImageLoader
                  src={src}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 w-full h-full"
                  imgClassName="w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center text-white/20 text-[10px]">
                  ?
                </div>
              )}
              {epLabel && (
                <span
                  className="absolute top-1 left-1 text-[9px] leading-none font-mono font-semibold
                             text-white/95 px-1 py-0.5 rounded bg-black/85 border border-white/15"
                >
                  {epLabel}
                </span>
              )}
            </div>
          );
        })}
        {moreCount > 0 && (
          <div
            className="relative flex-shrink-0 rounded-md bg-white/5 border border-white/10
                       flex items-center justify-center text-white/75 text-[11px] font-mono font-semibold"
            style={{ width: posterW, height: posterH }}
          >
            +{moreCount}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

interface Props {
  library: LibraryItem[];
  addons: AddonEntry[];
  /** Click handler — opens the DetailView for the selected entry. */
  onSelectMeta?: (meta: MetaPreview) => void;
}

function libraryItemToMeta(item: LibraryItem, detail: MetaDetail | null): MetaPreview {
  return {
    id:           item.id,
    name:         detail?.name ?? item.name,
    media_type:   detail?.media_type ?? item.media_type,
    poster:       detail?.poster ?? item.poster,
    background:   detail?.background ?? item.background,
    fanart:       null,
    backdrop:     null,
    logo:         detail?.logo ?? item.logo,
    release_info: detail?.release_info ?? item.year,
    description:  detail?.description ?? null,
    imdb_rating:  detail?.imdb_rating ?? null,
    genres:       detail?.genres ?? [],
  };
}

// ---------------------------------------------------------------------------
// PosterShimmer — animated skeleton shown while metadata is loading
// ---------------------------------------------------------------------------

function PosterShimmer() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 rounded-md image-loader-skeleton"
    />
  );
}

// ---------------------------------------------------------------------------
// CalendarView
// ---------------------------------------------------------------------------

// CalendarView routes meta fetches through the shared `metaCache.ts`
// module — same persistent 4h-for-episodic / 7d-for-movie TTL the
// HomeView, DetailView, and NotificationsScanner use. Previously this
// file maintained its OWN parallel `calendarMetaCache` Map that
// bypassed the persistent cache, so a fresh app start always paid
// 100+ HTTP round-trips to fill the calendar even though the meta
// was already on disk from a prior session. The shared cache also
// dedupes concurrent calls (`dedupedInvoke`) so two views asking
// for the same item at the same time fire one network request.

export default function CalendarView({ library, addons, onSelectMeta }: Props) {
  const [details, setDetails] = useState<Map<string, MetaDetail | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(new Date()));
  // The day cell whose extra posters show in the hover popout, with its rect.
  // Its posters are read from the current buckets at render, never captured
  // at mouseenter: the progressive load keeps adding to a hovered day.
  const [popout, setPopout] = useState<{ key: string; anchor: DOMRect } | null>(null);
  // Changing month unmounts the hovered cell without a mouseleave.
  useEffect(() => { setPopout(null); }, [monthAnchor]);
  // overlayDate drives the day-click modal; null = closed.
  const [overlayDate, setOverlayDate] = useState<Date | null>(null);

  // Fetch detail for every library item via the shared metaCache. Two things
  // keep this responsive even on a cold-ish cache (episodic meta has a 4 h TTL,
  // so the calendar re-fetches series meta a few times a day):
  //
  //   • PROGRESSIVE render — results flush to state in throttled batches as
  //     they resolve, so cached items (which return instantly) paint right away
  //     instead of being held hostage by the slowest network miss. The grid
  //     fills in rather than staying blank for the whole 100+-item load.
  //   • PRIORITISED order — items the release-signal store flags as airing /
  //     recently aired (episodes near "now", i.e. the visible window) are
  //     fetched FIRST, so the current month populates before older / ended
  //     shows and movies stream in behind it. Falls back to library order when
  //     no signal is present (release-search off, guest, or not yet reconciled).
  //
  // Each item is resolved over the elected meta providers for ITS id
  // (getMetaDetailFallback -> electMetaAddons, the same election DetailView
  // makes), with fallback down the list. `keepThin` keeps a series answer
  // that has no episodes yet rather than dropping it, because the movie-style
  // bucket below still reads its `released` date. `details` stays keyed by
  // item id whichever addon answered.
  useEffect(() => {
    if (addons.length === 0 || library.length === 0) {
      setDetails(new Map());
      // A run this one superseded never reaches its own setLoading(false).
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    // Fetch order: airing-soon / recently-aired first, then everything else in
    // stable library order. Cheap — release signals are already in memory.
    const NEAR_MS = 60 * DAYS_MS;
    const now = Date.now();
    const priority = (item: LibraryItem): number => {
      const sig = getReleaseSignal(item.id);
      if (!sig) return 0;
      const next = sig.next_aired?.aired_at ? Date.parse(sig.next_aired.aired_at) : NaN;
      const last = sig.last_aired?.aired_at ? Date.parse(sig.last_aired.aired_at) : NaN;
      let score = 0;
      if (Number.isFinite(next) && Math.abs(next - now) <= NEAR_MS) score += 2;
      if (Number.isFinite(last) && now - last <= NEAR_MS) score += 1;
      return score;
    };
    const order = library
      .map((item, i) => ({ item, i, p: priority(item) }))
      .sort((a, b) => (b.p - a.p) || (a.i - b.i))
      .map((e) => e.item);

    // Throttled flush so cached-item bursts and slow misses both paint
    // progressively without one setState per item (~150 re-renders).
    // Partial flushes MERGE over what is shown: a library refresh (the focus
    // refetch) re-runs this scan, and replacing with the partial map would
    // blank every item not yet re-resolved until the scan finished. The final
    // write below rebuilds from this run, which prunes items that left the
    // library. Neither lets a null from THIS run replace a detail already
    // shown: null is a failed refetch (offline, an addon timeout or rate
    // limit once the 4 h meta TTL has passed), and taking it dropped that
    // series' releases off the grid until a later run succeeded.
    const acc = new Map<string, MetaDetail | null>();
    let flushTimer: number | null = null;
    const scheduleFlush = () => {
      if (flushTimer != null) return;
      flushTimer = window.setTimeout(() => {
        flushTimer = null;
        if (cancelled) return;
        setDetails((prev) => {
          const next = new Map(prev);
          for (const [k, v] of acc) next.set(k, v ?? prev.get(k) ?? null);
          return next;
        });
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
          // metaCache handles cache + dedupe + null-on-error.
          const d = await getMetaDetailFallback(addons, item.media_type, item.id, { keepThin: true })
            .catch(() => null);
          acc.set(item.id, d);
          scheduleFlush();
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (!cancelled) {
        if (flushTimer != null) { window.clearTimeout(flushTimer); flushTimer = null; }
        setDetails((prev) => {
          const next = new Map<string, MetaDetail | null>();
          for (const [k, v] of acc) next.set(k, v ?? prev.get(k) ?? null);
          return next;
        });
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (flushTimer != null) window.clearTimeout(flushTimer);
    };
  }, [library, addons]);

  // Build a date-keyed bucket of entries across the entire library.
  //
  // For SERIES items: walk detail.videos and bucket each episode by its
  //   own `released` date. That's how Stremio's calendar populates the
  //   future grid — each upcoming episode shows on its airdate.
  // For MOVIES: bucket by the single release_info / year fallback.
  // Items without any release date skip silently.
  const entriesByDate = useMemo(() => {
    const buckets = new Map<string, CalendarEntry[]>();
    const isEpisodicType = (t: string) =>
      ["series", "anime"].includes((t ?? "").toLowerCase());

    for (const item of library) {
      const detail = details.get(item.id) ?? null;
      const episodic = isEpisodicType(item.media_type);

      if (episodic && detail?.videos?.length) {
        for (const { video, day, key } of episodeDays(detail)) {
          const list = buckets.get(key) ?? [];
          list.push({ item, detail, video, releaseDate: day });
          buckets.set(key, list);
        }
        continue;
      }

      // Movie / non-episodic — single bucket from the meta-level date.
      const release = parseReleaseDate(detail, item);
      if (!release) continue;
      const key = dateKey(release);
      const list = buckets.get(key) ?? [];
      list.push({ item, detail, video: null, releaseDate: release });
      buckets.set(key, list);
    }
    return buckets;
  }, [library, details]);

  // Build the visible grid for the current month (Mon-anchored).
  // Default to 5 rows; expand to 6 only when the month genuinely needs
  // it (e.g. Aug 2026 — Aug 1 is a Saturday + 31 days). This keeps the
  // common case denser without ever clipping the tail of the month.
  const { monthCells, rows } = useMemo(() => {
    const gridStart = startOfWeekMon(monthAnchor);
    const monthEnd = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0);
    // Rounded, not floored: both ends are local midnights, so across a DST
    // change the gap is a whole number of days plus or minus an hour, and a
    // floor on the 23-hour side counts one day short (which could cut a row).
    const daysSpanned = Math.round((monthEnd.getTime() - gridStart.getTime()) / DAYS_MS) + 1;
    const weeksNeeded = Math.ceil(daysSpanned / 7);
    const r = Math.max(5, weeksNeeded);
    const totalCells = r * 7;
    const cells: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < totalCells; i++) {
      // Built from date PARTS, never `gridStart + i * DAYS_MS`: a DST day is 23
      // or 25 hours long, so on the 25-hour day the millisecond step landed at
      // 23:00 of the SAME date. That showed Sunday Nov 1 2026 twice and left
      // every later cell (and the releases keyed to it) one day behind.
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      cells.push({ date: d, inMonth: d.getMonth() === monthAnchor.getMonth() });
    }
    return { monthCells: cells, rows: r };
  }, [monthAnchor]);

  // "Today" must not be frozen at mount. The Calendar can sit open across local
  // midnight, which left the loud `.cal-today` ring on YESTERDAY's cell until
  // the user navigated away and back (App only mounts this view while the tab is
  // active, so a tab switch was the only thing that refreshed it).
  //
  // A self-rescheduling timeout wakes exactly once per day boundary instead of
  // polling, and re-snapping on the hidden -> visible transition covers a
  // machine that slept through midnight with its timers throttled. Setting the
  // state to an unchanged value is a React no-op, so neither path costs a
  // render on an ordinary day.
  const hidden = useWindowHidden();
  const [todayMs, setTodayMs] = useState(() => startOfDay(new Date()).getTime());
  useEffect(() => {
    setTodayMs(startOfDay(new Date()).getTime());
    let timer = 0;
    const arm = () => {
      const n = new Date();
      // Built from date PARTS rather than `startOfDay + DAYS_MS`, so the 23- and
      // 25-hour days at a DST transition still land on the real local midnight.
      const nextMidnight = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).getTime();
      timer = window.setTimeout(() => {
        setTodayMs(startOfDay(new Date()).getTime());
        arm();
      }, Math.max(1_000, nextMidnight - Date.now()));
    };
    arm();
    return () => window.clearTimeout(timer);
  }, [hidden]);
  const today = useMemo(() => new Date(todayMs), [todayMs]);

  const monthLabel = monthAnchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const goPrev  = () => setMonthAnchor((d) => addMonths(d, -1));
  const goNext  = () => setMonthAnchor((d) => addMonths(d, 1));
  const goToday = () => setMonthAnchor(startOfMonth(startOfDay(new Date())));

  const overlayEntries = overlayDate ? (entriesByDate.get(dateKey(overlayDate)) ?? []) : [];
  const totalEntries = useMemo(
    () => [...entriesByDate.values()].reduce((s, l) => s + l.length, 0),
    [entriesByDate],
  );

  // The hovered day's posters past the first two, from the CURRENT buckets.
  const popoutKey = popout?.key ?? null;
  const popoutEntries = useMemo(
    () => (popoutKey ? dedupeBySeries(entriesByDate.get(popoutKey) ?? NO_ENTRIES).slice(2) : NO_ENTRIES),
    [popoutKey, entriesByDate],
  );

  // Stable cell callbacks, so a hover (which sets `popout` and re-renders this
  // view) re-renders only the popout, not all 35 to 42 memoized day cells.
  const openDay = useCallback((date: Date) => {
    setPopout(null);
    setOverlayDate(date);
  }, []);
  const showHidden = useCallback((key: string, anchor: DOMRect) => {
    setPopout({ key, anchor });
  }, []);
  const hideHidden = useCallback((key: string) => {
    setPopout((p) => (p?.key === key ? null : p));
  }, []);

  return (
    // flex-1 + flex-col + min-h-0: fills the parent flex slot (App's main
    // content area) without overflowing. min-h-0 is required so the inner
    // flex children can shrink below their intrinsic content height.
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      {/* Scrollable page chrome — header, month label, empty states */}
      <div
        className="mx-auto w-full px-6 pt-6 pb-3 shrink-0"
        style={{ maxWidth: "min(2200px, 96%)" }}
      >
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-4">
          <div>
            <h1 data-glass-light="text" className="aura-row-title text-3xl font-semibold tracking-tight">Release Calendar</h1>
            <p className="text-white/55 text-sm mt-1">
              Releases for items in your library.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={goPrev}
              aria-label="Previous month"
              className="aura-glass-flat w-9 h-9 rounded-full flex items-center justify-center
                         text-white/70 hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
              </svg>
            </button>
            <button
              onClick={goToday}
              className="aura-glass-flat px-3 h-9 rounded-full text-xs font-medium
                         text-white/70 hover:text-white"
            >
              Today
            </button>
            <button
              onClick={goNext}
              aria-label="Next month"
              className="aura-glass-flat w-9 h-9 rounded-full flex items-center justify-center
                         text-white/70 hover:text-white"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
              </svg>
            </button>
          </div>
        </div>

        {/* Month label */}
        <div className="flex items-baseline gap-3 mb-3">
          <h2 className="text-white/80 text-2xl font-light tracking-wide">{monthLabel}</h2>
          <span className="text-white/55 text-xs">
            {entriesByDate.size === 0
              ? "No releases tracked"
              : `${totalEntries} total in library`}
          </span>
        </div>

        {/* Empty/empty-addon states */}
        {addons.length === 0 && (
          <div {...sheet("rounded-[20px] px-5 py-4 mb-3")}>
            <p className="text-white/65 text-sm">
              Add an addon (in the Addons tab) to populate the calendar.
            </p>
          </div>
        )}
        {addons.length > 0 && library.length === 0 && !loading && (
          <div {...sheet("rounded-[20px] px-5 py-4 mb-3")}>
            <p className="text-white/65 text-sm">
              Your library is empty. Items you save show up here when their
              release date falls in view.
            </p>
          </div>
        )}

        {/* Indeterminate loading bar — visible while meta fetches are in-flight.
            Sits just above the weekday header so it reads as page-level progress
            rather than belonging to any individual cell. */}
        {loading && (
          <div className="relative h-[3px] w-full rounded-full bg-white/5 overflow-hidden mb-2">
            <div
              className="absolute top-0 left-0 h-full w-1/3 rounded-full bg-[var(--ln-accent-mark)]"
              style={{ animation: "calendar-loading-bar 1.4s ease-in-out infinite" }}
            />
          </div>
        )}

        {/* Weekday header */}
        <div className="grid grid-cols-7 gap-2 px-1 mb-2">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="text-white/55 text-[10px] font-semibold tracking-[0.18em] uppercase text-center">
              {d}
            </div>
          ))}
        </div>
      </div>

      {/* Month grid — flex-1 + min-h-0 fills all remaining vertical space.
          gridTemplateRows uses 1fr per row so cells grow/shrink with the
          viewport height rather than being fixed at 175 px. */}
      <div
        className="flex-1 min-h-0 mx-auto w-full px-6 pb-4"
        style={{ maxWidth: "min(2200px, 96%)" }}
      >
        <div
          key={monthAnchor.getMonth()}
          className="aura-cal-grid grid grid-cols-7 gap-2 h-full"
          style={{
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            gridAutoRows: "minmax(0, 1fr)",
          }}
        >
          {monthCells.map(({ date, inMonth }) => {
            const key = dateKey(date);
            return (
              <CalendarDayCell
                key={key}
                dayKey={key}
                date={date}
                inMonth={inMonth}
                entries={entriesByDate.get(key) ?? NO_ENTRIES}
                isToday={isSameDay(date, today)}
                loading={loading}
                onOpen={openDay}
                onShowHidden={showHidden}
                onHideHidden={hideHidden}
              />
            );
          })}
        </div>
      </div>

      {popout && !overlayDate && popoutEntries.length > 0 && (
        <HiddenPostersPopout key={popout.key} anchor={popout.anchor} entries={popoutEntries} />
      )}

      {/* Day overlay — mounted only when a cell with releases is clicked */}
      {overlayDate && (
        <DayOverlay
          date={overlayDate}
          entries={overlayEntries}
          onClose={() => setOverlayDate(null)}
          onSelectMeta={onSelectMeta}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalendarDayCell: one day of the month grid. Memoized: hovering a busy day
// sets the popout state in CalendarView, which used to re-render (and
// re-dedupe) every cell of the month on each cell the pointer crossed.
// ---------------------------------------------------------------------------

const CalendarDayCell = memo(function CalendarDayCell({
  dayKey: key, date, inMonth, entries, isToday, loading, onOpen, onShowHidden, onHideHidden,
}: {
  dayKey: string;
  date: Date;
  inMonth: boolean;
  entries: CalendarEntry[];
  isToday: boolean;
  loading: boolean;
  onOpen: (date: Date) => void;
  onShowHidden: (key: string, anchor: DOMRect) => void;
  onHideHidden: (key: string) => void;
}) {
  const dim = !inMonth;

  // Dedup posters by series id; cap at 2 visible posters (cleaner at cell
  // sizes than 3).
  const allDedupedEntries = dedupeBySeries(entries);
  const totalDeduped = allDedupedEntries.length;
  const visiblePosters = allDedupedEntries.slice(0, 2);
  const hiddenCount = totalDeduped - visiblePosters.length;

  const CellTag = entries.length > 0 ? "button" : "div";
  return (
    // The posters past the first two show in HiddenPostersPopout,
    // portalled to body, while the cell is hovered. onMouseLeave is set
    // always, not only while there are hidden posters: a hovered cell whose
    // count drops to 0 (or that turns from button to div, a remount) must
    // still close its popout when the pointer leaves.
    <CellTag
      {...(entries.length > 0
        ? { onClick: () => onOpen(date) }
        : {})}
      {...(hiddenCount > 0
        ? {
            onMouseEnter: (e: ReactMouseEvent<HTMLElement>) =>
              onShowHidden(key, e.currentTarget.getBoundingClientRect()),
          }
        : {})}
      onMouseLeave={() => onHideHidden(key)}
      {...sheet(`is-cell group relative rounded-[14px] p-2 text-left
                  flex flex-col
                  ${dim ? "is-dim" : ""}
                  ${entries.length > 0 ? "is-live cursor-pointer" : "cursor-default"}
                  ${isToday ? "is-today" : ""}`)}
    >
      {/* Date number + optional overflow badge */}
      <div className="flex items-start justify-between">
        <span
          className={`leading-none ${isToday
            ? "aura-cal-today-num inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 -ml-0.5 -mt-0.5 rounded-full text-sm font-bold"
            : dim
              ? "text-white/55 text-sm font-medium"
              : "text-white/75 text-sm font-medium"
          }`}
        >
          {date.getDate()}
        </span>
        {/* Badge: only shown when there are hidden posters */}
        {hiddenCount > 0 && (
          <span className="aura-mark-chip text-[11px] font-mono font-semibold tracking-wide px-2 py-0.5">
            +{hiddenCount}
          </span>
        )}
      </div>


      {/* Visible poster strip: max 2 posters per cell */}
      {visiblePosters.length > 0 && (
        // Posters share the remaining cell height equally; height
        // is driven by the 1fr row, not a fixed minHeight. The
        // 2:3 aspect ratio derives width from height automatically.
        <div className="mt-2 flex-1 min-h-0 flex items-end justify-center gap-1.5">
          {visiblePosters.map(({ item, detail, video }) => {
            const src = detail?.poster ?? item.poster;
            const epLabel =
              video && video.season != null && video.episode != null
                ? formatEpLabel(video.season, video.episode)
                : null;
            return (
              <div
                key={item.id}
                className="relative h-full rounded-md overflow-hidden bg-white/5"
                style={{ aspectRatio: "2 / 3" }}
                title={detail?.name ?? item.name}
              >
                {src ? (
                  <ImageLoader
                    src={src}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 w-full h-full"
                    imgClassName="w-full h-full object-cover"
                  />
                ) : loading ? (
                  <PosterShimmer />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center
                                  text-white/20 text-[10px]">
                    ?
                  </div>
                )}
                {epLabel && (
                  // Top-LEFT to match the DayOverlay badge and to
                  // stay clear of addon-baked HDR/DV/language badges
                  // that sit in the poster's top-right art.
                  <span
                    className="absolute top-1 left-1 text-[9px] leading-none
                               font-mono font-semibold text-white/95
                               px-1 py-0.5 rounded bg-black/85
                               border border-white/15"
                  >
                    {epLabel}
                  </span>
                )}
                <span aria-hidden className="aura-card-bezel" data-glass-light="rim" />
              </div>
            );
          })}
        </div>
      )}
    </CellTag>
  );
});

// ---------------------------------------------------------------------------
// DayOverlay — modal that appears when the user clicks a calendar cell.
//
// Animation mirrors DetailView's `opening` pattern: two rAF ticks after mount
// flip `opening` to false, which transitions opacity 0→1 and scale 0.92→1.
// Backdrop fades 60 ms before the card via a CSS delay on the card transform.
// ---------------------------------------------------------------------------

interface DayOverlayProps {
  date: Date;
  entries: CalendarEntry[];
  onClose: () => void;
  onSelectMeta?: (meta: MetaPreview) => void;
}

function DayOverlay({ date, entries, onClose, onSelectMeta }: DayOverlayProps) {
  const [opening, setOpening] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);

  // Two rAF ticks = one painted frame; after that the browser has committed
  // the initial opacity:0/scale:0.92 state, so the transition fires visibly.
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setOpening(false))
    );
    return () => cancelAnimationFrame(id);
  }, []);

  // ESC closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const releaseCount = entries.length;

  return (
    // Backdrop — fixed full-viewport, sits above the calendar (z-55) but
    // below PlayerOverlay (z-60+). Fades in immediately on mount.
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-6"
      onClick={onClose}
    >
      {/* The dim + blur is a SIBLING of the card, never its wrapper: a
          backdrop-filter on an ancestor is a Backdrop Root, so the card's own
          glass would blur only this black scrim. Clicks on it still bubble to
          the wrapper's onClose. */}
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          backgroundColor: opening ? "transparent" : "rgba(0,0,0,0.80)",
          backdropFilter: opening ? "blur(0px)" : "blur(8px)",
          transition: "background-color 200ms ease, backdrop-filter 200ms ease",
        }}
      />
      {/* Modal card: click-through stops propagation to backdrop */}
      <div
        ref={cardRef}
        className="aura-float-glass relative rounded-2xl flex flex-col overflow-hidden"
        style={{
          width: "min(1100px, 92vw)",
          maxHeight: "88vh",
          opacity: opening ? 0 : 1,
          transform: opening ? "scale(0.92)" : "scale(1)",
          // 60 ms delay staggers the card entry slightly after the backdrop
          transition: "opacity 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 shrink-0
                        border-b border-white/8">
          <div>
            <h2 className="text-white/90 text-lg font-semibold tracking-tight">{dateLabel}</h2>
            <p className="text-white/60 text-sm mt-0.5">
              {releaseCount === 1 ? "1 release" : `${releaseCount} releases`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="aura-glass-flat w-8 h-8 rounded-full flex items-center justify-center
                       text-white/50 hover:text-white shrink-0 mt-0.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {/* Card grid — scrollable */}
        <div
          className="aura-page-scroller overflow-y-auto p-6"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {entries.map(({ item, detail, video, releaseDate }, idx) => {
              const meta = libraryItemToMeta(item, detail);
              return (
              <CalendarCard
                key={`${item.id}:${video?.id ?? idx}`}
                meta={meta}
                name={detail?.name ?? item.name}
                poster={detail?.poster ?? item.poster}
                mediaType={detail?.media_type ?? item.media_type}
                episodeTag={video && video.season != null && video.episode != null
                  ? formatEpLabel(video.season, video.episode)
                  : null}
                episodeTitle={video?.title ?? null}
                released={releaseDate}
                onClick={onSelectMeta ? () => { closeHoverNow(); onClose(); onSelectMeta(meta); } : undefined}
                onContextMenu={(e) => {
                  // Right-click → fire the same `aura:card-context`
                  // event the rest of the app's cards use. The App-
                  // level listener resolves the meta to a context menu
                  // (Mark watched, Add/Remove from library, Open in…
                  // etc.) anchored at the cursor coords. The overlay
                  // stays open so the user can keep exploring after
                  // making a context-menu choice.
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("aura:card-context", {
                    detail: {
                      meta,
                      x: e.clientX,
                      y: e.clientY,
                      source: "calendar",
                      item,
                    },
                  }));
                }}
              />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalendarCard — poster-art tile used both in DayOverlay.
// ---------------------------------------------------------------------------

function CalendarCard({
  meta, name, poster, mediaType, episodeTag, episodeTitle, released, onClick, onContextMenu,
}: {
  /** Catalog meta for the shared mini-meta hover/bind panel. */
  meta: MetaPreview;
  name: string;
  poster: string | null;
  mediaType: string;
  /** "S01E05"-style label when the card is for a series episode. */
  episodeTag: string | null;
  /** Episode-specific title; rendered under the series name. */
  episodeTitle: string | null;
  released: Date;
  /** Right-click handler — fires the `aura:card-context` event the
   *  shared App-level listener uses to render context menus on cards
   *  app-wide. Optional so non-interactive use sites stay clean. */
  onContextMenu?: (e: ReactMouseEvent<HTMLElement>) => void;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  const hover = useHoverCardActivation(meta);
  const dateLabel = released.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
  });
  return (
    <Tag
      onClick={onClick}
      onContextMenu={onContextMenu}
      {...hover}
      data-meta-card={`${mediaType}:${meta.id}`}
      className={`aura-content-card group rounded-[12px] p-2.5 flex flex-col gap-2 text-left w-full
                  ${onClick ? "is-live cursor-pointer" : ""}`}
    >
      <div
        className="relative w-full rounded-md overflow-hidden bg-white/5"
        style={{ aspectRatio: "2 / 3" }}
      >
        {poster ? (
          <ImageLoader
            src={shrinkPoster(poster)}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/20 text-xs">
            No art
          </div>
        )}
        {episodeTag && (
          // Top-LEFT to keep clear of the AIOMetadata-baked badges
          // (HDR / language flag / DV) that sit in the top-right of the
          // poster art.
          <span className="absolute top-1.5 left-1.5 text-[13px] font-mono font-semibold
                           text-white/95 px-2 py-1 rounded
                           bg-black/85 border border-white/15">
            {episodeTag}
          </span>
        )}
        <span aria-hidden className="aura-card-bezel" data-glass-light="rim" />
      </div>
      <div className="min-w-0">
        <p className="aura-poster-title text-white/95 text-sm font-semibold leading-tight line-clamp-2">{name}</p>
        {episodeTitle && (
          <p className="text-white/70 text-[12.5px] mt-0.5 line-clamp-1">{episodeTitle}</p>
        )}
        <p className="text-white/60 text-[11px] mt-0.5 font-mono">
          {mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} · {dateLabel}
        </p>
      </div>
    </Tag>
  );
}
