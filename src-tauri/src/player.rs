// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use indexmap::IndexMap;

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
///
/// ## Why "passthrough" uses the colorspace HINT (gpu-next reality)
///
/// Under `vo=gpu-next`, libplacebo's swapchain wrapper is the FINAL
/// authority on the DXGI swapchain state, and the ONLY mechanism that
/// flips it to HDR is the per-frame colorspace hint driven by
/// `target-colorspace-hint`. mpv's own `d3d11-output-csp=pq` is applied
/// one layer below at swapchain creation — and libplacebo immediately
/// re-decides it: with the hint off it resets the swapchain to sRGB
/// every frame (aura-mpv.log: "Initial swap chain configuration:
/// R8G8B8A8_UNORM, RGB_FULL_G22_NONE_P709" right after mpv's own
/// "Swapchain successfully configured to color space G2084"). PQ pixels
/// rendered into that sRGB surface = raised milky blacks + muted
/// highlights. (`d3d11-output-csp` was ALSO silently dropped for months
/// by the Windows manifest version-lie — see windows-app-manifest.xml —
/// but even with that fixed, the hint is what actually governs.)
///
/// On this mpv build (0.41+), explicit `target-*` options are folded
/// INTO the hint before it is sent (vo_gpu_next.c) AND into the render
/// target: the swapchain switches to 10-bit + PQ with HDR10 metadata
/// (MaxMasteringLuminance = `target-peak`), and mpv STILL tone-maps
/// content down to `target-peak`. The historical "hint disables tone
/// mapping / supersedes target params" behavior — the original
/// blown-out-whites failure on panels that under-report their real
/// peak (AW3425DW in True Black: ~450 real vs ~1000 reported) — does
/// not apply when the targets are explicit. So: hint=yes + explicit
/// BT.2020/PQ/peak/contrast = tone-mapped HDR output with correct
/// swapchain + metadata, switchable per load (the option set is
/// runtime-updatable; the engine still only writes it between files).
///
/// `peak_nits` is only consulted in "passthrough" mode; 0 = auto
/// (= the display-reported peak, for panels that report honestly).
pub fn apply_hdr_options(
    options: &mut IndexMap<String, serde_json::Value>,
    mode: &str,
    peak_nits: u32,
) {
    match mode {
        "passthrough" => {
            // THE switch that makes libplacebo negotiate the swapchain
            // to 10-bit PQ + HDR10 metadata. Explicit target params
            // below override the display-derived metadata in the hint.
            options.insert("target-colorspace-hint".into(), serde_json::json!("yes"));
            // Strict (the default) makes the renderer use the swapchain's
            // NEGOTIATED colorspace for the render target and apply our
            // target-* only where the swapchain reported nothing. When the
            // d3d11 swapchain negotiation reports back the display's own
            // characterization (its inflated ~1000-nit peak, or an SDR
            // transfer when the format negotiation faltered), our explicit
            // target-trc=pq / target-peak get SKIPPED — so mpv tone-maps to
            // the display peak, not the user's. True Black panels (~450 real
            // nits) then CLIP every highlight above their real peak: the
            // "blown highlights, ignores my nits, looks better in Peak-1000
            // mode" report. `no` makes the explicit BT.2020/PQ/peak/contrast
            // below authoritative — mpv tone-maps content to the user's peak
            // and forces the swapchain to match.
            options.insert("target-colorspace-hint-strict".into(), serde_json::json!("no"));
            // libplacebo owns the swapchain colorspace via the hint;
            // keep mpv's creation-level csp at its default.
            options.insert("d3d11-output-csp".into(),       serde_json::json!("auto"));
            options.insert("target-prim".into(),            serde_json::json!("bt.2020"));
            options.insert("target-trc".into(),             serde_json::json!("pq"));
            // Infinite display contrast: with an explicit PQ target and
            // no contrast info, libplacebo assumes a finite (~1000:1)
            // panel and BT.2390 LIFTS source blacks to that assumed
            // floor — on an OLED that rendered as a uniform milky/white
            // veil over both SDR and HDR content ("brightness/contrast
            // looks off"). `inf` maps black to true black. (On a
            // non-OLED this merely skips black-point compensation — a
            // far smaller error than the veil.)
            options.insert("target-contrast".into(),        serde_json::json!("inf"));
            options.insert("hdr-compute-peak".into(),       serde_json::json!("yes"));
            options.insert("tone-mapping".into(),           serde_json::json!("auto"));
            if peak_nits > 0 {
                options.insert("target-peak".into(),        serde_json::json!(peak_nits));
            } else {
                options.insert("target-peak".into(),        serde_json::json!("auto"));
            }
        }
        "sdr" => {
            // Active HDR→SDR tone-map. compute-peak detects the source's
            // per-scene peak luminance; mobius rolls highlights off
            // gently while keeping midtones at their natural brightness
            // (auto can over-boost on bright HDR content). target-peak
            // 203 cd/m² is BT.2408's reference SDR white.
            options.insert("target-colorspace-hint".into(), serde_json::json!("no"));
            options.insert("target-colorspace-hint-strict".into(), serde_json::json!("yes"));
            options.insert("d3d11-output-csp".into(),       serde_json::json!("auto"));
            options.insert("target-contrast".into(),        serde_json::json!("auto"));
            options.insert("target-prim".into(),            serde_json::json!("bt.709"));
            options.insert("target-trc".into(),             serde_json::json!("bt.1886"));
            options.insert("target-peak".into(),            serde_json::json!(203));
            options.insert("hdr-compute-peak".into(),       serde_json::json!("yes"));
            options.insert("tone-mapping".into(),           serde_json::json!("mobius"));
        }
        // "off" and any unknown value
        _ => {
            options.insert("target-colorspace-hint".into(), serde_json::json!("no"));
            options.insert("target-colorspace-hint-strict".into(), serde_json::json!("yes"));
            options.insert("d3d11-output-csp".into(),       serde_json::json!("auto"));
            options.insert("target-contrast".into(),        serde_json::json!("auto"));
            options.insert("hdr-compute-peak".into(),       serde_json::json!("no"));
            options.insert("tone-mapping".into(),           serde_json::json!("clip"));
            options.insert("target-prim".into(),            serde_json::json!("auto"));
            options.insert("target-trc".into(),             serde_json::json!("auto"));
            options.insert("target-peak".into(),            serde_json::json!("auto"));
        }
    }
}

