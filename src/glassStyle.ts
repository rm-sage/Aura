// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// glassStyle.ts: which glass material the app draws, as one attribute on <html>.
//
//   <html data-glass="frosted" | "liquid">   the material App.css draws
//   <html data-glass-glint-mode="on" | "off">  the cursor glint (src/glassGlint.ts)
//
// The root attribute is deliberately NOT `data-glass-glint`: that one is the
// per-element opt-in the glint matches with closest(), and <html> carrying it
// made every non-glass pointer target resolve to the document root.
//
// The choice lives in AuraSettings (`glassStyle`, `glassCursorGlow`): per scope,
// cloud-synced and portable like the rest of the blob. What is DRAWN can differ
// from what is chosen, and only here:
//
//   - Hardware acceleration off: Liquid falls back to Frosted. An SVG displacement
//     filter inside backdrop-filter on software rendering costs whole frames. The
//     flag is read ONCE at startup, because the WebView2 GPU state only changes on
//     a restart (the Settings row says so); a later toggle must not swap the look
//     of a session whose renderer has not changed. The last answer is remembered
//     in localStorage (machine-local) so the synchronous first stamp is right.
//   - Zero-blur themes (--ln-blur-elev: 0px, today midnight / contrast /
//     contrast-azure): the attribute stays as chosen, App.css keeps their opaque
//     fill, and the refraction binder (liquidGlass.ts) stands down, since there is
//     no backdrop pass to bend.
//   - High Contrast themes set `--lg-glint-off: 1` in App.css: no glint there.
//
// No theme id is named in this file (the valid set lives in ThemeEngine.tsx): both
// theme facts are read back from the computed root style when data-theme changes.

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadAuraSettings } from "./auraSettings";

export type GlassStyle = "frosted" | "liquid";

export interface GlassState {
  /** The material the user chose. */
  chosen: GlassStyle;
  /** The material actually drawn (Liquid falls back to Frosted with no GPU). */
  style: GlassStyle;
  /** WebView2 was launched without hardware acceleration. */
  gpuOff: boolean;
  /** The theme has no backdrop blur (opaque glass, nothing to refract). */
  zeroBlurTheme: boolean;
  /** The cursor glint should draw (setting on, theme allows it). */
  glint: boolean;
  /** High Contrast theme: player surfaces keep the solid fill and real glass
   *  never draws (realGlass.ts reads the same `--lg-glint-off` fact). */
  contrastFloor: boolean;
}

/** The last gpu_acceleration answer, remembered per machine so the synchronous
 *  first stamp (before the backend replies) already draws the right material:
 *  without it a GPU-off machine painted Liquid and built filters on software
 *  rendering for a moment at every launch. Machine-local, never synced. */
const GPU_OFF_KEY = "aura-glass-gpu-off";

