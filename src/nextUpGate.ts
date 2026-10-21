// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// nextUpGate: WHEN the Next-Up card may appear, and where the stream ends.
//
// Pure (plus one module-level value, the detected media end of the playing
// file) and import-free, so a node check can load it directly.
//
// The rules:
//
//   1. Nothing auto-advances before end of stream. The corner card NEVER runs a
//      countdown: unattended advance happens only on the EOS path (mpv's
//      keep-open pause -> EosSpotlight). After-credits scenes and previews
//      therefore always play unless the user presses something. The card that
//      armed a countdown at the ED start and fired 5-30 s later lost every
//      after-credits scene and preview (TYBW 3:1 has 169 s of story after its
//      ending); the START was never the problem, the countdown was.
//   2. The card appears when the ending STARTS: the ending `nextUpEnding`
//      (skipWindows.ts) elects, at any level (Verified, then Likely, then
//      Risky), unless it lies in the first half of the file or starts within
//      ED_LAST_SLACK_S of the end (nothing left to show). A Risky ending
//      raises it as well, together with its prompt: a Transition-only theme's
//      start can sit minutes inside the story (Cowboy Bebop 13's 280 s) and a
//      lone AniSkip ending is wrong 8 times in 13, but a card without a
//      countdown only sits there, while waiting for the trusted END put it up
//      in the last seconds of every Transition-only ending that runs to the
//      end of the file (To Be Hero X E07, 1246-1415 s of 1422 s). Waiting for
//      the ending's END instead (v2.2.2) put the card on
//      screen a fraction of a second before the end screen covered it on
//      every episode whose ending runs to the end of the file.
//   3. Without a credible start, the v2.2.2 expression: with a TRUSTED ending
//      (Layer 1, the AnimeThemes match, including a Transition-only match,
//      whose END is trusted even though its start is the song's, and a
//      partially Over match; the published ending that replaced a match
//      counts when its end agrees with the match's) the card appears at
//      max(ed_end, end - lead), or at ed_end when nothing follows it within
//      ED_LAST_SLACK_S. Without a trusted ending: the lead trigger only.
//   4. What follows the ending is SAID, never guessed (`nextUpTailNote`): a
//      preview chapter that fills it is a preview; otherwise only its length,
//      and only when a trusted ending end and a MEASURED media end (TAIL read
//      to EOF, else the probe's DURATION tag; never the container duration)
//      bound it. The banner is a warning about what Play would skip, so it
//      goes once the ending is over: the user is then watching it. A crowd or chapter ending's end is not enough
//      (AniSkip ending rows ran 32-38 s early on TYBW 3:9-3:11, which would
//      invent a tail).
//   5. A card that went up while the PLAYHEAD was before the ending's end
//      fades with the player controls once the playhead passes it
//      (`nextUpFadeFrom`): the user stayed for whatever follows. That includes
//      an ending auto-skipped straight past (the user chose to skip it). A
//      card that first went up at or after that point (the rule 3 fallback, a
//      resume or a seek into the tail) stays up, as it did in v2.2.2: born
//      faded, it would never be seen by a viewer who is not moving the mouse.
//      A card raised by a RISKY ending's start follows the controls from the
//      moment it goes up (`nextUpFollowsControls`), like that ending's prompt
//      (user's call, 2026-10-20): the ending may be wrong and sit over story,
//      so neither pops up on its own. Their keys work while they are hidden.
//   6. "end" is the MEDIA end (last decoded audio, from the detector), else
//      the container duration. A container can run ~29 s past its media.
//   7. The card hides again only when the playhead moves back more than
//      HIDE_MARGIN_S before the trigger. While the trigger is a rule 3
//      fallback, that is measured from the EARLIEST trigger the card was
//      raised at, so a later stamp that withdraws the ending cannot take it
//      down in the middle of the credits. A credible start (rule 2) is always
//      measured from itself: a stamp that replaced a wrong ending with the
//      real, later one takes down a card that went up over story.
// ---------------------------------------------------------------------------

