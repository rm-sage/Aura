// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { AddonEntry, LibraryItem } from "./types";
import { loadAuraSettings } from "./auraSettings";
import { useNotifications } from "./NotificationsContext";
import {
  getReleaseSignal,
  useReleaseSignalsVersion,
} from "./releaseSignalStore";
import { reconcileLibraryReleaseSignals } from "./releaseSignalStore";
import type { ReleaseAired } from "./releaseSearch";
import { formatEpLabel } from "./episodeLabel";
import { useIdleGatedInterval } from "./useIdleGate";

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
// the scanner refreshes signals on a 5-minute interval while the app
// is open (§6.0 "5–10 min recommended" — bottom of the band per user
// preference, so newly-aired episodes surface as fast as the cloud
// poller can confirm them). The cloud serves these from cache
// cheaply; the §10.1 batch-ETag short-circuit will land later to
// reduce the bandwidth further.
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
//       lastNotifiedAt: <ms epoch>
//     }
//   }
// ---------------------------------------------------------------------------

const SCANNER_STATE_KEY = "aura:notifications:scanner-state";
const SCANNER_VERSION_KEY = "aura:notifications:scanner-version";
const CURRENT_SCANNER_VERSION = "3";
const PERIODIC_REFRESH_MS = 5 * 60 * 1000;
/** Slower cadence while the window is hidden/minimized: we keep catching new
 *  releases so they are ready on restore, but poll less often to save power. */
const HIDDEN_REFRESH_MS = 15 * 60 * 1000;

interface ScannerItemState {
  lastChecked: number;
  seenVideoIds: string[];
  lastNotifiedAt?: number;
}

type ScannerState = Record<string, ScannerItemState>;

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
      out[k] = { lastChecked, seenVideoIds: seen, lastNotifiedAt };
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

/** Wipe the persisted episode-scanner seen-ledger. Called by the
 *  settings-scope follower on an ACTUAL account change (A→B / sign-
 *  out) so one account's "already seen / notified" memory can't bleed
 *  into another. The next scan then takes the documented one-shot
 *  first-scan seeding grace (seeds current state, fires nothing), then
 *  resumes normal new-episode detection. Never call on a same-account
 *  restore — that would re-seed every launch and swallow a genuinely
 *  new episode. */
