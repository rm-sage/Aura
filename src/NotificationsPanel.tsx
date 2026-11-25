// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  safeNotifPoster,
  useNotifications,
  type Notification,
  type NotificationKind,
} from "./NotificationsContext";
import Tooltip from "./Tooltip";
import { useIdleGatedInterval } from "./useIdleGate";
import { showAppToast } from "./AppToast";
import { beginScrobbleSignIn } from "./scrobbleSignIn";
import { HDR_OFFER_DATA_KIND, setHdrMode } from "./hdrMode";
import { AUDIO_ORDER_DATA_KIND } from "./legacyAudioPriority";
import { readAudioOrderNoticeData, undoAudioOrderRepair } from "./audioPriorityRepair";
import {
  SCROBBLE_LABELS,
  isScrobbleService,
  type ScrobbleService,
} from "./scrobbleConn";
import { CHROME_TOP_PX, RAIL_POPUP_GAP_PX, type RailAnchor } from "./railLayout";
import { useListDroplet } from "./glassListDroplet";
import { shrinkPoster } from "./posterSize";

// ---------------------------------------------------------------------------
// NotificationsPanel: the rail's Notifications SIDE SHEET (round 10).
//
// It emerges from the rail's Notifications row (the rail's TOP row since
// round 12): left edge at rail right + 10, DOCKED beside the rail: top flush
// with the rail's top and bottom level with the rail's bottom (`anchor`,
// railLayout useRailAnchor), so the two read as a pair (a content-driven
// height missed the rail's ends by 12 to 25 px, which looked like a mistake).
// A short list leaves glass below it; the empty state centres. It springs
// open DOWNWARD from the row (transform-origin on the rail edge at the row's
// middle, near its top; --lg-springy) and retracts into it on a quicker ease; NotificationsBell
// drives it through usePopPresence (`visible`), so a reopen mid-close reverses
// instead of racing. No light bridge: that is the arrival bubble's alone
// (the sheet's was dropped in round 17, user's call).
//
// Material: the shared floating glass (`.aura-float-glass`, the Liquid menu
// tier with the idle rim and the cursor light; Frosted in Matte). Items
// are CONTENT rows on it (styles/glass-notify.css), never glass pills, under
// the shared Liquid hover droplet (useListDroplet). Grouped by day, newest
// first. Click (or Enter / Space) acts on an item; Delete dismisses it; the
// arrows, Home and End move between items.
// ---------------------------------------------------------------------------

interface Props {
  /** Beside the rail, top flush with the rail's top. */
  anchor: RailAnchor;
  /** The open style is applied (usePopPresence); false while mounting and
   *  while the close transition plays. */
  visible: boolean;
  panelRef: RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /** Ids that were unread when the panel opened. Opening marks everything read
   *  (the badge clears at once), so the panel keeps its own snapshot to show
   *  which items are new. */
  newIds: ReadonlySet<string>;
  /** An item to land on (the arrival bubble was clicked): scrolled into view,
   *  focused and flashed once. */
  focusId?: string | null;
  /** Poster for an item (data.poster, else the library's), already sized. */
  posterOf: (n: Notification) => string | null;
  /** When present, renders a refresh-library button in the header (the old
   *  standalone LibraryRefreshButton, folded in). */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Cooldown lockout for the refresh button (rate-limit guard). */
  refreshDisabled?: boolean;
}

/** The vertical middle of the rail row an anchor was measured from, in
 *  viewport px. Popups grow out of it. */
export function rowMidY(anchor: RailAnchor): number {
  return Math.round((anchor.top + (window.innerHeight - anchor.bottom)) / 2);
}

/** The rail row's height (the anchor's row). */
export function rowHeight(anchor: RailAnchor): number {
  return Math.max(0, window.innerHeight - anchor.bottom - anchor.top);
}

/** Where a popup growing out of the Notifications row seats its TOP: flush
 *  with the rail's top (the row is the rail's first), never closer to the
 *  title bar than CHROME_TOP_PX. Unrounded, like `railTop`, so a half-pixel
 *  rail edge does not miss by one. */
