// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { StreamEntry } from "./types";

// ---------------------------------------------------------------------------
// streamMeta — extract structured chip data from an addon's stream output.
//
// AIOStreams (https://docs.aiostreams.viren070.me/reference/custom-formatter/)
// emits the bulk of metadata as a glyph-tagged multi-line string in two
// fields on a stream: `title` (the "Name") and `description`. Each line
// in those fields is identified by a LEADING glyph; the rest of the line
// is the field value. We walk lines, classify each by glyph, and extract
// the value into a typed structure. Lines we don't recognise stay in
// `extra` so we never silently drop content.
//
// For non-AIOStreams addons (legacy Torrentio / Comet emit looser title
// strings) we fall back to a regex pass over the same body so basic chips
// (resolution, ripType, size, seeders) still populate.
// ---------------------------------------------------------------------------

export interface ParsedStream {
  /** Top-line release name with parsed tokens stripped — what the UI
   *  shows next to the quality summary. */
  primary: string;
  /** Remaining lines from the addon's title (also token-stripped).
   *  Empty after a clean AIOStreams parse; non-empty only when there's
   *  unrecognised content we don't want to drop. */
  extra: string[];

  // ── LEFT-COLUMN summary fields. ────────────────────────────────────
  resolution: string | null;        // "1080p" / "4K" / "720p" …
  /** AIOStreams' canonical quality string from `〈〉`. When present this
   *  wins over `ripType` (regex fallback). */
  quality: string | null;
  ripType: string | null;           // "WEB-DL" / "BluRay" / "HDTV" / "REMUX" …
  /** Star count parsed from the title's ★ / ☆ glyphs. 0 when not present. */
  stars: number;
  /** Debrid-cache hint extracted from the title:
   *   "cached"   → ⚡ symbol present (instant playback on debrid)
   *   "uncached" → ⏳ / hourglass symbol present (queued)
   *   null       → no cached signal in the title */
  cachedStatus: "cached" | "uncached" | null;
  /** Source-type marker from the Name field's superscript-paren tag —
   *  ⁽ᵖ²ᵖ⁾, ⁽ˡᶦᵛᵉ⁾, ⁽ʷᵉᵇ⁾, ⁽ⁿᶻᵇ⁾, ⁽ᶦⁿᶠᵒ⁾, ⁽ˢᵗᵃᵗˢ⁾, ⁽ᵉˣᵗ⁾, ⁽ᵉʳʳᵒʳ⁾, ⁽ʸᵗ⁾.
   *  After NFKC these collapse to "(p2p)", "(live)", … */
  streamType:
    | "p2p" | "live" | "web" | "nzb" | "info" | "stats" | "ext" | "error" | "yt"
    | null;

  // ── TITLE/EPISODE row. ──────────────────────────────────────────────
  /** Display title from `✎`, `☁︎` or `➤`. */
  displayTitle: string | null;
  /** Whether the entry is flagged from the user's library (☁︎). */
  library: boolean;
  /** Whether the addon flagged the entry as preloading to a debrid service
   *  (`➤`). AIOStreams added this as a THIRD title glyph alongside ☁︎ / ✎. */
  preloading: boolean;
  /** Year in `(YYYY)` after the title, or the whole range for a multi-year
   *  title (`"2017-19"`). Also filled from `date` when the addon emits a
   *  full air date instead of a bare year. Display only, never parsed as a
   *  number. */
  year: string | null;
  /** Air / release date from the title line, e.g. "5 Jul 2026". Newer
   *  AIOStreams TamTaro emits this in place of the bare `(YYYY)` token. */
  date: string | null;
  /** SxxEyy-style episode tag if episodic. */
  episode: string | null;

  // ── ENCODE / VISUAL / AUDIO. ───────────────────────────────────────
  /** Codec from `▣`. e.g. "HEVC", "AVC", "x264". */
  encode: string | null;
  /** Primary visual tags from `✦` — HDR / DV / HDR10 / HDR10+. */
  visualTagsPrimary: string[];
  /** Secondary visual tags from `✧` — IMAX / 3D / etc. */
  visualTagsSecondary: string[];
  /** Audio codec tags from `♬` — DD / DTS / ATMOS / TrueHD / FLAC / OPUS / AAC. */
  audioTags: string[];
  /** Audio channel tags from `♯` — 5.1 / 7.1 / 2.0. */
  audioChannels: string[];

  // ── SIZE / BITRATE / SEEDERS / AGE. ────────────────────────────────
  /** Size in user-readable form, e.g. "12.6 GB". */
  size: string | null;
  /** Whether the size came from `❖` (season pack) instead of `◈`. */
  seasonPack: boolean;
  /** Folder size after `/` separator. */
  folderSize: string | null;
  /** Bit-rate, e.g. "12.5 Mbps". */
  bitrate: string | null;
  /** Seeders count parsed from `⇄ N❦`. */
  seeders: number | null;
  /** Age string after seeders (`· 2 days`). */
  age: string | null;

  // ── PROXY / SERVICE / ADDON. ───────────────────────────────────────
  /** VPS-proxy state encoded by AIOStreams' shield glyphs.
   *
   *   • "on"   — addon stream is being routed through a VPS / debrid
   *              proxy (filled glyph `⛊` or legacy 🛡).
   *   • "self" - NOT proxied, but the addon host is itself the ORIGIN:
   *              AIOStreams' built-in usenet engine (`service.shortName`
   *              `AIO`) streams from the operator's own NNTP providers, so
   *              the bytes come off the AIOStreams box rather than a debrid
   *              CDN. `stream.proxied` is correctly false for these (it means
   *              MediaFlow-style proxying), which made the outline `⛉` badge
   *              read as "direct from a third party" when the traffic was in
   *              fact leaving via the addon's IP. Distinct state, not folded
   *              into "on": the mechanism differs even though both keep the
   *              connection on the addon host.
   *   • "off"  — addon explicitly emits the outline glyph `⛉` to
   *              indicate the user has disabled their VPS proxy AND
   *              the stream is being delivered direct.
   *   • null   — addon doesn't speak the AIOStreams proxy convention
   *              at all (most legacy addons). The chip is hidden.
   *
   * The render layer turns "on" into a teal pill with a filled shield
   * and "off" into a red pill with a hollow shield so users can tell
   * at a glance whether their VPS toggle is actually being honoured by
   * the addon. Earlier versions used `proxied: boolean` and a fallback
   * regex that matched both shield glyphs, which silently coerced
   * "off" → "on" and made the badge useless as a state indicator. */
  proxyState: "on" | "self" | "off" | null;
  /** Debrid service short code from `[TB]` / `[RD]` / `[AD]` / `[PM]` etc. */
  serviceShort: string | null;
  /** Addon display name parsed from the description (distinct from
   *  StreamEntry.addon_name set by Rust). */
  addonName: string | null;

  // ── RELEASE / TRACKER. ─────────────────────────────────────────────
  /** Private-tracker flag (`⚿ private`). */
  private: boolean;
  /** Release group or indexer (depending on stream type). */
  releaseGroup: string | null;
  /** Indexer name (separate when both group and indexer are present). */
  indexer: string | null;

  // ── LANGUAGES / SUBS. ──────────────────────────────────────────────
  /** Language codes from `⛿` (e.g. ["JP", "EN"]). */
  languages: string[];
  /** Whether the entry has a `· sub` flag after languages. */
  subbed: boolean;
  /** Subtitle codes from the trailing parens after `⛿`. */
  subtitles: string[];

  // ── METADATA FLAGS (after ` » ` separator). ────────────────────────
  /** Seadex "best release" flag. */
  seadexBest: boolean;
  /** Seadex "alt best" flag. */
  seadexAlt: boolean;
  /** NZB health classification. */
  nzbHealth: "verified" | "elf" | "unverified" | "broken" | null;
  /** Trailing subscript score (e.g. ₂₅ → 25, ₋₅ → -5). */
  seScore: number | null;
  /** Whatever remains after the ` » ` separator once seadex / NZB / score are
   *  taken out: AIOStreams' release-scoring matches, plus the newer
   *  `stream.network` and `stream.editions` fields. Kept as free text so new
   *  upstream additions surface as chips instead of being silently swallowed. */
  releaseFlags: string[];

