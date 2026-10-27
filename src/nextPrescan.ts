// Next-episode pre-scan: the pure half. While an anime episode plays, App.tsx
// asks the skip detector (`skip_detect` action `prescan`) to run the REAL
// detection on the stream Next-Up pre-resolved for the next episode, in the
// background, so its result lands in the detector's per-file result cache and
// that episode's load is a cache hit (windows, theme-match states and the
// media end there at once, no HEAD / TAIL decode).
//
// Everything that DECIDES lives here (eligibility, which kinds, when the
// playing stream is healthy enough to share the link, when to abort, what to
// do after each reply); App.tsx owns the effects, the invoke calls and the
// logs. Import-free on purpose, like nextUpGate.ts: node loads it directly for
// the check script.

// Shortest file the detector reads the ending of for the Next-Up card alone
// (Endings set to Off): only one long enough that TAIL (the last 480 s, from
// the smaller of the container and the track's DURATION tag) cannot reach
// HEAD's 600 s. Where they overlap, a continuity ending found over the opening
// is withdrawn WITH a continuity opening (Rust `no_ed_inside_the_opening`, at
// any length: Kaiju No. 8's 224 s special), so an ending nobody skips could
// cost the user their opening. 600 + 480, plus 60 s for a tag below the
// container (the gaps measured were at most 29 s; Rust does not bound it, so
// this is a margin, not a guarantee). A card-only continuity ending could
// never raise the card anyway (Risky). The skip chain's `wantEdFor`, the
// next-episode theme prefetch and the pre-scan's kinds all read it.
export const CARD_ONLY_ED_MIN_DURATION_S = 600 + 480 + 60;

/** Attempts per (playing episode, next episode, stream url). An attempt is
 *  one prescan request that was really started; a `busy` reply is not one. */
export const PRESCAN_MAX_ATTEMPTS = 3;
/** `busy` replies tolerated per key before giving up (a live detect was
 *  running; each one waits for the live detect to settle first). */
export const PRESCAN_MAX_BUSY = 5;
/** Readahead the playing stream must have before a pre-scan starts, unless
 *  the demuxer already read it to the end. */
export const PRESCAN_START_CACHE_S = 30;
/** Readahead below which a running pre-scan is aborted, unless the demuxer
 *  already read the playing stream to the end. */
export const PRESCAN_ABORT_CACHE_S = 10;

export type PrescanSkipMode = "off" | "prompt" | "auto";

/** The `skip_detect` prescan reply's outcome (snake_case on the wire). */
export type PrescanOutcome = "done" | "cached" | "preempted" | "cancelled" | "busy" | "unavailable";

/** The stream is one the detector can read: http(s) only (Rust's
 *  `Request.validate` rejects anything else, and a magnet / info-hash-only
 *  entry has no url at all). */
