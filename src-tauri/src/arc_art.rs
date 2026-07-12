// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Arc key art, from Fandom.
//!
//! TMDB's episode groups carry no arc image (Harbor, which uses the same
//! source, renders arcs as text rows for exactly this reason). Fandom is the
//! only place real arc key art exists: each arc has a page in a
//! `Category:Story Arcs`-style category with a 1920x1080 lead image.
//!
//! Two things make this a lookup rather than a scrape:
//!
//! 1. There is no reliable id -> wiki mapping anywhere, so we ship a curated
//!    TMDB-id -> wiki-host table. That is not the limitation it sounds like:
//!    ~30 shows is approximately the entire universe of anime that HAS arcs
//!    (arcs are a property of long-running manga, not of anime), and the same
//!    ~30 shows are the ones TMDB has story-arc groups for.
//! 2. Wikis do not agree on the category name, so we probe a small candidate
//!    list and keep the first that yields members. Cached for 30 days, since
//!    an arc's key art does not change.
//!
//! Everything here is best-effort. A dead host, a renamed category, or an arc
//! name that does not fuzzy-match simply yields no art, and `arcs.rs` falls
//! back to an episode still. This module must never fail a caller.
//!
//! Licensing: Fandom images are CC-BY-SA. The arcs view carries the credit
//! line; `image_source: "fandom"` on each arc is what tells it to.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

use crate::arc_align::dice_bigram;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Arc key art is static. A month is conservative.
const TTL: Duration = Duration::from_secs(30 * 24 * 3600);
/// A MISS (empty art map) gets a much shorter TTL than a hit. An empty map is
/// ambiguous: it means "this wiki has no arc category and no name matched" but
/// it ALSO means "Fandom was down / the network was out when we asked". Honouring
/// a network blip for 30 days would permanently strip a show of its arc art. One
/// day is long enough to stop re-probing on every detail open, short enough to
/// self-heal.
const NEGATIVE_TTL: Duration = Duration::from_secs(24 * 3600);
const CACHE_CAP: usize = 60;
/// Below this the names are not the same arc. "Alabasta" vs "Arabasta Arc"
/// scores well above it; "Alabasta" vs "Skypiea" does not.
const MIN_NAME_SIMILARITY: f64 = 0.6;
/// A show with more arcs than this is not something we are going to art up.
const MAX_ARCS: usize = 120;

/// Curated TMDB tv id -> Fandom wiki host. Keyed by TMDB id (not IMDb) because
/// `arcs.rs` has already resolved one by the time it calls here, and because
/// these ids were verified directly against TMDB during the coverage census.
///
/// A host that does not exist, or a wiki with no arc category, costs one failed
/// request and then caches the miss. Adding a show is a one-line change.
const WIKI_BY_TMDB: &[(i64, &str)] = &[
    (37854,  "onepiece.fandom.com"),
    (46260,  "naruto.fandom.com"),          // Naruto
    (31910,  "naruto.fandom.com"),          // Naruto Shippuden
    (70881,  "naruto.fandom.com"),          // Boruto
    (30984,  "bleach.fandom.com"),
    (12609,  "dragonball.fandom.com"),      // Dragon Ball
    (12971,  "dragonball.fandom.com"),      // Dragon Ball Z
    (62715,  "dragonball.fandom.com"),      // Dragon Ball Super
    (46298,  "hunterxhunter.fandom.com"),
    (1429,   "attackontitan.fandom.com"),
    (85937,  "kimetsu-no-yaiba.fandom.com"),
    (95479,  "jujutsu-kaisen.fandom.com"),
    (65930,  "myheroacademia.fandom.com"),
    (46261,  "fairytail.fandom.com"),
    (73223,  "blackclover.fandom.com"),
    (31911,  "fma.fandom.com"),
    (13916,  "deathnote.fandom.com"),
    (57041,  "gintama.fandom.com"),
    (45790,  "jojo.fandom.com"),
    (30983,  "detectiveconan.fandom.com"),
    (45782,  "swordartonline.fandom.com"),
    (65942,  "rezero.fandom.com"),
    (67075,  "mob-psycho-100.fandom.com"),
    (114410, "chainsaw-man.fandom.com"),
    (120089, "spy-x-family.fandom.com"),
    (209867, "frieren.fandom.com"),
    (60863,  "haikyuu.fandom.com"),
    (131041, "blue-lock.fandom.com"),
    (86031,  "dr-stone.fandom.com"),
    (63926,  "onepunchman.fandom.com"),
    (31724,  "codegeass.fandom.com"),
];

