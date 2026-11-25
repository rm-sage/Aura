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
import { SCROBBLE_ONBOARDING_SUBTITLE, isScrobbleService } from "./scrobbleConn";

// ---------------------------------------------------------------------------
// NotificationsContext — bell-store for new-release / new-episode / dismissed-
// auto-update notifications.
//
// Persisted to localStorage under `aura:notifications:v1`. Capped at 200 items
// (drop oldest beyond cap, but never silently drop a kind:'update' — keeps the
// most recent update plus 199 others when triaging). The context exposes a
// minimal mutation surface (add / mark / dismiss / clearDismissed). (The old
// transient `hasNew` pulse is gone: nothing read it since the bell's glow was
// retired, and its on / off flips re-rendered every consumer twice per add.)
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
  /** Most recently added notification: surfaced for about 5 s as
   *  the arrival bubble beside the rail's Notifications row, then retracted
   *  into the row. Cleared (set to null) when the timer fires or the
   *  user dismisses it manually via `dismissPopup`. */
  popup: Notification | null;
  /** How many arrivals the current popup stands for: 1 for one, more when
   *  several landed in quick succession (a coalesced batch, a backlog drained
   *  after suppression, or a new arrival while the bubble was still up). The
   *  arrival bubble shows it as a count and bumps on every increase; 0 while
   *  no popup is up. */
  popupCount: number;
  addNotification: (n: Omit<Notification, "createdAt" | "read" | "dismissed"> & {
    id?: string;
    createdAt?: number;
    read?: boolean;
    dismissed?: boolean;
  }) => void;
  /** Clear the popup ON SCREEN (the bubble retracted, or was clicked to
   *  open the panel). Arrivals still waiting behind it (a coalesce timer, the
   *  boot grace, the suppression queue) and their count are kept, so one that
   *  lands while the bubble retracts still shows. `{ pending: true }` also
   *  drops those (the panel opened: the user is looking at everything).
   *  Distinct from `dismissNotification`, which removes the notification
   *  from the list entirely. */
  dismissPopup: (opts?: { pending?: boolean }) => void;
  /** Suppress popup display while the bell isn't visible (during
   *  stream playback, while the DetailView is open, anywhere else
   *  the bubble would be either hidden or distracting). The
   *  notification itself still lands in the ring buffer; only the
   *  floating bubble is held. When suppression flips false again,
   *  the most-recently-suppressed candidate (if any) gets shown so
   *  the user doesn't completely miss new arrivals — but a flurry
   *  of N suppressed candidates collapses to one popup since the
   *  user only needs the freshest signal. */
  setPopupSuppressed: (suppressed: boolean) => void;
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
/** Grace period after app start before the first popup is allowed.
 *  The boot splash + initial library load can fire notifications
 *  (NotificationsScanner kicks off as soon as Home mounts) and the
 *  popup would spawn behind the loading overlay where the user
 *  never sees it. 5 s lets the splash fade and the bell become
 *  visible first. Subsequent popups (after this window) fire
 *  immediately. Module-level so React StrictMode's double mount
 *  doesn't double the wait. */
const POPUP_BOOT_GRACE_MS = 5_000;
/** Coalesce window: when the scanner fires N notifications across an
 *  async loop, each addNotification schedules a setPopup. React's
 *  auto-batch breaks across `await` boundaries so without a coalesce
 *  the user sees the popup chase through every entry. We always
 *  schedule the popup behind a short timer (latest add wins by
 *  resetting the timer) so a batch lands as one final popup. */
