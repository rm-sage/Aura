// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// NavSidebar: the LEFT RAIL (Direction A, "Obsidian rail").
//
// ONE floating glass surface (`.aura-rail`, styles/glass-rail.css; the shared
// `.aura-float-glass.aura-glass-control` material, so Liquid and Frosted both
// apply), 204 px wide, 22 px corners, 12 px from the window edge. It is an
// in-flow flex item of the app body (App.tsx `flex gap-3 p-3`), hugs its
// content and centres vertically in the body under the title bar, so the page
// column starts at 228 px and nothing scrolls under it. Top to bottom
// (round 12: Notifications moved from the bottom to the very top):
//
//   - the Notifications row (NotificationsBell)
//   - hairline
//   - User Panel and Watch Party rows (AccountButton, PartyButton)
//   - hairline
//   - the nav: Home, Library (Queue and Airing sub-rows), Discover, Live TV,
//     Calendar, History, a divider, Addons, Settings
//
// Rows are list rows on the rail's one surface, never separate glass pills.
// ONE hover droplet (`.aura-glass-hl`, Liquid only) serves EVERY row on the
// rail (useRailDroplet), so it slides across the hairlines and the divider in
// both directions (it used to be one droplet per section: a move between two
// sections faded out in one and snapped in in the other). The nav's active row
// wears a nested inner pill (`.aura-rail-pill`, no backdrop pass: a backdrop
// inside the rail would sample only the rail). Popups opened from rows portal
// into a host beside the rail (RailRow `RailPopup`).
//
// The cursor-light system registers the rail by `data-glass-light="panel"`
// and the active pill by `data-glass-light="rim"`.
//
// Short windows: the row heights step down at two max-height breakpoints
// (glass-rail.css) and below those the nav section scrolls inside the rail, so
// the section rows above it always stay in view. Row geometry is MEASURED
// (offsetTop / offsetHeight for the pill, rects for the droplet), never
// derived from constants.
// ---------------------------------------------------------------------------

import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { animateSpan, cancelSpan } from "./liquidGlass";
import { liquidActive, reducedMotionActive } from "./glassStyle";
import AccountButton from "./AccountButton";
import PartyButton from "./PartyButton";
import NotificationsBell from "./NotificationsBell";
import { RailPopupHostContext } from "./RailRow";
import type { LibraryItem } from "./types";

export type NavView = "home" | "library" | "queue" | "airing" | "addons" | "discover" | "live" | "calendar" | "history" | "settings";

