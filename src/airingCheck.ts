// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// airingCheck - asks the stream addons for an airing show's next episode once
// its listed air date is within a day, so a late listing is caught before the
// user goes looking (availableEarly.ts holds what it finds).
//
// A metadata addon's `released` can trail the real release: AIOMetadata dated
// Bleach: Thousand-Year Blood War S4E10 a day and a half after Cinemeta, and
// Continue Watching counted down 13 h to an episode the stream addons already
// served. availableEarly.ts corrects that once something fetched the episode's
// streams; this pass is that something for an episode nobody opened.
//
// Cost rules (a stream query fans out to every stream addon, debrid checks
// included): only the next MAIN-RUN episode of a library series whose listed
// date is ahead by at most CHECK_WINDOW_MS, each such episode at most once per
// RECHECK_MS, at most MAX_PROBES_PER_PASS per pass, one query at a time, and
// none while something plays (the caller skips the pass). A show is looked at
// only with a cached meta detail, or when it is in Continue Watching or the
// cloud's next_aired falls in the window (then its detail is fetched through
// the meta cache, at most MAX_DETAIL_FETCHES_PER_PASS per pass): never a meta
// fetch for every library item.
//
// Import-free, its I/O injected (useAiringStreamCheck.ts wires it), so a node
// check can drive it.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;

/** How far ahead of now a listed air date may be for the episode to be checked. */
export const CHECK_WINDOW_MS = 24 * HOUR_MS;
/** One check per episode per this long. */
export const RECHECK_MS = HOUR_MS;
/** How often the pass runs while the window is visible. */
export const PASS_INTERVAL_MS = 10 * 60_000;
/** Delay before the first pass after launch or a library change. */
export const FIRST_PASS_DELAY_MS = 20_000;
export const MAX_PROBES_PER_PASS = 6;
export const MAX_DETAIL_FETCHES_PER_PASS = 10;
/** Bound on the per-episode last-check record. */
export const LAST_CHECK_CAP = 200;

/** The episode shape this module reads. */
export interface CheckVideo {
  id: string;
  season?: number | null;
  episode?: number | null;
  released?: string | null;
  /** Streams embedded in the meta itself (a channel-style meta): nothing to ask. */
  streams?: unknown[] | null;
}

