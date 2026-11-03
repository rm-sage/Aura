// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// CatalogHoverCard — Stremio-Kai-style mini-meta panel.
//
// Mounted ONCE as <CatalogHoverHost> (App). Subscribes to catalogHoverStore;
// when a card hover-intent fires it portals a rich info panel beside that
// card: title, release / season / runtime line, brand-coloured rating
// chips, genre tags, plot, director, cast (photo + role). Meta comes from
// the shared 24 h meta cache (getMetaDetailFallback) so repeat hovers are
// instant and cost nothing extra. The panel keeps itself open while
// hovered (cancels the store pending close); the store open delay + close
// leeway handle hover-intent and the card-to-panel cursor gap.
//
// Motion: it fades in at its final place, fades out instead of vanishing
// (the host holds the last panel for the exit), and moving between cards
// glides it there while it keeps the previous card's content up until the
// next card's is ready, then cross-fades. It never collapses to a loading
// box between cards. See the Motion block below.
//
// Placement: see hoverPlacement.ts for the side. A panel with no clear side
// covers other cards, so it lets the pointer through to them unless Alt is
// held or the cursor is already on it (`covers`, below). A panel over free
// space takes the pointer as it always did.
// ---------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, MetaDetail } from "./types";
import { getMetaDetail, getMetaDetailFallback, peekCachedDetailById } from "./metaCache";
import { useEpisodesBehind } from "./LibraryContext";
import { dedupedInvoke } from "./invokeDedupe";
import { BrandLogo, ratingDomain, ratingKindNote, groupRatingsByBrand } from "./logodev";
import { hasUsableRating } from "./ratingValue";
import {
  useHoverTarget,
  cancelHoverClose,
  scheduleHoverClose,
  closeHoverNow,
  refreshHoverAnchor,
  notePanelPointer,
  setHoverFrozen,
  useHoverFrozen,
  type HoverTarget,
} from "./catalogHoverStore";
import { coverOf, pickPanelSide, type Box } from "./hoverPlacement";
import { loadAuraSettings } from "./auraSettings";
import { electMetaAddons } from "./addonElection";
import { computeReleaseCountdowns, formatCountdown, formatTargetDate, isInTheaters, useCountdownNow } from "./releaseCountdown";
import { useMovieReleaseDates } from "./releaseDates";

const PANEL_W = 360;
const GAP = 12;
const PAD = 10;
// Nudge the panel UP off the card's vertical centre so it doesn't sit
// dead-level with the card it overlays — leaves the card's lower half
// clear, making it easier to sweep the cursor back onto the card.
const ANCHOR_Y_NUDGE = -30;
// What to assume when measuring which cards a panel will cover: at that moment
// it may still be a short loading box, and it grows once its content lands.
const TYPICAL_PANEL_H = 420;

/** A merged rating row (addon-supplied OR aggregator). `weight` drives
 *  the same ordering DetailView uses; absent → 50. */
interface RatingRow { source: string; value: string; kind?: string; weight?: number }

// Session cache for the multi-source aggregate (MDBList IMDb/RT/Metacritic
// + MAL/AniList for anime). Hovering re-fires the panel constantly, and
// the upstreams have request budgets, so a card is fetched at most once per
// distinct INPUT.
//
// Keyed on the ids the answer was computed from, NOT on meta.id alone. That
// distinction is the bug fix: keying on meta.id let the very first fire (which
// happens before the meta detail has landed, so it carries no mal/kitsu/anidb
// id and the backend falls through to a title search) permanently pin a
// franchise-root MAL entry for the whole session. The effect that re-runs once
// the real ids arrive was blocked by the cache it had just poisoned, so the
// hover disagreed with the detail page for as long as the app stayed open.
const aggRatingsCache = new Map<string, RatingRow[]>();

/** Cache / dedupe key. Carries the id material the answer depends on so a
 *  better-resolved later fire writes a NEW entry instead of reading the
 *  earlier, worse one. */
function ratingsKey(
  metaId: string,
  isAnime: boolean,
  ids: { mal?: number | null; kitsu?: number | null; anidb?: number | null },
): string {
  return [
    metaId,
    isAnime ? "anime" : "std",
    ids.mal ?? "",
    ids.kitsu ?? "",
    ids.anidb ?? "",
  ].join("|");
}

interface RatingChipStyle { bg: string; border: string; fg: string; }

// Compact brand palette — mirrors DetailView RATING_PALETTE keys so the
// two surfaces read consistently. Short labels (IMDb / RT / MC / MAL)
// save the horizontal space full source names would eat. Drop-in logo
// icons can replace the label later (see chipKeyLabel).
const RATING_STYLES: Record<string, RatingChipStyle> = {
  imdb:       { bg: "bg-amber-400/15",  border: "border-amber-300/40",  fg: "text-amber-100" },
  rt:         { bg: "bg-red-500/15",    border: "border-red-400/40",    fg: "text-red-100" },
  metacritic: { bg: "bg-teal-500/15",   border: "border-teal-300/40",   fg: "text-teal-100" },
  mal:        { bg: "bg-indigo-500/18", border: "border-indigo-300/40", fg: "text-indigo-50" },
  tmdb:       { bg: "bg-emerald-500/15",border: "border-emerald-300/40",fg: "text-emerald-100" },
  anilist:    { bg: "bg-sky-500/15",    border: "border-sky-300/40",    fg: "text-sky-100" },
  kitsu:      { bg: "bg-orange-500/15", border: "border-orange-300/40", fg: "text-orange-100" },
};
const NEUTRAL_CHIP: RatingChipStyle = {
  bg: "bg-white/8", border: "border-white/15", fg: "text-white/90",
};

/** Normalise a rating source name -> palette key + short label. */
function chipKeyLabel(source: string): { key: string; label: string } {
  const s = source.toLowerCase();
  if (s.includes("imdb")) return { key: "imdb", label: "IMDb" };
  if (s.includes("rotten") || s === "rt") return { key: "rt", label: "RT" };
  if (s.includes("metacritic") || s.includes("metascore")) return { key: "metacritic", label: "MC" };
  if (s.includes("myanimelist") || s.includes("mal")) return { key: "mal", label: "MAL" };
  if (s.includes("tmdb") || s.includes("the movie")) return { key: "tmdb", label: "TMDB" };
  if (s.includes("anilist")) return { key: "anilist", label: "AniList" };
  if (s.includes("kitsu")) return { key: "kitsu", label: "Kitsu" };
  return { key: "_", label: source.toUpperCase().slice(0, 6) };
}

