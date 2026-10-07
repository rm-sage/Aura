// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::sync::atomic::{AtomicBool, AtomicI8, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, ActivityType, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};

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

// ---------------------------------------------------------------------------
// Watch-party keep-alive
//
// Minimize / minimize-to-tray normally pauses MPV (see the window-event handler
// below). An in-sync watch-party MEMBER — leader OR follower — is EXEMPT and
// keeps playing while hidden, so the party stays in sync:
//   * a FOLLOWER paused on minimize desyncs, and on this build is NOT un-paused
//     by the leader's drift ticks (those bail when the follower is locally
//     paused) — only an explicit control frame would, which may be many seconds
//     away — so it sits frozen and behind until the leader next acts.
//   * a LEADER paused on minimize would pause LOCALLY without telling the party,
//     so it falls behind the still-playing room and snaps everyone back on
//     restore (the leader also stops emitting drift ticks while paused). Keeping
//     the leader playing keeps the party driven. (User-chosen policy.)
//
// The frontend sets this true while we are CONNECTED and IN-SYNC on the party
// title (either role) and false otherwise (left party / off the party title).
// Mirrors the casting exemption (cast::has_active_session) but for parties.
static PARTY_KEEP_ALIVE: AtomicBool = AtomicBool::new(false);

/// Frontend -> Rust: are we a connected, in-sync watch-party member (leader or
/// follower) right now? Drives the pause-on-minimize / tray exemption below.
///
/// `in_room` is the wider "connected to (or joining) any room at all" state,
/// in sync or not. It is optional only so an older caller that omits it reads
/// as "unchanged"; it gates the tray webview parking below, never the pause.
#[tauri::command]
pub fn set_party_keep_alive(app: AppHandle, active: bool, in_room: Option<bool>) {
    store_party_flags(active, in_room);
    // Leaving a room while the window sits in the tray clears a park blocker.
    repark_if_tray_hidden(&app);
}

/// The flag half of `set_party_keep_alive`, separate so the tests can drive it
/// without an AppHandle.
fn store_party_flags(active: bool, in_room: Option<bool>) {
    PARTY_KEEP_ALIVE.store(active, Ordering::Release);
    if let Some(in_room) = in_room {
        PARTY_IN_ROOM.store(in_room, Ordering::Release);
    }
}

/// Whether the minimize / tray pause should be SKIPPED to keep an in-sync party
/// member in lock-step with the party. Read by the window-event handlers AND by
/// the engine pump (so a kept-alive member that keeps PLAYING while hidden also
/// keeps the fast tick + cache poll instead of powering down).
pub fn party_keep_alive() -> bool {
    PARTY_KEEP_ALIVE.load(Ordering::Acquire)
}

// ---------------------------------------------------------------------------
// Tray webview parking
//
// Hiding the window to the tray hides only the NATIVE window. Nothing told
// WebView2, so Chromium still believed the page was visible and kept producing
// frames for every running animation at the display's refresh rate: measured
// in the tray on a detail page, the WebView2 GPU process used 174% of one core
// and the renderer 76% (aura.exe itself 0.1%), and on Home the renderer still
// used 45%. WebView2 does not infer visibility from its host window; the host
// has to say so through ICoreWebView2Controller::put_IsVisible.
//
// So the close-to-tray path PARKS the webview (IsVisible = false) and every
// path that brings the window back UNPARKS it before the window is shown.
// Only the controller's visibility is changed, deliberately not wry's
// `set_visible` (Webview::hide), which also SW_HIDEs the WRY_WEBVIEW container
// window: the restore animation depends on the window tree being intact
// (see the restore section of CLAUDE.md), and the container's own visibility
// buys nothing, since the parent is already hidden while in the tray.
//
// A hidden page has its timers clamped by Chromium (at most once a second,
// and once a minute for chained timers after about five minutes hidden). So
// the webview is parked ONLY when nothing in the page needs live timers:
// no file loaded (playing OR paused: the progress checkpoint, the scrobble
// heartbeat and the stats timer run from the page), not in a watch-together
// room (its WebSocket keepalive and the leader's drift tick are page timers),
// not casting, and no bulk History scrobble run in flight. Background audio
// is never affected because mpv is native, and Tauri events still reach a
// hidden page.
// ---------------------------------------------------------------------------

