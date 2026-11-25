// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The languages offered by the audio and subtitle pickers (Settings and the
 *  first-run setup). One list, so the two places cannot drift. Values are
 *  ISO 639-1 codes, the tokens `audio_priority` and `subtitle_language` hold. */
export const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "en", label: "English" },
  { value: "ja", label: "Japanese" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
  { value: "ru", label: "Russian" },
];

/** The `subtitle_language` value (and per-title `sub_lang`) that means "no
 *  subtitles": nothing is auto-selected or auto-loaded on play, forced tracks
 *  included, and the player's Subtitles menu can still turn a track on for
 *  that playback. Never part of LANGUAGE_OPTIONS: audio has no "off". */
export const SUBTITLES_OFF = "off";

export function isSubtitlesOff(lang: string | null | undefined): boolean {
  return (lang ?? "").trim().toLowerCase() === SUBTITLES_OFF;
}

/** The subtitle language choices (Settings and the first-run setup): Off,
 *  then the shared language list. */
export const SUBTITLE_LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: SUBTITLES_OFF, label: "Off" },
  ...LANGUAGE_OPTIONS,
];

/** SUBTITLE_LANGUAGE_OPTIONS for a select showing `stored`: a stored code the
 *  list does not hold (an import, a cloud blob, a code typed into an older
 *  build) is prepended as itself. A native select whose value matches no
 *  option shows its first one, which is "Off", and picking it would change
 *  behaviour. */
export function subtitleLanguageOptions(stored: string | null | undefined): { value: string; label: string }[] {
  if (!stored || SUBTITLE_LANGUAGE_OPTIONS.some((l) => l.value === stored)) return SUBTITLE_LANGUAGE_OPTIONS;
  return [{ value: stored, label: stored }, ...SUBTITLE_LANGUAGE_OPTIONS];
}
