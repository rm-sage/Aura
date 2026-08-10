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
// Opens from the player's three-dots MoreMenu via the "AniSkip
// Segments" item. Renders as a glass-styled popover anchored to the
// bottom-right of the player.
//
// Cour-aware MAL resolution: AniSkip indexes by MAL anime id + LOCAL
// per-cour episode (1-N within the entry). For cour-aggregated anime,
// the cour-specific MAL id lives behind the video id's anime-prefix
// portion (`kitsu:49240:9` → kitsu 49240 → yuna.moe → MAL 59978). We
// resolve once on mount and reuse for both submission and metadata
// display.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ActiveScrobbleTarget } from "./useScrobble";

/** Mirrors PlayerOverlay's AuraSkipWindow shape so this module can be
 *  imported without a circular dep. Local copy is intentional. */
export interface AniSkipMenuWindow {
  type: string;
  start: number;
  end: number;
  source: string;
  auto: boolean;
  skip_id?: string | null;
  /** Opening / ending song, when identified. This local copy of the window
   *  shape is deliberate (it avoids a circular import with PlayerOverlay);
   *  keep it in step with that file and with App.tsx. */
  song_title?:  string | null;
  song_artist?: string | null;
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
  if (!Number.isFinite(sec)) return "—";
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
  switch (kind) {
    case "op":       return "Opening";
    case "mixed-op": return "Opening (mixed)";
    case "ed":       return "Ending";
    case "recap":    return "Recap";
    default:         return "Segment";
  }
}

