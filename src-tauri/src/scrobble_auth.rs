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
//! `https://aura.animasec.dev/oauth/{trakt,anilist}`. Two paths are
//! supported:
//!
//!   • Trakt uses OAuth 2.0 device flow (RFC 8628). Aura calls the
//!     proxy's `/oauth/trakt/device/code` endpoint to get a short
//!     user_code + verification URL, opens the URL in the system
//!     browser, and polls `/oauth/trakt/device/token` until the user
//!     authorizes. No deep-link, no protocol scheme, no callback.
//!     Trakt issues both `access_token` and `refresh_token`.
//!
//!   • AniList uses authorization code flow (it does not expose a
//!     device-flow endpoint). Aura opens the proxy's
//!     `/oauth/anilist/start`; the proxy generates a CSRF state, 302s
//!     to AniList's authorize page, receives the callback at
//!     `/oauth/anilist`, exchanges the code (with `client_secret`
//!     held in env), and 302s to `aura://oauth/anilist?token=&expires=&user=`.
//!     The deep-link handler in App.tsx persists via
//!     `set_scrobble_auth_token`.
//!
//! IMPORTANT: AniList does NOT issue refresh tokens. Their access
//! tokens last 1 year, and the only way to renew is full re-auth
//! (the user has to click Connect again and walk through the auth
//! flow). Code paths that touch AniList must:
//!   • Never attempt a refresh-token round-trip (no endpoint exists).
//!   • Treat HTTP 401 / 403 from the GraphQL API as "token revoked
//!     or lapsed" — clear the keyring entry and surface a Reconnect
//!     prompt. Same code path as natural expiry; we don't try to
//!     distinguish revocation from expiry.
//!   • Never silently retry on 401/403 — that's a signal the user
//!     must intervene, not a transient blip.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl,
};
use tauri::webview::WebviewBuilder;

const KEYRING_SERVICE: &str = "aura";

// ---------------------------------------------------------------------------
// Log redaction
//
// OAuth callback URLs include long-lived bearer tokens in `token=` and
// `refresh=` query params. AniList's JWT specifically lasts a year and
// has no refresh endpoint — anyone who reads it from the log can
// impersonate the user against AniList for that entire window. Every
// site that logs an OAuth-bearing URL routes through this helper so a
// `cat aura-mpv.log` (or a copy-pasted DevConsole transcript) leaks
// only `token=<redacted>` instead of the live secret.
//
// The helper accepts the raw URL string (so callers don't need to
// thread through `url::Url`) and replaces only the value side of those
// two named params. Other query params (expires, user, …) round-trip
// unchanged because they're useful for debugging and don't carry
// secrets.
// ---------------------------------------------------------------------------

/// Redact `token=` and `refresh=` query-param values from a URL string
/// for safe logging. Non-OAuth URLs round-trip unchanged.
pub fn redact_oauth_url(raw: &str) -> String {
    // Split off the query string. If there isn't one, nothing to redact.
    let (head, query) = match raw.split_once('?') {
        Some(parts) => parts,
        None => return raw.to_string(),
    };
    let redacted: Vec<String> = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, _)) if k.eq_ignore_ascii_case("token") || k.eq_ignore_ascii_case("refresh")
                => format!("{k}=<redacted>"),
            _   => pair.to_string(),
        })
        .collect();
    format!("{head}?{}", redacted.join("&"))
}

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
    /// True when the access_token is approaching expiry but still
    /// usable. The threshold is provider-aware: AniList tokens last a
    /// year and have NO refresh path (the user must re-auth manually
    /// when the token finally lapses), so we warn 7 days ahead. Trakt
    /// tokens last 90 days; we warn 24 h ahead. The frontend renders
    /// this as a soft amber "reconnect when convenient" hint.
    pub stale: bool,
    /// True when `expires_at` has already passed. The frontend
    /// renders this as a hard red "expired, reconnect now" prompt
    /// because subsequent scrobble API calls will 401. Distinct from
    /// `stale` so the UI can use different visual urgency.
    pub expired: bool,
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

