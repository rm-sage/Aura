// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// NextUpCta — floating "Next Up" card rendered over the player's bottom-
// right corner. Appears in the final stretch of an episode (configurable
// lead time, or the moment the ending BEGINS when Aura knows where that is,
// whichever comes first) and offers a one-click jump to the next episode's
// first available stream.
//
// The ED trigger is the ED window's START, not its end: the card is meant to
// appear as the credits roll, which is the same instant the "Skip ending?
// Press X" prompt does. Waiting for the ED to END would put it in the last few
// seconds of the file, by which point the plain lead time has already fired.
//
// Design notes:
//   • Card geometry mirrors a Continue Watching tile: thumbnail on the
//     left, episode tag + title stacked on the right, single primary
//     CTA. Familiar shape for the user, no new visual vocabulary.
//   • FILLER / RECAP: when the next episode is filler/recap AND a later
//     canon episode exists, its rose/amber tag shows on the thumbnail and
//     the PRIMARY action becomes "Skip to canon · SxxEyy" (jumps past all
//     upcoming filler/recap); a small "Play this anyway" link plays the
//     filler. Auto-advance then targets the skip, matching the primary.
//   • Z-index sits ABOVE PlayerOverlay's auto-hide control bar so the
//     CTA stays put even when the controls fade. Pointer events route
//     through it so the user can dismiss / play without unhiding the
//     bar.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { useWindowHidden } from "./windowVisibility";
import ImageLoader from "./ImageLoader";
import { shrinkPoster } from "./posterSize";
import FillerRecapTags from "./FillerRecapTags";
import type { LibraryItem, VideoEntry } from "./types";
import { formatEpisodeTag, episodeKindFlags, episodeKindNoun } from "./nextUp";
import { loadAuraSettings } from "./auraSettings";
import { shouldBlurThumbnail } from "./episodeSpoilers";
import { getWatchState } from "./watchTogether/store";

interface Props {
  /** The next episode metadata. Provides the title + thumbnail + tag. */
  episode: VideoEntry;
  /** Library index, used only to resolve whether the next episode has been
   *  watched, which is half of the anti-spoiler blur gate. Same map the EOS
   *  Spotlight takes, so both surfaces answer identically. */
  libraryById: Map<string, LibraryItem>;
  /** True while the next episode's stream resolution is in flight. */
  loading: boolean;
  /** True when no playable stream resolved for the (literal) next episode. */
  noStream: boolean;
  /** When the next episode is filler/recap and a later canon episode was
   *  pre-resolved (with a stream), its SxxEyy tag — presence flips the card
   *  into "skip to canon primary" mode. null otherwise. */
  skipTag?: string | null;
  /** Skip past all upcoming filler/recap into the next canon episode. Wired
   *  by App only when `skipTag` is set. `auto` is true when the countdown
   *  fired it unattended, false on a click. Mirrors EosSpotlight's contract. */
  onSkipToCanon?: (auto: boolean) => void;
  /** The canon episode a skip would land on. Drives the hover preview, so the
   *  user can see WHAT they are skipping to before committing. */
  canonEpisode?: VideoEntry | null;
  /** How many episodes a skip would jump. Turns the tooltip from a vague
   *  promise into a countable one. */
  skipCount?: number;
  /** Should an UNATTENDED countdown press Skip rather than Play next? This is
   *  the entirety of what the filler / recap preference now decides. Both
   *  buttons are always offered either way. */
  autoSkipsToCanon?: boolean;
  /** Play the (literal) next episode. In skip mode this is the "Play this
   *  anyway" fallback; otherwise the primary action. `auto` as above. */
  onPlay: (auto: boolean) => void;
  /** Consecutive unattended auto-advances so far. At 2 or more (with the
   *  stillWatchingGate setting on) the countdown stands down and the user has
   *  to click, which is what stops an all-night chain. This card needs the
   *  same gate EosSpotlight has, because this is the surface that actually
   *  fires during a binge: it appears a lead-time BEFORE the end of the file,
   *  so the end-of-stream Spotlight never gets a turn. */
  autoAdvanceStreak: number;
  /** Hide the CTA for the rest of the current playback session. */
  onDismiss: () => void;
  /** True when the user has EXPLICITLY refused an auto-advance for this episode
   *  (they dismissed this card). Owned by App so the refusal survives this card
   *  being replaced by the end-of-stream Spotlight, which would otherwise arm a
   *  fresh countdown and advance anyway. Ambient activity - a mouse move, a
   *  keypress - only cancels the countdown LOCALLY: it is attention, not a
   *  decision, and the end card is a new decision point. */
  autoAdvanceCancelled: boolean;
  /** Set only when the episode just finished was the LAST of its story arc, so
   *  playing the next one crosses an arc boundary. Purely informational: the
   *  countdown still rolls into the next arc. `next` is null on the final arc. */
  arcNote?: { ending: string; next: string | null } | null;
}

