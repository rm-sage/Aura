// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Streaming bridge — in-process axum server on `127.0.0.1:11471`.
//!
//! History: the proxy spent a while as a separate `aura-bridge` sidecar
//! binary (spawned/killed by lib.rs, staged into `bundle.externalBin` by
//! `scripts/stage-bridge.cjs` at release time, and living in a git-ignored
//! private crate). That meant source builds needed a separately-built binary
//! or plain-HTTP streams silently lost proxying, and bridge fixes lived
//! outside version control. Re-internalised: the same axum router now runs on
//! Tauri's shared tokio runtime inside the main process — nothing to bundle,
//! stage, spawn, or reap; it dies with the process, and the code is tracked.
//!
//! Routes:
//!   GET /health           → liveness probe
//!   GET /proxy/<encoded>  → byte-range / live proxy for plain-HTTP URLs
//!   GET /magnet/<encoded> → reserved (501 — Aura is Stremio-addon-only)
//!
//! `resolve_stream` below decides per-URL whether MPV goes through the proxy
//! (single-file plain HTTP) or connects directly (HTTPS, and ALL HLS — see
//! the routing rules on the command).

use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::Duration;

use axum::{
    body::Body,
    extract::Path as AxumPath,
    http::{HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::StreamExt;

pub const BRIDGE_PORT: u16 = 11471;

// ---------------------------------------------------------------------------
// In-process server
// ---------------------------------------------------------------------------

/// Shared HTTP client for proxying. Created lazily on first request and
/// reused — keeps connection pools warm and avoids per-request TLS
/// handshake overhead.
static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn proxy_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Deliberately NOT a whole-request `.timeout()`. A live `.ts` is a
            // single never-ending GET; a total timeout aborts it mid-stream and
            // kills live playback. `read_timeout` is a per-read INACTIVITY
            // timeout: a healthy stream — VOD byte-range or continuous live —
            // keeps delivering bytes and never trips it; only a genuine stall
            // fires it. `connect_timeout` still bounds the handshake.
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(30))
            .user_agent(concat!("aura-bridge/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::limited(5))
            // SSRF guard on the CONNECT hop: a hostname that resolves only to a
            // private / loopback / link-local / cloud-metadata address is
            // refused, and every connection re-resolves so a DNS-rebind is caught
            // on the exploiting hop. IP-literal hosts are checked up front in
            // `proxy_stream` (the resolver only runs for hostnames). Shared with
            // img_proxy so both fetchers enforce the same policy.
            .dns_resolver(std::sync::Arc::new(crate::img_proxy::SsrfGuardResolver))
            .build()
            .expect("Proxy HTTP client init failed")
    })
}

async fn health() -> &'static str {
    "ok"
}

