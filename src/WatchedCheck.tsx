// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// WatchedCheck — green checkmark badge with a dark halo + light inner ring.
//
// Used on episode thumbnails and catalog poster corners to flag fully-watched
// items. The double-ring shadow is what keeps it readable on:
//   • bright backgrounds (the dark halo gives separation)
//   • green poster art (the white inner ring + saturated green-500 still
//     reads as "watched", and the white check sits on the green disc)
// ---------------------------------------------------------------------------

interface Props {
  className?: string;
  /** Side length in px. Default 20 (matches w-5 h-5). */
  size?: number;
}

export default function WatchedCheck({ className = "", size = 20 }: Props) {
  return (
    <div
      className={`flex items-center justify-center rounded-full ${className}`}
      style={{
        width:  size,
        height: size,
        background: "rgb(34, 197, 94)", // green-500
        boxShadow:
          "0 0 0 1.5px rgba(0,0,0,0.85), 0 0 0 2.5px rgba(255,255,255,0.25), 0 2px 6px rgba(0,0,0,0.55)",
      }}
      aria-label="Watched"
    >
      <svg
        width={Math.round(size * 0.55)}
        height={Math.round(size * 0.55)}
        viewBox="0 0 24 24"
        fill="white"
        aria-hidden
      >
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
      </svg>
    </div>
  );
}
