// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import Tooltip from "./Tooltip";
import { animateSpan, cancelSpan } from "./liquidGlass";
import { liquidActive } from "./glassStyle";

// ---------------------------------------------------------------------------
// ContextMenu — custom React-based right-click menu (singleton-style).
//
// The browser's native menu is OS-themed and breaks the glass aesthetic, so
// every consumer that wants a custom menu calls `e.preventDefault()` and then
// `openContextMenu(x, y, items)`. A single <ContextMenuHost /> mounted near
// the app root subscribes to a global custom event and renders one menu at a
// time. This avoids prop-threading the open/close state through every level
// of the tree.
//
// Item types:
//   • action   — clickable row; closes the menu after onClick fires
//   • submenu  — opens a child menu on hover or click
//   • divider  — horizontal rule, visually separates groups (no click)
//
// Tones:
//   default | success | warning | danger | notice | skip
//
// `skip` is purple on purpose and not a generic colour name: purple IS the skip
// colour everywhere else in Aura (the progress-bar segment, the History tag,
// the episode-row badge), so a skip action reading in any other colour breaks
// the one association the user has already learned.
// ---------------------------------------------------------------------------

export type MenuTone =
  | "default" | "success" | "warning" | "danger" | "notice" | "skip";

interface BaseItem {
  /** When true, the item is rendered greyed-out and ignores clicks. */
  disabled?: boolean;
  /** Explanatory hint shown on hover, as an instant glass tooltip (see
   *  MenuLabel). For items whose effect is not fully described by the label,
   *  e.g. a bulk action with a stopping rule. */
  hint?: string;
}

export interface ActionMenuItem extends BaseItem {
  kind?: "action";
  label: string;
  /** Optional 14-px icon node placed before the label. */
  icon?: React.ReactNode;
  /** Called when the user activates the item. The menu auto-closes after. */
  onClick: () => void;
  /** Visual tone — colours the label and hover background accordingly. */
  tone?: MenuTone;
  /** Legacy alias for tone="danger". Kept so older call sites keep working. */
  danger?: boolean;
  /** Optional hover-submenu. When provided, the row gains a chevron
   *  indicator and opens the listed items on hover. Clicking the row
   *  itself STILL fires `onClick` + closes the menu — distinct from a
   *  pure `kind: "submenu"` row, which has no clickable action of its
   *  own. Used for "clickable parent with bulk variants" patterns
   *  (watched-marks: click "Mark as Watched" to mark the clicked
   *  episode, OR hover the same row to reach "Mark this & below /
   *  above / all"). */
  submenu?: ContextMenuItem[];
}

export interface SubmenuMenuItem extends BaseItem {
  kind: "submenu";
  label: string;
  icon?: React.ReactNode;
  /** Items shown in the child menu when this row is hovered / clicked. */
  items: ContextMenuItem[];
}

export interface DividerMenuItem {
  kind: "divider";
}

export type ContextMenuItem = ActionMenuItem | SubmenuMenuItem | DividerMenuItem;

const MENU_MARGIN = 6; // px from viewport edge
const SUBMENU_GAP = 4; // px between parent edge and submenu
/** How long after hover before the submenu opens. Set to 0 so hover is
 *  effectively instant — earlier 120 ms felt unresponsive and broke
 *  the click path when fast clicks beat the timer. */
const SUBMENU_OPEN_DELAY_MS = 0;
/** How long after mouseleave before the submenu closes. Generous so
 *  the user can travel from the parent button to the submenu items
 *  through the small visual gap without the submenu vanishing. */
const SUBMENU_CLOSE_DELAY_MS = 250;

interface OpenDetail {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

// Direct global handler — see prior commit notes for why we don't use
// a CustomEvent bridge.
let _menuSetter: ((d: OpenDetail | null) => void) | null = null;

/** Trigger the singleton context menu. Call this from any onContextMenu
 *  handler after `e.preventDefault()`. */
export function openContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  if (items.length === 0) {
    console.warn("[ctx] openContextMenu called with empty items — menu won't show");
    return;
  }
  if (!_menuSetter) {
    console.warn(
      "[ctx] openContextMenu called but no ContextMenuHost is mounted — " +
        "this usually means HMR replaced the module and the host lost its " +
        "registration. Restart pnpm tauri dev or hard-reload the webview.",
    );
    return;
  }
  console.info(
    `[ctx] openContextMenu (${items.length} items) at (${x},${y})`,
  );
  _menuSetter({ x, y, items });
}

