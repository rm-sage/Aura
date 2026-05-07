// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// SpectralPulse — three orbiting blurred discs (indigo / teal / violet) with
// a "Loading…" caption underneath. Centred horizontally + vertically in the
// container, the trio breathes (scale 0.85 → 1.15) while the discs orbit.
//
// Brightness ramps with elapsed time against the AIOStreams cap:
//   • movies / anime movies   → 7 s
//   • series / anime series   → 12 s
//
// AIOStreams returns ALL streams in a single response when its internal
// timeout elapses, so brightness is driven by wall time, not by streams
// received. Once streams land, the parent unmounts the loader.
// ---------------------------------------------------------------------------

interface Props {
  active: boolean;
  /** Manual brightness override [0..1]; disables the timer-based ramp. */
  intensity?: number;
  /** Compact variant — smaller orbit, no caption. Used inline as a
   *  "still discovering" badge once some streams have already arrived. */
  small?: boolean;
  /** Total wait window in seconds — drives the auto-ramp. Default 7. */
  capSeconds?: number;
}

export default function SpectralPulse({
  active, intensity, small, capSeconds = 7,
}: Props) {
  // ── Time-based intensity ramp ────────────────────────────────────
  // When `intensity` is unset, drive brightness from elapsed wall time
  // against the AIOStreams cap. Quantised to 1 % steps.
  const [auto, setAuto] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!active || intensity != null) return;
    let raf = 0;
    startedAtRef.current = performance.now();
    let lastSnap = 0;
    const tick = () => {
      if (startedAtRef.current == null) return;
      const elapsed = (performance.now() - startedAtRef.current) / 1000;
      const next = Math.min(1, elapsed / capSeconds);
      const snapped = Math.round(next * 100) / 100;
      if (snapped !== lastSnap) {
        lastSnap = snapped;
        setAuto(snapped);
      }
      if (next < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, intensity, capSeconds]);

  if (!active) return null;

  const i = Math.max(0, Math.min(1, intensity ?? auto));
  const size = small ? 96 : 200;
  const orbit = size * 0.32;
  // Orbit speed: 7 s at intensity 0, 1.6 s at intensity 1.
  const period = (1.6 + (1 - i) * 5.4).toFixed(2);
  // Disc opacity ramps 0.4 → 0.95 over the cap.
  const alpha = 0.4 + i * 0.55;
  // Breathing period — the whole cluster pulses in/out subtly.
  const breathe = 2.4;

  const discStyle = (color: string, phaseDeg: number): React.CSSProperties => {
    // Combined into a single `animation` shorthand to avoid React's
    // shorthand-vs-longhand mixing warning (which fires when both
    // `animation` and `animationDelay` are set on the same element).
    const delay = (-(phaseDeg / 360) * parseFloat(period)).toFixed(3);
    return {
      position: "absolute",
      left: "50%",
      top: "50%",
      width: size * 0.55,
      height: size * 0.55,
      marginLeft: -(size * 0.55) / 2,
      marginTop: -(size * 0.55) / 2,
      borderRadius: "50%",
      background: color,
      filter: `blur(${size * 0.18}px)`,
      opacity: alpha,
      transformOrigin: "center center",
      animation: `spectral-orbit ${period}s linear ${delay}s infinite`,
      ["--orbit" as never]: `${orbit}px`,
    };
  };

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center gap-5"
      role="status"
      aria-label="Discovering streams"
      aria-live="polite"
    >
      {/* Orbiting discs — wrapped in a "breathing" wrapper that scales
          the whole cluster in and out, while each disc orbits its own
          phase. Fixed-size box so the rotating elements don't push
          surrounding layout. */}
      <div
        className="relative gpu-layer"
        style={{
          width: size,
          height: size,
          animation: `spectral-breathe ${breathe}s ease-in-out infinite`,
        }}
      >
        <span style={discStyle(`rgba(99, 102, 241, 1)`, 0)}    aria-hidden /> {/* indigo */}
        <span style={discStyle(`rgba(20, 184, 166, 1)`, 120)}  aria-hidden /> {/* teal   */}
        <span style={discStyle(`rgba(167, 139, 250, 1)`, 240)} aria-hidden /> {/* violet */}
      </div>

      {!small && (
        <p className="text-white/55 text-[12.5px] font-mono uppercase tracking-[0.28em]">
          Loading…
        </p>
      )}

      <style>{`
        @keyframes spectral-orbit {
          0%   { transform: rotate(0deg)   translateX(var(--orbit)) rotate(0deg); }
          100% { transform: rotate(360deg) translateX(var(--orbit)) rotate(-360deg); }
        }
        @keyframes spectral-breathe {
          0%, 100% { transform: scale(0.85); }
          50%      { transform: scale(1.15); }
        }
      `}</style>
    </div>
  );
}
