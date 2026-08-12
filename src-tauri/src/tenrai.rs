// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Tenrai (MyAnimeList mirror) client.
//
// Replaces Jikan (api.jikan.moe/v4), which is shutting down permanently.
// Tenrai serves the identical response envelope and field names, so this is a
// base-URL change rather than a client rewrite. The one thing that is NOT the
// same is the version segment: Tenrai is `/v1`, Jikan was `/v4`. Verified live
// against /anime/21/full (One Piece) before the migration.
//
// Rate limits (better than Jikan's 3 req/s, 60/min):
//   public          4 req/s, 120/min, 40k/day
//   X-Server-Key    5 req/s, 300/min, unlimited daily  (Patreon; NOT used)
//
// The server key is deliberately out of scope. Public limits cover Aura's
// usage comfortably, and `api_keyring::SUPPORTED_KEYS` is where it would live
// if that ever changes.
//
// WHY THIS IS A MODULE AND NOT A CONST
//
// `/anime/{id}/full` was already being fetched by `ratings.rs` on every anime
// detail open AND every catalog hover, parsed down to five fields, and thrown
// away. That same payload carries the `theme` object (opening and ending
// songs). Routing both readers through one cached fetch means theme songs cost
// zero additional requests, and repeat surfaces cost zero requests at all.
//
// Everything here is best-effort, but it distinguishes "MAL has nothing" from
// "we could not ask". A 404 is an ANSWER and is cacheable; a dead host, a 5xx
// or an unparseable body is an ERROR and propagates. The frontend caches these
// payloads for seven days, so collapsing the two would persist a transient
// outage as "this show has no theme songs" long after Tenrai recovered.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Base URL. Single source of truth: `aniskip.rs`'s title search reads this
/// too, so there is no second hardcoded host anywhere in the tree.
pub const TENRAI_API: &str = "https://api.tenrai.org/v1";

const TIMEOUT: Duration = Duration::from_secs(10);
/// MAL scores drift slowly. Long enough to collapse a browsing session's
/// repeat hovers into one request, short enough that a score is never
/// meaningfully stale.
const TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// A miss is ambiguous: it means "no such MAL entry" but it also means
/// "the network was out when we asked". Honouring the second for six hours
/// would strip a show of ratings for the rest of the session.
const NEGATIVE_TTL: Duration = Duration::from_secs(10 * 60);
const CACHE_CAP: usize = 200;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent("Aura/1.6.3 anime-metadata")
            .build()
            .expect("Tenrai HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// /anime/{id}/full
// ---------------------------------------------------------------------------

/// The raw theme block. Both arrays are display strings, not structured data:
///   `1: "again" by YUI (eps 1-14)`
/// `theme_parse` turns them into spans. Note the naming trap on the wire:
/// `theme` is songs, `themes` is genre themes (Military, Isekai). Different
/// fields, and only the first is wanted here.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AnimeThemeRaw {
    #[serde(default)]
    pub openings: Vec<String>,
    #[serde(default)]
    pub endings: Vec<String>,
}

