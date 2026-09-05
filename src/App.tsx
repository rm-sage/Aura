// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import NavSidebar, { type NavView } from "./NavSidebar";
import { loadSessionRoute, saveSessionRoute } from "./sessionRoute";
import BootSplash from "./BootSplash";
import ResizeHandles from "./ResizeHandles";
import HomeView from "./views/HomeView";
import DiscoverView from "./views/DiscoverView";
import LiveView from "./views/LiveView";
import type { IptvChannel, IptvPlaylist } from "./iptv/types";
import LibraryView from "./views/LibraryView";
import AddonsView from "./views/AddonsView";
import CalendarView from "./views/CalendarView";
import HistoryView from "./views/HistoryView";
import QueueView from "./views/QueueView";
import AiringView from "./views/AiringView";
import SettingsView from "./views/SettingsView";
import DetailView from "./views/DetailView";
import ThemeEngine from "./ThemeEngine";
import TitleBar from "./TitleBar";
import LandingView from "./LandingView";
import LoginView from "./LoginView";
import OnboardingView from "./views/OnboardingView";
import { isOnboardingComplete } from "./onboarding";
import PlayerOverlay, { VOLUME_MAX } from "./PlayerOverlay";
import AmbientAura from "./AmbientAura";
import ContextMenuHost, { openContextMenu } from "./ContextMenu";
import { CatalogHoverHost } from "./CatalogHoverCard";
import AppToastHost, { showAppToast } from "./AppToast";
import ScrobbleRunBar from "./ScrobbleRunBar";
import ScrobbleClosePrompt from "./ScrobbleClosePrompt";
import { safeSetItem } from "./storageQuota";
import FlyUpToastHost, { showFlyUpToast } from "./FlyUpToast";
import { runtimeDepPresent, ensureRuntimeDep } from "./runtimeDeps";
import PartyToastHost from "./PartyToast";
import SourcePopupHost from "./SourcePopup";
import DevConsole from "./DevConsole";
import UpdatePopup from "./UpdatePopup";
import CrashReportingConsent from "./CrashReportingConsent";
import ResumePrompt, { type PendingResume } from "./ResumePrompt";
import { isNewer } from "./updater";
import { checkForUpdatePlugin, downloadAndInstallUpdatePlugin, type UpdateInfo } from "./updaterPlugin";
import { advanceWatchedAfter } from "./autoAdvance";
import { clearAutoBumped, clearAutoBumpedForVideo } from "./autoBumped";
import { mirrorWatchedFromCloud, pushItemWatched } from "./watchedSync";
import { onWatchedSync } from "./manualWatched";
import { useScrobble, type ActiveScrobbleTarget } from "./useScrobble";
import { useScrobbleAuthAlerts } from "./useScrobbleAuthAlerts";
import { useKeybindings } from "./useKeybindings";
import { libraryToggle, libraryRemoveAll, libraryWriteProgress, libraryClearProgress } from "./libraryActions";
import { libraryItemSeriesId } from "./libraryNormalize";
import { isWindowHidden, isWindowFocused, useWindowHidden, subscribeWindowVisibility } from "./windowVisibility";
import { sourcesForMeta, openSourceLink } from "./externalSources";
import { setManualWatchedScope, getManualWatchedState, setManualWatchedState, setManualWatchedMany, getPlannedQueue } from "./manualWatched";
import { reconcileLibraryReleaseSignals, clearReleaseSignalStore, getReleaseSignal } from "./releaseSignalStore";
import { syncPullAll, installSyncTriggers, startBackgroundPull, clearSyncEtags, setSyncActiveScope } from "./sync";
import { setHistoryScope, addHistoryEntry } from "./historyStore";
import { setAutoBackupScope, startAutoBackup } from "./userDataBackup";
import NextUpCta from "./NextUpCta";
import EosSpotlight from "./EosSpotlight";
import EpisodePanel from "./EpisodePanel";
import SourceSwitcher, { streamKey, sameStreamSource } from "./SourceSwitcher";
import PlaybackEngineGate from "./PlaybackEngineGate";
import CastMenu from "./CastMenu";
import CastSessionBar from "./CastSessionBar";
import { useCastSession } from "./useCastSession";
import WatchTogetherPanel from "./WatchTogetherPanel";
import PartyButton from "./PartyButton";
import PlayerPartyHud from "./PlayerPartyHud";
import PartyVotesOverlay from "./PartyVotesOverlay";
import {
  setPlaybackBridge, notifyLocalControl, notifyLocalVideo, resyncToRoom,
  startPartyStream, setLocalStaging, getWatchState, getPartyStartPosition,
  notifyLocalBuffer, startVote, leaveRoom,
} from "./watchTogether/store";
import { useWatchTogether } from "./watchTogether/useWatchTogether";
import { streamLabel, streamMatchKey } from "./watchTogether/streamMatch";
import { parseStream } from "./streamMeta";
import { resolveNextEpisode, pickFirstStreamForEpisode, findNextEpisode, findPreviousEpisode, resolveCanonSkipTarget, autoSkipApplies, formatEpisodeTag } from "./nextUp";
import { arcPositionOf, fetchStoryArcs, loadArcMode } from "./storyArcs";
import { getMetaDetailFallback, getRichestMetaDetail, peekCachedDetailById, peekRichestCachedDetailById, peekFreshestPostersByIds } from "./metaCache";
import { PersistentCache } from "./persistentCache";
import { applyReducedMotionAttribute, loadAuraSettings, streamQueryAddons } from "./auraSettings";

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
import { useLibraryArtRetry } from "./libraryArtRetry";
import { LibraryProvider } from "./LibraryContext";
import { NotificationsProvider, useNotifications } from "./NotificationsContext";
import NotificationsBell from "./NotificationsBell";
import AccountButton from "./AccountButton";
import NotificationsScanner, { clearScannerState } from "./NotificationsScanner";
import { getTitleState, titleStateKey } from "./titleState";
import { isAnimeMeta, markAnimeId } from "./aiometadata";
import { setSkipMarksScope } from "./skipMarks";
import { markEpisodesSkipped } from "./skipActions";
import { connectedServices, useScrobbleConnections } from "./scrobbleConn";
import type { AnimeTheme, AnimeThemes } from "./animeExtras";
import type {
  AddonEntry,
  ExternalSubtitle,
  LibraryItem,
  MetaPreview,
  StreamEntry,
  StreamFetchResult,
  VideoEntry,
} from "./types";
import { isVideoAired } from "./types";
import { nextAiringEpisode } from "./releaseCountdown";
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
// `existing` is the AniSkip / publicmetadb window list for this load. It
// is NOT yet stamped to MPV: this function owns the single stamp for the
// load and publishes on every exit that still holds the load token.
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
  /** The song playing in this window, stamped below from the MAL theme
   *  list. Absent whenever the join was not certain: see stampThemeSongs.
   *  Mirrors Rust's PreparedWindow; PlayerOverlay and AniSkipMenu carry
   *  their own copies of this shape and must change with it. */
  song_title?:  string | null;
  song_artist?: string | null;
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
// Sanity caps so a mis-titled / coarse chapter can't nuke real content.
// A real opening is ~90 s (OP_MAX_SECONDS is 130); a titled "Opening"
// chapter much longer than that is a coarse marker that runs until the
// NEXT marker (e.g. The Punisher S01E13 shipped an "Opening" chapter
// spanning 4:53-9:37 = ~284 s, which skipped whole scenes). Reject those
// here so silencedetect's precise window wins instead. ED can legitimately
// run long (a full credits roll), so it keeps a generous cap.
const TITLED_OP_MAX_SECONDS = 150;
const ED_MAX_SECONDS        = 900;
const MIN_WINDOW_SECONDS    = 2;
// Plausible length band for an OP window, used ONLY to rank competing OP
// candidates against each other in dedupeSkipWindows (never to drop one).
// Below the floor is a title card / eyecatch: Vodes' Hell's Paradise S02
// files ship a 15 s "Intro" chapter at 0:00 alongside the real "Opening"
// chapter, and the earliest-start tie-break handed the OP slot to the
// title card. Above the ceiling is a coarse marker that swallowed the cold
// open: AniSkip's crowd-sourced window for that same episode is 0-158 s
// against a real OP of 0:59-2:38.
const OP_PLAUSIBLE_MIN_SECONDS = 20;
const OP_PLAUSIBLE_MAX_SECONDS = TITLED_OP_MAX_SECONDS;
// Plausible band for an ENDING, measured BACK from the end of the file. A TV
// ending theme runs ~90 s and a next-episode preview adds ~30 s, so the credits
// begin somewhere in the last few minutes; anything claiming to start earlier
// than that is a mid-episode act break, not the ending. This is what decides
// which ED window times the Next-Up card, and it is the sanity gate on an
// INFERRED ed start - the Hell's Paradise S02E11 report (card a minute or two
// early, nothing drawn on the scrubber) was an ffmpeg tail-scan boundary from
// the middle of the final act, and the only check it had to pass was
// `start >= duration * 0.5`.
// Observed real endings, for calibration: Hell's Paradise S02 starts its ED
// 89 s before the end of a 1465 s episode, Frieren 100 s before the end of a
// 1470 s one, and live-action credits are usually shorter still. 240 s is
// generous against all of them, and it is also the tail the ffmpeg outro scan
// is given, so the two cannot drift apart.
const ED_TAIL_MIN_SECONDS = 20;
const ED_TAIL_MAX_SECONDS = 240;

/** Playback position that means "the ending has started" - the EARLIEST ED
 *  window start inside the plausible outro band, or null when no ED window
 *  qualifies. Drives the Next-Up CTA, and doubles as the acceptance test for an
 *  inferred ED before it is stamped.
 *
 *  Earliest, not latest: a release that ships both an "Ending" and a "Preview"
 *  chapter produces two ED windows (classifyChapterTitle maps preview /
 *  next episode / next time / coming up to "ed"), and taking the last one timed
 *  the card off the preview - by which point the fixed lead time had usually
 *  fired anyway, so the precise trigger silently did nothing. The band is what
 *  makes earliest safe: a bogus early ED cannot qualify in the first place.
 *
 *  With no container duration there is no band to test against, so it falls
 *  back to the old last-ED behaviour rather than dropping the feature. */
function edTriggerStart(windows: PreparedWindow[], duration: number): number | null {
  const eds = windows.filter((w) => w.type === "ed");
  if (eds.length === 0) return null;
  if (!(duration > 0)) {
    return eds.reduce<number | null>((acc, w) => (acc == null || w.start > acc ? w.start : acc), null);
  }
  const inBand = eds
    .map((w) => w.start)
    .filter((s) => duration - s >= ED_TAIL_MIN_SECONDS && duration - s <= ED_TAIL_MAX_SECONDS);
  return inBand.length > 0 ? Math.min(...inBand) : null;
}

/** Fraction of [aStart,aEnd) that overlaps [bStart,bEnd). */
function windowOverlapFraction(
  aStart: number, aEnd: number, bStart: number, bEnd: number,
): number {
  const inter = Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
  return inter / Math.max(0.001, aEnd - aStart);
}

/** Collapse overlapping skip windows of the SAME kind across sources so a
 *  region never gets two segments (e.g. an AniSkip OP + a chapter OP that
 *  only partially overlap — the per-source guards in mergeChapterSkipWindows
 *  let those slip through, which surfaced as the reported "chapter + no-source
 *  overlap"). The higher-trust source wins the region; the loser is dropped
 *  WHOLE, never merged into a union (a coarse chapter must not extend a precise
 *  AniSkip window). `mixed-op` shares the OP group.
 *
 *  The single OP slot is elected on plausible-length FIRST and source trust
 *  second - see `opLengthScore` below for why. */
function dedupeSkipWindows(windows: PreparedWindow[]): PreparedWindow[] {
  const group = (t: string) => (t === "mixed-op" ? "op" : t);
  // Trust order. A release group's EXPLICIT titled chapter ("Opening") beats
  // AniSkip: the chapter is a direct, encoder-set boundary (and the ≤150 s cap
  // in mergeChapterSkipWindows already drops coarse markers), whereas AniSkip's
  // crowd-sourced timings can be wrong for a given episode — observed on
  // Dr. STONE S04E18, where the file's chapter OP was right and AniSkip's was
  // off. Aura's own guesses (positional heuristic / silencedetect) rank lowest.
  // "aniskip-neighbour" is a window borrowed from the SAME series' other
  // episodes (see fetch_neighbour_skip_profile) - real crowd data, but not for
  // this episode, so it ranks under every source that describes this file and
  // over Aura's own signal-processing guesses.
  const PRIO: Record<string, number> = {
    chapter: 6, aniskip: 5, publicmetadb: 4, "aniskip-neighbour": 3,
    "chapter-heuristic": 2, silencedetect: 1,
  };
  const prio = (src: string) => PRIO[src] ?? 0;
  // An OP whose LENGTH is plausible outranks one whose length is not, ABOVE
  // source priority. Source trust only tells us who is usually right; a 15 s
  // or a 158 s "opening" is self-evidently not one, whoever supplied it. This
  // is a ranking key, never a filter: when no candidate is plausible the old
  // (priority, start) order still elects one, so `hasOp` downstream and the
  // shape of the payload are unchanged. 0 for every non-OP window, so the
  // relative order of the ed / recap groups is untouched.
  const opPlausible = (w: PreparedWindow): number => {
    if (group(w.type) !== "op") return 0;
    const len = w.end - w.start;
    return len >= OP_PLAUSIBLE_MIN_SECONDS && len <= OP_PLAUSIBLE_MAX_SECONDS ? 1 : 0;
  };
  // Closeness to the industry-standard length, bucketed to 20 s so near-ties
  // (85 vs 90) are not decided by a couple of seconds. Ranks BELOW source
  // priority, so it only ever separates candidates the trust order cannot: two
  // chapters from the same release, where a 25 s title card and a 90 s opening
  // are equally "plausible" on a yes/no test and the earliest-start tie-break
  // would hand the OP slot to the title card. Above source priority it would
  // invert the documented trust order and let a crowd-sourced AniSkip window
  // beat a release group's own "Opening" chapter, which is the Dr. STONE case
  // that order exists for.
  const opCloseness = (w: PreparedWindow): number => {
    if (group(w.type) !== "op") return 0;
    return -Math.round(Math.abs((w.end - w.start) - TARGET_OP_SECONDS) / 20);
  };
  // Plausible OP first, then highest-priority source (it survives a conflict),
  // then closest to a real opening's length, stable by start.
  const ordered = [...windows].sort(
    (a, b) => opPlausible(b) - opPlausible(a)
           || prio(b.source) - prio(a.source)
           || opCloseness(b) - opCloseness(a)
           || a.start - b.start,
  );
  const kept: PreparedWindow[] = [];
  let opTaken = false;
  for (const w of ordered) {
    const g = group(w.type);
    // An episode has exactly ONE opening. When two sources disagree on WHERE
    // it is (e.g. AniSkip 2:34-4:04 vs a chapter "Opening" 0:55-2:24 on
    // Dr. STONE — NON-overlapping, so the overlap test below can't catch
    // them), keep only the single best-ranked OP and drop the rest.
    // ED / recap are NOT collapsed this way: a real ED plus a next-episode
    // "preview" are both legitimately skippable, so those get only the
    // same-region overlap dedup below.
    if (g === "op") {
      if (opTaken) continue;
      opTaken = true;
      kept.push(w);
      continue;
    }
    const wLen = Math.max(0.001, w.end - w.start);
    const clashes = kept.some((k) => {
      if (group(k.type) !== g) return false;
      const inter = Math.max(0, Math.min(k.end, w.end) - Math.max(k.start, w.start));
      const kLen = Math.max(0.001, k.end - k.start);
      // Overlap past ~a quarter of the SHORTER window = the same region.
      return inter / Math.min(wLen, kLen) > 0.25;
    });
    if (!clashes) kept.push(w);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Sources whose windows are INFERRED rather than authored. They are stamped
 *  `auto: false` at construction on purpose (a wrong guess must never yank the
 *  playhead) and the per-kind mode does not override that: "auto" means "trust
 *  a real OP/ED marker", not "trust anything Aura guessed". */
const GUESS_SKIP_SOURCES = new Set([
  "chapter-heuristic", "silencedetect", "aniskip-neighbour",
]);

/**
 * Name the song playing in each OP/ED window, from the MAL theme list.
 *
 * THE JOIN. MAL theme episode ranges are expressed in MAL-LOCAL, per-cour
 * numbering, and so is the episode number this chain already computes for
 * AniSkip (see the `episodeNum` note further down: cour 1's MAL id with an
 * absolute episode 404s, cour 2's with a local one is correct). So the pair
 * needed here is the pair AniSkip already had to get right, and this is NOT
 * the numbering-mismatch problem `arc_align.rs` exists to solve.
 *
 * WHAT MAKES IT SAFE is the refusal to guess. A song is attached only when
 * exactly ONE theme of that kind covers the episode. Three cases deliberately
 * yield nothing, and each falls back to the existing generic label:
 *
 *   - the theme carried no parseable episode range, so `covers` is false for
 *     every episode (an empty span list means UNKNOWN, never "all"),
 *   - no theme covers this episode (common: MAL lists songs for a cour the
 *     addon numbers differently, or the range data is simply incomplete),
 *   - more than one covers it (One Piece reuses OP1 for episode 1000, so an
 *     episode can genuinely sit inside two ranges).
 *
 * Naming the wrong song is worse than naming none, which is the same rule
 * `streamMeta.ts` follows for stream chips.
 */
function stampThemeSongs(
  windows: PreparedWindow[],
  themes: AnimeThemes | null,
  episodeNum: number | null,
): PreparedWindow[] {
  if (!themes || episodeNum === null || !Number.isFinite(episodeNum)) return windows;

  const pick = (list: AnimeTheme[]): AnimeTheme | null => {
    const hits = list.filter((t) =>
      t.episodes.some((s) => episodeNum >= s.start && episodeNum <= s.end));
    return hits.length === 1 ? hits[0] : null;
  };
  const opening = pick(themes.openings);
  const ending  = pick(themes.endings);

  return windows.map((w) => {
    // `mixed-op` is an opening with content mixed in; it is still the OP song.
    const t = w.type === "op" || w.type === "mixed-op" ? opening
            : w.type === "ed" ? ending
            : null;
    if (!t || (!t.title && !t.artist)) return w;
    return { ...w, song_title: t.title, song_artist: t.artist };
  });
}

/** Re-apply the user's CURRENT per-kind modes to a window list on its way
 *  out to `set_skip_windows`: drop kinds now switched off, recompute `auto`.
 *  Windows are built with the modes that were live when they were derived,
 *  which can be seconds earlier. Unknown kinds resolve to "off" and are
 *  dropped, but nothing upstream produces one (classifyChapterTitle and the
 *  AniSkip map both filter to op / mixed-op / ed / recap first). */
function applySkipModes(
  windows: PreparedWindow[],
  modeFor: (kind: string) => "off" | "prompt" | "auto",
): PreparedWindow[] {
  return windows
    .filter((w) => modeFor(w.type) !== "off")
    .map((w) => {
      const auto = GUESS_SKIP_SOURCES.has(w.source)
        ? false
        : modeFor(w.type) === "auto";
      return auto === w.auto ? w : { ...w, auto };
    });
}

async function mergeChapterSkipWindows(
  existing: PreparedWindow[],
  modeFor: (kind: string) => "off" | "prompt" | "auto",
  /** Per-load token check from handlePlayStream. The poll below runs up to
   *  ~6 s, which is long enough for the file to have been replaced. Without
   *  it the chapters read belong to the NEW file, get merged with the OLD
   *  file's windows, and the result is stamped over the new file's own. */
  isStale?: () => boolean,
  /** Last-mile decoration applied INSIDE `publish`, so it rides the one stamp
   *  rather than needing a second write. Used to name the OP/ED song. It runs
   *  after `applySkipModes` because a window dropped by a mode change must not
   *  be looked up at all. */
  decorate?: (windows: PreparedWindow[]) => Promise<PreparedWindow[]>,
): Promise<PreparedWindow[]> {
  // The ONE stamp per load (see the comment in finishWithChapters). Every
  // exit below that still owns the load token has to go through here: the
  // "no chapters" and "no derived windows" paths used to return without
  // stamping, which with a single-stamp chain would leave a file with no
  // chapters holding no windows at all.
  const publish = async (
    raw: PreparedWindow[],
    note: string,
  ): Promise<PreparedWindow[]> => {
    if (isStale?.()) return raw;
    // Modes are re-applied HERE, not at derivation time, so a mode change
    // made while the chapter poll was running lands in the payload instead
    // of being reverted by it.
    const windows = decorate
      ? await decorate(applySkipModes(raw, modeFor))
      : applySkipModes(raw, modeFor);
    if (isStale?.()) return raw;
    try {
      await invoke("set_skip_windows", { payload: { windows } });
      const detail = windows.length === 0
        ? "no windows"
        : windows
            .map((w) => `${w.type} ${Math.round(w.start)}-${Math.round(w.end)}s `
                      + `${w.source}${w.auto ? " auto" : " prompt"}`)
            .join(", ");
      console.info(`[auraskip] ${note}: ${detail}`);
    } catch (err) {
      console.warn(`[auraskip] stamp failed (${note}): ${String(err)}`);
    }
    return windows;
  };

  // Wait for chapter-list to land. Demuxer parse can be slightly behind
  // duration; bail early once we see chapters, or after CONFIRM_EMPTY_READS
  // consecutive well-formed EMPTY lists once duration is known, or after ~6 s
  // of attempts. The empty-list exit matters because this poll now gates the
  // ONLY stamp of the load: a file with no chapters used to burn all ten
  // ticks, and that idle time is auto-skip latency now, not free time. An
  // empty read is only trusted once `duration > 0` (mpv has parsed headers,
  // which is when chapters appear too) and only after a confirmation tick, so
  // a container whose Chapters element trails duration slightly is still
  // caught.
  //
  // CRITICAL: only read with `string` format. The earlier `node`-format
  // attempt crashes the wrapper at `mpv_wrapper_get_property+0xa71` —
  // same dispatch-table fault as the original `track-list/node` crash
  // documented in lib.rs:591 (CLAUDE.md landmine #3 family). The
  // try/catch here can't recover because the fault is a STATUS_ACCESS_
  // VIOLATION inside the FFI call, not a JS exception. The string
  // format goes through a different code path that's safe to call
  // even while libmpv is still processing loadfile.
  const CONFIRM_EMPTY_READS = 3;
  const POLL_TICKS = 10;
  let chapters: MpvChapter[] | null = null;
  let duration = 0;
  let emptyReads = 0;
  for (let i = 0; i < POLL_TICKS; i += 1) {
    await new Promise((r) => setTimeout(r, 600));
    if (isStale?.()) return existing;
    try {
      duration = (await invoke<number | null>("get_property", { name: "duration", format: "double" })) ?? 0;
    } catch {}
    try {
      const raw = await invoke<string | null>("get_property", { name: "chapter-list", format: "string" });
      if (typeof raw === "string" && raw.trim().length > 0) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          chapters = parsed as MpvChapter[];
          // Chapters WITHOUT a duration are worse than waiting one more tick:
          // the span derivation below ends the last chapter at `duration || start`,
          // so a duration of 0 collapses the final span (usually the Ending) to
          // zero length and it is filtered out - the ED disappears and both
          // positional heuristics, which are gated on `duration > 0`, sit out
          // entirely. Keep polling for the duration, but accept chapters
          // regardless on the last tick so a duration-less container is no
          // worse off than before.
          if (chapters.length > 0 && (duration > 0 || i === POLL_TICKS - 1)) break;
          // Counted ONLY here, so a thrown invoke, a null / blank string or a
          // parse failure never passes for "this file has no chapters". Reset
          // on anything that is not a clean empty read so the three have to be
          // CONSECUTIVE, which is what the early exit assumes.
          if (chapters.length === 0 && duration > 0) {
            if ((emptyReads += 1) >= CONFIRM_EMPTY_READS) break;
          } else {
            emptyReads = 0;
          }
        } else {
          emptyReads = 0;
        }
      } else {
        emptyReads = 0;
      }
    } catch {
      emptyReads = 0;
    }
  }
  if (!chapters || chapters.length === 0) return publish(existing, "no chapters in file");

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
    // Always add the titled chapter — cross-source overlap (incl. vs AniSkip)
    // is resolved centrally by dedupeSkipWindows, which now PREFERS the
    // encoder-set chapter. The old "drop the chapter when AniSkip covers this
    // region" guard here contradicted that (it kept the less-reliable AniSkip
    // window), so it's gone.
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

  if (derived.length === 0) return publish(existing, "chapters yielded no windows");

  const merged = dedupeSkipWindows([...existing, ...derived]);
  return publish(
    merged,
    `merged ${derived.length} chapter window(s) → total ${merged.length}`,
  );
}

// ---------------------------------------------------------------------------
// publicmetadb skip windows — crowd-sourced OP/ED timestamps from the
// publicmetadb skip database (TMDB-keyed). Aura's PRIMARY skip source
// for live-action series; a best-effort fallback for anime. Maps the
// Rust `PublicmetadbSkips` payload into `PreparedWindow`s, dropping any
// kind the user has switched off. Network / parse failure → empty list
// (the caller falls through to chapters / silencedetect).
// ---------------------------------------------------------------------------
async function fetchPublicmetadbWindows(
  tmdbId:    number,
  mediaType: "tv" | "movie",
  season:    number,
  episode:   number,
  modeFor:   (kind: string) => "off" | "prompt" | "auto",
): Promise<PreparedWindow[]> {
  try {
    const res = await invoke<{
      found:   boolean;
      windows: { kind: string; start: number; end: number; source: string }[];
    }>("fetch_publicmetadb_skips", {
      tmdbId,
      mediaType,
      season,
      episode,
    });
    if (!res.found || res.windows.length === 0) return [];
    return res.windows
      .filter((w) => modeFor(w.kind) !== "off")
      .map((w) => ({
        type:   w.kind,
        start:  w.start,
        end:    w.end,
        source: w.source, // "publicmetadb"
        auto:   modeFor(w.kind) === "auto",
      }));
  } catch (e) {
    console.warn(`[publicmetadb] lookup failed: ${String(e)}`);
    return [];
  }
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
  /** Buffering % (cache-buffering-state) — only present while stalled. */
  cache_pct?: number;
  /** Demuxer readahead buffered ahead of the playhead, seconds. */
  cache_seconds?: number;
  /** The demuxer's reader thread has hit end-of-stream. NOT a fault on its
   *  own (it is also how a healthy file ends) - only meaningful against
   *  `cache_end` vs `duration`. See `streamTruncatedRef`. */
  demux_eof?: boolean;
  /** Absolute timestamp of the last cached packet (mpv `demuxer-cache-time`,
   *  the same value as `demuxer-cache-state/cache-end`). */
  cache_end?: number;
  /** Seek lifecycle (SEEK → PLAYBACK_RESTART) — drives the loading overlay on seeks. */
  seeking?: boolean;
}

// ── Truncated-stream detection ──────────────────────────────────────────
// An origin that drops the response body mid-transfer is reported by mpv as
// a clean EOF: `stream.c` collapses every I/O error into `s->eof = 1`, and
// the demuxer then latches the cached range `eof=1`. After that latch
// `find_cache_seek_range()` accepts any pts, every seek resolves in-cache,
// and mpv NEVER issues another HTTP request for that load - so the stream is
// unrecoverable even once the origin comes back, and a forward seek past the
// cached data makes `keep-open=yes` run `seek_to_last_frame()`, teleporting
// `time-pos` to `duration` and looking exactly like a finished episode.
//
// The discriminator is demuxer EOF while the cached range ends far short of
// the container duration. A real EOF has `cache_end ~= duration`.
//
// The floor absorbs container-duration slop (an MKV header duration can be a
// second or two off the last packet); the ratio scales it for long files. In
// the incident that motivated this the shortfall was 1210 s of a 1419 s file,
// so neither value is delicate.
const EOF_SHORTFALL_MIN_S = 20;
const EOF_SHORTFALL_RATIO = 0.02;
// Consecutive qualifying samples before the condition latches. The engine
// polls at CACHE_POLL_INTERVAL (500 ms), so this debounces a single odd read
// without adding meaningful latency to recovery.
const TRUNCATED_CONFIRM_SAMPLES = 2;
// How close the playhead must get to the END of the cached data before a
// truncated stream actually triggers a reload.
//
// Detection and recovery are deliberately DECOUPLED. The demuxer EOFs the
// instant the origin drops, but mpv keeps playing out of a cache holding up
// to `cache-secs=180`. Reloading immediately would therefore interrupt up to
// three minutes of perfectly good playback to fix a problem the viewer cannot
// see yet. So the verdict latches at once (it has to: it is what stops the
// false end card and the poisoned progress writes) while the reload waits
// until the runway is nearly gone. The lead time is what lets the reload
// re-open and re-buffer while the last seconds drain, instead of stalling
// first and reloading after.
const TRUNCATED_RECOVERY_LEAD_S = 12;

// Tail window (seconds before metadata duration) considered "near end"
// for EOS detection. Shared between the in-listener paused-transition
// fast-path and the 1 Hz stale-heartbeat near-end short-circuit below.
// 5 s is generous enough that a last reported `time-pos` a frame or two
// behind duration still trips, but tight enough that an intentional
// user pause earlier in the file cannot satisfy it.
const EOS_TAIL_SECONDS = 5;

// Minimum forward jump in demuxer readahead (s) that counts as real buffer
// progress — filters jitter so only a genuine fill resets the stall timers.
const BUFFER_PROGRESS_MIN_S = 2;
// How long the buffer may make NO progress before a stalled load / mid-play
// cache wait is treated as wedged (and the recovery modal allowed). While the
// buffer keeps filling within this window, the modal is suppressed so a slow-
// but-alive source can finish buffering.
const BUFFER_STALL_MS = 25000;
// Minimum buffering-% rate (cache-buffering-state, %/second) that still counts
// as a healthily filling buffer. `cache_seconds` (readahead) fills the resume
// threshold in sub-BUFFER_PROGRESS_MIN_S steps on high-bitrate sources, so the
// cache-buffering PERCENTAGE — what the loading overlay shows — is the reliable
// "still alive" signal. While the % climbs at least this fast the recovery modal
// stays suppressed; only a % that's stopped or crawling slower than this (for
// BUFFER_STALL_MS) is treated as wedged.
const BUFFER_PCT_MIN_RATE = 2;
// How long a `paused` transition may lag an explicit toggle_pause and still be
// attributed to the user rather than to mpv's keep-open auto-pause at EOF. The
// round trip is a Tauri invoke plus one observed-property event, so it lands in
// tens of milliseconds; this is generous on purpose, because the cost of being
// wrong the other way is the end card ambushing someone who pressed space.
const USER_PAUSE_GRACE_MS = 800;

// Grace after an `end-file reason=error` before the recovery modal is allowed.
// mpv's own reconnect gives up on a transient range-request failure and fires
// this while the NEXT episode is still opening; the old code flipped the modal
// instantly (0 s), surfacing it "too soon" on streams that then played fine.
// 20 s is long enough for mpv to re-open / the source to recover; if playback
// comes alive in that window (a time-pos update lands after the error) or a new
// load supersedes it, the modal never shows. Only a genuinely dead stream (no
// life for the full grace) surfaces recovery, ~20 s later instead of instantly.
const STREAM_ERROR_GRACE_MS = 20000;
// The same grace for a load that has produced NO frame yet. Short, because the
// long window buys nothing here: with no first frame there is no playback to
// "come alive", mpv has already ended the file, and nothing re-issues a
// loadfile on its own. What the long grace actually absorbs is an error stamped
// around a LOAD TRANSITION, which clears the moment the new load's first
// time-pos lands - and that case has a first frame by definition. Keeping the
// full 20 s here just meant staring at a dead loader before anything happened.
// Sized so the auto-retries below still fit inside the old time-to-modal.
const STREAM_ERROR_COLD_GRACE_MS = 6000;

// Per-tick forward-progress cap (s) for the History watched accumulator.
// A `time` delta larger than this is a seek, not playback — discarded so
// skipping to the end never inflates summed watched time. Matches
// useScrobble's TICK_DELTA_CAP_S.
const HISTORY_TICK_DELTA_CAP_S = 5;

/** Requested Watch-Trailer quality. "auto" = best available. */
export type TrailerQuality = "auto" | "720" | "1080" | "1440" | "2160";

/** Shape returned by the Rust `resolve_trailer_url` command. `audio_url` is
 *  set only for DASH (1080p+); `quality_label` reflects the ACTUAL resolved
 *  height (may be lower than requested when the title has no higher rendition). */
interface TrailerResolution {
  video_url: string;
  audio_url: string | null;
  height: number;
  quality_label: string;
  /** Highest rendition this title offers — gates the quality menu. */
  max_height_available: number;
}

/** Map a requested quality to a max pixel height (0 = Auto/best). */
function qualityToHeight(q: string): number {
  switch (q) {
    case "720":  return 720;
    case "1080": return 1080;
    case "1440": return 1440;
    case "2160": return 2160;
    default:     return 0; // "auto"
  }
}

/** Map an ACTUAL resolved height to the menu rung that should be highlighted
 *  (so the selector always shows the resolution that's really playing). Sub-720
 *  heights have no rung, so "auto" is highlighted. */
