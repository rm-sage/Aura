import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, ThemeId } from "../types";
import { useTheme, THEME_LABELS, THEME_DESCRIPTIONS } from "../ThemeEngine";
import { findAIOMetadataAddon } from "../aiometadata";
import {
  loadAuraSettings,
  saveAuraSettings,
  type AuraSettings,
} from "../auraSettings";

// ---------------------------------------------------------------------------
// Backend-side settings shape — must mirror Rust AppSettings.
// ---------------------------------------------------------------------------
interface BackendSettings {
  theme: string;
  global_audio_lang: string;
  global_subs_lang: string;
  anime_audio_lang: string;
  anime_subs_lang: string;
  discord_rpc_enabled: boolean;
  discord_rpc_show_titles: boolean;
  discord_rpc_blocked_titles: string[];
  pause_on_minimize: boolean;
  pause_on_lost_focus: boolean;
  close_on_exit: boolean;
  scrobble_addon_url: string;
}

// ---------------------------------------------------------------------------
// Reusable setting controls
// ---------------------------------------------------------------------------

interface DropdownProps {
  label: string;
  description: string;
  value: string | null;
  options: { value: string; label: string }[];
  onChange: (value: string | null) => void;
  required?: boolean;
  disabled?: boolean;
  /** Optional badge rendered after the label (e.g., "Managed by AIOMetadata"). */
  badge?: React.ReactNode;
}

