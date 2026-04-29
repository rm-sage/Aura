import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LibraryItem, AddonEntry, MetaDetail } from "../types";
import { loadAuraSettings } from "../auraSettings";

// ---------------------------------------------------------------------------
// CalendarView — monthly grid with heatmap + per-day breakdown
//
// The calendar pulls each library item's full meta detail (concurrency 4) to
// resolve a release date. The grid then groups every release into its day
// cell; clicking a cell scrolls a vertical detail list below.
//
// "Today" is highlighted with a multi-stop box-shadow built from the Aura
// spectral palette (see `.cal-today` in App.css).
// ---------------------------------------------------------------------------

const DAYS_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Date helpers ---------------------------------------------------------------

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeekMon(d: Date): Date {
  const x = startOfDay(d);
  const dow = x.getDay();              // 0..6, Sunday=0
  const diff = (dow + 6) % 7;          // shift Mon=0
  x.setDate(x.getDate() - diff);
  return x;
}

function startOfMonth(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

function addMonths(d: Date, n: number): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth() &&
         a.getDate()     === b.getDate();
}

function parseReleaseDate(detail: MetaDetail | null, item: LibraryItem): Date | null {
  const candidates = [
    detail?.released,
    detail?.release_info,
    item.year,
  ].filter((x): x is string => !!x);

  for (const c of candidates) {
    const iso = Date.parse(c);
    if (!isNaN(iso)) return startOfDay(new Date(iso));
    if (/^\d{4}$/.test(c)) return startOfDay(new Date(parseInt(c, 10), 0, 1));
  }
  return null;
}

// ---------------------------------------------------------------------------
// CalendarEntry & view shape
// ---------------------------------------------------------------------------

interface CalendarEntry {
  item: LibraryItem;
  detail: MetaDetail | null;
  releaseDate: Date;
}

interface Props {
  library: LibraryItem[];
  addons: AddonEntry[];
}

// ---------------------------------------------------------------------------
// CalendarView
// ---------------------------------------------------------------------------

