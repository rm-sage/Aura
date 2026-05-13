// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Aura Cloud sync client (proxy still hosted on aura.animasec.dev,
//! "Aura Cloud" is the user-facing name for the per-account state
//! sync feature; "proxy" persists in the codebase only as the
//! historical name of the Go service that powers it).
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

/// Derive the proxy-side scope hash. Prefers the Stremio user `_id`
/// (stable across logins on every device for the same account); falls
/// back to the auth_key only when the user_id hasn't been backfilled
/// yet (pre-0.6.9 sessions on first launch after upgrade, or when
/// the `/getUser` backfill failed).
///
/// Returns None when no Stremio session is active (guest mode).
///
/// The auth_key fallback is the LEGACY path — every device that
/// logged in pre-0.6.9 wrote data to `sha256(auth_key)` and that
/// scope is now cross-device-inconsistent. Callers that want the
/// legacy scope explicitly (the migration sweep) should use
/// `legacy_scope_hash_from_auth_key` instead of this function.
fn derive_scope_hash<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let session = auth::load_session(app).ok().flatten()?;
    if let Some(uid) = session.user_id.as_deref().filter(|s| !s.is_empty()) {
        return Some(hash_hex(uid.as_bytes()));
    }
    if session.auth_key.is_empty() {
        return None;
    }
    crate::devlog!(
        warn, "sync",
        "derive_scope_hash: falling back to auth_key (user_id not backfilled — cross-device sync won't work for this session)",
    );
    Some(hash_hex(session.auth_key.as_bytes()))
}

/// Legacy scope-hash derivation: `sha256(auth_key)`. Used exclusively
/// by the migration sweep so we can read blobs out of the old
/// per-session scope and copy them into the new per-account scope.
fn legacy_scope_hash_from_auth_key(auth_key: &str) -> String {
    hash_hex(auth_key.as_bytes())
}

fn hash_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
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
    /// Cumulative count of failed release-endpoint HTTP attempts since
    /// app start. Surfaced so the title-bar chip can light up on
    /// release-search disconnects even when namespace traffic is
    /// healthy — the two share the same Aura Cloud host but the
    /// release endpoints can fail independently (poller down,
    /// upstream addon outage, etc.).
    pub release_failure_count: u64,
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
            release_failure_count: release_failure_count(),
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
            release_failure_count: release_failure_count(),
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
        release_failure_count: release_failure_count(),
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

/// Summary of a migration run. One entry per namespace plus
/// totals so the DevConsole can render a single human-readable line.
#[derive(Serialize)]
pub struct MigrationReport {
    pub legacy_scope_prefix: String,
    pub new_scope_prefix: String,
    pub copied: Vec<String>,
    pub skipped_empty: Vec<String>,
    pub failed: Vec<MigrationFailure>,
}

#[derive(Serialize)]
pub struct MigrationFailure {
    pub namespace: String,
    pub stage: String, // "pull" | "push"
    pub error: String,
}

