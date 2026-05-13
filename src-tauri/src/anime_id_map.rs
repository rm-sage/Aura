// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! IMDB → AniList ID resolution map, backed by the community-maintained
//! [Fribb/anime-lists](https://github.com/Fribb/anime-lists) dataset.
//!
//! Purpose: skip the AniList title-search round-trip for known anime.
//! `scrobble_anilist::save_progress` resolves an Aura session to an
//! AniList media id by either (a) consulting this map, (b) hitting the
//! per-show on-disk cache, or (c) falling back to a fuzzy title search.
//! Path (a) is O(1) hash lookup and removes a class of failure modes
//! (AniList's fuzzy search rejecting titles with punctuation — see the
//! Frieren "Beyond Journey's End" case that motivated this whole arc).
//!
//! Lifecycle:
//!   • On startup, `warm_cache()` is spawned on the async runtime.
//!     Reads from `<app_data>/anime-id-map.json` when present + fresh
//!     (≤ 7 days old); otherwise fetches from Fribb's upstream.
//!   • Failure modes are non-fatal — a missing / unreachable map just
//!     leaves the in-memory state empty, and `lookup()` returns None.
//!     scrobble_anilist then takes the existing title-search path,
//!     same as pre-this-task behavior.
//!
//! Multi-season caveat: an IMDB id often spans multiple AniList entries
//! (one per season, each with its own anilist_id and anidb_id). Without
//! the separate `Anime-Lists/anime-lists` XML cour-split mapping, we
//! can't deterministically pick "the AniList id for season N" from
//! Fribb data alone. The heuristic here is: when multiple anilist_ids
//! share an imdb_id, store as Vec, and at lookup time use `season - 1`
//! as the index into that Vec. Fribb's data tends to order entries by
//! anidb_id creation order, which typically matches air-order for
//! sequels — good enough for most cases. When wrong, AniList's
//! `progress > episodes` guard rejects the save and the caller falls
//! through to title-search. Proper season-to-anilist tiebreak would
//! require the Anime-Lists XML wiring — tracked as a future
//! enhancement.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime};

const FRIBB_URL: &str = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-lists-reduced.json";
const TTL: Duration = Duration::from_secs(7 * 24 * 3600);

/// Subset of Fribb's per-anime row that we care about. The full row
/// also has tvdb / tmdb fields; we ignore those. Defaulted so rows
/// missing an `anilist_id` (most non-anime) don't fail parsing.
#[derive(Deserialize)]
struct FribbEntry {
    #[serde(default)]
    anilist_id: Option<u64>,
    #[serde(default)]
    mal_id: Option<u64>,
    #[serde(default)]
    kitsu_id: Option<u64>,
    #[serde(default)]
    anidb_id: Option<u64>,
    #[serde(default)]
    imdb_id: Option<String>,
}

/// One row's worth of cross-anime ids — what we keep in the in-memory
/// index per imdb-id. Multi-cour shows produce multiple of these
/// under the same imdb-id key (Fribb's data shape).
///
/// `kitsu_id` and `anidb_id` are populated but no lookup currently
/// surfaces them — kept for symmetry with `anilist_id` and `mal_id`,
/// and ready for the day a future caller needs the cour-specific
/// kitsu / anidb id (e.g. to bypass the yuna.moe round-trip we
/// currently use). Suppressing dead-code until then.
#[derive(Clone, Debug, Default)]
pub struct AnimeIdRow {
    pub anilist_id: Option<u64>,
    pub mal_id:     Option<u64>,
    #[allow(dead_code)] pub kitsu_id: Option<u64>,
    #[allow(dead_code)] pub anidb_id: Option<u64>,
}

/// In-memory lookup. Populated by `warm_cache`; accessed by
/// `scrobble_anilist::save_progress` via `lookup()` for AniList and by
/// `aniskip` resolution paths via `lookup_mal()`.
static MAP: OnceLock<Mutex<HashMap<String, Vec<AnimeIdRow>>>> = OnceLock::new();

