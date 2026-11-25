// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useIdleGatedInterval } from "./useIdleGate";
import { showAppToast } from "./AppToast";
import {
  beginScrobbleSignIn,
  beginScrobbleSignInInApp,
  oauthPendingKey,
} from "./scrobbleSignIn";
import {
  SCROBBLE_LABELS,
  knownScrobbleServicesAvailable,
  scrobbleServicesAvailable,
  summaryFor,
  type ScrobbleAuthStatus,
  type ScrobbleAuthSummary,
  type ScrobbleService,
} from "./scrobbleConn";

// ---------------------------------------------------------------------------
// ScrobbleAuthRow - one row in the Scrobbling section (AniList, Simkl), also
// rendered by the first-run setup.
// Shows connection state ("Not connected" or "Connected as <user>"), a
// Connect button that opens the OAuth authorize URL in the user's
// default browser, and a Disconnect button when authenticated. The
// connection state is read on mount + whenever `aura:scrobble-auth-
// changed` fires (the deep-link handler in App.tsx dispatches it
// after persisting a token, the Disconnect handler dispatches it
// after clearing one).
//
// `scope` is the first 12 chars of the Stremio auth_key (or "guest"),
// matching the keyring layout in scrobble_auth.rs. Sharing a scope
// across components keeps the displayed status in sync with the
// stored token regardless of which Stremio account is signed in.
//
// A service this BUILD cannot sign in to (`scrobble_services_available`
// leaves it out: Simkl until its client_id is filled in) renders muted with
// no Connect button, rather than a button that can only fail.
// ---------------------------------------------------------------------------

/** The row's line for a lapsed token. Simkl's "expired" is its renewal
 *  deadline passing (180 days with no silent refresh), not its 7-day access
 *  token, which renews itself. */
const EXPIRED_COPY: Record<ScrobbleService, string> = {
  anilist: "AniList sign-in expired (AniList cannot renew it automatically). Click Reconnect.",
  simkl: "Simkl sign-in lapsed after months without a scrobble. Click Reconnect.",
};

/** The row's line for a token inside its provider's stale window. */
const STALE_COPY: Record<ScrobbleService, string> = {
  anilist: "AniList token expires within a week. Reconnect to extend (no automatic renewal).",
  simkl: "Simkl will ask you to sign in again within a week. Finishing anything with scrobbling on renews it.",
};

/** Format a Unix-seconds expiry into a "Mon DD, YYYY · HH:MM" string in
 *  the user's locale + timezone. Returns `null` if the timestamp is
 *  outside any sane range (NaN, 0, etc.) so the caller can fall back
 *  to "No expiry reported". */
