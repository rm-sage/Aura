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
import { invoke } from "@tauri-apps/api/core";
import ImageLoader from "./ImageLoader";
import { dedupedInvoke } from "./invokeDedupe";
import { shrinkPoster } from "./posterSize";
import { loadAuraSettings } from "./auraSettings";
import { shouldBlurThemeRange } from "./episodeSpoilers";
import {
  fetchExtras, formatSpans, themeLabel,
  type AnimeStatistics, type AnimeTheme, type AnimeThemes, type AnimeTrailer,
  type AnimeCharacter, type AnimeFacts, type AnimeRelation, type CourRef, type Recommendation, type StaffCredit, type ExtrasTab,
} from "./animeExtras";

// Server-resize widths. Every image in here is decorative and small, and the
// upstream assets are not: MAL staff portraits are full-size, and the trailer
// thumbnail chain deliberately prefers YouTube's 1280x720 maxres asset because
// that is the only one guaranteed to exist. Decoded image memory is the app's
// top consumer, so each one is hinted to roughly its rendered width (the
// overlay caps at 56rem, so a 4-up poster grid is ~180px and a 3-up trailer
// grid is ~270px; doubled for high-DPI).
const STAFF_AVATAR_W = 72;
const CHARACTER_ART_W = 300;
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
function CourHeading({ label, show }: { label: string; show: boolean }) {
  if (!show) return null;
  // A label alone was not enough separation: with rows immediately above and
  // below it, each season read as one continuous list with a stray caption in
  // it. The rule gives the break something to land on, and the generous top
  // margin (collapsed on the first) is what actually does the separating.
  return (
    <div className="flex items-center gap-3 mt-7 mb-3 first:mt-0">
      <span className="h-px flex-1 bg-white/10" aria-hidden />
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
  // Filter BEFORE choosing the layout. `rows` has one entry per cour we ASKED
  // about, not per cour MAL answered for, so keying the layout off its length
  // sent a three-cour show with statistics on only one of them down the
  // two-column path: one histogram on the left, an empty column beside it.
  const shown = rows.filter(
    (r): r is { cour: CourRef; value: AnimeStatistics } => r.value != null,
  );
  if (shown.length === 0) return <Empty what="score data" />;

  const one = shown.length === 1;
  return (
    // Two seasons per row rather than one full-width block each. A histogram
    // stretched across the whole panel put its bars and its vote counts an
    // absurd distance apart, and stacking seasons vertically made every one a
    // scroll away from the next.
    //
    // A show with ONE cour is not a one-item grid: left-aligned in a two-column
    // track it sat against the panel's left edge with the whole right half
    // empty, which read as content that had failed to load. It gets a single
    // centred column at the same measure a column of the two-up layout has, so
    // the histogram is the same size either way and only its position differs.
    // The single-cour column is sized as a FRACTION, not a fixed rem value: a
    // two-up column is `(100% - gap) / 2` and therefore tracks the panel, so a
    // fixed cap only matched it at the panel's own 74rem ceiling and was nearly
    // twice a column's width at a 1280px window, which is exactly the spacing
    // the grid exists to avoid. `gap-x-10` is 2.5rem, hence the 1.25rem. Below
    // the 1100px breakpoint the grid is a single full-width column anyway, so
    // this matches it by staying full-width there too.
    <div className={one
      ? "mx-auto w-full min-[1100px]:w-[calc(50%-1.25rem)]"
      : "grid gap-x-10 gap-y-2 grid-cols-1 min-[1100px]:grid-cols-2"}
    >
      {shown.map(({ cour, value }) => {
        const peak = Math.max(1, ...value.scores.map((b) => b.votes));
        return (
          // `mt-0` on every heading: the grid's own row gap does the
          // separating here, so the shared top margin would double it.
          <div key={cour.malId} className="[&>div:first-child]:mt-0">
            {/* ALWAYS headed, unlike the other tabs. A lone histogram rendered
                bare read as a fragment rather than a section, and the label is
                the only thing saying WHAT is being counted. A show that was
                never split into cours has one MAL entry scoring the whole run,
                so "All Cours" is the honest label. A multi-cour show that only
                answered for one keeps that cour's own label, because there the
                numbers really are just that cour's. */}
            <CourHeading label={cours.length > 1 ? cour.label : "All Cours"} show />
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

/** One staff row: a search button when a handler is available, otherwise inert
 *  markup. Keeps the whole row as the hit target rather than just the name. */
function RowTag({ onSearchName, name, className, children }: {
  onSearchName?: (name: string) => void;
  name: string;
  className: string;
  children: React.ReactNode;
}) {
  if (!onSearchName) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      onClick={() => onSearchName(name)}
      title={`Search for "${name}"`}
      className={className + " group/staff cursor-pointer focus:outline-none focus-visible:underline"}
    >
      {children}
    </button>
  );
}

export function StaffTab({ cours, compact = false, onSearchName }: {
  cours: CourRef[];
  compact?: boolean;
  /** Search for this staff member by name. */
  onSearchName?: (name: string) => void;
}) {
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
                // A button when it can search, a plain div otherwise, rather
                // than a permanently disabled control: the whole row is the
                // target so the small avatar is not the only thing to hit.
                <RowTag
                  key={c.mal_id}
                  onSearchName={onSearchName}
                  name={c.name}
                  className="flex items-center gap-2.5 min-w-0 text-left w-full bg-transparent p-0 border-0"
                >
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
                    <p className={"text-[12.5px] leading-tight truncate "
                      + (onSearchName
                        ? "text-white/85 group-hover/staff:text-ln-accent transition-colors"
                        : "text-white/85")}>
                      {c.name}
                    </p>
                    <p className="text-white/35 text-[11px] leading-tight truncate">
                      {c.positions.join(", ")}
                    </p>
                  </div>
                </RowTag>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Facts
//
// Rendered inside Overview rather than as a tab of its own. Everything here
// was already arriving in the cached /anime/{id}/full payload and being thrown
// away, so it costs no request. Scores are deliberately absent: they are chips
// in the identity block and a whole tab besides, and Overview repeating them
// was part of why it read as filler.
// ---------------------------------------------------------------------------

export function FactList({ items }: { items: [string, string][] }) {
  if (!items.length) return null;
  return (
    <dl className="grid gap-x-6 gap-y-2 grid-cols-[auto_1fr]">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-white/35 text-[10px] font-mono uppercase tracking-[0.16em] pt-0.5">
            {k}
          </dt>
          <dd className="text-white/80 text-[12.5px] leading-snug min-w-0">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FactsBlock({ cours, leading = [] }: {
  cours: CourRef[];
  /** Rows prepended before the MAL facts. Genres arrive this way: they come
   *  from the addon, not MAL, but belong in the same list. */
  leading?: [string, string][];
}) {
  // The SERIES-root entry only. A per-cour fact list would repeat "Manga",
  // "Shounen" and the studio three times for a three-season show.
  const rows = useCourPayloads<AnimeFacts>("facts", cours.slice(0, 1));
  const f = rows?.[0]?.value;
  // The leading rows do not depend on the fetch, so they render immediately
  // and stay put when MAL's answer lands underneath them.
  if (!f) return <FactList items={leading} />;

  const items: [string, string][] = [...leading];
  if (f.source)    items.push(["Source", f.source]);
  if (f.status)    items.push(["Status", f.status]);
  if (f.premiered) items.push(["Premiered", f.premiered]);
  if (f.aired)     items.push(["Aired", f.aired]);
  if (f.rating)    items.push(["Rating", f.rating]);
  if (f.demographics.length) items.push(["Demographic", f.demographics.join(", ")]);
  if (f.studios.length)   items.push([f.studios.length > 1 ? "Studios" : "Studio", f.studios.join(", ")]);
  if (f.producers.length) items.push(["Producers", f.producers.slice(0, 6).join(", ")]);
  if (f.licensors.length) items.push(["Licensors", f.licensors.join(", ")]);
  if (f.broadcast)        items.push(["Broadcast", f.broadcast]);
  return <FactList items={items} />;
}

// ---------------------------------------------------------------------------
// Characters
//
// The addon's own cast data is {name, character, photo}: an actor photo and a
// character's NAME, never the character's art. So this tab does not decorate
// the existing cast list, it replaces it with a source that actually has both
// faces, and the card shows the CHARACTER by default because that is who the
// viewer recognises. The actor is one hover away rather than the other way
// round.
// ---------------------------------------------------------------------------

export function CharactersTab({
  cours, blurNames, onSearchName,
}: {
  cours: CourRef[];
  /** Hide character names and art until hovered. Character art routinely
   *  spoils a later form or a reveal, and a name can spoil that someone
   *  exists at all. */
  blurNames: boolean;
  /** Search for the person on the card. The VOICE ACTOR, not the character:
   *  a character name is not a searchable title, and the actor is the thing a
   *  viewer actually wants to look up after recognising a voice. */
  onSearchName?: (name: string) => void;
}) {
  const rows = useCourPayloads<AnimeCharacter[]>("characters", cours);
  if (!rows) return <Loading />;

  // Merged across cours and deduped: a returning character is the same person
  // in season 3 as in season 1, and listing them per season would be mostly
  // repetition. Main-cast ordering from the backend is preserved.
  const seen = new Set<number>();
  const list: AnimeCharacter[] = [];
  for (const { value } of rows) {
    for (const c of value ?? []) {
      if (seen.has(c.mal_id)) continue;
      seen.add(c.mal_id);
      list.push(c);
    }
  }
  if (!list.length) return <Empty what="characters" />;

  return (
    <div className="grid gap-x-4 gap-y-5
                    grid-cols-3 min-[900px]:grid-cols-5
                    min-[1200px]:grid-cols-7 min-[1500px]:grid-cols-8">
      {list.map((c) => (
        <CharacterCard
          key={c.mal_id}
          character={c}
          blurred={blurNames}
          onSearchName={onSearchName}
        />
      ))}
    </div>
  );
}

function CharacterCard({
  character: c, blurred, onSearchName,
}: {
  character: AnimeCharacter;
  blurred: boolean;
  onSearchName?: (name: string) => void;
}) {
  const [hover, setHover] = useState(false);
  const [revealed, setRevealed] = useState(false);

  // ACTOR is the resting state; the character is what hovering reveals. That
  // ordering matters for the spoiler gate: the person is never a spoiler, so
  // the card can always show something at rest, and the blur only ever has to
  // cover the thing that is.
  const showChar = hover && !!c.image;
  const hideChar = blurred && !revealed;

  const restImage = c.actor_image ?? c.image;
  // THE RESTING STATE IS NOT ALWAYS THE ACTOR, and the gate above assumed it
  // was. Both resting slots fall back to the character when the entry has no
  // voice actor: `restImage` falls back to `c.image`, and the name line below
  // falls back to `c.name`. For those entries the tile showed the character's
  // art and the character's name completely unblurred with the toggle on, which
  // is the whole thing the toggle exists to hide - and MAL leaves the actor
  // empty for exactly the characters most likely to be a reveal (an unvoiced
  // late-arrival, a form a character takes later).
  const restIsChar = !c.actor_image && !!c.image;
  const restNameIsChar = !c.actor;
  return (
    <div
      className="min-w-0"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        onClick={() => { if (hideChar) setRevealed(true); }}
        aria-label={hideChar ? `Reveal ${c.actor ?? "character"}'s role` : c.name}
        className="block w-full aspect-[2/3] rounded-lg overflow-hidden
                   bg-white/6 border border-white/8 relative
                   focus-visible:outline focus-visible:outline-2 focus-visible:outline-ln-accent"
      >
        {restImage && (
          <ImageLoader
            src={shrinkPoster(restImage, CHARACTER_ART_W)}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
            imgStyle={{
              opacity: showChar ? 0 : 1,
              transition: "opacity 180ms ease-out",
              // Blurred only when this resting image IS the character art.
              // An actor portrait is never a spoiler and stays sharp.
              ...(hideChar && restIsChar
                ? { filter: "blur(16px)", transform: "scale(1.1)" }
                : null),
            }}
            draggable={false}
          />
        )}
        {/* Character art, cross-faded in on hover. Mounted only once hovered,
            so a 60-card grid does not fetch 60 second images on open. When the
            spoiler toggle is on it still appears, blurred, and a click clears
            it: hiding it entirely would leave no affordance to reveal. */}
        {showChar && c.image && (
          <ImageLoader
            src={shrinkPoster(c.image, CHARACTER_ART_W)}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
            imgStyle={hideChar ? { filter: "blur(16px)", transform: "scale(1.1)" } : undefined}
            draggable={false}
          />
        )}
        {/* The reveal affordance has to cover the actor-less tiles too, or
            their blur would have no way out. */}
        {hideChar && (showChar || restIsChar) && (
          <span className="absolute inset-0 flex items-center justify-center
                           text-white/80 text-[10px] font-mono uppercase
                           tracking-[0.16em] bg-black/35">
            Click to reveal
          </span>
        )}
        {c.role === "Main" && !showChar && (
          <span className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded
                           bg-black/70 text-white/85 text-[9px] font-mono
                           uppercase tracking-[0.14em]">
            Main
          </span>
        )}
      </button>

      {/* Both lines are FIXED: only the image swaps on hover. Swapping the
          text too made every card jump as the cursor crossed it. The actor
          leads because that is the resting state; the character sits under it
          and carries the blur when gated, since the role is the spoiler.
          The actor line is the clickable one: searching a character name finds
          nothing, searching the person finds their other work. */}
      {onSearchName ? (
        <button
          type="button"
          onClick={() => onSearchName(c.actor ?? c.name)}
          title={`Search for "${c.actor ?? c.name}"`}
          // Blurred when this line has fallen back to the CHARACTER name,
          // which is the same spoiler the line below carries when an actor
          // exists. Sharp whenever it is a real person.
          style={hideChar && restNameIsChar ? { filter: "blur(4px)" } : undefined}
          className="block w-full text-left bg-transparent p-0 border-0 cursor-pointer
                     text-white/85 text-[11.5px] leading-tight mt-1.5 line-clamp-2
                     hover:text-ln-accent transition-colors
                     focus:outline-none focus-visible:underline"
        >
          {c.actor ?? c.name}
        </button>
      ) : (
        <p className="text-white/85 text-[11.5px] leading-tight mt-1.5 line-clamp-2"
           style={hideChar && restNameIsChar ? { filter: "blur(4px)" } : undefined}>
          {c.actor ?? c.name}
        </p>
      )}
      {c.actor && (
        <p className="text-white/35 text-[10.5px] leading-tight mt-0.5 truncate"
           style={hideChar ? { filter: "blur(4px)" } : undefined}>
          {c.name}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Related
// ---------------------------------------------------------------------------

/**
 * Posters for relation entries, with bounded retry.
 *
 * The relations payload is {mal_id, type, name} with no artwork, so each entry
 * needs its own lookup. Those miss for two different reasons and only one is
 * worth retrying: the request failed (transient), or MAL genuinely has no
 * image for that id (permanent, and retrying it forever would be a spin).
 *
 * Rust returns only the ids it RESOLVED, so a missing id is ambiguous between
 * the two. The compromise is a small number of attempts with a widening delay,
 * then accept the gap. `pending` marks exactly the tiles still being retried,
 * so a placeholder can distinguish "still working" from "there is no art",
 * which is otherwise indistinguishable to the user.
 */
function useRelationPosters(relations: AnimeRelation[]): {
  posters: Map<number, string>;
  pending: Set<number>;
} {
  const [posters, setPosters] = useState<Map<number, string>>(() => new Map());
  const [pending, setPending] = useState<Set<number>>(() => new Set());
  const key = relations.map((r) => r.mal_id).join(",");

  useEffect(() => {
    if (!key) {
      setPosters(new Map());
      setPending(new Set());
      return;
    }
    let cancelled = false;
    const ids = key.split(",").map(Number);
    // Attempt 0 is the initial fetch, so this allows two retries. The backoff
    // is deliberately short: this is decorative art on a tab already on screen,
    // not something worth a long tail of background work.
    const MAX_ATTEMPTS = 3;
    const DELAYS = [900, 2600];

    const run = async (want: number[], attempt: number): Promise<void> => {
      if (cancelled || want.length === 0) return;
      setPending(new Set(want));
      let got: [number, string][] = [];
      try {
        got = await dedupedInvoke(
          // The attempt is part of the key so a retry is never served the
          // failed call's own in-flight promise.
          `posters:${want.join(",")}:${attempt}`,
          () => invoke<[number, string][]>("fetch_anime_posters", { malIds: want }),
        );
      } catch {
        got = [];
      }
      if (cancelled) return;
      if (got.length) {
        setPosters((prev) => {
          const next = new Map(prev);
          for (const [id, url] of got) next.set(id, url);
          return next;
        });
      }
      const resolved = new Set(got.map(([id]) => id));
      const missing = want.filter((id) => !resolved.has(id));
      if (missing.length === 0 || attempt + 1 >= MAX_ATTEMPTS) {
        setPending(new Set());
        return;
      }
      setPending(new Set(missing));
      await new Promise((r) => setTimeout(r, DELAYS[Math.min(attempt, DELAYS.length - 1)]));
      if (!cancelled) await run(missing, attempt + 1);
    };

    void run(ids, 0);
    return () => { cancelled = true; };
  }, [key]);

  return { posters, pending };
}

export function RelatedTab({ cours, onSearchTitle }: {
  cours: CourRef[];
  /** Run a search for the clicked title. The only thing a tile does now. */
  onSearchTitle?: (name: string) => void;
}) {
  const recRows  = useCourPayloads<Recommendation[]>("related", cours);
  // Relations come from the SERIES ROOT only: every cour of a show lists the
  // same franchise, so per-cour would print the same sequels three times.
  const relRows  = useCourPayloads<AnimeRelation[]>("relations", cours.slice(0, 1));
  const relations = relRows?.[0]?.value ?? [];
  const { posters, pending } = useRelationPosters(relations);
  if (!recRows) return <Loading />;

  // Merged across cours and re-ranked: two cours of one show recommend largely
  // the same titles, and showing each twice is noise.
  const merged = new Map<number, Recommendation>();
  for (const { value } of recRows) {
    for (const r of value ?? []) {
      const prev = merged.get(r.mal_id);
      if (!prev || r.votes > prev.votes) merged.set(r.mal_id, r);
    }
  }
  // A title already listed as a direct relation must not reappear below as a
  // recommendation: it is the same show, and the relation says more about it.
  for (const rel of relations) merged.delete(rel.mal_id);
  const list = [...merged.values()].sort((a, b) => b.votes - a.votes);

  if (!relations.length && !list.length) return <Empty what="related titles" />;

  return (
    <div>
      {relations.length > 0 && (
        <section className="mb-2">
          <CourHeading label="Direct relations" show />
          <div className="grid gap-x-4 gap-y-4
                          grid-cols-3 min-[900px]:grid-cols-5
                          min-[1200px]:grid-cols-7 min-[1500px]:grid-cols-8">
            {relations.map((r) => (
              <OpenableTile
                key={`${r.relation}-${r.mal_id}`}
                malId={r.mal_id}
                name={r.name}
                image={posters.get(r.mal_id) ?? null}
                loadingArt={pending.has(r.mal_id)}
                caption={r.kind ? `${r.relation} · ${r.kind}` : r.relation}
                onSearchTitle={onSearchTitle}
              />
            ))}
          </div>
        </section>
      )}

      {list.length > 0 && (
        <section>
          <CourHeading label="Recommendations" show={relations.length > 0} />
          <div className="grid gap-x-4 gap-y-4
                          grid-cols-3 min-[900px]:grid-cols-5
                          min-[1200px]:grid-cols-7 min-[1500px]:grid-cols-8">
            {list.map((r) => (
              <OpenableTile
                key={r.mal_id}
                malId={r.mal_id}
                name={r.title}
                image={r.image}
                caption={`${r.votes} ${r.votes === 1 ? "rec" : "recs"}`}
                onSearchTitle={onSearchTitle}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * A tile that names another title. Clicking it SEARCHES for that title.
 *
 * It used to resolve the MAL id to a Stremio id through Fribb's reverse map and
 * open that title's detail page in place. That was a large surface for a small
 * feature: the swap had to reset a dozen pieces of page state, a MAL id that
 * Fribb maps to a film opened under the wrong media type and 404'd on every
 * addon, and many MAL ids collapse onto one IMDb id so a relation could
 * silently resolve to the page you were already on. Search reaches the same
 * place through a path that already works everywhere else in the app, and it
 * cannot land the user on a broken page.
 */
function OpenableTile({
  malId, name, image, caption, loadingArt = false, onSearchTitle,
}: {
  malId: number; name: string; image: string | null; caption: string;
  /** This tile's artwork is still being looked up or retried. Distinguishes a
   *  pending lookup from a title that simply has no art, which otherwise look
   *  identical (both are an empty box). */
  loadingArt?: boolean;
  onSearchTitle?: (name: string) => void;
}) {
  void malId;
  return (
    <button
      type="button"
      onClick={onSearchTitle ? () => onSearchTitle(name) : undefined}
      disabled={!onSearchTitle}
      title={onSearchTitle ? `Search for "${name}"` : undefined}
      className="min-w-0 text-left group disabled:cursor-default"
    >
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-white/6 mb-1.5
                      group-hover:ring-1 group-hover:ring-white/25 transition-shadow">
        {image ? (
          <ImageLoader
            src={shrinkPoster(image, RELATED_POSTER_W)}
            alt=""
            className="absolute inset-0 w-full h-full"
            imgClassName="w-full h-full object-cover"
            draggable={false}
          />
        ) : loadingArt ? (
          // Deliberately NOT the global shimmer skeleton: that one animates at
          // full tile brightness and a grid of them reads as a fault. A single
          // small pulsing dot says "working" without shouting.
          <span className="absolute inset-0 flex items-center justify-center" aria-hidden>
            <span className="w-1.5 h-1.5 rounded-full bg-white/40 aura-poster-retry-dot" />
          </span>
        ) : null}
      </div>
      <p className="text-white/80 text-[11.5px] leading-tight line-clamp-2
                    group-hover:text-white transition-colors">{name}</p>
      <p className="text-white/30 text-[10.5px] mt-0.5">{caption}</p>
    </button>
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
