/// Streaming bridge — local HTTP proxy on port 11471.
///
/// Most Stremio addon streams are HTTPS URLs that MPV can load directly.
/// The bridge adds value by:
///   1. Forwarding byte-range requests so MPV can seek without buffering.
///   2. Acting as a single stable origin for future auth-header injection.
///   3. Providing the endpoint that the magnet/torrent engine will serve from
///      (torrent engine integration is a future task — see TODO below).
use std::net::SocketAddr;
use std::sync::OnceLock;
use std::time::Duration;

use axum::{
    body::Body,
    extract::Path,
    http::{HeaderName, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

pub const BRIDGE_PORT: u16 = 11471;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeConfig {
    /// Root directory for torrent/piece cache.
    pub cache_root: String,
    /// Maximum on-disk cache in gigabytes.
    pub cache_size_gb: u64,
    /// Maximum simultaneous peer connections (mirrors server-settings.json).
    pub max_connections: usize,
}

impl Default for BridgeConfig {
    fn default() -> Self {
        Self {
            cache_root: "E:\\AuraCache".into(),
            cache_size_gb: 10,
            max_connections: 55,
        }
    }
}

// ---------------------------------------------------------------------------
// Shared HTTP client for proxying
// ---------------------------------------------------------------------------

static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn proxy_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("Aura/0.1")
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("Proxy HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async fn health() -> &'static str {
    "ok"
}

/// Proxy an HTTP/HTTPS stream URL through the bridge.
/// Preserves Content-Type, Content-Length, Content-Range, and Accept-Ranges so
/// MPV can perform byte-range seeks against the upstream server.
/// The upstream Range header (if MPV sent one) is forwarded as-is.
async fn proxy_stream(
    Path(encoded): Path<String>,
    req_headers: axum::http::HeaderMap,
) -> Response {
    // Percent-decode the path segment
    let url = match percent_decode(&encoded) {
        Some(u) => u,
        None => {
            return (StatusCode::BAD_REQUEST, "Invalid URL encoding").into_response()
        }
    };

    if !url.starts_with("http://") && !url.starts_with("https://") {
        return (StatusCode::BAD_REQUEST, "Only http/https stream URLs are supported")
            .into_response();
    }

    let mut builder = proxy_client().get(&url);
    // Forward the Range header so MPV can seek
    if let Some(range) = req_headers.get("range") {
        builder = builder.header("range", range);
    }

    let upstream = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::BAD_GATEWAY, format!("Upstream error: {e}")).into_response()
        }
    };

    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();

    // Convert reqwest streaming body to axum Body (zero-copy pipe)
    let stream = upstream
        .bytes_stream()
        .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));

    let body = Body::from_stream(stream);

    let mut resp = Response::builder().status(status);
    if let Some(headers) = resp.headers_mut() {
        for name_str in ["content-type", "content-length", "content-range", "accept-ranges"] {
            if let Some(val) = upstream_headers.get(name_str) {
                if let Ok(name) = HeaderName::from_bytes(name_str.as_bytes()) {
                    headers.insert(name, val.clone());
                }
            }
        }
        // Signal byte-range support so MPV knows it can seek
        headers.insert(
            HeaderName::from_static("accept-ranges"),
            HeaderValue::from_static("bytes"),
        );
    }

    resp.body(body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Placeholder route for magnet-link / infohash streams.
///
/// TODO (Task 2.4+): integrate a torrent engine (e.g. librqbit) here.
/// The engine should:
///   1. Parse the infohash from the magnet URI.
///   2. Connect to DHT/trackers and start piece selection.
///   3. Serve the file as a byte-range HTTP stream from this endpoint.
///   4. Cache pieces to config.cache_root to allow resume.
async fn magnet_stream(Path(encoded): Path<String>) -> Response {
    let _ = encoded; // suppress unused-variable warning while stubbed
    (
        StatusCode::NOT_IMPLEMENTED,
        "Torrent streaming is not yet enabled. \
         Install the torrent engine module to stream magnet links.",
    )
        .into_response()
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

pub async fn start(_config: BridgeConfig) {
    let app = Router::new()
        .route("/health", get(health))
        .route("/proxy/*encoded", get(proxy_stream))
        .route("/magnet/*encoded", get(magnet_stream));

    let addr = SocketAddr::from(([127, 0, 0, 1], BRIDGE_PORT));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[bridge] Failed to bind {addr}: {e}");
            return;
        }
    };

    println!("[bridge] Listening on http://{addr}");

    if let Err(e) = axum::serve(listener, app).await {
        eprintln!("[bridge] Server error: {e}");
    }
}

// ---------------------------------------------------------------------------
// Tauri command — resolve a stream URL to a bridge-proxied URL
// ---------------------------------------------------------------------------

/// Convert a raw stream URL into the form MPV should load.
///
/// - HTTP/HTTPS URLs: returns a bridge proxy URL so byte-range forwarding
///   and future auth-header injection work correctly.
/// - Magnet links: returns the bridge magnet endpoint (currently 501 until the
///   torrent engine is integrated).
/// - Other: returned as-is (MPV may or may not handle them).
#[tauri::command]
pub async fn resolve_stream(url: String) -> Result<String, String> {
    if url.starts_with("magnet:") {
        let encoded = percent_encode(&url);
        return Ok(format!("http://127.0.0.1:{BRIDGE_PORT}/magnet/{encoded}"));
    }

    if url.starts_with("http://") || url.starts_with("https://") {
        let encoded = percent_encode(&url);
        return Ok(format!("http://127.0.0.1:{BRIDGE_PORT}/proxy/{encoded}"));
    }

    Ok(url)
}

// ---------------------------------------------------------------------------
// Percent-encode / decode helpers (no external dep needed)
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

fn percent_decode(s: &str) -> Option<String> {
    let s = s.replace('+', " ");
    let mut out = String::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = bytes.next()? as char;
            let lo = bytes.next()? as char;
            let code = u8::from_str_radix(&format!("{hi}{lo}"), 16).ok()?;
            out.push(code as char);
        } else {
            out.push(b as char);
        }
    }
    Some(out)
}
