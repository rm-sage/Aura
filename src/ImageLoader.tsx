// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useImageEpoch, withImageBust } from "./imageCacheBust";

// ---------------------------------------------------------------------------
// ImageLoader: global graceful fade-in for every poster / backdrop / logo.
//
// Behaviour:
//   • Pre-load: shimmer skeleton (animated linear-gradient) reserves the box.
//   • onLoad:   image transitions opacity 0 → 1 over 300 ms and the skeleton
//               goes. With `catalog` (every catalog row and grid): a 1000 ms
//               fade that a cached image gets too, the skeleton crossfading
//               out under it (see the fade effect).
//   • onError:  silent; the parent gets the placeholder via children fallback.
//
// Key invariant: the wrapper has the SAME box geometry whether the image is
// loaded, loading, or errored. That kills layout shifts as images stream in
// from the network.
// ---------------------------------------------------------------------------

export interface ImageLoaderProps {
  src: string | null | undefined;
  alt?: string;
  draggable?: boolean;
  decoding?: "async" | "sync" | "auto";
  loading?: "eager" | "lazy";
  /** Class on the OUTER box (controls geometry / aspect ratio). */
  className?: string;
  /** Class on the INNER <img> (controls object-fit / placement). */
  imgClassName?: string;
  /** Inline style on the inner <img>. */
  imgStyle?: React.CSSProperties;
  /** Optional class for the shimmer skeleton (defaults match the dark UI). */
  skeletonClassName?: string;
  /** Fired with the underlying HTMLImageElement on successful load. Useful for
   *  measuring `naturalWidth` (e.g. low-res detection in the hero). */
  onLoad?: (img: HTMLImageElement) => void;
  /** Optional fallback content rendered when the image errors out. */
  fallback?: React.ReactNode;
  /** Fired once the loader has given up — every retry and the RPDB→metahub
   *  swap exhausted. Callers that GATE something on this image being ready
   *  (the detail hero holds its whole reveal until the backdrop decodes)
   *  need the failure edge too, or one dead URL strands them waiting
   *  forever. Not fired for intermediate failures that still have a retry
   *  left. */
  onError?: () => void;
  /** Diagnostic: when set, warn to the DevConsole if the DECODED image is
   *  pathologically large for a small tile (>1.5 MP). Surfaces a single
   *  oversized poster that tanks scroll (compositor re-rasters the big texture
   *  every frame). Label is the item name so the culprit is identifiable. */
  perfLabel?: string;
  /** Catalog art (a poster or card in a row, grid or list): a slower fade
   *  (CATALOG_FADE_MS) that also runs when the browser already has the image,
   *  with the skeleton crossfading out under it. See the fade effect below. */
  catalog?: boolean;
}

/** The catalog fade (2026-11-25; the user: catalog images should "slowly fade
 *  in as they load, so switching to and from the home page isn't as
 *  jarring", everywhere catalogs load). */
const CATALOG_FADE_MS = 1000;

/** Map an `api.ratingposterdb.com/.../imdb/poster-default/<tt…>.jpg` URL to
 *  the equivalent metahub poster URL. Returns null for any non-RPDB or
 *  non-IMDb path. RPDB serves posters via per-user `t3-<token>` API keys
 *  baked into the URL by whichever addon supplied the poster; once that
 *  token is revoked or rate-limited, RPDB returns `403 "API Key is
 *  Invalid"` for every poster sharing the token. Metahub (Cinemeta's
 *  CDN) is freely accessible and carries the same poster set keyed by
 *  IMDb id, so it's a clean drop-in fallback for tt-prefixed entries. */
function rpdbToMetahubFallback(url: string): string | null {
  const m = url.match(/api\.ratingposterdb\.com\/[^/]+\/imdb\/poster-default\/(tt\d+)\.jpg/);
  return m ? `https://images.metahub.space/poster/medium/${m[1]}/img` : null;
}

// Max automatic re-fetches after a transient image failure before we give up to
// the placeholder. Two (with backoff) recovers a network blip / 429 / 503 / a
// momentarily-unreachable CDN without looping forever on a genuine 404.
const MAX_IMG_RETRIES = 2;