function SettingDropdown({
  label, description, value, options, onChange, required, disabled, badge,
}: DropdownProps) {
  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-center gap-2">
          <p className="text-white/75 text-sm font-medium">{label}</p>
          {badge}
        </div>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className={`w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5
                   text-sm outline-none focus:border-white/25
                   transition-colors appearance-none cursor-pointer
                   ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
        style={{
          color: "var(--text-primary)",
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='rgba(255,255,255,0.3)'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 14px center",
          paddingRight: "36px",
        }}
      >
        {!required && <option value="">— System default —</option>}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface ToggleProps {
  label: string;
  description: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

function SettingToggle({ label, description, value, onChange }: ToggleProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <button
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
        className={`relative w-10 h-6 rounded-full transition-colors duration-150 flex-shrink-0
                    ${value ? "bg-ln-accent/80" : "bg-white/15"}`}
      >
        <span
          className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white
                     shadow-md transition-transform duration-150"
          style={{ transform: value ? "translateX(16px)" : "translateX(0)" }}
        />
      </button>
    </div>
  );
}

interface TextInputProps {
  label: string;
  description: string;
  value: string;
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  badge?: React.ReactNode;
}

function SettingText({
  label, description, value, placeholder, onChange, disabled, badge,
}: TextInputProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        {badge}
      </div>
      <p className="text-white/35 text-xs -mt-1">{description}</p>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className={`w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5
                    text-sm font-mono placeholder:text-white/25 outline-none
                    focus:border-white/25 transition-colors
                    ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Multi-select addon picker — used for "Additional Home Sources"
// ---------------------------------------------------------------------------

interface MultiPickerProps {
  label: string;
  description: string;
  /** All available addons */
  addons: AddonEntry[];
  /** Currently selected URLs */
  values: string[];
  /** Optional URL to disable (typically the primary, can't double-add) */
  disabledUrl?: string | null;
  onChange: (values: string[]) => void;
}

function AddonMultiPicker({
  label, description, addons, values, disabledUrl, onChange,
}: MultiPickerProps) {
  const toggle = (url: string) => {
    if (values.includes(url)) onChange(values.filter((v) => v !== url));
    else onChange([...values, url]);
  };

  return (
    <div className="space-y-2">
      <div>
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      {addons.length === 0 ? (
        <p className="text-white/30 text-xs italic px-1 py-2">No addons installed.</p>
      ) : (
        <div className="space-y-1">
          {addons.map((a) => {
            const checked = values.includes(a.url);
            const disabled = disabledUrl === a.url;
            return (
              <label
                key={a.url}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg
                            transition-colors
                            ${disabled
                              ? "bg-white/3 text-white/30 cursor-not-allowed"
                              : "hover:bg-white/5 cursor-pointer"
                            }`}
              >
                <input
                  type="checkbox"
                  checked={checked && !disabled}
                  disabled={disabled}
                  onChange={() => !disabled && toggle(a.url)}
                  className="accent-ln-accent w-4 h-4"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate"
                     style={{ color: disabled ? "rgba(255,255,255,0.3)" : "var(--text-primary)" }}>
                    {a.name}
                  </p>
                  <p className="text-[10px] text-white/30 font-mono truncate">
                    {a.url.replace(/^https?:\/\//, "")}
                  </p>
                </div>
                {disabled && (
                  <span className="text-[10px] uppercase tracking-wider text-white/30">
                    Primary
                  </span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-white/40 text-xs font-semibold tracking-[0.1em] uppercase">
        {title}
      </h2>
      <div className="space-y-5 bg-white/3 border border-white/8 rounded-2xl px-5 py-5">
        {children}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AIOMetadata badge
// ---------------------------------------------------------------------------

function ManagedByAIOBadge() {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                 font-semibold uppercase tracking-wider
                 bg-ln-accent/15 text-ln-accent border border-ln-accent/30"
      title="This setting is automatically managed because the AIOMetadata addon is installed."
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" />
      </svg>
      Managed by AIOMetadata
    </span>
  );
}

// ---------------------------------------------------------------------------
// SettingsView
// ---------------------------------------------------------------------------

interface Props {
  addons: AddonEntry[];
}

const LANG_OPTIONS = [
  { value: "en", label: "English" },
  { value: "ja", label: "Japanese" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "ko", label: "Korean" },
  { value: "zh", label: "Chinese" },
];

export default function SettingsView({ addons }: Props) {
  const [aura, setAura] = useState<AuraSettings>(loadAuraSettings);
  const [backend, setBackend] = useState<BackendSettings | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const { theme, setTheme } = useTheme();

  // Detect AIOMetadata in the user's installed addons
  const aioAddon = findAIOMetadataAddon(addons);

  // Persist localStorage settings whenever they change
  useEffect(() => { saveAuraSettings(aura); }, [aura]);

  // Load backend settings on mount
  useEffect(() => {
    invoke<BackendSettings>("get_settings").then(setBackend).catch(() => {});
  }, []);

  // Patch a backend setting and round-trip through update_settings.
  const patchBackend = useCallback(async (patch: Partial<BackendSettings>) => {
    try {
      const updated = await invoke<BackendSettings>("update_settings", { patch });
      setBackend(updated);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1200);
    } catch {
      // ignore — UI keeps its optimistic state
    }
  }, []);

  // Auto-lock scrobble URL to AIOMetadata when present and the user hasn't
  // pinned a different URL yet (or has previously pinned to AIO).
  useEffect(() => {
    if (!backend || !aioAddon) return;
    if (backend.scrobble_addon_url !== aioAddon.url) {
      patchBackend({ scrobble_addon_url: aioAddon.url });
    }
  }, [aioAddon, backend, patchBackend]);

  // Saved flash for local changes
  useEffect(() => {
    setSavedFlash(true);
    const t = setTimeout(() => setSavedFlash(false), 1200);
    return () => clearTimeout(t);
  }, [aura]);

  const setLocal = (patch: Partial<AuraSettings>) =>
    setAura((prev) => ({ ...prev, ...patch }));

  const addonOptions = addons.map((a) => ({ value: a.url, label: a.name }));
  const themeOptions: { value: ThemeId; label: string }[] = [
    { value: "mica",     label: THEME_LABELS.mica },
    { value: "glass",    label: THEME_LABELS.glass },
    { value: "midnight", label: THEME_LABELS.midnight },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Background spans full width; content is centered in a readable column. */}
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
          <div className="flex items-baseline justify-between">
            <div>
              <h1 className="text-white/85 text-xl font-light tracking-wide">Settings</h1>
              <p className="text-white/35 text-sm mt-1">App preferences and defaults.</p>
            </div>
            {savedFlash && <span className="text-white/30 text-xs">Saved</span>}
          </div>

          {/* Appearance */}
          <Section title="Appearance">
            <SettingDropdown
              label="Theme"
              description={THEME_DESCRIPTIONS[theme]}
              value={theme}
              options={themeOptions}
              required
              onChange={(v) => v && setTheme(v as ThemeId)}
            />
          </Section>

          {/* Catalog defaults */}
          <Section title="Catalog Defaults">
            <SettingDropdown
              label="Default Home Catalog"
              description="The primary addon whose catalogs lead the Home view."
              value={aura.defaultHomeAddonUrl}
              options={addonOptions}
              onChange={(v) => setLocal({ defaultHomeAddonUrl: v })}
            />
            <div className="h-px bg-white/6" />
            <AddonMultiPicker
              label="Additional Home Sources"
              description="Catalogs from these addons render alongside the primary on Home."
              addons={addons}
              values={aura.additionalHomeAddonUrls}
              disabledUrl={aura.defaultHomeAddonUrl ?? addons[0]?.url ?? null}
              onChange={(v) => setLocal({ additionalHomeAddonUrls: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingDropdown
              label="Default Metadata Provider"
              description="Preferred addon for fetching movie and series details."
              value={aura.defaultMetadataAddonUrl}
              options={addonOptions}
              onChange={(v) => setLocal({ defaultMetadataAddonUrl: v })}
            />
          </Section>

          {/* Playback — Global Defaults */}
          {backend && (
            <Section title="Playback · Global Defaults">
              <SettingDropdown
                label="Default audio language"
                description="Applied to movies and live-action series."
                value={backend.global_audio_lang}
                options={LANG_OPTIONS}
                required
                onChange={(v) => v && patchBackend({ global_audio_lang: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingDropdown
                label="Default subtitle language"
                description="Loaded automatically when subtitles are available."
                value={backend.global_subs_lang}
                options={LANG_OPTIONS}
                required
                onChange={(v) => v && patchBackend({ global_subs_lang: v })}
              />
            </Section>
          )}

          {/* Playback — Anime Defaults */}
          {backend && (
            <Section title="Playback · Anime Defaults">
              <SettingDropdown
                label="Audio language"
                description="Applied automatically when the title is detected as anime."
                value={backend.anime_audio_lang}
                options={LANG_OPTIONS}
                required
                onChange={(v) => v && patchBackend({ anime_audio_lang: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingDropdown
                label="Subtitle language"
                description="Anime usually pairs Japanese audio with localized subs."
                value={backend.anime_subs_lang}
                options={LANG_OPTIONS}
                required
                onChange={(v) => v && patchBackend({ anime_subs_lang: v })}
              />
            </Section>
          )}

          {/* Discord Rich Presence */}
          {backend && (
            <Section title="Discord Rich Presence">
              <SettingToggle
                label="Show what I'm watching"
                description="Publish playback details to Discord."
                value={backend.discord_rpc_enabled}
                onChange={(v) => patchBackend({ discord_rpc_enabled: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Show titles in presence"
                description="When off, Discord just shows 'Watching on Aura'."
                value={backend.discord_rpc_show_titles}
                onChange={(v) => patchBackend({ discord_rpc_show_titles: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingText
                label="Privacy: blocked titles"
                description="Comma-separated list. These titles never appear in your Discord status."
                value={backend.discord_rpc_blocked_titles.join(", ")}
                placeholder="e.g. Sensitive Show, Another Title"
                onChange={(v) => patchBackend({
                  discord_rpc_blocked_titles: v
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0),
                })}
              />
            </Section>
          )}

          {/* Window & system behaviour */}
          {backend && (
            <Section title="Window & System">
              <SettingToggle
                label="Pause on minimize"
                description="Pause playback when the window is minimized."
                value={backend.pause_on_minimize}
                onChange={(v) => patchBackend({ pause_on_minimize: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Pause on lost focus"
                description="Pause playback when another window takes focus."
                value={backend.pause_on_lost_focus}
                onChange={(v) => patchBackend({ pause_on_lost_focus: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Close on exit"
                description="Exit cleanly on close instead of staying in the tray."
                value={backend.close_on_exit}
                onChange={(v) => patchBackend({ close_on_exit: v })}
              />
            </Section>
          )}

          {/* Scrobbling */}
          {backend && (
            <Section title="Scrobbling (AIOMetadata)">
              <SettingText
                label="Scrobble addon URL"
                description={
                  aioAddon
                    ? "AIOMetadata is installed — Aura is locked onto its endpoint for Trakt / AniList progress reporting."
                    : "Optional. When set, Aura sends Start / Heartbeat / End events to this AIOMetadata-compatible endpoint to drive Trakt or AniList progress."
                }
                value={backend.scrobble_addon_url}
                placeholder="https://example.com/aiometadata"
                disabled={!!aioAddon}
                badge={aioAddon ? <ManagedByAIOBadge /> : null}
                onChange={(v) => patchBackend({ scrobble_addon_url: v.trim() })}
              />
            </Section>
          )}

          {/* About */}
          <Section title="About">
            <div className="flex items-center justify-between">
              <p className="text-white/55 text-sm">Aura</p>
              <p className="text-white/30 text-xs font-mono">Phase 3 Optimization</p>
            </div>
            <div className="h-px bg-white/6" />
            <div className="flex items-center justify-between">
              <p className="text-white/55 text-sm">Installed addons</p>
              <p className="text-white/30 text-xs">{addons.length}</p>
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}
