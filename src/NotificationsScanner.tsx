// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, LibraryItem } from "./types";
import { loadAuraSettings } from "./auraSettings";
import { useNotifications } from "./NotificationsContext";
import {
  getReleaseSignal,
  useReleaseSignalsVersion,
} from "./releaseSignalStore";
import { reconcileLibraryReleaseSignals } from "./releaseSignalStore";
import type { ReleaseAired } from "./releaseSearch";

// ---------------------------------------------------------------------------
// useNotificationsScanner — cloud-signal driven (v3).
//
// History (in case this needs to be redesigned later):
//   • v1: ran on activeView==="home" gate only — users who lived in
//     Library / Calendar / Settings never saw notifications.
//   • v2: removed view gate, walked addon-probe meta per library item
//     every 30 min. Redundant with Aura Cloud's release poller doing
//     the same probe globally — and the per-user probe can't see new
//     episodes when AIOMetadata's local cache is cold.
//   • v3 (this file): driven entirely by `releaseSignalStore`. The
//     cloud is the single source of truth. The desktop walks each
//     signal's `recent_aired` array (every aired episode within the
//     last 365 days) and fires one notification per episode newer
//     than its local "last seen" record. Stacked notifications fall
//     out naturally — three episodes that aired between sessions
//     surface as three notifications, not one.
//   • Migration from v2 (now): on first v3 boot, wipe the prior
//     scanner state so v2's per-item addon-probe tracking doesn't
//     produce phantom "you have a new episode" alerts for season
//     finales of completed shows. Subsequent first-scan-per-series
//     seeding uses the cloud signal's `last_aired.aired_at` plus a
//     library `state.video_id` cross-check, so we don't notify the
//     user about an episode they've already watched even on a
//     truly first scan.
//
// Periodic refresh: in addition to reacting to store version bumps,
// the scanner refreshes signals on a 7-minute interval while the app
// is open (§6.0 "5–10 min recommended"). The cloud serves these from
// cache cheaply; the §10.1 batch-ETag short-circuit will land later
// to reduce the bandwidth further.
//
// Stream-availability gate: when `notifyOnlyWithStreams` is on, the
// scanner records new episodes as "pending stream check" instead of
// notifying immediately, and a 15-min timer re-checks fetch_streams
// for each pending entry. First time streams come back, the
// notification fires. Pending state is persisted so it survives
// app restarts.
//
// Persisted state (localStorage `aura:notifications:scanner-state`):
//   {
//     "tt22248376": {
//       lastChecked: <ms epoch>,
//       seenVideoIds: ["tt22248376:2:7", ...],
//       // ms epoch of the newest aired_at we've already notified
//       // for. Used as the diff baseline against recent_aired so we
//       // don't re-fire on a new poller tick that returns the same
//       // already-notified episodes.
//       lastNotifiedAt: <ms epoch>,
//       // Episodes seen via cloud signal but withheld because
//       // notifyOnlyWithStreams was on and no streams were available
//       // yet. The 15-min timer retries fetch_streams for these and
//       // promotes to seenVideoIds + fires the notification once
//       // streams appear.
//       pendingStreamCheck?: [
//         { videoId, aired_at, season, episode, recordedAt }
//       ]
//     }
//   }
// ---------------------------------------------------------------------------

const SCANNER_STATE_KEY = "aura:notifications:scanner-state";
const SCANNER_VERSION_KEY = "aura:notifications:scanner-version";
const CURRENT_SCANNER_VERSION = "3";
const STREAM_AVAILABILITY_KEY = "aura:notifications:stream-availability";
const STREAM_AVAILABILITY_TTL_MS = 12 * 60 * 60 * 1000;
const PERIODIC_REFRESH_MS = 7 * 60 * 1000;
const STREAM_RECHECK_MS = 15 * 60 * 1000;
const PENDING_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface PendingStreamCheck {
  videoId: string;
  airedAtMs: number;
  season: number | null;
  episode: number | null;
  recordedAtMs: number;
}

interface ScannerItemState {
  lastChecked: number;
  seenVideoIds: string[];
  lastNotifiedAt?: number;
  pendingStreamCheck?: PendingStreamCheck[];
}

type ScannerState = Record<string, ScannerItemState>;

interface StreamAvailabilityEntry {
  hasStreams: boolean;
  ts: number;
}

type StreamAvailabilityCache = Record<string, StreamAvailabilityEntry>;

