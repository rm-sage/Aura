// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// heroBackdrop - the per-title backdrop override for the detail hero, and the
// candidates its picker offers.
//
// The addon's art stays the default. A right-click on the hero lets the user
// pick among backdrops Aura ALREADY holds for the title (every cached addon
// answer, the catalog preview, the library record, arc key art), and the
// choice is remembered per title. Nothing here fetches: the candidates are
// collected synchronously from memory, so opening the picker costs no request
// and needs no Rust command.
//
// DEVICE-LOCAL, deliberately, like `aura:arc-mode:v1`. This is per-title view
// state, not a Settings-page setting, so it is in neither PORTABLE_*_FIELDS
// (settings export / import) nor the Aura Cloud blob, and userDataBackup does
// not carry it either.
// ---------------------------------------------------------------------------

import { PersistentCache } from "./persistentCache";
import { isSafeExternalUrl } from "./externalUrl";
import { peekCachedBackgroundsById } from "./metaCache";
import { loadAuraSettings } from "./auraSettings";
import { arcPositionOf, peekCachedArcs, stripArcKindSuffix } from "./storyArcs";
import type { AddonEntry, MetaDetail, MetaPreview } from "./types";

/** Same ceiling the Rust side puts on every art URL it hands the frontend
 *  (`sanitize_url` in stremio.rs). */
const MAX_ART_URL_LEN = 2048;

/** The picker never lists more than this many backdrops. A long-running show
 *  with arc art could otherwise offer dozens, and each tile is an image. */
export const MAX_BACKDROP_CANDIDATES = 24;

/** The localStorage key, exported for Settings > Storage, whose clear has to
 *  go through clearHeroBackdrops rather than a bare removeItem. */
export const HERO_BACKDROP_STORAGE_KEY = "aura:hero-backdrop:v1";

/** Keyed by the detail page's meta id; the value is the chosen URL only.
 *  Mirrors arcModeCache: a year's TTL and a cap, so a big library cannot grow
 *  it without limit. NOT reclaimable: these are the user's choices, not data
 *  that re-fetches, and a quota squeeze elsewhere must not quietly undo half
 *  of them for the few KB they hold. */
const heroBackdropCache = new PersistentCache<string>({
  storageKey: HERO_BACKDROP_STORAGE_KEY,
  ttlMs: 365 * 24 * 60 * 60 * 1000,
  maxEntries: 300,
  reclaimable: false,
});

/** A well-formed http(s) URL within the length cap. The one check for every
 *  backdrop this module stores, reads back or offers. */
export function isArtUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= MAX_ART_URL_LEN && isSafeExternalUrl(url);
}

/** The stored backdrop for a title, or null for "automatic". A stored value
 *  that fails validation (a hand-edited or corrupt blob) reads as no override
 *  rather than reaching an <img>. */
export function loadHeroBackdrop(id: string): string | null {
  if (!id) return null;
  const v = heroBackdropCache.get(id);
  return isArtUrl(v) ? v : null;
}

/** Remember a backdrop for a title; null (or anything invalid) clears it, so
 *  the title goes back to following its addon's art. */
export function saveHeroBackdrop(id: string, url: string | null): void {
  if (!id) return;
  if (url && isArtUrl(url)) heroBackdropCache.set(id, url);
  else heroBackdropCache.delete(id);
}

/** Settings > Storage "Chosen backdrops" clear. Removing the localStorage key
 *  alone is not enough: the cache hydrated into memory at import, so cleared
 *  choices would keep applying for the session and the next save on ANY title
 *  would write the whole in-memory map, every cleared choice included, back.
 *  A detail page already open keeps its latched hero until it is reopened. */
export function clearHeroBackdrops(): void {
  heroBackdropCache.clear();
}

export interface BackdropCandidate {
  url: string;
  /** Where it came from: an addon's name, "Catalog", "Library", or
   *  "Arc: <name>". */
  label: string;
}

export interface BackdropSources {
  preview: MetaPreview;
  addons: AddonEntry[];
  /** The detail the page is showing and the addon that answered it. The
   *  page's own meta probe does not write the metaCache, so without this the
   *  art on screen could be missing from its own picker. */
  live: { detail: MetaDetail; addonUrl: string } | null;
  /** `background` of the title's library record, when it has one. */
  libraryBackground: string | null;
  /** The resume episode the hero picks arc art from. */
  resumeVideoId: string | null;
  /** The stored override, listed even when no source still offers it, so the
   *  current choice is always visible (and marked) in the picker. */
  override: string | null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Every backdrop Aura already holds for a title, deduplicated by exact URL,
 *  in this order (the first label for a URL wins):
 *
 *    1. addon answers: the page's live detail, then every fresh metaCache
 *       entry for the id, in the user's addon order, each labelled with the
 *       addon's name (its host when it has none);
 *    2. the library record's stored background ("Library"). Ahead of the
 *       catalog preview because a page opened FROM the library has the
 *       record's own background as its preview, and "Library" is the name
 *       the user knows that image by;
 *    3. the catalog preview's background / fanart / backdrop ("Catalog");
 *    4. arc key art, only with "Match artwork to your current story arc" on,
 *       only Fandom key art (the same rule as arcArtFor), and only for arcs up
 *       to and including the one holding the resume episode. That setting
 *       already records that arc art ADDS spoiler exposure, and a picker of
 *       later arcs' key art would spoil more than the automatic mode does.
 *       Newest arc first, so the cap drops the oldest arcs, not the one the
 *       user is in.
 *
 *  Capped at MAX_BACKDROP_CANDIDATES. Synchronous and network-free. */
export function collectBackdropCandidates(src: BackdropSources): BackdropCandidate[] {
  const out: BackdropCandidate[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined, label: string) => {
    if (!isArtUrl(url) || seen.has(url)) return;
    seen.add(url);
    out.push({ url, label });
  };
  const addonLabel = (url: string) => {
    const name = src.addons.find((a) => a.url === url)?.name?.trim();
    return name || hostOf(url);
  };

  if (src.live) push(src.live.detail.background, addonLabel(src.live.addonUrl));
  const orderOf = (url: string) => {
    const i = src.addons.findIndex((a) => a.url === url);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const cached = peekCachedBackgroundsById(src.preview.id)
    .map((c, i) => ({ ...c, i }))
    .sort((a, b) => orderOf(a.addonUrl) - orderOf(b.addonUrl) || a.i - b.i);
  for (const c of cached) push(c.background, addonLabel(c.addonUrl));

  push(src.libraryBackground, "Library");

  push(src.preview.background, "Catalog");
  push(src.preview.fanart, "Catalog");
  push(src.preview.backdrop, "Catalog");

  if (src.resumeVideoId && loadAuraSettings().arcAwareArt) {
    const arcs = peekCachedArcs(src.preview.id);
    const pos = arcPositionOf(arcs, src.resumeVideoId);
    if (arcs && pos) {
      for (let i = arcs.arcs.indexOf(pos.arc); i >= 0; i--) {
        const arc = arcs.arcs[i];
        if (arc.image_source !== "fandom") continue;
        // The name TMDB gives is shown without its kind marker: the picker
        // says nothing about filler, and that marker is often wrong.
        push(arc.image, `Arc: ${stripArcKindSuffix(arc.name)}`);
      }
    }
  }

  const capped = out.slice(0, MAX_BACKDROP_CANDIDATES);
  if (src.override && isArtUrl(src.override) && !capped.some((c) => c.url === src.override)) {
    if (capped.length >= MAX_BACKDROP_CANDIDATES) capped.pop();
    capped.push({ url: src.override, label: "Saved choice" });
  }
  return capped;
}