/// Proxy a plain-HTTP stream URL through the bridge. Forwards the upstream's
/// range headers (incl. `accept-ranges` only when present), the client's
/// `Range`, and the client's `User-Agent`, then streams the body back.
async fn proxy_stream(
    AxumPath(encoded): AxumPath<String>,
    req_headers: axum::http::HeaderMap,
) -> Response {
    let url = match percent_decode(&encoded) {
        Some(u) => u,
        None => return (StatusCode::BAD_REQUEST, "Invalid URL encoding").into_response(),
    };

    if !url.starts_with("http://") && !url.starts_with("https://") {
        return (StatusCode::BAD_REQUEST, "Only http/https stream URLs are supported")
            .into_response();
    }

    // SSRF guard. Without it, a web page in the user's browser could
    // `fetch("http://127.0.0.1:11471/proxy/http://192.168.1.1/...")` while Aura
    // is running and use the bridge as a same-machine port scanner / internal
    // service reader that bypasses the browser's same-origin policy. An
    // IP-LITERAL host is validated HERE (the connect-time resolver only runs for
    // hostnames); a hostname passes here and is enforced on connect by the
    // SsrfGuardResolver above.
    match reqwest::Url::parse(&url) {
        Ok(parsed) if crate::img_proxy::host_is_public(&parsed) => {}
        _ => {
            return (StatusCode::FORBIDDEN, "blocked: non-public host").into_response();
        }
    }

    let mut builder = proxy_client().get(&url);
    if let Some(range) = req_headers.get("range") {
        builder = builder.header("range", range);
    }
    // Forward MPV's own User-Agent (Lavf/…) instead of the client default
    // (aura-bridge/…). IPTV providers routinely gate on User-Agent and reject
    // unknown ones, so a proxied single-file `.ts` would 403 where standalone
    // mpv — sending the same Lavf UA — succeeds.
    if let Some(ua) = req_headers.get("user-agent") {
        builder = builder.header("user-agent", ua);
    }

    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("Upstream error: {e}")).into_response()
        }
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();

    let stream = upstream
        .bytes_stream()
        .map(|r| r.map_err(std::io::Error::other));
    let body = Body::from_stream(stream);

    let mut resp = Response::builder().status(status);
    if let Some(headers) = resp.headers_mut() {
        // Forward range-relevant headers EXACTLY as upstream sent them —
        // including `accept-ranges` only when present. Do NOT fabricate
        // `accept-ranges: bytes`: a live origin is typically non-seekable, and
        // advertising byte-range support invites MPV to issue Range seeks the
        // server answers with a 200 (full/live-edge) instead of a 206,
        // breaking scrub/restart on live channels.
        for name_str in ["content-type", "content-length", "content-range", "accept-ranges"] {
            if let Some(val) = upstream_headers.get(name_str) {
                if let Ok(name) = HeaderName::from_bytes(name_str.as_bytes()) {
                    headers.insert(name, val.clone());
                }
            }
        }
        // CORS — so hls.js running in the WebView can fetch IPTV segments
        // through the bridge for the Multiview grid. Reflect ONLY the WebView's
        // own origin, never `*`: loopback binding does not stop a browser page
        // the user visits from calling the bridge, and `*` would let that page
        // READ the response cross-origin (an egress proxy attributable to the
        // victim's IP). MPV ignores CORS, so the native path is unaffected.
        add_cors(headers, req_headers.get("origin"));
    }

    resp.body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// CORS preflight for the proxy route — hls.js's Range-bearing segment GETs
/// trigger an OPTIONS preflight. Reflects only the WebView origin.
async fn proxy_preflight(req_headers: axum::http::HeaderMap) -> Response {
    let mut resp = Response::builder().status(StatusCode::NO_CONTENT);
    if let Some(headers) = resp.headers_mut() {
        add_cors(headers, req_headers.get("origin"));
        headers.insert(
            HeaderName::from_static("access-control-allow-methods"),
            HeaderValue::from_static("GET, OPTIONS"),
        );
        headers.insert(
            HeaderName::from_static("access-control-max-age"),
            HeaderValue::from_static("600"),
        );
    }
    resp.body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// The origins the WebView UI is served from. hls.js runs here; a page in the
/// user's normal browser does not, so it never gets a reflected ACAO and cannot
/// read a proxied response cross-origin. `tauri.localhost` is the packaged
/// WebView2 origin; `localhost:1420` is the Vite dev server.
fn is_webview_origin(origin: &str) -> bool {
    matches!(
        origin,
        "http://tauri.localhost"
            | "https://tauri.localhost"
            | "http://localhost:1420"
            | "https://localhost:1420"
    )
}

fn add_cors(headers: &mut axum::http::HeaderMap, origin: Option<&HeaderValue>) {
    // Reflect the request Origin only when it is the WebView's own. No match ->
    // no ACAO header at all, so a cross-origin read fails. `*` is never sent.
    let allowed = origin
        .and_then(|v| v.to_str().ok())
        .filter(|o| is_webview_origin(o))
        .and_then(|o| HeaderValue::from_str(o).ok());
    let Some(origin_val) = allowed else { return };
    headers.insert(
        HeaderName::from_static("access-control-allow-origin"),
        origin_val,
    );
    // Vary on Origin so a cache never serves one origin's reflected value to
    // another.
    headers.insert(
        HeaderName::from_static("vary"),
        HeaderValue::from_static("Origin"),
    );
    headers.insert(
        HeaderName::from_static("access-control-allow-headers"),
        HeaderValue::from_static("range, content-type"),
    );
    headers.insert(
        HeaderName::from_static("access-control-expose-headers"),
        HeaderValue::from_static("content-length, content-range, accept-ranges"),
    );
}

/// Reserved magnet endpoint. Permanently 501 — Aura is Stremio-addon-only
/// with Debrid; there is no native torrent engine and none is planned.
async fn magnet_stream(AxumPath(_encoded): AxumPath<String>) -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        "Torrent streaming is not enabled.",
    )
        .into_response()
}

