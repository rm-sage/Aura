// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// ReleaseBasisTag: how sure a movie's release date is, as a small chip beside
// its countdown (the detail page meta strip and the catalog hover panel).
//
// Same look as SkipConfidenceBadge: colour, an icon whose SHAPE differs per
// basis and the word, so it reads without relying on colour alone.
//   - Confirmed: emerald + a check (a TMDB per-country date).
//   - Reported:  neutral + a half-filled dot (MDBList or the addon's date).
//   - Estimate:  amber, DASHED border + an "about" glyph (the +45-day guess).
// The words and the hover text come from `describeReleaseBasis`
// (movieRelease.ts); the caller puts the hover on the whole countdown.
// ---------------------------------------------------------------------------

import { RELEASE_BASIS_TAG, type ReleaseBasis } from "./movieRelease";
import type { EarlyTagTone } from "./movieEarly";

const TONES: Record<ReleaseBasis, string> = {
  confirmed: "bg-emerald-500/15 text-emerald-300 border-emerald-400/35",
  reported:  "bg-white/8 text-white/70 border-white/20",
  estimated: "bg-amber-500/10 text-amber-200/90 border-dashed border-amber-400/45",
};

function BasisIcon({ basis, size }: { basis: ReleaseBasis; size: number }) {
  if (basis === "confirmed") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    );
  }
  if (basis === "reported") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3" aria-hidden>
        <circle cx="12" cy="12" r="7.5" />
        <path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  // "About": two stacked waves (the approximately-equal sign).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.8" strokeLinecap="round" aria-hidden>
      <path d="M4 9.5c2.5-2.5 5.5-2.5 8 0s5.5 2.5 8 0" />
      <path d="M4 16c2.5-2.5 5.5-2.5 8 0s5.5 2.5 8 0" />
    </svg>
  );
}

export default function ReleaseBasisTag({ basis, size = "sm" }: {
  basis: ReleaseBasis;
  /** "sm" sits in the hover panel; "md" in the detail page meta strip. */
  size?: "sm" | "md";
}) {
  const md = size === "md";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-semibold tracking-wide normal-case
                  ${md ? "px-1.5 py-[1px] text-[11px]" : "px-1.5 py-[1px] text-[10px]"}
                  ${TONES[basis]}`}
    >
      <BasisIcon basis={basis} size={md ? 10 : 9} />
      {RELEASE_BASIS_TAG[basis]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// EarlyReleaseTag: the chip for a film's early-release check (movieEarly.ts),
// beside the Digital countdown. Same chip shape as the basis tag.
//   - verified:   emerald + a check ("Verified": AIOStreams verified the leak)
//   - unverified: amber, dashed + a question mark (home copies, unverified)
//   - note:       neutral, no icon ("Theater copies", "Unlabeled copies")
//   - checking:   neutral + a spinning ring, while the detail page's stream
//                 fetch is still out
// ---------------------------------------------------------------------------

const EARLY_TONES: Record<EarlyTagTone, string> = {
  verified:   "bg-emerald-500/15 text-emerald-300 border-emerald-400/35",
  unverified: "bg-amber-500/10 text-amber-200/90 border-dashed border-amber-400/45",
  note:       "bg-white/8 text-white/70 border-white/20",
  checking:   "bg-white/8 text-white/60 border-white/15",
};

function EarlyIcon({ tone, size }: { tone: EarlyTagTone; size: number }) {
  if (tone === "verified") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    );
  }
  if (tone === "unverified") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M8.5 9a3.5 3.5 0 1 1 5 3.2c-1 .5-1.5 1.2-1.5 2.3" />
        <path d="M12 19h.01" />
      </svg>
    );
  }
  if (tone === "checking") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="3" strokeLinecap="round" className="animate-spin" aria-hidden>
        <path d="M12 3a9 9 0 1 1-9 9" />
      </svg>
    );
  }
  return null;
}

export function EarlyReleaseTag({ tone, label, size = "sm" }: {
  tone: EarlyTagTone;
  label: string;
  size?: "sm" | "md";
}) {
  const md = size === "md";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border font-semibold tracking-wide normal-case
                  ${md ? "px-1.5 py-[1px] text-[11px]" : "px-1.5 py-[1px] text-[10px]"}
                  ${EARLY_TONES[tone]}`}
    >
      <EarlyIcon tone={tone} size={md ? 10 : 9} />
      {label}
    </span>
  );
}