/// Wikis do not agree on what the arc category is called. Probed in order.
const CATEGORY_CANDIDATES: &[&str] = &[
    "Category:Story Arcs",
    "Category:Arcs",
    "Category:Story arcs",
    "Category:Sagas",
    "Category:Manga Arcs",
    "Category:Anime Arcs",
];

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .pool_max_idle_per_host(1)
            .user_agent("Aura/1.4 (+https://github.com/rm-sage/Aura) arc-art")
            .build()
            .expect("arc_art HTTP client init failed")
    })
}

/// Normalise an arc name for cross-source matching. Fandom says
/// "Arabasta Arc"; TMDB says "Alabasta". Lowercase, drop punctuation, and
/// strip the trailing "arc" / "saga" noise word so it cannot dominate the
/// bigram score (every candidate has it, so it is pure signal loss).
pub fn normalize_arc_name(s: &str) -> String {
    let lowered: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { ' ' })
        .collect();
    let words: Vec<&str> = lowered
        .split_whitespace()
        .filter(|w| !matches!(*w, "arc" | "arcs" | "saga" | "sagas"))
        .collect();
    words.join(" ")
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// normalized arc name -> image URL, per show. An empty map is a cached MISS
/// (no wiki, no category, no matches) and is honoured for the full TTL so a
/// show without art does not re-probe every time you open its detail page.
#[derive(Clone, Serialize, Deserialize)]
struct ArtEntry {
    fetched_at: u64,
    art: HashMap<String, String>,
}

type ArtCache = HashMap<String, ArtEntry>;

static CACHE: OnceLock<Mutex<ArtCache>> = OnceLock::new();

fn cache() -> &'static Mutex<ArtCache> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("arc-art-v1.json"))
}

/// Hydrated once per process; see arcs.rs for the same reasoning (blocking
/// full-file read + parse off the runtime, and not on every call).
static CACHE_LOADED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

