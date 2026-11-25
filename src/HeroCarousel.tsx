// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useCallback, memo } from "react";
import type { MetaPreview } from "./types";
import ImageLoader from "./ImageLoader";
import { shrinkPoster, screenWidthHint, sizedLogo } from "./posterSize";
import { useWindowHidden } from "./windowVisibility";
import HeroBleed, { BLEED_STRENGTH } from "./HeroBleed";
import {
  heroPalette, peekHeroPalette, underglowImage, UNDERGLOW_PAD,
  type HeroPalette, type RGB,
} from "./heroAmbient";
import { releaseSvgImage } from "./glassGlint";

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
// Auto-advances every AUTO_ADVANCE_MS; holds while the cursor is over the
// hero, the window is hidden, or Home is not seen (`paused`: a Detail page
// over it, or playback). The first slide mounts at full opacity with no
// cross-fade (only a later index change fades), and HomeView hands over a
// settled list (heroSource.ts), so loading never steps through slides.
// ---------------------------------------------------------------------------

interface Props {
  items: MetaPreview[];
  /** The source's identity (HomeView keys the carousel on it too): the
   *  slide shown is remembered per source, so coming back to Home shows
   *  the slide it was on instead of restarting at the first. */
  sourceKey?: string;
  /** Hold the auto-advance (Home mounted but covered). */
  paused?: boolean;
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

/** The slide last shown, by source (one entry): HomeView unmounts when
 *  another view opens, and a return lands back on this slide. */
let lastSlide: { source: string; id: string } | null = null;

function initialSlide(items: MetaPreview[], source: string | undefined): number {
  if (!source || !lastSlide || lastSlide.source !== source) return 0;
  const id = lastSlide.id;
  const i = items.findIndex((it) => it.id === id);
  return i >= 0 ? i : 0;
}

function HeroCarouselInner({ items, onSelect, sourceLabel, sourceKey, paused }: Props) {
  // Per-item "logo image failed to load" set. Falls back to the
  // text-title rendering path for that item, sidestepping the
  // broken-image glyph the browser would otherwise paint next to the
  // alt text. Keyed by item id so a working logo for the next slide
  // isn't suppressed by a previous item's failure.
  const [logoFailed, setLogoFailed] = useState<Set<string>>(new Set());
  const markLogoFailed = (id: string) => {
    setLogoFailed((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };
  // The first slide (the remembered one on a return) is the initial state, so
  // the first commit already shows it: prevIndexRef starts on it below and no
  // cross-fade runs for it.
  const [rawIndex, setIndex] = useState(() => initialSlide(items, sourceKey));
  // Clamped at READ time. The effect below resets the state when the list
  // shrinks, but it runs after the render that sees the shorter list, and that
  // render reads items[index] for the current slide: an out-of-range index
  // there is a crash, not a flash. The list can still change under a mounted
  // carousel (a pinned catalog refetched with other titles), so every read
  // goes through this value instead.
  const index = rawIndex < items.length ? rawIndex : 0;
  const [hovered, setHovered] = useState(false);
  /** Item ids where we've detected a dual-layer fallback (low-res or
   *  portrait-only). Keyed by id, not slide index: the list can change under a
   *  mounted carousel, and an index mark would then pad a different slide. */
  const [dualLayer, setDualLayer] = useState<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  // RAM: only the backdrops needed for the cross-fade stay mounted (each full
  // 21:9 art is ~5 MB decoded). `transitionFrom` keeps the OUTGOING slide
  // mounted for the fade duration so even an arbitrary dot-jump cross-fades
  // cleanly; afterwards only {prev, current, next} remain decoded.
  const [transitionFrom, setTransitionFrom] = useState<number | null>(null);
  const prevIndexRef = useRef(index);
  useEffect(() => {
    if (prevIndexRef.current === index) return;
    setTransitionFrom(prevIndexRef.current);
    prevIndexRef.current = index;
    const t = setTimeout(() => setTransitionFrom(null), FADE_DURATION_MS);
    return () => clearTimeout(t);
  }, [index]);

  const reportDualLayer = useCallback((id: string) => {
    setDualLayer((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Clamp index when items list shrinks
  useEffect(() => {
    if (rawIndex >= items.length) setIndex(0);
  }, [items.length, rawIndex]);

  // Auto-advance: only while Home is seen (not `paused` under a Detail page
  // or playback, not hovered, the window not hidden / minimized). Each of
  // those restarts the full interval when it ends.
  const hidden = useWindowHidden();
  useEffect(() => {
    if (items.length <= 1 || hovered || hidden || paused) return;
    timer.current = setInterval(() => {
      setIndex((i) => (i + 1) % items.length);
    }, AUTO_ADVANCE_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [items.length, hovered, hidden, paused]);

  // Remember the slide shown for a return to Home.
  const shownId = items.length > 0 ? items[index].id : null;
  useEffect(() => {
    if (sourceKey && shownId) lastSlide = { source: sourceKey, id: shownId };
  }, [sourceKey, shownId]);

  const goTo = useCallback((i: number) => {
    if (items.length === 0) return;
    setIndex(((i % items.length) + items.length) % items.length);
  }, [items.length]);

  const next = useCallback(() => goTo(index + 1), [index, goTo]);
  const prev = useCallback(() => goTo(index - 1), [index, goTo]);

  // ---- ambient light (round 9): palette, underglow, bleed ------------------
  // The current slide's art, exactly as the backdrop loads it (the proxy url,
  // so its colours can be read back; heroAmbient.ts).
  const currentItem = items.length > 0 ? items[index] : null;
  // ONE width hint per render, handed to the memoized backdrops as a prop:
  // read inside them, a display / scale change reached the palette url on
  // the next carousel render but not the shown art, so the two drifted apart.
  const widthHint = screenWidthHint();
  const artUrl = currentItem ? (shrinkPoster(pickHeroArt(currentItem).src, widthHint) ?? null) : null;
  const [palette, setPalette] = useState<HeroPalette | null>(() => peekHeroPalette(artUrl));
  useEffect(() => {
    let live = true;
    const hit = peekHeroPalette(artUrl);
    if (hit) { setPalette(hit); return; }
    // The old palette stays only while the read is pending; an unreadable
    // slide clears it (no bleed, a neutral shadow, never the last slide's).
    heroPalette(artUrl).then((p) => { if (live) setPalette(p ?? null); });
    return () => { live = false; };
  }, [artUrl]);

  // The neighbours' palettes and logos are read AHEAD (2026-11-24; the user:
  // on Avengers: Endgame the colour bleed "seems to be pausing to wait for
  // the logo to load before applying"). The palette was read only once a
  // slide was current, from the art fetched again then, so a slide whose
  // art was slow to arrive kept the last slide's bleed until it did (the
  // video: the old bleed held about 0.5 s after the slide changed, released
  // with the art and the logo, which was likewise fetched only then). Both
  // neighbours, so auto-advance, Next and Previous all find them ready; the
  // palette cache is bounded (heroAmbient.ts, 32), and the two logo images
  // here are replaced on every change.
  const logoWarm = useRef<HTMLImageElement[]>([]);
  useEffect(() => {
    const n = items.length;
    if (n < 2) return;
    const near = [...new Set([(index + 1) % n, (index - 1 + n) % n])].filter((i) => i !== index);
    const imgs: HTMLImageElement[] = [];
    for (const i of near) {
      const it = items[i];
      const art = shrinkPoster(pickHeroArt(it).src, screenWidthHint());
      if (art) void heroPalette(art);
      if (it.logo && !logoFailed.has(it.id)) {
        const img = new Image();
        img.decoding = "async";
        img.src = sizedLogo(it.logo) ?? it.logo;
        imgs.push(img);
      }
    }
    logoWarm.current = imgs;
  }, [index, items]); // eslint-disable-line react-hooks/exhaustive-deps

  const heroRef = useRef<HTMLDivElement>(null);
  const underglow = useUnderglow(heroRef, palette);

  if (items.length === 0) return null;

  const current = items[index];

  // Mounted-backdrop window: current ± 1 (preload for next/prev/auto-advance)
  // plus the slide we're fading FROM. Everything else stays unmounted so its
  // decoded bitmap is freed. The outgoing slide is derived during RENDER: on the
  // commit right after an index change, prevIndexRef still holds the old index
  // (the effect below advances it post-paint), so even a non-adjacent dot jump
  // mounts the outgoing slide in the SAME frame and its fade-OUT fires (rather
  // than a hard cut + a pointless re-mount). During the fade it's transitionFrom.
  const outgoing = prevIndexRef.current !== index ? prevIndexRef.current : transitionFrom;
  const n = items.length;
  const windowed = new Set<number>([index]);
  if (n > 1) {
    windowed.add((index - 1 + n) % n);
    windowed.add((index + 1) % n);
  }
  if (outgoing != null && outgoing < n && outgoing !== index) windowed.add(outgoing);

  return (
    // The wrapper carries the width (so the underglow can sit outside the
    // hero's clip); the hero box inside keeps the same size as before.
    <div className="relative mx-auto w-full" style={{ maxWidth: HERO_MAX_WIDTH }}>
    {underglow.layers.map((l) => (
      <div
        key={l.key}
        aria-hidden
        className={`aura-hero-underglow${l.out ? " is-out" : ""}`}
        style={{
          left: -underglow.room.left, right: -underglow.room.right,
          top: -underglow.room.top, bottom: -underglow.room.bottom,
          backgroundImage: l.url,
        }}
      />
    ))}
    <HeroBleed palette={palette} heroRef={heroRef} />
    <div
      ref={heroRef}
      className="relative mx-auto w-full overflow-hidden rounded-[18px]
                 aura-hero-box group gpu-layer cv-auto-hero cursor-pointer"
      style={{
        // 21:9 box (cinematic). Landscape art is object-cover and crops
        // slightly to fill the wider box. 18 px corners and a cursor-lit
        // bezel (round 9, .aura-hero-bezel below) frame it; the old 1px
        // white border is gone. .aura-hero-box (glass-hero.css) clips the
        // whole group once, so its corners have no dark ring (round 19).
        aspectRatio: "21 / 9",
        maxHeight: HERO_MAX_HEIGHT,
        maxWidth: HERO_MAX_WIDTH,
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
      {/* Backdrop layers — only the windowed indices ({prev,current,next} +
          the fading-out slide) mount, so offscreen 21:9 art doesn't stay
          decoded (~5 MB each). Priority: background → fanart → backdrop →
          poster (heavy blur). Each item reports its natural width on load so we
          can detect low-resolution backdrops and lay a sharp poster on top. */}
      {items.map((item, i) => (
        windowed.has(i) ? (
          <HeroBackdrop
            key={item.id}
            item={item}
            active={i === index}
            widthHint={widthHint}
            onDualLayer={reportDualLayer}
          />
        ) : null
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

      {/* Localised legibility ramp — a soft radial-ish gradient anchored
          to the bottom-left corner of the hero, sized to cover the title
          + synopsis column without touching the rest of the image. Gives
          the text a darker pedestal on dark-natured backdrops (cave
          scenes, night shots, low-key cinematography) where the existing
          text-shadow alone reads as visible glow against the source
          darkness. On bright backdrops the gradient blends into the
          natural shadow gradient of the image and is essentially
          invisible. Independent of the mask fades above — that fix
          addresses the page-edge seam; this one addresses text-on-image
          legibility. pointer-events: none so it doesn't intercept the
          wrapper's click-to-detail handler. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "linear-gradient(to top right, " +
              "rgba(0,0,0,0.55) 0%, " +
              "rgba(0,0,0,0.40) 20%, " +
              "rgba(0,0,0,0.20) 40%, " +
              "transparent 65%)",
        }}
      />

      {/* Hero text overlay — bare typography anchored bottom-LEFT of
          the hero box. No glass card; the shadow + the legibility ramp
          above do the work. Restricted to a left-anchored column so long
          synopses don't sprawl across the whole hero, and pulled tight
          to the bottom-left corner with `justify-start` + `items-end`
          so the block feels intentionally placed rather than centred. */}
      <div className="absolute inset-0 flex items-end justify-start pointer-events-none">
        <div
          key={current.id /* re-mount → fade in */}
          className={`pb-4 transition-[padding] duration-500
                      ${dualLayer.has(current.id) ? "pl-[420px] pr-10" : "pl-5 pr-10"}`}
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
            {current.logo && !logoFailed.has(current.id) ? (
              <div className="flex items-end gap-4 mb-3 flex-wrap">
                <img
                  src={sizedLogo(current.logo) ?? undefined}
                  alt=""
                  draggable={false}
                  className="max-h-24 object-contain object-left"
                  style={{
                    maxWidth: "min(440px, 100%)",
                    filter:
                      "drop-shadow(0 4px 14px rgba(0,0,0,0.85)) drop-shadow(0 0 22px rgba(0,0,0,0.4))",
                  }}
                  // Logo URLs can 404 or return malformed image data (CDN
                  // churn, deleted Fanart.tv entries, etc.). Flip into the
                  // text-title branch on error so the user sees the show
                  // name instead of the browser's broken-image glyph + alt
                  // text. Empty alt above means the broken-image state
                  // doesn't ALSO leak the title — the text branch below
                  // owns that. Once flipped for an id, stays flipped for
                  // the rest of the carousel session (no retry-on-render
                  // thrash).
                  onError={() => markLogoFailed(current.id)}
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
          onClick (which routes to detail view) doesn't intercept them.
          Floating glass controls (App.css GLASS SYSTEM); their opacity fade
          is in glass-misc.css (.aura-hero-arrow), beside the press motion. */}
      {items.length > 1 && (
        <>
          <button
            onClick={(e) => { e.stopPropagation(); prev(); }}
            aria-label="Previous"
            className="aura-float-glass aura-glass-control aura-glass-press aura-hero-arrow
                       absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full
                       flex items-center justify-center text-white/80 hover:text-white
                       opacity-0 group-hover:opacity-100"
          >
            <ChevronLeft />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); next(); }}
            aria-label="Next"
            className="aura-float-glass aura-glass-control aura-glass-press aura-hero-arrow
                       absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full
                       flex items-center justify-center text-white/80 hover:text-white
                       opacity-0 group-hover:opacity-100"
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

      {/* The bezel: the rim light ring over the art (glass-hero.css). */}
      <span aria-hidden data-glass-light="rim" className="aura-hero-bezel" />
    </div>
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

// memo(), with the stable `reportDualLayer` (it takes the id): a hover in or
// out, a palette landing, an underglow layer swap or the fade's end re-render
// the carousel, and each of the three or four mounted backdrops (and their
// ImageLoaders) re-rendered with it for nothing, re-running both dual-layer
// effects on a fresh inline callback every time.
const HeroBackdrop = memo(function HeroBackdrop({
  item, active, widthHint, onDualLayer,
}: {
  item: MetaPreview;
  active: boolean;
  /** screenWidthHint() as the carousel read it (the same value its palette url uses). */
  widthHint: number;
  onDualLayer: (id: string) => void;
}) {
  const { src, isPortraitFallback } = pickHeroArt(item);
  // Full-bleed backdrop: resize to the display's physical width (never upscaled,
  // so a low-res source stays low-res and the detection below still fires).
  const proxiedSrc = shrinkPoster(src, widthHint);
  const [lowRes, setLowRes] = useState(false);

  // Reset measurement when src changes
  useEffect(() => { setLowRes(false); }, [src]);

  // If we already know we're falling back to a portrait poster, signal up
  // immediately so the parent slides the title card before the image arrives.
  useEffect(() => {
    if (isPortraitFallback) onDualLayer(item.id);
  }, [isPortraitFallback, onDualLayer, item.id]);

  // When the heuristic detection escalates to lowRes after onLoad, signal up
  useEffect(() => {
    if (lowRes) onDualLayer(item.id);
  }, [lowRes, onDualLayer, item.id]);

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
            src={proxiedSrc}
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
            src={proxiedSrc}
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
});

// ---------------------------------------------------------------------------
// useUnderglow: the hero's art-tinted underglow (round 9). A contact shadow
// (the art's raw middle at 22%, alpha 0.55, sigma 26) and a coloured halo
// (the vivid centre, alpha min(0.3, bleed x 1.4), sigma 62) behind the hero,
// as ONE dithered image (heroAmbient.ts underglowImage) per hero size and
// slide, crossfading between two layers on a change. It reaches
// UNDERGLOW_PAD past each edge, less where the page scroller's clip box is
// closer (it fades to 0 there instead of being cut). No palette: a neutral
// contact shadow only.
// ---------------------------------------------------------------------------

interface UnderglowLayer { key: number; url: string; out: boolean }
interface Room { left: number; right: number; top: number; bottom: number }
const NO_ROOM: Room = { left: 0, right: 0, top: 0, bottom: 0 };

function useUnderglow(heroRef: React.RefObject<HTMLDivElement | null>, palette: HeroPalette | null) {
  const [geo, setGeo] = useState<{ w: number; h: number; room: Room } | null>(null);
  const [layers, setLayers] = useState<UnderglowLayer[]>([]);
  const seq = useRef(0);
  const urlsRef = useRef(new Map<number, string>());

  // Size and room, re-measured when the hero resizes (debounced, 4 px steps).
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const r = hero.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      const sc = hero.closest<HTMLElement>(".aura-page-scroller");
      const st = sc?.scrollTop ?? 0;
      const c = sc?.getBoundingClientRect();
      const pad = UNDERGLOW_PAD;
      const room: Room = {
        left: Math.round(Math.max(0, Math.min(pad, c ? r.left - c.left : pad))),
        right: Math.round(Math.max(0, Math.min(pad, c ? c.right - r.right - 8 : pad))),
        top: Math.round(Math.max(0, Math.min(pad, c ? r.top + st - c.top : pad))),
        bottom: pad,
      };
      const w = Math.round(r.width / 4) * 4, h = Math.round(r.height / 4) * 4;
      setGeo((g) => (g && g.w === w && g.h === h && g.room.left === room.left && g.room.right === room.right
        && g.room.top === room.top ? g : { w, h, room }));
    };
    measure();
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(measure, 150);
    });
    ro.observe(hero);
    return () => { if (t) clearTimeout(t); ro.disconnect(); };
  }, [heroRef]);

  useEffect(() => {
    if (!geo) return;
    const shadow: RGB = palette ? palette.raw.map((v) => Math.round(v * 0.22)) as RGB : [0, 0, 0];
    const halo: RGB = palette ? palette.center : [0, 0, 0];
    const url = underglowImage({
      w: geo.w, h: geo.h, ...geo.room, shadow, halo,
      aS: 0.55, aH: palette ? Math.min(0.3, BLEED_STRENGTH * 1.4) : 0,
    });
    const key = ++seq.current;
    // The new layer fades in on mount (a CSS animation, no state flip), the
    // one in front of it fades out, and is dropped once the fade is done.
    urlsRef.current.set(key, url);
    setLayers((ls) => [...ls.filter((l) => !l.out).slice(-1).map((l) => ({ ...l, out: true })), { key, url, out: false }]);
    const drop = setTimeout(() => {
      setLayers((ls) => ls.filter((l) => l.key === key));
      // Images no layer shows any more (blob urls) are released.
      for (const [k, u] of urlsRef.current) if (k !== key) { releaseSvgImage(u); urlsRef.current.delete(k); }
    }, 1000);
    return () => clearTimeout(drop);
  }, [geo, palette]);
  useEffect(() => () => {
    for (const u of urlsRef.current.values()) releaseSvgImage(u);
    urlsRef.current.clear();
  }, []);

  return { layers, room: geo?.room ?? NO_ROOM };
}