/// Start the bridge server on Tauri's shared tokio runtime. Called once from
/// `lib.rs` setup; the task lives for the process lifetime and dies with it
/// (no graceful-shutdown choreography needed — the listener is loopback-only
/// and holds no state).
///
/// Bind failure (e.g. an orphaned `aura-bridge.exe` from a pre-internalisation
/// install still squatting on 11471) is logged and swallowed: only plain-HTTP
/// streams need the proxy; HTTPS and HLS streams bypass the bridge entirely
/// and keep working.
pub fn start_in_process() {
    tauri::async_runtime::spawn(async {
        let app = Router::new()
            .route("/health", get(health))
            .route("/proxy/*encoded", get(proxy_stream).options(proxy_preflight))
            .route("/magnet/*encoded", get(magnet_stream))
            // On-device poster resize-and-cache proxy (img_proxy.rs).
            .route("/img", get(crate::img_proxy::handle));

        let addr = SocketAddr::from(([127, 0, 0, 1], BRIDGE_PORT));
        let listener = match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => l,
            Err(e) => {
                crate::devlog!(
                    warn, "bridge",
                    "failed to bind {addr}: {e} — plain-HTTP stream proxying disabled \
                     (HTTPS / HLS streams are unaffected; they bypass the bridge). If an \
                     old aura-bridge.exe is still running from a previous install, close it.",
                );
                return;
            }
        };
        crate::devlog!(info, "bridge", "in-process bridge listening on http://{addr}");
        if let Err(e) = axum::serve(listener, app).await {
            crate::devlog!(warn, "bridge", "bridge server error: {e}");
        }
    });
}

/// Percent-decode the path-segment encoding `percent_encode` produces.
/// Accumulates raw BYTES and decodes as UTF-8 once — a per-byte `as char`
/// cast would map each byte to a Latin-1 code point and corrupt multi-byte
/// UTF-8 characters in the URL.
fn percent_decode(s: &str) -> Option<String> {
    let s = s.replace('+', " ");
    let mut out: Vec<u8> = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next()? as char;
            let lo = bytes.next()? as char;
            let code = u8::from_str_radix(&format!("{hi}{lo}"), 16).ok()?;
            out.push(code);
        } else {
            out.push(b);
        }
    }
    Some(String::from_utf8_lossy(&out).into_owned())
}

// ---------------------------------------------------------------------------
// Tauri command — resolve a stream URL to a bridge-proxied URL
// ---------------------------------------------------------------------------

