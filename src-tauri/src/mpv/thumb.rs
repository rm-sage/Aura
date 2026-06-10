// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! `mpv::thumb` — headless hover-seek thumbnail engine on direct libmpv FFI.
//!
//! # What this replaces
//!
//! The hover-scrubber thumbnail used to spin up a SEPARATE named libmpv
//! instance ("thumb") through `tauri-plugin-libmpv` (`app.mpv().init(cfg,
//! "thumb")`). That was the one remaining consumer of the plugin's
//! named-instance API on the thumbnail path and the documented blocker for
//! retiring the plugin entirely (see the Phase-7 plan). This module ports
//! the extractor to a self-owned headless `mpv_handle` created directly via
//! [`super::ffi::Libmpv`] — no plugin, no `libmpv-wrapper.dll`, no render
//! context.
//!
//! # Why headless needs no render context
//!
//! The thumb instance runs `vo=null`: there is no video output window and
//! no presentation surface, so the render-API machinery the main engine
//! needs (`mpv_render_context_*`, a WGL context, a child HWND) is entirely
//! absent here. `screenshot-to-file` reads from the decoder / filter chain,
//! not the VO, so it produces a JPEG with the VO disabled — exactly as the
//! plugin-backed version did (user-confirmed "works flawlessly, very
//! quick"). This is a pure client-API consumer.
//!
//! # Threading model
//!
//! A single dedicated worker thread (`aura-mpv-thumb`) owns the
//! `*mut mpv_handle` and the [`Libmpv`] loader for its entire lifetime. The
//! raw pointer never crosses a thread boundary, so no `unsafe impl Send` is
//! needed and ops are naturally serialised (the JS side single-flights and
//! debounces anyway). Requests arrive over an `mpsc` channel carrying a
//! one-shot reply `Sender`; [`extract`] blocks on the reply. The worker is
//! spawned lazily on the first [`extract`] call and the mpv handle is
//! created lazily on the first request the worker processes — a load /
//! init failure is reported per-request and retried on the next one
//! (mirroring the old `inited` flag), so a transient DLL hiccup never
//! permanently disables thumbnails.
//!
//! # Fail-graceful contract
//!
//! Every path degrades to `Ok(None)` (or an `Err` the JS `.catch(() =>
//! null)` swallows) so the scrubber simply falls back to the
//! timestamp-only tooltip. Nothing here can wedge the main player.
//!
//! Windows-only — gated at the `mod` declaration in [`super`]. mpv's client
//! API is identical on every platform, but Aura ships Windows-only and the
//! sibling render engine is Windows-gated, so the thumb engine matches.

use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::ffi::{mpv_event_id, mpv_format, mpv_handle, Libmpv};
use crate::thumbs::ThumbResult;

// ===========================================================================
// Public API
// ===========================================================================

/// A single thumbnail request and its one-shot reply channel.
struct ThumbRequest {
    url: String,
    at_seconds: f64,
    /// `Ok(Some(_))` with the frame, `Ok(None)` when no frame could be
    /// produced (graceful), `Err` on a hard failure the JS side swallows.
    reply: Sender<Result<Option<ThumbResult>, String>>,
}

/// Control message to the worker thread.
enum ThumbControl {
    Extract(ThumbRequest),
    Shutdown,
}

/// Handle to the live worker thread held in the process-global [`WORKER`].
struct ThumbWorker {
    tx: Sender<ThumbControl>,
    join: Option<JoinHandle<()>>,
}

/// Process-global worker slot. Started lazily by the first [`extract`].
static WORKER: OnceLock<Mutex<Option<ThumbWorker>>> = OnceLock::new();

fn worker_slot() -> &'static Mutex<Option<ThumbWorker>> {
    WORKER.get_or_init(|| Mutex::new(None))
}

