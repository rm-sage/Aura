// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TrackEntry } from "./types";
// Mandatory: without this the overlay's control bar auto-hides out from under
// the panel. Lives in its own module precisely so a sibling panel like this one
// can join the counter without importing back into PlayerOverlay.
import { useMenuOpenSync } from "./menuTracker";

// ---------------------------------------------------------------------------
// SubtitleSyncPanel - "Live Subtitle Sync"
//
// Shows the subtitle LINES around the current playback position. The user
// clicks the line they just heard, and Aura derives the subtitle delay from
// the gap between that cue's RAW file time and the playback clock.
//
// Two deliberate wins over Stremio's supporter-only version:
//
//  1. WE FREEZE THE CLOCK. On open we pause and snapshot `anchor =
//     currentTime`. Stremio measures against the LIVE playhead at click time,
//     so every second the user spends scanning the list for the right line is
//     baked into the correction as error. Ours is exact regardless of how long
//     the user takes.
//
//  2. TWO-POINT SYNC. A constant offset cannot fix FRAMERATE DRIFT (a 23.976
//     subtitle on a 25 fps release slides progressively further out). With two
//     anchors we solve for a slope as well as an intercept:
//         speed = (t2 - t1) / (cue2.end - cue1.end)
//         delay = t1 - speed * cue1.end
//     and drive mpv's `sub-speed` alongside `sub-delay`. Stremio structurally
//     cannot do this (it only ever collects one point).
//
// Nothing here is persisted. A subtitle delay belongs to the RELEASE, not the
// title: persisting it would re-apply a wrong correction after a source switch.
// Same reasoning as playback speed and the video EQ, which are also
// session-only. `sub-delay` / `sub-speed` are reset by PlayerOverlay on file
// change.
// ---------------------------------------------------------------------------

/** Mirror of Rust `subsync::SubCue`. Times are RAW file seconds (never
 *  delay-shifted); `text` is already markup-stripped. */
interface SubCue {
  start: number;
  end: number;
  text: string;
}

/** Mirror of Rust `subsync::ProbedSubStream`. */
interface ProbedSubStream {
  sub_index: number;
  codec: string;
  language: string;
  title: string;
  is_bitmap: boolean;
}

/** One (playback clock, cue end) pair. Lives in PlayerOverlay scope so it
 *  survives this panel closing and reopening: the two-point flow is "pick a
 *  line, resume, play on, reopen, pick a second line". Cleared on file change. */
export interface SyncAnchorPair {
  /** Playback clock (seconds) at the moment the panel was opened. */
  t: number;
  /** RAW file end-time (seconds) of the cue the user picked. */
  cueEnd: number;
}

// ── Bounds ─────────────────────────────────────────────────────────────────

/** Cues shown either side of the anchor. */
const CUE_WINDOW_SECS = 300;
/** Width of the ffmpeg extraction window for EMBEDDED tracks. Rust clamps this
 *  to 30..900 and centres it on `aroundSeconds`. A full-file demux of a remote
 *  20 GB mkv takes minutes, hence the window. */
const EXTRACT_WINDOW_SECS = 300;
/** Hard cap on rendered rows. A whole-episode cue array is never held: the
 *  external tier returns the full file, and we slice a centred window out of it
 *  immediately. Dropped entirely on close / file change. */
const MAX_RENDERED_CUES = 400;

const DELAY_STEP = 0.25;
/** mpv's own clamps (lib.rs `set_subtitle_delay` / `set_subtitle_speed`). */
const DELAY_LIMIT = 120;
const SPEED_LIMIT_LO = 0.5;
const SPEED_LIMIT_HI = 2.0;

/** Two anchors closer together than this make the speed term wildly unstable
 *  (the denominator `cue2.end - cue1.end` approaches the pick error). */
const MIN_ANCHOR_GAP_SECS = 60;
/** A REAL framerate mismatch lives in a narrow band around 1.0: 25 / 23.976 =
 *  1.043 and its inverse 0.959. A solve outside this band is a bad pick, not a
 *  correction, and applying it would scramble the track. */
const SPEED_PLAUSIBLE_LO = 0.9;
const SPEED_PLAUSIBLE_HI = 1.1;

/** Image-based subtitle codecs (mirrors `subsync::BITMAP_CODECS`, plus the
 *  short names mpv sometimes reports). These can never yield text without OCR,
 *  so they are a first-class DISABLED state rather than an error. Common on
 *  remuxes, which is exactly what Aura plays. */
