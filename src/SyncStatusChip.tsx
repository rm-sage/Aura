// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import Tooltip from "./Tooltip";
import { useIdleGatedInterval } from "./useIdleGate";

// ---------------------------------------------------------------------------
// SyncStatusChip — tiny cloud icon in the title bar that reflects the live
// Aura Cloud sync state at a glance. Four visual states:
//
//   • Gray cloud  — guest mode (no Stremio session → no sync available)
//   • Green check — connected, last sync_status query succeeded recently
//   • Amber alert — connected, but no successful sync in over a week
//                   (NS updated_at falls in the stale window)
//   • Rose error  — connected, last sync_status query failed (network /
//                   proxy down / auth refused)
//
// Polls `sync_status` every 60s. Re-fires on `aura:settings-changed`
// (account switch dispatches this) so the chip reflects sign-in /
// sign-out within one render. Tooltip surfaces the most recent
// per-namespace updated_at as "Last synced N minutes ago".
//
// Click opens the Cloud Sync settings section (`sec-cloud-sync`) once
// Task #4 lands. Until then, falls back to the Storage section since
// it's the closest sync-adjacent surface in Settings today.
// ---------------------------------------------------------------------------

interface NamespaceStatus {
  name: string;
  etag: string | null;
  updated_at: number | null;
  size: number | null;
}

interface SyncStatus {
  connected: boolean;
  namespaces: NamespaceStatus[];
  total_size: number;
  quota: number;
}

type ChipState = "guest" | "ok" | "stale" | "error";

const POLL_INTERVAL_MS = 60_000;
/** Cadence for the relative-time tooltip. Separate from POLL_INTERVAL_MS
 *  because the two answer different questions: one refetches server state, the
 *  other just advances the local clock. `formatAgo`'s finest unit is a minute,
 *  so 30 s is a 2x oversample and the "N min ago" line can never be a whole
 *  display unit behind. */
const TICK_INTERVAL_MS = 30_000;
/** Treat the sync as "stale" when the most recent namespace update is
 *  older than this. One week matches the AniList token warn window —
 *  reasonable for "haven't been active on this account in a while".
 *  Lower if we want sharper feedback later. */
