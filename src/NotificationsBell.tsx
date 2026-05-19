// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { useNotifications, type Notification } from "./NotificationsContext";
import NotificationsPanel from "./NotificationsPanel";
import { nudgeReleasePoller } from "./releaseSearch";
import { loadAuraSettings } from "./auraSettings";
import type { LibraryItem } from "./types";

// ---------------------------------------------------------------------------
// NotificationsBell — fixed bottom-3 left-3, z-30 (above app body, below
// modals/player). Renders a count badge when unreadCount > 0 and pulses on
// every new addNotification via the `hasNew` flag exposed by the context.
//
// Click-out detection mirrors the NavSidebar profile-popover pattern: a
// global mousedown listener with `closest()` checks for the bell or panel
// containers via data-attributes.
// ---------------------------------------------------------------------------

/** Match the aura-bell-panel-out keyframe duration in App.css. The
 *  bell keeps the panel mounted for this long after the user
 *  triggers close so the exit animation has a chance to play before
 *  React removes the DOM node. */
const PANEL_CLOSE_MS = 200;
/** Refresh-button cooldown — respects the cloud's per-IP nudge rate
 *  limit (the same 2 s the standalone button used before it was
 *  folded into the bell popup). */
const REFRESH_COOLDOWN_MS = 2000;

export default function NotificationsBell({ library }: { library: LibraryItem[] }) {
  const { notifications, unreadCount, hasNew, popup, dismissPopup, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);

  // Treat panel-open as a global mark-read. The user has actively
  // surfaced the panel; whatever they see there counts as seen for
  // the purpose of the badge. Individual dismiss still works for
  // hiding entries from the list, but the badge clears immediately
  // so the bell stops drawing the eye while the user is reading.
  const openPanel = useCallback(() => {
    setOpen((wasOpen) => {
      if (!wasOpen) markAllRead();
      return !wasOpen;
    });
  }, [markAllRead]);
  /** When true, the panel is in the middle of its out-animation —
   *  still mounted, but pointer-events disabled and visually
   *  collapsing. setOpen(false) and clearing this flag both run on
   *  the same PANEL_CLOSE_MS timer. */
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Trigger the panel's exit animation, then unmount once it has
  // finished. Idempotent — calling while already closing is a no-op.
  const requestClose = useCallback(() => {
    if (!open || closing) return;
    setClosing(true);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
      setClosing(false);
      closeTimerRef.current = null;
    }, PANEL_CLOSE_MS);
  }, [open, closing]);

  useEffect(() => () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  // Suppress the popup while the panel is already open — the user is
  // looking, no need to chase them with a bubble.
  const popupActive = popup && !open ? popup : null;
  // The bell shouldn't pulse while the bubble is showing — both
  // animations layered look messy. Compute a quiet flag.
  const popupVisible = !!popupActive;

  // Drive the recurring "ringing" attention animation. Only fires when
  // there's at least one DISMISSABLE unread notification — the always-
  // pinned `update` kind doesn't trigger it (it has its own popup
  // surface and the bell would ring forever otherwise). The animation
  // pauses while the panel is open since the user is already looking.
  const hasDismissableUnread =
    !open && notifications.some((n) => !n.read && !n.dismissed && n.kind !== "update");

  // Click-outside / Escape closes the panel (animated).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest?.("[data-notifications-panel]")) return;
      if (target.closest?.("[data-notifications-bell]")) return;
      requestClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, requestClose]);

  // Manual library refresh, folded into the bell popup header. Same
  // semantics as the old standalone button (release-search-spec §6.2
  // path 3): fire aura:library-changed, nudge the cloud poller per
  // tt item, re-batch after 30 s. Short cooldown guards the cloud
  // per-IP nudge rate limit.
  const [refreshCooldown, setRefreshCooldown] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!refreshCooldown) return;
    const t = setTimeout(() => setRefreshCooldown(false), REFRESH_COOLDOWN_MS);
    return () => clearTimeout(t);
  }, [refreshCooldown]);
  const handleRefresh = useCallback(() => {
    if (refreshCooldown) return;
    setRefreshCooldown(true);
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), REFRESH_COOLDOWN_MS);
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
      // Re-batch after 30 s so the cloud's freshly-polled signals
      // propagate into the local store without waiting for the next
      // library mutation.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("aura:library-changed"));
      }, 30_000);
    }
  }, [refreshCooldown, library]);

  // Format the count badge — "9+" cap handles 10..999 uniformly.
  const badgeText = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div
      ref={containerRef}
      className="fixed bottom-3 left-3 z-30"
      style={{ pointerEvents: "auto" }}
    >
      {open && (
        <NotificationsPanel
          onClose={requestClose}
          closing={closing}
          onRefresh={handleRefresh}
          refreshing={refreshing}
          refreshDisabled={refreshCooldown}
        />
      )}
      {popupActive && (
        <NotificationThoughtBubble
          notification={popupActive}
          onClick={() => {
            // Click bubble → open the panel + mark this entry read.
            markRead(popupActive.id);
            dismissPopup();
            setOpen(true);
          }}
          onDismiss={dismissPopup}
        />
      )}
      <button
        type="button"
        data-notifications-bell
        onClick={openPanel}
        aria-label={
          unreadCount > 0
            ? `Notifications (${unreadCount} unread)`
            : "Notifications"
        }
        className={[
          "relative h-10 w-10 rounded-full",
          "flex items-center justify-center",
          "bg-white/[0.08] hover:bg-white/[0.14] active:bg-white/[0.18]",
          "border border-white/10 hover:border-white/20",
          "backdrop-blur-xl",
          "text-white/80 hover:text-white",
          "transition-colors duration-200",
          "shadow-lg",
          "aura-bell-hover",
          // While the popup is showing it's already drawing the eye —
          // skip the pulse to avoid two animations stacking awkwardly.
          hasNew && !popupVisible ? "aura-bell-pulse" : "",
        ].filter(Boolean).join(" ")}
      >
        {/* The icon (not the button) gets the rotation so the hover/
            border ring stays straight and doesn't tilt with the ring. */}
        <BellIcon
          className={[
            "h-5 w-5",
            hasDismissableUnread ? "aura-bell-ringing" : "",
          ].filter(Boolean).join(" ")}
        />
        {unreadCount > 0 && (
          <span
            aria-hidden
            className={[
              "absolute -top-1 -right-1",
              "min-w-[18px] h-[18px] px-1",
              "rounded-full",
              "flex items-center justify-center",
              "text-[10px] font-semibold leading-none",
              "bg-ln-accent text-black",
              "ring-2 ring-black/40",
              "shadow-[0_0_8px_rgba(91,164,255,0.55)]",
              // Initial pop on appearance, then continuous bounce in
              // sync with the bell ring (same 5 s cycle, peaks 76-82 %).
              "aura-bell-badge-pop",
              hasDismissableUnread ? "aura-bell-badge-bouncing" : "",
            ].filter(Boolean).join(" ")}
          >
            {badgeText}
          </span>
        )}
      </button>
    </div>
  );
}

