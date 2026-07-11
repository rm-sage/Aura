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
//   const metaUrl  = resolveDefaultMetaUrl(addons);
//
// Each `*_ORDER` constant is a ranked list of manifest.id values. The
// resolver walks the list, finds the first installed addon for each id,
// and emits its URL. Missing ids are silently skipped — a fresh-install
// user with only Cinemeta still gets Cinemeta as the primary, not a
// broken slot.
// ---------------------------------------------------------------------------

import type { AddonEntry } from "./types";

/** Cinemeta — the universal Stremio meta provider. Used as the meta
 *  fallback when AIOMetadata isn't installed, since Cinemeta ships with
 *  every Stremio install and exposes the same media-type catalogs. */
export const CINEMETA_MANIFEST_ID = "com.linvo.cinemeta";

/** AIOMetadata's manifest id — the user's preferred meta provider. The
 *  exact string comes from the addon's manifest.json. We prefer this
 *  over Cinemeta when installed because AIOMetadata exposes richer
 *  fields (originalLanguage / productionCountries / mal/kitsu/anidb id
 *  cross-refs) that drive Aura's audio scoring + anime-skip path. */
export const AIOMETADATA_MANIFEST_ID = "com.aiometadata";

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

/** Default meta-provider preference: AIOMetadata first, Cinemeta fallback. */
export const DEFAULT_META_ORDER: readonly string[] = [
  AIOMETADATA_MANIFEST_ID,
  CINEMETA_MANIFEST_ID,
] as const;

/** Default search providers for FULL searches. AI search included
 *  here (it's worth the latency for a deliberate Enter-search). */
export const DEFAULT_SEARCH_ORDER: readonly string[] = [
  "community.aiosearch",
  "community.aisearch",
  AIOMETADATA_MANIFEST_ID,
  CINEMETA_MANIFEST_ID,
] as const;

/** Default stream providers — empty means "all installed stream addons
 *  are queried" (the existing null-default semantics). We don't bake
 *  preferred stream addons into the default since the user's preferred
 *  set tends to depend on their debrid/account configuration, which is
 *  more variable than catalog/meta preferences. */
export const DEFAULT_STREAM_ORDER: readonly string[] = [] as const;

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

/**
 * Resolve the default meta-provider URL: AIOMetadata if installed,
 * Cinemeta otherwise, null if neither is installed (caller falls back
 * to first installed addon with the meta resource, or to no override).
 */
export function resolveDefaultMetaUrl(addons: AddonEntry[]): string | null {
  const ranked = resolveDefaultUrls(addons, DEFAULT_META_ORDER);
  return ranked[0] ?? null;
}

/**
 * Resolve a stored manifest-id-keyed list back to URLs, falling back to
 * the install-order default when the stored list is null. Used by
 * settings consumers that want a concrete URL list to feed downstream.
 *
 * `storedManifestIds` is the user's saved preference; `defaultOrder` is
 * the fallback ordering when nothing is stored. Returns a deduped URL
 * list, walking stored ids first, then default ids — that way a user
 * who has explicitly committed an order keeps it, and missing ids
 * auto-fill from defaults rather than vanishing.
 */
export function resolveStoredOrDefault(
  addons: AddonEntry[],
  storedManifestIds: readonly string[] | null,
  defaultOrder: readonly string[],
): string[] {
  if (storedManifestIds === null) {
    return resolveDefaultUrls(addons, defaultOrder);
  }
  return resolveDefaultUrls(addons, storedManifestIds);
}
