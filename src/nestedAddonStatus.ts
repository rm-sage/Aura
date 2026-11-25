// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// How the service status panel words a WRAPPED addon's health (the rows an
// addon declaring `behaviorHints.addonStatus` reports from its own server;
// contract: docs/superpowers/specs/2026-11-15-aiostreams-nested-addon-status.md).
// Import-free so a node check can load it.
//
// `error` is one of the wrapper's short fixed categories: timeout, unreachable,
// HTTP <code>, invalid manifest, invalid response, disabled on this instance,
// configuration error, request loop. A category this build does not know is
// shown as it came (Rust already stripped control characters and anything
// URL-shaped), clamped, so the next new category needs no Aura change. React
// renders it as text, never HTML.

/** The wrapper's latest REAL request to a wrapped addon. */
export interface NestedLastRequest {
  ok: boolean;
  /** Unix ms. */
  at: number | null;
  /** stream | meta | catalog | subtitles */
  resource: string | null;
  error: string | null;
}

/** A wrapped addon whose latest real request failed this recently is degraded
 *  even when its manifest answers (a scraper can be rate limited while its
 *  manifest is fine). */
export const NESTED_RECENT_FAILURE_MS = 30 * 60_000;

/** Longest category shown as it came. */
export const MAX_CATEGORY_CHARS = 40;

const KNOWN_CATEGORIES = new Set([
  "timeout",
  "unreachable",
  "invalid manifest",
  "invalid response",
  "disabled on this instance",
  "configuration error",
  "request loop",
]);

/** When the wrapper wrote its report, on its clock (`checked_at`) and on this
 *  machine's (`fetched_at`, when the report arrived). */
export interface NestedReportClock {
  checked_at: number | null;
  fetched_at: number;
}

/** How long ago, in ms, the wrapper's timestamp `at` was, measured on the
 *  WRAPPER's clock: its age when the report was written plus the time since
 *  the report arrived. The two machines' clocks need not agree (a server 35
 *  min behind would otherwise hide every failure). Without `checked_at` it
 *  falls back to this machine's clock. Never negative. */
export function nestedAge(at: number, now: number, clock: NestedReportClock): number {
  const age = clock.checked_at != null
    ? (clock.checked_at - at) + (now - clock.fetched_at)
    : now - at;
  return Math.max(0, age);
}

/** A failed real request recent enough to warn about. */
export function nestedRecentFailure(
  l: NestedLastRequest | null | undefined,
  now: number,
  clock: NestedReportClock,
): boolean {
  return !!l && !l.ok && l.at != null && nestedAge(l.at, now, clock) < NESTED_RECENT_FAILURE_MS;
}

/** The category as the row shows it: a known one or `HTTP <code>` as is, any
 *  other clamped to MAX_CATEGORY_CHARS. */
export function nestedCategory(error: string | null | undefined): string | null {
  const e = error?.trim();
  if (!e) return null;
  if (KNOWN_CATEGORIES.has(e) || /^HTTP \d{3}$/.test(e)) return e;
  const chars = Array.from(e);
  return chars.length > MAX_CATEGORY_CHARS ? `${chars.slice(0, MAX_CATEGORY_CHARS - 3).join("")}...` : e;
}

/** One sentence on what a failed request's category means, for the row's
 *  hover, when the bare category does not say it. */
export function nestedFailureExplanation(l: NestedLastRequest): string | null {
  if (l.ok) return null;
  if (l.error?.trim() === "invalid response") {
    return `The last ${l.resource ?? "addon"} request got an answer that isn't a valid Stremio response (often an error page from the addon or its host).`;
  }
  return null;
}

/** The row's failure suffix: " · last stream request failed (timeout)". */
export function nestedFailureSuffix(l: NestedLastRequest): string {
  const what = l.resource ? `${l.resource} request` : "request";
  return ` · last ${what} failed (${nestedCategory(l.error) ?? "error"})`;
}
