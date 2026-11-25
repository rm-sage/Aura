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
// ONE full-width banner per row, for every grouping (see TILE_ASPECT for why
// the two-up density was dropped).
//
// Watched state is derived from the SAME two sources every other Aura surface
// reads (manual marks, then position-implied progress against the library's
// resume pointer), so an arc's progress bar can never disagree with the ticks
// on the episode rows underneath it.
// ---------------------------------------------------------------------------

import { useLayoutEffect, useMemo, useRef } from "react";

import ImageLoader from "./ImageLoader";
import Tooltip from "./Tooltip";
import { episodeIsBeforeResume, useLibraryMap, useResumeVideoId } from "./LibraryContext";
import { getManualWatchedState, useManualWatchedVersion } from "./manualWatched";
import { isEpisodeWatched } from "./episodeSpoilers";
import { arcScrollAnchor } from "./seasonScroll";
import { isSkipped } from "./skipMarks";
import { shrinkPoster } from "./posterSize";
import {
  arcEpisodeRange, arcYearRange, orderGroupings, absoluteEpisodeMap,
  arcKindSummary, showHasKindData,
  type ArcGrouping, type ArcKindSummary, type ArcResult, type StoryArc,
  groupingDisplayName,} from "./storyArcs";
import type { VideoEntry } from "./types";


interface ArcGridProps {
  result: ArcResult;
  seriesId: string;
  /** The addon's real episode list, used to resolve each arc's episode ids into
   *  a displayable episode-number range, and to work out how much of each arc
   *  is filler. */
  videos: VideoEntry[];
  /** `cloudSignal?.episode_kinds`, the highest-priority filler / recap source
   *  and the ONLY source for many episodes. Passing an empty array degrades to
   *  the VideoEntry flags alone, exactly as `mergedKindFlags` does. */
  cloudKinds?: { id: string; kind: string }[];
  /** A grouping switch is in flight: show the skeleton in the tile shape of the
   *  grouping being loaded, not the stale arcs of the previous one. */
  loading?: boolean;
  /** The grouping the user has ASKED for, which during a switch is not yet the
   *  one `result` holds. Defaults to the loaded result's grouping. */
  activeGroupingId?: string;
  onSelect: (arc: StoryArc) => void;
  onGroupingChange: (groupingId: string) => void;
  /** Right-click on an arc tile. Given the arc so the caller can mark every
   *  episode in it; the caller owns the menu because it owns the series
   *  identity and the scrobble connection. */
  onArcContextMenu?: (arc: StoryArc, x: number, y: number) => void;
  /** The manga chapters an arc adapts, already formatted ("Ch. 1,058-1,125"),
   *  or null. From mangaChapters.ts; absent for shows with no chapter data. */
  chapterLabelFor?: (arc: StoryArc) => string | null;
  /** The player drawer's playing episode: the grid lands on its arc, ahead of
   *  the latest watched one. */
  pinnedEpisodeId?: string | null;
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

/** Tile geometry: one full-width banner per row, for every grouping. The
 *  banner is deliberately NOT 16:9: a full-panel-width 16:9 box would be
 *  ~450 px tall and only two arcs would fit on screen.
 *
 *  There used to be a second, two-up 16:9 density for groupings of more than
 *  20 arcs (One Piece's 55). At half width its meta line had about 200px, so
 *  once manga chapters joined the episode count and years, the filler count
 *  was pushed off the tile (Bleach, 21 arcs, sat just over the line). One
 *  density costs a longer scroll on the fine groupings and keeps every tile's
 *  facts readable. */
const TILE_ASPECT = "32 / 9";
const TILE_ART_WIDTH = 960;

function ArcCard({
  arc,
  absoluteById,
  resumeId,
  kind,
  chapters,
  onSelect,
  onArcContextMenu,
}: {
  arc: StoryArc;
  /** "Ch. 1,058-1,125", or null. */
  chapters: string | null;
  absoluteById: Map<string, number>;
  resumeId: string | null;
  /** Aura's own reading of this arc's composition. Replaces the filler marker
   *  TMDB bakes into the arc NAME, which is wrong in both directions on
   *  Bleach. See the block comment in storyArcs.ts. */
  kind: ArcKindSummary;
  onSelect: (arc: StoryArc) => void;
  onArcContextMenu?: (arc: StoryArc, x: number, y: number) => void;
}) {
  const total = arc.episode_ids.length;
  const watched = watchedCount(arc.episode_ids, resumeId);
  const ratio = total > 0 ? watched / total : 0;
  const complete = total > 0 && watched === total;
  const years = arcYearRange(arc);
  const range = arcEpisodeRange(arc, absoluteById);

  // Server-resize hint sized to the tile, never a full-size master pulled into
  // a banner (memory discipline: the wide tile is ~2x the half-width one).
  const art = shrinkPoster(arc.image, TILE_ART_WIDTH);

  return (
    <button
      type="button"
      data-arc-id={arc.id}
      onClick={() => onSelect(arc)}
      onContextMenu={onArcContextMenu ? (e) => {
        e.preventDefault();
        e.stopPropagation();
        onArcContextMenu(arc, e.clientX, e.clientY);
      } : undefined}
      title={
        kind.known && kind.filler > 0
          ? `${kind.name} · ${kind.filler} of ${kind.total} filler`
          : kind.name
      }
      // The card bezel (a rim-only cursor-light surface, last child) is the
      // edge, not a border: no accent border on hover (round 11).
      className="group relative block w-full text-left overflow-hidden rounded-xl
                 bg-white/5 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-white/60"
      style={{ aspectRatio: TILE_ASPECT }}
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
        // Deliberately EMPTY. The placeholder used to read "no art", centred
        // in the tile, which on the old two-up tile was where the title started:
        // the words rendered through the arc name as an unreadable smudge, and
        // there is no collision-free band left on a 16/9 tile once the badges
        // own the top and the title owns the bottom. The button's own tinted
        // background plus the scrim already read as "card with no image", and
        // the title is right there saying which arc it is.
        <div className="absolute inset-0" aria-hidden />
      )}