interface Props {
  /** The page whose row is lit; null lights none (Home showing search
   *  results: App's homeSearchActive, so Home does not read as selected). */
  active: NavView | null;
  onNavigate: (view: NavView) => void;
  /** Email of the signed-in user; null when guest. May be an empty string
   *  when the user has a valid auth_key but the email was never persisted
   *  (older Aura builds saved only auth_key): the popover falls back to a
   *  placeholder then. */
  userEmail?: string | null;
  /** Authoritative "signed in to a Stremio account" flag, driven by the
   *  presence of `session.auth_key`, not by `email`. */
  loggedIn?: boolean;
  /** Optional Stremio account nickname. Wins over the email initial. */
  userNickname?: string | null;
  /** Open the LoginView (the popover's "Sign in" for a guest). */
  onLoginRequest?: () => void;
  /** Sign the user out. */
  onLogout?: () => void;
  /** The library, for the Notifications panel's manual refresh. */
  library: LibraryItem[];
  /** A page covers the rail (an open Detail page): the cursor light skips
   *  it (`data-glass-covered`). Only the rail itself: its popups host stays
   *  lit (the notifications sheet sits above the Detail page). */
  covered?: boolean;
}

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
  // Bookmark glyph: same shape the planned-state badge uses, so the
  // Queue tab's icon visually corresponds to the per-item badge.
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
  </svg>
);
const AiringIcon = () => (
  // Broadcast / on-air signal: a centre dot with concentric arcs, reading as
  // "currently airing". Stroke-drawn arcs (the sibling icons are filled; a
  // filled broadcast glyph reads muddy at this size).
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.9" strokeLinecap="round" aria-hidden>
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
  </svg>
);
const DiscoverIcon = () => (
  // Compass glyph: discover/explore convention. Distinct from the
  // Library "books" icon so the two browseable surfaces don't blur
  // visually in the sidebar.
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm-1.42-6.58L6 16l2.58-4.58L13.16 9l-2.58 4.42zM12 10.9c-.61 0-1.1.49-1.1 1.1s.49 1.1 1.1 1.1 1.1-.49 1.1-1.1-.49-1.1-1.1-1.1z" />
  </svg>
);
const LiveIcon = () => (
  // TV/broadcast glyph: distinct from the Calendar and Library marks so
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

// ---------------------------------------------------------------------------
// Nav items, top to bottom. Sub-rows nest under Library (indented, with a tree
// connector); "divider" is the hairline between the browse group and
// Addons / Settings. All of them are ONE list with one pill and one droplet.
// ---------------------------------------------------------------------------

interface ItemMeta { id: NavView; label: string; icon: React.ReactNode; sub?: boolean }

const NAV_ITEMS: (ItemMeta | "divider")[] = [
  { id: "home",     label: "Home",     icon: <HomeIcon /> },
  { id: "library",  label: "Library",  icon: <LibraryIcon /> },
  { id: "queue",    label: "Queue",    icon: <QueueIcon />,  sub: true },
  { id: "airing",   label: "Airing",   icon: <AiringIcon />, sub: true },
  { id: "discover", label: "Discover", icon: <DiscoverIcon /> },
  { id: "live",     label: "Live TV",  icon: <LiveIcon /> },
  { id: "calendar", label: "Calendar", icon: <CalendarIcon /> },
  { id: "history",  label: "History",  icon: <HistoryIcon /> },
  "divider",
  { id: "addons",   label: "Addons",   icon: <AddonsIcon /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon /> },
];

/** Library's sub-views: the Library row reads as the lit PARENT while one of
 *  them is the page (accent label), the pill sits on the sub-row. */
const LIBRARY_SUBS: NavView[] = ["queue", "airing"];

// The rail renders as a child of App, which re-renders on every
// playback-update tick (the rail stays mounted, hidden, during playback) and
// passes fresh inline closures each time. The wrapper below hands the body
// stable callbacks that call the latest props, so the memoized body (the
// Notifications row and its open sheet, the account and party rows, every nav
// row) renders only when what it shows changes. Contexts and stores the rows
// subscribe to still re-render them directly.
export default function NavSidebar(props: Props) {
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const onNavigate = useCallback((view: NavView) => latest.current.onNavigate(view), []);
  const onLoginRequest = useCallback(() => latest.current.onLoginRequest?.(), []);
  const onLogout = useCallback(() => latest.current.onLogout?.(), []);
  return (
    <RailBody
      {...props}
      onNavigate={onNavigate}
      onLoginRequest={onLoginRequest}
      onLogout={onLogout}
    />
  );
}

const RailBody = memo(function RailBody({
  active,
  onNavigate,
  userEmail,
  loggedIn,
  userNickname,
  onLoginRequest,
  onLogout,
  library,
  covered,
}: Props) {
  // Where the rows' popups render: a host BESIDE the rail (see RailRow).
  const [popupHost, setPopupHost] = useState<HTMLDivElement | null>(null);
  // ONE Liquid hover droplet for every row on the rail (inert in Frosted).
  const railRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const droplet = useRailDroplet(railRef, navRef);

  return (
    <RailPopupHostContext.Provider value={popupHost}>
      <aside
        ref={railRef}
        className="aura-rail aura-float-glass aura-glass-control"
        data-aura-rail=""
        data-glass-light="panel"
        data-glass-covered={covered ? "" : undefined}
        // Liquid drops every row's own hover fill inside (App.css): the one
        // droplet below is the hover.
        data-glass-droplet=""
        aria-label="Navigation"
      >
        {/* The droplet: first, so the nav's active pill and every row paint
            over it. Positioned in the rail's own box (left and width inline),
            inside a clip of the rail's rounded padding box: a long slide
            overshoots its target row, and at the rail's ends that would
            poke out past the rail's edge. */}
        <span aria-hidden className="aura-rail-hlclip">
          <span ref={droplet.ref} className="aura-glass-hl aura-rail-hl" />
        </span>

        <div className="aura-rail-sec">
          <NotificationsBell library={library} />
        </div>

        <div className="aura-rail-hair" aria-hidden />

        <div className="aura-rail-sec">
          <AccountButton
            loggedIn={!!loggedIn}
            email={userEmail ?? null}
            nickname={userNickname ?? null}
            onLoginRequest={onLoginRequest}
            onLogout={onLogout}
          />
          <PartyButton />
        </div>

        <div className="aura-rail-hair" aria-hidden />

        <nav ref={navRef} className="aura-rail-nav" aria-label="Main">
          <NavList active={active} onNavigate={onNavigate} handoff={droplet.handoff} />
        </nav>
      </aside>
      {/* The popup host. `display: contents` and only fixed children, so it
          is never a flex item of the body (no extra gap), and it stays inside
          the body: hidden with it during playback, under the detail page. */}
      <div ref={setPopupHost} className="contents" data-rail-popups="" />
    </RailPopupHostContext.Provider>
  );
});

// ---------------------------------------------------------------------------
// NavList: the nav rows with the active pill and the hover droplet.
// ---------------------------------------------------------------------------

/** Bumped when the list's box changes size (a breakpoint changed the row
 *  heights, a font loaded), so the pill re-measures and snaps. */
const ListLayoutContext = createContext(0);

function NavList({ active, onNavigate, handoff }: {
  active: NavView | null;
  onNavigate: (view: NavView) => void;
  /** performance.now() of the last click on the droplet's row (useRailDroplet). */
  handoff: React.MutableRefObject<number>;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [layoutGen, setLayoutGen] = useState(0);
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    // The list (row heights stepped at a breakpoint) and the nav scroller (a
    // shorter window: the active row may need scrolling back into view).
    // Only fires on a real size change; the pill re-measures, it never polls.
    const ro = new ResizeObserver(() => setLayoutGen((g) => g + 1));
    ro.observe(list);
    if (list.parentElement) ro.observe(list.parentElement);
    return () => ro.disconnect();
  }, []);
  const parentLit = active !== null && LIBRARY_SUBS.includes(active);

  return (
    <ListLayoutContext.Provider value={layoutGen}>
      <div ref={listRef} className="aura-rail-list">
        {/* The active pill, under the rows (the rail's one hover droplet is
            NavSidebar's, under this pill). */}
        <NavPill listRef={listRef} activeId={active} handoff={handoff} />
        {/* Library's tree connector, over the pill and under the rows. */}
        <NavTree listRef={listRef} activeId={active} />
        {NAV_ITEMS.map((item, i) => {
          if (item === "divider") return <div key={`div-${i}`} className="aura-rail-div" aria-hidden />;
          return (
            <NavRow
              key={item.id}
              item={item}
              active={active === item.id}
              parentLit={item.id === "library" && parentLit}
              onClick={() => onNavigate(item.id)}
            />
          );
        })}
      </div>
    </ListLayoutContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// NavPill: the active-row indicator (`.aura-rail-pill`, the nested inner glass
// pill: a faint raised face with no backdrop pass, rim-lit by the cursor-light
// system through data-glass-light="rim"). Moved by liquidGlass.animateSpan,
// which writes translate + height inline: in Frosted a single write that the
// CSS transition animates (with the spatial overshoot), in Liquid two springs
// (leading edge fast, trailing edge slow) so the pill stretches toward the new
// row and settles. A re-layout (a breakpoint changing the row heights) snaps.
//
// Two twin pills, shown by `.is-on` (opacity + visibility). A pointer click on
// the row under the Liquid hover droplet HANDS OFF instead of flying: the
// spare twin snaps to the clicked row and fades in while the droplet and the
// old pill fade out, so the selection materialises where the pointer is.
// Keyboard and programmatic route changes keep the slide.
// ---------------------------------------------------------------------------

/** A route change this soon after a pointer click on the droplet's row is a hand-off. */
const HANDOFF_MS = 400;

function NavPill({ listRef, activeId, handoff }: {
  listRef: React.RefObject<HTMLDivElement | null>;
  activeId: NavView | null;
  /** performance.now() of the last hand-off click (useRailDroplet), 0 when none. */
  handoff: React.MutableRefObject<number>;
}) {
  const layoutGen = useContext(ListLayoutContext);
  const p0 = useRef<HTMLSpanElement>(null);
  const p1 = useRef<HTMLSpanElement>(null);
  const cur = useRef(0);
  const placed = useRef<NavView | null>(null);
  useLayoutEffect(() => {
    const pills = [p0.current, p1.current];
    const live = pills[cur.current], spare = pills[1 - cur.current];
    const clickedAt = handoff.current;
    handoff.current = 0;
    const list = listRef.current;
    if (!live || !spare || !list) return;
    const row = activeId ? list.querySelector<HTMLElement>(`[data-nav-id="${activeId}"]`) : null;
    if (!row) {
      // Fade out in place; the next appearance snaps.
      cancelSpan(live);
      live.classList.remove("is-on");
      placed.current = null;
      return;
    }
    const span = { a: row.offsetTop, b: row.offsetTop + row.offsetHeight };
    const moved = placed.current !== null && placed.current !== activeId;
    // A window short enough that the nav section scrolls: keep the active
    // row in view (a route change from a shortcut, or a resize).
    const scroller = list.parentElement;
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
      const sr = scroller.getBoundingClientRect(), rr = row.getBoundingClientRect();
      const pad = 6;
      if (rr.top < sr.top + pad) scroller.scrollTop -= sr.top + pad - rr.top;
      else if (rr.bottom > sr.bottom - pad) scroller.scrollTop += rr.bottom - (sr.bottom - pad);
    }
    if (moved && clickedAt > 0 && performance.now() - clickedAt < HANDOFF_MS
        && liquidActive() && !reducedMotionActive()) {
      animateSpan(spare, "y", span, { snap: true });
      spare.classList.add("is-on");
      cancelSpan(live);
      live.classList.remove("is-on");
      cur.current = 1 - cur.current;
    } else {
      // First placement and a re-layout snap; a route change slides.
      animateSpan(live, "y", span, { snap: !moved });
      live.classList.add("is-on");
    }
    placed.current = activeId;
  }, [activeId, layoutGen, listRef, handoff]);
  useEffect(() => {
    const a = p0.current, b = p1.current;
    return () => {
      if (a) cancelSpan(a);
      if (b) cancelSpan(b);
    };
  }, []);
  return (
    <>
      <span ref={p0} aria-hidden className="aura-rail-pill" data-glass-light="rim" />
      <span ref={p1} aria-hidden className="aura-rail-pill" data-glass-light="rim" />
    </>
  );
}

// ---------------------------------------------------------------------------
// NavTree: Library's tree connector (2026-11-25; the user: "redesign the click
// animation to be more cohesive with the physics based light theme of the
// app"). One SVG over the list, under the rows: the trunk from Library's
// bottom edge, a tick into every sub-row's icon and a rounded L into the last.
// It used to be each sub-row's ::before / ::after, so the lines moved with the
// row: a click played a 280 ms scale(0.92) pulse on the row (a Material curve,
// the one off-vocabulary motion in the rail) that threw the trunk about 6 px
// right and back. Now the lines never move, and a click on a sub-row sends
// LIGHT along them instead: a cool-white glint with the cursor light's blue
// fringe (glassGlint.ts / aura-glass-rim.js colours) runs from Library down
// the trunk into the clicked row on the snappy spring (--aura-spring-snappy,
// sampled from the k600/c38 spring, close to the pill's leading edge), fading
// in and out on the cursor light's curves, and leaves the branch to the
// active child lit (it never showed which child was active). From one sibling
// to the other only the new stretch runs. Leaving Library's family fades the
// branch out. Reduced motion: no run, the branch crossfades. High Contrast: no
// glint, a brighter branch (glass-rail.css "Tree connector").
//
// Every coordinate is snapped to the device pixel grid in PAGE space (the
// rail's top can sit on a half pixel), so the 1 px lines stay as crisp as the
// borders they replace. Written imperatively: React renders the empty paths.
// ---------------------------------------------------------------------------

/** The connector's geometry in the sub-row (as the old pseudo-elements). */
const TREE_X = 16.8, TREE_TICK = 9, TREE_R = 6;
/** The glint's three strokes (dash lengths, CSS px) and the blue fringe's lag. */
const GLINT_TAIL = 22, GLINT_HALO = 14, GLINT_CORE = 7, GLINT_DISP_LAG = 1;
/** The lit branch's crossfade (the pill's own fade in Liquid). */
const TREE_FADE_MS = 220;

interface TreeGeom {
  key: string;
  base: string;
  /** Per sub-row: its tick's y, and its branch from a point on the trunk. */
  subs: Map<NavView, { y: number; from: (y: number) => string }>;
  top: number;
}

function cssMs(name: string, fallback: number): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? (v.endsWith("s") && !v.endsWith("ms") ? n * 1000 : n) : fallback;
}

