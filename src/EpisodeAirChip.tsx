// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// EpisodeAirChip — the live "airs in …" countdown pill OVERLAID on the
// next-to-air episode's thumbnail, in the SAME style as the Continue-
// Watching tile countdown (CinemaRows.tsx::CWReleaseCountdown): a centred,
// blurred dark pill with an accent clock + text-shadow, legible over light
// AND dark cover art.
//
// Render this INSIDE the thumbnail's `relative` container — it positions
// itself absolutely (bottom-centre). Render EXACTLY ONE per list, on the
// next-airing row. PERF: owns its own 1 s tick, so only this pill
// re-renders each second; the surrounding episode list never ticks. Later
// unaired rows show a static date in the card body instead.
// ---------------------------------------------------------------------------

import { formatCountdown, useCountdownNow } from "./releaseCountdown";

export default function EpisodeAirChip({ targetMs }: { targetMs: number }) {
  const now = useCountdownNow();
  if (targetMs <= now) return null; // aired since mount — drop the pill
  return (
    <div className="absolute inset-x-0 bottom-1.5 flex justify-center pointer-events-none z-10">
      <span
        className="inline-flex items-center gap-1 whitespace-nowrap px-2 py-0.5 rounded-full
                   bg-black/72 backdrop-blur-sm border border-white/15
                   text-white text-[11px] font-semibold tabular-nums"
        style={{ textShadow: "0 1px 2px rgba(0,0,0,0.9)" }}
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" className="text-ln-accent" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {formatCountdown(targetMs, now, { compactDays: true })}
      </span>
    </div>
  );
}
