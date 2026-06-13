// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// useHoverCardActivation — the single source of truth for how a catalog
// card activates the mini-meta panel. Driven by AuraSettings.metaPanelActivation:
//
//   • "hover" (default): reproduces the historical
//     onMouseEnter/onMouseLeave hover-intent behaviour exactly.
//   • "button": hover never opens; the panel opens when the configured
//     mouse button is pressed on a card and a second press toggles it
//     shut. preventDefault on the bound button's pointerdown suppresses
//     middle-click autoscroll / back-forward navigation.
//   • "hold": hover never opens; a PRESS-AND-HOLD (~0.4 s) of the primary
//     button / a trackpad tap-and-hold on a card opens it. A quick click
//     still selects (the hold-open suppresses only the click that ends the
//     hold, via a capture-phase stopPropagation); moving past a small
//     threshold or releasing early cancels. Trackpad-friendly — no aux
//     button or steady hover required.
//
// In both "button" and "hold" modes the panel does NOT close on card
// mouse-leave (there is no hover intent to bridge card→panel) — it closes
// via the bound-button toggle, click-outside / Esc (CatalogHoverHost), or
// scroll-out (store re-anchor).
//
// Spread the returned handlers on the card's root element; the card keeps
// its own onClick / onContextMenu — this hook owns ONLY hover/bind/hold
// activation. Reacts live to settings changes via the
// `aura:settings-changed` event (saveAuraSettings busts the settings cache
// before dispatching it, so the re-read is fresh).
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import type { MetaPreview } from "./types";
import { loadAuraSettings } from "./auraSettings";
import {
  scheduleHoverOpen,
  cancelHoverOpen,
  scheduleHoverClose,
  toggleHoverNow,
  openHoverNow,
} from "./catalogHoverStore";

export interface HoverCardActivation {
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerMove?: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerUp?: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel?: (e: React.PointerEvent<HTMLElement>) => void;
  onAuxClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onClickCapture?: (e: React.MouseEvent<HTMLElement>) => void;
}

/** Long-press duration to open the panel in "hold" mode. */
const HOLD_MS = 400;
/** Pointer drift (px) past which a hold is treated as a scroll/drag and cancelled. */
const HOLD_MOVE_PX = 10;

function readActivation(): { activation: "hover" | "button" | "hold"; button: number } {
  const a = loadAuraSettings();
  return { activation: a.metaPanelActivation, button: a.metaPanelBindButton };
}

export function useHoverCardActivation(meta: MetaPreview): HoverCardActivation {
  const [mode, setMode] = useState(readActivation);
  // Per-card press-and-hold bookkeeping (stable across renders).
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number; opened: boolean }>({
    timer: null, x: 0, y: 0, opened: false,
  });

  useEffect(() => {
    // Only re-read when an activation-relevant key actually changed —
    // otherwise every poster on screen re-renders on any unrelated
    // settings flip. Absent detail.keys (legacy emitters) → re-read.
    const sync = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (keys && !keys.includes("metaPanelActivation") && !keys.includes("metaPanelBindButton")) return;
      setMode(readActivation());
    };
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  if (mode.activation === "button") {
    return {
      onPointerDown: (e) => { if (e.button !== mode.button) return; e.preventDefault(); },
      onAuxClick: (e) => {
        if (e.button !== mode.button) return;
        e.preventDefault();
        toggleHoverNow(meta, e.currentTarget);
      },
    };
  }

  if (mode.activation === "hold") {
    const clearTimer = () => {
      if (hold.current.timer) { clearTimeout(hold.current.timer); hold.current.timer = null; }
    };
    return {
      onPointerDown: (e) => {
        if (e.button !== 0) return; // primary button / trackpad tap only
        clearTimer();
        hold.current.opened = false;
        hold.current.x = e.clientX;
        hold.current.y = e.clientY;
        const el = e.currentTarget;
        hold.current.timer = setTimeout(() => {
          hold.current.timer = null;
          hold.current.opened = true; // suppress the click that ends this hold
          openHoverNow(meta, el);
        }, HOLD_MS);
      },
      onPointerMove: (e) => {
        if (!hold.current.timer) return;
        if (Math.abs(e.clientX - hold.current.x) > HOLD_MOVE_PX ||
            Math.abs(e.clientY - hold.current.y) > HOLD_MOVE_PX) {
          clearTimer(); // moved → it's a scroll/drag, not a hold
        }
      },
      onPointerUp: clearTimer,
      onPointerLeave: clearTimer,
      onPointerCancel: clearTimer,
      // A hold that opened the panel must NOT also fire the card's select
      // onClick. Capture phase + stopPropagation eats that one click.
      onClickCapture: (e) => {
        if (hold.current.opened) { e.preventDefault(); e.stopPropagation(); hold.current.opened = false; }
      },
    };
  }

  return {
    onMouseEnter: (e) => scheduleHoverOpen(meta, e.currentTarget),
    onMouseLeave: () => { cancelHoverOpen(); scheduleHoverClose(); },
  };
}
