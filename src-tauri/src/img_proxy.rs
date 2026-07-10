// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! img_proxy: on-device poster resize-and-cache proxy.
//!
//! Served as `GET /img?url=<encoded>&w=<px>` on the in-process axum bridge
//! (streaming.rs, `127.0.0.1:11471`). The WebView2 UI points every poster
//! `<img>` here (via `posterSize.ts::shrinkPoster`) so the browser only ever
//! fetches, decodes, and textures a card-sized image. Raw kitsu/anilist anime
//! covers are 3+ MP and were being decoded full-size into ~180px tiles, which
//! is the GPU-texture-memory + scroll-raster cost documented in the library
//! perf notes; resizing to card width in native code fixes that at the source.
//!
//! Why the host does it instead of the webview: to downscale you must first
//! decode, and doing that in JS/canvas still pays the full decode inside the
//! process that janks (the compositor + main thread, sharing the GPU with
//! libmpv). Decoding in native Rust off the webview, disk-caching the small
//! result, means the webview never touches a big image and repeat views cost a
//! localhost read.
//!
//! SECURITY: this fetches arbitrary third-party URLs server-side, so it is an
//! SSRF surface. Mitigations, matching the posture the upstream poster proxy
//! had to add:
//!   • A validating DNS resolver rejects any host that resolves to a non-public
//!     address, enforced at CONNECT time so redirect hops and DNS-rebinding are
//!     covered (each connection re-resolves through the guard).
//!   • A hard streamed byte ceiling (NOT trusting Content-Length, which can lie
//!     and is a no-op on a streaming body).
//!   • A pre-decode PIXEL ceiling read from the image header so a decode bomb is
//!     rejected before any pixels are processed.
//!   • Decode/resize runs on a bounded blocking-thread pool so a burst of tiles
//!     on a weak machine can't swamp the CPU.
//! Any failure degrades to a 302 to the original URL, so a poster never renders
//! worse than it would without the proxy.

use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::extract::Query;
use axum::http::header;
use axum::response::{IntoResponse, Redirect, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

// ── Limits ──────────────────────────────────────────────────────────────────

/// Hard ceiling on bytes read from an upstream image before we abort. Well
/// above any real poster (the 18.8 MP tvmaze originals are ~2 MB) but bounds a
/// hostile or runaway body.
const MAX_FETCH_BYTES: usize = 24 * 1024 * 1024;

/// Pre-decode pixel ceiling. The largest REAL poster observed was ~24.3 MP, so
/// 40 MP leaves headroom while rejecting the 64 MP+ decode bombs whose only cost
/// is CPU/latency (a 40 MP JPEG still decodes cheaply via shrink-on-load).
const MAX_DECODE_PIXELS: u64 = 40 * 1_000_000;

/// Requested widths are clamped into this range; hi-DPI callers pass ~2x CSS px.
/// The ceiling is 4K-wide so a full-bleed backdrop can be delivered sharp on a
/// 4K / ultrawide display (callers pass the physical screen width). Output size
/// scales with `w`, but the INPUT is still bounded by the byte + pixel caps, so a
/// large `w` can't be turned into a decode bomb.
const MIN_TARGET_W: u32 = 64;
const MAX_TARGET_W: u32 = 4096;
const DEFAULT_TARGET_W: u32 = 360;

/// JPEG quality for the re-encoded output. 82 is visually clean for poster art
/// at card size and keeps the cached bytes small.
const OUTPUT_JPEG_QUALITY: u8 = 82;

/// Disk-cache size cap. Evicted oldest-first when exceeded (see `maybe_evict`).
const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;

// ── Global state ──────────────────────────────────────────────────────────────

/// Cache directory, captured from `app_data_dir()` at setup (the bridge task has
/// no AppHandle). None disables caching (still resizes, just never persists).
static CACHE_DIR: OnceLock<Option<PathBuf>> = OnceLock::new();

/// SSRF-guarded HTTP client, distinct from streaming.rs's stream client (which
/// has stream-shaped timeouts and no DNS guard).
static IMG_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// Caps concurrent /img JOBS (fetch buffer + decode + resize) so a burst of
/// tiles can't blow up transient memory OR peg every core on a weak box. Gating
/// the WHOLE job (not just the decode) bounds the in-flight fetch buffers too,
/// since the loopback listener is reachable by any local process, not only the
/// per-origin-throttled webview.
static JOB_SEM: OnceLock<Semaphore> = OnceLock::new();

/// Rough write counter driving periodic, off-thread cache eviction.
static WRITE_COUNT: AtomicU64 = AtomicU64::new(0);

/// Capture the on-device cache directory. Called once from lib.rs setup before
/// the bridge starts. Best-effort: a failed mkdir just disables persistence.
pub fn init(cache_dir: PathBuf) {
    let ok = std::fs::create_dir_all(&cache_dir).is_ok();
    let _ = CACHE_DIR.set(if ok { Some(cache_dir) } else { None });
}

fn cache_dir() -> Option<&'static Path> {
    CACHE_DIR.get().and_then(|o| o.as_deref())
}

