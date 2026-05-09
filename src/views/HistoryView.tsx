// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import type { MetaPreview } from "../types";
import {
  getHistory,
  removeHistoryEntry,
  clearHistory,
  onHistoryChange,
  type HistoryEntry,
} from "../historyStore";
import ImageLoader from "../ImageLoader";
import ErrorBoundary from "../ErrorBoundary";
import { showAppToast } from "../AppToast";
import { typeLabel } from "../aiometadata";

// ---------------------------------------------------------------------------
// HistoryView — Trakt-style detailed feed of recent automatic plays.
//
// Source: localStorage `aura:history:<scope>` populated at exit-playback
// when the user actually watched (≥85 % of duration OR ≥5 min). Entries
// from manual mark-as-watched are excluded by contract (see App.tsx
// handleExitPlayback's history-append branch).
//
// Layout: grouped by day (Today / Yesterday / "Friday May 1, 2026") with
// a running total runtime per day in the header and one row per entry.
// Each row has a hover X to remove the single entry.
// ---------------------------------------------------------------------------

interface Props {
  onSelectMeta?: (meta: MetaPreview) => void;
}

export default function HistoryView(props: Props) {
  return (
    <ErrorBoundary scope="History">
      <HistoryViewBody {...props} />
    </ErrorBoundary>
  );
}