fn summarise(service: &str, token: Option<ScrobbleAuthToken>) -> Option<ScrobbleAuthSummary> {
    let token = token?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // Provider-specific warning window. AniList's tokens are 1 year
    // long with NO refresh endpoint — when they lapse, the only
    // option is to re-auth from scratch (full device-flow / browser
    // round-trip). 7 days of advance warning gives the user time to
    // notice and reconnect. Trakt's tokens are 90 days; 24 h warning
    // is plenty since Trakt does have refresh tokens (today they go
    // unused until the proxy adds a refresh endpoint, but the path
    // exists).
    let warn_window: u64 = match service {
        "anilist" => 7 * 24 * 3600,
        _         => 24 * 3600,
    };
    let stale = match token.expires_at {
        Some(exp) => exp > now && exp <= now + warn_window,
        None      => false,
    };
    let expired = match token.expires_at {
        Some(exp) => exp <= now,
        None      => false,
    };
    Some(ScrobbleAuthSummary {
        username:   token.username.clone(),
        expires_at: token.expires_at,
        stale,
        expired,
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
        trakt:   summarise("trakt",   read_token("trakt",   &scope)),
        anilist: summarise("anilist", read_token("anilist", &scope)),
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

    // Best-effort server-side revoke BEFORE dropping the local entry so
    // Trakt invalidates the token on their side too — otherwise a
    // "disconnected" token stays live on Trakt until its 90-day TTL.
    // Trakt-only: AniList exposes no revoke endpoint. Every failure is
    // swallowed inside `revoke_trakt_token`; the local clear below runs
    // regardless of whether the proxy/Trakt was reachable.
    if service == "trakt" {
        if let Some(tok) = read_token("trakt", &scope) {
            revoke_trakt_token(&tok.access_token).await;
        }
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

/// Host portion of `REDIRECT_BASE`. Kept as a separate const so the
/// in-app popup's `on_navigation` interceptor can string-compare
/// without parsing a URL on every navigation event. If the proxy ever
/// moves, both constants must be updated together.
const REDIRECT_BASE_HOST: &str = "aura.animasec.dev";

/// Best-effort host extraction for the popup's referrer-tracking logic.
/// A failed parse returns None — and a None prior host can never match
/// `REDIRECT_BASE_HOST`, so the intercept is rejected by default,
/// fail-closed.
fn parsed_host_of(raw: &str) -> Option<String> {
    Url::parse(raw).ok().and_then(|u| u.host_str().map(|h| h.to_string()))
}

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
/// `loopback` selects how the proxy should finish the flow:
///
///   * `Some(true)`  — the caller is about to open the user's DEFAULT
///     BROWSER, so the proxy must land on
///     `http://127.0.0.1:<port>/oauth/callback` (RFC 8252 §7.3). Plain
///     HTTP to loopback, so no browser blocks it and no OS scheme handler
///     is involved. A single-use nonce is minted and travels with the
///     request; `oauth_callback::handle` refuses any callback without it.
///   * `None` / `Some(false)` — the caller is about to open the IN-APP
///     popup webview, which intercepts the terminal `aura://oauth/<svc>`
///     navigation itself. Keeps the legacy contract intact for the popup
///     fallback path and for `NotificationsPanel`'s reconnect button.
///
/// Requesting loopback while the bridge is down is an error rather than a
/// silent downgrade: the caller needs to know to use the popup instead,
/// otherwise it would open a browser tab that can never come back.
#[tauri::command]
pub fn scrobble_oauth_authorize_url(
    service:  String,
    loopback: Option<bool>,
) -> Result<String, String> {
    if !["trakt", "anilist"].contains(&service.as_str()) {
        return Err(format!("unknown scrobble service: {service}"));
    }
    let base = format!("{REDIRECT_BASE}/{service}/start");
    if loopback != Some(true) {
        return Ok(base);
    }
    if !crate::streaming::is_running() {
        return Err(
            "the local callback listener is not running (port 11471 is in use \
             by another process); sign in inside Aura instead"
                .to_string(),
        );
    }
    let port  = crate::streaming::BRIDGE_PORT.to_string();
    let nonce = crate::oauth_callback::issue_nonce(&service);
    let url = Url::parse_with_params(
        &base,
        &[("redirect", "loopback"), ("port", port.as_str()), ("nonce", nonce.as_str())],
    )
    .map_err(|e| format!("failed to build authorize url: {e}"))?;
    crate::devlog!(
        info, "scrobble",
        "oauth start ({service}) → system browser, loopback callback on port {port}",
    );
    Ok(url.to_string())
}

// ---------------------------------------------------------------------------
// OAuth 2.0 device flow (RFC 8628)
//
// Trakt supports device flow as an alternative to authorization code, and
// device flow sidesteps the entire deep-link / scheme handler chain that
// Firefox was breaking on this build. Aura calls
// `scrobble_oauth_device_begin` to start, gets back a short user_code +
// verification_url to show the user, and polls
// `scrobble_oauth_device_poll` every `interval` seconds until the user
// authorizes on Trakt's site (or the code expires / is denied).
//
// AniList does NOT currently support device flow (their OAuth offers
// authorization-code + implicit grant only), so AniList stays on the
// `scrobble_oauth_authorize_url` + deep-link path. The commands below are
// generic enough that adding a new device-flow provider on the proxy is
// the only code change needed; the Rust side just routes by `service`.
//
// The proxy holds the `client_secret` for both endpoints. Aura only ever
// sees the `device_code` (a temporary value the proxy uses on Aura's
// behalf when polling Trakt's token endpoint).
// ---------------------------------------------------------------------------

/// Response from `POST /oauth/{service}/device/code`. Mirrors Trakt's
/// device-code response shape verbatim — the proxy passes it through
/// without modification.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DeviceFlowBegin {
    pub user_code:        String,
    pub verification_url: String,
    pub device_code:      String,
    /// Total seconds until the device_code expires. Trakt issues 600 s.
    pub expires_in:       u64,
    /// Recommended polling interval in seconds. Trakt issues 5 s.
    pub interval:         u64,
}

/// Result of a single device-flow poll. The frontend uses the
/// discriminant to drive UI transitions (continue polling, back off,
/// flip to Connected, surface an error). On `Authorized` the token is
/// already persisted in the keyring; the frontend just dispatches the
/// auth-changed event so Settings refreshes.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum DeviceFlowPoll {
    /// User clicked Allow on the provider site. Token persisted.
    Authorized { username: Option<String> },
    /// User hasn't acted yet. Continue polling at the same cadence.
    Pending,
    /// Polling too fast. Frontend should add ~5 s to the interval.
    SlowDown,
    /// device_code expired (>10 min for Trakt). User must restart.
    Expired,
    /// User clicked Deny on the provider site.
    Denied,
    /// Proxy / upstream returned an unexpected status. Treat as fatal
    /// for this attempt; the user can retry.
    Error { message: String },
}

fn device_flow_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .https_only(true)
        .timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " device-flow"))
        .build()
        .map_err(|e| e.to_string())
}

