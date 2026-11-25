// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The one write path for backend settings (Rust AppSettings) from the UI:
// Settings' controls and import, and the first-run setup. It round-trips the
// patch through update_settings and fires the events the rest of the app
// reads, so no caller can forget one (see "Settings sync" in
// .claude/rules/conventions.md).
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";

/** The backend settings snapshot as update_settings / get_settings return it.
 *  SettingsView keeps the typed mirror (BackendSettings); callers that only
 *  read a few fields can stay on this loose shape. */
export type AppSettingsLike = Record<string, unknown>;

/** Patch backend settings. Rejects when the patch is refused or cannot be
 *  saved (the caller decides whether that is worth reporting).
 *
 *  `before` is the snapshot the patch is diffed against, so
 *  `aura:backend-settings-changed` lists only keys whose value really changed
 *  (by value: arrays compare by content). A patch that changed nothing must
 *  not stamp and push over another device's edit. Pass the caller's own copy
 *  when it holds one, as a function when that copy is updated by earlier
 *  overlapping writes: it is then read AFTER this write lands, so a fast
 *  second patch is diffed against the first one's result and the last write
 *  that changed a value always sends its own event. `null` means "no
 *  snapshot" and counts every patched key as changed; leaving it out reads
 *  get_settings first (that read has to precede the write). */
export async function patchBackendSettings<T = AppSettingsLike>(
  patch: Record<string, unknown>,
  before?: Record<string, unknown> | null | (() => Record<string, unknown> | null),
): Promise<T> {
  const preRead = before === undefined
    ? await invoke<Record<string, unknown>>("get_settings").catch(() => null)
    : null;
  const updated = await invoke<T>("update_settings", { patch });
  const prior = before === undefined
    ? preRead
    : typeof before === "function" ? before() : before;
  // Against the state BEFORE the write (`updated` already holds the patch).
  const after = updated as unknown as Record<string, unknown>;
  const changedKeys = Object.keys(patch).filter(
    (k) => !prior || JSON.stringify(prior[k]) !== JSON.stringify(after[k]),
  );
  // Live-apply subtitle styling - when the user adjusts size/colour/etc.
  // we want the change to show up immediately in the active player
  // without waiting for the next stream load.
  if (Object.keys(patch).some((k) => k.startsWith("subtitle_"))) {
    invoke("apply_subtitle_style").catch(() => {});
  }
  // The title bar's close button changes behaviour with this one setting
  // (a click hides to tray, so it grows a hold-to-quit affordance), and it
  // reads the value itself rather than taking a prop. Nudge it so the
  // toggle applies immediately instead of on next launch.
  //
  // Deliberately narrow: `aura:settings-changed` also drives an AuraSkip
  // re-stamp and a sync-chip refresh, so firing it on EVERY backend patch
  // would cause pointless churn on unrelated settings.
  if ("minimize_to_tray_on_close" in patch) {
    window.dispatchEvent(new Event("aura:settings-changed"));
  }
  // The scrobble toggles get their own signal for the same reason the
  // above is narrow. `scrobbleConn` caches both of them in a module-level
  // snapshot that resolves once per session, and without this the cached
  // answer never changed: turning scrobbling off and then skipping a
  // filler run still pushed plays to AniList / Simkl.
  if ("scrobble_enabled" in patch || "auto_scrobble_enabled" in patch) {
    window.dispatchEvent(new Event("aura:scrobble-settings-changed"));
  }
  // The player's chord labels read the map themselves.
  if ("keybindings" in patch) {
    window.dispatchEvent(new CustomEvent("aura:keybindings-changed"));
  }
  // The narrow signal for every backend edit, with the keys it touched: sync
  // stamps and pushes on it, App and ThemeEngine re-read only for theirs. An
  // empty list is a no-op for every listener, so it is not sent.
  if (changedKeys.length > 0) {
    window.dispatchEvent(new CustomEvent("aura:backend-settings-changed", {
      detail: { keys: changedKeys },
    }));
  }
  return updated;
}
