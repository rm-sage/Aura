// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// EosSpotlight — the End-Of-Stream "Next-Up Spotlight" (design spec
// 2026-05-19, Decisions 1-2 & 6). A full-screen dark-scrim overlay shown
// the instant playback reaches a clean end (mpv `playback-end`
// reason="eof" OR a near-end stale-heartbeat ≤5 s from duration — see
// App.tsx). It REPLACES the false "Stream connection lost" modal at true
// end-of-stream and gives the user one focused decision.
//
// Two states:
//   • NEXT-UP   — a next aired episode exists. Big thumbnail (series-art
//                 fallback per Decision 6), SxxEyy tag, title, spoiler-
//                 gated synopsis, primary "Play Next" (with the
//                 NextUpCta-style countdown ring iff autoAdvance is on),
//                 Replay, Exit, "Episodes" (opens the shared drawer).
//   • END-CARD  — no next episode (movie finished / series finale / last
//                 aired with a later season unaired). "You've finished
//                 {title}", optional season note, Replay / Episodes
//                 (series only) / Exit. No countdown.
//
// Z-INDEX: z-[10300] — above PlayerOverlay (9999) and the small NextUpCta
// (10001), below the stream-broken recovery modal (10500) so a genuine
// break still wins if both ever race. MPV is a separate child window, so
// the dark scrim alone hides the last frame; we do NOT CSS-blur video.
//
// This component is presentational + self-contained timing. All playback
// side-effects (resolve next, play, reload, exit) are injected by App so
// the History/scrobble fixes on those paths are reused unchanged.
// ---------------------------------------------------------------------------

import { memo, useEffect, useRef, useState } from "react";
import { useWindowHidden } from "./windowVisibility";
import ImageLoader from "./ImageLoader";
import FillerRecapTags from "./FillerRecapTags";
import type { LibraryItem, StreamEntry, VideoEntry } from "./types";
import { formatEpisodeTag, episodeKindFlags } from "./nextUp";
import { loadAuraSettings } from "./auraSettings";
import { isEpisodeWatched, shouldBlurSynopsis } from "./episodeSpoilers";
import { formatCountdown, useCountdownNow } from "./releaseCountdown";
import { getWatchState } from "./watchTogether/store";

interface Props {
  /** Series / movie display name for the END-CARD heading. */
  title: string;
  /** Next aired episode, or null → END-CARD state. */
  episode: VideoEntry | null;
  /** Pre-resolved first stream for `episode`. null + !loading ⇒ the
   *  "no source" hint (Replay / Exit / Episodes still work). */
  stream: StreamEntry | null;
  /** True while App is still resolving the next episode / its stream.
   *  Renders the card skeleton-ish with a disabled, spinner primary. */
  loading: boolean;
  /** True for series/anime (drives "Episodes" button + finale copy). */
  isSeries: boolean;
  /** True when there IS no next AIRED episode but a later season is
   *  known/likely unaired ("Caught up" wording vs plain "finale"). */
  caughtUpUnaired: boolean;
  /** Air timestamp (ms) of the next-to-air episode when caught up but the
   *  season is still going — drives the END-CARD live countdown. null when
   *  no upcoming date is known (true finale, or next ep unscheduled). */
  nextAirTargetMs: number | null;
  /** Series landscape/portrait art — the Decision-6 fallback shown
   *  instead of a big blurred still for an unwatched next episode. */
  seriesArt: string | null;
  /** id→LibraryItem index (App builds from `library`) for the pure
   *  spoiler gate — identical rule to DetailView. */
  libraryById: Map<string, LibraryItem>;
  /** Advance to the next episode. `auto` = true when fired by the auto-advance
   *  countdown (counts toward the still-watching gate); false on a manual click
   *  (resets the gate's streak). */
  onPlayNext: (auto: boolean) => void;
  /** When the next episode is filler/recap and a canon target was pre-resolved
   *  (with a stream), its SxxEyy tag — presence flips the primary action to
   *  "Skip to canon · SxxEyy". null otherwise. */
  skipTag?: string | null;
  /** Skip past all upcoming filler/recap into the next canon episode. `auto`
   *  mirrors onPlayNext (counts toward the still-watching gate). Wired by App
   *  only when `skipTag` is set. */
  onSkipToCanon?: (auto: boolean) => void;
  /** Consecutive unattended auto-advances so far (App-tracked). At >=2, with the
   *  stillWatchingGate setting on, the auto-advance countdown is suppressed and a
   *  "Still watching?" confirm is shown instead, stopping an all-night chain. */
  autoAdvanceStreak: number;
  onReplay: () => void;
  onExit: () => void;
  onOpenEpisodes: () => void;
  /** Hide the Spotlight WITHOUT tearing playback down (distinct from
   *  onExit, which is the full handleExitPlayback teardown). mpv is
   *  idle/ended at EOF and the DXGI flip model retains the last frame,
   *  so the user is left looking at the paused final frame. Wired to
   *  the × button and Escape. */
  onDismiss: () => void;
  /** Set only when the episode just finished was the LAST of its story arc.
   *  Renders an arc-boundary line on the next-up state. Informational: it does
   *  not gate or delay auto-advance. `next` is null on the final arc. */
  arcNote?: { ending: string; next: string | null } | null;
  /** True when the EpisodePanel drawer (opened via Spotlight's
   *  "Episodes" button) is on top of the Spotlight. Esc cascade
   *  contract: panel closes FIRST (its own listener), then Spotlight
   *  dismisses, then App's playback-exit. Without this gate, BOTH the
   *  panel's Esc and Spotlight's Esc fire on the same keystroke and
   *  the user loses the Spotlight after dismissing the panel — Esc
   *  becomes "close both at once" instead of "close one layer at a
   *  time". When the panel is open we return EARLY without calling
   *  onDismiss, letting the panel's own keydown listener handle it
   *  (panel sits at z-10400, Spotlight at z-10300). */
  episodesOpen: boolean;
}

