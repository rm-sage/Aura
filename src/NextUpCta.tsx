// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// NextUpCta — floating "Next Up" card rendered over the player's bottom-
// right corner. Appears in the final stretch of an episode (configurable
// lead time, or right after an anime ED chapter ends, whichever comes
// first) and offers a one-click jump to the next episode's first
// available stream.
//
// Design notes:
//   • Card geometry mirrors a Continue Watching tile: thumbnail on the
//     left, episode tag + title stacked on the right, single primary
//     CTA. Familiar shape for the user, no new visual vocabulary.
//   • Z-index sits ABOVE PlayerOverlay's auto-hide control bar so the
//     CTA stays put even when the controls fade. Pointer events route
//     through it so the user can dismiss / play without unhiding the
//     bar.
//   • DOES NOT auto-advance — explicit user click required. Some users
//     legitimately want to sit on the credits / preview, and a silent
//     auto-jump after N seconds is the kind of behaviour that earns
//     bug reports rather than thanks. Auto-advance can come later as
//     an opt-in setting if there's demand.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import ImageLoader from "./ImageLoader";
import type { VideoEntry } from "./types";
import { formatEpisodeTag } from "./nextUp";
import { loadAuraSettings } from "./auraSettings";

interface Props {
  /** The next episode metadata. Provides the title + thumbnail. */
  episode: VideoEntry;
  /** True while the next episode's stream resolution is in flight.
   *  The CTA still renders so the user can see the "Next Up: SxxEyy"
   *  preview, but the play button is disabled with a small spinner
   *  until a stream lands. */
  loading: boolean;
  /** When true, no playable stream resolved for the next episode (every
   *  addon either errored or returned an empty array). The CTA renders
   *  with a disabled-with-helper-text state instead of a play button. */
  noStream: boolean;
  /** Click handler — App.tsx wires this to `handlePlayStream(stream,
   *  target)` after the current playback's resume offset is flushed. */
  onPlay: () => void;
  /** Hide the CTA for the rest of the current playback session. The
   *  parent owns the dismiss state — this component just emits the
   *  intent. */
  onDismiss: () => void;
}

