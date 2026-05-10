// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Aura Proxy v2 sync client.
//!
//! Round-trips per-account state (settings, queue + manual marks, recent
//! searches, per-title preferences, AniList ID cache, etc.) through the
//! `aura.animasec.dev` proxy so signing in to Aura on a new machine
//! restores the user's configuration without a manual export/import dance.
//!
//! ## Auth model
//!
//! The proxy never sees the raw Stremio auth_key. Aura derives a per-
//! account opaque scope hash on the desktop:
//!
//!     scope_hash = sha256_hex(auth_key)
//!
//! and sends it as `Authorization: Aura-Sync <hex>` on every request.
//! The proxy stores blobs keyed by that hash. Anyone holding the
//! auth_key already owns the Stremio account, so deriving sync identity
//! from it adds no new compromise vector. Guests (no auth_key) cannot
//! sync; their state stays local until they sign in.
//!
//! ## Namespaces
//!
//! Each top-level Aura store maps to one named blob on the proxy:
//!
//!   - `settings`        — backend AppSettings + frontend auraSettings
//!   - `manual-state`    — queue + manual watched/in-progress marks
//!   - `auto-bumped`     — series IDs the user finished
//!   - `notifications`   — last-7-days ring buffer
//!   - `recent-searches` — recent search query strings
//!   - `title-state`     — per-title volume / shader / lang preferences
//!   - `anilist-id-map`  — IMDB → AniList media id cache
//!
//! Blobs are arbitrary JSON; the Rust side is namespace-agnostic. The
//! frontend owns merge semantics for each namespace (last-writer-wins,
//! union, etc.) per the ROADMAP §7.5 contract.
//!
//! ## Concurrency
//!
//! Writes carry an optional `If-Match: <etag>` header for optimistic
//! concurrency. On `412 Precondition Failed`, the caller fetches the
//! server version, merges, and retries. The Rust side never merges; it
//! just relays the conflict so the frontend can apply the right
//! per-namespace strategy.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{AppHandle, Runtime};

use crate::auth;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Base URL of the proxy's `/sync/v1/` endpoint group. Matches the
/// REDIRECT_BASE in scrobble_auth.rs (same VPS, same TLS cert).
const SYNC_BASE: &str = "https://aura.animasec.dev/sync/v1";

const TIMEOUT: Duration = Duration::from_secs(10);

/// Hard limit on a single namespace blob (matches the proxy's quota).
/// Pushes that exceed this are rejected client-side before hitting the
/// network so the user sees a clear error instead of a 413.
const MAX_BLOB_BYTES: usize = 1024 * 1024;

/// Allowed namespace names. Adding a new namespace is intentionally a
/// two-place change (here AND on the proxy) so a typo'd name on either
/// side can't accidentally create stray blobs.
const NAMESPACES: &[&str] = &[
    "settings",
    "manual-state",
    "auto-bumped",
    "notifications",
    "recent-searches",
    "title-state",
    "anilist-id-map",
];

fn validate_namespace(namespace: &str) -> Result<(), String> {
    if NAMESPACES.contains(&namespace) {
        Ok(())
    } else {
        Err(format!("unknown sync namespace: {namespace}"))
    }
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(TIMEOUT)
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " sync"))
            .build()
            .expect("Sync HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Scope derivation
// ---------------------------------------------------------------------------

/// Derive the proxy-side scope hash from the Stremio auth_key. The hash
/// goes into the `Authorization` header; the raw auth_key never leaves
/// the desktop. Returns None when no Stremio session is active (guest
/// mode); callers then short-circuit before any network I/O.
fn derive_scope_hash<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let session = auth::load_session(app).ok().flatten()?;
    if session.auth_key.is_empty() {
        return None;
    }
    let mut hasher = Sha256::new();
    hasher.update(session.auth_key.as_bytes());
    Some(hex::encode(hasher.finalize()))
}

fn auth_header(hash: &str) -> String {
    format!("Aura-Sync {hash}")
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// One namespace's stored blob plus its metadata. Returned from `pull`.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SyncBlob {
    /// The namespace identifier (`settings`, `manual-state`, etc.).
    pub namespace: String,
    /// The stored JSON value as-is. Frontend deserializes per its own
    /// schema; the Rust side does not validate the shape.
    pub data: serde_json::Value,
    /// Server-assigned content hash. Pass back as `if_match` on the
    /// next push to detect concurrent writes from another device.
    pub etag: String,
    /// Unix seconds of the most recent successful write.
    pub updated_at: u64,
}

