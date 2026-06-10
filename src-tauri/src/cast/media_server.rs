// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Cast media server — a LAN-reachable (`0.0.0.0`) axum listener that
//! re-serves the upstream stream to the cast device.
//!
//! Why it exists (vs the loopback streaming bridge in `streaming.rs`):
//! a TV cannot fetch `127.0.0.1`, debrid upstreams are HTTPS with
//! byte-range semantics some renderers fumble, and several receivers
//! reject `application/octet-stream`. So the device gets a plain-HTTP
//! LAN URL, and Aura server-side-fetches the real upstream (range
//! headers forwarded, MIME forced to a video type, permissive CORS).
//! This HTTPS→HTTP re-serve is a SANCTIONED divergence from
//! `resolve_stream`'s HTTPS-bypass — it applies to the cast path only
//! and must never leak into local playback.
//!
//! The listener is LAZY: it binds on the first cast (which is also when
//! Windows Firewall prompts) rather than at app startup, so users who
//! never cast never expose a LAN port. Sessions are UUID-pathed and
//! cleared when casting stops.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use axum::{
    body::Body,
    extract::Path as AxumPath,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::StreamExt;

struct ProxySession {
    upstream: String,
}

/// Bound port (0 = not started yet) + the session table.
static PORT: OnceLock<u16> = OnceLock::new();
/// Serialises first-start so two concurrent first casts can't both bind
/// (the loser's listener would be orphaned and its caller handed a port
/// nothing listens on). tokio Mutex because the bind awaits inside the
/// critical section.
static START_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static SESSIONS: OnceLock<Mutex<HashMap<String, ProxySession>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, ProxySession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

static UPSTREAM_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn upstream_client() -> &'static reqwest::Client {
    UPSTREAM_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // No overall timeout — a cast session streams for hours; rely
            // on connect timeout + the device closing its socket.
            .connect_timeout(Duration::from_secs(15))
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("cast upstream client init failed")
    })
}

/// Register an upstream for casting and return the LAN URL the device
/// should load. Starts the listener on first use.
pub async fn register_cast(upstream: &str, device_host: &str) -> Result<String, String> {
    let port = ensure_started().await?;
    let ip = reachable_ip_for(device_host).unwrap_or_else(lan_ip_fallback);
    let id = uuid::Uuid::new_v4().to_string();
    sessions()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), ProxySession { upstream: upstream.to_string() });
    let url = format!("http://{ip}:{port}/s/{id}");
    crate::devlog!(
        info, "cast",
        "media server session {id} → {} (serving at {url})",
        crate::stremio::redact_sensitive_url(upstream),
    );
    Ok(url)
}

/// Drop all proxy sessions (called when casting stops). The listener
/// itself stays up for the process lifetime once started — rebinding
/// per cast would re-trigger firewall prompts.
pub fn clear_sessions() {
    if let Ok(mut s) = sessions().lock() {
        s.clear();
    }
}

async fn ensure_started() -> Result<u16, String> {
    if let Some(p) = PORT.get() {
        return Ok(*p);
    }
    let _guard = START_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    // Double-check under the lock — a racing first cast may have just
    // finished the bind.
    if let Some(p) = PORT.get() {
        return Ok(*p);
    }
    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/s/:id", get(serve_session).head(serve_session_head));
    let listener = tokio::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0)))
        .await
        .map_err(|e| format!("cast media server bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            crate::devlog!(warn, "cast", "media server error: {e}");
        }
    });
    let _ = PORT.set(port);
    crate::devlog!(info, "cast", "media server listening on 0.0.0.0:{port}");
    Ok(port)
}

async fn serve_session(
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    forward(id, headers, false).await
}

async fn serve_session_head(
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    forward(id, headers, true).await
}

/// Server-side-fetch the upstream and stream it back, preserving the
/// byte-range contract and forcing a cast-friendly MIME.
async fn forward(id: String, req_headers: HeaderMap, head_only: bool) -> Response {
    let upstream = {
        let Ok(map) = sessions().lock() else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        match map.get(&id) {
            Some(s) => s.upstream.clone(),
            None => return (StatusCode::NOT_FOUND, "unknown cast session").into_response(),
        }
    };

    let mut builder = upstream_client().get(&upstream);
    if let Some(range) = req_headers.get("range") {
        builder = builder.header("range", range);
    }
    let upstream_resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "cast", "upstream fetch failed: {e}");
            return (StatusCode::BAD_GATEWAY, format!("Upstream error: {e}")).into_response();
        }
    };

    let status = upstream_resp.status();
    let up_headers = upstream_resp.headers().clone();

    let mut resp = Response::builder().status(status);
    if let Some(h) = resp.headers_mut() {
        for name in ["content-length", "content-range", "accept-ranges"] {
            if let Some(v) = up_headers.get(name) {
                if let Ok(n) = HeaderName::from_bytes(name.as_bytes()) {
                    h.insert(n, v.clone());
                }
            }
        }
        // Cast receivers reject application/octet-stream — force a video
        // MIME when the upstream is unhelpful.
        let ct = up_headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.starts_with("application/octet-stream") && !v.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| guess_mime(&upstream).to_string());
        if let Ok(v) = HeaderValue::from_str(&ct) {
            h.insert(HeaderName::from_static("content-type"), v);
        }
        h.insert(
            HeaderName::from_static("accept-ranges"),
            HeaderValue::from_static("bytes"),
        );
        // Permissive CORS — receiver apps run in a browser sandbox.
        h.insert(
            HeaderName::from_static("access-control-allow-origin"),
            HeaderValue::from_static("*"),
        );
    }

    if head_only {
        return resp.body(Body::empty()).unwrap_or_else(|_| {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        });
    }

    let stream = upstream_resp
        .bytes_stream()
        .map(|r| r.map_err(std::io::Error::other));
    resp.body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

fn guess_mime(url: &str) -> &'static str {
    let path = url.split('?').next().unwrap_or("").to_ascii_lowercase();
    if path.ends_with(".webm") {
        "video/webm"
    } else if path.ends_with(".mkv") {
        "video/x-matroska"
    } else if path.ends_with(".ts") {
        "video/mp2t"
    } else {
        "video/mp4"
    }
}

// ---------------------------------------------------------------------------
// LAN IP selection
// ---------------------------------------------------------------------------

/// The local IP the OS would use to reach `device_host` — a connected
/// (no-traffic) UDP socket makes the kernel pick the right interface,
/// which beats subnet guessing on multi-homed machines (VPN + LAN).
fn reachable_ip_for(device_host: &str) -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect((device_host, 9)).ok()?;
    let ip = sock.local_addr().ok()?.ip();
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    Some(ip.to_string())
}

/// Generic default-route fallback (same trick against a public IP; no
/// packet is actually sent).
fn lan_ip_fallback() -> String {
    std::net::UdpSocket::bind("0.0.0.0:0")
        .ok()
        .and_then(|s| {
            s.connect(("8.8.8.8", 80)).ok()?;
            Some(s.local_addr().ok()?.ip().to_string())
        })
        .unwrap_or_else(|| "127.0.0.1".to_string())
}
