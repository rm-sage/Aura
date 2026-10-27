// The skip chain's MAL cour resolution, shared by the live chain (App.tsx's
// skip chain, every episode load) and the next-episode pre-scan (App.tsx,
// nextPrescan.ts). Both MUST pick the same cour: the detector's result cache
// serves a request only for the MAL id it was computed for, so a pre-scan that
// resolved the cour any other way would warm an entry the load never reads.
//
// The cascade is the live chain's, moved here unchanged (steps, order, network
// calls and log lines). Side effects that belong to a LOAD (markAnimeId, the
// skipCourRef the theme prefetch reads) stay at the live call site.

import { invoke } from "@tauri-apps/api/core";
import type { MetaDetail } from "./types";

/** The parts of a playback target the cascade reads. */
export interface SkipCourTarget {
  id: string;
  series_id?: string;
  season?: number;
  episode_num?: number;
}

export interface SkipCour {
  /** The cour's MAL id, or null when nothing resolved (live action, or an
   *  anime no step could name). */
  malId: number | null;
  /** "aiometadata" (the video's own pair), "anilist" (its AniList pair
   *  resolved), else null (the caller logs "aniskip"). */
  malSource: string | null;
  /** The episode LOCAL to the cour, from Step 0's pair; null otherwise. */
  courEpisode: number | null;
  /** A tt-keyed season > 1: the series-level steps (2 and 3) were skipped,
   *  since every one of them names the first cour. */
  laterSeasonTt: boolean;
  /** The id's last segment as a number (NaN when it is not one). */
  idEpisode: number;
  /** The addon's own episode number within its season (TVDB / TMDB
   *  shaped): PublicMetaDB is keyed by it. May be NaN. */
  seasonEpisodeNum: number;
  /** The episode LOCAL to the MAL entry (AniSkip, its cache key, skip_ref,
   *  the neighbour profile, theme songs, the detector's mal_episode). May be
   *  NaN. */
  episodeNum: number;
}

/**
 * Resolve the COUR-SPECIFIC MAL id. AniSkip keys by MAL anime id and MAL
 * splits multi-cour shows into separate entries: Frieren's cour 1 is MAL 52991
 * (eps 1-28), cour 2 is MAL 59978 (eps 1-10 LOCAL). Querying cour 1's MAL id
 * with the absolute episode 37 returns 404 (cour 1 ends at 28); querying cour
 * 2's MAL id with local episode 9 returns the correct timings.
 *
 * Resolution priority:
 *   0. The playing video's own cour ids from the addon (mal_id/mal_episode,
 *      else anilist_id/anilist_episode), used only as a whole pair.
 *   1. Anime-prefix video id (kitsu/mal/anidb/anilist): extract the
 *      cour-specific show id from target.id and resolve via yuna.moe.
 *      AIOMetadata's cour-aggregation patch encodes the cour-specific provider
 *      id directly, so this is exact.
 *   1.5. A tt-keyed season > 1: the season-aware resolver.
 *   2. detail.mal_id / detail.kitsu_id / detail.anidb_id / detail.anilist_id:
 *      show-root anime ids from the meta detail. These are typically cour 1's
 *      ids for multi-cour shows, so they only match for cour 1 playback.
 *   3. Title-based search: last-resort exact-title match.
 * 2 and 3 never run for a tt-keyed season > 1 (laterSeasonTt): they name the
 * first cour.
 *
 * `log: false` silences the cascade's `[aniskip]` lines (the pre-scan logs its
 * own summary instead, so a background resolve is not mistaken for the
 * playing episode's).
 */
