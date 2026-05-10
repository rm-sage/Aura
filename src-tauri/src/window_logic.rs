// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};
use tauri_plugin_libmpv::MpvExt;

use crate::settings;

// ---------------------------------------------------------------------------
// Discord Rich Presence
//
// Client ID is hardcoded — we ship one Aura-branded Discord application
// that every install connects to. Empty string disables RPC (useful in dev
// while the app ID hasn't been set yet).
//
// Connection lives behind a global mutex so playback callbacks can update
// presence cheaply. Failed connections are logged once per attempt; the next
// call retries (handles "user started Discord after Aura").
// ---------------------------------------------------------------------------

/// Aura's Discord application ID. Leave empty to disable RPC.
const DISCORD_CLIENT_ID: &str = "1499651271357890610";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiscordPresence {
    /// Top line shown in Discord ("Watching Frieren", "Browsing Home", …).
    /// Required (will fail validation client-side if empty).
    pub title: String,
    /// Second line in Discord ("Episode 5", "On Home", …). Optional.
    pub subtitle: Option<String>,
    /// Unix seconds — Discord renders an "Elapsed: hh:mm" counter when
    /// non-zero. 0 = hide the timestamp (used for browse states so the
    /// counter doesn't grow stale on a parked screen).
    pub started_at: i64,
    /// True for active playback (matters for the `discord_rpc_browse_states`
    /// gate AND for the per-title blocklist, which should NOT redact
    /// non-playback screen names). Defaults to false (browse) so legacy
    /// callers without the flag are treated as ambient state.
    #[serde(default)]
    pub is_playback: bool,
    /// Optional HTTPS URL for the large image — Discord RPC v9+ accepts
    /// raw URLs in addition to uploaded asset names. We pass the meta's
    /// poster / background here when watching or browsing a specific
    /// title; falls back to the "aura_logo" uploaded asset for browse
    /// screens where there's no specific title.
    #[serde(default)]
    pub large_image_url: Option<String>,
    /// Hover-text on the large image. "Aura" by default; for content,
    /// pass the title so Discord shows "Frieren: Beyond Journey's End"
    /// when the user hovers.
    #[serde(default)]
    pub large_image_text: Option<String>,
}

static RPC: OnceLock<Mutex<Option<DiscordIpcClient>>> = OnceLock::new();

fn rpc_slot() -> &'static Mutex<Option<DiscordIpcClient>> {
    RPC.get_or_init(|| Mutex::new(None))
}

fn ensure_connected() -> bool {
    if DISCORD_CLIENT_ID.is_empty() {
        return false;
    }
    let mut slot = match rpc_slot().lock() {
        Ok(g) => g,
        Err(_) => return false,
    };
    if slot.is_some() {
        return true;
    }
    match DiscordIpcClient::new(DISCORD_CLIENT_ID) {
        Ok(mut client) => match client.connect() {
            Ok(()) => {
                crate::devlog!(info, "rpc", "connected to Discord (app {})", DISCORD_CLIENT_ID);
                // Re-arm the warn rate-limiter so the next disconnect logs
                // once instead of being silently swallowed.
                LAST_CONNECT_WARN_SECS.store(0, Ordering::Relaxed);
                *slot = Some(client);
                true
            }
            Err(e) => {
                rate_limited_connect_warn(format_args!("Discord connect failed: {}", e));
                false
            }
        },
        Err(e) => {
            rate_limited_connect_warn(format_args!("Discord client init failed: {}", e));
            false
        }
    }
}

/// Throttled WARN logger for Discord-IPC failures. The presence-update
/// path runs on every meaningful playback event (load_video, pause,
/// resume, scrub, focus/blur, RPC config change, …), so when Discord
/// isn't running the unsuppressed warn fires several times per second
/// and crowds out everything else in the dev-log. We rate-limit to once
/// per RPC_WARN_THROTTLE_SECS; the first failure after a successful
/// connect (or after the throttle window) prints, the rest are silent.
const RPC_WARN_THROTTLE_SECS: i64 = 30;
static LAST_CONNECT_WARN_SECS: AtomicI64 = AtomicI64::new(0);

fn rate_limited_connect_warn(args: std::fmt::Arguments<'_>) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let last = LAST_CONNECT_WARN_SECS.load(Ordering::Relaxed);
    if now.saturating_sub(last) < RPC_WARN_THROTTLE_SECS {
        return;
    }
    LAST_CONNECT_WARN_SECS.store(now, Ordering::Relaxed);
    crate::devlog!(warn, "rpc", "{}", args);
}