fn job_sem() -> &'static Semaphore {
    JOB_SEM.get_or_init(|| {
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        // Leave a core for the UI + audio; clamp so even a many-core box doesn't
        // fan out an unbounded decode burst.
        let permits = cores.saturating_sub(1).clamp(2, 6);
        Semaphore::new(permits)
    })
}

// ── SSRF-guarding DNS resolver ────────────────────────────────────────────────

/// True only for globally-routable unicast addresses. Everything private,
/// loopback, link-local (incl. 169.254.169.254 cloud metadata), CGNAT-shared,
/// documentation/benchmark, and their IPv6 equivalents is rejected. Several of
/// the precise predicates (`is_shared`, `is_benchmarking`, IPv6 unique-local /
/// link-local) are unstable in std, so they're spelled out over the raw octets.
fn is_public_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            let shared = o[0] == 100 && (o[1] & 0xC0) == 0x40; // 100.64.0.0/10
            let benchmarking = o[0] == 198 && (o[1] & 0xFE) == 18; // 198.18.0.0/15
            let ietf = o[0] == 192 && o[1] == 0 && o[2] == 0; // 192.0.0.0/24
            let this_net = o[0] == 0; // 0.0.0.0/8
            let reserved = o[0] >= 240; // 240.0.0.0/4 (class E, incl 255.*)
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || shared
                || benchmarking
                || ietf
                || this_net
                || reserved)
        }
        IpAddr::V6(v6) => {
            if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                return false;
            }
            // An IPv4-mapped (::ffff:a.b.c.d) or the deprecated IPv4-compatible
            // (::a.b.c.d) v6 address is really a v4 target; validate it as such so
            // it can't smuggle a private v4 past the v6 path.
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return is_public_ip(&IpAddr::V4(mapped));
            }
            let s = v6.segments();
            if s[0..6].iter().all(|&x| x == 0) && !(s[6] == 0 && s[7] == 0) {
                let v4 = std::net::Ipv4Addr::new(
                    (s[6] >> 8) as u8,
                    (s[6] & 0xff) as u8,
                    (s[7] >> 8) as u8,
                    (s[7] & 0xff) as u8,
                );
                return is_public_ip(&IpAddr::V4(v4));
            }
            let unique_local = (s[0] & 0xfe00) == 0xfc00; // fc00::/7
            let link_local = (s[0] & 0xffc0) == 0xfe80; // fe80::/10
            !(unique_local || link_local)
        }
    }
}

/// Whether a URL's host is safe to fetch. An IP-LITERAL host is validated with
/// `is_public_ip` HERE because hyper's connector dials a literal address WITHOUT
/// consulting the custom DNS resolver (`SsrfGuardResolver` only runs for
/// hostnames). A hostname returns true and is guarded by the resolver at connect
/// time. A missing/unparseable host is rejected.
fn host_is_public(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    // host_str brackets an IPv6 literal ("[::1]"); strip before parsing.
    let h = host
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(host);
    match h.parse::<IpAddr>() {
        Ok(ip) => is_public_ip(&ip),
        Err(_) => true, // hostname: DNS resolver enforces the guard on connect
    }
}

struct SsrfGuardResolver;

