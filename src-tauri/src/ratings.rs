// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Multi-source ratings aggregator.
//
// Folds OMDb (IMDb / Rotten Tomatoes critic / Metacritic critic) and
// Jikan (MyAnimeList score, weighted score, popularity rank) into a
// single normalized list the DetailView renders. OMDb stays optional —
// no API key = no IMDb / RT / Metacritic, but Jikan still lights up for
// anime, and addon-supplied ratings still render alongside.
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
//   • OMDb (omdbapi.com)             — IMDb, Rotten Tomatoes critic,
//                                       Metacritic critic. User-supplied
//                                       free key.
//   • Jikan (api.jikan.moe v4)       — MyAnimeList score (anime only),
//                                       no key needed, 3 req/sec ceiling.
//
// Output shape: `AggregateRating { source, value, weight, kind, badge_color }`
// — the frontend doesn't need to know how each value was sourced; it
// just renders whatever lands in the array.
// ---------------------------------------------------------------------------

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const JIKAN_API: &str = "https://api.jikan.moe/v4";
const TIMEOUT: Duration = Duration::from_secs(10);

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
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
// OMDb branch — wraps the existing fetch_omdb_ratings in this module's
// shape so callers can hit one entry point.
// ---------------------------------------------------------------------------

async fn omdb_to_aggregate(imdb_id: &str) -> Vec<AggregateRating> {
    let raw = match crate::omdb::fetch_omdb_ratings(imdb_id.to_string()).await {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    raw.into_iter()
        .map(|r| {
            let weight = match r.source.as_str() {
                "IMDb"            => 100,
                "Rotten Tomatoes" => 90,
                "Metacritic"      => 80,
                _                  => 50,
            };
            AggregateRating {
                source: r.source,
                value: r.value,
                kind: "critic".into(),
                weight,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Jikan (MyAnimeList) branch
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct JikanFullData {
    score: Option<f64>,
    /// Number of users who rated. Useful for "x.x ★ from N users" UI.
    #[allow(dead_code)]
    scored_by: Option<u64>,
    rank: Option<u32>,
    popularity: Option<u32>,
    members: Option<u64>,
}

#[derive(Deserialize)]
struct JikanFullEnvelope {
    data: Option<JikanFullData>,
}

async fn jikan_for_mal_id(mal_id: u32) -> Vec<AggregateRating> {
    let url = format!("{JIKAN_API}/anime/{mal_id}/full");
    let resp = match client().get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "ratings", "jikan request failed: {e}");
            return Vec::new();
        }
    };
    let resp = match resp.error_for_status() {
        Ok(r) => r,
        Err(e) => {
            // 404 here usually means the MAL id doesn't exist; quiet.
            if e.status().map(|s| s.as_u16()) != Some(404) {
                crate::devlog!(warn, "ratings", "jikan HTTP error: {e}");
            }
            return Vec::new();
        }
    };
    let env: JikanFullEnvelope = match resp.json().await {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(warn, "ratings", "jikan parse error: {e}");
            return Vec::new();
        }
    };
    let Some(data) = env.data else { return Vec::new(); };

    let mut out = Vec::new();
    if let Some(score) = data.score.filter(|v| *v > 0.0) {
        out.push(AggregateRating {
            source: "MyAnimeList".into(),
            value: format!("{score:.2}/10"),
            kind: "aggregate".into(),
            weight: 95,
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

/// Resolve an arbitrary anime id (kitsu, anilist, anidb) → MAL id and
/// fetch the Jikan rating block. Routes through the existing aniskip
/// resolver since it already knows the relations.yuna.moe mapping.
async fn jikan_via_resolved_mal(source: &str, id: u32) -> Vec<AggregateRating> {
    match crate::aniskip::resolve_mal_id(source.to_string(), id).await {
        Ok(Some(mal)) => jikan_for_mal_id(mal).await,
        Ok(None) | Err(_) => Vec::new(),
    }
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct AggregateInput {
    /// IMDb id when known (`tt0903747`). Populates OMDb branch.
    pub imdb_id: Option<String>,
    /// Numeric MAL id, when the caller already knows it (e.g. from
    /// AIOMetadata). Populates Jikan branch directly.
    pub mal_id: Option<u32>,
    /// Numeric Kitsu id; resolved → MAL → Jikan.
    pub kitsu_id: Option<u32>,
    /// Numeric AniList id; resolved → MAL → Jikan.
    pub anilist_id: Option<u32>,
    /// Numeric AniDB id; resolved → MAL → Jikan.
    pub anidb_id: Option<u32>,
    /// Title fallback for resolution by name when no numeric id
    /// resolved. Optional release year tightens the match.
    pub title: Option<String>,
    pub year: Option<u32>,
    /// True when the meta type is "anime" or genres include the anime
    /// signal. Gate for the Jikan branch — non-anime IMDb ids skip the
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

    // ── OMDb branch (IMDb / RT critic / Metacritic critic) ──────────────
    if let Some(imdb) = input.imdb_id.as_deref().filter(|s| s.starts_with("tt")) {
        out.extend(omdb_to_aggregate(imdb).await);
    }

    // ── Jikan / MAL branch (anime only) ─────────────────────────────────
    if input.is_anime {
        // Direct hit if the caller already has the MAL id.
        if let Some(mal) = input.mal_id {
            out.extend(jikan_for_mal_id(mal).await);
        } else if let Some(id) = input.kitsu_id {
            out.extend(jikan_via_resolved_mal("kitsu", id).await);
        } else if let Some(id) = input.anilist_id {
            out.extend(jikan_via_resolved_mal("anilist", id).await);
        } else if let Some(id) = input.anidb_id {
            out.extend(jikan_via_resolved_mal("anidb", id).await);
        } else if let Some(title) = input.title.as_deref().filter(|s| !s.trim().is_empty()) {
            // Title-based MAL resolution as a last resort. Less
            // reliable than id-based — the resolver has heuristics for
            // disambiguating sequels / dubs / movies-of-series, but it
            // will occasionally pick the wrong title for very generic
            // names. We accept that — the worst case is a slightly off
            // MAL score on the meta page, which the user can ignore.
            if let Ok(Some(mal)) = crate::aniskip::resolve_mal_id_by_title(
                title.to_string(), input.year,
            ).await {
                out.extend(jikan_for_mal_id(mal).await);
            }
        }
    }

    // Stable sort by weight DESCENDING — highest-weighted source first
    // so DetailView's slice(0, N) renders the most valuable ratings.
    out.sort_by(|a, b| b.weight.cmp(&a.weight));
    Ok(out)
}
