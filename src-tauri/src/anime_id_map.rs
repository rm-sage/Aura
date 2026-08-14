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

// The FULL dataset, NOT `anime-lists-reduced.json`. Fribb dropped `anilist_id`
// (and mal/kitsu/anidb) from the reduced file — its schema is now just
// anidb/tmdb/tvdb/imdb + season + episode_offset — so the reduced file resolves
// NOTHING here (every row parses with anilist_id=None and lookup() always
// returns None). The full file still carries anilist_id / mal_id / kitsu_id /
// anidb_id alongside imdb_id, which is exactly what `FribbEntry` reads; serde
// ignores the extra provider-id / season / offset fields.
const FRIBB_URL: &str = "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json";
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
    // Fribb changed `imdb_id` from a plain string ("tt123") to an ARRAY of
    // strings (["tt123"]) for multi-imdb entries (and many rows now omit it).
    // Accept string OR [string] (first wins) OR null/absent — a bare
    // `Option<String>` failed to deserialize the array rows, which made
    // serde reject the WHOLE array and left the map empty ("snapshot
    // unparseable").
    #[serde(default, deserialize_with = "de_imdb_id")]
    imdb_id: Option<String>,
    // Which TVDB / TMDB season this AniList entry maps to (full dataset only),
    // and the entry kind ("TV" / "ONA" / "OVA" / "SPECIAL" / "MOVIE"). These
    // drive the season-aware, main-run-filtered lookup that replaced the
    // fragile positional (season-1) index. Absent on rows Fribb hasn't tagged.
    #[serde(default)]
    season: Option<FribbSeason>,
    #[serde(rename = "type", default)]
    kind: Option<String>,
}

/// The `season` sub-object of a full-dataset Fribb row (`{tvdb, tmdb}`).
#[derive(Deserialize, Default)]
struct FribbSeason {
    #[serde(default)]
    tvdb: Option<u32>,
    #[serde(default)]
    tmdb: Option<u32>,
}

/// Deserialize Fribb's `imdb_id`: a string, an array of strings (first
/// wins), or null / absent.
fn de_imdb_id<'de, D>(d: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum StringOrVec {
        One(String),
        Many(Vec<String>),
    }
    Ok(match Option::<StringOrVec>::deserialize(d)? {
        Some(StringOrVec::One(s)) => Some(s),
        Some(StringOrVec::Many(v)) => v.into_iter().next(),
        None => None,
    })
}

/// One row's worth of cross-anime ids — what we keep in the in-memory
/// index per imdb-id. Multi-cour shows produce multiple of these
/// under the same imdb-id key (Fribb's data shape).
///
/// The two ids any lookup surfaces (`anilist_id`, `mal_id`) plus the
/// season / main-run signals the season-aware lookup needs. Fribb's
/// `kitsu_id` / `anidb_id` still gate inclusion in `build_index` (a row
/// needs ≥1 anime id of any kind) but aren't read back, so they're not
/// stored. If a future caller needs the cour-specific kitsu / anidb id,
/// re-add the fields here and the assignments in `build_index`.
#[derive(Clone, Debug, Default)]
pub struct AnimeIdRow {
    pub anilist_id: Option<u64>,
    pub mal_id:     Option<u64>,
    /// TVDB / TMDB season this entry maps to (full dataset), used to MATCH a
    /// requested season instead of positionally indexing the Vec.
    pub season_tvdb: Option<u32>,
    pub season_tmdb: Option<u32>,
    /// True for main-run episodic formats (TV / ONA). OVA / SPECIAL / MOVIE
    /// rows interleave the Vec, so they're excluded from season matching to
    /// stop them shifting a pick onto the wrong cour.
    pub is_main: bool,
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
    // -v2: bumped when the upstream source moved from the reduced file to the
    // full file. Ignoring the old `anime-id-map.json` snapshot (reduced schema,
    // no anilist_id) stops a stale <=7-day cache from keeping the map empty
    // after the switch — the next launch refetches the full file cleanly.
    Some(dir.join("anime-id-map-v2.json"))
}

fn parse_entries(text: &str) -> Option<Vec<FribbEntry>> {
    // Fribb's dataset is a top-level array. Fast path: deserialize straight
    // into `Vec<FribbEntry>`. serde ignores the full file's extra fields (the
    // other provider ids, nested season / episode_offset objects), so this is
    // far lighter than building a `serde_json::Value` DOM for the ~7.5 MB full
    // file — it only allocates the five Options we keep per row.
    if let Ok(rows) = serde_json::from_str::<Vec<FribbEntry>>(text) {
        return Some(rows);
    }
    // Fallback: parse the array structurally, then deserialize each row
    // INDEPENDENTLY so a single row whose shape drifted (Fribb periodically
    // restructures — imdb_id became an array; themoviedb_id / tvdb_id became
    // objects) skips just that row instead of failing the whole map. Combined
    // with the string-or-array `imdb_id` handling above, the rows we actually
    // want (those carrying an imdb_id) survive the current format.
    let rows: Vec<serde_json::Value> = serde_json::from_str(text).ok()?;
    Some(
        rows.into_iter()
            .filter_map(|v| serde_json::from_value::<FribbEntry>(v).ok())
            .collect(),
    )
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
            season_tvdb: e.season.as_ref().and_then(|s| s.tvdb),
            season_tmdb: e.season.as_ref().and_then(|s| s.tmdb),
            is_main: e.kind.as_deref()
                .map(|k| k.eq_ignore_ascii_case("TV") || k.eq_ignore_ascii_case("ONA"))
                .unwrap_or(false),
        });
    }
    m
}

