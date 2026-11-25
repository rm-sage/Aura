// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNotifications, type Notification } from "./NotificationsContext";
import NotificationsPanel, {
  NotifThumb,
  RailBridge,
  notifDetail,
  notifPosterUrl,
  notifTitle,
  railOrigin,
  railPopupTop,
} from "./NotificationsPanel";
import { nudgeReleasePoller } from "./releaseSearch";
import { loadAuraSettings } from "./auraSettings";
import type { LibraryItem } from "./types";
import RailRow, { RailPopup } from "./RailRow";
import { useRailAnchor, type RailAnchor } from "./railLayout";
import { usePopPresence } from "./popPresence";
import { playRepeat } from "./AppToast";
import { reducedMotionActive } from "./glassStyle";

// ---------------------------------------------------------------------------
// NotificationsBell: the rail's "Notifications" row (its TOP row since round
// 12, NavSidebar), plus the two surfaces that grow out of it (round 10):
//
//   - the side sheet (NotificationsPanel), opened by the row;
//   - the ARRIVAL BUBBLE: when something new lands with the sheet closed, a
//     compact preview (poster, title, one line) grows out of the row to the
//     right (top flush with the rail's top, growing downward), holds, and
//     retracts back into it. Arrivals in quick succession
//     MERGE into it (a count and AppToast's repeat bump), never stack.
//     Clicking it opens the sheet at that item.
//
// Both seat themselves beside the rail, top flush with the rail's top
// (railLayout `useRailAnchor`, NotificationsPanel `railPopupTop`), grow
// downward from the row's middle on the rail's edge,
// and are portalled out of the rail (RailPopup) so its backdrop-filter neither
// positions nor clips them. A light bridge (RailBridge) ties the bubble to the
// row; the sheet has none (round 17, user's call).
//
// The row itself: an unread count badge, a very faint STATIC wash while a
// dismissable item is unread (nothing loops), and on each arrival one accent
// light sweep across the row with the badge popping in sync.
//
// Click-out: a global mousedown listener with `closest()` checks for the row or
// the sheet via data attributes (and spares the context menu).
// ---------------------------------------------------------------------------

/** The sheet's close transition (styles/glass-notify.css `.aura-notif-sheet`).
 *  usePopPresence keeps it mounted this long after a close. */
const PANEL_CLOSE_MS = 220;
/** Refresh-button cooldown: respects the cloud's per-IP nudge rate limit. */
const REFRESH_COOLDOWN_MS = 2000;
/** The row's arrival sweep (styles/glass-notify.css `aura-notif-sweep`). */
const SWEEP_MS = 1150;

const NO_IDS: ReadonlySet<string> = new Set();

