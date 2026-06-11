// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Live TV store — module-level singleton + CustomEvent pub/sub, mirroring
// the shape of historyStore / releaseSignalStore. Holds:
//   • `sources`   — configured playlists (persisted in Rust AppSettings
//                   `iptv_playlists`, round-tripped via get/update_settings).
//   • `playlists` — parsed channel lists keyed by source id, cached in
//                   memory with a TTL so re-entering Live TV doesn't refetch.
//   • `loading` / `errors` — per-source UI state.
//
// All network goes through `iptvFetchText` (the Rust hop: IPTV-client UA,
// no CORS, 64 MiB cap). Xtream passwords live in the OS keyring (Phase 0),
// never in the persisted source — they're merged back in here at fetch time.
//
// MEMORY: the cache is bounded by the number of configured sources (a
// handful), each holding one parsed playlist. A playlist can carry
// thousands of channels — that's inherent to the feature and only resident
// while sources are configured. The PARSE_TTL_MS gate avoids re-holding a
// fresh copy on every Live TV mount.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { iptvFetchText } from "./fetch";
import { parseM3u, groupChannels } from "./m3u";
import type { IptvPlaylist, IptvPlaylistSource } from "./types";

const CHANGE_EVENT = "aura:iptv-changed";
/** Re-fetch a source's playlist at most this often on passive refresh. A
 *  manual refresh (force) bypasses it. 30 min balances "channels rarely
 *  change" against a stale list after the provider adds channels. */
const PARSE_TTL_MS = 30 * 60 * 1000;

interface IptvState {
  sources: IptvPlaylistSource[];
  /** source id → parsed playlist. */
  playlists: Map<string, IptvPlaylist>;
  /** source ids with an in-flight fetch. */
  loading: Set<string>;
  /** source id → user-readable error string. */
  errors: Map<string, string>;
  /** True once the first loadIptvSources() has resolved. */
  loaded: boolean;
}

const _state: IptvState = {
  sources: [],
  playlists: new Map(),
  loading: new Set(),
  errors: new Map(),
  loaded: false,
};

/** In-flight fetch promises per source id, so concurrent refresh calls
 *  (e.g. a remount mid-fetch) share one network hop. */
const _inflight = new Map<string, Promise<void>>();

