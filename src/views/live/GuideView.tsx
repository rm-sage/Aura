// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useMemo, useRef, useEffect } from "react";
import { channelPrograms } from "../../iptv/epgStore";
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

const CHANNEL_COL_W = 168; // px — sticky left column
const ROW_H = 44; // px
const PX_PER_MIN = 5; // 300 px / hour
const WINDOW_HOURS = 8; // visible/scrollable span forward from the hour

interface Props {
  channels: IptvChannel[];
  sourceId: string;
  nowMs: number;
  hasEpg: boolean;
  onPlayChannel: (channel: IptvChannel) => void;
}

export default function GuideView({ channels, sourceId, nowMs, hasEpg, onPlayChannel }: Props) {
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

  // Hour tick marks across the ruler.
  const hours = useMemo(() => {
    const out: { x: number; label: string }[] = [];
    for (let t = windowStart; t <= windowEnd; t += 3_600_000) {
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
      <div className="flex-1 flex items-center justify-center text-center px-6">
        <p className="text-white/40 text-sm max-w-sm">
          No EPG loaded for this playlist. Add an EPG (XMLTV) URL to the playlist,
          or use an Xtream login (its guide is fetched automatically).
        </p>
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
        {/* Time ruler (sticky top) */}
        <div
          className="sticky top-0 z-20 flex bg-[rgba(12,12,16,0.96)] backdrop-blur-sm border-b border-white/8"
          style={{ height: 30 }}
        >
          <div
            className="sticky left-0 z-10 flex-shrink-0 bg-[rgba(12,12,16,0.96)] border-r border-white/8"
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

        {/* Now line — spans all rows, over the timeline only. */}
        {nowX >= 0 && nowX <= timelineW && (
          <span
            aria-hidden
            className="absolute top-0 bottom-0 w-px bg-ln-accent/70 z-10 pointer-events-none"
            style={{ left: CHANNEL_COL_W + nowX }}
          />
        )}

        {/* Channel rows */}
        {channels.map((ch) => (
          <GuideRow
            key={ch.id}
            channel={ch}
            sourceId={sourceId}
            windowStart={windowStart}
            windowEnd={windowEnd}
            nowMs={nowMs}
            timelineW={timelineW}
            onPlay={() => onPlayChannel(ch)}
          />
        ))}
      </div>
    </div>
  );
}

const GuideRow = memo(function GuideRow({
  channel,
  sourceId,
  windowStart,
  windowEnd,
  nowMs,
  timelineW,
  onPlay,
}: {
  channel: IptvChannel;
  sourceId: string;
  windowStart: number;
  windowEnd: number;
  nowMs: number;
  timelineW: number;
  onPlay: () => void;
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
      {/* Sticky channel cell — also the play button. */}
      <button
        type="button"
        onClick={onPlay}
        title={channel.name}
        className="sticky left-0 z-[5] flex-shrink-0 flex items-center gap-2 px-2.5
                   bg-[rgba(12,12,16,0.92)] border-r border-white/8 text-left
                   hover:bg-white/[0.06] transition-colors"
        style={{ width: CHANNEL_COL_W }}
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

      {/* Timeline */}
      <div className="relative flex-shrink-0" style={{ width: timelineW }}>
        {blocks.map(({ p, left, width, live }) => (
          <button
            key={`${p.startMs}`}
            type="button"
            onClick={onPlay}
            title={`${p.title}\n${fmtRange(p.startMs, p.endMs)}${p.description ? "\n\n" + p.description : ""}`}
            className={[
              "absolute top-[3px] bottom-[3px] rounded-md px-2 overflow-hidden text-left transition-colors",
              live
                ? "bg-ln-accent/15 border border-ln-accent/30 hover:bg-ln-accent/25"
                : "bg-white/[0.05] border border-white/8 hover:bg-white/[0.10]",
            ].join(" ")}
            style={{ left, width }}
          >
            <span className="block text-[11.5px] text-white/85 font-medium truncate leading-tight mt-0.5">
              {p.title}
            </span>
            <span className="block text-[10px] text-white/40 truncate leading-tight">
              {fmtTime(p.startMs)}
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
