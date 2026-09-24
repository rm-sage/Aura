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
/// MediaWiki reports a chained normalization (NFC repair, then the first
/// letter) and a double redirect one hop per entry, so the walks in
/// `key_images_to_requested` loop. Bounded so a malformed answer cannot spin.
const MAX_TITLE_HOPS: usize = 8;

/// Curated TMDB tv id -> Fandom wiki host. Keyed by TMDB id (not IMDb) because
/// `arcs.rs` has already resolved one by the time it calls here, and because
/// these ids were verified directly against TMDB during the coverage census.
///
/// A host that does not exist, or a wiki with no arc category, costs one failed
/// request and then caches the miss. Adding a show is a one-line change.
///
/// AUDITED 2026-08-09, 38 further candidates, NET ZERO added. The bottleneck is
/// not this table, it is TMDB: 36 of the 38 have no type-5 episode group at all,
/// so they render no arcs and the art would have nothing to attach to. Checked
/// and rejected, so nobody has to check them twice: Vinland Saga, Tokyo Ghoul,
/// Seven Deadly Sins, Fire Force, Promised Neverland, Made in Abyss, Yu Yu
/// Hakusho, InuYasha, Rurouni Kenshin, Soul Eater, Magi, Shaman King, Food Wars,
/// Assassination Classroom, Kingdom, Golden Kamuy, Mushoku Tensei, Solo
/// Leveling, Oshi no Ko, Overlord, D.Gray-man, Claymore, Monster, Berserk,
/// Beastars, Parasyte, Toriko, Ranking of Kings, Sakamoto Days, Wind Breaker,
/// Dandadan, Black Butler, Fate/Zero, Shield Hero, and Fullmetal Alchemist
/// (2003) - the last of which is why only Brotherhood is listed below.
///
/// Two were near misses on `score_grouping`'s 0.85 coverage bar rather than on
/// the group's existence: Tokyo Revengers (4 arcs, 37/50 episodes = 74%) and
/// Hell's Paradise (3 arcs, 21/25 = 84%). Both are correctly rejected today;
/// revisit only if TMDB's groups grow to cover their full runs.
///
/// Katekyo Hitman Reborn! (45857) DOES clear every mechanical gate and is still
/// deliberately absent. Its only type-5 grouping is "Saga Española", whose arc
/// names are Spanish ("Bala", "Batalla", "Especiales"), which would render
/// Spanish arc titles in an English UI and would score ~0 against the English
/// Fandom page names this module fuzzy-matches on, so it would yield no art
/// either way. Passing a gate is not the same as being right.
///
/// Bleach (30984) was listed and is deliberately REMOVED. Its wiki has no arc
/// category, and its arc names land on the wrong kind of page: 9 of the 21 in
/// TMDB's "Arcs" grouping redirect into sections of one generic "Episodes"
/// page (episode 1's title card), and the names that reach a real page land
/// on event pages ("Gotei 13 Invading Army" -> "Reigai Uprising") whose lead
/// images are episode screenshots, some of them final-arc spoilers. None of
/// that is key art, so the show stays on episode stills.
const WIKI_BY_TMDB: &[(i64, &str)] = &[
    (37854,  "onepiece.fandom.com"),
    (46260,  "naruto.fandom.com"),          // Naruto
    (31910,  "naruto.fandom.com"),          // Naruto Shippuden
    (70881,  "naruto.fandom.com"),          // Boruto
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

/// normalized arc name -> image URL, per show and arc-name set (see
/// `cache_key`). An empty map is a cached MISS (no wiki, no category, no
/// matches) and is honoured for NEGATIVE_TTL so a show without art does not
/// re-probe every time you open its detail page.
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

/// The pre-v2 file, removed once per process by `ensure_cache_loaded`.
const LEGACY_CACHE_FILE: &str = "arc-art-v1.json";

fn cache_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    // -v2: bumped with the redirect-aware matcher. A v1 hit was computed by a
    // matcher that could not key a renamed redirect back to its arc and had no
    // shared-image guard on either path, and a hit lives 30 days, so without
    // the bump an already-cached show would keep that answer for up to a
    // month. It only re-runs the match: a category-path fuzzy match this
    // change did not touch comes out the same (see the known false positive
    // in `resolve_arc_art`). The key format changed too (`cache_key` now
    // covers the arc names), so no v1 entry could ever be hit again; they
    // would only sit in CACHE_CAP slots. Costs each show one re-probe.
    Some(dir.join("arc-art-v2.json"))
}