function emit(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeIptv(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
}

/** A snapshot for React reads. The collections are the live references —
 *  callers must not mutate them; treat as read-only. `useSyncExternalStore`
 *  consumers should derive a primitive/version from this rather than depend
 *  on referential identity (the maps are mutated in place). */
export function getIptvState(): Readonly<IptvState> {
  return _state;
}

// ---------------------------------------------------------------------------
// Settings round-trip
// ---------------------------------------------------------------------------

/** Load configured sources from Rust AppSettings and kick off a passive
 *  refresh of each. Idempotent enough to call on every LiveView mount —
 *  cached playlists within the TTL are reused. */
export async function loadIptvSources(): Promise<void> {
  let sources: IptvPlaylistSource[] = [];
  try {
    const s = await invoke<{ iptv_playlists?: IptvPlaylistSource[] }>("get_settings");
    sources = Array.isArray(s.iptv_playlists) ? s.iptv_playlists : [];
  } catch {
    sources = [];
  }
  _state.sources = sources;
  _state.loaded = true;
  emit();
  // Passive-refresh each source (TTL-gated; no-op if fresh).
  await Promise.all(sources.map((src) => refreshPlaylist(src.id).catch(() => {})));
}

/** Persist the current `sources` array to Rust settings. */
async function persistSources(): Promise<void> {
  try {
    await invoke("update_settings", { patch: { iptv_playlists: _state.sources } });
  } catch (e) {
    console.warn("[iptv] persist sources failed", e);
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** Add a new playlist source. For Xtream, `password` is written to the OS
 *  keyring (never persisted in settings). Returns the stored source and
 *  triggers an immediate (forced) fetch. */
export async function addPlaylistSource(
  input: Omit<IptvPlaylistSource, "id"> & { id?: string },
  password?: string,
): Promise<IptvPlaylistSource> {
  const id = input.id ?? `iptv_${Math.abs(hashString(input.url + ":" + input.name))}_${_state.sources.length}`;
  // Strip any password out of the persisted xtream object — keyring only.
  const xtream = input.xtream
    ? { server: input.xtream.server, username: input.xtream.username }
    : input.xtream;
  const source: IptvPlaylistSource = { ...input, id, xtream };

  if (password && password.length > 0) {
    try {
      await invoke("iptv_set_xtream_password", { playlistId: id, password });
    } catch (e) {
      console.warn("[iptv] keyring write failed", e);
    }
  }

  _state.sources = [..._state.sources.filter((s) => s.id !== id), source];
  emit();
  await persistSources();
  await refreshPlaylist(id, { force: true }).catch(() => {});
  return source;
}

/** Remove a source: drop from settings, clear its keyring password and
 *  cached playlist/error. */
export async function removePlaylistSource(id: string): Promise<void> {
  _state.sources = _state.sources.filter((s) => s.id !== id);
  _state.playlists.delete(id);
  _state.errors.delete(id);
  _state.loading.delete(id);
  emit();
  await persistSources();
  try {
    await invoke("iptv_clear_xtream_password", { playlistId: id });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

/** Fetch + parse a source's playlist into the cache. TTL-gated unless
 *  `force`. Concurrent calls share one in-flight promise. */
export function refreshPlaylist(id: string, opts?: { force?: boolean }): Promise<void> {
  const existing = _inflight.get(id);
  if (existing) return existing;

  const source = _state.sources.find((s) => s.id === id);
  if (!source) return Promise.resolve();

  // TTL gate — skip if we have a fresh parse and aren't forcing.
  const cached = _state.playlists.get(id);
  if (!opts?.force && cached && Date.now() - cached.fetchedAt < PARSE_TTL_MS) {
    return Promise.resolve();
  }

  const p = doFetch(source).finally(() => _inflight.delete(id));
  _inflight.set(id, p);
  return p;
}

async function doFetch(source: IptvPlaylistSource): Promise<void> {
  _state.loading.add(source.id);
  _state.errors.delete(source.id);
  emit();
  try {
    const playlist = await fetchAndParse(source);
    _state.playlists.set(source.id, playlist);
    _state.errors.delete(source.id);
  } catch (e) {
    _state.errors.set(source.id, classifyIptvError(e));
  } finally {
    _state.loading.delete(source.id);
    emit();
  }
}

/** Resolve a source to a parsed playlist. Phase 1 handles `m3u` (and any
 *  source whose url is a plain playlist). Xtream (`kind === "xtream"`) is
 *  wired in Phase 2 — for now it falls through to the M3U path using the
 *  source url, which already works for Xtream `get.php` playlist URLs. */
async function fetchAndParse(source: IptvPlaylistSource): Promise<IptvPlaylist> {
  const body = await iptvFetchText(source.url);
  if (!body.trim().startsWith("#EXTM3U") && !body.includes("#EXTINF")) {
    throw new Error("That URL didn't return an M3U playlist (no #EXTINF entries found).");
  }
  const { channels, epgUrl } = parseM3u(body, source.url);
  if (channels.length === 0) {
    throw new Error("The playlist parsed but contained no playable channels.");
  }
  const groups = [...groupChannels(channels).keys()];
  return {
    id: source.id,
    name: source.name,
    url: source.url,
    epgUrl: source.epgUrl ?? epgUrl,
    channels,
    fetchedAt: Date.now(),
    groups,
  };
}

// ---------------------------------------------------------------------------
// Error classification — turn raw fetch/parse errors (already partly
// classified by the Rust hop) into a single user-facing string.
// ---------------------------------------------------------------------------

export function classifyIptvError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  // The Rust iptv_fetch_text already returns friendly strings for HTTP
  // status / connection / timeout cases — pass those through verbatim.
  if (raw && raw.length > 0 && raw !== "[object Object]") return raw;
  return "Couldn't load this playlist. Check the URL and your connection.";
}

/** Tiny non-crypto string hash for synthetic ids (mirrors m3u.ts). */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}
