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
import { flushHistoryNow } from "./historyStore";

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

/** The download + install running now. A second press joins it. */
let installInFlight: Promise<boolean> | null = null;

function infoOf(update: Update): UpdateInfo {
  return {
    version:        update.version,
    currentVersion: update.currentVersion,
    date:           update.date,
    body:           update.body,
  };
}

/** Probe the configured update endpoint via the plugin. Returns
 *  null when no update is available OR the plugin can't verify the
 *  manifest signature. During an install it answers with the update being
 *  installed: a null from a network blip would send the bell's second press
 *  to its browser fallback mid-download. */
export async function checkForUpdatePlugin(): Promise<UpdateInfo | null> {
  if (installInFlight && cachedUpdate) return infoOf(cachedUpdate);
  try {
    const update = await check();
    cachedUpdate = update;
    if (!update) return null;
    return infoOf(update);
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
 *  install. (We don't auto-rerun the check here: back-to-back network
 *  round-trips would add latency the user will notice.) */
export function downloadAndInstallUpdatePlugin(): Promise<boolean> {
  if (installInFlight) return installInFlight;
  // Captured once: download() records its bytes on the object it ran on, so
  // install() on any other one throws "called before download".
  const update = cachedUpdate;
  if (!update) {
    console.warn("[updater] download_and_install called without a prior successful check");
    return Promise.resolve(false);
  }
  installInFlight = runInstall(update).finally(() => { installInFlight = null; });
  return installInFlight;
}

async function runInstall(update: Update): Promise<boolean> {
  try {
    // install() ends in std::process::exit on Windows, without the window's
    // close path, so history_store.rs's exit flush never runs and a change
    // still inside its ~1.5 s write coalescing would be lost. Flush AFTER the
    // download and right before the install: flushing before the download
    // (one downloadAndInstall call) left the whole download, tens of seconds
    // with the UI usable from the notifications bell, for a play or a
    // History removal to land unsaved. flushHistoryNow never throws.
    await update.download();
    await flushHistoryNow();
    await update.install();
    return true;
  } catch (e) {
    console.warn(`[updater] download_and_install failed: ${String(e)}`);
    return false;
  }
}
