// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// SourceSwitcher — swap the streaming source for the CURRENTLY-PLAYING item
// in place, without leaving the player.
//
// A transient centered modal (above PlayerOverlay's z-[9999]) listing the
// other sources for the active target. Clicking a row re-invokes the canonical
// play path (App.handlePlayStream) with `forceStartSeconds` = the live
// position, so the swap inherits resolve → preheat → lang/subtitle/loudnorm/
// motion-interp/aniskip/thumb-prewarm for free and resumes at the same moment.
//
// Purely presentational: App owns the fetch + swap + open state and passes
// everything in. Opened via the `aura:open-source-switcher` window event
// dispatched from PlayerOverlay's MoreMenu.
// ---------------------------------------------------------------------------

import { useEffect, useMemo } from "react";
import type { StreamEntry } from "./types";
import { parseStream, chipStyleFor, type ChipKind } from "./streamMeta";

/** Stable identity for a stream row — used for the "now playing" + resolving
 *  markers. Mirrors how App keys the swap. */
export function streamKey(s: StreamEntry): string {
  return s.info_hash ?? s.url ?? `${s.addon_name}:${s.title}`;
}

/** Whether `row` is the same SOURCE as the currently-playing stream `cur`.
 *  Deliberately does NOT compare raw `url`s first: debrid links re-resolve to a
 *  fresh url on every fetch, so the switcher's own fetch yields a different url
 *  than the one that's playing (set from DetailView's fetch). That mismatch is
 *  why the row went un-highlighted on the FIRST play but matched after a swap
 *  (the swap played a row from this very list). Match on cross-fetch-stable
 *  identity instead: info_hash, then addon + release filename, then url. */
export function sameStreamSource(row: StreamEntry, cur: StreamEntry | null): boolean {
  if (!cur) return false;
  if (row.info_hash && cur.info_hash) return row.info_hash === cur.info_hash;
  const rf = row.filename ?? row.title ?? null;
  const cf = cur.filename ?? cur.title ?? null;
  if (row.addon_name && cur.addon_name && rf && cf) {
    return row.addon_name === cur.addon_name && rf === cf;
  }
  return row.url != null && row.url === cur.url;
}

interface SourceSwitcherProps {
  open: boolean;
  onClose: () => void;
  streams: StreamEntry[];
  loading: boolean;
  onPick: (stream: StreamEntry) => void;
  /** streamKey() of the row mid-resolve (spinner), or null. */
  resolvingKey: string | null;
  /** The currently-playing stream — matched on stable identity (not raw url,
   *  which differs across fetches for debrid sources). */
  currentStream: StreamEntry | null;
  /** Windowed playback keeps the 36px Win32 title bar — offset for it. */
  isFullscreen: boolean;
}

/** Compact quality chips for a row — the same parse + palette the
 *  DetailView stream list uses (`parseStream` / `chipStyleFor`), trimmed
 *  to the handful that matter when comparing sources at a glance. */
function rowChips(s: StreamEntry): { kind: ChipKind; label: string }[] {
  const p = parseStream(s);
  const chips: { kind: ChipKind; label: string }[] = [];
  // Debrid / service tile first ([TB]/[ND]/…) so the provider reads at a
  // glance — mirrors the DetailView stream row's service pill.
  if (p.serviceShort) chips.push({ kind: "service", label: `[${p.serviceShort}]` });
  if (p.resolution) chips.push({ kind: "resolution", label: p.resolution });
  const quality = p.quality ?? p.ripType;
  if (quality) chips.push({ kind: "quality", label: quality });
  if (p.hdr) chips.push({ kind: "hdr", label: p.hdr });
  const codec = p.codec ?? p.encode;
  if (codec) chips.push({ kind: "codec", label: codec });
  if (p.cachedStatus === "cached") chips.push({ kind: "service", label: "⚡ cached" });
  if (p.size) chips.push({ kind: "size", label: p.size });
  if (p.seeders != null) chips.push({ kind: "seeders", label: `${p.seeders} seed` });
  // Scraper (the addon that surfaced it) + release group — same fields and
  // palette the DetailView row shows, so the switcher matches it.
  if (p.addonName) chips.push({ kind: "addon", label: p.addonName });
  if (p.releaseGroup) chips.push({ kind: "group", label: p.releaseGroup });
  return chips.slice(0, 9);
}

