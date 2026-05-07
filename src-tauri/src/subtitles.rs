// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_libmpv::MpvExt;

use crate::settings;

// ---------------------------------------------------------------------------
// OpenSubtitles bridge — api.opensubtitles.com REST v1
//
// All requests require an Api-Key header (configurable in Settings → Subtitles).
// Free tier allows 20 downloads / day. We never send credentials over HTTP.
//
// Flow:
//   1. search_subtitles(query, year?, imdb_id?, languages)  → [SubtitleEntry]
//   2. download_subtitle(file_id)                            → local .srt path
//   3. add_subtitle_to_mpv(path)                             → injects via sub-add
//
// All IO is best-effort: search/download failures are surfaced as Err strings
// the frontend can show in a toast, never as panics.
// ---------------------------------------------------------------------------

const OS_API: &str = "https://api.opensubtitles.com/api/v1";
const TIMEOUT: Duration = Duration::from_secs(20);
const USER_AGENT: &str = "Aura v0.1";

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
            .expect("OS HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
pub struct SubtitleEntry {
    /// OpenSubtitles file_id (used for download lookup).
    pub file_id: i64,
    pub release: String,
    pub language: String,
    pub feature_title: String,
    /// HD/CD count, often signals format quality.
    pub fps: Option<f64>,
    pub download_count: Option<i64>,
    pub hearing_impaired: bool,
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn search_subtitles(
    query: Option<String>,
    year: Option<i32>,
    imdb_id: Option<String>,
    languages: Option<String>,
) -> Result<Vec<SubtitleEntry>, String> {
    let cfg = settings::snapshot();
    if cfg.opensubtitles_api_key.trim().is_empty() {
        return Err("OpenSubtitles API key not configured".into());
    }

    let mut params: Vec<(&str, String)> = Vec::new();
    if let Some(q) = query.as_ref().filter(|s| !s.is_empty()) {
        params.push(("query", q.clone()));
    }
    if let Some(y) = year {
        params.push(("year", y.to_string()));
    }
    if let Some(id) = imdb_id.as_ref().filter(|s| !s.is_empty()) {
        // OpenSubtitles wants the numeric portion of "tt1234567"
        let numeric = id.trim_start_matches("tt").trim_start_matches('0');
        if !numeric.is_empty() {
            params.push(("imdb_id", numeric.to_string()));
        }
    }
    let langs = languages.unwrap_or_else(|| "en".to_string());
    params.push(("languages", langs));

    let url = format!("{OS_API}/subtitles");
    let raw = client()
        .get(&url)
        .header("Api-Key", cfg.opensubtitles_api_key.as_str())
        .query(&params)
        .send()
        .await
        .map_err(|e| format!("OpenSubtitles network error: {e}"))?
        .error_for_status()
        .map_err(|e| format!("OpenSubtitles HTTP error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("OpenSubtitles read error: {e}"))?;

    parse_search_response(&raw)
}

fn parse_search_response(raw: &str) -> Result<Vec<SubtitleEntry>, String> {
    let json: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("OpenSubtitles parse error: {e}"))?;

    let data = json
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "OpenSubtitles response missing data".to_string())?;

    let mut out = Vec::with_capacity(data.len().min(50));
    for item in data.iter().take(50) {
        let attrs = match item.get("attributes") {
            Some(a) => a,
            None => continue,
        };
        let files = attrs.get("files").and_then(|v| v.as_array());
        let file_id = files
            .and_then(|arr| arr.first())
            .and_then(|f| f.get("file_id"))
            .and_then(|v| v.as_i64());
        let Some(file_id) = file_id else { continue };

        out.push(SubtitleEntry {
            file_id,
            release: attrs
                .get("release")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            language: attrs
                .get("language")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            feature_title: attrs
                .pointer("/feature_details/title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            fps: attrs.get("fps").and_then(|v| v.as_f64()),
            download_count: attrs.get("download_count").and_then(|v| v.as_i64()),
            hearing_impaired: attrs
                .get("hearing_impaired")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Download — request a single-use URL, GET it, write to app_data_dir
// ---------------------------------------------------------------------------

fn subtitles_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("subtitles");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
pub async fn download_subtitle<R: Runtime>(
    app: AppHandle<R>,
    file_id: i64,
) -> Result<String, String> {
    let cfg = settings::snapshot();
    if cfg.opensubtitles_api_key.trim().is_empty() {
        return Err("OpenSubtitles API key not configured".into());
    }

    // Step 1: ask OpenSubtitles for a download link
    let body = serde_json::json!({ "file_id": file_id });
    let raw = client()
        .post(format!("{OS_API}/download"))
        .header("Api-Key", cfg.opensubtitles_api_key.as_str())
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download HTTP error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Download read error: {e}"))?;

    let json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Download parse error: {e}"))?;
    let link = json
        .get("link")
        .and_then(|v| v.as_str())
        .ok_or("Download link missing in response")?;
    let file_name = json
        .get("file_name")
        .and_then(|v| v.as_str())
        .map(|s| sanitize_filename(s))
        .unwrap_or_else(|| format!("{file_id}.srt"));

    // Step 2: GET the link directly
    let bytes = client()
        .get(link)
        .send()
        .await
        .map_err(|e| format!("Subtitle fetch failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Subtitle HTTP error: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("Subtitle read error: {e}"))?;

    // Step 3: write to subtitles cache dir
    let dest = subtitles_dir(&app)?.join(&file_name);
    std::fs::write(&dest, &bytes).map_err(|e| format!("Subtitle write error: {e}"))?;

    Ok(dest.to_string_lossy().into_owned())
}

/// Strip path components and dangerous chars from a server-supplied filename.
fn sanitize_filename(name: &str) -> String {
    let just_name = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let cleaned: String = just_name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .take(180)
        .collect();
    if cleaned.is_empty() {
        "subtitle.srt".into()
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// Inject — pipe a subtitle file into the live MPV instance
// ---------------------------------------------------------------------------

/// `flag` matches MPV's sub-add semantics:
///   • "select" — add and make active (used by the explicit Subtitles picker)
///   • "auto"   — add without making active (used for bulk auto-injection)
///   • "cached" — add only if not already loaded (idempotent)
/// Defaults to "select" if not provided.
///
/// `title` and `lang` are forwarded as the optional 3rd/4th sub-add
/// arguments. Without them, MPV auto-titles the track from the file
/// path — for HTTPS subtitle URLs this surfaces as a meaningless string
/// of digits (e.g. the OpenSubtitles `file_id` segment) in the track
/// menu. Passing a friendly title lets us show "OpenSubtitles · ENG" in
/// the dropdown instead, and lets the deduplication logic match by
/// title across the embedded/external split.
#[tauri::command]
pub async fn add_subtitle_to_mpv(
    app: AppHandle,
    path: String,
    flag: Option<String>,
    title: Option<String>,
    lang: Option<String>,
) -> Result<(), String> {
    let normalised = path.replace('\\', "/");
    let mode = flag.unwrap_or_else(|| "select".into());
    tauri::async_runtime::spawn_blocking(move || {
        let mut args: Vec<serde_json::Value> = vec![
            serde_json::json!(normalised),
            serde_json::json!(mode),
        ];
        // `sub-add <file> <flags> <title> <lang>` — positional. We must
        // pass title (even if empty) before lang, otherwise MPV interprets
        // `lang` as the title.
        if title.is_some() || lang.is_some() {
            args.push(serde_json::json!(title.unwrap_or_default()));
            if let Some(lang_str) = lang {
                args.push(serde_json::json!(lang_str));
            }
        }
        app.mpv()
            .command("sub-add", &args, "main")
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
