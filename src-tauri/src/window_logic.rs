use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};
use tauri_plugin_libmpv::MpvExt;

use crate::settings;

// ---------------------------------------------------------------------------
// Discord Rich Presence
//
// Application ID is a placeholder — replace with your registered Discord
// application client ID. All RPC traffic is best-effort: if Discord isn't
// running, the connection silently fails and we move on. The client lives
// behind a global mutex so playback callbacks can update presence cheaply.
// ---------------------------------------------------------------------------

const DISCORD_CLIENT_ID: &str = "0000000000000000000"; // TODO: replace with real app ID

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiscordPresence {
    pub title: String,
    pub subtitle: Option<String>,
    pub started_at: i64, // unix seconds — Discord uses this for "elapsed"
}

static RPC: OnceLock<Mutex<Option<DiscordIpcClient>>> = OnceLock::new();

fn rpc_slot() -> &'static Mutex<Option<DiscordIpcClient>> {
    RPC.get_or_init(|| Mutex::new(None))
}

fn ensure_connected() -> bool {
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
                *slot = Some(client);
                true
            }
            Err(_) => false, // Discord likely not running — try again next call
        },
        Err(_) => false,
    }
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
// • blocked_titles contains the title     → clear presence
// • show_titles = false                   → generic "Watching on Aura"
// • else                                  → full title + subtitle
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

    // Privacy: explicit per-title blocklist (case-insensitive).
    let blocked = cfg
        .discord_rpc_blocked_titles
        .iter()
        .any(|b| b.eq_ignore_ascii_case(&p.title));
    if blocked {
        clear_presence_inner();
        return Ok(());
    }

    if !ensure_connected() {
        return Ok(()); // best-effort
    }

    let (details, state) = if cfg.discord_rpc_show_titles {
        (p.title.clone(), p.subtitle.unwrap_or_else(|| "Aura".into()))
    } else {
        ("Watching".into(), "Aura".into())
    };

    let timestamps = Timestamps::new().start(p.started_at);
    let assets = Assets::new().large_image("aura_logo").large_text("Aura");

    let activity = Activity::new()
        .details(&details)
        .state(&state)
        .timestamps(timestamps)
        .assets(assets);

    let result = {
        let mut slot = rpc_slot().lock().map_err(|e| e.to_string())?;
        match slot.as_mut() {
            Some(client) => client.set_activity(activity),
            None => return Ok(()),
        }
    };

    if result.is_err() {
        drop_connection(); // force reconnect on next call
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
        // Use set_property pause=true (idempotent). cycle would also flip a
        // paused video back to playing on a second focus event.
        let _ = app.mpv().command(
            "set_property",
            &vec![serde_json::json!("pause"), serde_json::json!(true)],
            "main",
        );
    });
}

fn stop_mpv<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = app.mpv().command("stop", &Vec::<serde_json::Value>::new(), "main");
    });
}

/// Install the window-event handler. Call from Tauri `setup`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let handle = app.clone();

    window.clone().on_window_event(move |event| {
        let cfg = settings::snapshot();
        match event {
            WindowEvent::Focused(false) if cfg.pause_on_lost_focus => {
                pause_mpv(&handle);
            }
            // Resized to (0, 0) on Windows ≈ minimised. Tauri 2 fires this
            // reliably across platforms when the user clicks the OS minimise
            // button or our own custom button.
            WindowEvent::Resized(size)
                if cfg.pause_on_minimize && size.width == 0 && size.height == 0 =>
            {
                pause_mpv(&handle);
            }
            WindowEvent::CloseRequested { .. } if cfg.close_on_exit => {
                // Stop playback cleanly so libmpv flushes its writers before
                // the process tears down. The default close handler then
                // proceeds — we don't call api.prevent_close().
                stop_mpv(&handle);
                clear_presence_inner();
            }
            _ => {}
        }
    });
}
