// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// AnimeExtrasOverlay — the detail page's "More info" panel.
//
// WHY AN OVERLAY AND NOT A SECTION
//
// DetailView is already 5000+ lines and its left column is `justify-end`, so
// anything appended to the main stack pushes the hero title UPWARD rather than
// pushing content down. Everything in here is also genuinely secondary: a
// score histogram and a staff list are things you go looking for, not things
// you should have to scroll past on the way to pressing play.
//
// POSITIONING
//
// This renders ABSOLUTE inside DetailView's root, following SubtitlePicker's
// pattern, and deliberately does NOT portal. Two reasons:
//   1. DetailView's z-[60] root carries a transform, so a `position: fixed`
//      descendant positions against that root rather than the viewport. Fixed
//      positioning here would look right by accident and break on any future
//      transform change.
//   2. The other in-app overlays (CinemaRows' CatalogPopup, CalendarView's
//      DayOverlay) are z-[55], i.e. BELOW DetailView. Copying either would
//      render this underneath the page that opened it.
//
// FETCHING
//
// Per TAB, on first open of that tab. Opening the panel to look at the
// histogram never costs a staff request. See animeExtras.ts.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import ImageLoader from "./ImageLoader";
import { shrinkPoster } from "./posterSize";
import { loadAuraSettings } from "./auraSettings";
import { shouldBlurThemeRange } from "./episodeSpoilers";
import {
  fetchExtras, formatSpans, themeLabel,
  type AnimeStatistics, type AnimeTheme, type AnimeThemes, type AnimeTrailer,
  type CourRef, type Recommendation, type StaffCredit, type ExtrasTab,
} from "./animeExtras";

// Server-resize widths. Every image in here is decorative and small, and the
// upstream assets are not: MAL staff portraits are full-size, and the trailer
// thumbnail chain deliberately prefers YouTube's 1280x720 maxres asset because
// that is the only one guaranteed to exist. Decoded image memory is the app's
// top consumer, so each one is hinted to roughly its rendered width (the
// overlay caps at 56rem, so a 4-up poster grid is ~180px and a 3-up trailer
// grid is ~270px; doubled for high-DPI).
const STAFF_AVATAR_W = 72;
const RELATED_POSTER_W = 360;
const TRAILER_THUMB_W = 540;

const TABS: { id: ExtrasTab; label: string }[] = [
  { id: "songs",    label: "Songs" },
  { id: "ratings",  label: "Ratings" },
  { id: "staff",    label: "Staff" },
  { id: "related",  label: "Related" },
  { id: "trailers", label: "Trailers" },
];

interface Props {
  open: boolean;
  onClose: () => void;
  /** One entry per cour. Empty means the trigger should not have rendered. */
  cours: CourRef[];
  seriesName: string;
  /** Play a trailer through the existing in-MPV yt-dlp path. Takes a
   *  YouTube id, matching DetailView's own trailer button. */
  onPlayTrailer?: (ytId: string, title: string) => void;
}