export default function NextUpCta({
  episode, loading, noStream, onPlay, onDismiss,
}: Props) {
  const tag = formatEpisodeTag(episode);
  const title = (episode.title ?? "").trim() || "Untitled episode";

  // ── Opt-in auto-advance ─────────────────────────────────────────────
  // When the user has flipped `autoAdvanceNextEpisode` ON in Settings,
  // arm a countdown the moment the CTA mounts with a resolved playable
  // stream (loading === false AND noStream === false). The countdown
  // shows as a thin progress bar across the bottom of the card and the
  // primary CTA button gains a "Playing in Ns…" label. Any cancel
  // signal (mouse move in the viewport, key press, mouseenter on the
  // card itself) clears the timer and the CTA reverts to its standard
  // "Play next episode" state — the user can still click manually.
  //
  // Settings are read once at mount via the existing loadAuraSettings
  // memoized snapshot; we deliberately don't subscribe to mid-session
  // setting changes because the active countdown is tied to the
  // moment-of-truth surfacing of the CTA, and reacting to a setting
  // flip mid-countdown would either restart or abort in surprising
  // ways. The user opts in at the level of "the next time NextUp
  // surfaces, use auto-advance." Next surface honours the new value.
  const settings = loadAuraSettings();
  const initialSeconds = Math.max(5, Math.min(30, Math.round(settings.autoAdvanceDelaySeconds)));
  const autoArmed = settings.autoAdvanceNextEpisode && !loading && !noStream;

  const [remaining, setRemaining] = useState<number | null>(autoArmed ? initialSeconds : null);
  // `cancelled` latches once the user has expressed any cancel intent
  // so we don't restart the countdown if `autoArmed` flickers true again
  // (e.g. a `loading=true → false` cycle while the user was actively
  // moving the mouse). One cancel = no auto for this CTA instance.
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!autoArmed) return;
    if (cancelledRef.current) return;
    if (remaining === null) {
      setRemaining(initialSeconds);
      return;
    }
    if (remaining <= 0) {
      onPlay();
      return;
    }
    const id = window.setTimeout(() => setRemaining((s) => (s === null ? null : s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [autoArmed, remaining, initialSeconds, onPlay]);

  // Cancel signals: any pointer move on the document, any keydown,
  // hover into the CTA card itself (the user is reading / about to
  // act), or the explicit dismiss button. Arrow / Escape / Tab all
  // count — the user touched the keyboard. We listen at the window
  // scope while the countdown is armed and detach when it isn't.
  useEffect(() => {
    if (remaining === null) return;
    const cancel = () => {
      cancelledRef.current = true;
      setRemaining(null);
    };
    window.addEventListener("pointermove", cancel, { passive: true });
    window.addEventListener("keydown", cancel);
    window.addEventListener("wheel", cancel, { passive: true });
    return () => {
      window.removeEventListener("pointermove", cancel);
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("wheel", cancel);
    };
  }, [remaining]);

  const countdownActive = remaining !== null && remaining > 0;
  const fillPct = countdownActive
    ? Math.max(0, Math.min(100, ((initialSeconds - remaining) / initialSeconds) * 100))
    : 0;

  return (
    <div
      // Z-INDEX 10001 (above PlayerOverlay's 9999) so the CTA paints
      // and receives clicks ahead of the overlay's invisible
      // "tap to play/pause" layer. `fixed` positioning anchors to the
      // viewport directly — the CTA is rendered as a sibling of the
      // overlay at App's root, NOT a child, so `absolute` would resolve
      // against the document body and produce the same coordinates,
      // but `fixed` is the explicit semantic: "stick to the viewport
      // corner regardless of any ancestor's transform / overflow."
      //
      // pointer-events-auto + `onClick stopPropagation` on the wrapper
      // is belt-and-braces against any ancestor click handler that
      // might still be installed when this mounts.
      className="fixed bottom-28 right-6 z-[10001] pointer-events-auto
                 bg-black/80 backdrop-blur-2xl border border-white/15
                 rounded-2xl shadow-[0_24px_64px_rgba(0,0,0,0.65)]
                 p-3 flex items-stretch gap-3 max-w-[420px] w-[420px]
                 animate-[next-up-rise_220ms_ease-out]"
      role="dialog"
      aria-label="Next episode available"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* ── Thumbnail ── */}
      <div
        className="relative flex-shrink-0 w-[140px] rounded-lg overflow-hidden bg-white/5 border border-white/8"
        style={{ aspectRatio: "16 / 9" }}
      >
        {episode.thumbnail ? (
          <ImageLoader
            src={episode.thumbnail}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/25">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 min-w-0 flex flex-col justify-between gap-1.5">
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-white/45 text-[10.5px] font-mono uppercase tracking-[0.18em]">
              Next up · {tag}
            </span>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss next-up suggestion"
              className="w-5 h-5 rounded-full text-white/45 hover:text-white/85
                         hover:bg-white/10 transition-colors flex items-center justify-center"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
          <p className="text-white/95 text-sm font-medium leading-tight mt-0.5 line-clamp-2">
            {title}
          </p>
        </div>

        {noStream ? (
          <p className="text-amber-300/90 text-[11px] leading-snug">
            No streams found for this episode. Try opening it from the
            episode list.
          </p>
        ) : (
          <button
            type="button"
            disabled={loading}
            onClick={onPlay}
            className="relative w-full px-3 py-1.5 rounded-lg overflow-hidden
                       border border-ln-accent/45 bg-ln-accent/20
                       text-ln-accent text-[12px] font-semibold tracking-wide
                       hover:bg-ln-accent/30 transition-colors
                       disabled:opacity-55 disabled:cursor-progress
                       flex items-center justify-center gap-2"
          >
            {/* Auto-advance countdown fill — paints behind the button
                label as a thin growing bar so the user sees the timer
                at a glance without cluttering the layout. Linear 1s
                steps, no easing, so it reads as a real clock. */}
            {countdownActive && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-ln-accent/25 transition-[width] duration-1000 ease-linear"
                style={{ width: `${fillPct}%` }}
              />
            )}
            {loading ? (
              <>
                <svg
                  className="animate-spin"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="32 16" />
                </svg>
                Resolving stream…
              </>
            ) : countdownActive ? (
              <span className="relative flex items-center gap-2">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8 5v14l11-7z" />
                </svg>
                Playing next in {remaining}s — move to cancel
              </span>
            ) : (
              <>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play next episode
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
