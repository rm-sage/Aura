/// Cinema Suite — shader profiles, performance OSD, HDR, and audio passthrough.
///
/// Shader files are bundled as Tauri resources in `src-tauri/shaders/`.
/// If a shader file is absent the command returns a descriptive error so the
/// user knows exactly which file to obtain rather than getting a silent failure.
use std::sync::atomic::{AtomicU8, Ordering};

use serde::Serialize;
use tauri::Manager;
use tauri_plugin_libmpv::MpvExt;

// ---------------------------------------------------------------------------
// Shader profiles
// ---------------------------------------------------------------------------

/// Active shader profile index stored globally so the OSD can read it without
/// an extra IPC round-trip.
static ACTIVE_PROFILE: AtomicU8 = AtomicU8::new(0);

/// Maps profile index → (display name, optional shader filename, optional MPV
/// scale/cscale override).
///
/// Exact filenames match what users are expected to place in `src-tauri/shaders/`.
/// See `shaders/README.txt` for download links.
const PROFILES: &[(u8, &str, Option<&str>, Option<(&str, &str)>)] = &[
    (0, "None",           None,                         None),
    (1, "Anime4K",        Some("Anime4K.glsl"),          None),
    (2, "FSR",            Some("FSR.glsl"),               None),
    (3, "FSRCNNX",        Some("FSRCNNX.glsl"),           None),
    (4, "KrigBilateral",  Some("KrigBilateral.glsl"),     None),
    (5, "RAVU",           Some("ravu.hook"),              None),
    (6, "SSimSuperRes",   Some("SSimSuperRes.glsl"),       None),
];

#[derive(Serialize, Clone)]
pub struct ShaderProfileInfo {
    pub id: u8,
    pub name: String,
    pub requires_file: Option<String>,
}

/// Return metadata for all profiles so the UI can render a picker.
#[tauri::command]
pub fn list_shader_profiles() -> Vec<ShaderProfileInfo> {
    PROFILES
        .iter()
        .map(|(id, name, file, _)| ShaderProfileInfo {
            id: *id,
            name: name.to_string(),
            requires_file: file.map(String::from),
        })
        .collect()
}

/// Apply a shader profile to the running MPV instance.
///
/// The shader GLSL files must exist in `$RESOURCE_DIR/shaders/`; if they are
/// absent the command returns an error naming the missing file.
#[tauri::command]
pub async fn set_shader_profile(app: tauri::AppHandle, profile: u8) -> Result<(), String> {
    let entry = PROFILES
        .iter()
        .find(|(id, ..)| *id == profile)
        .ok_or_else(|| format!("Unknown shader profile {profile}"))?;

    let (_, _name, shader_file, scale_override) = entry;

    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        let shader_path: Option<String> = if let Some(filename) = shader_file {
            let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
            let path = resource_dir.join("shaders").join(filename);
            if !path.exists() {
                return Err(format!(
                    "Shader file not found: {}\n\
                     Place the file in src-tauri/shaders/ and rebuild.",
                    path.display()
                ));
            }
            Some(path.to_string_lossy().into_owned())
        } else {
            None
        };

        let scale = scale_override.map(|(s, _)| s.to_string());
        let cscale = scale_override.map(|(_, c)| c.to_string());

        move || -> Result<(), String> {
            let mpv = app.mpv();

            // Clear any previously active shader
            mpv.command(
                "set_property",
                &vec![serde_json::json!("glsl-shaders"), serde_json::json!("")],
                "main",
            )
            .map_err(|e| e.to_string())?;

            // Apply new shader file (if any)
            if let Some(path) = shader_path {
                mpv.command(
                    "set_property",
                    &vec![serde_json::json!("glsl-shaders"), serde_json::json!(path)],
                    "main",
                )
                .map_err(|e| e.to_string())?;
            }

            // Apply scale overrides (for Sinc-Lanczos built-in profile)
            if let Some(s) = scale {
                mpv.command(
                    "set_property",
                    &vec![serde_json::json!("scale"), serde_json::json!(s)],
                    "main",
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(c) = cscale {
                mpv.command(
                    "set_property",
                    &vec![serde_json::json!("cscale"), serde_json::json!(c)],
                    "main",
                )
                .map_err(|e| e.to_string())?;
            }

            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())??;

    ACTIVE_PROFILE.store(profile, Ordering::Relaxed);
    Ok(())
}

/// Return the currently active shader profile id.
#[tauri::command]
pub fn get_shader_profile() -> u8 {
    ACTIVE_PROFILE.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// OSD helpers
// ---------------------------------------------------------------------------

/// Resolve the display name for the active shader profile.
pub fn active_profile_name() -> &'static str {
    let id = ACTIVE_PROFILE.load(Ordering::Relaxed);
    PROFILES
        .iter()
        .find(|(pid, ..)| *pid == id)
        .map(|(_, name, ..)| *name)
        .unwrap_or("None")
}
