// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { openUrl } from "@tauri-apps/plugin-opener";
import type { MetaPreview } from "./types";
import { isAnimeMeta } from "./aiometadata";
import { loadAuraSettings } from "./auraSettings";

// ---------------------------------------------------------------------------
// externalSources — opens a meta in an external review/database site via an
// in-app Tauri WebviewWindow popup (NOT the system browser). Each entry
// builds a URL from the meta and exposes it as a context-menu entry.
//
// Why a Tauri WebviewWindow instead of an iframe? Most of these sites set
// `X-Frame-Options: DENY` or `frame-ancestors` CSPs that block iframe
// embedding. A separate WebviewWindow runs in its own browsing context
// outside the iframe sandbox, so the page loads normally — and because
// it's spawned by Aura's process (not handed off to the user's default
// browser via `shell:open`), it still feels in-app: same Aura icon in
// the taskbar, can be closed alongside Aura, etc.
// ---------------------------------------------------------------------------

export interface SourceLink {
  /** Display label in the right-click menu. */
  label: string;
  /** URL to open. Already encoded. */
  url: string;
  /** A short host label used as the popup window title prefix. */
  source: string;
}

/** All sources applicable to a given meta. Order matches menu rendering.
 *
 *  ANIME — when the meta resolves as anime (kitsu:/mal:/anidb: prefix or
 *  AIOMetadata's anime-genre flag), we surface ONLY anime-native
 *  databases (AniList / MAL / Kitsu). Live-action review sites
 *  (RT / Metacritic / Letterboxd) don't index anime well and the
 *  results are uniformly poor quality.
 *  EVERYTHING ELSE — surface IMDb / TMDB / Trakt / RT / Metacritic /
 *  Letterboxd (movies only). */
export function sourcesForMeta(meta: MetaPreview): SourceLink[] {
  const out: SourceLink[] = [];
  const isMovie = (meta.media_type ?? "").toLowerCase() === "movie";
  const anime = isAnimeMeta(meta);

  if (anime) {
    // AniList — search by name (numeric AniList ids aren't carried in
    // our meta shape, so the search page is the most reliable jumping-
    // off point; same pattern as RT / Metacritic for live-action).
    out.push({
      label:  "Open in AniList",
      source: "AniList",
      url:    `https://anilist.co/search/anime?search=${encodeURIComponent(meta.name)}`,
    });
    // MyAnimeList — same.
    out.push({
      label:  "Open in MyAnimeList",
      source: "MyAnimeList",
      url:    `https://myanimelist.net/anime.php?q=${encodeURIComponent(meta.name)}`,
    });
    // Kitsu — direct link if we have the id, otherwise search.
    if (meta.id.startsWith("kitsu:")) {
      out.push({
        label:  "Open in Kitsu",
        source: "Kitsu",
        url:    `https://kitsu.io/anime/${meta.id.slice("kitsu:".length)}`,
      });
    } else {
      out.push({
        label:  "Open in Kitsu",
        source: "Kitsu",
        url:    `https://kitsu.io/explore/anime?text=${encodeURIComponent(meta.name)}`,
      });
    }
    return out;
  }

  // Direct-id sources first — these jump straight to the title page.
  if (meta.id.startsWith("tt")) {
    out.push({
      label:  "Open in IMDb",
      source: "IMDb",
      url:    `https://www.imdb.com/title/${meta.id}/`,
    });
  }
  if (meta.id.startsWith("tmdb:")) {
    const tmdbId = meta.id.slice("tmdb:".length);
    const kind = isMovie ? "movie" : "tv";
    out.push({
      label:  "Open in TMDB",
      source: "TMDB",
      url:    `https://www.themoviedb.org/${kind}/${tmdbId}`,
    });
  }

  // Trakt accepts a search-by-imdb deep link that resolves both movies
  // and series; fall back to a name search for non-IMDb ids.
  if (meta.id.startsWith("tt")) {
    out.push({
      label:  "Open in Trakt",
      source: "Trakt",
      url:    `https://trakt.tv/search/imdb/${meta.id}`,
    });
  } else {
    out.push({
      label:  "Open in Trakt",
      source: "Trakt",
      url:    `https://trakt.tv/search?query=${encodeURIComponent(searchQuery(meta))}`,
    });
  }

  // Search-only sources — RT / Metacritic / Letterboxd don't expose a
  // stable id mapping from IMDb / TMDB, so we hand the user off to the
  // site's search results page with the title (+ year when available)
  // prefilled. The popup lets them click through with a single tap.
  out.push({
    label:  "Open in Rotten Tomatoes",
    source: "Rotten Tomatoes",
    url:    `https://www.rottentomatoes.com/search?search=${encodeURIComponent(searchQuery(meta))}`,
  });
  out.push({
    label:  "Open in Metacritic",
    source: "Metacritic",
    url:    `https://www.metacritic.com/search/${encodeURIComponent(searchQuery(meta))}/`,
  });
  if (isMovie) {
    out.push({
      label:  "Open in Letterboxd",
      source: "Letterboxd",
      url:    `https://letterboxd.com/search/${encodeURIComponent(searchQuery(meta))}/`,
    });
  }

  return out;
}

/** Title + year (when available) — gives the search engines on RT /
 *  Metacritic / Letterboxd the best shot at disambiguation. */
function searchQuery(meta: MetaPreview): string {
  const year = (meta.release_info ?? "").trim();
  if (year) return `${meta.name} ${year}`;
  return meta.name;
}

// ---------------------------------------------------------------------------
// Popup browser — fires a CustomEvent picked up by SourcePopupHost,
// which renders an in-app modal containing a child Tauri Webview. See
// SourcePopup.tsx for the rendering pipeline.
//
// Why an event bus instead of a direct call: the sites firing this
// (App.tsx context menu items) shouldn't have to import / be aware of
// the host component's lifecycle. Same loose-coupling pattern Aura
// already uses for ContextMenu open / library-changed / etc.
// ---------------------------------------------------------------------------

const OPEN_EVENT = "aura:open-source-popup";

/** Open an external source. Default: the in-app popup webview (event
 *  → SourcePopupHost). When the user has opted into
 *  `openLinksExternally`, hand off to the system browser instead; if
 *  that throws (e.g. missing opener permission on an old WebView2
 *  build) fall back to the popup so the action never silently no-ops. */
export function openInPopupBrowser(url: string, title: string): void {
  const popup = () =>
    window.dispatchEvent(
      new CustomEvent(OPEN_EVENT, { detail: { url, title } }),
    );
  if (loadAuraSettings().openLinksExternally) {
    openUrl(url).catch(popup);
    return;
  }
  popup();
}