export default function AniSkipMenu({
  open, onClose, activeTarget, time, duration, windows,
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
  const courEpisode = useMemo(() => {
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

  useEffect(() => {
    if (!open || !activeTarget) return;
    let cancelled = false;
    setMalResolving(true);
    setMalId(null);
    (async () => {
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
  }, [open, activeTarget]);

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
    if (malId == null || courEpisode == null) {
      showFlash("MAL id not resolvable for this episode");
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
    try {
      const result = await invoke<{ success: boolean; skip_id: string | null; message: string }>(
        "submit_skip_time",
        {
          malId, episode: courEpisode, skipType: formType,
          startTime: start, endTime: end, episodeLength: Math.max(0, duration),
        },
      );
      showFlash(result.message || (result.success ? "Submitted!" : "Submit failed"));
      if (result.success) {
        setStartInput("");
        setEndInput("");
        // Drop the locally cached windows for this episode so the next load
        // picks the submission up. Rust invalidates its own entry inside the
        // command; this covers the 3-day frontend cache.
        window.dispatchEvent(new CustomEvent("aura:aniskip-invalidate", {
          detail: { malId, episode: courEpisode },
        }));
      }
    } catch (err) {
      showFlash(String(err) || "Submit error");
    } finally {
      setSubmitting(false);
    }
  }, [malId, courEpisode, formType, startInput, endInput, duration]);

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

  if (!open) return null;

  // Sort windows for display: OP first, then mixed-op, ED, recap.
  const orderedWindows = [...windows].sort((a, b) => {
    const order: Record<string, number> = { op: 0, "mixed-op": 1, ed: 2, recap: 3 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9);
  });

  return (
    <div
      // Anchored fixed bottom-right of the viewport so the menu sits
      // OFF TO THE SIDE of the controls bar rather than overlapping
      // the scrub bar above the three-dots button. `bottom-24` leaves
      // clearance for the controls bar height; `right-4` keeps the
      // panel away from the right edge. max-w-[92vw] handles the
      // narrow-viewport collapse without spilling off-screen.
      className="fixed bottom-24 right-4 z-50
                 rounded-xl aura-glass-menu shadow-glass-edge
                 w-[460px] max-w-[92vw] text-white/85"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header — title centered with the close button absolute-
          positioned so its 24 px footprint doesn't shift the title
          off-center. Letterspacing + uppercase tones match the
          column subheaders below for visual consistency with the
          rest of the player's submenus. */}
      <div className="relative px-4 pt-3 pb-2 border-b border-white/8">
        <h3 className="text-white/85 text-[11.5px] font-semibold uppercase tracking-[0.18em] text-center">
          AuraSkip
        </h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close AuraSkip menu"
          className="absolute top-2.5 right-2.5 w-6 h-6 rounded text-white/55 hover:text-white hover:bg-white/12
                     flex items-center justify-center transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 p-4">
        {/* ── Left column: existing segments ─────────────────────── */}
        <div className="space-y-2">
          <p className="text-white/60 text-[11px] font-semibold uppercase tracking-wider">
            Segments
          </p>
          {orderedWindows.length === 0 && (
            <p className="text-white/40 text-[12px] italic">
              No segments yet — submit one on the right.
            </p>
          )}
          {orderedWindows.map((w, i) => (
            <div
              key={`${w.type}:${w.start}:${i}`}
              className="rounded-lg bg-white/[0.05] border border-white/8 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-[12px] font-semibold leading-tight">
                    {skipLabel(w.type)}
                  </p>
                  <p className="text-white/55 text-[10.5px] font-mono mt-0.5">
                    {fmtTime(w.start)} – {fmtTime(w.end)}
                  </p>
                  {w.auto && (
                    <p className="text-amber-300/80 text-[10px] mt-0.5">auto-skip</p>
                  )}
                </div>
                {w.source === "aniskip" && w.skip_id && (() => {
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
                        className={`w-6 h-6 rounded transition-colors flex items-center justify-center
                                    ${lastUp
                                      ? "text-ln-accent bg-ln-accent/20"
                                      : "text-ln-accent/85 hover:text-ln-accent hover:bg-ln-accent/15"}
                                    disabled:opacity-45 disabled:cursor-not-allowed
                                    disabled:hover:bg-transparent`}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
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
                        className={`w-6 h-6 rounded transition-colors flex items-center justify-center
                                    ${lastDown
                                      ? "text-rose-300 bg-rose-500/15"
                                      : "text-white/55 hover:text-rose-300 hover:bg-rose-500/12"}
                                    disabled:opacity-45 disabled:cursor-not-allowed
                                    disabled:hover:bg-transparent`}
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M7 10l5 5 5-5z" />
                        </svg>
                      </button>
                    </div>
                  );
                })()}
              </div>
            </div>
          ))}
        </div>

        {/* ── Right column: submit form ──────────────────────────── */}
        <div className="space-y-2.5">
          <p className="text-white/60 text-[11px] font-semibold uppercase tracking-wider">
            Submit new segment
          </p>

          <div>
            <label className="text-white/45 text-[10px] uppercase tracking-wider">Type</label>
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value as SkipType)}
              className="w-full mt-1 bg-white/8 border border-white/12 rounded-lg px-3 py-1.5
                         text-[12px] outline-none focus:border-white/25 transition-colors
                         appearance-none cursor-pointer"
              style={{
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='rgba(255,255,255,0.4)'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
                backgroundRepeat: "no-repeat",
                backgroundPosition: "right 10px center",
                paddingRight: "28px",
              }}
            >
              <option value="op">Opening</option>
              <option value="mixed-op">Opening (mixed-op)</option>
              <option value="ed">Ending</option>
              <option value="recap">Recap</option>
            </select>
          </div>

          <div>
            <label className="text-white/45 text-[10px] uppercase tracking-wider">Start time</label>
            <div className="mt-1 flex items-stretch gap-1.5">
              <input
                value={startInput}
                onChange={(e) => setStartInput(e.target.value)}
                placeholder="e.g. 0:00 or 90"
                className="flex-1 bg-white/8 border border-white/12 rounded-lg px-3
                           text-[12px] font-mono outline-none focus:border-white/25
                           placeholder:text-white/30 transition-colors"
              />
              <button
                type="button"
                onClick={() => setStartInput(fmtTime(time))}
                title="Use current playback position"
                className="px-2.5 rounded-lg bg-white/8 border border-white/12
                           text-[11px] font-semibold hover:bg-white/12 transition-colors"
              >
                Now
              </button>
            </div>
          </div>

          <div>
            <label className="text-white/45 text-[10px] uppercase tracking-wider">End time</label>
            <div className="mt-1 flex items-stretch gap-1.5">
              <input
                value={endInput}
                onChange={(e) => setEndInput(e.target.value)}
                placeholder="e.g. 1:30 or 180"
                className="flex-1 bg-white/8 border border-white/12 rounded-lg px-3
                           text-[12px] font-mono outline-none focus:border-white/25
                           placeholder:text-white/30 transition-colors"
              />
              <button
                type="button"
                onClick={() => setEndInput(fmtTime(time))}
                title="Use current playback position"
                className="px-2.5 rounded-lg bg-white/8 border border-white/12
                           text-[11px] font-semibold hover:bg-white/12 transition-colors"
              >
                Now
              </button>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || malId == null || courEpisode == null}
            className="w-full mt-1 px-3 py-1.5 rounded-lg border border-ln-accent/40
                       bg-ln-accent/15 text-ln-accent text-[12px] font-semibold
                       hover:bg-ln-accent/25 transition-colors
                       disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? "Submitting…" : "+ Submit segment"}
          </button>

          {malResolving && (
            <p className="text-white/40 text-[10.5px] italic">
              Resolving MAL id…
            </p>
          )}
          {!malResolving && malId == null && (
            <p className="text-amber-300/75 text-[10.5px] italic">
              MAL id not resolvable for this episode — submission unavailable.
            </p>
          )}
          {!malResolving && malId != null && (
            <p className="text-white/35 text-[10.5px] font-mono">
              mal={malId} · ep={courEpisode}
            </p>
          )}
        </div>
      </div>

      {/* ── Skip-mode toggles (full-width row) ───────────────────── */}
      <div className="px-4 pb-3 pt-1 border-t border-white/8">
        <p className="text-white/60 text-[11px] font-semibold uppercase tracking-[0.18em] mb-2 text-center">
          Skip behaviour
        </p>
        <div className="space-y-1.5">
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
            one case that can't apply live is re-enabling a segment turned fully
            off, because its window was dropped from the active payload. */}
        <p className="text-white/40 text-[10px] leading-snug mt-2 text-center px-2">
          Applies to the current episode instantly. Turning a segment fully off
          then back on takes effect from the next stream load.
        </p>
      </div>

      {flash && (
        <div className="px-4 py-2 text-[11px] font-mono text-ln-accent/85 border-t border-white/8">
          {flash}
        </div>
      )}
    </div>
  );
}

