// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// mangaChapters: the frontend face of the Rust `manga_chapters` module.
//
// Which manga chapters an anime adapts, at three grains:
//   * series:  "The anime reaches chapter 1,150 · continue from 1,151"
//              (MangaUpdates, via the detail page),
//   * arc:     "Ch. 1,058-1,125" on an arc tile (the arc's Fandom infobox, or
//              derived from per-episode data when that covers the arc),
//   * episode: "Ch. 402-404" in an episode row's hover text and the player
//              (per-episode Fandom pages, joined to Aura's episodes by AIR
//              DATE in Rust, never by number: see manga_chapters.rs).
//
// Everything is lazy and degrades to nothing. A show with no match, no wiki,
// or no per-episode field simply shows no chapter text anywhere; a guess is
// never shown in place of an answer.
//
// State is per series id, in memory, bounded (the Rust side holds the disk
// cache), and shared through a tiny external store so the player overlay can
// read what the detail page or the episode drawer already fetched without
// fetching anything itself.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useSyncExternalStore } from "react";

import { isAnimeMeta } from "./aiometadata";
import { NEWER_EPISODES_ARC_ID, type ArcResult, type StoryArc } from "./storyArcs";
import type { MetaDetail, VideoEntry } from "./types";

export interface MangaSeries {
  series_id: number;
  title: string;
  url: string | null;
  /** First chapter the anime adapts, when known. */
  adapts_from: number | null;
  /** Furthest chapter adapted. Null when MangaUpdates records a part that has
   *  started without an end, since the last recorded end would understate it. */
  reach: number | null;
  /** The anime stops partway into `reach`. */
  reach_partial: boolean;
  /** MangaUpdates' latest chapter, only when it is past `reach`. */
  latest: number | null;
  completed: boolean;
}

export interface ChapterRange {
  start: number;
  end: number;
}

export interface SeriesState {
  /** undefined = not asked yet; null = asked, nothing to show. */
  series?: MangaSeries | null;
  /** Aura video id -> chapters. An empty list is the wiki saying "adapts
   *  nothing" (an anime original). `null` = this show's wiki has no
   *  per-episode field. */
  episodes?: Record<string, number[]> | null;
  /** Arc NAME -> the range its wiki page's infobox gives. */
  arcRanges?: Record<string, ChapterRange>;
}

// ---------------------------------------------------------------------------
// Store: bounded, immutable snapshots.
// ---------------------------------------------------------------------------

/** A handful of series is all a session looks at; the Rust side keeps the
 *  real cache on disk. */
const MAX_SERIES = 24;
const store = new Map<string, SeriesState>();
const listeners = new Set<() => void>();
const EMPTY: SeriesState = Object.freeze({});

