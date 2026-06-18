// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// RuntimeComponentsSection — Settings UI for the on-demand optional binaries
// (ffmpeg / ffprobe). They aren't bundled in the installer (keeps ~314 MB out
// of every update); the user downloads them here once when they want the
// dependent features. Downloads are verified against a baked SHA-256 on the
// Rust side and stored in a per-user dir that survives app updates. See
// runtimeDeps.ts + src-tauri/src/runtime_deps.rs.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import {
  ensureRuntimeDep,
  runtimeDepPresent,
  type RuntimeDepName,
  type RuntimeDepProgress,
} from "./runtimeDeps";

interface DepUi {
  name: RuntimeDepName;
  label: string;
  approxMb: number;
  purpose: string;
}

const DEPS: DepUi[] = [
  { name: "ffmpeg.exe",  label: "FFmpeg",  approxMb: 97,  purpose: "Silence detection — automatic OP/ED skip inference (Hybrid mode)." },
  { name: "ffprobe.exe", label: "FFprobe", approxMb: 97,  purpose: "Casting transmux — play files a Chromecast can't natively decode (e.g. some MKVs)." },
];

const fmtMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;

export default function RuntimeComponentsSection() {
  const [present, setPresent] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<RuntimeDepName | null>(null);
  const [progress, setProgress] = useState<RuntimeDepProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    for (const d of DEPS) {
      runtimeDepPresent(d.name)
        .then((ok) => { if (alive) setPresent((p) => ({ ...p, [d.name]: ok })); })
        .catch(() => {});
    }
    return () => { alive = false; };
  }, []);

  const download = async (name: RuntimeDepName) => {
    setError(null);
    setBusy(name);
    setProgress(null);
    try {
      await ensureRuntimeDep(name, (p) => setProgress(p));
      setPresent((p) => ({ ...p, [name]: true }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-white/55 text-[12.5px] leading-relaxed mb-4">
        These components aren&apos;t bundled with Aura — download them once to enable the
        features below. They&apos;re stored separately and survive app updates, so you
        won&apos;t re-download them on the next version.
      </p>

      <div className="flex flex-col gap-2.5">
        {DEPS.map((d) => {
          const installed = present[d.name];
          const downloading = busy === d.name;
          const pct =
            downloading && progress && progress.total > 0
              ? Math.round((progress.downloaded / progress.total) * 100)
              : null;
          return (
            <div
              key={d.name}
              className="flex items-start gap-3 rounded-lg border border-white/8 bg-white/[0.02] px-3.5 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-white/90 text-[13.5px] font-medium">{d.label}</span>
                  {installed ? (
                    <span className="text-[10.5px] font-semibold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      Installed
                    </span>
                  ) : (
                    <span className="text-white/40 text-[11px] font-mono tabular-nums">~{d.approxMb} MB</span>
                  )}
                </div>
                <p className="text-white/45 text-[11.5px] leading-snug mt-0.5">{d.purpose}</p>
                {downloading && (
                  <div className="mt-2">
                    <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                      <div
                        className="h-full bg-ln-accent transition-[width] duration-300 ease-linear"
                        style={{ width: `${pct ?? 0}%` }}
                      />
                    </div>
                    <span className="text-white/45 text-[11px] font-mono tabular-nums mt-1 inline-block">
                      {pct != null
                        ? `${pct}% · ${fmtMb(progress!.downloaded)} / ${fmtMb(progress!.total)}`
                        : "Starting…"}
                    </span>
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={downloading}
                onClick={() => download(d.name)}
                className={`flex-shrink-0 px-3.5 py-1.5 rounded-lg text-[12.5px] font-medium tracking-wide transition-colors
                            ${downloading
                              ? "text-white/40 bg-white/[0.04] border border-white/8 cursor-progress"
                              : "text-ln-accent bg-ln-accent/15 border border-ln-accent/35 hover:bg-ln-accent/25 hover:border-ln-accent/55"}`}
              >
                {downloading ? "Downloading…" : installed ? "Re-download" : "Download"}
              </button>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="text-amber-300/90 text-[12px] leading-snug mt-3">
          Download failed: {error}
        </p>
      )}
    </div>
  );
}
