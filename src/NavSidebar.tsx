// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import Tooltip from "./Tooltip";
import AuraLogoA from "./AuraLogoA";

export type NavView = "home" | "library" | "queue" | "addons" | "discover" | "calendar" | "history" | "settings";

interface Props {
  active: NavView;
  onNavigate: (view: NavView) => void;
  /** Email of signed-in user; null when guest. May be empty string when
   *  the user has a valid auth_key but the email field wasn't persisted
   *  (older Aura builds saved only auth_key) — the popover falls back
   *  to a placeholder in that case. */
  userEmail?: string | null;
  /** Authoritative "is the user signed in to a Stremio account" flag.
   *  Driven by the presence of `session.auth_key`, not by `email`,
   *  because at least one historical save shape persisted only the
   *  auth_key. When this is true but email is empty/null, the popover
   *  shows "Stremio account" as the identity placeholder. */
  loggedIn?: boolean;
  /** Optional Stremio account nickname. Wins over the email initial. */
  userNickname?: string | null;
  /** Open the LoginView (called from the popover when guest clicks "Sign in"). */
  onLoginRequest?: () => void;
  /** Sign the user out. */
  onLogout?: () => void;
}

// ---------------------------------------------------------------------------
// Geometry — each row is ROW_H_PX tall, groups use ROW_GAP_PX between rows.
// SLOT_PX is the stride used by the .aura-glow pill's translateY offset.
// ---------------------------------------------------------------------------
const ROW_H_PX   = 48;
const ROW_GAP_PX = 6;
const SLOT_PX    = ROW_H_PX + ROW_GAP_PX;

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

const HomeIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />
  </svg>
);
const LibraryIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z" />
  </svg>
);
const AddonsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7s2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z" />
  </svg>
);
const CalendarIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17 12h-5v5h5v-5zM16 1v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-1V1h-2zm3 18H5V8h14v11z" />
  </svg>
);
const HistoryIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 7 7 6.96 6.96 0 0 1-4.95-2.05L6.63 18.36A8.97 8.97 0 0 0 13 21a9 9 0 1 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z" />
  </svg>
);
const QueueIcon = () => (
  // Bookmark glyph — same shape the planned-state badge uses, so the
  // Queue tab's icon visually corresponds to the per-item badge.
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
  </svg>
);
const DiscoverIcon = () => (
  // Compass glyph — discover/explore convention. Distinct from the
  // Library "books" icon so the two browseable surfaces don't blur
  // visually in the sidebar.
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm-1.42-6.58L6 16l2.58-4.58L13.16 9l-2.58 4.42zM12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1 1.1-.49 1.1-1.1-.49-1.1-1.1-1.1z" />
  </svg>
);
const SettingsIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
  </svg>
);

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
const CogIconSm = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Item groups
// ---------------------------------------------------------------------------

interface ItemMeta { id: NavView; label: string; icon: React.ReactNode }

const TOP_ITEMS: ItemMeta[] = [
  { id: "home",     label: "Home",     icon: <HomeIcon /> },
  { id: "library",  label: "Library",  icon: <LibraryIcon /> },
  { id: "discover", label: "Discover", icon: <DiscoverIcon /> },
  { id: "calendar", label: "Calendar", icon: <CalendarIcon /> },
  { id: "history",  label: "History",  icon: <HistoryIcon /> },
];
const BOTTOM_ITEMS: ItemMeta[] = [
  { id: "addons",   label: "Addons",   icon: <AddonsIcon /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon /> },
];

// ---------------------------------------------------------------------------
// NavSidebar
//
// Layout (top to bottom):
//   • A compact AuraLogoA + status dot — clicking opens the profile popover
//     (this is also the "home / brand" mark, replacing the bulky two-line
//     profile-card from earlier).
//   • A thin separator
//   • TOP_ITEMS (Home / Library / Calendar) — pill glow tracks active row
//   • flex-1 spacer
//   • BOTTOM_ITEMS (Addons / Settings)
// ---------------------------------------------------------------------------

