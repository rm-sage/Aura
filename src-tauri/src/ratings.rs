// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Multi-source ratings aggregator.
//
// Folds MDBList (IMDb / RT & Metacritic audience / TMDB / Trakt /
// Letterboxd) and the anime pair Tenrai (MyAnimeList score, weighted
// score, popularity rank) + AniList (averageScore) into a single
// normalized list the DetailView renders. The MDBList key is baked at
// build time, so the IMDb / RT / Metacritic tier always lights up;
// Tenrai + AniList add the anime scores, and addon-supplied ratings
// still render alongside.
//
// Why no Rotten Tomatoes audience score? RT's "audience" score sits
// behind Fandango's paid Audience Insights API and isn't exposed by any
// free public endpoint. Same story for Metacritic's user score (the
// public site embeds it but neither RT nor Metacritic publish a stable
// JSON endpoint outside of their own front-end). When a free provider
// for either becomes available we slot it in here — every additional
// source is a single async fn that pushes Rating rows.
//
// Sources supported here:
//   • MDBList (mdblist.com/api)      — IMDb + Rotten Tomatoes & Metacritic
//                                       AUDIENCE + TMDB + Trakt + Letterboxd,
//                                       one call by IMDb id. Key baked at
//                                       build time (build.rs, git-ignored
//                                       file → cargo:rustc-env). Replaced
//                                       OMDb (critic-only, redundant now).
//   • Tenrai (api.tenrai.org v1)     - MyAnimeList score (anime only),
//                                       no key needed, 4 req/sec ceiling.
//                                       Replaced Jikan, which shut down.
//   • AniList (graphql.anilist.co)   — averageScore by idMal (anime
//                                       only), no key needed.
//
// Output shape: `AggregateRating { source, value, weight, kind, badge_color }`
// — the frontend doesn't need to know how each value was sourced; it
// just renders whatever lands in the array.
// ---------------------------------------------------------------------------

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const TIMEOUT: Duration = Duration::from_secs(10);

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
            .user_agent("Aura/0.6.6 ratings-aggregator")
            .build()
            .expect("Ratings HTTP client init failed")
    })
}

#[derive(Clone, Debug, Serialize)]
pub struct AggregateRating {
    /// Display label, e.g. "IMDb", "Rotten Tomatoes", "Metacritic", "MAL".
    pub source: String,
    /// Pre-formatted display value, e.g. "8.1/10", "94%", "85/100".
    pub value: String,
    /// "critic" | "audience" | "aggregate". Lets the UI separate critic
    /// vs audience tiles when both are present (RT critic + RT
    /// audience would render as a paired group).
    pub kind: String,
    /// Optional sort hint (higher = render first). Useful when the
    /// frontend wants to surface IMDb / MAL ahead of niche scores.
    pub weight: i32,
}

// ---------------------------------------------------------------------------
// MDBList branch — one call by IMDb id returns every mainstream score
// (replaces OMDb, which only had IMDb + RT/Metacritic CRITIC). Key is
// baked at build time by build.rs (cargo:rustc-env) from a git-ignored
// file — never in the repo; empty key → branch no-ops cleanly.
//
// We surface the AUDIENCE score per brand (one chip each): RT audience
// (not the Tomatometer), Metacritic user (not the Metascore), TMDB /
// Trakt user scores, IMDb, Letterboxd. Pure-critic rows
// (tomatoes/metacritic critic, rogerebert) and myanimelist are skipped
// - MAL is owned by the richer Tenrai branch below (score + rank +
// popularity, and it works for kitsu/mal-id anime MDBList can't key);
// AniList rides alongside Tenrai from the same resolved MAL id.
// ---------------------------------------------------------------------------

const MDBLIST_KEY: &str = env!("AURA_MDBLIST_KEY");