/// Convert a raw stream URL into the form MPV should load.
///
/// Routing rules:
/// - `magnet:`      → bridge magnet endpoint (501 — no torrent engine).
/// - HLS (.m3u8/.m3u, HTTP or HTTPS) → DIRECT to MPV (see is_hls / below).
/// - `https://`     → returned **verbatim**. MPV speaks HTTPS natively, supports
///                    byte-range, and the bridge would only add round-trip cost
///                    (and break VPS hosts whose TLS cert is signed for the
///                    direct domain — the bridge is `127.0.0.1`).
/// - `http://`      → in-process bridge proxy (single-file plain-HTTP streams).
/// - other          → returned as-is (MPV decides what to do).
///
/// `via_proxy` (Live TV per-playlist proxy): when true, plain-HTTP URLs are
/// returned DIRECT instead of through the local bridge, because mpv is tunneling
/// everything through its `http-proxy` for this load — routing through the
/// 127.0.0.1 bridge would make mpv ask the remote proxy to fetch loopback.
///
/// The parameter is named `raw_url` (not `url`) so the JS caller passes
/// `{ rawUrl: ... }` — keeping the call-site explicit about what shape it is.
#[tauri::command]
pub async fn resolve_stream(raw_url: String, via_proxy: Option<bool>) -> Result<String, String> {
    let lower = raw_url.to_lowercase();

    if lower.starts_with("magnet:") {
        let encoded = percent_encode(&raw_url);
        crate::devlog!(info, "bridge", "resolve_stream(magnet) → bridge magnet endpoint");
        return Ok(format!("http://127.0.0.1:{BRIDGE_PORT}/magnet/{encoded}"));
    }

    // HLS manifests (.m3u8 / .m3u) are NEVER proxied — for HTTP or HTTPS.
    // MPV resolves the segment / variant / key URIs inside a manifest
    // RELATIVE to the URL it loaded. A proxied manifest therefore makes MPV
    // resolve those against the 127.0.0.1 bridge:
    //   - an absolute-path segment ("/live/.../seg.ts", very common) resolves
    //     to http://127.0.0.1:11471/live/... — a route the bridge doesn't
    //     serve → 404 → playback dies;
    //   - and the bridge fetches the manifest with its OWN User-Agent, which
    //     IPTV providers routinely gate (they accept MPV's Lavf UA but reject
    //     unknown ones).
    // Letting MPV fetch HLS directly makes Aura behave exactly like standalone
    // mpv (its own player UA, segments resolved against the real origin) — the
    // same reason HTTPS already bypasses below.
    if is_hls(&lower) {
        crate::devlog!(info, "bridge", "resolve_stream(hls) → direct (no proxy)");
        return Ok(raw_url);
    }

    // HTTPS: no proxy. Bypass keeps MPV connecting straight to the upstream
    // host so its TLS cert validates and we don't double-buffer through the
    // local axum server. This is what the user expects for VPS-hosted streams
    // (e.g. stremthru.animasec.dev).
    if lower.starts_with("https://") {
        crate::devlog!(info, "bridge", "resolve_stream(https) → direct (no proxy)");
        return Ok(raw_url);
    }

    // Plaintext HTTP: route through the in-process bridge so we can add headers
    // / fix up byte-range edge cases. Cheap enough on the loopback interface.
    // EXCEPT when this load is proxied (via_proxy) — then mpv tunnels through
    // its http-proxy and must reach the origin directly, not the loopback
    // bridge.
    if lower.starts_with("http://") {
        if via_proxy == Some(true) {
            crate::devlog!(info, "bridge", "resolve_stream(http, via proxy) → direct");
            return Ok(raw_url);
        }
        let encoded = percent_encode(&raw_url);
        crate::devlog!(info, "bridge", "resolve_stream(http) → bridge proxy");
        return Ok(format!("http://127.0.0.1:{BRIDGE_PORT}/proxy/{encoded}"));
    }

    crate::devlog!(warn, "bridge", "resolve_stream(unknown scheme) → passthrough");
    Ok(raw_url)
}

/// HLS manifest? Decided by the path extension, ignoring any query string
/// (`…/517527.m3u8?token=…`). HLS must bypass the bridge — see resolve_stream.
fn is_hls(lower_url: &str) -> bool {
    let path = lower_url.split('?').next().unwrap_or(lower_url);
    path.ends_with(".m3u8") || path.ends_with(".m3u")
}

// ---------------------------------------------------------------------------
// Percent-encode helper — produces the path-segment encoding the bridge
// expects on its /proxy/* and /magnet/* routes.
// ---------------------------------------------------------------------------

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'~' | b'/' | b':' | b'?' | b'=' | b'&' => {
                out.push(b as char)
            }
            _ => {
                out.push('%');
                out.push(char::from_digit((b >> 4) as u32, 16).unwrap().to_ascii_uppercase());
                out.push(char::from_digit((b & 0xf) as u32, 16).unwrap().to_ascii_uppercase());
            }
        }
    }
    out
}