export function prescanUrlEligible(url: string | null | undefined): boolean {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

/**
 * Which kinds to pre-scan, mirroring the live chain (`detect_op` /
 * `wantEdFor`) and the theme prefetch: the opening when its mode is not Off;
 * the ending when its mode is not Off, or for the Next-Up card alone (card on)
 * on a file of at least CARD_ONLY_ED_MIN_DURATION_S. The playing file's
 * duration stands in for the next episode's (unknown until it is probed; a
 * request for a superset of kinds is still served from the cache). Null when
 * no kind is wanted.
 */
export function prescanKinds(
  modes: { op: PrescanSkipMode; ed: PrescanSkipMode },
  nextUpOn: boolean,
  playingDuration: number,
): { op: boolean; ed: boolean } | null {
  const op = modes.op !== "off";
  const ed = modes.ed !== "off"
    || (nextUpOn && Number.isFinite(playingDuration) && playingDuration >= CARD_ONLY_ED_MIN_DURATION_S);
  return op || ed ? { op, ed } : null;
}

export interface PrescanStaticInput {
  /** `autoSkipDetect !== false`. */
  autoSkipDetect: boolean;
  /** `prescanNextEpisode !== false`. */
  prescanSetting: boolean;
  /** The Next-Up card is on (lead time > 0). With it off the end screen
   *  still resolves the next episode, and that must not start a pre-scan. */
  nextUpOn: boolean;
  /** The playing target's media type. */
  mediaType: string | null | undefined;
  /** The pre-resolved next stream's url. */
  streamUrl: string | null | undefined;
  /** prescanKinds' answer. */
  kinds: { op: boolean; ed: boolean } | null;
  /** A cast session is active or connecting: the device pulls the stream the
   *  user watches, and no health signal here measures it (local mpv is
   *  paused, its full cache would read as healthy). */
  casting?: boolean;
}

/** Why the pre-scan cannot run at all right now (settings, stream, kinds), or
 *  null when nothing static blocks it. The MAL id (async), ffmpeg (async),
 *  the settled live detect and the stream health are checked separately. */
export function prescanStaticBlocker(i: PrescanStaticInput): string | null {
  if (!i.autoSkipDetect) return "automatic skip detection off";
  if (!i.prescanSetting) return "pre-scan off";
  if (!i.nextUpOn) return "next-up card off";
  if (i.casting) return "casting";
  const mt = (i.mediaType ?? "").toLowerCase();
  if (mt !== "series" && mt !== "anime") return "not a series";
  if (!prescanUrlEligible(i.streamUrl)) return "no http(s) stream";
  if (!i.kinds) return "no kind wanted";
  return null;
}

/** The cour resolution's answer is usable: anime only (a MAL id). Live
 *  action is never pre-scanned (its kinds depend on crowd rows and chapters
 *  only known at load). */
export function prescanCourEligible(malId: number | null | undefined): boolean {
  return typeof malId === "number" && Number.isFinite(malId) && malId > 0;
}

/** The playing stream's health, from the playback-update cache fields. */
export interface PrescanHealth {
  buffering: boolean;
  streamBroken: boolean;
  streamTruncated: boolean;
  /** The demuxer read the playing stream to its end. */
  demuxEof: boolean;
  /** Readahead ahead of the playhead (s); null when unknown (a seek clears
   *  it until the next poll). */
  cacheSeconds: number | null;
}

/** One sample healthy enough toward a START: not stalled, not broken or
 *  truncated, and either fully read or at least PRESCAN_START_CACHE_S ahead.
 *  A start needs a streak of these (prescanHealthStreak), not one. */
export function prescanHealthyToStart(h: PrescanHealth): boolean {
  if (h.buffering || h.streamBroken || h.streamTruncated) return false;
  if (h.demuxEof) return true;
  return h.cacheSeconds != null && Number.isFinite(h.cacheSeconds) && h.cacheSeconds >= PRESCAN_START_CACHE_S;
}

/** How long the playing stream must have been CONTINUOUSLY healthy (every
 *  sample passing prescanHealthyToStart, on fresh cache data, with no seek)
 *  before a pre-scan starts. One good poll is not a healthy link: a stream
 *  whose readahead swings across the start bar would otherwise start a
 *  pre-scan on the one sample above it. */
export const PRESCAN_HEALTHY_FOR_MS = 15_000;
/** A cache reading older than this is unknown, never healthy. The engine's
 *  cache poll rides playback-update about every 500 ms while the window is
 *  visible; while it is hidden the cache fields stop updating, and the last
 *  reading would otherwise keep passing. */
export const PRESCAN_CACHE_STALE_MS = 3_000;

/** One health sample for the streak: the cache fields plus what can break a
 *  streak beyond them. */
export interface PrescanSample extends PrescanHealth {
  /** A seek is in flight (its cache numbers belong to the old position). */
  seeking: boolean;
  /** Wall clock (ms) of the last cache reading (cache_seconds or demux_eof
   *  on a playback-update); 0 when none for this load. */
  cacheAt: number;
}

/** The last cache reading is recent enough to judge the stream by. */
export function prescanCacheFresh(cacheAt: number, now: number): boolean {
  return Number.isFinite(cacheAt) && cacheAt > 0 && now - cacheAt >= 0 && now - cacheAt <= PRESCAN_CACHE_STALE_MS;
}

/** The healthy streak after this sample: its start (ms) when the sample is
 *  healthy (kept from `prevStart`, or `now` when a streak begins here), null
 *  when it is not (a stall, too little readahead while the demuxer still has
 *  to read, broken, truncated, a seek, or stale cache data). The caller passes
 *  a null `prevStart` after a new load. */
export function prescanHealthStreak(prevStart: number | null, s: PrescanSample, now: number): number | null {
  if (s.seeking || !prescanCacheFresh(s.cacheAt, now) || !prescanHealthyToStart(s)) return null;
  return prevStart != null && Number.isFinite(prevStart) && prevStart <= now ? prevStart : now;
}

/** The streak has lasted PRESCAN_HEALTHY_FOR_MS: a pre-scan may start. */
export function prescanHealthyLongEnough(streakStart: number | null, now: number): boolean {
  return streakStart != null && now - streakStart >= PRESCAN_HEALTHY_FOR_MS;
}

/** Ms until a running streak is long enough (0 when it already is), null
 *  when there is no streak. For the re-check timer while samples may not
 *  move any state (a paused, fully buffered file). */
export function prescanHealthyMsLeft(streakStart: number | null, now: number): number | null {
  if (streakStart == null) return null;
  return Math.max(0, PRESCAN_HEALTHY_FOR_MS - (now - streakStart));
}

/** A running pre-scan must stop: the playing stream stalls, breaks or is
 *  truncated, or its readahead fell under PRESCAN_ABORT_CACHE_S while the
 *  demuxer still has to read. An unknown readahead (null, right after a
 *  seek) is not a reason: a real stall shows as `buffering`. */
export function prescanShouldAbort(h: PrescanHealth): boolean {
  if (h.buffering || h.streamBroken || h.streamTruncated) return true;
  if (h.demuxEof) return false;
  return h.cacheSeconds != null && Number.isFinite(h.cacheSeconds) && h.cacheSeconds < PRESCAN_ABORT_CACHE_S;
}

/** A running pre-scan's health readings stopped arriving while the playing
 *  episode plays on: the engine's cache poll halts while the window is hidden
 *  (cloaked on another virtual desktop) yet playback continues, freezing
 *  `buffering` and the readahead at their last healthy values. Such a reading
 *  is unknown, so the playing stream wins. Not while paused (nothing is
 *  consumed), not during a seek or right after one or a load (`cacheAt` 0),
 *  not once the demuxer read the file to its end. */
export function prescanStaleWhilePlaying(
  cacheAt: number, paused: boolean, seeking: boolean, demuxEof: boolean, now: number,
): boolean {
  if (paused || seeking || demuxEof || !(Number.isFinite(cacheAt) && cacheAt > 0)) return false;
  return !prescanCacheFresh(cacheAt, now);
}

/** The pre-scan may start only once THIS file's live detect settled (it ran
 *  to its end, or the chain exited without one): the pre-scan must never
 *  compete with the playing episode's own HEAD / TAIL read. */
export function prescanLiveSettled(settledSeq: number | null, currentSeq: number): boolean {
  return settledSeq != null && settledSeq === currentSeq;
}

/** What decides whether Next-Up's pre-resolve may run early. */
export interface PrescanEarlyResolveInput {
  /** `autoSkipDetect !== false`. */
  autoSkipDetect: boolean;
  /** `prescanNextEpisode !== false`. */
  prescanSetting: boolean;
  casting: boolean;
  mediaType: string | null | undefined;
  /** The live chain resolved a MAL cour for the PLAYING episode (anime). */
  playingHasMal: boolean;
  /** prescanLiveSettled for the playing file. */
  liveSettled: boolean;
  /** prescanKinds' answer. */
  kinds: { op: boolean; ed: boolean } | null;
}

/** Next-Up's pre-resolve (the next episode and its first stream) normally
 *  waits for 50 % progress; the pre-scan reads the stream it finds, so when a
 *  pre-scan could follow it runs as soon as this file's live detect settled
 *  instead, and the pre-scan starts once the playing stream is healthy rather
 *  than half an episode later. Only for an anime episode with a MAL cour, with
 *  both switches on and a kind wanted, not while casting: everything else
 *  keeps the 50 % mark. */
export function prescanWantsEarlyResolve(i: PrescanEarlyResolveInput): boolean {
  if (!i.autoSkipDetect || !i.prescanSetting || i.casting) return false;
  const mt = (i.mediaType ?? "").toLowerCase();
  if (mt !== "series" && mt !== "anime") return false;
  return i.playingHasMal && i.liveSettled && i.kinds != null;
}

/** Per-key retry bookkeeping. */
export interface PrescanBudget {
  /** Prescan requests really started (busy excluded). */
  attempts: number;
  /** `busy` replies so far. */
  busy: number;
}

/** What to do after a reply:
 *  - "end": stop for this key (done, cached, unavailable, a failed call, or
 *    the budget is spent);
 *  - "retry": start again once the playing stream is healthy and its live
 *    detect has settled;
 *  - "retry-after-settle": wait for the live detect to settle again (busy),
 *    then retry. */
export type PrescanNext = "end" | "retry" | "retry-after-settle";

/** May another attempt start? */
export function prescanCanAttempt(b: PrescanBudget): boolean {
  return b.attempts < PRESCAN_MAX_ATTEMPTS && b.busy <= PRESCAN_MAX_BUSY;
}

/**
 * The retry policy. `outcome` null means the call itself failed (an older
 * Rust build without the action, a serde error): never retried. `budget` is
 * the state AFTER the reply's request was counted (the caller counts an
 * attempt when it sends one, and `busy` gives it back here). Returns the next
 * step and the updated budget.
 */
export function prescanAfterOutcome(
  outcome: PrescanOutcome | null,
  budget: PrescanBudget,
): { next: PrescanNext; budget: PrescanBudget } {
  switch (outcome) {
    case "done":
    case "cached":
    case "unavailable":
      return { next: "end", budget };
    case "busy": {
      // Not started: the attempt is given back, the busy count is spent.
      const b = { attempts: Math.max(0, budget.attempts - 1), busy: budget.busy + 1 };
      return { next: b.busy > PRESCAN_MAX_BUSY ? "end" : "retry-after-settle", budget: b };
    }
    case "preempted":
    case "cancelled":
      // A live detect took over (a new load, a source switch), the health
      // abort, or a load's prescan_cancel: worth another go while budget
      // remains. A cancel for a key that is no longer current never reaches
      // here (the caller drops a reply whose key moved on).
      return { next: budget.attempts < PRESCAN_MAX_ATTEMPTS ? "retry" : "end", budget };
    default:
      return { next: "end", budget };
  }
}

/** The once-per key: the playing episode, the next episode and the exact
 *  stream url (a re-pick with a new url is another file to read). */
export function prescanKey(currentId: string, nextId: string, url: string): string {
  return `${currentId}\u0000${nextId}\u0000${url}`;
}

/** A wire outcome, validated (anything unknown reads as null: end). */
export function parsePrescanOutcome(v: unknown): PrescanOutcome | null {
  return v === "done" || v === "cached" || v === "preempted" || v === "cancelled"
    || v === "busy" || v === "unavailable" ? v : null;
}
