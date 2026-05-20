// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import NavSidebar, { type NavView } from "./NavSidebar";
import BootSplash from "./BootSplash";
import ResizeHandles from "./ResizeHandles";
import HomeView from "./views/HomeView";
import DiscoverView from "./views/DiscoverView";
import LibraryView from "./views/LibraryView";
import AddonsView from "./views/AddonsView";
import CalendarView from "./views/CalendarView";
import HistoryView from "./views/HistoryView";
import QueueView from "./views/QueueView";
import SettingsView from "./views/SettingsView";
import DetailView from "./views/DetailView";
import ThemeEngine from "./ThemeEngine";
import TitleBar from "./TitleBar";
import LandingView from "./LandingView";
import LoginView from "./LoginView";
import OnboardingView from "./views/OnboardingView";
import { isOnboardingComplete } from "./onboarding";
import PlayerOverlay from "./PlayerOverlay";
import AmbientAura from "./AmbientAura";
import ContextMenuHost, { openContextMenu } from "./ContextMenu";
import { CatalogHoverHost } from "./CatalogHoverCard";
import AppToastHost, { showAppToast } from "./AppToast";
import FlyUpToastHost, { showFlyUpToast } from "./FlyUpToast";
import SourcePopupHost from "./SourcePopup";
import DevConsole from "./DevConsole";
import UpdatePopup from "./UpdatePopup";
import CrashReportingConsent from "./CrashReportingConsent";
import ResumePrompt, { type PendingResume } from "./ResumePrompt";
import { isNewer } from "./updater";
import { checkForUpdatePlugin, downloadAndInstallUpdatePlugin, type UpdateInfo } from "./updaterPlugin";
import { advanceWatchedAfter } from "./autoAdvance";
import { clearAutoBumped } from "./autoBumped";
import { mirrorWatchedFromCloud, pushItemWatched } from "./watchedSync";
import { onWatchedSync } from "./manualWatched";
import { useScrobble, type ActiveScrobbleTarget } from "./useScrobble";
import { useScrobbleAuthAlerts } from "./useScrobbleAuthAlerts";
import { useKeybindings } from "./useKeybindings";
import { libraryToggle, libraryRemoveAll, libraryWriteProgress, libraryClearProgress } from "./libraryActions";
import { libraryItemSeriesId } from "./libraryNormalize";
import { sourcesForMeta, openInPopupBrowser } from "./externalSources";
import { setManualWatchedScope, getManualWatchedState, setManualWatchedState, setManualWatchedMany, getPlannedQueue } from "./manualWatched";
import { reconcileLibraryReleaseSignals, clearReleaseSignalStore } from "./releaseSignalStore";
import { syncPullAll, installSyncTriggers, startBackgroundPull, clearSyncEtags, setSyncActiveScope } from "./sync";
import { setHistoryScope, addHistoryEntry } from "./historyStore";
import { setAutoBackupScope, startAutoBackup } from "./userDataBackup";
import NextUpCta from "./NextUpCta";
import EosSpotlight from "./EosSpotlight";
import EpisodePanel from "./EpisodePanel";
import { resolveNextEpisode, pickFirstStreamForEpisode, findNextEpisode, findPreviousEpisode } from "./nextUp";
import { getMetaDetailFallback, peekCachedDetailById } from "./metaCache";
import { PersistentCache } from "./persistentCache";
import { loadAuraSettings } from "./auraSettings";

interface AniSkipResult {
  found: boolean;
  windows: { kind: string; start: number; end: number; source: string; skip_id?: string | null }[];
}

// 3-day cache for AniSkip windows. Still skips the network round-trip
// on a binge / same-week re-watch (the common case), but the previous
// 30-day TTL meant a community CORRECTION to an episode's timestamps
// stayed invisible for up to a month for anyone who'd watched it once.
// 3 days is the balance: corrections surface within days, re-watches
// inside the window stay free. Negative results are still never cached
// (see the fetch site), so a freshly-contributed not-found → found
// flip is picked up on the very next watch regardless of this TTL.
const aniskipCache = new PersistentCache<AniSkipResult>({
  storageKey: "aura:aniskip-cache:v1",
  ttlMs:      3 * 24 * 60 * 60 * 1000,
  maxEntries: 600,
});

/** Slice of BackendSettings used by the AniSkip resolver. Avoids
 *  importing the full BackendSettings interface (lives in SettingsView)
 *  which would create a circular-ish dependency. */
interface BackendSettingsLite {
  skip_op_mode?: string;
  skip_ed_mode?: string;
  skip_recap_mode?: string;
  skip_treat_mixed_op_as_op?: boolean;
}
import type { ContextMenuItem } from "./ContextMenu";
import { normalizeLibrary } from "./libraryNormalize";
import { LibraryProvider } from "./LibraryContext";
import { NotificationsProvider, useNotifications } from "./NotificationsContext";
import NotificationsBell from "./NotificationsBell";
import AccountButton from "./AccountButton";
import NotificationsScanner, { clearScannerState } from "./NotificationsScanner";
import { getTitleState } from "./titleState";
import { isAnimeMeta, markAnimeId } from "./aiometadata";
import type {
  AddonEntry,
  ExternalSubtitle,
  LibraryItem,
  MetaPreview,
  StreamEntry,
  VideoEntry,
} from "./types";
import { isVideoAired } from "./types";
import type { UserSession, StremioAccount } from "./LoginView";
import "./App.css";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const SESSION_EXPIRED = "SESSION_EXPIRED";

/** Current app version — kept in sync with package.json by hand. Read by
 *  the auto-updater on every Home visit (debounced to 1×/5min) to compare
 *  against the latest GitHub release tag. Sourced from `package.json`'s
 *  `version` field via the `VITE_APP_VERSION` define wired in
 *  vite.config.ts, so it stays in sync with every version bump without
 *  needing two extra Edit calls per release. Previously a hardcoded
 *  string here — that drifted from package.json once (constant got
 *  pre-bumped to a release that hadn't shipped yet, so binaries built in
 *  the interim believed they were already on the new version and the
 *  in-app "up to date" check silently stopped working). */
const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "0.0.0";

/** localStorage key for the most recent release tag the user has dismissed
 *  to the notifications bell. The auto-updater popup re-fires only when
 *  a NEWER tag is detected. Keep the key string in sync with the bell
 *  implementation — both halves read/write this same key. */
const UPDATE_DISMISSED_KEY = "aura:update:dismissed-version";

/** Min interval between GitHub release polls. The check runs on entry to
 *  the Home view; this guard prevents a tab-flick spamming the API. */
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Chapter-driven skip windows (anime OP/ED detection from embedded
// chapters). Many anime releases ship chapter markers titled "Opening",
// "OP", "Ending", "ED", "Recap", etc. We complement AniSkip data by
// reading MPV's chapter-list a few seconds after load and merging any
// matching chapters as additional skip windows.
//
// `existing` is the AniSkip-derived window list already stamped to MPV.
// `modeFor(kind)` returns the user's "off"/"prompt"/"auto" preference
// per window kind so a chapter-detected OP picks up the same OP mode
// the user configured for AniSkip's OP windows.
//
// Chapter titles are matched case-insensitively. We trim the chapter
// at the next chapter's start (or duration) to derive an end time —
// MPV chapters store start only.
// ---------------------------------------------------------------------------

interface MpvChapter {
  title?: string | null;
  time?:  number | null;
}

function classifyChapterTitle(title: string): "op" | "ed" | "recap" | null {
  const t = title.toLowerCase().trim();
  if (!t) return null;
  // Recap first — "Previously on…" / "recap" / "summary" intros
  // sometimes precede an opening, so the recap match wins.
  if (/\b(recap|previously|previously on|last time|story so far|summary)\b/.test(t)) return "recap";
  // Opening / intro / theme — generic enough to also catch live-action
  // title sequences (not anime-only). "Cold open" / "teaser" are
  // DELIBERATELY excluded: those are usually real story content, and
  // skipping them would eat the episode.
  if (
    /^op(\b|\d| |$)/.test(t) ||
    /\b(opening|intro|introduction|theme song|main theme|title sequence)\b/.test(t)
  ) return "op";
  // Ending / outro / credits / next-episode preview. "Preview" /
  // "next episode" are end-of-episode content; the positional guard in
  // mergeChapterSkipWindows stops a stray EARLY "Preview" chapter from
  // being treated as an outro.
  if (
    /^ed(\b|\d| |$)/.test(t) ||
    /\b(ending|outro|closing|end credits|credits|epilogue|end theme|closing theme|preview|next episode|next time|coming up)\b/.test(t)
  ) return "ed";
  return null;
}

interface PreparedWindow {
  type:   string;
  start:  number;
  end:    number;
  source: string;
  auto:   boolean;
}

// Kai-derived chapter heuristics (live-action + anime where AniSkip
// has no data). Industry-standard OP length is ~90 s; an UNTITLED
// chapter inside the leading INTRO_FRACTION whose length is closest to
// that (within OP_MIN..OP_MAX) is treated as the opening — prompt-only
// (never auto: it's a guess). AniSkip windows and titled chapters
// always take precedence over the positional heuristic.
const INTRO_FRACTION       = 0.20;
const OUTRO_FRACTION       = 0.20;
const TARGET_OP_SECONDS    = 90;
const OP_MIN_SECONDS       = 30;
const OP_MAX_SECONDS       = 130;
// Sanity caps so a mis-titled giant chapter ("Part 1") can't nuke real
// content. ED can legitimately run long (a full credits roll).
const TITLED_OP_MAX_SECONDS = 300;
const ED_MAX_SECONDS        = 900;
const MIN_WINDOW_SECONDS    = 2;

/** Fraction of [aStart,aEnd) that overlaps [bStart,bEnd). */
function windowOverlapFraction(
  aStart: number, aEnd: number, bStart: number, bEnd: number,
): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  return inter / Math.max(0.001, aEnd - aStart);
}

