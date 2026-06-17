// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// EPG parse worker. Moves the XMLTV scan + index build OFF the main thread so
// a large guide (the bundled iptv-org US EPG inflates to tens of MB even after
// the Rust-side cap) no longer freezes the UI on entry to Live TV. The heavy
// string scanning + per-programme entity decode runs here; only the finished,
// playlist-filtered index crosses back via structured clone.
//
// `buildEpgIndex` is pure (no DOM / Tauri), so the exact same call is used as a
// main-thread fallback in epgStore.ts when a Worker can't be created.
// ---------------------------------------------------------------------------

import { buildEpgIndex } from "./xmltv";

export interface EpgParseRequest {
  body: string;
  /** Only the resolver join fields — keeps the postMessage payload small. */
  channels: Array<{ tvgId: string; name: string }>;
}

export type EpgParseResponse =
  | { ok: true; index: import("./types").EpgIndex; rawHasPrograms: boolean }
  | { ok: false; error: string };

self.onmessage = (e: MessageEvent<EpgParseRequest>) => {
  try {
    const { index, rawHasPrograms } = buildEpgIndex(e.data.body, e.data.channels);
    // EpgIndex holds Maps; structured clone copies those natively.
    (self as unknown as Worker).postMessage({ ok: true, index, rawHasPrograms } satisfies EpgParseResponse);
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies EpgParseResponse);
  }
};
