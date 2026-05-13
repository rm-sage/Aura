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

// ---------------------------------------------------------------------------
// useNotificationsScanner — cloud-signal driven.
//
// History (in case this needs to be redesigned later):
//   • v1: ran on activeView==="home" gate only — users who lived in
//     Library / Calendar / Settings never saw notifications.
//   • v2: removed view gate, walked addon-probe meta per library item
//     every 30 min. Worked, but redundant with Aura Cloud's release
//     poller doing the same probe globally — and the per-user probe
//     can't see new episodes when AIOMetadata's local cache is cold
//     (the cloud's poller is warm by virtue of fanning across every
//     user's library).
//   • v3 (this file): driven entirely by `releaseSignalStore`. The
//     cloud is the single source of truth for "what's the most-recent
//     aired episode for series X" — the desktop just compares the
//     signal's `last_aired.id` against its local seen-episodes ledger
//     and fires a notification when there's a new one. No timer, no
//     addon probe. The store updates whenever the library changes or
//     the user hits the refresh button, so this hook reacts to those
//     updates via `useReleaseSignalsVersion`.
//
// Non-cloud items (kitsu/mal/anidb-keyed library entries):
//   Per release-search-spec §6 the cloud poller is imdb-keyed.
//   Library items whose id doesn't start with "tt" don't get cloud
//   signals and therefore don't fire notifications from this scanner.
//   That's an explicit trade — the addon-probe fallback was removed
//   per user direction since Aura Cloud is supposed to be the
//   authoritative release-detection path.
//
// Persisted state (localStorage `aura:notifications:scanner-state`):
//   { [libraryItemId]: { lastChecked: number; seenVideoIds: string[] } }
//   Shape unchanged from v2 so `notifytest` and the cloud sync layer
//   keep working. `seenVideoIds` now grows by ~1 entry per
//   cloud-detected new episode rather than the full episode array.
// ---------------------------------------------------------------------------

const SCANNER_STATE_KEY = "aura:notifications:scanner-state";
const STREAM_AVAILABILITY_KEY = "aura:notifications:stream-availability";
const STREAM_AVAILABILITY_TTL_MS = 12 * 60 * 60 * 1000;

