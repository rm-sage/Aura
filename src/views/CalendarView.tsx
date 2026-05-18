// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useMemo } from "react";
import type { LibraryItem, AddonEntry, MetaDetail, MetaPreview, VideoEntry } from "../types";
import { loadAuraSettings } from "../auraSettings";
import { resolveDefaultMetaUrl } from "../addonDefaults";
import { getMetaDetail } from "../metaCache";
import ImageLoader from "../ImageLoader";
import { formatEpLabel } from "../episodeLabel";

// ---------------------------------------------------------------------------
// CalendarView — full-viewport month grid + day-click overlay
//
// The calendar pulls each library item's full meta detail (concurrency 4) to
// resolve a release date. The grid groups every release into its day cell;
// clicking a cell with releases opens a glass-panel overlay instead of an
// inline breakdown section (which ate vertical space and required scrolling).
//
// Grid rows use `minmax(0, 1fr)` so the 5- or 6-row grid fills all remaining
// height without overflow or wasted space at any viewport height.
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
  /** Per-episode release for series items; null for movies (the whole
   *  movie's release date is the only release). */
  video: VideoEntry | null;
  releaseDate: Date;
}

interface Props {
  library: LibraryItem[];
  addons: AddonEntry[];
  /** Click handler — opens the DetailView for the selected entry. */
  onSelectMeta?: (meta: MetaPreview) => void;
}

function libraryItemToMeta(item: LibraryItem, detail: MetaDetail | null): MetaPreview {
  return {
    id:           item.id,
    name:         detail?.name ?? item.name,
    media_type:   detail?.media_type ?? item.media_type,
    poster:       detail?.poster ?? item.poster,
    background:   detail?.background ?? item.background,
    fanart:       null,
    backdrop:     null,
    logo:         detail?.logo ?? item.logo,
    release_info: detail?.release_info ?? item.year,
    description:  detail?.description ?? null,
    imdb_rating:  detail?.imdb_rating ?? null,
    genres:       detail?.genres ?? [],
  };
}

// ---------------------------------------------------------------------------
// PosterShimmer — animated skeleton shown while metadata is loading
// ---------------------------------------------------------------------------

function PosterShimmer() {
  return (
    <div
      aria-hidden
      className="absolute inset-0 rounded-md image-loader-skeleton"
    />
  );
}

// ---------------------------------------------------------------------------
// CalendarView
// ---------------------------------------------------------------------------

// CalendarView routes meta fetches through the shared `metaCache.ts`
// module — same persistent 4h-for-episodic / 7d-for-movie TTL the
// HomeView, DetailView, and NotificationsScanner use. Previously this
// file maintained its OWN parallel `calendarMetaCache` Map that
// bypassed the persistent cache, so a fresh app start always paid
// 100+ HTTP round-trips to fill the calendar even though the meta
// was already on disk from a prior session. The shared cache also
// dedupes concurrent calls (`dedupedInvoke`) so two views asking
// for the same item at the same time fire one network request.

