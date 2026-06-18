// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// NoProvidersWarning.tsx ─────────────────────────────────────────────────────
//
// Clickable amber warning shown on Home / Search / the stream list when the
// matching provider list has no active addons. Clicking it routes to the
// relevant Settings section via the shared `aura:open-settings` event.

export default function NoProvidersWarning({
  section,
  message,
}: {
  /** Settings section id to jump to, e.g. "sec-catalog" / "sec-streams" / "sec-search". */
  section: string;
  message: string;
}) {
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(new CustomEvent("aura:open-settings", { detail: { section } }))
      }
      className="group w-full max-w-xl mx-auto flex items-center gap-3 px-4 py-3 rounded-xl text-left
                 border border-amber-400/30 bg-amber-500/[0.08] hover:bg-amber-500/[0.14]
                 transition-colors"
    >
      <span className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center
                       bg-amber-400/15 text-amber-300 border border-amber-300/30">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M12 2 1 21h22L12 2zm0 4.5L19.5 19h-15L12 6.5zM11 10v5h2v-5h-2zm0 6v2h2v-2h-2z" />
        </svg>
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-amber-100/90 text-[13px] font-medium leading-snug">{message}</span>
        <span className="block text-amber-200/60 text-[11px] mt-0.5">Click to choose providers in Settings.</span>
      </span>
      <svg
        width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden
        className="flex-shrink-0 text-amber-300/60 group-hover:text-amber-300/90 transition-colors"
      >
        <path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z" />
      </svg>
    </button>
  );
}
