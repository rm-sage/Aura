// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { StremioAccount } from "./LoginView";
import AuraLogoA from "./AuraLogoA";
import RailRow, { RailPopup } from "./RailRow";
import { anchorFromElement, type PartyAnchor } from "./partyAnchor";
import { usePopPresence } from "./popPresence";
import { useGlassStyle } from "./glassStyle";
import { useListDroplet } from "./glassListDroplet";

// ---------------------------------------------------------------------------
// AccountButton: the rail's "User Panel" row (first row of the rail's top
// section, NavSidebar) plus its profile popover. The popover opens BESIDE the
// rail, level with the row (partyAnchor `anchorFromElement`, the same helper
// the Watch-Together surfaces use), and is portalled out of the rail
// (RailPopup) so the rail's backdrop-filter neither positions nor clips it.
//
// Outside-click + Escape close, as before.
// ---------------------------------------------------------------------------

interface Props {
  /** Whether the user is signed into Stremio. */
  loggedIn: boolean;
  /** Stremio account email, shown in the popover's identity row.
   *  May be empty during the pre-backfill window for older sessions;
   *  the popover renders "Email pending sync" in that case. */
  email?: string | null;
  /** Display nickname if available. Currently null in the source; wired
   *  through for forward-compat when Stremio surfaces one. */
  nickname?: string | null;
  onLoginRequest?: () => void;
  onLogout?: () => void;
}

export default function AccountButton({
  loggedIn, email, nickname, onLoginRequest, onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
  // Measured by ProfilePopover to seat itself beside this row.
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Focus inside the popover goes back to the row before the popover closes:
  // the popover unmounts after its exit, and a focused button inside it would
  // drop focus on <body>.
  const returnFocus = () => {
    if (document.activeElement?.closest?.("[data-profile-popover]")) {
      triggerRef.current?.focus({ preventScroll: true });
    }
  };

  // Outside-click + Esc to close, with data-attribute guards so clicks inside
  // the popover (or in a context menu opened over it) do not close it.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const insidePopover = target?.closest?.("[data-profile-popover]");
      const onTriggerBtn  = target?.closest?.("[data-profile-trigger]");
      const inContextMenu = target?.closest?.("[data-aura-context-menu]");
      if (!insidePopover && !onTriggerBtn && !inContextMenu) setOpen(false);
    };
    // Capture phase, and stopped there: the window-level Escape handlers (App's,
    // the catalog page's) would otherwise close the page under the popover too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      returnFocus();
      setOpen(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const profileTitle = loggedIn
    ? `Signed in as ${nickname ?? email ?? "Stremio account"}`
    : "Guest. Click to sign in.";
  // The accessible name STARTS with the visible label (WCAG 2.5.3), so voice
  // control finds the row as "User Panel".
  const profileAria = loggedIn
    ? `User Panel, signed in as ${nickname ?? email ?? "Stremio account"}`
    : "User Panel, guest";

  const initials = monogramFor(loggedIn, email);

  return (
    <>
      <RailRow
        ref={triggerRef}
        label="User Panel"
        title={profileTitle}
        ariaLabel={profileAria}
        ariaExpanded={open}
        active={open}
        onClick={() => setOpen((o) => !o)}
        // data-profile-trigger is a CONTRACT: the outside-click guard finds
        // this node by selector, so dropping it makes the popover close on
        // its own trigger.
        extraProps={{ "data-profile-trigger": true }}
        icon={initials ? (
          <span className="aura-rail-monogram">{initials}</span>
        ) : (
          <AuraLogoA size={22} />
        )}
      />
      <RailPopup>
        <ProfilePopover
          open={open}
          triggerRef={triggerRef}
          loggedIn={loggedIn}
          email={email}
          nickname={nickname}
          onLogin={() => { returnFocus(); setOpen(false); onLoginRequest?.(); }}
          onLogout={() => { returnFocus(); setOpen(false); onLogout?.(); }}
        />
      </RailPopup>
    </>
  );
}

/** Two-letter monogram from the signed-in email (first upper, second lower:
 *  "rmsage95@gmail.com" gives "Rm"). Derived from the local part so the "@"
 *  never leaks in. Null for guests or pre-sync sessions with no email yet
 *  (they show the Aura "A" mark). ONE helper for the rail row and the
 *  popover's identity circle, so the two always agree. */
function monogramFor(loggedIn: boolean, email: string | null | undefined): string | null {
  const local = (email ?? "").trim().split("@")[0] ?? "";
  if (!loggedIn || local.length === 0) return null;
  return local
    .slice(0, 2)
    .split("")
    .map((c, i) => (i === 0 ? c.toUpperCase() : c.toLowerCase()))
    .join("");
}

const LogOutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z" />
  </svg>
);
const SignInIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z" />
  </svg>
);

