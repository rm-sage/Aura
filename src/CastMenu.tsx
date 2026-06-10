// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// CastMenu — the cast device picker. A transient centered modal (same
// shell pattern as SourceSwitcher: scrim + glass panel above
// PlayerOverlay's z-[9999]). Purely presentational; useCastSession owns
// discovery + session state.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import type { CastDeviceInfo } from "./cast";

interface CastMenuProps {
  open: boolean;
  onClose: () => void;
  devices: CastDeviceInfo[];
  scanning: boolean;
  onRescan: () => void;
  onPick: (d: CastDeviceInfo) => void;
  connectingId: string | null;
  error: string | null;
  isFullscreen: boolean;
}

export default function CastMenu({
  open, onClose, devices, scanning, onRescan, onPick, connectingId, error, isFullscreen,
}: CastMenuProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center"
      style={{ top: isFullscreen ? 0 : 36 }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />

      <div
        className="relative w-[min(440px,92vw)] max-h-[70vh] flex flex-col
                   rounded-2xl aura-glass-menu shadow-glass-edge overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Cast to device"
      >
        <div className="flex items-baseline justify-between px-5 pt-4 pb-3 border-b border-white/8">
          <h2 className="text-white text-[16px] font-semibold tracking-tight">Cast to device</h2>
          <button
            type="button"
            onClick={onRescan}
            disabled={scanning}
            className="text-[12px] text-white/55 hover:text-white/85 transition-colors disabled:opacity-40"
          >
            {scanning ? "scanning…" : "rescan"}
          </button>
        </div>

        <div className="overflow-y-auto px-2 py-2 aura-scroll">
          {scanning && devices.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-3 text-white/50">
              <Spinner />
              <span className="text-[13px]">Looking for devices on your network…</span>
            </div>
          ) : devices.length === 0 ? (
            <div className="py-10 px-6 text-center text-white/45 text-[13px] leading-relaxed">
              No cast devices found. Make sure the TV / Chromecast is powered
              on and on the same network, then rescan.
            </div>
          ) : (
            devices.map((d) => {
              const connecting = connectingId === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={connecting}
                  onClick={() => onPick(d)}
                  className="w-full text-left rounded-xl px-3 py-2.5 mb-1 flex items-center gap-3
                             transition-colors hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"
                >
                  <TvIcon kind={d.kind} />
                  <div className="min-w-0 flex-1">
                    <p className="text-white/90 text-[13.5px] font-medium leading-snug truncate">
                      {d.name}
                    </p>
                    <p className="text-white/40 text-[11px] leading-snug truncate">
                      {d.kind === "chromecast" ? "Chromecast" : "DLNA"}
                      {d.model ? ` · ${d.model}` : ""}
                      {d.audio_only ? " · audio only" : ""}
                    </p>
                  </div>
                  {connecting && <Spinner small />}
                </button>
              );
            })
          )}
          {error && (
            <p className="px-3 py-2 text-rose-300/85 text-[12px] leading-snug">{error}</p>
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-white/8 text-white/35 text-[11px]">
          Local playback pauses while casting · Esc to close
        </div>
      </div>
    </div>
  );
}

function TvIcon({ kind }: { kind: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
         className={`flex-shrink-0 ${kind === "chromecast" ? "text-sky-300/80" : "text-emerald-300/80"}`}
         aria-hidden>
      <rect x="2" y="5" width="20" height="13" rx="2" />
      <path d="M8 21h8" />
    </svg>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const sz = small ? "w-4 h-4" : "w-6 h-6";
  return (
    <svg className={`${sz} animate-spin text-white/55 flex-shrink-0`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
