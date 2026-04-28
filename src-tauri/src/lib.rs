mod player;

use tauri::{Listener, Manager};
use tauri_plugin_libmpv::MpvExt;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Load a media file into the embedded MPV instance and begin playback.
///
/// Accepts any path format MPV understands (local file, URL, `magnet:`, …).
/// Windows back-slashes are normalised to forward slashes before dispatch.
#[tauri::command]
async fn load_video(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let normalised = path.replace('\\', "/");
    tauri::async_runtime::spawn_blocking(move || {
        app.mpv()
            .command(
                "loadfile",
                &vec![
                    serde_json::json!(normalised),
                    serde_json::json!("replace"),
                ],
                "main",
            )
            .map_err(|e| e.to_string())
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
        // tauri-plugin-libmpv: manages MPV instances, routes commands, emits events.
        .plugin(tauri_plugin_libmpv::init())
        .setup(|app| {
            // ---- DLL pre-flight -------------------------------------------
            // Fail fast with a clear message before any window appears, so the
            // user sees a helpful error rather than an OS-level crash dialog.
            player::check_mpv_dll().map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::NotFound, e)
            })?;

            // ---- Vibrancy -------------------------------------------------
            let window = app.get_webview_window("main").unwrap();

            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::{apply_acrylic, apply_mica};
                apply_mica(&window, Some(true))
                    .or_else(|_| apply_acrylic(&window, Some((0, 0, 0, 180))))
                    .expect("Failed to apply Windows vibrancy (Mica/Acrylic)");
            }

            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                apply_vibrancy(&window, NSVisualEffectMaterial::HudWindow, None, None)
                    .expect("Failed to apply macOS vibrancy");
            }

            // ---- MPV engine -----------------------------------------------
            // Creates the wid-mode MPV instance for the "main" window with the
            // rendering options from the spec (vo=gpu-next, hwdec=auto-safe).
            // The plugin resolves the window HWND internally.
            player::init_mpv(app.handle()).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::Other, e)
            })?;

            // ---- Mica persistence on pause --------------------------------
            // When MPV pauses it stops submitting frames to the swap-chain.
            // On Windows 11 this can cause the DWM compositor to drop the Mica
            // backdrop. Re-applying the attribute on every pause event is
            // idempotent and keeps the glass effect alive.
            let handle = app.handle().clone();
            app.listen("mpv-event-main", move |event| {
                if let Ok(ev) =
                    serde_json::from_str::<serde_json::Value>(event.payload())
                {
                    let is_pause = ev.get("name").and_then(|v| v.as_str()) == Some("pause");
                    let paused = ev.get("data").and_then(|v| v.as_bool()).unwrap_or(false);

                    if is_pause && paused {
                        if let Some(win) = handle.get_webview_window("main") {
                            let w = win.clone();
                            // DWM attribute writes must happen on the window's
                            // message-loop thread to avoid race conditions.
                            win.run_on_main_thread(move || {
                                #[cfg(target_os = "windows")]
                                window_vibrancy::apply_mica(&w, Some(true)).ok();
                            })
                            .ok();
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![load_video])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
