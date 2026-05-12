// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Third-party API keys stored in the OS keyring (DPAPI on Windows,
//! Keychain on macOS, Secret Service on Linux — via `keyring 3`'s
//! native backends). Replaces the previous plaintext storage in
//! `settings.json::omdb_api_key` / `opensubtitles_api_key`.
//!
//! Threat model: even in a "single-user desktop, OS-level filesystem
//! trust" context, the keyring is the right place for credentials.
//! Settings JSON lives in `<app_data>` and is readable by any process
//! with file-system access; the keyring requires the active user
//! session's encryption key.
//!
//! Layout: one keyring service identifier (`aura-api-keys`) with one
//! entry per API name. The value is the raw key string (no JSON
//! wrapping — DPAPI encrypts at the OS layer; we Zeroize the
//! in-process copy via `Zeroizing<String>` when read).
//!
//! See `migrate_api_keys_to_keyring` in `lib.rs::run` for the one-shot
//! migration that runs once per launch and moves plaintext keys out of
//! `settings.json`.

use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "aura-api-keys";

/// Canonical name of every API key Aura stores. Centralised here so
/// the migration, reads, and settings-export paths all reference the
/// same set.
pub const SUPPORTED_KEYS: &[&str] = &["omdb", "opensubtitles"];

fn entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, name).map_err(|e| e.to_string())
}

/// Read the stored API key for `name`. Returns None when the keyring
/// has no entry for that name (fresh install, post-clear, keyring
/// unavailable on the platform — Linux without Secret Service falls
/// here too). Wraps the returned string in `Zeroizing<String>` so the
/// in-process copy is wiped on drop.
pub fn read(name: &str) -> Option<Zeroizing<String>> {
    let e = entry(name).ok()?;
    let raw = e.get_password().ok()?;
    Some(Zeroizing::new(raw))
}

/// Write the API key for `name`. Empty `value` is treated as a delete
/// (semantically a user clearing the field — we don't want an empty
/// keyring entry sitting around). Returns `Err` only on keyring backend
/// failures; the caller should log + fall back to settings.json when
/// this happens.
pub fn write(name: &str, value: &str) -> Result<(), String> {
    let e = entry(name)?;
    if value.is_empty() {
        return delete(name);
    }
    e.set_password(value).map_err(|e| e.to_string())
}

/// Drop the stored entry for `name`. Idempotent — a missing entry is
/// treated as success. Mirrors the `clear_token_for` pattern in
/// `scrobble_auth.rs` for cross-module consistency.
pub fn delete(name: &str) -> Result<(), String> {
    let e = match entry(name) {
        Ok(e) => e,
        Err(_) => return Ok(()),
    };
    match e.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}

// ---------------------------------------------------------------------------
// Tauri commands — surfaced to the frontend so the Settings text inputs
// can write keys directly to the keyring (no settings.json round-trip).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_api_key(name: String) -> Result<String, String> {
    if !SUPPORTED_KEYS.contains(&name.as_str()) {
        return Err(format!("unknown API key name: {name}"));
    }
    Ok(read(&name).map(|z| z.to_string()).unwrap_or_default())
}

#[tauri::command]
pub async fn set_api_key(name: String, value: String) -> Result<(), String> {
    if !SUPPORTED_KEYS.contains(&name.as_str()) {
        return Err(format!("unknown API key name: {name}"));
    }
    write(&name, value.trim())
}

#[tauri::command]
pub async fn clear_api_key(name: String) -> Result<(), String> {
    if !SUPPORTED_KEYS.contains(&name.as_str()) {
        return Err(format!("unknown API key name: {name}"));
    }
    delete(&name)
}

// ---------------------------------------------------------------------------
// Resolver — used by feature code (omdb.rs, subtitles.rs) to fetch the
// active key. Keyring-first, with a fallback to settings.json so the
// brief migration window doesn't break in-flight feature work.
// ---------------------------------------------------------------------------

/// Resolve an API key. Tries the keyring first, then falls back to the
/// matching field in `AppSettings`. Returns None when neither source
/// has a non-empty value.
pub fn resolve(name: &str) -> Option<Zeroizing<String>> {
    if let Some(k) = read(name) {
        if !k.is_empty() { return Some(k); }
    }
    let s = crate::settings::snapshot();
    let raw = match name {
        "omdb"          => s.omdb_api_key.trim().to_string(),
        "opensubtitles" => s.opensubtitles_api_key.trim().to_string(),
        _ => return None,
    };
    if raw.is_empty() { None } else { Some(Zeroizing::new(raw)) }
}

// ---------------------------------------------------------------------------
// One-shot migration: settings.json → OS keyring
// ---------------------------------------------------------------------------

/// Move any plaintext API keys from `settings.json` into the OS keyring,
/// then null out the settings.json fields. Idempotent — re-running is a
/// no-op when there's nothing to migrate AND the keyring is already
/// populated. The keyring wins on conflict (an external edit to
/// settings.json doesn't silently overwrite a keyring value the user
/// previously set via the Settings UI).
///
/// Failure modes are non-fatal:
///   • Keyring write fails (Linux without Secret Service, etc.) → the
///     settings.json field is left intact so the resolver's fallback
///     still serves the key. Logged as a warning.
///   • Settings save fails → migrated keys still exist in the keyring;
///     next run will see settings.json still populated and try again.
///     Lossless.
pub fn migrate_from_settings<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let mut settings = crate::settings::load(app);
    let mut changed = false;

    let pairs: [(&str, String); 2] = [
        ("omdb",          settings.omdb_api_key.trim().to_string()),
        ("opensubtitles", settings.opensubtitles_api_key.trim().to_string()),
    ];

    for (name, current) in &pairs {
        if current.is_empty() {
            // Already empty in settings — nothing to migrate.
            continue;
        }
        // Only migrate when the keyring slot is empty. If the user has
        // already set the key via the Settings UI (which writes through
        // to the keyring), keep that value; otherwise we'd silently
        // overwrite it with a stale settings.json value.
        if read(name).is_none() {
            match write(name, current) {
                Ok(()) => {
                    crate::devlog!(
                        info, "migration",
                        "migrated {name} API key to OS keyring",
                    );
                }
                Err(e) => {
                    crate::devlog!(
                        warn, "migration",
                        "API key migrate {name} failed: {e} — leaving settings.json intact for fallback",
                    );
                    continue;
                }
            }
        }
        // Whether we just wrote OR the keyring was already populated:
        // null out the settings.json field. Keyring is now the source
        // of truth for this key.
        match *name {
            "omdb"          => { settings.omdb_api_key.clear(); }
            "opensubtitles" => { settings.opensubtitles_api_key.clear(); }
            _ => {}
        }
        changed = true;
    }

    if changed {
        if let Err(e) = crate::settings::save(app, &settings) {
            crate::devlog!(
                warn, "migration",
                "settings.json save after API key migration failed: {e}",
            );
        }
    }
}