  // ── LEGACY fallback fields (kept for compatibility). ───────────────
  /** Codec — kept for back-compat with non-AIOStreams parsing. Mirrors
   *  `encode` when AIOStreams glyph parsing fired. */
  codec: string | null;
  /** HDR/DV summary string ("HDR" / "DV" / "DV+HDR") for legacy callers. */
  hdr: string | null;
  /** Compact audio summary ("DDP5.1") for legacy callers. */
  audio: string | null;
  /** Best-effort first language tag. */
  language: string | null;
  /** Bit-depth ("8bit" / "10bit"). */
  bitDepth: string | null;
}

// ---------------------------------------------------------------------------
// Regex toolbox.
// ---------------------------------------------------------------------------

const RES_RX        = /\b(2160p|1440p|1080p|720p|480p|360p|4K|2K|UHD|HD)\b/i;
const RIP_RX        = /(REMUX|BluRay|BLU[-\s.]?RAY|WEB[-\s.]?DL|WEB[-\s.]?RIP|WEBRip|HC[-\s.]?HDRip|HDRip|BRRip|BDRip|DVDRip|HDTV|HDTC|TELESYNC|VHS)/i;
const CODEC_RX      = /\b(HEVC|H\.?265|x265|H\.?264|x264|AV1|VP9|MPEG[\s-]?2|AVC)\b/i;
const HDR_RX        = /\b(DV\+HDR|HDR10\+?|HDR|Dolby[\s-]?Vision|DV)\b/i;
const AUDIO_RX      = /\b(Atmos|TrueHD|DTS-HD(?:\s?MA)?|DTS-X|DTS|DDP[\s-]?\d(?:\.\d)?|DD[\s-]?\d(?:\.\d)?|EAC3|AC3|AAC|FLAC|OPUS)\b/i;
const SIZE_RX       = /(\d+(?:[.,]\d+)?)\s*(TB|GB|MB)\b/i;
const SEEDER_RX_LEGACY_A = /(?:👤|👥)\s*([\d.,]+\s*[Kk]?)/u;
const SEEDER_RX_LEGACY_B = /\b(?:Seeders?|S)\s*[:=]\s*(\d+)/i;
const RELGROUP_RX   = /\[([A-Z0-9.\-]{2,16})\]\s*$/i;
const LANG_RX       = /\b(EN|EN-US|ENG|JA|JP|JPN|ES|ESP|FR|FRE|DE|GER|IT|ITA|PT|POR|KR|KOR|CN|CHI|RU|RUS|HI|HIN|AR|TR)\b/;
// Stars from AIOStreams. Solid ★ counts as 1, hollow ☆ as half.
const STAR_RX       = /[★☆]/g;
// Debrid cache hints. AIOStreams emits ⚡ for cached, ⌛/⏳ for uncached.
const CACHED_RX     = /[⚡⚡️]/u;
const UNCACHED_RX   = /[⌛⏳]/u;
// Bit-rate (Mbps / Kbps) — case-insensitive after NFKC collapses superscripts.
const BITRATE_RX    = /(\d+(?:[.,]\d+)?)\s*(Mbps|Kbps|kbps|mbps)\b/i;
// Bit depth — "10bit" / "8 bit".
const BITDEPTH_RX   = /(8|10|12)\s*-?\s*bit\b/i;
// Quality in chevrons — AIOStreams' canonical quality string.
const QUALITY_RX    = /〈([^〉]+)〉/u;
// Episode tag — after NFKC + smallcaps map, AIOStreams' `s₀₁·ᴇ₀₅`
// collapses to `s01·E05`. We match it as a STANDALONE token (preceded by
// start-of-string or whitespace, NOT by a `.` — that would be a filename
// like `Show.Name.S01E10.1080p` whose episode marker we want to PRESERVE
// in the displayTitle).
const EPISODE_STANDALONE_RX = /(?:^|\s)s\s*(\d{1,3})\s*[·‧•\-\s]+E\s*(\d{1,3})\b/i;
// Year token on the title line. Matches a bare `(2024)` and also the RANGE
// form newer TamTaro emits for multi-year titles - the template rewrites
// `2017-2019` to `2017-19` (`::replace('-20','-')`), which the old
// four-digits-then-paren pattern rejected outright, leaving `(2017-19)`
// stranded in the display title with no year chip. Capture group 1 is the
// START year in both shapes.
const YEAR_TOKEN_RX = /(?:^|\s)\(((?:19|20)\d{2}(?:\s*-\s*\d{2,4})?)\)/;
// Air / release date on the title line. AIOStreams formats it `%-d %b %Y`
// (no zero padding, abbreviated English month), e.g. "5 Jul 2026". Newer
// TamTaro emits this INSTEAD of the bare `(YYYY)` token for series, so the
// year has to be recovered from it or the year chip disappears.
const DATE_RX       = /(?:^|\s)(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+((?:19|20)\d{2}))\b/i;
// Service short code in brackets — `[TB]`, `[RD]`, `[AD]`, `[PM]`, etc.
// 2-3 uppercase letters/digits.
const SERVICE_RX    = /\[([A-Z]{2,3})\]/;
// Subscript digit map — ₀₁₂₃₄₅₆₇₈₉ NFKC to plain digits, but the minus
// sign ₋ is U+208B which ALSO maps via NFKC to "-". After NFKC a string
// like `₂₅` becomes `25` and `₋₅` becomes `-5`. We grep for trailing
// integer-like sequences AFTER NFKC.
const SCORE_TRAIL_RX = /(?:^|\s)(-?\d+)\s*$/;
// Section break — AIOStreams emits ` » ` (with surrounding spaces) as
// the hard separator between body and metadata flags.
const SECTION_BREAK = "»";

// Glyphs we recognise as line-leading markers in the description. The
// classifier walks each line, finds the first non-whitespace character,
// and dispatches based on it.
const GLYPH_TITLE       = "✎";   // ✎ U+270E
const GLYPH_LIBRARY     = "☁";   // ☁ U+2601 (also matches ☁︎ - VS stripped)
const GLYPH_PRELOAD     = "➤";   // ➤ U+27A4 - third title glyph (preloading)
const GLYPH_ENCODE      = "▣";   // ▣ U+25A3
const GLYPH_VISUAL_PRI  = "✦";   // ✦ U+2726
const GLYPH_VISUAL_SEC  = "✧";   // ✧ U+2727
const GLYPH_AUDIO       = "♬";   // ♬ U+266C
const GLYPH_CHANNELS    = "♯";   // ♯ U+266F
const GLYPH_SIZE_PACK   = "❖";   // ❖ U+2756
const GLYPH_SIZE_SINGLE = "◈";   // ◈ U+25C8
const GLYPH_SEEDERS     = "⇄";   // ⇄ U+21C4
const GLYPH_PROXY_FILL  = "⛊";   // ⛊ U+26CA
const GLYPH_PROXY_OUT   = "⛉";   // ⛉ U+26C9
const GLYPH_LANG        = "⛿";   // ⛿ U+26FF - languages, no subtitles
const GLYPH_LANG_SUBBED = "✓";   // ✓ U+2713 - languages, subtitles present
const GLYPH_PRIVATE     = "⚿";   // ⚿ U+26BF

/** The glyphs unique to AIOStreams' "TamTaro" format that the parser keys on.
 *  Used by `looksLikeTamTaro` for auto-detection. */
const TAMTARO_SIGNATURE_GLYPHS = [
  GLYPH_TITLE, GLYPH_LIBRARY, GLYPH_PRELOAD, GLYPH_ENCODE, GLYPH_VISUAL_PRI,
  GLYPH_VISUAL_SEC, GLYPH_AUDIO, GLYPH_CHANNELS, GLYPH_SIZE_PACK,
  GLYPH_SIZE_SINGLE, GLYPH_SEEDERS, GLYPH_PROXY_FILL, GLYPH_PROXY_OUT,
  GLYPH_LANG, GLYPH_PRIVATE,
];

/** Glyphs that OPEN a tagged segment, for the line splitter below.
 *
 *  AIOStreams packs SEVERAL tagged segments onto ONE physical line - e.g.
 *  `▣  HEVC  ✦  HDR  ♬  DD+  ♯ 5.1` is a single line of addon output. An
 *  earlier version of this parser dispatched on the line's FIRST character
 *  and then consumed the whole line, so everything after the first segment
 *  was silently discarded (audio channels and seeders never populated at all,
 *  and visual tags vanished whenever a codec was present). We split on the
 *  glyphs instead, so each segment is parsed on its own and the layout
 *  upstream chooses stops mattering.
 *
 *  `⚿` is deliberately NOT a delimiter: it sits INSIDE the proxy/addon
 *  segment, between the addon name and the release group, so splitting there
 *  would orphan the group. `parseProxyServiceAddon` strips it inline.
 *  `✓` IS a delimiter - newer TamTaro leads the language segment with it
 *  (instead of `⛿`) whenever the stream carries subtitles. */
