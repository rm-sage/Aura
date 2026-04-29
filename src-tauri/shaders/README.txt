Place upscaling shader files here with THESE EXACT filenames.
Aura bundles them as Tauri resources at build time.

  Profile 1 – Anime4K       → Anime4K.glsl
    https://github.com/bloc97/Anime4K/releases
    (e.g. Anime4K_Upscale_CNN_x2_VL.glsl → rename to Anime4K.glsl)

  Profile 2 – FSR            → FSR.glsl
    https://gist.github.com/agyild/82219984f27a34a9a5052b6399ca4c16

  Profile 3 – FSRCNNX        → FSRCNNX.glsl
    https://github.com/igv/FSRCNN-TensorFlow/releases
    (e.g. FSRCNNX_16_0_8_1.glsl → rename to FSRCNNX.glsl)

  Profile 4 – KrigBilateral  → KrigBilateral.glsl
    https://github.com/haasn/gentoo-conf/tree/master/home/nand/.config/mpv/shaders

  Profile 5 – RAVU           → ravu.hook
    https://github.com/bjin/mpv-prescalers
    (e.g. ravu-lite-ar-r4.hook → rename to ravu.hook)

  Profile 6 – SSimSuperRes   → SSimSuperRes.glsl
    https://github.com/igv/FSRCNN-TensorFlow (or mpv-prescalers)

After placing files here, run: pnpm tauri build
The "None" profile needs no file.
