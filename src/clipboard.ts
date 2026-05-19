// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Copy text to the clipboard. Prefers the Tauri clipboard plugin
 *  (reliable on every WebView2 build), falling back to the browser
 *  Clipboard API. Both paths are wrapped so a missing permission can
 *  never crash the app; resolves `false` only when BOTH fail. */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return true;
  } catch (e) {
    // Browser fallback — some hosts (older WebView2 builds without the
    // permission strings) reject the plugin call. The HTML5 clipboard
    // API still works there.
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e2) {
      console.error("clipboard write failed", e, e2);
      return false;
    }
  }
}
