// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Which manga chapters an anime adapts.
//!
//! Three answers, from two sources, each at the grain its source actually has:
//!
//! 1. SERIES: how far the anime has got, and where to pick the manga up.
//!    MangaUpdates' public API (no key) records it per manga as two strings,
//!    `anime.start` / `anime.end`, e.g. "Vol 113, Chap 1150 (As of EP 1180)".
//!    The strings are parsed strictly (`parse_mu_anime`): anything the parser
//!    does not fully understand yields nothing, never the raw text and never a
//!    guess.
//! 2. ARC: a chapter range per story arc, read from the RENDERED infobox of
//!    the arc's Fandom page ("Manga Chapters: 1058-1125, 68 chapters"). The
//!    wikitext often says `chapter = auto`, so only the rendered HTML has the
//!    numbers. Arcs reach their page through `arc_art::resolve_arc_pages`,
//!    i.e. BY PAGE, never by episode number.
//! 3. EPISODE: on wikis whose episode infobox lists the chapters it adapts
//!    (Bleach `chapters`, Jujutsu Kaisen `adapted from`, see the curated table
//!    in `arc_art.rs`).
//!
//! THE NUMBERING LANDMINE (CLAUDE.md, Story arcs). Wikis number episodes the
//! OFFICIAL way (One Piece counts the Toriko crossover special as 590), while
//! Aura's episodes come from the user's metadata addon (Cinemeta files it as
//! S0E39, so Aura's 590 is the wiki's 591). A per-episode join by number would
//! be off by one for half of One Piece and look right. So the wiki's "Episode
//! N" is only a page NAME here: episodes are joined on AIR DATE
//! (`join_by_air_date`), with title similarity as the tie-break for two
//! episodes on one day, and anything still ambiguous is dropped. One Piece's
//! episode pages carry no Japanese air date at all (only the 2012 remaster's),
//! so One Piece gets arc ranges and no per-episode chapters, which is the
//! honest answer.
//!
//! Everything is lazy (the frontend asks only for an anime series' detail
//! page, and for episodes only while the episode list is shown), batched (50
//! episode pages per request), and cached on disk, bounded
//! (`manga-chapters-v1.json`).
//!
//! Devlog label: `[manga]`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::arc_align::{dice_bigram, normalize_title};
use crate::arc_art::{self, EpisodeFields, Wiki};

const MU_API: &str = "https://api.mangaupdates.com/v1";
const TIMEOUT: Duration = Duration::from_secs(12);

/// A series match: a week. MangaUpdates moves `anime.end` forward as the
/// anime airs, so a longer TTL would keep an old "continue from".
const MU_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
/// Wiki pages (arc infoboxes, episode pages): a month. A finished arc's
/// chapters do not change.
const WIKI_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// Every miss, and anything that may still be being written (a recent episode
/// page): a day. A miss is ambiguous between "not there" and "not there yet".
const MISS_TTL: Duration = Duration::from_secs(24 * 3600);
/// An episode page for something that aired within this window is cached like
/// a miss: new pages are often created before their chapter field is filled.
const FRESH_EPISODE_DAYS: i64 = 60;

/// Bounds. Episode pages dominate (Bleach is ~410), so the cap is sized for a
/// handful of long shows, and the oldest entries go first.
const CACHE_CAP: usize = 5000;
/// Never ask for more episode pages than this for one show.
const MAX_EPISODE_PAGES: u32 = 1500;
/// MediaWiki's per-request title limit for a non-bot client.
const TITLES_PER_REQUEST: usize = 50;
/// Arc infobox fetches in flight at once, to be gentle with Fandom.
const ARC_FETCH_CONCURRENCY: usize = 4;
const MAX_ARC_PAGES: usize = 120;

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .pool_max_idle_per_host(1)
            .user_agent("Aura/2 (+https://github.com/rm-sage/Aura) manga-chapters")
            .build()
            .expect("manga_chapters HTTP client init failed")
    })
}

async fn get_text(url: &str) -> Result<String, String> {
    let resp = client().get(url).send().await.map_err(|e| crate::stremio::reqwest_err_for_log(&e))?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    resp.text().await.map_err(|e| crate::stremio::reqwest_err_for_log(&e))
}

// ---------------------------------------------------------------------------
// Disk cache: one file, typed values stored as JSON, per-entry TTL.
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
struct CacheEntry {
    fetched_at: u64,
    ttl_secs: u64,
    value: serde_json::Value,
}

type CacheMap = HashMap<String, CacheEntry>;

static CACHE: OnceLock<Mutex<CacheMap>> = OnceLock::new();
static CACHE_LOADED: AtomicBool = AtomicBool::new(false);
static CACHE_DIRTY: AtomicBool = AtomicBool::new(false);

fn cache() -> &'static Mutex<CacheMap> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("manga-chapters-v1.json"))
}