// NOTE on the AniSkip Lua script (`scripts/skip-windows.lua`): the legacy
// plugin path installed it to <app_data_dir>/scripts and loaded it via a
// post-init `load-script` command. The mpv engine NEVER loaded it (since
// v0.9.0 made the engine the default, the script has been dormant) — the
// OP/ED auto-skip that users actually exercise is the React-side
// skip-window logic fed by `aniskip.rs`'s `aura:skip-windows` event. The
// engine consolidation keeps that shipped behaviour: no Lua is loaded,
// and the installer/loader code was removed with the legacy path. The
// `user-data/aura/skip-windows` property write in aniskip.rs stays (it's
// harmless without a listener and keeps the payload inspectable via
// `get_property`).

/// Resolve the mpv verbose-log path (`%USERPROFILE%\aura-mpv.log`),
/// rotating an oversized previous log to `.old` first. Returns `None`
/// when USERPROFILE is unset (never on a real Windows session).
///
/// mpv's `log-file` option truncates on init (mode 'w'), so without
/// rotation we'd overwrite valuable forensic data the moment the next
/// session starts; with one `.old` slot the previous run's final lines
/// survive for crash triage. Verbose levels can produce hundreds of MB
/// on long sessions, hence the 50 MB rotation cap. Failures are silent —
/// rotation is best-effort.
pub fn mpv_log_file_path() -> Option<String> {
    let home = std::env::var("USERPROFILE").ok()?;
    let log_path = format!("{home}\\aura-mpv.log");
    const MAX_LOG_BYTES: u64 = 50 * 1024 * 1024;
    if let Ok(meta) = std::fs::metadata(&log_path) {
        if meta.len() > MAX_LOG_BYTES {
            let rotated = format!("{home}\\aura-mpv.log.old");
            let _ = std::fs::remove_file(&rotated);
            let _ = std::fs::rename(&log_path, &rotated);
        }
    }
    Some(log_path)
}

// ---------------------------------------------------------------------------
// DLL pre-flight
// ---------------------------------------------------------------------------

/// Verify libmpv is reachable before the engine's `Libmpv::load` attempts
/// to bind it (which would otherwise surface as an opaque engine-thread
/// failure rather than a clear startup error message).
///
/// Expected layout inside the exe directory (debug: `target/debug/`):
///   lib/libmpv-2.dll         — mpv core  (github.com/zhongfly/mpv-winbuild)
///
/// `libmpv-wrapper.dll` is NO LONGER required — it belonged to
/// `tauri-plugin-libmpv`, removed in the engine consolidation.
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

        // On-demand download dir (libmpv is no longer bundled — fetched at
        // first run). Matches mpv::ffi::Libmpv::search_dirs.
        if let Some(dir) = crate::runtime_deps::dir() {
            search_dirs.push(dir);
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

        let mpv_found = ["libmpv-2.dll", "mpv.dll", "mpv-2.dll", "mpv-1.dll"]
            .iter()
            .any(|name| try_load(name));

        if !mpv_found {
            return Err(
                "libmpv-2.dll not found (also tried mpv.dll, mpv-2.dll, mpv-1.dll).\n\
                 Download from: https://github.com/zhongfly/mpv-winbuild/releases\n\
                 Place libmpv-2.dll in src-tauri/lib/."
                    .to_string(),
            );
        }
    }

    // macOS / Linux: libmpv is expected on LD_LIBRARY_PATH / DYLD_LIBRARY_PATH.
    Ok(())
}

