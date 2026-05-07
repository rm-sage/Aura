// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// updaterPlugin.ts ────────────────────────────────────────────────────────
//
// Thin wrapper around tauri-plugin-updater. Talks to the plugin via
// raw invoke() so we don't need to add @tauri-apps/plugin-updater as a
// frontend dep — the plugin's JS surface is a tiny set of named IPC
// calls and this matches the existing pattern Aura uses for every
// other Tauri command.
//
// All functions return null / false on any failure (network, missing
// pubkey, signature mismatch). They never throw — the caller fires
// from a useEffect / button handler and an unhandled rejection during
// boot would surface as red console noise on every Home visit.
//
// REQUIRED TO ACTUALLY WORK
// =========================
// 1. Generate a signing keypair on your dev machine:
//      pnpm tauri signer generate -- -w aura-updater.key
//    The command prints the public key. Copy it into
//    src-tauri/tauri.conf.json under `plugins.updater.pubkey`. Keep
//    aura-updater.key OFF the repo (it's the private half).
//
// 2. At release-build time, set the env vars:
//      $env:TAURI_SIGNING_PRIVATE_KEY = "<contents of aura-updater.key>"
//      $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<your password>"
//    Then run `pnpm tauri build`. The bundler signs the produced
//    installer + emits a sidecar `latest.json` manifest containing
//    the version, pub_date, signature, and platform-specific URLs.
//
// 3. Upload BOTH the installer (.msi / .exe) AND `latest.json` to
//    your GitHub release. The endpoint configured in tauri.conf.json
//    points at the latest release's `latest.json`, so the plugin
//    automatically picks up new versions.
//
// Until step 1 is done the calls below will resolve to null/false and
// log a one-line warning. The existing fallback updater.ts keeps
// working for "manual click → open browser" so users still get
// upgrade notifications, just without one-click install.

import { invoke } from "@tauri-apps/api/core";

/** Manifest the plugin returns when an update is available. */
export interface UpdateInfo {
  version:        string;
  currentVersion: string;
  date?:          string;
  body?:          string;
}

/** True when the configured public key in tauri.conf.json is the
 *  scaffold placeholder. The plugin will fail with a signature error
 *  in that case; we short-circuit so the UI shows a clean "updater
 *  not configured" rather than a cryptic plugin error. */
function pubkeyIsPlaceholder(): boolean {
  // The plugin's check() doesn't expose the configured pubkey to JS.
  // Best-effort: the placeholder string we ship in tauri.conf.json
  // is "REPLACE_WITH_PUBKEY_FROM_pnpm_tauri_signer_generate". A
  // real pubkey is base64 minisign output (~50 chars, ends with
  // "RWQ..."). We can't sniff it directly, so we let the plugin
  // try and catch the error. This helper is a placeholder for the
  // future where we expose the pubkey via a small command.
  return false;
}

/** Probe the configured update endpoint. Returns null when no update
 *  is available OR the plugin can't verify the manifest signature. */
export async function checkForUpdatePlugin(): Promise<UpdateInfo | null> {
  if (pubkeyIsPlaceholder()) return null;
  try {
    const result = await invoke<{
      version?:         string;
      currentVersion?:  string;
      date?:            string;
      body?:            string;
      available?:       boolean;
    } | null>("plugin:updater|check");
    if (!result || !result.available) return null;
    return {
      version:        String(result.version ?? ""),
      currentVersion: String(result.currentVersion ?? ""),
      date:           result.date ? String(result.date) : undefined,
      body:           result.body ? String(result.body) : undefined,
    };
  } catch (e) {
    console.warn(`[updater] check failed: ${String(e)}`);
    return null;
  }
}

/** Download + install the available update, then relaunch. Returns
 *  false on any failure. The plugin handles signature verification
 *  internally — a mismatched signature errors out before any disk
 *  write, so this is safe to call without additional checks. */
export async function downloadAndInstallUpdatePlugin(): Promise<boolean> {
  try {
    await invoke("plugin:updater|download_and_install");
    return true;
  } catch (e) {
    console.warn(`[updater] download_and_install failed: ${String(e)}`);
    return false;
  }
}
