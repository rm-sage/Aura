// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, LibraryItem } from "./types";
import { loadAuraSettings } from "./auraSettings";
import { resolveDefaultMetaUrl } from "./addonDefaults";
import { getMetaDetail } from "./metaCache";
import { useNotifications } from "./NotificationsContext";

// ---------------------------------------------------------------------------
// useNotificationsScanner
//
// Polls library items (series / anime only — no reliable "movie released"
// signal from Stremio meta) for new episodes. Pushes a kind:'episode'
// notification for any video whose `released` falls in the recent window
// that we haven't surfaced before.
//
// What changed from the previous implementation:
//
//   1. **No view gate.** The old scanner only ran while the user was on
//      Home, which meant a user who lived in Library / Calendar never
//      got notifications. We now run on a global timer regardless.
//
//   2. **Shared meta cache.** The old code hit `fetch_meta_detail` for
//      every due item per scan, ignoring the 24-hour persistent cache
//      in `metaCache.ts`. We now route through `getMetaDetail`, which
//      is what the Calendar view also uses — meta fetched for one
//      view (or earlier scan) satisfies the other for free, and
//      concurrent scans for the same item dedupe via `dedupedInvoke`.
//
//   3. **First-scan seeding fixed.** The old logic seeded
//      `seenVideoIds` with EVERY video on the first pass, so any
//      episode that was already in the addon's feed when the user
//      first installed Aura would never notify — even if it aired
//      yesterday. We now only seed videos that fall OUTSIDE the
//      recent-release window on first scan; episodes inside the
//      window are still candidates for notification on first contact.
//      This is what made the bell silently stop firing for "the
//      latest Frieren" types of cases the user reported.
//
//   4. **Optional stream-availability gate.** When
//      `auraSettings.notifyOnlyWithStreams` is true, the scanner
//      additionally calls `fetch_streams` for each candidate and
//      only fires the notification if at least one non-pseudo
//      stream is returned. Result is cached locally for 12 hours so
//      a re-scan over the same episode doesn't spam the network.
//      Off by default to keep the scan cheap; users with
//      occasionally-empty addons can toggle it on.
//
// Persisted state (localStorage `aura:notifications:scanner-state`):
//   { [libraryItemId]: { lastChecked: number; seenVideoIds: string[] } }
// ---------------------------------------------------------------------------

const SCANNER_STATE_KEY = "aura:notifications:scanner-state";
const STREAM_AVAILABILITY_KEY = "aura:notifications:stream-availability";
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const PER_ITEM_DEBOUNCE_MS = 30 * 60 * 1000;
const RECENT_RELEASE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STREAM_AVAILABILITY_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_STAGGER_MS = 1500;

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
    // Evict entries past 2x the TTL. Without this the map grows
    // unboundedly across years of use, slowing every scan tick on
    // JSON parse + bloating the localStorage budget metaCache also
    // pulls from. 2x the TTL gives the user a generous "we already
    // checked, don't re-check immediately" window without keeping
    // entries forever.
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

/** Series-only filter — movies are excluded for now (no good "release" signal
 *  from the existing meta endpoint without rebuilding the airDate logic the
 *  Calendar already has). Anime is reported as media_type "anime" or "series"
 *  with one of the known anime-id prefixes — we accept both. */
function isScannable(item: LibraryItem): boolean {
  if (item.removed) return false;
  if (item.temp) return false; // auto-tracked items aren't user-curated
  const t = (item.media_type ?? "").toLowerCase();
  if (t === "movie") return false;
  if (t === "channel" || t === "channels" || t === "tv") return false;
  return true;
}

/** Streams whose `type` is "statistic" or "error" are AIOStreams meta
 *  pseudo-streams (filter / scrape / debrid summary) — they don't
 *  represent actual playable sources. The notifications scanner counts
 *  only real streams when deciding whether to fire under the
 *  notifyOnlyWithStreams gate. */
function isPlayableStream(s: { type?: string | null }): boolean {
  const t = (s.type ?? "").toLowerCase();
  return t !== "statistic" && t !== "error";
}

interface Props {
  addons: AddonEntry[];
  library: LibraryItem[];
}

