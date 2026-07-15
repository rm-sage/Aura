// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MetaPreview } from "../types";
import {
  getHistory,
  removeHistoryEntry,
  removeHistoryEntries,
  clearHistory,
  onHistoryChange,
  type HistoryEntry,
} from "../historyStore";
import {
  isIneligible,
  isScrobbled,
  markIneligible,
  markScrobbled,
  onScrobbledChange,
  type ScrobbleService,
} from "../scrobbledStore";
import {
  cleanFailureMessage,
  isPermanentFailure,
  startScrobbleRun,
  useScrobbleRun,
  type ScrobbleWorkItem,
} from "../scrobbleRun";
import ImageLoader from "../ImageLoader";
import { shrinkPoster } from "../posterSize";
import ErrorBoundary from "../ErrorBoundary";
import { showAppToast } from "../AppToast";
import { useConfirm } from "../ConfirmDialog";
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
//
// SCROBBLING — three ways in, all funnelling through the SAME two Tauri
// commands (`scrobble_history_trakt` / `scrobble_history_anilist`) so every
// path inherits their gates identically:
//   1. per-row Trakt / AniList buttons (hover),
//   2. a multi-selection (per-row checkbox, or a whole day via the day header),
//   3. "Scrobble All" over the entire history.
// See `runScrobble` for how duplicates are prevented.
// ---------------------------------------------------------------------------

/** Selection / dedup primary key for one play. Mirrors the history store's own
 *  (id, played_at) key, so a re-watch is a distinct row. */
const keyOf = (e: HistoryEntry) => `${e.id}::${e.played_at}`;

/** Which services this entry can actually be pushed to, given what the account
 *  has connected. AniList is anime-only: `isAnimeMeta` reads id-prefix + the
 *  localStorage anime cache + media_type, the same detector the rest of the app
 *  uses — we do not invent a new signal here. The series root id is used when
 *  present so an episode id resolves against the show. */
