// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { HistoryEntry } from "./historyStore";
import type { MediaKinds, MediaTypeFilter } from "./mediaTypePills";

// ---------------------------------------------------------------------------
// historyIndex - the History page's data model, kept free of React and of any
// module with side effects so a node script can load it and time it over
// synthetic histories far past the store's cap.
//
// WHY IT EXISTS. The page used to derive everything per render and per row:
// a `toLocaleTimeString` / `toLocaleDateString` call per card (each of those
// builds a fresh ICU formatter: 650 of them measured 33 ms in node against
// 1 ms through one cached Intl.DateTimeFormat), and then mounted EVERY card,
// each with its own image observer, shimmer skeleton and ~25 DOM nodes. Now
// ONE pass over the entries builds the index below, filters read precomputed
// fields, and `buildLayout` turns the filtered list into fixed-height items
// that the view windows, so only the rows near the viewport ever mount.
//
// Three stages, each memoised on its own inputs by the view:
//   1. buildHistoryIndex(entries)   - on a history change only
//   2. filterHistory(index, ...)     - on a search / title / type change
//   3. buildLayout(filtered, cols)   - on a filter or column-count change
// Scrolling touches none of them: it only binary-searches `tops`.
// ---------------------------------------------------------------------------

/** Selection / dedup primary key for one play. Mirrors the history store's
 *  own (id, played_at) key, so a re-watch is a distinct row. */
export const keyOf = (e: HistoryEntry) => `${e.id}::${e.played_at}`;

/** The title a play belongs to: the series root for an episode, the item
 *  itself for a movie. What "show every play of this title" filters on. */
export const titleKeyOf = (e: HistoryEntry) => e.parent_id ?? e.id;

export interface IndexedEntry {
  entry: HistoryEntry;
  key: string;
  /** Local calendar day, YYYY-MM-DD (sorts lexically = chronologically). */
  dayKey: string;
  ts: number;
  titleKey: string;
  /** Precomputed matcher text: name, episode title and SxxEyy, normalised
   *  once here instead of on every keystroke for every row. */
  search: string;
  kinds: MediaKinds;
}

export interface TitleInfo {
  name: string;
  count: number;
}

export interface HistoryIndex {
  /** Newest first. */
  items: IndexedEntry[];
  titles: Map<string, TitleInfo>;
}

/** Local-time YYYY-MM-DD for a timestamp. */
export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  return dayKeyOfDate(d);
}

