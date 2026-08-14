// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { StremioAccount } from "./LoginView";
import AuraLogoA from "./AuraLogoA";
import { anchorFromRect, type PartyAnchor } from "./partyAnchor";

export type NavView = "home" | "library" | "queue" | "airing" | "addons" | "discover" | "live" | "calendar" | "history" | "settings";

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
const AiringIcon = () => (
  // Broadcast / on-air signal — a centre dot with concentric arcs, reading as
  // "currently airing". Stroke-drawn arcs (the sibling icons are filled; a
  // filled broadcast glyph reads muddy at this size).
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.9" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
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
const LiveIcon = () => (
  // TV/broadcast glyph — distinct from the Calendar and Library marks so
  // the live surface reads clearly in the sidebar.
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M21 6h-7.59l3.29-3.29L16 2l-4 4-4-4-.71.71L10.59 6H3c-1.1 0-2 .89-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V8c0-1.11-.9-2-2-2zm0 14H3V8h18v12z" />
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
// (CogIconSm removed — the popover's "Account settings" button it
//  iconed was replaced by inline account details + a "Manage on
//  Stremio" link in ProfilePopover.)

// ---------------------------------------------------------------------------
// Item groups
// ---------------------------------------------------------------------------

interface ItemMeta { id: NavView; label: string; icon: React.ReactNode }

const TOP_ITEMS: ItemMeta[] = [
  { id: "home",     label: "Home",     icon: <HomeIcon /> },
  { id: "library",  label: "Library",  icon: <LibraryIcon /> },
  { id: "discover", label: "Discover", icon: <DiscoverIcon /> },
  { id: "live",     label: "Live TV",  icon: <LiveIcon /> },
  { id: "calendar", label: "Calendar", icon: <CalendarIcon /> },
  { id: "history",  label: "History",  icon: <HistoryIcon /> },
];
const BOTTOM_ITEMS: ItemMeta[] = [
  { id: "addons",   label: "Addons",   icon: <AddonsIcon /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon /> },
];

// Sub-tabs nested under Library (indented, rendered directly below the Library
// row, top to bottom). Each consumes one pill SLOT_PX below Library.
const LIBRARY_SUBROWS: ItemMeta[] = [
  { id: "queue",  label: "Queue",  icon: <QueueIcon /> },
  { id: "airing", label: "Airing", icon: <AiringIcon /> },
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
  // Profile popover state and identity derivation moved to
  // <AccountButton /> in 0.6.18 — see src/AccountButton.tsx.
  // NavSidebar no longer needs loggedIn / email / nickname /
  // callbacks; those props remain on the Props interface only for
  // backward-compat with call sites that still pass them. They're
  // ignored here.
  void loggedInProp; void userEmail; void userNickname; void onLoginRequest; void onLogout;

  // Queue is a Library sub-tab — when it's the active view, the Library
  // pill should stay lit (Queue is conceptually nested under Library).
  // We transform `active` for index/highlight purposes only; the Queue
  // button itself still uses the raw active value to know it's the
  // selected sub-tab.
  const navActive: NavView = (active === "queue" || active === "airing") ? "library" : active;
  const bottomIdx = BOTTOM_ITEMS.findIndex((i) => i.id === navActive);

  // Bumped each time Queue is clicked — drives a brief shrink-then-
  // restore animation on the Queue row's pill so the click reads as a
  // distinct event (Queue is visually smaller than the other rows, so
  // a regular pill slide-in alone reads as muted).
  const [subClickPulse, setSubClickPulse] = useState<Record<string, number>>({});

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
    return baseIdx + LIBRARY_SUBROWS.length;
  };
  const topIdx = flatIdxFor(navActive);

  // When Queue is the active view, the standard active-pill needs to
  // sit on the Queue row instead of Library. Queue's button starts at
  // (libraryY + ROW_H_PX + QUEUE_TOP_GAP_PX), which doesn't align with
  // the regular SLOT_PX stride — so we override the pill's translateY
  // with this absolute pixel value when Queue is active.
  // A sub-row's active pill sits below the Library row: Library top + one row +
  // the tight top-gap, then one SLOT_PX per preceding sub-row.
  const subRowPillY = (subIndex: number): number =>
    libraryFlatIdx * SLOT_PX + ROW_H_PX + QUEUE_TOP_GAP_PX + subIndex * SLOT_PX;
  const activeSubIndex = LIBRARY_SUBROWS.findIndex((s) => s.id === active);

  return (
    <aside
      // `z-20` keeps the sidebar above content-area backgrounds (hero
      // carousel art, catalog cards). `relative` is required so the
      // absolutely-positioned decoration layer and profile popover are
      // scoped to this stacking context.
      // `aura-nav-rail` carries the SHORT-WINDOW reflow only. The rail centres
      // itself in the whole body, but the User Panel / Watch Party pills are
      // `fixed z-30` over x 20..184, y 44..130 - directly on top of this rail's
      // x-range and above its z-20. Once the window is short enough that
      // centring pushes the first nav rows up into that band, the Watch Party
      // pill sits on the Home row and eats its clicks. The rule is scoped to a
      // max-height media query so the layout above the threshold is unchanged.
      className="aura-nav-rail relative z-20 self-center flex-shrink-0 flex flex-col w-[180px] px-2 py-3"
      aria-label="Navigation"
    >
      {/* Profile button + popover moved out of the sidebar in
          0.6.18 — the Aura logo / account affordance now lives at
          the top-left of the app body via <AccountButton />,
          rendered alongside the bell + refresh from App.tsx. The
          sidebar starts at the nav cluster. */}

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
        pillYOverride={activeSubIndex >= 0 ? subRowPillY(activeSubIndex) : null}
        onNavigate={onNavigate}
        renderSubAfter={(item) => {
          if (item.id !== "library") return null;
          return (
            <>
              {LIBRARY_SUBROWS.map((sub, i) => (
                <SubRow
                  key={sub.id}
                  label={sub.label}
                  icon={sub.icon}
                  active={active === sub.id}
                  isLast={i === LIBRARY_SUBROWS.length - 1}
                  clickPulseId={subClickPulse[sub.id] ?? 0}
                  onClick={() => {
                    setSubClickPulse((p) => ({ ...p, [sub.id]: (p[sub.id] ?? 0) + 1 }));
                    onNavigate(sub.id);
                  }}
                />
              ))}
            </>
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

      {/* ProfilePopover invocation moved to <AccountButton />. */}
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

function SubRow({
  label, icon, active, isLast, onClick, clickPulseId,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  /** Last child under Library — its connector is a rounded L that stops
   *  at the icon. Earlier children draw a straight trunk that runs to the
   *  container edge so the whole spine reads as one continuous line. */
  isLast: boolean;
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
        {/* Tree connector into this child's icon. The vertical leg sits at
            the same horizontal centre as the parent's icon (≈ NavRow's
            `px-3` + half of icon width) and is anchored absolutely so it
            doesn't shift the button's content.

            The last child draws a single rounded L that stops at its icon
            centre. Earlier children draw a straight trunk that runs past
            the container edge (clipped by the outer `overflow: hidden`)
            plus a horizontal tick into the icon — so the next child's
            trunk, which starts at ITS container top, continues the same
            line and the whole spine reads as one unbroken trunk with a
            branch at each child instead of a stack of detached Ls. */}
        {isLast ? (
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
        ) : (
          <>
            <span
              aria-hidden
              className="absolute pointer-events-none border-l border-white/20"
              style={{ left: "1.05rem", top: -QUEUE_TOP_GAP_PX, bottom: "-1rem" }}
            />
            <span
              aria-hidden
              className="absolute pointer-events-none border-t border-white/20"
              style={{ left: "1.05rem", top: "50%", width: "0.7rem" }}
            />
          </>
        )}
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
            aria-label={label}
            className={[
              "nav-tap relative w-full flex items-center gap-2.5 pl-8 pr-3 rounded-xl",
              "transition-colors duration-150",
              active
                ? "text-ln-accent"
                : "text-white/55 hover:text-white/90 hover:bg-white/[0.08]",
            ].join(" ")}
            style={{ height: ROW_H_PX }}
          >
            <span className="flex-shrink-0">{icon}</span>
            <span className="text-[12.5px] font-medium tracking-wide">{label}</span>
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
      // `w-full` is what makes the hover background fill the same
      // footprint as the `.aura-glow` active pill (which is
      // absolute-positioned left:0 right:0 across the group). Without
      // it the hover bg only spanned the intrinsic icon+label width,
      // so Calendar / History / Discover hover looked tighter than
      // Queue (which has w-full in its sub-row variant).
      className={`nav-tap relative w-full flex items-center gap-3 px-3 rounded-xl
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
// ProfilePopover — hangs BELOW its trigger icon. It measures the trigger's
// box (passed as `triggerRef`) through partyAnchor's `anchorFromRect` — the
// same helper the Watch-Together panel/toasts use — so it seats itself a hair
// under the button, flips to the icon's side, and clamps its height to the
// viewport (overflow-y) rather than clipping off the top edge. Exported so the
// floating AccountButton (top-left of the app, below the title bar) reuses the
// same panel without forking the JSX.
// ---------------------------------------------------------------------------

// Exit-animation duration — the popover stays mounted this long after `open`
// flips false so it can collapse back into its trigger before unmounting.
// Keep in step with the transform/opacity transition below.
const PROFILE_EXIT_MS = 200;

export function ProfilePopover({
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
  // Mount + spawn/despawn lifecycle, mirrored from WatchTogetherPanel so the
  // popover grows out of / collapses back into the account button with the
  // SAME easing (the old CSS keyframe was a springy overshoot that read as
  // "snappy"). `render` keeps the card alive through the exit animation;
  // `visible` drives the enter/exit transition; `anchor` pins it under the
  // trigger (measured via partyAnchor's anchorFromRect — top-LEFT default).
  const [render, setRender] = useState(open);
  const [visible, setVisible] = useState(false);
  const [anchor, setAnchor] = useState<PartyAnchor>({ side: "left", top: 94, left: 12 });

  // On open: snapshot the anchor, mount, then flip `visible` on the next
  // frame so the transition runs from the collapsed state; re-pin on resize.
  // On close: flip `visible` off and unmount once the exit finishes.
  useEffect(() => {
    if (open) {
      const measure = () => {
        const el = triggerRef.current;
        if (el) setAnchor(anchorFromRect(el.getBoundingClientRect()));
      };
      measure();
      setRender(true);
      // Capture BOTH rAF handles: a close inside the ~16ms gap must not let
      // the inner frame fire setVisible(true) after the exit already began.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true));
      });
      window.addEventListener("resize", measure);
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
        window.removeEventListener("resize", measure);
      };
    }
    setVisible(false);
    const t = setTimeout(() => setRender(false), PROFILE_EXIT_MS);
    return () => clearTimeout(t);
  }, [open, triggerRef]);

  // Read-only Stremio account snapshot, baked directly into this popover (the
  // former separate "Account settings" panel was folded in here). Fetched on
  // open; the Rust command is cached 24h so each open is a cache hit.
  // Best-effort — failure just leaves the prop email.
  const [acct, setAcct] = useState<StremioAccount | null>(null);
  useEffect(() => {
    if (!open || !loggedIn) return;
    let cancelled = false;
    invoke<StremioAccount>("fetch_stremio_account")
      .then((a) => { if (!cancelled) setAcct(a); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, loggedIn]);

  if (!render) return null;

  const reduced = document.documentElement.getAttribute("data-reduced-motion") === "true";

  const monthYear = (iso: string | null | undefined): string | null => {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    return new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
  };

  const fetchedEmail = acct?.email && acct.email.length > 0 ? acct.email : null;
  const propEmail = email && email.length > 0 ? email : null;
  const shownEmail = fetchedEmail ?? propEmail;
  const since = monthYear(acct?.date_registered);
  const premium = monthYear(acct?.premium_until);
  const id = acct?.user_id ?? "";
  const acctId = id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : (id || null);

  return (
    <div
      data-profile-popover
      role="dialog"
      aria-label="Profile"
      // bg-black/72 was bleeding the SearchBar text through the
      // popover. Bumped to /95 + an explicit solid backdrop layer so
      // the dialog reads cleanly at any z-stack depth without losing
      // the glass aesthetic.
      className="fixed w-[300px] z-[10045] overflow-y-auto
                 rounded-2xl border border-white/15 shadow-glass-edge
                 aura-float-glass"
      style={{
        top: anchor.top,
        ...(anchor.side === "left" ? { left: anchor.left } : { right: anchor.right }),
        maxHeight: `calc(100vh - ${anchor.top + 16}px)`,
        transformOrigin: anchor.side === "left" ? "top left" : "top right",
        opacity: visible ? 1 : 0,
        // Grow out of / collapse back into the account button corner — same
        // easing as WatchTogetherPanel.
        transform: visible
          ? "translateY(0) scale(1)"
          : reduced ? "none" : "translateY(-8px) scale(0.96)",
        transition: reduced
          ? "opacity 160ms ease"
          : "opacity 200ms ease, transform 240ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
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

      {/* Account details — baked in (replaces the old separate panel). */}
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

      <div className="py-1">
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
