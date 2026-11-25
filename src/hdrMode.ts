// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// HDR mode: the one write path and the device-local decisions around it.
//
// Every writer of `hdr_mode` (the Settings row, the setup wizard, the bell
// offer's "Turn on", the Off migration, the new-device default) goes through
// setHdrMode, so the three things a mode change needs always happen together:
//   1. the backend write (patchBackendSettings: persists, and dispatches
//      `aura:backend-settings-changed` with the keys that really changed),
//   2. apply_hdr_settings (pushes the mpv option set and re-applies the MPO
//      poison; passthrough only reaches an HDR-hinted load, see lib.rs),
//   3. HDR_MODE_CHANGED_EVENT, so a page holding its own copy (Settings) and
//      the bell offer can follow a change made somewhere else.
//
// The HDR settings are MACHINE-LOCAL: they describe the display, not the
// account. Rust keeps them in render.json beside gpu_acceleration, sync.ts
// strips and pins them (MACHINE_LOCAL_BACKEND_KEYS) and settings export leaves
// them out. So the flags below live in localStorage, per device, too.
//
// Stored values: "sdr" (Convert HDR to fit this screen, tone-mapping, the
// Rust default), "passthrough" (Send HDR to my HDR display) and the legacy
// "off" (no tone-mapping: HDR highlights clip). `hdr_enabled` is kept in
// lockstep ("off" = false) for the old readers.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { patchBackendSettings, type AppSettingsLike } from "./backendSettings";

export type HdrMode = "sdr" | "passthrough" | "off";

/** What `get_display_hdr_info` reports for the display Aura's main window is
 *  on. `detected` false = the probe failed (or this is not Windows), so
 *  `supported` / `enabled` mean nothing. */
export interface DisplayHdrInfo { detected: boolean; supported: boolean; enabled: boolean }

const UNKNOWN_DISPLAY: DisplayHdrInfo = { detected: false, supported: false, enabled: false };

/** Fired on window after every setHdrMode write lands. Detail `{ mode }`. */
export const HDR_MODE_CHANGED_EVENT = "aura:hdr-mode-changed";

/** The bell offer's id. Device-local: sync.ts keeps it out of the cloud
 *  notifications blob (another device may have no HDR display at all). */
export const HDR_OFFER_NOTICE_ID = "notice:hdr-passthrough-offer";
/** `data.kind` of the offer, which NotificationsPanel gives a "Turn on". */
export const HDR_OFFER_DATA_KIND = "hdr-passthrough-offer";

/** Set once the one-time "Send HDR?" offer was raised, or once this device
 *  no longer needs it (a choice made by hand, the first-run default). */
const OFFER_ASKED_KEY = "aura:hdr-offer-asked:v1";
/** Set once the first-run default for this device was decided (or the user
 *  picked a mode by hand, which outranks any default). */
const DEFAULT_DECIDED_KEY = "aura:hdr-default-decided:v1";

function readFlag(key: string): boolean {
  try { return localStorage.getItem(key) === "1"; } catch { return false; }
}

function writeFlag(key: string): void {
  try { localStorage.setItem(key, "1"); } catch { /* best effort */ }
}

export function hdrOfferAsked(): boolean { return readFlag(OFFER_ASKED_KEY); }
export function markHdrOfferAsked(): void { writeFlag(OFFER_ASKED_KEY); }

/** The stored mode, from a get_settings / update_settings snapshot. A
 *  snapshot with no usable `hdr_mode` falls back to the legacy boolean. */
export function hdrModeOf(s: AppSettingsLike | null | undefined): HdrMode {
  const raw = typeof s?.hdr_mode === "string" ? s.hdr_mode.trim().toLowerCase() : "";
  if (raw === "sdr" || raw === "passthrough" || raw === "off") return raw;
  return s?.hdr_enabled === false ? "off" : "sdr";
}

/** HDR is supported AND on in Windows for the display the window is on. */
export function displayReadyForHdr(info: DisplayHdrInfo | null): boolean {
  return !!info && info.detected && info.supported && info.enabled;
}

/** The mode the Recommended tag goes on: Send HDR when the display is ready
 *  for it, Convert otherwise (an unknown probe included). Null while the
 *  probe has not answered, so the tag never jumps from one to the other. */
export function recommendedHdrMode(info: DisplayHdrInfo | null): HdrMode | null {
  if (info == null) return null;
  return displayReadyForHdr(info) ? "passthrough" : "sdr";
}

/** Ask Windows about the window's display. Never rejects. */
export function probeDisplayHdr(): Promise<DisplayHdrInfo> {
  return invoke<DisplayHdrInfo>("get_display_hdr_info").catch(() => UNKNOWN_DISPLAY);
}

type Before = Record<string, unknown> | null | (() => Record<string, unknown> | null);

/** Write the HDR mode and apply it. `byUser` marks a choice the user made by
 *  hand: nothing automatic (the new-device default, the bell offer) may
 *  second-guess it afterwards. `before` is passed through to
 *  patchBackendSettings (see there). Rejects when the write is refused. */
export async function setHdrMode<T = AppSettingsLike>(
  mode: HdrMode,
  opts: { before?: Before; byUser?: boolean } = {},
): Promise<T> {
  if (opts.byUser) {
    writeFlag(DEFAULT_DECIDED_KEY);
    writeFlag(OFFER_ASKED_KEY);
  }
  const updated = await patchBackendSettings<T>(
    { hdr_mode: mode, hdr_enabled: mode !== "off" },
    opts.before,
  );
  await applyStoredHdrMode(mode);
  return updated;
}