function RatingChip({ source, value, kind }: { source: string; value: string; kind?: string }) {
  const { key, label } = chipKeyLabel(source);
  const st = RATING_STYLES[key] ?? NEUTRAL_CHIP;
  return (
    <span
      title={source + ratingKindNote(source, kind)}
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md border ${st.bg} ${st.border}`}
    >
      <BrandLogo
        domain={ratingDomain(source)}
        alt={label}
        size={48}
        className="h-3.5 w-auto max-w-[54px] object-contain"
        fallback={
          <span className={`text-[10px] font-bold tracking-wide opacity-80 ${st.fg}`}>
            {label}
          </span>
        }
      />
      <span className={`text-[12px] font-semibold tabular-nums ${st.fg}`}>{value}</span>
    </span>
  );
}

/** Round neutral avatar fallback when a photo is missing / fails. */
function Avatar({ src, alt }: { src: string | null; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      <img
        src={src}
        alt={alt}
        draggable={false}
        onError={() => setFailed(true)}
        className="w-9 h-9 rounded-full object-cover bg-white/5 flex-shrink-0"
      />
    );
  }
  return (
    <span
      aria-hidden
      className="w-9 h-9 rounded-full bg-white/8 flex items-center justify-center flex-shrink-0 text-white/25"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0 2c-5 0-9 2.5-9 6v2h18v-2c0-3.5-4-6-9-6z" />
      </svg>
    </span>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-white/40 text-[10px] font-mono font-semibold uppercase tracking-[0.18em] mt-3 mb-1.5">
      {children}
    </p>
  );
}

/** Live, self-ticking release-countdown chip. Owns its own 1 s tick so only
 *  this node re-renders each second, not the whole hover panel (cast grid,
 *  ratings, etc.). */
function HoverCountdownChip({ label, targetMs, estimated }: { label: string; targetMs: number; estimated?: boolean }) {
  const now = useCountdownNow();
  return (
    <span
      title={estimated ? `${formatTargetDate(targetMs)} (estimated)` : formatTargetDate(targetMs)}
      className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-ln-accent"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {/* "~" marks the PVOD-window estimate vs an authoritative MDBList date. */}
      {label} in {estimated ? "~" : ""}{formatCountdown(targetMs, now)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Motion. Everything below animates opacity / transform (compositor work),
// except the panel's height, which is one fixed-position box whose children
// are not sized by it, so a height step relayouts nothing else on the page.
// No per-frame React state: transitions and the Web Animations API run it.
// ---------------------------------------------------------------------------

/** Fade + settle on open. */
const ENTER_MS = 170;
/** Fade out on close. The host keeps the last panel mounted this long. */
const EXIT_MS = 150;
/** Glide between cards, and the height change that comes with new content. */
const GLIDE_MS = 190;
/** Fade the new card's content in once it is ready. Long enough that the
 *  climb from the held dim (HELD_OPACITY) reads as a cross-fade, not a pop. */
const SWAP_MS = 220;
const EASE_OUT = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
/** How far the panel sits toward its card (and how much smaller) while it
 *  fades in or out, so it reads as coming from the card. */
const ENTER_SHIFT_PX = 6;
const ENTER_SCALE = 0.98;
/** On a switch, the previous card's content stays up (dimmed) while the
 *  next one's meta loads, and the next card's ratings get this long to land
 *  too, so the panel swaps once with the chip row in place instead of
 *  swapping and then growing a row. A rating answer slower than this simply
 *  arrives into the already-swapped panel. */
const RATINGS_GRACE_MS = 250;
/** First open of a title whose meta is already cached: hold the panel
 *  invisible this long at most for the elected fetch to answer, so it
 *  appears with its content instead of as a spinner box that then grows.
 *  A hit answers within a task; this only bounds a slow one. */
const REVEAL_HOLD_MS = 180;
/** A dim or loading badge shown for less than this reads as a flicker, and a
 *  cache-hit switch finishes well inside it, so both wait this long. */
const DIM_DELAY_MS = 120;
/** The held (previous card's) content while the next one loads. At the old
 *  0.45 it still read as the hovered card's info (user feedback): this low,
 *  plus washed out and softened, it reads as a placeholder for the size of
 *  the panel, and the "Loading <name>" badge over it says what is coming.
 *  The filter is a static, one-surface effect (it only costs anything while
 *  it transitions) and is skipped entirely under reduced motion. */
const HELD_OPACITY = 0.18;
const HELD_FILTER = "saturate(0.35) blur(1.5px)";
const DIM_FADE_MS = 180;
/** The longest the previous card's content is held beside a card whose meta
 *  has not landed. Past this the fetch is slow or failing (each provider can
 *  take its 10 s timeout, per type), so the panel shows the hovered card's
 *  own title with a spinner instead, at the held height. It was 1 s while the
 *  held content was only lightly dimmed, because another show's title beside
 *  the hovered card then read as wrong; with the content washed out under a
 *  badge naming the hovered card it reads as loading, so it may stay longer
 *  and a merely slow provider no longer costs an extra swap. */
const HOLD_CAP_MS = 2500;
/** A cache-hit switch never dimmed, so its content only eases in lightly
 *  from here: a dip to the dim level would read as a blink. */
const QUICK_SWAP_FROM = 0.85;
const QUICK_SWAP_MS = 120;

function reducedMotion(): boolean {
  return document.documentElement.getAttribute("data-reduced-motion") === "true";
}

/** Which side of its card the panel sits on: decides where it fades in from. */
type PanelSide = "right" | "left" | "center";

function hiddenTransform(side: PanelSide): string {
  // "Toward the card": a panel right of its card starts nudged left, etc.
  if (side === "right") return `translateX(${-ENTER_SHIFT_PX}px) scale(${ENTER_SCALE})`;
  if (side === "left") return `translateX(${ENTER_SHIFT_PX}px) scale(${ENTER_SCALE})`;
  return `translateY(${ENTER_SHIFT_PX}px) scale(${ENTER_SCALE})`;
}

function originFor(side: PanelSide): string {
  if (side === "right") return "left center";
  if (side === "left") return "right center";
  return "center top";
}

/** What the panel is SHOWING, which on a switch is the previous card's until
 *  the next one is ready. Content is rendered only from this, never from a
 *  mix of the live card and the last card's detail. */
interface ShownContent {
  meta: MetaPreview;
  detail: MetaDetail | null;
  aggRatings: RatingRow[];
}

/** The panel's spinner glyph. `spinning` is off while its badge is faded out,
 *  so nothing keeps animating on an invisible layer. */
function Spinner({ className, spinning = true }: { className: string; spinning?: boolean }) {
  return (
    <svg className={`${spinning ? "animate-spin " : ""}${className}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** The panel's top for a card, clamped into the viewport. */
function panelTopFor(rect: DOMRect, h: number, vh: number): number {
  let top = rect.top + rect.height / 2 - h / 2 + ANCHOR_Y_NUDGE;
  if (top + h + PAD > vh) top = vh - h - PAD;
  if (top < PAD) top = PAD;
  return top;
}

/** Is this card what is really on top at the middle of its visible part? A card
 *  under a modal, or clipped out of its row, is not one the panel can block. The
 *  panel itself is looked through: it may be sitting on the card right now. */
function cardIsReachable(card: HTMLElement, r: DOMRect): boolean {
  const x = (Math.max(r.left, 0) + Math.min(r.right, window.innerWidth)) / 2;
  const y = (Math.max(r.top, 0) + Math.min(r.bottom, window.innerHeight)) / 2;
  for (const el of document.elementsFromPoint(x, y)) {
    if (el.closest("[data-hover-panel], [data-perf-monitor]")) continue;
    return el.closest("[data-hover-card]") === card;
  }
  return false;
}

/** The side for this card, and whether the panel will cover other cards there.
 *  Runs once per card (a query plus a few rect reads), not per frame. */
function measurePlacement(
  target: HoverTarget, h: number, vw: number, vh: number, prevSide: PanelSide | null,
): { side: "left" | "right"; covers: boolean } {
  const { rect, el } = target;
  const leftAt = rect.left - GAP - PANEL_W;
  const rightAt = rect.right + GAP;
  const fitsLeft = leftAt >= PAD;
  const fitsRight = rightAt + PANEL_W + PAD <= vw;
  const assumedH = Math.min(Math.max(h, TYPICAL_PANEL_H), vh - 2 * PAD);
  const top = panelTopFor(rect, assumedH, vh);

  const others: { el: HTMLElement; r: DOMRect }[] = [];
  for (const c of document.querySelectorAll<HTMLElement>("[data-hover-card]")) {
    if (c !== el && !c.contains(el) && !el.contains(c)) others.push({ el: c, r: c.getBoundingClientRect() });
  }
  const reachable = new Map<HTMLElement, boolean>();
  const coverAt = (left: number): number => {
    const panel: Box = { left, top, right: left + PANEL_W, bottom: top + assumedH };
    let sum = 0;
    for (const o of others) {
      const f = coverOf(panel, o.r);
      if (f === 0) continue;
      let ok = reachable.get(o.el);
      if (ok === undefined) { ok = cardIsReachable(o.el, o.r); reachable.set(o.el, ok); }
      if (ok) sum += f;
    }
    return sum;
  };
  const coverLeft = fitsLeft ? coverAt(leftAt) : 0;
  const coverRight = fitsRight ? coverAt(rightAt) : 0;
  const side = pickPanelSide({
    fitsLeft, fitsRight, coverLeft, coverRight, card: rect, entry: target.entry ?? null, prevSide,
  });
  // Fitting neither way centres the panel, over the hovered card itself.
  const covers = !fitsLeft && !fitsRight ? true : (side === "left" ? coverLeft : coverRight) > 0;
  // Only a hover has a pointer to let through: the other modes open on an
  // explicit press and close on an explicit dismiss.
  return { side, covers: covers && loadAuraSettings().metaPanelActivation === "hover" };
}

function HoverPanel({
  target, exiting, addons, onSelectMeta,
}: {
  target: HoverTarget;
  /** The store has closed; the host keeps this copy up for EXIT_MS so it
   *  fades out instead of vanishing. It takes no pointer input meanwhile. */
  exiting: boolean;
  addons: AddonEntry[];
  onSelectMeta?: (m: MetaPreview) => void;
}) {
  const { meta, rect } = target;
  const panelRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLParagraphElement>(null);

  // The meta detail and WHICH meta.id it belongs to, set together. The ratings
  // effect gates on `for` rather than on a loading flag, because both effects
  // re-run in the same pass when the hovered card changes and a flag would
  // still hold the PREVIOUS card's value at that moment. Gating on it would
  // fire a request pairing the new card's imdb id with the old card's anime
  // ids. `real` is false when no fetch was possible (no addons): that answer
  // settles the panel but must not open the anime ratings gate, which would
  // then search by title alone.
  //
  // It is deliberately NOT cleared when the card changes: the panel keeps
  // showing the previous card (see `shown`) until the next one is ready, so
  // it never collapses to a spinner box between two cards.
  const [fetched, setFetched] = useState<{ for: string; detail: MetaDetail | null; real: boolean } | null>(null);
  const landed = fetched?.for === meta.id;
  const detailReady = landed && fetched.real;
  const liveDetail = landed ? fetched.detail : null;

  // Fetch the meta detail (cached). Goes FIRST to the lead meta provider
  // only: fan-out across every installed addon would pull search-only
  // addons (e.g. AISearch) into the meta path, where they return empty
  // "?" stubs and waste a network round-trip on every hover.
  //
  // Alt-type fallback mirrors the CW card: anime catalogs often tag
  // content as series/movie with an anime-prefixed id, so the first
  // lookup against the lead provider can miss.
  useEffect(() => {
    let cancelled = false;
    const id = meta.id;
    (async () => {
      // The SAME election DetailView makes (its metaCandidates memo), by
      // construction rather than by copy: both call electMetaAddons with the
      // same addons, type and id. When the two used to disagree, a user
      // pinned to Cinemeta got a hover detail with no mal/kitsu/anidb ids at
      // all and a detail page with them, so the same show showed two
      // different MAL scores. The surfaces must elect the same provider or
      // they cannot agree.
      if (addons.length === 0) {
        setFetched({ for: id, detail: null, real: false });
        return;
      }
      const provider = electMetaAddons(addons, meta.media_type, id)[0] ?? null;
      const alt = meta.media_type === "series" ? "anime"
        : meta.media_type === "anime" ? "series" : null;
      let d: MetaDetail | null = null;
      // No lead for this type is not the end: the alt-type walk below can
      // still elect one (an addon that only declares `anime` for a card
      // tagged `series`).
      if (provider) {
        d = await getMetaDetail(provider, meta.media_type, id);
        if (!d && alt) d = await getMetaDetail(provider, alt, id);
      }
      // Fall back down the rest of the elected list (mirrors the detail page)
      // when the lead provider has nothing for this item: fixes hover meta
      // missing for items only another addon serves.
      if (!d) d = await getMetaDetailFallback(addons, meta.media_type, id);
      if (!d && alt) d = await getMetaDetailFallback(addons, alt, id);
      if (cancelled) return;
      setFetched({ for: id, detail: d, real: true });
    })();
    return () => { cancelled = true; };
  }, [meta.id, meta.media_type, addons]);

  // Multi-source rating enrichment — the SAME free aggregator the
  // detail page uses (MDBList: IMDb / RT / Metacritic / TMDB / Trakt /
  // Letterboxd; + MAL/AniList for anime). The addon's own
  // `detail.ratings` is usually just IMDb, which is why the hover card
  // looked bare. Session-cached per id so repeat hovers don't burn the
  // upstream request budgets; dedupe shares one
  // in-flight call across rapid re-hovers.
  //
  // Tagged with the card it belongs to (`HoverPanel` has no React key and
  // `catalogHoverStore` flips the active card A -> B without a null in
  // between, so this component is reused rather than remounted), and `done`
  // once this card's answer is in (or there is nothing to ask), which is what
  // lets a switch wait for the chip row instead of growing it afterwards.
  const [agg, setAgg] = useState<{ metaId: string | null; list: RatingRow[]; done: boolean }>(
    { metaId: null, list: [], done: false },
  );
  const ratingsDetail = detailReady ? liveDetail : null;
  // The key whose answer `agg` already holds. The effect re-runs when the
  // detail lands; for a non-anime card the key is usually unchanged then, and
  // re-asking would only repeat the call (an empty answer is never cached)
  // and briefly mark the row unanswered again.
  // Scoped to the card it was answered for: back on a card after another one
  // (A, B, A), `agg` holds B's state, so A must be asked (or read from the
  // cache) again rather than skipped.
  const answeredKeyRef = useRef<{ metaId: string; key: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const id = meta.id;
    if (answeredKeyRef.current?.metaId !== id) answeredKeyRef.current = null;
    // Only THIS card's detail. The state may still hold the previous card's
    // for a moment, and its anime ids must never pair with this card's id.
    const d = ratingsDetail;
    // `isAnime` is true from the SURFACE alone (media_type or id prefix), so
    // it arms before `detail` has resolved and therefore before any anime id
    // is known. That is exactly the state we must not fetch in.
    const isAnime =
      meta.media_type === "anime" ||
      /^(kitsu|mal|anidb|anilist):/.test(id) ||
      !!(d?.mal_id || d?.kitsu_id || d?.anidb_id);
    // A list already fetched for this card stays up while a better-resolved
    // key is asked; another card's never does.
    const keep = (prev: { metaId: string | null; list: RatingRow[] }) =>
      prev.metaId === id ? prev.list : [];

    // Wait for the meta detail on anime, and specifically for THIS card's.
    // Fetching sooner would send all-null anime ids, and the backend's
    // last-resort title search elects the franchise-root MAL entry (it needs
    // an exact title match, which a "... Season 2" cour cannot satisfy while
    // the base-titled original can). Gating here removes the wrong request
    // rather than correcting it afterwards, and saves one MAL search per
    // hover.
    //
    // A tt-keyed anime only reads as anime once its detail lands. When a cached
    // detail says it will, a request now would be a std call the anime key
    // replaces at once, so wait for it too. The peek only decides to wait (it
    // can be another addon's detail): the ids always come from the elected one.
    const peeked = !isAnime && !landed ? peekCachedDetailById(id) : null;
    const animeIdsComing = !!(peeked?.mal_id || peeked?.kitsu_id || peeked?.anidb_id);
    if ((isAnime && !detailReady) || animeIdsComing) {
      setAgg((prev) => ({ metaId: id, list: keep(prev), done: false }));
      return;
    }

    const ids = {
      mal:   d?.mal_id   ?? null,
      kitsu: d?.kitsu_id ?? null,
      anidb: d?.anidb_id ?? null,
    };
    const key = ratingsKey(id, isAnime, ids);
    // The key carries the meta id, so a match is this card's own answer.
    if (answeredKeyRef.current?.key === key) return;

    const cached = aggRatingsCache.get(key);
    if (cached) {
      answeredKeyRef.current = { metaId: id, key };
      setAgg({ metaId: id, list: cached, done: true });
      return;
    }

    const input = {
      imdb_id:    id.startsWith("tt") ? id : null,
      mal_id:     ids.mal,
      kitsu_id:   ids.kitsu,
      anilist_id: null,
      anidb_id:   ids.anidb,
      title:      meta.name,
      year:       meta.release_info ? Number(meta.release_info.slice(0, 4)) || null : null,
      is_anime:   isAnime,
    };
    // Nothing resolvable → skip the round-trip entirely.
    if (!input.imdb_id && !isAnime) {
      setAgg({ metaId: id, list: [], done: true });
      return;
    }
    setAgg((prev) => ({ metaId: id, list: keep(prev), done: false }));
    // The dedupe key must carry the same id material as the cache key.
    // `dedupedInvoke` coalesces on key, so a key without ids would hand a
    // corrected second call the stale first call's promise.
    dedupedInvoke(key, () => invoke<RatingRow[]>("fetch_aggregate_ratings", { input }))
      .then((r) => {
        const list = Array.isArray(r) ? r : [];
        // Kept even when this listener has gone (the card was left, or a better
        // key took over): dropping it re-asks the upstream on every revisit.
        // Do NOT cache an empty result. `[]` is truthy, so caching it used to
        // pin "no ratings" on the card for the rest of the session even after
        // the ids that would have resolved them arrived.
        if (list.length > 0) {
          // Bounded LRU (~400): this session cache was previously uncapped, so
          // a long browse across hundreds of cards grew it monotonically.
          // Rating arrays are small, so 400 covers a heavy session well under
          // ~200KB.
          if (aggRatingsCache.size >= 400 && !aggRatingsCache.has(key)) {
            const oldest = aggRatingsCache.keys().next().value;
            if (oldest !== undefined) aggRatingsCache.delete(oldest);
          }
          aggRatingsCache.set(key, list);
        }
        if (cancelled) return;
        answeredKeyRef.current = { metaId: id, key };
        setAgg({ metaId: id, list, done: true });
      })
      .catch(() => {
        // A failed lookup is an answer too: without `done` a switch would
        // sit on the previous card for the whole grace.
        if (!cancelled) setAgg((prev) => ({ metaId: id, list: keep(prev), done: true }));
      });
    return () => { cancelled = true; };
  }, [meta.id, meta.media_type, meta.name, meta.release_info, landed, detailReady,
      ratingsDetail?.mal_id, ratingsDetail?.kitsu_id, ratingsDetail?.anidb_id]);

  // The switch timers (the ratings grace, the hold cap), scoped to ONE visit
  // of a card and reset during render the moment the card changes. An id
  // alone is not enough: on A, B, A the grace that ran out on the first visit
  // to A would still read as run out on the return, before A's ratings effect
  // has replaced B's `agg`, and settle A without its chip row. Reset in
  // render, not in an effect, because that render already reads them.
  const [timers, setTimers] = useState<{ card: string; graceOver: boolean; holdOver: boolean }>(
    () => ({ card: meta.id, graceOver: false, holdOver: false }),
  );
  if (timers.card !== meta.id) {
    setTimers({ card: meta.id, graceOver: false, holdOver: false });
  }
  const timersLive = timers.card === meta.id;
  const graceOver = timersLive && timers.graceOver;
  const holdOver = timersLive && timers.holdOver;

  // The ratings grace, counted from the moment this card's detail landed.
  useEffect(() => {
    if (!landed) return;
    const id = meta.id;
    const t = window.setTimeout(
      () => setTimers((s) => (s.card === id ? { ...s, graceOver: true } : s)),
      RATINGS_GRACE_MS,
    );
    return () => window.clearTimeout(t);
  }, [meta.id, landed]);

  // What to SHOW. The live card's content once it is ready, otherwise the
  // last content shown (the previous card's, dimmed: `pending`). The first
  // open has nothing to hold, so it does not wait for ratings; they arrive
  // into the open panel. Derived during render from a ref so the swap
  // happens in the same commit as the data, never a frame later.
  const lastShownRef = useRef<ShownContent | null>(null);
  // The content's height at the last placement while it showed a card, and
  // the height the cap's title + spinner fallback keeps once the cap dropped
  // that content, so hitting the cap does not shrink the panel either. The
  // held height is NOT tied to the card the cap fired on: with a slow
  // provider the user moves on before that card lands, and a hold keyed to
  // it let every later card's fallback collapse the panel to a title and a
  // spinner. It lasts until a card settles (or the panel unmounts).
  const lastContentHRef = useRef(0);
  const capHeldRef = useRef<number | null>(null);
  const ratingsDone = agg.metaId === meta.id && agg.done;
  // Only a TRUE first open skips the ratings wait. After the cap the panel
  // is already up at its held height, so the 250 ms grace costs nothing and
  // keeps the card from landing and then growing again when its chips come.
  const settled = landed
    && (ratingsDone || graceOver || (lastShownRef.current == null && capHeldRef.current == null));
  if (settled) {
    capHeldRef.current = null;
    const prevShown = lastShownRef.current;
    lastShownRef.current = {
      meta,
      detail: liveDetail,
      // `agg` can lag a render behind the card; this card's own chips, if
      // already on screen, stay rather than blinking out for that render.
      aggRatings: agg.metaId === meta.id ? agg.list
        : prevShown?.meta.id === meta.id ? prevShown.aggRatings : [],
    };
  } else if (!landed && holdOver) {
    // Held past the cap: drop the other card's content. With nothing held,
    // the panel shows this card's title and a spinner, and its detail then
    // settles as on a first open (no ratings wait).
    if (lastShownRef.current != null) {
      capHeldRef.current = lastContentHRef.current;
    }
    lastShownRef.current = null;
  }
  const shown = lastShownRef.current;
  const pending = shown != null && shown.meta.id !== meta.id;
  const capMinH = shown == null && capHeldRef.current != null ? capHeldRef.current : 0;
  // The loading badge names the card being loaded, and keeps that name while
  // it fades out after the swap rather than blanking mid-fade.
  const loadingLabelRef = useRef(meta.name);
  if (pending) loadingLabelRef.current = meta.name;

  // The hold cap, counted from the switch (a further switch re-arms it).
  useEffect(() => {
    if (landed || !pending) return;
    const id = meta.id;
    const t = window.setTimeout(
      () => setTimers((s) => (s.card === id ? { ...s, holdOver: true } : s)),
      HOLD_CAP_MS,
    );
    return () => window.clearTimeout(t);
  }, [meta.id, landed, pending]);

  // First open of a title the meta cache already holds: stay invisible until
  // the elected fetch answers (bounded by REVEAL_HOLD_MS). The peek is only a
  // HINT that it will answer at once; what is shown always comes from the
  // elected fetch above, never from whichever addon the peek found.
  const [revealHold, setRevealHold] = useState(() => peekCachedDetailById(target.meta.id) != null);
  useEffect(() => {
    if (!revealHold) return;
    const t = window.setTimeout(() => setRevealHold(false), REVEAL_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [revealHold]);

  // Placement: beside the card on the side measurePlacement picked (kept for
  // as long as the panel stays on this card, unless it stops fitting), clamped
  // vertically into the viewport using the panel's FINAL height (the one its
  // height is animating to).
  //
  // `animate` says whether this move glides: a switch to another card and a
  // height change from new content do; the first placement does not (the
  // panel must appear where it belongs, never slide in from 0,0 or from a
  // stale card), and neither does a scroll / resize re-anchor to the SAME
  // card (the panel is glued to the card; a glide would trail behind it).
  const [pos, setPos] = useState<{
    left: number; top: number; h: number; side: PanelSide; covers: boolean; ready: boolean; animate: boolean;
  }>({ left: 0, top: 0, h: 0, side: "right", covers: false, ready: false, animate: false });
  const placedElRef = useRef<HTMLElement | null>(null);
  const pickRef = useRef<{
    el: HTMLElement; id: string; vw: number; side: "left" | "right"; covers: boolean;
  } | null>(null);
  // Set beside the store's notePanelPointer. Once on the panel the cursor keeps
  // it, so Alt can be let go to read or scroll it.
  const [pointerInside, setPointerInside] = useState(false);
  const frozen = useHoverFrozen();
  const panelAnimRef = useRef<Animation | null>(null);

  // Content height changes that arrive without a render of this component
  // (a countdown chip's text, a font swap) still need the box re-measured.
  // Bumps a counter at most once per resize; never per frame.
  const [, remeasure] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => remeasure());
    ro.observe(sc);
    return () => ro.disconnect();
  }, []);

  // Runs after every render and sets state only when something moved, so it
  // cannot loop. One forced layout read per render of this panel, which
  // happens a handful of times per hover.
  useLayoutEffect(() => {
    if (exiting) return;
    const panel = panelRef.current;
    const sc = scrollRef.current;
    if (!panel || !sc) return;
    if (!pos.ready && revealHold && shown == null) return;
    // The scroller's own height (capped at 80vh) plus the panel's borders:
    // the panel's height is set explicitly, so measure what it should be.
    const baseH = sc.offsetHeight + (panel.offsetHeight - panel.clientHeight);
    // Layout is already fresh from the read above, so this costs nothing.
    if (shown != null && contentRef.current) lastContentHRef.current = contentRef.current.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let pick = pickRef.current;
    if (!pick || pick.el !== target.el || pick.id !== meta.id || pick.vw !== vw) {
      pick = {
        el: target.el, id: meta.id, vw,
        ...measurePlacement(target, baseH, vw, vh, pos.ready ? pos.side : null),
      };
      pickRef.current = pick;
    }
    const covers = pick.covers;
    // The hint counts from the pass that picks it, before it joins the flow: a
    // height that grew one commit later would glide a first placement.
    const h = baseH + (covers && hintRef.current ? hintRef.current.offsetHeight : 0);
    const leftAt = rect.left - GAP - PANEL_W;
    const rightAt = rect.right + GAP;
    const leftFits = leftAt >= PAD;
    const rightFits = rightAt + PANEL_W + PAD <= vw;
    // The pick still has to fit now: a scroll can carry the card toward an edge.
    let side: PanelSide = pick.side;
    if (side === "left" && !leftFits) side = "right";
    if (side === "right" && !rightFits) side = leftFits ? "left" : "center";
    let left = side === "left" ? leftAt
      : side === "right" ? rightAt
      : Math.max(PAD, (vw - PANEL_W) / 2);
    let top = panelTopFor(rect, h, vh);
    // Whole pixels: a fractional translate blurs the panel's text.
    left = Math.round(left);
    top = Math.round(top);
    const sameEl = placedElRef.current === target.el;
    if (pos.ready && sameEl && left === pos.left && top === pos.top && h === pos.h && covers === pos.covers) return;
    const first = !pos.ready;
    const reanchorOnly = sameEl && h === pos.h;
    placedElRef.current = target.el;
    setPos({ left, top, h, side, covers, ready: true, animate: !first && !reanchorOnly && !reducedMotion() });
    if (first && !reducedMotion()) {
      panelAnimRef.current?.cancel();
      panelAnimRef.current = panel.animate(
        [{ opacity: 0, transform: hiddenTransform(side) }, { opacity: 1, transform: "none" }],
        { duration: ENTER_MS, easing: EASE_OUT },
      );
    }
  });

  // Close and re-open. The exit fades from wherever the panel is now (it may
  // still be entering), and a re-open inside the exit turns it back from
  // there, so neither ever jumps. `fill: forwards` holds the faded state
  // until the host unmounts the copy.
  const wasExitingRef = useRef(false);
  useLayoutEffect(() => {
    if (exiting === wasExitingRef.current) return;
    wasExitingRef.current = exiting;
    // The cursor may be on the panel as it goes (a click on Open details,
    // Esc); the store must not keep believing it is, or scroll re-anchoring
    // would stay off for the next panel.
    if (exiting) { notePanelPointer(false); setPointerInside(false); }
    const panel = panelRef.current;
    if (!panel) return;
    if (reducedMotion()) { panelAnimRef.current?.cancel(); return; }
    const cs = getComputedStyle(panel);
    const from = { opacity: cs.opacity, transform: cs.transform };
    panelAnimRef.current?.cancel();
    panelAnimRef.current = exiting
      ? panel.animate(
        [from, { opacity: 0, transform: hiddenTransform(pos.side) }],
        { duration: EXIT_MS, easing: EASE_IN, fill: "forwards" },
      )
      : panel.animate(
        [from, { opacity: 1, transform: "none" }],
        { duration: ENTER_MS, easing: EASE_OUT },
      );
  }, [exiting, pos.side]);

  useEffect(() => () => notePanelPointer(false), []);

  // The content swap: back to the top of the new card, and its content fades
  // in from where the dim left it (HELD_OPACITY, or wherever the dim's own
  // fade had reached), so a slow switch reads as a cross-fade rather than a
  // cut, while the held filter eases off on its CSS transition and the
  // loading badge fades out over it. A cache hit that never dimmed swaps
  // directly with only a short, shallow ease: dipping it to the dim level
  // first was a blink.
  const shownId = shown?.meta.id ?? null;
  const prevShownIdRef = useRef<string | null | undefined>(undefined);
  const contentAnimRef = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const prev = prevShownIdRef.current;
    prevShownIdRef.current = shownId;
    if (prev === undefined || prev === shownId) return;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    const c = contentRef.current;
    if (!c || !pos.ready || reducedMotion()) return;
    const raw = Number.parseFloat(getComputedStyle(c).opacity);
    const cur = Number.isFinite(raw) ? raw : 1;
    const dimmed = cur < QUICK_SWAP_FROM;
    contentAnimRef.current?.cancel();
    contentAnimRef.current = c.animate(
      [{ opacity: dimmed ? cur : Math.min(cur, QUICK_SWAP_FROM) }, { opacity: 1 }],
      { duration: dimmed ? SWAP_MS : QUICK_SWAP_MS, easing: EASE_OUT },
    );
  }, [shownId]);

  const reduced = reducedMotion();
  const letPointerThrough = pos.covers && !frozen && !pointerInside;
  return createPortal(
    // Positioner: carries the placement as a transform, so a glide between
    // cards is compositor work. The panel inside owns the fade / scale, so
    // the two never fight over one transform.
    <div
      className="fixed left-0 top-0 z-[10000]"
      style={{
        transform: `translate3d(${pos.left}px, ${pos.top}px, 0)`,
        transition: pos.animate ? `transform ${GLIDE_MS}ms ${EASE_OUT}` : "none",
        // Never a mispositioned first frame: hidden until placed.
        visibility: pos.ready ? "visible" : "hidden",
        pointerEvents: "none",
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`${meta.name} details`}
        aria-busy={pending || shown == null}
        data-hover-panel="true"
        onMouseEnter={() => { if (exiting) return; notePanelPointer(true); setPointerInside(true); cancelHoverClose(); }}
        onMouseLeave={() => { notePanelPointer(false); setPointerInside(false); if (!exiting) scheduleHoverClose(); }}
        className="relative w-[360px] overflow-hidden
                   rounded-xl border border-white/12 bg-black/85 backdrop-blur-2xl
                   shadow-[0_28px_64px_-20px_rgba(0,0,0,0.92)]"
        style={{
          height: pos.ready ? pos.h : undefined,
          transition: pos.animate ? `height ${GLIDE_MS}ms ${EASE_OUT}` : "none",
          transformOrigin: originFor(pos.side),
          pointerEvents: exiting || letPointerThrough ? "none" : "auto",
        }}
        // pointer-events alone leaves a fading copy's buttons focusable and
        // keyboard-activatable; inert takes the whole copy out of focus,
        // key input and the accessibility tree for its exit.
        inert={exiting || undefined}
      >
        <div
          ref={scrollRef}
          className="max-h-[80vh] overflow-y-auto px-4 py-3.5"
          style={{
            scrollbarWidth: "thin",
            scrollbarColor: "rgba(255,255,255,0.15) transparent",
          }}
        >
          <div
            ref={contentRef}
            style={{
              // The previous card's content, held while the next loads, is
              // only a placeholder for the panel's size: it dims hard (washed
              // out and softened too) once the wait is long enough to notice,
              // and takes no clicks or keys (inert, below), so Open details can never open the card
              // it shows instead of the card under the cursor. It is kept
              // whole rather than having its title swapped to the new card:
              // a new title over the old body would be a mixed panel, and a
              // title wrapping to a different line count would move the
              // height mid-wait. The badge below names the new card instead.
              // Leaving the hold, the filter eases back with the cross-fade
              // (see the content swap). Reduced motion keeps the delay (so a
              // cache hit still never flashes dim) but steps, and no filter.
              opacity: pending ? HELD_OPACITY : 1,
              filter: pending && !reduced ? HELD_FILTER : undefined,
              transition: !pending
                ? (reduced ? "none" : `opacity 120ms ease-out, filter ${SWAP_MS}ms ${EASE_OUT}`)
                : reduced ? `opacity 0s linear ${DIM_DELAY_MS}ms`
                : `opacity ${DIM_FADE_MS}ms ease-out ${DIM_DELAY_MS}ms, filter ${DIM_FADE_MS}ms ease-out ${DIM_DELAY_MS}ms`,
              pointerEvents: pending ? "none" : undefined,
            }}
            // pointer-events blocks clicks only: a button that already had
            // focus (a press dragged off before release, a Tab) would still
            // answer Enter and open the HELD card while the badge names the
            // new one, and assistive tech would read the held card's text
            // under a dialog named for the new one. inert drops focus (the
            // browser blurs a focused descendant), key activation and the
            // accessibility tree for exactly as long as the content is held.
            inert={pending || undefined}
          >
            {shown ? (
              <PanelContent
                key={shown.meta.id}
                meta={shown.meta}
                detail={shown.detail}
                aggRatings={shown.aggRatings}
                onSelectMeta={onSelectMeta}
              />
            ) : (
              // Past the hold cap this keeps the held height (capMinH), so
              // the fallback never shrinks the panel; on a first open it is 0.
              <div className="flex flex-col" style={capMinH > 0 ? { minHeight: capMinH } : undefined}>
                <h3 className="text-white text-[17px] font-semibold leading-tight line-clamp-2">
                  {meta.name}
                </h3>
                <div className="flex-1 py-6 flex items-center justify-center">
                  <Spinner className="w-5 h-5 text-white/40" />
                </div>
              </div>
            )}
          </div>
        </div>
        {/* Only where the panel lets the pointer through: over free space it
            can simply be moved onto, and this would be noise. A footer, because
            a panel in pass-through cannot be scrolled to anything below the
            scroller's fold. Always mounted, out of flow and unseen until
            needed, so the placement can count its height before it shows. */}
        <p
          ref={hintRef}
          className="px-4 py-2 border-t border-white/8 text-[11px] text-white/40"
          style={pos.covers ? undefined : { position: "absolute", top: 0, left: 0, right: 0, visibility: "hidden" }}
          aria-hidden
        >
          Hold{" "}
          <kbd
            className={`px-1 py-px rounded border font-mono text-[10px] transition-colors
              ${frozen ? "border-ln-accent/50 text-ln-accent" : "border-white/15 bg-white/8 text-white/60"}`}
          >
            Alt
          </kbd>{" "}
          to keep this open and move onto it
        </p>
        {/* The loading badge over the held content: centred on the panel's
            visible box (absolute, so it never sizes the panel), shown with
            the dim and on the same delay, so a cache hit never flashes it.
            Always mounted so it can fade out over the incoming content
            instead of vanishing; `visibility` takes it out of paint once
            faded, and its spinner only spins while it is up. */}
        <div
          aria-hidden
          className="absolute inset-0 flex items-center justify-center px-6 pointer-events-none"
          style={{
            opacity: pending ? 1 : 0,
            visibility: pending ? "visible" : "hidden",
            transition: pending
              ? (reduced
                ? `opacity 0s linear ${DIM_DELAY_MS}ms, visibility 0s linear ${DIM_DELAY_MS}ms`
                : `opacity ${DIM_FADE_MS}ms ease-out ${DIM_DELAY_MS}ms, visibility 0s linear ${DIM_DELAY_MS}ms`)
              : (reduced ? "none" : "opacity 120ms ease-out, visibility 0s linear 120ms"),
          }}
        >
          <div
            className="flex items-center gap-2 max-w-full rounded-full px-3.5 py-1.5
                       bg-black/60 border border-white/10 shadow-[0_8px_24px_-8px_rgba(0,0,0,0.9)]"
          >
            <Spinner className="w-3.5 h-3.5 flex-shrink-0 text-white/75" spinning={pending} />
            <span className="min-w-0 truncate text-[12px] text-white/55">
              Loading <span className="text-white/90 font-medium">{loadingLabelRef.current}</span>
            </span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The panel's content for ONE title. Keyed on the title by HoverPanel, so a
 *  switch remounts it: per-title hook state (release dates, avatar failures)
 *  starts fresh instead of showing the previous title's for a frame. */
function PanelContent({
  meta, detail, aggRatings, onSelectMeta,
}: {
  meta: MetaPreview;
  detail: MetaDetail | null;
  aggRatings: RatingRow[];
  onSelectMeta?: (m: MetaPreview) => void;
}) {
  const isEpisodic = meta.media_type === "series" || meta.media_type === "anime";
  const seasonCount = detail
    ? new Set(detail.videos.map((v) => v.season ?? 0).filter((s) => s > 0)).size
    : 0;
  const epCount = detail?.videos.length ?? 0;
  const metaBits: string[] = [];
  const yearStr = detail?.release_info || (detail?.released ? detail.released.slice(0, 4) : "");
  if (yearStr) metaBits.push(yearStr);
  if (isEpisodic && seasonCount > 0) metaBits.push(`${seasonCount} Season${seasonCount === 1 ? "" : "s"}`);
  if (isEpisodic && epCount > 0) metaBits.push(`${epCount} Episode${epCount === 1 ? "" : "s"}`);
  if (detail?.runtime) metaBits.push(detail.runtime);

  // "N episodes behind" for an airing series (red line below). null when not
  // airing or fully caught up.
  const episodesBehind = useEpisodesBehind(detail?.videos, meta.id);

  // Accurate Digital + Theatrical dates (MDBList) for the Digital countdown
  // and the "In Theaters" tag. null for non-movies / before it lands.
  const releaseDates = useMovieReleaseDates(meta.id, meta.media_type);

  // Release countdown(s) — next-episode / premiere for series, cinematic +
  // digital for movies. Computed once per render; the hover panel is too
  // short-lived to need a live tick (see releaseCountdown.ts). No-op when
  // nothing is upcoming.
  const countdowns = detail ? computeReleaseCountdowns(detail, Date.now(), releaseDates) : [];

  // Merge addon-supplied + aggregator ratings (aggregator wins on
  // source collision — it goes through ratings.rs label normalisation),
  // weight-sorted exactly like DetailView so the strongest sources
  // surface first within the 6-chip cap.
  const ratings = (() => {
    const map = new Map<string, RatingRow>();
    for (const r of detail?.ratings ?? []) {
      if (hasUsableRating(r.value)) map.set(r.source.toLowerCase(), { source: r.source, value: r.value });
    }
    for (const r of aggRatings) {
      if (hasUsableRating(r.value)) map.set(r.source.toLowerCase(), r);
    }
    return groupRatingsByBrand(
      [...map.values()].sort((a, b) => (b.weight ?? 50) - (a.weight ?? 50)),
    ).slice(0, 6);
  })();
  const tags = (detail?.genres ?? []).slice(0, 8);
  const directors = (detail?.director ?? []).filter(Boolean).slice(0, 2);
  const cast = (detail?.cast_detailed ?? []).slice(0, 6);

  return (
    <>
      <div className="flex items-start gap-2">
        <h3 className="flex-1 text-white text-[17px] font-semibold leading-tight line-clamp-2">
          {detail?.name ?? meta.name}
        </h3>
        {onSelectMeta && (
          <button
            type="button"
            aria-label="Open details"
            onClick={() => { closeHoverNow(); onSelectMeta(meta); }}
            className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center
                       text-white/55 hover:text-white hover:bg-white/10 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" />
            </svg>
          </button>
        )}
      </div>

      {metaBits.length > 0 && (
        <p className="text-white/55 text-[12px] mt-1 font-mono tracking-tight">
          {metaBits.join("  ·  ")}
        </p>
      )}

      {episodesBehind != null && (
        <p className="text-red-400 text-[12px] font-semibold mt-1">
          {episodesBehind} episode{episodesBehind === 1 ? "" : "s"} behind
        </p>
      )}

      {/* Persistent "In Theaters" tag (movies only). Rendered separately
          from the countdown row because that row can be empty for an
          in-theaters film whose estimated digital date has also passed. */}
      {isInTheaters(meta.media_type, releaseDates) && (
        <div className="mt-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded
                           bg-amber-500/20 border border-amber-400/40 text-amber-100
                           text-[11px] font-semibold">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M22 10V6c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2v4c1.1 0 1.99.9 1.99 2s-.89 2-2 2v4c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2v-4c-1.1 0-2-.9-2-2s.9-2 2-2z" />
            </svg>
            In Theaters
          </span>
        </div>
      )}

      {countdowns.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5">
          {countdowns.map((c) => (
            <HoverCountdownChip key={c.kind} label={c.label} targetMs={c.targetMs} estimated={c.estimated} />
          ))}
        </div>
      )}

      {ratings.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {ratings.map((r) => (
            <RatingChip key={r.source} source={r.source} value={r.value} kind={r.kind} />
          ))}
        </div>
      )}

      {tags.length > 0 && (
        <>
          <Heading>Tags</Heading>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <span
                key={t}
                className="px-2 py-0.5 rounded-md bg-white/8 border border-white/10 text-white/75 text-[11px]"
              >
                {t}
              </span>
            ))}
          </div>
        </>
      )}

      {(() => {
        // Season/cour-aware plot. When the hovered catalog item is itself a
        // single season/cour, its season_credits carries exactly one season
        // — prefer that season's overview so the panel describes the cour,
        // not the umbrella series. Multi-season series fall through to the
        // show-level description (which, for a per-cour catalog id, the
        // addon already returns cour-specific). Empty season_credits (anime
        // today) also falls through. Always fall back to the default.
        const sc = detail?.season_credits;
        const keys = sc ? Object.keys(sc) : [];
        const lone = keys.length === 1 ? sc![keys[0]]?.overview : null;
        const plot = (typeof lone === "string" && lone.trim() ? lone : null)
          ?? detail?.description
          ?? null;
        if (!plot) return null;
        return (
          <>
            <Heading>Plot</Heading>
            <p className="text-white/70 text-[12.5px] leading-relaxed line-clamp-5">
              {plot}
            </p>
          </>
        );
      })()}

      {directors.length > 0 && (
        <>
          <Heading>{directors.length > 1 ? "Directors" : "Director"}</Heading>
          <div className="flex items-center gap-2">
            <Avatar src={null} alt={directors[0]} />
            <span className="text-white/85 text-[12.5px]">{directors.join(", ")}</span>
          </div>
        </>
      )}

      {cast.length > 0 && (
        <>
          <Heading>Cast</Heading>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            {cast.map((c, i) => (
              <div key={`${c.name}-${i}`} className="flex items-center gap-2 min-w-0">
                <Avatar src={c.photo} alt={c.name} />
                <div className="min-w-0">
                  <p className="text-white/90 text-[12px] font-medium leading-tight truncate">
                    {c.name}
                  </p>
                  {c.character && (
                    <p className="text-white/45 text-[11px] leading-tight truncate">
                      {c.character}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!detail && (
        <p className="text-white/40 text-[12px] py-3 italic">
          No extra details available.
        </p>
      )}
    </>
  );
}

/** Mount ONCE (App). Renders the hover panel for whatever card the
 *  store currently has as the active hover target. */
export function CatalogHoverHost({
  addons, onSelectMeta,
}: {
  addons: AddonEntry[];
  onSelectMeta?: (m: MetaPreview) => void;
}) {
  const target = useHoverTarget();
  // True in the non-hover activation modes ("button" / "hold"), where the panel
  // is opened explicitly and has no mouse-leave close — so it needs Esc +
  // click-outside dismissal (added below).
  const [explicitDismiss, setExplicitDismiss] = useState(
    () => loadAuraSettings().metaPanelActivation !== "hover",
  );

  useEffect(() => {
    const sync = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (keys && !keys.includes("metaPanelActivation")) return;
      setExplicitDismiss(loadAuraSettings().metaPanelActivation !== "hover");
    };
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  // Scroll / resize used to hard-close the popup (the rect went stale).
  // Now we RE-ANCHOR to the card's live box instead, so the panel stays
  // open while the cursor is still on the card (it only closes when the
  // pointer leaves the card/panel, or the card scrolls off-screen).
  // Capture phase so an inner scroll container counts too.
  useEffect(() => {
    if (!target) return;
    const reanchor = () => refreshHoverAnchor();
    window.addEventListener("scroll", reanchor, true);
    window.addEventListener("resize", reanchor);
    return () => {
      window.removeEventListener("scroll", reanchor, true);
      window.removeEventListener("resize", reanchor);
    };
  }, [target]);

  // Anchor-survival watchdog. The hover store closes on scroll/resize
  // when the anchor card scrolls out of view or is disconnected, but a
  // grid change (e.g. Discover switching catalogs while the cursor was
  // momentarily over a card) unmounts the anchor WITHOUT firing scroll
  // — and the panel sticks. Re-check every 250 ms while a target is
  // live; if the anchor is no longer in the document, close. Interval
  // chosen so a rapid hover→unmount→hover sequence still feels snappy.
  useEffect(() => {
    if (!target) return;
    const id = window.setInterval(() => {
      if (!target.el.isConnected) closeHoverNow();
    }, 250);
    return () => window.clearInterval(id);
  }, [target]);

  // Alt holds the panel still (see the store). Hover mode only: the other modes
  // never move or close on a hover. Keyed on "a panel is up", not on the target,
  // which is a new object on every scroll re-anchor and would drop a hold. A
  // bare Alt is default-prevented or Windows arms the window's system menu on
  // release and eats the next key. A focus loss (Alt+Tab) never delivers the
  // keyup, so it counts as one.
  const live = target != null;
  useEffect(() => {
    if (!live || explicitDismiss) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      e.preventDefault();
      setHoverFrozen(true);
    };
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt") return;
      e.preventDefault();
      setHoverFrozen(false);
    };
    const onBlur = () => setHoverFrozen(false);
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      setHoverFrozen(false);
    };
  }, [live, explicitDismiss]);

  // Button / hold modes only: there is no mouse-leave close, so Esc and a
  // click outside the panel + its anchoring card dismiss it. Hover mode is
  // intentionally NOT given these (its leave/scroll behaviour is unchanged
  // and shipped). target.el is the active card element.
  useEffect(() => {
    if (!target || !explicitDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHoverNow();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      // Click inside the panel, or on the Performance Monitor, which floats over
      // the app and is not part of the page.
      if (t.closest("[data-hover-panel], [data-perf-monitor]")) return;
      if (target.el.contains(t)) return;                 // click on the card
      closeHoverNow();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [target, explicitDismiss]);

  // A card's right-click, from whichever view: the panel is portalled above the
  // app shell's menus, so left up it would paint over the menu and take its
  // clicks. Also stops an open still pending on that card.
  useEffect(() => {
    window.addEventListener("aura:card-context", closeHoverNow);
    return () => window.removeEventListener("aura:card-context", closeHoverNow);
  }, []);

  // Exit presence (the StackPresence idea, NextUpCta.tsx): when the store
  // closes, the last target stays rendered for EXIT_MS, marked `exiting`, so
  // the panel fades out showing what it showed instead of vanishing. It is
  // the SAME element at the same place in the tree, so React keeps the
  // instance: a re-open inside the exit turns the fade around and glides to
  // the new card rather than remounting. Derived during render so the held
  // copy is swapped in before anything commits. Every effect above keys on
  // the LIVE target, so a fading copy is never re-anchored or dismissed.
  // Reduced motion drops it at once.
  const lastTargetRef = useRef<HoverTarget | null>(null);
  const [wasLive, setWasLive] = useState(target != null);
  const [leaving, setLeaving] = useState<HoverTarget | null>(null);
  if ((target != null) !== wasLive) {
    setWasLive(target != null);
    const fadesOut = target == null && !reducedMotion();
    setLeaving(fadesOut ? lastTargetRef.current : null);
    // No exit means no exit timer to let the card element go.
    if (target == null && !fadesOut) lastTargetRef.current = null;
  }
  if (target) lastTargetRef.current = target;
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => {
      setLeaving(null);
      // Do not keep the card element alive past its panel.
      lastTargetRef.current = null;
    }, EXIT_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  const shownTarget = target ?? leaving;
  if (!shownTarget) return null;
  return (
    <HoverPanel
      target={shownTarget}
      exiting={target == null}
      addons={addons}
      onSelectMeta={onSelectMeta}
    />
  );
}
