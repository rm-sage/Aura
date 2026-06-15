// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Casting subsystem — Chromecast (CASTV2 via `rust_cast`) + DLNA
//! (SSDP + SOAP/AVTransport). Ported per the 2026-06-09 casting spec.
//!
//! Scope: device discovery, in-process LAN media proxy, direct-play
//! load/control on Chromecast's Default Media Receiver (`CC1AD845` —
//! built into the Cast protocol, no Google registration) and on DLNA
//! renderers, plus Phase-4 ffmpeg HLS transmux (`transcode.rs` + `hls.rs`)
//! for containers the receiver can't open directly (MKV/AVI/…). DLNA TVs
//! mostly decode those natively, so transmux engages for Chromecast only.
//! `cast_ffmpeg_present` gates it (ffmpeg+ffprobe must both be present).
//!
//! Roku / AirPlay are deferred indefinitely — low value for Aura: it is a
//! Windows desktop app (AirPlay is legacy AP-1 only, which modern Apple
//! devices reject), and Roku needs the user to side-load a channel + flip
//! an ECP toggle. Chromecast + DLNA already cover the vast majority of TVs.
//!
//! ## Threading model (Chromecast)
//!
//! `rust_cast`'s `CastDevice` is a blocking TLS connection. The session
//! is held by a dedicated `aura-cast-session` thread that answers the
//! device's heartbeat PINGs for the session lifetime (a Cast device
//! drops senders that go ~10 s without a PONG). Control commands
//! (play/pause/seek/stop/status) use short-lived fresh connections —
//! CASTV2 explicitly supports multiple senders, and a fresh ~100 ms
//! connect per user action is far simpler and more robust than
//! multiplexing commands into the blocked receive loop.
//!
//! ## MPV landmines: NOT implicated
//!
//! Casting is a parallel media path. Local playback is only touched via
//! the existing engine-gated Tauri commands (the frontend pauses MPV on
//! cast start). No new observed_properties, no property polling — the
//! status poll talks to the cast DEVICE, not libmpv.

pub mod castv2;
pub mod discovery;
pub mod dlna;
pub mod hls;
pub mod media_server;
pub mod transcode;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

/// Default Media Receiver — Google's built-in receiver app. Plays
/// MP4/WebM/HLS/TS with no registration. (The reference implementation's
/// private receiver id is unusable by Aura; see spec decision #2.)
const CAST_RECEIVER_APP_ID: &str = "CC1AD845";

// ---------------------------------------------------------------------------
// Wire types (Rust → React; snake_case field names match the TS types
// verbatim — no serde renames, per the CLAUDE.md serialization rule)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CastDeviceInfo {
    /// Stable identity for the picker (host-based).
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub model: Option<String>,
    /// "chromecast" | "dlna"
    pub kind: String,
    /// DLNA AVTransport control URL (absolute). None for Chromecast.
    pub control_url: Option<String>,
    /// Google Home / Nest Audio etc. — audio only, video casts will
    /// play sound without picture.
    pub audio_only: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct CastStatus {
    /// "playing" | "paused" | "buffering" | "idle" | "unknown"
    pub player_state: String,
    pub position_sec: f64,
    pub duration_sec: Option<f64>,
    pub device_name: String,
    pub kind: String,
    /// True while the active cast is being HLS-transmuxed by ffmpeg
    /// (drives the "Transcoding" badge in the session bar).
    pub transcoding: bool,
}

// ---------------------------------------------------------------------------
// Active session bookkeeping
// ---------------------------------------------------------------------------

struct ChromecastSession {
    host: String,
    port: u16,
    device_name: String,
    /// Transport id of the launched receiver app — control connections
    /// address media commands to it.
    transport_id: String,
    /// Receiver session id — needed to stop the app on cast_stop.
    app_session_id: String,
    media_session_id: Option<i64>,
    /// Resume offset baked into the transmux: ffmpeg input-seeks here and the
    /// device plays from currentTime=0, so real_time = device_time + this.
    /// 0 for direct-play (the device's own time is already absolute).
    tx_offset: f64,
    /// Signals the heartbeat thread to exit.
    stop: Arc<AtomicBool>,
}

