// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TrackEntry } from "./types";

// ---------------------------------------------------------------------------
// Audio track scoring — picks the best default audio stream from MPV's
// track-list using user preferences + AIOMetadata's originalLanguage and
// productionCountries.
//
// Algorithm (per the user's spec, simplified for our libmpv build which
// doesn't expose disposition flags — we fall back to title regex for the
// commentary / audio-description filter):
//
// 1. Hard-exclude commentary / audio-description / karaoke tracks.
// 2. Normalize each track's `lang` to a 2-letter (639-1) code.
// 3. Resolve the user's audio_priority list, replacing the literal token
//    "original" with the meta's `original_language` (drop if null).
//    English is appended as the universal final fallback.
// 4. Score each track:
//      - Language match: 1000 - (idx * 50). Outside the list → disqualified.
//      - Original / dub disposition (title regex):
//          • title contains "original" / "(sub)" → +80
//          • title contains "dub" / "english dub" → -200 if avoidDubs else -30
//      - Region tiebreak: +40 if track region matches a production country,
//        +20 if it matches the user's saved region.
//      - Default flag (track.selected at fetch time): +10
// 5. Pick the highest score; if every survivor is disqualified, return
//    the first non-excluded track (graceful fallback).
//
// Returns null when there are no usable audio tracks at all.
// ---------------------------------------------------------------------------

export interface ScoringMeta {
  original_language: string | null;
  production_countries: string[];
  /** Genre list from the addon. Used as a fallback heuristic when the
   *  meta lacks `original_language` — an "Anime" tag almost always
   *  implies Japanese original audio. */
  genres?: string[];
  /** Free-form country string (TMDB ships names like "Japan" or
   *  "United States, Japan"; TVDB ships lowercase 3-letter codes like
   *  "jpn"). Last-ditch fallback when no structured signal is present. */
  country?: string | null;
}

// ---------------------------------------------------------------------------
// Original-language fallback resolver
//
// AIOMetadata occasionally caches meta blobs that pre-date the
// originalLanguage / productionCountries fields. Until those cache keys
// are flushed, we synthesise a best-effort answer from the surrounding
// signals so audio_priority's "original" token can still resolve.
//
// Order of authority (per the user's spec):
//   1. `original_language` field itself, when populated
//   2. genres includes "Anime"        → "ja"   (curated mapping in
//                                              AIOMetadata is reliable)
//   3. productionCountries[0]         → ISO map
//   4. `country` field, comma-split   → ISO map (TMDB / TVDB shapes)
//   5. null                           → priority list falls through
// ---------------------------------------------------------------------------

const COUNTRY_TO_LANG: Record<string, string> = {
  // Japan
  "japan": "ja", "jpn": "ja", "jp": "ja",
  // Korea
  "south korea": "ko", "korea": "ko", "kor": "ko", "kr": "ko",
  // China + Taiwan (both Mandarin / Cantonese)
  "china": "zh", "chn": "zh", "cn": "zh",
  "taiwan": "zh", "twn": "zh", "tw": "zh",
  // Western Europe
  "france": "fr", "fra": "fr", "fr": "fr",
  "germany": "de", "deu": "de", "de": "de",
  "spain": "es", "esp": "es", "es": "es",
  "italy": "it", "ita": "it", "it": "it",
  "portugal": "pt", "prt": "pt", "pt": "pt",
  // Latin America
  "mexico": "es", "mex": "es", "mx": "es",
  "brazil": "pt", "bra": "pt", "br": "pt",
  // Eastern Europe + South / Southeast Asia
  "russia": "ru", "rus": "ru", "ru": "ru",
  "india": "hi", "ind": "hi", "in": "hi",
  "thailand": "th", "tha": "th", "th": "th",
  "turkey": "tr", "tur": "tr", "tr": "tr",
  // Anglophone
  "united kingdom": "en", "gbr": "en", "gb": "en", "uk": "en",
  "united states": "en", "united states of america": "en", "usa": "en", "us": "en",
  "canada": "en", "can": "en", "ca": "en",
  "australia": "en", "aus": "en", "au": "en",
};

function lookupCountry(token: string | undefined | null): string | null {
  if (!token) return null;
  const key = token.trim().toLowerCase();
  return COUNTRY_TO_LANG[key] ?? null;
}

