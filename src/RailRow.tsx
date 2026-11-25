// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// RailRow: one row of the left rail's two sections above the nav
// (Notifications, then User Panel and Watch Party). It replaced SidePill: those three controls used
// to be separate floating glass pills around a bare nav; in the rail they are
// LIST ROWS on the rail's one glass surface (styles/glass-rail.css), under the
// rail's one hover droplet with the nav rows (NavSidebar useRailDroplet, which
// finds rows by `.aura-nav-row`).
//
// Popups opened from a row (the profile popover, the notifications panel and
// bubble) must NOT render inside the rail: the rail has a backdrop-filter, so
// it is both the containing block of a `position: fixed` descendant and its
// Backdrop Root (the popup would be placed, clipped and blurred against the
// rail alone). `RailPopup` portals them into a host element NavSidebar renders
// as a sibling of the rail, still inside the app body, so they keep the body's
// stacking (under the detail page) and its `hidden` class during playback.
// ---------------------------------------------------------------------------

import { createContext, forwardRef, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** The element RailPopup portals into (NavSidebar provides it). */
export const RailPopupHostContext = createContext<HTMLElement | null>(null);

/** Renders `children` beside the rail instead of inside it (see the header). */
export function RailPopup({ children }: { children: ReactNode }) {
  const host = useContext(RailPopupHostContext);
  return host ? createPortal(children, host) : <>{children}</>;
}

interface Props {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** Badges at the row's right end (a count, a status dot). */
  tail?: ReactNode;
  /** "This control is currently open / live": an accent label and a faint
   *  wash (styles/glass-rail.css `.aura-rail-row.is-active`). */
  active?: boolean;
  /** Extra classes on the row (state hooks such as `.aura-notif-unread`). */
  className?: string;
  /** Extra classes on the icon slot (the arrival pop). */
  iconClassName?: string;
  title?: string;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  /** Forwarded verbatim. Several carry data-* attributes that other surfaces
   *  query by selector (data-profile-trigger, data-party-anchor,
   *  data-notifications-bell), so they are a contract. */
  extraProps?: Record<string, string | boolean>;
}

const RailRow = forwardRef<HTMLButtonElement, Props>(function RailRow(
  { label, icon, onClick, tail, active, className, iconClassName, title, ariaLabel, ariaExpanded, extraProps },
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
      className={[
        "aura-rail-row aura-rail-urow aura-nav-row nav-tap",
        active ? "is-active" : "",
        className ?? "",
      ].filter(Boolean).join(" ")}
      {...extraProps}
    >
      <span className={["aura-rail-icon", iconClassName ?? ""].filter(Boolean).join(" ")}>{icon}</span>
      <span className="aura-rail-label">{label}</span>
      {tail && <span className="aura-rail-tail">{tail}</span>}
    </button>
  );
});

export default RailRow;