const POPUP_COALESCE_MS = 150;
const APP_BOOT_AT = Date.now();
/** Cap on the arrivals remembered behind one pending bubble. */
const FOLDED_CAP = 50;
/** Delay before a live arrival's bubble: the boot grace, else the coalesce window. */
function livePopupWait(): number {
  const sinceBoot = Date.now() - APP_BOOT_AT;
  const bootWait = sinceBoot < POPUP_BOOT_GRACE_MS ? POPUP_BOOT_GRACE_MS - sinceBoot : 0;
  return Math.max(bootWait, POPUP_COALESCE_MS);
}

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
      // Download completions are no longer announced (the downloads panel is
      // the whole report), so drop any that a previous build persisted rather
      // than leaving dead entries in the bell forever.
      if (id.startsWith("download:") && kind === "success") continue;
      // An expired-token alert for a scrobble service Aura no longer has (a
      // removed provider) can never be resolved by a Reconnect: drop it.
      if (id.startsWith("scrobble-auth-expired:")
        && !isScrobbleService(id.split(":")[1] ?? "")) continue;
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
        // The scrobble onboarding notice always reads the current copy, so a
        // stored one never names a provider that is gone.
        subtitle: id === "notice:scrobble-onboarding"
          ? SCROBBLE_ONBOARDING_SUBTITLE
          : typeof obj.subtitle === "string" ? obj.subtitle : undefined,
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

/** Eviction policy:
 *
 *    1. Notifications the user has NOT dismissed never fall out of the
 *       buffer due to the soft `MAX_ITEMS` cap. Per the user's intent,
 *       the bell should hold every undismissed item until they take
 *       care of it. A separate hard cap (`ABSOLUTE_MAX`) prevents
 *       runaway growth in pathological cases (a misbehaving addon
 *       fanning out 5,000 episode releases) — at that point even
 *       undismissed items get evicted oldest-first.
 *
 *    2. Dismissed notifications fill any slots left under `MAX_ITEMS`
 *       after counting undismissed. They're evicted newest-first
 *       below that line, then disappear entirely if undismissed
 *       already saturates `MAX_ITEMS`.
 *
 *    3. The single newest `kind: 'update'` entry is always kept, even
 *       if otherwise it would fall outside the cap. Updates aren't
 *       dismissable through the normal flow (the bell panel preserves
 *       them across `dismissAll`) so they need an explicit guard
 *       against eviction by the volume-cap path.
 */
const ABSOLUTE_MAX = 300;