/// Extract a thumbnail at `at_seconds` from `url`. Blocks the calling
/// thread on the worker's reply — call it from a `spawn_blocking` context
/// (the Tauri command does), never on the async runtime.
///
/// Lazily spawns the worker thread on first use. Returns the actual
/// `playback-time` the captured frame landed at (see [`ThumbResult::at`]),
/// which can differ from the requested seek target after the post-seek
/// frame-step.
pub fn extract(url: String, at_seconds: f64) -> Result<Option<ThumbResult>, String> {
    // Try once with the current (or freshly spawned) worker. If the send
    // fails the worker thread is gone — its `Receiver` was dropped (channel
    // closed) — so discard the dead handle, respawn, and try once more. This
    // is what keeps the module's "never permanently disabled" contract true
    // for ANY cause of worker death (the per-request `catch_unwind` in
    // `run_worker` already prevents a single panicking request from killing
    // the thread, but this self-heal covers anything that slips past it).
    for attempt in 0..2u32 {
        let tx = ensure_worker()?;
        let (reply_tx, reply_rx) = mpsc::channel();
        match tx.send(ThumbControl::Extract(ThumbRequest {
            url: url.clone(),
            at_seconds,
            reply: reply_tx,
        })) {
            Ok(()) => {
                return reply_rx
                    .recv()
                    .map_err(|e| format!("thumb worker reply channel closed: {e}"))?;
            }
            Err(_) => {
                crate::devlog!(
                    warn, "mpv",
                    "thumb worker channel closed (attempt {attempt}) — respawning",
                );
                discard_worker();
            }
        }
    }
    Err("thumb worker unavailable after respawn".to_string())
}

/// Lazily start the worker if none is live and return a clone of its
/// command sender. Spawns the dedicated `aura-mpv-thumb` thread on first
/// use; subsequent calls just clone the existing sender.
fn ensure_worker() -> Result<Sender<ThumbControl>, String> {
    let mut guard = worker_slot()
        .lock()
        .map_err(|_| "thumb worker slot poisoned".to_string())?;
    if guard.is_none() {
        let (tx, rx) = mpsc::channel::<ThumbControl>();
        let join = thread::Builder::new()
            .name("aura-mpv-thumb".into())
            .spawn(move || run_worker(rx))
            .map_err(|e| format!("failed to spawn thumb worker: {e}"))?;
        *guard = Some(ThumbWorker { tx, join: Some(join) });
    }
    Ok(guard
        .as_ref()
        .expect("thumb worker present after lazy spawn")
        .tx
        .clone())
}

/// Drop a dead worker handle from the slot so the next [`ensure_worker`]
/// spawns a fresh one. The detached `JoinHandle` is dropped — the thread it
/// referred to is already gone (that's why we're here).
fn discard_worker() {
    if let Ok(mut guard) = worker_slot().lock() {
        *guard = None;
    }
}

/// Tear the worker down if one is running. Called from the `CloseRequested`
/// path. Sends `Shutdown` and waits for the worker to drain its current op
/// and run `mpv_terminate_destroy`, but BOUNDS the wait at 2 s so an
/// in-flight extract (worst case ~a few seconds of seek retries) can't
/// stall app shutdown — on timeout the thread is left for the OS to reap
/// at process exit. The thumb instance runs `audio=no`, so it holds no
/// WASAPI device; an un-joined teardown leaks nothing the OS won't reclaim.
pub fn shutdown() {
    // Hold the slot lock across the send + bounded join. Taking the worker out
    // and THEN releasing the lock (the prior behaviour) left the slot None for
    // the whole teardown, so a racing extract() → ensure_worker() would see
    // None and spawn a SECOND instance this stop_video never tears down
    // (defeating the free-RAM-on-stop intent). Holding the lock makes a
    // concurrent ensure_worker() block until teardown completes, then
    // deterministically spawn at most one fresh worker. The worker thread never
    // locks the slot itself, so there's no deadlock.
    let Ok(mut guard) = worker_slot().lock() else {
        return;
    };
    let Some(ThumbWorker { tx, join }) = guard.take() else {
        return;
    };
    let _ = tx.send(ThumbControl::Shutdown);
    if let Some(j) = join {
        // Join on a helper thread so the bounded wait can give up without
        // abandoning the JoinHandle's resources mid-call.
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            let _ = j.join();
            let _ = done_tx.send(());
        });
        if done_rx.recv_timeout(Duration::from_secs(2)).is_err() {
            crate::devlog!(
                warn, "mpv",
                "thumb worker did not exit within 2 s — detaching for OS reap",
            );
        }
    }
    // `guard` (slot now None) drops here, releasing the lock.
}

// ===========================================================================
// Worker thread
// ===========================================================================

/// Live state owned exclusively by the worker thread.
struct ThumbInstance {
    lib: Libmpv,
    handle: *mut mpv_handle,
    /// The URL currently loaded into the instance, so we only re-`loadfile`
    /// when the stream changes (a re-load pays the ~450 ms demux/decode
    /// spin-up; reusing the loaded file makes warm hovers instant).
    loaded_url: Option<String>,
}

