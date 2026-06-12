// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useMemo, useRef, useEffect, useReducer, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { channelPrograms } from "../../iptv/epgStore";
import { isFavorite, toggleFavorite, subscribeFavorites } from "../../iptv/favoritesStore";
import { openChannelMenu } from "../../iptv/channelMenu";
import type { IptvChannel, EpgProgram } from "../../iptv/types";

// ---------------------------------------------------------------------------
// GuideView — a TV-guide time grid: channel rows × a horizontally-scrolling
// timeline of programme blocks, with a sticky channel column, a sticky time
// ruler, and a "now" line. Built on the EPG store (channelPrograms).
//
// MEMORY/PERF: rows are the already-filtered+capped channel set from
// LiveView (group + search), so the guide never renders thousands of rows.
// Per channel we render only the programmes that intersect the visible time
// WINDOW (now → +WINDOW_HOURS), so block count stays bounded regardless of
// how deep the EPG goes.
// ---------------------------------------------------------------------------

const CHANNEL_COL_W = 220; // px — sticky left column (wide enough that most
                           // channel names don't truncate)
const ROW_H = 44; // px
const PX_PER_MIN = 5; // 300 px / hour
const WINDOW_HOURS = 8; // visible/scrollable span forward from the hour
const RULER_H = 30; // px — time-ruler row height
const LIVE_STRIP_H = 20; // px — strip above the ruler that holds the LIVE pill

interface Props {
  channels: IptvChannel[];
  sourceId: string;
  sourceName: string;
  nowMs: number;
  hasEpg: boolean;
  epgLoading: boolean;
  /** True when more channels exist beyond the rendered slice — drives the
   *  scroll-to-load-more behaviour + the bottom sentinel. */
  hasMore?: boolean;
  /** Reveal the next page of channel rows (called once when the vertical
   *  scroll nears the bottom and `hasMore` is true). */
  onReachEnd?: () => void;
  onPlayChannel: (channel: IptvChannel) => void;
}