async function mergeChapterSkipWindows(
  existing: PreparedWindow[],
  modeFor: (kind: string) => "off" | "prompt" | "auto",
): Promise<PreparedWindow[]> {
  // Wait for chapter-list to land. Demuxer parse can be slightly behind
  // duration; bail early once we see chapters or after ~6 s of attempts.
  //
  // CRITICAL: only read with `string` format. The earlier `node`-format
  // attempt crashes the wrapper at `mpv_wrapper_get_property+0xa71` —
  // same dispatch-table fault as the original `track-list/node` crash
  // documented in lib.rs:591 (CLAUDE.md landmine #3 family). The
  // try/catch here can't recover because the fault is a STATUS_ACCESS_
  // VIOLATION inside the FFI call, not a JS exception. The string
  // format goes through a different code path that's safe to call
  // even while libmpv is still processing loadfile.
  let chapters: MpvChapter[] | null = null;
  let duration = 0;
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      duration = (await invoke<number | null>("get_property", { name: "duration", format: "double" })) ?? 0;
    } catch {}
    try {
      const raw = await invoke<string | null>("get_property", { name: "chapter-list", format: "string" });
      if (typeof raw === "string" && raw.trim().length > 0) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          chapters = parsed as MpvChapter[];
          if (chapters.length > 0) break;
        }
      }
    } catch {}
  }
  if (!chapters || chapters.length === 0) return existing;

  // Sort by start time so adjacent-chapter end derivation is stable.
  const sorted = [...chapters]
    .filter((c) => typeof c.time === "number")
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0));

  // Derive [start,end) for every chapter once (MPV stores start only;
  // end = next chapter's start, or duration for the last). Drop sub-
  // MIN_WINDOW_SECONDS slivers (chapter-marker noise).
  const spans = sorted
    .map((c, i) => {
      const start = c.time ?? 0;
      const end   = ((sorted[i + 1]?.time) ?? (duration || start)) - 0.001;
      return { title: (c.title ?? "").toString(), start, end };
    })
    .filter((s) => s.end > s.start + MIN_WINDOW_SECONDS);

  const derived: PreparedWindow[] = [];
  // Any-overlap guard (vs AniSkip `existing` AND already-derived) —
  // used for the heuristic windows so a guess can never double-stamp
  // a region a precise source already owns.
  const free = (start: number, end: number): boolean =>
    !existing.some((e) => windowOverlapFraction(start, end, e.start, e.end) > 0.0001) &&
    !derived.some((d) => windowOverlapFraction(start, end, d.start, d.end) > 0.0001);

  // 1. TITLED chapters — honour the user's per-kind mode (may be auto).
  //    Length-capped so a mis-titled monster chapter can't nuke real
  //    content. A "Preview"/"Next episode" chapter only counts as an
  //    ending when it actually sits in the outro region.
  for (const s of spans) {
    const kind = classifyChapterTitle(s.title);
    if (!kind) continue;
    if (modeFor(kind) === "off") continue;
    const len = s.end - s.start;
    if (len > (kind === "ed" ? ED_MAX_SECONDS : TITLED_OP_MAX_SECONDS)) continue;
    const lower = s.title.toLowerCase();
    const isPreviewish =
      /\b(preview|next episode|next time|coming up)\b/.test(lower) &&
      !/\b(ending|outro|closing|credits|epilogue)\b/.test(lower);
    if (
      kind === "ed" && isPreviewish && duration > 0 &&
      s.start < duration * (1 - OUTRO_FRACTION) - 1
    ) continue; // a stray EARLY "Preview" is not an outro
    // Skip when AniSkip already covers this region (>80 % overlap).
    const dup = existing.some(
      (e) => windowOverlapFraction(s.start, s.end, e.start, e.end) > 0.8,
    );
    if (dup) continue;
    derived.push({
      type:   kind,
      start:  s.start,
      end:    s.end,
      source: "chapter",
      auto:   modeFor(kind) === "auto",
    });
  }

  // 2. PROLOGUE FIX — when nothing (AniSkip or titled chapter) gave us
  //    an OP, pick the untitled chapter in the leading INTRO_FRACTION
  //    whose length is closest to the ~90 s industry-standard OP
  //    (tie → the LATER chapter, so a short cold-open prologue loses
  //    to the real OP). Prompt-only — never auto-skip a guess.
  if (duration > 0 && modeFor("op") !== "off") {
    const hasOp =
      existing.some((e) => e.type === "op" || e.type === "mixed-op") ||
      derived.some((d) => d.type === "op");
    if (!hasOp) {
      const introLimit = duration * INTRO_FRACTION;
      const cands = spans
        .filter((s) => classifyChapterTitle(s.title) === null && s.start < introLimit)
        .map((s) => ({ s, len: s.end - s.start }))
        .filter(({ len }) => len >= OP_MIN_SECONDS && len <= OP_MAX_SECONDS)
        .sort((a, b) => {
          const da = Math.abs(a.len - TARGET_OP_SECONDS);
          const db = Math.abs(b.len - TARGET_OP_SECONDS);
          return Math.abs(da - db) <= 5 ? b.s.start - a.s.start : da - db;
        });
      const pick = cands[0]?.s;
      if (pick && free(pick.start, pick.end)) {
        derived.push({
          type: "op", start: pick.start, end: pick.end,
          source: "chapter-heuristic", auto: false,
        });
      }
    }
  }

  // 3. Untitled OUTRO — exactly one untitled chapter wholly inside the
  //    trailing OUTRO_FRACTION, ≥20 s, when nothing else gave an ED.
  //    Prompt-only. The "exactly one" gate keeps multi-part credits /
  //    post-credit scenes from being mis-skipped.
  if (duration > 0 && modeFor("ed") !== "off") {
    const hasEd =
      existing.some((e) => e.type === "ed") || derived.some((d) => d.type === "ed");
    if (!hasEd) {
      const outroStart = duration * (1 - OUTRO_FRACTION);
      const outroCands = spans.filter(
        (s) =>
          classifyChapterTitle(s.title) === null &&
          s.start >= outroStart &&
          s.end - s.start >= 20 &&
          s.end - s.start <= ED_MAX_SECONDS,
      );
      if (outroCands.length === 1 && free(outroCands[0].start, outroCands[0].end)) {
        const o = outroCands[0];
        derived.push({
          type: "ed", start: o.start, end: o.end,
          source: "chapter-heuristic", auto: false,
        });
      }
    }
  }

  if (derived.length === 0) return existing;

  const merged = [...existing, ...derived];
  try {
    await invoke("set_skip_windows", { payload: { windows: merged } });
    console.info(
      `[aniskip] merged ${derived.length} chapter window(s) → total ${merged.length}`,
    );
  } catch (err) {
    console.warn(`[aniskip] chapter merge stamp failed: ${String(err)}`);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// usePlayback
// ---------------------------------------------------------------------------

/** Aggregated playback snapshot emitted by the Rust observer bridge
 *  after folding the latest pause / time-pos / duration / volume / speed
 *  events from MPV. The `buffering` and `eof` fields are not driven by
 *  events (those properties can't be observed safely on this libmpv
 *  build) — they're updated by polling get_property. */
interface PlaybackPayload {
  time: number;
  duration: number;
  paused: boolean;
  volume: number;
  speed: number;
  buffering: boolean;
  eof: boolean;
}

function usePlayback(playerActive: boolean) {
  const [time, setTime]           = useState(0);
  const [duration, setDuration]   = useState(0);
  const [paused, setPaused]       = useState(true);
  const [volume, setVolume]       = useState(50);
  const [speed, setSpeed]         = useState(1);
  // Stream-broken detector. MPV silently uninits its video output
  // when a seek hits a network outage and the demuxer flips to EOF
  // (canonical aura-mpv.log signature: "EOF code: 1" → "vo/...win32
  // uninit"). The webview is still alive but every player command
  // is a no-op — user sees Aura's background under transparent
  // controls that don't respond. We detect the dead state by
  // tracking the last `time-pos` heartbeat: if playback was active,
  // not paused, and we haven't received an update in
  // BROKEN_STALE_MS, surface a recovery prompt.
  const [streamBroken, setStreamBroken] = useState(false);
  // Initial buffering=true so the loading overlay is visible from the
  // very first paint after the user clicks play, all the way through
  // the gap between MPV's loadfile completing (duration > 0) and our
  // first paused-for-cache poll resolving 1.5 s later. Without this,
  // there was a window where the overlay would briefly disappear even
  // though MPV was still filling its initial cache.
  const [buffering, setBuffering] = useState(true);
  const [eof, setEof]             = useState(false);
  // Cache fill level reported by MPV during a buffering event. Null
  // when not buffering or when the property isn't readable yet (early
  // load window). Surfaced to the BufferingOverlay so long buffer hangs
  // are visible to the user.
  //
  // Permanently null today: the only writer (the now-removed
  // cache-buffering-state poll) was dropped because every JS-driven
  // `get_property` rolled the dice against the libmpv-wrapper crash.
  // Re-introduce via a Rust-side cache-state listener (event-driven, no
  // polling) when adding the buffering UX back.
  const [bufferPct] = useState<number | null>(null);
  // Once-per-playback latch: flips true the first time MPV reports
  // time-pos > 0 (i.e. real frames are flowing). The loading overlay
  // stays up until this flips, regardless of `duration` / `buffering`,
  // so the user never sees the overlay vanish while they're still
  // staring at a blank video region. Reset by `notifyNewLoad()` on
  // every new load_video so per-episode swaps go back through the
  // loading state cleanly.
  const [firstFrameSeen, setFirstFrameSeen] = useState(false);

  // ── Buffering / EOF polling ──
  // `paused-for-cache`, `eof-reached`, and `cache-buffering-state` USED to be
  // polled here — but every `get_property` IPC during playback is a roulette
  // bet against the libmpv-wrapper's mid-seek-state race. Whenever AniSkip's
  // Lua `skip-windows.lua` seeks past an OP/ED, the wrapper's internal
  // property-name lookup table is briefly inconsistent; a JS-driven
  // `get_property` landing in that window crashes at
  // `mpv_wrapper_get_property+0xa71` (movsxd dereference of -1).
  //
  // CLAUDE.md landmines #3 and #4 cover the underlying race. The first round
  // of fixes removed the highest-frequency callers (250 ms skip-windows poll,
  // 500 ms sub-visibility poll) and trimmed this poll from 800 → 1500 ms.
  // The crash kept reproducing because every poll tick still rolls the dice.
  //
  // The pragmatic exit: drop the poll entirely. We lose:
  //   • Cache-pause indicator (`paused-for-cache`) — purely cosmetic.
  //   • Cache fill percentage UI (`cache-buffering-state`) — cosmetic.
  //   • EOF detection (`eof-reached`) — accepted regression; the proper fix
  //     is an `MPV_EVENT_END_FILE` listener on the Rust side emitting a
  //     dedicated event. Tracked separately.
  //
  // Initial buffering (set true at loadfile, cleared on first time-pos > 0
  // via the `playback-update` channel) still works because that path uses
  // observed properties only.

  // ── Event-driven sync ──
  // The Rust observer bridge folds MPV property events into a single
  // PlaybackState and broadcasts `playback-update`. We consume the
  // aggregated snapshot here and update React state.
  /** Wall-clock timestamp of the last `notifyNewLoad`. Drives
   *  the load-timing log: every load-phase transition is emitted
   *  with a `+Xms` delta so the user can see exactly which step
   *  is slow when a stream feels stuck loading. Reset each time
   *  a new stream starts loading. */
  const loadStartedAtRef = useRef<number>(0);
  /** Set of load-event names already emitted for the current
   *  load. Stops the same milestone from spamming the log on
   *  every poll tick (e.g. "duration appeared"). */
  const loadEventsSeenRef = useRef<Set<string>>(new Set());
  /** Last cache-buffering-state percentage we logged, so we only
   *  emit on meaningful changes (≥5 % delta or boundary crossings). */
  const lastCacheBufferLogRef = useRef<number | null>(null);

  /** Append a milestone to the load log (DevConsole). Called on
   *  every load-phase transition so the user can see the timing
   *  breakdown of what's happening between "click stream" and
   *  "first frame visible". */
  const logLoadEvent = useCallback((name: string, data?: Record<string, unknown>) => {
    const start = loadStartedAtRef.current;
    if (start === 0) return; // not currently loading
    const dt = Date.now() - start;
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    console.info(`[load] +${dt}ms ${name}${dataStr}`);
  }, []);

  // Last received `time-pos` event timestamp — drives the broken-
  // stream detector below. Updated on every `time` payload that
  // contains a numeric value (NOT just non-zero ones, so a paused
  // file that's still receiving heartbeats counts as alive).
  const lastTimeUpdateAtRef = useRef<number>(0);

  useEffect(() => {
    const p = listen<PlaybackPayload>("playback-update", ({ payload }) => {
      if (typeof payload.time === "number") {
        lastTimeUpdateAtRef.current = Date.now();
        setTime(payload.time);
        // First-frame latch: any time > 0 reading means MPV has
        // started producing frames for the current file. Once
        // flipped, stays true until notifyNewLoad() resets it.
        if (payload.time > 0) {
          if (!loadEventsSeenRef.current.has("first-frame")) {
            loadEventsSeenRef.current.add("first-frame");
            logLoadEvent("first frame visible", { time: payload.time });
          }
          setFirstFrameSeen(true);
          setBuffering(false);
          // Any heartbeat clears the broken-stream flag — playback
          // self-recovered (mpv reconnected, or the user successfully
          // reloaded). The recovery overlay's listener uses the same
          // ref so the latch resets symmetrically.
          setStreamBroken(false);
        }
      }
      if (typeof payload.duration === "number") {
        if (payload.duration > 0 && !loadEventsSeenRef.current.has("duration-known")) {
          loadEventsSeenRef.current.add("duration-known");
          logLoadEvent("duration emitted (demuxer parsed headers)", { duration: payload.duration });
        }
        setDuration(payload.duration);
      }
      if (typeof payload.paused === "boolean")  setPaused(payload.paused);
      if (typeof payload.volume === "number")   setVolume(payload.volume);
      if (typeof payload.speed === "number" && payload.speed > 0) setSpeed(payload.speed);
      if (typeof payload.buffering === "boolean") setBuffering(payload.buffering);
      if (typeof payload.eof === "boolean")     setEof(payload.eof);

      // EOS Spotlight — immediate-fire on the live tick. mpv's time-pos halts
      // within ~0.5 s of duration at true EOF on this libmpv build; without
      // this, the stale-heartbeat path adds a 1.5 s floor. Shares the one-shot
      // nearEndEosFiredRef so the 1.5 s / 8 s / playback-end {eof} fallbacks
      // all latch through one fuse. Window widened from 0.25 → 0.5 s
      // (2026-05-20): the 0.25 s threshold was tighter than the actual last
      // tick before mpv entered keep-open state (now `keep-open=yes`), so
      // many true-EOF flushes fell through to the 1.5 s stale-heartbeat path
      // — visible as a ~1.5 s delay before the Spotlight appeared. 0.5 s
      // catches the genuine last tick while still being narrow enough that
      // mid-playback ticks don't trip it (a forward seek would have to land
      // within half a second of duration, which only happens at true EOF).
      const _t = typeof payload.time     === "number" ? payload.time     : null;
      const _d = typeof payload.duration === "number" ? payload.duration : null;
      const _isPaused = typeof payload.paused === "boolean" ? payload.paused : false;
      if (
        !nearEndEosFiredRef.current &&
        _t != null && _d != null &&
        _t > 0 && _d > 0 &&
        _d - _t <= 0.5 &&
        !_isPaused
      ) {
        nearEndEosFiredRef.current = true;
        window.dispatchEvent(new CustomEvent("aura:eos-detected"));
      }
    });
    return () => { p.then((fn) => fn()).catch(() => {}); };
  }, [logLoadEvent]);

  // Pause → unpause transition: reset the heartbeat baseline so the
  // stale-heartbeat detector measures from "just resumed", not "last
  // time-pos before pause". Without this, a long pause (tray-close
  // for several minutes, then restore + resume) makes the detector
  // fire immediately on resume because `last` is stale by however
  // long the user was paused — visible as a spurious "Stream
  // connection lost" prompt on a perfectly healthy resume.
  const prevPausedRef = useRef(paused);
  useEffect(() => {
    if (prevPausedRef.current && !paused) {
      lastTimeUpdateAtRef.current = Date.now();
    }
    prevPausedRef.current = paused;
  }, [paused]);

  // Tray-restore handler. Rust emits `aura:window-restored-from-tray`
  // after `win.show()` in the tray-icon click path. We poke MPV's vo
  // (refresh_video toggles video-zoom to force a redraw) — the
  // off-screen render period during the hide can leave the vo stuck
  // on a stale frame. We also stamp the heartbeat to "now" so the
  // stale-heartbeat detector measures from the restore moment; if
  // the user resumes playback and the stream is dead (debrid URL
  // expired during the tray dwell), the detector then fires the
  // reload prompt after the normal 8 s grace window instead of
  // waiting indefinitely on an unrecoverable stream.
  useEffect(() => {
    if (!playerActive) return;
    const p = listen("aura:window-restored-from-tray", () => {
      invoke("refresh_video").catch(() => {});
      lastTimeUpdateAtRef.current = Date.now();
    });
    return () => { p.then((fn) => fn()).catch(() => {}); };
  }, [playerActive]);

  // Stale-heartbeat detector. Wakes once a second; flags the stream
  // broken when time-pos hasn't ticked in BROKEN_STALE_MS while we
  // were genuinely playing (firstFrameSeen + !paused). The recovery
  // overlay shown by PlayerOverlay reads this and offers a Reload
  // button that re-invokes handlePlayStream with the current target
  // and the last-known time as the resume offset.
  //
  // EOS DISAMBIGUATION (EOS Spotlight, 2026-05-19): on this libmpv
  // build mpv stops emitting `time-pos` at true end-of-stream, so the
  // 8 s stale detector would otherwise fire a FALSE "Stream connection
  // lost" modal on every clean episode/movie finish. Before flagging
  // the stream broken we check the last-known position: if playback
  // halted within ~5 s of the metadata duration (≈ the last 1 %), this
  // is end-of-stream, not a network break — dispatch `aura:eos-detected`
  // and let App's EOS Spotlight own the screen instead. Genuine breaks
  // (>5 s from the end) still flip `streamBroken` and surface the
  // unchanged recovery / Reload modal.
  const lastPosRef = useRef({ time: 0, duration: 0 });
  useEffect(() => {
    lastPosRef.current = { time, duration };
  }, [time, duration]);
  // One-shot guard so the fast near-end EOS short-circuit dispatches
  // `aura:eos-detected` exactly once per stream. Reset per load inside
  // notifyNewLoad (alongside the other fresh-load state resets).
  const nearEndEosFiredRef = useRef(false);
  useEffect(() => {
    const BROKEN_STALE_MS = 8000;
    // Fast path: when playback was already within the last few seconds
    // of the metadata duration, a stale heartbeat is end-of-stream, not
    // a network break — on this libmpv-wrapper build `time-pos` simply
    // stops at true EOF and `end-file` is unreliable, so the 8 s broken
    // detector would otherwise make the EOS Spotlight appear ~8 s late.
    // Surface it after ~1.5 s instead. Genuine mid-stream halts (>5 s
    // from the end) still wait the full 8 s and flip `streamBroken`.
    const EOS_NEAR_END_STALE_MS = 1500;
    const EOS_TAIL_SECONDS = 5;
    const id = window.setInterval(() => {
      const last = lastTimeUpdateAtRef.current;
      if (last === 0) return;
      // Only meaningful while playback was actually rolling. paused-
      // for-cache buffering is its own state with its own UI.
      if (paused) return;
      if (!firstFrameSeen) return;
      const staleFor = Date.now() - last;
      const { time: t, duration: d } = lastPosRef.current;
      const nearEnd = t > 0 && d > 0 && d - t <= EOS_TAIL_SECONDS;
      // Near-end short-circuit (~1.5 s): clean EOF, fire the Spotlight
      // early. Guarded so it dispatches once per stream.
      if (
        nearEnd &&
        !nearEndEosFiredRef.current &&
        staleFor >= EOS_NEAR_END_STALE_MS
      ) {
        nearEndEosFiredRef.current = true;
        window.dispatchEvent(new CustomEvent("aura:eos-detected"));
        return;
      }
      if (staleFor >= BROKEN_STALE_MS) {
        if (nearEnd) {
          // Near-end stall → end-of-stream, not a break. App owns the
          // Spotlight; one dispatch is enough (the listener latches).
          if (!nearEndEosFiredRef.current) {
            nearEndEosFiredRef.current = true;
            window.dispatchEvent(new CustomEvent("aura:eos-detected"));
          }
          return;
        }
        setStreamBroken(true);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [paused, firstFrameSeen]);

  // ── Load-failure detector ──
  // The stale-heartbeat detector above only catches mid-play stalls
  // (firstFrameSeen=true + heartbeat went silent). A DNS / TCP /
  // demuxer failure during the INITIAL load never reaches that path
  // because no first frame ever arrives. MPV signals this via the
  // `end-file` event with reason="error"; the Rust bridge forwards
  // it as `playback-end` so we can flip streamBroken regardless of
  // whether playback ever actually started.
  //
  // The aura-mpv.log signature is the comet.animasec.dev DNS-fail
  // case: ffmpeg "Failed to open ...", ytdl_hook fallback also
  // fails, "finished playback, loading failed (reason 4)", then
  // vo/gpu-next/win32 uninit. Without this listener, MPV's video
  // output is gone but Aura has no way to know.
  useEffect(() => {
    const p = listen<{ reason?: string; error?: number }>("playback-end", ({ payload }) => {
      const reason = payload?.reason ?? "";
      // "error" is the only failure mode worth surfacing as a BREAK —
      // "stop" and "quit" are user-initiated; "redirect" is internal to
      // MPV's playlist handling and never reaches the user.
      if (reason === "error") {
        console.warn("[playback] end-file reason=error", payload);
        setStreamBroken(true);
        return;
      }
      // "eof" = the file played to completion. This is the clean
      // end-of-stream signal (EOS Spotlight, 2026-05-19). App owns the
      // Spotlight UI; we just notify via a window event so usePlayback
      // stays free of the eosActive state (App clears it on new load /
      // exit). The near-end stale-heartbeat path above is the fallback
      // for containers whose `eof` event never arrives.
      if (reason === "eof") {
        if (!nearEndEosFiredRef.current) {
          nearEndEosFiredRef.current = true;
          window.dispatchEvent(new CustomEvent("aura:eos-detected"));
        }
      }
    });
    return () => { p.then((fn) => fn()).catch(() => {}); };
  }, []);

  // Belt-and-suspenders watchdog: if loadStartedAtRef has been non-
  // zero for >LOAD_TIMEOUT_MS and firstFrameSeen is still false, the
  // load is wedged (e.g. silent network hang where no end-file event
  // ever fires). Surface the recovery overlay anyway. The 45 s
  // window is long enough that slow CDNs handing over the first 4K
  // frame don't false-positive.
  useEffect(() => {
    if (firstFrameSeen) return;
    const LOAD_TIMEOUT_MS = 45000;
    const id = window.setInterval(() => {
      const start = loadStartedAtRef.current;
      if (start === 0) return;
      if (Date.now() - start >= LOAD_TIMEOUT_MS) {
        console.warn("[playback] load watchdog: no first frame in 45 s");
        setStreamBroken(true);
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [firstFrameSeen]);

  /** Reset playback state for a new load_video call. Called from the
   *  parent right before invoking load_video so every fresh playback
   *  session — first or Nth — starts in the "loading" state and the
   *  overlay only hides once MPV is genuinely ready to play. */
  const notifyNewLoad = useCallback(() => {
    loadStartedAtRef.current = Date.now();
    loadEventsSeenRef.current = new Set();
    lastTimeUpdateAtRef.current = 0;
    lastCacheBufferLogRef.current = null;
    nearEndEosFiredRef.current = false;
    console.info("[load] +0ms notifyNewLoad — fresh load sequence begins");
    setBuffering(true);
    setFirstFrameSeen(false);
    setTime(0);
    setDuration(0);
    setEof(false);
    // Reset paused to false at load time. MPV's default behaviour on
    // loadfile is "play immediately"; on this libmpv build the initial
    // pause property fires `paused=true` during loadfile then no follow-
    // up event because pause never actually flips (MPV stayed in
    // "playing" the whole time). Without this reset the play/pause
    // icon stays stuck on Play until the user manually toggles. We
    // assume "playing" here; if the user has the stream set to start
    // paused (rare) the next property-change event will correct us.
    setPaused(false);
    // Reset the broken-stream latch so a stale flag from the
    // previous load doesn't keep the recovery overlay visible
    // while the new stream is still loading. Both manual paths
    // (Reload button, Exit button) clear it explicitly too — this
    // is the catch-all for the "user picked a different stream"
    // path through handlePlayStream.
    setStreamBroken(false);
  }, []);

  const togglePause   = useCallback(() => invoke("toggle_pause").catch(() => {}), []);
  const seekRelative  = useCallback(
    (s: number) => invoke("seek_relative", { seconds: s }).catch(() => {}),
    [],
  );
  const seekAbsolute  = useCallback(
    (t: number) => invoke("seek_absolute",  { time: t }).catch(() => {}),
    [],
  );
  /** Optimistic volume — set local state immediately so the slider stays
   *  responsive; the polling reconciles within ≤ 250 ms. */
  const commitVolume = useCallback((v: number) => {
    setVolume(v);
    invoke("set_volume", { volume: v }).catch(() => {});
  }, []);
  const commitSpeed = useCallback((s: number) => {
    setSpeed(s);
    invoke("set_speed", { speed: s }).catch(() => {});
  }, []);

  return {
    time, duration, paused, volume, speed, buffering, bufferPct, eof, firstFrameSeen,
    streamBroken, setStreamBroken,
    togglePause, seekRelative, seekAbsolute, commitVolume, commitSpeed,
    notifyNewLoad, logLoadEvent,
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/** Pick the first valid HTTPS image URL from a list — used to feed Discord
 *  RPC's `large_image` slot. Discord rejects non-HTTPS URLs (and the request
 *  fails silently in some clients), so we filter early. */
function pickArt(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && /^https:\/\//i.test(c)) return c;
  }
  return null;
}

export default function App() {
  // ── Nav state ──
  const [activeView, setActiveView] = useState<NavView>("home");
  const [homeResetKey, setHomeResetKey] = useState(0);

  // ── Auto-updater state ──
  // `pendingUpdate` is non-null only when a newer release has been
  // detected AND the user hasn't already dismissed that exact tag to the
  // notifications bell. The popup mounts on the truthy state.
  const [pendingUpdate, setPendingUpdate] = useState<UpdateInfo | null>(null);
  // Throttle ref — Date.now() of the most recent release-API hit. The
  // home-view effect short-circuits if the last check was < 5 min ago.
  const lastUpdateCheckRef = useRef<number>(0);

  // ── Auth state ──
  const [session, setSession] = useState<UserSession | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  /** True once the home view has fully settled (all catalog rows populated,
   *  HeroCarousel stable) OR once the 8-second hard timeout fires.  The boot
   *  splash stays up until this flips — prevents hero flicker on the first
   *  paint.  On the landing screen (no session, guest not yet chosen) it
   *  bypasses home and flips as soon as authChecked is true. */
  const [bootReady, setBootReady] = useState(false);
  /** Ref mirror of bootReady so the boot-ready effect can bail early on
   *  re-runs without adding bootReady to its dependency array (which would
   *  cause the listener + timeout to be re-armed on every flip). */
  const bootReadyRef = useRef(false);
  /** True once the user has either signed in OR explicitly chosen guest mode. */
  const [landingDismissed, setLandingDismissed] = useState(false);
  /** Controls the LoginView modal independently of the landing screen. */
  const [showLogin, setShowLogin] = useState(false);
  /** First-run wizard: dismisses to false once the user finishes/skips the
   *  flow OR if a completed flag was already on disk from a prior install.
   *  `onboardingStartAddons` flips true when AddonsView fires the
   *  "Reopen onboarding addons" event so the wizard remounts at step 2. */
  const [onboardingActive, setOnboardingActive] = useState<boolean>(() => !isOnboardingComplete());
  const [onboardingStartAddons, setOnboardingStartAddons] = useState(false);

  // ── Addons ──
  const [addons, setAddons] = useState<AddonEntry[]>([]);

  // ── Library (Continue Watching + Calendar source) ──
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  // Resume-from-progress prompt: when handlePlayStream sees a saved
  // timeOffset for the target, it sets `pendingResume` to a deferred
  // pair of resolvers (onResume / onStartOver). The prompt component
  // shows the choice + a 15 s auto-resume countdown, and whichever
  // button the user picks resolves the promise → handlePlayStream
  // continues with the appropriate start_seconds for load_video.
  const [pendingResume, setPendingResume] = useState<PendingResume | null>(null);
  /** Raw, un-normalized library straight from library_get. Held alongside
   *  the normalized `library` purely so removal flows can target every
   *  contributing record (phantom episode-level rows that the normalizer
   *  has collapsed under one series-root key). Without this, removing the
   *  series root leaves the per-episode rows live on the server and the
   *  next sync re-surfaces them as ghost tiles. */
  const [rawLibrary, setRawLibrary] = useState<LibraryItem[]>([]);
  /** False until the first library_get for the current session has resolved.
   *  Drives the LibraryView skeleton state — without this we'd flash an
   *  empty-state card during the initial fetch. */
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  // ── Active scrobble / RPC / SMTC target ──
  const [activeTarget, setActiveTarget] = useState<ActiveScrobbleTarget | null>(null);
  /** The DIRECT (un-proxied) URL of the playing stream, kept for the
   *  PlayerOverlay's Copy / Download / External-player utilities. Cleared
   *  when playback exits. */
  const [activeStreamUrl, setActiveStreamUrl] = useState<string | null>(null);
  /** External subtitle tracks for the active stream — addon-supplied
   *  .srt/.vtt URLs. Merged with MPV's track-list in the subtitle dropdown. */
  const [activeExternalSubs, setActiveExternalSubs] = useState<ExternalSubtitle[]>([]);
  /** Scoring inputs for the audio auto-select algorithm — populated from
   *  AIOMetadata's `original_language` + `production_countries` at the time
   *  the user picks a stream. Cleared on exit-playback. */
  const [activeScoringMeta, setActiveScoringMeta] = useState<{
    original_language: string | null;
    production_countries: string[];
    genres?: string[];
    country?: string | null;
  } | null>(null);

  const isPlayerActive = activeTarget != null;

  // ── Playback hook — gated on activeTarget so the polling fallback only
  //     runs while a stream is loaded.
  const {
    time, duration, paused, volume, speed, buffering, bufferPct, firstFrameSeen,
    streamBroken, setStreamBroken,
    togglePause, seekRelative, seekAbsolute, commitVolume, commitSpeed,
    notifyNewLoad, logLoadEvent,
  } = usePlayback(isPlayerActive);

  // ── Detail-view state (selected meta + click-rect for shared-element open) ──
  const [selectedMeta, setSelectedMeta] = useState<MetaPreview | null>(null);
  const [selectedRect, setSelectedRect] = useState<DOMRect | null>(null);

  // ── Catalog deep-view state (clicking "View All" on Home) ──
  // Holdover from the old "View All → catalog deep view" navigation.
  // The View-All popup is local to DiscoveryRow now (no parent state),
  // so nothing currently writes a non-null value here. The state is
  // kept (always null) so the existing conditionals scattered through
  // the App body / RPC handler / Discord-scene logic don't need to
  // be untangled in one go — they all read it as null and skip.
  type CatalogTarget = {
    addonUrl:    string;
    addonName:   string;
    mediaType:   string;
    catalogId:   string;
    catalogName: string;
  };
  const [activeCatalog, setActiveCatalog] = useState<CatalogTarget | null>(null);

  /** When true, DetailView's next mount ignores the state.video_id
   *  resume hint — used by every entry point EXCEPT Continue Watching
   *  cards. Series clicks open at S01E01 (episodes panel); only CW
   *  cards jump to the resume-from-streams view, since that's their
   *  whole purpose. Inverted from earlier default at the user's
   *  request — search / catalog / library / hero / history / calendar
   *  all preferred the episodes-list-first behaviour. */
  const [ignoreResumeOnNextOpen, setIgnoreResumeOnNextOpen] = useState(true);

  /** When true, DetailView's next mount opens directly in STREAMS mode
   *  for the supplied `openOnEpisodeId`, skipping the episodes-list
   *  intermediate step. Used by the EOS Spotlight's EpisodePanel
   *  single-click flow (2026-05-20): the user picks an episode from
   *  the in-player panel, App bounces them out to DetailView, and
   *  rather than landing on the episodes list (one extra click) they
   *  land directly on the streams panel for the chosen episode. Highest
   *  precedence over openOnEpisodeId/resumeVideoId default branches in
   *  DetailView's panelMode init. One-shot — consumed via
   *  `onConsumeOpenInStreamsMode` on the next render so a stale flag
   *  doesn't bleed into a later unrelated open. */
  const [openInStreamsMode, setOpenInStreamsMode] = useState(false);
  const consumeOpenInStreamsMode = useCallback(() => setOpenInStreamsMode(false), []);

  /** Default open: ignores the resume hint. Used by every surface that
   *  isn't a CW tile (search / catalog / library / hero / history /
   *  calendar / detail card overlays). Series open on the episode
   *  list at S01E01. */
  const openDetail = useCallback((meta: MetaPreview) => {
    setIgnoreResumeOnNextOpen(true);
    const el = document.querySelector<HTMLElement>(
      `[data-meta-card="${meta.media_type}:${meta.id}"]`
    );
    setSelectedRect(el ? el.getBoundingClientRect() : null);
    setSelectedMeta(meta);
  }, []);

  /** Continue-Watching open: HONOURS the resume hint, jumping straight
   *  to the streams panel for the last-watched episode. The whole
   *  point of a CW card is "pick up where you left off." */
  const openDetailFromCW = useCallback((meta: MetaPreview) => {
    setIgnoreResumeOnNextOpen(false);
    const el = document.querySelector<HTMLElement>(
      `[data-meta-card="${meta.media_type}:${meta.id}"]`
    );
    setSelectedRect(el ? el.getBoundingClientRect() : null);
    setSelectedMeta(meta);
  }, []);

  const closeDetail = useCallback(() => {
    setSelectedMeta(null);
    setSelectedRect(null);
    setIgnoreResumeOnNextOpen(true);
  }, []);

  /** Stream → MPV bridge: route the URL through the streaming bridge then
      load_video. Sets activeTarget so scrobble/RPC/SMTC light up.
      `target.id` is the EPISODE id for series/anime (e.g. `kitsu:12345:1`)
      so scrobbling and external-subtitle lookups key off the right entry.

      External subtitles are NOT auto-added here. We used to fan them out
      synchronously right after load_video, which hammered MPV with up to
      ~50 `sub-add` commands while it was still negotiating the HTTPS
      stream — playback would silently fail to start. The
      `auto-load-external-subs` effect below only runs AFTER MPV reports a
      non-zero duration (i.e. the main file is actually playing) and is
      capped to 5 tracks with the non-blocking `auto` flag. */
  const handlePlayStream = useCallback(
    async (
      stream: StreamEntry,
      target: {
        id: string;
        series_id?: string;
        media_type: string;
        name: string;
        episode?: string;
        episode_title?: string;
        season?: number;
        episode_num?: number;
        scoring?: {
          original_language: string | null;
          production_countries: string[];
          genres?: string[];
          country?: string | null;
        };
      },
    ) => {
      try {
        if (!stream.url && !stream.info_hash) return;
        // User actually engaged with this series → clear the
        // auto-bumped CW-suppression flag (recheck-watched flow).
        // The series can now re-enter CW as normal once the player
        // updates state.timeOffset, with no further suppression.
        const targetSeriesId = target.series_id ?? target.id;
        if (targetSeriesId) clearAutoBumped(targetSeriesId);

        // ── Resume-from-progress prompt ──────────────────────────────
        // Look up the library record for the SERIES root (movies key
        // on `id` directly). When the addon has a saved timeOffset
        // for this exact episode (or movie), and that offset is
        // non-trivial, ask the user whether to resume or start over.
        // Movies / standalone files: target.id IS the library key.
        // Series: state.video_id stores the resume episode and we
        //         only show the prompt when the user is loading that
        //         exact episode — picking a different episode means
        //         "I want to play this one fresh".
        const RESUME_MIN_OFFSET_SECONDS = 60;
        const RESUME_NEAR_END_RATIO     = 0.95;
        let resumeSeconds: number | null = null;
        let resumeDuration: number | null = null;
        const libRow = library.find((i) => i.id === targetSeriesId);
        if (libRow) {
          const st = libRow.state ?? {};
          const off = typeof st.timeOffset === "number" ? st.timeOffset : 0;
          const dur = typeof st.duration === "number" ? st.duration : 0;
          // Series resume only counts when the user is opening the
          // SAME video that was last played; opening a different
          // episode in the same series should start at 0.
          const sameEpisode =
            target.media_type === "movie"
              ? true
              : (typeof st.video_id === "string" && st.video_id === target.id);
          if (sameEpisode && off >= RESUME_MIN_OFFSET_SECONDS) {
            // If the user finished the file (>= 95 % through), don't
            // re-prompt them to "resume" the last 30 seconds — they
            // just want to rewatch from the start.
            if (dur === 0 || off / dur < RESUME_NEAR_END_RATIO) {
              resumeSeconds  = off;
              resumeDuration = dur > 0 ? dur : null;
            }
          }
        }

        // Sentinel value the prompt's Cancel path resolves with. Caller
        // (below) checks the awaited value against this to short-circuit
        // the entire play flow — no resolve_stream, no load_video, no
        // history entry. Esc + outside-click on the modal route here.
        const RESUME_CANCELLED = Symbol("resume-cancelled");
        let resumeAt: number | null | typeof RESUME_CANCELLED = null;
        if (resumeSeconds != null) {
          resumeAt = await new Promise<number | null | typeof RESUME_CANCELLED>((resolve) => {
            setPendingResume({
              resumeSeconds:   resumeSeconds!,
              durationSeconds: resumeDuration,
              title:           target.name,
              episodeTag:      target.episode ?? null,
              onResume:    () => { setPendingResume(null); resolve(resumeSeconds); },
              onStartOver: () => { setPendingResume(null); resolve(null); },
              onCancel:    () => { setPendingResume(null); resolve(RESUME_CANCELLED); },
            });
          });
          if (resumeAt === RESUME_CANCELLED) {
            // User dismissed the prompt — abort cleanly. No notifyNewLoad,
            // no resolve_stream, no MPV load_video. The UI returns to
            // whatever it was showing before the click.
            return;
          }
        }

        const raw = stream.url ?? `magnet:?xt=urn:btih:${stream.info_hash}`;
        // Reset playback state BEFORE load_video so the loading overlay
        // covers the entire window between user click and first frame.
        // notifyNewLoad ALSO arms the load-timing log; subsequent
        // logLoadEvent calls emit `[load] +Xms` lines so the user can
        // see exactly which phase is slow when a stream hangs at
        // "Loading… N%".
        notifyNewLoad();
        const t0resolve = Date.now();
        const resolved = await invoke<string>("resolve_stream", { rawUrl: raw });
        logLoadEvent("resolve_stream returned", {
          dt: Date.now() - t0resolve,
          scheme: resolved.startsWith("https://") ? "https" :
                  resolved.startsWith("http://127.0.0.1:") ? "bridge" :
                  resolved.startsWith("http://") ? "http" : "other",
        });

        // CDN preheat — fire-and-forget Range: bytes=0-65535 GET to
        // warm the upstream debrid edge before MPV connects. Goal:
        // first byte-range MPV requests hits a hot CDN cache instead
        // of cold-fetching at 2–50 Mbps. Cuts perceived startup lag
        // by 100–500 ms on cold origins. Capped at 2 s — if the
        // preheat doesn't finish in time the worst case is "MPV
        // connects normally" (which it would have anyway). Skip for
        // magnet URLs (no HTTP edge to preheat) and for `http://127.
        // 0.0.1:` bridge URLs (the bridge sits on the loopback).
        if (resolved.startsWith("https://") || (resolved.startsWith("http://") && !resolved.startsWith("http://127.0.0.1:"))) {
          const preheatStart = Date.now();
          void fetch(resolved, {
            method: "GET",
            headers: { Range: "bytes=0-65535" },
            signal: AbortSignal.timeout(2000),
          })
            .then((r) => {
              logLoadEvent("preheat done", {
                dt: Date.now() - preheatStart,
                status: r.status,
              });
              // Drain the body so the connection can be reused / closed
              // cleanly without leaving an in-flight response object.
              r.body?.cancel().catch(() => {});
            })
            .catch(() => {
              // Preheat is best-effort. CORS / network errors are
              // expected for some hosts and don't surface to the user.
            });
        }

        const t0load = Date.now();
        await invoke("load_video", {
          path:           resolved,
          // resumeAt is null when the user picked "Start over" or the
          // saved offset didn't meet the prompt threshold. mpv treats
          // a missing start_seconds as 0 (play from the beginning).
          startSeconds:   resumeAt ?? null,
        });
        logLoadEvent("load_video returned (MPV accepted loadfile)", {
          dt: Date.now() - t0load,
          resumeAt,
        });
        // Position MPV viewport immediately (offset below the 36 px title bar
        // in windowed mode). At this point MPV's vo hasn't created its
        // child window yet so this is mostly a no-op, but it doesn't hurt
        // and the duration-armed effect catches the real window when it
        // appears. Pass the current fullscreen state explicitly.
        setTimeout(() => {
          invoke("refresh_video", {
            isFullscreen: isFullscreenRef.current,
          }).catch(() => {});
        }, 150);
        // Apply preferred language tracks after MPV has had time to detect
        // the available audio/subtitle streams.
        //
        // `media_type === "anime"` alone misses most titles — anime
        // catalogs from AIOMetadata typically tag content as `series` or
        // `movie` and rely on the `kitsu:` / `anilist:` / `mal:` /
        // `anidb:` ID prefix to mark it as anime. `isAnimeMeta` checks
        // both. Without this, every anime got the global English audio
        // pref instead of the Japanese-first anime defaults.
        const animeFlag = isAnimeMeta({
          media_type: target.media_type,
          id: target.id,
        });
        setTimeout(() => {
          invoke("apply_lang_defaults", { isAnime: animeFlag }).catch(() => {});
          // Re-push the user's subtitle styling so a freshly-loaded
          // file inherits the saved size / colour / position / etc.
          invoke("apply_subtitle_style").catch(() => {});
          // Loudness normalization re-applies on every stream load.
          // Read fresh — the toggle (Settings or player's three-dots
          // menu) writes through saveAuraSettings which busts the
          // module-level snapshot, so this returns the current value.
          const { loudnessNormalization, motionInterpolation, interpolationTscale } = loadAuraSettings();
          invoke("set_audio_loudnorm", { enabled: !!loudnessNormalization }).catch(() => {});
          // SVP Tier 1 — re-apply the persisted motion-interpolation
          // setting on every load (the @auraInterp vf is per-file).
          // Issued inside the same +1500 ms post-load gate as loudnorm
          // so it never touches libmpv during the loadfile critical
          // section (landmine #3).
          invoke("set_motion_interpolation", {
            enabled: !!motionInterpolation,
            tscale: interpolationTscale ?? "mitchell",
          }).catch(() => {});
          // Hover-thumbnail pre-warm. `extract_thumbnail` lazily spins
          // up a SEPARATE "thumb" libmpv instance (audio=false, vo=null,
          // no observed properties) and loadfiles the URL on the FIRST
          // scrubber hover, so the first ~4 user hovers were spent just
          // warming it. Prime it once here, off the user's path, with
          // the SAME URL the Scrubber later passes as `streamUrl`
          // (== activeStreamUrl == stream.url). Fire-and-forget; runs
          // inside this same +1500 ms post-load gate so it is well
          // clear of the loadfile critical section (landmine #3) and
          // touches a different instance entirely (never the "main"
          // mpv). No-op for magnet streams (no stream.url).
          if (stream.url) {
            void invoke("extract_thumbnail", {
              url: stream.url,
              atSeconds: 1,
            }).catch(() => {});
          }
        }, 1500);

        // ── Anime OP/ED skip windows ──
        // Fire-and-forget AniSkip lookup + payload stamp. The Lua
        // script on MPV's side will react to user-data/aura/skip-
        // windows changes. We always clear the property first so a
        // previously-played anime episode's windows don't leak into a
        // non-anime title's playback.
        //
        // Gate is mal-id resolvability, NOT the upfront `animeFlag`.
        // animeFlag relies on media_type === "anime" / id-prefix /
        // localStorage cache — it returns FALSE on a fresh play of
        // IMDb-id'd anime (e.g. tt0988824 Naruto Shippuden coming from
        // a stremio anime catalog whose meta_type is "series" and id
        // is `tt…`). meta detail from AIOMetadata stamps `mal_id` /
        // `kitsu_id` / `anilist_id` regardless of the surface id, so
        // attempting resolution unconditionally is the reliable path.
        // Anything that doesn't resolve to a mal_id (movies, live-
        // action series) bails cleanly without a network round-trip
        // beyond the meta-detail cache hit.
        // Episode number is parsed from target.id's last segment.
        {
          (async () => {
            // Reset first so non-anime / no-data cases don't leave
            // stale windows from the previous load.
            try { await invoke("set_skip_windows", { payload: { windows: [] } }); } catch {}

            // Skip windows are a SERIES concept (anime via AniSkip +
            // chapters; live-action via chapters / the positional
            // heuristic). Movies and live-TV have no OP/ED structure.
            const mtLower = (target.media_type ?? "").toLowerCase();
            if (mtLower === "movie" || mtLower === "channel" || mtLower === "channels" || mtLower === "tv") {
              return;
            }

            // Settings → per-kind mode. HOISTED above the MAL cascade
            // (was below it) so (a) the chapter path is reachable for
            // live-action, which never resolves a MAL id, and (b) an
            // all-off config short-circuits before any network round
            // trip (the old order paid the MAL/Jikan cascade first).
            let settings: BackendSettingsLite | null = null;
            try { settings = await invoke<BackendSettingsLite>("get_settings"); } catch {}
            const normalizeMode = (raw: string | undefined, fallback: "off" | "prompt" | "auto"): "off" | "prompt" | "auto" =>
              raw === "off" || raw === "prompt" || raw === "auto" ? raw : fallback;
            const opMode    = normalizeMode(settings?.skip_op_mode,    "auto");
            const edMode    = normalizeMode(settings?.skip_ed_mode,    "prompt");
            const recapMode = normalizeMode(settings?.skip_recap_mode, "prompt");
            const treatMixed = settings?.skip_treat_mixed_op_as_op ?? true;
            if (opMode === "off" && edMode === "off" && recapMode === "off") {
              console.info(`[aniskip] skip — all modes off`);
              return;
            }
            const modeFor = (kind: string): "off" | "prompt" | "auto" =>
              kind === "op" || kind === "mixed-op" ? opMode
              : kind === "ed"    ? edMode
              : kind === "recap" ? recapMode
              : "off";

            // Tail used by EVERY exit below: stamp any AniSkip windows
            // (empty for live-action / AniSkip-miss), then ALWAYS run
            // the chapter augment so titled chapters + the positional
            // heuristic still produce skip windows, then surface the
            // ED start for the Next-Up CTA. This is what extends skip
            // from anime-only to any series.
            const finishWithChapters = async (
              prepared: PreparedWindow[],
              opts?: { silenceUrl?: string | null },
            ): Promise<void> => {
              try {
                if (prepared.length > 0) {
                  await invoke("set_skip_windows", { payload: { windows: prepared } });
                  console.info(`[aniskip] stamped ${prepared.length} window(s)`);
                }
                const merged = await mergeChapterSkipWindows(prepared, modeFor);
                // Latest ED window START → precisely-timed Next-Up CTA
                // (last ED wins for double-ED / sponsor-bumper cases).
                const lastEdStart = merged
                  .filter((w) => w.type === "ed")
                  .reduce<number | null>(
                    (acc, w) => (acc == null || w.start > acc ? w.start : acc),
                    null,
                  );
                if (lastEdStart != null) {
                  window.dispatchEvent(new CustomEvent<number>("aura:ed-start-time", {
                    detail: lastEdStart,
                  }));
                }
                // Hybrid-mode auto OP fallback. Every series path now
                // passes `silenceUrl` (anime AND live-action) — that's
                // the Hybrid opt-in: when NOTHING upstream produced an
                // OP (no AniSkip data AND no titled/heuristic chapter
                // OP), one bounded ffmpeg silencedetect pass infers the
                // OP→dialogue boundary. Same one-shot command + heuristic
                // as the manual "Detect Skip" button; just automatic.
                // Prompt-mode (auto:false) — never auto-seek a guess.
                // ffmpeg-on-PATH best-effort: a clean no-op without it.
                const url = opts?.silenceUrl ?? null;
                const hasOp = merged.some((w) => w.type === "op" || w.type === "mixed-op");
                if (url && !hasOp && modeFor("op") !== "off") {
                  try {
                    const sd = await invoke<{
                      available: boolean;
                      intervals: { start: number; end: number; duration: number }[];
                      note: string;
                    }>("detect_silence_intervals", { url, maxSecs: 180 });
                    if (sd.available) {
                      // Largest silence ≥1.5 s starting 30–180 s ≈ the
                      // OP→dialogue boundary (identical heuristic to
                      // SkipWindowButton's manual path).
                      const qualifying = sd.intervals
                        .filter((iv) => iv.duration >= 1.5 && iv.start >= 30 && iv.start <= 180)
                        .sort((a, b) => b.duration - a.duration);
                      // Only treat the dominant silence as an OP boundary
                      // if it's actually OP-shaped: it must END in the
                      // 60–110 s band (a real OP→content cut after a
                      // standard ~90 s opening) AND be clearly the single
                      // dominant pause (no comparable-length silence else-
                      // where in the first 3 min). Without these guards
                      // ANY show with an ordinary ≥1.5 s dialogue gap in
                      // 30–180 s got a bogus "OP 0-Ns" stamped — e.g.
                      // Witch Hat Atelier (no OP at all) reported OP
                      // 0-119s and then auto-skipped real content.
                      const top = qualifying[0];
                      const cand =
                        top &&
                        top.end >= 60 &&
                        top.end <= 110 &&
                        (qualifying.length < 2 ||
                          qualifying[1].duration < top.duration * 0.6)
                          ? top
                          : undefined;
                      if (cand) {
                        const opWin: PreparedWindow = {
                          type: "op",
                          start: 0,
                          end: cand.end,
                          source: "silencedetect",
                          auto: false,
                        };
                        // MERGE (not replace) so chapter ED windows
                        // already stamped above survive.
                        await invoke("set_skip_windows", {
                          payload: { windows: [...merged, opWin] },
                        });
                        console.info(
                          `[aniskip] silencedetect fallback → OP 0-${Math.round(cand.end)}s`,
                        );
                      } else {
                        console.info(`[aniskip] silencedetect: no obvious OP boundary`);
                      }
                    } else {
                      console.info(`[aniskip] silencedetect unavailable (ffmpeg not on PATH)`);
                    }
                  } catch (e) {
                    console.warn(`[aniskip] silencedetect fallback failed: ${String(e)}`);
                  }
                }
                // Hybrid-mode ED fallback. When NOTHING upstream gave an
                // ED (no AniSkip ED, no titled/heuristic chapter ED →
                // `lastEdStart == null`), tail-scan the stream's last
                // few minutes for the credits boundary (one bounded
                // ffmpeg pass, blackdetect + silencedetect, NO 90×
                // scan). We do NOT stamp a skip window (no reliable end
                // without the container duration) — we only hand the
                // Next-Up CTA an ED-start so it fires on time for
                // live-action / any series AniSkip + chapters miss.
                if (url && lastEdStart == null && modeFor("ed") !== "off") {
                  try {
                    const ob = await invoke<{
                      available: boolean;
                      ed_start: number | null;
                      note: string;
                    }>("detect_outro_boundary", { url, tailSecs: 330 });
                    if (ob.available && ob.ed_start != null && ob.ed_start > 0) {
                      window.dispatchEvent(new CustomEvent<number>("aura:ed-start-time", {
                        detail: ob.ed_start,
                      }));
                      console.info(
                        `[aniskip] outro tail-scan → ED≈${Math.round(ob.ed_start)}s (next-up timing)`,
                      );
                    } else {
                      console.info(`[aniskip] outro tail-scan: ${ob.note}`);
                    }
                  } catch (e) {
                    console.warn(`[aniskip] outro tail-scan failed: ${String(e)}`);
                  }
                }
              } catch (err) {
                console.warn(`[aniskip] finish/chapter merge failed: ${String(err)}`);
              }
            };

            // Resolve mal_id via the meta-detail cache. The detail
            // fetch is shared with the buffering-overlay path so it's
            // already warm by the time we get here.
            const seriesId = target.series_id ?? target.id;
            const detail = await getMetaDetailFallback(addons, target.media_type, seriesId);
            // Resolution cascade — first id-based via yuna.moe, then a
            // title-based Jikan lookup as a last resort. The id-based
            // path is preferred because it's exact and free of false
            // positives, but for IMDb-keyed anime (the common case —
            // tt22248376 = Frieren via Stremio) AIOMetadata's response
            // typically has NO anime ids populated. Without the title
            // fallback the AniSkip feature silently does nothing for
            // most series.
            // Resolve the COUR-SPECIFIC MAL id. AniSkip keys by MAL
            // anime id and MAL splits multi-cour shows into separate
            // entries — Frieren's cour 1 is MAL 52991 (eps 1-28), cour
            // 2 is MAL 59978 (eps 1-10 LOCAL). Querying cour 1's MAL
            // id with the absolute episode 37 returns 404 (cour 1 ends
            // at 28); querying cour 2's MAL id with local episode 9
            // returns the correct timings.
            //
            // Resolution priority:
            //   1. Anime-prefix video id (kitsu/mal/anidb/anilist) →
            //      extract the cour-specific show id from target.id
            //      and resolve via yuna.moe. AIOMetadata's cour-
            //      aggregation patch encodes the cour-specific
            //      provider id directly, so this is exact.
            //   2. detail.mal_id / detail.kitsu_id / detail.anidb_id /
            //      detail.anilist_id — show-root anime ids from the
            //      meta detail. These are typically cour 1's ids for
            //      multi-cour shows, so they only match for cour 1
            //      playback.
            //   3. Title-based Jikan search — last-resort fuzzy match.
            //
            // AIOMetadata may also stamp the cour-specific malId
            // directly on the video as `mal_id` — we'd accept that
            // if AIOMetadata starts emitting it, but the wire shape
            // is parsed off the video id below.
            let malId: number | null = null;
            const tryResolve = async (src: "kitsu" | "anidb" | "anilist", id: number | null | undefined) => {
              if (!id) return null;
              try {
                return await invoke<number | null>("resolve_mal_id", { source: src, id });
              } catch { return null; }
            };
            // Step 1 — parse cour-specific show id from target.id.
            // `kitsu:49240:9` → ("kitsu", 49240); `mal:59978:9` is
            // already the MAL id (no round-trip needed).
            const idSegments = target.id.split(":");
            if (idSegments.length === 3) {
              const provider = idSegments[0].toLowerCase();
              const showId = Number(idSegments[1]);
              if (Number.isFinite(showId)) {
                if (provider === "mal") {
                  malId = showId;
                } else if (provider === "kitsu" || provider === "anidb" || provider === "anilist") {
                  malId = await tryResolve(provider as "kitsu" | "anidb" | "anilist", showId);
                }
              }
            }
            // Step 2 — meta-detail anime ids. Only hit when step 1
            // didn't resolve (legacy tt-style ids or unrecognised
            // prefix).
            if (!malId) {
              malId = detail?.mal_id ?? null;
            }
            if (!malId) {
              malId = await tryResolve("kitsu",   detail?.kitsu_id)
                   ?? await tryResolve("anidb",   detail?.anidb_id)
                   ?? await tryResolve("anilist", (detail as { anilist_id?: number | null } | null)?.anilist_id);
            }
            if (!malId && detail?.name) {
              // Year hint from `release_info` ("2023" or "2023-2024").
              // Jikan's TV-only filter plus exact-title scoring keeps
              // false positives at bay; we never accept a fuzzy match.
              const yearMatch = (detail.release_info ?? "").match(/\b(19|20)\d{2}\b/);
              const year = yearMatch ? Number(yearMatch[0]) : null;
              try {
                malId = await invoke<number | null>("resolve_mal_id_by_title", {
                  title: detail.name,
                  year,
                });
              } catch { /* leave null, falls through to skip log */ }
            }
            if (!malId) {
              // Live-action, or anime we couldn't resolve to a MAL id
              // (IMDb-keyed with no anime ids + no Jikan title hit).
              // No AniSkip data — fall straight through to the chapter
              // path so chaptered live-action series still get skip
              // windows. THIS is the anime-only → any-series extension.
              console.info(`[aniskip] no mal_id for ${seriesId} — chapter-only skip path`);
              await finishWithChapters([], { silenceUrl: stream.url ?? null });
              return;
            }
            // Mal-id was resolved → this is an anime; mark for future
            // sessions so isAnimeMeta-dependent surfaces (right-click
            // menus, audio-language defaults) classify it correctly
            // before DetailView is ever opened.
            markAnimeId(seriesId);
            // Episode number for AniSkip lookup. AniSkip indexes by
            // MAL anime id + LOCAL episode (1-based within that MAL
            // entry, NOT show-wide absolute). MAL splits multi-cour
            // shows into separate entries — Frieren cour 2 is MAL
            // 59978 with episodes 1-10 LOCAL (= global 29-38).
            // Querying cour 1's MAL id with absolute 37 → 404; cour 2's
            // MAL id with local 9 → correct timings.
            //
            // The malId resolution above already picked the cour-
            // specific entry by parsing the cour-specific show id
            // from target.id, so the matching episode here is
            // VideoEntry's `episode_num` (which is cour-relative for
            // cour-aggregated shows). Falls back to id-derived
            // trailing segment for shows whose VideoEntry lacks the
            // field.
            const idParts = target.id.split(":");
            const idEpisode = Number(idParts[idParts.length - 1]);
            const episodeNum = Number.isFinite(target.episode_num as number)
              ? (target.episode_num as number)
              : idEpisode;
            if (!Number.isFinite(episodeNum)) {
              // Can't index AniSkip without an episode number, but a
              // chaptered file can still yield skip windows.
              console.info(`[aniskip] couldn't parse episode from ${target.id} — chapter-only`);
              await finishWithChapters([], { silenceUrl: stream.url ?? null });
              return;
            }
            console.info(
              `[aniskip] episode resolution: id-derived=${idEpisode}, ` +
              `cour-relative=${target.episode_num}, using=${episodeNum} ` +
              `(against mal=${malId})`,
            );
            // AniSkip fetch (settings / modeFor / all-off were handled
            // up top). On found → build prepared windows; on
            // not-found / network failure → prepared stays empty and
            // we still fall through to the chapter augment.
            let prepared: PreparedWindow[] = [];
            try {
              const cacheKey = `${malId}:${episodeNum}:${treatMixed ? 1 : 0}`;
              let result = aniskipCache.get(cacheKey);
              if (!result) {
                result = await invoke<AniSkipResult>(
                  "fetch_skip_windows",
                  {
                    malId,
                    episode: episodeNum,
                    episodeLength: 0,
                    treatMixedOpAsOp: treatMixed,
                  },
                );
                // Cache only successful resolutions — not-found can flip
                // to found after community contribution lands.
                if (result.found && result.windows.length > 0) {
                  aniskipCache.set(cacheKey, result);
                }
              } else {
                console.info(`[aniskip] cache hit mal=${malId} ep=${episodeNum}`);
              }
              if (result.found && result.windows.length > 0) {
                prepared = result.windows
                  .filter((w) => modeFor(w.kind) !== "off")
                  .map((w) => ({
                    type:    w.kind,
                    start:   w.start,
                    end:     w.end,
                    source:  w.source,
                    auto:    modeFor(w.kind) === "auto",
                    skip_id: w.skip_id ?? null,
                  }));
              }
            } catch (err) {
              // AniSkip network/parse failure is non-fatal — chapter +
              // heuristic windows still run via finishWithChapters.
              console.warn(`[aniskip] lookup failed: ${String(err)}`);
            }
            // ALWAYS augment with chapters (even on an empty AniSkip
            // result): anime with no AniSkip data gets the same
            // chapter / heuristic treatment as live-action. Passing
            // `silenceUrl` arms the auto silencedetect OP fallback for
            // this (MAL-resolved) path only — the no-mal / no-episode
            // exits above intentionally don't, to avoid a heavy ffmpeg
            // scan on every live-action open.
            await finishWithChapters(prepared, { silenceUrl: stream.url ?? null });
          })();
        }
        // Stash the DIRECT raw URL (not the bridge-proxied form) so Copy /
        // Download / External-player open the genuine source — proxying
        // through 127.0.0.1 makes no sense for those utilities.
        setActiveStreamUrl(stream.url ?? null);
        // Look up the logo for the buffering overlay. Try the selected meta
        // (the exact card the user clicked) first, falling back to the
        // selected library item.
        const logo =
          selectedMeta?.logo ??
          library.find((i) => i.id === target.id)?.logo ??
          null;
        // absolute_episode_num is patched in by the async effect
        // below — computing it inline would require awaiting the meta
        // detail BEFORE we can flip activeTarget, which would block
        // the play flow on a potentially slow (cold-cache) fetch.
        // The effect resolves it within milliseconds when the cache
        // is warm; on cold-cache it lands well before the 120-second
        // scrobble_start warmup, so the Trakt absolute fallback has
        // the value it needs.
        setActiveTarget({
          id:            target.id,
          series_id:     target.series_id,
          media_type:    target.media_type,
          name:          target.name,
          episode:       target.episode,
          episode_title: target.episode_title,
          // Authoritative numeric S/E from the picker — thread through
          // so scrobble.rs's Trakt payload uses the same numbers the
          // user clicked on, sidestepping ID-string parse mismatches.
          season:        target.season,
          episode_num:   target.episode_num,
          logo,
          // Carry the scoring signals through to scrobble's anime
          // detector. Without these the AniList path saw
          // `genres=undefined` for every Cinemeta IMDB session and
          // short-circuited at `if !sess.is_anime` in scrobble.rs.
          genres:               target.scoring?.genres ?? null,
          original_language:    target.scoring?.original_language ?? null,
          production_countries: target.scoring?.production_countries ?? null,
        });
        setActiveScoringMeta(target.scoring ?? null);
        // Intentionally NOT closing the DetailView here. Keeping
        // `selectedMeta` populated means that when the user exits
        // playback (or hits Esc), they're returned to the stream /
        // episode picker they came from instead of the home grid.
        // DetailView is unmounted while `isPlayerActive` so it doesn't
        // paint behind the player — see the conditional render below.
      } catch (e) {
        console.error("Stream load failed", e);
      }
    },
    [closeDetail, selectedMeta, library]
  );

  // ── External subtitles fetch ──────────────────────────────────────────
  // Fires once per activeTarget after MPV has produced a duration. We
  // capture the raw addon list and surface it to PlayerOverlay so the
  // subtitle dropdown can merge external entries with MPV's track-list.
  // We DO NOT auto-`sub-add` every track up front any more — that storm
  // crashed playback in earlier phases. The user picks one from the menu;
  // PlayerOverlay calls `add_subtitle_to_mpv` lazily for the chosen URL.
  const subsFetchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTarget) return;
    const key = `${activeTarget.media_type}:${activeTarget.id}`;
    if (subsFetchedFor.current === key) return;
    subsFetchedFor.current = key;

    invoke<ExternalSubtitle[]>("fetch_external_subtitles", {
      addons,
      mediaType: activeTarget.media_type,
      id:        activeTarget.id,
    })
      .then((subs) => setActiveExternalSubs(subs ?? []))
      .catch(() => setActiveExternalSubs([]));
  }, [activeTarget, addons]);

  // ── Subtitle picker overlay ──
  const [subsOpen, setSubsOpen] = useState(false);

  // ── Keybindings + preferred subtitle language ──
  // Both come from the backend `AppSettings`. The preferred subs lang
  // drives the PlayerOverlay's subtitle-list ordering (selected language
  // pulled to the top). Reload on `aura:keybindings-changed` (also fires
  // for general settings updates).
  const [keybindings, setKeybindings] = useState<Record<string, string>>({});
  // We keep all four lang prefs in state; the *preferred* values passed
  // to PlayerOverlay are derived per-stream from `isAnimeMeta(activeTarget)`
  // so anime defaults (typically ja audio + en subs) only apply to anime
  // and never bleed into Western movies/series.
  // Audio defaults live entirely inside `audio_priority` (with the
  // "original" token resolving to AIOMetadata's `original_language`).
  // Subtitles use a single global preference; per-title state can
  // override when needed.
  const [subtitleLanguage,   setSubtitleLanguage]   = useState<string | null>(null);
  const [selectableSubLangs, setSelectableSubLangs] = useState<string[]>([]);
  const [audioPriority,      setAudioPriority]      = useState<string[]>([]);
  const [avoidDubs,          setAvoidDubs]          = useState(false);
  const [userRegion,         setUserRegion]         = useState("");
  const [nextUpLeadSeconds,  setNextUpLeadSeconds]  = useState(60);
  useEffect(() => {
    const loadSettings = () =>
      invoke<{
        keybindings: Record<string, string>;
        subtitle_language?: string;
        selectable_subtitle_languages?: string[];
        audio_priority?: string[];
        avoid_dubs?: boolean;
        user_region?: string;
        next_up_lead_seconds?: number;
      }>("get_settings")
        .then((s) => {
          setKeybindings(s.keybindings ?? {});
          setSubtitleLanguage(s.subtitle_language ?? null);
          setSelectableSubLangs(s.selectable_subtitle_languages ?? []);
          setAudioPriority(s.audio_priority ?? []);
          setAvoidDubs(!!s.avoid_dubs);
          setUserRegion(s.user_region ?? "");
          if (typeof s.next_up_lead_seconds === "number") {
            // Clamp here mirroring the Settings UI clamp [0, 300].
            // 0 means the user disabled the CTA entirely.
            setNextUpLeadSeconds(Math.max(0, Math.min(300, s.next_up_lead_seconds)));
          }
        })
        .catch(() => {});
    loadSettings();
    const onChange = () => loadSettings();
    window.addEventListener("aura:keybindings-changed", onChange);
    window.addEventListener("aura:settings-changed", onChange);
    return () => {
      window.removeEventListener("aura:keybindings-changed", onChange);
      window.removeEventListener("aura:settings-changed", onChange);
    };
  }, []);

  // ── Show-login event listener ──
  // Components without a direct callback prop to surface the LoginView
  // (e.g. Settings → Cloud Sync's guest-state Sign-In button) dispatch
  // `aura:show-login` and we surface the modal here. Cheap; one
  // listener, one setter call.
  useEffect(() => {
    const onShow = () => setShowLogin(true);
    window.addEventListener("aura:show-login", onShow);
    return () => window.removeEventListener("aura:show-login", onShow);
  }, []);

  // ── Reopen-onboarding-addons event listener ──
  // AddonsView's "Reopen onboarding addons" button fires
  // `aura:onboarding-reopen-addons`; remount the wizard at step 2 so the
  // user can revisit just the suggested-addons page without re-running
  // steps 0 (import) and 1 (settings).
  useEffect(() => {
    const onReopen = () => {
      setOnboardingStartAddons(true);
      setOnboardingActive(true);
    };
    window.addEventListener("aura:onboarding-reopen-addons", onReopen);
    return () => window.removeEventListener("aura:onboarding-reopen-addons", onReopen);
  }, []);

  // ── Finish-onboarding event listener ──
  // The wizard's "Open Trakt & AniList settings" jump finishes the
  // wizard outright (markOnboardingComplete already fired in the
  // button) and dispatches this event so we unmount the OnboardingView
  // and let the settings-deep-link router land the user on Settings.
  useEffect(() => {
    const onFinish = () => {
      setOnboardingActive(false);
      setOnboardingStartAddons(false);
    };
    window.addEventListener("aura:onboarding-finish", onFinish);
    return () => window.removeEventListener("aura:onboarding-finish", onFinish);
  }, []);

  // ── Session-changed broadcast ──
  // Decoupled components (SyncStatusChip in the title bar, profile
  // popover, etc.) need to know when the active Stremio session
  // changes so they can refresh their cloud-side state without
  // waiting for the next poll cycle. Single useEffect that fires on
  // every session transition (sign-in, sign-out, account switch).
  // Carries the auth_key prefix (or null) in detail so subscribers
  // can decide whether to clear local cached state too.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("aura:session-changed", {
      detail: { authKey: session?.auth_key ?? null },
    }));
  }, [session]);

  // ── Settings-deep-link router ──
  // Components that aren't in the NavSidebar's prop tree (TitleBar's
  // SyncStatusChip, NotificationsPanel action items, etc.) can request
  // a jump to a specific Settings section via:
  //   window.dispatchEvent(new CustomEvent("aura:open-settings", {
  //     detail: { section: "sec-cloud-sync" }
  //   }))
  // We route the user to Settings; the section anchor is consumed by
  // SettingsView's TOC scroll-spy which will scroll the matching
  // section into view on next paint if `section` is non-empty.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ section?: string }>).detail;
      setActiveCatalog(null);
      setActiveView("settings");
      if (detail?.section && typeof detail.section === "string") {
        // Defer scroll until SettingsView has mounted (one paint is
        // enough; useEffect inside SettingsView runs on its mount).
        // Encode the requested anchor in the URL hash so SettingsView's
        // scroll-spy can pick it up regardless of whether the user is
        // already on Settings (no remount).
        window.location.hash = detail.section;
      }
    };
    window.addEventListener("aura:open-settings", onOpen);
    return () => window.removeEventListener("aura:open-settings", onOpen);
  }, []);

  // ── Reduced-motion attribute live-updater ──
  // main.tsx runs the initial application synchronously before React
  // mounts, so the first paint already carries the right attribute.
  // This effect keeps the attribute in sync with:
  //   • OS-level `prefers-reduced-motion` changes (user flips the OS
  //     toggle without restarting Aura)
  //   • Aura-level `reduceMotion` setting changes (user toggles via
  //     Settings → Appearance — dispatches `aura:settings-changed`)
  // Lazy import (`require` style via dynamic) would defeat the
  // tree-shake, so we import statically from auraSettings; the
  // function is a one-line DOM write so the bundle cost is trivial.
  useEffect(() => {
    let importedApply: (() => void) | null = null;
    import("./auraSettings").then((mod) => {
      importedApply = mod.applyReducedMotionAttribute;
      importedApply();
    });
    const apply = () => importedApply?.();
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", apply);
    window.addEventListener("aura:settings-changed", apply);
    return () => {
      mq.removeEventListener("change", apply);
      window.removeEventListener("aura:settings-changed", apply);
    };
  }, []);

  // ── Per-title saved state (volume / shader / audio_lang / sub_lang) ──
  // Loaded once per activeTarget and applied. The audio/sub language values
  // override the global / anime lang defaults when present, so a user who
  // picked Spanish audio for a specific show keeps Spanish on every replay.
  const [titleOverrides, setTitleOverrides] = useState<{
    audio_lang?: string | null;
    sub_lang?:   string | null;
  } | null>(null);
  useEffect(() => {
    if (!activeTarget) { setTitleOverrides(null); return; }
    let cancelled = false;
    getTitleState(activeTarget.media_type, activeTarget.id).then((st) => {
      if (cancelled || !st) { setTitleOverrides(null); return; }
      setTitleOverrides({ audio_lang: st.audio_lang, sub_lang: st.sub_lang });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [activeTarget]);

  // ── Next-Up CTA ───────────────────────────────────────────────────────
  // Resolves the next aired episode + its first available stream when
  // the user is in the final stretch of an episode, so a single click
  // jumps straight to the next playback. Only mounts for series / anime;
  // movies and standalone files never trigger.
  //
  // The flow is split into TWO phases so the CTA appears immediately
  // when the trigger fires (instead of waiting for the addon round-trip
  // to land first, which is what made the card "only show in the last
  // second" — by remaining=60 s the resolution kicked off, but
  // fetch_streams against multiple addons takes 5–30 s):
  //
  //   1. PRE-RESOLVE  — once playback crosses 50 % progress (or
  //      remaining < 2× leadSeconds, whichever comes first), kick off
  //      the meta + streams resolution in the background. Result is
  //      cached in state and READY by the time the display gate trips.
  //
  //   2. DISPLAY GATE — render the CTA when:
  //      • the ED chapter has ENDED (anime, if AniSkip / chapter
  //        merge surfaced an ED via `aura:ed-end-time`), OR
  //      • duration - time <= leadSeconds (universal fallback), OR
  //      • EOF (file ended early; metadata duration was wrong).
  //
  // The lead time is settable in Settings → Video & Audio (clamped
  // 0..300; 0 = disabled).
  const [nextUpInfo, setNextUpInfo] = useState<{
    episode:  VideoEntry;
    stream:   StreamEntry | null;
  } | null>(null);
  /** Per-episode dismiss flag. Keyed by the CURRENT episode's id (not
   *  the next-up id) so dismissing while watching S01E05 only suppresses
   *  the suggestion for THIS playback; opening S01E06 fresh produces a
   *  new CTA when its own end approaches. */
  const nextUpDismissedFor = useRef<string | null>(null);
  /** Sticky resolution flag — when we've already resolved a candidate
   *  (or determined there isn't one) for the active target, don't keep
   *  poking the addons every tick. Reset on activeTarget change. */
  const nextUpResolvedFor = useRef<string | null>(null);
  /** ED-chapter START time in seconds, captured by the AniSkip /
   *  chapter-merge flow inside handlePlayStream. When set, the
   *  display gate fires the moment playback time crosses this value
   *  — same instant the in-player "Skip ending? Press X" prompt
   *  appears. Reset on activeTarget change. */
  const nextUpEdStartRef = useRef<number | null>(null);
  /** Display flag derived from the conditions above. Driving this
   *  through state (rather than computing inline at render) lets us
   *  log the transition once for debugging without spamming the
   *  per-tick render. */
  const [nextUpVisible, setNextUpVisible] = useState(false);

  // ── EOS Spotlight (2026-05-19) ──────────────────────────────────────
  // `eosActive` is the App-owned carrier for the end-of-stream screen.
  // It is set ONLY via the `aura:eos-detected` window event dispatched
  // from usePlayback's detectors (playback-end reason="eof" OR a near-
  // end stale-heartbeat ≤5 s from duration). usePlayback deliberately
  // does NOT own this state — App clears it on every new load / target
  // change (the reset effect below) and on handleExitPlayback so a
  // re-watch or episode swap starts clean. Mounting the Spotlight
  // suppresses the small NextUpCta (mutual exclusion in the JSX gate).
  const [eosActive, setEosActive] = useState(false);
  // Mirror `paused` into a ref so the eos-detected listener can read it
  // without stale closures (the listener is registered once and lives
  // across renders).
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  useEffect(() => {
    const onEos = () => {
      setEosActive(true);
      // Pause mpv at the last frame. This silences the 1 Hz stale-
      // heartbeat detector's `if (paused) return` short-circuit, so no
      // further eos-detected can re-dispatch after the user dismisses.
      // togglePause is a CYCLE on mpv (landmine #1 — not set_property);
      // gate on pausedRef so we don't accidentally unpause an already-
      // paused stream.
      if (!pausedRef.current) togglePause();
    };
    window.addEventListener("aura:eos-detected", onEos);
    return () => window.removeEventListener("aura:eos-detected", onEos);
  }, [togglePause]);

  // Listen for ED-start updates from the AniSkip pipeline. The event
  // is dispatched from inside handlePlayStream's lookup IIFE.
  useEffect(() => {
    const onEdStart = (e: Event) => {
      const detail = (e as CustomEvent<number>).detail;
      if (typeof detail === "number" && Number.isFinite(detail) && detail > 0) {
        nextUpEdStartRef.current = detail;
      }
    };
    window.addEventListener("aura:ed-start-time", onEdStart);
    return () => window.removeEventListener("aura:ed-start-time", onEdStart);
  }, []);

  // Reset CTA state whenever the active target changes (new playback).
  // This is also the canonical "new load" boundary for the EOS
  // Spotlight: every load_video site (DetailView pick, NextUp/Spotlight
  // Play-Next, Reload) routes through a setActiveTarget, so clearing
  // eosActive here covers all of them without touching usePlayback's
  // notifyNewLoad. handleExitPlayback also clears it explicitly.
  useEffect(() => {
    setNextUpInfo(null);
    setNextUpVisible(false);
    setEosActive(false);
    nextUpResolvedFor.current = null;
    nextUpEdStartRef.current = null;
    // Don't reset nextUpDismissedFor here — App.tsx unmounts the
    // PlayerOverlay on exit which clears activeTarget; clearing the
    // dismiss ref on EVERY target change would re-show the CTA after
    // the user dismissed it, hopped to the detail picker, and came
    // back. Instead clear it lazily when the new key differs:
    if (
      activeTarget &&
      nextUpDismissedFor.current &&
      nextUpDismissedFor.current !== activeTarget.id
    ) {
      nextUpDismissedFor.current = null;
    }
  }, [activeTarget]);

  // PRE-RESOLVE effect — fires at 50 % progress (or sooner if the
  // episode is short / the lead is large). The actual fetch is
  // deduped via `nextUpResolvedFor` so it only runs once per target.
  // Network round-trips can take 5–30 s depending on the addon set
  // — kicking it off mid-episode means data is ready by the time
  // the display gate trips.
  useEffect(() => {
    if (!activeTarget) return;
    if (nextUpLeadSeconds <= 0) return; // user disabled the feature
    if (!duration || duration <= 0) return;
    if (!addons || addons.length === 0) return;
    const mt = (activeTarget.media_type ?? "").toLowerCase();
    if (mt !== "series" && mt !== "anime") return;
    if (nextUpDismissedFor.current === activeTarget.id) return;
    if (nextUpResolvedFor.current === activeTarget.id) return;

    const ratio = time / duration;
    const remaining = duration - time;
    // Trigger pre-resolve at 50 % ratio OR remaining ≤ leadSeconds*2,
    // whichever fires first. The lead*2 floor catches resumed-near-end
    // sessions where the user joined past the 50 % mark.
    if (ratio < 0.5 && remaining > nextUpLeadSeconds * 2) return;

    nextUpResolvedFor.current = activeTarget.id;
    const seriesId = activeTarget.series_id ?? activeTarget.id;
    const mediaType = activeTarget.media_type;
    const currentId = activeTarget.id;

    void (async () => {
      const next = await resolveNextEpisode(addons, mediaType, seriesId, currentId, loadAuraSettings().nextUpSkipFillerRecap);
      if (!next) {
        // No further aired episode — leave the CTA unmounted. The
        // resolved-for guard prevents another lookup until the user
        // navigates to a different episode.
        return;
      }
      // Pre-fetch the first stream so the user's click feels instant.
      // If this returns null we still show the CTA but with a
      // "no stream found" hint rather than a play button.
      const stream = await pickFirstStreamForEpisode(addons, mediaType, next.next.id);
      // Guard against state changes during the await — only commit if
      // the active target hasn't moved on (user could have hit Next /
      // Back during the resolution).
      if (nextUpResolvedFor.current === currentId) {
        setNextUpInfo({ episode: next.next, stream });
      }
    })();
  }, [activeTarget, time, duration, addons, nextUpLeadSeconds]);

  // DISPLAY-GATE effect — flips the CTA on once the user has hit
  // either the ED-end mark (anime, when known) OR the lead-time
  // window. Once on, stays on until activeTarget changes or the user
  // dismisses.
  useEffect(() => {
    if (!activeTarget) {
      if (nextUpVisible) setNextUpVisible(false);
      return;
    }
    if (!nextUpInfo) return;
    if (nextUpDismissedFor.current === activeTarget.id) return;
    if (nextUpVisible) return;
    const remaining = duration - time;
    const edStart = nextUpEdStartRef.current;
    // Sanity-gate the ED start: a real end-credits boundary is in the
    // back half of the runtime. Ignoring an implausibly-early edStart
    // keeps a bad value (e.g. a future regression in the tail-scan
    // timestamp math) from firing Next-Up mid-episode the instant the
    // 50 %-gated pre-resolve completes.
    const edTriggered =
      edStart != null && duration > 0 && edStart >= duration * 0.5 && time >= edStart;
    const leadTriggered =
      nextUpLeadSeconds > 0 && duration > 0 && remaining <= nextUpLeadSeconds && remaining > 0;
    if (edTriggered || leadTriggered) {
      setNextUpVisible(true);
    }
  }, [activeTarget, time, duration, nextUpInfo, nextUpLeadSeconds, nextUpVisible]);

  // "Hard EOF" NextUp forcer REMOVED (EOS Spotlight, 2026-05-19): it
  // was gated on the dead `eof` carrier (Rust never sets
  // PlaybackState.eof) so it never ran. End-of-stream now surfaces the
  // EOS Spotlight (App-level, gated on `eosActive`), which resolves the
  // next episode itself and supersedes the small NextUpCta — so the
  // "container reports a longer duration than the actual content" case
  // is covered by the Spotlight's own resolveNextEpisode call.

  /** Click-handler for the Next-Up CTA — flushes the current episode's
   *  resume offset, then routes the resolved stream + target through
   *  the same handlePlayStream the DetailView uses. The episode tag
   *  ("S02E01" etc.) is reconstructed from the VideoEntry's parsed
   *  fields so the OSD / SMTC titles look right. */
  const onNextUpPlay = useCallback(async () => {
    if (!nextUpInfo || !activeTarget || !nextUpInfo.stream) return;
    const seriesId = activeTarget.series_id ?? activeTarget.id;

    // ── Record CURRENT episode into history before advancing ──
    // handlePlayStream swaps the active target without going through
    // handleExitPlayback, which is where the history-append normally
    // fires. Without this block, an episode finished via "Play next
    // episode" never lands in the History view (or in any of the
    // downstream consumers — recommendations, etc.). Mirrors the gate
    // in handleExitPlayback: meaningful = ≥ 80% AND ≥ 5 min watched.
    {
      const { time: watched, duration: dur } = playbackRef.current;
      const meaningfulRatio = dur > 0 && watched / dur >= 0.80;
      const meaningfulTime  = watched >= 5 * 60;
      const playedEpisodeId = activeTarget.id;
      const isSeriesEpisode = activeTarget.series_id != null && activeTarget.series_id !== activeTarget.id;
      if (meaningfulRatio && meaningfulTime && playedEpisodeId) {
        // Same VideoEntry-first / id-parse-fallback shape as
        // handleExitPlayback's history append — see that block for
        // the rationale (post-AIOMetadata-patch non-tt ids would
        // otherwise mis-parse provider id as season).
        let season: number | null = activeTarget.season ?? null;
        let episode: number | null = activeTarget.episode_num ?? null;
        if (isSeriesEpisode
            && (season == null || episode == null)
            && playedEpisodeId.startsWith("tt")) {
          const parts = playedEpisodeId.split(":");
          if (parts.length >= 3) {
            const s = Number(parts[parts.length - 2]);
            const e = Number(parts[parts.length - 1]);
            if (season == null && Number.isFinite(s)) season = s;
            if (episode == null && Number.isFinite(e)) episode = e;
          }
        }
        const libRecord = library.find((i) => i.id === seriesId) ?? null;
        addHistoryEntry({
          id:            playedEpisodeId,
          parent_id:     isSeriesEpisode ? seriesId : undefined,
          name:          activeTarget.name,
          media_type:    activeTarget.media_type,
          poster:        libRecord?.poster ?? selectedMeta?.poster ?? null,
          background:    libRecord?.background ?? selectedMeta?.background ?? null,
          season,
          episode,
          episode_title: activeTarget.episode_title ?? null,
          played_at:     new Date().toISOString(),
          duration:      dur || undefined,
          watched_seconds: watched,
        });
      }
    }

    const ep = nextUpInfo.episode;
    const tag =
      ep.season != null && ep.episode != null
        ? `S${String(ep.season).padStart(2, "0")}E${String(ep.episode).padStart(2, "0")}`
        : ep.episode != null ? `Episode ${ep.episode}` : undefined;
    const target = {
      id:            ep.id,
      series_id:     seriesId,
      media_type:    activeTarget.media_type,
      name:          activeTarget.name,
      episode:       tag,
      episode_title: ep.title ?? undefined,
      season:        ep.season ?? undefined,
      episode_num:   ep.episode ?? undefined,
    };
    setNextUpInfo(null);
    await handlePlayStream(nextUpInfo.stream, target);
    // Allow the new target's CTA to arm when its own end approaches.
    nextUpResolvedFor.current = null;
  }, [nextUpInfo, activeTarget, library, selectedMeta]);

  const onNextUpDismiss = useCallback(() => {
    if (activeTarget) {
      nextUpDismissedFor.current = activeTarget.id;
    }
    setNextUpInfo(null);
  }, [activeTarget]);

  // ── EOS Spotlight wiring (2026-05-19) ───────────────────────────────
  // Pure id→LibraryItem index for the spoiler gate (mirrors what
  // LibraryProvider builds; passed to EosSpotlight + EpisodePanel so the
  // blur rule is byte-identical to DetailView without re-implementing).
  const libraryById = useMemo(() => {
    const m = new Map<string, LibraryItem>();
    for (const it of library) { if (!it.removed) m.set(it.id, it); }
    return m;
  }, [library]);

  // Resolution state for the Spotlight: idle (not at EOS) → resolving →
  // ready (a next episode exists; reuse `nextUpInfo`) | none (END-CARD:
  // movie / finale / caught-up-unaired). `eosCaughtUpUnaired` only flips
  // true when a LATER episode exists but hasn't aired yet (so the
  // END-CARD wording differs from a true finale).
  const [eosResolve, setEosResolve] = useState<"idle" | "resolving" | "ready" | "none">("idle");
  const [eosCaughtUpUnaired, setEosCaughtUpUnaired] = useState(false);
  const [eosEpisodesOpen, setEosEpisodesOpen] = useState(false);
  /** Episode id whose EOS resolution has already been kicked off, so
   *  the resolution effect's own `setEosResolve("resolving")` re-run
   *  doesn't fire a duplicate addon round-trip. Reset when the EOS
   *  screen tears down (eosActive false / target change). */
  const eosResolveStartedFor = useRef<string | null>(null);

  // Drive the resolution when the EOS screen activates. The pre-resolve
  // effect usually populated `nextUpInfo` already (fires at 50 %), so
  // the common path is an instant "ready". When it didn't (short
  // episode, resume-near-end, container shorter than metadata), resolve
  // here. Movies skip straight to END-CARD.
  useEffect(() => {
    if (!eosActive || !activeTarget) {
      setEosResolve("idle");
      setEosCaughtUpUnaired(false);
      setEosEpisodesOpen(false);
      eosResolveStartedFor.current = null;
      return;
    }
    const mt = (activeTarget.media_type ?? "").toLowerCase();
    const isSeriesLike = mt === "series" || mt === "anime";
    if (!isSeriesLike) { setEosResolve("none"); return; }
    if (nextUpInfo) { setEosResolve("ready"); return; }
    if (eosResolve === "ready" || eosResolve === "none") return;
    // Once per current episode: the setEosResolve("resolving") below
    // re-runs this effect, but the started-for ref keeps us from
    // firing a second addon fan-out.
    if (eosResolveStartedFor.current === activeTarget.id) return;
    eosResolveStartedFor.current = activeTarget.id;
    setEosResolve("resolving");
    const seriesId = activeTarget.series_id ?? activeTarget.id;
    const mediaType = activeTarget.media_type;
    const currentId = activeTarget.id;
    let cancelled = false;
    void (async () => {
      const res = await resolveNextEpisode(
        addons, mediaType, seriesId, currentId,
        loadAuraSettings().nextUpSkipFillerRecap,
      );
      if (cancelled) return;
      if (res) {
        const stream = await pickFirstStreamForEpisode(addons, mediaType, res.next.id);
        if (cancelled) return;
        setNextUpInfo({ episode: res.next, stream });
        setEosResolve("ready");
        return;
      }
      // No AIRED next episode. Distinguish "true finale" from "caught
      // up — next season not yet aired": re-run the walk ignoring the
      // aired filter (a far-future `now`); a hit there means a later
      // episode exists but simply hasn't aired.
      const detail =
        peekCachedDetailById(seriesId) ??
        (await getMetaDetailFallback(addons, mediaType, seriesId));
      if (cancelled) return;
      const laterIgnoringAir = detail
        ? findNextEpisode(detail, currentId, Number.MAX_SAFE_INTEGER,
            loadAuraSettings().nextUpSkipFillerRecap)
        : null;
      setEosCaughtUpUnaired(!!laterIgnoringAir);
      setEosResolve("none");
    })();
    return () => { cancelled = true; };
  }, [eosActive, activeTarget, addons, nextUpInfo, eosResolve]);
  // (EOS action handlers are defined just below handleExitPlayback —
  // they depend on it, which is declared later in this component.)

  // ── Global last-used volume ──
  // Volume is a property of the user's environment (headphones loud, TV
  // quiet) — NOT a property of the content. Save on user-initiated
  // changes (via commitVolumeAndSave) and re-apply on every stream load.
  useEffect(() => {
    if (!activeTarget) return;
    invoke<{ last_volume?: number }>("get_settings")
      .then((s) => {
        if (typeof s.last_volume === "number") {
          invoke("set_volume", { volume: s.last_volume }).catch(() => {});
        }
      })
      .catch(() => {});
  }, [activeTarget]);

  // Wrap commitVolume so user-driven changes also persist (debounced).
  // CRITICAL: save only fires for USER-initiated commits, not for the
  // polling sync that reads volume back from MPV. The previous version
  // saved on every `volume` state change, which raced with the
  // apply-saved-volume effect: MPV reported 0 momentarily during
  // loadfile, that landed in React state, and the save effect wrote
  // last_volume = 0 before the apply settled. End result: slider
  // showed 0 % while audio kept playing at the saved level.
  const volSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitVolumeAndSave = useCallback((v: number) => {
    commitVolume(v);
    if (volSaveTimer.current) clearTimeout(volSaveTimer.current);
    volSaveTimer.current = setTimeout(() => {
      invoke("update_settings", { patch: { last_volume: v } }).catch(() => {});
    }, 600);
  }, [commitVolume]);

  // ── Deep-link query (set from the Tauri deep-link event below) ──
  const [deepLinkSearch, setDeepLinkSearch] = useState<string | null>(null);

  // Recently-cleared CW items. Stremio's datastore is eventually consistent
  // on `_mtime` — even after a successful libraryClearProgress, a refetch
  // within the eventual-consistency window can return the OLD state with
  // a non-zero timeOffset, undoing the user's clear. We keep a 5-minute
  // post-clear window where we forcibly re-zero matching items in any
  // library_get response. After that the server should be settled.
  const recentlyCleared = useRef<Map<string, number>>(new Map());
  const CLEAR_WINDOW_MS = 5 * 60 * 1000;
  const overlayRecentClears = useCallback((items: LibraryItem[]): LibraryItem[] => {
    const now = Date.now();
    let dropped = 0;
    for (const [id, ts] of recentlyCleared.current.entries()) {
      if (now - ts > CLEAR_WINDOW_MS) {
        recentlyCleared.current.delete(id);
        dropped++;
      }
    }
    if (dropped) console.info(`[cw-clear] expired ${dropped} entries from recent-clear set`);
    if (recentlyCleared.current.size === 0) return items;
    return items.map((i) =>
      recentlyCleared.current.has(i.id)
        ? { ...i, state: { ...i.state, timeOffset: 0 } }
        : i
    );
  }, []);

  const loadLibrary = useCallback(async (sess: UserSession | null) => {
    if (!sess?.auth_key) { setLibrary([]); setRawLibrary([]); setLibraryLoaded(true); return; }
    // Warm-start from the localStorage cache so the user sees their library
    // instantly on app launch — Stremio's `datastoreGet` round-trip can take
    // a second or two on cold network. The cache is keyed by auth_key
    // prefix so it doesn't bleed across accounts. Replaced as soon as the
    // fresh fetch resolves below.
    const cacheKey = `aura:library:${sess.auth_key.slice(0, 12)}`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw) as LibraryItem[];
        if (Array.isArray(cached) && cached.length > 0) {
          setLibrary(overlayRecentClears(cached));
          setLibraryLoaded(true);
        }
      }
    } catch { /* malformed cache — ignore */ }

    try {
      const raw = await invoke<LibraryItem[]>("library_get", { authKey: sess.auth_key });
      // Collapse per-episode rows into one canonical entry per series root
      // BEFORE anything else sees the list. Library, Calendar, Continue
      // Watching all read the same `library` state — normalising at the
      // boundary means none of them have to repeat the dedup logic.
      const items = normalizeLibrary(raw);
      setRawLibrary(raw);
      setLibrary(overlayRecentClears(items));
      // Pull half of the watched-status sync — mirror cloud `aura_watched`
      // flags into the local manualWatched store. Idempotent; only
      // promotes null → "watched" so it never clobbers an explicit
      // local in-progress / planned mark mid-flight.
      mirrorWatchedFromCloud(items);
      // Seed the anime-id cache from any library item whose state
      // already carries genres. Without this seed, the Library page's
      // anime filter (and right-click menu's anime detection) only
      // catches items the user has opened DetailView for. Library
      // hydrates on every login + every aura:library-changed re-fetch,
      // so this also keeps the cache fresh as new entries arrive.
      for (const it of items) {
        const stateGenres = (it.state ?? {}).genres;
        if (Array.isArray(stateGenres)) {
          const hasAnime = stateGenres.some(
            (g) => typeof g === "string" && /^anime$/i.test(g.trim()),
          );
          const t = (it.media_type ?? "").toLowerCase();
          const hasAnimationSeries = (t === "series" || t === "anime") && stateGenres.some(
            (g) => typeof g === "string" && /^animation$/i.test(g.trim()),
          );
          if (hasAnime || hasAnimationSeries) markAnimeId(it.id);
        }
      }
      // Diagnostic — surfaces phantom situations (multiple raw rows
      // collapsed into one normalized row) in the DevConsole. The
      // libraryRemoveAll path uses the same raw array to surgically
      // delete every contributor.
      const collapsed = raw.length - items.length;
      console.info(
        `[library] library_get raw=${raw.length} normalized=${items.length}` +
          (collapsed > 0 ? ` (collapsed ${collapsed} duplicate/episode rows)` : ""),
      );
      try {
        localStorage.setItem(cacheKey, JSON.stringify(items));
      } catch { /* quota exceeded — non-fatal */ }
    } catch (err) {
      if (String(err) === SESSION_EXPIRED) {
        await invoke("logout").catch(() => {});
        setSession(null);
        setLibrary([]); setRawLibrary([]);
      }
      // Other errors silently leave library empty — calendar/Continue Watching
      // will just show empty states.
    } finally {
      setLibraryLoaded(true);
    }
  }, [overlayRecentClears]);

  // ── Session expired ──
  const handleSessionExpired = useCallback(async () => {
    await invoke("logout").catch(() => {});
    setSession(null);
    setLibrary([]); setRawLibrary([]);
    invoke<AddonEntry[]>("list_addons").then(setAddons).catch(() => setAddons([]));
  }, []);

  // ── Library refresh — fires after any context-menu library toggle ──
  useEffect(() => {
    const onChange = () => { if (session) loadLibrary(session); };
    window.addEventListener("aura:library-changed", onChange);
    return () => window.removeEventListener("aura:library-changed", onChange);
  }, [session, loadLibrary]);

  // ── Release-signal reconciliation (Phase 9) ──
  // Fires whenever the library list changes or the session swaps.
  // Batch-fetches release signals from Aura Cloud and writes them
  // into releaseSignalStore for downstream consumers (CW banners,
  // notifications scanner, detail page episode_kinds enrichment).
  // Bails internally for guests + opted-out users — no need to gate
  // here. Errors are logged but never thrown; the existing per-user
  // addon probe paths remain the fallback. See
  // docs/release-search-spec.md §6.2.
  useEffect(() => {
    if (library.length === 0) return;
    void reconcileLibraryReleaseSignals(library, !session?.auth_key);
  }, [library, session?.auth_key]);

  // Clear the store on sign-out / account switch so signals from a
  // prior scope don't leak into the next account's surfaces.
  useEffect(() => {
    if (!session?.auth_key) clearReleaseSignalStore();
  }, [session?.auth_key]);

  // Library sync. Stremio's server is eventually-consistent on `_mtime`
  // — pulling within ~30 seconds of a local write rounds-tripped the
  // old state back (the server's diff-by-mtime hasn't seen our update
  // yet). Bumped to 5 minutes after observing the row reappear at the
  // 30-second mark; Stremio's settle time can run that long. The
  // recent-clear overlay above also catches anything that slips through.
  const lastWriteRef = useRef(0);
  useEffect(() => {
    const onWrite = () => { lastWriteRef.current = Date.now(); };
    window.addEventListener("aura:library-write", onWrite);
    return () => window.removeEventListener("aura:library-write", onWrite);
  }, []);
  useEffect(() => {
    if (!session) return;
    const onFocus = () => {
      const sinceWrite = Date.now() - lastWriteRef.current;
      if (sinceWrite < 5 * 60_000) {
        console.info(`[library-sync] skipping focus refetch (wrote ${Math.round(sinceWrite / 1000)}s ago)`);
        return;
      }
      console.info("[library-sync] focus → loadLibrary");
      loadLibrary(session);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [session, loadLibrary]);

  // ── Push half of the watched-status sync.
  //     Listens for per-id transitions emitted by manualWatched, and
  //     pushes any "watched" entry/exit on a series-root or movie id
  //     to the Stremio cloud library. Episode-level marks (ids that
  //     don't match a library entry — series ids carry no colons,
  //     episode ids do) silently no-op since there's no cloud field
  //     for them.
  useEffect(() => {
    if (!session?.auth_key) return;
    const authKey = session.auth_key;
    return onWatchedSync((diffs) => {
      for (const d of diffs) {
        const wasWatched = d.oldState === "watched";
        const isWatched  = d.newState === "watched";
        if (wasWatched === isWatched) continue;
        const item = library.find((i) => i.id === d.id);
        if (!item) continue;
        pushItemWatched(authKey, item, isWatched).catch((err) => {
          console.warn(`[watched-sync] push fail id=${d.id} err=${String(err)}`);
        });
      }
    });
  }, [session, library]);

  // ── Local stats: bump streams_played on every load_video, accumulate
  //     watched-time per media_type via a 5 s tick while playing. The
  //     home_view_secs counter is bumped from the Home view directly.
  const lastStatsTickRef = useRef<number | null>(null);
  useEffect(() => {
    if (!activeTarget) {
      lastStatsTickRef.current = null;
      return;
    }
    // First-time per session — count this as a stream played.
    invoke("bump_stat", { kind: "streams_played", delta: 1 }).catch(() => {});
    lastStatsTickRef.current = Date.now();
  }, [activeTarget?.id, activeTarget?.media_type]);
  useEffect(() => {
    if (!activeTarget || paused) {
      lastStatsTickRef.current = null;
      return;
    }
    const id = setInterval(() => {
      const now = Date.now();
      const last = lastStatsTickRef.current ?? now;
      const delta = (now - last) / 1000;
      lastStatsTickRef.current = now;
      // Pick a kind based on media type + the anime detection hook.
      const isAnime = isAnimeMeta({
        media_type: activeTarget.media_type,
        id:         activeTarget.id,
      });
      const kind = isAnime
        ? "watched_anime_secs"
        : (activeTarget.media_type === "movie" ? "watched_movie_secs" : "watched_series_secs");
      invoke("bump_stat", { kind, delta }).catch(() => {});
    }, 5000);
    lastStatsTickRef.current = Date.now();
    return () => clearInterval(id);
  }, [activeTarget, paused]);

  // Home-view dwell time. The same 5 s cadence accumulates against
  // home_view_secs whenever activeView === "home" and the player isn't up.
  useEffect(() => {
    if (activeView !== "home" || isPlayerActive) return;
    const id = setInterval(() => {
      invoke("bump_stat", { kind: "home_view_secs", delta: 5 }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [activeView, isPlayerActive]);

  // ── Auto-updater poll ──
  // Every time the user lands on Home, check the GitHub Releases API for
  // a newer release tag — but no more than once per 5 minutes (so quick
  // tab-flips back to Home don't spam the API or get us rate-limited).
  //
  // If a newer release exists AND it's strictly newer than the tag the
  // user previously dismissed to the notifications bell, surface the
  // popup. Otherwise stay quiet — the bell already carries the dismissed
  // version (a separate task owns that side of the UI).
  //
  // checkForUpdate() never throws; it returns null on any failure.
  useEffect(() => {
    if (activeView !== "home") return;
    if (isPlayerActive) return;
    const now = Date.now();
    if (now - lastUpdateCheckRef.current < UPDATE_CHECK_INTERVAL_MS) return;
    lastUpdateCheckRef.current = now;

    let cancelled = false;
    (async () => {
      const release = await checkForUpdatePlugin();
      if (cancelled || !release) return;
      // Only show the popup if (a) nothing was previously dismissed, or
      // (b) the new tag is strictly newer than what was dismissed. The
      // bell handles re-surfacing for the "still pending" case via its
      // own UI; we don't re-pop a tag the user has already deferred.
      const dismissed = (() => {
        try { return localStorage.getItem(UPDATE_DISMISSED_KEY); }
        catch { return null; }
      })();
      if (!dismissed || isNewer(release.version, dismissed)) {
        setPendingUpdate(release);
      }
    })();
    return () => { cancelled = true; };
  }, [activeView, isPlayerActive]);

  // Continue-Watching ✕ button → clear playback state in Stremio cloud.
  // Card dispatches `aura:cw-clear` with the LibraryItem; we resolve the
  // auth_key here and round-trip through library_put. libraryClearProgress
  // dispatches `aura:library-changed` on success which re-fetches the row.
  //
  // Using a ref for the session keeps the listener stable — without it,
  // re-mounting the listener on every session change can race a click
  // event that fires while session is briefly null during a re-fetch.
  const sessionRef = useRef<UserSession | null>(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    const onClear = async (e: Event) => {
      const detail = (e as CustomEvent<{ item: LibraryItem }>).detail;
      const sess = sessionRef.current;
      if (!detail?.item || !sess?.auth_key) {
        console.warn("[cw-clear] no session or item", { hasItem: !!detail?.item, hasSess: !!sess?.auth_key });
        return;
      }
      console.info("[cw-clear] clearing", detail.item.id);
      // Register the id in the recent-clear set IMMEDIATELY. Even if
      // a focus-driven refetch races our cloud write and brings back
      // the non-zero timeOffset, overlayRecentClears() will re-zero it
      // before the library state is set. Survives for CLEAR_WINDOW_MS.
      recentlyCleared.current.set(detail.item.id, Date.now());
      try {
        // Optimistic local update FIRST so the row drops out instantly.
        // Match what stremio-core's RewindLibraryItem does — only
        // `state.timeOffset = 0`, everything else preserved.
        setLibrary((curr) => curr.map((i) =>
          i.id === detail.item.id
            ? { ...i, state: { ...i.state, timeOffset: 0 } }
            : i
        ));
        // Mark the write so the focus-based sync skips the
        // immediately-after-clear refetch (which would round-trip
        // the old state back from Stremio's eventual-consistency window).
        window.dispatchEvent(new CustomEvent("aura:library-write"));
        // Then push to the cloud — fire-and-forget so a slow network
        // doesn't keep the row visible.
        await libraryClearProgress(sess.auth_key, detail.item);
      } catch (err) {
        console.warn("[cw-clear] failed", err);
      }
    };
    window.addEventListener("aura:cw-clear", onClear);
    return () => window.removeEventListener("aura:cw-clear", onClear);
  }, []);

  // ── Auto-advance to next episode after a watched-completion event.
  //     Dispatched from useScrobble (90 % threshold) and DetailView's
  //     manual "Mark as Watched" handler. Routes to advanceWatchedAfter
  //     which has the meta-cache lookup and series-complete logic.
  useEffect(() => {
    const onAdvance = (e: Event) => {
      const detail = (e as CustomEvent<{ seriesId?: string; episodeId?: string; mediaType?: string }>).detail;
      if (!detail || typeof detail.seriesId !== "string" || typeof detail.episodeId !== "string") return;
      const mt = detail.mediaType ?? "";
      // History parity. The 80 % auto-complete is the definitive
      // "watched" signal that already drives Trakt/AniList — but the
      // History tab is written ONLY by handleExitPlayback / onNextUpPlay,
      // and a binge / auto-advance / resume-at-end teardown can skip BOTH
      // for the just-finished episode (observed: WHA EP01 scrobbled to
      // Trakt+AniList yet never appeared in History). Write it here too,
      // for the episode that's actually active. `autoHistoryWrittenId`
      // is the per-play slot handleExitPlayback consults so it skips its
      // own duplicate append (addHistoryEntry only dedups exact
      // id+played_at, and the two paths fire at different timestamps).
      const at = activeTarget;
      if (
        at &&
        at.id === detail.episodeId &&
        detail.seriesId !== detail.episodeId &&
        autoHistoryWrittenId.current !== detail.episodeId
      ) {
        const { time: watched, duration: dur } = playbackRef.current;
        let season: number | null = at.season ?? null;
        let episode: number | null = at.episode_num ?? null;
        if ((season == null || episode == null) && detail.episodeId.startsWith("tt")) {
          const parts = detail.episodeId.split(":");
          if (parts.length >= 3) {
            const s = Number(parts[parts.length - 2]);
            const ep = Number(parts[parts.length - 1]);
            if (season == null && Number.isFinite(s)) season = s;
            if (episode == null && Number.isFinite(ep)) episode = ep;
          }
        }
        const libRecord = library.find((i) => i.id === detail.seriesId) ?? null;
        addHistoryEntry({
          id:            detail.episodeId,
          parent_id:     detail.seriesId,
          name:          at.name,
          media_type:    at.media_type,
          poster:        libRecord?.poster ?? selectedMeta?.poster ?? null,
          background:    libRecord?.background ?? selectedMeta?.background ?? null,
          season,
          episode,
          episode_title: at.episode_title ?? null,
          played_at:     new Date().toISOString(),
          duration:      dur || undefined,
          watched_seconds: watched || undefined,
        });
        autoHistoryWrittenId.current = detail.episodeId;
      }
      void advanceWatchedAfter(detail.seriesId, detail.episodeId, mt, addons);
    };
    window.addEventListener("aura:auto-advance-watched", onAdvance);
    return () => window.removeEventListener("aura:auto-advance-watched", onAdvance);
  }, [addons, activeTarget, library, selectedMeta]);

  // ── Library toggle handler — exposed to right-click menus + DetailView.
  //
  // Optimistic: we mutate the local `library` / `rawLibrary` state BEFORE
  // the network request returns so every consumer (DetailView's
  // Add/Remove pill, Library grid X button, CW row, catalog cards'
  // checkmark overlay) flips state in the same frame as the click. The
  // server confirmation lands ~250-2000 ms later via the
  // `aura:library-changed` re-fetch, which then either confirms or
  // gently corrects the optimistic state.
  const handleLibraryToggle = useCallback(async (meta: MetaPreview, originPoint?: { x: number; y: number }) => {
    if (!session?.auth_key) {
      // Guest: surface that this is a Stremio-account-scoped feature.
      setShowLogin(true);
      return;
    }
    const inLib = library.some((i) => i.id === meta.id && !i.removed);
    const nowIso = new Date().toISOString();

    if (inLib) {
      // Optimistic remove — drop from BOTH normalized and raw views so
      // the X button / pill flip immediately. rawLibrary needs every
      // record whose series-root id matches stripped (covers phantom
      // per-episode rows the normalizer collapsed).
      setLibrary((prev) => prev.filter((i) => i.id !== meta.id));
      setRawLibrary((prev) =>
        prev.filter((i) => libraryItemSeriesId(i.id) !== meta.id),
      );
    } else {
      const newItem: LibraryItem = {
        id:         meta.id,
        media_type: meta.media_type,
        name:       meta.name,
        poster:     meta.poster,
        background: meta.background,
        logo:       meta.logo,
        year:       meta.release_info,
        removed:    false,
        temp:       false,
        ctime:      nowIso,
        mtime:      nowIso,
        state:      {},
      };
      setLibrary((prev) => [newItem, ...prev.filter((i) => i.id !== meta.id)]);
      setRawLibrary((prev) => [newItem, ...prev.filter((i) => i.id !== meta.id)]);
    }

    if (originPoint) {
      const verb = inLib ? "Removed from Library" : "Added to Library";
      showFlyUpToast(`${verb} · ${meta.name}`, {
        x: originPoint.x,
        y: originPoint.y,
        tone: inLib ? "danger" : "success",
      });
    } else {
      showAppToast(
        inLib ? `Removed "${meta.name}" from library` : `Added "${meta.name}" to library`,
        { tone: inLib ? "default" : "success" },
      );
    }

    try {
      await libraryToggle(session.auth_key, meta, library);
    } catch (err) {
      if (String(err) === SESSION_EXPIRED) await handleSessionExpired();
      // On any error, the impending `aura:library-changed` re-fetch
      // (which DOESN'T fire on throw — let's force one) corrects the
      // optimistic state. Trigger a refresh so UI snaps back to truth.
      window.dispatchEvent(new CustomEvent("aura:library-changed"));
    }
  }, [session, library, handleSessionExpired]);

  // Library card "X" affordance. Uses libraryRemoveAll (not the simple
  // toggle) so phantom per-episode rows that were collapsed by the
  // normalizer are also marked removed — otherwise the next sync would
  // re-surface them as a tile with stale metadata.
  const handleLibraryRemove = useCallback(async (item: LibraryItem, originPoint?: { x: number; y: number }) => {
    if (!session?.auth_key) {
      setShowLogin(true);
      return;
    }
    // Optimistic remove — same shape as handleLibraryToggle's remove
    // path. Reads as instant feedback even though the
    // datastorePut + library_get round-trip takes a beat.
    setLibrary((prev) => prev.filter((i) => i.id !== item.id));
    setRawLibrary((prev) =>
      prev.filter((i) => libraryItemSeriesId(i.id) !== item.id),
    );

    if (originPoint) {
      showFlyUpToast(`Removed from Library · ${item.name}`, {
        x: originPoint.x,
        y: originPoint.y,
        tone: "danger",
      });
    }

    try {
      const result = await libraryRemoveAll(session.auth_key, item.id, rawLibrary);
      if (result.removedCount === 0) {
        // Nothing matched on the server — surface to the user, then
        // force a refresh so the optimistic state is reconciled.
        showAppToast(`Could not find "${item.name}" to remove`, { tone: "danger" });
        window.dispatchEvent(new CustomEvent("aura:library-changed"));
      } else if (!originPoint) {
        // Only fall back to the bottom-right toast when the caller
        // didn't supply a click point for the fly-up version.
        const suffix = result.removedCount > 1 ? ` (cleaned up ${result.removedCount - 1} stale record${result.removedCount > 2 ? "s" : ""})` : "";
        showAppToast(`Removed "${item.name}" from library${suffix}`);
      }
    } catch (err) {
      if (String(err) === SESSION_EXPIRED) await handleSessionExpired();
      window.dispatchEvent(new CustomEvent("aura:library-changed"));
    }
  }, [session, rawLibrary, handleSessionExpired]);

  // ── Card right-click — listens for "aura:card-context" events fired by
  //     CatalogCard / ContinueWatchingCard / PosterCard. App builds the menu
  //     items here because only it knows the library state and the session.
  useEffect(() => {
    console.info("[ctx] App card-context listener installed");
    const onCardContext = (e: Event) => {
      const ev = e as CustomEvent<{
        meta: MetaPreview;
        x: number;
        y: number;
        /** Where the right-click originated. Drives the menu mix —
         *  CW cards show "Remove from Continue Watching" instead of
         *  "Remove from Library". */
        source?: "cw" | "catalog" | "library";
        /** Raw library item — only present for cw/library card sources;
         *  used by the CW-clear handler to write the rewind state. */
        item?: LibraryItem;
      }>;
      const { meta, x, y, source, item } = ev.detail;
      console.info(
        `[ctx] App received card-context: ${meta.media_type}:${meta.id} "${meta.name}" @ (${x},${y}) source=${source ?? "default"}`,
      );
      const inLib = library.some((i) => i.id === meta.id && !i.removed);
      // Anime detection at right-click time: a stripped library / CW
      // preview often lacks the genres isAnimeMeta needs, but the hover
      // panel / CW / Calendar usually warmed metaCache for this id
      // already. Consult that cached detail (genres / language / mal·
      // kitsu·anidb ids) synchronously, and persist a positive via
      // markAnimeId so a later cold-cache right-click still resolves —
      // that also makes sourcesForMeta's own isAnimeMeta hit the cache.
      const cachedDetail = peekCachedDetailById(meta.id);
      const isAnime =
        isAnimeMeta(meta) ||
        (cachedDetail != null &&
          (cachedDetail.mal_id != null ||
            cachedDetail.kitsu_id != null ||
            cachedDetail.anidb_id != null ||
            isAnimeMeta({
              media_type: cachedDetail.media_type,
              id: cachedDetail.id,
              genres: cachedDetail.genres,
              original_language: cachedDetail.original_language,
              production_countries: cachedDetail.production_countries,
            })));
      if (isAnime) markAnimeId(meta.id);
      console.info(
        `[anime] check id=${meta.id} type=${meta.media_type} ` +
          `genres=${JSON.stringify(meta.genres ?? [])} → ${isAnime ? "ANIME" : "non-anime"}`,
      );

      const items: ContextMenuItem[] = [];

      // ── "Open in…" submenu ─────────────────────────────────────────
      // Collapses every external-source link into one parent row that
      // expands on hover. Anime metas surface AniList / MAL / Kitsu;
      // everything else surfaces IMDb / TMDB / Trakt / RT / Metacritic
      // / Letterboxd (movies-only).
      const sources = sourcesForMeta(meta);
      if (sources.length > 0) {
        items.push({
          kind: "submenu",
          label: "Open in…",
          icon: (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" />
            </svg>
          ),
          items: sources.map((s) => ({
            label: s.label,
            onClick: () => openInPopupBrowser(s.url, s.source),
          })),
        });
      }

      // ── Mark watched / in-progress / planned (4-state, manual) ──
      // The user can flip the same id between the four states. We
      // surface ALL state buttons so flipping doesn't require an
      // extra click — clicking "Mark as Watched" on an already-
      // watched item flips it back to null.
      const manualState = getManualWatchedState(meta.id);
      const isWatched   = manualState === "watched";
      const isProgress  = manualState === "in-progress";
      const isPlanned   = manualState === "planned";
      items.push({
        kind: "action",
        label: isWatched ? "Unmark Watched" : "Mark as Watched",
        tone: "success",
        icon: (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
        ),
        onClick: () => {
          const next = isWatched ? null : "watched";
          // Series-level flip is synchronous so the UI updates
          // instantly. For series, also fan out to every episode under
          // the title so the detail-page episode rows + Continue
          // Watching reflect the bulk change. We fetch the meta detail
          // async to avoid blocking the menu close — episode marks
          // arrive a few hundred ms later when AIOMetadata's response
          // lands. Movies have no `videos[]` so the fan-out is a
          // no-op for them; gating on media_type avoids the round-trip
          // entirely.
          setManualWatchedState(meta.id, next);
          showFlyUpToast(
            next ? `Marked watched · ${meta.name}` : `Unmarked · ${meta.name}`,
            { x, y, tone: next ? "success" : "default" },
          );
          if (meta.media_type === "series" || meta.media_type === "anime") {
            void (async () => {
              try {
                const detail = await getMetaDetailFallback(addons, meta.media_type, meta.id);
                // When MARKING as watched, restrict the fan-out to
                // episodes that have actually aired. Without this
                // filter, a 52-video meta like Frieren (S3 not yet
                // fully aired) ends up with every future episode
                // green-checked. When UN-marking we don't filter —
                // the unmark needs to be able to reach any stale
                // future-episode marks a previous bug may have
                // written.
                const candidates = next === "watched"
                  ? (detail?.videos ?? []).filter(isVideoAired)
                  : (detail?.videos ?? []);
                const episodeIds = candidates
                  .map((v) => v.id)
                  .filter((id): id is string => typeof id === "string" && id.length > 0);
                if (episodeIds.length > 0) {
                  // setManualWatchedMany dedupes per-id no-ops, so an
                  // already-watched episode within the series doesn't
                  // generate a sync diff or a CHANGE_EVENT redraw.
                  setManualWatchedMany(episodeIds, next);
                }
              } catch {
                // Best-effort — if meta fetch fails, the series-level
                // mark stays but episode-level fan-out doesn't happen.
                // User can right-click in DetailView to mark individually.
              }
            })();
          }
        },
      });
      items.push({
        kind: "action",
        label: isProgress ? "Unmark In Progress" : "Mark as In Progress",
        tone: "warning",
        icon: (
          <span className="inline-block w-[10px] h-[10px] rounded-full bg-current" />
        ),
        onClick: () => {
          const next = isProgress ? null : "in-progress";
          setManualWatchedState(meta.id, next);
          showFlyUpToast(
            next ? `Marked in progress · ${meta.name}` : `Unmarked · ${meta.name}`,
            { x, y, tone: next ? "success" : "default" },
          );
        },
      });
      // Mark as Planned — only for catalog-level items (NOT episodes).
      // The right-click handler in App.tsx is wired by every card-level
      // surface (catalog/library/CW/search/hero); episodes use their
      // own handler in DetailView, so this branch is naturally
      // catalog-only. Marking as planned ALSO adds the item to the
      // user's library so the rest of Aura sees it.
      items.push({
        kind: "action",
        label: isPlanned ? "Unmark Planned" : "Mark as Planned",
        tone: "notice",
        icon: (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
          </svg>
        ),
        onClick: () => {
          const next = isPlanned ? null : "planned";
          setManualWatchedState(meta.id, next);
          showFlyUpToast(
            next ? `Added to Queue · ${meta.name}` : `Removed from Queue · ${meta.name}`,
            { x, y, tone: next ? "success" : "default" },
          );
          // Auto-add to library on planned. Skip when already in lib
          // to avoid the toggle's confirm-toast firing for a no-op.
          if (next === "planned" && session?.auth_key && !inLib) {
            handleLibraryToggle(meta);
          }
        },
      });

      // ── Bottom-anchored danger row ────────────────────────────────
      // Always last, always preceded by a divider. Layout discipline
      // here is what stops the user mis-clicking destructive options
      // in muscle memory — you have to consciously skip past the
      // mark-watched group to reach the remove button.
      items.push({ kind: "divider" });
      if (source === "cw" && item) {
        items.push({
          kind: "action",
          label: "Remove from Continue Watching",
          tone: "danger",
          onClick: () => window.dispatchEvent(new CustomEvent("aura:cw-clear", { detail: { item } })),
        });
      } else {
        items.push({
          kind: "action",
          label: inLib ? "Remove from Library" : "Add to Library",
          tone: inLib ? "danger" : "default",
          disabled: !session,
          onClick: () => handleLibraryToggle(meta, { x, y }),
        });
      }

      openContextMenu(x, y, items);
    };
    window.addEventListener("aura:card-context", onCardContext);
    return () => window.removeEventListener("aura:card-context", onCardContext);
  }, [library, session, handleLibraryToggle]);

  // ── Load synced or local addons ──
  // Defensive cache layer for the cloud addon list. Each auth_key gets
  // its own localStorage entry; on every successful sync we stash the
  // result. The bug we're guarding against: a fresh sign-in on a
  // second device occasionally returns a SHORTER addon list from the
  // /api/addonCollectionGet endpoint (suspected Stremio API race —
  // cloud_add_addon's read-modify-write has no concurrency token, so
  // a near-simultaneous write from device A while device B is
  // adding can land a partial collection in storage). Without this
  // cache, device B's view replaces a working list with the partial
  // one and the user thinks their addons vanished. With this cache,
  // we keep showing the previous list when the new one is suspiciously
  // smaller and surface a warning so the user can choose to re-sync.
  const cloudAddonCacheKey = useCallback(
    (authKey: string) => `aura:cloud-addons-cache:${authKey.slice(0, 12)}`,
    [],
  );
  const loadSyncedAddons = useCallback(async (sess: UserSession) => {
    const key = cloudAddonCacheKey(sess.auth_key);
    let cached: AddonEntry[] | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) cached = parsed as AddonEntry[];
      }
    } catch { /* corrupt cache — ignore */ }

    // Warm-start: paint the cached list IMMEDIATELY so home / addons
    // tab populate on the first frame, then refetch in the background
    // and replace if the cloud has changed. Mirrors the loadLibrary
    // pattern (App.tsx:1456-1466). Without this, every silent session
    // restore from the keyring path paid the full Stremio
    // addonCollectionGet round-trip before any UI rendered, even
    // when nothing had changed since the previous run.
    if (cached) setAddons(cached);

    try {
      const synced = await invoke<AddonEntry[]>("get_synced_addons", { authKey: sess.auth_key });
      // Suspicion check: a fresh fetch returning empty OR fewer than half
      // the previously-cached count is almost always a sync glitch
      // rather than a real user-driven wipe. Treat it as transient and
      // keep the cache; the user can manually refresh to re-attempt.
      if (
        cached
        && cached.length >= 2
        && synced.length < Math.floor(cached.length / 2)
      ) {
        console.warn(
          `[addons] cloud sync returned ${synced.length} addons; cache had ${cached.length}. ` +
          `Keeping cached list to avoid a destructive wipe; re-open the Addons tab to retry.`,
        );
        showAppToast(
          `Cloud sync returned ${synced.length} addons (${cached.length} cached). ` +
          `Showing cached list to be safe.`,
          { duration: 5000 },
        );
        setAddons(cached);
        return;
      }
      setAddons(synced);
      // Persist the latest healthy fetch so future sessions on this
      // device have a fallback. JSON.stringify is cheap for the typical
      // <30 addons most users have.
      try { localStorage.setItem(key, JSON.stringify(synced)); } catch { /* quota */ }
    } catch (err) {
      if (String(err) === SESSION_EXPIRED) {
        await handleSessionExpired();
      } else if (cached) {
        // Network failure during initial sync — fall back to whatever
        // we cached last time so the Addons tab and home rows aren't
        // empty while the user troubleshoots.
        console.warn(`[addons] cloud sync failed; falling back to cache (${cached.length} addons).`);
        setAddons(cached);
      }
    }
  }, [cloudAddonCacheKey, handleSessionExpired]);

  const loadLocalAddons = useCallback(() => {
    invoke<AddonEntry[]>("list_addons").then(setAddons).catch(() => {});
  }, []);

  // ── Popup-browser first-open hint ──
  // SourcePopup uses an in-app modal (no separate OS window) so the
  // app-shell dim is handled by the modal's own backdrop now — no need
  // for the CSS class toggle the first-pass implementation used. We
  // still surface the orientation toast though.
  useEffect(() => {
    const onHint = (e: Event) => {
      const message = (e as CustomEvent<{ message: string }>).detail?.message;
      if (message) showAppToast(message, { duration: 5000 });
    };
    window.addEventListener("aura:popup-first-open-hint", onHint);
    return () => window.removeEventListener("aura:popup-first-open-hint", onHint);
  }, []);

  // ── Settings scope follower ──
  // The Rust settings module persists user prefs in a per-scope file
  // (account-derived hash, or "guest"). Whenever the auth state changes,
  // tell the backend to swap which file is the source of truth so the
  // user's settings don't leak across accounts and the same person on
  // the same device gets the same prefs every session. We mirror the
  // same scope swap into the manualWatched store (purely JS-side
  // localStorage) so that "I've already watched this" marks also stay
  // scoped to the user.
  // Tracks the last scope `applySettingsScope` actually applied, so a
  // cross-account switch can be distinguished from a same-account
  // restore (drives the release-signal/scanner clear below).
  const appliedScopeRef = useRef<string | null>(null);
  const applySettingsScope = useCallback(async (sess: UserSession | null) => {
    const authKey = sess?.auth_key ?? null;
    const userId  = sess?.user_id ?? null;
    // History keys on the stable user_id so a fresh login (Stremio
    // rotates auth_keys on every login) doesn't orphan the user's
    // play log. legacyAuthScope is the pre-fix scope the user's
    // history may still live under — historyStore migrates from it
    // on the first call where the new scope's storage entry is empty.
    const newHistoryScope = userId && userId.trim()
      ? `user-${userId.slice(0, 16)}`
      : (authKey && authKey.trim() ? `user-${authKey.slice(0, 12)}` : "guest");
    const legacyAuthScope = authKey && authKey.trim()
      ? `user-${authKey.slice(0, 12)}`
      : null;
    // Manual-watched and auto-backup stay on the auth_key-prefix
    // scope for now — manual-watched cloud-syncs (so a fresh local
    // scope is repopulated by the next pull), and auto-backup keeps
    // its directories addressable from the existing UI.
    const scope = authKey && authKey.trim() ? `user-${authKey.slice(0, 12)}` : "guest";
    // Cross-account isolation for the in-memory release-signal store +
    // the persisted episode-scanner seen-ledger (both per-account).
    // The sign-out-only effect elsewhere misses a DIRECT account A→B
    // switch — it routes through here but not setSession(null). Gate
    // on an ACTUAL scope change: first apply (ref===null) and a
    // same-account cached-session restore (ref===scope) must NOT wipe
    // the scanner ledger, else every launch re-seeds and a genuinely
    // new episode is swallowed by first-scan seeding.
    if (appliedScopeRef.current !== null && appliedScopeRef.current !== scope) {
      clearReleaseSignalStore();
      clearScannerState();
    }
    appliedScopeRef.current = scope;
    setManualWatchedScope(scope);
    setHistoryScope(newHistoryScope, { legacyScope: legacyAuthScope });
    // Backups follow the same scope so a sign-out / sign-in cycle's
    // auto-snapshots land under the right user-<hash> directory and
    // a restore from Settings lists the user's actual snapshots.
    setAutoBackupScope(scope);
    // Cloud sync (Aura Cloud) is per-account: drop ETags from any
    // previous account so the next push doesn't carry a stale ETag,
    // and trigger a pull-all to seed the new account's local state
    // from whatever is on the proxy (fresh-device restore path). We
    // also publish the active scope to sync.ts so writeLocal can pick
    // the right `aura:manual-state:user-<hex>` key on a fresh-device
    // first login (where no localStorage entry exists yet to scan
    // for). We skip the pull for guest mode (sync requires a Stremio
    // session) but still publish the scope and clear ETags so the
    // transition to guest doesn't leak prior-account state.
    clearSyncEtags();
    setSyncActiveScope(scope);
    if (authKey && authKey.trim()) {
      void syncPullAll();
    }
    try {
      await invoke("set_settings_scope", { authKey });
    } catch {
      // Best-effort: a failure here just means the previous scope keeps
      // serving; we don't want to block sign-in or surface an error.
    }
  }, []);

  // ── Cloud sync orchestration (Aura Cloud) ──
  // Install push triggers once on mount and keep a 5-minute background
  // pull running so changes from another signed-in device land without
  // a sign-in cycle. Both are no-ops in guest mode (sync.rs returns
  // early when no Stremio auth_key is present), so they're safe to
  // mount unconditionally. The pull-on-login itself is wired through
  // applySettingsScope above so it fires immediately on auth-state
  // changes rather than waiting for the next 5-minute tick.
  useEffect(() => {
    installSyncTriggers();
    const teardown = startBackgroundPull();
    return teardown;
  }, []);

  // ── Auto-backup boot ──
  // Once on mount, register the scope-aware auto-snapshotter so any
  // user-data write fires a debounced create_user_backup. The backup
  // directory is bounded (10 most recent per scope by default), so
  // disk usage stays low. The scope here is "guest" until applySettingsScope
  // runs after auth resolution; setAutoBackupScope keeps the ledger
  // pointed at the right slice from then on.
  useEffect(() => {
    const stop = startAutoBackup("guest");
    return () => { stop(); };
  }, []);

  // ── Startup: restore session ──
  // Tokens live in the OS keyring (DPAPI / Keychain / Secret Service), encrypted
  // at rest. If a session exists, we bypass the LandingView entirely.
  useEffect(() => {
    invoke<UserSession | null>("get_session")
      .then(async (sess) => {
        if (sess) {
          // Pre-0.6.9 sessions in the keyring don't carry `user_id`.
          // Backfill it from Stremio's `/getUser` BEFORE the scope
          // hash is derived for the first time — otherwise the very
          // first sync_pull_all uses the legacy auth_key-derived
          // scope and re-asserts the cross-device-inconsistent
          // bucket. Backfill failures are non-fatal; sync.rs falls
          // back to the legacy scope so the user isn't locked out.
          if (!sess.user_id) {
            try {
              const backfilled = await invoke<string | null>("backfill_user_id");
              // Merge the backfilled user_id into the in-memory
              // session BEFORE applySettingsScope runs — otherwise
              // the scope derivation on this launch still falls
              // back to the legacy auth_key prefix and the history-
              // store migration can't anchor on the new user_id-
              // based scope.
              if (backfilled) sess = { ...sess, user_id: backfilled };
            } catch (e) {
              console.warn(`[auth] backfill_user_id failed: ${String(e)}`);
            }
          }
          await applySettingsScope(sess);
          setSession(sess);
          setLandingDismissed(true); // bypass landing on cached credentials
          // Self-heal a stuck/empty email: /login can persist an empty
          // address and backfill_user_id short-circuits once user_id is
          // set, so the popover would show "Email pending sync"
          // forever. fetch_stremio_account re-derives it from /getUser
          // (cached 24h) and rewrites the keyring; merge the result
          // into the in-memory session so the line updates without a
          // relogin. Best-effort — failure leaves the prior behaviour.
          invoke<StremioAccount>("fetch_stremio_account")
            .then((acct) => {
              if (acct?.email) {
                setSession((s) => (s && s.email !== acct.email ? { ...s, email: acct.email } : s));
              }
            })
            .catch(() => {});
          await Promise.all([loadSyncedAddons(sess), loadLibrary(sess)]);
        } else {
          await applySettingsScope(null);
          loadLocalAddons();
        }
      })
      .catch(() => loadLocalAddons())
      .finally(() => setAuthChecked(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auth handlers ──
  const handleLoginSuccess = useCallback(async (sess: UserSession) => {
    await applySettingsScope(sess);
    setSession(sess);
    setLandingDismissed(true);
    await Promise.all([loadSyncedAddons(sess), loadLibrary(sess)]);
  }, [loadSyncedAddons, loadLibrary, applySettingsScope]);

  const handleContinueGuest = useCallback(() => {
    applySettingsScope(null);
    setLandingDismissed(true);
  }, [applySettingsScope]);

  const handleLogout = useCallback(async () => {
    await invoke("logout").catch(() => {});
    await applySettingsScope(null);
    setSession(null);
    setLibrary([]); setRawLibrary([]);
    loadLocalAddons();
  }, [loadLocalAddons, applySettingsScope]);


  // ── Addon list handlers (passed to AddonsView) ──
  const handleAddonAdded = useCallback((entry: AddonEntry) => {
    setAddons((prev) => [...prev, entry]);
  }, []);

  const handleAddonRemoved = useCallback((url: string) => {
    setAddons((prev) => prev.filter((a) => a.url !== url));
  }, []);

  // ── Absolute-episode patch effect ──
  // Computes activeTarget.absolute_episode_num asynchronously after
  // activeTarget is set. handlePlayStream can't await the meta detail
  // before flipping activeTarget (would block the play flow on a cold
  // cache); this effect fetches in the background and patches the
  // target with the absolute number once detail resolves. Lands well
  // before the 120 s scrobble_start warmup so the Trakt absolute-
  // numbering fallback target has the value it needs.
  //
  // Only fires for episodes with season > 1 (S1 cour-relative ==
  // absolute, no conversion needed) AND when absolute_episode_num
  // isn't already stamped (idempotency — don't refetch on every
  // re-render).
  useEffect(() => {
    if (!activeTarget) return;
    if (activeTarget.absolute_episode_num != null) return;
    const s = activeTarget.season;
    const e = activeTarget.episode_num;
    if (s == null || s <= 1 || e == null) return;
    const seriesId = activeTarget.series_id ?? activeTarget.id;
    let cancelled = false;
    (async () => {
      const detail = await getMetaDetailFallback(addons, activeTarget.media_type, seriesId)
        .catch(() => null);
      if (cancelled || !detail?.videos || detail.videos.length === 0) return;
      const priorCourEps = detail.videos.filter(
        (v) => (v.season ?? 0) > 0 && (v.season ?? 0) < s,
      ).length;
      const absoluteEp = priorCourEps + e;
      // Patch via functional setState — if the user has already swapped
      // to a different episode by the time the meta resolves, the id
      // check refuses to overwrite the new target with stale data.
      setActiveTarget((prev) => {
        if (!prev || prev.id !== activeTarget.id) return prev;
        if (prev.absolute_episode_num === absoluteEp) return prev;
        return { ...prev, absolute_episode_num: absoluteEp };
      });
    })();
    return () => { cancelled = true; };
  }, [activeTarget, addons]);

  // ── Scrobble lifecycle (no-ops while activeTarget is null) ──
  // `scope` keys the per-account Trakt token in the keyring, matching
  // the layout in scrobble_auth.rs (first 12 chars of auth_key, or
  // "guest" when signed out). scrobble.rs reads this off the session
  // it receives at scrobble_start time.
  const scrobbleScope = session?.auth_key ? session.auth_key.slice(0, 12) : "guest";
  useScrobble({
    active: activeTarget,
    playback: { time, duration, paused },
    scope: scrobbleScope,
  });

  // ── DevConsole `scrobble` test command bridge ──
  // The console fires `aura:devlogs-scrobble-test` with a `respond`
  // callback in the event detail; we have activeTarget + the live
  // playback snapshot in scope here, so we build the ScrobbleSession
  // shape (matching what scrobble_start would have populated) and
  // hand it to scrobble_test_fire. This bypasses the 120s warmup
  // gate that prevents session_slot from being populated for
  // genuine real-user-watching scenarios — testing should fire
  // immediately, not after 2 minutes.
  useEffect(() => {
    interface ScrobbleTestResp {
      ok: boolean;
      message: string;
      level: "info" | "warn" | "error";
    }
    interface TestEventDetail {
      respond: (r: ScrobbleTestResp) => void;
    }
    interface RustResult {
      session_active: boolean;
      trakt_fired: boolean;
      anilist_fired: boolean;
      message: string;
    }
    const handler = async (e: Event) => {
      const detail = (e as CustomEvent<TestEventDetail>).detail;
      if (!detail?.respond) return;
      if (!activeTarget) {
        detail.respond({
          ok: false,
          level: "warn",
          message: "no active stream - open a video first, then run `scrobble`",
        });
        return;
      }
      try {
        const session = {
          imdb_id:    activeTarget.id,
          media_type: activeTarget.media_type,
          episode:    activeTarget.episode ?? null,
          title:      activeTarget.name,
          is_anime:   isAnimeMeta(activeTarget),
          scope:      scrobbleScope,
          // Authoritative numeric S/E from the VideoEntry. scrobble.rs
          // prefers these over the ID-string parse so the Trakt payload
          // matches what the user actually clicked in the picker — the
          // critical disambiguation for dual-numbered anime.
          season:      activeTarget.season ?? null,
          episode_num: activeTarget.episode_num ?? null,
          // Series-root IMDb id, kept separate from imdb_id (which now
          // carries the kitsu/mal/anidb-shaped video id after the
          // AIOMetadata IMDb-anime patch). Mirrors the shape useScrobble
          // sends for the live-playback path — without it, Trakt
          // scrobble bails on "id format unsupported" because
          // parse_trakt_target can't extract a show anchor from a
          // non-tt video id, and the series_imdb_id fallback in
          // scrobble.rs::trakt_targets has nothing to work with.
          series_imdb_id:
            activeTarget.series_id && activeTarget.series_id.startsWith("tt")
              ? activeTarget.series_id
              : (activeTarget.id.startsWith("tt")
                  ? activeTarget.id.split(":")[0]
                  : null),
          // Absolute episode for Trakt's S1-absolute fallback. Stamped
          // on activeTarget at handlePlayStream time from
          // detail.videos prior-cour sums; the test fire reads it
          // directly so DevConsole test runs cover the same retry
          // path as live playback.
          absolute_episode_num: activeTarget.absolute_episode_num ?? null,
        };
        const r = await invoke<RustResult>("scrobble_test_fire", {
          session,
          time,
          duration,
        });
        detail.respond({
          ok: r.trakt_fired || r.anilist_fired,
          level: r.trakt_fired || r.anilist_fired ? "info" : "warn",
          message: r.message,
        });
      } catch (err) {
        detail.respond({
          ok: false,
          level: "error",
          message: `scrobble test failed: ${String(err)}`,
        });
      }
    };
    window.addEventListener("aura:devlogs-scrobble-test", handler);
    return () => window.removeEventListener("aura:devlogs-scrobble-test", handler);
  }, [activeTarget, scrobbleScope, time, duration]);
  // Scrobble-auth bell alerts run inside NotificationsBridge — see
  // its useScrobbleAuthAlerts(authKey) call below. Mounting them here
  // would crash because useNotifications() requires being inside the
  // <NotificationsProvider> tree, which doesn't wrap App.

  // ── Custom keybindings — global keydown → action handlers ──
  // Note: `fullscreen` is now wired through the lifted toggleFullscreen so
  // the TitleBar hides/shows in lockstep with MPV taking over the screen.
  //
  // Volume bumps fire a `aura:player-toast` so the user gets the same
  // visual feedback they get from the wheel handler — but we DON'T let
  // the keydown wake the auto-hidden control bar. PlayerOverlay's
  // useAutoHide reads `silentWakeKeys` and skips its `wake()` call for
  // these codes, matching mousewheel behaviour. Step is 2 % (vs 5 % for
  // mousewheel) so keyboard users have finer-grained control.
  const bumpVolumeFromKey = useCallback((delta: number) => {
    const next = Math.max(0, Math.min(100, volume + delta));
    commitVolumeAndSave(next);
    window.dispatchEvent(
      new CustomEvent("aura:player-toast", { detail: { message: `Volume · ${Math.round(next)}%` } }),
    );
  }, [volume, commitVolumeAndSave]);
  // Apply an Anime4K profile via chord. Only fires while a stream is
  // playing — outside playback the chord is a no-op. Failure (most
  // likely "shader file not found") surfaces in the player toast so
  // the user can see which file is missing without digging through
  // DevConsole. Profile ids 7..12 are stable in cinema.rs::PROFILES.
  // All paths to a shader switch — picker click, cycle hotkey, and
  // the Ctrl+1..6 chord shortcuts — funnel through the ShaderPicker's
  // `select()` so the throttle gate, MPV invoke, pill update, toast,
  // and per-title persistence happen in exactly one place. Here we
  // just publish the intent; the picker listens and does the work.
  // Unused `label` kept in the signature for call-site readability.
  const applyAnime4KProfile = useCallback((profileId: number, _label: string) => {
    if (!isPlayerActive) return;
    window.dispatchEvent(new CustomEvent("aura:set-shader", {
      detail: { profileId },
    }));
  }, [isPlayerActive]);

  useKeybindings({
    bindings: keybindings,
    enabled: !showLogin,
    handlers: {
      "toggle-pause":     () => togglePause(),
      "seek-back":        () => seekRelative(-10),
      "seek-forward":     () => seekRelative(10),
      "volume-up":        () => bumpVolumeFromKey(2),
      "volume-down":      () => bumpVolumeFromKey(-2),
      "toggle-osd":       () => window.dispatchEvent(new CustomEvent("aura:toggle-osd")),
      "cycle-shader":     () => window.dispatchEvent(new CustomEvent("aura:cycle-shader")),
      "toggle-subtitles": () => setSubsOpen((v) => !v),
      // Fullscreen toggle is a player-only action — pressing F outside
      // playback shouldn't fullscreen the chrome (catalog views etc.).
      "fullscreen":       () => { if (isPlayerActive) toggleFullscreen(); },
      // Panscan toggle — flips MPV's `panscan` between 0.0 (default,
      // letterbox/pillarbox) and 1.0 (zoom-and-crop to fill viewport).
      // The control bar button owns the on/off state; the keybind just
      // dispatches an event so both paths converge on the same handler.
      "toggle-panscan":   () => {
        if (!isPlayerActive) return;
        window.dispatchEvent(new CustomEvent("aura:toggle-panscan"));
      },
      // Frame-step: nudge one frame at a time. MPV auto-pauses on
      // frame-step / frame-back-step so no separate pause toggle is
      // required. Gated on isPlayerActive so the bindings stay free
      // outside playback (no false-pause if the user types "," on
      // the home page).
      "frame-step-back":    () => {
        if (!isPlayerActive) return;
        invoke("frame_step", { forward: false }).catch(() => {});
      },
      "frame-step-forward": () => {
        if (!isPlayerActive) return;
        invoke("frame_step", { forward: true }).catch(() => {});
      },
      // Anime4K v4 chord shortcuts. Defaults Ctrl+1..6 + Ctrl+0;
      // user-rebindable via Settings → Keybindings.
      "anime4k-a":        () => applyAnime4KProfile(7,  "Anime4K Mode A"),
      "anime4k-b":        () => applyAnime4KProfile(8,  "Anime4K Mode B"),
      "anime4k-c":        () => applyAnime4KProfile(11, "Anime4K Mode C"),
      "anime4k-aa":       () => applyAnime4KProfile(9,  "Anime4K Mode A+A"),
      "anime4k-bb":       () => applyAnime4KProfile(10, "Anime4K Mode B+B"),
      "anime4k-cc":       () => applyAnime4KProfile(12, "Anime4K Mode C+C"),
      "anime4k-none":     () => applyAnime4KProfile(0,  "None"),
    },
  });

  // ── SMTC: forward OS media-key events to MPV ──
  // Step the active target ±1 episode and play the result. Used by
  // SMTC Next/Previous and any future "I want next episode now"
  // surface. Series/anime only — for movies the step is a no-op
  // (the OS Next button does nothing rather than e.g. jumping to a
  // planned-queue entry, which would surprise users who don't know
  // their queue is wired to media keys).
  // Queue advance fallback — when the current show has no more episodes
  // to step to, hop to the next planned-queue entry's S01E01 so the
  // user's media-key Next never dead-ends mid-binge. Only fires when
  // the current series is in the queue (otherwise casual not-queued
  // playback isn't redirected somewhere unexpected). Returns true when
  // it successfully loaded the queued show's first episode, false
  // otherwise (caller surfaces the original "No next episode" toast).
  const advanceToQueueNext = useCallback(async (currentRoot: string): Promise<boolean> => {
    const queue = getPlannedQueue();
    const idx = queue.indexOf(currentRoot);
    if (idx < 0 || idx + 1 >= queue.length) return false;
    const nextRootId = queue[idx + 1];
    if (!nextRootId) return false;

    // Queue entries don't carry their media_type — probe series/anime/
    // movie in that order. The meta cache short-circuits subsequent
    // attempts when an earlier one succeeds.
    for (const candidateType of ["series", "anime", "movie"] as const) {
      const detail = await getMetaDetailFallback(addons, candidateType, nextRootId).catch(() => null);
      if (!detail) continue;
      const videos = (detail.videos ?? []).filter((v) => v && v.id);
      // First aired episode (season > 0 to skip Specials), else first
      // entry, else the meta id itself for movies.
      const firstEp = videos.find((v) => (v.season ?? 0) > 0) ?? videos[0];
      const targetId = firstEp?.id ?? nextRootId;
      const stream = await pickFirstStreamForEpisode(addons, candidateType, targetId);
      if (!stream) continue;
      const epTag =
        firstEp && firstEp.season != null && firstEp.episode != null
          ? `S${String(firstEp.season).padStart(2, "0")}E${String(firstEp.episode).padStart(2, "0")}`
          : undefined;
      await handlePlayStream(stream, {
        id:            targetId,
        series_id:     nextRootId,
        media_type:    candidateType,
        name:          detail.name ?? "",
        episode:       epTag,
        episode_title: firstEp?.title ?? undefined,
        season:        firstEp?.season ?? undefined,
        episode_num:   firstEp?.episode ?? undefined,
      });
      return true;
    }
    return false;
  }, [addons, handlePlayStream]);

  const stepEpisode = useCallback(async (direction: 1 | -1) => {
    const target = activeTarget;
    if (!target) return;
    const isSeries = target.media_type === "series" || target.media_type === "anime";
    if (!isSeries) {
      // Movies / non-episodic: there's no "previous episode" semantic,
      // but media-key Next still meaningfully advances through a queue
      // of planned items if the current movie is in it.
      if (direction === 1) {
        const rootId = target.series_id ?? target.id;
        if (rootId) await advanceToQueueNext(rootId);
      }
      return;
    }
    const seriesId = target.series_id ?? target.id;
    if (!seriesId) return;
    try {
      const detail = await getMetaDetailFallback(addons, target.media_type, seriesId);
      if (!detail) return;
      // SMTC Next honours the user's filler/recap skip preference;
      // SMTC Previous walks backward through the watch order unfiltered
      // since "Previous" means "go back" — skipping past filler going
      // backward would surprise users who just hit Next.
      const candidate = direction === 1
        ? findNextEpisode(detail, target.id, Date.now(), loadAuraSettings().nextUpSkipFillerRecap)
        : findPreviousEpisode(detail, target.id);
      if (!candidate) {
        // Out of episodes in the current series. On Next, fall back to
        // the planned queue — if the user explicitly queued this series
        // alongside others, advance to the next entry's S01E01.
        // Previous stays a no-op (going backward through the queue
        // doesn't match a sensible media-key semantic — "Previous"
        // means "earlier in what I'm currently watching").
        if (direction === 1 && await advanceToQueueNext(seriesId)) return;
        window.dispatchEvent(new CustomEvent("aura:player-toast", {
          detail: { message: direction === 1 ? "No next episode" : "No previous episode" },
        }));
        return;
      }
      const stream = await pickFirstStreamForEpisode(addons, target.media_type, candidate.id);
      if (!stream) {
        window.dispatchEvent(new CustomEvent("aura:player-toast", {
          detail: { message: "No streams found" },
        }));
        return;
      }
      const ep = candidate.title || `Episode ${candidate.episode ?? "?"}`;
      // Scoring metadata isn't carried on ActiveScrobbleTarget — handlePlayStream
      // accepts it as optional and falls back to the addon-supplied stream
      // metadata for default-track selection. The OS Next/Prev path is rare
      // enough that the small loss in audio-track scoring fidelity isn't
      // worth threading the original scoring values through React state.
      await handlePlayStream(stream, {
        id:           candidate.id,
        series_id:    seriesId,
        media_type:   target.media_type,
        name:         target.name,
        episode:      ep,
        episode_title: candidate.title ?? undefined,
        season:        candidate.season ?? undefined,
        episode_num:   candidate.episode ?? undefined,
      });
    } catch (err) {
      console.warn("[smtc] step episode failed:", err);
    }
  }, [addons, activeTarget, handlePlayStream, advanceToQueueNext]);

  useEffect(() => {
    const p = listen<string>("smtc-event", ({ payload }) => {
      switch (payload) {
        case "play":
        case "pause":
        case "toggle":
          togglePause();
          break;
        case "stop":
          // No explicit stop binding; pause as the closest analogue.
          if (!paused) togglePause();
          break;
        case "next":
          void stepEpisode(1);
          break;
        case "previous":
          void stepEpisode(-1);
          break;
      }
    });
    return () => { p.then((fn) => fn()); };
  }, [togglePause, paused, stepEpisode]);

  // ── SMTC: push now-playing metadata when activeTarget / duration changes ──
  useEffect(() => {
    if (activeTarget && duration > 0) {
      invoke("smtc_set_metadata", {
        title:    activeTarget.name,
        artist:   activeTarget.episode ?? null,
        coverUrl: null,        // wired when detail-view feeds backdrop URL
        duration,
      }).catch(() => {});
    } else {
      invoke("smtc_clear").catch(() => {});
    }
  }, [activeTarget, duration]);

  // ── SMTC: push playback state on every pause / time change at low rate ──
  useEffect(() => {
    if (!activeTarget) return;
    invoke("smtc_set_playback", {
      playing: duration > 0,
      paused,
      position: time,
    }).catch(() => {});
  }, [activeTarget, paused, duration, time]);

  // ── Global wheel-to-volume — only while the player overlay is up.
  // Listens on the player container (the whole app body); each wheel event
  // adjusts MPV volume by ±5%. We do NOT preventDefault when scrolling lists
  // — a wheel event over a scrollable element should still scroll that
  // element. Detection: walk up the target chain; if any ancestor has
  // overflow:auto/scroll AND there is something to scroll, defer to the
  // browser. Otherwise, the wheel "belongs to" the player and we steal it.
  // Gating on `isPlayerActive` (not just `duration > 0`) keeps the catalog
  // / library / settings views scrollable normally — the engine can hold
  // a stale duration from the previous playback while the user browses.
  useEffect(() => {
    if (!isPlayerActive || duration <= 0) return;

    const isOverScrollable = (target: EventTarget | null): boolean => {
      let el = target instanceof HTMLElement ? target : null;
      while (el && el !== document.body) {
        const cs = window.getComputedStyle(el);
        const oy = cs.overflowY;
        if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) {
          return true;
        }
        el = el.parentElement;
      }
      return false;
    };

    const onWheel = (e: WheelEvent) => {
      if (isOverScrollable(e.target)) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 5 : -5;
      const next = Math.max(0, Math.min(100, volume + step));
      commitVolumeAndSave(next);
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [isPlayerActive, duration, volume, commitVolumeAndSave]);

  // ── Library writeback — on pause + on activeTarget change, send the
  //     current timeOffset/duration to the Stremio cloud datastore so the
  //     "Continue Watching" row picks it up next session. Debounced so a
  //     rapid play/pause sequence doesn't flood the API.
  const lastWrittenTime = useRef<number>(-1);
  const writebackTarget = useRef<ActiveScrobbleTarget | null>(null);
  const writebackTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackRef     = useRef({ time: 0, duration: 0 });
  useEffect(() => { playbackRef.current = { time, duration }; }, [time, duration]);
  /** Episode id whose History row was already written by the 80 %
   *  auto-complete path (onAdvance) for the CURRENT play. Lets
   *  handleExitPlayback skip its duplicate append (addHistoryEntry
   *  dedups only on exact id+played_at, and the two paths fire at
   *  different timestamps). Reset per load in notifyNewLoad so a
   *  re-watch in the same session still logs a fresh row. */
  const autoHistoryWrittenId = useRef<string | null>(null);

  /** Stable, sync writer used in cleanup/pause paths so we don't capture stale
   *  state from old renders. Calls library_put best-effort.
   *
   *  Warmup gate: don't write progress until the user has watched
   *  `PROGRESS_WARMUP_S`. The previous 30 s threshold meant any wrong-stream
   *  preview that lasted half a minute landed in CW with a yellow in-progress
   *  badge — out of parity with auto-mark-watched, which requires 80 % +
   *  ≥300 s of elapsed playback. 120 s here matches the `scrobble_start`
   *  warmup (`useScrobble.ts::START_WARMUP_S_DEFAULT`), so both auto-mark
   *  surfaces fire only after the user is demonstrably committed to the
   *  stream rather than evaluating it.
   */
  const PROGRESS_WARMUP_S = 120;
  const flushProgress = useCallback(
    (sess: UserSession | null, target: ActiveScrobbleTarget | null) => {
      const { time, duration } = playbackRef.current;
      if (!sess?.auth_key || !target || duration <= 0) return;
      if (time < PROGRESS_WARMUP_S) return;
      // Skip if we already wrote this exact second — prevents duplicate writes
      // when pause and unmount fire close together.
      if (Math.abs(time - lastWrittenTime.current) < 1) return;
      lastWrittenTime.current = time;
      libraryWriteProgress(sess.auth_key, target, library, time, duration).catch(() => {});
    },
    [library],
  );

  // Track the latest active target in a ref so unmount cleanup can flush even
  // though the cleanup callback can't easily depend on activeTarget.
  useEffect(() => { writebackTarget.current = activeTarget; }, [activeTarget]);

  // Pause → write (debounced 800 ms so seeking-then-pausing settles first).
  useEffect(() => {
    if (!paused) return;
    if (!session || !activeTarget) return;
    if (writebackTimer.current) clearTimeout(writebackTimer.current);
    writebackTimer.current = setTimeout(() => flushProgress(session, activeTarget), 800);
    return () => { if (writebackTimer.current) clearTimeout(writebackTimer.current); };
  }, [paused, session, activeTarget, flushProgress]);

  // Active target changed (or cleared) → flush the *previous* target's progress.
  useEffect(() => {
    return () => {
      flushProgress(session, writebackTarget.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTarget]);

  // App unload — best-effort sync flush. Tauri's webview closes don't
  // guarantee `beforeunload`, but we try.
  useEffect(() => {
    const onUnload = () => flushProgress(session, writebackTarget.current);
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [session, flushProgress]);

  // ── Exit playback ────────────────────────────────────────────────────
  // Flushes progress, stops MPV, clears the active target. Triggered by the
  // PlayerOverlay's "Exit playback" button (and keybinding if configured).
  const handleExitPlayback = useCallback(async () => {
    flushProgress(session, writebackTarget.current);
    // Capture which episode the user just played BEFORE we clear
    // activeTarget. If this was an episode of a series/anime, DetailView
    // will scroll to it on its next mount (handled below via the
    // `lastPlayedEpisodeId` state).
    const playedEpisodeId = activeTarget?.id ?? null;
    const isSeriesEpisode = activeTarget?.series_id != null && activeTarget.series_id !== activeTarget.id;

    // ── History append ──
    // Append a History entry when the user actually watched content —
    // either crossed the 85 % threshold OR played 5+ minutes. The
    // `meaningful*` gate is sufficient on its own: a user who only
    // briefly previewed and bailed never crosses either bar, while
    // a real session (binge / completion) lands above one.
    //
    // We deliberately DO NOT skip on `isManuallyWatched(...)` any more.
    // The auto-advance flow (useScrobble's 90 % autocomplete →
    // `aura:auto-advance-watched` → advanceWatchedAfter) marks the
    // current episode "watched" BEFORE the user closes the player —
    // which used to cause this branch to skip every legitimately-
    // finished episode. Right-click "Mark as Watched" on a poster
    // happens OUTSIDE the player overlay, so handleExitPlayback
    // doesn't run for those flips at all and the gate isn't needed.
    if (activeTarget && playedEpisodeId) {
      const watched = time;
      const dur     = duration;
      // Both conditions must hold: at least 80 % progress AND at least
      // 5 minutes of fresh playback. The previous OR was over-eager
      // — a 5-minute drive-by on a 2-hour movie (or any 80 %+ resume
      // glance regardless of fresh-content) appended a history entry.
      // AND requires both engagement AND substantive progress, which
      // matches the user's expectation of "I actually watched this."
      const meaningfulRatio = dur > 0 && watched / dur >= 0.80;
      const meaningfulTime  = watched >= 5 * 60;
      const seriesId = activeTarget.series_id ?? activeTarget.id;
      // Skip if the 80 %-autocomplete path (onAdvance) already wrote a
      // History row for THIS play — addHistoryEntry only dedups exact
      // id+played_at and the two fire at different timestamps, so without
      // this guard every normally-watched episode would double-log.
      if (meaningfulRatio && meaningfulTime && autoHistoryWrittenId.current !== playedEpisodeId) {
        // Episode info for series. Prefer the VideoEntry-authoritative
        // `activeTarget.season` / `activeTarget.episode_num` — those
        // are set by App.tsx from the clicked video's metadata and are
        // correct regardless of id shape. Falls back to id-string
        // parsing (`tt12345:1:5` → S01E05) only for tt-prefixed ids
        // where the trailing segments are guaranteed to be S/E. After
        // AIOMetadata's IMDb-anime patch, non-tt ids (`kitsu:46474:5`)
        // have a provider id in the middle slot that would otherwise
        // get mis-parsed as season=46474.
        let season: number | null = activeTarget.season ?? null;
        let episode: number | null = activeTarget.episode_num ?? null;
        if (isSeriesEpisode && playedEpisodeId
            && (season == null || episode == null)
            && playedEpisodeId.startsWith("tt")) {
          const parts = playedEpisodeId.split(":");
          if (parts.length >= 3) {
            const s = Number(parts[parts.length - 2]);
            const e = Number(parts[parts.length - 1]);
            if (season == null && Number.isFinite(s)) season = s;
            if (episode == null && Number.isFinite(e)) episode = e;
          }
        }
        const libRecord = library.find((i) => i.id === seriesId) ?? null;
        addHistoryEntry({
          id:            playedEpisodeId,
          parent_id:     isSeriesEpisode ? seriesId : undefined,
          name:          activeTarget.name,
          media_type:    activeTarget.media_type,
          poster:        libRecord?.poster ?? selectedMeta?.poster ?? null,
          background:    libRecord?.background ?? selectedMeta?.background ?? null,
          season,
          episode,
          episode_title: activeTarget.episode_title ?? null,
          played_at:     new Date().toISOString(),
          duration:      dur || undefined,
          watched_seconds: watched,
        });
      }
      // Reset the per-play guard now the History decision for this play
      // is done, so a later re-watch of the same episode in this session
      // logs a fresh row (addHistoryEntry keys on id+played_at).
      autoHistoryWrittenId.current = null;
    }
    // Always exit fullscreen on exit-playback — fullscreen is a
    // player-scoped concept; once the player is gone the rest of the
    // app shouldn't stay covering the monitor. Use the native Win32
    // path so the saved pre-fullscreen window bounds get restored.
    try {
      await invoke("set_native_fullscreen", { enabled: false });
    } catch {}
    setIsFullscreen(false);
    try {
      await invoke("stop_video");
    } catch {
      // Best-effort — even if MPV's stop fails the UI clears below.
    }
    setActiveTarget(null);
    setActiveStreamUrl(null);
    setActiveExternalSubs([]);
    setActiveScoringMeta(null);
    // EOS Spotlight: ensure the end screen is torn down the instant the
    // player exits, independent of the activeTarget-reset effect's
    // ordering (the Spotlight's own Exit button routes here).
    setEosActive(false);
    if (isSeriesEpisode && playedEpisodeId) {
      // DetailView reads this once on mount, opens the episode panel,
      // selects the right season, and scrolls the matching row to the
      // top of the list (or highlights it if the list can't scroll
      // further). It then fires the consume callback so the next
      // unrelated DetailView open doesn't inherit the hint.
      setLastPlayedEpisodeId(playedEpisodeId);
    }
  }, [session, flushProgress, activeTarget, time, duration, library, selectedMeta]);

  // ── EOS Spotlight action handlers ───────────────────────────────────
  // Defined here (not next to the resolution effect above) because they
  // depend on `handleExitPlayback`, which is block-scoped just above.

  // Spotlight / END-CARD "Replay" — reload the CURRENT stream from 0
  // (mirrors the recovery modal's Reload, minus the resume offset).
  // Clearing eosActive tears the screen down; notifyNewLoad re-arms the
  // load-state UI so the buffering overlay shows through the re-buffer.
  const onEosReplay = useCallback(async () => {
    if (!activeStreamUrl) { setEosActive(false); handleExitPlayback(); return; }
    setEosActive(false);
    notifyNewLoad();
    try {
      await invoke("load_video", { path: activeStreamUrl, startSeconds: null });
    } catch (e) {
      console.error("[eos] replay failed", e);
    }
  }, [activeStreamUrl, handleExitPlayback, notifyNewLoad]);

  // "Play Next" reuses onNextUpPlay (carries this pass's History/
  // scrobble append + target build + handlePlayStream swap unchanged).
  const onEosPlayNext = useCallback(() => { void onNextUpPlay(); }, [onNextUpPlay]);

  const onEosExit = useCallback(() => {
    setEosActive(false);
    handleExitPlayback();
  }, [handleExitPlayback]);

  // Spotlight × / Escape — hide the end screen WITHOUT tearing playback
  // down (distinct from onEosExit's handleExitPlayback teardown). mpv is
  // idle/ended at EOF; the reverted DXGI flip model retains the last
  // decoded frame, so the user is left on the paused final frame. No
  // mpv pause/set_property here — flip-model retention handles the
  // visual (CLAUDE.md landmine #1: never mpv.command set_property).
  const onEosDismiss = useCallback(() => setEosActive(false), []);

  // EpisodePanel play path (Spotlight "Episodes" button + Phase 4 hover
  // edge). Same target shape as onNextUpPlay; routes through
  // handlePlayStream so the History/scrobble pass + reload-survival
  // invariant hold. Picking a DIFFERENT episode mid-stream is a user-
  // initiated jump (like DetailView's in-session switching), so we don't
  // duplicate the natural-finish History append here.
  const onEosPlayEpisode = useCallback((video: VideoEntry) => {
    if (!activeTarget) return;
    // No-op on the currently-playing episode.
    if (video.id === activeTarget.id) {
      setEosEpisodesOpen(false);
      return;
    }
    const seriesId = activeTarget.series_id ?? activeTarget.id;
    // Build (or reuse) the MetaPreview the DetailView will open against.
    const libRow = library.find((i) => i.id === seriesId) ?? null;
    const meta: MetaPreview = (selectedMeta && selectedMeta.id === seriesId)
      ? selectedMeta
      : {
          id:           seriesId,
          media_type:   activeTarget.media_type,
          name:         activeTarget.name,
          poster:       libRow?.poster ?? selectedMeta?.poster ?? null,
          background:   libRow?.background ?? selectedMeta?.background ?? null,
          fanart:       null,
          backdrop:     null,
          logo:         libRow?.logo ?? selectedMeta?.logo ?? null,
          release_info: libRow?.year ?? selectedMeta?.release_info ?? null,
          description:  null,
          imdb_rating:  null,
          genres:       [],
        };
    // Drop EOS surfaces synchronously so the panel disappears instantly.
    setEosEpisodesOpen(false);
    setEosActive(false);
    setNextUpInfo(null);
    // Tear down playback (history/scrobble append already handled by
    // handleExitPlayback + the 80% autocomplete from the prior pass).
    handleExitPlayback();
    // Anchor DetailView on this episode + force streams-mode initial panel
    // so the user lands directly in the streams picker for the chosen
    // episode (one click from Spotlight's EpisodePanel → playable). The
    // openInStreamsMode hint takes precedence in DetailView's panelMode
    // init; without it the user would land on the episodes-list view
    // and have to click the episode again to reach the streams panel.
    setLastPlayedEpisodeId(video.id);
    setIgnoreResumeOnNextOpen(false);
    setOpenInStreamsMode(true);
    setSelectedRect(null);
    setSelectedMeta(meta);
  }, [
    activeTarget, library, selectedMeta, handleExitPlayback,
  ]);

  /** Set by handleExitPlayback when the user just finished an episode of
   *  a series/anime; consumed by DetailView's mount effect to anchor the
   *  episode list on the just-played row. Cleared after consumption so
   *  re-opening detail views from elsewhere doesn't re-anchor. */
  const [lastPlayedEpisodeId, setLastPlayedEpisodeId] = useState<string | null>(null);
  const consumeLastPlayedEpisode = useCallback(() => setLastPlayedEpisodeId(null), []);

  // EOF auto-exit REMOVED (EOS Spotlight, 2026-05-19): the dead `eof`
  // carrier never fired (Rust never sets PlaybackState.eof). End-of-
  // stream is now detected via the `playback-end` reason="eof" branch /
  // near-end stale-heartbeat path, both of which dispatch
  // `aura:eos-detected`; the EOS Spotlight owns the end screen and
  // routes Exit through handleExitPlayback explicitly.

  // ── MPV transparent passthrough ───────────────────────────────────────
  // When a video is loaded, NO React content can paint opaque pixels in the
  // webview — the native MPV layer beneath has to win every pixel. We add
  // `.playing-video` as soon as `activeTarget` is set (i.e., the user
  // clicked a stream and we issued `load_video`), BEFORE MPV produces a
  // first frame. The CSS in App.css forces every theme's body / #root to
  // `background: transparent`. The body div in the JSX below is also
  // `display: none`-d via the `hidden` Tailwind class for belt-and-braces.

  // ── Fullscreen state (lifted from PlayerOverlay) ──
  // The TitleBar is part of the webview content; Tauri's setFullscreen only
  // resizes the OS window and won't hide it. We track fullscreen here and
  // unmount the TitleBar when active, so MPV truly covers the whole screen.
  //
  // OWNERSHIP NOTE: this state is owned by `handleFullscreen` (the F11
  // toggle path) and by the playback-exit cleanup (`handleExitPlayback`
  // sets it back to false). We do NOT reactively sync from
  // `win.isFullscreen()` on every resize: Aura drives fullscreen via the
  // Win32 path (`set_native_fullscreen` → `win32::enter_native_fullscreen`)
  // which Tauri's API doesn't know about, so `win.isFullscreen()` always
  // returns false. A previous version of this effect listened to
  // `onResized` and called setIsFullscreen(false) on every WM_SIZE — which
  // wiped out the optimistic `setIsFullscreen(true)` from `handleFullscreen`
  // mid-toggle, leaving the TitleBar visible AND making the user's next
  // F11 press call enter_native_fullscreen a SECOND time (overwriting
  // SAVED_BOUNDS / SAVED_WAS_MAXIMIZED with already-fullscreen state).
  // We still do the one-shot mount-time query so a fullscreen state set
  // by a previous run / restored-from-tray scenario is reflected.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    let mounted = true;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      win.isFullscreen()
        .then((fs) => { if (mounted) setIsFullscreen(fs); })
        .catch(() => {});
    });
    return () => { mounted = false; };
  }, []);

  // ── App-wide Esc handler ──────────────────────────────────────────────
  // Acts as a "back" / "dismiss" key everywhere in the app. Priority,
  // top-down — first match wins:
  //   1. fullscreen player → exit fullscreen (PlayerOverlay's own ESC
  //      handler runs first and consumes; we only fall through here when
  //      the player is windowed)
  //   2. player active     → exit playback (returns to DetailView)
  //   3. detail view open  → close DetailView (back to catalog)
  //   4. catalog view open → back to Home
  //   5. login modal open  → close modal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (isFullscreen) return; // PlayerOverlay's own ESC handler owns this
      // EOS layers own Escape when visible — their own listeners dismiss themselves.
      // Top-layer-wins: EpisodePanel (z-10400) > Spotlight (z-10300) > playback exit.
      if (eosEpisodesOpen) return;
      if (eosActive) return;
      if (isPlayerActive) {
        e.stopPropagation();
        handleExitPlayback();
        return;
      }
      if (selectedMeta) {
        e.stopPropagation();
        closeDetail();
        return;
      }
      if (activeCatalog) {
        e.stopPropagation();
        setActiveCatalog(null);
        return;
      }
      if (showLogin) {
        e.stopPropagation();
        setShowLogin(false);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    isFullscreen, isPlayerActive, selectedMeta, activeCatalog, showLogin,
    handleExitPlayback, closeDetail, eosActive, eosEpisodesOpen,
  ]);

  const toggleFullscreen = useCallback(async () => {
    // We bypass Tauri's `setFullscreen` and use a native Win32 path
    // (`set_native_fullscreen`) because Tauri's implementation on
    // borderless+transparent windows lands at work-area bounds, leaving
    // a strip of taskbar reserved area uncovered. The Rust command moves
    // the parent window to the FULL monitor rcMonitor, which Windows
    // then recognises as a fullscreen window (taskbar auto-hides).
    const next = !isFullscreen;
    // Optimistic local update so the TitleBar unmounts on the same paint
    // as the OS resize fires.
    setIsFullscreen(next);
    try {
      await invoke("set_native_fullscreen", { enabled: next });
    } catch (e) {
      console.error("set_native_fullscreen failed", e);
      // Fall back to Tauri's API rather than leaving the user stuck.
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().setFullscreen(next);
      } catch {}
    }
    // Repoint MPV's child window now that the parent's bounds changed.
    // We pass our authoritative `next` value rather than letting Rust
    // re-query Tauri (which lags behind the OS during transitions).
    setTimeout(() => {
      invoke("refresh_video", { isFullscreen: next }).catch(() => {});
    }, 80);
    setTimeout(() => {
      invoke("refresh_video", { isFullscreen: next }).catch(() => {});
    }, 240);
  }, [isFullscreen]);

  // ── Force MPV redraw on every window resize during playback ──
  // Even within windowed mode, dragging to a new size leaves MPV's child
  // window stale on some libmpv builds. We listen for `onResized` and
  // poke MPV to redraw whenever a video is loaded. Capture the current
  // `isFullscreen` so the Rust side picks the right y-offset without
  // having to query Tauri (which races the OS during transitions).
  const isFullscreenRef = useRef(isFullscreen);
  useEffect(() => { isFullscreenRef.current = isFullscreen; }, [isFullscreen]);

  useEffect(() => {
    if (!isPlayerActive) return;
    let mounted = true;
    let unlistenResize:  Promise<() => void> | null = null;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (!mounted) return;
      const win = getCurrentWindow();
      unlistenResize = win.onResized(() => {
        invoke("refresh_video", {
          isFullscreen: isFullscreenRef.current,
        }).catch(() => {});
      });
      // The focus-regain refresh used to live here as a fix for MPV's
      // child-window bounds drifting up by ~36 px during alt-tab
      // cycles. Removed — it caused a VISIBLE expand-then-shrink flicker
      // every time focus returned (the video-zoom toggle inside
      // refresh_video re-renders the frame at zoom→0 then back). The
      // duration-armed multi-fire above is enough to keep MPV at the
      // right bounds without needing reactive focus refreshes.
    });
    return () => {
      mounted = false;
      unlistenResize?.then((fn) => fn()).catch(() => {});
    };
  }, [isPlayerActive]);

  // ── Re-fire refresh_video on fullscreen transitions ──
  // The fullscreen toggle changes the y-offset MPV's child should use
  // (0 in fullscreen, 36 in windowed). `toggleFullscreen` itself fires
  // refresh_video at 80 ms and 240 ms, but the OS sometimes hasn't
  // finished the resize by then — `is_fullscreen()` returns the wrong
  // state and MPV ends up sized for the previous mode. By also firing
  // here whenever `isFullscreen` flips (and once more 600 ms later) we
  // catch the case where the OS resize lands after the initial pair.
  //
  // Safe to re-introduce now that the get_tracks crash is fixed — that
  // was the actual culprit when this effect was in place earlier.
  useEffect(() => {
    if (!isPlayerActive) return;
    invoke("refresh_video", { isFullscreen }).catch(() => {});
    const t = setTimeout(() => {
      invoke("refresh_video", { isFullscreen }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [isFullscreen, isPlayerActive]);

  // ── Duration-armed MPV resize ──
  // MPV's vo creates its child window LAZILY — not at load_video time but
  // the moment it has its first decoded frame. Until then,
  // `resize_mpv_child_to_parent` enumerates the parent's children and
  // finds nothing (or finds a stale handle) and silently no-ops.
  //
  // Symptom: video starts up rendering BEHIND the Aura title bar (top 36 px
  // covered) until the user alt-tabs out and back in — the focus-regain
  // handler re-fires refresh_video AFTER the vo is up and the bounds
  // get re-applied. Same symptom in fullscreen: child is at the previous
  // windowed bounds until something prods it.
  //
  // Fix: when `duration` flips 0 → positive (= MPV decoded a frame and
  // the child is in the tree), fire refresh_video repeatedly across the
  // first ~3 seconds. Some libmpv builds layout the vo asynchronously
  // — even after duration > 0 the actual child HWND can take a beat to
  // be enumerated correctly. The repeated firing is idempotent and
  // costs nothing past the first hit that lands.
  const durationReady = duration > 0;
  useEffect(() => {
    if (!durationReady) return;
    const fire = () => {
      invoke("refresh_video", {
        isFullscreen: isFullscreenRef.current,
      }).catch(() => {});
    };
    fire();
    const delays = [80, 200, 500, 1000, 2000];
    const timers = delays.map((d) => setTimeout(fire, d));
    return () => { timers.forEach(clearTimeout); };
  }, [durationReady]);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const root = document.getElementById("root");
    if (isPlayerActive) {
      html.classList.add("playing-video");
      body.classList.add("playing-video");
      root?.classList.add("playing-video");
    } else {
      html.classList.remove("playing-video");
      body.classList.remove("playing-video");
      root?.classList.remove("playing-video");
    }
    return () => {
      html.classList.remove("playing-video");
      body.classList.remove("playing-video");
      root?.classList.remove("playing-video");
    };
  }, [isPlayerActive]);

  // ── Discord Rich Presence ──
  //
  // Mirrors stremio-community-v5 (https://github.com/Zaarrg/stremio-community-v5,
  // src/utils/discord.cpp): every navigable scene gets its own activity card.
  // Browse states have NO timestamp (matches v5 — keeps the elapsed counter
  // from growing stale on a parked screen). Playback uses a fresh started_at
  // on each new title; pausing zeros the timestamp so Discord stops counting.
  //
  // State precedence (high → low):
  //   1. Active playback (paused or playing) — title + episode
  //   2. Detail page open (selectedMeta, no playback)
  //   3. Catalog deep-view (activeCatalog under Home)
  //   4. Search active on Home
  //   5. Top-level activeView (home / library / calendar / addons / settings)
  //
  // Backend gates: discord_rpc_enabled (master), discord_rpc_browse_states
  // (browse-only suppression), discord_rpc_show_titles + blocked_titles
  // (playback only — those keys are content-specific).
  const [homeSearchActive, setHomeSearchActive] = useState(false);
  useEffect(() => {
    const onSearch = (e: Event) => {
      const ce = e as CustomEvent<{ query: string | null }>;
      setHomeSearchActive(!!ce.detail?.query);
    };
    window.addEventListener("aura:home-search-changed", onSearch);
    return () => window.removeEventListener("aura:home-search-changed", onSearch);
  }, []);

  const presenceStartedAt = useRef<number | null>(null);
  const lastSceneRef = useRef<string>("");
  // Debounce timer for the RPC `invoke`. MPV's `pause` property can
  // flap rapidly while the cache fills (resume → small underflow →
  // re-pause within tens of ms), and that was producing dozens of
  // Playing/Paused round-trips per second on Discord — visibly
  // burning the rate limit and spamming the dev log. We hold a 400 ms
  // settle window: if the deps change again before the timer fires,
  // we cancel and re-arm. The user pays a one-shot 400 ms latency on
  // a clean toggle, which is well below the human pause→update
  // threshold for Rich Presence.
  const rpcInvokeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastInvokedPresenceRef = useRef<string>("");
  useEffect(() => {
    // Don't broadcast presence while the user is on the landing/login screen
    // or before we've finished checking session — nothing meaningful to show
    // and "Resuming Favorites" while the user is signing in is misleading.
    const onLanding = !session && !landingDismissed;
    if (!authChecked || onLanding) {
      lastSceneRef.current = "";
      presenceStartedAt.current = null;
      invoke("discord_clear_presence").catch(() => {});
      return;
    }

    let sceneKey = "";
    let isPlayback = false;
    let title = "";
    let subtitle: string | null = null;
    let useTimestamp = false;
    // Per-scene art — Discord RPC (v9+) accepts raw HTTPS URLs in the
    // `large_image` slot in addition to uploaded asset names. We pass
    // the meta poster / background through when watching or viewing
    // a specific title; the backend falls back to "aura_logo" otherwise.
    // Hover text mirrors the show / movie name when known.
    let largeImage: string | null = null;
    let largeText: string | null = null;

    if (activeTarget && duration > 0) {
      isPlayback = true;
      title = activeTarget.name;
      subtitle = paused
        ? `Paused${activeTarget.episode ? ` · ${activeTarget.episode}` : ""}`
        : (activeTarget.episode ?? null);
      // Pause keeps the same scene key — we don't want to reset the elapsed
      // counter every time the user pauses. Discord just hides the timer
      // while paused (started_at = 0) and on resume we re-anchor it to the
      // real video position so Discord matches what the user is watching,
      // not how long the app has been open.
      sceneKey = `play:${activeTarget.media_type}:${activeTarget.id}`;
      useTimestamp = !paused;
      // Prefer the stylized logo (transparent PNG) for playback art —
      // Discord renders it as the rich square so a clean logo reads
      // better than a 16:9 backdrop. Fall back through poster if no logo.
      largeImage = pickArt(
        activeTarget.logo ?? null,
        selectedMeta?.poster ?? null,
        selectedMeta?.background ?? null,
      );
      largeText = activeTarget.name;
    } else if (selectedMeta) {
      const isSeries = (selectedMeta.media_type ?? "").toLowerCase() === "series";
      title = selectedMeta.name;
      subtitle = isSeries ? "Exploring a Series" : "Exploring a Movie";
      sceneKey = `meta:${selectedMeta.media_type}:${selectedMeta.id}`;
      largeImage = pickArt(
        selectedMeta.poster,
        selectedMeta.background,
        selectedMeta.fanart,
        selectedMeta.backdrop,
      );
      largeText = selectedMeta.name;
    } else if (activeCatalog) {
      title = activeCatalog.catalogName || "Browsing Catalog";
      subtitle = "On Discover";
      sceneKey = `cat:${activeCatalog.addonUrl}:${activeCatalog.catalogId}:${activeCatalog.mediaType}`;
    } else if (activeView === "home" && homeSearchActive) {
      title = "Searching for Shows & Movies";
      subtitle = "In Search";
      sceneKey = "search";
    } else {
      switch (activeView) {
        case "home":     title = "Resuming Favorites";       subtitle = "On Board";     sceneKey = "home";     break;
        case "library":  title = "Revisiting Old Favorites"; subtitle = "In Library";   sceneKey = "library";  break;
        case "queue":    title = "Lining Up What's Next";    subtitle = "In Queue";     sceneKey = "queue";    break;
        case "calendar": title = "Planning My Next Binge";   subtitle = "On Calendar";  sceneKey = "calendar"; break;
        case "addons":   title = "Exploring Add-ons";        subtitle = "In Add-ons";   sceneKey = "addons";   break;
        case "settings": title = "Tuning Preferences";       subtitle = "In Settings";  sceneKey = "settings"; break;
      }
    }

    // New scene → fresh timer (only matters for playback; browse states pass 0).
    if (sceneKey !== lastSceneRef.current) {
      presenceStartedAt.current = Math.floor(Date.now() / 1000);
      lastSceneRef.current = sceneKey;
    }

    // Playback-specific: anchor started_at to the real video position so
    // Discord's elapsed counter matches the timeline (not "minutes since
    // app launch"). Recomputed only on play→pause→play transitions; the
    // dep array deliberately doesn't include `time`, otherwise Discord
    // would get spammed every second.
    let startedAt = presenceStartedAt.current ?? 0;
    if (isPlayback && useTimestamp && time > 0) {
      startedAt = Math.floor(Date.now() / 1000) - Math.floor(time);
    }

    const presence = {
      title,
      subtitle,
      started_at: useTimestamp ? startedAt : 0,
      is_playback: isPlayback,
      large_image_url: largeImage,
      large_image_text: largeText,
    };

    // Cancel any in-flight schedule and reschedule. The previous
    // timer never gets to call `invoke` if the deps change again
    // within 400 ms, which is exactly the pause-flap window MPV
    // produces during cache settle.
    if (rpcInvokeTimer.current) {
      clearTimeout(rpcInvokeTimer.current);
    }
    // Skip the started_at field for the dedupe signature — it ticks
    // by ~1 s per re-render via the `time` recompute, which would
    // otherwise defeat the dedupe even when nothing user-visible has
    // changed.
    const sig = JSON.stringify({ ...presence, started_at: useTimestamp ? "ts" : 0 });
    rpcInvokeTimer.current = setTimeout(() => {
      if (sig === lastInvokedPresenceRef.current) return;
      lastInvokedPresenceRef.current = sig;
      invoke("discord_set_presence", { presence }).catch(() => {});
    }, 400);
  }, [
    authChecked, session, landingDismissed,
    activeTarget, duration, paused,
    selectedMeta, activeCatalog,
    activeView, homeSearchActive,
  ]);

  // ── Deep-link routing ──
  // Rust emits the `deep-link` Tauri event for both `aura://` and
  // `stremio://` protocol URLs. Routes:
  //   aura://search?q=<query>             → navigate to Home and run a search
  //   stremio://detail/<type>/<id>        → open the matching DetailView
  //   aura://detail/<type>/<id>           → same (alias)
  useEffect(() => {
    const p = listen<string>("deep-link", ({ payload }) => {
      try {
        const url = new URL(payload);
        // OAuth callback from the VPS proxy at aura.animasec.dev. The
        // proxy exchanges the provider's authorization code for an
        // access_token (using the client_secret it holds), then
        // redirects the browser at `aura://oauth/{trakt,anilist}?...`
        // with the token + refresh + expires + username in query
        // params. We persist the token via the Tauri command and
        // surface a toast so the user knows the connection landed.
        if (url.hostname === "oauth") {
          const service = url.pathname.replace(/^\//, "").toLowerCase();
          if (service !== "trakt" && service !== "anilist") return;
          const access_token  = url.searchParams.get("token");
          const refresh_token = url.searchParams.get("refresh");
          const expiresStr    = url.searchParams.get("expires");
          const username      = url.searchParams.get("user");
          if (!access_token) {
            showAppToast(`${service} OAuth callback missing token`, { duration: 5000 });
            return;
          }
          // Recover the scope SettingsView stashed under the per-
          // provider pending slot when the user clicked Connect.
          // The proxy's deep-link doesn't round-trip any
          // identifier, so this slot is the only way to know which
          // Stremio account to write the token under. Falling back
          // to "guest" covers edge cases (manual nav to
          // aura://oauth/..., user restarted Aura mid-flow) without
          // dropping the token.
          const stashKey   = `aura:oauth:pending:${service}`;
          const stateScope = sessionStorage.getItem(stashKey) ?? "guest";
          sessionStorage.removeItem(stashKey);
          const expires_at = expiresStr ? Number(expiresStr) : null;
          invoke("set_scrobble_auth_token", {
            service,
            scope: stateScope,
            accessToken:  access_token,
            refreshToken: refresh_token ?? null,
            expiresAt:    Number.isFinite(expires_at) ? expires_at : null,
            username:     username ?? null,
          })
            .then(() => {
              showAppToast(
                `Connected to ${service.charAt(0).toUpperCase() + service.slice(1)}` +
                (username ? ` as ${username}` : ""),
                { duration: 4000 },
              );
              window.dispatchEvent(new CustomEvent("aura:scrobble-auth-changed"));
            })
            .catch((err) => {
              showAppToast(`${service} token store failed: ${String(err)}`, { duration: 6000 });
            });
          return;
        }
        if (url.hostname === "search") {
          const q = url.searchParams.get("q") ?? "";
          if (q) {
            setActiveView("home");
            setActiveCatalog(null);
            setDeepLinkSearch(q);
          }
          return;
        }
        if (url.hostname === "detail") {
          // Stremio's canonical detail URL is /detail/<type>/<id>; the
          // `id` may itself contain colons (e.g. `tt0903747:1:5` for an
          // episode), but pathname.split('/') tolerates that — the path
          // is `/series/tt0903747` not `/series/tt0903747:1:5` because
          // Stremio strips the episode segment before routing the
          // detail page. Anything past the second segment is ignored.
          const parts = url.pathname.split("/").filter(Boolean);
          const type = parts[0];
          const id   = parts[1];
          if (!type || !id) return;
          // Build a minimal MetaPreview stub — DetailView fetches the
          // full meta-detail itself, so the missing poster / name etc.
          // get filled in within ~100 ms after the detail mounts.
          // Closing detail and re-opening with new state in the same
          // tick would race with the fade-out animation; setSelectedMeta
          // alone handles the swap cleanly because the close handler
          // resets state to null first when detail closes.
          setActiveView("home");
          setActiveCatalog(null);
          openDetail({
            id,
            name: "",
            media_type: type,
            poster: null,
            background: null,
            fanart: null,
            backdrop: null,
            logo: null,
            release_info: null,
            description: null,
            imdb_rating: null,
          } as MetaPreview);
        }
      } catch {}
    });
    return () => { p.then((fn) => fn()).catch(() => {}); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Boot-ready gate ──
  // The boot splash stays up until homeView has fully settled so the hero
  // doesn't flicker through multiple catalogs before the user sees the screen.
  //
  // Three paths to bootReady = true:
  //   1. Landing path: auth resolved AND user is on the landing screen (or has
  //      no addons and therefore no HomeView catalogs to wait on) → flip
  //      immediately once authChecked.
  //   2. Normal path: HomeView dispatches `aura:home-ready` after its parallel
  //      catalog fetch completes + 200 ms HeroCarousel settle grace period.
  //   3. Hard timeout: 8 s safety valve in case home never signals (no addons,
  //      slow network, error path).
  useEffect(() => {
    if (!authChecked) return; // wait for keyring check first
    // If the splash already faded (e.g. the landing bypass ran, then the user
    // signed in and session/landingDismissed changed), don't re-arm anything.
    if (bootReadyRef.current) return;

    const markReady = () => {
      bootReadyRef.current = true;
      setBootReady(true);
    };

    // Landing-screen bypass: no session and guest not chosen → the home view
    // won't mount, so there's nothing to wait on.
    const onLandingScreen = !session && !landingDismissed;
    if (onLandingScreen) {
      markReady();
      return;
    }

    const onHomeReady = () => markReady();
    window.addEventListener("aura:home-ready", onHomeReady, { once: true });

    // Hard safety timeout — 8 s covers the worst-case slow-network scenario.
    const hardTimeout = setTimeout(() => markReady(), 8000);

    return () => {
      window.removeEventListener("aura:home-ready", onHomeReady);
      clearTimeout(hardTimeout);
    };
  }, [authChecked, session, landingDismissed]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show landing when no session AND user hasn't yet chosen guest mode.
  const showLanding = !session && !landingDismissed;

  return (
    <ThemeEngine>
    <LibraryProvider library={library}>
    <NotificationsProvider>
    <NotificationsBridge
      addons={addons}
      library={library}
      authKey={session?.auth_key ?? null}
      // Suppress the floating popup bubble while the user is in
      // playback OR has DetailView open. The notification still
      // lands in the bell's ring buffer and badge count, but the
      // bubble would either be hidden (playback unmounts the bell)
      // or distracting (over the DetailView's tech-noir layout).
      // The most-recently-suppressed candidate is shown the next
      // time the user navigates back to a bell-visible surface.
      popupSuppressed={isPlayerActive || selectedMeta != null}
      onOpenMeta={(metaId, mediaType) => {
        // Reconstruct a MetaPreview from the LibraryItem when available
        // (covers the scanner's episode notifications since they always
        // refer to a series the user has in their library). Falls back to
        // a minimal stub when not — DetailView's own meta-fetch will
        // still resolve poster / background once it mounts.
        const lib = library.find((i) => i.id === metaId);
        const stub: MetaPreview = lib
          ? {
              id:           lib.id,
              name:         lib.name,
              media_type:   lib.media_type,
              poster:       lib.poster,
              background:   lib.background,
              fanart:       null,
              backdrop:     null,
              logo:         lib.logo,
              release_info: lib.year,
              description:  null,
              imdb_rating:  null,
              genres:       [],
            }
          : {
              id:           metaId,
              name:         metaId,
              media_type:   mediaType ?? "series",
              poster:       null,
              background:   null,
              fanart:       null,
              backdrop:     null,
              logo:         null,
              release_info: null,
              description:  null,
              imdb_rating:  null,
              genres:       [],
            };
        // Force-route to Home so the detail overlay anchors over the home
        // backdrop — Library or other views also work but Home is the
        // bell's host so the user expects to land there on a click.
        setActiveCatalog(null);
        setActiveView("home");
        openDetail(stub);
      }}
    />
    {/* Boot splash — stays up until bootReady (all catalog rows settled +
        HeroCarousel stable) so the hero doesn't flicker on first paint.
        Falls back to an 8-second hard timeout for slow-network / no-addon
        cases.  On the landing screen it fades as soon as authChecked. */}
    <BootSplash visible={!bootReady} />
    {/* Ambient global sweep — UNMOUNTED while a video is playing so its
        6-10 % gradient never tints / hides the MPV layer. */}
    <AmbientAura hidden={isPlayerActive} />
    <div className="aura-app-shell h-screen w-screen overflow-hidden flex flex-col relative">
      {/* Invisible window-resize edges + corners. `decorations: false` means
          the OS doesn't draw the usual hidden resize borders, so without
          these handles the user can't grab any edge to resize. Hidden in
          fullscreen because the window doesn't resize there. */}
      {!isFullscreen && <ResizeHandles />}
      {/* ── Custom title bar — completely unmounted during playback so the
              native MPV window has access to pixel 0,0. We also unmount in
              true fullscreen mode for the same reason. ── */}
      {/* Title bar is HIDDEN only in true OS-level fullscreen. During
          windowed playback we keep it on so the user can still see the
          Aura wordmark, drag the window, and hit min/max/close — MPV
          renders below it. The `opaque` prop thickens the bar to fully
          black during playback so MPV's video doesn't bleed through. */}
      {!isFullscreen && <TitleBar opaque={isPlayerActive} />}

      {/* ── Body ── */}
      {showLanding ? (
        <LandingView
          onSignedIn={handleLoginSuccess}
          onContinueGuest={handleContinueGuest}
        />
      ) : onboardingActive && !isPlayerActive ? (
        <OnboardingView
          session={session}
          addons={addons}
          startAtAddons={onboardingStartAddons}
          onAddonInstalled={(entry) => {
            setAddons((prev) =>
              prev.some((a) => a.url === entry.url) ? prev : [...prev, entry]
            );
          }}
          onComplete={() => {
            setOnboardingActive(false);
            setOnboardingStartAddons(false);
          }}
        />
      ) : (
      <div
        className={`flex-1 flex gap-3 p-3 min-h-0 ${
          // Hide the entire app body the instant a stream is selected —
          // we don't wait for MPV's first frame (the `duration > 0` flip
          // happens later) because any opaque webview paint during the
          // load delay tints / hides the native MPV layer.
          isPlayerActive ? "hidden" : ""
        }`}
      >
      {/* ── Nav sidebar (floating glass island) ── */}
      <NavSidebar
        active={activeView}
        onNavigate={(view) => {
          setActiveCatalog(null);
          // Always clear search when navigating to Home — even from another
          // view — so the user lands on the catalog rows, not stale results.
          if (view === "home") setHomeResetKey((k) => k + 1);
          setActiveView(view);
        }}
        // Use auth_key (not email) as the source of truth for "signed
        // in" state. Some keyring entries from earlier builds don't
        // have email populated; auth_key is the field the API actually
        // needs and the one that's reliably persisted.
        loggedIn={!!session?.auth_key}
        userEmail={session?.email ?? null}
        onLoginRequest={() => setShowLogin(true)}
        onLogout={handleLogout}
      />

      {/* ── Main content area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {activeView === "home" && (
          <HomeView
            addons={addons}
            session={session}
            library={library}
            onSelectMeta={openDetail}
            onSelectFromCW={openDetailFromCW}
            resetKey={homeResetKey}
            externalQuery={deepLinkSearch}
            onExternalQueryConsumed={() => setDeepLinkSearch(null)}
          />
        )}
        {activeView === "library" && (
          <LibraryView
            library={libraryLoaded ? library : undefined}
            session={session}
            onSelectMeta={openDetail}
            onRemoveItem={handleLibraryRemove}
          />
        )}
        {activeView === "addons" && (
          <AddonsView
            addons={addons}
            session={session}
            onAdd={handleAddonAdded}
            onRemove={handleAddonRemoved}
            onLoginSuccess={handleLoginSuccess}
            onLogout={handleLogout}
            onSessionExpired={handleSessionExpired}
          />
        )}
        {activeView === "discover" && (
          <DiscoverView addons={addons} onSelectMeta={openDetail} />
        )}
        {activeView === "calendar" && (
          <CalendarView library={library} addons={addons} onSelectMeta={openDetail} />
        )}
        {activeView === "history" && (
          <HistoryView onSelectMeta={openDetail} />
        )}
        {activeView === "queue" && (
          <QueueView library={library} onSelectMeta={openDetail} />
        )}
        {activeView === "settings" && (
          <SettingsView addons={addons} session={session} />
        )}
      </div>

      {/* Account button — top-left, below the title bar's
          SyncStatusChip. Same body-level placement as the bell /
          refresh below so all three floating account/notification
          affordances inherit the `hidden` class during playback. */}
      <AccountButton
        loggedIn={!!session?.auth_key}
        email={session?.email ?? null}
        onLoginRequest={() => setShowLogin(true)}
        onLogout={handleLogout}
      />
      {/* Notifications bell — fixed bottom-3 left-3, rendered INSIDE
          the app body so it inherits the `hidden` class during
          playback and unmounts visually when the player owns the
          screen. Living here (rather than inside HomeView) lets the
          bell appear on every main tab (Home, Library, Calendar,
          Addons, Settings); the NotificationsProvider above keeps
          state continuous. The manual library-refresh control now
          lives inside this bell's popup header. */}
      <NotificationsBell library={library} />

      </div>
      )}

      {/* ── PlayerOverlay — z-9999, transparent, mounts as soon as the
              user picks a stream (before MPV has a duration). The overlay
              owns the entire viewport minus the title bar; controls are
              auto-hidden after 3 s of mouse idle. */}
      {/* Stream-broken recovery. Triggered by THREE detectors in
          usePlayback: (a) stale-heartbeat — firstFrameSeen + no
          time-pos ticks for 8 s (mid-play stall, e.g. seek into a
          dead chunk); (b) playback-end with reason=error — MPV
          aborted the load (DNS / TCP / demuxer / codec failure);
          (c) load watchdog — no first frame after 45 s (silent
          network hang). All three converge on the same overlay:
          Reload re-invokes load_video with the last-known time as
          the resume offset; Exit drops out to the detail view.
          Sits ABOVE PlayerOverlay so the user can't accidentally
          interact with the dead controls underneath. */}
      {streamBroken && isPlayerActive && (
        <div
          // z-[10500] sits above PlayerOverlay's z-[9999] click-capture
          // layer AND its z-[10000] submenu portals. Without this,
          // clicks on the Reload / Exit buttons pass through to
          // PlayerOverlay's video-click handler (togglePause) instead
          // of landing on the modal.
          className="fixed inset-0 z-[10500] flex items-center justify-center
                     bg-black/75 backdrop-blur-md animate-[fade-in_120ms_ease-out]"
        >
          <div className="aura-glass-menu rounded-2xl max-w-[420px] w-[92%] p-6 text-white">
            <h2 className="text-[16px] font-semibold tracking-tight mb-2">
              {firstFrameSeen ? "Stream connection lost" : "Stream unavailable"}
            </h2>
            <p className="text-white/70 text-[13px] leading-relaxed mb-5">
              {firstFrameSeen
                ? "Aura hasn't received a playback heartbeat in 8 s. The most common cause is a transient DNS / TCP failure during a seek. Try reloading from your last position, or exit and pick another source."
                : "Aura couldn't open the stream. The addon's host may be down or unreachable (DNS / TCP failure). Try reloading, or exit and pick a different source."}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => { setStreamBroken(false); handleExitPlayback(); }}
                className="px-4 py-2 rounded-lg text-[13px] font-medium tracking-wide
                           text-white/85 bg-white/[0.06] border border-white/12
                           hover:bg-white/[0.10] hover:text-white transition-colors"
              >
                Exit player
              </button>
              <button
                type="button"
                onClick={async () => {
                  if (!activeStreamUrl) {
                    setStreamBroken(false);
                    handleExitPlayback();
                    return;
                  }
                  // Snapshot the resume offset BEFORE notifyNewLoad
                  // resets `time` to 0. Sub-1s offsets aren't worth
                  // a "resume" — the seek-and-buffer dance would
                  // dominate the experience and the user wouldn't
                  // notice the position difference anyway.
                  const resumeAt = time > 1 ? time : null;
                  setStreamBroken(false);
                  notifyNewLoad();
                  try {
                    await invoke("load_video", {
                      path: activeStreamUrl,
                      startSeconds: resumeAt,
                    });
                  } catch (e) {
                    console.error("Reload failed", e);
                  }
                }}
                className="px-4 py-2 rounded-lg text-[13px] font-medium tracking-wide
                           text-ln-accent bg-ln-accent/15 border border-ln-accent/35
                           hover:bg-ln-accent/25 hover:border-ln-accent/55
                           transition-colors"
              >
                Reload stream
              </button>
            </div>
          </div>
        </div>
      )}

      {isPlayerActive && (
        <PlayerOverlay
          activeTarget={activeTarget}
          time={time}
          duration={duration}
          paused={paused}
          volume={volume}
          speed={speed}
          buffering={buffering}
          bufferPct={bufferPct}
          firstFrameSeen={firstFrameSeen}
          togglePause={togglePause}
          seekRelative={seekRelative}
          seekAbsolute={seekAbsolute}
          commitVolume={commitVolumeAndSave}
          commitSpeed={commitSpeed}
          onExitPlayback={handleExitPlayback}
          subsOpen={subsOpen}
          setSubsOpen={setSubsOpen}
          isFullscreen={isFullscreen}
          onToggleFullscreen={toggleFullscreen}
          streamUrl={activeStreamUrl}
          externalSubs={activeExternalSubs}
          preferredAudioLang={
            // Per-title override is the ONLY thing that should pre-empt
            // the user's audio_priority list. Global / anime defaults
            // belong inside the priority list (the "original, en"
            // default token wires those up automatically), not here —
            // pre-pending them was breaking the "original" token for
            // every non-anime-prefixed series (including IMDb-id'd anime
            // like Frieren) by putting "en" at the front.
            titleOverrides?.audio_lang ?? null
          }
          preferredSubLang={
            // Per-title sub_lang override beats the global default.
            titleOverrides?.sub_lang ?? subtitleLanguage
          }
          selectableSubLangs={selectableSubLangs}
          scoringMeta={activeScoringMeta}
          audioPriority={audioPriority}
          avoidDubs={avoidDubs}
          userRegion={userRegion}
          silentWakeCodes={[keybindings["volume-up"], keybindings["volume-down"]]}
          episodePanel={(() => {
            // In-playback episode drawer data (EOS Spotlight Phase 4).
            // Series/anime only — null for movies so PlayerOverlay
            // doesn't render the edge handle. seriesArt mirrors the
            // Spotlight's fallback chain.
            if (!activeTarget) return null;
            const mt = (activeTarget.media_type ?? "").toLowerCase();
            if (mt !== "series" && mt !== "anime") return null;
            const sId = activeTarget.series_id ?? activeTarget.id;
            const libRow = library.find((i) => i.id === sId);
            return {
              seriesId: sId,
              mediaType: activeTarget.media_type,
              addons,
              currentEpisodeId: activeTarget.id,
              nextEpisodeId: nextUpInfo?.episode?.id ?? null,
              isFullscreen,
              libraryById,
              seriesArt:
                selectedMeta?.background ?? selectedMeta?.poster ??
                libRow?.background ?? libRow?.poster ?? null,
              onPlayEpisode: onEosPlayEpisode,
            };
          })()}
        />
      )}

      {/* Next-Up CTA — sibling to PlayerOverlay. The CTA's own root
          uses `fixed` positioning + `z-[10001]` (above PlayerOverlay's
          `z-[9999]`) so its click handlers win over the overlay's
          invisible "tap to play/pause" layer. Mounts only after the
          pre-resolve flow has populated `nextUpInfo` AND the display
          gate has tripped (ED-end for anime / lead-time fallback).
          MUTUAL EXCLUSION (EOS Spotlight): suppressed entirely while
          the EOS Spotlight is up — the Spotlight is the full-screen
          end-of-stream surface and owns the next-episode decision; a
          small corner CTA underneath it would be redundant + fight for
          the click. */}
      {!eosActive && isPlayerActive && nextUpInfo && nextUpVisible && (
        <NextUpCta
          episode={nextUpInfo.episode}
          loading={false}
          noStream={nextUpInfo.stream == null}
          onPlay={onNextUpPlay}
          onDismiss={onNextUpDismiss}
        />
      )}

      {/* ── EOS Spotlight — full-screen end-of-stream surface (spec
          2026-05-19). App-level sibling like NextUpCta / the recovery
          modal. z-[10300] (in EosSpotlight) sits above PlayerOverlay
          (9999) + NextUpCta (10001) and below the stream-broken
          recovery modal (10500) so a genuine break still wins if both
          ever race. Gated purely on `eosActive` (set by the
          `aura:eos-detected` event from clean EOF / near-end stale);
          shows a loading primary while the next episode resolves, then
          NEXT-UP or END-CARD per `eosResolve`. */}
      {eosActive && isPlayerActive && (() => {
        const mt = (activeTarget?.media_type ?? "").toLowerCase();
        const isSeriesLike = mt === "series" || mt === "anime";
        const libRow = activeTarget
          ? library.find((i) => i.id === (activeTarget.series_id ?? activeTarget.id))
          : null;
        const seriesArt =
          selectedMeta?.background ?? selectedMeta?.poster ??
          libRow?.background ?? libRow?.poster ?? null;
        const resolving = eosResolve === "idle" || eosResolve === "resolving";
        const nextEp = eosResolve === "ready" ? (nextUpInfo?.episode ?? null) : null;
        return (
          <EosSpotlight
            title={activeTarget?.name ?? "this title"}
            episode={nextEp}
            stream={nextEp ? (nextUpInfo?.stream ?? null) : null}
            loading={resolving && isSeriesLike}
            isSeries={isSeriesLike}
            caughtUpUnaired={eosCaughtUpUnaired}
            seriesArt={seriesArt}
            libraryById={libraryById}
            onPlayNext={onEosPlayNext}
            onReplay={onEosReplay}
            onExit={onEosExit}
            onDismiss={onEosDismiss}
            onOpenEpisodes={() => setEosEpisodesOpen(true)}
            episodesOpen={eosEpisodesOpen}
          />
        );
      })()}

      {/* Shared EpisodePanel opened by the Spotlight's "Episodes"
          button (the in-player hover-edge trigger is wired in Phase 4
          inside PlayerOverlay). z-[10000] in-component; the Spotlight
          (10300) stays painted behind it so closing the drawer returns
          to the end screen. */}
      {isPlayerActive && activeTarget && eosEpisodesOpen && (() => {
        const libRow = library.find(
          (i) => i.id === (activeTarget.series_id ?? activeTarget.id),
        );
        const seriesArt =
          selectedMeta?.background ?? selectedMeta?.poster ??
          libRow?.background ?? libRow?.poster ?? null;
        return (
          <EpisodePanel
            open={eosEpisodesOpen}
            onClose={() => setEosEpisodesOpen(false)}
            seriesId={activeTarget.series_id ?? activeTarget.id}
            mediaType={activeTarget.media_type}
            addons={addons}
            currentEpisodeId={activeTarget.id}
            nextEpisodeId={nextUpInfo?.episode?.id ?? null}
            isFullscreen={isFullscreen}
            libraryById={libraryById}
            seriesArt={seriesArt}
            onPlayEpisode={onEosPlayEpisode}
          />
        );
      })()}

      {/* Standalone login modal — used when a guest clicks the profile avatar */}
      {showLogin && !showLanding && (
        <LoginView
          onSuccess={(sess) => { setShowLogin(false); handleLoginSuccess(sess); }}
          onGuest={() => setShowLogin(false)}
        />
      )}

      {/* Detail view — shared-element open from the clicked card.
          Strictly unmounted while a stream is active. */}
      {selectedMeta && !isPlayerActive && (
        <DetailView
          meta={selectedMeta}
          addons={addons}
          fromRect={selectedRect}
          onClose={closeDetail}
          onPlayStream={handlePlayStream}
          onSearchByName={(name) => {
            // Cast/crew name click: flip to Home and queue the name as the
            // search query. DetailView calls onClose() right after this, so
            // setDeepLinkSearch must be called first to ensure HomeView's
            // externalQuery effect picks it up on the next render.
            setActiveView("home");
            setActiveCatalog(null);
            setDeepLinkSearch(name);
          }}
          inLibrary={library.some((i) => i.id === selectedMeta.id && !i.removed)}
          onLibraryToggle={(origin) => handleLibraryToggle(selectedMeta, origin)}
          openOnEpisodeId={lastPlayedEpisodeId}
          ignoreResumeHint={ignoreResumeOnNextOpen}
          onConsumeOpenHint={consumeLastPlayedEpisode}
          openInStreamsMode={openInStreamsMode}
          onConsumeOpenInStreamsMode={consumeOpenInStreamsMode}
        />
      )}

      {/* Auto-update popup — fixed inset-0, dims everything behind. Renders
          only when `pendingUpdate` is non-null (i.e. checkForUpdate found
          a newer release and it hasn't been dismissed to the bell yet). */}
      {pendingUpdate && !isPlayerActive && (
        <UpdatePopup
          release={pendingUpdate}
          currentVersion={APP_VERSION}
          onUpdate={async () => {
            // Signed in-app download + install via tauri-plugin-updater.
            // The plugin verifies the minisign signature on latest.json
            // BEFORE writing to disk, downloads the installer, runs it
            // silently, and relaunches the app. Success branch typically
            // never reaches setPendingUpdate(null) because the relaunch
            // tears down the React tree first; the assignment is here
            // for the rare path where the plugin returns true but
            // relaunch is suppressed (debug builds, manifest-driven
            // installMode change, etc).
            const ok = await downloadAndInstallUpdatePlugin();
            if (ok) setPendingUpdate(null);
            return ok;
          }}
          onDismiss={() => {
            // Persist the dismissed tag so the popup doesn't fire again
            // for the same release. The notifications bell (owned by a
            // separate task) listens for this event and surfaces the
            // dismissed update inside its menu.
            const tagName = `v${pendingUpdate.version}`;
            const htmlUrl = `https://github.com/rm-sage/Aura/releases/tag/${tagName}`;
            try {
              localStorage.setItem(UPDATE_DISMISSED_KEY, tagName);
            } catch { /* private mode / quota / disabled storage — best effort */ }
            window.dispatchEvent(new CustomEvent("aura:update-dismissed-to-bell", {
              detail: {
                tagName,
                htmlUrl,
                body:        pendingUpdate.body ?? "",
                publishedAt: pendingUpdate.date ?? "",
              },
            }));
            setPendingUpdate(null);
          }}
        />
      )}

      {/* Singleton context menu host — listens for openContextMenu() events. */}
      <ContextMenuHost />

      {/* Singleton Kai-style mini-meta hover panel — driven by
          catalogHoverStore, fed by every CatalogCard's hover intent. */}
      <CatalogHoverHost addons={addons} onSelectMeta={openDetail} />


      {/* Global toast surface — visible on every tab, fed by showAppToast(). */}
      <AppToastHost />

      {/* Fly-up toast — spawns at the click point and floats upward.
          Fed by showFlyUpToast(); used for library add/remove feedback
          so the action visibly originates from where the user clicked. */}
      <FlyUpToastHost />

      {/* In-app source popup — renders a calendar-day-overlay-style
          modal containing a child Tauri Webview pointed at the URL.
          Dispatched from the right-click menu via openInPopupBrowser. */}
      <SourcePopupHost />

      {/* DevConsole — F12-toggled terminal-style log viewer */}
      <DevConsole />

      {/* First-run crash reporting consent dialog. Renders only when the
          persisted `crash_reporting_consent` setting is `null` (the user
          has never been asked). Self-dismisses on either choice. */}
      <CrashReportingConsent />

      {/* Resume-from-progress prompt. Set by handlePlayStream when the
          target has a non-trivial saved timeOffset; the user picks
          Resume / Start over and the modal vanishes. Auto-resumes
          after 15 s of inaction. */}
      <ResumePrompt pending={pendingResume} />
    </div>
    </NotificationsProvider>
    </LibraryProvider>
    </ThemeEngine>
  );
}

// ---------------------------------------------------------------------------
// NotificationsBridge — thin component rendered INSIDE NotificationsProvider
// so it can call useNotifications() to push entries from external events.
//
// Two responsibilities:
//   1. Listen for `aura:update-dismissed-to-bell` (fired by UpdatePopup's
//      Dismiss handler above) and add a kind:'update' notification.
//   2. Listen for `aura:open-meta` (fired by NotificationsPanel row clicks)
//      and route to the App's openDetail via the parent prop.
//   3. Mount the NotificationsScanner — it has to live inside the provider
//      so its useNotifications() hook can resolve the context.
// ---------------------------------------------------------------------------

function NotificationsBridge({
  addons, library, authKey, popupSuppressed,
  onOpenMeta,
}: {
  addons: AddonEntry[];
  library: LibraryItem[];
  /** First-12-char prefix is derived inside the alerts hook; pass the
   *  raw auth_key (or null when signed out / guest). */
  authKey: string | null;
  /** True while playback is active or DetailView is open. Forwarded
   *  to NotificationsContext so the popup bubble is held until the
   *  user navigates back to a bell-visible surface. */
  popupSuppressed: boolean;
  onOpenMeta: (metaId: string, mediaType?: string) => void;
}) {
  const { addNotification, setPopupSuppressed, notifications, dismissNotification } = useNotifications();

  // Stale-update-notification cleanup. A `kind: "update"` entry with
  // `data.tagName === "v0.6.11"` is dead weight once the user is
  // already running 0.6.11+ — it would suggest "click to install a
  // version you already have." Sync replicates these entries across
  // devices, so a manual install on one device (which never went
  // through the dismiss-to-bell handler) leaves an orphan on the
  // others until something prunes. Runs on mount and on the
  // notifications array change so a freshly-pulled stale entry from
  // the cloud also gets cleared.
  useEffect(() => {
    for (const n of notifications) {
      if (n.kind !== "update") continue;
      const tag = (n.data?.tagName as string | undefined) ?? "";
      if (!tag) continue;
      // isNewer normalises the leading "v" + strips pre-release
      // suffixes, so vX.Y.Z and X.Y.Z compare cleanly.
      if (!isNewer(tag, APP_VERSION)) {
        dismissNotification(n.id);
      }
    }
  }, [notifications, dismissNotification]);
  // Mirror the prop into the context whenever it flips. Doing this
  // here (inside the provider tree) is the only way App.tsx can
  // reach setPopupSuppressed without lifting the provider above
  // App's hook chain.
  useEffect(() => {
    setPopupSuppressed(popupSuppressed);
  }, [popupSuppressed, setPopupSuppressed]);
  // Scrobble-auth bell alerts: surfaces expired Trakt / AniList tokens
  // in the bell so the user notices without opening Settings. Mounted
  // here (inside NotificationsProvider) so its useNotifications() call
  // resolves the context. The earlier App-body placement crashed at
  // first render — the provider hadn't been entered yet.
  useScrobbleAuthAlerts(authKey);

  // aura:update-dismissed-to-bell — owned by another agent's auto-updater.
  // Detail shape is documented in NotificationsContext: { tagName, htmlUrl,
  // body, publishedAt }.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        tagName?: string;
        htmlUrl?: string;
        body?: string;
        publishedAt?: string;
      } | undefined;
      if (!detail || typeof detail.tagName !== "string") return;
      addNotification({
        // ID keyed on tagName so the same release can't get added twice if
        // the user dismisses the popup, the bell, then encounters the same
        // tag again on a re-poll.
        id: `update:${detail.tagName}`,
        kind: "update",
        title: `Aura update available: ${detail.tagName}`,
        subtitle: "Click to download from GitHub",
        data: {
          tagName:     detail.tagName,
          htmlUrl:     detail.htmlUrl ?? "",
          body:        detail.body ?? "",
          publishedAt: detail.publishedAt ?? "",
        },
      });
    };
    window.addEventListener("aura:update-dismissed-to-bell", handler);
    return () => window.removeEventListener("aura:update-dismissed-to-bell", handler);
  }, [addNotification]);

  // aura:notify-scrobble-onboarding — fired by OnboardingView.handleFinish
  // ONLY on the FIRST completion (markOnboardingComplete returns true).
  // Replaces the in-wizard "Track what you watch" section that was
  // routinely skipped past; surfacing scrobble support as a one-time
  // bell-badge entry after the user lands on the home view gets
  // discovered more reliably. Stable id makes a re-fire on rapid
  // remount idempotent.
  useEffect(() => {
    const onPing = () => {
      addNotification({
        id: "notice:scrobble-onboarding",
        kind: "notice",
        title: "Track your watch history",
        subtitle: "Connect Trakt and AniList to sync watch progress automatically. Click to open the scrobble settings.",
        data: { settingsSection: "sec-scrobble" },
      });
    };
    window.addEventListener("aura:notify-scrobble-onboarding", onPing);
    return () => window.removeEventListener("aura:notify-scrobble-onboarding", onPing);
  }, [addNotification]);

  // aura:script-fallback — fired by the Rust player::init_mpv when its
  // first init attempt fails and the retry-without-script succeeds. We
  // surface this as a one-time amber warning in the bell PLUS a top-
  // center toast so the user knows immediately. The notification is
  // dismissable like every non-update kind.
  useEffect(() => {
    const tauriListen = listen<{ feature?: string; reason?: string }>(
      "aura:script-fallback",
      ({ payload }) => {
        const feature = payload?.feature ?? "Optional script";
        const reason  = payload?.reason  ?? "unknown error";
        const subtitle =
          `${feature} couldn't be loaded into MPV. Aura started without it. ` +
          `OP/ED auto-skip will be inactive for this session. ` +
          `Restart Aura to retry. (Detail: ${reason})`;
        addNotification({
          // Stable id so a re-fire in the same session doesn't double-up.
          id: `warning:script-fallback`,
          kind: "warning",
          title: `${feature} unavailable`,
          subtitle,
        });
        showAppToast(`${feature} unavailable; see notifications bell for details`, {
          tone: "danger",
          duration: 6000,
        });
      },
    );
    return () => { tauriListen.then((unlisten) => unlisten()).catch(() => {}); };
  }, [addNotification]);

  // aura:open-meta — fired by NotificationsPanel row clicks. The detail
  // payload is `{ metaId, videoId?, mediaType? }`. We delegate to the
  // App-level openDetail via the prop callback — videoId would be the
  // resume hint for series, but DetailView already resolves resume from
  // libraryState.video_id so we don't need to thread it explicitly.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        metaId?: string;
        mediaType?: string;
      } | undefined;
      if (!detail?.metaId) return;
      onOpenMeta(detail.metaId, detail.mediaType);
    };
    window.addEventListener("aura:open-meta", handler);
    return () => window.removeEventListener("aura:open-meta", handler);
  }, [onOpenMeta]);

  return (
    <NotificationsScanner
      addons={addons}
      library={library}
    />
  );
}