/// One-shot copy of all namespace blobs from the legacy scope
/// (`sha256(auth_key)`) to the new scope (`sha256(user_id)`).
///
/// Pre-0.6.9 desktops wrote data to a per-session scope that's
/// invisible to every other device on the same Stremio account
/// (different auth_keys → different hashes). This migration runs
/// MANUALLY from the DevConsole (`sync-migrate`) on the device that
/// holds the legacy data; the user's other devices then see it on
/// their next pull.
///
/// Force-overwrites on push (no If-Match): the new scope is empty
/// on a fresh-migration device, so there's no merge concern.
/// Bails early when the session is missing user_id (can't determine
/// the new scope) or when the two scopes already match (nothing to
/// do).
#[tauri::command]
pub async fn migrate_sync_scope<R: Runtime>(app: AppHandle<R>) -> Result<MigrationReport, String> {
    let session = auth::load_session(&app)?
        .ok_or_else(|| "migrate_sync_scope: no Stremio session".to_string())?;

    let user_id = session
        .user_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "migrate_sync_scope: user_id is not yet backfilled — run get_session or sign in again first".to_string()
        })?;

    if session.auth_key.is_empty() {
        return Err("migrate_sync_scope: no auth_key in session".to_string());
    }

    let legacy_scope = legacy_scope_hash_from_auth_key(&session.auth_key);
    let new_scope = hash_hex(user_id.as_bytes());

    if legacy_scope == new_scope {
        return Ok(MigrationReport {
            legacy_scope_prefix: legacy_scope[..8].to_string(),
            new_scope_prefix: new_scope[..8].to_string(),
            copied: vec![],
            skipped_empty: NAMESPACES.iter().map(|s| s.to_string()).collect(),
            failed: vec![],
        });
    }

    let mut report = MigrationReport {
        legacy_scope_prefix: legacy_scope[..8].to_string(),
        new_scope_prefix: new_scope[..8].to_string(),
        copied: vec![],
        skipped_empty: vec![],
        failed: vec![],
    };

    for &name in NAMESPACES {
        // Pull from the legacy scope.
        let legacy_blob = match client()
            .get(format!("{SYNC_BASE}/{name}"))
            .header("Authorization", auth_header(&legacy_scope))
            .send()
            .await
        {
            Ok(resp) if resp.status().as_u16() == 404 => {
                report.skipped_empty.push(name.to_string());
                continue;
            }
            Ok(resp) if !resp.status().is_success() => {
                report.failed.push(MigrationFailure {
                    namespace: name.to_string(),
                    stage: "pull".to_string(),
                    error: format!("http {}", resp.status().as_u16()),
                });
                continue;
            }
            Ok(resp) => match resp.json::<ServerBlobResponse>().await {
                Ok(body) => body.data,
                Err(e) => {
                    report.failed.push(MigrationFailure {
                        namespace: name.to_string(),
                        stage: "pull".to_string(),
                        error: format!("decode: {e}"),
                    });
                    continue;
                }
            },
            Err(e) => {
                report.failed.push(MigrationFailure {
                    namespace: name.to_string(),
                    stage: "pull".to_string(),
                    error: format!("network: {e}"),
                });
                continue;
            }
        };

        // Push to the new scope, force-overwrite (no If-Match).
        let serialized = match serde_json::to_vec(&legacy_blob) {
            Ok(v) => v,
            Err(e) => {
                report.failed.push(MigrationFailure {
                    namespace: name.to_string(),
                    stage: "push".to_string(),
                    error: format!("serialize: {e}"),
                });
                continue;
            }
        };

        let push_resp = client()
            .put(format!("{SYNC_BASE}/{name}"))
            .header("Authorization", auth_header(&new_scope))
            .header("Content-Type", "application/json")
            .body(serialized)
            .send()
            .await;

        match push_resp {
            Ok(resp) if resp.status().is_success() => {
                report.copied.push(name.to_string());
            }
            Ok(resp) => {
                report.failed.push(MigrationFailure {
                    namespace: name.to_string(),
                    stage: "push".to_string(),
                    error: format!("http {}", resp.status().as_u16()),
                });
            }
            Err(e) => {
                report.failed.push(MigrationFailure {
                    namespace: name.to_string(),
                    stage: "push".to_string(),
                    error: format!("network: {e}"),
                });
            }
        }
    }

    crate::devlog!(
        info, "sync",
        "migrate_sync_scope: {} → {} | copied={:?} skipped_empty={:?} failed={}",
        report.legacy_scope_prefix, report.new_scope_prefix,
        report.copied, report.skipped_empty, report.failed.len(),
    );

    Ok(report)
}

