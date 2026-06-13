// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PlayerPartyHud — in-player watch-party chrome: a presence cluster (top
// right) showing who's in the party + their sync state, and the "waiting for
// the party" staging banner (host gets a Start-now override). Rendered by App
// alongside PlayerOverlay while a stream is up.
//
// z-index: PlayerOverlay's root is z-[9999] with a full-screen click-to-pause
// surface (pointer-events-auto). This HUD MUST sit above it (z-[10000], below
// the SourceSwitcher's z-[10001]) so (a) the chrome isn't washed out under the
// overlay's gradient scrims, and (b) the Start-now button receives clicks
// instead of the overlay's pause surface eating them. The HUD's own elements
// carry pointer-events so clicking them never falls through to play/pause.
// ---------------------------------------------------------------------------

import { useWatchTogether } from "./watchTogether/useWatchTogether";

interface Props {
  /** Host override: start the party now (stop waiting). */
  onStart: () => void;
  isFullscreen: boolean;
}

// Drop-shadow on text so labels stay legible over bright video (clouds, snow).
const TEXT_SHADOW = "[text-shadow:_0_1px_4px_rgba(0,0,0,0.85)]";

export default function PlayerPartyHud({ onStart, isFullscreen }: Props) {
  const w = useWatchTogether();
  if (w.status !== "connected") return null;

  const onTitle = (vk: string | null) => w.roomVideoKey != null && vk === w.roomVideoKey;
  const readyHere = w.members.filter((m) => onTitle(m.videoKey)).length;
  const total = w.members.length;
  const openPanel = () => window.dispatchEvent(new CustomEvent("aura:open-watch-together"));

  return (
    <>
      {/* Presence cluster — top right, dropped BELOW the overlay's top action
          bar (exit button + title span left-4→right-4) so it never covers a
          long title; above the overlay so it's never washed out; click to open
          the party panel. */}
      <button
        type="button"
        data-party-anchor
        onClick={openPanel}
        title="Watch party — open"
        className="fixed right-4 z-[10000] pointer-events-auto flex items-center gap-1.5 px-2.5 h-9
                   rounded-full bg-black/70 backdrop-blur-xl border border-white/15
                   shadow-[0_4px_16px_rgba(0,0,0,0.55)] hover:bg-black/80 transition-colors"
        style={{ top: isFullscreen ? 60 : 96 }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ln-accent" aria-hidden>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        <div className="flex -space-x-1.5">
          {w.members.slice(0, 5).map((m) => {
            const isLeader = m.id === w.leaderId;
            return (
              <span
                key={m.id}
                title={`${m.name}${m.id === w.selfId ? " (you)" : ""}${isLeader ? " · host" : ""}${onTitle(m.videoKey) ? "" : " · different title"}`}
                className={[
                  "relative w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold uppercase",
                  "ring-2 ring-black/60",
                  isLeader ? "z-10" : "",
                  onTitle(m.videoKey) ? "bg-emerald-500/40 text-emerald-50" : "bg-amber-500/40 text-amber-50",
                ].join(" ")}
              >
                {(m.name || "?").slice(0, 2)}
                {isLeader && (
                  <span
                    aria-hidden
                    className="absolute -top-2 left-1/2 -translate-x-1/2 text-[9px] leading-none text-amber-300
                               [text-shadow:_0_1px_2px_rgba(0,0,0,0.9)]"
                  >
                    ♛
                  </span>
                )}
              </span>
            );
          })}
        </div>
        {total > 5 && <span className="text-white/75 text-[11px] tabular-nums">+{total - 5}</span>}
      </button>

      {/* Staging banner — playback is held until the party joins. Solid dark
          backdrop + text-shadow so it reads over any video. */}
      {w.staging && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[10000] pointer-events-auto rounded-2xl
                     bg-black/80 backdrop-blur-xl border border-white/15
                     shadow-[0_8px_30px_rgba(0,0,0,0.65)] px-5 py-3 flex items-center gap-4"
          // Raised to clear the player control bar (scrubber + buttons sit ~36px
          // up from the bottom; fullscreen's bar sits a touch lower).
          style={{ bottom: isFullscreen ? 124 : 156 }}
          role="status"
        >
          <div>
            <p className={`text-white text-[13px] font-semibold leading-tight ${TEXT_SHADOW}`}>
              {w.amStaging ? "Waiting for the party to join…" : "Waiting for the host to start…"}
            </p>
            <p className={`text-white/70 text-[11.5px] leading-tight tabular-nums ${TEXT_SHADOW}`}>
              {readyHere} of {total} here{w.roomTitle ? ` · ${w.roomTitle}` : ""}
            </p>
          </div>
          {w.amStaging && (
            <button
              type="button"
              onClick={onStart}
              className="pointer-events-auto px-3.5 h-9 rounded-xl text-[13px] font-semibold
                         bg-ln-accent text-black border border-ln-accent
                         hover:brightness-110 active:brightness-95 transition-[filter] whitespace-nowrap
                         shadow-[0_2px_10px_rgba(0,0,0,0.4)]"
            >
              Start now
            </button>
          )}
        </div>
      )}
    </>
  );
}