function formatExpiryAbsolute(expiresAt: number | null): string | null {
  if (expiresAt == null) return null;
  const date = new Date(expiresAt * 1000);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return null;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Pick the coarsest reasonable unit so the relative qualifier reads
 *  naturally ("in 23 days" rather than "in 1987200 seconds"). Uses
 *  `Intl.RelativeTimeFormat` with `numeric: "always"` so the output is
 *  always quantitative ("1 day ago", never "yesterday") - matches the
 *  precision the task asked for. */
function formatExpiryRelative(diffMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const sec = Math.round(diffMs / 1000);
  if (Math.abs(sec) < 60)  return rtf.format(sec, "second");
  const min = Math.round(diffMs / 60_000);
  if (Math.abs(min) < 60)  return rtf.format(min, "minute");
  const hr  = Math.round(diffMs / 3_600_000);
  if (Math.abs(hr)  < 24)  return rtf.format(hr,  "hour");
  const day = Math.round(diffMs / 86_400_000);
  if (Math.abs(day) < 30)  return rtf.format(day, "day");
  const mon = Math.round(diffMs / (86_400_000 * 30));
  if (Math.abs(mon) < 12)  return rtf.format(mon, "month");
  const yr  = Math.round(diffMs / (86_400_000 * 365));
  return rtf.format(yr, "year");
}

/** Tick period matching the unit `formatExpiryRelative` will actually print for
 *  this diff, so the row never shows a value staler than the unit it displays.
 *  Same rule as releaseCountdown.ts::showsSeconds: cadence follows RENDERED
 *  precision, never a fixed guess. A flat 60 s used to leave the seconds branch
 *  (|diff| < 60 s, symmetric around expiry) frozen, so a token that had already
 *  lapsed could still read "in 42 seconds". Each tier is a 2x oversample of the
 *  unit above it. */
function expiryTickMs(diffMs: number): number {
  const abs = Math.abs(diffMs);
  if (abs < 60_000)    return 1_000;   // rendered in seconds
  if (abs < 3_600_000) return 30_000;  // rendered in minutes
  return 60_000;                       // hours or coarser
}

export default function ScrobbleAuthRow({
  service, authKey, description,
}: {
  service: ScrobbleService;
  authKey: string | null;
  description: string;
}) {
  const scope = authKey ? authKey.slice(0, 12) : "guest";
  const label = SCROBBLE_LABELS[service];

  const [status, setStatus] = useState<ScrobbleAuthSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // Can this build sign in to the service at all? Asked once per process (see
  // scrobbleConn.ts); null until the answer arrives, which reads as available.
  const [available, setAvailable] = useState<boolean | null>(() => {
    const known = knownScrobbleServicesAvailable();
    return known ? known.has(service) : null;
  });
  useEffect(() => {
    let live = true;
    void scrobbleServicesAvailable().then((set) => {
      if (live) setAvailable(set.has(service));
    });
    return () => { live = false; };
  }, [service]);
  // Read through a ref so the answer arriving does not re-create `refresh`
  // and re-run the mount fetch below for every row.
  const unavailableRef = useRef(false);
  unavailableRef.current = available === false;
  // Auth-code (deep-link) waiting state - AniList and Simkl.
  const [pending, setPending] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  // Tick driving the "expires in N days" relative qualifier. Without it the
  // Settings page could sit open for hours showing a stale "in 23 days" line
  // that should read "in 22 days". Only runs when an expiring token is
  // connected: guests and non-expiring tokens (AniList implicit grant) skip it.
  //
  // The PERIOD follows what formatExpiryRelative will print (see expiryTickMs)
  // rather than being pinned at 60 s, and because it is recomputed from
  // `tickNow` it sharpens on its own as the token approaches expiry.
  const [tickNow, setTickNow] = useState(() => Date.now());
  const expiresAtMs = status?.expires_at != null ? status.expires_at * 1000 : null;
  const tickMs = expiresAtMs == null ? null : expiryTickMs(expiresAtMs - tickNow);
  useEffect(() => {
    if (tickMs == null) return;
    const id = window.setInterval(() => setTickNow(Date.now()), tickMs);
    return () => window.clearInterval(id);
  }, [tickMs]);

  const clearWaiting = useCallback(() => {
    setPending(false);
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    sessionStorage.removeItem(oauthPendingKey(service));
  }, [service]);

  const refresh = useCallback(() => {
    // Nothing to show for a service this build cannot use, so no keyring read.
    if (unavailableRef.current) return;
    invoke<ScrobbleAuthStatus>("get_scrobble_auth_status", { scope })
      .then((s) => setStatus(summaryFor(s, service)))
      .catch(() => {
        // Deliberately does NOT clear `status`. This now also runs on a 60 s
        // poll, and a transient IPC hiccup must not flash "not connected" over
        // a live account once a minute. A genuine disconnect is not an error:
        // it arrives as a SUCCESSFUL response with no summary for this
        // service, handled by the `then` branch above. On the very first
        // fetch `status` is already null, so leaving it alone matches the old
        // behaviour exactly.
      });
  }, [scope, service]);

  useEffect(() => {
    refresh();
    // Deep-link arrival: App.tsx persists the token, then dispatches
    // this event.
    const onChanged = (e: Event) => {
      refresh();
      // Another provider's disconnect-before-reconnect names itself in
      // `detail`, and must not cancel THIS row's sign-in in flight (its
      // scope stash). Untagged events clear every row.
      const from = (e as CustomEvent<{ service?: ScrobbleService } | null>).detail?.service;
      if (from && from !== service) return;
      clearWaiting();
    };
    window.addEventListener("aura:scrobble-auth-changed", onChanged);
    return () => {
      window.removeEventListener("aura:scrobble-auth-changed", onChanged);
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [refresh, clearWaiting]);

  // `expired` and `stale` are computed SERVER-side at fetch time, so with only
  // the mount fetch and the auth-changed listener above they were frozen for the
  // whole session: a Settings page left open across the expiry moment kept
  // showing the green "Connected" badge over a dead token while the line beneath
  // it counted negative. Re-query on a slow cadence so the badge flips on its
  // own. Paused while minimized with a catch-up on restore, matching the Cloud
  // Sync section.
  useIdleGatedInterval(() => refresh(), 60_000, { runOnResume: true });

  // Nothing polls on a sign-in's behalf: if the user closes the browser tab without authorizing, the row would sit
  // on "Connecting…" forever. Two minutes, then reset. Shared by the browser
  // and in-app paths so both behave identically. It is also the only way out
  // of a DECLINED Simkl consent, which sends nothing back to Aura at all
  // (Simkl's "You declined" page is the whole answer).
  const armBrowserTimeout = useCallback(() => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      setPending(false);
      // Only the waiting UI times out. The sign-in itself stays redeemable in
      // Rust for 15 minutes (NONCE_TTL in oauth_callback.rs, for AniList's
      // proxy nonce and Simkl's PKCE state alike), so an approval can still
      // land after this and deliver a token: the scope stash stays for it,
      // or App.tsx would file that token under "guest" instead of the
      // signed-in account. Cancel, the token's arrival and the next Connect
      // still clear or replace it.
      showAppToast(
        `${label} authorization didn't complete. Try again.`,
        { duration: 6000 },
      );
    }, 120_000);
  }, [service, label]);

  // ── Fallback: sign in inside Aura ────────────────────────────────────
  // The in-app popup webview, which was the default before the browser
  // handoff. It still works when the browser path can't run at all: no
  // default browser registered, `openUrl` refused, or port 11471 squatted
  // by an orphaned process so the loopback callback has nowhere to land.
  // The tradeoff is that its cookie jar drops session cookies at app exit,
  // so the user usually has to type their password again - which is the
  // whole reason it is no longer the default.
  const connectInApp = useCallback(async () => {
    try {
      await beginScrobbleSignInInApp(service, scope, `Connect to ${label}`);
      setPending(true);
      armBrowserTimeout();
    } catch (e) {
      showAppToast(`Couldn't start ${label} auth: ${String(e)}`, { duration: 5000 });
    }
  }, [service, scope, label, armBrowserTimeout]);

  const connect = useCallback(async () => {
    if (busy || pending) return;
    setBusy(true);
    try {
      // The browser first, the in-app popup when the loopback listener is
      // down (scrobbleSignIn.ts). `revokeFirst` when reconnecting over a
      // stored token (the Expired row's Reconnect), so Simkl revokes the old
      // grant (REVOKE_BEFORE_RECONNECT).
      await beginScrobbleSignIn(service, scope, {
        popupTitle: `Connect to ${label}`,
        revokeFirst: !!status,
        announceInAppFallback: true,
        logTag: "[scrobble-auth]",
      });
      setPending(true);
      armBrowserTimeout();
    } catch (e) {
      showAppToast(`Couldn't start ${label} auth: ${String(e)}`, { duration: 5000 });
    } finally {
      setBusy(false);
    }
  }, [
    busy, pending, service, scope, label, status, armBrowserTimeout,
  ]);

  const cancelPending = useCallback(() => {
    clearWaiting();
  }, [clearWaiting]);

  const disconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("clear_scrobble_auth_token", { service, scope });
      window.dispatchEvent(new CustomEvent("aura:scrobble-auth-changed"));
    } catch (e) {
      showAppToast(`Disconnect failed: ${String(e)}`, { duration: 5000 });
    } finally {
      setBusy(false);
    }
  }, [busy, service, scope]);

  const connected = !!status;

  // Not in this build: muted, no Connect, one line saying so. Checked here,
  // after every hook, so the hook order never depends on the answer.
  if (available === false) {
    return (
      <div
        className="min-w-0"
        data-settings-row=""
        data-settings-label={label}
        data-settings-description={description}
      >
        <p className="text-white/45 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs leading-relaxed">Not set up in this build yet.</p>
      </div>
    );
  }

  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-white/85 text-sm font-medium">{label}</p>
          <p className="text-white/55 text-xs leading-relaxed">{description}</p>
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
          {pending ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                                font-semibold uppercase tracking-wider
                                bg-amber-500/15 text-amber-200 border border-amber-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Waiting for authorization…
              </span>
              <button
                type="button"
                onClick={cancelPending}
                className="aura-glass-flat aura-glass-press px-3 py-1 rounded-lg
                           text-white/75 text-[11px] font-medium tracking-wide
                           hover:text-white"
              >
                Cancel
              </button>
            </>
          ) : connected && status?.expired ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                                font-semibold uppercase tracking-wider
                                bg-rose-500/15 text-rose-300 border border-rose-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                {status?.username ? `Expired · ${status.username}` : "Expired"}
              </span>
              {/* Absolute + relative expiry timestamp for the expired
                  branch. Useful diagnostic ("why am I being asked to
                  reconnect now?") and grounds the rose badge in a
                  concrete date. */}
              {(() => {
                const absolute = formatExpiryAbsolute(status?.expires_at ?? null);
                if (!absolute || status?.expires_at == null) return null;
                const relative = formatExpiryRelative(status.expires_at * 1000 - tickNow);
                return (
                  <div className="text-[10px] leading-tight text-right text-rose-300/80">
                    <div>Expired {absolute}</div>
                    <div className="text-rose-300/60">{relative}</div>
                  </div>
                );
              })()}
              <button
                type="button"
                onClick={connect}
                disabled={busy}
                className="aura-glass-flat aura-glass-press is-primary px-3 py-1 rounded-lg
                           text-[11px] font-medium tracking-wide disabled:opacity-50"
              >
                Reconnect
              </button>
            </>
          ) : connected ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                                font-semibold uppercase tracking-wider
                                bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                {status?.username ? `Connected · ${status.username}` : "Connected"}
              </span>
              {/* Live expiry readout. Amber when the token enters the
                  provider-specific stale window (7d AniList, the last 7d before Simkl's renewal deadline)
                  so the user notices before it lapses; neutral otherwise.
                  Renders "No expiry reported" for providers that issue
                  non-expiring tokens (AniList Implicit Grant, etc.) so
                  the absence of a date is explained rather than hidden. */}
              {(() => {
                if (status?.expires_at == null) {
                  return (
                    <div className="text-[10px] leading-tight text-right text-white/35">
                      No expiry reported
                    </div>
                  );
                }
                const absolute = formatExpiryAbsolute(status.expires_at);
                if (!absolute) return null;
                const relative = formatExpiryRelative(status.expires_at * 1000 - tickNow);
                const tone = status.stale
                  ? { primary: "text-amber-300/90", secondary: "text-amber-300/70" }
                  : { primary: "text-white/55",     secondary: "text-white/35"     };
                return (
                  <div className={`text-[10px] leading-tight text-right ${tone.primary}`}>
                    <div>Expires {absolute}</div>
                    <div className={tone.secondary}>{relative}</div>
                  </div>
                );
              })()}
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                className="aura-glass-flat aura-glass-press is-danger-hover px-3 py-1 rounded-lg
                           text-white/75 text-[11px] font-medium tracking-wide
                           hover:text-rose-200 disabled:opacity-50"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              className="aura-glass-flat aura-glass-press is-primary px-3 py-1 rounded-lg
                         text-[11px] font-medium tracking-wide disabled:opacity-50"
            >
              Connect {label}
            </button>
          )}
        </div>
      </div>
      {/* AniList / Simkl waiting state. An authorization-code flow has
          nothing to show, so without
          this the row just sat on a disabled button with no explanation of
          what the user was supposed to do next in the browser. */}
      {pending && (
        <div className="mt-2 rounded-lg border border-ln-accent/25 bg-ln-accent/[0.06] p-3">
          <p className="text-white/70 text-[11px] leading-snug">
            Finish signing in to {label} in your browser. Aura connects as soon as you approve.
          </p>
          <button
            type="button"
            onClick={connectInApp}
            className="mt-1.5 text-white/40 hover:text-white/70 text-[10.5px]
                       underline underline-offset-2 transition-colors"
          >
            Browser didn't open? Sign in inside Aura instead
          </button>
        </div>
      )}
      {status?.expired && !pending && (
        <p className="text-rose-400/90 text-xs">
          {EXPIRED_COPY[service]}
        </p>
      )}
      {status?.stale && !status?.expired && !pending && (
        <p className="text-amber-400/80 text-xs">
          {STALE_COPY[service]}
        </p>
      )}
    </div>
  );
}
