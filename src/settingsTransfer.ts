// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// settingsTransfer.ts ──────────────────────────────────────────────────────
//
// Import / export of Aura settings as a portable blob — file download, file
// upload, OR a base64 string that pastes cleanly into any messenger.
//
// SCOPE
//   Three buckets:
//     1. backend  — addon-independent BackendSettings (theme, RPC, audio,
//                   subtitles, keybindings, opensubtitles_api_key, …)
//     2. aura     — addon-independent localStorage prefs (spoiler toggles,
//                   auto-advance, motion/interpolation, meta-panel activation,
//                   next-up skip, etc. — see PORTABLE_AURA_FIELDS)
//     3. providers — addon-DEPENDENT prefs encoded by manifest_id INSTEAD
//                    of URL. On import, each id is resolved against the
//                    importing user's installed addons; ids that don't
//                    match an installed addon are silently dropped (the
//                    user can install the missing addon then re-import).
//                    Covers the home / metadata / stream / search
//                    provider lists AND the hero carousel source. This
//                    lets a user who has e.g. AIOMetadata installed on
//                    both machines round-trip their preferred provider
//                    ordering without leaking machine-specific URLs.
//
// SHAPE (v2)
//   {
//     version: 2,                 // bumped from 1 when providers added
//     exportedAt: "<ISO-8601>",
//     backend:   { ... },         // unchanged
//     aura:      { ... },         // unchanged
//     providers: {                // NEW — id-keyed, addon-dependent
//       defaultHomeAddonId:        string | null,
//       additionalHomeAddonIds:    string[],
//       defaultMetadataAddonId:    string | null,
//       streamAddonIds:            string[] | null,
//       searchAddonIds:            string[] | null,
//       heroCatalog: { addonId, mediaType, catalogId } | null
//     }
//   }
//
// IMPORT MERGE STRATEGY
//   - backend / aura: shallow-overwrite by field. Unknown fields dropped.
//   - providers: each id resolved to the installed addon's URL via
//     manifest_id match; unresolvable ids dropped from the imported list
//     (preserving the relative order of the resolvable ones).
//
// V1 BLOBS still parse — providers block is missing, so providers stay
// at their current values on the importing side. No-op forward-compat.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 2;

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
  "subtitle_brightness",
  "discord_rpc_enabled",
  "discord_rpc_show_titles",
  "discord_rpc_blocked_titles",
  "discord_rpc_browse_states",
  "close_on_exit",
  "minimize_to_tray_on_close",
  "opensubtitles_api_key",
  // Not a settings.json field: it lives in the OS keyring, and SettingsView
  // hydrates it into the export blob (and strips it back out on import) exactly
  // like the OpenSubtitles key. It has to be listed here anyway, because the
  // exporter FILTERS the blob down to this list and would otherwise drop it.
  "tmdb_api_key",
  "hdr_enabled",
  "hdr_mode",
  "hdr_target_peak_nits",
  "next_up_lead_seconds",
  "audio_passthrough",
  "loudness_normalization",
  "keybindings",
  "skip_op_mode",
  "skip_ed_mode",
  "skip_recap_mode",
  "skip_treat_mixed_op_as_op",
  "trailer_quality",
  "gpu_acceleration",
  "cache_secs",
  "demuxer_readahead_secs",
  "demuxer_max_mib",
  "scrobble_enabled",
  "auto_scrobble_enabled",
] as const;

export type PortableBackendField = typeof PORTABLE_BACKEND_FIELDS[number];

/** Aura-side (localStorage) fields safe to round-trip across installs — every
 *  addon-URL-INDEPENDENT user preference. The addon-DEPENDENT fields
 *  (defaultHomeAddonUrl, streamAddonUrls, heroCatalog, …) are NOT here; they
 *  ride the `providers` block keyed by manifest_id instead. Keep this list in
 *  sync with AuraSettings: any new addon-independent preference belongs here so
 *  export/import stays complete. The importer re-validates every value through
 *  `readFromStorage`, so a malformed imported field can't corrupt state. */
const PORTABLE_AURA_FIELDS = [
  "hideCastSpoilers",
  "blurUnwatchedThumbnails",
  "blurEpisodeSynopsis",
  "blurThemeEpisodeRanges",
  "blurCharacterArt",
  "arcAwareArt",
  "reduceMotion",
  "autoAdvanceNextEpisode",
  "autoAdvanceDelaySeconds",
  "seekStepSeconds",
  "stillWatchingGate",
  "autoSkipDetect",
  "nextUpSkipFillerRecap",
  "loudnessNormalization",
  "motionInterpolation",
  "interpolationTscale",
  "releaseSearchEnabled",
  "metaPanelActivation",
  "metaPanelBindButton",
  "openLinksExternally",
  "queueRemoveSeriesInProgress",
  "useAuraStreamFormatter",
  "heroDisabled",
  "libraryAutoRemoveWatchedMovies",
  "libraryAutoRemoveWatchedSeries",
  "airingTileSize",
] as const;
export type PortableAuraField = typeof PORTABLE_AURA_FIELDS[number];