#[derive(Deserialize)]
struct MdbRating {
    source: String,
    value:  Option<f64>,
    score:  Option<f64>,
}
#[derive(Deserialize)]
struct MdbResponse {
    #[serde(default)]
    ratings: Vec<MdbRating>,
    /// Theatrical / primary release date (`YYYY-MM-DD`). Present on
    /// movies; we capture it for the accurate "In Theaters" signal and
    /// as the cinematic-countdown anchor. The struct historically
    /// discarded every non-`ratings` key, so this is purely additive.
    #[serde(default)]
    released: Option<String>,
    /// Digital / streaming (PVOD/EST) release date (`YYYY-MM-DD`). This
    /// is the authoritative value that replaces Aura's old "theatrical
    /// + 45 days" estimate for the Digital countdown. Empty / absent for
    /// very recent theatrical titles whose digital window isn't announced
    /// yet — callers fall back to the estimate in that case.
    #[serde(default)]
    released_digital: Option<String>,
}

async fn mdblist_to_aggregate(imdb_id: &str) -> Vec<AggregateRating> {
    if MDBLIST_KEY.is_empty() {
        return Vec::new();
    }
    // Build the query via reqwest so the key + id are percent-encoded
    // and never string-interpolated into a URL we might log. `imdb_id`
    // is already `tt`-shape-filtered upstream; this is defence-in-depth.
    let resp = match client()
        .get("https://mdblist.com/api/")
        .query(&[("apikey", MDBLIST_KEY), ("i", imdb_id)])
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return Vec::new(),
    };
    let data: MdbResponse = match resp.json().await {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };

    let pct = |s: Option<f64>| s.map(|v| format!("{}%", v.round() as i64));
    let ten = |v: Option<f64>| v.map(|x| format!("{x:.1}"));

    let mut out = Vec::new();
    for r in &data.ratings {
        // (label, formatted value, weight, kind)
        let mapped: Option<(&str, Option<String>, i32, &str)> = match r.source.as_str() {
            "imdb"             => Some(("IMDb",            ten(r.value), 100, "audience")),
            "tomatoesaudience" => Some(("Rotten Tomatoes", pct(r.score),  92, "audience")),
            "metacriticuser"   => Some(("Metacritic",      pct(r.score),  80, "audience")),
            "tmdb"             => Some(("TMDB",            pct(r.score),  70, "audience")),
            "trakt"            => Some(("Trakt",           pct(r.score),  65, "audience")),
            "letterboxd"       => Some(("Letterboxd",      ten(r.value),  60, "audience")),
            _ => None,
        };
        if let Some((source, Some(value), weight, kind)) = mapped {
            out.push(AggregateRating {
                source: source.into(),
                value,
                kind: kind.into(),
                weight,
            });
        }
    }
    out
}

// ---------------------------------------------------------------------------
// MDBList release dates — accurate Digital / Theatrical dates for movies.
//
// The SAME MDBList response that powers the ratings branch already carries
// `released` (theatrical) and `released_digital` (digital/PVOD). Aura used
// to estimate the digital date as "theatrical + 45 days", which routinely
// drifted 20–40+ days off the real date (Oppenheimer: estimate 2023-09-02
// vs actual 2023-11-09). This reads the authoritative value instead, by
// IMDb id, using the key Aura already bakes — no new credential.
//
// Kept as its own one-call fetch (rather than folding into the ratings
// command's response) so the dates flow on a clean, independently-cached
// path that doesn't perturb the ratings contract or its hover-card cache.
// ---------------------------------------------------------------------------

/// Normalise an MDBList date string: trim, and treat empty as absent so
/// callers don't have to distinguish `Some("")` from a real date.
fn norm_date(d: Option<String>) -> Option<String> {
    d.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Fetch (theatrical, digital) release dates for a movie by IMDb id from
/// MDBList. Best-effort: any failure (no key, network, parse, no record)
/// yields `(None, None)` and the caller falls back to its estimate.
async fn mdblist_release_dates(imdb_id: &str) -> (Option<String>, Option<String>) {
    if MDBLIST_KEY.is_empty() {
        return (None, None);
    }
    let resp = match client()
        .get("https://mdblist.com/api/")
        .query(&[("apikey", MDBLIST_KEY), ("i", imdb_id)])
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return (None, None),
    };
    let data: MdbResponse = match resp.json().await {
        Ok(d) => d,
        Err(_) => return (None, None),
    };
    (norm_date(data.released), norm_date(data.released_digital))
}

