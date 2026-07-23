// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// titleState — frontend wrapper around per_title.rs.
//
// Saves the user's per-title preferences (volume, shader, audio language,
// subtitle language). Calls are debounced at the call site for high-traffic
// writers (volume scrubbing) so we don't fsync on every slider tick.
//
// Speed is intentionally NOT included — playback speed is a transient
// "this scene is talkative" tweak, not a per-title preference.
// ---------------------------------------------------------------------------

export interface TitleState {
  volume?:     number | null;  // 0..100
  shader?:     string | null;  // free-form profile id
  audio_lang?: string | null;  // 2-letter ISO ("ja", "en", …)
  sub_lang?:   string | null;  // 2-letter ISO, or "off" to mean "subs disabled"
}

/** Per-title state is a property of the SHOW, not of one episode: an audio
 *  or subtitle language picked on S01E01 has to apply to S01E02. For series,
 *  `activeTarget.id` is the EPISODE id, so keying on it saved a preference
 *  that could only ever match the episode the user had just finished, and
 *  grew the store by one record per episode watched. Every call site resolves
 *  the key through here instead. Movies are unaffected: their `series_id` is
 *  absent or equal to `id`. */
export function titleStateKey(
  target: { id: string; series_id?: string | null },
): string {
  return target.series_id ?? target.id;
}

/** Look up saved state for `{media_type}:{id}`. Returns null if nothing
 *  is stored yet (caller should fall back to the global defaults). */
export async function getTitleState(
  mediaType: string,
  id: string,
): Promise<TitleState | null> {
  try {
    return await invoke<TitleState | null>("get_title_state", { mediaType, id });
  } catch {
    return null;
  }
}

/** Merge `patch` into the saved state. Fields omitted from `patch` are
 *  left alone. Best-effort — failures are swallowed so a transient
 *  filesystem error never blocks the player. */
export async function setTitleState(
  mediaType: string,
  id: string,
  patch: TitleState,
): Promise<void> {
  try {
    await invoke("set_title_state", { mediaType, id, patch });
  } catch {
    /* ignore */
  }
}
