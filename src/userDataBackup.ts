// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// userDataBackup — local snapshot ledger for non-Stremio-synced state.
//
// What this protects: the chunks of Aura's user data that live entirely
// in localStorage (not in Stremio's cloud library). Specifically:
//
//   • aura:manual-state:<scope>  — Queue + manual watched/in-progress marks.
//   • aura:skip-marks:<scope>    — which of those watched marks were SKIPS.
//     Snapshotted WITH manual-state on purpose: a skip is an annotation over a
//     watched mark, so restoring one without the other leaves either orphaned
//     purple tags on unwatched episodes or silently-watched episodes that were
//     actually skipped.
//   • aura:history:<historyScope> - local watch history log. NOTE the
//     different scope: history keys on the stable user_id, everything else
//     here on the auth_key prefix, so the payload carries both.
//   • aura:auto-bumped-series:v1 — auto-bumped flags (cross-scope).
//   • aura:settings:v1           — AuraSettings (cross-scope).
//
// What this DOESN'T protect: Stremio's cloud-synced library (datastoreGet
// / datastorePut), addon installs (also cloud), backend AppSettings
// (lives on disk under <app_data>/settings/<scope>.json — separately
// snapshotted via the Backup & Restore section in Settings, not here).
//
// ─── DANGER FOR FUTURE WORK ────────────────────────────────────────────
// Several past sessions reported "my Queue and local History menus get
// wiped" after `pnpm tauri dev` restarts. Diagnosis: scope-detection
// momentary mis-fires (auth read returns guest while user-<hash> data
// sits intact in storage), making data appear deleted while still on
// disk. The risk: a future code path adds a "clean restart" or "reset
// data" affordance that calls `localStorage.removeItem` /
// `localStorage.clear` directly, then DOES the wipe for real.
//
// IF YOU ARE ABOUT TO REMOVE OR OVERWRITE ANY OF THE KEYS LISTED ABOVE,
// CALL `createSnapshot("pre-cleanup")` FIRST. The auto-snapshot path
// fires on every change, but it debounces — a synchronous wipe before
// a debounce flush leaves no recovery point. Manual snapshot is one
// async invoke and gives the user a rollback in Settings → Backups.
// ───────────────────────────────────────────────────────────────────────
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { reloadManualWatchedFromStorage } from "./manualWatched";
import { reloadSkipMarksFromStorage } from "./skipMarks";
import { getHistoryScope, reloadHistoryFromStorage } from "./historyStore";

// Storage keys we snapshot. Keep in sync with manualWatched.ts /
// historyStore.ts / auraSettings.ts / autoBumped.ts.
const KEYS = {
  manualState:    "aura:manual-state:",        // suffix: scope
  skipMarks:      "aura:skip-marks:",          // suffix: scope
  history:        "aura:history:",             // suffix: scope
  autoBumped:     "aura:auto-bumped-series:v1",
  auraSettings:   "aura:settings:v1",
} as const;

const AUTO_DEBOUNCE_MS = 30_000;       // 30 s of inactivity before auto-snapshot
const AUTO_MAX_KEEP    = 10;           // rolling backup count per scope
const AUTO_REASON_KEY  = "auto-snapshot";
/** Fired when the active backup scope changes, so readers can re-derive. */
export const BACKUP_SCOPE_EVENT = "aura:backup-scope-changed";
const SCOPE_EVENT = BACKUP_SCOPE_EVENT;
/** True between startAutoBackup and the first resolved scope. */
let startupSnapshotPending = false;

// ---------------------------------------------------------------------------
// Backup payload shape
// ---------------------------------------------------------------------------

export interface BackupPayload {
  /** Schema version. Bump when adding required fields. */
  schemaVersion: number;
  /** Scope this snapshot belongs to. Addresses every key EXCEPT history. */
  scope: string;
  /** The scope `history` was read from, which is NOT `scope`.
   *
   *  History keys on the stable `user_id` (`user-<userId16>`) so a fresh login
   *  does not orphan the play log, while everything else here stays on the
   *  auth_key prefix (`user-<authKey12>`). Reusing `scope` for history read a
   *  key nothing writes, so for every signed-in user the snapshot captured
   *  NOTHING and a restore then removed the real log. Absent on v1 snapshots,
   *  which fall back to `scope` so they keep their original behaviour. */
  historyScope?: string;
  /** ISO timestamp for human display. */
  capturedAt: string;
  /** localStorage values verbatim — Aura's other modules know how to
   *  parse the raw strings, so we don't try to type them here. */
  values: {
    manualState:  string | null;
    skipMarks:    string | null;
    history:      string | null;
    autoBumped:   string | null;
    auraSettings: string | null;
  };
}

export interface BackupMeta {
  fileName: string;
  scope: string;
  createdAtMs: number;
  sizeBytes: number;
  reason: string;
}

