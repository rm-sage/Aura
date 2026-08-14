// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PersonGrid: the Cast tab's tile grid for everything that is not anime.
//
// Anime get CharactersTab, whose tiles have two faces (the character's art and
// the voice actor's). Live action has one face per person, so this is the same
// grid with the swap removed.
//
// It exists because the thing it replaces cannot work where it now lives. The
// old shape was a text row plus an absolutely-positioned hover card, and the
// HUD panel that row sits in is `overflow-y: auto`. A scroll container clips
// out-of-flow descendants on BOTH axes (the other axis computes from `visible`
// to `auto`), and content overflowing the top edge of a scroller cannot even be
// scrolled to, so the card was not merely cut off, it was unreachable. The
// panel's fixed height is the whole reason the detail page never scrolls, so
// relaxing that overflow was not an option, and the left column clips again one
// level up anyway.
//
// The card was also mostly redundant: it re-rendered the same name and role
// already printed in the row 8px below it, which is why the visible remnant was
// a black box containing a duplicate of the line under it. The only things it
// added were the photo and the tier, and both belong on a tile.
// ---------------------------------------------------------------------------

import ImageLoader from "./ImageLoader";
import { shrinkPoster } from "./posterSize";

/** Matches CHARACTER_ART_W in AnimeExtrasOverlay. The tiles are the same size,
 *  so they should pull the same byte budget through the resize proxy rather
 *  than dragging full-size masters into a 2:3 thumbnail. */
const PERSON_ART_W = 300;

export interface PersonEntry {
  name: string;
  character: string | null;
  photo: string | null;
  /** TMDB series only. Drives the corner tier badge; absent on movies, on
   *  non-TMDB series, and whenever the cast-spoiler setting is on. */
  episode_count?: number;
  total_show_episodes?: number;
}

/** Placeholder for a person with no photo. Initials read as "we know who this
 *  is, there is just no picture", where an empty box reads as a failure. */
function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2)
    .map((w) => w[0] ?? "").join("").toUpperCase();
}

export default function PersonGrid({ entries, onClickName, badgeFor }: {
  entries: PersonEntry[];
  onClickName?: (name: string) => void;
  /** Optional corner badge. Return null for no badge on that entry. */
  badgeFor?: (e: PersonEntry) => string | null;
}) {
  if (entries.length === 0) return null;
  return (
    // Same breakpoints and gaps as the anime character grid, so switching
    // between an anime and a live-action title does not reflow the tab.
    <div className="grid gap-x-4 gap-y-5
                    grid-cols-3 min-[900px]:grid-cols-5
                    min-[1200px]:grid-cols-7 min-[1500px]:grid-cols-8">
      {entries.map((e, i) => {
        const badge = badgeFor?.(e) ?? null;
        return (
          // The BUTTON wraps only the art, and the two text lines are its
          // SIBLINGS, exactly as CharacterCard does it. A <p> inside a <button>
          // is an invalid content model (a button takes phrasing content only),
          // and browsers recover from it by closing the button early, which
          // silently breaks the click target it was supposed to define.
          <div key={`${e.name}-${i}`} className="min-w-0 group">
            <button
              type="button"
              onClick={onClickName ? () => onClickName(e.name) : undefined}
              title={onClickName ? `Search for "${e.name}"` : undefined}
              className={"block w-full aspect-[2/3] rounded-lg overflow-hidden "
                + "bg-white/6 border border-white/8 relative p-0 "
                + "focus:outline-none focus-visible:ring-1 focus-visible:ring-white/40 "
                + "group-hover:ring-1 group-hover:ring-white/25 transition-shadow "
                + (onClickName ? "cursor-pointer" : "cursor-default")}
            >
              {e.photo ? (
                <ImageLoader
                  src={shrinkPoster(e.photo, PERSON_ART_W)}
                  alt=""
                  className="absolute inset-0 w-full h-full"
                  imgClassName="w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <span className="absolute inset-0 flex items-center justify-center
                                 text-white/25 text-[20px] font-mono tracking-[0.08em]">
                  {initials(e.name)}
                </span>
              )}
              {badge && (
                <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded
                                 bg-black/70 text-white/85 text-[9px] font-mono
                                 uppercase tracking-[0.14em]">
                  {badge}
                </span>
              )}
            </button>

            {/* Both lines are fixed, mirroring the character card: the person
                leads, the role sits under them. Nothing swaps on hover,
                because there is no second image to swap to. */}
            <p className="text-white/85 text-[11.5px] leading-tight mt-1.5 line-clamp-2">
              {e.name}
            </p>
            {e.character && (
              <p className="text-white/35 text-[10.5px] leading-tight mt-0.5 truncate">
                {e.character}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
