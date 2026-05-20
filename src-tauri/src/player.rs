// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use indexmap::IndexMap;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_libmpv::{MpvConfig, MpvExt};

/// Resolve the persisted HDR mode against the legacy `hdr_enabled` flag.
///
/// Migration rule: if `hdr_mode` is the empty string (older settings
/// files predate the field) AND `hdr_enabled` is false, treat the user
/// as having explicitly turned HDR off → return "off". Otherwise honour
/// `hdr_mode` directly (defaulting to "sdr" via serde when missing).
/// Unknown mode strings collapse back to "sdr" — the safest default
/// for the average SDR-display user.
pub fn resolve_hdr_mode(s: &crate::settings::AppSettings) -> &'static str {
    let raw = s.hdr_mode.trim().to_ascii_lowercase();
    let resolved = if raw.is_empty() {
        if s.hdr_enabled { "sdr" } else { "off" }
    } else {
        raw.as_str().to_string().leak() as &str
    };
    match resolved {
        "off" | "passthrough" | "sdr" => resolved,
        // Anything else (typo, future-mode from another build, …) falls
        // back to the safe SDR default.
        _ => "sdr",
    }
}

/// Push the right MPV property values for the resolved HDR mode into
/// the supplied option map. Used at MPV init AND by `apply_hdr_settings`
/// to update a running instance without re-init.
pub fn apply_hdr_options(
    options: &mut IndexMap<String, serde_json::Value>,
    mode: &str,
) {
    match mode {
        "passthrough" => {
            options.insert("target-colorspace-hint".into(), serde_json::json!("yes"));
            options.insert("hdr-compute-peak".into(),       serde_json::json!("yes"));
            options.insert("tone-mapping".into(),           serde_json::json!("auto"));
            // Don't pin target-prim / target-trc — let the display auto-detect.
            options.insert("target-prim".into(),            serde_json::json!("auto"));
            options.insert("target-trc".into(),             serde_json::json!("auto"));
            options.insert("target-peak".into(),            serde_json::json!("auto"));
        }
        "sdr" => {
            // Active HDR→SDR tone-map. compute-peak detects the source's
            // per-scene peak luminance; mobius rolls highlights off
            // gently while keeping midtones at their natural brightness
            // (auto can over-boost on bright HDR content). target-peak
            // 203 cd/m² is BT.2408's reference SDR white.
            options.insert("target-colorspace-hint".into(), serde_json::json!("no"));
            options.insert("target-prim".into(),            serde_json::json!("bt.709"));
            options.insert("target-trc".into(),             serde_json::json!("bt.1886"));
            options.insert("target-peak".into(),            serde_json::json!(203));
            options.insert("hdr-compute-peak".into(),       serde_json::json!("yes"));
            options.insert("tone-mapping".into(),           serde_json::json!("mobius"));
        }
        // "off" and any unknown value
        _ => {
            options.insert("target-colorspace-hint".into(), serde_json::json!("no"));
            options.insert("hdr-compute-peak".into(),       serde_json::json!("no"));
            options.insert("tone-mapping".into(),           serde_json::json!("clip"));
            options.insert("target-prim".into(),            serde_json::json!("auto"));
            options.insert("target-trc".into(),             serde_json::json!("auto"));
            options.insert("target-peak".into(),            serde_json::json!("auto"));
        }
    }
}

// Embed the Lua script in the binary so we don't need to bundle it as
// a separate resource — keeps install_skip_script() idempotent and
// dependency-free.
const SKIP_WINDOWS_LUA: &str = include_str!("../scripts/skip-windows.lua");