/// The subset of `/full` Aura reads. Deliberately narrow: this is cached, and
/// the payload is large.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AnimeFull {
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub scored_by: Option<u64>,
    #[serde(default)]
    pub rank: Option<u32>,
    #[serde(default)]
    pub popularity: Option<u32>,
    #[serde(default)]
    pub members: Option<u64>,
    #[serde(default)]
    pub theme: Option<AnimeThemeRaw>,
    // ── Facts ──
    // All of this was already arriving in the payload and being discarded.
    // Deliberately narrow still: only fields the detail page does not already
    // show somewhere else. Score, rank and popularity are omitted here on
    // purpose because they are already chips in the identity block and a whole
    // tab of their own.
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub rating: Option<String>,
    #[serde(default)]
    pub season: Option<String>,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub aired: Option<AiredRaw>,
    #[serde(default)]
    pub studios: Vec<NamedRef>,
    #[serde(default)]
    pub producers: Vec<NamedRef>,
    #[serde(default)]
    pub licensors: Vec<NamedRef>,
    #[serde(default)]
    pub demographics: Vec<NamedRef>,
    #[serde(default)]
    pub broadcast: Option<BroadcastRaw>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct BroadcastRaw {
    #[serde(default)]
    pub string: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AiredRaw {
    #[serde(default)]
    pub string: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NamedRef {
    #[serde(default)]
    pub name: Option<String>,
}

/// The Overview tab's fact list. Flattened and pre-formatted so the frontend
/// renders strings rather than reimplementing MAL's shapes.
#[derive(Clone, Debug, Default, Serialize)]
pub struct AnimeFacts {
    pub source: Option<String>,
    pub status: Option<String>,
    pub rating: Option<String>,
    /// "Spring 2022", from season + year.
    pub premiered: Option<String>,
    pub aired: Option<String>,
    pub studios: Vec<String>,
    pub producers: Vec<String>,
    pub licensors: Vec<String>,
    pub demographics: Vec<String>,
    /// "Saturdays at 23:00 (JST)". Useful on an airing show, absent otherwise.
    pub broadcast: Option<String>,
}

fn names(v: Vec<NamedRef>) -> Vec<String> {
    v.into_iter()
        .filter_map(|n| n.name)
        .filter(|n| !n.trim().is_empty())
        .collect()
}

#[tauri::command]
pub async fn fetch_anime_facts(mal_id: u32) -> Result<Option<AnimeFacts>, String> {
    let Some(f) = anime_full_checked(mal_id).await? else { return Ok(None) };
    let premiered = match (f.season.as_deref(), f.year) {
        (Some(s), Some(y)) if !s.is_empty() => {
            let mut c = s.chars();
            let season = match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            };
            Some(format!("{season} {y}"))
        }
        _ => None,
    };
    let facts = AnimeFacts {
        // MAL writes "TV" as a rating value for unrated entries and "None" for
        // missing ones; both are noise in a fact list.
        rating: f.rating.filter(|r| !r.eq_ignore_ascii_case("none")),
        source: f.source.filter(|v| !v.eq_ignore_ascii_case("unknown")),
        status: f.status,
        premiered,
        aired: f.aired.and_then(|a| a.string).filter(|s| !s.trim().is_empty()),
        studios: names(f.studios),
        producers: names(f.producers),
        licensors: names(f.licensors),
        demographics: names(f.demographics),
        broadcast: f.broadcast.and_then(|b| b.string)
            .filter(|s| !s.trim().is_empty() && !s.eq_ignore_ascii_case("unknown")),
    };
    // Nothing worth a section is nothing at all.
    let empty = facts.source.is_none() && facts.status.is_none() && facts.rating.is_none()
        && facts.premiered.is_none() && facts.aired.is_none()
        && facts.studios.is_empty() && facts.producers.is_empty()
        && facts.licensors.is_empty() && facts.demographics.is_empty()
        && facts.broadcast.is_none();
    Ok(if empty { None } else { Some(facts) })
}

#[derive(Deserialize)]
struct Envelope<T> {
    data: Option<T>,
}

#[derive(Clone)]
struct FullEntry {
    value: Option<AnimeFull>,
    cached_at: Instant,
}

static FULL_CACHE: OnceLock<Mutex<HashMap<u32, FullEntry>>> = OnceLock::new();

fn full_cache() -> &'static Mutex<HashMap<u32, FullEntry>> {
    FULL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Insert with eviction. Drops the oldest quarter when the cap is reached,
/// mirroring `aniskip.rs`'s cache discipline.
fn cache_put(mal_id: u32, value: Option<AnimeFull>) {
    let mut lock = full_cache().lock().unwrap();
    if lock.len() >= CACHE_CAP {
        let mut ages: Vec<(u32, Instant)> =
            lock.iter().map(|(k, v)| (*k, v.cached_at)).collect();
        ages.sort_by_key(|(_, t)| *t);
        for (k, _) in ages.into_iter().take(CACHE_CAP / 4) {
            lock.remove(&k);
        }
    }
    lock.insert(mal_id, FullEntry { value, cached_at: Instant::now() });
}

fn cache_get(mal_id: u32) -> Option<Option<AnimeFull>> {
    let lock = full_cache().lock().unwrap();
    let entry = lock.get(&mal_id)?;
    let ttl = if entry.value.is_some() { TTL } else { NEGATIVE_TTL };
    if entry.cached_at.elapsed() >= ttl {
        return None;
    }
    Some(entry.value.clone())
}

/// Fetch `/anime/{id}/full`, cached. `None` means "no usable answer", never
/// "empty answer": callers treat it as the feature being unavailable for this
/// id rather than as data.
pub async fn anime_full(mal_id: u32) -> Option<AnimeFull> {
    if mal_id == 0 {
        return None;
    }
    if let Some(hit) = cache_get(mal_id) {
        return hit;
    }
    // Only an ANSWER is cached. A failure to ask propagates so the caller can
    // surface it rather than persisting "this show has nothing".
    match fetch_json::<AnimeFull>(&format!("{TENRAI_API}/anime/{mal_id}/full")).await {
        Ok(value) => {
            cache_put(mal_id, value.clone());
            value
        }
        Err(_) => None,
    }
}

/// Same as `anime_full` but preserves the ask-failed vs no-answer distinction
/// for the commands, which must not let the frontend cache an outage.
async fn anime_full_checked(mal_id: u32) -> Result<Option<AnimeFull>, String> {
    if mal_id == 0 {
        return Ok(None);
    }
    if let Some(hit) = cache_get(mal_id) {
        return Ok(hit);
    }
    let value = fetch_json::<AnimeFull>(&format!("{TENRAI_API}/anime/{mal_id}/full")).await?;
    cache_put(mal_id, value.clone());
    Ok(value)
}

// ---------------------------------------------------------------------------
// Extras: the on-demand payloads behind the detail page's More info overlay.
//
// NONE of this rides `MetaDetail`. `metaCache` holds up to 800 entries and is
// read by catalog hover, Calendar, Continue Watching and the notification
// scanner, so a histogram plus a staff list plus a recommendation array
// attached there would be multiplied by 800 and paid on surfaces that never
// render any of it. Each of these is fetched when a human opens the tab that
// shows it, and not before.
// ---------------------------------------------------------------------------

/// Opening and ending songs, already parsed. The frontend never sees a raw
/// display string it would have to parse itself.
#[derive(Clone, Debug, Default, Serialize)]
pub struct AnimeThemes {
    pub openings: Vec<crate::theme_parse::AnimeTheme>,
    pub endings: Vec<crate::theme_parse::AnimeTheme>,
}

#[tauri::command]
pub async fn fetch_anime_themes(mal_id: u32) -> Result<Option<AnimeThemes>, String> {
    let Some(full) = anime_full_checked(mal_id).await? else { return Ok(None) };
    let Some(theme) = full.theme else { return Ok(None) };
    if theme.openings.is_empty() && theme.endings.is_empty() {
        return Ok(None);
    }
    Ok(Some(AnimeThemes {
        openings: crate::theme_parse::parse_all(&theme.openings),
        endings: crate::theme_parse::parse_all(&theme.endings),
    }))
}

// ── /anime/{id}/statistics ──

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScoreBucket {
    pub score: u32,
    pub votes: u64,
    pub percentage: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct AnimeStatistics {
    #[serde(default)]
    pub watching: u64,
    #[serde(default)]
    pub completed: u64,
    #[serde(default)]
    pub on_hold: u64,
    #[serde(default)]
    pub dropped: u64,
    #[serde(default)]
    pub plan_to_watch: u64,
    #[serde(default)]
    pub total: u64,
    /// Ten buckets, one per whole score. Ordered 1..10 upstream.
    #[serde(default)]
    pub scores: Vec<ScoreBucket>,
}

#[tauri::command]
pub async fn fetch_anime_statistics(mal_id: u32) -> Result<Option<AnimeStatistics>, String> {
    let url = format!("{TENRAI_API}/anime/{mal_id}/statistics");
    let stats: Option<AnimeStatistics> = fetch_json(&url).await?;
    // A payload with no votes at all is not a histogram. Treat it as absent so
    // the tab renders an honest empty state instead of ten zero-width bars.
    Ok(stats.filter(|s| s.total > 0 || s.scores.iter().any(|b| b.votes > 0)))
}

// ── /anime/{id}/staff ──

/// Roles worth surfacing, in display order.
///
/// The raw response is enormous (742 rows for Frieren) because it includes
/// every per-episode storyboard and animation-director credit. Filtering here
/// rather than in the UI keeps that payload off the wire and out of the cache.
const KEY_STAFF_ROLES: &[&str] = &[
    "Original Creator",
    "Director",
    "Series Composition",
    "Script",
    "Character Design",
    "Music",
    "Sound Director",
];

#[derive(Deserialize)]
struct StaffRow {
    person: StaffPerson,
    #[serde(default)]
    positions: Vec<String>,
}

#[derive(Deserialize)]
struct StaffPerson {
    mal_id: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    images: Option<ImageSet>,
}

#[derive(Clone, Debug, Deserialize)]
struct ImageSet {
    #[serde(default)]
    jpg: Option<ImageUrls>,
}

#[derive(Clone, Debug, Deserialize)]
struct ImageUrls {
    #[serde(default)]
    image_url: Option<String>,
}

/// MAL serves this placeholder for people with no photo. Mapping it to None
/// lets the UI render its own initial-letter avatar instead of a grey glyph.
const MAL_PLACEHOLDER: &str = "questionmark";

#[derive(Clone, Debug, Serialize)]
pub struct StaffCredit {
    pub mal_id: u32,
    pub name: String,
    /// Only the roles from `KEY_STAFF_ROLES`, in that order.
    pub positions: Vec<String>,
    pub image: Option<String>,
}

#[tauri::command]
pub async fn fetch_anime_staff(mal_id: u32) -> Result<Vec<StaffCredit>, String> {
    let url = format!("{TENRAI_API}/anime/{mal_id}/staff");
    let Some(rows) = fetch_json::<Vec<StaffRow>>(&url).await? else {
        return Ok(Vec::new());
    };

    let mut out: Vec<StaffCredit> = Vec::new();
    for row in rows {
        let kept: Vec<String> = KEY_STAFF_ROLES
            .iter()
            .filter(|role| row.positions.iter().any(|p| p.eq_ignore_ascii_case(role)))
            .map(|r| (*r).to_string())
            .collect();
        if kept.is_empty() {
            continue;
        }
        let Some(name) = row.person.name.filter(|n| !n.trim().is_empty()) else { continue };
        // One person can hold several key roles (director and script is
        // common). Merge rather than listing them twice.
        if let Some(existing) = out.iter_mut().find(|c| c.mal_id == row.person.mal_id) {
            for r in kept {
                if !existing.positions.contains(&r) {
                    existing.positions.push(r);
                }
            }
            continue;
        }
        let image = row
            .person
            .images
            .and_then(|i| i.jpg)
            .and_then(|j| j.image_url)
            .filter(|u| !u.contains(MAL_PLACEHOLDER));
        out.push(StaffCredit { mal_id: row.person.mal_id, name, positions: kept, image });
    }

    // Order by the role table so a director never sorts below a sound
    // director just because MAL listed them later.
    out.sort_by_key(|c| {
        c.positions
            .iter()
            .filter_map(|p| KEY_STAFF_ROLES.iter().position(|r| r == p))
            .min()
            .unwrap_or(usize::MAX)
    });
    Ok(out)
}

// ── /anime/{id}/characters ──
//
// The addon's own cast entries carry only {name, character, photo}: an actor
// photo and a character's NAME, never the character's art. This is where that
// art comes from, which is what lets the cast grid show the role rather than
// only the person playing it.

const CHARACTER_CAP: usize = 60;

#[derive(Deserialize)]
struct CharacterRow {
    character: NamedEntity,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    favorites: u32,
    #[serde(default)]
    voice_actors: Vec<VoiceActorRow>,
}

#[derive(Deserialize)]
struct VoiceActorRow {
    person: NamedEntity,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Deserialize)]
struct NamedEntity {
    mal_id: u32,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    images: Option<CharImages>,
}

#[derive(Deserialize)]
struct CharImages {
    #[serde(default)]
    jpg: Option<ImageUrls>,
    #[serde(default)]
    webp: Option<ImageUrls>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnimeCharacter {
    pub mal_id: u32,
    /// MAL writes these surname-first ("Forger, Anya"). Flipped here so the UI
    /// never has to know that, and so it matches the addon's own cast strings.
    pub name: String,
    pub image: Option<String>,
    /// "Main" or "Supporting". Drives ordering.
    pub role: Option<String>,
    /// Japanese voice actor, which is the one that pairs with the character.
    pub actor: Option<String>,
    pub actor_image: Option<String>,
}

/// "Forger, Anya" -> "Anya Forger". Left alone when there is no comma, since a
/// mononym or an already-natural name must not be mangled.
fn flip_surname_first(raw: &str) -> String {
    match raw.split_once(',') {
        Some((last, first)) if !first.trim().is_empty() => {
            format!("{} {}", first.trim(), last.trim())
        }
        _ => raw.trim().to_string(),
    }
}

fn pick_image(images: Option<CharImages>) -> Option<String> {
    let i = images?;
    // webp first: MAL serves noticeably smaller files for identical art.
    let url = i
        .webp
        .and_then(|w| w.image_url)
        .or_else(|| i.jpg.and_then(|j| j.image_url))?;
    if url.contains(MAL_PLACEHOLDER) { None } else { Some(url) }
}

#[tauri::command]
pub async fn fetch_anime_characters(mal_id: u32) -> Result<Vec<AnimeCharacter>, String> {
    let url = format!("{TENRAI_API}/anime/{mal_id}/characters");
    let Some(rows) = fetch_json::<Vec<CharacterRow>>(&url).await? else {
        return Ok(Vec::new());
    };

    let mut rows: Vec<(bool, u32, AnimeCharacter)> = rows
        .into_iter()
        .filter_map(|r| {
            let name = r.character.name.filter(|n| !n.trim().is_empty())?;
            // The JAPANESE voice actor is the one that belongs with the
            // character art; an English dub would pair a different face to the
            // same role.
            let va = r
                .voice_actors
                .into_iter()
                .find(|v| v.language.as_deref() == Some("Japanese"));
            let is_main = r.role.as_deref() == Some("Main");
            Some((
                is_main,
                r.favorites,
                AnimeCharacter {
                    mal_id: r.character.mal_id,
                    name: flip_surname_first(&name),
                    image: pick_image(r.character.images),
                    role: r.role,
                    actor: va
                        .as_ref()
                        .and_then(|v| v.person.name.clone())
                        .map(|n| flip_surname_first(&n)),
                    actor_image: va.and_then(|v| pick_image(v.person.images)),
                },
            ))
        })
        .collect();

    // Main cast first, then by MAL favourites. Upstream order is neither, so
    // without this a 65-entry list opens on background characters.
    rows.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut out: Vec<AnimeCharacter> = rows.into_iter().map(|(_, _, c)| c).collect();
    out.truncate(CHARACTER_CAP);
    Ok(out)
}

// ── /anime/{id}/recommendations ──

const RECOMMENDATION_CAP: usize = 24;

#[derive(Deserialize)]
struct RecommendationRow {
    entry: RecommendationEntry,
    #[serde(default)]
    votes: u32,
}

#[derive(Deserialize)]
struct RecommendationEntry {
    mal_id: u32,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    images: Option<ImageSet>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Recommendation {
    pub mal_id: u32,
    pub title: String,
    pub votes: u32,
    pub image: Option<String>,
}

#[tauri::command]
pub async fn fetch_anime_recommendations(mal_id: u32) -> Result<Vec<Recommendation>, String> {
    let url = format!("{TENRAI_API}/anime/{mal_id}/recommendations");
    let Some(rows) = fetch_json::<Vec<RecommendationRow>>(&url).await? else {
        return Ok(Vec::new());
    };
    let mut out: Vec<Recommendation> = rows
        .into_iter()
        .filter_map(|r| {
            let title = r.entry.title.filter(|t| !t.trim().is_empty())?;
            Some(Recommendation {
                mal_id: r.entry.mal_id,
                title,
                votes: r.votes,
                image: r.entry.images.and_then(|i| i.jpg).and_then(|j| j.image_url),
            })
        })
        .collect();
    // Upstream order is not strictly by votes. Sort so the strongest
    // community picks lead, then cap: 80 rows for one show is a scroll, not a
    // recommendation.
    out.sort_by(|a, b| b.votes.cmp(&a.votes));
    out.truncate(RECOMMENDATION_CAP);
    Ok(out)
}

// ── /anime/{id}/videos ──

#[derive(Deserialize)]
struct VideosPayload {
    #[serde(default)]
    promo: Vec<PromoRow>,
}

#[derive(Deserialize)]
struct PromoRow {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    trailer: Option<TrailerRow>,
}

#[derive(Deserialize)]
struct TrailerRow {
    #[serde(default)]
    youtube_id: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    images: Option<TrailerImages>,
}

#[derive(Deserialize)]
struct TrailerImages {
    #[serde(default)]
    maximum_image_url: Option<String>,
    #[serde(default)]
    large_image_url: Option<String>,
    #[serde(default)]
    medium_image_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AnimeTrailer {
    pub youtube_id: String,
    pub title: String,
    pub url: String,
    pub thumbnail: Option<String>,
}

#[tauri::command]
pub async fn fetch_anime_trailers(mal_id: u32) -> Result<Vec<AnimeTrailer>, String> {
    let url = format!("{TENRAI_API}/anime/{mal_id}/videos");
    let Some(payload) = fetch_json::<VideosPayload>(&url).await? else {
        return Ok(Vec::new());
    };

    // Dedup by youtube_id is REQUIRED, not defensive: upstream genuinely
    // repeats one video under several titles (Frieren lists the same id as
    // both "Main Trailer" and "PV 5"). First title wins, since the earlier
    // entries carry the more descriptive names.
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for row in payload.promo {
        let Some(t) = row.trailer else { continue };
        let Some(yt) = t.youtube_id.filter(|s| !s.trim().is_empty()) else { continue };
        if seen.iter().any(|s| s == &yt) {
            continue;
        }
        seen.push(yt.clone());
        let images = t.images;
        out.push(AnimeTrailer {
            url: t.url.unwrap_or_else(|| format!("https://www.youtube.com/watch?v={yt}")),
            title: row.title.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "Trailer".into()),
            thumbnail: images.and_then(|i| {
                i.maximum_image_url.or(i.large_image_url).or(i.medium_image_url)
            }),
            youtube_id: yt,
        });
    }
    Ok(out)
}

/// Shared GET plus envelope unwrap. Every endpoint in this module returns
/// `{ "data": ... }`, so the failure handling lives here once.
///
/// `Err` means "we could not ask" (transport failure, a non-404 HTTP status, or
/// an unparseable body). `Ok(None)` means "we asked and MAL has nothing".
///
/// That distinction is load-bearing, and collapsing it was a real bug: the
/// frontend caches answers for SEVEN DAYS, so a transient outage returned as an
/// empty success got persisted as "this show has no theme songs" and survived
/// long after Tenrai came back. Only `Ok` is cacheable.
async fn fetch_json<T: for<'de> Deserialize<'de>>(url: &str) -> Result<Option<T>, String> {
    let resp = match client().get(url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "tenrai", "request failed {url}: {e}");
            return Err(format!("request failed: {e}"));
        }
    };
    let status = resp.status();
    if !status.is_success() {
        // 404 is a real answer: the id does not exist on MAL. Everything else
        // is us failing to ask, and must not be cached as an answer.
        if status.as_u16() == 404 {
            return Ok(None);
        }
        crate::devlog!(warn, "tenrai", "HTTP {} for {url}", status.as_u16());
        return Err(format!("HTTP {}", status.as_u16()));
    }
    match resp.json::<Envelope<T>>().await {
        Ok(env) => Ok(env.data),
        Err(e) => {
            crate::devlog!(warn, "tenrai", "parse error for {url}: {e}");
            Err(format!("parse error: {e}"))
        }
    }
}