export default function NextUpCta({
  episode, libraryById, loading, noStream, skipTag, onSkipToCanon, canonEpisode,
  skipCount, autoSkipsToCanon, onPlay, onDismiss, arcNote,
  autoAdvanceStreak, autoAdvanceCancelled,
}: Props) {
  // Hover preview state: which episode's identity the card is showing.
  const [previewCanon, setPreviewCanon] = useState(false);
  // Anti-spoiler blur. This card shows the NEXT episode's still, which is
  // exactly the thing "Blur unwatched episode thumbnails" exists to hide, but
  // it was the one next-up surface that never applied the gate: the Detail
  // list, the in-player episode drawer and the EOS Spotlight all did, so the
  // setting looked like it was being ignored. Routed through the shared
  // episodeSpoilers predicate so all four stay in lock-step.
  // A skip is OFFERED whenever the next episode is filler or recap and a canon
  // target with a stream was pre-resolved. Offering it is independent of the
  // preference: the button is always there so any single episode can be
  // overridden either way.
  const canSkip = !!(skipTag && onSkipToCanon);
  // Which button an unattended countdown presses. Previously this was `canSkip`
  // itself, so merely HAVING a canon target meant the countdown skipped, and
  // the user had no say per episode.
  const skipMode = canSkip && autoSkipsToCanon === true;
  // Kind of the LITERAL next episode, for the fallback button's label. Read off
  // `episode` and never off `shown`, so hovering Skip (which swaps the body to
  // the canon episode) cannot relabel a button that still plays the filler.
  const playKindNoun = episodeKindNoun(episode);

  // The identity shown in the body. Hovering Skip fades in the canon episode
  // so the two are directly comparable before committing.
  const shown = previewCanon && canonEpisode ? canonEpisode : episode;
  const shownTag = formatEpisodeTag(shown);
  const shownTitle = (shown.title ?? "").trim() || "Untitled episode";
  const shownKinds = episodeKindFlags(shown);
  const shownBlur = shouldBlurThumbnail(
    libraryById, shown.id, loadAuraSettings().blurUnwatchedThumbnails === true,
  );

  // ── Opt-in auto-advance ─────────────────────────────────────────────
  // When the user has flipped `autoAdvanceNextEpisode` ON in Settings,
  // arm a countdown the moment the CTA mounts with a resolved playable
  // primary action. In skip mode the countdown targets the skip (the canon
  // stream is always resolved), so we don't gate it on the filler's
  // `noStream`; otherwise it needs the literal next stream. Any cancel
  // signal (mouse move, key, wheel, hover) clears the timer.
  const settings = loadAuraSettings();
  const initialSeconds = Math.max(5, Math.min(30, Math.round(settings.autoAdvanceDelaySeconds)));
  // Still-watching binge gate, mirroring EosSpotlight: after 2 consecutive
  // unattended auto-advances the countdown stands down and the user has to
  // click through. Opt out via the stillWatchingGate setting (default on).
  const gatedByStillWatching =
    settings.stillWatchingGate !== false && autoAdvanceStreak >= 2;
  // Never auto-advance an in-sync party FOLLOWER. Same rule (and the same
  // reasoning) as EosSpotlight: advancing independently changes our local
  // videoKey, drops us off the party title, and leaves us watching ahead of the
  // room alone with no way back. This card is the surface that actually fires
  // during a binge - it appears a lead time BEFORE the end of the file, so the
  // Spotlight, which HAD the guard, never gets a turn.
  const party = getWatchState();
  const isPartyFollower =
    party.status === "connected" && !party.isLeader && party.inSync;
  const autoArmed =
    settings.autoAdvanceNextEpisode && !loading && (skipMode || !noStream)
    && !isPartyFollower && !gatedByStillWatching;

  const [remaining, setRemaining] = useState<number | null>(
    autoArmed && !autoAdvanceCancelled ? initialSeconds : null,
  );
  // `cancelled` latches once the user has expressed any cancel intent
  // so we don't restart the countdown if `autoArmed` flickers true again.
  // Seeded from App so a refusal made on an earlier surface still holds.
  const cancelledRef = useRef(autoAdvanceCancelled);
  const windowHidden = useWindowHidden();

  useEffect(() => {
    if (!autoArmed) return;
    if (cancelledRef.current) return;
    // Freeze the auto-play countdown while the window is hidden so there is no
    // surprise auto-advance while the user is in another app; resumes on show.
    if (windowHidden) return;
    if (remaining === null) {
      setRemaining(initialSeconds);
      return;
    }
    if (remaining <= 0) {
      // Fire whatever the primary button does: skip-to-canon in skip mode,
      // otherwise play the literal next episode.
      (skipMode ? onSkipToCanon! : onPlay)(true);
      return;
    }
    const id = window.setTimeout(() => setRemaining((s) => (s === null ? null : s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [autoArmed, remaining, initialSeconds, onPlay, onSkipToCanon, skipMode, windowHidden]);

  // Cancel signals: any pointer move on the document, any keydown, wheel, or
  // the explicit dismiss button. Local only - see `autoAdvanceCancelled`.
  //
  // Bound for the WHOLE lifetime, not just while a countdown is ticking. The
  // card mounts with the countdown disarmed while the next stream resolves, and
  // binding on `remaining !== null` meant every bit of activity during that
  // phase was discarded - the countdown then armed underneath a user who had
  // already been moving the mouse.
  //
  // CAPTURE phase, because SkipController's x / Shift+X handlers are themselves
  // window-capture listeners that call stopPropagation(). That stops the event
  // dead at the capture step, so a bubble-phase listener on window never runs
  // and pressing the skip key - unambiguous attention - could not cancel an
  // auto-advance. Same-node, same-phase listeners all still fire, so capture
  // sidesteps it without changing the skip handlers.
  useEffect(() => {
    const cancel = () => {
      if (cancelledRef.current) return;
      cancelledRef.current = true;
      setRemaining(null);
    };
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("pointermove", cancel, opts);
    window.addEventListener("keydown", cancel, { capture: true });
    window.addEventListener("wheel", cancel, opts);
    return () => {
      window.removeEventListener("pointermove", cancel, opts);
      window.removeEventListener("keydown", cancel, { capture: true });
      window.removeEventListener("wheel", cancel, opts);
    };
  }, []);

  const countdownActive = remaining !== null && remaining > 0;
  const fillPct = countdownActive
    ? Math.max(0, Math.min(100, ((initialSeconds - remaining) / initialSeconds) * 100))
    : 0;

  const PlayIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
  const SkipIcon = () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" />
    </svg>
  );

  return (
    <div
      // Z-INDEX 10001 (above PlayerOverlay's 9999) so the CTA paints
      // and receives clicks ahead of the overlay's invisible layer.
      // aura-float-glass rather than a hand-rolled bg + blur + border + shadow:
      // this is a floating surface over video and the app has one recipe for
      // those now, including the opaque fallback for the three zero-blur themes.
      className="aura-float-glass fixed bottom-28 right-6 z-[10001] pointer-events-auto
                 rounded-2xl p-3 flex items-stretch gap-3 w-[420px]
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
        {shown.thumbnail ? (
          <ImageLoader
            // Keyed on the id so a preview swap remounts the loader and the
            // fade actually plays instead of the browser reusing the decoded
            // image in place.
            key={shown.id}
            src={shrinkPoster(shown.thumbnail, 480)}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
            // Blur radius is scaled from the Spotlight's (16px over a 300px
            // still) to this card's 140px, so the smearing is equally strong
            // relative to the image rather than merely equal in pixels. The
            // slight scale-up hides the soft edge the blur leaves at the
            // container border.
            // The preview respects the spoiler blur for the CANON episode on
            // its own terms: skipping to an unwatched episode must not become
            // a way to peek at its still.
            imgStyle={shownBlur
              ? { filter: "blur(8px) saturate(115%)", transform: "scale(1.08)" }
              : undefined}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/25">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}
        {/* Filler / recap tag — top-right of the thumbnail (mirrors the
            episode list). Shows what's actually next even in skip mode. */}
        <FillerRecapTags filler={shownKinds.filler} recap={shownKinds.recap} className="absolute top-1.5 right-1.5 z-10" />
      </div>

      {/* ── Body ── */}
      <div className="flex-1 min-w-0 flex flex-col justify-between gap-1.5">
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className={`text-[10.5px] font-mono uppercase tracking-[0.18em] ${
              previewCanon && canonEpisode ? "text-purple-300/80" : "text-white/45"}`}>
              {previewCanon && canonEpisode ? "Skips to" : "Next up"} · {shownTag}
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
          <p
            key={shown.id}
            className="aura-canon-fade text-white/95 text-sm font-medium leading-tight mt-0.5 line-clamp-2"
          >
            {shownTitle}
          </p>
          {/* What the skip COSTS, shown in the card rather than over it. This
              is the one fact the removed tooltip carried that the button label
              does not: a skip marks everything it passes as watched, writes
              History rows and (on a click) scrobbles them. It appears while
              the user previews the skip, which is exactly when it matters, and
              takes the place the preview already reserved. */}
          {previewCanon && canonEpisode && skipCount != null && skipCount > 0 && (
            <p className="text-purple-300/75 text-[11px] leading-tight mt-1">
              Marks {skipCount} episode{skipCount === 1 ? "" : "s"} skipped
            </p>
          )}
          {/* Arc boundary. Additive to the SxxEyy tag above, not a replacement:
              the user still needs to know which episode is queued. The next-arc
              name sits on its own line so the two facts (arc ended / arc next)
              read as two lines rather than one long run-on. */}
          {arcNote && (
            <div className="text-ln-accent/85 text-[11px] leading-tight mt-1">
              <p className="line-clamp-1">{arcNote.ending} complete</p>
              {arcNote.next
                ? <p className="line-clamp-1">Next arc: {arcNote.next}</p>
                : <p>Final arc</p>}
            </div>
          )}
        </div>

        {noStream && !canSkip ? (
          <p className="text-amber-300/90 text-[11px] leading-snug">
            No streams found for this episode. Try opening it from the
            episode list.
          </p>
        ) : (
          // BOTH ACTIONS, ALWAYS, whenever a skip is available. The card used
          // to show one primary whose meaning flipped based on a setting, so
          // the user could neither see what would be skipped nor choose per
          // episode. Now Skip and Play sit side by side and the preference only
          // decides which one an unattended countdown presses.
          // NO TOOLTIPS on either button, and no native `title` either. This
          // card is pinned to the bottom-right corner over live video, and a
          // `pos="top"` tooltip on a 420px-wide button covered the thumbnail,
          // the episode tag and the title of the very episode the user was
          // deciding about. The buttons name their own target ("Skip to
          // S05E23", "Play filler anyway"), so the hover text was restating the
          // label on top of the facts that justify it. Same in EosSpotlight.
          //
          // Hovering Skip still previews the canon episode in the body above,
          // which is the part that was worth having.
          <div className="flex flex-col gap-1.5">
            {canSkip && (
              <button
                type="button"
                onClick={() => onSkipToCanon!(false)}
                onMouseEnter={() => setPreviewCanon(true)}
                onMouseLeave={() => setPreviewCanon(false)}
                onFocus={() => setPreviewCanon(true)}
                onBlur={() => setPreviewCanon(false)}
                className="relative w-full px-3 py-1.5 rounded-lg overflow-hidden
                           border border-purple-400/45 bg-purple-500/20
                           text-purple-200 text-[12px] font-semibold tracking-wide
                           hover:bg-purple-500/30 transition-colors
                           flex items-center justify-center gap-2"
              >
                {countdownActive && skipMode && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-purple-400/25 transition-[width] duration-1000 ease-linear"
                    style={{ width: `${fillPct}%` }}
                  />
                )}
                <span className="relative flex items-center gap-2">
                  <SkipIcon />
                  {countdownActive && skipMode
                    ? `Skipping in ${remaining}s, move to cancel`
                    : `Skip to ${skipTag}`}
                </span>
              </button>
            )}
            {!noStream && (
              <button
                type="button"
                disabled={loading}
                onClick={() => onPlay(false)}
                className={`relative w-full px-3 py-1.5 rounded-lg overflow-hidden
                           border text-[12px] font-semibold tracking-wide
                           transition-colors flex items-center justify-center gap-2
                           disabled:opacity-55 disabled:cursor-progress ${
                  canSkip
                    // Secondary when a skip is on offer: two equally loud
                    // buttons would make the choice harder, not easier.
                    ? "border-white/15 bg-white/8 text-white/80 hover:bg-white/12 hover:text-white"
                    : "border-ln-accent/45 bg-ln-accent/20 text-ln-accent hover:bg-ln-accent/30"
                }`}
              >
                {countdownActive && !skipMode && (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 bg-ln-accent/25 transition-[width] duration-1000 ease-linear"
                    style={{ width: `${fillPct}%` }}
                  />
                )}
                {loading ? (
                  <>
                    <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="32 16" />
                    </svg>
                    Resolving stream...
                  </>
                ) : countdownActive && !skipMode ? (
                  <span className="relative flex items-center gap-2">
                    <PlayIcon />
                    Playing next in {remaining}s, move to cancel
                  </span>
                ) : (
                  <>
                    <PlayIcon />
                    {/* Names the kind of the episode this button would actually
                        play - the LITERAL next one - not the run as a whole. A
                        skip can pass several episodes of mixed kinds, but this
                        button only ever plays the first of them. */}
                    {canSkip ? `Play ${playKindNoun ?? "it"} anyway` : "Play next episode"}
                  </>
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