// ---------------------------------------------------------------------------
// Release-search service (Phase 9)
//
// Three endpoints under `/sync/v1/release/` proxied by the same Aura
// Cloud service. The cloud-side spec lives at
// `docs/release-search-spec.md`; desktop responsibilities are §6.
// Endpoints:
//
//   • GET  /sync/v1/release/{imdb_id}        — anonymous, optional
//     If-None-Match for conditional fetch (304 → use cached).
//   • POST /sync/v1/release/batch            — Aura-Sync auth required;
//     body `{ items: [{id, type}, ...] }`, cap 500 items per call.
//   • POST /sync/v1/release/{imdb_id}/refresh — Aura-Sync auth required;
//     optional body `{ type }` for first-seen ids.
//
// Per the privacy boundary in §2: the cloud must not log the request
// body. We don't either — the devlog lines below carry counts /
// outcomes only.
//
// Release-endpoint HTTP failures are tracked in a small global counter
// (`release_failure_count`) that `sync_status` reads, so the title-bar
// sync chip lights up on release-side disconnect even when the
// namespace traffic is healthy. Without this, the user's first signal
// that the release feed is down would be "calendar / library
// reconciliation is silently stale" — much worse than a visible chip.
// ---------------------------------------------------------------------------

#[derive(Clone, Deserialize, Serialize)]
pub struct ReleaseSignalItem {
    pub id: String,
    // r#type is the raw Rust keyword; serde renames to "type" on the
    // wire so the JSON shape matches the spec's `{ id, type }`. The
    // struct is both Deserialize (frontend → command arg) and Serialize
    // (command → cloud POST body).
    #[serde(rename = "type")]
    pub r#type: String,
}

#[derive(Serialize)]
struct ReleaseBatchRequest<'a> {
    items: &'a [ReleaseSignalItem],
}

#[derive(Deserialize, Serialize)]
struct ReleaseBatchResponse {
    /// Map from imdb_id → signal-or-null. `null` differentiates
    /// "cloud has queued this id but the poller hasn't reached it yet"
    /// from "cloud has no record at all" (which doesn't happen in
    /// practice because every batched id is auto-inserted).
    signals: std::collections::HashMap<String, Option<serde_json::Value>>,
}

#[derive(Serialize)]
struct ReleaseNudgeRequest<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    r#type: Option<&'a str>,
}

