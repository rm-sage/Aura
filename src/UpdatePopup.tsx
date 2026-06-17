// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// UpdatePopup.tsx ───────────────────────────────────────────────────────────
//
// Centered, screen-dimming "Update Available" modal. Surfaced from App.tsx
// whenever checkForUpdate() returns a tag newer than the running app version
// AND that tag has not already been dismissed to the notifications bell.
//
// The new version's notes render at top via the shared ReleaseNotesBody; a
// "View earlier versions" control lazily loads prior releases from GitHub
// (RELEASES_PAGE_SIZE at a time) so the popup doubles as a quick changelog.
//
// Two ways to dismiss: backdrop click and Esc (suppressed while installing).
// We do NOT close on the "Install" button — the parent handles that after the
// plugin relaunches.

import { useCallback, useEffect, useState } from "react";
import type { UpdateInfo } from "./updaterPlugin";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ReleaseNotesBody } from "./releaseNotesRender";
import { fetchReleasePage, formatReleaseDate, RELEASES_PAGE_SIZE, type ReleaseNote } from "./changelogApi";

interface Props {
  release:        UpdateInfo;
  currentVersion: string;
  /** Primary action — kicks off the in-app signed download + install via
   *  tauri-plugin-updater. Returns true on success (the app relaunches, so
   *  the success branch typically never paints) and false on any failure. */
  onUpdate:       () => Promise<boolean>;
  onDismiss:      () => void;
}

/** Cap the new-version note body so a runaway tag can't scroll forever. */
const NOTES_MAX = 2200;

export default function UpdatePopup({
  release,
  currentVersion,
  onUpdate,
  onDismiss,
}: Props) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  // Prior versions, lazily loaded from the GitHub releases API on demand.
  const [prior, setPrior] = useState<ReleaseNote[]>([]);
  const [priorPage, setPriorPage] = useState(0);
  const [priorLoading, setPriorLoading] = useState(false);
  const [priorError, setPriorError] = useState<string | null>(null);
  const [priorDone, setPriorDone] = useState(false);
  const [showPrior, setShowPrior] = useState(false);

  const loadMorePrior = useCallback(async () => {
    if (priorLoading || priorDone) return;
    setPriorLoading(true);
    setPriorError(null);
    const next = priorPage + 1;
    try {
      const batch = await fetchReleasePage(next);
      // The target version's notes already show at top — drop it from the list.
      setPrior((p) => [...p, ...batch.filter((r) => r.version !== release.version)]);
      setPriorPage(next);
      if (batch.length < RELEASES_PAGE_SIZE) setPriorDone(true);
      setShowPrior(true);
    } catch (e) {
      setPriorError(e instanceof Error ? e.message : String(e));
    } finally {
      setPriorLoading(false);
    }
  }, [priorLoading, priorDone, priorPage, release.version]);

  // Esc dismiss — suppressed while installing (the plugin holds file handles).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (installing) return;
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDismiss, installing]);

  const targetTag = `v${release.version}`;
  const releasePageUrl = `https://github.com/rm-sage/Aura/releases/tag/${targetTag}`;
  const hasNotes = (release.body ?? "").trim().length > 0;

  const handleInstall = async () => {
    if (installing) return;
    setInstallError(null);
    setInstalling(true);
    try {
      const ok = await onUpdate();
      if (!ok) {
        setInstallError("Install failed — the signed download or signature check didn't succeed. Use \"View on GitHub\" to download the installer manually.");
      }
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aura-update-title"
      className="aura-update-backdrop fixed inset-0 z-[60] flex items-center
                 justify-center bg-black/60 backdrop-blur-md"
      onClick={(e) => {
        if (installing) return;
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="aura-update-card glass-panel-elevated rounded-2xl
                   px-8 py-7 w-full max-w-[680px] mx-4 shadow-glass-edge
                   flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-col gap-1">
          <h2
            id="aura-update-title"
            className="text-[var(--text-primary)] text-xl font-medium
                       tracking-wide flex items-center gap-2"
          >
            <span className="text-[color:rgb(91,164,255)]">Update Available</span>
          </h2>
          <p className="text-white/55 text-xs tracking-wide">
            Aura {currentVersion}
            <span className="px-1.5 text-white/35">→</span>
            <span className="text-white/85 font-medium">{targetTag}</span>
          </p>
        </div>

        {/* Notes — the new version at top, then lazily-loaded prior versions. */}
        <div
          className="bg-white/[0.03] border border-white/[0.08] rounded-xl
                     px-5 py-4 max-h-[50vh] overflow-y-auto space-y-5"
        >
          {hasNotes ? (
            <ReleaseNotesBody notes={release.body ?? ""} max={NOTES_MAX} />
          ) : (
            <p className="text-white/45 text-[13px] italic">No notes for this release.</p>
          )}

          {showPrior && prior.map((r) => (
            <section key={r.tag} className="space-y-2 pt-4 border-t border-white/8">
              <div className="flex items-baseline gap-2.5">
                <h3 className="text-white text-[14px] font-semibold tracking-tight">Aura {r.version}</h3>
                {formatReleaseDate(r.date) && (
                  <span className="text-white/35 text-[10.5px] font-mono ml-auto">{formatReleaseDate(r.date)}</span>
                )}
              </div>
              {r.notes.trim()
                ? <ReleaseNotesBody notes={r.notes} max={Infinity} />
                : <p className="text-white/40 text-[12px] italic">No notes for this release.</p>}
            </section>
          ))}

          {/* Pager — reveals the changelog of earlier versions inline. */}
          <div className="flex flex-col items-center gap-1.5 pt-1">
            {priorLoading ? (
              <span className="text-white/40 text-[11px]">Loading…</span>
            ) : priorDone ? (
              prior.length > 0 && <span className="text-white/30 text-[10.5px]">Showing all earlier versions.</span>
            ) : (
              <button
                type="button"
                onClick={() => void loadMorePrior()}
                className="px-3 py-1.5 rounded-lg text-[11.5px] font-medium text-white/75
                           bg-white/[0.05] border border-white/10 hover:bg-white/10 transition-colors"
              >
                {priorError ? "Retry" : showPrior ? `View ${RELEASES_PAGE_SIZE} more` : "View earlier versions"}
              </button>
            )}
            {priorError && <span className="text-red-200/80 text-[10.5px]">{priorError}</span>}
          </div>
        </div>

        {/* Inline install error. */}
        {installError && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/8 px-3 py-2">
            <p className="text-red-200/90 text-[11px] leading-snug">{installError}</p>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={() => openUrl(releasePageUrl).catch(() => {})}
            disabled={installing}
            className="px-3 py-2 rounded-xl text-[11px] text-white/45
                       hover:text-white/75 hover:bg-white/[0.04]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
          >
            View on GitHub
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDismiss}
              disabled={installing}
              className="px-4 py-2 rounded-xl text-sm text-white/60
                         hover:text-white/90 hover:bg-white/[0.05]
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={handleInstall}
              disabled={installing}
              className="px-4 py-2 rounded-xl text-sm font-medium text-white
                         bg-ln-accent/80 hover:bg-ln-accent active:scale-95
                         disabled:opacity-60 disabled:cursor-progress
                         transition-all shadow-accent-glow"
            >
              {installing ? "Installing…" : "Install"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