/** An ending that finishes within this of the end is the last content. */
export const ED_LAST_SLACK_S = 5;
/** Seeking back past the trigger by more than this takes the card away. */
export const HIDE_MARGIN_S = 5;
/** An ending that starts before this fraction of the file raises no card: a
 *  crowd or chapter "ending" that early is not the credits. */
export const ED_START_MIN_FRACTION = 0.5;
/** A detected media end further than this below the container duration is
 *  not trusted (measured gaps: 0.95-29.09 s). */
export const MEDIA_END_MAX_GAP_S = 60;

/** The end of the playable media: the detector's media end when it is a sane
 *  value at or below the container duration, else the container duration. */
export function playableEnd(duration: number, mediaEnd: number | null | undefined): number {
  if (!(duration > 0)) return duration;
  if (mediaEnd == null || !Number.isFinite(mediaEnd) || mediaEnd <= 0) return duration;
  if (mediaEnd >= duration || duration - mediaEnd > MEDIA_END_MAX_GAP_S) return duration;
  return mediaEnd;
}

export interface NextUpTiming {
  /** End of a TRUSTED ending (Layer 1, a Transition-only or partially Over
   *  match included), or null. */
  trustedEdEnd: number | null;
  /** The detector's media end (final or early estimate), or null. */
  mediaEnd: number | null;
  /** The media end as MEASURED: the value read at TAIL EOF, else the probe's
   *  mapped-track DURATION tag; never the container duration the early
   *  estimate can be. The banner's tail length rests on this. */
  mediaEndMeasured: number | null;
  /** Start and end of the ending whose START raises the card (any level and
   *  source: `nextUpEnding`), or null. */
  edStart: number | null;
  edEnd: number | null;
  /** That ending is Risky (`skipConfidence`): a card it raises shows only
   *  with the player controls (rule 5). */
  edRisky: boolean;
  /** The file's preview window (a titled preview chapter), or null. */
  previewStart: number | null;
  previewEnd: number | null;
}

/** Nothing known yet: the state at every load. A fresh object per call. */
export function emptyNextUpTiming(): NextUpTiming {
  return {
    trustedEdEnd: null, mediaEnd: null, mediaEndMeasured: null,
    edStart: null, edEnd: null, edRisky: false, previewStart: null, previewEnd: null,
  };
}

const finitePos = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v) && v > 0;

/** Rule 2's trigger: the ending's start, when it is credible and in the
 *  second half of the file, or null. One that starts within the slack of the
 *  end has nothing to show. */
function credibleStart(timing: NextUpTiming, end: number): number | null {
  const start = timing.edStart;
  return finitePos(start) && start >= end * ED_START_MIN_FRACTION && start < end - ED_LAST_SLACK_S
    ? start : null;
}

/** The playback position at which the card may appear, or null when the
 *  feature is off / there is nothing to time against. */
export function nextUpTriggerAt(
  timing: NextUpTiming,
  duration: number,
  leadSeconds: number,
): number | null {
  if (!(leadSeconds > 0) || !(duration > 0)) return null;
  const end = playableEnd(duration, timing.mediaEnd);
  const start = credibleStart(timing, end);
  if (start != null) return start;
  const leadAt = end - leadSeconds;
  const ed = timing.trustedEdEnd;
  if (finitePos(ed)) {
    // An ending that reaches within the slack of the end (including one
    // clamped exactly TO the end, or past it against a container end) is the
    // last content: the card waits for it, never the lead time inside it.
    if (ed >= end - ED_LAST_SLACK_S) return Math.min(ed, end);
    return Math.max(ed, leadAt);
  }
  return leadAt;
}

/** Should the card be up at `time`? */
export function nextUpShouldShow(
  time: number,
  timing: NextUpTiming,
  duration: number,
  leadSeconds: number,
): boolean {
  const at = nextUpTriggerAt(timing, duration, leadSeconds);
  return at != null && time >= at && time < duration;
}

