// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// scrobbleConn — "can we scrobble right now, and to what?"
//
// Extracted from HistoryView, which resolved this inline. Skips push through
// the same commands from a different surface, and two copies of this logic
// would drift the moment either changed.
//
// Answers three things together because they are always needed together: the
// active account scope (the key the scrobble commands are stored under), which
// services actually have a live token, and whether the user has auto-scrobble
// switched on at all.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type ScrobbleService = "trakt" | "anilist";

export interface ScrobbleConn {
  scope: string;
  trakt: boolean;
  anilist: boolean;
  /** The user's auto-scrobble preference. Gates every push that the user did
   *  not explicitly ask for by pressing a scrobble button. */
  autoScrobbleEnabled: boolean;
}

const EMPTY: ScrobbleConn = {
  scope: "guest", trakt: false, anilist: false, autoScrobbleEnabled: false,
};

/** Services with a live token, as the array `markEpisodesSkipped` expects. */
export function connectedServices(conn: ScrobbleConn): ScrobbleService[] {
  const out: ScrobbleService[] = [];
  if (conn.trakt) out.push("trakt");
  if (conn.anilist) out.push("anilist");
  return out;
}

/**
 * Live connection state. Re-resolves when the account changes or a token is
 * linked/unlinked in Settings, so a surface that offers scrobbling never
 * offers it against a token that has since been revoked.
 */
export function useScrobbleConnections(): ScrobbleConn {
  const [conn, setConn] = useState<ScrobbleConn>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let scope = "guest";
      try {
        const sess = await invoke<{ auth_key?: string } | null>("get_session");
        scope = sess?.auth_key ? sess.auth_key.slice(0, 12) : "guest";
      } catch {
        scope = "guest";
      }
      if (cancelled) return;

      let autoScrobbleEnabled = false;
      try {
        const settings = await invoke<{ auto_scrobble_enabled?: boolean }>("get_settings");
        autoScrobbleEnabled = settings?.auto_scrobble_enabled === true;
      } catch { /* treat unknown as OFF: never push on a guess */ }

      try {
        const status = await invoke<{ trakt: unknown | null; anilist: unknown | null }>(
          "get_scrobble_auth_status", { scope },
        );
        if (cancelled) return;
        setConn({
          scope,
          trakt: status.trakt != null,
          anilist: status.anilist != null,
          autoScrobbleEnabled,
        });
      } catch {
        if (!cancelled) setConn({ ...EMPTY, scope, autoScrobbleEnabled });
      }
    };
    void load();
    window.addEventListener("aura:session-changed", load);
    window.addEventListener("aura:scrobble-auth-changed", load);
    window.addEventListener("aura:settings-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("aura:session-changed", load);
      window.removeEventListener("aura:scrobble-auth-changed", load);
      window.removeEventListener("aura:settings-changed", load);
    };
  }, []);

  return conn;
}