/// Write skip-windows.lua to <app_data_dir>/scripts/skip-windows.lua
/// at startup if it's missing or differs from the bundled copy.
/// Returns the absolute path on success, or None if installation
/// failed (in which case MPV launches without the script — degraded
/// but functional).
///
/// CRITICAL: the returned path is forward-slashed and the leading
/// `\\?\` UNC prefix (which Rust's PathBuf may produce when joining
/// with `app_data_dir` on Windows) is stripped. mpv's option parser
/// chokes on both of those — the same workaround Aura already uses
/// for `glsl-shaders` paths (see HANDOFF.md landmine #8). Without
/// this, `--script=<path>` is rejected at mpv init, which propagates
/// as an init failure and crashes Aura at startup.
fn install_skip_script<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    let dir = app.path().app_data_dir().ok()?.join("scripts");
    if std::fs::create_dir_all(&dir).is_err() { return None; }
    let path = dir.join("skip-windows.lua");
    let needs_write = match std::fs::read_to_string(&path) {
        Ok(existing) => existing != SKIP_WINDOWS_LUA,
        Err(_)       => true,
    };
    if needs_write {
        if std::fs::write(&path, SKIP_WINDOWS_LUA).is_err() {
            return None;
        }
    }
    let raw = path.to_str()?;
    let stripped = raw.strip_prefix(r"\\?\").unwrap_or(raw);
    Some(stripped.replace('\\', "/"))
}

// ---------------------------------------------------------------------------
// DLL pre-flight
// ---------------------------------------------------------------------------

/// Verify that both required shared libraries are reachable before we let
/// `tauri-plugin-libmpv` attempt to load them (which would produce an opaque
/// OS crash rather than a clear error message).
///
/// Expected layout inside the exe directory (debug: `target/debug/`):
///   lib/libmpv-wrapper.dll   — FFI shim (github.com/nini22P/libmpv-wrapper)
///   lib/libmpv-2.dll         — mpv core  (github.com/zhongfly/mpv-winbuild)
pub fn check_mpv_dll() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Build a priority-ordered list of directories to search.
        let mut search_dirs: Vec<std::path::PathBuf> = Vec::new();

        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                search_dirs.push(dir.to_path_buf());
                search_dirs.push(dir.join("lib")); // canonical plugin location
            }
        }

        // Allow overriding the search path via the build-time env var that
        // the libmpv crate conventionally uses for its link directory.
        if let Ok(dir) = std::env::var("LIBMPV_LIB_DIR") {
            search_dirs.push(std::path::PathBuf::from(dir));
        }

        let try_load = |name: &str| -> bool {
            // 1. Try each explicit directory.
            for dir in &search_dirs {
                if unsafe { libloading::Library::new(dir.join(name)) }.is_ok() {
                    return true;
                }
            }
            // 2. Fall back to PATH / system search.
            unsafe { libloading::Library::new(name) }.is_ok()
        };

        if !try_load("libmpv-wrapper.dll") {
            return Err(
                "libmpv-wrapper.dll not found.\n\
                 Download from: https://github.com/nini22P/libmpv-wrapper/releases\n\
                 Place libmpv-wrapper.dll in src-tauri/lib/ next to libmpv-2.dll."
                    .to_string(),
            );
        }

        let mpv_found = ["libmpv-2.dll", "mpv.dll", "mpv-2.dll", "mpv-1.dll"]
            .iter()
            .any(|name| try_load(name));

        if !mpv_found {
            return Err(
                "libmpv-2.dll not found (also tried mpv.dll, mpv-2.dll, mpv-1.dll).\n\
                 Download from: https://github.com/zhongfly/mpv-winbuild/releases\n\
                 Place libmpv-2.dll in src-tauri/lib/ next to libmpv-wrapper.dll."
                    .to_string(),
            );
        }
    }

    // macOS / Linux: libmpv is expected on LD_LIBRARY_PATH / DYLD_LIBRARY_PATH.
    Ok(())
}

// ---------------------------------------------------------------------------
// MPV initialisation
// ---------------------------------------------------------------------------

