// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// settingsTransfer.ts ──────────────────────────────────────────────────────
//
// Import / export of Aura settings as a portable blob — file download, file
// upload, OR a base64 string that pastes cleanly into any messenger.
//
// SCOPE
//   Only addon-INDEPENDENT settings round-trip. Anything that names a
//   specific addon URL (catalog / stream / search provider lists, the
//   scrobble addon URL, the meta provider override) is excluded — those
//   are environment-specific and would point at addons that may not exist
//   on the importing machine. The user explicitly asked for this split
//   ("things like catalog/stream providers shouldn't be affected").
//
// SHAPE
//   {
//     version: 1,                 // schema version; bump when adding fields
//     exportedAt: "<ISO-8601>",   // diagnostic only; never used for merge
//     backend: { ... },           // subset of BackendSettings
//     aura:    { ... }            // currently empty; aura settings are
//                                 // all addon-URL-keyed (excluded above)
//   }
//
// IMPORT MERGE STRATEGY
//   For each portable backend field present in the blob, overwrite the
//   current value via patchBackend. Unknown fields (forward-compat from
//   future versions) are silently dropped. Missing fields keep their
//   current value. There's no "reset to defaults" mode — that would be
//   a separate action.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

/** Backend fields safe to round-trip across installs. Anything keyed by
 *  addon URL (scrobble_addon_url) is intentionally absent. */
const PORTABLE_BACKEND_FIELDS = [
  "theme",
  "subtitle_language",
  "selectable_subtitle_languages",
  "audio_priority",
  "avoid_dubs",
  "user_region",
  "subtitle_font_size",
  "subtitle_position",
  "subtitle_border_size",
  "subtitle_color",
  "subtitle_back_color",
  "subtitle_font",
  "discord_rpc_enabled",
  "discord_rpc_show_titles",
  "discord_rpc_blocked_titles",
  "discord_rpc_browse_states",
  "pause_on_minimize",
  "pause_on_lost_focus",
  "close_on_exit",
  "minimize_to_tray_on_close",
  "opensubtitles_api_key",
  "omdb_api_key",
  "hdr_enabled",
  "hdr_mode",
  "next_up_lead_seconds",
  "audio_passthrough",
  "keybindings",
  "skip_op_mode",
  "skip_ed_mode",
  "skip_recap_mode",
  "skip_treat_mixed_op_as_op",
  "gpu_acceleration",
] as const;

export type PortableBackendField = typeof PORTABLE_BACKEND_FIELDS[number];

/** Aura-side fields safe to round-trip across installs (all addon-URL-
 *  independent). hideCastSpoilers + showAioStreamsNotices are per-user
 *  preferences, not tied to any addon, so they're appropriate for the
 *  portable blob. */
const PORTABLE_AURA_FIELDS = [
  "hideCastSpoilers",
  "showAioStreamsNotices",
  "blurUnwatchedThumbnails",
] as const;
export type PortableAuraField = typeof PORTABLE_AURA_FIELDS[number];

export interface SettingsBlob {
  version: number;
  exportedAt: string;
  backend: Partial<Record<PortableBackendField, unknown>>;
  /** Addon-independent Aura-side settings (localStorage). Only fields
   *  in PORTABLE_AURA_FIELDS are round-tripped. */
  aura: Partial<Record<PortableAuraField, unknown>>;
}

/** Strip a backend snapshot down to the portable subset. Anything not in
 *  PORTABLE_BACKEND_FIELDS — e.g. scrobble_addon_url — is dropped. */
export function buildExportBlob(
  backend: Record<string, unknown>,
  aura: Record<string, unknown> = {},
): SettingsBlob {
  const portable: Partial<Record<PortableBackendField, unknown>> = {};
  for (const key of PORTABLE_BACKEND_FIELDS) {
    if (key in backend) portable[key] = backend[key];
  }
  const auraPortable: Partial<Record<PortableAuraField, unknown>> = {};
  for (const key of PORTABLE_AURA_FIELDS) {
    if (key in aura) auraPortable[key] = aura[key];
  }
  return {
    version:    SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    backend:    portable,
    aura:       auraPortable,
  };
}

/** Pretty-printed JSON for the file download / textarea. Indent=2 keeps
 *  the file human-diffable when checked into a dotfiles repo. */
export function blobToJsonString(blob: SettingsBlob): string {
  return JSON.stringify(blob, null, 2);
}

/** Base64-encoded compact JSON for the "paste a long string anywhere"
 *  share path. We base64 the whole JSON rather than emit raw JSON
 *  because some chat apps mangle quotes / brackets in raw text. */
export function blobToBase64(blob: SettingsBlob): string {
  const json = JSON.stringify(blob);
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Accepts either pretty JSON or our base64 wrapper. Whichever the user
 *  pastes, we decode and validate. Returns null on any failure (invalid
 *  base64, malformed JSON, missing required keys, wrong version) — the
 *  caller surfaces a generic "couldn't read settings" toast rather than
 *  a stack trace.
 *
 *  Forward compatibility: a blob with a higher version is accepted as
 *  long as the fields we care about are present and well-typed. We
 *  strip anything we don't recognise. */
export function parseImportInput(raw: string): SettingsBlob | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try JSON first (raw export-as-file shape). If that fails, try base64.
  let parsed: unknown = null;
  if (trimmed.startsWith("{")) {
    try { parsed = JSON.parse(trimmed); } catch { return null; }
  } else {
    try {
      const bin = atob(trimmed);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const json = new TextDecoder().decode(bytes);
      parsed = JSON.parse(json);
    } catch { return null; }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : -1;
  if (version < 1) return null;

  const backendRaw = obj.backend && typeof obj.backend === "object"
    ? obj.backend as Record<string, unknown>
    : {};
  // Whitelist filter — drop any field not in our portable set so a
  // malicious / forward-compat blob can't smuggle in addon-URL fields.
  const backend: Partial<Record<PortableBackendField, unknown>> = {};
  for (const key of PORTABLE_BACKEND_FIELDS) {
    if (key in backendRaw) backend[key] = backendRaw[key];
  }

  const auraRaw = obj.aura && typeof obj.aura === "object"
    ? obj.aura as Record<string, unknown>
    : {};
  const aura: Partial<Record<PortableAuraField, unknown>> = {};
  for (const key of PORTABLE_AURA_FIELDS) {
    if (key in auraRaw) aura[key] = auraRaw[key];
  }

  return {
    version:    SCHEMA_VERSION,
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
    backend,
    aura,
  };
}

/** Trigger a browser download of a JSON file containing the blob. Uses a
 *  blob URL; works inside the Tauri webview without needing the dialog
 *  plugin. Filename includes the export timestamp so multiple exports
 *  don't clobber each other in the user's Downloads folder. */
export function downloadBlobAsFile(blob: SettingsBlob): void {
  const json = blobToJsonString(blob);
  const file = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(file);
  const stamp = blob.exportedAt.replace(/[:.]/g, "-").slice(0, 19);
  const a = document.createElement("a");
  a.href = url;
  a.download = `aura-settings-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revocation so Chrome has time to start the download — the
  // navigation kicks off async; revoking immediately can race the start.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a user-picked file via FileReader. Returns the string contents
 *  (whatever the file actually held — JSON or base64) for the parser
 *  to figure out. Rejects on read errors. */
export function readImportFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(typeof r.result === "string" ? r.result : "");
    r.onerror = () => reject(r.error ?? new Error("file read failed"));
    r.readAsText(file);
  });
}