fn install(entries: Vec<FribbEntry>) {
    // Build the resident index, then drop the parse Vec (~2-3 MB of full
    // Fribb rows) BEFORE taking the map lock — so the transient overlap of
    // {parse Vec + new index + old index under lock} is trimmed at startup.
    let next = build_index(&entries);
    drop(entries);
    let count = next.len();
    if let Ok(mut g) = map_slot().lock() {
        *g = next;
    }
    crate::devlog!(info, "anime-id-map", "installed {count} imdb->anime-ids entries");
}

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .https_only(true)
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " anime-id-map"))
            .build()
            .expect("anime-id-map HTTP client init failed")
    })
}

async fn fetch_fresh() -> Result<String, String> {
    let resp = client().get(FRIBB_URL).send().await.map_err(|e| format!("fetch: {e}"))?;
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

    // One-time cleanup of the pre-v2 snapshot (reduced schema, no anilist_id).
    // cache_path now only ever references the -v2 file, so the legacy file would
    // otherwise linger in app_data forever. Best-effort; ignore any error.
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_file(dir.join("anime-id-map.json"));
    }

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
            let parsed = parse_entries(&text);
            drop(text); // free the (~7.5 MB full-file) JSON before building the index
            if let Some(entries) = parsed {
                install(entries);
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
            let parsed = parse_entries(&text);
            drop(text); // free the (~7.5 MB full-file) JSON before building the index
            match parsed {
                Some(entries) => install(entries),
                None => crate::devlog!(warn, "anime-id-map", "fresh snapshot unparseable"),
            }
        }
        Err(e) => {
            crate::devlog!(warn, "anime-id-map", "fetch failed ({e}) — falling back to stale cache");
            if let Ok(text) = std::fs::read_to_string(&path) {
                let parsed = parse_entries(&text);
                drop(text);
                if let Some(entries) = parsed {
                    install(entries);
                }
            }
        }
    }
}

/// Resolve an IMDB show id to an AniList media id.
///
/// `season` is the user's-VideoEntry-authoritative season number when
/// available. Single-row shows resolve directly. For multi-row shows
/// (multi-cour anime) with season > 1 we MATCH the row whose Fribb
/// TVDB/TMDB season equals `season`, restricted to main-run (TV/ONA)
/// rows and only when that match is UNIQUE — a deliberate change from
/// the old positional `season - 1` index, which the full dataset's
/// interleaved OVA/SPECIAL/MOVIE rows shifted onto the wrong cour. A
/// non-unique or unmatched season returns None so the caller's own
/// resolver disambiguates rather than trusting a wrong-cour guess.
///
/// Returns None when the imdb_id isn't in the map (uncached, niche, or
/// the map hasn't been warmed yet) OR when the season is ambiguous.
/// Caller is expected to fall through to the existing cache +
/// title-search / SEQUEL-walk resolution.
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
    // Unambiguous single-row show — no season disambiguation needed.
    if entries.len() == 1 {
        return entries.first().cloned();
    }
    match season {
        Some(s) if s > 1 => {
            // Match on the Fribb per-row SEASON among main-run (TV / ONA) rows —
            // NOT a positional (season-1) index. The full dataset interleaves
            // OVA / SPECIAL / MOVIE rows, so positional indexing lands on the
            // wrong cour (an OVA between S2 and S3 shifts S3's index onto S2,
            // silently writing S3 progress to the S2 AniList entry). Require a
            // UNIQUE main match; on 0 matches (season untagged) or >1 (a
            // cour-split season) return None so the caller's own resolver
            // (SEQUEL walk / addon-embedded id / title search) disambiguates
            // instead of us guessing a wrong cour.
            let mut it = entries.iter().filter(|r| {
                r.is_main && (r.season_tvdb == Some(s) || r.season_tmdb == Some(s))
            });
            let pick = it.next()?;
            if it.next().is_some() { return None; }
            Some(pick.clone())
        }
        // Season 1 / unknown: first main-run row (skips a leading OVA / movie),
        // falling back to the first row when nothing is tagged main.
        _ => entries.iter().find(|r| r.is_main).or_else(|| entries.first()).cloned(),
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
