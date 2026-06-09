// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// landscapeArt — resolved 16:9 art for Continue-Watching cards.
//
// AIOMeta owns art RESOLUTION (Fanart thumb → AniList banner → TMDB backdrop
// → TVDB bg → poster-crop, with the language/provider matching and id
// resolution Aura can't replicate client-side); Aura owns the RENDER
// decision. This module is the thin client over AIOMeta's per-user art
// endpoint:
//
//   GET {aioBase}/api/art/landscape/{type}/{id}.json[?w=N]
//
// It mirrors metaCache's shape (single-flight via dedupedInvoke + a
// module-level Map) but stays in-memory only — art URLs are stable and the
// CW row is small (≤8 cards), so there's no need to persist a blob to
// localStorage.
//
// AIOMeta is the art source-of-truth, so the card prefers AIOMeta's resolved
// `landscape` over the library item's own `background`: only AIOMeta knows
// whether the chosen image already has a baked-in title (`hasBakedTitle`),
// which is what drives Aura's logo-overlay decision. A title-less backdrop
// (e.g. Cyberpunk: Edgerunners) thus still reads its name via an overlaid
// logo. This means we fetch for EVERY CW item (not just background-less
// ones). Until AIOMeta deploys the endpoint the Rust command returns an
// empty result and the card falls back to its existing `background ??
// poster` chain, so this is inert (not broken) before the server side ships.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry } from "./types";
import { dedupedInvoke } from "./invokeDedupe";

export interface LandscapeArt {
  id: string;
  /** Chosen 16:9 image URL, or null when AIOMeta found nothing usable. */
  landscape: string | null;
  /** Provenance: "fanart-thumb" | "anilist-banner" | "tmdb-backdrop" |
   *  "tvdb-bg" | "poster-crop". */
  source: string | null;
  /** True when the title is already burned into `landscape` — render the
   *  image alone; otherwise the client may overlay `logo` + a scrim. */
  has_baked_title: boolean;
  /** Language-matched logo for overlay when `has_baked_title` is false. */
  logo: string | null;
  /** Vertical poster fallback so the client never shows a blank tile. */
  poster: string | null;
  /** Optional dominant colour (`#rrggbb`) for scrim / loading placeholder. */
  dominant_color: string | null;
}

// Target render width hint sent to AIOMeta for server-side resize. Sized at
// ~2× the widest CW tile (ultrawide renders 8 columns) so the art is crisp
// without pulling 1920px masters into a ~320px box.
export const LANDSCAPE_CARD_WIDTH = 640;

// `undefined` = never fetched; a stored value (possibly null) = fetched, so
// a miss isn't re-requested on every card remount / scroll.
const cache = new Map<string, LandscapeArt | null>();
const keyFor = (mediaType: string, id: string, width?: number) =>
  `${mediaType}::${id}::${width ?? ""}`;

/** Fetch (and cache) resolved landscape art for one title. Best-effort:
 *  any failure resolves to null and the caller falls back to its own art. */
export async function getLandscapeArt(
  addon: AddonEntry,
  mediaType: string,
  id: string,
  width?: number,
): Promise<LandscapeArt | null> {
  const k = keyFor(mediaType, id, width);
  if (cache.has(k)) return cache.get(k) ?? null;
  const res = await dedupedInvoke(`art:${addon.url}::${k}`, () =>
    invoke<LandscapeArt>("fetch_landscape_art", {
      addonUrl: addon.url,
      mediaType,
      id,
      width: width ?? null,
    }).catch(() => null),
  );
  // Treat a result with no usable image as a miss so the card falls back.
  const val: LandscapeArt | null =
    res && (res.landscape || res.poster) ? res : null;
  cache.set(k, val);
  return val;
}

/**
 * Resolved landscape art for a Continue-Watching item, or null when none is
 * available. Fetches whenever the user has AIOMeta installed (the resolved
 * art + its `hasBakedTitle` are needed even for items that already have a
 * `background`, to decide the logo overlay). Returns null immediately when
 * there's no AIOMeta addon, so the card keeps its current art chain.
 */
export function useLandscapeArt(
  item: { id: string; media_type: string } | null | undefined,
  aioAddon: AddonEntry | null,
  width: number = LANDSCAPE_CARD_WIDTH,
): LandscapeArt | null {
  const wantFetch = !!item && !!aioAddon;
  const k = item ? keyFor(item.media_type, item.id, width) : "";
  const [art, setArt] = useState<LandscapeArt | null>(
    () => (wantFetch && cache.has(k) ? cache.get(k) ?? null : null),
  );
  useEffect(() => {
    if (!wantFetch || !item || !aioAddon) {
      setArt(null);
      return;
    }
    if (cache.has(k)) {
      setArt(cache.get(k) ?? null);
      return;
    }
    let cancelled = false;
    getLandscapeArt(aioAddon, item.media_type, item.id, width)
      .then((r) => { if (!cancelled) setArt(r); })
      .catch(() => { if (!cancelled) setArt(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k, wantFetch, aioAddon?.url]);
  return art;
}
