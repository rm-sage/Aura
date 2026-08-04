// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Tray icon — created at startup but kept HIDDEN until the main window is
//! actually hidden to the tray (the close-to-tray path in window_logic). While
//! hidden the tray icon is the window's only route back, so it appears exactly
//! then and is hidden again the moment the window is restored — no permanent
//! tray clutter while the window is on screen / in the taskbar.
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

    let tray = TrayIconBuilder::with_id("aura-tray")
        .icon(icon)
        .tooltip("Aura")
        .menu(&menu)
        // show_menu_on_left_click: when false, left-click triggers
        // TrayIconEvent::Click instead of opening the menu — we use that
        // to bring the window back into focus, matching Stremio's behaviour.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-show" => show_main_window(app),
            // Route the quit through the window's CloseRequested handler rather
            // than exiting outright. `app.exit(0)` returns from the event loop
            // immediately and runs NONE of the shutdown work: MPV is never torn
            // down (so libmpv can hold its WASAPI device past process exit -
            // landmine #9), the scrobble stop is never flushed (Trakt stays on
            // "Currently watching"), and the cast session is never stopped.
            // request_quit arms the force-quit flag and issues a normal close, so
            // quitting from the tray now gets the same teardown as clicking X
            // with tray mode off.
            "tray-quit" => crate::window_logic::request_quit(app.clone()),
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

    // Hidden until the window is actually hidden to the tray (see
    // set_tray_visible, driven from window_logic's close-to-tray path).
    let _ = tray.set_visible(false);
    Ok(())
}

/// Show or hide the tray icon. Shown only while the main window is hidden to the
/// tray (its sole route back); hidden whenever the window is on screen / in the
/// taskbar so it isn't permanent clutter. No-op if the tray failed to install.
pub fn set_tray_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    if let Some(tray) = app.tray_by_id("aura-tray") {
        let _ = tray.set_visible(visible);
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        // Window is back on screen — the tray icon's job is done; hide it again.
        set_tray_visible(app, false);
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
