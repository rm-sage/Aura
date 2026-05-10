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
#[tauri::command]
pub fn scrobble_oauth_authorize_url(service: String) -> Result<String, String> {
    if !["trakt", "anilist"].contains(&service.as_str()) {
        return Err(format!("unknown scrobble service: {service}"));
    }
    Ok(format!("{REDIRECT_BASE}/{service}/start"))
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
