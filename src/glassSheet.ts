// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// The in-page glass SHEET (round 11, styles/glass-pages.css): an in-page
// section or card that sits ON a page (Settings sections, empty and error
// states, Calendar cells, the Live TV group rail). The A control face with
// NO backdrop pass (behind a page there is only Mica or the soft ambient
// sweep, so a blur adds almost nothing there, while a backdrop-filter over the
// animated sweep re-filters every frame and every scroll frame). It keeps the
// idle rim and the cursor light (as a panel), never refracts (data-liquid
// "off": liquidGlass skips it) and never lifts on hover.
//
// Spread the result on the element: `<div {...sheet("px-6 py-10")}>`.

export interface SheetProps {
  className: string;
  "data-liquid": "off";
  "data-glass-light": "panel";
}

/** Props for an in-page glass sheet. `tone: "danger"` adds a faint red
 *  hairline (error states). Radius comes from the caller's classes. */
export function sheet(className = "", opts?: { tone?: "danger" }): SheetProps {
  const tone = opts?.tone === "danger" ? " is-danger" : "";
  return {
    className: `aura-float-glass aura-glass-control aura-glass-sheet${tone} ${className}`.trim(),
    "data-liquid": "off",
    "data-glass-light": "panel",
  };
}
