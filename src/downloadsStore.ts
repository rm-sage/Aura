// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// downloadsStore — a PROJECTION of the Rust job list, not a copy that drifts.
//
// Rust is authoritative. This module holds whatever the last
// `downloads-snapshot` event carried, and rehydrates by calling
// `downloads_list` on init. That split is deliberate: the webview can be
// reloaded out from under a running transfer (F5, Ctrl+R, the stream-lost
// modal's Reload button at App.tsx, an HMR module swap in dev) and none of
// those may lose a 40 GB download. Anything this module forgets is one
// `downloads_list` away.
//
// There is therefore NO optimistic state here. Every mutation goes through
// `downloads_control`, which returns a fresh snapshot; the store applies that
// and nothing else. An optimistic "Paused" that the engine then refuses would
// be a lie the user has to click twice to clear.
//
// Structural twin of scrobbleRun.ts (module-scope singleton + a Set of
// subscribers + useSyncExternalStore), which is the house pattern.
// ---------------------------------------------------------------------------

export type DownloadState =
  | "queued"
  | "running"
  | "paused"
  | "relinking"
  | "needs_source"
  | "completed"
  | "failed";

export type JobKind = "http" | "hls_ledger" | "hls_passthrough";

export interface JobOrigin {
  stream_id: string;
  media_type: string;
  addon_name: string;
  match_key: string;
}

export interface DownloadJob {
  id: string;
  state: DownloadState;
  kind: JobKind;
  url: string;
  headers: Array<[string, string]>;
  title: string;
  subtitle: string | null;
  dest_path: string;
  part_path: string;
  total_bytes: number | null;
  bytes_done: number;
  resumable: boolean;
  validator: string | null;
  origin: JobOrigin;
  attempt: number;
  error: string | null;
  created_at: number;
  completed_at: number | null;
  truncated: boolean;
  /** Live, computed by Rust at snapshot time. */
  speed_bps: number | null;
  eta_secs: number | null;
  /** False for a single-pass HLS remux, which cannot be paused. */
  pausable: boolean;
}

export interface DownloadsSnapshot {
  jobs: DownloadJob[];
  active: number;
  overall: number | null;
  total_speed_bps: number;
  root: string;
}

const EMPTY: DownloadsSnapshot = {
  jobs: [],
  active: 0,
  overall: null,
  total_speed_bps: 0,
  root: "",
};

let snapshot: DownloadsSnapshot = EMPTY;
const subscribers = new Set<() => void>();

