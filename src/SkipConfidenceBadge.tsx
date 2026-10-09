// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// SkipConfidenceBadge: a skip window's confidence level as a chip.
//
// One look everywhere a level is shown (the skip prompt, the scrubber's hover
// card, the AuraSkip menu and the Settings legend): colour, an icon whose
// SHAPE differs per level (a check, a dot, a warning triangle) and the word,
// so the level reads without relying on colour alone. The levels themselves
// and their wording live in skipWindows.ts (`skipConfidence`) and
// skipSource.ts (`skipConfidenceLabel` / `skipConfidenceMeaning`).
// ---------------------------------------------------------------------------

import type { SkipConfidence } from "./skipWindows";
import { skipConfidenceLabel } from "./skipSource";

/** Text colour per level, for a note line that should carry the level's tone. */
export const SKIP_CONFIDENCE_TEXT: Record<SkipConfidence, string> = {
  verified: "text-emerald-300",
  likely:   "text-amber-300",
  risky:    "text-rose-300",
};

const TONES: Record<SkipConfidence, string> = {
  verified: "bg-emerald-500/15 text-emerald-300 border-emerald-400/35",
  likely:   "bg-amber-500/15 text-amber-300 border-amber-400/35",
  risky:    "bg-rose-500/15 text-rose-300 border-rose-400/40",
};

export function SkipConfidenceIcon({ level, size = 10 }: { level: SkipConfidence; size?: number }) {
  if (level === "verified") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    );
  }
  if (level === "likely") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3" aria-hidden>
        <circle cx="12" cy="12" r="7.5" />
        <path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5L2.5 20h19z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </svg>
  );
}

export default function SkipConfidenceBadge({
  level, size = "sm", help = false,
}: {
  level: SkipConfidence;
  /** "sm" matches the stream-quality chips; "md" sits in the skip prompt. */
  size?: "sm" | "md";
  /** Show the help cursor (the caller wraps it in a Tooltip). */
  help?: boolean;
}) {
  const md = size === "md";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-semibold tracking-wide
                  ${md ? "px-2 py-0.5 text-[12px]" : "px-1.5 py-[1px] text-[10.5px]"}
                  ${TONES[level]} ${help ? "cursor-help" : ""}`}
    >
      <SkipConfidenceIcon level={level} size={md ? 12 : 10} />
      {skipConfidenceLabel(level)}
    </span>
  );
}