export interface CheckItem {
  /** Series-root id (the meta id). */
  id: string;
  media_type: string;
  removed?: boolean;
  temp?: boolean;
  /** In Continue Watching (timeOffset > 0). */
  inContinueWatching?: boolean;
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** The episode to check: the earliest main-run episode by LISTED date that is
 *  still ahead of now, when that date is within CHECK_WINDOW_MS. Null when
 *  nothing is due within the window, when that episode embeds its own streams,
 *  or when it is already known to be out (`isKnownOut`). Earliest by the listed
 *  date, never by releasedMs: the point is the listing, and an episode already
 *  found out is no longer "next". */
export function pickEpisodeToCheck(
  videos: CheckVideo[] | null | undefined,
  nowMs: number,
  isKnownOut: (id: string) => boolean = () => false,
): { video: CheckVideo; listedMs: number } | null {
  let best: { video: CheckVideo; listedMs: number } | null = null;
  for (const v of videos ?? []) {
    if (!v?.id || v.season === 0) continue; // specials are off the airing axis
    const t = parseMs(v.released);
    if (t == null || t <= nowMs) continue;
    if (isKnownOut(v.id)) continue;
    if (best == null || t < best.listedMs) best = { video: v, listedMs: t };
  }
  if (!best || best.listedMs - nowMs > CHECK_WINDOW_MS) return null;
  if (Array.isArray(best.video.streams) && best.video.streams.length > 0) return null;
  return best;
}

/** Whether an episode last checked at `lastAt` is due again. */
export function checkDue(lastAt: number | null | undefined, nowMs: number): boolean {
  return lastAt == null || nowMs - lastAt >= RECHECK_MS;
}

/** Series-like library items worth looking at, deduped by id. */
export function checkableItems(items: CheckItem[]): CheckItem[] {
  const seen = new Set<string>();
  const out: CheckItem[] = [];
  for (const it of items) {
    const mt = (it.media_type ?? "").toLowerCase();
    if (mt !== "series" && mt !== "anime") continue;
    if (it.removed || it.temp || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    out.push(it);
  }
  return out;
}

export interface PassDeps {
  nowMs: number;
  items: CheckItem[];
  /** Synchronous cached detail for a series id, no network. */
  peekVideos: (id: string) => CheckVideo[] | null;
  /** Network detail fetch (through the meta cache). */
  fetchVideos: (item: CheckItem) => Promise<CheckVideo[] | null>;
  /** The cloud's next_aired time (ms) for a series id, when it has one. */
  cloudNextMs: (id: string) => number | null;
  /** Ask the stream addons; resolves to how many rows show the episode is out
   *  (availableEarly.countEpisodeEvidence). */
  fetchStreamCount: (item: CheckItem, video: CheckVideo) => Promise<number>;
  isKnownOut: (videoId: string) => boolean;
  noteFound: (video: CheckVideo, count: number) => void;
  /** Per-episode last-check record (the caller keeps it across passes). */
  lastCheck: Map<string, number>;
  /** False aborts between steps (playback started, unmounted). */
  stillWanted: () => boolean;
  log: (line: string) => void;
}

export interface PassResult {
  probed: number;
  found: number;
  detailFetches: number;
  /** Episodes in the window skipped because the per-pass cap was reached. */
  deferred: number;
}

/** Bound the last-check record: drop entries older than the window, then the
 *  oldest past the cap. */
export function pruneLastCheck(map: Map<string, number>, nowMs: number): void {
  for (const [id, at] of map) if (nowMs - at > CHECK_WINDOW_MS + RECHECK_MS) map.delete(id);
  while (map.size > LAST_CHECK_CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function hoursAhead(ms: number, nowMs: number): string {
  return `${((ms - nowMs) / HOUR_MS).toFixed(1)} h`;
}

/** One pass. Never throws: a failed query is logged and retried after
 *  RECHECK_MS like a miss. */
export async function runCheckPass(d: PassDeps): Promise<PassResult> {
  const res: PassResult = { probed: 0, found: 0, detailFetches: 0, deferred: 0 };
  pruneLastCheck(d.lastCheck, d.nowMs);
  for (const item of checkableItems(d.items)) {
    if (!d.stillWanted()) break;
    let videos = d.peekVideos(item.id);
    if (!videos) {
      const cloud = d.cloudNextMs(item.id);
      const cloudInWindow = cloud != null && cloud > d.nowMs && cloud - d.nowMs <= CHECK_WINDOW_MS;
      if (!item.inContinueWatching && !cloudInWindow) continue;
      if (res.detailFetches >= MAX_DETAIL_FETCHES_PER_PASS) continue;
      res.detailFetches += 1;
      try {
        videos = await d.fetchVideos(item);
      } catch {
        videos = null;
      }
      if (!d.stillWanted()) break;
      if (!videos) continue;
    }
    const pick = pickEpisodeToCheck(videos, d.nowMs, d.isKnownOut);
    if (!pick) continue;
    if (!checkDue(d.lastCheck.get(pick.video.id), d.nowMs)) continue;
    if (res.probed >= MAX_PROBES_PER_PASS) {
      res.deferred += 1;
      continue;
    }
    res.probed += 1;
    // Re-inserted so the Map's order stays oldest-first for the cap.
    d.lastCheck.delete(pick.video.id);
    d.lastCheck.set(pick.video.id, d.nowMs);
    let count = 0;
    try {
      count = await d.fetchStreamCount(item, pick.video);
    } catch (e) {
      d.log(`[airing-check] ${pick.video.id} (listed in ${hoursAhead(pick.listedMs, d.nowMs)}): stream query failed (${String(e).slice(0, 120)}), next try in 1 h`);
      continue;
    }
    // Recorded even when playback started meanwhile: the answer is still true.
    if (count > 0) {
      res.found += 1;
      d.noteFound(pick.video, count);
      d.log(`[airing-check] ${pick.video.id} (listed in ${hoursAhead(pick.listedMs, d.nowMs)}): ${count} stream(s) already, counted as aired`);
    } else {
      d.log(`[airing-check] ${pick.video.id} (listed in ${hoursAhead(pick.listedMs, d.nowMs)}): no streams yet, next try in 1 h`);
    }
    if (!d.stillWanted()) break;
  }
  if (res.deferred > 0) {
    d.log(`[airing-check] ${res.deferred} more episode(s) in the window wait for the next pass (cap ${MAX_PROBES_PER_PASS} per pass)`);
  }
  return res;
}
