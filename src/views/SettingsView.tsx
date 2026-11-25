// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  createContext, Fragment, useState, useEffect, useLayoutEffect, useCallback, useContext, useId, useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { checkForUpdatePlugin, downloadAndInstallUpdatePlugin } from "../updaterPlugin";
import StorageReport from "../StorageReport";
import { getHistoryCloudTrim } from "../historyStore";
import RuntimeComponentsSection from "../RuntimeComponentsSection";
import Changelog from "../Changelog";
import { useIdleGatedInterval } from "../useIdleGate";
import {
  buildExportBlob,
  blobToBase64,
  downloadBlobAsFile,
  applySettingsImport,
  importSummaryStatus,
  parseImportInput,
  readImportFile,
} from "../settingsTransfer";
import {
  applyBackupPayload,
  backupStorageUsed,
  createSnapshot,
  deleteSnapshot,
  listSnapshots,
  getActiveBackupScope,
  BACKUP_SCOPE_EVENT,
  readSnapshot,
  type BackupMeta,
} from "../userDataBackup";
import type { AddonEntry, ThemeId, KeybindAction } from "../types";
import type { UserSession } from "../LoginView";
import { KEYBIND_ACTIONS } from "../types";
import { useTheme, THEME_LABELS, THEME_DESCRIPTIONS } from "../ThemeEngine";
import { prettyBinding, formatBinding, parseBinding, setKeyCaptureActive } from "../useKeybindings";
import {
  loadAuraSettings,
  saveAuraSettings,
  type AuraSettings,
} from "../auraSettings";
import { isHomeSource, isSearchProvider, isStreamProvider } from "../addonElection";
import { dismissAppToasts, showAppToast } from "../AppToast";
import { openExternalUrl } from "../externalUrl";

/** Scope of the confirmations that only mean something on this page
 *  ("Settings saved", Cloud Sync pull / push / clear, a moved keybinding).
 *  They fade out as soon as Settings is left; errors stay unscoped so
 *  they run their full time. */
const SETTINGS_TOAST_SCOPE = "settings";
import { SCROBBLE_ROW_DESCRIPTIONS } from "../scrobbleConn";
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
import SkipConfidenceBadge from "../SkipConfidenceBadge";
import type { SkipConfidence } from "../skipWindows";
import {
  AdvancedMarkContext,
  AdvancedPill,
  AdvancedTag,
  AttachedSettings,
  SegmentedControl,
  SettingDropdown,
  SettingText,
  SettingToggle,
  ToggleSwitch,
} from "../settingsControls";
import { subtitleLanguageOptions } from "../languages";
import { patchBackendSettings } from "../backendSettings";
import { REAL_GLASS_AVAILABLE, realGlassAvailable, setRealGlassEnabled, useRealGlassState } from "../realGlass";
import { useGlassState } from "../glassStyle";
import HdrModeSetting from "../HdrModeSetting";
import { GlassStyleRows } from "../GlassStyleSetting";
import { AccentColorRow } from "../AccentColorSetting";
import { AUDIO_ORDER_CHANGED_EVENT } from "../audioPriorityRepair";
import { HDR_MODE_CHANGED_EVENT, applyStoredHdrMode, hdrModeOf, setHdrMode, setHdrPeakNits } from "../hdrMode";
import ScrobbleAuthRow from "../ScrobbleAuthRow";
import { requestRerunOnboarding } from "../onboarding";
import { sheet } from "../glassSheet";
import { useListDroplet } from "../glassListDroplet";

/** App version. Sourced from package.json via the `VITE_APP_VERSION`
 *  define in vite.config.ts so a single version bump in package.json
 *  flows everywhere. See App.tsx's APP_VERSION comment for the
 *  incident this prevents (hardcoded constant drifted from the actual
 *  build version, so the updater self-reported as "up to date"). */
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "0.0.0";

// ---------------------------------------------------------------------------
// Backend-side settings shape - must mirror Rust AppSettings.
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
  subtitle_brightness: number;
  discord_rpc_enabled: boolean;
  discord_rpc_show_titles: boolean;
  discord_rpc_blocked_titles: string[];
  discord_rpc_browse_states: boolean;
  close_on_exit: boolean;
  minimize_to_tray_on_close: boolean;
  scrobble_addon_url: string;
  auto_scrobble_enabled: boolean;
  opensubtitles_api_key: string;
  /** Legacy HDR toggle. Kept on the wire so older settings survive the
   *  migration, but the new UI talks to `hdr_mode` directly. */
  hdr_enabled: boolean;
  /** Tri-state HDR pipeline: "off" | "sdr" | "passthrough". See
   *  src-tauri/src/settings.rs for the property fan-out per mode. */
  hdr_mode: string;
  /** Passthrough-only display-peak override in nits (mpv target-peak).
   *  0 = auto (trust the caps Windows reports). Fixes blown-out
   *  highlights when the panel's current OSD mode peaks lower than
   *  Windows believes (OLED True Black modes). */
  hdr_target_peak_nits: number;
  /** Lead time (seconds before episode end) for the Next-Up CTA.
   *  0 disables the feature. */
  next_up_lead_seconds: number;
  audio_passthrough: boolean;
  /** Backend mirror of auraSettings.loudnessNormalization - written by
   *  the set_audio_loudnorm command so the engine can install the
   *  @loudnorm filter at mpv init. Not edited directly from this view. */
  loudness_normalization: boolean;
  cache_secs: number;
  demuxer_readahead_secs: number;
  demuxer_max_mib: number;
  screenshot_dir: string;
  /** Root folder downloads are written to. Empty = not chosen yet; the first
   *  download prompts for one. Machine-local: stripped from the cloud blob in
   *  sync.ts and absent from both portable lists. */
  download_dir: string;
  /** true = organised layout (Show/Season 01/...), false = flat. A real
   *  preference, so unlike the path it does sync and is portable. */
  download_organise: boolean;
  keybindings: Record<string, string>;
  skip_op_mode: string;
  skip_ed_mode: string;
  skip_recap_mode: string;
  skip_treat_mixed_op_as_op: boolean;
  /** Preferred Watch-Trailer quality: "auto" | "720" | "1080" | "1440" | "2160". */
  trailer_quality: string;
  gpu_acceleration: boolean;
  /** "Real glass over video" (experimental, default off): an mpv shader
   *  blurs the live video under the player's bar and menus. Machine-local
   *  (render.json), stripped from the cloud blob in sync.ts, not portable. */
  real_glass: boolean;
}

// ---------------------------------------------------------------------------
// Reusable setting controls (the row controls shared with the first-run setup
// live in settingsControls.tsx)
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

// ---------------------------------------------------------------------------
// Advanced settings
//
// "Show advanced settings" (AuraSettings.showAdvancedSettings, the switch
// under the search box) hides the provider overrides and the power-user rows.
// What hides is one of two UNITS:
//   • a whole Section, when its TOC leaf is marked `advanced` (TOC_GROUPS).
//     The TOC asks the same question through tocLeafShown, so an entry and
//     its section can never disagree about being there, and the scrollspy
//     never lands on an anchor that is not on screen.
//   • an <AdvancedOnly> block inside an ordinary Section: a row plus the
//     divider that separates it from its neighbour, so hiding it leaves no
//     stray rule behind.
// With the switch off, a unit is:
//   • rendered and tagged "Advanced" in a section a deep link
//     (aura:open-settings) opened during this visit to Settings;
//   • MOUNTED but `hidden` while a search is active, because the search walks
//     the DOM for [data-settings-row] and can only match a row that exists.
//     A unit holding a match (its `data-advanced-id`, collected by that walk)
//     is shown and tagged; the rest stay hidden. This is why every searchable
//     row keeps the data-settings-* attributes on its outermost element.
//   • otherwise not rendered at all, so none of its effects or IPC run,
//     UNLESS it was on screen earlier in this visit (the query has since
//     cleared, or the switch went off): then it stays mounted and `hidden`
//     (useLatchedUnitState), so what it had in flight survives.
// Neither a search nor a deep link writes the persisted switch.
// ---------------------------------------------------------------------------

interface AdvancedView {
  /** The persisted "Show advanced settings" switch. */
  show: boolean;
  /** A settings search query is active. */
  searching: boolean;
  /** `data-advanced-id` of every unit holding a search match. */
  hits: ReadonlySet<string>;
  /** Sections a deep link opened since the user came to Settings. */
  revealed: ReadonlySet<string>;
}

const NO_IDS: ReadonlySet<string> = new Set();

const AdvancedViewContext = createContext<AdvancedView>({
  show: true, searching: false, hits: NO_IDS, revealed: NO_IDS,
});
/** The enclosing Section's id, for AdvancedOnly's deep-link check. */
const SectionIdContext = createContext<string | undefined>(undefined);

type AdvancedUnitState = "shown" | "marked" | "hidden" | "absent";

function advancedUnitState(
  adv: AdvancedView, unitId: string, sectionId: string | undefined,
): AdvancedUnitState {
  if (adv.show) return "shown";
  if (sectionId !== undefined && adv.revealed.has(sectionId)) return "marked";
  if (!adv.searching) return "absent";
  return adv.hits.has(unitId) ? "marked" : "hidden";
}

/** A unit that has been on screen (shown or marked) stays MOUNTED, `hidden`,
 *  for the rest of this visit to Settings where it would otherwise go absent.
 *  Unmounting throws away component state mid-flight: an Optional Components
 *  download's progress, after which a remount offers the same download again
 *  while the first is still writing, or a half-typed API key. SettingsView
 *  unmounts when the user leaves, which ends the latch, and a unit never on
 *  screen is never latched, so a plain visit still renders none of them. */
function useLatchedUnitState(state: AdvancedUnitState): AdvancedUnitState {
  const [latched, setLatched] = useState(false);
  // Set during render (React's pattern for state derived from props): React
  // re-renders before committing, so the latch is in place before the unit
  // could ever go absent.
  if (!latched && (state === "shown" || state === "marked")) setLatched(true);
  return state === "absent" && latched ? "hidden" : state;
}

/** Advanced rows inside an ordinary Section (see the block comment above).
 *  The wrapper repeats the Section body's `space-y-5`, so its children space
 *  exactly as they would unwrapped, and a `hidden` wrapper drops out of the
 *  outer spacing. Put the row's separating divider inside it too. */
function AdvancedOnly({ children }: { children: React.ReactNode }) {
  const adv = useContext(AdvancedViewContext);
  const sectionId = useContext(SectionIdContext);
  const unitId = useId();
  const state = useLatchedUnitState(advancedUnitState(adv, unitId, sectionId));
  if (state === "absent") return null;
  return (
    <div className="space-y-5" data-advanced-id={unitId} hidden={state === "hidden"}>
      <AdvancedMarkContext.Provider value={state === "marked"}>
        {children}
      </AdvancedMarkContext.Provider>
    </div>
  );
}

/** The three skip confidence levels, as the player shows them. A plain
 *  explanation row (searchable like any other), not a control. */
const SKIP_CONFIDENCE_LEGEND: Record<SkipConfidence, string> = {
  verified: "Found in this episode itself: its theme song matched in the audio, or an opening or preview chapter of a usual length. Cuts at most a second or two of story, but can stop a little short.",
  likely:   "Usually right, but the edges are not confirmed: AniSkip, IntroDB or PublicMetaDB times, an ending chapter, or a theme match still being measured. Can be off, sometimes by more than a few seconds. On Auto these can skip by themselves.",
  risky:    "A guess, or times nothing in the episode backs up (for example AniSkip endings, unconfirmed IntroDB times, a chapter only named Intro or Outro, or a song that starts over the story). May cut into the story, so these always ask first, even on Auto.",
};

/** The legend's intro, shown on the page and searched, so the two cannot drift. */
const SKIP_CONFIDENCE_INTRO =
  "Skip prompts, the AuraSkip menu and the timeline's hover card show how sure Aura is that a segment holds only what it names. A level can change as the theme match finishes.";

const SKIP_CONFIDENCE_DESCRIPTION =
  `${SKIP_CONFIDENCE_INTRO} `
  + `Verified: ${SKIP_CONFIDENCE_LEGEND.verified} Likely: ${SKIP_CONFIDENCE_LEGEND.likely} Risky: ${SKIP_CONFIDENCE_LEGEND.risky}`;