async fn ensure_cache_loaded<R: Runtime>(app: &AppHandle<R>) {
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

/// Write once per command, and only when something new was inserted.
async fn persist_if_dirty<R: Runtime>(app: &AppHandle<R>) {
    if !CACHE_DIRTY.swap(false, Ordering::AcqRel) {
        return;
    }
    let Some(path) = cache_path(app) else { return };
    let snapshot = {
        let Ok(mut lock) = cache().lock() else { return };
        let now = now_secs();
        lock.retain(|_, e| now.saturating_sub(e.fetched_at) < e.ttl_secs);
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

/// `Some(value)` for a fresh entry (whose value may itself be a cached miss).
fn cache_get<T: serde::de::DeserializeOwned>(key: &str) -> Option<T> {
    let lock = cache().lock().ok()?;
    let e = lock.get(key)?;
    if now_secs().saturating_sub(e.fetched_at) >= e.ttl_secs {
        return None;
    }
    serde_json::from_value(e.value.clone()).ok()
}

fn cache_put<T: Serialize>(key: String, value: &T, ttl: Duration) {
    let Ok(value) = serde_json::to_value(value) else { return };
    if let Ok(mut lock) = cache().lock() {
        lock.insert(key, CacheEntry { fetched_at: now_secs(), ttl_secs: ttl.as_secs(), value });
        CACHE_DIRTY.store(true, Ordering::Release);
    }
}

// ---------------------------------------------------------------------------
// Public shapes (Rust -> React). No serde renames: see CLAUDE.md's quirk.
// ---------------------------------------------------------------------------

/// A MangaUpdates series, reduced to what the detail page can say truthfully.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MangaSeries {
    pub series_id: u64,
    pub title: String,
    pub url: Option<String>,
    /// The first chapter the anime adapts, when that is known.
    pub adapts_from: Option<u32>,
    /// The furthest chapter the anime has adapted. `None` when MangaUpdates
    /// records a segment that has started but not ended (Bleach: TYBW part 4
    /// starts at 661 with no end yet), because the last recorded end would
    /// then understate the anime.
    pub reach: Option<u32>,
    /// The anime stops partway into `reach` ("Chap 181 Page 14"), so the manga
    /// picks up in that same chapter rather than the next one.
    pub reach_partial: bool,
    /// MangaUpdates' latest chapter, only when it is past `reach`.
    /// (Its figure can be wrong: Bleach's reads 250 for a 686-chapter manga,
    /// and that is below the anime's reach, so it is dropped here.)
    pub latest: Option<u32>,
    pub completed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChapterRange {
    pub start: u32,
    pub end: u32,
}

#[derive(Deserialize)]
pub struct EpisodeRef {
    pub id: String,
    #[serde(default)]
    pub released: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub season: Option<i64>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum MangaAction {
    /// The detail page's "continue in the manga" line.
    Series {
        /// The anime's own titles (name first), used only when MAL gives no
        /// adaptation title.
        #[serde(default)]
        titles: Vec<String>,
        #[serde(default)]
        year: Option<u32>,
        /// MyAnimeList id of the first cour, when Aura resolved one. Its
        /// `source` and "Adaptation" relation make the match far safer.
        #[serde(default)]
        mal_id: Option<u32>,
    },
    /// Chapter ranges for a set of TMDB arc names.
    Arcs {
        #[serde(default)]
        tmdb_id: Option<i64>,
        #[serde(default)]
        imdb_id: Option<String>,
        arc_names: Vec<String>,
    },
    /// Per-episode chapters, joined onto Aura's own episode ids.
    Episodes {
        #[serde(default)]
        tmdb_id: Option<i64>,
        #[serde(default)]
        imdb_id: Option<String>,
        videos: Vec<EpisodeRef>,
    },
}

#[derive(Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum MangaReply {
    Series { series: Option<MangaSeries> },
    /// Keyed by the arc name exactly as it was sent.
    Arcs { ranges: HashMap<String, ChapterRange> },
    /// `supported` is false when the show's wiki has no per-episode field.
    /// An empty chapter list is the wiki saying the episode adapts nothing
    /// (an anime original).
    Episodes { supported: bool, chapters: HashMap<String, Vec<u32>> },
}

#[tauri::command]
pub async fn manga_chapters<R: Runtime>(app: AppHandle<R>, action: MangaAction) -> Result<MangaReply, String> {
    ensure_cache_loaded(&app).await;
    let out = match action {
        MangaAction::Series { titles, year, mal_id } => {
            series(&titles, year, mal_id).await.map(|series| MangaReply::Series { series })
        }
        MangaAction::Arcs { tmdb_id, imdb_id, arc_names } => {
            arcs(&app, tmdb_id, imdb_id.as_deref(), &arc_names).await.map(|ranges| MangaReply::Arcs { ranges })
        }
        MangaAction::Episodes { tmdb_id, imdb_id, videos } => episodes(&app, tmdb_id, imdb_id.as_deref(), &videos)
            .await
            .map(|(supported, chapters)| MangaReply::Episodes { supported, chapters }),
    };
    persist_if_dirty(&app).await;
    out
}

// ---------------------------------------------------------------------------
// 1. Series, from MangaUpdates
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct MuSearch {
    #[serde(default)]
    results: Vec<MuHit>,
}

#[derive(Deserialize)]
struct MuHit {
    record: MuRecord,
    #[serde(default)]
    hit_title: Option<String>,
}

#[derive(Deserialize)]
struct MuRecord {
    series_id: u64,
    #[serde(default)]
    title: String,
    #[serde(rename(deserialize = "type"), default)]
    kind: Option<String>,
    #[serde(default)]
    year: Option<String>,
}

#[derive(Deserialize)]
struct MuSeries {
    series_id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    anime: Option<MuAnime>,
    #[serde(default)]
    latest_chapter: Option<u32>,
    #[serde(default)]
    completed: Option<bool>,
}

#[derive(Deserialize)]
struct MuAnime {
    #[serde(default)]
    start: Option<String>,
    #[serde(default)]
    end: Option<String>,
}

/// One "Vol 113, Chap 1150" in `anime.start` / `anime.end`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct MuSegment {
    lo: u32,
    hi: u32,
    /// "Chap 181 Page 14": only part of the chapter.
    partial: bool,
}

/// What `anime.start` + `anime.end` say, together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Adaptation {
    adapts_from: Option<u32>,
    reach: Option<u32>,
    reach_partial: bool,
}

/// Remove every parenthesised note, "(As of EP 1180)", "(Chap 1 adapted in EP
/// 4)", "(TYBW P1)". Their numbers are not the segment's chapter. `None` on
/// unbalanced parentheses, which is text the parser does not understand.
fn strip_parens(s: &str) -> Option<String> {
    let mut out = String::with_capacity(s.len());
    let mut depth = 0i32;
    for c in s.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => {
                depth -= 1;
                if depth < 0 {
                    return None;
                }
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    (depth == 0).then_some(out)
}

/// Parse one segment strictly. Accepts "Vol 1, Chap 1", "Chap 1150",
/// "Chapter 1150-1151", "Ch. 12", "Vol 21, Chap 181 Page 14". Anything else,
/// including a decimal chapter or a second chapter mention, is `None`.
fn parse_mu_segment(raw: &str) -> Option<MuSegment> {
    let text = strip_parens(raw)?.to_ascii_lowercase().replace(',', " ");
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut found: Option<MuSegment> = None;
    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        let is_chap = matches!(w, "chap" | "chap." | "chapter" | "ch" | "ch." | "c.");
        // "ch.1150", "c.1150" written without a space.
        let glued = ["chap.", "ch.", "c."]
            .iter()
            .find_map(|p| w.strip_prefix(p).filter(|r| r.starts_with(|c: char| c.is_ascii_digit())));
        let (num_token, next) = if is_chap {
            (*words.get(i + 1)?, i + 2)
        } else if let Some(rest) = glued {
            (rest, i + 1)
        } else {
            i += 1;
            continue;
        };
        if found.is_some() {
            return None; // two chapter mentions in one segment
        }
        let (lo, hi) = parse_number_or_range(num_token)?;
        let mut j = next;
        // "1150 - 1151" spelled with spaces.
        if matches!(words.get(j), Some(&"-") | Some(&"~")) {
            let (hi2, _) = parse_number_or_range(words.get(j + 1)?)?;
            if hi2 < lo {
                return None;
            }
            found = Some(MuSegment { lo, hi: hi2, partial: false });
            j += 2;
        } else {
            found = Some(MuSegment { lo, hi, partial: false });
        }
        if matches!(words.get(j), Some(&"page") | Some(&"pages") | Some(&"pg") | Some(&"p.") | Some(&"p")) {
            if let Some(seg) = found.as_mut() {
                seg.partial = true;
            }
            j += 2;
        }
        i = j;
    }
    found
}

/// "1150" or "1150-1151". A decimal, a sign, or anything else is `None`.
fn parse_number_or_range(tok: &str) -> Option<(u32, u32)> {
    let tok = tok.trim();
    let (a, b) = match tok.split_once(['-', '~']) {
        Some((a, b)) => (a, Some(b)),
        None => (tok, None),
    };
    let lo = parse_chapter_number(a)?;
    let hi = match b {
        Some(b) => parse_chapter_number(b)?,
        None => lo,
    };
    (lo <= hi).then_some((lo, hi))
}

fn parse_chapter_number(s: &str) -> Option<u32> {
    let s = s.trim();
    if s.is_empty() || s.len() > 6 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok().filter(|n: &u32| *n > 0)
}

/// Parse `anime.start` and `anime.end` together. Segments are separated by
/// " / " (Bleach and Jujutsu Kaisen list one per season or part). Any
/// segment that does not parse makes the whole answer `None`.
fn parse_mu_anime(start: &str, end: &str) -> Option<Adaptation> {
    let parse_list = |s: &str| -> Option<Vec<MuSegment>> {
        let s = s.trim();
        if s.is_empty() {
            return Some(Vec::new());
        }
        s.split(" / ").map(parse_mu_segment).collect()
    };
    let starts = parse_list(start)?;
    let ends = parse_list(end)?;
    if starts.is_empty() && ends.is_empty() {
        return None;
    }
    let adapts_from = starts.iter().map(|s| s.lo).min();
    let last_end = ends.iter().max_by_key(|e| (e.hi, !e.partial));
    let last_start = starts.iter().map(|s| s.lo).max();
    let (reach, reach_partial) = match last_end {
        // A segment that began after the last recorded end has no end yet.
        Some(e) if last_start.is_some_and(|s| s > e.hi) => (None, false),
        Some(e) => (Some(e.hi), e.partial),
        None => (None, false),
    };
    Some(Adaptation { adapts_from, reach, reach_partial })
}

/// The manga types an anime can adapt with chapter numbering.
fn is_comic_type(kind: Option<&str>) -> bool {
    kind.is_some_and(|k| {
        let k = k.to_ascii_lowercase();
        k == "manga" || k == "manhwa" || k == "manhua"
    })
}

/// Pick the series among search hits: a comic type, a title (or the matched
/// alternate title) EXACTLY equal to one of `queries` after normalization,
/// not dated after the anime, and the earliest such. Two candidates tied on
/// the earliest year are ambiguous: no match beats a wrong one.
fn pick_series(hits: &[MuHit], queries: &[String], anime_year: Option<u32>) -> Option<u64> {
    let wanted: HashSet<String> = queries.iter().map(|q| normalize_title(q)).filter(|q| !q.is_empty()).collect();
    let mut cands: Vec<(u32, u64)> = hits
        .iter()
        .filter(|h| is_comic_type(h.record.kind.as_deref()))
        .filter(|h| {
            wanted.contains(&normalize_title(&h.record.title))
                || h.hit_title.as_deref().is_some_and(|t| wanted.contains(&normalize_title(t)))
        })
        .filter_map(|h| {
            let year = h.record.year.as_deref().and_then(|y| y.trim().parse::<u32>().ok());
            if let (Some(y), Some(a)) = (year, anime_year) {
                if y > a {
                    return None;
                }
            }
            Some((year.unwrap_or(u32::MAX), h.record.series_id))
        })
        .collect();
    cands.sort();
    cands.dedup_by_key(|c| c.1);
    match cands.as_slice() {
        [] => None,
        [only] => Some(only.1),
        [a, b, ..] if a.0 != b.0 => Some(a.1),
        _ => None,
    }
}

async fn mu_search(query: &str) -> Result<Vec<MuHit>, String> {
    let body = serde_json::json!({ "search": query, "perpage": 25 });
    let resp = client()
        .post(format!("{MU_API}/series/search"))
        .json(&body)
        .send()
        .await
        .map_err(|e| crate::stremio::reqwest_err_for_log(&e))?;
    if !resp.status().is_success() {
        return Err(format!("MangaUpdates search HTTP {}", resp.status()));
    }
    let parsed: MuSearch = resp.json().await.map_err(|e| format!("MangaUpdates search parse: {e}"))?;
    Ok(parsed.results)
}

/// The search strings to try, in order: MAL's "Adaptation" manga titles
/// first (the source material by name), then the anime's own titles. `None`
/// when MAL says the anime is NOT adapted from a manga.
async fn series_queries(titles: &[String], mal_id: Option<u32>) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    if let Some(full) = match mal_id {
        Some(id) if id > 0 => crate::tenrai::anime_full(id).await,
        _ => None,
    } {
        if let Some(src) = full.source.as_deref() {
            // "Manga", "Web manga", "4-koma manga". A light novel, a game or
            // an original has no chapters for this line to count.
            if !src.to_ascii_lowercase().contains("manga") {
                return None;
            }
        }
        for rel in &full.relations {
            if !rel.relation.as_deref().is_some_and(|r| r.eq_ignore_ascii_case("Adaptation")) {
                continue;
            }
            for e in &rel.entry {
                if e.kind.as_deref().is_some_and(|k| k.eq_ignore_ascii_case("manga")) {
                    if let Some(n) = e.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
                        out.push(n.to_string());
                    }
                }
            }
        }
    }
    for t in titles {
        let t = t.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
    let mut seen = HashSet::new();
    out.retain(|q| seen.insert(normalize_title(q)));
    out.truncate(3);
    Some(out)
}