// ---------------------------------------------------------------------------
// Snapshot capture / apply
// ---------------------------------------------------------------------------

/** Read every relevant localStorage entry for the given scope into a
 *  payload struct. Pass `null` keys through verbatim so absence vs.
 *  empty-string survives the round-trip. */
export function collectBackupPayload(scope: string): BackupPayload {
  const safeScope = (scope ?? "").trim() || "guest";
  // Ask the store, do not re-derive. See BackupPayload.historyScope.
  const hScope = getHistoryScope().trim() || safeScope;
  return {
    schemaVersion: 2,
    scope: safeScope,
    historyScope: hScope,
    capturedAt: new Date().toISOString(),
    values: {
      manualState:  localStorage.getItem(`${KEYS.manualState}${safeScope}`),
      skipMarks:    localStorage.getItem(`${KEYS.skipMarks}${safeScope}`),
      history:      localStorage.getItem(`${KEYS.history}${hScope}`),
      autoBumped:   localStorage.getItem(KEYS.autoBumped),
      auraSettings: localStorage.getItem(KEYS.auraSettings),
    },
  };
}

/** Restore a backup payload into localStorage. Writes ONLY to the keys
 *  named in the payload — anything else (e.g. device-specific flags)
 *  remains intact. After write, dispatches the same custom events the
 *  individual stores listen for so live-bound UI re-reads.
 *
 *  WARNING: this overwrites the user's current state. Callers MUST
 *  surface a confirmation prompt before invoking. */
export function applyBackupPayload(payload: BackupPayload): void {
  const safeScope = (payload.scope ?? "").trim() || "guest";
  // v1 snapshots have no historyScope; falling back to `scope` reproduces
  // exactly what they were written against, so an old snapshot restores where
  // it came from rather than being redirected to a key it never captured.
  const hScope = (payload.historyScope ?? "").trim() || safeScope;
  const v = payload.values ?? {} as BackupPayload["values"];

  const writeOrRemove = (key: string, value: string | null) => {
    if (value == null) {
      try { localStorage.removeItem(key); } catch {}
    } else {
      try { localStorage.setItem(key, value); } catch {}
    }
  };

  writeOrRemove(`${KEYS.manualState}${safeScope}`, v.manualState);
  writeOrRemove(`${KEYS.skipMarks}${safeScope}`, v.skipMarks ?? null);
  writeOrRemove(`${KEYS.history}${hScope}`,        v.history);
  writeOrRemove(KEYS.autoBumped,                   v.autoBumped);
  writeOrRemove(KEYS.auraSettings,                 v.auraSettings);

  // RELOAD the in-memory mirrors, do not merely re-render.
  //
  // manualWatched, skipMarks and historyStore each hydrate from localStorage
  // ONCE and short-circuit every read afterwards, so writing the keys above and
  // firing a change event only re-rendered components that then read the
  // PRE-RESTORE values. The restore appeared to do nothing until the app was
  // restarted, which is exactly what "Restored. Refresh views to see the
  // change." was trying and failing to describe. Each reload dispatches its own
  // change event, so the explicit ones below are only for the settings blob,
  // which has no mirror of its own.
  reloadManualWatchedFromStorage();
  reloadSkipMarksFromStorage();
  reloadHistoryFromStorage();
  window.dispatchEvent(new CustomEvent("aura:settings-changed"));
}

// ---------------------------------------------------------------------------
// Rust-bridged commands
// ---------------------------------------------------------------------------

/** Persist the current localStorage slice for `scope` to disk via the
 *  Rust backup ledger. Returns the resulting BackupMeta on success. */
export async function createSnapshot(
  reason: string,
  scope: string,
  maxKeep: number = AUTO_MAX_KEEP,
): Promise<BackupMeta | null> {
  try {
    const payload = collectBackupPayload(scope);
    const meta = await invoke<BackupMeta>("create_user_backup", {
      scope,
      reason,
      payload,
      maxKeep,
    });
    return meta;
  } catch (err) {
    // Best-effort: a backup-create failure must not block real work.
    console.warn("[backup] createSnapshot failed:", err);
    return null;
  }
}

/** Returns the full backup list across every scope unless `scope`
 *  narrows it. Newest-first. */
