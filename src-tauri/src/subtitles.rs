// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

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
// OpenSubtitles MovieHash — compute via Range GETs against the
// resolved stream URL. Algorithm (per opensubtitles.org wiki):
//
//   1. Read the first 64 KB of the file.
//   2. Read the last  64 KB of the file.
//   3. Treat each 64 KB block as 8 192 little-endian u64 values, sum
//      them (wrapping). Result is a single u64.
//   4. Add the file's total byte size to the running sum (wrapping).
//   5. Encode the resulting u64 as a 16-character zero-padded lowercase
//      hexadecimal string.
//
// Returned to the frontend alongside the file's byte size — both are
// required for OpenSubtitles' `moviehash` + `moviebytesize` query
// parameters.
// ---------------------------------------------------------------------------

const HASH_CHUNK_BYTES: u64 = 64 * 1024;

#[derive(Clone, Serialize)]
pub struct OpenSubtitlesHash {
    /// 16-char lowercase hex, zero-padded.
    pub hash: String,
    /// Total file size in bytes — feeds the `moviebytesize` parameter.
    pub bytesize: u64,
}

fn sum_chunk_as_u64(buf: &[u8]) -> u64 {
    let mut sum: u64 = 0;
    let mut i = 0;
    while i + 8 <= buf.len() {
        let val = u64::from_le_bytes([
            buf[i], buf[i + 1], buf[i + 2], buf[i + 3],
            buf[i + 4], buf[i + 5], buf[i + 6], buf[i + 7],
        ]);
        sum = sum.wrapping_add(val);
        i += 8;
    }
    sum
}

