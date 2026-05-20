// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// PathBuf and Manager are used only in cfg-gated code paths (the
// keyring fallback that writes to disk on platforms where the OS
// keyring isn't usable). The release profile sometimes flags them as
// "unused" because the conditional code is dead in that build's
// feature set; allow_unused covers both builds without splitting the
// import block.
#[allow(unused_imports)]
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
#[allow(unused_imports)]
use tauri::Manager;
use tauri::{AppHandle, Runtime};
use zeroize::Zeroizing;

use crate::addons::AddonEntry;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Sentinel error string the frontend can match to detect token expiry.
pub const SESSION_EXPIRED: &str = "SESSION_EXPIRED";

const STREMIO_API: &str = "https://api.strem.io/api";
const KEYRING_SERVICE: &str = "aura";
const KEYRING_USER: &str = "stremio-session";

// ---------------------------------------------------------------------------
// HTTPS-only HTTP client — separate from the general stremio client.
// https_only(true) prevents any redirect from HTTPS to HTTP so credentials
// can never be silently downgraded to a plaintext channel.
// ---------------------------------------------------------------------------

static AUTH_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn auth_client() -> &'static reqwest::Client {
    AUTH_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(15))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .user_agent("Aura/0.6.6")
            .build()
            .expect("Auth HTTP client init failed")
    })
}


// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSession {
    pub email: String,
    pub auth_key: String,
    /// Stremio user `_id` (MongoDB ObjectID), captured from the
    /// `/login` response or backfilled via `/getUser`. Stable across
    /// devices for the same Stremio account, which is what the Aura
    /// Cloud Sync scope hash needs to be cross-device-consistent.
    ///
    /// `Option` rather than `String` because pre-0.6.9 sessions in
    /// the keyring don't carry it. Deserialization defaults to
    /// `None` on legacy blobs; the session-restore path then calls
    /// `backfill_user_id` to populate it via Stremio's `/getUser`.
    #[serde(default)]
    pub user_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Session persistence
//
// Production: OS keyring (Windows DPAPI / macOS Keychain / Linux Secret
// Service) — encrypted at rest, scoped to the user.
//
// Debug builds: keyring + a plaintext JSON fallback at
//   <app_data_dir>/dev-session.json
// Why: keyring entries can occasionally fail to round-trip in dev (the entry
// is tied to your Windows user but tools like reset / virus scanners can wipe
// the credential vault). The fallback file makes dev iteration deterministic
// — you log in once and stay signed in across `pnpm tauri dev` restarts.
//
// The fallback is gated by `cfg(debug_assertions)` so release builds NEVER
// touch the plaintext file. Both reads and writes are best-effort.
// ---------------------------------------------------------------------------

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

#[cfg(debug_assertions)]
fn dev_session_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    if std::fs::create_dir_all(&dir).is_err() { return None; }
    Some(dir.join("dev-session.json"))
}

fn store_session<R: Runtime>(
    app: &AppHandle<R>,
    session: &UserSession,
) -> Result<(), String> {
    let json = serde_json::to_string(session).map_err(|e| e.to_string())?;
    keyring_entry()?.set_password(&json).map_err(|e| e.to_string())?;

    #[cfg(debug_assertions)]
    if let Some(path) = dev_session_path(app) {
        // Best-effort: dev fallback failure must not surface to the user.
        let _ = std::fs::write(&path, &json);
    }
    // In release builds the param is unused.
    let _ = app;
    Ok(())
}

pub(crate) fn load_session<R: Runtime>(app: &AppHandle<R>) -> Result<Option<UserSession>, String> {
    // 1) Try the OS keyring first — it's the canonical store.
    match keyring_entry()?.get_password() {
        Ok(json) => {
            return serde_json::from_str(&json).map(Some).map_err(|e| e.to_string());
        }
        Err(keyring::Error::NoEntry) => { /* fall through */ }
        Err(e) => return Err(e.to_string()),
    }

    // 2) Debug-only fallback — a plaintext file in app_data_dir.
    #[cfg(debug_assertions)]
    if let Some(path) = dev_session_path(app) {
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(sess) = serde_json::from_str::<UserSession>(&text) {
                // Re-seed the keyring so the next read hits the secure store.
                let _ = keyring_entry().and_then(|e| e.set_password(&text).map_err(|e| e.to_string()));
                return Ok(Some(sess));
            }
        }
    }
    let _ = app;
    Ok(None)
}

