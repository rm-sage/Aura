// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { checkForUpdatePlugin, downloadAndInstallUpdatePlugin } from "../updaterPlugin";
import StorageReport from "../StorageReport";
import {
  buildExportBlob,
  blobToBase64,
  downloadBlobAsFile,
  parseImportInput,
  readImportFile,
  resolveProviders,
} from "../settingsTransfer";
import {
  applyBackupPayload,
  backupStorageUsed,
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  readSnapshot,
  type BackupMeta,
} from "../userDataBackup";
import type { AddonEntry, ThemeId, KeybindAction } from "../types";
import type { UserSession } from "../LoginView";
import { KEYBIND_ACTIONS } from "../types";
import { useTheme, THEME_LABELS, THEME_DESCRIPTIONS } from "../ThemeEngine";
import { prettyBinding, formatBinding } from "../useKeybindings";
import {
  loadAuraSettings,
  saveAuraSettings,
  type AuraSettings,
} from "../auraSettings";
import { showAppToast } from "../AppToast";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import auraIconAsset from "../assets/aura-icon.png";

/** App version. Sourced from package.json via the `VITE_APP_VERSION`
 *  define in vite.config.ts so a single version bump in package.json
 *  flows everywhere. See App.tsx's APP_VERSION comment for the
 *  incident this prevents (hardcoded constant drifted from the actual
 *  build version, so the updater self-reported as "up to date"). */
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "0.0.0";

// ---------------------------------------------------------------------------
// Backend-side settings shape — must mirror Rust AppSettings.
// ---------------------------------------------------------------------------
interface BackendSettings {
  theme: string;
  subtitle_language: string;
  selectable_subtitle_languages: string[];
  audio_priority: string[];
  avoid_dubs: boolean;
  user_region: string;
  subtitle_font_size: number;
  subtitle_position: number;
  subtitle_border_size: number;
  subtitle_color: string;
  subtitle_back_color: string;
  subtitle_font: string;
  discord_rpc_enabled: boolean;
  discord_rpc_show_titles: boolean;
  discord_rpc_blocked_titles: string[];
  discord_rpc_browse_states: boolean;
  pause_on_minimize: boolean;
  pause_on_lost_focus: boolean;
  close_on_exit: boolean;
  minimize_to_tray_on_close: boolean;
  scrobble_addon_url: string;
  scrobble_enabled: boolean;
  opensubtitles_api_key: string;
  omdb_api_key: string;
  /** Legacy HDR toggle. Kept on the wire so older settings survive the
   *  migration, but the new UI talks to `hdr_mode` directly. */
  hdr_enabled: boolean;
  /** Tri-state HDR pipeline: "off" | "sdr" | "passthrough". See
   *  src-tauri/src/settings.rs for the property fan-out per mode. */
  hdr_mode: string;
  /** Lead time (seconds before episode end) for the Next-Up CTA.
   *  0 disables the feature. */
  next_up_lead_seconds: number;
  audio_passthrough: boolean;
  keybindings: Record<string, string>;
  skip_op_mode: string;
  skip_ed_mode: string;
  skip_recap_mode: string;
  skip_treat_mixed_op_as_op: boolean;
  gpu_acceleration: boolean;
}

// ---------------------------------------------------------------------------
// Reusable setting controls
// ---------------------------------------------------------------------------

/** Tight per-row matcher used by the Settings search bar. Replaces the
 *  earlier forgiving subsequence match (`fuzzySubseq`) that accepted
 *  "subfsz" → "Subtitle Font Size" and ended up matching every section
 *  on the page for generic queries.
 *
 *  Rules (all inputs pre-lowercased):
 *    • Each whitespace-separated token must match independently (AND).
 *    • A token matches if it is a substring of the label OR a prefix
 *      of any word in the label OR a substring of the description.
 *    • Empty query returns true (matches everything; caller decides
 *      what to do with that).
 *
 *  Accepts: "subtitle" → "Subtitle Font Size" (substring of label),
 *           "sub font" → "Subtitle Font Size" (prefix of each word),
 *           "subt" → "Subtitle Font Size" (prefix).
 *  Rejects: "subfsz" → no token is a contiguous match anywhere. */
function matchesSettingRow(query: string, label: string, description: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const lab = label.toLowerCase();
  const desc = description.toLowerCase();
  const labelWords = lab.split(/[^a-z0-9]+/i).filter(Boolean);
  return tokens.every((t) => {
    if (lab.includes(t)) return true;
    if (labelWords.some((w) => w.startsWith(t))) return true;
    if (desc.includes(t)) return true;
    return false;
  });
}

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
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
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
        {!required && <option value="">System default</option>}
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
    <div
      className="flex items-center justify-between gap-4"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
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

/** Three-position segmented selector (off / prompt / auto) used by the
 *  AniSkip section. Single row each for OP / ED / recap modes. */