#[tauri::command]
pub async fn compute_opensubtitles_hash(url: String) -> Result<OpenSubtitlesHash, String> {
    if url.is_empty() {
        return Err("compute_opensubtitles_hash: empty url".into());
    }
    // Magnet / non-HTTP URLs aren't usable here — we'd need a torrent
    // engine to read the bytes, which Aura intentionally doesn't ship.
    // Bail early so the frontend skips the hash and falls back to
    // query-based search.
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("compute_opensubtitles_hash: only http(s) URLs supported".into());
    }

    // Discover the file size via Range: bytes=0-(CHUNK-1). The
    // Content-Range header in the 206 response carries the total size
    // as `bytes 0-N/TOTAL`. Cheaper than a HEAD (some debrid hosts
    // don't accept HEAD) and combines the first-chunk read with the
    // probe.
    let head_resp = client()
        .get(&url)
        .header("Range", format!("bytes=0-{}", HASH_CHUNK_BYTES - 1))
        .send()
        .await
        .map_err(|e| format!("hash: first-chunk request failed: {e}"))?;

    let status = head_resp.status();
    if status.as_u16() != 206 {
        return Err(format!(
            "hash: server doesn't honour Range requests (got {} for first-chunk)",
            status.as_u16()
        ));
    }
    let content_range = head_resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "hash: response missing Content-Range header".to_string())?
        .to_string();
    // `bytes 0-65535/87654321` → parse the `/TOTAL` tail.
    let total: u64 = content_range
        .split('/')
        .nth(1)
        .ok_or_else(|| format!("hash: malformed Content-Range '{content_range}'"))?
        .trim()
        .parse()
        .map_err(|e| format!("hash: bad total in Content-Range '{content_range}': {e}"))?;

    if total < HASH_CHUNK_BYTES * 2 {
        // Files smaller than 128 KB — the hash algorithm strictly
        // requires two non-overlapping 64 KB blocks. Edge case for
        // shorts / trailers; bail and let the frontend fall back to
        // query-based search.
        return Err(format!(
            "hash: file too small ({} bytes < 128 KB minimum)",
            total
        ));
    }

    let first_bytes = head_resp
        .bytes()
        .await
        .map_err(|e| format!("hash: first-chunk read failed: {e}"))?;
    if (first_bytes.len() as u64) < HASH_CHUNK_BYTES {
        return Err(format!(
            "hash: first chunk truncated ({} bytes < {} expected)",
            first_bytes.len(), HASH_CHUNK_BYTES
        ));
    }
    let first_sum = sum_chunk_as_u64(&first_bytes);

    // Last 64 KB via a second Range request. `bytes=(total - CHUNK)-(total - 1)`.
    let tail_start = total - HASH_CHUNK_BYTES;
    let last_resp = client()
        .get(&url)
        .header("Range", format!("bytes={tail_start}-{}", total - 1))
        .send()
        .await
        .map_err(|e| format!("hash: last-chunk request failed: {e}"))?;
    if last_resp.status().as_u16() != 206 {
        return Err(format!(
            "hash: server failed last-chunk Range (got {})",
            last_resp.status().as_u16()
        ));
    }
    let last_bytes = last_resp
        .bytes()
        .await
        .map_err(|e| format!("hash: last-chunk read failed: {e}"))?;
    if (last_bytes.len() as u64) < HASH_CHUNK_BYTES {
        return Err(format!(
            "hash: last chunk truncated ({} bytes < {} expected)",
            last_bytes.len(), HASH_CHUNK_BYTES
        ));
    }
    let last_sum = sum_chunk_as_u64(&last_bytes);

    let combined = first_sum.wrapping_add(last_sum).wrapping_add(total);
    let hex = format!("{combined:016x}");
    crate::devlog!(
        info, "subtitles",
        "OS hash computed: {hex} ({} bytes)", total
    );
    Ok(OpenSubtitlesHash { hash: hex, bytesize: total })
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
    /// True when OpenSubtitles flagged this entry as a MovieHash match
    /// against the supplied `moviehash` + `moviebytesize`. Hash-matched
    /// entries are frame-accurate to that specific release; the UI
    /// surfaces a "Hash match" badge so the user picks them first.
    /// False for entries that came back via query / IMDB / year
    /// matching, OR when no hash was supplied to the search.
    #[serde(default)]
    pub moviehash_match: bool,
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
    moviehash: Option<String>,
    moviebytesize: Option<u64>,
) -> Result<Vec<SubtitleEntry>, String> {
    // Keyring-first resolution, with settings.json fallback during the
    // migration window. Zeroizing wrapper wipes the in-process copy on
    // drop; deref &str inline for the header.
    let key_z = crate::api_keyring::resolve("opensubtitles")
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "OpenSubtitles API key not configured".to_string())?;
    let key: &str = &key_z;

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

    // OpenSubtitles' MovieHash matcher — when both `moviehash` and
    // `moviebytesize` are present, frame-accurate hash-matched results
    // bubble to the top of the response. Skipped silently when either
    // is missing or when the hash computation failed (we still fall
    // back to title / IMDB / year matching, which is what the function
    // does pre-hash).
    if let (Some(h), Some(size)) = (
        moviehash.as_ref().filter(|s| !s.is_empty()),
        moviebytesize.filter(|n| *n > 0),
    ) {
        params.push(("moviehash", h.clone()));
        params.push(("moviebytesize", size.to_string()));
    }

    let url = format!("{OS_API}/subtitles");
    let raw = client()
        .get(&url)
        .header("Api-Key", key)
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
            moviehash_match: attrs
                .get("moviehash_match")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        });
    }
    // Hash-matched entries are frame-accurate to the played file —
    // surface them first so the user picks them by default. Stable
    // sort preserves OpenSubtitles' original ordering within each
    // group (typically by download_count desc).
    out.sort_by_key(|e| std::cmp::Reverse(e.moviehash_match));
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
    let key_z = crate::api_keyring::resolve("opensubtitles")
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "OpenSubtitles API key not configured".to_string())?;
    let key: &str = &key_z;

    // Step 1: ask OpenSubtitles for a download link
    let body = serde_json::json!({ "file_id": file_id });
    let raw = client()
        .post(format!("{OS_API}/download"))
        .header("Api-Key", key)
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
        .map(sanitize_filename)
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
    // Path containment: external subtitles must be either remote
    // (http(s)) OR a file inside `app_data_dir()/subtitles` (the only
    // directory `download_subtitle` ever writes to). Without this guard
    // a renderer-side bug or a malicious addon could call sub-add with
    // an arbitrary local path (`C:\Users\…\id_rsa`) and have mpv read
    // it as a "subtitle stream", leaking file existence and size via
    // mpv property events. Other schemes (`file://`, `\\server\share`,
    // bare drive letters) are rejected.
    let is_remote =
        path.starts_with("http://") || path.starts_with("https://");
    if !is_remote {
        let subs_root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("subtitles");
        // canonicalize requires the path exist; if it doesn't, that's
        // already a reject. Same for the root.
        let canon_root = std::fs::canonicalize(&subs_root)
            .map_err(|e| format!("subtitle root not initialised: {e}"))?;
        let canon_path = std::fs::canonicalize(&path)
            .map_err(|e| format!("subtitle path not found: {e}"))?;
        if !canon_path.starts_with(&canon_root) {
            return Err(
                "subtitle path is outside the allowed downloads directory"
                    .to_string(),
            );
        }
    }
    let normalised = path.replace('\\', "/");
    let mode = flag.unwrap_or_else(|| "select".into());
    #[cfg(target_os = "windows")]
    {
        // `sub-add <file> <flags> <title> <lang>` — positional. We must
        // pass title (even if empty) before lang, otherwise MPV interprets
        // `lang` as the title.
        let mut args: Vec<String> = vec![
            "sub-add".into(),
            normalised,
            mode,
        ];
        if title.is_some() || lang.is_some() {
            args.push(title.unwrap_or_default());
            if let Some(lang_str) = lang {
                args.push(lang_str);
            }
        }
        crate::mpv::engine::submit_command(args)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (normalised, mode, title, lang);
        Err("playback engine is Windows-only".into())
    }
}