export default function NotificationsScanner({ addons, library }: Props) {
  const { addNotification } = useNotifications();
  // Latest props captured in a ref so the scheduler doesn't have to be
  // re-armed on every library re-fetch.
  const propsRef = useRef({ addons, library });
  useEffect(() => { propsRef.current = { addons, library }; }, [addons, library]);

  // Ref guard to keep multiple in-flight scans from overlapping (which would
  // double-fire notifications when an interval tick lands while a previous
  // scan is still walking the staggered fetch list).
  const scanningRef = useRef(false);
  const runScan = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    runScan.current = async () => {
      if (scanningRef.current) return;
      const { addons, library } = propsRef.current;
      if (addons.length === 0 || library.length === 0) return;

      // Resolve metadata addon — settings override wins; otherwise we
      // walk the manifest-id default order (AIOMetadata → Cinemeta) so
      // a fresh-install user with Cinemeta but no AIOMetadata still
      // gets a sensible meta source. Final fallback: first installed
      // addon.
      const settings = loadAuraSettings();
      const overrideUrl = settings.defaultMetadataAddonUrl &&
        addons.find((a) => a.url === settings.defaultMetadataAddonUrl)?.url;
      const defaultUrl = overrideUrl ?? resolveDefaultMetaUrl(addons);
      const metaAddon = (defaultUrl && addons.find((a) => a.url === defaultUrl))
        || addons[0];
      if (!metaAddon) return;

      const candidates = library.filter(isScannable);
      if (candidates.length === 0) return;

      const state = loadScannerState();
      // Evict scanner state entries for library items the user removed.
      // Without this, removing a 200-episode show leaves its 200-id
      // seenVideoIds array in localStorage forever, slowing every
      // subsequent loadScannerState parse + bloating the persisted
      // blob the sync layer round-trips. We rebuild a clean state
      // from the current candidate set, preserving entries for items
      // still in the library; everything else falls off.
      const liveIds = new Set(candidates.map((c) => c.id));
      let stateDirty = false;
      for (const id of Object.keys(state)) {
        if (!liveIds.has(id)) {
          delete state[id];
          stateDirty = true;
        }
      }
      if (stateDirty) saveScannerState(state);
      const now = Date.now();
      const due = candidates.filter((item) => {
        const s = state[item.id];
        if (!s) return true;
        return now - s.lastChecked > PER_ITEM_DEBOUNCE_MS;
      });
      if (due.length === 0) return;

      const streamAvailability = loadStreamAvailability();
      let streamCacheDirty = false;

      scanningRef.current = true;
      try {
        for (const item of due) {
          if (item !== due[0]) {
            await new Promise((r) => setTimeout(r, FETCH_STAGGER_MS));
          }
          // Route through the shared 24h persistent meta cache so a
          // hit landed by Calendar / DetailView / a previous scan
          // satisfies us for free. The cache also dedupes concurrent
          // calls for the same key, so two browser tabs (or the
          // sync layer pulling at the same time) can't fan a request
          // out twice.
          const detail = await getMetaDetail(metaAddon, item.media_type, item.id)
            .catch(() => null);

          const prev = state[item.id] ?? { lastChecked: 0, seenVideoIds: [] };
          const seenSet = new Set<string>(prev.seenVideoIds);
          const isFirstScan = prev.lastChecked === 0;

          if (detail && Array.isArray(detail.videos)) {
            for (const v of detail.videos) {
              if (!v.id) continue;
              if (seenSet.has(v.id)) continue;
              // Skip TMDB/TVDB season-0 specials/extras unconditionally.
              if (typeof v.season === "number" && v.season <= 0) {
                seenSet.add(v.id);
                continue;
              }
              const releasedTs = v.released ? Date.parse(v.released) : NaN;
              const inWindow = Number.isFinite(releasedTs)
                && releasedTs <= now + 24 * 60 * 60 * 1000
                && now - releasedTs <= RECENT_RELEASE_WINDOW_MS;

              // First-scan seeding fix: only mark videos OUTSIDE the
              // recent-release window as seen. Episodes inside the
              // window are still notification candidates on first
              // contact, which is what makes "I just installed Aura
              // and last episode aired yesterday" actually work.
              if (isFirstScan && !inWindow) {
                seenSet.add(v.id);
                continue;
              }
              if (!inWindow) continue;

              // Optional stream-availability gate. Cached for 12h
              // per video id so a re-scan over the same recent
              // episode doesn't refire the network call.
              if (settings.notifyOnlyWithStreams) {
                const cacheHit = streamAvailability[v.id];
                let hasStreams: boolean;
                if (cacheHit && now - cacheHit.ts < STREAM_AVAILABILITY_TTL_MS) {
                  hasStreams = cacheHit.hasStreams;
                } else {
                  try {
                    const streams = await invoke<Array<{ type?: string | null }>>(
                      "fetch_streams",
                      { addons, mediaType: item.media_type, id: v.id },
                    );
                    hasStreams = Array.isArray(streams)
                      && streams.some(isPlayableStream);
                  } catch {
                    // Network blip: don't suppress permanently and
                    // don't mark as seen — the next scan retries.
                    continue;
                  }
                  streamAvailability[v.id] = { hasStreams, ts: now };
                  streamCacheDirty = true;
                }
                if (!hasStreams) {
                  // Skip THIS scan but DON'T add to seenSet. The
                  // previous code added the id to seenSet permanently,
                  // which trapped users in "no notification ever" for
                  // any episode whose first stream-check failed —
                  // making the 12h TTL on the availability cache dead
                  // code (the seenSet check above short-circuits
                  // before the TTL is consulted). Leaving v.id
                  // unmarked lets the next scan re-query streams once
                  // the cache entry expires, which is what we want:
                  // delayed-source episodes do eventually notify.
                  continue;
                }
              }

              seenSet.add(v.id);
              const epLabel = (() => {
                if (typeof v.season === "number" && typeof v.episode === "number") {
                  const s = String(v.season).padStart(2, "0");
                  const e = String(v.episode).padStart(2, "0");
                  return `S${s}E${e}`;
                }
                if (typeof v.episode === "number") return `E${v.episode}`;
                return null;
              })();
              const titleParts = [item.name];
              if (epLabel) titleParts.push(epLabel);
              addNotification({
                id: `episode:${item.id}:${v.id}`,
                kind: "episode",
                title: titleParts.join(" — "),
                subtitle: v.title || undefined,
                data: { metaId: item.id, videoId: v.id, mediaType: item.media_type },
              });
            }
          }
          state[item.id] = {
            lastChecked: Date.now(),
            seenVideoIds: Array.from(seenSet),
          };
          saveScannerState(state);
        }
      } finally {
        scanningRef.current = false;
        if (streamCacheDirty) saveStreamAvailability(streamAvailability);
      }
    };
  }, [addNotification]);

  // Run on mount + every 30 minutes, regardless of which view the user
  // is on. Previously this gated on activeView === "home" which meant
  // a user who lived in Library / Calendar / Settings never saw
  // notifications fire — that's the most likely root cause of the
  // user-reported "I haven't seen new-episode notifications for a while".
  useEffect(() => {
    runScan.current();
    const id = setInterval(() => { runScan.current(); }, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return null;
}
