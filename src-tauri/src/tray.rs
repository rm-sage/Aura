// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tray icon — installed once at startup, even when the user has
//! `minimize_to_tray_on_close` disabled. The icon stays in the system tray
//! the whole session; the toggle only changes whether the X button hides
//! to it or exits cleanly.
//!
//! Menu:
//!   • Show Aura — re-shows the window (restores from tray-hide / minimise).
//!   • Quit      — clean exit (mirrors clicking X with the toggle off).
//!
//! Left-click on the tray icon also re-shows the window (same as Show Aura).

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn install<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let show = MenuItem::with_id(app, "tray-show", "Show Aura", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|e| e.to_string())?;

    let icon = app
        .default_window_icon()
        .ok_or_else(|| "no default window icon".to_string())?
        .clone();

    let _ = TrayIconBuilder::with_id("aura-tray")
        .icon(icon)
        .tooltip("Aura")
        .menu(&menu)
        // show_menu_on_left_click: when false, left-click triggers
        // TrayIconEvent::Click instead of opening the menu — we use that
        // to bring the window back into focus, matching Stremio's behaviour.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    Ok(())
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // Notify the frontend that the window came back from a hidden
        // (tray) state. App.tsx listens and pokes MPV's render context
        // via refresh_video to clear any vo staleness from the
        // off-screen render period, and lets the stale-heartbeat
        // detector run with a tighter window so a stream that died
        // while we were hidden surfaces the reload prompt promptly
        // instead of waiting 8 s of post-resume silence.
        let _ = app.emit("aura:window-restored-from-tray", ());
    }
}
