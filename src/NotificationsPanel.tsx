// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import {
  useNotifications,
  type Notification,
  type NotificationKind,
} from "./NotificationsContext";

// ---------------------------------------------------------------------------
// NotificationsPanel — anchored ABOVE the bell (bottom-12 left-3 in absolute
// coords on the bell's parent). Glass-styled card with header + scrollable
// item list. Click rows to dispatch open-meta (release/episode) or open the
// release URL (update). Update items don't have a dismiss button per spec.
// ---------------------------------------------------------------------------

interface Props {
  onClose: () => void;
  /** True while the parent is playing the close animation — flips the
   *  panel from the entrance class (.aura-bell-panel-in) to the exit
   *  class (.aura-bell-panel-out) so it visibly retracts toward the
   *  bell instead of vanishing on unmount. */
  closing?: boolean;
}

export default function NotificationsPanel({ onClose, closing }: Props) {
  const {
    notifications,
    markRead,
    dismissAll,
    dismissNotification,
  } = useNotifications();

  // Sort newest-first for display. The store keeps insertion order, but
  // we re-sort here in case loadFromStorage returned them out of order.
  const sorted = useMemo(
    () => [...notifications].sort((a, b) => b.createdAt - a.createdAt),
    [notifications],
  );

  // "Dismiss all" applies to anything that ISN'T an `update` entry —
  // updates remain on the list per the kind-doc contract. The button
  // disables when there's nothing left to dismiss.
  const hasDismissable = notifications.some((n) => n.kind !== "update");

  return (
    <div
      data-notifications-panel
      className={[
        "absolute bottom-12 left-0",
        "w-[380px] max-h-[480px]",
        "rounded-2xl overflow-hidden",
        // Higher-contrast surface than the prior `bg-white/[0.07]`.
        // `bg-black/82` darkens the panel substantially so titles
        // stay legible against Mica's bright bleedthrough, while the
        // `backdrop-saturate-150 backdrop-brightness-75 backdrop-blur-2xl`
        // chain approximates iOS-style vibrancy without the per-frame
        // GPU cost of the proper macOS Vibrancy API. The bright
        // background still tinges the panel (the eye reads it as
        // "translucent") but text contrast is uniform regardless of
        // what's behind it.
        "bg-black/82 backdrop-saturate-150 backdrop-brightness-75 backdrop-blur-2xl",
        "border border-white/10",
        "shadow-2xl",
        "flex flex-col",
        closing ? "aura-bell-panel-out" : "aura-bell-panel-in",
      ].join(" ")}
      role="dialog"
      aria-label="Notifications"
    >
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="text-sm font-semibold text-white/90 tracking-wide">
          Notifications
        </div>
        <button
          type="button"
          onClick={() => { if (hasDismissable) dismissAll(); }}
          disabled={!hasDismissable}
          className={[
            "text-xs px-2 py-1 rounded-md transition-colors",
            hasDismissable
              ? "text-white/70 hover:text-white hover:bg-white/10"
              : "text-white/30 cursor-default",
          ].join(" ")}
        >
          Dismiss all
        </button>
      </div>

      {/* Body */}
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.10) transparent" }}
      >
        {sorted.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-white/40">
            No notifications
          </div>
        ) : (
          <ul className="divide-y divide-white/10">
            {sorted.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onActivate={() => {
                  // Mark read on activation regardless of kind.
                  markRead(n.id);
                  if (n.kind === "update") {
                    // Drive the signed in-app installer instead of
                    // opening the release page. The plugin's
                    // install path needs the Update resource the
                    // check produces, so we always run a fresh
                    // check first — the cached resource from
                    // App.tsx's home-screen check may not survive
                    // an app restart between when the bell entry
                    // was added and now. Fall through to the
                    // browser only when either the check or install
                    // fails.
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
                  // notice → settings deep-link path (e.g. the post-
                  // onboarding scrobble discovery notification). When
                  // `data.settingsSection` is set, route through the
                  // existing `aura:open-settings` event so the user
                  // lands on the matching section's anchor and the
                  // notification is auto-dismissed.
                  const settingsSection = n.data?.settingsSection as string | undefined;
                  if (settingsSection) {
                    window.dispatchEvent(new CustomEvent("aura:open-settings", {
                      detail: { section: settingsSection },
                    }));
                    dismissNotification(n.id);
                    onClose();
                    return;
                  }
                  // release / episode → open detail in the app, then
                  // auto-dismiss: the user has already acted on the
                  // notification, so leaving it in the panel makes the
                  // bell badge feel sticky.
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
                    // No metaId to navigate to (warning / error / notice
                    // / success without a target) — still dismiss on
                    // activation so the user can clear the row by
                    // clicking through it.
                    dismissNotification(n.id);
                  }
                }}
                onDismiss={() => dismissNotification(n.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

interface RowProps {
  notification: Notification;
  onActivate: () => void;
  onDismiss: () => void;
}

/** Per-kind tone palette. Centralised so the row, the unread accent
 *  bar, the hover background, and the icon all stay in sync. */
function toneFor(kind: NotificationKind) {
  switch (kind) {
    case "warning":
      return {
        hoverBg: "hover:bg-amber-400/10",
        bar:     "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.55)]",
        icon:    "text-amber-300",
      };
    case "error":
      return {
        hoverBg: "hover:bg-rose-400/10",
        bar:     "bg-rose-400 shadow-[0_0_6px_rgba(251,113,133,0.55)]",
        icon:    "text-rose-300",
      };
    case "success":
      return {
        hoverBg: "hover:bg-emerald-400/10",
        bar:     "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.55)]",
        icon:    "text-emerald-300",
      };
    case "notice":
      return {
        hoverBg: "hover:bg-ln-accent/10",
        bar:     "bg-ln-accent shadow-[0_0_6px_rgba(91,164,255,0.5)]",
        icon:    "text-ln-accent/95",
      };
    default:
      // release / episode / update — neutral white-on-default styling.
      return {
        hoverBg: "hover:bg-white/[0.08]",
        bar:     "bg-ln-accent shadow-[0_0_6px_rgba(91,164,255,0.5)]",
        icon:    "text-white/70",
      };
  }
}

function NotificationRow({ notification, onActivate, onDismiss }: RowProps) {
  const { id, kind, title, subtitle, createdAt, read } = notification;
  const tone = toneFor(kind);

  // Inline action surface — currently scoped to AniList token-expiry
  // notifications so the user can re-auth without leaving the panel.
  // Trakt has refresh tokens and a device-flow that requires UI to
  // display the user_code, so its alerts still route through Settings
  // (the user clicks the row to dismiss + opens Settings → Trakt
  // section manually). AniList's authorize-URL flow fits a single
  // button: open the OAuth popup, which intercepts the redirect and
  // re-emits the deep-link that scrobble_auth picks up.
  const expiredProvider =
    notification.data?.kind === "scrobble-auth-expired"
      ? (notification.data?.provider as string | undefined)
      : undefined;
  const expiredScope = notification.data?.scope as string | undefined;
  const showReconnect = expiredProvider === "anilist" && !!expiredScope;
  const [reconnecting, setReconnecting] = useState(false);

  const handleReconnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (reconnecting || !expiredScope) return;
    setReconnecting(true);
    try {
      // Mirrors the SettingsView → ScrobbleAuthRow → AniList branch:
      // stash the scope so the deep-link handler can route the token
      // to the right keyring slot, fetch the authorize URL, open the
      // OAuth popup with the redirect interceptor. Success closes the
      // popup and dispatches `aura:scrobble-auth-changed`; the
      // useScrobbleAuthAlerts watcher then removes this notification
      // automatically since the token is no longer expired.
      sessionStorage.setItem(`aura:oauth:pending:anilist`, expiredScope);
      const url = await invoke<string>("scrobble_oauth_authorize_url", { service: "anilist" });
      const { openOAuthPopup } = await import("./SourcePopup");
      openOAuthPopup(url, "Reconnect AniList", {
        interceptPrefix: `aura://oauth/anilist`,
      });
    } catch (err) {
      console.warn("[notifications] AniList reconnect failed:", err);
    } finally {
      setReconnecting(false);
    }
  };

  return (
    <li
      key={id}
      className={[
        "group relative flex items-start gap-3 px-4 py-3",
        "cursor-pointer",
        "transition-colors duration-150",
        tone.hoverBg,
        read ? "opacity-70" : "",
      ].filter(Boolean).join(" ")}
      onClick={onActivate}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {/* Unread accent bar — colour drawn from the tone palette */}
      {!read && (
        <span
          aria-hidden
          className={`absolute left-0 top-3 bottom-3 w-[3px] rounded-r-full ${tone.bar}`}
        />
      )}
      <div className={`flex-shrink-0 mt-0.5 ${tone.icon}`}>
        <KindIcon kind={kind} />
      </div>
      <div className="flex-1 min-w-0">
        {/* Native browser tooltip surfaces the full title on hover when
            the rendered text gets clipped by `truncate`. Long anime
            names ("Mushoku Tensei: Jobless Reincarnation …") were
            otherwise unreadable without opening the detail page.
            Same cheap solution Aura already uses on catalog cards. */}
        <div className="text-sm text-white/90 leading-tight truncate" title={title}>
          {title}
        </div>
        {subtitle && (
          <div className="text-xs text-white/55 leading-snug mt-0.5 line-clamp-2" title={subtitle}>
            {subtitle}
          </div>
        )}
        {showReconnect && (
          <button
            type="button"
            onClick={handleReconnect}
            disabled={reconnecting}
            className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md
                       text-[11px] font-medium tracking-wide
                       bg-amber-500/15 hover:bg-amber-500/25
                       text-amber-200 hover:text-amber-100
                       border border-amber-400/35 hover:border-amber-400/55
                       transition-colors disabled:opacity-50"
          >
            {reconnecting ? "Opening…" : "Reconnect AniList"}
          </button>
        )}
        <div className="text-[10px] text-white/35 mt-1.5 uppercase tracking-wider">
          {relativeTime(createdAt)}
        </div>
      </div>
      {kind !== "update" && (
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className={[
            "flex-shrink-0 self-start mt-0.5",
            "h-6 w-6 rounded-md",
            // Two-stage colour scheme: row-hover makes the X visible
            // as a rose tint (high-contrast even against Mica's bright
            // bleedthrough), button-hover then deepens to a solid
            // rose background so the destructive intent reads
            // unambiguously before the click. Was previously
            // white-on-white-translucent which dropped to ~0
            // contrast on light Mica.
            "text-white/40 group-hover:text-rose-400",
            "hover:!text-white hover:!bg-rose-500/55 hover:!border-rose-400/40",
            "border border-transparent",
            "opacity-0 group-hover:opacity-100",
            "transition-all duration-150",
            "flex items-center justify-center",
          ].join(" ")}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
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

function KindIcon({ kind }: { kind: NotificationKind }) {
  const cls = "h-4 w-4";
  if (kind === "release") {
    // clapperboard
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls}>
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M8 21 L16 21" />
        <path d="M8 6 L12 2 L16 6" />
      </svg>
    );
  }
  if (kind === "warning") {
    // exclamation triangle
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <path d="M12 3 L22 20 L2 20 Z" />
        <path d="M12 10 L12 14" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  if (kind === "error") {
    // bordered circle with X
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <circle cx="12" cy="12" r="9" />
        <path d="M9 9 L15 15 M15 9 L9 15" />
      </svg>
    );
  }
  if (kind === "success") {
    // checkmark in a circle
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <circle cx="12" cy="12" r="9" />
        <path d="M8 12.5 L11 15.5 L16 9.5" />
      </svg>
    );
  }
  if (kind === "notice") {
    // info "i" in a circle
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11 L12 16" />
        <circle cx="12" cy="8" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  // update — download/upload arrow
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className={cls}>
      <path d="M12 4 L12 16" />
      <path d="M7 11 L12 16 L17 11" />
      <path d="M5 20 L19 20" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// relativeTime — local helper to avoid pulling in date-fns. "Just now",
// "5m ago", "2h ago", "3d ago", or the locale date string for older entries.
// ---------------------------------------------------------------------------

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "Just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return "Just now";
  const min = Math.floor(sec / 60);
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
