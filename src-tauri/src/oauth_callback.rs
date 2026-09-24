// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Loopback OAuth callback — the landing pad for system-browser sign-in.
//!
//! RFC 8252 ("OAuth 2.0 for Native Apps") says a native client SHOULD run
//! the authorization leg in the user's own browser rather than an embedded
//! webview, precisely because the system browser already carries the user's
//! logged-in session. That is the whole point of this module: reconnecting
//! Trakt / AniList becomes one click on "Authorize" instead of retyping a
//! password into a webview whose cookie jar drops session cookies at app
//! exit.
//!
//! Why loopback rather than the `aura://` scheme: browsers deliberately
//! refuse to *auto*-redirect into a foreign protocol handler (Firefox is
//! the canonical case), which is what pushed the flow into an in-app
//! webview in the first place — see the comment block above
//! `open_oauth_popup_webview` in `scrobble_auth.rs`. RFC 8252 §7.3's
//! loopback redirect sidesteps that entirely: `http://127.0.0.1:<port>/…`
//! is ordinary HTTP, so no browser blocks it, no OS scheme handler is
//! consulted, and no second `aura.exe` can be spawned. Aura already runs a
//! loopback axum server for stream proxying, so the listener costs nothing
//! new — this module just adds one route to it.
//!
//! ## Trust model
//!
//! The callback URL carries a live bearer token in its query string, so the
//! endpoint must not accept a request that Aura did not initiate. A
//! malicious page in any browser on this machine can navigate the user to
//! `http://127.0.0.1:11471/oauth/callback?...` and try to plant an
//! attacker-controlled token (which would silently redirect the user's
//! scrobbles into the attacker's account).
//!
//! The control is a single-use nonce:
//!
//!   * `issue_nonce` mints a v4 UUID *only* when the user clicks Connect,
//!     and hands it to the proxy as part of the `/start` URL.
//!   * The proxy echoes it back on the final redirect.
//!   * `handle` consumes it — a nonce is accepted at most once, expires
//!     after `NONCE_TTL`, and the *service* is taken from the minted record
//!     rather than from the query string, so a callback cannot claim to be
//!     for a provider the user never started.
//!
//! An attacker who cannot observe the `/start` URL therefore cannot forge a
//! callback. Unknown / expired / replayed nonces are refused and logged.
//!
//! On success the handler re-emits the callback through the *existing*
//! `deep-link` event channel as `aura://oauth/<service>?…`, so App.tsx's
//! established handler persists the token via `set_scrobble_auth_token`
//! along exactly the code path the OS scheme handler would have taken. No
//! second persistence path to keep in sync.
//!
//! ## Simkl: `GET /oauth/callback/simkl`
//!
//! Simkl is a public PKCE client with no proxy in the middle, so Simkl
//! itself redirects here with `code` + `state` (+ `iss`), and this module
//! does the code exchange. The same nonce machinery guards it: the `state`
//! IS a nonce, minted by `issue_pkce_state` bound to "simkl" and carrying
//! the PKCE verifier, and redeemed exactly once. A PKCE record is only ever
//! accepted on the Simkl route, and a plain proxy nonce only on
//! `/oauth/callback`, so neither route can redeem the other's flow. The
//! result still leaves through the same `deep-link` re-emit.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::Query;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use tauri::{AppHandle, Emitter, Manager, Url};
use zeroize::Zeroizing;

/// Path the proxy redirects to. Kept public so `scrobble_auth.rs` can build
/// the `/start` URL without restating the string.
pub const CALLBACK_PATH: &str = "/oauth/callback";

/// Path Simkl redirects to. Registered with Simkl as part of
/// `scrobble_simkl::REDIRECT_URI`, byte for byte; a test there pins the two
/// together so neither can drift.
pub const SIMKL_CALLBACK_PATH: &str = "/oauth/callback/simkl";

/// How long a minted nonce stays redeemable. Long enough for a slow
/// sign-in (find the password, 2FA prompt, pick an account) but short
/// enough that an abandoned attempt cannot be redeemed hours later.
const NONCE_TTL: Duration = Duration::from_secs(15 * 60);

/// Hard cap on in-flight nonces. A user can realistically only have one or
/// two flows open; the cap keeps a pathological caller from growing the map
/// without bound (see the "bound every cache" rule in CLAUDE.md). Oldest is
/// evicted first.
const MAX_PENDING: usize = 8;

static APP: OnceLock<AppHandle> = OnceLock::new();

/// Capture the AppHandle during setup. Must be called BEFORE
/// `streaming::start_in_process`, because the bridge task has no handle of
/// its own — same pattern `img_proxy::init` uses for its cache dir.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

