// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isSafeExternalUrl } from "./externalUrl";
import type { MetaDetail, MetaPreview } from "./types";
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
  /** URL to open. Already encoded. This is always safe to open as-is: when a
   *  `resolve` exists this is the SEARCH fallback, used if resolution fails. */
  url: string;
  /** A short host label used as the popup window title prefix. */
  source: string;
  /** Optional async upgrade, awaited on CLICK (never while building the menu,
   *  which must stay synchronous). Returns a direct title URL, or null to keep
   *  `url`. Used where the id is not in the meta and has to be resolved through
   *  a Tauri command. Resolving lazily also means we do no work for menu rows
   *  the user never clicks. */
  resolve?: () => Promise<string | null>;
}

/** Ids we can build direct links from, gathered from the meta id itself plus
 *  whatever the (optional) cached MetaDetail carries.
 *
 *  Stremio ids arrive in several shapes: a bare IMDb id (`tt0133093`), an
 *  EPISODE id whose head is the series-root IMDb id (`tt0903747:1:5`), or a
 *  namespaced id (`kitsu:12345`, `mal:5114`, `tmdb:603`). Splitting on `:` and
 *  reading the head covers all of them. */
function extractIds(meta: MetaPreview, detail?: MetaDetail | null) {
  const parts = (meta.id ?? "").split(":");
  const head = parts[0] ?? "";
  const num = /^\d+$/.test(parts[1] ?? "") ? Number(parts[1]) : null;
  const imdb = /^tt\d+$/.test(head) ? head : null;
  const scheme = imdb ? null : head;
  const tmdbFromScheme = scheme === "tmdb" ? num : null;
  return {
    imdb,
    tmdb:  tmdbFromScheme ?? detail?.tmdb_id ?? null,
    // WHERE the TMDB id came from, which decides what it is safe to use for.
    // A `tmdb:`-scheme id belongs to the namespace matching the meta's own
    // type, but `MetaDetail.tmdb_id` is a live-action SERIES id everywhere this
    // repo populates it (see types.ts and stremio.rs, and the `"tv"` hardcoded
    // at its publicmetadb and story-arc call sites). Only the scheme-sourced
    // one may be handed to a movie-only endpoint.
    tmdbFromScheme,
    mal:   scheme === "mal"   ? num : (detail?.mal_id   ?? null),
    kitsu: scheme === "kitsu" ? num : (detail?.kitsu_id ?? null),
  };
}

/** The movie/series bucket, or null when the meta genuinely does not say.
 *
 *  Must NOT be assumed: some addons omit `type` altogether (stremio.rs defaults
 *  it to an empty string), and QueueView builds stub previews with
 *  `media_type: "other"` for anything missing from the library index - which,
 *  for a signed-out user, is every queued tile. Falls back to the cached
 *  detail, the same preference CalendarView already applies. */