const BITMAP_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "dvd_subtitle",
  "dvb_subtitle",
  "xsub",
  "pgs",
  "vobsub",
]);

function isBitmapCodec(codec: string | null | undefined): boolean {
  if (!codec) return false;
  return BITMAP_CODECS.has(codec.trim().toLowerCase());
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

/** mpv and ffprobe usually both emit ISO 639-2/B ("eng"), but a container can
 *  carry 639-1 ("en") on one side and not the other, so compare on the shared
 *  2-char prefix. */
function langMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase();
  const y = (b ?? "").trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || x.slice(0, 2) === y.slice(0, 2);
}

/**
 * Map mpv's ACTIVE subtitle track onto ffmpeg's subtitle-relative index (the N
 * in `-map 0:s:N`).
 *
 * mpv's `TrackEntry.id` is mpv's OWN sub id (1-based, and it counts sub-added
 * external tracks alongside container ones). It is NOT guaranteed to equal
 * ffmpeg's subtitle-relative index, so using it directly would silently extract
 * the WRONG language on any file where the two numbering schemes diverge.
 *
 * What IS reliable is ORDINAL POSITION: ffprobe's `-select_streams s` returns
 * the container's subtitle streams in container order, and mpv enumerates the
 * container's subtitle tracks in that same order. So the Nth container-embedded
 * sub track in mpv is `0:s:N` to ffmpeg.
 *
 * Cross-checks, in order:
 *   1. Exactly one probed stream -> it is the one, whatever the ordinal says.
 *   2. Ordinal hit whose language agrees with mpv's -> trust it.
 *   3. Language disagrees (or the ordinal is out of range) but exactly one
 *      probed stream carries mpv's language -> trust the language.
 *   4. Otherwise fall back to the ordinal (best available guess).
 */
function pickProbedStream(
  probed: ProbedSubStream[],
  active: TrackEntry,
  embedded: TrackEntry[],
): ProbedSubStream | null {
  if (probed.length === 0) return null;
  if (probed.length === 1) return probed[0];

  const ordinal = embedded.findIndex((t) => t.id === active.id);
  const byOrdinal = ordinal >= 0 ? (probed[ordinal] ?? null) : null;

  if (byOrdinal && (!active.lang || !byOrdinal.language)) return byOrdinal;
  if (byOrdinal && langMatches(active.lang, byOrdinal.language)) return byOrdinal;

  const byLang = probed.filter((p) => langMatches(active.lang, p.language));
  if (byLang.length === 1) return byLang[0];

  return byOrdinal;
}

/** Keep only the cues within +/- CUE_WINDOW_SECS of the anchor, then cap the
 *  row count with a slice CENTRED on the anchor (a head-slice would drop the
 *  very line the user is looking for). */
function windowCues(raw: SubCue[], anchorRaw: number): SubCue[] {
  const lo = anchorRaw - CUE_WINDOW_SECS;
  const hi = anchorRaw + CUE_WINDOW_SECS;
  const inWindow = raw.filter((c) => c.end >= lo && c.start <= hi);
  if (inWindow.length <= MAX_RENDERED_CUES) return inWindow;

  let centre = inWindow.findIndex((c) => c.end >= anchorRaw);
  if (centre < 0) centre = inWindow.length - 1;
  const half = Math.floor(MAX_RENDERED_CUES / 2);
  const start = Math.max(
    0,
    Math.min(inWindow.length - MAX_RENDERED_CUES, centre - half),
  );
  return inWindow.slice(start, start + MAX_RENDERED_CUES);
}

type Status = "idle" | "loading" | "ready" | "empty" | "bitmap" | "no-track" | "error";

// ── Icons ──────────────────────────────────────────────────────────────────

const SyncIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
  </svg>
);
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  onClose: () => void;

  /** Live playhead. Snapshotted into the frozen `anchor` on open, never read
   *  again while the panel is up. */
  currentTime: number;
  /** mpv's pause state, mirrored by PlayerOverlay. */
  paused: boolean;
  /** PlayerOverlay's EXISTING pause path (the same one the play button and the
   *  space-bar keybind use). Toggles; never call it blindly. */
  togglePause: () => void;

  /** PlayerOverlay's raw `get_tracks` list. NOT `subDropdownItems` (that one
   *  mints synthetic negative ids and stuffs the addon URL into `codec`). */
  tracks: TrackEntry[];
  /** Resolved URL of the playing file. Needed for the embedded (ffmpeg) tier. */
  streamUrl: string | null;

  /** mpv `sub-delay`, owned by PlayerOverlay. */
  subDelay: number;
  setSubDelay: (seconds: number) => void;
  /** mpv `sub-speed`, owned by PlayerOverlay. Session-only, reset to 1.0 on
   *  file change. */
  subSpeed: number;
  setSubSpeed: (speed: number) => void;

  /** First (clock, cue-end) pair of a two-point solve. Held in PlayerOverlay so
   *  it survives this panel closing and reopening; cleared on file change. */
  firstAnchor: SyncAnchorPair | null;
  setFirstAnchor: (pair: SyncAnchorPair | null) => void;
}