// Live "next episode airs in …" line for the caught-up END-CARD. Owns its
// OWN 1 s tick so only this line re-renders each second (the card is
// otherwise static). Mirrors DetailView's CountdownStat / EpisodeAirChip.
function NextAirCountdown({ targetMs }: { targetMs: number }) {
  const now = useCountdownNow();
  return (
    <p className="flex items-center justify-center gap-2 text-ln-accent text-[14px] leading-relaxed mb-6">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" className="text-ln-accent" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        Next episode airs in{" "}
        <span className="font-semibold tabular-nums">
          {formatCountdown(targetMs, now)}
        </span>
      </span>
    </p>
  );
}

function EosSpotlight({
  title, episode, stream, loading, isSeries, caughtUpUnaired, nextAirTargetMs,
  seriesArt, libraryById, onPlayNext, skipTag, onSkipToCanon, autoAdvanceStreak,
  onReplay, onExit, onOpenEpisodes, onDismiss, episodesOpen, arcNote,
}: Props) {
  const isNextUp = episode != null;
  const { filler, recap } = episode
    ? episodeKindFlags(episode)
    : { filler: false, recap: false };
  // Skip mode: the next episode is filler/recap and a canon target (with a
  // stream) was pre-resolved. The skip becomes the primary action.
  const skipMode = isNextUp && !!(skipTag && onSkipToCanon);

  // ── Countdown (NEXT-UP only) — mirrors NextUpCta's pattern exactly:
  // read autoAdvance settings once at mount, clamp delay to [5,30], arm
  // only when a playable stream is resolved (loading false + stream
  // present), latch-cancel on ANY pointer/key/wheel so a user reaching
  // for the remote never gets surprise-advanced.
  const settings = loadAuraSettings();
  const initialSeconds = Math.max(5, Math.min(30, Math.round(settings.autoAdvanceDelaySeconds)));
  // Never auto-advance an in-sync party FOLLOWER: independently advancing to the
  // next episode would change our local videoKey, drop us off the party title
  // (recomputeSync -> inSync=false), and leave us watching ahead of the party
  // alone with no recovery. A follower's episode changes ONLY when the leader's
  // control frame moves the room (openVideo / resyncToRoom). The leader (and
  // solo viewers) auto-advance as normal.
  const party = getWatchState();
  const isPartyFollower =
    party.status === "connected" && !party.isLeader && party.inSync;
  // Still-watching binge gate: after 2 consecutive UNATTENDED auto-advances,
  // suppress the auto-countdown and show a "Still watching?" confirm instead, so
  // an all-night chain stops. The streak is App-tracked (reset on manual
  // continue / exit). Opt-out via the stillWatchingGate setting (default on).
  const gatedByStillWatching =
    settings.stillWatchingGate !== false && isNextUp && autoAdvanceStreak >= 2;
  // In skip mode the canon stream is always pre-resolved, so don't gate the
  // countdown on the (filler) `stream`; otherwise the literal-next stream is
  // required for "Play Next".
  const autoArmed =
    isNextUp && settings.autoAdvanceNextEpisode && !loading && (skipMode || stream != null)
    && !isPartyFollower && !gatedByStillWatching;

  const [remaining, setRemaining] = useState<number | null>(autoArmed ? initialSeconds : null);
  const cancelledRef = useRef(false);
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
      (skipMode ? onSkipToCanon! : onPlayNext)(true);
      return;
    }
    const id = window.setTimeout(() => setRemaining((s) => (s === null ? null : s - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [autoArmed, remaining, initialSeconds, onPlayNext, onSkipToCanon, skipMode, windowHidden]);

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

  // Escape dismisses the Spotlight (stay paused on the last frame).
  // Independent of the countdown-cancel listener above: that one only
  // exists while a countdown is armed and merely cancels auto-advance;
  // this one always exists and actually hides the screen. stopPropagation
  // so the keypress doesn't also reach PlayerOverlay's own Esc handler.
  //
  // Esc cascade (2026-05-20): when EpisodePanel is OPEN on top of the
  // Spotlight, RETURN EARLY so the panel's own keydown listener owns
  // this keystroke. Without this gate both listeners fire in parallel
  // (window-level keydown is delivered to every registered listener),
  // so a single Esc closed BOTH the panel and the Spotlight at once.
  // With the gate the cascade is: Esc → panel closes → episodesOpen
  // flips false → next Esc dismisses Spotlight → next Esc exits
  // playback (App's window-level Esc handler, which already gates on
  // both eosEpisodesOpen and eosActive being false).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (episodesOpen) return;
      e.stopPropagation();
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, episodesOpen]);

  const countdownActive = remaining !== null && remaining > 0;
  const ringPct = countdownActive
    ? Math.max(0, Math.min(100, ((initialSeconds - remaining) / initialSeconds) * 100))
    : 0;

  // Thumbnail source: real episode still when available, falling back
  // to the series art on misses. The previous behaviour swapped to
  // series art whenever blurUnwatchedThumbnails was on for an unwatched
  // episode; that path is removed — blur the still in place instead.
  const epId = episode?.id ?? "";
  const epWatched = isNextUp ? isEpisodeWatched(libraryById, epId) : false;
  const blurThumb =
    isNextUp && settings.blurUnwatchedThumbnails && !epWatched;
  const thumbSrc = isNextUp
    ? (episode!.thumbnail || seriesArt)
    : seriesArt;

  const [revealed, setRevealed] = useState(false);
  // Re-lock the reveal whenever the episode identity changes (a fresh
  // EOS for a different episode shouldn't inherit the prior reveal).
  useEffect(() => { setRevealed(false); }, [epId]);
  const synopsis = (episode?.overview ?? "").trim();
  const synopsisBlurred =
    isNextUp &&
    !!synopsis &&
    shouldBlurSynopsis(libraryById, epId, settings.blurEpisodeSynopsis, revealed);

  const tag = isNextUp ? formatEpisodeTag(episode!) : "";
  const epTitle = (episode?.title ?? "").trim() || "Untitled episode";

  // Shared button class fragments.
  const btnBase =
    "px-5 py-2.5 rounded-xl text-[13px] font-semibold tracking-wide transition-colors flex items-center justify-center gap-2";
  const btnGhost =
    "text-white/85 bg-white/[0.06] border border-white/10 hover:bg-white/[0.10] hover:text-white";

  return (
    <div
      // z-[10300]: above PlayerOverlay (9999) + NextUpCta (10001), below
      // the recovery modal (10500). pointer-events-auto + click/pointer
      // stop so the dark scrim swallows stray taps (no pause toggle on
      // the dead controls beneath).
      className="fixed inset-0 z-[10300] flex items-center justify-center
                 bg-black/80 backdrop-blur-md
                 animate-[fade-in_160ms_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-label={isNextUp ? "Next episode" : "Playback finished"}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="relative aura-glass-menu rounded-3xl w-[92%] max-w-[760px] p-7 text-white
                      shadow-[0_40px_90px_-20px_rgba(0,0,0,0.85)]">
        {/* Dismiss — hides the Spotlight without tearing playback down.
            The reverted DXGI flip model retains the last decoded frame,
            so the user is left on the paused final frame. Distinct from
            Exit (full teardown). Also bound to Escape above. */}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close (stay paused)"
          className="absolute top-3 right-3 w-8 h-8 rounded-full
                     text-white/55 hover:text-white hover:bg-white/10
                     transition-colors flex items-center justify-center z-10"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
        {isNextUp ? (
          <>
            <p className="text-white/45 text-[11px] font-mono uppercase tracking-[0.22em] mb-4">
              Up next
            </p>
            <div className="flex gap-6 items-stretch">
              {/* ── Thumbnail (blur on unwatched when the setting is on) ── */}
              <div
                className="relative flex-shrink-0 w-[300px] max-w-[40vw] rounded-2xl
                           overflow-hidden bg-white/5 border border-white/10"
                style={{ aspectRatio: "16 / 9" }}
              >
                {thumbSrc ? (
                  <ImageLoader
                    src={thumbSrc}
                    alt=""
                    className="absolute inset-0 w-full h-full"
                    imgClassName="w-full h-full object-cover"
                    imgStyle={blurThumb ? { filter: "blur(16px) saturate(115%)", transform: "scale(1.08)" } : undefined}
                  />
                ) : (
                  <div className="absolute inset-0 flex items-center justify-center text-white/25">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </div>
                )}
                {/* Filler / recap tag — surfaces what's actually next even
                    when the primary action is "Skip to canon". */}
                <FillerRecapTags filler={filler} recap={recap} className="absolute top-2 right-2 z-10" />
              </div>

              {/* ── Body ── */}
              <div className="flex-1 min-w-0 flex flex-col">
                <span className="text-white/45 text-[11px] font-mono uppercase tracking-[0.18em]">
                  {title} · {tag}
                </span>
                <h2 className="text-white text-[22px] font-semibold leading-tight mt-1 line-clamp-2">
                  {epTitle}
                </h2>

                {/* Arc boundary. The episode you just finished ended a story
                    arc, so say which one, and which is next. Informational
                    only: the auto-advance countdown still runs. The next-arc
                    name gets its own line so it does not run on. */}
                {arcNote && (
                  <div className="text-ln-accent/85 text-[12.5px] leading-tight mt-1.5 space-y-0.5">
                    <p>{arcNote.ending} complete</p>
                    {arcNote.next
                      ? <p>Next arc: {arcNote.next}</p>
                      : <p>Final arc</p>}
                  </div>
                )}

                {synopsis && (
                  <div className="relative mt-3 max-w-[65ch]">
                    <p
                      className={[
                        "text-white/70 text-[13.5px] leading-relaxed line-clamp-4 transition-[filter] duration-200",
                        synopsisBlurred ? "select-none" : "selectable",
                      ].join(" ")}
                      style={{
                        filter: synopsisBlurred ? "blur(8px) saturate(120%)" : "none",
                        userSelect: synopsisBlurred ? "none" : "text",
                      }}
                    >
                      {synopsis}
                    </p>
                    {synopsisBlurred && (
                      <button
                        type="button"
                        onClick={() => setRevealed(true)}
                        aria-label="Reveal episode synopsis"
                        className="absolute inset-0 cursor-pointer group"
                      >
                        <span
                          aria-hidden
                          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
                                     opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap
                                     px-2.5 py-1 rounded-md bg-black/80 backdrop-blur-sm
                                     text-white/85 text-[11px] tracking-wide border border-white/10"
                        >
                          Click to reveal spoilers
                        </span>
                      </button>
                    )}
                  </div>
                )}

                <div className="flex-1" />

                {gatedByStillWatching && (skipMode || stream != null) && (
                  <p className="text-ln-accent text-[13px] font-semibold tracking-wide mb-1 flex items-center gap-2">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 8v4M12 16h.01" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Still watching? Auto-play paused after a few episodes.
                  </p>
                )}

                {/* ── Actions ── */}
                <div className="flex flex-wrap items-center gap-2.5 mt-5">
                  {skipMode ? (
                    <>
                      {/* Skip-to-canon primary (jumps past all upcoming
                          filler/recap) + "play this anyway" fallback. */}
                      <button
                        type="button"
                        onClick={() => onSkipToCanon!(false)}
                        className={`relative overflow-hidden ${btnBase}
                                    border border-ln-accent/45 bg-ln-accent/20 text-ln-accent
                                    hover:bg-ln-accent/30 min-w-[170px]`}
                      >
                        {countdownActive && (
                          <span
                            aria-hidden
                            className="absolute inset-y-0 left-0 bg-ln-accent/25 transition-[width] duration-1000 ease-linear"
                            style={{ width: `${ringPct}%` }}
                          />
                        )}
                        <span className="relative flex items-center gap-2">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" />
                          </svg>
                          {countdownActive
                            ? `Skipping to canon in ${remaining}s — move to cancel`
                            : `Skip to canon · ${skipTag}`}
                        </span>
                      </button>
                      {stream != null && (
                        <button type="button" onClick={() => onPlayNext(false)} className={`${btnBase} ${btnGhost}`}>
                          Play this anyway
                        </button>
                      )}
                    </>
                  ) : stream == null && !loading ? (
                    <p className="text-amber-300/90 text-[12.5px] leading-snug flex-1 min-w-[200px]">
                      No streams found for this episode. Open the episode
                      list to pick a source.
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => onPlayNext(false)}
                      className={`relative overflow-hidden ${btnBase}
                                  border border-ln-accent/45 bg-ln-accent/20 text-ln-accent
                                  hover:bg-ln-accent/30 disabled:opacity-55 disabled:cursor-progress
                                  min-w-[170px]`}
                    >
                      {countdownActive && (
                        <span
                          aria-hidden
                          className="absolute inset-y-0 left-0 bg-ln-accent/25 transition-[width] duration-1000 ease-linear"
                          style={{ width: `${ringPct}%` }}
                        />
                      )}
                      {loading ? (
                        <span className="relative flex items-center gap-2">
                          <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="32 16" />
                          </svg>
                          Resolving stream…
                        </span>
                      ) : countdownActive ? (
                        <span className="relative flex items-center gap-2">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M8 5v14l11-7z" />
                          </svg>
                          Play next in {remaining}s — move to cancel
                        </span>
                      ) : (
                        <span className="relative flex items-center gap-2">
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                            <path d="M8 5v14l11-7z" />
                          </svg>
                          {gatedByStillWatching ? "Continue watching" : "Play Next"}
                        </span>
                      )}
                    </button>
                  )}
                  <button type="button" onClick={onReplay} className={`${btnBase} ${btnGhost}`}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                    </svg>
                    Replay
                  </button>
                  {isSeries && (
                    <button type="button" onClick={onOpenEpisodes} className={`${btnBase} ${btnGhost}`}>
                      Episodes
                    </button>
                  )}
                  <button type="button" onClick={onExit} className={`${btnBase} ${btnGhost}`}>
                    Exit
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : (
          // ── END-CARD ──
          <div className="flex flex-col items-center text-center py-4">
            {thumbSrc && (
              <div
                className="relative w-[200px] rounded-2xl overflow-hidden mb-5
                           bg-white/5 border border-white/10"
                style={{ aspectRatio: "2 / 3" }}
              >
                <ImageLoader
                  src={thumbSrc}
                  alt=""
                  className="absolute inset-0 w-full h-full"
                  imgClassName="w-full h-full object-cover"
                />
              </div>
            )}
            <p className="text-white/45 text-[11px] font-mono uppercase tracking-[0.22em] mb-2">
              {caughtUpUnaired ? "Caught up" : isSeries ? "Series finale" : "Finished"}
            </p>
            <h2 className="text-white text-[24px] font-semibold leading-tight mb-2 max-w-[34ch]">
              {caughtUpUnaired ? `You’ve caught up on ${title}!` : `You’ve finished ${title}`}
            </h2>
            {caughtUpUnaired ? (
              nextAirTargetMs != null ? (
                <NextAirCountdown targetMs={nextAirTargetMs} />
              ) : (
                <p className="text-white/60 text-[13.5px] leading-relaxed mb-6 max-w-[42ch]">
                  You’re all caught up — the next episode hasn’t been scheduled yet.
                </p>
              )
            ) : (
              <p className="text-white/60 text-[13.5px] leading-relaxed mb-6 max-w-[42ch]">
                {isSeries
                  ? "That’s the last available episode. Nicely done."
                  : "Thanks for watching."}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={onReplay}
                className={`${btnBase} border border-ln-accent/45 bg-ln-accent/20 text-ln-accent hover:bg-ln-accent/30`}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
                </svg>
                Replay
              </button>
              {isSeries && (
                <button type="button" onClick={onOpenEpisodes} className={`${btnBase} ${btnGhost}`}>
                  Episodes
                </button>
              )}
              <button type="button" onClick={onExit} className={`${btnBase} ${btnGhost}`}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(EosSpotlight);
