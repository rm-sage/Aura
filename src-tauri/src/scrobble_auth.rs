// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! OAuth token storage for the direct AniList + Simkl scrobble path.
//!
//! Tokens are stored in the OS keyring (Windows Credential Manager /
//! macOS Keychain / Linux Secret Service) keyed by Stremio account so a
//! user logging into a different Stremio account on the same machine
//! gets a separate (or absent) AniList / Simkl connection rather than
//! inheriting the previous account's tokens. The keyring service name
//! is `aura`; the entry user name follows the pattern
//! `<service>-<scope>` where service is `anilist` / `simkl` and scope
//! is the first 12 chars of the Stremio auth_key (or `guest`).
//!
//! Token shape on disk: a small JSON object with access_token,
//! refresh_token, expires_at (unix seconds), and a cached display
//! username so the Settings UI can render "Connected as <user>"
//! without an API round-trip.
//!
//! Two sign-in paths:
//!
//!   • AniList uses the authorization code flow through a VPS proxy at
//!     `https://aura.animasec.dev/oauth/anilist`. Aura opens the proxy's
//!     `/oauth/anilist/start`; the proxy generates a CSRF state, 302s
//!     to AniList's authorize page, receives the callback at
//!     `/oauth/anilist`, exchanges the code (with `client_secret`
//!     held in env), and 302s to `aura://oauth/anilist?token=&expires=&user=`.
//!     The deep-link handler in App.tsx persists via
//!     `set_scrobble_auth_token`.
//!
//!   • Simkl does NOT go through the proxy. It is a public OAuth 2.0
//!     client (authorization code + PKCE, no client_secret), so Aura
//!     opens Simkl's authorize page itself and Simkl redirects straight
//!     to the loopback bridge at `/oauth/callback/simkl`, which exchanges
//!     the code and re-emits the same `aura://oauth/simkl?…` deep-link.
//!     See scrobble_simkl.rs. Every Simkl path is inert while
//!     `SIMKL_CLIENT_ID` below is empty.
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

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Url, WebviewUrl,
};
use tauri::webview::WebviewBuilder;

const KEYRING_SERVICE: &str = "aura";

/// Every scrobble service this module stores tokens for, in display order.
/// The ONE allowlist: every command that takes a `service` from the frontend
/// goes through `validate_service`, so a keyring entry name or a proxy URL can
/// only ever be built from a value listed here. Mirrored by
/// `SCROBBLE_SERVICES` in src/scrobbleConn.ts. "simkl" is listed even in a
/// build with no `SIMKL_CLIENT_ID`: the list says which keyring entries exist,
/// and `scrobble_services_available` says which services can sign in.
pub const SCROBBLE_SERVICES: &[&str] = &["anilist", "simkl"];

/// Services Aura used to store tokens for and no longer supports. A leftover
/// entry is deleted from the keyring the first time a scope's status is read
/// (`forget_retired_tokens`), so a token never outlives the feature it was for.
/// Never validated as a service: nothing can sign in to, read or write one.
const RETIRED_SERVICES: &[&str] = &["trakt"];

/// Reject a service name that is not in `SCROBBLE_SERVICES`. The error text is
/// the one every command returned before this was centralised.
fn validate_service(service: &str) -> Result<(), String> {
    if SCROBBLE_SERVICES.contains(&service) {
        Ok(())
    } else {
        Err(format!("unknown scrobble service: {service}"))
    }
}

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

/// Connection summary per service, keyed by service name, holding an entry
/// ONLY for a connected service. This used to be a struct with one `Option`
/// field per provider, which serialized a disconnected one as an explicit
/// `null`; the map omits the key instead, and every frontend reader treats
/// absent and `null` alike. A `BTreeMap` so the wire order is deterministic.
pub type ScrobbleAuthStatus = BTreeMap<String, ScrobbleAuthSummary>;

