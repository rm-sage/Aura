// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PlayerPartyHud — in-player watch-party chrome: a presence cluster (top
// right) showing who's in the party + their sync state, and the "waiting for
// the party" staging banner (host gets a Start-now override). Rendered by App
// alongside PlayerOverlay while a stream is up.
// ---------------------------------------------------------------------------

import { useWatchTogether } from "./watchTogether/useWatchTogether";

interface Props {
  /** Host override: start the party now (stop waiting). */
  onStart: () => void;
  isFullscreen: boolean;
}

export default function PlayerPartyHud({ onStart, isFullscreen }: Props) {
  const w = useWatchTogether();
  if (w.status !== "connected") return null;

  const onTitle = (vk: string | null) => w.roomVideoKey != null && vk === w.roomVideoKey;
  const readyHere = w.members.filter((m) => onTitle(m.videoKey)).length;
  const total = w.members.length;

  return (
    <>
      {/* Presence cluster — top right, below the title-bar inset. */}
      <div
        className="fixed right-4 z-[60] flex items-center gap-1.5 px-2.5 h-9 rounded-full
                   bg-black/45 backdrop-blur-md border border-white/10"
        style={{ top: isFullscreen ? 12 : 48 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ln-accent/85" aria-hidden>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <div className="flex -space-x-1.5">
          {w.members.slice(0, 5).map((m) => (
            <span
              key={m.id}
              title={`${m.name}${m.id === w.selfId ? " (you)" : ""}${onTitle(m.videoKey) ? "" : " · different title"}`}
              className={[
                "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold uppercase",
                "ring-2 ring-black/45",
                onTitle(m.videoKey) ? "bg-emerald-500/30 text-emerald-100" : "bg-amber-500/30 text-amber-100",
              ].join(" ")}
            >
              {(m.name || "?").slice(0, 2)}
            </span>
          ))}
        </div>
        {total > 5 && <span className="text-white/55 text-[11px] tabular-nums">+{total - 5}</span>}
      </div>

      {/* Staging banner — playback is held until the party joins. */}
      {w.staging && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[70] aura-glass-bar rounded-2xl shadow-glass-edge
                     px-5 py-3 flex items-center gap-4"
          style={{ bottom: isFullscreen ? 96 : 120 }}
          role="status"
        >
          <div>
            <p className="text-white/90 text-[13px] font-medium leading-tight">
              {w.amStaging ? "Waiting for the party to join…" : "Waiting for the host to start…"}
            </p>
            <p className="text-white/45 text-[11.5px] leading-tight tabular-nums">
              {readyHere} of {total} here{w.roomTitle ? ` · ${w.roomTitle}` : ""}
            </p>
          </div>
          {w.amStaging && (
            <button
              type="button"
              onClick={onStart}
              className="px-3.5 h-9 rounded-xl text-[13px] font-semibold bg-ln-accent/20 text-ln-accent
                         border border-ln-accent/30 hover:bg-ln-accent/30 transition-colors whitespace-nowrap"
            >
              Start now
            </button>
          )}
        </div>
      )}
    </>
  );
}
