// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  HEAT_LEVELS, buildCalendarHeat, dayKeyOfDate, formatWatchTime, heatLevel,
  type HeatScale,
} from "./historyIndex";

// ---------------------------------------------------------------------------
// HistoryDateJump - the History page's "jump to a date" calendar, which is
// also a HEAT MAP of watch volume (AniList's profile "Activity History").
//
// A month grid whose days are shaded by how many plays they hold (in the
// page's CURRENT filter, so a shaded day is always one the list can show;
// skip rows are counted apart and never shade, see historyIndex), a
// month / year picker behind the month title shaded the same way per month,
// a full-year strip of tiny squares for the year on screen, and a row of
// quick jumps. Picking any past day scrolls the list to it, or to the nearest
// EARLIER day with plays: the user asked about a point in time, and the
// newest plays at or before it are the answer. The parent resolves that
// (historyIndex `resolveJumpDay`), this panel only reports the date.
//
// The shading levels are relative to the user's own year (historyIndex
// `heatScale`), so a light watcher sees as much variation as a binger.
//
// PORTALLED TO document.body for the same reason as HeroBackdropPicker:
// ContextMenuHost renders its menu INLINE inside .aura-app-shell's stacking
// context, so a panel left in there would paint over a menu raised while it
// is open. Outside-click, Escape, and a wheel anywhere else close it.
// ---------------------------------------------------------------------------

/** Gap kept between the panel and the viewport edge. */
const EDGE = 12;
/** The custom title bar the panel must not cover. */
const TITLE_BAR_H = 36;

const MONTH_TITLE_FMT = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const MONTH_SHORT_FMT = new Intl.DateTimeFormat(undefined, { month: "short" });
const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "narrow" });
const DAY_LABEL_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "long", month: "long", day: "numeric", year: "numeric",
});
const DAY_SHORT_FMT = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const DAY_SHORT_YEAR_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short", month: "short", day: "numeric", year: "numeric",
});
const NUM_FMT = new Intl.NumberFormat();

/** First day of the week for the user's locale, 0 = Sunday. `weekInfo` is
 *  not in every engine (and is a getter in some, a method in others), so it
 *  is probed defensively and falls back to Sunday. */
const WEEK_START: number = (() => {
  try {
    const loc = new Intl.Locale(navigator.language || "en-US") as Intl.Locale & {
      weekInfo?: { firstDay?: number };
      getWeekInfo?: () => { firstDay?: number };
    };
    const info = loc.getWeekInfo?.() ?? loc.weekInfo;
    const fd = info?.firstDay;
    if (typeof fd === "number" && fd >= 1 && fd <= 7) return fd % 7;
  } catch { /* fall through */ }
  return 0;
})();

/** Year * 12 + month: one comparable integer per month. */
const monthIndex = (y: number, m: number) => y * 12 + m;
const monthOfKey = (key: string) => monthIndex(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1);
const dateOfKey = (key: string) =>
  new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));

// ---------------------------------------------------------------------------
// Heat colours. Every level is the theme accent at a rising alpha, written as
// `rgb(var(--ln-accent-rgb) / a)` so it follows the theme exactly like the
// `ln-accent` utilities do. Inline rather than `bg-ln-accent/NN` because the
// level is data, and an interpolated class name is one the JIT never sees.
//
// The TEXT on a shaded day cannot simply stay white: Contrast's accent is a
// near-yellow (#ffe000), and white on its top level measures about 1.8:1.
// So each level's ink is picked once, on open, by whichever of white or a
// near-black has the higher WCAG contrast against the accent blended over the
// panel's own near-black fill. Blue and green accents keep white on the low
// levels and switch only where the fill is genuinely light.
// ---------------------------------------------------------------------------

const HEAT_ALPHA = [0, 0.2, 0.38, 0.6, 0.85] as const;
/** Fill of a past day with no plays: neutral, not accent. Same value in the
 *  grid (`bg-white/6`), the strip and the legend's "less" swatch. */
