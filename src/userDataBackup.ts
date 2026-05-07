// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// userDataBackup — local snapshot ledger for non-Stremio-synced state.
//
// What this protects: the chunks of Aura's user data that live entirely
// in localStorage (not in Stremio's cloud library). Specifically:
//
//   • aura:manual-state:<scope>  — Queue + manual watched/in-progress marks.
//   • aura:history:<scope>       — local watch history log.
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

// Storage keys we snapshot. Keep in sync with manualWatched.ts /
// historyStore.ts / auraSettings.ts / autoBumped.ts.
const KEYS = {
  manualState:    "aura:manual-state:",        // suffix: scope
  history:        "aura:history:",             // suffix: scope
  autoBumped:     "aura:auto-bumped-series:v1",
  auraSettings:   "aura:settings:v1",
} as const;

const AUTO_DEBOUNCE_MS = 30_000;       // 30 s of inactivity before auto-snapshot
const AUTO_MAX_KEEP    = 10;           // rolling backup count per scope
const AUTO_REASON_KEY  = "auto-snapshot";

// ---------------------------------------------------------------------------
// Backup payload shape
// ---------------------------------------------------------------------------

export interface BackupPayload {
  /** Schema version. Bump when adding required fields. */
  schemaVersion: number;
  /** Scope this snapshot belongs to. */
  scope: string;
  /** ISO timestamp for human display. */
  capturedAt: string;
  /** localStorage values verbatim — Aura's other modules know how to
   *  parse the raw strings, so we don't try to type them here. */
  values: {
    manualState:  string | null;
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
  return {
    schemaVersion: 1,
    scope: safeScope,
    capturedAt: new Date().toISOString(),
    values: {
      manualState:  localStorage.getItem(`${KEYS.manualState}${safeScope}`),
      history:      localStorage.getItem(`${KEYS.history}${safeScope}`),
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
  const v = payload.values ?? {} as BackupPayload["values"];

  const writeOrRemove = (key: string, value: string | null) => {
    if (value == null) {
      try { localStorage.removeItem(key); } catch {}
    } else {
      try { localStorage.setItem(key, value); } catch {}
    }
  };

  writeOrRemove(`${KEYS.manualState}${safeScope}`, v.manualState);
  writeOrRemove(`${KEYS.history}${safeScope}`,     v.history);
  writeOrRemove(KEYS.autoBumped,                   v.autoBumped);
  writeOrRemove(KEYS.auraSettings,                 v.auraSettings);

  // Re-fire the change events so subscribed components re-hydrate from
  // the freshly-restored values without a manual refresh.
  window.dispatchEvent(new CustomEvent("aura:manual-watched-changed"));
  window.dispatchEvent(new CustomEvent("aura:history-changed"));
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
  // Take an initial snapshot at startup so even read-only sessions
  // capture the current state at least once. Best-effort fire-and-
  // forget; users on disk-quota-exhausted machines can disable
  // backups in Settings if needed.
  void createSnapshot("startup", autoScopeSnapshot);
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
  autoScopeSnapshot = scope?.trim() || "guest";
}
