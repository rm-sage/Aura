// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// aura_glass.glsl: "Real glass over video" for the player controls (opt-in,
// experimental; driven by mpv/glass.rs, written to disk as aura_glass_v3.glsl,
// so the option keys are `aura_glass_v3/...`). An mpv / libplacebo user shader
// on the OUTPUT stage:
// inside up to 4 rounded rectangles supplied at runtime it blurs the video,
// lifts it slightly in linear light (a lit material), holding bright areas
// down to a soft luminance cap, lifts its saturation and bends it like a lens
// near the rim.
// The webview then draws only the rim, shading and content on top.
//
// How it is driven (mpv/glass.rs + engine.rs; measured in glass_shader_tests.rs):
//   - loaded with `change-list glsl-shaders append <forward-slash path>`, LAST
//     in the list (after any upscaler chain);
//   - parameters set with ONE `change-list glsl-shader-opts add` per state
//     change, every key prefixed with this file's basename
//     (`aura_glass_v3/glass_n=2,aura_glass_v3/g0x=...`). mpv resets every parameter
//     to its default before applying the list, so always send the full set.
//   - all parameters are plain VARIABLE uniforms: a value change never
//     re-parses or recompiles the shader (but see the test notes: every
//     option change makes vo_gpu_next flush its frame-mixing cache).
//
// Coordinates: physical pixels relative to the top-left of the VISIBLE video
// rect (the OUTPUT texture is the clipped video destination rect, not the
// window: letterbox bars are drawn after this hook and cannot be covered).
//
// Cost: `glass_n = 0` skips every pass through WHEN (only the OUTPUT
// materialisation libplacebo does for any OUTPUT hook remains). With rects,
// a dual-Kawase pyramid (1/2 .. 1/16) feeds one full-resolution composite
// that does a single fetch outside the rects.
//
// Colour: OUTPUT is encoded in the TARGET transfer. `glass_pq = 1` means the
// target is PQ (HDR passthrough); otherwise a 2.2 power is assumed. The blur
// runs on encoded values (what CSS backdrop-filter does; PQ is near
// perceptual so highlights do not bloom); the dim, the luminance soft cap
// (on both transfers), the white lift and the saturation lift run in linear
// light.

//!PARAM glass_n
//!DESC Number of active rects (0 disables every pass)
//!TYPE int
//!MINIMUM 0
//!MAXIMUM 4
0

//!PARAM glass_ow
//!DESC Expected OUTPUT width in px; 0 = any. A mismatch (a video-mode screenshot) skips the glass
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM glass_dim
//!DESC Linear-light multiplier inside the glass
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
0.8

//!PARAM glass_blur
//!DESC Kawase tap offset scale (1 = default frost at 1x DPI; scale with the device pixel ratio)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 8.0
1.0

//!PARAM glass_refract
//!DESC Lens displacement at the rim, physical px; positive samples from inside the rect (magnifies inward), negative from beyond the edge
//!TYPE float
//!MINIMUM -400.0
//!MAXIMUM 400.0
14.0

//!PARAM glass_rim
//!DESC Width of the refracting band inside the edge, physical px
//!TYPE float
//!MINIMUM 0.5
//!MAXIMUM 400.0
22.0

//!PARAM glass_alpha
//!DESC Global opacity (the fade target when glass_fade_dur > 0)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
1.0

//!PARAM glass_fade_from
//!DESC Opacity at the start of an in-shader fade
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
1.0

//!PARAM glass_fade_t0
//!DESC Source PTS (s) the fade starts at
//!TYPE float
//!MINIMUM -1000000.0
//!MAXIMUM 100000000.0
0.0

//!PARAM glass_fade_dur
//!DESC Fade length in seconds of source PTS; 0 = no fade (glass_alpha applies at once). PTS stops while paused
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 60.0
0.0

//!PARAM glass_pq
//!DESC 1 when the output target is PQ (HDR passthrough)
//!TYPE int
//!MINIMUM 0
//!MAXIMUM 1
0

//!PARAM glass_gamma
//!DESC Non-PQ targets: the power law of the target transfer (2.2 sRGB-like, 2.4 for bt.1886)
//!TYPE float
//!MINIMUM 1.0
//!MAXIMUM 3.0
2.2

