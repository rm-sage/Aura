// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// cardGlow.ts: the HOVERED catalog card's art-tinted underglow (round 9, the
// A direction; frontend-ui.md "The Home cards").
//
// The hero's underglow (heroAmbient.ts underglowImage) at 0.6 scale: a
// contact shadow in the art's raw middle x 0.22 (alpha 0.55) plus a faint
// halo in its vivid centre (alpha 0.22), ONE dithered image. It replaces the
// hovered card's old `drop-shadow(0 6px 22px)` filter, which banded like any
// other 8-bit soft gradient and made the card a backdrop root.
//
// Only the hovered card gets it, and nothing is per card at rest:
//   - each glow host (a row's <section data-card-glow-host>) renders two empty
//     slots (`.aura-card-glow`, its first children, so they paint UNDER every
//     card in the row: the halo shows in the gaps and around the row, never
//     over a neighbour's art); the two crossfade when the glow moves between
//     cards;
//   - ONE delegated `pointerover` listener on the document (no React state, no
//     per-card handler); a card counts after HOVER_DELAY_MS, so sweeping the
//     pointer across a row reads nothing;
//   - the colours come from heroPalette (the proxied art, CORS-readable, LRU
//     shared with the hero); art that is not proxied gets a neutral contact
//     shadow only;
//   - images are cached by (size, colours, room) in a small LRU of blob urls,
//     released on eviction.
// A card outside any host (the Airing page, the View-all popup) keeps the old
// drop-shadow (CSS). High Contrast and the player hide the slots.

import { getGlassState } from "./glassStyle";
import { heroPalette, isReadableArt, peekHeroPalette, underglowImage, UNDERGLOW_PAD, type RGB } from "./heroAmbient";
import { releaseSvgImage } from "./glassGlint";

const CARD = "[data-card-glow]";
const ART = "[data-card-art]";
const HOST = "[data-card-glow-host]";
const SLOT = ":scope > .aura-card-glow";
/** A card counts as hovered once the pointer has rested on it this long. */
const HOVER_DELAY_MS = 90;
/** The card's hovered scale (`.card-grow:hover`): the glow is laid out for it. */
const HOVER_SCALE = 1.02;
/** The hero underglow's geometry, scaled to a card. */
const K = 0.6;
const PAD = Math.round(UNDERGLOW_PAD * K);
const SHADOW_A = 0.55;
const HALO_A = 0.22;
const IMAGE_CAP = 12;

interface Shown { card: HTMLElement; slot: HTMLElement; css: string }

