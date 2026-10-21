// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// NextUpCta - floating "Next Up" card rendered at the player's top left,
// under the skip prompt (playerStack.ts), so what the credits ask of the user
// sits in one place. Appears in the final stretch of an episode and offers a
// one-click jump to the next episode's first available stream. WHEN it appears
// is decided by `nextUpGate.ts` (as a credible ending STARTS, else the lead
// time before the media end or the end of a trusted ending).
//
// NO COUNTDOWN. This card never advances on its own: an unattended advance
// happens only at end of stream, through the EOS Spotlight. The countdown that
// used to live here armed as the credits began and fired 5-30 s later, which
// skipped every after-credits scene and next-episode preview (TYBW 3:1 has
// 169 s of story after its ending). After-credits content always plays unless
// the user presses something.
//
// WHAT FOLLOWS THE ENDING. Because the card is up during the credits, pressing
// Play there would skip whatever comes after them, so a banner on top of the
// card says so (`nextUpTailNote`): "Preview after the credits" when a preview
// chapter fills it, else its length, when that is measured; it goes once the
// ending is over, since the user is then watching what follows. It
// never names an unlabelled tail a scene or a preview: Aura cannot tell them
// apart. A card raised before the ending's end fades with the player controls
// past it, so it does not sit over the scene the user stayed for; it stays
// while the pointer is on it. A card first raised after the ending (the
// fallback timing) stays up, as before. With no card to carry it (no next
// episode), the note shows alone in the card's place (`NextUpTailPill`).
//
// KEYBOARD. The Play Next Episode binding (Shift+X by default) presses the
// card while it is up; with a skip to canon on offer it presses Skip, held
// for 2 s unless AuraSettings.nextUpHoldToSkip is off. See the listener.
//
// Design notes:
//   • It is drawn as the skip prompt's sibling, since it stacks right under
//     it: the same surface (`.aura-stack-surface`), width and side padding
//     (playerStack.ts), corner radius and uppercase header line, so the two
//     read as one group with one left edge. Top to bottom: the header, the
//     episode (thumbnail beside its tag and title, centred on each other),
//     the arc line, the note about what follows the credits, the actions,
//     and last the autoplay line, which is about the end screen rather than
//     the episode. Fixed width, so a hover preview never resizes it.
//   • Motion: it pops in like the prompt, slides with the prompt's height
//     (`top`), fades with the controls, collapses lines that come and go
//     (`Reveal`) instead of jumping, and fades out on the way off
//     (`StackPresence`, which holds the last card for EXIT_MS).
//   • FILLER / RECAP: when the next episode is filler/recap AND a later
//     canon episode exists, its rose/amber tag shows on the thumbnail and
//     the PRIMARY action becomes "Skip to canon · SxxEyy" (jumps past all
//     upcoming filler/recap); a quieter "Play this anyway" plays the
//     filler. Auto-advance then targets the skip, matching the primary.
//   • Z-index sits ABOVE PlayerOverlay (and its skip prompt) so the CTA
//     stays put even when the controls fade. Pointer events route
//     through it so the user can dismiss / play without unhiding the
//     controls.
// ---------------------------------------------------------------------------

