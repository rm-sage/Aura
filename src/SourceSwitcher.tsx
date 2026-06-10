// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// SourceSwitcher — swap the streaming source for the CURRENTLY-PLAYING item
// in place, without leaving the player.
//
// A transient centered modal (above PlayerOverlay's z-[9999]) listing the
// other sources for the active target. Clicking a row re-invokes the canonical
// play path (App.handlePlayStream) with `forceStartSeconds` = the live
// position, so the swap inherits resolve → preheat → lang/subtitle/loudnorm/
// motion-interp/aniskip/thumb-prewarm for free and resumes at the same moment.
//
// Purely presentational: App owns the fetch + swap + open state and passes
// everything in. Opened via the `aura:open-source-switcher` window event
// dispatched from PlayerOverlay's MoreMenu.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import type { StreamEntry } from "./types";

/** Stable identity for a stream row — used for the "now playing" + resolving
 *  markers. Mirrors how App keys the swap. */
export function streamKey(s: StreamEntry): string {
  return s.info_hash ?? s.url ?? `${s.addon_name}:${s.title}`;
}

interface SourceSwitcherProps {
  open: boolean;
  onClose: () => void;
  streams: StreamEntry[];
  loading: boolean;
  onPick: (stream: StreamEntry) => void;
  /** streamKey() of the row mid-resolve (spinner), or null. */
  resolvingKey: string | null;
  /** Raw URL of the currently-playing stream (== activeStreamUrl). */
  currentUrl: string | null;
  /** Windowed playback keeps the 36px Win32 title bar — offset for it. */
  isFullscreen: boolean;
}

export default function SourceSwitcher({
  open, onClose, streams, loading, onPick, resolvingKey, currentUrl, isFullscreen,
}: SourceSwitcherProps) {
  // Esc closes (capture phase so it wins over the player's global keybinds).
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
      {/* Scrim */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />

      {/* Panel */}
      <div
        className="relative w-[min(560px,92vw)] max-h-[78vh] flex flex-col
                   rounded-2xl aura-glass-menu shadow-glass-edge overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Switch source"
      >
        <div className="flex items-baseline justify-between px-5 pt-4 pb-3 border-b border-white/8">
          <h2 className="text-white text-[16px] font-semibold tracking-tight">Switch source</h2>
          <span className="text-white/45 text-[12px] font-mono tabular-nums">
            {loading ? "finding…" : `${streams.length} source${streams.length === 1 ? "" : "s"}`}
          </span>
        </div>

        <div className="overflow-y-auto px-2 py-2 aura-scroll">
          {loading && streams.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-3 text-white/50">
              <Spinner />
              <span className="text-[13px]">Finding other sources…</span>
            </div>
          ) : streams.length === 0 ? (
            <div className="py-10 text-center text-white/45 text-[13px]">
              No other sources available.
            </div>
          ) : (
            streams.map((s) => {
              const key = streamKey(s);
              const isCurrent = s.url != null && s.url === currentUrl;
              const resolving = resolvingKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={isCurrent || resolving}
                  onClick={() => onPick(s)}
                  className={`w-full text-left rounded-xl px-3 py-2.5 mb-1 flex items-center gap-3
                              transition-colors
                              ${isCurrent
                                ? "bg-ln-accent/10 cursor-default"
                                : "hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-ln-accent/80 text-[10.5px] font-mono uppercase tracking-wider truncate max-w-[40%]">
                        {s.addon_name}
                      </span>
                      {isCurrent && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded
                                         bg-ln-accent/20 text-ln-accent border border-ln-accent/30">
                          Now Playing
                        </span>
                      )}
                    </div>
                    <p className="text-white/90 text-[13.5px] font-medium leading-snug line-clamp-2 mt-0.5"
                       title={s.filename ?? s.title}>
                      {s.title}
                    </p>
                    {s.description && (
                      <p className="text-white/40 text-[11.5px] leading-snug line-clamp-1 mt-0.5">
                        {s.description}
                      </p>
                    )}
                  </div>
                  {resolving && <Spinner small />}
                </button>
              );
            })
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-white/8 text-white/35 text-[11px]">
          Click a source to swap in place · Esc to close
        </div>
      </div>
    </div>
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
