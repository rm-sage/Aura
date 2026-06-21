// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Navigation commands for the in-app SourcePopup child webview.
//!
//! The JS `@tauri-apps/api/webview` `Webview` class doesn't expose `eval`
//! on child popup webviews — only the Rust-side `Webview::eval` does.
//! These commands bridge the gap so the popup's chrome strip can drive
//! Back / Forward / Refresh / Navigate without giving the frontend a
//! generic eval surface.
//!
//! Label scoping: every command verifies the requested webview's label
//! starts with `aura-source-popup-`, which is the prefix
//! `SourcePopupHost` mints for its child webviews. Without that gate a
//! malicious React component could pass `"main"` and drive the parent.

use tauri::{AppHandle, Manager};

const POPUP_LABEL_PREFIX: &str = "aura-source-popup-";

fn find_popup<R: tauri::Runtime>(
    app: &AppHandle<R>,
    label: &str,
) -> Result<tauri::webview::Webview<R>, String> {
    if !label.starts_with(POPUP_LABEL_PREFIX) {
        return Err(format!("label out of scope: {label}"));
    }
    app.get_webview(label)
        .ok_or_else(|| format!("popup webview not found: {label}"))
}

#[tauri::command]
pub fn popup_webview_back(app: AppHandle, label: String) -> Result<(), String> {
    find_popup(&app, &label)?
        .eval("history.back()")
        .map_err(|e| format!("eval failed: {e}"))
}

#[tauri::command]
pub fn popup_webview_forward(app: AppHandle, label: String) -> Result<(), String> {
    find_popup(&app, &label)?
        .eval("history.forward()")
        .map_err(|e| format!("eval failed: {e}"))
}

#[tauri::command]
pub fn popup_webview_reload(app: AppHandle, label: String) -> Result<(), String> {
    find_popup(&app, &label)?
        .eval("location.reload()")
        .map_err(|e| format!("eval failed: {e}"))
}

/// Navigate the popup to `url`. Frontend pre-validates http(s)-only but
/// we double-check on the Rust side: the popup webview shares the
/// app's WebView2 process and a stray `javascript:` / `file:` /
/// `tauri:` here would have full execution rights inside the popup's
/// browsing context.
#[tauri::command]
pub fn popup_webview_navigate(
    app: AppHandle,
    label: String,
    url: String,
) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(format!("scheme not allowed: {}", parsed.scheme()));
    }
    let escaped = serde_json::to_string(&url)
        .map_err(|e| format!("escape failed: {e}"))?;
    find_popup(&app, &label)?
        .eval(format!("location.assign({escaped})"))
        .map_err(|e| format!("eval failed: {e}"))
}

/// Read the popup webview's current top-level URL. The SourcePopup chrome
/// strip polls this so the address bar tracks navigation that happens
/// *inside* the page — clicking links, submitting forms, AND SPA
/// client-side route changes (e.g. AniList's Vue router calling
/// `history.pushState`). This reads WebView2's live `Source` property,
/// which the engine keeps in sync for pushState/replaceState to a new
/// URL as well as ordinary document navigations — so we reflect the
/// current page without injecting a content script into the (sandboxed,
/// external-origin) popup. Returns the URL string; the JS side diffs it
/// against the last-known committed URL and only repaints the address
/// bar when it actually changes.
///
/// Pure read — no `eval`, no navigation — so it's safe to call on a
/// short interval. Errors (popup torn down mid-poll, not yet attached)
/// are surfaced to the caller, which ignores them and retries next tick.
#[tauri::command]
pub fn popup_webview_current_url(app: AppHandle, label: String) -> Result<String, String> {
    find_popup(&app, &label)?
        .url()
        .map(|u| u.to_string())
        .map_err(|e| format!("url read failed: {e}"))
}
