// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// DetailHud — the detail page's metadata surface.
//
// Replaces the single stacked column that used to run down the left side. That
// column had two problems and they pulled against each other: it grew every
// time a feature added a field, and because it was one flow the only way to
// reach the bottom of it was to scroll the ENTIRE page, artwork and all.
//
// The shape here is a tab bar over one fixed-height glass panel. Consequences
// that are the whole point:
//
//   - THE PAGE NEVER SCROLLS. The panel is height-capped and scrolls its own
//     content, so the artwork, the title and the actions are always on screen
//     and nothing below the fold exists.
//   - ADDING A FIELD COSTS A TAB, NOT HEIGHT. The previous layout got taller
//     with every addition until it stopped fitting.
//   - THE ART IS THE PAGE AGAIN. At rest only the identity block and the tab
//     bar sit over it.
//
// It also absorbs the anime extras that briefly lived behind a separate rail
// and modal. Two routes to secondary content was one too many, and the modal's
// scrim hid the artwork it was describing.
//
// LAYOUT NOTE: the panel lays out in COLUMNS, not rows. A wide short strip is
// the space actually available on a 21:9 display, and columns are what make it
// readable there; the column count steps down at narrower widths rather than
// letting any single column fall under a readable measure.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CharactersTab, RatingsTab, RelatedTab, SongsTab, StaffTab, TrailersTab,
} from "./AnimeExtrasOverlay";
import type { CourRef } from "./animeExtras";
import { loadAuraSettings } from "./auraSettings";

/** Tabs that always exist, plus the anime-only extras. */
export type HudTab =
  | "overview" | "cast"
  | "songs" | "ratings" | "staff" | "related" | "trailers";

interface Props {
  /** Rendered inside the Overview tab: synopsis, genres, per-episode text. */
  overview: React.ReactNode;
  /** Rendered inside the Cast tab. */
  cast: React.ReactNode;
  /** MAL entries, one per cour. Empty for live action, which removes every
   *  extras tab and leaves a two-tab bar. */
  cours: CourRef[];
  onPlayTrailer?: (ytId: string, title: string) => void;
  /** Re-seeds the active tab when the page swaps to a different title, so a
   *  user who was on Trailers does not land on Trailers for the next show. */
  resetKey: string;
}

const BASE_TABS: { id: HudTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "cast",     label: "Cast" },
];
const EXTRA_TABS: { id: HudTab; label: string }[] = [
  { id: "songs",    label: "Songs" },
  { id: "ratings",  label: "Ratings" },
  { id: "staff",    label: "Staff" },
  { id: "related",  label: "Related" },
  { id: "trailers", label: "Trailers" },
];

export default function DetailHud({
  overview, cast, cours, onPlayTrailer, resetKey,
}: Props) {
  const tabs = useMemo(
    () => (cours.length > 0 ? [...BASE_TABS, ...EXTRA_TABS] : BASE_TABS),
    [cours.length],
  );
  const [tab, setTab] = useState<HudTab>("overview");
  const listRef = useRef<HTMLDivElement | null>(null);

  const [blurChars, setBlurChars] = useState(() => loadAuraSettings().blurCharacterArt);
  useEffect(() => {
    const sync = () => setBlurChars(loadAuraSettings().blurCharacterArt);
    window.addEventListener("aura:settings-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("aura:settings-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Back to Overview on a title change. Also covers the case where the new
  // title is live action and the tab we were on no longer exists.
  useEffect(() => { setTab("overview"); }, [resetKey]);
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab("overview");
  }, [tabs, tab]);

  // Roving arrow-key navigation, the expected behaviour for a tablist and the
  // reason the buttons carry an explicit tabIndex.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.id === tab);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    setTab(tabs[next].id);
    const btns = listRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']");
    btns?.[next]?.focus();
  };

  return (
    // WIDTH IS CAPPED, and this is the fix for the panel reading as dead
    // space on an ultrawide. Spanning the full column meant a ~2900px glass
    // bar holding two blocks of text: the measure inside it stayed narrow, the
    // surplus columns came up empty, and the bar cut straight across the
    // artwork's subject. Capping it hands that width back to the art, which is
    // the point of a cinematic layout, and leaves the content at a width it
    // can actually fill. It stays left-aligned with the identity block above
    // so the two read as one column of page furniture.
    <div className="flex flex-col gap-3 min-h-0" style={{ width: "min(100%, 74rem)" }}>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Title information"
        onKeyDown={onKeyDown}
        className="flex items-center gap-1.5 flex-wrap"
      >
        {tabs.map((t) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              aria-controls="aura-hud-panel"
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={
                "aura-hud-tab px-3 h-7 rounded-lg text-[11px] font-medium "
                + "uppercase tracking-[0.14em] transition-colors border "
                + (on
                  ? "text-ln-accent bg-ln-accent/16 border-ln-accent/40"
                  : "text-white/70 border-white/12 hover:text-white")
              }
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* The panel. Height is CAPPED and the overflow is its own, which is the
          mechanism that keeps the page itself unscrollable. `min-h-0` on both
          this and the flex parent is load-bearing: without it a flex child
          refuses to shrink below its content and the cap silently does
          nothing. */}
      <div
        id="aura-hud-panel"
        role="tabpanel"
        className="aura-hud-surface shadow-glass-edge rounded-xl
                   px-6 py-5 overflow-y-auto"
        style={{
          // FIXED, not a max. A panel that resized to its content made every
          // tab switch jump the layout, which is worse than the dead space a
          // fixed box sometimes leaves. Roughly 50% taller than the first cut.
          height: "min(44vh, 31rem)",
          scrollbarWidth: "thin",
          scrollbarColor: "rgba(255,255,255,0.08) transparent",
        }}
      >
        {tab === "overview" && overview}
        {/* Anime get the MAL character grid, which has both the character's
            art and the actor's. Everything else falls back to the addon's own
            cast rows, which carry an actor photo and nothing more. */}
        {tab === "cast"     && (cours.length > 0
          ? <CharactersTab cours={cours} blurNames={blurChars} />
          : cast)}
        {tab === "songs"    && <SongsTab cours={cours} />}
        {tab === "ratings"  && <RatingsTab cours={cours} />}
        {tab === "staff"    && <StaffTab cours={cours} compact />}
        {tab === "related"  && <RelatedTab cours={cours} />}
        {tab === "trailers" && <TrailersTab cours={cours} onPlay={onPlayTrailer} />}
      </div>
    </div>
  );
}