/// The cache key covers the arc NAMES, not just the show. A show can offer
/// several arc groupings (One Piece has four: 55 arcs, 12 sagas, ...) and each
/// resolves to a different map. Keyed by show alone, whichever grouping was
/// resolved first was served to every other one for the next 30 days, which
/// looked up its own names in it and found only the few the two happened to
/// share. Order-insensitive, and hashed so a 55-arc show does not write a
/// kilobyte key.
fn cache_key(tmdb_id: i64, arc_names: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut names: Vec<&str> = arc_names.iter().map(String::as_str).collect();
    names.sort_unstable();
    names.dedup();
    let mut h = Sha256::new();
    for n in names {
        h.update(n.as_bytes());
        h.update([0u8]);
    }
    format!("art:{tmdb_id}:{}", hex::encode(&h.finalize()[..6]))
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
        // One-time cleanup of the pre-v2 file (see cache_path), which would
        // otherwise linger in app_data forever. Best-effort.
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_file(dir.join(LEGACY_CACHE_FILE));
        }
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

/// Without `formatversion=2`, `pages` is an object keyed by page id (negative
/// for a missing page), while `normalized` and `redirects` are arrays of
/// `{from, to}`. Captured live from bleach.fandom.com:
///
/// ```text
/// "normalized": [{"from": "soul_Society arc", "to": "Soul Society arc"}],
/// "redirects":  [{"from": "Soul Society arc", "to": "Ryoka Invasion"},
///                {"from": "Agent of the Shinigami", "to": "Episodes",
///                 "tofragment": "Agent of the Shinigami arc .28Episodes 1-20.29"}],
/// "pages": {"17143": {"title": "Ryoka Invasion", "original": {"source": "..."}},
///           "-1": {"title": "No Such Page Xyz", "missing": ""}}
/// ```
///
/// A title the server had to repair on input (non-NFC, or a control
/// character) is reported with `"fromencoded": ""` and its `from`
/// percent-encoded, then normalized further in a second entry:
/// `{"fromencoded": "", "from": "cafe%CC%81%20Test", "to": "café Test"}`,
/// `{"from": "café Test", "to": "Café Test"}` (onepiece.fandom.com).
#[derive(Deserialize)]
struct PagesQuery {
    #[serde(default)]
    normalized: Vec<TitleMap>,
    #[serde(default)]
    redirects: Vec<TitleMap>,
    #[serde(default)]
    pages: HashMap<String, PageEntry>,
}

/// One `{from, to}` hop from `query.normalized` or `query.redirects`.
#[derive(Deserialize)]
struct TitleMap {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
    /// Present (as `""`) when `from` is percent-encoded. Only its presence
    /// matters, so it is not parsed.
    #[serde(default)]
    fromencoded: Option<serde::de::IgnoredAny>,
    /// Only on a redirect, and only when it points at a SECTION of `to`.
    #[serde(default)]
    tofragment: Option<String>,
}

impl TitleMap {
    /// `from` as the title we sent, undoing `fromencoded`.
    fn requested_form(&self) -> String {
        if self.fromencoded.is_some() {
            if let Some(decoded) = percent_decode(&self.from) {
                return decoded;
            }
        }
        self.from.clone()
    }
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

/// Batch-fetch lead images for a set of page titles, keyed by the title as
/// REQUESTED (see `key_images_to_requested`). MediaWiki accepts up to 50
/// titles per request, so a 55-arc show costs two requests, not 55.
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
        // Per chunk: each response's `normalized` / `redirects` describe only
        // the titles that request carried.
        out.extend(key_images_to_requested(chunk, &q));
    }
    out
}

