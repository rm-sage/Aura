// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  HISTORY_COMMAND,
  SCROBBLE_LABELS,
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
  clearHistoryChecked,
  onHistoryChange,
  isHistoryLoaded,
  historyLoadError,
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
import { openContextMenu } from "../ContextMenu";
import { shrinkPoster } from "../posterSize";
import ErrorBoundary from "../ErrorBoundary";
import { showAppToast } from "../AppToast";
import { askConfirm, useConfirm } from "../ConfirmDialog";
import { typeLabel, isAnimeMeta, useAnimeCacheVersion } from "../aiometadata";
import ListSearchInput from "../ListSearchInput";
import {
  MediaTypePills, classifyMediaKinds, facetCounts, type MediaTypeFilter,
} from "../mediaTypePills";
import {
  buildHistoryIndex, buildLayout, dayKeyOfDate, episodeLabel, filterHistory, findAnchor, firstItemAt,
  keyOf, narrowByKind, resolveJumpDay, visibleRange,
  type HistoryLayout, type IndexedEntry, type LayoutMetrics,
} from "../historyIndex";
import HistoryDateJump from "../HistoryDateJump";

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
// Source: historyStore (a Rust-owned file per scope, hydrated at startup), written from two places:
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
//
// PERFORMANCE. Opening the page used to freeze the app for about a second on a
// 650-play history: every card mounted at once (each with its own image
// observer, shimmer skeleton and ~25 DOM nodes), and each card formatted its
// time through `toLocaleTimeString`, which builds a fresh ICU formatter per
// call. Now one pass builds an index (historyIndex.ts), the list is a FIXED
// HEIGHT layout of day headers and card rows, and only the items within
// OVERSCAN_PX of the viewport mount (VirtualHistoryList). Formatters are
// created once, at module scope.
//
// FILTERS. A title search, the media-type pills and "every play of this
// title" narrow the list and keep its day grouping. While any of them is on,
// the header's actions act on what is SHOWN and say so in their labels
// ("Scrobble 12 shown"); the whole-history actions (Scrobble All, Clear
// history) only appear with no filter, so no label can be read as either.
// ---------------------------------------------------------------------------

// Fixed geometry. Every card has the same height (the text is clamped), so
// the layout is exact without measuring and a date jump lands on the right
// pixel the first time. CARD_H = the 68 x 102 poster + p-2 + a 1 px border.
const METRICS: LayoutMetrics = {
  dayHeaderH: 40,
  rowH: 120,
  headerGap: 12,
  rowGap: 12,
  dayGap: 28,
};
/** Card columns: as many ~200 px cards as fit, between 2 and 4 (what the old
 *  md / lg breakpoints gave inside the 1100 px column). */
const MIN_CARD_W = 200;
/** Items within this distance of the viewport stay mounted, so a normal
 *  scroll never shows an unfilled row. */
const OVERSCAN_PX = 600;
/** Gap kept under the sticky header when jumping to a day. */
const JUMP_MARGIN = 12;
/** The sticky header's `top-3`. */
const STICKY_TOP = 12;
/** A remove while the history file cannot be read: see removeHistoryEntries. */
const REMOVE_REFUSED = "Aura can't read your history file right now (another program may have it open), so nothing was removed. Try again in a moment.";
/** The page is behind the player (the app body is display:none): nothing there
 *  has a box, so every rect, clientHeight and scrollTop reads 0. */
const hasNoBox = (el: HTMLElement) => el.clientHeight === 0 && el.clientWidth === 0;

