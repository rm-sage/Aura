mod addons;
mod auth;
mod cinema;
mod player;
mod scrobble;
mod settings;
mod streaming;
mod stremio;
mod window_logic;

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{Emitter, Listener, Manager};
use tauri_plugin_libmpv::MpvExt;

// ---------------------------------------------------------------------------
// Shared playback state (updated by the mpv-event-main observer bridge)
// ---------------------------------------------------------------------------

#[derive(Default, Clone, Serialize)]
struct PlaybackState {
    time: f64,
    duration: f64,
    paused: bool,
}

/// Performance stats for the Cinema Suite OSD.
/// Emitted as a separate `osd-update` event to avoid inflating the high-
/// frequency `playback-update` payload.
#[derive(Default, Clone, Serialize)]
struct OsdState {
    frame_drops: i64,
    video_width: i64,
    video_height: i64,
    display_fps: f64,
    shader_profile: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn load_video(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let normalised = path.replace('\\', "/");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command(
                "loadfile",
                &vec![serde_json::json!(normalised), serde_json::json!("replace")],
                "main",
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn toggle_pause(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command("cycle", &vec![serde_json::json!("pause")], "main")
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn seek_relative(app: tauri::AppHandle, seconds: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command(
                "seek",
                &vec![serde_json::json!(seconds), serde_json::json!("relative")],
                "main",
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_volume(app: tauri::AppHandle, volume: f64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command(
                "set_property",
                &vec![serde_json::json!("volume"), serde_json::json!(volume)],
                "main",
            )
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Apply audio + subtitle language defaults to MPV. Called by the frontend
/// when a meta loads — the `is_anime` flag picks between the Anime and Global
/// defaults stored in settings. MPV's `alang`/`slang` accept comma-separated
/// fallbacks; we always provide both so MPV picks whichever track exists.
#[tauri::command]
async fn apply_lang_defaults(
    app: tauri::AppHandle,
    is_anime: bool,
) -> Result<(), String> {
    let s = settings::snapshot();
    let (audio, subs) = if is_anime {
        (
            format!("{},{}", s.anime_audio_lang, s.global_audio_lang),
            format!("{},{}", s.anime_subs_lang, s.global_subs_lang),
        )
    } else {
        (
            format!("{},{}", s.global_audio_lang, s.anime_audio_lang),
            format!("{},{}", s.global_subs_lang, s.anime_subs_lang),
        )
    };

    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command(
                "set_property",
                &vec![serde_json::json!("alang"), serde_json::json!(audio)],
                "main",
            )
            .map_err(|e| e.to_string())?;
        app.mpv()
            .command(
                "set_property",
                &vec![serde_json::json!("slang"), serde_json::json!(subs)],
                "main",
            )
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_libmpv::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // ── DLL pre-flight ─────────────────────────────────────────────
            player::check_mpv_dll().map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::NotFound, e)
            })?;

            // ── Vibrancy ───────────────────────────────────────────────────
            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::{apply_acrylic, apply_mica};
                apply_mica(&window, Some(true))
                    .or_else(|_| apply_acrylic(&window, Some((0, 0, 0, 180))))
                    .expect("Failed to apply Windows vibrancy");
            }

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None)
                    .expect("Failed to apply macOS vibrancy");
            }

            // ── Settings — eager load so cache is hot for window callbacks ─
            settings::load(app.handle());

            // ── MPV engine ─────────────────────────────────────────────────
            player::init_mpv(app.handle()).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::Other, e)
            })?;

            // ── Window lifecycle (pause-on-blur, pause-on-min, close-on-exit) ─
            window_logic::install(app.handle());

            // ── Streaming bridge ───────────────────────────────────────────
            // Start the local HTTP proxy on 11471 in a dedicated async task.
            // The bridge runs independently of the Tauri event loop.
            let bridge_cfg = streaming::BridgeConfig::default();
            tauri::async_runtime::spawn(streaming::start(bridge_cfg));

            // ── Deep-link handler ─────────────────────────────────────────
            // Emits `deep-link` events to the frontend for both aura:// and
            // stremio:// protocol URLs so the UI can route them.
            {
                let handle = app.handle().clone();
                app.listen("deep-link://new-url", move |event| {
                    if let Ok(url) = serde_json::from_str::<String>(event.payload()) {
                        handle.emit("deep-link", url).ok();
                    }
                });
            }

            // ── Observer bridge ────────────────────────────────────────────
            // The plugin emits `mpv-event-main` for every observed property change.
            // We maintain two snapshot structs — PlaybackState (high-frequency,
            // sent as `playback-update`) and OsdState (low-frequency, sent as
            // `osd-update`) — and re-emit only the relevant one on each change.
            let pb_state: Arc<Mutex<PlaybackState>> =
                Arc::new(Mutex::new(PlaybackState::default()));
            let osd_state: Arc<Mutex<OsdState>> = Arc::new(Mutex::new(OsdState::default()));

            let handle = app.handle().clone();
            let pb_ref = pb_state.clone();
            let osd_ref = osd_state.clone();

            app.listen("mpv-event-main", move |event| {
                let Ok(ev) =
                    serde_json::from_str::<serde_json::Value>(event.payload())
                else {
                    return;
                };

                let name = ev.get("name").and_then(|v| v.as_str()).unwrap_or("");

                match name {
                    // ── Playback properties ──────────────────────────────
                    "pause" | "time-pos" | "duration" => {
                        let mut st = pb_ref.lock().unwrap();
                        match name {
                            "pause" => {
                                let paused =
                                    ev.get("data").and_then(|v| v.as_bool()).unwrap_or(false);
                                st.paused = paused;

                                // Re-apply Mica on pause; the DWM compositor
                                // drops the acrylic backdrop while MPV is
                                // compositing its own frame.
                                if paused {
                                    if let Some(win) = handle.get_webview_window("main") {
                                        let w = win.clone();
                                        win.run_on_main_thread(move || {
                                            #[cfg(target_os = "windows")]
                                            window_vibrancy::apply_mica(&w, Some(true)).ok();
                                        })
                                        .ok();
                                    }
                                }
                            }
                            "time-pos" => {
                                st.time =
                                    ev.get("data").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            }
                            "duration" => {
                                st.duration =
                                    ev.get("data").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            }
                            _ => {}
                        }
                        let snapshot = st.clone();
                        drop(st);
                        handle.emit("playback-update", snapshot).ok();
                    }

                    // ── OSD properties ───────────────────────────────────
                    "frame-drop-count" | "dwidth" | "dheight" | "display-fps" => {
                        let mut st = osd_ref.lock().unwrap();
                        match name {
                            "frame-drop-count" => {
                                st.frame_drops =
                                    ev.get("data").and_then(|v| v.as_i64()).unwrap_or(0);
                            }
                            "dwidth" => {
                                st.video_width =
                                    ev.get("data").and_then(|v| v.as_i64()).unwrap_or(0);
                            }
                            "dheight" => {
                                st.video_height =
                                    ev.get("data").and_then(|v| v.as_i64()).unwrap_or(0);
                            }
                            "display-fps" => {
                                st.display_fps =
                                    ev.get("data").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            }
                            _ => {}
                        }
                        st.shader_profile = cinema::active_profile_name().to_string();
                        let snapshot = st.clone();
                        drop(st);
                        handle.emit("osd-update", snapshot).ok();
                    }

                    _ => {}
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ── Player ──────────────────────────────────────────────────────
            load_video,
            toggle_pause,
            seek_relative,
            set_volume,
            apply_lang_defaults,
            // ── Stremio catalog ─────────────────────────────────────────────
            stremio::fetch_catalog,
            stremio::get_addon_manifest,
            // ── Addon management (guest) ─────────────────────────────────────
            stremio::add_addon,
            stremio::remove_addon,
            stremio::list_addons,
            // ── Global search & cloud sync (2.3) ────────────────────────────
            stremio::global_search,
            stremio::cloud_add_addon,
            stremio::cloud_remove_addon,
            // ── Auth ────────────────────────────────────────────────────────
            auth::login,
            auth::logout,
            auth::get_session,
            auth::get_synced_addons,
            // ── Streaming bridge (2.4) ───────────────────────────────────────
            streaming::resolve_stream,
            // ── Cinema Suite (2.6) ──────────────────────────────────────────
            cinema::list_shader_profiles,
            cinema::set_shader_profile,
            cinema::get_shader_profile,
            // ── Phase 3B: meta detail, library sync, settings ────────────────
            stremio::fetch_meta_detail,
            stremio::library_get,
            stremio::library_put,
            settings::get_settings,
            settings::set_theme,
            settings::update_settings,
            // ── Phase 3C: scrobbling ──────────────────────────────────────────
            scrobble::scrobble_start,
            scrobble::scrobble_heartbeat,
            scrobble::scrobble_end,
            // ── Phase 3C: Discord RPC ─────────────────────────────────────────
            window_logic::discord_set_presence,
            window_logic::discord_clear_presence,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
