// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ImageLoader from "./ImageLoader";
import { shrinkPoster } from "./posterSize";
import type { BackdropCandidate } from "./heroBackdrop";

// ---------------------------------------------------------------------------
// HeroBackdropPicker - the panel behind the detail hero's "Change backdrop…"
// menu item. An "Automatic" tile, then one 16:9 tile per backdrop Aura already
// holds for the title (see collectBackdropCandidates). A click applies the
// choice at once and the panel stays open, so backdrops can be compared on the
// hero itself; Escape, an outside click, a scroll elsewhere or the close
// button dismiss it.
//
// PORTALLED TO document.body. ContextMenuHost renders its menu INLINE at
// z-[200] inside .aura-app-shell, which is its own stacking context, so a
// panel left in that context would paint over any menu raised while it is
// open. The dismiss guard exempts the menu by selector for the same reason
// (see DownloadsPanelHost).
//
// Thumbnails go through the on-device resize proxy at a SMALL width and mount
// lazily, so opening the picker never decodes a dozen full-size masters to
// draw tiles about 140 px wide.
// ---------------------------------------------------------------------------

/** Resize-proxy width for a tile: ~140 CSS px at up to 2.5x DPI. */
const THUMB_W = 384;
/** Tiles per row. Fixed, so the arrow keys can step a whole row. */
const COLS = 3;
/** Gap kept between the panel and the viewport edge. */
const EDGE = 16;
/** The custom title bar the panel must not cover. */
const TITLE_BAR_H = 36;

interface Tile {
  /** What the tile shows. Null only for an Automatic that resolves to no art. */
  url: string | null;
  label: string;
  /** What a click stores: null is Automatic. */
  value: string | null;
}

interface Props {
  /** Where the hero was right-clicked. The panel opens there, clamped. */
  x: number;
  y: number;
  /** What Automatic resolves to right now (the hero's art with no override). */
  automatic: string | null;
  /** The candidate label Automatic currently matches, e.g. the addon's name. */
  automaticSource: string | null;
  candidates: BackdropCandidate[];
  /** The stored choice, or null for Automatic. */
  current: string | null;
  onPick: (url: string | null) => void;
  onClose: () => void;
  /** Focus goes back here on close when it was inside the panel. */
  returnFocus: HTMLElement | null;
}

