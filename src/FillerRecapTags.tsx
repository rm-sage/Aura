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
  /** Pill scale, chosen to suit the thumbnail underneath.
   *
   *  These sit on stills ranging from the in-player drawer's 120px to the
   *  end-of-stream Spotlight's 300px, and one fixed size cannot serve both: at
   *  9px the pill dominates the small thumbnail and nearly disappears on the
   *  large one. "sm" is the default and covers the 120px to 160px cluster;
   *  "lg" is for the Spotlight. */
  size?: "sm" | "lg";
}

const PILL: Record<"sm" | "lg", string> = {
  sm: "px-1.5 py-0.5 rounded text-[9px] tracking-[0.14em]",
  lg: "px-2 py-1 rounded-md text-[11px] tracking-[0.16em]",
};

export default function FillerRecapTags({ filler, recap, className, size = "sm" }: Props) {
  if (!filler && !recap) return null;
  const pill = PILL[size];
  return (
    // The group is deliberately a SIBLING of the thumbnail image rather than a
    // child of it, so the anti-spoiler blur (applied to the img itself, not to
    // this container) never touches the tags. Knowing an episode is filler is
    // not a spoiler, and it is the single most useful thing to know when the
    // still is hidden.
    <div className={`flex flex-col ${size === "lg" ? "gap-1.5" : "gap-1"} items-end ${className ?? ""}`}>
      {filler && (
        <span
          className={`${pill} font-semibold uppercase
                     border bg-rose-500/85 text-white border-rose-300/30
                     shadow-[0_2px_6px_rgba(244,63,94,0.4)]`}
        >
          filler
        </span>
      )}
      {recap && (
        <span
          className={`${pill} font-semibold uppercase
                     border bg-amber-400/85 text-amber-950 border-amber-200/40
                     shadow-[0_2px_6px_rgba(251,191,36,0.4)]`}
        >
          recap
        </span>
      )}
    </div>
  );
}
