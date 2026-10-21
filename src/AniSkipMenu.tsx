// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// AniSkipMenu — in-player panel for managing AniSkip OP/ED windows.
//
// Surfaces three capabilities not previously reachable from the player:
//   1. Vote on existing windows (upvote / downvote per-row arrows in the
//      "AniSkip Segments" column).
//   2. Submit a new OP / ED / mixed-OP / recap window (Type + Start +
//      End form with "Now" buttons that snap to the live playback
//      position).
//   3. Toggle the per-kind skip mode (off / prompt / auto) for OP, ED,
//      and recap — mirrors the same settings in Settings → Anime OP/ED
//      Skip so users don't have to leave the player to flip a single
//      knob.
//
// Opens from the player's three-dots MoreMenu via the "AuraSkip" item.
// Renders as a centered dialog styled after the Switch source panel.
//
// Cour-aware MAL resolution: AniSkip indexes by MAL anime id + LOCAL
// per-cour episode (1-N within the entry). For cour-aggregated anime,
// the cour-specific MAL id lives behind the video id's anime-prefix
// portion (`kitsu:49240:9` → kitsu 49240 → yuna.moe → MAL 59978). We
// resolve once on mount and reuse for both submission and metadata
// display.
//
// IntroDB: when the user has stored a personal IntroDB key (Settings > API
// Keys) and the title is IMDb-rooted, a submission here ALSO goes to IntroDB,
// filed under the addon's exact numbering. That is what makes the form useful
// on non-anime titles, where no MAL id exists: with a key it submits to IntroDB
// alone. Only ever user-initiated, never from Aura's own guesses.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { ActiveScrobbleTarget } from "./useScrobble";
import {
  introDbHasKey, introDbImdbRoot,
  introDbPrimaryNumbering, submitToIntroDb,
} from "./introdb";
import { peekCachedDetailById } from "./metaCache";
import {
  skipConfidenceInfo, skipHeldReason, skipKindLabel, skipSourceHint, skipSourceLabel,
} from "./skipSource";
import type { SkipBasis, SkipHold } from "./skipWindows";
import SkipConfidenceBadge from "./SkipConfidenceBadge";
import Tooltip from "./Tooltip";
import { useMenuOpenSync } from "./menuTracker";

/** Mirrors PlayerOverlay's AuraSkipWindow shape so this module can be
 *  imported without a circular dep. Local copy is intentional. */
export interface AniSkipMenuWindow {
  type: string;
  start: number;
  end: number;
  source: string;
  auto: boolean;
  skip_id?: string | null;
  /** `"{malId}:{episode}"` an "aniskip" window was fetched for. Votes are
   *  offered only when it matches this menu's own resolution. */
  skip_ref?: string | null;
  /** Opening / ending song, when identified. This local copy of the window
   *  shape is deliberate (it avoids a circular import with PlayerOverlay);
   *  keep it in step with that file and with App.tsx. */
  song_title?:  string | null;
  song_artist?: string | null;
  /** Why this window may only prompt (skipWindows.ts SkipHold). */
  hold?: SkipHold | null;
  /** What the window's position rests on (skipWindows.ts SkipBasis). */
  basis?: SkipBasis | null;
}

interface Props {
  /** True when the popover is open. */
  open: boolean;
  /** Close handler — invoked on outside click + after a submit. */
  onClose: () => void;
  /** Currently-playing target. Drives the malId/episode resolution. */
  activeTarget: ActiveScrobbleTarget | null;
  /** Live playback time — used by the "Now" buttons in the submit form. */
  time: number;
  /** Stream duration in seconds — passed to AniSkip as `episodeLength`
   *  on submission so the server stores the correct ratio. */
  duration: number;
  /** Existing skip windows for this episode. Driven by useSkipWindows
   *  upstream, threaded down so this component doesn't double-fetch. */
  windows: AniSkipMenuWindow[];
  /** AniSkip rows a theme match (Layer 1) replaced for their kind. Listed for
   *  their vote arrows only: they never auto-skip or prompt. */
  superseded?: AniSkipMenuWindow[];
  /** Windowed playback keeps the 36 px Win32 title bar: the dialog's scrim
   *  starts below it, like the Switch source panel. */
  isFullscreen?: boolean;
}

type SkipMode = "off" | "prompt" | "auto";
type SkipType = "op" | "ed" | "mixed-op" | "recap";