/// Key a batch's lead images back to the titles that were REQUESTED.
///
/// MediaWiki answers with the page it ended up on, not the title it was
/// given. It first normalizes each title (`soul_Society arc` -> `Soul Society
/// arc`, reported in `normalized`), then follows redirects from the
/// normalized form (`Soul Society arc` -> `Ryoka Invasion`, one hop per entry
/// in `redirects`). Walking requested -> normalized -> redirected therefore
/// lands on the returned page exactly, however little its title resembles the
/// request, which a similarity match against the TARGET title never could.
///
/// A redirect into a SECTION (`tofragment`) resolves to no art: the lead image
/// belongs to the whole page, not the section, and those pages are overviews
/// ("Episodes", "Timeline of Events") whose images are episode stills or
/// spoilers. So does landing on a single chapter or episode page (see
/// `is_unit_page`). A title the maps cannot trace to a returned page (a name
/// containing `|`, which MediaWiki receives as two titles, say) falls back to
/// the most similar image-bearing page that no traced title claimed, subject
/// to MIN_NAME_SIMILARITY.
fn key_images_to_requested(requested: &[String], q: &PagesQuery) -> HashMap<String, String> {
    let normalized: HashMap<String, &str> =
        q.normalized.iter().map(|m| (m.requested_form(), m.to.as_str())).collect();
    let redirects: HashMap<&str, &TitleMap> =
        q.redirects.iter().map(|m| (m.from.as_str(), m)).collect();
    // Returned page title -> its lead image, if it has one. Missing pages stay
    // in: a requested title that resolves to one is answered (no art), not lost.
    let pages: HashMap<&str, Option<&str>> = q
        .pages
        .values()
        .map(|p| {
            let img = p.original.as_ref().map(|i| i.source.as_str()).filter(|s| !s.is_empty());
            (p.title.as_str(), img)
        })
        .collect();

    let mut out: HashMap<String, String> = HashMap::new();
    let mut claimed: Vec<&str> = Vec::new();
    let mut untraced: Vec<&String> = Vec::new();

    for req in requested {
        let mut title = req.as_str();
        for _ in 0..MAX_TITLE_HOPS {
            let Some(to) = normalized.get(title) else { break };
            title = to;
        }
        let mut into_section = false;
        for _ in 0..MAX_TITLE_HOPS {
            let Some(hop) = redirects.get(title) else { break };
            into_section |= hop.tofragment.as_deref().is_some_and(|f| !f.is_empty());
            title = hop.to.as_str();
        }
        // Answered with no art, but still claimed, so the dice fallback below
        // cannot hand the page out either.
        let no_art = into_section || is_unit_page(title);
        match pages.get(title) {
            Some(img) => {
                claimed.push(title);
                if let (false, Some(url)) = (no_art, img) {
                    out.insert(req.clone(), (*url).to_string());
                }
            }
            None => untraced.push(req),
        }
    }

    if !untraced.is_empty() {
        let mut pool: Vec<(String, &str)> = pages
            .iter()
            .filter(|(title, _)| !claimed.contains(title))
            .filter_map(|(title, img)| img.map(|url| (normalize_arc_name(title), url)))
            .collect();
        // HashMap order is random; sort so a tie cannot pick differently per run.
        pool.sort();
        for req in untraced {
            let want = normalize_arc_name(req);
            if want.is_empty() {
                continue;
            }
            let best = pool
                .iter()
                .map(|(title, url)| (dice_bigram(&want, title), *url))
                .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            if let Some((score, url)) = best {
                if score >= MIN_NAME_SIMILARITY {
                    out.insert(req.clone(), url.to_string());
                }
            }
        }
    }
    out
}