/**
 * Thought-bubble popup that springs out of the bell when a new
 * notification arrives. Anchors above + slightly right of the bell
 * (which lives in the bottom-left corner). Three animation phases:
 *
 *   1. Spawn: scales up from a small dot near the bell with a slight
 *      overshoot + bobbing tail trail (mimics a comic thought bubble
 *      "blooming" out of the source).
 *   2. Idle: gentle 2 s breathe loop so the bubble feels alive while
 *      the user reads it.
 *   3. Collapse: scales down toward the bell + fades out — runs on
 *      auto-timeout (handled by the context, ~10 s) OR on user
 *      dismiss / panel-open.
 *
 * Multi-line bodies (notification.subtitle) are line-clamped to two
 * rows with a "..." overflow per the user's "summary if too long"
 * spec — clicking the bubble opens the full panel where the
 * complete entry lives.
 */
/** Total time the bubble stays in idle before auto-collapsing — matches
 *  the user's "after ~10s, collapse the popup into the bell" spec. The
 *  bubble owns this timer so the exit animation can play in full
 *  before notifying the parent to clear the popup slot. */
const BUBBLE_AUTO_DISMISS_MS = 10_000;
/** Length of the entrance keyframe in App.css (.aura-popup-enter). */
const BUBBLE_ENTER_MS = 520;
/** Length of the exit keyframe in App.css (.aura-popup-exit). */
const BUBBLE_EXIT_MS = 460;

