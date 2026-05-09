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
//! `https://aura.animasec.dev/oauth/{trakt,anilist}/start`. Aura
//! opens that URL in the system browser; the proxy generates a CSRF
//! state, caches it for 5 min, and 302s to the provider's authorize
//! URL with that state attached. After the user authorizes, the
//! provider redirects back to the proxy's `/oauth/{provider}`
//! callback (the redirect_uri registered in each provider dashboard),
//! which validates state, exchanges the code for a token using the
//! `client_secret` it holds in env, and 302s to
//! `aura://oauth/{provider}?token=...&refresh=...&expires=...`. The
//! deep-link handler in App.tsx picks up the params and calls
//! `set_scrobble_auth_token` here.

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
// Internal accessors — used by scrobble.rs to fetch tokens for direct
// Trakt / AniList API calls. The Runtime-typed wrapper exists so
// callers from a tauri command context can pass &AppHandle without
// caring about generics; the bare `read_token_for` is what scrobble.rs
// uses from non-tauri contexts (shutdown_blocking, etc.).
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub fn token_for<R: Runtime>(_app: &tauri::AppHandle<R>, service: &str, scope: &str)
    -> Option<ScrobbleAuthToken>
{
    read_token(service, scope)
}

/// Read the stored token for `(service, scope)`. Returns None if no
/// token is stored or the keyring entry can't be deserialised.
pub fn read_token_for(service: &str, scope: &str) -> Option<ScrobbleAuthToken> {
    read_token(service, scope)
}

/// Wipe the stored token for `(service, scope)`. Called from scrobble.rs
/// when an API request comes back 401, so the Settings UI re-prompts
/// instead of silently failing every subsequent call. Idempotent — a
/// missing entry is treated as success.
pub fn clear_token_for(service: &str, scope: &str) {
    if let Ok(e) = entry(service, scope) {
        let _ = e.delete_credential();
    }
}

// ---------------------------------------------------------------------------
// Provider constants — the bits that DO live in the desktop binary
// (per the integration doc, §5: client_id is fine to embed; only
// client_secret has to stay on the proxy).
// ---------------------------------------------------------------------------

/// Trakt client_id — required as the `trakt-api-key` header on every
/// Trakt API call. The matching client_secret is held by the OAuth
/// proxy in env (`TRAKT_CLIENT_SECRET`); the desktop never sees it.
pub const TRAKT_CLIENT_ID: &str =
    "6005fd2f46b73d6fdf40547c34af33acd2d2aeed1df73c9601fbac4634a40a9c";

// ---------------------------------------------------------------------------
// OAuth authorize URL helpers — give the frontend the right URL to
// open in the user's default browser.
// ---------------------------------------------------------------------------

/// Base URL of the OAuth proxy's `/oauth` namespace. The proxy owns
/// every provider-specific concern (client_secret, authorize URL
/// shape, state generation, code exchange); Aura just opens
/// `<base>/<service>/start` and waits for the deep-link.
const REDIRECT_BASE: &str = "https://aura.animasec.dev/oauth";

/// Return the URL the user's browser should open to begin the OAuth
/// flow. This is NOT the provider's authorize URL — it's the proxy's
/// `/start` endpoint, which generates and caches a CSRF state, then
/// 302s to the provider's authorize URL with that state attached.
///
/// Earlier builds had Aura build the provider's authorize URL itself
/// and pass its own state value; the proxy then rejected every
/// callback as `state-mismatch` because it never put that state into
/// its cache. Owning state generation server-side is what the proxy
/// is structured for (`startTrakt` / `startAnilist` in main.go), and
/// it keeps Aura ignorant of the per-provider URL shapes — adding a
/// third provider becomes a proxy-only change.
#[tauri::command]
pub fn scrobble_oauth_authorize_url(service: String) -> Result<String, String> {
    if !["trakt", "anilist"].contains(&service.as_str()) {
        return Err(format!("unknown scrobble service: {service}"));
    }
    Ok(format!("{REDIRECT_BASE}/{service}/start"))
}