export default function ImageLoader({
  src,
  alt = "",
  draggable,
  decoding = "async",
  loading = "lazy",
  className,
  imgClassName,
  imgStyle,
  skeletonClassName,
  onLoad,
  onError,
  fallback,
  perfLabel,
  catalog = false,
}: ImageLoaderProps) {
  const [loaded, setLoaded] = useState(false);
  // Catalog fade only: the skeleton stays (fading out) until the image's fade
  // has finished.
  const [settled, setSettled] = useState(false);
  const skeletonRef = useRef<HTMLSpanElement>(null);
  // A caller that drives the image's opacity itself keeps it (the detail
  // backdrop rides its own reveal).
  const fades = catalog && imgStyle?.opacity === undefined;
  const [errored, setErrored] = useState(false);
  // Substitute URL we've swapped in after the original failed. Used for
  // the RPDB → metahub recovery path below. Distinct from `errored` so a
  // successful retry can paint normally without flickering through the
  // skeleton/placeholder.
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(null);
  // Ref-not-state so the onError closure always sees the latest value
  // without re-binding the listener through a render cycle.
  const triedFallbackRef = useRef(false);
  // Bounded transient-failure retry. `retryNonce` is appended to the URL to
  // force the <img> to re-fetch the SAME source; the count + timer are refs so
  // the onError closure reads the latest without re-binding. Without this a
  // single failed fetch stranded the tile on the placeholder until it remounted
  // (scroll away + back) or a cache-bust: the "poster never loads, stays blank
  // forever" symptom.
  const [retryNonce, setRetryNonce] = useState(0);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  // `inView` controls whether we even set the <img>'s src. Native
  // `loading="lazy"` mis-fires on tiles inside horizontally-scrolling
  // rows: the initial IntersectionObserver check misses some entries,
  // and the only thing that wakes them up is a later layout change
  // (e.g. the hover :scale on the card), which is why poster tiles
  // appeared blank until the user pointed at them. Custom observer
  // below uses an explicit `rootMargin` of 600 px on every axis so
  // anything within ~600 px of the viewport — including off-screen
  // tiles in a horizontally-scrolled row — is pre-fetched.
  const [inView, setInView] = useState(loading === "eager");
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const ref = useRef<HTMLImageElement>(null);
  // Cache-bust epoch — appended to the loaded URL so "Reload cached posters"
  // (Settings > Storage) forces a fresh fetch of every image. No-op at epoch 0.
  const imgEpoch = useImageEpoch();

  // Reset state whenever the src changes so the new image fades in cleanly.
  useEffect(() => {
    const img = ref.current;
    const ready = !!img && img.complete && img.naturalWidth > 0;
    setLoaded(false);
    // An image already complete keeps `settled`: `loaded` comes back true in
    // this same batch, so the fade effect would not run to settle it again,
    // and a settled catalog card whose src swapped to a cached URL (a CW
    // card's landscape art landing, a Calendar cell's detail poster) kept
    // its skeleton shimmering over the poster for good. The fade effect runs
    // on the src change itself (its deps), so the swap still fades.
    if (!ready) setSettled(false);
    setErrored(false);
    setFallbackSrc(null);
    triedFallbackRef.current = false;
    retryCountRef.current = 0;
    setRetryNonce(0);
    if (retryTimerRef.current != null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    // If the browser already had this URL cached, `onLoad` may not fire.
    // Detect that and short-circuit so we don't show an indefinite skeleton.
    if (ready && img) {
      setLoaded(true);
      onLoad?.(img);
    }
    // We deliberately exclude `onLoad` from deps — callers often pass an inline
    // function. Resetting on src change is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // The catalog fade. A CSS transition on `opacity` runs only when the value
  // CHANGES after the element was first styled, so an image the browser
  // already had (every poster on a page you come back to) was marked loaded
  // before its first paint and popped in at full strength, while the rest
  // faded: the jarring page switch. A Web Animation from 0 runs either way,
  // started here before the paint. The skeleton fades out on the same clock
  // and is taken off when it ends (it used to vanish the moment the image
  // started to fade, so the fade ran over the bare card).
  useLayoutEffect(() => {
    if (!fades || !loaded) return;
    const img = ref.current;
    const reduced = document.documentElement.getAttribute("data-reduced-motion") === "true";
    if (!img || reduced || typeof img.animate !== "function") { setSettled(true); return; }
    const timing: KeyframeAnimationOptions = { duration: CATALOG_FADE_MS, easing: "ease-out" };
    const a = img.animate([{ opacity: 0 }, { opacity: 1 }], timing);
    const s = skeletonRef.current?.animate([{ opacity: 1 }, { opacity: 0 }], { ...timing, fill: "forwards" });
    a.onfinish = () => setSettled(true);
    return () => { a.onfinish = null; a.cancel(); s?.cancel(); };
    // `src` too: a swap to an image the browser already has never takes
    // `loaded` through false (see the reset effect), and still fades.
  }, [fades, loaded, src]);

  // Clear any pending retry timer on unmount so it can't fire into a dead card.
  useEffect(() => () => {
    if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
  }, []);

  // Custom IntersectionObserver-driven lazy-load. Only runs when
  // `loading="lazy"` (the default); `loading="eager"` short-circuits
  // by initialising `inView=true` above. The 1200 px rootMargin
  // (raised from 600 px) is wide enough to keep horizontal catalog
  // rows pre-fetched even during fast flick-scrolls — at 600 px, a
  // user dragging through CinemaRows quickly observed posters
  // appearing blank until they slowed down because the IO fired
  // AT +600 px and decode + paint took longer than the user took to
  // pass through. Combined with the `image.decode()` step below,
  // tiles enter the viewport with pixels already on the GPU.
  useEffect(() => {
    if (loading === "eager" || inView) return;
    const node = wrapperRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      // Older WebView2 / non-browser environment — just load eagerly.
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
            return;
          }
        }
      },
      // Preload ~0.75 of a viewport ahead instead of a flat 1200px: scales the
      // off-screen decode/VRAM cost to the window size (a flat 1200px preloads
      // many extra rows on a short window) while never exceeding the old value
      // and never dropping below 600px, so normal scrolling still hits warm
      // images. (Clamped conservatively; bump the 600 floor if fling-scroll on
      // the widest grid shows skeleton pop-in.)
      { rootMargin: `${Math.min(1200, Math.max(600, Math.round((typeof window !== "undefined" ? window.innerHeight : 1080) * 0.75)))}px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, inView]);

  // Wrapper position is determined by the caller's className — we deliberately
  // do NOT set `relative` here so callers passing `absolute inset-0` aren't
  // overridden by Tailwind's utility ordering (position utilities resolve to
  // whichever class wins the cascade, not the order in className).
  return (
    <span
      ref={wrapperRef}
      className={`block ${className ?? ""}`}
      style={{
        overflow: "hidden",
        // The skeleton below is `absolute inset-0`, so this element MUST be its
        // containing block. When a caller passes no positioning class the
        // skeleton escapes to whatever positioned ancestor it finds, and then
        // covers THAT instead: in the anime extras panel every one of 24 poster
        // skeletons stretched across the whole dialog and shimmered over the
        // header, the tabs and the loaded posters alike, forever, because tiles
        // below the fold never entered view to clear theirs.
        //
        // Applied as an inline style rather than a `relative` class on purpose:
        // position utilities collide in the cascade rather than by className
        // order (see the note above), so adding one would fight callers that
        // legitimately pass `absolute` or `fixed`. Those callers already supply
        // a containing block, so they are left alone.
        ...(/\b(absolute|fixed|sticky|relative)\b/.test(className ?? "")
          ? null
          : { position: "relative" as const }),
        // The catalog fade crossfades the skeleton UNDER the image: the
        // skeleton is positioned and the image is not, so without its own
        // stacking context here (and the skeleton at -1 in it) the shimmer
        // painted over the poster for the whole fade.
        ...(fades ? { isolation: "isolate" as const } : null),
      }}
    >
      {/* Skeleton: visible until the image fires onLoad. Its shimmer is
          held still (data-skeleton-parked, App.css) until the observer above
          says the tile is in view: a tile further down never enters view
          until it is scrolled to (the page scroller clips it, so the
          rootMargin does not reach it), and every row below the fold
          shimmered forever, repainting and re-rastering on every frame of an
          otherwise idle Home (measured round 11: about 3 ms of GPU-process
          time per frame with two rows parked below the fold). */}
      {!(fades ? settled : loaded) && !errored && (
        <span
          ref={skeletonRef}
          aria-hidden
          data-skeleton-parked={inView ? undefined : ""}
          className={`absolute inset-0 ${skeletonClassName ?? "image-loader-skeleton"}`}
          style={fades ? { zIndex: -1 } : undefined}
        />
      )}

      {src && !errored && inView && (
        <img
          ref={ref}
          // Append the retry nonce (when > 0) so a re-fetch attempt after a
          // transient failure bypasses the cached failed response.
          src={(() => {
            const busted = withImageBust(fallbackSrc ?? src, imgEpoch);
            return retryNonce > 0
              ? `${busted}${busted.includes("?") ? "&" : "?"}_r=${retryNonce}`
              : busted;
          })()}
          alt={alt}
          draggable={draggable}
          decoding={decoding}
          // Drop the native `loading` attribute — our IntersectionObserver
          // above already gates when the <img> mounts. Setting `loading=lazy`
          // here on top of our gate would just reintroduce the original
          // mis-fire (an <img> mounted with src=set + loading=lazy still
          // defers the actual fetch via the broken native path).
          onLoad={(e) => {
            const img = e.currentTarget;
            // Wait for actual GPU decode before fading in. `onLoad`
            // fires when bytes have arrived but `decoding="async"`
            // means pixels are processed off the main thread; without
            // the `image.decode()` await, fast scrolls would fade in
            // while the browser was still rasterising and the user
            // saw a momentary "blank tile that then filled in." For
            // browsers that don't support .decode() (older WebView2
            // builds), the catch path falls back to setLoaded(true)
            // immediately so rendering still happens.
            const finishLoad = () => {
              // Diagnostic: flag a decoded poster that's far larger than a small
              // tile needs (>1.5 MP, e.g. a 2000x3000 master). One such texture
              // re-rastered every scroll frame is the "one row tanks" symptom.
              if (perfLabel && img.naturalWidth * img.naturalHeight > 1_500_000) {
                console.warn(
                  `[lib-poster] oversized "${perfLabel}" ${img.naturalWidth}x${img.naturalHeight} src=${img.currentSrc}`,
                );
              }
              setLoaded(true);
              if (ref.current) onLoad?.(ref.current);
            };
            if (typeof img.decode === "function") {
              img.decode().then(finishLoad).catch(finishLoad);
            } else {
              finishLoad();
            }
          }}
          onError={() => {
            // First-failure recovery: if the broken URL is an RPDB
            // poster (per-user API key in the path; common revocation
            // / rate-limit failure mode), retry once from metahub
            // using the same IMDb id. Tracked via a ref so a second
            // failure on the metahub URL falls through to the
            // placeholder instead of looping.
            if (!triedFallbackRef.current) {
              const swap = rpdbToMetahubFallback(fallbackSrc ?? src ?? "");
              if (swap) {
                triedFallbackRef.current = true;
                setFallbackSrc(swap);
                return;
              }
            }
            // Bounded transient-failure retry: re-fetch the same URL a couple
            // times with backoff (1.5s, 3s) before settling on the placeholder,
            // so a network blip / rate-limit doesn't strand the tile blank until
            // it remounts. A genuine 404 exhausts the retries and falls through.
            if (retryCountRef.current < MAX_IMG_RETRIES) {
              const attempt = retryCountRef.current + 1;
              retryCountRef.current = attempt;
              if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
              retryTimerRef.current = window.setTimeout(() => {
                retryTimerRef.current = null;
                setRetryNonce(attempt); // nonce bump → <img> re-fetches the source
              }, attempt * 1500);
              return;
            }
            setErrored(true);
            onError?.();
          }}
          className={`block ${imgClassName ?? ""}`}
          style={{
            opacity: loaded ? 1 : 0,
            // The catalog fade is an animation (see the fade effect).
            ...(fades ? null : { transition: "opacity 300ms ease-out" }),
            ...imgStyle,
          }}
        />
      )}

      {errored && fallback}
    </span>
  );
}
