// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The first-run wizard shipped from May 2026 to 2.3.2 wrote its "Audio
// language" pick as `audio_priority: [code]`, replacing the default
// `["original", "en"]` and dropping the "original" token. With it gone, a title
// plays in the picked language whenever a track exists (an English dub of an
// anime, say) and never in its original language. The wizard's separate anime
// pick went to a key that never existed, so it was lost.
//
// That exact shape (one entry, one of the wizard's ten codes) is repaired once
// per account (`audioPriorityRepair.ts`; the synced backend flag
// `audio_priority_repaired` records that the check ran). The repair matches what
// the rebuilt wizard writes: English becomes the default `original, en` (the
// old wizard showed English as its preselected value), any other language
// keeps first place and gets `original` behind it.
//
// Import-free so it can be checked under node.
// ---------------------------------------------------------------------------

/** The old wizard's language list, the only values it could write. */
const OLD_WIZARD_CODES = new Set(["en", "ja", "es", "fr", "de", "ko", "zh", "pt", "ru", "it"]);

/** The repaired list for a value the old wizard wrote, or null when the value
 *  is anything else (left alone). */
export function repairLegacyAudioPriority(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const code = value[0];
  if (typeof code !== "string" || !OLD_WIZARD_CODES.has(code)) return null;
  return code === "en" ? ["original", "en"] : [code, "original"];
}

/** The bell notice raised when the repair changed the list (device-local:
 *  sync.ts isDeviceLocalNotification). Its "Undo" restores `data.from`. */
export const AUDIO_ORDER_NOTICE_ID = "notice:audio-order-repair";
export const AUDIO_ORDER_DATA_KIND = "audio-order-repair";

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English", ja: "Japanese", es: "Spanish", fr: "French", de: "German",
  ko: "Korean", zh: "Chinese", pt: "Portuguese", ru: "Russian", it: "Italian",
};

/** The notice copy for a repair from `from` to `to` (both as returned by
 *  repairLegacyAudioPriority's input and output). Short: the bell row shows
 *  two lines of the subtitle. */
export function describeAudioOrderRepair(from: string[], to: string[]): { title: string; subtitle: string } {
  const title = "Audio order updated";
  const code = from[0] ?? "";
  const name = LANGUAGE_NAMES[code] ?? code;
  if (to[0] === "original") {
    return { title, subtitle: `Titles now play in their original language first, then ${name} (was ${name} only).` };
  }
  return { title, subtitle: `Titles now play in ${name} first, then their original language (was ${name} only).` };
}

/** A string list as stored in `audio_priority`, or null for anything else
 *  (a notice's data is read back from storage, so it is checked). */
export function asAudioPriority(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  return value.every((v) => typeof v === "string" && v.length > 0 && v.length <= 32) ? (value as string[]) : null;
}

/** Same list, same order. */
export function sameAudioPriority(a: unknown, b: unknown): boolean {
  const x = asAudioPriority(a);
  const y = asAudioPriority(b);
  return !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
}
