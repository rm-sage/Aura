// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// AuraLogoA — the app's branded "A" mark.
//
// A glass-morphism letter A with the spectral Aura sweep refracted through
// it. The visual is built from:
//   • A clipped path (background-clip: text) running the same animated
//     gradient as the title-bar wordmark
//   • An inner highlight via -webkit-text-stroke
//   • Twin drop-shadows for depth
// All movement comes from the shared `aura-sweep-anim` keyframe so the A
// shimmers in lockstep with the title-bar wordmark and ambient backdrop.
// ---------------------------------------------------------------------------

interface Props {
  /** Logical pixel size of the bounding box. Letterform scales with it. */
  size?: number;
  className?: string;
}

export default function AuraLogoA({ size = 32, className }: Props) {
  return (
    <span
      className={`aura-logo-a inline-flex items-center justify-center
                  flex-shrink-0 select-none ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        // Letter is sized to fill ~88 % of the box.
        fontSize: size * 0.88,
        lineHeight: 1,
      }}
      aria-hidden
    >
      A
    </span>
  );
}
