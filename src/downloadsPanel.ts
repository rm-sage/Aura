// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// downloadsPanel: open/closed state for the title-bar downloads overlay.
//
// Module scope rather than App state, mirroring scrobbleRun.ts, because three
// consumers need it and none is an ancestor of the others:
//   * the trigger button, a leaf inside TitleBar (which App renders with one
//     prop today; threading a second down to a leaf is drilling for its own
//     sake)
//   * App, which must feed PlayerOverlay's anyMenuOpen so a click on the video
//     dismisses the panel WITHOUT toggling pause
//   * the panel itself
//
// THREE phases, not two. The panel plays an exit keyframe, and for that ~180 ms
// it is still painted and still eating clicks, so it must still own Escape and
// still swallow the video click. `closed` is the only phase where the panel is
// truly absent.
//
// Deliberately NOT part of downloadsStore.ts. That store is a projection of
// persisted engine state; this is throwaway UI state, and TitleBar has no
// business importing the job list to render one button's pressed look.
// ---------------------------------------------------------------------------

export type PanelPhase = "closed" | "open" | "closing";

/** Must match the aura-dl-panel-out keyframe duration in App.css. */
export const PANEL_CLOSE_MS = 180;

let phase: PanelPhase = "closed";
let closeTimer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

function emit(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

const getSnapshot = (): PanelPhase => phase;

export function useDownloadsPanelPhase(): PanelPhase {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True while the panel occupies the screen, INCLUDING its exit animation.
 *  Every guard reads this rather than `phase === "open"`, or a click during
 *  the fade would fall through to whatever is underneath. */
export function isDownloadsPanelVisible(): boolean {
  return phase !== "closed";
}

function clearTimer(): void {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

export function openDownloadsPanel(): void {
  clearTimer();
  if (phase === "open") return;
  phase = "open";
  emit();
}

export function closeDownloadsPanel(): void {
  if (phase !== "open") return;
  // Reduced motion kills the exit keyframe in CSS, so holding the node for
  // 180 ms there would just freeze a static panel on screen for a fifth of a
  // second. Collapse the delay, but keep a macrotask of "closing": this runs in
  // a capture listener, and React can flush "closed" in the microtask before
  // the video layer's mousedown reads anyMenuOpen, which would let that click
  // toggle pause.
  const reduced =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-reduced-motion") === "true";
  phase = "closing";
  emit();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    phase = "closed";
    emit();
  }, reduced ? 0 : PANEL_CLOSE_MS);
}

/** Close with no exit animation. Used when the anchor disappears from under
 *  the panel: entering fullscreen unmounts TitleBar, and animating out from a
 *  control that is no longer on screen reads as a glitch, not a transition. */
export function closeDownloadsPanelImmediate(): void {
  clearTimer();
  if (phase === "closed") return;
  phase = "closed";
  emit();
}

export function toggleDownloadsPanel(): void {
  if (phase === "open") closeDownloadsPanel();
  else openDownloadsPanel();
}

/** The player is up: the app body is hidden, so a page cannot be navigated to
 *  (App.tsx sets this class from isPlayerActive). */
export function isPlayerActive(): boolean {
  return document.documentElement.classList.contains("playing-video");
}

/** While a title-bar panel is up, keep the keys its controls need from the
 *  window-level player keybindings: Space / Enter on a control inside it
 *  (useKeybindings' preventDefault cancels the button press), Up / Down
 *  anywhere inside it (they would change the volume instead of scrolling). The
 *  bare panel root is only a focus landing spot, so Space there still pauses.
 *  At the document, not on the panel: document listeners (dnd-kit's keyboard
 *  drag in the Downloads list) still run, and every other key still reaches the
 *  window. Returns the cleanup. */
export function keepPanelKeysFromPlayer(panelSelector: string): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
    if (!(e.target instanceof Element)) return;
    const panel = e.target.closest(panelSelector);
    if (!panel) return;
    const arrow = e.code === "ArrowUp" || e.code === "ArrowDown";
    const press = e.code === "Space" || e.code === "Enter";
    if (arrow || (press && e.target !== panel)) e.stopPropagation();
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}
