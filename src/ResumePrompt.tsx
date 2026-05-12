// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect } from "react";

// ---------------------------------------------------------------------------
// ResumePrompt — small modal shown right before a stream loads when the
// library carries a non-trivial timeOffset for the target. Three exit
// paths now:
//   • Resume from saved position (button)
//   • Start over from the beginning (button)
//   • Cancel — dismiss without playing (Esc OR click outside the panel)
//
// The Enter / Esc keyboard shortcuts for Resume / Start-over have been
// removed; both keys would routinely fire as a side effect of typing
// elsewhere on the page right before a click landed, leading to silent
// "wrong choice" outcomes. Cancel is the only key-bound action now, and
// it just dismisses the prompt — no playback ensues.
// ---------------------------------------------------------------------------

export interface PendingResume {
  /** Saved offset in seconds (always > 0 when this prompt is shown). */
  resumeSeconds: number;
  /** Stream duration in seconds, when known. Renders the "X% in" hint. */
  durationSeconds?: number | null;
  /** Title to display so the user knows which stream they're resuming. */
  title: string;
  /** Optional episode tag (S01E05) shown next to the title. */
  episodeTag?: string | null;
  /** Called when the user picks Resume. */
  onResume: () => void;
  /** Called when the user picks Start over. */
  onStartOver: () => void;
  /** Called when the user dismisses the prompt (Esc / click outside).
   *  Caller is expected to abort the in-progress play flow — no stream
   *  is started in this branch. */
  onCancel: () => void;
}

function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export default function ResumePrompt({ pending }: { pending: PendingResume | null }) {
  // Esc → cancel (dismiss without starting playback). Enter no longer
  // bound — accidental Enter from typing-elsewhere would silently auto-
  // resume otherwise. Both buttons remain click-only for the
  // resume/start-over choice.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        pending.onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  if (!pending) return null;

  const pct = pending.durationSeconds && pending.durationSeconds > 0
    ? Math.min(100, Math.max(0, (pending.resumeSeconds / pending.durationSeconds) * 100))
    : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="resume-prompt-title"
      // Backdrop click → cancel. We compare e.target to e.currentTarget
      // so a click inside the panel doesn't propagate as "outside" by
      // accident.
      onClick={(e) => { if (e.target === e.currentTarget) pending.onCancel(); }}
      className="fixed inset-0 z-[1500] flex items-center justify-center
                 bg-black/70 backdrop-blur-md animate-[fade-in_120ms_ease-out]"
    >
      <div className="aura-glass-menu rounded-2xl max-w-[420px] w-[92%] p-6 text-white">
        <h2
          id="resume-prompt-title"
          className="text-[16px] font-semibold tracking-tight mb-1"
        >
          Resume where you left off?
        </h2>
        <p className="text-white/70 text-[13px] leading-relaxed mb-4">
          <span className="text-white/95">{pending.title}</span>
          {pending.episodeTag && (
            <span className="text-white/55 font-mono text-[12px] ml-2">
              {pending.episodeTag}
            </span>
          )}
        </p>

        <div className="rounded-xl border border-white/12 bg-white/[0.03] p-3 mb-4">
          <p className="text-white/55 text-[10.5px] font-mono uppercase tracking-[0.2em] mb-1.5">
            Saved Position
          </p>
          <div className="flex items-baseline gap-3">
            <span className="text-white text-[20px] font-mono tabular-nums">
              {formatTime(pending.resumeSeconds)}
            </span>
            {pending.durationSeconds && (
              <span className="text-white/45 text-[11.5px] tabular-nums">
                / {formatTime(pending.durationSeconds)}
                {pct != null && ` · ${pct.toFixed(0)}% in`}
              </span>
            )}
          </div>
          {pct != null && (
            <div className="mt-2 h-1 rounded-full bg-white/8 overflow-hidden">
              <div
                className="h-full bg-ln-accent"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={pending.onStartOver}
            className="px-4 py-2 rounded-lg text-[13px] font-medium tracking-wide
                       text-white/85 bg-white/[0.06] border border-white/12
                       hover:bg-white/[0.10] hover:text-white
                       transition-colors"
          >
            Start over
          </button>
          <button
            type="button"
            onClick={pending.onResume}
            className="px-4 py-2 rounded-lg text-[13px] font-medium tracking-wide
                       text-ln-accent bg-ln-accent/15 border border-ln-accent/35
                       hover:bg-ln-accent/25 hover:border-ln-accent/55
                       transition-colors"
          >
            Resume from {formatTime(pending.resumeSeconds)}
          </button>
        </div>
        <p className="text-white/35 text-[11px] mt-3 text-center">
          Esc or click outside to cancel
        </p>
      </div>
    </div>
  );
}