export async function listSnapshots(scope?: string): Promise<BackupMeta[]> {
  try {
    const list = await invoke<BackupMeta[]>("list_user_backups", { scope });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Read a snapshot's full body (BackupBody on the Rust side, JSON
 *  string from the wire). Parses the embedded payload and returns it
 *  ready to feed into `applyBackupPayload`. */
export async function readSnapshot(
  scope: string,
  fileName: string,
): Promise<BackupPayload | null> {
  try {
    const raw = await invoke<string>("read_user_backup", { scope, fileName });
    const parsed = JSON.parse(raw) as { payload: BackupPayload };
    return parsed?.payload ?? null;
  } catch (err) {
    console.warn("[backup] readSnapshot failed:", err);
    return null;
  }
}

export async function deleteSnapshot(
  scope: string,
  fileName: string,
): Promise<boolean> {
  try {
    await invoke("delete_user_backup", { scope, fileName });
    return true;
  } catch (err) {
    console.warn("[backup] deleteSnapshot failed:", err);
    return false;
  }
}

export async function backupStorageUsed(): Promise<number> {
  try {
    return await invoke<number>("user_backup_storage_used");
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Auto-snapshot scheduler
//
// Listens to every relevant change event and schedules a debounced
// snapshot. The first time an event fires after a quiet period, the
// timer arms; subsequent events within AUTO_DEBOUNCE_MS reset it.
// Trade-off: 30 s means a backup roughly captures every burst of
// activity rather than every individual change, keeping the backup
// directory's churn manageable while still giving the user a recent
// recovery point.
// ---------------------------------------------------------------------------

let autoSnapshotTimer: ReturnType<typeof setTimeout> | null = null;
let autoScopeSnapshot: string = "guest";
let autoEnabled = true;

function scheduleAutoSnapshot(): void {
  if (!autoEnabled) return;
  if (autoSnapshotTimer) clearTimeout(autoSnapshotTimer);
  autoSnapshotTimer = setTimeout(() => {
    autoSnapshotTimer = null;
    void createSnapshot(AUTO_REASON_KEY, autoScopeSnapshot);
  }, AUTO_DEBOUNCE_MS);
}

/** Initialise the auto-snapshot wiring. Subscribes to every store's
 *  change event so any user-data write triggers a debounced backup.
 *  Idempotent — call from App.tsx on mount. */
export function startAutoBackup(initialScope: string): () => void {
  autoScopeSnapshot = initialScope?.trim() || "guest";
  autoEnabled = true;
  const onChange = () => scheduleAutoSnapshot();
  window.addEventListener("aura:manual-watched-changed", onChange);
  window.addEventListener("aura:history-changed",        onChange);
  window.addEventListener("aura:settings-changed",       onChange);
  // The startup snapshot is DEFERRED to the first setAutoBackupScope call.
  //
  // It used to fire here, but App.tsx calls startAutoBackup("guest") before
  // the Stremio session has resolved, so every launch wrote a ~3 KB snapshot
  // of empty guest state. Those accumulated in the guest ledger, and since
  // each bucket keeps only the 10 most recent, the auto bucket filled with
  // useless startup entries while the real per-account snapshots sat in the
  // signed-in scope's directory. Waiting for the resolved scope also means the
  // snapshot captures real data instead of a pre-hydration blank.
  //
  // Guests still get one: App.tsx calls setAutoBackupScope on every session
  // outcome, "guest" included, so the deferral fires either way.
  startupSnapshotPending = true;
  return () => {
    autoEnabled = false;
    if (autoSnapshotTimer) {
      clearTimeout(autoSnapshotTimer);
      autoSnapshotTimer = null;
    }
    window.removeEventListener("aura:manual-watched-changed", onChange);
    window.removeEventListener("aura:history-changed",        onChange);
    window.removeEventListener("aura:settings-changed",       onChange);
  };
}

/** Update which scope the auto-snapshotter is targeting. Called from
 *  App.tsx whenever auth state flips so backups stamped while the
 *  user was signed-in land under their `user-<hash>` directory and
 *  guest-mode backups land under `guest`. */
export function setAutoBackupScope(scope: string | null): void {
  const next = scope?.trim() || "guest";
  const changed = next !== autoScopeSnapshot;
  autoScopeSnapshot = next;
  // Readers (the Settings panel) must re-derive: this is the moment the real
  // account scope becomes known, and it lands AFTER their first render.
  if (changed) window.dispatchEvent(new CustomEvent(SCOPE_EVENT));
  // Deferred startup snapshot, now that we know which account it belongs to.
  if (startupSnapshotPending && autoEnabled) {
    startupSnapshotPending = false;
    void createSnapshot("startup", autoScopeSnapshot);
  }
}

/** The scope snapshots are currently being WRITTEN under.
 *
 *  This is the only correct answer to "which scope is active", and every
 *  reader must use it. App.tsx derives it from the live auth_key and pushes it
 *  here via `setAutoBackupScope`, so it tracks account switches exactly as the
 *  writer does.
 *
 *  Do NOT re-derive it by scanning localStorage for an `aura:manual-state:`
 *  key. That was the previous approach in the Settings panel and it is wrong:
 *  every Stremio re-login rotates `auth_key`, so the prefix changes and the OLD
 *  `aura:manual-state:user-<hex>` entries are never removed. The scan returns
 *  whichever key enumeration reaches first, which in practice is the OLDEST
 *  scope, so the panel listed a stale directory and reported "0 auto" while
 *  snapshots were being written correctly to the real one. */
export function getActiveBackupScope(): string {
  return autoScopeSnapshot;
}