export default function SubtitleSyncPanel({
  open, onClose,
  currentTime, paused, togglePause,
  tracks, streamUrl,
  subDelay, setSubDelay,
  subSpeed, setSubSpeed,
  firstAnchor, setFirstAnchor,
}: Props) {
  // Freezes the control-bar auto-hide (and makes the overlay swallow the click
  // that dismissed us) for as long as the panel is up.
  useMenuOpenSync(open);

  // ── Frozen anchor + pause bookkeeping ────────────────────────────────
  const [anchor, setAnchor] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [cues, setCues] = useState<SubCue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [twoPointArmed, setTwoPointArmed] = useState(false);
  const [undo, setUndo] = useState<
    { delay: number; speed: number; pair: SyncAnchorPair | null } | null
  >(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const centeredRef = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest-value refs so the open/close effect can read play state and the
  // playhead WITHOUT re-running (it must run exactly once per open).
  const pausedRef = useRef(paused);
  const togglePauseRef = useRef(togglePause);
  const currentTimeRef = useRef(currentTime);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { togglePauseRef.current = togglePause; }, [togglePause]);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
  }, []);

  // Open: snapshot the clock and PAUSE (win #1 - the seconds the user spends
  // hunting for the line must not become error in the correction). Close:
  // restore the prior play/pause state and drop every cue we were holding.
  useEffect(() => {
    if (!open) return;

    setAnchor(currentTimeRef.current);
    setStatus("idle");
    setError(null);
    setNote(null);
    setQuery("");
    setMatchCursor(0);
    setFlashIdx(null);
    setTwoPointArmed(false);
    setUndo(null);
    centeredRef.current = false;

    // Only pause if we are actually playing; closing must not resume a stream
    // the user had deliberately paused BEFORE opening the panel.
    const resumeOnClose = !pausedRef.current;
    if (resumeOnClose) togglePauseRef.current();

    return () => {
      // The user may have resumed by hand while the panel was up - only toggle
      // when we are still the reason it is paused.
      if (resumeOnClose && pausedRef.current) togglePauseRef.current();
      setAnchor(null);
      setCues([]);
      setStatus("idle");
      rowRefs.current.clear();
    };
  }, [open]);

  // ── Active subtitle track ────────────────────────────────────────────
  const subTracks = useMemo(() => tracks.filter((t) => t.type === "sub"), [tracks]);
  const activeSub = useMemo(() => subTracks.find((t) => t.selected) ?? null, [subTracks]);
  // Container-embedded subs ONLY, in mpv's natural order. This is the list the
  // ffmpeg subtitle-relative index is an ordinal into; sub-added externals must
  // not shift it.
  const embeddedSubs = useMemo(() => subTracks.filter((t) => !t.external), [subTracks]);

  // Stable key: the track list object identity churns on every `get_tracks`
  // refresh, but the cue fetch must only re-run when the TRACK actually changes.
  const activeKey = activeSub
    ? `${activeSub.id}|${activeSub.external_filename ?? ""}`
    : "";

  // ── Cue fetch ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!open || anchor == null) return;

    if (!activeSub) {
      setStatus("no-track");
      return;
    }
    // Fast path: mpv already told us the codec, so a bitmap track never even
    // reaches ffprobe.
    if (isBitmapCodec(activeSub.codec)) {
      setStatus("bitmap");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    setError(null);
    setCues([]);

    (async () => {
      try {
        let raw: SubCue[];
        const source = activeSub.external_filename ?? null;

        if (source) {
          // TIER A - external track (OpenSubtitles download or an addon's
          // https .srt/.vtt). The text is already ours; Rust parses it directly.
          raw = await invoke<SubCue[]>("parse_subtitle_cues", { source });
        } else {
          // TIER B - container-embedded track. ffprobe maps mpv's track onto
          // ffmpeg's `-map 0:s:N`, then a WINDOWED ffmpeg extract pulls the
          // cues around the anchor.
          if (!streamUrl) {
            throw new Error("no stream URL for the playing file");
          }
          const probed = await invoke<ProbedSubStream[]>("probe_subtitle_streams", {
            url: streamUrl,
          });
          if (cancelled) return;

          const chosen = pickProbedStream(probed, activeSub, embeddedSubs);
          if (!chosen) {
            throw new Error(
              "could not match the active subtitle track to a stream in the container",
            );
          }
          if (chosen.is_bitmap) {
            setStatus("bitmap");
            return;
          }
          raw = await invoke<SubCue[]>("extract_embedded_cues", {
            url: streamUrl,
            subIndex: chosen.sub_index,
            aroundSeconds: anchor,
            windowSeconds: EXTRACT_WINDOW_SECS,
          });
        }
        if (cancelled) return;

        // The cue list is windowed + capped the moment it lands: a whole-episode
        // array is never retained.
        const windowed = windowCues(raw, anchor);
        setCues(windowed);
        setStatus(windowed.length > 0 ? "ready" : "empty");
      } catch (e) {
        if (cancelled) return;
        setError(String(e));
        setStatus("error");
      }
    })();

    return () => { cancelled = true; };
    // `activeSub` / `embeddedSubs` are read from the closure on purpose: they
    // are re-derived on every track refresh, but their CONTENT only changes when
    // `activeKey` does.
  }, [open, anchor, activeKey, streamUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── The cue that was on screen AT the anchor ─────────────────────────
  // Cue times are RAW file times; what the user actually SAW is
  // `cue * speed + delay`. So map the anchor back into raw-file space before
  // matching, otherwise an already-applied correction offsets the highlight.
  const anchorIdx = useMemo(() => {
    if (anchor == null || cues.length === 0) return -1;
    const speed = subSpeed || 1;
    const raw = (anchor - subDelay) / speed;
    const hit = cues.findIndex((c) => c.start <= raw && c.end >= raw);
    if (hit >= 0) return hit;
    // Between cues: the most recent line that has already ENDED is "the line
    // you just heard".
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].end <= raw) return i;
    }
    return 0;
  }, [cues, anchor, subDelay, subSpeed]);

  // ── Search ───────────────────────────────────────────────────────────
  // Each row keeps its ORIGINAL cue index so the anchor highlight, the flash,
  // and the pick handler all stay correct under a filter.
  const rows = useMemo(() => {
    const all = cues.map((c, i) => ({ cue: c, idx: i }));
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => r.cue.text.toLowerCase().includes(q));
  }, [cues, query]);

  const centerOn = useCallback((idx: number) => {
    const container = scrollRef.current;
    const el = rowRefs.current.get(idx);
    if (!container || !el) return;
    // Same maths Stremio uses, applied instantly (assigning scrollTop is
    // instant by definition; `behavior: "instant"` is not in every TS dom lib).
    container.scrollTop =
      el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
  }, []);

  // Centre the anchor cue once, on open.
  useEffect(() => {
    if (status !== "ready" || anchorIdx < 0 || centeredRef.current) return;
    centerOn(anchorIdx);
    centeredRef.current = true;
  }, [status, anchorIdx, centerOn]);

  // A fresh query jumps to (and centres) its first match.
  useEffect(() => {
    if (!query.trim() || rows.length === 0) return;
    setMatchCursor(0);
    centerOn(rows[0].idx);
  }, [query, rows, centerOn]);

  const activeMatchIdx =
    query.trim() && rows.length > 0 ? rows[matchCursor % rows.length].idx : -1;

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (rows.length === 0) return;
    const next = (matchCursor + 1) % rows.length;
    setMatchCursor(next);
    centerOn(rows[next].idx);
  };

  // ── !!! WHEEL !!! ────────────────────────────────────────────────────
  // PlayerOverlay installs a GLOBAL `{ passive: false }` volume-wheel handler.
  // It tries to defer to scroll-capable ancestors, but that check fails the
  // moment the list is shorter than its container (and any miss makes the whole
  // panel unscrollable while silently yanking the volume). So we do what
  // TrackMenu does: claim the event outright and scroll by hand.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      el.scrollBy({ top: e.deltaY, behavior: "auto" });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [open]);

  // ── Applying a correction ────────────────────────────────────────────
  //
  // MODEL (IMPORTANT - NOT YET RUNTIME-VERIFIED): we assume
  //
  //     displayed_time = cue_time * sub-speed + sub-delay
  //
  // mpv documents `sub-speed` as "multiply the subtitle event timestamps with
  // the given value" and `sub-delay` as a shift, but the exact multiplication
  // DIRECTION and how the two compose is documented ambiguously, and this has
  // not been confirmed against a real drifting release. Everything below is
  // written against that model, and the visible UNDO restores the previous
  // delay + speed in one click - so if the convention turns out to be inverted,
  // the cost is one button press, not a wedged subtitle track.
  const apply = useCallback(async (delay: number, speed: number) => {
    const d = clampNum(delay, -DELAY_LIMIT, DELAY_LIMIT);
    const s = clampNum(speed, SPEED_LIMIT_LO, SPEED_LIMIT_HI);
    try {
      // Speed first: the delay was solved FOR that speed, so applying delay
      // against the old speed would flash a visibly wrong position.
      await invoke("set_subtitle_speed", { speed: s });
      await invoke("set_subtitle_delay", { seconds: d });
      // Lift both into PlayerOverlay so the subtitle dropdown's delay row (and
      // any later +/- nudge) reflects what we just applied.
      setSubSpeed(s);
      setSubDelay(d);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [setSubDelay, setSubSpeed]);

  const flash = (idx: number) => {
    setFlashIdx(idx);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashIdx(null), 3000);
  };

  const onPickCue = async (idx: number) => {
    if (anchor == null) return;
    const cue = cues[idx];
    if (!cue) return;

    const prev = { delay: subDelay, speed: subSpeed, pair: firstAnchor };
    setNote(null);

    // ── Two-point solve ──
    if (twoPointArmed && firstAnchor) {
      const gap = Math.abs(cue.end - firstAnchor.cueEnd);
      const speed = (anchor - firstAnchor.t) / (cue.end - firstAnchor.cueEnd);
      const plausible =
        Number.isFinite(speed) &&
        speed >= SPEED_PLAUSIBLE_LO &&
        speed <= SPEED_PLAUSIBLE_HI;

      if (gap >= MIN_ANCHOR_GAP_SECS && plausible) {
        const delay = firstAnchor.t - speed * firstAnchor.cueEnd;
        setUndo(prev);
        await apply(delay, speed);
        setFirstAnchor({ t: anchor, cueEnd: cue.end });
        setTwoPointArmed(false);
        setNote(
          `Drift corrected: speed x${speed.toFixed(4)}, offset ${delay.toFixed(2)}s.`,
        );
        flash(idx);
        return;
      }

      // Refused. Say exactly why, then fall through to a plain offset from THIS
      // pick so the user is never left worse off than before they clicked.
      setNote(
        gap < MIN_ANCHOR_GAP_SECS
          ? `Those two lines are only ${gap.toFixed(0)}s apart in the file. `
            + `A drift solve needs at least ${MIN_ANCHOR_GAP_SECS}s between them or the `
            + `speed term is unstable, so a plain offset was applied instead. Play `
            + `further ahead and pick a second line there.`
          : `The solved speed (${Number.isFinite(speed) ? speed.toFixed(3) : "n/a"}) is `
            + `outside the plausible ${SPEED_PLAUSIBLE_LO}-${SPEED_PLAUSIBLE_HI} framerate `
            + `band, so it is a mis-picked line rather than real drift. A plain offset was `
            + `applied instead.`,
      );
      setTwoPointArmed(false);
    }

    // ── Plain offset ──
    // The line the user just HEARD has already finished by the time they click
    // it, so the correction is measured against the cue's END, not its start.
    // Under the model above, landing that cue on the anchor means
    //     delay = anchor - speed * cue.end
    // which is exactly `anchor - cue.end` at the default speed of 1.0, and stays
    // correct when a two-point solve has already set a speed.
    const delay = anchor - subSpeed * cue.end;
    setUndo(prev);
    await apply(delay, subSpeed);
    setFirstAnchor({ t: anchor, cueEnd: cue.end });
    flash(idx);
  };

  const nudgeDelay = (step: number) => {
    void apply(+(subDelay + step).toFixed(3), subSpeed);
  };

  const resetAll = () => {
    setUndo({ delay: subDelay, speed: subSpeed, pair: firstAnchor });
    setNote(null);
    setFirstAnchor(null);
    setTwoPointArmed(false);
    void apply(0, 1);
  };

  const doUndo = async () => {
    if (!undo) return;
    await apply(undo.delay, undo.speed);
    setFirstAnchor(undo.pair);
    setUndo(null);
    setNote("Reverted to the previous delay and speed.");
  };

  if (!open) return null;

  const speedIsSet = Math.abs(subSpeed - 1) > 1e-6;
  const canOfferDrift = firstAnchor !== null && !twoPointArmed && status === "ready";

  return (
    <div className="absolute inset-0 z-40 flex items-end justify-center p-6 pointer-events-none">
      <div
        className="glass-panel-elevated rounded-2xl shadow-glass-edge w-full max-w-[42rem]
                   pointer-events-auto flex flex-col max-h-[70vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-white/55"><SyncIcon /></span>
            <h2 className="text-white/85 text-sm font-semibold tracking-wide whitespace-nowrap">
              Live Subtitle Sync
            </h2>
            <span className="text-white/30 text-xs whitespace-nowrap">
              · click the line you just heard
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-full text-white/50 hover:text-white hover:bg-white/8
                       flex items-center justify-center transition-colors flex-shrink-0"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Delay readout + manual nudge */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-white/6 flex-shrink-0">
          <span className="text-white/45 text-[10px] font-mono font-semibold uppercase tracking-[0.18em]">
            Delay
          </span>
          <span className="text-ln-accent text-sm font-mono tabular-nums">
            {`${subDelay.toFixed(2)}s`}
          </span>
          {speedIsSet && (
            <span
              className="px-1.5 py-0.5 rounded text-[9px] font-mono font-semibold uppercase
                         tracking-wider bg-ln-accent/15 text-ln-accent border border-ln-accent/35"
              title="Subtitle speed multiplier from a two-point drift solve"
            >
              {`speed x${subSpeed.toFixed(4)}`}
            </span>
          )}

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => nudgeDelay(-DELAY_STEP)}
            className="px-2 py-1 rounded-md text-[11px] font-mono tabular-nums
                       bg-white/8 text-white/85 border border-white/12
                       hover:bg-white/14 hover:text-white active:scale-95 transition-all"
          >
            {`-${DELAY_STEP.toFixed(2)}s`}
          </button>
          <button
            type="button"
            onClick={() => nudgeDelay(+DELAY_STEP)}
            className="px-2 py-1 rounded-md text-[11px] font-mono tabular-nums
                       bg-white/8 text-white/85 border border-white/12
                       hover:bg-white/14 hover:text-white active:scale-95 transition-all"
          >
            {`+${DELAY_STEP.toFixed(2)}s`}
          </button>
          {undo && (
            <button
              type="button"
              onClick={doUndo}
              title="Restore the delay and speed from before the last change"
              className="px-2 py-1 rounded-md text-[10.5px] font-medium tracking-wide
                         bg-amber-400/12 text-amber-200 border border-amber-400/30
                         hover:bg-amber-400/20 hover:text-amber-100 transition-colors"
            >
              Undo
            </button>
          )}
          <button
            type="button"
            onClick={resetAll}
            disabled={subDelay === 0 && !speedIsSet}
            title="Clear the delay and the speed multiplier"
            className="px-2 py-1 rounded-md text-[10.5px] font-medium tracking-wide
                       bg-white/5 text-white/55 border border-white/10
                       hover:bg-white/10 hover:text-white
                       disabled:opacity-35 disabled:hover:bg-white/5 disabled:hover:text-white/55
                       transition-colors"
          >
            Reset
          </button>
        </div>

        {/* Search */}
        {status === "ready" && (
          <div className="px-5 py-2.5 border-b border-white/6 flex-shrink-0">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search the lines… (Enter jumps to the next match)"
              spellCheck={false}
              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-1.5
                         text-sm placeholder:text-white/25 outline-none focus:border-white/25
                         transition-colors"
              style={{ color: "var(--text-primary)" }}
            />
          </div>
        )}

        {/* Two-point / drift affordance */}
        {canOfferDrift && (
          <div className="px-5 py-2.5 border-b border-white/6 flex-shrink-0 flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-white/75 text-xs font-medium">Still drifting?</p>
              <p className="text-white/40 text-[11px] leading-snug mt-0.5">
                A single offset cannot fix a framerate mismatch: the subtitles slide
                further out the longer you watch. Play on to a much later point (at
                least a minute past your first pick), reopen this panel, then pick the
                line you hear there.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setTwoPointArmed(true); setNote(null); }}
              className="flex-shrink-0 px-2.5 py-1 rounded-md text-[11px] font-medium
                         bg-ln-accent/15 text-ln-accent border border-ln-accent/35
                         hover:bg-ln-accent/25 transition-colors"
            >
              Fix drift
            </button>
          </div>
        )}
        {twoPointArmed && (
          <div className="px-5 py-2 border-b border-white/6 flex-shrink-0 flex items-center gap-3">
            <p className="text-ln-accent text-[11.5px] flex-1 min-w-0">
              Two-point mode: pick the line you just heard. It has to be at least{" "}
              {MIN_ANCHOR_GAP_SECS}s away from your first pick.
            </p>
            <button
              type="button"
              onClick={() => setTwoPointArmed(false)}
              className="flex-shrink-0 px-2 py-1 rounded-md text-[10.5px] font-medium
                         bg-white/5 text-white/55 border border-white/10
                         hover:bg-white/10 hover:text-white transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Note / error */}
        {(note || error) && (
          <div className="px-5 py-2 flex-shrink-0 text-[11.5px] leading-snug">
            {error
              ? <span className="text-red-400/85 break-words">{error}</span>
              : <span className="text-white/55">{note}</span>}
          </div>
        )}

        {/* Cue list */}
        <div
          ref={scrollRef}
          className="relative flex-1 min-h-0 overflow-y-auto px-3 py-2"
          style={{
            overscrollBehavior: "contain",
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(255,255,255,0.1) transparent",
          }}
        >
          {status === "loading" && (
            <div className="text-white/40 text-xs px-3 py-8 text-center">
              Reading the subtitle track…
            </div>
          )}

          {status === "no-track" && (
            <div className="text-white/45 text-xs px-3 py-8 text-center leading-relaxed">
              No subtitle track is selected.
              <br />
              Pick one from the subtitles menu in the control bar, then reopen Live Sync.
            </div>
          )}

          {status === "bitmap" && (
            <div className="text-white/45 text-xs px-3 py-8 text-center leading-relaxed">
              This subtitle track is image-based (PGS). Live Sync needs a text track
              {" "}- pick a different one.
              <br />
              <span className="text-white/30">
                Image subtitles carry no text to match against. Remuxes ship them often;
                a text track (SRT / ASS) or an addon subtitle will work.
              </span>
            </div>
          )}

          {status === "empty" && (
            <div className="text-white/45 text-xs px-3 py-8 text-center leading-relaxed">
              No subtitle lines around this point. Seek to a spot with dialogue and try
              again.
            </div>
          )}

          {status === "error" && (
            <div className="text-white/45 text-xs px-3 py-8 text-center leading-relaxed">
              Could not read the subtitle lines for this track.
            </div>
          )}

          {status === "ready" && rows.length === 0 && (
            <div className="text-white/35 text-xs px-3 py-8 text-center">
              No line matches that search.
            </div>
          )}

          {status === "ready" && rows.map(({ cue, idx }) => {
            const isAnchor = idx === anchorIdx;
            const isFlash = idx === flashIdx;
            const isMatch = idx === activeMatchIdx;
            return (
              <button
                key={idx}
                ref={(el) => {
                  if (el) rowRefs.current.set(idx, el);
                  else rowRefs.current.delete(idx);
                }}
                onClick={() => { void onPickCue(idx); }}
                className={`w-full text-left px-3 py-2 rounded-lg text-[13px] leading-snug
                            transition-colors border
                            ${isFlash
                              ? "bg-ln-accent/25 text-white border-ln-accent/60"
                              : isAnchor
                                ? "bg-ln-accent/10 text-white border-ln-accent/35"
                                : isMatch
                                  ? "bg-white/12 text-white border-white/20"
                                  : "text-white/80 border-transparent hover:bg-white/8 hover:text-white"}`}
              >
                {/* Cue text only - Rust already stripped every SRT / VTT / ASS
                    markup form, so this is safe to render verbatim. */}
                {cue.text}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