function update(seriesId: string, patch: Partial<SeriesState>): void {
  const prev = store.get(seriesId) ?? EMPTY;
  store.delete(seriesId);
  store.set(seriesId, { ...prev, ...patch });
  while (store.size > MAX_SERIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The chapter state for a series, re-rendering when it changes. */
export function useMangaState(seriesId: string | null | undefined): SeriesState {
  return useSyncExternalStore(
    subscribe,
    () => (seriesId ? store.get(seriesId) ?? EMPTY : EMPTY),
  );
}

/** Requests in flight, so the detail page and the episode drawer asking at
 *  once cost one IPC round trip. An entry lives until its request settles. */
const inFlight = new Map<string, Promise<void>>();

function once(key: string, run: () => Promise<void>): void {
  if (inFlight.has(key)) return;
  const p = run().catch((e) => console.warn("[manga]", key, e)).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
}

/** Whether a title gets any manga-chapter lookup at all: an anime series
 *  with an episode list. */
export function mangaEligible(detail: MetaDetail | null | undefined): detail is MetaDetail {
  return eligible(detail);
}

function eligible(detail: MetaDetail | null | undefined): detail is MetaDetail {
  return !!detail
    && detail.videos.length > 1
    && isAnimeMeta({
      media_type: detail.media_type,
      id: detail.id,
      genres: detail.genres,
      original_language: detail.original_language,
      production_countries: detail.production_countries,
    });
}

function imdbRootOf(seriesId: string): string | null {
  const head = seriesId.split(":")[0] ?? "";
  return head.startsWith("tt") ? head : null;
}

// ---------------------------------------------------------------------------
// Hooks (the only things that fetch)
// ---------------------------------------------------------------------------

/** The detail page's "continue in the manga" data. `ready` holds the call
 *  until the MAL id resolution has settled, because MAL's "Adaptation"
 *  relation is the safest way to name the source manga. */
export function useMangaSeries(
  detail: MetaDetail | null | undefined,
  seriesId: string,
  malId: number | null,
  ready: boolean,
): MangaSeries | null {
  const state = useMangaState(seriesId);
  const ok = eligible(detail) && ready;
  useEffect(() => {
    if (!ok || !detail || state.series !== undefined) return;
    const year = (() => {
      const y = parseInt((detail.release_info ?? detail.released ?? "").slice(0, 4), 10);
      return Number.isFinite(y) && y > 1900 ? y : null;
    })();
    once(`series:${seriesId}`, async () => {
      const reply = await invoke<{ result: "series"; series: MangaSeries | null }>("manga_chapters", {
        action: { op: "series", titles: [detail.name], year, mal_id: malId },
      });
      update(seriesId, { series: reply.series ?? null });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, seriesId, malId, state.series === undefined]);
  return state.series ?? null;
}

/** Per-episode chapters. Call only where an episode list is on screen. */
export function useEpisodeChapters(
  detail: MetaDetail | null | undefined,
  seriesId: string,
): Record<string, number[]> | null {
  const state = useMangaState(seriesId);
  const ok = eligible(detail);
  const count = detail?.videos.length ?? 0;
  useEffect(() => {
    if (!ok || !detail || state.episodes !== undefined) return;
    once(`episodes:${seriesId}:${count}`, async () => {
      const videos = detail.videos.map((v: VideoEntry) => ({
        id: v.id, released: v.released, title: v.title, season: v.season,
      }));
      const reply = await invoke<{ result: "episodes"; supported: boolean; chapters: Record<string, number[]> }>(
        "manga_chapters",
        { action: { op: "episodes", tmdb_id: detail.tmdb_id ?? null, imdb_id: imdbRootOf(seriesId), videos } },
      );
      update(seriesId, { episodes: reply.supported ? reply.chapters : null });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, seriesId, count, state.episodes === undefined]);
  return state.episodes ?? null;
}

/** Infobox ranges for the arcs of the grouping on screen. */
export function useArcChapterRanges(
  detail: MetaDetail | null | undefined,
  seriesId: string,
  arcs: ArcResult | null,
): Record<string, ChapterRange> {
  const state = useMangaState(seriesId);
  const ok = eligible(detail) && !!arcs && arcs.arcs.length > 0;
  const names = (arcs?.arcs ?? []).filter((a) => a.id !== NEWER_EPISODES_ARC_ID).map((a) => a.name);
  const missing = names.filter((n) => !(state.arcRanges && n in state.arcRanges));
  const asked = arcsAsked.get(seriesId);
  const want = missing.filter((n) => !asked?.has(n));
  const key = want.join("\u0000");
  useEffect(() => {
    if (!ok || !detail || want.length === 0) return;
    const set = arcsAsked.get(seriesId) ?? new Set<string>();
    want.forEach((n) => set.add(n));
    arcsAsked.set(seriesId, set);
    if (arcsAsked.size > MAX_SERIES) {
      const oldest = arcsAsked.keys().next().value;
      if (oldest !== undefined) arcsAsked.delete(oldest);
    }
    once(`arcs:${seriesId}:${key}`, async () => {
      let reply: { result: "arcs"; ranges: Record<string, ChapterRange> };
      try {
        reply = await invoke("manga_chapters", {
          action: { op: "arcs", tmdb_id: detail.tmdb_id ?? null, imdb_id: imdbRootOf(seriesId), arc_names: names },
        });
      } catch (e) {
        // A failure to ASK is not an answer: let a later render ask again.
        want.forEach((n) => set.delete(n));
        throw e;
      }
      const merged = { ...(store.get(seriesId)?.arcRanges ?? {}), ...reply.ranges };
      update(seriesId, { arcRanges: merged });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, seriesId, key]);
  return state.arcRanges ?? {};
}

/** Arc names already requested per series, answered or not, so a name the
 *  wiki has no range for is not asked again on every render. Bounded with
 *  the store. */
const arcsAsked = new Map<string, Set<string>>();

// ---------------------------------------------------------------------------
// Formatting. ASCII hyphens only.
// ---------------------------------------------------------------------------

export function formatChapter(n: number): string {
  return n.toLocaleString("en-US");
}

export function formatRange(r: ChapterRange): string {
  return r.start === r.end ? formatChapter(r.start) : `${formatChapter(r.start)}-${formatChapter(r.end)}`;
}

/** Sorted chapters grouped into runs, allowing a small gap (an adaptation
 *  that skips a chapter is still one run). */
function runs(chapters: number[], gap: number): number[][] {
  const sorted = [...new Set(chapters)].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c - last[last.length - 1] <= gap) last.push(c);
    else out.push([c]);
  }
  return out;
}

/** "635, 654, 659-661, 674": every chapter, consecutive ones collapsed. */
function compressedList(chapters: number[]): string {
  return runs(chapters, 1)
    .map((r) => (r.length === 1 ? formatChapter(r[0]) : `${formatChapter(r[0])}-${formatChapter(r[r.length - 1])}`))
    .join(", ");
}

/** The chapters an episode is mainly about: the one run clearly larger than
 *  the others. Bleach 406 lists 635 and 654 (flashbacks) and 674 (a
 *  flash-forward) around 659-661. Null when no run is strictly largest. */
function coreRange(chapters: number[]): ChapterRange | null {
  const rs = runs(chapters, 3);
  if (rs.length === 0) return null;
  const sorted = [...rs].sort((a, b) => b.length - a.length);
  if (sorted.length > 1 && sorted[0].length === sorted[1].length) return null;
  const core = sorted[0];
  return { start: core[0], end: core[core.length - 1] };
}

/** Short label for the player and similar tight spots: "Ch. 590",
 *  "Ch. 402-404", "Anime original". Null when there is nothing to say. */
export function episodeChapterLabel(chapters: number[] | undefined | null): string | null {
  if (!chapters) return null;
  if (chapters.length === 0) return "Anime original";
  const core = coreRange(chapters);
  return core ? `Ch. ${formatRange(core)}` : `Ch. ${compressedList(chapters)}`;
}

/** Sentence for an episode row's hover text. */
export function episodeChapterHint(chapters: number[] | undefined | null): string | null {
  if (!chapters) return null;
  if (chapters.length === 0) return "Anime original: this episode does not adapt the manga.";
  const core = coreRange(chapters);
  if (!core) return `Adapts manga chapters ${compressedList(chapters)}.`;
  const one = core.start === core.end;
  const main = `Adapts manga chapter${one ? "" : "s"} ${formatRange(core)}.`;
  const extra = chapters.filter((c) => c < core.start || c > core.end);
  return extra.length > 0 ? `${main} Also draws on ${compressedList(extra)}.` : main;
}

/** Range derived from per-episode data over a set of episodes (an arc or a
 *  season), or null when the data does not cover them well enough to say.
 *  At least 80% of the episodes must have an answer from the wiki (an
 *  anime-original answer counts), and the range is the dominant run of the
 *  chapters they name, so a stray flashback cannot stretch it. */
export function derivedRange(
  ids: string[],
  episodes: Record<string, number[]> | null | undefined,
): ChapterRange | null {
  if (!episodes || ids.length === 0) return null;
  let answered = 0;
  const all: number[] = [];
  for (const id of ids) {
    const ch = episodes[id];
    if (!ch) continue;
    answered += 1;
    all.push(...ch);
  }
  if (answered < Math.ceil(ids.length * 0.8) || all.length === 0) return null;
  return coreRange(all);
}

/** The chapter range to show for an arc. Per-episode data wins when it
 *  covers the arc (it describes what the ANIME adapted); otherwise the arc
 *  page's infobox, which describes the MANGA arc, so it is cut at how far the
 *  anime has got when MangaUpdates says so, and is not shown for the last arc
 *  when nothing says how far that is. */
export function arcChapterRange(
  arc: StoryArc,
  state: SeriesState,
  isLastArc: boolean,
): ChapterRange | null {
  if (arc.id === NEWER_EPISODES_ARC_ID) return null;
  const derived = derivedRange(arc.episode_ids, state.episodes);
  if (derived) return derived;
  const r = state.arcRanges?.[arc.name];
  if (!r) return null;
  const reach = state.series?.reach ?? null;
  if (reach == null) return isLastArc ? null : r;
  if (r.start > reach) return null;
  return r.end > reach ? { start: r.start, end: reach } : r;
}

/** Is this the final arc TMDB lists (ignoring Aura's trailing
 *  newer-episodes group)? That arc may still be airing. */
export function isLastRealArc(result: ArcResult, arc: StoryArc): boolean {
  const real = result.arcs.filter((a) => a.id !== NEWER_EPISODES_ARC_ID);
  const maxOrder = Math.max(...real.map((a) => a.order));
  return arc.order === maxOrder;
}

/** True when the show has ANY chapter data, which is what licenses calling a
 *  filler episode an "anime original" (a show adapted from a light novel has
 *  filler too, and no chapters). */
export function hasMangaData(state: SeriesState): boolean {
  return !!state.series || !!state.episodes || Object.keys(state.arcRanges ?? {}).length > 0;
}

/** The detail page's line, or null. MangaUpdates' numbers as-is; the episode
 *  it was recorded at is never printed, because MangaUpdates counts episodes
 *  the official way and Aura's list may not. */
export function seriesChapterLine(s: MangaSeries | null): string | null {
  if (!s) return null;
  const from = s.adapts_from != null && s.adapts_from > 1
    ? `adapts from chapter ${formatChapter(s.adapts_from)}`
    : null;
  if (s.reach == null) {
    return s.adapts_from != null && s.adapts_from > 1
      ? `Adapts from chapter ${formatChapter(s.adapts_from)}`
      : null;
  }
  const reached = s.reach_partial
    ? `Reaches partway into chapter ${formatChapter(s.reach)}`
    : `Reaches chapter ${formatChapter(s.reach)}`;
  const next = s.reach_partial ? s.reach : s.reach + 1;
  // Without a latest chapter past the reach, a finished manga may have been
  // adapted to its end, so "continue from" would point past the last page.
  const canContinue = s.latest != null || !s.completed;
  const cont = canContinue
    ? ` · continue from ${formatChapter(next)}${s.latest != null ? ` (latest: ${formatChapter(s.latest)})` : ""}`
    : "";
  return `${reached}${cont}${from ? ` · ${from}` : ""}`;
}

/** The detail line's FALLBACK, from the fan wiki's per-episode chapters,
 *  for when MangaUpdates has no usable figure (Bleach: its last part is
 *  recorded as started with no end). The reach is the highest chapter any
 *  already-aired episode adapts; "continue from" follows it, and MangaUpdates'
 *  latest chapter is added when it has one past that reach. Null when the
 *  wiki has no per-episode data or no aired episode adapts anything. */
export function wikiChapterLine(
  episodes: Record<string, number[]> | null | undefined,
  videos: VideoEntry[],
  s: MangaSeries | null,
): string | null {
  if (!episodes) return null;
  const now = Date.now();
  let reach = 0;
  for (const v of videos) {
    if ((v.season ?? 0) <= 0) continue;
    const t = v.released ? Date.parse(v.released) : NaN;
    if (!Number.isFinite(t) || t > now) continue;
    for (const c of episodes[v.id] ?? []) if (c > reach) reach = c;
  }
  if (reach <= 0) return null;
  const latest = s?.latest != null && s.latest > reach ? s.latest : null;
  return `Reaches chapter ${formatChapter(reach)} · continue from ${formatChapter(reach + 1)}`
    + (latest != null ? ` (latest: ${formatChapter(latest)})` : "");
}

/** The Details list's "Manga" row. Always an answer once asked, so the row
 *  can say "Not available" rather than silently vanish: MangaUpdates first,
 *  then the fan wiki's per-episode chapters, then "Checking" while either
 *  source is still out, then "Not available" with the reason on hover. */
export interface MangaFact {
  value: string;
  /** Hover text: where the figure came from, or why there is none. */
  title: string;
  /** A real figure, as opposed to Checking / Not available. */
  available: boolean;
}

export function mangaFact(state: SeriesState, videos: VideoEntry[]): MangaFact {
  const s = state.series ?? null;
  const fromMu = seriesChapterLine(s);
  if (fromMu && s) {
    return {
      value: fromMu,
      title: `From MangaUpdates (${s.title}), as of the anime's position it last recorded.`,
      available: true,
    };
  }
  const fromWiki = wikiChapterLine(state.episodes, videos, s);
  if (fromWiki) {
    return {
      value: fromWiki,
      title: "From the fan wiki's episode pages: the furthest chapter any aired episode adapts.",
      available: true,
    };
  }
  if (state.series === undefined || state.episodes === undefined) {
    return { value: "Checking…", title: "Looking up the manga chapters this anime adapts.", available: false };
  }
  return {
    value: "Not available",
    title: s
      ? `MangaUpdates (${s.title}) does not record how far the anime has adapted, and no fan wiki Aura reads lists its chapters per episode.`
      : "No chapter data was found: MangaUpdates has no matching manga for this anime, and no fan wiki Aura reads lists its chapters per episode.",
    available: false,
  };
}

/** Synchronous lookup for the player: the label for an episode, from
 *  whatever the detail page or the episode drawer already fetched. */
export function useEpisodeChapterLabel(seriesId: string | null | undefined, episodeId: string | null | undefined): string | null {
  const state = useMangaState(seriesId);
  if (!episodeId) return null;
  return episodeChapterLabel(state.episodes?.[episodeId]);
}
