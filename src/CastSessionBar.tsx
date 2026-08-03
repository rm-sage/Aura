// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// CastSessionBar — floating "Casting to <device>" control strip shown
// while a cast session is active (local MPV is paused underneath).
// Play/pause, ±15 s, stop-and-resume-locally.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
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

/**
 * Wall-clock interpolation of the cast position between device-status polls.
 *
 * `fmt` above renders SECONDS, but `status` only refreshes on useCastSession's
 * 2 s poll, so the timecode used to step 0:00 -> 0:02 -> 0:04 with jitter from
 * the device RTT. Polling faster is the wrong fix: every poll is a fresh CASTV2
 * TLS connect or a DLNA SOAP call, and that cadence is a deliberate LAN-chatter
 * budget (see cast/mod.rs). So the bar runs its own clock between samples and
 * re-anchors on each one, which costs no extra device traffic at all.
 *
 * Only while PLAYING: a paused or buffering device is not advancing, and a
 * stopped one has nothing to advance. Interpolating is safe against overshoot
 * because our anchor is already ~RTT/2 behind the device's true position, so
 * re-anchoring pulls the display forward rather than snapping it back.
 */
/** How far the device may report BEHIND our projection before we believe it is
 *  a real rewind rather than poll jitter. Comfortably above DLNA's 1 s
 *  quantisation plus RTT variance, and far below the 15 s skip buttons. */
const SEEK_EPSILON_SEC = 2;

function useInterpolatedPosition(status: CastStatus | null): number | null {
  const reported = status?.position_sec ?? null;
  const duration = status?.duration_sec ?? null;
  const playing = status?.player_state === "playing";

  const [anchor, setAnchor] = useState<{ at: number; pos: number } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Re-anchor on every position the device reports. The device stays the source
  // of truth; we only fill the gaps.
  //
  // `playing` is load-bearing in the dep list, NOT decoration. `reported` is a
  // primitive, so React skips this effect whenever a poll repeats the same
  // number, and a DLNA renderer repeats it constantly: dlna.rs parses `RelTime`,
  // which AVTransport renders as HH:MM:SS, so positions are whole seconds and do
  // not move at all across a pause. Without `playing` here, `anchor.at` would
  // stay pinned at the instant playback stopped while the projection below
  // credits every millisecond since then as PLAYED time. Resuming after a
  // 5-minute pause would then read 6:41 instead of 1:41 (or clamp to the
  // duration and look finished) until the next poll happened to report a
  // different second. Re-stamping on the play-state transition costs nothing:
  // both deps are primitives, so this still only runs on genuine transitions.
  // Chromecast masked the bug, because castv2.rs reports `currentTime` as a
  // float that almost always differs.
  const prevPlayingRef = useRef(playing);
  useEffect(() => {
    const playStateChanged = prevPlayingRef.current !== playing;
    prevPlayingRef.current = playing;
    if (reported == null) {
      setAnchor(null);
      return;
    }
    const at = Date.now();
    setAnchor((prev) => {
      // MONOTONIC GUARD. A fresh sample routinely lands slightly BEHIND what we
      // are already projecting: it was taken ~RTT/2 ago, the RTT jitters between
      // polls, and DLNA quantises to whole seconds. Accepting it verbatim would
      // step the timecode backwards ("1:43 -> 1:42 -> 1:43"), which the old
      // 2 s-stepping display never did, so it would read as a new glitch. Hold
      // the current anchor for a sub-SEEK_EPSILON regression and let the clock
      // carry on; a genuine rewind (the -15 s button, or a seek on the device)
      // clears the threshold easily and is accepted at once. Clock drift cannot
      // accumulate past the threshold, because a bigger gap is always taken.
      //
      // Skipped when the play state just flipped: that anchor is stale by the
      // whole pause and MUST be replaced, however far back it drags us.
      if (prev && playing && !playStateChanged) {
        const projected = prev.pos + Math.max(0, at - prev.at) / 1000;
        const regression = projected - reported;
        if (regression > 0 && regression < SEEK_EPSILON_SEC) return prev;
      }
      return { at, pos: reported };
    });
    setNowMs(at);
  }, [reported, playing]);

  // 500 ms is a 2x oversample of the 1 s unit `fmt` prints, so a second never
  // renders a whole unit late. No timer at all unless the device is playing.
  useEffect(() => {
    if (!playing) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [playing]);

  if (anchor == null) return null;
  if (!playing) return anchor.pos;
  const projected = anchor.pos + Math.max(0, nowMs - anchor.at) / 1000;
  // Never run past the end: if the device stops answering near EOF, a free-
  // running clock would otherwise count on forever.
  return duration && duration > 0 ? Math.min(projected, duration) : projected;
}

export default function CastSessionBar({
  deviceName, status, onTogglePlayPause, onSeekBy, onStop, isFullscreen,
}: CastSessionBarProps) {
  const playing = status?.player_state === "playing";
  const buffering = status?.player_state === "buffering";
  const positionSec = useInterpolatedPosition(status);
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[10000] aura-glass-bar rounded-2xl
                 shadow-glass-edge px-4 py-2.5 flex items-center gap-3"
      style={{ bottom: isFullscreen ? 24 : 56 }}
      role="status"
    >
      <CastGlyph />
      <div className="min-w-0">
        <p className="text-white/90 text-[13px] font-medium leading-tight max-w-[240px] flex items-center gap-1.5">
          <span className="truncate">Casting to {deviceName}</span>
          {status?.transcoding && (
            <span
              title="This file is being converted on the fly so the device can play it"
              className="flex-shrink-0 px-1.5 py-px rounded-full bg-amber-400/15 text-amber-300/90
                         text-[9px] font-semibold uppercase tracking-wider leading-none"
            >
              Transcoding
            </span>
          )}
        </p>
        <p className="text-white/45 text-[11px] tabular-nums leading-tight">
          {buffering
            ? "buffering…"
            : status && positionSec != null
              ? `${fmt(positionSec)}${status.duration_sec ? ` / ${fmt(status.duration_sec)}` : ""}`
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