export function resolveOriginalLanguage(meta: ScoringMeta): string | null {
  // 1. Authoritative
  if (meta.original_language && meta.original_language.length > 0) {
    return meta.original_language.toLowerCase();
  }
  // 2. Anime genre → ja. Curated tag in AIOMetadata; correct ~95 % of
  // the time. Edge cases (Korean aeni, Chinese donghua) fall through if
  // we have a country signal that overrides — but we run this BEFORE
  // country because TMDB sometimes lists anime as US co-productions.
  if (meta.genres && meta.genres.some((g) => g.toLowerCase() === "anime")) {
    return "ja";
  }
  // 3. productionCountries — alpha-2 ISO codes per the spec.
  if (meta.production_countries && meta.production_countries.length > 0) {
    const lang = lookupCountry(meta.production_countries[0]);
    if (lang) return lang;
  }
  // 4. `country` field. TMDB-style co-productions are comma-joined
  // ("United States, Japan") — take the first entry.
  if (meta.country) {
    const first = meta.country.split(",")[0]?.trim();
    const lang = lookupCountry(first);
    if (lang) return lang;
  }
  return null;
}

export interface ScoringPrefs {
  audio_priority: string[];
  avoid_dubs: boolean;
  user_region: string;
}

/** ISO 639-2 → 639-1 fallback map for tracks tagged with 3-letter codes.
 *  Only the languages we realistically meet in addon-supplied streams. */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: "en", jpn: "ja", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de",
  ita: "it", por: "pt", rus: "ru", chi: "zh", zho: "zh", kor: "ko", ara: "ar",
  hin: "hi", tha: "th", vie: "vi", tur: "tr", pol: "pl", dut: "nl", nld: "nl",
  swe: "sv", nor: "no", dan: "da", fin: "fi", heb: "he", ind: "id", ron: "ro",
  hun: "hu", cze: "cs", ces: "cs", ell: "el", gre: "el", ukr: "uk", bul: "bg",
};

/** Crude language-name → 639-1 map for tracks where lang is a full word. */
const LANG_NAME_TO_1: Record<string, string> = {
  english: "en", japanese: "ja", spanish: "es", french: "fr", german: "de",
  italian: "it", portuguese: "pt", russian: "ru", chinese: "zh", korean: "ko",
  arabic: "ar", hindi: "hi", thai: "th", vietnamese: "vi", turkish: "tr",
  polish: "pl", dutch: "nl", swedish: "sv", norwegian: "no", danish: "da",
  finnish: "fi", hebrew: "he", indonesian: "id", romanian: "ro", hungarian: "hu",
  czech: "cs", greek: "el", ukrainian: "uk", bulgarian: "bg",
};

interface NormalizedTrack {
  track: TrackEntry;
  /** 2-letter code, or null when we couldn't recognise the lang. */
  lang2: string | null;
  /** Optional region tag pulled from BCP-47 ("pt-BR" → "BR"). */
  region: string | null;
  excluded: boolean;
}