/// Connected to (or joining) a watch-together room, in sync or not. Set with
/// `set_party_keep_alive`'s `in_room`.
static PARTY_IN_ROOM: AtomicBool = AtomicBool::new(false);

/// A file is loaded in mpv: set by `load_video` and the debug panel's
/// `debug_load_test_pattern`, cleared by `stop_video`, the debug panel's
/// `debug_stop_playback` and the page-reload teardown. Errs toward true (a
/// failed load leaves it set until the player is exited), which only ever
/// means "do not park".
static MEDIA_LOADED: AtomicBool = AtomicBool::new(false);

/// Whether the main webview is currently parked (IsVisible = false). Makes the
/// unpark a no-op on every restore that did not follow a park. Read and
/// written on the main thread only (the close handler, the tray, the
/// single-instance handler, the OAuth landing and the re-park all run there).
static WEBVIEW_PARKED: AtomicBool = AtomicBool::new(false);

/// The main window is hidden to the tray: set by the close-to-tray path, cleared
/// by `unpark_main_webview`, which every path that shows the window calls
/// first. Lets a park blocker that clears while in the tray (playback stopped,
/// room left, bulk scrobble done) park the webview after all.
static TRAY_HIDDEN: AtomicBool = AtomicBool::new(false);

/// Record whether mpv has a file loaded. See `MEDIA_LOADED`.
pub fn set_media_loaded(loaded: bool) {
    MEDIA_LOADED.store(loaded, Ordering::Release);
}

/// Whether a re-park is due: hidden to the tray, not parked yet, and nothing
/// blocks a park. Pure over the flags, so the gating can be tested.
fn repark_due() -> bool {
    TRAY_HIDDEN.load(Ordering::Acquire)
        && !WEBVIEW_PARKED.load(Ordering::Acquire)
        && park_blocker().is_none()
}

/// Park the webview now if the window sits in the tray and the blocker that
/// kept it visible at hide time has since cleared. Call after clearing any
/// park blocker. Cheap and a no-op in every other state. The decision is
/// re-made on the main thread, so a restore racing it always wins: the restore
/// clears TRAY_HIDDEN first, and the window must still be hidden.
pub fn repark_if_tray_hidden<R: Runtime>(app: &AppHandle<R>) {
    if !repark_due() {
        return;
    }
    let h = app.clone();
    let queued = app.run_on_main_thread(move || {
        if !repark_due() {
            return;
        }
        // Belt and braces: never park a page that is on screen, whatever path
        // showed the window.
        if let Some(win) = h.get_webview_window("main") {
            if !matches!(win.is_visible(), Ok(false)) {
                return;
            }
        }
        park_main_webview(&h);
    });
    if let Err(e) = queued {
        crate::devlog!(warn, "win", "tray: re-park could not be queued: {e}");
    }
}

/// Why the webview must stay visible in the tray, or None when it may park.
fn park_blocker() -> Option<&'static str> {
    if MEDIA_LOADED.load(Ordering::Acquire) {
        return Some("a file is loaded");
    }
    if party_keep_alive() || PARTY_IN_ROOM.load(Ordering::Acquire) {
        return Some("in a watch-together room");
    }
    if crate::cast::has_active_session() {
        return Some("casting");
    }
    if crate::scrobble::scrobble_run_active() {
        return Some("a History scrobble run is in progress");
    }
    None
}

/// Set the main webview's WebView2 visibility (the controller's IsVisible
/// only; see the section comment). `with_webview` runs inline when called on
/// the main thread and is queued IN ORDER with the window's own messages
/// otherwise, so a following show() never overtakes it.
fn set_main_webview_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) -> bool {
    let Some(webview) = app.get_webview("main") else { return false };
    #[cfg(target_os = "windows")]
    {
        let queued = webview.with_webview(move |pw| {
            let controller = pw.controller();
            // SAFETY: a plain COM property write on the controller wry owns,
            // made on the thread wry runs webview messages on.
            if let Err(e) = unsafe { controller.SetIsVisible(visible) } {
                crate::devlog!(warn, "win", "webview IsVisible={visible} failed: {e}");
            }
        });
        queued.is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (webview, visible);
        false
    }
}