/// "Chapter 53", "Episode 14": the page of ONE chapter or episode. A wiki
/// redirects a chapter's own title there, so an arc named after its opening
/// chapter lands on it ("Urban Legend" -> "Chapter 53" on mob-psycho-100,
/// which files the arc itself as a section of "Story Arcs"). The lead image is
/// that chapter's first manga page or an episode screenshot, not arc art.
fn is_unit_page(title: &str) -> bool {
    let mut words = title.split_whitespace();
    matches!(
        (words.next(), words.next(), words.next()),
        (Some("Chapter" | "Episode"), Some(n), None) if n.bytes().all(|b| b.is_ascii_digit())
    )
}

/// One image on two or more arcs of the same show is not arc art: it is a
/// generic page that several arc names land on. Bleach redirected 9 of its 21
/// arcs to one "Episodes" page whose lead image is episode 1's title card, and
/// Dragon Ball's Spanish, Catalan and Latin American saga groupings
/// fuzzy-match the 21st, 22nd and 23rd World Martial Arts Tournament onto one
/// category page carrying Buu Saga (DBZ) art.
/// Drops every arc carrying such an image (they fall back to an episode still,
/// which at least differs per arc) and returns how many it dropped.
///
/// Parts of ONE arc are exempt (see `part_family`): TMDB splits One Piece's
/// Wano Country into "Part 1/2/3", all three match "Wano Country Arc", and
/// that shared picture is the right one.
fn drop_shared_images(art: &mut HashMap<String, String>) -> usize {
    let mut families: HashMap<&str, Vec<&str>> = HashMap::new();
    for (arc, url) in art.iter() {
        let family = part_family(arc);
        let seen = families.entry(url.as_str()).or_default();
        if !seen.contains(&family) {
            seen.push(family);
        }
    }
    let shared: Vec<String> = families
        .into_iter()
        .filter(|(_, fams)| fams.len() >= 2)
        .map(|(url, _)| url.to_string())
        .collect();
    let before = art.len();
    art.retain(|_, url| !shared.contains(url));
    before - art.len()
}