function NavTree({ listRef, activeId }: {
  listRef: React.RefObject<HTMLDivElement | null>;
  activeId: NavView | null;
}) {
  const layoutGen = useContext(ListLayoutContext);
  const svgRef = useRef<SVGSVGElement>(null);
  const baseRef = useRef<SVGPathElement>(null);
  const lit0 = useRef<SVGPathElement>(null);
  const lit1 = useRef<SVGPathElement>(null);
  const glintRef = useRef<SVGGElement>(null);
  const halo = useRef<SVGPathElement>(null);
  const tail = useRef<SVGPathElement>(null);
  const disp = useRef<SVGPathElement>(null);
  const core = useRef<SVGPathElement>(null);
  const geom = useRef<TreeGeom | null>(null);
  const cur = useRef(0);
  const shown = useRef<NavView | null>(null);
  const runs = useRef<Animation[]>([]);
  // The rail moves with the window (it is centred) without changing size, so
  // the pixel snap is redone on a window resize too.
  const [winGen, setWinGen] = useState(0);
  useEffect(() => {
    const f = () => setWinGen((g) => g + 1);
    window.addEventListener("resize", f);
    return () => window.removeEventListener("resize", f);
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current, base = baseRef.current;
    const lits = [lit0.current, lit1.current];
    if (!list || !base || !lits[0] || !lits[1]) return;
    // ---- geometry -------------------------------------------------------
    const lib = list.querySelector<HTMLElement>('[data-nav-id="library"]');
    const subEls = LIBRARY_SUBS.map((id) => list.querySelector<HTMLElement>(`[data-nav-id="${id}"]`));
    let g: TreeGeom | null = null;
    if (lib && subEls.every(Boolean)) {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.floor(dpr));
      const sw = w / dpr;
      const o = list.getBoundingClientRect();
      // The svg is painted at its box's origin ROUNDED to the device grid
      // (a replaced element), and a border edge at v lands on device pixel
      // round(v): so a line drawn where the old border was is centred on
      // that pixel, counted from the svg's rounded origin. Measured against
      // the old pseudo-element borders (scratchpad tree/ab): flooring, or
      // counting from the unrounded origin (the rail's top sits on a half
      // pixel), moved the trunk a column left and split the ticks across two
      // rows.
      const ox = Math.round(o.left * dpr), oy = Math.round(o.top * dpr);
      const devX = (v: number) => Math.round((o.left + v) * dpr + 1e-3);
      const devY = (v: number) => Math.round((o.top + v) * dpr + 1e-3);
      const x = (devX((subEls[0] as HTMLElement).offsetLeft + TREE_X) - ox + w / 2) / dpr;
      const top = (devY(lib.offsetTop + lib.offsetHeight) - oy) / dpr;
      const n = (v: number) => +v.toFixed(3);
      const subs = new Map<NavView, { y: number; from: (y: number) => string }>();
      // Each branch from a point on the trunk: down to its tick, then right
      // (the last one round a TREE_R elbow, as the old L's border radius).
      const parts: string[] = [];
      for (let i = 0; i < LIBRARY_SUBS.length; i++) {
        const el = subEls[i] as HTMLElement;
        const last = i === LIBRARY_SUBS.length - 1;
        // A tick was a border-top at the row's middle (its first pixel there);
        // the L's foot a border-bottom ending there (its last pixel above).
        const y = (devY(el.offsetTop + el.offsetHeight / 2) - (last ? w : 0) - oy + w / 2) / dpr;
        const r = Math.max(0, Math.min(TREE_R, y - top));
        const from = last
          ? (y0: number) => `M${n(x)} ${n(y0)}V${n(y - r)}A${r} ${r} 0 0 0 ${n(x + r)} ${n(y)}H${n(x + TREE_TICK)}`
          : (y0: number) => `M${n(x)} ${n(y0)}V${n(y)}H${n(x + TREE_TICK)}`;
        subs.set(LIBRARY_SUBS[i], { y, from });
        // The whole trunk comes with the last branch; the others add a tick.
        parts.push(last ? from(top) : `M${n(x)} ${n(y)}H${n(x + TREE_TICK)}`);
      }
      const d = parts.join("");
      g = { key: `${d}|${sw}`, base: d, subs, top };
      svgRef.current?.style.setProperty("--tree-sw", `${n(sw)}px`);
    }
    const prevGeom = geom.current;
    geom.current = g;
    if (!g) { base.setAttribute("d", ""); for (const l of lits) l?.setAttribute("d", ""); return; }
    if (!prevGeom || prevGeom.key !== g.key) base.setAttribute("d", g.base);

    // ---- the lit branch and the glint -------------------------------------
    const prev = shown.current;
    const next = activeId && g.subs.has(activeId) ? activeId : null;
    shown.current = next;
    const finishRuns = () => { for (const a of runs.current) a.cancel(); runs.current = []; };
    // A re-layout or the first placement: draw the state, no motion.
    if (prev === next || !prevGeom) {
      if (prevGeom && prevGeom.key === g.key) return;
      finishRuns();
      const live = lits[cur.current] as SVGPathElement, spare = lits[1 - cur.current] as SVGPathElement;
      spare.setAttribute("d", ""); spare.style.opacity = "0";
      live.setAttribute("d", next ? g.subs.get(next)!.from(g.top) : "");
      live.style.opacity = next ? "1" : "0";
      live.style.strokeDasharray = "";
      return;
    }
    finishRuns();
    const reduced = reducedMotionActive();
    const old = lits[cur.current] as SVGPathElement;
    // Where the old branch and the new one part: the trunk above it stays lit.
    const shared = prev && next ? Math.min(g.subs.get(prev)!.y, g.subs.get(next)!.y) : g.top;
    if (prev) {
      // Only the old branch's own stretch fades (from the parting point on).
      old.setAttribute("d", g.subs.get(prev)!.from(next ? shared : g.top));
      old.style.opacity = "0";
      runs.current.push(old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TREE_FADE_MS, easing: "ease-out" }));
    }
    if (!next) return;
    cur.current = 1 - cur.current;
    const lit = lits[cur.current] as SVGPathElement;
    const d = g.subs.get(next)!.from(g.top);
    lit.setAttribute("d", d);
    lit.style.opacity = "1";
    lit.style.strokeDasharray = "";
    if (reduced) {
      runs.current.push(lit.animate([{ opacity: 0 }, { opacity: 1 }], { duration: TREE_FADE_MS, easing: "ease-out" }));
      return;
    }
    // The run: the head travels from the parting point to the tick's end.
    const L = lit.getTotalLength();
    const s0 = Math.max(0, shared - g.top);
    const root = getComputedStyle(document.documentElement);
    const easing = root.getPropertyValue("--aura-spring-snappy").trim() || "cubic-bezier(0.25, 1.1, 0.4, 1)";
    const dur = cssMs("--aura-spring-snappy-dur", 320);
    const timing: KeyframeAnimationOptions = { duration: dur, easing };
    // The branch lights up behind the head: one dash ending at the head and
    // reaching back past the path's start (D > 2L), so the spring's overshoot
    // (the snappy curve peaks at 1.02) never pulls its start off the trunk's
    // root, as a dash starting at 0 did.
    const D = 2 * L + 40;
    const dash = `${n3(D)} ${n3(D)}`;
    runs.current.push(lit.animate(
      [{ strokeDasharray: dash, strokeDashoffset: n3(D - s0) }, { strokeDasharray: dash, strokeDashoffset: n3(D - L) }], timing));
    // A dash of length `len` whose head is at distance s: offset len - s.
    const strokes: [SVGPathElement | null, number, number][] = [
      [halo.current, GLINT_HALO, 0], [tail.current, GLINT_TAIL, 0], [disp.current, GLINT_CORE, GLINT_DISP_LAG], [core.current, GLINT_CORE, 0],
    ];
    for (const [p, len, lag] of strokes) {
      if (!p) continue;
      p.setAttribute("d", d);
      const da = `${len} ${n3(L + len + 20)}`;
      runs.current.push(p.animate(
        [{ strokeDasharray: da, strokeDashoffset: n3(len - s0 + lag) }, { strokeDasharray: da, strokeDashoffset: n3(len - L + lag) }],
        { ...timing, fill: "forwards" }));
    }
    // The glint's fade: the cursor light's (260 ms ease-out cubic in, 600 ms
    // in-out sine out), out from the moment the head lands.
    const glint = glintRef.current;
    if (glint) {
      const total = dur + 600;
      runs.current.push(glint.animate([
        { opacity: 0, easing: "cubic-bezier(0.33, 1, 0.68, 1)" },
        { opacity: 1, offset: Math.min(260, dur) / total },
        { opacity: 1, offset: dur / total, easing: "cubic-bezier(0.37, 0, 0.63, 1)" },
        { opacity: 0 },
      ], { duration: total, fill: "forwards" }));
    }
  }, [activeId, layoutGen, winGen, listRef]);

  useEffect(() => () => { for (const a of runs.current) a.cancel(); }, []);

  return (
    <svg ref={svgRef} className="aura-rail-tree" aria-hidden focusable="false">
      <path ref={baseRef} className="aura-rail-tree-base" />
      <path ref={lit0} className="aura-rail-tree-lit" />
      <path ref={lit1} className="aura-rail-tree-lit" />
      <g ref={glintRef} className="aura-rail-tree-glint" style={{ opacity: 0 }}>
        <path ref={halo} className="is-halo" />
        <path ref={tail} className="is-tail" />
        <path ref={disp} className="is-disp" />
        <path ref={core} className="is-core" />
      </g>
    </svg>
  );
}

