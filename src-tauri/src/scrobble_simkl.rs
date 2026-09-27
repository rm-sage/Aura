// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Simkl: sign-in, the completion push and the History backfill.
//!
//! Simkl is the third scrobble provider, and it SUPPLEMENTS the other two
//! rather than replacing either: an anime episode still goes to AniList (list
//! progress) and now also to Simkl (a history row), and Simkl takes movies and
//! series too, like Trakt. Every path here is inert while
//! `scrobble_auth::SIMKL_CLIENT_ID` is empty: no request is made, and the only
//! trace is one info line per process.
//!
//! ## Sources
//!
//! The wire facts below come from Simkl's API docs, read 2026-09-24:
//!   * https://api.simkl.org/conventions/headers (three query params on every
//!     request, plus a User-Agent)
//!   * https://api.simkl.org/api-reference/auth-v2 and
//!     https://api.simkl.org/api-reference/oauth2-authorization-code
//!     (authorize on simkl.com, token on api.simkl.com, `state` and `iss`
//!     echoed back, `error=access_denied` on refusal)
//!   * https://api.simkl.org/api-reference/oauth2-pkce (S256 only; the
//!     RFC 7636 appendix B vector pinned in the tests)
//!   * https://api.simkl.org/api-reference/oauth2-tokens (7-day access token,
//!     180-day sliding NON-rotating refresh token, revoke)
//!   * https://api.simkl.org/api-reference/oauth2-scopes (omitting or
//!     misspelling `media:write` silently yields a read-only token)
//!   * https://api.simkl.org/api-reference/simkl/add-to-history and
//!     https://api.simkl.org/guides/sync (body shape, `not_found`,
//!     `use_tvdb_anime_seasons`, the write lock's lowercase `rate_limit` body)
//!   * https://api.simkl.org/resources/rate-limits (1 POST/s; the 400
//!     `RATE_LIMIT` per-user write lock; the 429 bodies; 412)
//!   * https://api.simkl.org/api-reference/simkl/get-user-settings (`user.name`)
//!
//! ## Sign-in: authorization code + PKCE, no proxy
//!
//! Simkl's AUTH V2 treats a desktop app as a PUBLIC client: no client_secret,
//! with PKCE proving that whoever redeems the code is whoever started the flow.
//! So unlike Trakt and AniList there is nothing for the aura.animasec.dev proxy
//! to hold, and Aura talks to Simkl directly: `authorize_url` mints a verifier
//! and a single-use `state` (an `oauth_callback` nonce that carries the
//! verifier), the user consents in their own browser, Simkl redirects to
//! `REDIRECT_URI` on the loopback bridge, and `oauth_callback::handle_simkl`
//! exchanges the code here and re-emits the ordinary `aura://oauth/simkl?…`
//! deep-link, so the token reaches the keyring through `set_scrobble_auth_token`
//! exactly like every other provider's.
//!
//! ## Completion-only, like Trakt
//!
//! One `POST /sync/history` when playback ends past Aura's completion rule
//! (plus one fallback POST with show-level ids when an anime episode's
//! cour-level ids come back not_found; see `targets`), never
//! `/scrobble/start|pause|stop`. Three reasons: Aura deliberately avoids
//! live "watching now" pushes for Trakt (a preview should not land on a public
//! feed); Simkl's docs do not say who can see its "Watching now" banner; and
//! live scrobbling multiplies POSTs against a budget of ONE POST per second
//! with a 20-second per-user write lock. Real-time can be a later opt-in.
//!
//! ## Pacing
//!
//! Going over 1 POST/s answers `429 {"error":"rate_limit"}` and also starts a
//! temporary throttling block on the token or client_id (a `412
//! client_id_failed` while it lasts), and repeated overage extends it. The
//! separate `400 RATE_LIMIT` is the 20 s per-user write lock, not a rate
//! limit. Every POST from this module therefore goes through `send_paced`, one
//! at a time and at least `POST_SPACING` apart, which also keeps Aura from
//! colliding with its own per-user write lock. The History backfill batches up
//! to `CHUNK_MAX` rows into each request instead of one request per row.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::scrobble::ScrobbleSession;
use crate::scrobble_auth::{self, RefreshError, RefreshOutcome, ScrobbleAuthToken};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API_BASE: &str = "https://api.simkl.com";

/// The consent page. On simkl.com, NOT api.simkl.com: that host 404s it.
const AUTHORIZE_URL: &str = "https://simkl.com/oauth2/authorize";

const TOKEN_PATH: &str = "/oauth2/token";
const REVOKE_PATH: &str = "/oauth2/revoke";
const HISTORY_PATH: &str = "/sync/history";
const USER_SETTINGS_PATH: &str = "/users/settings";

/// The redirect URI registered with Simkl, which compares it as a plain
/// string: `127.0.0.1` not `localhost`, no trailing slash. The token exchange
/// must send the identical string (port included) or it burns the code. A test
/// pins it to the bridge's port and `oauth_callback::SIMKL_CALLBACK_PATH`.
pub const REDIRECT_URI: &str = "http://127.0.0.1:11471/oauth/callback/simkl";

/// Both scopes, spelled exactly. Omitting `scope`, or any misspelling of
/// `media:write`, silently grants a READ-ONLY token that only fails at the
/// first write, which is why the exchange also checks what came back.
const SCOPE: &str = "media:read media:write";

/// Simkl's issuer identifier (RFC 9207), echoed as `iss` on the redirect.
pub const ISSUER: &str = "https://simkl.com";

/// `app-name` must be a short lowercase identifier.
const APP_NAME: &str = "aura";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const USER_AGENT: &str = concat!("Aura/", env!("CARGO_PKG_VERSION"));

/// Access-token lifetime. Simkl documents `expires_in` as always 604800.
pub const ACCESS_TOKEN_TTL_SECS: u64 = 7 * 24 * 3600;
/// Refresh-token lifetime, sliding forward on every refresh.
pub const REFRESH_TOKEN_TTL_SECS: u64 = 180 * 24 * 3600;
/// Refresh before a write once less than this much access-token life is left.
/// A day, as Simkl's docs suggest; the reactive 401 path is the backstop.
const PROACTIVE_REFRESH_WINDOW_SECS: u64 = 24 * 3600;

const OAUTH_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const REVOKE_TIMEOUT: Duration = Duration::from_secs(5);
/// The window-close flush budget, the same cap the other providers get.
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

/// Minimum gap between two POSTs (the documented budget is 1 per second).
const POST_SPACING: Duration = Duration::from_millis(1100);
/// Wait before the single retry after Simkl's per-user write lock answered
/// (`400 {"error":"RATE_LIMIT"}`, spelled `rate_limit` in the sync guide, or a
/// 409 / 423). The lock is held for at most 20 s, so a retry after that long
/// cannot meet the same write.
const LOCK_RETRY_DELAY: Duration = Duration::from_secs(20);
/// Wait before retrying a per-second `429 rate_limit`, which clears at once.
const RATE_RETRY_DELAY: Duration = Duration::from_secs(2);
/// Wait before retrying a 5xx.
const SERVER_RETRY_DELAY: Duration = Duration::from_secs(5);

/// Most rows per backfill request.
const CHUNK_MAX: usize = 100;

/// The error every entry point returns in a build with no client_id.
pub const NOT_CONFIGURED: &str = "Simkl sign-in is not set up in this build";

// ---------------------------------------------------------------------------
// Configuration, HTTP client, request builder, pacing
// ---------------------------------------------------------------------------

/// Whether this build carries a Simkl client_id. Side-effect free, for the
/// availability signal and the Settings summary.
pub fn is_configured() -> bool {
    !scrobble_auth::SIMKL_CLIENT_ID.is_empty()
}

static NOT_CONFIGURED_LOGGED: AtomicBool = AtomicBool::new(false);

/// The client_id, or `None` in a build without one. The first `None` of the
/// process logs one info line; after that it stays silent, so an unconfigured
/// build does not add a line to every playback.
fn client_id() -> Option<&'static str> {
    if is_configured() {
        return Some(scrobble_auth::SIMKL_CLIENT_ID);
    }
    if !NOT_CONFIGURED_LOGGED.swap(true, Ordering::Relaxed) {
        crate::devlog!(
            info, "scrobble",
            "Simkl is not configured in this build (SIMKL_CLIENT_ID is empty); every Simkl path is off",
        );
    }
    None
}

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Shared client. `https_only` like every other account client; each request
/// sets its own timeout, the client-level one is only a ceiling.
fn http() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(OAUTH_TIMEOUT)
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .build()
            .expect("Simkl HTTP client init failed")
    })
}

/// Every Simkl request starts here: the three identifying query params Simkl
/// asks for on EVERY call (`client_id`, `app-name`, `app-version`) and the
/// `Aura/<version>` User-Agent. Callers add the bearer token, body and timeout.
fn request(
    client:    &reqwest::Client,
    method:    reqwest::Method,
    path:      &str,
    client_id: &str,
) -> reqwest::RequestBuilder {
    client
        .request(method, format!("{API_BASE}{path}"))
        .query(&[("client_id", client_id), ("app-name", APP_NAME), ("app-version", APP_VERSION)])
        .header(reqwest::header::USER_AGENT, USER_AGENT)
}

