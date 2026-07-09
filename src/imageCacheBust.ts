// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// imageCacheBust — a monotonic "image epoch" that force-refetches every image.
//
// The webview (WebView2) caches poster / backdrop / logo bytes on disk keyed by
// URL, so a SERVER-SIDE image change (an RPDB size switch, the AIOMetadata proxy
// adding a `w` resize, a swapped poster) keeps painting the STALE cached bytes
// for the same URL. Bumping the epoch appends `_ic=<n>` to every image URL — a
// fresh cache key, so the webview refetches once at the new size, then caches
// normally again. Persisted so it survives restarts (and doesn't refetch on
// every launch); DEVICE-LOCAL and never cloud-synced — each device's webview
// cache is its own. Bumped from Settings > Storage > "Reload cached posters".
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

const KEY = "aura:img-epoch";

function read(): number {
  try {
    const n = parseInt(localStorage.getItem(KEY) ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

let epoch = read();
const listeners = new Set<() => void>();

/** Increment the epoch → every mounted ImageLoader re-renders with a fresh
 *  cache-busted src, forcing a one-time refetch of all images. Persisted. */
export function bumpImageEpoch(): void {
  epoch += 1;
  try { localStorage.setItem(KEY, String(epoch)); } catch { /* ignore */ }
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React binding — re-renders the caller whenever the epoch bumps. */
export function useImageEpoch(): number {
  return useSyncExternalStore(subscribe, () => epoch, () => epoch);
}

/** Append the cache-bust token to an http(s) URL. No-op at epoch 0 and for
 *  data: / blob: / empty srcs (which have no server cache to bust). */
export function withImageBust(url: string, ep: number): string;
export function withImageBust(url: string | null | undefined, ep: number): string | null | undefined;
export function withImageBust(url: string | null | undefined, ep: number): string | null | undefined {
  if (!url || ep <= 0 || !/^https?:/i.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}_ic=${ep}`;
}
