// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// ArcGrid — the arc list shown by DetailView's episodes panel when the user
// flips the Seasons | Arcs toggle.
//
// Tiles are built from the SAME visual language as the Continue-Watching cards
// (CinemaRows.tsx): a wide landscape banner, artwork under a bottom gradient
// scrim, the title and its metadata OVERLAID on the art (no text box beneath),
// a mono badge pinned top-left, and the CW watched-progress bar pinned to the
// bottom edge. An arc is a "chunk of show you can sit down and watch", so it
// gets a card that reads like one.
//
// TILES PER ROW is derived from how many arcs the active grouping has:
//   • <= ARC_DENSE_THRESHOLD (Sagas, Combos: One Piece has 12 / 14) -> ONE
//     full-width banner per row. There are few of them and each is a big
//     commitment, so they earn the width.
//   • >  ARC_DENSE_THRESHOLD (Story Arcs: One Piece has 55) -> TWO per row,
//     same design shrunk down, so a 55-arc show does not become an endless
//     single column.
// The count comes from the grouping's own `arc_count` (not the loaded arcs),
// so the skeleton shown WHILE a grouping loads already has the right shape.
//
// Watched state is derived from the SAME two sources every other Aura surface
// reads (manual marks, then position-implied progress against the library's
// resume pointer), so an arc's progress bar can never disagree with the ticks
// on the episode rows underneath it.
// ---------------------------------------------------------------------------

import { useMemo } from "react";

import ImageLoader from "./ImageLoader";
import Tooltip from "./Tooltip";
import { episodeIsBeforeResume, useResumeVideoId } from "./LibraryContext";
import { getManualWatchedState, useManualWatchedVersion } from "./manualWatched";
import { shrinkPoster } from "./posterSize";
import {
  arcEpisodeRange, arcYearRange, orderGroupings, showIsMultiSeason,
  type ArcGrouping, type ArcResult, type StoryArc, groupingDisplayName,} from "./storyArcs";
import type { VideoEntry } from "./types";

/** Above this arc count a grouping is "dense" and switches to two tiles per
 *  row. 20 sits comfortably above the coarse groupings (One Piece: 12 sagas,
 *  14 combos; Naruto: 5) and well below the fine-grained ones (One Piece: 55). */
const ARC_DENSE_THRESHOLD = 20;

interface ArcGridProps {
  result: ArcResult;
  seriesId: string;
  /** The addon's real episode list, used to resolve each arc's episode ids into
   *  a displayable episode-number range. */
  videos: VideoEntry[];
  /** A grouping switch is in flight: show the skeleton in the tile shape of the
   *  grouping being loaded, not the stale arcs of the previous one. */
  loading?: boolean;
  /** The grouping the user has ASKED for, which during a switch is not yet the
   *  one `result` holds. Defaults to the loaded result's grouping. */
  activeGroupingId?: string;
  onSelect: (arc: StoryArc) => void;
  onGroupingChange: (groupingId: string) => void;
}

/** Episodes in this arc the user has finished. Mirrors LibraryContext's
 *  precedence: a manual mark always wins, otherwise an episode positioned
 *  before the resume pointer is treated as watched. */
function watchedCount(episodeIds: string[], resumeId: string | null): number {
  let n = 0;
  for (const id of episodeIds) {
    const manual = getManualWatchedState(id);
    if (manual === "watched") {
      n++;
      continue;
    }
    if (manual === "in-progress") continue;
    if (resumeId && id !== resumeId && episodeIsBeforeResume(id, resumeId)) n++;
  }
  return n;
}

/** Geometry for the two tile densities. The wide banner is deliberately NOT
 *  16:9: a full-panel-width 16:9 box would be ~450 px tall and only two arcs
 *  would fit on screen. 32:9 keeps the same landscape feel at a height close to
 *  the half-width 16:9 tile, so the two densities read as the same component. */
function tileGeometry(perRow: 1 | 2): { aspect: string; artWidth: number } {
  return perRow === 1
    ? { aspect: "32 / 9", artWidth: 960 }
    : { aspect: "16 / 9", artWidth: 640 };
}