import {
  cloneElement, useEffect, useRef, useState, type ReactElement, type ReactNode,
} from "react";
import type { NextUpTailNote } from "./nextUpGate";
import { PLAYER_STACK_WIDTH } from "./playerStack";
import { bindingMatches, isTypingTarget, parseBinding, prettyBinding } from "./useKeybindings";
import ImageLoader from "./ImageLoader";
import { shrinkPoster } from "./posterSize";
import FillerRecapTags from "./FillerRecapTags";
import type { LibraryItem, VideoEntry } from "./types";
import { formatEpisodeTag, episodeKindFlags, episodeKindNoun } from "./nextUp";
import { loadAuraSettings } from "./auraSettings";
import { shouldBlurThumbnail } from "./episodeSpoilers";
import { getWatchState } from "./watchTogether/store";
import Tooltip from "./Tooltip";

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
   *  pre-resolved (with a stream), its SxxEyy tag - presence flips the card
   *  into "skip to canon primary" mode. null otherwise. */
  skipTag?: string | null;
  /** Skip past all upcoming filler/recap into the next canon episode. Wired
   *  by App only when `skipTag` is set. Always called with `auto = false` here
   *  (a click): this card has no countdown. Mirrors EosSpotlight's contract. */
  onSkipToCanon?: (auto: boolean) => void;
  /** The canon episode a skip would land on. Drives the hover preview, so the
   *  user can see WHAT they are skipping to before committing. */
  canonEpisode?: VideoEntry | null;
  /** How many episodes a skip would jump. Turns the tooltip from a vague
   *  promise into a countable one. */
  skipCount?: number;
  /** Play the (literal) next episode. In skip mode this is the "Play this
   *  anyway" fallback; otherwise the primary action. Always `auto = false`. */
  onPlay: (auto: boolean) => void;
  /** Hide the CTA for the rest of the current playback session. App also
   *  records this as a refusal of auto-advance, which the EOS Spotlight then
   *  honours instead of arming its own countdown. */
  onDismiss: () => void;
  /** Set only when the episode just finished was the LAST of its story arc, so
   *  playing the next one crosses an arc boundary. Purely informational.
   *  `next` is null on the final arc. */
  arcNote?: { ending: string; next: string | null } | null;
  /** Consecutive unattended auto-advances (App's still-watching streak). Only
   *  read to tell whether the end screen will count down at all, using the
   *  same test as EosSpotlight, so the "Autoplay" line is never a promise the
   *  end screen then breaks. */
  autoAdvanceStreak?: number;
  /** Whether the end screen's countdown would skip to the canon episode
   *  rather than play the literal next one. The same value App hands
   *  EosSpotlight, read only to decide whether autoplay will happen at all. */
  autoSkipsToCanon?: boolean;
  /** What follows the ending (nextUpGate's `nextUpTailNote`), shown as a
   *  banner on top of the card. null: nothing measured to say. */
  tailNote?: NextUpTailNote | null;
  /** The playhead is past the ending's end: the card follows the player
   *  controls' auto-hide (`controlsVisible`) instead of staying up. */
  fadeWithControls?: boolean;
  /** PlayerOverlay's auto-hide state. Read only with `fadeWithControls`. */
  controlsVisible?: boolean;
  /** `top` of the card: the slot under the skip prompt (playerStack.ts). */
  top: string;
  /** The Play Next Episode binding (useKeybindings spec; empty = unbound).
   *  Plays the next episode, or skips to canon when a skip is offered. */
  hotkey?: string;
  /** With a skip offered, the key must be HELD for HOLD_TO_SKIP_MS (the
   *  card previews the canon episode meanwhile, like hovering Skip); off,
   *  one press skips. AuraSettings.nextUpHoldToSkip. */
  holdToSkip?: boolean;
  /** Set by `StackPresence` on the copy it keeps while the card fades out:
   *  the key is unbound and nothing takes clicks. */
  exiting?: boolean;
}

/** How long the Play Next Episode key is held to skip to canon. */
const HOLD_TO_SKIP_MS = 2000;

/** m:ss for the banner's tail length. */
function formatTailLength(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The banner's words for a tail note. */
function tailNoteText(note: NextUpTailNote): string {
  if (note.kind === "preview") return "Preview after the credits";
  return `${formatTailLength(note.seconds)} more after the credits`
    + (note.withPreview ? ", including a preview" : "");
}

/** The line that says what follows the ending: the one caution on the card,
 *  so it sits on a faint amber strip right above the buttons it is about. */
function TailNoteLine({ note }: { note: NextUpTailNote }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-300/20 bg-amber-400/10
                    px-3 py-2 text-[13px] leading-snug">
      <InfoIcon className="flex-shrink-0 text-amber-300" />
      <span className="text-amber-100">{tailNoteText(note)}</span>
    </div>
  );
}

function InfoIcon({ className, size = 13 }: { className?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
  );
}

/** How long a card or pill takes to fade out once App stops rendering it.
 *  Matches `.aura-stack-exit` in App.css. */
const EXIT_MS = 200;
/** The card follows the skip prompt's height and presence (playerStack.ts). */
const STACK_MOVE = "top 360ms cubic-bezier(0.22, 1, 0.36, 1)";

