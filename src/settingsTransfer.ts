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
//                    match an installed addon are dropped and counted (the
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
//       heroCatalog: { addonId, mediaType, catalogId } | null,
//       occurrences?: { ... }     // which install of a repeated manifest_id
//     }
//   }
//
// IMPORT MERGE STRATEGY
//   - backend / aura: shallow-overwrite by field. Unknown fields dropped.
//   - providers: each id resolved to the installed addon's URL via
//     manifest_id match; unresolvable ids dropped from the imported list
//     (preserving the relative order of the resolvable ones). A stream or
//     search list that names ids of which NONE resolve is left out of the
//     patch: it says nothing about this user's addons, and an empty override
//     would switch every addon off (same reasoning as electHomeAddons' note on
//     a stale override). An explicit [] from the exporter still applies.
//   - Two installs can share a manifest_id. `occurrences` says which one was
//     meant (the nth installed with that id), so raw urls, which carry config
//     tokens, stay out of this shareable blob. Addon order can differ between
//     machines, so it is best effort; a choice that has to fall back to the
//     first install is counted as `ambiguous` and reported.
//
// V1 BLOBS still parse — providers block is missing, so providers stay
// at their current values on the importing side. No-op forward-compat.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { loadAuraSettings, saveAuraSettings } from "./auraSettings";

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
  // Same arrangement as the TMDB key: keyring-resident, hydrated into the blob
  // only when the user opts in to exporting keys, stripped back out on import.
  "introdb_api_key",
  // `hdr_mode`, `hdr_enabled` and `hdr_target_peak_nits` deliberately do NOT
  // travel: they describe this machine's display (Rust keeps them in the
  // machine-local render.json beside `gpu_acceleration`), and they are
  // stripped from the cloud blob in sync.ts for the same reason.
  "next_up_lead_seconds",
  "audio_passthrough",
  "loudness_normalization",
  "keybindings",
  "skip_op_mode",
  "skip_ed_mode",
  "skip_recap_mode",
  "skip_treat_mixed_op_as_op",
  "trailer_quality",
  // `gpu_acceleration` deliberately does NOT travel: it is a per-machine GPU
  // workaround (Rust keeps it in a machine-local render.json), and it is
  // stripped from the cloud blob in sync.ts for the same reason. Nor does
  // `real_glass` (Real glass over video): an mpv shader on this machine's
  // GPU, kept in render.json and stripped in sync.ts alike.
  "cache_secs",
  "demuxer_readahead_secs",
  "demuxer_max_mib",
  "auto_scrobble_enabled",
  // Organised vs flat download layout. A real preference, so it travels.
  // `download_dir` deliberately does NOT: it is a machine-local path, like
  // `screenshot_dir`, and is also stripped from the cloud blob in sync.ts
  // (absence from this list gates file export/import only).
  "download_organise",
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
  "prescanNextEpisode",
  "nextUpSkipFillerRecap",
  "nextUpHoldToSkip",
  "upscalerRecHighlight",
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
  // A view preference, but a portable one: someone who wants the power-user
  // rows on one machine wants them on the next.
  "showAdvancedSettings",
  // How scrolling feels: a preference that follows the user.
  "smoothWheelScroll",
  // Which debrid providers the title-bar status monitor checks. A preference
  // about the user's services, which are the same on every machine.
  "monitoredProviders",
  // The glass material and the cursor glint: looks, like the theme (which is
  // portable on the backend side). Liquid's GPU fallback is decided per
  // machine at startup, so carrying "liquid" to a machine without hardware
  // acceleration is harmless.
  "glassStyle",
  "glassCursorGlow",
  // The Cursor glow tuning (edge, surface, size): a look like the two above;
  // readFromStorage clamps it on import.
  "glassGlowTune",
  // The custom accent per theme: a look, like the theme. The whole map is
  // carried; readFromStorage re-validates it on import (hex only, capped).
  "themeAccents",
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
  /** Absent on blobs from before it existed. */
  occurrences?:              ProviderOccurrences;
}

/** For each id above, its position among the installed addons with that
 *  manifest_id. The lists are parallel to their id lists. */
