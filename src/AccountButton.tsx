// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { ProfilePopover } from "./NavSidebar";
import AuraLogoA from "./AuraLogoA";
import SidePill, { SIDE_PILL_LEFT_PX, SIDE_PILL_TOP_PX } from "./SidePill";

// ---------------------------------------------------------------------------
// AccountButton — compact circular Aura logo button + popover, anchored
// fixed at the top-left of the app body (below the title bar's
// SyncStatusChip). Replaces the older sidebar-top profile slot so the
// account UI sits in the natural "user identity" corner instead of being
// stacked above the navigation rows.
//
// The popover JSX is shared with the sidebar variant (see
// NavSidebar.ProfilePopover). It hangs BELOW this trigger — anchored off
// the button's measured box via partyAnchor's `anchorFromRect`, the same
// helper the Watch-Together surfaces use — so it grows out of the icon and
// stays viewport-clamped instead of clipping off the top edge.
//
// Outside-click + Escape close: mirrored from the sidebar's previous
// effect so behavior is identical.
// ---------------------------------------------------------------------------

interface Props {
  /** Whether the user is signed into Stremio. */
  loggedIn: boolean;
  /** Stremio account email — shown in the popover's identity row.
   *  May be empty during the pre-backfill window for older sessions;
   *  the popover renders "Email pending sync" in that case. */
  email?: string | null;
  /** Display nickname if available. Currently null in the source — wired
   *  through for forward-compat when Stremio surfaces one. */
  nickname?: string | null;
  onLoginRequest?: () => void;
  onLogout?: () => void;
}

export default function AccountButton({
  loggedIn, email, nickname, onLoginRequest, onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
  // Measured by ProfilePopover to seat itself just below this button.
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Outside-click + Esc to close — match the sidebar variant's behavior
  // exactly, including the same data-attribute guards so nested clicks
  // inside the popover don't close it.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const insidePopover = target?.closest?.("[data-profile-popover]");
      const onTriggerBtn  = target?.closest?.("[data-profile-trigger]");
      if (!insidePopover && !onTriggerBtn) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const profileTitle = loggedIn
    ? `Signed in as ${nickname ?? email ?? "Stremio account"}`
    : "Guest. Click to sign in.";

  // Two-letter monogram from the signed-in email (first upper, second lower
  // — "rmsage95@gmail.com" → "Rm"). Derived from the local part so the "@"
  // never leaks in. Falls back to the Aura "A" mark for guests or pre-sync
  // sessions that have no email yet.
  const local = (email ?? "").trim().split("@")[0] ?? "";
  const initials =
    loggedIn && local.length > 0
      ? local
          .slice(0, 2)
          .split("")
          .map((c, i) => (i === 0 ? c.toUpperCase() : c.toLowerCase()))
          .join("")
      : null;

  // Anchored just below the 36px title bar with an 8px gap. Same glass
  // recipe + ring-on-open accent the bell / refresh buttons use, so the
  // three floating affordances feel like a set.
  return (
    <div
      // The z-index LIFTS while the popover is open, and this is not cosmetic.
      // A `fixed z-30` wrapper is its own stacking context, so the popover's
      // own z-[10045] only ranks it against its siblings INSIDE this div. The
      // Watch Party pill is a separate fixed z-30 element later in the DOM, so
      // at equal z it won and painted straight over the open panel.
      className={open ? "fixed z-[10046]" : "fixed z-30"}
      style={{
        top: SIDE_PILL_TOP_PX,
        left: SIDE_PILL_LEFT_PX,
        pointerEvents: "auto",
      }}
    >
      <SidePill
        ref={triggerRef}
        label="User Panel"
        title={profileTitle}
        ariaLabel={profileTitle}
        ariaExpanded={open}
        active={open}
        onClick={() => setOpen((o) => !o)}
        // data-profile-trigger is a CONTRACT: the outside-click guard finds
        // this node by selector, so dropping it makes the popover close on
        // its own trigger.
        extraProps={{ "data-profile-trigger": true }}
        icon={initials ? (
          <span className="text-ln-accent text-[15px] font-semibold leading-none tracking-tight select-none">
            {initials}
          </span>
        ) : (
          <AuraLogoA size={22} />
        )}
      />
      <ProfilePopover
        open={open}
        triggerRef={triggerRef}
        loggedIn={loggedIn}
        email={email}
        nickname={nickname}
        onLogin={() => { setOpen(false); onLoginRequest?.(); }}
        onLogout={() => { setOpen(false); onLogout?.(); }}
      />
    </div>
  );
}
