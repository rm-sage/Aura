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
    // Mode C and C+C used to reference Anime4K_Restore_GAN_*.glsl, but
    // the canonical Anime4K v4 release doesn't ship a "Restore_GAN" step
    // — Mode C uses the combined upscale+denoise shader
    // (Upscale_Denoise_CNN_x2_*) as its single processing step instead.
    // The old chains failed with "shader file not found" for every user
    // because the GAN files literally don't exist upstream. Replaced
    // with the canonical Mode C / C+C definitions.
    (11, "Anime4K Mode C",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Upscale_Denoise_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Upscale_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode C. Combined denoise + upscale in one step. Sharpest of the single-pass modes; best for clean Blu-ray sources where fine detail is already present."),
    (12, "Anime4K Mode C+C",
        &[
            "Anime4K_Clamp_Highlights.glsl",
            "Anime4K_Upscale_Denoise_CNN_x2_VL.glsl",
            "Anime4K_AutoDownscalePre_x2.glsl",
            "Anime4K_AutoDownscalePre_x4.glsl",
            "Anime4K_Upscale_Denoise_CNN_x2_M.glsl",
        ],
        "Anime4K v4 — Mode C+C. Double denoise + upscale chain. Heaviest GPU cost; use only on a strong dGPU. Maximum sharpness on already-clean source material."),
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
    // Candidate base dirs for the bundled `shaders/` folder, first existing
    // wins — mirrors silencedetect::ffmpeg_bin. Without the exe-dir +
    // CARGO_MANIFEST_DIR fallbacks, `tauri dev` (where bundled resources are
    // NOT copied into resource_dir) can't find the shaders, so the upscaler
    // failed with "Shader file not found" / "Upscaler failed" on dev builds —
    // which looked like a party-follower-only bug when one device ran dev.
    let mut shader_dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        shader_dirs.push(dir.join("shaders"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            shader_dirs.push(dir.join("shaders"));
        }
    }
    shader_dirs.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("shaders"));

    let mut resolved_paths: Vec<String> = Vec::with_capacity(shader_files.len());
    for filename in shader_files.iter() {
        let path = shader_dirs
            .iter()
            .map(|d| d.join(filename))
            .find(|p| p.exists())
            .ok_or_else(|| {
                format!(
                    "Shader file not found: {} (looked in: {})\n\
                     Place it in src-tauri/shaders/ and rebuild. See shaders/README.txt.",
                    filename,
                    shader_dirs.iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(", "),
                )
            })?;
        let raw = path.to_string_lossy().into_owned();
        let cleaned = raw
            .strip_prefix(r"\\?\UNC\")
            .map(|s| format!(r"\\{}", s))
            .or_else(|| raw.strip_prefix(r"\\?\").map(String::from))
            .unwrap_or(raw);
        resolved_paths.push(cleaned.replace('\\', "/"));
    }

    // `glsl-shaders` is a CLI-list option (semicolon-separated). It can
    // NOT be assigned via `set_property` with a single path — libmpv
    // rejects that with "invalid parameter". The correct protocol is
    // `change-list <name> <op> <value>`:
    //   • change-list glsl-shaders clr ""        → drop all
    //   • change-list glsl-shaders set "<path>"  → replace (one)
    //   • change-list glsl-shaders append "<p>"  → add another
    //
    // For multi-file chains (Anime4K Mode A and friends): clear first,
    // then `set` the FIRST file, then `append` each remaining file in
    // order. The chain order matters — Anime4K expects clamp → restore →
    // upscale → downscale → upscale.
    #[cfg(target_os = "windows")]
    {
        crate::mpv::engine::submit_command(vec![
            "change-list".into(), "glsl-shaders".into(), "clr".into(), "".into(),
        ])?;
        for (i, path) in resolved_paths.iter().enumerate() {
            let op = if i == 0 { "set" } else { "append" };
            crate::devlog!(info, "cinema", "glsl-shaders {} {}", op, path);
            crate::mpv::engine::submit_command(vec![
                "change-list".into(),
                "glsl-shaders".into(),
                op.into(),
                path.clone(),
            ])?;
        }
    }
    #[cfg(not(target_os = "windows"))]
    return Err("playback engine is Windows-only".into());

    ACTIVE_PROFILE.store(profile, Ordering::Relaxed);
    Ok(())
}

/// Return the currently active shader profile id.
#[tauri::command]
pub fn get_shader_profile() -> u8 {
    ACTIVE_PROFILE.load(Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