#[derive(Clone, Debug, Serialize)]
pub struct ScrobbleAuthSummary {
    pub username: Option<String>,
    /// When the connection lapses, in unix seconds. For AniList that is
    /// the stored access token's expiry. For Simkl it is the
    /// RENEWAL DEADLINE instead (see `summarise`): its 7-day access token
    /// renews itself on the next write, so its expiry is not a date the
    /// user has to act on.
    pub expires_at: Option<u64>,
    /// True when the access_token is approaching expiry but still
    /// usable. The threshold is provider-aware: AniList tokens last a
    /// year and have NO refresh path (the user must re-auth manually
    /// when the token finally lapses), so we warn 7 days ahead. Simkl
    /// warns 7 days before its renewal deadline; anything else 24 h ahead. The frontend renders
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
    // option is to re-auth from scratch (full browser
    // round-trip). 7 days of advance warning gives the user time to
    // notice and reconnect.
    let warn_window: u64 = match service {
        "anilist" => 7 * 24 * 3600,
        _         => 24 * 3600,
    };

    // Simkl measures against its REFRESH path, not the access token. The
    // access token lives 7 days and every write renews it silently
    // (scrobble_simkl.rs refreshes proactively inside its last day, and
    // reactively on a 401), so warning on it would put an amber "expires in
    // 6 days" on a connection that never needs the user. What CAN lapse is
    // the refresh token: 180 days, sliding forward on every refresh, and a
    // refresh stamps a fresh 7-day `expires_at`. So the last refresh (or the
    // sign-in) happened at `expires_at - 7d`, and the grant dies unrenewed at
    // that moment + 180d. That deadline is what `expires_at` reports for
    // Simkl; `stale` is its last 7 days (watching anything renews it) and
    // `expired` is past it, the one state that needs a reconnect. A token
    // stored without a refresh_token has no silent renewal and is judged on
    // its access-token expiry.
    let simkl_refreshable = service == "simkl"
        && token.refresh_token.as_deref().is_some_and(|r| !r.is_empty());
    let reported_expiry = match token.expires_at {
        Some(exp) if simkl_refreshable => Some(
            exp.saturating_sub(crate::scrobble_simkl::ACCESS_TOKEN_TTL_SECS)
                + crate::scrobble_simkl::REFRESH_TOKEN_TTL_SECS,
        ),
        other => other,
    };
    let warn_window = if simkl_refreshable { 7 * 24 * 3600 } else { warn_window };

    let stale = match reported_expiry {
        Some(exp) => exp > now && exp <= now + warn_window,
        None      => false,
    };
    let expired = match reported_expiry {
        Some(exp) => exp <= now,
        None      => false,
    };
    Some(ScrobbleAuthSummary {
        username:   token.username.clone(),
        expires_at: reported_expiry,
        stale,
        expired,
    })
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Read the connection summary for every provider in one call. Used by
/// the Settings UI to render the AniList + Simkl rows without firing
/// one IPC round-trip per provider. `scope` is the first 12 chars of the
/// active Stremio auth_key (or the literal "guest" when signed out).
#[tauri::command]
pub async fn get_scrobble_auth_status(scope: String) -> Result<ScrobbleAuthStatus, String> {
    forget_retired_tokens(&scope);
    Ok(SCROBBLE_SERVICES
        .iter()
        .filter_map(|&service| {
            summarise(service, read_token(service, &scope))
                .map(|summary| (service.to_string(), summary))
        })
        .collect())
}

/// Delete any token stored for a `RETIRED_SERVICES` entry under `scope`.
/// Local only: the provider is not contacted. Runs once per scope per launch
/// (the keyring read is not free, and a scope's leftovers go on the first try).
fn forget_retired_tokens(scope: &str) {
    static DONE: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    let done = DONE.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()));
    if !done.lock().map(|mut g| g.insert(scope.to_string())).unwrap_or(false) {
        return;
    }
    #[cfg(windows)]
    sweep_retired_tokens_every_scope();
    for &service in RETIRED_SERVICES {
        if let Ok(e) = entry(service, scope) {
            if e.delete_credential().is_ok() {
                // No scope in the line: it is a slice of the Stremio auth_key.
                crate::devlog!(info, "scrobble", "removed the stored {service} token for this account (no longer supported)");
            }
        }
    }
}