struct DlnaSession {
    device_name: String,
    control_url: String,
}

enum ActiveSession {
    Chromecast(ChromecastSession),
    Dlna(DlnaSession),
}

static ACTIVE: OnceLock<Mutex<Option<ActiveSession>>> = OnceLock::new();

fn active_slot() -> &'static Mutex<Option<ActiveSession>> {
    ACTIVE.get_or_init(|| Mutex::new(None))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Discover Chromecast (mDNS) + DLNA (SSDP) devices on the LAN.
/// Fans out both protocols concurrently; ~3 s wall time.
#[tauri::command]
pub async fn cast_discover() -> Result<Vec<CastDeviceInfo>, String> {
    discovery::discover_all().await
}

/// Whether ffmpeg AND ffprobe are locatable — the Phase-4 transmux
/// prerequisites. The UI uses this to explain why an MKV cast may fail
/// on Chromecast (DLNA TVs often play MKV natively).
#[tauri::command]
pub fn cast_ffmpeg_present() -> bool {
    locate_tool("ffmpeg.exe").is_some() && locate_tool("ffprobe.exe").is_some()
}

/// Locate a bundled tool next to the exe (`lib/<name>` is the canonical
/// spot — same arrangement as the git-ignored ffmpeg.exe), with a
/// `CARGO_MANIFEST_DIR` fallback for `tauri dev`. Shared with the
/// transcode/hls submodules.
pub(super) fn locate_tool(name: &str) -> Option<std::path::PathBuf> {
    // On-demand download dir (survives updates) takes precedence — a fetched,
    // checksum-verified copy beats a stale bundled one.
    if let Some(p) = crate::runtime_deps::resolved_path(name) {
        return Some(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [dir.join("lib").join(name), dir.join(name)] {
                if cand.exists() {
                    return Some(cand);
                }
            }
        }
    }
    let dev = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("lib").join(name);
    if dev.exists() {
        return Some(dev);
    }
    None
}