/// Create an MPV instance for the `"main"` window with the rendering options
/// defined in the spec (vo=gpu-next, hwdec=auto-safe) and register the
/// properties we want to observe so the plugin emits frontend events for them.
pub fn init_mpv<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let mut initial_options: IndexMap<String, serde_json::Value> = IndexMap::new();

    // ── Video ──────────────────────────────────────────────────────────────
    // `vo=gpu-next` is MPV's modern OpenGL/Vulkan compositor based on
    // libplacebo. It's the best-quality path and the one the user wants
    // to keep — confirmed as stable in this app prior to recent changes.
    // `hwdec=auto` enables the full set of MPV's hardware decoders.
    initial_options.insert("vo".into(), serde_json::json!("gpu-next"));
    initial_options.insert("hwdec".into(), serde_json::json!("auto"));
    initial_options.insert("keepaspect".into(), serde_json::json!("yes"));
    // Transparent letterbox so the area outside the active video is
    // truly empty — combined with the webview transparency this is what
    // keeps the OS-level vibrancy / desktop visible behind the player.
    initial_options.insert("background".into(), serde_json::json!("none"));

    // ── HDR ────────────────────────────────────────────────────────────────
    // Tri-state mode (was a boolean — see settings.rs). The previous "on"
    // path (target-colorspace-hint=yes + tone-mapping=auto + compute-peak)
    // routed HDR through gpu-next's display-aware path, which on common
    // SDR setups (Windows, HDR off in OS settings, monitor reporting
    // sRGB) over-brightened HDR sources because mpv assumed the display
    // could carry BT.2020 / PQ values. The user-visible artefact: bright
    // playback frames with normal-looking paused frames (pause skips the
    // active tone-map pass and shows the raw signal clipped to display
    // primaries by Windows' compositor).
    //
    // Modes:
    //   "off"          — no HDR processing. Source goes to display
    //                    untouched. SDR sources look right; HDR sources
    //                    show clipped highlights but stay natural in the
    //                    midtones. The previous "off" path.
    //   "sdr"          — actively tone-map down to a 100-nit SDR target.
    //                    Mobius preserves midtone brightness while
    //                    rolling off highlights. compute-peak adapts to
    //                    each scene. The new default.
    //   "passthrough"  — pass HDR through to an HDR-capable display.
    //                    The previous "on" path. Only correct when the
    //                    user actually has an HDR monitor with HDR mode
    //                    enabled in Windows settings.
    let s = crate::settings::snapshot();
    let resolved_mode = resolve_hdr_mode(&s);
    apply_hdr_options(&mut initial_options, resolved_mode);
    crate::devlog!(info, "player", "HDR mode resolved to '{resolved_mode}'");

    // ── Audio ──────────────────────────────────────────────────────────────
    // CRITICAL: do NOT enable `audio-exclusive` or `audio-spdif` by default.
    //
    // `audio-exclusive=yes` puts WASAPI into exclusive mode on Windows, which
    // grabs the output device for Aura alone — no other audio app (Stremio's
    // bundled MPV, mpv.net, Spotify, browsers, …) can play sound while Aura
    // is running. If Aura crashes without releasing the device, it remains
    // locked until next reboot. `audio-spdif` (bitstream passthrough)
    // implicitly forces exclusive access too, so the same lock-out applies.
    //
    // The right policy is shared mode by default; users who want bitstream
    // passthrough to an AVR / soundbar should opt in via Settings (a future
    // toggle that maps to these two properties). Until then, leave them
    // OFF so other media apps keep working.

    // ── Audio passthrough ──────────────────────────────────────────────────
    // CRITICAL: see player.rs header comment for why these default OFF.
    // Only enable when the user has explicitly opted in via Settings.
    if s.audio_passthrough {
        initial_options.insert("audio-exclusive".into(), serde_json::json!("yes"));
        initial_options.insert(
            "audio-spdif".into(),
            serde_json::json!("ac3,dts,dts-hd,eac3,truehd"),
        );
    }

    // ── Initial volume ─────────────────────────────────────────────────────
    // 50 % is a comfortable cinematic default; the user can scroll up to
    // 100 % easily. MPV's default is 100 which is too loud for first-frame
    // playback when the user is wearing headphones.
    initial_options.insert("volume".into(), serde_json::json!(50));

    // ── Streaming buffer tuning ────────────────────────────────────────────
    // The 1s-then-buffer hiccup on HTTPS streams is the demuxer running
    // out of bytes the moment playback starts. The previous round added
    // cache-pause-initial + cache-secs but the symptom kept happening,
    // because the byte-budget defaults are too small for high-bitrate
    // remuxes — MPV's cache-secs of 30 only buffers what fits in the
    // demuxer-max-bytes ceiling.
    initial_options.insert("cache".into(),                   serde_json::json!("yes"));
    // cache-pause-initial=no — let MPV BEGIN playback as soon as the
    // demuxer has decoded the first frame, instead of waiting for
    // cache-pause-wait seconds of buffer to accumulate first. The
    // initial-pause path is what produced the user-visible "stuck at
    // X%" loading bar on slow / throttled origins: cache-pause-wait=4
    // means MPV holds playback until ~4 s of buffer arrives, and
    // upstreams that initial-burst then throttle would stall mid-fill
    // (e.g. 23 % = 0.92 s buffered, then throughput drops to ~zero).
    // Stremio Community v5 uses essentially this default — playback
    // starts on first decoded frame, accepting at most one brief
    // re-pause if the cache underruns immediately. cache-pause-wait
    // (set below) is still honoured for mid-playback re-buffering, so
    // the rebuffer-cycle protection isn't lost.
    initial_options.insert("cache-pause-initial".into(),     serde_json::json!("no"));
    initial_options.insert("cache-secs".into(),              serde_json::json!(180));
    initial_options.insert("demuxer-readahead-secs".into(),  serde_json::json!(120));
    // Big byte budgets — 1.5 GiB forward / 256 MiB back. The previous
    // 512 MiB ceiling capped the cache to ~50 s of video on 4K remuxes
    // at ~80 Mbps, so the demuxer ran dry mid-playback even though
    // cache-secs was 120. With 1.5 GiB forward, even ~80 Mbps streams
    // get a clean ~150 s of headroom and stay continuous through
    // transient network jitter.
    initial_options.insert("demuxer-max-bytes".into(),       serde_json::json!(1_536_u64 * 1024 * 1024));
    initial_options.insert("demuxer-max-back-bytes".into(),  serde_json::json!(256_u64 * 1024 * 1024));
    // Initial-fill threshold AND resume-after-underflow gate.
    // Tuned to 4.0: 2.0 was perceptibly faster to start playback but
    // produced constant rebuffer cycles on bandwidth-limited streams
    // (cache fills, plays for ~2 s, drains, refills — observed in
    // production logs as cache-buffering-state cycling 0% → 100% →
    // 0% every ~10 s). 4.0 keeps the start tolerably quick while
    // giving the buffer 2× the headroom before re-pause, which on a
    // bandwidth-just-above-stream-rate connection is the difference
    // between continuous playback and constant stalls. The original
    // 5.0 was even safer but felt sluggish on episode swaps; this
    // value is the empirical sweet spot.
    initial_options.insert("cache-pause-wait".into(),        serde_json::json!(4.0));
    // Pause threshold during playback — re-enter buffering when the
    // forward queue drops below 1 s of video, instead of MPV's default
    // of 0 s (which lets the queue empty before the buffering UI shows).
    initial_options.insert("cache-pause".into(),             serde_json::json!("yes"));
    initial_options.insert("network-timeout".into(),         serde_json::json!(60));

    // ── libavformat HTTP resilience ────────────────────────────────────────
    // mpv's underlying HTTP demuxer (libavformat) accepts protocol-level
    // options via `demuxer-lavf-o`. The flags below opt into automatic
    // reconnect behaviour for transient TCP / TLS failures, which were
    // surfacing as "End of file" hard-stops on long anime episodes
    // streamed from debrid hosts that occasionally close idle keep-alives.
    //
    // Each flag (per ffmpeg/libavformat http.c documentation):
    //   • reconnect=1             — reconnect on EOF / connection drop.
    //   • reconnect_streamed=1    — reconnect for non-seekable streams too.
    //   • reconnect_on_network_error=1 — retry on transient network errors
    //     (DNS hiccup, TLS reset). Capped by reconnect_delay_max so a
    //     dead origin still surfaces as an error within ~5 s.
    //   • reconnect_delay_max=4   — max exponential backoff in seconds.
    //
    // Parallel range fetching ("custom local cache layer") was evaluated
    // in task #27 and DEFERRED:
    //   • mpv already issues sequential Range requests; the demuxer cache
    //     keeps 120 s read-ahead which is enough on most uplinks.
    //   • A multi-connection prefetch layer in `streaming.rs` would only
    //     help HTTP streams (HTTPS bypasses the bridge to keep debrid TLS
    //     valid), and most modern Stremio addons serve HTTPS — so the
    //     impact would be limited.
    //   • Resilience-via-reconnect (the flags above) addresses the
    //     observed user-visible failure mode (idle-drop EOF) without the
    //     engineering risk of duplicating the HTTP path.
    initial_options.insert(
        "demuxer-lavf-o".into(),
        serde_json::json!(
            "reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=4"
        ),
    );

    // ── Diagnostic log ─────────────────────────────────────────────────────
    // Writes MPV's own verbose log to a file we can `tail` after a crash.
    // The last few lines of this file usually tell us exactly what MPV's
    // internals were doing right before STATUS_ACCESS_VIOLATION fires.
    //
    // We set this unconditionally for now — it's cheap, and the file is
    // truncated each MPV init (mode `w`). If/when crashes are gone we can
    // gate it behind a debug flag.
    if let Ok(home) = std::env::var("USERPROFILE") {
        let log_path = format!("{home}\\aura-mpv.log");
        // Pre-emptive rotation: if a prior session's log grew past 50 MB
        // (verbose log levels can produce hundreds of MB on long
        // sessions or HDR-stat-heavy playback), rename it to
        // `aura-mpv.log.old` before mpv reopens. mpv's `log-file`
        // option truncates on init in mode 'w', so without rotation we
        // overwrite valuable forensic data the moment the next session
        // starts. With one .old slot we preserve the previous run's
        // final lines for crash triage. Failures here are silent;
        // rotation is best-effort.
        const MAX_LOG_BYTES: u64 = 50 * 1024 * 1024;
        if let Ok(meta) = std::fs::metadata(&log_path) {
            if meta.len() > MAX_LOG_BYTES {
                let rotated = format!("{home}\\aura-mpv.log.old");
                let _ = std::fs::remove_file(&rotated);
                let _ = std::fs::rename(&log_path, &rotated);
            }
        }
        initial_options.insert("log-file".into(), serde_json::json!(log_path.clone()));
        initial_options.insert("msg-level".into(), serde_json::json!("all=v"));
        crate::devlog!(info, "player", "MPV log: {}", log_path);
    }

    // ── Subtitles ──────────────────────────────────────────────────────────
    initial_options.insert("sub-pos".into(), serde_json::json!("95"));
    initial_options.insert("sub-font-size".into(), serde_json::json!("45"));
    initial_options.insert("sub-border-size".into(), serde_json::json!("3"));
    initial_options.insert("sub-shadow-offset".into(), serde_json::json!("2"));
    initial_options.insert("sub-color".into(), serde_json::json!("#FFFFFFFF"));

    // ── Anime OP/ED skip script ────────────────────────────────────────────
    // The Lua script IS installed to <app_data_dir>/scripts/skip-
    // windows.lua at startup so it's ready on disk, but we deliberately
    // DO NOT pass it to mpv via any initial-option key on this build:
    //
    //   • `script`         → libmpv rejects as unknown option →
    //                        `mpv_terminate_destroy` cross-thread hang
    //                        during `mpv_create` (confirmed via WinDbg
    //                        thread 11 stack: mpv_create → mpv_terminate
    //                        _destroy → SleepConditionVariableSRW; main
    //                        thread sitting in mpv_destroy waiting on
    //                        the same handshake → deadlock).
    //   • `scripts`        → same hang. The Windows path's drive-letter
    //                        colon (`C:/...`) is parsed as a string-list
    //                        separator, splitting into invalid entries,
    //                        triggering the same destroy path.
    //   • `scripts-append` → ALSO triggers the same hang on tauri-plugin
    //                        -libmpv 0.3.2's wrapper build. The wrapper
    //                        seems to reject the option key entirely.
    //
    // The defensive retry path below can't help — the FIRST init
    // attempt never returns; it's the wrapper's destroy-during-create
    // sequence that hangs, not the option-parse.
    //
    // Result: skip-anime-OPs auto-skipping is dormant on this build.
    // The AniSkip API call, settings UI, payload property write, and
    // installed Lua file all still work — they just have no script
    // listening on the mpv side. To re-enable, swap the wrapper for a
    // build that supports script loading via the libmpv option API,
    // or use mpv's runtime `load-script` command (which has its own
    // landmines per CLAUDE.md #1).
    // The script is materialised here so the post-init `load-script`
    // command (further below) has an absolute path to point at. Don't
    // wire it via initial_options — that path deadlocks mpv_create on
    // this libmpv build.
    let _ = install_skip_script(app);

    // ── Observed properties ────────────────────────────────────────────────
    //
    // CRITICAL: Phase 6.0.1 had a much larger observation set including
    // `track-list` (node format), `aid`/`sid` (string), and `core-idle` /
    // `paused-for-cache` (flag). On the libmpv build this project links
    // against, requesting some of those formats during init can cause the
    // wrapper's internal observation thread to never emit ANY property
    // events — symptom is identical to "nothing changes in the UI".
    //
    // We've trimmed back to the well-known-working set (pause, time-pos,
    // duration, volume, speed) and let the React side pull the rest via
    // `get_property` polling on a short timer. Keeps the UI live without
    // depending on flaky observe semantics.
    // CRITICAL: ANY unrecognised property name or format silently kills the
    // ENTIRE observation channel on this libmpv build — no events fire at
    // all. Past victims: track-list(node), aid/sid(string), core-idle(flag),
    // paused-for-cache(flag), frame-drop-count(int64), dwidth/dheight(int64).
    // OSD stats are now polled via get_property in CinemaSuite instead.
    let mut observed_properties: IndexMap<String, String> = IndexMap::new();
    observed_properties.insert("pause".into(),    "flag".into());
    observed_properties.insert("time-pos".into(), "double".into());
    observed_properties.insert("duration".into(), "double".into());
    observed_properties.insert("volume".into(),   "double".into());
    observed_properties.insert("speed".into(),    "double".into());

    let config = MpvConfig {
        initial_options,
        observed_properties,
    };

    // Single init attempt now that the script-loading option has been
    // removed (see header note above). Earlier defensive retry-without-
    // script path is gone because there's nothing to strip — the prior
    // failure mode was libmpv hanging in mpv_create's destroy handshake
    // BEFORE returning, so the retry never had a chance to fire anyway.
    app.mpv()
        .init(config, "main")
        .map(|_| ())
        .map_err(|e| e.to_string())?;

    // ── Post-init script load (experimental) ──────────────────────────────
    // After init succeeds, try wiring the skip-windows.lua script via
    // mpv's runtime `load-script` COMMAND (different from the option
    // path that crashed mpv_create). This is the prototype mentioned in
    // the resolution notes — if it works, we get OP/ED auto-skip back
    // without forking the libmpv wrapper.
    //
    // Best-effort: the command interface is known unreliable on this
    // libmpv build (CLAUDE.md landmine #1 covers `set_property` via
    // command — silently no-ops). For real commands like `load-script`
    // it's less clear; we log the result either way so the user can
    // see in DevConsole whether the script actually loaded. A failure
    // here does NOT propagate as an init error — playback still works.
    if let Some(script_path) = install_skip_script(app) {
        let app_clone = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // The mpv command interface accepts a vec of args. For
            // `load-script` the only arg is the file path string.
            let args = vec![serde_json::Value::String(script_path.clone())];
            let result = app_clone.mpv().command(
                "load-script",
                &args,
                "main",
            );
            match result {
                Ok(_) => crate::devlog!(
                    info, "player",
                    "skip-windows.lua loaded via load-script command — OP/ED auto-skip active"
                ),
                Err(e) => crate::devlog!(
                    warn, "player",
                    "load-script failed: {}; OP/ED auto-skip dormant", e
                ),
            }
        });
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Hover-seek thumbnails — native 2nd-libmpv frame engine.
//
// A single lazily-initialised, paused, audio-less, headless `"thumb"`
// libmpv instance. Per request: (re)loadfile when the URL changes,
// seek absolute+exact, brief bounded settle, `screenshot-to-file`
// (video, no OSD/subs) to a temp JPEG, base64 → data URL.
//
// RISK (user-accepted): multi-instance + headless screenshot are
// unverified on this libmpv-wrapper build. EVERYTHING here fails
// gracefully to `Ok(None)` (or `Err` the JS side swallows) so the
// scrubber simply falls back to the timestamp-only tooltip — it can
// never break the main player. `screenshot-raw` is intentionally NOT
// used: the plugin's `command` returns no value, so the only way to
// get pixels out is via a file. Output is pre-scaled to 320 px wide
// so each data URL is a few KB.
// ---------------------------------------------------------------------------

