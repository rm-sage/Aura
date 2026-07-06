// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// FillerRecapTags — the rose "filler" / amber "recap" pills shown on episode
// thumbnails (episode list + next-up cards). Two INDEPENDENT flags: an episode
// can be BOTH filler AND recap (release-search-spec §6.3), so both can render,
// stacked. Purely presentational — the caller computes the two booleans (from
// a VideoEntry's is_filler / is_recap / episode_kind, and/or the Aura Cloud
// release signal) and positions the group via `className`.
//   Filler = rose (skip-worthy), recap = amber (informational).
// ---------------------------------------------------------------------------

interface Props {
  filler: boolean;
  recap: boolean;
  /** Positioning / layout for the pill group (e.g. absolute placement over a
   *  thumbnail). The group itself is a right-aligned vertical stack. */
  className?: string;
}

export default function FillerRecapTags({ filler, recap, className }: Props) {
  if (!filler && !recap) return null;
  return (
    <div className={`flex flex-col gap-1 items-end ${className ?? ""}`}>
      {filler && (
        <span
          className="px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-[0.14em] uppercase
                     border bg-rose-500/85 text-white border-rose-300/30
                     shadow-[0_2px_6px_rgba(244,63,94,0.4)]"
        >
          filler
        </span>
      )}
      {recap && (
        <span
          className="px-1.5 py-0.5 rounded text-[9px] font-semibold tracking-[0.14em] uppercase
                     border bg-amber-400/85 text-amber-950 border-amber-200/40
                     shadow-[0_2px_6px_rgba(251,191,36,0.4)]"
        >
          recap
        </span>
      )}
    </div>
  );
}
