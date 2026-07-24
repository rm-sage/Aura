// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Tooltip from "./Tooltip";
import SubtitlePicker from "./SubtitlePicker";
import CinemaSuite from "./CinemaSuite";
import ImageLoader from "./ImageLoader";
import type { ActiveScrobbleTarget } from "./useScrobble";
import type { AddonEntry, ExternalSubtitle, LibraryItem, TrackEntry, VideoEntry } from "./types";
import EpisodePanel from "./EpisodePanel";
import { formatAbsoluteEpisode } from "./storyArcs";
import { setTitleState, titleStateKey } from "./titleState";
import { pickDefaultAudio, toLang2, type ScoringMeta } from "./audioScoring";
import { prettyBinding } from "./useKeybindings";
import { loadAuraSettings, saveAuraSettings } from "./auraSettings";
import AniSkipMenu from "./AniSkipMenu";
import SubtitleSyncPanel, { type SyncAnchorPair } from "./SubtitleSyncPanel";
import { MenuTrackerCtx, useMenuOpenSync, type MenuTracker } from "./menuTracker";
import { copyTextToClipboard } from "./clipboard";

// Max volume the slider / wheel / keys can reach. mpv's `volume-max` init option
// (engine.rs) must match. >100 is a soft boost (~+3.5 dB at 150) for quiet
// sources; the DEFAULT stays 50 so nothing is loud until the user opts in.
export const VOLUME_MAX = 150;

// Stable empty track list. Shared identity matters: it is what the track-list
// state falls back to while the current file's list has not been read yet, and
// a fresh [] each render would re-fire every useMemo / effect keyed on it.
const EMPTY_TRACKS: TrackEntry[] = [];

/** Does a subtitle track's language tag satisfy the preferred language?
 *
 *  Both sides are normalized to a 2-letter code first, because the two ends
 *  disagree on shape in practice: embedded mpv tracks tag themselves 639-2
 *  ("eng"), addon-supplied externals are almost always 2-letter ("en"), and a
 *  saved per-title pick stores whichever the user happened to click. A bare
 *  prefix test matched "eng" against "en" but NOT "en" against "eng", so a
 *  per-title choice made on an embedded track silently stopped matching the
 *  external list. The prefix test is kept as a fallback so a 3-letter code
 *  missing from the ISO table behaves exactly as it did before. */
function subLangMatches(lang: string | null | undefined, pref: string): boolean {
  if (!pref) return false;
  const raw = (lang ?? "").toLowerCase();
  const prefNorm = toLang2(pref) ?? pref;
  const langNorm = toLang2(raw);
  if (langNorm && langNorm === prefNorm) return true;
  return raw.startsWith(pref);
}

// ---------------------------------------------------------------------------
// Menu-open tracker — child menus (TrackMenu, SpeedMenu, ShaderPicker,
// MoreMenu) call `useMenuOpenSync(open)` so the overlay can:
//   • freeze auto-hide while any menu is up (controls stay visible),
//   • swallow a click on the video region whose only effect was to close a
//     menu (so the user doesn't accidentally toggle pause on dismissal).
// ---------------------------------------------------------------------------

// The open-menu counter (MenuTrackerCtx + useMenuOpenSync) lives in
// ./menuTracker so sibling panels rendered outside this module can join the
// same coordination without importing back into PlayerOverlay.

/** openUrl wrapper — wrapped in try/catch so a missing permission can
 *  never crash the app. (Clipboard copy: ./clipboard#copyTextToClipboard.) */

async function openExternalUrl(url: string): Promise<boolean> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
    return true;
  } catch (e) {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      return true;
    } catch (e2) {
      console.error("open url failed", e, e2);
      return false;
    }
  }
}

/** Fire a transient toast over the player. Anyone can call this — the
 *  PlayerOverlay component subscribes via an event listener and renders
 *  the visual feedback. */
export function fireToast(message: string) {
  window.dispatchEvent(
    new CustomEvent("aura:player-toast", { detail: { message } }),
  );
}

// ---------------------------------------------------------------------------
// PlayerOverlay — z-[9999] full-screen container that renders ONLY when a
// stream is active. Background is strictly transparent so the native MPV
// window painted behind the webview is visible.
// ---------------------------------------------------------------------------

// ── Icons ────────────────────────────────────────────────────────────────
const PlayIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8 5v14l11-7z" />
  </svg>
);
const PauseIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
  </svg>
);
const ReplayIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
  </svg>
);
const ForwardIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ transform: "scaleX(-1)" }}>
    <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" />
  </svg>
);
const VolumeMaxIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
  </svg>
);
const VolumeMidIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 9v6h4l5 5V4l-5 5H7zm9.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
  </svg>
);
const VolumeMuteIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
  </svg>
);
const SubsIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 1.99-.9 1.99-2L22 6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H10v-2h10v2z" />
  </svg>
);
const ShaderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.86 0-7-3.14-7-7s3.14-7 7-7 7 3.14 7 7-3.14 7-7 7zm-1-11h2v6h-2zm0 8h2v2h-2z" />
  </svg>
);
const ExitIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);
const FullscreenIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
  </svg>
);
const PanscanIcon = () => (
  // Distinct from FullscreenIcon's corner-brackets motif: a horizontal
  // screen frame (the visible viewport) with a TALLER filled rectangle
  // overflowing top and bottom (the video, which gets cropped to fill
  // the screen's constrained axis). Reads as "video is bigger than
  // screen → fill by cropping" — exactly what panscan does — and is
  // immediately visually different from fullscreen's outward-pointing
  // corner-bracket motif.
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {/* Outer letterbox / viewport rectangle */}
    <rect x="2.5" y="7" width="19" height="10" rx="1.2" />
    {/* Inner video frame — taller than the viewport (overflows top + bottom) */}
    <rect x="6" y="3.5" width="12" height="17" rx="1" fill="currentColor"
          fillOpacity="0.42" stroke="none" />
    <rect x="6" y="3.5" width="12" height="17" rx="1" />
  </svg>
);
const ExitFullscreenIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
  </svg>
);
const SpeedIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M20.38 8.57l-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83z" />
  </svg>
);
const AudioIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 3v9.28c-.47-.17-.97-.28-1.5-.28C8.01 12 6 14.01 6 16.5S8.01 21 10.5 21c2.31 0 4.2-1.75 4.45-4H15V6h4V3h-7z" />
  </svg>
);
const MoreIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z" />
  </svg>
);
const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
  </svg>
);
const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
  </svg>
);
const ExternalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" />
  </svg>
);
const LoudnormIcon = () => (
  // Compact audio-level bars — four vertical bars at varying heights
  // suggesting "evened out" levels. Visually distinct from VolumeIcon's
  // speaker glyph.
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <rect x="3"  y="10" width="3" height="8" rx="0.5" />
    <rect x="8"  y="6"  width="3" height="12" rx="0.5" />
    <rect x="13" y="8"  width="3" height="10" rx="0.5" />
    <rect x="18" y="11" width="3" height="7"  rx="0.5" />
  </svg>
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function useAutoHide(
  delayMs = 3000,
  forceVisible = false,
  silentWakeCodes: readonly string[] = [],
): boolean {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Hold silentWakeCodes in a ref so changing the prop doesn't tear down
  // and re-add the window listeners every render.
  const silentRef = useRef(silentWakeCodes);
  silentRef.current = silentWakeCodes;

  useEffect(() => {
    // Toggling `cursor: ''` on the root only loses to descendants that
    // declare their own (cursor-pointer on click targets, etc.) — so the
    // mouse stayed visible even when the rest of the UI faded. The
    // `aura-cursor-hidden` class on <html> applies `cursor: none
    // !important` to every descendant via the rule in App.css; show
    // the cursor by removing the class.
    const setCursorHidden = (hidden: boolean) => {
      const root = document.documentElement;
      if (hidden) root.classList.add("aura-cursor-hidden");
      else root.classList.remove("aura-cursor-hidden");
    };
    if (forceVisible) {
      setVisible(true);
      setCursorHidden(false);
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      return () => setCursorHidden(false);
    }
    const wake = () => {
      setVisible(true);
      setCursorHidden(false);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setVisible(false);
        setCursorHidden(true);
      }, delayMs);
    };
    const wakeFromKey = (e: KeyboardEvent) => {
      // Suppress wake for caller-listed codes — used so volume arrow
      // keys don't fade the controls back in (the user gets a transient
      // toast instead, matching mousewheel behaviour).
      if (silentRef.current.includes(e.code)) return;
      wake();
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("mousedown", wake);
    window.addEventListener("keydown", wakeFromKey);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("mousedown", wake);
      window.removeEventListener("keydown", wakeFromKey);
      if (timer.current) clearTimeout(timer.current);
      setCursorHidden(false);
    };
  }, [delayMs, forceVisible]);

  return visible;
}

// ---------------------------------------------------------------------------
// ShaderPicker — talks directly to the cinema commands.
// ---------------------------------------------------------------------------

interface ShaderProfileInfo {
  id: number;
  name: string;
  requires_file: string | null;
  description: string;
}

// Anime4K profile ids in the order the user wants them shown in the
// submenu (A → B → C → A+A → B+B → C+C). Maps each id to the keybind
// action whose chord (from `settings.keybindings`) is shown next to
// the entry in small subtle font. Profile id 1 (the legacy single-
// shader "Anime4K") is INTENTIONALLY hidden from the picker — it
// produced essentially no visible improvement, and the v4 reference
// modes below replace it. The id is preserved in cinema.rs for
// back-compat with persisted per-title state that still references it.
const ANIME4K_DISPLAY_ORDER = [7, 8, 11, 9, 10, 12] as const;
const ANIME4K_ID_SET = new Set<number>(ANIME4K_DISPLAY_ORDER);
const ANIME4K_ACTION_BY_ID: Record<number, string> = {
  7: "anime4k-a",
  8: "anime4k-b",
  9: "anime4k-aa",
  10: "anime4k-bb",
  11: "anime4k-c",
  12: "anime4k-cc",
};
const HIDDEN_PROFILE_IDS = new Set<number>([1]);

// Minimum interval between shader switches. MPV's GLSL chain rebuilds
// on every change-list call; firing them faster than this can land
// concurrent rebuilds inside libmpv's renderer and cause visible
// stutter, brief frame drops, or in extreme cases the "shaders stop
// applying until next loadfile" symptom. 220 ms is well above the
// ~80 ms a chain-rebuild typically takes on the user's hardware,
// while still feeling responsive to a deliberate single keypress.
// Module-scope so all entry points (button clicks, cycle hotkey,
// Ctrl+1..6 chord keybinds) share the same gate without prop drilling.
const SHADER_SWITCH_MIN_INTERVAL_MS = 220;
let lastShaderSwitchAt = 0;