export default function NotificationsBell({ library }: { library: LibraryItem[] }) {
  const {
    notifications, unreadCount, popup, popupCount, dismissPopup, markRead, markAllRead,
  } = useNotifications();
  const [open, setOpen] = useState(false);
  /** Unread when the sheet opened (see NotificationsPanel `newIds`). */
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(NO_IDS);
  /** The item the sheet should land on (from the bubble). */
  const [focusId, setFocusId] = useState<string | null>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  const badgeRef = useRef<HTMLSpanElement | null>(null);

  const openPanel = useCallback((at?: string) => {
    setNewIds(new Set(notifications.filter((n) => !n.read && !n.dismissed).map((n) => n.id)));
    setFocusId(at ?? null);
    setOpen(true);
  }, [notifications]);

  const requestClose = useCallback(() => {
    // Focus inside the sheet goes back to the row, not to <body>.
    const panel = document.querySelector("[data-notifications-panel]");
    if (panel && panel.contains(document.activeElement)) {
      rowRef.current?.focus({ preventScroll: true });
    }
    setOpen(false);
  }, []);

  const togglePanel = useCallback(() => {
    if (open) requestClose();
    else openPanel();
  }, [open, openPanel, requestClose]);

  // Opening the sheet is a global mark-read: whatever the user sees there counts
  // as seen for the badge (the sheet keeps its own `newIds` snapshot to mark
  // them). In an effect on the open transition, NOT inside a state updater:
  // updaters run during render, and a NotificationsProvider setstate there fired
  // React's "Cannot update NotificationsProvider while rendering" warning.
  useEffect(() => {
    if (open) markAllRead();
  }, [open, markAllRead]);
  // The user is looking: no bubble while the sheet is open, and one that was
  // pending (a coalesce timer, the suppression queue) must not float up after
  // it closes.
  useEffect(() => {
    if (open) dismissPopup({ pending: true });
  }, [open, popup, dismissPopup]);

  const popupActive = popup && !open ? popup : null;
  // While the Home search focus dim is up the bubble waits (retracted), so it
  // never floats bright over a dim that exists to focus the search.
  const searchDim = useSearchDim(!!popupActive);
  // Where the sheet and the bubble seat themselves, measured only while one of
  // them is up. Declared BEFORE usePopPresence (its layout effect must batch
  // into the same render as the mount).
  const anchor = useRailAnchor(rowRef, open || !!popupActive);
  const sheet = usePopPresence<HTMLDivElement>(open, PANEL_CLOSE_MS);

  // A poster per item: the scanner stamps `data.poster`; older entries find it
  // in the library. The map is built only while a surface needs it.
  const needPosters = sheet.render || !!popupActive;
  const libPosters = useMemo(() => {
    if (!needPosters) return null;
    const m = new Map<string, string | null>();
    for (const it of library) if (it.id) m.set(it.id, it.poster);
    return m;
  }, [library, needPosters]);
  const posterOf = useCallback(
    (n: Notification) => notifPosterUrl(n, (id) => libPosters?.get(id)),
    [libPosters],
  );

  // A dismissable unread item (the always-pinned `update` kind never counts:
  // it has its own surface) leaves a very faint static wash on the row.
  const hasDismissableUnread =
    !open && notifications.some((n) => !n.read && !n.dismissed && n.kind !== "update");

  // Click-outside / Escape closes the sheet.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest?.("[data-notifications-panel]")) return;
      if (target.closest?.("[data-notifications-bell]")) return;
      if (target.closest?.("[data-aura-context-menu]")) return;
      requestClose();
    };
    // Capture phase, and stopped there: the window-level Escape handlers (App's,
    // the catalog page's) would otherwise close the page under the sheet too.
    // The search chord (searchHotkey.ts) closes the sheet and is NOT stopped:
    // the sheet can cover the search box, and the closed sheet goes
    // click-through before the hotkey's bubble listener looks for the box.
    const onKey = (e: KeyboardEvent) => {
      if (isSearchChord(e)) { requestClose(); return; }
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      requestClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, requestClose]);

  // Manual library refresh, folded into the sheet header. Same semantics as the
  // old standalone button (release-search-spec §6.2 path 3): fire
  // aura:library-changed, nudge the cloud poller per tt item, re-batch after
  // 30 s. Short cooldown guards the cloud per-IP nudge rate limit.
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const later = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => { timersRef.current.delete(t); fn(); }, ms);
    timersRef.current.add(t);
  }, []);
  useEffect(() => () => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current.clear();
  }, []);
  useEffect(() => {
    if (!refreshCooldown) return;
    const t = setTimeout(() => setRefreshCooldown(false), REFRESH_COOLDOWN_MS);
    return () => clearTimeout(t);
  }, [refreshCooldown]);
  const handleRefresh = useCallback(() => {
    if (refreshCooldown) return;
    setRefreshCooldown(true);
    setRefreshing(true);
    later(() => setRefreshing(false), REFRESH_COOLDOWN_MS);
    window.dispatchEvent(new CustomEvent("aura:library-changed"));
    if (loadAuraSettings().releaseSearchEnabled) {
      for (const it of library) {
        if (!it.id || !it.id.startsWith("tt")) continue;
        const t = (it.media_type ?? "").toLowerCase();
        const mt: "series" | "movie" | undefined =
          t === "movie" ? "movie"
            : (t === "series" || t === "anime") ? "series"
            : undefined;
        if (!mt) continue;
        nudgeReleasePoller(it.id, mt);
      }
      // Re-batch after 30 s so the cloud's freshly-polled signals propagate
      // into the local store without waiting for the next library mutation.
      later(() => {
        window.dispatchEvent(new CustomEvent("aura:library-changed"));
      }, 30_000);
    }
  }, [refreshCooldown, library, later]);

  // ARRIVAL on the row: one accent light sweep (runs once; a merge during it
  // does not restart it) and the badge pops in sync with the bubble.
  const [sweeping, setSweeping] = useState(false);
  const sweepingRef = useRef(false);
  const lastArrival = useRef<string | null>(null);
  const arrivalKey = popupActive && !searchDim ? `${popupActive.id}#${popupCount}` : null;
  useEffect(() => {
    if (!arrivalKey) { lastArrival.current = null; return; }
    if (arrivalKey === lastArrival.current) return;
    lastArrival.current = arrivalKey;
    popBadge(badgeRef.current);
    if (sweepingRef.current) return;
    sweepingRef.current = true;
    setSweeping(true);
    later(() => { sweepingRef.current = false; setSweeping(false); }, SWEEP_MS);
  }, [arrivalKey, later]);

  // Screen readers: ONE persistent live region (always mounted, so the first
  // arrival is announced too: a region inserted with its text already in it is
  // not read). Written on each arrival or merge.
  const [announce, setAnnounce] = useState("");
  const announceKey = popupActive ? `${popupActive.id}#${popupCount}` : null;
  useEffect(() => {
    if (!announceKey || !popupActive) return;
    const more = popupCount > 1 ? ` ${popupCount} new notifications.` : "";
    setAnnounce(`New notification: ${notifTitle(popupActive)}. ${notifDetail(popupActive)}.${more}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [announceKey]);

  // Format the count badge: "9+" caps 10..999 uniformly.
  const badgeText = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <>
      <RailPopup>
        {sheet.render && (
          <NotificationsPanel
            anchor={anchor}
            visible={sheet.visible}
            panelRef={sheet.ref}
            onClose={requestClose}
            newIds={newIds}
            focusId={focusId}
            posterOf={posterOf}
            onRefresh={handleRefresh}
            refreshing={refreshing}
            refreshDisabled={refreshCooldown}
          />
        )}
        {popupActive && (
          <ArrivalBubble
            anchor={anchor}
            notification={popupActive}
            count={popupCount}
            poster={posterOf(popupActive)}
            onOpen={() => {
              // The panel lands on this item; the snapshot in openPanel still
              // sees it unread (this markRead lands after).
              openPanel(popupActive.id);
              markRead(popupActive.id);
              dismissPopup();
            }}
            onGone={() => dismissPopup()}
            suspended={searchDim}
            focusRow={() => rowRef.current?.focus({ preventScroll: true })}
          />
        )}
      </RailPopup>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announce}</span>
      <RailRow
        ref={rowRef}
        label="Notifications"
        ariaLabel={unreadCount > 0
          ? `Notifications (${unreadCount} unread)`
          : "Notifications"}
        ariaExpanded={open}
        active={open}
        onClick={togglePanel}
        // data-notifications-bell is a CONTRACT: the outside-click guard finds
        // this node by selector.
        extraProps={{ "data-notifications-bell": true }}
        className={[
          hasDismissableUnread ? "aura-notif-unread" : "",
          sweeping ? "aura-notif-arrive" : "",
        ].filter(Boolean).join(" ") || undefined}
        icon={<BellIcon className="h-5 w-5" />}
        tail={unreadCount > 0 ? (
          <span ref={badgeRef} aria-hidden className="aura-rail-unread aura-bell-badge-pop">
            {badgeText}
          </span>
        ) : undefined}
      />
    </>
  );
}

/** The badge's arrival pop (a WAAPI scale on the bouncy spring). Skipped while
 *  its own mount pop (aura-bell-badge-pop) is still running, so a 0 -> 1 badge
 *  pops once, and under reduced motion. */
function popBadge(el: HTMLElement | null) {
  if (!el || typeof el.animate !== "function" || reducedMotionActive()) return;
  if (el.getAnimations().some((a) => a.playState === "running")) return;
  const spring = getComputedStyle(document.documentElement)
    .getPropertyValue("--aura-spring-bouncy").trim() || "cubic-bezier(0.34, 1.4, 0.64, 1)";
  const frames = (settle: string): Keyframe[] => [
    { scale: "1", easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" },
    { scale: "1.3", offset: 0.22, easing: settle },
    { scale: "1" },
  ];
  try {
    el.animate(frames(spring), { duration: 520 });
  } catch {
    try { el.animate(frames("cubic-bezier(0.34, 1.4, 0.64, 1)"), { duration: 520 }); } catch { /* no WAAPI */ }
  }
}

// ---------------------------------------------------------------------------
// ArrivalBubble
// ---------------------------------------------------------------------------

/** How long the bubble holds before it retracts (the user's "after about
 *  10 s, collapse the popup into the bell", halved to 5 s in round 17 as it
 *  lingered); paused while the pointer or focus is on it, and a shorter grace
 *  after both leave. A merge restarts the full hold. */
const BUBBLE_HOLD_MS = 5_000;
const BUBBLE_HOLD_AFTER_HOVER_MS = 3_000;
/** Its retract transition (styles/glass-notify.css `.aura-notif-bubble`). */
const BUBBLE_EXIT_MS = 300;

function ArrivalBubble({
  anchor, notification, count, poster, onOpen, onGone, suspended, focusRow,
}: {
  /** Beside the rail, top flush with the rail's top. */
  anchor: RailAnchor;
  notification: Notification;
  /** Arrivals merged into it (NotificationsContext `popupCount`). */
  count: number;
  poster: string | null;
  onOpen: () => void;
  /** Called once its retract has played: the parent clears the popup. */
  onGone: () => void;
  /** Held retracted (the Home search focus dim is up); grows back, with a
   *  fresh hold, when it clears. */
  suspended: boolean;
  /** Moves focus to the rail row (a retract with focus inside the bubble). */
  focusRow: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  // Open while not leaving: the grow-out is an inline-style transition, so the
  // flip goes through usePopPresence (no pop-in race). A merge while leaving
  // reverses the retract from wherever it is.
  const { ref, visible } = usePopPresence<HTMLDivElement>(!leaving && !suspended, BUBBLE_EXIT_MS);
  // Pointer and focus hold it separately: a blur under the pointer (or the
  // pointer leaving while focus stays inside) must not start the retract.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const held = hovered || focused;
  const wasHeld = useRef(false);
  const onGoneRef = useRef(onGone);
  onGoneRef.current = onGone;
  const focusRowRef = useRef(focusRow);
  focusRowRef.current = focusRow;

  // Retract, handing focus back to the row first if it is inside (an
  // unmounting bubble would drop it on <body>). Stable, so a parent re-render
  // never restarts the hold timer below.
  const retract = useCallback(() => {
    const el = ref.current;
    if (el && el.contains(document.activeElement)) focusRowRef.current();
    setLeaving(true);
  }, [ref]);

  // Hold, then retract. Restarted by a merge (the id or the count changes).
  useEffect(() => {
    if (!visible || leaving || held) return;
    const t = setTimeout(retract, wasHeld.current ? BUBBLE_HOLD_AFTER_HOVER_MS : BUBBLE_HOLD_MS);
    return () => clearTimeout(t);
  }, [visible, leaving, held, notification.id, count, retract]);
  // Suspended (search dim): nothing holds it any more, and the next showing
  // gets the full hold.
  useEffect(() => {
    if (!suspended) return;
    wasHeld.current = false;
    setHovered(false);
    setFocused(false);
  }, [suspended]);

  // Retracted: hand the slot back.
  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(() => onGoneRef.current(), BUBBLE_EXIT_MS);
    return () => clearTimeout(t);
  }, [leaving]);

  // A merge: come back if retracting, and bump (AppToast's repeat bump: scale
  // on the bouncy spring, a lift flash, a faint accent halo).
  const mergeKey = `${notification.id}#${count}`;
  const lastKey = useRef(mergeKey);
  useEffect(() => {
    if (lastKey.current === mergeKey) return;
    lastKey.current = mergeKey;
    // Fresh content: the full hold again, whatever an earlier hover left.
    wasHeld.current = false;
    setLeaving(false);
    if (ref.current) playRepeat(ref.current, "default");
  }, [mergeKey, ref]);

  // Escape while focus is in the bubble retracts it (capture, stopped, so the
  // page under it keeps its own Escape).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const el = ref.current;
      if (!el || !el.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      retract();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ref, retract]);

  const hover = (on: boolean) => {
    if (on) wasHeld.current = true;
    setHovered(on);
  };
  const focus = (on: boolean) => {
    if (on) wasHeld.current = true;
    setFocused(on);
  };
  const detail = notifDetail(notification);
  const title = notifTitle(notification);
  const shown = visible && !leaving && !suspended;
  const top = railPopupTop(anchor);

  return (
    <>
      <div
        ref={ref}
        data-notifications-popup
        data-lg-pop=""
        // A plain group: the announcement goes through the bell's persistent
        // live region (a status region inserted already filled is not read).
        role="group"
        aria-label="New notification"
        className={["aura-notif-bubble aura-float-glass", shown ? "is-open" : ""].join(" ")}
        style={{
          left: anchor.left,
          // Flush with the rail's top, beside the Notifications row (the
          // rail's first), growing downward out of it.
          top,
          width: `min(304px, calc(100vw - ${anchor.left + 16}px))`,
          transformOrigin: railOrigin(anchor, top),
        }}
        onPointerEnter={() => hover(true)}
        onPointerLeave={() => hover(false)}
        onFocus={() => focus(true)}
        onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focus(false); }}
      >
        <button
          type="button"
          className="aura-notif-bubble-main"
          onClick={onOpen}
          aria-label={`${title}. ${detail}. Open notifications`}
        >
          <NotifThumb notification={notification} poster={poster} size="bubble" />
          <span className="aura-notif-bubble-text">
            <span className="aura-notif-bubble-line">
              <span className="aura-notif-bubble-title">{title}</span>
              {count > 1 && (
                <span className="aura-notif-newchip font-mono tabular-nums">{count} new</span>
              )}
            </span>
            <span className="aura-notif-bubble-sub">{detail}</span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          className="aura-notif-bubble-x"
          onClick={(e) => { e.stopPropagation(); retract(); }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
      <RailBridge anchor={anchor} on={shown} layer="bubble" />
    </>
  );
}

/** The chord searchHotkey.ts focuses the search box on (HistoryDateJump keeps
 *  the same test): keyCode as well as key, so a non-Latin layout matches. */
function isSearchChord(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat
    && (e.key.toLowerCase() === "f" || e.keyCode === 70);
}

/** Whether the Home search focus dim is up (SearchBar.tsx marks it
 *  `data-aura-search-dim="on"` and fires `aura:search-dim` on each change).
 *  Listens only while `active`. */
function useSearchDim(active: boolean): boolean {
  const [dim, setDim] = useState(false);
  useEffect(() => {
    if (!active) { setDim(false); return; }
    const check = () => setDim(!!document.querySelector('[data-aura-search-dim="on"]'));
    check();
    window.addEventListener("aura:search-dim", check);
    return () => window.removeEventListener("aura:search-dim", check);
  }, [active]);
  // Read synchronously as well: the state only catches up in a passive effect,
  // so the first render with a popup already under the dim would otherwise
  // pop the badge and start the sweep there, then play both again when the
  // dim clears. The event still drives the off transition through state.
  return dim || (active && !!document.querySelector('[data-aura-search-dim="on"]'));
}

function BellIcon({ className }: { className?: string }) {
  // Simple bell glyph: stroke-based so it inherits text colour.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