fn post_gate() -> &'static tokio::sync::Mutex<Option<Instant>> {
    static GATE: OnceLock<tokio::sync::Mutex<Option<Instant>>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(None))
}

/// Send a POST no sooner than `POST_SPACING` after the previous one finished.
/// The gate is held across the send, so Simkl POSTs from anywhere in the
/// process (a completion push, a backfill, a refresh) go out one at a time.
async fn send_paced(rb: reqwest::RequestBuilder) -> reqwest::Result<reqwest::Response> {
    let mut last = post_gate().lock().await;
    if let Some(prev) = *last {
        let since = prev.elapsed();
        if since < POST_SPACING {
            tokio::time::sleep(POST_SPACING - since).await;
        }
    }
    let res = rb.send().await;
    *last = Some(Instant::now());
    res
}

/// A reqwest error's Display includes the request URL, query and all, so logs
/// name only the category.
fn category(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_decode() {
        "decode"
    } else {
        "send"
    }
}

/// The machine-readable `error` code from a Simkl error body (both the OAuth
/// envelope and the API's own `{error, code, message}` use this key), reduced
/// to a plain identifier so it is safe to log.
fn error_code(raw: &str) -> String {
    #[derive(Deserialize)]
    struct ErrorBody {
        #[serde(default)]
        error: Option<String>,
    }
    serde_json::from_str::<ErrorBody>(raw)
        .ok()
        .and_then(|b| b.error)
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(40)
        .collect()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// PKCE + the authorize URL
// ---------------------------------------------------------------------------

/// Unpadded base64url (RFC 4648 section 5), the encoding PKCE uses for both
/// the verifier and the challenge.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        let n = (u32::from(chunk[0]) << 16) | (u32::from(b1) << 8) | u32::from(b2);
        // 1 byte -> 2 chars, 2 -> 3, 3 -> 4; no padding.
        for i in 0..=chunk.len() {
            out.push(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize] as char);
        }
    }
    out
}

/// A fresh `code_verifier`: 32 random bytes, base64url, i.e. 43 characters
/// from the unreserved set, the form Simkl's docs recommend.
///
/// The bytes are the SHA-256 of three v4 UUIDs. The crate has no direct RNG
/// dependency, and `uuid`'s v4 draws from the OS generator (`getrandom`); three
/// of them hold 366 random bits (6 of each 128 are fixed version / variant
/// bits), and hashing condenses that into 32 uniformly distributed bytes.
pub(crate) fn new_verifier() -> Zeroizing<String> {
    let mut hasher = Sha256::new();
    for _ in 0..3 {
        hasher.update(uuid::Uuid::new_v4().as_bytes());
    }
    Zeroizing::new(base64url(&hasher.finalize()))
}

/// S256 challenge: base64url(SHA-256(verifier)), hashing the verifier STRING.
fn challenge_for(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// Percent-encode a query value, spaces as `%20` (Simkl's documented form for
/// the space-separated scope) rather than the `+` of form encoding.
/// `byte_serialize` escapes a literal `+` as `%2B`, so every `+` it emits is a
/// space and the replacement is exact.
fn pct(s: &str) -> String {
    url::form_urlencoded::byte_serialize(s.as_bytes())
        .collect::<String>()
        .replace('+', "%20")
}

fn build_authorize_url(client_id: &str, state: &str, challenge: &str) -> String {
    let params = [
        ("client_id", client_id),
        ("redirect_uri", REDIRECT_URI),
        ("response_type", "code"),
        ("scope", SCOPE),
        ("state", state),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ];
    let query: Vec<String> = params.iter().map(|(k, v)| format!("{k}={}", pct(v))).collect();
    format!("{AUTHORIZE_URL}?{}", query.join("&"))
}

/// The `simkl` arm of `scrobble_oauth_authorize_url`: the URL the frontend
/// opens in the system browser. Mints the verifier and a single-use `state`
/// holding it (see `oauth_callback::issue_pkce_state`); the URL itself is never
/// logged, since it carries the state.
pub fn authorize_url() -> Result<String, String> {
    let Some(client_id) = client_id() else {
        return Err(NOT_CONFIGURED.to_string());
    };
    if !crate::streaming::is_running() {
        return Err(
            "Simkl sign-in needs Aura's local callback listener on port 11471, which another \
             process is using. Close it and try again."
                .to_string(),
        );
    }
    let verifier = new_verifier();
    let challenge = challenge_for(&verifier);
    let state = crate::oauth_callback::issue_pkce_state("simkl", verifier);
    crate::devlog!(
        info, "scrobble",
        "oauth start (simkl) -> system browser, PKCE S256, loopback callback on {}",
        crate::oauth_callback::SIMKL_CALLBACK_PATH,
    );
    Ok(build_authorize_url(client_id, &state, &challenge))
}

// ---------------------------------------------------------------------------
// Token exchange, display name, refresh, revoke
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    scope: Option<String>,
}

/// A successful code exchange, ready for the deep-link.
pub(crate) struct TokenGrant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Absolute unix seconds, the unit `set_scrobble_auth_token` stores.
    pub expires_at: u64,
}

/// Why a code exchange failed, as far as the landing page needs to know.
pub(crate) enum ExchangeError {
    /// No client_id in this build (unreachable in practice: no state is minted).
    NotConfigured,
    /// `401 invalid_client`: the client_id is not enabled for AUTH V2 as a
    /// public app. The most likely first-run failure, so it gets its own page.
    InvalidClient,
    /// Simkl granted a token without `media:write`; the grant was revoked.
    ReadOnly,
    /// Simkl refused the grant (`invalid_grant`: code expired, reused, or a
    /// PKCE mismatch). A failed exchange burns the code either way.
    Rejected,
    /// Network, 5xx, or an unreadable response.
    Transient,
}

fn scope_grants_write(scope: &str) -> bool {
    scope.split_whitespace().any(|s| s == "media:write")
}

/// Exchange an authorization code for tokens. Public client: `client_id` and
/// `code_verifier`, never a secret. Called once per code, never retried, since
/// Simkl consumes a code even when the exchange fails.
pub(crate) async fn exchange_code(code: &str, verifier: &str) -> Result<TokenGrant, ExchangeError> {
    let Some(client_id) = client_id() else {
        return Err(ExchangeError::NotConfigured);
    };
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    let rb = request(http(), reqwest::Method::POST, TOKEN_PATH, client_id)
        .timeout(OAUTH_TIMEOUT)
        .form(&form);
    let resp = match send_paced(rb).await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "scrobble", "Simkl code exchange failed: {}", category(&e));
            return Err(ExchangeError::Transient);
        }
    };
    let status = resp.status().as_u16();
    let raw = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        let code = error_code(&raw);
        if code == "invalid_client" {
            crate::devlog!(
                warn, "scrobble",
                "Simkl code exchange: invalid_client. The client_id must have OAuth 2.0 (AUTH V2) \
                 enabled and be registered as a desktop app (a server app needs a secret Aura \
                 does not have) in Simkl's developer settings",
            );
            return Err(ExchangeError::InvalidClient);
        }
        crate::devlog!(warn, "scrobble", "Simkl code exchange refused (status={status}, error={code})");
        return Err(if status >= 500 { ExchangeError::Transient } else { ExchangeError::Rejected });
    }
    let body: TokenResponse = match serde_json::from_str(&raw) {
        Ok(b) => b,
        Err(e) => {
            crate::devlog!(warn, "scrobble", "Simkl code exchange: unreadable token response: {e}");
            return Err(ExchangeError::Transient);
        }
    };
    if body.access_token.is_empty() {
        crate::devlog!(warn, "scrobble", "Simkl code exchange: token response carried no access_token");
        return Err(ExchangeError::Transient);
    }
    let refresh_token = body.refresh_token.filter(|r| !r.is_empty());
    // Check the scope actually granted rather than trusting the request:
    // Simkl downgrades silently. A read-only grant would only surface as a
    // 403 on the first completion, so refuse it now and revoke it.
    if let Some(scope) = body.scope.as_deref() {
        if !scope_grants_write(scope) {
            crate::devlog!(
                warn, "scrobble",
                "Simkl granted scope {scope:?} without media:write; revoking the read-only grant",
            );
            let token = refresh_token.as_deref().unwrap_or(&body.access_token);
            revoke_raw(client_id, token).await;
            return Err(ExchangeError::ReadOnly);
        }
    }
    crate::devlog!(info, "scrobble", "Simkl code exchange OK (refresh token: {})", refresh_token.is_some());
    Ok(TokenGrant {
        access_token: body.access_token,
        refresh_token,
        expires_at: now_secs() + body.expires_in.unwrap_or(ACCESS_TOKEN_TTL_SECS),
    })
}