function ShaderPicker({ activeTarget }: { activeTarget: ActiveScrobbleTarget | null }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ShaderProfileInfo[]>([]);
  const [active, setActive] = useState(0);
  const [keybindings, setKeybindings] = useState<Record<string, string>>({});
  const [anime4kSubOpen, setAnime4kSubOpen] = useState(false);
  const [submenuPos, setSubmenuPos] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const anime4kRowRef = useRef<HTMLDivElement>(null);
  // Refs to the portal-rendered Anime4K submenu so the click-outside
  // detector can recognise it as part of the picker even though
  // createPortal places it under document.body, outside `ref.current`.
  // Without this, a mousedown on a submenu button triggers the outside
  // handler, unmounts the picker, and the button's click event never
  // reaches `select()` — clicking Anime4K modes silently no-op'd.
  const anime4kPortalRef = useRef<HTMLDivElement>(null);
  // Timer that delays the submenu close so the cursor can cross the
  // small gap between the parent row and the portal-rendered submenu
  // without triggering mouseleave-driven dismissal.
  const closeTimerRef = useRef<number | null>(null);
  useMenuOpenSync(open);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setAnime4kSubOpen(false);
      closeTimerRef.current = null;
    }, 220);
  }, [cancelClose]);

  const openSubmenu = useCallback(() => {
    cancelClose();
    if (anime4kRowRef.current) {
      const rect = anime4kRowRef.current.getBoundingClientRect();
      // Pop to the RIGHT of the parent menu so the popout direction
      // matches the chevron the user sees on the row. 8 px gap keeps
      // the submenu visually distinct from the parent without any
      // dead space the cursor would otherwise have to jump over.
      // The picker is right-anchored to the upscaler button which
      // itself sits near the right edge of the control bar, but the
      // parent menu's right edge stops at the button, so there is
      // 300 px+ of free screen width to the right at every supported
      // window size. If the screen is narrow enough that the submenu
      // would clip, the body's overflow rules will still keep the
      // important left half (the mode names and chord labels) visible.
      setSubmenuPos({ top: rect.top, left: rect.right + 8 });
    }
    setAnime4kSubOpen(true);
  }, [cancelClose]);

  // Close the submenu and clear any pending timer when the parent
  // picker itself closes.
  useEffect(() => {
    if (!open) {
      cancelClose();
      setAnime4kSubOpen(false);
    }
  }, [open, cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  useEffect(() => {
    invoke<ShaderProfileInfo[]>("list_shader_profiles").then(setProfiles).catch(() => {});
    invoke<number>("get_shader_profile").then(setActive).catch(() => {});
  }, []);

  // Pull current keybindings so the submenu can show each Anime4K
  // mode's chord. Refresh on `aura:keybindings-changed` so a Settings
  // remap reflects immediately without a player restart.
  useEffect(() => {
    const refresh = () => {
      invoke<{ keybindings?: Record<string, string> }>("get_settings")
        .then((s) => setKeybindings(s?.keybindings ?? {}))
        .catch(() => {});
    };
    refresh();
    window.addEventListener("aura:keybindings-changed", refresh);
    return () => window.removeEventListener("aura:keybindings-changed", refresh);
  }, []);

  // Apply persisted shader for this title (if any) once the profile list
  // is known. The saved value is the profile NAME so it's stable across
  // renumbering — we look it up against the current profile list and
  // call set_shader_profile with the matching id.
  useEffect(() => {
    if (!activeTarget || profiles.length === 0) return;
    let cancelled = false;
    import("./titleState").then(({ getTitleState }) => {
      getTitleState(activeTarget.media_type, titleStateKey(activeTarget)).then((st) => {
        if (cancelled) return;
        const match = st?.shader ? profiles.find((p) => p.name === st.shader) : null;
        if (!match) {
          // No saved profile for this title: clear whatever the PREVIOUS title
          // left applied. `glsl-shaders` is a global mpv option and survives
          // loadfile, and this effect only ever applied, never un-applied, so
          // an Anime4K chain picked on an anime stayed active on the next
          // live-action film. Profile 0 is the empty chain, so this resolves
          // to a `change-list glsl-shaders clr` and never hands a path to
          // set_property (landmine 8).
          invoke<number>("get_shader_profile")
            .then((cur) => {
              if (cancelled || cur === 0) return;
              invoke("set_shader_profile", { profile: 0 })
                .then(() => setActive(0))
                .catch(() => {});
            })
            .catch(() => {});
          return;
        }
        invoke("set_shader_profile", { profile: match.id })
          .then(() => setActive(match.id))
          .catch(() => {});
      });
    });
    return () => { cancelled = true; };
  }, [activeTarget, profiles]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      // The Anime4K submenu lives in a portal under document.body so
      // a click on one of its rows isn't inside ref.current. Without
      // this second check the mousedown closes the picker before the
      // submenu button's click event fires, and the row appears dead.
      const insidePicker = ref.current?.contains(target);
      const insidePortal = anime4kPortalRef.current?.contains(target);
      if (!insidePicker && !insidePortal) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const select = useCallback(async (id: number) => {
    // Single throttle gate for every shader-switch entry point: row
    // clicks, the cycle hotkey, and the Ctrl+1..6 chords (which
    // dispatch `aura:set-shader` and re-enter this same function).
    // Module-scoped timestamp so the gate spans component remounts
    // and multiple call sites without state plumbing.
    const now = Date.now();
    if (now - lastShaderSwitchAt < SHADER_SWITCH_MIN_INTERVAL_MS) {
      return;
    }
    lastShaderSwitchAt = now;
    try {
      await invoke("set_shader_profile", { profile: id });
      setActive(id);
      const name = profiles.find((p) => p.id === id)?.name ?? "None";
      fireToast(id === 0 ? "Upscaler off" : `Upscaler · ${name}`);
      if (activeTarget && name) {
        setTitleState(activeTarget.media_type, titleStateKey(activeTarget), { shader: name });
      }
    } catch (e) {
      console.error("Shader switch failed", e);
      // Surface the actual reason (first line, capped) so a failure is
      // actionable instead of a generic toast — e.g. "Shader file not found …".
      const reason = String(e).replace(/^Error:\s*/i, "").split("\n")[0].trim().slice(0, 90);
      fireToast(reason ? `Upscaler failed — ${reason}` : "Upscaler failed");
    }
    setOpen(false);
  }, [profiles, activeTarget]);

  useEffect(() => {
    const onCycle = () => {
      // The legacy "Anime4K" profile (id 1) is hidden from the picker
      // because its v4 replacements (ids 7-12) supersede it. The cycle
      // hotkey was iterating the raw profile list, so pressing S could
      // still land on the hidden id with no UI representation. Filter
      // to the same set the picker actually shows.
      const cyclable = profiles.filter((p) => !HIDDEN_PROFILE_IDS.has(p.id));
      if (cyclable.length === 0) return;
      const i = cyclable.findIndex((p) => p.id === active);
      const next = cyclable[(i + 1) % cyclable.length];
      select(next.id);
    };
    window.addEventListener("aura:cycle-shader", onCycle);
    return () => window.removeEventListener("aura:cycle-shader", onCycle);
  }, [profiles, active, select]);

  // Keybind shortcuts (Ctrl+1..6 / Ctrl+0) dispatch `aura:set-shader`
  // with a profile id and let this listener route through `select()`,
  // so the throttle gate, MPV invoke, pill update, toast, and per-
  // title persistence all happen in exactly one place. Without this
  // funnel the pill's `active` state would drift on chord switches
  // and a fast double-tap could land two concurrent change-list
  // rebuilds in libmpv.
  useEffect(() => {
    const onSetShader = (e: Event) => {
      const detail = (e as CustomEvent<{ profileId?: number }>).detail;
      if (!detail || typeof detail.profileId !== "number") return;
      void select(detail.profileId);
    };
    window.addEventListener("aura:set-shader", onSetShader);
    return () => window.removeEventListener("aura:set-shader", onSetShader);
  }, [select]);

  // Compact label for the upscaler pill on the control bar. For
  // Anime4K profiles (ids 7–12) the pill collapses "Anime4K Mode A+A"
  // → "Anime4K (A+A)" to fit in the limited space without losing the
  // mode identifier the user just selected. Other profiles render
  // their full name.
  const activeName = (() => {
    const p = profiles.find((q) => q.id === active);
    if (!p) return "None";
    if (ANIME4K_ID_SET.has(p.id)) {
      const tag = p.name.replace(/^Anime4K\s+(?:Mode\s+)?/, "");
      return `Anime4K (${tag})`;
    }
    return p.name;
  })();

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Upscaling / Shader Profile"
        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-xs font-medium
                    transition-all duration-150 border
                    ${open || active !== 0
                      ? "bg-ln-accent/20 text-ln-accent border-ln-accent/30"
                      : "bg-white/5 text-white/55 border-white/10 hover:bg-white/10 hover:text-white/85"
                    }`}
      >
        <ShaderIcon />
        <span className="font-mono tracking-wider">{activeName}</span>
      </button>

      {open && profiles.length > 0 && (() => {
        const visibleProfiles = profiles.filter(
          (p) => !HIDDEN_PROFILE_IDS.has(p.id) && !ANIME4K_ID_SET.has(p.id),
        );
        const noneEntry = visibleProfiles.find((p) => p.id === 0);
        const otherEntries = visibleProfiles.filter((p) => p.id !== 0);
        const anime4kProfiles = ANIME4K_DISPLAY_ORDER
          .map((id) => profiles.find((p) => p.id === id))
          .filter((p): p is ShaderProfileInfo => Boolean(p));
        const anime4kActive = ANIME4K_ID_SET.has(active);
        const activeAnime4k = anime4kProfiles.find((p) => p.id === active);

        const renderRow = (p: ShaderProfileInfo) => (
          <button
            key={p.id}
            onClick={() => select(p.id)}
            className={`w-full text-left px-3 py-2.5 rounded-md transition-colors
                        ${p.id === active
                          ? "bg-ln-accent/10 text-ln-accent"
                          : "text-white/85 hover:text-white hover:bg-white/[0.16]"}`}
          >
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] font-semibold">{p.name}</span>
              {p.id === active && (
                <span className="text-[10px] font-mono uppercase tracking-[0.18em] opacity-80">
                  Active
                </span>
              )}
            </div>
            <p className={`text-[12px] leading-snug mt-0.5
                          ${p.id === active ? "text-ln-accent/90" : "text-white/65"}`}>
              {p.description}
            </p>
          </button>
        );

        return (
          <div className="absolute bottom-full mb-2 right-0 w-[340px]
                          rounded-xl shadow-glass-edge z-50
                          aura-glass-menu p-2">
            <p className="text-white/55 text-[10.5px] font-mono uppercase tracking-[0.22em]
                          px-2 pt-2 pb-1.5">
              Upscaler
            </p>
            <div className="max-h-[60vh] overflow-y-auto">
              {noneEntry && renderRow(noneEntry)}

              {/* Anime4K parent — hover-only; clicking does nothing.
                  The submenu pops out to the LEFT of the parent via
                  a portal so the picker's overflow-y-auto can't clip
                  it. A short close-delay timer lets the cursor cross
                  the gap between parent and submenu without dismiss. */}
              {anime4kProfiles.length > 0 && (
                <div
                  ref={anime4kRowRef}
                  onMouseEnter={openSubmenu}
                  onMouseLeave={scheduleClose}
                  role="menuitem"
                  aria-haspopup="menu"
                  aria-expanded={anime4kSubOpen}
                  className={`w-full text-left px-3 py-2.5 rounded-md cursor-default
                              transition-colors select-none
                              ${anime4kActive
                                ? "bg-ln-accent/10 text-ln-accent"
                                : anime4kSubOpen
                                  ? "bg-white/8 text-white"
                                  : "text-white/85 hover:bg-white/[0.16] hover:text-white"
                              }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[14px] font-semibold">Anime4K</span>
                    <div className="flex items-center gap-2">
                      {anime4kActive && (
                        <span className="text-[10px] font-mono uppercase tracking-[0.18em] opacity-80">
                          {activeAnime4k?.name.replace("Anime4K ", "") ?? "Active"}
                        </span>
                      )}
                      <span className="text-white/40 text-[15px] leading-none">›</span>
                    </div>
                  </div>
                  <p className={`text-[12px] leading-snug mt-0.5
                                ${anime4kActive ? "text-ln-accent/90" : "text-white/65"}`}>
                    Specialised upscaler for anime / cartoon line art. Preserves edges and reduces ringing far better than general-purpose shaders on animated sources.
                  </p>
                </div>
              )}

              {otherEntries.map(renderRow)}
            </div>
          </div>
        );
      })()}

      {anime4kSubOpen && submenuPos && createPortal(
        <div
          ref={anime4kPortalRef}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          style={{ position: "fixed", top: submenuPos.top, left: submenuPos.left }}
          className="w-[300px] rounded-xl shadow-glass-edge z-[10000]
                     aura-glass-menu p-2"
        >
          <p className="text-white/55 text-[10.5px] font-mono uppercase tracking-[0.22em]
                        px-2 pt-2 pb-1.5">
            Anime4K · Modes
          </p>
          {(() => {
            const anime4kProfiles = ANIME4K_DISPLAY_ORDER
              .map((id) => profiles.find((p) => p.id === id))
              .filter((p): p is ShaderProfileInfo => Boolean(p));
            return anime4kProfiles.map((p) => {
              const action = ANIME4K_ACTION_BY_ID[p.id];
              const chord = action ? keybindings[action] : "";
              const chordLabel = chord ? prettyBinding(chord) : "";
              const modeLabel = p.name.replace(/^Anime4K\s+/, "");
              return (
                <button
                  key={p.id}
                  onClick={() => { select(p.id); setAnime4kSubOpen(false); }}
                  className={`w-full text-left px-3 py-2 rounded-md transition-colors
                              ${p.id === active
                                ? "bg-ln-accent/10 text-ln-accent"
                                : "text-white/85 hover:text-white hover:bg-white/[0.16]"}`}
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-[13px] font-semibold">{modeLabel}</span>
                    {chordLabel && (
                      <span className="text-[10px] font-mono text-white/35 tracking-wider">
                        {chordLabel}
                      </span>
                    )}
                  </div>
                  <p className={`text-[11.5px] leading-snug mt-0.5
                                ${p.id === active ? "text-ln-accent/90" : "text-white/65"}`}>
                    {p.description.replace(/^Anime4K v4 — Mode [A-Z+]+\.\s*/, "")}
                  </p>
                </button>
              );
            });
          })()}
        </div>,
        document.body,
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PanscanButton — toggles MPV's `panscan` between 0.0 (default; letterbox /
// pillarbox) and 1.0 (zoom-and-crop the video to fill the viewport on its
// constrained axis). The on-screen button + the `toggle-panscan` keybind
// converge here via the `aura:toggle-panscan` event so the same flip happens
// either way and the active highlight stays in sync.
//
// Reset to off on stream change — MPV persists `panscan` across loadfile,
// so without this the previous stream's setting bleeds into the next one
// (e.g. a 21:9 movie's fill setting would re-apply to a 16:9 episode).
// ---------------------------------------------------------------------------

function PanscanButton({ activeTarget }: { activeTarget: ActiveScrobbleTarget | null }) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(false);
    invoke("set_panscan", { value: 0.0 }).catch(() => {});
  }, [activeTarget?.id]);

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      invoke("set_panscan", { value: next ? 1.0 : 0.0 })
        .then(() => fireToast(next ? "Fill screen on" : "Fill screen off"))
        .catch(() => fireToast("Panscan failed"));
      return next;
    });
  }, []);

  useEffect(() => {
    const onEvent = () => toggle();
    window.addEventListener("aura:toggle-panscan", onEvent);
    return () => window.removeEventListener("aura:toggle-panscan", onEvent);
  }, [toggle]);

  return (
    <Tooltip
      text="Fill Screen: zoom and crop to remove letterbox / pillarbox bars"
      pos="top"
      shortcut="Z"
    >
      <button
        onClick={toggle}
        aria-label={on ? "Disable fill screen" : "Enable fill screen"}
        aria-pressed={on}
        className={`flex items-center justify-center w-10 h-10 rounded-full
                    transition-colors duration-150 flex-shrink-0
                    ${on
                      ? "bg-ln-accent/25 text-ln-accent"
                      : "text-white/80 hover:text-white hover:bg-white/12 active:bg-white/20"
                    }`}
      >
        <PanscanIcon />
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// SubtitleStyleMenu — expose all six subtitle style settings inline from
// the player control bar, in addition to the deeper Settings page. Reuses
// the same backend round-trip (`update_settings` + `apply_subtitle_style`)
// so every change is reflected in MPV instantly.
// ---------------------------------------------------------------------------

interface SubStyle {
  subtitle_font_size: number;
  subtitle_position: number;
  subtitle_border_size: number;
  subtitle_color: string;
  subtitle_back_color: string;
  subtitle_font: string;
}

function SubtitleStyleMenu() {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<SubStyle | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useMenuOpenSync(open);

  useEffect(() => {
    invoke<SubStyle>("get_settings").then(setStyle).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const patch = useCallback(async (p: Partial<SubStyle>) => {
    if (!style) return;
    const next = { ...style, ...p };
    setStyle(next); // optimistic
    try {
      await invoke("update_settings", { patch: p });
      invoke("apply_subtitle_style").catch(() => {});
      // Fire the change event so PlayerOverlay's lift effect refreshes
      // its cached baseline. Without this the lift would clobber the
      // user's slider adjustment on the next controls-hide cycle.
      window.dispatchEvent(new CustomEvent("aura:settings-changed"));
    } catch { /* keep optimistic state */ }
  }, [style]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Subtitle styling"
        className={`flex items-center justify-center w-10 h-10 rounded-full
                    transition-colors duration-150 flex-shrink-0
                    ${open
                      ? "bg-ln-accent/25 text-ln-accent"
                      : "bg-white/5 text-white/55 hover:bg-white/10 hover:text-white/85"}`}
      >
        <span className="font-bold text-[14px] tracking-tight">Aa</span>
      </button>

      {open && style && (
        <div
          className="absolute bottom-full mb-2 right-0 w-[320px]
                     rounded-xl shadow-glass-edge z-50
                     aura-glass-menu p-4
                     space-y-4"
        >
          <p className="text-white/55 text-[10.5px] font-mono uppercase tracking-[0.22em]">
            Subtitle Style
          </p>

          {/* Range goes 0..150 because MPV's sub-pos accepts up to 150;
              values >100 push subs below the natural frame baseline,
              useful when ASS scripts add their own margin and even
              with `ass-style-override=force` the subs land slightly
              above the true bottom edge. */}
          <InlineSlider
            label="Vertical position" value={style.subtitle_position} min={0} max={150} suffix="%"
            onChange={(v) => patch({ subtitle_position: v })}
          />
          <InlineSlider
            label="Font size" value={style.subtitle_font_size} min={20} max={100}
            onChange={(v) => patch({ subtitle_font_size: v })}
          />
          <InlineSlider
            label="Outline" value={style.subtitle_border_size} min={0} max={10}
            onChange={(v) => patch({ subtitle_border_size: v })}
          />
          <InlineHexInput
            label="Glyph colour"
            value={style.subtitle_color}
            onChange={(v) => patch({ subtitle_color: v })}
          />
          <InlineHexInput
            label="Background"
            value={style.subtitle_back_color}
            onChange={(v) => patch({ subtitle_back_color: v })}
          />
          <InlineTextInput
            label="Font family"
            value={style.subtitle_font}
            placeholder="default"
            onChange={(v) => patch({ subtitle_font: v })}
          />
        </div>
      )}
    </div>
  );
}

function InlineSlider({
  label, value, min, max, suffix, onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  const span = Math.max(1, max - min);
  const frac = Math.max(0, Math.min(1, (value - min) / span));
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-white/70 text-[12px]">{label}</span>
        <span className="text-white/55 text-[11px] font-mono tabular-nums">
          {value}{suffix ?? ""}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={1}
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

function InlineHexInput({
  label, value, onChange,
}: { label: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  const valid = /^#[0-9a-fA-F]{6,8}$/.test(draft);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-white/70 text-[12px]">{label}</span>
        <span
          aria-hidden
          className="w-5 h-5 rounded-md border border-white/15"
          style={{ background: valid ? draft : "transparent" }}
        />
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => valid && onChange(draft.trim())}
        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
        spellCheck={false}
        className="w-full bg-white/5 border border-white/10 focus:border-white/25
                   rounded-md px-2.5 py-1.5 text-[12px] font-mono outline-none"
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );
}

function InlineTextInput({
  label, value, placeholder, onChange,
}: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);
  return (
    <div className="space-y-1">
      <span className="text-white/70 text-[12px]">{label}</span>
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onChange(draft)}
        onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
        spellCheck={false}
        className="w-full bg-white/5 border border-white/10 focus:border-white/25
                   rounded-md px-2.5 py-1.5 text-[12px] font-mono outline-none
                   placeholder:text-white/25"
        style={{ color: "var(--text-primary)" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// IconButton — uniform 40 px round button used across the bar.
// ---------------------------------------------------------------------------

function IconButton({
  onClick, label, children, tooltip, active,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  tooltip?: string;
  active?: boolean;
}) {
  const btn = (
    <button
      onClick={onClick}
      aria-label={label}
      className={`flex items-center justify-center w-10 h-10 rounded-full
                  transition-colors duration-150 flex-shrink-0
                  ${active
                    ? "bg-ln-accent/25 text-ln-accent"
                    : "text-white/80 hover:text-white hover:bg-white/12 active:bg-white/20"
                  }`}
    >
      {children}
    </button>
  );
  return tooltip ? <Tooltip text={tooltip} pos="top">{btn}</Tooltip> : btn;
}

// ---------------------------------------------------------------------------
// PlayerOverlay
// ---------------------------------------------------------------------------

interface Props {
  activeTarget: ActiveScrobbleTarget | null;

  /** True when the active target is anime (isAnimeMeta). Gates the
   *  motion-interpolation toggle — interpolation is anime-only. */
  isAnime: boolean;

  /** True for Live TV channels (synthetic `iptv:` target). Replaces the
   *  seek scrubber with a LIVE indicator — an infinite live stream has no
   *  duration to scrub, and resume/skip controls are meaningless. */
  isLive?: boolean;
  /** True for a "Watch Trailer" session (synthetic `trailer:<id>` target).
   *  Keeps the VOD scrubber (a trailer is finite) but disables hover
   *  thumbnails (the googlevideo CDN URL isn't reliably range-probeable) and
   *  the OP/ED skip-window button, and shows a TRAILER badge instead of LIVE. */
  isTrailer?: boolean;
  /** Requested trailer quality ("auto"|"720"|"1080"|"1440"|"2160") — drives the
   *  active row in the quality menu. */
  trailerQuality?: string;
  /** Actually-resolved trailer quality label (e.g. "1080p") — the menu button
   *  text; may be lower than requested when the title has no higher rendition. */
  trailerQualityLabel?: string;
  /** Highest rendition the current trailer offers — gates the quality menu so
   *  unavailable resolutions never appear. */
  trailerMaxHeight?: number;
  /** True while a trailer quality swap is re-resolving (yt-dlp). Disables the
   *  quality menu + shows a loading affordance. */
  isTrailerResolving?: boolean;
  /** Change the trailer quality (re-resolves + swaps in place at the playhead). */
  onSetTrailerQuality?: (quality: string) => void;

  // Playback state
  time: number;
  duration: number;
  paused: boolean;
  volume: number;
  speed: number;
  buffering: boolean;
  /** Cache fill percent (0..100) reported by MPV during a buffer underflow.
   *  Null when not buffering or not yet readable. Surfaced under the
   *  buffering overlay so the user knows whether MPV is making progress. */
  bufferPct: number | null;
  /** True during a slow/buffering seek (debounced) — surfaces the loading
   *  overlay so the user sees WHY playback paused after a seek. */
  seekLoading?: boolean;
  /** True once MPV has produced a first frame in the current playback
   *  session (time-pos > 0). Used to gate the loading overlay so it
   *  stays up across the gap between MPV's loadfile completing and
   *  paused-for-cache settling — i.e. until the user is genuinely
   *  about to see something. */
  firstFrameSeen: boolean;

  /** True when we're a NON-leader synced to a watch party — the leader controls
   *  playback, so the transport controls (play/pause / seek / skip / speed) are
   *  disabled with a hint. Local-only controls (volume, subs, fullscreen) stay
   *  live. The handlers are also no-ops in this state (gated in App), so this is
   *  purely the visual/affordance half. */
  partyFollower?: boolean;

  /** Mirrors the overlay's auto-hide `controlsVisible` to the parent, so the
   *  sibling PlayerPartyHud pill can fade in lockstep with the player chrome. */
  onControlsVisibleChange?: (visible: boolean) => void;

  // Handlers
  togglePause: () => void;
  seekRelative: (s: number) => void;
  seekAbsolute: (t: number) => void;
  commitVolume: (v: number) => void;
  commitSpeed: (s: number) => void;
  onExitPlayback: () => void;

  // Subtitle picker (the EXTERNAL OpenSubtitles search)
  subsOpen: boolean;
  setSubsOpen: (open: boolean) => void;

  // Lifted fullscreen state
  isFullscreen: boolean;
  onToggleFullscreen: () => void;

  /** Direct (un-proxied) stream URL — used for Copy / Download / External. */
  streamUrl: string | null;
  /** Stream-addon-derived external subtitles (.srt/.vtt) — merged with
   *  MPV's track-list in the subtitle dropdown. Already sorted by addon
   *  order with the preferred-language priority applied. */
  externalSubs: ExternalSubtitle[];
  /** 2-letter ISO language code for the user's preferred subtitle
   *  language — drives the "selected lang first" ordering. */
  preferredSubLang?: string | null;
  /** 2-letter ISO language code for the user's preferred audio
   *  language — used to auto-switch audio when MPV picked the wrong
   *  default (e.g. anime files where EN dub was picked over JP). */
  preferredAudioLang?: string | null;
  /** Allow-list of 2-letter ISO codes the subtitle picker should
   *  surface. Empty = surface every track regardless of language. */
  selectableSubLangs?: string[];
  /** AIOMetadata-sourced scoring inputs (originalLanguage / productionCountries).
   *  null when DetailView didn't supply them (e.g. CW row that didn't fully
   *  resolve meta detail before the user clicked play). */
  scoringMeta?: ScoringMeta | null;
  /** Ordered audio language priority. "original" token resolves to
   *  meta.original_language at evaluation time. */
  audioPriority?: string[];
  /** Heavy penalty against tracks whose title contains "dub" or "dubbed". */
  avoidDubs?: boolean;
  /** Optional ISO 3166-1 region for regional dialect tiebreak (es-MX vs es-ES). */
  userRegion?: string;
  /** Keyboard codes that should NOT wake the auto-hidden control bar.
   *  App passes the user's volume-up / volume-down bindings here so
   *  arrow-key volume bumps stay silent (toast-only) like mousewheel. */
  silentWakeCodes?: readonly string[];

  /** In-playback episode drawer (EOS Spotlight spec 2026-05-19, Phase
   *  4). When supplied (series/anime only), PlayerOverlay renders an
   *  always-present thin right-edge handle that hover/click-expands the
   *  shared EpisodePanel. Omitted for movies. seriesId / mediaType /
   *  currentEpisodeId derive from activeTarget on the App side; the
   *  panel resolves its own (cached) MetaDetail. */
  episodePanel?: {
    seriesId: string;
    mediaType: string;
    addons: AddonEntry[];
    currentEpisodeId: string;
    nextEpisodeId: string | null;
    isFullscreen: boolean;
    libraryById: Map<string, LibraryItem>;
    seriesArt: string | null;
    onPlayEpisode: (video: VideoEntry) => void;
  } | null;
}

// ---------------------------------------------------------------------------
// EpisodeEdgeTrigger — the in-playback episode drawer affordance (EOS
// Spotlight spec 2026-05-19, Phase 4). A thin always-present handle on
// the right edge; hovering it (with a ~150 ms open-intent delay so a
// cursor merely crossing the edge doesn't fire) or clicking it expands
// the shared EpisodePanel. Leaving the handle + panel for ~300 ms closes
// it (grace so a brief overshoot toward the season dropdown doesn't
// dismiss). `useMenuOpenSync(open)` freezes the control-bar auto-hide
// while it's open AND makes the overlay swallow the dismiss click — the
// exact same coordination AniSkipMenu / SubtitlePicker use.
// ---------------------------------------------------------------------------

function EpisodeEdgeTrigger({
  seriesId, mediaType, addons, currentEpisodeId, nextEpisodeId,
  isFullscreen, libraryById, seriesArt, onPlayEpisode, controlsVisible,
}: NonNullable<Props["episodePanel"]> & { controlsVisible: boolean }) {
  const [open, setOpen] = useState(false);
  useMenuOpenSync(open);

  // Two timers: open-intent (hover dwell before expanding) and leave-
  // grace (delay before collapsing). Refs so re-renders don't drop a
  // pending timer.
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const armOpen = useCallback(() => {
    if (open) return;
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (openTimer.current) return;
    openTimer.current = setTimeout(() => {
      openTimer.current = null;
      setOpen(true);
    }, 150);
  }, [open]);

  const cancelOpen = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
  }, []);

  const armClose = useCallback(() => {
    if (closeTimer.current) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
    }, 300);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);

  const closeNow = useCallback(() => {
    clearTimers();
    setOpen(false);
  }, [clearTimers]);

  return (
    <>
      {/* Thin edge handle. z-[9998] keeps it just under PlayerOverlay's
          click-capture (9999) but it has its own pointer-events so
          hover/click register. Fades in lockstep with the control-bar
          auto-hide (opacity/pointer-events below) — when the chrome
          hides, the handle goes with it; any pointer move wakes both, so
          the drawer is still one gesture away. Hidden entirely once the
          panel is open (the panel covers this strip). */}
      {!open && (
        <button
          type="button"
          aria-label="Show episodes"
          onClick={() => { cancelOpen(); setOpen(true); }}
          onPointerEnter={armOpen}
          onPointerLeave={cancelOpen}
          style={{
            opacity: controlsVisible ? 1 : 0,
            pointerEvents: controlsVisible ? "auto" : "none",
          }}
          className="fixed top-1/2 -translate-y-1/2 right-0 z-[9998]
                     h-28 w-[10px] hover:w-[16px] rounded-l-lg
                     bg-white/10 hover:bg-white/20 backdrop-blur-sm
                     border-y border-l border-white/10
                     flex items-center justify-center
                     transition-[width,background-color,opacity] duration-150
                     group"
        >
          <svg
            width="12" height="12" viewBox="0 0 24 24" fill="currentColor"
            className="text-white/55 group-hover:text-white/85 -ml-0.5"
            aria-hidden
          >
            <path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
          </svg>
        </button>
      )}

      {/* Shared drawer. Wrapped so a pointer dwelling on the panel
          cancels the leave-grace, and leaving it (toward the video)
          re-arms the close. EpisodePanel paints its own scrim + slides
          in from the right; clicking the scrim / Escape / a row closes
          it via onClose. */}
      <div
        className="pointer-events-auto"
        onPointerEnter={cancelClose}
        onPointerLeave={armClose}
      >
        <EpisodePanel
          open={open}
          onClose={closeNow}
          seriesId={seriesId}
          mediaType={mediaType}
          addons={addons}
          currentEpisodeId={currentEpisodeId}
          nextEpisodeId={nextEpisodeId}
          isFullscreen={isFullscreen}
          libraryById={libraryById}
          seriesArt={seriesArt}
          onPlayEpisode={(v) => { closeNow(); onPlayEpisode(v); }}
        />
      </div>
    </>
  );
}

// 5× was removed: at 5× a 4K HEVC stream can't keep up — the VO drops
// hundreds of frames/sec and audio/video desyncs. 4× is the smooth
// ceiling on current hardware, so it's the top stop.
const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export default function PlayerOverlay({
  activeTarget,
  isAnime,
  isLive = false,
  isTrailer = false,
  trailerQuality = "1080",
  trailerQualityLabel = "",
  trailerMaxHeight = 2160,
  isTrailerResolving = false,
  onSetTrailerQuality,
  time, duration, paused, volume, speed, buffering, bufferPct, seekLoading = false, firstFrameSeen,
  partyFollower = false,
  onControlsVisibleChange,
  togglePause, seekRelative, seekAbsolute, commitVolume, commitSpeed,
  onExitPlayback,
  subsOpen, setSubsOpen,
  isFullscreen, onToggleFullscreen,
  streamUrl, externalSubs, preferredSubLang, preferredAudioLang,
  selectableSubLangs,
  scoringMeta, audioPriority, avoidDubs, userRegion,
  silentWakeCodes,
  episodePanel,
}: Props) {
  // ── Open-menu tracker ──────────────────────────────────────────────
  // Each child menu (TrackMenu, SpeedMenu, ShaderPicker, MoreMenu,
  // VolumeControl) calls `useMenuOpenSync(open)` which adjusts this
  // counter via the MenuTrackerCtx provided below. The OpenSubtitles
  // modal is also folded into the count so its presence freezes
  // auto-hide and suppresses stray play/pause toggles.
  const [openMenuCount, setOpenMenuCount] = useState(0);
  const openMenuCountRef = useRef(0);
  const menuTracker = useMemo<MenuTracker>(() => ({
    notify: (delta) => setOpenMenuCount((n) => Math.max(0, n + delta)),
  }), []);
  useEffect(() => {
    openMenuCountRef.current = openMenuCount;
  }, [openMenuCount]);

  const anyMenuOpen = openMenuCount > 0 || subsOpen;
  const anyMenuOpenRef = useRef(false);
  useEffect(() => { anyMenuOpenRef.current = anyMenuOpen; }, [anyMenuOpen]);

  // While the pointer rests on the scrubber, hold the chrome visible — hover
  // thumbnails can take a moment to load, and the 3 s idle auto-hide would
  // otherwise pull the whole bar (and the preview) out from under the cursor.
  const [scrubberHovered, setScrubberHovered] = useState(false);

  // Auto-hide is bypassed (controls + cursor stay visible) whenever a
  // menu is open, playback is paused, OR the scrubber is hovered. Fading
  // should only happen during active playback — a paused frame doesn't need
  // its UI to disappear; the user is likely about to re-engage.
  const controlsVisible = useAutoHide(3000, anyMenuOpen || paused || scrubberHovered, silentWakeCodes);
  // Publish controls-visibility to the parent so the sibling PlayerPartyHud pill
  // can fade with the chrome (it lives outside this overlay).
  useEffect(() => { onControlsVisibleChange?.(controlsVisible); }, [controlsVisible, onControlsVisibleChange]);

  // Scrub state — `scrubValue` is set while the user drags the slider; we
  // commit on pointer-up so we don't seek-storm.
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const displayTime = scrubValue ?? time;
  const progress = duration > 0 ? (displayTime / duration) * 100 : 0;

  // Live DVR — for Live TV, instead of hiding the scrubber entirely we let
  // the user rewind through mpv's demuxer back-buffer (the 128 MiB the
  // engine already keeps — RAM-only, freed on stop, nothing on the VPS).
  // The estimator rides `time` + wallclock; no new mpv property reads, so
  // none of the get_property-race landmines apply. See `useLiveDvr`. The
  // target id keys the estimator so switching channels (isLive stays true,
  // time resets to ~0) re-anchors to the new edge instead of showing the
  // fresh channel as "behind live".
  const dvr = useLiveDvr(isLive, time, activeTarget?.id ?? null);
  // Go Live: jump a few seconds behind the live edge, but debounced + a no-op
  // when already live, so spam-clicking can't seek-storm mpv (which stalled
  // forward buffering until the clicking stopped).
  const lastGoLiveRef = useRef(0);
  const goLive = () => {
    const t = Date.now();
    if (t - lastGoLiveRef.current < 800) return;
    lastGoLiveRef.current = t;
    if (dvr.atLive) return;
    seekAbsolute(Math.max(dvr.windowStart, dvr.edge - 3));
  };

  // AniSkip OP/ED/recap windows for the current episode. Surfaced as
  // amber bands on the scrubber so the user can see where skip
  // boundaries land before crossing them. Same hook used elsewhere
  // for the SkipWindowButton + auto-skip logic — single source of
  // truth, no duplicate fetch.
  const skipWindowsForScrub = useSkipWindows();

  // Track lists: read on demand because we trimmed `track-list / aid / sid`
  // out of the property-observer set in Phase 6.0.2 (those formats broke the
  // entire observation channel on this libmpv build). The 500 ms poll this
  // comment used to describe is GONE and must not come back: it raced the
  // AniSkip seek and crashed the FFI. See the read-once + `aura:tracks-refresh`
  // pattern in the effect below.
  //
  // The list is KEYED to the file it was read from. An episode advance or a
  // source switch swaps the file without unmounting PlayerOverlay, and the
  // one-shot auto-selects below re-arm the instant `activeTarget.id` /
  // `streamUrl` changes, which is in the SAME commit, ~10 ms after
  // `loadfile`, long before the new file's track list has been read. Holding
  // the list in plain state let those effects run against the PREVIOUS
  // file's tracks and burn their one-shot guard on a stale answer (observed
  // as the audio auto-select firing 12 ms after loadfile). Deriving `tracks`
  // from a load key during RENDER, rather than clearing it from the reset
  // effect, is what makes the staleness visible synchronously: a state
  // update scheduled inside the reset effect would not be serviced until
  // after every other passive effect in the same commit had already run.
  // In-place reloads (recovery-modal "Reload stream", EOS "Replay", live
  // auto-reconnect) re-issue load_video with the SAME activeTarget.id and the
  // SAME streamUrl, so neither half of this key changes even though mpv has
  // re-run loadfile and reverted aid / sid to the file's defaults. App.tsx
  // fires `aura:player-reloaded` on those three paths; folding the nonce into
  // the key makes them re-arm exactly like any other load.
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    const onReloaded = () => setReloadNonce((n) => n + 1);
    window.addEventListener("aura:player-reloaded", onReloaded);
    return () => window.removeEventListener("aura:player-reloaded", onReloaded);
  }, []);
  const loadKey = `${activeTarget?.id ?? ""}::${streamUrl ?? ""}::${reloadNonce}`;
  const [trackList, setTrackList] = useState<{ key: string; list: TrackEntry[] }>(
    { key: "", list: EMPTY_TRACKS },
  );
  const tracks = trackList.key === loadKey ? trackList.list : EMPTY_TRACKS;
  /** Local "subtitles muted" flag tracked separately because MPV's
   *  `sub-visibility=no` doesn't surface as a track-list change. */
  const [subsMuted, setSubsMuted] = useState(false);

  // ── A/V sync nudges ──
  // Lifted into PlayerOverlay scope so both the audio and sub track
  // menus can host their respective delay row inline.
  //
  // `sub-delay`, `audio-delay` and `sub-speed` are all mpv OPTIONS, and a
  // runtime change to an option PERSISTS across `loadfile`. mpv does not zero
  // them for us. Resetting only the React state (which is what this used to do)
  // left the UI reading 0.00s while mpv was still applying the previous
  // episode's correction: a 30s Live Sync fix silently poisoned the next
  // episode, and the user had no value on screen to explain it. Every reset
  // below therefore has to be WRITTEN THROUGH to mpv, not just to React.
  const [audioDelay, setAudioDelay] = useState(0);
  const [subDelay,   setSubDelay]   = useState(0);
  // ── Live Subtitle Sync ──
  // `subSpeed` is mpv's `sub-speed` (the framerate-drift multiplier a two-point
  // solve produces). `syncFirstAnchor` is the first (playback clock, cue end)
  // pair of that solve: it lives HERE, not in the panel, because the two-point
  // flow is "pick a line, close, play on, reopen, pick a second line" and the
  // panel unmounts in between.
  const [subSpeed, setSubSpeed] = useState(1);
  const [syncFirstAnchor, setSyncFirstAnchor] = useState<SyncAnchorPair | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  useEffect(() => {
    setAudioDelay(0);
    setSubDelay(0);
    setSubSpeed(1);
    setSyncFirstAnchor(null);
    setSyncOpen(false);
    // Write every reset THROUGH to mpv. These are options, not per-file state:
    // mpv carries them across `loadfile`, so React-only resets would leave the
    // engine applying the last episode's correction behind a UI reading 0.00s.
    invoke("set_subtitle_delay", { seconds: 0 }).catch(() => {});
    invoke("set_audio_delay", { seconds: 0 }).catch(() => {});
    invoke("set_subtitle_speed", { speed: 1 }).catch(() => {});
    // `sub-visibility` is in the same family: an option, so it survives
    // loadfile, and React's mirror (`subsMuted`) does NOT survive an unmount.
    // Turning subs off on one title therefore left mpv hiding them on the NEXT
    // title played, while a freshly-mounted overlay showed subsMuted=false and
    // the menu showed a track selected. Symptom: "subtitles just stopped
    // working" with nothing in the UI to explain it. Re-enable per file; the
    // persisted per-title "off" preference re-applies it a moment later in the
    // subtitle auto-select effect below, which runs after this one.
    setSubsMuted(false);
    invoke("set_subtitle_visibility", { visible: true }).catch(() => {});
    // Keyed on the STREAM as well as the target. A source switch keeps the same
    // activeTarget.id but is a different release, and a subtitle correction
    // belongs to the release: carrying it over would silently mistime the new
    // source. Nothing is persisted to disk for the same reason (same reasoning
    // as playback speed and the video EQ, which are also session-only).
  }, [activeTarget?.id, streamUrl]);
  const nudgeAudioDelay = useCallback((delta: number) => {
    setAudioDelay((prev) => {
      const next = Math.max(-10, Math.min(10, +(prev + delta).toFixed(3)));
      invoke("set_audio_delay", { seconds: next }).catch(() => {});
      return next;
    });
  }, []);
  // Clamped to mpv's own +/-120 s range (lib.rs `set_subtitle_delay`), NOT the
  // old +/-10: Live Sync can legitimately land a 30 s correction on a
  // badly-muxed release, and a ±10 clamp here would snap it back the moment the
  // user tapped +0.1.
  const nudgeSubDelay = useCallback((delta: number) => {
    setSubDelay((prev) => {
      const next = Math.max(-120, Math.min(120, +(prev + delta).toFixed(3)));
      invoke("set_subtitle_delay", { seconds: next }).catch(() => {});
      return next;
    });
  }, []);
  const resetAudioDelay = useCallback(() => {
    setAudioDelay(0);
    invoke("set_audio_delay", { seconds: 0 }).catch(() => {});
  }, []);
  // Full reset of the subtitle timing: delay AND the drift multiplier. Zeroing
  // the delay while leaving a 1.043x speed applied would leave the track just as
  // wrong, in a way the user has no visible control for from this row.
  const resetSubDelay = useCallback(() => {
    setSubDelay(0);
    setSubSpeed(1);
    setSyncFirstAnchor(null);
    invoke("set_subtitle_delay", { seconds: 0 }).catch(() => {});
    invoke("set_subtitle_speed", { speed: 1 }).catch(() => {});
  }, []);

  // ── Toast (transient feedback over the player) ──
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = (e as CustomEvent<{ message: string }>).detail;
      if (!detail?.message) return;
      setToast(detail.message);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 1700);
    };
    window.addEventListener("aura:player-toast", onToast);
    return () => window.removeEventListener("aura:player-toast", onToast);
  }, []);
  // Phase 6.0.5 — gate the track-list polling on `duration > 0` so we
  // never read MPV properties while libmpv is still inside its loadfile
  // critical section. The earlier "as soon as overlay mounts" version
  // raced the wrapper and crashed on this libmpv build (concurrent reads
  // of pre-load properties returned non-null garbage that the FFI free
  // path then tried to release as if it were a heap pointer).
  //
  // CRITICAL: duration > 0 fires DURING loadfile, not safely after. Pair
  // with App.tsx — delay the first read 1.5 s past the 0→positive
  // transition and stabilize the dep on a derived boolean so duration
  // refinements don't re-arm.
  //
  // CRITICAL #2 — NO PERIODIC POLLING. The earlier `setInterval(refresh,
  // 500)` raced AniSkip's Lua-issued OP/ED seek: each `get_tracks` does
  // ~7 `get_property` calls in succession (count + 6 fields × N tracks),
  // and any one of them landing inside libmpv's seek critical section
  // crashes the wrapper at `mpv_wrapper_get_property+0xa71` (movsxd
  // rax, [rcx+rax*4] dereferencing -1). The previous mitigation removed
  // the 500 ms `sub-visibility` poll but left this loop, which fires the
  // same crash whenever the OP-skip seek and a poll tick coincide.
  //
  // Replacement: one read 1.5 s after duration goes positive (covers
  // the resume-seek window for Continue Watching), then refresh ONLY in
  // response to an `aura:tracks-refresh` window event. Track-mutating
  // actions (set_audio_track / set_subtitle_track / add_subtitle_to_mpv)
  // dispatch the event after their invoke resolves — see the picker
  // handlers below. AniSkip's seek never races this because it doesn't
  // mutate the track list.
  const tracksReady = duration > 0;
  useEffect(() => {
    if (!tracksReady) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const t = await invoke<TrackEntry[]>("get_tracks");
        if (!cancelled) setTrackList({ key: loadKey, list: t });
      } catch {
        if (!cancelled) setTrackList({ key: loadKey, list: EMPTY_TRACKS });
      }
    };
    const startTimer = setTimeout(() => {
      if (!cancelled) refresh();
    }, 1500);
    const onRefresh = () => {
      if (cancelled) return;
      refresh();
      // Reconcile after mpv commits the new sid — the immediate read can
      // still report the OLD selected track. selectedSubId covers the gap.
      setTimeout(() => { if (!cancelled) refresh(); }, 150);
    };
    window.addEventListener("aura:tracks-refresh", onRefresh);
    return () => {
      cancelled = true;
      clearTimeout(startTimer);
      window.removeEventListener("aura:tracks-refresh", onRefresh);
    };
    // `loadKey` is a dep so the read (and the refresh listener) re-arm for
    // the new file even in the case where `duration` never dips back to 0
    // between two loads.
  }, [tracksReady, loadKey]);

  // ── Subtitle dynamic lift while controls are visible ──────────────────
  //
  // The control bar sits at the bottom of the player, in the same vertical
  // band where MPV draws subtitles by default (sub-pos ≈ 95). Without
  // intervention, the bar covers dialogue every time the user moves the
  // mouse. Solution: when the bar appears, push subs UP by ~12 percentage
  // points; when it hides, restore the user's chosen baseline.
  //
  // Implementation notes:
  //   • Tracks the persisted baseline in state so a mid-playback slider
  //     change (via SubtitleStyleMenu) re-triggers the lift effect with
  //     the new baseline — otherwise the user's adjustment would be
  //     overridden by the next controls-toggle cycle.
  //   • `aura:settings-changed` is dispatched by SubtitleStyleMenu after
  //     `update_settings` succeeds, keeping baseline in sync without a
  //     polling loop.
  //   • Uses the dedicated runtime command — does NOT persist; never
  //     overrides the user's saved value.
  //   • Gated on `tracksReady` so we don't poke MPV during loadfile.
  const [subBaseline, setSubBaseline] = useState<number>(95);
  useEffect(() => {
    if (!tracksReady) return;
    let cancelled = false;
    const refresh = () => {
      invoke<{ subtitle_position: number }>("get_settings")
        .then((s) => { if (!cancelled) setSubBaseline(s.subtitle_position ?? 95); })
        .catch(() => {});
    };
    refresh();
    window.addEventListener("aura:settings-changed", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("aura:settings-changed", refresh);
    };
  }, [tracksReady]);

  // The sub-pos value the lift last computed. Held in a ref so the re-assert
  // effect below can re-apply the CURRENT target without re-subscribing.
  const liftTargetRef = useRef(subBaseline);
  useEffect(() => {
    if (!tracksReady) return;
    const LIFT_AMOUNT = 12;
    const target = controlsVisible
      ? Math.max(0, subBaseline - LIFT_AMOUNT)
      : subBaseline;
    liftTargetRef.current = target;
    invoke("set_subtitle_position_runtime", { percent: target }).catch(() => {});
  }, [controlsVisible, tracksReady, subBaseline]);

  // Re-assert the lift after events that silently clobber the runtime sub-pos:
  //   • a SEEK — mpv re-renders subtitles at the new position and the ASS
  //     force-margins path drops the runtime sub-pos, so the lifted dialogue
  //     snaps back down behind the control bar. The main lift effect does NOT
  //     re-run (controlsVisible has not changed), so nothing restores it. Two
  //     delayed re-asserts: one once mpv has processed a cached seek, one a beat
  //     later to cover a debrid re-buffer that renders the new frame late.
  //   • apply_subtitle_style at load — it re-applies the saved sub-pos baseline,
  //     undoing a lift that fired first. Re-assert immediately.
  useEffect(() => {
    if (!tracksReady) return;
    const reassert = () =>
      invoke("set_subtitle_position_runtime", { percent: liftTargetRef.current }).catch(() => {});
    const timers = new Set<number>();
    const later = (ms: number) => {
      const id = window.setTimeout(() => { timers.delete(id); reassert(); }, ms);
      timers.add(id);
    };
    const onSeek = () => { later(140); later(700); };
    window.addEventListener("aura:player-seek", onSeek);
    window.addEventListener("aura:subtitle-style-applied", reassert);
    return () => {
      window.removeEventListener("aura:player-seek", onSeek);
      window.removeEventListener("aura:subtitle-style-applied", reassert);
      timers.forEach((id) => clearTimeout(id));
    };
  }, [tracksReady]);

  const audioTracks = useMemo(() => tracks.filter((t) => t.type === "audio"), [tracks]);
  // Optimistic subtitle selection. mpv's track-list `selected` flag lags a
  // switch by a beat, so the menu highlight drifted from reality right after
  // a pick. We record the user's intent here for instant feedback; the
  // delayed get_tracks reconcile (below) is authoritative. Reset per file so
  // a stale id can't match a different track after an episode change.
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null);
  // One-shot guards for the audio + subtitle auto-select effects further down.
  // Declared here (above the reset effect) so they re-arm per file.
  const subAutoSelectedRef = useRef(false);
  const audioAutoSelectedRef = useRef(false);
  // Same for the external-sub fallback. An mpv `sub-add` does NOT survive a
  // loadfile, so a guard that armed once per MOUNT meant only the first
  // sub-less episode of a binge got an external subtitle: every later one
  // played bare while the menu still listed the addon's tracks as available.
  const extSubFallbackRef = useRef(false);
  // Reset per file: on episode change AND on a source switch (streamUrl change).
  // A source switch swaps the stream WITHOUT unmounting PlayerOverlay, so
  // without re-arming these one-shot pickers they keep the PREVIOUS source's
  // tracks and never re-apply the language defaults to the new file — observed
  // as switching sources selecting the file's default (e.g. Russian) audio
  // instead of the preferred English. selectedSubId is cleared for the same
  // reason (a stale id must not match a different track after the swap).
  useEffect(() => {
    setSelectedSubId(null);
    subAutoSelectedRef.current = false;
    audioAutoSelectedRef.current = false;
    extSubFallbackRef.current = false;
    // `reloadNonce`: an in-place reload re-runs loadfile, which drops the
    // sub-add'd external track and reverts aid / sid to the file's defaults.
    // These guards have to re-arm for it too, or the user's language picks are
    // silently lost for the rest of the episode. Note the delay / sub-speed
    // reset effect above deliberately does NOT take this dep: those are mpv
    // options that survive loadfile, and a Live Sync correction made for THIS
    // release should survive a reload of the same release.
  }, [activeTarget?.id, streamUrl, reloadNonce]);

  // Embedded MPV subtitle tracks (in-file + any sub-add'd via the
  // OpenSubtitles picker). The external addon list is merged in below.
  const embeddedSubTracks = useMemo(
    () => tracks.filter((t) => t.type === "sub"),
    [tracks],
  );

  // ── Subtitle auto-select: prefer Full over Signs & Songs ─────────
  // MPV's automatic track selection uses `slang` (set by us via
  // `apply_lang_defaults`) plus the file's default/forced flags. For
  // anime, that frequently picks the "Signs & Songs" forced track —
  // a partial subtitle covering only on-screen text, NOT the dialogue.
  // Once tracks are populated for a session we walk them and switch
  // to the best match: matching `slang`, with a title that doesn't
  // suggest a partial / forced / signs-only track. Runs once per file
  // (subAutoSelectedRef is declared + re-armed above on episode change /
  // source switch / unmount).
  useEffect(() => {
    if (subAutoSelectedRef.current) return;
    // Persisted "off" — user previously disabled subs for this title.
    // Hide them and bail out before any auto-select runs.
    if ((preferredSubLang ?? "").toLowerCase() === "off") {
      subAutoSelectedRef.current = true;
      invoke("set_subtitle_visibility", { visible: false }).catch(() => {});
      setSubsMuted(true);
      return;
    }
    if (embeddedSubTracks.length === 0) return;

    const isPartialTitle = (title: string | null | undefined) => {
      if (!title) return false;
      const lower = title.toLowerCase();
      return /\b(sign|song|forced|partial)/i.test(lower);
    };
    const pref = (preferredSubLang ?? "en").toLowerCase();

    const scored = embeddedSubTracks.map((t) => {
      let score = 0;
      if (subLangMatches(t.lang, pref)) score += 100;
      if (!isPartialTitle(t.title)) score += 10;
      // Tiebreaker: keep MPV's natural ordering (lower id = earlier track).
      score -= t.id * 0.001;
      return { track: t, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.track;
    if (!best) return;

    // If MPV already chose this track (or a better one we'd score
    // identically), don't fight it — just mark done.
    if (best.selected) {
      subAutoSelectedRef.current = true;
      return;
    }
    invoke("set_subtitle_track", { track: best.id })
      .then(() => {
        // Refresh tracks so `selected` reflects the new active sub.
        // No periodic polling runs anymore — see the read-once pattern
        // wired up in the tracks effect above.
        window.dispatchEvent(new Event("aura:tracks-refresh"));
      })
      .catch(() => {})
      .finally(() => { subAutoSelectedRef.current = true; });
  }, [embeddedSubTracks, preferredSubLang]);

  // ── External-sub fallback ────────────────────────────────────────
  // When the file has NO embedded subs at all but the user has
  // externals available (addon-supplied .srt/.vtt), automatically
  // sub-add the first preferred-language external — or the first one
  // outright if none match. Without this the user has to manually pop
  // open the menu every time they play a release that ships sub-less.
  //
  // Trigger: only after the initial track-list fetch has produced a
  // result (`tracks.length > 0` — any video has at least one track) AND
  // there are zero embedded sub rows. Runs once per FILE
  // (`extSubFallbackRef`, re-armed by the per-file reset effect above).
  useEffect(() => {
    if (extSubFallbackRef.current) return;
    // Live TV / trailers have no persistent subtitles — never auto-load one
    // (the upstream external-sub fetch is already skipped for both; this is
    // belt-and-braces).
    if (isLive || isTrailer) return;
    // Need the initial fetch to have produced data so an empty embedded
    // list is a real "no subs" answer rather than "we haven't fetched yet".
    if (tracks.length === 0) return;
    if (embeddedSubTracks.length > 0) return;
    if (externalSubs.length === 0) return;

    const pref = (preferredSubLang ?? "").toLowerCase();
    const match = pref
      ? externalSubs.find((s) => subLangMatches(s.lang, pref))
      : null;
    const target = match ?? externalSubs[0];
    if (!target) return;

    const title = externalTitleFor(target);
    extSubFallbackRef.current = true;
    invoke("add_subtitle_to_mpv", {
      path: target.url,
      flag: "select",
      title,
      lang: target.lang ?? null,
    })
      .then(() => window.dispatchEvent(new Event("aura:tracks-refresh")))
      .catch(() => {});
  }, [tracks.length, embeddedSubTracks.length, externalSubs, preferredSubLang, isLive, isTrailer]);

  // ── Audio auto-select ─────────────────────────────────────────────
  // Replaces the old simple lang-prefix match with the full scoring
  // algorithm in audioScoring.ts. The scorer:
  //   • hard-excludes commentary / audio-description / karaoke
  //   • normalises 3-letter / BCP-47 / language-name lang tags
  //   • expands the user's audio_priority list, swapping the literal
  //     "original" token for meta.original_language
  //   • scores each track on language match + dub disposition + region
  //     tiebreak + the file's default-flag, picks the highest
  //   • falls back gracefully when no language matches
  //
  // The `preferredAudioLang` prop (per-title override / global default)
  // is folded into the audioPriority list so per-title overrides still
  // beat the priority tokens.
  //
  // Runs once per file (audioAutoSelectedRef is declared + re-armed above on
  // episode change / source switch / unmount).
  useEffect(() => {
    if (audioAutoSelectedRef.current) return;
    if (audioTracks.length === 0) return;

    // Fold `preferredAudioLang` (per-title override or global default)
    // to the front of the priority list so explicit user picks for this
    // title beat the generic "original / en" heuristic.
    const priority: string[] = [];
    if (preferredAudioLang) priority.push(preferredAudioLang.toLowerCase());
    for (const tok of (audioPriority ?? [])) priority.push(tok);

    const meta: ScoringMeta = {
      original_language:    scoringMeta?.original_language ?? null,
      production_countries: scoringMeta?.production_countries ?? [],
      genres:               scoringMeta?.genres ?? [],
      country:              scoringMeta?.country ?? null,
    };

    const pick = pickDefaultAudio(audioTracks, meta, {
      audio_priority: priority,
      avoid_dubs:     !!avoidDubs,
      user_region:    userRegion ?? "",
    });

    // Single diagnostic log so we can see exactly what the scorer saw
    // and what it chose. Prints once per playback session.
    // eslint-disable-next-line no-console
    console.info(
      "[audio-pick] tracks=", audioTracks.map((t) => ({
        id: t.id, lang: t.lang, title: t.title, selected: t.selected,
      })),
      " priority=", priority,
      " orig_lang=", meta.original_language,
      " production=", meta.production_countries,
      " pick=", pick && { id: pick.id, lang: pick.lang, title: pick.title },
    );

    if (!pick) {
      audioAutoSelectedRef.current = true;
      return;
    }
    if (pick.selected) {
      audioAutoSelectedRef.current = true;
      return;
    }
    invoke("set_audio_track", { track: pick.id })
      .then(() => window.dispatchEvent(new Event("aura:tracks-refresh")))
      .catch(() => {})
      .finally(() => { audioAutoSelectedRef.current = true; });
  }, [audioTracks, preferredAudioLang, audioPriority, avoidDubs, userRegion, scoringMeta]);

  // Merged subtitle list — embedded tracks ++ external addon tracks.
  //
  // External entries get synthetic negative IDs and stash their URL in
  // the `codec` field. Clicking an external entry calls
  // `add_subtitle_to_mpv` first; subsequent clicks see the entry as
  // embedded and just switch the `sid`.
  //
  // Ordering (per Phase 6.1.x spec):
  //   1. embedded tracks first, in MPV's natural order
  //   2. external entries sorted by their addon's installed order
  //      (already done upstream in App.tsx) with the user's preferred
  //      subtitle language pulled to the top
  //   3. when sub-visibility=no, NOTHING is "selected" — the dropdown
  //      shows Off as the active row.
  // Friendly title used as both the dropdown label AND the title we pass
  // to MPV's `sub-add`. Keeping these in sync is what powers the dedupe
  // below: once an external entry has been sub-added, MPV reports the
  // resulting embedded track with this same title, and we filter the
  // duplicate out of the externals list.
  // Build a unique-per-row title for each external sub. The naive
  // `${addon} · ${lang}` form collides whenever an addon ships multiple
  // candidates in the same language (OpenSubtitles + SubDL frequently
  // do); the menu would then show several rows with identical titles
  // AND every row would highlight as "selected" once one of them was
  // sub-added because the title-keyed match finds the same live entry.
  // Adding a "#N" suffix to duplicates keeps the visible label concise
  // while making the matching key unique.
  const externalTitleFor = useCallback((s: ExternalSubtitle): string => {
    if (s.label) return s.label;
    const base = `${s.addon_name}${s.lang ? ` · ${s.lang.toUpperCase()}` : ""}`;
    // Count duplicates of `base` and append #N to anything past the first.
    let n = 0;
    let myIdx = 0;
    for (const other of externalSubs) {
      const otherBase = other.label
        ? other.label
        : `${other.addon_name}${other.lang ? ` · ${other.lang.toUpperCase()}` : ""}`;
      if (otherBase === base) {
        n += 1;
        if (other === s) myIdx = n;
      }
    }
    return n > 1 ? `${base} #${myIdx}` : base;
  }, [externalSubs]);

  const subDropdownItems: TrackEntry[] = useMemo(() => {
    // ── Stable ordering ────────────────────────────────────────────
    // Without this, picking an external promotes it to MPV's
    // track-list (sub-add), which moves it from the EXT section to
    // the embedded section — and the visible order shuffles every
    // time the user changes tracks.
    //
    // We keep two stable groups:
    //   1. File-embedded subs (external=false on TrackEntry) — these
    //      came from the file itself; preserve MPV's natural order.
    //   2. External addon subs — preserve the order App.tsx passed in
    //      (already addon-installed order). Sub-added externals are
    //      MATCHED back to their slot in `externalSubs` by title and
    //      replaced with the embedded TrackEntry so the row is
    //      "live" (correct id, selected state, etc.).
    //
    // The preferred-language priority sort is applied to the EXT
    // group only and uses a stable sort (Array.prototype.sort is
    // stable in modern V8), so within each preference bucket the
    // addon order is preserved.

    const fileEmbedded: TrackEntry[] = embeddedSubTracks
      .filter((t) => !t.external)
      .map((t) => ({ ...t, selected: t.selected && !subsMuted }));

    // Map sub-added (external=true on MPV side) embedded tracks by title
    // so we can swap them back into the EXT slot they originated from.
    const subAddedByTitle = new Map<string, TrackEntry>();
    for (const t of embeddedSubTracks) {
      if (t.external && t.title) {
        subAddedByTitle.set(t.title, { ...t, selected: t.selected && !subsMuted });
      }
    }
    const usedTitles = new Set<string>();

    // Externals ordering: OpenSubtitles bucket → preferred-language →
    // addon-installed order. Array.sort is stable in V8, so equal-key pairs
    // keep the addon order the Rust fan-out now guarantees. OpenSubtitles is
    // self-gating: the bucket only has members when an OpenSubtitles addon is
    // installed (the API key is unrelated — it's only for MovieHash matching).
    const isOpenSubs = (s: ExternalSubtitle) => /opensubtitles/i.test(s.addon_name);
    const prefLang = preferredSubLang ? preferredSubLang.toLowerCase() : null;
    const sortedSource = [...externalSubs].sort((a, b) => {
      const aOs = isOpenSubs(a) ? 0 : 1;
      const bOs = isOpenSubs(b) ? 0 : 1;
      if (aOs !== bOs) return aOs - bOs;
      if (prefLang) {
        const aPref = (a.lang ?? "").toLowerCase().startsWith(prefLang) ? 0 : 1;
        const bPref = (b.lang ?? "").toLowerCase().startsWith(prefLang) ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
      }
      return 0; // preserve addon order (stable sort)
    });

    const externals: TrackEntry[] = sortedSource.map((s) => {
      const title = externalTitleFor(s);
      const live = subAddedByTitle.get(title);
      // Only the FIRST external row matching a live (sub-added) title
      // gets the live entry — protects against the "click one, all four
      // light up" bug when the title mapper collides across entries.
      if (live && !usedTitles.has(title)) {
        usedTitles.add(title);
        return live;
      }
      // Synthetic id keyed on the ORIGINAL externalSubs position, NOT the
      // sorted index — a re-sort (e.g. preferredSubLang change) would
      // otherwise remap ids and make the optimistic selectedSubId highlight
      // point at the wrong row until the next reconcile.
      const originalIdx = externalSubs.indexOf(s);
      return {
        id: -1 - originalIdx,
        type: "sub",
        title,
        lang: s.lang || null,
        selected: false,
        external: true,
        codec: s.url,
      };
    });

    // Any sub-added tracks we couldn't match to an external slot
    // (e.g. user-side sub-add we don't track) get appended so they
    // remain reachable from the menu.
    const orphans: TrackEntry[] = [];
    for (const [title, t] of subAddedByTitle) {
      if (!usedTitles.has(title)) orphans.push(t);
    }

    let merged = [...fileEmbedded, ...externals, ...orphans];

    // Optional language allow-list — when the user has narrowed which
    // subtitle languages they want surfaced, drop anything outside that
    // set. Tracks with no `lang` are kept (they may be the only English
    // option that wasn't tagged) so we don't accidentally hide valid
    // subs for a poorly-tagged release.
    if (selectableSubLangs && selectableSubLangs.length > 0) {
      const allow = new Set(selectableSubLangs.map((s) => s.toLowerCase()));
      merged = merged.filter((t) => {
        if (!t.lang) return true;
        const lang = t.lang.toLowerCase();
        return [...allow].some((a) => lang.startsWith(a));
      });
    }

    // Optimistic override: when the user just picked a track, force its row
    // selected immediately. Guarded on the id still matching a visible row —
    // once an external is sub-added and swapped to its live (positive) id, the
    // negative selectedSubId no longer matches and we fall back to the
    // authoritative track-list `selected` flag. subsMuted = nothing selected.
    if (selectedSubId != null && !subsMuted && merged.some((t) => t.id === selectedSubId)) {
      merged = merged.map((t) => ({ ...t, selected: t.id === selectedSubId }));
    }

    return merged;
  }, [embeddedSubTracks, externalSubs, preferredSubLang, subsMuted, selectableSubLangs, selectedSubId]);

  // Volume scroll wheel — wired locally since the rest of the app is hidden.
  // Skipped when the wheel is over a scroll-capable child (track-menu lists,
  // the more-menu, etc.) so those can scroll their content normally.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      // Walk up the target chain — if any ancestor has overflow-y auto/scroll
      // AND content larger than its container, defer to the browser.
      let el = e.target instanceof HTMLElement ? e.target : null;
      while (el && el !== document.body) {
        const cs = window.getComputedStyle(el);
        const oy = cs.overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
          return;
        }
        el = el.parentElement;
      }
      e.preventDefault();
      const step = e.deltaY < 0 ? 5 : -5;
      const next = Math.max(0, Math.min(VOLUME_MAX, volume + step));
      commitVolume(next);
      fireToast(`Volume · ${Math.round(next)}%`);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [volume, commitVolume]);

  // Esc exits fullscreen first; if not in fullscreen, fall through to nothing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isFullscreen) {
        onToggleFullscreen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen, onToggleFullscreen]);

  // Mute toggle — keeps the device-side state in MPV land.
  const previousVolumeRef = useRef<number>(volume);
  const isMuted = volume === 0;
  const toggleMute = useCallback(() => {
    if (isMuted) {
      commitVolume(previousVolumeRef.current || 80);
    } else {
      previousVolumeRef.current = volume;
      commitVolume(0);
    }
  }, [isMuted, volume, commitVolume]);

  const VolumeIconForLevel = isMuted
    ? VolumeMuteIcon
    : volume < 50 ? VolumeMidIcon : VolumeMaxIcon;

  // Logo for buffering animation — App threads the meta's logo through
  // ActiveScrobbleTarget so we can show the same stylized art the hero
  // carousel and detail page use. Title text falls back when no logo.
  const logoForBuffer  = activeTarget?.logo ?? null;
  const titleForBuffer = activeTarget?.name ?? "";

  // ── Click interaction layer ────────────────────────────────────────
  // An invisible absolute layer behind the controls (z-0 within the
  // overlay) that captures click events on the video region. Single click
  // toggles play/pause; double click toggles fullscreen. We use a simple
  // single/double click discriminator with a 220 ms hold so dblclick wins
  // when both events fire together.
  //
  // When ANY child menu (audio/subs/speed/shader/more) or the OpenSubtitles
  // modal is open at mousedown time, we mark the upcoming click as
  // "menu-dismiss" and suppress the togglePause inside the click handler.
  // The menu's own outside-click handler closes it during the same
  // mousedown, so the user gets a single intuitive dismiss without an
  // accidental pause. A ref captures the snapshot SYNCHRONOUSLY at
  // mousedown so we don't race React's state batching for the close
  // notification.
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissNextClickRef = useRef(false);
  const handleVideoMouseDown = useCallback(() => {
    if (anyMenuOpenRef.current) {
      dismissNextClickRef.current = true;
    }
  }, []);
  const handleVideoClick = useCallback(() => {
    if (dismissNextClickRef.current) {
      dismissNextClickRef.current = false;
      // Cancel any pending single-click timer so a residual togglePause
      // from a previous click can't fire either.
      if (clickTimerRef.current) {
        clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      return;
    }
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
      return; // swallowed by upcoming dblclick
    }
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      togglePause();
    }, 220);
  }, [togglePause]);
  const handleVideoDoubleClick = useCallback(() => {
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    // If a menu was just dismissed by the first click of a double-tap,
    // don't enter fullscreen as a side-effect.
    if (dismissNextClickRef.current) {
      dismissNextClickRef.current = false;
      return;
    }
    onToggleFullscreen();
  }, [onToggleFullscreen]);

  return (
    <MenuTrackerCtx.Provider value={menuTracker}>
    <div
      className="fixed inset-0 z-[9999] pointer-events-none"
      style={{ background: "transparent" }}
    >
      {/* ── Invisible click layer — captures clicks on the video region.
              Single click → play/pause, double click → fullscreen. Sits
              BELOW the buffering overlay and the control bar in DOM order
              so children intercept before reaching this layer. ── */}
      <div
        aria-hidden
        onMouseDown={handleVideoMouseDown}
        onClick={handleVideoClick}
        onDoubleClick={handleVideoDoubleClick}
        className="absolute inset-0 pointer-events-auto cursor-pointer"
        style={{ background: "transparent" }}
      />

      {/* ── Status overlay — covers the player whenever it isn't
              actively progressing through the file:
                • before MPV emits a duration (still demuxing / negotiating
                  the stream): "Loading"
                • before the first frame has actually rendered (loadfile is
                  done, but cache-pause-initial / paused-for-cache is still
                  filling): "Loading"
                • cache stall mid-playback (`paused-for-cache`): "Buffering"
              Manual user pause is NOT covered (intentional pause shouldn't
              hide the frame the user is looking at). ── */}
      <BufferingOverlay
        show={!firstFrameSeen || buffering || seekLoading || isTrailerResolving}
        statusText={isTrailerResolving ? "Switching quality" : !firstFrameSeen ? "Loading" : buffering ? "Buffering" : "Seeking"}
        bufferPct={bufferPct}
        title={titleForBuffer}
        logo={logoForBuffer}
      />

      {/* ── Transient toast — fires for control changes via `fireToast()` ── */}
      {toast && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-30 pointer-events-none
                     px-5 py-2.5 rounded-full
                     aura-glass-menu
                     text-white text-[14px] font-medium tracking-wide
                     shadow-glass-edge"
          style={{
            top: isFullscreen ? "10%" : "calc(10% + 36px)",
            animation: "aura-toast-pop 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            textShadow: "0 1px 4px rgba(0,0,0,0.85)",
          }}
        >
          {toast}
        </div>
      )}

      {/* ── Skip-window controller — owns auto-skip, prompt toast, and
              the global `x` / Shift+X keybinds. Renders nothing when no
              skip window is active or when the active window is in
              auto mode. Mounted at the player root (not in the bottom
              control bar) so its keybinds stay alive even when the
              control bar fades out. ── */}
      <SkipController
        time={time}
        seekAbsolute={seekAbsolute}
        isFullscreen={isFullscreen}
        streamUrl={streamUrl}
        controlsVisible={controlsVisible}
        ready={tracksReady}
      />

      {/* ── Top scrim — gradient fade from black to transparent so the
              title + episode info stay readable over bright backgrounds
              (e.g. anime opening sky shots). Sits BEHIND the title bar
              (z-0) and fades with the controls. ── */}
      <div
        className="absolute inset-x-0 top-0 h-40 pointer-events-none transition-opacity duration-500 ease-in-out"
        style={{
          opacity: controlsVisible ? 1 : 0,
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.65) 0%, rgba(0,0,0,0.45) 35%, rgba(0,0,0,0.0) 100%)",
        }}
      />

      {/* ── Top bar: exit playback + prominent title + (optional) episode ──
              In windowed mode the Aura TitleBar (36 px) sits above this
              overlay. We push the controls down to 4 + 36 = 40 px so they
              don't overlap. In fullscreen the TitleBar is unmounted, so
              we revert to a clean 16 px inset. */}
      <div
        className={`absolute left-4 right-4 flex items-start gap-4
                    pointer-events-auto transition-opacity duration-300`}
        style={{
          opacity: controlsVisible ? 1 : 0,
          top: isFullscreen ? 16 : 16 + 36,
        }}
      >
        <button
          onClick={onExitPlayback}
          aria-label="Exit playback"
          className="flex-shrink-0 mt-0.5 flex items-center gap-2 px-3 h-9 rounded-full
                     bg-black/97 backdrop-blur-xl border border-white/30
                     text-white/85 hover:text-white text-xs font-semibold tracking-[0.14em] uppercase
                     transition-colors"
        >
          <ExitIcon />
          <span>Exit playback</span>
        </button>
        {activeTarget && (
          <div className="flex-1 min-w-0 flex flex-col gap-0.5 select-none">
            <h1
              className="text-white text-2xl font-semibold tracking-tight leading-[1.1] truncate"
              style={{ textShadow: "0 2px 12px rgba(0,0,0,0.9), 0 0 24px rgba(0,0,0,0.55)" }}
            >
              {activeTarget.name}
            </h1>
            {(activeTarget.episode || activeTarget.episode_title) && (
              <p
                className="text-white/85 text-[13.5px] font-medium tracking-[0.02em] truncate"
                style={{ textShadow: "0 1px 6px rgba(0,0,0,0.92)" }}
              >
                {activeTarget.episode && (
                  <span className="font-mono text-ln-accent/90 mr-2">
                    {activeTarget.episode}
                    {/* Absolute-episode annotation on a saga show that uses
                        per-season numbering (empty otherwise). absolute_episode_num
                        is stamped by App's target enrichment for season > 1. */}
                    {(() => {
                      const tag = formatAbsoluteEpisode(
                        activeTarget.series_id ?? activeTarget.id,
                        activeTarget.episode_num,
                        activeTarget.absolute_episode_num,
                      );
                      return tag ? <span className="text-white/45 ml-1.5">{tag}</span> : null;
                    })()}
                  </span>
                )}
                {activeTarget.episode_title && (
                  <span className="text-white/85">{activeTarget.episode_title}</span>
                )}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Bottom gradient vignette — darkens bright video behind the control bar */}
      <div
        className="absolute inset-x-0 bottom-0 h-56 pointer-events-none"
        style={{
          opacity: controlsVisible ? 1 : 0,
          transition: "opacity 500ms ease-in-out",
          background: "linear-gradient(to top, rgba(0,0,0,0.75) 0%, transparent 100%)",
        }}
      />

      {/* ── Bottom: control bar ── */}
      <div
        className="absolute inset-x-0 bottom-6 flex justify-center px-6
                   pointer-events-none transition-opacity duration-500 ease-in-out"
        style={{ opacity: controlsVisible ? 1 : 0 }}
      >
        <div
          className="aura-glass-bar rounded-2xl px-4 pt-2 pb-3 w-full max-w-[1100px]
                     pointer-events-auto"
        >
          {/* ── Scrubber (full-width row). VOD gets the full thumbnail
              scrubber; Live TV gets the DVR scrubber (rewind within the
              demuxer back-buffer, "Go Live" to snap back to the edge). ── */}
          {!isLive && (
            <div
              className={`px-1.5 pt-0.5 ${partyFollower ? "pointer-events-none opacity-60" : ""}`}
              onMouseEnter={() => setScrubberHovered(true)}
              onMouseLeave={() => setScrubberHovered(false)}
            >
              <Scrubber
                value={displayTime}
                max={duration || 1}
                onScrubStart={() => setScrubValue(time)}
                onScrub={(v) => setScrubValue(v)}
                onScrubEnd={(v) => {
                  seekAbsolute(v);
                  setScrubValue(null);
                }}
                progressPct={progress}
                segments={skipWindowsForScrub}
                thumbnailAt={
                  // Trailers play off a googlevideo CDN URL that ffmpeg can't
                  // reliably seek/range-probe for hover frames — skip thumbs.
                  streamUrl && !isTrailer
                    ? (sec) =>
                        invoke<{ data_url: string; at: number } | null>("extract_thumbnail", {
                          url: streamUrl,
                          atSeconds: sec,
                        }).catch(() => null)
                    : undefined
                }
              />
            </div>
          )}
          {isLive && (
            // Defensive: a party follower is never on Live TV (live reports a
            // null videoKey ⇒ never in sync ⇒ partyFollower stays false), but
            // disable the DVR scrubber under the flag anyway for consistency.
            <div
              className={partyFollower ? "pointer-events-none opacity-60" : ""}
              onMouseEnter={() => setScrubberHovered(true)}
              onMouseLeave={() => setScrubberHovered(false)}
            >
              <LiveScrubber
                windowStart={dvr.windowStart}
                edge={dvr.edge}
                position={dvr.position}
                atLive={dvr.atLive}
                onSeek={(t) => seekAbsolute(t)}
                onGoLive={goLive}
              />
            </div>
          )}

          {/* ── Button row — order: Rewind ▶ Play/Pause ▶ Forward ── */}
          {/* gap-1.5 (6 px) keeps the row tight; pill buttons (Speed,
              Shader) carry less horizontal padding (px-2.5 vs px-3)
              so they don't visually bloat against the round neighbours
              and the rhythm stays even across the bar. */}
          <div className="flex items-center gap-1.5 mt-1">
            {/* Back-10 is available for Live TV too — it rewinds within the
                demuxer back-buffer (the DVR window). Forward-10 only shows
                when behind live (catching up toward the edge); at the live
                edge there's nothing ahead to seek into. */}
            <div className={`flex items-center gap-1.5 ${partyFollower ? "opacity-[0.45] pointer-events-none" : ""}`}>
              <IconButton
                onClick={() => seekRelative(-10)}
                label="Skip back 10 seconds"
                tooltip="Back 10 s"
              >
                <ReplayIcon />
              </IconButton>

              <Tooltip text={paused ? "Play (Space)" : "Pause (Space)"} pos="top">
                <button
                  onClick={togglePause}
                  aria-label={paused ? "Play" : "Pause"}
                  className="flex items-center justify-center w-11 h-11 rounded-full
                             bg-ln-accent/15 text-ln-accent hover:bg-ln-accent/25
                             transition-colors flex-shrink-0"
                >
                  {paused ? <PlayIcon /> : <PauseIcon />}
                </button>
              </Tooltip>

              {(!isLive || !dvr.atLive) && (
                <IconButton
                  onClick={() => seekRelative(10)}
                  label="Skip forward 10 seconds"
                  tooltip="Forward 10 s"
                >
                  <ForwardIcon />
                </IconButton>
              )}
            </div>

            {partyFollower && (
              <span className="ml-2 flex items-center gap-1 text-amber-200/85 text-[11.5px] whitespace-nowrap
                               [text-shadow:_0_1px_3px_rgba(0,0,0,0.8)]">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                     strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="4" y="11" width="16" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
                Leader controls playback
              </span>
            )}

            {/* Time display — current / total. For Live TV: a LIVE badge at
                the edge, or how far behind live when rewound into the DVR
                buffer. */}
            {isLive ? (
              dvr.atLive ? (
                <div className="ml-2 flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-red-500" style={{ boxShadow: "0 0 8px rgba(239,68,68,0.7)" }} />
                  <span className="text-red-300/90 font-semibold text-[12px] tracking-wide">LIVE</span>
                </div>
              ) : (
                <div className="ml-2 flex items-center gap-1.5 text-white/70 font-mono text-[12px] tabular-nums">
                  <span className="w-1.5 h-1.5 rounded-full bg-white/40" />
                  <span>−{fmtBehind(Math.max(0, dvr.edge - dvr.position))} behind</span>
                </div>
              )
            ) : (
              <div className="ml-2 flex items-center gap-2 text-white/85 font-mono text-[12.5px] tabular-nums">
                <span>{fmt(displayTime)}</span>
                <span className="text-white/30">/</span>
                <span className="text-white/55">{fmt(duration)}</span>
              </div>
            )}

            {/* TRAILER badge — distinguishes a trailer session from a normal
                watch (and from LIVE). Sits right after the time display. */}
            {isTrailer && (
              <div className="ml-2 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-violet-400" style={{ boxShadow: "0 0 8px rgba(167,139,250,0.7)" }} />
                <span className="text-violet-200/90 font-semibold text-[12px] tracking-wide">TRAILER</span>
              </div>
            )}

            {/* Skip-window button — surfaces inline ONLY when playback is
                currently inside a known OP/ED/Recap window, giving the user a
                one-click manual skip in addition to the Lua script's auto /
                prompt behaviour. The old "Detect" affordance was removed: skip
                detection is now fully automatic (App.tsx finishWithChapters runs
                a silencedetect fallback for any missing OP/ED). */}
            {!isLive && !isTrailer && (
              <div className={partyFollower ? "pointer-events-none opacity-[0.45]" : ""}>
                <SkipWindowButton time={time} seekAbsolute={seekAbsolute} />
              </div>
            )}

            {/* Spacer */}
            <div className="flex-1" />

            {/* Volume with hover-expanding slider */}
            <VolumeControl
              volume={volume}
              isMuted={isMuted}
              onMute={toggleMute}
              onChange={commitVolume}
              Icon={VolumeIconForLevel}
            />

            {/* Speed — disabled for a party follower (rate isn't synced, so a
                follower at a different speed would constantly drift + re-seek). */}
            <div className={partyFollower ? "pointer-events-none opacity-[0.45]" : ""}>
              <SpeedMenu speed={speed} onChange={commitSpeed} />
            </div>

            {/* Audio tracks — always render the dropdown so the dedicated
                voice-track button is present even before MPV resolves
                (it's empty-state-friendly via `emptyHint`). */}
            <TrackMenu
              label="Audio (Language)"
              tooltip="Audio language / track"
              icon={<AudioIcon />}
              tracks={audioTracks}
              allowOff={false}
              onPick={async (id) => {
                if (id == null) return;
                try {
                  await invoke("set_audio_track", { track: id });
                  window.dispatchEvent(new Event("aura:tracks-refresh"));
                  const t = audioTracks.find((x) => x.id === id);
                  fireToast(`Audio · ${t?.title ?? t?.lang?.toUpperCase() ?? `#${id}`}`);
                  // Persist the picked LANGUAGE (not the numeric id —
                  // ids change between releases) so a sibling episode
                  // or a re-watch picks the same language automatically.
                  if (activeTarget && t?.lang) {
                    setTitleState(activeTarget.media_type, titleStateKey(activeTarget), {
                      audio_lang: t.lang.toLowerCase(),
                    });
                  }
                } catch {}
              }}
              emptyHint="No audio tracks reported yet"
              delay={{
                label: "Audio sync",
                value: audioDelay,
                onMinus: () => nudgeAudioDelay(-0.1),
                onPlus:  () => nudgeAudioDelay(+0.1),
                onReset: resetAudioDelay,
              }}
            />

            {/* Subtitle tracks — embedded MPV tracks merged with external
                addon-supplied .srt/.vtt URLs. Clicking an external entry
                first sub-adds it (so MPV picks up the file) then activates. */}
            <TrackMenu
              label="Subtitles"
              tooltip="Subtitle track"
              icon={<SubsIcon />}
              tracks={subDropdownItems}
              isOff={subsMuted}
              onOff={async () => {
                // True off — hide subtitles entirely. We use sub-visibility
                // because some libmpv builds reject `sid=no` after a sub-add.
                try {
                  await invoke("set_subtitle_visibility", { visible: false });
                  setSubsMuted(true);
                  setSelectedSubId(null);
                  fireToast("Subtitles off");
                  if (activeTarget) {
                    setTitleState(activeTarget.media_type, titleStateKey(activeTarget), {
                      sub_lang: "off",
                    });
                  }
                } catch {}
              }}
              onPick={async (id) => {
                // Picking any track also re-enables visibility.
                try {
                  await invoke("set_subtitle_visibility", { visible: true });
                  setSubsMuted(false);
                } catch {}

                if (id == null) {
                  setSelectedSubId(null);
                  invoke("set_subtitle_track", { track: "no" })
                    .then(() => window.dispatchEvent(new Event("aura:tracks-refresh")))
                    .catch(() => {});
                  return;
                }
                // Negative IDs are external addon entries (synthetic
                // negative IDs we mint in `subDropdownItems`).
                if (id < 0) {
                  const ext = subDropdownItems.find((t) => t.id === id);
                  const url = ext?.codec;
                  if (!url) return;
                  // If this URL has already been sub-added in this
                  // session, MPV has an embedded track for it. Find that
                  // track by matching title and just switch to it
                  // instead of re-adding (which would create a duplicate).
                  // The dedupe in `subDropdownItems` hides the external
                  // entry once a track-refresh picks up the new embedded
                  // track, but there's a brief window before that fires.
                  const matching = embeddedSubTracks.find(
                    (e) => e.title && e.title === ext?.title,
                  );
                  if (matching) {
                    try {
                      await invoke("set_subtitle_track", { track: matching.id });
                      setSelectedSubId(matching.id);
                      window.dispatchEvent(new Event("aura:tracks-refresh"));
                      fireToast(
                        `Subtitles · ${matching.title ?? matching.lang?.toUpperCase() ?? `#${matching.id}`}`,
                      );
                      if (activeTarget && matching.lang) {
                        setTitleState(activeTarget.media_type, titleStateKey(activeTarget), {
                          sub_lang: matching.lang.toLowerCase(),
                        });
                      }
                    } catch {}
                    return;
                  }
                  try {
                    // Pass title + lang so MPV labels the new track
                    // sensibly (otherwise it auto-titles from the URL,
                    // which surfaces as e.g. "1958307247" in the
                    // dropdown). The title is also what powers the
                    // dedupe above on the next refresh.
                    await invoke("add_subtitle_to_mpv", {
                      path: url,
                      flag: "select",
                      title: ext?.title,
                      lang: ext?.lang ?? null,
                    });
                    setSelectedSubId(id); // negative menu id until the refresh swaps in the live track
                    window.dispatchEvent(new Event("aura:tracks-refresh"));
                    fireToast(`Subtitles · ${ext?.lang?.toUpperCase() ?? "external"}`);
                    if (activeTarget && ext?.lang) {
                      setTitleState(activeTarget.media_type, titleStateKey(activeTarget), {
                        sub_lang: ext.lang.toLowerCase(),
                      });
                    }
                  } catch (e) {
                    console.error("sub-add failed", e);
                  }
                  return;
                }
                try {
                  await invoke("set_subtitle_track", { track: id });
                  setSelectedSubId(id);
                  window.dispatchEvent(new Event("aura:tracks-refresh"));
                  const t = subDropdownItems.find((x) => x.id === id);
                  fireToast(`Subtitles · ${t?.title ?? t?.lang?.toUpperCase() ?? `#${id}`}`);
                  if (activeTarget && t?.lang) {
                    setTitleState(activeTarget.media_type, titleStateKey(activeTarget), {
                      sub_lang: t.lang.toLowerCase(),
                    });
                  }
                } catch {}
              }}
              emptyHint="No subtitle tracks"
              delay={{
                label: "Subtitle sync",
                value: subDelay,
                onMinus: () => nudgeSubDelay(-0.1),
                onPlus:  () => nudgeSubDelay(+0.1),
                onReset: resetSubDelay,
                onLiveSync: () => setSyncOpen(true),
              }}
            />

            {/* Subtitle styling — same six controls as Settings, inline. */}
            <SubtitleStyleMenu />

            {/* Shader / upscaler */}
            <ShaderPicker activeTarget={activeTarget} />

            {/* Panscan / fill-screen toggle — for ultrawide vs 16:9 mismatches.
                Sits just left of Fullscreen so the two screen-shape controls
                are spatially grouped. */}
            <PanscanButton activeTarget={activeTarget} />

            {/* Fullscreen */}
            <Tooltip text={isFullscreen ? "Exit fullscreen (F / Esc)" : "Fullscreen (F)"} pos="top">
              <button
                onClick={onToggleFullscreen}
                aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                className={`flex items-center justify-center w-10 h-10 rounded-full
                            transition-colors flex-shrink-0
                            ${isFullscreen
                              ? "bg-ln-accent/25 text-ln-accent"
                              : "text-white/80 hover:text-white hover:bg-white/12"}`}
              >
                {isFullscreen ? <ExitFullscreenIcon /> : <FullscreenIcon />}
              </button>
            </Tooltip>

            {/* Trailer quality — only during trailer playback. Sits left of
                the "more" menu, grouped with the other stream-shaping pills. */}
            {isTrailer && onSetTrailerQuality && (
              <TrailerQualityMenu
                quality={trailerQuality}
                label={trailerQualityLabel}
                maxHeight={trailerMaxHeight}
                resolving={isTrailerResolving}
                onSelect={onSetTrailerQuality}
              />
            )}

            {/* Three-dots / gear menu — AniSkip, Switch source, Copy link,
                Download, External player. Anchored to the far right so it reads
                as the bar's catch-all "more" affordance. */}
            <MoreMenu
              streamUrl={streamUrl}
              activeTarget={activeTarget}
              isAnime={isAnime}
              time={time}
              duration={duration}
              skipWindows={skipWindowsForScrub}
            />
          </div>
        </div>
      </div>

      {/* In-playback episode drawer — hover-right-edge trigger + the
          shared EpisodePanel (EOS Spotlight spec, Phase 4). Only mounts
          for series/anime (App passes `episodePanel` null for movies).
          Lives inside MenuTrackerCtx so its open state freezes the
          control-bar auto-hide and the overlay swallows the dismiss
          click — same as the other submenus. */}
      {episodePanel && <EpisodeEdgeTrigger {...episodePanel} controlsVisible={controlsVisible} />}

      {/* SubtitlePicker (OpenSubtitles search overlay) */}
      <SubtitlePicker
        open={subsOpen}
        initialQuery={activeTarget?.name}
        initialImdbId={
          activeTarget?.media_type === "movie" || activeTarget?.media_type === "series"
            ? activeTarget.id
            : undefined
        }
        streamUrl={streamUrl}
        onClose={() => setSubsOpen(false)}
      />

      {/* Live Subtitle Sync: cue picker. Sibling of SubtitlePicker, inside
          MenuTrackerCtx so its own `useMenuOpenSync(open)` freezes the
          control-bar auto-hide while it is up. Owns nothing: the delay, the
          drift multiplier and the first two-point anchor all live in this
          component's state so they survive the panel closing and reopening. */}
      <SubtitleSyncPanel
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        currentTime={time}
        paused={paused}
        togglePause={togglePause}
        tracks={tracks}
        streamUrl={streamUrl}
        subDelay={subDelay}
        setSubDelay={setSubDelay}
        subSpeed={subSpeed}
        setSubSpeed={setSubSpeed}
        firstAnchor={syncFirstAnchor}
        setFirstAnchor={setSyncFirstAnchor}
      />

      {/* Performance OSD */}
      <CinemaSuite
        isFullscreen={isFullscreen}
        pollGate={duration > 0 && firstFrameSeen && !buffering && !seekLoading}
      />
    </div>
    </MenuTrackerCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// Live DVR — rewind a live stream within mpv's demuxer back-buffer.
//
// We never read mpv's cache-state node property (that's the documented
// get_property-race crash path). Instead we estimate the live edge purely
// from the `time` the engine already streams plus wallclock: while we're
// riding the edge, edge==time and advances 1 s/s; once the user rewinds,
// `time` falls behind the estimate and the edge keeps growing on wallclock
// alone. A large backward jump (channel switch / stream restart) re-anchors.
//
// The window is a conservative fixed span (the engine keeps 128 MiB of back-
// buffer ≈ a few minutes; seeks past the real floor are clamped by mpv, so a
// slightly-generous window is harmless). RAM-only, freed on stop — nothing is
// persisted and nothing is stored server-side.
// ---------------------------------------------------------------------------

/** Conservative rewind window (s). The 128 MiB back-buffer holds ~2–5 min
 *  depending on bitrate; mpv clamps over-seeks, so this only bounds the UI. */
const DVR_WINDOW_S = 150;
/** Within this many seconds of the estimated edge counts as "at live". */
const DVR_EDGE_TOL_S = 6;

interface LiveDvrState {
  atLive: boolean;
  /** Estimated live-edge position, in `time` units. */
  edge: number;
  /** Earliest seekable position shown in the UI. */
  windowStart: number;
  /** Current playback position clamped to the window. */
  position: number;
}

function useLiveDvr(isLive: boolean, time: number, streamKey: string | null): LiveDvrState {
  const anchor = useRef<{ t: number; wall: number; init: boolean; key: string | null }>({
    t: 0, wall: 0, init: false, key: null,
  });
  const [state, setState] = useState<LiveDvrState>({ atLive: true, edge: 0, windowStart: 0, position: 0 });
  const lastEmit = useRef<LiveDvrState | null>(null);

  // mpv fires time-pos events many times per second; the DVR scrubber only
  // moves sub-pixel between them, so committing a fresh state object each
  // event re-rendered the whole PlayerOverlay an EXTRA time per tick (the
  // live-lag cause). Dedupe to whole-second granularity — re-emit only when a
  // visible value changes.
  const commit = (next: LiveDvrState) => {
    const prev = lastEmit.current;
    if (
      prev &&
      prev.atLive === next.atLive &&
      Math.round(prev.edge) === Math.round(next.edge) &&
      Math.round(prev.windowStart) === Math.round(next.windowStart) &&
      Math.round(prev.position) === Math.round(next.position)
    ) {
      return;
    }
    lastEmit.current = next;
    setState(next);
  };

  useEffect(() => {
    if (!isLive) {
      anchor.current.init = false;
      anchor.current.key = streamKey;
      return;
    }
    const now = Date.now() / 1000;

    // First sample, a CHANNEL SWITCH (streamKey changed — isLive stays true so
    // the !isLive reset above never fires, and a fresh channel's `time` resets
    // to ~0 which the est-relative test below can miss), or an in-channel
    // stream restart where `time` drops well below the window floor → discard
    // the prior anchor and re-anchor to the new live edge on this sample.
    const est = anchor.current.t + (now - anchor.current.wall);
    if (!anchor.current.init || anchor.current.key !== streamKey || time < est - DVR_WINDOW_S - 60) {
      anchor.current = { t: time, wall: now, init: true, key: streamKey };
      commit({
        atLive: true,
        edge: time,
        windowStart: Math.max(0, time - DVR_WINDOW_S),
        position: time,
      });
      return;
    }

    const atLive = time >= est - DVR_EDGE_TOL_S;
    // Advance the edge anchor ONLY for a genuinely NEWER live frame (time
    // beyond the wallclock estimate), never just because we're near the edge.
    // Re-anchoring on "near" collapsed the estimate backward after a Go-Live
    // seek to (edge − 3): that seeked position is within tolerance, so it used
    // to reset edge = edge − 3, and each repeated click walked the edge (and
    // the seek target) backward toward the start of the stream. Keeping the
    // edge monotonic means Go Live always targets the true live frontier.
    if (time > est) {
      anchor.current = { t: time, wall: now, init: true, key: streamKey };
    }
    const edge = anchor.current.t + (now - anchor.current.wall);
    commit({
      atLive,
      edge,
      windowStart: Math.max(0, edge - DVR_WINDOW_S),
      position: Math.min(Math.max(time, 0), edge),
    });
  }, [isLive, time, streamKey]);

  return state;
}

/** Live DVR scrub bar: a red fill from the window start to the current
 *  position, a draggable thumb, and a Live pill that snaps back to the edge.
 *  Seeks are committed on pointer-up (no seek-storm). */
function LiveScrubber({
  windowStart,
  edge,
  position,
  atLive,
  onSeek,
  onGoLive,
}: {
  windowStart: number;
  edge: number;
  position: number;
  atLive: boolean;
  onSeek: (t: number) => void;
  onGoLive: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const span = Math.max(1, edge - windowStart);
  const shown = drag ?? position;
  const pct = Math.max(0, Math.min(100, ((shown - windowStart) / span) * 100));

  const timeAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return position;
    const r = el.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return windowStart + f * span;
  };

  return (
    <div className="flex items-center gap-2.5 px-1.5 pt-0.5">
      <div
        ref={trackRef}
        className="group relative flex-1 h-1.5 rounded-full bg-white/15 cursor-pointer"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          setDrag(timeAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (drag != null) setDrag(timeAt(e.clientX));
        }}
        onPointerUp={(e) => {
          const t = drag ?? timeAt(e.clientX);
          setDrag(null);
          onSeek(t);
        }}
      >
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-red-500/80"
          style={{ width: `${pct}%` }}
        />
        <span
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full
                     bg-white shadow opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ left: `${pct}%` }}
        />
      </div>
      <button
        type="button"
        onClick={onGoLive}
        aria-label="Go to live edge"
        title={atLive ? "Live" : "Go to live"}
        className={[
          "flex items-center gap-1.5 px-2.5 h-6 rounded-full text-[11px] font-semibold tracking-wide transition-colors flex-shrink-0",
          atLive
            ? "bg-red-500/15 text-red-300/90 cursor-default"
            : "bg-white/8 text-white/70 hover:bg-white/15 hover:text-white",
        ].join(" ")}
      >
        <span
          className={["w-2 h-2 rounded-full", atLive ? "bg-red-500" : "bg-white/40"].join(" ")}
          style={atLive ? { boxShadow: "0 0 8px rgba(239,68,68,0.7)" } : undefined}
        />
        {atLive ? "LIVE" : "GO LIVE"}
      </button>
    </div>
  );
}

/** Compact "behind live" offset — "8s", "1:23", "12:05". */
function fmtBehind(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Scrubber — animated gradient progress + draggable thumb.
// ---------------------------------------------------------------------------

/** A scrub-bar preview frame. Either a standalone image (`src` only)
 *  or a crop from a BIF / WebVTT sprite sheet (`src` + sprite rect, in
 *  device px). This is the stable contract the thumbnail-source layer
 *  (ROADMAP / task #11) resolves into; the Scrubber renders it with a
 *  loading animation until the underlying image actually loads. */
function Scrubber({
  value, max, progressPct, onScrubStart, onScrub, onScrubEnd, segments,
  thumbnailAt,
}: {
  value: number;
  max: number;
  progressPct: number;
  onScrubStart: () => void;
  onScrub: (v: number) => void;
  onScrubEnd: (v: number) => void;
  /** AniSkip OP/ED/recap windows for the current episode. Rendered as
   *  amber bands overlaid on the scrub fill so the user can see where
   *  skip boundaries land. Hovering shows the kind + timestamps. */
  segments?: AuraSkipWindow[];
  /** Async resolver: returns the data URL + the ACTUAL `playback-time`
   *  at which mpv produced the frame, or null when none is available
   *  (extraction failed / no engine). Optional — when absent the
   *  scrubber still shows the timestamp tooltip on hover, just no
   *  image. Wired by PlayerOverlay to the native `extract_thumbnail`
   *  libmpv engine. Reporting `at` lets us cache at the frame's real
   *  second so an immediate re-hover at the same second hits the cache
   *  instead of re-paying the seek+screenshot cost. */
  thumbnailAt?: (seconds: number) => Promise<{ data_url: string; at: number } | null>;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  // Hovered segment + cursor x in track-relative px so the tooltip
  // can anchor near the pointer instead of jumping band-to-band on
  // wide windows. Updated on segment-band pointer move; cleared on
  // band leave AND on full-track leave.
  const [hoveredSegment, setHoveredSegment] = useState<{
    seg: AuraSkipWindow;
    leftPct: number;
  } | null>(null);

  // Hover thumbnails are always on (the toggle was removed — low
  // resource cost, good UX). The frame box still only renders when an
  // engine is wired AND a frame resolves/loads.
  // Seconds at the cursor (null when not hovering). Drives the always-
  // on timestamp tooltip and the debounced frame lookup.
  const hoverSec = hoverPct != null ? (hoverPct / 100) * max : null;
  // Integer-second bucket. The fetch debounce keys on THIS, not the
  // float `hoverSec`, so sub-second mouse moves WITHIN the same integer
  // second don't reset the 220 ms timer. Earlier code keyed the effect
  // dep on `hoverSec` directly, which meant every pointermove (every
  // ~8-16 ms) re-ran the effect, the cleanup cancelled the pending
  // 220 ms timer, and a fresh timer was scheduled — so as long as the
  // user kept moving (even slowly) the timer NEVER fired and no fetch
  // was issued. The visible symptom was "the displayed thumb only
  // updates when the mouse leaves and re-enters the bar": leaving
  // cleared `hoverSec` (separate effect below), re-entering populated
  // a fresh `hoverSec` once → effect ran → timer fired → fetch
  // succeeded → new thumb displayed. Bucketing the dep on `Math.floor`
  // is the minimal correct fix: continuous hovering WITHIN an integer
  // second leaves the timer alone (it fires after 220 ms), and only
  // CROSSING an integer-second boundary cancels and re-schedules.
  const hoverIntSec = hoverSec != null ? Math.max(0, Math.floor(hoverSec)) : null;

  // Async hover-thumbnail resolution. The engine (native libmpv
  // screenshot) is slow + serialised, so we DEBOUNCE on hover-settle,
  // single-flight via a request id, and cache per integer-second. The
  // stale frame is cleared the instant the target second changes, so
  // the loading animation shows — never the previous frame.
  const thumbnailAtRef = useRef(thumbnailAt);
  useEffect(() => { thumbnailAtRef.current = thumbnailAt; }, [thumbnailAt]);
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  // The integer-second the current `thumbUrl` corresponds to (the sec
  // for which the cached/fetched thumb was set). The render gates the
  // <img> on `thumbUrlSec === hoverIntSec` so a stale URL — left over
  // while the new fetch is in flight, OR carried briefly because React
  // hasn't committed the setThumbUrl(null) yet, OR re-set by a late-
  // arriving superseded .then — can never paint on top of a different
  // hover position. Symptom this fixes: "after a thumb generates, the
  // OLD thumb is shown for 1-2 s when moving to a new second before
  // the new one resolves" (the user-reported regression after 837f850
  // switched the effect dep to hoverIntSec). With this gate the user
  // sees the loader during fetch latency, never a stale frame.
  const [thumbUrlSec, setThumbUrlSec] = useState<number | null>(null);
  const [thumbBusy, setThumbBusy] = useState(false);
  const thumbReqRef = useRef(0);
  // Escalating loader copy. A cold extraction can take several seconds — the
  // warm FFI engine burns its seek/restart timeouts BEFORE the ffmpeg-per-hover
  // fallback even starts — so a bare spinner reads as frozen. Staged off the
  // same hoverIntSec lifecycle as the fetch: 0 = spinner only (fast hovers stay
  // clean), then a label steps up as the wait grows so the user sees it's still
  // working rather than stuck.
  const [thumbLoaderStage, setThumbLoaderStage] = useState(0);

  useEffect(() => {
    // Bump reqId FIRST so any in-flight `.then` from a prior effect run sees a
    // mismatch and discards — the supersession guard that stops a late fetch
    // painting over a newer hover.
    const reqId = ++thumbReqRef.current;
    if (!thumbnailAtRef.current || hoverIntSec == null) return;
    const sec = hoverIntSec;
    // Always extract a FRESH frame for this second — no cache, no recycled or
    // approximate frames (those showed a far-off "wrong" frame). Drop the prior
    // frame immediately (+ thumbUrlSec=null) so the loader shows during fetch
    // latency, never the previous second's image.
    setThumbUrl(null);
    setThumbUrlSec(null);
    setThumbBusy(true);
    const timer = setTimeout(() => {
      const fn = thumbnailAtRef.current;
      if (!fn) { setThumbBusy(false); return; }
      fn(sec)
        .then((res) => {
          if (reqId !== thumbReqRef.current) return; // superseded
          if (res) {
            setThumbUrl(res.data_url);
            setThumbUrlSec(sec);
          } else {
            setThumbUrl(null);
            setThumbUrlSec(null);
          }
          setThumbBusy(false);
        })
        .catch(() => {
          if (reqId !== thumbReqRef.current) return;
          setThumbUrl(null);
          setThumbUrlSec(null);
          setThumbBusy(false);
        });
    }, 220);
    return () => clearTimeout(timer);
  }, [hoverIntSec]);

  // Drive the escalating loader copy off the same per-second lifecycle as the
  // fetch: reset on each new hovered second, then step the label up as the wait
  // grows (2.5 s → "Generating preview", 9 s → "Slow stream, still working").
  useEffect(() => {
    setThumbLoaderStage(0);
    if (hoverIntSec == null) return;
    const t1 = window.setTimeout(() => setThumbLoaderStage(1), 2500);
    const t2 = window.setTimeout(() => setThumbLoaderStage(2), 9000);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, [hoverIntSec]);

  // Leaving the track: invalidate any in-flight request and clear.
  useEffect(() => {
    if (hoverSec == null) {
      thumbReqRef.current += 1;
      setThumbUrl(null);
      setThumbUrlSec(null);
      setThumbBusy(false);
    }
  }, [hoverSec]);

  const pctFromEvent = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    onScrubStart();
    onScrub(pctFromEvent(e.clientX) * max);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const pct = pctFromEvent(e.clientX) * 100;
    setHoverPct(pct);
    // OP/ED segment hover is driven from the cursor's X across the
    // FULL track height — the same vertical leeway the thumbnail
    // already gets — rather than the 4px band's own pointer events
    // (which demanded pixel-perfect aim on the bar). `drawableSegments`
    // is initialised by render time; this only runs on pointer events.
    const hit = drawableSegments.find(
      (s) => pct >= s.leftPct && pct <= s.leftPct + s.widthPct,
    );
    setHoveredSegment(
      hit ? { seg: hit, leftPct: hit.leftPct + hit.widthPct / 2 } : null,
    );
    if (!dragging) return;
    onScrub(pctFromEvent(e.clientX) * max);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setDragging(false);
    onScrubEnd(pctFromEvent(e.clientX) * max);
  };

  // Format mm:ss / h:mm:ss for the tooltip timestamps.
  const fmtTime = (sec: number): string => {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  // Filter segments to those that are within-duration AND have a
  // sane width — guards against malformed AniSkip rows (start > end,
  // negative timestamps, end past duration) that would otherwise
  // render as garbled bands extending off the track. Important:
  // bail entirely when max ≤ 1 — that's the duration=0 fallback in
  // the parent's `max || 1`, and any segment computed against it
  // would render at thousands-of-percent left offsets that escape
  // the scrub track horizontally.
  const drawableSegments = useMemo(() => {
    if (!segments || max <= 1) return [];
    return segments
      .filter((s) => s.end > s.start && s.end > 0 && s.start < max)
      .map((s) => {
        // Clamp end to the track's right edge so windows that extend
        // past `max` (rare but real — AniSkip submitters sometimes
        // record an `endTime` slightly past the actual runtime) stop
        // at 100% instead of continuing into the void.
        const clampedStart = Math.max(0, s.start);
        const clampedEnd   = Math.min(max, s.end);
        const leftPct  = Math.max(0, Math.min(100, (clampedStart / max) * 100));
        const widthPct = Math.max(0, Math.min(100 - leftPct, ((clampedEnd - clampedStart) / max) * 100));
        return { ...s, leftPct, widthPct };
      })
      .filter((s) => s.widthPct > 0.05);
  }, [segments, max]);

  // Band colours — amber regardless of mode (the user wants a
  // single recognisable colour); slightly higher opacity when auto-
  // skip is armed so the user knows the bar will fire automatically
  // there. Mounted ABOVE the gradient scrub fill so the band stays
  // visible while the fill animates underneath.
  const bandClassFor = (auto: boolean) =>
    auto
      ? "bg-amber-400/85 shadow-[0_0_6px_rgba(251,191,36,0.55)]"
      : "bg-amber-400/65";

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => { setHoverPct(null); setHoveredSegment(null); }}
      className="relative h-6 flex items-center group cursor-pointer select-none"
    >
      {/* Track (background) */}
      <div className="absolute inset-x-0 h-1 rounded-full bg-white/15 group-hover:h-1.5 transition-all duration-150" />

      {/* Hover preview — a dim segment from 0 → cursor position */}
      {hoverPct != null && (
        <div
          aria-hidden
          className="absolute h-1 rounded-full bg-white/25 group-hover:h-1.5 transition-all duration-150"
          style={{ left: 0, width: `${hoverPct}%` }}
        />
      )}

      {/* Filled portion — animated gradient */}
      <div
        aria-hidden
        className="aura-scrub-fill absolute h-1 rounded-full group-hover:h-1.5 transition-[height] duration-150"
        style={{ left: 0, width: `${progressPct}%` }}
      />

      {/* AniSkip segment bands — rendered above the fill so the amber
          stands out against the green gradient. Purely visual now
          (aria-hidden, pointer-events handled by the track): hover
          detection is driven by the track's onPointerMove against the
          cursor X, so the OP/ED tooltip triggers anywhere in the full
          24px track height — same leeway as the frame thumbnail —
          instead of demanding pixel-perfect aim on this 4px sliver. */}
      {drawableSegments.map((s, i) => (
        <div
          key={`${s.type}:${s.start}:${i}`}
          aria-hidden
          className={`absolute h-1 rounded-full group-hover:h-1.5 transition-all duration-150 pointer-events-none ${bandClassFor(s.auto)}`}
          style={{ left: `${s.leftPct}%`, width: `${s.widthPct}%` }}
        />
      ))}

      {/* Thumb */}
      <div
        aria-hidden
        className="absolute w-3.5 h-3.5 rounded-full bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.5),0_2px_8px_rgba(0,0,0,0.5)]
                   transition-transform duration-150
                   group-hover:scale-110"
        style={{
          left: `calc(${progressPct}% - 7px)`,
          opacity: dragging || progressPct > 0 ? 1 : 0,
        }}
      />

      {/* Unified hover popover — one cursor-anchored column that grows
          UPWARD (bottom-full + flex-col, so the first child sits
          highest). Order: skip-segment details (when hovering a band)
          ABOVE the frame preview ABOVE the always-visible timestamp —
          so the segment info never covers the thumbnail, it stacks on
          top of it (the requested behaviour). The stale frame is
          cleared the instant the target second changes (debounce effect
          above) so the loading animation shows, never the prior frame. */}
      {hoverSec != null && (
        <div
          className="absolute bottom-full mb-3 pointer-events-none z-10
                     flex flex-col items-center gap-1.5"
          style={{ left: `${hoverPct}%`, transform: "translateX(-50%)" }}
        >
          {hoveredSegment && (
            <div className="aura-glass-menu rounded-md px-3 py-2 text-[11.5px] min-w-[160px]">
              <div className="text-white font-semibold tracking-wide">
                {skipKindLabel(hoveredSegment.seg.type)}
                {hoveredSegment.seg.type === "mixed-op" && (
                  <span className="text-white/45 font-normal ml-1.5">(mixed)</span>
                )}
              </div>
              <div className="text-white/75 font-mono tabular-nums mt-0.5">
                {fmtTime(hoveredSegment.seg.start)} – {fmtTime(hoveredSegment.seg.end)}
              </div>
              <div className="text-white/45 text-[10px] mt-0.5">
                {(hoveredSegment.seg.end - hoveredSegment.seg.start).toFixed(1)}s
                {hoveredSegment.seg.source && hoveredSegment.seg.source !== "aniskip" && (
                  <span className="ml-2">· source: {hoveredSegment.seg.source}</span>
                )}
                {hoveredSegment.seg.auto && (
                  <span className="ml-2 text-amber-300/80">· auto-skip</span>
                )}
              </div>
            </div>
          )}
          {thumbnailAt && (thumbUrl || thumbBusy) && (
            <div className="relative w-40 aspect-video rounded-md overflow-hidden
                            aura-glass-menu shadow-[0_8px_24px_-8px_rgba(0,0,0,0.7)]">
              {/* Gate the <img> on thumbUrlSec === hoverIntSec so a stale URL
                  (a prior sec's fetch resolving after the user moved) NEVER
                  paints over a new hover — the loader fills that gap. Each
                  hover extracts a fresh frame; no cached/approximate frames. */}
              {thumbUrl && thumbUrlSec === hoverIntSec ? (
                <img
                  src={thumbUrl}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5">
                  <div className="absolute inset-0 bg-white/5 animate-pulse" />
                  <svg
                    className="relative w-5 h-5 animate-spin text-white/70"
                    viewBox="0 0 24 24" fill="none" aria-hidden
                  >
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  {thumbLoaderStage > 0 && (
                    <span className="relative text-white/60 text-[9px] leading-tight tracking-wide px-2 text-center">
                      {thumbLoaderStage === 1 ? "Generating preview…" : "Slow stream, still working…"}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="aura-glass-menu rounded px-2 py-0.5 text-[11px]
                          font-mono tabular-nums text-white/90">
            {fmtTime(hoverSec)}
          </div>
        </div>
      )}

      <span className="sr-only">{Math.round(value)} of {Math.round(max)} seconds</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VolumeControl — icon button + slider that expands on hover/focus.
// ---------------------------------------------------------------------------

function VolumeControl({
  volume, isMuted, onMute, onChange, Icon,
}: {
  volume: number;
  isMuted: boolean;
  onMute: () => void;
  onChange: (v: number) => void;
  Icon: React.FC;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useMenuOpenSync(open);

  const pctFromEvent = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  // Hover-open with a small grace period on leave so brief cursor exits
  // (e.g. crossing the gap between button and popover) don't snap shut.
  const onEnter = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    setOpen(true);
  };
  const onLeave = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), 220);
  };

  // The popover sits ABOVE the button (absolute, bottom-full) — that means
  // expanding it can never push neighbouring buttons. The button itself
  // stays in flex flow at a fixed 40 px width.
  return (
    <div
      ref={wrapRef}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className="relative flex items-center flex-shrink-0"
    >
      <Tooltip text={isMuted ? "Unmute (M)" : "Mute (M)"} pos="top">
        <button
          onClick={onMute}
          aria-label={isMuted ? "Unmute" : "Mute"}
          className="flex items-center justify-center w-10 h-10 rounded-full
                     text-white/80 hover:text-white hover:bg-white/12 transition-colors"
        >
          <Icon />
        </button>
      </Tooltip>

      {open && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50
                     aura-glass-menu
                     rounded-full shadow-glass-edge px-3 py-2"
          onMouseEnter={onEnter}
          onMouseLeave={onLeave}
        >
          {/* Vertical-ish slider — stays compact; the user requested the
              wheel/keyboard work too, both wired at the overlay level. */}
          <div
            ref={trackRef}
            onPointerDown={(e) => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              onChange(Math.round(pctFromEvent(e.clientX) * VOLUME_MAX));
            }}
            onPointerMove={(e) => {
              if (e.buttons & 1) onChange(Math.round(pctFromEvent(e.clientX) * VOLUME_MAX));
            }}
            className="relative h-5 flex items-center cursor-pointer w-32"
          >
            <div className="absolute inset-x-0 h-1 rounded-full bg-white/15" />
            {/* Tick at the 100% (unity-gain) point so the boost zone is obvious. */}
            <div
              aria-hidden
              className="absolute top-1/2 -translate-y-1/2 w-px h-2.5 bg-white/35"
              style={{ left: `${(100 / VOLUME_MAX) * 100}%` }}
            />
            <div
              aria-hidden
              className={`absolute left-0 h-1 rounded-full ${volume > 100 ? "bg-ln-accent" : "bg-white/85"}`}
              style={{ width: `${(volume / VOLUME_MAX) * 100}%` }}
            />
            <div
              aria-hidden
              className="absolute w-3 h-3 rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
              style={{ left: `calc(${(volume / VOLUME_MAX) * 100}% - 6px)` }}
            />
          </div>
          <div className="text-center text-[10px] font-mono text-white/55 tabular-nums mt-1">
            {Math.round(volume)}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SpeedMenu — discrete-stop dropdown 0.5x → 5x with 0.25 increments.
// ---------------------------------------------------------------------------

function SpeedMenu({
  speed, onChange,
}: {
  speed: number;
  onChange: (v: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMenuOpenSync(open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const label = speed === 1 ? "1×" : `${speed}×`;
  const isCustom = !SPEED_OPTIONS.includes(speed);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <Tooltip text="Playback speed" pos="top">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Playback speed"
          className={`flex items-center gap-1.5 px-2.5 h-10 rounded-full
                      transition-colors
                      ${open || speed !== 1
                        ? "bg-ln-accent/20 text-ln-accent"
                        : "text-white/80 hover:text-white hover:bg-white/12"
                      }`}
        >
          <SpeedIcon />
          <span className="font-mono text-[12px] tabular-nums tracking-wider">
            {label}
          </span>
        </button>
      </Tooltip>

      {open && (
        <div className="absolute bottom-full mb-2 right-0 min-w-[110px]
                        rounded-xl py-1.5 z-50
                        aura-glass-menu
                        shadow-glass-edge max-h-[280px] overflow-y-auto">
          {SPEED_OPTIONS.map((s) => (
            <button
              key={s}
              onClick={() => {
                onChange(s);
                fireToast(`Speed · ${s}×`);
              }}
              className={`w-full flex items-center justify-between px-4 py-1.5 text-[13px]
                          transition-colors font-mono tabular-nums
                          ${s === speed
                            ? "text-ln-accent bg-ln-accent/10"
                            : "text-white/75 hover:text-white hover:bg-white/[0.16]"
                          }`}
            >
              <span>{s}×</span>
              {s === 1 && <span className="text-[10px] text-white/35">normal</span>}
            </button>
          ))}
          {isCustom && (
            <div className="px-4 py-1.5 text-[10px] text-white/35 font-mono">
              custom: {speed}×
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Sliders / "tune" glyph for the trailer quality pill.
const QualityIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
  </svg>
);

const TRAILER_QUALITY_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "2160", label: "4K" },
  { value: "1440", label: "1440p" },
  { value: "1080", label: "1080p" },
  { value: "720",  label: "720p" },
];

// ---------------------------------------------------------------------------
// TrailerQualityMenu — pill (mirrors SpeedMenu) shown ONLY during trailer
// playback. The button shows the resolved quality (e.g. "1080p"); picking a
// rung re-resolves via yt-dlp and swaps in place at the current playhead.
// ---------------------------------------------------------------------------
function TrailerQualityMenu({
  quality, label, maxHeight, resolving, onSelect,
}: {
  quality: string;
  label: string;
  maxHeight: number;
  resolving: boolean;
  onSelect: (q: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useMenuOpenSync(open);

  // Only show rungs this title actually offers (+ Auto, which always maps to
  // the best available) so the user can't pick a resolution that doesn't exist.
  const options = TRAILER_QUALITY_OPTIONS.filter(
    (o) => o.value === "auto" || Number(o.value) <= maxHeight,
  );

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Button text = the RESOLVED label ("1080p"); "…" while re-resolving. Accent
  // when the menu is open or a non-default quality is active.
  const btnText = resolving ? "…" : (label || "Quality");
  const active = open || (quality !== "1080" && quality !== "auto");

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <Tooltip text="Trailer quality" pos="top">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Trailer quality"
          className={`flex items-center gap-1.5 px-2.5 h-10 rounded-full transition-colors
                      ${active
                        ? "bg-ln-accent/20 text-ln-accent"
                        : "text-white/80 hover:text-white hover:bg-white/12"}`}
        >
          <QualityIcon />
          <span className="font-mono text-[12px] tabular-nums tracking-wider">{btnText}</span>
        </button>
      </Tooltip>

      {open && (
        <div className={`absolute bottom-full mb-2 right-0 min-w-[130px]
                         rounded-xl py-1.5 z-50 aura-glass-menu shadow-glass-edge
                         ${resolving ? "opacity-50 pointer-events-none" : ""}`}>
          <div className="px-4 pt-1.5 pb-1 text-white/40 text-[10px] font-mono font-semibold tracking-[0.18em] uppercase">
            Quality
          </div>
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => { onSelect(o.value); setOpen(false); }}
              className={`w-full flex items-center justify-between px-4 py-1.5 text-[13px]
                          transition-colors font-mono tabular-nums
                          ${o.value === quality
                            ? "text-ln-accent bg-ln-accent/10"
                            : "text-white/75 hover:text-white hover:bg-white/[0.16]"}`}
            >
              <span>{o.label}</span>
              {o.value === "auto" && <span className="text-[10px] text-white/35">best</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TrackMenu — generic dropdown for audio + subtitle tracks.
// ---------------------------------------------------------------------------

interface TrackMenuExtra {
  label: string;
  onClick: () => void;
  accent?: boolean;
}

function TrackMenu({
  label, tooltip, icon, tracks, onPick, extraItems, emptyHint,
  isOff, onOff, allowOff = true, delay,
}: {
  label: string;
  tooltip: string;
  icon: React.ReactNode;
  tracks: TrackEntry[];
  onPick: (id: number | null) => void;
  extraItems?: TrackMenuExtra[];
  emptyHint?: string;
  /** When provided, signals the dropdown should treat the menu as "Off"
   *  and lets the caller intercept the Off click (used for sub-visibility). */
  isOff?: boolean;
  onOff?: () => void;
  /** Set to false to hide the Off option (e.g. audio tracks). Defaults true. */
  allowOff?: boolean;
  /** Optional inline sync-nudge row. When set, renders ±0.1 s / Reset
   *  controls at the bottom of the dropdown — used to merge the
   *  audio-delay and sub-delay calibration into the corresponding
   *  track menu (saves a dedicated button in the control bar and
   *  groups conceptually-paired controls). */
  delay?: {
    label: string;
    value: number;
    onMinus: () => void;
    onPlus:  () => void;
    onReset: () => void;
    /** When set, adds a "Live sync" button to the delay row. This is the row a
     *  user already comes to when the subtitles are off, so it is where the
     *  cue-picker panel belongs. Clicking closes this menu and opens the panel. */
    onLiveSync?: () => void;
  };
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useMenuOpenSync(open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  // Mousewheel-over-dropdown: scroll the menu instead of letting the
  // overlay's volume-wheel handler steal the event.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.scrollBy({ top: e.deltaY, behavior: "auto" });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  const offIsActive = isOff ?? !tracks.some((t) => t.selected);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <Tooltip text={tooltip} pos="top">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label={tooltip}
          className={`flex items-center justify-center w-10 h-10 rounded-full
                      transition-colors
                      ${open
                        ? "bg-ln-accent/20 text-ln-accent"
                        : "text-white/80 hover:text-white hover:bg-white/12"
                      }`}
        >
          {icon}
        </button>
      </Tooltip>

      {open && (
        <div
          ref={scrollRef}
          className="absolute bottom-full mb-2 right-0 w-[340px]
                     rounded-xl py-1.5 z-50
                     aura-glass-menu
                     shadow-glass-edge max-h-[60vh] overflow-y-auto overflow-x-hidden"
          style={{ overscrollBehavior: "contain" }}
        >
          <div className="px-4 pt-1.5 pb-1 text-white/40 text-[10px] font-mono font-semibold tracking-[0.18em] uppercase">
            {label}
          </div>

          {/* Track-selection menus stay open after a click so the user
              can audit / re-pick without reopening every time. The
              outside-click handler above still closes them, and the
              dedicated dismiss-on-second-trigger-click still works
              because the menu trigger itself is a toggle. */}
          {allowOff && (
            <button
              onClick={() => {
                if (onOff) onOff(); else onPick(null);
              }}
              className={`w-full text-left px-4 py-2 text-[13px] transition-colors
                          ${offIsActive
                            ? "text-ln-accent bg-ln-accent/10"
                            : "text-white/55 hover:text-white hover:bg-white/[0.16]"}`}
            >
              Off
            </button>
          )}

          {tracks.length === 0 ? (
            <div className="px-4 py-3 text-white/40 text-[12px] italic">
              {emptyHint ?? "No tracks available"}
            </div>
          ) : (
            tracks.map((t) => (
              <button
                key={t.id}
                onClick={() => { onPick(t.id); }}
                className={`w-full text-left px-4 py-2 text-[13px] transition-colors
                            ${t.selected
                              ? "text-ln-accent bg-ln-accent/10"
                              : "text-white/90 hover:text-white hover:bg-white/[0.16]"
                            }`}
              >
                <div className="flex items-start gap-2">
                  <span className="flex-1 min-w-0 leading-snug break-words">
                    {t.title || t.lang?.toUpperCase() || `Track ${t.id}`}
                  </span>
                  <div className="flex-shrink-0 flex items-center gap-1">
                    {t.lang && (
                      <span className="text-[10px] font-mono text-white/55 px-1.5 py-0.5 rounded bg-white/8 border border-white/10">
                        {t.lang.toUpperCase()}
                      </span>
                    )}
                    {t.external && (
                      <span className="text-[9px] font-mono text-amber-300/90 px-1.5 py-0.5 rounded bg-amber-400/10 border border-amber-400/30">
                        EXT
                      </span>
                    )}
                  </div>
                </div>
              </button>
            ))
          )}

          {extraItems && extraItems.length > 0 && (
            <>
              <div className="my-1 mx-3 h-px bg-white/8" />
              {extraItems.map((it, idx) => (
                <button
                  key={idx}
                  onClick={() => { it.onClick(); setOpen(false); }}
                  className={`w-full text-left px-4 py-2 text-[13px] transition-colors
                              ${it.accent
                                ? "text-ln-accent hover:bg-ln-accent/10"
                                : "text-white/75 hover:text-white hover:bg-white/[0.16]"}`}
                >
                  {it.label}
                </button>
              ))}
            </>
          )}

          {delay && (
            <>
              <div className="my-1 mx-3 h-px bg-white/8" />
              <div className="px-4 py-2 space-y-1.5">
                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="text-white/55 font-mono uppercase tracking-[0.16em]">
                    {delay.label}
                  </span>
                  <span className="text-white/70 font-mono tabular-nums">
                    {delay.value === 0
                      ? "0.0 s"
                      : `${delay.value > 0 ? "+" : "−"}${Math.abs(delay.value).toFixed(1)} s`}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={delay.onMinus}
                    className="flex-1 px-1.5 py-1 rounded-md text-[11px] font-mono tabular-nums
                               bg-white/8 text-white/85 border border-white/12
                               hover:bg-white/14 hover:text-white active:scale-95 transition-all"
                  >
                    −0.1 s
                  </button>
                  <button
                    type="button"
                    onClick={delay.onPlus}
                    className="flex-1 px-1.5 py-1 rounded-md text-[11px] font-mono tabular-nums
                               bg-white/8 text-white/85 border border-white/12
                               hover:bg-white/14 hover:text-white active:scale-95 transition-all"
                  >
                    +0.1 s
                  </button>
                  <button
                    type="button"
                    onClick={delay.onReset}
                    disabled={delay.value === 0}
                    className="px-2 py-1 ml-auto rounded-md text-[10.5px] font-medium tracking-wide
                               bg-white/5 text-white/55 border border-white/10
                               hover:bg-white/10 hover:text-white
                               disabled:opacity-35 disabled:hover:bg-white/5 disabled:hover:text-white/55
                               transition-colors"
                  >
                    Reset
                  </button>
                </div>
                {delay.onLiveSync && (
                  <button
                    type="button"
                    onClick={() => { setOpen(false); delay.onLiveSync?.(); }}
                    className="w-full px-1.5 py-1 rounded-md text-[11px] font-medium tracking-wide
                               bg-ln-accent/15 text-ln-accent border border-ln-accent/35
                               hover:bg-ln-accent/25 active:scale-95 transition-all"
                  >
                    Live sync · pick the line you heard
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MoreMenu — Copy link / Download / External / Restart …
// ---------------------------------------------------------------------------

function MoreMenu({
  streamUrl, activeTarget, isAnime, time, duration, skipWindows,
}: {
  streamUrl: string | null;
  activeTarget: ActiveScrobbleTarget | null;
  isAnime: boolean;
  time: number;
  duration: number;
  skipWindows: AuraSkipWindow[];
}) {
  const [open, setOpen] = useState(false);
  const [aniskipOpen, setAniskipOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  // Mirror loudnessNormalization from auraSettings. Read fresh on mount
  // + every aura:settings-changed so flipping in Settings updates the
  // in-menu state without a remount. Toggling here writes back through
  // saveAuraSettings (which busts the module-level cache and re-fires
  // the event), so Settings and the player stay in lock-step.
  const [loudness, setLoudness] = useState(() => loadAuraSettings().loudnessNormalization);
  useEffect(() => {
    const sync = () => setLoudness(loadAuraSettings().loudnessNormalization);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);
  // SVP Tier 1 motion interpolation — same auraSettings-event-bus
  // mirror pattern as loudness above.
  const [interp, setInterp] = useState(() => !!loadAuraSettings().motionInterpolation);
  useEffect(() => {
    const sync = () => setInterp(!!loadAuraSettings().motionInterpolation);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);
  // Video equalizer — display-space VO controls. Live + session-scoped (mpv
  // keeps brightness/contrast/etc across files), with a Reset. Not persisted, so
  // a per-title fix doesn't silently bleed into the next title beyond a reset.
  const EQ_PROPS = [
    ["brightness", "Brightness"], ["contrast", "Contrast"], ["saturation", "Saturation"],
    ["gamma", "Gamma"], ["hue", "Hue"],
  ] as const;
  const [eqOpen, setEqOpen] = useState(false);
  const [eq, setEq] = useState<Record<string, number>>(
    { brightness: 0, contrast: 0, saturation: 0, gamma: 0, hue: 0 },
  );
  const setEqProp = (prop: string, value: number) => {
    setEq((m) => ({ ...m, [prop]: value }));
    invoke("set_video_eq", { prop, value }).catch(() => {});
  };
  const resetEq = () => {
    setEq({ brightness: 0, contrast: 0, saturation: 0, gamma: 0, hue: 0 });
    for (const [p] of EQ_PROPS) invoke("set_video_eq", { prop: p, value: 0 }).catch(() => {});
  };
  const ref = useRef<HTMLDivElement>(null);
  useMenuOpenSync(open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const toggleLoudness = () => {
    const next = !loudness;
    setLoudness(next);
    const current = loadAuraSettings();
    saveAuraSettings({ ...current, loudnessNormalization: next });
    invoke("set_audio_loudnorm", { enabled: next }).catch(() => {});
    showFlash(next ? "Loudness normalization on" : "Loudness normalization off");
  };

  const toggleInterp = () => {
    if (!isAnime) return; // anime-only — interpolation hurts live-action
    const next = !interp;
    setInterp(next);
    const current = loadAuraSettings();
    saveAuraSettings({ ...current, motionInterpolation: next });
    // Applies to the CURRENT video immediately; App.tsx re-applies on
    // each subsequent load. mpv GPU interpolation — the tscale kernel
    // (the smoothness dial) lives in Settings.
    invoke("set_motion_interpolation", {
      enabled: next,
      tscale: loadAuraSettings().interpolationTscale ?? "mitchell",
    }).catch(() => {});
    showFlash(next ? "Motion interpolation on" : "Motion interpolation off");
  };

  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1400);
  };

  const copy = useCallback(async () => {
    if (!streamUrl) { showFlash("No stream URL"); return; }
    const ok = await copyTextToClipboard(streamUrl);
    showFlash(ok ? "Copied!" : "Copy failed");
  }, [streamUrl]);

  const openExternal = useCallback(async () => {
    if (!streamUrl) { showFlash("No stream URL"); return; }
    const ok = await openExternalUrl(streamUrl);
    if (!ok) showFlash("Failed to open");
  }, [streamUrl]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <Tooltip text="More options" pos="top">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="More options"
          className={`flex items-center justify-center w-10 h-10 rounded-full transition-colors
                      ${open
                        ? "bg-ln-accent/20 text-ln-accent"
                        : "text-white/80 hover:text-white hover:bg-white/12"
                      }`}
        >
          <MoreIcon />
        </button>
      </Tooltip>

      {/* AniSkip submit / vote / mode-toggle popover. Rendered as a
          sibling of the MoreMenu list so it can stay open even when the
          parent menu collapses (and so its own click handlers don't
          collide with MoreMenu's outside-click handler). */}
      <AniSkipMenu
        open={aniskipOpen}
        onClose={() => setAniskipOpen(false)}
        activeTarget={activeTarget}
        time={time}
        duration={duration}
        windows={skipWindows}
      />

      {open && (
        <div className="absolute bottom-full mb-2 right-0 min-w-[240px]
                        rounded-xl py-1.5 z-50
                        aura-glass-menu
                        shadow-glass-edge">
          <MoreItem
            icon={<MoreIcon />}
            label="AuraSkip"
            onClick={() => { setAniskipOpen(true); setOpen(false); }}
          />
          <div className="my-1 mx-3 h-px bg-white/8" />
          <MoreItem
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M7 16V4M7 4 3 8M7 4l4 4" />
                <path d="M17 8v12M17 20l4-4M17 20l-4-4" />
              </svg>
            }
            label="Switch source"
            disabled={!streamUrl}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("aura:open-source-switcher"));
              setOpen(false);
            }}
          />
          <MoreItem
            icon={
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6" />
                <circle cx="2" cy="20" r="0.5" fill="currentColor" />
              </svg>
            }
            label="Cast to device"
            disabled={!streamUrl}
            onClick={() => {
              window.dispatchEvent(new CustomEvent("aura:open-cast-menu"));
              setOpen(false);
            }}
          />
          {/* Watch Together entry REMOVED — the in-player party pill (presence
              cluster) is the sole entry point during playback. */}
          <div className="my-1 mx-3 h-px bg-white/8" />
          <MoreItem
            icon={<CopyIcon />}
            label="Copy stream link"
            disabled={!streamUrl}
            onClick={() => { copy(); }}
          />
          <MoreItem
            icon={<DownloadIcon />}
            label="Download (open in browser)"
            disabled={!streamUrl}
            onClick={() => { openExternal(); setOpen(false); }}
          />
          <MoreItem
            icon={<ExternalIcon />}
            label="Open in external player"
            disabled={!streamUrl}
            onClick={() => { openExternal(); setOpen(false); }}
          />
          <div className="my-1 mx-3 h-px bg-white/8" />
          {/* Audio loudness normalization — in-player mirror of the
              Settings → Video & Audio → "Loudness normalization"
              toggle. Stays in sync with the Settings UI via the
              auraSettings event bus. */}
          <button
            type="button"
            onClick={toggleLoudness}
            className="w-full flex items-center gap-3 px-4 py-2 text-left text-[13px]
                       text-white/85 hover:text-white hover:bg-white/[0.16]
                       transition-colors"
            role="switch"
            aria-checked={loudness}
          >
            <span className="text-white/55 flex-shrink-0">
              <LoudnormIcon />
            </span>
            <span className="flex-1">Normalize loudness</span>
            <span
              aria-hidden
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0
                          ${loudness ? "bg-ln-accent/80" : "bg-white/15"}`}
            >
              <span
                className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-md
                           transition-transform duration-150"
                style={{ transform: loudness ? "translateX(16px)" : "translateX(0)" }}
              />
            </span>
          </button>
          {/* SVP Tier 1 motion interpolation — in-player mirror of the
              Settings → Video & Audio toggle. Same auraSettings event
              bus keeps the two surfaces in lock-step. */}
          <button
            type="button"
            onClick={toggleInterp}
            disabled={!isAnime}
            title={
              isAnime
                ? undefined
                : "Anime only — interpolation adds judder/drops on live-action"
            }
            className={`w-full flex items-center gap-3 px-4 py-2 text-left text-[13px]
                       transition-colors
                       ${isAnime
                         ? "text-white/85 hover:text-white hover:bg-white/[0.16]"
                         : "text-white/35 cursor-not-allowed"}`}
            role="switch"
            aria-checked={interp && isAnime}
            aria-disabled={!isAnime}
          >
            <span className="text-white/55 flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 3v2h2V7H5zm0 4v2h2v-2H5zm0 4v2h2v-2H5zm12-8v2h2V7h-2zm0 4v2h2v-2h-2zm0 4v2h2v-2h-2zM9 8.5v7l5-3.5-5-3.5z" />
              </svg>
            </span>
            <span className="flex-1">Motion interpolation</span>
            <span
              aria-hidden
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0
                          ${interp ? "bg-ln-accent/80" : "bg-white/15"}`}
            >
              <span
                className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-md
                           transition-transform duration-150"
                style={{ transform: interp ? "translateX(16px)" : "translateX(0)" }}
              />
            </span>
          </button>
          {/* Video equalizer — brightness / contrast / saturation / gamma / hue
              (display-space VO controls, live, session-scoped). Collapsible. */}
          <div className="my-1 mx-3 h-px bg-white/8" />
          <button
            type="button"
            onClick={() => setEqOpen((v) => !v)}
            aria-expanded={eqOpen}
            className="w-full flex items-center gap-3 px-4 py-2 text-left text-[13px]
                       text-white/85 hover:text-white hover:bg-white/[0.16] transition-colors"
          >
            <span className="text-white/55 flex-shrink-0">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" aria-hidden>
                <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
                <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
                <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
                <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
              </svg>
            </span>
            <span className="flex-1">Video equalizer</span>
            <span className="text-white/40 text-[11px]" aria-hidden>{eqOpen ? "▾" : "▸"}</span>
          </button>
          {eqOpen && (
            <div className="px-4 pt-1 pb-2 space-y-1.5">
              {EQ_PROPS.map(([prop, label]) => (
                <div key={prop} className="flex items-center gap-2">
                  <span className="text-white/55 text-[11px] w-[68px] flex-shrink-0">{label}</span>
                  <input
                    type="range" min={-100} max={100} step={1} value={eq[prop]}
                    onChange={(e) => setEqProp(prop, Number(e.target.value))}
                    className="flex-1 h-1 accent-ln-accent cursor-pointer"
                    aria-label={label}
                  />
                  <span className="text-white/45 text-[10px] font-mono w-7 text-right tabular-nums">{eq[prop]}</span>
                </div>
              ))}
              <button
                type="button"
                onClick={resetEq}
                className="w-full mt-0.5 text-[11px] text-white/55 hover:text-white py-1
                           rounded-md hover:bg-white/[0.08] transition-colors"
              >
                Reset to neutral
              </button>
            </div>
          )}
          {flash && (
            <div className="px-4 py-1.5 text-[11px] font-mono text-ln-accent/85 border-t border-white/8 mt-1">
              {flash}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MoreItem({
  icon, label, onClick, disabled,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full flex items-center gap-3 px-4 py-2 text-left text-[13px]
                  transition-colors
                  ${disabled
                    ? "text-white/30 cursor-not-allowed"
                    : "text-white/85 hover:text-white hover:bg-white/[0.16]"
                  }`}
    >
      <span className="text-white/55 flex-shrink-0">{icon}</span>
      <span className="flex-1">{label}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// BufferingOverlay — center-screen logo / title that pulses for any state
// where MPV isn't actively progressing through the file. Used for:
//   • cache stalls (MPV's `paused-for-cache` is true) — "Buffering"
//   • the initial loadfile window before MPV reports a duration —
//     "Loading"
// Manual user pause is intentionally NOT covered — the user knows
// they paused, the overlay would be intrusive over the frame they're
// looking at. Same Aura gradient as the title-bar wordmark.
// ---------------------------------------------------------------------------

function BufferingOverlay({
  show, statusText, bufferPct, title, logo,
}: {
  show: boolean;
  /** Replaces "Buffering" — caller decides ("Loading", "Buffering", …). */
  statusText: string;
  /** MPV cache-buffering-state (0..100) — the REAL progress toward the
   *  stream becoming playable (how full the cache is toward the point
   *  playback (re)starts and this overlay drops). Rendered as the primary
   *  progress readout + bar. Null when not in a cache wait. */
  bufferPct: number | null;
  title: string;
  logo: string | null;
}) {
  if (!title && !logo) return null;
  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-none"
      style={{
        opacity: show ? 1 : 0,
        transition: "opacity 320ms ease-out",
      }}
    >
      <div className="flex flex-col items-center gap-5">
        {logo ? (
          <div
            className="aura-buffering-pulse"
            style={{ filter: "drop-shadow(0 6px 22px rgba(0,0,0,0.85)) drop-shadow(0 0 28px rgba(91,164,255,0.32))" }}
          >
            <ImageLoader
              src={logo}
              alt={title}
              className="block"
              imgClassName="block max-h-32 w-auto object-contain"
            />
          </div>
        ) : (
          <h2
            className="aura-buffering-text text-5xl font-light tracking-tight"
            style={{ textShadow: "0 4px 24px rgba(0,0,0,0.85)" }}
          >
            {title}
          </h2>
        )}
        <p className="text-white/60 text-[12.5px] font-mono uppercase tracking-[0.3em]">
          {statusText}…
        </p>
        {/* Progress toward playable: MPV's cache-buffering-state (%), i.e. how
            full the cache is toward the point playback (re)starts and this
            overlay drops. Replaces the old "Ns buffered" readahead — that was a
            demuxer readahead figure, not load progress, and read as a false
            "already buffered" number on a stalled load. */}
        {typeof bufferPct === "number" && (
          <div className="flex flex-col items-center gap-1.5 -mt-2 w-40">
            <span className="text-white/55 text-[13px] font-mono tabular-nums tracking-[0.35em]">
              {Math.round(bufferPct)}%
            </span>
            <span className="block h-[3px] w-full rounded-full bg-white/12 overflow-hidden">
              <span
                className="block h-full bg-ln-accent rounded-full transition-[width] duration-300"
                style={{ width: `${Math.max(0, Math.min(100, bufferPct))}%` }}
              />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skip windows — React-side controller.
//
// Owns ALL skip behaviour (auto-skip, prompt toast, prompt-key, force-skip
// Shift+X) so the feature works whether or not the Lua script ever loads
// (which on this libmpv build is unreliable — see player.rs comment block
// above the post-init `load-script` call).
//
// Polling on a 250 ms interval is the source of truth for window-active
// state. We deliberately don't observe `user-data/aura/skip-windows` as a
// new MPV property — changing the observed-property set on this libmpv
// build can break the entire event channel (CLAUDE.md landmine #4).
//
// Components:
//   • SkipWindowButton — inline pill in the bottom control bar; offers
//     a one-click manual skip ONLY while inside a known OP/ED/Recap window.
//     (Skip detection is automatic now: App.tsx finishWithChapters runs a
//     silencedetect fallback for any missing OP/ED, so there's no manual probe.)
//   • SkipPromptToast — large top-left toast rendered when the active
//     window is in `prompt` mode (auto: false). Shows kind + the hotkey.
//   • SkipController — invisible component that owns the auto-skip
//     timer, the global `x` keybind (only fires while a prompt window is
//     active), and the always-on Shift+X force-skip keybind. Mounted
//     once at PlayerOverlay's root so its keybinds stay alive even when
//     the bottom control bar is hidden.
// ---------------------------------------------------------------------------

interface AuraSkipWindow {
  type:   string;
  start:  number;
  end:    number;
  source: string;
  auto:   boolean;
  /** AniSkip per-row identifier — present only when source ===
   *  "aniskip". Threaded through so the AniSkipMenu can call
   *  vote_skip_time without re-fetching. */
  skip_id?: string | null;
}

/** Reactive skip-windows store. The Rust side owns the canonical
 *  payload (it computes it from AniSkip + per-type user settings, then
 *  writes both the Aura cache AND mpv's user-data property). React
 *  fetches the cache once on mount and listens for `aura:skip-windows`
 *  for further updates.
 *
 *  This used to poll `get_property("user-data/aura/skip-windows")` at
 *  250 ms — that read raced libmpv's seek critical section the moment
 *  the Lua skip-windows.lua script issued its OP-skip seek, crashing
 *  the wrapper at `mpv_wrapper_get_property+0xa71` (movsxd dereference
 *  of -1 / unmapped pointer). See CLAUDE.md landmine #3. */
function useSkipWindows(): AuraSkipWindow[] {
  const [windows, setWindows] = useState<AuraSkipWindow[]>([]);
  useEffect(() => {
    let cancelled = false;
    invoke<{ windows?: AuraSkipWindow[] } | null>("get_skip_windows")
      .then((p) => {
        if (cancelled) return;
        const arr = Array.isArray(p?.windows) ? p!.windows! : [];
        setWindows(arr);
      })
      .catch(() => {});
    const unlistenP = listen<{ windows?: AuraSkipWindow[] }>(
      "aura:skip-windows",
      (e) => {
        if (cancelled) return;
        const arr = Array.isArray(e.payload?.windows) ? e.payload.windows! : [];
        setWindows(arr);
      },
    );
    return () => {
      cancelled = true;
      unlistenP.then((un) => un()).catch(() => {});
    };
  }, []);
  return windows;
}

function skipKindLabel(kind: string): string {
  switch (kind) {
    case "op":       return "Opening";
    case "mixed-op": return "Opening";
    case "ed":       return "Ending";
    case "recap":    return "Recap";
    default:         return "Segment";
  }
}

/** Top-left prompt toast rendered when in a prompt-mode window.
 *  Sized larger than the standard control-feedback toast (which lives
 *  near the centre top); positioned `fixed` at viewport top-left,
 *  offset below the exit-playback / title bar elements (which start at
 *  16 px in fullscreen and 16 + 36 = 52 px in windowed). Uses
 *  `pointer-events-none` so it never intercepts clicks on the controls. */
function SkipPromptToast({
  window: w,
  isFullscreen,
  visible,
}: {
  window: AuraSkipWindow;
  isFullscreen: boolean;
  visible: boolean;
}) {
  const kindLabel = skipKindLabel(w.type);
  // Top offset has to clear the "Exit playback ↗  <Title>" header above.
  // That header sits at top: 16 (fs) / 52 (windowed) and its content is
  // ~64 px tall. 96 / 132 keeps the prompt firmly below it.
  const top = isFullscreen ? 96 : 132;
  return (
    <div
      className="fixed left-6 z-[9000] pointer-events-none
                 px-7 py-4 rounded-2xl
                 bg-black/90 backdrop-blur-2xl border border-white/30
                 text-white shadow-glass-edge"
      style={{
        top,
        opacity: visible ? 1 : 0,
        transition: "opacity 400ms ease",
        animation: "aura-toast-pop 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
        textShadow: "0 1px 4px rgba(0,0,0,0.85)",
      }}
    >
      <div className="text-[12px] uppercase tracking-[0.22em] text-white/55 mb-1">
        Skip {kindLabel.toLowerCase()}
      </div>
      <div className="text-[20px] font-medium tracking-wide">
        Press{" "}
        <kbd className="inline-flex items-center justify-center
                        min-w-[28px] h-[28px] px-2 mx-0.5
                        rounded-md border border-white/35 bg-white/12
                        text-white font-mono text-[15px] align-middle">
          X
        </kbd>{" "}
        to skip the {kindLabel}
      </div>
    </div>
  );
}

/** Headless controller — auto-skips, key bindings, prompt rendering.
 *  Returns the prompt toast as its only DOM child. Mounted once at the
 *  top of PlayerOverlay so its `keydown` listeners stay alive even
 *  when the bottom control bar is hidden by the auto-fade timer. */
function SkipController({
  time, seekAbsolute, isFullscreen, streamUrl, controlsVisible, ready,
}: {
  time: number;
  seekAbsolute: (t: number) => void;
  isFullscreen: boolean;
  streamUrl: string | null;
  controlsVisible: boolean;
  /** The file is genuinely loaded (duration > 0). Everything below is gated
   *  on it: skip windows for the NEW episode get stamped within ~1 s of
   *  `loadfile`, seconds before libmpv finishes parsing headers, while
   *  `time` is still 0 (or a leftover tick from the file being replaced).
   *  Ungated, a window starting at ~0 matched instantly and fired its seek
   *  into libmpv's loadfile critical section: on a cold open mpv rejected it
   *  (`seek ... failed: -12`) and the window was burned unskipped, and on an
   *  episode advance (previous file still loaded) it landed, which is the
   *  "opening skipped the moment it started" symptom. Gating the match
   *  itself also suppresses the premature toast and prompt. Deliberately
   *  NOT keyed on first-frame-seen: that flag is set by the cross-boundary
   *  tick this guard exists to ignore. */
  ready: boolean;
}) {
  const windows = useSkipWindows();
  const active   = ready ? (windows.find((w) => time >= w.start && time < w.end) ?? null) : null;
  const upcoming = ready ? (windows.find((w) => w.start > time && (w.start - time) <= 30) ?? null) : null;

  // Per-window "we already handled this one" set, scoped to the
  // current stream. A backwards seek out of the window then back in
  // should re-trigger the prompt; that's why we key by start+end +
  // reset on stream change.
  const firedRef = useRef<Set<string>>(new Set());
  useEffect(() => { firedRef.current = new Set(); }, [streamUrl]);

  // Refs that the always-on Shift+X listener reads. The listener is
  // installed once and never re-bound — capturing `active` / `upcoming`
  // / `seekAbsolute` directly would freeze them at install time.
  const activeRef    = useRef(active);
  const upcomingRef  = useRef(upcoming);
  const seekRef      = useRef(seekAbsolute);
  const timeRef      = useRef(time);
  useEffect(() => { activeRef.current   = active; },   [active]);
  useEffect(() => { upcomingRef.current = upcoming; }, [upcoming]);
  useEffect(() => { seekRef.current     = seekAbsolute; }, [seekAbsolute]);
  useEffect(() => { timeRef.current     = time; },     [time]);

  // Auto-skip: when entering a window with auto=true, fire seek to end.
  // Midpoint grace mirrors the Lua script — if the user resumed past
  // the midpoint they're presumably engaged with the OP and yanking
  // forward would be jarring.
  useEffect(() => {
    if (!active || !active.auto) return;
    const key = `${active.start}-${active.end}`;
    if (firedRef.current.has(key)) return;
    const span = active.end - active.start;
    if (time - active.start > span * 0.5) {
      // Don't yank, but mark fired so we don't re-evaluate every tick.
      firedRef.current.add(key);
      return;
    }
    firedRef.current.add(key);
    seekAbsolute(active.end);
    fireToast(`Skipped ${skipKindLabel(active.type)}`);
    // Only the start/end+auto matter for the gate; `time` is
    // intentionally excluded so a single firing isn't re-evaluated on
    // every poll tick. The midpoint check above runs once per entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.start, active?.end, active?.auto, streamUrl]);

  // Prompt-mode key 'x' — only bound while in a prompt window.
  useEffect(() => {
    if (!active || active.auto) return;
    const key = `${active.start}-${active.end}`;
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "x") return;
      // Don't intercept if the user is typing in an input field.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      e.stopPropagation();
      firedRef.current.add(key);
      seekAbsolute(active.end);
      fireToast(`Skipped ${skipKindLabel(active.type)}`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active?.start, active?.end, active?.auto, seekAbsolute]);

  // Force-skip Shift+X — always active, anywhere in playback. Inside a
  // window: skip it. Within 30 s of the next window's start: pre-skip.
  // Otherwise: feedback toast.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key.toLowerCase() !== "x") return;
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      e.preventDefault();
      e.stopPropagation();
      const a = activeRef.current;
      const u = upcomingRef.current;
      if (a) {
        firedRef.current.add(`${a.start}-${a.end}`);
        seekRef.current(a.end);
        fireToast(`Skipped ${skipKindLabel(a.type)}`);
      } else if (u) {
        firedRef.current.add(`${u.start}-${u.end}`);
        seekRef.current(u.end);
        fireToast(`Skipped upcoming ${skipKindLabel(u.type)}`);
      } else {
        fireToast("No skip window nearby");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // After 10 s in the same prompt window, fade the toast out — but
  // unhide it again whenever the player chrome reappears. The 'x'
  // keybind above is bound to `active`, not the toast's visibility,
  // so the skip still works while the prompt is hidden.
  const promptKey = active && !active.auto ? `${active.start}-${active.end}` : null;
  const [autoHidden, setAutoHidden] = useState(false);
  useEffect(() => {
    setAutoHidden(false);
    if (!promptKey) return;
    const t = setTimeout(() => setAutoHidden(true), 10_000);
    return () => clearTimeout(t);
  }, [promptKey]);

  if (!active || active.auto) return null;
  // Suppress the toast briefly after firing — `firedRef.has(key)` is
  // the cleanest way to know "user already accepted, hide the prompt".
  if (firedRef.current.has(`${active.start}-${active.end}`)) return null;
  const visible = !autoHidden || controlsVisible;
  return <SkipPromptToast window={active} isFullscreen={isFullscreen} visible={visible} />;
}

function SkipWindowButton({
  time, seekAbsolute,
}: {
  time: number;
  seekAbsolute: (t: number) => void;
}) {
  const windows = useSkipWindows();
  const active = windows.find((w) => time >= w.start && time < w.end);

  // Inside an active window → the "Skip OP/ED/Recap" jump button.
  if (active) {
    const labelByKind: Record<string, string> = {
      op:    "Skip OP",
      ed:    "Skip ED",
      recap: "Skip Recap",
      "mixed-op": "Skip OP",
    };
    const label = labelByKind[active.type] ?? "Skip";
    return (
      <button
        type="button"
        onClick={() => seekAbsolute(active.end)}
        className="ml-3 px-3 py-1 rounded-full
                   bg-ln-accent/20 text-ln-accent
                   hover:bg-ln-accent/30 active:bg-ln-accent/40
                   border border-ln-accent/40
                   text-[12px] font-semibold tracking-wide
                   transition-colors"
        title={`${label} (${Math.round(active.end - time)} s remaining)`}
      >
        {label}
      </button>
    );
  }

  return null;
}
