// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// SidePill — the shell shared by the three floating controls that flank the
// nav rail: User Panel, Watch Party and Notifications.
//
// They used to be three 40px circles pinned to three different left offsets
// (12, 64 and 12) with nothing to align to. That read as debris around the
// menu rather than as part of it, and an icon alone left the user to guess
// what each circle did. They are now labelled pills sized to the NAV COLUMN,
// so the top group, the menu and the bottom pill share one left edge and one
// width, and the whole left side reads as a single column of furniture.
//
// The geometry constants below are derived from NavSidebar and must track it:
// the aside is `w-[180px] px-2` inside a `p-3` body, so its rows occupy
// x = 20..184. Changing the rail's padding without changing these silently
// breaks the alignment that is the entire point.
// ---------------------------------------------------------------------------

import { forwardRef, type ReactNode } from "react";

/** Left edge of a nav row: 12px body padding + 8px aside padding. */
export const SIDE_PILL_LEFT_PX = 20;
/** Width of a nav row: 180px aside minus its 8px padding on each side. */
export const SIDE_PILL_W_PX = 164;
/** Pill height. Matches the notification panel's `bottom-12` offset, which
 *  assumes a 40px trigger, so changing this means re-measuring that too. */
export const SIDE_PILL_H_PX = 40;
/** Clearance under the 36px TitleBar. Anything above y=36 covers the window
 *  drag region and breaks drag plus double-click-to-maximize. */
export const SIDE_PILL_TOP_PX = 44;
/** Gap between the two stacked top pills. Matches NavSidebar's ROW_GAP_PX. */
export const SIDE_PILL_GAP_PX = 6;

interface Props {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** A count badge or status dot. Rendered as a CORNER OVERLAY on the icon,
   *  not as a third item in the row.
   *
   *  It was an absolutely-positioned slot at the pill's right edge, which had
   *  two problems at 164px: the badge sat on the border rather than inside it,
   *  and the label had to truncate to avoid running underneath it, so
   *  "Notifications" rendered as "Notification". Hanging it off the icon is
   *  also where it lived on the round bubbles these replaced, and where an
   *  unread count conventionally goes. */
  trailing?: ReactNode;
  /** Accent ring, for "this control is currently open". */
  active?: boolean;
  /** Extra classes, used for the per-state animation hooks. */
  className?: string;
  title?: string;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  /** Forwarded verbatim. Several of these carry data-* attributes that other
   *  surfaces query by selector to seat themselves, so they are a contract. */
  extraProps?: Record<string, string | boolean>;
}

const SidePill = forwardRef<HTMLButtonElement, Props>(function SidePill(
  { label, icon, onClick, trailing, active, className, title, ariaLabel, ariaExpanded, extraProps },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? label}
      aria-expanded={ariaExpanded}
      style={{ width: SIDE_PILL_W_PX, height: SIDE_PILL_H_PX }}
      className={[
        "aura-side-pill aura-float-glass",
        // CENTRED as a group, with the trailing slot taken out of the flow.
        // Left-aligning the label meant the pill's text sat off-centre against
        // its own box, and letting a badge participate in the row shifted the
        // label sideways the moment one appeared or cleared.
        "relative flex items-center justify-center gap-2.5 px-3 rounded-xl",
        "text-white/80 hover:text-white",
        // A state CLASS, not `ring-1 ring-ln-accent/50`. The ring utility emits
        // into `box-shadow`, which `.aura-float-glass` also sets at equal
        // specificity and later in the sheet, so the ring silently lost and
        // every pill looked the same open as closed. See `.aura-side-pill
        // .is-active` in App.css.
        active ? "is-active" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      {...extraProps}
    >
      <span className="relative flex-shrink-0 w-[22px] flex items-center justify-center">
        {icon}
        {trailing && (
          <span className="absolute -top-1.5 -right-2 flex items-center">{trailing}</span>
        )}
      </span>
      {/* 13px with default tracking, not 13.5px with tracking-wide. The wider
          pair needed ~108px for "Notifications" against ~106px of usable room,
          so the longest of the three labels clipped its final letter. */}
      <span className="min-w-0 text-[13px] font-medium truncate">
        {label}
      </span>
    </button>
  );
});

export default SidePill;