/// Start casting `url` to `device`, beginning at `start_seconds`.
///
/// Routing:
/// * HLS (`.m3u8`) upstreams → handed to the device DIRECTLY (proxying a
///   playlist would break its relative segment URIs).
/// * Direct-playable containers (MP4/WebM) → re-served through the
///   in-process LAN proxy (`media_server`) — cast devices can't always do
///   the TLS/range dance debrid hosts require, and several reject
///   `application/octet-stream`.
/// * Receiver-incompatible containers (MKV/AVI/…) on Chromecast → ffmpeg
///   HLS transmux (`hls::register_transcode`), when ffmpeg+ffprobe exist.
#[tauri::command]
pub async fn cast_load(
    device: CastDeviceInfo,
    url: String,
    title: Option<String>,
    poster: Option<String>,
    start_seconds: Option<f64>,
) -> Result<(), String> {
    crate::devlog!(
        info, "cast",
        "cast_load → {} ({}) url={}",
        device.name, device.kind,
        crate::stremio::redact_sensitive_url(&url),
    );

    // One session at a time — stop whatever is active first, then drop any
    // proxy / transcode sessions it left behind (a finished transcode's
    // ffmpeg would otherwise linger until idle-eviction).
    stop_active_session().await;
    media_server::clear_sessions();
    hls::clear_all_async().await;

    let resume = start_seconds.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0);
    let is_hls = url.split('?').next().unwrap_or("").to_ascii_lowercase().ends_with(".m3u8");
    // Phase-4 transmux: containers the Default Media Receiver can't open
    // directly (MKV/AVI/…) are re-segmented to HLS via ffmpeg — but only
    // for Chromecast. Most DLNA TVs decode them natively, so DLNA always
    // direct-plays (no needless transcode load). ffmpeg/ffprobe absent ⇒
    // fall back to direct-play (the device may still cope, or report an
    // error the user can act on).
    let transmux = !is_hls
        && device.kind == "chromecast"
        && transcode::should_transmux(&url)
        && cast_ffmpeg_present();
    let (media_url, content_type): (String, &'static str) = if is_hls {
        (url.clone(), guess_content_type(&url, true))
    } else if transmux {
        (hls::register_transcode(&url, &device.host, resume).await?, "application/x-mpegurl")
    } else {
        (media_server::register_cast(&url, &device.host).await?, guess_content_type(&url, false))
    };
    // A transmux input-seeks ffmpeg to `resume`, so its HLS timeline starts at
    // 0; the device is told currentTime=0 and we add the offset back for
    // status / seek / stop (so the receiver never seeks to an unproduced
    // position). Direct-play / HLS seek the real file, so the device gets the
    // real resume position and there's no offset.
    let (device_start, tx_offset) = if transmux { (0.0, resume) } else { (resume, 0.0) };

    let result: Result<(), String> = match device.kind.as_str() {
        "chromecast" => {
            let dev = device.clone();
            let media_url2 = media_url.clone();
            let ct = content_type.to_string();
            match tauri::async_runtime::spawn_blocking(move || {
                chromecast_load_blocking(&dev, &media_url2, &ct, title.as_deref(), poster.as_deref(), device_start)
            })
            .await
            .map_err(|e| e.to_string())?
            {
                Ok(mut session) => {
                    session.tx_offset = tx_offset;
                    *active_slot().lock().unwrap() = Some(ActiveSession::Chromecast(session));
                    Ok(())
                }
                Err(e) => Err(humanize_cast_error(e)),
            }
        }
        "dlna" => {
            let load_res: Result<(), String> = async {
                let control_url = device
                    .control_url
                    .clone()
                    .ok_or("DLNA device has no AVTransport control URL")?;
                dlna::load(&control_url, &media_url, content_type, title.as_deref()).await?;
                if device_start > 1.0 {
                    // Some renderers need a beat between Play and Seek.
                    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                    let _ = dlna::seek(&control_url, device_start).await;
                }
                *active_slot().lock().unwrap() = Some(ActiveSession::Dlna(DlnaSession {
                    device_name: device.name.clone(),
                    control_url,
                }));
                Ok(())
            }
            .await;
            load_res
        }
        other => Err(format!("unsupported cast device kind '{other}'")),
    };

    // A failed load leaves no active session — drop the proxy session we
    // just registered so repeated failures can't pile entries up (no
    // other session can be live here; we stopped any active one above).
    if result.is_err() {
        media_server::clear_sessions();
        hls::clear_all_async().await;
    }
    result
}