interface ScannerItemState {
  lastChecked: number;
  seenVideoIds: string[];
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
      out[k] = { lastChecked, seenVideoIds: seen };
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

/** Format an SxxEyy / Eyy label from optional season + episode
 *  numbers. Mirrors the prior scanner's helper to keep notification
 *  titles visually identical. */
function formatEpLabel(season: number | null | undefined, episode: number | null | undefined): string | null {
  if (typeof season === "number" && typeof episode === "number") {
    return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
  }
  if (typeof episode === "number") return `E${episode}`;
  return null;
}

interface Props {
  addons: AddonEntry[];
  library: LibraryItem[];
}

export default function NotificationsScanner({ addons, library }: Props) {
  const { addNotification } = useNotifications();
  // Re-render on every release-signal store change. The store version
  // bumps from `reconcileLibraryReleaseSignals` (library load /
  // refresh / manual nudge) so this hook reacts to the same events
  // that drive the rest of the cloud-signal pipeline.
  const version = useReleaseSignalsVersion();

  // Capture props in a ref so the scan effect doesn't redeclare its
  // closure when only `library` changes (the version bump above is
  // what we react to; library identity bumps just refresh the ref).
  const propsRef = useRef({ addons, library });
  useEffect(() => { propsRef.current = { addons, library }; }, [addons, library]);

  // Re-entrancy guard. If a refresh fires while the previous async
  // body is still running its stream-availability checks, the second
  // run skips — the next version bump will pick up wherever we left
  // off.
  const scanningRef = useRef(false);

  useEffect(() => {
    if (scanningRef.current) return;
    const { addons, library } = propsRef.current;
    if (library.length === 0) return;

    const settings = loadAuraSettings();
    // Honor the user's opt-out — if they've disabled the cloud
    // release feed, we can't drive notifications from it. Nothing
    // fires; v2's addon-probe fallback was removed per direction.
    if (!settings.releaseSearchEnabled) return;

    const candidates = library.filter(isScannable);
    if (candidates.length === 0) return;

    scanningRef.current = true;

    void (async () => {
      try {
        const state = loadScannerState();
        // Evict scanner state entries for library items the user
        // removed (same housekeeping as v2).
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

        for (const item of candidates) {
          const signal = getReleaseSignal(item.id);
          // `undefined` means "store hasn't seen this id yet" —
          // happens during the first reconcile pass or for ids the
          // cloud poller hasn't reached. We skip rather than
          // assuming no episode aired.
          if (signal === undefined) continue;
          // `null` is "cloud has no record for this id" — also a
          // skip; nothing to compare against.
          if (signal === null) continue;
          const la = signal.last_aired;
          if (!la?.id) continue;

          const prev = state[item.id] ?? { lastChecked: 0, seenVideoIds: [] };
          const seenSet = new Set<string>(prev.seenVideoIds);
          const isFirstScan = prev.lastChecked === 0;

          // First-scan seeding: if we've never seen this series
          // before, mark the current `last_aired` as seen WITHOUT
          // notifying. Notifications only fire for genuinely-new
          // episodes that arrived after the user's first scan.
          // Without this, signing in on a fresh device would spam a
          // notification for whatever happened to be the most-recent
          // episode of every show in the library.
          if (isFirstScan) {
            seenSet.add(la.id);
            state[item.id] = {
              lastChecked: Date.now(),
              seenVideoIds: Array.from(seenSet),
            };
            stateDirty = true;
            continue;
          }

          // Already notified about this episode — no-op.
          if (seenSet.has(la.id)) {
            // Bump lastChecked so the housekeeping eviction above
            // doesn't think we never touched this entry. Cheap.
            if (state[item.id]) state[item.id].lastChecked = Date.now();
            continue;
          }

          // Optional stream-availability gate (preserved from v2). When
          // on, we only fire the notification if at least one
          // playable stream is available for the new episode. Result
          // cached locally for 12 h so re-scans don't refire the
          // network call. Cloud doesn't know about streams (per
          // §2 privacy boundary — streams stay per-user), so this
          // gate stays client-side.
          if (settings.notifyOnlyWithStreams) {
            const now = Date.now();
            const cacheHit = streamAvailability[la.id];
            let hasStreams: boolean;
            if (cacheHit && now - cacheHit.ts < STREAM_AVAILABILITY_TTL_MS) {
              hasStreams = cacheHit.hasStreams;
            } else {
              try {
                const streams = await invoke<Array<{ type?: string | null }>>(
                  "fetch_streams",
                  { addons, mediaType: item.media_type, id: la.id },
                );
                hasStreams = Array.isArray(streams)
                  && streams.some(isPlayableStream);
              } catch {
                // Network blip — don't mark as seen so the next
                // signal-bump retries.
                continue;
              }
              streamAvailability[la.id] = { hasStreams, ts: now };
              streamCacheDirty = true;
            }
            if (!hasStreams) {
              // Skip THIS pass; v2's bug of permanently marking
              // unavailable-stream eps as seen is not repeated.
              continue;
            }
          }

          // Fire the notification.
          seenSet.add(la.id);
          const epLabel = formatEpLabel(la.season, la.episode);
          const titleParts: string[] = [item.name];
          if (epLabel) titleParts.push(epLabel);
          addNotification({
            id: `episode:${item.id}:${la.id}`,
            kind: "episode",
            title: titleParts.join(" — "),
            subtitle: undefined,
            data: { metaId: item.id, videoId: la.id, mediaType: item.media_type },
          });
          state[item.id] = {
            lastChecked: Date.now(),
            seenVideoIds: Array.from(seenSet),
          };
          stateDirty = true;
        }

        if (stateDirty) saveScannerState(state);
        if (streamCacheDirty) saveStreamAvailability(streamAvailability);
      } finally {
        scanningRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  return null;
}
