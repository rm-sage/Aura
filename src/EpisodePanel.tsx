// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// EpisodePanel — the in-playback / EOS-Spotlight episode list. A right-
// side slide-in glass drawer (EOS Spotlight spec 2026-05-19, Phase 3).
// SAME component opened by:
//   • the EosSpotlight "Episodes" button (App-level), and
//   • the hover-right-edge handle in PlayerOverlay (Phase 4).
//
// Self-contained: resolves its OWN MetaDetail via getMetaDetailFallback
// (already warmed by the NextUp pre-resolve / DetailView during a normal
// session, so the open is usually instant; cold opens show a skeleton).
// Header = the shared SeasonSelect + episode count; the scrollable list
// renders MetaDetail.videos for the selected season, current + next
// episodes highlighted, click → play (App injects the stream-pick path).
//
// Spoiler parity with DetailView is exact: thumbnails use the pure
// `shouldBlurThumbnail` gate (same keys), and an unwatched-blurred thumb
// shows a small lock affordance — identical rule to EpisodeRow. The glass
// uses `.aura-glass-menu` (App.css) for the readable-over-bright-video
// surface + universal text-shadow lift; the scrim is a touch stronger
// than the dropdown for legibility over a bright paused frame.
// ---------------------------------------------------------------------------

import { memo, useEffect, useMemo, useRef, useState } from "react";
import ImageLoader from "./ImageLoader";
import SeasonSelect from "./SeasonSelect";
import type { AddonEntry, LibraryItem, MetaDetail, VideoEntry } from "./types";
import { getMetaDetailFallback, peekCachedDetailById } from "./metaCache";
import { getSortedEpisodes } from "./episodeSort";
import { loadAuraSettings } from "./auraSettings";
import { shouldBlurThumbnail, isEpisodeWatched } from "./episodeSpoilers";
import { formatEpisodeTag } from "./nextUp";
import { isVideoAired } from "./types";
import { nextAiringEpisode, formatTargetDate } from "./releaseCountdown";
import EpisodeAirChip from "./EpisodeAirChip";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Series root id (library-record key). */
  seriesId: string;
  /** "series" / "anime" — drives the meta-cache URL path. */
  mediaType: string;
  addons: AddonEntry[];
  /** The episode currently playing (highlighted + initial season). */
  currentEpisodeId: string | null;
  /** The resolved next episode id (highlighted as "Next"), if any. */
  nextEpisodeId: string | null;
  /** True in OS fullscreen — the Win32 title bar is hidden, so the
   *  drawer can start at top:0; in windowed mode offset 36px below the
   *  always-visible 36px Win32 title bar (CLAUDE.md landmine #6). */
  isFullscreen: boolean;
  /** id→LibraryItem index for the pure spoiler gate. */
  libraryById: Map<string, LibraryItem>;
  /** Series art fallback. NO LONGER used for panel rows (those now
   *  always show the blurred episode still, mirroring DetailView's
   *  EpisodeRow); retained only so EosSpotlight's large preview can
   *  pass it through unchanged. */
  seriesArt: string | null;
  /** App injects the play path (resolves a stream, swaps the active
   *  target through handlePlayStream — carries History/scrobble). May
   *  be sync (Option-A EOS-bounce handler) or async (legacy direct-play
   *  path); the single-flight wrapper below treats both uniformly. */
  onPlayEpisode: (video: VideoEntry) => void | Promise<void>;
}

