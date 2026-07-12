// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Story arcs for anime episode lists.
//!
//! Source: TMDB's "episode groups" API. A group whose numeric `type` is 5
//! ("Story Arc") partitions a show's episodes into named arcs. Coverage was
//! measured, not assumed: 32 of 44 probed popular anime have at least one
//! such group (One Piece, both Narutos, Bleach, all three Dragon Balls, HxH,
//! AoT, Demon Slayer, JJK, MHA, Fairy Tail, Black Clover, FMA:B, Death Note,
//! Gintama, JoJo, Boruto, Conan, SAO, Re:Zero, Mob Psycho, Chainsaw Man,
//! Spy x Family, Frieren, Haikyu, Blue Lock, Dr. Stone, One-Punch Man,
//! Code Geass, ...). Every other candidate source was checked and has no arc
//! model at all: AniList (schema introspected), MAL/Jikan, Kitsu, AniDB,
//! Trakt, Simkl, and animefillerlist (whose episode table is exactly four
//! columns: #, Title, Type, Airdate).
//!
//! THE JOIN IS THE HARD PART, AND IT IS NOT A NUMBERING CONVERSION.
//! TMDB's arcs are sets of TMDB (season, episode) pairs. Aura's episode ids
//! come from Stremio meta addons (Cinemeta / TVDB numbering). The two
//! disagree, and not by a constant:
//!
//!   TMDB promotes a Toriko/One Piece/DBZ crossover special into One Piece's
//!   MAIN RUN at absolute 590. Cinemeta files the same episode as special
//!   S0E39. So TMDB abs N == Cinemeta abs N for N <= 589 and N-1 for N >= 591.
//!   A naive absolute-index join misplaces 579 of Cinemeta's 1168 One Piece
//!   episodes: every arc from Punk Hazard onward starts and ends one episode
//!   late, silently. That is worse than not shipping the feature.
//!
//! So the mapping goes through `arc_align`, a banded sequence alignment over
//! air date + title that absorbs promotions/demotions as gaps. See that
//! module for why neither date nor title alone is a usable key.
//!
//! Key: `AURA_TMDB_KEY`, baked by build.rs from `.env.local` (same pattern as
//! `AURA_MDBLIST_KEY` / `AURA_PUBLICMETADB_KEY`). A user-supplied key in the
//! OS keyring wins. Empty key -> the whole feature no-ops, no network, no
//! toggle rendered.
//!
//! Devlog label: `[arcs]`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::arc_align::{self, AlignEpisode};

const TMDB_API: &str = "https://api.themoviedb.org/3";
/// Episode stills are 16:9. w780 is the smallest rung that still looks right
/// on a wide arc card; everything is re-resized by `img_proxy` downstream
/// anyway (standing rule: never pull a master into a small tile).
const TMDB_STILL_BASE: &str = "https://image.tmdb.org/t/p/w780";
const TIMEOUT: Duration = Duration::from_secs(12);

/// TMDB's episode-group type enum. 1 original air date, 2 absolute, 3 DVD,
/// 4 digital, 5 STORY ARC, 6 production, 7 TV.
const GROUP_TYPE_STORY_ARC: i64 = 5;

/// Ongoing shows gain an episode every week, and TMDB contributors re-cut arc
/// groups, so a long TTL would serve a stale arc that is missing the newest
/// episodes. One day is the right trade.
const TTL: Duration = Duration::from_secs(24 * 3600);
/// Bounded, per the standing "never ship an unbounded cache" rule.
const CACHE_CAP: usize = 40;

/// Below this, we do not believe the alignment and refuse to render the arc.
/// Measured on real data, One Piece and Naruto Shippuden produce ZERO pairs
/// under this threshold, so tripping it means something genuinely drifted.
///
/// Compared against `AlignPair::confidence` (evidence-normalised), never against
/// the raw score. Against the raw score this threshold would be UNREACHABLE for
/// any episode missing an air date on either side (their ceiling is the title
/// weight, 0.45), so a single dateless episode would silently reject its whole
/// arc even when the alignment is perfect.
const MIN_PAIR_CONFIDENCE: f64 = 0.5;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent("Aura/1.4 story-arcs")
            .build()
            .expect("arcs HTTP client init failed")
    })
}

