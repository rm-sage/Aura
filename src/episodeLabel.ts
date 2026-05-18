// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Format an SxxEyy / Eyy label.
 *
 *  Single source of truth for the season/episode badge string shared by
 *  the notifications scanner and the calendar (month grid + day
 *  overlay). Returns `S02E06` when both numbers are known, `E6` when
 *  only the episode is known, and `null` otherwise (e.g. movies). */
export function formatEpLabel(
  season: number | null | undefined,
  episode: number | null | undefined,
): string | null {
  if (typeof season === "number" && typeof episode === "number") {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  // Episode-only (season unknown): no zero-pad — matches the Stremio
  // `E<n>` label convention and the prior NotificationsScanner behavior.
  if (typeof episode === "number") return `E${episode}`;
  return null;
}