function HistoryViewBody({ onSelectMeta }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => getHistory());

  useEffect(() => {
    const sync = () => setEntries(getHistory());
    return onHistoryChange(sync);
  }, []);

  // Group entries by calendar day in the user's local timezone. Entry
  // order is already newest-first from the store, so each day's
  // entries fall naturally in reverse-chrono order within the group.
  const grouped = useMemo(() => {
    const days = new Map<string, HistoryEntry[]>();
    for (const e of entries) {
      const d = new Date(e.played_at);
      if (Number.isNaN(d.getTime())) continue;
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const list = days.get(key) ?? [];
      list.push(e);
      days.set(key, list);
    }
    return [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  }, [entries]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-[1100px] mx-auto px-6 py-6 space-y-7">
          <div className="flex items-end justify-between gap-4 flex-wrap">
            <div>
              <h1 className="aura-row-title text-3xl font-semibold tracking-tight">History</h1>
              <p className="text-white/35 text-sm mt-1">
                {entries.length === 0
                  ? "Your watch history is empty. Items you finish playing show up here automatically."
                  : `${entries.length} item${entries.length === 1 ? "" : "s"} from automatic playback.`}
              </p>
            </div>
            {entries.length > 0 && (
              <button
                onClick={() => {
                  if (confirm(`Clear all ${entries.length} history entries? This can't be undone.`)) {
                    clearHistory();
                    showAppToast("History cleared");
                  }
                }}
                className="px-3.5 py-1.5 rounded-full text-xs font-medium
                           bg-white/5 text-white/60 border border-white/10
                           hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-300/40
                           transition-colors"
              >
                Clear All
              </button>
            )}
          </div>

          {entries.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                Watch something to start a history. Only auto-tracked plays
                appear here; manual mark-as-watched entries don't.
              </p>
            </div>
          ) : (
            grouped.map(([key, dayEntries]) => (
              <DayGroup
                key={key}
                dateKey={key}
                entries={dayEntries}
                onSelectMeta={onSelectMeta}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Day grouping — header line + running total + entry rows.
// ---------------------------------------------------------------------------

function DayGroup({
  dateKey, entries, onSelectMeta,
}: {
  dateKey: string;
  entries: HistoryEntry[];
  onSelectMeta?: (meta: MetaPreview) => void;
}) {
  const totalSecs = useMemo(
    () => entries.reduce((s, e) => s + (e.watched_seconds ?? 0), 0),
    [entries],
  );

  return (
    <section className="space-y-3">
      <header className="flex items-center justify-between gap-3 border-b border-white/8 pb-2">
        <div className="flex items-baseline gap-3">
          <ClockIcon />
          <h2 className="text-white/85 text-lg font-semibold">
            {prettyDay(dateKey)}
          </h2>
          <span className="text-white/35 text-xs font-mono">
            {entries.length} {entries.length === 1 ? "play" : "plays"}
          </span>
        </div>
        {totalSecs > 0 && (
          <p className="text-white/35 text-xs font-mono tabular-nums">
            {formatDuration(totalSecs)}
          </p>
        )}
      </header>

      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {entries.map((entry) => (
          <HistoryCard
            key={`${entry.id}::${entry.played_at}`}
            entry={entry}
            onSelectMeta={onSelectMeta}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Single entry row.
// ---------------------------------------------------------------------------

function HistoryCard({
  entry, onSelectMeta,
}: {
  entry: HistoryEntry;
  onSelectMeta?: (meta: MetaPreview) => void;
}) {
  const epLabel = entry.season != null && entry.episode != null
    ? `S${String(entry.season).padStart(2, "0")}E${String(entry.episode).padStart(2, "0")}`
    : entry.episode != null
      ? `EP${String(entry.episode).padStart(2, "0")}`
      : null;

  const meta: MetaPreview = {
    id:           entry.parent_id ?? entry.id,
    name:         entry.name,
    media_type:   entry.media_type,
    poster:       entry.poster ?? null,
    background:   entry.background ?? null,
    fanart:       null,
    backdrop:     null,
    logo:         null,
    release_info: null,
    description:  null,
    imdb_rating:  null,
    genres:       [],
  };

  return (
    <div
      className="group relative card-contain rounded-xl overflow-hidden
                 bg-white/4 border border-white/8 cursor-pointer
                 hover:border-white/20 transition-colors"
      onClick={() => onSelectMeta?.(meta)}
    >
      <div className="flex items-stretch gap-3 p-2">
        {/* Poster thumb — small portrait so the card stays compact. */}
        <div
          className="relative flex-shrink-0 w-[68px] rounded-md overflow-hidden bg-white/5 border border-white/10"
          style={{ aspectRatio: "2 / 3" }}
        >
          {entry.poster ? (
            <ImageLoader
              src={entry.poster}
              alt={entry.name}
              className="absolute inset-0 w-full h-full"
              imgClassName="w-full h-full object-cover"
            />
          ) : null}
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5">
          <p className="text-white/90 text-[14px] font-medium leading-tight line-clamp-2">
            {entry.name}
          </p>
          {epLabel && (
            <p className="text-white/55 text-[11px] font-mono tracking-wider">
              {epLabel}
              {entry.episode_title ? ` · ${entry.episode_title}` : ""}
            </p>
          )}
          <p className="text-white/35 text-[10.5px] mt-0.5 font-mono tabular-nums">
            {formatTime(entry.played_at)} · {typeLabel(entry.media_type ?? "other")}
          </p>
        </div>
      </div>

      {/* Hover X — removes ONLY this entry (id, played_at). */}
      <button
        type="button"
        aria-label="Remove from history"
        title="Remove from history"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          removeHistoryEntry(entry.id, entry.played_at);
          showAppToast("Removed from history");
        }}
        className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full
                   bg-black/70 backdrop-blur-md border border-white/20
                   text-white/85 hover:text-white hover:bg-rose-500/40
                   hover:border-rose-300/50
                   flex items-center justify-center
                   opacity-0 group-hover:opacity-100 focus:opacity-100
                   transition-all duration-150 z-10"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function prettyDay(key: string): string {
  // key is YYYY-MM-DD in local time.
  const [yStr, mStr, dStr] = key.split("-");
  const d = new Date(Number(yStr), Number(mStr) - 1, Number(dStr));
  if (Number.isNaN(d.getTime())) return key;
  const today = new Date();
  const yest  = new Date();
  yest.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth() &&
    a.getDate()     === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yest))  return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function formatDuration(secs: number): string {
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const ClockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
       className="text-ln-accent/75" aria-hidden>
    <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
  </svg>
);
