// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

// ---------------------------------------------------------------------------
// NotificationsContext — bell-store for new-release / new-episode / dismissed-
// auto-update notifications.
//
// Persisted to localStorage under `aura:notifications:v1`. Capped at 200 items
// (drop oldest beyond cap, but never silently drop a kind:'update' — keeps the
// most recent update plus 199 others when triaging). The context exposes a
// minimal mutation surface (add / mark / dismiss / clearDismissed) plus a
// transient `hasNew` pulse used by the bell to trigger its glow animation.
// ---------------------------------------------------------------------------

/** Visual + semantic kind for the bell. Tones (used by NotificationsPanel
 *  for accent bar / icon colour / hover bg):
 *
 *   • release  — new movie / season / episode (default tone, white)
 *   • episode  — single episode aired (default tone, white)
 *   • update   — Aura update available (default tone, NON-dismissable)
 *   • notice   — generic info / system message (accent blue)
 *   • success  — confirmation that something completed OK (emerald)
 *   • warning  — degraded behaviour, user should know (amber)
 *   • error    — something failed and the user can act on it (rose)
 */
export type NotificationKind =
  | "release"
  | "episode"
  | "update"
  | "notice"
  | "success"
  | "warning"
  | "error";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  subtitle?: string;
  data?: Record<string, unknown>;
  createdAt: number;
  read: boolean;
  dismissed: boolean;
}

interface NotificationsCtxValue {
  notifications: Notification[];
  unreadCount: number;
  hasNew: boolean;
  /** Most recently added notification — surfaced for ~10 s as a
   *  thought-bubble popup over the bell, then auto-collapsed into
   *  the bell. Cleared (set to null) when the timer fires or the
   *  user dismisses it manually via `dismissPopup`. */
  popup: Notification | null;
  addNotification: (n: Omit<Notification, "createdAt" | "read" | "dismissed"> & {
    id?: string;
    createdAt?: number;
    read?: boolean;
    dismissed?: boolean;
  }) => void;
  /** Manually dismiss the active popup (e.g. user clicked the bubble
   *  to open the panel). Distinct from `dismissNotification`, which
   *  removes the notification from the list entirely. */
  dismissPopup: () => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  dismissNotification: (id: string) => void;
  /** Remove every dismissable notification from the list at once.
   *  `kind === "update"` entries are preserved per the existing
   *  contract (updates aren't individually dismissable, so a "dismiss
   *  all" affordance must not silently nuke them). Used by the bell
   *  panel's header action — replaces the older "mark all read"
   *  which left items visible but read. */
  dismissAll: () => void;
  clearDismissed: () => void;
}

const STORAGE_KEY = "aura:notifications:v1";
const MAX_ITEMS = 200;
/** Hold the bell-glow pulse for ~3 s after addNotification fires. */
const NEW_PULSE_MS = 3000;
/** Grace period after app start before the first popup is allowed.
 *  The boot splash + initial library load can fire notifications
 *  (NotificationsScanner kicks off as soon as Home mounts) and the
 *  popup would spawn behind the loading overlay where the user
 *  never sees it. 5 s lets the splash fade and the bell become
 *  visible first. Subsequent popups (after this window) fire
 *  immediately. Module-level so React StrictMode's double mount
 *  doesn't double the wait. */
const POPUP_BOOT_GRACE_MS = 5_000;
const APP_BOOT_AT = Date.now();

const NotificationsCtx = createContext<NotificationsCtxValue | null>(null);

/** Defensive parse — ignores malformed entries without throwing.
 *  Returns [] for any read failure so the bell silently no-ops on corrupt
 *  storage rather than crashing the app. */