type Exitable = ReactElement<{ exiting?: boolean }>;

/** Keeps the last card (or pill) on screen for EXIT_MS after App stops
 *  rendering it, marked `exiting` so it fades out instead of vanishing. The
 *  copy is the SAME element type at the same place in the tree, so React keeps
 *  its instance (no remount, no second entry animation). `animate` false
 *  (leaving the player) drops it at once. */
export function StackPresence({
  children, animate = true,
}: {
  children: Exitable | null | false;
  animate?: boolean;
}) {
  const live = children || null;
  const lastRef = useRef<Exitable | null>(null);
  const [wasLive, setWasLive] = useState(live != null);
  const [leaving, setLeaving] = useState<Exitable | null>(null);
  // Derived during render (React's "storing information from previous
  // renders"): on the render where the card goes, the held copy is swapped in
  // before anything commits, so the instance is never unmounted in between.
  if ((live != null) !== wasLive) {
    setWasLive(live != null);
    setLeaving(live == null && animate ? lastRef.current : null);
  }
  if (live) lastRef.current = live;
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);
  if (live) return live;
  return leaving ? cloneElement(leaving, { exiting: true }) : null;
}

/** A line that comes and goes without making the card jump: its height
 *  animates open and shut (grid rows 0fr to 1fr) while it fades. While shutting
 *  it keeps showing what it last showed. Spacing belongs on `className`, which
 *  sits inside the collapsing box, so the gap collapses with it. */
function Reveal({ show, children, className = "" }: { show: boolean; children: ReactNode; className?: string }) {
  const last = useRef<ReactNode>(children);
  if (show) last.current = children;
  return (
    <div
      aria-hidden={!show}
      className={`grid transition-[grid-template-rows,opacity] duration-300 ease-out ${
        show ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"}`}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={className}>{show ? children : last.current}</div>
      </div>
    </div>
  );
}

/** The same note on its own, in the card's place, for an episode with no
 *  card to carry it (no next episode: the latest aired one, a finale). There
 *  it says "do not leave yet" rather than "Play would skip this". It only ever
 *  shows during the ending (the note goes once the ending is over), so it
 *  takes no clicks and fades with the controls only under a Risky ending
 *  (`hidden`), as the prompt above it does. Drawn like the skip prompt: an
 *  uppercase header over one larger line. */
export function NextUpTailPill({
  note, top, hidden = false, exiting = false,
}: { note: NextUpTailNote; top: string; hidden?: boolean; exiting?: boolean }) {
  // Mounted hidden: no rise, whose keyframes end at full opacity.
  const [mountedHidden] = useState(hidden);
  return (
    <div
      // Same slot and layer as the card, which it stands in for.
      className={`aura-stack-surface fixed left-6 z-[10001] rounded-2xl px-6 py-4
                  text-white pointer-events-none ${
                    exiting ? "aura-stack-exit" : mountedHidden ? "" : "aura-stack-enter"}`}
      style={{
        top,
        width: PLAYER_STACK_WIDTH,
        opacity: hidden ? 0 : 1,
        transition: `opacity 500ms ease-in-out, ${STACK_MOVE}`,
        textShadow: STACK_TEXT_SHADOW,
      }}
      role="status"
    >
      <div className="text-[12px] uppercase tracking-[0.22em] text-white/55 mb-1">
        Keep watching
      </div>
      <div className="flex items-center gap-2 text-[18px] font-medium tracking-wide">
        <InfoIcon size={16} className="flex-shrink-0 text-amber-300" />
        <span>{tailNoteText(note)}</span>
      </div>
    </div>
  );
}

/** The skip prompt's text shadow: keeps small text legible over bright
 *  frames that bleed through the glass. */
const STACK_TEXT_SHADOW = "0 1px 4px rgba(0,0,0,0.85)";

/** A key hint on one of the card's buttons: the skip prompt's key cap, small. */
function KeyHint({ children }: { children: ReactNode }) {
  return (
    <kbd className="ml-auto inline-flex items-center h-[20px] px-1.5 rounded-md
                    border border-white/30 bg-white/10 text-white/80
                    font-mono text-[11px] font-medium leading-none">
      {children}
    </kbd>
  );
}