function servicesFor(entry: HistoryEntry, conn: ScrobbleConnState): ScrobbleService[] {
  const out: ScrobbleService[] = [];
  if (conn.trakt) out.push("trakt");
  const isAnime = isAnimeMeta({
    media_type: entry.media_type,
    id: entry.parent_id ?? entry.id,
    genres: [],
  });
  if (conn.anilist && isAnime) out.push("anilist");
  return out;
}

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
  /** Selected (id::played_at) keys. Empty = not in selection mode. */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Bumped on any scrobbledStore write. Threaded down to the rows purely to
   *  invalidate their memo, so the "already scrobbled" tick refreshes without
   *  every row having to subscribe to the store itself. */
  const [scrobbledVersion, setScrobbledVersion] = useState(0);

  // The bulk job lives at module scope (see scrobbleRun.ts), so it survives this
  // view unmounting when the user navigates away. We only READ it here; the
  // progress bar itself is rendered globally from App.
  const run = useScrobbleRun();
  const busy = run.running;

  // Aura's own centred confirm modal, in place of the native WebView2 dialog.
  const { ask, dialog } = useConfirm();

  useEffect(() => {
    const sync = () => setEntries(getHistory());
    return onHistoryChange(sync);
  }, []);

  useEffect(
    () => onScrobbledChange(() => setScrobbledVersion((v) => v + 1)),
    [],
  );

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

  // Drop selections whose entries no longer exist (removed here or by a sync).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map(keyOf));
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

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

  const anyService = conn.trakt || conn.anilist;
  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(keyOf(e))),
    [entries, selected],
  );

  // -------------------------------------------------------------------------
  // The one bulk-scrobble runner. Every bulk entry point (Scrobble All, or the
  // selection bar) calls THIS, so they cannot drift apart.
  //
  // DUPLICATE PROTECTION, in layers:
  //   1. We skip any (entry, service) already recorded in scrobbledStore, so a
  //      re-run does not even make the call.
  //   2. The commands themselves are the real gate, and are the SAME ones the
  //      per-row buttons use: Trakt's /sync/history is idempotent on the
  //      `watched_at` we send (the entry's exact played_at), and AniList's
  //      save_progress no-ops with AlreadyAhead when it is already past this
  //      episode. So even a stale/absent local record cannot produce a dupe.
  //   3. AniList is only ever offered for anime, and each service only when the
  //      account has it connected (`servicesFor`).
  //
  // The job itself (pacing, retry/backoff, cancellation, the single-job lock)
  // lives in scrobbleRun.ts so it can outlive this view. This function only
  // decides WHAT to push and asks the user.
  // -------------------------------------------------------------------------
  const runScrobble = useCallback(
    async (list: HistoryEntry[], what: string) => {
      if (busy) return;
      if (!anyService) {
        showAppToast("Connect Trakt or AniList in Settings > Scrobbling first.", { tone: "danger" });
        return;
      }

      // Everything eligible and not already done, split by service.
      const traktWork: ScrobbleWorkItem[] = [];
      const anilistPending: HistoryEntry[] = [];
      const items = new Set<string>();
      let alreadyDone = 0;
      let retired = 0;
      for (const entry of list) {
        for (const service of servicesFor(entry, conn)) {
          if (isScrobbled(conn.scope, service, entry.id, entry.played_at)) {
            alreadyDone++;
            continue;
          }
          // The service has already told us, definitively, that it cannot take this
          // item (Trakt has no catalog entry for it; AniList cannot resolve it).
          // Sending it again would fail identically and re-report the same error.
          if (isIneligible(conn.scope, service, entry.id)) {
            retired++;
            continue;
          }
          items.add(keyOf(entry));
          if (service === "trakt") traktWork.push({ entry, service });
          else anilistPending.push(entry);
        }
      }

      // COLLAPSE THE ANILIST SIDE. AniList keeps ONE progress number per entry, so
      // only the highest episode of a given (series, season) actually writes
      // anything -- every lower episode resolves, discovers progress is already
      // ahead, and skips. Those no-ops still cost a GraphQL round trip each, and
      // they are what exhausts AniList's ~90/min budget on a big run. Push only
      // the season's highest episode and mark the rest as covered by it: identical
      // end state (progress + backdated completedAt), a fraction of the calls.
      //
      // Movies, and rows with no episode number, have nothing to collapse against
      // and each stand alone.
      const anilistWork: ScrobbleWorkItem[] = [];
      const bySeason = new Map<string, HistoryEntry[]>();
      for (const e of anilistPending) {
        if (e.episode == null) {
          anilistWork.push({ entry: e, service: "anilist" });
          continue;
        }
        const key = `${e.parent_id ?? e.id}::${e.season ?? 0}`;
        const bucket = bySeason.get(key) ?? [];
        bucket.push(e);
        bySeason.set(key, bucket);
      }
      for (const bucket of bySeason.values()) {
        // Highest episode wins; its played_at is the season's completion date,
        // which is exactly what AniList's day-precision completedAt wants.
        bucket.sort((a, b) => (b.episode ?? 0) - (a.episode ?? 0));
        const [highest, ...covered] = bucket;
        anilistWork.push({
          entry: highest,
          service: "anilist",
          covers: covered.map((c) => ({ id: c.id, playedAt: c.played_at })),
        });
      }

      const anilistCollapsed = anilistPending.length - anilistWork.length;
      const work: ScrobbleWorkItem[] = [...traktWork, ...anilistWork];

      if (work.length === 0) {
        const why =
          alreadyDone > 0
            ? `Nothing to do — all ${alreadyDone} eligible push${alreadyDone === 1 ? "" : "es"} in ${what} are already scrobbled.`
            : `Nothing in ${what} is eligible (AniList only takes anime; Trakt needs an IMDb id).`;
        showAppToast(
          retired > 0
            ? `${why} ${retired} item${retired === 1 ? " was" : "s were"} refused by the service and won't be retried.`
            : why,
        );
        return;
      }

      // ITEMS vs PUSHES. One item can produce TWO pushes: every eligible row goes
      // to Trakt, and the anime subset ALSO goes to AniList. So "118 items" and
      // "217 pushes" are both true of the same run, and the dialog has to say so
      // outright -- quoting only the push count next to a header that counts
      // items reads like a bug.
      const legs: string[] = [];
      if (traktWork.length > 0) legs.push(`${traktWork.length} to Trakt`);
      if (anilistWork.length > 0) legs.push(`${anilistWork.length} to AniList`);
      const n = items.size;
      const detail =
        `${work.length} push${work.length === 1 ? "" : "es"} in total: ${legs.join(", ")}.` +
        (anilistCollapsed > 0
          ? ` AniList tracks one progress number per season, so ${anilistCollapsed} lower episode${anilistCollapsed === 1 ? " is" : "s are"} covered by the highest one rather than sent separately.`
          : "") +
        (alreadyDone > 0
          ? ` ${alreadyDone} already-scrobbled push${alreadyDone === 1 ? "" : "es"} will be skipped.`
          : "") +
        (retired > 0
          ? ` ${retired} item${retired === 1 ? "" : "s"} the service has already refused (no catalog match) ${retired === 1 ? "is" : "are"} skipped too.`
          : "");

      const confirmed = await ask({
        title: "Scrobble history",
        message: `Scrobble ${n} item${n === 1 ? "" : "s"} from ${what}?`,
        detail,
        confirmLabel: "Scrobble",
        tone: "accent",
      });
      if (!confirmed) return;

      // Hand off to the module-level runner. It owns pacing, retry/backoff, the
      // scrobbled-marking, and the single-job lock; it keeps going if the user
      // navigates away, and the progress bar for it is rendered from App.
      const summary = await startScrobbleRun(conn.scope, work, what);
      if (!summary) return; // a job was already running

      const parts: string[] = [`${summary.ok} scrobbled`];
      if (summary.failed > 0) parts.push(`${summary.failed} failed`);
      if (alreadyDone > 0) parts.push(`${alreadyDone} already done`);
      if (summary.cancelled) parts.push("cancelled");
      showAppToast(
        parts.join(" · ") + (summary.firstError ? ` — ${summary.firstError}` : ""),
        {
          tone: summary.failed > 0 ? "danger" : "success",
          duration: summary.failed > 0 ? 8000 : 4500,
        },
      );
    },
    [anyService, conn, ask, busy],
  );

  const toggleEntry = useCallback((entry: HistoryEntry) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(entry);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }, []);

  /** Select (or, if the whole day is already selected, deselect) every play on
   *  a given date — the "select everything played on a date" affordance. */
  const toggleDay = useCallback((dayEntries: HistoryEntry[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = dayEntries.every((e) => next.has(keyOf(e)));
      for (const e of dayEntries) {
        if (allOn) next.delete(keyOf(e));
        else next.add(keyOf(e));
      }
      return next;
    });
  }, []);

  const removeSelected = useCallback(async () => {
    if (selectedEntries.length === 0) return;
    const n = selectedEntries.length;
    const confirmed = await ask({
      title: "Remove from history",
      message: `Remove ${n} selected item${n === 1 ? "" : "s"} from your history?`,
      detail: "This only clears Aura's local history. Anything already scrobbled stays on Trakt / AniList.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    // ONE write + ONE change event for the whole selection.
    removeHistoryEntries(selectedEntries.map((e) => ({ id: e.id, playedAt: e.played_at })));
    setSelected(new Set());
    showAppToast(`Removed ${n} item${n === 1 ? "" : "s"} from history`);
  }, [selectedEntries, ask]);

  const clearAll = useCallback(async () => {
    const n = entries.length;
    const confirmed = await ask({
      title: "Clear history",
      message: `Clear all ${n} history entr${n === 1 ? "y" : "ies"}?`,
      detail: "This can't be undone. It only clears Aura's local history — anything already scrobbled stays on Trakt / AniList.",
      confirmLabel: "Clear All",
      tone: "danger",
    });
    if (!confirmed) return;
    clearHistory();
    setSelected(new Set());
    showAppToast("History cleared");
  }, [entries.length, ask]);

  const selectionActive = selected.size > 0;

  return (
    <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
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
              <div className="flex items-center gap-2">
                {anyService && (
                  <button
                    disabled={busy}
                    onClick={() => void runScrobble(entries, "your entire history")}
                    className="px-3.5 py-1.5 rounded-full text-xs font-medium
                               bg-ln-accent/15 text-ln-accent border border-ln-accent/35
                               hover:bg-ln-accent/25 hover:text-white
                               disabled:opacity-40 disabled:cursor-default
                               transition-colors"
                  >
                    Scrobble All
                  </button>
                )}
                <button
                  disabled={busy}
                  onClick={() => void clearAll()}
                  className="px-3.5 py-1.5 rounded-full text-xs font-medium
                             bg-white/5 text-white/60 border border-white/10
                             hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-300/40
                             disabled:opacity-40 disabled:cursor-default
                             transition-colors"
                >
                  Clear All
                </button>
              </div>
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
                selected={selected}
                selectionActive={selectionActive}
                onToggleEntry={toggleEntry}
                onToggleDay={toggleDay}
                scrobbledVersion={scrobbledVersion}
                runActive={busy}
              />
            ))
          )}

          {/* Bottom padding so the floating action bar never covers the last row. */}
          {(selectionActive || busy) && <div className="h-16" aria-hidden />}
        </div>
      </div>

      {/* Multi-selection actions. There is no progress variant here any more: the
          run's bar is rendered globally from App (ScrobbleRunBar) so it survives
          navigating away from this page. While a run is in flight the Scrobble
          action goes inert, so a second job can never be stacked on the first. */}
      {selectionActive && (
        <ActionBar raised={busy}>
          <span className="text-white/85 text-xs font-medium">
            {selected.size} selected
          </span>
          {anyService && (
            <BarButton
              tone="accent"
              disabled={busy}
              onClick={() => void runScrobble(selectedEntries, `${selected.size} selected item${selected.size === 1 ? "" : "s"}`)}
            >
              Scrobble
            </BarButton>
          )}
          <BarButton tone="danger" disabled={busy} onClick={() => void removeSelected()}>
            Remove
          </BarButton>
          <BarButton onClick={() => setSelected(new Set())}>Clear</BarButton>
        </ActionBar>
      )}

      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating bar shell + its buttons.