pub(crate) async fn series(titles: &[String], year: Option<u32>, mal_id: Option<u32>) -> Result<Option<MangaSeries>, String> {
    let key = {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        for t in titles {
            h.update(normalize_title(t).as_bytes());
            h.update([0u8]);
        }
        format!("mu:{}:{}:{}", mal_id.unwrap_or(0), year.unwrap_or(0), hex::encode(&h.finalize()[..6]))
    };
    if let Some(hit) = cache_get::<Option<MangaSeries>>(&key) {
        return Ok(hit);
    }

    let Some(queries) = series_queries(titles, mal_id).await else {
        crate::devlog!(info, "manga", "mal {:?}: not adapted from a manga; no chapter line", mal_id);
        cache_put(key, &None::<MangaSeries>, MU_TTL);
        return Ok(None);
    };
    let mut picked: Option<u64> = None;
    for q in &queries {
        let hits = mu_search(q).await?;
        if let Some(id) = pick_series(&hits, &queries, year) {
            picked = Some(id);
            break;
        }
    }
    let Some(id) = picked else {
        crate::devlog!(info, "manga", "no MangaUpdates series matched {:?}", queries);
        cache_put(key, &None::<MangaSeries>, MISS_TTL);
        return Ok(None);
    };

    let text = get_text(&format!("{MU_API}/series/{id}")).await?;
    let mu: MuSeries = serde_json::from_str(&text).map_err(|e| format!("MangaUpdates series parse: {e}"))?;
    let result = build_series(&mu);
    match &result {
        Some(s) => crate::devlog!(
            info, "manga",
            "MangaUpdates {} '{}': from {:?}, reach {:?}{}, latest {:?}",
            s.series_id, s.title, s.adapts_from, s.reach,
            if s.reach_partial { " (partway)" } else { "" }, s.latest
        ),
        None => crate::devlog!(info, "manga", "MangaUpdates {id}: no parseable anime range; nothing shown"),
    }
    cache_put(key, &result, if result.is_some() { MU_TTL } else { MISS_TTL });
    Ok(result)
}

fn build_series(mu: &MuSeries) -> Option<MangaSeries> {
    let anime = mu.anime.as_ref()?;
    let adaptation = parse_mu_anime(anime.start.as_deref().unwrap_or(""), anime.end.as_deref().unwrap_or(""))?;
    let latest = mu.latest_chapter.filter(|l| adaptation.reach.is_some_and(|r| *l > r));
    Some(MangaSeries {
        series_id: mu.series_id,
        title: mu.title.clone(),
        url: mu.url.clone().filter(|u| u.starts_with("https://")),
        adapts_from: adaptation.adapts_from,
        reach: adaptation.reach,
        reach_partial: adaptation.reach_partial,
        latest,
        completed: mu.completed.unwrap_or(false),
    })
}

// ---------------------------------------------------------------------------
// 2. Arc ranges, from the rendered arc infobox
// ---------------------------------------------------------------------------

/// Decode the handful of entities a portable infobox uses and fold dash
/// variants to an ASCII hyphen.
fn decode_entities(s: &str) -> String {
    s.replace("&#160;", " ")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&#8211;", "-")
        .replace("&#8212;", "-")
        .replace("&ndash;", "-")
        .replace("&mdash;", "-")
        .replace(['\u{2013}', '\u{2014}', '\u{2212}'], "-")
}

/// Drop every `<...>` tag, keeping the text between them.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// The first chapter range in an infobox value: "1058-1125, 68 chapters",
/// "Chapter 138 - 221", "Chapters 186 - 318", "67 - 97". An OPEN range
/// ("1126-present", "Chapter 138 - TBA") is `None`: its end is not known.
fn parse_range_value(value: &str) -> Option<ChapterRange> {
    let v = decode_entities(value);
    let b = v.as_bytes();
    let mut i = 0;
    while i < b.len() && !b[i].is_ascii_digit() {
        i += 1;
    }
    let s0 = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let start = parse_chapter_number(&v[s0..i])?;
    let mut j = i;
    while j < b.len() && b[j] == b' ' {
        j += 1;
    }
    if j < b.len() && (b[j] == b'-' || b[j] == b'~') {
        j += 1;
        while j < b.len() && b[j] == b' ' {
            j += 1;
        }
        // "Chapters 1 - Chapter 20" is not a format any wiki uses; only a
        // number may follow the dash.
        let e0 = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        let end = parse_chapter_number(&v[e0..j])?;
        return (start <= end).then_some(ChapterRange { start, end });
    }
    Some(ChapterRange { start, end: start })
}

/// Read the manga chapter range out of a rendered portable infobox. An item
/// counts when its `data-source` is `chapter` / `chapters`, or its label
/// mentions chapters, or the label is just "Manga" (Jujutsu Kaisen and Demon
/// Slayer), and never when the label is about episodes.
pub(crate) fn parse_infobox_chapters(html: &str) -> Option<ChapterRange> {
    let marker = "data-source=\"";
    let mut rest = html;
    while let Some(pos) = rest.find(marker) {
        let after = &rest[pos + marker.len()..];
        let Some(q) = after.find('"') else { break };
        let source = after[..q].to_ascii_lowercase();
        // This item runs to the next item.
        let body_end = after[q..].find(marker).map(|n| q + n).unwrap_or(after.len());
        let body = &after[q..body_end];
        rest = &after[q..];

        let label = body
            .find("<h3")
            .and_then(|h| body[h..].find('>').map(|g| h + g + 1))
            .and_then(|l0| body[l0..].find("</h3>").map(|l1| &body[l0..l0 + l1]))
            .map(|l| decode_entities(&strip_tags(l)).trim().trim_end_matches(':').trim().to_ascii_lowercase())
            .unwrap_or_default();
        let is_chapter_item = (source == "chapter"
            || source == "chapters"
            || label.contains("chapter")
            || label == "manga")
            && !label.contains("episode")
            && !source.contains("episode");
        if !is_chapter_item {
            continue;
        }
        let Some(v0) = body.find("pi-data-value") else { continue };
        let Some(g) = body[v0..].find('>') else { continue };
        let value_html = &body[v0 + g + 1..];
        let value_html = value_html.find("</div>").map(|e| &value_html[..e]).unwrap_or(value_html);
        return parse_range_value(&strip_tags(value_html));
    }
    None
}

#[derive(Deserialize)]
struct ParseResponse {
    #[serde(default)]
    parse: Option<ParseBody>,
    #[serde(default)]
    error: Option<serde::de::IgnoredAny>,
}

#[derive(Deserialize)]
struct ParseBody {
    #[serde(default)]
    text: String,
}

/// One arc page's range, cached. `Err` is a failure to ask.
async fn arc_page_range(host: &str, page: &str) -> Result<Option<ChapterRange>, String> {
    let key = format!("arc:{host}:{page}");
    if let Some(hit) = cache_get::<Option<ChapterRange>>(&key) {
        return Ok(hit);
    }
    let url = format!(
        "https://{host}/api.php?action=parse&page={}&prop=text&section=0&redirects=1&format=json&formatversion=2",
        urlencode(page)
    );
    let text = get_text(&url).await?;
    let parsed: ParseResponse = serde_json::from_str(&text).map_err(|e| format!("parse response: {e}"))?;
    let range = match (parsed.parse, parsed.error) {
        (Some(p), _) => parse_infobox_chapters(&p.text),
        (None, Some(_)) => None, // missingtitle and friends: an answer
        (None, None) => return Err("empty parse response".into()),
    };
    cache_put(key, &range, if range.is_some() { WIKI_TTL } else { MISS_TTL });
    Ok(range)
}

async fn arcs<R: Runtime>(
    app: &AppHandle<R>,
    tmdb_id: Option<i64>,
    imdb_id: Option<&str>,
    arc_names: &[String],
) -> Result<HashMap<String, ChapterRange>, String> {
    let Some(tv) = crate::arcs::resolve_tv_id(app, tmdb_id, imdb_id).await? else { return Ok(HashMap::new()) };
    let Some(wiki) = arc_art::wiki_for(tv) else { return Ok(HashMap::new()) };
    let pages = arc_art::resolve_arc_pages(app, tv, arc_names).await;
    arc_ranges_for(wiki, arc_names, &pages).await
}

/// Given each arc's page, fetch the ranges. A part of an arc ("Wano Country
/// Part 2") and any arc sharing its page with another arc get NOTHING: the
/// page's range is the whole arc's, and showing it on a part would claim the
/// part covers all of it.
pub(crate) async fn arc_ranges_for(
    wiki: &Wiki,
    arc_names: &[String],
    pages: &HashMap<String, String>,
) -> Result<HashMap<String, ChapterRange>, String> {
    use futures_util::stream::{self, StreamExt};

    let mut per_page: HashMap<&str, usize> = HashMap::new();
    for p in pages.values() {
        *per_page.entry(p.as_str()).or_default() += 1;
    }
    let mut wanted: Vec<(String, String)> = Vec::new();
    for name in arc_names {
        let norm = arc_art::normalize_arc_name(name);
        if arc_art::part_family(&norm) != norm {
            continue;
        }
        let Some(page) = pages.get(&norm) else { continue };
        if per_page.get(page.as_str()).copied().unwrap_or(0) > 1 || !names_one_arc(name, page) {
            continue;
        }
        wanted.push((name.clone(), page.clone()));
    }
    wanted.truncate(MAX_ARC_PAGES);

    let host = wiki.host;
    let results: Vec<(String, Result<Option<ChapterRange>, String>)> = stream::iter(wanted)
        .map(|(name, page): (String, String)| async move {
            let r = arc_page_range(host, &page).await;
            (name, r)
        })
        .buffer_unordered(ARC_FETCH_CONCURRENCY)
        .collect()
        .await;
    let mut out = HashMap::new();
    let mut failed = 0usize;
    for (name, r) in results {
        match r {
            // A one-chapter "arc" is a page about something else (Bleach's
            // "The Lost Agent" lands on a page whose infobox says 424 alone,
            // for an arc that runs 424-479).
            Ok(Some(range)) if range.end > range.start => {
                out.insert(name, range);
            }
            Ok(_) => {}
            Err(_) => failed += 1,
        }
    }
    crate::devlog!(
        info, "manga",
        "{host}: chapter ranges for {}/{} arcs ({} pages resolved{})",
        out.len(), arc_names.len(), pages.len(),
        if failed > 0 { format!(", {failed} fetches failed") } else { String::new() }
    );
    Ok(out)
}

