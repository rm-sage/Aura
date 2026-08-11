// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Anime extras — the tab bodies behind the detail page's metadata HUD.
//
// These were originally a centred modal opened from a button, then briefly from
// a drawer rail. Both are gone: the modal's scrim hid the artwork it was
// describing, and a rail plus a HUD meant two routes to secondary content. The
// bodies now render inline inside DetailHud, which is why each grid-heavy tab
// takes a `compact` flag: the HUD is WIDE and SHORT where the modal was narrow
// and tall, so poster and trailer grids become horizontal scrollers there.
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
function CourHeading({ label, show, center = false }: {
  label: string; show: boolean; center?: boolean;
}) {
  if (!show) return null;
  // A label alone was not enough separation: with rows immediately above and
  // below it, each season read as one continuous list with a stray caption in
  // it. The rule gives the break something to land on, and the generous top
  // margin (collapsed on the first) is what actually does the separating.
  return (
    <div className={"flex items-center gap-3 mt-7 mb-3 first:mt-0 "
      + (center ? "justify-center" : "")}>
      {center && <span className="h-px flex-1 bg-white/10" aria-hidden />}
      <span className="text-white/55 text-[10.5px] font-mono uppercase tracking-[0.22em] whitespace-nowrap">
        {label}
      </span>
      <span className="h-px flex-1 bg-white/10" aria-hidden />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

export function SongsTab({ cours }: { cours: CourRef[] }) {
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
            <div className="flex flex-col gap-0.5">
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
    // `w-fit` + `mx-auto`: the row is only as wide as its content and centred
    // in the panel, so the episode range sits immediately after the artist
    // instead of being flung to the far edge of a very wide box.
    <div className="flex items-baseline gap-3 py-1.5 w-fit max-w-full mx-auto">
      <span className="shrink-0 w-9 text-white/35 text-[11px] font-mono tabular-nums text-right">
        {themeLabel(kind, theme)}
      </span>
      <div className="min-w-0">
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
                       rounded px-2 py-0.5 bg-white/8 hover:bg-white/12 transition-colors"
            style={{ filter: "blur(4px)" }}
            title="Click to reveal"
          >
            {range}
          </button>
        ) : (
          <span className="shrink-0 text-white/40 text-[11px] font-mono tabular-nums
                           rounded px-2 py-0.5 bg-white/6">
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

export function RatingsTab({ cours }: { cours: CourRef[] }) {
  const rows = useCourPayloads<AnimeStatistics>("ratings", cours);
  if (!rows) return <Loading />;
  const any = rows.some((r) => r.value);
  if (!any) return <Empty what="score data" />;

  const multi = rows.length > 1;
  return (
    // Two seasons per row rather than one full-width block each. A histogram
    // stretched across the whole panel put its bars and its vote counts an
    // absurd distance apart, and stacking seasons vertically made every one a
    // scroll away from the next.
    <div className="grid gap-x-10 gap-y-2 grid-cols-1 min-[1100px]:grid-cols-2">
      {rows.map(({ cour, value }) => {
        if (!value) return null;
        const peak = Math.max(1, ...value.scores.map((b) => b.votes));
        return (
          // `mt-0` on every heading: the grid's own row gap does the
          // separating here, so the shared top margin would double it.
          <div key={cour.malId} className="[&>div:first-child]:mt-0">
            <CourHeading label={cour.label} show={multi} center />
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
                  <span className="w-[92px] shrink-0 text-white/35 text-[10.5px] font-mono tabular-nums text-right">
                    {b.votes.toLocaleString()} ({b.percentage.toFixed(1)}%)
                  </span>
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
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

export function StaffTab({ cours, compact = false }: { cours: CourRef[]; compact?: boolean }) {
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
            <div className={compact
              ? "grid gap-x-6 gap-y-3 grid-cols-2 min-[1100px]:grid-cols-3 min-[1500px]:grid-cols-4"
              : "grid grid-cols-2 gap-x-5 gap-y-2.5"}>
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

export function RelatedTab({ cours }: { cours: CourRef[] }) {
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
    // Wraps and flows downward with the panel's own scroll. It used to be a
    // horizontal scroller, which meant a wide panel showed ten posters and hid
    // the rest behind a sideways drag while metres of vertical space sat empty.
    <div className="grid gap-x-4 gap-y-4
                    grid-cols-3 min-[900px]:grid-cols-5
                    min-[1200px]:grid-cols-7 min-[1500px]:grid-cols-8">
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

export function TrailersTab({
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
            <div className="grid gap-x-4 gap-y-4
                            grid-cols-2 min-[900px]:grid-cols-4 min-[1300px]:grid-cols-5">
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
