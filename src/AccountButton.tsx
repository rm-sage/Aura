// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { ProfilePopover } from "./NavSidebar";
import AuraLogoA from "./AuraLogoA";

// ---------------------------------------------------------------------------
// AccountButton — compact circular Aura logo button + popover, anchored
// fixed at the top-left of the app body (below the title bar's
// SyncStatusChip). Replaces the older sidebar-top profile slot so the
// account UI sits in the natural "user identity" corner instead of being
// stacked above the navigation rows.
//
// The popover JSX is shared with the sidebar variant (see
// NavSidebar.ProfilePopover). Its built-in positioning (`absolute top-2
// left-full ml-3`) means it slides out to the RIGHT of the trigger
// button — consistent with the previous sidebar-anchored behavior.
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
  onOpenSettings: () => void;
  onLoginRequest?: () => void;
  onLogout?: () => void;
}

export default function AccountButton({
  loggedIn, email, nickname, onOpenSettings, onLoginRequest, onLogout,
}: Props) {
  const [open, setOpen] = useState(false);

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

  // Anchored just below the 36px title bar with an 8px gap. Same glass
  // recipe + ring-on-open accent the bell / refresh buttons use, so the
  // three floating affordances feel like a set.
  return (
    <div className="fixed top-[44px] left-3 z-30" style={{ pointerEvents: "auto" }}>
      <button
        data-profile-trigger
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={profileTitle}
        aria-expanded={open}
        title={profileTitle}
        className={[
          "relative w-10 h-10 rounded-full",
          "flex items-center justify-center",
          "bg-white/[0.08] hover:bg-white/[0.14] active:bg-white/[0.18]",
          "border border-white/10 hover:border-white/20",
          "backdrop-blur-xl shadow-lg",
          "transition-colors duration-150",
          "aura-bell-hover",
          open ? "ring-1 ring-ln-accent/50" : "",
        ].filter(Boolean).join(" ")}
      >
        <AuraLogoA size={24} />
        {/* Tiny status dot — green when signed in, neutral when guest.
            Matches the marker pattern on the bell + popover for visual
            consistency. */}
        <span
          aria-hidden
          className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-[1.5px]
                      ${loggedIn
                        ? "bg-emerald-400 border-black/85"
                        : "bg-white/30 border-black/85"}`}
          style={{ boxShadow: loggedIn ? "0 0 6px rgba(110,231,183,0.65)" : undefined }}
        />
      </button>
      {open && (
        <ProfilePopover
          loggedIn={loggedIn}
          email={email}
          nickname={nickname}
          onClose={() => setOpen(false)}
          onSettings={() => { setOpen(false); onOpenSettings(); }}
          onLogin={() => { setOpen(false); onLoginRequest?.(); }}
          onLogout={() => { setOpen(false); onLogout?.(); }}
        />
      )}
    </div>
  );
}