export default function AnimeExtrasOverlay({
  open, onClose, cours, seriesName, onPlayTrailer,
}: Props) {
  const [tab, setTab] = useState<ExtrasTab>("songs");

  // Close on Escape. Capture phase so the detail page's own Escape handler
  // does not close the whole page out from under an open panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-8">
      {/* Scrim. Clicking it closes, matching every other dismissable surface. */}
      <div
        aria-hidden
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label={`More information about ${seriesName}`}
        className="aura-sheet-in glass-panel-elevated relative rounded-2xl shadow-glass-edge
                   w-full flex flex-col overflow-hidden"
        // Arbitrary values: tailwind.config replaces the maxWidth scale, so
        // every named max-w-* token emits no CSS at all and this would
        // stretch to the full viewport.
        style={{ maxWidth: "56rem", maxHeight: "78vh" }}
      >
        <header className="flex items-center justify-between gap-3 px-5 py-3
                           border-b border-white/8 flex-shrink-0">
          <div className="min-w-0">
            <h2 className="text-white/90 text-sm font-semibold tracking-wide truncate">
              {seriesName}
            </h2>
            <p className="text-white/30 text-[11px] mt-0.5">MyAnimeList via Tenrai</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 w-7 h-7 rounded-full text-white/50 hover:text-white
                       hover:bg-white/8 flex items-center justify-center transition-colors"
          >
            <CloseGlyph />
          </button>
        </header>

        <nav className="flex items-center gap-1 px-4 pt-3 pb-2 border-b border-white/6 flex-shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={
                "px-3 h-7 rounded-full text-[12px] font-medium transition-colors " +
                (tab === t.id
                  ? "bg-white/12 text-white/95"
                  : "text-white/45 hover:text-white/80 hover:bg-white/6")
              }
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div
          className="flex-1 min-h-0 overflow-y-auto px-5 py-4"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
        >
          {tab === "songs"    && <SongsTab cours={cours} />}
          {tab === "ratings"  && <RatingsTab cours={cours} />}
          {tab === "staff"    && <StaffTab cours={cours} />}
          {tab === "related"  && <RelatedTab cours={cours} />}
          {tab === "trailers" && <TrailersTab cours={cours} onPlay={onPlayTrailer} />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared per-cour loader
// ---------------------------------------------------------------------------

/** Loads one tab's payload for every cour in parallel. Returns entries in
 *  cour order with their labels, so each tab renders headings identically. */
function useCourPayloads<T>(tab: ExtrasTab, cours: CourRef[]) {
  const [rows, setRows] = useState<{ cour: CourRef; value: T | null }[] | null>(null);
  const key = useMemo(() => cours.map((c) => c.malId).join(","), [cours]);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    (async () => {
      const settled = await Promise.all(
        cours.map(async (cour) => ({
          cour,
          value: await fetchExtras<T>(tab, cour.malId),
        })),
      );
      if (!cancelled) setRows(settled);
    })();
    return () => { cancelled = true; };
    // `key` stands in for the cour list; `tab` is fixed per mounted tab.
  }, [tab, key]);

  return rows;
}

function Loading() {
  return <p className="text-white/35 text-[12.5px] py-6 text-center">Loading…</p>;
}

function Empty({ what }: { what: string }) {
  return (
    <p className="text-white/35 text-[12.5px] py-6 text-center">
      No {what} listed for this show.
    </p>
  );
}

/** Cour heading. Suppressed when there is only one, since a single-entry show
 *  does not need to be told which season it is looking at. */
