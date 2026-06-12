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
import { fetchXtreamLiveChannels, buildXtreamUrls, type XtreamCreds } from "./xtream";
import { dropEpg } from "./epgStore";
import type { IptvPlaylist, IptvPlaylistSource } from "./types";

const CHANGE_EVENT = "aura:iptv-changed";
/** Re-fetch a source's playlist at most this often on passive refresh. A
 *  manual refresh (force) bypasses it. 30 min balances "channels rarely
 *  change" against a stale list after the provider adds channels. */
const PARSE_TTL_MS = 30 * 60 * 1000;

/** Bundled, always-offered default playlist: iptv-org's free global index +
 *  the iptv-epg.org US XMLTV guide (gzip, matched via the resolver's tvg-id +
 *  name fallback; US-focused so it won't cover every global channel).
 *  Seeded ONCE per install (see loadIptvSources) so a new user has something to
 *  try Live TV with; fully removable afterward. */
const DEFAULT_PLAYLIST: IptvPlaylistSource = {
  id: "iptv_org",
  name: "iptv-org (Free)",
  url: "https://iptv-org.github.io/iptv/index.m3u",
  kind: "m3u",
  epgUrl: "https://iptv-epg.org/files/epg-us.xml.gz",
};
const DEFAULT_SEEDED_KEY = "aura.iptv.defaultSeeded";
/** The previous bundled-default EPG URL. Existing installs that were seeded
 *  with it are migrated ONCE to the current `DEFAULT_PLAYLIST.epgUrl` (a user
 *  who set their own EPG is untouched — only the exact old default matches). */
const OLD_DEFAULT_EPG = "https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz";
const EPG_MIGRATION_KEY = "aura.iptv.defaultEpgMigratedV2";

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
  /** Playlist id Live TV auto-selects on open (persisted in AppSettings).
   *  null = no default → fall back to the first source. */
  defaultId: string | null;
}

const _state: IptvState = {
  sources: [],
  playlists: new Map(),
  loading: new Set(),
  errors: new Map(),
  loaded: false,
  defaultId: null,
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
    const s = await invoke<{ iptv_playlists?: IptvPlaylistSource[]; iptv_default_playlist_id?: string | null }>(
      "get_settings",
    );
    sources = Array.isArray(s.iptv_playlists) ? s.iptv_playlists : [];
    _state.defaultId = s.iptv_default_playlist_id ?? null;
  } catch {
    sources = [];
  }
  // One-time EPG migration: the bundled default's EPG URL changed. Rewrite any
  // source still on the OLD default EPG to the new one — a user who set a
  // custom EPG is untouched (only the exact old default matches). Runs once.
  try {
    if (!localStorage.getItem(EPG_MIGRATION_KEY)) {
      localStorage.setItem(EPG_MIGRATION_KEY, "1");
      let migrated = false;
      sources = sources.map((s) => {
        if (s.epgUrl === OLD_DEFAULT_EPG) {
          migrated = true;
          return { ...s, epgUrl: DEFAULT_PLAYLIST.epgUrl };
        }
        return s;
      });
      if (migrated) {
        _state.sources = sources;
        await persistSources();
      }
    }
  } catch {
    /* localStorage unavailable — skip migration */
  }
  // Seed the bundled iptv-org playlist ONCE per install (so a new user has a
  // working Live TV starting point), then never force it again — the user can
  // remove it permanently. Deduped by URL so the current user's existing
  // iptv-org entry isn't duplicated.
  let seededNow = false;
  try {
    if (!localStorage.getItem(DEFAULT_SEEDED_KEY)) {
      localStorage.setItem(DEFAULT_SEEDED_KEY, "1");
      if (!sources.some((s) => s.url === DEFAULT_PLAYLIST.url)) {
        sources = [DEFAULT_PLAYLIST, ...sources];
        seededNow = true;
      }
    }
  } catch {
    /* localStorage unavailable — skip seeding */
  }
  _state.sources = sources;
  _state.loaded = true;
  if (seededNow) await persistSources();
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

/** Edit an existing source in place. Applies the provided fields, optionally
 *  updates the keyring password (Xtream only; empty/undefined = keep the
 *  current one), persists, and force-refetches so the change takes effect.
 *  The Xtream object is stripped of any password before persisting (keyring
 *  only), mirroring addPlaylistSource. */