export function railPopupTop(anchor: RailAnchor): number {
  return Math.max(anchor.railTop, CHROME_TOP_PX);
}

/** transform-origin for a popup whose top is at `top` (railPopupTop): on the
 *  rail's edge (the gap to the left of the popup), level with the row's TOP,
 *  so it grows DOWNWARD out of the row. Round 12 review: at the row's middle
 *  the 72 px arrival bubble grew about as far up as down (top 130 to 103,
 *  bottom 145 to 176 at 1600 x 900); from the row's top (11.5 px below the
 *  popup's top there) it grows 9 px up and 48 px down. The light bridge
 *  still sits at the row's middle (`rowMidY`). */
export function railOrigin(anchor: RailAnchor, top: number): string {
  const fromTop = Math.max(0, anchor.top - top);
  return `${-RAIL_POPUP_GAP_PX}px ${fromTop.toFixed(1)}px`;
}

/** The sheet's height: the rail's own (from its top to the rail's bottom). */
function sheetHeight(anchor: RailAnchor, top: number): string {
  return `max(160px, calc(100vh - ${Math.round((top + anchor.railBottom) * 2) / 2}px))`;
}

export default function NotificationsPanel({
  anchor, visible, panelRef, onClose, newIds, focusId, posterOf,
  onRefresh, refreshing, refreshDisabled,
}: Props) {
  const {
    notifications,
    markRead,
    dismissAll,
    dismissNotification,
  } = useNotifications();

  // Newest first. The store keeps insertion order, but loadFromStorage (or a
  // cloud merge) can return them out of order.
  const sorted = useMemo(
    () => [...notifications].sort((a, b) => b.createdAt - a.createdAt),
    [notifications],
  );

  // `relativeTime` and the day groups read Date.now() at render, so without a
  // tick of our own every timestamp freezes at whatever it said when the panel
  // opened. 30 s is a 2x oversample of relativeTime's finest unit (minutes,
  // with a 45 s "Just now" threshold). The panel only mounts while it is open
  // (or closing), so this costs nothing the rest of the time.
  const [clock, bumpClock] = useState(0);
  useIdleGatedInterval(() => bumpClock((n) => n + 1), 30_000, { runOnResume: true });

  // The tick is a dependency so the groups roll over at midnight (an item
  // from "Today" moves to "Yesterday" with the sheet open).
  const groups = useMemo(() => groupByDay(sorted, Date.now()), [sorted, clock]);

  // "Clear all" removes anything that ISN'T an `update` entry: updates stay on
  // the list per the kind-doc contract.
  const hasDismissable = notifications.some((n) => n.kind !== "update");
  const newCount = sorted.reduce((c, n) => c + (isUnread(n, newIds) ? 1 : 0), 0);

  const sheetTop = railPopupTop(anchor);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const droplet = useListDroplet<HTMLDivElement>(".aura-notif-item");

  // A short fade at the top of the list once it is scrolled, so rows slide
  // under the header instead of being cut by its hairline. Written only when
  // the state flips (one attribute, no React render per scroll).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let on = false;
    const sync = () => {
      const next = el.scrollTop > 0;
      if (next === on) return;
      on = next;
      if (on) el.setAttribute("data-scrolled", "");
      else el.removeAttribute("data-scrolled");
    };
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    return () => el.removeEventListener("scroll", sync);
  }, []);

  // Land focus on open: the requested item (scrolled to the middle and flashed
  // once), else the sheet itself so the arrows work at once. Programmatic focus
  // after a pointer click draws no focus ring (focus-visible heuristics).
  // Re-armed on every close: a reopen during the close transition reuses this
  // instance (usePopPresence keeps it mounted), and the close already moved
  // focus back to the row.
  const [flashId, setFlashId] = useState<string | null>(null);
  const landedRef = useRef(false);
  useLayoutEffect(() => {
    if (!visible) { landedRef.current = false; return; }
    if (landedRef.current) return;
    landedRef.current = true;
    const panel = panelRef.current;
    const scroller = scrollRef.current;
    if (!panel) return;
    const row = focusId && scroller
      ? scroller.querySelector<HTMLElement>(`[data-notif-id="${cssEscape(focusId)}"]`)
      : null;
    if (row && scroller) {
      scroller.scrollTop = Math.max(0, row.offsetTop - (scroller.clientHeight - row.offsetHeight) / 2);
      row.focus({ preventScroll: true });
      setFlashId(focusId ?? null);
    } else {
      panel.focus({ preventScroll: true });
    }
  }, [visible, focusId, panelRef]);

  // After a keyboard dismiss the removed row took focus with it: put it on the
  // row that slid into its place (or the one above, or the sheet).
  const refocusIndex = useRef<number | null>(null);
  useLayoutEffect(() => {
    const idx = refocusIndex.current;
    if (idx === null) return;
    refocusIndex.current = null;
    const rows = rowsOf(panelRef.current);
    const next = rows[Math.min(idx, rows.length - 1)];
    if (next) next.focus({ preventScroll: true });
    else panelRef.current?.focus({ preventScroll: true });
  }, [sorted, panelRef]);

  const dismissWithFocus = (id: string) => {
    const panel = panelRef.current;
    if (panel && panel.contains(document.activeElement)) {
      const rows = rowsOf(panel);
      const at = rows.findIndex((r) => r.dataset.notifId === id);
      if (at >= 0) refocusIndex.current = at;
    }
    droplet.hide();
    dismissNotification(id);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Tab wraps inside the sheet: it lives in the popup host after the rail,
    // so leaving it would land on page controls hidden behind it (the Home
    // search box at 900 x 600), and Shift+Tab on the Settings nav row.
    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const panel = panelRef.current;
      if (!panel) return;
      const tabbables = Array.from(panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((el) => el.getClientRects().length > 0);
      if (tabbables.length === 0) { e.preventDefault(); panel.focus({ preventScroll: true }); return; }
      const first = tabbables[0];
      const last = tabbables[tabbables.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === panel)) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
      return;
    }
    const rows = rowsOf(panelRef.current);
    if (rows.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const cur = active?.closest?.<HTMLElement>("[data-notif-row]") ?? null;
    const i = cur ? rows.indexOf(cur) : -1;
    let next = -1;
    switch (e.key) {
      case "ArrowDown": next = Math.min(rows.length - 1, i + 1); break;
      case "ArrowUp": next = i <= 0 ? 0 : i - 1; break;
      case "Home": next = 0; break;
      case "End": next = rows.length - 1; break;
      case "Delete":
      case "Backspace":
        // Only with the ROW focused (not one of its buttons), and never an
        // update (those are not dismissable).
        if (cur && active === cur && cur.dataset.notifKind !== "update" && cur.dataset.notifId) {
          e.preventDefault();
          dismissWithFocus(cur.dataset.notifId);
        }
        return;
      default: return;
    }
    e.preventDefault();
    const row = rows[next];
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: "nearest" });
  };

  const activate = (n: Notification) => {
    // Mark read on activation regardless of kind.
    markRead(n.id);
    if (n.kind === "update") {
      // Drive the signed in-app installer instead of opening the release
      // page. The plugin's install path needs the Update resource the check
      // produces, so we always run a fresh check first: the cached resource
      // from App.tsx's home-screen check may not survive an app restart
      // between when the bell entry was added and now. Fall through to the
      // browser only when either the check or install fails.
      void (async () => {
        try {
          const { checkForUpdatePlugin, downloadAndInstallUpdatePlugin } =
            await import("./updaterPlugin");
          const release = await checkForUpdatePlugin();
          if (release) {
            const ok = await downloadAndInstallUpdatePlugin();
            if (ok) return;
          }
        } catch {
          // fall through to browser fallback
        }
        const url = (n.data?.htmlUrl as string | undefined) ?? null;
        if (url) openUrl(url).catch(() => {});
      })();
      return;
    }
    // notice -> settings deep link (e.g. the post-onboarding scrobble
    // discovery notification): `data.settingsSection` routes through the
    // existing `aura:open-settings` event so the user lands on the matching
    // section's anchor, and the notification is auto-dismissed.
    const settingsSection = n.data?.settingsSection as string | undefined;
    if (settingsSection) {
      window.dispatchEvent(new CustomEvent("aura:open-settings", {
        detail: { section: settingsSection },
      }));
      dismissNotification(n.id);
      onClose();
      return;
    }
    // release / episode -> open the detail page, then auto-dismiss: the user
    // has acted on it, so leaving it in the panel makes the badge feel sticky.
    const metaId = n.data?.metaId as string | undefined;
    const videoId = n.data?.videoId as string | undefined;
    const mediaType = n.data?.mediaType as string | undefined;
    if (metaId) {
      window.dispatchEvent(new CustomEvent("aura:open-meta", {
        detail: { metaId, videoId, mediaType },
      }));
      dismissNotification(n.id);
      onClose();
    } else {
      // No target (warning / error / notice / success without one): still
      // dismiss on activation so the user can clear the row by clicking it.
      dismissWithFocus(n.id);
    }
  };

  return (
    <>
      <div
        ref={panelRef}
        data-notifications-panel
        // An inline-transition pop: liquidGlass holds the lens off until it
        // settles (POP_SELECTOR), the cursor light treats it as a panel.
        data-lg-pop=""
        data-glass-light="panel"
        role="dialog"
        aria-label="Notifications"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={["aura-notif-sheet aura-float-glass", visible ? "is-open" : ""].join(" ")}
        style={{
          left: anchor.left,
          // Top flush with the rail's top (the Notifications row is its first)
          // and the rail's height, so the bottom is level with the rail's.
          top: sheetTop,
          height: sheetHeight(anchor, sheetTop),
          width: `min(372px, calc(100vw - ${anchor.left + 16}px))`,
          transformOrigin: railOrigin(anchor, sheetTop),
        }}
      >
        <header className="aura-notif-head aura-notif-fadein">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="aura-notif-heading">Notifications</h2>
            {newCount > 0 && (
              <span className="aura-notif-newchip font-mono tabular-nums">{newCount} new</span>
            )}
          </div>
          <div className="flex flex-none items-center gap-1.5">
            {onRefresh && (
              <Tooltip
                text="Refresh library: pulls fresh data from Stremio, then asks Aura Cloud whether any library titles have new episodes."
                pos="top"
                delay={60}
              >
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={refreshDisabled}
                  aria-label="Refresh library"
                  className={[
                    "aura-glass-flat aura-notif-headbtn is-icon",
                    refreshDisabled ? "is-off" : "",
                  ].join(" ")}
                >
                  <RefreshIcon spinning={!!refreshing} />
                </button>
              </Tooltip>
            )}
            <button
              type="button"
              onClick={() => { if (hasDismissable) { droplet.hide(); dismissAll(); } }}
              disabled={!hasDismissable}
              aria-label="Dismiss all notifications"
              className={["aura-glass-flat aura-notif-headbtn font-mono", hasDismissable ? "" : "is-off"].join(" ")}
            >
              Clear all
            </button>
          </div>
        </header>

        <div ref={scrollRef} className="aura-notif-scroll aura-notif-fadein" {...droplet.listProps}>
          <span ref={droplet.ref} aria-hidden className="aura-glass-hl aura-notif-hl" />
          {sorted.length === 0 ? (
            <div className="aura-notif-empty">
              <BellGlyph />
              <p className="aura-notif-empty-title">You're all caught up</p>
              <p className="aura-notif-empty-sub">New episodes, releases and alerts land here.</p>
            </div>
          ) : (
            groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <div className="aura-notif-group font-mono" aria-hidden>{g.label}</div>
                <ul role="list" className="aura-notif-list">
                  {g.items.map((n) => (
                    <NotificationRow
                      key={n.id}
                      notification={n}
                      unread={isUnread(n, newIds)}
                      flash={flashId === n.id}
                      poster={posterOf(n)}
                      onActivate={() => activate(n)}
                      onDismiss={() => dismissWithFocus(n.id)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function isUnread(n: Notification, newIds: ReadonlySet<string>): boolean {
  return !n.read || newIds.has(n.id);
}

function rowsOf(panel: HTMLElement | null): HTMLElement[] {
  return panel ? Array.from(panel.querySelectorAll<HTMLElement>("[data-notif-row]")) : [];
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Day groups: Today, Yesterday, This week, Earlier (local days).
// ---------------------------------------------------------------------------

interface Group { label: string; items: Notification[] }

function groupByDay(sorted: Notification[], now: number): Group[] {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  const DAY = 86_400_000;
  const labelOf = (ts: number) =>
    ts >= today ? "Today"
      : ts >= today - DAY ? "Yesterday"
      : ts >= today - 6 * DAY ? "This week"
      : "Earlier";
  const out: Group[] = [];
  for (const n of sorted) {
    const label = labelOf(n.createdAt);
    const last = out[out.length - 1];
    if (last && last.label === label) last.items.push(n);
    else out.push({ label, items: [n] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// RailBridge: the light that ties the arrival bubble to the rail (only the
// bubble since round 17; the sheet has none). A lit point on the
// rail's edge and on the popup's edge, level with the Notifications row (no
// taller than the row), and ONE laser beam across the 10 px gap between them,
// drawn out of the rail's point as the popup grows, its end point flashing once
// as it lands (glass-notify.css). Tiny (12 x at most 44 px), so its gradients
// need no dither. Fades out first when the popup retracts.
// ---------------------------------------------------------------------------

export function RailBridge({ anchor, on, layer }: {
  anchor: RailAnchor;
  on: boolean;
  /** Only "bubble" today (the sheet's bridge was dropped in round 17). */
  layer: "bubble";
}) {
  const h = Math.max(12, Math.min(44, rowHeight(anchor) - 6));
  return (
    <span
      aria-hidden
      data-notif-bridge=""
      className={["aura-notif-bridge", `is-${layer}`, on ? "is-on" : ""].join(" ")}
      style={{
        left: anchor.left - RAIL_POPUP_GAP_PX - 1,
        top: rowMidY(anchor),
        width: RAIL_POPUP_GAP_PX + 2,
        height: h,
        marginTop: -Math.round(h / 2),
      }}
    >
      <i />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Shared visuals (the panel rows and the arrival bubble).
// ---------------------------------------------------------------------------

/** A poster for an item: `data.poster` (the scanner stamps it), else what
 *  `libraryPoster` finds for `data.metaId`. Only http(s) urls of sane length,
 *  sized down through the on-device resize proxy (thumbs are 34 px wide). */
export function notifPosterUrl(
  n: Notification,
  libraryPoster?: (metaId: string) => string | null | undefined,
): string | null {
  const own = safeNotifPoster(n.data?.poster);
  const metaId = typeof n.data?.metaId === "string" ? n.data.metaId : null;
  const raw = own ?? (metaId && libraryPoster ? safeNotifPoster(libraryPoster(metaId)) : undefined);
  if (!raw) return null;
  return shrinkPoster(raw, 96) ?? null;
}

/** Release / episode entries stored before the scanner wrote a subtitle carry
 *  everything in the title (name, an em dash, then "now available" or SxxEyy):
 *  split the tail off at render time so the second line says it and the
 *  episode number is not lost to the title's ellipsis. */
const LEGACY_SEP = " \u2014 ";
function legacySplit(n: Notification): { head: string; tail: string } | null {
  if (n.subtitle || (n.kind !== "release" && n.kind !== "episode")) return null;
  const i = n.title.lastIndexOf(LEGACY_SEP);
  if (i <= 0) return null;
  const tail = n.title.slice(i + LEGACY_SEP.length).trim();
  if (!tail) return null;
  return { head: n.title.slice(0, i), tail: tail.charAt(0).toUpperCase() + tail.slice(1) };
}

/** The title line (a legacy combined title loses its tail to `notifDetail`). */
export function notifTitle(n: Notification): string {
  return legacySplit(n)?.head ?? n.title;
}

/** The one-line detail under a title: its subtitle, else what kind of thing
 *  it is. */
export function notifDetail(n: Notification): string {
  if (n.subtitle) return n.subtitle;
  const legacy = legacySplit(n);
  if (legacy) return legacy.tail;
  switch (n.kind) {
    case "episode": return "New episode";
    case "release": return "Now available";
    case "update": return "Update ready to install";
    case "warning": return "Needs attention";
    case "error": return "Something went wrong";
    case "success": return "Done";
    default: return "Notice";
  }
}

/** Poster thumb (2:3, with the round 9 card bezel: a rim-only cursor-light
 *  surface) or, without one, the kind's icon on a small tile. */
export function NotifThumb({ notification, poster, size = "row" }: {
  notification: Notification;
  poster: string | null;
  size?: "row" | "bubble";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (poster && failedSrc !== poster) {
    return (
      <span className={`aura-notif-thumb is-poster is-${size}`}>
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailedSrc(poster)}
        />
        <span aria-hidden className="aura-card-bezel" data-glass-light="rim" />
      </span>
    );
  }
  return (
    <span className={`aura-notif-thumb is-icon is-${size}`} data-tone={notification.kind}>
      <KindIcon kind={notification.kind} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

interface RowProps {
  notification: Notification;
  unread: boolean;
  flash: boolean;
  poster: string | null;
  onActivate: () => void;
  onDismiss: () => void;
}

/** Which expired-token alerts carry an inline Reconnect. Every current
 *  provider signs in through the browser, which fits a single button; a
 *  provider whose sign-in needs its own UI would route through Settings. */
const INLINE_RECONNECT: Record<ScrobbleService, boolean> = {
  anilist: true,
  simkl: true,
};

function NotificationRow({ notification, unread, flash, poster, onActivate, onDismiss }: RowProps) {
  const { id, kind, subtitle, createdAt } = notification;
  const title = notifTitle(notification);

  // Inline action surface: scoped to the AniList and Simkl token-expiry
  // notifications (INLINE_RECONNECT) so the user can re-auth without leaving
  // the panel. Both sign-ins fit a single button: the shared starter
  // (scrobbleSignIn.ts) opens the browser, falling back to the in-app popup
  // for AniList; Simkl's runs in the browser only (LOOPBACK_ONLY_SIGN_IN).
  const expiredProvider =
    notification.data?.kind === "scrobble-auth-expired"
      ? (notification.data?.provider as string | undefined)
      : undefined;
  const expiredScope = notification.data?.scope as string | undefined;
  const reconnectService =
    expiredProvider !== undefined && isScrobbleService(expiredProvider)
      && INLINE_RECONNECT[expiredProvider]
      ? expiredProvider
      : null;
  const showReconnect = reconnectService !== null && !!expiredScope;
  const [reconnecting, setReconnecting] = useState(false);

  // The one-time "Send HDR?" offer (useHdrPassthroughOffer): "Turn on" writes
  // through the shared HDR helper, a choice made by hand. Its
  // HDR_MODE_CHANGED_EVENT removes this notice once the write lands.
  const hdrOffer = notification.data?.kind === HDR_OFFER_DATA_KIND;
  const [turningOnHdr, setTurningOnHdr] = useState(false);
  const handleTurnOnHdr = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (turningOnHdr) return;
    setTurningOnHdr(true);
    try {
      await setHdrMode("passthrough", { byUser: true });
      showAppToast("Send HDR is on. Change it any time in Settings > Video & Audio.", { tone: "success" });
    } catch (err) {
      console.warn("[notifications] HDR switch failed:", err);
      showAppToast("Couldn't turn on Send HDR. Try again in Settings > Video & Audio.", { tone: "danger" });
    } finally {
      setTurningOnHdr(false);
    }
  };

  // The one-time audio order repair's notice (useAudioOrderNotice): "Undo"
  // restores the list it replaced. The write's changed-keys event removes
  // this notice; a list changed since is left alone and the notice goes.
  const audioOrder = notification.data?.kind === AUDIO_ORDER_DATA_KIND
    ? readAudioOrderNoticeData(notification.data)
    : null;
  const [undoingAudio, setUndoingAudio] = useState(false);
  const handleUndoAudioOrder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (undoingAudio || !audioOrder) return;
    setUndoingAudio(true);
    try {
      const result = await undoAudioOrderRepair(audioOrder);
      if (result === "restored") {
        showAppToast("Audio order put back.", { tone: "success" });
      } else if (result === "changed") {
        showAppToast("Your audio order has changed since, so it was left as it is.");
        onDismiss();
      } else {
        showAppToast("Couldn't undo yet. Sign in to the same account, wait a moment and try again.");
      }
    } catch (err) {
      console.warn("[notifications] audio order undo failed:", err);
      showAppToast("Couldn't undo. Change the audio order in Settings > Audio Track Selection.", { tone: "danger" });
    } finally {
      setUndoingAudio(false);
    }
  };

  const handleReconnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (reconnecting || !expiredScope || !reconnectService) return;
    const service = reconnectService;
    const label = SCROBBLE_LABELS[service];
    setReconnecting(true);
    try {
      // The same sign-in as the Settings row (scrobbleSignIn.ts), under the
      // EXPIRED notice's scope, which is the account whose token lapsed and
      // not necessarily the one signed in now. The token's arrival dispatches
      // `aura:scrobble-auth-changed` and the useScrobbleAuthAlerts watcher
      // removes this notification, since the token is no longer expired.
      //
      // Reconnecting is the ONE thing this notification exists to make
      // easy, so a loopback failure falls back to the in-app popup (AniList)
      // rather than leaving the button inert.
      //
      // No disconnect first for Simkl here (`revokeFirst: false`), unlike its
      // Settings row (REVOKE_BEFORE_RECONNECT). A cleared token reads as not
      // connected, so the watcher would dismiss this notice the moment the
      // button was pressed, and a declined or abandoned sign-in (which sends
      // nothing back) would leave no reminder at all. The notice only exists
      // for a lapsed grant, and the new token replaces the stored one on
      // arrival.
      await beginScrobbleSignIn(service, expiredScope, {
        popupTitle: `Reconnect ${label}`,
        revokeFirst: false,
        announceInAppFallback: false,
        logTag: "[notifications]",
      });
    } catch (err) {
      console.warn(`[notifications] ${label} reconnect failed:`, err);
      // The button would otherwise just return to rest with nothing said.
      showAppToast(`Couldn't start ${label} sign-in: ${String(err)}`, { duration: 6000 });
    } finally {
      setReconnecting(false);
    }
  };

  let actions: ReactNode = null;
  if (showReconnect || hdrOffer || audioOrder) {
    actions = (
      <div className="mt-2 flex flex-wrap gap-1.5">
        {showReconnect && (
          <button
            type="button"
            onClick={handleReconnect}
            disabled={reconnecting}
            className="aura-glass-flat aura-chrome-warn inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                       text-[11px] font-medium tracking-wide disabled:opacity-50"
          >
            {reconnecting ? "Opening..." : `Reconnect ${reconnectService ? SCROBBLE_LABELS[reconnectService] : ""}`}
          </button>
        )}
        {hdrOffer && (
          <button
            type="button"
            onClick={handleTurnOnHdr}
            disabled={turningOnHdr}
            className="aura-glass-flat is-primary inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                       text-[11px] font-medium tracking-wide disabled:opacity-50"
          >
            {turningOnHdr ? "Turning on..." : "Turn on Send HDR"}
          </button>
        )}
        {audioOrder && (
          <button
            type="button"
            onClick={handleUndoAudioOrder}
            disabled={undoingAudio}
            className="aura-glass-flat inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full
                       text-[11px] font-medium tracking-wide disabled:opacity-50"
          >
            {undoingAudio ? "Undoing..." : "Undo"}
          </button>
        )}
      </div>
    );
  }

  return (
    <li
      data-notif-row=""
      data-notif-id={id}
      data-notif-kind={kind}
      className={[
        "aura-notif-item",
        unread ? "is-unread" : "",
        flash ? "is-target" : "",
      ].filter(Boolean).join(" ")}
      onClick={onActivate}
      // No role="button": a button's children are presentational, which would
      // hide the Dismiss / Undo / Send HDR buttons inside the row from
      // assistive tech and leave the list with no listitems. The row stays
      // focusable and activates on Enter / Space.
      tabIndex={0}
      onKeyDown={(e) => {
        // Only the row itself: Enter on one of its buttons is that button's.
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      <span aria-hidden className="aura-notif-dot" />
      <NotifThumb notification={notification} poster={poster} />
      <div className="aura-notif-body">
        <div className="aura-notif-line">
          {/* The native tooltip surfaces a title `truncate` clipped (long
              anime names). */}
          <span className="aura-notif-title" title={title}>
            {unread && <span className="sr-only">Unread: </span>}
            {title}
          </span>
          <time className="aura-notif-time font-mono tabular-nums" dateTime={new Date(createdAt).toISOString()}>
            {relativeTime(createdAt)}
          </time>
        </div>
        {/* The subtitle, else what kind of thing it is (as the bubble), so a
            row with a poster is never a lone title over empty space. */}
        <div className="aura-notif-sub" title={subtitle || undefined}>
          {notifDetail(notification)}
        </div>
        {actions}
      </div>
      {kind !== "update" && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="aura-notif-x"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5" aria-hidden>
            <path d="M6 6 L18 18 M18 6 L6 18" />
          </svg>
        </button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// KindIcon
// ---------------------------------------------------------------------------

export function KindIcon({ kind }: { kind: NotificationKind }) {
  const cls = "h-4 w-4";
  if (kind === "release") {
    // clapperboard
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
        <path d="M3 8 L21 8 L21 20 L3 20 Z" />
        <path d="M3 8 L7 4 L11 8" />
        <path d="M9 8 L13 4" />
        <path d="M15 8 L19 4" />
      </svg>
    );
  }
  if (kind === "episode") {
    // tv glyph
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M8 21 L16 21" />
        <path d="M8 6 L12 2 L16 6" />
      </svg>
    );
  }
  if (kind === "warning") {
    // exclamation triangle
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
        <path d="M12 3 L22 20 L2 20 Z" />
        <path d="M12 10 L12 14" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "error") {
    // bordered circle with X
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9 L15 15 M15 9 L9 15" />
      </svg>
    );
  }
  if (kind === "success") {
    // checkmark in a circle
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5 L11 15.5 L16 9.5" />
      </svg>
    );
  }
  if (kind === "notice") {
    // info "i" in a circle
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11 L12 16" />
        <circle cx="12" cy="8" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  // update: download arrow
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls} aria-hidden>
      <path d="M12 4 L12 16" />
      <path d="M7 11 L12 16 L17 11" />
      <path d="M5 20 L19 20" />
    </svg>
  );
}

function BellGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" className="aura-notif-empty-icon" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// relativeTime: local helper to avoid pulling in date-fns. "Just now",
// "5m ago", "2h ago", "3d ago", or the locale date string for older entries.
// ---------------------------------------------------------------------------

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "Just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "Just now";
  // ROUND, not floor. With `Math.floor(sec / 60)` the 15 s band between the 45 s
  // "Just now" threshold and the first whole minute rendered "0m ago", a string
  // that is simply wrong. Rounding matches the two sibling formatters
  // (ServiceStatusChip's formatAgo and SettingsView's), where 45 s reads
  // "1 min ago".
  const min = Math.round(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  try {
    return new Date(ts).toLocaleDateString();
  } catch {
    return `${day}d ago`;
  }
}

// ---------------------------------------------------------------------------
// RefreshIcon: Material-style circular-refresh glyph. Spins while a refresh is
// in flight (the `aura-refresh-spin` keyframe lives in App.css).
// ---------------------------------------------------------------------------

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      style={{
        transition: "transform 0.2s ease",
        animation: spinning ? "aura-refresh-spin 1.2s linear infinite" : "none",
      }}
    >
      <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}
