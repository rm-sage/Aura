import { useState, useEffect, useRef, useCallback, memo } from "react";
import type { MetaPreview } from "./types";

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

const AUTO_ADVANCE_MS = 8000;

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

function HeroCarouselInner({ items }: Props) {
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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
      className="relative w-full overflow-hidden rounded-2xl group gpu-layer cv-auto-hero"
      style={{ aspectRatio: "21 / 9", maxHeight: "55vh" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Backdrop layers — render every item so cross-fade works.
          Priority: background → fanart → backdrop → poster (heavy blur). */}
      {items.map((item, i) => {
        const { src, isPortraitFallback } = pickHeroArt(item);
        const active = i === index;
        const filter = isPortraitFallback
          ? "blur(20px) saturate(1.2)"          // portrait fallback — heavy blur
          : "blur(2px) saturate(1.1)";           // landscape art — minimal soft-focus

        return (
          <div
            key={item.id}
            className="absolute inset-0 transition-opacity duration-700 ease-in-out"
            style={{ opacity: active ? 1 : 0 }}
          >
            {src ? (
              <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                className="w-full h-full object-cover"
                style={{
                  filter,
                  // Slight scale-up on the heavy-blur path so blurred edges
                  // don't show through.
                  transform: isPortraitFallback ? "scale(1.08)" : undefined,
                }}
                draggable={false}
              />
            ) : (
              <div className="w-full h-full bg-black" />
            )}
            {/* Vignette + bottom gradient for legibility */}
            <div
              className="absolute inset-0"
              style={{
                background:
                  "radial-gradient(ellipse at center, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.85) 100%)",
              }}
            />
            <div
              className="absolute inset-x-0 bottom-0 h-1/2"
              style={{
                background:
                  "linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0) 100%)",
              }}
            />
          </div>
        );
      })}

      {/* Centered glass overlay — title / year / synopsis */}
      <div className="absolute inset-0 flex items-end pointer-events-none">
        <div
          key={current.id /* re-mount → fade in */}
          className="w-full px-10 pb-10"
          style={{ animation: "theme-fade-in 600ms ease-out" }}
        >
          <div className="glass-panel-elevated rounded-2xl px-7 py-5 max-w-2xl
                          shadow-glass-edge pointer-events-auto inline-block">
            <div className="flex items-baseline gap-3 flex-wrap mb-2">
              <h2 className="text-white text-2xl font-light tracking-wide leading-tight">
                {current.name}
              </h2>
              {current.release_info && (
                <span className="text-white/50 text-sm font-mono">
                  {current.release_info}
                </span>
              )}
            </div>
            {current.description && (
              <p className="text-white/70 text-sm leading-relaxed line-clamp-3">
                {current.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Hover-only arrows */}
      {items.length > 1 && (
        <>
          <button
            onClick={prev}
            aria-label="Previous"
            className="absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full
                       glass-panel-elevated flex items-center justify-center
                       text-white/80 hover:text-white
                       opacity-0 group-hover:opacity-100 transition-opacity duration-300"
          >
            <ChevronLeft />
          </button>
          <button
            onClick={next}
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
                onClick={() => goTo(i)}
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
