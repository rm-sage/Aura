// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EpisodeGrouping } from "./storyArcs";

// ---------------------------------------------------------------------------
// GroupingToggle — the Seasons | Arcs segmented control.
//
// Shared by the Detail page episode list AND the in-player episode panel so the
// two read as the same control (and cannot drift). Mirrors LiveView's
// ViewModeToggle styling.
// ---------------------------------------------------------------------------

export default function GroupingToggle({
  mode,
  onChange,
  loading = false,
}: {
  mode: EpisodeGrouping;
  onChange: (m: EpisodeGrouping) => void;
  /** Arcs are still resolving: the Arcs button shows a spinner and is inert
   *  (there is nothing to switch to yet), but the control is present so it does
   *  not pop into the header a moment later. */
  loading?: boolean;
}) {
  return (
    <div className="flex gap-1 p-0.5 rounded-lg bg-white/6 border border-white/8" role="group" aria-label="Episode grouping">
      {(["seasons", "arcs"] as const).map((m) => {
        const arcsLoading = loading && m === "arcs";
        return (
          <button
            key={m}
            type="button"
            onClick={() => { if (!arcsLoading) onChange(m); }}
            disabled={arcsLoading}
            aria-pressed={mode === m}
            aria-busy={arcsLoading}
            className={[
              "px-2.5 h-6 rounded-md text-[11px] font-medium capitalize transition-colors",
              "inline-flex items-center gap-1 disabled:cursor-default",
              mode === m
                ? "bg-ln-accent/20 text-ln-accent"
                : arcsLoading
                  ? "text-white/35"
                  : "text-white/50 hover:text-white/85",
            ].join(" ")}
          >
            {arcsLoading && (
              <svg width="9" height="9" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"
                        strokeWidth="3" strokeLinecap="round" strokeDasharray="42 14" opacity="0.9" />
              </svg>
            )}
            {m}
          </button>
        );
      })}
    </div>
  );
}