//!PARAM glass_white_nits
//!DESC PQ only: soft cap for the glass luminance (SDR reference white)
//!TYPE float
//!MINIMUM 1.0
//!MAXIMUM 10000.0
203.0

//!PARAM glass_cap
//!DESC Luminance soft cap inside the glass, relative to SDR white (PQ: x glass_white_nits); 1 = no cap on SDR
//!TYPE float
//!MINIMUM 0.01
//!MAXIMUM 1.0
1.0

//!PARAM glass_sat
//!DESC Saturation lift of the glass (CSS saturate())
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 3.0
1.0

//!PARAM glass_lift
//!DESC Additive white lift (a lit material), linear, relative to SDR white (PQ: x glass_white_nits), applied after the cap as l + lift * (white - l)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 0.25
0.0

//!PARAM PTS
//!DESC Filled by mpv every frame with the source frame PTS (fade clock)
//!TYPE float
0.0

//!PARAM g0x
//!DESC Rect 0 left edge, physical px from the video rect's left
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g0y
//!DESC Rect 0 top edge, physical px from the video rect's top
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g0w
//!DESC Rect 0 width, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g0h
//!DESC Rect 0 height, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g0r
//!DESC Rect 0 corner radius, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g0s
//!DESC Rect 0 strength 0..1 (blend of the glass over the video)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
1.0

//!PARAM g1x
//!DESC Rect 1 left edge, physical px from the video rect's left
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g1y
//!DESC Rect 1 top edge, physical px from the video rect's top
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g1w
//!DESC Rect 1 width, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g1h
//!DESC Rect 1 height, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g1r
//!DESC Rect 1 corner radius, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g1s
//!DESC Rect 1 strength 0..1 (blend of the glass over the video)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
1.0

//!PARAM g2x
//!DESC Rect 2 left edge, physical px from the video rect's left
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g2y
//!DESC Rect 2 top edge, physical px from the video rect's top
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g2w
//!DESC Rect 2 width, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g2h
//!DESC Rect 2 height, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g2r
//!DESC Rect 2 corner radius, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g2s
//!DESC Rect 2 strength 0..1 (blend of the glass over the video)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
1.0

//!PARAM g3x
//!DESC Rect 3 left edge, physical px from the video rect's left
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g3y
//!DESC Rect 3 top edge, physical px from the video rect's top
//!TYPE float
//!MINIMUM -100000.0
//!MAXIMUM 100000.0
0.0

//!PARAM g3w
//!DESC Rect 3 width, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g3h
//!DESC Rect 3 height, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g3r
//!DESC Rect 3 corner radius, physical px
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 100000.0
0.0

//!PARAM g3s
//!DESC Rect 3 strength 0..1 (blend of the glass over the video)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
1.0


