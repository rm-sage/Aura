use indexmap::IndexMap;
use tauri::{AppHandle, Runtime};
use tauri_plugin_libmpv::{MpvConfig, MpvExt};

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
    initial_options.insert("vo".into(), serde_json::json!("gpu-next"));
    initial_options.insert("hwdec".into(), serde_json::json!("auto-safe"));
    initial_options.insert("keepaspect".into(), serde_json::json!("yes"));
    // Transparent background regions — lets Mica show through wherever the
    // video frame doesn't paint (letterbox bars, paused overlay, etc.).
    initial_options.insert("background".into(), serde_json::json!("none"));

    let mut observed_properties: IndexMap<String, String> = IndexMap::new();
    observed_properties.insert("pause".into(), "flag".into());
    observed_properties.insert("time-pos".into(), "double".into());
    observed_properties.insert("duration".into(), "double".into());

    let config = MpvConfig {
        initial_options,
        observed_properties,
    };

    app.mpv()
        .init(config, "main")
        .map(|_| ())
        .map_err(|e| e.to_string())
}