export default function HeroBackdropPicker({
  x, y, automatic, automaticSource, candidates, current, onPick, onClose, returnFocus,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState({ left: x, top: y });

  const tiles: Tile[] = [
    { url: automatic, label: "Automatic", value: null },
    ...candidates.map((c) => ({ url: c.url, label: c.label, value: c.url })),
  ];
  const selectedIdx = current == null
    ? 0
    : Math.max(0, tiles.findIndex((t) => t.value === current));
  // Roving tabindex: one tile is in the tab order, the arrows move it.
  const [focusIdx, setFocusIdx] = useState(selectedIdx);

  // Focus a tile and scroll ONLY the tile grid to it. A plain focus() may
  // scroll any ancestor, and on the first frame the panel can still sit at the
  // unclamped click point, partly off screen, which would drag the page.
  const focusTile = (i: number) => {
    const tile = tileRefs.current[i];
    const grid = gridRef.current;
    if (!tile) return;
    tile.focus({ preventScroll: true });
    if (!grid) return;
    const g = grid.getBoundingClientRect();
    const r = tile.getBoundingClientRect();
    if (r.bottom > g.bottom) grid.scrollTop += r.bottom - g.bottom;
    else if (r.top < g.top) grid.scrollTop -= g.top - r.top;
  };

  // Open at the click, pulled back inside the viewport (and below the title
  // bar). Measured before paint, like the context menu, so it never flashes at
  // the unclamped spot. Re-run on resize rather than closing: a resize says
  // nothing about whether the user is done choosing.
  useLayoutEffect(() => {
    const place = () => {
      const el = panelRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(EDGE, Math.min(x, vw - r.width - EDGE));
      const top = Math.max(TITLE_BAR_H + 8, Math.min(y, vh - r.height - EDGE));
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [x, y]);

  // Focus the current choice on open. On close, hand focus back to the page
  // when it was in here, rather than leaving it on a node that is about to be
  // removed. A layout cleanup, because it runs while the panel is still in the
  // document and `contains` can still answer.
  useLayoutEffect(() => {
    focusTile(selectedIdx);
    const panel = panelRef.current;
    return () => {
      const active = document.activeElement as HTMLElement | null;
      if (!panel || !active || !panel.contains(active)) return;
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      else active.blur();
    };
    // Mount-only: the selection moving while open must not steal focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const inside = (t: EventTarget | null) =>
      t instanceof Node && !!panelRef.current?.contains(t);
    const onMouseDown = (e: MouseEvent) => {
      if (inside(e.target)) return;
      // A menu raised while the panel is open is not a DOM descendant of it.
      if (e.target instanceof Element && e.target.closest("[data-aura-context-menu]")) return;
      onClose();
    };
    // Scrolling somewhere else means the user has moved on. Scrolling the
    // tile grid itself is how a long list is browsed, so that is exempt.
    const onWheel = (e: WheelEvent) => {
      if (!inside(e.target)) onClose();
    };
    // Capture phase, and stopped there: App's window-level Escape handler
    // would otherwise close the whole detail page along with the panel.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onClose]);

  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const last = tiles.length - 1;
    let next = focusIdx;
    if (e.key === "ArrowRight") next = Math.min(last, focusIdx + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, focusIdx - 1);
    else if (e.key === "ArrowDown") next = focusIdx + COLS <= last ? focusIdx + COLS : focusIdx;
    else if (e.key === "ArrowUp") next = focusIdx - COLS >= 0 ? focusIdx - COLS : focusIdx;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    setFocusIdx(next);
    focusTile(next);
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Choose a backdrop"
      // aura-float-glass carries the background, border and shadow.
      // Arbitrary sizes on purpose: tailwind.config.ts replaces the maxWidth
      // scale, so a named max-w token would emit nothing.
      className="aura-float-glass fixed z-[10045] flex flex-col w-[480px] max-w-[calc(100vw-32px)]
                 max-h-[min(540px,calc(100vh-60px))] rounded-2xl overflow-hidden select-none"
      style={{ left: pos.left, top: pos.top, animation: "fade-in 140ms ease-out" }}
    >
      <header className="flex items-center gap-2 pl-4 pr-2.5 pt-3 pb-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-[13px] font-semibold text-white/85">Backdrop</h2>
          <p className="text-[11px] text-white/45 truncate">
            Remembered for this title on this device.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="w-7 h-7 rounded-md flex items-center justify-center text-white/50
                     hover:text-white hover:bg-white/10 transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div
        ref={gridRef}
        role="group"
        aria-label="Backdrops"
        onKeyDown={onGridKeyDown}
        className="grid grid-cols-3 gap-1 px-2.5 pb-3 overflow-y-auto min-h-0"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.12) transparent" }}
      >
        {tiles.map((t, i) => {
          const selected = i === selectedIdx;
          return (
            <button
              key={t.value ?? "automatic"}
              ref={(el) => { tileRefs.current[i] = el; }}
              type="button"
              aria-pressed={selected}
              tabIndex={i === focusIdx ? 0 : -1}
              onFocus={() => setFocusIdx(i)}
              onClick={() => onPick(t.value)}
              className="group min-w-0 p-1.5 rounded-lg text-left outline-none transition-colors
                         hover:bg-white/6 focus-visible:bg-white/8"
            >
              <span
                className={`relative block aspect-video rounded-md overflow-hidden bg-white/6 transition-shadow
                            ${selected
                              ? "ring-2 ring-ln-accent"
                              : "ring-1 ring-white/10 group-hover:ring-white/25 group-focus-visible:ring-white/60"}`}
              >
                {t.url ? (
                  <ImageLoader
                    src={shrinkPoster(t.url, THUMB_W)}
                    alt=""
                    draggable={false}
                    className="absolute inset-0 w-full h-full"
                    imgClassName="w-full h-full object-cover"
                  />
                ) : (
                  <span className="absolute inset-0 flex items-center justify-center text-[11px] text-white/35">
                    No artwork
                  </span>
                )}
                {selected && (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 w-[18px] h-[18px] rounded-full bg-ln-accent text-black
                               flex items-center justify-center shadow-[0_1px_4px_rgba(0,0,0,0.6)]"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                    </svg>
                  </span>
                )}
              </span>
              <span className="mt-1.5 px-0.5 flex items-baseline gap-1.5 min-w-0">
                {/* "Automatic" never gives way to its source name; the source
                    truncates instead. */}
                <span
                  className={`${i === 0 ? "shrink-0" : "truncate"} text-[11.5px]
                              ${selected ? "text-ln-accent" : "text-white/75"}`}
                >
                  {t.label}
                </span>
                {i === 0 && automaticSource && (
                  <span className="truncate text-[10.5px] text-white/40">{automaticSource}</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
