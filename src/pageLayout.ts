// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// pageLayout — shared content-width cap for the main scrollable pages
// (Library, Queue, Discover, ...).
//
// Tailwind's maxWidth scale is stripped in tailwind.config.ts (the app targets
// fluid ultrawide layouts), so `max-w-6xl` and friends emit NO CSS and the cap
// must be applied as an INLINE style. Arbitrary values like `max-w-[1800px]`
// DO emit, but they drift from each other. Keeping the single source of truth
// here means every page's centered column is exactly the same width and they
// can never diverge again. Library's row-windowing column math also reads this
// (as LIB_MAX_GRID_W), so CSS and JS stay in lockstep.
//
// Usage: <div className="mx-auto px-6 py-6 space-y-5" style={{ maxWidth: PAGE_CONTENT_MAX_W }}>
// ---------------------------------------------------------------------------

/** px width cap for the centered content column on the main pages (~8 poster cols). */
export const PAGE_CONTENT_MAX_W = 2000;
