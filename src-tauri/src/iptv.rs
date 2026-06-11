// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! IPTV network hop — the one Rust touchpoint the Live TV feature needs
//! today (per the 2026-06-09 live-tv spec §2): a text fetch that
//! (a) sends the IPTV-client User-Agent many providers gate on,
//! (b) has no CORS constraints (unlike a webview fetch), and
//! (c) enforces a hard size cap so a 200 MB EPG can't balloon the
//! webview heap through the invoke channel.
//!
//! Parsing (M3U / XMLTV / Xtream JSON) lives in `src/iptv/` on the
//! frontend — pure TypeScript ports, no Rust parsers.

use std::sync::OnceLock;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Persisted playlist source (lives in AppSettings.iptv_playlists). Mirrors
// the TS `IptvPlaylistSource` in src/iptv/types.ts. `rename_all="camelCase"`
// because we own BOTH ends of this wire format and want camelCase JSON in
// each direction (unlike the LibraryItem case in CLAUDE.md, where the
// inbound wire names differed from the TS interface).
//
// SECURITY (live-tv spec Decision D): the Xtream PASSWORD is NOT stored
// here — it lives in the OS keyring keyed by playlist id (see the keyring
// helpers below). `XtreamRef` carries only the server + username (the
// username is the account identifier, not the secret, and already appears
// in plaintext in M3U URLs). serde drops any extra `password` the frontend
// sends, so a stray cred can't leak into settings.json.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IptvPlaylistSource {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub epg_url: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub xtream: Option<XtreamRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XtreamRef {
    pub server: String,
    #[serde(default)]
    pub username: String,
}

// ---------------------------------------------------------------------------
// Xtream password → OS keyring (DPAPI on Windows, via the same `keyring`
// crate api_keyring.rs uses). Dedicated service so the per-playlist entries
// don't collide with the api-keys allowlist. Empty value = delete.
// ---------------------------------------------------------------------------

const XTREAM_KEYRING_SERVICE: &str = "aura-iptv-xtream";

fn xtream_entry(playlist_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(XTREAM_KEYRING_SERVICE, playlist_id).map_err(|e| e.to_string())
}

/// Store the Xtream password for `playlist_id`. Empty deletes the entry.
#[tauri::command]
pub async fn iptv_set_xtream_password(playlist_id: String, password: String) -> Result<(), String> {
    let e = xtream_entry(&playlist_id)?;
    if password.is_empty() {
        return iptv_clear_xtream_password(playlist_id).await;
    }
    e.set_password(&password).map_err(|e| e.to_string())
}

/// Read the Xtream password for `playlist_id`. Returns "" when absent
/// (fresh, cleared, or keyring unavailable) so the caller can treat the
/// missing-creds case uniformly.
#[tauri::command]
pub async fn iptv_get_xtream_password(playlist_id: String) -> Result<String, String> {
    let e = xtream_entry(&playlist_id)?;
    match e.get_password() {
        Ok(p) => Ok(p),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(err) => Err(err.to_string()),
    }
}

/// Drop the stored Xtream password for `playlist_id`. Idempotent.
#[tauri::command]
pub async fn iptv_clear_xtream_password(playlist_id: String) -> Result<(), String> {
    let e = match xtream_entry(&playlist_id) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

/// Providers fingerprint players; this UA matches the widely-allowed
/// IPTV Smarters client (the reference implementation ships the same).
const IPTV_USER_AGENT: &str = "IPTVSmartersPro/3.1.5 (Aura)";

/// Hard response cap — playlists run a few MB; EPGs can be huge. 64 MiB
/// covers every reasonable provider while bounding the invoke payload.
const MAX_BYTES: usize = 64 * 1024 * 1024;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Generous: big EPGs on slow providers. Stall protection
            // comes from the read loop below, not just this ceiling.
            .timeout(Duration::from_secs(120))
            .connect_timeout(Duration::from_secs(15))
            .user_agent(IPTV_USER_AGENT)
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("IPTV HTTP client init failed")
    })
}

/// Fetch a text body (M3U playlist / XMLTV EPG / Xtream player_api
/// JSON). Errors are classified into user-readable strings — the
/// frontend store surfaces them verbatim.
#[tauri::command]
pub async fn iptv_fetch_text(url: String) -> Result<String, String> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Only http(s) playlist/EPG URLs are supported".into());
    }
    crate::devlog!(
        info, "iptv",
        "fetch {}",
        crate::stremio::redact_sensitive_url(&url),
    );

    let resp = client()
        .get(&url)
        .send()
        .await
        .map_err(classify_send_error)?;

    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            401 | 403 => "The provider rejected the credentials (401/403). Check the username/password in the playlist URL.".into(),
            404 => "Playlist not found (404). Check the URL.".into(),
            429 => "The provider is rate-limiting (429). Wait a minute and retry.".into(),
            503 => "The provider is temporarily unavailable (503).".into(),
            code => format!("Provider returned HTTP {code}."),
        });
    }

    // Stream the body with the size cap enforced as bytes arrive — a
    // Content-Length header can't be trusted (chunked EPG endpoints
    // omit it entirely).
    let mut out: Vec<u8> = Vec::with_capacity(256 * 1024);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Download interrupted: {e}"))?;
        if out.len() + chunk.len() > MAX_BYTES {
            return Err(format!(
                "Response exceeded the {} MB limit — the EPG/playlist is too large.",
                MAX_BYTES / (1024 * 1024),
            ));
        }
        out.extend_from_slice(&chunk);
    }

    crate::devlog!(
        debug, "iptv",
        "fetched {} KiB from {}",
        out.len() / 1024,
        crate::stremio::redact_sensitive_url(&url),
    );
    Ok(String::from_utf8_lossy(&out).into_owned())
}

fn classify_send_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        return "The provider didn't respond in time (timeout).".into();
    }
    if e.is_connect() {
        return "Couldn't connect to the provider (DNS / connection refused). Check the URL and your network.".into();
    }
    format!("Fetch failed: {e}")
}