/// Result of a successful push.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PushResult {
    pub etag: String,
    pub updated_at: u64,
}

/// Outcome of a push operation. Conflict carries the server's current
/// version so the caller can merge without a separate pull round-trip.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PushOutcome {
    Ok(PushResult),
    Conflict { server: SyncBlob },
}

/// Status row used by the Settings → Cloud Sync panel.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct NamespaceStatus {
    pub name: String,
    pub etag: Option<String>,
    pub updated_at: Option<u64>,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SyncStatus {
    /// True when a Stremio session is active and sync is therefore
    /// available. Guests get `connected: false` and an empty namespace
    /// list; the panel then prompts them to sign in.
    pub connected: bool,
    pub namespaces: Vec<NamespaceStatus>,
    pub total_size: u64,
    pub quota: u64,
}

// Server response shapes (private to this module so we can rename
// fields independently of the public API later).

#[derive(Deserialize)]
struct ServerListResponse {
    namespaces: Vec<NamespaceStatus>,
    total_size: u64,
    quota: u64,
}

#[derive(Deserialize)]
struct ServerBlobResponse {
    data: serde_json::Value,
    etag: String,
    updated_at: u64,
}

#[derive(Deserialize)]
struct ServerPushResponse {
    etag: String,
    updated_at: u64,
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Status snapshot for the Settings → Cloud Sync panel. Returns
/// `connected: false` with an empty namespaces list when no Stremio
/// session is active so the UI can render an "Sign in to enable cloud
/// sync" empty state without a network round-trip.
#[tauri::command]
pub async fn sync_status<R: Runtime>(app: AppHandle<R>) -> Result<SyncStatus, String> {
    let Some(scope) = derive_scope_hash(&app) else {
        return Ok(SyncStatus {
            connected: false,
            namespaces: vec![],
            total_size: 0,
            quota: MAX_BLOB_BYTES as u64 * NAMESPACES.len() as u64,
        });
    };

    let resp = client()
        .get(format!("{SYNC_BASE}/"))
        .header("Authorization", auth_header(&scope))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if resp.status().as_u16() == 404 {
        // Account exists but has never written anything; treat as empty.
        return Ok(SyncStatus {
            connected: true,
            namespaces: vec![],
            total_size: 0,
            quota: MAX_BLOB_BYTES as u64 * NAMESPACES.len() as u64,
        });
    }
    if !resp.status().is_success() {
        return Err(format!("sync_status http {}", resp.status().as_u16()));
    }
    let body: ServerListResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    Ok(SyncStatus {
        connected: true,
        namespaces: body.namespaces,
        total_size: body.total_size,
        quota: body.quota,
    })
}

/// Fetch a single namespace blob. Returns `None` when:
///
///   - No Stremio session is active (guest mode), or
///   - The proxy returns 404 (no blob written for this account yet)
///
/// Any other failure (network, HTTP 5xx, malformed JSON) is surfaced as
/// an error so the caller can decide whether to retry / show a toast.
#[tauri::command]
pub async fn sync_pull<R: Runtime>(
    app: AppHandle<R>,
    namespace: String,
) -> Result<Option<SyncBlob>, String> {
    validate_namespace(&namespace)?;
    let Some(scope) = derive_scope_hash(&app) else {
        return Ok(None);
    };

    let resp = client()
        .get(format!("{SYNC_BASE}/{namespace}"))
        .header("Authorization", auth_header(&scope))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    if resp.status().as_u16() == 404 {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("sync_pull {namespace} http {}", resp.status().as_u16()));
    }
    let body: ServerBlobResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    Ok(Some(SyncBlob {
        namespace,
        data: body.data,
        etag: body.etag,
        updated_at: body.updated_at,
    }))
}

/// Pull every known namespace in a single sweep. Used by the login
/// flow so a fresh device gets the full per-account picture in one
/// orchestrated round-trip rather than seven independent fetches.
///
/// Failures on individual namespaces are LOGGED but do not abort the
/// sweep — the caller gets back whatever did succeed. This matches the
/// "best effort restore" intent: a single dropped blob shouldn't
/// prevent the rest of settings from landing.
#[tauri::command]
pub async fn sync_pull_all<R: Runtime>(app: AppHandle<R>) -> Result<Vec<SyncBlob>, String> {
    if derive_scope_hash(&app).is_none() {
        return Ok(vec![]);
    }
    let mut out = Vec::with_capacity(NAMESPACES.len());
    for &name in NAMESPACES {
        match sync_pull(app.clone(), name.to_string()).await {
            Ok(Some(blob)) => out.push(blob),
            Ok(None) => {}
            Err(e) => {
                crate::devlog!(
                    warn, "sync",
                    "pull_all: {name} failed ({e}) - continuing with remaining namespaces",
                );
            }
        }
    }
    Ok(out)
}