export function clearScannerState(): void {
  try {
    localStorage.removeItem(SCANNER_STATE_KEY);
  } catch {
    // private mode / quota — non-fatal
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

/** Items that participate in the scanner. Channel / TV streams
 *  skipped (live programming, not catalog). Movies ARE included now:
 *  the cloud's `last_aired` carries the digital-release timestamp,
 *  so a movie added to the library pre-release fires a notification
 *  the first scan after it goes available. Anime / series fire per
 *  episode via `recent_aired` as before. */
function isScannable(item: LibraryItem): boolean {
  if (item.removed) return false;
  if (item.temp) return false;
  if (!item.id || !item.id.startsWith("tt")) return false; // cloud is imdb-keyed
  const t = (item.media_type ?? "").toLowerCase();
  if (t === "channel" || t === "channels" || t === "tv") return false;
  return true;
}

function isMovieType(item: LibraryItem): boolean {
  return (item.media_type ?? "").toLowerCase() === "movie";
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

/** Representation-independent dedup key for an episode: `e:<season>:<episode>`.
 *  The cloud's `id` field can churn for the SAME episode — `last_aired.id` vs
 *  `recent_aired[].id` can differ in format, and anime absolute↔season
 *  numbering shifts the id as AIOMetadata resolves the season mapping. The
 *  (season, episode) NUMBERS are semantic and stable, so keying dedup on them
 *  (in addition to the raw id) stops the newest already-notified episode from
 *  re-firing when only its id representation changed. Returns null when there's
 *  no episode number (movies / number-less rows) — those fall back to the raw
 *  id + timestamp guards, so there's no regression. The `e:` prefix can never
 *  collide with a tt-style raw id. */
function episodeKey(ep: ReleaseAired): string | null {
  if (typeof ep.episode !== "number") return null;
  const s = typeof ep.season === "number" ? ep.season : "";
  return `e:${s}:${ep.episode}`;
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
 *  signal wins.
 *
 *  Movies: returns true when the user has any playback offset for
 *  the movie. A pre-release movie sitting in library with no
 *  timeOffset still notifies on release. */
function librarySaysSeen(item: LibraryItem, target: ReleaseAired): boolean {
  const state = item.state;
  if (!state) return false;
  if (isMovieType(item)) {
    return typeof state.timeOffset === "number" && state.timeOffset > 0;
  }
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

/** Window event the scanner listens for to force an immediate scan
 *  pass regardless of whether the release-signal store version has
 *  changed. Wired up by the DevConsole `notifytest` command so the
 *  user can validate the gate path end-to-end even when the cloud
 *  signal is byte-identical to its cached copy (the normal store
 *  bump path short-circuits in that case — by design — leaving the
 *  command otherwise inert). Also useful when debugging release
 *  notifications: dispatch from the DevConsole and watch the
 *  `[notif-scan]` trail. */
export const FORCE_SCAN_EVENT = "aura:notifications-force-scan";

export default function NotificationsScanner({ addons, library }: Props) {
  const { addNotification } = useNotifications();
  const version = useReleaseSignalsVersion();
  // Bumps any time a `aura:notifications-force-scan` event fires.
  // The main scan effect re-runs on this counter (in addition to the
  // store's `version`) so notifytest etc. always exercise the gate
  // path, even when the underlying signal data didn't move.
  const [forceTick, setForceTick] = useState(0);
  useEffect(() => {
    const onForce = () => {
      console.info("[notif-scan] force-scan event received");
      setForceTick((t) => t + 1);
    };
    window.addEventListener(FORCE_SCAN_EVENT, onForce);
    return () => window.removeEventListener(FORCE_SCAN_EVENT, onForce);
  }, []);

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
  //
  // Heavy console.info instrumentation: every gate logs a short label.
  // Run `notifytest <imdb_id>` in DevConsole and the trail tells you
  // exactly which gate swallowed the signal. The lines are intentionally
  // prefixed `[notif-scan]` so DevConsole's source filter picks them up
  // as a coherent set.
  useEffect(() => {
    if (scanningRef.current) {
      console.info(`[notif-scan] skip: scan already in flight (version=${version})`);
      return;
    }
    const { library } = propsRef.current;
    if (library.length === 0) {
      console.info(`[notif-scan] skip: empty library (version=${version})`);
      return;
    }

    const settings = loadAuraSettings();
    if (!settings.releaseSearchEnabled) {
      console.info(`[notif-scan] skip: releaseSearchEnabled is OFF`);
      return;
    }

    const candidates = library.filter(isScannable);
    if (candidates.length === 0) {
      console.info(`[notif-scan] skip: no scannable items in library of ${library.length}`);
      return;
    }
    console.info(`[notif-scan] start: ${candidates.length}/${library.length} scannable, version=${version}`);

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

        const now = Date.now();

        let firedCount = 0;
        for (const item of candidates) {
          const signal = getReleaseSignal(item.id);
          if (signal === undefined) {
            console.info(`[notif-scan] ${item.id} (${item.name}): store has no entry — skip`);
            continue;
          }
          if (signal === null) {
            console.info(`[notif-scan] ${item.id} (${item.name}): cloud has no record — skip`);
            continue;
          }
          const isMovie = isMovieType(item);
          // Movies surface their digital-release date via `last_aired`
          // (cloud guarantees `recent_aired: []` for movies). Series /
          // anime walk every recent episode, falling back to last_aired
          // if the cloud hasn't filled recent_aired yet.
          const recent = Array.isArray(signal.recent_aired) ? signal.recent_aired : [];
          const candidates_aired: ReleaseAired[] = isMovie
            ? (signal.last_aired ? [signal.last_aired] : [])
            : recent.length > 0
              ? recent
              : (signal.last_aired ? [signal.last_aired] : []);
          if (candidates_aired.length === 0) {
            console.info(`[notif-scan] ${item.id} (${item.name}): signal carries no aired entries (recent_aired=${recent.length}, last_aired=${signal.last_aired ? "set" : "null"}) — skip`);
            continue;
          }

          const prev = state[item.id] ?? { lastChecked: 0, seenVideoIds: [] };
          const seenSet = new Set<string>(prev.seenVideoIds);
          const isFirstScan = prev.lastChecked === 0;
          const lastNotifiedMs = prev.lastNotifiedAt ?? 0;

          console.info(
            `[notif-scan] ${item.id} (${item.name}): walking ${candidates_aired.length} aired entries, ` +
            `isFirstScan=${isFirstScan}, seenIds=${seenSet.size}, lastNotifiedAt=${lastNotifiedMs}, isMovie=${isMovie}`,
          );

          // First-scan seeding. Mark everything currently aired as
          // seen WITHOUT notifying. Uses the library `state.video_id`
          // cross-check so even a never-seeded series doesn't get a
          // backlog of notifications when the user already watched up
          // to recent episodes. This is the v2→v3 migration safety
          // net + the cold-install onboarding behaviour.
          if (isFirstScan) {
            console.info(`[notif-scan] ${item.id}: FIRST-SCAN seed (no notifications will fire this pass)`);
            let newestSeed = 0;
            for (const ep of candidates_aired) {
              const ms = airedAtMs(ep);
              // Defense-in-depth (caveat #1): don't seed a not-yet-
              // aired episode as "seen". If the cloud surfaced it
              // early (degraded upstream render / future estimate),
              // seeding it here would permanently suppress its
              // notification when it actually airs. Leaving it
              // un-seeded lets the normal diff fire it once aired.
              // (Unparseable timestamps are NEGATIVE_INFINITY → not
              // > now → seeded as before.)
              if (ms > now) continue;
              seenSet.add(ep.id);
              const k = episodeKey(ep);
              if (k) seenSet.add(k); // representation-independent dedup
              if (ms > newestSeed) newestSeed = ms;
            }
            state[item.id] = {
              lastChecked: now,
              seenVideoIds: Array.from(seenSet),
              lastNotifiedAt: newestSeed > 0 ? newestSeed : undefined,
            };
            stateDirty = true;
            continue;
          }

          // Pre-fix state stored only raw cloud ids. The NEWEST notified
          // episode sits exactly AT the `<` timestamp watermark, so only its
          // raw id protected it — and if the cloud has since churned that id
          // (last_aired vs recent_aired format, or anime absolute↔season
          // numbering) it re-fires. Seed its representation-independent key so
          // it can't. Episodes strictly BELOW the watermark don't need this:
          // the predate-watermark branch in the diff walk marks them seen
          // (id + key) without firing regardless of id drift. We seed the
          // at-watermark key ONLY when exactly one recent episode matches the
          // watermark timestamp — with a same-timestamp batch drop we can't
          // tell the notified episode from an un-notified sibling, so we
          // defer to the diff walk (caveat #2: same-timestamp siblings still
          // fire) and accept at most one extra notification. Idempotent: once
          // the key is in seenVideoIds, this is a no-op.
          if (lastNotifiedMs > 0) {
            const atWatermark = candidates_aired.filter((ep) => airedAtMs(ep) === lastNotifiedMs);
            if (atWatermark.length === 1) {
              const wk = episodeKey(atWatermark[0]);
              if (wk) seenSet.add(wk);
            }
          }

          // Stacked diff: walk recent_aired ascending, fire for
          // every entry that's (a) not yet seen AND (b) newer than
          // our `lastNotifiedAt` watermark AND (c) not behind the
          // user's library state.video_id.
          let highestFiredMs = lastNotifiedMs;
          for (const ep of candidates_aired) {
            if (!ep?.id) {
              console.info(`[notif-scan] ${item.id}: skipping entry with no id`);
              continue;
            }
            const epKey = episodeKey(ep);
            // Already notified — by raw id OR by representation-independent
            // (season:episode) key. The key check is what survives a cloud
            // episode-id churn that the raw-id check alone would miss.
            if (seenSet.has(ep.id) || (epKey && seenSet.has(epKey))) {
              console.info(`[notif-scan] ${item.id}/${ep.id}: already seen (id or s/e key) — skip`);
              continue;
            }
            const epMs = airedAtMs(ep);
            // Defense-in-depth (caveat #1): never notify before the
            // episode's stated air time. The cloud is the primary
            // guard — it pins aired_at and shouldn't surface an
            // episode early — but a degraded upstream render or a
            // future first-published estimate could still slip a
            // not-yet-aired entry into recent_aired. Skip it WITHOUT
            // marking it seen or advancing the watermark so it gets
            // re-evaluated and fires correctly once actually aired.
            // (A local clock running behind real time at worst delays
            // a just-aired episode by one ~5-min tick — self-healing;
            // firing early is the worse failure. Unparseable
            // timestamps are NEGATIVE_INFINITY → not > now → fall
            // through to the existing handling below.)
            if (epMs > now) {
              console.info(`[notif-scan] ${item.id}/${ep.id}: aired_at is in the future (${ep.aired_at}) — skip without seeding`);
              continue;
            }
            if (epMs < lastNotifiedMs) {
              // Strictly older than the watermark — mark as seen
              // without notifying. Prevents future polls from
              // re-evaluating it every tick.
              //
              // NOTE (caveat #2): this is `<`, not `<=`, on purpose.
              // An episode whose aired_at exactly EQUALS the watermark
              // is a same-timestamp sibling of an already-fired
              // episode (batch / double drop) — it must NOT be
              // silently swallowed here; it falls through to the
              // id-dedup + notify path below. The `seenSet.has(ep.id)`
              // check above still prevents re-firing the episode that
              // set the watermark.
              console.info(`[notif-scan] ${item.id}/${ep.id}: aired_at ${ep.aired_at} predates watermark ${lastNotifiedMs} — mark seen without firing`);
              seenSet.add(ep.id);
              if (epKey) seenSet.add(epKey);
              continue;
            }
            if (librarySaysSeen(item, ep)) {
              // User has already played at or past this episode in
              // their library — don't notify.
              console.info(`[notif-scan] ${item.id}/${ep.id}: librarySaysSeen=true (state.video_id=${item.state?.video_id ?? "(none)"}, timeOffset=${item.state?.timeOffset ?? 0}) — mark seen without firing`);
              seenSet.add(ep.id);
              if (epKey) seenSet.add(epKey);
              if (epMs > highestFiredMs) highestFiredMs = epMs;
              continue;
            }

            // Fire the notification.
            seenSet.add(ep.id);
            if (epKey) seenSet.add(epKey);
            if (epMs > highestFiredMs) highestFiredMs = epMs;
            firedCount++;
            console.info(`[notif-scan] ${item.id}/${ep.id}: FIRING notification (${isMovie ? "movie release" : "episode"})`);
            if (isMovie) {
              addNotification({
                id: `release:${item.id}`,
                kind: "release",
                title: `${item.name} — now available`,
                subtitle: undefined,
                data: { metaId: item.id, mediaType: item.media_type },
              });
            } else {
              const epLabel = formatEpLabel(ep.season, ep.episode);
              const titleParts: string[] = [item.name];
              if (epLabel) titleParts.push(epLabel);
              addNotification({
                // Representation-independent notification id (falls back to
                // the raw cloud id only when there's no episode number) so the
                // bell store's id-dedup also survives a churned cloud id.
                id: `episode:${item.id}:${epKey ?? ep.id}`,
                kind: "episode",
                title: titleParts.join(" — "),
                subtitle: undefined,
                data: { metaId: item.id, videoId: ep.id, mediaType: item.media_type },
              });
            }
          }

          state[item.id] = {
            lastChecked: now,
            seenVideoIds: Array.from(seenSet),
            lastNotifiedAt: highestFiredMs > 0 ? highestFiredMs : prev.lastNotifiedAt,
          };
          stateDirty = true;
        }

        console.info(`[notif-scan] done: fired=${firedCount}, stateDirty=${stateDirty}`);
        if (stateDirty) saveScannerState(state);
      } finally {
        scanningRef.current = false;
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, forceTick]);

  // Periodic refresh — kicks reconcileLibraryReleaseSignals so the
  // cloud signal store stays fresh while the app is open. Per §6.0
  // recommendation, 5–10 min. The cloud serves these from cache; the
  // §10.1 ETag short-circuit will reduce the bytes further once it
  // lands.
  // The ONE poll we deliberately keep running while minimized/tray: the user
  // wants new releases caught and ready on restore. It runs at a slower cadence
  // while hidden (HIDDEN_REFRESH_MS) and fires an immediate catch-up the moment
  // the window is restored.
  useIdleGatedInterval(
    () => {
      // Guest-mode + opt-out gated inside reconcileLibraryReleaseSignals.
      void reconcileLibraryReleaseSignals(propsRef.current.library, false);
    },
    PERIODIC_REFRESH_MS,
    { keepWhileHidden: true, hiddenMs: HIDDEN_REFRESH_MS, runOnResume: true },
  );

  return null;
}