/// Resolve the TMDB key: a user-supplied key in the OS keyring wins, else the
/// build-time baked one. `None` when neither is set, which makes every public
/// entry point here return `Ok(None)` without touching the network.
fn tmdb_key() -> Option<String> {
    if let Some(k) = crate::api_keyring::read("tmdb") {
        let t = k.trim().to_string();
        if !t.is_empty() {
            return Some(t);
        }
    }
    let baked = env!("AURA_TMDB_KEY").trim();
    if baked.is_empty() {
        None
    } else {
        Some(baked.to_string())
    }
}

/// True when arcs can work at all. Cheap enough for the frontend to gate on.
#[tauri::command]
pub async fn story_arcs_available() -> bool {
    tmdb_key().is_some()
}

/// GET a TMDB path, with the api_key appended. Retries 429 / 5xx a few times
/// with a bounded backoff, because TMDB rate-limits a shared key.
async fn tmdb_get(path: &str, key: &str) -> Result<String, String> {
    let sep = if path.contains('?') { '&' } else { '?' };
    let url = format!("{TMDB_API}{path}{sep}api_key={key}&language=en-US");
    let mut delay_ms = 250u64;
    let mut last = String::new();

    for attempt in 0..4 {
        match client().get(&url).send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.is_success() {
                    return resp.text().await.map_err(|e| e.to_string());
                }
                if status.as_u16() == 401 {
                    // A bad key is not retryable and is worth surfacing loudly:
                    // it is the one failure a user can actually fix.
                    return Err("TMDB rejected the API key (401)".to_string());
                }
                last = format!("TMDB HTTP {status}");
                if !(status.as_u16() == 429 || status.is_server_error()) {
                    return Err(last);
                }
            }
            Err(e) => last = e.to_string(),
        }
        if attempt < 3 {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            delay_ms = (delay_ms * 2).min(2000);
        }
    }
    Err(last)
}

// ---------------------------------------------------------------------------
// Disk cache: the TMDB payloads only.
//
// The alignment itself is recomputed per call. It is a banded DP over ~1300
// episodes with a band of ~25, i.e. tens of thousands of f64 ops, which is far
// cheaper than the IPC round trip that delivered the episode list. Caching the
// NETWORK is what matters.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct CacheEntry {
    /// Unix seconds.
    fetched_at: u64,
    body: String,
}

type CacheMap = HashMap<String, CacheEntry>;

static CACHE: OnceLock<Mutex<CacheMap>> = OnceLock::new();

fn cache() -> &'static Mutex<CacheMap> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Set once the disk file has been hydrated into `CACHE`, so we read it from
/// disk exactly once per process instead of on every `cached_get`.
static CACHE_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("arcs-cache-v1.json"))
}

/// Hydrate the in-memory cache from disk ONCE. The full-file read + JSON parse
/// (a One Piece payload is 1000+ episodes) runs on a blocking thread so it never
/// stalls a tokio worker, and the CACHE_LOADED flag stops the ~20 `cached_get`
/// calls of a single One Piece arc open from each re-reading and re-parsing the
/// whole file only to throw the result away.
async fn ensure_cache_loaded<R: Runtime>(app: &AppHandle<R>) {
    use std::sync::atomic::Ordering;
    if CACHE_LOADED.swap(true, Ordering::AcqRel) {
        return;
    }
    let Some(path) = cache_path(app) else { return };
    let loaded = tokio::task::spawn_blocking(move || {
        let text = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str::<CacheMap>(&text).ok()
    })
    .await
    .ok()
    .flatten();
    if let Some(map) = loaded {
        if let Ok(mut lock) = cache().lock() {
            if lock.is_empty() {
                *lock = map;
            }
        }
    }
}

