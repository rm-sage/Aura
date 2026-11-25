// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// One-time repair of the audio order the old first-run wizard broke (see
// `legacyAudioPriority.ts` for what it wrote and what replaces it).
//
// ONCE PER ACCOUNT. That the check ran is the backend setting
// `audio_priority_repaired`, which syncs with the list it describes (written
// in the same patch), so once any device has run it no other device does and
// none rewrites a single-language list the user then set on purpose. sync.ts
// writeSettingsBlob never lets a pull turn it back off. It is not in settings
// export / import (an imported `false` would re-arm the check), and a "Reset
// all settings" keeps it (settings.rs reset_settings).
//
// It waits for this account's first cloud pull of the session to answer
// (settingsCloudSettled): before that, the pull would replace a repaired value
// with the cloud's old copy, and a fresh device would not yet see another
// device's flag. A check that could not finish (the pull failed, the account
// changed, storage unavailable) records nothing and runs again on the next
// launch or sign-in. The per-device marker (`DONE_KEY_PREFIX` + scope) from
// before the synced flag still stops this device from repairing; such a device
// only publishes the flag.
//
// When the list really changed, a device-local bell notice says what changed
// and offers Undo (`undoAudioOrderRepair`), which restores the exact previous
// list through patchBackendSettings. The notice carries the lists and the
// scope in its data, so Undo still works after a restart. The repair may
// finish before the bell is mounted (sign-in runs on the landing screen), so
// it parks the notice in `PENDING_KEY` and useAudioOrderNotice raises it.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { patchBackendSettings } from "./backendSettings";
import {
  AUDIO_ORDER_DATA_KIND,
  asAudioPriority,
  repairLegacyAudioPriority,
  sameAudioPriority,
} from "./legacyAudioPriority";
import { settingsCloudSettled } from "./sync";

const DONE_KEY_PREFIX = "aura:audio-priority-repair-v1:";
/** A notice owed but not yet raised: `{ scope, from, to }`. Device-local. */
export const AUDIO_ORDER_PENDING_KEY = "aura:audio-order-notice:v1";
/** Fired after a repair parks its notice. */
export const AUDIO_ORDER_REPAIRED_EVENT = "aura:audio-order-repaired";
/** Fired after the repair or its Undo writes the list. Settings holds its own
 *  copy of the backend settings and re-reads only for a cloud pull, so without
 *  this it kept showing (and on the next edit, wrote back) the old list. */
export const AUDIO_ORDER_CHANGED_EVENT = "aura:audio-order-changed";

const running = new Set<string>();

export interface AudioOrderNoticeData {
  kind: typeof AUDIO_ORDER_DATA_KIND;
  scope: string;
  from: string[];
  to: string[];
  [key: string]: unknown;
}

/** `scope` is the settings scope ("guest" or "user-<auth_key[0..12]>");
 *  `pulled` is the scope's first syncPullAll (resolved at once for a guest). */
export async function runLegacyAudioPriorityRepair(scope: string, pulled: Promise<unknown>): Promise<void> {
  const doneKey = DONE_KEY_PREFIX + scope;
  let doneHere: boolean;
  try {
    doneHere = localStorage.getItem(doneKey) !== null;
  } catch {
    return; // nowhere to record "done": do not risk repairing twice
  }
  if (running.has(scope)) return;
  running.add(scope);
  try {
    await pulled.catch(() => {});
    if (!settingsCloudSettled(scope)) return;
    const settings = await invoke<Record<string, unknown>>("get_settings");
    // The account can change during the read: get_settings then answered for
    // the new one, and the write would land there too.
    if (!settingsCloudSettled(scope)) return;
    if (settings.audio_priority_repaired === true) {
      // Another device (or an earlier launch) ran it for this account.
      if (!doneHere) localStorage.setItem(doneKey, "1");
      return;
    }
    const previous = asAudioPriority(settings.audio_priority);
    const repaired = doneHere || !previous ? null : repairLegacyAudioPriority(previous);
    // One patch, so the flag and the list it describes land and sync together.
    await patchBackendSettings(
      repaired ? { audio_priority: repaired, audio_priority_repaired: true } : { audio_priority_repaired: true },
      settings,
    );
    if (repaired) window.dispatchEvent(new Event(AUDIO_ORDER_CHANGED_EVENT));
    if (!doneHere) localStorage.setItem(doneKey, "1");
    if (repaired && previous) {
      console.info(`[settings] repaired the audio order the old setup wizard saved: now ${repaired.join(", ")}`);
      try {
        localStorage.setItem(AUDIO_ORDER_PENDING_KEY, JSON.stringify({ scope, from: previous, to: repaired }));
      } catch { /* the list is repaired; only the notice is lost */ }
      window.dispatchEvent(new Event(AUDIO_ORDER_REPAIRED_EVENT));
    }
  } catch (e) {
    console.warn("[settings] audio order check failed, retrying next launch:", e);
  } finally {
    running.delete(scope);
  }
}

/** Take the parked notice, if any (removed as it is read). */
export function takePendingAudioOrderNotice(): AudioOrderNoticeData | null {
  try {
    const raw = localStorage.getItem(AUDIO_ORDER_PENDING_KEY);
    if (raw === null) return null;
    localStorage.removeItem(AUDIO_ORDER_PENDING_KEY);
    return readAudioOrderNoticeData(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** The notice data, validated (it comes back from storage). */
export function readAudioOrderNoticeData(value: unknown): AudioOrderNoticeData | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const from = asAudioPriority(v.from);
  const to = asAudioPriority(v.to);
  if (typeof v.scope !== "string" || !v.scope || !from || !to) return null;
  return { kind: AUDIO_ORDER_DATA_KIND, scope: v.scope, from, to };
}

export type AudioOrderUndoResult = "restored" | "changed" | "unavailable";

/** Put back the list the repair replaced, through the normal settings write
 *  (its changed-keys event stamps and pushes it). Only for the account the
 *  repair ran for, once this session's pull has answered, and only while the
 *  list is still the repaired one: a list changed since (here, in Settings,
 *  or on another device) is left as it is. Rejects when the write fails. */
export async function undoAudioOrderRepair(data: AudioOrderNoticeData): Promise<AudioOrderUndoResult> {
  if (!settingsCloudSettled(data.scope)) return "unavailable";
  const settings = await invoke<Record<string, unknown>>("get_settings");
  if (!settingsCloudSettled(data.scope)) return "unavailable";
  if (!sameAudioPriority(settings.audio_priority, data.to)) return "changed";
  await patchBackendSettings({ audio_priority: data.from }, settings);
  window.dispatchEvent(new Event(AUDIO_ORDER_CHANGED_EVENT));
  return "restored";
}
