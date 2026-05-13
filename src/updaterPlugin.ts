// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// updaterPlugin.ts ────────────────────────────────────────────────────────
//
// Thin wrapper around `@tauri-apps/plugin-updater`. We delegate to the
// official JS package rather than calling the plugin IPC directly —
// the IPC's request/response shape isn't quite what you'd expect:
//   • `plugin:updater|check` returns `Metadata | null` on the wire
//     (the `available` boolean is a JS-side derived field on the
//     wrapper class, NOT in the raw response). A previous
//     hand-rolled invoke wrapper here checked `result.available`,
//     which was always `undefined`, so the wrapper always reported
//     "no update".
//   • `plugin:updater|download_and_install` needs the resource ID
//     returned by `check()` AND a progress Channel — neither of
//     which a bare `invoke(...)` would supply.
// The official package handles both correctly: it caches the `Update`
// resource between calls (so `update.downloadAndInstall()` knows
// which rid to pass) and wires up the Channel transparently.
//
// All functions still return null / false on any failure (network,
// missing pubkey, signature mismatch). They never throw — callers
// fire from useEffect / button handlers and an unhandled rejection
// during boot would surface as red console noise on every Home
// visit.

import { check, type Update } from "@tauri-apps/plugin-updater";

/** Shape the rest of Aura's UI consumes. Matches the prior export
 *  exactly so the App.tsx / UpdatePopup / SettingsView call sites
 *  don't need to know the package switched underneath them. */
export interface UpdateInfo {
  version:        string;
  currentVersion: string;
  date?:          string;
  body?:          string;
}

/** Holds the most recent `Update` resource returned by `check()`.
 *  `downloadAndInstallUpdatePlugin()` needs the same resource to
 *  download against — Tauri's plugin holds the manifest + signature
 *  bytes inside the resource and refuses to install from anything
 *  else. Cleared after a successful install (the app relaunches, so
 *  this rarely matters in practice) and after every fresh check
 *  (which produces a new resource). */
let cachedUpdate: Update | null = null;

/** Probe the configured update endpoint via the plugin. Returns
 *  null when no update is available OR the plugin can't verify the
 *  manifest signature. */
export async function checkForUpdatePlugin(): Promise<UpdateInfo | null> {
  try {
    const update = await check();
    cachedUpdate = update;
    if (!update) return null;
    return {
      version:        update.version,
      currentVersion: update.currentVersion,
      date:           update.date,
      body:           update.body,
    };
  } catch (e) {
    console.warn(`[updater] check failed: ${String(e)}`);
    cachedUpdate = null;
    return null;
  }
}

/** Download + install the available update, then relaunch. Returns
 *  false on any failure. Caller MUST run a successful
 *  `checkForUpdatePlugin()` first — the plugin needs the resource
 *  the check produced to know which manifest + signature to
 *  install. (We don't auto-rerun the check here: a stale result
 *  doesn't fail the install, but back-to-back network round-trips
 *  would add latency the user will notice.) */
export async function downloadAndInstallUpdatePlugin(): Promise<boolean> {
  if (!cachedUpdate) {
    console.warn("[updater] download_and_install called without a prior successful check");
    return false;
  }
  try {
    await cachedUpdate.downloadAndInstall();
    return true;
  } catch (e) {
    console.warn(`[updater] download_and_install failed: ${String(e)}`);
    return false;
  }
}
