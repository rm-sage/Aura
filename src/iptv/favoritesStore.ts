// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Live TV favourites — a cross-playlist star list. Same module-singleton +
// CustomEvent pub/sub shape as the other iptv stores, but persisted in
// localStorage (favourites are a tiny user list, not provider data, and want
// to survive without a settings round-trip).
//
// Each favourite is a SNAPSHOT of the channel plus the source it came from,
// so the "★ Favourites" view renders + plays without every origin playlist
// being loaded (a channel from a not-currently-selected provider still shows
// and plays — handlePlayChannel only needs channel.url/name/id + the source
// name). Identity is `${sourceId}::${channelId}` so the same logical channel
// in two playlists is two independent stars (matches the user's "favourite
// across multiple playlists" intent).
//
// MEMORY: hard-capped at MAX_FAVORITES, oldest-evicted, and persisted as one
// bounded JSON blob — no unbounded growth (the standing RAM directive).
// ---------------------------------------------------------------------------

import type { IptvChannel } from "./types";
import { safeSetItem } from "../storageQuota";
import { showAppToast } from "../AppToast";

export interface FavoriteChannel {
  /** `${sourceId}::${channel.id}` — stable cross-playlist identity. */
  key: string;
  sourceId: string;
  sourceName: string;
  channel: IptvChannel;
  addedAt: number;
}

const STORE_KEY = "aura.iptv.favorites";
const CHANGE_EVENT = "aura:iptv-favorites-changed";
/** Cap the persisted list — a star list is small by nature; this just
 *  bounds the blob so it can't balloon localStorage. Oldest-evicted. */
const MAX_FAVORITES = 500;

let _favorites: FavoriteChannel[] = load();
let _keys = new Set(_favorites.map((f) => f.key));

function load(): FavoriteChannel[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidFavorite).slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

function isValidFavorite(f: unknown): f is FavoriteChannel {
  const fav = f as FavoriteChannel;
  return (
    !!f &&
    typeof fav.key === "string" &&
    typeof fav.sourceId === "string" &&
    !!fav.channel &&
    // channel.id is the identity half of `key` — without it the un-star
    // recompute (favKey(sourceId, channel.id)) can't match the stored key.
    typeof fav.channel.id === "string" &&
    fav.channel.id.length > 0 &&
    typeof fav.channel.url === "string"
  );
}

/** One-shot guard so a wedged localStorage doesn't toast on every star toggle. */
let _warnedPersistFail = false;

function persist(): void {
  if (safeSetItem(STORE_KEY, JSON.stringify(_favorites))) return;
  // localStorage is the only home for favourites — a failed write means the
  // stars won't survive a restart. Keep it low-noise: one toast per session.
  if (!_warnedPersistFail) {
    _warnedPersistFail = true;
    showAppToast("Couldn't save favorites: local storage may be full.", { tone: "danger" });
  }
}

function emit(): void {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function subscribeFavorites(cb: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, cb);
  return () => window.removeEventListener(CHANGE_EVENT, cb);
}

export function favKey(sourceId: string, channelId: string): string {
  return `${sourceId}::${channelId}`;
}

export function isFavorite(sourceId: string, channelId: string): boolean {
  return _keys.has(favKey(sourceId, channelId));
}

/** The live favourites array (read-only — do not mutate). Insertion order. */
export function getFavorites(): readonly FavoriteChannel[] {
  return _favorites;
}

export function favoriteCount(): number {
  return _favorites.length;
}

/** Add or remove a channel from favourites (idempotent toggle). */
export function toggleFavorite(
  sourceId: string,
  sourceName: string,
  channel: IptvChannel,
): void {
  const key = favKey(sourceId, channel.id);
  if (_keys.has(key)) {
    _keys.delete(key);
    _favorites = _favorites.filter((f) => f.key !== key);
  } else {
    const entry: FavoriteChannel = {
      key,
      sourceId,
      sourceName,
      channel,
      addedAt: Date.now(),
    };
    _favorites = [..._favorites, entry];
    // Oldest-evict beyond the cap (keep the most-recent MAX_FAVORITES).
    if (_favorites.length > MAX_FAVORITES) {
      _favorites = [..._favorites]
        .sort((a, b) => b.addedAt - a.addedAt)
        .slice(0, MAX_FAVORITES);
      _keys = new Set(_favorites.map((f) => f.key));
    }
  }
  persist();
  emit();
}

/** Drop every favourite belonging to a removed source (called on playlist
 *  removal so dangling stars don't linger). No-op when none match. */
export function dropFavoritesForSource(sourceId: string): void {
  const before = _favorites.length;
  _favorites = _favorites.filter((f) => f.sourceId !== sourceId);
  if (_favorites.length === before) return;
  _keys = new Set(_favorites.map((f) => f.key));
  persist();
  emit();
}
