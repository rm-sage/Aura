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
/// has anidb / kitsu / mal / tvdb / tmdb fields too; we ignore them
/// since AniList id + IMDB id is what feeds the lookup. Defaulted so
/// rows missing an `anilist_id` (most non-anime) don't fail parsing.
#[derive(Deserialize)]
struct FribbEntry {
    #[serde(default)]
    anilist_id: Option<u64>,
    #[serde(default)]
    imdb_id: Option<String>,
}

/// In-memory lookup. Populated by `warm_cache`; accessed by
/// `scrobble_anilist::save_progress` via `lookup()`.
static MAP: OnceLock<Mutex<HashMap<String, Vec<u64>>>> = OnceLock::new();

fn map_slot() -> &'static Mutex<HashMap<String, Vec<u64>>> {
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

fn build_index(entries: &[FribbEntry]) -> HashMap<String, Vec<u64>> {
    let mut m: HashMap<String, Vec<u64>> = HashMap::with_capacity(entries.len());
    for e in entries {
        let (Some(imdb), Some(anilist)) = (&e.imdb_id, e.anilist_id) else { continue };
        if imdb.is_empty() { continue; }
        m.entry(imdb.clone()).or_default().push(anilist);
    }
    m
}

fn install(entries: &[FribbEntry]) {
    let next = build_index(entries);
    let count = next.len();
    if let Ok(mut g) = map_slot().lock() {
        *g = next;
    }
    crate::devlog!(info, "anime-id-map", "installed {count} imdb→anilist entries");
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
/// available. For most anime (single-season) the map has a single
/// anilist_id per imdb_id and season is ignored. For multi-season
/// anime (Frieren, Demon Slayer, etc.) Fribb may carry multiple
/// anilist_ids under the same imdb_id; we use `season - 1` as an index
/// into the Vec. Falls back to the first entry when the season index
/// is out of range OR season is None.
///
/// Returns None when the imdb_id isn't in the map (uncached, niche, or
/// the map hasn't been warmed yet). Caller is expected to fall through
/// to the existing cache + title-search resolution.
pub fn lookup(imdb_id: &str, season: Option<u32>) -> Option<u64> {
    let g = map_slot().lock().ok()?;
    let entries = g.get(imdb_id)?;
    if entries.is_empty() { return None; }
    match season {
        Some(s) if s > 1 => {
            let idx = (s - 1) as usize;
            entries.get(idx).copied().or_else(|| entries.first().copied())
        }
        _ => entries.first().copied(),
    }
}

/// Number of imdb→anilist entries in the in-memory index. Useful for
/// diagnostics; surfaced in the DevConsole `version` command (TBD) so
/// users can see whether the map is loaded.
#[allow(dead_code)]
pub fn entry_count() -> usize {
    map_slot().lock().map(|g| g.len()).unwrap_or(0)
}
