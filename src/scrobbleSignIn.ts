// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// scrobbleSignIn - the ONE AniList / Simkl sign-in starter.
//
// Two surfaces start a scrobble sign-in: ScrobbleAuthRow (Settings >
// Scrobbling and the setup wizard's Tracking step) and the bell's Reconnect on
// an expired-token notice (NotificationsPanel). Each used to carry its own copy
// of the flow below, and the copies had already drifted. The mechanics live
// here; each surface keeps its own waiting UI, and its own failure copy (a
// failure is thrown back to the caller, after the scope stash is cleared).
//
// What has to hold, because it is why a token lands under the right account:
//   - The scope is stashed in sessionStorage BEFORE the browser can come back.
//     App.tsx's `deep-link` handler reads it to pick the keyring slot, and
//     falls back to "guest" without it. Nothing here clears it on success: a
//     caller's waiting UI may give up after two minutes, but the sign-in stays
//     redeemable in Rust for 15 minutes (NONCE_TTL in oauth_callback.rs).
//   - The default browser first (RFC 8252), through the loopback listener.
//     When the listener is down, AniList falls back to the in-app popup;
//     Simkl (LOOPBACK_ONLY_SIGN_IN) has nothing to fall back to, so the error
//     surfaces instead.
// Imported by components only, never by scrobbleConn.ts (no cycle).
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { showAppToast } from "./AppToast";
import { openExternalUrl } from "./externalUrl";
import {
  LOOPBACK_ONLY_SIGN_IN,
  REVOKE_BEFORE_RECONNECT,
  SCROBBLE_LABELS,
  type ScrobbleService,
} from "./scrobbleConn";

/** The sessionStorage slot App.tsx's `deep-link` handler reads the account
 *  scope from. */
export function oauthPendingKey(service: ScrobbleService): string {
  return `aura:oauth:pending:${service}`;
}

/** Where the sign-in opened. */
export type ScrobbleSignInRoute = "browser" | "in-app";

export interface ScrobbleSignInOptions {
  /** Title of the in-app popup, if the flow ends up there. */
  popupTitle: string;
  /** A token is already stored for this scope and is being replaced (the
   *  Settings row's Reconnect). Applies REVOKE_BEFORE_RECONNECT. The bell's
   *  Reconnect passes false on purpose: clearing the token first would dismiss
   *  its notice before any sign-in had happened (see NotificationsPanel). */
  revokeFirst: boolean;
  /** Toast why the sign-in opened inside Aura when the loopback listener is
   *  down. */
  announceInAppFallback: boolean;
  /** Console prefix, e.g. "[scrobble-auth]". */
  logTag: string;
}

/** The in-app popup sign-in. Also the Settings row's "Browser didn't open?"
 *  link. Throws (with the stash cleared) when it could not start.
 *
 *  `loopback: false` keeps the legacy terminal hop at `aura://oauth/<svc>`,
 *  which the popup's own on_navigation interceptor catches and re-emits as a
 *  `deep-link`. Requesting the loopback URL here would work too, but routing
 *  it through the interceptor keeps the popup's trust check (prior host must
 *  be the proxy) on the path it was written for. A loopback-only provider
 *  (Simkl) has no such hop: the popup simply follows its redirect to the
 *  loopback listener, which exchanges the code and emits the deep-link
 *  itself, so there is nothing to intercept. */
export async function beginScrobbleSignInInApp(
  service: ScrobbleService,
  scope: string,
  popupTitle: string,
): Promise<"in-app"> {
  try {
    const { openOAuthPopup } = await import("./SourcePopup");
    sessionStorage.setItem(oauthPendingKey(service), scope);
    const url = await invoke<string>("scrobble_oauth_authorize_url", {
      service, loopback: false,
    });
    openOAuthPopup(url, popupTitle, LOOPBACK_ONLY_SIGN_IN[service] ? {} : {
      interceptPrefix: `aura://oauth/${service}`,
    });
    return "in-app";
  } catch (e) {
    sessionStorage.removeItem(oauthPendingKey(service));
    throw e;
  }
}

/** Start a sign-in for `service` whose token will be stored under `scope`.
 *  Resolves with where it opened; throws (with the stash cleared) when it
 *  could not start, for the caller to report in its own words. */
export async function beginScrobbleSignIn(
  service: ScrobbleService,
  scope: string,
  opts: ScrobbleSignInOptions,
): Promise<ScrobbleSignInRoute> {
  const label = SCROBBLE_LABELS[service];
  // Reconnecting over a stored token: Simkl disconnects first, which revokes
  // the old grant, so the new sign-in does not leave a second live one behind
  // (see REVOKE_BEFORE_RECONNECT). Best effort: a failed revoke must not block
  // the sign-in. Before the scope stash below, because the auth-changed event
  // clears it. The event names this service, so another row's sign-in in
  // flight keeps its own stash.
  if (opts.revokeFirst && REVOKE_BEFORE_RECONNECT[service]) {
    try {
      await invoke("clear_scrobble_auth_token", { service, scope });
      window.dispatchEvent(new CustomEvent("aura:scrobble-auth-changed", { detail: { service } }));
    } catch (e) {
      console.warn(`${opts.logTag} ${label} disconnect before reconnect failed:`, e);
    }
  }
  try {
    // Sign-in starts in the user's DEFAULT BROWSER, which is what RFC 8252
    // ("OAuth 2.0 for Native Apps") recommends for native clients - not for
    // purity, but because the system browser already holds the user's
    // AniList / Simkl session. Re-authorizing becomes one click on
    // "Authorize" instead of retyping a password into a webview whose cookie
    // jar drops session cookies when Aura exits.
    //
    // Browsers refuse to AUTO-redirect into a foreign protocol handler, so the
    // proxy's old terminal `aura://oauth/<svc>` hop died silently (Firefox
    // being the canonical case). A loopback redirect (RFC 8252 §7.3) avoids
    // that hop: the provider (AniList through the proxy, Simkl directly) lands
    // on http://127.0.0.1:11471/oauth/callback, which is plain HTTP and so is
    // never blocked; oauth_callback.rs checks it and re-emits the usual
    // `deep-link`.
    //
    // The stash must be set BEFORE the browser can come back.
    sessionStorage.setItem(oauthPendingKey(service), scope);
    // `loopback: true` makes the Rust side mint a single-use nonce and point
    // the proxy at 127.0.0.1. It errors (rather than silently downgrading) if
    // the bridge never bound its port, because opening a browser tab that has
    // nowhere to return to is exactly the kind of silent dead end the
    // silent-failure audit set out to remove.
    let url: string;
    try {
      url = await invoke<string>("scrobble_oauth_authorize_url", {
        service, loopback: true,
      });
    } catch (loopbackErr) {
      // Simkl can only ever land on the loopback listener, so the popup would
      // fail the same way: report the reason instead.
      if (LOOPBACK_ONLY_SIGN_IN[service]) throw loopbackErr;
      console.warn(`${opts.logTag} loopback unavailable:`, loopbackErr);
      if (opts.announceInAppFallback) {
        showAppToast(
          "Opening sign-in inside Aura (the local callback port is unavailable).",
          { duration: 5000 },
        );
      }
      return await beginScrobbleSignInInApp(service, scope, opts.popupTitle);
    }
    openExternalUrl(url);
    return "browser";
  } catch (e) {
    sessionStorage.removeItem(oauthPendingKey(service));
    throw e;
  }
}