struct Pending {
    service: String,
    issued:  Instant,
    /// The PKCE `code_verifier` for a flow Aura exchanges itself (Simkl).
    /// `None` for a proxy flow, whose exchange happens on the proxy. Kept in
    /// memory only and zeroed on drop: it is half of what turns a stolen
    /// authorization code into a token.
    pkce_verifier: Option<Zeroizing<String>>,
}

static PENDING: OnceLock<Mutex<HashMap<String, Pending>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, Pending>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Mint a single-use nonce bound to `service`. Called when the user starts
/// a flow; the value travels to the proxy and back.
pub fn issue_nonce(service: &str) -> String {
    insert_pending(service, None)
}

/// Mint a single-use OAuth `state` for a flow Aura exchanges itself, holding
/// its PKCE verifier until the provider redirects back. Same rules as a proxy
/// nonce: single use, `NONCE_TTL`, at most `MAX_PENDING` in flight, so a
/// declined or abandoned consent expires on its own.
pub(crate) fn issue_pkce_state(service: &str, verifier: Zeroizing<String>) -> String {
    insert_pending(service, Some(verifier))
}

fn insert_pending(service: &str, pkce_verifier: Option<Zeroizing<String>>) -> String {
    let nonce = uuid::Uuid::new_v4().to_string();
    if let Ok(mut map) = pending().lock() {
        map.retain(|_, p| p.issued.elapsed() < NONCE_TTL);
        while map.len() >= MAX_PENDING {
            let oldest = map
                .iter()
                .min_by_key(|(_, p)| p.issued)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => { map.remove(&k); }
                None    => break,
            }
        }
        map.insert(
            nonce.clone(),
            Pending { service: service.to_string(), issued: Instant::now(), pkce_verifier },
        );
    }
    nonce
}

/// Redeem a nonce, returning the record it was minted with. Single-use:
/// a second redemption of the same value fails.
fn consume_nonce(nonce: &str) -> Option<Pending> {
    let mut map = pending().lock().ok()?;
    map.retain(|_, p| p.issued.elapsed() < NONCE_TTL);
    map.remove(nonce)
}

/// Minimal self-contained result page. No external resources (the user's
/// browser has no reason to reach out to anything for this), and it tries
/// `window.close()` for the case where the tab was script-opened.
fn page(title: &str, headline: &str, body: &str, ok: bool) -> Html<String> {
    page_with_accent(title, headline, body, if ok { "#8ad6a0" } else { "#e88a92" })
}

