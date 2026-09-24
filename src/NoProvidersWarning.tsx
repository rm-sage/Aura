// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// NoProvidersWarning.tsx ─────────────────────────────────────────────────────
//
// Clickable amber warning shown on Home / Search / the stream list when no
// addon can do the job. Under automatic election that usually means nothing
// INSTALLED can, which Settings cannot fix, so the click goes to the Addons
// page (`aura:open-addons`). Only when a provider override in Settings is the
// cause (emptyElectionCause) does it deep-link to that override's section
// instead (`aura:open-settings`), which reveals the section's advanced rows
// even with "Show advanced settings" off.

import type { AddonEntry } from "./types";
import { emptyElectionCause, type ProviderJob } from "./addonElection";

const COPY: Record<ProviderJob, { section: string; addons: string; override: string }> = {
  home: {
    section: "sec-catalog",
    addons: "None of your installed addons offer catalogs for Home, so it has nothing to show.",
    override: "Your Home Catalog Sources override leaves Home with nothing to show.",
  },
  search: {
    section: "sec-search",
    addons: "None of your installed addons can search, so nothing can be searched.",
    override: "Your Search Providers override leaves out every addon that can search.",
  },
  streams: {
    section: "sec-streams",
    addons: "None of your installed addons provide streams, so no sources can be fetched.",
    override: "Your Stream Providers override leaves out every addon that provides streams.",
  },
};

export default function NoProvidersWarning({
  job,
  addons,
  onNavigate,
}: {
  /** Which election came back empty. */
  job: ProviderJob;
  /** Every installed addon, not the (empty) election: the cause depends on
   *  what the override left out. */
  addons: readonly AddonEntry[];
  /** Runs before the navigation. The detail page passes its close: it is a
   *  full-window overlay, so the page behind it would change unseen. */
  onNavigate?: () => void;
}) {
  const cause = emptyElectionCause(addons, job);
  const copy = COPY[job];
  return (
    <button
      type="button"
      onClick={() => {
        onNavigate?.();
        window.dispatchEvent(
          cause === "override"
            ? new CustomEvent("aura:open-settings", { detail: { section: copy.section } })
            : new CustomEvent("aura:open-addons"),
        );
      }}
      className="group w-full max-w-[36rem] mx-auto flex items-center gap-3 px-4 py-3 rounded-xl text-left
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
        <span className="block text-amber-100/90 text-[13px] font-medium leading-snug">
          {cause === "override" ? copy.override : copy.addons}
        </span>
        <span className="block text-amber-200/60 text-[11px] mt-0.5">
          {cause === "override"
            ? "Click to review it in Settings."
            : "Click to add one on the Addons page."}
        </span>
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