const COMMENTARY_RE = /\b(commentary|director(?:'s)? notes?|cast (?:and|&) crew|isolated)\b/i;
const DESCRIPTION_RE = /\b(audio description|described|dvs|visual(?:ly)? impaired|hearing impaired)\b/i;
const KARAOKE_RE     = /\b(karaoke|instrumental)\b/i;
const DUB_RE         = /\b(dub|dubbed)\b/i;
const ORIGINAL_RE    = /\b(original|(?:sub)|sub(?:bed|titled))\b/i;

function normalizeLang(raw: string | null | undefined): { lang2: string | null; region: string | null } {
  if (!raw) return { lang2: null, region: null };
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === "und" || trimmed === "mul") return { lang2: null, region: null };

  // BCP-47 form (en-US, pt-BR, …).
  if (trimmed.includes("-")) {
    const [head, tail] = trimmed.split("-", 2);
    const lang2 = head.length === 2
      ? head
      : ISO_639_2_TO_1[head] ?? LANG_NAME_TO_1[head] ?? null;
    const region = tail ? tail.toUpperCase() : null;
    return { lang2, region };
  }

  if (trimmed.length === 2) return { lang2: trimmed, region: null };
  if (trimmed.length === 3) return { lang2: ISO_639_2_TO_1[trimmed] ?? null, region: null };
  return { lang2: LANG_NAME_TO_1[trimmed] ?? null, region: null };
}

/** Public normalizer for stored or user-supplied language tags: maps a raw
 *  mpv `lang` value ("jpn"), a BCP-47 tag ("pt-BR") or a language name
 *  ("Japanese") to a 2-letter 639-1 code. Unrecognised tags fall back to the
 *  trimmed lowercase input so they still round-trip instead of vanishing.
 *
 *  Exported because the SAME normalization has to happen on both sides of
 *  every language comparison. Track tags were already normalized here while
 *  saved per-title preferences and priority tokens were not, so a per-title
 *  pick stored as "jpn" could never match a track scored as "ja" and the
 *  user's explicit choice silently did nothing. */
export function toLang2(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const { lang2 } = normalizeLang(raw);
  if (lang2) return lang2;
  const trimmed = raw.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isExcluded(t: TrackEntry): boolean {
  const blob = `${t.title ?? ""} ${t.codec ?? ""}`;
  return COMMENTARY_RE.test(blob) || DESCRIPTION_RE.test(blob) || KARAOKE_RE.test(blob);
}

/** Build the effective lookup list — substitute "original" with the meta's
 *  language (after the fallback resolver), dedup while preserving order,
 *  append "en" as final fallback. */
function expandPriority(audioPriority: string[], originalLanguage: string | null): string[] {
  const out: string[] = [];
  for (const tok of audioPriority) {
    const t = tok.trim().toLowerCase();
    if (!t) continue;
    if (t === "original") {
      if (originalLanguage) {
        const norm = toLang2(originalLanguage) ?? originalLanguage.toLowerCase();
        if (!out.includes(norm)) out.push(norm);
      }
      continue;
    }
    // Tokens are matched against tracks whose tags went through
    // normalizeLang, so they have to be normalized too. A per-title override
    // arrives here as the raw mpv tag ("jpn") and would otherwise never match.
    const norm = toLang2(t) ?? t;
    if (!out.includes(norm)) out.push(norm);
  }
  if (!out.includes("en")) out.push("en");
  return out;
}

export function pickDefaultAudio(
  tracks: TrackEntry[],
  meta: ScoringMeta,
  prefs: ScoringPrefs,
): TrackEntry | null {
  const audio = tracks.filter((t) => t.type === "audio");
  if (audio.length === 0) return null;

  // Stage 1: hard-exclude commentary / AD / karaoke.
  const survivors: NormalizedTrack[] = audio.map((t) => {
    const { lang2, region } = normalizeLang(t.lang);
    return { track: t, lang2, region, excluded: isExcluded(t) };
  });
  const safe = survivors.filter((s) => !s.excluded);
  if (safe.length === 0) return null;

  // If this is a single-track file with no language tag and it survived
  // step 1, just return it — refusing to play a `und` single-track file
  // is worse than refusing to pick anything.
  if (safe.length === 1) return safe[0].track;

  // Stage 3: build effective priority list. Run the original-language
  // fallback resolver BEFORE expanding so the "original" token still
  // resolves even when AIOMetadata's cached blob predates the
  // `originalLanguage` field.
  const resolvedOriginal = resolveOriginalLanguage(meta);
  const wanted = expandPriority(prefs.audio_priority, resolvedOriginal);

  // Stage 4: score.
  type Scored = { entry: NormalizedTrack; score: number };
  const scored: Scored[] = [];
  for (const entry of safe) {
    if (!entry.lang2) continue; // disqualified
    const idx = wanted.indexOf(entry.lang2);
    if (idx < 0) continue; // disqualified — language not in the user's list

    let score = 1000 - idx * 50;

    const blob = `${entry.track.title ?? ""}`;
    // Disposition fall-back: title-regex. Don't apply if we already
    // matched the language tag — DUB_RE on a title like "English Dub"
    // shouldn't double-penalise tracks that are correctly tagged.
    // Original/dub bumps: prefer tracks whose title hints at the right
    // kind, especially when avoid_dubs is set.
    const looksOriginal = ORIGINAL_RE.test(blob);
    const looksDub      = DUB_RE.test(blob);
    if (looksOriginal && !looksDub) score += 80;
    if (looksDub) score -= prefs.avoid_dubs ? 200 : 30;

    // Region tiebreak — only when both sides have a region.
    if (entry.region) {
      if (meta.production_countries.includes(entry.region)) score += 40;
      else if (prefs.user_region && entry.region === prefs.user_region.toUpperCase()) score += 20;
    }

    if (entry.track.selected) score += 10;

    scored.push({ entry, score });
  }

  if (scored.length === 0) {
    // No language matches at all → graceful fallback to the first
    // non-excluded track (typically the file's actual default).
    return safe[0].track;
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0].entry.track;
}
