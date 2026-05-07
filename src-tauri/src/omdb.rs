// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! OMDb (omdbapi.com) bridge — supplements catalog/meta ratings with the
//! Rotten Tomatoes Tomatometer and the Metacritic Metascore. Both are
//! CRITIC scores; OMDb's free tier doesn't surface audience scores (those
//! sit behind Rotten Tomatoes' paid Fandango Audience Insights API and an
//! unofficial Metacritic endpoint).
//!
//! Free tier limits: 1,000 requests/day per key. We make at most one
//! request per DetailView open, so this is comfortably within budget.

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const OMDB_API: &str = "https://www.omdbapi.com/";
const TIMEOUT: Duration = Duration::from_secs(10);
const USER_AGENT: &str = "Aura/0.6.7";

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .user_agent(USER_AGENT)
            .build()
            .expect("OMDb HTTP client init failed")
    })
}

#[derive(Clone, Serialize)]
pub struct OmdbRating {
    /// Display label, e.g. "Rotten Tomatoes" / "Metacritic" / "IMDb".
    pub source: String,
    /// Raw OMDb-supplied value, e.g. "94%" / "85/100" / "8.1/10".
    pub value: String,
}

#[derive(Deserialize)]
struct OmdbRawRating {
    #[serde(rename = "Source")]
    source: String,
    #[serde(rename = "Value")]
    value: String,
}

#[derive(Deserialize)]
struct OmdbRawResponse {
    #[serde(rename = "Response", default)]
    response: String,
    #[serde(rename = "Error", default)]
    error: Option<String>,
    #[serde(rename = "Ratings", default)]
    ratings: Vec<OmdbRawRating>,
    /// Sometimes OMDb omits Ratings but includes a top-level Metascore.
    #[serde(rename = "Metascore", default)]
    metascore: Option<String>,
    /// Same with imdbRating — surfacing it as a fallback.
    #[serde(rename = "imdbRating", default)]
    imdb_rating: Option<String>,
}

/// Fetch the rating set for a given IMDb-prefixed id (`tt0903747`). Returns
/// an empty list when no key is configured or OMDb has no record. Never
/// surfaces an `Err` — this is a "nice to have" enrichment and shouldn't
/// block the DetailView when the network is flaky.
///
/// Reads the OMDb API key from `AppSettings::omdb_api_key`. Empty string
/// = OMDb lookups disabled (return early with no ratings). Settings ships
/// a default shared key so first-run installs work out of the box; users
/// can replace it with their own private key in Settings → API keys.
#[tauri::command]
pub async fn fetch_omdb_ratings(imdb_id: String) -> Result<Vec<OmdbRating>, String> {
    if !imdb_id.starts_with("tt") {
        // OMDb only knows IMDb ids — anime / kitsu / tmdb prefixes can't
        // be mapped without an extra lookup, which is out of scope here.
        return Ok(vec![]);
    }

    let key = crate::settings::snapshot().omdb_api_key.trim().to_string();
    if key.is_empty() {
        crate::devlog!(info, "omdb", "skipped — no OMDb API key configured");
        return Ok(vec![]);
    }

    let url = format!("{OMDB_API}?apikey={key}&i={imdb_id}&r=json&tomatoes=true");
    crate::devlog!(info, "omdb", "GET {url}", url = url.replace(key.as_str(), "***"));

    let resp = match client().get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "omdb", "request failed: {e}");
            return Ok(vec![]);
        }
    };
    let resp = match resp.error_for_status() {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "omdb", "HTTP error: {e}");
            return Ok(vec![]);
        }
    };

    let body: OmdbRawResponse = match resp.json().await {
        Ok(b) => b,
        Err(e) => {
            crate::devlog!(warn, "omdb", "parse error: {e}");
            return Ok(vec![]);
        }
    };

    if body.response.eq_ignore_ascii_case("False") {
        crate::devlog!(
            info, "omdb",
            "no record for {imdb_id}: {}",
            body.error.as_deref().unwrap_or(""),
        );
        return Ok(vec![]);
    }

    let mut out: Vec<OmdbRating> = Vec::new();

    // OMDb canonical ratings array. Normalise the source labels so the
    // DetailView can group / colour them.
    for r in body.ratings.iter() {
        if r.value.is_empty() || r.value.eq_ignore_ascii_case("N/A") {
            continue;
        }
        let label = match r.source.as_str() {
            "Internet Movie Database" => "IMDb",
            "Rotten Tomatoes"         => "Rotten Tomatoes",
            "Metacritic"              => "Metacritic",
            other                     => other,
        };
        out.push(OmdbRating {
            source: label.to_string(),
            value:  r.value.clone(),
        });
    }

    // Backfill from scalar fields if Ratings was empty for some reason.
    if !out.iter().any(|r| r.source == "Metacritic") {
        if let Some(m) = body.metascore.as_deref().filter(|v| *v != "N/A" && !v.is_empty()) {
            out.push(OmdbRating { source: "Metacritic".into(), value: format!("{m}/100") });
        }
    }
    if !out.iter().any(|r| r.source == "IMDb") {
        if let Some(i) = body.imdb_rating.as_deref().filter(|v| *v != "N/A" && !v.is_empty()) {
            out.push(OmdbRating { source: "IMDb".into(), value: format!("{i}/10") });
        }
    }

    crate::devlog!(info, "omdb", "{imdb_id} → {} rating(s)", out.len());
    Ok(out)
}