// ---------------------------------------------------------------------------
// ProfilePopover: opens BESIDE the rail, level with its trigger row (measured
// through partyAnchor's `anchorFromElement`, the same helper the
// Watch-Together panel and toasts use), and clamps its height to the viewport
// (overflow-y) rather than clipping off the bottom edge.
// ---------------------------------------------------------------------------

// Exit-animation duration: the popover stays mounted this long after `open`
// flips false so it can collapse back into its trigger before unmounting.
// Keep in step with the transform/opacity transition below.
const PROFILE_EXIT_MS = 200;

function ProfilePopover({
  open, triggerRef, loggedIn, email, nickname, onLogin, onLogout,
}: {
  open: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  loggedIn: boolean;
  email?: string | null;
  nickname?: string | null;
  onLogin: () => void;
  onLogout: () => void;
}) {
  // Mount + spawn/despawn lifecycle, shared with WatchTogetherPanel
  // (usePopPresence) so the popover grows out of / collapses back into the
  // account row with the SAME easing. `render` keeps the card alive through
  // the exit animation; `visible` drives the enter/exit transition; `anchor`
  // pins it beside the trigger.
  const [anchor, setAnchor] = useState<PartyAnchor>({ side: "left", top: 94, left: 228 });
  const glass = useGlassStyle();
  // Liquid's shared hover droplet over the action rows (inert in Frosted).
  const droplet = useListDroplet<HTMLDivElement>();

  // On open: snapshot the anchor and re-pin on resize. A layout effect declared
  // BEFORE the presence hook, so setAnchor batches with its mount into one sync
  // render.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = triggerRef.current;
      if (el) setAnchor(anchorFromElement(el));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [open, triggerRef]);
  const pop = usePopPresence<HTMLDivElement>(open, PROFILE_EXIT_MS);
  const { render, visible } = pop;

  // Keyboard reach: the popover is portalled after the whole rail (RailPopup),
  // so Tab from the row would walk every nav row first. Move focus to its
  // first action once it shows (once per opening).
  const actionsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    actionsRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [visible]);

  // Read-only Stremio account snapshot, baked directly into this popover (the
  // former separate "Account settings" panel was folded in here). Fetched on
  // open; the Rust command is cached 24h so each open is a cache hit.
  // Best-effort: failure just leaves the prop email.
  const [acct, setAcct] = useState<StremioAccount | null>(null);
  // The popover outlives a sign-out and sign-in, so the snapshot belongs to
  // the account it was read for: drop it when that account goes away, or the
  // next account would show the previous one's email, id and Premium date.
  useEffect(() => {
    setAcct(null);
  }, [loggedIn, email]);
  useEffect(() => {
    if (!open || !loggedIn) return;
    let cancelled = false;
    invoke<StremioAccount>("fetch_stremio_account")
      .then((a) => { if (!cancelled) setAcct(a); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, loggedIn, email]);

  if (!render) return null;

  const reduced = document.documentElement.getAttribute("data-reduced-motion") === "true";
  // Liquid grows the card out of its trigger like a droplet (squashed toward
  // the row, then a springy settle), the Watch Together panel's curve.
  // Frosted keeps the short slide and scale.
  const liquid = glass === "liquid";
  const hiddenTransform = reduced ? "none"
    : liquid ? "translateX(-8px) scale(0.88, 0.66)" : "translateX(-8px) scale(0.96)";
  const openTransition = reduced
    ? "opacity 160ms ease"
    : liquid
      ? "opacity 200ms ease, transform var(--aura-spring-bouncy-dur) var(--aura-spring-bouncy)"
      : "opacity 200ms ease, transform 240ms cubic-bezier(0.16, 1, 0.3, 1)";

  const monthYear = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };

  const fetchedEmail = acct?.email && acct.email.length > 0 ? acct.email : null;
  const propEmail = email && email.length > 0 ? email : null;
  const shownEmail = fetchedEmail ?? propEmail;
  // The rail row reads the prop email: prefer it so the two always match.
  const popInitials = monogramFor(loggedIn, propEmail ?? fetchedEmail);
  const since = monthYear(acct?.date_registered);
  const premium = monthYear(acct?.premium_until);
  const id = acct?.user_id ?? "";
  const acctId = id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : (id || null);

  return (
    <div
      ref={pop.ref}
      data-profile-popover
      // Liquid: no lens build until the pop settles (holdLensDuringPop; a lens
      // already built for its size binds from the first frame), so the account
      // fetch growing the card mid-pop cannot drop and rebuild it.
      data-lg-pop=""
      role="dialog"
      aria-label="Profile"
      // The menu tier of the glass (baked dark base: legible at any z-stack
      // depth). No border / shadow utilities: the class owns both.
      className="fixed w-[300px] z-[10045] overflow-y-auto rounded-2xl aura-float-glass"
      style={{
        top: anchor.top,
        ...(anchor.side === "left" ? { left: anchor.left } : { right: anchor.right }),
        maxHeight: `calc(100vh - ${anchor.top + 16}px)`,
        transformOrigin: anchor.side === "left" ? "top left" : "top right",
        opacity: visible ? 1 : 0,
        // Grow out of / collapse back toward the account row, same easing as
        // WatchTogetherPanel.
        transform: visible ? "translateX(0) scale(1)" : hiddenTransform,
        transition: openTransition,
      }}
    >
      {/* Top: logo + identity */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-white/8">
        {/* The identity circle shows the same initials as the rail row
            (round 11: it showed the Aura "A" beside a rail that said "Vi"),
            in the accent MARK like the rail monogram; guests keep the A.
            The glow reads the theme accent token, never the Mica literal. */}
        <span className="relative flex items-center justify-center w-12 h-12 rounded-full
                         bg-white/5 border border-white/10"
              style={{ boxShadow: "0 0 28px rgb(var(--ln-accent-rgb) / 0.22)" }}>
          {popInitials ? (
            <span className="aura-rail-monogram aura-profile-monogram">{popInitials}</span>
          ) : (
            <AuraLogoA size={36} />
          )}
          <span aria-hidden
                className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-black/75
                            ${loggedIn ? "bg-emerald-400" : "bg-white/30"}`}
                style={{ boxShadow: loggedIn ? "0 0 8px rgba(110,231,183,0.65)" : undefined }} />
        </span>
        <div className="flex-1 min-w-0 selectable">
          {!loggedIn ? (
            <>
              <p className="text-white/95 text-sm font-semibold leading-tight truncate">Guest mode</p>
              <p className="text-white/45 text-[11px] mt-0.5 truncate font-mono">No Stremio account linked</p>
            </>
          ) : (
            <>
              <p className="text-white/95 text-sm font-semibold leading-tight truncate">
                {nickname && nickname.length > 0 ? nickname : "Stremio account"}
              </p>
              <p className="text-white/45 text-[11px] mt-0.5 truncate font-mono">
                {shownEmail ?? "Email pending sync"}
              </p>
            </>
          )}
        </div>
      </div>

      {/* Account details, baked in (replaces the old separate panel). */}
      {loggedIn && (since || acctId || premium) && (
        <div className="px-4 py-3 border-b border-white/8 space-y-1.5 selectable">
          {since && (
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-white/40">Member since</span>
              <span className="text-white/85">{since}</span>
            </div>
          )}
          {acctId && (
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-white/40">Account</span>
              <span className="text-white/85 font-mono">{acctId}</span>
            </div>
          )}
          {premium && (
            <div className="flex items-center justify-between gap-3 text-[12px]">
              <span className="text-white/40">Stremio Premium</span>
              <span className="text-white/85">until {premium}</span>
            </div>
          )}
        </div>
      )}

      <div className="px-4 py-3 border-b border-white/8">
        <p className="text-white/40 text-[9.5px] font-mono font-semibold tracking-[0.18em] uppercase mb-1.5">
          Sync
        </p>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${loggedIn ? "bg-emerald-400" : "bg-white/30"}`}
                style={{ boxShadow: loggedIn ? "0 0 6px rgba(110,231,183,0.7)" : undefined }} />
          <p className="text-white/85 text-[12.5px]">
            {loggedIn ? "Synced to Stremio cloud" : "Local only. Sign in to sync."}
          </p>
        </div>
      </div>

      <div ref={actionsRef} className="relative py-1" {...droplet.listProps}>
        <span
          ref={droplet.ref}
          aria-hidden
          className="aura-glass-hl aura-glass-hl-inset"
        />
        {loggedIn && (
          <PopoverButton
            icon={
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" />
              </svg>
            }
            label="Manage on Stremio"
            onClick={() => { openUrl("https://www.stremio.com/acc-settings").catch(() => {}); }}
          />
        )}
        {loggedIn ? (
          <PopoverButton icon={<LogOutIcon />} label="Log out" danger onClick={onLogout} />
        ) : (
          <PopoverButton icon={<SignInIcon />} label="Sign in to Stremio" accent onClick={onLogin} />
        )}
      </div>

    </div>
  );
}

function PopoverButton({
  icon, label, onClick, danger, accent,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
  accent?: boolean;
}) {
  return (
    // A glass menu row. The tone is the label colour in both materials; the
    // Frosted hover adds a faint tone tint (the context menu's data-tone
    // rules, src/styles/glass-chrome.css); Liquid's droplet stays neutral.
    <button
      onClick={onClick}
      data-tone={danger ? "danger" : accent ? "notice" : undefined}
      className={`aura-glass-row aura-ctx-row relative w-full flex items-center gap-3 px-4 py-2.5
                  text-left text-[13px]
                  ${danger ? "text-red-300/90" : accent ? "text-ln-accent" : "text-white/85"}`}
    >
      <span className="flex-shrink-0 opacity-80">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
