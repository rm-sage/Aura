// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// logodev — Logo.dev brand-logo image API (https://img.logo.dev/{domain}).
//
// Used for compact rating-source icons (and any other brand glyph that
// saves space vs. a text label). The token is a PUBLISHABLE key —
// Logo.dev's design has it living in the client; safe to ship in the
// bundle. `format=png` is deliberate (transparent background, vs. jpg's
// white box which would look broken on Aura's dark surfaces). `retina`
// keeps it crisp when rendered small. `fallback=404` makes the API
// return a real 404 when a brand has no logo, so <BrandLogo> can swap
// in a styled text fallback that matches the surrounding chip instead
// of Logo.dev's generic monogram.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

export const LOGODEV_PUBLISHABLE_KEY = "pk_fkGWFYlzQMebhze1-a9JYw";

export interface LogoOpts {
  /** 1-800, default 64 (rendered small + retina). */
  size?: number;
  format?: "png" | "jpg" | "webp";
  theme?: "auto" | "light" | "dark";
  greyscale?: boolean;
  retina?: boolean;
  fallback?: "monogram" | "404";
}

export function logoUrl(domain: string, opts: LogoOpts = {}): string {
  const p = new URLSearchParams({ token: LOGODEV_PUBLISHABLE_KEY });
  p.set("size", String(opts.size ?? 64));
  p.set("format", opts.format ?? "png");
  if (opts.theme) p.set("theme", opts.theme);
  if (opts.greyscale) p.set("greyscale", "true");
  if (opts.retina ?? true) p.set("retina", "true");
  p.set("fallback", opts.fallback ?? "404");
  return `https://img.logo.dev/${encodeURIComponent(domain)}?${p.toString()}`;
}

/** Map a rating-source label (as returned by the meta aggregators) to a
 *  brand domain Logo.dev can resolve. Null = not a known logo'd brand
 *  (caller shows a text label instead). */
export function ratingDomain(source: string): string | null {
  const s = source.toLowerCase();
  if (s.includes("imdb")) return "imdb.com";
  if (s.includes("rotten") || s === "rt") return "rottentomatoes.com";
  if (s.includes("metacritic") || s.includes("metascore")) return "metacritic.com";
  if (s.includes("myanimelist") || s.includes("mal")) return "myanimelist.net";
  if (s.includes("tmdb") || s.includes("the movie")) return "themoviedb.org";
  if (s.includes("anilist")) return "anilist.co";
  if (s.includes("kitsu")) return "kitsu.io";
  if (s.includes("trakt")) return "trakt.tv";
  if (s.includes("letterboxd")) return "letterboxd.com";
  return null;
}

/** Stable regroup so same-brand rating rows sit together (e.g. all MAL tiles:
 *  score + rank + popularity, which carry different `source` strings). Preserves
 *  input order WITHIN and BETWEEN brands — callers sort by weight first, then
 *  this clusters by brand with each brand positioned at its highest-weight
 *  (= first-seen) member. Unknown sources (ratingDomain null) group on the
 *  lowercased source string. */
export function groupRatingsByBrand<T extends { source: string }>(rows: T[]): T[] {
  const order: string[] = [];
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = ratingDomain(r.source) ?? r.source.toLowerCase();
    let g = groups.get(key);
    if (!g) { g = []; groups.set(key, g); order.push(key); }
    g.push(r);
  }
  return order.flatMap((k) => groups.get(k)!);
}

/** Tooltip suffix disambiguating critic vs audience — ONLY for the
 *  sources that actually publish both axes (Rotten Tomatoes'
 *  Tomatometer vs Audience Score, Metacritic's Metascore vs User
 *  Score). Single-figure aggregate sites (IMDb, TMDB, Trakt,
 *  Letterboxd, MyAnimeList, AniList) don't differentiate, so the
 *  suffix would be noise → "". Mirrors DetailView's ratingLabelFor so
 *  the detail page and the hover card read identically. */
export function ratingKindNote(source: string, kind?: string): string {
  const suffix =
    kind === "critic"   ? " · CRITIC"
  : kind === "audience" ? " · AUDIENCE"
  : "";
  if (!suffix) return "";
  return /rotten tomatoes|metacritic/i.test(source) ? suffix : "";
}

/** Brand glyph with a graceful, styled fallback. Renders the Logo.dev
 *  image; on a 404 / network error (offline, unknown brand) it renders
 *  `fallback` instead — so callers keep full control of the missing
 *  state (a palette-matched text label, usually). `domain` may be null
 *  (→ straight to fallback) so callers can pass `ratingDomain(src)`
 *  directly. */
export function BrandLogo({
  domain, alt, size = 64, className, fallback,
}: {
  domain: string | null;
  alt: string;
  size?: number;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  // Reset when the domain changes so a recycled component instance
  // re-attempts for the new brand instead of staying on the fallback.
  useEffect(() => { setFailed(false); }, [domain]);

  if (!domain || failed) return <>{fallback}</>;
  return (
    <img
      src={logoUrl(domain, { size, format: "png", retina: true, fallback: "404" })}
      alt={alt}
      draggable={false}
      loading="lazy"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
