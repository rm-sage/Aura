// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useCallback, memo } from "react";
import type { MetaPreview } from "./types";
import ImageLoader from "./ImageLoader";

// ---------------------------------------------------------------------------
// HeroCarousel
//
// Full-width backdrop banner with deep soft-focus blur, centered glass overlay
// for title / year / synopsis, hover-triggered nav arrows, and dot pagination.
//
// Image priority (per AIOMetadata convention):
//   1. background — Stremio canonical landscape art
//   2. fanart     — alternate landscape (often higher quality)
//   3. backdrop   — secondary landscape
//   4. poster     — portrait fallback, blurred at 20px so the hero never
//                   collapses to a black slab
//
// Performance notes:
//   • Wrapped in React.memo so a stable `items` array doesn't re-render the
//     hero when an unrelated parent state changes.
//   • Uses gpu-layer + cv-auto-hero for compositor isolation.
//
// Auto-advances every 8 seconds; pauses while the cursor is over the hero.
// ---------------------------------------------------------------------------

interface Props {
  items: MetaPreview[];
  /** Click on the active hero card → open the detail view. */
  onSelect?: (meta: MetaPreview) => void;
  /** Catalog the hero items were pulled from (e.g. "Trending Movies").
   *  Renders as a subtle top-left chip — readable at sofa distance
   *  without competing with the title or backdrop art. Omitted /
   *  empty → no chip. */
  sourceLabel?: string;
}

/** Pick the best landscape art and report whether we landed on the
    portrait-poster fallback path (so the renderer can apply heavy blur). */
function pickHeroArt(item: MetaPreview): { src: string | null; isPortraitFallback: boolean } {
  if (item.background) return { src: item.background, isPortraitFallback: false };
  if (item.fanart)     return { src: item.fanart,     isPortraitFallback: false };
  if (item.backdrop)   return { src: item.backdrop,   isPortraitFallback: false };
  if (item.poster)     return { src: item.poster,     isPortraitFallback: true  };
  return { src: null, isPortraitFallback: false };
}

/** Treat a backdrop as low-res (and trigger the dual-layer fallback) below
 *  this natural-width threshold. Picked to match the most common addon
 *  thumb size; real fanart is usually 1280+. */
const LOW_RES_THRESHOLD = 900;

/** Time spent on each hero item before auto-advancing. Long enough that
 *  the user has space to read the synopsis without it sliding away
 *  mid-sentence. */
const AUTO_ADVANCE_MS = 22000;
/** Cross-fade duration between adjacent hero items. The slower the
 *  transition, the softer the swap; ~2.4 s reads as a deliberate
 *  cinematic dissolve rather than a snap. */
const FADE_DURATION_MS = 2400;

/**
 * Shared sizing for the hero AND the search bar that sits above it. The
 * hero is intentionally a bit wider than the source backdrop's 16:9 so
 * ultrawide viewports don't end up with a postage-stamp-sized card —
 * the difference is filled by a heavily blurred copy of the same image
 * so the actual landscape art is never cropped, just letterboxed into
 * a softer ambient frame.
 *
 *   • aspect-ratio 21:9 reads as proper cinematic widescreen.
 *   • The pixel ceilings come from CSS custom properties driven by a
 *     media query in App.css — defaults target ultrawide (60vh / 760px),
 *     the < 2400 px viewport variant scales it down (50vh / 600px) so
 *     1080p / standard-aspect monitors don't get a hero that dominates
 *     the page. Ultrawide stays exactly as it was.
 *   • Both vars exported so HomeView can pin the search bar above the
 *     hero to the same width — the user reads the two as a single
 *     anchored panel.
 */
export const HERO_MAX_HEIGHT = "var(--hero-max-h)";
export const HERO_MAX_WIDTH  = "var(--hero-max-w)";

const ChevronLeft = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
  </svg>
);
const ChevronRight = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
  </svg>
);