function capItems(items: Notification[]): Notification[] {
  // Drop already-dismissed notifications older than 30 days: they have been
  // seen and only bloat the persisted blob. Undismissed (unseen) entries and
  // updates are kept regardless of age.
  const ageCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const fresh = items.filter(
    (n) => !n.dismissed || n.kind === "update" || n.createdAt >= ageCutoff,
  );
  // Always serve in newest-first order downstream.
  const sorted = [...fresh].sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.length <= MAX_ITEMS) return sorted;

  const undismissed = sorted.filter((n) => !n.dismissed);
  const dismissed   = sorted.filter((n) =>  n.dismissed);

  // Hard ceiling on undismissed too, but a generous one. Without
  // this an addon misbehaving (1000s of episode releases) could
  // grow the persisted blob past the proxy's per-account quota.
  const keptUndismissed = undismissed.slice(0, ABSOLUTE_MAX);

  // Slots remaining for dismissed AFTER seating the undismissed.
  // Negative when undismissed alone exceeds the soft cap; treat as 0
  // (drop dismissed entirely until undismissed shrinks).
  const slotsLeft = Math.max(0, MAX_ITEMS - keptUndismissed.length);
  let kept = [...keptUndismissed, ...dismissed.slice(0, slotsLeft)];

  // Newest-update guard: if an update fell out of `kept` but still
  // exists in the source, swap the oldest non-update kept item for
  // it. Updates are intentionally non-dismissable through `dismissAll`
  // so the user needs to explicitly action them; the cap shouldn't
  // silently bury one.
  const newestUpdate = sorted.find((n) => n.kind === "update");
  if (newestUpdate && !kept.some((k) => k.id === newestUpdate.id)) {
    // Find the slot to give up: oldest non-update kept entry. If
    // every kept entry is an update, the cap is already update-only
    // and nothing needs to move.
    const giveUpIdx = (() => {
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i].kind !== "update") return i;
      }
      return -1;
    })();
    if (giveUpIdx >= 0) {
      kept = [...kept.slice(0, giveUpIdx), ...kept.slice(giveUpIdx + 1), newestUpdate];
      // Re-sort to maintain newest-first ordering for downstream consumers.
      kept.sort((a, b) => b.createdAt - a.createdAt);
    }
  }
  return kept;
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>(() => loadFromStorage());
  // Synchronous mirror of the live notification ids — lets addNotification
  // detect a same-id re-add (a release-notification re-fire) without reading
  // through React state. Kept in sync on every change below.
  const liveIdsRef = useRef<Set<string>>(new Set(notifications.map((n) => n.id)));
  useEffect(() => {
    liveIdsRef.current = new Set(notifications.map((n) => n.id));
  }, [notifications]);
  /** Active arrival-bubble popup. Set to the freshly added
   *  notification on every addNotification; cleared after
   *  POPUP_LIFETIME_MS or on user dismissal. */
  const [popup, setPopup] = useState<Notification | null>(null);
  /** See `popupCount` in the context type. `pendingCountRef` counts the
   *  candidates folded into the popup a pending timer (or the suppression
   *  queue) will show. */
  const [popupCount, setPopupCount] = useState(0);
  const pendingCountRef = useRef(0);
  // The arrivals behind pendingCountRef, oldest first (capped). When the
  // candidate they collapsed into is auto-dismissed, the bubble falls back to
  // the newest one still live instead of dropping every arrival with it.
  const foldedRef = useRef<Notification[]>([]);
  const showPopup = useCallback((n: Notification) => {
    const add = Math.max(1, pendingCountRef.current);
    pendingCountRef.current = 0;
    foldedRef.current = [];
    setPopup(n);
    setPopupCount((c) => c + add);
  }, []);
  const popupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Suppression flag + queued popup candidate. The flag is mirrored
  // into a ref so addNotification can read it synchronously without
  // re-rendering the whole tree on every flip. The queued popup is
  // the LAST candidate we'd have shown while suppressed; on
  // un-suppress we surface that one (multiple while-suppressed
  // candidates collapse to the freshest). Cleared when the queued
  // popup is shown OR when the user navigates away from the bell-
  // visible surface again before we get a chance to show it.
  // Ref-only: suppression is read synchronously inside addNotification
  // and the toggle drains the queue itself — no consumer needs to
  // re-render on a flip, so a state would just churn the tree.
  const popupSuppressedRef = useRef(false);
  const queuedPopupRef = useRef<Notification | null>(null);
  // The candidate a pending popupTimerRef will show, so a suppress that
  // cancels the timer can queue it instead of losing it.
  const pendingPopupRef = useRef<Notification | null>(null);
  /** (Re)arm the timer that shows `candidate` after `wait` ms. */
  const armPopup = useCallback((candidate: Notification, wait: number) => {
    if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    pendingPopupRef.current = candidate;
    popupTimerRef.current = setTimeout(() => {
      showPopup(candidate);
      popupTimerRef.current = null;
      pendingPopupRef.current = null;
    }, wait);
  }, [showPopup]);

  // Persist on every change. Cheap (≤200 items) and saves us from re-deriving
  // the list on remount. Also fires the change event the cloud sync layer
  // listens for to debounce a push to the proxy's `notifications` namespace.
  //
  // The serialized blob is compared against the last-persisted snapshot
  // before writing. Without this guard, the rehydrate path (sync layer
  // writes localStorage + fires `aura:notifications-rehydrate` → we
  // setNotifications(loadFromStorage()) → this effect runs) would
  // re-write the identical blob AND re-dispatch
  // `aura:notifications-changed`, which schedules a wasted push round-
  // trip to the server with the data the server just gave us.
  const lastPersistedRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      const serialized = JSON.stringify(notifications);
      if (serialized === lastPersistedRef.current) return;
      lastPersistedRef.current = serialized;
      localStorage.setItem(STORAGE_KEY, serialized);
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

  // Settings > Storage cleared the list. A clear is local: the persist effect
  // must not write it again or fire the change event that publishes it, so
  // lastPersistedRef is set first. Update banners are device-local, not history.
  useEffect(() => {
    const onCleared = () => {
      setNotifications((prev) => {
        const kept = prev.filter((n) => n.kind === "update");
        const serialized = JSON.stringify(kept);
        lastPersistedRef.current = serialized;
        if (kept.length > 0) {
          try { localStorage.setItem(STORAGE_KEY, serialized); } catch { /* non-fatal */ }
        }
        return kept;
      });
    };
    window.addEventListener("aura:notifications-cleared", onCleared);
    return () => window.removeEventListener("aura:notifications-cleared", onCleared);
  }, []);

  const addNotification = useCallback<NotificationsCtxValue["addNotification"]>((n) => {
    const id = n.id ?? `${n.kind}:${n.title}`;
    // Re-fire guard for aired-content alerts: an `episode`/`release`
    // notification whose id is ALREADY in the bell is a re-fire (a churned
    // cloud episode-id slipping past the scanner's ledger, etc.). The scanner
    // is the primary guard; this is defence-in-depth so a stray re-fire can't
    // re-pulse the bell or re-float the popup for something the user already
    // saw. Genuinely-new episodes always carry a new id, so a real new-episode
    // alert is never suppressed. (Dismissed entries are removed from the list,
    // so they're not matched here — the scanner's persisted ledger covers
    // those.)
    if ((n.kind === "episode" || n.kind === "release") && liveIdsRef.current.has(id)) {
      return;
    }
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
      // Update notifications collapse to a single live entry: when a
      // newer Aura release arrives the prior `update:vX.Y.Z`
      // notification should be replaced rather than coexist with
      // the new `update:vX.Y.Z+1`. Dedup-by-id can't catch this
      // because the ids are intentionally version-suffixed (so the
      // same release isn't re-added on every poll). Drop any other
      // update entries before seating the incoming one.
      let base = prev;
      if (n.kind === "update") {
        base = prev.filter((p) => p.kind !== "update" || p.id === id);
      }
      let merged: Notification[];
      const existingInBase = base.findIndex((p) => p.id === id);
      if (existingInBase >= 0) {
        merged = [...base];
        merged[existingInBase] = { ...next, createdAt: base[existingInBase].createdAt };
      } else if (existing >= 0 && n.kind !== "update") {
        // Same-id rehydrate path for non-update kinds (couldn't take
        // the simpler branch above because we may have filtered
        // updates out of `base`). Preserve original createdAt.
        merged = [...base];
        const fresh: Notification = { ...next, createdAt: prev[existing].createdAt };
        merged.unshift(fresh);
      } else {
        merged = [next, ...base];
      }
      return capItems(merged);
    });
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
      // Suppressed (player active, DetailView open, etc.): queue
      // the candidate so the user sees it the next time the bell
      // becomes visible. Multiple while-suppressed candidates
      // collapse to the freshest — bell badge counts still reflect
      // every individual notification, but we don't want to chase
      // the user with a backlog of 5 popups when they exit a
      // 30-minute stream.
      pendingCountRef.current += 1;
      const folded = foldedRef.current.filter((f) => f.id !== id);
      folded.push(popupCandidate);
      foldedRef.current = folded.length > FOLDED_CAP ? folded.slice(-FOLDED_CAP) : folded;
      if (popupSuppressedRef.current) {
        queuedPopupRef.current = popupCandidate;
        return;
      }
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
      //
      // Plus a short coalesce window (POPUP_COALESCE_MS) so a batch of
      // N notifications fired across an async loop (the scanner walks
      // items with an `await` stagger between each fetch_meta_detail)
      // collapses to just the LAST popup. Without this, a fresh-
      // install scan that surfaces 4 episodes from one show would
      // visibly chase the user with 4 sequential popups; React's
      // auto-batch doesn't help across await boundaries.
      armPopup(popupCandidate, livePopupWait());
    }
  }, [armPopup]);

  /** Setter exposed via context. Updates BOTH the ref (for synchronous
   *  reads inside addNotification) and the state (so React subscribers
   *  re-render). On a true→false transition AND a queued popup
   *  exists, drain it through the same coalesce timer the live path
   *  uses — that way the popup respects the bell's animation budget
   *  even when it surfaces from a backlog. */
  const setPopupSuppressed = useCallback((suppressed: boolean) => {
    const prev = popupSuppressedRef.current;
    popupSuppressedRef.current = suppressed;
    if (prev && !suppressed && queuedPopupRef.current) {
      const queued = queuedPopupRef.current;
      queuedPopupRef.current = null;
      armPopup(queued, POPUP_COALESCE_MS);
    } else if (suppressed && popupTimerRef.current) {
      // Suppressing while a deferred (timer-pending) popup is armed:
      // cancel it and queue the candidate instead. Prevents the timer
      // from firing setPopup mid-stream after the user just navigated
      // INTO the player.
      clearTimeout(popupTimerRef.current);
      popupTimerRef.current = null;
      queuedPopupRef.current = pendingPopupRef.current;
      pendingPopupRef.current = null;
    }
  }, [armPopup]);

  const dismissPopup = useCallback((opts?: { pending?: boolean }) => {
    setPopup(null);
    setPopupCount(0);
    if (!opts?.pending) return;
    pendingCountRef.current = 0;
    foldedRef.current = [];
    queuedPopupRef.current = null;
    if (popupTimerRef.current) {
      clearTimeout(popupTimerRef.current);
      popupTimerRef.current = null;
    }
    pendingPopupRef.current = null;
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

  // A dismissed notification takes its popup bubble with it: the one showing,
  // the one a coalesce timer is about to show, and the one queued while
  // popups are held (playback, detail page). Otherwise an auto-dismissed
  // notice (the HDR offer once Send HDR is on, a cleared sign-in alert) could
  // still float its bubble after it left the bell.
  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((p) => p.id !== id));
    // Take it out of the waiting batch; the bubble then stands for the newest
    // arrival still in the bell (none left: nothing floats).
    const folded = foldedRef.current;
    const kept = folded.filter((f) => f.id !== id);
    if (kept.length !== folded.length) {
      foldedRef.current = kept;
      pendingCountRef.current = Math.max(0, pendingCountRef.current - (folded.length - kept.length));
    }
    const fallback = kept.length > 0 ? kept[kept.length - 1] : null;
    if (!fallback) pendingCountRef.current = 0;
    if (queuedPopupRef.current?.id === id) {
      queuedPopupRef.current = fallback;
    }
    if (pendingPopupRef.current?.id === id) {
      if (popupTimerRef.current) {
        clearTimeout(popupTimerRef.current);
        popupTimerRef.current = null;
      }
      pendingPopupRef.current = null;
      if (fallback) armPopup(fallback, livePopupWait());
    }
    setPopup((p) => (p?.id === id ? null : p));
  }, [armPopup]);
  // The count belongs to the popup on screen: whatever cleared it (a dismiss,
  // the notification itself going away) starts the next one from zero.
  useEffect(() => {
    if (!popup) setPopupCount(0);
  }, [popup]);

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
      popup,
      popupCount,
      addNotification,
      dismissPopup,
      setPopupSuppressed,
      markRead,
      markAllRead,
      dismissNotification,
      dismissAll,
      clearDismissed,
    }),
    [
      notifications, unreadCount, popup, popupCount,
      addNotification, dismissPopup, setPopupSuppressed,
      markRead, markAllRead,
      dismissNotification, dismissAll, clearDismissed,
    ],
  );

  // Cleanup the popup timer on unmount so a long-lived timer doesn't leak.
  useEffect(() => {
    return () => {
      if (popupTimerRef.current) clearTimeout(popupTimerRef.current);
    };
  }, []);

  return <NotificationsCtx.Provider value={value}>{children}</NotificationsCtx.Provider>;
}

/** A poster url safe to store on (and show from) a notification: http(s)
 *  only, at most 2048 characters. Anything else is dropped, so an oversized or
 *  odd string never reaches the persisted, cloud-synced list. */
export function safeNotifPoster(p: unknown): string | undefined {
  return typeof p === "string" && p.length <= 2048 && /^https?:\/\//i.test(p) ? p : undefined;
}

export function useNotifications(): NotificationsCtxValue {
  const v = useContext(NotificationsCtx);
  if (!v) {
    throw new Error("useNotifications must be used within a NotificationsProvider");
  }
  return v;
}