export function dayKeyOfDate(d: Date): string {
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? "0" : ""}${m}-${day < 10 ? "0" : ""}${day}`;
}

/** SxxEyy / EPxx, or null for a movie. Shared with the card so the label a
 *  user reads is exactly the one the search matches. */
export function episodeLabel(e: HistoryEntry): string | null {
  if (e.season != null && e.episode != null) {
    return `S${String(e.season).padStart(2, "0")}E${String(e.episode).padStart(2, "0")}`;
  }
  if (e.episode != null) return `EP${String(e.episode).padStart(2, "0")}`;
  return null;
}

// ---------------------------------------------------------------------------
// Matching. The SAME rules as ListSearchInput's `looseMatch` (lowercase, drop
// Latin diacritics, every run of anything but letters, numbers and other marks
// is one separator, then token-AND with a de-spaced contiguous fallback), split
// so the text side is normalised once per entry. `looseMatch` normalises both
// sides on every call, which over a 10,000-row history is a full
// re-normalisation of the whole log per keystroke. Keep the two in step: a rule
// changed there must change here, or History and Library would disagree about
// what a query matches.
//
// Marks outside U+0300-U+036F stay: NFD splits a voiced kana or an Indic vowel
// sign off its base, and as separators they cut a title into fragments that
// match unrelated titles (ガンダム into カ / ンタ / ム).
// ---------------------------------------------------------------------------

const KEEP_NON_ASCII = /[\p{L}\p{N}\p{M}]/u;

export function normalizeForMatch(s: string): string {
  const decomposed = s.toLowerCase().normalize("NFD");
  let out = "";
  for (const ch of decomposed) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x300 && c <= 0x36f) continue;
    const keep = (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)
      || (c >= 0x80 && KEEP_NON_ASCII.test(ch));
    out += keep ? ch : " ";
  }
  return out.replace(/ +/g, " ").trim();
}

export interface PreparedQuery {
  tokens: string[];
  compact: string;
}

/** Null when the query has nothing to match on: empty, or only punctuation.
 *  `filterHistory` tells those two apart. */
export function prepareQuery(query: string): PreparedQuery | null {
  const q = normalizeForMatch(query);
  if (!q) return null;
  return { tokens: q.split(" "), compact: q.replace(/ /g, "") };
}

export function matchesPrepared(q: PreparedQuery, normalizedText: string): boolean {
  if (!normalizedText) return false;
  let all = true;
  for (const tok of q.tokens) {
    if (!normalizedText.includes(tok)) { all = false; break; }
  }
  if (all) return true;
  return normalizedText.replace(/ /g, "").includes(q.compact);
}

// ---------------------------------------------------------------------------
// Stage 1: the index.
// ---------------------------------------------------------------------------

/** `classify` is injected (the view passes classifyMediaKinds) so this module
 *  stays loadable without the app's localStorage-backed anime cache. It is
 *  called once per TITLE, not per play: every play of a show classifies the
 *  same way. */
export function buildHistoryIndex(
  entries: readonly HistoryEntry[],
  classify: (mediaType: string, titleId: string) => MediaKinds,
): HistoryIndex {
  const items: IndexedEntry[] = [];
  const titles = new Map<string, TitleInfo>();
  const kindsByTitle = new Map<string, MediaKinds>();
  // Normalised name per title: a show's name repeats on every one of its
  // plays, so it is normalised once.
  const nameNorm = new Map<string, string>();
  for (const entry of entries) {
    const ts = Date.parse(entry.played_at);
    if (Number.isNaN(ts)) continue;
    const titleKey = titleKeyOf(entry);
    let kinds = kindsByTitle.get(titleKey);
    if (!kinds) {
      kinds = classify(entry.media_type ?? "", titleKey);
      kindsByTitle.set(titleKey, kinds);
    }
    const t = titles.get(titleKey);
    if (t) t.count++;
    // The NEWEST play's name labels the title (entries arrive newest first),
    // so a show renamed by its addon reads as it does today.
    else titles.set(titleKey, { name: entry.name, count: 1 });
    const nameKey = `${titleKey}\u0000${entry.name}`;
    let nn = nameNorm.get(nameKey);
    if (nn === undefined) {
      nn = normalizeForMatch(entry.name ?? "");
      nameNorm.set(nameKey, nn);
    }
    const ep = episodeLabel(entry);
    const extra = entry.episode_title || ep
      ? normalizeForMatch(`${ep ?? ""} ${entry.episode_title ?? ""}`)
      : "";
    items.push({
      entry,
      key: keyOf(entry),
      dayKey: dayKeyOf(ts),
      ts,
      titleKey,
      search: extra ? `${nn} ${extra}` : nn,
      kinds,
    });
  }
  // The store keeps newest first, but a cloud merge or an older build may have
  // written rows out of order, and the day grouping below assumes order. A
  // stable sort leaves an already ordered list exactly as it was.
  let ordered = true;
  for (let i = 1; i < items.length; i++) {
    if (items[i].ts > items[i - 1].ts) { ordered = false; break; }
  }
  if (!ordered) items.sort((a, b) => b.ts - a.ts);
  return { items, titles };
}

// ---------------------------------------------------------------------------
// Stage 2: filtering.
// ---------------------------------------------------------------------------

export interface HistoryFilter {
  query: string;
  titleKey: string | null;
}

/** The TYPE-AGNOSTIC result (search + title), which is what the faceted type
 *  pills count over; `narrowByKind` takes the pill's slice of it. */
export function filterHistory(index: HistoryIndex, f: HistoryFilter): IndexedEntry[] {
  const q = prepareQuery(f.query);
  // "!!!" is a search that matches nothing, not no search at all: the page
  // would read "N of N shown" and its "shown" actions would take every row.
  if (!q && f.query.trim() !== "") return [];
  if (!q && !f.titleKey) return index.items;
  const out: IndexedEntry[] = [];
  for (const it of index.items) {
    if (f.titleKey && it.titleKey !== f.titleKey) continue;
    if (q && !matchesPrepared(q, it.search)) continue;
    out.push(it);
  }
  return out;
}

export function narrowByKind(list: IndexedEntry[], kind: MediaTypeFilter): IndexedEntry[] {
  if (kind === "all") return list;
  return list.filter((it) => it.kinds[kind]);
}

// ---------------------------------------------------------------------------
// Stage 3: layout. Every item has a FIXED height (the card's text is clamped
// so it can never grow a row), so positions are exact without measuring, a
// jump lands on the right pixel the first time, and the scrollbar reflects
// the whole history from the first frame.
// ---------------------------------------------------------------------------

export interface LayoutMetrics {
  dayHeaderH: number;
  rowH: number;
  /** Header bottom to first card row. */
  headerGap: number;
  /** Between two card rows of one day. */
  rowGap: number;
  /** Last row of a day to the next day's header. */
  dayGap: number;
}

export type LayoutItem =
  | { kind: "day"; key: string; dayKey: string; entries: IndexedEntry[]; totalSecs: number }
  | { kind: "row"; key: string; dayKey: string; entries: IndexedEntry[] };

export interface HistoryLayout {
  items: LayoutItem[];
  /** Top of each item, px from the list's top. Ascending. */
  tops: number[];
  heights: number[];
  totalHeight: number;
  /** Days present, NEWEST first. */
  dayKeys: string[];
  /** dayKey -> index of its header in `items`. */
  dayItem: Map<string, number>;
  /** dayKey -> PLAYS that day (in the filtered list), for the calendar's
   *  heat. Skip rows (`entry.skipped`) are not plays and are not counted:
   *  one "skip to canon" writes a row per episode of the arc on one day, and
   *  counting those painted a skipped filler arc as the busiest day of the
   *  year. Days with no plays are absent. */
  dayCounts: Map<string, number>;
  /** dayKey -> skip rows that day (same list). Days with none are absent. A
   *  skip-only day is still in `dayKeys` (a jump target), it just has no heat. */
  daySkips: Map<string, number>;
  /** dayKey -> seconds watched that day (same list), for the heat map's
   *  per-day readout. Summed in the same pass that groups the day. */
  daySecs: Map<string, number>;
  totalSecs: number;
}

export function buildLayout(
  list: readonly IndexedEntry[],
  cols: number,
  m: LayoutMetrics,
): HistoryLayout {
  const items: LayoutItem[] = [];
  const tops: number[] = [];
  const heights: number[] = [];
  const dayKeys: string[] = [];
  const dayItem = new Map<string, number>();
  const dayCounts = new Map<string, number>();
  const daySkips = new Map<string, number>();
  const daySecsMap = new Map<string, number>();
  let y = 0;
  let totalSecs = 0;
  const c = Math.max(1, cols);
  let i = 0;
  while (i < list.length) {
    const dayKey = list[i].dayKey;
    let j = i;
    let daySecs = 0;
    let skips = 0;
    while (j < list.length && list[j].dayKey === dayKey) {
      daySecs += list[j].entry.watched_seconds ?? 0;
      if (list[j].entry.skipped) skips++;
      j++;
    }
    const dayEntries = list.slice(i, j);
    totalSecs += daySecs;
    if (items.length > 0) y += m.dayGap;
    dayKeys.push(dayKey);
    dayItem.set(dayKey, items.length);
    const plays = dayEntries.length - skips;
    if (plays > 0) dayCounts.set(dayKey, plays);
    if (skips > 0) daySkips.set(dayKey, skips);
    if (daySecs > 0) daySecsMap.set(dayKey, daySecs);
    items.push({ kind: "day", key: `d:${dayKey}`, dayKey, entries: dayEntries, totalSecs: daySecs });
    tops.push(y);
    heights.push(m.dayHeaderH);
    y += m.dayHeaderH + m.headerGap;
    for (let r = 0; r < dayEntries.length; r += c) {
      if (r > 0) y += m.rowGap;
      items.push({
        kind: "row",
        // A row is a layout unit only: the view mounts each CARD keyed by its
        // own play, so this key never decides what remounts (keyed rows
        // remounted every later card of a day on one removal).
        key: `r:${dayEntries[r].key}`,
        dayKey,
        entries: dayEntries.slice(r, r + c),
      });
      tops.push(y);
      heights.push(m.rowH);
      y += m.rowH;
    }
    i = j;
  }
  return {
    items, tops, heights, totalHeight: y, dayKeys, dayItem, dayCounts, daySkips, daySecs: daySecsMap,
    totalSecs,
  };
}

/** First item whose bottom edge is below `y` (binary search over `tops`). */
export function firstItemAt(layout: HistoryLayout, y: number): number {
  const { tops, heights } = layout;
  let lo = 0;
  let hi = tops.length - 1;
  let ans = tops.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] + heights[mid] > y) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

/** Where the view's top item went when the list was rebuilt (columns changed,
 *  plays added or removed), as a pair of indexes whose tops differ by exactly
 *  what the scroll position must move. Matched per PLAY: a row's key is its
 *  first play, which a reflow changes, and the play may not stay first in its
 *  row. When that item's plays are gone, the nearest one that survives, looking
 *  older first; null when nothing does. */
export function findAnchor(
  prev: HistoryLayout,
  at: number,
  next: HistoryLayout,
): { from: number; to: number } | null {
  const rowOfPlay = new Map<string, number>();
  next.items.forEach((item, i) => {
    if (item.kind === "row") for (const it of item.entries) rowOfPlay.set(it.key, i);
  });
  const targetOf = (item: LayoutItem): number | undefined => {
    if (item.kind === "day") return next.dayItem.get(item.dayKey);
    for (const it of item.entries) {
      const row = rowOfPlay.get(it.key);
      if (row !== undefined) return row;
    }
    return undefined;
  };
  for (let i = at; i < prev.items.length; i++) {
    const to = targetOf(prev.items[i]);
    if (to !== undefined) return { from: i, to };
  }
  for (let i = Math.min(at, prev.items.length) - 1; i >= 0; i--) {
    const to = targetOf(prev.items[i]);
    if (to !== undefined) return { from: i, to };
  }
  return null;
}

/** [start, end) of the items overlapping [y0, y1]. */
export function visibleRange(layout: HistoryLayout, y0: number, y1: number): [number, number] {
  const n = layout.tops.length;
  if (n === 0) return [0, 0];
  const start = Math.min(firstItemAt(layout, Math.max(0, y0)), n - 1);
  let end = start;
  while (end < n && layout.tops[end] <= y1) end++;
  return [start, Math.max(end, start + 1)];
}

/** The day to land on for a picked date: that day when it has plays, else
 *  the nearest EARLIER day that does (the user asked about a point in the
 *  past, so the next older plays are the answer); if the date is older than
 *  everything, the oldest day. Null for an empty list. */
export function resolveJumpDay(dayKeys: readonly string[], target: string): string | null {
  if (dayKeys.length === 0) return null;
  // dayKeys are newest first: the first one at or before the target wins.
  let lo = 0;
  let hi = dayKeys.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dayKeys[mid] <= target) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans >= 0 ? dayKeys[ans] : dayKeys[dayKeys.length - 1];
}

// ---------------------------------------------------------------------------
// Calendar heat. The jump-to-date calendar shades each day (and, in its month
// picker, each month) by how many PLAYS it holds (skips are counted apart and
// never shade: the user asked for the volume watched), AniList "Activity History"
// style. Built from the layout's per-day maps, so it costs O(days with plays),
// never O(plays): the per-play pass already happened in buildLayout.
//
// WHY A PER-USER SCALE. Fixed thresholds (1 / 3 / 6 / 10 plays) leave a light
// watcher's whole calendar on one level and saturate a binger's. The scale is
// instead relative to the user's own TYPICAL busy day: the 90th percentile of
// the non-zero days in the year on screen, not the max, so one 40-episode
// marathon does not flatten every other day to the bottom level. A floor of 2
// keeps a "one play a day" calendar on a middle level rather than maxed out
// (with a cap of 1 every single play would read as the busiest day there is).
//
// SMALL SAMPLES. With fewer than 20 active days the 90th-percentile rank lands
// on the largest or second-largest value (ceil(0.9 * n) - 1 is n - 1 for every
// n <= 9), so a new user's one marathon, or the current year in early January,
// became the cap and pushed every other day to the lowest shade, exactly what
// the percentile was meant to prevent. Below that size the cap is also held to
// a few times the median day, which a lone outlier cannot move. From 20 days
// on the percentile is left alone: a heavily skewed but well-sampled year
// (median 1, p90 8) would otherwise saturate its whole top tenth. The month
// picker has at most 12 values a year, so it always takes the small-sample
// rule.
// ---------------------------------------------------------------------------

/** Shading levels for a day with plays (0 is "no plays"). */
export const HEAT_LEVELS = 4;
const HEAT_CAP_QUANTILE = 0.9;
const HEAT_CAP_FLOOR = 2;
/** Below this many non-zero values the cap is also bounded by the median. */
const HEAT_SMALL_SAMPLE = 20;
/** The small-sample cap: at most this many times the median value. */
const HEAT_MEDIAN_MULT = 3;

export interface HeatScale {
  /** Plays at or above which a day takes the top level. */
  cap: number;
}

export interface PeriodStat {
  plays: number;
  secs: number;
  /** Skip rows: reported beside the plays, never part of the heat. */
  skips: number;
}

export interface CalendarHeat {
  /** Day scale per calendar year. */
  dayScale: Map<number, HeatScale>;
  /** Plays and seconds per month, keyed year * 12 + month (0-based). */
  months: Map<number, PeriodStat>;
  /** Month scale per calendar year (over that year's months). */
  monthScale: Map<number, HeatScale>;
  years: Map<number, PeriodStat>;
}

/** The scale for a set of counts. Sorts its argument in place. */
export function heatScale(values: number[]): HeatScale {
  const nz = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (nz.length === 0) return { cap: HEAT_CAP_FLOOR };
  const rank = Math.max(0, Math.ceil(HEAT_CAP_QUANTILE * nz.length) - 1);
  let cap = nz[rank];
  if (nz.length < HEAT_SMALL_SAMPLE) {
    // Lower median: with an even count the upper one could be the outlier
    // itself (n = 2).
    const median = nz[(nz.length - 1) >> 1];
    cap = Math.min(cap, HEAT_MEDIAN_MULT * median);
  }
  return { cap: Math.max(HEAT_CAP_FLOOR, cap) };
}

/** 0 for no plays, else 1..HEAT_LEVELS by the share of the cap (GitHub's
 *  quarter steps, against the percentile cap instead of the max). */
export function heatLevel(n: number, scale: HeatScale): number {
  if (n <= 0) return 0;
  return Math.max(1, Math.min(HEAT_LEVELS, Math.ceil((HEAT_LEVELS * n) / scale.cap)));
}

export function buildCalendarHeat(
  dayCounts: ReadonlyMap<string, number>,
  daySecs: ReadonlyMap<string, number>,
  daySkips: ReadonlyMap<string, number>,
): CalendarHeat {
  const perYearDays = new Map<number, number[]>();
  const months = new Map<number, PeriodStat>();
  const years = new Map<number, PeriodStat>();
  const add = (key: string, n: number, skips: number) => {
    const y = Number(key.slice(0, 4));
    const mi = y * 12 + Number(key.slice(5, 7)) - 1;
    const secs = daySecs.get(key) ?? 0;
    if (n > 0) {
      let arr = perYearDays.get(y);
      if (!arr) { arr = []; perYearDays.set(y, arr); }
      arr.push(n);
    }
    const m = months.get(mi);
    if (m) { m.plays += n; m.secs += secs; m.skips += skips; }
    else months.set(mi, { plays: n, secs, skips });
    const yr = years.get(y);
    if (yr) { yr.plays += n; yr.secs += secs; yr.skips += skips; }
    else years.set(y, { plays: n, secs, skips });
  };
  for (const [key, n] of dayCounts) add(key, n, daySkips.get(key) ?? 0);
  // Skip-only days: absent from dayCounts, still part of the period totals.
  for (const [key, s] of daySkips) if (!dayCounts.has(key)) add(key, 0, s);
  const dayScale = new Map<number, HeatScale>();
  for (const [y, arr] of perYearDays) dayScale.set(y, heatScale(arr));
  const perYearMonths = new Map<number, number[]>();
  for (const [mi, st] of months) {
    const y = Math.floor(mi / 12);
    let arr = perYearMonths.get(y);
    if (!arr) { arr = []; perYearMonths.set(y, arr); }
    arr.push(st.plays);
  }
  const monthScale = new Map<number, HeatScale>();
  for (const [y, arr] of perYearMonths) monthScale.set(y, heatScale(arr));
  return { dayScale, months, monthScale, years };
}

/** "2h 41m" / "41m" / "<1m", matching the History day headers' wording. */
export function formatWatchTime(secs: number): string {
  const total = Math.floor(secs);
  if (total < 60) return "<1m";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