export default function GuideView({ channels, sourceId, sourceName, nowMs, hasEpg, epgLoading, hasMore, onReachEnd, onPlayChannel }: Props) {
  // Re-render the rows when favourites change so the stars stay in sync.
  const [, bumpFav] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeFavorites(bumpFav), []);

  // Floating programme hover card (portaled to body so it escapes the guide's
  // scroll overflow).
  const [hover, setHover] = useState<HoverState | null>(null);
  // Window: floor `now` to the hour so the in-progress programme is visible,
  // spanning WINDOW_HOURS forward. Recomputed only when the hour rolls over.
  const windowStart = useMemo(() => {
    const d = new Date(nowMs);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }, [Math.floor(nowMs / 3_600_000)]); // eslint-disable-line react-hooks/exhaustive-deps
  const windowEnd = windowStart + WINDOW_HOURS * 3_600_000;
  const timelineW = WINDOW_HOURS * 60 * PX_PER_MIN;

  const scrollRef = useRef<HTMLDivElement>(null);
  // Scroll so the now-line is ~1/4 in from the left on first mount / hour roll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nowX = ((nowMs - windowStart) / 60_000) * PX_PER_MIN;
    el.scrollLeft = Math.max(0, nowX - el.clientWidth * 0.25);
    // Only re-center when the window resets (hour roll), not every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStart]);

  // Clear the hover card on scroll — it's positioned at the block's rect at
  // hover time, so scrolling would otherwise strand it mid-viewport.
  useEffect(() => {
    if (!hover) return;
    const el = scrollRef.current;
    const clear = () => setHover(null);
    el?.addEventListener("scroll", clear, { passive: true });
    return () => el?.removeEventListener("scroll", clear);
  }, [hover]);

  // Infinite scroll: reveal the next page when the user nears the bottom.
  // `loadingMore` guards against a fast scroll firing several reveals before
  // the new rows mount; it's cleared once the rendered count changes (a page
  // landed), re-arming the next reveal. Only the vertical metric is read, so
  // horizontal timeline scrolling never trips it.
  const loadingMore = useRef(false);
  useEffect(() => { loadingMore.current = false; }, [channels.length]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !onReachEnd || !hasMore) return;
    const onScroll = () => {
      if (loadingMore.current) return;
      if (el.scrollHeight - (el.scrollTop + el.clientHeight) < ROW_H * 4) {
        loadingMore.current = true;
        onReachEnd();
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [onReachEnd, hasMore]);

  // Hour tick marks across the ruler. Stop BEFORE windowEnd — a tick at the
  // very right edge (x === timelineW) renders its label outside the timeline
  // box, where it shows as unstyled overflow text.
  const hours = useMemo(() => {
    const out: { x: number; label: string }[] = [];
    for (let t = windowStart; t < windowEnd; t += 3_600_000) {
      out.push({
        x: ((t - windowStart) / 60_000) * PX_PER_MIN,
        label: new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
      });
    }
    return out;
  }, [windowStart, windowEnd]);

  const nowX = ((nowMs - windowStart) / 60_000) * PX_PER_MIN;

  if (!hasEpg) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-3">
        {epgLoading ? (
          <>
            <span className="w-7 h-7 rounded-full border-2 border-white/15 border-t-ln-accent animate-spin" />
            <p className="text-white/45 text-sm">Loading the TV guide…</p>
          </>
        ) : (
          <p className="text-white/40 text-sm max-w-sm">
            No EPG loaded for this playlist. Add an EPG (XMLTV) URL to the playlist,
            or use an Xtream login (its guide is fetched automatically).
          </p>
        )}
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-auto relative"
      style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
    >
      <div style={{ width: CHANNEL_COL_W + timelineW, position: "relative" }}>
        {/* Sticky header: a LIVE-pill strip ABOVE the time ruler, so the pill
            never overlaps the hour labels or the top programme row. */}
        <div className="sticky top-0 z-20 bg-[rgba(12,12,16,0.96)] backdrop-blur-sm">
          {/* LIVE pill strip — pill sits flush to the strip's bottom, just
              above the ruler, with the now-line descending from its base. */}
          <div className="relative" style={{ height: LIVE_STRIP_H }}>
            {nowX >= 0 && nowX <= timelineW && (
              // Centred on the now-line, but its left position is clamped so
              // the pill's left edge can't cross under the channel column
              // (its half-width ≈ 18px). So it sits centred over the line
              // everywhere except the first few minutes after an hour rollover,
              // where it nudges right just enough to stay fully visible.
              <span
                className="absolute bottom-0 -translate-x-1/2 px-1.5 h-[16px] flex items-center rounded-full
                           bg-red-500 text-white text-[9px] font-bold tracking-wider leading-none"
                style={{ left: Math.max(CHANNEL_COL_W + 18, CHANNEL_COL_W + nowX) }}
              >
                LIVE
              </span>
            )}
          </div>
          {/* Time ruler */}
          <div className="flex border-b border-white/8" style={{ height: RULER_H }}>
            <div
              className="sticky left-0 z-[40] flex-shrink-0 bg-[rgba(12,12,16,0.96)] border-r border-white/8"
              style={{ width: CHANNEL_COL_W }}
            />
            <div className="relative flex-shrink-0" style={{ width: timelineW }}>
              {hours.map((h) => (
                <span
                  key={h.x}
                  className="absolute top-0 h-full flex items-center text-[11px] text-white/45 font-medium border-l border-white/8 pl-1.5"
                  style={{ left: h.x }}
                >
                  {h.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Now line — a thin red vertical line descending through the rows.
            z-10 keeps it ABOVE the programme blocks (z-auto) but BELOW the
            sticky header (z-20): the content-anchored line otherwise scrolls
            up behind the pinned header and, at a higher z, painted straight
            over the LIVE pill. Now the header's opaque background masks the
            line wherever they overlap, so the pill stays clean. */}
        {nowX >= 0 && nowX <= timelineW && (
          <span
            aria-hidden
            className="absolute bottom-0 w-px bg-red-500/85 z-10 pointer-events-none"
            style={{
              left: CHANNEL_COL_W + nowX,
              top: LIVE_STRIP_H,
              boxShadow: "0 0 6px rgba(239,68,68,0.55)",
            }}
          />
        )}

        {/* Channel rows */}
        {channels.map((ch) => (
          <GuideRow
            key={ch.id}
            channel={ch}
            sourceId={sourceId}
            sourceName={sourceName}
            favorited={isFavorite(sourceId, ch.id)}
            windowStart={windowStart}
            windowEnd={windowEnd}
            nowMs={nowMs}
            timelineW={timelineW}
            onPlay={() => onPlayChannel(ch)}
            onBlockHover={(p, el, live) =>
              setHover({ p, rect: el.getBoundingClientRect(), live })
            }
            onBlockLeave={() => setHover(null)}
          />
        ))}

        {/* Bottom sentinel — only while more channels remain. Reaching it (or
            near it) triggers the next page via the scroll listener above. */}
        {hasMore && (
          <div
            className="flex items-center justify-center gap-2 py-3 text-white/35 text-[11px] sticky left-0"
            style={{ width: CHANNEL_COL_W }}
          >
            <span className="w-3.5 h-3.5 rounded-full border-2 border-white/15 border-t-ln-accent animate-spin" />
            Loading more channels…
          </div>
        )}
      </div>

      <ProgramHoverCard hover={hover} />
    </div>
  );
}

const GuideRow = memo(function GuideRow({
  channel,
  sourceId,
  sourceName,
  favorited,
  windowStart,
  windowEnd,
  nowMs,
  timelineW,
  onPlay,
  onBlockHover,
  onBlockLeave,
}: {
  channel: IptvChannel;
  sourceId: string;
  sourceName: string;
  favorited: boolean;
  windowStart: number;
  windowEnd: number;
  nowMs: number;
  timelineW: number;
  onPlay: () => void;
  onBlockHover: (p: EpgProgram, el: HTMLElement, live: boolean) => void;
  onBlockLeave: () => void;
}) {
  // Programmes intersecting the window, with their pixel geometry.
  const blocks = useMemo(() => {
    const programs = channelPrograms(sourceId, channel) ?? [];
    const out: { p: EpgProgram; left: number; width: number; live: boolean }[] = [];
    for (const p of programs) {
      if (p.endMs <= windowStart || p.startMs >= windowEnd) continue;
      const left = Math.max(0, ((p.startMs - windowStart) / 60_000) * PX_PER_MIN);
      const right = Math.min(timelineW, ((p.endMs - windowStart) / 60_000) * PX_PER_MIN);
      const width = Math.max(2, right - left);
      out.push({ p, left, width, live: p.startMs <= nowMs && p.endMs > nowMs });
    }
    return out;
    // nowMs only flips `live`; bucket to the minute to avoid churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, channel, windowStart, windowEnd, timelineW, Math.floor(nowMs / 60_000)]);

  return (
    <div className="flex border-b border-white/[0.05]" style={{ height: ROW_H }}>
      {/* Sticky channel cell — play button + favourite star. */}
      <div
        className="group sticky left-0 z-[40] flex-shrink-0 relative
                   bg-[rgba(12,12,16,0.92)] border-r border-white/8"
        style={{ width: CHANNEL_COL_W }}
      >
        <button
          type="button"
          onClick={onPlay}
          onContextMenu={(e) =>
            openChannelMenu(e, { channel, sourceId, sourceName, onPlay })
          }
          title={channel.name}
          className="w-full h-full flex items-center gap-2 px-2.5 pr-7 text-left
                     hover:bg-white/[0.06] transition-colors"
        >
          {channel.logo ? (
            <img
              src={channel.logo}
              alt=""
              loading="lazy"
              className="w-8 h-8 object-contain flex-shrink-0"
              onError={(e) => { (e.currentTarget.style.visibility = "hidden"); }}
            />
          ) : (
            <span className="w-8 h-8 flex-shrink-0" />
          )}
          <span className="text-[12px] text-white/80 font-medium truncate">{channel.name}</span>
        </button>
        <button
          type="button"
          aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
          title={favorited ? "Remove from favorites" : "Add to favorites"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(sourceId, sourceName, channel);
          }}
          className={[
            "absolute top-1/2 -translate-y-1/2 right-1 w-6 h-6 rounded-md flex items-center justify-center transition-all",
            favorited
              ? "opacity-100 text-amber-300"
              : "opacity-0 group-hover:opacity-100 text-white/40 hover:text-amber-300",
          ].join(" ")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill={favorited ? "currentColor" : "none"}
               stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
            <path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.7 1.2 6.6L12 18.6 6.1 21.8l1.2-6.6L2.5 9.5l6.6-.9z" />
          </svg>
        </button>
      </div>

      {/* Timeline */}
      <div className="relative flex-shrink-0" style={{ width: timelineW }}>
        {blocks.map(({ p, left, width, live }) => (
          <button
            key={`${p.startMs}`}
            type="button"
            onClick={onPlay}
            onMouseEnter={(e) => onBlockHover(p, e.currentTarget, live)}
            onMouseLeave={onBlockLeave}
            className={[
              "absolute top-[3px] bottom-[3px] rounded-md px-2 overflow-hidden text-left transition-colors",
              live
                ? "bg-red-500/[0.14] border border-red-500/45 hover:bg-red-500/25"
                : "bg-white/[0.05] border border-white/8 hover:bg-white/[0.10]",
            ].join(" ")}
            style={{ left, width }}
          >
            <span className="block text-[11.5px] text-white/85 font-medium truncate leading-tight mt-0.5">
              {p.title}
            </span>
            <span
              className={[
                "block text-[10px] truncate leading-tight",
                live ? "text-red-300/90 font-semibold" : "text-white/40",
              ].join(" ")}
            >
              {live ? "● LIVE" : fmtTime(p.startMs)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
});

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtRange(a: number, b: number): string {
  return `${fmtTime(a)} – ${fmtTime(b)}`;
}
function fmtDur(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

// ---------------------------------------------------------------------------
// Programme hover card — Harbor-style floating detail popover. Portaled to
// <body> so it escapes the guide's scroll overflow; positioned at the hovered
// block's rect (flips above the block in the lower part of the screen).
// ---------------------------------------------------------------------------

interface HoverState {
  p: EpgProgram;
  rect: DOMRect;
  live: boolean;
}

const HOVER_CARD_W = 300;

function ProgramHoverCard({ hover }: { hover: HoverState | null }) {
  if (!hover) return null;
  const { p, rect, live } = hover;
  const margin = 10;
  let left = rect.left;
  if (left + HOVER_CARD_W > window.innerWidth - margin) {
    left = window.innerWidth - HOVER_CARD_W - margin;
  }
  left = Math.max(margin, left);
  // Below the block normally; flip to bottom-anchored above it in the lower
  // 45% of the screen (no card-height measurement needed).
  const flipUp = rect.bottom > window.innerHeight * 0.55;
  const pos: CSSProperties = flipUp
    ? { left, bottom: window.innerHeight - rect.top + 6 }
    : { left, top: rect.bottom + 6 };

  return createPortal(
    <div
      className="fixed z-[300] pointer-events-none rounded-xl border border-white/12
                 bg-[rgba(16,16,20,0.98)] backdrop-blur-2xl shadow-glass-edge p-3.5"
      style={{ width: HOVER_CARD_W, ...pos }}
    >
      {live && (
        <span className="inline-flex items-center gap-1.5 mb-1.5 px-2 h-[18px] rounded-full
                         bg-red-500/15 text-red-300/90 text-[10px] font-bold tracking-wider">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          LIVE
        </span>
      )}
      <p className="text-white/95 text-[13.5px] font-semibold leading-snug">{p.title}</p>
      <p className="text-white/45 text-[11.5px] mt-1 tabular-nums">
        {fmtRange(p.startMs, p.endMs)} · {fmtDur(p.endMs - p.startMs)}
      </p>
      {p.description && (
        <p className="text-white/65 text-[12px] leading-relaxed mt-2 line-clamp-6">
          {p.description}
        </p>
      )}
      {p.category && (
        <p className="text-white/35 text-[10.5px] mt-2 uppercase tracking-wide">{p.category}</p>
      )}
    </div>,
    document.body,
  );
}