const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export default function SyncStatusChip() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [errored, setErrored] = useState(false);
  // Tick state so the relative tooltip ("3 minutes ago") refreshes on
  // its own without waiting for the next poll cycle.
  const [tickNow, setTickNow] = useState(() => Date.now());

  // Guards a late `sync_status` reply landing after unmount. Set on mount (not
  // just at declaration) so a StrictMode double-mount re-arms it.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<SyncStatus>("sync_status");
      if (!aliveRef.current) return;
      setStatus(s);
      setErrored(false);
    } catch {
      if (!aliveRef.current) return;
      setErrored(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Refresh on settings change (theme, etc. — cheap) AND on session
    // transitions (sign-in / sign-out / account switch — the chip's
    // primary trigger for changing colour). Without the session
    // listener, the chip would lag up to one POLL_INTERVAL_MS after
    // login before going from gray to green.
    const onRefreshSignal = () => { void refresh(); };
    window.addEventListener("aura:settings-changed", onRefreshSignal);
    window.addEventListener("aura:session-changed",  onRefreshSignal);
    return () => {
      window.removeEventListener("aura:settings-changed", onRefreshSignal);
      window.removeEventListener("aura:session-changed",  onRefreshSignal);
    };
  }, [refresh]);

  // The chip lives in the title bar, invisible while minimized, so both the
  // status IPC and the relative-time tick pause there. `runOnResume` is the
  // load-bearing half: the old hand-rolled `if (!isWindowHidden())` intervals
  // skipped their work while hidden but had no catch-up, so restoring after an
  // hour in the tray left the tooltip reporting whatever it said on the way
  // out, for up to a further minute. Both now snap current on the way back in.
  useIdleGatedInterval(() => { void refresh(); }, POLL_INTERVAL_MS, { runOnResume: true });
  useIdleGatedInterval(() => setTickNow(Date.now()), TICK_INTERVAL_MS, { runOnResume: true });

  // Most recent updated_at across all namespaces. `null` when:
  //   • Guest mode (no namespaces returned)
  //   • Connected but no namespace has ever been written (fresh account)
  const lastSyncMs = useMemo(() => {
    if (!status?.namespaces?.length) return null;
    const max = status.namespaces.reduce(
      (acc, ns) => (ns.updated_at && ns.updated_at > acc ? ns.updated_at : acc),
      0,
    );
    return max > 0 ? max * 1000 : null;
  }, [status]);

  const state: ChipState = useMemo(() => {
    if (errored && status?.connected) return "error";
    if (!status || !status.connected) return "guest";
    if (lastSyncMs != null && tickNow - lastSyncMs > STALE_WINDOW_MS) return "stale";
    return "ok";
  }, [errored, status, lastSyncMs, tickNow]);

  const tooltip = useMemo(() => {
    if (state === "guest") return "Cloud sync disabled — sign in to Stremio to enable";
    if (state === "error") return "Cloud sync — last status check failed";
    if (state === "stale" && lastSyncMs) return `Cloud sync — last activity ${formatAgo(tickNow - lastSyncMs)}`;
    if (state === "ok" && lastSyncMs)    return `Cloud sync — last activity ${formatAgo(tickNow - lastSyncMs)}`;
    return "Cloud sync — connected (no data yet)";
  }, [state, lastSyncMs, tickNow]);

  // Click jumps to the Cloud Sync section if it exists, otherwise the
  // closest sync-adjacent surface (Storage). Use a scroll-to anchor so
  // we don't have to deep-link via a custom event chain when the user
  // is already on Settings, AND we dispatch a nav event so the App
  // routes them to Settings when they're elsewhere.
  const openSettingsCloudSync = () => {
    window.dispatchEvent(new CustomEvent("aura:open-settings", {
      detail: { section: "sec-cloud-sync" },
    }));
  };

  return (
    <Tooltip text={tooltip} pos="bottom">
      <button
        type="button"
        onClick={openSettingsCloudSync}
        aria-label={tooltip}
        data-no-drag
        className="flex items-center justify-center w-8 h-full transition-opacity hover:opacity-100"
        style={{
          color: COLOR[state],
          opacity: state === "guest" ? 0.45 : 0.78,
          pointerEvents: "auto",
        }}
      >
        <CloudIcon state={state} />
      </button>
    </Tooltip>
  );
}

const COLOR: Record<ChipState, string> = {
  guest: "rgba(255,255,255,0.6)",
  ok:    "rgb(110, 231, 183)",   // emerald-300
  stale: "rgb(252, 211, 77)",    // amber-300
  error: "rgb(251, 113, 133)",   // rose-400
};

/** Compact relative-time formatter for the tooltip. Mirrors the
 *  expiry formatter in SettingsView so the two surfaces feel
 *  consistent without sharing state. */
function formatAgo(diffMs: number): string {
  if (diffMs < 0) return "in the future";
  const sec = Math.round(diffMs / 1000);
  // Deliberately NO seconds bucket. The clock behind this advances every
  // TICK_INTERVAL_MS, so a "42s ago" reading would be wrong the instant after
  // it rendered and would sit frozen until the next tick; "just now" is true
  // for the whole sub-minute window. Matches SettingsView's formatAgo. If you
  // ever want real seconds here, the tick has to drop to 1 s with it (same
  // rule as releaseCountdown.ts::showsSeconds).
  if (sec < 45) return "just now";
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(diffMs / 3_600_000);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(diffMs / 86_400_000);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(diffMs / (86_400_000 * 30));
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.round(diffMs / (86_400_000 * 365));
  return `${yr}y ago`;
}

function CloudIcon({ state }: { state: ChipState }) {
  // Outer path is the standard cloud silhouette; inner mark varies by
  // state (checkmark / alert / X / nothing) so a glance reads the
  // status without parsing color alone.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.7-1.5A4 4 0 0 0 6 18h11Z" />
      {state === "ok"    && <path d="M9 13.5l2 2 4-4" />}
      {state === "stale" && <path d="M12 11v3M12 16v0.1" />}
      {state === "error" && <path d="M9.5 12l5 4M14.5 12l-5 4" />}
    </svg>
  );
}
