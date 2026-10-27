// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// availableEarly - episodes whose streams arrived before their listed air date.
//
// A metadata addon's `released` can be late: AIOMetadata dated Bleach: Thousand-
// Year Blood War S4E10 2026-10-27 11:00 UTC while Cinemeta had it 2026-10-26
// 00:00 and the stream addons already served it, so Continue Watching counted
// down 13 h to an episode the user could play. A stream addon answering for an
// episode is evidence from the release itself, so the stream fetches record it
// here and every "has it aired" read (`releasedMs`) treats the episode as aired
// from that moment.
//
// Only a listed date at most EARLY_WINDOW_MS ahead counts: a late date is off
// by a timezone or an air time, while streams for an episode listed weeks out
// are more likely another episode's (an absolute-number mix-up). Only rows that
// can be THIS episode count (`countEpisodeEvidence`): a season pack is not, nor
// is a status row an addon sends instead of an empty list. Device-local,
// bounded (CAP, oldest first), and an entry is dropped once both its listed
// date and EARLY_WINDOW_MS after the sighting have passed: another addon can
// list the same episode later than the one the recorder read.
//
// Import-free: types.ts reads it.
// ---------------------------------------------------------------------------

const KEY = "aura:available-early:v1";
const CAP = 200;
const DAY_MS = 86_400_000;
/** How far ahead of now a listed air date may be for streams to override it. */
export const EARLY_WINDOW_MS = 4 * DAY_MS;

interface EarlyRecord {
  /** When the streams were seen (ms). */
  at: number;
  /** The listed air date the recorder read (ms). */
  listed: number;
}

/** A record stops mattering once both its listed date and EARLY_WINDOW_MS
 *  after the sighting have passed (any listing it could correct by then has). */
function expired(r: EarlyRecord, nowMs: number): boolean {
  return Math.max(r.listed, r.at + EARLY_WINDOW_MS) <= nowMs;
}

/** The stream-row fields countEpisodeEvidence reads (StreamEntry's). */
export interface EvidenceRow {
  url?: string | null;
  info_hash?: string | null;
  filename?: string | null;
  video_size?: number | null;
  episode_pack?: boolean | null;
}

/** How many rows of a stream answer show the episode itself is out. Not a
 *  season or multi-episode pack (`episode_pack`: matched by title, it can be
 *  any earlier episode), and only a row naming a release: a torrent hash, or a
 *  url with a filename or a file size. An addon's status row ("Invalid
 *  config", a debrid error) carries a url and neither. */
export function countEpisodeEvidence(rows: EvidenceRow[] | null | undefined): number {
  let n = 0;
  for (const s of rows ?? []) {
    if (!s || s.episode_pack === true) continue;
    const hash = typeof s.info_hash === "string" && s.info_hash.length > 0;
    const named = typeof s.url === "string" && s.url.length > 0
      && ((typeof s.filename === "string" && s.filename.trim().length > 0)
        || (typeof s.video_size === "number" && s.video_size > 0));
    if (hash || named) n++;
  }
  return n;
}

let records: Map<string, EarlyRecord> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): Map<string, EarlyRecord> {
  if (records) return records;
  records = new Map();
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      for (const e of parsed) {
        if (!Array.isArray(e) || typeof e[0] !== "string") continue;
        const at = Number(e[1]);
        const listed = Number(e[2]);
        if (Number.isFinite(at) && Number.isFinite(listed) && !expired({ at, listed }, Date.now())) {
          records.set(e[0], { at, listed });
        }
      }
    }
  } catch { /* unreadable: start empty */ }
  return records;
}

function save(map: Map<string, EarlyRecord>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify([...map].map(([id, r]) => [id, r.at, r.listed])));
  } catch { /* quota or storage off: the session map still holds it */ }
}

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** A stream fetch for `video` came back with `count` rows of evidence
 *  (countEpisodeEvidence, never a bare list length). Records it when its listed
 *  air date is still ahead, within EARLY_WINDOW_MS. */
export function noteStreamsFound(
  video: { id: string; released?: string | null } | null | undefined,
  count: number,
  nowMs: number = Date.now(),
): void {
  if (!video?.id || count <= 0) return;
  const listed = parseMs(video.released);
  if (listed == null || listed <= nowMs || listed - nowMs > EARLY_WINDOW_MS) return;
  const map = load();
  // An expired record (kept until the next prune) never blocks a new sighting.
  const prev = map.get(video.id);
  if (prev && !expired(prev, nowMs)) return;
  for (const [id, r] of map) if (expired(r, nowMs)) map.delete(id);
  while (map.size >= CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  map.set(video.id, { at: nowMs, listed });
  save(map);
  console.info(`[streams] ${video.id}: streams found before its listed air date (${new Date(listed).toISOString()}), treated as aired`);
  version += 1;
  for (const l of listeners) l();
}

/** When streams for `id` were first seen ahead of its listed date, else null. */
export function availableEarlyAt(id: string | null | undefined): number | null {
  if (!id) return null;
  const r = load().get(id);
  // A session can outlive a record (days in the tray): expire on read too.
  return r && !expired(r, Date.now()) ? r.at : null;
}

/** The episode's effective release (ms): its listed date, or the moment its
 *  streams were seen when that came first. Null when undated or unparseable,
 *  so each caller keeps its own rule for those. */
export function releasedMs(v: { id?: string | null; released?: string | null }): number | null {
  const listed = parseMs(v.released);
  if (listed == null) return null;
  const early = availableEarlyAt(v.id);
  return early != null && early < listed ? early : listed;
}

/** Whether the cloud's next_aired episode is one already found out early.
 *  By id first; else by date against the local episode list, because the
 *  cloud's ids follow its own source's numbering (AIOMetadata, else Cinemeta)
 *  and a record is keyed by the local meta addon's id: a recorded main-run
 *  episode listed up to EARLY_WINDOW_MS after the cloud's date (or a day
 *  before it) is that episode. */
export function cloudNextIsOut(
  sig: { id?: string | null; aired_at?: string | null } | null | undefined,
  videos?: { id?: string | null; season?: number | null; released?: string | null }[] | null,
): boolean {
  if (!sig) return false;
  if (availableEarlyAt(sig.id) != null) return true;
  const cloud = parseMs(sig.aired_at);
  if (cloud == null || !videos) return false;
  return videos.some((v) => {
    if (v.season === 0 || availableEarlyAt(v.id) == null) return false;
    const listed = parseMs(v.released);
    // One-sided: the record exists because the local listing is LATE, so the
    // same episode's cloud date sits on or before it (an air-time drift of up
    // to a day allowed). A cloud date further after it is the NEXT episode
    // (a twice-weekly show, a double drop) and keeps its countdown.
    return listed != null && cloud >= listed - EARLY_WINDOW_MS && cloud <= listed + DAY_MS;
  });
}

export function subscribeAvailableEarly(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getAvailableEarlyVersion(): number {
  return version;
}