function readRememberedGpuOff(): boolean {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(GPU_OFF_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberGpuOff(off: boolean): void {
  try {
    if (off) localStorage.setItem(GPU_OFF_KEY, "1");
    else localStorage.removeItem(GPU_OFF_KEY);
  } catch { /* storage blocked: the next launch just stamps late again */ }
}

let gpuOff = readRememberedGpuOff();
let themeFacts = { zeroBlur: false, glintOff: false };
let state: GlassState = computeState();
const listeners = new Set<() => void>();

function readThemeFacts(): { zeroBlur: boolean; glintOff: boolean } {
  if (typeof document === "undefined") return { zeroBlur: false, glintOff: false };
  const cs = getComputedStyle(document.documentElement);
  const blur = parseFloat(cs.getPropertyValue("--ln-blur-elev"));
  return {
    zeroBlur: Number.isFinite(blur) && blur <= 0,
    glintOff: cs.getPropertyValue("--lg-glint-off").trim() === "1",
  };
}

function computeState(): GlassState {
  const s = loadAuraSettings();
  const chosen: GlassStyle = s.glassStyle === "liquid" ? "liquid" : "frosted";
  const style: GlassStyle = chosen === "liquid" && !gpuOff ? "liquid" : "frosted";
  return {
    chosen,
    style,
    gpuOff,
    zeroBlurTheme: themeFacts.zeroBlur,
    glint: s.glassCursorGlow !== false && !themeFacts.glintOff,
    contrastFloor: themeFacts.glintOff,
  };
}

function sameState(a: GlassState, b: GlassState): boolean {
  return a.chosen === b.chosen && a.style === b.style && a.gpuOff === b.gpuOff
    && a.zeroBlurTheme === b.zeroBlurTheme && a.glint === b.glint
    && a.contrastFloor === b.contrastFloor;
}

function writeAttributes(s: GlassState): void {
  const root = document.documentElement;
  if (root.getAttribute("data-glass") !== s.style) root.setAttribute("data-glass", s.style);
  const g = s.glint ? "on" : "off";
  if (root.getAttribute("data-glass-glint-mode") !== g) root.setAttribute("data-glass-glint-mode", g);
  // Hardware acceleration, for CSS: off drops the rim light's chromatic
  // dispersion (App.css --lg-disp) and real-frost badges fall back to faux
  // frost (Home cards). glassGlint.ts reads gpuOff from the state directly.
  const gpu = s.gpuOff ? "off" : "on";
  if (root.getAttribute("data-glass-gpu") !== gpu) root.setAttribute("data-glass-gpu", gpu);
}

function refresh(): void {
  const next = computeState();
  writeAttributes(next);
  if (sameState(next, state)) return;
  state = next;
  for (const l of listeners) l();
}

/** Synchronous first stamp, before React mounts, so the first frame already
 *  draws the chosen material (main.tsx). Safe to call again. */
export function applyGlassAttributes(): void {
  if (typeof document === "undefined") return;
  themeFacts = readThemeFacts();
  state = computeState();
  writeAttributes(state);
}

export function getGlassState(): GlassState {
  return state;
}

export function subscribeGlass(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The id App.css names in the Liquid backdrop chains of glass that page
 *  content can move under (`blur(...) url(#aura-glass-base) ...`): the menu
 *  tier and `.aura-glass-control[data-glass-base]`. Never Frosted, never
 *  chrome (side pills, nav pill), where it only replaced the real Mica with
 *  the darker estimate. */
export const GLASS_BASE_FILTER_ID = "aura-glass-base";

/** The solid base UNDER the blur of Liquid glass over page content, as an SVG filter: floods
 *  the window backdrop estimate (`--lg-base-under`, normally `--lg-window-est`),
 *  then the theme's page colour (`--lg-base-page`, normally `--ln-bg`) over it,
 *  then merges the blurred backdrop on top, so the backdrop pass comes out
 *  opaque. Both tokens go transparent under `html.playing-video` (App.css):
 *  over the mpv video the base would hide the picture.
 *
 *  Why a filter and not a background. The window is transparent, and Chromium
 *  draws a backdrop-filter's result OVER the unfiltered content behind the
 *  element. Wherever the page is see-through (Mica's --ln-bg is transparent,
 *  Haze's is alpha 0.45), a blurred result that is itself see-through let the
 *  CRISP page show through it: poster titles read sharp through the Home
 *  search bar while the opaque posters blurred. Only an opaque filtered result
 *  replaces those pixels, and a CSS background paints ABOVE the filter output,
 *  so it would hide the blurred posters too. The base must be inside the
 *  backdrop filter. Size independent, so one element serves every surface;
 *  the colours resolve through CSS `flood-color: var(...)` on the in-DOM
 *  filter, and Chromium repaints every referencing backdrop when they change
 *  (measured, bound and unbound), so a theme change needs no rebuild and the
 *  filter registry is not keyed by theme. liquidGlass.ts bakes the same two
 *  floods into its per-size filters (bound and unbound match). Installed
 *  here, before React mounts, whatever the material (an unreferenced filter
 *  costs nothing, and a material switch needs no install). Without it the
 *  url() step is skipped and the chain falls back to the old see-through
 *  blur (measured), never to no backdrop. */
function installGlassBaseFilter(): () => void {
  if (typeof document === "undefined" || !document.body) return () => {};
  if (document.getElementById(GLASS_BASE_FILTER_ID)) return () => {};
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none");
  const f = document.createElementNS(NS, "filter");
  f.setAttribute("id", GLASS_BASE_FILTER_ID);
  f.setAttribute("color-interpolation-filters", "sRGB");
  for (const n of glassBaseNodes("SourceGraphic", "base")) f.append(n);
  // The menu tier's tone map (see GLASS_MENU_TONE_FILTER_ID), same svg.
  const tone = document.createElementNS(NS, "filter");
  tone.setAttribute("id", GLASS_MENU_TONE_FILTER_ID);
  tone.setAttribute("color-interpolation-filters", "sRGB");
  const t = glassToneNodes("SourceGraphic", "tone", IDENTITY_GAIN);
  menuToneFuncs = t.funcs;
  tone.append(...t.nodes);
  syncMenuToneFilter();
  svg.append(f, tone);
  document.body.append(svg);
  return () => { svg.remove(); menuToneFuncs = []; };
}

/** The id App.css names in the Liquid menu tier's backdrop chain, after the
 *  brightness (`--lg-menu-tone-step`, normally `url(#aura-glass-menu-tone)`):
 *  a tone map on LUMINANCE that keeps the hue (glassToneNodes). It makes the
 *  menu body one translucent material: a steep response over dark and mid
 *  backdrops, so their colour shows through the way it used to show only in
 *  the caustic band along the edge, and a soft cap over bright ones, so white
 *  text keeps its contrast over a white poster. liquidGlass.ts bakes the same
 *  map into the bound lens at the same point, so bound and unbound match.
 *  `--lg-menu-tone: none` writes an identity map here and no step in the
 *  lens (the darker variant, App.css). */
export const GLASS_MENU_TONE_FILTER_ID = "aura-glass-menu-tone";
/** The gain table holds gain / TONE_GAIN_K (the multiply step scales it back),
 *  so the map can lift a dark backdrop as well as cap a bright one. */
const TONE_GAIN_K = 2;
const IDENTITY_GAIN = String(1 / TONE_GAIN_K) + " " + String(1 / TONE_GAIN_K);
let menuToneFuncs: SVGElement[] = [];

/** A `--lg-<tier>-tone` token, `<slope> <cap>`, as the gain table of
 *  glassToneNodes, or null for `none`, empty or invalid. The curve is
 *  T(y) = cap * (1 - exp(-slope * y / cap)) on luma y in [0, 1]: `slope` at
 *  black (at most TONE_GAIN_K), approaching `cap` over white. Gain =
 *  T(y) / y, sampled at 17 knots and stored divided by TONE_GAIN_K. */
export function readToneTable(cs: CSSStyleDeclaration, name: string): string | null {
  const raw = cs.getPropertyValue(name).trim();
  if (!raw || raw === "none") return null;
  const [slope, cap] = raw.split(/[\s,]+/).map(Number);
  if (!(slope > 0 && slope <= TONE_GAIN_K && cap > 0 && cap <= 1)) return null;
  const out: string[] = [];
  for (let i = 0; i <= 16; i++) {
    const y = i / 16;
    const g = y === 0 ? slope : (cap * (1 - Math.exp((-slope * y) / cap))) / y;
    out.push(String(+Math.min(1, g / TONE_GAIN_K).toFixed(4)));
  }
  return out.join(" ");
}

/** The tone map's primitives: luma into all three channels (alpha 1), a
 *  per-luma gain from `table` (the feFuncR/G/B returned as `funcs`, so the
 *  CSS face's node can be retuned in place), and the input multiplied by it
 *  times TONE_GAIN_K. The arithmetic multiply scales alpha by TONE_GAIN_K
 *  too, so it runs on an OPAQUE copy of the input and the input's own alpha
 *  is put back after (`in`): a see-through input keeps its alpha. Over the
 *  mpv video the base goes transparent, and a multiply on the input itself
 *  doubled the alpha of any half-clear layer behind a menu (measured, the
 *  panel over the video: over a black 0.4 layer alpha 0.95 against 0.85
 *  with no tone step, over a white 0.3 layer a darker grey, 41 at 0.89
 *  against 56 at 0.80; now 0.85 and 0.80). Opaque input is pixel-identical.
 *  Scaling
 *  RGB by one gain keeps the hue and the relative saturation, where a
 *  per-channel curve near its cap would grey out a bright colour. */
export function glassToneNodes(input: string, result: string, table: string): { nodes: SVGElement[]; funcs: SVGElement[] } {
  const NS = "http://www.w3.org/2000/svg";
  const luma = document.createElementNS(NS, "feColorMatrix");
  luma.setAttribute("in", input);
  luma.setAttribute("type", "matrix");
  const y = "0.299 0.587 0.114 0 0";
  luma.setAttribute("values", `${y}  ${y}  ${y}  0 0 0 0 1`);
  luma.setAttribute("result", `${result}-y`);
  const ct = document.createElementNS(NS, "feComponentTransfer");
  ct.setAttribute("in", `${result}-y`);
  ct.setAttribute("result", `${result}-g`);
  const funcs = (["feFuncR", "feFuncG", "feFuncB"] as const).map((ch) => {
    const fn = document.createElementNS(NS, ch);
    fn.setAttribute("type", "table");
    fn.setAttribute("tableValues", table);
    ct.append(fn);
    return fn;
  });
  const opaque = document.createElementNS(NS, "feColorMatrix");
  opaque.setAttribute("in", input);
  opaque.setAttribute("type", "matrix");
  opaque.setAttribute("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1");
  opaque.setAttribute("result", `${result}-o`);
  const mul = document.createElementNS(NS, "feComposite");
  mul.setAttribute("in", `${result}-o`);
  mul.setAttribute("in2", `${result}-g`);
  mul.setAttribute("operator", "arithmetic");
  mul.setAttribute("k1", String(TONE_GAIN_K));
  mul.setAttribute("result", `${result}-m`);
  const keepAlpha = document.createElementNS(NS, "feComposite");
  keepAlpha.setAttribute("in", `${result}-m`);
  keepAlpha.setAttribute("in2", input);
  keepAlpha.setAttribute("operator", "in");
  keepAlpha.setAttribute("result", result);
  return { nodes: [luma, ct, opaque, mul, keepAlpha], funcs };
}

/** Writes the `--lg-menu-tone` token into the CSS face's tone filter (read
 *  from :root, so App.css must be applied). Called at install and by
 *  liquidGlass.ts on every (re)activation, so a live retune reaches both. */
export function syncMenuToneFilter(): void {
  if (typeof document === "undefined" || !menuToneFuncs.length) return;
  const table = readToneTable(getComputedStyle(document.documentElement), "--lg-menu-tone") ?? IDENTITY_GAIN;
  for (const fn of menuToneFuncs) fn.setAttribute("tableValues", table);
}

/** The base's filter primitives: two floods (window estimate, then the page
 *  colour) and a merge with `input` on top, as `result`. Shared with
 *  liquidGlass.ts makeFilter, so the bound lens and the CSS face stack the
 *  same base. */
export function glassBaseNodes(input: string, result: string): SVGElement[] {
  const NS = "http://www.w3.org/2000/svg";
  const flood = (color: string, res: string) => {
    const n = document.createElementNS(NS, "feFlood");
    n.setAttribute("style", `flood-color: ${color}`);
    n.setAttribute("result", res);
    return n;
  };
  const merge = document.createElementNS(NS, "feMerge");
  merge.setAttribute("result", result);
  for (const src of [`${result}-w`, `${result}-p`, input]) {
    const m = document.createElementNS(NS, "feMergeNode");
    m.setAttribute("in", src);
    merge.append(m);
  }
  return [flood("var(--lg-base-under, #202020)", `${result}-w`), flood("var(--lg-base-page, transparent)", `${result}-p`), merge];
}

/** Installs the live wiring: settings changes, theme changes and the one-off
 *  GPU read. Returns the cleanup. */
export function installGlassStyle(): () => void {
  applyGlassAttributes();
  const removeBase = installGlassBaseFilter();
  let disposed = false;

  const onSettings = () => refresh();
  window.addEventListener("aura:settings-changed", onSettings);

  // data-theme flips (ThemeEngine) change the two theme facts. Reading them back
  // needs the new theme's tokens, which the attribute write has already applied.
  const mo = new MutationObserver(() => {
    const next = readThemeFacts();
    if (next.zeroBlur === themeFacts.zeroBlur && next.glintOff === themeFacts.glintOff) return;
    themeFacts = next;
    refresh();
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  invoke<{ gpu_acceleration?: boolean }>("get_settings")
    .then((s) => {
      if (disposed) return;
      const off = s?.gpu_acceleration === false;
      rememberGpuOff(off);
      if (off === gpuOff) return;
      gpuOff = off;
      refresh();
    })
    .catch(() => { /* no backend (plain vite dev): assume the GPU is on */ });

  return () => {
    disposed = true;
    removeBase();
    window.removeEventListener("aura:settings-changed", onSettings);
    mo.disconnect();
  };
}

/** The whole glass state, for components that render per material. */
export function useGlassState(): GlassState {
  return useSyncExternalStore(subscribeGlass, getGlassState, getGlassState);
}

/** The material actually drawn. */
export function useGlassStyle(): GlassStyle {
  return useSyncExternalStore(subscribeGlass, () => state.style, () => state.style);
}

/** True while Liquid is drawn and the theme can refract (springs and lenses). */
export function liquidActive(): boolean {
  return state.style === "liquid";
}

/** The Aura reduced-motion gate (OS pref or the Settings override). */
export function reducedMotionActive(): boolean {
  return typeof document !== "undefined"
    && document.documentElement.getAttribute("data-reduced-motion") === "true";
}
