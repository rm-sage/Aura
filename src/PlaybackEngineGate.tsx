// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PlaybackEngineGate — first-run download of the mpv engine (libmpv).
//
// libmpv is no longer bundled in the installer (keeps ~115 MB out of every
// update). On a FRESH install the engine can't start until libmpv is fetched, so
// this gate: checks `playback_engine_ready`; if not ready, downloads
// `libmpv-2.dll` from the runtime-deps release (verified by the Rust side) with
// progress, then calls `ensure_playback_engine` to start the engine, then self-
// hides. On an UPDATE the prior version's libmpv-2.dll is still on disk and the
// engine starts at launch, so the gate never appears. Non-Windows reports ready
// (no Windows libmpv to fetch). See runtimeDeps.ts + src-tauri/src/lib.rs.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ensureRuntimeDep, type RuntimeDepProgress } from "./runtimeDeps";

type Phase = "checking" | "downloading" | "starting" | "ready" | "error";

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

export default function PlaybackEngineGate() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [progress, setProgress] = useState<RuntimeDepProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lets the user browse while the (one-time) download runs in the background.
  const [hidden, setHidden] = useState(false);

  const setup = async () => {
    setError(null);
    try {
      if (await invoke<boolean>("playback_engine_ready")) {
        setPhase("ready");
        return;
      }
      setPhase("downloading");
      setProgress(null);
      await ensureRuntimeDep("libmpv-2.dll", (p) => setProgress(p));
      setPhase("starting");
      const ok = await invoke<boolean>("ensure_playback_engine");
      if (ok) {
        setPhase("ready");
        return;
      }
      setError("The playback engine couldn't start after downloading. Please try again.");
      setPhase("error");
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/i, "").split("\n")[0].trim().slice(0, 160));
      setPhase("error");
    }
  };

  useEffect(() => { void setup(); }, []);

  // Done, still verifying, or the user chose to browse meanwhile → no overlay.
  if (phase === "ready" || phase === "checking" || hidden) return null;

  const pct =
    progress && progress.total > 0
      ? Math.round((progress.downloaded / progress.total) * 100)
      : null;

  return (
    <div className="fixed inset-0 z-[10600] flex items-center justify-center bg-black/85 backdrop-blur-md animate-[fade-in_140ms_ease-out]">
      <div className="aura-glass-menu rounded-2xl max-w-[440px] w-[92%] p-7 text-white text-center">
        <h2 className="text-[17px] font-semibold tracking-tight mb-2">Setting up Aura</h2>
        <p className="text-white/70 text-[13px] leading-relaxed mb-5">
          {phase === "error"
            ? "Aura needs its playback engine (libmpv, ~115 MB) before it can play video."
            : "Downloading the playback engine (libmpv, ~115 MB). One-time setup — future updates won’t re-download it."}
        </p>

        {(phase === "downloading" || phase === "starting") && (
          <div className="mb-2">
            <div className="h-2 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-ln-accent transition-[width] duration-300 ease-linear"
                style={{ width: phase === "starting" ? "100%" : `${pct ?? 0}%` }}
              />
            </div>
            <span className="text-white/50 text-[11.5px] font-mono tabular-nums mt-1.5 inline-block">
              {phase === "starting"
                ? "Starting engine…"
                : pct != null
                  ? `${pct}% · ${mb(progress!.downloaded)} / ${mb(progress!.total)}`
                  : "Starting download…"}
            </span>
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setHidden(true)}
                className="text-white/45 text-[12px] hover:text-white/75 transition-colors underline-offset-2 hover:underline"
              >
                Continue browsing (playback unavailable until this finishes)
              </button>
            </div>
          </div>
        )}

        {phase === "error" && (
          <>
            <p className="text-amber-300/90 text-[12px] leading-snug mb-4">{error}</p>
            <div className="flex items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={() => void setup()}
                className="px-5 py-2 rounded-lg text-[13px] font-medium tracking-wide text-ln-accent bg-ln-accent/15 border border-ln-accent/35 hover:bg-ln-accent/25 hover:border-ln-accent/55 transition-colors"
              >
                Retry
              </button>
              <button
                type="button"
                onClick={() => setHidden(true)}
                className="px-5 py-2 rounded-lg text-[13px] font-medium tracking-wide text-white/85 bg-white/[0.06] border border-white/10 hover:bg-white/[0.10] hover:text-white transition-colors"
              >
                Continue browsing
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
