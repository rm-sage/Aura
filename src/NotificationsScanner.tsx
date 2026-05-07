// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, LibraryItem, MetaDetail } from "./types";
import { loadAuraSettings } from "./auraSettings";
import { resolveDefaultMetaUrl } from "./addonDefaults";
import { useNotifications } from "./NotificationsContext";

// ---------------------------------------------------------------------------
// useNotificationsScanner
//
// Polls library items (series / anime only — no reliable "movie released"
// signal from Stremio meta unless we want to fall back to airDate flags) for
// new episodes, and pushes a kind:'episode' notification for any video whose
// `released` falls in the last 30 days that we haven't surfaced before.
//
// Scheduling rules:
//   - Runs on hook mount + every 30 minutes (setInterval).
//   - Only runs when activeView === 'home' — moving away from Home pauses
//     the scan and a new visit re-triggers it (per-item debounce still
//     skips items we touched < 30 min ago, so coming back to Home doesn't
//     fan out 100+ requests).
//   - Per-fetch stagger of 1500 ms so we don't pummel the metadata addon.
//
// Persisted state (localStorage `aura:notifications:scanner-state`):
//   { [libraryItemId]: { lastChecked: number; seenVideoIds: string[] } }
//
//   - lastChecked debounces to 30 min per item.
//   - seenVideoIds prevents re-adding the same notification on every pass.
//     We seed seenVideoIds with EVERY video we see on the FIRST scan of an
//     item, so users who freshly install Aura don't get hit with hundreds of
//     "new episode" notifications for back-catalog content. Only videos
//     that appear AFTER the first scan and within their 30-day window
//     count as new.
// ---------------------------------------------------------------------------

const SCANNER_STATE_KEY = "aura:notifications:scanner-state";
const SCAN_INTERVAL_MS = 30 * 60 * 1000;
const PER_ITEM_DEBOUNCE_MS = 30 * 60 * 1000;
const RECENT_RELEASE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_STAGGER_MS = 1500;

interface ScannerItemState {
  lastChecked: number;
  seenVideoIds: string[];
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

/** Series-only filter — movies are excluded for now (no good "release" signal
 *  from the existing meta endpoint without rebuilding the airDate logic the
 *  Calendar already has). Anime is reported as media_type "anime" or "series"
 *  with one of the known anime-id prefixes — we accept both. */
function isScannable(item: LibraryItem): boolean {
  if (item.removed) return false;
  const t = (item.media_type ?? "").toLowerCase();
  if (t === "movie") return false;
  if (t === "channel" || t === "channels" || t === "tv") return false;
  return true;
}

interface Props {
  addons: AddonEntry[];
  library: LibraryItem[];
  /** Pass the App's activeView so the scanner only runs while the user is on
   *  Home. Any other view pauses the scheduler. */
  activeView: string;
}

export default function NotificationsScanner({ addons, library, activeView }: Props) {
  const { addNotification } = useNotifications();
  // Latest props captured in a ref so the scheduler doesn't have to be
  // re-armed on every library re-fetch.
  const propsRef = useRef({ addons, library });
  useEffect(() => { propsRef.current = { addons, library }; }, [addons, library]);

  // Ref guard to keep multiple in-flight scans from overlapping (which would
  // double-fire notifications when an interval tick lands while a previous
  // scan is still walking the staggered fetch list).
  const scanningRef = useRef(false);
  // First-scan grace flag — when scanner state is empty, the very first
  // pass for each item seeds seenVideoIds with everything currently on the
  // meta and fires no notifications.
  const runScan = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    runScan.current = async () => {
      if (scanningRef.current) return;
      const { addons, library } = propsRef.current;
      if (addons.length === 0 || library.length === 0) return;

      // Resolve metadata addon — settings override wins; otherwise we
      // walk the manifest-id default order (AIOMetadata → Cinemeta) so
      // a fresh-install user with Cinemeta but no AIOMetadata still
      // gets a sensible meta source rather than whatever was installed
      // first. Final fallback: first installed addon.
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
      const now = Date.now();
      const due = candidates.filter((item) => {
        const s = state[item.id];
        if (!s) return true;
        return now - s.lastChecked > PER_ITEM_DEBOUNCE_MS;
      });
      if (due.length === 0) return;

      scanningRef.current = true;
      try {
        for (const item of due) {
          // Staggered fetch — keeps us from machine-gunning the addon.
          // The first item kicks off immediately; subsequent items wait.
          if (item !== due[0]) {
            await new Promise((r) => setTimeout(r, FETCH_STAGGER_MS));
          }
          let detail: MetaDetail | null = null;
          try {
            detail = await invoke<MetaDetail>("fetch_meta_detail", {
              addonUrl: metaAddon.url,
              mediaType: item.media_type,
              id: item.id,
            });
          } catch {
            // Network / addon error — skip this item but keep its
            // lastChecked stamp so we don't retry it for 30 min.
          }
          const prev = state[item.id] ?? { lastChecked: 0, seenVideoIds: [] };
          const seenSet = new Set<string>(prev.seenVideoIds);
          const isFirstScan = prev.lastChecked === 0;
          if (detail && Array.isArray(detail.videos)) {
            for (const v of detail.videos) {
              if (!v.id) continue;
              if (seenSet.has(v.id)) continue;
              // Mark as seen regardless — the seen set grows monotonically.
              seenSet.add(v.id);
              if (isFirstScan) continue; // first pass: seed only, no notify
              // Skip season 0 — that's the TMDB / TVDB convention for
              // SPECIALS, EXTRAS, FEATURETTES, behind-the-scenes clips,
              // making-of reels. Addons shovel these into the videos
              // array along with regular episodes; without this filter
              // the bell fires for "S00E117 Soldier Boy - VNN
              // Interview" the moment the addon adds it. The user
              // expects new-episode notifications to be about real
              // released episodes, not promotional material.
              if (typeof v.season === "number" && v.season <= 0) continue;
              // Recent-release filter — only fire for videos with a parseable
              // `released` ISO date in the last 30 days.
              const releasedTs = v.released ? Date.parse(v.released) : NaN;
              if (!Number.isFinite(releasedTs)) continue;
              if (now - releasedTs > RECENT_RELEASE_WINDOW_MS) continue;
              if (releasedTs > now + 24 * 60 * 60 * 1000) continue; // future-dated > 1 day → skip
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
      }
    };
  }, [addNotification]);

  useEffect(() => {
    if (activeView !== "home") return;
    // Fire on entry to home.
    runScan.current();
    const id = setInterval(() => { runScan.current(); }, SCAN_INTERVAL_MS);
    return () => clearInterval(id);
  }, [activeView]);

  return null;
}