export function installCardGlow(): () => void {
  if (typeof document === "undefined") return () => {};
  const root = document.documentElement;
  const images = new Map<string, string>();
  let shown: Shown | null = null;
  let pending: HTMLElement | null = null;
  let deferred: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0;
  const clipOf = new WeakMap<HTMLElement, HTMLElement | null>();

  // High Contrast is read from the computed theme fact (--lg-glint-off via
  // glassStyle.ts), never by theme id.
  const off = () =>
    root.classList.contains("playing-video") || getGlassState().contrastFloor;

  const imageFor = (key: string, make: () => string): string => {
    const hit = images.get(key);
    if (hit) {
      images.delete(key);
      images.set(key, hit);
      return hit;
    }
    const css = make();
    images.set(key, css);
    while (images.size > IMAGE_CAP) {
      const [k, v] = images.entries().next().value as [string, string];
      images.delete(k);
      // Never revoke the image a slot still shows (it is re-added on use).
      if (shown?.css !== v) releaseSvgImage(v);
    }
    return css;
  };

  /** The nearest ancestor that clips horizontally (the page scroller). */
  const clipBox = (host: HTMLElement): HTMLElement | null => {
    if (clipOf.has(host)) return clipOf.get(host) ?? null;
    let el = host.parentElement;
    while (el && el !== document.body) {
      const o = getComputedStyle(el).overflowX;
      if (o !== "visible" && o !== "clip") break;
      el = el.parentElement;
    }
    const c = el && el !== document.body ? el : null;
    clipOf.set(host, c);
    return c;
  };

  const hide = () => {
    gen++;
    if (shown) shown.slot.classList.remove("is-on");
    shown = null;
  };

  const place = (card: HTMLElement, pal: { raw: RGB; center: RGB } | null) => {
    const host = card.closest<HTMLElement>(HOST);
    const art = card.querySelector<HTMLElement>(ART);
    if (!host || !art || !card.isConnected) return;
    const slots = host.querySelectorAll<HTMLElement>(SLOT);
    if (slots.length === 0) return;
    // Geometry at the hovered scale, whatever the scale is mid-transition: the
    // card scales about its centre, which the transform does not move.
    const cr = card.getBoundingClientRect();
    const s = card.offsetWidth > 0 ? cr.width / card.offsetWidth : 1;
    if (!(s > 0)) return;
    const ar = art.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const lx = (ar.left - cr.left) / s - card.offsetWidth / 2;
    const ly = (ar.top - cr.top) / s - card.offsetHeight / 2;
    const w = art.offsetWidth * HOVER_SCALE, h = art.offsetHeight * HOVER_SCALE;
    const x0 = cx + lx * HOVER_SCALE, y0 = cy + ly * HOVER_SCALE;
    if (!(w > 4 && h > 4)) return;
    // Room to the clip box on the sides (the halo fades there instead of
    // being cut); top and bottom are cut by the viewport like the content.
    const clip = clipBox(host)?.getBoundingClientRect();
    const left = Math.max(0, Math.min(PAD, clip ? x0 - clip.left : PAD));
    const right = Math.max(0, Math.min(PAD, clip ? clip.right - (x0 + w) : PAD));
    const shadow: RGB = pal ? pal.raw.map((v) => Math.round(v * 0.22)) as RGB : [0, 0, 0];
    const halo: RGB = pal ? pal.center : [0, 0, 0];
    const aH = pal ? HALO_A : 0;
    const W = Math.round(w), H = Math.round(h), L = Math.round(left), R = Math.round(right);
    const key = `${W}x${H}|${L}|${R}|${shadow.join(",")}|${halo.join(",")}|${aH}`;
    const css = imageFor(key, () => underglowImage({
      w: W, h: H, left: L, right: R, top: PAD, bottom: PAD,
      shadow, halo, aS: SHADOW_A, aH, scale: K,
    }));
    if (css === "none") return;
    const hr = host.getBoundingClientRect();
    // Alternate the two slots so a move between cards crossfades.
    const slot = shown && shown.slot === slots[0] && slots[1] ? slots[1] : slots[0];
    if (shown && shown.slot !== slot) shown.slot.classList.remove("is-on");
    const st = slot.style;
    st.left = `${Math.round(x0 - hr.left - L)}px`;
    st.top = `${Math.round(y0 - hr.top - PAD)}px`;
    st.width = `${L + W + R}px`;
    st.height = `${PAD + H + PAD}px`;
    st.backgroundImage = css;
    slot.classList.add("is-on");
    shown = { card, slot, css };
  };

  const show = (card: HTMLElement) => {
    if (off()) return;
    const my = ++gen;
    const img = card.querySelector<HTMLImageElement>(`${ART} img`);
    const url = img ? img.currentSrc || img.src : null;
    if (!isReadableArt(url)) { place(card, null); return; }
    const hit = peekHeroPalette(url);
    if (hit) { place(card, hit); return; }
    void heroPalette(url).then((p) => {
      if (my !== gen || !card.matches(":hover")) return;
      place(card, p);
    });
  };

  const consider = (card: HTMLElement | null) => {
    if (card === pending) return;
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    pending = card;
    deferred = null;
    if (shown && shown.card !== card) hide();
    if (!card || shown?.card === card) return;
    // A scroll carrying cards under a still pointer is not a hover (the
    // `.card-grow` rules suppress it too), except the card held from before.
    if (root.hasAttribute("data-aura-scrolling") && !card.hasAttribute("data-hover-held")) {
      deferred = card;
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (pending === card && card.isConnected) show(card);
    }, HOVER_DELAY_MS);
  };

  const onOver = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    const t = e.target as Element | null;
    consider(t && typeof t.closest === "function" ? t.closest<HTMLElement>(CARD) : null);
  };
  const onLeave = () => consider(null);
  const onResize = () => { pending = null; hide(); };

  // A card the pointer rested on while the page scrolled lights once it settles.
  const mo = new MutationObserver(() => {
    if (root.hasAttribute("data-aura-scrolling") || !deferred) return;
    const card = deferred;
    deferred = null;
    pending = null;
    if (card.isConnected && card.matches(":hover")) consider(card);
  });
  mo.observe(root, { attributes: true, attributeFilter: ["data-aura-scrolling"] });

  document.addEventListener("pointerover", onOver, { passive: true });
  document.documentElement.addEventListener("pointerleave", onLeave);
  window.addEventListener("blur", onLeave);
  window.addEventListener("resize", onResize);

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    mo.disconnect();
    document.removeEventListener("pointerover", onOver);
    document.documentElement.removeEventListener("pointerleave", onLeave);
    window.removeEventListener("blur", onLeave);
    window.removeEventListener("resize", onResize);
    hide();
    for (const v of images.values()) releaseSvgImage(v);
    images.clear();
  };
}