/** Provider lists encoded by addon manifest_id (NOT url). On import,
 *  each id is resolved against the importing user's installed addon
 *  list; ids that don't match an installed manifest_id are dropped
 *  with a warning. This lets the same Stremio user round-trip "I want
 *  AIOMetadata first then Cinemeta" between machines without each
 *  machine needing the same hostname / port for the addon. */
export interface PortableProvidersBlob {
  defaultHomeAddonId:        string | null;
  additionalHomeAddonIds:    string[];
  defaultMetadataAddonId:    string | null;
  streamAddonIds:            string[] | null;
  searchAddonIds:            string[] | null;
  heroCatalog:               { addonId: string; mediaType: string; catalogId: string } | null;
}

export interface SettingsBlob {
  version: number;
  exportedAt: string;
  backend: Partial<Record<PortableBackendField, unknown>>;
  /** Addon-independent Aura-side settings (localStorage). Only fields
   *  in PORTABLE_AURA_FIELDS are round-tripped. */
  aura: Partial<Record<PortableAuraField, unknown>>;
  /** Addon-DEPENDENT prefs encoded by manifest_id. v1 blobs lack this
   *  block; the importer treats absence as "leave provider lists alone". */
  providers?: PortableProvidersBlob;
}

/** Minimal AddonEntry shape needed for URL ↔ manifest_id resolution.
 *  Decoupled from the full type so this module stays import-light. */
interface AddonRef {
  url: string;
  manifest_id: string;
}

/** URL → manifest_id (or `null` when the url isn't installed). */
function urlToId(url: string | null, addons: AddonRef[]): string | null {
  if (!url) return null;
  const match = addons.find((a) => a.url === url);
  return match?.manifest_id || null;
}

/** Build the providers block by resolving every URL field to its
 *  manifest_id. URLs that don't match an installed addon (e.g. the
 *  user removed it after picking it as default) drop to null. */
function buildProvidersBlob(
  aura: Record<string, unknown>,
  addons: AddonRef[],
): PortableProvidersBlob {
  const ids = (urls: unknown): string[] | null => {
    if (urls == null) return null;
    if (!Array.isArray(urls)) return null;
    const out: string[] = [];
    for (const u of urls) {
      if (typeof u !== "string") continue;
      const id = urlToId(u, addons);
      if (id) out.push(id);
    }
    return out;
  };

  let heroCatalog: PortableProvidersBlob["heroCatalog"] = null;
  const hc = aura.heroCatalog as { addonUrl: string; mediaType: string; catalogId: string } | null | undefined;
  if (hc && typeof hc === "object" && hc.addonUrl && hc.mediaType && hc.catalogId) {
    const addonId = urlToId(hc.addonUrl, addons);
    if (addonId) {
      heroCatalog = { addonId, mediaType: hc.mediaType, catalogId: hc.catalogId };
    }
  }

  return {
    defaultHomeAddonId:       urlToId(aura.defaultHomeAddonUrl as string | null, addons),
    additionalHomeAddonIds:   ids(aura.additionalHomeAddonUrls) ?? [],
    defaultMetadataAddonId:   urlToId(aura.defaultMetadataAddonUrl as string | null, addons),
    streamAddonIds:           ids(aura.streamAddonUrls),
    searchAddonIds:           ids(aura.searchAddonUrls),
    heroCatalog,
  };
}

/** Strip a backend snapshot down to the portable subset. Anything not in
 *  PORTABLE_BACKEND_FIELDS — e.g. scrobble_addon_url — is dropped. */
export function buildExportBlob(
  backend: Record<string, unknown>,
  aura: Record<string, unknown> = {},
  addons: AddonRef[] = [],
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
    providers:  buildProvidersBlob(aura, addons),
  };
}

/** Resolved import patch ready for direct apply. URLs have already been
 *  matched against the importing user's installed addons; ids that
 *  didn't resolve are dropped from the lists. Caller hands `aura` and
 *  `backend` to its respective updaters (setLocal / patchBackend). */
export interface ResolvedImport {
  backend: Partial<Record<PortableBackendField, unknown>>;
  aura: Record<string, unknown>;
  /** Diagnostic — counts of provider ids that didn't match an installed
   *  addon. Surfaces as a toast so the user knows why a partial import
   *  happened. */
  unresolvedCount: number;
}

/** id → url (or null). Inverse of `urlToId`. */
function idToUrl(id: string | null, addons: AddonRef[]): string | null {
  if (!id) return null;
  const match = addons.find((a) => a.manifest_id === id);
  return match?.url || null;
}