function heightToRung(height: number): string {
  if (height >= 2160) return "2160";
  if (height >= 1440) return "1440";
  if (height >= 1080) return "1080";
  if (height >= 720)  return "720";
  return "auto";
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
  // Cache fill level (cache-buffering-state, 0-100) reported during a stall.
  // Null when not stalled / not yet readable. Surfaced to the BufferingOverlay.
  // Fed by the engine's gated, crash-safe cache poll (see mpv/engine.rs) via the
  // `playback-update` channel — NOT the old JS get_property polling that raced
  // the libmpv-wrapper (that wrapper is gone; the read now runs on the engine
  // thread, gated against load/seek critical sections).
  const [bufferPct, setBufferPct] = useState<number | null>(null);
  // Demuxer readahead buffered ahead of the playhead, seconds ("amount cached
  // in the demuxer"). Shown on the loading overlay + broadcast per-member.
  const [cacheSeconds, setCacheSeconds] = useState<number | null>(null);
  // Once-per-playback latch: flips true the first time MPV reports
  // time-pos > 0 (i.e. real frames are flowing). The loading overlay
  // stays up until this flips, regardless of `duration` / `buffering`,
  // so the user never sees the overlay vanish while they're still
  // staring at a blank video region. Reset by `notifyNewLoad()` on
  // every new load_video so per-episode swaps go back through the
  // loading state cleanly.
  const [firstFrameSeen, setFirstFrameSeen] = useState(false);
  // Raw seek lifecycle from the engine (SEEK → PLAYBACK_RESTART). Debounced into
  // `seekLoading` below so an instant seek doesn't flash the loading overlay, but
  // a slow/buffering seek surfaces it (with the buffering stats) for transparency.
  const [seeking, setSeeking] = useState(false);
  const [seekLoading, setSeekLoading] = useState(false);
  useEffect(() => {
    if (!seeking) { setSeekLoading(false); return; }
    const t = window.setTimeout(() => setSeekLoading(true), 250);
    return () => window.clearTimeout(t);
  }, [seeking]);

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
  /** Guards the 45 s load watchdog so it fires ONCE per load instead of
   *  re-warning + re-flipping streamBroken every 2 s forever. Reset on each
   *  fresh load (notifyNewLoad). */
  const loadWatchdogFiredRef = useRef(false);
  /** Wall-clock of an unrecovered `end-file reason=error`. mpv fires that when
   *  its own reconnect (reconnect_on_network_error=1) gives up on a range
   *  request; on a flaky debrid stream that happens TRANSIENTLY while the next
   *  episode is still opening. Rather than flip the recovery modal instantly
   *  (the old zero-grace behaviour that surfaced it "too soon" on streams that
   *  then loaded fine), we stamp this and let the error-grace watchdog wait
   *  STREAM_ERROR_GRACE_MS — cleared if playback comes alive or a new load
   *  supersedes it. 0 = no pending error. Reset per load (notifyNewLoad). */
  const loadErrorAtRef = useRef<number>(0);
  /** Set of load-event names already emitted for the current
   *  load. Stops the same milestone from spamming the log on
   *  every poll tick (e.g. "duration appeared"). */
  const loadEventsSeenRef = useRef<Set<string>>(new Set());
  /** True once mpv has confirmed the CURRENT load's file is open, i.e. the
   *  positions arriving on `playback-update` are known to belong to the file
   *  we asked for.
   *
   *  This exists because the property channel is anonymous. `playback-update`
   *  carries no file identity, and the load window opens HERE - at
   *  notifyNewLoad, which runs before the awaited `resolve_stream` and before
   *  `load_video` is even invoked - while the OUTGOING file is still loaded
   *  and still emitting a perfectly valid `time-pos` at ~30 Hz. Every one of
   *  those ticks used to be applied to the incoming load.
   *
   *  Mostly that self-healed one tick after the new file opened. It did not
   *  when the new file NEVER opened: an episode advance onto a stream that
   *  404'd left `time` holding the previous episode's playhead, and the VOD
   *  auto-retry read it as "where this load broke" and re-issued the episode
   *  at 1341 s of 1476 s - the end card of something the user had not watched.
   *  The same tick also latched `firstFrameSeen` on a file with no frames,
   *  which armed the 8 s mid-play stall detector (it gates on firstFrameSeen)
   *  and upgraded the error grace from the 6 s cold-load value to the 20 s
   *  warm one, so the failure was even diagnosed down the wrong path.
   *
   *  Cleared by notifyNewLoad, set by mpv's FILE_LOADED (`playback-file-loaded`).
   *  `duration > 0` is a second, independent unseal: mpv cannot report a
   *  runtime for a file it has not opened, so a missed FILE_LOADED can never
   *  strand the UI. Which path unsealed is logged, so a build where the event
   *  stops arriving is diagnosable rather than silently degraded. */
  const positionOwnedRef = useRef(false);
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
  // Buffer forward-progress tracker: last seen demuxer readahead (s) and the
  // wall-clock of the last genuine +BUFFER_PROGRESS_MIN_S jump. The stall /
  // load watchdogs use this to keep a slow-but-filling stream out of the
  // recovery modal. Reset per load in notifyNewLoad.
  const lastCacheSecondsRef = useRef<number>(0);
  const lastBufferProgressAtRef = useRef<number>(0);
  // Buffering-% (cache-buffering-state) rate tracker — last seen % and its
  // wall-clock. A climb of >= BUFFER_PCT_MIN_RATE %/s also refreshes
  // lastBufferProgressAtRef, so a slow-but-filling source (readahead moving in
  // sub-BUFFER_PROGRESS_MIN_S steps) is kept out of the recovery modal. Reset
  // per load in notifyNewLoad.
  const lastCachePctRef = useRef<number>(0);
  const lastCachePctAtRef = useRef<number>(0);
  // Wall-clock of the last user seek. A seek (e.g. fast-forwarding a live
  // stream toward the edge) makes mpv cache-pause while it refills, halting
  // time-pos — that's a buffer, NOT a broken stream, so the stale-heartbeat
  // detector gives a grace window after any seek before flagging a break.
  const lastSeekAtRef = useRef<number>(0);
  // ── Truncated-stream state (see EOF_SHORTFALL_MIN_S) ──
  // `streamTruncated` is the latched verdict: mpv's demuxer is at EOF but the
  // cached range ends far short of the container duration, i.e. the origin
  // dropped the body and this load can never fetch another byte. The ref is
  // what the once-registered listeners read (they outlive every render); the
  // state exists so effects can react to the transition.
  const [streamTruncated, setStreamTruncated] = useState(false);
  const streamTruncatedRef = useRef(false);
  const truncatedSamplesRef = useRef(0);
  /** Mirror of truncatedSamplesRef for the un-latch direction, and the cached
   *  range end at the moment the verdict landed. Together they let the verdict
   *  be released ONLY on proof that the demuxer fetched new data, which is the
   *  one thing a false positive cannot fake. */
  const truncatedRecoverSamplesRef = useRef(0);
  const truncatedAtEndRef = useRef<number | null>(null);
  /** True once a truncated stream's remaining cached runway is nearly spent.
   *  This, not `streamTruncated`, is what arms recovery. See
   *  TRUNCATED_RECOVERY_LEAD_S. */
  const [truncatedRunout, setTruncatedRunout] = useState(false);
  const truncatedRunoutRef = useRef(false);
  /** Absolute timestamp of the last cached packet. Frozen once the demuxer
   *  EOFs (nothing more is ever fetched), so `cacheEnd - time` is exactly the
   *  playable runway left. */
  const cacheEndRef = useRef<number | null>(null);
  // Last position observed while the stream was NOT truncated. Once mpv's
  // keep-open handling teleports `time-pos` to `duration`, every reload path
  // (`ownedTime()` included) would otherwise "resume" at the end of the
  // episode. This is the position recovery must actually use.
  const lastSanePosRef = useRef<number | null>(null);

  // One-shot guard so the fast near-end EOS short-circuit dispatches
  // `aura:eos-detected` exactly once per stream. Reset per load inside
  // notifyNewLoad (alongside the other fresh-load state resets).
  const nearEndEosFiredRef = useRef(false);

  /** Release the ENTIRE truncation state group, including the EOS fuse.
   *
   *  There are two exits from a truncation and both must land in the same
   *  place: a fresh load (notifyNewLoad) and an un-latch, which fires when the
   *  demuxer proves it is fetching again after a FALSE POSITIVE. Clearing only
   *  the verdict on the second path left `truncatedRunout` armed, which
   *  permanently disables the heartbeat's `setStreamBroken(false)` self-heal
   *  and strands the recovery modal over a stream that is demonstrably fine,
   *  and left `nearEndEosFiredRef` burned by the suppression path so the real
   *  end card could never fire for that episode. One helper so the two exits
   *  cannot drift apart again.
   *
   *  `cacheEndRef` is deliberately NOT reset here: on the un-latch path it
   *  holds the live cached range and is still wanted. notifyNewLoad clears it
   *  separately. */
  const clearTruncationState = useCallback(() => {
    streamTruncatedRef.current = false;
    truncatedSamplesRef.current = 0;
    truncatedRecoverSamplesRef.current = 0;
    truncatedAtEndRef.current = null;
    truncatedRunoutRef.current = false;
    nearEndEosFiredRef.current = false;
    setStreamTruncated(false);
    setTruncatedRunout(false);
  }, []);
  /** Single gate + fuse for every end-of-stream trigger.
   *
   *  There are five detectors (immediate near-end tick, keep-open paused
   *  transition, 1.5 s near-end stale heartbeat, 8 s stale near-end, and
   *  `playback-end` reason=eof) and before this they each dispatched
   *  `aura:eos-detected` inline. Two problems that fixes:
   *
   *  1. A TRUNCATED stream reaches four of the five. When an origin drops the
   *     body, a forward seek past the cached data makes mpv's keep-open run
   *     `seek_to_last_frame()`, which reports `time-pos == duration` and
   *     auto-pauses - satisfying every near-end predicate at once, on an
   *     episode the viewer is 15% into. Suppressing here is what stops the
   *     false end card, and (because the end card pauses mpv, and the break
   *     detector early-returns while paused) it is also what keeps recovery
   *     reachable at all.
   *  2. None of them logged, so after the fact there was no way to tell WHICH
   *     detector raised a card. `reason` is recorded for exactly that.
   *
   *  Deliberately NOT gated on accumulated watch time: a viewer who scrubs
   *  straight into the last few seconds has almost none, and must still get
   *  the end card. Suppression requires positive evidence of truncation. */
  const fireEos = useCallback((reason: string) => {
    if (nearEndEosFiredRef.current) return;
    if (streamTruncatedRef.current) {
      // Burn the fuse on this path too. The 1.5 s and 8 s near-end detectors
      // live in a 1 Hz setInterval that re-evaluates from scratch every tick,
      // so without this a truncated-and-teleported playhead re-enters here
      // once a second for as long as the recovery modal is up. Safe: a
      // truncated load can never reach a genuine end of stream (mpv issues no
      // further requests for it), and notifyNewLoad clears this fuse and the
      // truncation latch together, so the recovery reload re-arms both.
      nearEndEosFiredRef.current = true;
      console.warn(`[eos] suppressed (${reason}): stream is truncated, not finished`);
      return;
    }
    nearEndEosFiredRef.current = true;
    console.info(`[eos] fired by ${reason}`);
    window.dispatchEvent(new CustomEvent("aura:eos-detected"));
  }, []);

  useEffect(() => {
    // Previous tick's `payload.paused` for the keep-open EOS branch
    // below. With `keep-open=yes` + `keep-open-pause=yes` (player.rs
    // init_mpv), mpv at true EOF does NOT emit END_FILE — it auto-
    // pauses internally and holds the last frame. That breaks the
    // existing EOS-trigger paths:
    //   • The immediate-fire branch below has a `!_isPaused` guard
    //     that fails the moment mpv auto-pauses.
    //   • The 1 Hz stale-heartbeat detector early-returns on `paused`.
    //   • `playback-end {reason:"eof"}` never fires under keep-open.
    // The unambiguous EOS signal under keep-open is the false→true
    // transition of `paused` while time is near duration. (A manual
    // user-pause can happen at any time, not specifically near the
    // end — so the near-duration gate keeps it unambiguous.) Live in
    // the listener effect so it's per-mount (re-created on dep change
    // matches the natural fresh-listener lifetime).
    let prevPayloadPaused = false;
    const p = listen<PlaybackPayload>("playback-update", ({ payload }) => {
      // Backup unseal (see positionOwnedRef). mpv cannot report a runtime for
      // a file it has not opened, so a duration for THIS load is independent
      // proof the new file is up - and it means a missed `playback-file-loaded`
      // degrades to today's behaviour instead of stranding the scrubber at
      // 00:00 for the whole episode. Checked before the position block so a
      // payload that somehow carries both is not discarded.
      if (
        !positionOwnedRef.current &&
        typeof payload.duration === "number" && payload.duration > 0
      ) {
        positionOwnedRef.current = true;
        logLoadEvent("position unsealed via duration (no file-loaded event)", {
          duration: payload.duration,
        });
      }
      // Scoped rather than an early `return`: a payload carries one changed
      // property today, but dropping the whole tick would silently swallow
      // `paused` / `volume` / cache telemetry the day that stops being true.
      if (typeof payload.time === "number" && positionOwnedRef.current) {
        // Drop positions that belong to the OUTGOING file. Not an edge case:
        // between notifyNewLoad and mpv opening the new file the previous one
        // is still decoding and still emitting at ~30 Hz, so WITHOUT this every
        // episode advance re-poisons `time`, `firstFrameSeen` and the stall
        // detector's heartbeat with the previous episode's playhead. `duration`
        // is deliberately NOT gated: it arrives once per file and this handler
        // is its only writer, so swallowing it would kill the scrubber for the
        // whole episode, whereas `time` self-corrects on the very next tick.
        lastTimeUpdateAtRef.current = Date.now();
        // Accumulate real forward-progress for the History gate. Only
        // positive sub-cap deltas count, so a seek-to-end never inflates
        // watchedElapsedRef (see HISTORY_TICK_DELTA_CAP_S).
        const _dt = payload.time - watchedElapsedLastTimeRef.current;
        if (_dt > 0 && _dt < HISTORY_TICK_DELTA_CAP_S) {
          watchedElapsedRef.current += _dt;
        }
        watchedElapsedLastTimeRef.current = payload.time;
        setTime(payload.time);
        // Snapshot the last position from BEFORE the stream went bad. Once
        // mpv's keep-open handling runs seek_to_last_frame() the reported
        // playhead is `duration`, and every resume path (`ownedTime()`
        // included) would otherwise restart the episode at its end.
        // A position is honest when the stream is healthy, OR when it is
        // truncated but still inside the frozen cached range - those frames
        // are real, the viewer is watching them, and that is where a reload
        // must resume. Only the keep-open `seek_to_last_frame()` lie lands
        // PAST `cacheEnd`, and the truncation test guarantees
        // `duration > cacheEnd + EOF_SHORTFALL_MIN_S`, so the lie can never
        // pass this test. Without the second case the resume point froze at
        // the instant the demuxer EOF'd, which is a whole readahead
        // (`demuxer-readahead-secs=120`) behind where the viewer actually got
        // to, and every recovery rewound them by up to two minutes.
        const _cachedEnd = cacheEndRef.current;
        if (
          !streamTruncatedRef.current ||
          (_cachedEnd != null && payload.time <= _cachedEnd + 1)
        ) {
          lastSanePosRef.current = payload.time;
        }
        if (streamTruncatedRef.current && !truncatedRunoutRef.current) {
          // Truncated: count down the cached runway. `cacheEnd` is frozen (the
          // demuxer will never fetch again), so this shrinks purely as
          // playback consumes what is left. Arms recovery once the lead time
          // is reached - or immediately if the cache was already spent when
          // the verdict landed.
          const end = cacheEndRef.current;
          const runway = end != null ? end - payload.time : 0;
          if (runway <= TRUNCATED_RECOVERY_LEAD_S) {
            truncatedRunoutRef.current = true;
            setTruncatedRunout(true);
            console.warn(
              `[playback] truncated stream: ${runway > 0 ? `${runway.toFixed(0)}s` : "no"} `
              + `cached runway left - arming recovery`,
            );
          }
        }
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
          //
          // EXCEPT once truncation has armed recovery. Every other detector
          // triggers ON the heartbeat stopping, so no tick can arrive to undo
          // them; truncation is the only one that arms while `time-pos` is
          // still ticking at ~30 Hz (TRUNCATED_RECOVERY_LEAD_S deliberately
          // fires ~12 s BEFORE the cached runway ends, so the reload can
          // re-buffer while it drains). `streamBroken` is a dep of the VOD
          // auto-retry effect, so clearing it here runs that effect's cleanup
          // and cancels the pending reload roughly one tick after it was
          // scheduled - leaving the player to coast to a frozen stop with no
          // modal, no retry, and one retry attempt silently burned. The frames
          // still arriving are the cache draining, NOT recovery: mpv cannot
          // un-latch the demuxer's cached-range eof. notifyNewLoad clears both
          // flags together, so a successful reload still un-latches normally.
          if (!truncatedRunoutRef.current) setStreamBroken(false);
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
      if (typeof payload.buffering === "boolean") {
        setBuffering(payload.buffering);
        if (!payload.buffering) setBufferPct(null); // stall cleared → drop the %
      }
      if (typeof payload.eof === "boolean")     setEof(payload.eof);
      if (typeof payload.seeking === "boolean") {
        setSeeking(payload.seeking);
        // On seek start, the pre-seek cache stats are stale for the new position —
        // clear them so the overlay shows "Seeking…" until the post-seek poll
        // reports fresh numbers for where we landed.
        if (payload.seeking) { setBufferPct(null); setCacheSeconds(null); }
      }
      // Real cache telemetry from the engine's gated poll: drive the loading
      // overlay's % + readahead, and broadcast our buffer to the party.
      if (typeof payload.cache_pct === "number") {
        setBufferPct(payload.cache_pct);
        // Buffering-% forward progress: a cache-buffering-state climbing at
        // >= BUFFER_PCT_MIN_RATE %/s is a healthily filling buffer, so refresh
        // the progress timestamp to keep the recovery modal deferred — the user
        // sees the % climbing on the loading overlay and it must not be yanked
        // up mid-fill. A DROP is a new fill cycle / cache consumed: re-baseline
        // without counting it as progress.
        const pct = payload.cache_pct;
        const now = Date.now();
        const prevPct = lastCachePctRef.current;
        const prevAt = lastCachePctAtRef.current;
        if (prevAt > 0 && pct >= prevPct) {
          const dtSec = (now - prevAt) / 1000;
          if (dtSec > 0 && (pct - prevPct) / dtSec >= BUFFER_PCT_MIN_RATE) {
            lastBufferProgressAtRef.current = now;
          }
        }
        lastCachePctRef.current = pct;
        lastCachePctAtRef.current = now;
      }
      if (typeof payload.cache_seconds === "number") {
        setCacheSeconds(payload.cache_seconds);
        // Track buffer FORWARD progress so the stall / load watchdogs can tell
        // a slow-but-alive fill from a wedged stream. A >= BUFFER_PROGRESS_MIN_S
        // jump in demuxer readahead is real progress; a drop is playback
        // consuming the buffer (or a seek), so re-baseline down without
        // counting it as progress.
        const cs = payload.cache_seconds;
        const prev = lastCacheSecondsRef.current;
        if (cs > prev + BUFFER_PROGRESS_MIN_S) {
          lastBufferProgressAtRef.current = Date.now();
          lastCacheSecondsRef.current = cs;
        } else if (cs < prev) {
          lastCacheSecondsRef.current = cs;
        }
      }
      if (typeof payload.cache_pct === "number" || typeof payload.cache_seconds === "number") {
        notifyLocalBuffer({
          pct: typeof payload.cache_pct === "number" ? payload.cache_pct : null,
          seconds: typeof payload.cache_seconds === "number" ? payload.cache_seconds : null,
          stalled: payload.buffering === true,
        });
      }

      // ── Truncated-stream verdict ──
      // `demux_eof` and `cache_end` arrive together on the engine's cache
      // poll, so this is evaluated on that combined payload only. `duration`
      // never rides along (it is an observed property on its own partial
      // payload), hence lastPosRef.
      if (typeof payload.demux_eof === "boolean") {
        const dur = lastPosRef.current.duration;
        const end = typeof payload.cache_end === "number"
          ? payload.cache_end
          : null;
        // Require a real duration and a real cache end. Without both there is
        // nothing to compare, and guessing here would mean declaring a
        // healthy stream dead - strictly worse than missing a broken one.
        const shortfall = (dur > 0 && end != null && end > 0) ? dur - end : null;
        const qualifies =
          payload.demux_eof &&
          shortfall != null &&
          shortfall > Math.max(EOF_SHORTFALL_MIN_S, dur * EOF_SHORTFALL_RATIO);

        if (end != null) cacheEndRef.current = end;

        if (qualifies) {
          truncatedSamplesRef.current += 1;
          if (
            truncatedSamplesRef.current >= TRUNCATED_CONFIRM_SAMPLES &&
            !streamTruncatedRef.current
          ) {
            streamTruncatedRef.current = true;
            truncatedAtEndRef.current = end;
            truncatedRecoverSamplesRef.current = 0;
            setStreamTruncated(true);
            // Take down any Next-Up card already on screen. Its visibility
            // effect is gated on the verdict from here on, but a card raised
            // just before the teleport would otherwise sit there counting down
            // through the recovery reload (its per-target reset is keyed on
            // activeTarget.id, which an in-place reload does not change).
            window.dispatchEvent(new CustomEvent("aura:stream-truncated"));
            console.warn(
              `[playback] stream truncated: demuxer EOF at ${end!.toFixed(0)}s of `
              + `${dur.toFixed(0)}s (${shortfall!.toFixed(0)}s missing) - the origin dropped `
              + `the body and mpv will not request more data for this load`,
            );
          }
        } else {
          truncatedSamplesRef.current = 0;
          // Un-latch, but only on POSITIVE evidence that the demuxer fetched
          // fresh data for this load - never on `demux_eof === false` alone.
          // The latch is what suppresses the false end card and the poisoned
          // writes, so releasing it cheaply would re-arm every failure this
          // batch fixes. Two things must both hold: the demuxer is no longer
          // at EOF, AND the cached range now extends past where it was frozen.
          // In the real failure mpv issues no further requests at all, so
          // neither can happen; this exists so a detector FALSE POSITIVE
          // cannot poison progress, History and scrobbling for the whole
          // remaining episode. Debounced through the same sample counter for
          // symmetry with the latch.
          if (streamTruncatedRef.current && payload.demux_eof === false) {
            const frozenEnd = truncatedAtEndRef.current;
            if (end != null && frozenEnd != null && end > frozenEnd + 1) {
              truncatedRecoverSamplesRef.current += 1;
              if (truncatedRecoverSamplesRef.current >= TRUNCATED_CONFIRM_SAMPLES) {
                console.info(
                  `[playback] stream recovered: demuxer is fetching again `
                  + `(cache end ${frozenEnd.toFixed(0)}s -> ${end.toFixed(0)}s)`,
                );
                clearTruncationState();
              }
            }
          }
        }
      }

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
        fireEos("near-end-tick");
      }

      // EOS Spotlight — keep-open paused-transition branch (2026-05-20).
      // With `keep-open=yes` + `keep-open-pause=yes` (player.rs), mpv
      // at true EOF auto-pauses on the last frame instead of emitting
      // MPV_EVENT_END_FILE. The immediate-fire branch above can't catch
      // it because `!_isPaused` is false in that exact tick, and the
      // playback-end {eof} / stale-heartbeat fallbacks ALSO fail (the
      // event never fires; the stale detector early-returns on paused).
      // Solution: the unambiguous EOS signal under keep-open is the
      // false→true transition of `paused` WHILE time is near duration.
      //
      // CRITICAL (2026-05-20 v2): the Rust bridge in lib.rs emits one
      // `playback-update` PER observed-property change carrying ONLY
      // the field that changed (lib.rs:1786 "PARTIAL update carrying
      // ONLY the field that changed"). So the very payload that flips
      // `paused=true` typically has NO `time` / `duration` field, and
      // an `_t != null && _d != null` gate on the SAME payload is
      // unsatisfiable. We must read the LAST-KNOWN time/duration from
      // `lastPosRef.current` (set on every time/duration update
      // below) instead. Widened tail to EOS_TAIL_SECONDS (5 s) — under
      // keep-open the false→true pause transition is itself the
      // unambiguous EOS signal; the tail just bounds the "user
      // manually paused at the very end" misfire window, which a
      // generous 5 s value still keeps tight (any intentional pause
      // ≥5 s from end is filtered out).
      const lastKnownT =
        _t != null ? _t : lastPosRef.current.time;
      const lastKnownD =
        _d != null ? _d : lastPosRef.current.duration;
      //
      // The transition is only mpv's OWN auto-pause when nobody asked for one.
      // Every deliberate pause in the app routes through `togglePause`, which
      // stamps `pauseRequestedAtRef`, so a pause we requested inside the grace
      // is the user's and must not summon the end card - otherwise the first
      // time you pause during the credits the episode ends on you, and there is
      // no way to pause in the last EOS_TAIL_SECONDS at all.
      const userAskedToPause =
        Date.now() - pauseRequestedAtRef.current < USER_PAUSE_GRACE_MS;
      const pausedNearEnd =
        _isPaused && !prevPayloadPaused &&
        lastKnownT > 0 && lastKnownD > 0 &&
        lastKnownD - lastKnownT <= EOS_TAIL_SECONDS;
      if (pausedNearEnd && userAskedToPause) {
        // Hand the decision to the latch: the stale-time detector in the 1 s
        // poll fires ~1.5 s later, long after this timestamp grace expires.
        userPausedNearEndRef.current = true;
      } else if (!nearEndEosFiredRef.current && pausedNearEnd) {
        fireEos("keep-open-pause");
      }

      // Update prev-paused tracker AT THE END so the next tick
      // compares against THIS tick's paused state. Only update when
      // payload actually carried a paused field — otherwise we'd
      // collapse to false on every payload that lacks it.
      if (typeof payload.paused === "boolean") {
        prevPayloadPaused = payload.paused;
      }
    });
    return () => { p.then((fn) => fn()).catch(() => {}); };
  }, [logLoadEvent, fireEos]);

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
      // Resuming ends the user's pause, so the end-of-stream detectors go back
      // on duty for whatever happens next.
      userPausedNearEndRef.current = false;
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

  // ── Stream anomaly notice ──
  //
  // The engine reports a playhead move it cannot attribute to any seek, which
  // in practice means the demuxer hit damage, resynced to the next intact
  // point, and adopted that point's timestamp. A real report: a broken MKV
  // jumped 5 minutes 37 seconds with no indication anywhere, and it read as an
  // Aura bug rather than a bad source. The whole value here is telling the
  // user WHICH it was, so the message names the jump and blames the stream.
  //
  // Deliberately a toast and not the recovery modal: playback is still
  // running and the user has lost nothing they can get back by reloading, so
  // interrupting them would be worse than the silence it replaces. Rust
  // already reports at most once per load, so there is no throttle here.
  useEffect(() => {
    if (!playerActive) return;
    const p = listen<{ kind: string; from: number; to: number; delta: number }>(
      "stream-anomaly",
      ({ payload }) => {
        const secs = Math.abs(payload.delta);
        const mins = Math.floor(secs / 60);
        const rem = Math.round(secs % 60);
        const span = mins > 0 ? `${mins}m ${rem}s` : `${rem}s`;
        const backwards = payload.delta < 0;
        const cause = payload.kind === "corrupt-container"
          ? "This file is damaged"
          : "This stream's timestamps are broken";
        window.dispatchEvent(new CustomEvent("aura:player-toast", {
          detail: {
            message: `${cause} · playback ${backwards ? "rewound" : "skipped"} ${span}. Try a different source.`,
            durationMs: 7000,
          },
        }));
        console.warn(
          `[player] stream anomaly (${payload.kind}): ${payload.from.toFixed(1)}s -> `
          + `${payload.to.toFixed(1)}s (${payload.delta >= 0 ? "+" : ""}${payload.delta.toFixed(1)}s) with no seek`,
        );
      },
    );
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
  /** Summed forward playback progress (s) for the CURRENT load. Mirrors
   *  useScrobble's elapsedThisSession: per-tick time deltas accumulate
   *  only when positive and below the seek cap, so seeking never inflates
   *  it. Gates History writes so skip-to-end doesn't log a watched entry.
   *  Reset per load in notifyNewLoad. */
  const watchedElapsedRef = useRef<number>(0);
  const watchedElapsedLastTimeRef = useRef<number>(0);
  /** Latched when a paused transition inside the end-of-stream tail was
   *  attributed to the user rather than to mpv's keep-open auto-pause. There
   *  are TWO near-end EOS detectors and a timestamp grace can only cover the
   *  one that fires immediately: the 1 s poll's ~1.5 s stale-time branch runs
   *  regardless of `paused` and would summon the end card a moment after the
   *  grace expired. Cleared on resume and on every new load, so it only ever
   *  suppresses the pause the user is currently sitting in. */
  const userPausedNearEndRef = useRef(false);
  // True while the window is minimized / in the tray. Shared across the
  // playback-poll effects + the Discord presence effect so none of them do
  // work nobody can see. Playback is paused while hidden (pause-on-minimize
  // default), so these polls have nothing to do anyway; gating the EOS poll
  // also stops the near-end stale-time check from false-firing on paused time.
  const windowHidden = useWindowHidden();
  useEffect(() => {
    // A kept-alive party member (leader OR follower) keeps PLAYING while hidden
    // (window_logic.rs exempts an in-sync member from pause-on-minimise), so the
    // stream-broken detector must keep running for them — otherwise a minimized-
    // but-playing member whose debrid stream breaks never surfaces recovery and
    // sits frozen. Snapshot is fine: the effect re-arms on the windowHidden flip
    // (the minimise transition), which is exactly when this matters.
    const wParty = getWatchState();
    const partyPlayingWhileHidden =
      wParty.status === "connected" && wParty.inSync;
    if (windowHidden && !partyPlayingWhileHidden) return;
    const BROKEN_STALE_MS = 8000;
    // Fast path: when playback was already within the last few seconds
    // of the metadata duration, a stale heartbeat is end-of-stream, not
    // a network break — on this libmpv-wrapper build `time-pos` simply
    // stops at true EOF and `end-file` is unreliable, so the 8 s broken
    // detector would otherwise make the EOS Spotlight appear ~8 s late.
    // Surface it after ~1.5 s instead. Genuine mid-stream halts (>5 s
    // from the end) still wait the full 8 s and flip `streamBroken`.
    const EOS_NEAR_END_STALE_MS = 1500;
    const id = window.setInterval(() => {
      const last = lastTimeUpdateAtRef.current;
      if (last === 0) return;
      if (!firstFrameSeen) return;
      const staleFor = Date.now() - last;
      const { time: t, duration: d } = lastPosRef.current;
      const nearEnd = t > 0 && d > 0 && d - t <= EOS_TAIL_SECONDS;
      // Truncated stream whose heartbeat has stopped: the cached runway is
      // spent. This is the TERMINAL state of the failure - mpv played out
      // everything it had, hit its latched EOF, and `keep-open-pause=yes`
      // auto-paused on the last frame, so `time-pos` will never tick again and
      // the runway countdown in the playback-update listener can never
      // complete on its own.
      //
      // It MUST sit above the `if (paused) return` guard below, for exactly
      // the reason the near-end EOS branch does: from here, mpv's auto-pause
      // and a person pressing space are the same signal. Unlike that branch
      // there is no ambiguity to resolve, because a user pause on a stream we
      // have already PROVEN truncated still ends in the same place - the
      // stream is dead either way, and recovery is what the viewer wants.
      if (streamTruncatedRef.current) {
        // A stopped heartbeat is only runout if the cached runway is actually
        // gone. A deliberate user pause halts `time-pos` identically, and
        // arming on that would throw away the buffer the viewer could still
        // watch - the exact thing decoupling detection from recovery exists to
        // protect (up to `cache-secs=180` of it). So test the runway directly
        // rather than trying to tell the two pauses apart: mpv's own keep-open
        // auto-pause can only happen once the cache is exhausted, so it always
        // satisfies this, while a mid-buffer user pause never does. When they
        // resume, the countdown in the playback-update listener takes over.
        //
        // A null `cacheEnd` (never sampled) counts as spent: if we cannot tell
        // how much is left, recovering is the safe default.
        const _end = cacheEndRef.current;
        const _runwaySpent =
          _end == null || _end - lastPosRef.current.time <= TRUNCATED_RECOVERY_LEAD_S;
        if (
          !truncatedRunoutRef.current &&
          staleFor >= EOS_NEAR_END_STALE_MS &&
          _runwaySpent
        ) {
          truncatedRunoutRef.current = true;
          setTruncatedRunout(true);
          console.warn("[playback] truncated stream: playback stopped, cached data exhausted - arming recovery");
        }
        if (truncatedRunoutRef.current) {
          // Re-assert every tick rather than relying on the one-shot effect.
          // The modal's "Switch source" button clears `streamBroken` WITHOUT
          // issuing a load, so if the user closes the switcher without picking
          // anything the stream is still dead and the modal has to come back -
          // which is the behaviour the stale-heartbeat detector already
          // provides for every other break. Idempotent: setting a state to the
          // value it already holds does not re-render, so this cannot re-enter
          // the auto-retry effect. It stops on its own when the recovery reload
          // calls notifyNewLoad and clears the truncation latch.
          setStreamBroken(true);
        }
        return;
      }
      // Near-end EOS short-circuit (~1.5 s): runs REGARDLESS of the
      // paused flag. Under `keep-open=yes` + `keep-open-pause=yes`
      // (player.rs init_mpv), mpv at true EOF auto-pauses on the last
      // frame and stops emitting `time-pos`. The original
      // `if (paused) return;` guard up here would have gated this out
      // — the in-listener paused-transition detector can't compensate
      // because the Rust bridge emits partial `playback-update`
      // payloads (lib.rs:1786 "PARTIAL update carrying ONLY the field
      // that changed"), so the very payload that flips `paused=true`
      // typically has NO `time`/`duration` field. The single reliable
      // signal under keep-open is "time-pos was static at near-end for
      // ≥EOS_NEAR_END_STALE_MS"; that is exactly what this branch
      // checks. Defense-in-depth with the in-listener path: whichever
      // trips first wins via `nearEndEosFiredRef`.
      //
      // ...unless the user is the one who paused. mpv's auto-pause at EOF and a
      // person pressing space are the same two signals from here (paused, and
      // time-pos static near the duration), so the listener above latches which
      // it was. Without that, the FIRST pause inside the last EOS_TAIL_SECONDS
      // always summoned the end card 1.5 s later and there was no way to pause
      // during the credits.
      if (
        nearEnd &&
        !nearEndEosFiredRef.current &&
        !userPausedNearEndRef.current &&
        staleFor >= EOS_NEAR_END_STALE_MS
      ) {
        fireEos("near-end-stale-1.5s");
        return;
      }
      // Genuine-break path below: only meaningful while playback was
      // actually rolling. A deliberate user pause must not trigger the
      // recovery modal. (paused-for-cache buffering is its own state
      // with its own UI.) IMPORTANT: this early-return MUST come AFTER
      // the near-end EOS check above — moving it back up would re-
      // introduce the keep-open EOS regression.
      if (paused) return;
      // Post-seek grace: a seek (e.g. fast-forwarding a live stream toward the
      // edge) makes mpv cache-pause while it refills, halting time-pos. That's
      // a buffer, not a break — don't flag broken for a while after a seek.
      // (Live has no `duration`, so `nearEnd` can't disambiguate it as EOS;
      // this grace is what keeps FF-to-the-edge from tripping the modal.)
      const SEEK_GRACE_MS = 15000;
      if (Date.now() - lastSeekAtRef.current < SEEK_GRACE_MS) return;
      if (staleFor >= BROKEN_STALE_MS) {
        if (nearEnd) {
          // Near-end stall → end-of-stream, not a break. App owns the
          // Spotlight; one dispatch is enough (the listener latches).
          fireEos("near-end-stale-8s");
          return;
        }
        // Buffer-aware: a cache stall legitimately halts time-pos. If the
        // demuxer buffer is still FILLING (progress within BUFFER_STALL_MS),
        // the stream is alive but slow — keep waiting so buffering can finish
        // instead of yanking up the recovery modal mid-fill. Only a buffer
        // that has made NO progress for BUFFER_STALL_MS is treated as wedged.
        if (Date.now() - lastBufferProgressAtRef.current < BUFFER_STALL_MS) return;
        setStreamBroken(true);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [paused, firstFrameSeen, windowHidden, fireEos]);

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
        // Interpolate the mpv error code into the message string — passing
        // `payload` as a second arg made Sentry's console capture log a useless
        // "[object Object]". The code distinguishes failure modes (e.g. loading
        // failed vs. unsupported format); the stream URL is deliberately NOT
        // logged (debrid URLs carry auth tokens).
        console.warn(`[playback] end-file reason=error code=${payload?.error ?? "?"} — arming ${STREAM_ERROR_GRACE_MS / 1000}s recovery grace`);
        // Do NOT flip streamBroken here. This was the ONLY recovery path with
        // zero grace, and on a flaky debrid stream a transient error at the
        // START of the next episode (mpv's reconnect gave up on the first range
        // request, then a retry / the source recovers) surfaced the modal "too
        // soon" on streams that then played fine. Stamp the error; the
        // error-grace watchdog below waits STREAM_ERROR_GRACE_MS and only flags
        // broken if playback never comes alive (no time-pos update after the
        // error) and no new load supersedes it.
        loadErrorAtRef.current = Date.now();
        return;
      }
      // "eof" = the file played to completion. This is the clean
      // end-of-stream signal (EOS Spotlight, 2026-05-19). App owns the
      // Spotlight UI; we just notify via a window event so usePlayback
      // stays free of the eosActive state (App clears it on new load /
      // exit). The near-end stale-heartbeat path above is the fallback
      // for containers whose `eof` event never arrives.
      if (reason === "eof") {
        // Position-gated like every other trigger. Near-unreachable while
        // `keep-open=yes` holds (mpv converts AT_END_OF_FILE into KEEP_PLAYING
        // rather than emitting END_FILE), but it becomes live the moment
        // keep-open changes or the playlist gains a second entry - and an
        // ungated one is exactly how a premature EOF would fake an end card.
        const { time: eofT, duration: eofD } = lastPosRef.current;
        if (eofD > 0 && eofD - eofT > EOS_TAIL_SECONDS) {
          console.warn(
            `[eos] ignoring end-file eof at ${eofT.toFixed(0)}s of ${eofD.toFixed(0)}s `
            + `- too far from the end to be a completion`,
          );
        } else {
          fireEos("playback-end-eof");
        }
      }
    });
    return () => { p.then((fn) => fn()).catch(() => {}); };
  }, [fireEos]);

  // mpv opened the file the current load asked for → positions on
  // `playback-update` now belong to it. Mounted unconditionally (NOT behind
  // `playerActive`) and with an empty dep list, so the listener is live before
  // the session's first load rather than racing it.
  useEffect(() => {
    const p = listen("playback-file-loaded", () => {
      if (positionOwnedRef.current) return;
      positionOwnedRef.current = true;
      logLoadEvent("file opened (positions now owned by this load)");
    });
    return () => { p.then((fn) => fn()).catch(() => {}); };
  }, [logLoadEvent]);

  // Belt-and-suspenders watchdog: if loadStartedAtRef has been non-
  // zero for >LOAD_TIMEOUT_MS and firstFrameSeen is still false, the
  // load is wedged (e.g. silent network hang where no end-file event
  // ever fires). Surface the recovery overlay anyway. The 45 s
  // window is long enough that slow CDNs handing over the first 4K
  // frame don't false-positive.
  useEffect(() => {
    if (firstFrameSeen || windowHidden) return;
    const LOAD_TIMEOUT_MS = 45000;
    const id = window.setInterval(() => {
      const start = loadStartedAtRef.current;
      if (start === 0 || loadWatchdogFiredRef.current) return;
      if (Date.now() - start >= LOAD_TIMEOUT_MS) {
        // Buffer-aware: if the initial cache is still FILLING (progress within
        // BUFFER_STALL_MS), the source is just slow — don't declare the load
        // wedged; keep waiting so the buffer can reach the play threshold.
        if (Date.now() - lastBufferProgressAtRef.current < BUFFER_STALL_MS) return;
        // Fire ONCE per load — the guard (reset in notifyNewLoad) stops this
        // from re-warning + re-flipping streamBroken every 2 s indefinitely
        // when a load stays wedged.
        loadWatchdogFiredRef.current = true;
        console.warn("[playback] load watchdog: no first frame in 45 s");
        setStreamBroken(true);
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [firstFrameSeen, windowHidden]);

  // ── Error-grace watchdog ──
  // Deferred companion to the immediate `end-file reason=error` flip that used
  // to be here. When mpv reports a load/playback error we stamp loadErrorAtRef
  // (in the playback-end listener) rather than flag broken; this poll decides
  // the outcome once the grace elapses. It's the "more accurate" half: if a
  // time-pos update lands AFTER the error the stream came alive (mpv re-opened
  // it / the transient cleared) and we clear the pending error silently; a new
  // load resets loadErrorAtRef via notifyNewLoad, so an error from the previous
  // episode never leaks onto the next one. Only an error that stays dead for the
  // whole grace surfaces the recovery modal.
  useEffect(() => {
    if (windowHidden) return;
    const id = window.setInterval(() => {
      const errAt = loadErrorAtRef.current;
      if (errAt === 0) return;
      // Came alive after the error → recovered, no modal. (notifyNewLoad zeroes
      // lastTimeUpdateAtRef on a new load, so this can't false-clear across
      // loads; a stale pending error is cleared by notifyNewLoad directly.)
      if (lastTimeUpdateAtRef.current > errAt) { loadErrorAtRef.current = 0; return; }
      // Cold load (no frame ever seen) gets the short grace: see the constant.
      const grace = firstFrameSeen ? STREAM_ERROR_GRACE_MS : STREAM_ERROR_COLD_GRACE_MS;
      if (Date.now() - errAt >= grace) {
        loadErrorAtRef.current = 0;
        console.warn(`[playback] end-file error unrecovered after ${grace / 1000}s, surfacing recovery`);
        setStreamBroken(true);
      }
    }, 1000);
    return () => window.clearInterval(id);
    // firstFrameSeen picks the grace, so it must be a dep. Read from a stale
    // closure it would have pinned whichever value held when the interval was
    // created, and a cold load would have waited the full 20 s anyway.
  }, [windowHidden, firstFrameSeen]);

  /** Reset playback state for a new load_video call. Called from the
   *  parent right before invoking load_video so every fresh playback
   *  session — first or Nth — starts in the "loading" state and the
   *  overlay only hides once MPV is genuinely ready to play. */
  const notifyNewLoad = useCallback(() => {
    loadStartedAtRef.current = Date.now();
    loadWatchdogFiredRef.current = false;
    // A fresh load supersedes any pending error grace from the previous file,
    // so an error stamped just before the episode advance can't flag the NEW
    // stream broken 20 s in.
    loadErrorAtRef.current = 0;
    loadEventsSeenRef.current = new Set();
    // Nothing about the OUTGOING file survives this point. Re-opened only by
    // mpv confirming the new file is up (see positionOwnedRef) - until then
    // `time` stays 0 and the resume paths correctly fall back to the offset
    // this load was ISSUED with.
    positionOwnedRef.current = false;
    lastTimeUpdateAtRef.current = 0;
    lastCacheBufferLogRef.current = null;
    lastCacheSecondsRef.current = 0;
    lastBufferProgressAtRef.current = 0;
    lastCachePctRef.current = 0;
    lastCachePctAtRef.current = 0;
    nearEndEosFiredRef.current = false;
    userPausedNearEndRef.current = false;
    watchedElapsedRef.current = 0;
    watchedElapsedLastTimeRef.current = 0;
    // A fresh loadfile is the ONLY thing that can clear a truncation: mpv
    // cannot un-latch a cached range's eof flag, so the verdict is sticky for
    // the life of the load. `lastSanePosRef` is deliberately NOT cleared here
    // - the recovery reload is issued from it, and this runs immediately
    // BEFORE that reload.
    clearTruncationState();
    cacheEndRef.current = null;
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

  /** When a pause was last REQUESTED through this callback. The keep-open EOS
   *  detector reads it to tell mpv's own auto-pause on the last frame from a
   *  person hitting space: both look identical on the wire (a false->true
   *  `paused` transition near the duration), so without it the first pause
   *  inside the final EOS_TAIL_SECONDS always summoned the end card.
   *
   *  Covers the pauses the React layer originates - the keybindings, the video
   *  click layer, the control bar, the party bridge - which is every pause the
   *  user can make from inside Aura. A pause originated OUTSIDE the webview (an
   *  SMTC / media-key path handled in Rust, say) would not stamp it and would
   *  still read as end-of-stream; if one is added, stamp it there too. */
  const pauseRequestedAtRef = useRef(0);
  const togglePause   = useCallback(() => {
    pauseRequestedAtRef.current = Date.now();
    return invoke("toggle_pause").catch(() => {});
  }, []);
  // Fired on every seek so surfaces that MUST survive a seek can re-assert.
  // Right now it drives the subtitle control-bar lift: mpv drops the runtime
  // `sub-pos` override when it re-renders subtitles at the new position, so the
  // lifted dialogue snaps back behind the control bar (most visible while the
  // Live Sync panel holds the bar open). PlayerOverlay re-applies the lift on
  // this event. A plain window event avoids threading a nonce through the tree.
  const signalSeek = useCallback(() => {
    window.dispatchEvent(new Event("aura:player-seek"));
  }, []);
  const seekRelative  = useCallback(
    (s: number) => {
      lastSeekAtRef.current = Date.now();
      signalSeek();
      return invoke("seek_relative", { seconds: s }).catch(() => {});
    },
    [signalSeek],
  );
  const seekAbsolute  = useCallback(
    (t: number) => {
      lastSeekAtRef.current = Date.now();
      signalSeek();
      return invoke("seek_absolute",  { time: t }).catch(() => {});
    },
    [signalSeek],
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
    time, duration, paused, volume, speed, buffering, bufferPct, cacheSeconds, seekLoading, eof, firstFrameSeen,
    streamBroken, setStreamBroken,
    togglePause, seekRelative, seekAbsolute, commitVolume, commitSpeed,
    notifyNewLoad, logLoadEvent,
    watchedElapsedRef,
    positionOwnedRef,
    // Truncated-stream verdict + the last position from before it latched.
    // App owns recovery (the auto-retry and the modal both live there), so it
    // needs the state to react to and the ref to resume from.
    streamTruncated, streamTruncatedRef, lastSanePosRef,
    truncatedRunout, cacheEndRef,
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

/** Robust anime check for the active playback target. Series episodes key
 *  their anime signals (id-prefix, genres, localStorage cache) at the SERIES
 *  ROOT — `target.id` is the EPISODE id (tt…:S:E) and never matches — so we
 *  resolve `series_id` and feed the library item's genres. Mirrors the
 *  stats-ticker detection; the single source of truth for "is the thing on
 *  screen anime", shared by the motion-interpolation gate and in-player UI. */
function activeTargetIsAnime(
  target: ActiveScrobbleTarget,
  library: LibraryItem[],
): boolean {
  const recordId = target.series_id ?? target.id;
  const libItem = library.find((i) => i.id === recordId);
  const stateGenres = (libItem?.state ?? {}).genres;
  const genres = Array.isArray(stateGenres)
    ? stateGenres.filter((g): g is string => typeof g === "string")
    : undefined;
  return isAnimeMeta({
    media_type: target.media_type,
    id:         recordId,
    genres,
  });
}

/**
 * Shortest runtime Aura will accept as a real title.
 *
 * A debrid service or addon that fails to resolve does not always return an
 * HTTP error: TorBox and friends answer with a short MP4 that PLAYS PERFECTLY
 * and simply reads "REQUEST TIMED OUT" on screen. mpv sees an ordinary,
 * healthy ~30 s file, so nothing downstream knows anything went wrong.
 *
 * That matters because every completion gate in this file is expressed as a
 * RATIO of duration - "watched >= 80 %", "reached >= 90 %", "remaining <=
 * lead" - and a 30 s clip satisfies all of them trivially by running to its
 * own end. The observed symptom was an End-of-Season Spotlight offering the
 * next episode as though the episode that never played had been finished.
 *
 * So the floor is ABSOLUTE, not proportional. 120 s is not a new invention: it
 * is the bar PROGRESS_WARMUP_S, MEANINGFUL_WATCH_S and useScrobble's
 * START_WARMUP_S already apply, so a file whose entire duration is under it can
 * never produce a genuine WATCH by Aura's own existing definition. Letting it
 * produce a genuine COMPLETION was the inconsistency. Real episodes and films
 * are always longer; what is shorter is an error card, a sample file or a
 * placeholder, none of which the user watched.
 */
const MIN_PLAUSIBLE_TITLE_S = 120;

/** True when the loaded file is too short to be the title it claims to be.
 *  A missing / zero duration means "not known yet", which is NOT short: never
 *  suppress on absent data, only on a positive reading below the floor. */
function isImplausiblyShortStream(duration: number | null | undefined): boolean {
  return typeof duration === "number" && duration > 0 && duration < MIN_PLAUSIBLE_TITLE_S;
}

export default function App() {
  // ── Nav state ──
  // Restore the route from sessionStorage on a webview reload (Ctrl+R / F5)
  // so the user lands back on the page they were viewing rather than Home.
  // sessionStorage is cleared on app close, so a cold start still opens Home.
  // The lazy initializer runs once on mount; selectedMeta's does the same.
  const [activeView, setActiveView] = useState<NavView>(
    () => loadSessionRoute()?.view ?? "home",
  );
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
  // Backfill posters for art-less Library items (often unreleased), retrying
  // ~hourly per id. In-memory only — never touches the Stremio cloud record.
  useLibraryArtRetry(library, addons, (id, poster) => {
    setLibrary((prev) => prev.map((it) => (it.id === id && !it.poster ? { ...it, poster } : it)));
  });
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
  // Always-current mirror of rawLibrary, read by callbacks that would
  // otherwise have to list `rawLibrary` in their useCallback deps. Keeping
  // handleLibraryRemove out of the rawLibrary dependency makes it
  // referentially stable, so the LibraryView grid's memoized cards don't ALL
  // re-render every time the library list churns (poster-warm, focus
  // refetch). Updating a ref during render is safe — it's not observable
  // state, just the latest value for imperative reads.
  const rawLibraryRef = useRef(rawLibrary);
  rawLibraryRef.current = rawLibrary;
  // Same always-current mirror for the normalized library — lets the
  // playback stats ticker resolve an item's genres (for anime detection)
  // by series-root id without listing `library` in its effect deps (which
  // would reset the 5 s tick timer every poster-warm/refetch).
  const libraryRef = useRef(library);
  libraryRef.current = library;
  /** False until the first library_get for the current session has resolved.
   *  Drives the LibraryView skeleton state — without this we'd flash an
   *  empty-state card during the initial fetch. */
  const [libraryLoaded, setLibraryLoaded] = useState(false);

  // ── Active scrobble / RPC / SMTC target ──
  const [activeTarget, setActiveTarget] = useState<ActiveScrobbleTarget | null>(null);
  // Always-current mirror, read by the auto-remove effect (empty deps) so it
  // can tell whether a just-"watched" id is the one CURRENTLY playing - that
  // one's removal is deferred to handleExitPlayback (post-flush) to dodge the
  // progress-write resurrection race.
  const activeTargetRef = useRef(activeTarget);
  activeTargetRef.current = activeTarget;
  // Snapshot of whether the title was ALREADY watched when the current playback
  // began. The auto-remove exit hook fires only on a genuine not-watched to
  // watched TRANSITION, so replaying a title the user chose to KEEP (declined
  // the enable-sweep) is never re-removed. Keyed by root id; { id, wasWatched }.
  const watchedAtStartRef = useRef<{ id: string; wasWatched: boolean } | null>(null);
  /** Whether the active stream's NAME labelled it as HDR/DV content.
   *  Passed to `load_video` as `contentHdrHint` so the engine can pick
   *  the per-load HDR output set (PQ for HDR content, plain SDR
   *  otherwise) while hdr_mode=passthrough. Kept in a ref so the EOS
   *  replay / stream-broken reload sites can re-send the same hint
   *  without threading it through state. */
  const lastHdrHintRef = useRef<boolean>(false);
  /** The active load's per-playlist Live TV forward proxy (mpv `http-proxy`),
   *  null for every normal stream. `http-proxy` is a PER-FILE loadfile option,
   *  so every in-place reload (live auto-retry, recovery-modal Reload, EOS
   *  Replay) has to re-send it or the reload connects direct and a proxy-gated
   *  provider rejects it, leaving the channel unrecoverable without exiting to
   *  the Live grid. Same ref pattern as lastHdrHintRef. */
  const lastProxyUrlRef = useRef<string | null>(null);
  /** The active load's external DASH audio URL (1080p+ trailers), null for
   *  every normal stream. Like `http-proxy` this is a PER-FILE loadfile option,
   *  so an in-place reload that omits it clears `audio-files` and the reloaded
   *  trailer plays silently. Same ref pattern as lastProxyUrlRef. */
  const lastAudioUrlRef = useRef<string | null>(null);
  /** The `startSeconds` the active load was issued with. The reload paths used
   *  to derive their resume offset from the live `time`, which is 0 whenever
   *  the load never produced a frame - exactly the case a reload exists for -
   *  so retrying a failed resume silently restarted the episode from the top.
   *  Used as the fallback when `time` has nothing to say. */
  const lastStartSecondsRef = useRef<number | null>(null);
  /** Per-load token for the OP/ED skip-window resolution chain. That chain is
   *  fire-and-forget and LONG (a 6 s chapter poll, then a possible ffmpeg
   *  fetch, then silence scans over up to 600 s of audio), while
   *  `set_skip_windows` is global state with no file association. Without a
   *  token, the outgoing episode's chain stamps its OP/ED onto whatever is
   *  playing by the time it finally resolves: the next episode auto-seeks at
   *  the previous one's timings. Claimed synchronously before the first await
   *  and re-checked before every stamp. */
  const skipChainSeqRef = useRef(0);
  /** Live per-kind skip modes. Written by the skip chain when it reads
   *  settings at load time AND by the `aura:settings-changed` re-stamp, so a
   *  mode change made mid-load is honoured by whichever of the two writes the
   *  payload last. See the comment at the chain's `modeFor`. */
  const skipModesRef = useRef<{ op: "off" | "prompt" | "auto"; ed: "off" | "prompt" | "auto"; recap: "off" | "prompt" | "auto" }>(
    { op: "auto", ed: "prompt", recap: "prompt" },
  );
  /** The DIRECT (un-proxied) URL of the playing stream, kept for the
   *  PlayerOverlay's Copy / Download / External-player utilities. Cleared
   *  when playback exits. */
  const [activeStreamUrl, setActiveStreamUrl] = useState<string | null>(null);
  /** The currently-playing StreamEntry (not just its url) — the source switcher
   *  matches its "Now Playing" row on this by stable identity, since debrid urls
   *  re-resolve per fetch and wouldn't match a freshly-fetched switcher list. */
  const [currentStream, setCurrentStream] = useState<StreamEntry | null>(null);
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
  /** True while the "you're closing mid-scrobble" prompt owns the screen — it
   *  renders its own progress, so the floating bar stands down. */
  const [scrobbleClosePromptOpen, setScrobbleClosePromptOpen] = useState(false);
  // Mirror of PlayerOverlay's auto-hide `controlsVisible` so the sibling
  // PlayerPartyHud pill can fade in lockstep with the player chrome.
  const [playerControlsVisible, setPlayerControlsVisible] = useState(true);
  /** True when the active stream is a Live TV channel (synthetic `iptv:`
   *  target / media_type "tv"). Drives the live carve-outs: no scrubber,
   *  no resume prompt, no scrobble, no history / Continue-Watching write
   *  — an infinite live stream has no meaningful position or completion. */
  const isLivePlayback =
    activeTarget != null &&
    (activeTarget.media_type === "tv" || activeTarget.id.startsWith("iptv:"));

  /** A "Watch Trailer" playback session (synthetic `trailer:<ytId>` target).
   *  Like live TV it has no library record, resume position, or completion —
   *  so it shares every VOD carve-out (no scrobble / history / Continue-
   *  Watching / resume prompt / source switcher). Kept separate from
   *  `isLivePlayback` so the player chrome can show a TRAILER badge (not LIVE)
   *  and the live-only reconnect loop never fires for it. */
  const isTrailerPlayback =
    activeTarget != null && activeTarget.id.startsWith("trailer:");

  // ── Trailer quality state ──
  // `trailerQuality` is the REQUESTED quality (drives the active menu row);
  // `trailerQualityLabel` is what was actually RESOLVED (drives the menu button
  // text — may be lower when the title has no higher rendition). The ytId of
  // the playing trailer is kept in a ref so the in-player quality swap can
  // re-resolve without a stale closure. `trailerResolvingRef` guards against
  // overlapping re-resolves (the state is for the UI loading affordance).
  const [trailerQuality, setTrailerQuality] = useState<string>("1080");
  const [trailerQualityLabel, setTrailerQualityLabel] = useState<string>("");
  // Highest rendition the current trailer offers — gates the quality menu so
  // the user can't pick a resolution that isn't actually available.
  const [trailerMaxHeight, setTrailerMaxHeight] = useState<number>(2160);
  const [isTrailerResolving, setIsTrailerResolving] = useState(false);
  const activeTrailerYtIdRef = useRef<string | null>(null);
  const trailerResolvingRef = useRef(false);
  // The height ACTUALLY playing — so a quality switch that resolves to the same
  // height (e.g. 1440p requested but only 1080p exists) skips the pointless
  // reload instead of stuttering back to the same picture.
  const currentTrailerHeightRef = useRef<number>(0);
  // Guards the "Watch Trailer" button against spam-clicks: the yt-dlp resolve
  // takes 1-3 s, during which the DetailView button is still clickable.
  const trailerLaunchingRef = useRef(false);

  // ── Playback hook — gated on activeTarget so the polling fallback only
  //     runs while a stream is loaded.
  const {
    time, duration, paused, volume, speed, buffering, bufferPct, seekLoading, firstFrameSeen,
    streamBroken, setStreamBroken,
    togglePause, seekRelative, seekAbsolute, commitVolume, commitSpeed,
    notifyNewLoad, logLoadEvent,
    watchedElapsedRef,
    positionOwnedRef,
    streamTruncated, streamTruncatedRef, lastSanePosRef,
    truncatedRunout, cacheEndRef,
  } = usePlayback(isPlayerActive);

  /** `time`, but only when it is known to belong to the file currently loaded
   *  - null during a load, before mpv has confirmed the new file is open.
   *
   *  EVERY "where should I resume from" decision must go through this. Read
   *  raw, `time` can still be holding the PREVIOUS episode's playhead (see
   *  positionOwnedRef), which is how a retry of a failed episode advance
   *  resumed an unwatched episode at 91% and dropped the viewer on its end
   *  card. There were three independent copies of the raw read; one helper so
   *  a fourth cannot drift in.
   *
   *  It also applies the TRUNCATION rule, for the same "one place" reason. On
   *  a stream whose origin dropped the body, mpv's keep-open
   *  `seek_to_last_frame()` parks `time-pos` at `duration`, so a resume built
   *  on the live playhead restarts the title at its end. `lastSanePosRef` is
   *  the last position observed while the data was real. Keeping this inside
   *  the helper is what stops the rule from being applied at three of the four
   *  resume sites and forgotten at the fourth (the source switcher). */
  const ownedTime = useCallback(
    () => (positionOwnedRef.current
      ? (streamTruncatedRef.current ? lastSanePosRef.current : time)
      : null),
    [positionOwnedRef, streamTruncatedRef, lastSanePosRef, time],
  );

  // ── Watch-Together ──────────────────────────────────────────────────────
  // Refs the playback bridge reads, so the bridge is registered ONCE and never
  // captures a stale closure. The bridge drives local playback only through
  // the existing seek/pause controls (raw → no re-broadcast). See
  // src/watchTogether/. The broadcast-wrapped controls below are what the
  // on-screen controls + keybindings call (NOT programmatic/internal pauses).
  const wtTimeRef = useRef(time); wtTimeRef.current = time;
  const wtPausedRef = useRef(paused); wtPausedRef.current = paused;
  const wtSpeedRef = useRef(speed); wtSpeedRef.current = speed;
  const wtTargetRef = useRef(activeTarget); wtTargetRef.current = activeTarget;
  const wtSeekRef = useRef(seekAbsolute); wtSeekRef.current = seekAbsolute;
  const wtTogglePauseRef = useRef(togglePause); wtTogglePauseRef.current = togglePause;
  // RAW speed setter for the bridge's remote-apply path (sets the engine speed
  // WITHOUT broadcasting — apply() is applying, not originating).
  const wtCommitSpeedRef = useRef(commitSpeed); wtCommitSpeedRef.current = commitSpeed;
  /** The position to tell the party we are at.
   *
   *  While a load is in flight `time` is 0 (see positionOwnedRef), and 0 is a
   *  catastrophic thing to broadcast: an in-sync follower reads it as a
   *  twenty-minute backward drift and seeks the whole room to 00:00.
   *  `lastStartSecondsRef` is the right stand-in because it is the offset the
   *  IN-FLIGHT load was issued with, i.e. where this player is about to be -
   *  0 for a fresh episode (correct), the pre-swap playhead for a source swap
   *  (correct), the break point for a retry (correct).
   *
   *  Distinct from the leader TICK, which skips entirely while loading
   *  (`LocalPlayback.loading`): a tick is an unprompted "here is my playhead"
   *  and we have none, whereas a control frame is the user doing something and
   *  must carry both the action and a position the room can trust.
   *
   *  Reads REFS, never `time`, so it is stable for the lifetime of the
   *  component. Built on `ownedTime()` first, it inherited that callback's
   *  per-tick identity and made every control it is a dep of churn ~30x/sec -
   *  which re-subscribed the `smtc-event` listener (whose effect deps include
   *  wtTogglePause) at the same rate, with a listener-less gap on each pass. */
  const wtPosition = useCallback(
    () => {
      if (!positionOwnedRef.current) return lastStartSecondsRef.current ?? 0;
      // Same truncation rule as ownedTime(), and for a louder reason: this
      // value is BROADCAST. mpv's keep-open `seek_to_last_frame()` parks the
      // playhead at `duration` on a dropped stream, so a leader whose source
      // cut out would seek every in-sync member of the room to the end of the
      // episode. Refs only, so the callback identity stays stable.
      if (streamTruncatedRef.current) {
        return lastSanePosRef.current ?? wtTimeRef.current;
      }
      return wtTimeRef.current;
    },
    [positionOwnedRef, streamTruncatedRef, lastSanePosRef],
  );
  // `togglePause` is a relative, fire-and-forget command and the observed
  // `paused`/`wtPausedRef` only update on the next MPV event — so a remote
  // apply that toggles against the lagging ref can desync when two control
  // frames land inside the event round-trip. Track the INTENDED pause state,
  // updated SYNCHRONOUSLY on every command, and reconcile it from the real
  // state when that actually changes.
  const wtIntendedPausedRef = useRef(paused);
  useEffect(() => { wtIntendedPausedRef.current = paused; }, [paused]);
  // The leader's chosen stream (label + match key), stashed in handlePlayStream
  // so the bridge can broadcast it to the party.
  const wtStreamRef = useRef<{ label: string | null; key: string | null }>({ label: null, key: null });
  // Set when the leader starts a party stream — staging is armed once the
  // first frame lands (see the effect below).
  const wtPendingStageRef = useRef(false);
  const reactiveParty = useWatchTogether();
  // Tell Rust whether we're an in-sync party MEMBER (leader OR follower), so the
  // pause-on-minimise and minimize-to-tray paths SKIP the pause for us and we
  // keep playing while hidden — staying in sync with the party. A paused follower
  // desyncs (drift ticks can't resume it); a paused leader falls behind the
  // still-playing room and snaps everyone back on restore (and stops ticking).
  // User-chosen policy: both roles keep playing while minimized.
  const partyKeepAlive =
    reactiveParty.status === "connected" && reactiveParty.inSync;
  useEffect(() => {
    invoke("set_party_keep_alive", { active: partyKeepAlive }).catch(() => {});
  }, [partyKeepAlive]);
  // Leave any watch party when the signed-in identity CHANGES (sign-out or
  // account switch). Otherwise the party WebSocket + our cid survive into the
  // next account — leaking the old identity (and its leader crown) into a fresh
  // session. Fires only on a real identity change (not initial login), and is a
  // no-op when not in a party. Covers every logout path via the one `session`
  // signal rather than patching each call site.
  const prevAuthKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const key = session?.auth_key ?? null;
    const prev = prevAuthKeyRef.current;
    prevAuthKeyRef.current = key;
    if (prev !== null && prev !== key && getWatchState().status !== "idle") {
      leaveRoom();
    }
  }, [session]);
  useEffect(() => {
    setPlaybackBridge({
      getLocal: () => {
        // Live TV / trailers NEVER participate in the party: report a null
        // videoKey so the party can't sync/establish/stage on them (sync is
        // keyed on videoKey agreement, so a null key cascades through every
        // gate). A trailer is a private side-trip — it must not hijack the room.
        const t = wtTargetRef.current;
        const isLive =
          t != null &&
          (t.media_type === "tv" || t.id.startsWith("iptv:") || t.id.startsWith("trailer:"));
        return {
          paused: wtPausedRef.current,
          // Safe to call here even though this bridge is registered ONCE:
          // wtPosition reads refs only, so it never freezes a stale `time`.
          position: wtPosition(),
          // Tell the store that position may be a projection, not a playhead:
          // it is where this load is about to land, which is the right thing
          // for a control frame to carry but NOT something to tick at the room
          // unprompted. The leader timer skips on this.
          loading: !positionOwnedRef.current,
          speed: wtSpeedRef.current,
          videoKey: isLive ? null : (t?.id ?? null),
          metaId: isLive ? null : (t?.series_id ?? t?.id ?? null),
          mediaType: isLive ? null : (t?.media_type ?? null),
          title: isLive ? null : (t?.name ?? null),
          streamLabel: isLive ? null : wtStreamRef.current.label,
          streamKey: isLive ? null : wtStreamRef.current.key,
        };
      },
      apply: (remotePaused: boolean, position: number, speed: number) => {
        if (Math.abs(wtTimeRef.current - position) > 0.4) wtSeekRef.current(position);
        if (wtIntendedPausedRef.current !== remotePaused) {
          wtTogglePauseRef.current();
          wtIntendedPausedRef.current = remotePaused;
        }
        // Match the leader's speed so we don't outpace/lag them and re-seek
        // forever. RAW setter (no re-broadcast). Guard + epsilon avoid a
        // redundant set_speed every drift tick.
        if (Number.isFinite(speed) && speed > 0 && Math.abs(wtSpeedRef.current - speed) > 0.01) {
          wtSpeedRef.current = speed;
          wtCommitSpeedRef.current(speed);
        }
      },
      openVideo: ({ metaId, mediaType, videoKey, title }) => {
        // Land the member directly on the title's stream picker. Drop any
        // active playback target first — DetailView only mounts when
        // selectedMeta is set AND the player is inactive, so a member who's
        // already watching something must leave that first or the Join no-ops.
        setActiveTarget(null);
        setSelectedRect(null);
        setSelectedMeta({
          id: metaId, name: title ?? "", media_type: mediaType ?? "movie",
          poster: null, background: null, fanart: null, backdrop: null,
          logo: null, release_info: null, description: null, imdb_rating: null, genres: [],
        });
        if (videoKey) setLastPlayedEpisodeId(videoKey);
        setOpenInStreamsMode(true);
        setWatchPanelOpen(false);
      },
    });
    return () => setPlaybackBridge(null);
  }, []);
  // Stage the leader's stream once it's actually showing (pause + tell the
  // party). Pausing on the first frame rather than at load avoids racing the
  // loadfile critical section.
  useEffect(() => {
    if (!firstFrameSeen) return;
    if (wtPendingStageRef.current) {
      // Leader establishing a NEW party stream — pause + stage it for the party.
      wtPendingStageRef.current = false;
      if (!wtIntendedPausedRef.current) {
        togglePause();
        wtIntendedPausedRef.current = true;
      }
      startPartyStream();
    } else {
      // A member who just joined the party's title — now that the stream has a
      // decodable frame, snap to the room's live state (pause if staging, or
      // seek to the current play-head). No-op unless we're in sync.
      resyncToRoom();
    }
  }, [firstFrameSeen]);
  // While the party is staging AND we're on the staged title, normal
  // play/pause/seek must NOT override the "Start now" hold — only wtStartParty
  // (the host's "Start now" / the auto-start) releases it. A member off watching
  // something else (not in sync) keeps full control. Reads live module state so
  // it's always fresh (no stale-closure dep needed).
  const wtStagedHold = useCallback(() => {
    const w = getWatchState();
    return w.staging && w.inSync;
  }, []);
  // A NON-leader in sync with the party is locked out of transport entirely —
  // the leader controls playback. Suppress the LOCAL action too (not just the
  // broadcast, which notifyLocalControl already drops) so a follower can't
  // desync themselves via a button / keybinding / video click. A follower
  // watching something else (not in sync) keeps full control of their own
  // playback.
  const wtFollowerLocked = useCallback(() => {
    const w = getWatchState();
    return w.status === "connected" && !w.isLeader && w.inSync;
  }, []);
  const wtTogglePause = useCallback(() => {
    if (wtStagedHold() || wtFollowerLocked()) return;
    const next = !wtIntendedPausedRef.current;
    togglePause();
    wtIntendedPausedRef.current = next;
    notifyLocalControl({ paused: next, position: wtPosition() });
  }, [togglePause, wtStagedHold, wtFollowerLocked, wtPosition]);
  const wtSeekAbsolute = useCallback((t: number) => {
    if (wtStagedHold() || wtFollowerLocked()) return;
    seekAbsolute(t);
    notifyLocalControl({ paused: wtIntendedPausedRef.current, position: t });
  }, [seekAbsolute, wtStagedHold, wtFollowerLocked]);
  const wtSeekRelative = useCallback((d: number) => {
    if (wtStagedHold() || wtFollowerLocked()) return;
    seekRelative(d);
    notifyLocalControl({ paused: wtIntendedPausedRef.current, position: wtPosition() + d });
  }, [seekRelative, wtStagedHold, wtFollowerLocked, wtPosition]);
  // Playback-speed change. A follower is locked out (the leader controls
  // playback); the leader broadcasts the new speed so everyone matches it —
  // otherwise followers stay at 1x and constantly re-seek to chase the host.
  const wtCommitSpeed = useCallback((s: number) => {
    if (wtFollowerLocked()) return;
    commitSpeed(s);
    wtSpeedRef.current = s;
    notifyLocalControl({ paused: wtIntendedPausedRef.current, position: wtPosition(), speed: s });
  }, [commitSpeed, wtFollowerLocked, wtPosition]);
  // Start the party (unpause + clear staging) — the leader's "Start now"
  // override, also called by the auto-start effect once everyone's ready.
  // Bypasses the staging gate above (we're the one releasing it): clears
  // localStaging first, then unpauses RAW + broadcasts play (broadcastControl
  // recomputes staging=false now that localStaging is off).
  const wtStartParty = useCallback(() => {
    setLocalStaging(false);
    if (wtIntendedPausedRef.current) {
      togglePause();
      wtIntendedPausedRef.current = false;
    }
    notifyLocalControl({ paused: false, position: wtPosition() });
  }, [togglePause, wtPosition]);
  // NB: NO auto-start. Even once every member is on the party's stream, playback
  // stays staged (paused) until the HOST presses "Start now" (wtStartParty, the
  // PlayerPartyHud onStart). This is deliberate — the leader controls the start.
  // Tell the room what we're watching whenever the active title changes (so
  // presence + sync-gating stay current). Fires after the ref updates.
  useEffect(() => {
    notifyLocalVideo();
  }, [activeTarget?.id]);
  // Open the room panel from PlayerOverlay's More menu.
  const [watchPanelOpen, setWatchPanelOpen] = useState(false);
  useEffect(() => {
    const open = () => setWatchPanelOpen(true);
    window.addEventListener("aura:open-watch-together", open);
    return () => window.removeEventListener("aura:open-watch-together", open);
  }, []);

  // ── Detail-view state (selected meta + click-rect for shared-element open) ──
  // Restored from the session route on reload (no rect → opens without the
  // shared-element zoom, which is correct: there's no originating card).
  const [selectedMeta, setSelectedMeta] = useState<MetaPreview | null>(
    () => loadSessionRoute()?.detail ?? null,
  );
  const [selectedRect, setSelectedRect] = useState<DOMRect | null>(null);

  // Persist the browse route (active tab + open detail) on every change so a
  // webview reload can restore it. Cheap — a small JSON write to sessionStorage.
  useEffect(() => {
    saveSessionRoute({ view: activeView, detail: selectedMeta });
  }, [activeView, selectedMeta]);

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

  /** Dismiss the detail page. There is no navigation trail to unwind: a Related
   *  tile searches for the title it names rather than opening it in place, so
   *  the detail page is only ever one level deep. */
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
        /** Explicit art (Live TV passes the channel logo); preferred over the
         *  selectedMeta / library lookup below. */
        logo?: string | null;
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
      // In-player source switcher: when `forceStartSeconds` is set, bypass the
      // resume prompt and (re-)load the picked stream at this live position —
      // a swap-in-place. Everything else (resolve, preheat, post-load setup)
      // runs unchanged. See src/SourceSwitcher.tsx.
      // `proxyUrl`: per-playlist Live TV forward proxy (mpv http-proxy); null/
      // undefined plays direct (and clears any proxy left by a prior stream).
      opts?: { forceStartSeconds?: number; proxyUrl?: string | null; audioFileUrl?: string | null },
    ) => {
      try {
        if (!stream.url && !stream.info_hash) return;
        // Live TV (and trailer) carve-out, computed from `target`
        // (isLivePlayback derives from activeTarget, which isn't set yet
        // mid-load). A live channel has no byte-range CDN edge to preheat and
        // no useful scrubber thumbnails, and both open an EXTRA upstream
        // connection — wasteful, and costly against a provider's simultaneous-
        // stream cap. A trailer is short and its scrubber is suppressed, so it
        // needs neither preheat nor the thumbnail extractor (which can't
        // range-probe a googlevideo CDN URL reliably).
        const isLiveTarget =
          target.media_type === "tv" ||
          target.id.startsWith("iptv:") ||
          target.id.startsWith("trailer:");
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
        // A non-host party member opening the party's own stream skips the
        // "Resume where you left off" prompt entirely and lands at the party's
        // synced position (resyncToRoom fine-tunes on the first decoded frame).
        // It's treated exactly like a forced start, so the resume computation
        // below is skipped. `getPartyStartPosition()` is the extrapolated room
        // position; 0 if not known yet (resyncToRoom corrects post-load).
        const wtState = getWatchState();
        const isPartyFollowerJoin =
          wtState.status === "connected" && !wtState.isLeader &&
          wtState.roomVideoKey != null && wtState.roomVideoKey === target.id;
        const forceStart: number | null =
          opts?.forceStartSeconds ?? (isPartyFollowerJoin ? (getPartyStartPosition() ?? 0) : null);
        // A source swap / party-follower-join forces resume at a specific
        // position (below), so skip the resume-prompt computation entirely —
        // leaving resumeSeconds null means the prompt never shows.
        if (libRow && forceStart == null) {
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

        // In-player source swap OR party-follower-join: force resume at the
        // chosen position (the resume-prompt computation was skipped above).
        if (forceStart != null) {
          resumeAt = forceStart;
        }

        // ── Watch-Together: remember which stream this is (for broadcasting to
        // the party), and if the leader is starting a NEW party stream, arm
        // staging so it holds for the rest of the party once it's playing.
        //
        // Deliberately AFTER the resume-prompt abort above. Arming before it
        // left the flag (and the stream label) set for a stream that was never
        // loaded, so the next reload that bypasses handlePlayStream (EOS
        // Replay, live auto-retry) consumed the stale arming on its first frame
        // and re-staged the entire party at position 0 on the wrong stream.
        // Re-reading the room state here is also strictly more correct: the
        // room may have moved while the prompt was up.
        wtStreamRef.current = { label: streamLabel(stream), key: streamMatchKey(stream) };
        {
          const party = getWatchState();
          // Live TV and trailers are excluded from the party entirely: never
          // stage on them. A trailer is a private side-trip; it must not hijack
          // the room (mirrors the null videoKey in the party bridge's getLocal).
          const isLive =
            target.media_type === "tv" ||
            target.id.startsWith("iptv:") ||
            target.id.startsWith("trailer:");
          const establishingParty =
            !isLive && party.status === "connected" && party.isLeader && target.id !== party.roomVideoKey;
          wtPendingStageRef.current = establishingParty;
        }

        const raw = stream.url ?? `magnet:?xt=urn:btih:${stream.info_hash}`;
        // Reset playback state BEFORE load_video so the loading overlay
        // covers the entire window between user click and first frame.
        // notifyNewLoad ALSO arms the load-timing log; subsequent
        // logLoadEvent calls emit `[load] +Xms` lines so the user can
        // see exactly which phase is slow when a stream hangs at
        // "Loading… N%".
        //
        // Stamped BEFORE notifyNewLoad, not next to the load_video call below.
        // notifyNewLoad closes the position seal, and for as long as it is
        // closed this ref IS the answer to "where is the local player" for the
        // resume paths and the party. Stamping it after the awaited
        // resolve_stream left it describing the PREVIOUS load for that whole
        // window. `resumeAt` is final from the forceStart branch above and
        // nothing between here and load_video touches it.
        lastStartSecondsRef.current = resumeAt ?? null;
        notifyNewLoad();
        const t0resolve = Date.now();
        // Per-playlist Live TV proxy: viaProxy bypasses the local bridge so mpv
        // reaches the origin directly, then load_video applies the proxy as a
        // PER-FILE http-proxy option (auto-scoped to this load).
        const resolved = await invoke<string>("resolve_stream", {
          rawUrl: raw,
          viaProxy: !!opts?.proxyUrl,
        });
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
        if (!isLiveTarget && (resolved.startsWith("https://") || (resolved.startsWith("http://") && !resolved.startsWith("http://127.0.0.1:")))) {
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

        // HDR-content hint from the stream NAME (addon-supplied labels —
        // "HDR", "DV", "DV+HDR"). Drives the engine's per-load output
        // routing under hdr_mode=passthrough: only HDR-labelled content
        // gets the PQ swapchain path; SDR streams render exactly as
        // passthrough-off. parseStream never throws in practice but the
        // guard keeps a malformed entry from killing playback.
        const contentHdrHint = (() => {
          try { return parseStream(stream).hdr != null; } catch { return false; }
        })();
        lastHdrHintRef.current = contentHdrHint;
        lastProxyUrlRef.current = opts?.proxyUrl ?? null;
        lastAudioUrlRef.current = opts?.audioFileUrl ?? null;

        const t0load = Date.now();
        await invoke("load_video", {
          path:           resolved,
          // resumeAt is null when the user picked "Start over" or the
          // saved offset didn't meet the prompt threshold. mpv treats
          // a missing start_seconds as 0 (play from the beginning).
          startSeconds:   resumeAt ?? null,
          httpProxy:      opts?.proxyUrl ?? null,
          contentHdrHint,
          // External DASH audio for 1080p+ trailers; null for every normal
          // stream (which clears any stale `audio-files` value in the engine).
          audioUrl:       opts?.audioFileUrl ?? null,
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
        // Robust anime detection: series episodes key their signals at the
        // SERIES ROOT (id-prefix / genres / cache), and `target.id` is the
        // EPISODE id, so we resolve series_id + feed the library item's
        // genres. Drives both the Japanese-first audio/sub defaults AND the
        // motion-interpolation gate (interp is anime-only), so they stay
        // consistent with the in-player toggle's `isAnime`.
        const animeFlag = activeTargetIsAnime(target, libraryRef.current);
        setTimeout(() => {
          invoke("apply_lang_defaults", { isAnime: animeFlag }).catch(() => {});
          // Re-push the user's subtitle styling so a freshly-loaded
          // file inherits the saved size / colour / position / etc. This
          // re-applies the SAVED sub-pos baseline, which clobbers any
          // control-bar lift PlayerOverlay applied first; the event lets the
          // overlay re-assert the lift right after.
          invoke("apply_subtitle_style")
            .catch(() => {})
            .finally(() => window.dispatchEvent(new Event("aura:subtitle-style-applied")));
          // Loudness normalization is NOT re-applied per load anymore:
          // the `af` property persists across loadfiles, the engine
          // installs the filter at mpv init from the persisted setting,
          // and the toggles (Settings / three-dots menu) handle live
          // changes. The old per-load remove+add raced slow stream
          // opens — the filter sat in the property without rebuilding
          // the already-initialised audio chain until a seek forced it,
          // i.e. "volume is wrong until I seek once".
          const { motionInterpolation, interpolationTscale } = loadAuraSettings();
          // Re-apply the persisted motion-interpolation setting on every
          // load — unlike loudnorm this one IS load-dependent (the
          // anime-only gate means it must flip per title). Issued inside
          // this +1500 ms post-load gate so it never touches libmpv
          // during the loadfile critical section (landmine #3).
          invoke("set_motion_interpolation", {
            enabled: !!motionInterpolation && animeFlag,
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
          if (stream.url && !isLiveTarget) {
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
          // Claim this load's token BEFORE the first await. Every stamp below
          // is gated on still owning it, so a chain whose file has already
          // been replaced resolves into a no-op instead of writing the
          // previous episode's OP/ED windows onto the current one.
          skipChainSeqRef.current += 1;
          const skipSeq = skipChainSeqRef.current;
          const stale = () => skipChainSeqRef.current !== skipSeq;
          // The ED start belongs to the FILE, not to the target id. The
          // next-up reset effect is keyed on `activeTarget?.id` on purpose (see
          // its comment), so an EOS Replay, a recovery reload or an in-player
          // source switch all re-run loadfile without clearing it and the
          // previous release's credits position would keep timing the card.
          // The load token is the right lifetime, so clear it here.
          nextUpEdStartRef.current = null;
          (async () => {
            // Reset first so non-anime / no-data cases don't leave
            // stale windows from the previous load.
            try { await invoke("set_skip_windows", { payload: { windows: [] } }); } catch {}

            // Skip windows are a SERIES concept (anime via AniSkip +
            // chapters; live-action via chapters / the positional
            // heuristic). Movies and live-TV have no OP/ED structure.
            const mtLower = (target.media_type ?? "").toLowerCase();
            if (mtLower === "movie" || mtLower === "channel" || mtLower === "channels" || mtLower === "tv" || mtLower === "trailer") {
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
              console.info(`[auraskip] skip — all modes off`);
              return;
            }
            // Modes are read through a REF, not captured. This chain now spans
            // the whole chapter poll (and a silencedetect pass after it), and
            // the AniSkip menu's mode pills are reachable that entire time. A
            // snapshot meant `restampSkipModes` applied the user's change to
            // the cached payload and the chain's own stamp then silently
            // reverted it. Both writers read the same ref, so the last write
            // wins with the CURRENT settings either way.
            skipModesRef.current = { op: opMode, ed: edMode, recap: recapMode };
            const modeFor = (kind: string): "off" | "prompt" | "auto" => {
              const m = skipModesRef.current;
              return kind === "op" || kind === "mixed-op" ? m.op
                : kind === "ed"    ? m.ed
                : kind === "recap" ? m.recap
                : "off";
            };

            // Tail used by EVERY exit below: stamp any AniSkip windows
            // (empty for live-action / AniSkip-miss), then ALWAYS run
            // the chapter augment so titled chapters + the positional
            // heuristic still produce skip windows, then surface the
            // ED start for the Next-Up CTA. This is what extends skip
            // from anime-only to any series.
            const finishWithChapters = async (
              prepared: PreparedWindow[],
              opts?: {
                silenceUrl?: string | null;
                /** Set on the anime path only - lets the ED/OP gap be filled
                 *  from this series' OTHER episodes before any ffmpeg runs. */
                malId?: number | null;
                episodeNum?: number | null;
                treatMixed?: boolean;
              },
            ): Promise<void> => {
              try {
                // ONE stamp per load, and it happens inside
                // mergeChapterSkipWindows. There used to be a pre-merge stamp
                // of `prepared` here, and it was live for the seconds the
                // chapter poll takes - long enough to auto-seek against a
                // window a higher-trust source was about to discard. Hell's
                // Paradise S02E06: AniSkip's op 0-158 s was stamped at t+0.6 s,
                // SkipController's `ready` gate (duration > 0) opened at t+4.5 s
                // with the playhead still at 0 and auto-skipped to 2:38, and the
                // chapter merge replaced that window 112 ms later. The user was
                // yanked past a 59 s cold open by a window the UI never showed.
                // Publishing only the final list makes displayed == skipped by
                // construction. The stamp it replaced was also the one write in
                // this chain with no `stale()` guard, so a slow chain could put
                // the previous episode's windows on the current file.
                //
                // Cost: auto-skip waits for the chapter poll to settle. Both
                // of its exits key on the demuxer having parsed headers, which
                // is the same event that opens SkipController's `ready` gate:
                // a chaptered file settles within one 600 ms tick of it, a
                // chapterless one within CONFIRM_EMPTY_READS ticks (~1.8 s),
                // and the hard ceiling is the poll's own 10 x 600 ms. So the
                // worst case is a couple of seconds of opening before the
                // seek, against the old worst case of instantly seeking to
                // the wrong place.
                // Theme songs for this cour, fetched at most once per load and
                // only for anime (`opts.malId` is set on the anime path only,
                // so live action never pays for it). It rides the cached
                // /anime/{id}/full the ratings aggregator already fetches, so
                // it is usually free. This runs on the async chain, never on
                // the mpv engine thread.
                let themes: AnimeThemes | null = null;
                let themesFetched = false;
                const ensureThemes = async (): Promise<AnimeThemes | null> => {
                  if (themesFetched) return themes;
                  themesFetched = true;
                  if (!opts?.malId) return null;
                  try {
                    themes = await invoke<AnimeThemes | null>(
                      "fetch_anime_themes", { malId: opts.malId },
                    );
                  } catch {
                    themes = null;
                  }
                  return themes;
                };
                // Passed INTO the merge so the song names ride the one stamp.
                // They used to be applied only in `republish` below, which was
                // wrong in a way that made the feature look like it worked:
                // all three republish call sites are gated on a MISSING window
                // (neighbour fill, silencedetect OP, outro scan), so an episode
                // where AniSkip supplied both an OP and an in-band ED reached
                // none of them and never got a name. The feature was live only
                // where the skip data was WORST.
                const nameSongs = async (
                  windows: PreparedWindow[],
                ): Promise<PreparedWindow[]> => {
                  if (!opts?.malId) return windows;
                  return stampThemeSongs(
                    windows, await ensureThemes(), opts?.episodeNum ?? null,
                  );
                };
                // Warm it NOW, concurrently with the chapter poll, rather than
                // letting `nameSongs` be the first caller. That await sits
                // directly in front of the one `set_skip_windows` write, and
                // that write is what arms auto-skip, so a cold fetch there
                // would push the skip later by a whole round-trip for no
                // reason. The chapter poll takes ~0.6-6 s and this is a cached
                // lookup, so by the time publish runs it has almost always
                // already resolved. Fire-and-forget: `ensureThemes` memoises
                // and swallows its own errors, and nothing downstream needs
                // this promise.
                void ensureThemes();

                // `published` is the list currently stamped on the file. Every
                // later writer below extends THIS, never `merged`: the ED
                // fallback used to be the only other writer and it did not
                // stamp at all, so rebuilding from the merge result was
                // harmless. Now that both fallbacks stamp, building either
                // from the pre-fallback list would silently drop the other's
                // window.
                let published = await mergeChapterSkipWindows(
                  prepared, modeFor, stale, nameSongs,
                );
                if (stale()) return;
                // The container duration, which the chapter poll has already
                // waited for. Needed to decide whether an ED window sits in the
                // plausible outro band, and to give an inferred ED an END.
                let fileDuration = 0;
                try {
                  fileDuration = (await invoke<number | null>(
                    "get_property", { name: "duration", format: "double" },
                  )) ?? 0;
                } catch {}
                if (stale()) return;
                // Publish + report in one place so every writer below leaves
                // the same trace, and `published` can never drift from what is
                // actually stamped.
                // Every writer below is on the far side of a network call or an
                // ffmpeg pass, so the stale check belongs HERE rather than at
                // each call site: one place that cannot be forgotten, and the
                // one thing this chain must never do is stamp the previous
                // episode's windows onto the current file.
                const republish = async (
                  next: PreparedWindow[], note: string,
                ): Promise<void> => {
                  if (stale()) return;
                  const songs = await ensureThemes();
                  if (stale()) return;
                  const windows = stampThemeSongs(
                    applySkipModes(dedupeSkipWindows(next), modeFor),
                    songs,
                    opts?.episodeNum ?? null,
                  );
                  await invoke("set_skip_windows", { payload: { windows } });
                  published = windows;
                  // Report what is now STAMPED, not what was handed in: dedupe
                  // can drop the very window the note is announcing, and a log
                  // line claiming a window the scrubber is not drawing is the
                  // same class of mismatch this whole chain exists to remove.
                  console.info(
                    `[auraskip] ${note} | now: ` + (windows.length === 0
                      ? "no windows"
                      : windows.map((w) =>
                          `${w.type} ${Math.round(w.start)}-${Math.round(w.end)}s `
                          + `${w.source}${w.auto ? " auto" : " prompt"}`).join(", ")),
                  );
                };
                // Start of the ending → precisely-timed Next-Up CTA. Re-derived
                // after every writer below, so the card is always timed off a
                // window the scrubber is actually drawing.
                let edStart = edTriggerStart(published, fileDuration);
                const announceEd = (): void => {
                  const next = edTriggerStart(published, fileDuration);
                  if (next == null || next === edStart) return;
                  edStart = next;
                  window.dispatchEvent(new CustomEvent<number>("aura:ed-start-time", { detail: next }));
                };
                if (edStart != null) {
                  window.dispatchEvent(new CustomEvent<number>("aura:ed-start-time", {
                    detail: edStart,
                  }));
                }

                // ── Gap fill #1: this series' OTHER episodes ──
                // AniSkip coverage is per-episode and patchy (Hell's Paradise
                // S02 has an ED on 6 of 13 episodes), but an ending does not
                // move between episodes of one cour. Borrowing the neighbours'
                // median is both more accurate and far cheaper than the ffmpeg
                // passes below, so it runs FIRST and can spare them entirely.
                // Prompt-only by construction (`aniskip-neighbour` is in
                // GUESS_SKIP_SOURCES) and drawn on the scrubber like anything
                // else, so the inference is visible rather than implied.
                if (
                  opts?.malId != null && opts?.episodeNum != null
                  && fileDuration > 0
                  && (edStart == null || !published.some((w) => w.type === "op" || w.type === "mixed-op"))
                ) {
                  try {
                    const profile = await invoke<{
                      found: boolean;
                      windows: { kind: string; start: number; end: number; source: string }[];
                      note: string;
                    }>("fetch_neighbour_skip_profile", {
                      malId: opts.malId,
                      episode: opts.episodeNum,
                      duration: fileDuration,
                      treatMixedOpAsOp: opts.treatMixed ?? true,
                    });
                    if (stale()) return;
                    const fill = profile.windows
                      .filter((w) => modeFor(w.kind) !== "off")
                      // Only fill genuine gaps: a window this file already has
                      // from a source that describes THIS episode always wins.
                      .filter((w) => (w.kind === "ed"
                        ? edStart == null
                        : !published.some((p) => p.type === "op" || p.type === "mixed-op")))
                      // An inferred ED still has to land in the outro band.
                      .filter((w) => w.kind !== "ed"
                        || (fileDuration - w.start >= ED_TAIL_MIN_SECONDS
                          && fileDuration - w.start <= ED_TAIL_MAX_SECONDS))
                      .map((w): PreparedWindow => ({
                        type: w.kind, start: w.start, end: Math.min(w.end, fileDuration),
                        source: w.source, auto: false,
                      }));
                    if (fill.length > 0) {
                      await republish(
                        [...published, ...fill],
                        `neighbour profile → ${fill.map((w) => `${w.type} ${Math.round(w.start)}-${Math.round(w.end)}s`).join(", ")} (${profile.note})`,
                      );
                      announceEd();
                    } else {
                      console.info(`[auraskip] neighbour profile: nothing usable (${profile.note})`);
                    }
                  } catch (e) {
                    console.warn(`[auraskip] neighbour profile failed: ${String(e)}`);
                  }
                }
                // Hybrid-mode auto OP fallback. Every series path passes
                // `silenceUrl` (anime AND live-action): when NOTHING upstream
                // produced an OP (no AniSkip data AND no titled/heuristic
                // chapter OP), one bounded ffmpeg silencedetect pass infers the
                // OP->dialogue boundary. Prompt-mode (auto:false): never
                // auto-seek a guess. ffmpeg is ensured just below.
                const url = opts?.silenceUrl ?? null;
                const hasOp = published.some((w) => w.type === "op" || w.type === "mixed-op");
                // Automatic skip detection (replaces the old manual "Detect Skip"
                // button). When AniSkip + chapters miss the OP and/or the ED, a
                // bounded ffmpeg silencedetect pass infers ONLY the missing
                // segment (OP scan when no OP; ED tail-scan when no ED). ffmpeg is
                // an on-demand dep, so ensure it ONCE (a one-time ~97 MB download
                // with a toast) before either pass runs, otherwise the fallback
                // silently no-ops for anyone who never fetched ffmpeg. Gated by
                // the autoSkipDetect setting (default on).
                const autoDetect = loadAuraSettings().autoSkipDetect !== false;
                // Must mirror the two branch conditions below exactly, or the
                // one-time ~97 MB download gets pulled for a pass that then
                // does not run. The ED branch additionally needs a container
                // duration, since that is what bounds its scan.
                const willDetect = autoDetect && url != null
                  && ((!hasOp && modeFor("op") !== "off")
                    || (edStart == null && fileDuration > 0 && modeFor("ed") !== "off"));
                if (willDetect && !(await runtimeDepPresent("ffmpeg.exe").catch(() => false))) {
                  window.dispatchEvent(new CustomEvent("aura:player-toast", {
                    detail: { message: "Setting up automatic skip detection (one-time FFmpeg download)" },
                  }));
                  try {
                    await ensureRuntimeDep("ffmpeg.exe");
                  } catch {
                    // Couldn't fetch it: the detect calls below no-op cleanly.
                  }
                }
                if (autoDetect && url && !hasOp && modeFor("op") !== "off") {
                  try {
                    // Parallel, early-exit OP scan (Rust silencedetect).
                    // Splits the first ~10 min into overlapping chunks, fans
                    // out audio-only ffmpeg passes (bounded concurrency) and
                    // returns the inferred OP / title-sequence window. This
                    // replaces the old single 180 s pass + JS "dominant
                    // silence in 30-180 s, OP-always-from-0" heuristic, which
                    // could neither REACH nor REPRESENT a title card that
                    // only lands 5-6 min in (e.g. The Punisher's cold-open-
                    // then-credits structure). The window is stamped
                    // auto:false (a detected guess never auto-seeks — Lua
                    // shows an ignorable "Press X to skip" prompt instead),
                    // so a wrong guess can't yank real content.
                    const sd = await invoke<{
                      available: boolean;
                      intervals: { start: number; end: number; duration: number }[];
                      op_window: { start: number; end: number } | null;
                      note: string;
                    }>("detect_silence_intervals", { url, maxSecs: 600 });
                    if (stale()) return;
                    if (sd.available && sd.op_window) {
                      const opWin: PreparedWindow = {
                        type: "op",
                        start: Math.max(0, sd.op_window.start),
                        end: sd.op_window.end,
                        source: "silencedetect",
                        auto: false,
                      };
                      // MERGE (not replace) so chapter ED windows already
                      // stamped above survive. Modes are re-applied for the
                      // same reason publish() does it: this write can land a
                      // long way (an ffmpeg fetch + a 600 s scan) after the
                      // modes were read.
                      await republish(
                        [...published, opWin],
                        `silencedetect → OP ${Math.round(opWin.start)}-${Math.round(opWin.end)}s (${sd.note})`,
                      );
                    } else if (sd.available) {
                      console.info(`[auraskip] silencedetect: no OP boundary (${sd.note})`);
                    } else {
                      console.info(`[auraskip] silencedetect unavailable (ffmpeg not on PATH)`);
                    }
                  } catch (e) {
                    console.warn(`[auraskip] silencedetect scan failed: ${String(e)}`);
                  }
                }
                // Hybrid-mode ED fallback, and the LAST resort. When nothing
                // above produced an ending - no AniSkip ED, no titled or
                // heuristic chapter ED, no usable neighbour - tail-scan the
                // stream's last few minutes for the credits boundary (one
                // bounded ffmpeg pass, blackdetect + silencedetect, NO 90x scan).
                //
                // Its result is now STAMPED as a prompt-only window instead of
                // only timing the Next-Up card. The old behaviour is what the
                // Hell's Paradise S02E11 report came down to: a boundary from
                // the middle of the final act moved a visible card, and because
                // nothing was drawn on the scrubber there was no way to see
                // where the number had come from or that it was wrong. If it is
                // trusted enough to change the UI it is trusted enough to show
                // - the same rule the skip windows themselves now follow. The
                // container duration gives it the end it used to lack.
                if (autoDetect && url && edStart == null && modeFor("ed") !== "off"
                    && !(fileDuration > 0)) {
                  // Say so rather than going quiet: without a duration there is
                  // nothing to anchor the scan window to and nothing to give
                  // the stamped window as an end, so the Next-Up card falls back
                  // to its fixed lead time.
                  console.info("[auraskip] outro tail-scan skipped: no container duration");
                }
                if (
                  autoDetect && url && edStart == null
                  && fileDuration > 0 && modeFor("ed") !== "off"
                ) {
                  try {
                    const ob = await invoke<{
                      available: boolean;
                      ed_start: number | null;
                      note: string;
                    }>("detect_outro_boundary", {
                      url,
                      // The scan window IS the acceptance band: 420 s reached
                      // three minutes back into the final act and only ever
                      // added false candidates for the check below to throw
                      // away. Deriving it from the same constant keeps a scan
                      // from producing answers the gate must reject.
                      tailSecs: ED_TAIL_MAX_SECONDS,
                      duration: fileDuration,
                    });
                    if (stale()) return;
                    const tail = ob.ed_start != null ? fileDuration - ob.ed_start : null;
                    if (
                      ob.available && ob.ed_start != null && tail != null
                      && tail >= ED_TAIL_MIN_SECONDS && tail <= ED_TAIL_MAX_SECONDS
                    ) {
                      await republish(
                        [...published, {
                          type: "ed", start: ob.ed_start, end: fileDuration,
                          source: "silencedetect", auto: false,
                        }],
                        `outro tail-scan → ED ${Math.round(ob.ed_start)}-${Math.round(fileDuration)}s (${ob.note})`,
                      );
                      announceEd();
                    } else if (ob.ed_start != null) {
                      // Rejected rather than trusted: the Next-Up card falls
                      // back to its fixed lead time, which is late but right.
                      console.info(
                        `[auraskip] outro tail-scan rejected ED≈${Math.round(ob.ed_start)}s, `
                        + `${Math.round(tail ?? 0)}s before the end is outside `
                        + `${ED_TAIL_MIN_SECONDS}-${ED_TAIL_MAX_SECONDS}s (${ob.note})`,
                      );
                    } else {
                      console.info(`[auraskip] outro tail-scan: ${ob.note}`);
                    }
                  } catch (e) {
                    console.warn(`[auraskip] outro tail-scan failed: ${String(e)}`);
                  }
                }
              } catch (err) {
                console.warn(`[auraskip] finish/chapter merge failed: ${String(err)}`);
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
            // Step 1.5 — SEASON-AWARE resolver for IMDb-keyed multi-season
            // anime. `detail.mal_id` (Step 2) is the SERIES-ROOT entry, which
            // MAL treats as season 1: for a season-2 IMDb id (tt…:2:E) it would
            // pair season 1's MAL id with a season-local episode and fetch
            // season 1's OP/ED — applied to season 2 those land mid-content and
            // (with OP on auto) yank the playhead partway through the episode.
            // `resolve_mal_for_aniskip` keys Fribb by (imdb, season) and returns
            // the SEASON-specific entry — the exact resolver the in-player
            // AniSkip menu already uses, which is why the menu showed the correct
            // mal=55825 for Hell's Paradise S2 while this auto-stamp used 46569
            // (S1). Gated to tt-style ids with season > 1: season 1 and anime-
            // prefix ids (Step 1) already resolve correctly. On failure it falls
            // through to Step 2, so this can only improve resolution.
            if (!malId && target.id.startsWith("tt")
                && Number.isFinite(target.season as number) && (target.season as number) > 1) {
              const seriesImdb = target.series_id?.startsWith("tt")
                ? target.series_id
                : target.id.split(":")[0];
              try {
                malId = await invoke<number | null>("resolve_mal_for_aniskip", {
                  targetId:   target.id,
                  seriesImdb,
                  season:     target.season ?? null,
                  title:      detail?.name ?? null,
                });
                if (malId) {
                  console.info(
                    `[aniskip] season-aware resolve (s${target.season}) → mal=${malId} ` +
                    `(overrides series-root detail.mal_id=${detail?.mal_id ?? "none"})`,
                  );
                }
              } catch (e) {
                console.warn(`[aniskip] season-aware resolve threw: ${String(e)} — falling back to detail.mal_id`);
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
              // Live-action, or anime we couldn't resolve to a MAL id.
              // publicmetadb is the PRIMARY skip source here — keyed by
              // the show's TMDB id + season/episode. It feeds
              // finishWithChapters as `prepared`, so chapters and the
              // silencedetect heuristic only fill kinds it did not
              // supply. No publicmetadb data → empty list, and the
              // chapter path still runs so chaptered live-action keeps
              // producing windows.
              let pmdbWindows: PreparedWindow[] = [];
              const laTmdb = detail?.tmdb_id ?? null;
              const laSegs = target.id.split(":");
              // The segment fallback is for IMDb-style episode ids
              // (tt…:S:E). An anime-prefix id (kitsu:N:M, mal:N:M, …)
              // also splits into 3 segments, but segment 1 is a show
              // id, not a season — trust the fallback only when segment
              // 0 is a tt-prefixed IMDb id; otherwise yield NaN so the
              // Number.isFinite guard below cleanly skips publicmetadb.
              const laImdbId = laSegs.length === 3 && /^tt\d/i.test(laSegs[0]);
              const laSeason = Number.isFinite(target.season as number)
                ? (target.season as number)
                : laImdbId ? Number(laSegs[1]) : NaN;
              const laEpisode = Number.isFinite(target.episode_num as number)
                ? (target.episode_num as number)
                : laImdbId ? Number(laSegs[2]) : NaN;
              if (laTmdb != null && Number.isFinite(laSeason) && Number.isFinite(laEpisode)) {
                pmdbWindows = await fetchPublicmetadbWindows(
                  laTmdb, "tv", laSeason, laEpisode, modeFor,
                );
                console.info(
                  `[publicmetadb] no mal_id for ${seriesId} — ` +
                  `tmdb=${laTmdb} s${laSeason}e${laEpisode} → ${pmdbWindows.length} window(s)`,
                );
              } else {
                console.info(
                  `[publicmetadb] no mal_id for ${seriesId} — skipped ` +
                  `(tmdb=${laTmdb} season=${laSeason} episode=${laEpisode}); chapter-only`,
                );
              }
              await finishWithChapters(pmdbWindows, { silenceUrl: stream.url ?? null });
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
            // publicmetadb anime fallback — best-effort SECONDARY source.
            // Fires only when AniSkip left an OP or ED gap. The TMDB id
            // is resolved from yuna.moe's `themoviedb` (anime `_tmdbId`
            // from AIOMetadata is unreliable) using whichever anime id
            // we have. Fills ONLY the kinds AniSkip didn't supply. NOTE:
            // for multi-cour anime the MAL-local episode may not align
            // with TMDB numbering — that mis-key is the accepted
            // "best-effort" cost (AniSkip remains anime's primary source).
            try {
              const haveOp = prepared.some((w) => w.type === "op" || w.type === "mixed-op");
              const haveEd = prepared.some((w) => w.type === "ed");
              if ((!haveOp || !haveEd) && Number.isFinite(episodeNum)) {
                let animeTmdb: number | null = detail?.tmdb_id ?? null;
                const tmdbSources: ["kitsu" | "anidb" | "anilist", number | null | undefined][] = [
                  ["kitsu",   detail?.kitsu_id],
                  ["anidb",   detail?.anidb_id],
                  ["anilist", (detail as { anilist_id?: number | null } | null)?.anilist_id],
                ];
                for (const [src, sid] of tmdbSources) {
                  if (animeTmdb != null) break;
                  if (sid == null) continue;
                  try {
                    animeTmdb = await invoke<number | null>(
                      "resolve_anime_tmdb_id", { source: src, id: sid },
                    );
                  } catch { /* best-effort — leave null */ }
                }
                if (animeTmdb != null) {
                  const pmdb = await fetchPublicmetadbWindows(
                    animeTmdb, "tv", target.season ?? 1, episodeNum, modeFor,
                  );
                  for (const w of pmdb) {
                    if (w.type === "op" && !haveOp) prepared.push(w);
                    if (w.type === "ed" && !haveEd) prepared.push(w);
                  }
                  if (pmdb.length > 0) {
                    console.info(
                      `[publicmetadb] anime fallback: tmdb=${animeTmdb} → ${pmdb.length} window(s)`,
                    );
                  }
                }
              }
            } catch (e) {
              console.warn(`[publicmetadb] anime fallback failed: ${String(e)}`);
            }
            // ALWAYS augment with chapters (even on an empty AniSkip
            // result): anime with no AniSkip data gets the same
            // chapter / heuristic treatment as live-action. Passing
            // `silenceUrl` arms the auto silencedetect OP fallback for
            // this (MAL-resolved) path only — the no-mal / no-episode
            // exits above intentionally don't, to avoid a heavy ffmpeg
            // scan on every live-action open.
            await finishWithChapters(prepared, {
              silenceUrl: stream.url ?? null,
              // Anime path only: lets the neighbour profile fill an OP/ED gap
              // from this series' other episodes before any ffmpeg pass runs.
              malId,
              episodeNum,
              treatMixed,
            });
          })();
        }
        // Stash the DIRECT raw URL (not the bridge-proxied form) so Copy /
        // Download / External-player open the genuine source — proxying
        // through 127.0.0.1 makes no sense for those utilities.
        setActiveStreamUrl(stream.url ?? null);
        setCurrentStream(stream); // drives the source switcher's "Now Playing" match
        // Look up the logo for the buffering overlay. Try the selected meta
        // (the exact card the user clicked) first, falling back to the
        // selected library item.
        //
        // The library lookup keys on the SERIES ROOT, not `target.id`.
        // libraryNormalize collapses every per-episode row into one
        // series-rooted record, so an episode id (`tt123:1:5`) can never match
        // a library row and this fallback silently never fired for series.
        const logo =
          target.logo ??
          selectedMeta?.logo ??
          library.find((i) => i.id === (target.series_id ?? target.id))?.logo ??
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
        // Snapshot pre-play watched state so the auto-remove exit hook can fire
        // only on a genuine not-watched to watched transition (see
        // watchedAtStartRef). A movie counts by library ratio; a series by its
        // persistent "watched" flag.
        {
          const rootId = target.series_id ?? target.id;
          const mt = (target.media_type ?? "").toLowerCase();
          const isSeriesLike = mt === "series" || mt === "anime";
          let wasWatched = getManualWatchedState(rootId) === "watched";
          if (!wasWatched && !isSeriesLike) {
            const rec = library.find((i) => i.id === rootId);
            const off = typeof rec?.state?.timeOffset === "number" ? rec.state.timeOffset : 0;
            const dur = typeof rec?.state?.duration === "number" ? rec.state.duration : 0;
            wasWatched = dur > 0 && off / dur >= 0.9;
          }
          watchedAtStartRef.current = { id: rootId, wasWatched };
        }
        // Intentionally NOT closing the DetailView here. Keeping
        // `selectedMeta` populated means that when the user exits
        // playback (or hits Esc), they're returned to the stream /
        // episode picker they came from instead of the home grid.
        // DetailView is unmounted while `isPlayerActive` so it doesn't
        // paint behind the player — see the conditional render below.
      } catch (e) {
        console.error("Stream load failed", e);
        // Never leave party staging armed for a load that failed.
        wtPendingStageRef.current = false;
        // Nor the position seal. notifyNewLoad closed it on the assumption a
        // loadfile would follow; if the throw happened before mpv got one, no
        // `playback-file-loaded` is coming and whatever is still on screen
        // would otherwise sit with a frozen 00:00 scrubber. Re-opening is
        // right rather than merely safe: any file still loaded here is the one
        // these positions belong to.
        positionOwnedRef.current = true;
        // setActiveTarget is the LAST statement of the try, so a resolve_stream
        // or load_video failure leaves isPlayerActive false: PlayerOverlay never
        // mounts, and with it neither the `aura:player-toast` host nor the
        // recovery modal (both gated on isPlayerActive). The click was being
        // swallowed in total silence. showAppToast's host lives outside the
        // block hidden during playback, so it covers both the "player never
        // opened" case and a failed in-player source swap.
        showAppToast("Couldn't start playback. The source may be dead - try another.", {
          tone: "danger",
        });
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
    // Live TV / trailers have no IMDb id / episode / Stremio meta to match —
    // searching subtitle addons for `tv/iptv:<id>` (or `trailer:<id>`) just
    // fans out junk lookups to every installed subtitle addon (incl. the
    // user's VPS) per tune-in. Skip it.
    if (isLivePlayback || isTrailerPlayback) {
      setActiveExternalSubs([]);
      return;
    }
    const key = `${activeTarget.media_type}:${activeTarget.id}`;
    if (subsFetchedFor.current === key) return;
    subsFetchedFor.current = key;
    // Drop the OUTGOING episode's list before the new one lands. These are
    // per-episode subtitle files, and PlayerOverlay's external-sub fallback
    // auto-adds the first entry as soon as the new file's track list shows no
    // embedded subs. That read can win the race against this fetch, in which
    // case the fallback would sub-add the PREVIOUS episode's .srt onto the
    // current one: right language, wrong timings, and nothing on screen says
    // so. Clearing first makes the worst case "no external sub yet" instead.
    setActiveExternalSubs([]);

    // Ignore a response that arrives after the target moved on again (a fast
    // double-advance): without this the loser of that race overwrites the
    // winner and the menu lists an episode the user is no longer watching.
    let cancelled = false;
    invoke<ExternalSubtitle[]>("fetch_external_subtitles", {
      addons,
      mediaType: activeTarget.media_type,
      id:        activeTarget.id,
    })
      .then((subs) => { if (!cancelled) setActiveExternalSubs(subs ?? []); })
      .catch(() => { if (!cancelled) setActiveExternalSubs([]); });
    return () => { cancelled = true; };
  }, [activeTarget, addons, isLivePlayback, isTrailerPlayback]);

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

  // ── Live re-stamp of AniSkip windows when skip modes change mid-play ──
  // Each window's `auto` flag is BAKED at stamp time (from the mode read
  // then), and BOTH the MPV-side Lua script AND the in-player SkipController
  // key the actual skip on that per-window flag. So flipping OP auto→prompt
  // in the in-player AniSkip menu (or Settings) was silently ignored until
  // the NEXT episode load: the OP kept auto-skipping. On any settings change
  // during playback, re-read the per-kind modes and re-map every currently
  // stamped window's `auto` by kind (dropping kinds turned off), then re-push
  // via set_skip_windows — which rewrites the Lua user-data AND emits
  // `aura:skip-windows` for the SkipController, so the change takes effect
  // live. Guarded to a real change so unrelated settings (theme, etc.) don't
  // churn the payload. NOTE: turning a kind OFF drops its window from the
  // cache, so toggling it back ON mid-episode won't restore it until the next
  // load — the common auto<->prompt flip (the reported bug) is fully live.
  useEffect(() => {
    const restampSkipModes = async () => {
      try {
        let settings: BackendSettingsLite | null = null;
        try { settings = await invoke<BackendSettingsLite>("get_settings"); } catch { return; }
        const mode = (raw: string | undefined, fb: "off" | "prompt" | "auto"): "off" | "prompt" | "auto" =>
          raw === "off" || raw === "prompt" || raw === "auto" ? raw : fb;
        const opMode    = mode(settings?.skip_op_mode,    "auto");
        const edMode    = mode(settings?.skip_ed_mode,    "prompt");
        const recapMode = mode(settings?.skip_recap_mode, "prompt");
        // Publish to the ref BEFORE anything can return. A skip chain that is
        // still in flight reads its modes from here on every write, and while
        // it runs the payload is EMPTY (the load resets it and the single
        // stamp only lands at the end) - so the empty-payload short-circuit
        // below is exactly the case this has to survive. Ordering this after
        // it meant the chain's final stamp reverted the change every time.
        skipModesRef.current = { op: opMode, ed: edMode, recap: recapMode };
        const cur = await invoke<{ windows?: Array<PreparedWindow & { skip_id?: string | null }> } | null>(
          "get_skip_windows",
        );
        const windows = Array.isArray(cur?.windows) ? cur!.windows! : [];
        if (windows.length === 0) return; // nothing stamped yet / nothing to re-stamp
        // The SAME helper the skip chain stamps through, so the two writers
        // cannot disagree about what a mode means. The inline map this replaced
        // recomputed `auto` from the kind alone, which re-armed auto-seek on
        // every INFERRED window (chapter-heuristic, silencedetect,
        // aniskip-neighbour) the moment any setting changed - undoing, on the
        // live payload, the rule that a guess never yanks the playhead.
        const modeForKind = (kind: string): "off" | "prompt" | "auto" =>
          kind === "op" || kind === "mixed-op" ? opMode
          : kind === "ed"    ? edMode
          : kind === "recap" ? recapMode
          : "off";
        const remapped = applySkipModes(windows, modeForKind) as
          Array<PreparedWindow & { skip_id?: string | null }>;
        // Only re-push when the flags/count actually changed, so a theme or
        // unrelated settings change during playback doesn't rewrite the payload.
        const changed = remapped.length !== windows.length
          || remapped.some((w) => {
               const prev = windows.find(
                 (c) => c.type === w.type && c.start === w.start && c.end === w.end,
               );
               return !prev || prev.auto !== w.auto;
             });
        if (!changed) return;
        await invoke("set_skip_windows", { payload: { windows: remapped } });
        console.info(`[auraskip] re-stamped ${remapped.length} window(s) after skip-mode change`);
      } catch { /* best-effort — the next episode stamps fresh from settings anyway */ }
    };
    window.addEventListener("aura:settings-changed", restampSkipModes);
    return () => window.removeEventListener("aura:settings-changed", restampSkipModes);
  }, []);

  // ── AniSkip cache invalidation after a vote / submit ──
  // Positive AniSkip results are cached for 3 days on this side (and for the
  // process lifetime in Rust). A user who has just downvoted or corrected a
  // window has explicitly said the data is wrong, so continuing to serve them
  // the copy they complained about is the one outcome to avoid. The Rust side
  // invalidates its own entry inside the vote / submit commands; this drops
  // both `treatMixed` variants of the matching frontend key so the next load
  // of that episode refetches.
  useEffect(() => {
    const onInvalidate = (e: Event) => {
      const d = (e as CustomEvent<{ malId?: number | null; episode?: number | null }>).detail;
      const malId = d?.malId;
      const episode = d?.episode;
      if (malId == null || episode == null) return;
      aniskipCache.delete(`${malId}:${episode}:0`);
      aniskipCache.delete(`${malId}:${episode}:1`);
      console.info(`[aniskip] cache invalidated for mal=${malId} ep=${episode}`);
    };
    window.addEventListener("aura:aniskip-invalidate", onInvalidate);
    return () => window.removeEventListener("aura:aniskip-invalidate", onInvalidate);
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
  // applyReducedMotionAttribute is statically imported (line 60) so
  // this effect can run synchronously on first render — the previous
  // dynamic `import("./auraSettings")` re-resolved a chunk that was
  // already in the main bundle and introduced an unnecessary
  // microtask delay before the first attribute write.
  useEffect(() => {
    applyReducedMotionAttribute();
    const apply = () => applyReducedMotionAttribute();
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    mq.addEventListener("change", apply);
    window.addEventListener("aura:settings-changed", apply);
    return () => {
      mq.removeEventListener("change", apply);
      window.removeEventListener("aura:settings-changed", apply);
    };
  }, []);

  // ── Idle / unfocused decorative-animation suspend ──
  // The always-on spectral sweeps (AmbientAura full-viewport backdrop +
  // TitleBar strip) animate `background-position` — a PAINT property — so
  // they re-rasterise full-screen every frame. Chromium does NOT throttle
  // CSS animations on a window that's merely unfocused (only on a truly
  // hidden/minimized one), so a borderless Aura sitting behind another app
  // keeps repainting that gradient in the background — the ~11% idle GPU
  // users see in Task Manager. Toggle `data-aura-idle` whenever the window
  // loses focus or is hidden; the CSS gate (App.css) pauses the decorative
  // loops so they cost nothing while nobody's looking, then resume in place
  // on refocus. Native window focus (Tauri onFocusChanged) is the reliable
  // signal for a borderless WebView2 — DOM focus can stick when the OS
  // window loses focus — with visibilitychange covering minimize/occlude.
  // Derived from the shared windowVisibility store (single listener set for
  // the whole app). Two tiers, on two attributes:
  //   * data-aura-idle — window is hidden (minimized) OR unfocused. Safe to
  //     extend to the player's buffering/scrub paint loops (nobody's watching
  //     the window), so the CSS pause list includes those.
  //   * data-aura-user-idle — window is FOCUSED but has had no pointer/key/
  //     scroll input for IDLE_AFTER_MS. Freezes only the always-on ambient Home
  //     shimmers (full-viewport background-position PAINT loops), NOT the player
  //     UI — a user can watch for minutes without moving the mouse, so the live
  //     buffering/scrub bars must keep animating. Resumes on the next input.
  useEffect(() => {
    const root = document.documentElement;
    const IDLE_AFTER_MS = 25_000;
    let inputIdle = false;
    let idleTimer: number | undefined;

    const apply = () => {
      const away = isWindowHidden() || !isWindowFocused();
      if (away) root.setAttribute("data-aura-idle", "true");
      else root.removeAttribute("data-aura-idle");
      const userIdle = !away && inputIdle;
      if (userIdle) root.setAttribute("data-aura-user-idle", "true");
      else root.removeAttribute("data-aura-user-idle");
    };

    const armIdleTimer = () => {
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => { inputIdle = true; apply(); }, IDLE_AFTER_MS);
    };
    const onActivity = () => {
      if (inputIdle) { inputIdle = false; apply(); }
      armIdleTimer();
    };

    // Passive listeners — they never preventDefault, so they don't add input
    // latency. `scroll` is capture-phase to catch inner scroll containers too.
    const passive: AddEventListenerOptions = { passive: true };
    const passiveCapture: AddEventListenerOptions = { passive: true, capture: true };
    window.addEventListener("pointermove", onActivity, passive);
    window.addEventListener("pointerdown", onActivity, passive);
    window.addEventListener("keydown", onActivity, passive);
    window.addEventListener("wheel", onActivity, passive);
    window.addEventListener("scroll", onActivity, passiveCapture);

    apply();
    armIdleTimer();
    const unsub = subscribeWindowVisibility(apply);
    return () => {
      unsub();
      window.clearTimeout(idleTimer);
      window.removeEventListener("pointermove", onActivity, passive);
      window.removeEventListener("pointerdown", onActivity, passive);
      window.removeEventListener("keydown", onActivity, passive);
      window.removeEventListener("wheel", onActivity, passive);
      window.removeEventListener("scroll", onActivity, passiveCapture);
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
    getTitleState(activeTarget.media_type, titleStateKey(activeTarget)).then((st) => {
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
  // Scrobble target for automatic skips. Read once here rather than per call
  // site so every skip path pushes to the same place.
  const scrobbleConn = useScrobbleConnections();

  const [nextUpInfo, setNextUpInfo] = useState<{
    episode:  VideoEntry;
    stream:   StreamEntry | null;
    /** When `episode` is filler/recap and a later canon episode was
     *  pre-resolved (episode + first stream), drives the cards' "Skip to
     *  canon" primary action. null/absent otherwise. */
    canon?:   {
      episode: VideoEntry;
      stream: StreamEntry;
      /** The episodes this skip jumps OVER, so they can be marked skipped.
       *  Resolved with the canon target because that is the only point where
       *  both ends of the span are known. */
      skipped: VideoEntry[];
    } | null;
  } | null>(null);
  /** Per-episode dismiss flag. Keyed by the CURRENT episode's id (not
   *  the next-up id) so dismissing while watching S01E05 only suppresses
   *  the suggestion for THIS playback; opening S01E06 fresh produces a
   *  new CTA when its own end approaches. */
  const nextUpDismissedFor = useRef<string | null>(null);

  /** Arc context for the episode currently playing, but ONLY when finishing it
   *  crosses a story-arc boundary. The Next-Up card and the EOS Spotlight then
   *  say so ("Alabasta complete - next arc: Sky Island") instead of silently
   *  rolling into a new arc.
   *
   *  Decoration, never a gate: auto-advance behaviour is unchanged, and every
   *  failure path here (no arcs, no TMDB key, meta not cached yet) simply
   *  leaves this null. It must never delay playback, which is why it reads the
   *  CACHED meta rather than fetching one. */
  const [arcNote, setArcNote] = useState<{ ending: string; next: string | null } | null>(null);

  useEffect(() => {
    const seriesId = activeTarget?.series_id ?? activeTarget?.id ?? null;
    const episodeId = activeTarget?.id ?? null;
    const mt = activeTarget?.media_type ?? "";
    if (!seriesId || !episodeId || seriesId === episodeId || !(mt === "series" || mt === "anime")) {
      setArcNote(null);
      return;
    }
    const detail = peekRichestCachedDetailById(seriesId);
    if (!detail) {
      setArcNote(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const result = await fetchStoryArcs(detail, seriesId, loadArcMode(seriesId).groupingId);
      if (cancelled) return;
      const pos = arcPositionOf(result, episodeId);
      setArcNote(pos?.isLast ? { ending: pos.arc.name, next: pos.next?.name ?? null } : null);
    })();
    return () => { cancelled = true; };
  }, [activeTarget?.id, activeTarget?.series_id, activeTarget?.media_type]);
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
  // Same reason as pausedRef: the eos-detected listener is registered once and
  // outlives every render, so it cannot read `duration` directly without
  // capturing the value from the render that installed it (0, at load).
  const durationRef = useRef(duration);
  useEffect(() => { durationRef.current = duration; }, [duration]);

  useEffect(() => {
    const onEos = () => {
      // Trailers don't get an end-of-stream card — they're a short side-trip,
      // not a watch session with a "what's next". Let playback sit on the last
      // frame; the user exits back to the detail page when done.
      if (isTrailerPlayback) return;
      // Live TV has no end of stream: a channel reporting EOF has DROPPED
      // (provider ended the segment list), so it belongs on the reconnect
      // path, not an end card offering "Replay". Pausing here would also wedge
      // recovery outright, because the stale-heartbeat detector early-returns
      // while paused, so streamBroken could never flip afterwards and the
      // auto-retry effect would never run.
      if (isLivePlayback) { setStreamBroken(true); return; }
      // The file is too short to be the episode it claims to be, so reaching
      // its end is not a completion. This is the debrid "REQUEST TIMED OUT"
      // clip: a healthy ~30 s MP4 that plays to EOF and would otherwise raise
      // the Spotlight offering the NEXT episode, as though this one had been
      // watched. Say what happened instead, and leave the current target
      // untouched so nothing is marked, advanced or removed.
      //
      // Checked after the live-TV branch on purpose: a live channel reporting a
      // short duration is a dropped stream, which belongs on the reconnect path.
      const eosDur = durationRef.current;
      if (isImplausiblyShortStream(eosDur)) {
        console.warn(
          `[eos] suppressed: stream is ${Math.round(eosDur)}s, under the ${MIN_PLAUSIBLE_TITLE_S}s ` +
          `floor - treating as a source error clip, not a finished title`,
        );
        showAppToast(
          `That stream was only ${Math.round(eosDur)}s long, so it was not the episode. ` +
          `The source likely returned an error clip - try a different one.`,
          { tone: "danger", duration: 7000 },
        );
        return;
      }
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
  }, [togglePause, isTrailerPlayback, isLivePlayback, setStreamBroken]);

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

  // Reset CTA state whenever the active EPISODE changes (new playback).
  // Keyed on `activeTarget?.id`, NOT the whole object: the
  // absolute_episode_num enrichment below patches activeTarget in place
  // (same id, new object) AFTER load — for season>=2 anime — and an
  // in-player stream switch re-uses the same id too. Keying on the object
  // would re-run this reset on those, wiping the just-dispatched ED-start
  // (nextUpEdStartRef) and forcing a redundant next-up re-resolve, which
  // made the Next-Up CTA fall back to the fixed lead-time instead of firing
  // at the detected ED in anime. It's still the canonical "new load"
  // boundary for the EOS Spotlight: every genuine new episode changes the id.
  useEffect(() => {
    setNextUpInfo(null);
    setNextUpVisible(false);
    setEosActive(false);
    setAutoAdvanceCancelled(false);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTarget?.id]);

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
    // An error clip is not an episode, so do not spend an addon round-trip
    // pre-resolving "what's next" for it (see MIN_PLAUSIBLE_TITLE_S).
    if (isImplausiblyShortStream(duration)) return;
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
      let next: Awaited<ReturnType<typeof resolveNextEpisode>> = null;
      try {
        // "none" ALWAYS. The card shows the real next episode and offers the
        // skip as a separate button, so the resolver must never quietly walk
        // past anything: that is what made "Play next episode" play something
        // else, and what hid the skip from the code that marks it.
        next = await resolveNextEpisode(addons, mediaType, seriesId, currentId, "none");
      } catch (e) {
        // A THROW is not an answer. The latch is claimed before the await so
        // the per-tick effect cannot fan out duplicate lookups, which meant one
        // transient addon failure silently killed Next-Up for the rest of the
        // episode. Release it so a later tick retries; the 50 %-progress gate
        // keeps that from becoming a hot loop.
        if (nextUpResolvedFor.current === currentId) nextUpResolvedFor.current = null;
        console.warn(`[next-up] resolve failed for ${currentId}: ${String(e)}`);
        return;
      }
      if (!next) {
        // No further aired episode — leave the CTA unmounted. The
        // resolved-for guard prevents another lookup until the user
        // navigates to a different episode.
        return;
      }
      // Pre-fetch the first stream so the user's click feels instant.
      // If this returns null we still show the CTA but with a
      // "no stream found" hint rather than a play button. In parallel,
      // if the next episode is filler/recap, pre-resolve the next CANON
      // episode + its stream so the card can offer a one-tap "skip to
      // canon" (null when next isn't filler/recap or no canon lies ahead).
      const [stream, canon] = await Promise.all([
        pickFirstStreamForEpisode(addons, mediaType, next.next.id),
        resolveCanonSkipTarget(addons, next.detail, mediaType, currentId, next.next),
      ]);
      // Guard against state changes during the await — only commit if
      // the active target hasn't moved on (user could have hit Next /
      // Back during the resolution).
      if (nextUpResolvedFor.current === currentId) {
        setNextUpInfo({ episode: next.next, stream, canon });
      }
    })();
  }, [activeTarget, time, duration, addons, nextUpLeadSeconds]);

  // DISPLAY-GATE effect: flips the CTA on once the user has reached either
  // the ED START mark (when one is known) or the lead-time window. Note START,
  // not end: the card is meant to appear as the credits begin, which is the
  // same instant the "Skip ending? Press X" prompt does. Waiting for the ED to
  // END would put it on the last few seconds of the file, after the point where
  // the plain lead time has already fired.
  useEffect(() => {
    if (!activeTarget) {
      if (nextUpVisible) setNextUpVisible(false);
      return;
    }
    if (!nextUpInfo) return;
    if (nextUpDismissedFor.current === activeTarget.id) return;
    const remaining = duration - time;
    const edStart = nextUpEdStartRef.current;
    // Sanity-gate the ED start against the SAME outro band the producer used
    // (App.tsx `edTriggerStart`). Two independent checks rather than one: this
    // gate used to be `edStart >= duration * 0.5`, which on a 24-minute episode
    // accepts anything past 12 minutes and could not reject a single value the
    // ffmpeg tail-scan was capable of producing.
    const edTail = edStart != null ? duration - edStart : null;
    const edTriggered =
      edStart != null && edTail != null && duration > 0
      && edTail >= ED_TAIL_MIN_SECONDS && edTail <= ED_TAIL_MAX_SECONDS
      && time >= edStart && remaining > 0;
    const leadTriggered =
      nextUpLeadSeconds > 0 && duration > 0 && remaining <= nextUpLeadSeconds && remaining > 0;
    // A truncated stream must not offer "next episode" either. `fireEos` gates
    // the EOS Spotlight, but this card is an independent surface with its own
    // unattended countdown, and `eosActive` is false here precisely BECAUSE
    // the Spotlight was suppressed - so the mutual-exclusion gate in the JSX
    // does not cover it. mpv's keep-open teleport parks the playhead a
    // fraction of a second short of `duration`, which satisfies
    // `leadTriggered` outright, and with auto-advance enabled the card would
    // then skip to the next episode and cancel the recovery.
    const shouldShow = (edTriggered || leadTriggered) && !streamTruncatedRef.current;
    if (shouldShow) {
      if (!nextUpVisible) setNextUpVisible(true);
      return;
    }
    // Recoverable: seeking back out of the trigger region takes the card away
    // again. It used to latch on for the rest of the episode, so a card that
    // fired at the wrong moment could only be got rid of by dismissing it -
    // which suppressed the real one at the end too. The margin keeps a scrub
    // that lands a second short of the trigger from flickering it.
    if (nextUpVisible && duration > 0 && remaining > nextUpLeadSeconds + 5) {
      setNextUpVisible(false);
    }
  }, [activeTarget, time, duration, nextUpInfo, nextUpLeadSeconds, nextUpVisible,
      streamTruncated, streamTruncatedRef]);

  // Tear down a Next-Up card when a stream is proven truncated. Dispatched
  // from the verdict site in usePlayback, which cannot reach this state.
  useEffect(() => {
    const onTruncated = () => { setNextUpVisible(false); setNextUpInfo(null); };
    window.addEventListener("aura:stream-truncated", onTruncated);
    return () => window.removeEventListener("aura:stream-truncated", onTruncated);
  }, []);

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
  // Advance playback to a SPECIFIC next episode + pre-resolved stream,
  // recording the CURRENT episode into History first (same gate as
  // handleExitPlayback). Shared by "Play next episode" and "Skip to canon"
  // so both carry the identical History/scrobble + target-build + swap path.
  const advanceToEpisode = useCallback(async (ep: VideoEntry, stream: StreamEntry) => {
    if (!activeTarget) return;
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
      // A truncated stream parks the playhead at `duration`, so the ratio
      // below reads 1.0 on an episode nobody finished. See streamTruncatedRef.
      const meaningfulRatio = dur > 0 && watched / dur >= 0.80 && !streamTruncatedRef.current;
      // Real summed forward-progress, NOT the raw playhead — seeking to
      // the end leaves watchedElapsedRef at ~0 so a skip-to-end episode
      // is correctly excluded from History.
      const meaningfulTime  = watchedElapsedRef.current >= 5 * 60;
      const playedEpisodeId = activeTarget.id;
      const isSeriesEpisode = activeTarget.series_id != null && activeTarget.series_id !== activeTarget.id;
      // Respect the shared per-play guard: the 90%-autocomplete (onAdvance)
      // and handleExitPlayback paths coordinate through autoHistoryWrittenId
      // so an episode is logged once. Without this check, an episode that
      // already crossed 90% (onAdvance wrote it + set the guard) gets a
      // SECOND row here when the user then clicks "Play next episode" — the
      // two writes carry different timestamps so addHistoryEntry's exact
      // (id, played_at) dedup doesn't catch them. That's the observed
      // double-add (~3-5 min apart) on binged anime.
      if (meaningfulRatio && meaningfulTime && playedEpisodeId
          && autoHistoryWrittenId.current !== playedEpisodeId) {
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
          // Capture the addon's AniList mapping NOW, while we still have the
          // VideoEntry. A History row scrobbled later has no way to recover it,
          // and without it AniList mis-resolves split-cour anime — see the field
          // docs in historyStore.ts.
          anilist_id:      activeTarget.anilist_id ?? null,
          anilist_episode: activeTarget.anilist_episode ?? null,
        });
        // Claim the guard so handleExitPlayback (and a same-play onAdvance)
        // won't re-log this episode. Reset per-load in notifyNewLoad.
        autoHistoryWrittenId.current = playedEpisodeId;
      }
    }

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
      // Carry the OUTGOING episode's scoring signals into the next one.
      // Same series means same original language / production countries /
      // genres, so re-nesting them is exact, not a guess.
      //
      // Without this the advance handed handlePlayStream a target with no
      // `scoring`, which nulled activeScoringMeta AND the anime-detection
      // fields on activeTarget. The audio scorer then could not resolve the
      // "original" token in the priority list, silently dropped it, and
      // auto-selected the English dub on a Japanese-original show from the
      // second episode of a binge onward. Same class of loss the
      // useScrobble is_anime comment describes for AniList.
      //
      // activeScoringMeta is preferred over the flattened activeTarget
      // fields because it also carries `country`, which ActiveScrobbleTarget
      // has no slot for and which is the scorer's last-resort tier.
      // handlePlayStream does not clear it until later in this same call, so
      // it still holds the outgoing episode's values here. Mirrors the
      // re-nest in onPickSource.
      scoring: activeScoringMeta ?? {
        original_language:    activeTarget.original_language ?? null,
        production_countries: activeTarget.production_countries ?? [],
        genres:               activeTarget.genres ?? undefined,
        country:              null,
      },
    };
    // Tear the end screen down BEFORE clearing nextUpInfo. The Spotlight
    // derives its mode from `episode`, so a still-mounted eosActive with a null
    // nextUpInfo renders the "You've finished <title>" END-CARD for the whole
    // load, which is seconds, not a flash. The id-keyed reset effect clears
    // eosActive too, but not until setActiveTarget lands at the very end of
    // handlePlayStream.
    setEosActive(false);
    setNextUpInfo(null);
    await handlePlayStream(stream, target);
    // Allow the new target's CTA to arm when its own end approaches.
    nextUpResolvedFor.current = null;
  }, [activeTarget, activeScoringMeta, library, selectedMeta]);

  const onNextUpPlay = useCallback(async () => {
    if (!nextUpInfo || !nextUpInfo.stream) return;
    // Deliberately marks NOTHING. This button plays the episode it names, so
    // if that is filler the user is watching it, not skipping it. The skip
    // button beside it is the one that jumps a run, and it is the only path
    // that writes skip marks.
    await advanceToEpisode(nextUpInfo.episode, nextUpInfo.stream);
  }, [nextUpInfo, advanceToEpisode]);

  // Skip past all upcoming filler/recap straight into the pre-resolved next
  // canon episode. Only wired when `nextUpInfo.canon` is present.
  const onNextUpSkip = useCallback(async (auto = false) => {
    if (!nextUpInfo?.canon) return;
    const skippedEps = nextUpInfo.canon.skipped;
    if (skippedEps.length > 0 && activeTarget) {
      // `userInitiated` is the scrobble gate, and an UNATTENDED countdown is
      // not user-initiated. Falling asleep through a filler run should leave
      // purple tags you can clear, not a dozen Trakt plays you have to undo on
      // their website one at a time. The marks are written either way, so the
      // local record is the same however the skip fired.
      void markEpisodesSkipped(
        skippedEps.map((v: VideoEntry) => ({
          id: v.id,
          parentId: activeTarget.series_id ?? activeTarget.id,
          name: activeTarget.name,
          mediaType: activeTarget.media_type,
          season: v.season,
          episode: v.episode,
          episodeTitle: v.title ?? null,
          // The SERIES art, resolved the same way the natural-finish History
          // row does. These were null, so every skip row in History rendered
          // art-less next to played rows that had a poster.
          poster: library.find((i) => i.id === (activeTarget.series_id ?? activeTarget.id))?.poster
            ?? selectedMeta?.poster ?? null,
          background: library.find((i) => i.id === (activeTarget.series_id ?? activeTarget.id))?.background
            ?? selectedMeta?.background ?? null,
          anilistId: (v as { anilist_id?: number | null }).anilist_id ?? null,
          anilistEpisode: (v as { anilist_episode?: number | null }).anilist_episode ?? null,
        })),
        {
          userInitiated: !auto,
          autoScrobbleEnabled: scrobbleConn.autoScrobbleEnabled,
          scrobbleScope: scrobbleConn.scope,
          services: connectedServices(scrobbleConn),
        },
      );
    }
    await advanceToEpisode(nextUpInfo.canon.episode, nextUpInfo.canon.stream);
  }, [nextUpInfo, advanceToEpisode, activeTarget, scrobbleConn, library, selectedMeta]);

  const onNextUpDismiss = useCallback(() => {
    if (activeTarget) {
      nextUpDismissedFor.current = activeTarget.id;
    }
    // Dismissing is attendance: it resets the still-watching streak, and it
    // counts as refusing the auto-advance so the end-of-stream Spotlight does
    // not arm a fresh countdown a minute later.
    autoAdvanceStreakRef.current = 0;
    setAutoAdvanceCancelled(true);
    setNextUpInfo(null);
  }, [activeTarget]);

  /** Play a Live TV channel. Builds a synthetic StreamEntry + an `iptv:`
   *  target with media_type "tv" so the rest of the app treats it as a
   *  live stream. The `isLivePlayback` derivation below keys off that
   *  shape to suppress the scrubber, resume prompt, scrobble, and
   *  history / Continue-Watching writes — none of which make sense for an
   *  infinite live stream. resolve_stream routes HLS (.m3u8, HTTP or HTTPS)
   *  DIRECT to MPV — a proxied manifest breaks segment-URI resolution and
   *  trips provider UA gating — and only single-file HTTP (.ts/.mp4) goes
   *  through the bridge, so no playback change is needed here. */
  const handlePlayChannel = useCallback(
    (channel: IptvChannel, playlist: IptvPlaylist) => {
      if (!channel.url) return;
      const stream: StreamEntry = {
        title:       channel.name,
        addon_name:  playlist.name,
        url:         channel.url,
        info_hash:   null,
        file_idx:    null,
        description: null,
        filename:    null,
      };
      const target = {
        id:         `iptv:${channel.id}`,
        media_type: "tv",
        name:       channel.name,
        logo:       channel.logo ?? undefined,
      };
      void handlePlayStream(stream, target, { proxyUrl: playlist.proxyUrl ?? null });
    },
    [handlePlayStream],
  );

  // ── Watch Trailer ───────────────────────────────────────────────────
  // Plays a title's YouTube trailer in Aura's own MPV player (not a webview
  // popup / the browser). MPV can't open a YouTube page, so the id is resolved
  // to a direct CDN URL via yt-dlp (an on-demand binary fetched on first use)
  // and that plain HTTPS URL is fed through the normal play path. The synthetic
  // `trailer:<ytId>` target shape drives every VOD carve-out (no scrobble /
  // history / Continue-Watching / resume) via `isTrailerPlayback`.
  const handlePlayTrailer = useCallback(
    async (ytId: string, title: string) => {
      // Spam-click guard: the yt-dlp download + resolve takes a few seconds and
      // the DetailView button stays clickable until the player opens over it.
      if (trailerLaunchingRef.current) return;
      trailerLaunchingRef.current = true;
      try {
      const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      // First-use gate: download yt-dlp if it isn't already on disk. The toast
      // covers the one-time fetch; the player's own loading overlay takes over
      // once load_video starts. Subsequent trailer plays skip this entirely.
      const present = await runtimeDepPresent("yt-dlp.exe").catch(() => false);
      if (!present) {
        showFlyUpToast("Preparing trailer playback…", center);
        try {
          await ensureRuntimeDep("yt-dlp.exe");
        } catch (e) {
          showFlyUpToast(`Couldn't set up trailer playback: ${String(e)}`, { ...center, tone: "danger" });
          return;
        }
      }
      // Default quality comes from the sharable `trailer_quality` setting;
      // the in-player menu can override it per trailer afterward. 1080p+ is
      // DASH (yt-dlp returns a separate audio URL the engine mux-pairs).
      let quality = "1080";
      try {
        const s = await invoke<{ trailer_quality?: string }>("get_settings");
        if (s?.trailer_quality) quality = s.trailer_quality;
      } catch { /* fall back to 1080 */ }

      let res: TrailerResolution;
      try {
        res = await invoke<TrailerResolution>("resolve_trailer_url", {
          ytId, maxHeight: qualityToHeight(quality),
        });
      } catch (e) {
        showFlyUpToast(`Trailer unavailable: ${String(e)}`, { ...center, tone: "danger" });
        return;
      }
      activeTrailerYtIdRef.current = ytId;
      currentTrailerHeightRef.current = res.height;
      setTrailerMaxHeight(res.max_height_available);
      // Highlight the rung that's ACTUALLY playing (not the requested one).
      setTrailerQuality(heightToRung(res.height));
      setTrailerQualityLabel(res.quality_label);

      const stream: StreamEntry = {
        title:       `${title} — Trailer`,
        addon_name:  "YouTube",
        url:         res.video_url,
        info_hash:   null,
        file_idx:    null,
        description: null,
        filename:    null,
      };
      const target = {
        id:         `trailer:${ytId}`,
        media_type: "trailer",
        name:       title,
      };
      // forceStartSeconds: 0 forces a clean start (no resume prompt — a trailer
      // has no library record / saved position anyway). audioFileUrl is the
      // separate DASH audio stream (null for a muxed 720p single file).
      void handlePlayStream(stream, target, {
        forceStartSeconds: 0,
        audioFileUrl: res.audio_url ?? undefined,
      });
      } finally {
        trailerLaunchingRef.current = false;
      }
    },
    [handlePlayStream],
  );

  // In-player trailer quality switch: re-resolve at the chosen height and
  // swap in place at the current playhead (reuses handlePlayStream's
  // forceStartSeconds path, exactly like the source switcher). Persists the
  // choice as the new default. Guarded against overlapping re-resolves.
  const handleSetTrailerQuality = useCallback(
    async (quality: string) => {
      const ytId = activeTrailerYtIdRef.current;
      if (!ytId || trailerResolvingRef.current) return;
      const t = writebackTarget.current;
      if (!t || !t.id.startsWith("trailer:")) return;
      // Same rule as onPickSource, and for the same reason: a quality swap
      // replays the SAME trailer, so the live playhead is the right answer -
      // but only while it is ours. handlePlayStream resolves when load_video
      // returns, which is BEFORE mpv reports the file open, so a second
      // quality pick in that gap sees a sealed (0) position and would restart
      // the trailer from the top. lastStartSecondsRef carries the offset the
      // in-flight load was issued with, so it is scoped to this play.
      const startAt = ownedTime() ?? lastStartSecondsRef.current ?? 0;
      const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
      trailerResolvingRef.current = true;
      setIsTrailerResolving(true);
      try {
        const res = await invoke<TrailerResolution>("resolve_trailer_url", {
          ytId, maxHeight: qualityToHeight(quality),
        });
        // Reflect what ACTUALLY resolved (label + highlighted rung), and keep
        // the menu gated to what this title offers. Persist the user's REQUEST
        // as the default so a future trailer that does offer it honours it.
        setTrailerMaxHeight(res.max_height_available);
        setTrailerQualityLabel(res.quality_label);
        setTrailerQuality(heightToRung(res.height));
        invoke("update_settings", { patch: { trailer_quality: quality } }).catch(() => {});
        // Resolves to the SAME height already playing (e.g. re-selecting the
        // current rung) — skip the reload so the picture doesn't stutter.
        if (res.height === currentTrailerHeightRef.current) {
          return;
        }
        currentTrailerHeightRef.current = res.height;
        const stream: StreamEntry = {
          title:       `${t.name} — Trailer`,
          addon_name:  "YouTube",
          url:         res.video_url,
          info_hash:   null,
          file_idx:    null,
          description: null,
          filename:    null,
        };
        const target = { id: `trailer:${ytId}`, media_type: "trailer", name: t.name };
        await handlePlayStream(stream, target, {
          forceStartSeconds: startAt,
          audioFileUrl: res.audio_url ?? undefined,
        });
      } catch (e) {
        // Resolve failed — the highlight never changed (it's set from the
        // actual result only on success), so just surface the error.
        showFlyUpToast(`Couldn't switch quality: ${String(e)}`, { ...center, tone: "danger" });
      } finally {
        trailerResolvingRef.current = false;
        setIsTrailerResolving(false);
      }
    },
    // lastStartSecondsRef is a stable ref, so it needs no dep entry.
    [handlePlayStream, ownedTime],
  );

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
  const [eosNextAirMs, setEosNextAirMs] = useState<number | null>(null);
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
      setEosNextAirMs(null);
      setEosEpisodesOpen(false);
      eosResolveStartedFor.current = null;
      return;
    }
    const mt = (activeTarget.media_type ?? "").toLowerCase();
    const isSeriesLike = mt === "series" || mt === "anime";
    // Entry trace — fires whenever the EOS resolver runs, so a "why is there no
    // [eos] caught-up line / why finale" report shows which path it took: a
    // non-series END-CARD, a pre-resolved NEXT-UP (no caught-up check), an
    // already-settled resolve, or the caught-up walk (which logs its own line).
    console.info(
      `[eos] resolve enter id=${activeTarget.id} series_id=${activeTarget.series_id ?? "none"} ` +
        `mt=${mt || "none"} seriesLike=${isSeriesLike} nextUp=${nextUpInfo ? "ready" : "none"} resolve=${eosResolve}`,
    );
    if (!isSeriesLike) { setEosResolve("none"); return; }
    if (nextUpInfo) { setEosResolve("ready"); return; }
    if (eosResolve === "ready" || eosResolve === "none") return;
    // Once per current episode. `eosResolve` is deliberately NOT a dep of this
    // effect: while it was, the setEosResolve("resolving") below re-ran the
    // effect, and the re-run's cleanup flipped `cancelled` on the lookup that
    // had only just started. The resolve then sat on "resolving" forever,
    // which the Spotlight renders as a permanent spinner, so the finale and
    // caught-up end cards never appeared at all. The started-for ref is the
    // only re-entry guard needed here.
    if (eosResolveStartedFor.current === activeTarget.id) return;
    eosResolveStartedFor.current = activeTarget.id;
    setEosResolve("resolving");
    const seriesId = activeTarget.series_id ?? activeTarget.id;
    const mediaType = activeTarget.media_type;
    const currentId = activeTarget.id;
    let cancelled = false;
    void (async () => {
      // "none" always, matching the Next-Up resolver above.
      const res = await resolveNextEpisode(addons, mediaType, seriesId, currentId, "none");
      if (cancelled) return;
      if (res) {
        const [stream, canon] = await Promise.all([
          pickFirstStreamForEpisode(addons, mediaType, res.next.id),
          resolveCanonSkipTarget(addons, res.detail, mediaType, currentId, res.next),
        ]);
        if (cancelled) return;
        setNextUpInfo({ episode: res.next, stream, canon });
        setEosResolve("ready");
        return;
      }
      // No AIRED next episode. Distinguish "true finale" from "caught
      // up — next season not yet aired": re-run the walk ignoring the
      // aired filter (a far-future `now`); a hit there means a later
      // episode exists but simply hasn't aired.
      // RICHEST detail (most videos) for the caught-up vs finale call —
      // prefer the full episode list DetailView already cached, else fetch
      // the richest across addons. peekCachedDetailById / getMetaDetailFallback
      // can return a leaner entry (freshest-by-ts, or the FIRST addon with
      // any videos) that omits future-dated episodes, making a still-airing
      // show look finished (wrong "Series finale" + a missing countdown).
      const detail =
        peekRichestCachedDetailById(seriesId) ??
        (await getRichestMetaDetail(addons, mediaType, seriesId));
      if (cancelled) return;
      const laterIgnoringAir = detail
        ? findNextEpisode(detail, currentId, Number.MAX_SAFE_INTEGER,
            loadAuraSettings().nextUpSkipFillerRecap)
        : null;
      const nextAirMs = detail ? (nextAiringEpisode(detail.videos, undefined, { mainRunOnly: true })?.targetMs ?? null) : null;
      // Series airing status (surfaced from the addon meta — Cinemeta/TMDB
      // "Ended"/"Returning Series", Kitsu/MAL "finished"/"finished_airing"/
      // "current", etc.). The video-list signals above (laterIgnoringAir /
      // nextAirMs) only catch shows whose meta already LISTS a future episode;
      // a still-airing show whose next episode hasn't been added to the meta
      // yet (Wistoria after its last AIRED episode) has neither, so without a
      // status check it wrongly reads as a finale. We flip to "caught up" only
      // on POSITIVE evidence the series is NOT over — an explicit non-ended
      // status, or (when the addon omits status) an open-ended release-info run
      // like "2024–". A missing/unknown status alone stays on the finale path,
      // so status-less addons don't suppress legitimate finale cards for shows
      // that genuinely ended. The ended-match is a substring test so MAL's
      // "finished_airing" is covered while every ongoing vocab term is not.
      const statusRaw = (detail?.status ?? "").trim();
      const endedStatus = statusRaw !== "" && /(ended|finished|cancell?ed|complete)/i.test(statusRaw);
      const ongoingStatus = statusRaw !== "" && !endedStatus;
      const openEndedRun =
        statusRaw === "" && /^\d{4}\s*[-–—]\s*$/.test((detail?.release_info ?? "").trim());
      // Cloud release signal (videos-independent; imdb-keyed). For tt-keyed
      // series — which INCLUDES AIOMetadata anime mapped to imdb ids like
      // Wistoria's tt31889371 — the cloud poller tracks the upstream schedule
      // and knows the NEXT episode even when the addon meta lists none, emits
      // no status, and carries an ambiguous closed releaseInfo ("2024-2026").
      // A populated `next_aired` is hard proof the series is still going (a
      // genuinely-ended show has next_aired=null), so it's both a reliable
      // caught-up signal AND a real countdown target. Kitsu/anidb-keyed series
      // aren't in the imdb-keyed store → getReleaseSignal returns
      // undefined/null and we fall back to the addon-meta signals above.
      const sig = getReleaseSignal(seriesId);
      // IGNORE a season-0 next_aired: specials/OVAs (e.g. tt5626028:0:24) are
      // NOT "the series is still airing" — a finished show whose only upcoming
      // cloud entry is a special must still read as a finale. Prefer the
      // `season` field; fall back to parsing the `:S:E` tail of a tt-style id
      // when the field is absent.
      const cloudNext = sig?.next_aired ?? null;
      const cloudNextIsSpecial =
        cloudNext != null &&
        (cloudNext.season === 0 || /^tt\d+:0:\d+$/.test(cloudNext.id ?? ""));
      const cloudHasNext = cloudNext != null && !cloudNextIsSpecial;
      const cloudNextMs =
        cloudHasNext && cloudNext?.aired_at ? Date.parse(cloudNext.aired_at) : NaN;
      const caughtUp =
        !!laterIgnoringAir || ongoingStatus || nextAirMs != null || openEndedRun || cloudHasNext;
      // Countdown target: prefer the meta's future-dated episode, else the
      // cloud's next_aired when it's genuinely in the future. Null leaves the
      // "next episode hasn't been scheduled yet" copy (correct when caught up
      // via status/open-ended run with no known date).
      const effectiveNextAirMs =
        nextAirMs != null
          ? nextAirMs
          : Number.isFinite(cloudNextMs) && cloudNextMs > Date.now()
            ? cloudNextMs
            : null;
      console.info(
        `[eos] caught-up check seriesId=${seriesId} ` +
          `(targetSeriesId=${activeTarget.series_id ?? "none"} targetId=${currentId}) ` +
          `videos=${detail?.videos?.length ?? 0} ` +
          `laterIgnoringAir=${laterIgnoringAir ? laterIgnoringAir.id : "none"} ` +
          `nextAirMs=${nextAirMs ?? "none"} status=${statusRaw || "none"} ended=${endedStatus} ` +
          `cloudNext=${cloudNext ? `${cloudNext.id ?? "yes"}${cloudNextIsSpecial ? "(S0,ignored)" : ""}` : "none"} ` +
          `caughtUp=${caughtUp}`,
      );
      setEosCaughtUpUnaired(caughtUp);
      setEosNextAirMs(effectiveNextAirMs);
      setEosResolve("none");
    })().catch((e) => {
      // A THROW anywhere in the walk (addon fetch, richest-meta fetch, stream
      // pick) used to reject this IIFE silently, leaving `eosResolve` on
      // "resolving" for good with the started-for latch already claimed, so it
      // never retried either. That was survivable only because the Spotlight
      // rendered the END-CARD while resolving; now that it correctly renders a
      // spinner instead, an unhandled throw would park the user on that
      // spinner forever. Fall through to the end card - the honest answer when
      // we could not find a next episode - and release the latch so a later
      // re-entry can try again.
      if (cancelled) return;
      console.warn(`[eos] resolve failed for ${currentId}: ${String(e)}`);
      if (eosResolveStartedFor.current === currentId) eosResolveStartedFor.current = null;
      setEosCaughtUpUnaired(false);
      setEosNextAirMs(null);
      setEosResolve("none");
    });
    return () => { cancelled = true; };
  }, [eosActive, activeTarget, addons, nextUpInfo]);
  // (EOS action handlers are defined just below handleExitPlayback —
  // they depend on it, which is declared later in this component.)

  // ── Global last-used volume ──
  // Volume is a property of the user's environment (headphones loud, TV
  // quiet) — NOT a property of the content. Save on user-initiated
  // changes (via commitVolumeAndSave) and re-apply on every stream load.
  // Keyed on the target ID, not the object: the absolute_episode_num / anilist
  // enrichment patches activeTarget in place (same id, new object identity)
  // seconds after load, and an object-keyed dep re-read the PERSISTED
  // last_volume at that moment. Landing inside the 600 ms save debounce, that
  // reverted a volume the user had just set (settings ended up correct, mpv did
  // not). mpv keeps `volume` across loadfile, so a same-id source swap needs no
  // re-apply.
  useEffect(() => {
    if (!activeTarget) return;
    invoke<{ last_volume?: number }>("get_settings")
      .then((s) => {
        if (typeof s.last_volume === "number") {
          invoke("set_volume", { volume: s.last_volume }).catch(() => {});
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTarget?.id]);

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
    // a second or two on cold network. Keyed by the STABLE user_id when known:
    // Stremio rotates auth_key on EVERY login, so an auth_key-prefixed key never
    // hits across logins (defeating the warm-start it exists for) and orphans a
    // blob each time. Fall back to the auth_key prefix for legacy sessions that
    // predate user_id (backfilled next launch). Replaced by the fresh fetch.
    const cacheKey = `aura:library:${
      sess.user_id && sess.user_id.trim() ? `u:${sess.user_id}` : `k:${sess.auth_key.slice(0, 12)}`
    }`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw) as LibraryItem[];
        if (Array.isArray(cached) && cached.length > 0) {
          // metaCache hydrates synchronously at module import, so any
          // fresh poster URLs we warmed in the previous session are
          // already in memory. Apply them to the warm-start cache so
          // tile artwork is correct on the first paint instead of
          // flickering through the stale-URL set.
          const posterMap = peekFreshestPostersByIds(cached.map((it) => it.id));
          const warmed = posterMap.size > 0
            ? cached.map((it) => {
                const fresh = posterMap.get(it.id);
                return fresh && fresh !== it.poster ? { ...it, poster: fresh } : it;
              })
            : cached;
          setLibrary(overlayRecentClears(warmed));
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
      // Synchronously swap in any fresh poster URLs we already have
      // cached for these ids — Stremio library records freeze the
      // poster URL at insert time, so library tiles can display
      // stale (e.g. revoked RPDB-key) URLs while Home / Discover
      // catalogs show the latest because they re-fetch from the
      // addon. The metaCache typically holds fresher entries from
      // Calendar / Notifications scanner / Detail visits; the
      // background-warm effect below handles ids we don't yet have.
      const posterMap = peekFreshestPostersByIds(items.map((it) => it.id));
      const itemsWithFreshPosters = posterMap.size > 0
        ? items.map((it) => {
            const fresh = posterMap.get(it.id);
            return fresh && fresh !== it.poster ? { ...it, poster: fresh } : it;
          })
        : items;
      setLibrary(overlayRecentClears(itemsWithFreshPosters));
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
      // Drop any OTHER library warm-cache blobs (rotated-auth_key prefixes from
      // prior logins, or a different account) so they don't leak quota forever.
      try {
        const stale: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith("aura:library:") && k !== cacheKey) stale.push(k);
        }
        for (const k of stale) localStorage.removeItem(k);
      } catch { /* ignore */ }
      // Persist the patched list (via safeSetItem so a full origin evicts a
      // disposable cache rather than silently dropping the warm-start). Purely a
      // local UI cache; the Stremio cloud record itself is left untouched.
      safeSetItem(cacheKey, JSON.stringify(itemsWithFreshPosters));
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

  // ── Background library-poster warm ──
  // Stremio library records freeze the poster URL at insertion time
  // (revoked RPDB API keys leave 403'd tiles in Library / Queue
  // forever even after the addon serves new URLs in catalogs). For
  // every library id we don't yet have in the metaCache, fire a
  // best-effort `getMetaDetailFallback` and apply the fresh poster
  // back to the in-memory library — the rendered UI updates without
  // touching the Stremio cloud record. A ref-tracked set of "already
  // attempted" ids stops focus refetches / library-changed bumps
  // from re-firing the same network requests every cycle. Concurrency
  // is capped at 6 to keep AIOMetadata from getting hammered when the
  // user has a large library.
  const warmedPosterIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (library.length === 0 || addons.length === 0) return;
    // Cheap synchronous anime seed from details ALREADY in the metaCache (warmed
    // by Calendar / notifications / prior visits, which don't classify). The
    // network warm below only covers un-cached ids, so this closes the gap for
    // IMDb-id'd anime whose detail is cached but was never classified. markAnimeId
    // is idempotent + only bumps the reactive version on a genuinely new id.
    for (const it of library) {
      const cached = peekCachedDetailById(it.id);
      if (cached && isAnimeMeta({
        media_type: cached.media_type ?? it.media_type,
        id: it.id,
        genres: cached.genres,
        original_language: cached.original_language,
        production_countries: cached.production_countries,
      })) {
        markAnimeId(it.id);
      }
    }
    const candidates = library.filter((it) =>
      !warmedPosterIdsRef.current.has(it.id) &&
      !peekCachedDetailById(it.id),
    );
    if (candidates.length === 0) return;
    for (const it of candidates) warmedPosterIdsRef.current.add(it.id);

    let cancelled = false;
    void (async () => {
      const updates = new Map<string, string>();
      const queue = [...candidates];
      const concurrency = 6;
      const worker = async () => {
        while (queue.length > 0 && !cancelled) {
          const it = queue.shift();
          if (!it) break;
          const detail = await getMetaDetailFallback(addons, it.media_type, it.id)
            .catch(() => null);
          if (detail?.poster && detail.poster !== it.poster) {
            updates.set(it.id, detail.poster);
          }
          // Seed anime classification from the freshly-resolved detail. Library
          // records synced from Stremio carry no genres, so IMDb-id'd anime
          // (Bleach, Attack on Titan, Vinland Saga) fell into the Series bucket
          // until the user opened their detail page. This warm covers every
          // library id, so the Series/Anime split is correct after it settles.
          // markAnimeId is idempotent + only bumps the reactive version on a
          // genuinely new id, so LibraryView re-classifies without a poster diff.
          if (detail && isAnimeMeta({
            media_type: detail.media_type ?? it.media_type,
            id: it.id,
            genres: detail.genres,
            original_language: detail.original_language,
            production_countries: detail.production_countries,
          })) {
            markAnimeId(it.id);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      if (cancelled || updates.size === 0) return;
      setLibrary((prev) => {
        let dirty = false;
        const next = prev.map((it) => {
          const fresh = updates.get(it.id);
          if (!fresh || fresh === it.poster) return it;
          dirty = true;
          return { ...it, poster: fresh };
        });
        return dirty ? next : prev;
      });
    })();

    return () => { cancelled = true; };
  }, [library, addons]);

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

  // Reactive mirror of the Queue page's "remove series once started"
  // toggle. Synced via the settings-changed event so flipping it
  // retroactively reconciles the queue below (not just on next playback).
  const [queueRemoveSeriesInProgress, setQueueRemoveSeriesInProgress] = useState(
    () => loadAuraSettings().queueRemoveSeriesInProgress,
  );
  useEffect(() => {
    const sync = () =>
      setQueueRemoveSeriesInProgress(loadAuraSettings().queueRemoveSeriesInProgress);
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  // ── Queue ⇄ Library reconciliation ──
  // The Queue is the local "planned" subset of manualWatched. It can drift
  // from reality two ways; both are reconciled here whenever the library
  // changes (or the toggle flips):
  //
  //   (a) Orphaned tombstone — "Mark as Planned" auto-adds to the library,
  //       but a later removal (past build, cross-client sync, removal while
  //       closed) can leave the planned mark behind for content the user no
  //       longer has saved. Pruned when the library record is removed:true.
  //       Keyed on removed:true SPECIFICALLY (not mere absence) because
  //       Stremio is eventually consistent: a freshly-added planned item can
  //       briefly vanish from the array during library_put → library_get,
  //       and pruning on absence would race that into deleting a valid mark.
  //
  //   (b) Graduated out of "to watch" — a planned MOVIE that's been watched
  //       (≥90%) or a planned SERIES that's in-progress (any episode started,
  //       gated by the toggle). Manual "planned" masks the WatchedBadge's
  //       auto-derived state, so without this an already-started/finished
  //       planned item would linger in the Queue forever. Movies are
  //       unconditional (a watched movie is done); series are preference.
  //
  //   (c) EPISODE-shaped ids, which can only have come from the short-lived
  //       "Mark arc as planned" option (removed 2026-08-12). Planned is a
  //       title-level mark: the Queue looks each id up as a library record and
  //       the media-key advance fetches full meta for it, so an episode id sits
  //       there as an unremovable stub forever. Pruned on sight. The shape test
  //       is deliberately strict (3+ colon-separated parts, last two numeric)
  //       so no real root id can match: series roots are `tt0903747` or
  //       `kitsu:49240`, episodes are `tt0903747:1:5` / `kitsu:49240:6`.
  useEffect(() => {
    if (!libraryLoaded) return;
    const planned = getPlannedQueue();
    if (planned.length === 0) return;
    const byId = new Map(library.map((it) => [it.id, it] as const));
    for (const id of planned) {
      const parts = id.split(":");
      if (parts.length >= 3
          && /^\d+$/.test(parts[parts.length - 1])
          && /^\d+$/.test(parts[parts.length - 2])) {
        setManualWatchedState(id, null);
        continue;
      }
      const item = byId.get(id);
      if (!item) continue;
      if (item.removed) { setManualWatchedState(id, null); continue; }
      const off = typeof item.state?.timeOffset === "number" ? item.state.timeOffset : 0;
      const dur = typeof item.state?.duration === "number" ? item.state.duration : 0;
      if (dur <= 0 || off <= 0) continue;
      const mt = (item.media_type ?? "").toLowerCase();
      const isSeries = mt === "series" || mt === "anime";
      if (isSeries) {
        if (queueRemoveSeriesInProgress) setManualWatchedState(id, null);
      } else if (off / dur >= 0.9) {
        setManualWatchedState(id, null);
      }
    }
  }, [library, libraryLoaded, queueRemoveSeriesInProgress]);

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
        // Raw record supplies the state block verbatim so the push never
        // rewrites Stremio's millisecond progress in seconds (see the raw-item
        // note in pushItemWatched). Series roots carry the last episode's
        // position there, so this is a real cross-client resume fix, not just
        // cosmetic.
        const rawItem = rawLibraryRef.current.find((i) => i.id === d.id) ?? null;
        pushItemWatched(authKey, item, isWatched, rawItem).catch((err) => {
          console.warn(`[watched-sync] push fail id=${d.id} err=${String(err)}`);
        });
      }
    });
  }, [session, library]);

  // ── Clear the auto-bumped suppression when the user ENGAGES with a series by
  //     marking any of its episodes (or the series root) watched / in-progress.
  //     autoBumped previously only cleared on PLAY (onPlayStream pre-load hook),
  //     so a user who caught up by marking watched WITHOUT playing left the
  //     series stranded out of Continue Watching forever. Ungated (autoBumped is
  //     a local overlay, independent of sign-in) and fires for every
  //     watched-state transition; clearAutoBumpedForVideo prefix-matches an
  //     episode id back to its series root. Marking null (un-watch) is NOT an
  //     engagement, so recheckSeriesWatchedFlag's own seriesId->null write
  //     can't clear the bump it sets immediately after.
  useEffect(() => {
    return onWatchedSync((diffs) => {
      for (const d of diffs) {
        if (d.newState === "watched" || d.newState === "in-progress") {
          clearAutoBumpedForVideo(d.id);
        }
      }
    });
  }, []);

  // ── Local stats: bump streams_played on every load_video, accumulate
  //     watched-time per media_type via a 5 s tick while playing. The
  //     home_view_secs counter is bumped from the Home view directly.
  const windowHidden = useWindowHidden();
  const lastStatsTickRef = useRef<number | null>(null);
  useEffect(() => {
    // Live TV / trailers aren't a VOD "stream played" and a 24/7 channel left
    // on would pollute the watch-time stats — carve them out like
    // scrobble/history do.
    if (!activeTarget || isLivePlayback || isTrailerPlayback) {
      lastStatsTickRef.current = null;
      return;
    }
    // First-time per session — count this as a stream played.
    invoke("bump_stat", { kind: "streams_played", delta: 1 }).catch(() => {});
    lastStatsTickRef.current = Date.now();
  }, [activeTarget?.id, activeTarget?.media_type, isLivePlayback, isTrailerPlayback]);
  useEffect(() => {
    if (!activeTarget || paused || isLivePlayback || isTrailerPlayback) {
      lastStatsTickRef.current = null;
      return;
    }
    const id = setInterval(() => {
      const now = Date.now();
      const last = lastStatsTickRef.current ?? now;
      const delta = (now - last) / 1000;
      lastStatsTickRef.current = now;
      // Pick a kind based on media type + anime detection. CRITICAL: use
      // the SERIES-ROOT id (series_id), not activeTarget.id — for series
      // the latter is the EPISODE id (tt…:S:E), which never matches the
      // anime-id cache or genre signal (both keyed at the series root), so
      // IMDb-id'd anime series (Frieren etc.) were mis-counted as Series.
      // Also feed the library item's genres so anime tagged only by genre
      // (no kitsu/mal id prefix) is caught — covers anime movies too.
      const recordId = activeTarget.series_id ?? activeTarget.id;
      const libItem = libraryRef.current.find((i) => i.id === recordId);
      const stateGenres = (libItem?.state ?? {}).genres;
      const genres = Array.isArray(stateGenres)
        ? stateGenres.filter((g): g is string => typeof g === "string")
        : undefined;
      const isAnime = isAnimeMeta({
        media_type: activeTarget.media_type,
        id:         recordId,
        genres,
      });
      const kind = isAnime
        ? "watched_anime_secs"
        : (activeTarget.media_type === "movie" ? "watched_movie_secs" : "watched_series_secs");
      invoke("bump_stat", { kind, delta }).catch(() => {});
    }, 5000);
    lastStatsTickRef.current = Date.now();
    return () => clearInterval(id);
  }, [activeTarget, paused, isLivePlayback, isTrailerPlayback]);

  // ── Keep the display awake during active playback ──
  // Belt-and-suspenders alongside mpv's own stop-screensaver: assert the
  // keep-awake hold whenever the player is up AND not paused; release
  // otherwise (paused / browsing → normal sleep). The Rust side applies
  // SetThreadExecutionState from the engine's pump thread.
  useEffect(() => {
    invoke("set_keep_display_awake", { enabled: isPlayerActive && !paused })
      .catch(() => {});
  }, [isPlayerActive, paused]);

  // Home-view dwell time. The same 5 s cadence accumulates against
  // home_view_secs whenever activeView === "home" and the player isn't up.
  useEffect(() => {
    if (activeView !== "home" || isPlayerActive || windowHidden) return;
    const id = setInterval(() => {
      invoke("bump_stat", { kind: "home_view_secs", delta: 5 }).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [activeView, isPlayerActive, windowHidden]);

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
        // Mirror the zero into the RAW snapshot for every contributing record
        // (legacy per-episode rows included). Without this, rawLibraryRef keeps
        // reporting the pre-rewind offset and a later raw-sourced write
        // (libraryRemoveAll, libraryToggle) would echo it back to the cloud.
        setRawLibrary((curr) => curr.map((i) =>
          libraryItemSeriesId(i.id) === detail.item.id
            ? { ...i, state: { ...i.state, timeOffset: 0 } }
            : i
        ));
        window.dispatchEvent(new CustomEvent("aura:library-write"));
        // Then push to the cloud — fire-and-forget so a slow network
        // doesn't keep the row visible.
        await libraryClearProgress(sess.auth_key, detail.item, rawLibraryRef.current);
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
          anilist_id:      at.anilist_id ?? null,
          anilist_episode: at.anilist_episode ?? null,
        });
        autoHistoryWrittenId.current = detail.episodeId;
      }
      void advanceWatchedAfter(detail.seriesId, detail.episodeId, mt, addons);
    };
    window.addEventListener("aura:auto-advance-watched", onAdvance);
    return () => window.removeEventListener("aura:auto-advance-watched", onAdvance);
  }, [addons, activeTarget, library, selectedMeta]);

  // ── Auto-remove watched (Library) ──
  // Two opt-in toggles (Library page options popover, off by default) drop a
  // title from the Library once it's fully watched. A movie counts when it
  // reaches >=90% or is marked watched; a series counts only when its root
  // "watched" flag flips (every AIRED episode watched, nothing further
  // scheduled - advanceWatchedAfter), so an ongoing show is never removed.
  //
  // Removal is triggered at two RACE-SAFE points and always DEFERRED ~3 s +
  // re-verified before it fires:
  //   1. handleExitPlayback dispatches `aura:library-autoremove-check` for the
  //      just-finished title AFTER its final progress flush, so the removeAll
  //      tombstone lands with a later mtime than that write and Stremio's
  //      last-writer-wins merge can't resurrect the row. This covers the title
  //      you actually watched to the end.
  //   2. onWatchedSync covers "watched" marks made OUTSIDE playback (right-click
  //      Mark as Watched on a poster, or a completion of some other title). It
  //      SKIPS the id that's currently playing - that one is handled at exit
  //      (1) to avoid the resurrection race.
  // The pre-existing watched backlog is NOT swept here - that's the one-time
  // opt-in prompt on enable (handleAutoRemoveSweep). Settings are read fresh at
  // fire time; empty deps + live refs mean a toggle flip never re-subscribes.
  useEffect(() => {
    const pending = new Map<string, ReturnType<typeof setTimeout>>();

    // `trusted` = the caller already confirmed completion from an authoritative
    // source (handleExitPlayback's final playhead), so the movie branch can
    // skip the library-state ratio re-check - which is otherwise unreliable
    // because library progress is written on pause / exit only, so a
    // continuously-watched movie's stored timeOffset lags the true position and
    // the post-exit refetch may not have landed within the defer window.
    const scheduleRemoval = (id: string, trusted: boolean) => {
      if (pending.has(id)) return; // already queued for this id
      const timer = setTimeout(() => {
        pending.delete(id);
        const auth = sessionRef.current?.auth_key;
        if (!auth) return;
        // Re-check active playback at FIRE time (not just schedule time): if the
        // id became the currently-playing title during the 3s defer window,
        // removing it now would race the ongoing progress writes and get the
        // tombstone resurrected. Leave it to the exit path (which fires after
        // the final flush) instead of removing mid-playback.
        const at = activeTargetRef.current;
        const activeId = at ? (at.series_id ?? at.id) : null;
        if (activeId && id === activeId) return;
        const item = libraryRef.current.find((i) => i.id === id && !i.removed);
        if (!item) return;
        const s = loadAuraSettings();
        const mt = (item.media_type ?? "").toLowerCase();
        const isSeriesLike = mt === "series" || mt === "anime";
        // Re-verify eligibility + that the toggle is still on.
        if (isSeriesLike) {
          if (!s.libraryAutoRemoveWatchedSeries) return;
          // Series completion is a persistent local flag either way, so this
          // re-check is reliable regardless of `trusted`.
          if (getManualWatchedState(item.id) !== "watched") return;
        } else {
          if (!s.libraryAutoRemoveWatchedMovies) return;
          const off = typeof item.state?.timeOffset === "number" ? item.state.timeOffset : 0;
          const dur = typeof item.state?.duration === "number" ? item.state.duration : 0;
          const watched =
            trusted || getManualWatchedState(item.id) === "watched" || (dur > 0 && off / dur >= 0.9);
          if (!watched) return;
        }
        // Optimistic local removal + cloud tombstone - same path as the manual X.
        setLibrary((prev) => prev.filter((i) => i.id !== item.id));
        setRawLibrary((prev) => prev.filter((i) => libraryItemSeriesId(i.id) !== item.id));
        if (getManualWatchedState(item.id) === "planned") setManualWatchedState(item.id, null);
        void libraryRemoveAll(auth, item.id, rawLibraryRef.current)
          .then((res) => {
            if (res.removedCount > 0) {
              showAppToast(`Auto-removed watched ${isSeriesLike ? "series" : "movie"} · ${item.name}`);
            }
          })
          .catch((err) => console.warn(`[library] auto-remove failed id=${item.id} err=${String(err)}`));
      }, 3000);
      pending.set(id, timer);
    };

    // (1) The just-finished title, dispatched from handleExitPlayback post-flush.
    // Trusted: the exit hook already confirmed completion from the final playhead.
    const onExitCheck = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (typeof id === "string" && id) scheduleRemoval(id, true);
    };
    window.addEventListener("aura:library-autoremove-check", onExitCheck);

    // (2) Marks made outside playback. Skip the currently-playing root - its
    // removal is owned by the exit path so a final flush can't resurrect it.
    const unsubSync = onWatchedSync((diffs) => {
      const at = activeTargetRef.current;
      const activeId = at ? (at.series_id ?? at.id) : null;
      for (const diff of diffs) {
        if (diff.newState !== "watched") continue;
        if (activeId && diff.id === activeId) continue; // handled at exit
        // diff.id may be an episode / movie / series-root id. Only a library
        // record (movie or series root) resolves; episode-level marks find no
        // record and are skipped. Re-checked at fire time in scheduleRemoval.
        const item = libraryRef.current.find((i) => i.id === diff.id && !i.removed);
        if (!item) continue;
        const mt = (item.media_type ?? "").toLowerCase();
        const isSeriesLike = mt === "series" || mt === "anime";
        const s = loadAuraSettings();
        if (isSeriesLike ? s.libraryAutoRemoveWatchedSeries : s.libraryAutoRemoveWatchedMovies) {
          // Untrusted: re-verify from state. The diff means a "watched" mark was
          // just set, so getManualWatchedState==="watched" passes; a movie whose
          // mark got cleared in the defer window is correctly skipped.
          scheduleRemoval(item.id, false);
        }
      }
    });

    return () => {
      window.removeEventListener("aura:library-autoremove-check", onExitCheck);
      unsubSync();
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

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
      // "Planned" auto-adds to the library, so removing from the library
      // must also drop the Queue (planned) membership — otherwise an
      // orphaned Queue tile lingers for content the user no longer has
      // saved. Only "planned" is cleared; "watched"/"in-progress" are
      // independent historical marks that should survive a library remove.
      if (getManualWatchedState(meta.id) === "planned") {
        setManualWatchedState(meta.id, null);
      }
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
      await libraryToggle(session.auth_key, meta, library, rawLibraryRef.current);
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
    // Drop Queue (planned) membership too — see handleLibraryToggle's
    // remove branch for the rationale (planned ⟹ in library invariant).
    if (getManualWatchedState(item.id) === "planned") {
      setManualWatchedState(item.id, null);
    }

    if (originPoint) {
      showFlyUpToast(`Removed from Library · ${item.name}`, {
        x: originPoint.x,
        y: originPoint.y,
        tone: "danger",
      });
    }

    try {
      const result = await libraryRemoveAll(session.auth_key, item.id, rawLibraryRef.current);
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
  }, [session, handleSessionExpired]);

  // One-time backlog sweep when an auto-remove toggle is first enabled and the
  // user confirms the Library prompt. Bulk version of handleLibraryRemove:
  // optimistic drop of all victims at once, then parallel cloud tombstones
  // against the pre-optimistic raw snapshot, then one summary toast.
  const handleAutoRemoveSweep = useCallback((kind: "movie" | "series", victims: LibraryItem[]) => {
    const auth = session?.auth_key;
    if (!auth || victims.length === 0) return;
    const ids = new Set(victims.map((v) => v.id));
    const rawSnapshot = rawLibraryRef.current;
    setLibrary((prev) => prev.filter((i) => !ids.has(i.id)));
    setRawLibrary((prev) => prev.filter((i) => !ids.has(libraryItemSeriesId(i.id))));
    for (const v of victims) {
      if (getManualWatchedState(v.id) === "planned") setManualWatchedState(v.id, null);
    }
    void Promise.allSettled(
      victims.map((v) => libraryRemoveAll(auth, v.id, rawSnapshot)),
    ).then(() => {
      const label =
        kind === "movie"
          ? (victims.length === 1 ? "movie" : "movies")
          : "series";
      showAppToast(`Removed ${victims.length} watched ${label} from your Library`);
    });
  }, [session]);

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
      // Hand the richer anime verdict AND the cached detail down: the detail
      // carries mal / kitsu / tmdb ids, which is what turns most of these rows
      // from a title search into a direct link to the title's own page. On a
      // cache miss it is simply null and each source falls back to search.
      const sources = sourcesForMeta(meta, { detail: cachedDetail, isAnime });
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
            onClick: () => { void openSourceLink(s); },
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

      // ── Vote to Watch (party only) ────────────────────────────────
      // Only present while connected to a watch party. Proposes a poll
      // for this title; the relay caps it at 3 concurrent (startVote also
      // pre-checks + surfaces the error). Title-level only (this listener
      // never fires for episode rows — those use DetailView's own menu).
      if (getWatchState().status === "connected") {
        items.push({
          kind: "action",
          label: "Vote to Watch",
          tone: "notice",
          icon: (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z" />
            </svg>
          ),
          onClick: () => {
            const ok = startVote({
              metaId: meta.id,
              mediaType: meta.media_type,
              title: meta.name,
              poster: meta.poster ?? null,
            });
            if (ok) showFlyUpToast(`Vote started · ${meta.name}`, { x, y, tone: "success" });
          },
        });
      }

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
    // Skip annotations follow the watched marks they annotate; a skip whose
    // watched mark lives in another scope would be a ghost.
    setSkipMarksScope(scope);
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
          // Don't await `backfill_user_id` on boot any more. The
          // history-store migration falls back to `legacyAuthScope`
          // (a hash of `auth_key.slice(0, 12)`) whenever `user_id`
          // is absent — that's been the legacy-session compat path
          // since 0.6.x and works fine. Awaiting the round-trip
          // here added 200–800 ms to every cold start on
          // legacy-shaped sessions for no user-visible payoff;
          // backfill still runs in the background so the NEXT
          // launch's `get_session` picks up the persisted user_id.
          if (!sess.user_id) {
            void invoke<string | null>("backfill_user_id").catch((e) => {
              console.warn(`[auth] backfill_user_id failed: ${String(e)}`);
            });
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
          // Library + synced-addons load is fire-and-forget. Each
          // path already paints from its localStorage warm cache
          // immediately on the synchronous setX(cached) inside its
          // own function; awaiting the cloud refetch here just
          // delayed the splash for a redundant network round-trip.
          // The setters fire mid-flight via React state updates;
          // nothing downstream of `authChecked` reads from them
          // synchronously.
          void Promise.all([loadSyncedAddons(sess), loadLibrary(sess)]);
        } else {
          await applySettingsScope(null);
          loadLocalAddons();
        }
      })
      .catch((e) => {
        // A REJECTION here means the saved session could not be READ (the OS
        // credential vault was momentarily locked / unavailable) — DISTINCT
        // from "no saved session", which resolves null and is handled above.
        // Silently booting to guest strands a logged-in user: they think they
        // were signed out and re-login over a vault that will read fine next
        // launch. Load local addons so the app works, but tell them WHY so the
        // fix (restart, or unlock the vault) is obvious instead of a mystery.
        console.warn(`[auth] could not read saved sign-in: ${String(e)}`);
        loadLocalAddons();
        showAppToast(
          "Couldn't read your saved sign-in (your Windows credential vault may be locked). Restart Aura or sign in again.",
          { tone: "danger", duration: 7000 },
        );
      })
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

  /** Persist the new addon order to disk (guest) or to the Stremio cloud
   *  (logged-in). Optimistically updates local state immediately so the
   *  drag-drop feels instant; reverts on failure and surfaces a toast.
   *  Mirrors the new ordering into the warm-start cloud cache so the
   *  next launch paints the reordered list on the first frame. */
  const handleAddonsReorder = useCallback(async (urls: string[]) => {
    const previous = addons;
    const norm = (s: string) =>
      s.trim().replace(/\/manifest\.json$/, "").replace(/\/+$/, "").toLowerCase();
    const byUrl = new Map(previous.map((a) => [norm(a.url), a] as const));
    const reordered: AddonEntry[] = [];
    for (const u of urls) {
      const hit = byUrl.get(norm(u));
      if (hit) { reordered.push(hit); byUrl.delete(norm(hit.url)); }
    }
    for (const leftover of byUrl.values()) reordered.push(leftover);
    if (reordered.length === 0) return;

    setAddons(reordered);

    try {
      if (session?.auth_key) {
        await invoke("cloud_reorder_addons", {
          authKey: session.auth_key,
          urls: reordered.map((a) => a.url),
        });
        try {
          localStorage.setItem(
            cloudAddonCacheKey(session.auth_key),
            JSON.stringify(reordered),
          );
        } catch { /* quota */ }
      } else {
        await invoke("reorder_addons", { urls: reordered.map((a) => a.url) });
      }
    } catch (err) {
      if (String(err) === SESSION_EXPIRED) {
        await handleSessionExpired();
        return;
      }
      setAddons(previous);
      showAppToast(`Couldn't save addon order: ${String(err)}`, { duration: 4000 });
    }
  }, [addons, session, cloudAddonCacheKey, handleSessionExpired]);

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
    // Live-TV channels and trailers carry no episode metadata or AniList ids —
    // never enrich them (mirrors useScrobble's carve-out; without this the
    // effect would fan out a futile getMetaDetailFallback to every meta addon
    // on each channel change / trailer start).
    if (isLivePlayback || isTrailerPlayback) return;
    const s = activeTarget.season;
    const e = activeTarget.episode_num;
    // Absolute episode: only needed for season > 1 (S1 cour-relative ==
    // absolute) and only until stamped.
    const needAbsolute =
      activeTarget.absolute_episode_num == null && s != null && s > 1 && e != null;
    // Embedded AniList id/episode (AIOMetadata): stamp for ANY anime episode
    // (incl. season 1 / single-cour), once. Gated on an episode number so movies
    // and non-episodic targets — which can never carry a per-video anilist_id —
    // don't trigger a fetch here (they previously did none). Absent for
    // non-AIOMetadata sources, where the resolver falls back to the Fribb id-map
    // / SEQUEL-walk / title search.
    const needAnilist = activeTarget.anilist_id == null && e != null;
    if (!needAbsolute && !needAnilist) return;
    const targetId = activeTarget.id;
    const mediaType = activeTarget.media_type;
    const seriesId = activeTarget.series_id ?? targetId;
    let cancelled = false;
    (async () => {
      const detail = await getMetaDetailFallback(addons, mediaType, seriesId)
        .catch(() => null);
      if (cancelled || !detail?.videos || detail.videos.length === 0) return;
      // Absolute episode = prior-cour episode counts + this cour-relative ep.
      let absoluteEp: number | null = null;
      if (needAbsolute && s != null && e != null) {
        const priorCourEps = detail.videos.filter(
          (v) => (v.season ?? 0) > 0 && (v.season ?? 0) < s,
        ).length;
        absoluteEp = priorCourEps + e;
      }
      // Embedded AniList pair from the VideoEntry the user is actually playing.
      const vid = needAnilist ? detail.videos.find((v) => v.id === targetId) : undefined;
      const aid = vid?.anilist_id ?? null;
      const aep = vid?.anilist_episode ?? null;
      // Patch via functional setState — if the user has already swapped to a
      // different episode by the time the meta resolves, the id check refuses
      // to overwrite the new target with stale data.
      setActiveTarget((prev) => {
        if (!prev || prev.id !== targetId) return prev;
        let next = prev;
        if (absoluteEp != null && prev.absolute_episode_num !== absoluteEp) {
          next = { ...next, absolute_episode_num: absoluteEp };
        }
        if (
          aid != null && aep != null &&
          (prev.anilist_id !== aid || prev.anilist_episode !== aep)
        ) {
          next = { ...next, anilist_id: aid, anilist_episode: aep };
        }
        return next;
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
  // Hand the scrobbler the last HONEST position. A truncated origin parks
  // `time` at `duration` (mpv keep-open `seek_to_last_frame`), and
  // `scrobble_end` treats >= 80% as an unconditional "mark watched" on Trakt /
  // AniList. `positionTrusted` below stops the auto-complete branch, but every
  // TEARDOWN route into scrobble_end (exiting the player, switching episode,
  // beforeunload, unmount) reads the playback snapshot instead - so sanitizing
  // it here is what actually stops a dropped stream reporting a finished
  // episode.
  const scrobbleTime = streamTruncated ? (lastSanePosRef.current ?? 0) : time;
  useScrobble({
    // Live TV channels / trailers never scrobble — there's no episode or
    // completion to report. Passing null keeps the hook fully inert for
    // `iptv:` and `trailer:` targets.
    active: isLivePlayback || isTrailerPlayback ? null : activeTarget,
    playback: { time: scrobbleTime, duration, paused },
    scope: scrobbleScope,
    // Belt to the sanitized playhead's braces: this gates the auto-complete
    // branch itself, so a truncation can never satisfy the 80% ratio even if
    // a sane position was never recorded.
    positionTrusted: !streamTruncated,
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
    const next = Math.max(0, Math.min(VOLUME_MAX, volume + delta));
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
      "toggle-pause":     () => wtTogglePause(),
      // Step read at PRESS time, not when the handler map was built, so a
      // change in Settings applies to the very next key press without
      // re-registering the bindings.
      "seek-back":        () => wtSeekRelative(-loadAuraSettings().seekStepSeconds),
      "seek-forward":     () => wtSeekRelative(loadAuraSettings().seekStepSeconds),
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
        // Frame-step auto-pauses mpv, which would desync an in-sync follower
        // (and applyTick can't resume a follower past a self-inflicted pause).
        // The wrapped transport controls already gate on this; the keybinding
        // path must too. Also blocked during a staged hold.
        if (wtStagedHold() || wtFollowerLocked()) return;
        invoke("frame_step", { forward: false }).catch(() => {});
      },
      "frame-step-forward": () => {
        if (!isPlayerActive) return;
        if (wtStagedHold() || wtFollowerLocked()) return;
        invoke("frame_step", { forward: true }).catch(() => {});
      },
      "screenshot": () => {
        if (!isPlayerActive) return;
        // mpv `window` mode = the rendered (HDR-tonemapped) frame. Fire-and-
        // forget; the file lands a moment after the command is queued. The
        // toast names the directory it was saved to (configurable in Settings).
        invoke<string>("save_screenshot")
          .then((path) => {
            const dir = path.replace(/[\\/][^\\/]*$/, "") || path;
            window.dispatchEvent(new CustomEvent("aura:player-toast", { detail: { message: `Screenshot saved to ${dir}` } }));
          })
          .catch(() => window.dispatchEvent(new CustomEvent("aura:player-toast", { detail: { message: "Screenshot failed" } })));
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
        // A queue hop is a DIFFERENT show, so the outgoing episode's scoring
        // must not be inherited here. The freshly fetched `detail` carries
        // all four fields; same shape DetailView's targetForPlay builds.
        // Without this the queued title opens its first episode with the
        // "original" priority token unresolvable, i.e. on the English dub.
        scoring: {
          original_language:    detail.original_language ?? null,
          production_countries: detail.production_countries ?? [],
          genres:               detail.genres ?? [],
          country:              detail.country ?? null,
        },
      });
      return true;
    }
    return false;
  }, [addons, handlePlayStream]);

  const stepEpisode = useCallback(async (direction: 1 | -1) => {
    const target = activeTarget;
    if (!target) return;
    // A party follower must not move its own episode: changing our videoKey
    // drops us off the room title with no recovery path. Nobody steps while
    // the room is staged either. Same gate wtTogglePause uses.
    if (wtStagedHold() || wtFollowerLocked()) return;
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
      // BOTH DIRECTIONS UNFILTERED. Next used to honour the filler / recap
      // preference, which made a media key silently jump a run with no UI to
      // show what it passed and no code path to mark it, the same defect the
      // Next-Up card had. That preference now means "which button an
      // unattended countdown aims at", and a media key is a person pressing a
      // button, not an unattended countdown. Skipping a run is an explicit
      // action with its own button on the card.
      const candidate = direction === 1
        ? findNextEpisode(detail, target.id, Date.now(), "none")
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
      await handlePlayStream(stream, {
        id:           candidate.id,
        series_id:    seriesId,
        media_type:   target.media_type,
        name:         target.name,
        episode:      ep,
        episode_title: candidate.title ?? undefined,
        season:        candidate.season ?? undefined,
        episode_num:   candidate.episode ?? undefined,
        // Same-series step, so the outgoing episode's scoring carries over
        // verbatim. Omitting it nulled activeScoringMeta and made the audio
        // scorer drop the "original" priority token, auto-selecting the dub
        // (see the matching re-nest in advanceToEpisode). The older comment
        // here claimed handlePlayStream falls back to addon stream metadata
        // for default-track selection; it does not, it just passes
        // `target.scoring` straight through.
        scoring: activeScoringMeta ?? {
          original_language:    target.original_language ?? null,
          production_countries: target.production_countries ?? [],
          genres:               target.genres ?? undefined,
          country:              null,
        },
      });
    } catch (err) {
      console.warn("[smtc] step episode failed:", err);
    }
  }, [addons, activeTarget, activeScoringMeta, handlePlayStream, advanceToQueueNext,
      wtStagedHold, wtFollowerLocked]);

  // ── In-player source switcher ──────────────────────────────────────────
  // Swap the stream SOURCE for the currently-playing item without leaving the
  // player. Opened from PlayerOverlay's MoreMenu via the
  // `aura:open-source-switcher` window event; fetches the alternative sources
  // for the active target, then re-invokes the canonical handlePlayStream with
  // forceStartSeconds = the live position (a swap-in-place).
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherStreams, setSwitcherStreams] = useState<StreamEntry[]>([]);
  const [switcherLoading, setSwitcherLoading] = useState(false);
  const [switcherResolvingKey, setSwitcherResolvingKey] = useState<string | null>(null);

  useEffect(() => {
    const onOpen = () => {
      if (!activeTarget) return;
      const mt = (activeTarget.media_type ?? "").toLowerCase();
      if (!["movie", "series", "anime"].includes(mt)) return; // not live channels
      setSwitcherOpen(true);
      setSwitcherLoading(true);
      setSwitcherResolvingKey(null);
      setSwitcherStreams([]);
      // Same stream-addon scoping DetailView uses (respects the user's
      // streamAddonUrls setting; fetch_streams gates by capability anyway).
      const queryAddons = streamQueryAddons(addons);
      invoke<StreamFetchResult>("fetch_streams", {
        addons: queryAddons,
        mediaType: activeTarget.media_type,
        id: activeTarget.id,
      })
        .then((r) => setSwitcherStreams(Array.isArray(r) ? (r as StreamEntry[]) : (r?.streams ?? [])))
        .catch(() => setSwitcherStreams([]))
        .finally(() => setSwitcherLoading(false));
    };
    window.addEventListener("aura:open-source-switcher", onOpen);
    return () => window.removeEventListener("aura:open-source-switcher", onOpen);
  }, [activeTarget, addons]);

  const onPickSource = useCallback((stream: StreamEntry) => {
    if (!activeTarget) return;
    // Picking the already-playing row is a no-op (the UI disables it too) —
    // match on stable identity, not the volatile (debrid-re-resolved) url.
    if (sameStreamSource(stream, currentStream)) { setSwitcherOpen(false); return; }
    setSwitcherResolvingKey(streamKey(stream));
    // The live position wins; but if the user switched within the first
    // seconds (e.g. the original source failed to start), fall back to the
    // library's saved offset for the SAME video so the swap doesn't lose
    // the resume point. Mirrors handlePlayStream's same-episode rule.
    const seriesKey = activeTarget.series_id ?? activeTarget.id;
    const libRow = libraryRef.current.find((i) => i.id === seriesKey);
    const st = (libRow?.state ?? {}) as { timeOffset?: number; video_id?: string };
    const sameVideo = activeTarget.media_type === "movie"
      || st.video_id == null
      || st.video_id === activeTarget.id;
    const savedOffset = sameVideo && typeof st.timeOffset === "number" ? st.timeOffset : 0;
    // A swap plays the SAME content, so the live position is the right answer
    // - but only while it is genuinely ours. If the user swaps again while the
    // FIRST pick is still resolving (the switcher stays open until the
    // .finally), the seal is closed and `time` is 0, which would drop them
    // back to the library's last WRITTEN offset (debounced, 120 s warmup) or
    // to 00:00 on a swap that should be frame-accurate.
    //
    // The fallback is lastStartSecondsRef and NOT the newest position we
    // happen to have seen, because it is scoped to the CURRENT play by
    // construction: handlePlayStream stamps it with the offset every load is
    // issued with, and the paths that mean "start this again from the top"
    // (EOS Replay) null it deliberately. A position-shaped snapshot would
    // instead survive a start-over and resume the pre-restart playhead.
    const live = ownedTime() ?? lastStartSecondsRef.current ?? 0;
    const startAt = live > 5 ? live : Math.max(live, savedOffset);
    void handlePlayStream(stream, {
      id:            activeTarget.id,
      series_id:     activeTarget.series_id,
      media_type:    activeTarget.media_type,
      name:          activeTarget.name,
      episode:       activeTarget.episode,
      episode_title: activeTarget.episode_title,
      season:        activeTarget.season,
      episode_num:   activeTarget.episode_num,
      // Re-nest the anime-detection signals ActiveScrobbleTarget carries so the
      // swapped source keeps correct audio/sub default-track scoring.
      scoring: {
        original_language:    activeTarget.original_language ?? null,
        production_countries: activeTarget.production_countries ?? [],
        genres:               activeTarget.genres ?? undefined,
        country:              null,
      },
    }, { forceStartSeconds: startAt })
      .catch(() => {
        window.dispatchEvent(new CustomEvent("aura:player-toast", {
          detail: { message: "Couldn't switch source" },
        }));
      })
      .finally(() => {
        setSwitcherResolvingKey(null);
        setSwitcherOpen(false);
      });
  }, [activeTarget, currentStream, handlePlayStream, ownedTime]);

  // ── Casting (Chromecast + DLNA) ──
  // Device picker + session state live in useCastSession; opened via the
  // `aura:open-cast-menu` event from PlayerOverlay's MoreMenu. Local MPV
  // pauses while the TV plays and resumes at the device's last position
  // on stop. See src-tauri/src/cast/ + the 2026-06-09 casting spec.
  const castTitle = activeTarget
    ? activeTarget.media_type === "movie"
      ? activeTarget.name
      : `${activeTarget.name}${
          activeTarget.season != null && activeTarget.episode_num != null
            ? ` — S${String(activeTarget.season).padStart(2, "0")}E${String(activeTarget.episode_num).padStart(2, "0")}`
            : ""
        }`
    : null;
  const cast = useCastSession({
    streamUrl: activeStreamUrl,
    title: castTitle,
    currentTime: time,
    paused,
  });

  useEffect(() => {
    const p = listen<string>("smtc-event", ({ payload }) => {
      switch (payload) {
        case "play":
        case "pause":
        case "toggle":
          // Wrapped control, NOT the raw one: an OS media key is a user
          // transport action exactly like the on-screen button, so it has to
          // honour the party staging hold and the follower lockout, and it has
          // to broadcast the leader's play/pause to the room. Using the raw
          // control meant a leader pausing with a media key stopped locally
          // while every follower played on, with no control frame sent.
          wtTogglePause();
          break;
        case "stop":
          // No explicit stop binding; pause as the closest analogue.
          if (!paused) wtTogglePause();
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
  }, [wtTogglePause, paused, stepEpisode]);

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
  // Deduped to whole-second granularity: `time` ticks many times/sec, but the
  // OS media flyout only needs second resolution, so we skip redundant IPC
  // (this was firing an invoke per time-pos event — a chunk of the live-
  // playback UI lag, where the position is meaningless anyway).
  const lastSmtcRef = useRef<string>("");
  useEffect(() => {
    if (!activeTarget) return;
    const payload = { playing: duration > 0, paused, position: Math.round(time) };
    const sig = `${payload.playing}|${payload.paused}|${payload.position}`;
    if (sig === lastSmtcRef.current) return;
    lastSmtcRef.current = sig;
    invoke("smtc_set_playback", payload).catch(() => {});
  }, [activeTarget, paused, duration, time]);

  // Wheel-to-volume lives in PlayerOverlay's own window wheel listener (it adds
  // the on-screen toast and honors VOLUME_MAX = 150). A duplicate handler used
  // to live here too and clamped to 100, so it fought the overlay's 150 ceiling
  // (wheel visually stuck at ~100 while the toast read up to 105) and
  // double-fired the set_volume IPC per tick. Removed; the overlay is the sole
  // wheel-to-volume path and is mounted whenever the player is active.

  // ── Library writeback — on pause + on activeTarget change, send the
  //     current timeOffset/duration to the Stremio cloud datastore so the
  //     "Continue Watching" row picks it up next session. Debounced so a
  //     rapid play/pause sequence doesn't flood the API.
  const lastWrittenTime = useRef<number>(-1);
  const writebackTarget = useRef<ActiveScrobbleTarget | null>(null);
  const writebackTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackRef     = useRef({ time: 0, duration: 0 });
  /** Last position seen while a file was GENUINELY loaded, stamped with the
   *  target it belonged to.
   *
   *  handlePlayStream calls notifyNewLoad() (which zeroes time, duration and
   *  watchedElapsedRef) hundreds of lines BEFORE setActiveTarget, with an
   *  awaited resolve_stream + load_video in between, so they land in different
   *  commits. By the time the activeTarget-change cleanup flushes the OUTGOING
   *  target, the live refs already describe the INCOMING load and every gate in
   *  flushProgress rejects: watch 35 minutes, switch source, and those 35
   *  minutes were never written.
   *
   *  Two guards, both load-bearing:
   *    - only updated while a file is really loaded (duration > 0 AND time > 0),
   *      so a fresh-load reset or a stop_video reporting time 0 cannot poison
   *      it with zeroes.
   *    - stamped with the target id, so a snapshot left over from a PREVIOUS
   *      title can never be written into a different title's record. Without
   *      it: play A for 35 min, exit, open B, B never produces a duration
   *      (dead source), exit, and A's 35 minutes land on B's cloud record. */
  const lastLoadedRef   = useRef<{
    time: number; duration: number; watched: number; targetId: string | null;
  }>({ time: 0, duration: 0, watched: 0, targetId: null });
  useEffect(() => {
    playbackRef.current = { time, duration };
    // Never stamp a position the demuxer cannot actually hold. `flushProgress`
    // exempts this snapshot from its truncation guard on the grounds that it
    // is "frozen from before the break by construction" - that is only true if
    // the producer stops refreshing it. Without this the activeTarget-change
    // cleanup writes timeOffset ~= duration straight to the cloud library on
    // exit or on the recovery reload, overwriting the viewer's real resume
    // position with the full runtime. Positions still inside the frozen cached
    // range are genuine and keep updating; only the keep-open
    // `seek_to_last_frame()` value past `cacheEnd` is rejected.
    const cachedEnd = cacheEndRef.current;
    const positionHonest =
      !streamTruncatedRef.current ||
      (cachedEnd != null && time <= cachedEnd + 1);
    if (duration > 0 && time > 0 && positionHonest) {
      lastLoadedRef.current = {
        time,
        duration,
        watched:  watchedElapsedRef.current,
        // activeTargetRef is a render-time mirror, so this is the committed
        // target for the file these ticks belong to.
        targetId: activeTargetRef.current?.id ?? null,
      };
    }
  }, [time, duration, watchedElapsedRef]);
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
  // Continue-Watching is only written after this much GENUINE forward playback
  // (2 minutes). watchedElapsedRef excludes seeks (only sub-cap forward deltas
  // count), so scrubbing / skipping around — including a watch-together sync
  // seek that lands a follower mid-show — never adds a title to Continue
  // Watching without real viewing. The `time` (playhead) gate above stays so
  // the saved resume position is still meaningful.
  const MEANINGFUL_WATCH_S = 120;
  const flushProgress = useCallback(
    (
      sess: UserSession | null,
      target: ActiveScrobbleTarget | null,
      /** Optional frozen position to write INSTEAD of live state. Passed only
       *  by the activeTarget-change cleanup, whose live state already belongs
       *  to the incoming load (see lastLoadedRef). Every other call site is
       *  flushing a file that is still loaded, so it reads live state. */
      snap?: { time: number; duration: number; watched: number },
    ) => {
      const { time, duration } = snap ?? playbackRef.current;
      const watched = snap ? snap.watched : watchedElapsedRef.current;
      if (!sess?.auth_key || !target || duration <= 0) return;
      // A truncated stream's playhead is not a playhead. mpv's keep-open
      // `seek_to_last_frame()` reports `duration`, and both gates below
      // (`time >= 120`, `watched >= 120`) pass trivially on a long episode, so
      // without this the resume position and Continue Watching would be
      // rewritten to the END of an episode the viewer was minutes into. The
      // snapshot path is exempt: it carries a position frozen from before the
      // break by construction. Defence in depth - with the EOS suppression in
      // place the auto-pause that schedules this flush no longer happens.
      if (!snap && streamTruncatedRef.current) {
        console.warn("[library] skipping progress write: stream truncated, playhead is unreliable");
        return;
      }
      // Live TV / trailers: no Continue-Watching / progress write — an `iptv:`
      // or `trailer:` target has no library record and no meaningful resume
      // position (writing one would create a garbage Stremio library entry).
      if (
        target.media_type === "tv" ||
        target.id.startsWith("iptv:") ||
        target.id.startsWith("trailer:")
      ) return;
      if (time < PROGRESS_WARMUP_S) return;
      // Require real watching, not just a playhead parked past the warmup by a
      // seek / party sync. Fixes "skipping around added a show to CW".
      if (watched < MEANINGFUL_WATCH_S) return;
      // Skip if we already wrote this exact second — prevents duplicate writes
      // when pause and unmount fire close together.
      if (Math.abs(time - lastWrittenTime.current) < 1) return;
      lastWrittenTime.current = time;
      // libraryRef (not the `library` state) so this callback stays stable:
      // taking a `library` dep would recreate it on every optimistic patch
      // below, which re-runs the pause-debounce effect on a loop.
      libraryWriteProgress(sess.auth_key, target, libraryRef.current, time, duration)
        .then(() => {
          // Optimistically patch the in-memory library so the resume prompt and
          // Continue Watching see this position WITHOUT a refetch. The only
          // refetch paths are the `aura:library-changed` event and a window
          // `focus` handler, and a single-window desktop app never blurs
          // between play, exit and play again: without this the next resume
          // prompt reads a record that predates the whole session, and a
          // first-time movie (no row at all) never offers Resume.
          //
          // SECONDS here, deliberately. `library` holds normalizeLibrary's
          // output, whose canonical unit is seconds, and the resume prompt
          // reads it as seconds. libraryWriteProgress writes MILLISECONDS to
          // the cloud (Stremio's protocol unit) and the read side converts.
          const recordId  = target.series_id ?? target.id;
          const isEpisode = target.series_id != null && target.series_id !== target.id;
          const stamp     = new Date().toISOString();
          setLibrary((prev) => {
            const idx = prev.findIndex((i) => i.id === recordId);
            if (idx < 0) {
              // Mirror of the auto-tracked row the server just created.
              // `temp: true` matches libraryWriteProgress and keeps it out of
              // the Library grid and the notifications scanner (both skip
              // temp), while Continue Watching (timeOffset > 0) picks it up.
              const row: LibraryItem = {
                id:         recordId,
                media_type: target.media_type,
                name:       target.name,
                poster:     null,
                background: null,
                logo:       target.logo ?? null,
                year:       null,
                removed:    false,
                temp:       true,
                ctime:      stamp,
                mtime:      stamp,
                state: {
                  timeOffset: time,
                  duration,
                  ...(isEpisode ? { video_id: target.id } : {}),
                },
              };
              return [row, ...prev];
            }
            const curr = prev[idx];
            const out  = prev.slice();
            out[idx] = {
              ...curr,
              mtime: stamp,
              state: {
                ...curr.state,
                timeOffset: time,
                duration,
                ...(isEpisode ? { video_id: target.id } : {}),
              },
            };
            return out;
          });
          // Suppress the focus refetch for 5 minutes. Stremio's datastore is
          // eventually consistent on `_mtime`, so a pull right after our write
          // round-trips the OLD state back over the patch above (same reason
          // libraryClearProgress deliberately skips aura:library-changed).
          window.dispatchEvent(new CustomEvent("aura:library-write"));
        })
        .catch((err) => {
          // Never silent: this was the only library_put caller that swallowed
          // everything, including SESSION_EXPIRED, so an expired key meant every
          // resume position for the rest of the session was lost with no trace
          // to grep. Deliberately does NOT call handleSessionExpired: that would
          // log the user out from a background playback timer, mid-episode.
          console.warn(
            `[library] progress write FAILED id=${target.series_id ?? target.id} err=${String(err)}`,
          );
        });
    },
    // Intentionally empty: reads `library` through libraryRef so the callback
    // identity is stable, which keeps the optimistic setLibrary above from
    // re-creating it and re-running the pause-debounce effect in a loop.
    [],
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
      // Flush the OUTGOING target from the frozen snapshot, not live state: on
      // an in-player advance or source switch the live refs already belong to
      // the incoming load (see lastLoadedRef). Only honour the snapshot when it
      // was captured for THIS target, so a snapshot left over from a previous
      // title can never be written into this one's record.
      const outgoing = writebackTarget.current;
      const snap     = lastLoadedRef.current;
      const useSnap  = outgoing != null && snap.targetId === outgoing.id && snap.duration > 0;
      flushProgress(session, outgoing, useSnap ? snap : undefined);
      // Reset the dedup guard for the NEXT target. `flushProgress` skips a
      // write when `time` is within 1 s of `lastWrittenTime` (to coalesce a
      // pause-write and an unmount-write on the same second). Left un-reset
      // across an episode boundary, that guard instead compares the new
      // episode's playhead against the *previous* episode's last write —
      // and when two back-to-back episodes end at a similar playhead
      // (routine in anime binges) it wrongly suppresses the new episode's
      // flush, freezing `state.video_id` on an earlier episode. That stale
      // video_id is what surfaces in Continue Watching as a prior episode
      // stuck "in progress". The -1 sentinel makes the next target's first
      // flush always pass.
      lastWrittenTime.current = -1;
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
    autoAdvanceStreakRef.current = 0; // fresh start: reset the still-watching streak (#5)

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
    if (activeTarget && playedEpisodeId && !isLivePlayback && !isTrailerPlayback) {
      const watched = time;
      const dur     = duration;
      // Same truncation rule as the auto-advance history append above: the
      // reported playhead is `duration` on a dropped stream, so every ratio
      // gate in this block would pass on an unfinished episode.
      const posTrusted = !streamTruncatedRef.current;
      // Both conditions must hold: at least 80 % progress AND at least
      // 5 minutes of fresh playback. The previous OR was over-eager
      // — a 5-minute drive-by on a 2-hour movie (or any 80 %+ resume
      // glance regardless of fresh-content) appended a history entry.
      // AND requires both engagement AND substantive progress, which
      // matches the user's expectation of "I actually watched this."
      const meaningfulRatio = dur > 0 && watched / dur >= 0.80 && posTrusted;
      // Real summed forward-progress, NOT the raw playhead — seeking to
      // the end leaves watchedElapsedRef at ~0 so a skip-to-end episode
      // is correctly excluded from History.
      const meaningfulTime  = watchedElapsedRef.current >= 5 * 60;
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
          anilist_id:      activeTarget.anilist_id ?? null,
          anilist_episode: activeTarget.anilist_episode ?? null,
        });
      }
      // Reset the per-play guard now the History decision for this play
      // is done, so a later re-watch of the same episode in this session
      // logs a fresh row (addHistoryEntry keys on id+played_at).
      autoHistoryWrittenId.current = null;
    }

    // ── Auto-remove-watched hook (the just-finished title) ──
    // Fired AFTER flushProgress above so the removeAll tombstone (deferred in
    // the auto-remove effect) out-mtimes the final progress write and can't be
    // resurrected by Stremio's last-writer-wins merge. Movies count at >=90%
    // (or a manual mark); series count only once advanceWatchedAfter has flipped
    // the root "watched" flag (all aired watched, nothing upcoming, so an
    // ongoing show is never removed). It fires ONLY on a not-watched to watched
    // TRANSITION this session (via watchedAtStartRef), so replaying a title the
    // user chose to keep is never re-removed. The effect re-verifies + gates on
    // the toggle, so dispatching a hair eagerly here is harmless.
    if (activeTarget && !isLivePlayback && !isTrailerPlayback) {
      const settings = loadAuraSettings();
      const rootId = activeTarget.series_id ?? activeTarget.id;
      const mt = (activeTarget.media_type ?? "").toLowerCase();
      const isSeriesLike = mt === "series" || mt === "anime";
      let shouldRemove = false;
      if (isSeriesLike) {
        // Series carry a PERSISTENT completion flag (advanceWatchedAfter sets it
        // only when every aired episode is watched and nothing is upcoming), so
        // removal fires on the not-watched to watched TRANSITION this session:
        // replaying an episode of an already-completed series (flag set at
        // play-start) is not a transition, so it's never re-removed.
        if (settings.libraryAutoRemoveWatchedSeries && getManualWatchedState(rootId) === "watched") {
          const snap = watchedAtStartRef.current;
          const wasWatched = snap && snap.id === rootId ? snap.wasWatched : false;
          shouldRemove = !wasWatched;
        }
      } else {
        // Movies have no persistent completion flag, so a ratio-based "was it
        // watched at start" proxy is unreliable (a peek / another client can
        // park the offset at >=90% without a real watch). Instead remove on a
        // GENUINE completion THIS session: watched most of the runtime forward
        // AND reached the end. watchedElapsedRef sums positive playback deltas
        // and ignores seeks (per-play, reset on load), so seeking to ~95% to
        // peek can't fake a finish, and a movie already parked at >=90% is still
        // removed once genuinely finished. A manual "watched" mark is explicit
        // intent. A full genuine rewatch legitimately removes it again.
        if (settings.libraryAutoRemoveWatchedMovies) {
          // Both halves of this are RATIOS of duration, so a 30 s debrid error
          // clip clears them by simply running out (0.7 * 30 s is 21 s). The
          // absolute floor is what stops a failed resolve auto-removing a film
          // from the library as "finished". See MIN_PLAUSIBLE_TITLE_S.
          const genuineFinish =
            !isImplausiblyShortStream(duration) &&
            !streamTruncatedRef.current &&
            duration > 0 && time / duration >= 0.9 && watchedElapsedRef.current >= 0.7 * duration;
          shouldRemove = genuineFinish || getManualWatchedState(rootId) === "watched";
        }
      }
      if (shouldRemove) {
        window.dispatchEvent(new CustomEvent("aura:library-autoremove-check", { detail: { id: rootId } }));
      }
      watchedAtStartRef.current = null;
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
    setCurrentStream(null);
    setActiveExternalSubs([]);
    // Re-arm the fetch memo alongside the list it guards. Leaving it stamped
    // while the list is cleared meant replaying the SAME title later in the
    // session hit the `subsFetchedFor.current === key` early-return, so the
    // subtitle menu stayed permanently empty of addon tracks until restart.
    subsFetchedFor.current = null;
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
  }, [session, flushProgress, activeTarget, isLivePlayback, isTrailerPlayback, time, duration, library, selectedMeta]);

  // ── Live channel auto-retry (leeway before the broken-stream modal) ──
  // IPTV channels hiccup constantly on the provider side (transient 5xx,
  // brief 404s while the edge re-resolves, max-connection bumps). For a LIVE
  // target, when a load/heartbeat failure flips `streamBroken`, silently
  // reload the channel a couple of times on a short backoff BEFORE surfacing
  // the recovery modal — a momentary blip shouldn't throw the whole "Channel
  // unavailable" popup. A genuinely dead channel exhausts the retries and the
  // modal then shows (with live-specific copy, no "Switch source"). Counter
  // resets per channel; VOD streams keep the immediate-modal behaviour.
  const LIVE_MAX_RETRIES = 2;
  const liveRetryRef = useRef(0);
  // True while a live channel is mid-auto-retry: suppresses the broken-stream
  // modal (we show a subtle "Reconnecting…" indicator instead) so the user
  // doesn't see the popup flash on/off between attempts.
  const [liveReconnecting, setLiveReconnecting] = useState(false);
  useEffect(() => { liveRetryRef.current = 0; setLiveReconnecting(false); }, [activeTarget?.id]);
  useEffect(() => {
    // Not the auto-retry case (resolved / not live / no url / exhausted) →
    // clear the reconnecting flag; if streamBroken is still set + exhausted,
    // the modal shows.
    if (!streamBroken || !isLivePlayback || !activeStreamUrl) { setLiveReconnecting(false); return; }
    if (liveRetryRef.current >= LIVE_MAX_RETRIES) { setLiveReconnecting(false); return; }
    const attempt = liveRetryRef.current + 1;
    liveRetryRef.current = attempt;
    console.info(`[live] channel error — auto-retry ${attempt}/${LIVE_MAX_RETRIES}`);
    // Show "Reconnecting…" instead of the modal for the duration of the wait.
    // NOTE: we deliberately do NOT clear streamBroken here — doing so would
    // change this effect's deps and cancel the timeout via cleanup. The modal
    // is hidden purely via `liveReconnecting`; notifyNewLoad (on fire) clears
    // streamBroken.
    setLiveReconnecting(true);
    const t = window.setTimeout(() => {
      notifyNewLoad();
      // In-place reload: re-arm PlayerOverlay's per-file one-shots (the URL and
      // the target are unchanged, but mpv has re-run loadfile).
      window.dispatchEvent(new Event("aura:player-reloaded"));
      invoke("load_video", {
        path: activeStreamUrl,
        startSeconds: null,
        // Per-file options: without these the retry connects direct and a
        // proxy-gated provider rejects it (see lastProxyUrlRef).
        httpProxy: lastProxyUrlRef.current,
        audioUrl: lastAudioUrlRef.current,
      }).catch((e) => {
        console.error("[live] auto-retry reload failed", e);
      });
    }, 2500);
    return () => window.clearTimeout(t);
    // notifyNewLoad is stable from usePlayback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamBroken, isLivePlayback, activeStreamUrl]);

  // Restore the retry budget once a reconnect HOLDS. Without this the budget
  // is per tune-in, so a channel left on all evening spends its two retries on
  // unrelated hiccups hours apart and then goes modal-first on the third. The
  // hold window (not the first frame alone) is what stops a flapping channel
  // retrying forever: frame-drop-frame-drop never reaches 30 s of stable
  // playback, so it still exhausts and surfaces the modal.
  const LIVE_RETRY_RESET_MS = 30000;
  useEffect(() => {
    if (!isLivePlayback || !firstFrameSeen || streamBroken) return;
    if (liveRetryRef.current === 0) return;
    const t = window.setTimeout(() => { liveRetryRef.current = 0; }, LIVE_RETRY_RESET_MS);
    return () => window.clearTimeout(t);
  }, [isLivePlayback, firstFrameSeen, streamBroken]);

  // ── VOD auto-retry (leeway before the broken-stream modal) ──
  // The twin of the live retry above, for everything that is NOT a live
  // channel. Live got this treatment first and VOD was deliberately left on
  // modal-first, which turned out to be wrong for the commonest failure in a
  // binge: advancing from the Next-Up card or the end-of-stream Spotlight
  // surfaced "Stream connection lost" on an episode that then played fine from
  // the modal's own Reload button, every single time. A freshly minted debrid
  // URL is often still being assembled when mpv issues its first range
  // request, so attempt one is both the likeliest to fail and the cheapest to
  // repeat - and the user was being made to press a button to do exactly what
  // Aura could have done itself.
  //
  // Both detectors feed this: a load that never produced a frame AND a
  // mid-play heartbeat stall. The second is why the budget is restored after a
  // stable hold below, so a three-hour film cannot spend both attempts on a
  // blip in minute two and go modal-first at minute ninety.
  //
  // Trailers are included (a yt-dlp URL expires the same way). Live is
  // excluded here because it has its own loop with its own timings.
  // ── Truncated stream → arm recovery ───────────────────────────────────
  // The recovery machinery below (auto-retry + modal) is correct and was
  // always reachable in principle; the problem was that NOTHING could set
  // `streamBroken` for a dropped origin. mpv reports the drop as a clean EOF
  // and `keep-open-pause=yes` auto-pauses on the last frame, so:
  //   * the 1 Hz stale-heartbeat detector early-returns on `if (paused)`,
  //   * `end-file reason=error` never fires, so the error-grace path never
  //     arms either,
  //   * and the near-end EOS branches cannot fire because the playhead is
  //     nowhere near `duration` (until a forward seek teleports it there,
  //     which is the false end card `fireEos` now suppresses).
  // So this is the missing edge.
  //
  // It is keyed on `truncatedRunout`, NOT on the verdict itself. The verdict
  // lands the moment the origin drops, but mpv keeps playing out of a cache
  // holding up to `cache-secs=180` - reloading then would interrupt minutes of
  // good playback to fix something the viewer cannot see yet. Runout is
  // reached either by the playhead eating the remaining cached runway, or by
  // the heartbeat stopping outright (the 1 Hz detector's truncation branch);
  // whichever comes first.
  //
  // Live TV is excluded for free: the truncation test requires `duration > 0`
  // and a live stream has none, so `streamTruncated` cannot latch there.
  // Why the CURRENT recovery modal is up. `streamTruncated` cannot answer that:
  // every retry calls notifyNewLoad, which clears the verdict, so by the time
  // the attempts are exhausted and the modal actually renders the flag is
  // usually false again and the copy falls back to the generic
  // "connection lost" text. Latched here and released only when the target
  // changes, so the modal explains the failure the viewer actually hit.
  const [breakWasTruncation, setBreakWasTruncation] = useState(false);
  useEffect(() => { setBreakWasTruncation(false); }, [activeTarget?.id]);
  useEffect(() => {
    if (!truncatedRunout || !isPlayerActive) return;
    setBreakWasTruncation(true);
    setStreamBroken(true);
  }, [truncatedRunout, isPlayerActive, setStreamBroken]);

  const VOD_MAX_RETRIES = 2;
  const vodRetryRef = useRef(0);
  // Suppresses the recovery modal while a retry is pending, exactly as
  // liveReconnecting does, so the popup never flashes between attempts.
  const [vodReconnecting, setVodReconnecting] = useState(false);
  useEffect(() => { vodRetryRef.current = 0; setVodReconnecting(false); }, [activeTarget?.id]);
  useEffect(() => {
    if (!streamBroken || isLivePlayback || !activeStreamUrl) { setVodReconnecting(false); return; }
    if (vodRetryRef.current >= VOD_MAX_RETRIES) { setVodReconnecting(false); return; }
    const attempt = vodRetryRef.current + 1;
    vodRetryRef.current = attempt;
    // Resume where the break happened. `ownedTime()` is null when no frame
    // ever arrived for THIS file, which is precisely when the ORIGINAL
    // requested offset is the right answer - without the fallback, retrying a
    // failed resume restarted the episode from the beginning and looked like
    // Aura had lost the position. Sub-1s offsets aren't worth a
    // seek-and-buffer.
    //
    // It MUST be ownedTime() and not `time`: on an episode advance whose
    // stream failed to open, raw `time` still holds the PREVIOUS episode's
    // playhead, and this line then retried the new episode 91% of the way in.
    // ownedTime() already substitutes the last sane position on a truncated
    // stream, so this is safe against the keep-open playhead lie.
    const live = ownedTime();
    const resumeAt = live != null && live > 1 ? live : lastStartSecondsRef.current;
    // Record the offset THIS retry is issued with. notifyNewLoad zeroes `time`,
    // so without it a second attempt (and the modal's Reload after it) reads a
    // ref still holding whatever the ORIGINAL load used - null for anything
    // started from the beginning - and restarts a 40-minutes-in film at 00:00.
    lastStartSecondsRef.current = resumeAt;
    console.info(
      `[playback] stream error - auto-retry ${attempt}/${VOD_MAX_RETRIES}`
      + ` (resume ${resumeAt != null ? `${resumeAt.toFixed(0)}s` : "start"})`,
    );
    setVodReconnecting(true);
    // Short: the detector that got us here already waited out its own grace
    // (20 s for an mpv error, 8 s for a stall), so the transient has had its
    // chance. The second attempt backs off a little further.
    const delay = attempt === 1 ? 800 : 2500;
    // Attempt 1 re-loads the SAME url: cheap, and it is the right answer for a
    // transient (a dropped keep-alive, a 502 while the origin restarts).
    // Attempt 2 RE-RESOLVES from the addon instead, because the failure that
    // motivated this batch cannot be fixed by re-sending the url: an addon
    // proxy token that answers 404 answers 404 forever, and re-issuing it just
    // burns the second attempt. Re-resolving mints a fresh token (and, for
    // debrid, a fresh upstream link), which is the ONLY client-side move with
    // a real chance. Falls back to the plain reload whenever it cannot find
    // the same source again - a wrong source is worse than a retry that fails.
    const reResolve = attempt >= 2 && !isTrailerPlayback && !!activeTarget && !!currentStream;
    // Everything below the timeout is fire-and-forget, and `fetch_streams` can
    // run for tens of seconds while the UI stays interactive (the reconnect
    // pill is pointer-events-none; Escape still exits the player). Without a
    // guard, a re-resolve that lands after the viewer exited or moved to
    // another title yanks them back into the abandoned episode, and a
    // plainReload restarts mpv on a dead url with no player mounted. The
    // effect's cleanup runs on exit / target change, so this flag closes both.
    let cancelled = false;
    const t = window.setTimeout(() => {
      // Deliberately NOT clearing streamBroken here - it is a dep of this
      // effect and clearing it would re-run the cleanup and cancel this very
      // timeout. notifyNewLoad clears it on fire, same as the live path.
      const plainReload = () => {
        if (cancelled) return;
        notifyNewLoad();
        // In-place reload: same URL and target, but mpv has re-run loadfile, so
        // PlayerOverlay's per-file one-shots need the re-arm signal.
        window.dispatchEvent(new Event("aura:player-reloaded"));
        invoke("load_video", {
          path: activeStreamUrl,
          startSeconds: resumeAt,
          contentHdrHint: lastHdrHintRef.current,
          httpProxy: lastProxyUrlRef.current,
          audioUrl: lastAudioUrlRef.current,
        }).catch((e) => {
          console.error("[playback] auto-retry reload failed", e);
        });
      };
      if (cancelled) return;
      if (!reResolve) { plainReload(); return; }
      const tgt = activeTarget!;
      const queryAddons = streamQueryAddons(addons);
      console.info("[playback] auto-retry 2 - re-resolving the source for a fresh link");
      invoke<StreamFetchResult>("fetch_streams", {
        addons: queryAddons,
        mediaType: tgt.media_type,
        id: tgt.id,
      })
        .then((r) => {
          // Re-check liveness AND identity: the closure's `activeTarget` is
          // itself the stale copy, so compare against the render-time mirror.
          if (cancelled || activeTargetRef.current?.id !== tgt.id) {
            console.info("[playback] re-resolve landed after the target changed - discarding");
            return;
          }
          const rows = Array.isArray(r) ? (r as StreamEntry[]) : (r?.streams ?? []);
          // Same identity test the source switcher uses (info_hash, else
          // addon + filename). Matching on url would defeat the point: the
          // whole reason for re-resolving is that the url has changed.
          const match = rows.find((row) => sameStreamSource(row, currentStream));
          if (!match) {
            console.warn("[playback] re-resolve found no matching source - falling back to a plain reload");
            plainReload();
            return;
          }
          // handlePlayStream calls notifyNewLoad itself, but it does NOT fire
          // `aura:player-reloaded` (a normal source switch re-arms
          // PlayerOverlay's per-file one-shots via the changed url in its
          // loadKey). A re-resolve usually yields a fresh url too, but it is
          // not guaranteed to, so fire it explicitly: the nonce is the only
          // thing that re-arms those one-shots when the url comes back
          // identical.
          window.dispatchEvent(new Event("aura:player-reloaded"));
          return handlePlayStream(match, {
            id:         tgt.id,
            series_id:  tgt.series_id,
            media_type: tgt.media_type,
            name:       tgt.name,
            episode:       tgt.episode,
            episode_title: tgt.episode_title,
            season:        tgt.season,
            episode_num:   tgt.episode_num,
            // Same item, same load, so the scoring signals must carry over
            // verbatim. Omitting them nulls activeScoringMeta and the audio
            // scorer drops the "original" priority token, silently resuming
            // the episode on the English dub. Mirrors advanceToEpisode and
            // onPickSource, which re-nest for exactly this reason.
            scoring: activeScoringMeta ?? {
              original_language:    tgt.original_language ?? null,
              production_countries: tgt.production_countries ?? [],
              genres:               tgt.genres ?? undefined,
              country:              null,
            },
          }, { forceStartSeconds: resumeAt ?? 0 });
        })
        .catch((e) => {
          console.error("[playback] re-resolve failed, falling back to a plain reload", e);
          plainReload();
        });
    }, delay);
    // Cancels the pending timer AND disarms anything already in flight.
    return () => { cancelled = true; window.clearTimeout(t); };
    // `time` is read as a snapshot on purpose: the value when the break was
    // detected is the position to resume from, and adding it as a dep would
    // restart this effect (and its timer) on every heartbeat.
    // notifyNewLoad is stable from usePlayback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamBroken, isLivePlayback, activeStreamUrl]);

  // Restore the VOD retry budget once playback HOLDS, mirroring the live rule
  // above and for the same reason: per-load budget on a long film is spent by
  // unrelated hiccups hours apart. A stream that flaps never reaches 30 s of
  // stable playback, so it still exhausts its attempts and surfaces the modal.
  useEffect(() => {
    if (isLivePlayback || !firstFrameSeen || streamBroken) return;
    if (vodRetryRef.current === 0) return;
    const t = window.setTimeout(() => {
      // Checked at FIRE time, not effect time: a stream can truncate part-way
      // through this 30 s window. Thirty seconds of playback out of a frozen
      // cache is not "playback holding" - refunding the budget for it means a
      // repeatedly-truncating source relives attempt 1 (reload the same url)
      // forever and never escalates to attempt 2's re-resolve, which is the
      // only attempt that can actually fix a dead link.
      if (streamTruncatedRef.current) return;
      vodRetryRef.current = 0;
    }, LIVE_RETRY_RESET_MS);
    return () => window.clearTimeout(t);
  }, [isLivePlayback, firstFrameSeen, streamBroken, streamTruncatedRef]);

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
    // Drop the Next-Up card along with the end screen. activeTarget.id does not
    // change on a replay, so nextUpVisible would otherwise stay true and the
    // card would re-mount at t=0 of the replay with a freshly armed countdown,
    // yanking the user into the next episode seconds after they asked to watch
    // this one again. The normal ED / lead-time trigger re-arms it legitimately
    // when the replay reaches its own end.
    setNextUpVisible(false);
    // A replay is a fresh watch of the same file. `activeTarget.id` does not
    // change, so the per-episode reset effect never runs and a refusal from the
    // first pass would otherwise disable auto-advance for the whole replay too.
    setAutoAdvanceCancelled(false);
    autoAdvanceStreakRef.current = 0;
    notifyNewLoad();
    // A replay is issued from 0, so clear the "offset this load was issued
    // with" fallback that the auto-retry and the recovery modal's Reload read.
    // Left holding the previous pass's resume offset, a replay that dies before
    // producing a frame gets retried at 01:20:00 of a film the user just asked
    // to watch again from the top, landing them back on the end card.
    lastStartSecondsRef.current = null;
    // In-place reload: activeTarget.id and activeStreamUrl are both unchanged,
    // so PlayerOverlay's per-file one-shots need an explicit re-arm signal.
    window.dispatchEvent(new Event("aura:player-reloaded"));
    try {
      await invoke("load_video", {
        path: activeStreamUrl,
        startSeconds: null,
        contentHdrHint: lastHdrHintRef.current,
        httpProxy: lastProxyUrlRef.current,
        // Per-file, like http-proxy: omitting it clears mpv's `audio-files`,
        // so replaying a 1080p+ trailer would come back silent.
        audioUrl: lastAudioUrlRef.current,
      });
    } catch (e) {
      console.error("[eos] replay failed", e);
    }
  }, [activeStreamUrl, handleExitPlayback, notifyNewLoad]);

  // "Play Next" reuses onNextUpPlay (carries this pass's History/
  // scrobble append + target build + handlePlayStream swap unchanged).
  // `auto` distinguishes the EOS auto-advance countdown (counts toward the
  // "Still watching?" gate, #5) from a manual click (resets the streak). The
  // streak also resets on exit (handleExitPlayback).
  const autoAdvanceStreakRef = useRef(0);
  /** "The user has EXPLICITLY refused an auto-advance for this episode." Owned
   *  here, not by the cards, because there are TWO surfaces that arm the same
   *  countdown and the small NextUpCta is unmounted the moment the end-of-stream
   *  Spotlight takes over. A refusal latched inside the card died with it, and
   *  the Spotlight then counted down and advanced anyway.
   *
   *  Set only by an explicit dismiss, never by ambient activity: a mouse move
   *  cancels that card's countdown locally, but it is attention rather than a
   *  decision, and lifting it here would let one incidental jiggle during the
   *  credits disable auto-advance for the end card too. Cleared per episode
   *  alongside the other next-up state, and on an in-place replay. */
  const [autoAdvanceCancelled, setAutoAdvanceCancelled] = useState(false);
  const onEosPlayNext = useCallback((auto: boolean) => {
    autoAdvanceStreakRef.current = auto ? autoAdvanceStreakRef.current + 1 : 0;
    void onNextUpPlay();
  }, [onNextUpPlay]);

  // "Skip to canon" from the Spotlight — same streak bookkeeping as Play Next,
  // routes through onNextUpSkip (History append + swap unchanged).
  const onEosSkipToCanon = useCallback((auto: boolean) => {
    autoAdvanceStreakRef.current = auto ? autoAdvanceStreakRef.current + 1 : 0;
    void onNextUpSkip(auto);
  }, [onNextUpSkip]);

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
  const onEosDismiss = useCallback(() => {
    // Dismissing the end screen must not hand the decision back to the small
    // Next-Up card. That card is a fresh mount when the Spotlight goes away, so
    // its "user cancelled the countdown" latch is empty and a countdown the
    // user already declined re-arms on the frozen final frame. Latch the
    // dismiss for this episode instead. Escape is the worst case: the keydown
    // lands before the card mounts, so no cancel listener would ever see it.
    if (activeTarget) nextUpDismissedFor.current = activeTarget.id;
    // Dismissing the end card is someone being present, which is the only thing
    // the still-watching streak measures. Leaving it counting meant a viewer who
    // kept clicking through end cards still got told "Auto-play paused after a
    // few episodes" as though they had fallen asleep.
    autoAdvanceStreakRef.current = 0;
    setNextUpVisible(false);
    setEosActive(false);
  }, [activeTarget]);

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
  // Notification deep-link ring: set ONLY by the notifications → open-meta path,
  // so a normal post-playback return (which also uses lastPlayedEpisodeId for
  // season select + scroll) does NOT get the selection ring.
  const [deepLinkEpisodeId, setDeepLinkEpisodeId] = useState<string | null>(null);
  const consumeDeepLinkEpisode = useCallback(() => setDeepLinkEpisodeId(null), []);

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

  // (The per-content HDR target-peak probe that used to live here is
  // deliberately GONE. Lesson from hardware: ANY runtime write into the
  // HDR option set — even a single target-peak — destabilises the live
  // gpu-next d3d11 pipeline into blown-out output. The HDR modes are
  // now fully static per mode (player::apply_hdr_options): passthrough
  // forces a PQ swapchain at init and lets MPV tone-map everything to
  // the panel's real peak, so nothing needs to change per content.)

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
    // Suppress presence while the window is hidden (minimized / tray): nobody is
    // looking at the app, so skip the RPC churn + reconnect attempts. The effect
    // re-runs on restore (windowHidden is in the deps) and re-asserts presence.
    if (!authChecked || onLanding || windowHidden) {
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

    if (isLivePlayback && activeTarget) {
      // Live TV — duration is 0, so it never reaches the VOD branch below.
      // Show the channel + an elapsed-since-tune-in timer; the backend's
      // show_titles / blocklist gates apply because is_playback is true.
      isPlayback = true;
      title = activeTarget.name;
      subtitle = paused ? "Live TV · Paused" : "Watching Live TV";
      sceneKey = `live:${activeTarget.id}`;
      useTimestamp = !paused;
      // Channel logo only when HTTPS — Discord rejects raw http image URLs;
      // otherwise the backend falls back to the Aura logo.
      const logo = activeTarget.logo ?? null;
      largeImage = logo && logo.startsWith("https://") ? logo : null;
      largeText = activeTarget.name;
    } else if (isTrailerPlayback && activeTarget) {
      // Trailer — a short clip, not a watch session. Advertise it distinctly
      // (and BEFORE the VOD branch) so it doesn't read as "watching the movie".
      isPlayback = true;
      title = activeTarget.name;
      subtitle = paused ? "Trailer · Paused" : "Watching a trailer";
      sceneKey = `trailer:${activeTarget.id}`;
      useTimestamp = !paused;
    } else if (activeTarget && duration > 0) {
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
        case "home":     title = "Browsing the Home Screen";  subtitle = "On Home";      sceneKey = "home";     break;
        case "discover": title = "Browsing Add-on Catalogs";  subtitle = "On Discover";  sceneKey = "discover"; break;
        case "library":  title = "Revisiting Old Favorites";  subtitle = "In Library";   sceneKey = "library";  break;
        case "queue":    title = "Lining Up What's Next";     subtitle = "In Queue";     sceneKey = "queue";    break;
        case "airing":   title = "Catching Up on Airing Shows"; subtitle = "On Airing";  sceneKey = "airing";   break;
        case "live":     title = "Browsing Live TV";          subtitle = "On Live TV";   sceneKey = "live";     break;
        case "calendar": title = "Planning My Next Binge";    subtitle = "On Calendar";  sceneKey = "calendar"; break;
        case "history":  title = "Looking Through History";   subtitle = "In History";   sceneKey = "history";  break;
        case "addons":   title = "Exploring Add-ons";         subtitle = "In Add-ons";   sceneKey = "addons";   break;
        case "settings": title = "Tuning Preferences";        subtitle = "In Settings";  sceneKey = "settings"; break;
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
    if (isPlayback && useTimestamp && time > 0 && !isLivePlayback) {
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
    authChecked, session, landingDismissed, windowHidden,
    activeTarget, duration, paused, isLivePlayback, isTrailerPlayback,
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
      onOpenMeta={(metaId, mediaType, videoId) => {
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
        if (videoId) {
          setLastPlayedEpisodeId(videoId); // season select + scroll-to-row
          setDeepLinkEpisodeId(videoId);   // selection ring (notification only)
        }
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

      {/* (The old "FSO gap cover" strip is gone: the engine consolidation
          moved playback to --wid embedding, where mpv's own DXGI swapchain
          opts out of Win11's Independent-Flip promotion, so the engine
          surface covers the full monitor again and there is no 1px gap.) */}

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
      {/* `key={activeView}` is what makes the fade replay: only one view is
          mounted at a time and switching already unmounts the old one, so the
          key changes nothing structurally, it just gives the wrapper a fresh
          identity per view so the enter animation re-triggers.
          .aura-view-enter is opacity-only ON PURPOSE - see the note on it in
          App.css before adding any transform here. */}
      <div
        key={activeView}
        className="aura-view-enter flex-1 flex flex-col min-w-0 overflow-hidden"
      >
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
            onAutoRemoveSweep={handleAutoRemoveSweep}
          />
        )}
        {activeView === "addons" && (
          <AddonsView
            addons={addons}
            session={session}
            onAdd={handleAddonAdded}
            onRemove={handleAddonRemoved}
            onReorder={handleAddonsReorder}
            onLoginSuccess={handleLoginSuccess}
            onLogout={handleLogout}
            onSessionExpired={handleSessionExpired}
          />
        )}
        {activeView === "discover" && (
          <DiscoverView addons={addons} onSelectMeta={openDetail} />
        )}
        {activeView === "live" && (
          <LiveView
            active={activeView === "live"}
            playerActive={isPlayerActive}
            onPlayChannel={handlePlayChannel}
          />
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
        {activeView === "airing" && (
          <AiringView library={library} addons={addons} onSelectMeta={openDetail} />
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
      <PartyButton />
      {/* "Vote to Watch" stack — active polls + won winners + cap errors.
          Renders nothing unless in a party with something to show. Suppressed
          on detail pages / during playback so it never overlaps the
          stream/episode selector or the player chrome. */}
      <PartyVotesOverlay suppressed={!!selectedMeta || isPlayerActive} />

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
      {/* Subtle "Reconnecting…" indicator shown while a live channel is
          mid-auto-retry — replaces the full broken-stream modal so the popup
          doesn't flash on/off between attempts. */}
      {(liveReconnecting || vodReconnecting) && isPlayerActive && (
        <div className="fixed inset-0 z-[10500] flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl
                          bg-black/70 backdrop-blur-md border border-white/12 text-white/85">
            <span className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-ln-accent animate-spin" />
            <span className="text-[13px] font-medium">
              {liveReconnecting ? "Reconnecting to channel…" : "Reconnecting to stream…"}
            </span>
          </div>
        </div>
      )}

      {/* `!switcherOpen`: the recovery modal's own "Switch source" button opens
          the in-player source switcher WITHOUT issuing a new load_video, so the
          original (dead) stream is still being watched by the stale-heartbeat
          detector — which keeps re-flipping `streamBroken` true (its
          lastTimeUpdateAtRef is already past BROKEN_STALE_MS). Without this gate
          the z-[10500] modal re-renders over the open z-[10001] switcher within
          ~1 s, which reads as "the switch-source menu closed itself". Suppress
          the modal for as long as the switcher is up; picking a source clears
          streamBroken via notifyNewLoad, and closing without a pick correctly
          re-surfaces it (the stream genuinely is still broken). */}
      {streamBroken && isPlayerActive && !liveReconnecting && !vodReconnecting && !switcherOpen && (
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
              {isLivePlayback
                ? (firstFrameSeen ? "Channel connection lost" : "Channel unavailable")
                : (breakWasTruncation
                    ? "Stream ended early"
                    : firstFrameSeen ? "Stream connection lost" : "Stream unavailable")}
            </h2>
            <p className="text-white/70 text-[13px] leading-relaxed mb-5">
              {isLivePlayback
                ? (firstFrameSeen
                    ? "This channel dropped its connection. Live streams can hiccup on the provider side — Aura already retried a couple of times. Reload to try again, or exit and pick another channel."
                    : "Aura couldn't open this channel (the provider returned an error — often a removed or temporarily-down channel). Aura already retried a couple of times. Reload to try again, or exit and pick another channel.")
                : breakWasTruncation
                    ? "The source stopped sending data partway through, so the rest of this episode never arrived. Aura already retried and re-resolved the source. Reloading resumes from where the stream cut out; switching source is usually the faster fix."
                    : (firstFrameSeen
                        ? "Aura hasn't received a playback heartbeat in 8 s and retried a couple of times. The most common cause is a transient DNS / TCP failure during a seek. Try reloading from your last position, or exit and pick another source."
                        : "Aura couldn't open the stream, and retrying a couple of times didn't help. The addon's host may be down or unreachable (DNS / TCP failure). Try reloading, or pick a different source.")}
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
              {/* "Switch source" is meaningless for a Live TV channel (one
                  URL, no alternate-source list) or a trailer (single yt-dlp
                  URL), so it's hidden for both — the user picks a different
                  CHANNEL from the grid / exits the trailer instead. */}
              {!isLivePlayback && !isTrailerPlayback && (
                <button
                  type="button"
                  onClick={() => {
                    // Dismiss the recovery modal and open the in-player source
                    // switcher — when a stream dies, picking a different source
                    // is usually the real fix (the switcher swaps in place at
                    // the last-known position via handlePlayStream).
                    setStreamBroken(false);
                    window.dispatchEvent(new CustomEvent("aura:open-source-switcher"));
                  }}
                  className="px-4 py-2 rounded-lg text-[13px] font-medium tracking-wide
                             text-white/85 bg-white/[0.06] border border-white/12
                             hover:bg-white/[0.10] hover:text-white transition-colors"
                >
                  Switch source
                </button>
              )}
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
                  // notice the position difference anyway. Falls back to the
                  // offset this load was ISSUED with: on a load that never
                  // produced a frame there is no owned position, and reloading
                  // from 0 threw away the resume position the user had just
                  // accepted. ownedTime(), never raw `time` - see the VOD
                  // auto-retry for what a cross-episode position does here.
                  const live = ownedTime();
                  const resumeAt = live != null && live > 1 ? live : lastStartSecondsRef.current;
                  // Same reason as the auto-retry: this load is now the one
                  // that was ISSUED with resumeAt, so a second press of Reload
                  // inherits it instead of falling back to null.
                  lastStartSecondsRef.current = resumeAt;
                  setStreamBroken(false);
                  notifyNewLoad();
                  // In-place reload: re-arm PlayerOverlay's per-file one-shots.
                  window.dispatchEvent(new Event("aura:player-reloaded"));
                  try {
                    await invoke("load_video", {
                      path: activeStreamUrl,
                      startSeconds: resumeAt,
                      contentHdrHint: lastHdrHintRef.current,
                      httpProxy: lastProxyUrlRef.current,
                      audioUrl: lastAudioUrlRef.current,
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
          isAnime={activeTarget ? activeTargetIsAnime(activeTarget, library) : false}
          isLive={isLivePlayback}
          isTrailer={isTrailerPlayback}
          trailerQuality={trailerQuality}
          trailerQualityLabel={trailerQualityLabel}
          trailerMaxHeight={trailerMaxHeight}
          isTrailerResolving={isTrailerResolving}
          onSetTrailerQuality={handleSetTrailerQuality}
          time={time}
          duration={duration}
          paused={paused}
          volume={volume}
          speed={speed}
          buffering={buffering}
          bufferPct={bufferPct}
          seekLoading={seekLoading}
          firstFrameSeen={firstFrameSeen}
          // True when we're a non-leader synced to the party — the transport
          // controls (play/pause/seek/skip/speed) disable with a "Leader
          // controls playback" hint; local-only controls stay live.
          partyFollower={reactiveParty.status === "connected" && !reactiveParty.isLeader && reactiveParty.inSync}
          onControlsVisibleChange={setPlayerControlsVisible}
          togglePause={wtTogglePause}
          seekRelative={wtSeekRelative}
          seekAbsolute={wtSeekAbsolute}
          commitVolume={commitVolumeAndSave}
          commitSpeed={wtCommitSpeed}
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

      {/* Watch-party HUD — presence cluster + the "waiting for the party"
          staging banner (host gets a Start-now override). */}
      {isPlayerActive && (
        <PlayerPartyHud onStart={wtStartParty} isFullscreen={isFullscreen} controlsVisible={playerControlsVisible} />
      )}

      {/* First-run playback-engine (libmpv) download gate. Self-hides unless a
          fresh install needs to fetch libmpv before the engine can start. */}
      <PlaybackEngineGate />

      {/* In-player source switcher — sibling to PlayerOverlay; its own root is
          fixed + z-[10001] (above PlayerOverlay's z-[9999]). */}
      {activeTarget && (
        <SourceSwitcher
          open={switcherOpen}
          onClose={() => setSwitcherOpen(false)}
          streams={switcherStreams}
          currentStream={currentStream}
          loading={switcherLoading}
          onPick={onPickSource}
          resolvingKey={switcherResolvingKey}
          isFullscreen={isFullscreen}
        />
      )}

      {/* Cast device picker + session bar — same sibling/z-layer pattern
          as the source switcher. The bar shows while a cast session is
          active (local MPV paused underneath). */}
      {activeTarget && (
        <CastMenu
          open={cast.menuOpen}
          onClose={cast.closeMenu}
          devices={cast.devices}
          scanning={cast.scanning}
          onRescan={cast.rescan}
          onPick={cast.pickDevice}
          connectingId={cast.connectingId}
          error={cast.error}
          isFullscreen={isFullscreen}
        />
      )}

      {/* Watch-Together room panel — opened from the More menu. Available
          whenever the app is up (you can set the relay URL / create a room
          before playback), so it's not gated on activeTarget. */}
      <WatchTogetherPanel open={watchPanelOpen} onClose={() => setWatchPanelOpen(false)} />
      {cast.activeDevice && (
        <CastSessionBar
          deviceName={cast.activeDevice.name}
          status={cast.status}
          onTogglePlayPause={cast.togglePlayPause}
          onSeekBy={cast.seekBy}
          onStop={cast.stopCasting}
          isFullscreen={isFullscreen}
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
          libraryById={libraryById}
          loading={false}
          noStream={nextUpInfo.stream == null}
          skipTag={nextUpInfo.canon ? formatEpisodeTag(nextUpInfo.canon.episode) : null}
          // Routed through the EOS handlers, not the raw onNextUp* ones, so the
          // still-watching streak has a writer on the path that actually fires
          // during a binge. This card triggers a lead-time before the end of
          // the file, so an unattended chain never reaches EOF and the
          // Spotlight (previously the only surface that incremented the
          // streak) never got a turn: the gate was dead code in exactly the
          // scenario it exists for.
          onSkipToCanon={nextUpInfo.canon ? onEosSkipToCanon : undefined}
          // The canon episode itself, so the card can preview what a skip
          // would jump to on hover.
          canonEpisode={nextUpInfo.canon?.episode ?? null}
          skipCount={nextUpInfo.canon?.skipped.length ?? 0}
          // WHICH BUTTON THE UNATTENDED COUNTDOWN AIMS AT. This is the only
          // thing the filler / recap preference decides now. Kind-specific, so
          // "filler" does not silently jump a recap.
          autoSkipsToCanon={
            !!nextUpInfo.canon
            && autoSkipApplies(loadAuraSettings().nextUpSkipFillerRecap, nextUpInfo.episode)
          }
          onPlay={onEosPlayNext}
          onDismiss={onNextUpDismiss}
          autoAdvanceStreak={autoAdvanceStreakRef.current}
          autoAdvanceCancelled={autoAdvanceCancelled}
          arcNote={arcNote}
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
            nextAirTargetMs={eosNextAirMs}
            seriesArt={seriesArt}
            libraryById={libraryById}
            onPlayNext={onEosPlayNext}
            skipTag={nextEp && nextUpInfo?.canon ? formatEpisodeTag(nextUpInfo.canon.episode) : null}
            onSkipToCanon={onEosSkipToCanon}
            canonEpisode={nextEp ? (nextUpInfo?.canon?.episode ?? null) : null}
            skipCount={nextEp ? (nextUpInfo?.canon?.skipped.length ?? 0) : 0}
            autoSkipsToCanon={
              !!nextEp && !!nextUpInfo?.canon
              && autoSkipApplies(loadAuraSettings().nextUpSkipFillerRecap, nextEp)
            }
            arcNote={arcNote}
            autoAdvanceStreak={autoAdvanceStreakRef.current}
            autoAdvanceCancelled={autoAdvanceCancelled}
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
          // KEYED, and this is load-bearing rather than a micro-optimisation in
          // reverse. Swapping `selectedMeta` in place (a Related-tab click, a
          // Watch-Together openVideo, a notification deep-link onto an already
          // open page) is a PROP change, so React reuses the same DetailViewBody
          // and every mount-only initializer stays frozen on the previous
          // title: activeVideo, panelMode, revealedSynopses, the openOnEpisode
          // and highlight snapshots, plus EpisodesPanel's own season, grouping
          // and four consume-once refs. The page then rendered as a hybrid of
          // two shows, and Play on that page wrote the OLD episode id under the
          // NEW series root. Resetting those by hand is not an option: half of
          // them live in a child this component cannot reach, and the next
          // field anyone adds would silently miss the list. `media_type` is in
          // the key because isEpisodic, the meta URL and the stream fetch all
          // fork on it, so a same-id type change has to remount too.
          key={`${selectedMeta.media_type}:${selectedMeta.id}`}
          meta={selectedMeta}
          addons={addons}
          fromRect={selectedRect}
          partyStreamKey={reactiveParty.status === "connected" ? reactiveParty.roomStreamKey : null}
          onClose={closeDetail}
          onPlayStream={handlePlayStream}
          onSearchByName={(name) => {
            // Cast / crew / staff / related-title click: flip to Home and queue
            // the name as the search query. DetailView calls onClose() right
            // after this, so setDeepLinkSearch must be called first to ensure
            // HomeView's externalQuery effect picks it up on the next render.
            setActiveView("home");
            setActiveCatalog(null);
            setDeepLinkSearch(name);
          }}
          inLibrary={library.some((i) => i.id === selectedMeta.id && !i.removed)}
          onLibraryToggle={(origin) => handleLibraryToggle(selectedMeta, origin)}
          onQueueToggle={(origin) => {
            // Same behaviour as the catalog context menu's Mark as Planned, on
            // purpose: the queue has ONE rule set and two entry points, rather
            // than two implementations that can drift. Auto-add to library on
            // queue is part of that rule set, skipped when already in the
            // library so the toggle's own confirm toast does not fire twice.
            const isPlanned = getManualWatchedState(selectedMeta.id) === "planned";
            const next = isPlanned ? null : "planned";
            setManualWatchedState(selectedMeta.id, next);
            showFlyUpToast(
              next
                ? `Added to Queue · ${selectedMeta.name}`
                : `Removed from Queue · ${selectedMeta.name}`,
              {
                x: origin?.x ?? window.innerWidth / 2,
                y: origin?.y ?? window.innerHeight / 2,
                tone: next ? "success" : "default",
              },
            );
            const inLib = library.some((i) => i.id === selectedMeta.id && !i.removed);
            if (next === "planned" && session?.auth_key && !inLib) {
              handleLibraryToggle(selectedMeta);
            }
          }}
          onPlayTrailer={handlePlayTrailer}
          openOnEpisodeId={lastPlayedEpisodeId}
          ignoreResumeHint={ignoreResumeOnNextOpen}
          onConsumeOpenHint={consumeLastPlayedEpisode}
          highlightEpisodeId={deepLinkEpisodeId}
          onConsumeHighlight={consumeDeepLinkEpisode}
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

      {/* Bulk-scrobble progress. Mounted HERE, not in HistoryView: the job is a
          module-level singleton that outlives the page, so a bar owned by the
          view would vanish on navigation while the run kept firing requests
          invisibly. Renders nothing when no run is in flight.

          Suppressed (hidden, never stopped) while a stream or trailer is playing,
          where it would sit on top of the video, and while the close prompt is up,
          which renders its own copy of the progress. */}
      <ScrobbleRunBar suppressed={isPlayerActive || scrobbleClosePromptOpen} />

      {/* Answers Rust's refusal to close the window mid-scrobble. */}
      <ScrobbleClosePrompt onOpenChange={setScrobbleClosePromptOpen} />

      {/* Fly-up toast — spawns at the click point and floats upward.
          Fed by showFlyUpToast(); used for library add/remove feedback
          so the action visibly originates from where the user clicked. */}
      <FlyUpToastHost />

      {/* Party-activity toasts — spawn from the party icon's side and stack
          downward. Fed by showPartyToast() (joins / leaves / host changes). */}
      <PartyToastHost />

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
  onOpenMeta: (metaId: string, mediaType?: string, videoId?: string) => void;
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
  // payload is `{ metaId, videoId?, mediaType? }`. We thread `videoId` through
  // so an episode-release notification lands on the right season and scrolls
  // to + rings that episode (onOpenMeta sets the season/scroll hint AND the
  // notification-only selection ring).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        metaId?: string;
        mediaType?: string;
        videoId?: string;
      } | undefined;
      if (!detail?.metaId) return;
      onOpenMeta(detail.metaId, detail.mediaType, detail.videoId);
    };
    window.addEventListener("aura:open-meta", handler);
    return () => window.removeEventListener("aura:open-meta", handler);
  }, [onOpenMeta]);

  // aura:notify-force — DevConsole `notifyforce` command path. Bypasses
  // the scanner + cloud entirely and pushes a synthesized notification
  // through addNotification directly. Detail shape mirrors what the
  // scanner would emit: { id, kind, title, subtitle?, data? }. Used to
  // validate the bell/popup pipeline end-to-end when the cloud signal
  // is empty (or the user just wants to see the UI fire).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        id?: string;
        kind?: "release" | "episode" | "notice" | "success" | "warning" | "error";
        title?: string;
        subtitle?: string;
        data?: Record<string, unknown>;
      } | undefined;
      if (!detail?.id || !detail.kind || !detail.title) return;
      addNotification({
        id:       detail.id,
        kind:     detail.kind,
        title:    detail.title,
        subtitle: detail.subtitle,
        data:     detail.data,
      });
    };
    window.addEventListener("aura:notify-force", handler);
    return () => window.removeEventListener("aura:notify-force", handler);
  }, [addNotification]);

  return (
    <NotificationsScanner
      addons={addons}
      library={library}
    />
  );
}