function EpisodePanel({
  open, onClose, seriesId, mediaType, addons,
  currentEpisodeId, nextEpisodeId, isFullscreen, libraryById,
  seriesArt: _seriesArt, onPlayEpisode,
}: Props) {
  // Seed synchronously from the meta cache so a warm open paints
  // immediately (no skeleton flash); fall back to the async fetch.
  const [detail, setDetail] = useState<MetaDetail | null>(
    () => peekCachedDetailById(seriesId),
  );
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const warm = peekCachedDetailById(seriesId);
    if (warm) setDetail(warm);
    if (!warm) setLoading(true);
    void (async () => {
      const d = await getMetaDetailFallback(addons, mediaType, seriesId);
      if (cancelled) return;
      if (d) setDetail(d);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [open, seriesId, mediaType, addons]);

  const sorted = useMemo(
    () => (detail ? getSortedEpisodes(detail) : []),
    [detail],
  );
  const seasons = useMemo(() => {
    const set = new Set<number>();
    for (const v of sorted) set.add(v.season ?? 0);
    return [...set].sort((a, b) => a - b);
  }, [sorted]);

  // Initial season = the current episode's season (fallback: first).
  const currentSeason = useMemo(() => {
    const cur = sorted.find((v) => v.id === currentEpisodeId);
    return cur?.season ?? seasons[0] ?? 1;
  }, [sorted, currentEpisodeId, seasons]);

  const [season, setSeason] = useState<number>(currentSeason);
  // Re-anchor on the current season whenever the panel (re)opens or the
  // playing episode changes — but don't fight the user's manual pick
  // while it stays open.
  const reopenKey = `${open ? "o" : "c"}:${currentEpisodeId ?? ""}`;
  const lastReopenRef = useRef("");
  useEffect(() => {
    if (lastReopenRef.current === reopenKey) return;
    lastReopenRef.current = reopenKey;
    if (open) setSeason(currentSeason);
  }, [reopenKey, open, currentSeason]);

  const inSeason = useMemo(
    () => sorted.filter((v) => (v.season ?? 0) === season),
    [sorted, season],
  );

  // Next-to-air episode across ALL seasons — its row shows the live
  // countdown chip. No per-second tick here; the chip owns its own.
  const nextAiringId = useMemo(
    () => nextAiringEpisode(sorted)?.id ?? null,
    [sorted],
  );

  const blurThumbs = loadAuraSettings().blurUnwatchedThumbnails;

  // Auto-scroll the playing episode into view on open.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !currentEpisodeId) return;
    const id = window.setTimeout(() => {
      const el = listRef.current?.querySelector(
        `[data-ep-id="${CSS.escape(currentEpisodeId)}"]`,
      );
      el?.scrollIntoView({ block: "center" });
    }, 60);
    return () => window.clearTimeout(id);
  }, [open, currentEpisodeId, season]);

  // Escape closes (matches the other player submenus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Single-flight guard for episode-row clicks. Without this, a rapid
  // double-click (or impatient repeated clicks while the EOS-bounce
  // tears playback down) can queue parallel play paths through the
  // App-level handler — each one mutating activeTarget / DetailView
  // state out from under the previous. The ref short-circuits the
  // second click before any state work; the state flag drives a small
  // spinner overlay + `disabled` on every row so the user sees the
  // click landed. Reset on panel close (open === false).
  const [pendingPlayId, setPendingPlayId] = useState<string | null>(null);
  const pendingPlayRef = useRef<string | null>(null);

  const handleRowClick = (v: VideoEntry) => {
    if (v.id === currentEpisodeId) return; // currently playing — no-op
    if (pendingPlayRef.current) return;    // already a play in flight
    pendingPlayRef.current = v.id;
    setPendingPlayId(v.id);
    // Fire-and-release. onPlayEpisode may be sync (Option-A handler is
    // sync void) or async; treat uniformly.
    Promise.resolve(onPlayEpisode(v)).finally(() => {
      pendingPlayRef.current = null;
      setPendingPlayId(null);
    });
  };

  useEffect(() => {
    if (!open) {
      pendingPlayRef.current = null;
      setPendingPlayId(null);
    }
  }, [open]);

  if (!open) return null;

  return (
    <>
      {/* Scrim — a touch stronger than the season dropdown for
          legibility over a bright paused frame. Click to dismiss; the
          click is swallowed here so it never reaches the video region's
          play/pause toggle underneath. */}
      <div
        className="fixed inset-0 z-[10400] pointer-events-auto bg-black/45 animate-[fade-in_140ms_ease-out]"
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      />
      <div
        className="fixed right-0 bottom-0 z-[10400] pointer-events-auto w-[420px] max-w-[88vw]
                   aura-glass-menu border-l border-white/10
                   flex flex-col text-white
                   animate-[ep-panel-slide_220ms_cubic-bezier(0.16,1,0.3,1)]"
        style={{ top: isFullscreen ? 0 : 36 }}
        role="dialog"
        aria-label="Episodes"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            {seasons.length > 1 ? (
              <SeasonSelect seasons={seasons} value={season} onChange={setSeason} />
            ) : (
              <span className="text-[15px] font-mono tracking-wide text-white/80">
                Episodes
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-white/45 text-[12px] font-mono tracking-wider">
              {inSeason.length} {inSeason.length === 1 ? "ep" : "eps"}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close episode list"
              className="w-7 h-7 rounded-full text-white/55 hover:text-white
                         hover:bg-white/10 transition-colors flex items-center justify-center"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </div>
        </div>

        {/* List */}
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto px-3 pb-4 space-y-1.5"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.10) transparent" }}
        >
          {loading && inSeason.length === 0 ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[84px] rounded-xl bg-white/[0.04] animate-pulse" />
            ))
          ) : inSeason.length === 0 ? (
            <p className="text-white/45 text-[13px] italic px-3 py-6 text-center">
              No episode list available.
            </p>
          ) : (
            inSeason.map((v) => {
              const isCurrent = v.id === currentEpisodeId;
              const isNext = v.id === nextEpisodeId;
              const watched = isEpisodeWatched(libraryById, v.id);
              const blurThumb = shouldBlurThumbnail(libraryById, v.id, blurThumbs);
              const isPending = pendingPlayId === v.id;
              // Unaired = parseable FUTURE air date (undated specials count
              // as aired). The next-to-air row gets the live chip; later
              // unaired rows a static date. Both dim the thumbnail.
              const unaired = !isVideoAired(v);
              const airMs = unaired && v.released ? Date.parse(v.released) : null;
              const isNextAiring = v.id === nextAiringId;
              return (
                <button
                  key={v.id}
                  data-ep-id={v.id}
                  type="button"
                  onClick={() => handleRowClick(v)}
                  disabled={pendingPlayId !== null}
                  aria-busy={isPending || undefined}
                  className={`relative overflow-hidden w-full flex gap-3 p-2 rounded-xl text-left transition-colors
                              disabled:cursor-default
                              ${isCurrent
                                ? "bg-ln-accent/15 border border-ln-accent/35"
                                : "border border-transparent hover:bg-white/[0.07]"}`}
                >
                  <div
                    className="relative flex-shrink-0 w-[120px] rounded-lg overflow-hidden
                               bg-white/5 border border-white/10"
                    style={{ aspectRatio: "16 / 9" }}
                  >
                    {v.thumbnail ? (
                      <ImageLoader
                        src={v.thumbnail}
                        alt=""
                        className="absolute inset-0 w-full h-full"
                        imgClassName={`w-full h-full object-cover transition-[filter] duration-300
                                       ${blurThumb ? "blur-md scale-110" : ""}`}
                      />
                    ) : (
                      <div className="absolute inset-0 flex items-center justify-center text-white/25">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M8 5v14l11-7z" />
                        </svg>
                      </div>
                    )}
                    {/* Anti-spoiler veil — slight darken under the blur so
                        the row text reads cleanly; mirrors DetailView's
                        EpisodeRow exactly. */}
                    {blurThumb && v.thumbnail && (
                      <div
                        aria-hidden
                        className="absolute inset-0 bg-black/30 transition-opacity duration-300 flex items-center justify-center"
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-white/55" aria-hidden>
                          <path d="M12 17a2 2 0 0 0 2-2 2 2 0 0 0-2-2 2 2 0 0 0-2 2 2 2 0 0 0 2 2m6-9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2h1V6a5 5 0 0 1 5-5 5 5 0 0 1 5 5v2h1M12 3a3 3 0 0 0-3 3v2h6V6a3 3 0 0 0-3-3z" />
                        </svg>
                      </div>
                    )}
                    {/* Unaired veil — dims upcoming episodes (mirrors
                        DetailView's EpisodeRow). */}
                    {unaired && (
                      <div aria-hidden className="absolute inset-0 bg-black/45" />
                    )}
                    {watched && (
                      <span className="absolute bottom-1 right-1 w-4 h-4 rounded-full
                                       bg-emerald-500/90 border border-emerald-200/40
                                       flex items-center justify-center">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                          <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                        </svg>
                      </span>
                    )}
                    {/* Next-to-air countdown pill — CW-tile style overlay. */}
                    {isNextAiring && airMs != null && (
                      <EpisodeAirChip targetMs={airMs} />
                    )}
                  </div>
                  <div className="flex-1 min-w-0 py-0.5">
                    <div className="flex items-center gap-2">
                      <span className="text-white/45 text-[10.5px] font-mono uppercase tracking-[0.14em]">
                        {formatEpisodeTag(v)}
                      </span>
                      {isCurrent && (
                        <span className="text-ln-accent text-[9.5px] font-semibold uppercase tracking-wider">
                          Now playing
                        </span>
                      )}
                      {isNext && !isCurrent && (
                        <span className="text-white/70 text-[9.5px] font-semibold uppercase tracking-wider">
                          Next
                        </span>
                      )}
                    </div>
                    <p className="text-white/90 text-[13px] font-medium leading-tight mt-0.5 line-clamp-2">
                      {(v.title ?? "").trim() || "Untitled episode"}
                    </p>
                    {unaired && airMs != null && (
                      <p className="text-white/45 text-[11px] mt-1 whitespace-nowrap">
                        Airs {formatTargetDate(airMs)}
                      </p>
                    )}
                  </div>
                  {isPending && (
                    <span
                      aria-hidden
                      className="absolute inset-0 flex items-center justify-center
                                 bg-black/45 backdrop-blur-sm pointer-events-none"
                    >
                      <svg
                        width="22"
                        height="22"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        className="animate-spin text-white/85"
                      >
                        <path d="M21 12a9 9 0 1 1-9-9" />
                      </svg>
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

export default memo(EpisodePanel);