      {/* Scrim. Taller than the CW card's because this tile carries two lines of
          overlaid text, not one. */}
      <div className="absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-black/90 via-black/55 to-transparent" />

      {/* Episode-number range, top-left, in the CW badge's mono style: the arc's
          answer to "which episodes IS this?". */}
      {/* Frost look, FAUX in the grid (glass-detail.css `.aura-arc-grid`): one
          per card in a scroller, and in the player there is no backdrop. */}
      {range && (
        <span
          data-glass-light="rim"
          className="aura-frost absolute top-2 left-2 px-2 py-1 rounded-[7px]
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
        <span data-glass-light="rim"
              className="aura-frost absolute top-2 right-2 px-2 py-1 rounded-full
                         text-emerald-300 text-[11px] font-semibold tabular-nums">
          {watched}/{total}
        </span>
      ) : null}

      {/* Overlaid title block. Bottom padding clears the progress bar. */}
      <div className={`absolute inset-x-0 bottom-0 px-4 pb-3.5`}>
        <div
          className={[
            "font-semibold text-white leading-tight",
            "drop-shadow-[0_2px_4px_rgba(0,0,0,0.85)]",
            // Two lines need about 70px of block, and the corner badges end at
            // 34px, so a short tile cannot fit both: in a narrow window the
            // title's first line would sit ON the badges. One line below 1080px.
            "line-clamp-2 max-[1080px]:line-clamp-1",
            "text-[19px]",
          ].join(" ")}
        >
          {kind.name}
        </div>
        {/* Meta line, built so it can NEVER become two.

            It lives in an absolute bottom-anchored block, so a second line
            grows UPWARD into the title and the corner badges, which is what
            made this look broken once a filler count was added.

            `flex` was not the guard it looked like: `flex-wrap: nowrap` is
            already the CSS default, so the ROW never wrapped. Each span is a
            flex item with `flex-shrink: 1`, and a text span's min-content width
            is its longest WORD, so the spans collapsed to word width and
            wrapped their own text internally ("20" over "episodes"). The real
            guards are `whitespace-nowrap` so no item may break inside itself,
            `shrink-0` so the fixed facts hold full size, and only the optional
            trailing items (the manga chapters and the filler count) allowed
            to give, which truncate rather than pushing.

            "Completed" is gone. It was triplicated: the emerald check pinned
            top-right (which carries the accessible name, so nothing is lost to
            a screen reader) and the progress bar sitting at 100% right below
            both already say it, and it was the widest optional item here. */}
        <div
          className={[
            "mt-1 flex items-center gap-2 overflow-hidden whitespace-nowrap leading-tight",
            "text-white/70 tabular-nums",
            "text-[12px]",
          ].join(" ")}
        >
          <span className="shrink-0 font-medium">
            {total}{" "}
            {total === 1 ? "episode" : "episodes"}
          </span>
          {years && (
            <>
              <span className="shrink-0 text-white/30" aria-hidden>&middot;</span>
              <span className="shrink-0 font-mono">{years}</span>
            </>
          )}
          {/* Manga chapters. Quiet, and allowed to truncate like the filler
              count: the arc name plus the episode count already say which
              arc this is. */}
          {chapters && (
            <>
              <span className="shrink-0 text-white/30" aria-hidden>&middot;</span>
              <span className="min-w-0 truncate font-mono text-white/55" title="Manga chapters this arc adapts">
                {chapters}
              </span>
            </>
          )}
          {kind.known && kind.filler > 0 && (
            <>
              <span className="shrink-0 text-white/30" aria-hidden>&middot;</span>
              {/* Rose is the filler colour everywhere else in Aura (the
                  episode-row pill, the count chip's breakdown), so an arc reads
                  the same way as the episodes inside it. A PARTIAL arc says how
                  MANY rather than flattening to "Filler", because Bleach's
                  Gotei 13 Invading Army is filler except for its last episode
                  and a flat label cannot express that.

                  No denominator: the line already opens with this arc's episode
                  count, so "12 filler" reads the same in half the pixels, and it
                  matches what the opened arc's count chip renders. The flat word
                  is gated on every episode having RESOLVED as well as being
                  filler, or an arc where only a few ids mapped would claim to be
                  filler outright.

                  One of the two items allowed to truncate (the chapter range
                  is the other): the rose still carries the meaning when it
                  clips. */}
              <span className="min-w-0 truncate text-rose-300 font-medium">
                {kind.filler === kind.total && kind.resolved === kind.total
                  ? "Filler"
                  : `${kind.filler} filler`}
              </span>
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
      <span aria-hidden data-glass-light="rim" className="aura-card-bezel" />
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
      // `justify-center` so a wrapped last line (e.g. a lone "Season, Arc & Saga
      // Combos") sits centred rather than stranded left with dead space beside it.
      // The established selectable chip (`.aura-glass-flat.aura-filter-chip`,
      // aria-pressed), not a hand-rolled segmented wrap: a wrapping group
      // cannot be a SegmentedControl (round 11).
      className="flex flex-wrap items-center justify-center gap-1.5 max-w-full"
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
                "aura-glass-flat aura-filter-chip flex items-center gap-2 px-3 h-8 rounded-[10px] text-[12px] font-semibold",
                on ? "" : "text-white/55 hover:text-white/90",
              ].join(" ")}
            >
              <span className="truncate max-w-[11rem]">{groupingDisplayName(g.name)}</span>
              <span
                className={[
                  "px-1.5 py-px rounded-full text-[10px] font-mono tabular-nums",
                  on ? "bg-white/10" : "bg-white/10 text-white/60",
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
export function ArcGridSkeleton({ count }: { count?: number }) {
  // Enough tiles to fill the panel without dominating it, same intent as the
  // episode-list skeleton's five rows.
  const n = count ?? 3;
  return (
    <div
      role="status"
      aria-label="Loading story arcs"
      className="grid gap-3 grid-cols-1"
    >
      {Array.from({ length: n }, (_, i) => (
        <div
          key={i}
          className="rounded-xl bg-white/8 animate-pulse"
          style={{ aspectRatio: TILE_ASPECT }}
        />
      ))}
    </div>
  );
}

export default function ArcGrid({
  result, seriesId, videos, cloudKinds, loading, activeGroupingId, onSelect, onGroupingChange,
  onArcContextMenu, chapterLabelFor, pinnedEpisodeId,
}: ArcGridProps) {
  const resumeId = useResumeVideoId(seriesId);
  // Re-render when a manual mark lands anywhere, so the progress bars stay
  // truthful without each card subscribing individually.
  useManualWatchedVersion();

  const arcs = useMemo(
    () => [...result.arcs].sort((a, b) => a.order - b.order),
    [result.arcs],
  );

  // Absolute episode numbers, computed once, so every arc range reads as a plain
  // unambiguous E20-E67 no matter how the addon seasons the show.
  const absoluteById = useMemo(() => absoluteEpisodeMap(videos), [videos]);

  // One pass over the show, reused by every tile. `known` is computed at SHOW
  // level on purpose: a fully-canon arc inside a show that does have data
  // carries no flags at all, and testing per-arc would read that as "no data"
  // and fall back to the very TMDB label this replaces.
  const kindByArc = useMemo(() => {
    const kinds = cloudKinds ?? [];
    const byId = new Map(videos.map((v) => [v.id, v]));
    const known = showHasKindData(videos, kinds);
    return new Map(
      result.arcs.map((a) => [a.id, arcKindSummary(a, byId, kinds, known)]),
    );
  }, [result.arcs, videos, cloudKinds]);

  const active = activeGroupingId ?? result.grouping_id;

  // Fandom art is CC-BY-SA and the licence requires attribution. Only credit it
  // when we actually used it.
  const usesFandomArt = arcs.some((a) => a.image_source === "fandom");

  // Land on the arc holding the latest watched episode, once each time tiles appear: the
  // grid opening (a new scroller on the Detail page, the drawer's shared one with
  // whatever offset its rows left) or tiles replacing the skeleton, which has already
  // clamped the offset away, whichever grouping they are. The scroller is always the
  // parent, in both panels. scrollTop rather than scrollIntoView, which would also
  // scroll the page's clipped ancestors.
  const rootRef = useRef<HTMLDivElement>(null);
  const libraryById = useLibraryMap();
  const landedGroupingRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (loading) { landedGroupingRef.current = null; return; }
    if (landedGroupingRef.current === result.grouping_id) return;
    landedGroupingRef.current = result.grouping_id;
    const root = rootRef.current;
    const scroller = root?.parentElement;
    if (!root || !scroller) return;
    const broadcast = videos
      .filter((v) => absoluteById.has(v.id))
      .sort((a, b) => absoluteById.get(a.id)! - absoluteById.get(b.id)!);
    // A skipped episode is stored as a watched mark, but it is not where the
    // user got to: "Skip the filler" at E110 marks every filler through E220.
    const pinnedArc = pinnedEpisodeId ? arcs.find((a) => a.episode_ids.includes(pinnedEpisodeId))?.id : undefined;
    const arcId = pinnedArc
      ?? arcScrollAnchor(arcs, broadcast, (id) => isEpisodeWatched(libraryById, id) && !isSkipped(id));
    const tile = arcId
      ? root.querySelector<HTMLElement>(`[data-arc-id="${CSS.escape(arcId)}"]`)
      : null;
    // From the rects: the same offset the old offsetTop difference gave, and
    // still right when the scroller is the tile's offsetParent (the player
    // drawer's list is `relative` for its hover droplet). Rects include
    // ancestor transforms (the detail page opens under a scale), so the delta
    // is scaled back by offsetHeight / rect height.
    const sr = scroller.getBoundingClientRect();
    const k = sr.height > 0 ? scroller.offsetHeight / sr.height : 1;
    scroller.scrollTop = tile
      ? (tile.getBoundingClientRect().top - sr.top) * k + scroller.scrollTop
      : 0;
  }, [loading, result.grouping_id, arcs, videos, absoluteById, libraryById]);

  return (
    <div ref={rootRef} className="aura-arc-grid flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <GroupingSelect
          groupings={result.groupings}
          active={active}
          onChange={onGroupingChange}
        />
        {/* ml-auto, not justify-between alone: GroupingSelect renders null
            when a show has only one grouping, and a lone child in a
            `justify-between` row sits at flex-START, so the count jumped to the
            left edge on exactly the commonest case. */}
        <span className="ml-auto text-[12px] text-white/60 font-medium tabular-nums">
          {loading
            ? "Loading arcs…"
            : `${arcs.length} ${arcs.length === 1 ? "arc" : "arcs"}`}
        </span>
      </div>

      {loading ? (
        <ArcGridSkeleton />
      ) : (
        <div className="grid gap-3 grid-cols-1">
          {arcs.map((arc) => (
            <ArcCard
              key={arc.id}
              arc={arc}
              absoluteById={absoluteById}
              kind={
                kindByArc.get(arc.id) ?? {
                  name: arc.name,
                  filler: 0,
                  total: arc.episode_ids.length,
                  resolved: arc.episode_ids.length,
                  known: false,
                }
              }
              resumeId={resumeId}
              chapters={chapterLabelFor ? chapterLabelFor(arc) : null}
              onSelect={onSelect}
              onArcContextMenu={onArcContextMenu}
            />
          ))}
        </div>
      )}

      <div className="pt-1 text-[10px] text-white/50 leading-relaxed">
        Arc data from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.
        {usesFandomArt && " Arc artwork from Fandom, licensed CC BY-SA."}
      </div>
    </div>
  );
}
