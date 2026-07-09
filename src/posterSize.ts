// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// posterSize — rewrite known poster-CDN URLs to a card-sized render width.
//
// Decoding a full-resolution master (TMDB `original` ~2000x3000, metahub
// `large`) into a ~180px grid card wastes GPU decode + texture memory, and a
// single oversized texture is expensive for the compositor to re-raster on
// every scroll frame — the exact "one heavy poster tanks the whole row" shape.
// CLAUDE.md's perf note is explicit: "pass server-resize width hints (like
// landscapeArt's w=640) instead of full-size masters into small tiles."
//
// Unknown hosts pass through UNCHANGED, so this can only ever reduce work — it
// never upsizes and never rewrites a URL it doesn't recognise.
// ---------------------------------------------------------------------------

/** Downsize a poster URL to roughly `targetW` CSS px (callers fold in hi-DPI,
 *  e.g. 360 for a 180px card on a 2x display). Passthrough on null / unknown
 *  host / an already-smaller rung. */
export function shrinkPoster(
  url: string | null | undefined,
  targetW = 360,
): string | null | undefined {
  if (!url) return url;

  // AIOMetadata poster proxy: /poster/{type}/{id}?fallback=<url>&lang=&key=.
  // It re-encodes server-side (same place its `/api/art/landscape?w=N` resize
  // lives), so ask it for a card-width render instead of the full-res master —
  // this proxy is where the library's posters come from and it currently serves
  // originals (a tvmaze `original_untouched` fallback lands as 3543x5315 = 19MP
  // decoded into a 180px tile). Host-agnostic (self-hosted instances allowed):
  // matched by the /poster/{type}/ path + a `fallback=` param. Harmless before
  // the proxy honours `w` (unknown query params are ignored). Skip if already
  // width-hinted. `&w=` because the proxy URL always carries `?fallback=`.
  if (/\/poster\/(?:movie|series)\//.test(url) && /[?&]fallback=/.test(url)) {
    return /[?&]w=\d+/.test(url) ? url : `${url}&w=${targetW}`;
  }

  // metahub (Cinemeta CDN): path-based sizes small | medium | large.
  //   https://images.metahub.space/poster/large/<ttID>/img
  // `large` is the wasteful rung; `medium` (~230w) covers a 180px card.
  const mh = url.match(/^(https?:\/\/images\.metahub\.space\/poster\/)(small|medium|large)(\/.*)$/i);
  if (mh) {
    const want = targetW <= 200 ? "small" : "medium";
    const rank: Record<string, number> = { small: 0, medium: 1, large: 2 };
    // Only ever downsize.
    return rank[mh[2].toLowerCase()] > rank[want] ? `${mh[1]}${want}${mh[3]}` : url;
  }

  // TMDB image CDN: /t/p/original or /t/p/wNNN.
  //   https://image.tmdb.org/t/p/original/<hash>.jpg
  const tmdb = url.match(/^(https?:\/\/image\.tmdb\.org\/t\/p\/)(original|w\d+)(\/.*)$/i);
  if (tmdb) {
    const rung = targetW <= 200 ? "w185" : targetW <= 400 ? "w342" : "w500";
    const cur = tmdb[2].toLowerCase();
    const curW = cur === "original" ? Infinity : parseInt(cur.slice(1), 10);
    const rungW = parseInt(rung.slice(1), 10);
    return curW > rungW ? `${tmdb[1]}${rung}${tmdb[3]}` : url;
  }

  return url;
}
