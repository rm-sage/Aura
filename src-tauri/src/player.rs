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
/// ## Why "passthrough" is mpv-tone-mapped HDR OUTPUT, not a hint
///
/// The earlier design used `target-colorspace-hint=yes`, which tells the
/// d3d11 context to flip the swapchain to the CONTENT's colorspace and —
/// crucially — makes mpv do NO tone mapping at all (source == target by
/// definition). The display becomes responsible for compressing
/// 1000+-nit-mastered highlights into what the panel can show, and
/// monitors whose current OSD mode peaks lower than what Windows
/// reports (the AW3425DW in DisplayHDR True Black, ~450 nits real vs a
/// reported ~1000) CLIP instead — blown-out whites that NO `target-peak`
/// value can fix, because the hint supersedes the target params for HDR
/// content. Runtime rewrites of the colorspace plumbing to compensate
/// made things worse (swapchain renegotiation mid-playback mis-encodes).
///
/// The fix is to make MPV the tone-mapper while still outputting HDR:
/// force the swapchain to PQ (`d3d11-output-csp=pq` — deterministic,
/// init-time, requires HDR enabled in Windows), declare an explicit
/// BT.2020/PQ target, and tone-map content to `target-peak` =
/// `hdr_target_peak_nits` (the panel's REAL peak; "auto" = whatever the
/// display reports, for panels that report honestly). Everything is
/// static per mode — no per-content probing, no mid-playback writes.
///
/// `peak_nits` is only consulted in "passthrough" mode; 0 = auto.
pub fn apply_hdr_options(
    options: &mut IndexMap<String, serde_json::Value>,
    mode: &str,
    peak_nits: u32,
) {
    match mode {
        "passthrough" => {
            // We own the target — the hint must be OFF or it would
            // override the explicit target params for HDR content.
            options.insert("target-colorspace-hint".into(), serde_json::json!("no"));
            // Force the d3d11 swapchain to PQ so the HDR signal path is
            // active regardless of content (SDR gets mapped into the PQ
            // container at reference white). Reset to "auto" by the
            // other modes below.
            options.insert("d3d11-output-csp".into(),       serde_json::json!("pq"));
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

