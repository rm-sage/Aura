// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

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

/// Maps profile index → (display name, list of shader filenames, blurb).
///
/// Filenames must match what the user places in `src-tauri/shaders/`. The
/// chain is applied in array order — `change-list glsl-shaders set` then
/// `append` for each subsequent file — which matches Anime4K's reference
/// MPV pipeline (clamp-highlights → restore-CNN → upscale-CNN → auto-
/// downscale → final-upscale).
///
/// Single-file profiles (FSR, FSRCNNX, RAVU, KrigBilateral, SSimSuperRes,
/// legacy Anime4K) keep a single-element array so the call-site is uniform.
///
/// Per-profile metadata: (id, display_name, &[shader_files], blurb)
///
/// PROFILE IDs ARE STABLE — adding a new profile must append to the end
/// (or take an unused id) so saved per-title shader preferences keyed on
/// integer id continue to map to the right entry across releases. The
/// "Anime4K Mode A/B/A+A/B+B" entries below are net-new (ids 7–10);
/// Mode C and C+C are ids 11–12 (the GAN-restore variants).
type ShaderChain = &'static [&'static str];
const PROFILES: &[(u8, &str, ShaderChain, &str)] = &[
    (0, "None",           &[],
        "No upscaling — source frames pass through untouched. Best for already-sharp 4K content or low-end GPUs."),
    (1, "Anime4K",         &["Anime4K.glsl"],
        "Line-art-preserving upscaler tuned for animation. Sharpens edges and reduces ringing in 2D anime; not ideal for live-action."),
    (2, "FSR",             &["FSR.glsl"],
        "AMD FidelityFX Super Resolution. Fast, light on GPU, broadly safe for live-action and animation. Solid default for 1080p → 4K."),
    (3, "FSRCNNX",         &["FSRCNNX.glsl"],
        "Neural-net upscaler trained on real footage. Heavier than FSR but produces noticeably crisper detail on live-action."),
    (4, "KrigBilateral",   &["KrigBilateral.glsl"],
        "Edge-aware chroma upscaler. Best paired with another luma scaler — fixes the soft / blocky colour you sometimes see on older transfers."),
    (5, "RAVU",            &["ravu.hook"],
        "Rapid Anti-Aliasing Upscaler — sharper than FSR with a lower GPU cost than FSRCNNX. Great middle-ground default."),
    (6, "SSimSuperRes",    &["SSimSuperRes.glsl"],
        "Detail-recovery shader that reduces softness from compression. Layer on top of any other upscaler; minimal cost."),

    // Anime4K v4 reference chains — match the Stremio Community v5
    // bindings the user asked for. Each chain is applied in array order
    // via `change-list glsl-shaders set` + `append` per entry. See
    // shaders/README.txt for the exact files to drop into the resource
    // dir; missing any one of them turns the profile into a clear
    // "shader not found" error rather than silently degrading.
    //
    // Source: https://github.com/bloc97/Anime4K — Mode A/B/A+A/B+B
    // are the canonical "high-quality / lower-quality / heavy-restore"
    // permutations of the upstream pipeline.
    (7,  "Anime4K Mode A",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Restore_CNN_VL.glsl",
            "Anime4K_Upscale_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Upscale_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode A. High-quality restore + upscale. Best for clean line-art at native 1080p. Heaviest of the four anime modes."),
    (8,  "Anime4K Mode B",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Restore_CNN_Soft_VL.glsl",
            "Anime4K_Upscale_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Upscale_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode B. Softer restore than Mode A — better for noisy / heavily-compressed source material."),
    (9,  "Anime4K Mode A+A",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Restore_CNN_VL.glsl",
            "Anime4K_Upscale_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Restore_CNN_M.glsl",
            "Anime4K_Upscale_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode A+A. Double-restore variant for very low-quality sources. Maximum detail recovery; GPU cost is significant."),
    (10, "Anime4K Mode B+B",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Restore_CNN_Soft_VL.glsl",
            "Anime4K_Upscale_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Restore_CNN_Soft_M.glsl",
            "Anime4K_Upscale_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode B+B. Double-soft-restore for noisy material that needs aggressive cleanup before upscale."),
    (11, "Anime4K Mode C",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Restore_GAN_UL.glsl",
            "Anime4K_Upscale_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Upscale_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode C. GAN-based restore — sharpest of the single-restore modes. Best for clean Blu-ray sources where the source already has fine detail."),
    (12, "Anime4K Mode C+C",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Restore_GAN_UL.glsl",
            "Anime4K_Upscale_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Restore_GAN_M.glsl",
            "Anime4K_Upscale_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode C+C. Double GAN-restore. Heaviest GPU cost; use only on a strong dGPU. Maximum sharpness on already-clean source material."),
];