/// Close-to-tray: tell WebView2 the page is hidden, unless something in the
/// page needs live timers. Call after the window itself is hidden.
fn park_main_webview<R: Runtime>(app: &AppHandle<R>) {
    if let Some(why) = park_blocker() {
        crate::devlog!(info, "win", "tray: webview left visible ({why})");
        return;
    }
    if set_main_webview_visible(app, false) {
        WEBVIEW_PARKED.store(true, Ordering::Release);
        crate::devlog!(info, "win", "tray: webview parked (IsVisible=false)");
    }
}

/// Bring a parked webview back. EVERY path that shows the main window must
/// call this BEFORE `show()` / `unminimize()`, so the page is already visible
/// (and producing its first frame) when the restore animation starts. A
/// no-op when the webview was not parked. Main thread only, like every other
/// reader and writer of the parking flags, so a park can never interleave.
pub fn unpark_main_webview<R: Runtime>(app: &AppHandle<R>) {
    // The window is about to be shown: no re-park may follow from here on.
    TRAY_HIDDEN.store(false, Ordering::Release);
    if !WEBVIEW_PARKED.swap(false, Ordering::AcqRel) {
        return;
    }
    if !set_main_webview_visible(app, true) {
        crate::devlog!(warn, "win", "tray: webview unpark could not be queued");
        return;
    }
    crate::devlog!(info, "win", "tray: webview unparked (IsVisible=true)");
}

fn pause_mpv<R: Runtime>(app: &AppHandle<R>) {
    let _ = app;
    #[cfg(target_os = "windows")]
    {
        // Queue a typed pause-true write on the engine's command channel.
        // (CLAUDE.md landmine #1 — pause must be a dedicated property
        // write, never `command("set_property", …)`; the engine's
        // PropValue path is exactly that.)
        let _ = crate::mpv::engine::submit_set_property(
            "pause".into(),
            crate::mpv::engine::PropValue::Flag(true),
        );
    }
}

/// Last observed maximized show-state (-1 unknown, 0 restored, 1 maximized).
/// Used to persist the window-state plugin's save ONLY on an actual
/// maximize/restore transition (not every drag-resize tick).
static LAST_MAXIMIZED: AtomicI8 = AtomicI8::new(-1);

/// Whether the last observed resize found the window minimized. Makes the
/// restore wake below EDGE-triggered: an ordinary drag-resize must not turn
/// into a wake storm, which would negate the coarse-tick power discipline the
/// engine's HIDDEN_TICK / IDLE_TICK tiers exist for.
static LAST_MINIMIZED: AtomicBool = AtomicBool::new(false);

/// TEMPORARY restore-latency instrument (dev builds only). Times one
/// pass through the window-event callback and logs it if it was slow
/// enough to matter. A `Drop` guard rather than a wrapper because the
/// arms below `return` early. Threshold is deliberately low: this
/// callback should never be a measurable fraction of a restore.
#[cfg(all(target_os = "windows", debug_assertions))]
struct EvTimer(&'static str, std::time::Instant);

#[cfg(all(target_os = "windows", debug_assertions))]
impl EvTimer {
    fn new(event: &WindowEvent) -> Self {
        let name = match event {
            WindowEvent::Resized(_) => "Resized",
            WindowEvent::Moved(_) => "Moved",
            WindowEvent::Focused(true) => "Focused(true)",
            WindowEvent::Focused(false) => "Focused(false)",
            WindowEvent::CloseRequested { .. } => "CloseRequested",
            WindowEvent::ScaleFactorChanged { .. } => "ScaleFactorChanged",
            WindowEvent::ThemeChanged(_) => "ThemeChanged",
            _ => "other",
        };
        Self(name, std::time::Instant::now())
    }
}

#[cfg(all(target_os = "windows", debug_assertions))]
impl Drop for EvTimer {
    fn drop(&mut self) {
        let ms = self.1.elapsed().as_secs_f64() * 1000.0;
        if ms >= 2.0 && crate::win_probe::enabled() {
            crate::devlog!(warn, "wintiming", "on_window_event {} took {ms:.1} ms", self.0);
        }
    }
}

// ---------------------------------------------------------------------------
// Force quit
//
// With `minimize_to_tray_on_close` on, the X button (and Alt+F4, and every
// other close route) only HIDES the window, and the tray icon is shown only
// WHILE hidden - so from a visible window there was no way to actually end the
// process. This flag is the override: set it, then issue an ordinary close, and
// the CloseRequested handler below takes the full-exit branch instead of the
// tray branch.
//
// Deliberately routed back through CloseRequested rather than calling
// `app.exit(0)` directly. That path owns the whole shutdown discipline -
// synchronous MPV teardown so WASAPI is released (landmine #9), the scrobble
// flush that stops Trakt sitting on "Currently watching", cast teardown, and
// the window-state save. `app.exit(0)` skips every one of them.
static FORCE_QUIT: AtomicBool = AtomicBool::new(false);

/// Fully exit Aura, overriding `minimize_to_tray_on_close` for this one close.
/// Backs the press-and-hold on the title-bar close button and the tray's Quit.
#[tauri::command]
pub fn request_quit<R: Runtime>(app: AppHandle<R>) {
    // Logged because otherwise the three exits (X, the close-button hold, the
    // tray's Quit) are indistinguishable in a session log: they all converge on
    // CloseRequested and the only trace is the engine teardown, which every
    // exit produces. This line is what says the force-quit override was used.
    crate::devlog!(info, "window", "force quit requested - overriding minimize-to-tray");
    FORCE_QUIT.store(true, Ordering::SeqCst);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.close();
    }
}