export async function resolveSkipCour(
  target: SkipCourTarget,
  detail: MetaDetail | null,
  opts: { log?: boolean } = {},
): Promise<SkipCour> {
  const log = opts.log !== false;
  let malId: number | null = null;
  const tryResolve = async (src: "kitsu" | "anidb" | "anilist", id: number | null | undefined) => {
    if (!id) return null;
    try {
      return await invoke<number | null>("resolve_mal_id", { source: src, id });
    } catch { return null; }
  };
  // Step 0: the playing episode's OWN cour ids, from the addon.
  // AIOMetadata stamps every video with the MAL entry of its cour
  // (`_malId` / `_malEpisode`, parsed as mal_id / mal_episode) and
  // the AniList one (anilistId / anilistEpisode). Either pair names
  // the exact AniSkip entry and its LOCAL episode, so it beats every
  // step below. A pair is used only whole: a cour id with some other
  // episode number is the very mis-pairing this exists to prevent.
  // Read from detail.videos, not `target`: the enrichment effect
  // stamps the AniList pair onto activeTarget only later.
  let courEpisode: number | null = null;
  const playingVideo = detail?.videos?.find((v) => v.id === target.id) ?? null;
  // Where the cour MAL id came from, for the detector's log:
  // "aiometadata" (the video's own pair), "anilist" (its AniList pair
  // resolved), else "aniskip" (this pipeline's AniSkip resolution).
  let malSource: string | null = null;
  if (playingVideo?.mal_id && playingVideo.mal_episode) {
    malId = playingVideo.mal_id;
    courEpisode = playingVideo.mal_episode;
    malSource = "aiometadata";
  } else if (playingVideo?.anilist_id && playingVideo.anilist_episode) {
    const viaAnilist = await tryResolve("anilist", playingVideo.anilist_id);
    if (viaAnilist) {
      malId = viaAnilist;
      courEpisode = playingVideo.anilist_episode;
      malSource = "anilist";
    }
  }
  if (malId && log) {
    console.info(
      `[aniskip] per-episode ids from the addon -> mal=${malId} ep=${courEpisode}`,
    );
  }
  // Step 1: parse cour-specific show id from target.id.
  // `kitsu:49240:9` -> ("kitsu", 49240); `mal:59978:9` is
  // already the MAL id (no round-trip needed).
  const idSegments = target.id.split(":");
  if (!malId && idSegments.length === 3) {
    const provider = idSegments[0].toLowerCase();
    const showId = Number(idSegments[1]);
    if (Number.isFinite(showId)) {
      if (provider === "mal") {
        malId = showId;
      } else if (provider === "kitsu" || provider === "anidb" || provider === "anilist") {
        malId = await tryResolve(provider as "kitsu" | "anidb" | "anilist", showId);
      }
    }
  }
  // Step 1.5: SEASON-AWARE resolver for IMDb-keyed multi-season
  // anime. `detail.mal_id` (Step 2) is the SERIES-ROOT entry, which
  // MAL treats as season 1: for a season-2 IMDb id (tt...:2:E) it would
  // pair season 1's MAL id with a season-local episode and fetch
  // season 1's OP/ED; applied to season 2 those land mid-content and
  // (with OP on auto) yank the playhead partway through the episode.
  // `resolve_mal_for_aniskip` keys Fribb by (imdb, season) and returns
  // the SEASON-specific entry: the exact resolver the in-player
  // AniSkip menu already uses, which is why the menu showed the correct
  // mal=55825 for Hell's Paradise S2 while this auto-stamp used 46569
  // (S1). Gated to tt-style ids with season > 1: season 1 and anime-
  // prefix ids (Step 1) already resolve correctly. When it fails, the
  // series-level steps below are SKIPPED for these ids (see
  // laterSeasonTt): every one of them names the first cour.
  const laterSeasonTt = target.id.startsWith("tt")
    && Number.isFinite(target.season as number) && (target.season as number) > 1;
  if (!malId && laterSeasonTt) {
    const seriesImdb = target.series_id?.startsWith("tt")
      ? target.series_id
      : target.id.split(":")[0];
    try {
      malId = await invoke<number | null>("resolve_mal_for_aniskip", {
        targetId:   target.id,
        seriesImdb,
        season:     target.season ?? null,
        title:      detail?.name ?? null,
      });
      if (malId && log) {
        console.info(
          `[aniskip] season-aware resolve (s${target.season}) → mal=${malId} ` +
          `(overrides series-root detail.mal_id=${detail?.mal_id ?? "none"})`,
        );
      }
    } catch (e) {
      if (log) console.warn(`[aniskip] season-aware resolve threw: ${String(e)}`);
    }
    if (!malId && log) {
      console.info(
        `[aniskip] no cour-specific MAL id for ${target.id} (season ${target.season}); ` +
        `not borrowing the series-level id, which names the first cour`,
      );
    }
  }
  // Step 2: meta-detail anime ids. Only hit when nothing above
  // resolved (legacy tt-style ids or unrecognised prefix), and
  // NEVER for a tt-keyed season > 1: every id here (mal, kitsu,
  // anidb, anilist, and the title search) is the SERIES entry,
  // which MAL treats as the first cour, and pairing it with a later
  // season's local episode fetched another cour's timings. Bleach
  // TYBW S3E7 (part 3) was stamped with part 1 ep 7's opening, tens
  // of seconds off. No window beats a wrong auto-skip.
  if (!malId && !laterSeasonTt) {
    malId = detail?.mal_id ?? null;
  }
  if (!malId && !laterSeasonTt) {
    malId = await tryResolve("kitsu",   detail?.kitsu_id)
         ?? await tryResolve("anidb",   detail?.anidb_id)
         ?? await tryResolve("anilist", (detail as { anilist_id?: number | null } | null)?.anilist_id);
  }
  if (!malId && !laterSeasonTt && detail?.name) {
    // Year hint from `release_info` ("2023" or "2023-2024").
    // Jikan's TV-only filter plus exact-title scoring keeps
    // false positives at bay; we never accept a fuzzy match.
    const yearMatch = (detail.release_info ?? "").match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? Number(yearMatch[0]) : null;
    try {
      malId = await invoke<number | null>("resolve_mal_id_by_title", {
        title: detail.name,
        year,
      });
    } catch { /* leave null, falls through to skip log */ }
  }
  return { malId, malSource, courEpisode, laterSeasonTt, ...skipCourEpisodes(target, courEpisode) };
}

/**
 * Episode numbers for the resolved cour. Two numbers, never mixed.
 * `seasonEpisodeNum` is the addon's own, within its season (TVDB / TMDB
 * shaped): PublicMetaDB is keyed by it. `episodeNum` is LOCAL to the MAL
 * entry: AniSkip, its cache key, skip_ref, the neighbour profile and theme
 * songs are keyed by it, and the addon's cour-local number (Step 0) wins when
 * used. They differ whenever one season spans several MAL entries (Spy x
 * Family 1:15 is MAL Part 2 ep 3).
 *
 * The cascade already picked the cour-specific entry, so the matching episode
 * is VideoEntry's `episode_num` (cour-relative for cour-aggregated shows),
 * falling back to the id's trailing segment for shows whose VideoEntry lacks
 * the field.
 */
export function skipCourEpisodes(
  target: SkipCourTarget,
  courEpisode: number | null,
): { idEpisode: number; seasonEpisodeNum: number; episodeNum: number } {
  const idParts = target.id.split(":");
  const idEpisode = Number(idParts[idParts.length - 1]);
  const seasonEpisodeNum = Number.isFinite(target.episode_num as number)
    ? (target.episode_num as number)
    : idEpisode;
  const episodeNum = courEpisode != null ? courEpisode : seasonEpisodeNum;
  return { idEpisode, seasonEpisodeNum, episodeNum };
}
