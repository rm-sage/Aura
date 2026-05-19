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
// ---------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, MetaPreview, MetaDetail } from "./types";
import { getMetaDetailFallback } from "./metaCache";
import { dedupedInvoke } from "./invokeDedupe";
import { BrandLogo, ratingDomain, ratingKindNote } from "./logodev";
import { hasUsableRating } from "./ratingValue";
import {
  useHoverTarget,
  cancelHoverClose,
  scheduleHoverClose,
  closeHoverNow,
  refreshHoverAnchor,
  notePanelPointer,
  type HoverTarget,
} from "./catalogHoverStore";
import { loadAuraSettings } from "./auraSettings";

const PANEL_W = 360;
const GAP = 12;
const PAD = 10;
// Nudge the panel UP off the card's vertical centre so it doesn't sit
// dead-level with the card it overlays — leaves the card's lower half
// clear, making it easier to sweep the cursor back onto the card.
const ANCHOR_Y_NUDGE = -30;

/** A merged rating row (addon-supplied OR aggregator). `weight` drives
 *  the same ordering DetailView uses; absent → 50. */
interface RatingRow { source: string; value: string; kind?: string; weight?: number }

// Session cache for the multi-source aggregate (MDBList IMDb/RT/Metacritic
// + MAL/AniList for anime). Hovering re-fires the panel constantly, and
// the upstreams have request budgets — cache by meta id so a card is
// fetched at most once per session.
const aggRatingsCache = new Map<string, RatingRow[]>();

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

function HoverPanel({
  target, addons, onSelectMeta,
}: {
  target: HoverTarget;
  addons: AddonEntry[];
  onSelectMeta?: (m: MetaPreview) => void;
}) {
  const { meta, rect } = target;
  const ref = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<MetaDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0, top: 0, ready: false,
  });

  // Fetch the meta detail (cached). Alt-type fallback mirrors the CW
  // card: anime catalogs often tag content as series/movie with an
  // anime-prefixed id, so the first lookup can miss.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    (async () => {
      let d = await getMetaDetailFallback(addons, meta.media_type, meta.id);
      if (!d) {
        const alt = meta.media_type === "series" ? "anime"
          : meta.media_type === "anime" ? "series" : null;
        if (alt) d = await getMetaDetailFallback(addons, alt, meta.id);
      }
      if (cancelled) return;
      setDetail(d);
      setLoading(false);
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
  const [aggRatings, setAggRatings] = useState<RatingRow[]>(
    () => aggRatingsCache.get(meta.id) ?? [],
  );
  useEffect(() => {
    const cached = aggRatingsCache.get(meta.id);
    if (cached) { setAggRatings(cached); return; }
    let cancelled = false;
    const isAnime =
      meta.media_type === "anime" ||
      /^(kitsu|mal|anidb|anilist):/.test(meta.id) ||
      !!(detail?.mal_id || detail?.kitsu_id || detail?.anidb_id);
    const input = {
      imdb_id:    meta.id.startsWith("tt") ? meta.id : null,
      mal_id:     detail?.mal_id   ?? null,
      kitsu_id:   detail?.kitsu_id ?? null,
      anilist_id: null,
      anidb_id:   detail?.anidb_id ?? null,
      title:      meta.name,
      year:       meta.release_info ? Number(meta.release_info.slice(0, 4)) || null : null,
      is_anime:   isAnime,
    };
    // Nothing resolvable → skip the round-trip entirely.
    if (!input.imdb_id && !isAnime) return;
    dedupedInvoke(
      `ratings:${meta.id}:${isAnime ? "anime" : "std"}`,
      () => invoke<RatingRow[]>("fetch_aggregate_ratings", { input }),
    )
      .then((r) => {
        if (cancelled) return;
        const list = Array.isArray(r) ? r : [];
        aggRatingsCache.set(meta.id, list);
        setAggRatings(list);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [meta.id, meta.media_type, meta.name, meta.release_info,
      detail?.mal_id, detail?.kitsu_id, detail?.anidb_id]);

  // Position beside the card: prefer the right edge, flip left when
  // there is no room, clamp vertically into the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    const h = el?.offsetHeight ?? 420;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = rect.right + GAP;
    if (left + PANEL_W + PAD > vw) left = rect.left - GAP - PANEL_W;
    if (left < PAD) left = Math.max(PAD, (vw - PANEL_W) / 2);
    let top = rect.top + rect.height / 2 - h / 2 + ANCHOR_Y_NUDGE;
    if (top + h + PAD > vh) top = vh - h - PAD;
    if (top < PAD) top = PAD;
    setPos({ left, top, ready: true });
  }, [rect, detail, loading]);

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
    return [...map.values()]
      .sort((a, b) => (b.weight ?? 50) - (a.weight ?? 50))
      .slice(0, 6);
  })();
  const tags = (detail?.genres ?? []).slice(0, 8);
  const directors = (detail?.director ?? []).filter(Boolean).slice(0, 2);
  const cast = (detail?.cast_detailed ?? []).slice(0, 6);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={`${meta.name} details`}
      data-hover-panel="true"
      onMouseEnter={() => { notePanelPointer(true); cancelHoverClose(); }}
      onMouseLeave={() => { notePanelPointer(false); scheduleHoverClose(); }}
      className="fixed z-[280] w-[360px] max-h-[80vh] overflow-y-auto
                 rounded-xl border border-white/12 bg-black/85 backdrop-blur-2xl
                 shadow-[0_28px_64px_-20px_rgba(0,0,0,0.92)]
                 px-4 py-3.5 pointer-events-auto"
      style={{
        left: pos.left,
        top: pos.top,
        opacity: pos.ready ? 1 : 0,
        transition: "opacity 120ms ease-out",
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(255,255,255,0.15) transparent",
      }}
    >
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

      {loading && !detail && (
        <div className="py-6 flex items-center justify-center">
          <svg className="w-5 h-5 animate-spin text-white/40" viewBox="0 0 24 24" fill="none" aria-hidden>
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
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

      {detail?.description && (
        <>
          <Heading>Plot</Heading>
          <p className="text-white/70 text-[12.5px] leading-relaxed line-clamp-5">
            {detail.description}
          </p>
        </>
      )}

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

      {!loading && !detail && (
        <p className="text-white/40 text-[12px] py-3 italic">
          No extra details available.
        </p>
      )}
    </div>,
    document.body,
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
  const [bindEnabled, setBindEnabled] = useState(
    () => loadAuraSettings().metaPanelBindEnabled,
  );

  useEffect(() => {
    const sync = (e: Event) => {
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (keys && !keys.includes("metaPanelBindEnabled")) return;
      setBindEnabled(loadAuraSettings().metaPanelBindEnabled);
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

  // Bind mode only: there is no mouse-leave close, so Esc and a click
  // outside the panel + its anchoring card dismiss it. Hover mode is
  // intentionally NOT given these (its leave/scroll behaviour is
  // unchanged and shipped). target.el is the active card element.
  useEffect(() => {
    if (!target || !bindEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeHoverNow();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest("[data-hover-panel]")) return;       // click inside panel
      if (target.el.contains(t)) return;                 // click on the card
      closeHoverNow();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [target, bindEnabled]);

  if (!target) return null;
  return <HoverPanel target={target} addons={addons} onSelectMeta={onSelectMeta} />;
}
