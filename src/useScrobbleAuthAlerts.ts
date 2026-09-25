// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNotifications } from "./NotificationsContext";
import {
  SCROBBLE_LABELS,
  SCROBBLE_SERVICES,
  scrobbleServicesAvailable,
  summaryFor,
  type ScrobbleAuthStatus,
  type ScrobbleService,
} from "./scrobbleConn";

// ---------------------------------------------------------------------------
// useScrobbleAuthAlerts: surfaces expired Trakt / AniList / Simkl tokens in
// the notification bell so users notice without having to open Settings.
//
// Trigger sources:
//   • mount (covers the case where the user opens Aura with a token that
//     lapsed while the app was closed)
//   • `aura:scrobble-auth-changed` window events (fires after deep-link
//     persistence or manual disconnect)
//   • window focus (catches a STORED token whose expiry passed while the
//     user was outside the app; a token cleared on a 401 or invalid_grant
//     is not connected and raises nothing, see below)
//
// Notification ids are stable per (provider, scope) so re-firing produces
// no duplicates. When a provider's token is renewed (post-reconnect), the
// matching expired-notification is removed.
//
// What fires is a STORED token past its expiry. A token Rust has already
// cleared (AniList's 401, Simkl's invalid_grant) reads as not connected, not
// expired, so it raises nothing here, the same for every provider. A service
// this build cannot use (Simkl with no client_id) never alerts.
// ---------------------------------------------------------------------------

/** The alert's second line, per provider. */
const EXPIRED_SUBTITLE: Record<ScrobbleService, string> = {
  trakt:   "Open Settings and reconnect to keep scrobbling.",
  anilist: "AniList does not support refresh. Open Settings and reconnect to keep scrobbling.",
  simkl:   "Simkl sign-in lapsed after months without a scrobble. Reconnect to keep scrobbling.",
};

function alertId(provider: ScrobbleService, scope: string) {
  return `scrobble-auth-expired:${provider}:${scope}`;
}

export function useScrobbleAuthAlerts(authKey: string | null) {
  const { addNotification, dismissNotification } = useNotifications();
  const scope = authKey ? authKey.slice(0, 12) : "guest";
  /** Most recent (provider, expired) state we observed, so we don't
   *  re-fire addNotification on every refresh — addNotification dedupes
   *  by id, but it also nudges the bell pulse + popup, which is too
   *  loud for a poll-driven check. */
  const seen = useRef<Partial<Record<ScrobbleService, boolean>>>({});

  const check = useCallback(async () => {
    let status: ScrobbleAuthStatus;
    try {
      status = await invoke<ScrobbleAuthStatus>("get_scrobble_auth_status", { scope });
    } catch {
      return;
    }
    const available = await scrobbleServicesAvailable();
    // Walk the KNOWN providers, not the payload's keys: a disconnected one is
    // absent (or null, from an older backend) and reads as not expired, and a
    // key this build does not know about is ignored rather than alerted on.
    for (const provider of SCROBBLE_SERVICES) {
      const summary = summaryFor(status, provider);
      const isExpired = available.has(provider) && !!summary?.expired;
      const wasExpired = seen.current[provider] === true;
      if (isExpired && !wasExpired) {
        addNotification({
          id:       alertId(provider, scope),
          kind:     "warning",
          title:    `${SCROBBLE_LABELS[provider]} token expired`,
          subtitle: EXPIRED_SUBTITLE[provider],
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
    seen.current = {};
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
