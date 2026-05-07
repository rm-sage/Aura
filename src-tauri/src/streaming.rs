// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/// Streaming bridge — open shell.
///
/// The HTTP proxy itself runs in a separate `aura-bridge` binary
/// (sibling crate). This module is now only responsible for:
///   1. `resolve_stream` — URL transformation (decides whether to
///      route through the bridge or pass through to MPV directly).
///   2. `BRIDGE_PORT` — the agreed-upon port the bridge listens on.
///      Hardcoded to 11471 in both this module and aura-bridge so
///      both halves can construct the same proxy URL deterministically.
///
/// The bridge subprocess is launched / killed by `lib.rs::run`. See
/// the `bridge_subprocess` block there.

pub const BRIDGE_PORT: u16 = 11471;

// ---------------------------------------------------------------------------
// Tauri command — resolve a stream URL to a bridge-proxied URL
// ---------------------------------------------------------------------------

/// Convert a raw stream URL into the form MPV should load.
///
/// Routing rules (Phase 5.7):
/// - `magnet:`      → bridge magnet endpoint (501 until torrent engine lands).
/// - `http://`      → bridge HTTP proxy (we want to upgrade plaintext links
///                    on the local hop AND keep the option of header injection).
/// - `https://`     → returned **verbatim**. MPV speaks HTTPS natively, supports
///                    byte-range, and the bridge would only add round-trip cost
///                    (and break VPS hosts whose TLS cert is signed for the
///                    direct domain — the bridge is `127.0.0.1`).
/// - other          → returned as-is (MPV decides what to do).
///
/// The parameter is named `raw_url` (not `url`) so the JS caller passes
/// `{ rawUrl: ... }` — keeping the call-site explicit about what shape it is.
#[tauri::command]
pub async fn resolve_stream(raw_url: String) -> Result<String, String> {
    let lower = raw_url.to_lowercase();

    if lower.starts_with("magnet:") {
        let encoded = percent_encode(&raw_url);
        crate::devlog!(info, "bridge", "resolve_stream(magnet) → bridge magnet endpoint");
        return Ok(format!("http://127.0.0.1:{BRIDGE_PORT}/magnet/{encoded}"));
    }

    // HTTPS: no proxy. Bypass keeps MPV connecting straight to the upstream
    // host so its TLS cert validates and we don't double-buffer through the
    // local axum server. This is what the user expects for VPS-hosted streams
    // (e.g. stremthru.animasec.dev).
    if lower.starts_with("https://") {
        crate::devlog!(info, "bridge", "resolve_stream(https) → direct (no proxy)");
        return Ok(raw_url);
    }

    // Plaintext HTTP: route through the bridge so we can add headers / fix
    // up byte-range edge cases. Cheap enough on the loopback interface.
    if lower.starts_with("http://") {
        let encoded = percent_encode(&raw_url);
        crate::devlog!(info, "bridge", "resolve_stream(http) → bridge proxy");
        return Ok(format!("http://127.0.0.1:{BRIDGE_PORT}/proxy/{encoded}"));
    }

    crate::devlog!(warn, "bridge", "resolve_stream(unknown scheme) → passthrough");
    Ok(raw_url)
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