/// May this arc take its page's range? The art matcher accepts a similar
/// page (0.6 bigram similarity), which is fine for a picture and wrong for a
/// number: One Piece's combo grouping names "Water 7 & Enies Lobby Arc", which
/// lands on "Enies Lobby Arc", and printing 375-430 on it would drop Water 7's
/// 53 chapters. So a name that joins several arcs never takes one arc's range,
/// and the page's name must be about as long as the arc's (a spelling
/// difference like Alabasta / Arabasta, Skypia / Skypiea, Fishman / Fish-Man,
/// not a sub-arc).
fn names_one_arc(arc_name: &str, page: &str) -> bool {
    let raw = format!(" {} ", arc_name.to_ascii_lowercase());
    if [" & ", " and ", " / ", ", ", " + "].iter().any(|j| raw.contains(j)) {
        return false;
    }
    let (a, p) = (arc_art::normalize_arc_name(arc_name), arc_art::normalize_arc_name(page));
    let (a, p) = (a.replace(' ', ""), p.replace(' ', ""));
    let (short, long) = if a.len() <= p.len() { (a.len(), p.len()) } else { (p.len(), a.len()) };
    long > 0 && short * 4 >= long * 3
}

// ---------------------------------------------------------------------------
// 3. Per-episode chapters, from episode pages, joined by AIR DATE
// ---------------------------------------------------------------------------

/// One wiki episode page, reduced.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct WikiEpisode {
    /// Every Japanese broadcast date the page lists, as days since the epoch.
    pub days: Vec<i64>,
    pub title: String,
    /// `None`: the page has no chapter field. `Some(empty)`: the field is
    /// there and names no chapter (an anime original).
    pub chapters: Option<Vec<u32>>,
}

/// `|key = value` parameters of the page's templates, one per line. Keys are
/// lowercased and trimmed; the value runs to the end of its line.
fn template_params(wikitext: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for line in wikitext.lines() {
        let l = line.trim_start();
        let Some(rest) = l.strip_prefix('|') else { continue };
        let Some((k, v)) = rest.split_once('=') else { continue };
        let key = k.trim().to_ascii_lowercase();
        if key.is_empty() || key.len() > 40 {
            continue;
        }
        out.push((key, v.trim().to_string()));
    }
    out
}

/// Does `key` name the field `want`, or a numbered continuation of it
/// ("adapted 2" for "adapted")?
fn key_matches(key: &str, want: &str) -> bool {
    let want = want.to_ascii_lowercase();
    if key == want {
        return true;
    }
    key.strip_prefix(&want)
        .and_then(|r| r.strip_prefix(' '))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Chapter numbers in a chapter field. Linked chapters first: `[[Chapter
/// 402]]`, `[[Chapter 29|29]]`; anything that is not a "Chapter N" link
/// ("[[Short Mission 4]]") is ignored. With no links, a bare list or range
/// ("1-5", "45, 46") is read. A field that is empty or says none is
/// `Some(empty)`; one with text but no chapter at all is `None` (unknown).
pub(crate) fn parse_chapter_field(values: &[&str]) -> Option<Vec<u32>> {
    let mut nums: Vec<u32> = Vec::new();
    let mut any_text = false;
    for v in values {
        let mut rest = *v;
        while let Some(p) = rest.find("[[") {
            let after = &rest[p + 2..];
            let end = after.find("]]").unwrap_or(after.len());
            let target = after[..end].split('|').next().unwrap_or("").trim();
            if let Some(n) = target
                .strip_prefix("Chapter ")
                .or_else(|| target.strip_prefix("chapter "))
                .and_then(|n| parse_chapter_number(n.trim()))
            {
                nums.push(n);
            }
            rest = &after[end.min(after.len())..];
        }
        let plain = strip_tags(v).trim().to_string();
        let lowered = plain.to_ascii_lowercase();
        if !plain.is_empty() && !matches!(lowered.as_str(), "none" | "n/a" | "na" | "-" | "tba" | "?") {
            any_text = true;
        }
    }
    if nums.is_empty() && any_text {
        // Unlinked: only a value made of numbers, ranges, commas and "and".
        let joined = values.join(",");
        let cleaned = decode_entities(&strip_tags(&joined)).replace(" and ", ",");
        let ok = cleaned.chars().all(|c| c.is_ascii_digit() || matches!(c, ',' | '-' | ' '));
        if !ok {
            return None;
        }
        for part in cleaned.split(',') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let (lo, hi) = parse_number_or_range(&part.replace(' ', ""))?;
            if hi - lo > 60 {
                return None;
            }
            nums.extend(lo..=hi);
        }
        if nums.is_empty() {
            return None;
        }
    }
    nums.sort_unstable();
    nums.dedup();
    Some(nums)
}

const MONTHS: [&str; 12] = [
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
    "november", "december",
];

fn month_number(word: &str) -> Option<i64> {
    let w = word.trim_end_matches('.').to_ascii_lowercase();
    if w.len() < 3 {
        return None;
    }
    MONTHS.iter().position(|m| m.starts_with(&w) && (w.len() == 3 || w.len() == m.len() || w == "sept"))
        .map(|i| i as i64 + 1)
}

/// Remove `<sup>`, `<small>` and `<ref>` elements WITH their content ("2<sup>nd
/// </sup>", "<small>(Oct 12, at 00:00)</small>", a citation), `{{...}}`
/// templates, and every other tag.
fn clean_date_text(s: &str) -> String {
    let mut t = s.to_string();
    for tag in ["sup", "small", "ref"] {
        loop {
            let lower = t.to_ascii_lowercase();
            let Some(a) = lower.find(&format!("<{tag}")) else { break };
            let close = format!("</{tag}>");
            let b = match lower[a..].find(&close) {
                Some(n) => a + n + close.len(),
                None => match lower[a..].find("/>") {
                    Some(n) => a + n + 2,
                    None => t.len(),
                },
            };
            t.replace_range(a..b, " ");
        }
    }
    let mut out = String::with_capacity(t.len());
    let mut depth = 0i32;
    let mut chars = t.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '{' && chars.peek() == Some(&'{') {
            chars.next();
            depth += 1;
        } else if c == '}' && chars.peek() == Some(&'}') && depth > 0 {
            chars.next();
            depth -= 1;
        } else if depth == 0 {
            out.push(c);
        }
    }
    strip_tags(&out)
}

/// One date in free text: "2016-04-03", "October 3, 2020", "3 October 2020".
fn parse_date_text(s: &str) -> Option<i64> {
    let t = s.trim();
    // ISO anywhere in the text.
    for (i, _) in t.char_indices() {
        if let Some(d) = t.get(i..i + 10).and_then(crate::arc_align::parse_day) {
            return Some(d);
        }
    }
    let words: Vec<String> = t
        .split(|c: char| c.is_whitespace() || c == ',')
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect();
    let num = |w: &str| -> Option<i64> {
        let d: String = w.chars().take_while(|c| c.is_ascii_digit()).collect();
        if d.is_empty() || d.len() > 4 { None } else { d.parse().ok() }
    };
    for i in 0..words.len() {
        let Some(m) = month_number(&words[i]) else { continue };
        // Month D, YYYY
        if let (Some(d), Some(y)) = (words.get(i + 1).and_then(|w| num(w)), words.get(i + 2).and_then(|w| num(w))) {
            if (1..=31).contains(&d) && y > 1900 {
                return crate::arc_align::parse_day(&format!("{y:04}-{m:02}-{d:02}"));
            }
        }
        // D Month YYYY
        if i >= 1 {
            if let (Some(d), Some(y)) = (num(&words[i - 1]), words.get(i + 1).and_then(|w| num(w))) {
                if (1..=31).contains(&d) && y > 1900 {
                    return crate::arc_align::parse_day(&format!("{y:04}-{m:02}-{d:02}"));
                }
            }
        }
    }
    None
}

/// Every Japanese broadcast date in an air-date field. The field sometimes
/// lists other releases on further lines ("December 2, 2017 (Toonami)",
/// "(SimulDub)", "(Director's Cut)"); those lines are skipped, because a dub
/// date that lands on another episode's broadcast day would join the wrong
/// episode.
pub(crate) fn parse_air_dates(value: &str) -> Vec<i64> {
    let lowered = value.replace("<br />", "\n").replace("<br/>", "\n").replace("<br>", "\n");
    let mut days = Vec::new();
    for seg in lowered.split('\n') {
        let l = seg.to_ascii_lowercase();
        if ["dub", "toonami", "simul", "english", "(us", "us)", "netflix", "crunchyroll", "director", "re-air", "rerun", "remaster"]
            .iter()
            .any(|m| l.contains(m))
        {
            continue;
        }
        if let Some(d) = parse_date_text(&clean_date_text(seg)) {
            if !days.contains(&d) {
                days.push(d);
            }
        }
    }
    days
}

