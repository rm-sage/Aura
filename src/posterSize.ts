// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// posterSize: deliver card-sized poster bytes to the WebView2 layer.
//
// Decoding a full-resolution master (TMDB `original` ~2000x3000, metahub
// `large`, a raw kitsu/anilist anime cover at 3+ MP) into a ~180px grid card
// wastes GPU decode + texture memory, and a single oversized texture is
// expensive for the compositor to re-raster every scroll frame (the "one heavy
// poster tanks the whole row" shape).
//
// Two layers, applied in order by `shrinkPoster`:
//   1. CDN size hint (`applyCdnSizeHint`): rewrites URLs whose host exposes a
//      size knob (AIOMetadata `/poster?...&w=`, metahub path rung, TMDB `wNNN`)
//      so the FIRST fetch is already smaller. Unknown hosts pass through.
//   2. On-device resize proxy (`proxyImage`): wraps the result in Aura's Rust
//      `/img?url=&w=` endpoint, which fetches once, resizes in native code,
//      disk-caches, and serves card-sized bytes. This is what actually shrinks
//      the raw kitsu/anilist covers, which expose no size param at all. The
//      proxy degrades to the original URL on any failure, so a poster never
//      renders worse than without it.
//
// Both layers only ever reduce work and never upsize.
// ---------------------------------------------------------------------------

// Loopback bridge that hosts the resize proxy (streaming.rs `BRIDGE_PORT`).
// 127.0.0.1 is a trustworthy origin, so the app's secure context loads it
// without mixed-content blocking, and the CSP allows `http://127.0.0.1:*`.
const IMG_PROXY_BASE = "http://127.0.0.1:11471/img";

/** Apply a host-specific size hint so the first fetch is smaller. Unknown hosts
 *  pass through unchanged. Never upsizes.
 *
 *  NOTE: no AIOMetadata `/poster?...&w=` hint. That was dropped: no server
 *  producer emits it, the handler ignores it, and post its ETag fix the param
 *  forks the validator (a distinct cache entry for byte-identical content) and
 *  misses the nginx poster-cache's warmed no-`w` entries. The on-device resize
 *  proxy handles the `/poster` bytes regardless, so the hint was pure cost. */
function applyCdnSizeHint(url: string, targetW: number): string {
  // metahub (Cinemeta CDN): path-based sizes small | medium | large.
  const mh = url.match(/^(https?:\/\/images\.metahub\.space\/poster\/)(small|medium|large)(\/.*)$/i);
  if (mh) {
    const want = targetW <= 200 ? "small" : "medium";
    const rank: Record<string, number> = { small: 0, medium: 1, large: 2 };
    return rank[mh[2].toLowerCase()] > rank[want] ? `${mh[1]}${want}${mh[3]}` : url;
  }

  // TMDB image CDN: /t/p/original or /t/p/wNNN.
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

/** True for a loopback / private / link-local / CGNAT host. The resize proxy's
 *  SSRF guard rejects these server-side, so wrapping them would just burn a
 *  degrade round-trip on every render. A self-hosted AIOMetadata on localhost /
 *  LAN is the common case (its `/poster` URLs are already RPDB-small anyway). */
function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (!m) return false;
  const a = +m[1], b = +m[2];
  return (
    a === 127 || a === 10 || a === 0 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** Route a remote http(s) poster through Aura's on-device resize proxy.
 *  Passthrough for non-http (data:, blob:), the bridge itself, and private /
 *  loopback hosts (which the proxy's SSRF guard would reject anyway). */
function proxyImage(url: string, targetW: number): string {
  if (!/^https?:\/\//i.test(url)) return url;
  // Don't double-wrap or point the proxy at the bridge itself.
  if (/\/\/(?:127\.0\.0\.1|localhost):11471\b/.test(url)) return url;
  // Already server-resized by the addon (e.g. AIOMetadata's
  // /api/image/banner-to-background for AniList art): re-proxying would just
  // re-fetch + re-encode an image that's already sized.
  if (url.includes("/api/image/")) return url;
  if (isPrivateHost(url)) return url;
  return `${IMG_PROXY_BASE}?w=${targetW}&url=${encodeURIComponent(url)}`;
}

/** Physical horizontal resolution of the display, for FULL-BLEED art (hero /
 *  detail backdrops) so it stays sharp on a 4K / ultrawide panel while a 1080p
 *  screen only pulls ~1920px. Clamped so a tiny window still gets a decent
 *  backdrop and the proxy's 4096 ceiling is respected. */
export function screenWidthHint(): number {
  if (typeof window === "undefined") return 1920;
  const w = window.screen?.width || window.innerWidth || 1920;
  const dpr = window.devicePixelRatio || 1;
  return Math.min(4096, Math.max(1280, Math.round(w * dpr)));
}

/** Downsize a poster URL to roughly `targetW` CSS px (callers fold in hi-DPI,
 *  e.g. 360 for a 180px card on a 2x display). Applies the CDN size hint, then
 *  wraps in the on-device resize proxy. Passthrough on null / non-http. */
export function shrinkPoster(
  url: string | null | undefined,
  targetW = 360,
): string | null | undefined {
  if (!url) return url;
  return proxyImage(applyCdnSizeHint(url, targetW), targetW);
}