const SEGMENT_GLYPHS = [
  GLYPH_TITLE, GLYPH_LIBRARY, GLYPH_PRELOAD, GLYPH_ENCODE, GLYPH_VISUAL_PRI,
  GLYPH_VISUAL_SEC, GLYPH_AUDIO, GLYPH_CHANNELS, GLYPH_SIZE_PACK,
  GLYPH_SIZE_SINGLE, GLYPH_SEEDERS, GLYPH_PROXY_FILL, GLYPH_PROXY_OUT,
  GLYPH_LANG, GLYPH_LANG_SUBBED,
];
const SEGMENT_SPLIT_RX = new RegExp(`(?=[${SEGMENT_GLYPHS.join("")}])`, "u");

/** Split a description line into glyph-led segments. The first element has an
 *  empty `glyph` when the line opens with untagged text (a bare `(YYYY)`
 *  continuation line, or free-form residue). */
function splitSegments(line: string): { glyph: string; value: string }[] {
  return line
    .split(SEGMENT_SPLIT_RX)
    .filter((part) => part.length > 0)
    .map((part) => {
      const glyph = SEGMENT_GLYPHS.includes(part[0]) ? part[0] : "";
      return { glyph, value: glyph ? part.slice(glyph.length).trim() : part.trim() };
    });
}

/** Heuristic: does this stream use the TamTaro glyph-tagged format the parser
 *  is built for? Plain-label (Torrentio) and other emoji formats score 0, so
 *  the UI can detect them and offer to fall back to raw output. Two distinct
 *  signature glyphs is enough — a real TamTaro stream carries many. */
