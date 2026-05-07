Place upscaling shader files here with THESE EXACT filenames.
Aura bundles them as Tauri resources at build time.

Single-file profiles (existing):

  Profile 1 – Anime4K (legacy single-shader)  → Anime4K.glsl
    https://github.com/bloc97/Anime4K/releases
    (e.g. Anime4K_Upscale_CNN_x2_VL.glsl → rename to Anime4K.glsl)

  Profile 2 – FSR                              → FSR.glsl
    https://gist.github.com/agyild/82219984f27a34a9a5052b6399ca4c16

  Profile 3 – FSRCNNX                          → FSRCNNX.glsl
    https://github.com/igv/FSRCNN-TensorFlow/releases
    (e.g. FSRCNNX_16_0_8_1.glsl → rename to FSRCNNX.glsl)

  Profile 4 – KrigBilateral                    → KrigBilateral.glsl
    https://github.com/haasn/gentoo-conf/tree/master/home/nand/.config/mpv/shaders

  Profile 5 – RAVU                             → ravu.hook
    https://github.com/bjin/mpv-prescalers
    (e.g. ravu-lite-ar-r4.hook → rename to ravu.hook)

  Profile 6 – SSimSuperRes                     → SSimSuperRes.glsl
    https://github.com/igv/FSRCNN-TensorFlow (or mpv-prescalers)


Multi-file Anime4K v4 chains (Profiles 7–12, bound to Ctrl+1..6 by
default; Ctrl+0 disables — all are user-rebindable in Settings →
Keybindings):

  All files come from https://github.com/bloc97/Anime4K — the GLSL/
  directory. Drop them in here with their stock filenames (no rename).

  REQUIRED for ALL six modes:
    Anime4K_Clamp_Highlights.glsl
    Anime4K_Upscale_CNN_x2_VL.glsl
    Anime4K_AutoDownscalePre_x2.glsl
    Anime4K_AutoDownscalePre_x4.glsl
    Anime4K_Upscale_CNN_x2_M.glsl

  Profile 7  – Anime4K Mode A    (Ctrl+1)      → also needs:
    Anime4K_Restore_CNN_VL.glsl

  Profile 8  – Anime4K Mode B    (Ctrl+2)      → also needs:
    Anime4K_Restore_CNN_Soft_VL.glsl

  Profile 11 – Anime4K Mode C    (Ctrl+3)      → also needs:
    Anime4K_Restore_GAN_UL.glsl

  Profile 9  – Anime4K Mode A+A  (Ctrl+4)      → also needs:
    Anime4K_Restore_CNN_VL.glsl
    Anime4K_Restore_CNN_M.glsl

  Profile 10 – Anime4K Mode B+B  (Ctrl+5)      → also needs:
    Anime4K_Restore_CNN_Soft_VL.glsl
    Anime4K_Restore_CNN_Soft_M.glsl

  Profile 12 – Anime4K Mode C+C  (Ctrl+6)      → also needs:
    Anime4K_Restore_GAN_UL.glsl
    Anime4K_Restore_GAN_M.glsl


After placing files here, run: pnpm tauri build (or `pnpm tauri dev`
for live reload). Modes A / B / C / A+A / B+B / C+C match the
canonical Anime4K reference pipeline used by Stremio Community v5 and
the Anime4K MPV config — same chains, same visual output. The GAN-
based Mode C / C+C variants are the sharpest of the three single-
restore options on already-clean Blu-ray sources; the CNN variants
(A, B, doubles) are better choices for noisier compressed material.
The "None" profile needs no file; the others fail with a clear
"shader file not found" error naming the missing entry if any
required file is absent.
