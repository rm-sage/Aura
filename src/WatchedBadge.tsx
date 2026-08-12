// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import {
  getManualWatchedState, onManualWatchedChange, type ManualWatchedState,
} from "./manualWatched";
import { isSkipped, useSkipMarksVersion } from "./skipMarks";
import { useLibraryProgress } from "./LibraryContext";

// ---------------------------------------------------------------------------
// WatchedBadge — small status dot rendered on top-LEFT of catalog cards
// and episode tiles. Designed to NOT collide with:
//   • the top-right quality / episode badges (4K, HDR, S01E05, …)
//   • the bottom rating tiles or progress bars
//
// State precedence (most-specific first):
//   1. Manual mark "watched"      → green check
//   2. Library progress ≥ 90 %    → green check (movies + episode rows only —
//                                     see series caveat below)
//   3. Manual mark "in-progress"  → yellow dot
//   4. Library progress > 0       → yellow dot (auto-in-progress)
//   5. otherwise                  → no badge
//
// SERIES CAVEAT: Stremio's library record for a series stores the LAST
// played episode's state.timeOffset / state.duration — NOT a series-
// level "you've finished N of M episodes" signal. So `progress.watched`
// going true for a series only means "the user finished the most recent
// episode" — they likely have many unwatched episodes ahead. Auto-
// watching the WHOLE series off that signal mis-classifies in-progress
// shows (e.g., Frieren after E11) as fully watched. For series / anime
// we therefore demote the auto-watched signal to "in-progress" — the
// user can still manually mark watched when they actually finish.
//
// Manual marks beat auto-derived states so a user override always wins.
// ---------------------------------------------------------------------------

/** "skipped" is NOT a ManualWatchedState. It is the watched state plus the
 *  skip annotation (see skipMarks.ts), resolved into a distinct variant here
 *  purely so the badge can label it. Everything upstream still sees watched. */
type Variant = "watched" | "skipped" | "in-progress" | "planned" | null;

/** Inline visual badge. Caller decides where to position it (typically
 *  `absolute top-1.5 left-1.5` on the poster wrapper). Returns null
 *  when neither manual nor derived state warrants a badge.
 *
 *  Pass `mediaType` so the badge can apply the series-watched demotion
 *  rule (see header comment). When omitted the badge defaults to
 *  movie-style auto-derivation, which is fine for episode rows and
 *  catalog tiles whose meta type is unknown. */
export default function WatchedBadge({
  metaId,
  mediaType,
  className,
}: {
  metaId: string;
  mediaType?: string;
  className?: string;
}) {
  const variant = useWatchedVariant(metaId, mediaType);
  if (!variant) return null;
  return <WatchedBadgeStatic variant={variant} className={className} />;
}

/** Stateless variant — caller passes the variant in directly. Used by
 *  CW row title-suffix indicator (which doesn't have its own meta id
 *  context but does know the per-card variant from the LibraryItem). */
export function WatchedBadgeStatic({
  variant,
  className,
}: {
  variant: NonNullable<Variant>;
  className?: string;
}) {
  if (variant === "watched") {
    return (
      <span
        aria-label="Watched"
        title="Watched"
        className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full
                    bg-emerald-500/85 backdrop-blur-md text-white
                    border border-emerald-200/30 shadow-[0_2px_8px_rgba(0,0,0,0.45)]
                    ${className ?? ""}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      </span>
    );
  }
  if (variant === "skipped") {
    // Purple, and a distinct glyph rather than a recoloured check: the three
    // marks must read apart without relying on colour alone, which is also
    // what the watched/planned pair already does.
    return (
      <span
        aria-label="Skipped"
        title="Skipped"
        className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full
                    bg-purple-500/85 backdrop-blur-md text-white
                    border border-purple-200/30 shadow-[0_2px_8px_rgba(0,0,0,0.45)]
                    ${className ?? ""}`}
      >
        {/* Fast-forward glyph: "moved past this" rather than "completed it". */}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
        </svg>
      </span>
    );
  }
  if (variant === "planned") {
    // Bookmark glyph in Aura's signature blue. Distinct shape from
    // the watched check + in-progress dot so the three states read
    // at a glance without colour-only differentiation.
    return (
      <span
        aria-label="Planned"
        title="Planned"
        className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full
                    bg-ln-accent/85 backdrop-blur-md text-white
                    border border-blue-200/30 shadow-[0_2px_8px_rgba(0,0,0,0.45)]
                    ${className ?? ""}`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z" />
        </svg>
      </span>
    );
  }
  // in-progress. Explicit rather than a trailing fallthrough: this used to be
  // the unguarded default, so ANY unhandled variant rendered an amber
  // "In progress" dot with no error and no log.
  if (variant !== "in-progress") return null;
  return (
    <span
      aria-label="In progress"
      title="In progress"
      className={`inline-flex items-center justify-center w-[14px] h-[14px] rounded-full
                  bg-amber-400/85 border border-amber-200/40
                  shadow-[0_2px_8px_rgba(0,0,0,0.45)]
                  ${className ?? ""}`}
    />
  );
}

/** Resolve the variant for `metaId` — combines manual marks with
 *  library-derived progress. Subscribes to manualWatched changes so
 *  the badge flips immediately on right-click toggle.
 *
 *  Pass `mediaType` to apply the series-watched demotion: when the
 *  type is "series" / "anime", an auto-derived "watched" state is
 *  reduced to "in-progress" because the underlying library state is
 *  per-LAST-EPISODE, not series-level (see header note). Manual marks
 *  always win, so the user can still flag a series as fully watched
 *  via the right-click menu. */
export function useWatchedVariant(metaId: string, mediaType?: string): Variant {
  const progress = useLibraryProgress(metaId);
  const [manual, setManual] = useState<ManualWatchedState | null>(
    () => getManualWatchedState(metaId),
  );
  useEffect(() => {
    const sync = () => setManual(getManualWatchedState(metaId));
    sync();
    return onManualWatchedChange(sync);
  }, [metaId]);
  // Separate subscription: the skip annotation lives in its own store, so a
  // skip toggle fires its own event and must be observed independently.
  const skipVersion = useSkipMarksVersion();
  const skipped = useMemo(
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => isSkipped(metaId), [metaId, skipVersion],
  );

  // Manual marks always win. Skipped is checked FIRST because it is watched
  // plus an annotation, so testing watched first would always shadow it.
  if (manual === "watched") return skipped ? "skipped" : "watched";
  if (manual === "planned") return "planned";
  if (manual === "in-progress") return "in-progress";

  const isSeriesLike =
    mediaType === "series" || mediaType === "anime";

  // Auto-derived. For series we demote the >=90 % signal to "in-
  // progress" — see header. progress.watched = true on a series just
  // means the LAST episode is done; we have no idea about the others.
  if (progress?.watched) {
    return isSeriesLike ? "in-progress" : "watched";
  }
  if (progress?.partial) return "in-progress";
  return null;
}