#[tauri::command]
pub async fn cast_play() -> Result<(), String> {
    match snapshot_session() {
        Some(SessionSnapshot::Chromecast { host, port, transport_id, media_session_id, .. }) => {
            tauri::async_runtime::spawn_blocking(move || {
                chromecast_simple_command(&host, port, &transport_id, media_session_id, CcCommand::Play)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(humanize_cast_error)
        }
        Some(SessionSnapshot::Dlna { control_url, .. }) => dlna::play(&control_url).await,
        None => Err("no active cast session".into()),
    }
}

#[tauri::command]
pub async fn cast_pause() -> Result<(), String> {
    match snapshot_session() {
        Some(SessionSnapshot::Chromecast { host, port, transport_id, media_session_id, .. }) => {
            tauri::async_runtime::spawn_blocking(move || {
                chromecast_simple_command(&host, port, &transport_id, media_session_id, CcCommand::Pause)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(humanize_cast_error)
        }
        Some(SessionSnapshot::Dlna { control_url, .. }) => dlna::pause(&control_url).await,
        None => Err("no active cast session".into()),
    }
}

#[tauri::command]
pub async fn cast_seek(position_sec: f64) -> Result<(), String> {
    match snapshot_session() {
        Some(SessionSnapshot::Chromecast { host, port, transport_id, media_session_id, tx_offset }) => {
            // The UI seeks in real-media time; the transmux device timeline is
            // offset-relative, so subtract the transcode offset (0 for direct).
            let device_target = (position_sec - tx_offset).max(0.0);
            tauri::async_runtime::spawn_blocking(move || {
                chromecast_simple_command(
                    &host, port, &transport_id, media_session_id,
                    CcCommand::Seek(device_target),
                )
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(humanize_cast_error)
        }
        Some(SessionSnapshot::Dlna { control_url, .. }) => {
            dlna::seek(&control_url, position_sec).await
        }
        None => Err("no active cast session".into()),
    }
}

/// Stop casting and tear the session down. Returns the device's last
/// known position so the caller can resume local playback there.
#[tauri::command]
pub async fn cast_stop() -> Result<f64, String> {
    let last_pos = match current_status_inner().await {
        Ok(s) => s.position_sec,
        Err(_) => 0.0,
    };
    stop_active_session().await;
    media_server::clear_sessions();
    hls::clear_all_async().await;
    Ok(last_pos)
}

/// Poll the cast DEVICE for playback state (1–2 s cadence from the UI).
#[tauri::command]
pub async fn cast_status() -> Result<CastStatus, String> {
    current_status_inner().await
}

async fn current_status_inner() -> Result<CastStatus, String> {
    match snapshot_session() {
        Some(SessionSnapshot::Chromecast { host, port, transport_id, media_session_id, tx_offset }) => {
            let name = active_device_name().unwrap_or_default();
            let st = tauri::async_runtime::spawn_blocking(move || {
                chromecast_status(&host, port, &transport_id, media_session_id)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(humanize_cast_error)?;
            // Add the transmux offset back so the UI sees real-media time
            // (the device reports time relative to the input-seeked transcode).
            Ok(CastStatus {
                player_state: st.0,
                position_sec: st.1 + tx_offset,
                duration_sec: st.2.map(|d| d + tx_offset),
                device_name: name,
                kind: "chromecast".into(),
                transcoding: hls::is_active(),
            })
        }
        Some(SessionSnapshot::Dlna { control_url, device_name }) => {
            let (state, pos, dur) = dlna::status(&control_url).await?;
            Ok(CastStatus {
                player_state: state,
                position_sec: pos,
                duration_sec: dur,
                device_name,
                kind: "dlna".into(),
                transcoding: hls::is_active(),
            })
        }
        None => Err("no active cast session".into()),
    }
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/// Cloneable view of the active session for command dispatch (the
/// session itself stays behind the mutex).
enum SessionSnapshot {
    Chromecast {
        host: String,
        port: u16,
        transport_id: String,
        media_session_id: Option<i64>,
        tx_offset: f64,
    },
    Dlna {
        control_url: String,
        device_name: String,
    },
}

fn snapshot_session() -> Option<SessionSnapshot> {
    let slot = active_slot().lock().ok()?;
    match slot.as_ref()? {
        ActiveSession::Chromecast(s) => Some(SessionSnapshot::Chromecast {
            host: s.host.clone(),
            port: s.port,
            transport_id: s.transport_id.clone(),
            media_session_id: s.media_session_id,
            tx_offset: s.tx_offset,
        }),
        ActiveSession::Dlna(s) => Some(SessionSnapshot::Dlna {
            control_url: s.control_url.clone(),
            device_name: s.device_name.clone(),
        }),
    }
}

/// True while any cast session is active — the HLS evictor uses this so it
/// never reaps the transcode of a live (even paused/buffering) cast.
pub(super) fn has_active_session() -> bool {
    active_slot().lock().map(|s| s.is_some()).unwrap_or(false)
}

fn active_device_name() -> Option<String> {
    let slot = active_slot().lock().ok()?;
    match slot.as_ref()? {
        ActiveSession::Chromecast(s) => Some(s.device_name.clone()),
        ActiveSession::Dlna(s) => Some(s.device_name.clone()),
    }
}

/// Tear down whatever session is active: signal the Chromecast heartbeat
/// thread, stop the receiver app / DLNA transport (best-effort, bounded).
async fn stop_active_session() {
    let taken = active_slot().lock().ok().and_then(|mut s| s.take());
    match taken {
        Some(ActiveSession::Chromecast(s)) => {
            s.stop.store(true, Ordering::Release);
            let host = s.host.clone();
            let port = s.port;
            let app_session = s.app_session_id.clone();
            let transport = s.transport_id.clone();
            let media_session = s.media_session_id;
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = chromecast_simple_command(
                    &host, port, &transport, media_session, CcCommand::Stop,
                );
                let _ = chromecast_stop_app(&host, port, &app_session);
            })
            .await;
            crate::devlog!(info, "cast", "chromecast session stopped");
        }
        Some(ActiveSession::Dlna(s)) => {
            let _ = dlna::stop(&s.control_url).await;
            crate::devlog!(info, "cast", "dlna session stopped");
        }
        None => {}
    }
}

/// Synchronous shutdown hook for the CloseRequested path — bounded,
/// best-effort. Stops the heartbeat thread and the receiver app so the
/// TV doesn't sit on a dead "Default Media Receiver" splash.
pub fn shutdown_blocking() {
    // Kill any transcode ffmpeg + temp dirs first (orphan-proofing).
    hls::shutdown();
    let taken = active_slot().lock().ok().and_then(|mut s| s.take());
    match taken {
        Some(ActiveSession::Chromecast(s)) => {
            s.stop.store(true, Ordering::Release);
            let _ = chromecast_stop_app(&s.host, s.port, &s.app_session_id);
        }
        Some(ActiveSession::Dlna(_)) => {
            // SOAP stop needs the async reqwest client; skip on hard
            // shutdown — the renderer just keeps the URI until idle.
        }
        None => {}
    }
}

// ---------------------------------------------------------------------------
// Chromecast (blocking, hand-rolled CASTV2 — see castv2.rs)
// ---------------------------------------------------------------------------

enum CcCommand {
    Play,
    Pause,
    Stop,
    Seek(f64),
}

impl CcCommand {
    fn verb(&self) -> &'static str {
        match self {
            CcCommand::Play => "PLAY",
            CcCommand::Pause => "PAUSE",
            CcCommand::Stop => "STOP",
            CcCommand::Seek(_) => "SEEK",
        }
    }
}

/// Connect + launch the Default Media Receiver + LOAD (with the resume
/// offset as the LOAD's native `currentTime`), then leave a dedicated
/// heartbeat thread answering the device's PINGs for the session
/// lifetime — a Cast device drops senders that go quiet.
fn chromecast_load_blocking(
    device: &CastDeviceInfo,
    media_url: &str,
    content_type: &str,
    title: Option<&str>,
    poster: Option<&str>,
    start_seconds: f64,
) -> Result<ChromecastSession, String> {
    let mut conn = castv2::CastConnection::connect(&device.host, device.port)?;
    let (transport_id, app_session_id) = conn.launch(CAST_RECEIVER_APP_ID)?;
    conn.connect_transport(&transport_id)?;
    let mut media_session_id = conn.media_load(
        &transport_id,
        media_url,
        content_type,
        title,
        poster,
        start_seconds,
    )?;
    // An unsolicited MEDIA_STATUS broadcast can satisfy the LOAD wait
    // without carrying a mediaSessionId — resolve it with a follow-up
    // GET_STATUS so the session record is complete. (Control commands
    // also self-heal via get_status when this stays None.)
    if media_session_id.is_none() {
        if let Ok((_, _, _, ms)) = conn.media_status(&transport_id) {
            media_session_id = ms;
        }
    }

    crate::devlog!(
        info, "cast",
        "chromecast load OK on '{}' (transport {transport_id}, media session {media_session_id:?})",
        device.name,
    );

    // Heartbeat keeper — owns this connection for the session lifetime.
    // Read timeouts double as the PING cadence (send our own ping on an
    // idle tick); inbound PINGs are answered with PONG.
    let stop = Arc::new(AtomicBool::new(false));
    let stop_t = stop.clone();
    let dev_name = device.name.clone();
    let mut keeper = conn;
    let spawn_res = std::thread::Builder::new()
        .name("aura-cast-session".into())
        .spawn(move || {
            loop {
                if stop_t.load(Ordering::Acquire) {
                    break;
                }
                match keeper.read_frame() {
                    Ok(frame) => {
                        if frame.payload["type"] == "PING" {
                            let _ = keeper.pong();
                        }
                        // CLOSE on the connection namespace = the device
                        // tore the virtual connection down (app stopped).
                        if frame.payload["type"] == "CLOSE" {
                            crate::devlog!(
                                info, "cast",
                                "cast session closed by device ({dev_name})",
                            );
                            break;
                        }
                    }
                    Err(e) => {
                        // A read timeout is a routine idle tick — use it
                        // to send our own keepalive PING. Anything else
                        // (reset / close) ends the session.
                        let lower = e.to_ascii_lowercase();
                        let idle = lower.contains("timed out")
                            || lower.contains("timeout")
                            || lower.contains("would block");
                        if idle {
                            if keeper.ping().is_err() {
                                break;
                            }
                        } else {
                            crate::devlog!(
                                info, "cast",
                                "cast session connection ended ({dev_name}): {e}",
                            );
                            break;
                        }
                    }
                }
            }
        });
    if let Err(e) = spawn_res {
        crate::devlog!(warn, "cast", "heartbeat thread spawn failed: {e}");
    }

    Ok(ChromecastSession {
        host: device.host.clone(),
        port: device.port,
        device_name: device.name.clone(),
        transport_id,
        app_session_id,
        media_session_id,
        tx_offset: 0.0, // set by cast_load for a transmux session
        stop,
    })
}

/// Fresh-connection control command. CASTV2 supports multiple senders,
/// so a short-lived connection can address the running app's media
/// session without disturbing the heartbeat keeper.
fn chromecast_simple_command(
    host: &str,
    port: u16,
    transport_id: &str,
    media_session_id: Option<i64>,
    cmd: CcCommand,
) -> Result<(), String> {
    let mut conn = castv2::CastConnection::connect(host, port)?;
    conn.connect_transport(transport_id)?;
    let ms = match media_session_id {
        Some(ms) => ms,
        None => conn
            .media_status(transport_id)?
            .3
            .ok_or("no media session on the device")?,
    };
    let seek_to = match cmd {
        CcCommand::Seek(pos) => Some(pos),
        _ => None,
    };
    conn.media_command(transport_id, ms, cmd.verb(), seek_to)
}

fn chromecast_stop_app(host: &str, port: u16, app_session_id: &str) -> Result<(), String> {
    let mut conn = castv2::CastConnection::connect(host, port)?;
    conn.stop_app(app_session_id)
}

/// `(player_state, position_sec, duration_sec)` via a fresh connection.
fn chromecast_status(
    host: &str,
    port: u16,
    transport_id: &str,
    _media_session_id: Option<i64>,
) -> Result<(String, f64, Option<f64>), String> {
    let mut conn = castv2::CastConnection::connect(host, port)?;
    conn.connect_transport(transport_id)?;
    let (state, pos, dur, _ms) = conn.media_status(transport_id)?;
    Ok((state, pos, dur))
}

/// Map connection-layer failures to something a user can act on.
fn humanize_cast_error(e: String) -> String {
    let lower = e.to_ascii_lowercase();
    if lower.contains("timed out") || lower.contains("timeout") {
        return "The cast device didn't respond (network timeout). Make sure it's powered on and on the same network.".into();
    }
    if lower.contains("refused") {
        return "The cast device refused the connection. Try restarting it.".into();
    }
    format!("Cast failed: {e}")
}

/// Content-Type for the cast LOAD. Receivers reject
/// `application/octet-stream`, so unknown extensions are forced to
/// `video/mp4` (the most permissive guess for direct-play).
fn guess_content_type(url: &str, is_hls: bool) -> &'static str {
    if is_hls {
        return "application/x-mpegurl";
    }
    let path = url.split('?').next().unwrap_or("").to_ascii_lowercase();
    if path.ends_with(".webm") {
        "video/webm"
    } else if path.ends_with(".mkv") {
        "video/x-matroska"
    } else if path.ends_with(".ts") {
        "video/mp2t"
    } else if path.ends_with(".mp3") {
        "audio/mpeg"
    } else {
        "video/mp4"
    }
}