function emit(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

const getSnapshot = (): DownloadsSnapshot => snapshot;

/** The live job list. Safe to call from any component. */
export function useDownloads(): DownloadsSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Non-hook read, for callers outside React (event handlers, guards). */
export function downloadsSnapshot(): DownloadsSnapshot {
  return snapshot;
}

/** Terminal states seen already, so a notice fires once per job rather than on
 *  every snapshot that still contains it. Bounded by `clear_finished` and by
 *  the cap below, so it cannot grow without limit across a long session. */
const notified = new Set<string>();
const NOTIFIED_CAP = 300;

/** Announce a job that just reached a terminal state.
 *
 *  Fires BOTH channels, which is the house idiom for "important and must
 *  survive": the bell keeps it (via the existing `aura:notify-force` bridge in
 *  App), and a toast surfaces it now. The toast is a non-player surface at
 *  z-[300], so during playback only the bell entry lands; that matches how the
 *  bell already defers its popup while the player is up and shows it the next
 *  time the user reaches a bell-visible surface. */
function announce(job: DownloadJob): void {
  const ok = job.state === "completed";
  window.dispatchEvent(
    new CustomEvent("aura:notify-force", {
      detail: {
        id: `download:${job.id}`,
        kind: ok ? "success" : "error",
        title: ok ? "Download finished" : "Download failed",
        subtitle: ok ? job.title : `${job.title} - ${job.error ?? "unknown error"}`,
      },
    }),
  );
  void import("./AppToast").then(({ showAppToast }) => {
    showAppToast(
      ok ? `Downloaded ${job.title}` : `Could not download ${job.title}`,
      { tone: ok ? "success" : "danger", duration: ok ? 4000 : 6000 },
    );
  });
}

function apply(next: DownloadsSnapshot): void {
  const previous = snapshot;
  snapshot = next;

  // Announce only on a TRANSITION into a terminal state. The very first
  // snapshot after a launch is skipped: jobs restored from disk as `failed`
  // are old news, and toasting them at startup would be noise.
  if (previous !== EMPTY) {
    const before = new Map(previous.jobs.map((j) => [j.id, j.state]));
    for (const j of next.jobs) {
      if (j.state !== "completed" && j.state !== "failed") continue;
      if (notified.has(j.id)) continue;
      const was = before.get(j.id);
      if (was === undefined || was === j.state) continue;
      notified.add(j.id);
      announce(j);
    }
  }
  // Forget ids that are no longer in the list, then hard-cap as a backstop.
  if (notified.size > NOTIFIED_CAP) {
    const live = new Set(next.jobs.map((j) => j.id));
    for (const id of notified) if (!live.has(id)) notified.delete(id);
    if (notified.size > NOTIFIED_CAP) notified.clear();
  }

  emit();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let started = false;
let unlisten: (() => void) | null = null;

/** Mount once from App. Idempotent, so a StrictMode double-effect is free. */
export function startDownloadsStore(): () => void {
  if (started) return () => {};
  started = true;

  void invoke<DownloadsSnapshot>("downloads_list")
    .then(apply)
    .catch(() => {
      // A failure here means the command is not registered (the classic
      // three-places miss) or the engine did not initialise. Leave the store
      // empty rather than throwing: the button simply shows nothing.
    });

  void listen<DownloadsSnapshot>("downloads-snapshot", (e) => {
    apply(e.payload);
  }).then((fn) => {
    unlisten = fn;
  });

  return () => {
    unlisten?.();
    unlisten = null;
    started = false;
  };
}

// ---------------------------------------------------------------------------
// Control
// ---------------------------------------------------------------------------

type ControlAction =
  | { op: "pause"; id: string }
  | { op: "resume"; id: string }
  | { op: "cancel"; id: string }
  | { op: "retry"; id: string }
  | { op: "relink"; id: string; url: string; headers: Array<[string, string]> }
  | { op: "relink_failed"; id: string; reason?: string }
  | { op: "reorder"; id: string; to_index: number }
  | { op: "clear_finished" }
  | { op: "pause_all" };

async function control(action: ControlAction): Promise<void> {
  try {
    const next = await invoke<DownloadsSnapshot>("downloads_control", { action });
    apply(next);
  } catch (e) {
    // The engine refuses some transitions on purpose (pausing a single-pass
    // remux). Surfacing the reason beats a silent no-op.
    const msg = e instanceof Error ? e.message : String(e);
    const { showAppToast } = await import("./AppToast");
    showAppToast(msg, { tone: "danger" });
  }
}

export const pauseDownload = (id: string) => control({ op: "pause", id });
export const resumeDownload = (id: string) => control({ op: "resume", id });
export const cancelDownload = (id: string) => control({ op: "cancel", id });
export const retryDownload = (id: string) => control({ op: "retry", id });
export const clearFinishedDownloads = () => control({ op: "clear_finished" });
export const pauseAllDownloads = () => control({ op: "pause_all" });
export const reorderDownload = (id: string, toIndex: number) =>
  control({ op: "reorder", id, to_index: toIndex });
export const relinkDownload = (
  id: string,
  url: string,
  headers: Array<[string, string]>,
) => control({ op: "relink", id, url, headers });
export const relinkFailed = (id: string, reason?: string) =>
  control({ op: "relink_failed", id, reason });

// ---------------------------------------------------------------------------
// Formatting — shared by the button, the rows and the toasts so the three
// never disagree about how a number reads.
// ---------------------------------------------------------------------------

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.round(v)} ${units[i]}` : `${v.toFixed(1)} ${units[i]}`;
}

export function formatSpeed(bps: number | null | undefined): string {
  if (!bps) return "";
  return `${formatBytes(bps)}/s`;
}

/** Coarse by design above a minute: a per-second ETA on a 40 GB download is
 *  noise, and the snapshot cadence could not honour it anyway. */
export function formatEta(secs: number | null | undefined): string {
  if (secs == null || !Number.isFinite(secs) || secs <= 0) return "";
  if (secs < 60) return `${Math.round(secs)}s left`;
  const min = Math.round(secs / 60);
  if (min < 60) return `${min} min left`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  if (hr < 24) return rem ? `${hr}h ${rem}m left` : `${hr}h left`;
  return `${Math.round(hr / 24)}d left`;
}

/** Fraction complete, or null when the size is unknown and a bar would be a
 *  fiction. */
export function jobProgress(j: DownloadJob): number | null {
  if (!j.total_bytes || j.total_bytes <= 0) return null;
  return Math.max(0, Math.min(1, j.bytes_done / j.total_bytes));
}

/** One short line for the row's status area. */
export function jobStatusLine(j: DownloadJob): string {
  switch (j.state) {
    case "queued":
      return "Waiting";
    case "running": {
      const done = formatBytes(j.bytes_done);
      const total = j.total_bytes ? ` of ${formatBytes(j.total_bytes)}` : "";
      const speed = j.speed_bps ? ` · ${formatSpeed(j.speed_bps)}` : "";
      const eta = j.eta_secs ? ` · ${formatEta(j.eta_secs)}` : "";
      return `${done}${total}${speed}${eta}`;
    }
    case "paused":
      return j.total_bytes
        ? `Paused at ${formatBytes(j.bytes_done)} of ${formatBytes(j.total_bytes)}`
        : `Paused at ${formatBytes(j.bytes_done)}`;
    case "relinking":
      return "Refreshing link";
    case "needs_source":
      return j.error ?? "Source unavailable";
    case "completed":
      return formatBytes(j.total_bytes ?? j.bytes_done);
    case "failed":
      return j.error ?? "Failed";
  }
}