/// Delete a `RETIRED_SERVICES` token under EVERY scope, once per launch. The
/// per-scope delete above only reaches the account signed in now, and Stremio
/// rotates its auth_key on every login, so a token stored under an older key
/// (or another account, or "guest") would otherwise stay in Credential Manager
/// for good. keyring cannot enumerate, so this lists the targets itself:
/// keyring 3's windows-native target is "{user}.{service}", i.e.
/// "<retired>-<scope>.aura". Only a count is logged, never a scope.
#[cfg(windows)]
fn sweep_retired_tokens_every_scope() {
    use windows::core::PCWSTR;
    use windows::Win32::Security::Credentials::{CredEnumerateW, CredFree, CREDENTIALW, CRED_TYPE_GENERIC};

    static DONE: OnceLock<()> = OnceLock::new();
    if DONE.set(()).is_err() {
        return;
    }
    let suffix = format!(".{KEYRING_SERVICE}");
    let mut users: Vec<String> = Vec::new();
    for &service in RETIRED_SERVICES {
        let prefix = format!("{service}-");
        // CredEnumerateW takes a name prefix followed by one '*'.
        let filter: Vec<u16> = format!("{prefix}*").encode_utf16().chain(std::iter::once(0)).collect();
        let mut count = 0u32;
        let mut creds: *mut *mut CREDENTIALW = std::ptr::null_mut();
        // SAFETY: `filter` is NUL-terminated and outlives the call; on success
        // the API hands back `count` credential pointers in one buffer that is
        // released with CredFree below. ERROR_NOT_FOUND (no match) is an Err.
        if unsafe { CredEnumerateW(PCWSTR(filter.as_ptr()), None, &mut count, &mut creds) }.is_err()
            || creds.is_null()
        {
            continue;
        }
        for i in 0..count as usize {
            // SAFETY: `i < count`, and each entry is a valid CREDENTIALW (or null)
            // until CredFree.
            let c = unsafe { *creds.add(i) };
            if c.is_null() {
                continue;
            }
            let c = unsafe { &*c };
            if c.Type != CRED_TYPE_GENERIC || c.TargetName.is_null() {
                continue;
            }
            // SAFETY: TargetName is a NUL-terminated wide string owned by the buffer.
            let Ok(target) = (unsafe { c.TargetName.to_string() }) else { continue };
            if let Some(user) = target.strip_suffix(&suffix) {
                if user.len() > prefix.len() && user.starts_with(&prefix) {
                    users.push(user.to_string());
                }
            }
        }
        // SAFETY: `creds` came from a successful CredEnumerateW and is freed once.
        unsafe { CredFree(creds as *const core::ffi::c_void) };
    }
    let removed = users
        .iter()
        .filter(|user| {
            keyring::Entry::new(KEYRING_SERVICE, user)
                .and_then(|e| e.delete_credential())
                .is_ok()
        })
        .count();
    if removed > 0 {
        crate::devlog!(info, "scrobble", "removed {removed} stored token(s) of a retired service (no longer supported)");
    }
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
    validate_service(&service)?;
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
    validate_service(&service)?;

    // Best-effort server-side revoke BEFORE dropping the local entry so
    // the provider invalidates the token on its side too; otherwise a
    // "disconnected" token stays live until it expires.
    // Simkl only: AniList exposes no revoke endpoint, so its arm
    // in `revoke_access_token` does nothing. Every failure is swallowed
    // inside the provider's revoke; the local clear below runs regardless
    // of whether the provider was reachable.
    revoke_access_token(&service, &scope).await;

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
// AniList / Simkl API calls. The Runtime-typed wrapper exists so
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
/// Drop a token the PROVIDER rejected (a 401, a dead refresh token). Every
/// caller is automatic; the user's own Disconnect goes through
/// `clear_scrobble_auth_token` instead. So when a token was actually there,
/// this tells the frontend (`scrobble-signed-out`), which raises a notice with
/// Reconnect: before, the token just vanished and Settings quietly showed
/// "not connected", with nothing to say scrobbles had stopped.
pub fn clear_token_for(service: &str, scope: &str) {
    if let Ok(e) = entry(service, scope) {
        if e.delete_credential().is_ok() {
            crate::devlog::emit_event(
                "scrobble-signed-out",
                serde_json::json!({ "service": service, "scope": scope }),
            );
        }
    }
}

/// Replace the stored token for `(service, scope)`. Used by a refresh that
/// happens in Rust (scrobble_simkl.rs); a sign-in still persists through
/// `set_scrobble_auth_token` from the deep-link handler.
pub(crate) fn store_token_for(
    service: &str,
    scope:   &str,
    token:   &ScrobbleAuthToken,
) -> Result<(), String> {
    let json = serde_json::to_string(token).map_err(|e| e.to_string())?;
    entry(service, scope)?.set_password(&json).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Provider constants — the bits that DO live in the desktop binary
// (per the integration doc, §5: client_id is fine to embed; only
// client_secret has to stay on the proxy).
// ---------------------------------------------------------------------------

/// Simkl client_id, from https://simkl.com/settings/developer/. It is public
/// and safe to commit (Simkl's docs say so: an AUTH V2 client_id on its own
/// reaches only public catalog data). There is NO client_secret: Aura is
/// registered as a public desktop client and proves itself with PKCE
/// instead, so a secret must never be added here or anywhere in the binary.
///
/// Emptying this makes every Simkl path inert: no request is ever made, the
/// authorize command returns an error saying sign-in is not set up in this
/// build, the completion and shutdown pushes return at once, and
/// `scrobble_services_available` leaves "simkl" out so the frontend can tell
/// "not in this build" from "not connected".
pub const SIMKL_CLIENT_ID: &str =
    "3afb249691920c429719fef8af147e1909434b5b3b748cd82649bbe5ecf79827";

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
/// is structured for (`startAnilist` in main.go), and it keeps Aura
/// ignorant of the per-provider URL shapes.
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
///
/// Simkl is the exception to all of the above: it is not behind the proxy.
/// Its arm returns Simkl's OWN authorize URL (PKCE challenge + a single-use
/// `state` minted here), `loopback` is ignored because Simkl can only ever
/// land on the loopback route, and a build with no `SIMKL_CLIENT_ID` gets an
/// error instead of a URL. See `scrobble_simkl::authorize_url`.
#[tauri::command]
pub fn scrobble_oauth_authorize_url(
    service:  String,
    loopback: Option<bool>,
) -> Result<String, String> {
    validate_service(&service)?;
    if service == "simkl" {
        return crate::scrobble_simkl::authorize_url();
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

/// Whether this BUILD holds the client credentials `service` needs.
/// AniList's credentials live on the proxy, so it is always available;
/// Simkl is available only once `SIMKL_CLIENT_ID` has been filled in.
fn service_available(service: &str) -> bool {
    match service {
        "simkl" => crate::scrobble_simkl::is_configured(),
        _ => true,
    }
}

/// The scrobble services this build can sign in to, in `SCROBBLE_SERVICES`
/// order. Separate from `get_scrobble_auth_status` (which says what is
/// CONNECTED) so the frontend can tell "Simkl is not set up in this build"
/// apart from "Simkl is not connected" and hide the row instead of offering a
/// Connect button that can only fail.
#[tauri::command]
pub fn scrobble_services_available() -> Vec<String> {
    SCROBBLE_SERVICES
        .iter()
        .filter(|&&service| service_available(service))
        .map(|&service| service.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Refresh-token flow
//
// Simkl's 7-day access tokens come with a rotating `refresh_token`, so
// scrobble_simkl.rs refreshes proactively (near expiry) and reactively (on
// a 401) instead of dropping the token.
//
// CONCURRENCY: a rotating refresh invalidates the previous refresh_token.
// Two concurrent 401s both refreshing with the SAME stored refresh_token
// would have the first rotation invalidate the token the second call
// carries; the second refresh then fails and triggers a spurious full
// re-auth. The per-key async mutex below serialises refreshes; after acquiring it
// the function re-reads the keyring, and if another task already
// rotated the token (the stored access_token now differs from the one
// the caller saw fail) it returns that fresh token without spending a
// second refresh.
//
// AniList has NO refresh endpoint and is deliberately untouched here.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

/// Per-scope refresh lock registry. Each key gets its own
/// `tokio::sync::Mutex`; the outer `std::sync::Mutex` only guards the
/// short map lookup/insert and is never held across an await. Keys name
/// the provider and scope (Simkl uses `simkl:<scope>`), so providers never
/// queue behind each other's refresh.
fn refresh_locks() -> &'static std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>
        = OnceLock::new();
    LOCKS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

pub(crate) fn refresh_lock_for(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = refresh_locks().lock().unwrap_or_else(|e| e.into_inner());
    map.entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Why a refresh attempt failed. The caller routes on the discriminant:
///   • `NoRefreshToken`: nothing to refresh with; fall back to the
///     clear-token-and-re-auth behaviour.
///   • `Rejected`: the provider refused the refresh token (Simkl's
///     `invalid_grant`: revoked, or idle past its 180 days). The keyring
///     entry has ALREADY been cleared.
///   • `Transient`: 429 / 5xx / network / decode error. The stored token
///     is untouched and still usable; the caller should fail this attempt
///     without clearing.
#[derive(Debug)]
pub(crate) enum RefreshError {
    /// No `refresh_token` stored for this scope.
    NoRefreshToken,
    /// Refresh token expired/revoked. Keyring already cleared.
    Rejected,
    /// Transient failure (429/502/400/network/decode). Token left intact.
    Transient(String),
}

/// Successful refresh. Carries the new access_token so the caller
/// can immediately retry the request that triggered the refresh without
/// a second keyring round-trip.
#[derive(Debug)]
pub(crate) struct RefreshOutcome {
    pub access_token: String,
}

/// Refresh the stored access token for `(service, scope)`. The per-service
/// entry point, so a provider that gains a refresh path is one more arm here.
///
/// Simkl refreshes against its own token endpoint (a public client needs no
/// secret, see scrobble_simkl.rs). AniList issues no refresh token and exposes
/// no refresh endpoint (see the module docs), so it reports `NoRefreshToken`
/// and nothing is sent anywhere.
pub(crate) async fn refresh_access_token(
    service: &str,
    scope: &str,
    failing_access_token: Option<&str>,
) -> Result<RefreshOutcome, RefreshError> {
    match service {
        // No refresh path at all; renewal is a full re-auth.
        "anilist" => Err(RefreshError::NoRefreshToken),
        "simkl" => crate::scrobble_simkl::refresh_token(scope, failing_access_token).await,
        // Not a service this module stores tokens for.
        _ => Err(RefreshError::NoRefreshToken),
    }
}

/// Best-effort server-side revoke of the stored token for `(service, scope)`,
/// run by the Disconnect path before the local keyring entry is dropped.
/// Simkl exposes a revoke endpoint; for AniList there is nothing to call, so
/// its arm does nothing (and does not even read the keyring).
pub(crate) async fn revoke_access_token(service: &str, scope: &str) {
    match service {
        // No revoke endpoint; the caller's local keyring clear is all there is.
        "anilist" => {}
        // Never blocks the disconnect: capped at 5 s, every failure swallowed.
        "simkl" => crate::scrobble_simkl::revoke(scope).await,
        // Not a service this module stores tokens for.
        _ => {}
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
// Without an `intercept_prefix` the same command opens a plain in-app
// browser tab (SourcePopup's source pages).
// ---------------------------------------------------------------------------

/// Spawn a child popup webview attached to the main window: an OAuth flow,
/// or (with no `intercept_prefix`) a plain source page. SourcePopup builds
/// EVERY popup through here, never through the JS `new Webview()` API,
/// because only a Rust builder applies `webview_browser_args()` (WebView2
/// refuses a second environment with different options in the shared user
/// data folder, so a JS popup failed whenever Hardware acceleration was off).
///
/// `label`            — the webview's unique label; the JS side uses
///                      `Webview.getByLabel(label)` to resync position
///                      and size and to close it on user dismissal.
/// `url`              — the start URL (the proxy's `/oauth/<svc>/start`
///                      endpoint, or a source page).
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

    // One desktop Chrome user agent for every popup (OAuth or a plain
    // source page). Some providers gate consent screens on recognising a
    // modern desktop UA.
    const POPUP_USER_AGENT: &str =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
         (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

    // No native find bar here either (src/searchHotkey.ts is the main page's
    // half). Only blocks the browser's default: a page's own use of the key
    // still works, and nothing here can reach Aura. Virtual keys as in that
    // file's isLetter: a non-Latin layout's e.key is not the letter the
    // accelerator reads. Keep the two in step.
    const POPUP_NO_FIND_SCRIPT: &str = r#"window.addEventListener("keydown",function(e){
        if(e.metaKey||e.altKey)return;var k=(e.key||"").toLowerCase();
        if(k==="f3"?!e.ctrlKey:e.ctrlKey&&(k==="g"||e.keyCode===71||((k==="f"||e.keyCode===70)&&!e.shiftKey)))e.preventDefault();
    },true);"#;

    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
        .user_agent(POPUP_USER_AGENT)
        .initialization_script(POPUP_NO_FIND_SCRIPT);
    // Same browser arguments as the main webview (they share one user data
    // folder, and WebView2 refuses mismatched environment options there).
    if let Some(args) = crate::webview_browser_args() {
        builder = builder.additional_browser_args(args);
    }

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
        // Non-intercept mode (a plain source page): still emit nav-host
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

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: u64 = 24 * 3600;

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn token(expires_at: u64, refresh: bool) -> ScrobbleAuthToken {
        ScrobbleAuthToken {
            access_token:  "a".into(),
            refresh_token: refresh.then(|| "r".to_string()),
            expires_at:    Some(expires_at),
            username:      None,
        }
    }

    #[test]
    fn simkl_summary_tracks_the_renewal_deadline() {
        let now = now();
        // Fresh sign-in: reports the refresh window's end, nothing to warn about.
        let s = summarise("simkl", Some(token(now + 7 * DAY, true))).unwrap();
        assert_eq!(s.expires_at, Some(now + 180 * DAY));
        assert!(!s.stale && !s.expired);
        // Access token lapsed a week ago: still renews silently on the next write.
        let s = summarise("simkl", Some(token(now - 7 * DAY, true))).unwrap();
        assert!(!s.stale && !s.expired);
        // Idle for ~174 days: inside the last week of the refresh window.
        let s = summarise("simkl", Some(token(now - 170 * DAY, true))).unwrap();
        assert!(s.stale && !s.expired);
        // Idle past 180 days: only a reconnect helps.
        let s = summarise("simkl", Some(token(now - 200 * DAY, true))).unwrap();
        assert!(s.expired);
        // No refresh token: judged on the access token itself.
        let s = summarise("simkl", Some(token(now - DAY, false))).unwrap();
        assert!(s.expired);
    }

    #[test]
    fn anilist_scrobble_summary_warns_a_week_ahead() {
        let now = now();
        let s = summarise("anilist", Some(token(now + 3 * DAY, false))).unwrap();
        assert_eq!(s.expires_at, Some(now + 3 * DAY));
        assert!(s.stale && !s.expired);
        let s = summarise("anilist", Some(token(now - 1, false))).unwrap();
        assert!(s.expired);
    }

    #[test]
    fn simkl_is_listed_but_only_available_with_a_client_id() {
        assert!(SCROBBLE_SERVICES.contains(&"simkl"));
        assert_eq!(
            scrobble_services_available().contains(&"simkl".to_string()),
            !SIMKL_CLIENT_ID.is_empty(),
        );
        assert!(scrobble_services_available().contains(&"anilist".to_string()));
        // A retired service can neither be named nor signed in to.
        assert!(validate_service("trakt").is_err());
        assert!(!scrobble_services_available().contains(&"trakt".to_string()));
    }
}