/// Abandon a pending force quit. Called when the user backs out of the
/// scrobble-in-progress prompt: without it the flag would stay armed and the
/// NEXT ordinary X click would quit instead of minimising to tray.
#[tauri::command]
pub fn cancel_quit() {
    FORCE_QUIT.store(false, Ordering::SeqCst);
}

/// Size the main webview to the window's client area, at (0, 0).
///
/// Aura does this itself instead of leaving it to Tauri's auto-resize. The
/// `unstable` feature (needed for `add_child`, the OAuth popup) builds every
/// window's webview as a CHILD webview, so wry never attaches its own parent
/// resize handler and Tauri's auto-resize is the only thing sizing the page.
/// That auto-resize runs on EVERY Resized event, the minimize one included,
/// and a minimized borderless window reports its iconic 160x28 rect as its
/// client area: the whole page was re-laid out at 160x28 while minimized, and
/// the restore animation flew that tiny stale surface (the title bar alone)
/// across the screen before the real window appeared. Measured with the
/// win_probe: WRY_WEBVIEW 3440x1392 -> 160x28 inside the SIZE_MINIMIZED
/// WM_SIZE. Setup turns auto-resize off and calls this once; the Resized arm
/// calls it for every resize EXCEPT a minimize, so the page keeps its real
/// size while minimized and the OS animates the actual content.
pub fn fit_main_webview<R: Runtime>(app: &AppHandle<R>, size: tauri::PhysicalSize<u32>) {
    if size.width == 0 || size.height == 0 {
        return;
    }
    let Some(webview) = app.get_webview("main") else { return };
    let bounds = tauri::Rect {
        position: tauri::PhysicalPosition::new(0, 0).into(),
        size: size.into(),
    };
    if let Err(e) = webview.set_bounds(bounds) {
        crate::devlog!(warn, "win", "main webview resize failed: {e}");
    }
}