const EMPTY_FILL = "rgb(255 255 255 / 0.06)";
const FUTURE_FILL = "rgb(255 255 255 / 0.02)";
const heatFill = (level: number) =>
  level <= 0 ? EMPTY_FILL : `rgb(var(--ln-accent-rgb) / ${HEAT_ALPHA[Math.min(level, HEAT_LEVELS)]})`;

/** Approximately what .aura-float-glass resolves to behind the cells. */
const PANEL_RGB: readonly [number, number, number] = [14, 16, 22];
const DARK_INK_RGB: readonly [number, number, number] = [12, 12, 16];
const DARK_INK = "rgb(12 12 16)";

function readAccentRgb(): [number, number, number] {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--ln-accent-rgb");
    const p = raw.trim().split(/[\s,/]+/).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every((v) => Number.isFinite(v))) return [p[0], p[1], p[2]];
  } catch { /* fall through */ }
  return [91, 164, 255];
}

function luminance(rgb: readonly number[]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function inksFor(accent: readonly number[]): string[] {
  const darkL = luminance(DARK_INK_RGB);
  return HEAT_ALPHA.map((a) => {
    const mixed = accent.map((c, i) => c * a + PANEL_RGB[i] * (1 - a));
    const l = luminance(mixed);
    return (l + 0.05) / (darkL + 0.05) > 1.05 / (l + 0.05) ? DARK_INK : "#fff";
  });
}

// Day markers sit OUTSIDE the cell (box-shadow spread, into the 6px grid gap)
// so they read against the panel's dark fill whatever the heat level under
// them; a ring drawn on the fill vanishes on the top level of a light accent.
// The inset dark hairline on "current" separates the white ring from a light
// fill. Keyboard focus is an accent OUTLINE further out, so a focused current
// day shows both.
const MARK_CURRENT = "0 0 0 2px rgb(255 255 255 / 0.92), inset 0 0 0 1px rgb(0 0 0 / 0.45)";
const MARK_TODAY = "0 0 0 1px rgb(255 255 255 / 0.5)";
const FOCUS_CLS = "outline-none focus-visible:outline focus-visible:outline-2 "
  + "focus-visible:outline-offset-2 focus-visible:outline-ln-accent";

/** "7 plays, 2h 41m, 30 skipped". Skips get their own clause rather than
 *  joining the play count: a skipped filler arc is not viewing. */
function playsText(plays: number, secs: number, skips = 0): string {
  const parts: string[] = [];
  if (plays > 0) parts.push(`${NUM_FMT.format(plays)} play${plays === 1 ? "" : "s"}`);
  if (secs > 0) parts.push(formatWatchTime(secs));
  if (skips > 0) parts.push(`${NUM_FMT.format(skips)} skipped`);
  return parts.length > 0 ? parts.join(", ") : "no plays";
}

/** The chord searchHotkey.ts focuses the search box on: keep the two in step.
 *  keyCode as well as key, so a non-Latin layout matches. */
const isSearchChord = (e: React.KeyboardEvent) =>
  e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat
  && (e.key.toLowerCase() === "f" || e.keyCode === 70);

/** A jump closes the panel and moves the list at once, so the second press of
 *  a double-click lands on whatever is now under the pointer: a card's scrobble
 *  pill (a real push), its checkbox, its "every play" button. Window capture
 *  stops it before React sees it, for every control at once. Added during the
 *  first click's dispatch, past window capture, so that click never reaches it.
 *  No time check: detail > 1 already means the OS counted a double-click, while
 *  a slow render could outlast a clock. A keyboard press (detail 0) and a new
 *  click elsewhere (detail 1) pass and spend the shot. The timer only tidies
 *  up: Windows' longest double-click setting is 900 ms. */
function swallowDoubleClickTail() {
  const swallow = (e: MouseEvent) => {
    window.removeEventListener("click", swallow, true);
    if (e.detail > 1) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
  window.addEventListener("click", swallow, true);
  window.setTimeout(() => window.removeEventListener("click", swallow, true), 1000);
}

interface Props {
  anchor: HTMLElement;
  /** Plays per day (YYYY-MM-DD) in the page's current filter, skips
   *  excluded. Days with none are absent. */
  dayCounts: Map<string, number>;
  /** Skip rows per day, same filter. Reported, never shaded. */
  daySkips: Map<string, number>;
  /** Seconds watched per day, same filter. Days with none are absent. */
  daySecs: Map<string, number>;
  /** Oldest day with plays, for the lower navigation bound. */
  oldestKey: string | null;
  /** The day at the top of the list right now: the month the panel opens on. */
  currentKey: string | null;
  /** A picked date (YYYY-MM-DD). The parent lands on it or the nearest
   *  earlier day with plays. */
  onJump: (dayKey: string) => void;
  onClose: () => void;
}

export default function HistoryDateJump({
  anchor, dayCounts, daySecs, daySkips, oldestKey, currentKey, onJump, onClose,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const today = useMemo(() => new Date(), []);
  const todayKey = dayKeyOfDate(today);
  const thisYear = today.getFullYear();
  const maxMonth = monthIndex(thisYear, today.getMonth());
  // A history can hold nothing older than this month, so stepping further
  // back would only show empty months.
  const minMonth = Math.min(maxMonth, oldestKey ? monthOfKey(oldestKey) : maxMonth);

  const [month, setMonth] = useState(() =>
    Math.max(minMonth, Math.min(maxMonth, currentKey ? monthOfKey(currentKey) : maxMonth)),
  );
  const [mode, setMode] = useState<"days" | "months">("days");
  const year = Math.floor(month / 12);
  const monthInYear = month % 12;

  // What the readout line under the strip describes: a hovered or focused
  // day ("YYYY-MM-DD") or month ("m:<index>"), else the year on screen.
  const [hover, setHover] = useState<string | null>(null);

  // Month and year totals plus the per-year scales, from the per-day maps
  // buildLayout already summed: O(days with plays), once per open or filter.
  const heat = useMemo(
    () => buildCalendarHeat(dayCounts, daySecs, daySkips),
    [dayCounts, daySecs, daySkips],
  );
  const dayScale = heat.dayScale.get(year) ?? FALLBACK_SCALE;
  const monthScale = heat.monthScale.get(year) ?? FALLBACK_SCALE;
  // Read once: the theme does not change under an open popover.
  const inks = useMemo(() => inksFor(readAccentRgb()), []);

  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // Under the anchor, right edges aligned, pulled back inside the viewport.
  // Measured before paint so it never flashes at an unclamped spot.
  useLayoutEffect(() => {
    const place = () => {
      const el = panelRef.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const left = Math.max(EDGE, Math.min(a.right - r.width, vw - r.width - EDGE));
      let top = a.bottom + 6;
      if (top + r.height > vh - EDGE) top = Math.max(TITLE_BAR_H + 8, a.top - r.height - 6);
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  const focusBestDay = () => {
    const grid = gridRef.current;
    const target = grid?.querySelector<HTMLButtonElement>("[data-current='true']")
      ?? grid?.querySelector<HTMLButtonElement>("[data-has='true']")
      ?? grid?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    target?.focus({ preventScroll: true });
  };

  // Focus the first useful day on open; on close, hand focus back to the
  // anchor when it was in here, instead of leaving it on a removed node.
  useLayoutEffect(() => {
    focusBestDay();
    const panel = panelRef.current;
    return () => {
      const active = document.activeElement as HTMLElement | null;
      if (!panel || !active || !panel.contains(active)) return;
      if (anchor.isConnected) anchor.focus({ preventScroll: true });
      else active.blur();
    };
    // Mount-only: paging months must not yank focus back to the grid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Picking a month unmounts the focused month button with its grid. The day
  // grid exists only after that commit, so the pick asks for focus through a
  // ref, and paging never does.
  const focusDayAfterPick = useRef(false);
  // The day grid replaces the month grid in the same slot, so the second press
  // of a double-click on a month would land on a day and jump the list.
  const monthPickedAt = useRef(0);
  useLayoutEffect(() => {
    if (mode !== "days" || !focusDayAfterPick.current) return;
    focusDayAfterPick.current = false;
    focusBestDay();
  }, [mode]);

  useEffect(() => {
    const inside = (t: EventTarget | null) =>
      t instanceof Node && (!!panelRef.current?.contains(t) || anchor.contains(t));
    // The Performance Monitor floats over the app, it is not part of the page.
    const onMonitor = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest("[data-perf-monitor]");
    const onMouseDown = (e: MouseEvent) => {
      if (inside(e.target) || onMonitor(e.target)) return;
      if (e.target instanceof Element && e.target.closest("[data-aura-context-menu]")) return;
      onClose();
    };
    // Scrolling the list means the user has moved on; the panel would also
    // be left pointing at a button that scrolled away.
    const onWheel = (e: WheelEvent) => {
      if (!inside(e.target) && !onMonitor(e.target)) onClose();
    };
    // Capture phase, and stopped there, so App's window-level Escape handling
    // never sees the key that only meant "close this panel".
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("wheel", onWheel, { capture: true });
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onClose]);

  // The visible month as cells: leading blanks to the locale's week start,
  // then one cell per day.
  const cells = useMemo(() => {
    const first = new Date(year, monthInYear, 1);
    const lead = (first.getDay() - WEEK_START + 7) % 7;
    const days = new Date(year, monthInYear + 1, 0).getDate();
    const out: Array<{ key: string; day: number } | null> = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= days; d++) {
      out.push({ key: dayKeyOfDate(new Date(year, monthInYear, d)), day: d });
    }
    return out;
  }, [year, monthInYear]);

  const weekdays = useMemo(() => {
    // 2023-01-01 was a Sunday; step from it to name each column.
    const out: string[] = [];
    for (let i = 0; i < 7; i++) out.push(WEEKDAY_FMT.format(new Date(2023, 0, 1 + ((WEEK_START + i) % 7))));
    return out;
  }, []);

  const jump = (key: string) => { swallowDoubleClickTail(); onJump(key); onClose(); };

  /** A quick jump: `n` units back from today. A month or year back keeps
   *  the day of the month, clamped to the target month's length: a bare
   *  setMonth on March 31 asks for February 31, which Date rolls over to
   *  March 3 (28 days back), and Feb 29 a year back became March 1. */
  const quick = (unit: "week" | "month" | "year", n = 1) => {
    const d = new Date(today);
    if (unit === "week") d.setDate(d.getDate() - 7 * n);
    else {
      const day = d.getDate();
      d.setDate(1);
      if (unit === "month") d.setMonth(d.getMonth() - n);
      else d.setFullYear(d.getFullYear() - n);
      const daysInTarget = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      d.setDate(Math.min(day, daysInTarget));
    }
    jump(dayKeyOfDate(d));
  };

  // Arrow keys walk the day grid (a week per row), Home / End go to the
  // month's ends. Stays inside the month on purpose: the header buttons page.
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    const btns = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-day]") ?? []);
    const i = btns.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    let next = i;
    if (e.key === "ArrowRight") next = i + 1;
    else if (e.key === "ArrowLeft") next = i - 1;
    else if (e.key === "ArrowDown") next = i + 7;
    else if (e.key === "ArrowUp") next = i - 7;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = btns.length - 1;
    else return;
    e.preventDefault();
    next = Math.max(0, Math.min(btns.length - 1, next));
    // Future days are disabled and cannot take focus, so a step into them
    // settles on the last day that can.
    while (next > 0 && btns[next].disabled) next--;
    btns[next]?.focus({ preventScroll: true });
  };

  const navBtn = "w-9 h-9 rounded-lg grid place-items-center text-white/60 hover:text-white "
    + "hover:bg-white/10 transition-colors disabled:opacity-25 disabled:pointer-events-none";

  const titleRef = useRef<HTMLButtonElement>(null);
  const step = (delta: number) => {
    const next = Math.max(minMonth, Math.min(maxMonth, month + delta));
    setMonth(next);
    // The pressed chevron is about to disable, which would drop focus out of
    // the panel and hand the arrow keys to App's global bindings.
    const nextYear = Math.floor(next / 12) * 12;
    const atBound = delta < 0
      ? (mode === "days" ? next : nextYear) <= minMonth
      : (mode === "days" ? next : nextYear + 11) >= maxMonth;
    if (atBound) titleRef.current?.focus({ preventScroll: true });
  };

  const dayShort = (key: string) =>
    (Number(key.slice(0, 4)) === thisYear ? DAY_SHORT_FMT : DAY_SHORT_YEAR_FMT).format(dateOfKey(key));

  const yearStat = heat.years.get(year);
  const yearText = playsText(yearStat?.plays ?? 0, yearStat?.secs ?? 0, yearStat?.skips ?? 0);
  // The stat block under the strip: the hovered or focused day or month, else
  // the year's total. Parts rather than one sentence, so each number can carry
  // its own weight and colour.
  let readout: ReadoutStat = {
    label: `${year} total`,
    plays: yearStat?.plays ?? 0,
    secs: yearStat?.secs ?? 0,
    skips: yearStat?.skips ?? 0,
  };
  if (hover?.startsWith("m:")) {
    const mi = Number(hover.slice(2));
    const st = heat.months.get(mi);
    readout = {
      label: MONTH_TITLE_FMT.format(new Date(Math.floor(mi / 12), mi % 12, 1)),
      plays: st?.plays ?? 0,
      secs: st?.secs ?? 0,
      skips: st?.skips ?? 0,
    };
  } else if (hover) {
    readout = {
      label: dayShort(hover),
      plays: dayCounts.get(hover) ?? 0,
      secs: daySecs.get(hover) ?? 0,
      skips: daySkips.get(hover) ?? 0,
    };
  }

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Jump to date"
      className="aura-float-glass fixed z-[10045] w-[440px] max-w-[calc(100vw-24px)]
                 max-h-[calc(100vh-56px)] overflow-y-auto rounded-2xl p-4 select-none"
      style={{
        left: pos?.left ?? -9999,
        top: pos?.top ?? -9999,
        animation: "fade-in 140ms ease-out",
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(255,255,255,0.08) transparent",
      }}
      // Keys pressed in here stop here: App's window-level bindings do not
      // check defaultPrevented, and the arrows walking the grid must not also
      // drive them. Function keys still pass (F12 opens the DevConsole), and so
      // does Ctrl+F, closing the panel so it is not left open over the search.
      onKeyDown={(e) => {
        if (isSearchChord(e)) { onClose(); return; }
        if (!/^F\d{1,2}$/.test(e.key)) e.stopPropagation();
      }}
    >
      <div className="flex items-center gap-1 mb-3">
        <button
          type="button"
          aria-label={mode === "days" ? "Previous month" : "Previous year"}
          disabled={mode === "days" ? month <= minMonth : year * 12 <= minMonth}
          onClick={() => step(mode === "days" ? -1 : -12)}
          className={navBtn}
        >
          <Chevron dir="left" />
        </button>
        <button
          ref={titleRef}
          type="button"
          onClick={() => setMode((m) => (m === "days" ? "months" : "days"))}
          aria-label={mode === "days" ? "Pick a month" : "Back to days"}
          className="flex-1 h-9 rounded-lg text-[16px] font-semibold text-white/90
                     hover:bg-white/8 transition-colors"
        >
          {mode === "days" ? MONTH_TITLE_FMT.format(new Date(year, monthInYear, 1)) : year}
        </button>
        <button
          type="button"
          aria-label={mode === "days" ? "Next month" : "Next year"}
          disabled={mode === "days" ? month >= maxMonth : year * 12 + 11 >= maxMonth}
          onClick={() => step(mode === "days" ? 1 : 12)}
          className={navBtn}
        >
          <Chevron dir="right" />
        </button>
      </div>

      {/* Always as tall as a 6-row month (weekday row + 6 x 40 + 5 x 6): the
          panel is placed once, from the height it has on open, and moving it
          while paging would slide the chevrons out from under the cursor. */}
      <div className="min-h-[294px]">
      {mode === "days" ? (
        <>
          <div className="grid grid-cols-7 gap-1.5 mb-1.5" aria-hidden>
            {weekdays.map((w, i) => (
              <span key={i} className="text-center text-[12px] font-mono uppercase text-white/45">{w}</span>
            ))}
          </div>
          <div
            ref={gridRef}
            role="group"
            aria-label="Days"
            className="grid grid-cols-7 gap-1.5"
            onKeyDown={onGridKeyDown}
            onMouseLeave={() => setHover(null)}
          >
            {cells.map((c, i) => {
              if (!c) return <span key={`b${i}`} aria-hidden />;
              const n = dayCounts.get(c.key) ?? 0;
              const secs = daySecs.get(c.key) ?? 0;
              const skips = daySkips.get(c.key) ?? 0;
              // A skip-only day has no heat but IS a day in the list, so a
              // pick lands on it, not on an earlier one.
              const has = n > 0 || skips > 0;
              const future = c.key > todayKey;
              const isToday = c.key === todayKey;
              const isCurrent = c.key === currentKey;
              const level = heatLevel(n, dayScale);
              const label = `${DAY_LABEL_FMT.format(new Date(year, monthInYear, c.day))}: ${
                has ? playsText(n, secs, skips) : "no plays, goes to the closest earlier day"
              }`;
              return (
                <button
                  key={c.key}
                  type="button"
                  data-day
                  data-has={has ? "true" : undefined}
                  data-current={isCurrent ? "true" : undefined}
                  aria-current={isToday ? "date" : undefined}
                  disabled={future}
                  title={`${dayShort(c.key)}: ${playsText(n, secs, skips)}`}
                  aria-label={label}
                  onClick={(e) => {
                    // detail 0 is the keyboard: Enter on a month, then on its day.
                    if (e.detail > 0 && performance.now() - monthPickedAt.current < 450) return;
                    jump(c.key);
                  }}
                  onMouseEnter={() => setHover(c.key)}
                  onFocus={() => setHover(c.key)}
                  onBlur={() => setHover(null)}
                  className={`h-10 rounded-lg text-[15px] tabular-nums transition ${FOCUS_CLS}
                              disabled:opacity-20 disabled:cursor-default
                              ${future ? "" : level > 0
                                ? "font-semibold hover:brightness-125"
                                : "bg-white/6 text-white/40 hover:bg-white/12 hover:text-white/75"}`}
                  style={{
                    background: !future && level > 0 ? heatFill(level) : undefined,
                    color: !future && level > 0 ? inks[level] : undefined,
                    boxShadow: isCurrent ? MARK_CURRENT : isToday ? MARK_TODAY : undefined,
                  }}
                >
                  {c.day}
                </button>
              );
            })}
          </div>
        </>
      ) : (
        <div className="grid grid-cols-3 gap-2" onMouseLeave={() => setHover(null)}>
          {Array.from({ length: 12 }, (_, m) => {
            const mi = year * 12 + m;
            const st = heat.months.get(mi);
            const n = st?.plays ?? 0;
            const out = mi > maxMonth || mi < minMonth;
            const level = out ? 0 : heatLevel(n, monthScale);
            const label = `${MONTH_TITLE_FMT.format(new Date(year, m, 1))}: ${
              playsText(n, st?.secs ?? 0, st?.skips ?? 0)}`;
            return (
              <button
                key={m}
                type="button"
                disabled={out}
                title={label}
                aria-label={label}
                onClick={() => {
                  focusDayAfterPick.current = true;
                  monthPickedAt.current = performance.now();
                  setMonth(mi);
                  setMode("days");
                }}
                onMouseEnter={() => setHover(`m:${mi}`)}
                onFocus={() => setHover(`m:${mi}`)}
                onBlur={() => setHover(null)}
                className={`h-[60px] rounded-lg flex flex-col items-center justify-center gap-0.5
                            transition ${FOCUS_CLS} disabled:opacity-20 disabled:cursor-default
                            ${level > 0
                              ? "hover:brightness-125"
                              : `text-white/45 ${out ? "" : "bg-white/6 hover:bg-white/12"}`}`}
                style={{
                  background: level > 0 ? heatFill(level) : undefined,
                  color: level > 0 ? inks[level] : undefined,
                  boxShadow: mi === month ? MARK_CURRENT : undefined,
                }}
              >
                <span className="text-[15px] font-medium">{MONTH_SHORT_FMT.format(new Date(year, m, 1))}</span>
                <span className="text-[12px] font-mono tabular-nums opacity-80">
                  {n > 0 ? NUM_FMT.format(n) : "-"}
                </span>
              </button>
            );
          })}
        </div>
      )}
      </div>

      <div className="mt-4 pt-3 border-t border-white/10">
        <YearStrip
          year={year}
          visibleMonth={mode === "days" ? monthInYear : -1}
          dayCounts={dayCounts}
          scale={dayScale}
          todayKey={todayKey}
          currentKey={currentKey}
          hoverKey={hover && !hover.startsWith("m:") ? hover : null}
          summary={`Plays per day in ${year}: ${yearText}`}
          onHover={setHover}
          onPick={jump}
        />
        {/* Screen readers get all of this from each day's own aria-label. */}
        <div className="mt-3" aria-hidden>
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] font-semibold text-white/90">{readout.label}</span>
            <span className="shrink-0 flex items-center gap-1 text-[11.5px] text-white/55">
              <span className="mr-0.5">Less</span>
              {Array.from({ length: HEAT_LEVELS + 1 }, (_, l) => (
                <span key={l} className="w-3 h-3 rounded-[3px]" style={{ background: heatFill(l) }} />
              ))}
              <span className="ml-0.5">More</span>
            </span>
          </div>
          <ReadoutStats stat={readout} />
        </div>
      </div>

      <div className="mt-3 pt-3 border-t border-white/10 flex flex-wrap gap-2">
        <QuickJump label="Today" onClick={() => jump(todayKey)} />
        <QuickJump label="A week ago" onClick={() => quick("week")} />
        <QuickJump label="A month ago" onClick={() => quick("month")} />
        <QuickJump label="A year ago" onClick={() => quick("year")} />
      </div>
    </div>,
    document.body,
  );
}

const FALLBACK_SCALE: HeatScale = { cap: 2 };

interface ReadoutStat {
  label: string;
  plays: number;
  secs: number;
  skips: number;
}

// The numbers under the strip. The value is the loud half of each pair and its
// unit the quiet half, so a glance lands on the figures; the accent ties plays
// to the heat colours above them, and skips take the purple of the Skipped tag
// on a History row, so they are never read as viewing. The row keeps one height,
// numbers or not, or the panel would twitch as the cursor crosses an empty day.
function ReadoutStats({ stat }: { stat: ReadoutStat }) {
  const { plays, secs, skips } = stat;
  if (plays <= 0 && secs <= 0 && skips <= 0) {
    return <div className="mt-1 h-7 flex items-center text-[13px] text-white/45">No plays</div>;
  }
  return (
    <div className="mt-1 h-7 flex items-baseline gap-4 overflow-hidden whitespace-nowrap tabular-nums">
      {plays > 0 && (
        <span>
          <span className="text-[19px] leading-7 font-semibold text-ln-accent">{NUM_FMT.format(plays)}</span>
          <span className="ml-1 text-[12px] text-white/55">play{plays === 1 ? "" : "s"}</span>
        </span>
      )}
      {secs > 0 && (
        <span>
          <span className="text-[15px] leading-7 font-semibold text-white/90">{formatWatchTime(secs)}</span>
          <span className="ml-1 text-[12px] text-white/55">watched</span>
        </span>
      )}
      {skips > 0 && (
        <span>
          <span className="text-[15px] leading-7 font-semibold text-purple-200">{NUM_FMT.format(skips)}</span>
          <span className="ml-1 text-[12px] text-white/55">skipped</span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The full-year strip: one column per week, one row per weekday (the locale's
// week start on top), GitHub / AniList style. ~370 squares, so it is ONE SVG
// with one set of handlers reading `data-k` off the target, not 370 buttons:
// the squares are about 6 px, too small to be a keyboard surface, and the
// month grid above already is one. Its rects are memoised on the data, so a
// hover re-renders only the two overlay rects.
// ---------------------------------------------------------------------------

const CELL = 10;
const PITCH = 12;

interface StripProps {
  year: number;
  /** 0-11 to brighten that month's label, -1 for none. */
  visibleMonth: number;
  dayCounts: Map<string, number>;
  scale: HeatScale;
  todayKey: string;
  currentKey: string | null;
  hoverKey: string | null;
  summary: string;
  onHover: (key: string | null) => void;
  onPick: (key: string) => void;
}

const YearStrip = memo(function YearStrip({
  year, visibleMonth, dayCounts, scale, todayKey, currentKey, hoverKey, summary, onHover, onPick,
}: StripProps) {
  const layout = useMemo(() => {
    const lead = (new Date(year, 0, 1).getDay() - WEEK_START + 7) % 7;
    const pos = new Map<string, { x: number; y: number }>();
    const rects: React.ReactNode[] = [];
    const monthCols: number[] = [];
    let slot = lead;
    // Date arithmetic by setDate, never by adding 86,400,000 ms: a DST day
    // is 23 or 25 hours long and the millisecond step drifts across midnight.
    for (const d = new Date(year, 0, 1); d.getFullYear() === year; d.setDate(d.getDate() + 1), slot++) {
      const key = dayKeyOfDate(d);
      const x = Math.floor(slot / 7) * PITCH;
      const y = (slot % 7) * PITCH;
      if (d.getDate() === 1) monthCols.push(Math.floor(slot / 7));
      pos.set(key, { x, y });
      const future = key > todayKey;
      const level = heatLevel(dayCounts.get(key) ?? 0, scale);
      rects.push(
        <rect
          key={key}
          data-k={future ? undefined : key}
          x={x}
          y={y}
          width={CELL}
          height={CELL}
          rx={2}
          className={future ? undefined : "cursor-pointer"}
          style={{ fill: future ? FUTURE_FILL : heatFill(level) }}
        />,
      );
    }
    return { pos, rects, monthCols, cols: Math.floor((slot - 1) / 7) + 1 };
  }, [year, dayCounts, scale, todayKey]);

  const lastHover = useRef<string | null>(null);
  const keyAt = (t: EventTarget | null) =>
    t instanceof Element ? t.getAttribute("data-k") : null;
  const width = layout.cols * PITCH - (PITCH - CELL);
  const height = 7 * PITCH - (PITCH - CELL);
  const cur = currentKey ? layout.pos.get(currentKey) : undefined;
  const hov = hoverKey ? layout.pos.get(hoverKey) : undefined;

  return (
    <div>
      <div className="relative h-4 mb-1" aria-hidden>
        {layout.monthCols.map((col, m) => (
          <span
            key={m}
            className={`absolute top-0 text-[11px] leading-none ${
              m === visibleMonth ? "text-white/90 font-semibold" : "text-white/45"}`}
            style={{ left: `${(col / layout.cols) * 100}%` }}
          >
            {MONTH_SHORT_FMT.format(new Date(year, m, 1))}
          </span>
        ))}
      </div>
      <svg
        role="img"
        aria-label={summary}
        viewBox={`-1 -1 ${width + 2} ${height + 2}`}
        className="block w-full h-auto"
        onMouseMove={(e) => {
          const k = keyAt(e.target);
          // The gaps between squares carry no key: keep the last day rather
          // than flicker the readout back to the year between neighbours.
          if (k && k !== lastHover.current) { lastHover.current = k; onHover(k); }
        }}
        onMouseLeave={() => { lastHover.current = null; onHover(null); }}
        onClick={(e) => { const k = keyAt(e.target); if (k) onPick(k); }}
      >
        {layout.rects}
        {cur && (
          <rect x={cur.x} y={cur.y} width={CELL} height={CELL} rx={2}
                fill="none" stroke="rgb(255 255 255 / 0.9)" strokeWidth={2} pointerEvents="none" />
        )}
        {hov && (
          <rect x={hov.x - 1} y={hov.y - 1} width={CELL + 2} height={CELL + 2} rx={3}
                fill="none" stroke="rgb(255 255 255 / 0.7)" strokeWidth={1.5} pointerEvents="none" />
        )}
      </svg>
    </div>
  );
});

function QuickJump({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 px-3 py-1.5 rounded-full text-[13px] font-medium whitespace-nowrap bg-white/6
                 text-white/75 border border-white/10 hover:bg-white/12 hover:text-white transition-colors"
    >
      {label}
    </button>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}
