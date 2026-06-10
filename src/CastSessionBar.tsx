// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// CastSessionBar — floating "Casting to <device>" control strip shown
// while a cast session is active (local MPV is paused underneath).
// Play/pause, ±15 s, stop-and-resume-locally.
// ---------------------------------------------------------------------------

import type { CastStatus } from "./cast";

interface CastSessionBarProps {
  deviceName: string;
  status: CastStatus | null;
  onTogglePlayPause: () => void;
  onSeekBy: (deltaSec: number) => void;
  onStop: () => void;
  isFullscreen: boolean;
}

function fmt(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
}

export default function CastSessionBar({
  deviceName, status, onTogglePlayPause, onSeekBy, onStop, isFullscreen,
}: CastSessionBarProps) {
  const playing = status?.player_state === "playing";
  const buffering = status?.player_state === "buffering";
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[10000] aura-glass-bar rounded-2xl
                 shadow-glass-edge px-4 py-2.5 flex items-center gap-3"
      style={{ bottom: isFullscreen ? 24 : 56 }}
      role="status"
    >
      <CastGlyph />
      <div className="min-w-0">
        <p className="text-white/90 text-[13px] font-medium leading-tight truncate max-w-[220px]">
          Casting to {deviceName}
        </p>
        <p className="text-white/45 text-[11px] tabular-nums leading-tight">
          {buffering
            ? "buffering…"
            : status
              ? `${fmt(status.position_sec)}${status.duration_sec ? ` / ${fmt(status.duration_sec)}` : ""}`
              : "connecting…"}
        </p>
      </div>

      <div className="w-px self-stretch bg-white/10 mx-1" />

      <BarButton label="Back 15 seconds" onClick={() => onSeekBy(-15)}>
        <path d="M11 17l-5-5 5-5" /><path d="M18 17l-5-5 5-5" />
      </BarButton>
      <BarButton label={playing ? "Pause" : "Play"} onClick={onTogglePlayPause}>
        {playing
          ? <><path d="M10 5v14" /><path d="M14 5v14" /></>
          : <path d="M8 5l11 7-11 7V5z" />}
      </BarButton>
      <BarButton label="Forward 15 seconds" onClick={() => onSeekBy(15)}>
        <path d="M13 17l5-5-5-5" /><path d="M6 17l5-5-5-5" />
      </BarButton>

      <div className="w-px self-stretch bg-white/10 mx-1" />

      <button
        type="button"
        onClick={onStop}
        className="text-[12px] font-medium text-rose-300/85 hover:text-rose-200 transition-colors px-1"
      >
        Stop casting
      </button>
    </div>
  );
}

function BarButton({
  label, onClick, children,
}: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="p-1.5 rounded-lg text-white/75 hover:text-white hover:bg-white/[0.08] transition-colors"
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function CastGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
         className="text-sky-300/85 flex-shrink-0" aria-hidden>
      <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
      <circle cx="2" cy="20" r="0.5" fill="currentColor" />
    </svg>
  );
}