/// Begin a device-flow OAuth attempt. Returns the user-visible code +
/// verification URL plus the opaque device_code Aura uses to poll.
#[tauri::command]
pub async fn scrobble_oauth_device_begin(service: String) -> Result<DeviceFlowBegin, String> {
    if !["trakt", "anilist"].contains(&service.as_str()) {
        return Err(format!("unknown scrobble service: {service}"));
    }
    let url = format!("{REDIRECT_BASE}/{service}/device/code");
    let client = device_flow_client()?;
    let resp = client.post(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let status = resp.status();
        let _ = resp.text().await;
        return Err(format!("proxy returned {status}"));
    }
    let body: DeviceFlowBegin = resp.json().await.map_err(|e| e.to_string())?;
    crate::devlog!(
        info, "scrobble",
        "device-code issued for {service} (user_code={}, expires_in={})",
        body.user_code, body.expires_in,
    );
    Ok(body)
}

/// Poll the proxy with the device_code to check authorization status.
/// On success, persists the token to the keyring under (service, scope).
#[tauri::command]
pub async fn scrobble_oauth_device_poll(
    service:     String,
    scope:       String,
    device_code: String,
) -> Result<DeviceFlowPoll, String> {
    if !["trakt", "anilist"].contains(&service.as_str()) {
        return Err(format!("unknown scrobble service: {service}"));
    }
    let url = format!("{REDIRECT_BASE}/{service}/device/token");
    let client = device_flow_client()?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "device_code": device_code }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body_text = resp.text().await.map_err(|e| e.to_string())?;

    if status.is_success() {
        // Proxy augments Trakt's response with `expires_at` (absolute
        // unix seconds) and `username` (best-effort /users/me lookup).
        // We persist whatever's there; missing username just renders as
        // "Connected" without a name in the UI.
        #[derive(Deserialize)]
        struct SuccessBody {
            access_token:  String,
            #[serde(default)]
            refresh_token: Option<String>,
            #[serde(default)]
            expires_at:    Option<u64>,
            #[serde(default)]
            username:      Option<String>,
        }
        let body: SuccessBody = serde_json::from_str(&body_text)
            .map_err(|e| format!("decode success response: {e}"))?;

        let token = ScrobbleAuthToken {
            access_token:  body.access_token,
            refresh_token: body.refresh_token,
            expires_at:    body.expires_at,
            username:      body.username.clone(),
        };
        let json = serde_json::to_string(&token).map_err(|e| e.to_string())?;
        entry(&service, &scope)?
            .set_password(&json)
            .map_err(|e| e.to_string())?;

        crate::devlog!(
            info, "scrobble",
            "device-flow stored {service} token for scope={scope} (user={:?})",
            body.username,
        );
        return Ok(DeviceFlowPoll::Authorized { username: body.username });
    }

    // Error / pending paths. Two conventions to handle:
    //
    //   • Trakt uses HTTP status codes WITHOUT response bodies:
    //       400 = pending, 404 = unknown device_code,
    //       409 = already used, 410 = expired,
    //       418 = denied,  429 = slow_down.
    //
    //   • The RFC 8628 standard puts the state in the body:
    //       400 + {error: "authorization_pending"} = pending,
    //       400 + {error: "slow_down"}             = slow_down,
    //       400 + {error: "expired_token"}         = expired,
    //       400 + {error: "access_denied"}         = denied.
    //
    // We match status code first (Trakt's convention, since Trakt is the
    // only provider currently in the proxy's deviceFlowProviders) and
    // fall through to body parsing for unrecognised codes — which
    // covers any future provider using the standard format.
    #[derive(Deserialize)]
    struct ErrorBody {
        #[serde(default)]
        error: Option<String>,
    }
    let parsed: ErrorBody = serde_json::from_str(&body_text).unwrap_or(ErrorBody { error: None });
    let err_code = parsed.error.as_deref().unwrap_or("");

    let result = match status.as_u16() {
        400 if err_code.is_empty() || err_code == "authorization_pending" => DeviceFlowPoll::Pending,
        400 if err_code == "slow_down" => DeviceFlowPoll::SlowDown,
        400 if err_code == "expired_token" => DeviceFlowPoll::Expired,
        400 if err_code == "access_denied" => DeviceFlowPoll::Denied,
        404 => DeviceFlowPoll::Error { message: "device code not found".into() },
        409 => DeviceFlowPoll::Error { message: "code already used".into() },
        410 => DeviceFlowPoll::Expired,
        418 => DeviceFlowPoll::Denied,
        429 => DeviceFlowPoll::SlowDown,
        _ => {
            crate::devlog!(
                warn, "scrobble",
                "device-flow poll {service} unexpected status {status} body={}",
                body_text.chars().take(200).collect::<String>(),
            );
            DeviceFlowPoll::Error {
                message: format!("status {} ({})", status.as_u16(), err_code),
            }
        }
    };
    Ok(result)
}