// ---------------------------------------------------------------------------
// ContextMenuHost — mount once near the app root.
// ---------------------------------------------------------------------------

function ContextMenuHost() {
  const [state, setState] = useState<OpenDetail | null>(null);

  useEffect(() => {
    console.info("[ctx] ContextMenuHost mounted — registering global setter");
    _menuSetter = setState;
    return () => {
      console.info("[ctx] ContextMenuHost unmounting — clearing global setter");
      if (_menuSetter === setState) _menuSetter = null;
    };
  }, []);

  const close = useCallback(() => setState(null), []);

  if (!state) return null;
  return <ContextMenuRender x={state.x} y={state.y} items={state.items} onClose={close} />;
}

// ---------------------------------------------------------------------------
// Tone styling — shared between the parent menu and submenus.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MenuLabel - a row's text, with its hint as an INSTANT GLASS tooltip.
//
// The hint used to be a native `title` attribute. Two problems, and the first
// is fatal for what these hints say: the OS waits about a second before showing
// one, which is longer than it takes to read a menu row and click it, so a hint
// explaining that "Mark this and all below as skipped" stops at the next canon
// episode routinely arrived after the user had already committed to the action.
// The second is that a native tooltip cannot be styled at all, so the one piece
// of explanatory text in the app rendered as an OS-grey box on top of a glass
// menu.
//
// Routed through the shared Tooltip, which is portal-rendered (so the menu's
// own clipping cannot eat it), collision-aware (menus open near screen edges by
// definition) and glass, matching every other floating surface in the app.
// ---------------------------------------------------------------------------
function MenuLabel({ hint, children }: { hint?: string; children: React.ReactNode }) {
  if (!hint) return <span className="flex-1 truncate">{children}</span>;
  return (
    <Tooltip text={hint} pos="right" className="flex-1 min-w-0">
      <span className="w-full truncate">{children}</span>
    </Tooltip>
  );
}

function rowToneClasses(tone: MenuTone, disabled: boolean | undefined): string {
  // Text colour only. The hover lives in styles/glass-chrome.css
  // (.aura-ctx-row[data-tone]): a tone tint in Frosted, the shared neutral
  // hover droplet in Liquid. A Tailwind hover:bg-* here would lose to the
  // glass row rule anyway (App.css loads after the utilities).
  if (disabled) return "text-white/25 cursor-not-allowed";
  switch (tone) {
    case "success":
      return "text-emerald-300/95";
    case "warning":
      return "text-amber-300/95";
    case "danger":
      return "text-rose-300/95";
    case "notice":
      return "text-ln-accent";
    // purple-300 text over a purple-400 tint: the same pair the skip segment
    // (bg-purple-400) and the skipped-episode tag (text-purple-300) already use.
    case "skip":
      return "text-purple-300/95";
    default:
      return "text-white/85";
  }
}

/** Row classes shared by the menu and the submenu. */
const ROW_CLS = "aura-glass-row aura-ctx-row relative w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px]";

// ---------------------------------------------------------------------------
// useMenuDroplet: Liquid's shared hover droplet for one menu. A single soft
// face slides between rows on the glass spring instead of each row painting
// its own fill (App.css drops the per-row hover inside [data-glass-droplet] in
// Liquid). Inert in Frosted. Event driven: one rect pair per row change,
// nothing per frame, and the spring is cancelled on unmount.
// ---------------------------------------------------------------------------