function SkipModeRow({
  label, description, value, onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const opts: { id: string; label: string; tone: string }[] = [
    { id: "off",    label: "Off",    tone: "text-white/55" },
    { id: "prompt", label: "Prompt", tone: "text-amber-300" },
    { id: "auto",   label: "Auto",   tone: "text-emerald-300" },
  ];
  return (
    <div
      className="flex items-center justify-between gap-4"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <div
        className="flex-shrink-0 inline-flex rounded-full overflow-hidden
                   bg-white/5 border border-white/10 p-0.5 gap-0.5"
      >
        {opts.map((o) => {
          const active = value === o.id;
          return (
            <button
              key={o.id}
              onClick={() => onChange(o.id)}
              className={`px-3 py-1 rounded-full text-[11.5px] font-medium tracking-wide
                          transition-colors duration-150
                          ${active
                            ? `bg-ln-accent/20 ${o.tone}`
                            : "text-white/55 hover:text-white/85"}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
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
  /** Return "valid" | "invalid" | null (empty value → no indicator). */
  validate?: (v: string) => "valid" | "invalid" | null;
  validationHint?: string;
}

function SettingText({
  label, description, value, placeholder, onChange, disabled, badge,
  validate, validationHint,
}: TextInputProps) {
  const validState = validate && value.length > 0 ? validate(value) : null;
  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div className="flex items-center gap-2">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        {badge}
      </div>
      <p className="text-white/35 text-xs -mt-1">{description}</p>
      <div className="relative">
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          className={`w-full bg-white/5 border rounded-xl px-4 py-2.5
                      text-sm font-mono placeholder:text-white/25 outline-none
                      transition-colors
                      ${validate ? "pr-9" : ""}
                      ${validState === "valid"
                        ? "border-emerald-400/40 focus:border-emerald-400/60"
                        : validState === "invalid"
                        ? "border-red-400/40 focus:border-red-400/60"
                        : "border-white/10 focus:border-white/25"}
                      ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
          style={{ color: "var(--text-primary)" }}
        />
        {validState && (
          <span
            aria-hidden
            className={`absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold
                         pointer-events-none select-none
                         ${validState === "valid" ? "text-emerald-400" : "text-red-400"}`}
          >
            {validState === "valid" ? "✓" : "✗"}
          </span>
        )}
      </div>
      {validState === "invalid" && validationHint && (
        <p className="text-red-400/70 text-xs">{validationHint}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingSlider — labeled range input with live numeric readout
// ---------------------------------------------------------------------------

function SettingSlider({
  label, description, value, min, max, step = 1, suffix, onChange,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Optional unit suffix (e.g. " px", " %"). Empty by default. */
  suffix?: string;
  onChange: (v: number) => void;
}) {
  // Fraction 0..1 for the slider track gradient. The CSS uses `--val`
  // as a percentage and `--val-frac` as a 0..1 number for shadow intensity.
  const span = Math.max(1, max - min);
  const frac = Math.max(0, Math.min(1, (value - min) / span));
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <span className="text-white/65 text-[12px] font-mono tabular-nums">
          {value}{suffix ?? ""}
        </span>
      </div>
      <p className="text-white/35 text-xs -mt-1">{description}</p>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="aura-slider w-full"
        style={{
          ["--val" as never]:      `${(frac * 100).toFixed(2)}%`,
          ["--val-frac" as never]: frac.toFixed(3),
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SubLangFilterInput — comma-separated language codes (en, es, ja, …)
//
// Why this exists: SettingText is fully controlled and reflects whatever
// `value` is. If we filter the typed text on every keystroke through a
// regex that only accepts 2–3 letters, partial input ("e", "en, ") gets
// rejected, the parent state goes back to empty, and the input clears
// on the next keystroke — typing becomes impossible.
//
// This component holds a local DRAFT string that the user can edit
// freely. On blur (or Enter), we parse the draft into normalized ISO
// codes and commit upstream. The displayed value re-syncs from upstream
// only when it actually changes (e.g. settings reload), not while the
// user is typing.
// ---------------------------------------------------------------------------

function SubLangFilterInput({
  value, onCommit,
}: {
  value: string[];
  onCommit: (next: string[]) => void;
}) {
  const joined = value.join(", ");
  const [draft, setDraft] = useState(joined);
  const lastSyncedRef = useRef(joined);

  // Pull in upstream changes when they actually shift (settings reload,
  // import, etc.) — but never while the user is mid-edit.
  useEffect(() => {
    if (joined !== lastSyncedRef.current) {
      lastSyncedRef.current = joined;
      setDraft(joined);
    }
  }, [joined]);

  const commit = () => {
    const parsed = draft
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => /^[a-z]{2,3}$/.test(s));
    lastSyncedRef.current = parsed.join(", ");
    setDraft(parsed.join(", "));
    onCommit(parsed);
  };

  return (
    <div className="space-y-2">
      <p className="text-white/75 text-sm font-medium">Subtitle picker languages</p>
      <p className="text-white/35 text-xs -mt-1">
        Comma-separated 2-letter ISO codes (en, es, ja). Limits which languages
        appear in the in-player subtitle picker. Empty shows every language.
      </p>
      <input
        type="text"
        value={draft}
        placeholder="e.g. en, es, ja"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        spellCheck={false}
        className="w-full bg-white/5 border border-white/10 focus:border-white/25
                   rounded-xl px-4 py-2.5 text-sm font-mono
                   placeholder:text-white/25 outline-none transition-colors"
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AudioPriorityInput — ordered list of language tokens for the audio
// scoring algorithm. Same draft-on-blur pattern as SubLangFilterInput,
// but tolerates the literal token "original" alongside ISO 639-1 codes.
// ---------------------------------------------------------------------------

function AudioPriorityInput({
  value, onCommit,
}: {
  value: string[];
  onCommit: (next: string[]) => void;
}) {
  const joined = value.join(", ");
  const [draft, setDraft] = useState(joined);
  const lastSyncedRef = useRef(joined);

  useEffect(() => {
    if (joined !== lastSyncedRef.current) {
      lastSyncedRef.current = joined;
      setDraft(joined);
    }
  }, [joined]);

  const commit = () => {
    const parsed = draft
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s === "original" || /^[a-z]{2,3}$/.test(s));
    lastSyncedRef.current = parsed.join(", ");
    setDraft(parsed.join(", "));
    onCommit(parsed);
  };

  return (
    <div className="space-y-2">
      <p className="text-white/75 text-sm font-medium">Audio language priority</p>
      <p className="text-white/35 text-xs -mt-1">
        Ordered list. <span className="font-mono text-white/55">original</span> resolves to the
        title's <span className="font-mono">originalLanguage</span> from AIOMetadata; ISO 639-1
        codes (en, ja, es) match by language tag. English is always appended as a
        final fallback. Default: <span className="font-mono">original, en</span>.
      </p>
      <input
        type="text"
        value={draft}
        placeholder="e.g. original, ja, en"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        }}
        spellCheck={false}
        className="w-full bg-white/5 border border-white/10 focus:border-white/25
                   rounded-xl px-4 py-2.5 text-sm font-mono
                   placeholder:text-white/25 outline-none transition-colors"
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SortableAddonRow — dnd-kit-driven row used inside AddonMultiPicker.
// ---------------------------------------------------------------------------

function SortableAddonRow({
  id, addon, onRemove,
}: {
  id: string;
  addon: AddonEntry;
  onRemove: () => void;
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    zIndex: isDragging ? 30 : "auto",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg
                  border bg-white/4 hover:bg-white/8 transition-colors
                  ${isDragging
                    ? "border-ln-accent/45 bg-ln-accent/15 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.5)]"
                    : "border-white/10"}`}
    >
      {/* Drag handle — only this element listens for drag activation so the
          "Remove" button stays clickable without grabbing the row. */}
      <button
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${addon.name}`}
        className="text-white/30 hover:text-white/60 text-xs select-none cursor-grab
                   active:cursor-grabbing px-1 -mx-1 py-1 rounded"
      >
        ⋮⋮
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>
            {addon.name}
          </p>
        </div>
        <p className="text-[10px] text-white/30 font-mono truncate">
          {addon.url.replace(/^https?:\/\//, "")}
        </p>
      </div>
      <button
        onClick={onRemove}
        className="text-white/35 hover:text-white/80 text-xs px-2 py-0.5 rounded
                   hover:bg-white/8 transition-colors"
      >
        Remove
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resource-tag predicates used to filter the addon-picker lists. Match is
// case-insensitive against the addon's `resources` list — Stremio spec
// strings are lowercase but we don't want a vendor-side casing tweak to
// silently empty either picker.
// ---------------------------------------------------------------------------

function hasResource(addon: AddonEntry, ...needles: string[]): boolean {
  const set = (addon.resources ?? []).map((r) => r.toLowerCase());
  return needles.some((n) => set.includes(n.toLowerCase()));
}

/** Catalog Providers picker — addons that surface metadata or that wrap
 *  other addons (i.e. things you'd reasonably expect to feed Home). Pure
 *  stream / subtitle addons are filtered out. */
function isCatalogProvider(addon: AddonEntry): boolean {
  return hasResource(addon, "meta", "addon_catalog");
}

/** Stream Providers picker — addons declaring the stream resource. */
function isStreamProvider(addon: AddonEntry): boolean {
  return hasResource(addon, "stream");
}

/** Search Providers picker — addons whose manifest probe set the
 *  has_search flag at install/sync time. AddonEntry exposes that as
 *  a flat boolean so we don't need to walk catalogs/extras here. */
function isSearchProvider(addon: AddonEntry): boolean {
  return addon.has_search === true;
}

// ---------------------------------------------------------------------------
// Unified home sources picker — single sortable list; position 0 = primary.
// Replaces the separate "Default Home Catalog" dropdown + "Additional Sources"
// multi-picker so the user can reorder even the primary entry.
//
// Optional `filter` narrows the picker to a subset of addons (e.g. only those
// declaring the `meta` / `addon_catalog` resources, so the Catalog Providers
// list isn't cluttered with stream-only or subtitle-only addons).
// ---------------------------------------------------------------------------

interface UnifiedHomePickerProps {
  addons: AddonEntry[];
  primaryUrl: string | null;
  additionalUrls: string[];
  onChange: (primary: string | null, additional: string[]) => void;
  filter?: (a: AddonEntry) => boolean;
  title?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// HeroCatalogPicker — two cascading selects (Addon → Catalog) that
// pin a specific catalog as the source for the Home hero band. Lists
// EVERY catalog the addon exposes (including is_hidden_from_home), so
// the user can lift a Discover-only catalog like AIOMetadata's "AI
// Recommendations" into the hero rotation without surfacing it in the
// home grid below. Picking "Default" clears the override and the hero
// falls back to the first browseable row's items (the 0.6.x default).
// ---------------------------------------------------------------------------

function HeroCatalogPicker({
  addons, value, onChange,
}: {
  addons: AddonEntry[];
  value: { addonUrl: string; mediaType: string; catalogId: string } | null;
  onChange: (next: { addonUrl: string; mediaType: string; catalogId: string } | null) => void;
}) {
  const catalogAddons: AddonEntry[] = useMemo(
    () => addons.filter((a) => (a.resources ?? []).includes("catalog")),
    [addons],
  );
  const [selectedUrl, setSelectedUrl] = useState<string | null>(value?.addonUrl ?? null);
  const [manifest, setManifest] = useState<{
    catalogs: { id: string; media_type: string; name: string; is_search_only: boolean }[];
  } | null>(null);

  // Re-fetch the chosen addon's manifest whenever the picker switches
  // to a different addon. 5-min Rust-side cache makes repeat picks
  // snappy after the first resolution.
  useEffect(() => {
    if (!selectedUrl) { setManifest(null); return; }
    let cancelled = false;
    invoke<typeof manifest>("get_addon_manifest", { addonUrl: selectedUrl })
      .then((m) => { if (!cancelled) setManifest(m); })
      .catch(() => { if (!cancelled) setManifest(null); });
    return () => { cancelled = true; };
  }, [selectedUrl]);

  const browseable = (manifest?.catalogs ?? []).filter((c) => !c.is_search_only);

  return (
    <div className="space-y-2">
      <p className="text-white/85 text-sm font-medium">Hero Carousel Source</p>
      <p className="text-white/40 text-xs leading-relaxed">
        Catalog whose items rotate in the Home hero band. Hidden-from-home
        catalogs are valid picks, useful for surfacing curated lists
        (AIOMetadata's AI Recommendations, mdblist, Trakt user lists)
        as the hero source without cluttering the grid below. Default
        falls back to your first browseable row.
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={selectedUrl ?? ""}
          onChange={(e) => {
            const url = e.target.value || null;
            setSelectedUrl(url);
            if (!url) onChange(null);
          }}
          className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs
                     outline-none focus:border-white/25 transition-colors min-w-[180px]"
          style={{ color: "var(--text-primary)" }}
        >
          <option value="">Default (first row)</option>
          {catalogAddons.map((a) => (
            <option key={a.url} value={a.url}>{a.name}</option>
          ))}
        </select>
        {selectedUrl && (
          <select
            value={value && value.addonUrl === selectedUrl
              ? `${value.mediaType}:${value.catalogId}` : ""}
            onChange={(e) => {
              if (!selectedUrl || !e.target.value) { onChange(null); return; }
              const [mediaType, catalogId] = e.target.value.split(":", 2);
              if (mediaType && catalogId) {
                onChange({ addonUrl: selectedUrl, mediaType, catalogId });
              }
            }}
            className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs
                       outline-none focus:border-white/25 transition-colors min-w-[200px]"
            style={{ color: "var(--text-primary)" }}
          >
            <option value="">Pick a catalog</option>
            {browseable.map((c) => (
              <option
                key={`${c.media_type}:${c.id}`}
                value={`${c.media_type}:${c.id}`}
              >
                {c.name} ({c.media_type})
              </option>
            ))}
          </select>
        )}
        {value && (
          <button
            type="button"
            onClick={() => { setSelectedUrl(null); onChange(null); }}
            className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/80 text-[11px] font-medium hover:bg-white/10
                       transition-colors"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function UnifiedHomeSourcesPicker({
  addons, primaryUrl, additionalUrls, onChange,
  filter,
  title = "Home Catalog Sources",
  description = "Drag to reorder. The first addon is the primary; its catalogs lead Home.",
}: UnifiedHomePickerProps) {
  const visibleAddons = filter ? addons.filter(filter) : addons;
  const orderedUrls = [
    ...(primaryUrl ? [primaryUrl] : []),
    ...additionalUrls.filter((u) => u !== primaryUrl),
  ];

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const commit = (urls: string[]) => {
    const [first, ...rest] = urls;
    onChange(first ?? null, rest);
  };

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = orderedUrls.indexOf(String(active.id));
    const to   = orderedUrls.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    commit(arrayMove(orderedUrls, from, to));
  };

  const remove = (url: string) => commit(orderedUrls.filter((u) => u !== url));
  const add    = (url: string) => commit([...orderedUrls, url]);

  const selectedSet     = new Set(orderedUrls);
  // The selected list is rendered from the user's saved order, but only
  // the entries that match the visible-filter and exist in the addon list.
  // Persisted entries that no longer match the filter (e.g. addon was
  // uninstalled, or its resource set changed) silently disappear from the UI.
  const selectedAddons  = orderedUrls
    .map((url) => visibleAddons.find((a) => a.url === url))
    .filter((a): a is AddonEntry => !!a);
  const unselected = visibleAddons
    .filter((a) => !selectedSet.has(a.url))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-2">
      <div>
        <p className="text-white/75 text-sm font-medium">{title}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      {visibleAddons.length === 0 ? (
        <p className="text-white/30 text-xs italic px-1 py-2">No matching addons installed.</p>
      ) : (
        <div className="space-y-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={orderedUrls} strategy={verticalListSortingStrategy}>
              {selectedAddons.map((addon) => (
                <SortableAddonRow
                  key={addon.url}
                  id={addon.url}
                  addon={addon}
                  onRemove={() => remove(addon.url)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {selectedAddons.length === 0 && (
            <p className="text-white/30 text-xs italic px-1 py-2">
              No sources added. Select from Available below.
            </p>
          )}

          {unselected.length > 0 && (
            <div className="pt-2 mt-2 border-t border-white/6 space-y-1">
              <p className="text-white/30 text-[10px] font-semibold tracking-[0.1em] uppercase px-1">
                Available
              </p>
              {unselected.map((a) => (
                <button
                  key={a.url}
                  onClick={() => add(a.url)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg
                             hover:bg-white/5 text-left transition-colors"
                >
                  <span className="text-white/25 text-xs">＋</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--text-muted)" }}>
                      {a.name}
                    </p>
                    <p className="text-[10px] text-white/25 font-mono truncate">
                      {a.url.replace(/^https?:\/\//, "")}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// AboutSection — condensed app-info panel + fun-stats readout
//
// Replaces the spaced-out "Aura · Phase 3 Optimization / Installed addons / 8"
// pair with a single tight info row, the bundled app icon, the live version
// (mirroring APP_VERSION above), and a small grid of self-tracked counters
// pulled from the stats backend.
// ---------------------------------------------------------------------------

interface AuraStats {
  watched_movie_secs: number;
  watched_series_secs: number;
  watched_anime_secs: number;
  streams_played: number;
  home_view_secs: number;
}

// ---------------------------------------------------------------------------
// BackupRestoreSection — portable settings export/import.
//
// Only addon-INDEPENDENT backend fields round-trip. The settingsTransfer
// module owns the whitelist + parse/serialize logic; this component is
// just glue between that and the user's clicks (download file / copy
// base64 / paste base64 / pick file).
// ---------------------------------------------------------------------------

function BackupRestoreSection({
  backend, addons, onApply, onResetComplete,
}: {
  backend: BackendSettings;
  /** Installed addons. Required so the export can encode provider /
   *  hero-catalog URLs as manifest_ids and the import can resolve
   *  them back to URLs against the importing user's installed list. */
  addons: AddonEntry[];
  onApply: (patch: Partial<BackendSettings>) => Promise<void>;
  /** Fires after a successful full reset so the parent can refresh its
   *  local snapshot from the backend's new defaults. */
  onResetComplete: () => void;
}) {
  const [exportText, setExportText] = useState<string>("");
  const [importText, setImportText] = useState<string>("");
  const [status, setStatus] = useState<{
    kind: "idle" | "ok" | "error";
    message: string;
  }>({ kind: "idle", message: "" });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Two-click reset confirmation. First click arms the danger button
  // (changes the label + colour); second click within 5 s triggers the
  // actual wipe. Auto-disarms after 5 s of inactivity so a fat-finger
  // tap doesn't sit live for the rest of the session.
  const [resetArmed, setResetArmed] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
  }, []);
  const armReset = () => {
    setResetArmed(true);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setResetArmed(false), 5000);
  };
  const confirmReset = async () => {
    setResetArmed(false);
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    try {
      // Backend wipe via the reset_settings Tauri command (writes a
      // fresh AppSettings::default() to disk and returns the snapshot).
      await invoke<BackendSettings>("reset_settings");
      // Frontend wipe — drop the localStorage-backed AuraSettings so
      // home/meta/stream/search overrides return to manifest-id
      // defaults instead of pointing at whatever the user had pinned.
      try { localStorage.removeItem("aura:settings:v1"); } catch {}
      window.dispatchEvent(new CustomEvent("aura:settings-changed"));
      onResetComplete();
      setStatus({ kind: "ok", message: "All settings reset to defaults." });
    } catch (e) {
      setStatus({ kind: "error", message: `Reset failed: ${String(e)}` });
    }
  };

  // Read API keys from the OS keyring + merge them onto the backend
  // snapshot just for the export blob. The migration cleared the
  // settings.json fields so the raw `backend` would export empty
  // strings; this hydration restores backup parity (a portable
  // export gets the user's keys round-trippable to a fresh device).
  // Stays async since `get_api_key` is a Tauri command; calling
  // sites await the blob.
  const hydrateBackendWithKeyringKeys = useCallback(async (): Promise<Record<string, unknown>> => {
    const merged: Record<string, unknown> = { ...(backend as unknown as Record<string, unknown>) };
    for (const name of ["omdb", "opensubtitles"] as const) {
      try {
        const v = await invoke<string>("get_api_key", { name });
        if (v && v.trim()) {
          merged[`${name}_api_key`] = v;
        }
      } catch {
        // Keyring unavailable on this platform — keep the merged value
        // (possibly empty from the migrated settings.json) so the
        // export still ships *something*.
      }
    }
    return merged;
  }, [backend]);

  const buildAndShow = useCallback(async () => {
    const hydratedBackend = await hydrateBackendWithKeyringKeys();
    const blob = buildExportBlob(
      hydratedBackend,
      loadAuraSettings() as unknown as Record<string, unknown>,
      addons,
    );
    setExportText(blobToBase64(blob));
    setStatus({ kind: "ok", message: "Export string ready. Copy or download." });
  }, [hydrateBackendWithKeyringKeys, addons]);

  const downloadFile = useCallback(async () => {
    const hydratedBackend = await hydrateBackendWithKeyringKeys();
    const blob = buildExportBlob(
      hydratedBackend,
      loadAuraSettings() as unknown as Record<string, unknown>,
      addons,
    );
    try {
      const path = await downloadBlobAsFile(blob);
      if (path) {
        setStatus({ kind: "ok", message: `Saved settings to ${path}.` });
      }
      // path === null → user canceled the Save dialog; no toast.
    } catch (e) {
      setStatus({ kind: "error", message: `Save failed: ${String(e)}` });
    }
  }, [hydrateBackendWithKeyringKeys, addons]);

  const applyText = useCallback(async (raw: string) => {
    const blob = parseImportInput(raw);
    if (!blob) {
      setStatus({ kind: "error", message: "Couldn't parse. Paste a valid export string or JSON." });
      return;
    }
    try {
      // Redirect imported API keys away from settings.json (where
      // they'd remain readable to anyone with filesystem access) and
      // into the OS keyring. We mutate a copy of blob.backend so the
      // backend patch sent to onApply has the key fields stripped.
      const backendPatch = { ...(blob.backend as Record<string, unknown>) };
      const omdbKey = typeof backendPatch.omdb_api_key === "string"
        ? backendPatch.omdb_api_key as string : "";
      const opensubKey = typeof backendPatch.opensubtitles_api_key === "string"
        ? backendPatch.opensubtitles_api_key as string : "";
      delete backendPatch.omdb_api_key;
      delete backendPatch.opensubtitles_api_key;

      await onApply(backendPatch as Partial<BackendSettings>);

      // Now write the imported keys to the keyring. Best-effort —
      // if the keyring fails (Linux without Secret Service), nothing
      // is left in settings.json either (the user can re-paste the
      // key manually). Skip empty values so we don't overwrite an
      // existing keyring entry with nothing.
      let apiKeysTouched = false;
      if (omdbKey.trim()) {
        await invoke("set_api_key", { name: "omdb", value: omdbKey.trim() }).catch(() => {});
        apiKeysTouched = true;
      }
      if (opensubKey.trim()) {
        await invoke("set_api_key", { name: "opensubtitles", value: opensubKey.trim() }).catch(() => {});
        apiKeysTouched = true;
      }
      if (apiKeysTouched) {
        window.dispatchEvent(new CustomEvent("aura:api-keys-changed"));
      }
      // Aura-side portable subset. Import is additive: any field
      // present in the blob overwrites; missing fields keep their
      // current value. Provider lists go through resolveProviders so
      // the imported manifest_ids resolve to the importing user's
      // actual addon URLs (and unresolvable ids drop with a count).
      const current = loadAuraSettings();
      const next = { ...current };
      if (blob.aura) {
        if (typeof blob.aura.hideCastSpoilers === "boolean") {
          next.hideCastSpoilers = blob.aura.hideCastSpoilers;
        }
        if (typeof blob.aura.showAioStreamsNotices === "boolean") {
          next.showAioStreamsNotices = blob.aura.showAioStreamsNotices;
        }
        if (typeof blob.aura.blurUnwatchedThumbnails === "boolean") {
          next.blurUnwatchedThumbnails = blob.aura.blurUnwatchedThumbnails;
        }
      }
      const { aura: providerAura, unresolved } = resolveProviders(blob.providers, addons);
      // Each resolved provider field overlays the current Aura
      // settings. The resolveProviders return shape uses the same
      // field names as AuraSettings, so a direct merge applies.
      Object.assign(next, providerAura);
      saveAuraSettings(next);
      const fields =
        Object.keys(blob.backend).length
        + Object.keys(blob.aura ?? {}).length
        + Object.keys(providerAura).length;
      const tail = unresolved > 0
        ? ` (${unresolved} provider id${unresolved === 1 ? "" : "s"} skipped, not installed)`
        : "";
      setStatus({
        kind: "ok",
        message: `Imported ${fields} setting${fields === 1 ? "" : "s"}${tail}.`,
      });
    } catch (e) {
      setStatus({ kind: "error", message: `Import failed: ${String(e)}` });
    }
  }, [onApply, addons]);

  const onPickFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // reset so re-picking the same file fires onChange
    if (!file) return;
    try {
      const txt = await readImportFile(file);
      await applyText(txt);
    } catch (err) {
      setStatus({ kind: "error", message: `Couldn't read file: ${String(err)}` });
    }
  }, [applyText]);

  return (
    <Section id="sec-backup" title="Backup & Restore">
      <p className="text-white/55 text-xs leading-relaxed">
        Export portable settings (theme, audio / subtitles, keybindings, Discord
        RPC, anime-skip modes, etc.) as a file or pasteable string. Catalog,
        stream, and search-provider lists are intentionally excluded so an
        import on a fresh install doesn't point at addons that aren't there.
      </p>

      {/* ── Export ── */}
      <div className="space-y-2">
        <p className="text-white/75 text-sm font-medium">Export</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={downloadFile}
            className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/80 text-[12px] font-medium tracking-wide
                       hover:bg-white/10 transition-colors"
          >
            Download as file
          </button>
          <button
            type="button"
            onClick={buildAndShow}
            className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/80 text-[12px] font-medium tracking-wide
                       hover:bg-white/10 transition-colors"
          >
            Show as string
          </button>
          {exportText && (
            <button
              type="button"
              onClick={() => {
                navigator.clipboard.writeText(exportText)
                  .then(() => setStatus({ kind: "ok", message: "Copied to clipboard." }))
                  .catch(() => setStatus({ kind: "error", message: "Clipboard write failed." }));
              }}
              className="px-3 py-1.5 rounded-lg border border-ln-accent/40 bg-ln-accent/15
                         text-ln-accent text-[12px] font-medium tracking-wide
                         hover:bg-ln-accent/25 transition-colors"
            >
              Copy
            </button>
          )}
        </div>
        {exportText && (
          <textarea
            readOnly
            value={exportText}
            className="w-full h-24 bg-black/40 border border-white/10 rounded-md px-3 py-2
                       text-[11px] font-mono text-white/70 outline-none
                       resize-none break-all"
            onFocus={(e) => e.currentTarget.select()}
          />
        )}
      </div>

      <div className="h-px bg-white/6" />

      {/* ── Import ── */}
      <div className="space-y-2">
        <p className="text-white/75 text-sm font-medium">Import</p>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder="Paste an export string here"
          className="w-full h-24 bg-black/40 border border-white/10 rounded-md px-3 py-2
                     text-[11px] font-mono text-white/85 outline-none
                     focus:border-white/25 transition-colors resize-none break-all"
          spellCheck={false}
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!importText.trim()}
            onClick={() => applyText(importText)}
            className="px-3 py-1.5 rounded-lg border border-ln-accent/40 bg-ln-accent/15
                       text-ln-accent text-[12px] font-medium tracking-wide
                       hover:bg-ln-accent/25 disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
          >
            Apply pasted string
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/80 text-[12px] font-medium tracking-wide
                       hover:bg-white/10 transition-colors"
          >
            Import from file…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json,.txt"
            onChange={onPickFile}
            className="hidden"
          />
        </div>
      </div>

      {status.kind !== "idle" && (
        <p className={[
          "text-[11px] font-mono",
          status.kind === "ok"    ? "text-emerald-300/85" : "",
          status.kind === "error" ? "text-rose-300/85"    : "",
        ].filter(Boolean).join(" ")}>
          {status.message}
        </p>
      )}

      <div className="h-px bg-white/6" />

      {/* ── Local-data backups (Queue / History / manual marks) ──
          Distinct from the export / import above: those round-trip
          settings between machines. THIS round-trips the user-data
          slice that lives only in localStorage (Queue, watch history,
          manual watched marks, AuraSettings). Snapshots are auto-
          captured on change (debounced 30 s) and capped at 10 per
          scope; the user can also create / restore / delete by hand
          here. Restore overwrites the current state — confirm-prompts
          guard the destructive path. */}
      <LocalDataBackupsSubsection />

      <div className="h-px bg-white/6" />

      {/* ── Danger zone: full reset ──
          Wipes both the backend AppSettings (theme / audio / subs /
          keybindings / discord / scrobble / etc.) AND the localStorage
          AuraSettings (catalog / stream / search provider URL lists).
          Two-click confirm: first click arms; second click within 5 s
          actually fires. Auto-disarms after 5 s. */}
      <div className="space-y-2">
        <p className="text-rose-300/95 text-sm font-medium">Reset all settings</p>
        <p className="text-white/45 text-xs leading-relaxed">
          Wipes every setting back to defaults: theme, audio / subtitle prefs,
          keybindings, Discord RPC, anime-skip modes, and your catalog /
          stream / search provider lists. Installed addons themselves are not
          removed. There is no undo.
        </p>
        <button
          type="button"
          onClick={resetArmed ? confirmReset : armReset}
          className={[
            "px-3 py-1.5 rounded-lg text-[12px] font-medium tracking-wide",
            "border transition-colors",
            resetArmed
              ? "border-rose-300/60 bg-rose-500/25 text-rose-100 hover:bg-rose-500/35"
              : "border-rose-400/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
          ].join(" ")}
        >
          {resetArmed ? "Click again within 5 s to confirm" : "Reset all settings"}
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// LocalDataBackupsSubsection — view + restore + create/delete the on-disk
// snapshots written by `userDataBackup.ts`.
//
// Lists every backup across every scope so a user who accidentally
// triggered a guest-vs-user-X scope mismatch (the original "my Queue
// disappeared" symptom) can spot a snapshot taken under their other
// scope and restore from there.
// ---------------------------------------------------------------------------

function LocalDataBackupsSubsection() {
  const [list, setList] = useState<BackupMeta[]>([]);
  const [storageBytes, setStorageBytes] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<BackupMeta | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<BackupMeta | null>(null);
  const [status, setStatus] = useState<{ kind: "idle" | "ok" | "error"; message: string }>({
    kind: "idle",
    message: "",
  });

  // Resolve the currently active scope from the manualWatched store
  // (mirrors what App.tsx's applySettingsScope set). The backup list
  // is filtered to this scope so the per-scope "10 max" cap displayed
  // in the UI actually matches the on-disk reality. Switching accounts
  // surfaces the other scope's backups; users wanting cross-scope
  // recovery can switch profiles to see them.
  const currentScope = (() => {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith("aura:manual-state:")) {
        return key.replace("aura:manual-state:", "");
      }
    }
    return "guest";
  })();

  const refresh = useCallback(async () => {
    const [items, used] = await Promise.all([
      listSnapshots(currentScope),
      backupStorageUsed(),
    ]);
    setList(items);
    setStorageBytes(used);
  }, [currentScope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onCreate = useCallback(async () => {
    setBusy(true);
    try {
      // Snapshot the CURRENT scope. Reading the scope from the
      // manualWatched store is the cheapest source of truth — it
      // mirrors what App.tsx's applySettingsScope set.
      const scope = (() => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith("aura:manual-state:")) {
            return key.replace("aura:manual-state:", "");
          }
        }
        return "guest";
      })();
      const meta = await createSnapshot("manual", scope);
      if (meta) {
        setStatus({ kind: "ok", message: "Snapshot created." });
        await refresh();
      } else {
        setStatus({ kind: "error", message: "Snapshot failed. See DevConsole for details." });
      }
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const performRestore = useCallback(async (meta: BackupMeta) => {
    setBusy(true);
    setConfirmRestore(null);
    try {
      // Defensive: take a "pre-restore" snapshot of the CURRENT state
      // before overwriting, so the user can roll back if the restore
      // wasn't what they expected. This is the recommended pattern in
      // userDataBackup.ts's header — practising what we preach here
      // is what makes the recovery story actually trustworthy.
      await createSnapshot("pre-restore", meta.scope);
      const payload = await readSnapshot(meta.scope, meta.fileName);
      if (!payload) {
        setStatus({ kind: "error", message: "Couldn't read snapshot." });
        return;
      }
      applyBackupPayload(payload);
      setStatus({ kind: "ok", message: "Restored. Refresh views to see the change." });
      await refresh();
    } catch (e) {
      setStatus({ kind: "error", message: `Restore failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const performDelete = useCallback(async (meta: BackupMeta) => {
    setBusy(true);
    setConfirmDelete(null);
    try {
      // deleteSnapshot returns false on failure (it swallows the
      // invoke error internally so the toast can render correctly).
      // Without this guard the optimistic "Snapshot deleted." toast
      // fired even when the file wasn't actually removed — the bug
      // the user surfaced before the BackupMeta camelCase fix landed.
      const ok = await deleteSnapshot(meta.scope, meta.fileName);
      if (!ok) {
        setStatus({ kind: "error", message: "Delete failed. See DevConsole." });
        return;
      }
      setStatus({ kind: "ok", message: "Snapshot deleted." });
      await refresh();
    } catch (e) {
      setStatus({ kind: "error", message: `Delete failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const fmtSize = (bytes: number) => {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes >= 1024)        return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  };
  const fmtTimestamp = (ms: number) => {
    if (!ms) return "-";
    const d = new Date(ms);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const HH = String(d.getHours()).padStart(2, "0");
    const MM = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
  };

  // Manual / auto split — manual snapshots ("manual" + "pre-restore"
  // reasons) are kept in their own ledger so they CAN'T be silently
  // overwritten by the auto-snapshot scheduler firing every 30 s.
  // Both buckets cap at 10 per scope independently.
  const manualReasons = new Set(["manual", "pre-restore"]);
  const manualList = list.filter((m) => manualReasons.has(m.reason));
  const autoList   = list.filter((m) => !manualReasons.has(m.reason));

  const renderRow = (meta: BackupMeta) => (
    <div
      key={meta.fileName}
      className="flex items-center gap-3 px-3 py-2 bg-white/2 text-[12px]"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-white/85 tabular-nums">
            {fmtTimestamp(meta.createdAtMs)}
          </span>
          <span className="text-white/35 text-[10.5px] uppercase tracking-wider">
            {meta.reason}
          </span>
        </div>
        <div className="text-white/40 text-[11px] mt-0.5 font-mono truncate">
          {meta.scope === "guest" ? "Guest mode" : `Account ${meta.scope}`}
          <span className="mx-2 text-white/20">·</span>
          {fmtSize(meta.sizeBytes)}
        </div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => setConfirmRestore(meta)}
        className="px-2.5 py-1 rounded-md border border-ln-accent/30 bg-ln-accent/10
                   text-ln-accent text-[11px] font-medium hover:bg-ln-accent/20
                   disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Restore
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setConfirmDelete(meta)}
        className="px-2.5 py-1 rounded-md border border-rose-400/30 bg-rose-500/10
                   text-rose-300 text-[11px] font-medium hover:bg-rose-500/20
                   disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Delete
      </button>
    </div>
  );

  return (
    <div className="space-y-3">
      <div>
        <p className="text-white/75 text-sm font-medium">Local user-data backups</p>
        <p className="text-white/40 text-xs leading-relaxed mt-0.5">
          Snapshots of your <strong>Queue</strong>, watch <strong>History</strong>,
          manual <em>watched / in-progress / planned</em> marks, and your
          per-account UI preferences. Stored on disk under
          <code className="font-mono text-white/55 mx-1">backups/</code>
          in Aura's app-data folder.
          {" "}<strong className="text-white/65">Manual</strong> snapshots
          (Create snapshot now, plus pre-restore safety copies) live in a
          separate ledger from{" "}
          <strong className="text-white/65">auto</strong> snapshots
          (every 30 s after a change), so the auto sweep can never
          push a manual entry off the cliff. Each ledger keeps the
          most recent 10 per account.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                     text-white/80 text-[12px] font-medium tracking-wide
                     hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed
                     transition-colors"
        >
          Create snapshot now
        </button>
        <span className="text-white/40 text-[11px]">
          {manualList.length} manual · {autoList.length} auto · {fmtSize(storageBytes)} on disk
        </span>
      </div>

      {list.length === 0 ? (
        <div className="text-white/35 text-[12px] italic">
          No snapshots yet. The first auto-snapshot fires ~30 s after the next
          change to your Queue / History / settings, or click <em>Create
          snapshot now</em>.
        </div>
      ) : (
        <div className="space-y-3">
          {manualList.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-white/45 text-[10.5px] font-mono uppercase tracking-[0.18em] px-1">
                Manual ({manualList.length}/10)
              </p>
              <div className="rounded-xl border border-white/10 overflow-hidden divide-y divide-white/5">
                {manualList.map(renderRow)}
              </div>
            </div>
          )}
          {autoList.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-white/45 text-[10.5px] font-mono uppercase tracking-[0.18em] px-1">
                Automatic ({autoList.length}/10)
              </p>
              <div className="rounded-xl border border-white/10 overflow-hidden divide-y divide-white/5">
                {autoList.map(renderRow)}
              </div>
            </div>
          )}
        </div>
      )}

      {status.kind !== "idle" && (
        <p
          className={[
            "text-[11px] font-mono",
            status.kind === "ok" ? "text-emerald-300/85" : "",
            status.kind === "error" ? "text-rose-300/85" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          {status.message}
        </p>
      )}

      {confirmRestore && (
        <ConfirmModal
          tone="warning"
          title="Restore snapshot?"
          message={`Restore the snapshot from ${fmtTimestamp(confirmRestore.createdAtMs)}? Your current Queue / History / manual marks will be overwritten. A pre-restore safety snapshot is taken automatically before the swap.`}
          confirmLabel="Restore"
          onConfirm={() => performRestore(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
        />
      )}
      {confirmDelete && (
        <ConfirmModal
          tone="danger"
          title="Delete snapshot?"
          message={`Permanently delete the snapshot from ${fmtTimestamp(confirmDelete.createdAtMs)}? This action cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => performDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/** Centred modal confirm dialog — replaces the previous inline "are you
 *  sure?" row that pushed the rest of the page around when it appeared.
 *  Renders into a portal so the backdrop covers the whole viewport, with
 *  Esc-to-cancel and click-outside-to-cancel handled centrally. */
function ConfirmModal({
  tone, title, message, confirmLabel, onConfirm, onCancel,
}: {
  tone: "warning" | "danger";
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const accent = tone === "danger"
    ? { ring: "ring-rose-400/40", btn: "border-rose-300/60 bg-rose-500/30 text-rose-50 hover:bg-rose-500/45", icon: "text-rose-300" }
    : { ring: "ring-amber-400/40", btn: "border-amber-300/60 bg-amber-500/30 text-amber-50 hover:bg-amber-500/45", icon: "text-amber-300" };

  const node = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm
                 animate-[fade-in_120ms_ease-out]"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`max-w-[400px] w-full rounded-2xl bg-zinc-900/95 border border-white/15 ${accent.ring}
                    shadow-glass-edge ring-1 p-6 space-y-4`}
      >
        <div className="flex items-start gap-3">
          <span className={`flex-shrink-0 mt-0.5 text-2xl leading-none ${accent.icon}`} aria-hidden>
            {tone === "danger" ? "⚠" : "ⓘ"}
          </span>
          <div className="flex-1 min-w-0 space-y-1.5">
            <h3 className="text-white font-semibold text-[15px] leading-tight">{title}</h3>
            <p className="text-white/70 text-[13px] leading-relaxed">{message}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/80 text-[12px] font-medium hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={`px-4 py-1.5 rounded-lg border text-[12px] font-medium transition-colors ${accent.btn}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

/** Lead-time row for the Next-Up CTA. Rendered as a labelled number
 *  field with chip-style presets (off / 30 / 60 / 90 / 120 s) so the
 *  common cases are one click away while still allowing custom values. */
function NextUpLeadTimeRow({
  value, onChange,
}: { value: number; onChange: (v: number) => void }) {
  const PRESETS = [0, 30, 60, 90, 120];
  const clamped = Math.max(0, Math.min(300, value));
  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label="Next-Up lead time"
      data-settings-description="Seconds before an episode ends to surface the Next Up card during series / anime playback. Set to 0 to disable the prompt entirely. The card never appears for movies or for the last aired episode of a series."
    >
      <div>
        <p className="text-white/75 text-sm font-medium">Next-Up lead time</p>
        <p className="text-white/35 text-xs mt-0.5">
          Seconds before an episode ends to surface the "Next Up" card
          during series / anime playback. Set to 0 to disable the prompt
          entirely. The card never appears for movies or for the last
          aired episode of a series.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {PRESETS.map((p) => {
          const active = clamped === p;
          const label = p === 0 ? "Off" : `${p}s`;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={[
                "px-3 py-1 rounded-full text-[12px] font-medium border transition-colors",
                active
                  ? "bg-ln-accent/20 text-ln-accent border-ln-accent/40"
                  : "bg-white/5 text-white/65 border-white/10 hover:bg-white/10",
              ].join(" ")}
            >
              {label}
            </button>
          );
        })}
        <div className="flex items-center gap-2 ml-1 text-[12px]">
          <input
            type="number"
            min={0}
            max={300}
            value={clamped}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(Math.max(0, Math.min(300, Math.round(n))));
            }}
            className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1
                       text-white/85 outline-none focus:border-white/25 transition-colors
                       text-center tabular-nums"
          />
          <span className="text-white/40">seconds</span>
        </div>
      </div>
    </div>
  );
}

/** Countdown-seconds selector for the Auto-advance toggle. Same chip
 *  + number-input pattern as NextUpLeadTimeRow, but a tighter range
 *  ([5, 30]) since the user has consciously opted into auto-advance —
 *  zero would be "skip immediately" (not useful), >30 would be no
 *  better than the standard manual CTA. Default 10 is a comfortable
 *  middle ground that gives time to grab the remote / mouse. */
function AutoAdvanceDelayRow({
  value, onChange,
}: { value: number; onChange: (v: number) => void }) {
  const PRESETS = [5, 10, 15, 20, 30];
  const clamped = Math.max(5, Math.min(30, value));
  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label="Auto-advance delay"
      data-settings-description="Seconds the Next-Up card waits before auto-firing. Any mouse / keyboard / scroll input cancels the countdown."
    >
      <div>
        <p className="text-white/75 text-sm font-medium">Auto-advance delay</p>
        <p className="text-white/35 text-xs mt-0.5">
          Seconds the Next-Up card waits before auto-firing. Any
          mouse / keyboard / scroll input cancels the countdown so
          you only get auto-advance when you're genuinely away from
          the player.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {PRESETS.map((p) => {
          const active = clamped === p;
          return (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={[
                "px-3 py-1 rounded-full text-[12px] font-medium border transition-colors",
                active
                  ? "bg-ln-accent/20 text-ln-accent border-ln-accent/40"
                  : "bg-white/5 text-white/65 border-white/10 hover:bg-white/10",
              ].join(" ")}
            >
              {p}s
            </button>
          );
        })}
        <div className="flex items-center gap-2 ml-1 text-[12px]">
          <input
            type="number"
            min={5}
            max={30}
            value={clamped}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(Math.max(5, Math.min(30, Math.round(n))));
            }}
            className="w-16 bg-white/5 border border-white/10 rounded-lg px-2 py-1
                       text-white/85 outline-none focus:border-white/25 transition-colors
                       text-center tabular-nums"
          />
          <span className="text-white/40">seconds</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KeyringApiKeyInput — text input backed directly by the OS keyring
// (via the Rust api_keyring commands). Reads on mount; writes on every
// blur / Enter to avoid hammering the keyring on every keystroke.
// Wrapped with the same data-settings-row attributes as SettingText so
// the search highlighter picks it up.
// ---------------------------------------------------------------------------

function KeyringApiKeyInput({
  name, label, description, placeholder,
}: {
  name: "omdb" | "opensubtitles";
  label: string;
  description: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState<string>("");
  const [persisted, setPersisted] = useState<string>("");
  const [revealed, setRevealed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load initial value from the keyring.
  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_api_key", { name })
      .then((v) => {
        if (cancelled) return;
        setValue(v ?? "");
        setPersisted(v ?? "");
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [name]);

  const commit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed === persisted) return;
    invoke("set_api_key", { name, value: trimmed })
      .then(() => {
        setPersisted(trimmed);
        // Tell the cloud-sync layer the local keyring changed so it
        // re-builds the settings blob (which now carries an
        // encrypted api_keys field) and debounces a push.
        window.dispatchEvent(new CustomEvent("aura:api-keys-changed"));
      })
      .catch((e) => {
        console.warn(`[settings] set_api_key(${name}) failed:`, e);
      });
  }, [name, value, persisted]);

  // Masked vs revealed — masked is the default since these are
  // credentials. The "Show" button flips to plain text. Clearing the
  // input still works whether or not it's revealed.
  const masked = !revealed && value.length > 0
    ? "•".repeat(Math.min(value.length, 32))
    : value;

  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div className="flex items-center gap-2">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono uppercase tracking-wider
                         bg-emerald-500/15 text-emerald-300/90 border border-emerald-400/25">
          Keyring
        </span>
      </div>
      <p className="text-white/35 text-xs -mt-1">{description}</p>
      <div className="relative">
        <input
          type={revealed ? "text" : "password"}
          value={revealed ? value : masked}
          placeholder={placeholder}
          disabled={!loaded}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
          }}
          spellCheck={false}
          autoComplete="off"
          className={`w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 pr-20
                      text-sm font-mono placeholder:text-white/25 outline-none
                      focus:border-white/25 transition-colors
                      ${!loaded ? "opacity-50" : ""}`}
          style={{ color: "var(--text-primary)" }}
        />
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          disabled={value.length === 0}
          className="absolute right-2 top-1/2 -translate-y-1/2
                     px-2 py-1 rounded-md text-[10.5px] font-medium tracking-wide
                     bg-white/5 text-white/55 border border-white/10
                     hover:bg-white/10 hover:text-white
                     disabled:opacity-30 disabled:hover:bg-white/5
                     transition-colors"
        >
          {revealed ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CloudSyncSection — diagnostic + control surface for Aura Cloud sync.
//
// Three top-level states based on `sync_status()`:
//   • Guest — no Stremio session → no sync available. Show a card with
//     a "Sign in" CTA (dispatches `aura:show-login` for App.tsx to
//     surface the LoginView modal).
//   • Connected, empty — connected but no namespaces have been written
//     yet. Show a "you're set up, nothing pushed yet" message + the
//     Pull Now / Clear actions (so the user can manually pull state
//     from another device).
//   • Connected, active — full namespace table with last-updated +
//     size per row, total/quota footer, Pull / Purge actions.
//
// Polls `sync_status` every 30 s while mounted, re-fetches immediately
// on `aura:settings-changed` + `aura:session-changed`, and on any
// user-triggered push/pull/purge action.
// ---------------------------------------------------------------------------

interface SyncNamespaceStatus {
  name: string;
  etag: string | null;
  updated_at: number | null;
  size: number | null;
}
interface SyncStatusResp {
  connected: boolean;
  namespaces: SyncNamespaceStatus[];
  total_size: number;
  quota: number;
}

/** Friendly per-namespace labels. Falls back to the raw name when an
 *  unknown namespace appears (forward-compat with a future namespace
 *  the proxy returns before this map is updated). */
const NAMESPACE_LABEL: Record<string, string> = {
  "settings":         "App settings",
  "manual-state":     "Watched marks & queue",
  "auto-bumped":      "Auto-bumped series",
  "notifications":    "Notifications",
  "recent-searches":  "Recent searches",
  "title-state":      "Per-title preferences",
  "anilist-id-map":   "AniList ID cache",
};

function CloudSyncSection({ authKey }: { authKey: string | null }) {
  const [status, setStatus] = useState<SyncStatusResp | null>(null);
  const [errored, setErrored] = useState(false);
  const [busyAction, setBusyAction] = useState<null | "pull" | "purge" | "push">(null);
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  // Tick for relative-time labels — refreshes every 30 s so "5 minutes
  // ago" stays current. Cheap; the relative formatter is O(1).
  const [tickNow, setTickNow] = useState(() => Date.now());

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<SyncStatusResp>("sync_status");
      setStatus(s);
      setErrored(false);
    } catch {
      setErrored(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const pollId = window.setInterval(() => { void refresh(); }, 30_000);
    const tickId = window.setInterval(() => setTickNow(Date.now()), 30_000);
    const onSignal = () => { void refresh(); };
    window.addEventListener("aura:settings-changed", onSignal);
    window.addEventListener("aura:session-changed",  onSignal);
    return () => {
      window.clearInterval(pollId);
      window.clearInterval(tickId);
      window.removeEventListener("aura:settings-changed", onSignal);
      window.removeEventListener("aura:session-changed",  onSignal);
    };
  }, [refresh]);

  const handlePullNow = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("pull");
    try {
      const { syncPullAll } = await import("../sync");
      await syncPullAll();
      showAppToast("Cloud Sync pulled successfully", { duration: 2500 });
      await refresh();
    } catch (e) {
      showAppToast(`Pull failed: ${String(e)}`, { duration: 4000 });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refresh]);

  const handlePushNamespace = useCallback(async (ns: string) => {
    if (busyAction) return;
    setBusyAction("push");
    try {
      const { syncPushNow } = await import("../sync");
      // The sync module's namespace literal type is union-restricted;
      // cast at the boundary since we already validated against the
      // server's response (which only returns canonical names).
      await syncPushNow(ns as Parameters<typeof syncPushNow>[0]);
      showAppToast(`Pushed ${NAMESPACE_LABEL[ns] ?? ns}`, { duration: 2000 });
      await refresh();
    } catch (e) {
      showAppToast(`Push failed: ${String(e)}`, { duration: 4000 });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refresh]);

  const handlePurge = useCallback(async () => {
    if (busyAction) return;
    setPurgeConfirm(false);
    setBusyAction("purge");
    try {
      const { syncPurge } = await import("../sync");
      await syncPurge();
      showAppToast("Cloud Sync data cleared", { duration: 2500 });
      await refresh();
    } catch (e) {
      showAppToast(`Purge failed: ${String(e)}`, { duration: 4000 });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, refresh]);

  // ── Guest state ───────────────────────────────────────────────────
  if (!authKey || (status && !status.connected)) {
    return (
      <div
        data-settings-row=""
        data-settings-label="Cloud Sync"
        data-settings-description="Aura Cloud sync — requires Stremio sign-in to enable per-account state sync."
        className="space-y-2"
      >
        <p className="text-white/55 text-sm leading-relaxed">
          Cloud Sync requires a Stremio account. Sign in to keep your
          settings, queue, manual marks, AniList ID cache, and
          notifications in sync across devices.
        </p>
        <p className="text-white/35 text-xs leading-relaxed">
          Library / watch progress are not synced here — Stremio's own
          cloud handles those. The Aura proxy never sees your raw
          auth_key; a SHA-256 hash computed locally is what
          authenticates each request.
        </p>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("aura:show-login"))}
          className="mt-1 px-3 py-1.5 rounded-lg border border-ln-accent/45 bg-ln-accent/15
                     text-ln-accent text-[12px] font-semibold tracking-wide
                     hover:bg-ln-accent/25 transition-colors"
        >
          Sign in to Stremio
        </button>
      </div>
    );
  }

  // ── Loading / error state ─────────────────────────────────────────
  if (!status) {
    return (
      <div
        data-settings-row=""
        data-settings-label="Cloud Sync"
        data-settings-description="Aura Cloud sync status loading."
        className="text-white/40 text-xs"
      >
        {errored ? (
          <div className="space-y-2">
            <p>Couldn't reach Aura Cloud.</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="px-3 py-1.5 rounded-md border border-white/15 bg-white/5 text-white/75
                         hover:bg-white/10 transition-colors text-[11px] font-medium"
            >
              Retry
            </button>
          </div>
        ) : (
          <p>Loading sync status…</p>
        )}
      </div>
    );
  }

  // ── Connected (with or without namespaces) ────────────────────────
  const lastSyncMs = (() => {
    if (!status.namespaces.length) return null;
    const max = status.namespaces.reduce(
      (acc, ns) => (ns.updated_at && ns.updated_at > acc ? ns.updated_at : acc),
      0,
    );
    return max > 0 ? max * 1000 : null;
  })();
  const quotaPctTotal = status.quota > 0 ? (status.total_size / status.quota) * 100 : 0;

  return (
    <div
      data-settings-row=""
      data-settings-label="Cloud Sync"
      data-settings-description="Per-namespace last pull / push / size; Pull now and Clear cloud sync data actions."
      className="space-y-3"
    >
      {/* Top status line */}
      <div className="flex items-center justify-between gap-3 text-[12px]">
        <span className="text-white/75 font-medium">
          {lastSyncMs ? `Last activity ${formatAgo(tickNow - lastSyncMs)}` : "Connected — no data yet"}
        </span>
        <span className="text-white/35 font-mono tabular-nums">
          {formatBytes(status.total_size)} / {formatBytes(status.quota)}
        </span>
      </div>

      {/* Approaching-quota hint */}
      {quotaPctTotal >= 95 && (
        <p className="text-amber-300/85 text-[11px]">
          Approaching the 10 MB per-account quota. Consider clearing old data via the destructive action below.
        </p>
      )}

      {/* Namespace table */}
      {status.namespaces.length > 0 && (
        <div className="rounded-lg border border-white/8 divide-y divide-white/6">
          {status.namespaces.map((ns) => {
            const ago = ns.updated_at ? formatAgo(tickNow - ns.updated_at * 1000) : "Never";
            const sizeKb = ns.size != null ? formatBytes(ns.size) : "—";
            const overQuota = ns.size != null && ns.size > 1024 * 1024 * 0.95;
            return (
              <div key={ns.name}
                   className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                <div className="min-w-0 flex-1">
                  <p className="text-white/85 font-medium truncate">
                    {NAMESPACE_LABEL[ns.name] ?? ns.name}
                  </p>
                  <p className="text-white/40 text-[10.5px] mt-0.5">
                    {ago} · <span className={overQuota ? "text-amber-300/80" : ""}>{sizeKb}</span>
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handlePushNamespace(ns.name)}
                  className="px-2 py-1 rounded-md text-[10.5px] font-medium tracking-wide
                             bg-white/5 text-white/65 border border-white/10
                             hover:bg-white/10 hover:text-white
                             disabled:opacity-40 disabled:cursor-not-allowed
                             transition-colors"
                >
                  {busyAction === "push" ? "…" : "Push"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Actions row */}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={busyAction !== null}
          onClick={() => void handlePullNow()}
          className="px-3 py-1.5 rounded-lg border border-ln-accent/40 bg-ln-accent/15
                     text-ln-accent text-[11.5px] font-semibold tracking-wide
                     hover:bg-ln-accent/25 transition-colors
                     disabled:opacity-50 disabled:cursor-progress"
        >
          {busyAction === "pull" ? "Pulling…" : "Pull now"}
        </button>
        <button
          type="button"
          disabled={busyAction !== null || status.namespaces.length === 0}
          onClick={() => setPurgeConfirm(true)}
          className="px-3 py-1.5 rounded-lg border border-rose-400/35 bg-rose-500/10
                     text-rose-300/95 text-[11.5px] font-medium tracking-wide
                     hover:bg-rose-500/20 hover:border-rose-400/50
                     disabled:opacity-40 disabled:cursor-not-allowed
                     transition-colors"
        >
          Clear cloud sync data
        </button>
      </div>

      {/* Privacy footer */}
      <p className="text-white/35 text-[10.5px] leading-relaxed pt-2 border-t border-white/6">
        Cloud Sync uses a derived hash of your Stremio auth_key (SHA-256,
        computed locally, never sent) as the storage key. The proxy
        never sees your raw auth_key. Library / watch progress are not
        synced here — Stremio's own cloud handles those.
      </p>

      {/* Purge confirm modal */}
      {purgeConfirm && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="max-w-[400px] mx-4 rounded-2xl bg-black/90 border border-white/12 p-5 space-y-3
                          shadow-[0_18px_42px_-12px_rgba(0,0,0,0.75)]">
            <h3 className="text-white/95 text-sm font-semibold tracking-wide">Clear cloud sync data?</h3>
            <p className="text-white/55 text-xs leading-relaxed">
              This permanently deletes all your synced data on the Aura Cloud proxy.
              Local state stays intact — your settings, queue, and marks remain on
              this device. Other devices will pull this device's state on their next
              sync.
            </p>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPurgeConfirm(false)}
                className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                           text-white/75 text-[11px] font-medium hover:bg-white/10
                           transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handlePurge()}
                className="px-3 py-1.5 rounded-lg border border-rose-400/45 bg-rose-500/20
                           text-rose-200 text-[11px] font-semibold hover:bg-rose-500/30
                           transition-colors"
              >
                Clear data
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 KB";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatAgo(diffMs: number): string {
  if (diffMs < 0) return "just now";
  const sec = Math.round(diffMs / 1000);
  if (sec < 45)  return "just now";
  const min = Math.round(diffMs / 60_000);
  if (min < 60)  return `${min} min ago`;
  const hr  = Math.round(diffMs / 3_600_000);
  if (hr < 24)   return `${hr}h ago`;
  const day = Math.round(diffMs / 86_400_000);
  if (day < 30)  return `${day}d ago`;
  const mon = Math.round(diffMs / (86_400_000 * 30));
  if (mon < 12)  return `${mon}mo ago`;
  const yr  = Math.round(diffMs / (86_400_000 * 365));
  return `${yr}y ago`;
}

function AboutSection({ addonCount }: { addonCount: number }) {
  const [stats, setStats] = useState<AuraStats | null>(null);
  useEffect(() => {
    invoke<AuraStats>("get_stats").then(setStats).catch(() => {});
  }, []);

  return (
    <Section title="About">
      <div className="flex items-center gap-3">
        <img
          src={auraIconAsset}
          alt="Aura"
          width={40}
          height={40}
          className="drop-shadow-[0_2px_10px_rgba(91,164,255,0.45)]"
          draggable={false}
        />
        <div className="flex-1 min-w-0">
          <p className="text-white/95 text-[15px] font-semibold leading-tight">Aura</p>
          <p className="text-white/45 text-[12px] mt-0.5 font-mono">
            v{APP_VERSION}
            <span className="mx-2 text-white/15">·</span>
            <span>{addonCount} addon{addonCount === 1 ? "" : "s"}</span>
          </p>
        </div>
        <CheckForUpdatesButton />
      </div>

      <div className="h-px bg-white/6" />

      <div>
        <p className="text-white/40 text-[10.5px] font-mono uppercase tracking-[0.18em] mb-2">
          Lifetime
        </p>
        <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px]">
          <StatRow label="Movies watched"  value={fmtHrs(stats?.watched_movie_secs)} />
          <StatRow label="Series watched"  value={fmtHrs(stats?.watched_series_secs)} />
          <StatRow label="Anime watched"   value={fmtHrs(stats?.watched_anime_secs)} />
          <StatRow label="Streams played"  value={(stats?.streams_played ?? 0).toLocaleString()} />
          <StatRow
            label="Hovered Home"
            value={fmtHrs(stats?.home_view_secs)}
            tooltip="Time spent staring at the home screen, instead of pressing play."
          />
        </div>
      </div>
    </Section>
  );
}

function StatRow({ label, value, tooltip }: { label: string; value: string; tooltip?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={tooltip}>
      <span className="text-white/55 truncate">{label}</span>
      <span className="text-white/85 font-mono tabular-nums">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CheckForUpdatesButton — manual GitHub releases check, rate-limited.
//
// Aura's auto-check is gated to once-per-12h on the home screen; the manual
// button gives the user an "I want to know NOW" affordance without waiting.
// We rate-limit clicks to once-per-minute (well under GitHub's 60 req/hr
// unauthenticated cap) so a frantic user can't burn through the quota and
// poison subsequent auto-checks.
// ---------------------------------------------------------------------------

const MANUAL_UPDATE_COOLDOWN_MS = 60_000; // 1 minute

type CheckState = "idle" | "checking" | "uptodate" | "available" | "installing" | "error" | "ratelimited";

function CheckForUpdatesButton() {
  const [state, setState] = useState<CheckState>("idle");
  const [latestTag, setLatestTag] = useState<string | null>(null);
  const lastCheckRef = useRef<number>(0);

  const onClick = useCallback(async () => {
    if (state === "checking" || state === "installing") return;
    // If an update is already known to be available, clicking the
    // button triggers the signed in-app install via the updater
    // plugin (download → verify minisign signature → install →
    // relaunch). The success branch typically never repaints
    // because the relaunch tears down the React tree first.
    if (state === "available") {
      setState("installing");
      try {
        const ok = await downloadAndInstallUpdatePlugin();
        if (!ok) setState("error");
        // success: app is about to relaunch, leave state pinned to
        // "installing" so the button stays in its busy look until
        // the process exits.
      } catch {
        setState("error");
      }
      return;
    }
    const now = Date.now();
    if (now - lastCheckRef.current < MANUAL_UPDATE_COOLDOWN_MS) {
      setState("ratelimited");
      return;
    }
    lastCheckRef.current = now;
    setState("checking");
    const release = await checkForUpdatePlugin();
    if (release) {
      setLatestTag(`v${release.version}`);
      setState("available");
    } else {
      // checkForUpdatePlugin returns null for "no update", network
      // error, or signature mismatch. We can't disambiguate from
      // the API surface, but in practice the most common outcome
      // is "you're up to date" — call it that to avoid alarming
      // the user on every blip.
      setState("uptodate");
    }
  }, [state]);

  const label = (() => {
    switch (state) {
      case "checking":     return "Checking…";
      case "uptodate":     return "Up to date";
      case "available":    return latestTag ? `Install ${latestTag}` : "Install update";
      case "installing":   return "Installing…";
      case "ratelimited":  return "Try again soon";
      case "error":        return "Check failed";
      default:             return "Check for Updates";
    }
  })();

  const tone = state === "available"
    ? "border-ln-accent/60 bg-ln-accent/15 text-ln-accent hover:bg-ln-accent/25"
    : "border-white/15 bg-white/5 text-white/80 hover:bg-white/10";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "checking"}
      className={[
        "flex-shrink-0 px-3 py-1.5 rounded-lg",
        "text-[12px] font-medium tracking-wide",
        "border transition-colors duration-150",
        "disabled:opacity-60 disabled:cursor-default",
        tone,
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function fmtHrs(secs: number | undefined): string {
  if (!secs || secs < 60) return "-";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// SettingsSearchInput — search-bar pill with grow-in animation, clear button,
// and a small "n matches" pill that fades in once the user starts typing.
//
// Behaviour:
//   • Focus animation — grows the pill width from 220 px → 320 px when
//     focused or non-empty, signalling that the search is "active".
//   • Esc clears the query AND blurs the input.
//   • Cmd/Ctrl-K focuses it from anywhere on the Settings page (covers the
//     standard "search shortcut" muscle memory without colliding with
//     player keybindings since the Settings view doesn't catch them).
// ---------------------------------------------------------------------------

function SettingsSearchInput({
  value,
  onChange,
  matchCount,
  currentMatchIdx,
  onStepMatch,
  compact = false,
}: {
  value: string;
  onChange: (q: string) => void;
  matchCount: number | null;
  /** 0-based index of the focused match; -1 = none focused. */
  currentMatchIdx: number;
  /** Step to the prev / next match. Caller wraps around. */
  onStepMatch: (delta: 1 | -1) => void;
  /** When true, render the search filling its container instead of the
   *  width-animated pill. Used when the search is embedded under the
   *  TOC sidebar rather than the (former) page header. */
  compact?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const active = focused || value.trim().length > 0;
  const hasMatches = (matchCount ?? 0) > 0;
  const showStepper = hasMatches && (matchCount ?? 0) > 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={compact ? "space-y-1.5" : "flex items-center gap-2"}>
      <div
        className={
          compact
            ? `relative flex items-center w-full rounded-lg border
               transition-[background-color,border-color] duration-200 ease-out
               ${active ? "bg-white/8 border-white/20" : "bg-white/4 border-white/12 hover:bg-white/6"}`
            : `relative flex items-center
               rounded-full border
               transition-[width,background-color,border-color] duration-200 ease-out
               ${active
                 ? "bg-white/8 border-white/20 w-[320px]"
                 : "bg-white/4 border-white/12 w-[220px] hover:bg-white/6"}`
        }
      >
        <svg
          width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden
          className={`absolute left-3 transition-colors duration-200
                      ${active ? "text-ln-accent" : "text-white/45"}`}
        >
          <path d="M15.5 14h-.79l-.28-.27a6.471 6.471 0 0 0 1.48-5.34C15.18 5.27 12.4 3 9 3 5.13 3 2 6.13 2 10s3.13 7 7 7c1.61 0 3.09-.55 4.27-1.46l.27.28v.79l5 4.99L20.49 20l-4.99-5zm-6.5 0C6.51 14 4.5 11.99 4.5 9.5S6.51 5 9 5s4.5 2.01 4.5 4.5S11.49 14 9 14z" />
        </svg>
        <input
          ref={ref}
          type="text"
          value={value}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Search settings…"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onChange("");
              (e.target as HTMLInputElement).blur();
              return;
            }
            // Enter / Shift+Enter step through matches like in-page-find.
            if (e.key === "Enter" && hasMatches) {
              e.preventDefault();
              onStepMatch(e.shiftKey ? -1 : 1);
            }
          }}
          aria-label="Search settings"
          className="w-full bg-transparent outline-none
                     pl-9 pr-9 py-1.5
                     text-[13px] text-white/90 placeholder-white/35"
        />
        {value.length > 0 && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => { onChange(""); ref.current?.focus(); }}
            className="absolute right-2 w-5 h-5 rounded-full
                       flex items-center justify-center
                       text-white/45 hover:text-white/85
                       hover:bg-white/10
                       transition-colors duration-150"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
      </div>
      {matchCount != null && (
        <div className={compact ? "flex items-center justify-between gap-2 pl-0.5" : "flex items-center gap-1.5"}>
          <span
            aria-live="polite"
            className={`text-[11px] font-mono tabular-nums tracking-wide
                        transition-opacity duration-200
                        ${matchCount === 0 ? "text-rose-300/85" : "text-white/45"}`}
          >
            {hasMatches && currentMatchIdx >= 0 && (matchCount ?? 0) > 0
              ? `${currentMatchIdx + 1} of ${matchCount}`
              : `${matchCount} ${matchCount === 1 ? "match" : "matches"}`}
          </span>
          {showStepper && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous match"
                title="Previous match (Shift+Enter)"
                onClick={() => onStepMatch(-1)}
                className="w-6 h-6 rounded-md
                           flex items-center justify-center
                           text-white/55 hover:text-white/95
                           bg-white/5 hover:bg-white/12 border border-white/10
                           transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M14 7l-5 5 5 5V7z" />
                </svg>
              </button>
              <button
                type="button"
                aria-label="Next match"
                title="Next match (Enter)"
                onClick={() => onStepMatch(1)}
                className="w-6 h-6 rounded-md
                           flex items-center justify-center
                           text-white/55 hover:text-white/95
                           bg-white/5 hover:bg-white/12 border border-white/10
                           transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M10 17l5-5-5-5v10z" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}
      <style>{`
        @keyframes settings-fade-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="space-y-4 scroll-mt-6">
      <h2 className="text-white/40 text-xs font-semibold tracking-[0.1em] uppercase">
        {title}
      </h2>
      <div className="space-y-5 bg-white/3 border border-white/8 rounded-2xl px-5 py-5">
        {children}
      </div>
    </section>
  );
}

/** Visual group separator that mirrors the TOC's group labels on the
 *  page itself. Larger than a Section title (which acts as a
 *  subsection within the group) and styled with a thin top border so
 *  group transitions read as clear breaks during a vertical scroll. */
function GroupHeader({ label }: { label: string }) {
  return (
    <div className="pt-4 first:pt-0">
      <div className="border-t border-white/10 pt-6">
        <p className="text-white/85 text-[15px] font-semibold tracking-wide">
          {label}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Table of Contents
//
// Stable ids per Section, grouped into top-level categories. The TOC sidebar
// renders these as collapsible groups; clicking either a category header or
// a leaf section smoothly scrolls the panel so the section's title sits at
// the top of the viewport. The ids must match the `id` props on each
// <Section> below.
// ---------------------------------------------------------------------------

type TocLeaf  = { id: string; label: string };
type TocGroup = {
  key: string;
  label: string;
  /** Subsections rendered indented under the group label. Clicking the
   *  group label scrolls to the first subsection; clicking a subsection
   *  scrolls to that section directly. */
  sections: TocLeaf[];
};

// Each entry is either a flat header (one Section, no subheader) or a
// header with multiple sub-sections. The TOC renders flat entries as a
// single clickable row; multi-section entries render the header plus an
// indented list of sub-section labels.
// Six high-level groups, each containing the related sections that used
// to sit at the top level of the TOC. The flat list (17 entries) was too
// long to scan and obscured the conceptual relationship between e.g.
// "Subtitle Style" and "Subtitles · Defaults". Nesting lets the user
// drill into the right area without reading every label first.
//
// SECTION IDS REMAIN STABLE — `id="sec-..."` in the JSX hasn't moved,
// only the navigation-tree structure here changes. Existing deep-link
// fragments and the search filter still target the same DOM nodes.
const TOC_GROUPS: TocGroup[] = [
  {
    key: "browse",
    label: "Browsing",
    sections: [
      { id: "sec-catalog",     label: "Catalog Providers" },
      { id: "sec-streams",     label: "Stream Providers" },
      { id: "sec-search",      label: "Search Providers" },
      { id: "sec-detail-page", label: "Detail Page" },
      { id: "sec-notifications", label: "Notifications" },
    ],
  },
  {
    key: "playback",
    label: "Playback",
    sections: [
      { id: "sec-video-audio",       label: "Video & Audio" },
      { id: "sec-audio-tracks",      label: "Audio Track Selection" },
      { id: "sec-subtitle-defaults", label: "Subtitles · Defaults" },
      { id: "sec-subtitle-style",    label: "Subtitle Style" },
      { id: "sec-anime-skip",        label: "Anime OP / ED Skip" },
      { id: "sec-keybindings",       label: "Keybindings" },
    ],
  },
  {
    key: "appearance",
    label: "Appearance & Window",
    sections: [
      { id: "sec-appearance", label: "Theme" },
      { id: "sec-window",     label: "Window & System" },
    ],
  },
  {
    key: "integrations",
    label: "Integrations",
    sections: [
      { id: "sec-discord",         label: "Discord Rich Presence" },
      { id: "sec-scrobble",        label: "Trakt & AniList" },
      { id: "sec-cloud-sync",      label: "Cloud Sync" },
      { id: "sec-api-keys",        label: "API Keys" },
      { id: "sec-crash-reporting", label: "Crash Reporting" },
    ],
  },
  {
    key: "system",
    label: "System",
    sections: [
      { id: "sec-performance", label: "Performance" },
      { id: "sec-storage",     label: "Storage" },
    ],
  },
  {
    key: "backup",
    label: "Backup & Restore",
    sections: [
      { id: "sec-backup", label: "Backup & Restore" },
    ],
  },
];

interface SettingsTocProps {
  scrollRoot: HTMLDivElement | null;
  /** Search state — when present, the TOC renders the search input
   *  underneath its list of contents so the page header can stay
   *  free of sticky chrome. The aside itself is `sticky top-6`, which
   *  keeps the search input in view while the user scrolls without
   *  needing a horizontal sticky bar overlay across the content. */
  search?: {
    value: string;
    onChange: (q: string) => void;
    matchCount: number | null;
    currentMatchIdx: number;
    onStepMatch: (delta: 1 | -1) => void;
  };
}

function SettingsToc({ scrollRoot, search }: SettingsTocProps) {
  // Always-expanded layout — the collapsing UX added complexity that the
  // user found more annoying than helpful. Every leaf is visible at once.
  const [activeId, setActiveId] = useState<string>(TOC_GROUPS[0].sections[0].id);

  const scrollToSection = (id: string) => {
    if (!scrollRoot) return;
    const el = scrollRoot.querySelector<HTMLElement>(`#${id}`);
    if (!el) return;
    setActiveId(id);
    // scrollIntoView respects the scroll-mt-6 utility on the Section so
    // the title isn't flush against the panel's top edge.
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // Keep the active highlight in sync with whichever section the user
  // is reading. Implementation history:
  //   1. Manual scroll listener that picked the section whose top was
  //      closest to a fixed 16 px offset. Broke for short sections.
  //   2. IntersectionObserver with a negative rootMargin "active band"
  //      between 25 %-50 % from top. The IO callback only fires on
  //      intersection state CHANGES — for sections taller than the
  //      band, neither edge of the band ever crosses the section's
  //      boundary while the user reads through, so no callback fires
  //      and the active id doesn't update.
  //   3. Cached sectionEls + plain scroll listener with rAF debouncing.
  //      Worked but cached the section list once at mount time, so
  //      anything gated by `{backend && (...)}` (Playback, Window,
  //      Integrations, Performance) was missing from the cache and
  //      never highlighted — the spy walk silently skipped over them.
  //   4. (current) Same rAF-debounced walk, but query DOM each frame
  //      instead of caching. 18 querySelector(`#id`) lookups per frame
  //      is microsecond-cheap and means async section mounts (backend
  //      resolution, conditional renders) join the spy walk the moment
  //      they appear.
  useEffect(() => {
    if (!scrollRoot) return;
    const ALL_SECTIONS = TOC_GROUPS.flatMap((g) => g.sections);

    let raf: number | null = null;
    const update = () => {
      raf = null;
      const rootRect = scrollRoot.getBoundingClientRect();
      const threshold = rootRect.top + 0.2 * rootRect.height;
      let candidate: string | null = null;
      let firstFound: string | null = null;
      for (const s of ALL_SECTIONS) {
        const el = scrollRoot.querySelector<HTMLElement>(`#${s.id}`);
        if (!el) continue;
        if (firstFound == null) firstFound = s.id;
        const top = el.getBoundingClientRect().top;
        if (top <= threshold) {
          candidate = s.id;
        } else {
          // Sections are in document order; first miss = nothing
          // further down can satisfy the condition either.
          break;
        }
      }
      const next = candidate ?? firstFound;
      if (next) setActiveId(next);
    };

    const onScroll = () => {
      if (raf == null) raf = requestAnimationFrame(update);
    };

    // Prime once now (initial mount + content layout) and again after
    // a frame to catch any post-mount layout shifts.
    update();
    requestAnimationFrame(update);

    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      scrollRoot.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [scrollRoot]);

  return (
    <nav className="text-[13px] leading-snug select-none space-y-4">
      <p className="text-white/35 text-[10.5px] font-mono uppercase tracking-[0.2em]">
        Contents
      </p>
      <ul className="space-y-2.5">
        {TOC_GROUPS.map((g) => {
          const isActiveGroup = g.sections.some((s) => s.id === activeId);
          // Flatten when the group has exactly one sub-section AND its
          // label is the same as the header — drops the redundant
          // subheader row that just repeated the parent name.
          const flat = g.sections.length === 1 && g.sections[0].label === g.label;
          return (
            <li key={g.key}>
              <button
                type="button"
                onClick={() => scrollToSection(g.sections[0].id)}
                className={`w-full text-left py-1
                            transition-colors
                            ${isActiveGroup ? "text-white/95" : "text-white/55 hover:text-white/85"}`}
              >
                <span className="font-medium">{g.label}</span>
              </button>
              {!flat && g.sections.length > 0 && (
                <ul className="ml-1 mt-1 space-y-1 border-l border-white/8 pl-3">
                  {g.sections.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => scrollToSection(s.id)}
                        className={`w-full text-left py-1 transition-colors
                                    ${s.id === activeId
                                      ? "text-ln-accent"
                                      : "text-white/45 hover:text-white/75"}`}
                      >
                        {s.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      {/* Search input lives at the FOOTER of the TOC sidebar instead
          of in a sticky page header. Two payoffs:
            • The whole content column reclaims the vertical strip the
              sticky bar used to consume — the user actually sees more
              of each section while scrolling.
            • Because the aside itself is `sticky top-6`, the search
              stays in view as the user scrolls without needing a
              second sticky context. */}
      {search && (
        <div className="pt-3 border-t border-white/8 space-y-2">
          <p className="text-white/35 text-[10.5px] font-mono uppercase tracking-[0.2em]">
            Search
          </p>
          <SettingsSearchInput
            value={search.value}
            onChange={search.onChange}
            matchCount={search.matchCount}
            currentMatchIdx={search.currentMatchIdx}
            onStepMatch={search.onStepMatch}
            compact
          />
        </div>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// AIOMetadata badge
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// KeybindRow — captures a KeyboardEvent.code on press
// ---------------------------------------------------------------------------

interface KeybindRowProps {
  action: KeybindAction;
  label: string;
  description: string;
  code: string;
  onChange: (next: string) => void;
}

function KeybindRow({ label, description, code, onChange }: KeybindRowProps) {
  const [capturing, setCapturing] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!capturing) return;
    // Capture-mode keydown handler. The user can either press a plain
    // key (records bare code, e.g. "Space") or hold Ctrl/Alt/Shift/Meta
    // and press a non-modifier (records "Ctrl+Digit1"). Modifier-only
    // presses are ignored — we wait for the actual chord-completing
    // keystroke before persisting.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        setCapturing(false);
        return;
      }
      const modifierCodes = [
        "ShiftLeft", "ShiftRight",
        "ControlLeft", "ControlRight",
        "AltLeft", "AltRight",
        "MetaLeft", "MetaRight",
        "OSLeft", "OSRight",
      ];
      if (modifierCodes.includes(e.code)) return;
      const spec = formatBinding({
        ctrl:  e.ctrlKey,
        alt:   e.altKey,
        shift: e.shiftKey,
        meta:  e.metaKey,
        code:  e.code,
      });
      onChange(spec);
      setCapturing(false);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true } as any);
  }, [capturing, onChange]);

  return (
    <button
      ref={ref}
      onClick={() => setCapturing(true)}
      className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 rounded-lg
                  text-left transition-colors
                  ${capturing
                    ? "bg-ln-accent/15 border border-ln-accent/40"
                    : "hover:bg-white/5 border border-white/8"
                  }`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <kbd
        className={`flex-shrink-0 min-w-[64px] px-2.5 py-1 rounded-md text-xs font-mono
                    text-center transition-colors
                    ${capturing
                      ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/50"
                      : "bg-white/8 text-white/75 border border-white/12"
                    }`}
      >
        {capturing ? "Press a key…" : code ? prettyBinding(code) : "Unbound"}
      </kbd>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ScrobbleAuthRow — one row in the new Trakt + AniList Settings section.
// Shows connection state ("Not connected" or "Connected as <user>"), a
// Connect button that opens the OAuth authorize URL in the user's
// default browser, and a Disconnect button when authenticated. The
// connection state is read on mount + whenever `aura:scrobble-auth-
// changed` fires (the deep-link handler in App.tsx dispatches it
// after persisting a token, the Disconnect handler dispatches it
// after clearing one).
//
// `scope` is the first 12 chars of the Stremio auth_key (or "guest"),
// matching the keyring layout in scrobble_auth.rs. Sharing a scope
// across components keeps the displayed status in sync with the
// stored token regardless of which Stremio account is signed in.
// ---------------------------------------------------------------------------

interface ScrobbleAuthSummary {
  username: string | null;
  expires_at: number | null;
  /** Token is approaching expiry (provider-specific window: 7d for
   *  AniList, 24h for Trakt). Soft warning. */
  stale: boolean;
  /** Token has already lapsed. Hard reconnect required: AniList
   *  cannot refresh, Trakt's refresh endpoint is not yet wired
   *  through the proxy. */
  expired: boolean;
}

/** Format a Unix-seconds expiry into a "Mon DD, YYYY · HH:MM" string in
 *  the user's locale + timezone. Returns `null` if the timestamp is
 *  outside any sane range (NaN, 0, etc.) so the caller can fall back
 *  to "No expiry reported". */
function formatExpiryAbsolute(expiresAt: number | null): string | null {
  if (expiresAt == null) return null;
  const date = new Date(expiresAt * 1000);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return null;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Pick the coarsest reasonable unit so the relative qualifier reads
 *  naturally ("in 23 days" rather than "in 1987200 seconds"). Uses
 *  `Intl.RelativeTimeFormat` with `numeric: "always"` so the output is
 *  always quantitative ("1 day ago", never "yesterday") — matches the
 *  precision the task asked for. */
function formatExpiryRelative(diffMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" });
  const sec = Math.round(diffMs / 1000);
  if (Math.abs(sec) < 60)  return rtf.format(sec, "second");
  const min = Math.round(diffMs / 60_000);
  if (Math.abs(min) < 60)  return rtf.format(min, "minute");
  const hr  = Math.round(diffMs / 3_600_000);
  if (Math.abs(hr)  < 24)  return rtf.format(hr,  "hour");
  const day = Math.round(diffMs / 86_400_000);
  if (Math.abs(day) < 30)  return rtf.format(day, "day");
  const mon = Math.round(diffMs / (86_400_000 * 30));
  if (Math.abs(mon) < 12)  return rtf.format(mon, "month");
  const yr  = Math.round(diffMs / (86_400_000 * 365));
  return rtf.format(yr, "year");
}

function ScrobbleAuthRow({
  service, authKey, description,
}: {
  service: "trakt" | "anilist";
  authKey: string | null;
  description: string;
}) {
  const scope = authKey ? authKey.slice(0, 12) : "guest";
  const label = service === "trakt" ? "Trakt" : "AniList";
  // Trakt supports OAuth 2.0 device flow (RFC 8628), which sidesteps
  // the browser → custom-URL-scheme → OS handler chain that broke on
  // Firefox + Aura's dev build. AniList doesn't expose device-flow
  // endpoints, so it stays on the legacy authorize-URL + deep-link
  // path until upstream changes.
  const useDeviceFlow = service === "trakt";

  const [status, setStatus] = useState<ScrobbleAuthSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // Auth-code (deep-link) waiting state — only used by AniList now.
  const [pending, setPending] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  // 60s tick driving the "expires in N days" relative qualifier. Without
  // this, the Settings page could sit open for hours showing a stale
  // "in 23 days" line that should read "in 22 days". Only ticks when
  // an expiring token is connected — guests / non-expiring tokens skip.
  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    if (!status || status.expires_at == null) return;
    const id = window.setInterval(() => setTickNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [status]);

  // Device-flow state. When set, the row renders the user_code +
  // verification URL + Cancel button, and a poll loop runs until the
  // proxy returns Authorized (clears) / Expired / Denied / Error.
  interface DeviceFlowState {
    user_code:        string;
    verification_url: string;
    device_code:      string;
    /** Wall-clock ms when the device_code expires. */
    expires_at:       number;
    /** Polling interval in ms (start at server-suggested, may grow on slow_down). */
    interval_ms:      number;
  }
  const [deviceFlow, setDeviceFlow] = useState<DeviceFlowState | null>(null);

  const clearWaiting = useCallback(() => {
    setPending(false);
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    sessionStorage.removeItem(`aura:oauth:pending:${service}`);
  }, [service]);

  const refresh = useCallback(() => {
    invoke<{ trakt: ScrobbleAuthSummary | null; anilist: ScrobbleAuthSummary | null }>(
      "get_scrobble_auth_status",
      { scope },
    )
      .then((s) => setStatus(service === "trakt" ? s.trakt : s.anilist))
      .catch(() => setStatus(null));
  }, [scope, service]);

  useEffect(() => {
    refresh();
    // Deep-link arrival (AniList path): App.tsx persists the token,
    // then dispatches this event. Device-flow polling dispatches the
    // same event after a successful poll.
    const onChanged = () => {
      refresh();
      clearWaiting();
      setDeviceFlow(null);
    };
    window.addEventListener("aura:scrobble-auth-changed", onChanged);
    return () => {
      window.removeEventListener("aura:scrobble-auth-changed", onChanged);
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [refresh, clearWaiting]);

  // Device-flow poll loop. Runs while `deviceFlow` is set, polls the
  // proxy at the server-suggested interval, dispatches scrobble-auth-
  // changed on success (which clears `deviceFlow` via the listener
  // above). Honours `slow_down` by adding 5 s to the interval.
  useEffect(() => {
    if (!deviceFlow) return;
    let cancelled = false;
    let intervalMs = deviceFlow.interval_ms;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (Date.now() >= deviceFlow.expires_at) {
        setDeviceFlow(null);
        showAppToast(
          `${label} authorization timed out. The code expired before you finished. Try again.`,
          { duration: 6000 },
        );
        return;
      }
      try {
        const resp = await invoke<{ status: string; username?: string | null; message?: string }>(
          "scrobble_oauth_device_poll",
          { service, scope, deviceCode: deviceFlow.device_code },
        );
        if (cancelled) return;
        switch (resp.status) {
          case "authorized":
            window.dispatchEvent(new CustomEvent("aura:scrobble-auth-changed"));
            showAppToast(
              `Connected to ${label}${resp.username ? ` as ${resp.username}` : ""}`,
              { duration: 4000 },
            );
            return;
          case "pending":
            break;
          case "slow_down":
            intervalMs = Math.min(intervalMs + 5000, 30000);
            break;
          case "expired":
            setDeviceFlow(null);
            showAppToast(
              `${label} code expired before authorization completed. Try again.`,
              { duration: 5000 },
            );
            return;
          case "denied":
            setDeviceFlow(null);
            showAppToast(`${label} authorization was denied.`, { duration: 5000 });
            return;
          case "error":
          default:
            setDeviceFlow(null);
            showAppToast(
              `${label} auth failed: ${resp.message || resp.status}`,
              { duration: 6000 },
            );
            return;
        }
      } catch (e) {
        // Network blip: don't kill the flow, just keep polling on
        // schedule. The expires_at gate will end the loop if we never
        // reach the proxy again.
        console.warn(`[scrobble] device poll failed:`, e);
      }
      if (!cancelled) {
        timer = window.setTimeout(tick, intervalMs);
      }
    };

    timer = window.setTimeout(tick, deviceFlow.interval_ms);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [deviceFlow, service, scope, label]);

  const connect = useCallback(async () => {
    if (busy || pending || deviceFlow) return;
    setBusy(true);
    try {
      // Both providers route their auth UI through the in-app
      // SourcePopup (a child Tauri Webview) instead of the system
      // browser. This sidesteps a class of browser bugs around
      // automatic redirects to non-HTTP custom schemes (Firefox
      // silently dropping `aura://` 302s, etc.) and keeps the entire
      // flow inside Aura's process. AniList additionally registers a
      // navigation interceptor on the popup so the proxy's terminal
      // `aura://oauth/anilist?...` redirect is caught and re-emitted
      // as a `deep-link` event — the existing App.tsx handler then
      // persists the token through the same code path the OS scheme
      // handler would have taken. Trakt doesn't need the interceptor
      // because device-flow polling drives auth detection.
      const { openOAuthPopup } = await import("../SourcePopup");

      if (useDeviceFlow) {
        // Trakt: device-flow path. No deep-link involvement; we poll.
        const begin = await invoke<{
          user_code:        string;
          verification_url: string;
          device_code:      string;
          expires_in:       number;
          interval:         number;
        }>("scrobble_oauth_device_begin", { service });
        setDeviceFlow({
          user_code:        begin.user_code,
          verification_url: begin.verification_url,
          device_code:      begin.device_code,
          expires_at:       Date.now() + begin.expires_in * 1000,
          interval_ms:      Math.max(2000, begin.interval * 1000),
        });
        // Open the activation page so the user can paste/type the code
        // immediately. The popup self-closes when the device-flow poll
        // returns Authorized (via the aura:scrobble-auth-changed event
        // SourcePopup listens for in OAuth mode).
        //
        // Surface the user_code as a chip in the popup header (and on
        // the floating minimize pill) so it's always visible alongside
        // trakt.tv/activate — no need to dismiss or minimize the
        // popup just to read the code.
        openOAuthPopup(begin.verification_url, `Connect to ${label}`, {
          userCode: begin.user_code,
        });
      } else {
        // AniList: authorize-URL + deep-link path, but the deep-link
        // is intercepted inside the popup webview rather than handed
        // off to the OS scheme handler via the system browser.
        sessionStorage.setItem(`aura:oauth:pending:${service}`, scope);
        const url = await invoke<string>("scrobble_oauth_authorize_url", { service });
        openOAuthPopup(url, `Connect to ${label}`, {
          interceptPrefix: `aura://oauth/${service}`,
        });
        setPending(true);
        // Safety timer — if the user closes the popup without
        // authorizing (or the proxy never redirects to the intercept
        // prefix), we still want the row's "Connecting…" state to
        // clear. Keeps the existing 2-minute window.
        timeoutRef.current = window.setTimeout(() => {
          timeoutRef.current = null;
          setPending(false);
          sessionStorage.removeItem(`aura:oauth:pending:${service}`);
          showAppToast(
            `${label} authorization didn't complete. Try again.`,
            { duration: 6000 },
          );
        }, 120_000);
      }
    } catch (e) {
      sessionStorage.removeItem(`aura:oauth:pending:${service}`);
      showAppToast(`Couldn't start ${label} auth: ${String(e)}`, { duration: 5000 });
    } finally {
      setBusy(false);
    }
  }, [busy, pending, deviceFlow, service, scope, useDeviceFlow, label]);

  const cancelPending = useCallback(() => {
    clearWaiting();
    setDeviceFlow(null);
  }, [clearWaiting]);

  const copyUserCode = useCallback(async () => {
    if (!deviceFlow) return;
    try {
      await navigator.clipboard.writeText(deviceFlow.user_code);
      showAppToast("Code copied", { duration: 2000 });
    } catch {
      // Clipboard API may be blocked; non-fatal — code is still
      // visible on screen for the user to type manually.
    }
  }, [deviceFlow]);

  const reopenVerification = useCallback(async () => {
    if (!deviceFlow) return;
    try {
      // Reopen the activation page in the same in-app popup the
      // initial Connect click used. The device-flow poll in the
      // background continues polling regardless of which popup is
      // visible; we just need to make the activation URL accessible
      // again if the user dismissed the first popup.
      const { openOAuthPopup } = await import("../SourcePopup");
      openOAuthPopup(deviceFlow.verification_url, `Connect to ${label}`, {
        userCode: deviceFlow.user_code,
      });
    } catch (e) {
      showAppToast(`Couldn't open ${deviceFlow.verification_url}: ${String(e)}`, { duration: 5000 });
    }
  }, [deviceFlow, label]);

  const disconnect = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await invoke("clear_scrobble_auth_token", { service, scope });
      window.dispatchEvent(new CustomEvent("aura:scrobble-auth-changed"));
    } catch (e) {
      showAppToast(`Disconnect failed: ${String(e)}`, { duration: 5000 });
    } finally {
      setBusy(false);
    }
  }, [busy, service, scope]);

  const connected = !!status;

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-white/85 text-sm font-medium">{label}</p>
          <p className="text-white/55 text-xs leading-relaxed">{description}</p>
        </div>
        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
          {deviceFlow ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                                font-semibold uppercase tracking-wider
                                bg-amber-500/15 text-amber-200 border border-amber-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Awaiting authorization
              </span>
              <button
                type="button"
                onClick={cancelPending}
                className="px-3 py-1 rounded-lg border border-white/15 bg-white/5
                           text-white/75 text-[11px] font-medium tracking-wide
                           hover:bg-white/10 hover:text-white
                           transition-colors"
              >
                Cancel
              </button>
            </>
          ) : pending ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                                font-semibold uppercase tracking-wider
                                bg-amber-500/15 text-amber-200 border border-amber-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                Waiting for authorization…
              </span>
              <button
                type="button"
                onClick={cancelPending}
                className="px-3 py-1 rounded-lg border border-white/15 bg-white/5
                           text-white/75 text-[11px] font-medium tracking-wide
                           hover:bg-white/10 hover:text-white
                           transition-colors"
              >
                Cancel
              </button>
            </>
          ) : connected && status?.expired ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                                font-semibold uppercase tracking-wider
                                bg-rose-500/15 text-rose-300 border border-rose-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
                {status?.username ? `Expired · ${status.username}` : "Expired"}
              </span>
              {/* Absolute + relative expiry timestamp for the expired
                  branch. Useful diagnostic ("why am I being asked to
                  reconnect now?") and grounds the rose badge in a
                  concrete date. */}
              {(() => {
                const absolute = formatExpiryAbsolute(status?.expires_at ?? null);
                if (!absolute || status?.expires_at == null) return null;
                const relative = formatExpiryRelative(status.expires_at * 1000 - tickNow);
                return (
                  <div className="text-[10px] leading-tight text-right text-rose-300/80">
                    <div>Expired {absolute}</div>
                    <div className="text-rose-300/60">{relative}</div>
                  </div>
                );
              })()}
              <button
                type="button"
                onClick={connect}
                disabled={busy}
                className="px-3 py-1 rounded-lg border border-ln-accent/35 bg-ln-accent/15
                           text-ln-accent text-[11px] font-medium tracking-wide
                           hover:bg-ln-accent/25 hover:border-ln-accent/55
                           transition-colors disabled:opacity-50"
              >
                Reconnect
              </button>
            </>
          ) : connected ? (
            <>
              <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px]
                                font-semibold uppercase tracking-wider
                                bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                {status?.username ? `Connected · ${status.username}` : "Connected"}
              </span>
              {/* Live expiry readout. Amber when the token enters the
                  provider-specific stale window (7d AniList / 24h Trakt)
                  so the user notices before it lapses; neutral otherwise.
                  Renders "No expiry reported" for providers that issue
                  non-expiring tokens (AniList Implicit Grant, etc.) so
                  the absence of a date is explained rather than hidden. */}
              {(() => {
                if (status?.expires_at == null) {
                  return (
                    <div className="text-[10px] leading-tight text-right text-white/35">
                      No expiry reported
                    </div>
                  );
                }
                const absolute = formatExpiryAbsolute(status.expires_at);
                if (!absolute) return null;
                const relative = formatExpiryRelative(status.expires_at * 1000 - tickNow);
                const tone = status.stale
                  ? { primary: "text-amber-300/90", secondary: "text-amber-300/70" }
                  : { primary: "text-white/55",     secondary: "text-white/35"     };
                return (
                  <div className={`text-[10px] leading-tight text-right ${tone.primary}`}>
                    <div>Expires {absolute}</div>
                    <div className={tone.secondary}>{relative}</div>
                  </div>
                );
              })()}
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                className="px-3 py-1 rounded-lg border border-white/15 bg-white/5
                           text-white/75 text-[11px] font-medium tracking-wide
                           hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-300/40
                           transition-colors disabled:opacity-50"
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={connect}
              disabled={busy}
              className="px-3 py-1 rounded-lg border border-ln-accent/35 bg-ln-accent/15
                         text-ln-accent text-[11px] font-medium tracking-wide
                         hover:bg-ln-accent/25 hover:border-ln-accent/55
                         transition-colors disabled:opacity-50"
            >
              Connect {label}
            </button>
          )}
        </div>
      </div>
      {deviceFlow && (
        <div className="mt-2 rounded-lg border border-amber-400/25 bg-amber-500/[0.06]
                        p-3 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-white/70 text-[11px] leading-snug mb-1">
              Open Trakt and enter this code to authorize Aura. Aura will
              connect automatically once you click Allow.
            </p>
            <div className="flex items-center gap-2">
              <code className="font-mono tracking-[0.25em] text-[15px]
                               text-amber-200 bg-black/30 rounded px-2.5 py-1
                               border border-amber-400/20 select-all">
                {deviceFlow.user_code}
              </code>
              <button
                type="button"
                onClick={copyUserCode}
                className="px-2.5 py-1 rounded-md border border-white/15 bg-white/5
                           text-white/75 text-[10.5px] font-medium tracking-wide
                           hover:bg-white/10 hover:text-white transition-colors"
              >
                Copy
              </button>
              <button
                type="button"
                onClick={reopenVerification}
                className="px-2.5 py-1 rounded-md border border-white/15 bg-white/5
                           text-white/75 text-[10.5px] font-medium tracking-wide
                           hover:bg-white/10 hover:text-white transition-colors"
              >
                Open Trakt
              </button>
            </div>
            <p className="text-white/40 text-[10.5px] mt-1.5 truncate">
              {deviceFlow.verification_url}
            </p>
          </div>
        </div>
      )}
      {status?.expired && !pending && !deviceFlow && (
        <p className="text-rose-400/90 text-xs">
          {service === "anilist"
            ? "AniList token expired. AniList does not support refresh, so click Connect to re-authorize."
            : "Trakt token expired. Click Connect to re-authorize."}
        </p>
      )}
      {status?.stale && !status?.expired && !pending && !deviceFlow && (
        <p className="text-amber-400/80 text-xs">
          {service === "anilist"
            ? "AniList token expires within a week. Reconnect to extend (no automatic renewal)."
            : "Token expires soon. Reconnect to refresh."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SettingsView
// ---------------------------------------------------------------------------

interface Props {
  addons: AddonEntry[];
  session: UserSession | null;
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

interface CrashReportingConfig {
  consent: boolean | null;
  dsn: string;
}

export default function SettingsView({ addons, session }: Props) {
  const [aura, setAura] = useState<AuraSettings>(loadAuraSettings);
  const [backend, setBackend] = useState<BackendSettings | null>(null);
  // Crash reporting consent + DSN live in a global sidecar (not the
  // per-scope AppSettings) so opting in once survives every Stremio
  // login / logout. See src-tauri/src/crash_reporting.rs.
  const [crashConfig, setCrashConfig] = useState<CrashReportingConfig | null>(null);
  const { theme, setTheme } = useTheme();

  // Track whether we've finished the first mount so the initial backend
  // load + the first localStorage hydration don't fire a "Settings saved"
  // toast for a no-op.
  const hydratedRef = useRef(false);

  // ── Toast debouncer ──────────────────────────────────────────────────
  // Every keystroke in a text field drives a `patchBackend` (live save).
  // Showing a toast for each one stacks 3+ "Settings saved" pills when
  // the user is just typing a word. Coalesce to one toast that fires
  // after typing settles for TOAST_QUIET_MS — fast enough that discrete
  // clicks (toggles, selects) still feel acknowledged immediately, but
  // slow enough that a typed word produces a single confirmation.
  const TOAST_QUIET_MS = 700;
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSavedToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      showAppToast("Settings saved");
      toastTimerRef.current = null;
    }, TOAST_QUIET_MS);
  }, []);
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  // Persist localStorage settings whenever they change
  useEffect(() => {
    saveAuraSettings(aura);
    if (hydratedRef.current) queueSavedToast();
  }, [aura, queueSavedToast]);

  // Load backend settings on mount
  useEffect(() => {
    invoke<BackendSettings>("get_settings")
      .then((b) => {
        setBackend(b);
        hydratedRef.current = true;
      })
      .catch(() => { hydratedRef.current = true; });
  }, []);

  // Load + watch the crash-reporting sidecar. Refresh whenever the
  // consent modal or another tab writes — keeps both surfaces in sync
  // (`aura:crash-reporting-changed` is the canonical event).
  useEffect(() => {
    const refresh = () => {
      invoke<CrashReportingConfig>("get_crash_reporting")
        .then(setCrashConfig)
        .catch(() => setCrashConfig({ consent: null, dsn: "" }));
    };
    refresh();
    window.addEventListener("aura:crash-reporting-changed", refresh);
    return () => window.removeEventListener("aura:crash-reporting-changed", refresh);
  }, []);

  // Round-trip a partial crash-reporting patch through the new
  // sidecar-aware Tauri command. Mirrors patchBackend's optimistic
  // shape so the toggle and DSN field feel identical to the rest
  // of the page.
  const patchCrashConfig = useCallback(
    async (patch: Partial<CrashReportingConfig>) => {
      try {
        const updated = await invoke<CrashReportingConfig>("set_crash_reporting", {
          consent: patch.consent ?? null,
          dsn: patch.dsn ?? null,
        });
        setCrashConfig(updated);
        queueSavedToast();
        window.dispatchEvent(new CustomEvent("aura:crash-reporting-changed"));
      } catch {
        // optimistic UI keeps its state
      }
    },
    [queueSavedToast],
  );

  // Patch a backend setting and round-trip through update_settings.
  const patchBackend = useCallback(async (patch: Partial<BackendSettings>) => {
    try {
      const updated = await invoke<BackendSettings>("update_settings", { patch });
      setBackend(updated);
      queueSavedToast();
      // Live-apply subtitle styling — when the user adjusts size/colour/etc.
      // we want the change to show up immediately in the active player
      // without waiting for the next stream load.
      if (Object.keys(patch).some((k) => k.startsWith("subtitle_"))) {
        invoke("apply_subtitle_style").catch(() => {});
      }
    } catch {
      // ignore — UI keeps its optimistic state
    }
  }, [queueSavedToast]);

  const setLocal = (patch: Partial<AuraSettings>) =>
    setAura((prev) => ({ ...prev, ...patch }));

  const addonOptions = addons.map((a) => ({ value: a.url, label: a.name }));
  const themeOptions: { value: ThemeId; label: string }[] =
    (Object.entries(THEME_LABELS) as [ThemeId, string][]).map(([value, label]) => ({ value, label }));

  // Pre-compute the URL list shown in the Stream Providers picker. While
  // streamAddonUrls is null (the backward-compatible default), the picker
  // reflects "every stream addon is queried" by showing all of them as
  // selected; the user's first edit then commits a specific array.
  const effectiveStreamUrls = aura.streamAddonUrls
    ?? addons.filter(isStreamProvider).map((a) => a.url);

  // Same pattern for the Search Providers + Search Suggestion Providers
  // pickers. `null` (default) means "every search-capable addon"; the
  // first edit commits a concrete array to the relevant key.
  const effectiveSearchUrls = aura.searchAddonUrls
    ?? addons.filter(isSearchProvider).map((a) => a.url);
  const effectiveSearchSuggestionUrls = aura.searchSuggestionAddonUrls
    ?? addons.filter(isSearchProvider).map((a) => a.url);

  // The scroll container the TOC observes for active-section highlighting
  // AND the target for `scrollIntoView`. Captured via ref so the TOC can
  // access it once the DOM is mounted.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setScrollEl(scrollRef.current); }, []);

  // ── Settings search ───────────────────────────────────────────────────
  //
  // Forgiving fuzzy filter over visible Sections. Each whitespace-separated
  // token in the query must appear as a CHARACTER SUBSEQUENCE in the
  // section's text content (case-insensitive) — so "subfsz" matches
  // "Subtitle Font Size" without the user having to type the words
  // verbatim. Sections that don't match are visually hidden via inline
  // display:none + opacity transition; the underlying React tree stays
  // mounted so re-typing is instant and component state is preserved.
  //
  // Implementation runs as a layout effect on `query` so the DOM is
  // updated synchronously after each keystroke. We also fire it on
  // section-content changes (sections may render new fields when other
  // settings flip) by re-querying on every effect run.
  const [searchQuery, setSearchQuery] = useState("");
  const matchCountRef = useRef(0);
  const [matchCount, setMatchCount] = useState<number | null>(null);
  /** Ordered list of section IDs that match the current search. Used
   *  by the prev / next match-stepper buttons in the search bar so
   *  the user can hop between matched sections without scrolling. */
  const [matchedIds, setMatchedIds] = useState<string[]>([]);
  /** Index of the currently-focused match within `matchedIds`. -1 when
   *  no match is focused (initial state). */
  const [currentMatchIdx, setCurrentMatchIdx] = useState(-1);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    // Cleanup the legacy section-level highlight in case a previous
    // build of this code left one on a re-render boundary. Cheap
    // belt-and-braces.
    root.querySelectorAll(".settings-section-matched").forEach((s) =>
      s.classList.remove("settings-section-matched"));

    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-settings-row]"));
    const q = searchQuery.trim();
    if (!q) {
      rows.forEach((r) => r.classList.remove("settings-row-matched"));
      matchCountRef.current = 0;
      setMatchCount(null);
      setMatchedIds([]);
      setCurrentMatchIdx(-1);
      return;
    }
    let matches = 0;
    const matchedNow: string[] = [];
    rows.forEach((r, idx) => {
      const label       = r.getAttribute("data-settings-label") ?? "";
      const description = r.getAttribute("data-settings-description") ?? "";
      const ok = matchesSettingRow(q, label, description);
      if (ok) {
        matches += 1;
        // DOM-position-based id — stable within a render and unique
        // even if two settings happen to share a label.
        matchedNow.push(String(idx));
        r.classList.add("settings-row-matched");
      } else {
        r.classList.remove("settings-row-matched");
      }
    });
    matchCountRef.current = matches;
    setMatchCount(matches);
    setMatchedIds(matchedNow);
    // Reset to the first match when the matched-list changes — the
    // user typically wants to start at the top of results.
    setCurrentMatchIdx(matchedNow.length > 0 ? 0 : -1);
  }, [searchQuery]);

  // Auto-scroll to the focused match. Runs whenever the index moves
  // (prev / next clicks) or the matched-list changes. Each id in
  // `matchedIds` is a DOM-position index into the row NodeList; we
  // re-query the rows here rather than holding refs because rows
  // can unmount/remount across renders (conditionally-rendered
  // sections like AutoAdvanceDelayRow).
  useEffect(() => {
    if (currentMatchIdx < 0) return;
    const idxStr = matchedIds[currentMatchIdx];
    if (!idxStr) return;
    const rowIdx = Number(idxStr);
    const rows = scrollRef.current?.querySelectorAll<HTMLElement>("[data-settings-row]");
    const el = rows?.[rowIdx];
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [currentMatchIdx, matchedIds]);

  const stepMatch = useCallback((delta: 1 | -1) => {
    setCurrentMatchIdx((prev) => {
      if (matchedIds.length === 0) return -1;
      const start = prev < 0 ? 0 : prev;
      const next = (start + delta + matchedIds.length) % matchedIds.length;
      return next;
    });
  }, [matchedIds.length]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto flex items-center justify-center"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        {/* Outer centering container: caps total width so the layout sits
            middle-of-screen on ultrawide. The flex centring on the parent
            keeps the WHOLE layout vertically centred when the content is
            short; tall content scrolls normally.
            Three-column grid (TOC | content | mirror) keeps the settings
            content visually centred on the page regardless of the TOC.
            The empty third column mirrors the TOC's 200 px so the content
            sits at exact grid centre, and mx-auto on the grid centres the
            whole thing on the viewport. maxWidth is bumped from 1100 →
            1340 to absorb the extra 240 px (200 mirror + 40 gap) without
            shrinking the content column. */}
        <div
          className="mx-auto my-auto px-8 py-6 grid gap-10 w-full"
          style={{
            maxWidth: "min(1340px, 95%)",
            gridTemplateColumns: "200px minmax(0, 1fr) 200px",
          }}
        >
          {/* TOC — sticky so it stays in view while the user scrolls.
              The search input now lives at the BOTTOM of this sidebar
              (instead of in a sticky page header) so the content
              column doesn't lose vertical real estate to a fixed bar. */}
          <aside className="sticky top-6 self-start">
            <SettingsToc
              scrollRoot={scrollEl}
              search={{
                value: searchQuery,
                onChange: setSearchQuery,
                matchCount,
                currentMatchIdx,
                onStepMatch: stepMatch,
              }}
            />
          </aside>

          {/* Settings content column. No more sticky page header — the
              first section's title sits at the same vertical baseline
              as the TOC's "Contents" heading so the two columns align
              cleanly at the top of the viewport. */}
          <div className="space-y-6">
          {searchQuery.trim() && matchCount === 0 && (
            <div
              role="status"
              className="text-center px-4 py-10 rounded-2xl
                         bg-white/3 border border-white/8
                         text-white/55 text-sm
                         animate-[settings-fade-in_180ms_ease-out]"
            >
              <p className="text-white/85 text-base mb-1">No settings match
                <span className="font-mono text-ln-accent ml-2">"{searchQuery.trim()}"</span>
              </p>
              <p className="text-white/40 text-xs">
                Try fewer or shorter terms. The search is forgiving but needs the
                characters to appear in order.
              </p>
            </div>
          )}

          {/* Sections render in TOC order (Browsing → Playback →
              Appearance → Integrations → System → Backup) so the
              scrollspy walks the TOC list top-to-bottom as the user
              scrolls. Group separators below mirror the TOC groups
              so the page itself reads as the same hierarchy. */}

          <GroupHeader label="Browsing" />

          {/* Catalog providers — filtered to addons that actually serve
              metadata or addon-catalog content so stream-only and
              subtitle-only addons don't clutter the picker. */}
          <Section id="sec-catalog" title="Catalog Providers">
            <UnifiedHomeSourcesPicker
              addons={addons}
              primaryUrl={aura.defaultHomeAddonUrl}
              additionalUrls={aura.additionalHomeAddonUrls}
              filter={isCatalogProvider}
              onChange={(primary, additional) => setLocal({
                defaultHomeAddonUrl: primary,
                additionalHomeAddonUrls: additional,
              })}
            />
            <div className="h-px bg-white/6" />
            <SettingDropdown
              label="Default Metadata Provider"
              description="Preferred addon for fetching movie and series details."
              value={aura.defaultMetadataAddonUrl}
              options={addonOptions}
              onChange={(v) => setLocal({ defaultMetadataAddonUrl: v })}
            />
            <div className="h-px bg-white/6" />
            <HeroCatalogPicker
              addons={addons}
              value={aura.heroCatalog}
              onChange={(v) => setLocal({ heroCatalog: v })}
            />
          </Section>

          {/* Stream providers — filtered to addons declaring the stream
              resource. The list controls which addons fetch_streams
              actually queries. While streamAddonUrls is null (the
              backward-compatible default), every stream-resource addon is
              queried; the picker reflects that by showing all of them as
              selected. The user's first edit commits a specific array. */}
          <Section id="sec-streams" title="Stream Providers">
            <UnifiedHomeSourcesPicker
              addons={addons}
              filter={isStreamProvider}
              primaryUrl={effectiveStreamUrls[0] ?? null}
              additionalUrls={effectiveStreamUrls.slice(1)}
              onChange={(primary, additional) => {
                const urls = [
                  ...(primary ? [primary] : []),
                  ...additional,
                ];
                setLocal({ streamAddonUrls: urls });
              }}
              title="Active Stream Providers"
              description={
                aura.streamAddonUrls === null
                  ? "All installed stream addons are queried (default). Remove any addon to stop sending it stream-fetch requests."
                  : "Drag to reorder. Only the listed addons are queried for streams; remove an entry to skip it on every lookup."
              }
            />
          </Section>

          {/* ── Search Providers ──────────────────────────────────────────
              Two separate lists for the two distinct search code paths:

                • "Search Providers" — addons hit on a deliberate Enter
                  search (the SearchView grouped results). Cost-tolerant:
                  expensive AI providers belong here.
                • "Suggestion Providers" — addons hit on every debounced
                  keystroke pause for the live dropdown. Latency / cost
                  sensitive: drop AI / slow providers from this list to
                  keep typing snappy without losing them on submit.

              Defaults to "all search-capable installed addons" for both
              lists; the first user edit commits a concrete array. */}
          <Section id="sec-search" title="Search Providers">
            <UnifiedHomeSourcesPicker
              addons={addons}
              filter={isSearchProvider}
              primaryUrl={effectiveSearchUrls[0] ?? null}
              additionalUrls={effectiveSearchUrls.slice(1)}
              onChange={(primary, additional) => {
                const urls = [
                  ...(primary ? [primary] : []),
                  ...additional,
                ];
                setLocal({ searchAddonUrls: urls });
              }}
              title="On Submit (Enter)"
              description={
                aura.searchAddonUrls === null
                  ? "All installed search-capable addons are queried when you press Enter (default). Drag to reorder once you make any edit."
                  : "Drag to reorder. Only the listed addons run on submit; remove an entry to skip it for full-search results."
              }
            />
            <div className="h-px bg-white/6" />
            <UnifiedHomeSourcesPicker
              addons={addons}
              filter={isSearchProvider}
              primaryUrl={effectiveSearchSuggestionUrls[0] ?? null}
              additionalUrls={effectiveSearchSuggestionUrls.slice(1)}
              onChange={(primary, additional) => {
                const urls = [
                  ...(primary ? [primary] : []),
                  ...additional,
                ];
                setLocal({ searchSuggestionAddonUrls: urls });
              }}
              title="Live Suggestions (while typing)"
              description={
                aura.searchSuggestionAddonUrls === null
                  ? "All installed search-capable addons feed the typing-suggestions dropdown (default). Remove expensive ones (e.g. AI search) to keep typing snappy without losing them on submit."
                  : "Drag to reorder. Only the listed addons feed the typing-suggestions dropdown; submit-search providers are configured above."
              }
            />
          </Section>

          {/* ── Detail Page ───────────────────────────────────────────────
              Toggles affecting the detail-page surface specifically.
              Currently a single hideCastSpoilers gate for the cast-card
              hover overlay (Main / Recurring / Guest tier + episode
              counts). Some shows lean on regular-vs-guest billing as a
              plot beat (deaths, returns, cameos) so the count alone
              can spoil. */}
          <Section id="sec-detail-page" title="Detail Page">
            <SettingToggle
              label="Hide cast episode counts"
              description="Some shows treat regular vs. guest billing as a plot beat (deaths, returns, surprise cameos). When on, the cast hover card shows just the name; per-actor episode counts and tier are hidden."
              value={aura.hideCastSpoilers}
              onChange={(v) => setLocal({ hideCastSpoilers: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Show AIOStreams notices"
              description="Show filter, timing, and scrape-summary notices plus addon errors as small icon badges over the streams panel. Notices the addon flags as un-suppressible (e.g. the Digital Release Filter warning) always show, regardless of this toggle."
              value={aura.showAioStreamsNotices}
              onChange={(v) => setLocal({ showAioStreamsNotices: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Blur unwatched episode thumbnails"
              description="Hide episode thumbnails behind a blur until the episode is marked watched (manually or auto-derived from playback progress). Useful for thrillers, mystery shows, and anime where the thumbnail itself spoils the episode."
              value={aura.blurUnwatchedThumbnails}
              onChange={(v) => setLocal({ blurUnwatchedThumbnails: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Blur selected episode synopsis"
              description="Hide the per-episode synopsis text that appears below the show synopsis when you select an episode. Click to reveal per episode. Watched episodes always show their synopsis without blur — the content's no longer a spoiler. Useful for mystery / thriller / weekly-airing anime where the per-episode description gives away plot beats."
              value={aura.blurEpisodeSynopsis}
              onChange={(v) => setLocal({ blurEpisodeSynopsis: v })}
            />
          </Section>

          {/* ── Notifications ─────────────────────────────────────────────
              The bell's "new episode aired" notifications are scheduled
              by NotificationsScanner against your library's series/anime
              entries. By default the scanner notifies the moment an
              addon publishes a recently-released episode; this toggle
              additionally gates on stream availability for users whose
              addon mix occasionally publishes episodes hours or days
              before any source becomes scrapable. */}
          <Section id="sec-notifications" title="Notifications">
            <SettingToggle
              label="Only notify when a stream is available"
              description="When on, the bell waits to fire a new-episode notification until at least one playable stream is found across your installed addons. Adds a small per-episode network check at scan time (cached for 12 hours so re-scans are free). Off by default: the bell fires the moment an episode is marked released, even if scrapers haven't caught up yet."
              value={aura.notifyOnlyWithStreams}
              onChange={(v) => setLocal({ notifyOnlyWithStreams: v })}
            />
          </Section>

          <GroupHeader label="Playback" />

          {/* Video & Audio quality */}
          {backend && (
            <Section id="sec-video-audio" title="Video & Audio">
              <SettingDropdown
                label="HDR mode"
                description={
                  // Keep this short — the user reading this is debugging
                  // playback colour, not learning colour science.
                  "Pick what to do with HDR sources. \"Tone-map for SDR\" is the safe default for laptop / desktop monitors. \"Passthrough\" is for HDR-capable TVs/monitors with HDR enabled in OS settings. \"Off\" disables all HDR processing."
                }
                value={(() => {
                  const m = (backend.hdr_mode ?? "").trim().toLowerCase();
                  if (m === "off" || m === "passthrough" || m === "sdr") return m;
                  // Migrate legacy boolean: hdr_enabled true → "sdr", false → "off".
                  return backend.hdr_enabled ? "sdr" : "off";
                })()}
                required
                options={[
                  { value: "sdr",         label: "Tone-map HDR → SDR (recommended)" },
                  { value: "passthrough", label: "Passthrough (HDR display)" },
                  { value: "off",         label: "Off (no HDR processing)" },
                ]}
                onChange={async (raw) => {
                  const mode = raw === "off" || raw === "passthrough" || raw === "sdr"
                    ? raw
                    : "sdr";
                  await patchBackend({ hdr_mode: mode, hdr_enabled: mode !== "off" });
                  invoke("apply_hdr_settings", { mode }).catch(() => {});
                }}
              />
              <div className="h-px bg-white/6" />
              <NextUpLeadTimeRow
                value={backend.next_up_lead_seconds ?? 60}
                onChange={(v) => patchBackend({ next_up_lead_seconds: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Auto-advance to next episode"
                description="When the Next-Up card surfaces, automatically start the next episode after a short countdown. Mouse movement, any key press, scrolling, or the dismiss button cancels the countdown — you only get the auto-jump when you're genuinely afk during the credits. Default off."
                value={aura.autoAdvanceNextEpisode}
                onChange={(v) => setLocal({ autoAdvanceNextEpisode: v })}
              />
              {aura.autoAdvanceNextEpisode && (
                <>
                  <div className="h-px bg-white/6" />
                  <AutoAdvanceDelayRow
                    value={aura.autoAdvanceDelaySeconds}
                    onChange={(v) => setLocal({ autoAdvanceDelaySeconds: v })}
                  />
                </>
              )}
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Audio passthrough (bitstream)"
                description="WASAPI exclusive mode + AC3/DTS/TrueHD bitstream output to an AVR or soundbar. Other audio apps will lose device access while Aura is open. Takes effect on next app restart."
                value={backend.audio_passthrough}
                onChange={(v) => patchBackend({ audio_passthrough: v })}
              />
              {backend.audio_passthrough && (
                <p className="text-amber-400/75 text-xs mt-1">
                  Restart Aura for audio passthrough to take effect.
                </p>
              )}
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Loudness normalization"
                description={
                  backend.audio_passthrough
                    ? "Disabled while audio passthrough is active — bitstream output bypasses the audio filter chain. Turn passthrough off to use loudness normalization."
                    : "EBU R128 loudness normalization for consistent volume across sources. Levels are normalized to −23 LUFS with a true-peak ceiling of −2 dBTP and a 7 LU loudness range. Adds ~100 ms of latency on stream load."
                }
                value={aura.loudnessNormalization && !backend.audio_passthrough}
                onChange={(v) => {
                  if (backend.audio_passthrough) return;
                  setLocal({ loudnessNormalization: v });
                  invoke("set_audio_loudnorm", { enabled: v }).catch(() => {});
                }}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Motion interpolation"
                description="mpv's built-in GPU frame interpolation (video-sync=display-resample). Smooths low-frame-rate content (24 fps film, anime) on a high-refresh display. GPU-cheap. Tune the look with the kernel dropdown below."
                value={!!aura.motionInterpolation}
                onChange={(v) => {
                  setLocal({ motionInterpolation: v });
                  invoke("set_motion_interpolation", {
                    enabled: v,
                    tscale: aura.interpolationTscale ?? "mitchell",
                  }).catch(() => {});
                }}
              />
              <SettingDropdown
                label="Interpolation kernel (smoothness)"
                description="The tscale kernel — the smoothness dial. 'oversample' only fixes cadence judder and synthesises no in-between motion, so it looks barely interpolated (especially when your refresh rate is an exact multiple of the video fps). The blending kernels add visibly smoother motion with progressively more softening. Applies live when interpolation is on."
                value={aura.interpolationTscale ?? "mitchell"}
                options={[
                  { value: "oversample",  label: "Oversample — sharpest · judder-fix only (least obvious)" },
                  { value: "catmull_rom", label: "Catmull-Rom — sharp · light smoothing" },
                  { value: "mitchell",    label: "Mitchell — balanced smoothing (recommended)" },
                  { value: "gaussian",    label: "Gaussian — smooth · soft" },
                  { value: "bicubic",     label: "Bicubic — smoothest · softest" },
                ]}
                required
                onChange={(v) => {
                  const k = v || "mitchell";
                  setLocal({ interpolationTscale: k });
                  // Apply live only when interpolation is currently on.
                  if (aura.motionInterpolation) {
                    invoke("set_motion_interpolation", {
                      enabled: true,
                      tscale: k,
                    }).catch(() => {});
                  }
                }}
              />
            </Section>
          )}

          {/* Audio scoring — Original Language preference + dub aversion */}
          {backend && (
            <Section id="sec-audio-tracks" title="Audio Track Selection">
              <AudioPriorityInput
                value={backend.audio_priority}
                onCommit={(arr) => patchBackend({ audio_priority: arr })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Avoid dubs"
                description="Heavily penalise audio tracks whose title indicates a dub. Use when you want the title's original audio even when a dub matches your preferred language list."
                value={backend.avoid_dubs}
                onChange={(v) => patchBackend({ avoid_dubs: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingText
                label="Your region (optional)"
                description="ISO 3166-1 alpha-2 (e.g. US, GB, MX). Used as a tiebreaker when picking between regional dialect variants of the same language and the title's productionCountries don't disambiguate. Leave empty for no preference."
                value={backend.user_region}
                placeholder="e.g. US"
                onChange={(v) => patchBackend({ user_region: v.trim().toUpperCase() })}
                validate={(v) => /^$|^[A-Z]{2}$/.test(v.trim().toUpperCase()) ? "valid" : "invalid"}
                validationHint="Two-letter ISO country code (or empty)."
              />
            </Section>
          )}

          {/* Subtitle defaults — language preference + picker filter.
              Audio defaults moved to "Audio Track Selection" above; the
              older split between global-and-anime defaults was redundant
              once audio_priority + the subtitle preference cover both. */}
          {backend && (
            <Section id="sec-subtitle-defaults" title="Subtitles · Defaults">
              <SettingDropdown
                label="Subtitle language"
                description="Loaded automatically when subtitles are available. Applied to all titles; per-title overrides cover the rare exception."
                value={backend.subtitle_language}
                options={LANG_OPTIONS}
                required
                onChange={(v) => v && patchBackend({ subtitle_language: v })}
              />
              <div className="h-px bg-white/6" />
              <SubLangFilterInput
                value={backend.selectable_subtitle_languages}
                onCommit={(arr) => patchBackend({ selectable_subtitle_languages: arr })}
              />
            </Section>
          )}

          {/* Subtitle styling — pushed to MPV via apply_subtitle_style.
              Changes apply on next stream load AND on every patch (the
              backend re-pushes when the active player updates). */}
          {backend && (
            <Section id="sec-subtitle-style" title="Subtitle Style">
              <SettingSlider
                label="Font size"
                description="Glyph height in MPV units. 45 is the default; bump up for ultrawide / TV viewing."
                value={backend.subtitle_font_size}
                min={20}
                max={100}
                onChange={(v) => patchBackend({ subtitle_font_size: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingSlider
                label="Vertical position"
                description="0 = pinned to top, 100 = baseline at frame bottom, up to 150 to push past the natural bottom (useful for some ASS-styled tracks that add their own bottom margin)."
                value={backend.subtitle_position}
                min={0}
                max={150}
                suffix=" %"
                onChange={(v) => patchBackend({ subtitle_position: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingSlider
                label="Outline thickness"
                description="Border around glyphs. 0 = no outline; 6+ feels like a heavy SDH style."
                value={backend.subtitle_border_size}
                min={0}
                max={10}
                onChange={(v) => patchBackend({ subtitle_border_size: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingText
                label="Glyph colour"
                description="Hex form #RRGGBB or #RRGGBBAA. Default white."
                value={backend.subtitle_color}
                placeholder="#FFFFFFFF"
                onChange={(v) => patchBackend({ subtitle_color: v.trim() })}
                validate={(v) => /^#[0-9a-fA-F]{6,8}$/.test(v.trim()) ? "valid" : "invalid"}
                validationHint="Must be #RRGGBB or #RRGGBBAA."
              />
              <div className="h-px bg-white/6" />
              <SettingText
                label="Background colour"
                description="Box behind the text. Final 2 hex digits are alpha; #00000000 means no background."
                value={backend.subtitle_back_color}
                placeholder="#00000000"
                onChange={(v) => patchBackend({ subtitle_back_color: v.trim() })}
                validate={(v) => /^#[0-9a-fA-F]{6,8}$/.test(v.trim()) ? "valid" : "invalid"}
                validationHint="Must be #RRGGBB or #RRGGBBAA."
              />
              <div className="h-px bg-white/6" />
              <SettingText
                label="Font family"
                description="Font name (must be installed on your system). Empty falls back to MPV's default sans."
                value={backend.subtitle_font}
                placeholder="e.g. Inter, Arial, Helvetica"
                onChange={(v) => patchBackend({ subtitle_font: v })}
              />
            </Section>
          )}

          {/* Anime OP / ED skip (AniSkip) */}
          {backend && (
            <Section id="sec-anime-skip" title="Anime OP / ED Skip">
              <p className="text-white/40 text-xs">
                Aura looks up timestamps from the AniSkip community
                database for anime episodes that have a MyAnimeList id.
                Per-type modes: <span className="text-white/65">off</span> hides
                the segment, <span className="text-white/65">prompt</span> shows
                a "Press S to skip" toast, <span className="text-white/65">auto</span> skips
                without asking.
              </p>
              <SkipModeRow
                label="Openings (OP)"
                description="Skip the OP. Most users want this on auto."
                value={backend.skip_op_mode}
                onChange={(v) => patchBackend({ skip_op_mode: v })}
              />
              <div className="h-px bg-white/6" />
              <SkipModeRow
                label="Endings (ED)"
                description="Endings often contain next-episode previews; prompt by default."
                value={backend.skip_ed_mode}
                onChange={(v) => patchBackend({ skip_ed_mode: v })}
              />
              <div className="h-px bg-white/6" />
              <SkipModeRow
                label="Recaps"
                description="Pure recap segments at episode start. Prompt by default for first-time viewers."
                value={backend.skip_recap_mode}
                onChange={(v) => patchBackend({ skip_recap_mode: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Treat mixed-OP as OP"
                description="AniSkip's `mixed-op` results bundle a recap into the opening. When on, they're handled with your OP mode; when off, they fall through (effectively unskipped)."
                value={backend.skip_treat_mixed_op_as_op}
                onChange={(v) => patchBackend({ skip_treat_mixed_op_as_op: v })}
              />
              <div className="h-px bg-white/6" />
              {/* Next-Up filler/recap skip — lives here because users
                  who care about OP/ED skipping typically also care
                  about not auto-advancing into filler. Requires
                  AIOMetadata's per-episode `episodeKind` field; older
                  metadata addons emit nothing for this field and the
                  filter becomes a no-op (every candidate passes). */}
              <SettingDropdown
                label="Next-Up skip filler / recap"
                description="When computing the next episode (Next-Up card and SMTC Next media key), skip episodes AIOMetadata has flagged as filler or recap. Episodes without a flag pass through unchanged."
                value={aura.nextUpSkipFillerRecap}
                required
                options={[
                  { value: "none",   label: "Don't skip" },
                  { value: "filler", label: "Skip filler" },
                  { value: "recap",  label: "Skip recap" },
                  { value: "both",   label: "Skip both" },
                ]}
                onChange={(v) => {
                  if (v === "none" || v === "filler" || v === "recap" || v === "both") {
                    setLocal({ nextUpSkipFillerRecap: v });
                  }
                }}
              />
            </Section>
          )}

          {/* Keybindings */}
          {backend && (
            <Section id="sec-keybindings" title="Keybindings">
              <p className="text-white/40 text-xs">
                Click a row, then press a key to bind it. Press Escape to cancel.
              </p>
              <div className="space-y-1">
                {KEYBIND_ACTIONS.map((a) => (
                  <KeybindRow
                    key={a.id}
                    action={a.id}
                    label={a.label}
                    description={a.description}
                    code={backend.keybindings[a.id] ?? ""}
                    onChange={async (next) => {
                      const updatedMap = { ...backend.keybindings, [a.id]: next };
                      await patchBackend({ keybindings: updatedMap });
                      window.dispatchEvent(new CustomEvent("aura:keybindings-changed"));
                    }}
                  />
                ))}
              </div>
            </Section>
          )}

          <GroupHeader label="Appearance & Window" />

          {/* Theme */}
          <Section id="sec-appearance" title="Theme">
            <SettingDropdown
              label="Theme"
              description={THEME_DESCRIPTIONS[theme]}
              value={theme}
              options={themeOptions}
              required
              onChange={(v) => v && setTheme(v as ThemeId)}
            />
            <div className="h-px bg-white/6" />
            {/* Reduced motion — disables Aura's decorative infinite-loop
                animations (title bar sweep, ambient backdrop drift,
                sidebar pill pulse, bell ring + badge bounce, popup
                breathe, hover-glow rotate). Loading bars, buffering
                pulses, popup enter/exit transitions, and skeleton
                shimmer stay on — they convey work-in-progress. The
                attribute is applied synchronously before React mounts
                so OS-pref users never see the BootSplash sweep. */}
            <SettingDropdown
              label="Reduce motion"
              description="Disable Aura's decorative ambient animations (title-bar sweep, backdrop drift, sidebar glow pulse, bell ring + bounce). Auto follows the OS setting; Always forces motion off regardless of OS; Never forces motion on even if the OS asked for reduce."
              value={aura.reduceMotion}
              options={[
                { value: "auto",   label: "Auto — follow OS setting" },
                { value: "always", label: "Always reduce" },
                { value: "never",  label: "Never reduce" },
              ]}
              required
              onChange={(v) => v && setLocal({ reduceMotion: v as AuraSettings["reduceMotion"] })}
            />
          </Section>

          {/* Window & system behaviour */}
          {backend && (
            <Section id="sec-window" title="Window & System">
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
                label="Minimize to tray on close"
                description="Hide Aura to a tray icon when you click the close button instead of exiting. Click the tray icon to bring the window back."
                value={backend.minimize_to_tray_on_close}
                onChange={(v) => patchBackend({ minimize_to_tray_on_close: v })}
              />
            </Section>
          )}

          <GroupHeader label="Integrations" />

          {/* Discord Rich Presence */}
          {backend && (
            <Section id="sec-discord" title="Discord Rich Presence">
              <SettingToggle
                label="Show what I'm watching"
                description="Publish playback details to Discord."
                value={backend.discord_rpc_enabled}
                onChange={(v) => patchBackend({ discord_rpc_enabled: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Show titles in presence"
                description="When off, Discord just shows 'Watching Aura'."
                value={backend.discord_rpc_show_titles}
                onChange={(v) => patchBackend({ discord_rpc_show_titles: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Show what I'm browsing"
                description="Publish presence for Home, Library, Calendar, Add-ons, Settings, Search and Detail screens. When off, Discord only lights up while a stream is playing."
                value={backend.discord_rpc_browse_states}
                onChange={(v) => patchBackend({ discord_rpc_browse_states: v })}
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

          {/* Scrobbling — direct Trakt + AniList OAuth.
              Replaces the AIOMetadata-addon scrobble path with a
              direct connection to each provider. Tokens are stored in
              the OS keyring per Stremio account so signing out and
              back in keeps the connection. Connect opens the user's
              default browser; the VPS proxy at aura.animasec.dev
              completes the OAuth dance and deep-links the token back
              into Aura. */}
          {backend && (
            <Section id="sec-scrobble" title="Trakt & AniList">
              <ScrobbleAuthRow
                service="trakt"
                authKey={session?.auth_key ?? null}
                description="Trakt receives playback progress for movies and series. Aura logs in directly via OAuth, no addon required. Scrobble events fire at start (after 120 s of real playback) and end (80 % progress with at least 5 min watched)."
              />
              <div className="h-px bg-white/6" />
              <ScrobbleAuthRow
                service="anilist"
                authKey={session?.auth_key ?? null}
                description="AniList tracks anime episode progress. When connected, Aura updates your AniList list as you finish episodes. Detected automatically for anime targets; movies and live-action use Trakt instead."
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Enable scrobbling"
                description="Master switch. When off, Aura sends no scrobble traffic to either provider, useful for pausing without disconnecting your accounts."
                value={backend.scrobble_enabled}
                onChange={(v) => patchBackend({ scrobble_enabled: v })}
              />
            </Section>
          )}

          {/* Cloud Sync — diagnostic + manual controls for the
              per-account state sync (Phase 7). Engine runs silently in
              the background; this section surfaces last-pull / last-
              push / size per namespace plus on-demand Pull / Purge. */}
          <Section id="sec-cloud-sync" title="Cloud Sync">
            <CloudSyncSection authKey={session?.auth_key ?? null} />
            <div className="h-px bg-white/6 my-3" />
            {/* Release-search opt-in. Default on for signed-in users
                per docs/release-search-spec.md §6.4. When off, the
                desktop falls back to per-user addon probes for
                library / calendar reconciliation (same code path as
                pre-Phase 9). Ignored for guests — they always use the
                addon path because the cloud requires a signed-in
                scope hash on the batch + nudge endpoints. */}
            {/* No `disabled` prop on SettingToggle. The setting is
                editable for everyone, but the runtime gate at call
                sites (releaseSearch.ts, library reconciler) ignores
                the flag for guests since the cloud batch + nudge
                endpoints require a signed-in scope hash. */}
            <SettingToggle
              label="Use Aura Cloud's shared release feed"
              description="When on, Aura asks the cloud service whether new episodes have aired instead of probing addons from your machine. Faster library refresh and lower bandwidth, but Aura Cloud sees the imdb-ids in your library (it never sees streams, watch history, or your Debrid keys). Signed-in only."
              value={aura.releaseSearchEnabled}
              onChange={(v) => setLocal({ releaseSearchEnabled: v })}
            />
          </Section>

          {/* API keys — currently just OMDb. Other third-party services
              that need a key (OpenSubtitles, etc.) can plug into this
              section as they get re-introduced. Aura no longer ships
              a default OMDb key — users register a free one at
              omdbapi.com (signup ~30 s, 1,000 req/day) and paste it
              here. Without a key OMDb is silently disabled and the
              detail page falls back to addon-supplied ratings plus the
              MAL aggregator. The user's key is round-tripped via the
              Backup & Restore export blob so it follows them across
              installs. */}
          {backend && (
            <Section id="sec-api-keys" title="API Keys">
              <KeyringApiKeyInput
                name="omdb"
                label="OMDb API key"
                description="Enriches Detail-page ratings with Rotten Tomatoes and Metacritic critic scores. Aura does not ship a default key; register a free one at omdbapi.com (1,000 requests/day, ~30 s signup) and paste it here. Leave empty to disable OMDb; addon-supplied ratings and the MAL aggregator still render without it. Stored securely in the OS keyring."
                placeholder="e.g. 1a2b3c4d"
              />
              <div className="h-px bg-white/6" />
              <KeyringApiKeyInput
                name="opensubtitles"
                label="OpenSubtitles API key"
                description="Unlocks the in-player subtitle picker that queries OpenSubtitles' REST API. Register a free account at opensubtitles.com (the .com REST API, not the legacy .org XML-RPC) and find your key under Profile → Consumer. Leave empty to disable; addon-supplied subtitles still work without it. Stored securely in the OS keyring."
                placeholder="e.g. 1a2b3c4dXyZ…"
              />
            </Section>
          )}

          {/* Crash reporting — opt-in Sentry integration. The toggle
              flips `crash_reporting_consent` to true / false (matching
              the consent dialog's two outcomes); the DSN field is
              the per-project key from the Sentry dashboard. Both the
              Rust panic hook and the JS Sentry init read these at
              startup, so changes only take effect after a restart. */}
          {crashConfig && (
            <Section id="sec-crash-reporting" title="Crash Reporting">
              <SettingToggle
                label="Send crash reports"
                description="When enabled, Aura sends anonymised crash reports (error message, stack trace, OS / app version) to the developer's Sentry endpoint. No PII: usernames, IP addresses, file paths, and stream URLs are never included. Reports help fix bugs that would otherwise vanish silently on the user's machine. Takes effect on next app restart."
                value={crashConfig.consent === true}
                onChange={(v) => patchCrashConfig({ consent: v })}
              />
              {/* The Sentry DSN used to be a user-facing input here.
                  It's now hardcoded into the build (mirrored in
                  src-tauri/src/lib.rs::HARDCODED_SENTRY_DSN and
                  src/main.tsx::HARDCODED_SENTRY_DSN) so end users
                  have nothing to configure — the only thing they
                  decide is whether reports send at all (the toggle
                  above). Developers can still override via the
                  SENTRY_DSN / VITE_SENTRY_DSN env vars at build time,
                  or by setting the `dsn` field in
                  <app_data_dir>/crash-reporting.json directly. */}
            </Section>
          )}

          <GroupHeader label="System" />

          {/* Performance — rendering toggles that need a restart to
              take effect. Today: just hardware acceleration; future
              additions (e.g. low-power mode, animation reduction
              overrides) would join here. */}
          {backend && (
            <Section id="sec-performance" title="Performance">
              <SettingToggle
                label="Hardware acceleration"
                description="Lets WebView2 use the GPU for rendering. Turn off if you see laggy scrolling on a multi-monitor / ultrawide setup with low CPU and GPU usage; that's a sign the OS compositor is the bottleneck rather than render workload. Restart Aura after toggling."
                value={backend.gpu_acceleration}
                onChange={(v) => patchBackend({ gpu_acceleration: v })}
              />
            </Section>
          )}

          {/* Storage — disk + localStorage cache inspection. Clear
              buttons remove individual entries; "user data" badge
              flags the destructive ones (manual marks, settings,
              etc.). */}
          <Section id="sec-storage" title="Storage">
            <StorageReport />
          </Section>

          <GroupHeader label="Backup & Restore" />

          {/* Backup & Restore — portable settings export/import.
              Only addon-INDEPENDENT fields round-trip (theme / audio /
              subtitles / keybindings / discord / skip / etc.). Provider
              URL lists are excluded so an import on a fresh machine
              doesn't try to point at addons that aren't installed. */}
          {backend && (
            <BackupRestoreSection
              backend={backend}
              addons={addons}
              onApply={async (patch) => { await patchBackend(patch); }}
              onResetComplete={() => {
                // Force the SettingsView to re-pull fresh backend
                // defaults so the UI controls reflect the wipe.
                invoke<BackendSettings>("get_settings")
                  .then(setBackend)
                  .catch(() => {});
                // Reset local Aura settings state too — the listener
                // on aura:settings-changed already fires reads, but
                // doing it explicitly here keeps the controls in sync
                // even if the listener registration ordering ever
                // changes.
                setLocal({}); // no-op patch to nudge a re-render
              }}
            />
          )}

          {/* About */}
          <AboutSection addonCount={addons.length} />
          </div>{/* /content column */}

          {/* Mirror of the TOC width — empty third column. Keeps the
              content column centred on the page rather than off to the
              right next to the TOC. */}
          <div aria-hidden />
        </div>{/* /grid */}
      </div>
    </div>
  );
}