/// The signed-in user's display name (`GET /users/settings` -> `user.name`),
/// best-effort: any failure connects without a name, as the other providers do.
pub(crate) async fn fetch_username(access_token: &str) -> Option<String> {
    #[derive(Deserialize)]
    struct Settings {
        #[serde(default)]
        user: Option<User>,
    }
    #[derive(Deserialize)]
    struct User {
        #[serde(default)]
        name: Option<String>,
    }
    let client_id = client_id()?;
    let resp = match request(http(), reqwest::Method::GET, USER_SETTINGS_PATH, client_id)
        .bearer_auth(access_token)
        .timeout(OAUTH_TIMEOUT)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(info, "scrobble", "Simkl /users/settings {}: connecting without a name", category(&e));
            return None;
        }
    };
    if !resp.status().is_success() {
        crate::devlog!(
            info, "scrobble",
            "Simkl /users/settings status {}: connecting without a name",
            resp.status().as_u16(),
        );
        return None;
    }
    let settings: Settings = resp.json().await.ok()?;
    let name = settings.user?.name?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.chars().take(64).collect())
}

/// The `simkl` arm of `scrobble_auth::refresh_access_token`, with the same
/// contract as Trakt's: serialised per scope, a caller whose failing token was
/// already replaced gets the fresh one without a second refresh, `Rejected`
/// clears the keyring entry, `Transient` leaves it alone.
///
/// Simkl's refresh is NON-rotating (the same refresh token comes back), so
/// the serialisation is not about a double-spent refresh token as it is for
/// Trakt. It matters for a different reason: a refresh replaces the grant's
/// access token and the previous one stops working at once, so two
/// overlapping refreshes would each invalidate what the other just stored.
pub(crate) async fn refresh_token(
    scope: &str,
    failing_access_token: Option<&str>,
) -> Result<RefreshOutcome, RefreshError> {
    let Some(client_id) = client_id() else {
        return Err(RefreshError::Transient(NOT_CONFIGURED.to_string()));
    };
    match scrobble_auth::read_token_for("simkl", scope) {
        Some(t) if t.refresh_token.as_deref().is_some_and(|r| !r.is_empty()) => {}
        _ => return Err(RefreshError::NoRefreshToken),
    }

    let lock = scrobble_auth::refresh_lock_for(&format!("simkl:{scope}"));
    let _guard = lock.lock().await;

    // Re-read under the lock: another task may have refreshed while we queued.
    let Some(stored) = scrobble_auth::read_token_for("simkl", scope) else {
        return Err(RefreshError::NoRefreshToken);
    };
    if let Some(failing) = failing_access_token {
        if failing != stored.access_token {
            crate::devlog!(
                info, "scrobble",
                "Simkl refresh skipped for scope={scope}: another task already refreshed the token",
            );
            return Ok(RefreshOutcome { access_token: stored.access_token });
        }
    }
    let Some(refresh) = stored.refresh_token.clone().filter(|r| !r.is_empty()) else {
        return Err(RefreshError::NoRefreshToken);
    };

    let form = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh.as_str()),
        ("client_id", client_id),
    ];
    let rb = request(http(), reqwest::Method::POST, TOKEN_PATH, client_id)
        .timeout(OAUTH_TIMEOUT)
        .form(&form);
    let resp = match send_paced(rb).await {
        Ok(r) => r,
        Err(e) => {
            let reason = format!("network error ({})", category(&e));
            crate::devlog!(warn, "scrobble", "Simkl refresh for scope={scope} failed: {reason}");
            return Err(RefreshError::Transient(reason));
        }
    };
    let status = resp.status().as_u16();
    let raw = resp.text().await.unwrap_or_default();

    if !(200..300).contains(&status) {
        let code = error_code(&raw);
        if code == "invalid_grant" {
            // The refresh token is dead: revoked from Simkl's Connected Apps,
            // or idle past its 180 days. Only a new sign-in helps, so clear
            // the entry and let Settings show the reconnect state.
            scrobble_auth::clear_token_for("simkl", scope);
            crate::devlog!(
                warn, "scrobble",
                "Simkl refresh rejected (invalid_grant) for scope={scope}: refresh token dead, token cleared",
            );
            return Err(RefreshError::Rejected);
        }
        // invalid_client, 429, 5xx and the rest say nothing about THIS token,
        // so it is left in place.
        let reason = format!("status {status} ({code})");
        crate::devlog!(warn, "scrobble", "Simkl refresh for scope={scope} failed: {reason}");
        return Err(RefreshError::Transient(reason));
    }

    let body = match serde_json::from_str::<TokenResponse>(&raw) {
        Ok(b) if !b.access_token.is_empty() => b,
        _ => {
            let reason = "unreadable refresh response".to_string();
            crate::devlog!(warn, "scrobble", "Simkl refresh for scope={scope} failed: {reason}");
            return Err(RefreshError::Transient(reason));
        }
    };
    // Store whatever comes back. Simkl repeats the same refresh token, but
    // keeping the old one when a response omits it is what avoids ending up
    // with no refresh path at all.
    let new_token = ScrobbleAuthToken {
        access_token:  body.access_token.clone(),
        refresh_token: body.refresh_token.filter(|r| !r.is_empty()).or(Some(refresh)),
        expires_at:    Some(now_secs() + body.expires_in.unwrap_or(ACCESS_TOKEN_TTL_SECS)),
        username:      stored.username,
    };
    if let Err(e) = scrobble_auth::store_token_for("simkl", scope, &new_token) {
        return Err(RefreshError::Transient(e));
    }
    crate::devlog!(
        info, "scrobble",
        "Simkl token refreshed for scope={scope} (expires_at={:?})",
        new_token.expires_at,
    );
    Ok(RefreshOutcome { access_token: body.access_token })
}

/// The `simkl` arm of `scrobble_auth::revoke_access_token`. Revokes by the
/// refresh token (revoking either half ends the whole grant), capped at
/// `REVOKE_TIMEOUT`, every failure swallowed: Disconnect never waits on Simkl.
pub(crate) async fn revoke(scope: &str) {
    let Some(client_id) = client_id() else { return };
    let Some(tok) = scrobble_auth::read_token_for("simkl", scope) else { return };
    let token = tok.refresh_token.filter(|r| !r.is_empty()).unwrap_or(tok.access_token);
    revoke_raw(client_id, &token).await;
}

async fn revoke_raw(client_id: &str, token: &str) {
    let form = [("token", token), ("client_id", client_id)];
    let rb = request(http(), reqwest::Method::POST, REVOKE_PATH, client_id)
        .timeout(REVOKE_TIMEOUT)
        .form(&form);
    // The outer cap also covers any wait at the POST gate.
    match tokio::time::timeout(REVOKE_TIMEOUT, send_paced(rb)).await {
        // A 200 is all revoke ever answers (RFC 7009), so it confirms nothing.
        Ok(Ok(r)) if r.status().is_success() => {
            crate::devlog!(info, "scrobble", "Simkl revoke sent");
        }
        Ok(Ok(r)) => {
            crate::devlog!(
                warn, "scrobble",
                "Simkl revoke returned {} (ignored, disconnecting anyway)",
                r.status().as_u16(),
            );
        }
        Ok(Err(e)) => {
            crate::devlog!(
                warn, "scrobble",
                "Simkl revoke request failed ({}) (ignored, disconnecting anyway)",
                category(&e),
            );
        }
        Err(_) => {
            crate::devlog!(warn, "scrobble", "Simkl revoke timed out (ignored, disconnecting anyway)");
        }
    }
}

// ---------------------------------------------------------------------------
// What to send: targets from a ScrobbleSession
//
// Two kinds of episode address, never mixed in one entry:
//
//   * AnimeEpisode: ids naming ONE anime entry (AniList / Kitsu / MAL /
//     AniDB) with the episode number local to it. Simkl's native anime model
//     is AniDB's (each cour its own title, episodes restart at 1), so this
//     needs no numbering translation at all. The source is AIOMetadata's
//     per-video AniList pair when the session has it (the same mapping
//     AniList's fast path trusts), else an anime-database video id.
//   * ShowEpisode: show-level ids (the series-root IMDb id, or a TMDB / TVDB
//     show id) with the VideoEntry's season/episode, which is Cinemeta / TVDB
//     style. Sent with `use_tvdb_anime_seasons: true`, the documented switch
//     that makes Simkl read season/number as TVDB per-season numbering when
//     the title turns out to be anime (the default is AniDB-sequential).
//     Nothing is converted to absolute numbering client-side.
//
// An anime session tries its AnimeEpisode first and its ShowEpisode only if
// Simkl reports the first not_found, one POST each. Mixing both id sets into
// one entry would let Simkl resolve a cour-level id and then read TVDB
// numbers against it.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
enum SimklTarget {
    Movie { ids: Map<String, Value> },
    ShowEpisode { ids: Map<String, Value>, season: u32, number: u32 },
    AnimeEpisode { ids: Map<String, Value>, number: u32 },
}

/// Stremio id prefixes that name one anime entry, episodes local to it.
const ANIME_ID_KEYS: &[&str] = &["anilist", "anidb", "kitsu", "mal"];
/// Stremio id prefixes that name a whole show (or a movie). TMDB ids are only
/// ever sent inside a typed `movies` / `shows` entry, since a bare TMDB id is
/// ambiguous between the two.
const SHOW_ID_KEYS: &[&str] = &["tmdb", "tvdb"];

fn is_imdb(s: &str) -> bool {
    s.len() >= 3 && s.len() <= 16 && s.starts_with("tt") && s[2..].bytes().all(|b| b.is_ascii_digit())
}