/// Snapshot the (bounded) cache and write it once, off the runtime. Call at the
/// END of a fetch, not per sub-request.
async fn persist_cache<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = cache_path(app) else { return };
    let snapshot = {
        let Ok(mut lock) = cache().lock() else { return };
        // Bound the file: drop the oldest entries past the cap.
        if lock.len() > CACHE_CAP {
            let mut by_age: Vec<(String, u64)> =
                lock.iter().map(|(k, v)| (k.clone(), v.fetched_at)).collect();
            by_age.sort_by_key(|(_, ts)| *ts);
            let excess = lock.len() - CACHE_CAP;
            for (k, _) in by_age.into_iter().take(excess) {
                lock.remove(&k);
            }
        }
        lock.clone()
    };
    let _ = tokio::task::spawn_blocking(move || {
        if let Ok(text) = serde_json::to_string(&snapshot) {
            let _ = std::fs::write(path, text);
        }
    })
    .await;
}

/// Fetch through the in-memory cache. Does NO disk I/O of its own: the caller
/// hydrates once via `ensure_cache_loaded` up front and persists once via
/// `persist_cache` at the end. Returns whether a NEW body was fetched, so the
/// caller knows whether a persist is worth doing.
async fn cached_get<R: Runtime>(
    app: &AppHandle<R>,
    cache_key: &str,
    path: &str,
    api_key: &str,
) -> Result<String, String> {
    let _ = app;
    if let Ok(lock) = cache().lock() {
        if let Some(entry) = lock.get(cache_key) {
            if now_secs().saturating_sub(entry.fetched_at) < TTL.as_secs() {
                return Ok(entry.body.clone());
            }
        }
    }
    let body = tmdb_get(path, api_key).await?;
    if let Ok(mut lock) = cache().lock() {
        lock.insert(
            cache_key.to_string(),
            CacheEntry { fetched_at: now_secs(), body: body.clone() },
        );
        CACHE_DIRTY.store(true, std::sync::atomic::Ordering::Release);
    }
    Ok(body)
}

/// Set whenever `cached_get` inserts a new body, so the caller can skip the
/// persist (and its serialize + write) entirely on an all-cache-hit open.
static CACHE_DIRTY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------------------------------------------------------------------------
// TMDB wire shapes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct GroupsList {
    #[serde(default)]
    results: Vec<GroupSummary>,
}

#[derive(Deserialize, Clone)]
struct GroupSummary {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(rename = "type", default)]
    kind: i64,
    #[serde(default)]
    group_count: i64,
    #[serde(default)]
    episode_count: i64,
}

#[derive(Deserialize)]
struct GroupDetail {
    #[serde(default)]
    groups: Vec<GroupBucket>,
}

#[derive(Deserialize)]
struct GroupBucket {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    order: i64,
    #[serde(default)]
    episodes: Vec<GroupEpisode>,
}

/// One episode inside a group. TMDB documents the group payload as carrying
/// full episode objects (name / air_date / still_path), but we do not depend
/// on that: every field past the two numbers is optional, and when the payload
/// turns out to be pointers-only we hydrate from the per-season endpoint.
#[derive(Deserialize, Clone)]
struct GroupEpisode {
    #[serde(default)]
    season_number: Option<i64>,
    #[serde(default)]
    episode_number: Option<i64>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    air_date: Option<String>,
    #[serde(default)]
    still_path: Option<String>,
}

#[derive(Deserialize)]
struct SeasonDetail {
    #[serde(default)]
    episodes: Vec<SeasonEpisode>,
}

#[derive(Deserialize)]
struct SeasonEpisode {
    #[serde(default)]
    season_number: Option<i64>,
    #[serde(default)]
    episode_number: Option<i64>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    air_date: Option<String>,
    #[serde(default)]
    still_path: Option<String>,
}

#[derive(Deserialize)]
struct FindResult {
    #[serde(default)]
    tv_results: Vec<FindTv>,
}

#[derive(Deserialize)]
struct FindTv {
    #[serde(default)]
    id: Option<i64>,
}

// ---------------------------------------------------------------------------
// Public shapes (Rust -> React)
//
// NOTE the serde quirk called out in CLAUDE.md: `#[serde(rename)]` is
// BIDIRECTIONAL, so a rename here would change the OUTGOING key too and the TS
// interface would read `undefined`. Everything below serializes with its Rust
// field name, which is exactly what `src/storyArcs.ts` declares.
// ---------------------------------------------------------------------------

