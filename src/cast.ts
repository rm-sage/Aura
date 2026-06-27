// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// cast.ts — typed invoke() wrappers for the casting backend (src-tauri/
// src/cast/). Chromecast + DLNA v1; see the 2026-06-09 casting spec.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";

export interface CastDeviceInfo {
  id: string;
  name: string;
  host: string;
  port: number;
  model: string | null;
  /** "chromecast" | "dlna" */
  kind: string;
  control_url: string | null;
  audio_only: boolean;
}

export interface CastStatus {
  /** "playing" | "paused" | "buffering" | "idle" | "unknown" */
  player_state: string;
  position_sec: number;
  duration_sec: number | null;
  device_name: string;
  kind: string;
  transcoding: boolean;
}

export function discoverCastDevices(): Promise<CastDeviceInfo[]> {
  return invoke<CastDeviceInfo[]>("cast_discover");
}

export function castLoad(opts: {
  device: CastDeviceInfo;
  url: string;
  title?: string | null;
  poster?: string | null;
  startSeconds?: number | null;
}): Promise<void> {
  return invoke("cast_load", {
    device: opts.device,
    url: opts.url,
    title: opts.title ?? null,
    poster: opts.poster ?? null,
    startSeconds: opts.startSeconds ?? null,
  });
}

export const castPlay = () => invoke<void>("cast_play");
export const castPause = () => invoke<void>("cast_pause");
export const castSeek = (positionSec: number) =>
  invoke<void>("cast_seek", { positionSec });
/** Resolves to the device's last known position (for local resume). */
export const castStop = () => invoke<number>("cast_stop");
export const castStatus = () => invoke<CastStatus>("cast_status");
export const castFfmpegPresent = () => invoke<boolean>("cast_ffmpeg_present");

// Mirror of the Rust transmux gate (cast/transcode.rs TRANSMUX_EXT plus
// cast/mod.rs is_hls): container extensions the Chromecast Default Media
// Receiver cannot open directly, so Aura re-segments them to HLS via
// ffmpeg. HLS (.m3u8) and direct-play containers (.mp4 / .m4v / .webm) are
// deliberately NOT here. The picker uses this to pre-flight the on-demand
// ffmpeg component before starting a doomed Chromecast session.
const TRANSMUX_EXTENSIONS = new Set([
  "mkv", "avi", "flv", "wmv", "m2ts", "mts", "ts", "vob", "mpg", "mpeg",
  "ogv", "ogm", "divx", "rmvb", "rm", "asf", "3gp",
]);

/** True when `url` is a container that needs an ffmpeg transmux for a
 *  Chromecast (non-HLS, extension in the transmux set). Matches the Rust
 *  decision in `cast::cast_load`. */
export function needsTransmux(url: string): boolean {
  const path = (url.split("?")[0] ?? "").toLowerCase();
  if (path.endsWith(".m3u8")) return false;
  const ext = path.split(".").pop();
  return ext ? TRANSMUX_EXTENSIONS.has(ext) : false;
}
