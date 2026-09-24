// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// addonDefaults.ts ─────────────────────────────────────────────────────────
//
// Resolves "what addon URL should this slot default to" by walking the
// user's installed addons against a manifest-id ordering. Lets defaults
// survive a host change (a user moving from one AIOMetadata instance to
// another keeps the same `manifest_id` even though the URL differs)
// and lets a fresh-install user inherit the same intent without us
// hard-coding domains.
//
// USAGE PATTERN
//   const homeUrls = resolveDefaultUrls(addons, DEFAULT_HOME_ORDER);
//
// Meta and search are NOT defaulted here any more: who answers either is
// decided by addon order in addonElection.ts (electMetaAddons,
// electSearchAddons), with no manifest-id table.
//
// Each `*_ORDER` constant is a ranked list of manifest.id values. The
// resolver walks the list, finds the first installed addon for each id,
// and emits its URL. Missing ids are silently skipped — a fresh-install
// user with only Cinemeta still gets Cinemeta as the primary, not a
// broken slot.
// ---------------------------------------------------------------------------

import type { AddonEntry } from "./types";
import { AIOMETADATA_MANIFEST_ID } from "./aiometadata";

/** Cinemeta: the universal Stremio catalog provider, which ships with
 *  every Stremio install and exposes the same media-type catalogs. */
export const CINEMETA_MANIFEST_ID = "com.linvo.cinemeta";

/**
 * Default home-catalog ordering, in priority order. The first installed
 * match leads Home; remaining matches fan out below it. New users with
 * any subset of these get the same ordering automatically.
 */
export const DEFAULT_HOME_ORDER: readonly string[] = [
  AIOMETADATA_MANIFEST_ID,
  "community.aiosearch",
  "community.aisearch",
  CINEMETA_MANIFEST_ID,
] as const;

/**
 * Walk the manifest-id list in order; for each id, find the first
 * installed addon whose manifest_id matches. Emits the URL of each
 * match. Missing ids are silently skipped. The returned array is in
 * the order the manifest-id list specifies, NOT the addon-install
 * order — that's the whole point.
 */
export function resolveDefaultUrls(
  addons: AddonEntry[],
  manifestIdOrder: readonly string[],
): string[] {
  if (addons.length === 0 || manifestIdOrder.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of manifestIdOrder) {
    const match = addons.find(
      (a) => a.manifest_id === id && !seen.has(a.url),
    );
    if (match) {
      out.push(match.url);
      seen.add(match.url);
    }
  }
  return out;
}