export default function NextUpCta({
  episode, libraryById, loading, noStream, skipTag, onSkipToCanon, canonEpisode,
  skipCount, onPlay, onDismiss, arcNote, autoAdvanceStreak = 0, autoSkipsToCanon,
  tailNote, fadeWithControls = false, controlsVisible = true,
  top, hotkey: boundHotkey = "", holdToSkip = true, exiting = false,
}: Props) {
  // A card on its way out (StackPresence) answers no key.
  const hotkey = exiting ? "" : boundHotkey;
  // Hover preview state: which episode's identity the card is showing.
  const [previewCanon, setPreviewCanon] = useState(false);
  // The Play Next Episode key is being held toward a skip (HOLD_TO_SKIP_MS).
  // Stands in for hovering Skip: the canon preview shows and the card stays up.
  const [holding, setHolding] = useState(false);
  // A pointer resting on the card keeps it up: the player controls auto-hide
  // after 3 s without movement, and the card must not fade out from under a
  // cursor that is about to press Play.
  const [hovered, setHovered] = useState(false);
  const faded = fadeWithControls && !controlsVisible && !hovered && !holding;
  const inert = faded || exiting;
  // A card that first appears already faded (an ending auto-skipped straight
  // into what follows it, controls hidden) skips the rise: the keyframes end
  // at full opacity and would flash it on screen for their 220 ms. App judges
  // that fade against the auto-skip's seek target while the seek is in flight
  // (`nextUpFadeTime`), so the card mounts faded here instead of rising.
  const [mountedFaded] = useState(faded);
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
  // Kind of the LITERAL next episode, for the fallback button's label. Read off
  // `episode` and never off `shown`, so hovering Skip (which swaps the body to
  // the canon episode) cannot relabel a button that still plays the filler.
  const playKindNoun = episodeKindNoun(episode);

  // Whether the end-of-episode screen will count down into the next episode.
  // This card has no countdown of its own, so without saying so a user with
  // autoplay on sees a card that just sits there. Mirrors EosSpotlight's
  // `autoArmed` minus the stream-resolution part: never for an in-sync party
  // follower, never once the still-watching gate has tripped, and never when
  // the countdown would have nothing to play: it skips to canon only when
  // `autoSkipsToCanon` says so (EosSpotlight's `skipMode`), and otherwise
  // needs the literal next episode's stream (`stream != null` there). An
  // OFFERED skip alone is not enough: with the filler preference off the
  // countdown plays the literal next episode, which may have no stream.
  const settings = loadAuraSettings();
  const party = getWatchState();
  const isPartyFollower = party.status === "connected" && !party.isLeader && party.inSync;
  const gatedByStillWatching = settings.stillWatchingGate !== false && autoAdvanceStreak >= 2;
  const skipMode = canSkip && autoSkipsToCanon === true;
  const autoplayAhead = settings.autoAdvanceNextEpisode
    && !isPartyFollower && !gatedByStillWatching && (skipMode || !noStream);
  const dismissLabel = autoplayAhead ? "Hide and cancel autoplay for this episode" : "Hide";

  // THE PLAY NEXT EPISODE KEY (Settings > Keybindings, Shift+X by default).
  // Mounted only while the card is up, so it is bound exactly while there is
  // a card to press, faded or not. It presses what the card offers: with a
  // skip to canon on offer, the SKIP (the key's job is "move on", and the
  // skip is the card's first button), held for HOLD_TO_SKIP_MS unless the
  // hold is turned off, since a skip marks episodes and cannot be taken back
  // as easily as a play. Releasing early cancels. Without a skip, one press
  // plays the next episode. Capture phase like every other player key, so it
  // wins over the bubble-phase useKeybindings listener.
  const latest = useRef({ canSkip, noStream, loading, onPlay, onSkipToCanon, holdToSkip });
  latest.current = { canSkip, noStream, loading, onPlay, onSkipToCanon, holdToSkip };
  const holdTimer = useRef<number | null>(null);
  useEffect(() => {
    const chord = parseBinding(hotkey);
    if (!chord) return;
    const cancel = () => {
      if (holdTimer.current != null) {
        window.clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
      setHolding(false);
    };
    const onDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      // The held key's auto-repeat, whatever modifiers are still down.
      if (holdTimer.current != null && e.code === chord.code) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (!bindingMatches(hotkey, e)) return;
      e.preventDefault();
      e.stopPropagation();
      // A key already held when the card appeared is not a press.
      if (e.repeat) return;
      const a = latest.current;
      if (a.canSkip && a.onSkipToCanon) {
        if (!a.holdToSkip) {
          a.onSkipToCanon(false);
          return;
        }
        setHolding(true);
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null;
          setHolding(false);
          latest.current.onSkipToCanon?.(false);
        }, HOLD_TO_SKIP_MS);
        return;
      }
      if (!a.noStream && !a.loading) a.onPlay(false);
    };
    // Only the bound key's release ends a hold: letting go of Shift first is
    // still holding.
    const onUp = (e: KeyboardEvent) => {
      if (holdTimer.current != null && e.code === chord.code) cancel();
    };
    window.addEventListener("keydown", onDown, true);
    window.addEventListener("keyup", onUp, true);
    // Focus leaving the window swallows the keyup.
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onDown, true);
      window.removeEventListener("keyup", onUp, true);
      window.removeEventListener("blur", cancel);
      cancel();
    };
  }, [hotkey]);
  const keyLabel = parseBinding(hotkey) ? prettyBinding(hotkey) : null;

  // The identity shown in the body. Hovering Skip (or holding the key toward
  // it) fades in the canon episode so the two are directly comparable before
  // committing.
  const previewing = (previewCanon || holding) && canonEpisode != null;
  const shown = previewing && canonEpisode ? canonEpisode : episode;
  const shownTag = formatEpisodeTag(shown);
  const shownTitle = (shown.title ?? "").trim() || "Untitled episode";
  const shownKinds = episodeKindFlags(shown);
  const shownBlur = shouldBlurThumbnail(
    libraryById, shown.id, settings.blurUnwatchedThumbnails === true,
  );

  const skipMarks = previewing && skipCount != null && skipCount > 0;

  return (
    <div
      // Z-INDEX 10001 (above PlayerOverlay's 9999) so the CTA paints
      // and receives clicks ahead of the overlay's invisible layer.
      // `.aura-stack-surface` is the skip prompt's own surface: the two stack
      // as one group, so they must not read as two different materials.
      // The fade mirrors PlayerOverlay's chrome (opacity, 500 ms), and a
      // faded card takes no clicks, like the controls it follows.
      // TOP-LEFT, under the skip prompt (playerStack.ts): everything the
      // credits ask of the user sits in one place, and `top` follows the
      // prompt as it grows, fades or goes.
      // A card that first appears already faded (an ending auto-skipped
      // straight into what follows it, controls hidden) skips the entry: the
      // keyframes end at full opacity and would flash it on screen.
      className={`aura-stack-surface fixed left-6 z-[10001] rounded-2xl px-6 py-4
                  text-white ${exiting ? "aura-stack-exit" : mountedFaded ? "" : "aura-stack-enter"}`}
      style={{
        top,
        width: PLAYER_STACK_WIDTH,
        opacity: faded ? 0 : 1,
        pointerEvents: inert ? "none" : "auto",
        transition: `opacity 500ms ease-in-out, ${STACK_MOVE}`,
        textShadow: STACK_TEXT_SHADOW,
      }}
      role="dialog"
      aria-label="Next episode available"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ── Header ── The skip prompt's header line ("SKIP ENDING" over the
          key), so the stack reads top to bottom as one voice. The episode's
          tag sits with its title below, not here. */}
      <div className="-mt-1 flex items-center justify-between gap-3">
        <span
          className={`text-[12px] uppercase tracking-[0.22em] truncate transition-colors duration-300 ${
            previewing ? "text-purple-300/90" : "text-white/55"}`}
        >
          {previewing ? "Skips to" : "Next up"}
        </span>
        {/* A tooltip here, unlike on the action buttons below: this is a
            small corner button, so a tip above it covers nothing the user is
            deciding about, and closing the card ALSO cancels autoplay for
            this episode, which nothing else on the card says. */}
        <Tooltip pos="top" text={dismissLabel}>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={dismissLabel}
            className="-mr-2 w-7 h-7 flex-shrink-0 rounded-full text-white/55 hover:text-white
                       hover:bg-white/12 transition-colors flex items-center justify-center"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </Tooltip>
      </div>

      {/* ── Episode ── */}
      <div className="mt-2 flex items-center gap-4">
        <div
          className="relative flex-shrink-0 w-[148px] rounded-lg overflow-hidden bg-white/5"
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
              // still) to this card's thumbnail, so the smearing is equally
              // strong relative to the image rather than merely equal in
              // pixels. The slight scale-up hides the soft edge the blur
              // leaves at the container border.
              // The preview respects the spoiler blur for the CANON episode on
              // its own terms: skipping to an unwatched episode must not become
              // a way to peek at its still.
              imgStyle={shownBlur
                ? { filter: "blur(7px) saturate(115%)", transform: "scale(1.08)" }
                : undefined}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-white/25">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          )}
          {/* Filler / recap tag - top-right of the thumbnail (mirrors the
              episode list). Shows what's actually next even in skip mode. */}
          <FillerRecapTags filler={shownKinds.filler} recap={shownKinds.recap} className="absolute top-1.5 right-1.5 z-10" />
          {/* The hairline edge, drawn OVER the still: an inset ring on the
              box itself paints under the image and never shows. */}
          <span aria-hidden className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/10 pointer-events-none" />
        </div>

        <div className="flex-1 min-w-0">
          <div key={shown.id} className="aura-canon-fade">
            <p
              className={`text-[12px] font-semibold tabular-nums tracking-[0.08em] transition-colors duration-300 ${
                previewing ? "text-purple-300/90" : "text-white/55"}`}
            >
              {shownTag}
            </p>
            <p className="mt-0.5 text-white text-[16px] font-medium leading-snug line-clamp-2">
              {shownTitle}
            </p>
          </div>
          {/* What the skip COSTS, shown in the card rather than over it: a
              skip marks everything it passes as watched, writes History rows
              and (on a click) scrobbles them. It opens while the user previews
              the skip, which is exactly when it matters. */}
          <Reveal show={skipMarks} className="pt-1">
            <p className="text-purple-300/90 text-[13px] leading-snug">
              Marks {skipCount} episode{skipCount === 1 ? "" : "s"} skipped
            </p>
          </Reveal>
        </div>
      </div>

      {/* Arc boundary, under the episode across the card's width: additive to
          the SxxEyy tag, not a replacement, since the user still needs to
          know which episode is queued. The ended arc in white, where the
          story goes next in the accent. */}
      {arcNote && (
        <div className="mt-3 flex items-start gap-2 text-[13px] leading-snug">
          <ArcIcon />
          <p className="min-w-0">
            <span className="text-white/85">{arcNote.ending} complete</span>
            <span className="text-white/35"> · </span>
            <span className="text-ln-accent">
              {arcNote.next ? `Next: ${arcNote.next}` : "Final arc"}
            </span>
          </p>
        </div>
      )}

      {/* ── What pressing Play now would skip ── Right above the actions,
          where the decision is made. It goes when the ending does, so it
          collapses rather than making the buttons jump. */}
      <Reveal show={tailNote != null} className="pt-3">
        {tailNote && <TailNoteLine note={tailNote} />}
      </Reveal>

      {noStream && !canSkip ? (
        <p className="mt-3 text-amber-200/90 text-[13px] leading-snug">
          No streams found for this episode. Try opening it from the episode
          list.
        </p>
      ) : (
        // BOTH ACTIONS, ALWAYS, whenever a skip is available. The card used
        // to show one primary whose meaning flipped based on a setting, so
        // the user could neither see what would be skipped nor choose per
        // episode. Now Skip and Play sit side by side (the preference decides
        // which one the EOS Spotlight's unattended countdown presses).
        // NO TOOLTIPS on either button, and no native `title` either: a tip
        // on a full-width button covers the thumbnail, the episode tag and
        // the title of the very episode the user is deciding about. The
        // buttons name their own target ("Skip to S05E23", "Play filler
        // anyway"). Same in EosSpotlight.
        //
        // Hovering Skip previews the canon episode in the body above, which
        // is the part that was worth having.
        <div className="mt-3.5 flex flex-col gap-2">
          {canSkip && (
            <button
              type="button"
              onClick={() => onSkipToCanon!(false)}
              onMouseEnter={() => setPreviewCanon(true)}
              onMouseLeave={() => setPreviewCanon(false)}
              onFocus={() => setPreviewCanon(true)}
              onBlur={() => setPreviewCanon(false)}
              className={`${ACTION_BUTTON} border-purple-400/50 bg-purple-500/25 text-purple-100
                          hover:bg-purple-500/35 hover:border-purple-300/60`}
            >
              {/* The hold's progress, filling left to right; unmounted on
                  release, so an early release empties it at once. */}
              {holding && (
                <span
                  aria-hidden
                  className="absolute inset-0 origin-left bg-purple-400/35"
                  style={{ animation: `next-up-hold ${HOLD_TO_SKIP_MS}ms linear forwards` }}
                />
              )}
              <span className="relative flex flex-1 items-center gap-2.5 min-w-0">
                <span className={ACTION_ICON}><SkipIcon /></span>
                <span className="truncate">{`Skip to ${skipTag}`}</span>
                {keyLabel && <KeyHint>{holdToSkip ? `Hold ${keyLabel}` : keyLabel}</KeyHint>}
              </span>
            </button>
          )}
          {!noStream && (
            <button
              type="button"
              disabled={loading}
              onClick={() => onPlay(false)}
              className={`${ACTION_BUTTON} disabled:opacity-55 disabled:cursor-progress ${
                canSkip
                  // Secondary when a skip is on offer: two equally loud
                  // buttons would make the choice harder, not easier.
                  ? "h-9 border-white/12 bg-white/6 text-white/80 hover:bg-white/12 hover:text-white"
                  : "border-ln-accent/50 bg-ln-accent/25 text-white hover:bg-ln-accent/35 hover:border-ln-accent/70"
              }`}
            >
              <span className="relative flex flex-1 items-center gap-2.5 min-w-0">
                {loading ? (
                  <>
                    <svg className="animate-spin flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="32 16" />
                    </svg>
                    <span className="truncate">Resolving stream...</span>
                  </>
                ) : (
                  <>
                    <span className={ACTION_ICON}><PlayIcon /></span>
                    {/* Names the kind of the episode this button would
                        actually play - the LITERAL next one - not the run as a
                        whole. A skip can pass several episodes of mixed kinds,
                        but this button only ever plays the first of them. */}
                    <span className="truncate">
                      {canSkip ? `Play ${playKindNoun ?? "it"} anyway` : "Play next episode"}
                    </span>
                    {/* The key presses Skip when one is offered, so only the
                        lone Play button names it. */}
                    {keyLabel && !canSkip && <KeyHint>{keyLabel}</KeyHint>}
                  </>
                )}
              </span>
            </button>
          )}
        </div>
      )}

      {/* Neutral on purpose: it stays true whichever button (Play or Skip)
          the end screen's countdown presses. Last, and quiet: it is about
          the end screen, not this card's choice. */}
      {autoplayAhead && (
        <p className="mt-3 flex items-center gap-1.5 text-white/45 text-[12px] leading-snug">
          <AutoplayIcon />
          Autoplay starts when this episode ends
        </p>
      )}
    </div>
  );
}

/** The card's two actions: full-width rows at the player menus' 13.5 px, with
 *  room for a key cap on the right. */
const ACTION_BUTTON = `group relative w-full h-10 px-3.5 rounded-xl overflow-hidden border
  text-[13.5px] font-semibold tracking-wide text-left flex items-center
  transition-[background-color,border-color,color,transform] duration-200
  active:scale-[0.985]`;
/** The icon nudges forward on hover: a small "this moves you on". */
const ACTION_ICON = "flex-shrink-0 transition-transform duration-200 group-hover:translate-x-0.5";

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

/** A flag at a boundary: the arc line's marker. */
function ArcIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden
         className="mt-[2px] flex-shrink-0 text-ln-accent">
      <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z" />
    </svg>
  );
}

function AutoplayIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden className="flex-shrink-0">
      <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0020 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 004 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
    </svg>
  );
}

function SkipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 18l8.5-6L6 6v12zM16 6h2v12h-2z" />
    </svg>
  );
}