export default function CalendarView({ library, addons, onSelectMeta }: Props) {
  const [details, setDetails] = useState<Map<string, MetaDetail | null>>(new Map());
  const [loading, setLoading] = useState(false);
  const [monthAnchor, setMonthAnchor] = useState<Date>(() => startOfMonth(new Date()));
  // overlayDate drives the day-click modal; null = closed.
  const [overlayDate, setOverlayDate] = useState<Date | null>(null);

  // Resolve metadata addon: explicit setting > manifest-id default
  // (AIOMetadata → Cinemeta) > first installed. Fresh-install users
  // with only Cinemeta get Cinemeta; users with AIOMetadata get that.
  const metaAddon = useMemo(() => {
    const { defaultMetadataAddonUrl } = loadAuraSettings();
    const override = defaultMetadataAddonUrl &&
      addons.find((a) => a.url === defaultMetadataAddonUrl);
    if (override) return override;
    const defaultUrl = resolveDefaultMetaUrl(addons);
    if (defaultUrl) {
      const m = addons.find((a) => a.url === defaultUrl);
      if (m) return m;
    }
    return addons[0] ?? null;
  }, [addons]);

  // Fetch detail for every library item via the shared metaCache —
  // hits from prior sessions / other views land instantly, misses
  // fan out concurrently with concurrency 4.
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
          // getMetaDetail handles cache + dedupe + null-on-error.
          const d = await getMetaDetail(metaAddon, item.media_type, item.id)
            .catch(() => null);
          next.set(item.id, d);
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

  // Build a date-keyed bucket of entries across the entire library.
  //
  // For SERIES items: walk detail.videos and bucket each episode by its
  //   own `released` date. That's how Stremio's calendar populates the
  //   future grid — each upcoming episode shows on its airdate.
  // For MOVIES: bucket by the single release_info / year fallback.
  // Items without any release date skip silently.
  const entriesByDate = useMemo(() => {
    const buckets = new Map<string, CalendarEntry[]>();
    const isEpisodicType = (t: string) =>
      ["series", "anime"].includes((t ?? "").toLowerCase());

    for (const item of library) {
      const detail = details.get(item.id) ?? null;
      const episodic = isEpisodicType(item.media_type);

      if (episodic && detail?.videos?.length) {
        for (const v of detail.videos) {
          if (!v.released) continue;
          const ts = Date.parse(v.released);
          if (isNaN(ts)) continue;
          const day = startOfDay(new Date(ts));
          const key = dateKey(day);
          const list = buckets.get(key) ?? [];
          list.push({ item, detail, video: v, releaseDate: day });
          buckets.set(key, list);
        }
        continue;
      }

      // Movie / non-episodic — single bucket from the meta-level date.
      const release = parseReleaseDate(detail, item);
      if (!release) continue;
      const key = dateKey(release);
      const list = buckets.get(key) ?? [];
      list.push({ item, detail, video: null, releaseDate: release });
      buckets.set(key, list);
    }
    return buckets;
  }, [library, details]);

  // Build the visible grid for the current month (Mon-anchored).
  // Default to 5 rows; expand to 6 only when the month genuinely needs
  // it (e.g. Aug 2026 — Aug 1 is a Saturday + 31 days). This keeps the
  // common case denser without ever clipping the tail of the month.
  const { monthCells, rows } = useMemo(() => {
    const gridStart = startOfWeekMon(monthAnchor);
    const monthEnd = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + 1, 0);
    const daysSpanned = Math.floor((monthEnd.getTime() - gridStart.getTime()) / DAYS_MS) + 1;
    const weeksNeeded = Math.ceil(daysSpanned / 7);
    const r = Math.max(5, weeksNeeded);
    const totalCells = r * 7;
    const cells: { date: Date; inMonth: boolean }[] = [];
    for (let i = 0; i < totalCells; i++) {
      const d = new Date(gridStart.getTime() + i * DAYS_MS);
      cells.push({ date: d, inMonth: d.getMonth() === monthAnchor.getMonth() });
    }
    return { monthCells: cells, rows: r };
  }, [monthAnchor]);

  const today = useMemo(() => startOfDay(new Date()), []);

  const monthLabel = monthAnchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });

  const goPrev  = () => setMonthAnchor((d) => addMonths(d, -1));
  const goNext  = () => setMonthAnchor((d) => addMonths(d, 1));
  const goToday = () => setMonthAnchor(startOfMonth(startOfDay(new Date())));

  const overlayEntries = overlayDate ? (entriesByDate.get(dateKey(overlayDate)) ?? []) : [];

  return (
    // flex-1 + flex-col + min-h-0: fills the parent flex slot (App's main
    // content area) without overflowing. min-h-0 is required so the inner
    // flex children can shrink below their intrinsic content height.
    <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden">
      {/* Scrollable page chrome — header, month label, empty states */}
      <div
        className="mx-auto w-full px-6 pt-6 pb-3 shrink-0"
        style={{ maxWidth: "min(2200px, 96%)" }}
      >
        {/* Header */}
        <div className="flex items-end justify-between gap-4 mb-4">
          <div>
            <h1 className="aura-row-title text-3xl font-semibold tracking-tight">Release Calendar</h1>
            <p className="text-white/35 text-sm mt-1">
              Releases for items in your library.
            </p>
          </div>
          <div className="flex items-center gap-2">
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
        <div className="flex items-baseline gap-3 mb-3">
          <h2 className="text-white/80 text-2xl font-light tracking-wide">{monthLabel}</h2>
          <span className="text-white/30 text-xs">
            {entriesByDate.size === 0
              ? "No releases tracked"
              : `${[...entriesByDate.values()].reduce((s, l) => s + l.length, 0)} total in library`}
          </span>
        </div>

        {/* Empty/empty-addon states */}
        {!metaAddon && (
          <div className="glass-panel rounded-2xl px-5 py-4 mb-3">
            <p className="text-white/55 text-sm">
              Add an addon (in the Addons tab) to populate the calendar.
            </p>
          </div>
        )}
        {metaAddon && library.length === 0 && !loading && (
          <div className="glass-panel rounded-2xl px-5 py-4 mb-3">
            <p className="text-white/55 text-sm">
              Your library is empty. Items you save show up here when their
              release date falls in view.
            </p>
          </div>
        )}

        {/* Indeterminate loading bar — visible while meta fetches are in-flight.
            Sits just above the weekday header so it reads as page-level progress
            rather than belonging to any individual cell. */}
        {loading && (
          <div className="relative h-[3px] w-full rounded-full bg-white/5 overflow-hidden mb-2">
            <div
              className="absolute top-0 left-0 h-full w-1/3 rounded-full bg-ln-accent"
              style={{ animation: "calendar-loading-bar 1.4s ease-in-out infinite" }}
            />
          </div>
        )}

        {/* Weekday header */}
        <div className="grid grid-cols-7 gap-2 px-1 mb-2">
          {WEEKDAY_LABELS.map((d) => (
            <div key={d} className="text-white/35 text-[10px] font-semibold tracking-[0.18em] uppercase text-center">
              {d}
            </div>
          ))}
        </div>
      </div>

      {/* Month grid — flex-1 + min-h-0 fills all remaining vertical space.
          gridTemplateRows uses 1fr per row so cells grow/shrink with the
          viewport height rather than being fixed at 175 px. */}
      <div
        className="flex-1 min-h-0 mx-auto w-full px-6 pb-4"
        style={{ maxWidth: "min(2200px, 96%)" }}
      >
        <div
          key={monthAnchor.getMonth()}
          className="grid grid-cols-7 gap-2 h-full"
          style={{
            gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
            gridAutoRows: "minmax(0, 1fr)",
          }}
        >
          {monthCells.map(({ date, inMonth }) => {
            const key = dateKey(date);
            const entries = entriesByDate.get(key) ?? [];
            const isToday = isSameDay(date, today);
            const dim = !inMonth;

            // Dedup posters by series id so a day with 5 episodes of the
            // same show shows ONE poster, not five identical thumbs.
            // Cap at 2 visible posters — cleaner at cell sizes than 3.
            const allDedupedEntries: typeof entries = [];
            const seen = new Set<string>();
            for (const e of entries) {
              if (seen.has(e.item.id)) continue;
              seen.add(e.item.id);
              allDedupedEntries.push(e);
            }
            const totalDeduped = allDedupedEntries.length;
            const visiblePosters = allDedupedEntries.slice(0, 2);
            const hiddenPosters = allDedupedEntries.slice(2);
            const hiddenCount = totalDeduped - visiblePosters.length;

            const CellTag = entries.length > 0 ? "button" : "div";
            return (
              // NOTE: overflow-hidden is intentionally absent so the hover
              // popout (absolute bottom-full) can escape the cell boundary.
              // Top-row cells will have their popout clipped by the page
              // chrome — this is acceptable for v1 (the outer wrapper's
              // overflow-hidden clips it cleanly without broken layout).
              <CellTag
                key={key}
                {...(entries.length > 0
                  ? { onClick: () => setOverlayDate(date) }
                  : {})}
                className={`group relative rounded-xl glass-panel p-2 text-left
                            flex flex-col
                            ${dim ? "opacity-35" : ""}
                            ${entries.length > 0
                              ? "cursor-pointer transition-all duration-150 hover:bg-white/10 hover:border-white/20 hover:scale-[1.02] hover:ring-1 hover:ring-ln-accent/40"
                              : "cursor-default"}
                            ${isToday ? "cal-today" : ""}`}
              >
                {/* Date number + optional overflow badge */}
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
                  {/* Badge: only shown when there are hidden posters */}
                  {hiddenCount > 0 && (
                    <span className="text-xs font-bold tracking-wide text-ln-accent
                                     px-2 py-0.5 rounded bg-ln-accent/25 border border-ln-accent/40">
                      +{hiddenCount}
                    </span>
                  )}
                </div>


                {/* Visible poster strip — max 2 posters per cell */}
                {visiblePosters.length > 0 && (
                  // Posters share the remaining cell height equally — height
                  // is driven by the 1fr row, not a fixed minHeight. The
                  // 2:3 aspect ratio derives width from height automatically.
                  <div className="mt-2 flex-1 min-h-0 flex items-end justify-center gap-1.5">
                    {visiblePosters.map(({ item, detail, video }) => {
                      const src = detail?.poster ?? item.poster;
                      const epLabel =
                        video && video.season != null && video.episode != null
                          ? formatEpLabel(video.season, video.episode)
                          : null;
                      return (
                        <div
                          key={item.id}
                          className="relative h-full rounded-md overflow-hidden
                                     bg-white/5 border border-white/10"
                          style={{ aspectRatio: "2 / 3" }}
                          title={detail?.name ?? item.name}
                        >
                          {src ? (
                            <ImageLoader
                              src={src}
                              alt=""
                              draggable={false}
                              className="absolute inset-0 w-full h-full"
                              imgClassName="w-full h-full object-cover"
                            />
                          ) : loading ? (
                            <PosterShimmer />
                          ) : (
                            <div className="absolute inset-0 flex items-center justify-center
                                            text-white/20 text-[10px]">
                              ?
                            </div>
                          )}
                          {epLabel && (
                            // Top-LEFT to match the DayOverlay badge and to
                            // stay clear of addon-baked HDR/DV/language badges
                            // that sit in the poster's top-right art.
                            <span
                              className="absolute top-1 left-1 text-[9px] leading-none
                                         font-mono font-semibold text-white/95
                                         px-1 py-0.5 rounded bg-black/85
                                         border border-white/15"
                            >
                              {epLabel}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Hover popout — floats above the cell, shows hidden posters.
                    Only rendered when there are posters beyond the 2-cap.
                    pointer-events-none throughout: the parent <button> cell
                    owns the click; the popout is purely decorative on hover. */}
                {hiddenCount > 0 && (
                  <div
                    className="absolute bottom-full left-0 right-0 mb-2 z-50
                               pointer-events-none
                               opacity-0 scale-90 translate-y-2
                               group-hover:opacity-100 group-hover:scale-100 group-hover:translate-y-0
                               transition-all duration-200 ease-out"
                    style={{ transformOrigin: "bottom right" }}
                  >
                    <div className="bg-black/85 backdrop-blur-md rounded-xl
                                    border border-white/15 shadow-glass-edge p-2
                                    flex flex-row gap-1.5 overflow-x-auto whitespace-nowrap"
                         style={{ height: "180px" }}>
                      {hiddenPosters.map(({ item, detail }, i) => {
                        const src = detail?.poster ?? item.poster;
                        return (
                          <div
                            key={item.id}
                            className="relative h-full flex-shrink-0 rounded-md overflow-hidden
                                       bg-white/5 border border-white/10
                                       opacity-0 scale-90
                                       group-hover:opacity-100 group-hover:scale-100
                                       transition-all duration-200 ease-out"
                            style={{
                              aspectRatio: "2 / 3",
                              transitionDelay: `${i * 30}ms`,
                            }}
                            title={detail?.name ?? item.name}
                          >
                            {src ? (
                              <ImageLoader
                                src={src}
                                alt=""
                                draggable={false}
                                className="absolute inset-0 w-full h-full"
                                imgClassName="w-full h-full object-cover"
                              />
                            ) : (
                              <div className="absolute inset-0 flex items-center justify-center
                                              text-white/20 text-[10px]">
                                ?
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CellTag>
            );
          })}
        </div>
      </div>

      {/* Day overlay — mounted only when a cell with releases is clicked */}
      {overlayDate && (
        <DayOverlay
          date={overlayDate}
          entries={overlayEntries}
          onClose={() => setOverlayDate(null)}
          onSelectMeta={onSelectMeta}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DayOverlay — modal that appears when the user clicks a calendar cell.
//
// Animation mirrors DetailView's `opening` pattern: two rAF ticks after mount
// flip `opening` to false, which transitions opacity 0→1 and scale 0.92→1.
// Backdrop fades 60 ms before the card via a CSS delay on the card transform.
// ---------------------------------------------------------------------------

interface DayOverlayProps {
  date: Date;
  entries: CalendarEntry[];
  onClose: () => void;
  onSelectMeta?: (meta: MetaPreview) => void;
}

function DayOverlay({ date, entries, onClose, onSelectMeta }: DayOverlayProps) {
  const [opening, setOpening] = useState(true);
  const cardRef = useRef<HTMLDivElement>(null);

  // Two rAF ticks = one painted frame; after that the browser has committed
  // the initial opacity:0/scale:0.92 state, so the transition fires visibly.
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setOpening(false))
    );
    return () => cancelAnimationFrame(id);
  }, []);

  // ESC closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const releaseCount = entries.length;

  return (
    // Backdrop — fixed full-viewport, sits above the calendar (z-55) but
    // below PlayerOverlay (z-60+). Fades in immediately on mount.
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center p-6"
      style={{
        backgroundColor: opening ? "transparent" : "rgba(0,0,0,0.80)",
        backdropFilter: opening ? "blur(0px)" : "blur(8px)",
        transition: "background-color 200ms ease, backdrop-filter 200ms ease",
      }}
      onClick={onClose}
    >
      {/* Modal card — click-through stops propagation to backdrop */}
      <div
        ref={cardRef}
        className="glass-panel rounded-2xl flex flex-col overflow-hidden"
        style={{
          width: "min(1100px, 92vw)",
          maxHeight: "88vh",
          opacity: opening ? 0 : 1,
          transform: opening ? "scale(0.92)" : "scale(1)",
          // 60 ms delay staggers the card entry slightly after the backdrop
          transition: "opacity 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1), transform 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-start justify-between gap-4 px-6 py-5 shrink-0
                        border-b border-white/8">
          <div>
            <h2 className="text-white/90 text-lg font-semibold tracking-tight">{dateLabel}</h2>
            <p className="text-white/40 text-sm mt-0.5">
              {releaseCount === 1 ? "1 release" : `${releaseCount} releases`}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full glass-panel flex items-center justify-center
                       text-white/50 hover:text-white transition-colors shrink-0 mt-0.5"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {/* Card grid — scrollable */}
        <div
          className="overflow-y-auto p-6"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
            {entries.map(({ item, detail, video, releaseDate }, idx) => (
              <CalendarCard
                key={`${item.id}:${video?.id ?? idx}`}
                name={detail?.name ?? item.name}
                poster={detail?.poster ?? item.poster}
                mediaType={detail?.media_type ?? item.media_type}
                episodeTag={video && video.season != null && video.episode != null
                  ? formatEpLabel(video.season, video.episode)
                  : null}
                episodeTitle={video?.title ?? null}
                released={releaseDate}
                onClick={onSelectMeta ? () => { onClose(); onSelectMeta(libraryItemToMeta(item, detail)); } : undefined}
                onContextMenu={(e) => {
                  // Right-click → fire the same `aura:card-context`
                  // event the rest of the app's cards use. The App-
                  // level listener resolves the meta to a context menu
                  // (Mark watched, Add/Remove from library, Open in…
                  // etc.) anchored at the cursor coords. The overlay
                  // stays open so the user can keep exploring after
                  // making a context-menu choice.
                  e.preventDefault();
                  window.dispatchEvent(new CustomEvent("aura:card-context", {
                    detail: {
                      meta: libraryItemToMeta(item, detail),
                      x: e.clientX,
                      y: e.clientY,
                      source: "calendar",
                      item,
                    },
                  }));
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalendarCard — poster-art tile used both in DayOverlay.
// ---------------------------------------------------------------------------

function CalendarCard({
  name, poster, mediaType, episodeTag, episodeTitle, released, onClick, onContextMenu,
}: {
  name: string;
  poster: string | null;
  mediaType: string;
  /** "S01E05"-style label when the card is for a series episode. */
  episodeTag: string | null;
  /** Episode-specific title; rendered under the series name. */
  episodeTitle: string | null;
  released: Date;
  /** Right-click handler — fires the `aura:card-context` event the
   *  shared App-level listener uses to render context menus on cards
   *  app-wide. Optional so non-interactive use sites stay clean. */
  onContextMenu?: (e: React.MouseEvent<HTMLElement>) => void;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  const dateLabel = released.toLocaleDateString(undefined, {
    month: "short", day: "numeric",
  });
  return (
    <Tag
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`glass-panel rounded-xl p-2.5 flex flex-col gap-2 text-left w-full
                  ${onClick ? "hover:bg-white/8 transition-colors cursor-pointer" : ""}`}
    >
      <div
        className="relative w-full rounded-md overflow-hidden bg-white/5 border border-white/8"
        style={{ aspectRatio: "2 / 3" }}
      >
        {poster ? (
          <ImageLoader
            src={poster}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-white/20 text-xs">
            No art
          </div>
        )}
        {episodeTag && (
          // Top-LEFT to keep clear of the AIOMetadata-baked badges
          // (HDR / language flag / DV) that sit in the top-right of the
          // poster art.
          <span className="absolute top-1.5 left-1.5 text-[13px] font-mono font-semibold
                           text-white/95 px-2 py-1 rounded
                           bg-black/85 border border-white/15">
            {episodeTag}
          </span>
        )}
      </div>
      <div className="min-w-0">
        <p className="text-white/95 text-sm font-semibold leading-tight line-clamp-2">{name}</p>
        {episodeTitle && (
          <p className="text-white/70 text-[12.5px] mt-0.5 line-clamp-1">{episodeTitle}</p>
        )}
        <p className="text-white/45 text-[11px] mt-0.5 font-mono">
          {mediaType.charAt(0).toUpperCase() + mediaType.slice(1)} · {dateLabel}
        </p>
      </div>
    </Tag>
  );
}
