// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MetaPreview } from "./types";
import type { NavView } from "./NavSidebar";

// ---------------------------------------------------------------------------
// Session route persistence — survive a webview reload (Ctrl+R / F5 / Ctrl+F5)
// by restoring the page the user was on instead of snapping back to Home.
//
// sessionStorage — NOT localStorage — is the correct store: it persists across
// a reload of the SAME webview context but is cleared when the app/webview is
// closed. So a genuine cold start still opens at Home, while a refresh lands
// back on the detail page (or whichever tab) the user was viewing.
//
// We persist only the lightweight browse route: the active nav tab plus the
// open detail target (a fully-serialisable MetaPreview). Playback is not
// persisted — re-resolving a stream on reload is out of scope; a refresh mid-
// playback restores the underlying page beneath the player.
// ---------------------------------------------------------------------------

const KEY = "aura:session-route:v1";

const VALID_VIEWS: readonly NavView[] = [
  "home", "library", "queue", "airing", "addons", "discover",
  "live", "calendar", "history", "settings",
] as const;

export interface SessionRoute {
  view: NavView;
  /** Open detail page target, or null when browsing a top-level tab. */
  detail: MetaPreview | null;
}

/** Persist the current browse route. Best-effort — a quota/private-mode
 *  failure just means no restore on the next reload, never a crash. */
export function saveSessionRoute(route: SessionRoute): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(route));
  } catch {
    /* sessionStorage unavailable (quota / disabled) — degrade silently */
  }
}

/** Read the persisted route, or null if absent/corrupt. Validates the view
 *  against the known nav set and requires a minimally-shaped detail object
 *  (id + media_type) so a malformed blob can't open a broken detail page. */
export function loadSessionRoute(): SessionRoute | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SessionRoute>;
    if (!parsed || typeof parsed !== "object") return null;
    const view = VALID_VIEWS.includes(parsed.view as NavView)
      ? (parsed.view as NavView)
      : "home";
    const d = parsed.detail;
    const detail =
      d && typeof d === "object" &&
      typeof (d as MetaPreview).id === "string" &&
      typeof (d as MetaPreview).media_type === "string"
        ? (d as MetaPreview)
        : null;
    return { view, detail };
  } catch {
    return null;
  }
}
