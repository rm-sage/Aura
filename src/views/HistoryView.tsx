// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  HISTORY_COMMAND,
  SCROBBLE_SERVICES,
  knownScrobbleServicesAvailable,
  useScrobbleConnections,
  type RowHistoryService,
  type ScrobbleConn,
  type ScrobbleService,
} from "../scrobbleConn";
import { pushSimklHistory, simklCanIdentify, simklItemFromEntry } from "../scrobbleSimkl";
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
} from "../scrobbledStore";
import {
  cleanFailureMessage,
  isPermanentFailure,
  startScrobbleRun,
  useScrobbleRun,
  type ScrobbleWorkItem,
} from "../scrobbleRun";
import ImageLoader from "../ImageLoader";
import Tooltip from "../Tooltip";
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
// for "connected". One flag per service, derived from the shared type.
type ScrobbleConnState = Pick<ScrobbleConn, "scope" | ScrobbleService>;

// ---------------------------------------------------------------------------
// HistoryView — Trakt-style detailed feed of completions.
//
// Source: localStorage `aura:history:<scope>`, written from two places:
// exit-playback when the user actually watched (>= 80 % of duration AND
// >= 5 min), and skipActions when an episode is marked Skipped. Manual
// mark-as-WATCHED is still excluded by contract: it claims nothing about
// having engaged with the episode, whereas a skip is an explicit decision
// that it is done.
//
// Layout: grouped by day (Today / Yesterday / "Friday May 1, 2026") with
// a running total runtime per day in the header and one row per entry.
//
// SCROBBLING: three ways in, all funnelling through the SAME Tauri commands
// (`scrobble_history_trakt` / `scrobble_history_anilist` per row,
// `scrobble_history_simkl` as one batch) so every path inherits their gates
// identically:
//   1. per-row Trakt / AniList / Simkl buttons (hover),
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
 *  present so an episode id resolves against the show.
 *
 *  Simkl takes movies, series and anime alike, so it supplements both: an
 *  anime row is offered to AniList AND Simkl, a movie or series row to Trakt
 *  AND Simkl. Its gate is only "is there an id Simkl can key on", the same
 *  test its Rust command applies (see scrobbleSimkl.ts). */