//!HOOK OUTPUT
//!BIND HOOKED
//!SAVE AG_D1
//!WIDTH HOOKED.w 2 /
//!HEIGHT HOOKED.h 2 /
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass down2

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Dual-Kawase downsample: centre x4 plus four diagonal taps.
vec4 hook() {
    vec4 s = vec4(0.0);
    if (ag_near(HOOKED_pos * HOOKED_size)) {
        vec2 p = HOOKED_pos;
        vec2 d = HOOKED_pt * glass_blur;
        s = HOOKED_tex(p) * 4.0;
        s += HOOKED_tex(p - d);
        s += HOOKED_tex(p + d);
        s += HOOKED_tex(p + vec2(d.x, -d.y));
        s += HOOKED_tex(p - vec2(d.x, -d.y));
        s *= 0.125;
    }
    return s;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND AG_D1
//!SAVE AG_D2
//!WIDTH HOOKED.w 4 /
//!HEIGHT HOOKED.h 4 /
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass down4

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Dual-Kawase downsample: centre x4 plus four diagonal taps.
vec4 hook() {
    vec4 s = vec4(0.0);
    if (ag_near(HOOKED_pos * HOOKED_size)) {
        vec2 p = AG_D1_pos;
        vec2 d = AG_D1_pt * glass_blur;
        s = AG_D1_tex(p) * 4.0;
        s += AG_D1_tex(p - d);
        s += AG_D1_tex(p + d);
        s += AG_D1_tex(p + vec2(d.x, -d.y));
        s += AG_D1_tex(p - vec2(d.x, -d.y));
        s *= 0.125;
    }
    return s;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND AG_D2
//!SAVE AG_D3
//!WIDTH HOOKED.w 8 /
//!HEIGHT HOOKED.h 8 /
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass down8

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Dual-Kawase downsample: centre x4 plus four diagonal taps.
vec4 hook() {
    vec4 s = vec4(0.0);
    if (ag_near(HOOKED_pos * HOOKED_size)) {
        vec2 p = AG_D2_pos;
        vec2 d = AG_D2_pt * glass_blur;
        s = AG_D2_tex(p) * 4.0;
        s += AG_D2_tex(p - d);
        s += AG_D2_tex(p + d);
        s += AG_D2_tex(p + vec2(d.x, -d.y));
        s += AG_D2_tex(p - vec2(d.x, -d.y));
        s *= 0.125;
    }
    return s;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND AG_D3
//!SAVE AG_D4
//!WIDTH HOOKED.w 16 /
//!HEIGHT HOOKED.h 16 /
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass down16

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Dual-Kawase downsample: centre x4 plus four diagonal taps.
vec4 hook() {
    vec4 s = vec4(0.0);
    if (ag_near(HOOKED_pos * HOOKED_size)) {
        vec2 p = AG_D3_pos;
        vec2 d = AG_D3_pt * glass_blur;
        s = AG_D3_tex(p) * 4.0;
        s += AG_D3_tex(p - d);
        s += AG_D3_tex(p + d);
        s += AG_D3_tex(p + vec2(d.x, -d.y));
        s += AG_D3_tex(p - vec2(d.x, -d.y));
        s *= 0.125;
    }
    return s;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND AG_D4
//!SAVE AG_U3
//!WIDTH HOOKED.w 8 /
//!HEIGHT HOOKED.h 8 /
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass up8

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Dual-Kawase upsample: eight taps on a diamond, diagonals weighted x2.
vec4 hook() {
    vec4 s = vec4(0.0);
    if (ag_near(HOOKED_pos * HOOKED_size)) {
        vec2 p = AG_D4_pos;
        vec2 d = AG_D4_pt * glass_blur * 0.75;
        s = AG_D4_tex(p + vec2(-2.0 * d.x, 0.0));
        s += AG_D4_tex(p + vec2(-d.x, d.y)) * 2.0;
        s += AG_D4_tex(p + vec2(0.0, 2.0 * d.y));
        s += AG_D4_tex(p + vec2(d.x, d.y)) * 2.0;
        s += AG_D4_tex(p + vec2(2.0 * d.x, 0.0));
        s += AG_D4_tex(p + vec2(d.x, -d.y)) * 2.0;
        s += AG_D4_tex(p + vec2(0.0, -2.0 * d.y));
        s += AG_D4_tex(p + vec2(-d.x, -d.y)) * 2.0;
        s *= 1.0 / 12.0;
    }
    return s;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND AG_U3
//!SAVE AG_U2
//!WIDTH HOOKED.w 4 /
//!HEIGHT HOOKED.h 4 /
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass up4

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Dual-Kawase upsample: eight taps on a diamond, diagonals weighted x2.
vec4 hook() {
    vec4 s = vec4(0.0);
    if (ag_near(HOOKED_pos * HOOKED_size)) {
        vec2 p = AG_U3_pos;
        vec2 d = AG_U3_pt * glass_blur * 0.75;
        s = AG_U3_tex(p + vec2(-2.0 * d.x, 0.0));
        s += AG_U3_tex(p + vec2(-d.x, d.y)) * 2.0;
        s += AG_U3_tex(p + vec2(0.0, 2.0 * d.y));
        s += AG_U3_tex(p + vec2(d.x, d.y)) * 2.0;
        s += AG_U3_tex(p + vec2(2.0 * d.x, 0.0));
        s += AG_U3_tex(p + vec2(d.x, -d.y)) * 2.0;
        s += AG_U3_tex(p + vec2(0.0, -2.0 * d.y));
        s += AG_U3_tex(p + vec2(-d.x, -d.y)) * 2.0;
        s *= 1.0 / 12.0;
    }
    return s;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND AG_U2
//!SAVE AG_U1
//!WIDTH HOOKED.w 2 /
//!HEIGHT HOOKED.h 2 /
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass up2

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Dual-Kawase upsample: eight taps on a diamond, diagonals weighted x2.
vec4 hook() {
    vec4 s = vec4(0.0);
    if (ag_near(HOOKED_pos * HOOKED_size)) {
        vec2 p = AG_U2_pos;
        vec2 d = AG_U2_pt * glass_blur * 0.75;
        s = AG_U2_tex(p + vec2(-2.0 * d.x, 0.0));
        s += AG_U2_tex(p + vec2(-d.x, d.y)) * 2.0;
        s += AG_U2_tex(p + vec2(0.0, 2.0 * d.y));
        s += AG_U2_tex(p + vec2(d.x, d.y)) * 2.0;
        s += AG_U2_tex(p + vec2(2.0 * d.x, 0.0));
        s += AG_U2_tex(p + vec2(d.x, -d.y)) * 2.0;
        s += AG_U2_tex(p + vec2(0.0, -2.0 * d.y));
        s += AG_U2_tex(p + vec2(-d.x, -d.y)) * 2.0;
        s *= 1.0 / 12.0;
    }
    return s;
}

//!HOOK OUTPUT
//!BIND HOOKED
//!BIND AG_U1
//!WHEN glass_n 0 > glass_ow 0 = HOOKED.w glass_ow = + *
//!DESC aura glass composite

// No loops, no early returns inside helpers: the D3D11 path translates
// GLSL -> SPIR-V -> HLSL and FXC rejected a loop-with-break version
// ("temp not initialized"), which makes libplacebo disable the hook.
bool ag_in(vec2 px, vec4 r, float m) {
    return px.x >= r.x - m && px.y >= r.y - m &&
           px.x <= r.x + r.z + m && px.y <= r.y + r.w + m;
}

// True when the full-resolution pixel px lies within margin m of any active
// rect. Pyramid texels far from every rect are never read, so they early-out.
bool ag_near(vec2 px) {
    float m = abs(glass_refract) + 96.0 * glass_blur + 8.0;
    bool hit = glass_n > 0 && ag_in(px, vec4(g0x, g0y, g0w, g0h), m);
    hit = hit || (glass_n > 1 && ag_in(px, vec4(g1x, g1y, g1w, g1h), m));
    hit = hit || (glass_n > 2 && ag_in(px, vec4(g2x, g2y, g2w, g2h), m));
    hit = hit || (glass_n > 3 && ag_in(px, vec4(g3x, g3y, g3w, g3h), m));
    return hit;
}

// Signed distance to a rounded box (centre c, half size b, radius r):
// negative inside, positive outside, in px.
float ag_sd(vec2 p, vec2 c, vec2 b, float r) {
    vec2 q = abs(p - c) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

// SMPTE ST 2084, normalised so 1.0 = 10000 nits.
const float PQ_M1 = 0.1593017578125;
const float PQ_M2 = 78.84375;
const float PQ_C1 = 0.8359375;
const float PQ_C2 = 18.8515625;
const float PQ_C3 = 18.6875;

vec3 ag_pq_eotf(vec3 e) {
    vec3 p = pow(clamp(e, 0.0, 1.0), vec3(1.0 / PQ_M2));
    return pow(max(p - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * p), vec3(1.0 / PQ_M1));
}

vec3 ag_pq_oetf(vec3 l) {
    vec3 p = pow(clamp(l, 0.0, 1.0), vec3(PQ_M1));
    return pow((PQ_C1 + PQ_C2 * p) / (1.0 + PQ_C3 * p), vec3(PQ_M2));
}

// Monotonic luminance soft cap at w (linear): untouched below 0.7 w, then an
// exponential knee that approaches w and never inverts tones.
vec3 ag_cap(vec3 l, vec3 kY, float w) {
    float y = dot(l, kY);
    float k = 0.7 * w;
    float y2 = y > k ? k + (w - k) * (1.0 - exp(-(y - k) / (w - k))) : y;
    l *= y > 1e-6 ? y2 / y : 1.0;
    return l;
}

vec3 ag_sat(vec3 l, vec3 kY) {
    float y = dot(l, kY);
    return max(mix(vec3(y), l, glass_sat), 0.0);
}

// The lit-material lift: move every channel a fixed share of the way toward
// white (linear). Bounded: white ends at cap + lift * (white - cap).
vec3 ag_lift(vec3 l, float white) {
    return l + glass_lift * max(vec3(white) - l, 0.0);
}

// Dim (1.0 passes through), then soft-cap the luminance so a BRIGHT backdrop
// is held near glass_cap of SDR white (white text keeps its contrast), then a
// small white lift so a dark or mid backdrop passes near its own level and
// reads as a lit pane, then the saturation lift (after the neutral lift, so
// the lift never washes the colour out).
vec3 ag_tint(vec3 e) {
    vec3 res;
    if (glass_pq != 0) {
        vec3 kY = vec3(0.2627, 0.6780, 0.0593);
        vec3 l = ag_pq_eotf(e) * (10000.0 * glass_dim);
        l = ag_cap(l, kY, glass_white_nits * glass_cap);
        l = ag_sat(ag_lift(l, glass_white_nits), kY);
        res = ag_pq_oetf(l / 10000.0);
    } else {
        vec3 kY = vec3(0.2126, 0.7152, 0.0722);
        vec3 l = pow(max(e, 0.0), vec3(glass_gamma)) * glass_dim;
        if (glass_cap < 1.0) l = ag_cap(l, kY, glass_cap);
        l = ag_sat(ag_lift(l, 1.0), kY);
        res = pow(min(l, vec3(1.0)), vec3(1.0 / glass_gamma));
    }
    return res;
}

// PTS is SOURCE time, so a seek moves it arbitrarily. A frame more than
// 0.5 s before the fade start can only come from a backward seek: treat the
// fade as finished (glass_alpha) instead of snapping back to glass_fade_from,
// which would hide the glass under visible controls after a seek-back.
float ag_alpha() {
    float t = 1.0;
    if (glass_fade_dur > 0.0 && PTS >= glass_fade_t0 - 0.5)
        t = clamp((PTS - glass_fade_t0) / glass_fade_dur, 0.0, 1.0);
    return mix(glass_fade_from, glass_alpha, t);
}

// One rect: rounded-box SDF, 1 px anti-aliased coverage, lens displacement
// concentrated in the glass_rim band and fading to neutral further in.
vec3 ag_apply(vec3 col, vec2 px, vec4 r, float radius, float s, float a) {
    vec2 b = 0.5 * max(r.zw, vec2(0.0));
    vec2 c = r.xy + b;
    float bmin = min(b.x, b.y);
    float rad = clamp(radius, 0.0, bmin);
    float d = ag_sd(px, c, b, rad);
    float cov = clamp(0.5 - d, 0.0, 1.0) * step(0.5, bmin);
    if (cov > 0.0) {
        // The band never reaches past the centre line: on a rect thinner
        // than two rims the normal flips there, and a non-zero displacement
        // would show as a seam.
        float rim = min(glass_rim, bmin);
        float pr = 1.0 - clamp(-d / rim, 0.0, 1.0);
        pr *= pr;
        // Outward normal from an inner rounded box whose radius is at least
        // the rim width, so the normal field is continuous wherever pr > 0.
        float rn = min(max(rad, glass_rim), bmin);
        vec2 rel = px - c;
        vec2 q = abs(rel) - b + rn;
        vec2 qn = max(q, 0.0);
        float ql = length(qn);
        vec2 n = ql > 1e-4 ? qn / ql : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
        n *= vec2(rel.x < 0.0 ? -1.0 : 1.0, rel.y < 0.0 ? -1.0 : 1.0);
        // Pull the sample inward: the rim magnifies what lies just inside it.
        vec2 sp = px - n * (glass_refract * pr * s);
        vec3 g = ag_tint(AG_U1_tex(sp / HOOKED_size).rgb);
        col = mix(col, g, cov * s * a);
    }
    return col;
}

vec4 hook() {
    vec4 orig = HOOKED_tex(HOOKED_pos);
    float a = ag_alpha();
    vec3 col = orig.rgb;
    if (a > 0.0) {
        vec2 px = HOOKED_pos * HOOKED_size;
        if (glass_n > 0) col = ag_apply(col, px, vec4(g0x, g0y, g0w, g0h), g0r, g0s, a);
        if (glass_n > 1) col = ag_apply(col, px, vec4(g1x, g1y, g1w, g1h), g1r, g1s, a);
        if (glass_n > 2) col = ag_apply(col, px, vec4(g2x, g2y, g2w, g2h), g2r, g2s, a);
        if (glass_n > 3) col = ag_apply(col, px, vec4(g3x, g3y, g3w, g3h), g3r, g3s, a);
    }
    return vec4(col, orig.a);
}
