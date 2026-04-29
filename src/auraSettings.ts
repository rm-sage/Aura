// ---------------------------------------------------------------------------
// Aura UI settings (localStorage)
//
// Frontend-only preferences that don't need to round-trip through the backend
// (the backend `settings.json` covers system-level concerns: theme, RPC,
// language defaults, scrobble URL).
//
// Whenever the UI mutates settings via `saveAuraSettings`, an
// `aura:settings-changed` event is dispatched so other components in the same
// window can react without a manual prop chain.
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "aura:settings:v1";
const CHANGE_EVENT = "aura:settings-changed";

export interface AuraSettings {
  /** URL of the addon whose catalogs lead the Home view. */
  defaultHomeAddonUrl: string | null;
  /** Optional metadata-provider override used for detail/calendar fetches. */
  defaultMetadataAddonUrl: string | null;
  /** Extra addons whose catalogs render *alongside* the primary on Home. */
  additionalHomeAddonUrls: string[];
}

export const DEFAULT_AURA_SETTINGS: AuraSettings = {
  defaultHomeAddonUrl: null,
  defaultMetadataAddonUrl: null,
  additionalHomeAddonUrls: [],
};

export function loadAuraSettings(): AuraSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AURA_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AuraSettings>;
    return {
      ...DEFAULT_AURA_SETTINGS,
      ...parsed,
      // Defensive: ensure the array is always present and well-typed
      additionalHomeAddonUrls: Array.isArray(parsed.additionalHomeAddonUrls)
        ? parsed.additionalHomeAddonUrls.filter((u): u is string => typeof u === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_AURA_SETTINGS };
  }
}

export function saveAuraSettings(s: AuraSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  // Same-window components don't see `storage` events; emit a custom one.
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}