/// Reduce one episode page's lead section. `page_title` is the page it
/// landed on (Bleach redirects "Episode 20" to "Gin Ichimaru's Shadow").
pub(crate) fn parse_episode_page(page_title: &str, wikitext: &str, f: &EpisodeFields) -> WikiEpisode {
    let params = template_params(wikitext);
    let chapter_values: Vec<&str> = params
        .iter()
        .filter(|(k, _)| key_matches(k, f.chapters))
        .map(|(_, v)| v.as_str())
        .collect();
    let chapters = if chapter_values.is_empty() { None } else { parse_chapter_field(&chapter_values) };
    let air_key = f.airdate.to_ascii_lowercase();
    let days = params
        .iter()
        .find(|(k, _)| *k == air_key)
        .map(|(_, v)| parse_air_dates(v))
        .unwrap_or_default();
    let title = match f.title {
        Some(tf) => {
            let tk = tf.to_ascii_lowercase();
            params
                .iter()
                .find(|(k, _)| *k == tk)
                .map(|(_, v)| decode_entities(&clean_date_text(v)).trim().to_string())
                .unwrap_or_default()
        }
        None => episode_title_from_page(page_title),
    };
    WikiEpisode { days, title, chapters }
}

/// A page title as an episode title: "BLACK (episode)" -> "BLACK", "Episode 1
/// (2011)" -> "" (a number is no title, and useless as a tie-break).
fn episode_title_from_page(t: &str) -> String {
    let mut s = t.trim().to_string();
    if let Some(open) = s.rfind(" (") {
        if s.ends_with(')') {
            s.truncate(open);
        }
    }
    let lower = s.to_ascii_lowercase();
    if let Some(n) = lower.strip_prefix("episode ") {
        if n.split(['-', ' ']).next().is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())) {
            return String::new();
        }
    }
    s
}

/// An Aura episode, for the join.
#[derive(Clone, Debug)]
pub(crate) struct AuraEpisode {
    pub id: String,
    pub day: Option<i64>,
    pub title: String,
}

/// Join wiki episodes to Aura's by AIR DATE, never by number.
///
/// Pass 1 pairs on the same day, pass 2 lets the rest differ by one day (a
/// late-night JST broadcast is the previous day in UTC, which is how many
/// addons store it). Within a pass, episodes are grouped into connected
/// components of "could be the same broadcast"; a one-to-one component is a
/// match, and a larger one (two episodes on one day, a special on the same
/// day as a regular episode) is settled only by a clear, mutual title winner.
/// Everything else is dropped: a missing hint is better than a wrong one.
///
/// Returns `aura id -> index into wiki`.
pub(crate) fn join_by_air_date(aura: &[AuraEpisode], wiki: &[WikiEpisode]) -> HashMap<String, usize> {
    let mut matched: HashMap<String, usize> = HashMap::new();
    let mut wiki_used = vec![false; wiki.len()];
    for tolerance in [0i64, 1] {
        let aura_open: Vec<usize> = (0..aura.len())
            .filter(|&a| aura[a].day.is_some() && !matched.contains_key(&aura[a].id))
            .collect();
        let wiki_open: Vec<usize> = (0..wiki.len()).filter(|&w| !wiki_used[w] && !wiki[w].days.is_empty()).collect();
        // Index wiki episodes by day for the edge build.
        let mut by_day: HashMap<i64, Vec<usize>> = HashMap::new();
        for &w in &wiki_open {
            for d in &wiki[w].days {
                by_day.entry(*d).or_default().push(w);
            }
        }
        // Union-find over aura nodes [0, A) and wiki nodes [A, A + W).
        let a_n = aura.len();
        let mut parent: Vec<usize> = (0..a_n + wiki.len()).collect();
        fn find(p: &mut [usize], x: usize) -> usize {
            let mut r = x;
            while p[r] != r {
                r = p[r];
            }
            let mut c = x;
            while p[c] != r {
                let n = p[c];
                p[c] = r;
                c = n;
            }
            r
        }
        let mut edges: Vec<(usize, usize)> = Vec::new();
        for &a in &aura_open {
            let day = aura[a].day.unwrap_or_default();
            let mut ws: Vec<usize> = Vec::new();
            for d in (day - tolerance)..=(day + tolerance) {
                if let Some(list) = by_day.get(&d) {
                    ws.extend(list);
                }
            }
            ws.sort_unstable();
            ws.dedup();
            for w in ws {
                edges.push((a, w));
                let (ra, rw) = (find(&mut parent, a), find(&mut parent, a_n + w));
                if ra != rw {
                    parent[ra] = rw;
                }
            }
        }
        let mut comps: HashMap<usize, (Vec<usize>, Vec<usize>)> = HashMap::new();
        for &(a, w) in &edges {
            let r = find(&mut parent, a);
            let c = comps.entry(r).or_default();
            if !c.0.contains(&a) {
                c.0.push(a);
            }
            if !c.1.contains(&w) {
                c.1.push(w);
            }
        }
        for (_, (auras, wikis)) in comps {
            if auras.len() == 1 && wikis.len() == 1 {
                matched.insert(aura[auras[0]].id.clone(), wikis[0]);
                wiki_used[wikis[0]] = true;
                continue;
            }
            // Title tie-break, mutual and clear, restricted to this component's
            // own date edges.
            let score = |a: usize, w: usize| -> f64 {
                if !edges.contains(&(a, w)) {
                    return 0.0;
                }
                let (ta, tw) = (normalize_title(&aura[a].title), normalize_title(&wiki[w].title));
                if ta.is_empty() || tw.is_empty() { 0.0 } else { dice_bigram(&ta, &tw) }
            };
            let best_of = |scores: Vec<(usize, f64)>| -> Option<usize> {
                let mut s = scores;
                s.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
                let top = s.first()?;
                let second = s.get(1).map(|x| x.1).unwrap_or(0.0);
                (top.1 >= 0.5 && top.1 - second >= 0.2).then_some(top.0)
            };
            for &a in &auras {
                let Some(w) = best_of(wikis.iter().map(|&w| (w, score(a, w))).collect()) else { continue };
                let Some(back) = best_of(auras.iter().map(|&x| (x, score(x, w))).collect()) else { continue };
                if back == a && !wiki_used[w] {
                    matched.insert(aura[a].id.clone(), w);
                    wiki_used[w] = true;
                }
            }
        }
    }
    matched
}

#[derive(Deserialize)]
struct RevQueryResponse {
    #[serde(default)]
    query: Option<RevQuery>,
}

#[derive(Deserialize)]
struct RevQuery {
    #[serde(default)]
    normalized: Vec<FromTo>,
    #[serde(default)]
    redirects: Vec<FromTo>,
    #[serde(default)]
    pages: Vec<RevPage>,
}

#[derive(Deserialize)]
struct FromTo {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
}

#[derive(Deserialize)]
struct RevPage {
    #[serde(default)]
    title: String,
    #[serde(default)]
    missing: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    revisions: Vec<Revision>,
}

#[derive(Deserialize)]
struct Revision {
    #[serde(default)]
    slots: Option<Slots>,
}

#[derive(Deserialize)]
struct Slots {
    #[serde(default)]
    main: Option<SlotMain>,
}

#[derive(Deserialize)]
struct SlotMain {
    #[serde(default)]
    content: String,
}

/// Fetch "Episode {n}" pages for every `n` in `numbers`, 50 per request,
/// returning `n -> page` for the ones that exist. Only the lead section
/// (`rvsection=0`) is fetched: the infobox lives there, and the rest of a page
/// is a long plot summary.
async fn fetch_episode_pages(
    wiki: &Wiki,
    fields: &EpisodeFields,
    numbers: &[u32],
) -> Result<HashMap<u32, Option<WikiEpisode>>, String> {
    let mut out: HashMap<u32, Option<WikiEpisode>> = HashMap::new();
    for chunk in numbers.chunks(TITLES_PER_REQUEST) {
        let titles: Vec<String> = chunk.iter().map(|n| format!("Episode {n}")).collect();
        let url = format!(
            "https://{}/api.php?action=query&titles={}&prop=revisions&rvprop=content&rvslots=main&rvsection=0&redirects=1&format=json&formatversion=2",
            wiki.host,
            urlencode(&titles.join("|"))
        );
        let text = get_text(&url).await?;
        let resp: RevQueryResponse = serde_json::from_str(&text).map_err(|e| format!("episode pages parse: {e}"))?;
        let Some(q) = resp.query else { return Err("episode pages: no query".into()) };
        let normalized: HashMap<&str, &str> = q.normalized.iter().map(|m| (m.from.as_str(), m.to.as_str())).collect();
        let redirects: HashMap<&str, &str> = q.redirects.iter().map(|m| (m.from.as_str(), m.to.as_str())).collect();
        let pages: HashMap<&str, &RevPage> = q.pages.iter().map(|p| (p.title.as_str(), p)).collect();
        for (n, requested) in chunk.iter().zip(titles.iter()) {
            let mut t = requested.as_str();
            if let Some(to) = normalized.get(t) {
                t = to;
            }
            for _ in 0..4 {
                match redirects.get(t) {
                    Some(to) => t = to,
                    None => break,
                }
            }
            let ep = pages.get(t).filter(|p| p.missing.is_none()).and_then(|p| {
                let content = p.revisions.first()?.slots.as_ref()?.main.as_ref()?.content.as_str();
                Some(parse_episode_page(&p.title, content, fields))
            });
            out.insert(*n, ep);
        }
    }
    Ok(out)
}