struct ThumbState {
    inited: bool,
    loaded_url: Option<String>,
}
static THUMB: std::sync::OnceLock<std::sync::Mutex<ThumbState>> = std::sync::OnceLock::new();

/// Standard base64 (with padding). Tiny inline impl — avoids pulling a
/// new crate for a few-KB transient thumbnail.
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Result shape for `extract_thumbnail`. The Rust side reports the
/// ACTUAL `playback-time` at which mpv produced the frame, not just the
/// requested seek target — the frontend caches at the actual time so an
/// immediate re-hover one second later hits the cache instead of
/// re-paying the seek+screenshot cost.
#[derive(serde::Serialize)]
pub struct ThumbResult {
    pub data_url: String,
    pub at:       f64,
}

#[tauri::command]
pub async fn extract_thumbnail(
    app: AppHandle,
    url: String,
    at_seconds: f64,
) -> Result<Option<ThumbResult>, String> {
    if url.is_empty() || !at_seconds.is_finite() || at_seconds < 0.0 {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<ThumbResult>, String> {
        let lock = THUMB.get_or_init(|| {
            std::sync::Mutex::new(ThumbState { inited: false, loaded_url: None })
        });
        // Serialise all thumb ops (the JS side single-flights + debounces
        // anyway, so contention is minimal).
        let mut st = lock.lock().map_err(|_| "thumb state poisoned".to_string())?;
        let mpv = app.mpv();

        if !st.inited {
            let mut opts: IndexMap<String, serde_json::Value> = IndexMap::new();
            opts.insert("vo".into(), serde_json::json!("null"));
            opts.insert("audio".into(), serde_json::json!(false));
            opts.insert("pause".into(), serde_json::json!(true));
            opts.insert("idle".into(), serde_json::json!("yes"));
            // Software decode — predictable headless screenshots; no
            // shared GPU surface with the main instance.
            opts.insert("hwdec".into(), serde_json::json!("no"));
            opts.insert("really-quiet".into(), serde_json::json!(true));
            opts.insert("hr-seek".into(), serde_json::json!("yes"));
            opts.insert("vf".into(), serde_json::json!("scale=320:-2"));
            opts.insert("screenshot-format".into(), serde_json::json!("jpg"));
            opts.insert("screenshot-jpeg-quality".into(), serde_json::json!(80));
            opts.insert("demuxer-max-bytes".into(), serde_json::json!("32MiB"));
            opts.insert("cache".into(), serde_json::json!("yes"));
            let cfg = MpvConfig {
                initial_options: opts,
                observed_properties: IndexMap::new(),
            };
            mpv.init(cfg, "thumb").map_err(|e| {
                crate::devlog!(warn, "player", "thumb instance init failed: {e}");
                format!("thumb init: {e}")
            })?;
            st.inited = true;
            crate::devlog!(info, "player", "thumb libmpv instance initialised");
        }

        if st.loaded_url.as_deref() != Some(url.as_str()) {
            mpv.command("loadfile", &vec![serde_json::json!(url.clone())], "thumb")
                .map_err(|e| format!("thumb loadfile: {e}"))?;
            st.loaded_url = Some(url.clone());
            // Let demux/decode spin up before the first seek.
            std::thread::sleep(std::time::Duration::from_millis(450));
        }

        let mut path = std::env::temp_dir();
        path.push("aura-thumb.jpg");
        let path_fwd = path.to_string_lossy().replace('\\', "/");

        // Bounded retry — this is the "warm-up" fix. On the FIRST hover
        // of a freshly-loaded URL the headless decode pipeline usually
        // hasn't produced a frame yet, so the first screenshot(s) come
        // back empty. The old code returned Ok(None) immediately, so the
        // scrubber flashed the loading spinner then nothing and the user
        // had to hover 2-3 times to "warm" the engine. Retrying the
        // seek+screenshot here self-warms WITHIN the first hover. Warm /
        // subsequent hovers still succeed on attempt 0, so there's no
        // added latency once primed.
        //
        // Seek-confirmation poll (2026-05-19): the old fixed sleep was
        // often shorter than a real exact-seek on a remote stream, so
        // the screenshot returned the PREVIOUSLY decoded frame and the
        // tooltip lied about which moment it showed. We now poll
        // `playback-time` against the requested target until it matches
        // ±0.5 s, bounded. The thumb instance is serialised under THUMB's
        // Mutex (paused, vo=null, idle) — no concurrent ops, so
        // landmine #3's race-during-seek does not apply (that documents
        // the *main* instance race with Lua-issued seeks). Format MUST
        // be "double" (NEVER "node" — that's the dispatch-table fault
        // path on this libmpv build).
        for attempt in 0..6u32 {
            mpv.command(
                "seek",
                &vec![serde_json::json!(at_seconds), serde_json::json!("absolute+exact")],
                "thumb",
            )
            .map_err(|e| format!("thumb seek: {e}"))?;

            // Confirm the seek landed before screenshotting.
            let deadline_ms: u32 = if attempt == 0 { 900 } else { 500 };
            let mut waited_ms: u32 = 0;
            let mut confirmed = false;
            while waited_ms < deadline_ms {
                std::thread::sleep(std::time::Duration::from_millis(25));
                waited_ms += 25;
                if let Ok(v) = mpv.get_property("playback-time".into(), "double".into(), "thumb") {
                    if let Some(pt) = v.as_f64() {
                        if (pt - at_seconds).abs() <= 0.5 {
                            confirmed = true;
                            break;
                        }
                    }
                }
            }
            if !confirmed { continue; } // try seek again

            let _ = std::fs::remove_file(&path);
            mpv.command(
                "screenshot-to-file",
                &vec![serde_json::json!(path_fwd.clone()), serde_json::json!("video")],
                "thumb",
            )
            .map_err(|e| format!("thumb screenshot: {e}"))?;
            std::thread::sleep(std::time::Duration::from_millis(50));

            if let Ok(bytes) = std::fs::read(&path) {
                if !bytes.is_empty() {
                    let _ = std::fs::remove_file(&path);
                    // Read the actual playback-time once more for the
                    // return shape (Fix 3b). Same safety as the poll
                    // above. Falls back to the requested target if the
                    // get_property happens to fail at the same moment.
                    let actual_at = mpv
                        .get_property("playback-time".into(), "double".into(), "thumb")
                        .ok()
                        .and_then(|v| v.as_f64())
                        .unwrap_or(at_seconds);
                    return Ok(Some(ThumbResult {
                        data_url: format!("data:image/jpeg;base64,{}", b64_encode(&bytes)),
                        at:       actual_at,
                    }));
                }
            }
        }
        // Still nothing after the retries (headless render produced
        // nothing on this build) — graceful: scrubber stays on the
        // timestamp-only tooltip.
        let _ = std::fs::remove_file(&path);
        Ok(None)
    })
    .await
    .map_err(|e| e.to_string())?
}