/** Should a card that is up be taken down at `time`? Only a real move back
 *  (rule 7): from the earliest trigger it was raised at (`shownAt`) while the
 *  trigger is a fallback, from the trigger itself while it is a credible
 *  ending start. */
export function nextUpShouldHide(
  time: number,
  timing: NextUpTiming,
  duration: number,
  leadSeconds: number,
  shownAt: number | null = null,
): boolean {
  const at = nextUpTriggerAt(timing, duration, leadSeconds);
  if (at == null) return true;
  const floor = credibleStart(timing, playableEnd(duration, timing.mediaEnd)) != null
    ? at : Math.min(at, shownAt ?? at);
  return time < floor - HIDE_MARGIN_S;
}

/** What the card's banner says follows the ending, or null for nothing to
 *  say (and from the moment the ending is over). `preview`: a preview chapter
 *  fills it. `more`: `seconds` of something after the ending, measured from a
 *  trusted ending end to a measured media end; `withPreview` when a preview
 *  chapter is part of it. */
export type NextUpTailNote =
  | { kind: "preview" }
  | { kind: "more"; seconds: number; withPreview: boolean };

export function nextUpTailNote(
  timing: NextUpTiming,
  duration: number,
  time: number,
): NextUpTailNote | null {
  if (!(duration > 0)) return null;
  // Where the ending stops, as well as it is known.
  const trusted = finitePos(timing.trustedEdEnd) ? timing.trustedEdEnd : null;
  const after = trusted ?? (finitePos(timing.edEnd) ? timing.edEnd : null);
  // Once the ending is over the user is watching what follows: nothing left
  // to warn about.
  if (after == null || !(time < after)) return null;
  // A length is said only when both of its ends are measured: a trusted
  // ending end, and a measured media end playableEnd keeps. The early
  // estimate can be the container duration, which can run ~29 s past the
  // media and would invent a tail.
  // One a few ms past the container duration (audio a frame past an MKV's
  // segment duration) is still measured, clamped to it.
  const m = timing.mediaEndMeasured;
  const measured = !finitePos(m) ? null
    : m >= duration ? duration
      : playableEnd(duration, m) === m ? m : null;
  const end = measured ?? playableEnd(duration, timing.mediaEnd);
  // A preview chapter that FILLS what follows the ending: it starts where the
  // ending stops and runs to the end (the container end bounds that from
  // above when the media end is not measured). Anything less leaves an
  // unlabelled stretch the word "preview" would hide.
  const ps = timing.previewStart, pe = timing.previewEnd;
  const preview = finitePos(ps) && finitePos(pe) && pe > ps
    && ps >= after - ED_LAST_SLACK_S ? { start: ps, end: pe } : null;
  const fills = preview != null
    && preview.start - after <= ED_LAST_SLACK_S && end - preview.end <= ED_LAST_SLACK_S;
  if (trusted != null && measured != null) {
    if (!(end - trusted > ED_LAST_SLACK_S)) return null;
    if (fills) return { kind: "preview" };
    return { kind: "more", seconds: Math.round(end - trusted), withPreview: preview != null };
  }
  return fills ? { kind: "preview" } : null;
}

/** The playback position from which the card fades with the player controls
 *  (the end of the ending: the trusted one, else the electing one), or null
 *  for a card that stays up. `raisedAt` is the PLAYHEAD when the card went
 *  up: only a card up BEFORE the ending ended fades (rule 5). */
export function nextUpFadeFrom(timing: NextUpTiming, raisedAt: number | null): number | null {
  const from = finitePos(timing.trustedEdEnd) ? timing.trustedEdEnd
    : finitePos(timing.edEnd) ? timing.edEnd : null;
  if (from == null || raisedAt == null || !(raisedAt < from)) return null;
  return from;
}