export async function updatePlaylistSource(
  id: string,
  patch: Partial<Pick<IptvPlaylistSource, "name" | "url" | "epgUrl" | "xtream" | "proxyUrl">>,
  password?: string,
): Promise<void> {
  const idx = _state.sources.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const cur = _state.sources[idx];
  const xtream = patch.xtream
    ? { server: patch.xtream.server, username: patch.xtream.username }
    : patch.xtream;
  const next: IptvPlaylistSource = {
    ...cur,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.url !== undefined ? { url: patch.url } : {}),
    ...(patch.epgUrl !== undefined ? { epgUrl: patch.epgUrl } : {}),
    ...(patch.xtream !== undefined ? { xtream } : {}),
    ...(patch.proxyUrl !== undefined ? { proxyUrl: patch.proxyUrl } : {}),
  };
  _state.sources = [..._state.sources.slice(0, idx), next, ..._state.sources.slice(idx + 1)];

  if (password && password.length > 0) {
    try {
      await invoke("iptv_set_xtream_password", { playlistId: id, password });
    } catch (e) {
      console.warn("[iptv] keyring write failed", e);
    }
  }

  // The cached playlist/EPG are now stale (url/creds/epg may have changed).
  _state.playlists.delete(id);
  // If the EPG URL changed — especially CLEARED to null — drop the cached
  // EPG too. loadEpg() early-returns on a null url, so without this the old
  // EPG would linger (hasEpg stays true, guide keeps serving removed
  // programmes) until an unrelated LRU eviction or restart.
  if (patch.epgUrl !== undefined && patch.epgUrl !== cur.epgUrl) {
    dropEpg(id);
  }
  emit();
  await persistSources();
  await refreshPlaylist(id, { force: true }).catch(() => {});
}

/** Remove a source: drop from settings, clear its keyring password and
 *  cached playlist/error. Clears the default if it pointed here. */
export async function removePlaylistSource(id: string): Promise<void> {
  _state.sources = _state.sources.filter((s) => s.id !== id);
  _state.playlists.delete(id);
  _state.errors.delete(id);
  _state.loading.delete(id);
  const wasDefault = _state.defaultId === id;
  if (wasDefault) _state.defaultId = null;
  emit();
  await persistSources();
  if (wasDefault) {
    try {
      await invoke("update_settings", { patch: { iptv_default_playlist_id: null } });
    } catch (e) {
      console.warn("[iptv] clear default failed", e);
    }
  }
  try {
    await invoke("iptv_clear_xtream_password", { playlistId: id });
  } catch {
    /* best effort */
  }
}

/** Set (or clear, with null) the default playlist that Live TV auto-selects
 *  on open. Persisted in AppSettings so it syncs + backs up. Passing the id
 *  that is already the default toggles it off. */
export async function setDefaultPlaylist(id: string | null): Promise<void> {
  const next = _state.defaultId === id ? null : id;
  _state.defaultId = next;
  emit();
  try {
    await invoke("update_settings", { patch: { iptv_default_playlist_id: next } });
  } catch (e) {
    console.warn("[iptv] set default failed", e);
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

/** Resolve a source to a parsed playlist. `xtream` uses the player API
 *  (categories + live streams) with the keyring password merged in;
 *  everything else is fetched as an M3U body. */
async function fetchAndParse(source: IptvPlaylistSource): Promise<IptvPlaylist> {
  if (source.kind === "xtream" && source.xtream) {
    const password = await getXtreamPassword(source.id);
    if (!password) {
      throw new Error("No saved password for this Xtream login. Remove and re-add it.");
    }
    const creds: XtreamCreds = {
      base: source.xtream.server,
      username: source.xtream.username,
      password,
    };
    const channels = await fetchXtreamLiveChannels(creds);
    if (channels.length === 0) {
      throw new Error("Xtream returned no live channels (check the subscription / credentials).");
    }
    const groups = [...groupChannels(channels).keys()];
    // EPG URL is derived fresh (carries the keyring password) — never
    // persisted. The in-memory playlist holds it only for the EPG phase.
    const epgUrl = source.epgUrl ?? buildXtreamUrls(creds).epg;
    return {
      id: source.id,
      name: source.name,
      url: source.url,
      epgUrl,
      channels,
      fetchedAt: Date.now(),
      groups,
      proxyUrl: source.proxyUrl ?? null,
    };
  }

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
    proxyUrl: source.proxyUrl ?? null,
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

/** Read an Xtream login's password from the OS keyring (empty when
 *  absent / keyring unavailable). */
async function getXtreamPassword(playlistId: string): Promise<string> {
  try {
    return await invoke<string>("iptv_get_xtream_password", { playlistId });
  } catch {
    return "";
  }
}

/** Tiny non-crypto string hash for synthetic ids (mirrors m3u.ts). */
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h;
}