// ---------------------------------------------------------------------------

/** `raised` lifts the bar clear of the globally-rendered ScrobbleRunBar, which
 *  occupies the same bottom-centre slot while a bulk job is in flight. */
function ActionBar({ children, raised = false }: { children: React.ReactNode; raised?: boolean }) {
  return (
    <div className={`absolute left-1/2 -translate-x-1/2 z-30
                     flex items-center gap-3 px-4 py-2.5 rounded-full
                     bg-black/80 backdrop-blur-xl border border-white/15
                     shadow-2xl shadow-black/50 transition-[bottom] duration-200
                     ${raised ? "bottom-[4.75rem]" : "bottom-5"}`}>
      {children}
    </div>
  );
}

function BarButton({
  children, onClick, tone = "plain", disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: "plain" | "accent" | "danger";
  disabled?: boolean;
}) {
  const toneCls =
    tone === "accent"
      ? "bg-ln-accent/20 text-ln-accent border-ln-accent/40 hover:bg-ln-accent/30 hover:text-white"
      : tone === "danger"
        ? "bg-white/5 text-white/70 border-white/15 hover:bg-rose-500/20 hover:text-rose-200 hover:border-rose-300/40"
        : "bg-white/5 text-white/70 border-white/15 hover:bg-white/12 hover:text-white";
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors
                  disabled:opacity-40 disabled:cursor-default ${toneCls}`}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Selection checkbox — shared by the day header and each card.
// ---------------------------------------------------------------------------

function SelectBox({
  checked, indeterminate = false, onToggle, label, className = "",
}: {
  checked: boolean;
  indeterminate?: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  const on = checked || indeterminate;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
      className={`w-[18px] h-[18px] rounded-[5px] flex-shrink-0
                  flex items-center justify-center border transition-colors
                  ${on
                    ? "bg-ln-accent border-ln-accent text-black"
                    : "bg-black/60 border-white/35 text-transparent hover:border-white/70"}
                  ${className}`}
    >
      {indeterminate ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <rect x="5" y="10.5" width="14" height="3" rx="1.5" />
        </svg>
      ) : checked ? (
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Day grouping — header line + running total + entry rows.
// ---------------------------------------------------------------------------

/** Memoised: a bulk run ticks `progress` on every push, and without this the
 *  whole grid would re-render hundreds of times mid-run. None of these props
 *  change per tick, so the rows stay put. */
const DayGroup = memo(function DayGroup({
  dateKey, entries, onSelectMeta, conn, selected, selectionActive, onToggleEntry, onToggleDay, scrobbledVersion, runActive,
}: {
  dateKey: string;
  entries: HistoryEntry[];
  onSelectMeta?: (meta: MetaPreview) => void;
  conn: ScrobbleConnState;
  selected: Set<string>;
  selectionActive: boolean;
  onToggleEntry: (e: HistoryEntry) => void;
  onToggleDay: (entries: HistoryEntry[]) => void;
  scrobbledVersion: number;
  /** A bulk job is in flight — every per-row scrobble button goes inert so a
   *  single-row push cannot race the run that is already pushing that row. */
  runActive: boolean;
}) {
  const totalSecs = useMemo(
    () => entries.reduce((s, e) => s + (e.watched_seconds ?? 0), 0),
    [entries],
  );

  const selectedInDay = entries.filter((e) => selected.has(keyOf(e))).length;
  const allSelected = selectedInDay === entries.length && entries.length > 0;
  const someSelected = selectedInDay > 0 && !allSelected;

  return (
    <section className="space-y-3">
      <header className="group/day flex items-center justify-between gap-3 border-b border-white/8 pb-2">
        <div className="flex items-center gap-3">
          {/* Select every play on this date. Hidden until hover unless the day
              already has a selection, so the header stays clean at rest. */}
          <div className={`transition-opacity ${allSelected || someSelected ? "opacity-100" : "opacity-0 group-hover/day:opacity-100 focus-within:opacity-100"}`}>
            <SelectBox
              checked={allSelected}
              indeterminate={someSelected}
              onToggle={() => onToggleDay(entries)}
              label={`Select all ${entries.length} plays on ${prettyDay(dateKey)}`}
            />
          </div>
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
            key={keyOf(entry)}
            entry={entry}
            onSelectMeta={onSelectMeta}
            conn={conn}
            isSelected={selected.has(keyOf(entry))}
            selectionActive={selectionActive}
            onToggleSelect={onToggleEntry}
            scrobbledVersion={scrobbledVersion}
            runActive={runActive}
          />
        ))}
      </div>
    </section>
  );
});

// ---------------------------------------------------------------------------
// Single entry card.
// ---------------------------------------------------------------------------

const HistoryCard = memo(function HistoryCard({
  entry, onSelectMeta, conn, isSelected, selectionActive, onToggleSelect, scrobbledVersion, runActive,
}: {
  entry: HistoryEntry;
  onSelectMeta?: (meta: MetaPreview) => void;
  conn: ScrobbleConnState;
  isSelected: boolean;
  selectionActive: boolean;
  onToggleSelect: (e: HistoryEntry) => void;
  /** Only here to invalidate the memo when the scrobbled record changes; the
   *  done-state itself is read straight from the store below. */
  scrobbledVersion: number;
  /** A bulk job is in flight — this row's buttons go inert. */
  runActive: boolean;
}) {
  void scrobbledVersion;
  // null = idle; otherwise the service whose push is in flight. Blocks
  // both buttons while either is running so a double-click can't fire two
  // overlapping writes for the same row.
  const [busy, setBusy] = useState<"trakt" | "anilist" | null>(null);

  const eligible = servicesFor(entry, conn);
  const showTrakt = eligible.includes("trakt");
  const showAnilist = eligible.includes("anilist");

  const scrobble = async (service: ScrobbleService) => {
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
        anilistId:      entry.anilist_id ?? null,
        anilistEpisode: entry.anilist_episode ?? null,
      });
      markScrobbled(conn.scope, service, entry.id, entry.played_at);
      showAppToast(message, { tone: "success" });
    } catch (err) {
      const raw = String(err);
      // Same retirement rule as the bulk runner: a verdict about the item means a
      // bulk run should stop re-sending it too. The marker never reaches the user.
      if (isPermanentFailure(raw)) {
        markIneligible(conn.scope, service, entry.id);
      }
      showAppToast(cleanFailureMessage(raw), { tone: "danger", duration: 6000 });
    } finally {
      setBusy(null);
    }
  };

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
      className={`group relative card-contain rounded-xl overflow-hidden
                  bg-white/4 border cursor-pointer transition-colors
                  ${isSelected
                    ? "border-ln-accent/70 bg-ln-accent/10"
                    : "border-white/8 hover:border-white/20"}`}
      // While a selection is active the card toggles instead of navigating, so
      // building a selection never bounces the user off the page by accident.
      onClick={() => (selectionActive ? onToggleSelect(entry) : onSelectMeta?.(meta))}
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

      {/* Selection box. Always visible once selected or while a selection is in
          progress; otherwise revealed on hover. */}
      <div
        className={`absolute top-1.5 left-1.5 z-10 transition-opacity
                    ${isSelected || selectionActive
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"}`}
      >
        <SelectBox
          checked={isSelected}
          onToggle={() => onToggleSelect(entry)}
          label={isSelected ? `Deselect ${entry.name}` : `Select ${entry.name}`}
        />
      </div>

      {/* Hover-revealed scrobble actions. Each service is only offered when the
          account has it connected (AniList additionally gated to anime). A
          service already recorded for this row renders as a done tick instead of
          a live button — the service would no-op the write anyway, so there is
          nothing to gain from firing it again. Suppressed entirely while a
          selection is active, so the checkboxes own the hover surface. */}
      {(showTrakt || showAnilist) && !selectionActive && (
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
              disabled={busy !== null || runActive}
              done={isScrobbled(conn.scope, "trakt", entry.id, entry.played_at)}
              unavailable={isIneligible(conn.scope, "trakt", entry.id)}
              onClick={() => scrobble("trakt")}
            />
          )}
          {showAnilist && (
            <ScrobbleButton
              label="AniList"
              busy={busy === "anilist"}
              disabled={busy !== null || runActive}
              done={isScrobbled(conn.scope, "anilist", entry.id, entry.played_at)}
              unavailable={isIneligible(conn.scope, "anilist", entry.id)}
              onClick={() => scrobble("anilist")}
            />
          )}
        </div>
      )}

      {/* Hover X — removes ONLY this entry (id, played_at). */}
      {!selectionActive && (
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
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Scrobble action pill, shared by the Trakt / AniList buttons on a card.
// Shows a spinner while its push is in flight; disabled while EITHER
// service on the row is running. `done` renders the already-scrobbled state.
// ---------------------------------------------------------------------------

function ScrobbleButton({
  label, busy, disabled, done, unavailable = false, onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  done: boolean;
  /** The service has definitively refused this item (no catalog match / can't
   *  resolve). Shown as inert rather than letting the user re-trigger the same
   *  error forever. */
  unavailable?: boolean;
  onClick: () => void;
}) {
  const title = done
    ? `Already scrobbled to ${label}`
    : unavailable
      ? `${label} has no catalog match for this item`
      : `Scrobble to ${label}`;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled || done || unavailable}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full
                  text-[10.5px] font-medium leading-none
                  backdrop-blur-md transition-colors
                  disabled:cursor-default
                  ${done
                    ? "bg-emerald-400/15 text-emerald-200 border border-emerald-300/35"
                    : unavailable
                      ? "bg-white/5 text-white/30 border border-white/10 line-through"
                      : "bg-white/10 text-white/85 border border-white/20 hover:bg-ln-accent/25 hover:text-white hover:border-ln-accent/50 disabled:opacity-50"}`}
    >
      {busy ? (
        <svg
          width="10" height="10" viewBox="0 0 24 24"
          className="animate-spin" aria-hidden
        >
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"
                  strokeWidth="3" strokeLinecap="round" strokeDasharray="42 14" opacity="0.9" />
        </svg>
      ) : done ? (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      ) : null}
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