/// The arc a numbered part belongs to, from a NORMALIZED name: "wano country
/// part 2" and "compilation 15 part ii" (fairytail) -> "wano country",
/// "compilation 15". Only a TRAILING marker with a stem before it counts, so
/// deathnote's "part i l" (Part I - L arc) is a whole arc of its own.
fn part_family(arc_norm: &str) -> &str {
    match arc_norm.rsplit_once(" part ") {
        Some((stem, n))
            if !n.is_empty()
                && (n.bytes().all(|b| b.is_ascii_digit())
                    || n.bytes().all(|b| matches!(b, b'i' | b'v' | b'x'))) =>
        {
            stem
        }
        _ => arc_norm,
    }
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

/// The inverse, for a `fromencoded` title. Strict: `+` stays `+` (MediaWiki
/// encodes a space as `%20` here, and `+` is a legal title character), and a
/// malformed escape or non-UTF-8 result is `None` rather than a guess.
fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
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

    let key = cache_key(tmdb_id, arc_names);
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

    if pages.is_empty() {
        // ── Direct title probe ──
        //
        // A category listing is the good path, but a large minority of wikis
        // simply do not have one. Measured across this table: 7 of 27 hosts
        // returned zero members for ALL SIX category candidates: fma,
        // deathnote, swordartonline, mob-psycho-100, haikyuu, codegeass, and
        // bleach before it was removed. No amount of adding category names
        // fixes that, because those wikis do not model arcs as a category in
        // the first place.
        //
        // So ask for the arc names as page titles directly and let MediaWiki
        // resolve them (`redirects=1`). An arc a wiki files under another name
        // is a RENAMED redirect, and `fetch_page_images` keys the target's
        // image back to the name we asked for through the response's redirect
        // map. A redirect into a section, or onto a single chapter or episode
        // page, yields no art (see `key_images_to_requested`). Costs one
        // batched request (40 titles each), and only on hosts where the
        // category path already found nothing.
        let probe: Vec<String> = arc_names
            .iter()
            .filter(|n| !normalize_arc_name(n).is_empty())
            .cloned()
            .collect();
        // Every key is a name we asked for, so no stray entry (a redirect
        // target's own title, say) can make a miss non-empty and earn it the
        // 30-day hit TTL.
        for (name, url) in fetch_page_images(host, &probe).await {
            art.insert(normalize_arc_name(&name), url);
        }
    }

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
            // Known false positive, left for the maintainer: in One Piece's
            // "Sagas" grouping "sky island" scores 0.63 against "Drum Island
            // Arc" and 0.27 against the right page, "Skypiea Arc", so that
            // saga shows Drum Island's art. The wiki has a "Sky Island Saga"
            // page, so trying each arc name as an exact title before this
            // match would fix it (and would need its own cache bump).
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
        // Keyed by the page title we asked for, however MediaWiki normalized
        // or redirected it on the way (see `key_images_to_requested`).
        let images = fetch_page_images(host, &wanted).await;
        for (arc_norm, page) in arc_to_page {
            if let Some(url) = images.get(&page) {
                art.insert(arc_norm, url.clone());
            }
        }
    }

    // Both paths: a probe has no category vouching for the page it lands on,
    // and on the category path the fuzzy match above can put several arcs on
    // one member page.
    let shared = drop_shared_images(&mut art);
    if shared > 0 {
        crate::devlog!(
            info, "arcs",
            "{host}: dropped {shared} arcs that share one image with a different arc (not arc art)"
        );
    }
    if pages.is_empty() {
        crate::devlog!(
            info, "arcs",
            "{host}: no arc category, title probe matched {}/{} arcs",
            art.len(), arc_names.len()
        );
    } else {
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

#[cfg(test)]
mod tests {
    use super::*;

    // Unless marked synthetic, the `query` objects below are trimmed from real
    // responses to the exact request `fetch_page_images` sends (recorded
    // 2026-09-24 against onepiece.fandom.com, bleach.fandom.com and
    // mob-psycho-100.fandom.com), with the image URLs shortened. Parsing them
    // through `PagesQuery` keeps the wire shape under test too.
    fn query(json: &str) -> PagesQuery {
        serde_json::from_str(json).expect("fixture must parse as a MediaWiki query")
    }

    fn titles(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn img<'a>(out: &'a HashMap<String, String>, requested: &str) -> Option<&'a str> {
        out.get(requested).map(String::as_str)
    }

    // -------------------------------------------------- key_images_to_requested

    #[test]
    fn plain_title_keys_to_itself() {
        let q = query(
            r#"{"pages": {
                "1551": {"title": "Skypiea Arc", "original": {"source": "https://img/skypiea.png"}}
            }}"#,
        );
        let out = key_images_to_requested(&titles(&["Skypiea Arc"]), &q);
        assert_eq!(img(&out, "Skypiea Arc"), Some("https://img/skypiea.png"));
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn normalized_title_keys_back_to_the_request() {
        // MediaWiki turns the underscore into a space and answers under the
        // normalized title; the request must still get its image.
        let q = query(
            r#"{
                "normalized": [{"from": "Water_7 Arc", "to": "Water 7 Arc"}],
                "pages": {
                    "1554": {"title": "Water 7 Arc", "original": {"source": "https://img/water7.png"}}
                }
            }"#,
        );
        let out = key_images_to_requested(&titles(&["Water_7 Arc"]), &q);
        assert_eq!(img(&out, "Water_7 Arc"), Some("https://img/water7.png"));
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn repaired_title_is_decoded_and_its_normalization_chain_walked() {
        // Shape recorded on onepiece.fandom.com for a decomposed "e" + U+0301:
        // the repair is reported percent-encoded under `fromencoded`, and the
        // first-letter uppercasing follows as a SECOND entry. The page is
        // missing there; it is given an image here so the keying shows.
        let q = query(
            r#"{
                "normalized": [
                    {"fromencoded": "", "from": "cafe%CC%81%20Test", "to": "café Test"},
                    {"from": "café Test", "to": "Café Test"}
                ],
                "pages": {
                    "-1": {"title": "Café Test", "original": {"source": "https://img/cafe.png"}}
                }
            }"#,
        );
        let requested = "cafe\u{301} Test".to_string();
        let out = key_images_to_requested(std::slice::from_ref(&requested), &q);
        assert_eq!(img(&out, &requested), Some("https://img/cafe.png"));
        assert_eq!(percent_decode("a%2Bb+c%20d").as_deref(), Some("a+b+c d"));
        assert_eq!(percent_decode("bad%2"), None);
        assert_eq!(percent_decode("%FF"), None);
    }

    #[test]
    fn renamed_redirect_keys_back_to_the_requested_arc() {
        // The bug: the old matcher fuzzy-matched the request against the
        // TARGET title, and "Ryoka Invasion" shares nothing with "Soul Society
        // arc", so a renamed redirect was fetched and then never found.
        assert!(
            dice_bigram(
                &normalize_arc_name("Soul Society arc"),
                &normalize_arc_name("Ryoka Invasion"),
            ) < MIN_NAME_SIMILARITY
        );
        // Normalization first, then the redirect FROM the normalized form.
        let q = query(
            r#"{
                "normalized": [{"from": "soul_Society arc", "to": "Soul Society arc"}],
                "redirects": [{"from": "Soul Society arc", "to": "Ryoka Invasion"}],
                "pages": {
                    "17143": {"title": "Ryoka Invasion", "original": {"source": "https://img/ryoka.png"}}
                }
            }"#,
        );
        let out = key_images_to_requested(&titles(&["soul_Society arc"]), &q);
        assert_eq!(img(&out, "soul_Society arc"), Some("https://img/ryoka.png"));
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn two_requests_redirecting_to_one_page_both_key_back() {
        // Recorded on bleach.fandom.com: both names reach "Bount Invasion",
        // which appears ONCE in `pages`. Each request still gets its image;
        // whether sharing it is acceptable is `drop_shared_images`' call.
        let q = query(
            r#"{
                "redirects": [
                    {"from": "The Bount arc", "to": "Bount Invasion"},
                    {"from": "Bount arc", "to": "Bount Invasion"}
                ],
                "pages": {
                    "19154": {"title": "Bount Invasion", "original": {"source": "https://img/bount.png"}}
                }
            }"#,
        );
        let out = key_images_to_requested(&titles(&["The Bount arc", "Bount arc"]), &q);
        assert_eq!(img(&out, "The Bount arc"), Some("https://img/bount.png"));
        assert_eq!(img(&out, "Bount arc"), Some("https://img/bount.png"));
    }

    #[test]
    fn redirect_chain_is_followed_hop_by_hop() {
        // Synthetic: MediaWiki reports a double redirect as two hops.
        let q = query(
            r#"{
                "redirects": [
                    {"from": "Old Name", "to": "Middle Name"},
                    {"from": "Middle Name", "to": "Final Page"}
                ],
                "pages": {
                    "7": {"title": "Final Page", "original": {"source": "https://img/final.png"}}
                }
            }"#,
        );
        let out = key_images_to_requested(&titles(&["Old Name"]), &q);
        assert_eq!(img(&out, "Old Name"), Some("https://img/final.png"));
    }

    #[test]
    fn redirect_loop_terminates() {
        // Synthetic: a malformed answer must not spin the walk.
        let q = query(
            r#"{
                "redirects": [{"from": "A", "to": "B"}, {"from": "B", "to": "A"}],
                "pages": {}
            }"#,
        );
        assert!(key_images_to_requested(&titles(&["A"]), &q).is_empty());
    }

    #[test]
    fn redirect_into_a_section_yields_no_art() {
        // Recorded on bleach.fandom.com: "The Past" lands in a SECTION of a
        // timeline page whose lead image is a final-arc spoiler. The page's
        // image is not the section's, so the arc gets nothing, and the page is
        // claimed so the dice fallback cannot hand it out either.
        let q = query(
            r#"{
                "redirects": [{
                    "from": "The Past",
                    "to": "Timeline of Events",
                    "tofragment": "Historical Timeline"
                }],
                "pages": {
                    "88": {"title": "Timeline of Events", "original": {"source": "https://img/spoiler.png"}}
                }
            }"#,
        );
        let out = key_images_to_requested(&titles(&["The Past", "Timeline of Event"]), &q);
        assert!(out.is_empty(), "got {out:?}");
    }

    #[test]
    fn redirect_onto_a_chapter_page_yields_no_art() {
        // Recorded on mob-psycho-100.fandom.com: the arc "Urban Legend" is
        // chapter 53's title, and the page's lead image is that chapter's
        // first manga page, speech bubbles and all. The page stays claimed,
        // so the dice fallback cannot give it to a near-miss name either.
        let q = query(
            r#"{
                "redirects": [{"from": "Urban Legend", "to": "Chapter 53"}],
                "pages": {
                    "2725": {"pageid": 2725, "ns": 0, "title": "Chapter 53",
                             "original": {"source": "https://img/ch53.png", "width": 715, "height": 1013}}
                }
            }"#,
        );
        let out = key_images_to_requested(&titles(&["Urban Legend", "Chapter 5"]), &q);
        assert!(out.is_empty(), "got {out:?}");
    }

    #[test]
    fn unit_page_is_one_chapter_or_episode_only() {
        assert!(is_unit_page("Chapter 53"));
        assert!(is_unit_page("Episode 14"));
        // TMDB names fma's arcs like chapters, but each is a whole arc.
        assert!(!is_unit_page("Chapter 1 - Hunt for the Stone"));
        assert!(!is_unit_page("Episodes"));
        assert!(!is_unit_page("Chapter"));
        assert!(!is_unit_page("Chapter Black"));
    }

    #[test]
    fn missing_page_is_answered_not_fuzzed() {
        // Recorded on onepiece.fandom.com: "alabasta arc" normalizes to a
        // title that does not exist. That is an answer (no art), not a reason
        // to borrow "Arabasta Arc"'s image, which scores 0.71 against it.
        assert!(dice_bigram("alabasta", "arabasta") >= MIN_NAME_SIMILARITY);
        let q = query(
            r#"{
                "normalized": [{"from": "alabasta arc", "to": "Alabasta arc"}],
                "pages": {
                    "-1": {"ns": 0, "title": "Alabasta arc", "missing": ""},
                    "1548": {"title": "Arabasta Arc", "original": {"source": "https://img/arabasta.png"}}
                }
            }"#,
        );
        let out = key_images_to_requested(&titles(&["alabasta arc"]), &q);
        assert!(out.is_empty(), "got {out:?}");
    }

    #[test]
    fn untraceable_title_falls_back_to_dice() {
        // Synthetic. A request no map entry mentions and no page is titled,
        // which is what a name containing `|` produces: MediaWiki receives it
        // as two titles, neither of them the one we hold. Only then does
        // similarity apply, and only against pages no traced request claimed.
        let q = query(
            r#"{
                "pages": {
                    "1": {"title": "Enies Lobby Arc", "original": {"source": "https://img/enies.png"}},
                    "2": {"title": "Impel Down Arc", "original": {"source": "https://img/impel.png"}}
                }
            }"#,
        );
        let requested = titles(&[
            "Impel Down Arc",     // traced exactly, claims its page
            "Enies Lobby",        // untraced, dice 1.0 after normalization
            "Impel Down Part 2",  // untraced, and its only good match is claimed
            "Skypiea",            // untraced, nothing similar
        ]);
        let out = key_images_to_requested(&requested, &q);
        assert_eq!(img(&out, "Impel Down Arc"), Some("https://img/impel.png"));
        assert_eq!(img(&out, "Enies Lobby"), Some("https://img/enies.png"));
        assert_eq!(img(&out, "Impel Down Part 2"), None);
        assert_eq!(img(&out, "Skypiea"), None);
        assert_eq!(out.len(), 2);
    }

    // ------------------------------------------------------- drop_shared_images

    #[test]
    fn shared_image_is_dropped_from_every_arc() {
        // The Bleach shape: arc names collapsing onto one generic page.
        let mut art: HashMap<String, String> = [
            ("agent of the shinigami", "https://img/ep1-title-card.png"),
            ("soul society the sneak entry", "https://img/ep1-title-card.png"),
            ("soul society the rescue", "https://img/ep1-title-card.png"),
            ("the bount", "https://img/bount.png"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(drop_shared_images(&mut art), 3);
        assert_eq!(art.len(), 1);
        assert_eq!(art.get("the bount").map(String::as_str), Some("https://img/bount.png"));
    }

    #[test]
    fn distinct_images_are_all_kept() {
        let mut art: HashMap<String, String> = [
            ("alabasta", "https://img/arabasta.png"),
            ("water 7", "https://img/water7.png"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(drop_shared_images(&mut art), 0);
        assert_eq!(art.len(), 2);
        let mut empty: HashMap<String, String> = HashMap::new();
        assert_eq!(drop_shared_images(&mut empty), 0);
    }

    #[test]
    fn parts_of_one_arc_keep_their_shared_image() {
        // Both shapes from the category path, replayed live: One Piece's
        // "Story Arc" grouping puts Wano's three parts on "Wano Country Arc"
        // (right), and Dragon Ball's "Spanish Sagas" puts three different
        // tournaments on one page with Buu Saga art (wrong).
        let mut art: HashMap<String, String> = [
            ("wano country part 1", "https://img/wano.png"),
            ("wano country part 2", "https://img/wano.png"),
            ("wano country part 3", "https://img/wano.png"),
            ("21st world martial arts tournament", "https://img/buu-cast.jpg"),
            ("22nd world martial arts tournament", "https://img/buu-cast.jpg"),
            ("23rd world martial arts tournament", "https://img/buu-cast.jpg"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(drop_shared_images(&mut art), 3);
        assert_eq!(art.len(), 3);
        assert!(art.keys().all(|k| k.starts_with("wano country part ")), "got {art:?}");

        // Parts of one arc sharing an image with a DIFFERENT arc are two
        // families on one image, so all of them go.
        let mut art: HashMap<String, String> = [
            ("egghead part 1", "https://img/generic.png"),
            ("egghead part 2", "https://img/generic.png"),
            ("elbaph", "https://img/generic.png"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(drop_shared_images(&mut art), 3);
    }

    #[test]
    fn part_family_strips_only_a_trailing_part_number() {
        assert_eq!(part_family("wano country part 2"), "wano country");
        assert_eq!(part_family("compilation 15 part ii"), "compilation 15");
        // A leading marker is a whole arc (deathnote's "Part I - L arc").
        assert_eq!(part_family("part i l"), "part i l");
        assert_eq!(part_family("water 7"), "water 7");
        assert_eq!(part_family("x part 2 the separation"), "x part 2 the separation");
    }

    // ---------------------------------------------------------------- cache_key

    #[test]
    fn cache_key_tracks_the_arc_name_set() {
        let a = cache_key(37854, &titles(&["Alabasta", "Water 7"]));
        // Order and duplicates do not matter...
        assert_eq!(a, cache_key(37854, &titles(&["Water 7", "Alabasta", "Water 7"])));
        // ...but another grouping of the same show, or another show, does.
        assert_ne!(a, cache_key(37854, &titles(&["Alabasta Saga", "Water 7 Saga"])));
        assert_ne!(a, cache_key(46260, &titles(&["Alabasta", "Water 7"])));
        assert!(a.starts_with("art:37854:"));
    }
}