// ---------------------------------------------------------------------------
// Trakt refresh-token flow
//
// Trakt's OAuth access tokens are 90-day-lived but the device-flow
// stores a `refresh_token` alongside. Earlier Aura builds never used it
// — on any 401 the keyring entry was just deleted and the user was
// re-prompted (roughly weekly in practice). The proxy now exposes
// `POST /oauth/trakt/refresh`, so scrobble.rs refreshes proactively
// (near expiry) and reactively (on a 401) instead of dropping the
// token.
//
// CONCURRENCY: Trakt rotates the refresh_token on every refresh and
// invalidates the previous one. Two concurrent 401s both calling the
// proxy with the SAME stored refresh_token would have the first
// rotation invalidate the token the second call carries — the second
// refresh then 401s and triggers a spurious full re-auth. The
// per-scope async mutex below serialises refreshes; after acquiring it
// the function re-reads the keyring, and if another task already
// rotated the token (the stored access_token now differs from the one
// the caller saw fail) it returns that fresh token without spending a
// second refresh.
//
// AniList has NO refresh endpoint and is deliberately untouched here.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// Per-Trakt-scope refresh lock registry. Each scope gets its own
/// `tokio::sync::Mutex`; the outer `std::sync::Mutex` only guards the
/// short map lookup/insert and is never held across an await.
fn refresh_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>
        = OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn refresh_lock_for(scope: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = refresh_locks().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(scope.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Why a Trakt refresh attempt failed. The caller (scrobble.rs) routes
/// on the discriminant:
///   • `NoRefreshToken` — nothing to refresh with; fall back to the old
///     clear-token-and-re-auth behaviour.
///   • `Rejected` — the proxy returned 401; the refresh_token is dead.
///     `refresh_trakt_token` has ALREADY cleared the keyring entry.
///   • `Transient` — 429 / 502 / 400 / network / decode error. The
///     stored token is untouched and still usable; the caller should
///     fail this attempt without clearing.
#[derive(Debug)]
pub(crate) enum RefreshError {
    /// No `refresh_token` stored for this scope.
    NoRefreshToken,
    /// Proxy 401 — refresh token expired/revoked. Keyring already cleared.
    Rejected,
    /// Transient failure (429/502/400/network/decode). Token left intact.
    Transient(String),
}

/// Successful Trakt refresh. Carries the new access_token so the caller
/// can immediately retry the request that triggered the refresh without
/// a second keyring round-trip.
#[derive(Debug)]
pub(crate) struct RefreshOutcome {
    pub access_token: String,
}

/// Attempt to refresh the stored Trakt access token for `scope` using
/// its rotating `refresh_token` against the proxy.
///
/// `failing_access_token` is the access_token the caller saw fail (or
/// the one it read just before a proactive refresh). It is used purely
/// for the concurrency short-circuit: if, after acquiring the per-scope
/// lock, the stored access_token no longer matches it, another task
/// already refreshed — we return that fresh token instead of spending
/// the (now-rotated) refresh_token a second time. Pass `None` to skip
/// the short-circuit and always attempt a refresh.
///
/// Not a `#[tauri::command]` — called from Rust (scrobble.rs), so no
/// command registration is needed.
pub(crate) async fn refresh_trakt_token(
    scope: &str,
    failing_access_token: Option<&str>,
) -> Result<RefreshOutcome, RefreshError> {
    // Cheap pre-check before taking the lock: if there's no token or no
    // refresh_token at all, there's nothing the lock can change.
    let pre = read_token("trakt", scope);
    match &pre {
        Some(t) if t.refresh_token.is_some() => {}
        _ => return Err(RefreshError::NoRefreshToken),
    }

    let lock = refresh_lock_for(scope);
    let _guard = lock.lock().await;

    // Re-read under the lock — another task may have refreshed while we
    // were queued. If the stored access_token already differs from the
    // one the caller saw failing, that other task rotated the token;
    // hand back the fresh one rather than burning the refresh_token.
    let stored = read_token("trakt", scope);
    let refresh_token = match &stored {
        Some(t) => {
            if let (Some(failing), fresh) = (failing_access_token, t.access_token.as_str()) {
                if failing != fresh {
                    crate::devlog!(
                        info, "scrobble",
                        "Trakt refresh skipped for scope={scope}: another task already rotated the token",
                    );
                    return Ok(RefreshOutcome { access_token: fresh.to_string() });
                }
            }
            match &t.refresh_token {
                Some(rt) => rt.clone(),
                // The token (or its refresh_token) was cleared between
                // the pre-check and acquiring the lock — most likely a
                // concurrent Rejected. Nothing to refresh with.
                None => return Err(RefreshError::NoRefreshToken),
            }
        }
        None => return Err(RefreshError::NoRefreshToken),
    };
    // `stored` is guaranteed Some here.
    let prev_username = stored.and_then(|t| t.username);

    let url = format!("{REDIRECT_BASE}/trakt/refresh");
    let client = match device_flow_client() {
        Ok(c) => c,
        Err(e) => return Err(RefreshError::Transient(e)),
    };
    let resp = match client
        .post(&url)
        .json(&serde_json::json!({ "refresh_token": refresh_token }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Network-level failure — transient, leave the token alone.
            let reason = format!("network error: {e}");
            crate::devlog!(warn, "scrobble", "Trakt refresh for scope={scope} failed: {reason}");
            return Err(RefreshError::Transient(reason));
        }
    };

    let status = resp.status();

    if status.as_u16() == 401 {
        // refresh_token is dead — the user must fully re-authenticate.
        // Clear the keyring so the existing "Trakt token expired"
        // notification fires on the next status read.
        clear_token_for("trakt", scope);
        crate::devlog!(
            warn, "scrobble",
            "Trakt refresh rejected (401) for scope={scope} — refresh token dead, token cleared",
        );
        return Err(RefreshError::Rejected);
    }

    if !status.is_success() {
        // 429 (rate_limited) / 502 (upstream_failure) / 400 (bad_request)
        // / any other non-2xx — all transient. Do NOT clear the token.
        let body_text = resp.text().await.unwrap_or_default();
        let reason = format!(
            "proxy returned {} ({})",
            status.as_u16(),
            body_text.chars().take(120).collect::<String>(),
        );
        crate::devlog!(warn, "scrobble", "Trakt refresh for scope={scope} failed: {reason}");
        return Err(RefreshError::Transient(reason));
    }

    // HTTP 200 — decode with the SAME success-body struct the
    // device-flow poll uses (the proxy's refresh 200 body is identical).
    let body_text = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            let reason = format!("read 200 body: {e}");
            crate::devlog!(warn, "scrobble", "Trakt refresh for scope={scope} failed: {reason}");
            return Err(RefreshError::Transient(reason));
        }
    };
    #[derive(Deserialize)]
    struct SuccessBody {
        access_token:  String,
        #[serde(default)]
        refresh_token: Option<String>,
        #[serde(default)]
        expires_at:    Option<u64>,
        #[serde(default)]
        username:      Option<String>,
    }
    let body: SuccessBody = match serde_json::from_str(&body_text) {
        Ok(b) => b,
        Err(e) => {
            // Decode failure — the token on disk is still the valid one;
            // treat as transient so the reactive 401 path can retry.
            let reason = format!("decode refresh response: {e}");
            crate::devlog!(warn, "scrobble", "Trakt refresh for scope={scope} failed: {reason}");
            return Err(RefreshError::Transient(reason));
        }
    };

    // Persist the rotated token. Trakt always issues a new
    // refresh_token; if the proxy ever omits it, keep the old one so we
    // don't end up with no refresh path. `username` may be empty when
    // the proxy's identity fetch failed — keep the previously-stored
    // display name in that case.
    let rotated_refresh = body.refresh_token.or(Some(refresh_token));
    let username = match body.username {
        Some(u) if !u.is_empty() => Some(u),
        _ => prev_username,
    };
    let new_token = ScrobbleAuthToken {
        access_token: body.access_token.clone(),
        refresh_token: rotated_refresh,
        expires_at:   body.expires_at,
        username,
    };
    let json = match serde_json::to_string(&new_token) {
        Ok(j) => j,
        // Serialisation can't realistically fail for this shape, but if
        // it does the old token is still valid — transient.
        Err(e) => return Err(RefreshError::Transient(
            format!("serialise refreshed token: {e}"),
        )),
    };
    let persist = entry("trakt", scope)
        .and_then(|e| e.set_password(&json).map_err(|e| e.to_string()));
    if let Err(e) = persist {
        return Err(RefreshError::Transient(e));
    }

    crate::devlog!(
        info, "scrobble",
        "Trakt token refreshed for scope={scope} (expires_at={:?})",
        new_token.expires_at,
    );
    Ok(RefreshOutcome { access_token: body.access_token })
}