fn drop_connection() {
    if let Ok(mut slot) = rpc_slot().lock() {
        if let Some(mut client) = slot.take() {
            let _ = client.close();
        }
    }
}

// ---------------------------------------------------------------------------
// Privacy-aware presence update
//
// • discord_rpc_enabled = false           → clear presence
// • is_playback = false &&
//   discord_rpc_browse_states = false     → clear presence (no ambient RPC)
// • is_playback && blocked_titles match   → clear presence
// • is_playback && show_titles = false    → generic "Watching" / "Aura"
// • !is_playback                          → details/state passed through as-is
//                                            (browse screens are not titles, so
//                                             show_titles & blocklist don't apply)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn discord_set_presence(
    presence: Option<DiscordPresence>,
) -> Result<(), String> {
    let cfg = settings::snapshot();

    // RPC fully disabled → clear and bail.
    if !cfg.discord_rpc_enabled {
        clear_presence_inner();
        return Ok(());
    }

    // No payload → clear presence (caller is signalling "stopped watching").
    let Some(p) = presence else {
        clear_presence_inner();
        return Ok(());
    };

    // Browse states gated separately so users who only want playback RPC
    // don't get their idle screen broadcast.
    if !p.is_playback && !cfg.discord_rpc_browse_states {
        clear_presence_inner();
        return Ok(());
    }

    // Privacy controls only apply to actual content titles. Browse states
    // ("On Home", "In Settings") are screen labels, not titles, so the
    // per-title blocklist and show_titles toggle would just produce confusing
    // redactions ("Watching" while you're literally on the Settings screen).
    let (details, state) = if p.is_playback {
        let blocked = cfg
            .discord_rpc_blocked_titles
            .iter()
            .any(|b| b.eq_ignore_ascii_case(&p.title));
        if blocked {
            clear_presence_inner();
            return Ok(());
        }
        if cfg.discord_rpc_show_titles {
            (p.title.clone(), p.subtitle.clone().unwrap_or_else(|| "Aura".into()))
        } else {
            ("Watching".into(), "Aura".into())
        }
    } else {
        (p.title.clone(), p.subtitle.clone().unwrap_or_else(|| "Aura".into()))
    };

    if !ensure_connected() {
        return Ok(()); // best-effort — already logged inside
    }

    // Discord's RPC API (v9+) accepts both uploaded asset NAMES (the
    // "aura_logo" entry under Developer Portal → Rich Presence → Art
    // Assets) AND raw HTTPS URLs. Pass the meta poster URL through when
    // we have one so Discord shows the actual show / movie art instead
    // of the generic Aura mark; fall back to "aura_logo" for browse
    // screens or when the metadata addon didn't ship art.
    //
    // Privacy note: when `discord_rpc_show_titles` is OFF for playback,
    // we redact details/state but ALSO redact the artwork — otherwise
    // Discord still leaks the show identity via the image. For browse
    // screens (is_playback=false) the art stays since there's nothing
    // private to leak in "On Home" / "In Settings".
    let large_image: &str = if p.is_playback && !cfg.discord_rpc_show_titles {
        "aura_logo"
    } else {
        match p.large_image_url.as_deref() {
            Some(u) if u.starts_with("http") => u,
            _ => "aura_logo",
        }
    };
    let large_text: &str = if p.is_playback && !cfg.discord_rpc_show_titles {
        "Aura"
    } else {
        p.large_image_text.as_deref().unwrap_or("Aura")
    };
    let assets = Assets::new().large_image(large_image).large_text(large_text);
    // ActivityType::Watching gives the "Watching Aura" prefix that the
    // user prefers — Discord's protocol locks the verb to one of its
    // built-in types (Playing / Listening to / Watching / Competing in)
    // so anything custom like "Farming" isn't expressible without
    // rejected protocol hacks. Sticking with Watching here.
    let mut activity = Activity::new()
        .activity_type(ActivityType::Watching)
        .details(&details)
        .state(&state)
        .assets(assets);
    let ts;
    if p.started_at > 0 {
        ts = Timestamps::new().start(p.started_at);
        activity = activity.timestamps(ts);
    }

    crate::devlog!(
        info, "rpc",
        "set_activity → details={:?} state={:?} started_at={}",
        details, state, p.started_at,
    );

    let result = {
        let mut slot = rpc_slot().lock().map_err(|e| e.to_string())?;
        match slot.as_mut() {
            Some(client) => client.set_activity(activity),
            None => return Ok(()),
        }
    };

    if let Err(e) = result {
        crate::devlog!(warn, "rpc", "set_activity failed, dropping connection: {}", e);
        drop_connection(); // force reconnect on next call
    } else {
        crate::devlog!(info, "rpc", "set_activity OK");
    }
    Ok(())
}