function servicesFor(entry: HistoryEntry, conn: ScrobbleConnState): ScrobbleService[] {
  const out: ScrobbleService[] = [];
  if (conn.trakt) out.push("trakt");
  const isAnime = isAnimeMeta({
    media_type: entry.media_type,
    id: entry.parent_id ?? entry.id,
    genres: [],
  });
  if (conn.anilist && isAnime) out.push("anilist");
  if (conn.simkl && simklCanIdentify(simklItemFromEntry(entry))) out.push("simkl");
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
    scope: "guest", trakt: false, anilist: false, simkl: false,
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

  // Connection state now lives in scrobbleConn.ts, shared with the skip
  // actions so both surfaces resolve "can we push, and to what" identically.
  const sharedConn = useScrobbleConnections();
  useEffect(() => {
    setConn({
      scope: sharedConn.scope,
      trakt: sharedConn.trakt,
      anilist: sharedConn.anilist,
      simkl: sharedConn.simkl,
    });
  }, [sharedConn.scope, sharedConn.trakt, sharedConn.anilist, sharedConn.simkl]);

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

  const anyService = SCROBBLE_SERVICES.some((service) => conn[service]);
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
  //      episode. Simkl answers a re-sent row with a no-op. So even a
  //      stale/absent local record cannot produce a dupe.
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
        // Simkl is named only in a build that can sign in to it.
        const names = knownScrobbleServicesAvailable()?.has("simkl")
          ? "Trakt, AniList or Simkl"
          : "Trakt or AniList";
        showAppToast(`Connect ${names} in Settings > Scrobbling first.`, { tone: "danger" });
        return;
      }

      // Everything eligible and not already done, split by service. Keyed by
      // service rather than `trakt ? ... : anilist`, so a new service is a
      // compile error here instead of silently landing in AniList's
      // per-season collapse below.
      const pendingBy: Record<ScrobbleService, HistoryEntry[]> = {
        trakt: [], anilist: [], simkl: [],
      };
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
          pendingBy[service].push(entry);
        }
      }

      // Trakt records each play separately, keyed on watched_at, so every row
      // is its own push.
      const traktWork: ScrobbleWorkItem[] = pendingBy.trakt.map(
        (entry) => ({ entry, service: "trakt" }),
      );
      const anilistPending = pendingBy.anilist;

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

      // Simkl logs each play separately like Trakt, so nothing collapses, but
      // the runner sends all of these in ONE batched call after the per-row
      // pushes (see scrobbleRun.ts) rather than one call each.
      const simklWork: ScrobbleWorkItem[] = pendingBy.simkl.map(
        (entry) => ({ entry, service: "simkl" }),
      );
      const work: ScrobbleWorkItem[] = [...traktWork, ...anilistWork, ...simklWork];

      if (work.length === 0) {
        const why =
          alreadyDone > 0
            ? `Nothing to do — all ${alreadyDone} eligible push${alreadyDone === 1 ? "" : "es"} in ${what} are already scrobbled.`
            : `Nothing in ${what} is eligible (AniList only takes anime; Trakt needs an IMDb id${
              conn.simkl ? "; Simkl needs an IMDb, TMDB, TVDB or anime id, plus an episode number on an episode" : ""
            }).`;
        showAppToast(
          retired > 0
            ? `${why} ${retired} item${retired === 1 ? " was" : "s were"} refused by the service and won't be retried.`
            : why,
        );
        return;
      }

      // ITEMS vs PUSHES. One item can produce up to THREE pushes: every eligible
      // row goes to Trakt and Simkl, and the anime subset ALSO goes to AniList.
      // So "118 items" and "217 pushes" are both true of the same run, and the
      // dialog has to say so outright -- quoting only the push count next to a
      // header that counts items reads like a bug.
      const legs: string[] = [];
      if (traktWork.length > 0) legs.push(`${traktWork.length} to Trakt`);
      if (anilistWork.length > 0) legs.push(`${anilistWork.length} to AniList`);
      if (simklWork.length > 0) legs.push(`${simklWork.length} to Simkl (sent as one batch)`);
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
      detail: "This can't be undone. It only clears Aura's local history; anything already scrobbled stays on Trakt / AniList.",
      confirmLabel: "Clear history",
      tone: "danger",
    });
    if (!confirmed) return;
    clearHistory();
    setSelected(new Set());
    showAppToast("History cleared");
  }, [entries.length, ask]);

  const selectionActive = selected.size > 0;

  // Whether the sticky header is floating over content, which is when it needs
  // its glass. It rests 24 px down (the column's py-6) and sticks at 12 px, so
  // anything past 12 px of scroll has content sliding underneath it. Only
  // commits on a change, so scrolling a long history re-renders twice, not
  // once per frame.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const next = el.scrollTop > 12;
      setStuck((prev) => (prev === next ? prev : next));
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-[1100px] mx-auto px-6 py-6 space-y-7">
          <HistoryHeader
            total={entries.length}
            selectedCount={selected.size}
            stuck={stuck}
            anyService={anyService}
            busy={busy}
            onScrobbleAll={() => void runScrobble(entries, "your entire history")}
            onClearHistory={() => void clearAll()}
            onScrobbleSelected={() => void runScrobble(
              selectedEntries,
              `${selected.size} selected item${selected.size === 1 ? "" : "s"}`,
            )}
            onRemoveSelected={() => void removeSelected()}
            onCancelSelection={() => setSelected(new Set())}
          />

          {entries.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                Watch something to start a history. Plays you finish and
                episodes you skip appear here; marking something watched by
                hand doesn't.
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

          {/* Bottom padding so the globally-rendered ScrobbleRunBar (fixed,
              bottom-centre, only while a bulk job runs) never covers the last
              row. The selection actions no longer float, so they need none. */}
          {busy && <div className="h-16" aria-hidden />}
        </div>
      </div>

      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page header, which becomes the selection toolbar.
// ---------------------------------------------------------------------------

/** Shared pill geometry, so both states sit at exactly the same height and the
 *  swap never shifts the page. */
const PILL = "px-3.5 py-1.5 rounded-full text-xs font-medium border transition-colors "
  + "disabled:opacity-40 disabled:cursor-default";

/**
 * The page header, which BECOMES the selection toolbar while anything is
 * selected. One slot, two states, so the global actions (Scrobble All, Clear
 * history) and the selection actions (Scrobble N, Remove N, Cancel) are never
 * on screen together.
 *
 * They used to be. The global pair sat up here while a small floating pill
 * carried the selection actions at the bottom, in the SAME pill grammar and
 * the same accent-vs-neutral weighting, so the eye went to the header and
 * weight said nothing about scope. Worst of all, "Clear All" (wipes the whole
 * local history) had a near-identical twin "Clear" (only deselects). Now the
 * scope is written into the labels (the counts), and the only way to reach a
 * global action is to leave selection mode first.
 *
 * Sticky, so the toolbar is reachable anywhere in a long history. Its glass
 * fades in only once it is actually floating over content (or while
 * selecting), and a separate accent layer marks selection mode itself.
 */
function HistoryHeader({
  total, selectedCount, stuck, anyService, busy,
  onScrobbleAll, onClearHistory, onScrobbleSelected, onRemoveSelected, onCancelSelection,
}: {
  total: number;
  selectedCount: number;
  stuck: boolean;
  anyService: boolean;
  /** A bulk scrobble job is running (module-level, see scrobbleRun.ts). */
  busy: boolean;
  onScrobbleAll: () => void;
  onClearHistory: () => void;
  onScrobbleSelected: () => void;
  onRemoveSelected: () => void;
  onCancelSelection: () => void;
}) {
  const selecting = selectedCount > 0;

  // Leaving selection mode puts "Clear history" (rest state) where a selection
  // control just was. Cancel now lives on the LEFT, so a double-click on it
  // lands on the static title, but the selection can also empty under a still
  // pointer (a sync prunes the selected entries while it rests on Remove N).
  // A click on the history wipe that soon after the swap is not a decision
  // about the new button, so it is ignored. Not a substitute for the confirm
  // dialog; a guard in front of it.
  const leftSelectionAt = useRef(0);
  const wasSelecting = useRef(selecting);
  // Cancel unmounts itself (the whole selecting row is keyed away), which
  // would drop keyboard focus to <body>. When the user cancelled, hand focus
  // to the page title instead. Only then: a selection emptied by anything
  // else must not pull focus out of the list the user is working in.
  const restoreFocusOnExit = useRef(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (wasSelecting.current && !selecting) {
      leftSelectionAt.current = performance.now();
      if (restoreFocusOnExit.current) titleRef.current?.focus({ preventScroll: true });
    }
    restoreFocusOnExit.current = false;
    wasSelecting.current = selecting;
  }, [selecting]);
  const clearHistoryGuarded = () => {
    if (performance.now() - leftSelectionAt.current < 450) return;
    onClearHistory();
  };

  return (
    <div className="sticky top-3 z-20 -mx-4">
      {/* Two separate layers rather than classes on one element:
          .aura-float-glass sets background, border and box-shadow as
          shorthands, which silently beats any border or ring utility on the
          same element, so the accent rim has to be its own layer. Both are
          opacity-only, so the fade runs on the compositor. */}
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 rounded-2xl aura-float-glass
                    transition-opacity duration-200 ${stuck || selecting ? "opacity-100" : "opacity-0"}`}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-0 rounded-2xl
                    border border-ln-accent/45 bg-ln-accent/10
                    transition-opacity duration-200 ${selecting ? "opacity-100" : "opacity-0"}`}
      />
      {/* Always mounted, outside the keyed row. A live region inserted with
          its text already in place is not spoken, so one living inside the
          selecting branch never announced the switch INTO selection mode. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {selecting ? `${selectedCount} selected` : ""}
      </p>
      {/* Keyed on the MODE (not the count), so the swap plays its enter
          animation once per mode change and a count change never re-triggers
          it. */}
      <div
        key={selecting ? "selecting" : "rest"}
        className="aura-header-swap relative flex items-end justify-between gap-4 flex-wrap px-4 py-3"
      >
        {selecting ? (
          <>
            {/* Cancel leads, beside the count, and never sits in the right-hand
                cluster: both clusters are flush right, bottom-aligned and 30 px
                tall, so a right-aligned X shared its hit area with the rest
                state's "Clear history" pill. A double-click on Cancel then
                deselected, swapped the header, and opened the history-wipe
                confirm with its destructive button focused. Here, the spot it
                vacates is the rest state's static title. */}
            <div className="min-w-0 flex items-center gap-3">
              <Tooltip text="Cancel selection" pos="bottom">
                <button
                  type="button"
                  aria-label="Cancel selection"
                  onClick={() => { restoreFocusOnExit.current = true; onCancelSelection(); }}
                  className="w-[30px] h-[30px] rounded-full grid place-items-center shrink-0
                             bg-white/5 text-white/70 border border-white/15
                             hover:bg-white/12 hover:text-white transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </Tooltip>
              <div className="min-w-0">
                <h1 className="sr-only">History</h1>
                <p className="text-3xl font-semibold tracking-tight text-white">
                  <span className="text-ln-accent tabular-nums">{selectedCount}</span> selected
                </p>
                <p className="text-white/45 text-sm mt-1">
                  of {total} · click a card to add or remove it
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {anyService && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onScrobbleSelected}
                  className={`${PILL} bg-ln-accent/20 text-ln-accent border-ln-accent/45
                              hover:bg-ln-accent/30 hover:text-white`}
                >
                  Scrobble {selectedCount}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={onRemoveSelected}
                className={`${PILL} bg-white/5 text-white/75 border-white/15
                            hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-300/40`}
              >
                Remove {selectedCount}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="min-w-0">
              <h1
                ref={titleRef}
                tabIndex={-1}
                className="aura-row-title text-3xl font-semibold tracking-tight outline-none"
              >
                History
              </h1>
              <p className="text-white/35 text-sm mt-1">
                {total === 0
                  ? "Your watch history is empty. Items you finish playing, or skip, show up here automatically."
                  : `${total} item${total === 1 ? "" : "s"} from playback and skips.`}
              </p>
            </div>
            {total > 0 && (
              <div className="flex items-center gap-2">
                {anyService && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onScrobbleAll}
                    className={`${PILL} bg-ln-accent/15 text-ln-accent border-ln-accent/35
                                hover:bg-ln-accent/25 hover:text-white`}
                  >
                    Scrobble All
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={clearHistoryGuarded}
                  className={`${PILL} bg-white/5 text-white/60 border-white/10
                              hover:bg-rose-500/15 hover:text-rose-200 hover:border-rose-300/40`}
                >
                  Clear history
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
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
    // Every focusable control in the list is a <button> (cards are plain
    // divs), so one descendant rule covers the day and card checkboxes, the
    // hover remove X and the scrobble pills. 108 px clears the stuck
    // HistoryHeader (top-3 = 12, plus ~84 tall) with 12 px to spare. Chromium
    // scrolls focus into view only when the target leaves the scrollport, so
    // without this a control under the stuck header took focus invisibly.
    <section className="space-y-3 [&_button]:scroll-mt-[108px]">
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
  const [busy, setBusy] = useState<ScrobbleService | null>(null);

  const eligible = servicesFor(entry, conn);
  const showTrakt = eligible.includes("trakt");
  const showAnilist = eligible.includes("anilist");
  const showSimkl = eligible.includes("simkl");

  const scrobble = async (service: RowHistoryService) => {
    if (busy) return;
    setBusy(service);
    try {
      // Tauri maps these camelCase keys onto the Rust command's
      // snake_case params (parent_id, media_type, played_at, ...).
      const message = await invoke<string>(HISTORY_COMMAND[service], {
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

  // Simkl's command takes a batch (see scrobbleSimkl.ts), so the row button
  // sends a batch of ONE and reads its single answer, with the same marking
  // rules as the bulk runner: added is scrobbled, not_found / skipped retire
  // the row, failed is left for a retry.
  const scrobbleSimkl = async () => {
    if (busy) return;
    setBusy("simkl");
    try {
      const [result] = await pushSimklHistory(conn.scope, [simklItemFromEntry(entry)]);
      if (result.status === "added") {
        markScrobbled(conn.scope, "simkl", entry.id, entry.played_at);
        showAppToast(result.message, { tone: "success" });
        return;
      }
      if (result.status === "not_found" || result.status === "skipped") {
        markIneligible(conn.scope, "simkl", entry.id);
      }
      showAppToast(result.message, { tone: "danger", duration: 6000 });
    } catch (err) {
      showAppToast(String(err), { tone: "danger", duration: 6000 });
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
          {/* Skips sit in the same feed as plays because they make the same
              claim (this episode is done) and stay re-scrobblable from here.
              The tag is what stops the two being confused, since a skipped row
              has no runtime and would otherwise just look like a short play. */}
          {entry.skipped && (
            <span className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded
                             bg-purple-500/20 border border-purple-300/30
                             text-purple-100 text-[9.5px] font-mono uppercase tracking-[0.14em]">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
              </svg>
              Skipped
            </span>
          )}
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
      {(showTrakt || showAnilist || showSimkl) && !selectionActive && (
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
          {showSimkl && (
            <ScrobbleButton
              label="Simkl"
              busy={busy === "simkl"}
              disabled={busy !== null || runActive}
              done={isScrobbled(conn.scope, "simkl", entry.id, entry.played_at)}
              unavailable={isIneligible(conn.scope, "simkl", entry.id)}
              onClick={() => void scrobbleSimkl()}
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
// Scrobble action pill, shared by the Trakt / AniList / Simkl buttons on a card.
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