const n3 = (v: number) => +v.toFixed(3);

// ---------------------------------------------------------------------------
// useRailDroplet: Liquid's hover droplet (.aura-glass-hl) for the WHOLE rail.
// One faint face under every row (Notifications, User Panel, Watch Party and
// the nav) that slides to the row under the pointer on the hover spring,
// across the hairlines and the nav's divider, in both directions. It used to
// be three droplets (one per section): crossing a hairline left one list
// (its droplet faded out) and entered another (its droplet snapped in), so
// Settings <-> Notifications never slid while History <-> Addons did.
//
// Positioned in the rail's padding box (inside `.aura-rail-hlclip`, the
// rail's first child, under the pill and the rows, which clips a slide's
// overshoot to the rail's rounded box): `translate` + `height` through animateSpan, `left` +
// `width` inline from the row's rect (a nav row is narrower while the nav
// shows a scrollbar). A nav row is CLAMPED to the nav scroller's box, so the
// droplet never paints past the scroller's clip on a short window, and it
// follows its row while the nav scrolls.
//
// Over the active nav row (the pill marks it) the droplet slides there and
// fades out under the pill; from there it slides out again to the next row,
// so even the active row never breaks the motion. A click fades it out in
// place (and, on the droplet's own nav row, hands off to the pill: NavPill);
// it lights again when the pointer reaches another row. Leaving the rail
// fades it out where it is, and the next entry snaps it in.
//
// Native listeners on the rail, not React handlers: the rows' popups are
// React children portalled OUT of the rail (RailPopup), and React bubbles
// their events (and computes pointerleave) through the React tree, so a
// pointer on the notifications sheet would still count as "in the rail".
// Driven by pointermove only (a closest() per move, one rect pair per row
// CHANGE), so a pointerover from a re-layout under a still pointer never
// lights a row. Inert in Frosted (rows keep their own hover fill there).
// ---------------------------------------------------------------------------