async fn episodes<R: Runtime>(
    app: &AppHandle<R>,
    tmdb_id: Option<i64>,
    imdb_id: Option<&str>,
    videos: &[EpisodeRef],
) -> Result<(bool, HashMap<String, Vec<u32>>), String> {
    let Some(tv) = crate::arcs::resolve_tv_id(app, tmdb_id, imdb_id).await? else { return Ok((false, HashMap::new())) };
    let Some(wiki) = arc_art::wiki_for(tv) else { return Ok((false, HashMap::new())) };
    let Some(fields) = wiki.episodes else { return Ok((false, HashMap::new())) };
    let chapters = episode_chapters_for(wiki, &fields, videos).await?;
    Ok((true, chapters))
}

pub(crate) async fn episode_chapters_for(
    wiki: &Wiki,
    fields: &EpisodeFields,
    videos: &[EpisodeRef],
) -> Result<HashMap<String, Vec<u32>>, String> {
    let main_run = videos.iter().filter(|v| v.season.unwrap_or(1) >= 1).count() as u32;
    if main_run == 0 {
        return Ok(HashMap::new());
    }
    // The wiki may number a few more episodes than the addon lists (specials
    // promoted into the main run, an episode the addon has not caught up
    // with), so ask a little past the end. The tail misses cost one request a
    // day.
    let upto = (main_run + (main_run / 10).max(5)).min(MAX_EPISODE_PAGES);

    let mut pages: HashMap<u32, Option<WikiEpisode>> = HashMap::new();
    let mut need: Vec<u32> = Vec::new();
    for n in 1..=upto {
        match cache_get::<Option<WikiEpisode>>(&format!("ep:{}:{n}", wiki.host)) {
            Some(hit) => {
                pages.insert(n, hit);
            }
            None => need.push(n),
        }
    }
    if !need.is_empty() {
        let fetched = fetch_episode_pages(wiki, fields, &need).await?;
        let today = (now_secs() / 86_400) as i64;
        for (n, ep) in fetched {
            // A page for something that aired recently (or has no date yet)
            // may not have its chapters filled in: keep it only for a day.
            let settled = ep
                .as_ref()
                .and_then(|e| e.days.iter().max())
                .is_some_and(|d| today - d > FRESH_EPISODE_DAYS);
            cache_put(format!("ep:{}:{n}", wiki.host), &ep, if settled { WIKI_TTL } else { MISS_TTL });
            pages.insert(n, ep);
        }
    }

    let mut numbers: Vec<u32> = pages.iter().filter(|(_, e)| e.is_some()).map(|(n, _)| *n).collect();
    numbers.sort_unstable();
    let wiki_eps: Vec<WikiEpisode> = numbers.iter().filter_map(|n| pages.get(n).cloned().flatten()).collect();
    let aura: Vec<AuraEpisode> = videos
        .iter()
        .map(|v| AuraEpisode {
            id: v.id.clone(),
            day: v.released.as_deref().and_then(crate::arc_align::parse_day),
            title: v.title.clone().unwrap_or_default(),
        })
        .collect();
    let joined = join_by_air_date(&aura, &wiki_eps);
    let mut out: HashMap<String, Vec<u32>> = HashMap::new();
    for (id, w) in &joined {
        if let Some(ch) = wiki_eps[*w].chapters.clone() {
            out.insert(id.clone(), ch);
        }
    }
    crate::devlog!(
        info, "manga",
        "{}: {} episode pages, {} joined by air date to {} addon episodes, {} with chapter data",
        wiki.host, wiki_eps.len(), joined.len(), aura.len(), out.len()
    );
    Ok(out)
}

/// Percent-encode a MediaWiki query parameter (see `arc_art::urlencoding`).
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ------------------------------------------------------- MangaUpdates text

    #[test]
    fn mu_segments_parse_the_live_shapes() {
        // Recorded 2026-09-27 from api.mangaupdates.com.
        assert_eq!(
            parse_mu_segment("Vol 1, Chap 1 (Chap 1 adapted in EP 4)"),
            Some(MuSegment { lo: 1, hi: 1, partial: false })
        );
        assert_eq!(
            parse_mu_segment("Vol 113, Chap 1150 (As of EP 1180)"),
            Some(MuSegment { lo: 1150, hi: 1150, partial: false })
        );
        assert_eq!(
            parse_mu_segment("Vol 21, Chap 181 Page 14 (S3)"),
            Some(MuSegment { lo: 181, hi: 181, partial: true })
        );
        assert_eq!(parse_mu_segment("Chap 1150-1151"), Some(MuSegment { lo: 1150, hi: 1151, partial: false }));
        assert_eq!(parse_mu_segment("Chapter 12 - 14"), Some(MuSegment { lo: 12, hi: 14, partial: false }));
        assert_eq!(parse_mu_segment("Ch.40"), Some(MuSegment { lo: 40, hi: 40, partial: false }));
        // Refused rather than guessed.
        assert_eq!(parse_mu_segment("Vol 113"), None);
        assert_eq!(parse_mu_segment("Chap 1150.5"), None);
        assert_eq!(parse_mu_segment("Chap 10, Chap 12"), None);
        assert_eq!(parse_mu_segment("Chap 1150 (As of EP 1180"), None);
        assert_eq!(parse_mu_segment("the whole thing"), None);
    }

    #[test]
    fn mu_anime_one_piece_single_segment() {
        let a = parse_mu_anime("Vol 1, Chap 1 (Chap 1 adapted in EP 4)", "Vol 113, Chap 1150 (As of EP 1180)");
        assert_eq!(a, Some(Adaptation { adapts_from: Some(1), reach: Some(1150), reach_partial: false }));
    }

    #[test]
    fn mu_anime_multi_segment_partial_end() {
        // Jujutsu Kaisen: three seasons, the last ending partway into 181.
        let a = parse_mu_anime(
            "Vol 1, Chap 1 (S1) / Vol 8, Chap 64 (S2) / Vol 16, Chap 138 (S3)",
            "Vol 8, Chap 63 (S1) / Vol 16, Chap 137 (S2) / Vol 21, Chap 181 Page 14 (S3)",
        );
        assert_eq!(a, Some(Adaptation { adapts_from: Some(1), reach: Some(181), reach_partial: true }));
    }

    #[test]
    fn mu_anime_open_segment_withholds_the_reach() {
        // Bleach: TYBW part 4 has started (661) and has no end yet, so the
        // last recorded end (660) would understate the anime.
        let a = parse_mu_anime(
            "Vol 1, Chap 1 (Bleach) / Vol 55, Chap 480 (TYBW P1) / Vol 61, Chap 543 (TYBW P2) / Vol 67, Chap 610 (TYBW P3) / Vol 72, Chap 661 (TYBW P4)",
            "Vol 54, Chap 479 (Bleach) / Vol 61, Chap 542 (TYBW P1) / Vol 67, Chap 609 (TYBW P2) / Vol 72, Chap 660 (TYBW P3)",
        );
        assert_eq!(a, Some(Adaptation { adapts_from: Some(1), reach: None, reach_partial: false }));
    }

    #[test]
    fn mu_anime_refuses_any_unreadable_segment() {
        assert_eq!(parse_mu_anime("Vol 1, Chap 1 / Vol 3", "Vol 5, Chap 40"), None);
        assert_eq!(parse_mu_anime("", ""), None);
        // A start with no end at all: the anime has begun, reach unknown.
        assert_eq!(
            parse_mu_anime("Vol 1, Chap 1", ""),
            Some(Adaptation { adapts_from: Some(1), reach: None, reach_partial: false })
        );
    }

    #[test]
    fn build_series_drops_a_latest_below_the_reach() {
        let mu = MuSeries {
            series_id: 70994361491,
            title: "Bleach".into(),
            url: Some("https://www.mangaupdates.com/series/x/bleach".into()),
            anime: Some(MuAnime { start: Some("Vol 1, Chap 1".into()), end: Some("Vol 54, Chap 479".into()) }),
            latest_chapter: Some(250),
            completed: Some(true),
        };
        let s = build_series(&mu).expect("parses");
        assert_eq!(s.reach, Some(479));
        assert_eq!(s.latest, None, "250 is below the anime's reach, so it is not the manga's latest");
        let mu = MuSeries { latest_chapter: Some(1194), ..mu };
        assert_eq!(build_series(&mu).unwrap().latest, Some(1194));
    }

    fn hit(id: u64, title: &str, hit_title: Option<&str>, kind: &str, year: &str) -> MuHit {
        MuHit {
            record: MuRecord {
                series_id: id,
                title: title.into(),
                kind: Some(kind.into()),
                year: Some(year.into()),
            },
            hit_title: hit_title.map(str::to_string),
        }
    }

    #[test]
    fn pick_series_requires_an_exact_comic_title_and_prefers_the_earliest() {
        let hits = vec![
            hit(1, "One Piece dj - Short Piece", None, "Doujinshi", "2009"),
            hit(2, "Odekake One Piece", None, "Manga", "2015"),
            hit(3, "One Piece", Some("One Piece"), "Manga", "1997"),
            hit(4, "One Piece Color Walk", None, "Artbook", "2001"),
        ];
        assert_eq!(pick_series(&hits, &["One Piece".into()], Some(1999)), Some(3));
        // Matched through an alternate title.
        let hits = vec![hit(9, "Kimetsu no Yaiba", Some("Demon Slayer: Kimetsu no Yaiba"), "Manga", "2016")];
        assert_eq!(pick_series(&hits, &["Demon Slayer: Kimetsu no Yaiba".into()], Some(2019)), Some(9));
        // A manga dated after the anime is not its source.
        assert_eq!(pick_series(&hits, &["Kimetsu no Yaiba".into()], Some(2010)), None);
        // Two exact matches in the same year: ambiguous, so none.
        let hits = vec![hit(5, "Monster", None, "Manga", "1994"), hit(6, "Monster", None, "Manga", "1994")];
        assert_eq!(pick_series(&hits, &["Monster".into()], None), None);
        // Only a similar title: none.
        let hits = vec![hit(7, "Bleach Unmasked", None, "Manga", "2011")];
        assert_eq!(pick_series(&hits, &["Bleach".into()], None), None);
    }

    // ------------------------------------------------------- rendered infobox

    /// Trimmed from the live `action=parse&page=Egghead_Arc&section=0` HTML.
    const EGGHEAD_HTML: &str = r#"<section class="pi-item pi-group pi-border-color">