function useMenuDroplet() {
  const ref = useRef<HTMLSpanElement>(null);
  const lastRow = useRef<HTMLElement | null>(null);
  // Armed by the first REAL pointermove over the menu. A menu that opens (or
  // is clamped) under a stationary pointer gets a pointerover from Chromium's
  // layout-driven hover re-test with no pointermove; lighting a row then would
  // show a highlight the user never pointed at (native menus wait for a move).
  // Never reset by hide(), so leaving and re-entering keeps working.
  const moved = useRef(false);
  useEffect(() => {
    const el = ref.current;
    return () => { if (el) cancelSpan(el); };
  }, []);
  const hide = () => {
    lastRow.current = null;
    const hl = ref.current;
    if (!hl) return;
    // Stop a spring in flight where it is, so the fade runs (the flight holds
    // the CSS transitions off) instead of the droplet vanishing mid-move.
    cancelSpan(hl);
    hl.classList.remove("is-on");
  };
  const track = (e: React.PointerEvent<HTMLDivElement>) => {
    const hl = ref.current;
    if (!hl || !liquidActive()) return;
    const row = (e.target as Element).closest<HTMLElement>(".aura-ctx-row");
    if (!row || !e.currentTarget.contains(row)) return;
    if (row === lastRow.current) return;
    if ((row as HTMLButtonElement).disabled) { hide(); return; }
    const box = e.currentTarget.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    const a = r.top - box.top;
    animateSpan(hl, "y", { a, b: a + r.height }, { snap: !hl.classList.contains("is-on"), spring: "hover" });
    hl.classList.add("is-on");
    lastRow.current = row;
  };
  const onPointerOver = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!moved.current) return;
    track(e);
  };
  // Only the FIRST move tracks (it lights the row the pointer is resting on);
  // after that pointerover drives every row change, as before.
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (moved.current) return;
    moved.current = true;
    track(e);
  };
  return { ref, onPointerOver, onPointerMove, onPointerLeave: hide };
}

/** The pop morph grows from the corner the menu opened at: a menu flipped
 *  left or up by the viewport clamp grows from its right or bottom edge. */
function popOrigin(flippedX: boolean, flippedY: boolean): string {
  return `${flippedY ? "bottom" : "top"} ${flippedX ? "right" : "left"}`;
}

// ---------------------------------------------------------------------------
// Internal — render. Handles the parent menu plus one nested submenu at a
// time (Aura doesn't need deeper nesting; Open-in is the only use case).
// ---------------------------------------------------------------------------

interface RenderProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