fn clear_presence_inner() {
    if let Ok(mut slot) = rpc_slot().lock() {
        if let Some(client) = slot.as_mut() {
            let _ = client.clear_activity();
        }
    }
}

#[tauri::command]
pub async fn discord_clear_presence() -> Result<(), String> {
    clear_presence_inner();
    Ok(())
}

#[allow(dead_code)] // exposed for tests / future use
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Window event lifecycle
//
// • PauseOnLostFocus — pause MPV when the window loses focus
// • PauseOnMinimize  — pause MPV when the window is minimised (Resized w/0,0
//                     is the most reliable cross-platform minimise heuristic)
// • CloseOnExit      — when window close is requested AND close_on_exit is on,
//                     stop MPV cleanly and let the default close proceed
// ---------------------------------------------------------------------------

fn pause_mpv<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // CLAUDE.md landmine #1: this libmpv build silently no-ops the
        // generic `command("set_property", [name, value])` form. We
        // MUST use the dedicated `set_property` FFI path, otherwise
        // pause-on-focus-lost / pause-on-minimize fire the call but
        // libmpv ignores it and playback keeps going. Symptom: user
        // alt-tabs away expecting playback to halt; audio keeps
        // bleeding through.
        let _ = app.mpv().set_property(
            "pause",
            &serde_json::json!(true),
            "main",
        );
    });
}

/// SYNCHRONOUS shutdown — used in the CloseRequested path so MPV is fully
/// torn down BEFORE the process exits. The async spawn_blocking in
/// `stop_mpv` returns immediately, which on Windows can leave the WASAPI
/// audio device handle dangling and prevents Stremio / mpv.net from
/// opening the same device on the next launch. Calling `mute=yes`,
/// `stop`, then destroying the instance synchronously gives libmpv enough
/// time to release the device cleanly.
fn shutdown_mpv_sync<R: Runtime>(app: &AppHandle<R>) {
    let mpv = app.mpv();
    // 1. Mute first so any in-flight audio buffers don't squeak through
    //    the device-close path (a known cause of "stuck" exclusive
    //    locks). Per CLAUDE.md landmine #1 the `command("set_property",
    //    ...)` form silently no-ops on this libmpv build, so the older
    //    spelling here was failing to actually mute — defeating the
    //    WASAPI lock-protection this whole shutdown sequence exists
    //    for. Use the dedicated set_property FFI path.
    let _ = mpv.set_property("mute", &serde_json::json!(true), "main");
    // 2. Stop the loadfile. This unlinks the demuxer and releases the AO.
    let _ = mpv.command("stop", &Vec::<serde_json::Value>::new(), "main");
    // 3. Tear down the MPV instance. The plugin's `destroy` calls
    //    `mpv_terminate_destroy` under the hood, which is the only way to
    //    guarantee WASAPI hands the device back to the OS mixer.
    let _ = mpv.destroy("main");
    crate::devlog!(info, "player", "MPV shut down on close");
}

