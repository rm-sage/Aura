// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cancelScrobbleRun, useScrobbleRun } from "./scrobbleRun";

// ---------------------------------------------------------------------------
// ScrobbleRunBar — progress for the in-flight bulk scrobble.
//
// Mounted from App, NOT from HistoryView, on purpose: the job outlives the
// History page. When this lived in the view, navigating away tore the bar down
// while the run carried on firing requests invisibly. Rendering it at the shell
// means the run is always accounted for, wherever the user has wandered to.
// Renders nothing at all when no job is running.
// ---------------------------------------------------------------------------

export default function ScrobbleRunBar({ suppressed = false }: { suppressed?: boolean }) {
  const run = useScrobbleRun();
  // Hidden, but NOT stopped: during playback (a stream or a trailer) the bar
  // would sit on top of the video, and while the close-confirmation prompt is up
  // that prompt renders its own progress. The job keeps running either way and
  // the bar comes straight back when the reason to hide it goes away.
  if (!run.running || suppressed) return null;

  const pct = Math.round((run.done / Math.max(1, run.total)) * 100);

  return (
    <div
      className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[250]
                 flex items-center gap-3 px-4 py-2.5 rounded-full
                 bg-black/85 backdrop-blur-xl border border-white/15
                 shadow-2xl shadow-black/50"
      role="status"
      aria-live="polite"
    >
      <span className="text-white/85 text-xs font-mono tabular-nums whitespace-nowrap">
        {run.backingOff
          ? `Rate limited — retrying ${run.done}/${run.total}`
          : `Scrobbling ${run.done}/${run.total}`}
      </span>

      <div className="h-1 w-28 rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full transition-[width] duration-200 ${run.backingOff ? "bg-amber-400" : "bg-ln-accent"}`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {run.failed > 0 && (
        <span className="text-rose-300/80 text-[11px] font-mono tabular-nums whitespace-nowrap">
          {run.failed} failed
        </span>
      )}

      <button
        type="button"
        onClick={cancelScrobbleRun}
        className="px-3 py-1 rounded-full text-xs font-medium border transition-colors
                   bg-white/5 text-white/70 border-white/15
                   hover:bg-rose-500/20 hover:text-rose-200 hover:border-rose-300/40"
      >
        Cancel
      </button>
    </div>
  );
}