function NotificationThoughtBubble({
  notification, onClick, onDismiss,
}: {
  notification: Notification;
  onClick: () => void;
  onDismiss: () => void;
}) {
  // Track which animation phase we're in. The collapse phase plays the
  // exit keyframe before the parent unmounts us, so the user sees the
  // bubble actually fly back into the bell instead of just disappearing.
  const [phase, setPhase] = useState<"enter" | "idle" | "exit">("enter");
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idlePhaseRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // After the entrance keyframe settles, transition into idle.
  // The auto-dismiss countdown starts here (idle phase) so the
  // 10-second window doesn't include the entrance time.
  useEffect(() => {
    idlePhaseRef.current = setTimeout(() => {
      setPhase("idle");
      autoDismissRef.current = setTimeout(() => {
        triggerDismiss();
      }, BUBBLE_AUTO_DISMISS_MS);
    }, BUBBLE_ENTER_MS);
    return () => {
      if (idlePhaseRef.current)   clearTimeout(idlePhaseRef.current);
      if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trigger the exit phase: play collapse-into-bell animation, then
  // tell the parent to clear the popup slot. Idempotent — entering
  // exit twice is a no-op. Used by both the auto-dismiss timer and
  // user clicks (X / click-through to panel).
  const triggerDismiss = () => {
    if (phase === "exit") return;
    setPhase("exit");
    // Cancel any pending phase / auto-dismiss work.
    if (idlePhaseRef.current)   clearTimeout(idlePhaseRef.current);
    if (autoDismissRef.current) clearTimeout(autoDismissRef.current);
    if (exitTimerRef.current)   clearTimeout(exitTimerRef.current);
    exitTimerRef.current = setTimeout(() => onDismiss(), BUBBLE_EXIT_MS);
  };

  // Truncate subtitle to a 2-line equivalent when it's long. CSS
  // line-clamp does the visual heavy lifting; the explicit cap here
  // is a hard safety so a runaway subtitle (e.g. an error message
  // dumping a stack trace) doesn't blow out the bubble.
  const subtitleClamped = notification.subtitle && notification.subtitle.length > 280
    ? notification.subtitle.slice(0, 277) + "…"
    : notification.subtitle;

  return (
    <div
      role="alertdialog"
      aria-labelledby="aura-popup-title"
      data-notifications-popup
      onClick={onClick}
      className={[
        // Anchored above the bell, slid right so the accent edge sits
        // flush with the bell's right border for a chained look.
        "absolute bottom-12 left-1 z-40",
        "min-w-[220px] max-w-[300px]",
        "pl-3 pr-8 py-2.5",
        "rounded-xl overflow-hidden",
        // Aura's standard elevated-glass surface — same panel
        // recipe used by the player overlay, the OAuth popup, and
        // the settings panels. Drops the plain-black opaque shell
        // of the old thought bubble in favour of the theme's
        // signature blurred-glass + subtle accent edge.
        "glass-panel-elevated",
        "shadow-[0_12px_36px_-10px_rgba(0,0,0,0.7),0_0_22px_-8px_rgba(91,164,255,0.35)]",
        "cursor-pointer select-none text-left",
        phase === "enter" ? "aura-popup-card-enter" : "",
        phase === "exit"  ? "aura-popup-card-exit"  : "",
        phase === "idle"  ? "aura-popup-card-breathe" : "",
      ].filter(Boolean).join(" ")}
      style={{ transformOrigin: "bottom left" }}
    >
      {/* Left accent stripe — picks up the same ln-accent token the
          rest of Aura's primary UI uses. Doubles as the visual
          "anchor" to the bell beneath it. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-[3px]
                   bg-gradient-to-b from-ln-accent/85 via-ln-accent/55 to-ln-accent/20
                   shadow-[0_0_10px_rgba(91,164,255,0.55)]"
      />
      <button
        type="button"
        aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); triggerDismiss(); }}
        className="absolute top-1.5 right-1.5
                   w-5 h-5 flex items-center justify-center
                   rounded-full text-white/45 hover:text-white/85 hover:bg-white/8
                   transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
      <div className="flex items-start gap-2.5">
        {/* Tiny pulsing accent dot — the "fresh notification"
            signal the bubble used to communicate via its tail. */}
        <span
          aria-hidden
          className="mt-1 flex-shrink-0 w-1.5 h-1.5 rounded-full
                     bg-ln-accent shadow-[0_0_6px_rgba(91,164,255,0.85)]
                     aura-popup-card-pulse"
        />
        <div className="min-w-0 flex-1">
          <p
            id="aura-popup-title"
            className="text-white/95 text-[13px] font-semibold leading-snug line-clamp-2"
          >
            {notification.title}
          </p>
          {subtitleClamped && (
            <p className="text-white/55 text-[11.5px] leading-snug mt-1 line-clamp-2 break-words">
              {subtitleClamped}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function BellIcon({ className }: { className?: string }) {
  // Simple bell glyph — stroke-based so it inherits text colour.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}