/// A Stremio id split into its database key, id value, and trailing numbers
/// (`tt0903747:1:5` -> imdb "tt0903747", [1, 5]; `kitsu:46474:5` -> kitsu
/// 46474, [5]). `None` for anything not well-formed, so only well-formed ids
/// are ever sent.
struct StremioId {
    key:   &'static str,
    value: Value,
    rest:  Vec<u32>,
}

fn parse_stremio_id(id: &str) -> Option<StremioId> {
    let mut parts = id.trim().split(':');
    let head = parts.next()?;
    let (key, value) = if is_imdb(head) {
        ("imdb", Value::String(head.to_string()))
    } else {
        let key = ANIME_ID_KEYS.iter().chain(SHOW_ID_KEYS).copied().find(|k| *k == head)?;
        let n: u64 = parts.next()?.parse().ok().filter(|n| *n > 0)?;
        (key, json!(n))
    };
    let rest: Option<Vec<u32>> = parts.map(|p| p.parse().ok()).collect();
    Some(StremioId { key, value, rest: rest? })
}

/// Ordered candidates for one session, best first. Empty means Simkl has
/// nothing it can key on and the push is skipped.
fn targets(sess: &ScrobbleSession) -> Vec<SimklTarget> {
    let video = parse_stremio_id(&sess.imdb_id);
    let parent_imdb = sess.series_imdb_id.as_deref().map(str::trim).filter(|s| is_imdb(s));

    if sess.media_type == "movie" {
        let mut ids = Map::new();
        if let Some(v) = video.as_ref().filter(|v| v.rest.is_empty()) {
            ids.insert(v.key.to_string(), v.value.clone());
        }
        if !ids.contains_key("imdb") {
            if let Some(p) = parent_imdb {
                ids.insert("imdb".to_string(), Value::String(p.to_string()));
            }
        }
        return if ids.is_empty() { Vec::new() } else { vec![SimklTarget::Movie { ids }] };
    }

    let cour = match (
        sess.anilist_id.filter(|n| *n > 0),
        sess.anilist_episode.filter(|n| *n > 0),
    ) {
        (Some(id), Some(number)) => {
            let mut ids = Map::new();
            ids.insert("anilist".to_string(), json!(id));
            Some(SimklTarget::AnimeEpisode { ids, number })
        }
        _ => video
            .as_ref()
            .filter(|v| ANIME_ID_KEYS.contains(&v.key) && v.rest.len() == 1 && v.rest[0] > 0)
            .map(|v| {
                let mut ids = Map::new();
                ids.insert(v.key.to_string(), v.value.clone());
                SimklTarget::AnimeEpisode { ids, number: v.rest[0] }
            }),
    };

    let show_video = video.as_ref().filter(|v| v.key == "imdb" || SHOW_ID_KEYS.contains(&v.key));
    let mut show_ids = Map::new();
    if let Some(p) = parent_imdb {
        show_ids.insert("imdb".to_string(), Value::String(p.to_string()));
    }
    if let Some(v) = show_video {
        show_ids.entry(v.key.to_string()).or_insert_with(|| v.value.clone());
    }
    // The VideoEntry's own numbers win over the id-parsed ones, as for Trakt.
    let numbering = match (sess.season, sess.episode_num) {
        (Some(season), Some(number)) => Some((season, number)),
        _ => show_video.filter(|v| v.rest.len() == 2).map(|v| (v.rest[0], v.rest[1])),
    };
    let show = match numbering {
        Some((season, number)) if number > 0 && !show_ids.is_empty() => {
            Some(SimklTarget::ShowEpisode { ids: show_ids, season, number })
        }
        _ => None,
    };

    cour.into_iter().chain(show).collect()
}

/// One `/sync/history` entry for `target`, and the top-level array it goes in.
fn history_entry(target: &SimklTarget, watched_at: Option<&str>) -> (&'static str, Value) {
    let stamp = |mut v: Value| -> Value {
        if let Some(ts) = watched_at {
            v["watched_at"] = Value::String(ts.to_string());
        }
        v
    };
    match target {
        SimklTarget::Movie { ids } => ("movies", stamp(json!({ "ids": ids }))),
        SimklTarget::ShowEpisode { ids, season, number } => (
            "shows",
            json!({
                "ids": ids,
                "use_tvdb_anime_seasons": true,
                "seasons": [{ "number": season, "episodes": [stamp(json!({ "number": number }))] }],
            }),
        ),
        SimklTarget::AnimeEpisode { ids, number } => (
            "shows",
            json!({
                "ids": ids,
                "seasons": [{ "number": 1, "episodes": [stamp(json!({ "number": number }))] }],
            }),
        ),
    }
}

/// The request body for a set of entries: one element per entry (entries for
/// the same show are NOT merged, so a `not_found` echo maps back to its row).
fn history_body(entries: &[(&'static str, Value)]) -> Value {
    let mut movies = Vec::new();
    let mut shows = Vec::new();
    for (bucket, entry) in entries {
        if *bucket == "movies" {
            movies.push(entry.clone());
        } else {
            shows.push(entry.clone());
        }
    }
    let mut body = Map::new();
    if !movies.is_empty() {
        body.insert("movies".to_string(), Value::Array(movies));
    }
    if !shows.is_empty() {
        body.insert("shows".to_string(), Value::Array(shows));
    }
    Value::Object(body)
}

/// A short, secret-free description of a target for log lines.
fn describe(target: &SimklTarget) -> String {
    match target {
        SimklTarget::Movie { ids } => format!("movie {}", Value::Object(ids.clone())),
        SimklTarget::ShowEpisode { ids, season, number } => {
            format!("show S{season}E{number} {}", Value::Object(ids.clone()))
        }
        SimklTarget::AnimeEpisode { ids, number } => {
            format!("anime ep {number} {}", Value::Object(ids.clone()))
        }
    }
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian. Howard
/// Hinnant's civil_from_days, the inverse of `arc_align::days_from_civil`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Unix seconds as `YYYY-MM-DDTHH:MM:SSZ`, the form Simkl documents.
fn iso_utc(secs: u64) -> String {
    let (year, month, day) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3_600,
        (rem % 3_600) / 60,
        rem % 60,
    )
}

/// A History row's `played_at` in Simkl's form. Empty means no backdate
/// (Simkl then stamps the request time, as Trakt does on that path).
/// Fractional seconds, which JavaScript's `toISOString` always adds, are
/// dropped. Anything that is not a UTC timestamp is an `Err`: a malformed value
/// would otherwise fail the whole batched request with a 400.
fn normalize_watched_at(raw: &str) -> Result<Option<String>, ()> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let main = s
        .strip_suffix('Z')
        .or_else(|| s.strip_suffix("+00:00"))
        .ok_or(())?;
    let (head, frac) = main.split_once('.').unwrap_or((main, ""));
    if !frac.bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    let b = head.as_bytes();
    if b.len() != 19 {
        return Err(());
    }
    for (i, c) in b.iter().enumerate() {
        let ok = match i {
            4 | 7 => *c == b'-',
            10 => *c == b'T',
            13 | 16 => *c == b':',
            _ => c.is_ascii_digit(),
        };
        if !ok {
            return Err(());
        }
    }
    let num = |from: usize, to: usize| head[from..to].parse::<u32>().unwrap_or(u32::MAX);
    let in_range = (1..=12).contains(&num(5, 7))
        && (1..=31).contains(&num(8, 10))
        && num(11, 13) < 24
        && num(14, 16) < 60
        && num(17, 19) <= 60;
    if !in_range {
        return Err(());
    }
    Ok(Some(format!("{head}Z")))
}

// ---------------------------------------------------------------------------
// The /sync/history write
// ---------------------------------------------------------------------------

/// A 2xx reply, parsed as far as Aura needs.
struct HistoryReply {
    status: u16,
    raw: String,
    /// False when the body was not a JSON object at all.
    parsed: bool,
    /// Every `not_found` echo, whichever bucket it came in (Simkl files a
    /// missed anime under `shows` whatever wrapper it was sent in).
    not_found: Vec<Value>,
    added_movies: u64,
    added_episodes: u64,
    statuses: usize,
}

fn parse_reply(status: u16, raw: String) -> HistoryReply {
    let v: Option<Value> = serde_json::from_str(&raw).ok();
    let parsed = v.as_ref().is_some_and(Value::is_object);
    let mut not_found = Vec::new();
    if let Some(buckets) = v.as_ref().and_then(|v| v.get("not_found")).and_then(Value::as_object) {
        for list in buckets.values() {
            if let Some(items) = list.as_array() {
                not_found.extend(items.iter().cloned());
            }
        }
    }
    let added = v.as_ref().and_then(|v| v.get("added"));
    let count = |key: &str| added.and_then(|a| a.get(key)).and_then(Value::as_u64).unwrap_or(0);
    let statuses = added
        .and_then(|a| a.get("statuses"))
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    HistoryReply {
        status,
        added_movies: count("movies"),
        added_episodes: count("episodes"),
        statuses,
        not_found,
        parsed,
        raw,
    }
}

/// What one POST came back as.
enum Write {
    Reply(HistoryReply),
    Unauthorized,
    /// Worth ONE retry after the delay: the per-user write lock, the per-second
    /// rate limit, or a server error.
    Busy(Duration),
    /// The user's daily allowance is spent (it resets at midnight US Eastern).
    Quota,
    /// 412: the client_id was refused, or a throttling block is active.
    ClientRejected,
    /// 403 `insufficient_scope`: this token cannot write.
    ReadOnly,
    Failed(String),
}

fn classify(status: u16, raw: String) -> Write {
    if (200..300).contains(&status) {
        return Write::Reply(parse_reply(status, raw));
    }
    let code = error_code(&raw);
    match status {
        401 => Write::Unauthorized,
        // Not a quota error despite the name: "your previous write for this
        // user is still running", the 20-second per-user lock. Simkl's docs
        // spell the code both ways (rate-limits: `RATE_LIMIT`, the sync
        // guide's example body: `rate_limit`), and the status alone keeps it
        // apart from the per-second 429 below.
        400 if code.eq_ignore_ascii_case("rate_limit") => Write::Busy(LOCK_RETRY_DELAY),
        409 | 423 => Write::Busy(LOCK_RETRY_DELAY),
        429 if code == "user_limit_exceeded" || code == "app_limit_exceeded" => Write::Quota,
        429 => Write::Busy(RATE_RETRY_DELAY),
        412 => Write::ClientRejected,
        403 if code == "insufficient_scope" => Write::ReadOnly,
        500..=599 => Write::Busy(SERVER_RETRY_DELAY),
        _ if code.is_empty() => Write::Failed(format!("status {status}")),
        _ => Write::Failed(format!("status {status}, {code}")),
    }
}

async fn post_history(client_id: &str, access_token: &str, body: &Value, timeout: Duration) -> Write {
    let rb = request(http(), reqwest::Method::POST, HISTORY_PATH, client_id)
        .bearer_auth(access_token)
        .timeout(timeout)
        .json(body);
    match send_paced(rb).await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let raw = resp.text().await.unwrap_or_default();
            classify(status, raw)
        }
        Err(e) => Write::Failed(format!("network error, {}", category(&e))),
    }
}

