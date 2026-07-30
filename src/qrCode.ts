// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// qrCode — encode a short string as an SVG path.
//
// Used by the Trakt device-flow panel so the user can authorize from their
// phone (which is already signed in to Trakt) instead of typing the code on
// the desktop. Device flow is deliberately device-agnostic: the Rust poll
// loop completes regardless of WHICH device approved the code, so scanning
// the QR is a genuine shortcut rather than a gimmick.
//
// Returns path data rather than an `<svg>` string on purpose: the caller
// renders real React elements, so nothing goes through
// dangerouslySetInnerHTML. `qrcode-generator` is pure JS with no transitive
// dependencies and no network access, which matters because Artifacts-style
// CSP rules and Aura's offline-first posture rule out a CDN renderer.
//
// The result is a plain string; callers should `useMemo` on the input text
// so a re-render doesn't re-run the encoder (see the "bound every cache"
// rule in CLAUDE.md — this holds no module-level state at all).
// ---------------------------------------------------------------------------

import qrcode from "qrcode-generator";

export interface QrCode {
  /** SVG path `d` covering every dark module. */
  path: string;
  /** viewBox edge length in module units, margin included. */
  size: number;
}

/** Encode `text` as QR path data, or null if it cannot be encoded (too
 *  long for the largest version, or an empty string). Never throws — a
 *  missing QR degrades to "type the code manually", which is still a
 *  complete flow. */
export function encodeQr(text: string, margin = 2): QrCode | null {
  if (!text) return null;
  try {
    // Type number 0 = pick the smallest version that fits. "M" error
    // correction (~15%) survives phone-camera glare at this size.
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    let path = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) {
          path += `M${col + margin} ${row + margin}h1v1h-1z`;
        }
      }
    }
    return path ? { path, size: count + margin * 2 } : null;
  } catch {
    return null;
  }
}
