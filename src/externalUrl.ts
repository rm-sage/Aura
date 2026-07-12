// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// externalUrl — the ONE gate for handing a URL to the OS shell opener.
//
// `@tauri-apps/plugin-opener`'s openUrl is `ShellExecute` on Windows: it will
// happily launch `file:///C:/…/payload.exe`, a UNC `\\attacker\share\payload`,
// or a dangerous protocol handler (`ms-msdt:`, `search-ms:`, `steam://`). Some
// of the URLs we open come from Stremio ADDONS (a stream's `url`, an addon's
// configure / manifest URL), which are attacker-controlled if the user installs
// a hostile addon or an addon is served over plain HTTP and MITM'd. So every
// external open MUST pass through here, which refuses anything that is not plain
// http(s). The in-app popup path (`popup_nav.rs`) already does the same on the
// Rust side; this closes the shell-opener path the same way.
// ---------------------------------------------------------------------------

import { openUrl } from "@tauri-apps/plugin-opener";

import { showAppToast } from "./AppToast";

/** True only for a well-formed http/https URL. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

/** Open a URL in the user's default browser, but ONLY when it is http(s).
 *  Anything else is refused with a toast rather than handed to the shell. */
export function openExternalUrl(url: string): void {
  if (!isSafeExternalUrl(url)) {
    showAppToast("Refused to open a non-web link for safety.", { tone: "danger" });
    return;
  }
  openUrl(url).catch(() => {
    showAppToast("Could not open that link.", { tone: "danger" });
  });
}