/// Worker entry point. Owns the mpv handle for the thread's lifetime;
/// processes requests until `Shutdown` (or the channel closes), then tears
/// the instance down.
fn run_worker(rx: Receiver<ThumbControl>) {
    let mut instance: Option<ThumbInstance> = None;

    while let Ok(ctl) = rx.recv() {
        match ctl {
            ThumbControl::Shutdown => break,
            ThumbControl::Extract(req) => {
                // Coalesce rapid hovers: drain any newer requests already
                // queued and skip straight to the LATEST, replying Ok(None) to
                // the superseded ones (the scrubber's reqId guard ignores
                // them). Keeps the worker always on the current hover instead
                // of churning a backed-up queue — the rapid-scrub win.
                let mut req = req;
                let mut shutdown_after = false;
                loop {
                    match rx.try_recv() {
                        Ok(ThumbControl::Extract(newer)) => {
                            let _ = req.reply.send(Ok(None));
                            req = newer;
                        }
                        Ok(ThumbControl::Shutdown) => {
                            shutdown_after = true;
                            break;
                        }
                        Err(_) => break, // queue empty (or disconnected)
                    }
                }
                let ThumbRequest {
                    url,
                    at_seconds,
                    reply,
                } = req;
                // Run the FFI work inside `catch_unwind` so a panic in one
                // request degrades to an `Err` reply (the JS side `.catch`es
                // it → timestamp-only tooltip) instead of unwinding the
                // worker thread and orphaning the global slot. `?` inside the
                // closure short-circuits lazy-init failures the same way (and
                // leaves `instance` None so the next request retries init).
                // `AssertUnwindSafe`: a panic mid-op could leave libmpv state
                // inconsistent, so on `Err` we drop the instance and rebuild
                // it fresh next request.
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| unsafe {
                    if instance.is_none() {
                        instance = Some(init_instance()?);
                    }
                    let inst = instance
                        .as_mut()
                        .expect("thumb instance present after lazy init");
                    process(inst, &url, at_seconds)
                }));
                let result = match outcome {
                    Ok(r) => r,
                    Err(_) => {
                        if let Some(inst) = instance.take() {
                            unsafe { (inst.lib.terminate_destroy)(inst.handle) };
                        }
                        crate::devlog!(error, "mpv", "thumb extraction panicked — instance reset");
                        Err("thumb extraction panicked".to_string())
                    }
                };
                let _ = reply.send(result);
                if shutdown_after {
                    break;
                }
            }
        }
    }

    if let Some(inst) = instance.take() {
        unsafe { (inst.lib.terminate_destroy)(inst.handle) };
        crate::devlog!(info, "mpv", "thumb instance destroyed");
    }
}

/// Build the headless mpv instance: `mpv_create`, set the headless options
/// BEFORE `mpv_initialize` (so they go through the option path, not the
/// runtime-property path), then initialise. Mirrors the option set the
/// plugin-backed version used verbatim.
unsafe fn init_instance() -> Result<ThumbInstance, String> {
    let lib = Libmpv::load()?;
    let handle = (lib.create)();
    if handle.is_null() {
        return Err("mpv_create returned NULL (thumb)".to_string());
    }

    // Headless options. `vo=null` (no output surface), `audio=no` (no
    // WASAPI device — so teardown is non-critical), paused + idle so the
    // instance just sits between requests, software decode for predictable
    // headless screenshots, `hr-seek=yes` for exact seeks, a 320px-wide
    // downscale filter so each JPEG is a few KB, and a small demuxer cache
    // ceiling since we only ever decode one frame at a time.
    const OPTS: &[(&[u8], &[u8])] = &[
        (b"vo\0", b"null\0"),
        (b"audio\0", b"no\0"),
        (b"pause\0", b"yes\0"),
        (b"idle\0", b"yes\0"),
        (b"hwdec\0", b"no\0"),
        (b"really-quiet\0", b"yes\0"),
        (b"hr-seek\0", b"yes\0"),
        (b"vf\0", b"scale=320:-2\0"),
        (b"screenshot-format\0", b"jpg\0"),
        (b"screenshot-jpeg-quality\0", b"80\0"),
        (b"demuxer-max-bytes\0", b"32MiB\0"),
        (b"cache\0", b"yes\0"),
    ];
    for (name, value) in OPTS {
        let r = (lib.set_property_string)(
            handle,
            name.as_ptr() as *const c_char,
            value.as_ptr() as *const c_char,
        );
        if r < 0 {
            crate::devlog!(
                warn, "mpv",
                "thumb option {} = {} failed: {}",
                String::from_utf8_lossy(&name[..name.len().saturating_sub(1)]),
                String::from_utf8_lossy(&value[..value.len().saturating_sub(1)]),
                err_str(&lib, r),
            );
        }
    }

    let ir = (lib.initialize)(handle);
    if ir < 0 {
        let e = err_str(&lib, ir);
        (lib.terminate_destroy)(handle);
        return Err(format!("mpv_initialize failed (thumb): {e}"));
    }

    crate::devlog!(info, "mpv", "thumb headless instance initialised (direct FFI)");
    Ok(ThumbInstance {
        lib,
        handle,
        loaded_url: None,
    })
}

