// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// ArcGrid — the arc-card list shown by DetailView's episodes panel when the
// user flips the Seasons | Arcs toggle.
//
// One card per story arc, in air order: key art (Fandom when we have it, an
// episode still otherwise), the arc name, its episode count, the year range
// its episodes aired in, and a watched-progress bar. Clicking a card hands the
// arc back to the panel, which then renders only that arc's episodes.
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
import { arcYearRange, type ArcGrouping, type ArcResult, type StoryArc } from "./storyArcs";

interface ArcGridProps {
  result: ArcResult;
  seriesId: string;
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

function ArcCard({
  arc,
  resumeId,
  onSelect,
}: {
  arc: StoryArc;
  resumeId: string | null;
  onSelect: (arc: StoryArc) => void;
}) {
  const total = arc.episode_ids.length;
  const watched = watchedCount(arc.episode_ids, resumeId);
  const ratio = total > 0 ? watched / total : 0;
  const complete = total > 0 && watched === total;
  const years = arcYearRange(arc);

  // 640 is the same width hint the Continue-Watching landscape art uses: a
  // 16:9 card at this size on a 2x display, not a full-size master pulled into
  // a small tile.
  const art = shrinkPoster(arc.image, 640);

  return (
    <button
      type="button"
      onClick={() => onSelect(arc)}
      className="group text-left rounded-xl overflow-hidden bg-white/4 border border-white/8 hover:border-ln-accent/40 hover:bg-white/6 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60"
    >
      <div className="relative aspect-video bg-black/40">
        {art ? (
          <ImageLoader
            src={art}
            alt=""
            loading="lazy"
            imgClassName="w-full h-full object-cover"
            className="w-full h-full"
          />
        ) : (
          <div className="w-full h-full grid place-items-center text-white/25 text-[11px] font-mono uppercase tracking-[0.18em]">
            no art
          </div>
        )}

        {complete && (
          <div className="absolute top-1.5 right-1.5 rounded-full bg-ln-accent/90 text-black w-5 h-5 grid place-items-center text-[11px] font-bold">
            {/* A finished arc reads at a glance, same as a watched episode. */}
            &#10003;
          </div>
        )}

        {/* Progress sits on the art, not below it, so the card height is
            identical whether or not the user has started the arc. */}
        {ratio > 0 && !complete && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/60">
            <div
              className="h-full bg-ln-accent"
              style={{ width: `${Math.round(ratio * 100)}%` }}
            />
          </div>
        )}
      </div>

      <div className="p-2.5">
        <div className="text-[13px] font-medium text-white/90 line-clamp-2 group-hover:text-white">
          {arc.name}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-white/45">
          <span>
            {total} {total === 1 ? "episode" : "episodes"}
          </span>
          {years && (
            <>
              <span className="text-white/20">&middot;</span>
              <span>{years}</span>
            </>
          )}
          {watched > 0 && !complete && (
            <>
              <span className="text-white/20">&middot;</span>
              <span className="text-ln-accent/80">{watched} watched</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

/** The grouping switcher. Only rendered when a show genuinely has more than one
 *  arc grouping: One Piece can be browsed as 55 fine-grained arcs or 12 broad
 *  sagas, and Naruto as 24 arcs-with-filler or 5 manga-canon-only arcs. */
function GroupingSelect({
  groupings,
  active,
  onChange,
}: {
  groupings: ArcGrouping[];
  active: string;
  onChange: (id: string) => void;
}) {
  if (groupings.length < 2) return null;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {groupings.map((g) => (
        <Tooltip key={g.id} text={`${g.arc_count} arcs, ${g.episode_count} episodes`}>
          <button
            type="button"
            onClick={() => onChange(g.id)}
            className={[
              "px-2.5 h-6 rounded-full text-[11px] font-medium transition-colors",
              g.id === active
                ? "bg-ln-accent/20 text-ln-accent"
                : "text-white/45 hover:text-white/80 hover:bg-white/6",
            ].join(" ")}
          >
            {g.name}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export default function ArcGrid({ result, seriesId, onSelect, onGroupingChange }: ArcGridProps) {
  const resumeId = useResumeVideoId(seriesId);
  // Re-render when a manual mark lands anywhere, so the progress bars stay
  // truthful without each card subscribing individually.
  useManualWatchedVersion();

  const arcs = useMemo(
    () => [...result.arcs].sort((a, b) => a.order - b.order),
    [result.arcs],
  );

  // Fandom art is CC-BY-SA and the licence requires attribution. Only credit it
  // when we actually used it.
  const usesFandomArt = arcs.some((a) => a.image_source === "fandom");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <GroupingSelect
          groupings={result.groupings}
          active={result.grouping_id}
          onChange={onGroupingChange}
        />
        <span className="text-[11px] text-white/35">
          {arcs.length} {arcs.length === 1 ? "arc" : "arcs"}
        </span>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {arcs.map((arc) => (
          <ArcCard key={arc.id} arc={arc} resumeId={resumeId} onSelect={onSelect} />
        ))}
      </div>

      <div className="pt-1 text-[10px] text-white/25 leading-relaxed">
        Arc data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
        {usesFandomArt && " Arc artwork from Fandom, licensed CC BY-SA."}
      </div>
    </div>
  );
}
