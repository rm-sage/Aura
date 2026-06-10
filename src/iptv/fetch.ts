// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// IPTV network hop — every playlist / EPG / Xtream-API fetch goes
// through the `iptv_fetch_text` Rust command (src-tauri/src/iptv.rs):
// the backend sends the IPTV-client User-Agent providers gate on, has
// no CORS constraints, and enforces the size cap. The frontend never
// fetches IPTV endpoints directly.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { dedupedInvoke } from "../invokeDedupe";

/** Fetch a text body (M3U / XMLTV / Xtream JSON) via the backend.
 *  In-flight deduped per URL so a rescan storm can't stack requests. */
export function iptvFetchText(url: string): Promise<string> {
  return dedupedInvoke(`iptv:${url}`, () =>
    invoke<string>("iptv_fetch_text", { url }),
  );
}