/// Movie release dates returned to the frontend. Both `YYYY-MM-DD` when
/// known; either may be absent. The fields serialise as `theatrical` /
/// `digital` (Rust field names → Tauri's outgoing JSON), matching the
/// `ReleaseDates` TS interface in `src/releaseDates.ts`.
#[derive(Clone, Debug, Default, Serialize)]
pub struct MovieReleaseDates {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theatrical: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digital: Option<String>,
}

/// Accurate Digital + Theatrical release dates for a movie, by IMDb id.
/// Non-`tt` ids resolve to empty (MDBList's `i` param is IMDb-keyed).
/// Never errors — an unavailable date is simply `None`.
#[tauri::command]
pub async fn fetch_movie_release_dates(imdb_id: String) -> Result<MovieReleaseDates, String> {
    if !imdb_id.starts_with("tt") {
        return Ok(MovieReleaseDates::default());
    }
    let (theatrical, digital) = mdblist_release_dates(&imdb_id).await;
    Ok(MovieReleaseDates { theatrical, digital })
}

// ---------------------------------------------------------------------------
// MyAnimeList branch
//
// Reads through `tenrai::anime_full`, which caches the `/anime/{id}/full`
// payload. That payload also carries the opening and ending theme songs the
// extras overlay renders, so the two features share one request instead of
// issuing one each.
// ---------------------------------------------------------------------------

async fn mal_for_mal_id(mal_id: u32) -> Vec<AggregateRating> {
    let Some(data) = crate::tenrai::anime_full(mal_id).await else {
        return Vec::new();
    };

    let mut out = Vec::new();
    if let Some(score) = data.score.filter(|v| *v > 0.0) {
        out.push(AggregateRating {
            source: "MyAnimeList".into(),
            value: format!("{score:.2}/10"),
            kind: "aggregate".into(),
            // > IMDb's 100 so anime always surfaces MAL/AniList first
            // within the chip cap (the user's "prioritise" ask).
            weight: 110,
        });
    }
    if let Some(rank) = data.rank.filter(|v| *v > 0) {
        out.push(AggregateRating {
            source: "MAL Rank".into(),
            value: format!("#{rank}"),
            kind: "aggregate".into(),
            weight: 60,
        });
    }
    if let Some(pop) = data.popularity.filter(|v| *v > 0) {
        out.push(AggregateRating {
            source: "MAL Popularity".into(),
            value: format!("#{pop}"),
            kind: "aggregate".into(),
            weight: 55,
        });
    }
    let _ = data.members;
    out
}

// ---------------------------------------------------------------------------
// AniList branch — public GraphQL, no key, generous rate limit. AniList
// indexes by MAL id directly (`idMal`), so we reuse whatever MAL id the
// MAL branch resolved. `averageScore` is AniList's weighted 0-100
// mean — the score users actually recognise on anilist.co.
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct AlMedia {
    #[serde(rename = "averageScore")]
    average_score: Option<i64>,
}
#[derive(Deserialize)]
struct AlData {
    #[serde(rename = "Media")]
    media: Option<AlMedia>,
}
#[derive(Deserialize)]
struct AlResp {
    data: Option<AlData>,
}

