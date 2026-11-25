// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EpisodeGrouping } from "./storyArcs";
import { SegmentedControl } from "./settingsControls";

// ---------------------------------------------------------------------------
// GroupingToggle — the Seasons | Arcs segmented control.
//
// Shared by the Detail page episode list AND the in-player episode panel so the
// two read as the same control (and cannot drift).
// ---------------------------------------------------------------------------

export default function GroupingToggle({
  mode,
  onChange,
  loading = false,
}: {
  mode: EpisodeGrouping;
  onChange: (m: EpisodeGrouping) => void;
  /** Arcs are still resolving: the Arcs button shows a spinner and is inert
   *  (there is nothing to switch to yet), but the control is present so it does
   *  not pop into the header a moment later. */
  loading?: boolean;
}) {
  const spinner = (
    <svg width="9" height="9" viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor"
              strokeWidth="3" strokeLinecap="round" strokeDasharray="42 14" opacity="0.9" />
    </svg>
  );
  // The shared glass segmented control (settingsControls.tsx): one sliding
  // indicator, the same selection look as every other segmented control.
  return (
    <SegmentedControl<EpisodeGrouping>
      value={mode}
      onChange={onChange}
      ariaLabel="Episode grouping"
      size="sm"
      options={[
        { value: "seasons", label: "Seasons" },
        {
          value: "arcs",
          label: "Arcs",
          disabled: loading,
          busy: loading,
          adornment: loading ? spinner : undefined,
        },
      ]}
    />
  );
}