/// Best-effort server-side revoke of a Trakt access token. Called from
/// the "Disconnect Trakt" path BEFORE the local keyring entry is
/// dropped so Trakt invalidates the token on their side too. Every
/// failure is swallowed — the disconnect must succeed regardless of
/// whether the proxy/Trakt is reachable. Trakt-only; AniList has no
/// revoke endpoint.
pub(crate) async fn revoke_trakt_token(access_token: &str) {
    let client = match device_flow_client() {
        Ok(c) => c,
        Err(e) => {
            crate::devlog!(warn, "scrobble", "Trakt revoke skipped: client init failed: {e}");
            return;
        }
    };
    let url = format!("{REDIRECT_BASE}/trakt/revoke");
    match client
        .post(&url)
        .json(&serde_json::json!({ "token": access_token }))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            crate::devlog!(info, "scrobble", "Trakt token revoked server-side");
        }
        Ok(r) => {
            crate::devlog!(
                warn, "scrobble",
                "Trakt revoke returned {} (ignored — disconnecting anyway)",
                r.status().as_u16(),
            );
        }
        Err(e) => {
            crate::devlog!(
                warn, "scrobble",
                "Trakt revoke request failed: {e} (ignored — disconnecting anyway)",
            );
        }
    }
}

// ---------------------------------------------------------------------------
// In-app OAuth popup webview
//
// Spawns a child Webview (attached to the main WebviewWindow) that loads the
// proxy's OAuth start URL. Optionally registers an `on_navigation` handler
// that intercepts navigations to a configured prefix (e.g.
// `aura://oauth/anilist`) and re-emits them through the existing
// `deep-link` event channel — so App.tsx's existing handler persists the
// token via the same code path the OS scheme handler would have taken.
//
// Why this exists: redirecting from the proxy to `aura://...` inside the
// user's default browser is fragile (modern browsers silently drop
// auto-redirects to non-HTTP schemes; Firefox is the canonical case
// today). Routing the OAuth flow through a webview Aura controls means
// the scheme switch never has to leave Aura's process — we observe the
// navigation, peel the params off the URL, and cancel the navigation
// before WebView2 even tries the OS scheme handler.
//
// Trakt uses device flow (no scheme redirect), so it spawns the popup
// without an `intercept_prefix` — the polling loop in scrobble_auth.rs
// handles the authorization signal independently. Same command, both
// providers, with the intercept arg distinguishing the two flows.
// ---------------------------------------------------------------------------