function ArcCard({
  arc,
  perRow,
  videosById,
  multiSeason,
  resumeId,
  onSelect,
}: {
  arc: StoryArc;
  perRow: 1 | 2;
  videosById: Map<string, VideoEntry>;
  multiSeason: boolean;
  resumeId: string | null;
  onSelect: (arc: StoryArc) => void;
}) {
  const total = arc.episode_ids.length;
  const watched = watchedCount(arc.episode_ids, resumeId);
  const ratio = total > 0 ? watched / total : 0;
  const complete = total > 0 && watched === total;
  const years = arcYearRange(arc);
  const range = arcEpisodeRange(arc, videosById, multiSeason);
  const { aspect, artWidth } = tileGeometry(perRow);

  // Server-resize hint sized to the tile, never a full-size master pulled into
  // a banner (memory discipline: the wide tile is ~2x the half-width one).
  const art = shrinkPoster(arc.image, artWidth);

  return (
    <button
      type="button"
      onClick={() => onSelect(arc)}
      title={arc.name}
      className="group relative block w-full text-left overflow-hidden rounded-xl
                 bg-white/5 border border-white/10 hover:border-ln-accent/40
                 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60"
      style={{ aspectRatio: aspect }}
    >
      {art ? (
        <ImageLoader
          src={art}
          alt=""
          loading="lazy"
          draggable={false}
          className="absolute inset-0 w-full h-full"
          imgClassName="w-full h-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center text-white/20 text-[11px] font-mono uppercase tracking-[0.18em]">
          no art
        </div>
      )}

      {/* Scrim. Taller than the CW card's because this tile carries two lines of
          overlaid text, not one. */}
      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/55 to-transparent" />

      {/* Episode-number range, top-left, in the CW badge's mono style: the arc's
          answer to "which episodes IS this?". */}
      {range && (
        <span
          className="absolute top-2 left-2 px-2 py-1 rounded
                     bg-black/75 backdrop-blur-sm border border-white/15
                     text-white/90 text-[12px] font-mono font-semibold tracking-wider tabular-nums"
        >
          {range}
        </span>
      )}

      {complete ? (
        <span
          className="absolute top-2 right-2 w-6 h-6 rounded-full grid place-items-center
                     bg-emerald-400 text-black text-[13px] font-bold shadow-lg shadow-black/40"
          aria-label="Arc completed"
        >
          &#10003;
        </span>
      ) : watched > 0 ? (
        <span className="absolute top-2 right-2 px-2 py-1 rounded-full bg-black/75 backdrop-blur-sm
                         border border-white/15 text-emerald-300 text-[11px] font-semibold tabular-nums">
          {watched}/{total}
        </span>
      ) : null}

      {/* Overlaid title block. Bottom padding clears the progress bar. */}
      <div className={`absolute inset-x-0 bottom-0 ${perRow === 1 ? "px-4 pb-3.5" : "px-3 pb-3"}`}>
        <div
          className={[
            "font-semibold text-white leading-tight line-clamp-2",
            "drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]",
            perRow === 1 ? "text-[19px]" : "text-[15px]",
          ].join(" ")}
        >
          {arc.name}
        </div>
        <div
          className={[
            "mt-1 flex items-center gap-2 text-white/70 tabular-nums",
            perRow === 1 ? "text-[12px]" : "text-[11px]",
          ].join(" ")}
        >
          <span className="font-medium">
            {total} {total === 1 ? "episode" : "episodes"}
          </span>
          {years && (
            <>
              <span className="text-white/30" aria-hidden>&middot;</span>
              <span className="font-mono">{years}</span>
            </>
          )}
          {complete && (
            <>
              <span className="text-white/30" aria-hidden>&middot;</span>
              <span className="text-emerald-300 font-medium">Completed</span>
            </>
          )}
        </div>
      </div>

      {/* Watched-progress bar, same 5 px inset-from-the-corners bar the CW cards
          use, and the same emerald fill so "watched" means one colour app-wide. */}
      {ratio > 0 && (
        <div className="absolute left-2 right-2 bottom-1 h-[5px] rounded-full overflow-hidden bg-white/15">
          <div
            className="h-full bg-emerald-400"
            style={{ width: `${Math.min(100, ratio * 100)}%` }}
          />
        </div>
      )}
    </button>
  );
}

/** The grouping switcher: a prominent segmented control carrying each
 *  grouping's arc count inline (it used to hide in a tooltip). Only rendered
 *  when a show genuinely has more than one grouping: One Piece can be browsed
 *  as 12 sagas, 55 fine-grained arcs, or a combo cut. */