function ContextMenuRender({ x, y, items, onClose }: RenderProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Open submenu — null when no submenu is up. Carries the parent row's
  // bounding rect so we can anchor the child menu next to it.
  const [openSub, setOpenSub] = useState<{ idx: number; rect: DOMRect } | null>(null);
  const subOpenTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const droplet = useMenuDroplet();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top  = y;
    if (left + rect.width  + MENU_MARGIN > vw) left = vw - rect.width  - MENU_MARGIN;
    if (top  + rect.height + MENU_MARGIN > vh) top  = vh - rect.height - MENU_MARGIN;
    if (left < MENU_MARGIN) left = MENU_MARGIN;
    if (top  < MENU_MARGIN) top  = MENU_MARGIN;
    setPos({ left, top });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      // Click outside both the parent and the submenu (if any) closes.
      if (ref.current?.contains(target)) return;
      const sub = document.querySelector("[data-aura-submenu]");
      if (sub && sub.contains(target)) return;
      onClose();
    };
    // Capture phase, and stopped there: the window-level Escape handlers (App's,
    // the catalog page's) would otherwise close the page under the menu too.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const cancelSubTimer = () => {
    if (subOpenTimer.current) {
      clearTimeout(subOpenTimer.current);
      subOpenTimer.current = null;
    }
  };

  const scheduleOpenSub = (idx: number, rect: DOMRect) => {
    cancelSubTimer();
    subOpenTimer.current = setTimeout(() => {
      setOpenSub({ idx, rect });
    }, SUBMENU_OPEN_DELAY_MS);
  };

  const scheduleCloseSub = () => {
    cancelSubTimer();
    subOpenTimer.current = setTimeout(() => {
      setOpenSub(null);
    }, SUBMENU_CLOSE_DELAY_MS);
  };

  return (
    <div
      ref={ref}
      role="menu"
      // CONTRACT: floating panels test for this with closest() to decide
      // whether an outside-click should dismiss them. A menu raised FROM a
      // panel row is not a DOM descendant of that panel (this host lives
      // elsewhere in the tree), so without a marker the first click on a menu
      // item would close the panel underneath it.
      data-aura-context-menu
      // aura-float-glass carries the background, border and shadow, so the
      // utilities that used to set those are gone rather than fighting it.
      // aura-glass-pop-in is the shared open morph (a droplet grow in Liquid,
      // a short fade and lift in Frosted); positioned by left/top, never by
      // transform, so the morph's transform cannot displace it.
      data-glass-droplet=""
      onPointerOver={droplet.onPointerOver}
      onPointerMove={droplet.onPointerMove}
      onPointerLeave={droplet.onPointerLeave}
      className="aura-float-glass aura-glass-pop-in fixed z-[200] min-w-[220px] py-1.5 rounded-xl select-none"
      style={{
        left: pos.left,
        top:  pos.top,
        ["--lg-origin" as string]: popOrigin(pos.left < x, pos.top < y),
        // Anchored at the pointer: the pop grows from the click corner with
        // NO lift. A lift slides the menu over the stationary pointer, which
        // unhovers the card under it and lights row 1 until the spring
        // settles (App.css aura-glass-pop-shape).
        ["--lg-pop-dy" as string]: "0px",
      }}
    >
      <span ref={droplet.ref} aria-hidden className="aura-glass-hl aura-ctx-hl" />
      {items.map((item, idx) => {
        if (item.kind === "divider") {
          return (
            <div
              key={`div-${idx}`}
              role="separator"
              className="h-px my-1 mx-2 bg-white/12"
            />
          );
        }
        if (item.kind === "submenu") {
          const isOpen = openSub?.idx === idx;
          return (
            <button
              key={`sub-${idx}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              disabled={item.disabled}
              onMouseEnter={(e) => {
                if (item.disabled) return;
                const rect = e.currentTarget.getBoundingClientRect();
                scheduleOpenSub(idx, rect);
              }}
              onMouseLeave={() => scheduleCloseSub()}
              onClick={(e) => {
                if (item.disabled) return;
                e.preventDefault();
                e.stopPropagation();
                // Click toggles the submenu — convenient for keyboard / touch.
                const rect = e.currentTarget.getBoundingClientRect();
                cancelSubTimer();
                console.info(`[ctx] submenu click idx=${idx} isOpen=${isOpen} → ${isOpen ? "close" : "open"}`);
                setOpenSub(isOpen ? null : { idx, rect });
              }}
              data-tone="default"
              className={`${ROW_CLS} ${rowToneClasses("default", item.disabled)}`}
            >
              {item.icon && <span className="flex-shrink-0 text-white/55">{item.icon}</span>}
              <MenuLabel hint={item.hint}>{item.label}</MenuLabel>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"
                   className="flex-shrink-0 text-white/40" aria-hidden>
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
              </svg>
            </button>
          );
        }
        // action — may also carry an optional hover-submenu (the
        // "clickable parent + bulk variants" pattern).
        const tone = item.tone ?? (item.danger ? "danger" : "default");
        const hasSubmenu = Array.isArray(item.submenu) && item.submenu.length > 0;
        const isOpen = hasSubmenu && openSub?.idx === idx;
        return (
          <button
            key={`act-${idx}`}
            role="menuitem"
            aria-haspopup={hasSubmenu ? "menu" : undefined}
            aria-expanded={hasSubmenu ? isOpen : undefined}
            disabled={item.disabled}
            onMouseEnter={(e) => {
              if (hasSubmenu && !item.disabled) {
                const rect = e.currentTarget.getBoundingClientRect();
                scheduleOpenSub(idx, rect);
              } else if (openSub) {
                // Hovering a non-submenu action closes any open submenu.
                scheduleCloseSub();
              }
            }}
            onMouseLeave={() => { if (hasSubmenu) scheduleCloseSub(); }}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onClose();
            }}
            data-tone={tone}
            className={`${ROW_CLS} ${rowToneClasses(tone, item.disabled)}`}
          >
            {item.icon && <span className="flex-shrink-0 opacity-90">{item.icon}</span>}
            <MenuLabel hint={item.hint}>{item.label}</MenuLabel>
            {hasSubmenu && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"
                   className="flex-shrink-0 text-white/40" aria-hidden>
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
              </svg>
            )}
          </button>
        );
      })}

      {openSub != null && (() => {
        const parent = items[openSub.idx];
        // Both a kind:"submenu" row and a kind:"action" row with a
        // non-empty `submenu` field can drive the child menu. Resolve
        // the items list from whichever variant is present.
        const subItems: ContextMenuItem[] | null =
          parent?.kind === "submenu"
            ? parent.items
            : (parent?.kind === "action" || parent?.kind === undefined) && Array.isArray((parent as ActionMenuItem).submenu)
              ? (parent as ActionMenuItem).submenu!
              : null;
        if (!subItems) return null;
        return createPortal(
          <Submenu
            parentRect={openSub.rect}
            items={subItems}
            onActivate={onClose}
            onMouseEnter={cancelSubTimer}
            onMouseLeave={scheduleCloseSub}
          />,
          document.body,
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Submenu — child menu anchored to the right of its parent row. Falls
// back to the LEFT of the parent menu when there isn't room.
//
// Portaled to document.body. The parent menu has a `transform` keyframe
// animation (the aura-glass-pop-in morph) which creates a containing block for any `position: fixed`
// descendants, so without the portal the submenu's left/top would be
// interpreted relative to the parent menu's transformed origin rather
// than the viewport — symptom: submenu lands far away from the parent
// row, often outside the visible area entirely.
// ---------------------------------------------------------------------------

interface SubmenuProps {
  parentRect: DOMRect;
  items: ContextMenuItem[];
  onActivate: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function Submenu({ parentRect, items, onActivate, onMouseEnter, onMouseLeave }: SubmenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const droplet = useMenuDroplet();
  const [pos, setPos] = useState<{ left: number; top: number }>({
    left: parentRect.right + SUBMENU_GAP,
    top:  parentRect.top,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = parentRect.right + SUBMENU_GAP;
    let top  = parentRect.top;
    if (left + r.width + MENU_MARGIN > vw) {
      // Flip to the left side of the parent menu.
      left = parentRect.left - r.width - SUBMENU_GAP;
    }
    if (top + r.height + MENU_MARGIN > vh) top = vh - r.height - MENU_MARGIN;
    if (left < MENU_MARGIN) left = MENU_MARGIN;
    if (top  < MENU_MARGIN) top  = MENU_MARGIN;
    setPos({ left, top });
  }, [parentRect.right, parentRect.left, parentRect.top]);

  return (
    <div
      ref={ref}
      role="menu"
      data-aura-submenu
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-glass-droplet=""
      onPointerOver={droplet.onPointerOver}
      onPointerMove={droplet.onPointerMove}
      onPointerLeave={droplet.onPointerLeave}
      className="aura-float-glass aura-glass-pop-in fixed z-[210] min-w-[220px] py-1.5 rounded-xl select-none"
      style={{
        left: pos.left,
        top:  pos.top,
        // Grows out of its parent row: from the left edge normally, from the
        // right edge when it flipped to the parent's left.
        ["--lg-origin" as string]: popOrigin(pos.left < parentRect.left, false),
        // Level with its parent row: no lift sliding it past the row's top.
        ["--lg-pop-dy" as string]: "0px",
      }}
    >
      <span ref={droplet.ref} aria-hidden className="aura-glass-hl aura-ctx-hl" />
      {items.map((item, idx) => {
        if (item.kind === "divider") {
          return <div key={`s-div-${idx}`} role="separator" className="h-px my-1 mx-2 bg-white/12" />;
        }
        if (item.kind === "submenu") {
          // Nested submenus are out of scope — render as a flat action that
          // expands inline. Aura's menu doesn't currently use this branch.
          return null;
        }
        const tone = item.tone ?? (item.danger ? "danger" : "default");
        return (
          <button
            key={`s-act-${idx}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              item.onClick();
              onActivate();
            }}
            data-tone={tone}
            className={`${ROW_CLS} ${rowToneClasses(tone, item.disabled)}`}
          >
            {item.icon && <span className="flex-shrink-0 opacity-90">{item.icon}</span>}
            <MenuLabel hint={item.hint}>{item.label}</MenuLabel>
          </button>
        );
      })}
    </div>
  );
}

// Memoized: App renders this host with no props (or only primitives / its own
// stable state) and re-renders on every playback-update tick. The host is
// driven by its own state and store subscriptions, so skipping those renders
// changes nothing on screen.
export default memo(ContextMenuHost);