async fn ensure_cache_loaded<R: Runtime>(app: &AppHandle<R>) {
    use std::sync::atomic::Ordering;
    if CACHE_LOADED.swap(true, Ordering::AcqRel) {
        return;
    }
    let Some(path) = cache_path(app) else { return };
    let loaded = tokio::task::spawn_blocking(move || {
        let text = std::fs::read_to_string(&path).ok()?;
        serde_json::from_str::<ArtCache>(&text).ok()
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

async fn persist_cache<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = cache_path(app) else { return };
    let snapshot = {
        let Ok(mut lock) = cache().lock() else { return };
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

// ---------------------------------------------------------------------------
// MediaWiki wire shapes
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct CategoryResponse {
    #[serde(default)]
    query: Option<CategoryQuery>,
}

#[derive(Deserialize)]
struct CategoryQuery {
    #[serde(default)]
    categorymembers: Vec<CategoryMember>,
}

#[derive(Deserialize)]
struct CategoryMember {
    #[serde(default)]
    title: String,
}

#[derive(Deserialize)]
struct PagesResponse {
    #[serde(default)]
    query: Option<PagesQuery>,
}

#[derive(Deserialize)]
struct PagesQuery {
    #[serde(default)]
    pages: HashMap<String, PageEntry>,
}

#[derive(Deserialize)]
struct PageEntry {
    #[serde(default)]
    title: String,
    #[serde(default)]
    original: Option<PageImage>,
}

#[derive(Deserialize)]
struct PageImage {
    #[serde(default)]
    source: String,
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

async fn get_json<T: serde::de::DeserializeOwned>(url: &str) -> Option<T> {
    let resp = client().get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let text = resp.text().await.ok()?;
    serde_json::from_str::<T>(&text).ok()
}

/// List the arc pages in a wiki. Probes the candidate categories in order and
/// keeps the first that yields a plausible number of members.
async fn list_arc_pages(host: &str) -> Vec<String> {
    for cat in CATEGORY_CANDIDATES {
        let url = format!(
            "https://{host}/api.php?action=query&list=categorymembers&cmtitle={}&cmlimit=500&cmnamespace=0&format=json",
            urlencoding(cat)
        );
        let Some(resp) = get_json::<CategoryResponse>(&url).await else { continue };
        let members: Vec<String> = resp
            .query
            .map(|q| q.categorymembers.into_iter().map(|m| m.title).collect())
            .unwrap_or_default();
        if members.len() >= 3 {
            crate::devlog!(info, "arcs", "{host}: {} arc pages under {cat}", members.len());
            return members;
        }
    }
    Vec::new()
}

/// Batch-fetch lead images for a set of page titles. MediaWiki accepts up to
/// 50 titles per request, so a 55-arc show costs two requests, not 55.
async fn fetch_page_images(host: &str, titles: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for chunk in titles.chunks(40) {
        let joined = chunk.join("|");
        let url = format!(
            "https://{host}/api.php?action=query&titles={}&prop=pageimages&piprop=original&redirects=1&format=json",
            urlencoding(&joined)
        );
        let Some(resp) = get_json::<PagesResponse>(&url).await else { continue };
        let Some(q) = resp.query else { continue };
        for (_, page) in q.pages {
            if let Some(img) = page.original {
                if !img.source.is_empty() {
                    out.insert(page.title, img.source);
                }
            }
        }
    }
    out
}

/// Percent-encode a MediaWiki query parameter. Kept local and minimal rather
/// than pulling a crate in for two call sites: MediaWiki titles only need
/// spaces, pipes, and the usual reserved punctuation escaped.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Resolve arc art for a show. Returns `normalized arc name -> image URL`.
/// Never errors: a miss is an empty map, which makes the caller fall back to
/// episode stills.
pub async fn resolve_arc_art<R: Runtime>(
    app: &AppHandle<R>,
    tmdb_id: i64,
    arc_names: &[String],
) -> HashMap<String, String> {
    let Some((_, host)) = WIKI_BY_TMDB.iter().find(|(id, _)| *id == tmdb_id) else {
        return HashMap::new();
    };
    if arc_names.is_empty() || arc_names.len() > MAX_ARCS {
        return HashMap::new();
    }

    let key = format!("art:{tmdb_id}");
    ensure_cache_loaded(app).await;
    if let Ok(lock) = cache().lock() {
        if let Some(entry) = lock.get(&key) {
            let ttl = if entry.art.is_empty() { NEGATIVE_TTL } else { TTL };
            if now_secs().saturating_sub(entry.fetched_at) < ttl.as_secs() {
                return entry.art.clone();
            }
        }
    }

    let pages = list_arc_pages(host).await;
    let mut art: HashMap<String, String> = HashMap::new();

    if !pages.is_empty() {
        // Match each TMDB arc name to its best Fandom page.
        let normalized_pages: Vec<(String, &String)> =
            pages.iter().map(|p| (normalize_arc_name(p), p)).collect();

        let mut wanted: Vec<String> = Vec::new();
        let mut arc_to_page: HashMap<String, String> = HashMap::new();

        for name in arc_names {
            let want = normalize_arc_name(name);
            if want.is_empty() {
                continue;
            }
            let best = normalized_pages
                .iter()
                .map(|(np, orig)| (dice_bigram(&want, np), *orig))
                .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            if let Some((score, page)) = best {
                if score >= MIN_NAME_SIMILARITY {
                    arc_to_page.insert(want, page.clone());
                    wanted.push(page.clone());
                }
            }
        }

        wanted.sort();
        wanted.dedup();
        let images = fetch_page_images(host, &wanted).await;

        // MediaWiki normalises and follows redirects, so the title it returns
        // may not be byte-identical to the one we asked for. Match back through
        // the same normalisation rather than assuming equality.
        let images_norm: HashMap<String, String> = images
            .into_iter()
            .map(|(title, url)| (normalize_arc_name(&title), url))
            .collect();

        for (arc_norm, page) in arc_to_page {
            let page_norm = normalize_arc_name(&page);
            if let Some(url) = images_norm.get(&page_norm) {
                art.insert(arc_norm, url.clone());
            }
        }
        crate::devlog!(
            info, "arcs",
            "{host}: matched art for {}/{} arcs", art.len(), arc_names.len()
        );
    }

    if let Ok(mut lock) = cache().lock() {
        lock.insert(key, ArtEntry { fetched_at: now_secs(), art: art.clone() });
    }
    // We only reach here on a cache MISS (a hit returned above), so a write is
    // always warranted; persist once, off the runtime.
    persist_cache(app).await;
    art
}
