// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNotifications } from "./NotificationsContext";

// ---------------------------------------------------------------------------
// useScrobbleAuthAlerts — surfaces expired Trakt / AniList tokens in the
// notification bell so users notice without having to open Settings.
//
// Trigger sources:
//   • mount (covers the case where the user opens Aura with a token that
//     lapsed while the app was closed)
//   • `aura:scrobble-auth-changed` window events (fires after deep-link
//     persistence or manual disconnect)
//   • window focus (catches mid-session expiries — token went 401 from
//     scrobble.rs's clear-on-401 path while user was outside the app)
//
// Notification ids are stable per (provider, scope) so re-firing produces
// no duplicates. When a provider's token is renewed (post-reconnect), the
// matching expired-notification is removed.
// ---------------------------------------------------------------------------

interface ScrobbleAuthSummary {
  username:   string | null;
  expires_at: number | null;
  stale:      boolean;
  expired:    boolean;
}

interface ScrobbleAuthStatus {
  trakt:   ScrobbleAuthSummary | null;
  anilist: ScrobbleAuthSummary | null;
}

type Provider = "trakt" | "anilist";

const LABELS: Record<Provider, string> = {
  trakt:   "Trakt",
  anilist: "AniList",
};

function alertId(provider: Provider, scope: string) {
  return `scrobble-auth-expired:${provider}:${scope}`;
}

export function useScrobbleAuthAlerts(authKey: string | null) {
  const { addNotification, dismissNotification } = useNotifications();
  const scope = authKey ? authKey.slice(0, 12) : "guest";
  /** Most recent (provider, expired) state we observed, so we don't
   *  re-fire addNotification on every refresh — addNotification dedupes
   *  by id, but it also nudges the bell pulse + popup, which is too
   *  loud for a poll-driven check. */
  const seen = useRef<Record<Provider, boolean>>({ trakt: false, anilist: false });

  const check = useCallback(async () => {
    let status: ScrobbleAuthStatus;
    try {
      status = await invoke<ScrobbleAuthStatus>("get_scrobble_auth_status", { scope });
    } catch {
      return;
    }
    for (const provider of ["trakt", "anilist"] as const) {
      const summary = status[provider];
      const isExpired = !!summary?.expired;
      const wasExpired = seen.current[provider];
      if (isExpired && !wasExpired) {
        addNotification({
          id:       alertId(provider, scope),
          kind:     "warning",
          title:    `${LABELS[provider]} token expired`,
          subtitle: provider === "anilist"
            ? "AniList does not support refresh. Open Settings and reconnect to keep scrobbling."
            : "Open Settings and reconnect to keep scrobbling.",
          data:     { provider, scope, kind: "scrobble-auth-expired", settingsSection: "sec-scrobble" },
        });
      } else if (!isExpired && wasExpired) {
        dismissNotification(alertId(provider, scope));
      }
      seen.current[provider] = isExpired;
    }
  }, [scope, addNotification, dismissNotification]);

  useEffect(() => {
    // Reset the "seen" ledger when scope changes (different Stremio
    // account → different keyring entries). Without this, switching
    // accounts could carry over a stale "already notified" flag.
    seen.current = { trakt: false, anilist: false };
    void check();
    const onChanged = () => { void check(); };
    const onFocus   = () => { void check(); };
    window.addEventListener("aura:scrobble-auth-changed", onChanged);
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("aura:scrobble-auth-changed", onChanged);
      window.removeEventListener("focus", onFocus);
    };
  }, [check]);
}