fn map_slot() -> &'static Mutex<HashMap<String, Vec<AnimeIdRow>>> {
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    if std::fs::create_dir_all(&dir).is_err() {
        return None;
    }
    Some(dir.join("anime-id-map.json"))
}

fn parse_entries(text: &str) -> Option<Vec<FribbEntry>> {
    serde_json::from_str::<Vec<FribbEntry>>(text).ok()
}

fn build_index(entries: &[FribbEntry]) -> HashMap<String, Vec<AnimeIdRow>> {
    let mut m: HashMap<String, Vec<AnimeIdRow>> = HashMap::with_capacity(entries.len());
    for e in entries {
        // Index any row carrying an imdb_id + AT LEAST ONE anime id.
        // The earlier filter required anilist_id specifically, which
        // dropped rows where Fribb has only mal/kitsu but no anilist
        // (occasionally happens for older entries). Inclusive shape
        // lets aniskip mal lookups succeed for those too.
        let Some(imdb) = &e.imdb_id else { continue };
        if imdb.is_empty() { continue; }
        if e.anilist_id.is_none() && e.mal_id.is_none()
            && e.kitsu_id.is_none() && e.anidb_id.is_none() {
            continue;
        }
        m.entry(imdb.clone()).or_default().push(AnimeIdRow {
            anilist_id: e.anilist_id,
            mal_id:     e.mal_id,
            kitsu_id:   e.kitsu_id,
            anidb_id:   e.anidb_id,
        });
    }
    m
}

fn install(entries: &[FribbEntry]) {
    let next = build_index(entries);
    let count = next.len();
    if let Ok(mut g) = map_slot().lock() {
        *g = next;
    }
    crate::devlog!(info, "anime-id-map", "installed {count} imdb→anime-ids entries");
}

async fn fetch_fresh() -> Result<String, String> {
    let cli = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .https_only(true)
        .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " anime-id-map"))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = cli.get(FRIBB_URL).send().await.map_err(|e| format!("fetch: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("upstream returned HTTP {}", status.as_u16()));
    }
    resp.text().await.map_err(|e| format!("read body: {e}"))
}

/// Background warm-up. Call once during app setup; non-blocking.
///
/// Flow:
///   1. Try the on-disk snapshot first. If present AND ≤ 7 days old,
///      install it as the in-memory index and we're done.
///   2. Otherwise fetch from Fribb upstream, write to disk, install.
///   3. On network failure, fall back to the on-disk snapshot even if
///      stale — anything is better than nothing for the resolver.
///
/// Failures here are silent / log-only. The resolver returns None when
/// the map is empty, which gracefully degrades to the existing title-
/// search code path in scrobble_anilist.
pub async fn warm_cache<R: Runtime>(app: AppHandle<R>) {
    let path = match cache_path(&app) {
        Some(p) => p,
        None => {
            crate::devlog!(warn, "anime-id-map", "no app_data_dir — disabled");
            return;
        }
    };

    let fresh_disk = match std::fs::metadata(&path) {
        Ok(meta) => meta
            .modified()
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age < TTL)
            .unwrap_or(false),
        Err(_) => false,
    };

    if fresh_disk {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Some(entries) = parse_entries(&text) {
                install(&entries);
                return;
            }
            crate::devlog!(warn, "anime-id-map", "cached snapshot unparseable — refetching");
        }
    }

    match fetch_fresh().await {
        Ok(text) => {
            // Write before parsing so a future-run can use the cache
            // even if our parse here trips a transient error.
            if let Err(e) = std::fs::write(&path, &text) {
                crate::devlog!(warn, "anime-id-map", "cache write failed: {e}");
            }
            match parse_entries(&text) {
                Some(entries) => install(&entries),
                None => crate::devlog!(warn, "anime-id-map", "fresh snapshot unparseable"),
            }
        }
        Err(e) => {
            crate::devlog!(warn, "anime-id-map", "fetch failed ({e}) — falling back to stale cache");
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Some(entries) = parse_entries(&text) {
                    install(&entries);
                }
            }
        }
    }
}