/// `post_history` with the single retry a `Busy` answer earns.
async fn post_history_retrying(client_id: &str, access_token: &str, body: &Value) -> Write {
    match post_history(client_id, access_token, body, WRITE_TIMEOUT).await {
        Write::Busy(delay) => {
            crate::devlog!(
                info, "scrobble",
                "Simkl /sync/history busy (write lock, rate limit or server error); retrying once in {}s",
                delay.as_secs(),
            );
            tokio::time::sleep(delay).await;
            match post_history(client_id, access_token, body, WRITE_TIMEOUT).await {
                Write::Busy(_) => Write::Failed("Simkl stayed busy after a retry".to_string()),
                other => other,
            }
        }
        other => other,
    }
}

/// A write after token handling: a 401 has been refreshed-and-retried already.
enum Authed {
    Reply(HistoryReply),
    /// The sign-in is gone (refresh rejected, or a refreshed token still 401s).
    /// The keyring entry has been cleared.
    SignedOut,
    Quota,
    ClientRejected,
    Failed(String),
}

async fn write_authed(
    client_id: &str,
    scope:     &str,
    token:     &mut ScrobbleAuthToken,
    body:      &Value,
) -> Authed {
    let mut write = post_history_retrying(client_id, &token.access_token, body).await;

    // Reactive refresh on a 401, then the write once more, as Trakt does.
    if let Write::Unauthorized = write {
        match scrobble_auth::refresh_access_token("simkl", scope, Some(&token.access_token)).await {
            Ok(refreshed) => {
                crate::devlog!(info, "scrobble", "Simkl 401: token refreshed, retrying /sync/history once");
                match scrobble_auth::read_token_for("simkl", scope) {
                    Some(fresh) => *token = fresh,
                    None => token.access_token = refreshed.access_token,
                }
                write = post_history_retrying(client_id, &token.access_token, body).await;
                if let Write::Unauthorized = write {
                    crate::devlog!(
                        warn, "scrobble",
                        "Simkl /sync/history 401 even after refresh; clearing token for scope={scope}",
                    );
                    scrobble_auth::clear_token_for("simkl", scope);
                    return Authed::SignedOut;
                }
            }
            // Refresh token dead; refresh_token() already cleared the entry.
            Err(RefreshError::Rejected) => return Authed::SignedOut,
            Err(RefreshError::Transient(reason)) => {
                crate::devlog!(
                    warn, "scrobble",
                    "Simkl 401 + transient refresh failure ({reason}); token left intact",
                );
                return Authed::Failed("token refresh failed".to_string());
            }
            Err(RefreshError::NoRefreshToken) => {
                scrobble_auth::clear_token_for("simkl", scope);
                return Authed::SignedOut;
            }
        }
    }

    match write {
        Write::Reply(reply) => Authed::Reply(reply),
        Write::Unauthorized => Authed::SignedOut,
        Write::Quota => {
            crate::devlog!(warn, "scrobble", "Simkl daily request allowance for this account is used up");
            Authed::Quota
        }
        Write::ClientRejected => {
            crate::devlog!(
                warn, "scrobble",
                "Simkl 412: the client_id was refused or is temporarily throttled",
            );
            Authed::ClientRejected
        }
        Write::ReadOnly => {
            crate::devlog!(
                warn, "scrobble",
                "Simkl 403 insufficient_scope: this token cannot write; reconnect Simkl",
            );
            Authed::Failed("read-only access, reconnect Simkl".to_string())
        }
        Write::Busy(_) => Authed::Failed("Simkl was busy".to_string()),
        Write::Failed(reason) => {
            crate::devlog!(warn, "scrobble", "Simkl /sync/history failed: {reason}");
            Authed::Failed(reason)
        }
    }
}

/// The stored token, refreshed first when under a day of access-token life is
/// left (at most once per `scrobble::proactive_refresh_allowed` cooldown).
/// `None` when there is no token, or when the refresh found the sign-in dead.
async fn live_token(scope: &str) -> Option<ScrobbleAuthToken> {
    let token = scrobble_auth::read_token_for("simkl", scope)?;
    let Some(exp) = token.expires_at else { return Some(token) };
    if exp.saturating_sub(now_secs()) >= PROACTIVE_REFRESH_WINDOW_SECS
        || !crate::scrobble::proactive_refresh_allowed(&format!("simkl:{scope}"))
    {
        return Some(token);
    }
    match scrobble_auth::refresh_access_token("simkl", scope, Some(&token.access_token)).await {
        Ok(_) => scrobble_auth::read_token_for("simkl", scope),
        Err(RefreshError::Rejected) => None,
        Err(RefreshError::Transient(reason)) => {
            crate::devlog!(
                info, "scrobble",
                "Simkl proactive refresh transient failure for scope={scope}: {reason}; using the current token",
            );
            Some(token)
        }
        Err(RefreshError::NoRefreshToken) => Some(token),
    }
}

// ---------------------------------------------------------------------------
// Completion push + shutdown flush (called from scrobble.rs `dispatch`)
// ---------------------------------------------------------------------------

/// Outcome of one completion push, for `scrobble_test_fire`'s message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimklSyncResult {
    Fired,
    NotFound,
    NoToken,
    NoUsableId,
    NotConfigured,
    Failed,
}

/// Mark one finished session watched on Simkl: one POST per candidate target,
/// the second only when the first came back not_found.
pub async fn push_completion(scope: &str, sess: &ScrobbleSession) -> SimklSyncResult {
    let Some(client_id) = client_id() else { return SimklSyncResult::NotConfigured };
    if scrobble_auth::read_token_for("simkl", scope).is_none() {
        crate::devlog!(info, "scrobble", "Simkl /sync/history skipped: no token for scope={scope}");
        return SimklSyncResult::NoToken;
    }
    let candidates = targets(sess);
    if candidates.is_empty() {
        crate::devlog!(
            debug, "scrobble",
            "Simkl /sync/history skipped: no id Simkl can use: {} (type={})",
            sess.imdb_id, sess.media_type,
        );
        return SimklSyncResult::NoUsableId;
    }
    let Some(mut token) = live_token(scope).await else {
        crate::devlog!(info, "scrobble", "Simkl /sync/history skipped: sign-in for scope={scope} is gone");
        return SimklSyncResult::NoToken;
    };

    let watched_at = iso_utc(now_secs());
    let total = candidates.len();
    for (idx, target) in candidates.iter().enumerate() {
        if idx > 0 {
            crate::devlog!(
                info, "scrobble",
                "Simkl not_found on attempt {idx}, retrying with candidate {}/{total}",
                idx + 1,
            );
        }
        let body = history_body(&[history_entry(target, Some(&watched_at))]);
        match write_authed(client_id, scope, &mut token, &body).await {
            Authed::Reply(reply) if reply.parsed && reply.not_found.is_empty() => {
                crate::devlog!(
                    info, "scrobble",
                    "Simkl /sync/history OK (status={}, added movies={} episodes={}, statuses={}) for {} as {}",
                    reply.status, reply.added_movies, reply.added_episodes, reply.statuses,
                    sess.imdb_id, describe(target),
                );
                if reply.added_movies + reply.added_episodes == 0 && reply.statuses == 0 {
                    // Simkl answers a repeat of an already-watched episode with
                    // a no-op rather than an error.
                    crate::devlog!(
                        info, "scrobble",
                        "Simkl counted nothing new for {} (already in the user's Simkl history)",
                        sess.imdb_id,
                    );
                }
                return SimklSyncResult::Fired;
            }
            Authed::Reply(reply) => {
                let preview: String = reply.raw.chars().take(400).collect();
                if reply.parsed {
                    crate::devlog!(
                        warn, "scrobble",
                        "Simkl /sync/history accepted but not_found (status={}, not_found={}) for {} as {}. body: {}",
                        reply.status, reply.not_found.len(), sess.imdb_id, describe(target), preview,
                    );
                } else {
                    // Same call as Trakt's parse-failure branch: never report
                    // a write nobody could confirm as fired.
                    crate::devlog!(
                        warn, "scrobble",
                        "Simkl /sync/history body unreadable (status={}) for {} as {}; treating as not_found. body: {}",
                        reply.status, sess.imdb_id, describe(target), preview,
                    );
                }
            }
            Authed::SignedOut | Authed::Quota | Authed::ClientRejected | Authed::Failed(_) => {
                return SimklSyncResult::Failed;
            }
        }
    }
    crate::devlog!(
        warn, "scrobble",
        "Simkl /sync/history exhausted all {total} candidate target(s) without a match",
    );
    SimklSyncResult::NotFound
}