export function looksLikeTamTaro(s: StreamEntry): boolean {
  const body = `${s.title ?? ""}\n${s.description ?? ""}`;
  let hits = 0;
  for (const g of TAMTARO_SIGNATURE_GLYPHS) {
    if (body.includes(g) && (hits += 1) >= 2) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Normalisation helpers.
// ---------------------------------------------------------------------------

/** Map of Unicode "smallcaps Latin" letters that NFKC does NOT decompose
 *  to ASCII counterparts. AIOStreams pulls these from a few different
 *  Unicode blocks:
 *    • U+1D00-U+1D7F  (Phonetic Extensions)
 *    • U+0250-U+02AF  (IPA Extensions — `ɴ` U+0274, `ʙ` U+0299, …)
 *  Regular ASCII `s`/`x` are already lowercase ASCII; they don't need
 *  remapping but we include them as identity entries for completeness.
 *  AIOStreams uses these heavily for `ʙᴇsᴛ ʀᴇʟᴇᴀsᴇ`, `ɴᴢʙ`, language
 *  flag codes, etc. — so we have to handle them ourselves. */
const SMALLCAPS_MAP: Record<string, string> = {
  // Phonetic Extensions / Latin Extended-D smallcaps.
  "ᴀ": "A", "ᴄ": "C", "ᴅ": "D", "ᴇ": "E", "ꜰ": "F", "ɢ": "G",
  "ʜ": "H", "ɪ": "I", "ᴊ": "J", "ᴋ": "K", "ʟ": "L", "ᴍ": "M",
  "ᴏ": "O", "ᴘ": "P", "ǫ": "Q", "ʀ": "R", "ᴛ": "T", "ᴜ": "U",
  "ᴠ": "V", "ᴡ": "W", "ʏ": "Y", "ᴢ": "Z",
  // IPA Extensions block — `ʙ` (U+0299) and `ɴ` (U+0274) are the
  // smallcaps glyphs AIOStreams emits for B and N.
  "ʙ": "B",
  "ɴ": "N",
  // HOMOGLYPHS. Older TamTaro deliberately swapped three smallcaps letters
  // for look-alikes from other scripts (`::replace('F','ғ')` etc.) because
  // the true smallcaps forms render badly in some clients. They are NOT
  // decomposed by NFKC, so without these entries `ᴜɴᴠᴇʀɪғɪᴇᴅ ɴᴢʙ` normalised
  // to "UNVERIғIED NZB" and the NZB-health regex below never matched. The
  // newer format dropped the swap from the language codes but still emits
  // `ғ` inside the hardcoded unverified-NZB string, and old-format streams
  // are still in the wild - so both spellings have to keep working.
  "ғ": "F",   // U+0493 Cyrillic ghe with stroke
  "х": "X",   // U+0445 Cyrillic small ha
  "ϙ": "Q",   // U+03D9 Greek koppa
  "ꜱ": "S",   // U+A731 Latin letter small capital S
};

// ── Build the FULL smallcaps regex once, including all keys from the map.
// Some keys are multi-block; build a character class from the keys.
const SMALLCAPS_RX = (() => {
  const escaped = Object.keys(SMALLCAPS_MAP).map((k) =>
    k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return new RegExp(`(?:${escaped.join("|")})`, "gu");
})();

/** Collapse Unicode superscripts / smallcaps / subscripts to ASCII via
 *  NFKC, then apply manual smallcaps-Latin → uppercase mapping for
 *  blocks NFKC leaves untouched. Also forces every dash variant to a
 *  plain `-` and strips VS-16 selectors. */
function normaliseLineForRegex(s: string): string {
  let out = s
    .normalize("NFKC")
    // Strip BOTH variation selectors. VS-16 (U+FE0F, emoji presentation) and
    // VS-15 (U+FE0E, text presentation) - the library glyph is emitted as
    // `☁︎` = U+2601 U+FE0E, and a surviving VS-15 rode along into the parsed
    // display title as an invisible leading character.
    .replace(/[\u{FE0E}\u{FE0F}]/gu, "")
    .replace(/[‐‑‒–—−]/g, "-");
  // Smallcaps → ASCII (preserves case as uppercase for visibility).
  out = out.replace(SMALLCAPS_RX, (c) => SMALLCAPS_MAP[c] ?? c);
  return out;
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Walks the string and drops any `(` / `[` that has no matching close
 *  (and vice versa). Token-strip frequently produces those when the
 *  parsed token sat at one edge of a parenthesised group with other
 *  content next to it. */
function rebalanceWrappers(s: string): string {
  const stack: number[] = [];
  const drop = new Set<number>();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") {
      stack.push(i);
    } else if (c === ")" || c === "]") {
      if (stack.length === 0) drop.add(i);
      else stack.pop();
    }
  }
  for (const i of stack) drop.add(i);
  if (drop.size === 0) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) if (!drop.has(i)) out += s[i];
  return out;
}

function cleanupResidue(s: string): string {
  let out = s;
  let prev = "";
  while (out !== prev) {
    prev = out;
    out = rebalanceWrappers(out)
      .replace(/[\(\[]\s*[\)\]]/g, " ")
      .replace(/[\(\[]\s*[·•|:,\-\s]+\s*[\)\]]/g, " ")
      .replace(/\s*[·•|:]+\s*/g, " ")
      .replace(/^[·•|:,\-\s]+/, "")
      .replace(/[·•|:,\-\s]+$/, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-line classifier helpers.
// ---------------------------------------------------------------------------

/** Whitespace AND zero-width / bidi-format characters that `String.trim()`
 *  leaves behind. An addon that emits a stray U+200B (or similar) as a field
 *  value would otherwise survive as a "blank but not empty" token and render
 *  as an empty chip next to its category icon. */
const INVISIBLE_RX = /[\s ​-‏‪-‮⁠﻿]+/gu;

/** True when `s` has at least one VISIBLE character (not just whitespace /
 *  zero-width / bidi marks). */
function hasVisible(s: string): boolean {
  return s.replace(INVISIBLE_RX, "").length > 0;
}

/** Split a value on `·` / `•` separators (after NFKC). Returns trimmed tokens
 *  that contain at least one visible character (drops blank/zero-width-only
 *  tokens so they never render as empty chips). */
function splitOnDot(s: string): string[] {
  return s
    .split(/[·•]/)
    .map((t) => t.trim())
    .filter((t) => hasVisible(t));
}

function parseSeederValue(raw: string): { count: number | null; age: string | null } {
  // Examples after NFKC:
  //   "245❦"               → 245 seeders, no age
  //   "245❦ · 2 days"      → 245 seeders, "2 days"
  //   "1.2K❦"              → 1200 seeders
  // The ❦ glyph follows the count. Anything after the first `·` is age.
  const dot = raw.indexOf("·");
  const head = dot >= 0 ? raw.slice(0, dot).trim() : raw.trim();
  const tail = dot >= 0 ? raw.slice(dot + 1).trim() : null;

  const m = /([\d.,]+\s*[Kk]?)/.exec(head);
  let count: number | null = null;
  if (m) {
    let s = m[1].replace(/,/g, ".").trim();
    let mult = 1;
    if (/[Kk]$/.test(s)) { mult = 1000; s = s.slice(0, -1); }
    const n = parseFloat(s);
    if (isFinite(n)) count = Math.round(n * mult);
  }
  return { count, age: tail };
}

/** Parse the size line — handles size, optional `/folderSize`, optional
 *  `· bitrate`. */
function parseSizeLine(raw: string): {
  size: string | null;
  folderSize: string | null;
  bitrate: string | null;
} {
  let size: string | null = null;
  let folderSize: string | null = null;
  let bitrate: string | null = null;

  // Bitrate may sit at the tail after `·`. Pull it out first.
  const dot = raw.lastIndexOf("·");
  let head = raw;
  if (dot >= 0) {
    const tail = raw.slice(dot + 1).trim();
    const br = BITRATE_RX.exec(tail);
    if (br) {
      bitrate = `${br[1]} ${br[2].slice(0, 1).toUpperCase()}${br[2].slice(1).toLowerCase()}`;
      head = raw.slice(0, dot).trim();
    }
  }

  // Size and optional folder size.
  const slash = head.indexOf("/");
  if (slash >= 0) {
    const headPart = head.slice(0, slash);
    const sm = SIZE_RX.exec(headPart);
    const fm = SIZE_RX.exec(head.slice(slash + 1));
    if (fm) folderSize = `${fm[1]} ${fm[2].toUpperCase()}`;
    if (sm) {
      size = `${sm[1]} ${sm[2].toUpperCase()}`;
    } else if (fm) {
      // Newer TamTaro drops the unit off the FILE size when it and the folder
      // size share one, emitting `12.6 / 45.2 GB`. A bare number matches no
      // unit, so `size` parsed as null - and the fullBody fallback further
      // down then re-filled it with the first size-shaped token in the body,
      // which is the FOLDER size. The chip showed a plausible but wrong
      // number, which is worse than showing none. Inherit the folder's unit.
      const bare = /(?:^|\s)(\d+(?:[.,]\d+)?)\s*$/.exec(headPart);
      if (bare) size = `${bare[1]} ${fm[2].toUpperCase()}`;
    }
  } else {
    const sm = SIZE_RX.exec(head);
    if (sm) size = `${sm[1]} ${sm[2].toUpperCase()}`;
  }

  // Bitrate sometimes follows the size directly (no `·` if NFKC ate it).
  if (!bitrate) {
    const br = BITRATE_RX.exec(raw);
    if (br) {
      bitrate = `${br[1]} ${br[2].slice(0, 1).toUpperCase()}${br[2].slice(1).toLowerCase()}`;
    }
  }

  return { size, folderSize, bitrate };
}

/** Parse the proxy/service/addon line:
 *    "⛊ [TB] Comet · GROUP"
 *    "⛉ AIOStreams"
 *    "⛊ [RD] AIOStreams · indexerName"
 */
function parseProxyServiceAddon(raw: string): {
  serviceShort: string | null;
  addonName: string | null;
  releaseGroupOrIndexer: string | null;
  privateFlag: boolean;
} {
  let s = raw.trim();
  let serviceShort: string | null = null;
  let addonName: string | null = null;
  let releaseGroupOrIndexer: string | null = null;
  let privateFlag = false;

  // Service in [BRACKETS].
  const svc = SERVICE_RX.exec(s);
  if (svc) {
    serviceShort = svc[1];
    s = s.replace(SERVICE_RX, "").trim();
  }

  // Private flag — `⚿ private` after the addon name. Detect anywhere on
  // the line; remove the marker so it doesn't pollute the addon name.
  if (s.includes(GLYPH_PRIVATE) || /\bprivate\b/i.test(s)) {
    privateFlag = true;
    s = s.replace(new RegExp(GLYPH_PRIVATE, "g"), "").replace(/\bprivate\b/ig, "").trim();
  }

  // Split on `·` — first token is addon name, second is release group / indexer.
  const parts = splitOnDot(s);
  if (parts.length > 0) addonName = parts[0] || null;
  if (parts.length > 1) releaseGroupOrIndexer = parts.slice(1).join(" · ") || null;

  return { serviceShort, addonName, releaseGroupOrIndexer, privateFlag };
}

/** Parse the language line:
 *    "JP · EN"             → ["JP", "EN"], no sub
 *    "JP · EN · sub (EN)"  → ["JP", "EN"], subbed = true, subs = ["EN"]
 */
function parseLanguageLine(raw: string): {
  languages: string[];
  subbed: boolean;
  subtitles: string[];
} {
  let s = raw.trim();
  const subtitles: string[] = [];
  let subbed = false;

  // Trailing subtitle codes in parens.
  const subParen = /\(([^)]+)\)\s*$/.exec(s);
  if (subParen) {
    subtitles.push(...splitOnDot(subParen[1]).map((c) => c.toUpperCase()));
    s = s.slice(0, subParen.index).trim();
  }

  // `· sub` flag.
  s = s.replace(/[·•]\s*sub\b/i, () => { subbed = true; return ""; }).trim();
  if (/^sub\b/i.test(s) || /\bsub$/i.test(s)) {
    subbed = true;
    s = s.replace(/\bsub\b/i, "").trim();
  }

  // What's left is the language list.
  const languages = splitOnDot(s).map((c) => c.toUpperCase());
  return { languages, subbed, subtitles };
}

/** Parse the trailing metadata flags line (after ` » `):
 *    "best release ☑ NZB 25"
 *    "alt best release"
 *    "elf NZB"
 *    "✘NZB -5"
 */
function parseMetadataFlags(raw: string): {
  seadexBest: boolean;
  seadexAlt: boolean;
  nzbHealth: "verified" | "elf" | "unverified" | "broken" | null;
  seScore: number | null;
  flags: string[];
} {
  let s = raw.trim();
  let seadexBest = false;
  let seadexAlt = false;
  let nzbHealth: "verified" | "elf" | "unverified" | "broken" | null = null;
  let seScore: number | null = null;

  // Trailing score — must run before NZB flag detection because the
  // score can be a bare digit run that gets eaten by NZB regex otherwise.
  const sm = SCORE_TRAIL_RX.exec(s);
  if (sm) {
    const n = parseInt(sm[1], 10);
    if (isFinite(n)) {
      seScore = n;
      s = s.slice(0, sm.index).trim();
    }
  }

  // Seadex tags. `alt best release` MUST run before plain `best release`.
  if (/\balt\s+best\s+release\b/i.test(s)) {
    seadexAlt = true;
    s = s.replace(/\balt\s+best\s+release\b/i, "").trim();
  } else if (/\bbest\s+release\b/i.test(s)) {
    seadexBest = true;
    s = s.replace(/\bbest\s+release\b/i, "").trim();
  }

  // NZB health. AIOStreams tags these with EMOJI, not the `☑` / plain words
  // this parser originally looked for - the template rewrites its upstream
  // health strings to `✅ ɴᴢʙ`, `🧝 ɴᴢʙ`, `💚 ɴᴢʙ`, `ᴜɴᴠᴇʀɪғɪᴇᴅ ɴᴢʙ` and
  // `✘ɴᴢʙ`. Only the broken case ever matched; verified and elf silently never
  // fired, and unverified was blocked by the `ғ` homoglyph that the smallcaps
  // map now folds back to F. Order matters: `broken` and `unverified` are
  // checked before `verified` so neither is swallowed by a looser pattern.
  const NZB_PATTERNS: [RegExp, "verified" | "elf" | "unverified" | "broken"][] = [
    [/(?:✘|🚫)\s*NZB|\bbroken\s*NZB\b/i,     "broken"],
    [/(?:⚠\s*)?\bunverified\s*NZB\b/i,       "unverified"],
    [/(?:🧝|💚)\s*NZB|\belf\s*NZB\b/i,        "elf"],
    [/(?:✅|☑)\s*NZB|\bverified\s*NZB\b/i,    "verified"],
  ];
  for (const [rx, health] of NZB_PATTERNS) {
    if (rx.test(s)) {
      nzbHealth = health;
      s = s.replace(rx, " ").trim();
      break;
    }
  }

  // Whatever survives is AIOStreams' release-scoring matches plus the newer
  // `stream.network` / `stream.editions` fields. They used to be discarded
  // here without a trace; keep them as free text so an upstream addition
  // shows up as a chip instead of vanishing.
  const leftover = cleanupResidue(s);
  const flags = leftover.length === 0
    ? []
    : [leftover.length > 60 ? `${leftover.slice(0, 59)}…` : leftover];

  return { seadexBest, seadexAlt, nzbHealth, seScore, flags };
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

export function parseStream(s: StreamEntry): ParsedStream {
  // Split title and description into normalised lines. We keep them
  // separate — the title line is treated as the "Name" field (resolution
  // / streamType / quality / stars / cache), the description as the
  // glyph-tagged body.
  const titleLines = (s.title ?? "")
    .split(/\r?\n/)
    .map((l) => normaliseLineForRegex(l).trim())
    .filter((l) => l.length > 0);
  const descLines = (s.description ?? "")
    .split(/\r?\n/)
    .map((l) => normaliseLineForRegex(l).trim())
    .filter((l) => l.length > 0);

  // ── Initialise output. ──────────────────────────────────────────────
  const out: ParsedStream = {
    primary: "",
    extra: [],
    resolution: null,
    quality: null,
    ripType: null,
    stars: 0,
    cachedStatus: null,
    streamType: null,
    displayTitle: null,
    library: false,
    preloading: false,
    year: null,
    date: null,
    episode: null,
    encode: null,
    visualTagsPrimary: [],
    visualTagsSecondary: [],
    audioTags: [],
    audioChannels: [],
    size: null,
    seasonPack: false,
    folderSize: null,
    bitrate: null,
    seeders: null,
    age: null,
    proxyState: null,
    serviceShort: null,
    addonName: null,
    private: false,
    releaseGroup: null,
    indexer: null,
    languages: [],
    subbed: false,
    subtitles: [],
    seadexBest: false,
    seadexAlt: false,
    nzbHealth: null,
    seScore: null,
    releaseFlags: [],
    codec: null,
    hdr: null,
    audio: null,
    language: null,
    bitDepth: null,
  };

  // Body string for legacy/fallback regex passes — covers BOTH title and
  // description so a non-AIOStreams addon with everything in `title` still
  // populates basic fields.
  const fullBody = [...titleLines, ...descLines].join(" │ ");

  // ── 1) Parse the Name (title) field. ────────────────────────────────
  const nameLine = titleLines.join(" ");
  // Resolution.
  const resMatch = RES_RX.exec(nameLine) ?? RES_RX.exec(fullBody);
  if (resMatch) out.resolution = normaliseRes(resMatch[1]);
  // Quality from `〈〉`.
  const qualityMatch = QUALITY_RX.exec(nameLine) ?? QUALITY_RX.exec(fullBody);
  if (qualityMatch) out.quality = normaliseQuality(qualityMatch[1]);
  // Cached / uncached.
  if (CACHED_RX.test(nameLine)) out.cachedStatus = "cached";
  else if (UNCACHED_RX.test(nameLine)) out.cachedStatus = "uncached";
  // Stars.
  const starGlyphs = nameLine.match(STAR_RX) ?? [];
  const solid = starGlyphs.filter((g) => g === "★").length;
  const half  = starGlyphs.filter((g) => g === "☆").length;
  out.stars = Math.max(0, Math.min(5, solid + half * 0.5));
  // Stream type — the (p2p) / (live) / (web) etc. parens, post-NFKC.
  const stMatch = /\((p2p|live|web|nzb|info|stats|ext|error|yt)\)/i.exec(nameLine);
  if (stMatch) {
    out.streamType = stMatch[1].toLowerCase() as ParsedStream["streamType"];
  }

  // ── 2) Walk description lines, classify each glyph-led segment. ─────
  // Segments we consume here never reach `remaining`, so they don't appear
  // in `extra` later.
  const remaining: string[] = [];

  for (const rawLine of descLines) {
    let line = rawLine;
    // Section break - peel the metadata-flags suffix off FIRST, so it is
    // handled identically whether the addon put it inline or (as newer
    // TamTaro does once the flag run gets long) on a line of its own.
    const breakIdx = line.indexOf(SECTION_BREAK);
    if (breakIdx >= 0) {
      handleMetadataFlags(line.slice(breakIdx + SECTION_BREAK.length).trim(), out);
      line = line.slice(0, breakIdx).trim();
    }
    if (line.length === 0) continue;

    // Split into glyph-led segments and parse each on its own. Dispatching on
    // the line's FIRST character instead (and consuming the rest) is what used
    // to drop every segment after the first.
    for (const seg of splitSegments(line)) {
      if (handleSegment(seg.glyph, seg.value, out)) continue;
      if (consumeUntagged(seg.value, out)) continue;
      if (hasVisible(seg.value)) remaining.push(seg.glyph + seg.value);
    }
  }


  // ── 3) Reconcile + legacy-fill from `fullBody` for non-AIOStreams. ──
  // RipType regex fallback, and use it as `ripType`. If we got a
  // `quality` from chevrons, `ripType` is still set as a reasonable
  // mirror for legacy callers — but the UI prefers `quality`.
  const ripMatch = RIP_RX.exec(fullBody);
  if (ripMatch) out.ripType = normaliseRip(ripMatch[1]);
  // Codec/HDR/audio fallback regex on fullBody when AIOStreams glyphs
  // didn't fire.
  if (!out.codec) {
    const cm = CODEC_RX.exec(fullBody);
    if (cm) out.codec = normaliseCodec(cm[1]);
  }
  if (!out.hdr) {
    const hm = HDR_RX.exec(fullBody);
    if (hm) out.hdr = normaliseHdr(hm[1]);
  }
  if (!out.audio) {
    const am = AUDIO_RX.exec(fullBody);
    if (am) out.audio = am[1].toUpperCase().replace(/\s+/g, "");
  }
  if (!out.size) {
    const szm = SIZE_RX.exec(fullBody);
    if (szm) out.size = `${szm[1]} ${szm[2].toUpperCase()}`;
  }
  if (out.seeders == null) {
    const sa = SEEDER_RX_LEGACY_A.exec(fullBody);
    if (sa) {
      let v = sa[1].replace(/,/g, ".").trim();
      let mult = 1;
      if (/[Kk]$/.test(v)) { mult = 1000; v = v.slice(0, -1); }
      const n = parseFloat(v);
      if (isFinite(n)) out.seeders = Math.round(n * mult);
    } else {
      const sb = SEEDER_RX_LEGACY_B.exec(fullBody);
      if (sb) out.seeders = parseInt(sb[1], 10);
    }
  }
  if (!out.bitrate) {
    const br = BITRATE_RX.exec(fullBody);
    if (br) {
      out.bitrate = `${br[1]} ${br[2].slice(0, 1).toUpperCase()}${br[2].slice(1).toLowerCase()}`;
    }
  }
  if (!out.bitDepth) {
    const bd = BITDEPTH_RX.exec(fullBody);
    if (bd) out.bitDepth = `${bd[1]}bit`;
  }
  if (out.proxyState == null) {
    // Body-level fallback. The line-leading parser handles the canonical
    // AIOStreams `⛊ … / ⛉ …` lines; this catches addons that sprinkle
    // the glyph anywhere in the description. Distinguish filled (on)
    // from outline (off) — the previous version's `PROXY_RX` regex
    // matched BOTH and treated both as "on", silently flipping the
    // explicit-off case back to true. That's the bug the user noticed
    // ("the badge never changes").
    if (/[\u{1F6E1}⛊]\u{FE0F}?/u.test(fullBody))      out.proxyState = "on";
    else if (/⛉\u{FE0F}?/u.test(fullBody))            out.proxyState = "off";
  }
  if (!out.language) {
    const lm = LANG_RX.exec(fullBody);
    if (lm) out.language = lm[1].toUpperCase();
  }
  if (!out.releaseGroup) {
    const gm = RELGROUP_RX.exec(titleLines[0] ?? "");
    if (gm) out.releaseGroup = gm[1];
  }
  // AIOStreams' own service short code means its BUILT-IN usenet engine is
  // serving the file from the operator's NNTP providers, i.e. the addon host
  // is the origin. `stream.proxied` is false for these (it tracks MediaFlow
  // proxying only), so without this the badge claimed "direct from a third
  // party" for traffic that never left the addon's IP. An explicit proxy flag
  // still wins: if the addon says it IS proxying, that's the stronger claim.
  if (out.proxyState !== "on" && out.serviceShort === "AIO") out.proxyState = "self";

  // ── 4) Build the displayed `primary` and `extra`. ───────────────────
  // For AIOStreams entries (recognised when displayTitle was set), we
  // synthesise primary from displayTitle so the UI doesn't repeat raw
  // glyph lines. For legacy addons, we strip parsed tokens from the
  // raw lines and use what's left.
  if (out.displayTitle) {
    out.primary = out.displayTitle;
    out.extra = remaining.map(stripGlyphsAndCleanup).filter((l) => l.length > 0);
  } else {
    // Legacy fallback — strip parsed tokens from the merged raw lines.
    const allRaw = [...titleLines, ...descLines];
    const stripped = legacyStrip(allRaw, out);
    out.primary = stripped[0] ?? allRaw[0] ?? "";
    out.extra = stripped.slice(1);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Helpers used by the main loop.
// ---------------------------------------------------------------------------

/** Cheap detector for "this whole line is metadata-flag content". Used
 *  when a description line has no leading glyph but consists entirely
 *  of seadex/NZB flags + a trailing score. */
function looksLikeMetadataFlags(s: string): boolean {
  return /\b(?:best\s+release|alt\s+best|verified\s*nzb|unverified\s*nzb|elf\s*nzb|broken\s*nzb)\b/i.test(s)
      || /[☑✘]\s*nzb/i.test(s);
}

function handleMetadataFlags(raw: string, out: ParsedStream): void {
  const r = parseMetadataFlags(raw);
  out.seadexBest = out.seadexBest || r.seadexBest;
  out.seadexAlt  = out.seadexAlt  || r.seadexAlt;
  if (r.nzbHealth) out.nzbHealth = r.nzbHealth;
  if (r.seScore != null) out.seScore = r.seScore;
  for (const f of r.flags) if (!out.releaseFlags.includes(f)) out.releaseFlags.push(f);
}

/** Parse ONE glyph-led segment into `out`. Returns false when the segment
 *  carries no glyph we know, or when a known glyph turned out to hold nothing
 *  parseable - either way the caller keeps it as visible residue rather than
 *  dropping it. */
function handleSegment(glyph: string, value: string, out: ParsedStream): boolean {
  switch (glyph) {
    // ✎ / ☁ / ➤ - display title, with optional inline date, year and episode.
    case GLYPH_TITLE:
    case GLYPH_LIBRARY:
    case GLYPH_PRELOAD: {
      if (glyph === GLYPH_LIBRARY)  out.library = true;
      if (glyph === GLYPH_PRELOAD)  out.preloading = true;
      let body = value;
      // Air date - newer TamTaro emits `· 5 Jul 2026` here INSTEAD of the
      // bare `(YYYY)` token (always for series, and for movies whenever a
      // date is known). Take it before the year so the year survives even
      // when only a date was sent.
      const dm = DATE_RX.exec(body);
      if (dm) {
        out.date = dm[1].replace(/\s+/g, " ");
        out.year = out.year ?? dm[2];
        body = (body.slice(0, dm.index) + body.slice(dm.index + dm[0].length)).trim();
      }
      // Year - only as a SEPARATE `(YYYY)` / `(YYYY-YY)` token. An inline
      // 2024 inside a release name should stay put.
      const ym = YEAR_TOKEN_RX.exec(body);
      if (ym) {
        out.year = ym[1];
        body = (body.slice(0, ym.index) + body.slice(ym.index + ym[0].length)).trim();
      }
      // Episode tag - STANDALONE only (don't strip "S01E10" embedded in a
      // release filename like `Show.Name.S01E10.1080p`).
      const em = EPISODE_STANDALONE_RX.exec(body);
      if (em) {
        out.episode = `S${em[1].padStart(2, "0")}E${em[2].padStart(2, "0")}`;
        body = (body.slice(0, em.index) + body.slice(em.index + em[0].length)).trim();
      }
      out.displayTitle = cleanupResidue(body) || out.displayTitle;
      return true;
    }

    // ▣ - codec. Isolate it via CODEC_RX (which knows the canonical names)
    // rather than by position, and pull any bit-depth out separately.
    case GLYPH_ENCODE: {
      const cm = CODEC_RX.exec(value);
      if (cm) {
        out.encode = cm[1].toUpperCase().replace(/\s+/g, "");
      } else {
        // Unknown codec - take the leading alphanumeric token so we still
        // surface SOMETHING for non-canonical codecs.
        const tm = /^([A-Za-z0-9.]+)/.exec(value);
        out.encode = tm ? tm[1].toUpperCase() : null;
      }
      if (out.encode) out.codec = normaliseCodec(out.encode);
      const bd = BITDEPTH_RX.exec(value);
      if (bd && !out.bitDepth) out.bitDepth = `${bd[1]}bit`;
      return out.encode != null || out.bitDepth != null;
    }

    // ✦ - primary visual tags (HDR / DV / HLG).
    case GLYPH_VISUAL_PRI: {
      const tokens: string[] = [];
      for (const t of splitOnDot(value).map((x) => x.toUpperCase())) {
        // A bit depth tucked behind a ✦ separator on the codec segment
        // (`▣ HEVC ✦ 10BIT`) is a bit depth, not an HDR tag. Route it to
        // bitDepth so it can't render as a bogus "✦ 10BIT" HDR chip.
        const bd = BITDEPTH_RX.exec(t);
        if (bd && t.replace(BITDEPTH_RX, "").trim().length === 0) {
          out.bitDepth = out.bitDepth ?? `${bd[1]}bit`;
          continue;
        }
        tokens.push(t);
      }
      out.visualTagsPrimary.push(...tokens);
      // Mirror to the legacy `hdr` field.
      if (!out.hdr && tokens.length > 0) {
        const joined = tokens.join("+").toUpperCase();
        if (joined.includes("DV") && joined.includes("HDR")) out.hdr = "DV+HDR";
        else if (joined.startsWith("DV")) out.hdr = "DV";
        else out.hdr = tokens[0];
      }
      return tokens.length > 0 || out.bitDepth != null;
    }

    // ✧ - secondary visual tags (IMAX / 3D / ...).
    case GLYPH_VISUAL_SEC: {
      const tokens = splitOnDot(value).map((t) => t.toUpperCase());
      out.visualTagsSecondary.push(...tokens);
      return tokens.length > 0;
    }

    // ♬ - audio codecs.
    case GLYPH_AUDIO: {
      const tokens = splitOnDot(value).map((t) => t.toUpperCase());
      out.audioTags.push(...tokens);
      if (!out.audio && out.audioTags.length > 0) out.audio = out.audioTags[0];
      return tokens.length > 0;
    }

    // ♯ - audio channel layouts.
    case GLYPH_CHANNELS: {
      const tokens = splitOnDot(value);
      out.audioChannels.push(...tokens);
      return tokens.length > 0;
    }

    // ❖ / ◈ - season-pack or single-file size, folder size, bit rate.
    case GLYPH_SIZE_PACK:
    case GLYPH_SIZE_SINGLE: {
      if (glyph === GLYPH_SIZE_PACK) out.seasonPack = true;
      const info = parseSizeLine(value);
      if (info.size)       out.size = info.size;
      if (info.folderSize) out.folderSize = info.folderSize;
      if (info.bitrate)    out.bitrate = info.bitrate;
      return Boolean(info.size || info.folderSize || info.bitrate);
    }

    // ⇄ - seeder count and stream age.
    case GLYPH_SEEDERS: {
      // Some addons drop the ❦ glyph; tolerate either case.
      const r = parseSeederValue(value.replace(/❦/g, "").trim());
      if (r.count != null) out.seeders = r.count;
      if (r.age) out.age = r.age;
      return r.count != null || r.age != null;
    }

    // ⛊ / ⛉ - VPS proxy state, then service / addon / group on the same run.
    case GLYPH_PROXY_FILL:
    case GLYPH_PROXY_OUT: {
      out.proxyState = glyph === GLYPH_PROXY_FILL ? "on" : "off";
      const r = parseProxyServiceAddon(value);
      if (r.serviceShort) out.serviceShort = r.serviceShort;
      if (r.addonName)    out.addonName = r.addonName;
      if (r.releaseGroupOrIndexer) {
        // For NZB streams the field is the indexer; for torrents the release
        // group. When streamType says nzb route to indexer, else default to
        // releaseGroup. Either way the chip renders.
        if (out.streamType === "nzb") out.indexer = r.releaseGroupOrIndexer;
        else out.releaseGroup = r.releaseGroupOrIndexer;
      }
      if (r.privateFlag) out.private = true;
      return true;
    }

    // ⛿ / ✓ - audio languages, sub flag, subtitle codes. Newer TamTaro swaps
    // the leading ⛿ for a ✓ whenever the stream carries subtitles.
    case GLYPH_LANG:
    case GLYPH_LANG_SUBBED: {
      // `⛿` is unambiguous, but `✓` is a plain check mark that other addons
      // use for anything ("✓ Verified", "✓ Cached"). Claim it only when what
      // follows really does look like language codes, so a stray check mark
      // can't manufacture a bogus language chip; otherwise hand the segment
      // back and let it show as residue.
      if (glyph === GLYPH_LANG_SUBBED && !looksLikeLanguageCodes(value)) return false;
      const lr = parseLanguageLine(value);
      out.languages.push(...lr.languages);
      out.subbed = out.subbed || lr.subbed;
      out.subtitles.push(...lr.subtitles);
      if (!out.language && out.languages.length > 0) out.language = out.languages[0];
      return lr.languages.length > 0 || lr.subbed || lr.subtitles.length > 0;
    }

    default:
      return false;
  }
}

/** Does this segment body look like AIOStreams' language list (`ᴇɴ · ᴊᴀ`,
 *  optionally with a `sᴜʙ` flag and a trailing `(ᴇɴ)` subtitle group) rather
 *  than arbitrary prose? Requires every token to be a short word AND at least
 *  one to be an actual 2-3 letter code or a known dual-audio marker, so
 *  "Verified" or "Cached" behind a check mark is rejected. */
function looksLikeLanguageCodes(value: string): boolean {
  const isCode = (t: string) => /^[A-Za-z]{2,3}$/.test(t);
  const parens = /\(([^)]*)\)\s*$/.exec(value);
  const head = parens ? value.slice(0, parens.index) : value;
  const tokens = splitOnDot(head.replace(/\bsub\b/i, "").trim());
  // Subtitle codes only, no audio languages listed.
  if (tokens.length === 0) {
    return parens != null && splitOnDot(parens[1]).every(isCode);
  }
  return tokens.every((t) => /^[A-Za-z-]{2,12}$/.test(t))
      && tokens.some((t) => isCode(t) || /^(?:DUO|DUB|DUAL AUDIO|DUBBED)$/i.test(t));
}

/** Line content that carries no glyph at all but still isn't residue: the
 *  bare `(YYYY) SxxEyy` continuation line some addons emit beneath the title,
 *  and a standalone run of metadata flags with no ` » ` in front of it. */
function consumeUntagged(value: string, out: ParsedStream): boolean {
  if (!hasVisible(value)) return true;

  // Bare "(YYYY) [SxxEyy]" continuation line.
  if (value.startsWith("(")) {
    const padded = ` ${value}`;
    const ym = YEAR_TOKEN_RX.exec(padded);
    if (ym) {
      out.year = out.year ?? ym[1];
      const rest = padded.slice(0, ym.index) + padded.slice(ym.index + ym[0].length);
      const em = EPISODE_STANDALONE_RX.exec(rest);
      if (em && !out.episode) {
        out.episode = `S${em[1].padStart(2, "0")}E${em[2].padStart(2, "0")}`;
      }
      return true;
    }
  }

  // Bare standalone episode line (no year prefix). Only when the line is JUST
  // that, so a release note that happens to mention an episode isn't eaten.
  const em = EPISODE_STANDALONE_RX.exec(` ${value}`);
  if (em && value.replace(em[0].trim(), "").trim().length === 0) {
    if (!out.episode) out.episode = `S${em[1].padStart(2, "0")}E${em[2].padStart(2, "0")}`;
    return true;
  }

  // A whole line of metadata flags with no ` » ` separator in front.
  if (looksLikeMetadataFlags(value)) {
    handleMetadataFlags(value, out);
    return true;
  }

  return false;
}

/** Strip any of our recognised glyphs from a residue line — they're
 *  decorative once we've parsed their value out. */
const ALL_GLYPHS_RX = new RegExp(
  `[${[...SEGMENT_GLYPHS, GLYPH_PRIVATE].join("")}❦《》〈〉]`,
  "gu",
);

function stripGlyphsAndCleanup(line: string): string {
  let s = line.replace(ALL_GLYPHS_RX, " ").replace(STAR_RX, " ");
  s = s.replace(/[⚡⏳⌛]/gu, " ");
  return cleanupResidue(s);
}

/** Legacy-style token strip — for non-AIOStreams addons. Removes the
 *  parsed scalar fields from the raw lines so the displayed `primary`
 *  doesn't repeat them. */
function legacyStrip(rawLines: string[], p: ParsedStream): string[] {
  const tokens: RegExp[] = [];
  const wrap = (token: string) =>
    new RegExp(`\\s*[\\(\\[]?\\s*${token}\\s*[\\)\\]]?\\s*`, "ig");
  if (p.resolution) tokens.push(wrap(escapeRx(p.resolution)));
  if (p.ripType)    tokens.push(wrap(escapeRx(p.ripType).replace(/-/g, "[-\\s.]?")));
  if (p.codec)      tokens.push(wrap(escapeRx(p.codec)));
  if (p.hdr)        tokens.push(wrap(escapeRx(p.hdr)));
  if (p.audio)      tokens.push(wrap(escapeRx(p.audio)));
  if (p.size)       tokens.push(wrap(escapeRx(p.size).replace("\\ ", "\\s*")));
  if (p.bitrate)    tokens.push(wrap(escapeRx(p.bitrate).replace("\\ ", "\\s*")));
  if (p.bitDepth)   tokens.push(wrap(escapeRx(p.bitDepth).replace("\\ ", "\\s*")));
  if (p.proxyState != null) tokens.push(/[🛡⛊⛉]/gu);
  if (p.cachedStatus === "cached")   tokens.push(/[⚡⚡️]/gu);
  if (p.cachedStatus === "uncached") tokens.push(/[⌛⏳]/gu);
  tokens.push(STAR_RX);
  tokens.push(/[\(\[]\s*(nzb|usenet|torrent|direct|magnet|http|https|debrid|rd|ad|pm|tb|premiumize|alldebrid)\s*[\)\]]/ig);
  tokens.push(/\b(?:Mbps|Kbps)\b/ig);

  const GLYPH_RX = /[\u{1F3AC}\u{1F3B5}\u{1F4BE}\u{1F4F7}\u{1F5BC}\u{1F4F8}\u{1F3A4}\u{1F3A5}\u{1F3F7}✦⚡⏳⌛\u{1F6E1}\u{1F4DD}\u{1F464}\u{1F465}\u{2699}\u{1FA70}-\u{1FA7F}]\u{FE0F}?/gu;
  const SEP_RX = /\\(?=\s)|(?<=\s)\\/g;
  // Strip parsed seeder shorthand `1.2K` if seeders were extracted.
  const SEED_NUM_RX = /\b\d+(?:[.,]\d+)?[Kk]?\s*(?=$|\s|\)|\])/g;

  return rawLines
    .map((line) => {
      let out = line;
      for (const rx of tokens) out = out.replace(rx, " ");
      out = out.replace(GLYPH_RX, " ").replace(SEP_RX, " ");
      out = out.replace(ALL_GLYPHS_RX, " ");
      // Strip the bare seeder count and trailing service short codes
      // (RD / TB / etc.) that legacy addons sprinkle without parens.
      if (p.seeders != null) out = out.replace(SEED_NUM_RX, " ");
      out = out.replace(/\b(rd|ad|pm|tb|premiumize|alldebrid|debrid)\b/gi, " ");
      return cleanupResidue(out);
    })
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Normalisers.
// ---------------------------------------------------------------------------

function normaliseRip(raw: string): string {
  const r = raw.toUpperCase().replace(/[\s.]/g, "-");
  if (r === "WEB-DL" || r === "WEBDL")     return "WEB-DL";
  if (r === "WEB-RIP" || r === "WEBRIP")   return "WEBRip";
  if (r === "BLU-RAY" || r === "BLURAY")   return "BluRay";
  if (r === "BD-RIP" || r === "BDRIP")     return "BDRip";
  if (r === "BR-RIP" || r === "BRRIP")     return "BRRip";
  if (r === "HD-RIP" || r === "HDRIP")     return "HDRip";
  if (r === "HC-HD-RIP" || r === "HCHDRIP" || r === "HC-HDRIP") return "HC HDRip";
  if (r === "DVD-RIP" || r === "DVDRIP")   return "DVDRip";
  if (r === "REMUX")                       return "REMUX";
  if (r === "HDTV")                        return "HDTV";
  if (r === "HDTC")                        return "HDTC";
  if (r === "CAM" || r === "TS" || r === "TC" || r === "TELESYNC") return r;
  return r;
}

function normaliseRes(raw: string): string {
  const r = raw.toUpperCase();
  if (r === "4K" || r === "UHD" || r === "2160P") return "2160p";
  if (r === "2K" || r === "1440P") return "1440p";
  if (r === "HD" || r === "1080P") return "1080p";
  return r.toLowerCase();
}

function normaliseCodec(raw: string): string {
  const r = raw.replace(/\s+/g, "").toUpperCase();
  if (r === "H.265" || r === "H265" || r === "X265") return "HEVC";
  if (r === "H.264" || r === "H264" || r === "X264" || r === "AVC") return "AVC";
  if (r === "MPEG-2" || r === "MPEG2") return "MPEG-2";
  return r;
}

function normaliseHdr(raw: string): string {
  const r = raw.toUpperCase().replace(/\s+/g, "").replace("DOLBY-VISION", "DV").replace("DOLBYVISION", "DV");
  if (r.includes("DV") && r.includes("HDR")) return "DV+HDR";
  if (r.startsWith("DV"))  return "DV";
  if (r.startsWith("HDR")) return "HDR";
  return r;
}

/** Title-case the AIOStreams quality string from `〈Bluray Remux〉`. */
function normaliseQuality(raw: string): string {
  const trimmed = raw.trim();
  // Common AIOStreams forms — unify to canonical labels.
  const upper = trimmed.toUpperCase().replace(/[-\s]+/g, " ");
  if (upper === "BLURAY REMUX")    return "BluRay Remux";
  if (upper === "BLURAY")          return "BluRay";
  if (upper === "WEB DL")          return "WEB-DL";
  if (upper === "WEB RIP" || upper === "WEBRIP") return "WEBRip";
  if (upper === "HC HDRIP" || upper === "HC HDRIP") return "HC HDRip";
  if (upper === "HDRIP")           return "HDRip";
  if (upper === "BRRIP")           return "BRRip";
  if (upper === "BDRIP")           return "BDRip";
  if (upper === "DVDRIP")          return "DVDRip";
  if (upper === "REMUX")           return "REMUX";
  // Fall back to the raw string with simple title-casing per word.
  return trimmed
    .split(/\s+/)
    .map((w) => w.length > 0 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Tag-pill colour mapping for stream chips. Same palette as AddonsView so the
// app feels coherent.
// ---------------------------------------------------------------------------

export interface ChipStyle { bg: string; fg: string; border: string }

export type ChipKind =
  | "resolution" | "quality" | "encode" | "codec"
  | "visual-pri" | "visual-sec" | "hdr"
  | "audio" | "channels"
  | "size" | "folder" | "bitrate" | "seeders" | "age"
  | "lang" | "sub"
  | "service" | "addon" | "group" | "indexer"
  | "proxy" | "proxy-self" | "proxy-off" | "private"
  | "seadex-best" | "seadex-alt"
  | "nzb-verified" | "nzb-elf" | "nzb-unverified" | "nzb-broken"
  | "score"
  | "default";

export function chipStyleFor(kind: ChipKind): ChipStyle {
  switch (kind) {
    case "resolution":    return { bg: "bg-emerald-500/15", fg: "text-emerald-300", border: "border-emerald-400/30" };
    case "quality":       return { bg: "bg-emerald-500/15", fg: "text-emerald-200", border: "border-emerald-400/30" };
    case "encode":
    case "codec":         return { bg: "bg-cyan-500/15",    fg: "text-cyan-300",    border: "border-cyan-400/30" };
    case "visual-pri":
    case "hdr":           return { bg: "bg-fuchsia-500/15", fg: "text-fuchsia-300", border: "border-fuchsia-400/30" };
    case "visual-sec":    return { bg: "bg-violet-500/15",  fg: "text-violet-200",  border: "border-violet-400/30" };
    case "audio":         return { bg: "bg-amber-500/15",   fg: "text-amber-300",   border: "border-amber-400/30" };
    case "channels":      return { bg: "bg-orange-500/15",  fg: "text-orange-300",  border: "border-orange-400/30" };
    case "size":          return { bg: "bg-blue-500/15",    fg: "text-blue-300",    border: "border-blue-400/30" };
    case "folder":        return { bg: "bg-blue-500/10",    fg: "text-blue-200/85", border: "border-blue-400/20" };
    case "bitrate":       return { bg: "bg-blue-500/12",    fg: "text-blue-200",    border: "border-blue-400/25" };
    case "seeders":       return { bg: "bg-green-500/15",   fg: "text-green-300",   border: "border-green-400/30" };
    case "age":           return { bg: "bg-white/5",        fg: "text-white/60",    border: "border-white/12" };
    case "lang":          return { bg: "bg-rose-500/15",    fg: "text-rose-300",    border: "border-rose-400/30" };
    case "sub":           return { bg: "bg-pink-500/15",    fg: "text-pink-300",    border: "border-pink-400/30" };
    case "service":       return { bg: "bg-teal-500/15",    fg: "text-teal-300",    border: "border-teal-400/30" };
    case "addon":         return { bg: "bg-white/8",        fg: "text-white/75",    border: "border-white/15" };
    case "group":         return { bg: "bg-violet-500/15",  fg: "text-violet-300",  border: "border-violet-400/30" };
    case "indexer":       return { bg: "bg-slate-500/15",   fg: "text-slate-300",   border: "border-slate-400/30" };
    case "proxy":         return { bg: "bg-teal-500/15",    fg: "text-teal-300",    border: "border-teal-400/30" };
    // Blue, not teal: the connection still stays on the addon host, but it is
    // the ORIGIN rather than a proxy. Distinct colour so the two aren't read
    // as the same thing at a glance.
    case "proxy-self":    return { bg: "bg-sky-500/15",     fg: "text-sky-300",     border: "border-sky-400/35" };
    case "proxy-off":     return { bg: "bg-rose-500/15",    fg: "text-rose-300",    border: "border-rose-400/35" };
    case "private":       return { bg: "bg-yellow-500/15",  fg: "text-yellow-300",  border: "border-yellow-400/30" };
    case "seadex-best":   return { bg: "bg-amber-400/20",   fg: "text-amber-200",   border: "border-amber-300/40" };
    case "seadex-alt":    return { bg: "bg-amber-400/10",   fg: "text-amber-200/80",border: "border-amber-300/25" };
    case "nzb-verified":  return { bg: "bg-green-500/15",   fg: "text-green-300",   border: "border-green-400/30" };
    case "nzb-elf":       return { bg: "bg-lime-500/15",    fg: "text-lime-300",    border: "border-lime-400/30" };
    case "nzb-unverified":return { bg: "bg-yellow-500/15",  fg: "text-yellow-300",  border: "border-yellow-400/30" };
    case "nzb-broken":    return { bg: "bg-red-500/15",     fg: "text-red-300",     border: "border-red-400/30" };
    case "score":         return { bg: "bg-white/8",        fg: "text-white/75",    border: "border-white/15" };
    default:              return { bg: "bg-white/8",        fg: "text-white/70",    border: "border-white/15" };
  }
}