async fn anilist_for_mal(mal_id: u32) -> Vec<AggregateRating> {
    let body = serde_json::json!({
        "query": "query($m:Int){Media(idMal:$m,type:ANIME){averageScore}}",
        "variables": { "m": mal_id },
    });
    let resp = match client().post("https://graphql.anilist.co").json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "ratings", "anilist request failed: {e}");
            return Vec::new();
        }
    };
    let parsed: AlResp = match resp.json().await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(score) = parsed
        .data
        .and_then(|d| d.media)
        .and_then(|m| m.average_score)
        .filter(|s| *s > 0)
    else {
        return Vec::new();
    };
    vec![AggregateRating {
        source: "AniList".into(),
        value:  format!("{score}%"),
        kind:   "audience".into(),
        weight: 108, // just below MAL, above IMDb (anime priority)
    }]
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AggregateInput {
    /// IMDb id when known (`tt0903747`). Populates the MDBList branch.
    pub imdb_id: Option<String>,
    /// Numeric MAL id, when the caller already knows it (e.g. from
    /// AIOMetadata). Populates the MAL + AniList branches directly.
    pub mal_id: Option<u32>,
    /// Numeric Kitsu id; resolved -> MAL -> Tenrai.
    pub kitsu_id: Option<u32>,
    /// Numeric AniList id; resolved -> MAL -> Tenrai.
    pub anilist_id: Option<u32>,
    /// Numeric AniDB id; resolved -> MAL -> Tenrai.
    pub anidb_id: Option<u32>,
    /// Title fallback for resolution by name when no numeric id
    /// resolved. Optional release year tightens the match.
    pub title: Option<String>,
    pub year: Option<u32>,
    /// True when the meta type is "anime" or genres include the anime
    /// signal. Gate for the MAL branch: non-anime IMDb ids skip the
    /// resolution attempt to avoid useless calls.
    pub is_anime: bool,
}

/// Aggregate ratings from every available source for a given title.
/// Best-effort: any branch that fails or isn't applicable contributes
/// nothing rather than erroring the call. Returned newest-source-first
/// after stable-sorting by `weight` descending.
#[tauri::command]
pub async fn fetch_aggregate_ratings(
    input: AggregateInput,
) -> Result<Vec<AggregateRating>, String> {
    let mut out: Vec<AggregateRating> = Vec::new();

    // ── MDBList branch (IMDb / RT+Metacritic AUDIENCE / TMDB / Trakt /
    //    Letterboxd) — by IMDb id ─────────────────────────────────────────
    if let Some(imdb) = input.imdb_id.as_deref().filter(|s| s.starts_with("tt")) {
        out.extend(mdblist_to_aggregate(imdb).await);
    }

    // ── Anime branch (MAL + AniList, anime only) ────────────────────────
    // Resolve a MAL id ONCE (it keys both Tenrai and AniList), then fetch
    // both ratings in parallel. Title resolution is the last resort —
    // its sequel/dub/movie-of-series heuristics occasionally mispick on
    // very generic names; worst case is a slightly-off score the user
    // can ignore.
    if input.is_anime {
        let mal: Option<u32> = if let Some(m) = input.mal_id {
            Some(m)
        } else if let Some(id) = input.kitsu_id {
            crate::aniskip::resolve_mal_id("kitsu".into(), id).await.ok().flatten()
        } else if let Some(id) = input.anilist_id {
            crate::aniskip::resolve_mal_id("anilist".into(), id).await.ok().flatten()
        } else if let Some(id) = input.anidb_id {
            crate::aniskip::resolve_mal_id("anidb".into(), id).await.ok().flatten()
        } else if let Some(title) = input.title.as_deref().filter(|s| !s.trim().is_empty()) {
            crate::aniskip::resolve_mal_id_by_title(title.to_string(), input.year)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        if let Some(mal) = mal {
            let (j, a) = tokio::join!(mal_for_mal_id(mal), anilist_for_mal(mal));
            out.extend(j);
            out.extend(a);
        }
    }

    // Stable sort by weight DESCENDING — highest-weighted source first
    // so DetailView's slice(0, N) renders the most valuable ratings.
    out.sort_by_key(|r| std::cmp::Reverse(r.weight));
    Ok(out)
}