/// `page` with a caller-chosen headline colour, for the one outcome that is
/// neither a success nor a failure: the user declining on purpose.
///
/// Every string reaching this is a constant from this module. Never pass it
/// text from the query string or a provider response: it is interpolated
/// into HTML unescaped.
fn page_with_accent(title: &str, headline: &str, body: &str, accent: &str) -> Html<String> {
    Html(format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\
<title>{title}</title><style>\
:root{{color-scheme:dark light}}\
body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;\
background:#101216;color:#e7e9ee;\
font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}}\
.card{{max-width:26rem;padding:2rem 2.25rem;border-radius:14px;\
background:#171a20;border:1px solid #262a33;text-align:center}}\
h1{{margin:0 0 .5rem;font-size:1.15rem;font-weight:600;color:{accent}}}\
p{{margin:0;color:#a8adb8;font-size:.9rem}}\
</style></head><body><div class=\"card\"><h1>{headline}</h1><p>{body}</p></div>\
<script>setTimeout(function(){{try{{window.close()}}catch(e){{}}}},1200)</script>\
</body></html>",
    ))
}

/// The "start again" page every refused callback gets: nothing about WHY is
/// shown, since the reasons (unknown, expired, replayed, wrong route) are all
/// the same instruction to the user.
fn expired_page() -> Response {
    (
        StatusCode::BAD_REQUEST,
        page(
            "Aura",
            "That sign-in link has expired",
            "Start the connection again from Aura's Settings page.",
            false,
        ),
    )
        .into_response()
}

/// `GET /oauth/callback` — the proxy's final redirect target.
///
/// Expects `nonce` plus the same token params the `aura://` deep-link
/// carries (`token`, `refresh`, `expires`, `user`). Rebuilds the deep-link
/// URL and emits it, then brings Aura to the front so the user lands back
/// on the app they started from.
pub async fn handle(Query(params): Query<HashMap<String, String>>) -> Response {
    let nonce = params.get("nonce").map(String::as_str).unwrap_or_default();

    // Fail closed. An absent, expired, replayed or simply wrong nonce means
    // this callback is not one Aura started, so it never reaches the token
    // persistence path.
    let service = match consume_nonce(nonce) {
        Some(p) if p.pkce_verifier.is_none() => p.service,
        // A PKCE state only ever comes back on its provider's own route, with
        // a code rather than a token. Presented here it is forged or
        // misrouted, and this route takes the token from the query string, so
        // it is refused (and, being consumed, cannot be tried again).
        Some(p) => {
            crate::devlog!(
                warn, "scrobble",
                "oauth loopback callback REJECTED: a {} PKCE state arrived on the proxy route",
                p.service,
            );
            return expired_page();
        }
        None => {
            crate::devlog!(
                warn, "scrobble",
                "oauth loopback callback REJECTED: unknown / expired / replayed nonce",
            );
            return expired_page();
        }
    };

    // A callback with no token is the provider or proxy telling us the user
    // declined (or something failed upstream). Surface it as a clean cancel
    // rather than persisting an empty credential.
    let token = params.get("token").map(String::as_str).unwrap_or_default();
    if token.is_empty() {
        crate::devlog!(
            warn, "scrobble",
            "oauth loopback callback for {service} carried no token (declined or proxy error)",
        );
        return (
            StatusCode::BAD_REQUEST,
            page(
                "Aura",
                "Authorization was not completed",
                "No token came back. You can close this tab and try again from Aura.",
                false,
            ),
        )
            .into_response();
    }

    // Only the four params App.tsx reads are forwarded: `nonce` deliberately
    // is not, so it never lands in a log line or the frontend's URL parsing.
    let pairs: Vec<(&str, &str)> = ["token", "refresh", "expires", "user"]
        .into_iter()
        .filter_map(|key| params.get(key).map(|v| (key, v.as_str())))
        .collect();
    deliver(&service, &pairs)
}

/// Rebuild the deep-link URL App.tsx already knows how to parse from
/// `pairs` (empty values dropped), emit it on the `deep-link` channel, pull
/// Aura to the front, and answer the browser with the "connected" page. The
/// one exit both loopback routes share, so a token only ever reaches the
/// keyring through `set_scrobble_auth_token`.
fn deliver(service: &str, pairs: &[(&str, &str)]) -> Response {
    let mut deep_link = match Url::parse(&format!("aura://oauth/{service}")) {
        Ok(u) => u,
        Err(e) => {
            crate::devlog!(warn, "scrobble", "oauth loopback: deep-link build failed: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                page("Aura", "Something went wrong", "Please try again from Aura.", false),
            )
                .into_response();
        }
    };
    {
        let mut qp = deep_link.query_pairs_mut();
        for &(key, v) in pairs {
            if !v.is_empty() {
                qp.append_pair(key, v);
            }
        }
    }
    let deep_link = deep_link.to_string();

    crate::devlog!(
        info, "scrobble",
        "oauth loopback callback accepted for {service}: {}",
        crate::scrobble_auth::redact_oauth_url(&deep_link),
    );

    match APP.get() {
        Some(app) => {
            let _ = app.emit("deep-link", deep_link);
            // The user's attention is in the browser right now; pull Aura
            // forward so the "Connected as <user>" toast is actually seen.
            if let Some(win) = app.get_webview_window("main") {
                // show() first for the same reason as tray::show_main_window:
                // a tray-hidden window is hidden AND minimized, and a bare
                // unminimize() on it would SW_RESTORE then be re-hidden in the
                // same tao flag pass, leaving a hidden window with WS_MINIMIZE
                // cleared. That is invisible here and disarms the animation on
                // the NEXT tray click. Deliberately not routed through
                // tray::show_main_window: that also emits
                // aura:window-restored-from-tray, whose refresh_video nudge has
                // a documented expand-then-shrink flicker, and an OAuth
                // completion can land mid-playback.
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }
        None => {
            // init() runs before the bridge starts, so this is unreachable in
            // practice — but losing a token silently is exactly the class of
            // failure the silent-failure audit was about, so it is loud.
            crate::devlog!(
                error, "scrobble",
                "oauth loopback callback for {service} arrived before init() — token DROPPED",
            );
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                page("Aura", "Aura was not ready", "Please try connecting again.", false),
            )
                .into_response();
        }
    }

    page(
        "Aura",
        "You're connected",
        "Aura has the authorization. You can close this tab.",
        true,
    )
    .into_response()
}

/// `GET /oauth/callback/simkl`: Simkl's redirect target (AUTH V2).
///
/// Simkl answers with `code` + `state` + `iss` on approval and with
/// `error=access_denied` + `state` + `iss` on refusal. The state is redeemed
/// FIRST on both paths, so a decline also retires it and a replay of either
/// fails closed. On approval the code is exchanged here (no secret: Aura is a
/// public PKCE client), the display name is read best-effort, and the pair
/// leaves through `deliver` as
/// `aura://oauth/simkl?token=&refresh=&expires=&user=`, with `expires` in
/// absolute unix seconds as App.tsx and `set_scrobble_auth_token` expect.
pub async fn handle_simkl(Query(params): Query<HashMap<String, String>>) -> Response {
    let state = params.get("state").map(String::as_str).unwrap_or_default();
    let verifier = match consume_nonce(state) {
        Some(Pending { service, pkce_verifier: Some(verifier), .. }) if service == "simkl" => {
            verifier
        }
        _ => {
            crate::devlog!(
                warn, "scrobble",
                "Simkl oauth callback REJECTED: unknown / expired / replayed state",
            );
            return expired_page();
        }
    };

    // RFC 9207 mix-up defence, which Simkl's docs ask every client to make:
    // a response naming any other issuer is refused before the code goes
    // anywhere. An absent `iss` is let through: AUTH V2 always sends it, and
    // the state above already proves Aura started this flow.
    if let Some(iss) = params.get("iss") {
        if iss != crate::scrobble_simkl::ISSUER {
            crate::devlog!(
                warn, "scrobble",
                "Simkl oauth callback REJECTED: issuer is not {}",
                crate::scrobble_simkl::ISSUER,
            );
            return (
                StatusCode::BAD_REQUEST,
                page(
                    "Aura",
                    "That response did not come from Simkl",
                    "Nothing was connected. Start the connection again from Aura's Settings page.",
                    false,
                ),
            )
                .into_response();
        }
    }

    if let Some(error) = params.get("error").filter(|e| !e.is_empty()) {
        if error == "access_denied" {
            crate::devlog!(info, "scrobble", "Simkl sign-in declined by the user; nothing stored");
            return page_with_accent(
                "Aura",
                "You declined",
                "Nothing was connected. You can close this tab.",
                "#a9b8d0",
            )
            .into_response();
        }
        // Log only a plain error code; the value came off the query string.
        let code: String = error
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
            .take(40)
            .collect();
        crate::devlog!(warn, "scrobble", "Simkl sign-in came back with error={code}");
        return (
            StatusCode::BAD_REQUEST,
            page(
                "Aura",
                "Simkl did not complete the sign-in",
                "Nothing was connected. You can close this tab and try again from Aura.",
                false,
            ),
        )
            .into_response();
    }

    let code = params.get("code").map(String::as_str).unwrap_or_default();
    if code.is_empty() {
        crate::devlog!(
            warn, "scrobble",
            "Simkl oauth callback carried neither a code nor an error",
        );
        return (
            StatusCode::BAD_REQUEST,
            page(
                "Aura",
                "Authorization was not completed",
                "No code came back. You can close this tab and try again from Aura.",
                false,
            ),
        )
            .into_response();
    }

    use crate::scrobble_simkl::ExchangeError;
    let grant = match crate::scrobble_simkl::exchange_code(code, &verifier).await {
        Ok(grant) => grant,
        Err(ExchangeError::InvalidClient) => {
            return (
                StatusCode::BAD_GATEWAY,
                page(
                    "Aura",
                    "Simkl sign-in is not enabled for this app",
                    "Simkl rejected Aura's client id. The app has to be registered for OAuth 2.0 \
                     (AUTH V2) as a desktop app in Simkl's developer settings. Nothing was connected.",
                    false,
                ),
            )
                .into_response();
        }
        Err(ExchangeError::ReadOnly) => {
            return (
                StatusCode::BAD_GATEWAY,
                page(
                    "Aura",
                    "Simkl granted read-only access",
                    "Aura needs permission to update your Simkl history. Nothing was connected; \
                     try connecting again from Aura.",
                    false,
                ),
            )
                .into_response();
        }
        Err(ExchangeError::NotConfigured | ExchangeError::Rejected | ExchangeError::Transient) => {
            return (
                StatusCode::BAD_GATEWAY,
                page(
                    "Aura",
                    "Could not finish connecting to Simkl",
                    "The sign-in code could not be exchanged. Try connecting again from Aura.",
                    false,
                ),
            )
                .into_response();
        }
    };

    let user = crate::scrobble_simkl::fetch_username(&grant.access_token).await;
    let expires = grant.expires_at.to_string();
    deliver(
        "simkl",
        &[
            ("token",   grant.access_token.as_str()),
            ("refresh", grant.refresh_token.as_deref().unwrap_or_default()),
            ("expires", expires.as_str()),
            ("user",    user.as_deref().unwrap_or_default()),
        ],
    )
}