export default function CalendarView({ library, addons }: Props) {
  const [details, setDetails] = useState<Map<string, MetaDetail | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState<Date>(() => startOfDay(new Date()));

  // Resolve metadata addon: setting > first installed
  const metaAddon = useMemo(() => {
    const { defaultMetadataAddonUrl } = loadAuraSettings();
    return (
      (defaultMetadataAddonUrl && addons.find((a) => a.url === defaultMetadataAddonUrl)) ??
      addons[0] ??
      null
    );
  }, [addons]);

  // Fetch detail for every library item, bounded concurrency 4
  useEffect(() => {
    if (!metaAddon || library.length === 0) {
      setDetails(new Map());
      return;
    }
    let cancelled = false;
    setLoading(true);

    (async () => {
      const next = new Map<string, MetaDetail | null>();
      const concurrency = 4;
      let cursor = 0;
      const worker = async () => {
        while (!cancelled) {
          const i = cursor++;
          if (i >= library.length) return;
          const item = library[i];
          try {
            const d = await invoke<MetaDetail>("fetch_meta_detail", {
              addonUrl: metaAddon.url,
              mediaType: item.media_type,
              id: item.id,
            });
            next.set(item.id, d);
          } catch {
            next.set(item.id, null);
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, worker));
      if (!cancelled) {
        setDetails(next);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [library, metaAddon]);

  // Build a date-keyed bucket of entries across the entire library
  const entriesByDate = useMemo(() => {
    const buckets = new Map<string, CalendarEntry[]>();
    for (const item of library) {
      const detail = details.get(item.id) ?? null;
      const release = parseReleaseDate(detail, item);
      if (!release) continue;
      const key = dateKey(release);
      const list = buckets.get(key) ?? [];
      list.push({ item, detail, releaseDate: release });
      buckets.set(key, list);
    }
    return buckets;
  }, [library, details]);

  // Build the visible 6×7 grid for the current month (Mon-anchored)
  const monthCells = useMemo(() => {
    const gridStart = startOfWeekMon(monthAnchor);
    const cells: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getTime() + i * DAYS_MS);
      cells.push({ date: d, inMonth: d.getMonth() === monthAnchor.getMonth() });
    }
    return cells;
  }, [monthAnchor]);

  const today = useMemo(() => startOfDay(new Date()), []);
  const selectedEntries = entriesByDate.get(dateKey(selectedDate)) ?? [];

  const monthLabel = monthAnchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const goPrev   = () => setMonthAnchor((d) => addMonths(d, -1));
  const goNext   = () => setMonthAnchor((d) => addMonths(d, 1));
  const goToday  = () => {
    const now = startOfDay(new Date());
    setMonthAnchor(startOfMonth(now));
    setSelectedDate(now);
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="flex-1 overflow-y-auto"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        <div className="max-w-6xl mx-auto px-6 py-6 space-y-6">
          {/* Header */}
          <div className="flex items-end justify-between gap-4">
            <div>
              <h1 className="text-white/85 text-xl font-light tracking-wide">Release Calendar</h1>
              <p className="text-white/35 text-sm mt-1">
                Releases for items in your library.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {loading && <span className="text-white/35 text-xs mr-2">Loading…</span>}
              <button
                onClick={goPrev}
                aria-label="Previous month"
                className="w-9 h-9 rounded-full glass-panel flex items-center justify-center
                           text-white/70 hover:text-white transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6z" />
                </svg>
              </button>
              <button
                onClick={goToday}
                className="px-3 h-9 rounded-full glass-panel text-xs font-medium
                           text-white/70 hover:text-white transition-colors"
              >
                Today
              </button>
              <button
                onClick={goNext}
                aria-label="Next month"
                className="w-9 h-9 rounded-full glass-panel flex items-center justify-center
                           text-white/70 hover:text-white transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
                </svg>
              </button>
            </div>
          </div>

          {/* Month label */}
          <div className="flex items-baseline gap-3">
            <h2 className="text-white/80 text-2xl font-light tracking-wide">{monthLabel}</h2>
            <span className="text-white/30 text-xs">
              {entriesByDate.size === 0
                ? "No releases tracked"
                : `${[...entriesByDate.values()].reduce((s, l) => s + l.length, 0)} total in library`}
            </span>
          </div>

          {/* Empty/empty-addon states */}
          {!metaAddon && (
            <div className="glass-panel rounded-2xl px-5 py-4">
              <p className="text-white/55 text-sm">
                Add an addon (in the Addons tab) to populate the calendar.
              </p>
            </div>
          )}
          {metaAddon && library.length === 0 && !loading && (
            <div className="glass-panel rounded-2xl px-5 py-4">
              <p className="text-white/55 text-sm">
                Your library is empty. Items you save show up here when their
                release date falls in view.
              </p>
            </div>
          )}

          {/* Weekday header */}
          <div className="grid grid-cols-7 gap-2 px-1">
            {WEEKDAY_LABELS.map((d) => (
              <div key={d} className="text-white/35 text-[10px] font-semibold tracking-[0.18em] uppercase text-center">
                {d}
              </div>
            ))}
          </div>

          {/* Month grid */}
          <div className="grid grid-cols-7 gap-2">
            {monthCells.map(({ date, inMonth }) => {
              const key = dateKey(date);
              const entries = entriesByDate.get(key) ?? [];
              const isToday = isSameDay(date, today);
              const isSelected = isSameDay(date, selectedDate);
              const dim = !inMonth;

              return (
                <button
                  key={key}
                  onClick={() => setSelectedDate(date)}
                  className={`relative h-20 rounded-xl glass-panel p-2 text-left
                              transition-all duration-150 overflow-hidden
                              ${dim ? "opacity-35" : "hover:bg-white/8"}
                              ${isSelected && !isToday ? "ring-1 ring-white/35" : ""}
                              ${isToday ? "cal-today" : ""}`}
                >
                  <div className="flex items-start justify-between">
                    <span
                      className={`text-sm font-medium leading-none
                                  ${isToday
                                    ? "text-ln-accent"
                                    : dim
                                      ? "text-white/35"
                                      : "text-white/75"
                                  }`}
                    >
                      {date.getDate()}
                    </span>
                    {entries.length > 0 && (
                      <Heatmap count={entries.length} />
                    )}
                  </div>

                  {/* Up to two release names as tiny labels */}
                  {entries.length > 0 && (
                    <div className="mt-2 space-y-0.5">
                      {entries.slice(0, 2).map(({ item, detail }) => (
                        <p
                          key={item.id}
                          className="text-[10px] text-white/55 truncate leading-tight"
                          title={detail?.name ?? item.name}
                        >
                          {detail?.name ?? item.name}
                        </p>
                      ))}
                      {entries.length > 2 && (
                        <p className="text-[10px] text-white/35">+{entries.length - 2} more</p>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Selected-day breakdown */}
          <section className="space-y-3 pt-2">
            <div className="flex items-baseline gap-3 px-1">
              <h3 className="text-white/80 text-sm font-semibold tracking-wide">
                {selectedDate.toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
              </h3>
              <span className="text-white/30 text-xs">
                {selectedEntries.length === 0
                  ? "No releases"
                  : `${selectedEntries.length} release${selectedEntries.length === 1 ? "" : "s"}`}
              </span>
            </div>

            {selectedEntries.length === 0 ? (
              <div className="glass-panel rounded-2xl px-5 py-6 text-center">
                <p className="text-white/40 text-sm">Nothing scheduled for this day.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {selectedEntries.map(({ item, detail, releaseDate }) => (
                  <CalendarRow
                    key={item.id}
                    name={detail?.name ?? item.name}
                    poster={detail?.poster ?? item.poster}
                    mediaType={detail?.media_type ?? item.media_type}
                    description={detail?.description ?? null}
                    released={releaseDate}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap dot — quick visual for "this day has releases"
// ---------------------------------------------------------------------------

function Heatmap({ count }: { count: number }) {
  // Single dot if 1, glowing dot if 2+, ringed dot if 4+
  const radius = count >= 4 ? 4 : 3;
  const glow   = count >= 2;
  return (
    <span
      className="flex items-center justify-center"
      style={{ width: 10, height: 10 }}
      aria-label={`${count} release${count === 1 ? "" : "s"}`}
    >
      <span
        className="rounded-full bg-ln-accent"
        style={{
          width:  radius * 1.5,
          height: radius * 1.5,
          boxShadow: glow ? "0 0 6px rgba(91, 164, 255, 0.55)" : undefined,
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// CalendarRow — vertical detail card for a release
// ---------------------------------------------------------------------------

function CalendarRow({
  name, poster, mediaType, description, released,
}: {
  name: string;
  poster: string | null;
  mediaType: string;
  description: string | null;
  released: Date;
}) {
  return (
    <div className="glass-panel rounded-xl px-4 py-3 flex items-start gap-4">
      <div className="flex-shrink-0 w-12 h-16 rounded-md overflow-hidden bg-white/5 border border-white/8">
        {poster ? (
          <img src={poster} alt="" className="w-full h-full object-cover" draggable={false} />
        ) : null}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white/85 text-sm font-medium leading-tight truncate">{name}</p>
        <p className="text-white/35 text-xs mt-0.5">
          {mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} ·{" "}
          {released.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </p>
        {description && (
          <p className="text-white/45 text-xs mt-1.5 line-clamp-2 leading-relaxed">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
