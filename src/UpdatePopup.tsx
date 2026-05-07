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

import { useEffect } from "react";
import type { ReleaseInfo } from "./updater";

interface Props {
  release:        ReleaseInfo;
  currentVersion: string;
  onUpdate:       () => void;
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
  // Esc handler — mounted only while this popup is up, so we don't have
  // to coordinate with the global keybinding system in useKeybindings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDismiss]);

  const notes = truncateNotes(release.body);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aura-update-title"
      // Backdrop layer — fixed full-viewport, dims everything behind, click
      // to dismiss. z-[60] sits above the standard UI but BELOW the player
      // overlay (z-[9999]) so a popup that fires while a stream loads
      // never paints over MPV.
      className="aura-update-backdrop fixed inset-0 z-[60] flex items-center
                 justify-center bg-black/60 backdrop-blur-md"
      onClick={(e) => {
        // Only treat clicks that originated on the backdrop itself as a
        // dismiss — clicks that bubble up from the card shouldn't close.
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
            <span className="text-white/85 font-medium">{release.tagName}</span>
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

        {/* Actions — Dismiss on the left (subtle), Update on the right
            (primary accent). Order intentional: primary action sits where
            users expect it on Windows (right edge of the dialog). */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onDismiss}
            className="px-4 py-2 rounded-xl text-sm text-white/60
                       hover:text-white/90 hover:bg-white/[0.05]
                       transition-colors"
          >
            Dismiss
          </button>
          <button
            type="button"
            onClick={onUpdate}
            className="px-4 py-2 rounded-xl text-sm font-medium text-white
                       bg-ln-accent/80 hover:bg-ln-accent active:scale-95
                       transition-all shadow-accent-glow"
          >
            Update
          </button>
        </div>
      </div>
    </div>
  );
}