#[derive(Serialize, Clone)]
pub struct ShaderProfileInfo {
    pub id: u8,
    pub name: String,
    /// Legacy single-file hint surfaced for back-compat with older
    /// frontend code that read this field as a string. For multi-file
    /// chains this is the FIRST file (which is enough to detect a
    /// missing dependency in the picker UI). Use `requires_files` for
    /// the full list.
    pub requires_file: Option<String>,
    /// Full ordered list of shader files this profile applies. Empty
    /// for the "None" profile.
    pub requires_files: Vec<String>,
    /// Short human-readable description of what the profile does and when
    /// to use it. Surfaced inline in the player's upscaler menu.
    pub description: String,
}

/// Return metadata for all profiles so the UI can render a picker.
#[tauri::command]
pub fn list_shader_profiles() -> Vec<ShaderProfileInfo> {
    PROFILES
        .iter()
        .map(|(id, name, files, desc)| ShaderProfileInfo {
            id: *id,
            name: name.to_string(),
            requires_file: files.first().map(|s| s.to_string()),
            requires_files: files.iter().map(|s| s.to_string()).collect(),
            description: desc.to_string(),
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

    let (_, _name, shader_files, _description) = entry;

    // Resolve every file in the chain to an absolute, MPV-friendly path
    // BEFORE we go inside spawn_blocking. Any missing file aborts here
    // with a clear error naming the offending entry. Tauri's
    // resource_dir on Windows returns the extended-length path
    // (`\\?\C:\…`); libmpv parses that as garbage in its option-list
    // grammar and rejects with "invalid parameter", so we strip the
    // prefix and forward-slash the result.
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let mut resolved_paths: Vec<String> = Vec::with_capacity(shader_files.len());
    for filename in shader_files.iter() {
        let path = resource_dir.join("shaders").join(filename);
        if !path.exists() {
            return Err(format!(
                "Shader file not found: {}\n\
                 Place the file in src-tauri/shaders/ and rebuild.\n\
                 See shaders/README.txt for download links.",
                path.display()
            ));
        }
        let raw = path.to_string_lossy().into_owned();
        let cleaned = raw
            .strip_prefix(r"\\?\UNC\")
            .map(|s| format!(r"\\{}", s))
            .or_else(|| raw.strip_prefix(r"\\?\").map(String::from))
            .unwrap_or(raw);
        resolved_paths.push(cleaned.replace('\\', "/"));
    }

    tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || -> Result<(), String> {
            let mpv = app.mpv();

            // `glsl-shaders` is a CLI-list option (semicolon-separated). It
            // can NOT be assigned via `set_property` with a single path —
            // libmpv rejects that with "invalid parameter". The correct
            // protocol is `change-list <name> <op> <value>`:
            //   • change-list glsl-shaders clr ""        → drop all
            //   • change-list glsl-shaders set "<path>"  → replace (one)
            //   • change-list glsl-shaders append "<p>"  → add another
            //
            // For multi-file chains (Anime4K Mode A and friends): clear
            // first, then `set` the FIRST file, then `append` each
            // remaining file in order. The chain order matters — Anime4K
            // expects clamp → restore → upscale → downscale → upscale.
            mpv.command(
                "change-list",
                &vec![
                    serde_json::json!("glsl-shaders"),
                    serde_json::json!("clr"),
                    serde_json::json!(""),
                ],
                "main",
            )
            .map_err(|e| {
                crate::devlog!(warn, "cinema", "glsl-shaders clr failed: {}", e);
                e.to_string()
            })?;

            for (i, path) in resolved_paths.iter().enumerate() {
                let op = if i == 0 { "set" } else { "append" };
                crate::devlog!(info, "cinema", "glsl-shaders {} {}", op, path);
                mpv.command(
                    "change-list",
                    &vec![
                        serde_json::json!("glsl-shaders"),
                        serde_json::json!(op),
                        serde_json::json!(path.clone()),
                    ],
                    "main",
                )
                .map_err(|e| {
                    crate::devlog!(warn, "cinema", "glsl-shaders {} {} failed: {}", op, path, e);
                    e.to_string()
                })?;
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
