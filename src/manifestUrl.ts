// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** A manifest url as the user pasted it, ready for add_addon / cloud_add_addon.
 *  Addon configure pages (AIOStreams, AIOMetadata) hand out an Install link
 *  with the `stremio://` scheme next to the copy button; it is the https
 *  manifest url with the scheme swapped, and Rust's validate_url accepts only
 *  http(s). Never log the result: a manifest url carries the addon's token. */
export function normalizeManifestInput(text: string): string {
  return text.trim().replace(/^stremio:\/\//i, "https://");
}