/// Run one extraction against the live instance. (re)loadfile on URL change
/// (gated on `FILE_LOADED`), then a bounded retry of seek → wait for
/// `PLAYBACK_RESTART` → `screenshot-to-file` → read bytes.
///
/// The never-stale core: instead of polling `playback-time` (which tracks the
/// DEMUXER position and can reach the target before the decoder advances its
/// OUTPUT frame — the original stale-frame race), we gate the screenshot on
/// mpv's `playback-restart` EVENT. mpv fires that exactly once it has
/// completed the (exact, `hr-seek=yes`) seek AND decoded the first frame at
/// the new position, so the frame we screenshot is guaranteed to be the sought
/// one. Event-driven (`wait_event` blocks until the event), so it's both
/// correct and fast — no fixed sleeps, no frame-step heuristic.
unsafe fn process(
    inst: &mut ThumbInstance,
    url: &str,
    at_seconds: f64,
) -> Result<Option<ThumbResult>, String> {
    let lib = &inst.lib;
    let handle = inst.handle;

    // Drain any queued events so the waits below only observe events from THIS
    // request (and so mpv's event ring can't overflow over a long session).
    drain_events(lib, handle);

    if inst.loaded_url.as_deref() != Some(url) {
        run_command(lib, handle, &["loadfile", url, "replace"])
            .map_err(|e| format!("thumb loadfile: {e}"))?;
        inst.loaded_url = Some(url.to_string());
        // Wait for the demuxer to finish opening before the first seek —
        // event-driven (far faster than a fixed sleep when the file opens
        // quickly; correct when it's slow). Bounded so a dead URL can't hang
        // the worker. On failure, drop the cached URL so the next request
        // re-loads cleanly.
        if !wait_for_event(lib, handle, mpv_event_id::FILE_LOADED, 6000) {
            inst.loaded_url = None;
            return Ok(None);
        }
    }

    let mut path = std::env::temp_dir();
    path.push("aura-thumb.jpg");
    let path_fwd = path.to_string_lossy().replace('\\', "/");
    // mpv's `seek` accepts a numeric string for the position argument.
    let target = format!("{:.3}", at_seconds);

    // Up to 3 attempts: right after a fresh loadfile the cold decode pipeline
    // occasionally needs a second seek before it emits playback-restart /
    // produces a frame. Warm hovers succeed on attempt 0.
    for attempt in 0..3u32 {
        // Clear any pending events so the waits below only see THIS seek's.
        drain_events(lib, handle);
        run_command(lib, handle, &["seek", &target, "absolute+exact"])
            .map_err(|e| format!("thumb seek: {e}"))?;

        let timeout_ms = if attempt == 0 { 3000 } else { 1500 };
        // Barrier: wait for OUR seek to START (SEEK event) before looking for
        // the completion restart. mpv fires an IMPLICIT playback-restart after
        // loadfile (first-frame decode at ~position 0); without this barrier a
        // delayed one could be mistaken for the seek's restart → a frame-0
        // screenshot labelled as the target second (the exact stale-frame bug).
        // mpv emits SEEK at seek initiation and PLAYBACK_RESTART at completion,
        // so a restart observed AFTER our SEEK is guaranteed to be ours.
        if !wait_for_event(lib, handle, mpv_event_id::SEEK, timeout_ms) {
            continue;
        }
        // The anti-stale gate proper: seek done + first frame at the new
        // position decoded. Warm seeks fire it in tens of ms.
        if !wait_for_event(lib, handle, mpv_event_id::PLAYBACK_RESTART, timeout_ms) {
            continue; // seek didn't confirm in time — retry
        }

        // Honest timestamp of the frame we're about to capture. `hr-seek=yes`
        // lands exactly on the target; if the position is far off we somehow
        // caught a restart that wasn't ours — retry rather than screenshot the
        // wrong frame (belt-and-suspenders behind the SEEK barrier).
        let actual_at = get_double(lib, handle, b"playback-time\0").unwrap_or(at_seconds);
        if (actual_at - at_seconds).abs() > 1.0 {
            continue;
        }

        let _ = std::fs::remove_file(&path);
        run_command(lib, handle, &["screenshot-to-file", &path_fwd, "video"])
            .map_err(|e| format!("thumb screenshot: {e}"))?;

        // screenshot-to-file writes synchronously, but allow one short retry
        // for the filesystem to flush the bytes.
        for _ in 0..2 {
            if let Ok(bytes) = std::fs::read(&path) {
                if !bytes.is_empty() {
                    let _ = std::fs::remove_file(&path);
                    return Ok(Some(ThumbResult {
                        data_url: format!("data:image/jpeg;base64,{}", b64_encode(&bytes)),
                        at: actual_at,
                    }));
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    // Nothing after the retries — graceful: scrubber stays on the
    // timestamp-only tooltip (or the ffmpeg fallback in thumbs.rs).
    let _ = std::fs::remove_file(&path);
    Ok(None)
}

/// Block-drain mpv's event queue until `target` fires or `timeout_ms` elapses,
/// discarding other events. Event-driven (no polling): each `wait_event` call
/// blocks until an event arrives or its sub-timeout, so `target` is observed
/// the instant mpv emits it. Returns true iff `target` was seen; `SHUTDOWN`
/// aborts the wait.
unsafe fn wait_for_event(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    target: mpv_event_id,
    timeout_ms: u64,
) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return false;
        }
        // Cap each blocking wait so the deadline is re-checked; libmpv takes
        // the timeout in seconds.
        let secs = remaining.as_secs_f64().min(0.5);
        let ev = (lib.wait_event)(handle, secs);
        if ev.is_null() {
            continue;
        }
        let id = (*ev).event_id;
        if id == target {
            return true;
        }
        if id == mpv_event_id::SHUTDOWN {
            return false;
        }
    }
}

// ===========================================================================
// FFI helpers (module-local; mirror the private helpers in `engine.rs`)
// ===========================================================================

/// `<null>`-safe NUL-terminated-C-string → owned `String`.
unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        return "<null>".to_string();
    }
    CStr::from_ptr(p).to_string_lossy().into_owned()
}