/** Apply the providers block to the importing user's addon list.
 *  Returns an aura-shape patch with URLs resolved + a count of ids
 *  that couldn't be matched. */
export function resolveProviders(
  providers: PortableProvidersBlob | undefined,
  addons: AddonRef[],
): { aura: Record<string, unknown>; unresolved: number } {
  if (!providers) return { aura: {}, unresolved: 0 };
  let unresolved = 0;
  const resolveList = (ids: string[] | null): string[] | null => {
    if (ids == null) return null;
    const out: string[] = [];
    for (const id of ids) {
      const url = idToUrl(id, addons);
      if (url) out.push(url);
      else unresolved += 1;
    }
    return out;
  };

  const aura: Record<string, unknown> = {};
  if (providers.defaultHomeAddonId !== undefined) {
    const url = idToUrl(providers.defaultHomeAddonId, addons);
    if (url) aura.defaultHomeAddonUrl = url;
    else if (providers.defaultHomeAddonId) unresolved += 1;
  }
  if (providers.additionalHomeAddonIds) {
    aura.additionalHomeAddonUrls = resolveList(providers.additionalHomeAddonIds) ?? [];
  }
  if (providers.defaultMetadataAddonId !== undefined) {
    const url = idToUrl(providers.defaultMetadataAddonId, addons);
    if (url) aura.defaultMetadataAddonUrl = url;
    else if (providers.defaultMetadataAddonId) unresolved += 1;
  }
  if (providers.streamAddonIds !== undefined) {
    aura.streamAddonUrls = resolveList(providers.streamAddonIds);
  }
  if (providers.searchAddonIds !== undefined) {
    aura.searchAddonUrls = resolveList(providers.searchAddonIds);
  }
  if (providers.heroCatalog) {
    const url = idToUrl(providers.heroCatalog.addonId, addons);
    if (url) {
      aura.heroCatalog = {
        addonUrl: url,
        mediaType: providers.heroCatalog.mediaType,
        catalogId: providers.heroCatalog.catalogId,
      };
    } else {
      unresolved += 1;
    }
  }
  return { aura, unresolved };
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

  // Providers — only present in v2+ blobs. Validate each field;
  // anything malformed gets dropped silently rather than failing the
  // whole import.
  let providers: PortableProvidersBlob | undefined;
  const provRaw = obj.providers && typeof obj.providers === "object"
    ? obj.providers as Record<string, unknown>
    : null;
  if (provRaw) {
    const stringOrNull = (v: unknown): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;
    const stringArrOrNull = (v: unknown): string[] | null => {
      if (v == null) return null;
      if (!Array.isArray(v)) return null;
      return v.filter((x): x is string => typeof x === "string");
    };
    let heroCatalog: PortableProvidersBlob["heroCatalog"] = null;
    const hcRaw = provRaw.heroCatalog as Record<string, unknown> | null | undefined;
    if (
      hcRaw && typeof hcRaw === "object"
      && typeof hcRaw.addonId === "string"
      && typeof hcRaw.mediaType === "string"
      && typeof hcRaw.catalogId === "string"
    ) {
      heroCatalog = {
        addonId: hcRaw.addonId,
        mediaType: hcRaw.mediaType,
        catalogId: hcRaw.catalogId,
      };
    }
    providers = {
      defaultHomeAddonId:       stringOrNull(provRaw.defaultHomeAddonId),
      additionalHomeAddonIds:   stringArrOrNull(provRaw.additionalHomeAddonIds) ?? [],
      defaultMetadataAddonId:   stringOrNull(provRaw.defaultMetadataAddonId),
      streamAddonIds:           stringArrOrNull(provRaw.streamAddonIds),
      searchAddonIds:           stringArrOrNull(provRaw.searchAddonIds),
      heroCatalog,
    };
  }

  return {
    version:    SCHEMA_VERSION,
    exportedAt: typeof obj.exportedAt === "string" ? obj.exportedAt : "",
    backend,
    aura,
    providers,
  };
}

/** Save the blob as a JSON file via the native Win32 "Save As…"
 *  dialog. Routes through the same `save_text_with_dialog` Rust
 *  command the DevConsole log download uses, so the user always
 *  gets to pick the folder + filename instead of having the file
 *  silently land in WebView2's default Downloads location.
 *
 *  Returns the chosen path on success, `null` when the user
 *  cancels the dialog, and rejects on IO / IPC failure. */
export async function downloadBlobAsFile(blob: SettingsBlob): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const json = blobToJsonString(blob);
  const stamp = blob.exportedAt.replace(/[:.]/g, "-").slice(0, 19);
  const result = await invoke<string | null>("save_text_with_dialog", {
    content: json,
    defaultName: `aura-settings-${stamp}.json`,
  });
  return result;
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
