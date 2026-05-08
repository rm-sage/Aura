Place upscaling shader files in this directory. Filenames must match
exactly — Aura looks them up by name when applying a shader profile.
The .glsl / .hook files themselves are gitignored to keep the repo
small; you have to download them once per clone.

After placing files here, run `pnpm tauri build` (or `pnpm tauri dev`
for live reload). A profile fails with a clear "shader file not
found" error naming the missing entry if any required file is
absent — silent partial chains are not possible.

================================================================
SINGLE-FILE PROFILES
================================================================

  Profile 1 — Anime4K (legacy single-shader)  → Anime4K.glsl
    https://github.com/bloc97/Anime4K/releases
    Pick any single-pass build, e.g. Anime4K_Upscale_CNN_x2_VL.glsl,
    and rename it to Anime4K.glsl.

  Profile 2 — FSR                              → FSR.glsl
    https://gist.github.com/agyild/82219984f27a34a9a5052b6399ca4c16

  Profile 3 — FSRCNNX                          → FSRCNNX.glsl
    https://github.com/igv/FSRCNN-TensorFlow/releases
    e.g. FSRCNNX_x2_16-0-4-1.glsl → rename to FSRCNNX.glsl.

  Profile 4 — KrigBilateral                    → KrigBilateral.glsl
    https://github.com/haasn/gentoo-conf/tree/master/home/nand/.config/mpv/shaders

  Profile 5 — RAVU                             → ravu.hook
    https://github.com/bjin/mpv-prescalers
    e.g. ravu-lite-ar-r4.hook → rename to ravu.hook.

  Profile 6 — SSimSuperRes                     → SSimSuperRes.glsl
    https://github.com/igv/FSRCNN-TensorFlow (or mpv-prescalers)


================================================================
ANIME4K v4 REFERENCE CHAINS  (Profiles 7–12)
================================================================

All files come from https://github.com/bloc97/Anime4K — the GLSL/
directory. Drop them in here with their stock filenames (no rename).
Bound to Ctrl+1..6 by default; Ctrl+0 disables. Rebindable in
Settings → Keybindings.

REQUIRED for ALL six modes:
  Anime4K_Clamp_Highlights.glsl
  Anime4K_Upscale_CNN_x2_VL.glsl
  Anime4K_AutoDownscalePre_x2.glsl
  Anime4K_AutoDownscalePre_x4.glsl
  Anime4K_Upscale_CNN_x2_M.glsl

Profile 7  — Mode A   (Ctrl+1)   → also needs:
  Anime4K_Restore_CNN_VL.glsl

Profile 8  — Mode B   (Ctrl+2)   → also needs:
  Anime4K_Restore_CNN_Soft_VL.glsl

Profile 11 — Mode C   (Ctrl+3)   → also needs:
  Anime4K_Upscale_Denoise_CNN_x2_VL.glsl
    (Anime4K v4 Mode C is a combined upscale+denoise step — there is
    NO separate "GAN restore" file. Earlier versions of Aura mistakenly
    referenced an Anime4K_Restore_GAN_*.glsl that does not exist
    upstream; Mode C now correctly uses the canonical denoise variant.)

Profile 9  — Mode A+A (Ctrl+4)   → also needs:
  Anime4K_Restore_CNN_VL.glsl
  Anime4K_Restore_CNN_M.glsl

Profile 10 — Mode B+B (Ctrl+5)   → also needs:
  Anime4K_Restore_CNN_Soft_VL.glsl
  Anime4K_Restore_CNN_Soft_M.glsl

Profile 12 — Mode C+C (Ctrl+6)   → also needs:
  Anime4K_Upscale_Denoise_CNN_x2_VL.glsl
  Anime4K_Upscale_Denoise_CNN_x2_M.glsl

Modes A / B / C and their double variants follow Anime4K's reference
pipeline. CNN modes (A / B / doubles) suit noisier compressed sources;
the combined denoise modes (C / C+C) are sharpest on clean Blu-ray
material. The "None" profile needs no file.
