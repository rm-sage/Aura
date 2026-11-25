// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// subtitleLift: the PURE half of the player's subtitle lift (PlayerOverlay.tsx,
// "Subtitle dynamic lift while controls are visible").
//
// While the control bar shows, subtitles are raised just enough that their
// bottom edge clears the bar's top by `gapPx`, and not at all when they
// already clear it. mpv's `sub-pos` is the subtitle's BOTTOM edge as a percent
// of the mpv host's height (Aura sets sub-ass-force-margins yes and
// sub-margin-y 0), measured from the host's top (`hostTop`, CSS px: the 36
// PHYSICAL px title-bar inset windowed, 0 in fullscreen).
//
// No runtime imports on purpose, so a node check can load it directly.
// ---------------------------------------------------------------------------

/** mpv's `sub-pos` range (the runtime command clamps to the same). */
export const SUB_POS_MIN = 0;
export const SUB_POS_MAX = 150;

/**
 * The fixed lift used when the bar's geometry cannot be measured, and while
 * the Subtitle style menu is open (each Vertical position step must show).
 */
export const SUB_LIFT_FALLBACK = 12;

export interface SubLiftInput {
  /** The user's saved `sub-pos` (percent of the host height). */
  baseline: number;
  /** The control bar's top edge, CSS px from the window top; null if unknown. */
  barTop: number | null;
  /** The mpv host's top edge, CSS px from the window top. */
  hostTop: number;
  /** The mpv host's height, CSS px. */
  hostH: number;
  /** Clearance kept between the subtitle's bottom and the bar's top, CSS px. */
  gapPx: number;
}

function clampSubPos(v: number): number {
  if (!Number.isFinite(v)) return SUB_POS_MIN;
  return Math.min(SUB_POS_MAX, Math.max(SUB_POS_MIN, v));
}

/**
 * The `sub-pos` to send while the controls show.
 *
 * - The subtitle's bottom already sits at or above `barTop - gapPx`: the
 *   baseline itself (zero lift).
 * - Otherwise: the largest whole percent whose bottom clears the bar by
 *   `gapPx` (floored, so the result never lands short of the gap).
 * - Geometry unknown (no bar, a host with no height, a bar at or above the
 *   host top): the old fixed lift, `baseline - SUB_LIFT_FALLBACK`.
 *
 * Always within mpv's 0..150 range.
 */
export function subtitleLiftTarget({ baseline, barTop, hostTop, hostH, gapPx }: SubLiftInput): number {
  // A non-finite baseline (never expected: settings store a u32) reads as
  // Aura's default height rather than the top of the frame.
  const base = Number.isFinite(baseline) ? clampSubPos(baseline) : 95;
  if (barTop == null || !Number.isFinite(barTop) || !(hostH > 0) || barTop <= hostTop) {
    return clampSubPos(base - SUB_LIFT_FALLBACK);
  }
  const limit = (100 * (barTop - hostTop - gapPx)) / hostH;
  if (base <= limit) return base;
  return clampSubPos(Math.floor(limit));
}
