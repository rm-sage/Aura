// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::{mpsc, OnceLock};
use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

// ---------------------------------------------------------------------------
// SMTC bridge — System Media Transport Controls (Windows) via `souvlaki`.
//
// Souvlaki's MediaControls is !Send on Windows because it owns COM objects
// tied to a specific thread's apartment + the parent window's HWND. We
// therefore spawn ONE dedicated thread which:
//
//   1. Constructs MediaControls with our window's HWND
//   2. Attaches an event callback that re-emits Play/Pause/Next/Prev as
//      Tauri events for the frontend to handle
//   3. Drains an mpsc channel of `Cmd` messages (set_metadata, set_playback,
//      clear) and dispatches them to the local controls instance
//
// Tauri commands `smtc_set_metadata`, `smtc_set_playback`, `smtc_clear`
// simply enqueue messages — they never block the IPC thread on COM.
// ---------------------------------------------------------------------------

static TX: OnceLock<mpsc::Sender<Cmd>> = OnceLock::new();

enum Cmd {
    SetMetadata {
        title: String,
        artist: Option<String>,
        cover_url: Option<String>,
        duration: Option<f64>,
    },
    SetPlayback {
        playing: bool,
        paused: bool,
        position: Option<f64>,
    },
    Clear,
}

// ---------------------------------------------------------------------------
// Setup — call from Tauri `setup`
// ---------------------------------------------------------------------------

pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let (tx, rx) = mpsc::channel::<Cmd>();
    if TX.set(tx).is_err() {
        // already installed
        return;
    }

    let app_clone = app.clone();

    // Resolve HWND on Windows. The pointer captured in the spawn is wrapped
    // in a Send-marker struct because *mut c_void isn't Send by default; we
    // know the pointer is stable for the window's lifetime.
    #[cfg(target_os = "windows")]
    let hwnd_send = match app.get_webview_window("main").and_then(|w| w.hwnd().ok()) {
        Some(hwnd) => Some(SendHwnd(hwnd.0 as *mut std::ffi::c_void)),
        None => None,
    };

    std::thread::spawn(move || {
        let config = PlatformConfig {
            display_name: "Aura",
            dbus_name: "aura",
            #[cfg(target_os = "windows")]
            hwnd: hwnd_send.map(|h| h.0),
            #[cfg(not(target_os = "windows"))]
            hwnd: None,
        };

        let mut controls = match MediaControls::new(config) {
            Ok(c) => c,
            Err(_) => return, // SMTC unavailable on this host — silently skip
        };

        // Forward OS media-key events to the frontend, which already owns
        // the canonical playback control surface.
        let app_for_handler = app_clone.clone();
        let _ = controls.attach(move |event: MediaControlEvent| {
            let payload = match event {
                MediaControlEvent::Play     => "play",
                MediaControlEvent::Pause    => "pause",
                MediaControlEvent::Toggle   => "toggle",
                MediaControlEvent::Stop     => "stop",
                MediaControlEvent::Next     => "next",
                MediaControlEvent::Previous => "previous",
                _ => return,
            };
            let _ = app_for_handler.emit("smtc-event", payload);
        });

        // Drain the command channel for the lifetime of the process.
        while let Ok(msg) = rx.recv() {
            match msg {
                Cmd::SetMetadata { title, artist, cover_url, duration } => {
                    let dur = duration
                        .filter(|d| d.is_finite() && *d > 0.0)
                        .map(|d| Duration::from_secs_f64(d));
                    let _ = controls.set_metadata(MediaMetadata {
                        title:     Some(&title),
                        artist:    artist.as_deref(),
                        album:     None,
                        cover_url: cover_url.as_deref(),
                        duration:  dur,
                    });
                }
                Cmd::SetPlayback { playing, paused, position } => {
                    let progress = position
                        .filter(|p| p.is_finite() && *p >= 0.0)
                        .map(|p| souvlaki::MediaPosition(Duration::from_secs_f64(p)));
                    let state = if !playing {
                        MediaPlayback::Stopped
                    } else if paused {
                        MediaPlayback::Paused { progress }
                    } else {
                        MediaPlayback::Playing { progress }
                    };
                    let _ = controls.set_playback(state);
                }
                Cmd::Clear => {
                    let _ = controls.set_playback(MediaPlayback::Stopped);
                    let _ = controls.set_metadata(MediaMetadata::default());
                }
            }
        }
    });
}

#[cfg(target_os = "windows")]
struct SendHwnd(*mut std::ffi::c_void);
#[cfg(target_os = "windows")]
unsafe impl Send for SendHwnd {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

fn send_cmd(cmd: Cmd) -> Result<(), String> {
    match TX.get() {
        Some(tx) => tx.send(cmd).map_err(|e| e.to_string()),
        None => Ok(()), // SMTC not installed — silently no-op
    }
}

#[tauri::command]
pub async fn smtc_set_metadata(
    title: String,
    artist: Option<String>,
    cover_url: Option<String>,
    duration: Option<f64>,
) -> Result<(), String> {
    send_cmd(Cmd::SetMetadata { title, artist, cover_url, duration })
}

#[tauri::command]
pub async fn smtc_set_playback(
    playing: bool,
    paused: bool,
    position: Option<f64>,
) -> Result<(), String> {
    send_cmd(Cmd::SetPlayback { playing, paused, position })
}

#[tauri::command]
pub async fn smtc_clear() -> Result<(), String> {
    send_cmd(Cmd::Clear)
}