/** Steps 2 and 3 of a mode change, for a write that already landed some
 *  other way (Settings' "Reset all settings", whose reset_settings rewrites
 *  this machine's HDR fields to the defaults): push the mode to the player
 *  and announce it. Best effort: the mode is saved either way and the next
 *  load applies it. */
export async function applyStoredHdrMode(mode: HdrMode): Promise<void> {
  await invoke("apply_hdr_settings", { mode }).catch(() => {});
  window.dispatchEvent(new CustomEvent(HDR_MODE_CHANGED_EVENT, { detail: { mode } }));
}

/** Write the Send HDR peak brightness and re-push the active mode's option
 *  set, so the new target-peak reaches the running player at once. */
export async function setHdrPeakNits<T = AppSettingsLike>(nits: number, before?: Before): Promise<T> {
  const updated = await patchBackendSettings<T>({ hdr_target_peak_nits: nits }, before);
  const mode = hdrModeOf(updated as unknown as AppSettingsLike);
  await invoke("apply_hdr_settings", { mode }).catch(() => {});
  return updated;
}

// ---------------------------------------------------------------------------
// Device-local decisions
// ---------------------------------------------------------------------------

let defaultDecision: Promise<void> | null = null;

/** First run on this device (the setup wizard's "first-run" mode, which a new
 *  device of an existing account also gets, since the completion flag is
 *  device-local): default the HDR mode to the recommended one. Only moves the
 *  untouched default ("sdr") to "passthrough" on a display that has HDR on
 *  in Windows, and never after a choice made by hand. Once the probe has
 *  answered, the decision is recorded and the one-time bell offer is spent:
 *  a first-run user got the recommendation as the default.
 *
 *  An unknown probe (the DisplayConfig query failed) decides NOTHING and
 *  sets no flag: "sdr" stays, and because the offer flag is not spent either,
 *  the bell offer can still reach this device later once Windows answers.
 *  That is the only way a device whose default could not be decided ever
 *  hears about Send HDR, and the offer never overrides a choice either.
 *
 *  The retired "off" counts as untouched too (no new user can pick it; it is
 *  what an old install or a split dev/production data dir leaves behind), so
 *  a device still on it also gets the recommendation instead of spending the
 *  flags on a mode the Off migration is about to move to Convert.
 *
 *  Ordered against the Off migration so the two never read the same "off"
 *  and both write: a migration already scheduled when this starts is awaited
 *  first, and one scheduled later awaits this (scheduleHdrOffMigration
 *  captures it). Each side only waits on the one that existed before it, so
 *  they cannot wait on each other.
 *
 *  Idempotent and shared: the bell offer awaits pendingHdrDecisions() so the
 *  two can never both act. */
export function decideHdrDefaultForNewDevice(): Promise<void> {
  if (!defaultDecision) {
    // Captured synchronously, before defaultDecision is assigned.
    const migrationBefore = offMigration;
    defaultDecision = (async () => {
      if (readFlag(DEFAULT_DECIDED_KEY)) return;
      const info = await probeDisplayHdr();
      if (!info.detected) return;
      if (migrationBefore) await migrationBefore;
      const settings = await invoke<AppSettingsLike>("get_settings").catch(() => null);
      if (!settings) return;
      // Re-checked after the awaits: a pick made meanwhile wins.
      if (readFlag(DEFAULT_DECIDED_KEY)) return;
      writeFlag(DEFAULT_DECIDED_KEY);
      writeFlag(OFFER_ASKED_KEY);
      const stored = hdrModeOf(settings);
      if (stored === "sdr" || stored === "off") {
        const next: HdrMode = displayReadyForHdr(info) ? "passthrough" : "sdr";
        if (next !== stored) await setHdrMode(next, { before: settings });
      }
    })().catch((e) => {
      console.warn(`[hdr] new-device default failed: ${String(e)}`);
    });
  }
  return defaultDecision;
}

let offMigration: Promise<void> | null = null;

/** The device-local HDR decisions in flight this session (the new-device
 *  default, the Off migration), settled. The bell offer waits on them so it
 *  never acts on a mode one of them is about to change. */
export function pendingHdrDecisions(): Promise<void> {
  return Promise.all([defaultDecision, offMigration]).then(() => undefined);
}

/** Run migrateHdrOffToConvert once `after` settles (App passes the settings
 *  scope's first cloud pull, so the pull's write cannot land over it). The
 *  promise is recorded at once, so pendingHdrDecisions covers the wait. A
 *  new-device default already in flight is waited on too (it handles "off"
 *  itself), captured now so the two never wait on each other. */
export function scheduleHdrOffMigration(after: Promise<unknown>): void {
  const decisionBefore = defaultDecision;
  offMigration = after
    .catch(() => undefined)
    .then(() => decisionBefore ?? undefined)
    .then(() => migrateHdrOffToConvert());
}

/** "Off" is retired: move a device still on it to Convert, once per load of
 *  the settings scope (it is a no-op on any other mode, so no flag needed).
 *
 *  Why there is no serious downside: for SDR videos Off and Convert look the
 *  same. For HDR videos Off hard-clips everything above SDR white (no peak
 *  measurement, tone-mapping=clip) while Convert rolls the highlights off, and
 *  Off never outputs real HDR, even on an HDR display. Its only saving is the
 *  per-frame peak measurement, which is negligible. Not a hand-made choice
 *  (byUser false), so the bell offer can still follow on an HDR display. */
export async function migrateHdrOffToConvert(): Promise<void> {
  const settings = await invoke<AppSettingsLike>("get_settings").catch(() => null);
  if (!settings || hdrModeOf(settings) !== "off") return;
  try {
    await setHdrMode("sdr", { before: settings });
  } catch (e) {
    console.warn(`[hdr] Off to Convert migration failed: ${String(e)}`);
  }
}