/// One selectable arc grouping. A show commonly has several: One Piece has
/// "Story Arc" (55 fine-grained arcs), "Sagas" (12 broad ones), and
/// "Arcs (Official)"; Naruto has "Story Arcs with Filler" (24) and
/// "Manga Story Arcs" (5, canon-only).
#[derive(Clone, Serialize)]
pub struct ArcGrouping {
    pub id: String,
    pub name: String,
    pub description: String,
    pub arc_count: i64,
    pub episode_count: i64,
}

#[derive(Clone, Serialize)]
pub struct StoryArc {
    pub id: String,
    pub name: String,
    pub order: i64,
    /// Aura video ids, in the arc's own order. Cross-season arcs are flat:
    /// the season boundary is invisible and arc order is authoritative.
    pub episode_ids: Vec<String>,
    /// Arc key art. Fandom art when we have it, else an episode still.
    pub image: Option<String>,
    /// "fandom" | "tmdb" | "episode" | "none". Drives the attribution line.
    pub image_source: String,
    /// Earliest / latest release YEAR across the arc's mapped episodes,
    /// taken from AURA's own `released` values so the chip can never
    /// disagree with the episode rows underneath it.
    pub year_start: Option<i64>,
    pub year_end: Option<i64>,
    /// Members TMDB listed that we could not map to an Aura episode (a
    /// special TMDB promoted into the main run, an episode the addon has not
    /// listed yet). Surfaced so the UI can be honest rather than silently
    /// short.
    pub dropped: usize,
}

#[derive(Clone, Serialize)]
pub struct ArcResult {
    pub grouping_id: String,
    pub grouping_name: String,
    /// Every viable grouping, so the UI can offer the switcher.
    pub groupings: Vec<ArcGrouping>,
    pub arcs: Vec<StoryArc>,
    /// Arcs dropped wholesale because the alignment was not confident.
    pub rejected: usize,
}

/// The Aura-side episode list, passed in from the frontend. We take the
/// caller's REAL videos rather than re-fetching a meta, so the ids we hand
/// back are the exact addon ids `fetch_streams` expects. Do not reconstruct
/// them.
#[derive(Deserialize)]
pub struct ArcVideoRef {
    pub id: String,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
    #[serde(default)]
    pub released: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
}

// ---------------------------------------------------------------------------
// Grouping selection
// ---------------------------------------------------------------------------

/// Names that are really air-order / season splits which an uploader typed as
/// "Story Arc". Naruto Shippuden alone has a "TVDB Order" and a "Wikipedia
/// Order" both carrying type 5, and Naruto has one literally named "Seasons".
/// These are NOT arcs (they are the season list relabelled), so they are
/// rejected outright rather than merely deprioritised: a "Seasons" tab sitting
/// in the Arcs view is worse than not offering it, and it was slipping onto the
/// grouping switcher on real shows.
fn is_not_an_arc_grouping(name: &str) -> bool {
    let n = name.trim().to_lowercase();
    n == "seasons"
        || n == "season"
        || n.contains("order")     // "TVDB Order", "Wikipedia Order", "Absolute Order", ...
        || n.contains("air date")
        || n.contains("tvdb")
        || n.contains("wikipedia")
}