/// Format an mpv error code with its human-readable name.
unsafe fn err_str(lib: &Libmpv, code: c_int) -> String {
    format!("{code} ({})", cstr((lib.error_string)(code)))
}

/// `mpv_command(handle, args)` with a borrowed `&str` slice. Promotes each
/// argument to a NUL-terminated `CString`, builds the `*const c_char` array
/// terminated by a NULL sentinel libmpv requires, and maps a negative
/// return into a readable error.
unsafe fn run_command(
    lib: &Libmpv,
    handle: *mut mpv_handle,
    args: &[&str],
) -> Result<(), String> {
    let cstrings: Vec<CString> = args
        .iter()
        .map(|s| CString::new(*s))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("command argument contained NUL: {e}"))?;
    let mut ptrs: Vec<*const c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    let r = (lib.command)(handle, ptrs.as_mut_ptr());
    if r < 0 {
        Err(err_str(lib, r))
    } else {
        Ok(())
    }
}

/// `mpv_get_property(name, MPV_FORMAT_DOUBLE)` → `Some(f64)` on success.
/// `name` MUST be NUL-terminated. DOUBLE only — never NODE (landmine #3).
unsafe fn get_double(lib: &Libmpv, handle: *mut mpv_handle, name: &[u8]) -> Option<f64> {
    let mut v: f64 = 0.0;
    let r = (lib.get_property)(
        handle,
        name.as_ptr() as *const c_char,
        mpv_format::DOUBLE,
        &mut v as *mut _ as *mut c_void,
    );
    if r < 0 {
        None
    } else {
        Some(v)
    }
}

/// Drain mpv's event queue without blocking, discarding every event. We
/// don't observe any properties on the thumb instance, but mpv still queues
/// lifecycle events (START_FILE / FILE_LOADED / END_FILE / …) that would
/// otherwise accumulate. `wait_event(0.0)` returns immediately; stop at the
/// first NONE (queue empty) or NULL.
unsafe fn drain_events(lib: &Libmpv, handle: *mut mpv_handle) {
    loop {
        let ev = (lib.wait_event)(handle, 0.0);
        if ev.is_null() || (*ev).event_id == mpv_event_id::NONE {
            break;
        }
    }
}

/// Standard base64 (with padding). Tiny inline impl — avoids pulling a new
/// crate for a few-KB transient thumbnail. (Moved here from `player.rs`
/// alongside the rest of the thumbnail engine.)
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
