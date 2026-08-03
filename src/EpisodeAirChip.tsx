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
// next-airing row. PERF: owns its own tick, so only this pill re-renders;
// the surrounding episode list never ticks. Later unaired rows show a static
// date in the card body instead.
//
// The SAME `compactDays` opts go to both useCountdownNow and formatCountdown,
// so the tick matches the precision on screen: 30 s at day scale (where the
// string ends at minutes) and 1 s inside 24 h (where it grows a seconds
// field). Passing them to only one of the two is the bug they exist to
// prevent, see releaseCountdown.ts::showsSeconds.
// ---------------------------------------------------------------------------

import { formatCountdown, useCountdownNow } from "./releaseCountdown";

const COUNTDOWN_OPTS = { compactDays: true } as const;

export default function EpisodeAirChip({ targetMs }: { targetMs: number }) {
  const now = useCountdownNow(targetMs, COUNTDOWN_OPTS);
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
        {formatCountdown(targetMs, now, COUNTDOWN_OPTS)}
      </span>
    </div>
  );
}