const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "long", month: "long", day: "numeric", year: "numeric",
});
const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

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
  /** The store hydrates from disk asynchronously; until it has, an empty
   *  list means "not read yet", not "no history". */
  const [loaded, setLoaded] = useState(() => isHistoryLoaded());
  /** Set while the load keeps failing (a history file another program holds
   *  open): say so, rather than "loading" forever or "no history". */
  const [loadError, setLoadError] = useState<string | null>(() => historyLoadError());
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
    const sync = () => {
      const next = getHistory();
      // Same rows, same array: `getHistory` always copies, and a new array
      // rebuilds the index and layout, which the mount's sync does for nothing.
      setEntries((prev) => (
        next.length === prev.length && next.every((e, i) => e === prev[i]) ? prev : next
      ));
      setLoaded(isHistoryLoaded());
      setLoadError(historyLoadError());
    };
    // Hydration can finish between the first render and this subscription.
    sync();
    return onHistoryChange(sync);
  }, []);

  useEffect(
    () => onScrobbledChange(() => setScrobbledVersion((v) => v + 1)),
    [],
  );

  // Connection state now lives in scrobbleConn.ts, shared with the skip
  // actions so both surfaces resolve "can we push, and to what" identically.
  // Derived, not copied into state by an effect: the copy cost a second full
  // render of the page on every open, for a value already in hand.
  const sharedConn = useScrobbleConnections();
  const conn = useMemo<ScrobbleConnState>(() => ({
    scope: sharedConn.scope,
    trakt: sharedConn.trakt,
    anilist: sharedConn.anilist,
    simkl: sharedConn.simkl,
  }), [sharedConn.scope, sharedConn.trakt, sharedConn.anilist, sharedConn.simkl]);

  // Drop selections whose entries no longer exist (removed here or by a sync).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map(keyOf));
      const next = new Set([...prev].filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- Filters ------------------------------------------------------------
  const [query, setQuery] = useState("");
  /** Show only the plays of one title (its `parent_id ?? id`). */
  const [titleFilter, setTitleFilter] = useState<string | null>(null);
  const [kind, setKind] = useState<MediaTypeFilter>("all");
  // The list re-filters at a lower priority than the keystroke, so typing
  // stays immediate on a very long history.
  const deferredQuery = useDeferredValue(query);

  // ONE pass over the history (see historyIndex.ts). Re-run when the anime
  // cache learns an id, since that moves a title between Series and Anime.
  const animeCacheVersion = useAnimeCacheVersion();
  const index = useMemo(
    () => buildHistoryIndex(entries, (mediaType, id) => classifyMediaKinds(mediaType, id, null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, animeCacheVersion],
  );
  // The type-agnostic result (search + title) the pills count over, then the
  // pill's slice of it, so a pill's count is always what selecting it shows.
  const agnostic = useMemo(
    () => filterHistory(index, { query: deferredQuery, titleKey: titleFilter }),
    [index, deferredQuery, titleFilter],
  );
  const typeCounts = useMemo(() => facetCounts(agnostic, (it) => it.kinds), [agnostic]);
  const shown = useMemo(() => narrowByKind(agnostic, kind), [agnostic, kind]);
  // From the DEFERRED query, like the list itself, so the header counts and
  // its shown-vs-all actions never describe a list one keystroke behind them.
  const filtered = deferredQuery.trim() !== "" || titleFilter !== null || kind !== "all";

  // A title filter whose last play was removed (here, or by a sync) would
  // otherwise leave a chip naming nothing over an empty page.
  useEffect(() => {
    if (titleFilter && !index.titles.has(titleFilter)) setTitleFilter(null);
  }, [index, titleFilter]);

  /** "Every play of this title". Clears the search and the type pill: either
   *  could hide plays of the very title the user asked to see. */
  const showTitle = useCallback((titleKey: string) => {
    setQuery("");
    setKind("all");
    setTitleFilter(titleKey);
  }, []);
  const clearFilters = useCallback(() => {
    setQuery("");
    setKind("all");
    setTitleFilter(null);
  }, []);

  // ---- Layout + scroll -------------------------------------------------------
  const [cols, setCols] = useState(4);
  const layout = useMemo(() => buildLayout(shown, cols, METRICS), [shown, cols]);
  /** The day at the top of the viewport: labels the jump button, and is the
   *  month the calendar opens on. */
  const [topDay, setTopDay] = useState<string | null>(null);
  const listHandle = useRef<ListHandle | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const jumpBtnRef = useRef<HTMLButtonElement>(null);
  const [jumpOpen, setJumpOpen] = useState(false);
  const closeJump = useCallback(() => setJumpOpen(false), []);
  // An emptied list closes the calendar for good: left armed, it would remount
  // when rows return and take focus from the search box being typed in.
  useEffect(() => {
    if (layout.dayKeys.length === 0) setJumpOpen(false);
  }, [layout.dayKeys.length]);
  /** A day just jumped to, briefly highlighted so the eye finds it. */
  const [flashDay, setFlashDay] = useState<string | null>(null);
  useEffect(() => {
    if (!flashDay) return;
    const t = window.setTimeout(() => setFlashDay(null), 1600);
    return () => window.clearTimeout(t);
  }, [flashDay]);

  const jumpTo = useCallback((target: string) => {
    const day = resolveJumpDay(layout.dayKeys, target);
    if (!day) return;
    listHandle.current?.scrollToDay(day);
    setFlashDay(day);
  }, [layout.dayKeys]);

  // A new filter shows a new list: the list itself starts it from the top
  // (its `filterSig` prop), keyed on the filter only, so removing a play
  // never moves the page.
  const filterSig = `${deferredQuery}\u0000${titleFilter ?? ""}\u0000${kind}`;

  const connectedList = useMemo(
    () => SCROBBLE_SERVICES.filter((service) => conn[service]),
    [conn],
  );
  const anyService = connectedList.length > 0;
  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(keyOf(e))),
    [entries, selected],
  );
  const shownEntries = useMemo(() => shown.map((it) => it.entry), [shown]);
  /** Selected plays the current filter hides: said out loud in the toolbar so
   *  "Remove 5" never surprises anyone looking at three. */
  const hiddenSelected = useMemo(() => {
    if (selected.size === 0 || !filtered) return 0;
    let visible = 0;
    for (const it of shown) if (selected.has(it.key)) visible++;
    return selected.size - visible;
  }, [selected, shown, filtered]);
  const allShownSelected = useMemo(
    () => shown.length > 0 && shown.every((it) => selected.has(it.key)),
    [shown, selected],
  );
  const selectShown = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const it of shown) next.add(it.key);
      return next;
    });
  }, [shown]);

  // -------------------------------------------------------------------------
  // The one bulk-scrobble runner. Every bulk entry point (Scrobble All, or the
  // selection bar) calls THIS, so they cannot drift apart.
  //
  // DUPLICATE PROTECTION, in layers:
  //   1. Any (entry, service) already recorded in scrobbledStore is a REPEAT:
  //      it is sent again only when the user says so in a prompt that says it
  //      is one (repeatPrompt), otherwise skipped without a call.
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
    // `only` narrows the run to one service ("Scrobble All to Simkl"); every
    // other rule below is unchanged, so a narrowed run is exactly the slice of
    // the full run that would have gone to that service.
    async (list: HistoryEntry[], what: string, only?: ScrobbleService) => {
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
      // per-entry collapse below.
      const pendingBy: Record<ScrobbleService, HistoryEntry[]> = {
        trakt: [], anilist: [], simkl: [],
      };
      const items = new Set<string>();
      // Already-scrobbled pushes, held back until the user decides on them.
      const repeats: Array<{ entry: HistoryEntry; service: ScrobbleService }> = [];
      let retired = 0;
      for (const entry of list) {
        for (const service of servicesFor(entry, conn)) {
          if (only && service !== only) continue;
          // The service has already told us, definitively, that it cannot take this
          // item (Trakt has no catalog entry for it; AniList cannot resolve it).
          // Sending it again would fail identically and re-report the same error.
          // Checked before the repeat test, as the row's pill is: a retired id is
          // never offered as a repeat.
          if (isIneligible(conn.scope, service, entry.id)) {
            retired++;
            continue;
          }
          if (isScrobbled(conn.scope, service, entry.id, entry.played_at)) {
            repeats.push({ entry, service });
            continue;
          }
          items.add(keyOf(entry));
          pendingBy[service].push(entry);
        }
      }

      // REPEATS. Asked about on their own, before the run's own confirmation,
      // so the prompt can say plainly that these were sent already. With only
      // repeats in the run that one prompt is the confirmation; with fresh
      // pushes too, declining it (or Escape) still scrobbles the fresh ones.
      let alreadyDone = repeats.length;
      const onlyRepeats = items.size === 0 && repeats.length > 0;
      if (repeats.length > 0) {
        const repeatItems = new Set(repeats.map((r) => keyOf(r.entry))).size;
        const services = SCROBBLE_SERVICES.filter((sv) => repeats.some((r) => r.service === sv))
          .map((sv) => SCROBBLE_LABELS[sv]);
        const again = await ask({
          title: onlyRepeats ? "Scrobble again?" : "Include repeats?",
          message: onlyRepeats
            ? `Everything eligible in ${what} is already scrobbled${only ? ` to ${SCROBBLE_LABELS[only]}` : ""}. Send ${repeatItems} item${repeatItems === 1 ? "" : "s"} again as a repeat?`
            : `${repeatItems} item${repeatItems === 1 ? " was" : "s were"} already scrobbled (${repeats.length} push${repeats.length === 1 ? "" : "es"}). Send ${repeatItems === 1 ? "it" : "them"} again as a repeat?`,
          detail: repeatDetail(services),
          confirmLabel: onlyRepeats ? "Scrobble again" : "Include repeats",
          cancelLabel: onlyRepeats ? "Cancel" : "Skip repeats",
          tone: "accent",
        });
        if (onlyRepeats && !again) return;
        if (again) {
          for (const r of repeats) {
            items.add(keyOf(r.entry));
            pendingBy[r.service].push(r.entry);
          }
          alreadyDone = 0;
        }
      }

      // Trakt records each play separately, keyed on watched_at, so every row
      // is its own push.
      const traktWork: ScrobbleWorkItem[] = pendingBy.trakt.map(
        (entry) => ({ entry, service: "trakt" }),
      );
      const anilistPending = pendingBy.anilist;

      // COLLAPSE THE ANILIST SIDE, only where "same entry" is PROVABLE. AniList
      // keeps ONE progress number per entry, so only the highest episode of an
      // entry actually writes anything -- every lower episode resolves, discovers
      // progress is already ahead, and skips. Those no-ops still cost a GraphQL
      // round trip each, and they are what exhausts AniList's ~90/min budget on a
      // big run. Push only the entry's highest episode and mark the rest as
      // covered by it: identical end state (progress + backdated completedAt), a
      // fraction of the calls.
      //
      // A season is NOT an entry: a split-cour show files each cour as its own
      // entry inside one addon season, so collapsing Dr. STONE S04 would push the
      // later cour, leave the earlier one at zero and mark every row scrobbled.
      // The only proof is the row's own anilist_id + anilist_episode pair, the
      // same test as Rust's fast path in save_progress (and skipActions.ts).
      // Any other row goes through the resolver, which picks the cour from the
      // episode number, so it stands alone.
      const anilistWork: ScrobbleWorkItem[] = [];
      const byEntry = new Map<number, HistoryEntry[]>();
      for (const e of anilistPending) {
        if (!e.anilist_id || e.anilist_id <= 0 || !e.anilist_episode || e.anilist_episode <= 0) {
          anilistWork.push({ entry: e, service: "anilist" });
          continue;
        }
        const bucket = byEntry.get(e.anilist_id) ?? [];
        bucket.push(e);
        byEntry.set(e.anilist_id, bucket);
      }
      for (const bucket of byEntry.values()) {
        // Highest episode wins; its played_at is the entry's completion date,
        // which is exactly what AniList's day-precision completedAt wants.
        bucket.sort((a, b) => (b.anilist_episode ?? 0) - (a.anilist_episode ?? 0));
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
        const onlyWhy: Record<ScrobbleService, string> = {
          trakt: "Trakt needs an IMDb id",
          anilist: "AniList only takes anime",
          simkl: "Simkl needs an IMDb, TMDB, TVDB or anime id, plus an episode number on an episode",
        };
        const why =
          alreadyDone > 0
            ? `Nothing to do: all ${alreadyDone} eligible push${alreadyDone === 1 ? "" : "es"} in ${what}${only ? ` for ${SCROBBLE_LABELS[only]}` : ""} are already scrobbled.`
            : only
              ? `Nothing in ${what} can go to ${SCROBBLE_LABELS[only]} (${onlyWhy[only]}).`
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
          ? ` AniList tracks one progress number per entry, so ${anilistCollapsed} lower episode${anilistCollapsed === 1 ? " is" : "s are"} covered by the highest one of the same entry rather than sent separately.`
          : "") +
        (alreadyDone > 0
          ? ` ${alreadyDone} already-scrobbled push${alreadyDone === 1 ? "" : "es"} will be skipped.`
          : "") +
        (retired > 0
          ? ` ${retired} item${retired === 1 ? "" : "s"} the service has already refused (no catalog match) ${retired === 1 ? "is" : "are"} skipped too.`
          : "");

      const confirmed = onlyRepeats || await ask({
        title: "Scrobble history",
        message: `Scrobble ${n} item${n === 1 ? "" : "s"} from ${what}${only ? ` to ${SCROBBLE_LABELS[only]}` : ""}?`,
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
      if (summary.firstError) parts.push(summary.firstError);
      showAppToast(
        parts.join(" · "),
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
   *  a given date: the "select everything played on a date" affordance. Under
   *  a filter that is every SHOWN play of the date: the day header counts
   *  those, and selecting what the user cannot see would be a surprise. */
  const toggleDay = useCallback((dayEntries: IndexedEntry[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allOn = dayEntries.every((it) => next.has(it.key));
      for (const it of dayEntries) {
        if (allOn) next.delete(it.key);
        else next.add(it.key);
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
      detail: `This removes ${n === 1 ? "it" : "them"} from your Aura history, including its Aura Cloud copy when you're signed in. Anything already scrobbled stays on ${scrobbleHomes()}.`,
      confirmLabel: "Remove",
      tone: "danger",
    });
    if (!confirmed) return;
    // ONE write + ONE change event for the whole selection.
    if (!removeHistoryEntries(selectedEntries.map((e) => ({ id: e.id, playedAt: e.played_at })))) {
      showAppToast(REMOVE_REFUSED, { tone: "danger", duration: 6000 });
      return;
    }
    setSelected(new Set());
    showAppToast(`Removed ${n} item${n === 1 ? "" : "s"} from history`);
  }, [selectedEntries, ask]);

  const clearAll = useCallback(async () => {
    const n = entries.length;
    const confirmed = await ask({
      title: "Clear history",
      message: `Clear all ${n} history entr${n === 1 ? "y" : "ies"}?`,
      detail: `This can't be undone. It clears your Aura history, including its Aura Cloud copy when you're signed in; anything already scrobbled stays on ${scrobbleHomes()}.`,
      confirmLabel: "Clear history",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await clearHistoryChecked();
    } catch (e) {
      showAppToast(e instanceof Error ? e.message : String(e), { tone: "danger", duration: 6000 });
      return;
    }
    setSelected(new Set());
    showAppToast("History cleared");
  }, [entries.length, ask]);

  const selectionActive = selected.size > 0;

  // Whether the sticky header is floating over content, which is when it needs
  // its glass. It rests 24 px down (the column's py-6) and sticks at 12 px, so
  // anything past 12 px of scroll has content sliding underneath it. Only
  // commits on a change, so scrolling a long history re-renders twice, not
  // once per frame.
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

  const titleInfo = titleFilter ? index.titles.get(titleFilter) ?? null : null;
  const total = entries.length;

  return (
    <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        ref={scrollRef}
        // VirtualHistoryList finds this element through the attribute while
        // scrollRef is still unattached (see its getScroll).
        data-history-scroll=""
        className="aura-page-scroller flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-[1100px] mx-auto px-6 py-6 space-y-7">
          <HistoryHeader
            headerRef={headerRef}
            total={total}
            loading={!loaded}
            shownCount={shown.length}
            shownSecs={layout.totalSecs}
            filtered={filtered}
            selectedCount={selected.size}
            hiddenSelected={hiddenSelected}
            allShownSelected={allShownSelected}
            stuck={stuck}
            services={connectedList}
            busy={busy}
            onScrobbleAll={(only) => void runScrobble(entries, "your entire history", only)}
            onScrobbleShown={(only) => void runScrobble(
              shownEntries,
              `the ${shown.length} shown item${shown.length === 1 ? "" : "s"}`,
              only,
            )}
            onSelectShown={selectShown}
            onClearHistory={() => void clearAll()}
            onScrobbleSelected={(only) => void runScrobble(
              selectedEntries,
              `${selected.size} selected item${selected.size === 1 ? "" : "s"}`,
              only,
            )}
            onRemoveSelected={() => void removeSelected()}
            onCancelSelection={() => setSelected(new Set())}
          >
            {total > 0 && (
              // The filter row lives OUTSIDE the header's keyed mode swap, so
              // entering or leaving selection never remounts the search box
              // (and never drops its focus or its text).
              <div className="relative flex flex-wrap items-center gap-2 px-4 pb-3">
                <MediaTypePills value={kind} onChange={setKind} counts={typeCounts} />
                {titleFilter && (
                  <span
                    className="inline-flex items-center gap-1.5 max-w-[280px] pl-3 pr-1 py-1 rounded-full
                               text-xs font-medium bg-ln-accent/15 text-ln-accent border border-ln-accent/35"
                  >
                    <span
                      className="truncate"
                      title={titleInfo ? `${titleInfo.name}: ${titleInfo.count} play${titleInfo.count === 1 ? "" : "s"} in your history` : undefined}
                    >
                      <span className="text-white/55">Showing </span>
                      {titleInfo?.name ?? titleFilter}
                    </span>
                    <button
                      type="button"
                      aria-label="Show every title again"
                      title="Show every title again"
                      onClick={() => setTitleFilter(null)}
                      className="w-5 h-5 shrink-0 rounded-full grid place-items-center
                                 hover:bg-ln-accent/25 hover:text-white transition-colors"
                    >
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                           strokeWidth="3" strokeLinecap="round" aria-hidden>
                        <path d="M6 6l12 12M18 6L6 18" />
                      </svg>
                    </button>
                  </span>
                )}
                <div className="ml-auto flex items-center gap-2">
                  {/* A native title, not a Tooltip: the instant glass tip would
                      open right where the calendar does and sit over it. */}
                  <button
                    ref={jumpBtnRef}
                    title="Jump to a date"
                    type="button"
                    aria-haspopup="dialog"
                    aria-expanded={jumpOpen}
                    aria-label={`Jump to a date${topDay ? `, now showing ${monthLabel(topDay)}` : ""}`}
                    disabled={layout.dayKeys.length === 0}
                    onClick={() => setJumpOpen((o) => !o)}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium
                                border transition-colors disabled:opacity-40
                                ${jumpOpen
                                  ? "bg-ln-accent/20 text-ln-accent border-ln-accent/35"
                                  : "bg-white/5 text-white/70 border-white/10 hover:text-white hover:bg-white/8"}`}
                  >
                    <CalendarIcon />
                    {/* Doubles as a "where am I" readout while scrolling a
                        long history. */}
                    <span className="tabular-nums">{topDay ? monthLabel(topDay) : "Jump to date"}</span>
                  </button>
                  <ListSearchInput
                    value={query}
                    onChange={setQuery}
                    placeholder="Search history (Ctrl+F)"
                    ariaLabel="Search history by title or episode"
                    className="w-56"
                  />
                </div>
              </div>
            )}
            {/* In the sticky header, so it shows at any depth and the list's
                measure (which observes the header) follows its height. */}
            {total > 0 && loadError && (
              <p role="status" className="relative px-4 pb-3 text-xs text-white/55">
                Aura can't read your history file right now (another program may have it open). Retrying...
                Only plays from this session are shown, and nothing can be removed until it can be read.
              </p>
            )}
          </HistoryHeader>

          {total === 0 && !loaded ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center" aria-busy="true">
              <p className="text-white/45 text-sm">
                {loadError
                  ? "Aura can't read your history file right now (another program may have it open). Retrying..."
                  : "Loading your history..."}
              </p>
            </div>
          ) : total === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center">
              <p className="text-white/55 text-sm">
                Watch something to start a history. Plays you finish and
                episodes you skip appear here; marking something watched by
                hand doesn't.
              </p>
            </div>
          ) : shown.length === 0 ? (
            <div className="glass-panel rounded-2xl px-6 py-10 text-center space-y-3">
              <p className="text-white/55 text-sm">
                {deferredQuery.trim()
                  ? <>No plays match <span className="text-white/80">&ldquo;{deferredQuery.trim()}&rdquo;</span>{titleInfo ? <> in {titleInfo.name}</> : null}{kind !== "all" ? " for this type" : ""}.</>
                  : "No plays match these filters."}
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className={`${PILL} bg-white/5 text-white/75 border-white/15 hover:bg-white/10 hover:text-white`}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <VirtualHistoryList
              layout={layout}
              cols={cols}
              scrollRef={scrollRef}
              headerRef={headerRef}
              handleRef={listHandle}
              onCols={setCols}
              onTopDay={setTopDay}
              flashDay={flashDay}
              onSelectMeta={onSelectMeta}
              conn={conn}
              selected={selected}
              selectionActive={selectionActive}
              onToggleEntry={toggleEntry}
              onToggleDay={toggleDay}
              onShowTitle={showTitle}
              titleFilterActive={titleFilter !== null}
              scrobbledVersion={scrobbledVersion}
              runActive={busy}
              filterSig={filterSig}
            />
          )}

          {/* Bottom padding so the globally-rendered ScrobbleRunBar (fixed,
              bottom-centre, only while a bulk job runs) never covers the last
              row. The selection actions no longer float, so they need none. */}
          {busy && <div className="h-16" aria-hidden />}
        </div>
      </div>

      {jumpOpen && layout.dayKeys.length > 0 && jumpBtnRef.current && (
        <HistoryDateJump
          anchor={jumpBtnRef.current}
          dayCounts={layout.dayCounts}
          daySecs={layout.daySecs}
          daySkips={layout.daySkips}
          oldestKey={layout.dayKeys[layout.dayKeys.length - 1] ?? null}
          currentKey={topDay}
          onJump={jumpTo}
          onClose={closeJump}
        />
      )}

      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The windowed list. Owns the scroll-driven range so a scroll re-renders only
// this component (and only when the set of mounted items changes), never the
// page header above it.
// ---------------------------------------------------------------------------

interface ListHandle {
  scrollToDay: (dayKey: string) => void;
}

interface ListProps {
  layout: HistoryLayout;
  /** Card columns the layout was built for. */
  cols: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** The sticky page header: what a jump has to clear. */
  headerRef: React.RefObject<HTMLDivElement | null>;
  handleRef: React.MutableRefObject<ListHandle | null>;
  onCols: (cols: number) => void;
  onTopDay: (dayKey: string | null) => void;
  flashDay: string | null;
  onSelectMeta?: (meta: MetaPreview) => void;
  conn: ScrobbleConnState;
  selected: Set<string>;
  selectionActive: boolean;
  onToggleEntry: (e: HistoryEntry) => void;
  onToggleDay: (entries: IndexedEntry[]) => void;
  onShowTitle: (titleKey: string) => void;
  titleFilterActive: boolean;
  scrobbledVersion: number;
  runActive: boolean;
  /** Changes with the search / title / type filter (never with a removal):
   *  a new filter starts its list from the top. */
  filterSig: string;
}

const VirtualHistoryList = memo(function VirtualHistoryList({
  layout, cols, scrollRef, headerRef, handleRef, onCols, onTopDay, flashDay,
  onSelectMeta, conn, selected, selectionActive, onToggleEntry, onToggleDay,
  onShowTitle, titleFilterActive, scrobbledVersion, runActive, filterSig,
}: ListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Read by the scroll handler, which is bound once: refs, so it never needs
  // re-binding (and never pays a getBoundingClientRect per scroll event).
  const layoutRef = useRef(layout);
  const listTopRef = useRef(0);
  const clearanceRef = useRef(0);
  /** The layout the scroll position was last true for, and that position. */
  const anchoredLayoutRef = useRef(layout);
  const scrollPosRef = useRef(0);
  // First paint: whatever fits a window-tall viewport, so the page shows its
  // first screen at once; the layout effect below refines it before paint.
  const [range, setRange] = useState<[number, number]>(() =>
    visibleRange(layout, 0, (typeof window !== "undefined" ? window.innerHeight : 1080) + OVERSCAN_PX),
  );
  const [clearance, setClearance] = useState(0);

  // The item holding keyboard focus stays mounted when it leaves the window:
  // unmounting it drops focus to <body>, and PageDown then has no scroller to
  // start from. By KEY (its data-hist-item), since a rebuild moves indexes. One
  // item at most, never a stretched range. A date jump or a filter reset may
  // leave it far from the viewport, which costs one card, and Tab still works
  // from it.
  const [pinKey, setPinKey] = useState<string | null>(null);
  const pinned = useMemo(() => {
    if (!pinKey) return null;
    if (pinKey.startsWith("d:")) {
      const i = layout.dayItem.get(pinKey.slice(2));
      return i == null ? null : { i, col: 0 };
    }
    const playKey = pinKey.slice(2);
    for (let i = 0; i < layout.items.length; i++) {
      const item = layout.items[i];
      if (item.kind !== "row") continue;
      const col = item.entries.findIndex((it) => it.key === playKey);
      if (col >= 0) return { i, col };
    }
    return null; // Removed or filtered out: nothing to keep.
  }, [pinKey, layout]);
  // React sees no focusout when the focused control itself unmounts (a removed
  // card, the pills going as a selection starts).
  useEffect(() => {
    if (pinKey && !listRef.current?.contains(document.activeElement)) setPinKey(null);
  }, [pinKey, layout, range]);

  // The scroll container is an ANCESTOR, and React attaches a host element's
  // ref only after its subtree's layout effects ran. When this list mounts in
  // the same commit as the page (the normal visit: the store is hydrated before
  // the History tab opens), scrollRef.current is still null in the layout
  // effects below, and the measure effect, whose deps never change, bailed for
  // the whole visit: 4 columns at any width, no resize handling, a 0 px focus
  // clearance. The list's own ref IS attached by then (a descendant), so read
  // the container from it until the parent's ref lands. Stable: deps are refs.
  const getScroll = useCallback(
    () => scrollRef.current
      ?? listRef.current?.closest<HTMLDivElement>("[data-history-scroll]")
      ?? null,
    [scrollRef],
  );

  const compute = useCallback(() => {
    const scroll = getScroll();
    const L = layoutRef.current;
    // Hidden: left as it was, or the window collapses to the top of the list
    // (mounting rows nobody sees). Showing the page again re-measures.
    if (!scroll || hasNoBox(scroll)) return;
    scrollPosRef.current = scroll.scrollTop;
    const within = scroll.scrollTop - listTopRef.current;
    const [a, b] = visibleRange(L, within - OVERSCAN_PX, within + scroll.clientHeight + OVERSCAN_PX);
    setRange((prev) => (prev[0] === a && prev[1] === b ? prev : [a, b]));
    // The day at the top edge of what is actually visible, i.e. just under
    // the sticky header. Before the list has scrolled under it, the newest.
    const n = L.items.length;
    if (n === 0) { onTopDay(null); return; }
    const at = Math.min(n - 1, firstItemAt(L, Math.max(0, within + clearanceRef.current)));
    onTopDay(L.items[at].dayKey);
  }, [getScroll, onTopDay]);

  // Hold the plays on screen still when the list is rebuilt under them (a column
  // change, a cloud merge, a removal above the viewport): scrollTop alone would
  // land on other dates. From the position compute() last saw, not a fresh read:
  // the shorter list's height is already in the DOM, so a read would be clamped.
  const reanchor = useCallback(() => {
    const scroll = getScroll();
    const prev = anchoredLayoutRef.current;
    const next = layoutRef.current;
    // Hidden: kept for the re-measure when the page shows again.
    if (!scroll || prev === next || hasNoBox(scroll)) return;
    anchoredLayoutRef.current = next;
    const pos = scrollPosRef.current;
    if (pos <= 0) return;
    const y = Math.max(0, pos - listTopRef.current + clearanceRef.current);
    const anchor = findAnchor(prev, firstItemAt(prev, y), next);
    if (!anchor) return;
    scroll.scrollTop = pos + next.tops[anchor.to] - prev.tops[anchor.from];
  }, [getScroll]);

  // A new filter starts its list from the top rather than at an arbitrary
  // depth of the previous one. A LAYOUT effect declared before the one below,
  // so the reset lands before that effect's compute and the new range commits
  // before paint. In the parent's passive effect it ran after the compute:
  // one frame of the new list at the old depth, then a frame of the top with
  // nothing mounted (the reset's scroll event renders after paint). Skips the
  // first render.
  const lastFilterSig = useRef(filterSig);
  useLayoutEffect(() => {
    if (lastFilterSig.current === filterSig) return;
    lastFilterSig.current = filterSig;
    // The reset wins: no position is carried over to the new list.
    anchoredLayoutRef.current = layout;
    const scroll = getScroll();
    if (!scroll || scroll.scrollTop === 0) return;
    scroll.scrollTop = 0;
    // Computed here too, not left to the effect below: a filter can change
    // without changing the layout (a type pill whose slice is the same
    // list), and that effect would then not run.
    layoutRef.current = layout;
    compute();
  }, [filterSig, getScroll, layout, compute]);

  useLayoutEffect(() => {
    layoutRef.current = layout;
    reanchor();
    compute();
  }, [layout, reanchor, compute]);

  // Measure before paint: the column count (from the list's width), where the
  // list starts inside the scroll content (the header above it changes height
  // when its filter row wraps or a chip appears), and the sticky header's
  // bottom edge, which a jump must land below.
  useLayoutEffect(() => {
    const scroll = getScroll();
    const list = listRef.current;
    if (!scroll || !list) return;
    const measure = () => {
      if (hasNoBox(scroll)) return;
      const w = list.clientWidth;
      if (w > 0) {
        const c = Math.max(2, Math.min(4, Math.floor((w + METRICS.rowGap) / (MIN_CARD_W + METRICS.rowGap))));
        onCols(c);
      }
      const top = list.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
      listTopRef.current = top;
      const hh = headerRef.current?.offsetHeight ?? 0;
      const clear = STICKY_TOP + hh + JUMP_MARGIN;
      clearanceRef.current = clear;
      setClearance((prev) => (prev === clear ? prev : clear));
      reanchor();
      compute();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    ro.observe(scroll);
    if (headerRef.current) ro.observe(headerRef.current);
    return () => ro.disconnect();
  }, [getScroll, headerRef, onCols, reanchor, compute]);

  useEffect(() => {
    const scroll = getScroll();
    if (!scroll) return;
    scroll.addEventListener("scroll", compute, { passive: true });
    return () => scroll.removeEventListener("scroll", compute);
  }, [getScroll, compute]);

  useEffect(() => {
    handleRef.current = {
      scrollToDay: (dayKey) => {
        const scroll = getScroll();
        const L = layoutRef.current;
        const i = L.dayItem.get(dayKey);
        if (!scroll || i == null) return;
        // Instant, not smooth: a jump can cross years of history, and a
        // smooth scroll would mount and unmount every row on the way.
        scroll.scrollTop = i === 0
          ? 0
          : Math.max(0, listTopRef.current + L.tops[i] - clearanceRef.current);
        // Mount the target's rows NOW. Left to the native scroll event, the
        // range update renders at continuous priority in a task AFTER the
        // next paint, so a jump past the overscan painted one frame of empty
        // page under the sticky header. Called from a click, never from a
        // render or an effect, so flushSync is allowed here.
        flushSync(compute);
      },
    };
    return () => { handleRef.current = null; };
  }, [handleRef, getScroll, compute]);

  const todayKey = dayKeyOfDate(new Date());
  const yest = new Date();
  yest.setDate(yest.getDate() - 1);
  const yesterdayKey = dayKeyOfDate(yest);

  const [start, end] = range;
  const last = Math.min(end, layout.items.length);
  const nodes: React.ReactNode[] = [];
  const pushItem = (i: number, onlyCol?: number) => {
    const item = layout.items[i];
    // Numbers, not a style object: a fresh object per render would defeat the
    // items' memo on every scroll step.
    const top = layout.tops[i];
    const height = layout.heights[i];
    if (item.kind === "day") {
      nodes.push(
        <DayHeader
          key={item.key}
          itemKey={item.key}
          top={top}
          height={height}
          label={prettyDay(item.dayKey, todayKey, yesterdayKey)}
          entries={item.entries}
          totalSecs={item.totalSecs}
          selected={selected}
          onToggleDay={onToggleDay}
          flash={flashDay === item.dayKey}
        />,
      );
    } else {
      // Rows exist only in the layout maths: every CARD is its own sibling
      // here, keyed by its play. Keyed rows (by their first play) remounted
      // every later card of a day when one play was removed, and nearly
      // every card on a column-count change, replaying each poster's shimmer
      // and fade. Keyed per play, a removal only moves the cards after it.
      for (let col = 0; col < item.entries.length; col++) {
        if (onlyCol !== undefined && col !== onlyCol) continue;
        const it = item.entries[col];
        nodes.push(
          <CardCell
            key={`c:${it.key}`}
            top={top}
            height={height}
            col={col}
            cols={cols}
            item={it}
            isSelected={selected.has(it.key)}
            onSelectMeta={onSelectMeta}
            conn={conn}
            selectionActive={selectionActive}
            onToggleEntry={onToggleEntry}
            onShowTitle={onShowTitle}
            titleFilterActive={titleFilterActive}
            scrobbledVersion={scrobbledVersion}
            runActive={runActive}
          />,
        );
      }
    }
  };
  // In index order: a pinned node out of order makes React MOVE it in the DOM,
  // and a moved element loses focus. It also keeps the Tab order right.
  const pinBefore = pinned !== null && pinned.i < start;
  const pinAfter = pinned !== null && !pinBefore && pinned.i >= last;
  if (pinBefore) pushItem(pinned.i, pinned.col);
  for (let i = start; i < last; i++) pushItem(i);
  if (pinAfter) pushItem(pinned.i, pinned.col);

  return (
    <div
      ref={listRef}
      onFocus={(e) => {
        setPinKey((e.target as Element).closest("[data-hist-item]")?.getAttribute("data-hist-item") ?? null);
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (to instanceof Node && e.currentTarget.contains(to)) return;
        // The window losing focus: the control stays active and gets it back.
        if (document.activeElement === e.target) return;
        setPinKey(null);
      }}
      // Every focusable control in the list is a <button> (cards are plain
      // divs), so one descendant rule keeps keyboard focus clear of the
      // sticky header. Chromium scrolls focus into view only when the target
      // leaves the scrollport, so without it a control under the stuck
      // header took focus invisibly. The clearance is measured, since the
      // header's height depends on its filter row.
      className="relative [&_button]:scroll-mt-[var(--hist-clear)]"
      style={{
        height: layout.totalHeight,
        ["--hist-clear" as string]: `${clearance}px`,
      }}
    >
      {nodes}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Page header, which becomes the selection toolbar.
// ---------------------------------------------------------------------------

/** Shared pill geometry, so both states sit at exactly the same height and the
 *  swap never shifts the page. */
const PILL = "px-3.5 py-1.5 rounded-full text-xs font-medium border transition-colors "
  + "disabled:opacity-40 disabled:cursor-default";

/**
 * A scrobble pill with a menu half. The main half runs every connected
 * service; the arrow opens "<label> to Trakt / AniList / Simkl", one row per
 * connected service. With a single service connected the two would be the
 * same action, so the arrow is left off and it is a plain pill.
 */
function ScrobbleSplitButton({
  label, services, busy, strong = false, onRun,
}: {
  label: string;
  services: ScrobbleService[];
  busy: boolean;
  /** Selection mode's slightly stronger accent. */
  strong?: boolean;
  onRun: (only?: ScrobbleService) => void;
}) {
  const tone = strong
    ? "bg-ln-accent/20 text-ln-accent border-ln-accent/45 hover:bg-ln-accent/30 hover:text-white"
    : "bg-ln-accent/15 text-ln-accent border-ln-accent/35 hover:bg-ln-accent/25 hover:text-white";
  const base = "py-1.5 text-xs font-medium border transition-colors "
    + "disabled:opacity-40 disabled:cursor-default";
  if (services.length < 2) {
    return (
      <button type="button" disabled={busy} onClick={() => onRun()} className={`${PILL} ${tone}`}>
        {label}
      </button>
    );
  }
  return (
    <div className="flex items-stretch">
      <button
        type="button"
        disabled={busy}
        onClick={() => onRun()}
        className={`${base} ${tone} pl-3.5 pr-3 rounded-l-full`}
      >
        {label}
      </button>
      <Tooltip text="Scrobble to one service" pos="bottom">
        <button
          type="button"
          disabled={busy}
          aria-label={`${label} to one service`}
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            openContextMenu(r.left, r.bottom + 4, services.map((service) => ({
              label: `${label} to ${SCROBBLE_LABELS[service]}`,
              onClick: () => onRun(service),
            })));
          }}
          className={`${base} ${tone} pl-2 pr-2.5 rounded-r-full border-l-0 h-full grid place-items-center`}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
      </Tooltip>
    </div>
  );
}

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
  headerRef, total, loading, shownCount, shownSecs, filtered, selectedCount, hiddenSelected,
  allShownSelected, stuck, services, busy,
  onScrobbleAll, onScrobbleShown, onSelectShown, onClearHistory, onScrobbleSelected,
  onRemoveSelected, onCancelSelection, children,
}: {
  headerRef: React.RefObject<HTMLDivElement | null>;
  total: number;
  /** The store has not hydrated yet (see HistoryViewBody's `loaded`). */
  loading?: boolean;
  /** Plays the current filter shows (= total with no filter). */
  shownCount: number;
  /** Watch time of the shown plays. */
  shownSecs: number;
  /** A search, title or type filter is on. */
  filtered: boolean;
  selectedCount: number;
  /** Selected plays the current filter hides. */
  hiddenSelected: number;
  allShownSelected: boolean;
  stuck: boolean;
  /** Connected scrobble services, in display order. */
  services: ScrobbleService[];
  /** A bulk scrobble job is running (module-level, see scrobbleRun.ts). */
  busy: boolean;
  /** No argument: every connected service. A service: that one only. */
  onScrobbleAll: (only?: ScrobbleService) => void;
  /** Same, over the filtered plays only. */
  onScrobbleShown: (only?: ScrobbleService) => void;
  /** Add every shown play to the selection. */
  onSelectShown: () => void;
  onClearHistory: () => void;
  onScrobbleSelected: (only?: ScrobbleService) => void;
  onRemoveSelected: () => void;
  onCancelSelection: () => void;
  /** The filter row, rendered under the mode row in both modes. */
  children?: React.ReactNode;
}) {
  const selecting = selectedCount > 0;
  const anyService = services.length > 0;

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
  // The mirror case: "Select N shown" sits rightmost at rest, exactly where
  // "Remove N" lands once the selection exists, so a double-click on it
  // would open the remove confirm. Same guard, the other way round.
  const enteredSelectionAt = useRef(0);
  // The entering mirror of restoreFocusOnExit: "Select N shown" unmounts
  // itself the same way (the rest row is keyed away), so a keyboard press on
  // it dropped focus to <body> and left Scrobble N / Remove N a tab walk from
  // the top of the document away. Focus goes to the selected count, whose
  // next tab stop is that cluster. Only for this button: a selection started
  // from a card must leave focus in the list.
  const focusCountOnEnter = useRef(false);
  const countRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (wasSelecting.current && !selecting) {
      leftSelectionAt.current = performance.now();
      if (restoreFocusOnExit.current) titleRef.current?.focus({ preventScroll: true });
    }
    if (!wasSelecting.current && selecting) {
      enteredSelectionAt.current = performance.now();
      if (focusCountOnEnter.current) countRef.current?.focus({ preventScroll: true });
    }
    restoreFocusOnExit.current = false;
    focusCountOnEnter.current = false;
    wasSelecting.current = selecting;
  }, [selecting]);
  const clearHistoryGuarded = () => {
    if (performance.now() - leftSelectionAt.current < 450) return;
    onClearHistory();
  };
  const removeSelectedGuarded = () => {
    if (performance.now() - enteredSelectionAt.current < 450) return;
    onRemoveSelected();
  };

  return (
    <div ref={headerRef} className="sticky top-3 z-20 -mx-4">
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
                <p
                  ref={countRef}
                  tabIndex={-1}
                  className="text-3xl font-semibold tracking-tight text-white outline-none"
                >
                  <span className="text-ln-accent tabular-nums">{selectedCount}</span> selected
                </p>
                <p className="text-white/45 text-sm mt-1">
                  of {total}
                  {hiddenSelected > 0 && (
                    <span className="text-ln-accent/85">
                      {` · ${hiddenSelected} hidden by the filter`}
                    </span>
                  )}
                  {" · click a card to add or remove it"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {/* Grows a selection to everything the filter shows: "select a
                  day" for a whole search result or a whole title. */}
              {!allShownSelected && shownCount > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onSelectShown}
                  className={`${PILL} bg-white/5 text-white/75 border-white/15 hover:bg-white/10 hover:text-white`}
                >
                  {filtered ? `Select all ${shownCount} shown` : `Select all ${shownCount}`}
                </button>
              )}
              {anyService && (
                <ScrobbleSplitButton
                  label={`Scrobble ${selectedCount}`}
                  services={services}
                  busy={busy}
                  strong
                  onRun={onScrobbleSelected}
                />
              )}
              <button
                type="button"
                disabled={busy}
                onClick={removeSelectedGuarded}
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
              <p className="text-white/35 text-sm mt-1 tabular-nums">
                {total === 0 && loading
                  ? "Loading..."
                  : total === 0
                  ? "Your watch history is empty. Items you finish playing, or skip, show up here automatically."
                  : filtered
                    ? `${shownCount} of ${total} item${total === 1 ? "" : "s"} shown${shownSecs > 0 ? ` · ${formatDuration(shownSecs)} watched` : ""}`
                    : `${total} item${total === 1 ? "" : "s"} from playback and skips${shownSecs > 0 ? ` · ${formatDuration(shownSecs)} watched` : ""}`}
              </p>
            </div>
            {/* With a filter on, the actions here act on what is SHOWN and
                say so; the whole-history pair returns once it is off. A
                "Clear history" next to a filtered list reads as "clear
                these", which it never did. */}
            {total > 0 && !filtered && (
              <div className="flex items-center gap-2">
                {anyService && (
                  <ScrobbleSplitButton
                    label="Scrobble All"
                    services={services}
                    busy={busy}
                    onRun={onScrobbleAll}
                  />
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
            {filtered && shownCount > 0 && (
              <div className="flex items-center gap-2">
                {anyService && (
                  <ScrobbleSplitButton
                    label={`Scrobble ${shownCount} shown`}
                    services={services}
                    busy={busy}
                    onRun={onScrobbleShown}
                  />
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => { focusCountOnEnter.current = true; onSelectShown(); }}
                  className={`${PILL} bg-white/5 text-white/70 border-white/10 hover:bg-white/10 hover:text-white`}
                >
                  Select {shownCount} shown
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {children}
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
// Day grouping: the header line (with its running total) and the card rows
// are SEPARATE list items, so a day with 40 plays mounts only the rows of it
// that are near the viewport.
// ---------------------------------------------------------------------------

/** Memoised: a bulk run ticks `progress` on every push, and without this the
 *  visible list would re-render hundreds of times mid-run. None of these
 *  props change per tick. */
const DayHeader = memo(function DayHeader({
  itemKey, top, height, label, entries, totalSecs, selected, onToggleDay, flash,
}: {
  itemKey: string;
  top: number;
  height: number;
  label: string;
  /** The day's SHOWN rows (the current filter's slice of it). */
  entries: IndexedEntry[];
  totalSecs: number;
  selected: Set<string>;
  onToggleDay: (entries: IndexedEntry[]) => void;
  /** Just jumped to: a brief accent wash so the eye finds it. */
  flash: boolean;
}) {
  let selectedInDay = 0;
  // Skip rows are not plays: the same split as buildLayout, so this line and
  // the calendar's readout agree.
  let skips = 0;
  for (const it of entries) {
    if (selected.has(it.key)) selectedInDay++;
    if (it.entry.skipped) skips++;
  }
  const plays = entries.length - skips;
  const allSelected = selectedInDay === entries.length && entries.length > 0;
  const someSelected = selectedInDay > 0 && !allSelected;

  return (
    <header
      data-hist-item={itemKey}
      style={{ position: "absolute", left: 0, right: 0, top, height }}
      className={`group/day flex items-end justify-between gap-3 border-b pb-2 px-2 -mx-2 rounded-t-lg
                  transition-colors duration-500 [html[data-reduced-motion="true"]_&]:transition-none
                  ${flash ? "bg-ln-accent/15 border-ln-accent/60" : "bg-transparent border-white/8"}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        {/* Select every shown play on this date. Hidden until hover unless
            the day already has a selection, so the header stays clean at
            rest. */}
        <div className={`transition-opacity ${allSelected || someSelected ? "opacity-100" : "opacity-0 group-hover/day:opacity-100 focus-within:opacity-100"}`}>
          <SelectBox
            checked={allSelected}
            indeterminate={someSelected}
            onToggle={() => onToggleDay(entries)}
            label={`Select all ${entries.length} item${entries.length === 1 ? "" : "s"} on ${label}`}
          />
        </div>
        <ClockIcon />
        <h2 className="text-white/85 text-lg font-semibold truncate">
          {label}
        </h2>
        <span className="text-white/35 text-xs font-mono shrink-0">
          {plays > 0 && `${plays} ${plays === 1 ? "play" : "plays"}`}
          {plays > 0 && skips > 0 && ", "}
          {skips > 0 && `${skips} skipped`}
        </span>
      </div>
      {totalSecs > 0 && (
        <p className="text-white/35 text-xs font-mono tabular-nums shrink-0">
          {formatDuration(totalSecs)}
        </p>
      )}
    </header>
  );
});

/** One card at its place in the grid: the row's top, and a column's share of
 *  the list's width (the same tracks the old `repeat(cols, 1fr)` grid with a
 *  rowGap gap drew). Memoised on numbers and a boolean, not the selection Set,
 *  so a selection change re-renders only the cards whose state flipped. */
const CardCell = memo(function CardCell({
  top, height, col, cols, item, isSelected, onSelectMeta, conn, selectionActive, onToggleEntry,
  onShowTitle, titleFilterActive, scrobbledVersion, runActive,
}: {
  top: number;
  height: number;
  col: number;
  cols: number;
  item: IndexedEntry;
  isSelected: boolean;
  onSelectMeta?: (meta: MetaPreview) => void;
  conn: ScrobbleConnState;
  selectionActive: boolean;
  onToggleEntry: (e: HistoryEntry) => void;
  onShowTitle: (titleKey: string) => void;
  titleFilterActive: boolean;
  scrobbledVersion: number;
  runActive: boolean;
}) {
  const gap = METRICS.rowGap;
  const track = `((100% - ${(cols - 1) * gap}px) / ${cols})`;
  return (
    <div
      data-hist-item={`c:${item.key}`}
      style={{
        position: "absolute", top, height,
        left: `calc(${track} * ${col} + ${col * gap}px)`,
        width: `calc${track}`,
        display: "grid",
      }}
    >
      <HistoryCard
        item={item}
        onSelectMeta={onSelectMeta}
        conn={conn}
        isSelected={isSelected}
        selectionActive={selectionActive}
        onToggleSelect={onToggleEntry}
        onShowTitle={onShowTitle}
        titleFilterActive={titleFilterActive}
        scrobbledVersion={scrobbledVersion}
        runActive={runActive}
      />
    </div>
  );
});

// ---------------------------------------------------------------------------
// In-flight row pushes, keyed by play. Module-level rather than card state
// because a card REMOUNTS mid-push (scrolled out of the window and back, or
// the page left and reopened): a useState guard came back null while the
// first invoke was still pending, its buttons re-enabled, and confirmRepeat
// could not catch a second press either (the scrobbled mark lands only when
// the push resolves). Bounded by construction: an entry lives exactly as long
// as one push, removed in its `finally`.
// ---------------------------------------------------------------------------

const rowPushes = new Map<string, ScrobbleService>();
const rowPushListeners = new Set<() => void>();

function setRowPush(key: string, service: ScrobbleService | null) {
  if (service) rowPushes.set(key, service);
  else rowPushes.delete(key);
  for (const l of rowPushListeners) l();
}

function subscribeRowPushes(listener: () => void) {
  rowPushListeners.add(listener);
  return () => { rowPushListeners.delete(listener); };
}

// ---------------------------------------------------------------------------
// Single entry card.
// ---------------------------------------------------------------------------

/** When a row was last removed. Module-level: the X press it guards lands on a
 *  different card instance (see the X's onClick). */
let lastRowRemoveAt = 0;

const HistoryCard = memo(function HistoryCard({
  item, onSelectMeta, conn, isSelected, selectionActive, onToggleSelect, onShowTitle,
  titleFilterActive, scrobbledVersion, runActive,
}: {
  item: IndexedEntry;
  onSelectMeta?: (meta: MetaPreview) => void;
  conn: ScrobbleConnState;
  isSelected: boolean;
  selectionActive: boolean;
  onToggleSelect: (e: HistoryEntry) => void;
  /** Filter the page to every play of this card's title. */
  onShowTitle: (titleKey: string) => void;
  /** The page already shows one title: its "every play" action is moot. */
  titleFilterActive: boolean;
  /** Only here to invalidate the memo when the scrobbled record changes; the
   *  done-state itself is read straight from the store below. */
  scrobbledVersion: number;
  /** A bulk job is in flight — this row's buttons go inert. */
  runActive: boolean;
}) {
  void scrobbledVersion;
  const entry = item.entry;
  // null = idle; otherwise the service whose push is in flight. Blocks
  // both buttons while either is running so a double-click can't fire two
  // overlapping writes for the same row. Read from the module-level record
  // (see rowPushes), so it survives this card remounting mid-push.
  const pushKey = item.key;
  const busy = useSyncExternalStore(
    subscribeRowPushes,
    () => rowPushes.get(pushKey) ?? null,
  );
  const setBusy = (service: ScrobbleService | null) => setRowPush(pushKey, service);

  const eligible = servicesFor(entry, conn);
  const showTrakt = eligible.includes("trakt");
  const showAnilist = eligible.includes("anilist");
  const showSimkl = eligible.includes("simkl");

  const epLabel = episodeLabel(entry);
  const epLine = epLabel
    ? `${epLabel}${entry.episode_title ? ` · ${entry.episode_title}` : ""}`
    : null;

  /** A push for a service already recorded on this row is a repeat: say so
   *  and let the user confirm it (the shared dialog: the card has no hook of
   *  its own). False when declined. */
  const confirmRepeat = async (service: ScrobbleService): Promise<boolean> => {
    if (!isScrobbled(conn.scope, service, entry.id, entry.played_at)) return true;
    const label = SCROBBLE_LABELS[service];
    return askConfirm({
      title: "Scrobble again?",
      message: `${entry.name}${epLabel ? ` ${epLabel}` : ""} is already scrobbled to ${label}. Send it again as a repeat?`,
      detail: repeatDetail([label]),
      confirmLabel: "Scrobble again",
      tone: "accent",
    });
  };

  const scrobble = async (service: RowHistoryService) => {
    if (rowPushes.has(pushKey)) return;
    const repeat = isScrobbled(conn.scope, service, entry.id, entry.played_at);
    if (!(await confirmRepeat(service))) return;
    // Again after the dialog: a remounted copy of this card may have started
    // a push while it was open.
    if (rowPushes.has(pushKey)) return;
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
        // Trakt's title + air-date fallback; the other commands ignore them.
        episodeTitle:    entry.episode_title ?? null,
        episodeReleased: entry.episode_released ?? null,
      });
      markScrobbled(conn.scope, service, entry.id, entry.played_at);
      showAppToast(message, { tone: "success" });
    } catch (err) {
      const raw = String(err);
      // Same retirement rule as the bulk runner: a verdict about the item means a
      // bulk run should stop re-sending it too. The marker never reaches the user.
      // Never for a repeat: the service took this item before.
      if (isPermanentFailure(raw) && !repeat) {
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
    if (rowPushes.has(pushKey)) return;
    const repeat = isScrobbled(conn.scope, "simkl", entry.id, entry.played_at);
    if (!(await confirmRepeat("simkl"))) return;
    if (rowPushes.has(pushKey)) return;
    setBusy("simkl");
    try {
      const [result] = await pushSimklHistory(conn.scope, [simklItemFromEntry(entry)]);
      if (result.status === "added") {
        markScrobbled(conn.scope, "simkl", entry.id, entry.played_at);
        showAppToast(result.message, { tone: "success" });
        return;
      }
      if ((result.status === "not_found" || result.status === "skipped") && !repeat) {
        markIneligible(conn.scope, "simkl", entry.id);
      }
      showAppToast(result.message, { tone: "danger", duration: 6000 });
    } catch (err) {
      showAppToast(String(err), { tone: "danger", duration: 6000 });
    } finally {
      setBusy(null);
    }
  };

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

  const remove = () => {
    if (!removeHistoryEntry(entry.id, entry.played_at)) {
      showAppToast(REMOVE_REFUSED, { tone: "danger", duration: 6000 });
      return;
    }
    lastRowRemoveAt = performance.now();
    showAppToast("Removed from history");
  };

  // Right-click: the card's actions in one place, including the two that
  // have no hover control of their own ("every play of this title" while the
  // hover row is busy with scrobble pills, and Select outside selection mode).
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, [
      { label: "Open details", onClick: () => onSelectMeta?.(meta), disabled: !onSelectMeta },
      {
        label: "Show every play of this title",
        hint: "Filters History to this title. Clear the chip next to the search to go back.",
        onClick: () => onShowTitle(item.titleKey),
        disabled: titleFilterActive,
      },
      { label: isSelected ? "Deselect" : "Select", onClick: () => onToggleSelect(entry) },
      { kind: "divider" },
      { label: "Remove from history", tone: "danger", onClick: remove },
    ]);
  };

  return (
    <div
      className={`group relative card-contain rounded-xl overflow-hidden h-full
                  bg-white/4 border cursor-pointer transition-colors
                  ${isSelected
                    ? "border-ln-accent/70 bg-ln-accent/10"
                    : "border-white/8 hover:border-white/20"}`}
      // While a selection is active the card toggles instead of navigating, so
      // building a selection never bounces the user off the page by accident.
      // A real click on a card navigates away, so a second press of a
      // double-click here began on a control that rebuilt the list under the
      // pointer ("every play", Clear filters).
      onClick={(e) => {
        if (selectionActive) onToggleSelect(entry);
        else if (e.detail < 2) onSelectMeta?.(meta);
      }}
      onContextMenu={onContextMenu}
    >
      <div className="flex items-stretch gap-3 p-2 h-full">
        {/* Poster thumb: a small portrait so the card stays compact. Its
            height (102 px) is what sets the card's, which the list's fixed
            row height (METRICS.rowH) relies on. */}
        <div
          className="relative flex-shrink-0 w-[68px] h-[102px] rounded-md overflow-hidden bg-white/5 border border-white/10"
        >
          {entry.poster ? (
            <ImageLoader
              // ~68 CSS px at up to 2.5x DPI. The default 360 decoded a
              // poster five times the size this thumb can show.
              src={shrinkPoster(entry.poster, 180)}
              alt={entry.name}
              // Eager: the list already mounts only near-viewport rows, so a
              // per-card IntersectionObserver would be one more observer per
              // card for no saving (same call as Library's grid).
              loading="eager"
              className="absolute inset-0 w-full h-full"
              imgClassName="w-full h-full object-cover"
            />
          ) : null}
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 overflow-hidden">
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
          {/* One line, truncated: a long episode title used to wrap and grow
              the card, and every card must keep the row's fixed height. */}
          {epLine && (
            <p className="text-white/55 text-[11px] font-mono tracking-wider truncate" title={epLine}>
              {epLine}
            </p>
          )}
          <p className="text-white/35 text-[10.5px] mt-0.5 font-mono tabular-nums truncate">
            {TIME_FMT.format(item.ts)} · {typeLabel(entry.media_type ?? "other")}
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
          service already recorded for this row renders as a done tick that can
          still be pressed: it sends the push again after a prompt that says it
          is a repeat (confirmRepeat). Suppressed entirely while a
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

      {/* Hover "every play of this title": the quickest way from one play
          of a show to its whole watch log. Left of the X, never under it. */}
      {!selectionActive && !titleFilterActive && (
        <button
          type="button"
          aria-label={`Show every play of ${entry.name}`}
          title="Show every play of this title"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onShowTitle(item.titleKey);
          }}
          className="absolute top-1.5 right-9 w-6 h-6 rounded-full
                     bg-black/70 border border-white/20
                     text-white/85 hover:text-white hover:bg-ln-accent/40
                     hover:border-ln-accent/60
                     flex items-center justify-center
                     opacity-0 group-hover:opacity-100 focus:opacity-100
                     transition-all duration-150 z-10"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M3 5h2v2H3V5zm4 0h14v2H7V5zM3 11h2v2H3v-2zm4 0h14v2H7v-2zm-4 6h2v2H3v-2zm4 0h14v2H7v-2z" />
          </svg>
        </button>
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
            // Same swap-under-the-pointer rule as clearHistoryGuarded: the next
            // card takes this slot at once, its X on the same pixel, and a
            // remove has no confirm or undo. Keyboard (detail 0) is exempt.
            if (e.detail > 0 && (e.detail > 1 || performance.now() - lastRowRemoveAt < 450)) return;
            remove();
          }}
          className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full
                     bg-black/70 border border-white/20
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

/** Where a scrobble lives on, for the remove prompts. Simkl is named only in a
 *  build that can sign in to it. */
function scrobbleHomes(): string {
  return knownScrobbleServicesAvailable()?.has("simkl")
    ? "Trakt / AniList / Simkl"
    : "Trakt / AniList";
}

/** What a repeat push does, for the prompts that offer one. Aura re-sends
 *  through the same commands, so each service answers a repeat its own way:
 *  AniList keeps one progress number (save_progress no-ops when it is already
 *  there), Trakt and Simkl get the same play, with the same watched time,
 *  again. */
function repeatDetail(services: string[]): string {
  const others = services.filter((s) => s !== SCROBBLE_LABELS.anilist);
  const parts: string[] = [];
  if (others.length > 0) {
    parts.push(
      `${others.join(" and ")} ${others.length === 1 ? "gets" : "get"} the same play again, with the same watched time: `
      + "useful when it was removed there, and the service decides whether it counts twice.",
    );
  }
  if (services.includes(SCROBBLE_LABELS.anilist)) {
    parts.push("AniList keeps one progress number per show, so it changes only if your progress there is now lower.");
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Scrobble action pill, shared by the Trakt / AniList / Simkl buttons on a card.
// Shows a spinner while its push is in flight; disabled while EITHER
// service on the row is running. `done` renders the already-scrobbled state,
// still pressable for a repeat.
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
  const title = unavailable
    ? `${label} has no catalog match for this item`
    : done
      ? `Already scrobbled to ${label}. Click to send it again`
      : `Scrobble to ${label}`;
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled || unavailable}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        onClick();
      }}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full
                  text-[10.5px] font-medium leading-none
                  transition-colors
                  disabled:cursor-default
                  ${unavailable
                    ? "bg-white/5 text-white/30 border border-white/10 line-through"
                    : done
                      ? "bg-emerald-400/15 text-emerald-200 border border-emerald-300/35 hover:bg-emerald-400/25 disabled:opacity-50"
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

/** Local-time Date for a YYYY-MM-DD key. */
function dateOfKey(key: string): Date {
  return new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
}

/** "Today" / "Yesterday" / "Friday, May 1, 2026". The two relative keys are
 *  computed once per list render by the caller, not once per header. */
function prettyDay(key: string, todayKey: string, yesterdayKey: string): string {
  if (key === todayKey) return "Today";
  if (key === yesterdayKey) return "Yesterday";
  const d = dateOfKey(key);
  return Number.isNaN(d.getTime()) ? key : DAY_FMT.format(d);
}

/** "October 2026", for the jump button's where-am-I readout. */
function monthLabel(key: string): string {
  const d = dateOfKey(key);
  return Number.isNaN(d.getTime()) ? key : MONTH_FMT.format(d);
}

function formatDuration(secs: number): string {
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const CalendarIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);

const ClockIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
       className="text-ln-accent/75" aria-hidden>
    <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
  </svg>
);