/// Install the window-event handler. Call from Tauri `setup`.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let handle = app.clone();
    let win = window.clone();

    window.clone().on_window_event(move |event| {
        // TEMPORARY restore-latency instrument (dev builds only). This
        // callback runs INSIDE the main wndproc, so every millisecond it
        // spends is a millisecond a cross-process ShowWindow(SW_RESTORE)
        // blocks on. `win_probe` times the whole wndproc; this splits out
        // how much of that is ours. See win_probe.rs.
        #[cfg(all(target_os = "windows", debug_assertions))]
        let _ev_timer = EvTimer::new(event);
        let cfg = settings::snapshot();
        match event {
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
                // No geometry backstop needed — the engine tracks the
                // parent's client rect every pump tick and resizes its
                // host window (plus mpv's inner child) itself.
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
            WindowEvent::Resized(size) => {
                #[cfg(all(target_os = "windows", debug_assertions))]
                let t_arm = std::time::Instant::now();
                // Minimised path — pause MPV (if configured) and BAIL
                // before the child-resize backstop below. A Resized
                // event during a minimise/restore cycle reports a
                // zero-sized payload; calling
                // `resize_mpv_child_to_parent` with that rect would
                // SetWindowPos the MPV child to 0×0, which on this
                // libmpv build tears down the render surface so that
                // the subsequent restore lands on a dead vo. Visible
                // symptom: "I minimised mid-playback and the stream
                // came back broken on restore." The Focused(true)
                // handler above already re-syncs the child rect when
                // the window comes back, so skipping the resize here
                // is safe.
                #[cfg(all(target_os = "windows", debug_assertions))]
                let t_step = std::time::Instant::now();
                let minimised = matches!(win.is_minimized(), Ok(true));
                #[cfg(all(target_os = "windows", debug_assertions))]
                let ms_is_min = t_step.elapsed().as_secs_f64() * 1000.0;
                if minimised {
                    // Pause on minimise is the default now, with TWO exemptions
                    // that must keep video + audio rolling while hidden:
                    //   * casting to a device — pausing would cut the cast off.
                    //   * an in-sync watch-party member (leader OR follower) —
                    //     pausing would desync the party (followers freeze with no
                    //     drift-tick recovery; a paused leader falls behind and
                    //     snaps everyone back on restore).
                    if crate::cast::has_active_session() {
                        crate::devlog!(info, "win", "minimised while casting → keep playing");
                    } else if party_keep_alive() {
                        crate::devlog!(info, "win", "minimised as in-sync party member → keep playing (stay in sync)");
                    } else {
                        crate::devlog!(info, "win", "minimised → pause MPV");
                        pause_mpv(&handle);
                    }
                    LAST_MINIMIZED.store(true, Ordering::Relaxed);
                    return;
                }
                // Past the minimize bail-out on purpose: see fit_main_webview.
                fit_main_webview(&handle, *size);
                // Restored from minimize: tray click, taskbar button, Win+D, or
                // a second instance raising this one. Wake the engine pump. It
                // is asleep on a 150 ms HIDDEN_TICK, and its geometry pass is
                // edge-triggered on a CHANGED rect, so a same-size restore
                // would otherwise leave the host window unpainted and any
                // queued command up to a full tick late. Deliberately NOT
                // hooked to Focused(true), which fires on every alt-tab and
                // would run a forced pass on a very common gesture.
                #[cfg(all(target_os = "windows", debug_assertions))]
                let t_step = std::time::Instant::now();
                let restored = LAST_MINIMIZED.swap(false, Ordering::Relaxed);
                if restored {
                    #[cfg(target_os = "windows")]
                    crate::mpv::engine::wake_and_resync();
                }
                #[cfg(all(target_os = "windows", debug_assertions))]
                let ms_wake = t_step.elapsed().as_secs_f64() * 1000.0;
                // Non-minimise resizes need no backstop here — the
                // engine's pump loop tracks the parent rect itself.
                //
                // Persist a maximize/restore TRANSITION immediately. The
                // window-state plugin only captures the maximized flag on
                // CloseRequested / app-exit, so a hard process-kill (Task
                // Manager, crash, OS shutdown) — which fires neither — would
                // restore a stale flag and the window would open un-maximized.
                // Writing the truthful state the moment the user maximizes or
                // restores means the choice survives a kill. Fires only on an
                // actual state change (not every drag tick), and only while
                // visible (the early return above handles minimized, where
                // is_maximized() falsely reports false).
                #[cfg(all(target_os = "windows", debug_assertions))]
                let t_step = std::time::Instant::now();
                let maxi = matches!(win.is_maximized(), Ok(true)) as i8;
                #[cfg(all(target_os = "windows", debug_assertions))]
                let ms_is_max = t_step.elapsed().as_secs_f64() * 1000.0;
                #[cfg(all(target_os = "windows", debug_assertions))]
                let mut ms_save = f64::NAN;
                if LAST_MAXIMIZED.swap(maxi, Ordering::Relaxed) != maxi {
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    #[cfg(all(target_os = "windows", debug_assertions))]
                    let t_save = std::time::Instant::now();
                    let _ = handle.save_window_state(
                        StateFlags::all() ^ StateFlags::FULLSCREEN,
                    );
                    #[cfg(all(target_os = "windows", debug_assertions))]
                    {
                        ms_save = t_save.elapsed().as_secs_f64() * 1000.0;
                    }
                }
                // One line, emitted after every measurement is taken, so
                // the log itself cannot inflate any of the numbers it
                // reports. Only on a restore or a slow pass, so an
                // ordinary drag-resize stays quiet.
                #[cfg(all(target_os = "windows", debug_assertions))]
                {
                    let total = t_arm.elapsed().as_secs_f64() * 1000.0;
                    if (restored || total >= 2.0) && crate::win_probe::enabled() {
                        let save = if ms_save.is_nan() {
                            "skipped".to_string()
                        } else {
                            format!("{ms_save:.1} ms")
                        };
                        crate::devlog!(
                            warn, "wintiming",
                            "Resized arm{}: {total:.1} ms total (is_minimized {ms_is_min:.1}, wake {ms_wake:.1}, is_maximized {ms_is_max:.1}, save_window_state {save})",
                            if restored { " [RESTORE]" } else { "" },
                        );
                    }
                }
            }
            WindowEvent::CloseRequested { api, .. } => {
                // A bulk History scrobble is mid-flight and this close would END THE
                // PROCESS. Tearing down now would abandon the run partway, leaving
                // Trakt/AniList half-updated with nothing to say where it stopped —
                // so hand the decision to the user rather than guessing. The
                // frontend answers by finishing the run, cancelling it, or
                // dismissing; each path clears the flag and re-issues the close, and
                // we then fall through to the normal teardown below.
                //
                // Gated on `!minimize_to_tray_on_close`: in tray mode the X button
                // does not exit at all, it just hides the window, and the run would
                // carry on perfectly happily in the background. Prompting there
                // would be asking the user to approve something that isn't
                // happening.
                //
                // Runs FIRST, before any shutdown housekeeping, so a prevented close
                // leaves no side effects behind.
                // Is this close actually going to END the process? Normally that
                // is just "tray mode is off", but a force quit (press-and-hold on
                // the close button, or the tray's Quit) overrides tray mode for
                // this one close. Everything below branches on THIS, not on the
                // setting, so the force-quit path gets the identical shutdown
                // discipline an ordinary close gets.
                let exiting =
                    FORCE_QUIT.load(Ordering::SeqCst) || !cfg.minimize_to_tray_on_close;

                if exiting && crate::scrobble::scrobble_run_active() {
                    api.prevent_close();
                    use tauri::Emitter;
                    let _ = handle.emit("aura:scrobble-close-request", ());
                    // FORCE_QUIT is intentionally LEFT ARMED here: the prompt's
                    // "finish" and "stop and close" paths re-issue a plain close,
                    // and that follow-up must still quit rather than fall back to
                    // hiding. The "keep Aura open" path disarms it explicitly via
                    // cancel_quit().
                    return;
                }

                // Same shape as the scrobble gate above, for the same reason:
                // a 40 GB transfer is exactly the thing a user does not want
                // to lose to a reflexive click on the X. The prompt's "quit
                // anyway" path re-issues a plain close, by which time the
                // downloads have been parked and this gate passes.
                //
                // FORCE_QUIT stays armed for the same reason it does above.
                if exiting && crate::downloads::active_count() > 0 {
                    api.prevent_close();
                    use tauri::Emitter;
                    let _ = handle.emit(
                        "aura:downloads-close-request",
                        serde_json::json!({
                            "active": crate::downloads::active_count(),
                            // Jobs a "stop everything" would have to CANCEL
                            // rather than pause, so the prompt can say so
                            // before the user commits.
                            "unpausable": crate::downloads::unpausable_active(),
                        }),
                    );
                    return;
                }

                // Belt-and-suspenders — restore the Windows taskbar in
                // case the user closes while still in fullscreen mode.
                #[cfg(target_os = "windows")]
                crate::win32::ensure_taskbar_visible();

                // Preserve the maximize state across restart.
                // tauri-plugin-window-state captures `is_maximized()` when it
                // persists on CloseRequested AND on app exit — and a
                // MINIMIZED window reports is_maximized() == false. So
                // closing or quitting Aura while it sits minimized saved
                // `maximized: false`, and the NEXT launch opened un-maximized
                // at the last non-maximized size (which recover_window_state
                // can't heal — that only fixes a full-monitor window). If we
                // are minimized at close, un-minimize so the show-state is
                // truthful, then force a corrected save. No-op on a normal
                // visible close. Flags mirror the plugin registration in
                // lib.rs (all bits except FULLSCREEN).
                if matches!(win.is_minimized(), Ok(true)) {
                    let _ = win.unminimize();
                    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                    let _ = handle.save_window_state(
                        StateFlags::all() ^ StateFlags::FULLSCREEN,
                    );
                }

                if !exiting {
                    // Tray-hide path — keep the process alive, let the user
                    // bring the window back via the tray icon. We deliberately
                    // do NOT stop MPV: hiding the window mid-playback should
                    // feel like a quick "hide, resume later" toggle.
                    //
                    // Pause MPV before calling win.hide() (skipped while
                    // casting). When the OS marks the window
                    // hidden, libmpv's vo keeps rendering frames into the
                    // off-screen child surface; on this build that's been
                    // observed to leave audio / video desynced or the vo
                    // stuck on a frozen frame after the user restores
                    // from the tray. Pausing first means MPV is in a
                    // known-quiet state across the hide/show cycle and
                    // the user-perceived "stream broke while minimised
                    // to tray" symptom doesn't manifest. Two exemptions keep
                    // playback rolling across the hide (same as the minimise
                    // path above): while casting (don't cut the cast off) and
                    // while an in-sync watch-party member (don't desync the party).
                    if !crate::cast::has_active_session() && !party_keep_alive() {
                        pause_mpv(&handle);
                    }
                    api.prevent_close();
                    // Minimize BEFORE hiding, so the window carries WS_MINIMIZE
                    // while it sits in the tray. That is what gives the restore
                    // (show then unminimize, in tray::show_main_window) a real
                    // iconic to restored transition for Windows to animate;
                    // showing a merely hidden window never animates. Order is
                    // load-bearing in both directions: after prevent_close and
                    // the pause above, and before the hide, because SW_MINIMIZE
                    // carries SWP_SHOWWINDOW and would un-hide an
                    // already-hidden window.
                    let _ = win.minimize();
                    let _ = win.hide();
                    // Then tell WebView2 the page is hidden, so it stops
                    // producing frames in the tray (see "Tray webview
                    // parking"). Undone before the window is shown again.
                    // TRAY_HIDDEN lets a blocker that clears while in the tray
                    // park it later (repark_if_tray_hidden).
                    TRAY_HIDDEN.store(true, Ordering::Release);
                    park_main_webview(&handle);
                    // Window is now hidden to the tray — surface the tray icon,
                    // which is its only route back. Hidden again on restore
                    // (tray::show_main_window).
                    crate::tray::set_tray_visible(&handle, true);
                } else {
                    // Clean-shutdown path — tear down MPV synchronously so
                    // libmpv releases its WASAPI device, then EXPLICITLY exit
                    // the process. The tray icon (always installed) would
                    // otherwise keep the app alive in a zombie state where the
                    // window has closed AND MPV has been destroyed — every
                    // subsequent load_video would error "instance not found".
                    //
                    // The best-effort teardowns (scrobble flush, cast stop,
                    // thumb worker) each block on the network / a join, so the
                    // old strictly-sequential order could take ~7 s worst case.
                    // Run them CONCURRENTLY on background threads so they
                    // overlap each other AND the mandatory MPV teardown — they
                    // touch only the network / a side mpv handle / Discord
                    // (never Win32), so they're safe off the main thread — then
                    // bound the wait. A fast, clean exit also narrows the
                    // Windows self-update file-lock window (the NSIS updater
                    // can't overwrite aura.exe until this process is gone).
                    //
                    // FLUSH SCROBBLE so Trakt / AniList see a clean stop on a
                    // hard window-close (the JS useScrobble cleanup never runs
                    // when the process exits via app.exit, which left Trakt
                    // stuck "Currently watching" for hours). Capped 2 s.
                    let sc = handle.clone();
                    #[allow(unused_mut)]
                    let mut bg = vec![
                        std::thread::spawn(move || crate::scrobble::shutdown_blocking(&sc)),
                        // Cast teardown stops the Chromecast heartbeat thread +
                        // receiver app so the TV doesn't sit on a dead splash.
                        std::thread::spawn(crate::cast::shutdown_blocking),
                    ];
                    // Headless thumbnail engine — no-op unless a thumbnail was
                    // requested. audio=no, so it holds no WASAPI device; an
                    // un-joined teardown leaks nothing the OS won't reclaim.
                    #[cfg(target_os = "windows")]
                    bg.push(std::thread::spawn(crate::mpv::thumb::shutdown));

                    // Park every running download and write the job list. Cheap
                    // and synchronous: it signals the workers (which stop at
                    // their next select, so within a chunk) and writes one
                    // small JSON file. Doing it here rather than on a bg thread
                    // means it cannot be cut short by the 2500 ms deadline and
                    // lose the list, which would strand .aurapart files with
                    // nothing pointing at them.
                    crate::downloads::shutdown();

                    // MANDATORY + main-thread only: the engine join pumps Win32
                    // messages (a child DestroyWindow posts WM_PARENTNOTIFY back
                    // to this thread), so it must run here. This is the
                    // WASAPI-release discipline (landmine #9) and always
                    // completes before exit.
                    #[cfg(target_os = "windows")]
                    crate::mpv::engine::shutdown_if_running();
                    clear_presence_inner();

                    // Join the best-effort threads, but never past a hard
                    // deadline — a stuck network teardown must not hold the
                    // process open. (The streaming bridge needs no step: it dies
                    // with the process and the OS frees the loopback listener
                    // immediately.)
                    let deadline = std::time::Instant::now()
                        + std::time::Duration::from_millis(2500);
                    for t in bg {
                        while !t.is_finished() && std::time::Instant::now() < deadline {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                        if t.is_finished() {
                            let _ = t.join();
                        }
                    }
                    handle.exit(0);
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tray parks the webview only when nothing in the page needs live
    /// timers. One test, run in sequence, because the flags are process-wide
    /// statics and parallel tests would race on them.
    #[test]
    fn park_blocker_follows_media_and_room_flags() {
        set_media_loaded(false);
        store_party_flags(false, Some(false));
        assert_eq!(park_blocker(), None, "idle app parks");

        set_media_loaded(true);
        assert_eq!(park_blocker(), Some("a file is loaded"));
        set_media_loaded(false);

        // Joined a room but not (yet) in sync: still no park.
        store_party_flags(false, Some(true));
        assert_eq!(park_blocker(), Some("in a watch-together room"));
        // An older caller that omits in_room leaves it unchanged.
        store_party_flags(false, None);
        assert_eq!(park_blocker(), Some("in a watch-together room"));
        store_party_flags(false, Some(false));
        assert_eq!(park_blocker(), None);

        // In-sync member: the keep-alive alone also blocks.
        store_party_flags(true, None);
        assert_eq!(park_blocker(), Some("in a watch-together room"));
        store_party_flags(false, Some(false));
        assert_eq!(park_blocker(), None);

        // Re-park gating: only while hidden to the tray, not yet parked, and
        // with nothing blocking.
        TRAY_HIDDEN.store(false, Ordering::Release);
        WEBVIEW_PARKED.store(false, Ordering::Release);
        assert!(!repark_due(), "a visible window never re-parks");
        TRAY_HIDDEN.store(true, Ordering::Release);
        set_media_loaded(true);
        assert!(!repark_due(), "still blocked: a file is loaded");
        set_media_loaded(false);
        assert!(repark_due(), "blocker cleared while in the tray");
        WEBVIEW_PARKED.store(true, Ordering::Release);
        assert!(!repark_due(), "already parked");
        WEBVIEW_PARKED.store(false, Ordering::Release);
        store_party_flags(false, Some(true));
        assert!(!repark_due(), "still blocked: in a room");
        store_party_flags(false, Some(false));
        assert!(repark_due());
        TRAY_HIDDEN.store(false, Ordering::Release);
        assert!(!repark_due(), "a restore clears the tray state");
    }
}
