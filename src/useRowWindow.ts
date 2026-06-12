// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// useRowWindow — responsive grid row-virtualization, generalized from
// LibraryView's proven `useLibraryRowWindow`. Mounts only the rows in (or near)
// the viewport so 100-item catalog grids don't keep every poster + its
// observers/subscriptions decoded and composited.
//
//   • COLUMNS — auto-fill count from the wrapper's measured width
//     (floor((W + gap) / (minCardW + gap))), OR a caller-supplied `resolveCols`
//     for CSS-var-driven fixed-column grids.
//   • ROW STRIDE — MEASURED from a real card's offsetHeight + gap (cards MUST
//     be uniform height — give every card a fixed-height title block). Estimate
//     until first paint; re-measured on resize.
//   • RANGE — scrollTop (offset by the grid's position within the scroll
//     content) ± a row buffer to avoid blank flashes on fast scroll.
//
// Consumer renders a relative spacer of `totalHeight` with the grid absolutely
// positioned at `offsetY`, rendering items.slice(start, end). The scrollbar
// then reflects the whole list while only ~viewport rows mount.
//
// NOTE: this is a deliberate copy of LibraryView's private hook (not an
// extraction) so the proven Library path is never at risk from a shared edit.
// ---------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface RowWindow {
  start: number;
  end: number;
  totalHeight: number;
  offsetY: number;
  cols: number;
}

export interface RowWindowOptions {
  /** Grid gap in px (must match the CSS gap). */
  gap: number;
  /** Auto-fill minmax min card width (px). Ignored when `resolveCols` is set. */
  minCardW?: number;
  /** Overscan rows above + below the viewport. */
  bufferRows?: number;
  /** Pre-measure row-stride fallback (poster + title + gap). */
  estRowStride?: number;
  /** Override the column count (e.g. a `repeat(var(--cols), …)` grid). Receives
   *  the wrapper width + the grid element so it can read a CSS var. */
  resolveCols?: (width: number, grid: HTMLElement | null) => number;
}

export function useRowWindow(
  scrollRef: React.RefObject<HTMLDivElement | null>,
  wrapperRef: React.RefObject<HTMLDivElement | null>,
  gridRef: React.RefObject<HTMLDivElement | null>,
  itemCount: number,
  opts: RowWindowOptions,
): RowWindow {
  const { gap, minCardW = 180, bufferRows = 2, estRowStride = 360, resolveCols } = opts;
  const [cols, setCols] = useState(1);
  const [rowStride, setRowStride] = useState(estRowStride);
  const [range, setRange] = useState({ start: 0, end: 40 });
  const gridTopRef = useRef(0);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const wrapper = wrapperRef.current;
    if (!scroll || !wrapper) return;
    const measure = () => {
      const w = wrapper.clientWidth;
      if (w > 0) {
        const c = resolveCols
          ? Math.max(1, resolveCols(w, gridRef.current))
          : Math.max(1, Math.floor((w + gap) / (minCardW + gap)));
        setCols((prev) => (prev === c ? prev : c));
      }
      const card = gridRef.current?.firstElementChild as HTMLElement | null;
      const h = card?.offsetHeight ?? 0;
      if (h > 0) {
        const s = h + gap;
        setRowStride((prev) => (Math.abs(prev - s) < 0.5 ? prev : s));
      }
      const wrapRect = wrapper.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      gridTopRef.current = wrapRect.top - scrollRect.top + scroll.scrollTop;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrapper);
    ro.observe(scroll);
    return () => ro.disconnect();
  }, [scrollRef, wrapperRef, gridRef, itemCount, gap, minCardW, resolveCols]);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const compute = () => {
      if (rowStride <= 0) return;
      const within = scroll.scrollTop - gridTopRef.current;
      const viewportH = scroll.clientHeight;
      const totalRows = Math.ceil(itemCount / cols);
      // Clamp to the last row so a list that SHRANK under a deep scroll (e.g. a
      // same-catalog refetch returning fewer items) can't leave firstRow past
      // the end → an empty slice → a blank grid for a frame.
      const maxFirstRow = Math.max(0, totalRows - 1);
      const firstRow = Math.max(0, Math.min(Math.floor(within / rowStride) - bufferRows, maxFirstRow));
      const rowsInView = Math.ceil(viewportH / rowStride) + bufferRows * 2;
      const lastRow = Math.min(totalRows, firstRow + rowsInView);
      const nextStart = firstRow * cols;
      const nextEnd = Math.min(itemCount, lastRow * cols);
      setRange((prev) =>
        prev.start === nextStart && prev.end === nextEnd ? prev : { start: nextStart, end: nextEnd },
      );
    };
    compute();
    scroll.addEventListener("scroll", compute, { passive: true });
    return () => scroll.removeEventListener("scroll", compute);
  }, [scrollRef, cols, rowStride, itemCount, bufferRows]);

  const totalRows = Math.ceil(itemCount / cols);
  const totalHeight = totalRows > 0 ? totalRows * rowStride - gap : 0;
  const offsetY = Math.floor(range.start / cols) * rowStride;
  return { start: range.start, end: range.end, totalHeight, offsetY, cols };
}