/** One row of the skip-mode toggles — off / prompt / auto pill group.
 *  Matches Settings → Anime OP/ED Skip's `SkipModeRow` styling exactly
 *  so the player-side mirror feels visually unified: rounded-full
 *  capsule with per-state tone (white/55 off, amber prompt, emerald
 *  auto) and a soft accent background on the active pill. */
function ModeRow({
  label, value, onChange, disabled,
}: {
  label: string;
  value: SkipMode;
  onChange: (v: SkipMode) => void;
  disabled?: boolean;
}) {
  const opts: { id: SkipMode; label: string; tone: string }[] = [
    { id: "off",    label: "Off",    tone: "text-white/55" },
    { id: "prompt", label: "Prompt", tone: "text-amber-300" },
    { id: "auto",   label: "Auto",   tone: "text-emerald-300" },
  ];
  return (
    // Center the label+toggle pair as a unit instead of pinning the
    // toggle to the right edge — at 460px panel width the previous
    // justify-between layout left a huge gap between e.g. "Opening"
    // and the pill group. Fixed-width label keeps the rows aligned
    // vertically; gap-3 sits the toggle right next to the label.
    <div className="flex items-center justify-center gap-3">
      <span className="text-[12px] text-white/85 flex-shrink-0 w-[68px] text-right">{label}</span>
      <div
        className="flex-shrink-0 inline-flex rounded-full overflow-hidden
                   bg-white/5 border border-white/10 p-0.5 gap-0.5"
      >
        {opts.map((o) => {
          const active = value === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              disabled={disabled}
              className={`px-3 py-1 rounded-full text-[11.5px] font-medium tracking-wide
                          transition-colors duration-150
                          ${active
                            ? `bg-ln-accent/20 ${o.tone}`
                            : "text-white/55 hover:text-white/85"}
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