/// The window-close flush: the best candidate only, one POST, fire-and-forget
/// inside `SHUTDOWN_TIMEOUT` (which also bounds any wait at the POST gate).
pub async fn flush_on_shutdown(scope: &str, sess: &ScrobbleSession, progress_pct: f64) {
    let Some(client_id) = client_id() else { return };
    let Some(target) = targets(sess).into_iter().next() else { return };
    let Some(token) = scrobble_auth::read_token_for("simkl", scope) else { return };
    crate::devlog!(
        info, "scrobble",
        "shutdown_blocking flushing Simkl /sync/history for {} ({:.0}%)",
        sess.imdb_id, progress_pct,
    );
    let body = history_body(&[history_entry(&target, Some(&iso_utc(now_secs())))]);
    let _ = tokio::time::timeout(
        SHUTDOWN_TIMEOUT,
        post_history(client_id, &token.access_token, &body, SHUTDOWN_TIMEOUT),
    )
    .await;
}

// ---------------------------------------------------------------------------
// History backfill (`scrobble_history_simkl`)
// ---------------------------------------------------------------------------

/// One History row to backfill. The fields are the ones the Trakt / AniList
/// history commands take, under the same camelCase keys the frontend already
/// sends for them (`parentId`, `mediaType`, `playedAt`, ...); the snake_case
/// spellings of a `HistoryEntry` are accepted too. Deserialize-only: this
/// never flows back to the frontend.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimklHistoryItem {
    pub id: String,
    #[serde(default, alias = "parent_id")]
    pub parent_id: Option<String>,
    #[serde(default, alias = "media_type")]
    pub media_type: String,
    #[serde(default)]
    pub season: Option<u32>,
    #[serde(default)]
    pub episode: Option<u32>,
    #[serde(default)]
    pub name: String,
    /// The original watch time (ISO 8601 UTC) to backdate the row to.
    #[serde(default, alias = "played_at")]
    pub played_at: String,
    #[serde(default, alias = "anilist_id")]
    pub anilist_id: Option<u64>,
    #[serde(default, alias = "anilist_episode")]
    pub anilist_episode: Option<u32>,
}

/// Per-item verdict. `not_found` and `skipped` are verdicts about the ITEM
/// (retrying changes nothing); `failed` is about the attempt and is worth
/// retrying.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SimklItemStatus {
    Added,
    NotFound,
    Failed,
    Skipped,
}

/// One result per input item, in input order (`results[i]` answers
/// `items[i]`). `id` and `played_at` echo the item: the pair the History page
/// keys a row by. Serialize-only, field names as written, no renames.
#[derive(Clone, Debug, Serialize)]
pub struct SimklHistoryResult {
    pub id: String,
    pub played_at: String,
    pub status: SimklItemStatus,
    pub message: String,
}

const MSG_ADDED: &str = "Added to Simkl history";
const MSG_NOT_FOUND: &str = "Simkl has no catalog match for this title.";
const MSG_NO_ID: &str = "This item has no id Simkl can use.";
const MSG_BAD_TIME: &str = "This item's watch time is not a UTC timestamp Simkl accepts.";
const MSG_SIGNED_OUT: &str = "Simkl sign-in expired. Reconnect it in Settings > Scrobbling.";
const MSG_QUOTA: &str =
    "Simkl's daily request allowance for this account is used up. It resets at midnight US Eastern.";
const MSG_CLIENT: &str =
    "Simkl refused Aura's requests (client id rejected or temporarily throttled). Try again later.";

/// Does this `not_found` echo name this entry? Echoes are verbatim copies of
/// what was sent, so the ids must agree, and a show echo that lists seasons
/// covers only the episode it lists. An episode-level echo without ids is
/// matched on its number, narrowed by `watched_at` when it carries one.
fn echo_matches(entry: &Value, echo: &Value) -> bool {
    match echo.get("ids") {
        Some(echo_ids) => {
            let Some(entry_ids) = entry.get("ids") else { return false };
            if !same_ids(entry_ids, echo_ids) {
                return false;
            }
            match (echo.get("seasons").and_then(Value::as_array), entry_episode(entry)) {
                (Some(seasons), Some((season, number, _))) => seasons.iter().any(|s| {
                    s.get("number").is_some_and(|n| same_scalar(n, &json!(season)))
                        && s.get("episodes").and_then(Value::as_array).map_or(true, |eps| {
                            eps.iter()
                                .any(|e| e.get("number").is_some_and(|n| same_scalar(n, &json!(number))))
                        })
                }),
                _ => true,
            }
        }
        None => match (echo.get("number"), entry_episode(entry)) {
            (Some(n), Some((_, number, watched_at))) => {
                same_scalar(n, &json!(number))
                    && echo
                        .get("watched_at")
                        .and_then(Value::as_str)
                        .map_or(true, |w| Some(w) == watched_at.as_deref())
            }
            _ => false,
        },
    }
}

/// (season, episode, watched_at) of an episode entry built by `history_entry`.
fn entry_episode(entry: &Value) -> Option<(u64, u64, Option<String>)> {
    let season = entry.get("seasons")?.get(0)?;
    let episode = season.get("episodes")?.get(0)?;
    Some((
        season.get("number")?.as_u64()?,
        episode.get("number")?.as_u64()?,
        episode.get("watched_at").and_then(Value::as_str).map(String::from),
    ))
}

/// Every id the entry sent is present, with the same value, in the echo.
/// Compared as text so `"46474"` and `46474` agree.
fn same_ids(entry_ids: &Value, echo_ids: &Value) -> bool {
    match (entry_ids.as_object(), echo_ids.as_object()) {
        (Some(sent), Some(echoed)) => {
            !sent.is_empty()
                && sent.iter().all(|(k, v)| echoed.get(k).is_some_and(|w| same_scalar(v, w)))
        }
        _ => false,
    }
}