impl reqwest::dns::Resolve for SsrfGuardResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        Box::pin(async move {
            let host = name.as_str().to_owned();
            // Port is a placeholder; reqwest overrides it with the request's
            // real port. We only care about the resolved IPs.
            let resolved = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let public: Vec<SocketAddr> = resolved.filter(|a| is_public_ip(&a.ip())).collect();
            if public.is_empty() {
                // Fail closed: a host that resolves only to non-public addresses
                // (or a rebind returning a private IP on this connection) never
                // gets connected. Every connection re-resolves through here, so a
                // TTL-flip rebind is caught on the hop that would exploit it.
                return Err("blocked: host resolves to no public address".into());
            }
            Ok(Box::new(public.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn img_client() -> &'static reqwest::Client {
    IMG_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .dns_resolver(Arc::new(SsrfGuardResolver))
            .connect_timeout(Duration::from_secs(10))
            // A whole-request timeout is fine here (images are finite, unlike a
            // live `.ts`); bounds a slow-loris upstream.
            .timeout(Duration::from_secs(20))
            // Validate every redirect hop's host, not just the initial URL: a
            // redirect to an internal IP literal would otherwise skip the DNS
            // guard (hyper dials literals directly). Also caps the hop count.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 5 {
                    return attempt.error("too many redirects".to_string());
                }
                // Fail fast on a self-referential loop instead of walking to the
                // hop cap. A 302 with an EMPTY Location resolves back to the same
                // URL (the AIOMetadata /poster artwork-less path emits exactly
                // this), which would otherwise self-redirect five times.
                if attempt.previous().iter().any(|u| u == attempt.url()) {
                    return attempt.error("redirect loop".to_string());
                }
                if host_is_public(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.error("blocked redirect to non-public host".to_string())
                }
            }))
            .user_agent(concat!("aura-img/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("img proxy HTTP client init failed")
    })
}

// ── Handler ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ImgQuery {
    url: String,
    w: Option<u32>,
}

/// `GET /img?url=<encoded>&w=<px>`. Serves a JPEG resized to ~`w` CSS px,
/// disk-cached. Degrades to a 302 to the original URL on any failure so the
/// poster still loads (just full-size).
pub async fn handle(Query(q): Query<ImgQuery>) -> Response {
    let url = q.url;
    let target_w = q.w.unwrap_or(DEFAULT_TARGET_W).clamp(MIN_TARGET_W, MAX_TARGET_W);

    // Only proxy remote http(s). Anything else (data:, blob:, a mistaken
    // loopback self-reference) is handed straight back.
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Redirect::temporary(&url).into_response();
    }

    let key = cache_key(&url, target_w);
    let path = cache_dir().map(|d| d.join(&key));

    // Cache hit → serve the small bytes directly.
    if let Some(p) = &path {
        if let Ok(bytes) = tokio::fs::read(p).await {
            if !bytes.is_empty() {
                return jpeg_response(bytes);
            }
        }
    }

    if let Ok(bytes) = fetch_and_resize(&url, target_w).await {
        if let Some(p) = path {
            write_cache(p, bytes.clone()).await;
        }
        return jpeg_response(bytes);
    }

    // RPDB key-revoked recovery, centralized here (the webview's own
    // RPDB->metahub swap can't see through the proxy URL): if the source was an
    // RPDB imdb poster, retry the same IMDb id from freely-accessible metahub
    // before giving up. Resized + cached like any other hit.
    if let Some(mh) = rpdb_to_metahub(&url) {
        if let Ok(bytes) = fetch_and_resize(&mh, target_w).await {
            if let Some(p) = path {
                write_cache(p, bytes.clone()).await;
            }
            return jpeg_response(bytes);
        }
    }

    // Never surface a broken tile: fall back to the original image.
    Redirect::temporary(&url).into_response()
}

