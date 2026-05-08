// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! OAuth token storage for the direct Trakt + AniList scrobble path.
//!
//! Tokens are stored in the OS keyring (Windows Credential Manager /
//! macOS Keychain / Linux Secret Service) keyed by Stremio account so a
//! user logging into a different Stremio account on the same machine
//! gets a separate (or absent) Trakt / AniList connection rather than
//! inheriting the previous account's tokens. The keyring service name
//! is `aura`; the entry user name follows the pattern
//! `<service>-<scope>` where service is `trakt` / `anilist` and scope
//! is the first 12 chars of the Stremio auth_key (or `guest`).
//!
//! Token shape on disk: a small JSON object with access_token,
//! refresh_token, expires_at (unix seconds), and a cached display
//! username so the Settings UI can render "Connected as <user>"
//! without an API round-trip.
//!
//! The actual OAuth flow lives in a VPS proxy at
//! `https://aura.animasec.dev/oauth/{trakt,anilist}/callback` that
//! exchanges the authorization code for a token and redirects back to
//! `aura://oauth/{trakt,anilist}?...` — Aura's deep-link handler picks
//! up the params and calls `set_scrobble_auth_token` here.

use serde::{Deserialize, Serialize};
use tauri::Runtime;

const KEYRING_SERVICE: &str = "aura";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScrobbleAuthToken {
    pub access_token:  String,
    pub refresh_token: Option<String>,
    /// Unix seconds at which the access_token expires. `None` for
    /// providers that issue non-expiring tokens (AniList's Implicit
    /// Grant flow being the canonical case).
    pub expires_at:    Option<u64>,
    /// Cached display name from the provider's `me` endpoint. Surfaces
    /// in the Settings UI as "Connected as <username>" without a
    /// network round-trip on every render.
    pub username:      Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScrobbleAuthStatus {
    pub trakt:   Option<ScrobbleAuthSummary>,
    pub anilist: Option<ScrobbleAuthSummary>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScrobbleAuthSummary {
    pub username: Option<String>,
    pub expires_at: Option<u64>,
    /// True iff the access_token expires within the next 60 s. The
    /// frontend uses this to surface a "Reconnect to refresh" hint
    /// without firing a refresh-token round-trip on every render.
    pub stale: bool,
}

fn keyring_user(service: &str, scope: &str) -> String {
    format!("{service}-{scope}")
}

fn entry(service: &str, scope: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, &keyring_user(service, scope))
        .map_err(|e| e.to_string())
}

fn read_token(service: &str, scope: &str) -> Option<ScrobbleAuthToken> {
    let e = entry(service, scope).ok()?;
    let raw = e.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

fn summarise(token: Option<ScrobbleAuthToken>) -> Option<ScrobbleAuthSummary> {
    let token = token?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stale = match token.expires_at {
        Some(exp) => exp <= now + 60,
        None => false,
    };
    Some(ScrobbleAuthSummary {
        username:   token.username.clone(),
        expires_at: token.expires_at,
        stale,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read the connection summary for both providers in one call. Used by
/// the Settings UI to render the Trakt + AniList rows without firing
/// two separate IPC round-trips. `scope` is the first 12 chars of the
/// active Stremio auth_key (or the literal "guest" when signed out).
#[tauri::command]
pub async fn get_scrobble_auth_status(scope: String) -> Result<ScrobbleAuthStatus, String> {
    Ok(ScrobbleAuthStatus {
        trakt:   summarise(read_token("trakt",   &scope)),
        anilist: summarise(read_token("anilist", &scope)),
    })
}

/// Persist a token coming back from the VPS OAuth proxy. Called by
/// the deep-link handler when `aura://oauth/{service}?...` arrives.
/// Replaces any existing token for that (service, scope) pair.
#[tauri::command]
pub async fn set_scrobble_auth_token(
    service: String,
    scope:   String,
    access_token:  String,
    refresh_token: Option<String>,
    expires_at:    Option<u64>,
    username:      Option<String>,
) -> Result<(), String> {
    if !["trakt", "anilist"].contains(&service.as_str()) {
        return Err(format!("unknown scrobble service: {service}"));
    }
    let token = ScrobbleAuthToken { access_token, refresh_token, expires_at, username };
    let json = serde_json::to_string(&token).map_err(|e| e.to_string())?;
    entry(&service, &scope)?
        .set_password(&json)
        .map_err(|e| e.to_string())?;
    crate::devlog!(
        info, "scrobble",
        "stored {service} token for scope={} (user={:?})",
        scope, token.username,
    );
    Ok(())
}

/// Drop the stored token for a (service, scope) pair. Used by the
/// "Disconnect" button in the Settings UI.
#[tauri::command]
pub async fn clear_scrobble_auth_token(
    service: String,
    scope:   String,
) -> Result<(), String> {
    if !["trakt", "anilist"].contains(&service.as_str()) {
        return Err(format!("unknown scrobble service: {service}"));
    }
    let e = entry(&service, &scope)?;
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {
            crate::devlog!(info, "scrobble", "cleared {service} token for scope={scope}");
            Ok(())
        }
        Err(err) => Err(err.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Internal accessor for scrobble.rs — fetches the access_token if any.
// Returned values: (access_token, expires_at). `None` means "no
// authenticated session for this provider in this scope".
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn token_for<R: Runtime>(_app: &tauri::AppHandle<R>, service: &str, scope: &str)
    -> Option<ScrobbleAuthToken>
{
    read_token(service, scope)
}

// ---------------------------------------------------------------------------
// OAuth authorize URL helpers — give the frontend the right URL to
// open in the user's default browser. Hosting the redirect endpoint
// at https://aura.animasec.dev/oauth/{service}/callback is the user's
// responsibility (see VPS setup prompt).
// ---------------------------------------------------------------------------

const TRAKT_CLIENT_ID: &str =
    "972708314725cf99c75e8abc66d05e2664e466f4181a2fd14198e346e4bc7379";
const ANILIST_CLIENT_ID: &str = "40808";
const REDIRECT_BASE: &str = "https://aura.animasec.dev/oauth";

/// Build the authorize URL the user's browser should open. The
/// `state` query param round-trips the Stremio scope so the VPS
/// callback knows which keyring entry to write into when it deep-
/// links back to Aura.
#[tauri::command]
pub fn scrobble_oauth_authorize_url(service: String, scope: String) -> Result<String, String> {
    let scope_enc = urlencoding(&scope);
    match service.as_str() {
        "trakt" => Ok(format!(
            "https://trakt.tv/oauth/authorize?\
              response_type=code\
              &client_id={cid}\
              &redirect_uri={redir}/trakt/callback\
              &state={state}",
            cid = TRAKT_CLIENT_ID,
            redir = urlencoding(REDIRECT_BASE),
            state = scope_enc,
        )),
        "anilist" => Ok(format!(
            "https://anilist.co/api/v2/oauth/authorize?\
              client_id={cid}\
              &redirect_uri={redir}/anilist/callback\
              &response_type=code\
              &state={state}",
            cid = ANILIST_CLIENT_ID,
            redir = urlencoding(REDIRECT_BASE),
            state = scope_enc,
        )),
        _ => Err(format!("unknown scrobble service: {service}")),
    }
}

/// Tiny inline percent-encoder — avoids pulling in `urlencoding` for
/// just two query params. Encodes EVERY non-alphanumeric byte except
/// `-_.~` per RFC 3986 unreserved set, which is what OAuth providers
/// expect for `state` / `redirect_uri`.
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}
