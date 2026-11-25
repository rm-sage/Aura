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
//   3. Manual mark "in-progress"  → amber half-filled ring
//   4. Library progress > 0       → amber half-filled ring (auto-in-progress)
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
 *  `absolute top-2 left-2` on the poster wrapper). Returns null
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
  material,
}: {
  metaId: string;
  mediaType?: string;
  className?: string;
  /** "frost": the Home cards' real-frost mark (round 9). Default: solid. */
  material?: "solid" | "frost";
}) {
  const variant = useWatchedVariant(metaId, mediaType);
  if (!variant) return null;
  return <WatchedBadgeStatic variant={variant} className={className} material={material} />;
}

const VARIANT_LABEL: Record<NonNullable<Variant>, string> = {
  watched: "Watched",
  skipped: "Skipped",
  planned: "Planned",
  "in-progress": "In progress",
};

/** Where each glyph's ink box (stroke included) sits off the 24-unit grid's
 *  centre: the check 0.2 / 0.3 units low-right, the fast-forward 0.75 right.
 *  The viewBox moves by it so every glyph's ink box is centred in its disc. */
const GLYPH_OFFSET: Record<NonNullable<Variant>, readonly [number, number]> = {
  watched: [0.2, 0.3], skipped: [0.75, 0], planned: [0, 0], "in-progress": [0, 0],
};

/** `box`: the svg's CSS size; `glyph`: the size the 24-unit glyph is drawn at
 *  inside it. The box is 14 px in both discs so the inset is a whole multiple
 *  of 4 CSS px (frost (26 - 2 - 14) / 2 + 1 = 6, solid 4) and comes out whole
 *  in device px at every Windows scale (2026-11-25; the user: the marks are
 *  "off center by a few pixels"). An inset of 4.5 (frost, 15 px box) or 3.5
 *  (solid, 13 px) was rounded to a whole pixel: every glyph sat a pixel right
 *  and down at 100% (gaps 9 / 8 / 8 / 7 on the bookmark). Measured at the real
 *  display scale (not Playwright's deviceScaleFactor, which rounds in CSS px):
 *  centred within 0.4 device px at 100%, 150% and 200%, 0.62 at 125% and 175%
 *  (was up to 1.4; the rest is the 26 px disc's own half-pixel width there).
 *  Scratchpad wf/marks. */
function markViewBox(variant: NonNullable<Variant>, box: number, glyph: number): string {
  const span = (24 * box) / glyph;
  const o = (24 - span) / 2;
  const [dx, dy] = GLYPH_OFFSET[variant];
  const r = (n: number) => +n.toFixed(3);
  return `${r(o + dx)} ${r(o + dy)} ${r(span)} ${r(span)}`;
}

/** The state glyph, one set for both materials so every state draws at the
 *  SAME size (round 12: the in-progress mark was a bare 8 px dot in a 22 px
 *  disc on the art and a 14 px disc beside the CW title, while the other
 *  three were glyphs in 22 px discs). In progress is a half-filled ring: a
 *  glyph of the check's size that still reads "partly done" by shape, so the
 *  four states read apart without colour. */
function MarkGlyph({ variant, box, glyph }: { variant: NonNullable<Variant>; box: number; glyph: number }) {
  const viewBox = markViewBox(variant, box, glyph);
  if (variant === "in-progress") {
    return (
      <svg width={box} height={box} viewBox={viewBox} aria-hidden>
        <circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="2.6" />
        <path d="M12 3.8A8.2 8.2 0 0 1 12 20.2Z" fill="currentColor" />
      </svg>
    );
  }
  // A hairline stroke in the fill colour thickens the thin check and the
  // bookmark's edges by about half a pixel, so they hold up on bright art.
  return (
    <svg width={box} height={box} viewBox={viewBox} fill="currentColor"
         stroke="currentColor" strokeWidth={1} strokeLinejoin="round" aria-hidden>
      <path d={
        variant === "watched" ? "M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"
          // Fast-forward glyph: "moved past this" rather than "completed it".
          : variant === "skipped" ? "M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"
            // Bookmark: planned (the Queue).
            : "M17 3H7c-1.1 0-2 .9-2 2v16l7-3 7 3V5c0-1.1-.9-2-2-2z"
      } />
    </svg>
  );
}

/** The frost mark on the art (round 9, the A direction's `.wb`; round 12
 *  size): a 26 px frost disc (glass-cards.css `.aura-frost.aura-watch-mark`, a
 *  rim-only light surface) holding the state's 15 px glyph in its colour, the
 *  disc washed with that colour so the mark keeps the mass the old solid disc
 *  had. Same glyphs and labels as the solid badge. Callers place it 8 px in
 *  (`top-2 left-2`) on every poster and card. */
function FrostMark({ variant, className }: { variant: NonNullable<Variant>; className?: string }) {
  const label = VARIANT_LABEL[variant];
  return (
    <span
      aria-label={label}
      title={label}
      data-glass-light="rim"
      className={`aura-frost aura-watch-mark is-${variant} inline-flex items-center justify-center
                  w-[26px] h-[26px] rounded-full ${className ?? ""}`}
    >
      <MarkGlyph variant={variant} box={14} glyph={15} />
    </span>
  );
}

/** Stateless variant — caller passes the variant in directly. Used by
 *  CW row title-suffix indicator (which doesn't have its own meta id
 *  context but does know the per-card variant from the LibraryItem). */
export function WatchedBadgeStatic({
  variant,
  className,
  material,
}: {
  variant: NonNullable<Variant>;
  className?: string;
  material?: "solid" | "frost";
}) {
  // Explicit lookup rather than a trailing fallthrough: the in-progress dot
  // used to be the unguarded default, so ANY unhandled variant rendered an
  // amber "In progress" mark with no error and no log.
  const fill = SOLID_FILL[variant];
  if (!fill) return null;
  if (material === "frost") return <FrostMark variant={variant} className={className} />;
  // The solid disc (episode rows, the CW title suffix): every state one 22 px
  // disc with a 13 px glyph (round 12; in progress was a 14 px bare dot). The
  // glyphs read apart by shape, never by colour alone.
  const label = VARIANT_LABEL[variant];
  return (
    <span
      aria-label={label}
      title={label}
      className={`inline-flex items-center justify-center w-[22px] h-[22px] rounded-full
                  ${fill} shadow-[0_2px_8px_rgba(0,0,0,0.45)] ${className ?? ""}`}
    >
      <MarkGlyph variant={variant} box={14} glyph={13} />
    </span>
  );
}

/** The solid disc per state. Planned's glyph is in the accent INK (a custom
 *  accent can be light: white on it vanished); in progress puts a dark glyph
 *  on amber, which white does not clear. */
const SOLID_FILL: Record<NonNullable<Variant>, string> = {
  watched: "bg-emerald-500/85 text-white border border-emerald-200/30",
  skipped: "bg-purple-500/85 text-white border border-purple-200/30",
  planned: "bg-ln-accent/85 text-ln-accent-ink border border-white/25",
  "in-progress": "bg-amber-400/90 text-[rgb(28_20_4)] border border-amber-200/40",
};

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
