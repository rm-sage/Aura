// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MetaPreview } from "../types";
import {
  getHistory,
  removeHistoryEntry,
  clearHistory,
  onHistoryChange,
  type HistoryEntry,
} from "../historyStore";
import ImageLoader from "../ImageLoader";
import { shrinkPoster } from "../posterSize";
import ErrorBoundary from "../ErrorBoundary";
import { showAppToast } from "../AppToast";
import { typeLabel, isAnimeMeta } from "../aiometadata";

// Which scrobble services are connected for the active account. Drives
// whether each History row offers the "Scrobble to Trakt / AniList"
// actions. We never render an action for a service the user hasn't
// linked. Sourced from the same `get_scrobble_auth_status` command the
// Settings + notification surfaces use, so there is one source of truth
// for "connected".
interface ScrobbleConnState {
  scope: string;
  trakt: boolean;
  anilist: boolean;
}

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
  const [conn, setConn] = useState<ScrobbleConnState>({
    scope: "guest", trakt: false, anilist: false,
  });

  useEffect(() => {
    const sync = () => setEntries(getHistory());
    return onHistoryChange(sync);
  }, []);

  // Resolve the active scope + which scrobble services are connected.
  // Re-runs when the account changes (aura:session-changed) or a token
  // is (dis)connected in Settings (aura:scrobble-auth-changed) so the
  // per-row actions appear / disappear without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let scope = "guest";
      try {
        const sess = await invoke<{ auth_key?: string } | null>("get_session");
        scope = sess?.auth_key ? sess.auth_key.slice(0, 12) : "guest";
      } catch {
        scope = "guest";
      }
      if (cancelled) return;
      try {
        const status = await invoke<{ trakt: unknown | null; anilist: unknown | null }>(
          "get_scrobble_auth_status", { scope },
        );
        if (cancelled) return;
        setConn({ scope, trakt: status.trakt != null, anilist: status.anilist != null });
      } catch {
        if (!cancelled) setConn({ scope, trakt: false, anilist: false });
      }
    };
    void load();
    window.addEventListener("aura:session-changed", load);
    window.addEventListener("aura:scrobble-auth-changed", load);
    return () => {
      cancelled = true;
      window.removeEventListener("aura:session-changed", load);
      window.removeEventListener("aura:scrobble-auth-changed", load);
    };
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
                conn={conn}
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
  dateKey, entries, onSelectMeta, conn,
}: {
  dateKey: string;
  entries: HistoryEntry[];
  onSelectMeta?: (meta: MetaPreview) => void;
  conn: ScrobbleConnState;
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
            conn={conn}
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
  entry, onSelectMeta, conn,
}: {
  entry: HistoryEntry;
  onSelectMeta?: (meta: MetaPreview) => void;
  conn: ScrobbleConnState;
}) {
  // null = idle; otherwise the service whose push is in flight. Blocks
  // both buttons while either is running so a double-click can't fire two
  // overlapping writes for the same row.
  const [busy, setBusy] = useState<"trakt" | "anilist" | null>(null);

  // AniList is anime-only. isAnimeMeta reads id-prefix + the localStorage
  // anime cache (populated by DetailView) + media_type: the same detector
  // the rest of the app uses; we do not invent a new signal here. Use the
  // series root id when present so an episode id resolves against the show.
  const isAnime = isAnimeMeta({
    media_type: entry.media_type,
    id: entry.parent_id ?? entry.id,
    genres: [],
  });

  const scrobble = async (service: "trakt" | "anilist") => {
    if (busy) return;
    setBusy(service);
    try {
      const command = service === "trakt"
        ? "scrobble_history_trakt"
        : "scrobble_history_anilist";
      // Tauri maps these camelCase keys onto the Rust command's
      // snake_case params (parent_id, media_type, played_at, ...).
      const message = await invoke<string>(command, {
        id:        entry.id,
        parentId:  entry.parent_id ?? null,
        mediaType: entry.media_type,
        season:    entry.season ?? null,
        episode:   entry.episode ?? null,
        name:      entry.name,
        scope:     conn.scope,
        playedAt:  entry.played_at,
      });
      showAppToast(message, { tone: "success" });
    } catch (err) {
      showAppToast(String(err), { tone: "danger", duration: 6000 });
    } finally {
      setBusy(null);
    }
  };

  const showTrakt = conn.trakt;
  const showAnilist = conn.anilist && isAnime;

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
              src={shrinkPoster(entry.poster)}
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

      {/* Hover-revealed scrobble actions. Each service is only offered
          when the account has it connected (AniList additionally gated to
          anime). Explicit click only; nothing fires on hover. */}
      {(showTrakt || showAnilist) && (
        <div
          className="absolute bottom-0 inset-x-0 flex items-center justify-end gap-1.5
                     px-2 py-1.5 bg-gradient-to-t from-black/80 to-transparent
                     opacity-0 group-hover:opacity-100 focus-within:opacity-100
                     transition-opacity duration-150 z-10"
          onClick={(e) => e.stopPropagation()}
        >
          {showTrakt && (
            <ScrobbleButton
              label="Trakt"
              busy={busy === "trakt"}
              disabled={busy !== null}
              onClick={() => scrobble("trakt")}
            />
          )}
          {showAnilist && (
            <ScrobbleButton
              label="AniList"
              busy={busy === "anilist"}
              disabled={busy !== null}
              onClick={() => scrobble("anilist")}
            />
          )}
        </div>
      )}

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
// Scrobble action pill, shared by the Trakt / AniList buttons on a card.
// Shows a spinner while its push is in flight; disabled while EITHER
// service on the row is running.
// ---------------------------------------------------------------------------

function ScrobbleButton({
  label, busy, disabled, onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={`Scrobble to ${label}`}
      aria-label={`Scrobble to ${label}`}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      className="inline-flex items-center gap-1 px-2 py-1 rounded-full
                 text-[10.5px] font-medium leading-none
                 bg-white/10 text-white/85 border border-white/20
                 hover:bg-ln-accent/25 hover:text-white hover:border-ln-accent/50
                 disabled:opacity-50 disabled:cursor-default
                 backdrop-blur-md transition-colors"
    >
      {busy && (
        <svg
          width="10" height="10" viewBox="0 0 24 24"
          className="animate-spin" aria-hidden
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"
                  strokeWidth="3" strokeLinecap="round" strokeDasharray="42 14" opacity="0.9" />
        </svg>
      )}
      {label}
    </button>
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