/// Install the window-event handler. Call from Tauri `setup`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let handle = app.clone();
    let win = window.clone();

    window.clone().on_window_event(move |event| {
        let cfg = settings::snapshot();
        match event {
            WindowEvent::Focused(false) if cfg.pause_on_lost_focus => {
                crate::devlog!(info, "win", "lost focus → pause MPV");
                pause_mpv(&handle);
            }
            // Focus REGAIN backstop. After an alt-tab cycle (especially
            // following an enter/exit fullscreen sequence) libmpv's vo
            // child window has been observed to drift back to its default
            // rect — (0, 0, parent_client_w, parent_client_h) — which
            // covers the title-bar area when the parent is windowed.
            // Visible symptom: MPV "grows" 36 px upward and renders
            // behind the Aura title bar.
            //
            // We can't fix this from the React side because Tauri's
            // `onResized` doesn't fire for focus changes, and the
            // duration-armed refresh runs only once per stream-load. The
            // previous attempt at a frontend focus-regain refresh used
            // the `refresh_video` command, which toggles `video-zoom`
            // 0.0001 ↔ 0.0 to force an MPV re-render — that toggle
            // produced a visible expand-then-shrink flicker on every
            // alt-tab back. Here we ONLY call `resize_mpv_child_to_parent`
            // (a plain SetWindowPos on MPV's child HWND) with no
            // video-zoom side effect, so no flicker.
            WindowEvent::Focused(true) => {
                #[cfg(target_os = "windows")]
                {
                    let parent_hwnd: isize =
                        win.hwnd().ok().map(|h| h.0 as isize).unwrap_or(0);
                    if parent_hwnd != 0 {
                        let y_offset = if crate::win32::is_in_native_fullscreen() {
                            0
                        } else {
                            36
                        };
                        crate::win32::resize_mpv_child_to_parent(parent_hwnd, y_offset);
                    }
                }
            }
            // Resized fires for minimise too — but the size payload isn't a
            // reliable signal across Tauri / Windows versions (sometimes
            // (0, 0), sometimes a stale value, sometimes absent). The
            // canonical check is the OS-level minimised flag, which Tauri
            // exposes via `is_minimized()`. We query it on EVERY resize and
            // pause if the window is now minimised.
            //
            // We ALSO use this hook as a backstop for the MPV-child resize
            // sync. The React side (onResized → refresh_video) already
            // handles this in normal operation, but if the JS side is busy
            // (long fetch, heavy render, …) the child can lag the parent.
            // Resyncing in Rust costs nothing and guarantees the child
            // tracks the parent's client area.
            WindowEvent::Resized(_) => {
                if cfg.pause_on_minimize {
                    if let Ok(true) = win.is_minimized() {
                        crate::devlog!(info, "win", "minimised → pause MPV");
                        pause_mpv(&handle);
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    let parent_hwnd: isize = win.hwnd().ok().map(|h| h.0 as isize).unwrap_or(0);
                    if parent_hwnd != 0 {
                        // y_offset = 0 in fullscreen (we sit at monitor top
                        // and the title bar is unmounted), 36 windowed
                        // (TitleBar component height).
                        let y_offset = if crate::win32::is_in_native_fullscreen() { 0 } else { 36 };
                        crate::win32::resize_mpv_child_to_parent(parent_hwnd, y_offset);
                    }
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                // Belt-and-suspenders — restore the Windows taskbar in
                // case the user closes while still in fullscreen mode.
                #[cfg(target_os = "windows")]
                crate::win32::ensure_taskbar_visible();

                if cfg.minimize_to_tray_on_close {
                    // Tray-hide path — keep the process alive, let the user
                    // bring the window back via the tray icon. We deliberately
                    // do NOT stop MPV: hiding the window mid-playback should
                    // feel like a quick "hide, resume later" toggle.
                    api.prevent_close();
                    let _ = win.hide();
                } else {
                    // Clean-shutdown path — tear down MPV synchronously so
                    // libmpv releases its WASAPI device, then EXPLICITLY
                    // exit the process. The tray icon (always installed)
                    // would otherwise keep the app alive in a zombie state
                    // where the window has closed AND MPV has been
                    // destroyed — every subsequent load_video would error
                    // out with "instance not found".
                    //
                    // FLUSH SCROBBLE FIRST. If a scrobble session was open
                    // (Trakt check-in / AniList in-progress mark), POST
                    // the /end event before tearing MPV down so the
                    // remote service sees a clean stop. Without this the
                    // user's Trakt status was stuck on "Currently
                    // watching" for hours after a hard window close
                    // (the JS-side useScrobble cleanup never ran because
                    // React doesn't get a teardown when the process
                    // exits via app.exit). Capped at 2 s internally.
                    crate::scrobble::shutdown_blocking(&handle);
                    shutdown_mpv_sync(&handle);
                    clear_presence_inner();
                    // Reap the streaming-bridge subprocess so it doesn't
                    // outlive the parent. Without this the bridge keeps
                    // its TCP listener bound to 11471 and the next Aura
                    // launch can't bind the same port (the OS holds it
                    // for ~30 s in TIME_WAIT before the parent's death
                    // releases it via Windows' job-object semantics).
                    crate::shutdown_bridge_subprocess();
                    handle.exit(0);
                }
            }
            _ => {}
        }
    });
}