/// Write a namespace blob. When `if_match` is provided, the proxy
/// rejects the write with 412 if the server-side ETag has changed; the
/// caller gets back `PushOutcome::Conflict { server }` so it can merge
/// and retry without a separate pull. Pass `None` to force-overwrite
/// (used by pull-on-login to seed the proxy on first contact).
#[tauri::command]
pub async fn sync_push<R: Runtime>(
    app: AppHandle<R>,
    namespace: String,
    data: serde_json::Value,
    if_match: Option<String>,
) -> Result<PushOutcome, String> {
    validate_namespace(&namespace)?;
    let Some(scope) = derive_scope_hash(&app) else {
        return Err("sync unavailable in guest mode".to_string());
    };

    // Belt-and-braces size check. The proxy enforces the same limit but
    // we'd rather surface "Setting blob too large" locally than waste a
    // request on a doomed payload.
    let serialized = serde_json::to_vec(&data).map_err(|e| format!("serialize: {e}"))?;
    if serialized.len() > MAX_BLOB_BYTES {
        return Err(format!(
            "sync_push {namespace} too large: {} bytes (max {})",
            serialized.len(), MAX_BLOB_BYTES,
        ));
    }

    let mut req = client()
        .put(format!("{SYNC_BASE}/{namespace}"))
        .header("Authorization", auth_header(&scope))
        .header("Content-Type", "application/json")
        .body(serialized);
    if let Some(etag) = if_match {
        req = req.header("If-Match", etag);
    }

    let resp = req.send().await.map_err(|e| format!("network: {e}"))?;
    let status = resp.status();

    if status.as_u16() == 412 {
        // Server returns its current blob in the body so we don't need a
        // round-trip to fetch it before merging.
        let body: ServerBlobResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
        return Ok(PushOutcome::Conflict {
            server: SyncBlob {
                namespace,
                data: body.data,
                etag: body.etag,
                updated_at: body.updated_at,
            },
        });
    }
    if status.as_u16() == 429 {
        return Err("sync_push rate-limited - back off and retry".to_string());
    }
    if !status.is_success() {
        return Err(format!("sync_push {namespace} http {}", status.as_u16()));
    }
    let body: ServerPushResponse = resp.json().await.map_err(|e| format!("decode: {e}"))?;
    crate::devlog!(
        debug, "sync",
        "pushed {namespace} ({} bytes, etag={})",
        body.updated_at, body.etag,
    );
    Ok(PushOutcome::Ok(PushResult {
        etag: body.etag,
        updated_at: body.updated_at,
    }))
}

/// Drop a single namespace from the proxy. Idempotent. Used by
/// per-namespace "Reset" actions in the Cloud Sync panel.
#[tauri::command]
pub async fn sync_delete<R: Runtime>(
    app: AppHandle<R>,
    namespace: String,
) -> Result<(), String> {
    validate_namespace(&namespace)?;
    let Some(scope) = derive_scope_hash(&app) else {
        return Ok(()); // guests: nothing on the server to delete
    };

    let resp = client()
        .delete(format!("{SYNC_BASE}/{namespace}"))
        .header("Authorization", auth_header(&scope))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        return Err(format!("sync_delete {namespace} http {}", resp.status().as_u16()));
    }
    Ok(())
}

/// Wipe every blob for this account. Used by Settings → Privacy →
/// "Clear cloud sync data" so a user can opt out without uninstalling.
/// Local data is unaffected; the next push will repopulate the cloud
/// from local state (intentional: makes the action recoverable).
#[tauri::command]
pub async fn sync_purge<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let Some(scope) = derive_scope_hash(&app) else {
        return Ok(());
    };

    let resp = client()
        .post(format!("{SYNC_BASE}/_purge"))
        .header("Authorization", auth_header(&scope))
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("sync_purge http {}", resp.status().as_u16()));
    }
    crate::devlog!(info, "sync", "purged all cloud blobs for active account");
    Ok(())
}