export default function NavSidebar({
  active,
  onNavigate,
  userEmail,
  loggedIn: loggedInProp,
  userNickname,
  onLoginRequest,
  onLogout,
}: Props) {
  // Prefer the explicit `loggedIn` prop (driven by auth_key in App.tsx);
  // fall back to checking `userEmail` for older callers that don't pass
  // it. This matters because some users have a valid keyring session
  // with an empty email field, and we still want the UI to show them
  // as signed in.
  const loggedIn = loggedInProp ?? !!userEmail;
  const identityLabel = userEmail && userEmail.length > 0
    ? userEmail
    : (loggedIn ? "Stremio account" : null);
  const profileTitle = loggedIn
    ? `Signed in as ${userNickname ?? identityLabel ?? "Stremio account"}`
    : "Guest. Click to sign in.";

  // Profile popover open state
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    if (!profileOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInsidePopover = (target as HTMLElement)?.closest?.("[data-profile-popover]");
      const isProfileBtn    = (target as HTMLElement)?.closest?.("[data-profile-trigger]");
      if (!isInsidePopover && !isProfileBtn) setProfileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setProfileOpen(false); };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [profileOpen]);

  // Queue is a Library sub-tab — when it's the active view, the Library
  // pill should stay lit (Queue is conceptually nested under Library).
  // We transform `active` for index/highlight purposes only; the Queue
  // button itself still uses the raw active value to know it's the
  // selected sub-tab.
  const navActive: NavView = active === "queue" ? "library" : active;
  const bottomIdx = BOTTOM_ITEMS.findIndex((i) => i.id === navActive);

  // Bumped each time Queue is clicked — drives a brief shrink-then-
  // restore animation on the Queue row's pill so the click reads as a
  // distinct event (Queue is visually smaller than the other rows, so
  // a regular pill slide-in alone reads as muted).
  const [queueClickPulseId, setQueueClickPulseId] = useState(0);

  // Queue is a permanent visual child of Library — always rendered
  // directly below the Library row. The L-shape connector + indented
  // QueueSubRow signals the parent/child relationship.
  //
  // Pill index: the Queue row always occupies the slot immediately
  // after Library, so items below Library always shift +1.
  const libraryFlatIdx = TOP_ITEMS.findIndex((i) => i.id === "library");
  const flatIdxFor = (id: NavView): number => {
    const baseIdx = TOP_ITEMS.findIndex((i) => i.id === id);
    if (baseIdx < 0) return -1;
    if (baseIdx <= libraryFlatIdx) return baseIdx;
    return baseIdx + 1;
  };
  const topIdx = flatIdxFor(navActive);

  // When Queue is the active view, the standard active-pill needs to
  // sit on the Queue row instead of Library. Queue's button starts at
  // (libraryY + ROW_H_PX + QUEUE_TOP_GAP_PX), which doesn't align with
  // the regular SLOT_PX stride — so we override the pill's translateY
  // with this absolute pixel value when Queue is active.
  const queuePillY =
    libraryFlatIdx * SLOT_PX + ROW_H_PX + QUEUE_TOP_GAP_PX;

  return (
    <aside
      // `z-20` keeps the sidebar above content-area backgrounds (hero
      // carousel art, catalog cards). `relative` is required so the
      // absolutely-positioned decoration layer and profile popover are
      // scoped to this stacking context.
      className="relative z-20 self-center flex-shrink-0 flex flex-col w-[180px] px-2 py-3"
      aria-label="Navigation"
    >
      {/* ── Compact profile / brand button (anchored near top) ───────── */}
      <Tooltip text={profileTitle} pos="right">
        <button
          data-profile-trigger
          onClick={() => setProfileOpen((o) => !o)}
          aria-label={profileTitle}
          aria-expanded={profileOpen}
          className={`nav-tap mb-3 w-full flex items-center justify-start gap-3 px-3
                      rounded-xl transition-colors duration-150
                      bg-white/5 hover:bg-white/10 border border-white/10
                      ${profileOpen ? "ring-1 ring-ln-accent/50" : ""}`}
          style={{ height: ROW_H_PX }}
        >
          <span className="relative flex items-center justify-center w-9 h-9">
            <AuraLogoA size={32} />
            {/* Tiny status dot — green when signed in, neutral when guest. */}
            <span
              aria-hidden
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-[1.5px]
                          ${loggedIn
                            ? "bg-emerald-400 border-black/85"
                            : "bg-white/30 border-black/85"}`}
              style={{ boxShadow: loggedIn ? "0 0 6px rgba(110,231,183,0.65)" : undefined }}
            />
          </span>
          <span className="text-white/85 text-[13px] font-semibold tracking-[0.04em]">
            Aura
          </span>
        </button>
      </Tooltip>

      {/* ── Nav cluster ────────────────────────────────────────────── */}
      {/* TOP group with the Queue sub-row permanently in-flow directly
          below Library. The L-shape connector + indented row signals
          the parent/child relationship; no hover-to-reveal animation. */}
      <NavGroupWithSub
        items={TOP_ITEMS}
        active={navActive}
        activeIdx={topIdx}
        // When Queue is the active view, override the pill's y-offset
        // so it sits on the Queue row instead of Library. Otherwise
        // null, and the pill follows the regular activeIdx*SLOT_PX
        // stride for whichever top item is active.
        pillYOverride={active === "queue" ? queuePillY : null}
        onNavigate={onNavigate}
        renderSubAfter={(item) => {
          if (item.id !== "library") return null;
          return (
            <QueueSubRow
              active={active === "queue"}
              clickPulseId={queueClickPulseId}
              onClick={() => {
                setQueueClickPulseId((n) => n + 1);
                onNavigate("queue");
              }}
            />
          );
        }}
      />

      {/* Hairline divider between groups */}
      <div className="h-px bg-white/10 my-3 mx-2" />

      {/* BOTTOM group */}
      <NavGroup
        items={BOTTOM_ITEMS}
        active={active}
        activeIdx={bottomIdx}
        onNavigate={onNavigate}
      />

      {profileOpen && (
        <ProfilePopover
          loggedIn={loggedIn}
          email={userEmail}
          nickname={userNickname}
          onClose={() => setProfileOpen(false)}
          onSettings={() => { setProfileOpen(false); onNavigate("settings"); }}
          onLogin={() => { setProfileOpen(false); onLoginRequest?.(); }}
          onLogout={() => { setProfileOpen(false); onLogout?.(); }}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// NavGroup — single glowing pill tracks the active row.
//
// One absolutely-positioned `.aura-glow` pill slides to the active row
// via CSS transform. The buttons themselves are fully transparent at rest;
// hover gets a subtle bg-white/8 tint; active state is provided entirely
// by the pill behind — no button-level background change on active.
// ---------------------------------------------------------------------------

function NavGroup({
  items, active, activeIdx, onNavigate,
}: {
  items: ItemMeta[];
  active: NavView;
  activeIdx: number;
  onNavigate: (view: NavView) => void;
}) {
  return (
    <div className="relative">
      {/* ── Glowing pill — slides to whichever row is active ── */}
      <span
        aria-hidden
        className="aura-glow"
        style={{
          height: ROW_H_PX,
          opacity: activeIdx >= 0 ? 1 : 0,
          transform: `translateY(${Math.max(0, activeIdx) * SLOT_PX}px)`,
        }}
      />

      {/* ── Interactive buttons ── */}
      <div className="flex flex-col" style={{ gap: ROW_GAP_PX }}>
        {items.map((item) => (
          <NavRow
            key={item.id}
            label={item.label}
            icon={item.icon}
            active={active === item.id}
            onClick={() => onNavigate(item.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NavGroupWithSub — variant of NavGroup that allows injecting a sub-row
// after a specific item. Used by the Queue tab to render directly below
// Library. The pill index has to be adjusted by the caller to match the
// extra slot the sub-row consumes.
// ---------------------------------------------------------------------------

function NavGroupWithSub({
  items, active, activeIdx, onNavigate,
  renderSubAfter, pillYOverride,
}: {
  items: ItemMeta[];
  active: NavView;
  activeIdx: number;
  onNavigate: (view: NavView) => void;
  /** Optional sub-row to inject AFTER the given item. Return null /
   *  undefined to skip injection (no flex slot, no spacing). */
  renderSubAfter?: (item: ItemMeta) => React.ReactNode | null;
  /** Absolute pixel y-offset for the active pill, overriding the
   *  default activeIdx * SLOT_PX stride. Used when the active row is
   *  a sub-row (Queue) whose y-position doesn't fall on the regular
   *  stride boundary. Null means "use the default stride". */
  pillYOverride?: number | null;
}) {
  const pillY = pillYOverride ?? Math.max(0, activeIdx) * SLOT_PX;
  return (
    <div className="relative">
      <span
        aria-hidden
        className="aura-glow"
        style={{
          height: ROW_H_PX,
          opacity: (activeIdx >= 0 || pillYOverride != null) ? 1 : 0,
          transform: `translateY(${pillY}px)`,
        }}
      />

      <div className="flex flex-col" style={{ gap: ROW_GAP_PX }}>
        {items.map((item) => {
          const sub = renderSubAfter?.(item);
          return (
            <div key={item.id}>
              <NavRow
                label={item.label}
                icon={item.icon}
                active={active === item.id}
                onClick={() => onNavigate(item.id)}
              />
              {sub}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NavRow — transparent background; the .aura-glow pill behind supplies the
// active indicator. Active text/icon colour uses ln-accent so it reads
// cleanly against the pill's gradient.
// ---------------------------------------------------------------------------

interface RowProps {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}

// ---------------------------------------------------------------------------
// QueueSubRow — sub-tab nested under Library in the navigation. Renders
// indented to signal hierarchy, animates open from collapsed height
// when the parent group is hovered or Queue itself is the active view.
// Has its own active styling (background tint instead of the pill,
// since the pill belongs to the top group's index math).
// ---------------------------------------------------------------------------

// Vertical gap between Library and the Queue child row — slightly
// tighter than the standard inter-row gap to visually reinforce the
// parent/child relationship (about 10 % less vertical space).
const QUEUE_TOP_GAP_PX = Math.max(0, Math.round(ROW_GAP_PX * 0.9));

function QueueSubRow({
  active, onClick, clickPulseId,
}: {
  active: boolean;
  onClick: () => void;
  /** Bumped on every click — drives the brief shrink-then-restore
   *  pulse on the Queue button. Re-keying the inner element via
   *  `key={clickPulseId}` re-mounts it so the keyframes replay even
   *  on rapid consecutive clicks. */
  clickPulseId: number;
}) {
  return (
    <div
      style={{
        height: ROW_H_PX + ROW_GAP_PX,
        overflow: "hidden",
      }}
    >
      <div
        className="relative"
        style={{ height: ROW_H_PX, marginTop: QUEUE_TOP_GAP_PX }}
      >
        {/* L-shape connector — drawn from below the Library row's
            icon (top of this container) down + right into the Queue
            row's icon. Anchored absolutely so it doesn't shift the
            button's content. The vertical leg sits at the same
            horizontal centre as the parent's icon (≈ NavRow's
            `px-3` + half of icon width). */}
        <span
          aria-hidden
          className="absolute pointer-events-none border-l border-b border-white/20 rounded-bl-md"
          style={{
            left:   "1.05rem",
            top:    -QUEUE_TOP_GAP_PX,
            bottom: "50%",
            width:  "0.7rem",
          }}
        />
        {/* The button's own background tint is dropped now that the
            standard active-pill (.aura-glow) covers Queue when active.
            Click animation lives on a wrapper keyed by `clickPulseId`
            so each click remounts and replays the shrink keyframe. */}
        <div
          key={clickPulseId}
          className={clickPulseId > 0 ? "aura-queue-click-pulse" : ""}
        >
          <button
            onClick={onClick}
            aria-label="Queue"
            className={[
              "nav-tap relative w-full flex items-center gap-2.5 pl-8 pr-3 rounded-xl",
              "transition-colors duration-150",
              active
                ? "text-ln-accent"
                : "text-white/55 hover:text-white/90 hover:bg-white/[0.08]",
            ].join(" ")}
            style={{ height: ROW_H_PX }}
          >
            <span className="flex-shrink-0"><QueueIcon /></span>
            <span className="text-[12.5px] font-medium tracking-wide">Queue</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function NavRow({ label, icon, active, onClick }: RowProps) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`nav-tap relative flex items-center gap-3 px-3 rounded-xl
                  transition-all duration-150
                  ${active
                    ? "text-ln-accent"
                    : "text-white/60 hover:text-white/90 hover:bg-white/[0.08]"
                  }`}
      style={{ height: ROW_H_PX }}
    >
      <span className="flex-shrink-0">{icon}</span>
      <span className="text-[13.5px] font-medium tracking-wide">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ProfilePopover — anchored to the right of the sidebar.
// ---------------------------------------------------------------------------

function ProfilePopover({
  loggedIn, email, nickname, onClose, onSettings, onLogin, onLogout,
}: {
  loggedIn: boolean;
  email?: string | null;
  nickname?: string | null;
  onClose: () => void;
  onSettings: () => void;
  onLogin: () => void;
  onLogout: () => void;
}) {
  return (
    <div
      data-profile-popover
      role="dialog"
      aria-label="Profile"
      // bg-black/72 was bleeding the SearchBar text through the
      // popover. Bumped to /95 + an explicit solid backdrop layer so
      // the dialog reads cleanly at any z-stack depth without losing
      // the glass aesthetic.
      className="absolute top-2 left-full ml-3 w-[300px] z-50
                 rounded-2xl border border-white/15 shadow-glass-edge
                 bg-[rgba(12,12,16,0.96)] backdrop-blur-2xl"
      style={{ animation: "profile-pop-in 220ms cubic-bezier(0.34, 1.56, 0.64, 1)" }}
    >
      {/* Top — logo + identity */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-white/8">
        <span className="relative flex items-center justify-center w-12 h-12 rounded-full
                         bg-white/5 border border-white/10
                         shadow-[0_0_28px_rgba(91,164,255,0.25)]">
          <AuraLogoA size={36} />
          <span aria-hidden
                className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-black/75
                            ${loggedIn ? "bg-emerald-400" : "bg-white/30"}`}
                style={{ boxShadow: loggedIn ? "0 0 8px rgba(110,231,183,0.65)" : undefined }} />
        </span>
        <div className="flex-1 min-w-0 selectable">
          {(() => {
            // Three display states:
            //   • Guest          → "Guest mode" + "No Stremio account linked"
            //   • Logged in, email known      → "Stremio account" + email
            //   • Logged in, email missing    → "Stremio account" + "—" (no fake duplicate)
            // The duplicate "Stremio account / Stremio account" rendering
            // pre-0.6.17 was caused by passing the same placeholder as
            // both nickname and email; we now pass raw fields and let the
            // popover decide what to show.
            if (!loggedIn) {
              return (
                <>
                  <p className="text-white/95 text-sm font-semibold leading-tight truncate">Guest mode</p>
                  <p className="text-white/45 text-[11px] mt-0.5 truncate font-mono">No Stremio account linked</p>
                </>
              );
            }
            const hasEmail = !!email && email.length > 0;
            const topName  = nickname && nickname.length > 0 ? nickname : "Stremio account";
            return (
              <>
                <p className="text-white/95 text-sm font-semibold leading-tight truncate">{topName}</p>
                <p className="text-white/45 text-[11px] mt-0.5 truncate font-mono">
                  {hasEmail ? email : "Email pending sync"}
                </p>
              </>
            );
          })()}
        </div>
      </div>

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

      <div className="py-1">
        <PopoverButton icon={<CogIconSm />} label="Account settings" onClick={onSettings} />
        {loggedIn ? (
          <PopoverButton icon={<LogOutIcon />} label="Log out" danger onClick={onLogout} />
        ) : (
          <PopoverButton icon={<SignInIcon />} label="Sign in to Stremio" accent onClick={onLogin} />
        )}
      </div>

      <button
        onClick={onClose}
        className="absolute top-2 right-2 w-6 h-6 rounded-md text-white/40 hover:text-white
                   hover:bg-white/10 flex items-center justify-center text-sm"
        aria-label="Close"
      >
        ×
      </button>

      <style>{`
        @keyframes profile-pop-in {
          from { opacity: 0; transform: translateX(-6px) scale(0.96); }
          to   { opacity: 1; transform: translateX(0)     scale(1); }
        }
      `}</style>
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
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-[13px]
                  transition-colors
                  ${danger
                    ? "text-red-300/90 hover:bg-red-400/10"
                    : accent
                      ? "text-ln-accent hover:bg-ln-accent/10"
                      : "text-white/85 hover:bg-white/8"
                  }`}
    >
      <span className="flex-shrink-0 opacity-80">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