fn delete_session<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let kr = match keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    };

    #[cfg(debug_assertions)]
    if let Some(path) = dev_session_path(app) {
        let _ = std::fs::remove_file(&path);
    }
    let _ = app;
    kr
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Map a Stremio API error string to SESSION_EXPIRED when appropriate,
/// or to a plain error otherwise.
fn stremio_error(e: String) -> String {
    let lower = e.to_lowercase();
    if lower.contains("session")
        || lower.contains("unauthorized")
        || lower.contains("auth")
        || lower.contains("expired")
    {
        SESSION_EXPIRED.into()
    } else {
        e
    }
}


// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Authenticate with Stremio, persist the session token in the platform
/// keyring, and return the session to the frontend.
///
/// Security properties:
/// - The `password` parameter is wrapped in `Zeroizing<String>`, which
///   overwrites the heap allocation with zeros the moment this function
///   returns (or panics), limiting the credential's lifetime in process
///   memory to the duration of the HTTP round-trip.
/// - The auth client enforces `https_only(true)`: no HTTP redirects are
///   ever followed, so credentials cannot be silently downgraded.
#[tauri::command]
pub async fn login<R: Runtime>(
    app: AppHandle<R>,
    email: String,
    password: String,
) -> Result<UserSession, String> {
    // Wrap immediately — zeroed on drop regardless of error path.
    let password = Zeroizing::new(password);

    // Serialise into the request body while password is still valid.
    let body = serde_json::json!({
        "email": email,
        "password": &*password,
        "facebook": false,
    });

    // `password` is zeroed when this function exits (Zeroizing destructor).
    // Fetch raw text first so any parse failure includes the actual body
    // (makes it self-diagnosing when the Stremio API changes its schema).
    let raw = auth_client()
        .post(format!("{STREMIO_API}/login"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .error_for_status()
        .map_err(|e| format!("HTTP {}: {}", e.status().map(|s| s.as_u16()).unwrap_or(0), e))?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("JSON parse error: {e}\nRaw response: {raw}"))?;

    // Surface API-level errors before trying to extract fields
    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(stremio_error(err.to_string()));
    }

    let auth_key = json
        .pointer("/result/authKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("authKey missing in response: {raw}"))?
        .to_string();

    // `/login`'s response shape is `{ result: { authKey, user: { _id,
    // email, ... } } }`. Probe `/result/user/email` first (canonical
    // path), then `/result/email` as a safety net for older API
    // versions / schema drift. Pre-0.6.17 sessions had this set to
    // empty because we only checked `/result/email` — that's why
    // the ProfilePopover was rendering "Stremio account" on both
    // lines instead of the user's actual address.
    let email = json
        .pointer("/result/user/email")
        .or_else(|| json.pointer("/result/email"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    // `/login`'s response embeds `result.user._id` — Stremio's stable
    // MongoDB ObjectID for the account, identical across every login
    // session on every device. We need this for the Aura Cloud Sync
    // scope hash so all of a user's devices land in the same proxy
    // bucket. Falls back to None if the field is missing (older
    // Stremio API responses, or schema drift); the session-restore
    // path will then attempt a `/getUser` backfill before deriving
    // the scope hash.
    let user_id = json
        .pointer("/result/user/_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let session = UserSession { email, auth_key, user_id };
    store_session(&app, &session)?;
    clear_account_cache();
    Ok(session)
}

/// Remove the stored session from the platform keyring (and the dev fallback
/// file in debug builds).
#[tauri::command]
pub async fn logout<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    clear_account_cache();
    delete_session(&app)
}

/// Backfill `user_id` on a stored session that predates the field
/// (pre-0.6.9 keyring blobs). Calls Stremio's `/getUser` with the
/// session's existing auth_key, extracts `result._id`, persists the
/// updated session back to the keyring, and returns the new
/// `user_id` so the caller knows the round-trip succeeded.
///
/// Idempotent: a session that already carries `user_id` short-
/// circuits and just returns the cached value, no network call.
///
/// `SESSION_EXPIRED` is returned when the API rejects the auth_key
/// — the frontend should treat that the same as get_synced_addons's
/// session-expiry path (force a fresh login).
#[tauri::command]
pub async fn backfill_user_id<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let Some(mut session) = load_session(&app)? else {
        return Ok(None);
    };
    if let Some(existing) = &session.user_id {
        if !existing.is_empty() {
            return Ok(Some(existing.clone()));
        }
    }
    if session.auth_key.is_empty() {
        return Ok(None);
    }

    let body = serde_json::json!({ "authKey": session.auth_key });
    let raw = auth_client()
        .post(format!("{STREMIO_API}/getUser"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("JSON parse error: {e}\nRaw response: {raw}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(stremio_error(err.to_string()));
    }

    // `/getUser` returns `{ result: { _id, email, ... } }` — the user
    // object is at the result root, not nested under `result.user`
    // the way `/login` shapes it. Probe both for forward-compat in
    // case the API consolidates them.
    let user_id = json
        .pointer("/result/_id")
        .or_else(|| json.pointer("/result/user/_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Email comes along for the ride — pre-0.6.17 sessions had
    // empty email fields because the original /login parser looked
    // at the wrong JSON path. Backfilling here ensures the popover
    // can render a real address on the next launch even for
    // sessions stored before the fix.
    let email = json
        .pointer("/result/email")
        .or_else(|| json.pointer("/result/user/email"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut updated = false;
    if let Some(e) = email.as_ref().filter(|s| !s.is_empty()) {
        if session.email != *e {
            session.email = e.clone();
            updated = true;
        }
    }
    match user_id {
        Some(id) if !id.is_empty() => {
            session.user_id = Some(id.clone());
            store_session(&app, &session)?;
            crate::devlog!(
                info, "auth",
                "backfilled user_id (len={}) email_updated={}",
                id.len(), updated,
            );
            Ok(Some(id))
        }
        _ => {
            if updated {
                store_session(&app, &session)?;
                crate::devlog!(info, "auth", "backfilled email only; user_id missing");
            } else {
                crate::devlog!(warn, "auth", "backfill: /getUser did not return _id; raw={raw}");
            }
            Ok(None)
        }
    }
}

/// Read the stored session without any network request.
/// Returns `null` when in guest mode (no stored token).
#[tauri::command]
pub async fn get_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<UserSession>, String> {
    let result = load_session(&app);
    // Diagnostic: when "not detecting I'm logged in" is reported, this
    // tells us whether the keyring round-trip yields a session and
    // whether `email` survived the serialise/deserialise cycle.
    match &result {
        Ok(Some(sess)) => crate::devlog!(
            info, "auth",
            "get_session → found, email_len={}, auth_key_len={}",
            sess.email.len(), sess.auth_key.len(),
        ),
        Ok(None) => crate::devlog!(info, "auth", "get_session → no stored session"),
        Err(e) => crate::devlog!(warn, "auth", "get_session → error: {}", e),
    }
    result
}

/// Read-only snapshot of the signed-in Stremio account, surfaced by the
/// Account panel. Serialised to the frontend with these exact field
/// names (snake_case == the TS `StremioAccount` interface), so NO serde
/// rename is needed — Tauri sends Rust field names outward.
#[derive(Debug, Clone, Serialize)]
pub struct StremioAccount {
    pub email: String,
    pub user_id: String,
    /// ISO date string from `/getUser` `dateRegistered`; `None` when the
    /// API omits it (frontend then hides the "Member since" row).
    pub date_registered: Option<String>,
    /// Optional premium-expiry ISO string. Only `Some` when the API
    /// actually returns a non-empty value — the panel never fabricates
    /// a "not active" line.
    pub premium_until: Option<String>,
}

// 24h in-memory cache. One signed-in account at a time, so a single
// slot suffices. Cleared on login/logout (below) so a re-auth always
// re-fetches. Fully-qualified std paths keep auth.rs's import list
// untouched.
static ACCOUNT_CACHE: std::sync::Mutex<Option<(std::time::Instant, StremioAccount)>> =
    std::sync::Mutex::new(None);

fn clear_account_cache() {
    if let Ok(mut g) = ACCOUNT_CACHE.lock() {
        *g = None;
    }
}

/// Fetch the signed-in user's Stremio account via `/getUser`, cached
/// in-memory for 24h. Self-heals the stored session's `email`: the
/// `/login` path can persist an empty email when the API omits it at
/// the probed pointers, and `backfill_user_id` short-circuits once
/// `user_id` is set — so without this a session stays stuck on an
/// empty email. Read-only: only surfaces fields the API returns;
/// never fabricates. Returns `NOT_LOGGED_IN` when there is no session.
#[tauri::command]
pub async fn fetch_stremio_account<R: Runtime>(
    app: AppHandle<R>,
) -> Result<StremioAccount, String> {
    if let Ok(g) = ACCOUNT_CACHE.lock() {
        if let Some((at, acct)) = g.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(24 * 3600) {
                return Ok(acct.clone());
            }
        }
    }

    let Some(mut session) = load_session(&app)? else {
        return Err("NOT_LOGGED_IN".into());
    };
    if session.auth_key.is_empty() {
        return Err("NOT_LOGGED_IN".into());
    }

    let body = serde_json::json!({ "authKey": session.auth_key });
    let raw = auth_client()
        .post(format!("{STREMIO_API}/getUser"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("JSON parse error: {e}\nRaw response: {raw}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(stremio_error(err.to_string()));
    }

    let email = json
        .pointer("/result/email")
        .or_else(|| json.pointer("/result/user/email"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_id = json
        .pointer("/result/_id")
        .or_else(|| json.pointer("/result/user/_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let date_registered = json
        .pointer("/result/dateRegistered")
        .or_else(|| json.pointer("/result/user/dateRegistered"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    // Defensive premium-expiry probe — surfaced only if a non-empty
    // date string is actually present.
    let premium_until = json
        .pointer("/result/premium_expire")
        .or_else(|| json.pointer("/result/user/premium_expire"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Self-heal: persist a recovered email so the ProfilePopover line
    // stops showing "Email pending sync" on the next session read.
    if !email.is_empty() && session.email != email {
        session.email = email.clone();
        store_session(&app, &session)?;
    }

    let acct = StremioAccount { email, user_id, date_registered, premium_until };
    if let Ok(mut g) = ACCOUNT_CACHE.lock() {
        *g = Some((std::time::Instant::now(), acct.clone()));
    }
    Ok(acct)
}

/// Fetch the user's installed addon list from the Stremio account API.
///
/// Returns the `SESSION_EXPIRED` sentinel string on 401 or any server-side
/// auth error so the frontend can distinguish token expiry from other
/// failures and trigger a re-login flow without crashing.
#[tauri::command]
pub async fn get_synced_addons(auth_key: String) -> Result<Vec<AddonEntry>, String> {
    let body = serde_json::json!({ "authKey": auth_key });

    let raw = auth_client()
        .post(format!("{STREMIO_API}/addonCollectionGet"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .error_for_status()
        .map_err(|e| {
            if e.status().map(|s| s.as_u16()) == Some(401) {
                SESSION_EXPIRED.into()
            } else {
                format!("HTTP error: {e}")
            }
        })?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("JSON parse error: {e}\nRaw: {raw}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(stremio_error(err.to_string()));
    }

    let addons_arr = json
        .pointer("/result/addons")
        .and_then(|v| v.as_array())
        .ok_or_else(|| format!("addons array missing in response: {raw}"))?;

    let entries = addons_arr
        .iter()
        .filter_map(|item| {
            let manifest = item.get("manifest")?;

            let name = manifest
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Unknown")
                .to_string();

            let has_search = manifest
                .get("catalogs")
                .and_then(|c| c.as_array())
                .map(|cats| {
                    cats.iter().any(|cat| {
                        cat.get("extra")
                            .and_then(|e| e.as_array())
                            .map(|extras| {
                                extras.iter().any(|ex| {
                                    ex.get("name").and_then(|v| v.as_str()) == Some("search")
                                })
                            })
                            .unwrap_or(false)
                    })
                })
                .unwrap_or(false);

            let types       = crate::stremio::extract_manifest_types(manifest);
            let resources   = crate::stremio::extract_manifest_resources(manifest);
            let id_prefixes = crate::stremio::extract_manifest_id_prefixes(manifest);
            let (stream_types, stream_id_prefixes) =
                crate::stremio::extract_stream_resource_info(manifest);
            let configurable = crate::stremio::extract_manifest_configurable(manifest);
            let manifest_id = manifest
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let transport_url = item
                .get("transportUrl")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            let base_url = transport_url
                .strip_suffix("/manifest.json")
                .unwrap_or(&transport_url)
                .trim_end_matches('/')
                .to_string();

            if base_url.is_empty() {
                None
            } else {
                Some(AddonEntry {
                    url: base_url,
                    name,
                    manifest_id,
                    has_search,
                    types,
                    resources,
                    stream_types,
                    id_prefixes,
                    stream_id_prefixes,
                    configurable,
                })
            }
        })
        .collect();

    Ok(entries)
}