export interface ProviderOccurrences {
  defaultHome?:     number;
  additionalHome?:  number[];
  defaultMetadata?: number;
  stream?:          number[];
  search?:          number[];
  hero?:            number;
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

/** The url's position among the installed addons sharing its manifest_id,
 *  or undefined when it is not installed. */
function urlToOccurrence(url: string | null, addons: AddonRef[]): number | undefined {
  const id = urlToId(url, addons);
  if (!id) return undefined;
  return addons.filter((a) => a.manifest_id === id).findIndex((a) => a.url === url);
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

  // Parallel to `ids`: the same urls survive, in the same order.
  const occs = (urls: unknown): number[] | undefined => {
    if (!Array.isArray(urls)) return undefined;
    const out: number[] = [];
    for (const u of urls) {
      if (typeof u !== "string") continue;
      const n = urlToOccurrence(u, addons);
      if (n !== undefined) out.push(n);
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
    occurrences: {
      defaultHome:     urlToOccurrence(aura.defaultHomeAddonUrl as string | null, addons),
      additionalHome:  occs(aura.additionalHomeAddonUrls),
      defaultMetadata: urlToOccurrence(aura.defaultMetadataAddonUrl as string | null, addons),
      stream:          occs(aura.streamAddonUrls),
      search:          occs(aura.searchAddonUrls),
      hero:            hc?.addonUrl ? urlToOccurrence(hc.addonUrl, addons) : undefined,
    },
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

/** Apply the providers block to the importing user's addon list.
 *  Returns an aura-shape patch with URLs resolved, a count of ids that
 *  couldn't be matched, and a count of choices that landed on another install
 *  of the same addon because the blob could not say which one was meant. */
export function resolveProviders(
  providers: PortableProvidersBlob | undefined,
  addons: AddonRef[],
): { aura: Record<string, unknown>; unresolved: number; ambiguous: number } {
  if (!providers) return { aura: {}, unresolved: 0, ambiguous: 0 };
  let unresolved = 0;
  let ambiguous = 0;
  const occ = providers.occurrences;
  const installsOf = (id: string) => addons.filter((a) => a.manifest_id === id);
  /** One pinned addon. `n` undefined is a blob from before occurrences. */
  const resolveOne = (id: string | null, n: number | undefined): string | null => {
    if (!id) return null;
    const installs = installsOf(id);
    if (installs.length === 0) return null;
    const exact = n === undefined ? (installs.length === 1 ? installs[0] : undefined) : installs[n];
    if (!exact) ambiguous += 1;
    return (exact ?? installs[0]).url;
  };
  const resolveList = (ids: string[] | null, ns: number[] | undefined): string[] | null => {
    if (ids == null) return null;
    const indexed = ns?.length === ids.length ? ns : null;
    const out = new Set<string>(); // a repeat that lands on one install collapses
    const seen = new Map<string, number>();
    ids.forEach((id, i) => {
      const kth = seen.get(id) ?? 0;
      seen.set(id, kth + 1);
      const installs = installsOf(id);
      if (installs.length === 0) {
        unresolved += 1;
        return;
      }
      // No index: the kth repeat of an id means its kth install, and only a
      // list naming it fewer times than there are installs leaves a real doubt.
      const exact = installs[indexed ? indexed[i] : kth];
      const inDoubt = !indexed && kth === 0 && installs.length > ids.filter((x) => x === id).length;
      if (!exact || inDoubt) ambiguous += 1;
      out.add((exact ?? installs[0]).url);
    });
    return [...out];
  };
  /** undefined: named ids, none installed, so leave the field out of the patch
   *  (see IMPORT MERGE STRATEGY). */
  const resolveOverride = (ids: string[] | null, ns: number[] | undefined): string[] | null | undefined => {
    const out = resolveList(ids, ns);
    return ids && ids.length > 0 && out && out.length === 0 ? undefined : out;
  };

  const aura: Record<string, unknown> = {};
  if (providers.defaultHomeAddonId !== undefined) {
    const url = resolveOne(providers.defaultHomeAddonId, occ?.defaultHome);
    if (url) aura.defaultHomeAddonUrl = url;
    else if (providers.defaultHomeAddonId) unresolved += 1;
  }
  if (providers.additionalHomeAddonIds) {
    aura.additionalHomeAddonUrls = resolveList(providers.additionalHomeAddonIds, occ?.additionalHome) ?? [];
  }
  if (providers.defaultMetadataAddonId !== undefined) {
    const url = resolveOne(providers.defaultMetadataAddonId, occ?.defaultMetadata);
    if (url) aura.defaultMetadataAddonUrl = url;
    else if (providers.defaultMetadataAddonId) unresolved += 1;
  }
  if (providers.streamAddonIds !== undefined) {
    const urls = resolveOverride(providers.streamAddonIds, occ?.stream);
    if (urls !== undefined) aura.streamAddonUrls = urls;
  }
  if (providers.searchAddonIds !== undefined) {
    const urls = resolveOverride(providers.searchAddonIds, occ?.search);
    if (urls !== undefined) aura.searchAddonUrls = urls;
  }
  if (providers.heroCatalog) {
    const url = resolveOne(providers.heroCatalog.addonId, occ?.hero);
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
  return { aura, unresolved, ambiguous };
}

/** The keyring-resident API keys an export can carry (only when the user
 *  opted in). On import they go to the OS keyring, never settings.json. */
const IMPORTABLE_API_KEYS = ["opensubtitles", "tmdb", "introdb"] as const;

/** update_settings' answers for a patch it will not take (settings.rs), as
 *  opposed to a save that failed: only these are worth retrying per field. */
function isPatchRejection(e: unknown): boolean {
  const message = String(e);
  return message.startsWith("Invalid settings patch") || message.startsWith("Unknown theme");
}

/** What an import actually landed, for the caller's status line. */
export interface ImportSummary {
  /** Settings applied: backend fields taken, API keys written to the keyring,
   *  Aura fields and resolved provider fields. */
  applied: number;
  /** Backend fields update_settings refused, even one at a time. */
  rejected: string[];
  /** Provider ids with no installed addon to resolve to. */
  unresolved: number;
  /** Provider choices that fell back to another install of the same addon. */
  ambiguous: number;
}

/** Apply a parsed settings blob: the shared import path for Settings and the
 *  first-run setup. `applyBackend` is the caller's backend patch writer (it
 *  must reject when update_settings does, so a refused patch can be retried
 *  field by field). Rejects when a save fails outright; the caller reports it.
 *
 *  Steps, in order: imported API keys are stripped from the backend patch; the
 *  patch is applied (one bad field rejects the whole patch, so on a rejection
 *  each field is retried alone, and a failed SAVE ends the import); the keys go
 *  to the keyring (best effort) with `aura:api-keys-changed`; the Aura fields
 *  merge over the current ones, then the provider ids resolve against
 *  `addons`; the loudness switch is mirrored to the engine when the blob held
 *  it (the Settings toggle does the same). */
export async function applySettingsImport(
  blob: SettingsBlob,
  addons: AddonRef[],
  applyBackend: (patch: Record<string, unknown>) => Promise<unknown>,
): Promise<ImportSummary> {
  // Redirect imported API keys away from settings.json (where they'd remain
  // readable to anyone with filesystem access) and into the OS keyring. A
  // copy of blob.backend, so the patch sent to applyBackend has them stripped.
  const backendPatch = { ...(blob.backend as Record<string, unknown>) };
  const importedKeys: [string, string][] = [];
  for (const name of IMPORTABLE_API_KEYS) {
    const field = `${name}_api_key`;
    const value = typeof backendPatch[field] === "string"
      ? backendPatch[field] as string : "";
    // Strip unconditionally, even when empty: `tmdb_api_key` is not a
    // backend settings field at all, and an unknown key must not ride along
    // into the settings.json patch.
    delete backendPatch[field];
    if (value.trim()) importedKeys.push([name, value.trim()]);
  }

  // update_settings deserializes the merged object as one unit, so one bad
  // field rejects the whole patch. Field by field only then: each call
  // rewrites settings.json. A failed SAVE is not retried, it ends the import.
  const backendKeys = Object.keys(backendPatch);
  const rejected: string[] = [];
  if (backendKeys.length > 0) {
    try {
      await applyBackend(backendPatch);
    } catch (e) {
      if (!isPatchRejection(e)) throw e;
      for (const key of backendKeys) {
        try {
          await applyBackend({ [key]: backendPatch[key] });
        } catch (fieldError) {
          if (!isPatchRejection(fieldError)) throw fieldError;
          rejected.push(key);
        }
      }
    }
  }

  // Now write the imported keys to the keyring. Best-effort: if the keyring
  // fails (Linux without Secret Service), nothing is left in settings.json
  // either (the user can re-paste the key manually). Empty values were
  // skipped above so an existing keyring entry is never overwritten with
  // nothing.
  let keysWritten = 0;
  for (const [name, value] of importedKeys) {
    await invoke("set_api_key", { name, value }).then(() => { keysWritten += 1; }, () => {});
  }
  if (importedKeys.length > 0) {
    window.dispatchEvent(new CustomEvent("aura:api-keys-changed"));
  }

  // Aura-side portable subset. Import is additive: any field present in the
  // blob overwrites; missing fields keep their current value. Provider lists
  // go through resolveProviders so the imported manifest_ids resolve to the
  // importing user's actual addon URLs (and unresolvable ids drop with a
  // count).
  const next = { ...loadAuraSettings() };
  if (blob.aura) {
    // blob.aura is already whitelisted to PORTABLE_AURA_FIELDS (and is
    // addon-URL-independent), so merge every field present. Each value is
    // re-validated and clamped by readFromStorage() on the next load, so a
    // malformed imported field can't corrupt state. (Addon-dependent
    // provider fields arrive separately via resolveProviders below.)
    Object.assign(next, blob.aura);
  }
  const { aura: providerAura, unresolved, ambiguous } = resolveProviders(blob.providers, addons);
  // Each resolved provider field overlays the current Aura settings. The
  // resolveProviders return shape uses the same field names as AuraSettings,
  // so a direct merge applies.
  Object.assign(next, providerAura);
  saveAuraSettings(next);

  // The engine installs its loudness filter at mpv init from a backend
  // mirror of this switch (set_audio_loudnorm), so an imported value must
  // reach it too. The re-validated value, not the raw blob field.
  if (blob.aura && "loudnessNormalization" in blob.aura) {
    const enabled = loadAuraSettings().loudnessNormalization;
    invoke("set_audio_loudnorm", { enabled }).catch(() => {});
  }

  // What actually landed, not what the blob held.
  const applied =
    backendKeys.length - rejected.length
    + keysWritten
    + Object.keys(blob.aura ?? {}).length
    + Object.keys(providerAura).length;
  return { applied, rejected, unresolved, ambiguous };
}

/** The status line for an import: what landed, what was refused, and the
 *  provider notes. `kind` is "error" when any backend field was refused. */
export function importSummaryStatus(summary: ImportSummary): { kind: "ok" | "error"; message: string } {
  const { applied, rejected, unresolved, ambiguous } = summary;
  const notes: string[] = [];
  if (unresolved > 0) {
    notes.push(`${unresolved} provider id${unresolved === 1 ? "" : "s"} skipped, not installed`);
  }
  if (ambiguous > 0) {
    notes.push(`${ambiguous} provider choice${ambiguous === 1 ? "" : "s"} matched another install of the same addon, check Settings`);
  }
  const tail = notes.length > 0 ? ` (${notes.join("; ")})` : "";
  const imported = `Imported ${applied} setting${applied === 1 ? "" : "s"}`;
  return rejected.length > 0
    ? { kind: "error", message: `${imported}; could not apply: ${rejected.join(", ")}${tail}.` }
    : { kind: "ok", message: `${imported}${tail}.` };
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
  // An export from before the "Enable scrobbling" master switch was retired:
  // with it off nothing was sent automatically, whatever the auto switch said,
  // so keep that meaning (the same fold settings.rs applies to a file or patch).
  if (backendRaw.scrobble_enabled === false) backend.auto_scrobble_enabled = false;

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
    const nth = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
    const nthList = (v: unknown): number[] | undefined =>
      Array.isArray(v) && v.every((x) => nth(x) !== undefined) ? (v as number[]) : undefined;
    const occRaw = provRaw.occurrences && typeof provRaw.occurrences === "object"
      ? provRaw.occurrences as Record<string, unknown>
      : null;
    providers = {
      defaultHomeAddonId:       stringOrNull(provRaw.defaultHomeAddonId),
      additionalHomeAddonIds:   stringArrOrNull(provRaw.additionalHomeAddonIds) ?? [],
      defaultMetadataAddonId:   stringOrNull(provRaw.defaultMetadataAddonId),
      streamAddonIds:           stringArrOrNull(provRaw.streamAddonIds),
      searchAddonIds:           stringArrOrNull(provRaw.searchAddonIds),
      heroCatalog,
      occurrences: occRaw ? {
        defaultHome:     nth(occRaw.defaultHome),
        additionalHome:  nthList(occRaw.additionalHome),
        defaultMetadata: nth(occRaw.defaultMetadata),
        stream:          nthList(occRaw.stream),
        search:          nthList(occRaw.search),
        hero:            nth(occRaw.hero),
      } : undefined,
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