/// Spawn a child OAuth popup webview attached to the main window.
///
/// `label`            — the webview's unique label; the JS side uses
///                      `Webview.getByLabel(label)` to resync position
///                      and size and to close it on user dismissal.
/// `url`              — the start URL (the proxy's `/oauth/<svc>/start`
///                      endpoint, or Trakt's verification URL).
/// `x`/`y`/`width`/`height` — initial bounds in logical pixels matching
///                      the placeholder in the SourcePopup modal.
/// `intercept_prefix` — when `Some`, navigations whose URL starts with
///                      this prefix are cancelled and re-emitted as a
///                      `deep-link` event. When `None`, the webview
///                      behaves like a generic in-app browser tab.
#[tauri::command]
pub async fn open_oauth_popup_webview(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    intercept_prefix: Option<String>,
) -> Result<(), String> {
    // Parse early — `WebviewUrl::External` takes a `url::Url`, and a
    // malformed start URL should fail loudly instead of spawning a
    // blank webview that the user has to close manually.
    let parsed = Url::parse(&url)
        .map_err(|e| format!("invalid start url ({url}): {e}"))?;

    // `add_child` lives on `tauri::Window`, not `WebviewWindow` — the
    // latter is a Window+Webview composite and doesn't re-export the
    // child-attachment API. Look up the bare Window by the same label.
    let parent = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    // Match the user-agent SourcePopup uses for non-OAuth popups, so the
    // OAuth provider sees the same Chrome string regardless of which
    // spawn path was taken. Some providers gate consent screens on
    // recognising a modern desktop UA.
    const POPUP_USER_AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .user_agent(POPUP_USER_AGENT);

    // Emit the start host immediately so the JS-side popup header has
    // something to render before the first navigation event fires —
    // otherwise the security label would briefly flash empty on slow
    // page loads (the proxy `/start` redirect typically takes ~300ms).
    let nav_event = format!("popup-nav:{label}");
    let _ = app.emit(&nav_event, parsed_host_of(&url).unwrap_or_default());

    if let Some(prefix) = intercept_prefix {
        let handle = app.clone();
        let prefix_owned = prefix.clone();
        let nav_event_intercept = nav_event.clone();
        // Track the host of the most recent allowed navigation. The
        // intercept fires only when the prior page was the OAuth proxy
        // (REDIRECT_BASE_HOST below) — so an attacker who somehow gets
        // the popup to top-level-navigate to
        // `aura://oauth/<svc>?token=<evil>` from an unrelated origin
        // can't trick us into persisting a forged token. The trusted
        // boundary is "the proxy was the page that issued this
        // redirect"; on_navigation in WebView2 only fires for top-
        // level navigations (subframes use a separate event), so an
        // iframe-embedded redirect can't smuggle past the gate.
        let last_host = std::sync::Mutex::new(parsed_host_of(&url));
        builder = builder.on_navigation(move |target_url| {
            let s = target_url.as_str();
            if s.starts_with(&prefix_owned) {
                let prior = last_host.lock().ok().and_then(|g| g.clone());
                if prior.as_deref() != Some(REDIRECT_BASE_HOST) {
                    crate::devlog!(
                        warn, "scrobble",
                        "oauth popup intercept REJECTED: prior host={:?} != {} url={}",
                        prior, REDIRECT_BASE_HOST, redact_oauth_url(s),
                    );
                    // Cancel the navigation anyway — a non-proxy origin
                    // trying to redirect to our scheme is suspicious
                    // enough that we don't want WebView2 to follow it
                    // either. The popup stays open so the user can
                    // see the page that attempted it.
                    return false;
                }
                crate::devlog!(
                    info, "scrobble",
                    "oauth popup intercept matched prefix={prefix_owned} url={}",
                    redact_oauth_url(s),
                );
                // Re-emit through the same channel the OS scheme handler
                // would have used. App.tsx's existing `deep-link`
                // listener handles parsing + keyring write + UI toast.
                let _ = handle.emit("deep-link", s.to_string());
                // Cancel the navigation — without this WebView2 still
                // tries to launch the OS scheme handler, which on a
                // dev-build Windows install can launch a second
                // aura.exe before single-instance forwarding kicks in.
                return false;
            }
            // Allowed navigation — remember its host for the next
            // intercept check. We update *before* returning true so the
            // tracker reflects the page WebView2 is about to commit.
            let host = target_url.host_str().map(|h| h.to_string());
            if let Ok(mut g) = last_host.lock() {
                *g = host.clone();
            }
            // Notify the JS popup header so the user can see what page
            // they're about to interact with. Sending only the host
            // (no path / query) avoids leaking the OAuth state token
            // that lives in the proxy's start URL parameters.
            let _ = handle.emit(&nav_event_intercept, host.unwrap_or_default());
            true
        });
    } else {
        // Non-intercept mode (Trakt device flow): still emit nav-host
        // events so the popup header can render the same security
        // chip. Same payload shape; JS subscribers don't need to know
        // which mode the popup was spawned in.
        let handle = app.clone();
        builder = builder.on_navigation(move |target_url| {
            let host = target_url.host_str().map(|h| h.to_string()).unwrap_or_default();
            let _ = handle.emit(&nav_event, host);
            true
        });
    }

    parent
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width, height),
        )
        .map_err(|e| format!("add_child failed: {e}"))?;

    Ok(())
}