function HeroCarouselInner({ items, onSelect, sourceLabel }: Props) {
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  /** Indices where we've detected a dual-layer fallback (low-res or portrait-only). */
  const [dualLayer, setDualLayer] = useState<Set<number>>(new Set());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reportDualLayer = useCallback((i: number) => {
    setDualLayer((prev) => {
      if (prev.has(i)) return prev;
      const next = new Set(prev);
      next.add(i);
      return next;
    });
  }, []);

  // Clamp index when items list shrinks
  useEffect(() => {
    if (index >= items.length) setIndex(0);
  }, [items.length, index]);

  // Auto-advance
  useEffect(() => {
    if (items.length <= 1 || hovered) return;
    timer.current = setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, AUTO_ADVANCE_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [items.length, hovered]);

  const goTo = useCallback((i: number) => {
    if (items.length === 0) return;
    setIndex(((i % items.length) + items.length) % items.length);
  }, [items.length]);

  const next = useCallback(() => goTo(index + 1), [index, goTo]);
  const prev = useCallback(() => goTo(index - 1), [index, goTo]);

  if (items.length === 0) return null;

  const current = items[index];

  return (
    <div
      className="relative mx-auto w-full overflow-hidden group gpu-layer cv-auto-hero cursor-pointer"
      style={{
        // 21:9 box (cinematic). The blurred ambient-fill layers were
        // removed (user feedback: didn't look great) — landscape art
        // is now object-cover and crops slightly to fill the wider box,
        // which is the lesser visual evil.
        aspectRatio: "21 / 9",
        maxHeight: HERO_MAX_HEIGHT,
        maxWidth: HERO_MAX_WIDTH,
        // Soft alpha-fade edges. Toned down compared to the first
        // pass — the previous 12 % top / 4 % side fades were eating
        // into the lower-left description block (long synopses turned
        // into a half-faded block on the bottom edge). Now: a 6 % top
        // bleed for the search-bar handoff, ~5 % bottom into the page
        // background, ~2 % side nibbles. Header / description / arrows
        // all sit comfortably in the fully-opaque region.
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent 0%, black 6%, black 95%, transparent 100%), " +
          "linear-gradient(to right, transparent 0%, black 2%, black 98%, transparent 100%)",
        maskImage:
          "linear-gradient(to bottom, transparent 0%, black 6%, black 95%, transparent 100%), " +
          "linear-gradient(to right, transparent 0%, black 2%, black 98%, transparent 100%)",
        WebkitMaskComposite: "source-in" as React.CSSProperties["WebkitMaskComposite"],
        // Standards property — newer Chromium / Safari support `intersect`.
        maskComposite: "intersect",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Whole-art click → detail page. The text-block click below also
      // fires onSelect; this just lets users hit the artwork directly
      // (a more discoverable affordance than aiming at the title).
      onClick={() => onSelect?.(current)}
      onContextMenu={(e) => {
        // Same dispatch protocol every other card uses. App.tsx's
        // listener builds the menu from the meta + click coords.
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("aura:card-context", {
          detail: { meta: current, x: e.clientX, y: e.clientY },
        }));
      }}
      data-meta-card={`${current.media_type}:${current.id}`}
      role={onSelect ? "button" : undefined}
    >
      {/* Backdrop layers — render every item so cross-fade works.
          Priority: background → fanart → backdrop → poster (heavy blur).
          Each item also reports its natural width on load so we can detect
          low-resolution backdrops and lay a sharp poster on top. */}
      {items.map((item, i) => (
        <HeroBackdrop
          key={item.id}
          item={item}
          active={i === index}
          onDualLayer={() => reportDualLayer(i)}
        />
      ))}

      {/* Catalog-source chip — small pill at the top-left identifying
          which catalog produced these hero items. Subtle styling so
          it doesn't compete with the title / synopsis treatment below;
          uppercase mono spacing keeps it feeling like a label rather
          than a primary headline. Hidden when no source is available. */}
      {sourceLabel && (
        <div className="absolute top-3 left-4 z-10 pointer-events-none">
          <span className="px-2.5 py-1 rounded-md
                           bg-black/40 backdrop-blur-md
                           border border-white/10
                           text-white/65 text-[10.5px] font-mono uppercase
                           tracking-[0.18em]
                           shadow-[0_2px_8px_rgba(0,0,0,0.45)]">
            {sourceLabel}
          </span>
        </div>
      )}

      {/* Hero text overlay — bare typography anchored bottom-LEFT of
          the hero box. No glass card; the shadow does the legibility
          heavy-lifting. Restricted to a left-anchored column so long
          synopses don't sprawl across the whole hero, and pulled tight
          to the bottom-left corner with `justify-start` + `items-end`
          so the block feels intentionally placed rather than centred. */}
      <div className="absolute inset-0 flex items-end justify-start pointer-events-none">
        <div
          key={current.id /* re-mount → fade in */}
          className={`pb-4 transition-[padding] duration-500
                      ${dualLayer.has(index) ? "pl-[420px] pr-10" : "pl-5 pr-10"}`}
          style={{
            animation: "theme-fade-in 600ms ease-out",
            // Fixed comfortable reading column. 1100px holds three
            // lines of typical Stremio description text without
            // wrapping or truncation, while still reading as a
            // bounded column instead of full-width on ultrawide.
            maxWidth: "min(1100px, 65%)",
          }}
        >
          <div
            className="pointer-events-auto inline-block cursor-pointer
                       transition-transform duration-200 hover:translate-x-0.5"
            onClick={(e) => {
              e.stopPropagation();
              onSelect?.(current);
            }}
            role={onSelect ? "button" : undefined}
            tabIndex={onSelect ? 0 : undefined}
          >
            {current.logo ? (
              <div className="flex items-end gap-4 mb-3 flex-wrap">
                <img
                  src={current.logo}
                  alt={current.name}
                  draggable={false}
                  className="max-h-24 object-contain object-left"
                  style={{
                    maxWidth: "min(440px, 100%)",
                    filter:
                      "drop-shadow(0 4px 14px rgba(0,0,0,0.85)) drop-shadow(0 0 22px rgba(0,0,0,0.4))",
                  }}
                />
                {current.release_info && (
                  <span
                    className="text-white/85 text-sm font-mono pb-1 tracking-wider"
                    style={{ textShadow: "0 2px 8px rgba(0,0,0,0.95)" }}
                  >
                    {current.release_info}
                  </span>
                )}
              </div>
            ) : (
              <div className="flex items-baseline gap-3 flex-wrap mb-3">
                <h2
                  className="text-white text-4xl font-light tracking-tight leading-[1.05]"
                  style={{
                    textShadow:
                      "0 2px 14px rgba(0,0,0,0.95), 0 0 28px rgba(0,0,0,0.55), 0 1px 2px rgba(0,0,0,0.8)",
                  }}
                >
                  {current.name}
                </h2>
                {current.release_info && (
                  <span
                    className="text-white/85 text-sm font-mono tracking-wider"
                    style={{ textShadow: "0 2px 8px rgba(0,0,0,0.95)" }}
                  >
                    {current.release_info}
                  </span>
                )}
              </div>
            )}
            {current.description && (
              <p
                className="text-white/95 text-[14.5px] leading-relaxed line-clamp-3"
                style={{ textShadow: "0 2px 8px rgba(0,0,0,0.95), 0 0 18px rgba(0,0,0,0.5)" }}
              >
                {current.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Hover-only arrows. Clicks must stopPropagation so the wrapper's
          onClick (which routes to detail view) doesn't intercept them. */}
      {items.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); prev(); }}
            aria-label="Previous"
            className="absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full
                       glass-panel-elevated flex items-center justify-center
                       text-white/80 hover:text-white
                       opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          >
            <ChevronLeft />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); next(); }}
            aria-label="Next"
            className="absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full
                       glass-panel-elevated flex items-center justify-center
                       text-white/80 hover:text-white
                       opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          >
            <ChevronRight />
          </button>

          {/* Dot pagination */}
          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
            {items.map((it, i) => (
              <button
                key={it.id}
                onClick={(e) => { e.stopPropagation(); goTo(i); }}
                aria-label={`Go to slide ${i + 1}`}
                className={`h-1.5 rounded-full transition-all duration-300
                            ${i === index
                              ? "w-6 bg-white/90"
                              : "w-1.5 bg-white/35 hover:bg-white/60"
                            }`}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const HeroCarousel = memo(HeroCarouselInner);
export default HeroCarousel;

// ---------------------------------------------------------------------------
// HeroBackdrop — single item layer. Detects low-resolution landscape art
// (natural width below LOW_RES_THRESHOLD) and switches to the dual-layer
// composition: heavily blurred + scaled background filling the ultrawide,
// sharp poster card overlay anchored on the left.
// ---------------------------------------------------------------------------

function HeroBackdrop({
  item, active, onDualLayer,
}: {
  item: MetaPreview;
  active: boolean;
  onDualLayer: () => void;
}) {
  const { src, isPortraitFallback } = pickHeroArt(item);
  const [lowRes, setLowRes] = useState(false);

  // Reset measurement when src changes
  useEffect(() => { setLowRes(false); }, [src]);

  // If we already know we're falling back to a portrait poster, signal up
  // immediately so the parent slides the title card before the image arrives.
  useEffect(() => {
    if (isPortraitFallback) onDualLayer();
  }, [isPortraitFallback, onDualLayer]);

  // When the heuristic detection escalates to lowRes after onLoad, signal up
  useEffect(() => {
    if (lowRes) onDualLayer();
  }, [lowRes, onDualLayer]);

  const usePortraitInset = isPortraitFallback || lowRes;

  return (
    <div
      className="absolute inset-0 ease-in-out"
      style={{
        opacity: active ? 1 : 0,
        transition: `opacity ${FADE_DURATION_MS}ms ease-in-out`,
      }}
    >
      {src ? (
        usePortraitInset ? (
          // Portrait / low-res fallback: heavy blurred backdrop with a
          // sharp poster card overlaid (handled below). Kept from the
          // previous implementation since portrait sources have nothing
          // landscape to crop into.
          <ImageLoader
            src={src}
            alt=""
            decoding="async"
            loading="lazy"
            draggable={false}
            onLoad={(img) => {
              if (
                !isPortraitFallback &&
                img.naturalWidth > 0 &&
                img.naturalWidth < LOW_RES_THRESHOLD
              ) {
                setLowRes(true);
              }
            }}
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
            imgStyle={{
              objectPosition: "center top",
              filter: "blur(22px) saturate(1.25)",
              transform: "scale(1.14)",
            }}
          />
        ) : (
          // Landscape source: plain object-cover. The 21:9 box crops a
          // little vertically off a 16:9 source, but the user prefers
          // that to the blurred ambient-fill copies that previously
          // flanked an object-contain inset.
          <ImageLoader
            src={src}
            alt={item.name}
            decoding="async"
            loading="lazy"
            draggable={false}
            onLoad={(img) => {
              if (img.naturalWidth > 0 && img.naturalWidth < LOW_RES_THRESHOLD) {
                setLowRes(true);
              }
            }}
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
            imgStyle={{ objectPosition: "center center" }}
          />
        )
      ) : (
        <div className="w-full h-full bg-black" />
      )}

      {/* Sharp poster overlay — left-center anchor, leaves the bottom-right
          quadrant clear for the title card. Only used for the portrait /
          low-res fallback path; hidden on narrow viewports. */}
      {usePortraitInset && item.poster && (
        <div
          className="absolute left-10 top-1/2 -translate-y-1/2 hidden md:block"
          style={{
            height: "min(82%, 380px)",
            aspectRatio: "2 / 3",
          }}
        >
          <ImageLoader
            src={item.poster}
            alt={item.name}
            decoding="async"
            loading="lazy"
            draggable={false}
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover rounded-2xl
                         border border-white/15 shadow-glass-edge"
          />
        </div>
      )}

      {/* Vignette + bottom gradient for legibility */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0.18) 0%, rgba(0,0,0,0.45) 70%, rgba(0,0,0,0.78) 100%)",
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-1/2 pointer-events-none"
        style={{
          background:
            "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)",
        }}
      />
    </div>
  );
}