export default function SourceSwitcher({
  open, onClose, streams, loading, onPick, resolvingKey, currentStream, isFullscreen,
}: SourceSwitcherProps) {
  // Esc closes (capture phase so it wins over the player's global keybinds).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Parse once per stream list, not once per render of every row —
  // resolvingKey/loading state flips would otherwise re-run the regex
  // parse across the whole list.
  const chipsByKey = useMemo(() => {
    const m = new Map<string, { kind: ChipKind; label: string }[]>();
    for (const s of streams) m.set(streamKey(s), rowChips(s));
    return m;
  }, [streams]);

  // Match the DetailView stream list's visible order: it groups streams by
  // addon (Map insertion order, order-preserving within a group). The raw
  // fetch can interleave addons, so without this the switcher's flat order
  // differs from the detail page. Group here so the two agree.
  const orderedStreams = useMemo(() => {
    const byAddon = new Map<string, StreamEntry[]>();
    for (const s of streams) {
      const list = byAddon.get(s.addon_name) ?? [];
      list.push(s);
      byAddon.set(s.addon_name, list);
    }
    return [...byAddon.values()].flat();
  }, [streams]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center"
      style={{ top: isFullscreen ? 0 : 36 }}
      onClick={onClose}
    >
      {/* Scrim */}
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" />

      {/* Panel */}
      <div
        className="relative w-[min(560px,92vw)] max-h-[78vh] flex flex-col
                   rounded-2xl aura-glass-menu shadow-glass-edge overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Switch source"
      >
        <div className="flex items-baseline justify-between px-5 pt-4 pb-3 border-b border-white/8">
          <h2 className="text-white text-[16px] font-semibold tracking-tight">Switch source</h2>
          <span className="text-white/45 text-[12px] font-mono tabular-nums">
            {loading ? "finding…" : `${streams.length} source${streams.length === 1 ? "" : "s"}`}
          </span>
        </div>

        <div className="overflow-y-auto px-2 py-2 aura-scroll">
          {loading && streams.length === 0 ? (
            <div className="py-10 flex flex-col items-center gap-3 text-white/50">
              <Spinner />
              <span className="text-[13px]">Finding other sources…</span>
            </div>
          ) : streams.length === 0 ? (
            <div className="py-10 text-center text-white/45 text-[13px]">
              No other sources available.
            </div>
          ) : (
            orderedStreams.map((s) => {
              const key = streamKey(s);
              const isCurrent = sameStreamSource(s, currentStream);
              const resolving = resolvingKey === key;
              return (
                <button
                  key={key}
                  type="button"
                  disabled={isCurrent || resolving}
                  onClick={() => onPick(s)}
                  className={`w-full text-left rounded-xl px-3 py-2.5 mb-1 flex items-center gap-3
                              transition-colors
                              ${isCurrent
                                ? "bg-ln-accent/10 cursor-default"
                                : "hover:bg-white/[0.07] focus:bg-white/[0.07] focus:outline-none"}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-ln-accent/80 text-[10.5px] font-mono uppercase tracking-wider truncate max-w-[40%]">
                        {s.addon_name}
                      </span>
                      {isCurrent && (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded
                                         bg-ln-accent/20 text-ln-accent border border-ln-accent/30">
                          Now Playing
                        </span>
                      )}
                    </div>
                    <p className="text-white/90 text-[13.5px] font-medium leading-snug line-clamp-2 mt-0.5"
                       title={s.filename ?? s.title}>
                      {s.title}
                    </p>
                    {(chipsByKey.get(key) ?? []).length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        {(chipsByKey.get(key) ?? []).map((c, i) => {
                          const st = chipStyleFor(c.kind);
                          return (
                            <span
                              key={`${c.kind}:${i}`}
                              className={`px-1.5 py-[1px] rounded border text-[10px] font-medium tracking-wide ${st.bg} ${st.fg} ${st.border}`}
                            >
                              {c.label}
                            </span>
                          );
                        })}
                      </div>
                    )}
                    {s.description && (
                      <p className="text-white/40 text-[11.5px] leading-snug line-clamp-1 mt-0.5">
                        {s.description}
                      </p>
                    )}
                  </div>
                  {resolving && <Spinner small />}
                </button>
              );
            })
          )}
        </div>

        <div className="px-5 py-2.5 border-t border-white/8 text-white/35 text-[11px]">
          Click a source to swap in place · Esc to close
        </div>
      </div>
    </div>
  );
}

function Spinner({ small }: { small?: boolean }) {
  const sz = small ? "w-4 h-4" : "w-6 h-6";
  return (
    <svg className={`${sz} animate-spin text-white/55 flex-shrink-0`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