fn same_scalar(a: &Value, b: &Value) -> bool {
    fn text(v: &Value) -> String {
        match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
    text(a) == text(b)
}

/// Turn one batched reply into a verdict per entry.
fn attribute(entries: &[(&'static str, Value)], reply: &HistoryReply) -> Vec<(SimklItemStatus, String)> {
    if !reply.parsed {
        return vec![(SimklItemStatus::Failed, "Simkl's reply could not be read. Try again.".to_string()); entries.len()];
    }
    let mut missed = vec![false; entries.len()];
    let mut unmatched = Vec::new();
    for echo in &reply.not_found {
        let mut hit = false;
        for (k, (_, entry)) in entries.iter().enumerate() {
            if echo_matches(entry, echo) {
                missed[k] = true;
                hit = true;
            }
        }
        if !hit {
            unmatched.push(echo.to_string().chars().take(200).collect::<String>());
        }
    }
    if !unmatched.is_empty() {
        // An echo in a shape this matcher does not know. The rows it cannot
        // name stay "added" (re-sending an already-recorded row is a no-op on
        // Simkl anyway); the log carries the echo so the matcher can learn it.
        crate::devlog!(
            warn, "scrobble",
            "Simkl backfill: {} not_found echo(es) matched no row: {}",
            unmatched.len(), unmatched.join(" | "),
        );
    }
    missed
        .into_iter()
        .map(|miss| {
            if miss {
                (SimklItemStatus::NotFound, MSG_NOT_FOUND.to_string())
            } else {
                (SimklItemStatus::Added, MSG_ADDED.to_string())
            }
        })
        .collect()
}

/// Backfill History rows to Simkl, backdated to each row's watch time.
///
/// Simkl allows about one POST per second with a 20-second per-user write
/// lock, so a row-per-request bulk run is unsafe. Rows are sent in chunks of at
/// most `CHUNK_MAX`, one request at a time, at least `POST_SPACING` apart (the
/// POST gate), each with the single retry a busy answer earns. Pass 0 sends
/// every row's best target; pass 1 re-sends, with the second target, only the
/// rows pass 0 reported not_found. A signed-out, quota or 412 answer stops the
/// run and fails every row not yet answered with that reason.
///
/// `Err` only for the whole-batch conditions the Trakt command also reports as
/// errors (not configured, not connected); otherwise one result per item.
pub async fn history_batch(
    scope: &str,
    items: Vec<SimklHistoryItem>,
) -> Result<Vec<SimklHistoryResult>, String> {
    let Some(client_id) = client_id() else {
        return Err(NOT_CONFIGURED.to_string());
    };
    if scrobble_auth::read_token_for("simkl", scope).is_none() {
        return Err("Simkl is not connected. Connect it in Settings > Scrobbling.".into());
    }

    // Plan every row up front: its candidate targets and its backdate.
    let mut verdicts: Vec<Option<(SimklItemStatus, String)>> = vec![None; items.len()];
    let mut plans: Vec<(Vec<SimklTarget>, Option<String>)> = Vec::with_capacity(items.len());
    for (i, item) in items.iter().enumerate() {
        let Ok(watched_at) = normalize_watched_at(&item.played_at) else {
            verdicts[i] = Some((SimklItemStatus::Skipped, MSG_BAD_TIME.to_string()));
            plans.push((Vec::new(), None));
            continue;
        };
        let sess = crate::scrobble::session_from_history(
            item.id.clone(), item.parent_id.clone(), item.media_type.clone(),
            item.season, item.episode, item.name.clone(), false, scope.to_string(),
            item.anilist_id, item.anilist_episode,
        );
        let candidates = targets(&sess);
        if candidates.is_empty() {
            verdicts[i] = Some((SimklItemStatus::Skipped, MSG_NO_ID.to_string()));
        }
        plans.push((candidates, watched_at));
    }
    crate::devlog!(
        info, "scrobble",
        "scrobble_history_simkl: scope={scope} items={} sendable={}",
        items.len(), verdicts.iter().filter(|v| v.is_none()).count(),
    );

    if verdicts.iter().any(Option::is_none) {
        let Some(mut token) = live_token(scope).await else {
            return Err(MSG_SIGNED_OUT.to_string());
        };
        let mut stop: Option<&'static str> = None;
        for pass in 0..2 {
            let work: Vec<usize> = (0..items.len())
                .filter(|&i| {
                    let due = match (pass, &verdicts[i]) {
                        (0, None) => true,
                        (1, Some((SimklItemStatus::NotFound, _))) => true,
                        _ => false,
                    };
                    due && plans[i].0.len() > pass
                })
                .collect();
            let chunk_count = work.len().div_ceil(CHUNK_MAX);
            for (n, chunk) in work.chunks(CHUNK_MAX).enumerate() {
                if let Some(reason) = stop {
                    for &i in chunk {
                        verdicts[i] = Some((SimklItemStatus::Failed, reason.to_string()));
                    }
                    continue;
                }
                let entries: Vec<(&'static str, Value)> = chunk
                    .iter()
                    .map(|&i| history_entry(&plans[i].0[pass], plans[i].1.as_deref()))
                    .collect();
                let body = history_body(&entries);
                match write_authed(client_id, scope, &mut token, &body).await {
                    Authed::Reply(reply) => {
                        let answers = attribute(&entries, &reply);
                        let missed = answers.iter().filter(|a| a.0 == SimklItemStatus::NotFound).count();
                        crate::devlog!(
                            info, "scrobble",
                            "Simkl backfill pass {pass} chunk {}/{chunk_count}: {} row(s), status={}, \
                             added movies={} episodes={}, not_found rows={missed}",
                            n + 1, chunk.len(), reply.status, reply.added_movies, reply.added_episodes,
                        );
                        for (&i, answer) in chunk.iter().zip(answers) {
                            verdicts[i] = Some(answer);
                        }
                    }
                    stopped @ (Authed::SignedOut | Authed::Quota | Authed::ClientRejected) => {
                        // Every later request would get the same answer, so
                        // none is sent: this chunk and everything after fail
                        // with the reason.
                        let reason = match stopped {
                            Authed::SignedOut => MSG_SIGNED_OUT,
                            Authed::Quota => MSG_QUOTA,
                            _ => MSG_CLIENT,
                        };
                        stop = Some(reason);
                        for &i in chunk {
                            verdicts[i] = Some((SimklItemStatus::Failed, reason.to_string()));
                        }
                    }
                    Authed::Failed(reason) => {
                        let message = format!("Simkl request failed ({reason}). Try again.");
                        for &i in chunk {
                            verdicts[i] = Some((SimklItemStatus::Failed, message.clone()));
                        }
                    }
                }
            }
        }
    }

    Ok(items
        .into_iter()
        .zip(verdicts)
        .map(|(item, verdict)| {
            let (status, message) = verdict.unwrap_or((
                SimklItemStatus::Failed,
                "Not sent. Try again.".to_string(),
            ));
            SimklHistoryResult { id: item.id, played_at: item.played_at, status, message }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, media_type: &str) -> ScrobbleSession {
        ScrobbleSession {
            imdb_id: id.to_string(),
            media_type: media_type.to_string(),
            episode: None,
            title: "t".to_string(),
            is_anime: false,
            scope: "guest".to_string(),
            season: None,
            episode_num: None,
            series_imdb_id: None,
            absolute_episode_num: None,
            anilist_id: None,
            anilist_episode: None,
            episode_title: None,
            episode_released: None,
        }
    }

    fn ids(pairs: &[(&str, Value)]) -> Map<String, Value> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn pkce_matches_rfc7636_appendix_b() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        );
    }

    #[test]
    fn base64url_is_unpadded_and_url_safe() {
        // RFC 4648 section 10 vectors, padding stripped.
        for (input, want) in [
            ("", ""), ("f", "Zg"), ("fo", "Zm8"), ("foo", "Zm9v"),
            ("foob", "Zm9vYg"), ("fooba", "Zm9vYmE"), ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64url(input.as_bytes()), want, "input {input:?}");
        }
        // 62 and 63 map to '-' and '_', never '+' and '/'.
        assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    }

    #[test]
    fn generated_verifier_is_43_unreserved_chars() {
        let a = new_verifier();
        let b = new_verifier();
        for v in [&a, &b] {
            assert_eq!(v.len(), 43);
            assert!(v.bytes().all(|c| c.is_ascii_alphanumeric() || b"-._~".contains(&c)), "{v:?}");
        }
        assert_ne!(*a, *b);
    }

    #[test]
    fn authorize_url_carries_every_param_encoded() {
        let url = build_authorize_url("client-123", "state-abc", "challenge_xyz");
        assert!(url.starts_with("https://simkl.com/oauth2/authorize?"), "{url}");
        assert!(
            url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A11471%2Foauth%2Fcallback%2Fsimkl"),
            "{url}",
        );
        assert!(url.contains("scope=media%3Aread%20media%3Awrite"), "{url}");
        assert!(!url.contains('+'), "a space must be %20, not +: {url}");

        let parsed = url::Url::parse(&url).unwrap();
        let q: std::collections::HashMap<String, String> = parsed.query_pairs().into_owned().collect();
        assert_eq!(q.len(), 7);
        assert_eq!(q["client_id"], "client-123");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:11471/oauth/callback/simkl");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "media:read media:write");
        assert_eq!(q["state"], "state-abc");
        assert_eq!(q["code_challenge"], "challenge_xyz");
        assert_eq!(q["code_challenge_method"], "S256");
    }

    #[test]
    fn redirect_uri_is_the_bridge_route() {
        assert_eq!(
            REDIRECT_URI,
            format!(
                "http://127.0.0.1:{}{}",
                crate::streaming::BRIDGE_PORT,
                crate::oauth_callback::SIMKL_CALLBACK_PATH,
            ),
        );
    }

    #[test]
    fn every_request_carries_app_identity() {
        let req = request(&reqwest::Client::new(), reqwest::Method::POST, HISTORY_PATH, "cid")
            .build()
            .unwrap();
        assert_eq!(req.url().host_str(), Some("api.simkl.com"));
        assert_eq!(req.url().path(), "/sync/history");
        let q: std::collections::HashMap<String, String> =
            req.url().query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["app-name"], "aura");
        assert_eq!(q["app-version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            req.headers()[reqwest::header::USER_AGENT],
            format!("Aura/{}", env!("CARGO_PKG_VERSION")).as_str(),
        );
    }

    #[test]
    fn history_body_for_a_movie() {
        let t = targets(&session("tt0111161", "movie"));
        assert_eq!(t, vec![SimklTarget::Movie { ids: ids(&[("imdb", json!("tt0111161"))]) }]);
        let body = history_body(&[history_entry(&t[0], Some("2026-09-24T21:04:00Z"))]);
        assert_eq!(
            body,
            json!({ "movies": [{ "ids": { "imdb": "tt0111161" }, "watched_at": "2026-09-24T21:04:00Z" }] }),
        );
    }

    #[test]
    fn history_body_for_a_series_episode() {
        let mut s = session("tt0903747:1:5", "series");
        s.season = Some(1);
        s.episode_num = Some(5);
        let t = targets(&s);
        assert_eq!(t.len(), 1);
        let body = history_body(&[history_entry(&t[0], Some("2026-09-24T21:04:00Z"))]);
        assert_eq!(
            body,
            json!({ "shows": [{
                "ids": { "imdb": "tt0903747" },
                "use_tvdb_anime_seasons": true,
                "seasons": [{
                    "number": 1,
                    "episodes": [{ "number": 5, "watched_at": "2026-09-24T21:04:00Z" }],
                }],
            }] }),
        );
    }

    #[test]
    fn history_body_for_an_anime_episode() {
        // AIOMetadata anime: a Kitsu video id, an IMDb series root, the
        // VideoEntry's TVDB numbers, and the per-video AniList pair.
        let mut s = session("kitsu:46474:9", "series");
        s.is_anime = true;
        s.series_imdb_id = Some("tt22248376".to_string());
        s.season = Some(1);
        s.episode_num = Some(9);
        s.anilist_id = Some(154587);
        s.anilist_episode = Some(9);
        let t = targets(&s);
        // Cour-level first (the AniList pair beats the Kitsu id), TVDB-style second.
        assert_eq!(
            t,
            vec![
                SimklTarget::AnimeEpisode { ids: ids(&[("anilist", json!(154587))]), number: 9 },
                SimklTarget::ShowEpisode {
                    ids: ids(&[("imdb", json!("tt22248376"))]),
                    season: 1,
                    number: 9,
                },
            ],
        );
        let body = history_body(&[history_entry(&t[0], None)]);
        assert_eq!(
            body,
            json!({ "shows": [{
                "ids": { "anilist": 154587 },
                "seasons": [{ "number": 1, "episodes": [{ "number": 9 }] }],
            }] }),
        );

        // Without the AniList pair the Kitsu video id names the cour.
        s.anilist_id = None;
        s.anilist_episode = None;
        assert_eq!(
            targets(&s)[0],
            SimklTarget::AnimeEpisode { ids: ids(&[("kitsu", json!(46474))]), number: 9 },
        );
    }

    #[test]
    fn only_well_formed_ids_are_sent() {
        assert!(targets(&session("kitsu:abc:3", "series")).is_empty());
        assert!(targets(&session("ttx123:1:2", "series")).is_empty());
        assert!(targets(&session("youtube:xyz", "movie")).is_empty());
        // A TMDB id only ever goes inside a typed entry.
        assert_eq!(
            targets(&session("tmdb:603", "movie")),
            vec![SimklTarget::Movie { ids: ids(&[("tmdb", json!(603))]) }],
        );
        assert_eq!(
            targets(&session("tmdb:1399:2:3", "series")),
            vec![SimklTarget::ShowEpisode { ids: ids(&[("tmdb", json!(1399))]), season: 2, number: 3 }],
        );
    }

    #[test]
    fn backfill_chunks_150_rows_as_100_then_50() {
        let work: Vec<usize> = (0..150).collect();
        let sizes: Vec<usize> = work.chunks(CHUNK_MAX).map(<[usize]>::len).collect();
        assert_eq!(sizes, vec![100, 50]);
        assert!(POST_SPACING >= Duration::from_millis(1100));
    }

    #[test]
    fn classify_maps_simkl_limit_signals() {
        assert!(matches!(classify(201, "{}".into()), Write::Reply(_)));
        assert!(matches!(classify(401, String::new()), Write::Unauthorized));
        assert!(matches!(
            classify(400, r#"{"error":"RATE_LIMIT"}"#.into()),
            Write::Busy(d) if d == LOCK_RETRY_DELAY
        ));
        // The sync guide's spelling of the same lock.
        assert!(matches!(
            classify(
                400,
                r#"{"error":"rate_limit","error_description":"Another sync is in progress for this user, please retry later."}"#
                    .into()
            ),
            Write::Busy(d) if d == LOCK_RETRY_DELAY
        ));
        assert!(matches!(
            classify(429, r#"{"error":"rate_limit"}"#.into()),
            Write::Busy(d) if d == RATE_RETRY_DELAY
        ));
        assert!(matches!(classify(429, r#"{"error":"user_limit_exceeded"}"#.into()), Write::Quota));
        assert!(matches!(classify(412, String::new()), Write::ClientRejected));
        assert!(matches!(classify(403, r#"{"error":"insufficient_scope"}"#.into()), Write::ReadOnly));
        assert!(matches!(classify(503, String::new()), Write::Busy(_)));
        assert!(matches!(classify(400, r#"{"error":"wrong_parameter"}"#.into()), Write::Failed(_)));
    }

    #[test]
    fn not_found_echoes_map_back_to_their_rows() {
        let a = history_entry(
            &SimklTarget::ShowEpisode { ids: ids(&[("imdb", json!("tt1"))]), season: 1, number: 1 },
            Some("2026-01-01T00:00:00Z"),
        );
        let b = history_entry(
            &SimklTarget::ShowEpisode { ids: ids(&[("imdb", json!("tt1"))]), season: 1, number: 2 },
            Some("2026-01-02T00:00:00Z"),
        );
        let c = history_entry(&SimklTarget::Movie { ids: ids(&[("tmdb", json!(603))]) }, None);
        let entries = vec![a.clone(), b, c];
        // A verbatim copy of row a, with a field Simkl adds.
        let mut echo = a.1.clone();
        echo["rating"] = Value::Null;
        let raw = json!({
            "added": { "movies": 1, "episodes": 1, "statuses": [] },
            "not_found": { "movies": [], "shows": [echo], "episodes": [] },
        })
        .to_string();
        let verdicts: Vec<SimklItemStatus> =
            attribute(&entries, &parse_reply(201, raw)).into_iter().map(|v| v.0).collect();
        assert_eq!(
            verdicts,
            vec![SimklItemStatus::NotFound, SimklItemStatus::Added, SimklItemStatus::Added],
        );

        // A stringified numeric id still matches its row.
        let raw = json!({ "not_found": { "movies": [{ "ids": { "tmdb": "603" } }] } }).to_string();
        let verdicts: Vec<SimklItemStatus> =
            attribute(&entries, &parse_reply(201, raw)).into_iter().map(|v| v.0).collect();
        assert_eq!(
            verdicts,
            vec![SimklItemStatus::Added, SimklItemStatus::Added, SimklItemStatus::NotFound],
        );

        let verdicts: Vec<SimklItemStatus> = attribute(&entries, &parse_reply(201, "not json".into()))
            .into_iter()
            .map(|v| v.0)
            .collect();
        assert_eq!(verdicts, vec![SimklItemStatus::Failed; 3]);
    }

    #[test]
    fn watched_at_is_normalised_or_refused() {
        assert_eq!(normalize_watched_at(""), Ok(None));
        assert_eq!(
            normalize_watched_at("2026-07-12T21:04:00.000Z"),
            Ok(Some("2026-07-12T21:04:00Z".to_string())),
        );
        assert_eq!(
            normalize_watched_at("2026-07-12T21:04:00+00:00"),
            Ok(Some("2026-07-12T21:04:00Z".to_string())),
        );
        assert_eq!(normalize_watched_at("2026-07-12T21:04:00+02:00"), Err(()));
        assert_eq!(normalize_watched_at("2026-13-12T21:04:00Z"), Err(()));
        assert_eq!(normalize_watched_at("yesterday"), Err(()));
    }

    #[test]
    fn iso_utc_formats_known_instants() {
        assert_eq!(iso_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso_utc(946_684_799), "1999-12-31T23:59:59Z");
        assert_eq!(iso_utc(951_868_800), "2000-03-01T00:00:00Z");
        assert_eq!(iso_utc(1_709_210_096), "2024-02-29T12:34:56Z");
        assert_eq!(iso_utc(1_790_283_840), "2026-09-24T21:04:00Z");
    }

    #[test]
    fn scope_check_needs_media_write() {
        assert!(scope_grants_write("media:read media:write"));
        assert!(!scope_grants_write("media:read"));
        assert!(!scope_grants_write(""));
    }

    #[test]
    fn history_item_accepts_both_key_spellings() {
        let camel: SimklHistoryItem = serde_json::from_value(json!({
            "id": "tt1:1:2", "parentId": "tt1", "mediaType": "series", "season": 1,
            "episode": 2, "name": "n", "playedAt": "2026-01-01T00:00:00.000Z",
            "anilistId": null, "anilistEpisode": null,
        }))
        .unwrap();
        let snake: SimklHistoryItem = serde_json::from_value(json!({
            "id": "tt1:1:2", "parent_id": "tt1", "media_type": "series", "season": 1,
            "episode": 2, "name": "n", "played_at": "2026-01-01T00:00:00.000Z",
        }))
        .unwrap();
        for item in [camel, snake] {
            assert_eq!(item.parent_id.as_deref(), Some("tt1"));
            assert_eq!(item.media_type, "series");
            assert_eq!(item.played_at, "2026-01-01T00:00:00.000Z");
        }
    }
}