function SkipConfidenceLegend() {
  const levels: SkipConfidence[] = ["verified", "likely", "risky"];
  return (
    <div
      data-settings-row=""
      data-settings-label="Skip confidence"
      data-settings-description={SKIP_CONFIDENCE_DESCRIPTION}
    >
      <p className="text-white/75 text-sm font-medium">Skip confidence</p>
      <p className="text-white/35 text-xs mt-0.5">{SKIP_CONFIDENCE_INTRO}</p>
      <div className="mt-2 space-y-1.5">
        {levels.map((l) => (
          <div key={l} className="flex items-start gap-2.5">
            <span className="w-[86px] flex-shrink-0"><SkipConfidenceBadge level={l} /></span>
            <span className="text-white/55 text-xs leading-snug">{SKIP_CONFIDENCE_LEGEND[l]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Three-position segmented selector (off / prompt / auto) used by the
 *  AniSkip section. Single row each for OP / ED / recap modes. Colourless on
 *  purpose: green / amber / red in this section mean confidence levels. */
function SkipModeRow({
  label, description, value, onChange,
}: {
  label: string;
  description: string;
  value: string;
  onChange: (v: string) => void;
}) {
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
      <SegmentedControl<string>
        value={value}
        options={SKIP_MODE_OPTIONS}
        onChange={onChange}
        ariaLabel={label}
      />
    </div>
  );
}

const SKIP_MODE_OPTIONS: { value: string; label: string }[] = [
  { value: "off",    label: "Off" },
  { value: "prompt", label: "Prompt" },
  { value: "auto",   label: "Auto" },
];

// ---------------------------------------------------------------------------
// SettingSlider - labeled range input with live numeric readout
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
  /** Called once per gesture, on release (see below). A returned promise
   *  holds the drag's value on the thumb until the write settles. */
  onChange: (v: number) => void | Promise<unknown>;
}) {
  // A drag (or a held arrow key) keeps its value HERE and commits once, on
  // release, key up, blur or the native `change` event. Every tick used to
  // patch straight through: an update_settings round trip (a settings.json
  // write), apply_subtitle_style or apply_buffer_settings, a sync stamp, the
  // whole Settings page re-rendering and its settings-changed listeners
  // re-reading, dozens of times a second. The thumb and the readout still
  // follow the pointer on every tick (only this row re-renders), and the
  // committed value is the same one the last tick wrote before.
  const [draft, setDraft] = useState<number | null>(null);
  const draftRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const genRef = useRef(0);
  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const inputRef = useRef<HTMLInputElement>(null);
  // Chromium also fires `change` on every arrow key press: a held key
  // commits on key up instead.
  const keyHeldRef = useRef(false);
  // Commits whose write has not landed yet. While one is out, `value` is
  // still the value from before it, so "unchanged" cannot be judged against
  // it: a quick move back to that value would be dropped, then the earlier
  // write would land and leave the thumb (and the setting) on it.
  const pendingRef = useRef(0);

  const commitRef = useRef(() => {
    if (!activeRef.current) return;
    activeRef.current = false;
    const v = draftRef.current;
    const gen = ++genRef.current;
    const settle = () => {
      // A newer gesture owns the draft now: leave it alone.
      if (genRef.current !== gen || activeRef.current) return;
      draftRef.current = null;
      setDraft(null);
    };
    if (v === null || (pendingRef.current === 0 && v === valueRef.current)) { settle(); return; }
    // Settled AFTER the write (its new value is already in `value` by then),
    // so the thumb never flashes back to the old value; a refused write
    // still lands back on the stored one, as before.
    pendingRef.current += 1;
    Promise.resolve(onChangeRef.current(v))
      .finally(() => { pendingRef.current -= 1; })
      .then(settle, settle);
  });

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    // The native `change` fires when a range gesture ends, even when the
    // pointer is released outside the input.
    const onNativeChange = () => { if (!keyHeldRef.current) commitRef.current(); };
    el.addEventListener("change", onNativeChange);
    return () => {
      el.removeEventListener("change", onNativeChange);
      // Leaving mid-gesture still saves the value on the thumb.
      commitRef.current();
    };
  }, []);

  const shown = draft ?? value;
  // Fraction 0..1 for the slider track gradient. The CSS uses `--val`
  // as a percentage and `--val-frac` as a 0..1 number for shadow intensity.
  const span = Math.max(1, max - min);
  const frac = Math.max(0, Math.min(1, (shown - min) / span));
  const commit = () => commitRef.current();
  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-white/75 text-sm font-medium">{label}<AdvancedTag /></p>
        <span className="text-white/65 text-[12px] font-mono tabular-nums">
          {shown}{suffix ?? ""}
        </span>
      </div>
      <p className="text-white/35 text-xs -mt-1">{description}</p>
      <input
        ref={inputRef}
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          activeRef.current = true;
          draftRef.current = v;
          setDraft(v);
        }}
        onPointerUp={commit}
        onKeyDown={() => { keyHeldRef.current = true; }}
        onKeyUp={() => { keyHeldRef.current = false; commit(); }}
        onBlur={() => { keyHeldRef.current = false; commit(); }}
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
// SubLangFilterInput - comma-separated language codes (en, es, ja, …)
//
// Why this exists: SettingText is fully controlled and reflects whatever
// `value` is. If we filter the typed text on every keystroke through a
// regex that only accepts 2-3 letters, partial input ("e", "en, ") gets
// rejected, the parent state goes back to empty, and the input clears
// on the next keystroke - typing becomes impossible.
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
  // import, etc.) - but never while the user is mid-edit.
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
    const next = parsed.join(", ");
    lastSyncedRef.current = next;
    setDraft(next);
    // Against the prop, so a failed save stays retryable. A blur that changed
    // nothing must not stamp and push over another device's edit.
    if (next !== joined) onCommit(parsed);
  };

  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label="Subtitle picker languages"
      data-settings-description="Only these languages show in the player's subtitle picker. Comma-separated codes (en, es, ja); empty shows every language."
    >
      <p className="text-white/75 text-sm font-medium">Subtitle picker languages</p>
      <p className="text-white/35 text-xs -mt-1">
        Only these languages show in the player's subtitle picker. Comma-separated
        codes (en, es, ja); empty shows every language.
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
        className="aura-glass-field w-full rounded-xl px-4 py-2.5 text-sm font-mono
                   placeholder:text-white/25 outline-none"
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AudioPriorityInput - ordered list of language tokens for the audio
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
    const next = parsed.join(", ");
    lastSyncedRef.current = next;
    setDraft(next);
    if (next !== joined) onCommit(parsed);
  };

  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label="Audio language priority"
      data-settings-description="Languages to prefer, in order. original means the title's original language (needs AIOMetadata, installed on its own or inside AIOStreams); codes like en, ja, es match a track's language. English is always the last fallback. Default: original, en."
    >
      <p className="text-white/75 text-sm font-medium">Audio language priority</p>
      <p className="text-white/35 text-xs -mt-1">
        Languages to prefer, in order. <span className="font-mono text-white/55">original</span> means
        the title's original language (needs AIOMetadata, installed on its own or inside AIOStreams); codes like en, ja, es match a track's language.
        English is always the last fallback. Default: <span className="font-mono">original, en</span>.
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
        className="aura-glass-field w-full rounded-xl px-4 py-2.5 text-sm font-mono
                   placeholder:text-white/25 outline-none"
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SortableAddonRow - dnd-kit-driven row used inside AddonMultiPicker.
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
  };

  // A content row, not glass. The dragged row draws a dense face of its
  // own (.aura-content-row.is-dragging, which also lifts its z-index), so
  // it stays fully opaque and the rows it passes under never show through.
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`aura-content-row aura-settings-sort-row flex items-center gap-3 px-3 py-2.5
                  ${isDragging ? "is-dragging" : ""}`}
    >
      {/* Drag handle - only this element listens for drag activation so the
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
        className="aura-glass-item text-white/35 hover:text-white/80 text-xs px-2 py-0.5 rounded"
      >
        Remove
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Unified home sources picker - single sortable list; position 0 = primary.
// Replaces the separate "Default Home Catalog" dropdown + "Additional Sources"
// multi-picker so the user can reorder even the primary entry.
//
// Optional `filter` narrows the picker to a subset of addons (e.g. only those
// that may serve catalogs, the Home election's own rule, so the Catalog
// Providers list isn't cluttered with subtitle-only addons).
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
// HeroCatalogPicker - two cascading selects (Addon → Catalog) that
// pin a specific catalog as the source for the Home hero band. Lists
// EVERY catalog the addon exposes (including is_hidden_from_home), so
// the user can lift a Discover-only catalog like AIOMetadata's "AI
// Recommendations" into the hero rotation without surfacing it in the
// home grid below. Picking "Default" clears the override and the hero
// falls back to the first browseable row's items (the 0.6.x default).
// ---------------------------------------------------------------------------

/** Sentinel option value for "turn the hero off entirely". Distinct from the
 *  empty-string Default option and from any real addon URL. */
const HERO_DISABLE_OPT = "__hero_disabled__";

function HeroCatalogPicker({
  addons, value, disabled, onChange,
}: {
  addons: AddonEntry[];
  value: { addonUrl: string; mediaType: string; catalogId: string } | null;
  /** True when the hero is fully disabled (the "Disable" item). */
  disabled: boolean;
  onChange: (next: {
    disabled: boolean;
    catalog: { addonUrl: string; mediaType: string; catalogId: string } | null;
  }) => void;
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
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label="Hero Carousel Source"
      data-settings-description="Catalog whose items rotate in the Home hero band. Catalogs hidden from Home work too (e.g. AIOMetadata's AI Recommendations or an MDBList list). Default uses your first row; Disable hides the hero."
    >
      <p className="text-white/85 text-sm font-medium">Hero Carousel Source</p>
      <p className="text-white/40 text-xs leading-relaxed">
        Catalog whose items rotate in the Home hero band. Catalogs hidden from
        Home work too (e.g. AIOMetadata's AI Recommendations or an MDBList list).
        Default uses your first row; <span className="text-white/65">Disable</span> hides the hero.
      </p>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={disabled ? HERO_DISABLE_OPT : (selectedUrl ?? "")}
          onChange={(e) => {
            const v = e.target.value;
            if (v === HERO_DISABLE_OPT) {
              setSelectedUrl(null);
              onChange({ disabled: true, catalog: null });
              return;
            }
            const url = v || null;
            setSelectedUrl(url);
            // Switching addon (or back to Default) clears any pinned catalog
            // until a new one is picked, and always re-enables the hero.
            onChange({ disabled: false, catalog: null });
          }}
          className="aura-glass-flat aura-glass-select appearance-none cursor-pointer rounded-lg px-3 py-1.5 text-xs
                     outline-none min-w-[180px]"
          style={{ color: "var(--text-primary)" }}
        >
          <option value={HERO_DISABLE_OPT}>Disable (no hero)</option>
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
              if (!selectedUrl || !e.target.value) { onChange({ disabled: false, catalog: null }); return; }
              const [mediaType, catalogId] = e.target.value.split(":", 2);
              if (mediaType && catalogId) {
                onChange({ disabled: false, catalog: { addonUrl: selectedUrl, mediaType, catalogId } });
              }
            }}
            className="aura-glass-flat aura-glass-select appearance-none cursor-pointer rounded-lg px-3 py-1.5 text-xs
                     outline-none min-w-[200px]"
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
        {(value || disabled) && (
          <button
            type="button"
            onClick={() => { setSelectedUrl(null); onChange({ disabled: false, catalog: null }); }}
            className="aura-glass-flat aura-glass-press px-3 py-1.5 rounded-lg
                       text-white/80 text-[11px] font-medium"
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
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label={title}
      data-settings-description={description}
    >
      <div>
        <p className="text-white/75 text-sm font-medium">{title}<AdvancedTag /></p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      {visibleAddons.length === 0 ? (
        <p className="text-white/30 text-xs italic px-1 py-2">No matching addons installed.</p>
      ) : (
        <div className="space-y-1">
          {/* A grouped content list, not glass. DndContext renders no DOM,
              so each row stays a direct child of the group (separators). */}
          {selectedAddons.length > 0 && (
            <div className="aura-content-group">
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
            </div>
          )}

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
              <div className="aura-content-group">
                {unselected.map((a) => (
                  <button
                    key={a.url}
                    onClick={() => add(a.url)}
                    className="aura-content-row w-full flex items-center gap-3 px-3 py-2.5 text-left"
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
// AboutSection - condensed app-info panel + fun-stats readout
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
// BackupRestoreSection - portable settings export/import.
//
// Only addon-INDEPENDENT backend fields round-trip. The settingsTransfer
// module owns the whitelist + parse/serialize logic; this component is
// just glue between that and the user's clicks (download file / copy
// base64 / paste base64 / pick file).
// ---------------------------------------------------------------------------

const RERUN_SETUP_DESCRIPTION =
  "Walk through the first-run setup again: theme, playback, addons and tracking. Nothing is reset.";

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
  // Off by default: keys are keyring credentials and the export is shareable.
  const [includeApiKeys, setIncludeApiKeys] = useState(false);
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
      const reset = await invoke<BackendSettings>("reset_settings");
      // The reset also rewrote this machine's HDR fields (render.json) to
      // the defaults; push the mode to the player and tell this page and
      // the bell offer, as every other HDR write does (hdrMode.ts).
      void applyStoredHdrMode(hdrModeOf(reset as unknown as Record<string, unknown>));
      // Frontend wipe - drop the localStorage-backed AuraSettings so
      // home/meta/stream/search overrides return to manifest-id
      // defaults instead of pointing at whatever the user had pinned.
      try { localStorage.removeItem("aura:settings:v1"); } catch {}
      window.dispatchEvent(new CustomEvent("aura:settings-changed"));
      // No key list: everything changed, the theme included.
      window.dispatchEvent(new CustomEvent("aura:backend-settings-changed"));
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
  const hydrateBackendWithKeyringKeys = useCallback(async (includeKeys: boolean): Promise<Record<string, unknown>> => {
    // A fresh read: the page's copy misses a theme picked this visit and a cloud
    // pull. A failed read still exports the copy rather than nothing.
    const fresh = await invoke<BackendSettings>("get_settings").catch(() => backend);
    const merged: Record<string, unknown> = { ...(fresh as unknown as Record<string, unknown>) };
    // API keys are OS-keyring CREDENTIALS. The export string is designed to be
    // shared (it pastes into a messenger), so by default we do NOT bake them in:
    // a user swapping configs with a friend would otherwise hand over their
    // OpenSubtitles, TMDB + IntroDB keys. Only include them when the user explicitly opts
    // in (moving to their own second machine).
    if (!includeKeys) {
      for (const name of ["opensubtitles", "tmdb", "introdb"] as const) {
        delete merged[`${name}_api_key`];
      }
      return merged;
    }
    for (const name of ["opensubtitles", "tmdb", "introdb"] as const) {
      try {
        const v = await invoke<string>("get_api_key", { name });
        if (v && v.trim()) {
          merged[`${name}_api_key`] = v;
        }
      } catch {
        // Keyring unavailable on this platform - keep the merged value
        // (possibly empty from the migrated settings.json) so the
        // export still ships *something*.
      }
    }
    return merged;
  }, [backend]);

  const buildAndShow = useCallback(async () => {
    const hydratedBackend = await hydrateBackendWithKeyringKeys(includeApiKeys);
    const blob = buildExportBlob(
      hydratedBackend,
      loadAuraSettings() as unknown as Record<string, unknown>,
      addons,
    );
    setExportText(blobToBase64(blob));
    setStatus({
      kind: "ok",
      message: includeApiKeys
        ? "Export ready. It contains your API keys, so do not share it."
        : "Export string ready. Copy or download.",
    });
  }, [hydrateBackendWithKeyringKeys, addons, includeApiKeys]);

  const downloadFile = useCallback(async () => {
    const hydratedBackend = await hydrateBackendWithKeyringKeys(includeApiKeys);
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
  }, [hydrateBackendWithKeyringKeys, addons, includeApiKeys]);

  const applyText = useCallback(async (raw: string) => {
    const blob = parseImportInput(raw);
    if (!blob) {
      setStatus({ kind: "error", message: "Couldn't parse. Paste a valid export string or JSON." });
      return;
    }
    try {
      // Keys to the keyring, the backend patch (retried field by field on a
      // rejection), the Aura merge and the provider ids: all in
      // applySettingsImport (settingsTransfer.ts, shared with the first-run
      // setup).
      const summary = await applySettingsImport(
        blob, addons, (patch) => onApply(patch as Partial<BackendSettings>),
      );
      setStatus(importSummaryStatus(summary));
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
        Save your settings (theme, audio and subtitles, keybindings, skip modes
        and more) as a file or a string to paste. Addon choices are included; on
        import, any addon you have not installed is skipped.
      </p>

      {/* ── Export ── */}
      <div className="space-y-2">
        <p className="text-white/75 text-sm font-medium">Export</p>
        <label className="flex items-start gap-2 text-white/60 text-[11.5px] leading-snug cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeApiKeys}
            onChange={(e) => { setIncludeApiKeys(e.target.checked); setExportText(""); }}
            className="mt-0.5 accent-ln-accent"
          />
          <span>
            Include my API keys (OpenSubtitles, TMDB, IntroDB). Only for moving to
            another device of your own: never share an export made with this on.
          </span>
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={downloadFile}
            className="aura-glass-flat aura-glass-press px-3 py-1.5 rounded-lg
                       text-white/80 text-[12px] font-medium tracking-wide"
          >
            Download as file
          </button>
          <button
            type="button"
            onClick={buildAndShow}
            className="aura-glass-flat aura-glass-press px-3 py-1.5 rounded-lg
                       text-white/80 text-[12px] font-medium tracking-wide"
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
              className="aura-glass-flat aura-glass-press is-primary px-3 py-1.5 rounded-lg
                         text-[12px] font-medium tracking-wide"
            >
              Copy
            </button>
          )}
        </div>
        {exportText && (
          <textarea
            readOnly
            value={exportText}
            className="aura-glass-field w-full h-24 rounded-md px-3 py-2
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
          className="aura-glass-field w-full h-24 rounded-md px-3 py-2
                     text-[11px] font-mono text-white/85 outline-none
                     resize-none break-all"
          spellCheck={false}
        />
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!importText.trim()}
            onClick={() => applyText(importText)}
            className="aura-glass-flat aura-glass-press is-primary px-3 py-1.5 rounded-lg
                       text-[12px] font-medium tracking-wide
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Apply pasted string
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="aura-glass-flat aura-glass-press px-3 py-1.5 rounded-lg
                       text-white/80 text-[12px] font-medium tracking-wide"
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

      {/* ── Run setup again ──
          Re-opens the first-run wizard. Every step there reads and writes
          the live settings, so nothing is reset by opening it. */}
      <div
        className="flex items-center justify-between gap-4"
        data-settings-row=""
        data-settings-label="Run setup again"
        data-settings-description={RERUN_SETUP_DESCRIPTION}
      >
        <div className="flex-1 min-w-0">
          <p className="text-white/75 text-sm font-medium">Run setup again</p>
          <p className="text-white/35 text-xs mt-0.5">{RERUN_SETUP_DESCRIPTION}</p>
        </div>
        <button
          type="button"
          onClick={() => requestRerunOnboarding()}
          className="aura-glass-flat aura-glass-press flex-shrink-0 px-3 py-1.5 rounded-lg
                     text-white/80 text-[12px] font-medium tracking-wide"
        >
          Run setup again
        </button>
      </div>

      <div className="h-px bg-white/6" />

      {/* ── Local-data backups (Queue / History / manual marks) ──
          Distinct from the export / import above: those round-trip
          settings between machines. THIS round-trips the user-data
          slice that lives only in localStorage (Queue, watch history,
          manual watched marks, AuraSettings). Snapshots are auto-
          captured on change (debounced 30 s) and capped at 10 per
          scope; the user can also create / restore / delete by hand
          here. Restore overwrites the current state - confirm-prompts
          guard the destructive path. */}
      <LocalDataBackupsSubsection />

      {/* ── Danger zone: full reset ──
          Wipes both the backend AppSettings (theme / audio / subs /
          keybindings / discord / scrobble / etc.) AND the localStorage
          AuraSettings (catalog / stream / search provider URL lists).
          Two-click confirm: first click arms; second click within 5 s
          actually fires. Auto-disarms after 5 s. Behind Show advanced
          settings; export / import above stays visible. */}
      <AdvancedOnly>
        <div className="h-px bg-white/6" />
        <div
          className="space-y-2"
          data-settings-row=""
          data-settings-label="Reset all settings"
          data-settings-description="Returns every setting to its default, including your catalog, stream and search provider choices. Installed addons are kept. There is no undo."
        >
          <p className="text-rose-300/95 text-sm font-medium">Reset all settings<AdvancedTag /></p>
          <p className="text-white/45 text-xs leading-relaxed">
            Returns every setting to its default, including your catalog, stream
            and search provider choices. Installed addons are kept. There is no undo.
          </p>
          <button
            type="button"
            onClick={resetArmed ? confirmReset : armReset}
            className={[
              "aura-glass-flat aura-glass-press is-danger px-3 py-1.5 rounded-lg text-[12px] font-medium tracking-wide",
              resetArmed ? "is-strong" : "",
            ].join(" ")}
          >
            {resetArmed ? "Click again within 5 s to confirm" : "Reset all settings"}
          </button>
        </div>
      </AdvancedOnly>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// LocalDataBackupsSubsection - view + restore + create/delete the on-disk
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

  // The scope snapshots are actually being written under. Must come from
  // `getActiveBackupScope()`, which App.tsx feeds from the live auth_key -
  // the same value the auto-snapshot writer uses.
  //
  // This used to scan localStorage for the first `aura:manual-state:` key and
  // take its suffix. That silently listed the WRONG directory: every Stremio
  // re-login rotates `auth_key`, the scope prefix changes with it, and the old
  // `aura:manual-state:user-<hex>` entries are never cleaned up - so the scan
  // returned whichever key enumeration reached first (in practice the oldest
  // account) while snapshots kept being written to the current one. The
  // symptom was a panel reporting "0 auto" next to a multi-megabyte on-disk
  // total, with a month of real auto-snapshots sitting invisible one directory
  // over. `backupStorageUsed()` counts every scope, which is why the byte
  // total looked right while the list did not.
  // Reactive: App.tsx resolves the account scope from the auth session AFTER
  // this panel's first render, so a value read once at render time would be
  // stuck on the pre-resolution "guest" and list the wrong directory.
  const [currentScope, setCurrentScope] = useState(getActiveBackupScope);
  useEffect(() => {
    const sync = () => setCurrentScope(getActiveBackupScope());
    sync();
    window.addEventListener(BACKUP_SCOPE_EVENT, sync);
    return () => window.removeEventListener(BACKUP_SCOPE_EVENT, sync);
  }, []);

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
      // Same authoritative scope the list and the auto-writer use. The old
      // localStorage scan here was the reason a manual snapshot could land in
      // a stale account's directory and then not appear in the list beside it.
      const meta = await createSnapshot("manual", getActiveBackupScope());
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
      // userDataBackup.ts's header - practising what we preach here
      // is what makes the recovery story actually trustworthy.
      // Read FIRST: a corrupt target must not push a good row out of the
      // bucket, and the snapshot's own prune must not delete the target (the
      // oldest row, the usual rollback), hence `protect`.
      const payload = await readSnapshot(meta.scope, meta.fileName);
      if (!payload) {
        setStatus({ kind: "error", message: "Couldn't read snapshot." });
        await refresh();
        return;
      }
      const rollback = await createSnapshot("pre-restore", meta.scope, undefined, meta.fileName);
      if (!rollback) {
        setStatus({ kind: "error", message: "Restore stopped: Aura couldn't save a snapshot of your current data to roll back to. Nothing was changed." });
        return;
      }
      applyBackupPayload(payload);
      // No longer asks for a refresh: applyBackupPayload now reloads the stores'
      // in-memory mirrors, so the restored data is live immediately. It used to
      // only write localStorage and fire change events, which re-rendered
      // against the pre-restore values, and no amount of refreshing short of an
      // app restart would have helped.
      setStatus({ kind: "ok", message: "Restored." });
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
      // fired even when the file wasn't actually removed - the bug
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

  // Manual / auto split - manual snapshots ("manual" + "pre-restore"
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
        className="aura-glass-flat aura-glass-press is-primary px-2.5 py-1 rounded-md
                   text-[11px] font-medium
                   disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Restore
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => setConfirmDelete(meta)}
        className="aura-glass-flat aura-glass-press is-danger px-2.5 py-1 rounded-md
                   text-[11px] font-medium
                   disabled:opacity-40 disabled:cursor-not-allowed"
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
          watched / planned / skipped marks and Aura's UI preferences, saved under
          <code className="font-mono text-white/55 mx-1">backups/</code>
          in Aura's app data. Aura keeps the last 10 automatic snapshots (taken
          30 s after a change) and the last 10 manual ones, per account.
        </p>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="aura-glass-flat aura-glass-press px-3 py-1.5 rounded-lg
                     text-white/80 text-[12px] font-medium tracking-wide
                     disabled:opacity-40 disabled:cursor-not-allowed"
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
          message={`Restore the snapshot from ${fmtTimestamp(confirmRestore.createdAtMs)}? It replaces your current Queue, History, marks and Aura UI preferences. Aura saves a safety snapshot first.`}
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

/** Centred modal confirm dialog - replaces the previous inline "are you
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

  // Tone rides the glass hooks (aura-glass-tone-*, glass-settings.css): a
  // ring-* utility on a glass surface would be overridden by its box-shadow.
  const accent = tone === "danger"
    ? { ring: "aura-glass-tone-danger", btn: "is-danger is-strong", icon: "text-rose-300" }
    : { ring: "aura-glass-tone-warning", btn: "is-warning is-strong", icon: "text-amber-300" };

  const node = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-6"
      onClick={onCancel}
    >
      {/* Dim + blur on a sibling layer: on the wrapper it would blind the
          card's own glass (an ancestor backdrop-filter is a backdrop root). */}
      <div aria-hidden className="aura-modal-backdrop-in absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`aura-float-glass aura-modal-card-in relative max-w-[400px] w-full rounded-2xl ${accent.ring} p-6 space-y-4`}
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
            className="aura-glass-flat aura-glass-press px-4 py-1.5 rounded-lg
                       text-white/80 text-[12px] font-medium"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={`aura-glass-flat aura-glass-press ${accent.btn} px-4 py-1.5 rounded-lg text-[12px] font-medium`}
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
/** "Real glass over video": the switch, plus an honest note when this GPU
 *  could not run the shader (the engine's vo-passes check, glass.rs). The
 *  status is re-asked whenever the switch or the engine's glass state moves.
 *  On a High Contrast theme the shader never draws (realGlass.ts), so the
 *  switch can be turned off there but not on. */
function RealGlassRow({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const glass = useRealGlassState();
  const floor = useGlassState().contrastFloor;
  const [available, setAvailable] = useState(true);
  useEffect(() => {
    let alive = true;
    void realGlassAvailable().then((a) => { if (alive) setAvailable(a); });
    return () => { alive = false; };
  }, [value, glass]);
  let description =
    "Experimental. Blurs the actual video behind the player's control bar and open menus so the picture "
    + "shows through like glass; bright scenes are toned down under the controls to keep them readable. "
    + "Each time the controls appear or hide it may cause a small hitch on HDR video with motion smoothing on. "
    + "Black bars around the picture keep the normal tint. Stays on this device.";
  if (floor) description += " Not used on the High Contrast themes, which keep the solid player background.";
  if (value && !available) {
    description += " Not available on this system: the graphics card could not run the glass effect, so the player keeps its normal look.";
  }
  return (
    <SettingToggle
      label="Real glass over video"
      description={description}
      value={value}
      onChange={onChange}
      disabled={floor && !value}
    />
  );
}

function HdrPeakNitsRow({
  value, onChange,
}: { value: number; onChange: (v: number) => void }) {
  // Common panel peaks: DisplayHDR True Black 400 OLEDs really peak
  // ~400-465 nits; HDR600 / HDR1000 monitors at their certification
  // levels. 0 = trust what Windows reports for the display.
  const PRESETS = [0, 400, 465, 600, 1000];
  const clamped = Math.max(0, Math.min(10000, value));
  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label="HDR display peak (nits)"
      data-settings-description="The peak brightness HDR is tone-mapped to in Send HDR (passthrough) mode. Leave on Auto unless highlights look blown out (common on OLEDs in DisplayHDR True Black mode; try 400-465)."
    >
      <div>
        <p className="text-white/75 text-sm font-medium">HDR display peak (nits)</p>
        <p className="text-white/35 text-xs mt-0.5">
          The peak brightness HDR is tone-mapped to in Send HDR (passthrough)
          mode. Leave on Auto unless highlights look blown out (common on OLEDs
          in DisplayHDR True Black mode; try 400-465).
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <SegmentedControl<string>
          value={String(clamped)}
          options={PRESETS.map((p) => ({ value: String(p), label: p === 0 ? "Auto" : `${p}` }))}
          onChange={(v) => onChange(Number(v))}
          ariaLabel="HDR display peak presets"
        />
        <div className="flex items-center gap-2 ml-1 text-[12px]">
          <input
            type="number"
            min={0}
            max={10000}
            value={clamped}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(Math.max(0, Math.min(10000, Math.round(n))));
            }}
            className="aura-glass-field w-20 rounded-lg px-2 py-1
                       text-white/85 outline-none
                       text-center tabular-nums"
          />
          <span className="text-white/40">nits (0 = auto)</span>
        </div>
      </div>
    </div>
  );
}

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
      data-settings-description="Seconds before an episode ends to show the Next Up card, when Aura has not found where the ending starts (otherwise the card appears as the ending begins). 0 turns the card off, and with it the next-episode pre-scan (under Show advanced settings)."
    >
      <div>
        <p className="text-white/75 text-sm font-medium">Next-Up lead time</p>
        <p className="text-white/35 text-xs mt-0.5">
          Seconds before an episode ends to show the Next Up card, when Aura
          has not found where the ending starts (otherwise the card appears as
          the ending begins). 0 turns the card off, and with it the
          next-episode pre-scan (under Show advanced settings).
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <SegmentedControl<string>
          value={String(clamped)}
          options={PRESETS.map((p) => ({ value: String(p), label: p === 0 ? "Off" : `${p}s` }))}
          onChange={(v) => onChange(Number(v))}
          ariaLabel="Next-Up lead time presets"
        />
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
            className="aura-glass-field w-16 rounded-lg px-2 py-1
                       text-white/85 outline-none
                       text-center tabular-nums"
          />
          <span className="text-white/40">seconds</span>
        </div>
      </div>
    </div>
  );
}

/** Countdown-seconds selector for the Auto-advance toggle: how long the
 *  end-of-episode screen counts down before starting the next episode (the
 *  Next-Up card itself never counts down; nothing advances before the end of
 *  the stream). Same chip + number-input pattern as NextUpLeadTimeRow, but a
 *  tighter range ([5, 30]) since the user has consciously opted into
 *  auto-advance: zero would be "skip immediately" (not useful), >30 would be
 *  no better than pressing play. Default 10 is a comfortable middle ground
 *  that gives time to grab the remote / mouse. */
function AutoAdvanceDelayRow({
  value, onChange, disabled = false,
}: { value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const PRESETS = [5, 10, 15, 20, 30];
  const clamped = Math.max(5, Math.min(30, value));
  return (
    <fieldset
      disabled={disabled}
      className={`space-y-2 min-w-0 ${disabled ? "opacity-40" : ""}`}
      data-settings-row=""
      data-settings-label="Auto-advance delay"
      data-settings-description="How long the end-of-episode countdown runs before the next episode starts. Any mouse, key or scroll input cancels it."
    >
      <div>
        <p className="text-white/75 text-sm font-medium">Auto-advance delay</p>
        <p className="text-white/35 text-xs mt-0.5">
          How long the end-of-episode countdown runs before the next
          episode starts. Any mouse, key or scroll input cancels it.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <SegmentedControl<string>
          value={String(clamped)}
          options={PRESETS.map((p) => ({ value: String(p), label: `${p}s` }))}
          onChange={(v) => onChange(Number(v))}
          ariaLabel="Auto-advance delay presets"
        />
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
            className="aura-glass-field w-16 rounded-lg px-2 py-1
                       text-white/85 outline-none
                       text-center tabular-nums"
          />
          <span className="text-white/40">seconds</span>
        </div>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// KeyringApiKeyInput - text input backed directly by the OS keyring
// (via the Rust api_keyring commands). Reads on mount; writes on every
// blur / Enter to avoid hammering the keyring on every keystroke.
// Wrapped with the same data-settings-row attributes as SettingText so
// the search highlighter picks it up.
// ---------------------------------------------------------------------------

function KeyringApiKeyInput({
  name, label, description, placeholder, link,
}: {
  name: "opensubtitles" | "tmdb" | "introdb";
  label: string;
  description: string;
  placeholder?: string;
  /** Optional "get a key" link under the description, opened in the system
   *  browser through the http(s)-only gate. */
  link?: { label: string; url: string };
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

  // Masked vs revealed - masked is the default since these are
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
      {link && (
        <button
          type="button"
          onClick={() => openExternalUrl(link.url)}
          className="text-ln-accent/85 hover:text-ln-accent text-xs underline underline-offset-2 -mt-1"
        >
          {link.label}
        </button>
      )}
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
          className={`aura-glass-field w-full rounded-xl px-4 py-2.5 pr-20
                      text-sm font-mono placeholder:text-white/25 outline-none
                      ${!loaded ? "opacity-50" : ""}`}
          style={{ color: "var(--text-primary)" }}
        />
        <button
          type="button"
          onClick={() => setRevealed((r) => !r)}
          disabled={value.length === 0}
          className="aura-glass-flat absolute right-2 top-1/2 -translate-y-1/2
                     px-2 py-1 rounded-md text-[10.5px] font-medium tracking-wide
                     text-white/55
                     hover:text-white
                     disabled:opacity-30"
        >
          {revealed ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CloudSyncSection - diagnostic + control surface for Aura Cloud sync.
//
// Three top-level states based on `sync_status()`:
//   • Guest - no Stremio session → no sync available. Show a card with
//     a "Sign in" CTA (dispatches `aura:show-login` for App.tsx to
//     surface the LoginView modal).
//   • Connected, empty - connected but no namespaces have been written
//     yet. Show a "you're set up, nothing pushed yet" message + the
//     Pull Now / Clear actions (so the user can manually pull state
//     from another device).
//   • Connected, active - full namespace table with last-updated +
//     size per row, total/quota footer, Pull / Purge actions.
//
// Polls `sync_status` every 30 s while mounted, re-fetches immediately
// on `aura:settings-changed` + `aura:session-changed`, and on any
// user-triggered push/pull/purge action.
//
// Only the guest card is always on screen. The loading state and the
// connected panel (namespace table, Push / Pull / Clear) are behind Show
// advanced settings, so each branch returns its own trailing divider: a
// hidden panel takes its separator from the release-feed toggle with it.
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
  "skip-marks":       "Skipped episodes",
  "auto-bumped":      "Auto-bumped series",
  "notifications":    "Notifications",
  "recent-searches":  "Recent searches",
  "title-state":      "Per-title preferences",
  "anilist-id-map":   "AniList ID cache",
  "history":          "Watch history",
};

function CloudSyncSection({ authKey }: { authKey: string | null }) {
  const [status, setStatus] = useState<SyncStatusResp | null>(null);
  const [errored, setErrored] = useState(false);
  const [busyAction, setBusyAction] = useState<null | "pull" | "purge" | "push">(null);
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  // Tick for relative-time labels - refreshes every 30 s so "5 minutes
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
    const onSignal = () => { void refresh(); };
    window.addEventListener("aura:settings-changed", onSignal);
    window.addEventListener("aura:session-changed",  onSignal);
    return () => {
      window.removeEventListener("aura:settings-changed", onSignal);
      window.removeEventListener("aura:session-changed",  onSignal);
    };
  }, [refresh]);
  // Status IPC + relative-time tick: paused while the window is minimized /
  // occluded (the Settings page isn't visible there), with one refresh on
  // restore so a stale "5 minutes ago" snaps current.
  useIdleGatedInterval(() => { void refresh(); }, 30_000, { runOnResume: true });
  useIdleGatedInterval(() => setTickNow(Date.now()), 30_000, { runOnResume: true });

  const handlePullNow = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("pull");
    try {
      const { syncPullAll } = await import("../sync");
      await syncPullAll();
      showAppToast("Cloud Sync pulled successfully", { duration: 2500, scope: SETTINGS_TOAST_SCOPE });
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
      showAppToast(`Pushed ${NAMESPACE_LABEL[ns] ?? ns}`, { duration: 2000, scope: SETTINGS_TOAST_SCOPE });
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
      showAppToast("Cloud Sync data cleared", { duration: 2500, scope: SETTINGS_TOAST_SCOPE });
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
      <>
        <div
          data-settings-row=""
          data-settings-label="Cloud Sync"
          data-settings-description="Aura Cloud: sign in to Stremio to sync your settings, queue, watched and skipped marks, watch history, recent searches, per-title preferences and notifications across devices. Aura Cloud knows you only by a hash made on this device, never your account id or auth key."
          className="space-y-2"
        >
          <p className="text-white/55 text-sm leading-relaxed">
            Sign in to Stremio to sync your settings, queue, watched and skipped marks, watch history, recent searches, per-title preferences and notifications across devices.
          </p>
          <p className="text-white/35 text-xs leading-relaxed">
            Your library and resume positions sync through Stremio itself. Aura Cloud knows you only by a hash made on this device, never your account id or auth key.
          </p>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent("aura:show-login"))}
            className="aura-glass-flat aura-glass-press is-primary mt-1 px-3 py-1.5 rounded-lg
                       text-[12px] font-semibold tracking-wide"
          >
            Sign in to Stremio
          </button>
        </div>
        <div className="h-px bg-white/6 my-3" />
      </>
    );
  }

  // ── Loading / error state ─────────────────────────────────────────
  if (!status) {
    return (
      <AdvancedOnly>
        <div
          data-settings-row=""
          data-settings-label="Cloud Sync"
          data-settings-description="Aura Cloud sync status loading."
          className="text-white/40 text-xs"
        >
          {errored ? (
            <div className="space-y-2">
              <p>Couldn't reach Aura Cloud.<AdvancedTag /></p>
              <button
                type="button"
                onClick={() => void refresh()}
                className="aura-glass-flat aura-glass-press px-3 py-1.5 rounded-md text-white/75
                           text-[11px] font-medium"
              >
                Retry
              </button>
            </div>
          ) : (
            <p>Loading sync status…<AdvancedTag /></p>
          )}
        </div>
        <div className="h-px bg-white/6 my-3" />
      </AdvancedOnly>
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
    <AdvancedOnly>
      <div
        data-settings-row=""
        data-settings-label="Cloud Sync"
        data-settings-description="Per-namespace last pull / push / size; Pull now and Clear cloud sync data actions."
        className="space-y-3"
      >
        {/* Top status line */}
        <div className="flex items-center justify-between gap-3 text-[12px]">
          <span className="text-white/75 font-medium">
            {lastSyncMs ? `Last activity ${formatAgo(tickNow - lastSyncMs)}` : "Connected - no data yet"}
            <AdvancedTag />
          </span>
          <span className="text-white/35 font-mono tabular-nums">
            {formatBytes(status.total_size)} / {formatBytes(status.quota)}
          </span>
        </div>

        {/* Approaching-quota hint */}
        {quotaPctTotal >= 95 && (
          <p className="text-amber-300/85 text-[11px]">
            Nearly at the {formatBytes(status.quota)} per-account limit. Clear cloud sync data below to free space.
          </p>
        )}

        {/* Namespace table */}
        {status.namespaces.length > 0 && (
          <div className="rounded-lg border border-white/8 divide-y divide-white/6">
            {status.namespaces.map((ns) => {
              const ago = ns.updated_at ? formatAgo(tickNow - ns.updated_at * 1000) : "Never";
              const sizeKb = ns.size != null ? formatBytes(ns.size) : "-";
              const overQuota = ns.size != null && ns.size > 1024 * 1024 * 0.95;
              // A history too big for one blob syncs its newest rows only
              // (history_store.rs cloud_encode_rows); say so, never silently.
              const trim = ns.name === "history" ? getHistoryCloudTrim() : null;
              return (
                <div key={ns.name}
                     className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
                  <div className="min-w-0 flex-1">
                    <p className="text-white/85 font-medium truncate">
                      {NAMESPACE_LABEL[ns.name] ?? ns.name}
                    </p>
                    <p className="text-white/40 text-[10.5px] mt-0.5">
                      {ago} · <span className={overQuota ? "text-amber-300/80" : ""}>{sizeKb}</span>
                      {trim && trim.included < trim.total && (
                        <> · Cloud copy holds the newest {trim.included.toLocaleString()} of {trim.total.toLocaleString()} entries</>
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => void handlePushNamespace(ns.name)}
                    className="aura-glass-flat aura-glass-press px-2 py-1 rounded-md text-[10.5px] font-medium tracking-wide
                               text-white/65
                               hover:text-white
                               disabled:opacity-40 disabled:cursor-not-allowed"
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
            className="aura-glass-flat aura-glass-press is-primary px-3 py-1.5 rounded-lg
                       text-[11.5px] font-semibold tracking-wide
                       disabled:opacity-50 disabled:cursor-progress"
          >
            {busyAction === "pull" ? "Pulling…" : "Pull now"}
          </button>
          <button
            type="button"
            disabled={busyAction !== null || status.namespaces.length === 0}
            onClick={() => setPurgeConfirm(true)}
            className="aura-glass-flat aura-glass-press is-danger px-3 py-1.5 rounded-lg
                       text-[11.5px] font-medium tracking-wide
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear cloud sync data
          </button>
        </div>

        {/* Privacy footer */}
        <p className="text-white/35 text-[10.5px] leading-relaxed pt-2 border-t border-white/6">
          Aura Cloud stores your data under a hash of your Stremio account id made on this device; your account id and auth key never reach it. Your library and resume positions sync through Stremio itself.
        </p>

        {/* Purge confirm modal */}
        {purgeConfirm && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center">
            <div aria-hidden className="aura-modal-backdrop-in absolute inset-0 bg-black/60 backdrop-blur-sm" />
            <div
              role="dialog"
              aria-modal="true"
              className="aura-float-glass aura-modal-card-in relative max-w-[400px] mx-4 rounded-2xl p-5 space-y-3"
            >
              <h3 className="text-white/95 text-sm font-semibold tracking-wide">Clear cloud sync data?</h3>
              <p className="text-white/55 text-xs leading-relaxed">
                Permanently deletes everything synced to Aura Cloud. This device keeps its settings, queue and marks, and other devices get this device's copy on their next sync.
              </p>
              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setPurgeConfirm(false)}
                  className="aura-glass-flat aura-glass-press px-3 py-1.5 rounded-lg
                             text-white/75 text-[11px] font-medium"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handlePurge()}
                  className="aura-glass-flat aura-glass-press is-danger px-3 py-1.5 rounded-lg
                             text-[11px] font-semibold"
                >
                  Clear data
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="h-px bg-white/6 my-3" />
    </AdvancedOnly>
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
  const [changelogOpen, setChangelogOpen] = useState(false);
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
          <div className="text-white/45 text-[12px] mt-1 font-mono flex items-center gap-2 flex-wrap">
            <span>v{APP_VERSION}</span>
            <button
              type="button"
              onClick={() => setChangelogOpen(true)}
              className="aura-glass-flat is-primary px-1.5 py-0.5 rounded text-[10.5px] font-sans tracking-normal"
            >
              Changelog
            </button>
            <span className="text-white/15">·</span>
            <span>{addonCount} addon{addonCount === 1 ? "" : "s"}</span>
          </div>
        </div>
        <CheckForUpdatesButton />
      </div>
      {changelogOpen && (
        <Changelog currentVersion={APP_VERSION} onClose={() => setChangelogOpen(false)} />
      )}

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

      <div className="h-px bg-white/6" />

      {/* Data-source attribution.
          Arc key art is CC BY-SA, which requires credit wherever it is used.
          ArcGrid carries its own contextual line, but arc art now also
          appears on Continue Watching tiles and the detail page backdrop, and
          neither of those has anywhere to put one. This is the app-wide
          notice that covers those surfaces. It is unconditional on purpose:
          a credit that appears only sometimes is worse than one that always
          does, and it costs one line. */}
      <p className="text-white/25 text-[10px] leading-relaxed">
        Metadata from TMDB, MyAnimeList via Tenrai, and AniList. This product uses
        the TMDB API but is not endorsed or certified by TMDB. Story arc artwork
        from Fandom, licensed CC BY-SA.
      </p>
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
// CheckForUpdatesButton - manual GitHub releases check, rate-limited.
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
      // is "you're up to date" - call it that to avoid alarming
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

  const tone = state === "available" ? "is-primary" : "text-white/80";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={state === "checking"}
      className={[
        "aura-glass-flat aura-glass-press flex-shrink-0 px-3 py-1.5 rounded-lg",
        "text-[12px] font-medium tracking-wide",
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
// SettingsSearchInput - search-bar pill with grow-in animation, clear button,
// and a small "n matches" pill that fades in once the user starts typing.
//
// Behaviour:
//   • Focus animation - grows the pill width from 220 px → 320 px when
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

  return (
    <div className={compact ? "space-y-1.5" : "flex items-center gap-2"}>
      <div
        className={
          compact
            ? "aura-glass-field aura-settings-search relative flex items-center w-full rounded-lg"
            : `aura-glass-field aura-settings-search aura-glass-morph-w relative flex items-center rounded-full
               ${active ? "w-[320px]" : "w-[220px]"}`
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
          data-aura-search
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
            className="aura-glass-item absolute right-2 w-5 h-5 rounded-full
                       flex items-center justify-center
                       text-white/45 hover:text-white/85"
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
                className="aura-glass-flat aura-glass-press w-6 h-6 rounded-md
                           flex items-center justify-center
                           text-white/55 hover:text-white/95"
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
                className="aura-glass-flat aura-glass-press w-6 h-6 rounded-md
                           flex items-center justify-center
                           text-white/55 hover:text-white/95"
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

/** A section whose TOC leaf is marked `advanced` is itself an advanced unit
 *  (see "Advanced settings" above): absent, hidden, or shown and tagged at
 *  its title, never half-rendered. */
function Section({ id, title, children }: { id?: string; title: string; children: React.ReactNode }) {
  const adv = useContext(AdvancedViewContext);
  const advanced = id !== undefined && ADVANCED_SECTION_IDS.has(id);
  const state = useLatchedUnitState(advanced ? advancedUnitState(adv, id, id) : "shown");
  if (state === "absent") return null;
  return (
    <SectionIdContext.Provider value={id}>
      <section
        id={id}
        className="space-y-4 scroll-mt-6"
        data-advanced-id={advanced ? id : undefined}
        hidden={state === "hidden"}
      >
        <h2 className="text-white/40 text-xs font-semibold tracking-[0.1em] uppercase">
          {title}
          {state === "marked" && <AdvancedPill />}
        </h2>
        <div {...sheet("space-y-5 rounded-[20px] px-5 py-5")}>
          {children}
        </div>
      </section>
    </SectionIdContext.Provider>
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

type TocLeaf  = {
  id: string;
  label: string;
  /** Every row in the section is behind Show advanced settings, so the
   *  section and this leaf hide together (tocLeafShown / Section). */
  advanced?: true;
};
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
// SECTION IDS REMAIN STABLE - `id="sec-..."` in the JSX hasn't moved,
// only the navigation-tree structure here changes. Existing deep-link
// fragments and the search filter still target the same DOM nodes.
const TOC_GROUPS: TocGroup[] = [
  {
    key: "browse",
    label: "Browsing",
    sections: [
      { id: "sec-catalog",     label: "Catalog Providers", advanced: true },
      { id: "sec-streams",     label: "Stream Providers" },
      { id: "sec-search",      label: "Search Providers", advanced: true },
      { id: "sec-spoilers", label: "Spoilers" },
      { id: "sec-hover-panel", label: "Hover Meta Panel" },
      { id: "sec-open-links", label: "Open Links" },
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
      { id: "sec-downloads",  label: "Downloads" },
    ],
  },
  {
    key: "integrations",
    label: "Integrations",
    sections: [
      { id: "sec-discord",         label: "Discord Rich Presence" },
      { id: "sec-scrobble",        label: "Scrobbling" },
      { id: "sec-cloud-sync",      label: "Cloud Sync" },
      { id: "sec-api-keys",        label: "API Keys", advanced: true },
      { id: "sec-crash-reporting", label: "Crash Reporting", advanced: true },
    ],
  },
  {
    // Every leaf is advanced, so the whole group (and its page header)
    // disappears with the switch off.
    key: "system",
    label: "System",
    sections: [
      { id: "sec-performance", label: "Performance", advanced: true },
      { id: "sec-storage",     label: "Storage", advanced: true },
      { id: "sec-optional-components", label: "Optional Components", advanced: true },
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

const ADVANCED_SECTION_IDS: ReadonlySet<string> = new Set(
  TOC_GROUPS.flatMap((g) => g.sections.filter((s) => s.advanced).map((s) => s.id)),
);

/** Whether a TOC leaf is listed: the same unit rule its Section renders by,
 *  so the TOC and the scrollspy only ever point at a section on screen. */
function tocLeafShown(leaf: TocLeaf, adv: AdvancedView): boolean {
  if (!leaf.advanced) return true;
  const state = advancedUnitState(adv, leaf.id, leaf.id);
  return state === "shown" || state === "marked";
}

/** Fast ease-out rAF scroll of `scrollRoot` so `el` is brought into view -
 *  roughly 1.6x faster than native scrollIntoView({ behavior: "smooth" }),
 *  whose duration the browser fixes and we can't speed up. `block: "start"`
 *  parks the element `topInset`px below the container top (mirrors the
 *  sections' scroll-mt-6); `block: "center"` vertically centers it. Jumps
 *  instantly under reduced motion. Shared by every settings section-scroll
 *  (the TOC + the search-match navigation) so they feel identical.
 *  Returns how long the animation runs in ms (0 when it jumps or does not
 *  move), so the TOC can hold its clicked highlight for exactly that long. */
// The running animation's pending rAF id per scroll container. A new scroll
// cancels the old one first: each frame writes an ABSOLUTE scrollTop, so two
// loops left running together fight, and the longer one wins after the
// shorter ends. The page then came to rest on the FIRST target while the
// TOC's click pin held the SECOND leaf, with no later scroll event to
// correct it. A WeakMap so a container that unmounts is not kept alive.
const settingsScrollAnim = new WeakMap<HTMLElement, number>();

function fastScrollToSettingsEl(
  scrollRoot: HTMLElement,
  el: HTMLElement,
  opts?: { block?: "start" | "center"; topInset?: number },
): number {
  // Cancel before measuring, and on every early return below too: a jump or
  // a no-op scroll is still the latest request, and an older loop left
  // running would carry the page away from it.
  const prev = settingsScrollAnim.get(scrollRoot);
  if (prev !== undefined) {
    cancelAnimationFrame(prev);
    settingsScrollAnim.delete(scrollRoot);
  }
  const block = opts?.block ?? "start";
  const topInset = opts?.topInset ?? 24;
  const rootRect = scrollRoot.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  const start = scrollRoot.scrollTop;
  const rel = start + (elRect.top - rootRect.top);
  const raw = block === "center"
    ? rel - (scrollRoot.clientHeight - elRect.height) / 2
    : rel - topInset;
  const target = Math.max(0, Math.min(raw, scrollRoot.scrollHeight - scrollRoot.clientHeight));
  const dist = Math.abs(target - start);
  if (dist < 2) return 0;
  // Reduced motion: jump instantly, no animated scroll.
  if (document.documentElement.getAttribute("data-reduced-motion") === "true") {
    scrollRoot.scrollTop = target;
    return 0;
  }
  const duration = Math.min(280, Math.max(130, dist * 0.32));
  const startTs = performance.now();
  const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
  const stepScroll = (now: number) => {
    const t = Math.min(1, (now - startTs) / duration);
    scrollRoot.scrollTop = start + (target - start) * easeOutCubic(t);
    if (t < 1) settingsScrollAnim.set(scrollRoot, requestAnimationFrame(stepScroll));
    else settingsScrollAnim.delete(scrollRoot);
  };
  settingsScrollAnim.set(scrollRoot, requestAnimationFrame(stepScroll));
  return duration;
}

interface SettingsTocProps {
  scrollRoot: HTMLDivElement | null;
  /** TOC_GROUPS narrowed to what is on screen (tocLeafShown), with any group
   *  left empty dropped. Drives both the list and the scrollspy. */
  groups: TocGroup[];
  /** The "Show advanced settings" switch, rendered under the search. */
  advanced?: {
    value: boolean;
    onChange: (v: boolean) => void;
  };
  /** Search state - when present, the TOC renders the search input
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
  /** A deep link's target, a new object per jump: its leaf is pinned. */
  pin?: { id: string } | null;
}

function SettingsToc({ scrollRoot, groups, advanced, search, pin }: SettingsTocProps) {
  // The TOC is a glass sheet (round 11): its rows are sheet rows under ONE
  // sliding hover droplet (Liquid; Frosted rows keep a hover fill).
  const tocDroplet = useListDroplet<HTMLDivElement>(".aura-sheet-row");
  // Always-expanded layout - the collapsing UX added complexity that the
  // user found more annoying than helpful. Every leaf is visible at once.
  const [activeId, setActiveId] = useState<string>(groups[0]?.sections[0]?.id ?? "");
  // A TOC click pins its leaf while the programmatic scroll it started runs:
  // the spy would otherwise re-judge every animation frame and, for a short
  // section the scroll cannot bring up to the reading line, move the
  // highlight off what the user just clicked. Released when it expires or on
  // the first sign of the user scrolling themselves (see the spy effect).
  // `graceUntil` lets a pin outlive its section not being listed or mounted yet.
  const clickLockRef = useRef<{ id: string; until: number; graceUntil?: number } | null>(null);

  // A deep link parks its section near the end of the page, where the ramp
  // below would light a later leaf. Its pin has no timer: the link re-scrolls
  // up to 550 ms later and sections above can still resize, each firing a scroll
  // event the spy would re-judge, so only the user's own scrolling releases it.
  useEffect(() => {
    if (!pin) return;
    setActiveId(pin.id);
    clickLockRef.current = { id: pin.id, until: Infinity, graceUntil: performance.now() + 700 };
  }, [pin]);

  const scrollToSection = (id: string) => {
    if (!scrollRoot) return;
    const el = scrollRoot.querySelector<HTMLElement>(`#${id}`);
    if (!el) return;
    setActiveId(id);
    // Snappy shared scroll instead of the browser-fixed native smooth
    // scrollIntoView (see fastScrollToSettingsEl).
    const duration = fastScrollToSettingsEl(scrollRoot, el, { block: "start" });
    // 150 ms past the animation covers its last scroll event and the spy's
    // rAF after it (an instant jump, duration 0, still fires one of each).
    clickLockRef.current = { id, until: performance.now() + duration + 150 };
  };

  // Keep the active highlight in sync with whichever section the user
  // is reading. Implementation history:
  //   1. Manual scroll listener that picked the section whose top was
  //      closest to a fixed 16 px offset. Broke for short sections.
  //   2. IntersectionObserver with a negative rootMargin "active band"
  //      between 25 %-50 % from top. The IO callback only fires on
  //      intersection state CHANGES - for sections taller than the
  //      band, neither edge of the band ever crosses the section's
  //      boundary while the user reads through, so no callback fires
  //      and the active id doesn't update.
  //   3. Cached sectionEls + plain scroll listener with rAF debouncing.
  //      Worked but cached the section list once at mount time, so
  //      anything gated by `{backend && (...)}` (Playback, Window,
  //      Integrations, Performance) was missing from the cache and
  //      never highlighted - the spy walk silently skipped over them.
  //   4. Same rAF-debounced walk, but query DOM each frame
  //      instead of caching. 18 querySelector(`#id`) lookups per frame
  //      is microsecond-cheap and means async section mounts (backend
  //      resolution, conditional renders) join the spy walk the moment
  //      they appear.
  //   5. (current) The reading line (active = last section whose top is at
  //      or above it) was a fixed 20 % down the viewport, which is wrong at
  //      both ENDS of the scroll range. At the top, a short first section
  //      (Stream Providers with advanced off) put the second one's top
  //      inside the top 20 % at scrollTop 0, so "Spoilers" lit up on a page
  //      the user had not scrolled. At the bottom, a short trailing section
  //      can never scroll up to the 20 % line, so it could never be active,
  //      and a TOC click on one was overridden by the very scroll it
  //      started. Now the line rides with the scroll position near the
  //      ends: it starts at the sections' 24 px scroll inset at scrollTop 0
  //      and moves down 1 px per px scrolled until it reaches 20 %, holds
  //      there through the middle, and over the last 80 % of a viewport of
  //      scroll moves down 1 px per px again until it reaches the viewport
  //      bottom at the end of the range, so every section, however short,
  //      gets a stretch of scroll in which it is the active one. A page too
  //      short for both ramps (a very tall window) interpolates the line
  //      linearly from the inset to the bottom over its whole scroll range,
  //      which is the same two slopes merged. The line's position in
  //      CONTENT coordinates only ever grows with scrollTop, so the
  //      highlight still advances strictly in document order. A TOC click
  //      also pins its leaf for the length of its scroll, and a deep link
  //      until the user scrolls (clickLockRef).
  // The walk covers only the listed leaves (`groups`), and re-primes when
  // they change, so Show advanced settings can never leave the highlight on
  // a section that just went away. A `hidden` section is skipped as well:
  // its rect is all zeros, which would read as "scrolled past".
  useEffect(() => {
    if (!scrollRoot) return;
    const ALL_SECTIONS = groups.flatMap((g) => g.sections);
    // Mirrors fastScrollToSettingsEl's default topInset (the sections'
    // scroll-mt-6): where a TOC click parks a section's top.
    const INSET = 24;
    const READ_FRACTION = 0.2;

    let raf: number | null = null;
    const update = () => {
      raf = null;
      const lock = clickLockRef.current;
      if (lock) {
        // Honour the pin only while it is live AND its section is still on
        // screen: a groups change (advanced off, a search query) that hid it
        // must not leave the highlight on a leaf that went away.
        const lockedEl = ALL_SECTIONS.some((s) => s.id === lock.id)
          ? scrollRoot.querySelector<HTMLElement>(`#${lock.id}`)
          : null;
        const now = performance.now();
        const onScreen = !!lockedEl && !lockedEl.hidden;
        if (now < lock.until && (onScreen || now < (lock.graceUntil ?? 0))) return;
        clickLockRef.current = null;
      }
      const rootRect = scrollRoot.getBoundingClientRect();
      const h = scrollRoot.clientHeight;
      const maxScroll = Math.max(0, scrollRoot.scrollHeight - h);
      const s = Math.min(Math.max(0, scrollRoot.scrollTop), maxScroll);
      const base = READ_FRACTION * h;
      const topRamp = Math.max(0, base - INSET); // scroll spent reaching 20 %
      const bottomRamp = h - base;               // scroll spent reaching the bottom
      let offset: number;
      if (maxScroll <= 0) {
        offset = INSET;
      } else if (maxScroll < topRamp + bottomRamp) {
        offset = INSET + (s / maxScroll) * (h - INSET);
      } else if (s < topRamp) {
        offset = INSET + s;
      } else if (maxScroll - s < bottomRamp) {
        offset = h - (maxScroll - s);
      } else {
        offset = base;
      }
      // +1 absorbs sub-pixel layout so a section parked exactly on the inset
      // (scrollTop 0, or a TOC click) counts as reached.
      const threshold = rootRect.top + offset + 1;
      let candidate: string | null = null;
      let firstFound: string | null = null;
      for (const s of ALL_SECTIONS) {
        const el = scrollRoot.querySelector<HTMLElement>(`#${s.id}`);
        if (!el || el.hidden) continue;
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

    // Any sign the user is scrolling themselves ends a TOC click's pin at
    // once, so a wheel during the animation is spied normally. These all
    // fire BEFORE the click event of a TOC press (pointerdown, or keydown
    // for Enter / Space), so a click re-pins after its own release.
    const releaseLock = () => { clickLockRef.current = null; };

    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    scrollRoot.addEventListener("wheel", releaseLock, { passive: true });
    scrollRoot.addEventListener("touchstart", releaseLock, { passive: true });
    scrollRoot.addEventListener("pointerdown", releaseLock);
    window.addEventListener("keydown", releaseLock);
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf != null) cancelAnimationFrame(raf);
      scrollRoot.removeEventListener("scroll", onScroll);
      scrollRoot.removeEventListener("wheel", releaseLock);
      scrollRoot.removeEventListener("touchstart", releaseLock);
      scrollRoot.removeEventListener("pointerdown", releaseLock);
      window.removeEventListener("keydown", releaseLock);
      window.removeEventListener("resize", onScroll);
    };
  }, [scrollRoot, groups]);

  return (
    <nav className="flex flex-col max-h-[calc(100vh-6rem-22px)] text-[13px] leading-snug select-none">
      {/* The contents list scrolls within the viewport-capped nav so a long TOC
          (or a high display scale) can't push the pinned search footer below
          the screen edge. */}
      {/* overflow-x hidden (aura-toc-scroll, glass-pages.css): with only
          overflow-y set, x computes to auto, and the hover droplet's grow
          spring overshoots the list's width for a few frames, which flashed
          a horizontal scrollbar under the list. */}
      <div className="aura-toc-scroll relative flex-1 min-h-0 overflow-y-auto aura-scroll flex flex-col gap-3" {...tocDroplet.listProps}>
      <span ref={tocDroplet.ref} aria-hidden className="aura-glass-hl aura-sheet-hl" />
      <p className="px-2.5 pt-1 text-white/55 text-[10.5px] font-mono uppercase tracking-[0.2em]">
        Contents
      </p>
      <ul className="space-y-2">
        {groups.map((g) => {
          const isActiveGroup = g.sections.some((s) => s.id === activeId);
          // Flatten when the group has exactly one sub-section AND its
          // label is the same as the header - drops the redundant
          // subheader row that just repeated the parent name.
          const flat = g.sections.length === 1 && g.sections[0].label === g.label;
          return (
            <li key={g.key}>
              <button
                type="button"
                onClick={() => scrollToSection(g.sections[0].id)}
                aria-current={flat && isActiveGroup ? "location" : undefined}
                data-glass-light={flat && isActiveGroup ? "rim" : undefined}
                className={`aura-sheet-row w-full text-left px-2.5 py-1.5
                            ${flat && isActiveGroup ? "is-selected" : isActiveGroup ? "text-white/95" : "text-white/65 hover:text-white/90"}`}
              >
                <span className="font-medium">{g.label}</span>
              </button>
              {!flat && g.sections.length > 0 && (
                <ul className="mt-0.5 space-y-0.5">
                  {g.sections.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => scrollToSection(s.id)}
                        aria-current={s.id === activeId ? "location" : undefined}
                        data-glass-light={s.id === activeId ? "rim" : undefined}
                        className={`aura-sheet-row is-leaf w-full text-left pl-6 pr-2.5 py-1.5
                                    ${s.id === activeId
                                      ? "is-selected"
                                      : "text-white/60 hover:text-white/85"}`}
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
              sticky bar used to consume - the user actually sees more
              of each section while scrolling.
            • Because the aside itself is `sticky top-6`, the search
              stays in view as the user scrolls without needing a
              second sticky context. */}
      </div>{/* /scroll region - search footer below stays pinned + visible */}

      {search && (
        <div className="pt-3 mt-3 border-t border-white/[0.09] space-y-2 flex-shrink-0 px-1">
          <p className="px-1.5 text-white/55 text-[10.5px] font-mono uppercase tracking-[0.2em]">
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
          {/* Beside the search on purpose: a search reaches the advanced
              rows whether or not this is on (see "Advanced settings"). The
              label wraps the switch, so clicking the text flips it too. */}
          {advanced && (
            <label
              className="flex items-center justify-between gap-3 pt-1.5 cursor-pointer"
              title="Show the provider overrides and power-user settings"
            >
              <span className="text-white/60 text-[12px] leading-snug">Show advanced settings</span>
              <ToggleSwitch value={advanced.value} onChange={advanced.onChange} />
            </label>
          )}
        </div>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// AIOMetadata badge
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// KeybindRow - captures a KeyboardEvent.code on press
// ---------------------------------------------------------------------------

interface KeybindRowProps {
  action: KeybindAction;
  label: string;
  description: string;
  code: string;
  onChange: (next: string) => void;
  /** Label of the action this row's key just moved to: the row glows red,
   *  and says so, for as long as Settings stays open and the row is unbound. */
  lostTo?: string;
}

function KeybindRow({ action, label, description, code, onChange, lostTo }: KeybindRowProps) {
  const [capturing, setCapturing] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!capturing) return;
    // Capture-mode keydown handler. The user can either press a plain
    // key (records bare code, e.g. "Space") or hold Ctrl/Alt/Shift/Meta
    // and press a non-modifier (records "Ctrl+Digit1"). Modifier-only
    // presses are ignored - we wait for the actual chord-completing
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
    setKeyCaptureActive(true);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      setKeyCaptureActive(false);
      window.removeEventListener("keydown", onKey, { capture: true } as any);
    };
  }, [capturing, onChange]);

  // Only while it is still unbound: rebinding it, or a reset, ends the glow.
  const lost = !capturing && !code && !!lostTo;
  return (
    <button
      ref={ref}
      onClick={() => setCapturing(true)}
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
      className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 text-left aura-content-row
                  ${capturing ? "is-capturing" : lost ? "aura-keybind-lost" : ""}`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
        {lost && (
          <p className="text-rose-300/90 text-xs mt-1">
            Its key moved to {lostTo}. Click to bind a new one.
          </p>
        )}
      </div>
      <kbd
        className={`flex-shrink-0 min-w-[64px] px-2.5 py-1 rounded-md text-xs font-mono
                    text-center transition-colors
                    ${capturing
                      ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/50"
                      : lost
                        ? "bg-rose-500/15 text-rose-200 border border-rose-400/45"
                        : "bg-white/8 text-white/75 border border-white/12"
                    }`}
      >
        {capturing
          ? "Press a key…"
          : code
            // Its hotkey is known as Alt+~, and pressing it with Shift works too.
            ? (action === "perf-monitor" ? prettyBinding(code).replace("`", "~") : prettyBinding(code))
            : "Unbound"}
      </kbd>
    </button>
  );
}

/** Bind `spec` to `action` and take it off every other action that had it,
 *  so one key never runs two actions. Returns the labels of the actions that
 *  lost the key, for a toast and a red row each. Specs are compared in canonical form, so a
 *  hand-edited "Shift+Ctrl+KeyS" still counts as "Ctrl+Shift+KeyS". Only rows
 *  Settings shows are cleared: a stale entry has no label to name. */
function rebindKey(
  current: Record<string, string>,
  action: KeybindAction,
  spec: string,
): { map: Record<string, string>; moved: { id: KeybindAction; label: string }[] } {
  const canon = (s: string) => {
    const chord = parseBinding(s);
    return chord ? formatBinding(chord) : null;
  };
  const target = canon(spec);
  const map = { ...current, [action]: spec };
  const moved: { id: KeybindAction; label: string }[] = [];
  if (target == null) return { map, moved };
  for (const other of KEYBIND_ACTIONS) {
    if (other.id === action) continue;
    const had = current[other.id];
    if (had && canon(had) === target) {
      map[other.id] = "";
      moved.push({ id: other.id, label: other.label });
    }
  }
  return { map, moved };
}

const MOUSE_BTN_LABELS: Record<number, string> = {
  1: "Middle click",
  3: "Back button",
  4: "Forward button",
};

/** Captures one of the three non-conflicting mouse buttons (middle /
 *  back / forward) on the next press. Left (0) and right (2) are
 *  rejected - left selects/navigates, right is the card context menu.
 *  Esc cancels capture. Mirrors KeybindRow's capture UX. */
function MouseBindRow({
  label, description, button, onChange,
}: {
  label: string;
  description: string;
  button: number;
  onChange: (next: 1 | 3 | 4) => void;
}) {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    if (!capturing) return;
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === 1 || e.button === 3 || e.button === 4) {
        onChange(e.button as 1 | 3 | 4);
        setCapturing(false);
      }
      // Left (0) / right (2): ignore - keep waiting for a valid button.
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setCapturing(false); }
    };
    const onCtx = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener("mousedown", onDown, { capture: true });
    window.addEventListener("keydown", onKey, { capture: true });
    window.addEventListener("contextmenu", onCtx, { capture: true });
    return () => {
      window.removeEventListener("mousedown", onDown, { capture: true } as any);
      window.removeEventListener("keydown", onKey, { capture: true } as any);
      window.removeEventListener("contextmenu", onCtx, { capture: true } as any);
    };
  }, [capturing, onChange]);

  return (
    <button
      onClick={() => setCapturing(true)}
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={description}
      className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 text-left aura-content-row
                  ${capturing ? "is-capturing" : ""}`}
    >
      <div className="flex-1 min-w-0">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <p className="text-white/35 text-xs mt-0.5">{description}</p>
      </div>
      <kbd
        className={`flex-shrink-0 min-w-[96px] px-2.5 py-1 rounded-md text-xs font-mono
                    text-center transition-colors
                    ${capturing
                      ? "bg-ln-accent/25 text-ln-accent border border-ln-accent/50"
                      : "bg-white/8 text-white/75 border border-white/12"
                    }`}
      >
        {capturing ? "Press a button…" : (MOUSE_BTN_LABELS[button] ?? "Middle click")}
      </kbd>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SettingsView
// ---------------------------------------------------------------------------

interface Props {
  addons: AddonEntry[];
  session: UserSession | null;
}

interface CrashReportingConfig {
  consent: boolean | null;
  dsn: string;
}

export default function SettingsView({ addons, session }: Props) {
  const [aura, setAura] = useState<AuraSettings>(loadAuraSettings);
  const [backend, setBackend] = useState<BackendSettings | null>(null);
  const backendRef = useRef(backend);
  backendRef.current = backend;
  // Keybinding rows whose key moved to another row this visit, and the label
  // of the row it went to. Kept here so the red rows clear when Settings is
  // left (this view unmounts) rather than on a timer the user might miss.
  const [keysLostTo, setKeysLostTo] = useState<Partial<Record<KeybindAction, string>>>({});
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
  // after typing settles for TOAST_QUIET_MS - fast enough that discrete
  // clicks (toggles, selects) still feel acknowledged immediately, but
  // slow enough that a typed word produces a single confirmation.
  const TOAST_QUIET_MS = 700;
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSavedToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => {
      showAppToast("Settings saved", { scope: SETTINGS_TOAST_SCOPE });
      toastTimerRef.current = null;
    }, TOAST_QUIET_MS);
  }, []);
  useEffect(() => {
    return () => {
      // Leaving Settings: drop a save still debouncing (unchanged) and fade
      // this page's confirmations out quickly, so a "Settings saved" pill
      // does not sit over the next page's search bar for seconds.
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      dismissAppToasts(SETTINGS_TOAST_SCOPE);
    };
  }, []);

  // Persist localStorage settings whenever they change. A change to Show
  // advanced settings alone raises no toast: it is a view preference, not a
  // setting, and hydratedRef only covers the hydration case. (A no-op patch,
  // which changes no key, still toasts as it always did.)
  const prevAuraRef = useRef(aura);
  // The `aura` objects that must NOT be saved: re-reads from storage (see
  // adoptStoredAura). Each already IS storage as of its read, so saving it
  // would only write it back (after a reset, recreating the key) and raise
  // "Settings saved" for a change this page did not make. Matched by
  // identity, so a later edit (always a new object) saves normally. A SET,
  // not one slot: two external changes can straddle a commit (an import's
  // backend dispatch, then its keyring round trip, then its own save), and
  // with one slot the second adopt overwrote the mark before the first
  // one's effect ran, which then saved the pre-import copy over the import.
  const adoptedAuraRef = useRef(new WeakSet<AuraSettings>());
  // True only while the effect below is saving, so the settings-changed
  // listener can tell this page's own save (dispatched synchronously) from
  // anyone else's.
  const savingAuraRef = useRef(false);
  useEffect(() => {
    if (adoptedAuraRef.current.has(aura)) {
      prevAuraRef.current = aura;
      return;
    }
    savingAuraRef.current = true;
    try {
      saveAuraSettings(aura);
    } finally {
      savingAuraRef.current = false;
    }
    const prev = prevAuraRef.current;
    prevAuraRef.current = aura;
    const changed = (Object.keys(aura) as (keyof AuraSettings)[]).filter((k) => aura[k] !== prev[k]);
    const viewPrefOnly = changed.length > 0 && changed.every((k) => k === "showAdvancedSettings");
    if (hydratedRef.current && !viewPrefOnly) queueSavedToast();
  }, [aura, queueSavedToast]);

  // Take whatever storage now holds, without saving it back. For a change
  // made anywhere but this page's own save: a full reset, an import, a cloud
  // pull, a player-side toggle. Merging into `aura` instead kept the page's
  // OLD copy, and the next save (on reset, the nudge itself) wrote every
  // stale value straight back over the change.
  const adoptStoredAura = useCallback(() => {
    const fresh = loadAuraSettings();
    adoptedAuraRef.current.add(fresh);
    setAura(fresh);
  }, []);
  useEffect(() => {
    const onChanged = () => {
      if (!savingAuraRef.current) adoptStoredAura();
    };
    window.addEventListener("aura:settings-changed", onChanged);
    return () => window.removeEventListener("aura:settings-changed", onChanged);
  }, [adoptStoredAura]);

  // Load backend settings on mount
  useEffect(() => {
    invoke<BackendSettings>("get_settings")
      .then((b) => {
        setBackend(b);
        hydratedRef.current = true;
      })
      .catch(() => { hydratedRef.current = true; });
  }, []);

  // This page outlives a sign-in / sign-out (a new scope's file) and a cloud
  // pull: re-read rather than keep showing, and editing, the old values.
  useEffect(() => {
    const reread = () => {
      invoke<BackendSettings>("get_settings").then(setBackend).catch(() => {});
    };
    const onSession = () => {
      setKeysLostTo({}); // those red rows belonged to the old scope
      reread();
    };
    const onBackendChange = (e: Event) => {
      if ((e as CustomEvent<{ fromCloud?: boolean }>).detail?.fromCloud) reread();
    };
    window.addEventListener("aura:session-changed", onSession);
    window.addEventListener("aura:backend-settings-changed", onBackendChange);
    return () => {
      window.removeEventListener("aura:session-changed", onSession);
      window.removeEventListener("aura:backend-settings-changed", onBackendChange);
    };
  }, []);

  // Load + watch the crash-reporting sidecar. Refresh whenever the
  // consent modal or another tab writes - keeps both surfaces in sync
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

  // Patch a backend setting and round-trip through update_settings. Rejects when
  // the patch is refused or cannot be saved: the import reports that. The live
  // controls go through patchBackend below. The write, the diff and every event
  // are patchBackendSettings' (backendSettings.ts, shared with the first-run
  // setup); this keeps the page's copy and its "Saved" toast.
  const applyBackendPatch = useCallback(async (patch: Partial<BackendSettings>) => {
    // Diffed against the page's copy as it stands once the write lands (read
    // after the await, so an overlapping earlier patch is already in it).
    const updated = await patchBackendSettings<BackendSettings>(
      patch as Record<string, unknown>,
      () => backendRef.current as unknown as Record<string, unknown> | null,
    );
    backendRef.current = updated;
    setBackend(updated);
    queueSavedToast();
  }, [queueSavedToast]);

  const patchBackend = useCallback(async (patch: Partial<BackendSettings>) => {
    try {
      await applyBackendPatch(patch);
    } catch {
      // ignore - UI keeps its optimistic state
    }
  }, [applyBackendPatch]);

  // An HDR write (hdrMode.ts: the backend patch plus the player apply). Kept
  // like applyBackendPatch: the page's copy follows, with its "Saved" toast.
  const applyHdrWrite = useCallback(async (write: () => Promise<BackendSettings>) => {
    try {
      const updated = await write();
      backendRef.current = updated;
      setBackend(updated);
      queueSavedToast();
    } catch {
      // ignore - the row keeps showing the stored value
    }
  }, [queueSavedToast]);

  // An HDR mode written from elsewhere (the bell's "Turn on", the Off
  // migration, the setup wizard), or the audio order written by its one-time
  // repair or the bell's Undo: re-read so this page never shows, diffs
  // against, or (on the next edit of that list) writes back the old value.
  useEffect(() => {
    const reread = () => {
      invoke<BackendSettings>("get_settings").then(setBackend).catch(() => {});
    };
    window.addEventListener(HDR_MODE_CHANGED_EVENT, reread);
    window.addEventListener(AUDIO_ORDER_CHANGED_EVENT, reread);
    return () => {
      window.removeEventListener(HDR_MODE_CHANGED_EVENT, reread);
      window.removeEventListener(AUDIO_ORDER_CHANGED_EVENT, reread);
    };
  }, []);

  // False once this page is leaving. React runs a removed tree's effect
  // cleanups parent first, so a slider committing from its own cleanup
  // (SettingSlider) sees it already false.
  const pageLiveRef = useRef(false);
  useEffect(() => {
    pageLiveRef.current = true;
    return () => { pageLiveRef.current = false; };
  }, []);

  const setLocal = (patch: Partial<AuraSettings>) =>
    setAura((prev) => ({ ...prev, ...patch }));

  const addonOptions = addons.map((a) => ({ value: a.url, label: a.name }));
  const themeOptions: { value: ThemeId; label: string }[] =
    (Object.entries(THEME_LABELS) as [ThemeId, string][]).map(([value, label]) => ({ value, label }));

  // ── Show advanced settings ────────────────────────────────────────────
  // The persisted switch lives in `aura`; the two temporary reveals do not,
  // so neither a search nor a deep link ever writes it (see "Advanced
  // settings" at the top of this file). `revealedSections` is component
  // state on purpose: SettingsView unmounts when the user leaves Settings,
  // which is exactly when a deep link's reveal should end.
  const [revealedSections, setRevealedSections] = useState<ReadonlySet<string>>(NO_IDS);
  const [advancedHits, setAdvancedHits] = useState<ReadonlySet<string>>(NO_IDS);

  // Pre-compute the URL list shown in the Stream Providers picker. While
  // streamAddonUrls is null (the backward-compatible default), the picker
  // reflects "every stream addon is queried" by showing all of them as
  // selected; the user's first edit then commits a specific array.
  const effectiveStreamUrls = aura.streamAddonUrls
    ?? addons.filter(isStreamProvider).map((a) => a.url);

  // Same pattern for the Search Providers picker. `null` (default) means
  // "every search-capable addon"; the first edit commits a concrete array.
  const effectiveSearchUrls = aura.searchAddonUrls
    ?? addons.filter(isSearchProvider).map((a) => a.url);

  // The scroll container the TOC observes for active-section highlighting
  // AND the target for `scrollIntoView`. Captured via ref so the TOC can
  // access it once the DOM is mounted.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => { setScrollEl(scrollRef.current); }, []);
  const [tocPin, setTocPin] = useState<{ id: string } | null>(null);

  // Consume the section anchor set by App's aura:open-settings handler
  // (window.location.hash). Without this, deep-linking to a Settings
  // section (a scrobble re-auth notification, scrobble onboarding, the title
  // bar's ServiceStatusChip) switched the view but never scrolled.
  useEffect(() => {
    if (!scrollEl) return;
    let raf = 0;
    const timers: number[] = [];
    const clearPending = () => {
      cancelAnimationFrame(raf);
      timers.forEach((t) => clearTimeout(t));
      timers.length = 0;
    };
    const jump = () => {
      const id = window.location.hash.replace(/^#/, "");
      if (!id) return;
      // One-shot: drop the anchor from the URL immediately so a later PLAIN
      // navigation to Settings (NavSidebar) doesn't re-scroll from a stale
      // hash. replaceState fires no `hashchange` and leaves no bare `#`.
      history.replaceState(null, "", window.location.pathname + window.location.search);
      // Reveal the target's advanced rows (or the whole section, when it is
      // an advanced one) until the user leaves Settings. The section renders
      // on the next commit; the settle-window re-runs below reach it there.
      setRevealedSections((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
      setTocPin({ id });
      const scrollToTarget = () => {
        const el = scrollEl.querySelector<HTMLElement>(`#${window.CSS.escape(id)}`);
        if (el) el.scrollIntoView({ behavior: "auto", block: "start" });
      };
      // The target can sit far down a long, partly-async page; sections above
      // it mount / resize after the first frame and shift its final position.
      // Re-run across a short settle window so we converge on the requested
      // section instead of parking on an earlier one.
      clearPending();
      raf = requestAnimationFrame(scrollToTarget);
      timers.push(window.setTimeout(scrollToTarget, 120));
      timers.push(window.setTimeout(scrollToTarget, 300));
      timers.push(window.setTimeout(scrollToTarget, 550));
    };
    jump();                                    // already-on-Settings case
    window.addEventListener("hashchange", jump);
    return () => {
      clearPending();
      window.removeEventListener("hashchange", jump);
    };
  }, [scrollEl]);

  // ── Settings search ───────────────────────────────────────────────────
  //
  // Forgiving fuzzy filter over visible Sections. Each whitespace-separated
  // token in the query must appear as a CHARACTER SUBSEQUENCE in the
  // section's text content (case-insensitive) - so "subfsz" matches
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
      setAdvancedHits(NO_IDS);
      return;
    }
    let matches = 0;
    const matchedNow: string[] = [];
    const hits = new Set<string>();
    rows.forEach((r, idx) => {
      const label       = r.getAttribute("data-settings-label") ?? "";
      const description = r.getAttribute("data-settings-description") ?? "";
      const ok = matchesSettingRow(q, label, description);
      if (ok) {
        matches += 1;
        // DOM-position-based id - stable within a render and unique
        // even if two settings happen to share a label.
        matchedNow.push(String(idx));
        r.classList.add("settings-row-matched");
        // A match inside an advanced unit reveals the unit. With the switch
        // off, every unit is mounted `hidden` while a query is active, so
        // this walk sees its rows; the re-render this schedules (before
        // paint) un-hides the ones that match. Hiding only toggles an
        // attribute, so `matchedNow`'s DOM positions survive it.
        for (
          let unit = r.closest<HTMLElement>("[data-advanced-id]");
          unit;
          unit = unit.parentElement?.closest<HTMLElement>("[data-advanced-id]") ?? null
        ) {
          hits.add(unit.getAttribute("data-advanced-id") ?? "");
        }
      } else {
        r.classList.remove("settings-row-matched");
      }
    });
    matchCountRef.current = matches;
    setMatchCount(matches);
    setMatchedIds(matchedNow);
    // Keep the old Set when nothing changed, so a keystroke that reveals
    // nothing new does not re-filter the TOC or re-arm its scrollspy.
    setAdvancedHits((prev) => (
      prev.size === hits.size && [...hits].every((h) => prev.has(h)) ? prev : hits
    ));
    // Reset to the first match when the matched-list changes - the
    // user typically wants to start at the top of results.
    setCurrentMatchIdx(matchedNow.length > 0 ? 0 : -1);
  }, [searchQuery]);

  // Auto-scroll to the focused match. Runs whenever the index moves
  // (prev / next clicks) or the matched-list changes. Each id in
  // `matchedIds` is a DOM-position index into the row NodeList; we
  // re-query the rows here rather than holding refs because rows
  // can unmount/remount across renders (conditionally-rendered
  // rows like HdrPeakNitsRow or the meta panel button).
  useEffect(() => {
    if (currentMatchIdx < 0) return;
    const idxStr = matchedIds[currentMatchIdx];
    if (!idxStr) return;
    const rowIdx = Number(idxStr);
    const root = scrollRef.current;
    const el = root?.querySelectorAll<HTMLElement>("[data-settings-row]")[rowIdx];
    if (!root || !el) return;
    // Same snappy shared scroll as the TOC, centered on the matched row.
    fastScrollToSettingsEl(root, el, { block: "center" });
  }, [currentMatchIdx, matchedIds]);

  const stepMatch = useCallback((delta: 1 | -1) => {
    setCurrentMatchIdx((prev) => {
      if (matchedIds.length === 0) return -1;
      const start = prev < 0 ? 0 : prev;
      const next = (start + delta + matchedIds.length) % matchedIds.length;
      return next;
    });
  }, [matchedIds.length]);

  const searching = searchQuery.trim().length > 0;
  const advancedView = useMemo<AdvancedView>(() => ({
    show: aura.showAdvancedSettings,
    searching,
    hits: advancedHits,
    revealed: revealedSections,
  }), [aura.showAdvancedSettings, searching, advancedHits, revealedSections]);
  // What the TOC lists, and which page-level group headers render: a leaf
  // goes when its section goes, and a group goes with its last leaf.
  const tocGroups = useMemo(
    () => TOC_GROUPS
      .map((g) => ({ ...g, sections: g.sections.filter((s) => tocLeafShown(s, advancedView)) }))
      .filter((g) => g.sections.length > 0),
    [advancedView],
  );
  const shownGroups = new Set(tocGroups.map((g) => g.key));

  // Sections and AdvancedOnly rows read the advanced view from context; the
  // TOC takes its already-narrowed groups as a prop.
  return (
    <AdvancedViewContext.Provider value={advancedView}>
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="aura-page-scroller flex-1 overflow-y-auto flex items-center justify-center"
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
            shrinking the content column.
            Below a 1200 px window the mirror is dropped: centring is not
            worth a quarter of a narrow window, and at the 900 px minimum
            the two fixed 200 px columns left the content column only
            about 140 px wide, every row wrapping word by word. */}
        <div
          className="mx-auto my-auto px-8 py-6 grid gap-10 w-full
                     grid-cols-[200px_minmax(0,1fr)] min-[1200px]:grid-cols-[200px_minmax(0,1fr)_200px]"
          style={{ maxWidth: "min(1340px, 95%)" }}
        >
          {/* TOC - sticky so it stays in view while the user scrolls.
              The search input now lives at the BOTTOM of this sidebar
              (instead of in a sticky page header) so the content
              column doesn't lose vertical real estate to a fixed bar.
              `max-h: 100vh - 6rem` bounds the aside to the viewport:
              36 px native title-bar inset (the sticky sits BELOW it) +
              24 px top sticky-offset + ~36 px bottom buffer. The earlier
              3 rem ignored the title bar, so on 1080p the aside spilled
              ~48 px past the bottom edge and clipped the pinned search
              footer. The nav's own internal scroll (below) still absorbs
              any TOC growth, so this only has to clear the chrome. */}
          <aside
            {...sheet("aura-toc-scroll sticky top-6 self-start overflow-y-auto rounded-[20px] p-[10px]")}
            style={{ maxHeight: "calc(100vh - 6rem)" }}
          >
            <SettingsToc
              scrollRoot={scrollEl}
              groups={tocGroups}
              pin={tocPin}
              advanced={{
                value: aura.showAdvancedSettings,
                onChange: (v) => setLocal({ showAdvancedSettings: v }),
              }}
              search={{
                value: searchQuery,
                onChange: setSearchQuery,
                matchCount,
                currentMatchIdx,
                onStepMatch: stepMatch,
              }}
            />
          </aside>

          {/* Settings content column. No more sticky page header - the
              first section's title sits at the same vertical baseline
              as the TOC's "Contents" heading so the two columns align
              cleanly at the top of the viewport. */}
          <div className="space-y-6">
          {searchQuery.trim() && matchCount === 0 && (
            <div
              role="status"
              {...sheet(`text-center px-4 py-10 rounded-[20px]
                         text-white/55 text-sm
                         animate-[settings-fade-in_180ms_ease-out]`)}
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

          {/* A group header renders only while its TOC group lists a
              section: with Show advanced settings off, System has none. */}
          {shownGroups.has("browse") && <GroupHeader label="Browsing" />}

          {/* Catalog providers - every control here overrides the automatic
              election, so the whole section is advanced (TOC_GROUPS). The
              Home picker lists what the automatic Home board can draw on
              (isHomeSource, the election's own rule, AIOStreams included),
              so an override can name anything the default board shows. A
              saved entry it cannot list (a meta-only addon the older picker
              allowed) is not shown here and does not hold the override in
              force either (electHomeAddons), so removing every listed entry
              always returns Home to the automatic board. */}
          <Section id="sec-catalog" title="Catalog Providers">
            <UnifiedHomeSourcesPicker
              addons={addons}
              primaryUrl={aura.defaultHomeAddonUrl}
              additionalUrls={aura.additionalHomeAddonUrls}
              filter={isHomeSource}
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
              disabled={aura.heroDisabled}
              onChange={(next) => setLocal({ heroCatalog: next.catalog, heroDisabled: next.disabled })}
            />
          </Section>

          {/* Stream providers - filtered to addons declaring the stream
              resource. The list controls which addons fetch_streams
              actually queries. While streamAddonUrls is null (the
              backward-compatible default), every stream-resource addon is
              queried; the picker reflects that by showing all of them as
              selected. The user's first edit commits a specific array.
              The picker is an override, so it is advanced; the formatter
              toggle below it is not. */}
          <Section id="sec-streams" title="Stream Providers">
            <AdvancedOnly>
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
              <div className="h-px bg-white/6" />
            </AdvancedOnly>
            <SettingToggle
              label="Aura stream formatting"
              description="Shows addon stream details as tidy chips (built for AIOStreams' TamTaro format). Off shows the addon's raw text, like Stremio. Also on the cog in the stream list."
              value={aura.useAuraStreamFormatter}
              onChange={(v) => setLocal({ useAuraStreamFormatter: v })}
            />
          </Section>

          {/* ── Search Providers ──────────────────────────────────────────
              Addons hit on a deliberate Enter search (the SearchView grouped
              results). Cost-tolerant: expensive AI providers belong here.
              Defaults to "all search-capable installed addons"; the first
              user edit commits a concrete array. An override, so the whole
              section is advanced (TOC_GROUPS). */}
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
          </Section>

          {/* ── Spoilers ──────────────────────────────────────────────────
              Was titled "Detail Page", which was always a misnomer: every
              toggle in it is a spoiler control and several of them apply
              well outside the detail page (the thumbnail blur also drives
              the EOS Spotlight, the in-player episode panel and the Next
              Up card).

              Read the section as "settings that govern spoiler exposure",
              in BOTH directions. Most add protection when switched on;
              arcAwareArt at the bottom adds exposure, because arc key art
              can depict something you have not reached. Its description
              says so. */}
          <Section id="sec-spoilers" title="Spoilers">
            <SettingToggle
              label="Hide the Main cast badge"
              description="Hides the Main badge on live-action cast tiles, since billing can give away who sticks around. Anime character tiles keep theirs."
              value={aura.hideCastSpoilers}
              onChange={(v) => setLocal({ hideCastSpoilers: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Blur unwatched episode thumbnails"
              description="Blurs episode thumbnails until the episode is watched (marked by you or from playback progress), on the detail page and in the player."
              value={aura.blurUnwatchedThumbnails}
              onChange={(v) => setLocal({ blurUnwatchedThumbnails: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Blur selected episode synopsis"
              description="Blurs the selected episode's synopsis until you click it. Watched episodes are never blurred."
              value={aura.blurEpisodeSynopsis}
              onChange={(v) => setLocal({ blurEpisodeSynopsis: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Blur theme song episode ranges"
              description="Blurs which episodes each opening and ending covers in an anime's Songs tab until clicked, since ranges reveal where arcs end. Titles and artists stay visible."
              value={aura.blurThemeEpisodeRanges}
              onChange={(v) => setLocal({ blurThemeEpisodeRanges: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Blur character portraits"
              description="Blurs character art and names in an anime's Cast tab until clicked. Both can give away later forms, reveals or who turns up."
              value={aura.blurCharacterArt}
              onChange={(v) => setLocal({ blurCharacterArt: v })}
            />
            <div className="h-px bg-white/6" />
            <SettingToggle
              label="Match artwork to your current story arc"
              description="Uses key art from the latest story arc you have progress in on Continue Watching tiles and the detail backdrop. Adds spoiler risk: arc art can show what you have not reached. Only some shows have it (from their fan wiki)."
              value={aura.arcAwareArt}
              onChange={(v) => setLocal({ arcAwareArt: v })}
            />
          </Section>

          {/* ── Hover Meta Panel ──────────────────────────────────────────
              The mini-meta panel that pops beside a catalog card
              (poster, ratings, plot, cast). Default: opens on hover.
              The toggle switches every surface (Home / Search / Library
              / Discover / Queue / Calendar day view) to open it on a
              mouse-button press instead - useful if hover-open feels
              twitchy or for click-only navigation. */}
          <Section id="sec-hover-panel" title="Hover Meta Panel">
            <SettingDropdown
              label="How the meta panel opens"
              description="When the mini-meta panel beside a catalog card opens: on hover, on a mouse button you choose, or on a long press of a poster (best for trackpads). On hover, hold Alt to keep the panel still and move onto it when it covers other cards."
              value={aura.metaPanelActivation}
              required
              options={[
                { value: "hover", label: "Hover (default)" },
                { value: "button", label: "Mouse button" },
                { value: "hold", label: "Press & hold (trackpad-friendly)" },
              ]}
              onChange={(v) => {
                if (v === "hover" || v === "button" || v === "hold") setLocal({ metaPanelActivation: v });
              }}
            />
            {aura.metaPanelActivation === "button" && (
              <AttachedSettings>
                <MouseBindRow
                  label="Meta panel button"
                  description="The button that opens and closes the panel (Middle, Back or Forward). Click the chip, then press that button; Esc cancels."
                  button={aura.metaPanelBindButton}
                  onChange={(b) => setLocal({ metaPanelBindButton: b })}
                />
              </AttachedSettings>
            )}
            {aura.metaPanelActivation === "hold" && (
              <AttachedSettings>
                <p className="text-white/40 text-xs leading-relaxed px-0.5">
                  Press and hold the left button (or tap-and-hold on a trackpad) on a poster
                  for about 0.4&nbsp;s to open the panel. A quick click still selects. Esc or a
                  click elsewhere closes it.
                </p>
              </AttachedSettings>
            )}
          </Section>

          {/* ── Open Links ────────────────────────────────────────────────
              The right-click "Open in…" external-source links (IMDb /
              MyAnimeList and more). Default opens them in Aura's
              in-app popup webview; this switches to the user's default
              system browser. */}
          <Section id="sec-open-links" title="Open Links">
            <SettingToggle
              label="Open external links in my browser"
              description="Opens the right-click “Open in…” links (IMDb, MyAnimeList and more) in your default browser instead of Aura's in-app popup."
              value={aura.openLinksExternally}
              onChange={(v) => setLocal({ openLinksExternally: v })}
            />
          </Section>

          {shownGroups.has("playback") && <GroupHeader label="Playback" />}

          {/* Video & Audio quality. Audio passthrough, both forward-buffer
              sliders, the screenshot folder and motion interpolation are
              behind Show advanced settings (<AdvancedOnly>); HDR mode and
              peak nits stay visible by decision. */}
          {backend && (
            <Section id="sec-video-audio" title="Video & Audio">
              {/* HDR mode and peak nits are machine-local (render.json,
                  stripped from sync and export): they describe this
                  display. Both write through hdrMode.ts, which also
                  applies the change to the player. */}
              <HdrModeSetting
                value={hdrModeOf(backend as unknown as Record<string, unknown>)}
                onChange={(mode) => {
                  void applyHdrWrite(() => setHdrMode<BackendSettings>(mode, {
                    before: () => backendRef.current as unknown as Record<string, unknown> | null,
                    byUser: true,
                  }));
                }}
              />
              {hdrModeOf(backend as unknown as Record<string, unknown>) === "passthrough" && (
                <AttachedSettings>
                  <HdrPeakNitsRow
                    value={backend.hdr_target_peak_nits ?? 0}
                    onChange={(v) => {
                      void applyHdrWrite(() => setHdrPeakNits<BackendSettings>(
                        v,
                        () => backendRef.current as unknown as Record<string, unknown> | null,
                      ));
                    }}
                  />
                </AttachedSettings>
              )}
              <div className="h-px bg-white/6" />
              <SettingSlider
                label="Seek step"
                description="How far Seek Back / Seek Forward jump, from the arrow keys (or your bindings) and the skip buttons beside Play. Default 5 s."
                value={aura.seekStepSeconds}
                min={1}
                max={60}
                step={1}
                suffix=" s"
                onChange={(v) => {
                  // A gesture still open when Settings closes commits from the
                  // slider's unmount, where setLocal no longer reaches the
                  // save effect: write storage directly then.
                  if (pageLiveRef.current) setLocal({ seekStepSeconds: v });
                  else saveAuraSettings({ ...loadAuraSettings(), seekStepSeconds: v });
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
                description="Starts the next episode after a countdown on the end screen. After-credits scenes and previews play first. Any mouse, key or scroll input cancels it; closing the Next Up card turns it off for that episode."
                value={aura.autoAdvanceNextEpisode}
                onChange={(v) => setLocal({ autoAdvanceNextEpisode: v })}
              />
              {/* The delay and the "Still watching?" check act only through
                  the end-of-episode countdown, so they grey out with
                  auto-advance off rather than unmount (an unmounted row cannot
                  be searched). The filler / recap dropdown stays live: it also
                  picks the canon episode the pre-scan reads, the Next Up card's
                  Autoplay line and the caught-up vs finale call. */}
              <AttachedSettings>
                <AutoAdvanceDelayRow
                  value={aura.autoAdvanceDelaySeconds}
                  disabled={!aura.autoAdvanceNextEpisode}
                  onChange={(v) => setLocal({ autoAdvanceDelaySeconds: v })}
                />
                <div className="h-px bg-white/6" />
                <SettingToggle
                  label={'"Still watching?" check'}
                  description="After a few episodes auto-play in a row with no input, asks if you're still watching instead of starting the next, so a binge does not run all night on your debrid."
                  value={aura.stillWatchingGate}
                  disabled={!aura.autoAdvanceNextEpisode}
                  onChange={(v) => setLocal({ stillWatchingGate: v })}
                />
                <div className="h-px bg-white/6" />
                {/* Picks which button the unattended countdown presses
                    (nextUp.ts autoSkipApplies). Requires AIOMetadata's
                    per-episode `episodeKind` field; older metadata addons
                    emit nothing for it and the filter becomes a no-op. */}
                <SettingDropdown
                  label="Auto-skip filler / recap during autoplay"
                  description="When the next episode is filler or recap, autoplay skips to the next canon episode instead, marking the episodes in between as Skipped. Needs AIOMetadata's filler and recap flags (AIOMetadata installed on its own or inside AIOStreams)."
                  value={aura.nextUpSkipFillerRecap}
                  required
                  options={[
                    { value: "none",   label: "Never auto-skip" },
                    { value: "filler", label: "Auto-skip filler" },
                    { value: "recap",  label: "Auto-skip recap" },
                    { value: "both",   label: "Auto-skip both" },
                  ]}
                  onChange={(v) => {
                    if (v === "none" || v === "filler" || v === "recap" || v === "both") {
                      setLocal({ nextUpSkipFillerRecap: v });
                    }
                  }}
                />
              </AttachedSettings>
              <AdvancedOnly>
                <div className="h-px bg-white/6" />
                <SettingToggle
                  label="Audio passthrough (bitstream)"
                  description="Sends AC3 / DTS / TrueHD untouched to an AVR or soundbar (WASAPI exclusive mode). Other apps lose the audio device while Aura is open. Needs a restart."
                  value={backend.audio_passthrough}
                  onChange={(v) => patchBackend({ audio_passthrough: v })}
                />
                {backend.audio_passthrough && (
                  <p className="text-amber-400/75 text-xs mt-1">
                    Restart Aura for audio passthrough to take effect.
                  </p>
                )}
              </AdvancedOnly>
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Loudness normalization"
                description={
                  // With the switch off the passthrough row above is not on
                  // screen, so the copy names the switch that brings it back.
                  backend.audio_passthrough
                    ? aura.showAdvancedSettings
                      ? "Unavailable while Audio passthrough is on (bitstream skips audio filters). Turn passthrough off to use it."
                      : "Unavailable while Audio passthrough is on (bitstream skips audio filters). To use it, turn on Show advanced settings, then turn Audio passthrough off."
                    : "Evens out volume so quiet dialogue and loud scenes sit at similar levels, and keeps working through seeks."
                }
                value={aura.loudnessNormalization && !backend.audio_passthrough}
                onChange={(v) => {
                  if (backend.audio_passthrough) return;
                  setLocal({ loudnessNormalization: v });
                  invoke("set_audio_loudnorm", { enabled: v }).catch(() => {});
                }}
              />
              <div className="h-px bg-white/6" />
              <SettingDropdown
                label="Trailer quality"
                description="Preferred quality for Watch Trailer. A trailer without it plays the best it offers; change it per trailer from the player's quality menu."
                required
                value={backend.trailer_quality ?? "1080"}
                options={[
                  { value: "auto", label: "Auto (best available)" },
                  { value: "2160", label: "4K (2160p)" },
                  { value: "1440", label: "1440p" },
                  { value: "1080", label: "1080p" },
                  { value: "720",  label: "720p" },
                ]}
                onChange={(v) => patchBackend({ trailer_quality: v ?? "1080" })}
              />
              <AdvancedOnly>
                <div className="h-px bg-white/6" />
                <SettingSlider
                  label="Forward buffer (seconds)"
                  description="Seconds of video to buffer ahead (cache). Higher rides out slow or bursty links but uses more RAM. Applies immediately, even mid-stream."
                  value={backend.cache_secs ?? 180}
                  min={30}
                  max={600}
                  suffix=" s"
                  onChange={(v) => {
                    const ra = Math.max(5, Math.round(v * 0.67));
                    const saved = patchBackend({ cache_secs: v, demuxer_readahead_secs: ra });
                    invoke("apply_buffer_settings", { cacheSecs: v, readaheadSecs: ra, maxMib: backend.demuxer_max_mib ?? 768 }).catch(() => {});
                    // Returned so the slider holds its value until the write lands.
                    return saved;
                  }}
                />
                <AttachedSettings>
                  <SettingSlider
                    label="Forward buffer memory cap"
                    description="Most RAM the forward buffer may use. The seconds above usually limit first; raise this only if 4K remuxes stall mid-playback. Applies immediately."
                    value={backend.demuxer_max_mib ?? 768}
                    min={128}
                    max={2048}
                    suffix=" MiB"
                    onChange={(v) => {
                      const saved = patchBackend({ demuxer_max_mib: v });
                      invoke("apply_buffer_settings", { cacheSecs: backend.cache_secs ?? 180, readaheadSecs: backend.demuxer_readahead_secs ?? 120, maxMib: v }).catch(() => {});
                      return saved;
                    }}
                  />
                </AttachedSettings>
              </AdvancedOnly>
              <AdvancedOnly>
                <div className="h-px bg-white/6" />
                <div
                  className="px-1 py-3"
                  data-settings-row=""
                  data-settings-label="Screenshot folder"
                  data-settings-description="Where the Screenshot key (default c) saves PNGs. Leave blank for the default Pictures\Aura folder."
                >
                  <p className="text-white/75 text-sm font-medium">Screenshot folder<AdvancedTag /></p>
                  <p className="text-white/45 text-[12.5px] leading-snug mt-0.5 mb-2">
                    Where the Screenshot key (default c) saves PNGs. Leave blank for the default Pictures\Aura folder.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={backend.screenshot_dir ?? ""}
                      placeholder="Default: Pictures\Aura"
                      onChange={(e) => patchBackend({ screenshot_dir: e.target.value })}
                      className="aura-glass-field flex-1 min-w-0 rounded-lg px-3 py-2 text-[13px] text-white/85 placeholder:text-white/30 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={async () => {
                        const picked = await invoke<string | null>("pick_folder").catch(() => null);
                        if (picked) patchBackend({ screenshot_dir: picked });
                      }}
                      className="aura-glass-flat aura-glass-press flex-shrink-0 px-3 py-2 rounded-lg text-[13px] text-white/85"
                    >
                      Browse
                    </button>
                    {(backend.screenshot_dir ?? "").trim() !== "" && (
                      <button
                        type="button"
                        onClick={() => patchBackend({ screenshot_dir: "" })}
                        className="aura-glass-item flex-shrink-0 px-3 py-2 rounded-lg text-[13px] text-white/55 hover:text-white"
                      >
                        Reset
                      </button>
                    )}
                  </div>
                </div>
              </AdvancedOnly>
              <AdvancedOnly>
                <div className="h-px bg-white/6" />
                <SettingToggle
                  label="Motion interpolation"
                  description="Smooths anime on a high-refresh display with light GPU frame interpolation. Anime only: skipped on live action, where it adds judder. Also in the player's menu."
                  value={!!aura.motionInterpolation}
                  onChange={(v) => {
                    // Persist ONLY - do not apply live from Settings. Interp is
                    // anime-gated and this view has no active-target context, so
                    // a live invoke here would enable interpolation on whatever
                    // is currently playing (incl. live-action), bypassing the
                    // gate. The per-load path (enabled && animeFlag) applies it
                    // correctly on the next play; the in-player MoreMenu toggle
                    // handles live changes for the anime that's actually on screen.
                    setLocal({ motionInterpolation: v });
                  }}
                />
                <AttachedSettings>
                  <SettingDropdown
                    label="Interpolation kernel (smoothness)"
                    description="How smooth interpolated motion looks. Oversample only fixes judder; the others add smoother motion with more softening. Applies from the next stream you start."
                    value={aura.interpolationTscale ?? "mitchell"}
                    options={[
                      { value: "oversample",  label: "Oversample - sharpest · judder-fix only (least obvious)" },
                      { value: "catmull_rom", label: "Catmull-Rom - sharp · light smoothing" },
                      { value: "mitchell",    label: "Mitchell - balanced smoothing (recommended)" },
                      { value: "gaussian",    label: "Gaussian - smooth · soft" },
                      { value: "bicubic",     label: "Bicubic - smoothest · softest" },
                    ]}
                    required
                    disabled={!aura.motionInterpolation}
                    onChange={(v) => {
                      const k = v || "mitchell";
                      // Persist ONLY - see the Motion-interpolation toggle above.
                      // Applying live here would push interpolation onto whatever
                      // is playing without the anime gate; the kernel takes effect
                      // on the next play via the gated load path.
                      setLocal({ interpolationTscale: k });
                    }}
                  />
                </AttachedSettings>
              </AdvancedOnly>
            </Section>
          )}

          {/* Audio scoring - Original Language preference + dub aversion */}
          {backend && (
            <Section id="sec-audio-tracks" title="Audio Track Selection">
              <AudioPriorityInput
                value={backend.audio_priority}
                onCommit={(arr) => patchBackend({ audio_priority: arr })}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Avoid dubs"
                description="Prefers the original audio over tracks titled as dubs, even when a dub matches your language list."
                value={backend.avoid_dubs}
                onChange={(v) => patchBackend({ avoid_dubs: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingText
                label="Your region (optional)"
                description="Two-letter ISO country code (e.g. US, GB, MX). Breaks ties between regional versions of one language when the title's own country does not decide."
                value={backend.user_region}
                placeholder="e.g. US"
                onChange={(v) => patchBackend({ user_region: v.trim().toUpperCase() })}
                validate={(v) => /^$|^[A-Z]{2}$/.test(v.trim().toUpperCase()) ? "valid" : "invalid"}
                validationHint="Two-letter ISO country code (or empty)."
              />
            </Section>
          )}

          {/* Subtitle defaults - language preference + picker filter.
              Audio defaults moved to "Audio Track Selection" above; the
              older split between global-and-anime defaults was redundant
              once audio_priority + the subtitle preference cover both. */}
          {backend && (
            <Section id="sec-subtitle-defaults" title="Subtitles · Defaults">
              <SettingDropdown
                label="Subtitle language"
                description="Loaded automatically when subtitles are available. Off starts titles with no subtitles, forced ones included, unless you picked a language for that title in the player. You can still turn them on from the player's Subtitles menu."
                value={backend.subtitle_language}
                options={subtitleLanguageOptions(backend.subtitle_language)}
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

          {/* Subtitle styling - pushed to MPV via apply_subtitle_style.
              Changes apply on next stream load AND on every patch (the
              backend re-pushes when the active player updates). */}
          {backend && (
            <Section id="sec-subtitle-style" title="Subtitle Style">
              <SettingSlider
                label="Font size"
                description="Subtitle text size. Default 45; raise it for TV or ultrawide viewing."
                value={backend.subtitle_font_size}
                min={20}
                max={100}
                onChange={(v) => patchBackend({ subtitle_font_size: v })}
              />
              <div className="h-px bg-white/6" />
              <SettingSlider
                label="Vertical position"
                description="0 is the top of the frame, 100 the bottom. Go past 100 for styled (ASS) tracks that add their own bottom margin."
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
              <SettingSlider
                label="Subtitle brightness"
                description="Dims subtitles so white text does not glare on HDR or OLED screens. 100 leaves the glyph colour unchanged."
                value={backend.subtitle_brightness}
                min={20}
                max={100}
                suffix=" %"
                onChange={(v) => patchBackend({ subtitle_brightness: v })}
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
                Skip times come from AniSkip, IntroDB, PublicMetaDB, chapters and Aura's own
                audio scan (Automatic skip detection: turn on Show advanced settings). The
                modes apply to live action too.{" "}
                <span className="text-white/65">Off</span> offers no skip,{" "}
                <span className="text-white/65">Prompt</span> shows a "Press X to skip" toast,{" "}
                <span className="text-white/65">Auto</span> skips by itself, but anything uncertain,
                or a segment you are past halfway through, asks first. The Skip Segment key (X by
                default, under Keybindings) skips whatever is playing now.
              </p>
              <SkipConfidenceLegend />
              <div className="h-px bg-white/6" />
              <SkipModeRow
                label="Openings (OP)"
                description="Prompt by default. On Auto, an opening skips by itself only when its timing is trusted; otherwise (an uncertain source, or while the theme match is still checking) it asks, and the prompt says why."
                value={backend.skip_op_mode}
                onChange={(v) => patchBackend({ skip_op_mode: v })}
              />
              {/* Advanced child of a visible row: the AdvancedOnly wraps the
                  whole box, so hiding it leaves no empty box behind. */}
              <AdvancedOnly>
                <AttachedSettings>
                  <SettingToggle
                    label="Treat mixed-OP as OP"
                    description="Label AniSkip's mixed-op times (a recap bundled into the opening) as an opening. Either way they follow your OP mode."
                    value={backend.skip_treat_mixed_op_as_op}
                    onChange={(v) => patchBackend({ skip_treat_mixed_op_as_op: v })}
                  />
                </AttachedSettings>
              </AdvancedOnly>
              <div className="h-px bg-white/6" />
              <SkipModeRow
                label="Endings (ED)"
                description="Prompt by default. On Auto, a trusted ending skips by itself; uncertain ones (such as AniSkip endings) only ask. A theme-matched ending stops where the song does, so after-credits scenes still play. Previews get their own Skip Preview prompt, never automatic. Off hides both prompts; the Next Up card still uses the ending."
                value={backend.skip_ed_mode}
                onChange={(v) => patchBackend({ skip_ed_mode: v })}
              />
              <div className="h-px bg-white/6" />
              <SkipModeRow
                label="Recaps"
                description="Prompt by default. On Auto, a recap skips by itself only when a chapter or a second source agrees, or it ends right where a matched opening starts; otherwise it asks."
                value={backend.skip_recap_mode}
                onChange={(v) => patchBackend({ skip_recap_mode: v })}
              />
              <AdvancedOnly>
                <div className="h-px bg-white/6" />
                <SettingToggle
                  label="Automatic skip detection"
                  description="Finds the opening and ending in the episode's own audio. For anime on MyAnimeList it matches the show's theme songs from AnimeThemes (a match can auto-skip); elsewhere it can only guess, and a guess only prompts. Reads the first 10 and last 8 minutes of the stream. Needs ffmpeg (~97 MB, downloaded once)."
                  value={aura.autoSkipDetect}
                  onChange={(v) => setLocal({ autoSkipDetect: v })}
                />
                {/* The pre-scan runs the same detector, and reads the stream
                    the Next-Up card pre-resolves, so it means nothing with
                    either off. Both rows are advanced: one unit. */}
                <AttachedSettings>
                  <SettingToggle
                    label="Pre-scan the next episode"
                    description="Reads the next anime episode's stream in the background once this episode's skip detection is done and its stream is steady, so its skips are ready when it starts. Uses extra bandwidth and a second debrid connection: turn it off on a slow or metered link. Needs Next-Up lead time above 0 (Video & Audio)."
                    value={aura.prescanNextEpisode}
                    disabled={!aura.autoSkipDetect || (backend.next_up_lead_seconds ?? 60) <= 0}
                    onChange={(v) => setLocal({ prescanNextEpisode: v })}
                  />
                </AttachedSettings>
              </AdvancedOnly>
            </Section>
          )}

          {/* Keybindings */}
          {backend && (
            <Section id="sec-keybindings" title="Keybindings">
              <p className="text-white/40 text-xs">
                Click a row, then press a key to bind it. Press Escape to cancel. A key already in use moves to the new row, and the old row is left unbound.
              </p>
              <div className="aura-content-group">
                {KEYBIND_ACTIONS.map((a) => (
                  <Fragment key={a.id}>
                  <KeybindRow
                    action={a.id}
                    label={a.label}
                    description={a.description}
                    code={backend.keybindings[a.id] ?? ""}
                    lostTo={keysLostTo[a.id]}
                    onChange={async (next) => {
                      // A patch replaces the whole map, so start from the active
                      // scope's current one: this page's copy can predate a
                      // sign-in, a sign-out or a cloud pull.
                      const fresh = await invoke<BackendSettings>("get_settings").catch(() => backend);
                      const { map: updatedMap, moved } = rebindKey(fresh.keybindings, a.id, next);
                      await patchBackend({ keybindings: updatedMap });
                      setKeysLostTo((prev) => {
                        const nextLost = { ...prev };
                        delete nextLost[a.id];
                        for (const m of moved) nextLost[m.id] = a.label;
                        return nextLost;
                      });
                      for (const { label } of moved) {
                        showAppToast(
                          `${prettyBinding(next)} moved from ${label} to ${a.label}. ${label} is now unbound.`,
                          { duration: 5000, scope: SETTINGS_TOAST_SCOPE },
                        );
                      }
                    }}
                  />
                  {/* The hold option belongs to this key, so it sits under
                      its row rather than among the Next Up settings. */}
                  {a.id === "play-next-episode" && (
                    // Inside the grouped list: a little air so the box does
                    // not touch the rows (the next row's hairline follows it).
                    <div className="pt-0.5 pb-1.5 pr-1">
                      <AttachedSettings>
                        <SettingToggle
                          label="Hold to skip filler / recap"
                          description="When the Next Up card offers to skip filler or recap, hold this key for 2 seconds to skip (the card shows where it will land). Off, one press skips. With automatic scrobbling on, episodes you skip are sent to your scrobbling services as watched."
                          value={aura.nextUpHoldToSkip}
                          onChange={(v) => setLocal({ nextUpHoldToSkip: v })}
                        />
                      </AttachedSettings>
                    </div>
                  )}
                  </Fragment>
                ))}
              </div>
            </Section>
          )}

          {shownGroups.has("appearance") && <GroupHeader label="Appearance & Window" />}

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
            {/* Custom accent for the CURRENT theme (src/AccentColorSetting.tsx,
                drawn by src/themeAccent.ts). AuraSettings.themeAccents, so
                portable (PORTABLE_AURA_FIELDS) and cloud-synced; the picker
                previews through CSS variables and commits on release. */}
            <AccentColorRow
              theme={theme}
              value={aura.themeAccents[theme] ?? null}
              onChange={(hex) => setAura((prev) => {
                const next = { ...prev.themeAccents };
                if (hex) next[theme] = hex;
                else delete next[theme];
                return { ...prev, themeAccents: next };
              })}
            />
            {/* Material style + Cursor glow (src/glassStyle.ts). AuraSettings
                fields, so portable (PORTABLE_AURA_FIELDS) and cloud-synced like
                the theme; Clear (stored "liquid")'s GPU fallback is decided per
                machine. */}
            <GlassStyleRows
              glassStyle={aura.glassStyle}
              cursorGlow={aura.glassCursorGlow}
              onGlassStyle={(v) => setLocal({ glassStyle: v })}
              onCursorGlow={(v) => setLocal({ glassCursorGlow: v })}
              // Edge highlights / Surface glow / Glow size under Cursor glow:
              // AuraSettings.glassGlowTune, portable and synced like the glow.
              glowTune={aura.glassGlowTune}
              onGlowTune={(t) => setLocal({ glassGlowTune: t })}
            />
            {/* Real glass over video: machine-local (render.json; stripped in
                sync.ts, never in settingsTransfer), so it needs the backend
                read. The Theme section itself is not gated on `backend`.
                Shelved behind REAL_GLASS_AVAILABLE (realGlass.ts): hidden, so
                it is also out of Settings search (rows are found in the DOM). */}
            {backend && REAL_GLASS_AVAILABLE && (
              <RealGlassRow
                value={backend.real_glass === true}
                onChange={(v) => {
                  // The engine checks the stored setting before loading the
                  // shader, so it is told only after the write lands.
                  void patchBackend({ real_glass: v }).then(() => setRealGlassEnabled(v));
                }}
              />
            )}
            <div className="h-px bg-white/6" />
            {/* Reduced motion - disables Aura's decorative infinite-loop
                animations (title bar sweep, ambient backdrop drift,
                sidebar pill pulse, bell ring + badge bounce, popup
                breathe, hover-glow rotate). Loading bars, buffering
                pulses, popup enter/exit transitions, and skeleton
                shimmer stay on - they convey work-in-progress. The
                attribute is applied synchronously before React mounts
                so OS-pref users never see the BootSplash sweep. */}
            <SettingDropdown
              label="Reduce motion"
              description="Turns off decorative ambient animations (title-bar sweep, backdrop drift, glow pulses, bell ring). Auto follows your OS setting."
              value={aura.reduceMotion}
              options={[
                { value: "auto",   label: "Auto - follow OS setting" },
                { value: "always", label: "Always reduce" },
                { value: "never",  label: "Never reduce" },
              ]}
              required
              onChange={(v) => v && setLocal({ reduceMotion: v as AuraSettings["reduceMotion"] })}
            />
            <SettingToggle
              label="Smooth mouse wheel"
              description="Blends wheel notches into one continuous motion. Off uses the browser's own scrolling, which stops between notches. Touchpads are not affected."
              value={aura.smoothWheelScroll}
              onChange={(v) => setLocal({ smoothWheelScroll: v })}
            />
          </Section>

          {/* Window & system behaviour */}
          {backend && (
            <Section id="sec-window" title="Window & System">
              <SettingToggle
                label="Minimize to tray on close"
                description="Closing hides Aura to the tray instead of quitting. Click the tray icon to reopen it, or right-click it for Quit. Hold the close button for a second to quit anyway."
                value={backend.minimize_to_tray_on_close}
                onChange={(v) => patchBackend({ minimize_to_tray_on_close: v })}
              />
          </Section>
          )}

          {/* Downloads */}
          {backend && (
            <Section id="sec-downloads" title="Downloads">
              <div
                className="px-1 py-3"
                data-settings-row=""
                data-settings-label="Download folder"
                data-settings-description="Where downloaded files are saved. Leave blank to be asked on your first download. It stays on this computer and is never synced."
              >
                <p className="text-white/75 text-sm font-medium">Download folder</p>
                <p className="text-white/45 text-[12.5px] leading-snug mt-0.5 mb-2">
                  Where downloaded files are saved. Leave blank to be asked on your first
                  download. It stays on this computer and is never synced.
                </p>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={backend.download_dir ?? ""}
                    placeholder="Not set yet"
                    readOnly
                    className="aura-glass-field flex-1 min-w-0 rounded-lg px-3 py-2 text-[13px] text-white/85 placeholder:text-white/30 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await invoke<string | null>("pick_folder").catch(() => null);
                      if (!picked) return;
                      try {
                        // Validated in Rust, which also RESOLVES it: an 8.3
                        // short name expands and a trailing separator is
                        // normalised, so store what comes back rather than
                        // what was picked.
                        const resolved = await invoke<string>("downloads_set_root", { path: picked });
                        patchBackend({ download_dir: resolved });
                      } catch (e) {
                        showAppToast(e instanceof Error ? e.message : String(e), { tone: "danger" });
                      }
                    }}
                    className="aura-glass-flat aura-glass-press flex-shrink-0 px-3 py-2 rounded-lg text-[13px] text-white/85"
                  >
                    Browse
                  </button>
                  {(backend.download_dir ?? "").trim() !== "" && (
                    <button
                      type="button"
                      onClick={() => patchBackend({ download_dir: "" })}
                      className="aura-glass-item flex-shrink-0 px-3 py-2 rounded-lg text-[13px] text-white/55 hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Sort downloads into folders"
                description="Saves episodes as Show/Season 01/Show - S01E07 - Title.mkv and movies as Dune (2021)/Dune (2021).mkv, the layout Plex and Jellyfin expect. Off, files keep their release name in the download folder."
                value={backend.download_organise ?? true}
                onChange={(v) => patchBackend({ download_organise: v })}
              />
            </Section>
          )}

          {shownGroups.has("integrations") && <GroupHeader label="Integrations" />}

          {/* Discord Rich Presence */}
          {backend && (
            <Section id="sec-discord" title="Discord Rich Presence">
              <SettingToggle
                label="Show what I'm watching"
                description="Publishes playback details to Discord. Set the options below first to keep titles private."
                value={backend.discord_rpc_enabled}
                onChange={(v) => patchBackend({ discord_rpc_enabled: v })}
              />
              {/* window_logic.rs clears all presence before reading any of
                  these when the master switch is off. They stay live anyway,
                  so a user can hide titles BEFORE turning presence on. */}
              <AttachedSettings>
                <SettingToggle
                  label="Show titles in presence"
                  description="Off, playback shows only 'Watching Aura' with no title or artwork. Browsing has its own switch."
                  value={backend.discord_rpc_show_titles}
                  onChange={(v) => patchBackend({ discord_rpc_show_titles: v })}
                />
                <div className="h-px bg-white/6" />
                <SettingToggle
                  label="Show what I'm browsing"
                  description="Also show presence on screens other than the player (Home, Library, Search and the rest). Off, Discord only shows Aura while something plays."
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
              </AttachedSettings>
            </Section>
          )}

          {/* Scrobbling - direct AniList + Simkl OAuth.
              Replaces the AIOMetadata-addon scrobble path with a
              direct connection to each provider. Tokens are stored in
              the OS keyring per Stremio account so signing out and
              back in keeps the connection. Connect opens the user's
              default browser; for AniList the VPS proxy at
              aura.animasec.dev completes the OAuth dance and deep-links
              the token back into Aura (Simkl needs no proxy: it redirects straight to
              the loopback listener, which does the exchange itself).
              The ScrobbleAuthRows (Simkl included) add no AppSettings /
              AuraSettings field: the connections live in the keyring, per
              account, so export/import and cloud sync carry nothing for
              them. The toggle below (auto_scrobble_enabled) IS a backend
              setting, listed in PORTABLE_BACKEND_FIELDS. */}
          {backend && (
            <Section id="sec-scrobble" title="Scrobbling">
              <ScrobbleAuthRow
                service="anilist"
                authKey={session?.auth_key ?? null}
                description={SCROBBLE_ROW_DESCRIPTIONS.anilist}
              />
              <div className="h-px bg-white/6" />
              <ScrobbleAuthRow
                service="simkl"
                authKey={session?.auth_key ?? null}
                description={SCROBBLE_ROW_DESCRIPTIONS.simkl}
              />
              <div className="h-px bg-white/6" />
              <SettingToggle
                label="Scrobble automatically"
                description="Sends what you finish, and episodes you mark Skipped, to your connected services as you go. Off, nothing is sent until you press a scrobble button on the History page. Your accounts stay connected either way."
                value={backend.auto_scrobble_enabled}
                onChange={(v) => patchBackend({ auto_scrobble_enabled: v })}
              />
            </Section>
          )}

          {/* Cloud Sync - diagnostic + manual controls for the
              per-account state sync (Phase 7). Engine runs silently in
              the background; this section surfaces last-pull / last-
              push / size per namespace plus on-demand Pull / Purge. */}
          <Section id="sec-cloud-sync" title="Cloud Sync">
            {/* Renders its own trailing divider: the connected panel is
                advanced and takes the divider with it when hidden. */}
            <CloudSyncSection authKey={session?.auth_key ?? null} />
            {/* Release-search opt-in. Default on for signed-in users
                per docs/release-search-spec.md §6.4. When off, the
                desktop falls back to per-user addon probes for
                library / calendar reconciliation (same code path as
                pre-Phase 9). Ignored for guests - they always use the
                addon path because the cloud requires a signed-in
                scope hash on the batch + nudge endpoints. */}
            {/* No `disabled` prop on SettingToggle. The setting is
                editable for everyone, but the runtime gate at call
                sites (releaseSearch.ts, library reconciler) ignores
                the flag for guests since the cloud batch + nudge
                endpoints require a signed-in scope hash. */}
            <SettingToggle
              label="Use Aura Cloud's shared release feed"
              description="Asks Aura Cloud whether new episodes have aired instead of probing addons from this machine: faster and lighter, but it sends Aura Cloud the IMDb ids in your library (never streams or Debrid keys). Signed-in only."
              value={aura.releaseSearchEnabled}
              onChange={(v) => setLocal({ releaseSearchEnabled: v })}
            />
          </Section>

          {/* API keys. Ratings now come from MDBList (key baked at
              build time, not user-supplied) + the free MAL/AniList
              APIs, so the only user-facing key left is OpenSubtitles.
              It's round-tripped via the Backup & Restore export blob so
              it follows the user across installs. */}
          {backend && (
            <Section id="sec-api-keys" title="API Keys">
              <KeyringApiKeyInput
                name="opensubtitles"
                label="OpenSubtitles API key"
                description="Turns on the player's OpenSubtitles search. Get a free key at opensubtitles.com (the .com site, not .org) under Profile → Consumer. Addon subtitles work without it. Stored in the OS keyring."
                placeholder="e.g. 1a2b3c4dXyZ…"
              />
              <KeyringApiKeyInput
                name="tmdb"
                label="TMDB API key (optional)"
                description="Powers the Seasons / Arcs toggle on anime with story arcs (One Piece, Naruto, Bleach and more). Aura has its own key; add yours only to use your own quota (free at themoviedb.org under Settings → API). Stored in the OS keyring."
                placeholder="e.g. 8a1b2c3d4e5f…"
              />
              <KeyringApiKeyInput
                name="introdb"
                label="IntroDB API key (optional)"
                description="Lets the AuraSkip menu send the skip times you enter to IntroDB, a shared database for any show with an IMDb id. Reading IntroDB needs no key. Stored in the OS keyring."
                placeholder="e.g. idb_…"
                link={{ label: "Get a key at introdb.app", url: "https://introdb.app" }}
              />
            </Section>
          )}

          {/* Crash reporting - opt-in Sentry integration. The toggle
              flips `crash_reporting_consent` to true / false (matching
              the consent dialog's two outcomes); the DSN field is
              the per-project key from the Sentry dashboard. Both the
              Rust panic hook and the JS Sentry init read these at
              startup, so changes only take effect after a restart. */}
          {crashConfig && (
            <Section id="sec-crash-reporting" title="Crash Reporting">
              <SettingToggle
                label="Send crash reports"
                description="Sends anonymised error reports (stack trace, console warnings and errors, OS and app version, a random install id) to the developer's Sentry, plus a masked UI replay with network metadata (text masked, media blocked) for sessions with an error and about 1 in 10 others. Account details, IP and location are removed; the error text is not, so it can hold what the failing code was handling. Applies after a restart."
                value={crashConfig.consent === true}
                onChange={(v) => patchCrashConfig({ consent: v })}
              />
              {/* The Sentry DSN used to be a user-facing input here.
                  It's now hardcoded into the build (mirrored in
                  src-tauri/src/lib.rs::HARDCODED_SENTRY_DSN and
                  src/main.tsx::HARDCODED_SENTRY_DSN) so end users
                  have nothing to configure - the only thing they
                  decide is whether reports send at all (the toggle
                  above). Developers can still override via the
                  SENTRY_DSN / VITE_SENTRY_DSN env vars at build time,
                  or by setting the `dsn` field in
                  <app_data_dir>/crash-reporting.json directly. */}
            </Section>
          )}

          {shownGroups.has("system") && <GroupHeader label="System" />}

          {/* Performance - rendering toggles that need a restart to
              take effect. Today: just hardware acceleration; future
              additions (e.g. low-power mode, animation reduction
              overrides) would join here. */}
          {backend && (
            <Section id="sec-performance" title="Performance">
              <SettingToggle
                label="Hardware acceleration"
                description="Lets WebView2 use the GPU to draw the interface. Turn off if scrolling lags on a multi-monitor or ultrawide setup while CPU and GPU usage stay low. Takes effect after a restart."
                value={backend.gpu_acceleration}
                onChange={(v) => patchBackend({ gpu_acceleration: v })}
              />
            </Section>
          )}

          {/* Storage - disk + localStorage cache inspection. Clear
              buttons remove individual entries; "user data" badge
              flags the destructive ones (manual marks, settings,
              etc.). Like everything in System it is advanced, and the
              row attributes on the wrapper are what let a search find
              and reveal it. */}
          <Section id="sec-storage" title="Storage">
            <div
              data-settings-row=""
              data-settings-label="Storage"
              data-settings-description="Disk files and localStorage entries Aura keeps, with their sizes and a Clear button for each. Clear caches or user data."
            >
              <StorageReport />
            </div>
          </Section>

          {/* Optional Components - on-demand ffmpeg/ffprobe download. Not
              bundled (keeps ~314 MB out of every update); fetched here when
              the user wants silence detection / casting transmux. Error
              copy elsewhere (the trailer and cast failures) sends users
              here to update yt-dlp or fetch FFmpeg, hence the searchable
              row naming all three. */}
          <Section id="sec-optional-components" title="Optional Components">
            <div
              data-settings-row=""
              data-settings-label="Optional Components"
              data-settings-description="Download or update FFmpeg, FFprobe and yt-dlp: automatic skip detection, Live Subtitle Sync, casting transmux and Watch Trailer."
            >
              <RuntimeComponentsSection />
            </div>
          </Section>

          {shownGroups.has("backup") && <GroupHeader label="Backup & Restore" />}

          {/* Backup & Restore - portable settings export/import.
              Only addon-INDEPENDENT fields round-trip (theme / audio /
              subtitles / keybindings / discord / skip / etc.). Provider
              URL lists are excluded so an import on a fresh machine
              doesn't try to point at addons that aren't installed. */}
          {backend && (
            <BackupRestoreSection
              backend={backend}
              addons={addons}
              onApply={applyBackendPatch}
              onResetComplete={() => {
                // Force the SettingsView to re-pull fresh backend
                // defaults so the UI controls reflect the wipe.
                invoke<BackendSettings>("get_settings")
                  .then(setBackend)
                  .catch(() => {});
                // Re-read the Aura settings from the storage the reset
                // just cleared (defaults, the key being gone). The
                // settings-changed listener has already done so; doing it
                // here too keeps the controls right even if that ordering
                // ever changes, and it is a no-op otherwise (the same
                // cached object).
                adoptStoredAura();
              }}
            />
          )}

          <AboutSection addonCount={addons.length} />
          </div>{/* /content column */}

          {/* Mirror of the TOC width - empty third column. Keeps the
              content column centred on the page rather than off to the
              right next to the TOC. */}
          <div aria-hidden />
        </div>{/* /grid */}
      </div>
    </div>
    </AdvancedViewContext.Provider>
  );
}