/// Map an `api.ratingposterdb.com/.../imdb/poster-default/<tt…>.jpg` URL to the
/// equivalent metahub poster URL. Mirrors the webview's `rpdbToMetahubFallback`.
/// RPDB bakes a per-user API key into the path; once revoked/rate-limited it
/// 403s every poster on that key, and metahub carries the same set keyed by
/// IMDb id. Returns None for any non-RPDB / non-IMDb path.
fn rpdb_to_metahub(url: &str) -> Option<String> {
    if !url.contains("api.ratingposterdb.com/") {
        return None;
    }
    const MARKER: &str = "/imdb/poster-default/";
    let after = &url[url.find(MARKER)? + MARKER.len()..];
    let file = after.split(['?', '#']).next()?;
    let tt = file.strip_suffix(".jpg").or_else(|| file.strip_suffix(".jpeg"))?;
    if !(tt.starts_with("tt") && tt.len() > 2 && tt[2..].bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    Some(format!("https://images.metahub.space/poster/medium/{tt}/img"))
}

async fn fetch_and_resize(url: &str, target_w: u32) -> Result<Vec<u8>, String> {
    // Bound the WHOLE job (fetch buffer + decode) under one permit so concurrency
    // caps transient memory as well as CPU.
    let _permit = job_sem()
        .acquire()
        .await
        .map_err(|_| "job semaphore closed".to_string())?;

    // Reject IP-literal internal hosts on the initial URL: hyper's connector
    // dials a literal address WITHOUT the custom DNS resolver, so is_public_ip
    // must be applied here (redirect hops are covered by the redirect policy).
    let parsed = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if !host_is_public(&parsed) {
        return Err("blocked non-public host".into());
    }

    let resp = img_client()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;

    // Fast reject on a truthful Content-Length; the streamed cap below is the
    // real guard (the header can lie or be absent).
    if let Some(len) = resp.content_length() {
        if len > MAX_FETCH_BYTES as u64 {
            return Err("upstream too large".into());
        }
    }

    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        if buf.len() + chunk.len() > MAX_FETCH_BYTES {
            return Err("upstream exceeded byte cap".into());
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        return Err("empty upstream body".into());
    }

    // Decode + resize + encode are CPU-bound: run on a blocking thread. The job
    // permit acquired above is still held, so this stays bounded.
    tokio::task::spawn_blocking(move || resize_to_jpeg(&buf, target_w))
        .await
        .map_err(|e| e.to_string())?
}

/// Pure CPU stage: header-check the pixel budget, decode, downscale (never up),
/// re-encode to JPEG. Runs inside spawn_blocking.
fn resize_to_jpeg(bytes: &[u8], target_w: u32) -> Result<Vec<u8>, String> {
    use std::io::Cursor;

    // Header-only dimension read BEFORE decoding so a bomb is rejected without
    // processing a single pixel.
    let (src_w, src_h) = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .into_dimensions()
        .map_err(|e| e.to_string())?;
    if (src_w as u64) * (src_h as u64) > MAX_DECODE_PIXELS {
        return Err("image exceeds pixel cap".into());
    }

    let img = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?;

    // Only ever downscale. When the source is already at/under the target width
    // the decoded image is used as-is (still re-encoded to a uniform JPEG).
    let resized = if src_w > target_w {
        let target_h = ((src_h as u64 * target_w as u64) / src_w as u64).max(1) as u32;
        img.resize_exact(target_w, target_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let mut out = Vec::with_capacity(48 * 1024);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, OUTPUT_JPEG_QUALITY)
        .encode_image(&resized.to_rgb8())
        .map_err(|e| e.to_string())?;
    Ok(out)
}

fn jpeg_response(bytes: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            // Immutable for the (url, w) pair; let the webview cache it too so a
            // re-scroll doesn't re-hit the bridge.
            (header::CACHE_CONTROL, "public, max-age=604800"),
        ],
        bytes,
    )
        .into_response()
}

fn cache_key(url: &str, target_w: u32) -> String {
    let mut h = Sha256::new();
    h.update(url.as_bytes());
    h.update([0u8]);
    h.update(target_w.to_le_bytes());
    format!("{:x}.jpg", h.finalize())
}

async fn write_cache(path: PathBuf, bytes: Vec<u8>) {
    // Write a PER-WRITE-UNIQUE temp sibling then rename, so two concurrent
    // requests for the same (url, w) don't interleave into one shared temp file
    // (which could leave a truncated JPEG that the read path serves forever). The
    // unique suffix comes from the global write counter; rename is atomic so a
    // reader sees either the old file or a complete new one.
    let n = WRITE_COUNT.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("{n}.tmp"));
    if tokio::fs::write(&tmp, &bytes).await.is_ok() {
        if tokio::fs::rename(&tmp, &path).await.is_err() {
            let _ = tokio::fs::remove_file(&tmp).await;
        }
    }
    maybe_evict(n);
}

/// Periodically (every 128 writes) sweep the cache off-thread and evict the
/// oldest files until it's back under 80% of the cap. Amortized so no single
/// request pays for a full-directory scan. `n` is the write counter value from
/// the caller (already incremented there for the unique temp name).
fn maybe_evict(n: u64) {
    if n % 128 != 0 {
        return;
    }
    let Some(dir) = cache_dir().map(Path::to_path_buf) else { return };
    tokio::task::spawn_blocking(move || {
        let mut entries: Vec<(PathBuf, std::time::SystemTime, u64)> = Vec::new();
        let mut total: u64 = 0;
        let Ok(rd) = std::fs::read_dir(&dir) else { return };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let size = meta.len();
            let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            total += size;
            entries.push((e.path(), mtime, size));
        }
        if total <= MAX_CACHE_BYTES {
            return;
        }
        entries.sort_by_key(|(_, mtime, _)| *mtime); // oldest first
        let target = MAX_CACHE_BYTES / 5 * 4; // drain to 80%
        for (p, _, size) in entries {
            if total <= target {
                break;
            }
            if std::fs::remove_file(&p).is_ok() {
                total = total.saturating_sub(size);
            }
        }
    });
}
