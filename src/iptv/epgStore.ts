// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// EPG (XMLTV) store — fetches + parses a playlist's EPG once, indexes it by
// tvg-id, and serves now/next lookups to the channel grid + guide. Same
// module-singleton + CustomEvent pub/sub shape as iptv/store.ts.
//
// MEMORY (the standing RAM directive): a 7-day XMLTV for hundreds of channels
// parses to tens of thousands of EpgProgram objects — tens of MB resident.
// So the cache is HARD-CAPPED: at most MAX_CACHED source EPGs are kept, LRU-
// evicted by last access, each with a TTL. Only the source(s) the user is
// actually viewing stay resident; switching sources drops the rest. The fetch
// goes through the Rust hop (iptv_fetch_text), which enforces the 64 MiB body
// cap so a runaway EPG can't balloon the webview heap.
// ---------------------------------------------------------------------------

import { iptvFetchText } from "./fetch";
import { parseXmltv, indexProgramsByChannel, parseXmltvChannelNames } from "./xmltv";
import { resolveChannelEpg, findSharedTvgIds } from "./epgResolver";
import { classifyIptvError } from "./store";
import type { EpgIndex, EpgProgram, IptvChannel } from "./types";

const CHANGE_EVENT = "aura:iptv-epg-changed";
/** Re-fetch an EPG at most this often on passive load (EPGs refresh on the
 *  provider hourly-ish; 30 min keeps now/next fresh without re-pulling a
 *  tens-of-MB body on every source switch). */
const PARSE_TTL_MS = 30 * 60 * 1000;
/** Max source EPGs resident at once (RAM cap — see header). LRU by lastUsed. */
const MAX_CACHED = 2;

interface EpgEntry {
  index: EpgIndex;
  /** tvg-ids used by >1 channel — drives the resolver's ambiguity guard. */
  shared: Set<string>;
  /** The epgUrl this was fetched from (so a changed URL forces a refetch). */
  url: string;
  lastUsed: number;
}

const _bySource = new Map<string, EpgEntry>();
const _loading = new Set<string>();
const _errors = new Map<string, string>();
const _inflight = new Map<string, Promise<void>>();

function emit(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeEpg(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
}

export function isEpgLoading(sourceId: string): boolean {
  return _loading.has(sourceId);
}

export function epgError(sourceId: string): string | null {
  return _errors.get(sourceId) ?? null;
}

export function hasEpg(sourceId: string): boolean {
  return _bySource.has(sourceId);
}

/** Evict least-recently-used EPGs beyond the cap (RAM discipline). */
function enforceCap(): void {
  while (_bySource.size > MAX_CACHED) {
    let oldestId: string | null = null;
    let oldest = Infinity;
    for (const [id, e] of _bySource) {
      if (e.lastUsed < oldest) {
        oldest = e.lastUsed;
        oldestId = id;
      }
    }
    if (oldestId == null) break;
    _bySource.delete(oldestId);
  }
}

/** Fetch + parse + index the EPG for a source. TTL-gated unless `force`.
 *  No-op when `epgUrl` is empty. Concurrent calls share one fetch. */
export function loadEpg(
  sourceId: string,
  epgUrl: string | null | undefined,
  channels: IptvChannel[],
  opts?: { force?: boolean },
): Promise<void> {
  if (!epgUrl) return Promise.resolve();

  const existing = _inflight.get(sourceId);
  if (existing) return existing;

  const cached = _bySource.get(sourceId);
  if (
    !opts?.force &&
    cached &&
    cached.url === epgUrl &&
    Date.now() - cached.index.fetchedAt < PARSE_TTL_MS
  ) {
    cached.lastUsed = Date.now();
    return Promise.resolve();
  }

  const p = doFetch(sourceId, epgUrl, channels).finally(() => _inflight.delete(sourceId));
  _inflight.set(sourceId, p);
  return p;
}

async function doFetch(sourceId: string, epgUrl: string, channels: IptvChannel[]): Promise<void> {
  _loading.add(sourceId);
  _errors.delete(sourceId);
  emit();
  try {
    const body = await iptvFetchText(epgUrl);
    const programs = parseXmltv(body);
    if (programs.length === 0) {
      throw new Error("The EPG loaded but contained no programmes.");
    }
    // Build the name→id index too so the resolver can fall back to a
    // display-name match when the playlist's tvg-ids don't line up with
    // this EPG's channel ids.
    const nameToId = parseXmltvChannelNames(body);
    const index = indexProgramsByChannel(programs, nameToId);
    const shared = findSharedTvgIds(channels);
    _bySource.set(sourceId, { index, shared, url: epgUrl, lastUsed: Date.now() });
    enforceCap();
    _errors.delete(sourceId);
  } catch (e) {
    _errors.set(sourceId, classifyIptvError(e));
  } finally {
    _loading.delete(sourceId);
    emit();
  }
}

/** Drop a source's cached EPG (e.g. on playlist removal). */
export function dropEpg(sourceId: string): void {
  if (_bySource.delete(sourceId) || _errors.delete(sourceId)) emit();
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

export interface NowNext {
  now: EpgProgram | null;
  next: EpgProgram | null;
}

/** Resolve the on-air + following programme for a channel, or null when no
 *  EPG is loaded / the channel has no matching rows. */
export function resolveNowNext(
  sourceId: string,
  channel: IptvChannel,
  nowMs: number,
): NowNext | null {
  const entry = _bySource.get(sourceId);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  const programs = resolveChannelEpg(channel, entry.index, entry.shared);
  if (!programs || programs.length === 0) return null;

  // programs are start-sorted; find the first that hasn't ended, then the
  // on-air one is `now` (if it has started) and the following is `next`.
  let now: EpgProgram | null = null;
  let next: EpgProgram | null = null;
  for (let i = 0; i < programs.length; i++) {
    const p = programs[i];
    if (p.startMs <= nowMs && p.endMs > nowMs) {
      now = p;
      next = programs[i + 1] ?? null;
      break;
    }
    if (p.startMs > nowMs) {
      next = p;
      break;
    }
  }
  if (now == null && next == null) return null;
  return { now, next };
}

/** The full program list for a channel (for the guide grid). Null when no
 *  EPG row matches. */
export function channelPrograms(sourceId: string, channel: IptvChannel): EpgProgram[] | null {
  const entry = _bySource.get(sourceId);
  if (!entry) return null;
  entry.lastUsed = Date.now();
  return resolveChannelEpg(channel, entry.index, entry.shared);
}
