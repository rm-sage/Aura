import { useState, useRef, memo } from "react";
import type { MetaPreview, LibraryItem } from "./types";

// ---------------------------------------------------------------------------
// Shared row scaffolding
//
// Performance notes:
//   • cv-auto on RowShell skips layout + paint for off-screen rows.
//   • We deliberately DO NOT promote each row to its own GPU layer; doing so
//     spawns one compositor surface per row and the cross-row copy/composite
//     cost was a net loss during fast vertical scrolls. Containment via
//     content-visibility already isolates each row's paint.
//   • All <img> are loading="lazy" decoding="async" — decode happens off the
//     main thread.
//   • The scroll arrows previously used .glass-panel-elevated (backdrop blur),
//     which forces a full-area filter pass even while invisible (opacity:0).
//     They now use a simple translucent black background — visually close,
//     vastly cheaper.
// ---------------------------------------------------------------------------

// Layout tunables — tweak in one spot
const DISCOVERY_W   = 220;     // portrait card width
const CONTINUE_W    = 460;     // 16:9 card width
const CARD_GAP_PX   = 22;      // horizontal gap between cards

const ChevronLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
  </svg>
);
const ChevronRight = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
  </svg>
);

interface RowShellProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

function RowShell({ title, subtitle, children }: RowShellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);

  const scroll = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  return (
    <section
      className="relative px-6 cv-auto"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-baseline justify-between mb-3 px-1">
        <h3 className="text-white/80 text-sm font-semibold tracking-wide">{title}</h3>
        {subtitle && (
          <p className="text-white/30 text-xs">{subtitle}</p>
        )}
      </div>

      <div className="relative">
        <div
          ref={ref}
          className="scroll-row flex pb-3"
          style={{ gap: `${CARD_GAP_PX}px` }}
        >
          {children}
        </div>

        {/* Hover-only scroll arrows — cheap solid background, no backdrop blur */}
        <button
          onClick={() => scroll(-1)}
          aria-label="Scroll left"
          className={`absolute left-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full
                      flex items-center justify-center
                      text-white/80 hover:text-white transition-opacity duration-200
                      bg-black/55 border border-white/15
                      ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <ChevronLeft />
        </button>
        <button
          onClick={() => scroll(1)}
          aria-label="Scroll right"
          className={`absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full
                      flex items-center justify-center
                      text-white/80 hover:text-white transition-opacity duration-200
                      bg-black/55 border border-white/15
                      ${hovered ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          <ChevronRight />
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Continue Watching — 16:9 backdrop cards with progress bar
// ---------------------------------------------------------------------------

interface ContinueWatchingCardProps { item: LibraryItem }

const ContinueWatchingCard = memo(function ContinueWatchingCard(
  { item }: ContinueWatchingCardProps
) {
  const [imgError, setImgError] = useState(false);
  const src = item.background ?? item.poster;
  const showImage = src && !imgError;

  // Progress (0..1) — derived from state.timeOffset / state.duration when both
  // are present. Falls back to 0 when duration is unknown.
  const offset = typeof item.state?.timeOffset === "number" ? item.state.timeOffset : 0;
  const duration = typeof item.state?.duration === "number" ? item.state.duration : 0;
  const progress = duration > 0 ? Math.min(1, offset / duration) : 0;

  return (
    <div
      className="group flex-shrink-0 cursor-pointer card-contain"
      style={{ width: `${CONTINUE_W}px`, scrollSnapAlign: "start" }}
    >
      <div
        className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
        style={{ aspectRatio: "16 / 9" }}
      >
        {showImage ? (
          <img
            src={src!}
            alt={item.name}
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
            draggable={false}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/20">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
        )}

        {/* Bottom gradient + progress bar */}
        <div className="absolute inset-x-0 bottom-0 h-1/3
                        bg-gradient-to-t from-black/70 to-transparent" />
        {progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/15">
            <div className="h-full bg-ln-accent" style={{ width: `${progress * 100}%` }} />
          </div>
        )}
      </div>
      <p className="text-white/85 text-sm font-medium mt-2.5 leading-tight line-clamp-1 text-center">
        {item.name}
      </p>
      {item.year && (
        <p className="text-white/35 text-xs mt-0.5 text-center">{item.year}</p>
      )}
    </div>
  );
});

interface ContinueWatchingRowProps {
  items: LibraryItem[];
}

export const ContinueWatchingRow = memo(function ContinueWatchingRow(
  { items }: ContinueWatchingRowProps
) {
  if (items.length === 0) return null;
  return (
    <RowShell title="Continue Watching" subtitle={`${items.length} in progress`}>
      {items.map((item) => (
        <ContinueWatchingCard key={item.id} item={item} />
      ))}
    </RowShell>
  );
});

// ---------------------------------------------------------------------------
// Discovery row — portrait posters (CatalogCard)
// ---------------------------------------------------------------------------

interface CatalogCardProps { meta: MetaPreview }

export const CatalogCard = memo(function CatalogCard({ meta }: CatalogCardProps) {
  const [imgError, setImgError] = useState(false);
  const showImage = meta.poster && !imgError;

  return (
    <div
      className="group flex-shrink-0 cursor-pointer card-contain"
      style={{ width: `${DISCOVERY_W}px`, scrollSnapAlign: "start" }}
    >
      <div
        className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
        style={{ aspectRatio: "2 / 3" }}
      >
        {showImage ? (
          <img
            src={meta.poster!}
            alt={meta.name}
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
            draggable={false}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-[1.04]"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/20">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
            </svg>
          </div>
        )}
      </div>
      <p className="text-white/85 text-sm font-medium mt-2.5 leading-tight line-clamp-2 text-center">
        {meta.name}
      </p>
      {meta.release_info && (
        <p className="text-white/35 text-xs mt-0.5 text-center">{meta.release_info}</p>
      )}
    </div>
  );
});

interface DiscoveryRowProps {
  title: string;
  items: MetaPreview[];
  loading?: boolean;
}

export const DiscoveryRow = memo(function DiscoveryRow(
  { title, items, loading }: DiscoveryRowProps
) {
  // Skeleton while loading
  if (loading && items.length === 0) {
    return (
      <RowShell title={title}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex-shrink-0 rounded-xl bg-white/5 animate-pulse"
            style={{ width: `${DISCOVERY_W}px`, aspectRatio: "2 / 3" }}
          />
        ))}
      </RowShell>
    );
  }

  if (items.length === 0) return null;

  return (
    <RowShell title={title}>
      {items.map((meta) => (
        <CatalogCard key={`${meta.media_type}:${meta.id}`} meta={meta} />
      ))}
    </RowShell>
  );
});