interface BackendSettingsLite {
  skip_op_mode: string;
  skip_ed_mode: string;
  skip_recap_mode: string;
  skip_treat_mixed_op_as_op: boolean;
}

function normalizeMode(raw: string | undefined, fallback: SkipMode): SkipMode {
  return raw === "off" || raw === "prompt" || raw === "auto" ? raw : fallback;
}

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return "--:--";
  const s = Math.max(0, Math.floor(sec));
  const ms = Math.max(0, Math.floor((sec - s) * 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const hms = h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
    : `${m}:${String(r).padStart(2, "0")}`;
  return ms > 0 ? `${hms}.${String(ms).padStart(3, "0")}` : hms;
}

/** Accept `MM:SS`, `MM:SS.mmm`, `H:MM:SS`, or bare seconds (`90`,
 *  `90.5`). Returns null when none match. */
function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const colonSegs = trimmed.split(":");
  if (colonSegs.length < 2 || colonSegs.length > 3) return null;
  const nums = colonSegs.map((s) => Number(s));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (colonSegs.length === 2) return nums[0] * 60 + nums[1];
  return nums[0] * 3600 + nums[1] * 60 + nums[2];
}

function skipLabel(kind: string): string {
  // "Opening (mixed)" is this menu's own wording (it is also the submit form's
  // type picker); every other kind reads the shared label.
  return kind === "mixed-op" ? "Opening (mixed)" : skipKindLabel(kind);
}

