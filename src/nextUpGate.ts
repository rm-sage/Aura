// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// nextUpGate: WHEN the Next-Up card may appear, and where the stream ends.
//
// Pure (plus one module-level value, the detected media end of the playing
// file) and import-free, so a node check can load it directly.
//
// The rules (skipdetect spec, "Next-Up / auto-advance"):
//
//   1. Nothing auto-advances before end of stream. The corner card NEVER runs a
//      countdown: unattended advance happens only on the EOS path (mpv's
//      keep-open pause -> EosSpotlight). After-credits scenes and previews
//      therefore always play unless the user presses something. The old card
//      armed at the ED START and fired 5-30 s later, which lost every
//      after-credits scene and preview (TYBW 3:1 has 169 s of story after its
//      ending).
//   2. One trigger expression. With a TRUSTED ending (Layer 1, the AnimeThemes
//      match, including a Transition-only match, whose END is trusted even
//      though its start is the song's, and a partially Over match, which is
//      prompt-only but located by the same evidence; the published ending that replaced a
//      match counts when its end agrees with the match's; agreed Layer 2 once
//      it ships) the card appears at
//      max(ed_end, end - lead): never inside the ending, and when story follows
//      the ending it waits for the plain lead time instead of covering that
//      story. When the ending is the last thing in the file (nothing follows
//      it within ED_LAST_SLACK_S) it appears at ed_end. Without a trusted
//      ending: the lead trigger only. A crowd, chapter or Layer 3 ED START is
//      never a trigger.
//   3. "end" is the MEDIA end (last decoded audio, from the detector), else
//      the container duration. A container can run ~29 s past its media.
//   4. The card hides again only when the playhead moves back more than
//      HIDE_MARGIN_S before the trigger, so the hide rule cannot take down a
//      card raised at the ED end.
// ---------------------------------------------------------------------------

/** An ending that finishes within this of the end is the last content. */
export const ED_LAST_SLACK_S = 5;
/** Seeking back past the trigger by more than this takes the card away. */
export const HIDE_MARGIN_S = 5;
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
  const leadAt = end - leadSeconds;
  const ed = timing.trustedEdEnd;
  if (ed != null && Number.isFinite(ed) && ed > 0) {
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

/** Should a card that is up be taken down at `time`? Only a real move back. */
export function nextUpShouldHide(
  time: number,
  timing: NextUpTiming,
  duration: number,
  leadSeconds: number,
): boolean {
  const at = nextUpTriggerAt(timing, duration, leadSeconds);
  return at == null || time < at - HIDE_MARGIN_S;
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
