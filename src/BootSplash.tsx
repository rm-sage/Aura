// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import auraIcon from "./assets/aura-icon.png";

// ---------------------------------------------------------------------------
// BootSplash — Layer B of the two-layer branded loading screen
//
// Layer A is the static #aura-boot-splash div in index.html, visible from
// the very first DOM paint before the JS bundle runs. This component is
// Layer B: it takes over as soon as React mounts, removes the static div,
// and provides a React-controlled overlay that can animate out cleanly when
// authChecked flips true.
//
// Render contract (from App.tsx):
//   <BootSplash visible={!authChecked} />
//
// The component always stays mounted while visible=true. When visible flips
// false it plays a 400 ms opacity fade, then calls its own internal
// "done" gate and renders nothing. This means the underlying UI is already
// painted before the fade completes, giving a natural cross-dissolve.
// ---------------------------------------------------------------------------

interface Props {
  /** True while App.tsx's authChecked is false. Triggers fade-out when it
   *  flips to false. */
  visible: boolean;
}

export default function BootSplash({ visible }: Props) {
  // Track whether we've entered the fade-out phase.
  const [fading, setFading] = useState(false);
  // Track whether the fade is fully complete (unmount gate).
  const [gone, setGone] = useState(false);

  // Remove the static Layer A element as soon as this component mounts —
  // the hand-off is invisible because we render the same visual.
  useEffect(() => {
    document.getElementById("aura-boot-splash")?.remove();
  }, []);

  // When visible goes false, start the fade-out sequence.
  useEffect(() => {
    if (visible) return;
    setFading(true);
    const t = setTimeout(() => setGone(true), 420); // 400 ms fade + 20 ms buffer
    return () => clearTimeout(t);
  }, [visible]);

  if (gone) return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        // Skip the top 36px so the TitleBar (rendered as a flex child of
        // aura-app-shell) stays visible and interactable through boot.
        // Without this top offset the splash sat at the same stacking
        // level as the title bar and visually erased it; the previous
        // "z 10000 keeps controls on top" comment relied on a stacking
        // context the title bar's `position: relative` parent never
        // actually established. Leaving the top strip uncovered also
        // means the user sees the real title bar's glass material
        // immediately rather than a "starting up" placeholder.
        top: 36,
        left: 0,
        right: 0,
        bottom: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
        // FULLY opaque, theme-coordinated backdrop. The CSS variable
        // is defined per :root[data-theme=...] block in App.css so the
        // splash matches the surface the user is about to land in.
        // Solid (alpha = 1) is non-negotiable: even 3 % bleed-through
        // lights up bright LandingView gradients on OLED + HDR before
        // the splash fades. Fallback `rgb(8, 10, 14)` covers the
        // pre-CSS frame on a hard reload. The animated `.aura-ambient`
        // overlay layered on top (see below) gives Mica + the rest of
        // the themes the same gentle moving gradient the active app
        // body has, so the visual transition into the post-boot UI is
        // continuous instead of "solid-color → suddenly-animated".
        background: "var(--aura-splash-bg, rgb(8, 10, 14))",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        // Z-band: above ResizeHandles (z 9000) and the app shell, below
        // the TitleBar's stacking-context line so the title bar shows
        // through the `top: 36` cutout above. Pure-opaque background
        // (PLUS the cutout) combined with this z value means nothing
        // else in the React tree shows through during the splash window.
        zIndex: 9500,
        // Block click-through while the splash is over the React tree.
        // The previous `none` value let the user click LandingView /
        // login fields through the opaque backdrop because they were
        // already painted underneath; now the splash captures input
        // for its full visible lifetime. Switches to `none` only once
        // the fade has started so the underlying UI is interactive
        // the instant it appears (no 400 ms dead window).
        pointerEvents: fading ? "none" : "auto",
        userSelect: "none",
        opacity: fading ? 0 : 1,
        transition: fading ? "opacity 400ms ease" : "none",
        willChange: "opacity",
      }}
    >
      {/* Animated ambient gradient layered on top of the solid theme
          base. Mirrors the `.aura-ambient` element the post-boot app
          body uses so the splash visually matches the destination
          theme — Mica's gentle violet/teal sweep, Ember's warm amber
          drift, etc. `position: absolute; inset: 0;` overrides the
          fixed-positioned `.aura-ambient` selector so the gradient is
          contained within the splash's cutout (top: 36 onwards) and
          doesn't paint over the title bar slot. */}
      <div
        className="aura-ambient"
        style={{ position: "absolute", inset: 0, zIndex: -1 }}
        aria-hidden
      />

      {/* Icon — slow pulse on the drop-shadow signals "loading" */}
      <img
        src={auraIcon}
        alt=""
        width={96}
        height={96}
        draggable={false}
        className="boot-splash-icon"
      />

      {/* AURA wordmark — matches .aura-title spectral gradient */}
      <span className="aura-title" style={{ fontSize: 18 }}>AURA</span>
    </div>
  );
}
