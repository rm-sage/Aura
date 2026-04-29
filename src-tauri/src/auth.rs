use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
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
            .user_agent("Aura/0.1")
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

fn load_session<R: Runtime>(app: &AppHandle<R>) -> Result<Option<UserSession>, String> {
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

    let email = json
        .pointer("/result/email")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| "") // email field is cosmetic — fall back gracefully
        .to_string();

    let session = UserSession { email, auth_key };
    store_session(&app, &session)?;
    Ok(session)
}

/// Remove the stored session from the platform keyring (and the dev fallback
/// file in debug builds).
#[tauri::command]
pub async fn logout<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    delete_session(&app)
}

/// Read the stored session without any network request.
/// Returns `null` when in guest mode (no stored token).
#[tauri::command]
pub async fn get_session<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<UserSession>, String> {
    load_session(&app)
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

            if base_url.is_empty() { None } else { Some(AddonEntry { url: base_url, name, has_search }) }
        })
        .collect();

    Ok(entries)
}
