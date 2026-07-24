// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// Changelog.tsx ──────────────────────────────────────────────────────────────
//
// Full release history modal, opened from the version line in Settings. Loads
// the GitHub release notes RELEASES_PAGE_SIZE versions at a time ("View more"),
// rendering each with the shared release-notes renderer so it matches the
// update popup. Esc / backdrop-click dismiss; pages are cached for the session.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fetchReleasePage, formatReleaseDate, RELEASES_PAGE_SIZE, type ReleaseNote } from "./changelogApi";
import { ReleaseNotesBody } from "./releaseNotesRender";

export default function Changelog({
  currentVersion,
  onClose,
}: {
  currentVersion: string;
  onClose: () => void;
}) {
  const [releases, setReleases] = useState<ReleaseNote[]>([]);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // True once a page returns fewer than a full batch — no older releases left.
  const [done, setDone] = useState(false);

  const loadMore = useCallback(async () => {
    if (loading || done) return;
    setLoading(true);
    setError(null);
    const next = page + 1;
    try {
      const batch = await fetchReleasePage(next);
      setReleases((prev) => [...prev, ...batch.items]);
      setPage(next);
      if (!batch.full) setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loading, done, page]);

  // First page on mount.
  useEffect(() => { void loadMore(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const node = (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Changelog"
      className="aura-update-backdrop fixed inset-0 z-[60] flex items-center justify-center
                 bg-black/60 backdrop-blur-md"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="aura-update-card glass-panel-elevated rounded-2xl w-full max-w-[680px] mx-4
                   shadow-glass-edge flex flex-col max-h-[82vh]"
        // glass-panel-elevated's background is the per-theme ACCENT-tinted glass
        // (--ln-glass-3), which made the whole changelog read as the accent
        // colour. Override to a NEUTRAL frosted glass (the white-on-dark texture
        // the neutral themes use) while keeping the blur + luminous rim, so the
        // accent shows only in the headers, not the whole surface.
        style={{ background: "rgba(255, 255, 255, 0.06)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-7 pt-6 pb-4 border-b border-white/8">
          <div className="flex flex-col gap-0.5">
            <h2 className="text-[var(--text-primary)] text-xl font-medium tracking-wide">
              <span className="text-ln-accent">Changelog</span>
            </h2>
            <p className="text-white/45 text-xs tracking-wide">Currently on Aura {currentVersion}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-white/50
                       hover:text-white hover:bg-white/8 transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 5.7 18.3l-1.42-1.42L9.17 12 4.29 5.71 5.7 4.29l4.89 4.88 4.88-4.88z" />
            </svg>
          </button>
        </div>

        {/* Scrollable body. Thin translucent scrollbar (the app-wide convention)
            so it reads as part of the frosted glass instead of the default chunky
            WebView2 bar that crowded the release cards. */}
        <div
          className="flex-1 min-h-0 overflow-y-auto px-7 py-5 space-y-5"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          {releases.map((r) => (
            <section key={r.tag} className="space-y-2.5">
              <div className="flex items-baseline gap-2.5">
                <h3 className="text-white text-[15px] font-semibold tracking-tight">Aura {r.version}</h3>
                {r.version === currentVersion && (
                  <span className="px-1.5 py-px rounded text-[9px] font-bold uppercase tracking-wider
                                   bg-ln-accent/20 text-ln-accent border border-ln-accent/30">
                    Installed
                  </span>
                )}
                {formatReleaseDate(r.date) && (
                  <span className="text-white/35 text-[11px] font-mono ml-auto">{formatReleaseDate(r.date)}</span>
                )}
              </div>
              <div className="rounded-xl bg-white/[0.03] border border-white/[0.08] px-5 py-4">
                {r.notes.trim()
                  ? <ReleaseNotesBody notes={r.notes} max={Infinity} />
                  : <p className="text-white/40 text-[13px] italic">No notes for this release.</p>}
              </div>
            </section>
          ))}

          {error && (
            <div className="rounded-lg border border-red-400/30 bg-red-500/8 px-3 py-2">
              <p className="text-red-200/90 text-[12px] leading-snug">{error}</p>
            </div>
          )}

          {!loading && releases.length === 0 && !error && (
            <p className="text-white/40 text-[13px] italic text-center py-6">No releases found.</p>
          )}

          {/* Pager */}
          <div className="flex items-center justify-center pt-1 pb-1">
            {loading ? (
              <span className="text-white/40 text-[12px]">Loading…</span>
            ) : done ? (
              releases.length > 0 && (
                <span className="text-white/30 text-[11px]">You've reached the first release.</span>
              )
            ) : (
              <button
                type="button"
                onClick={() => void loadMore()}
                className="px-4 py-2 rounded-xl text-[12.5px] font-medium text-white/80
                           bg-white/[0.05] border border-white/10 hover:bg-white/10 transition-colors"
              >
                {error ? "Retry" : `View ${RELEASES_PAGE_SIZE} more`}
              </button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-7 py-3 border-t border-white/8 flex justify-end">
          <button
            type="button"
            onClick={() => openUrl("https://github.com/rm-sage/Aura/releases").catch(() => {})}
            className="px-3 py-1.5 rounded-lg text-[11px] text-white/45 hover:text-white/75
                       hover:bg-white/[0.04] transition-colors"
          >
            All releases on GitHub
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