function loadScannerState(): ScannerState {
  try {
    const raw = localStorage.getItem(SCANNER_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: ScannerState = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const s = v as Record<string, unknown>;
      const lastChecked = typeof s.lastChecked === "number" ? s.lastChecked : 0;
      const seen = Array.isArray(s.seenVideoIds)
        ? (s.seenVideoIds as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const lastNotifiedAt = typeof s.lastNotifiedAt === "number" ? s.lastNotifiedAt : undefined;
      const pending = Array.isArray(s.pendingStreamCheck)
        ? (s.pendingStreamCheck as unknown[])
            .map((p) => {
              if (!p || typeof p !== "object") return null;
              const o = p as Record<string, unknown>;
              const videoId = typeof o.videoId === "string" ? o.videoId : null;
              const airedAtMs = typeof o.airedAtMs === "number" ? o.airedAtMs : null;
              const season = typeof o.season === "number" ? o.season : null;
              const episode = typeof o.episode === "number" ? o.episode : null;
              const recordedAtMs = typeof o.recordedAtMs === "number" ? o.recordedAtMs : Date.now();
              if (!videoId || airedAtMs == null) return null;
              return { videoId, airedAtMs, season, episode, recordedAtMs } satisfies PendingStreamCheck;
            })
            .filter((p): p is PendingStreamCheck => p !== null)
        : undefined;
      out[k] = { lastChecked, seenVideoIds: seen, lastNotifiedAt, pendingStreamCheck: pending };
    }
    return out;
  } catch {
    return {};
  }
}

function saveScannerState(state: ScannerState) {
  try {
    localStorage.setItem(SCANNER_STATE_KEY, JSON.stringify(state));
  } catch {
    // quota / private mode — non-fatal
  }
}

/** Migration gate — v2 left stale `seenVideoIds` blobs that don't
 *  align with cloud-signal id shapes. On v3 first boot, wipe the
 *  scanner state so the new scan path seeds from cloud + library
 *  cross-check rather than firing notifications for season finales
 *  the user already watched. Idempotent: re-runs only if the stored
 *  version is missing or doesn't match `CURRENT_SCANNER_VERSION`. */
function maybeMigrateScannerState(): void {
  try {
    const stored = localStorage.getItem(SCANNER_VERSION_KEY);
    if (stored === CURRENT_SCANNER_VERSION) return;
    localStorage.removeItem(SCANNER_STATE_KEY);
    localStorage.setItem(SCANNER_VERSION_KEY, CURRENT_SCANNER_VERSION);
    // Best-effort log so the user sees this happened once.
    console.info("[notifications] v3 migration — cleared prior scanner state");
  } catch {
    // localStorage unavailable — leave migration unmarked; will
    // retry next launch. Worst case the user dismisses a few
    // notifications once.
  }
}

function loadStreamAvailability(): StreamAvailabilityCache {
  try {
    const raw = localStorage.getItem(STREAM_AVAILABILITY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const evictBefore = now - STREAM_AVAILABILITY_TTL_MS * 2;
    const out: StreamAvailabilityCache = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const e = v as Record<string, unknown>;
      const ts = typeof e.ts === "number" ? e.ts : 0;
      if (ts < evictBefore) continue;
      const hasStreams = e.hasStreams === true;
      out[k] = { hasStreams, ts };
    }
    return out;
  } catch {
    return {};
  }
}

function saveStreamAvailability(cache: StreamAvailabilityCache) {
  try {
    localStorage.setItem(STREAM_AVAILABILITY_KEY, JSON.stringify(cache));
  } catch {
    // non-fatal
  }
}

/** Items that participate in the scanner. Movies excluded (no
 *  episode-level "release" signal we'd surface as a notification).
 *  Channel / TV streams skipped (live programming, not catalog). */
function isScannable(item: LibraryItem): boolean {
  if (item.removed) return false;
  if (item.temp) return false;
  if (!item.id || !item.id.startsWith("tt")) return false; // cloud is imdb-keyed
  const t = (item.media_type ?? "").toLowerCase();
  if (t === "movie") return false;
  if (t === "channel" || t === "channels" || t === "tv") return false;
  return true;
}

function isPlayableStream(s: { type?: string | null }): boolean {
  const t = (s.type ?? "").toLowerCase();
  return t !== "statistic" && t !== "error";
}

/** Format an SxxEyy / Eyy label. */
function formatEpLabel(season: number | null | undefined, episode: number | null | undefined): string | null {
  if (typeof season === "number" && typeof episode === "number") {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  if (typeof episode === "number") return `E${episode}`;
  return null;
}

/** Parse aired_at to ms epoch. Treats unparseable strings as
 *  `Number.NEGATIVE_INFINITY` so they sort to the bottom and never
 *  pass any "is newer than" comparison — defensive against the
 *  rare cloud response with a malformed timestamp. */
function airedAtMs(a: ReleaseAired | null | undefined): number {
  if (!a?.aired_at) return Number.NEGATIVE_INFINITY;
  const t = Date.parse(a.aired_at);
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/** Does the user's library record show they're at/past this
 *  episode? Used as a secondary "already seen" check so a fresh
 *  install (no prior scanner state) doesn't fire notifications for
 *  season finales they've already played.
 *
 *  Looks at `state.video_id` (last episode played) and compares
 *  via (season, episode) tuple. tt-style ids carry these directly;
 *  for prefix-style ids (kitsu/mal/anidb) we have no clean
 *  comparison shortcut so the check returns false and the cloud
 *  signal wins. */
function librarySaysSeen(item: LibraryItem, target: ReleaseAired): boolean {
  const state = item.state;
  if (!state) return false;
  const lastVideoId = typeof state.video_id === "string" ? state.video_id : null;
  if (!lastVideoId) return false;
  // Same id → trivially seen.
  if (lastVideoId === target.id) return true;
  // tt-style cross-check: (season, episode) tuple.
  if (lastVideoId.startsWith("tt") && target.season != null && target.episode != null) {
    const parts = lastVideoId.split(":");
    if (parts.length >= 3) {
      const ls = Number(parts[parts.length - 2]);
      const le = Number(parts[parts.length - 1]);
      if (Number.isFinite(ls) && Number.isFinite(le)) {
        // Last-played season > target → past it.
        if (ls > target.season) return true;
        // Same season: episode >= target episode → seen.
        if (ls === target.season && le >= target.episode) return true;
      }
    }
  }
  return false;
}

interface Props {
  addons: AddonEntry[];
  library: LibraryItem[];
}

export default function NotificationsScanner({ addons, library }: Props) {
  const { addNotification } = useNotifications();
  const version = useReleaseSignalsVersion();

  // Run migration once per app lifetime — the storage write itself
  // is idempotent so the useEffect's empty dep array is fine.
  useEffect(() => {
    maybeMigrateScannerState();
  }, []);

  const propsRef = useRef({ addons, library });
  useEffect(() => { propsRef.current = { addons, library }; }, [addons, library]);

  const scanningRef = useRef(false);

  // Main signal-diff effect. Reruns on every version bump from the
  // release-signal store (library load, refresh button, periodic
  // refresh below).
  useEffect(() => {
    if (scanningRef.current) return;
    const { library } = propsRef.current;
    if (library.length === 0) return;

    const settings = loadAuraSettings();
    if (!settings.releaseSearchEnabled) return;

    const candidates = library.filter(isScannable);
    if (candidates.length === 0) return;

    scanningRef.current = true;

    void (async () => {
      try {
        const state = loadScannerState();
        // Evict scanner state entries for library items the user
        // removed.
        const liveIds = new Set(candidates.map((c) => c.id));
        let stateDirty = false;
        for (const id of Object.keys(state)) {
          if (!liveIds.has(id)) {
            delete state[id];
            stateDirty = true;
          }
        }

        const streamAvailability = loadStreamAvailability();
        let streamCacheDirty = false;
        const now = Date.now();

        for (const item of candidates) {
          const signal = getReleaseSignal(item.id);
          if (signal === undefined) continue; // store hasn't seen this id yet
          if (signal === null) continue;       // cloud has no record
          const recent = Array.isArray(signal.recent_aired) ? signal.recent_aired : [];
          // Fallback to last_aired when the cloud's recent_aired is
          // empty — covers the transition window where the cloud
          // hasn't been redeployed with the new field, OR shows that
          // only have a single tracked episode.
          const candidates_aired: ReleaseAired[] = recent.length > 0
            ? recent
            : (signal.last_aired ? [signal.last_aired] : []);
          if (candidates_aired.length === 0) continue;

          const prev = state[item.id] ?? { lastChecked: 0, seenVideoIds: [] };
          const seenSet = new Set<string>(prev.seenVideoIds);
          const isFirstScan = prev.lastChecked === 0;
          const lastNotifiedMs = prev.lastNotifiedAt ?? 0;

          // First-scan seeding. Mark everything currently aired as
          // seen WITHOUT notifying. Uses the library `state.video_id`
          // cross-check so even a never-seeded series doesn't get a
          // backlog of notifications when the user already watched up
          // to recent episodes. This is the v2→v3 migration safety
          // net + the cold-install onboarding behaviour.
          if (isFirstScan) {
            let newestSeed = 0;
            for (const ep of candidates_aired) {
              seenSet.add(ep.id);
              const ms = airedAtMs(ep);
              if (ms > newestSeed) newestSeed = ms;
            }
            state[item.id] = {
              lastChecked: now,
              seenVideoIds: Array.from(seenSet),
              lastNotifiedAt: newestSeed > 0 ? newestSeed : undefined,
              pendingStreamCheck: prev.pendingStreamCheck,
            };
            stateDirty = true;
            continue;
          }

          // Stacked diff: walk recent_aired ascending, fire for
          // every entry that's (a) not yet seen AND (b) newer than
          // our `lastNotifiedAt` watermark AND (c) not behind the
          // user's library state.video_id.
          const newPending: PendingStreamCheck[] = [...(prev.pendingStreamCheck ?? [])];
          let highestFiredMs = lastNotifiedMs;
          for (const ep of candidates_aired) {
            if (!ep?.id) continue;
            if (seenSet.has(ep.id)) continue;
            const epMs = airedAtMs(ep);
            if (epMs <= lastNotifiedMs) {
              // Older than the watermark — mark as seen without
              // notifying. Prevents future polls from re-evaluating
              // it every tick.
              seenSet.add(ep.id);
              continue;
            }
            if (librarySaysSeen(item, ep)) {
              // User has already played at or past this episode in
              // their library — don't notify.
              seenSet.add(ep.id);
              if (epMs > highestFiredMs) highestFiredMs = epMs;
              continue;
            }

            if (settings.notifyOnlyWithStreams) {
              // Defer to the periodic stream-recheck timer. Record
              // the pending entry; the timer fires fetch_streams +
              // promotes to a notification once streams appear.
              // Avoid duplicate pending entries on rapid version
              // bumps.
              if (!newPending.some((p) => p.videoId === ep.id)) {
                newPending.push({
                  videoId: ep.id,
                  airedAtMs: epMs,
                  season: ep.season ?? null,
                  episode: ep.episode ?? null,
                  recordedAtMs: now,
                });
              }
              // Don't mark as seen yet — only promote when streams
              // arrive (in the recheck timer below).
              continue;
            }

            // Fire the notification.
            seenSet.add(ep.id);
            if (epMs > highestFiredMs) highestFiredMs = epMs;
            const epLabel = formatEpLabel(ep.season, ep.episode);
            const titleParts: string[] = [item.name];
            if (epLabel) titleParts.push(epLabel);
            addNotification({
              id: `episode:${item.id}:${ep.id}`,
              kind: "episode",
              title: titleParts.join(" — "),
              subtitle: undefined,
              data: { metaId: item.id, videoId: ep.id, mediaType: item.media_type },
            });
          }

          state[item.id] = {
            lastChecked: now,
            seenVideoIds: Array.from(seenSet),
            lastNotifiedAt: highestFiredMs > 0 ? highestFiredMs : prev.lastNotifiedAt,
            pendingStreamCheck: newPending.length > 0 ? newPending : undefined,
          };
          stateDirty = true;
        }

        if (stateDirty) saveScannerState(state);
        if (streamCacheDirty) saveStreamAvailability(streamAvailability);

        // After the diff finishes, kick the stream-recheck path so
        // anything pending from THIS tick gets a chance to promote
        // immediately when streams happen to already exist (e.g. on
        // a delayed cold-start where the episode aired hours ago
        // and scrapers have caught up).
        void recheckPendingStreams(propsRef.current.library, propsRef.current.addons, addNotification);
      } finally {
        scanningRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  // Periodic refresh — kicks reconcileLibraryReleaseSignals so the
  // cloud signal store stays fresh while the app is open. Per §6.0
  // recommendation, 5–10 min. The cloud serves these from cache; the
  // §10.1 ETag short-circuit will reduce the bytes further once it
  // lands.
  useEffect(() => {
    const tick = () => {
      const { library } = propsRef.current;
      // Guest-mode + opt-out gated inside reconcileLibraryReleaseSignals.
      void reconcileLibraryReleaseSignals(library, false);
    };
    const id = setInterval(tick, PERIODIC_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  // Stream-recheck timer — handles the notifyOnlyWithStreams flow.
  // When the setting is on, the main diff above doesn't fire
  // notifications immediately; it records `pendingStreamCheck`
  // entries. This timer iterates those entries every 15 min, calls
  // fetch_streams for each, and promotes to a notification the
  // first time streams come back.
  useEffect(() => {
    const tick = () => {
      void recheckPendingStreams(propsRef.current.library, propsRef.current.addons, addNotification);
    };
    const id = setInterval(tick, STREAM_RECHECK_MS);
    return () => clearInterval(id);
  }, [addNotification]);

  return null;
}

/** Walk every library item's `pendingStreamCheck` list, query
 *  `fetch_streams` for each pending video, and promote to a fired
 *  notification when streams appear. Pending entries older than
 *  PENDING_MAX_AGE_MS (14 days) are dropped — by then the user has
 *  either seen the episode through other means or the addon isn't
 *  going to find streams. Idempotent + safe to call from multiple
 *  triggers (signal bump + 15-min interval).
 *
 *  Exported-shape isn't useful outside this module; kept as a
 *  module-private async function. */
async function recheckPendingStreams(
  library: LibraryItem[],
  addons: AddonEntry[],
  addNotification: ReturnType<typeof useNotifications>["addNotification"],
): Promise<void> {
  if (library.length === 0) return;
  const settings = loadAuraSettings();
  if (!settings.notifyOnlyWithStreams) return; // setting off → nothing to do
  if (!settings.releaseSearchEnabled) return;

  const state = loadScannerState();
  const streamAvailability = loadStreamAvailability();
  const now = Date.now();
  let stateDirty = false;
  let streamCacheDirty = false;

  for (const item of library) {
    if (!isScannable(item)) continue;
    const entry = state[item.id];
    if (!entry?.pendingStreamCheck || entry.pendingStreamCheck.length === 0) continue;

    const remaining: PendingStreamCheck[] = [];
    const seenSet = new Set<string>(entry.seenVideoIds);
    let lastNotifiedAt = entry.lastNotifiedAt ?? 0;

    for (const pending of entry.pendingStreamCheck) {
      // Drop entries older than the 14-day cap.
      if (now - pending.recordedAtMs > PENDING_MAX_AGE_MS) continue;

      // Use the 12-h availability cache first.
      const cached = streamAvailability[pending.videoId];
      let hasStreams: boolean | null = null;
      if (cached && now - cached.ts < STREAM_AVAILABILITY_TTL_MS) {
        hasStreams = cached.hasStreams;
      } else {
        try {
          const streams = await invoke<Array<{ type?: string | null }>>(
            "fetch_streams",
            { addons, mediaType: item.media_type, id: pending.videoId },
          );
          hasStreams = Array.isArray(streams) && streams.some(isPlayableStream);
          streamAvailability[pending.videoId] = { hasStreams, ts: now };
          streamCacheDirty = true;
        } catch {
          hasStreams = null;
        }
      }

      if (hasStreams === true) {
        // Promote. Fire notification and remove from pending.
        seenSet.add(pending.videoId);
        if (pending.airedAtMs > lastNotifiedAt) lastNotifiedAt = pending.airedAtMs;
        const epLabel = formatEpLabel(pending.season, pending.episode);
        const titleParts: string[] = [item.name];
        if (epLabel) titleParts.push(epLabel);
        addNotification({
          id: `episode:${item.id}:${pending.videoId}`,
          kind: "episode",
          title: titleParts.join(" — "),
          subtitle: undefined,
          data: { metaId: item.id, videoId: pending.videoId, mediaType: item.media_type },
        });
        stateDirty = true;
      } else {
        // No streams yet (or fetch failed) — keep in pending for
        // the next tick.
        remaining.push(pending);
      }
    }

    if (remaining.length !== entry.pendingStreamCheck.length || seenSet.size !== entry.seenVideoIds.length) {
      state[item.id] = {
        ...entry,
        seenVideoIds: Array.from(seenSet),
        lastNotifiedAt: lastNotifiedAt > 0 ? lastNotifiedAt : entry.lastNotifiedAt,
        pendingStreamCheck: remaining.length > 0 ? remaining : undefined,
      };
      stateDirty = true;
    }
  }

  if (stateDirty) saveScannerState(state);
  if (streamCacheDirty) saveStreamAvailability(streamAvailability);
}