// Cumulative count of failed release-endpoint HTTP attempts since app
// start. `sync_status` returns this as part of the cloud-health view so
// the title-bar chip can flag release-feed disconnects independently
// from namespace traffic.
static RELEASE_FAILURE_COUNT: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn bump_release_failure() {
    RELEASE_FAILURE_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// Public — surfaced via `sync_status` payload so the React chip can
/// pulse on release failures.
pub fn release_failure_count() -> u64 {
    RELEASE_FAILURE_COUNT.load(std::sync::atomic::Ordering::Relaxed)
}

/// GET /sync/v1/release/{imdb_id}
///
/// Anonymous — no auth header. The cloud rate-limits per-IP (120/s
/// burst, 2/s refill); the desktop should already have a 5-min in-
/// memory cache so we hit this far less often than that.
///
/// `if_none_match` is the etag the desktop received on the prior fetch
/// for this id. When present, the cloud returns `304 Not Modified`
/// with no body; we surface that as `Ok(None)` and the caller reuses
/// its cached signal. The returned JSON Value already carries an
/// `"etag"` field per §3, so the caller can persist that for the next
/// conditional fetch.
#[tauri::command]
pub async fn fetch_release_signal(
    imdb_id: String,
    if_none_match: Option<String>,
) -> Result<Option<serde_json::Value>, String> {
    if imdb_id.is_empty() {
        return Err("empty imdb_id".into());
    }
    let mut req = client().get(format!("{SYNC_BASE}/release/{imdb_id}"));
    if let Some(etag) = if_none_match.as_deref().filter(|s| !s.is_empty()) {
        req = req.header("If-None-Match", etag);
    }
    let resp = req.send().await.map_err(|e| {
        bump_release_failure();
        format!("network: {e}")
    })?;
    let status = resp.status().as_u16();
    match status {
        304 => Ok(None),
        404 => Ok(None),
        s if (200..300).contains(&s) => {
            let body: serde_json::Value = resp.json().await.map_err(|e| {
                bump_release_failure();
                format!("decode: {e}")
            })?;
            Ok(Some(body))
        }
        _ => {
            bump_release_failure();
            Err(format!("fetch_release_signal http {status}"))
        }
    }
}

/// POST /sync/v1/release/batch
///
/// Auth required. Items cap at 500 per request (the cloud rejects
/// larger bodies with 400). The desktop is responsible for chunking
/// when the library has more — `releaseSearch.ts` does that on the JS
/// side, so this command sees only chunked payloads.
///
/// `if_none_match` carries the response ETag from the previous call
/// with the same id list. The cloud (since 2026-05-13, spec §10.1)
/// returns `304 Not Modified` when nothing about the response would
/// change — id list identical AND every signal's individual etag
/// identical. On 304 we return `BatchResult { etag: same, signals:
/// None }` so the caller can reuse its cached results without
/// re-decoding the (potentially ~100 KB) JSON body.
#[derive(Serialize)]
pub struct ReleaseBatchResult {
    /// Response ETag from the cloud. None means the cloud didn't
    /// include the header (older deploys; not currently possible but
    /// safe to handle). Use this as the `if_none_match` arg on the
    /// next call with the same id list.
    pub etag: Option<String>,
    /// `Some(map)` on 200 (fresh data — call site should merge into
    /// store). `None` on 304 (use cached). Always `Some` on the
    /// no-items short-circuit (empty map).
    pub signals: Option<std::collections::HashMap<String, Option<serde_json::Value>>>,
}

#[tauri::command]
pub async fn fetch_release_signals<R: Runtime>(
    app: AppHandle<R>,
    items: Vec<ReleaseSignalItem>,
    if_none_match: Option<String>,
) -> Result<ReleaseBatchResult, String> {
    if items.is_empty() {
        return Ok(ReleaseBatchResult {
            etag: None,
            signals: Some(std::collections::HashMap::new()),
        });
    }
    let Some(scope) = derive_scope_hash(&app) else {
        return Err("not signed in".into());
    };
    let body = ReleaseBatchRequest { items: &items };
    let mut req = client()
        .post(format!("{SYNC_BASE}/release/batch"))
        .header("Authorization", auth_header(&scope))
        .json(&body);
    if let Some(etag) = if_none_match.as_deref().filter(|s| !s.is_empty()) {
        req = req.header("If-None-Match", etag);
    }
    let resp = req.send().await.map_err(|e| {
        bump_release_failure();
        format!("network: {e}")
    })?;
    let status = resp.status().as_u16();
    // Pull the ETag header before any body decode — both 200 and 304
    // paths use it. Cloud spec emits bare hex without surrounding
    // quotes / W/ prefix; if a future server changes, the header
    // value is just passed through unchanged.
    let resp_etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    if status == 304 {
        return Ok(ReleaseBatchResult { etag: resp_etag, signals: None });
    }
    if !resp.status().is_success() {
        bump_release_failure();
        return Err(format!("fetch_release_signals http {status}"));
    }
    let parsed: ReleaseBatchResponse = resp.json().await.map_err(|e| {
        bump_release_failure();
        format!("decode: {e}")
    })?;
    Ok(ReleaseBatchResult {
        etag: resp_etag,
        signals: Some(parsed.signals),
    })
}

/// POST /sync/v1/release/{imdb_id}/refresh
///
/// Auth required. Fire-and-forget from the caller's perspective — the
/// cloud responds 202 immediately and the poller picks the row up on
/// its next 5 s tick. We return Ok(()) on 202 / 200 and surface the
/// failure code on anything else so the calling React code can decide
/// whether to retry.
#[tauri::command]
pub async fn nudge_release_poller<R: Runtime>(
    app: AppHandle<R>,
    imdb_id: String,
    media_type: Option<String>,
) -> Result<(), String> {
    if imdb_id.is_empty() {
        return Err("empty imdb_id".into());
    }
    let Some(scope) = derive_scope_hash(&app) else {
        return Err("not signed in".into());
    };
    let mt_str = media_type.as_deref();
    let body = ReleaseNudgeRequest { r#type: mt_str };
    let resp = client()
        .post(format!("{SYNC_BASE}/release/{imdb_id}/refresh"))
        .header("Authorization", auth_header(&scope))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            bump_release_failure();
            format!("network: {e}")
        })?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        bump_release_failure();
        return Err(format!("nudge_release_poller http {status}"));
    }
    Ok(())
}