function loadFromStorage(): Notification[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Notification[] = [];
    for (const v of parsed) {
      if (!v || typeof v !== "object") continue;
      const obj = v as Record<string, unknown>;
      const id = obj.id;
      const kind = obj.kind;
      const title = obj.title;
      const createdAt = obj.createdAt;
      if (typeof id !== "string" || !id) continue;
      if (
        kind !== "release"
        && kind !== "episode"
        && kind !== "update"
        && kind !== "notice"
        && kind !== "success"
        && kind !== "warning"
        && kind !== "error"
      ) continue;
      if (typeof title !== "string") continue;
      if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) continue;
      out.push({
        id,
        kind,
        title,
        subtitle: typeof obj.subtitle === "string" ? obj.subtitle : undefined,
        data: obj.data && typeof obj.data === "object"
          ? (obj.data as Record<string, unknown>)
          : undefined,
        createdAt,
        read: !!obj.read,
        dismissed: !!obj.dismissed,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Cap to MAX_ITEMS, but never silently drop the most recent update. We
 *  preserve the single newest kind:'update' (if any) plus the 199 most-recent
 *  others, sorted by createdAt desc. */
function capItems(items: Notification[]): Notification[] {
  if (items.length <= MAX_ITEMS) return items;
  const sorted = [...items].sort((a, b) => b.createdAt - a.createdAt);
  // Find newest update — if absent, just slice the head.
  const newestUpdateIdx = sorted.findIndex((n) => n.kind === "update");
  if (newestUpdateIdx === -1 || newestUpdateIdx < MAX_ITEMS) {
    return sorted.slice(0, MAX_ITEMS);
  }
  // Newest update fell outside the cap — keep it and trim the others.
  const head = sorted.slice(0, MAX_ITEMS - 1);
  head.push(sorted[newestUpdateIdx]);
  return head;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>(() => loadFromStorage());
  /** Transient pulse — flips true for NEW_PULSE_MS after every addNotification. */
  const [hasNew, setHasNew] = useState(false);
  const hasNewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Active thought-bubble popup. Set to the freshly added
   *  notification on every addNotification; cleared after
   *  POPUP_LIFETIME_MS or on user dismissal. */
  const [popup, setPopup] = useState<Notification | null>(null);
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Persist on every change. Cheap (≤200 items) and saves us from re-deriving
  // the list on remount. Also fires the change event the cloud sync layer
  // listens for to debounce a push to the proxy's `notifications` namespace.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications));
      try { window.dispatchEvent(new CustomEvent("aura:notifications-changed")); } catch {}
    } catch {
      // quota exceeded / private mode — non-fatal
    }
  }, [notifications]);

  // Cloud-sync rehydrate: when sync.ts merges a pulled blob into
  // localStorage it fires `aura:notifications-rehydrate` to ask us to
  // refresh React state from disk. Without this the merged
  // notifications wouldn't appear in the bell until the next reload
  // (the persistence effect above is write-only). Distinct event name
  // from `aura:notifications-changed` so we don't loop on our own writes.
  useEffect(() => {
    const onRehydrate = () => {
      try { setNotifications(loadFromStorage()); } catch {}
    };
    window.addEventListener("aura:notifications-rehydrate", onRehydrate);
    return () => window.removeEventListener("aura:notifications-rehydrate", onRehydrate);
  }, []);

  const addNotification = useCallback<NotificationsCtxValue["addNotification"]>((n) => {
    const id = n.id ?? `${n.kind}:${n.title}`;
    setNotifications((prev) => {
      // Dedupe by id — if a notification with the same id already exists,
      // bring it back to "unread + non-dismissed" instead of duplicating.
      const existing = prev.findIndex((p) => p.id === id);
      const next: Notification = {
        id,
        kind: n.kind,
        title: n.title,
        subtitle: n.subtitle,
        data: n.data,
        createdAt: n.createdAt ?? Date.now(),
        read: n.read ?? false,
        dismissed: n.dismissed ?? false,
      };
      let merged: Notification[];
      if (existing >= 0) {
        merged = [...prev];
        merged[existing] = { ...next, createdAt: prev[existing].createdAt };
      } else {
        merged = [next, ...prev];
      }
      return capItems(merged);
    });
    // Pulse the bell.
    setHasNew(true);
    if (hasNewTimerRef.current) clearTimeout(hasNewTimerRef.current);
    hasNewTimerRef.current = setTimeout(() => {
      setHasNew(false);
      hasNewTimerRef.current = null;
    }, NEW_PULSE_MS);
    // Float a thought-bubble popup over the bell. Latest add wins —
    // a rapid-fire batch (multiple new episodes resolving at once)
    // collapses to just the freshest popup so the user isn't chased
    // by N stacked bubbles. Skipped for items that arrive read or
    // dismissed (e.g. backfill from storage migrations).
    const popupCandidate: Notification = {
      id,
      kind: n.kind,
      title: n.title,
      subtitle: n.subtitle,
      data: n.data,
      createdAt: n.createdAt ?? Date.now(),
      read: n.read ?? false,
      dismissed: n.dismissed ?? false,
    };
    if (!popupCandidate.read && !popupCandidate.dismissed) {
      // First-load grace: while the boot splash is still up the
      // popup would render behind it (the splash sits at z-9999,
      // the bell at z-30) and disappear before the user ever sees
      // it. Defer until the grace window has elapsed.
      //
      // Auto-dismissal of the popup (after POPUP_LIFETIME_MS) is now
      // owned by the bubble component itself — that lets it play its
      // collapse-into-bell exit animation BEFORE asking us to clear
      // the popup slot. The earlier context-owned timer just nulled
      // the popup, which caused an instant unmount and skipped the
      // exit animation entirely. The bubble calls dismissPopup() once
      // its exit keyframe completes.
      const sinceBoot = Date.now() - APP_BOOT_AT;
      const wait = sinceBoot < POPUP_BOOT_GRACE_MS
        ? POPUP_BOOT_GRACE_MS - sinceBoot
        : 0;
      if (wait > 0) {
        if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
        popupTimerRef.current = setTimeout(() => {
          setPopup(popupCandidate);
          popupTimerRef.current = null;
        }, wait);
      } else {
        setPopup(popupCandidate);
      }
    }
  }, []);

  const dismissPopup = useCallback(() => {
    setPopup(null);
    if (popupTimerRef.current) {
      clearTimeout(popupTimerRef.current);
      popupTimerRef.current = null;
    }
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((p) => (p.id === id ? { ...p, read: true } : p)));
  }, []);

  // Mark-all-read: includes update notifications by design — once the user has
  // acknowledged the bell at all, the badge count should drop to zero. The
  // dismissed-update entries stay in the list (they're navigable), they just
  // stop contributing to unreadCount.
  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((p) => (p.read ? p : { ...p, read: true })));
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    // Keep `update` entries — they aren't individually dismissable
    // (see kind documentation at the top of the file), so a "dismiss
    // all" should respect that contract.
    setNotifications((prev) => prev.filter((p) => p.kind === "update"));
  }, []);

  const clearDismissed = useCallback(() => {
    setNotifications((prev) => prev.filter((p) => !p.dismissed));
  }, []);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read && !n.dismissed).length,
    [notifications],
  );

  const value = useMemo<NotificationsCtxValue>(
    () => ({
      notifications,
      unreadCount,
      hasNew,
      popup,
      addNotification,
      dismissPopup,
      markRead,
      markAllRead,
      dismissNotification,
      dismissAll,
      clearDismissed,
    }),
    [
      notifications, unreadCount, hasNew, popup,
      addNotification, dismissPopup, markRead, markAllRead,
      dismissNotification, dismissAll, clearDismissed,
    ],
  );

  // Cleanup pulse + popup timers on unmount so long-lived timers don't leak.
  useEffect(() => {
    return () => {
      if (hasNewTimerRef.current) clearTimeout(hasNewTimerRef.current);
      if (popupTimerRef.current)  clearTimeout(popupTimerRef.current);
    };
  }, []);

  return <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>;
}

export function useNotifications(): NotificationsCtxValue {
  const v = useContext(NotificationsCtx);
  if (!v) {
    throw new Error("useNotifications must be used within a NotificationsProvider");
  }
  return v;
}