/// Resolve an IMDB show id to an AniList media id.
///
/// `season` is the user's-VideoEntry-authoritative season number when
/// available. For most anime (single-season) the map has a single row
/// per imdb_id and season is ignored. For multi-season anime (Frieren,
/// Demon Slayer, etc.) Fribb may carry multiple rows under the same
/// imdb_id; we use `season - 1` as an index into the Vec. Falls back
/// to the first entry when the season index is out of range OR season
/// is None.
///
/// Returns None when the imdb_id isn't in the map (uncached, niche, or
/// the map hasn't been warmed yet). Caller is expected to fall through
/// to the existing cache + title-search resolution.
pub fn lookup(imdb_id: &str, season: Option<u32>) -> Option<u64> {
    lookup_row(imdb_id, season).and_then(|r| r.anilist_id)
}

/// Same lookup heuristic as `lookup`, but returns the MAL id slot.
/// Used by the AniSkip submission path so cour-2 episodes of multi-
/// cour anime get the correct per-cour MAL entry (e.g. Frieren cour 2
/// → MAL 59978 rather than the show-root cour 1 MAL 52991).
pub fn lookup_mal(imdb_id: &str, season: Option<u32>) -> Option<u64> {
    lookup_row(imdb_id, season).and_then(|r| r.mal_id)
}

fn lookup_row(imdb_id: &str, season: Option<u32>) -> Option<AnimeIdRow> {
    let g = map_slot().lock().ok()?;
    let entries = g.get(imdb_id)?;
    if entries.is_empty() { return None; }
    match season {
        Some(s) if s > 1 => {
            let idx = (s - 1) as usize;
            entries.get(idx).cloned().or_else(|| entries.first().cloned())
        }
        _ => entries.first().cloned(),
    }
}

/// Tauri command — surface `lookup_mal` to the frontend so the
/// AniSkipMenu's submission path can resolve cour-specific MAL ids
/// for tt-style video ids (where the cour-specific anime id isn't
/// embedded in `target.id`). Returns None when the map hasn't been
/// warmed or the imdb id isn't in Fribb's dataset.
#[tauri::command]
pub fn resolve_cour_mal_id(imdb_id: String, season: Option<u32>) -> Option<u64> {
    let id = lookup_mal(&imdb_id, season);
    crate::devlog!(
        info, "anime-id-map",
        "resolve_cour_mal_id imdb={imdb_id} season={season:?} → {id:?}",
    );
    id
}

/// Tauri command — surface the cour-specific AniList id directly.
/// Mirrors `resolve_cour_mal_id` but returns the AniList slot of the
/// Fribb row instead of MAL. Used as a step-2b fallback in the
/// AniSkipMenu resolver: when Fribb has a row for the imdb+season
/// pair but its `mal_id` slot is None (recent anime where Fribb
/// hasn't filled in MAL yet), the AniList slot is often populated,
/// and the frontend can chain through yuna.moe's `anilist → mal`
/// mapping to land on the right MAL id anyway.
#[tauri::command]
pub fn resolve_cour_anilist_id(imdb_id: String, season: Option<u32>) -> Option<u64> {
    let id = lookup(&imdb_id, season);
    crate::devlog!(
        info, "anime-id-map",
        "resolve_cour_anilist_id imdb={imdb_id} season={season:?} → {id:?}",
    );
    id
}

/// Number of imdb→anime-ids entries in the in-memory index. Useful for
/// diagnostics; surfaced in the DevConsole `version` command (TBD) so
/// users can see whether the map is loaded.
#[allow(dead_code)]
pub fn entry_count() -> usize {
    map_slot().lock().map(|g| g.len()).unwrap_or(0)
}
