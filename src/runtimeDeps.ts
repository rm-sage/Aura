// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Runtime deps — on-demand optional binaries.
//
// ffmpeg.exe (silence detection / Hybrid OP-ED inference) and ffprobe.exe
// (casting transmux) are NOT bundled in the installer (that kept ~314 MB out
// of every update). They're fetched on demand from the `runtime-deps` GitHub
// prerelease into a stable per-user dir that survives updates, verified by the
// Rust side against a baked SHA-256. This is the thin frontend wrapper over the
// `ensure_runtime_dep` / `runtime_dep_present` commands + `runtime-dep-progress`
// event. See src-tauri/src/runtime_deps.rs.
// ---------------------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type RuntimeDepName = "ffmpeg.exe" | "ffprobe.exe";

export interface RuntimeDepProgress {
  name: string;
  downloaded: number;
  total: number;
  /** Present + true on the final event once the file is verified + installed. */
  done?: boolean;
}

/** Whether the binary is already downloaded into the runtime dir (cheap
 *  existence check — no hashing). */
export function runtimeDepPresent(name: RuntimeDepName): Promise<boolean> {
  return invoke<boolean>("runtime_dep_present", { name });
}

/**
 * Ensure a runtime binary is downloaded + verified, resolving to its path.
 * Fast no-op when a correct copy already exists. `onProgress` (optional)
 * receives streaming updates for THIS binary only; the subscription is always
 * torn down when the call settles.
 */
export async function ensureRuntimeDep(
  name: RuntimeDepName,
  onProgress?: (p: RuntimeDepProgress) => void,
): Promise<string> {
  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<RuntimeDepProgress>("runtime-dep-progress", (e) => {
      if (e.payload?.name === name) onProgress(e.payload);
    });
  }
  try {
    return await invoke<string>("ensure_runtime_dep", { name });
  } finally {
    unlisten?.();
  }
}