function CourHeading({ label, show }: { label: string; show: boolean }) {
  if (!show) return null;
  return (
    <p className="text-white/40 text-[10.5px] font-mono uppercase tracking-[0.18em] mt-5 mb-2 first:mt-0">
      {label}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

function SongsTab({ cours }: { cours: CourRef[] }) {
  const rows = useCourPayloads<AnimeThemes>("songs", cours);
  // Read once per mount and subscribe, matching how every other consumer of a
  // spoiler toggle in the app reacts to a live settings change.
  const [blurRanges, setBlurRanges] = useState(() => loadAuraSettings().blurThemeEpisodeRanges);
  useEffect(() => {
    const sync = () => setBlurRanges(loadAuraSettings().blurThemeEpisodeRanges);
    window.addEventListener("aura:settings-changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("aura:settings-changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // Click-to-reveal latch, keyed per row. Not persisted: revealing a spoiler
  // once should not disarm the setting for the next visit.
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const reveal = useCallback((k: string) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      next.add(k);
      return next;
    });
  }, []);

  if (!rows) return <Loading />;
  const any = rows.some((r) => r.value && (r.value.openings.length || r.value.endings.length));
  if (!any) return <Empty what="theme songs" />;

  const multi = rows.length > 1;
  return (
    <div>
      {rows.map(({ cour, value }) => {
        if (!value || (!value.openings.length && !value.endings.length)) return null;
        return (
          <div key={cour.malId}>
            <CourHeading label={cour.label} show={multi} />
            <div className="flex flex-col gap-1">
              {value.openings.map((t, i) => (
                <ThemeRow
                  key={`op-${cour.malId}-${i}`} kind="op" theme={t}
                  blurRange={blurRanges}
                  revealed={revealed.has(`op-${cour.malId}-${i}`)}
                  onReveal={() => reveal(`op-${cour.malId}-${i}`)}
                />
              ))}
              {value.endings.map((t, i) => (
                <ThemeRow
                  key={`ed-${cour.malId}-${i}`} kind="ed" theme={t}
                  blurRange={blurRanges}
                  revealed={revealed.has(`ed-${cour.malId}-${i}`)}
                  onReveal={() => reveal(`ed-${cour.malId}-${i}`)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ThemeRow({
  kind, theme, blurRange, revealed, onReveal,
}: {
  kind: "op" | "ed";
  theme: AnimeTheme;
  blurRange: boolean;
  revealed: boolean;
  onReveal: () => void;
}) {
  const range = formatSpans(theme.episodes);
  const blurred = range !== null && shouldBlurThemeRange(blurRange, revealed);

  // When the parser could not extract a title, show the source string rather
  // than an empty row. `raw` is retained for exactly this case.
  const hasStructure = theme.title !== null || theme.artist !== null;

  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b border-white/4 last:border-b-0">
      <span className="shrink-0 w-11 text-white/35 text-[11px] font-mono tabular-nums">
        {themeLabel(kind, theme)}
      </span>
      <div className="min-w-0 flex-1">
        {hasStructure ? (
          <p className="text-white/85 text-[13px] leading-snug truncate">
            {theme.title ?? "Unknown title"}
            {theme.artist && (
              <span className="text-white/40"> by {theme.artist}</span>
            )}
          </p>
        ) : (
          <p className="text-white/60 text-[12.5px] leading-snug truncate">{theme.raw}</p>
        )}
      </div>
      {/* No range at all is a legitimate, common state (the source string
          simply carried none). Render nothing rather than inventing one. */}
      {range !== null && (
        blurred ? (
          <button
            type="button"
            onClick={onReveal}
            aria-label="Reveal episode range"
            className="shrink-0 text-white/45 text-[11px] font-mono tabular-nums
                       rounded px-1.5 py-0.5 bg-white/6 hover:bg-white/12 transition-colors"
            style={{ filter: "blur(4px)" }}
            title="Click to reveal"
          >
            {range}
          </button>
        ) : (
          <span className="shrink-0 text-white/40 text-[11px] font-mono tabular-nums">
            {range}
          </span>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ratings histogram
// ---------------------------------------------------------------------------

function RatingsTab({ cours }: { cours: CourRef[] }) {
  const rows = useCourPayloads<AnimeStatistics>("ratings", cours);
  if (!rows) return <Loading />;
  const any = rows.some((r) => r.value);
  if (!any) return <Empty what="score data" />;

  const multi = rows.length > 1;
  return (
    <div>
      {rows.map(({ cour, value }) => {
        if (!value) return null;
        const peak = Math.max(1, ...value.scores.map((b) => b.votes));
        return (
          <div key={cour.malId}>
            <CourHeading label={cour.label} show={multi} />
            <div className="flex flex-col gap-1 mb-4">
              {[...value.scores].sort((a, b) => b.score - a.score).map((b) => (
                <div key={b.score} className="flex items-center gap-2.5">
                  <span className="w-4 shrink-0 text-right text-white/45 text-[11px] font-mono tabular-nums">
                    {b.score}
                  </span>
                  <div className="flex-1 h-3.5 rounded bg-white/6 overflow-hidden">
                    <div
                      className="h-full rounded bg-ln-accent/70"
                      style={{ width: `${(b.votes / peak) * 100}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-white/35 text-[10.5px] font-mono tabular-nums text-right">
                    {b.votes.toLocaleString()} ({b.percentage.toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-x-5 gap-y-1 text-[12px]">
              <StatusRow label="Watching"     value={value.watching} />
              <StatusRow label="Completed"    value={value.completed} />
              <StatusRow label="On hold"      value={value.on_hold} />
              <StatusRow label="Dropped"      value={value.dropped} />
              <StatusRow label="Plan to watch" value={value.plan_to_watch} />
              <StatusRow label="Total"        value={value.total} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-white/45 truncate">{label}</span>
      <span className="text-white/80 font-mono tabular-nums">{value.toLocaleString()}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

function StaffTab({ cours }: { cours: CourRef[] }) {
  const rows = useCourPayloads<StaffCredit[]>("staff", cours);
  if (!rows) return <Loading />;
  const any = rows.some((r) => r.value && r.value.length);
  if (!any) return <Empty what="staff credits" />;

  const multi = rows.length > 1;
  return (
    <div>
      {rows.map(({ cour, value }) => {
        if (!value || !value.length) return null;
        return (
          <div key={cour.malId}>
            <CourHeading label={cour.label} show={multi} />
            <div className="grid grid-cols-2 gap-x-5 gap-y-2.5">
              {value.map((c) => (
                <div key={c.mal_id} className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-full overflow-hidden bg-white/8 shrink-0
                                  flex items-center justify-center">
                    {c.image ? (
                      <ImageLoader
                        src={shrinkPoster(c.image, STAFF_AVATAR_W)}
                        alt=""
                        className="w-full h-full"
                        imgClassName="w-full h-full object-cover"
                        draggable={false}
                      />
                    ) : (
                      <span className="text-white/35 text-[12px] font-medium">
                        {c.name.slice(0, 1)}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-white/85 text-[12.5px] leading-tight truncate">{c.name}</p>
                    <p className="text-white/35 text-[11px] leading-tight truncate">
                      {c.positions.join(", ")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Related
// ---------------------------------------------------------------------------

function RelatedTab({ cours }: { cours: CourRef[] }) {
  const rows = useCourPayloads<Recommendation[]>("related", cours);
  if (!rows) return <Loading />;

  // Merge across cours and re-rank: two cours of the same show recommend
  // largely the same things, and showing each twice is noise.
  const merged = new Map<number, Recommendation>();
  for (const { value } of rows) {
    for (const r of value ?? []) {
      const prev = merged.get(r.mal_id);
      if (!prev || r.votes > prev.votes) merged.set(r.mal_id, r);
    }
  }
  const list = [...merged.values()].sort((a, b) => b.votes - a.votes);
  if (!list.length) return <Empty what="recommendations" />;

  return (
    <div className="grid grid-cols-4 gap-3">
      {list.map((r) => (
        <div key={r.mal_id} className="min-w-0">
          <div className="aspect-[2/3] rounded-lg overflow-hidden bg-white/6 mb-1.5">
            {r.image && (
              <ImageLoader
                src={shrinkPoster(r.image, RELATED_POSTER_W)}
                alt=""
                className="w-full h-full"
                imgClassName="w-full h-full object-cover"
                draggable={false}
              />
            )}
          </div>
          <p className="text-white/80 text-[11.5px] leading-tight line-clamp-2">{r.title}</p>
          <p className="text-white/30 text-[10.5px] mt-0.5">
            {r.votes} {r.votes === 1 ? "rec" : "recs"}
          </p>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trailers
// ---------------------------------------------------------------------------

function TrailersTab({
  cours, onPlay,
}: {
  cours: CourRef[];
  onPlay?: (ytId: string, title: string) => void;
}) {
  const rows = useCourPayloads<AnimeTrailer[]>("trailers", cours);
  if (!rows) return <Loading />;
  const any = rows.some((r) => r.value && r.value.length);
  if (!any) return <Empty what="trailers" />;

  const multi = rows.length > 1;
  return (
    <div>
      {rows.map(({ cour, value }) => {
        if (!value || !value.length) return null;
        return (
          <div key={cour.malId}>
            <CourHeading label={cour.label} show={multi} />
            <div className="grid grid-cols-3 gap-3">
              {value.map((t) => (
                <button
                  key={t.youtube_id}
                  type="button"
                  onClick={() => onPlay?.(t.youtube_id, t.title)}
                  disabled={!onPlay}
                  className="text-left min-w-0 group disabled:cursor-default"
                >
                  <div className="aspect-video rounded-lg overflow-hidden bg-white/6 mb-1.5
                                  group-hover:ring-1 group-hover:ring-white/25 transition-shadow">
                    {t.thumbnail && (
                      <ImageLoader
                        src={shrinkPoster(t.thumbnail, TRAILER_THUMB_W)}
                        alt=""
                        className="w-full h-full"
                        imgClassName="w-full h-full object-cover"
                        draggable={false}
                      />
                    )}
                  </div>
                  <p className="text-white/80 text-[11.5px] leading-tight line-clamp-2">
                    {t.title}
                  </p>
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" />
    </svg>
  );
}
