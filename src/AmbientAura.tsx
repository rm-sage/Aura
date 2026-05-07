// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// AmbientAura — app-wide spectral sweep behind everything.
//
// The TitleBar already runs a 20 s sweep across its strip; this component
// extends the same idea to the ENTIRE app background as a low-opacity
// ambient backdrop. Everything is GPU-composited and runs in a single fixed
// element so the rest of the app pays nothing for it.
//
// CRITICAL: hidden via display:none while a video is loaded. The 6-10 %
// spectral gradient paints into the WebView2 surface and, even at low alpha,
// prevents the OS compositor from showing the native MPV layer behind the
// webview. display:none avoids any paint contribution while preserving the
// animation position so the sweep resumes seamlessly on playback exit.
// ---------------------------------------------------------------------------

interface Props {
  /** Pass `true` while a video is loaded — the component renders nothing. */
  hidden?: boolean;
}

export default function AmbientAura({ hidden }: Props) {
  return (
    <div
      aria-hidden
      className="aura-ambient"
      style={hidden ? { display: "none" } : undefined}
    />
  );
}
