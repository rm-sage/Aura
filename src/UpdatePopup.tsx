// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// UpdatePopup.tsx ───────────────────────────────────────────────────────────
//
// Centered, screen-dimming "Update Available" modal. Surfaced from
// App.tsx whenever `checkForUpdate()` returns a tag newer than the
// running app version AND that tag has not already been dismissed to the
// notifications bell.
//
// The modal is intentionally NOT focus-trapped — Aura's UI is
// tab-light and a strict trap would break the user's mental model of
// "Esc/click-out to dismiss". We do still mount it with role="dialog"
// + aria-modal="true" so screen readers identify it correctly.
//
// Two ways to dismiss: backdrop click and Esc.  Both call onDismiss,
// which in App.tsx writes the tag to localStorage at the
// "aura:update:dismissed-version" key and dispatches a CustomEvent for
// the (separately-implemented) bell to consume. We do NOT close on the
// "Update" button — the parent handles that after openUrl resolves.
//
// Animations live in App.css (.aura-update-backdrop / .aura-update-card)
// rather than inline styles so we share the @layer-components scoping
// and theme cross-fade behaviour with the rest of the app.

import { useEffect, useState } from "react";
import type { UpdateInfo } from "./updaterPlugin";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Props {
  release:        UpdateInfo;
  currentVersion: string;
  /** Primary action — kicks off the in-app signed download + install
   *  via the tauri-plugin-updater. The popup manages its own busy
   *  state during the call. Returns true on success (the app
   *  relaunches automatically, so the success branch typically never
   *  paints) and false on any failure; an error string is rendered
   *  inline when false. */
  onUpdate:       () => Promise<boolean>;
  onDismiss:      () => void;
}

/** Cap the rendered release notes to the first ~300 chars. Long
 *  multi-paragraph release notes from GitHub crash the modal's vertical
 *  rhythm and bury the action buttons; the user can read the full notes
 *  on the release page after clicking Update. */
const NOTES_MAX = 300;
function truncateNotes(body: string): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.length <= NOTES_MAX) return trimmed;
  // Try to break at a paragraph / sentence boundary inside the budget so
  // we don't slice mid-word. Falls back to a hard slice + ellipsis.
  const slice = trimmed.slice(0, NOTES_MAX);
  const lastBreak = Math.max(
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
  );
  const cut = lastBreak > NOTES_MAX * 0.6 ? slice.slice(0, lastBreak + 1) : slice;
  return cut.trimEnd() + "…";
}

export default function UpdatePopup({
  release,
  currentVersion,
  onUpdate,
  onDismiss,
}: Props) {
  /** True while the plugin is downloading + verifying + installing.
   *  Disables the action buttons and swaps the Install label for
   *  "Installing…". Success branch typically never paints because
   *  the plugin relaunches the app on completion. */
  const [installing, setInstalling] = useState(false);
  /** Non-null when the download/install path failed (signature
   *  mismatch, network outage, write permission, etc). Surfaced
   *  inline above the action row so the user has a recovery hint
   *  before falling back to the GitHub release page. */
  const [installError, setInstallError] = useState<string | null>(null);

  // Esc handler — mounted only while this popup is up, so we don't have
  // to coordinate with the global keybinding system in useKeybindings.
  // While installing, Esc is suppressed so the user can't accidentally
  // dismiss mid-download (the plugin holds open file handles that we'd
  // rather see finish).
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

  const notes = truncateNotes(release.body ?? "");
  // Plugin's UpdateInfo carries a bare version like "0.6.9"; surface
  // it with the conventional "v" prefix to match the GitHub release
  // page and the user's mental model of release tags.
  const targetTag = `v${release.version}`;
  const releasePageUrl = `https://github.com/rm-sage/Aura/releases/tag/${targetTag}`;

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
                   px-7 py-6 w-full max-w-[420px] mx-4 shadow-glass-edge
                   flex flex-col gap-4"
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

        {/* Release notes — truncated, scrollable up to a reasonable max. */}
        {notes && (
          <div
            className="bg-white/[0.03] border border-white/[0.08] rounded-xl
                       px-4 py-3 max-h-56 overflow-y-auto"
          >
            <p className="text-white/70 text-xs leading-relaxed whitespace-pre-line">
              {notes}
            </p>
          </div>
        )}

        {/* Inline error — rendered between notes and actions so the
            user sees the failure context before deciding whether to
            retry or fall back to the browser. */}
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