/** Whether the card (or its tail note) shows only while the player controls
 *  do at `time`: raised by a Risky ending's start, or past the fade point of
 *  rule 5. */
export function nextUpFollowsControls(
  timing: NextUpTiming,
  duration: number,
  time: number,
  raisedAt: number | null,
): boolean {
  if (timing.edRisky && credibleStart(timing, playableEnd(duration, timing.mediaEnd)) != null) return true;
  const from = nextUpFadeFrom(timing, raisedAt);
  return from != null && time >= from;
}

// ---------------------------------------------------------------------------
// An ending auto-skip whose seek has not landed yet.
//
// The SkipController seeks on the first time update inside an Auto ending, and
// the gate raises the card in the same commit, but mpv reports the new
// position only once the seek lands (100 ms to over 1 s on a debrid stream).
// Judged on the old time the card mounted visible, rose, and then faded with
// the hidden controls: a 0.5-2 s flash on every auto-skipped ending. The fade
// is judged against the seek's TARGET while it is pending (`nextUpFadeTime`);
// raisedAt stays the playhead at the raise, so rule 5 is unchanged. Bounded:
// one entry, dropped once the playhead reaches the fade point, on a seek back
// before the ending, after 3 s, or on a new load.
// ---------------------------------------------------------------------------

const AUTO_SKIP_SEEK_TTL_MS = 3000;
let endingSkipSeek: { start: number; target: number; at: number } | null = null;

/** The SkipController is about to auto-seek past an ending (`start` is the
 *  window's start, `target` where the seek lands). */
export function noteEndingAutoSkipSeek(start: number, target: number): void {
  endingSkipSeek = Number.isFinite(start) && Number.isFinite(target)
    ? { start, target, at: Date.now() } : null;
}

export function clearEndingAutoSkipSeek(): void {
  endingSkipSeek = null;
}

/** `time` for the card's fade decision: the pending auto-skip's target while
 *  that seek is in flight for the electing ending (start within 3 s), else
 *  `time`. Only the fade reads it; the gate and the tail note keep `time`. */
export function nextUpFadeTime(timing: NextUpTiming, time: number): number {
  const p = endingSkipSeek;
  if (p == null) return time;
  // The seek lands at the end of that same ending; a refined end a fraction
  // past the target must not leave the card judged inside it once the seek
  // HAS landed, so the entry holds until the playhead reaches that fade point.
  const end = finitePos(timing.trustedEdEnd) ? timing.trustedEdEnd : timing.edEnd;
  const landed = finitePos(end) && Math.abs(end - p.target) <= 3 ? Math.max(end, p.target) : p.target;
  if (Date.now() - p.at > AUTO_SKIP_SEEK_TTL_MS || time >= landed || time < p.start - 1) {
    endingSkipSeek = null;
    return time;
  }
  const start = timing.edStart;
  if (!finitePos(start) || Math.abs(start - p.start) > 3) return time;
  return landed;
}

// ---------------------------------------------------------------------------
// The playing file's detected media end, for the end-of-stream detectors.
//
// mpv's `duration` is the CONTAINER duration; when the container runs past the
// media (Spy x Family E2: 29 s), mpv's keep-open stops at the media end, far
// outside the 5 s near-end tail every EOS detector tests against `duration`,
// and the end card never came. Fed with the FINAL value (TAIL read to EOF)
// when there is one, else the probe's mapped-track DURATION tag (matched the
// final value within 0.012 s on every measured release); never the container
// duration. Still bounded by playableEnd. Reset on every new load.
// ---------------------------------------------------------------------------

let detectedMediaEnd: number | null = null;

export function setDetectedMediaEnd(value: number | null): void {
  detectedMediaEnd = value != null && Number.isFinite(value) && value > 0 ? value : null;
}

/** `duration` for the end-of-stream detectors: the detected media end when
 *  known and sane, else the container duration. */
export function eosEnd(duration: number): number {
  return playableEnd(duration, detectedMediaEnd);
}