function resolveBucket(
  meta: MetaPreview,
  detail?: MetaDetail | null,
): "movie" | "series" | null {
  for (const raw of [meta.media_type, detail?.media_type]) {
    const t = (raw ?? "").toLowerCase();
    if (t === "movie") return "movie";
    if (t === "series" || t === "anime" || t === "tv" || t === "show") return "series";
  }
  return null;
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
export function sourcesForMeta(
  meta: MetaPreview,
  opts?: { detail?: MetaDetail | null; isAnime?: boolean },
): SourceLink[] {
  const out: SourceLink[] = [];
  const detail = opts?.detail ?? null;
  const bucket = resolveBucket(meta, detail);
  const isMovie = bucket === "movie";
  // The caller does a richer anime check than isAnimeMeta can manage on a
  // stripped preview (it consults the cached detail's mal/kitsu/anidb ids), so
  // prefer its answer and only fall back to our own.
  const anime = opts?.isAnime ?? isAnimeMeta(meta);
  const ids = extractIds(meta, detail);
  const q = encodeURIComponent(searchQuery(meta));

  if (anime) {
    // AniList. MUST be an ANILIST media id, never a MAL id. The two coincide
    // for some famous titles (Fullmetal Alchemist: Brotherhood is 5114 on
    // both) and diverge in general (Frieren is AniList 154587 / MAL 52991), so
    // cross-feeding them silently opens a real but WRONG anime - the worst
    // failure mode there is. MetaDetail carries no AniList id, so resolve it
    // on click through the Fribb id map and fall back to search on a miss.
    out.push({
      label:  ids.imdb ? "Open in AniList" : "Search AniList",
      source: "AniList",
      url:    `https://anilist.co/search/anime?search=${encodeURIComponent(meta.name)}`,
      resolve: ids.imdb
        ? () => resolveAnimeId("resolve_cour_anilist_id", ids.imdb!, "https://anilist.co/anime/")
        : undefined,
    });

    // MyAnimeList. Direct when the id is already known, else resolve on click.
    if (ids.mal != null) {
      out.push({
        label:  "Open in MyAnimeList",
        source: "MyAnimeList",
        url:    `https://myanimelist.net/anime/${ids.mal}`,
      });
    } else {
      out.push({
        label:  ids.imdb ? "Open in MyAnimeList" : "Search MyAnimeList",
        source: "MyAnimeList",
        url:    `https://myanimelist.net/anime.php?q=${encodeURIComponent(meta.name)}`,
        resolve: ids.imdb
          ? () => resolveAnimeId("resolve_cour_mal_id", ids.imdb!, "https://myanimelist.net/anime/")
          : undefined,
      });
    }

    // Kitsu. NOTE the domain: kitsu.io moved to kitsu.app, and the old host
    // only forwards via a CLIENT-SIDE redirect behind a "We've moved!" banner,
    // so emit kitsu.app directly.
    out.push(
      ids.kitsu != null
        ? {
            label:  "Open in Kitsu",
            source: "Kitsu",
            url:    `https://kitsu.app/anime/${ids.kitsu}`,
          }
        : {
            label:  "Search Kitsu",
            source: "Kitsu",
            url:    `https://kitsu.app/explore/anime?text=${encodeURIComponent(meta.name)}`,
          },
    );
    return out;
  }

  // ── Direct-id sources ──────────────────────────────────────────────
  if (ids.imdb) {
    out.push({
      label:  "Open in IMDb",
      source: "IMDb",
      url:    `https://www.imdb.com/title/${ids.imdb}/`,
    });
  }
  // TMDB needs a KNOWN bucket, not merely "not a movie". TMDB numbers films and
  // TV as independent sequences, so the wrong namespace is not an error page,
  // it is a real unrelated title: /movie/603 is The Matrix, /tv/603 is
  // "Veronica's Closet". Defaulting an unlabelled meta to "tv" would therefore
  // emit a confidently wrong link, and in a QueueView stub (media_type
  // "other") it would be the only direct-title row in the menu. Same rule as
  // Trakt below: no reliable bucket, no entry.
  if (ids.tmdb != null && bucket) {
    out.push({
      label:  "Open in TMDB",
      source: "TMDB",
      url:    `https://www.themoviedb.org/${bucket === "movie" ? "movie" : "tv"}/${ids.tmdb}`,
    });
  }

  // Trakt. The old `/search/imdb/{id}` route is GONE - it 301s to app.trakt.tv
  // and serves a hard 404 ("404: Nothingness. The void."), so every non-anime
  // right-click was offering a dead link. The live shapes are /movies/{imdb}
  // and /shows/{imdb}, which the SPA resolves from a tt id.
  //
  // TWO RULES, both load-bearing:
  //   1. Route by media type. A series id under /movies (or vice versa) renders
  //      Trakt's 404 rather than falling through. That is the SAFE failure: a
  //      visible error, never a wrong title.
  //   2. NEVER pass a bare numeric id. Trakt reads a numeric path segment as
  //      its OWN internal id, so handing it a TMDB id lands on a real but
  //      unrelated title with no error at all (trakt.tv/movies/603 is "The Mad
  //      Adventures of Rabbi Jacob", not The Matrix). No IMDb id, no entry.
  if (ids.imdb) {
    out.push({
      label:  "Open in Trakt",
      source: "Trakt",
      url:    `https://trakt.tv/${isMovie ? "movies" : "shows"}/${ids.imdb}`,
    });
  }

  // Letterboxd (films only). /imdb/ and /tmdb/ are real server-side 302s to
  // the film page, and being exact id lookups they never confuse remakes the
  // way a title search does. Prefer the IMDb id: the TMDB endpoint only knows
  // the MOVIE namespace, and TMDB numbers films and TV separately, so a series
  // tmdb_id would be looked up as a film number and can land on a wrong title.
  // The isMovie gate below is what makes using ids.tmdb safe here at all.
  if (isMovie) {
    // Only a SCHEME-sourced TMDB id may be used here. detail.tmdb_id is a
    // series id in this repo, and Letterboxd's /tmdb/ endpoint knows only the
    // movie namespace, so it would look that series number up as a film and
    // land on an unrelated title. The IMDb id is unambiguous and preferred.
    const lbDirect =
      ids.imdb  ? `https://letterboxd.com/imdb/${ids.imdb}/`
      : ids.tmdbFromScheme != null ? `https://letterboxd.com/tmdb/${ids.tmdbFromScheme}/`
      : null;
    out.push({
      label:  lbDirect ? "Open in Letterboxd" : "Search Letterboxd",
      source: "Letterboxd",
      url:    lbDirect ?? `https://letterboxd.com/search/${q}/`,
    });
  }

  // Rotten Tomatoes and Metacritic are SEARCH ONLY, deliberately and
  // permanently. Neither exposes any id-based endpoint (every /m/{tt},
  // /imdb/{tt}, /tmdb/{id} variant 404s), and their URLs are editorial slugs
  // with year suffixes that cannot be derived from a title: the naive slug for
  // "The Killer" is a 1972 Shaw Brothers film on RT and John Woo's 1989 film on
  // Metacritic, when the user most likely wants Fincher's 2023 one. Guessing
  // would open the WRONG film while looking perfectly successful, which is
  // worse than a search page. The labels say "Search" so the row does not
  // promise something it cannot deliver.
  out.push({
    label:  "Search Rotten Tomatoes",
    source: "Rotten Tomatoes",
    url:    `https://www.rottentomatoes.com/search?search=${q}`,
  });
  out.push({
    label:  "Search Metacritic",
    source: "Metacritic",
    url:    `https://www.metacritic.com/search/${q}/`,
  });

  return out;
}

/** Resolve an anime id through one of the Fribb-map Tauri commands and build a
 *  direct URL. Returns null on any miss or failure so the caller keeps its
 *  search fallback rather than opening something wrong. */
async function resolveAnimeId(
  command: "resolve_cour_mal_id" | "resolve_cour_anilist_id",
  imdbId: string,
  urlPrefix: string,
): Promise<string | null> {
  try {
    const id = await invoke<number | null>(command, { imdbId, season: null });
    return id != null && id > 0 ? `${urlPrefix}${id}` : null;
  } catch {
    return null;
  }
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

/** Open a source link, upgrading to a direct title URL first when the entry
 *  carries a `resolve`. Any failure (command error, unknown id, no mapping)
 *  falls through to the entry's static search URL, so a click can never
 *  no-op and can never open a URL we are not confident in. */
export async function openSourceLink(link: SourceLink): Promise<void> {
  let url = link.url;
  if (link.resolve) {
    try {
      const direct = await link.resolve();
      if (direct) url = direct;
    } catch {
      /* keep the search fallback */
    }
  }
  openInPopupBrowser(url, link.source);
}

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
    // Only hand http(s) to the shell opener; a non-web URL (an addon could
    // supply `file:` or a protocol handler) falls back to the sandboxed in-app
    // popup instead of ShellExecute.
    if (isSafeExternalUrl(url)) {
      openUrl(url).catch(popup);
      return;
    }
  }
  popup();
}