function GroupingSelect({
  groupings,
  active,
  onChange,
}: {
  groupings: ArcGrouping[];
  active: string;
  onChange: (id: string) => void;
}) {
  // Sagas first, story arcs next, combos last. See orderGroupings.
  const ordered = useMemo(() => orderGroupings(groupings), [groupings]);
  if (ordered.length < 2) return null;

  return (
    <div
      role="group"
      aria-label="Arc grouping"
      // WRAP, and never exceed the container. A show can have three or four
      // groupings with long names ("Story Arcs with Filler"); a single
      // non-wrapping row slipped off both edges of the panel. `flex-wrap` +
      // `max-w-full` keeps every tab on screen, growing to a second line instead.
      className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-black/30 border border-white/10 max-w-full"
    >
      {ordered.map((g) => {
        const on = g.id === active;
        return (
          <Tooltip key={g.id} text={`${g.arc_count} arcs, ${g.episode_count} episodes`}>
            <button
              type="button"
              onClick={() => onChange(g.id)}
              aria-pressed={on}
              className={[
                "flex items-center gap-2 px-3 h-8 rounded-lg text-[12px] font-semibold transition-colors",
                on
                  ? "bg-ln-accent/20 text-ln-accent ring-1 ring-inset ring-ln-accent/40"
                  : "text-white/55 hover:text-white/90 hover:bg-white/6",
              ].join(" ")}
            >
              <span className="truncate max-w-[11rem]">{groupingDisplayName(g.name)}</span>
              <span
                className={[
                  "px-1.5 py-px rounded-full text-[10px] font-mono tabular-nums",
                  on ? "bg-ln-accent/25 text-ln-accent" : "bg-white/10 text-white/50",
                ].join(" ")}
              >
                {g.arc_count}
              </span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Shimmering tiles in the arc grid's own shape. Rendered while arcs resolve:
 *  the TMDB join takes a beat and the panel used to just sit there, so a first
 *  open (or a Sagas -> Story Arc switch) looked like nothing had happened. */
export function ArcGridSkeleton({ perRow = 1, count }: { perRow?: 1 | 2; count?: number }) {
  const { aspect } = tileGeometry(perRow);
  // Enough tiles to fill the panel without dominating it, same intent as the
  // episode-list skeleton's five rows.
  const n = count ?? (perRow === 1 ? 3 : 6);
  return (
    <div
      role="status"
      aria-label="Loading story arcs"
      className={`grid gap-3 ${perRow === 1 ? "grid-cols-1" : "grid-cols-2"}`}
    >
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className="rounded-xl bg-white/8 border border-white/8 animate-pulse"
          style={{ aspectRatio: aspect }}
        />
      ))}
    </div>
  );
}

export default function ArcGrid({
  result, seriesId, videos, loading, activeGroupingId, onSelect, onGroupingChange,
}: ArcGridProps) {
  const resumeId = useResumeVideoId(seriesId);
  // Re-render when a manual mark lands anywhere, so the progress bars stay
  // truthful without each card subscribing individually.
  useManualWatchedVersion();

  const arcs = useMemo(
    () => [...result.arcs].sort((a, b) => a.order - b.order),
    [result.arcs],
  );

  const videosById = useMemo(
    () => new Map(videos.map((v) => [v.id, v])),
    [videos],
  );
  // Decided once for the whole show so every arc's range reads the same way.
  const multiSeason = useMemo(() => showIsMultiSeason(videos), [videos]);

  const active = activeGroupingId ?? result.grouping_id;
  // Tile density follows the grouping the user asked for, so a switch to a
  // 55-arc grouping already skeletons as a 2-up grid.
  const activeCount = result.groupings.find((g) => g.id === active)?.arc_count ?? arcs.length;
  const perRow: 1 | 2 = activeCount > ARC_DENSE_THRESHOLD ? 2 : 1;

  // Fandom art is CC-BY-SA and the licence requires attribution. Only credit it
  // when we actually used it.
  const usesFandomArt = arcs.some((a) => a.image_source === "fandom");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <GroupingSelect
          groupings={result.groupings}
          active={active}
          onChange={onGroupingChange}
        />
        <span className="text-[12px] text-white/40 font-medium tabular-nums">
          {loading
            ? "Loading arcs…"
            : `${arcs.length} ${arcs.length === 1 ? "arc" : "arcs"}`}
        </span>
      </div>

      {loading ? (
        <ArcGridSkeleton perRow={perRow} />
      ) : (
        <div className={`grid gap-3 ${perRow === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
          {arcs.map((arc) => (
            <ArcCard
              key={arc.id}
              arc={arc}
              perRow={perRow}
              videosById={videosById}
              multiSeason={multiSeason}
              resumeId={resumeId}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      <div className="pt-1 text-[10px] text-white/25 leading-relaxed">
        Arc data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
        {usesFandomArt && " Arc artwork from Fandom, licensed CC BY-SA."}
      </div>
    </div>
  );
}