/// Score a candidate grouping. Higher is better; `None` rejects it outright.
fn score_grouping(g: &GroupSummary, main_run_total: i64) -> Option<f64> {
    if g.kind != GROUP_TYPE_STORY_ARC {
        return None;
    }
    // A single bucket is not a partition, it is the whole show.
    if g.group_count <= 1 {
        return None;
    }
    // Air-order / season splits are not arcs. Drop them entirely.
    if is_not_an_arc_grouping(&g.name) {
        return None;
    }
    // Coverage against the show's real main run. A grouping that only covers
    // half the episodes leaves the rest belonging to no arc at all.
    let coverage = if main_run_total > 0 {
        (g.episode_count as f64) / (main_run_total as f64)
    } else {
        1.0
    };
    if coverage < 0.85 {
        return None;
    }

    let mut score = coverage.min(1.15) * 100.0;
    // Prefer finer arcs, but only as a tiebreak: a show with 55 real arcs is
    // more useful than the same show cut into 12 broad sagas, and the user can
    // switch.
    score += (g.group_count as f64).min(80.0) * 0.25;
    Some(score)
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// Resolve a TMDB tv id from an IMDb id. Only used when the addon meta did not
/// stamp one (`MetaDetail.tmdb_id`) and the caller could not resolve one via
/// the existing kitsu/anidb/anilist path in `publicmetadb::resolve_anime_tmdb_id`.
/// `Ok(None)` means TMDB genuinely has no TV match for this IMDb id (a real,
/// cacheable "no arcs"). An `Err` means we could not ASK (429, 5xx, offline) and
/// must propagate so the caller does not cache a transient failure as a
/// permanent verdict for 24 hours.
async fn find_tmdb_by_imdb<R: Runtime>(
    app: &AppHandle<R>,
    imdb_id: &str,
    key: &str,
) -> Result<Option<i64>, String> {
    let body = cached_get(
        app,
        &format!("find:{imdb_id}"),
        &format!("/find/{imdb_id}?external_source=imdb_id"),
        key,
    )
    .await?;
    let parsed: FindResult = serde_json::from_str(&body)
        .map_err(|e| format!("TMDB /find parse failed: {e}"))?;
    Ok(parsed.tv_results.first().and_then(|t| t.id))
}

#[tauri::command]
pub async fn fetch_story_arcs<R: Runtime>(
    app: AppHandle<R>,
    tmdb_id: Option<i64>,
    imdb_id: Option<String>,
    videos: Vec<ArcVideoRef>,
    grouping_id: Option<String>,
) -> Result<Option<ArcResult>, String> {
    // Hydrate the disk cache once, up front, off the runtime. Then run the
    // fetch (which touches only the in-memory cache), and persist ONCE at the
    // end, and only if a new body was actually fetched. This wrapper is what
    // guarantees the single load / single conditional write no matter which of
    // the many early-return paths inside the inner fn is taken.
    ensure_cache_loaded(&app).await;
    let out = fetch_story_arcs_inner(&app, tmdb_id, imdb_id, videos, grouping_id).await;
    if CACHE_DIRTY.swap(false, std::sync::atomic::Ordering::AcqRel) {
        persist_cache(&app).await;
    }
    out
}

async fn fetch_story_arcs_inner<R: Runtime>(
    app: &AppHandle<R>,
    tmdb_id: Option<i64>,
    imdb_id: Option<String>,
    videos: Vec<ArcVideoRef>,
    grouping_id: Option<String>,
) -> Result<Option<ArcResult>, String> {
    let Some(key) = tmdb_key() else {
        // No key baked and none supplied: the feature is simply off. This is
        // the same clean no-op MDBList ratings and PublicMetaDB skips take.
        return Ok(None);
    };

    let tv_id = match tmdb_id {
        Some(id) if id > 0 => id,
        _ => match imdb_id.as_deref() {
            // A propagated Err here is deliberate: the frontend caches a
            // successful `null` for 24 h, so laundering a 429 / offline blip
            // into "this show has no arcs" would hide the toggle for a day.
            Some(imdb) if imdb.starts_with("tt") => match find_tmdb_by_imdb(app, imdb, &key).await? {
                Some(id) => id,
                None => {
                    crate::devlog!(info, "arcs", "no TMDB id for {imdb}; arcs unavailable");
                    return Ok(None);
                }
            },
            _ => return Ok(None),
        },
    };

    // Aura's main run, in broadcast order. Specials (season 0) are excluded on
    // both sides: the two databases disagree wildly about them (One Piece:
    // Cinemeta 63 specials vs TMDB 39) and no arc is defined over them.
    let mut aura: Vec<&ArcVideoRef> = videos
        .iter()
        .filter(|v| v.season.unwrap_or(0) >= 1 && v.episode.is_some())
        .collect();
    aura.sort_by_key(|v| (v.season.unwrap_or(0), v.episode.unwrap_or(0)));
    if aura.len() < 2 {
        return Ok(None);
    }

    // 1. List the groups and pick one.
    let list_body = cached_get(app, &format!("groups:{tv_id}"), &format!("/tv/{tv_id}/episode_groups"), &key).await?;
    let list: GroupsList = serde_json::from_str(&list_body)
        .map_err(|e| format!("TMDB episode_groups parse failed: {e}"))?;

    let main_run_total = aura.len() as i64;
    let mut candidates: Vec<(GroupSummary, f64)> = list
        .results
        .iter()
        .filter_map(|g| score_grouping(g, main_run_total).map(|s| (g.clone(), s)))
        .collect();
    if candidates.is_empty() {
        crate::devlog!(info, "arcs", "tmdb {tv_id}: no viable story-arc grouping");
        return Ok(None);
    }
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let chosen = grouping_id
        .as_deref()
        .and_then(|want| candidates.iter().find(|(g, _)| g.id == want))
        .unwrap_or(&candidates[0])
        .0
        .clone();

    let groupings: Vec<ArcGrouping> = candidates
        .iter()
        .map(|(g, _)| ArcGrouping {
            id: g.id.clone(),
            name: g.name.clone(),
            description: g.description.clone(),
            arc_count: g.group_count,
            episode_count: g.episode_count,
        })
        .collect();

    // 2. Expand the chosen group.
    let detail_body = cached_get(
        &app,
        &format!("group:{}", chosen.id),
        &format!("/tv/episode_group/{}", chosen.id),
        &key,
    )
    .await?;
    let detail: GroupDetail = serde_json::from_str(&detail_body)
        .map_err(|e| format!("TMDB episode_group parse failed: {e}"))?;

    // 3. Build TMDB's side: every main-run episode the group references, keyed
    //    by "s:e", deduped, in broadcast order. The aligner needs order + date
    //    + title; it does NOT need absolute numbers, which is what lets us skip
    //    the whole absolute-numbering minefield.
    let mut tmdb_eps: HashMap<(i64, i64), GroupEpisode> = HashMap::new();
    for bucket in &detail.groups {
        for e in &bucket.episodes {
            let (Some(s), Some(n)) = (e.season_number, e.episode_number) else { continue };
            if s < 1 {
                continue;
            }
            tmdb_eps.entry((s, n)).or_insert_with(|| e.clone());
        }
    }
    if tmdb_eps.is_empty() {
        return Ok(None);
    }

    // TMDB documents the group payload as carrying full episode objects, but
    // do not bet the feature on it: if the payload came back as bare pointers
    // (no dates AND no titles) the aligner has nothing to score on, so hydrate
    // from the per-season endpoint instead.
    let hydrated = tmdb_eps
        .values()
        .filter(|e| e.air_date.is_some() || e.name.is_some())
        .count();
    if hydrated * 2 < tmdb_eps.len() {
        crate::devlog!(
            info, "arcs",
            "tmdb {tv_id}: group payload is pointer-only ({hydrated}/{} hydrated); fetching seasons",
            tmdb_eps.len()
        );
        let mut seasons: Vec<i64> = tmdb_eps.keys().map(|(s, _)| *s).collect();
        seasons.sort_unstable();
        seasons.dedup();
        for s in seasons {
            let body = match cached_get(
                &app,
                &format!("season:{tv_id}:{s}"),
                &format!("/tv/{tv_id}/season/{s}"),
                &key,
            )
            .await
            {
                Ok(b) => b,
                Err(e) => {
                    crate::devlog!(warn, "arcs", "season {s} fetch failed: {e}");
                    continue;
                }
            };
            let Ok(sd) = serde_json::from_str::<SeasonDetail>(&body) else { continue };
            for se in sd.episodes {
                let (Some(sn), Some(en)) = (se.season_number, se.episode_number) else { continue };
                if let Some(slot) = tmdb_eps.get_mut(&(sn, en)) {
                    if slot.name.is_none() {
                        slot.name = se.name;
                    }
                    if slot.air_date.is_none() {
                        slot.air_date = se.air_date;
                    }
                    if slot.still_path.is_none() {
                        slot.still_path = se.still_path;
                    }
                }
            }
        }
    }

    let mut tmdb_sorted: Vec<((i64, i64), GroupEpisode)> =
        tmdb_eps.iter().map(|(k, v)| (*k, v.clone())).collect();
    tmdb_sorted.sort_by_key(|((s, e), _)| (*s, *e));

    // 4. Align.
    let left: Vec<AlignEpisode> = tmdb_sorted
        .iter()
        .map(|((s, e), ep)| AlignEpisode {
            key: format!("{s}:{e}"),
            title: ep.name.clone().unwrap_or_default(),
            day: ep.air_date.as_deref().and_then(arc_align::parse_day),
        })
        .collect();
    let right: Vec<AlignEpisode> = aura
        .iter()
        .map(|v| AlignEpisode {
            key: v.id.clone(),
            title: v.title.clone().unwrap_or_default(),
            day: v.released.as_deref().and_then(arc_align::parse_day),
        })
        .collect();

    let alignment = arc_align::align(&left, &right);
    // min_confidence is the number that matters (it is what the arc gate below
    // compares against); min_score is logged alongside it because a big gap
    // between the two means the data was thin, not that the join was bad.
    crate::devlog!(
        info, "arcs",
        "tmdb {tv_id} grouping '{}': aligned {} pairs ({} tmdb-only, {} aura-only), min confidence {:.2} (raw score {:.2})",
        chosen.name,
        alignment.pairs.len(),
        alignment.left_only.len(),
        alignment.right_only.len(),
        alignment.min_confidence(),
        alignment.min_score()
    );

    // Fast lookup of the Aura video behind a mapped id, for year ranges and
    // the still fallback.
    let by_id: HashMap<&str, &ArcVideoRef> =
        aura.iter().map(|v| (v.id.as_str(), *v)).collect();
    let tmdb_by_key: HashMap<String, &GroupEpisode> = tmdb_sorted
        .iter()
        .map(|((s, e), ep)| (format!("{s}:{e}"), ep))
        .collect();

    // 5. Arc art. Best-effort and never fatal: a failed wiki fetch just means
    //    the cards fall back to episode stills.
    let arc_names: Vec<String> = detail.groups.iter().map(|b| b.name.clone()).collect();
    let art = crate::arc_art::resolve_arc_art(app, tv_id, &arc_names).await;

    // 6. Build the arcs.
    let mut buckets: Vec<&GroupBucket> = detail.groups.iter().collect();
    buckets.sort_by_key(|b| b.order);

    // Index the alignment once: `Alignment::map` / `confidence_of` are each a
    // linear scan over ~1168 pairs, and the loop below calls both per episode,
    // so using them directly is O(episodes * pairs) (~1.3M string compares on
    // One Piece). One HashMap turns the inner lookups into O(1).
    let aligned: HashMap<&str, (&str, f64)> = alignment
        .pairs
        .iter()
        .map(|p| (p.left_key.as_str(), (p.right_key.as_str(), p.confidence)))
        .collect();

    let mut arcs: Vec<StoryArc> = Vec::new();
    let mut rejected = 0usize;

    for bucket in buckets {
        let mut episode_ids: Vec<String> = Vec::new();
        let mut dropped = 0usize;
        let mut worst = 1.0f64;
        let mut still: Option<String> = None;

        for e in &bucket.episodes {
            let (Some(s), Some(n)) = (e.season_number, e.episode_number) else {
                dropped += 1;
                continue;
            };
            if s < 1 {
                // A season-0 member. TMDB's and the addon's specials do not
                // correspond; dropping beats guessing.
                dropped += 1;
                continue;
            }
            let tkey = format!("{s}:{n}");
            match aligned.get(tkey.as_str()) {
                Some(&(aura_id, confidence)) => {
                    // `confidence`, NOT the raw score. The raw score is not
                    // comparable across pairs: an episode missing an air date on
                    // either side can never exceed the title weight (0.45), so
                    // gating the raw score against 0.5 would reject a perfectly
                    // aligned arc for having ONE dateless episode, which is
                    // routine on ongoing shows and on TMDB's newest entries.
                    // Confidence renormalises against the evidence available.
                    worst = worst.min(confidence);
                    if still.is_none() {
                        still = tmdb_by_key
                            .get(&tkey)
                            .and_then(|ge| ge.still_path.clone())
                            .map(|p| format!("{TMDB_STILL_BASE}{p}"));
                    }
                    episode_ids.push(aura_id.to_string());
                }
                None => dropped += 1,
            }
        }

        if episode_ids.is_empty() {
            continue;
        }
        // Fail visible, never fail off-by-one. An arc we are not confident
        // about is an arc that silently starts and ends on the wrong episode,
        // which is exactly the failure this whole module exists to prevent.
        if worst < MIN_PAIR_CONFIDENCE {
            crate::devlog!(
                warn, "arcs",
                "dropping arc '{}': low alignment confidence {:.2}",
                bucket.name, worst
            );
            rejected += 1;
            continue;
        }

        // Year range, from Aura's own release dates so the chip agrees with
        // the episode rows.
        let years: Vec<i64> = episode_ids
            .iter()
            .filter_map(|id| by_id.get(id.as_str()))
            .filter_map(|v| v.released.as_deref())
            .filter_map(|d| d.get(0..4).and_then(|y| y.parse::<i64>().ok()))
            .filter(|y| *y > 1900 && *y < 2200)
            .collect();

        let image_fandom = art.get(&arc_art::normalize_arc_name(&bucket.name)).cloned();
        let image_episode = episode_ids
            .first()
            .and_then(|id| by_id.get(id.as_str()))
            .and_then(|v| v.thumbnail.clone());

        let (image, image_source) = match (image_fandom, still, image_episode) {
            (Some(f), _, _) => (Some(f), "fandom"),
            (None, Some(s), _) => (Some(s), "tmdb"),
            (None, None, Some(e)) => (Some(e), "episode"),
            _ => (None, "none"),
        };

        arcs.push(StoryArc {
            id: if bucket.id.is_empty() {
                format!("{}:{}", chosen.id, bucket.order)
            } else {
                bucket.id.clone()
            },
            name: bucket.name.clone(),
            order: bucket.order,
            episode_ids,
            image,
            image_source: image_source.to_string(),
            year_start: years.iter().min().copied(),
            year_end: years.iter().max().copied(),
            dropped,
        });
    }

    if arcs.is_empty() {
        crate::devlog!(warn, "arcs", "tmdb {tv_id}: every arc was rejected or empty");
        return Ok(None);
    }

    Ok(Some(ArcResult {
        grouping_id: chosen.id,
        grouping_name: chosen.name,
        groupings,
        arcs,
        rejected,
    }))
}

// Re-export so `arcs::arc_art` reads naturally at the one call site above.
use crate::arc_art;

#[cfg(test)]
mod tests {
    use super::*;

    fn grp(name: &str, kind: i64, count: i64, eps: i64) -> GroupSummary {
        GroupSummary {
            id: "x".into(),
            name: name.into(),
            description: String::new(),
            kind,
            group_count: count,
            episode_count: eps,
        }
    }

    #[test]
    fn air_order_and_season_groupings_are_rejected_outright() {
        // These carry TMDB type 5 ("Story Arc") on real shows but are the season
        // list relabelled, not arcs. Naruto's "Seasons" was slipping onto the
        // grouping switcher; it must score None.
        for bad in ["Seasons", "season", "TVDB Order", "Wikipedia Order", "Absolute Order"] {
            assert!(is_not_an_arc_grouping(bad), "{bad} should be rejected");
            assert!(
                score_grouping(&grp(bad, GROUP_TYPE_STORY_ARC, 20, 220), 220).is_none(),
                "{bad} must not score",
            );
        }
    }

    #[test]
    fn real_arc_groupings_score() {
        // Naruto's genuine arc groupings must survive.
        for good in ["Story Arcs with Filler", "Official Story Arcs", "Italian Sagas", "Sagas"] {
            assert!(!is_not_an_arc_grouping(good), "{good} should NOT be rejected");
            assert!(
                score_grouping(&grp(good, GROUP_TYPE_STORY_ARC, 10, 220), 220).is_some(),
                "{good} must score",
            );
        }
    }

    #[test]
    fn low_coverage_and_single_bucket_are_rejected() {
        // "Manga Story Arcs" (129 of 220) leaves a third of the show in no arc.
        assert!(score_grouping(&grp("Manga Story Arcs", GROUP_TYPE_STORY_ARC, 5, 129), 220).is_none());
        // A single bucket is the whole show, not a partition.
        assert!(score_grouping(&grp("Everything", GROUP_TYPE_STORY_ARC, 1, 220), 220).is_none());
        // Wrong type is never an arc grouping.
        assert!(score_grouping(&grp("Absolute", 2, 2, 220), 220).is_none());
    }
}