export default function AniSkipMenu({
  open, onClose, activeTarget, time, duration, windows, superseded = [], isFullscreen = false,
}: Props) {
  // ── MAL resolution ───────────────────────────────────────────────
  // Cour-specific id derived from the video id when it's anime-prefix
  // shape. AIOMetadata's cour-aggregation patch encodes the cour-
  // specific provider id directly, so this is exact. For tt-style or
  // unknown shapes we surface a clear "MAL id not resolvable" state
  // so the user knows submission won't work for this episode.
  const [malId, setMalId] = useState<number | null>(null);
  const [malResolving, setMalResolving] = useState(false);
  // Cour-relative episode number — matches what AniSkip's per-MAL-
  // entry indexing wants (e.g. Frieren cour 2 ep 9 → MAL 59978 ep 9,
  // NOT absolute 37). Reads from activeTarget.episode_num set by
  // handlePlayStream from the VideoEntry.
  const targetEpisode = useMemo(() => {
    if (!activeTarget) return null;
    if (Number.isFinite(activeTarget.episode_num as number)) {
      return activeTarget.episode_num as number;
    }
    // Fallback to the id-trailing-segment parse for shows without
    // VideoEntry.episode_num populated.
    const parts = activeTarget.id.split(":");
    const last = Number(parts[parts.length - 1]);
    return Number.isFinite(last) ? last : null;
  }, [activeTarget]);

  // The AniSkip episode once a per-episode id pair from the addon resolved
  // it (see the effect below); null means "use targetEpisode".
  const [pairEpisode, setPairEpisode] = useState<number | null>(null);
  const courEpisode = pairEpisode ?? targetEpisode;
  // The AniSkip entry the skip pipeline ACTUALLY fetched this episode's
  // windows from (`skip_ref` on its "aniskip" windows). When present it is
  // authoritative: re-deriving it here could disagree (a meta cache entry that
  // expired mid-episode, another addon's detail), which would hide the vote
  // arrows on a correct window and point a submission at another entry.
  // Superseded rows count too: when the theme match replaced every AniSkip
  // row, they are the only record of which entry was fetched.
  const stampedRef = useMemo(() => {
    const ref = [...windows, ...superseded]
      .find((w) => w.source === "aniskip" && w.skip_ref)?.skip_ref ?? null;
    const m = ref ? /^(\d+):(\d+)$/.exec(ref) : null;
    return m ? { mal: Number(m[1]), episode: Number(m[2]) } : null;
  }, [windows, superseded]);

  useEffect(() => {
    if (!open || !activeTarget) return;
    let cancelled = false;
    setMalResolving(true);
    setMalId(null);
    setPairEpisode(null);
    if (stampedRef) {
      setMalId(stampedRef.mal);
      setPairEpisode(stampedRef.episode);
      setMalResolving(false);
      return;
    }
    (async () => {
      // The same order as the skip pipeline in App.tsx (its Step 0): the
      // playing episode's OWN cour ids from the addon come first, used only
      // as a whole pair. Without this the menu and the stamped windows could
      // name different AniSkip entries for a tt-keyed later season.
      const seriesKey = activeTarget.series_id ?? activeTarget.id;
      const video = peekCachedDetailById(seriesKey)?.videos?.find((v) => v.id === activeTarget.id) ?? null;
      const anilistId = video?.anilist_id ?? activeTarget.anilist_id ?? null;
      const anilistEpisode = video?.anilist_episode ?? activeTarget.anilist_episode ?? null;
      let pair: { mal: number; episode: number } | null = null;
      if (video?.mal_id && video.mal_episode) {
        pair = { mal: video.mal_id, episode: video.mal_episode };
      } else if (anilistId && anilistEpisode) {
        try {
          const m = await invoke<number | null>("resolve_mal_id", { source: "anilist", id: anilistId });
          if (typeof m === "number") pair = { mal: m, episode: anilistEpisode };
        } catch { /* fall through to the chain below */ }
      }
      if (pair) {
        console.info(`[aniskip] menu: per-episode ids from the addon -> mal=${pair.mal} ep=${pair.episode}`);
        if (!cancelled) {
          setMalId(pair.mal);
          setPairEpisode(pair.episode);
          setMalResolving(false);
        }
        return;
      }
      // Single server-side call walks the entire resolution chain
      // (anime-prefix → yuna.moe mal/anilist → Fribb mal/anilist →
      // AniList idMal → title search). Per-step diagnostics live in
      // the Rust devlog under `[aniskip]` so DevConsole still shows
      // which path resolved the id.
      const seriesImdb = activeTarget.series_id && activeTarget.series_id.startsWith("tt")
        ? activeTarget.series_id
        : (activeTarget.id.startsWith("tt") ? activeTarget.id.split(":")[0] : null);
      console.info(
        `[aniskip] menu resolving MAL for id=${activeTarget.id} ` +
        `series_imdb=${seriesImdb} season=${activeTarget.season} ` +
        `episode_num=${activeTarget.episode_num}`,
      );
      try {
        const m = await invoke<number | null>("resolve_mal_for_aniskip", {
          targetId:   activeTarget.id,
          seriesImdb,
          season:     activeTarget.season ?? null,
          title:      activeTarget.name ?? null,
        });
        console.info(`[aniskip] resolve_mal_for_aniskip → ${m}`);
        if (!cancelled) {
          setMalId(typeof m === "number" ? m : null);
          setMalResolving(false);
        }
      } catch (e) {
        console.warn(`[aniskip] resolve_mal_for_aniskip threw: ${e}`);
        if (!cancelled) { setMalId(null); setMalResolving(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [open, activeTarget, stampedRef?.mal, stampedRef?.episode]);

  // ── IntroDB availability ─────────────────────────────────────────
  // Submission needs a stored key, an IMDb root and the addon's numbering.
  // Only the key's PRESENCE is asked for; the key never leaves Rust.
  const [idbHasKey, setIdbHasKey] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    introDbHasKey().then((has) => { if (!cancelled) setIdbHasKey(has); });
    return () => { cancelled = true; };
  }, [open]);
  const idbImdb = useMemo(
    () => (activeTarget ? introDbImdbRoot(activeTarget) : null),
    [activeTarget],
  );
  const idbNumbering = useMemo(
    () => (activeTarget ? introDbPrimaryNumbering(activeTarget) : null),
    [activeTarget],
  );
  const idbAvailable = idbHasKey && idbImdb != null && idbNumbering != null;

  // ── Mode toggles (op / ed / recap) ────────────────────────────────
  const [opMode, setOpMode]       = useState<SkipMode>("auto");
  const [edMode, setEdMode]       = useState<SkipMode>("prompt");
  const [recapMode, setRecapMode] = useState<SkipMode>("prompt");
  const [modesLoading, setModesLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setModesLoading(true);
    invoke<BackendSettingsLite>("get_settings")
      .then((s) => {
        setOpMode(normalizeMode(s.skip_op_mode, "auto"));
        setEdMode(normalizeMode(s.skip_ed_mode, "prompt"));
        setRecapMode(normalizeMode(s.skip_recap_mode, "prompt"));
      })
      .catch(() => {})
      .finally(() => setModesLoading(false));
  }, [open]);

  const patchMode = useCallback(async (
    field: "skip_op_mode" | "skip_ed_mode" | "skip_recap_mode",
    value: SkipMode,
  ) => {
    try {
      await invoke("update_settings", { patch: { [field]: value } });
      window.dispatchEvent(new CustomEvent("aura:settings-changed"));
    } catch {
      // No-op on failure — the local state already reflects the user's
      // pick optimistically; a refresh will surface the real backend
      // state next time the panel opens.
    }
  }, []);

  // ── Submit form ───────────────────────────────────────────────────
  const [formType, setFormType] = useState<SkipType>("op");
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput]     = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash]           = useState<string | null>(null);
  const showFlash = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 2500);
  };

  const handleSubmit = useCallback(async () => {
    const aniskipOk = malId != null && courEpisode != null;
    // IntroDB has no mixed-op type; that kind goes to AniSkip only.
    const idbOk = idbAvailable && formType !== "mixed-op";
    if (!aniskipOk && !idbOk) {
      showFlash(idbAvailable
        ? "IntroDB has no mixed opening type, and no MAL id resolved for AniSkip"
        : "MAL id not resolvable for this episode");
      return;
    }
    const start = parseTimeInput(startInput);
    const end = parseTimeInput(endInput);
    if (start == null || end == null) {
      showFlash("Could not parse start / end times");
      return;
    }
    if (end <= start) {
      showFlash("End must be after start");
      return;
    }
    setSubmitting(true);
    const notes: string[] = [];
    let anyOk = false;
    try {
      if (aniskipOk) {
        try {
          const result = await invoke<{ success: boolean; skip_id: string | null; message: string }>(
            "submit_skip_time",
            {
              malId, episode: courEpisode, skipType: formType,
              startTime: start, endTime: end, episodeLength: Math.max(0, duration),
            },
          );
          notes.push(`AniSkip: ${result.message || (result.success ? "Submitted" : "Submit failed")}`);
          if (result.success) {
            anyOk = true;
            // Drop the locally cached windows for this episode so the next load
            // picks the submission up. Rust invalidates its own entry inside the
            // command; this covers the 3-day frontend cache.
            window.dispatchEvent(new CustomEvent("aura:aniskip-invalidate", {
              detail: { malId, episode: courEpisode },
            }));
          }
        } catch (err) {
          notes.push(`AniSkip: ${String(err) || "Submit error"}`);
        }
      }
      if (idbOk && idbImdb && idbNumbering && activeTarget) {
        const seriesId = activeTarget.series_id ?? activeTarget.id;
        const res = await submitToIntroDb({
          imdb:    idbImdb,
          season:  idbNumbering.season,
          episode: idbNumbering.episode,
          kind:    formType,
          start,
          end,
          // TMDB id from the already-cached meta detail (no fetch here). Aura
          // has no TVDB id for a series, so that optional field is left out.
          tmdbId:  peekCachedDetailById(seriesId)?.tmdb_id ?? null,
        });
        if (res.outcome === "ok") {
          anyOk = true;
          notes.push("IntroDB: Submitted");
        } else if (res.outcome === "rate_limited") {
          // Not an error: this segment was sent in the last five minutes.
          anyOk = true;
          notes.push("IntroDB: already submitted recently");
        } else if (res.outcome === "key_rejected") {
          notes.push("IntroDB: key rejected");
          window.dispatchEvent(new CustomEvent("aura:player-toast", {
            detail: { message: "IntroDB rejected your API key. Check it in Settings > API Keys." },
          }));
        } else {
          notes.push(`IntroDB: ${res.message}`);
        }
      }
      showFlash(notes.join(" · ") || "Nothing submitted");
      if (anyOk) {
        setStartInput("");
        setEndInput("");
      }
    } finally {
      setSubmitting(false);
    }
  }, [malId, courEpisode, formType, startInput, endInput, duration,
      idbAvailable, idbImdb, idbNumbering, activeTarget]);

  // Per-skip vote state: tracks the user's last vote direction so the
  // button styling can highlight it AND so the cooldown disables both
  // arrows for ~3 seconds after a click. AniSkip's server-side likely
  // dedupes by submitterId, but client-side cooldown prevents the
  // spam-clicking pattern entirely (the buttons are physically
  // unclickable during the window). Map is per-render; resets on
  // menu remount which is fine — votes always go through the server's
  // dedupe anyway.
  const [voteState, setVoteState] = useState<Record<string, {
    last: "upvote" | "downvote" | null;
    cooldownUntil: number;
  }>>({});
  const VOTE_COOLDOWN_MS = 3000;

  const handleVote = useCallback(async (
    skipId: string | null | undefined,
    voteType: "upvote" | "downvote",
  ) => {
    if (!skipId) { showFlash("No skip id for this row"); return; }
    const now = Date.now();
    const prev = voteState[skipId];
    if (prev && now < prev.cooldownUntil) {
      const wait = Math.ceil((prev.cooldownUntil - now) / 1000);
      showFlash(`Wait ${wait}s before voting again`);
      return;
    }
    // Optimistically lock the buttons for both arrows on this skip
    // before the network call settles. Server-side rejections still
    // surface via the flash toast; the cooldown is purely about
    // preventing accidental double-clicks / spam.
    setVoteState((m) => ({
      ...m,
      [skipId]: { last: voteType, cooldownUntil: now + VOTE_COOLDOWN_MS },
    }));
    try {
      // mal/episode are passed so the backend can drop its cached copy of
      // this episode's windows: a downvote that keeps being served from
      // cache for 3 days is indistinguishable from a downvote that did
      // nothing.
      await invoke<boolean>("vote_skip_time", {
        skipId, voteType, malId, episode: courEpisode,
      });
      showFlash(voteType === "upvote" ? "Upvoted" : "Downvoted");
      window.dispatchEvent(new CustomEvent("aura:aniskip-invalidate", {
        detail: { malId, episode: courEpisode },
      }));
    } catch (err) {
      showFlash(String(err) || "Vote failed");
      // On failure roll back the optimistic lock so the user can
      // retry immediately — the network blip shouldn't force a 3s
      // wait.
      setVoteState((m) => {
        const next = { ...m };
        delete next[skipId];
        return next;
      });
    }
  }, [voteState, malId, courEpisode]);

  // Freeze the control bar's auto-hide while the panel is up, and let the
  // overlay swallow the click that dismisses it (menuTracker.ts).
  useMenuOpenSync(open);

  // Esc closes (capture phase so it wins over the player's global keybinds,
  // which would otherwise also leave fullscreen).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  // Sort windows for display: OP first, then mixed-op, ED, preview, recap.
  // A superseded AniSkip row sits right after the window that replaced it.
  const listed: Array<AniSkipMenuWindow & { superseded?: boolean }> = [
    ...windows,
    ...superseded.map((w) => ({ ...w, auto: false, superseded: true })),
  ];
  const orderedWindows = listed.sort((a, b) => {
    const order: Record<string, number> = { op: 0, "mixed-op": 1, ed: 2, "mixed-ed": 2, preview: 3, recap: 4 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9)
      || Number(a.superseded ?? false) - Number(b.superseded ?? false);
  });
  const modes = { op: opMode, ed: edMode, recap: recapMode };
  const segmentCount = windows.length;

  // A centered dialog styled after the Switch source panel (SourceSwitcher):
  // the same scrim, card, type sizes and row treatment, so the two player
  // panels read alike. Portalled to <body> so it is not clipped or faded with
  // the control bar it is opened from; React events still bubble through the
  // portal, so the root stops them before they reach the overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center"
      style={{ top: isFullscreen ? 0 : 36 }}
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {/* Scrim */}
      <div className="aura-modal-backdrop-in absolute inset-0 bg-black/55 backdrop-blur-[2px]" />

      {/* Panel */}
      <div
        className="aura-modal-card-in relative w-[min(560px,92vw)] max-h-[82vh] flex flex-col
                   rounded-2xl aura-glass-menu shadow-glass-edge overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="AuraSkip"
      >
        <div className="flex items-center justify-between gap-3 pl-5 pr-3 pt-4 pb-3 border-b border-white/8">
          <h2 className="text-white text-[16px] font-semibold tracking-tight">AuraSkip</h2>
          <div className="flex items-center gap-2">
            <span className="text-white/45 text-[12px] font-mono tabular-nums">
              {`${segmentCount} segment${segmentCount === 1 ? "" : "s"}`}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close AuraSkip menu"
              className="w-7 h-7 rounded-lg text-white/55 hover:text-white hover:bg-white/12
                         flex items-center justify-center transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        </div>

        <div className="overflow-y-auto px-2 py-2 aura-scroll">
          {/* ── Segments ─────────────────────────────────────────── */}
          <SectionLabel>Segments</SectionLabel>
          {orderedWindows.length === 0 && (
            <div className="py-6 text-center text-white/45 text-[13px]">
              No segments for this episode yet.
            </div>
          )}
          {orderedWindows.map((w, i) => {
            // Votes go to AniSkip by skip_id alone, so they are offered only
            // for a window fetched for the very entry and episode this menu
            // resolved. A window borrowed from another cour would otherwise
            // let a downvote land on that cour's row.
            const canVote = w.source === "aniskip" && !!w.skip_id
              && malId != null && courEpisode != null
              && w.skip_ref === `${malId}:${courEpisode}`;
            const sourceHint = skipSourceHint(w.source);
            // The kind is on Auto but this window may only prompt (a guess, a
            // preview, an AniSkip ending, ...): say so, and why on hover.
            const held = !w.superseded && !w.auto ? skipHeldReason(w, modes) : null;
            const song = [w.song_title, w.song_artist].filter(Boolean).join(" · ");
            // A replaced row is never skipped, so it carries no level.
            const conf = w.superseded ? null : skipConfidenceInfo(w);
            return (
              <div
                key={`${w.type}:${w.start}:${i}`}
                className={`rounded-xl px-3 py-2.5 mb-1 flex items-center gap-3
                            ${w.superseded ? "bg-white/[0.02]" : "bg-white/[0.04]"}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2.5">
                    <span className={`text-[13.5px] font-medium leading-snug
                                      ${w.superseded ? "text-white/60" : "text-white/90"}`}>
                      {skipLabel(w.type)}
                    </span>
                    <span className={`text-[12.5px] font-mono tabular-nums
                                      ${w.superseded ? "text-white/45" : "text-white/70"}`}>
                      {fmtTime(w.start)} - {fmtTime(w.end)}
                    </span>
                  </div>
                  {song && (
                    <p className="text-white/45 text-[11.5px] leading-snug line-clamp-1 mt-0.5" title={song}>
                      {song}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1 mt-1">
                    {conf && (
                      <Tooltip pos="top" text={conf.meaning}>
                        <SkipConfidenceBadge level={conf.level} help />
                      </Tooltip>
                    )}
                    {sourceHint
                      ? (
                        <Tooltip pos="top" text={sourceHint}>
                          <Chip tone="source" help>{skipSourceLabel(w.source)}</Chip>
                        </Tooltip>
                      )
                      : <Chip tone="source">{skipSourceLabel(w.source)}</Chip>}
                    {w.superseded
                      ? (
                        <Tooltip
                          pos="top"
                          text={canVote
                            ? "Not used: the theme match replaced it. You can still vote on it"
                            : "Not used: the theme match replaced it"}
                        >
                          <Chip tone="neutral" help>Replaced by theme match</Chip>
                        </Tooltip>
                      )
                      : w.auto
                        ? <Chip tone="status">Auto-skips</Chip>
                        : held
                          ? (
                            <Tooltip pos="top" text={held.hint}>
                              <Chip tone="status" help>Prompt only</Chip>
                            </Tooltip>
                          )
                          : <Chip tone="status">Asks first</Chip>}
                  </div>
                  {conf && (
                    <p className="text-white/55 text-[11.5px] leading-snug mt-1">{conf.note}</p>
                  )}
                </div>
                {canVote && w.skip_id && (() => {
                  const vs = voteState[w.skip_id];
                  const onCooldown = vs ? Date.now() < vs.cooldownUntil : false;
                  const lastUp   = vs?.last === "upvote";
                  const lastDown = vs?.last === "downvote";
                  return (
                    <div className="flex flex-col gap-0.5 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => handleVote(w.skip_id, "upvote")}
                        disabled={onCooldown}
                        aria-label="Upvote segment"
                        aria-pressed={lastUp}
                        title={onCooldown ? "Cooling down…" : "Upvote segment"}
                        className={`w-7 h-7 rounded-lg transition-colors flex items-center justify-center
                                    ${lastUp
                                      ? "text-ln-accent bg-ln-accent/20"
                                      : "text-ln-accent/85 hover:text-ln-accent hover:bg-ln-accent/15"}
                                    disabled:opacity-45 disabled:cursor-not-allowed
                                    disabled:hover:bg-transparent`}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M7 14l5-5 5 5z" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleVote(w.skip_id, "downvote")}
                        disabled={onCooldown}
                        aria-label="Downvote segment"
                        aria-pressed={lastDown}
                        title={onCooldown ? "Cooling down…" : "Downvote segment"}
                        className={`w-7 h-7 rounded-lg transition-colors flex items-center justify-center
                                    ${lastDown
                                      ? "text-rose-300 bg-rose-500/15"
                                      : "text-white/60 hover:text-rose-300 hover:bg-rose-500/12"}
                                    disabled:opacity-45 disabled:cursor-not-allowed
                                    disabled:hover:bg-transparent`}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M7 10l5 5 5-5z" />
                        </svg>
                      </button>
                    </div>
                  );
                })()}
              </div>
            );
          })}

          {/* ── Skip behaviour ───────────────────────────────────── */}
          <div className="mt-2 pt-2 border-t border-white/8">
            <SectionLabel>Skip behaviour</SectionLabel>
            <div className="px-3 space-y-2">
              <ModeRow
                label="Opening"
                value={opMode}
                disabled={modesLoading}
                onChange={(v) => { setOpMode(v); patchMode("skip_op_mode", v); showFlash(`Opening skip: ${v}`); }}
              />
              <ModeRow
                label="Ending"
                value={edMode}
                disabled={modesLoading}
                onChange={(v) => { setEdMode(v); patchMode("skip_ed_mode", v); showFlash(`Ending skip: ${v}`); }}
              />
              <ModeRow
                label="Recap"
                value={recapMode}
                disabled={modesLoading}
                onChange={(v) => { setRecapMode(v); patchMode("skip_recap_mode", v); showFlash(`Recap skip: ${v}`); }}
              />
            </div>
            {/* Live-apply feedback. auto<->prompt re-stamps the CURRENT episode's
                windows instantly (App.tsx listens for aura:settings-changed); the
                one case that can't apply live is turning on a segment that was Off
                when the episode started, because nothing was gathered for it (not
                an ending while the Next-Up card was on: the chain gathers endings
                for the card even on Off). */}
            <p className="text-white/55 text-[12px] leading-relaxed mt-2.5 px-3 pb-1">
              Some segments always ask first, even on Auto: hover "Prompt only"
              for why. Only Verified and Likely segments can skip on their own;
              Risky ones always ask first. A level can change while a prompt is
              showing, as the theme match finishes checking the episode. Ending
              Off also hides previews. Changes apply to this episode instantly,
              except turning on a segment that was Off when the episode started,
              which takes effect from the next stream load (an ending is ready at
              once while the Next Up card is on).
            </p>
          </div>

          {/* ── Submit form ──────────────────────────────────────── */}
          <div className="mt-2 pt-2 border-t border-white/8">
            <SectionLabel>Submit a segment</SectionLabel>
            <div className="px-3 pb-1 space-y-2.5">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <FieldLabel>Type</FieldLabel>
                  <select
                    value={formType}
                    onChange={(e) => setFormType(e.target.value as SkipType)}
                    className="w-full h-8 mt-1 bg-white/8 border border-white/12 rounded-lg px-2.5
                               text-[13px] text-white/90 outline-none focus:border-white/30 transition-colors
                               appearance-none cursor-pointer"
                    style={{
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='rgba(255,255,255,0.5)'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
                      backgroundRepeat: "no-repeat",
                      backgroundPosition: "right 8px center",
                      paddingRight: "24px",
                    }}
                  >
                    <option value="op">Opening</option>
                    <option value="mixed-op">Opening (mixed)</option>
                    <option value="ed">Ending</option>
                    <option value="recap">Recap</option>
                  </select>
                </div>
                <TimeField label="Start" value={startInput} onChange={setStartInput}
                           placeholder="0:00" onNow={() => setStartInput(fmtTime(time))} />
                <TimeField label="End" value={endInput} onChange={setEndInput}
                           placeholder="1:30" onNow={() => setEndInput(fmtTime(time))} />
              </div>

              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || ((malId == null || courEpisode == null) && !idbAvailable)}
                className="w-full h-8 px-3 rounded-lg border border-ln-accent/40
                           bg-ln-accent/15 text-ln-accent text-[13px] font-semibold
                           hover:bg-ln-accent/25 transition-colors
                           disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Submitting…" : "Submit segment"}
              </button>

              {malResolving && (
                <p className="text-white/50 text-[12px]">Resolving MAL id…</p>
              )}
              {!malResolving && malId == null && !idbAvailable && (
                <p className="text-amber-300/90 text-[12px] leading-snug">
                  No MyAnimeList entry found for this episode. AniSkip and theme
                  matching need one, so submission is unavailable.
                </p>
              )}
              {!malResolving && malId == null && idbAvailable && (
                <p className="text-white/55 text-[12px] leading-snug">
                  No MyAnimeList entry found for this episode (AniSkip and theme
                  matching need one): submits to IntroDB only.
                </p>
              )}
              {(!malResolving && malId != null) || (idbAvailable && idbNumbering) ? (
                <p className="text-white/40 text-[11.5px] font-mono">
                  {[
                    !malResolving && malId != null ? `mal ${malId} · ep ${courEpisode}` : null,
                    idbAvailable && idbNumbering
                      ? `introdb ${idbImdb} · s${idbNumbering.season}e${idbNumbering.episode}`
                      : null,
                  ].filter(Boolean).join("   ")}
                </p>
              ) : null}
            </div>
          </div>
        </div>

        <div className={`px-5 py-2.5 border-t border-white/8 text-[12px]
                         ${flash ? "text-ln-accent" : "text-white/40"}`}>
          {flash ?? "Esc to close"}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-1 pb-1.5 text-white/55 text-[11px] font-semibold uppercase tracking-wider">
      {children}
    </p>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <span className="block text-white/55 text-[11.5px]">{children}</span>;
}

// Deliberately colourless: green / amber / red on a row means its
// confidence level (SkipConfidenceBadge), never its skip mode.
type ChipTone = "source" | "status" | "neutral";

const CHIP_TONES: Record<ChipTone, string> = {
  source:  "bg-white/6 text-white/75 border-white/14",
  status:  "bg-white/10 text-white/85 border-white/20",
  neutral: "bg-white/4 text-white/55 border-white/12",
};

/** A small status pill, the same size and shape as the stream-quality chips
 *  in the Switch source panel. */
function Chip({ tone, help, children }: { tone: ChipTone; help?: boolean; children: ReactNode }) {
  return (
    <span
      className={`inline-block px-1.5 py-[1px] rounded border text-[10.5px] font-medium tracking-wide
                  ${CHIP_TONES[tone]} ${help ? "cursor-help" : ""}`}
    >
      {children}
    </span>
  );
}

function TimeField({
  label, value, onChange, placeholder, onNow,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onNow: () => void;
}) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <div className="mt-1 flex items-stretch h-8 rounded-lg bg-white/8 border border-white/12
                      focus-within:border-white/30 transition-colors overflow-hidden">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={`${label} time`}
          className="min-w-0 flex-1 bg-transparent px-2.5 text-[13px] font-mono text-white/90
                     outline-none placeholder:text-white/30"
        />
        <button
          type="button"
          onClick={onNow}
          title="Use the current playback position"
          className="px-2 text-[11.5px] font-semibold text-white/70 border-l border-white/12
                     hover:bg-white/12 hover:text-white transition-colors"
        >
          Now
        </button>
      </div>
    </div>
  );
}

/** One row of the skip-mode toggles: an off / prompt / auto pill group,
 *  styled like Settings > Anime OP/ED Skip's `SkipModeRow`. Colourless on
 *  purpose: green / amber / red in this panel mean confidence levels. */
function ModeRow({
  label, value, onChange, disabled,
}: {
  label: string;
  value: SkipMode;
  onChange: (v: SkipMode) => void;
  disabled?: boolean;
}) {
  const opts: { id: SkipMode; label: string; tone: string }[] = [
    { id: "off",    label: "Off",    tone: "text-white" },
    { id: "prompt", label: "Prompt", tone: "text-white" },
    { id: "auto",   label: "Auto",   tone: "text-white" },
  ];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[13.5px] text-white/90">{label}</span>
      <div
        className="flex-shrink-0 inline-flex rounded-full overflow-hidden
                   bg-white/5 border border-white/12 p-0.5 gap-0.5"
        role="radiogroup"
        aria-label={`${label} skip`}
      >
        {opts.map((o) => {
          const active = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.id)}
              disabled={disabled}
              className={`px-3.5 py-1 rounded-full text-[12px] font-medium tracking-wide
                          transition-colors duration-150
                          ${active
                            ? `bg-ln-accent/25 ${o.tone}`
                            : "text-white/55 hover:text-white/90"}
                          disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