function useRailDroplet(
  railRef: React.RefObject<HTMLElement | null>,
  navRef: React.RefObject<HTMLElement | null>,
) {
  const ref = useRef<HTMLSpanElement>(null);
  const handoff = useRef(0);
  useEffect(() => {
    const rail = railRef.current, hl = ref.current, nav = navRef.current;
    if (!rail || !hl) return;
    /** The row the droplet is on (lit, or faded out on it after a click or
     *  under the pill). */
    let row: HTMLElement | null = null;
    /** The droplet's span sits on a real row right now, so the next row
     *  slides from it (false after leaving the rail: the next entry snaps). */
    let anchored = false;
    let lastLeft = "", lastWidth = "";

    const rowAt = (t: EventTarget | null): HTMLElement | null => {
      const r = (t as Element | null)?.closest?.<HTMLElement>(".aura-nav-row") ?? null;
      return r && rail.contains(r) ? r : null;
    };
    /** Moves the droplet onto `r`; false when `r` is scrolled fully out. */
    const place = (r: HTMLElement, snap: boolean): boolean => {
      const box = rail.getBoundingClientRect();
      const rr = r.getBoundingClientRect();
      let top = rr.top, bottom = rr.bottom;
      if (nav && nav.contains(r)) {
        const nr = nav.getBoundingClientRect();
        top = Math.max(top, nr.top);
        bottom = Math.min(bottom, nr.bottom);
      }
      if (bottom - top < 2) return false;
      // The padding box is the containing block: offsets from the border's
      // inner edge.
      const left = `${(rr.left - box.left - rail.clientLeft).toFixed(2)}px`;
      const width = `${rr.width.toFixed(2)}px`;
      if (left !== lastLeft) { hl.style.left = left; lastLeft = left; }
      if (width !== lastWidth) { hl.style.width = width; lastWidth = width; }
      const a = top - box.top - rail.clientTop;
      animateSpan(hl, "y", { a, b: a + (bottom - top) }, { snap, spring: "hover" });
      return true;
    };
    const hide = () => {
      row = null;
      anchored = false;
      // Stop a spring in flight where it is, so the droplet fades in place.
      cancelSpan(hl);
      hl.classList.remove("is-on");
    };
    const onMove = (e: PointerEvent) => {
      if (!liquidActive()) return;
      const r = rowAt(e.target);
      if (!r || r === row) return;
      if (!place(r, !anchored)) { hide(); return; }
      anchored = true;
      row = r;
      // The active row already wears the pill: the droplet rides under it,
      // faded out, ready to slide out to the next row.
      hl.classList.toggle("is-on", r.getAttribute("aria-current") !== "page");
    };
    const onClick = (e: MouseEvent) => {
      const r = rowAt(e.target);
      if (!r) return;
      // A click on the row the droplet sits on: NavPill hands the droplet off
      // to the pill at that row instead of flying the pill from the old one.
      if (r === row && hl.classList.contains("is-on")) handoff.current = performance.now();
      cancelSpan(hl);
      hl.classList.remove("is-on");
      // Stays on this row (faded): it lights again on the next row, sliding
      // from here.
      row = r;
    };
    // The nav scrolled under the droplet: follow its row (snapped, clamped to
    // the scroller); a row scrolled fully out hides it.
    const onNavScroll = () => {
      if (!row || !anchored || !nav || !nav.contains(row)) return;
      if (!place(row, true)) hide();
    };
    rail.addEventListener("pointermove", onMove, { passive: true });
    rail.addEventListener("pointerleave", hide);
    rail.addEventListener("click", onClick);
    nav?.addEventListener("scroll", onNavScroll, { passive: true });
    return () => {
      rail.removeEventListener("pointermove", onMove);
      rail.removeEventListener("pointerleave", hide);
      rail.removeEventListener("click", onClick);
      nav?.removeEventListener("scroll", onNavScroll);
      cancelSpan(hl);
    };
  }, [railRef, navRef]);
  return { ref, handoff };
}

// ---------------------------------------------------------------------------
// NavRow: transparent; the pill behind supplies the active indicator and the
// label colour comes from glass-rail.css (accent in Frosted, accent 34% over
// white in Liquid). A sub-row is indented under Library (`.aura-rail-sub`); its
// tree connector is NavTree's, drawn over the list, not part of the row.
// ---------------------------------------------------------------------------

function NavRow({ item, active, parentLit, onClick }: {
  item: ItemMeta;
  active: boolean;
  /** Library while one of its sub-views is the page. */
  parentLit: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-nav-id={item.id}
      onClick={onClick}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      data-parent-lit={parentLit ? "" : undefined}
      className={[
        "aura-rail-row aura-nav-row nav-tap",
        item.sub ? "aura-rail-sub" : "aura-rail-navrow",
      ].join(" ")}
    >
      <span className="aura-rail-icon">{item.icon}</span>
      <span className="aura-rail-label">{item.label}</span>
    </button>
  );
}