<h2 class="pi-item pi-header"> Arc Statistics</h2>
<div class="pi-item pi-data pi-item-spacing pi-border-color" data-source="vol">
	<h3 class="pi-data-label pi-secondary-font">Volumes</h3>
	<div class="pi-data-value pi-font">105-111, 7 volumes</div>
</div>
<div class="pi-item pi-data pi-item-spacing pi-border-color" data-source="chapter">
	<h3 class="pi-data-label pi-secondary-font">Manga Chapters:</h3>
	<div class="pi-data-value pi-font">1058-1125, 68 chapters</div>
</div>
<div class="pi-item pi-data pi-item-spacing pi-border-color" data-source="episode">
	<h3 class="pi-data-label pi-secondary-font">Anime Episodes:</h3>
	<div class="pi-data-value pi-font">1086-1155, 70 episodes</div>
</div>"#;

    #[test]
    fn infobox_one_piece_arc() {
        assert_eq!(parse_infobox_chapters(EGGHEAD_HTML), Some(ChapterRange { start: 1058, end: 1125 }));
    }

    #[test]
    fn infobox_label_variants_and_open_ranges() {
        // Jujutsu Kaisen and Demon Slayer label the item just "Manga".
        let jjk = r#"<div class="pi-item pi-data" data-source="kanji"><h3 class="pi-data-label">Kanji</h3><div class="pi-data-value pi-font">x</div></div>
<div class="pi-item pi-data" data-source="chapters"><h3 class="pi-data-label">Manga</h3><div class="pi-data-value pi-font"> Chapter 79 - 137</div></div>
<div class="pi-item pi-data" data-source="episodes"><h3 class="pi-data-label">Anime</h3><div class="pi-data-value pi-font"> Episode 30 - 47</div></div>"#;
        assert_eq!(parse_infobox_chapters(jjk), Some(ChapterRange { start: 79, end: 137 }));
        // Hunter x Hunter.
        let hxh = r#"<div class="pi-item pi-data" data-source="chapters"><h3 class="pi-data-label">Manga Chapters</h3><div class="pi-data-value pi-font">Chapters 186 &#8211; 318</div></div>"#;
        assert_eq!(parse_infobox_chapters(hxh), Some(ChapterRange { start: 186, end: 318 }));
        // An arc still running has no end: nothing, never "1126-1126".
        let open = r#"<div class="pi-item pi-data" data-source="chapter"><h3 class="pi-data-label">Manga Chapters:</h3><div class="pi-data-value pi-font">1126-present</div></div>"#;
        assert_eq!(parse_infobox_chapters(open), None);
        let tba = r#"<div class="pi-item pi-data" data-source="chapters"><h3 class="pi-data-label">Manga</h3><div class="pi-data-value pi-font">Chapter 138 - TBA</div></div>"#;
        assert_eq!(parse_infobox_chapters(tba), None);
        // Episodes alone are not chapters.
        let eps = r#"<div class="pi-item pi-data" data-source="episode"><h3 class="pi-data-label">Anime Episodes:</h3><div class="pi-data-value pi-font">1-61</div></div>"#;
        assert_eq!(parse_infobox_chapters(eps), None);
    }

    #[test]
    fn a_combined_or_partial_name_never_takes_one_arcs_range() {
        // Live matches from One Piece's groupings (2026-09-27).
        assert!(names_one_arc("Alabasta", "Arabasta Arc"));
        assert!(names_one_arc("Skypia Arc", "Skypiea Arc"));
        assert!(names_one_arc("Fishman Island", "Fish-Man Island Arc"));
        assert!(names_one_arc("Sky Island Saga", "Sky Island Saga"));
        assert!(!names_one_arc("Water 7 & Enies Lobby Arc", "Enies Lobby Arc"));
        assert!(!names_one_arc("Zou & Whole Cake Island Arc", "Whole Cake Island Arc"));
        assert!(!names_one_arc("Amazon Lily, Impel Down & Marine Ford Arc", "Impel Down Arc"));
        assert!(!names_one_arc("Hidden Inventory / Premature Death", "Hidden Inventory Arc"));
        assert!(!names_one_arc("Wano Kuni Arc (Onigashima)", "Wano Country Arc"));
    }

    // ------------------------------------------------------- episode pages

    const BLEACH_FIELDS: EpisodeFields = EpisodeFields { chapters: "chapters", airdate: "japair", title: None };
    const JJK_FIELDS: EpisodeFields = EpisodeFields { chapters: "adapted from", airdate: "jp air date", title: Some("ep title") };

    #[test]
    fn bleach_episode_page() {
        // Live "Episode 406" -> "MY LAST WORDS (episode)", lead section.
        let text = "{{Template:Bleach Wiki:Episode Template\n|title           = {{PAGENAME}}\n|episodenumber   = 406\n|chapters        = [[Chapter 635]] (pages 2-3),<br>[[Chapter 654]] (pages 6-14),<br>[[Chapter 659]] (pages 7-10),<br>[[Chapter 660]],<br>[[Chapter 661]] (pages 1-10),<br>[[Chapter 674]] (pages 16-17)\n|japair          = December 28, 2024\n|engair          = December 28, 2024\n}}";
        let ep = parse_episode_page("MY LAST WORDS (episode)", text, &BLEACH_FIELDS);
        assert_eq!(ep.chapters, Some(vec![635, 654, 659, 660, 661, 674]));
        assert_eq!(ep.days, vec![parse_date_text("2024-12-28").unwrap()]);
        assert_eq!(ep.title, "MY LAST WORDS");
        // Live "Episode 168": a filler, whose field literally says None.
        let text = "|episodenumber   = 168\n|chapters        =  None\n|japair          = April 23, 2008\n";
        let ep = parse_episode_page("The New Captain Appears!", text, &BLEACH_FIELDS);
        assert_eq!(ep.chapters, Some(vec![]));
    }

    #[test]
    fn jjk_episode_page() {
        // Live "Episode 1": two dates (early screening, then broadcast).
        let text = "{{Episode Infobox\n|season number = 1\n|ep number = 1\n|ep title = Ryomen Sukuna\n|jp air date = September 19, 2020 {{Sub|(Early Screening)}}<br>October 3, 2020\n|us air date = November 20, 2020\n|adapted from = [[Chapter 2]] (p. 2 - 3)<br>[[Chapter 1]]\n}}";
        let ep = parse_episode_page("Episode 1", text, &JJK_FIELDS);
        assert_eq!(ep.chapters, Some(vec![1, 2]));
        assert_eq!(ep.title, "Ryomen Sukuna");
        assert_eq!(
            ep.days,
            vec![parse_date_text("2020-09-19").unwrap(), parse_date_text("2020-10-03").unwrap()]
        );
        // Live "Episode 48": ISO date.
        let text = "|jp air date = 2026-01-09\n|adapted from = [[Chapter 138]] (pp. 1 - 12, 14 - 19)<br/>[[Chapter 139]]<br/>[[Chapter 140]]<br/>[[Chapter 141]] (p. 1 - 15)\n";
        let ep = parse_episode_page("Episode 48", text, &JJK_FIELDS);
        assert_eq!(ep.chapters, Some(vec![138, 139, 140, 141]));
        assert_eq!(ep.title, "");
    }

    #[test]
    fn other_wiki_field_shapes() {
        // Hunter x Hunter: numbered continuation fields, <sup> ordinals.
        let hxh = EpisodeFields { chapters: "Adapted", airdate: "Air Date", title: None };
        let text = "|Air Date = October 2<sup>nd</sup>, 2011\n|English Air Date = April 16<sup>th</sup>, 2016\n|Adapted = [[Chapter 1]] (pages 1-6,24-34)\n|Adapted 2 = [[Chapter 2]]\n";
        let ep = parse_episode_page("Episode 1 (2011)", text, &hxh);
        assert_eq!(ep.chapters, Some(vec![1, 2]));
        assert_eq!(ep.days, vec![parse_date_text("2011-10-02").unwrap()]);
        assert_eq!(ep.title, "");
        // Black Clover: dub dates on further lines are not broadcasts.
        let bc = EpisodeFields { chapters: "chapter", airdate: "airdate", title: None };
        let text = "|airdate= December 5, 2017<br />December 24, 2017 (Simuldub)<br />February 17, 2018 (Toonami)\n|chapter= [[Chapter 7]]<br />[[Chapter 8]]<br />[[Chapter 9]]\n";
        let ep = parse_episode_page("Episode 10", text, &bc);
        assert_eq!(ep.days, vec![parse_date_text("2017-12-05").unwrap()]);
        assert_eq!(ep.chapters, Some(vec![7, 8, 9]));
        // Chainsaw Man: the <small> note carries a second, yearless date.
        assert_eq!(
            parse_air_dates("October 11, 2022 <small>(Oct 12, at 00:00)</small>"),
            vec![parse_date_text("2022-10-11").unwrap()]
        );
        // Piped links and non-chapter links.
        assert_eq!(parse_chapter_field(&["[[Chapter 29]], [[Chapter 30|30]], [[Chapter 31|31]] (p.1-18)"]), Some(vec![29, 30, 31]));
        assert_eq!(parse_chapter_field(&["[[Short Mission 4]]<br>[[Chapter 15]]"]), Some(vec![15]));
        // Bare numbers and ranges (JoJo shape).
        assert_eq!(parse_chapter_field(&["1-5"]), Some(vec![1, 2, 3, 4, 5]));
        // Text that is not chapters is unknown, not "anime original".
        assert_eq!(parse_chapter_field(&["[[Response]]"]), None);
        assert_eq!(parse_chapter_field(&["N/A"]), Some(vec![]));
        // No field at all is unknown.
        let ep = parse_episode_page("X", "|japair = April 23, 2008\n", &BLEACH_FIELDS);
        assert_eq!(ep.chapters, None);
    }

    #[test]
    fn date_text_shapes() {
        let d = |s: &str| parse_date_text(s);
        assert_eq!(d("October 3, 2020"), d("2020-10-03"));
        assert_eq!(d("3 October 2020"), d("2020-10-03"));
        assert_eq!(d("Oct. 3, 2020"), d("2020-10-03"));
        assert_eq!(d("Sept 3, 2020"), d("2020-09-03"));
        assert!(d("2020-10-03").is_some());
        assert_eq!(d("TBA"), None);
        assert_eq!(d("Oct 12, at 00:00"), None);
        assert!(month_number("ma").is_none());
    }

    // ------------------------------------------------------- the join

    fn day(s: &str) -> i64 {
        crate::arc_align::parse_day(s).unwrap()
    }

    fn aura(id: &str, date: &str, title: &str) -> AuraEpisode {
        AuraEpisode { id: id.into(), day: Some(day(date)), title: title.into() }
    }

    fn wiki(date: &str, title: &str, chapters: &[u32]) -> WikiEpisode {
        WikiEpisode { days: vec![day(date)], title: title.into(), chapters: Some(chapters.to_vec()) }
    }

    #[test]
    fn join_is_by_date_not_number_across_a_promoted_special() {
        // The One Piece shape: the wiki numbers the crossover special INTO the
        // main run (its 590), the addon files it as a special (S0E39), so from
        // there on the addon's N is the wiki's N+1. A number join would be off
        // by one for every later episode; the date join is not.
        let wiki_eps = vec![
            wiki("2013-03-24", "Luffy vs Caesar", &[680]),         // wiki 589
            wiki("2013-04-07", "Toriko Crossover", &[]),           // wiki 590 (special)
            wiki("2013-04-14", "The Return to Punk Hazard", &[681]), // wiki 591
            wiki("2013-04-21", "Caesar's Trap", &[682]),           // wiki 592
        ];
        let aura_eps = vec![
            aura("op:1:589", "2013-03-24", "Luffy vs Caesar"),
            aura("op:1:590", "2013-04-14", "The Return to Punk Hazard"),
            aura("op:1:591", "2013-04-21", "Caesar's Trap"),
            aura("op:0:39", "2013-04-07", "Dream Crossover"),
        ];
        let m = join_by_air_date(&aura_eps, &wiki_eps);
        assert_eq!(m.get("op:1:589"), Some(&0));
        assert_eq!(m.get("op:1:590"), Some(&2), "addon 590 is wiki 591");
        assert_eq!(m.get("op:1:591"), Some(&3));
        assert_eq!(m.get("op:0:39"), Some(&1), "the special joins its own page by date");
    }

    #[test]
    fn join_settles_a_shared_air_date_by_title_or_drops_it() {
        // Two episodes on one day (Jujutsu Kaisen's season 3 premiere shape).
        let wiki_eps = vec![
            wiki("2026-01-09", "Execution", &[138, 139]),
            wiki("2026-01-09", "Perfect Preparation", &[140, 141]),
            wiki("2026-01-16", "Culling Game", &[144]),
        ];
        let aura_eps = vec![
            aura("jjk:3:1", "2026-01-09", "Execution"),
            aura("jjk:3:2", "2026-01-09", "Perfect Preparation"),
            aura("jjk:3:3", "2026-01-16", "The Culling Game"),
        ];
        let m = join_by_air_date(&aura_eps, &wiki_eps);
        assert_eq!(m.get("jjk:3:1"), Some(&0));
        assert_eq!(m.get("jjk:3:2"), Some(&1));
        assert_eq!(m.get("jjk:3:3"), Some(&2));

        // Same day, titles that do not tell them apart: both dropped, and the
        // unambiguous neighbour still joins.
        let aura_eps = vec![
            aura("x:1", "2026-01-09", "Part One"),
            aura("x:2", "2026-01-09", "Part Two"),
            aura("x:3", "2026-01-16", "Something"),
        ];
        let m = join_by_air_date(&aura_eps, &wiki_eps);
        assert!(!m.contains_key("x:1") && !m.contains_key("x:2"), "got {m:?}");
        assert_eq!(m.get("x:3"), Some(&2));
    }

    #[test]
    fn join_tolerates_a_one_day_timezone_shift_but_prefers_the_exact_day() {
        // The addon stores a late-night JST broadcast as the previous UTC day.
        let wiki_eps = vec![wiki("2020-10-03", "Ryomen Sukuna", &[1, 2]), wiki("2020-10-10", "For Myself", &[3])];
        let aura_eps = vec![aura("a:1", "2020-10-02", "Ryomen Sukuna"), aura("a:2", "2020-10-10", "For Myself")];
        let m = join_by_air_date(&aura_eps, &wiki_eps);
        assert_eq!(m.get("a:1"), Some(&0));
        assert_eq!(m.get("a:2"), Some(&1));
        // Undated episodes never join.
        let undated = vec![AuraEpisode { id: "u".into(), day: None, title: "Ryomen Sukuna".into() }];
        assert!(join_by_air_date(&undated, &wiki_eps).is_empty());
    }

    // ------------------------------------------------------- live (ignored)

    /// `cargo test --lib manga_chapters::tests::live -- --ignored --nocapture`
    /// Hits MangaUpdates, Fandom, Cinemeta and TMDB. Prints what the three
    /// verification shows actually produce.
    #[tokio::test]
    #[ignore]
    async fn live_end_to_end() {
        for (name, year, mal) in [("One Piece", 1999, 21), ("Bleach", 2004, 269), ("Jujutsu Kaisen", 2020, 40748)] {
            let s = series(&[name.to_string()], Some(year), Some(mal)).await;
            println!("SERIES {name}: {s:?}");
            if let Ok(s) = s {
                println!("   (the detail line would read from reach {:?}, latest {:?})", s.as_ref().and_then(|s| s.reach), s.as_ref().and_then(|s| s.latest));
            }
        }
        let tmdb_key = env!("AURA_TMDB_KEY");
        for (tv, imdb) in [(37854i64, "tt0388629"), (30984, "tt0434665"), (95479, "tt12343534")] {
            let wiki = arc_art::wiki_for(tv).unwrap();
            // Every story-arc grouping's arc names, straight from TMDB.
            let groups: serde_json::Value = client()
                .get(format!("https://api.themoviedb.org/3/tv/{tv}/episode_groups?api_key={tmdb_key}"))
                .send().await.unwrap().json().await.unwrap();
            for g in groups["results"].as_array().cloned().unwrap_or_default() {
                if g["type"].as_i64() != Some(5) {
                    continue;
                }
                let gid = g["id"].as_str().unwrap();
                let detail: serde_json::Value = client()
                    .get(format!("https://api.themoviedb.org/3/tv/episode_group/{gid}?api_key={tmdb_key}"))
                    .send().await.unwrap().json().await.unwrap();
                let names: Vec<String> = detail["groups"].as_array().cloned().unwrap_or_default()
                    .iter().filter_map(|b| b["name"].as_str().map(str::to_string)).collect();
                let pages = arc_art::compute_pages(wiki, &names).await;
                let ranges = arc_ranges_for(wiki, &names, &pages).await.unwrap();
                println!("ARCS {} / '{}' ({} arcs): {} pages, {} ranges", wiki.host, g["name"], names.len(), pages.len(), ranges.len());
                for n in &names {
                    println!("   {n:45} page={:?} range={:?}", pages.get(&arc_art::normalize_arc_name(n)), ranges.get(n));
                }
            }
            if let Some(fields) = wiki.episodes {
                let meta: serde_json::Value = client()
                    .get(format!("https://v3-cinemeta.strem.io/meta/series/{imdb}.json"))
                    .send().await.unwrap().json().await.unwrap();
                let videos: Vec<EpisodeRef> = meta["meta"]["videos"].as_array().cloned().unwrap_or_default()
                    .iter().map(|v| EpisodeRef {
                        id: v["id"].as_str().unwrap_or_default().to_string(),
                        released: v["released"].as_str().map(str::to_string),
                        title: v["name"].as_str().or(v["title"].as_str()).map(str::to_string),
                        season: v["season"].as_i64(),
                    }).collect();
                let ch = episode_chapters_for(wiki, &fields, &videos).await.unwrap();
                let mut ids: Vec<&String> = ch.keys().collect();
                ids.sort_by_key(|id| {
                    let p: Vec<i64> = id.split(':').skip(1).filter_map(|x| x.parse().ok()).collect();
                    (p.first().copied().unwrap_or(0), p.get(1).copied().unwrap_or(0))
                });
                println!("EPISODES {}: {} of {} addon episodes have chapters", wiki.host, ch.len(), videos.len());
                for id in ids.iter().take(6).chain(ids.iter().rev().take(6)) {
                    println!("   {id}: {:?}", ch[*id]);
                }
            }
        }
    }
}
