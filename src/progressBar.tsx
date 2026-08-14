// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// progressBar: the pieces the two watch-progress bars share.
//
// There are two bars and they live in different files: the Continue Watching
// tile's (CinemaRows.tsx, segmented or continuous depending on episode count)
// and the detail page's "Your Progress" (DetailView.tsx). They mean the same
// thing, so the parts a user can actually compare between them belong in one
// place: the hover tooltip's look, and the way a percentage is written.
//
// The tooltip is a PORTAL, not a native `title`. Three reasons, all of which
// bit the previous version:
//   1. A native tooltip cannot be styled, so the two surfaces looked unrelated.
//   2. It waits about a second before appearing, which is too slow for a
//      pointer sweeping along a bar.
//   3. Both bars sit inside clipping ancestors (the CW card's rounded overflow,
//      the detail HUD panel's `overflow-y: auto`), and an in-flow tooltip gets
//      clipped by them. Portalling to <body> is what makes it visible at all.
// ---------------------------------------------------------------------------

import { createPortal } from "react-dom";

import { formatEpLabel } from "./episodeLabel";

/** Cursor-anchored tooltip state. `y` is the bar's TOP edge, not the pointer's
 *  y: the tooltip sits above the bar and should not bob as the pointer moves
 *  vertically inside it. */
export interface BarTip {
  x: number;
  y: number;
  text: string;
}

/** Shared hover label for both progress bars. Renders nothing when `tip` is
 *  null, so callers can mount it unconditionally. */
export function BarTooltip({ tip }: { tip: BarTip | null }) {
  if (!tip) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[300] px-2 py-0.5 rounded-md
                 bg-black/85 backdrop-blur-sm border border-white/15
                 text-white text-[11px] font-medium whitespace-nowrap
                 -translate-x-1/2 -translate-y-full"
      style={{
        // Clamped on BOTH axes. `-translate-y-full` puts the pill above this
        // point, so an unclamped top pushes it off the top edge for a bar high
        // in the viewport and under the 36px windowed title bar just below
        // that. The horizontal clamp stops a bar near either screen edge from
        // pushing its own tooltip off-screen.
        left: Math.max(60, Math.min(window.innerWidth - 60, tip.x)),
        top: Math.max(58, tip.y - 6),
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

/** Percentages in progress copy, to two decimal places.
 *
 *  Two decimals rather than none because these are fractions of a whole SHOW:
 *  one episode of One Piece is 0.09% of it, and rounding that to "0%" told a
 *  user who had just watched something that they had watched nothing. Two
 *  places is the smallest precision that keeps a single episode visible on the
 *  longest series anyone actually tracks. Uniform, so the numbers stay column-
 *  comparable rather than changing width as they grow. */
export function formatProgressPct(fraction: number): string {
  if (!Number.isFinite(fraction)) return "0.00%";
  return `${(fraction * 100).toFixed(2)}%`;
}

/** "SxxEyy" for a tooltip, degrading to "Ex" and then to a generic word when
 *  the addon gave us no numbering.
 *
 *  Delegates rather than reimplements: `episodeLabel.ts` calls itself the
 *  single source of truth for the season/episode badge string, and a private
 *  copy here would make that false the first time either side changed. All this
 *  adds is the non-null fallback a tooltip needs. */
export function episodeTag(
  season: number | null | undefined,
  episode: number | null | undefined,
): string {
  return formatEpLabel(season, episode) ?? "Episode";
}
