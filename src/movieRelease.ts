// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// movieRelease: a film's theatrical and digital countdowns, the "In Theaters"
// test, and the words for how sure each date is. IMPORT-FREE on purpose, so
// a node check can load it directly (node runs the .ts file); releaseCountdown
// re-exports all of it, and both UI surfaces (the detail page meta strip and
// the catalog hover panel) read it through there.
//
// Where the dates come from (Rust `fetch_movie_release_dates`, wrapped by
// releaseDates.ts): TMDB's per-country release dates for the user's Windows
// region, else the US, else the earliest country; then MDBList; then nothing.
// MDBList alone proved wrong (The Odyssey: it said digital Nov 7, Universal
// and TMDB say Nov 17 in the US), so every date carries a BASIS the UI shows:
//   - confirmed: a TMDB per-country row (an authoritative, regional date)
//   - reported:  MDBList, or the addon's own `released` for the theatrical
//                date (one source's word, no country behind it)
//   - estimated: the +45-day PVOD window after the theatrical date, used only
//                when no digital date is known at all
// A confirmed date is never shown the way a guess is, and a guess is never
// shown bare: the tag and hover text come from `describeReleaseBasis`.
// ---------------------------------------------------------------------------

export type CountdownKind = "premiere" | "next-episode" | "cinematic" | "digital";

/** How a movie date was arrived at. See the module comment. */
export type ReleaseBasis = "confirmed" | "reported" | "estimated";

/** Where a movie date came from: TMDB's per-country rows, MDBList, the
 *  addon's own meta `released`, or the PVOD-window estimate. */
export type ReleaseSource = "tmdb" | "mdblist" | "addon" | "estimate";

export interface ReleaseCountdown {
  kind: CountdownKind;
  /** Short UI label, e.g. "Next Episode", "Premieres", "In Theaters", "Digital". */
  label: string;
  /** Target release timestamp (ms since epoch). */
  targetMs: number;
  /** Movie kinds only (cinematic / digital): how sure the date is. Episode
   *  countdowns read the meta addon's air dates and carry no basis. */
  basis?: ReleaseBasis;
  /** Movie kinds only: where the date came from. */
  source?: ReleaseSource;
  /** ISO 3166-1 alpha-2 of the country whose date this is, when the source
   *  is TMDB. */
  region?: string;
}

/** Resolved movie release dates (see releaseDates.ts). Dates are
 *  `YYYY-MM-DD`; any field may be absent. */
export interface AccurateReleaseDates {
  theatrical?: string | null;
  theatricalSource?: string | null;
  theatricalRegion?: string | null;
  digital?: string | null;
  digitalSource?: string | null;
  digitalRegion?: string | null;
  /** The user's region Aura asked for (alpha-2). */
  region?: string | null;
}

/** Most days a film counts as in theaters while its known digital date is
 *  still ahead. Without one, IN_THEATERS_WINDOW_DAYS applies. */
export const IN_THEATERS_MAX_DAYS = 365;

/** Days after theatrical release a film is assumed to hit digital when no
 *  digital date is known from any source. The post-2021 PVOD / 45-day window
 *  is the industry norm; it is shown as an Estimate, never as a date. */
export const DIGITAL_WINDOW_DAYS = 45;

/** Days after theatrical release a film is still treated as "in theaters"
 *  when NO digital date is known. Guards old catalog titles (which often carry
 *  a theatrical date but no recorded digital date) from reading as "In
 *  Theaters" indefinitely. ~120 days covers a typical wide + limited run. With
 *  a known digital date the run lasts until that date instead (The Odyssey's
 *  Nov 17 is 123 days after Jul 17, and the badge must not drop three days
 *  early). Theatrical runs have no published end date anywhere, which the
 *  badge's hover text says. */
export const IN_THEATERS_WINDOW_DAYS = 120;


/** A release date as the START OF THAT CALENDAR DAY IN THE USER'S ZONE. Movie
 *  dates are days, not instants: read as UTC midnight, "2026-11-17" ended a US
 *  West Coast countdown at 4 pm on Nov 16 local, a day before the date the
 *  hover text names. A full ISO timestamp (the addon's `released`) keeps only
 *  its day for the same reason. */
function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (m) {
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** `ms` plus `days` CALENDAR days, at the same local wall time. A fixed
 *  86_400_000 per day lands an hour off across a DST change, so a local
 *  midnight became 11 pm the evening before (the estimate named the wrong day). */
function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

function wireSource(s: string | null | undefined): ReleaseSource | null {
  return s === "tmdb" || s === "mdblist" ? s : null;
}

function regionCode(r: string | null | undefined): string | undefined {
  const code = (r ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : undefined;
}

/**
 * A film's countdown(s) relative to `nowMs`: the cinematic one while the
 * theatrical date is ahead, the digital one while the digital date (or the
 * estimate) is ahead. Cinematic first. `released` is the addon's meta date,
 * the theatrical fallback when the resolved dates have none.
 */
export function computeMovieCountdowns(
  released: string | null | undefined,
  nowMs: number,
  dates?: AccurateReleaseDates | null,
): ReleaseCountdown[] {
  const resolvedTheatricalMs = parseMs(dates?.theatrical);
  const cinematicMs = resolvedTheatricalMs ?? parseMs(released);
  if (cinematicMs == null) return [];
  const theatricalSource: ReleaseSource =
    resolvedTheatricalMs != null ? wireSource(dates?.theatricalSource) ?? "mdblist" : "addon";

  const out: ReleaseCountdown[] = [];
  if (cinematicMs > nowMs) {
    const confirmed = theatricalSource === "tmdb";
    out.push({
      kind: "cinematic",
      label: "In Theaters",
      targetMs: cinematicMs,
      basis: confirmed ? "confirmed" : "reported",
      source: theatricalSource,
      region: confirmed ? regionCode(dates?.theatricalRegion) : undefined,
    });
  }

  const resolvedDigitalMs = parseMs(dates?.digital);
  if (resolvedDigitalMs != null) {
    if (resolvedDigitalMs > nowMs) {
      const source = wireSource(dates?.digitalSource) ?? "mdblist";
      const confirmed = source === "tmdb";
      out.push({
        kind: "digital",
        label: "Digital",
        targetMs: resolvedDigitalMs,
        basis: confirmed ? "confirmed" : "reported",
        source,
        region: confirmed ? regionCode(dates?.digitalRegion) : undefined,
      });
    }
  } else {
    const estimateMs = addDays(cinematicMs, DIGITAL_WINDOW_DAYS);
    if (estimateMs > nowMs) {
      out.push({
        kind: "digital",
        label: "Digital",
        targetMs: estimateMs,
        basis: "estimated",
        source: "estimate",
      });
    }
  }
  return out;
}

/**
 * Whether a movie is in theaters now: its resolved theatrical date has
 * passed, it has not reached digital yet (or digital is unknown), and the
 * theatrical date is within IN_THEATERS_WINDOW_DAYS. Reads the dates it is
 * given (the user's region first, see the module comment) and nothing else,
 * so it is false until they resolve and never rests on the +45-day guess.
 * Series and anime are never in theaters.
 */
export function isInTheaters(
  mediaType: string | null | undefined,
  dates: AccurateReleaseDates | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const mt = (mediaType ?? "").toLowerCase();
  if (mt === "series" || mt === "anime") return false;
  if (!dates) return false;
  const theatrical = parseMs(dates.theatrical);
  if (theatrical == null || theatrical > nowMs) return false;
  return nowMs < inTheatersEnd(theatrical, parseMs(dates.digital));
}

/** When the "In Theaters" badge ends: the known digital date, capped at
 *  IN_THEATERS_MAX_DAYS; without one, IN_THEATERS_WINDOW_DAYS. Shared by
 *  isInTheaters and the badge's hover so the two can never name different
 *  days. */
function inTheatersEnd(theatricalMs: number, digitalMs: number | null): number {
  if (digitalMs != null) return Math.min(digitalMs, addDays(theatricalMs, IN_THEATERS_MAX_DAYS));
  return addDays(theatricalMs, IN_THEATERS_WINDOW_DAYS);
}

// ---------------------------------------------------------------------------
// Wording. Plain sentences, no dashes.
// ---------------------------------------------------------------------------

/** The visible tag per basis. */
export const RELEASE_BASIS_TAG: Record<ReleaseBasis, string> = {
  confirmed: "Confirmed",
  reported: "Reported",
  estimated: "Estimate",
};

let regionNames: { of(code: string): string | undefined } | null | undefined;
let regionNamesEnglish = true;

function displayNames(): { of(code: string): string | undefined } | null {
  if (regionNames !== undefined) return regionNames;
  try {
    const lang = typeof navigator !== "undefined" && navigator.language ? navigator.language : "en";
    const dn = new Intl.DisplayNames([lang, "en"], { type: "region" });
    regionNamesEnglish = dn.resolvedOptions().locale.toLowerCase().startsWith("en");
    regionNames = dn;
  } catch {
    regionNames = null;
  }
  return regionNames;
}

/** A country's display name in the user's language, else the code itself. */
export function regionName(code: string): string {
  try {
    const name = displayNames()?.of(code.toUpperCase());
    if (name && name !== code) return name;
  } catch { /* an unknown code: fall through */ }
  return code.toUpperCase();
}

// English country names that read with "the" ("in the United States").
const THE_REGIONS = new Set([
  "US", "GB", "AE", "NL", "PH", "DO", "BS", "GM", "CF", "KM", "MV", "MH", "SB",
  "KY", "FO", "VG", "VI", "TC", "FK", "CK",
]);

function inRegion(code: string): string {
  const name = regionName(code);
  return regionNamesEnglish && THE_REGIONS.has(code.toUpperCase()) ? `the ${name}` : name;
}

/** "Tue, Nov 17, 2026". Movie targets are local midnights (see parseMs), so
 *  the local calendar day is the release day. */
export function formatReleaseDay(targetMs: number): string {
  return new Date(targetMs).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Tue, Nov 17, 2026 in the United States": a countdown's day, with its
 *  country when the date has one. */
export function releaseDayWhere(c: Pick<ReleaseCountdown, "targetMs" | "region">): string {
  return `${formatReleaseDay(c.targetMs)}${c.region ? ` in ${inRegion(c.region)}` : ""}`;
}

export interface ReleaseBasisWording {
  /** The visible tag: "Confirmed" / "Reported" / "Estimate". */
  tag: string;
  /** The hover text. */
  hover: string;
}

/**
 * The tag and hover text for a movie countdown, or null for an episode
 * countdown (no basis). `userRegion` is the region Aura asked for
 * (`AccurateReleaseDates.region`).
 */
export function describeReleaseBasis(
  c: Pick<ReleaseCountdown, "kind" | "targetMs" | "basis" | "source" | "region">,
  userRegion?: string | null,
): ReleaseBasisWording | null {
  if (!c.basis) return null;
  const lead = c.kind === "cinematic" ? "In theaters" : "Digital release";
  const day = formatReleaseDay(c.targetMs);
  const tag = RELEASE_BASIS_TAG[c.basis];
  if (c.basis === "confirmed") {
    const where = c.region ? ` in ${inRegion(c.region)}` : "";
    let hover = `${lead}: ${day}${where}. Confirmed by TMDB's release dates.`;
    const user = regionCode(userRegion);
    if (c.region && user && user !== c.region) {
      hover += ` No date is listed for ${inRegion(user)} yet; this is the ${regionName(c.region)} date.`;
    }
    return { tag, hover };
  }
  if (c.basis === "reported") {
    // True whatever the reason TMDB had nothing (no listing, no date of this
    // kind yet, a failed lookup): the date names no country and TMDB has not
    // confirmed it.
    const per = c.source === "addon" ? "per the metadata addon" : "per MDBList";
    return { tag, hover: `${lead}: ${day}, ${per}, which names no country. TMDB has not confirmed it.` };
  }
  return {
    tag,
    hover:
      `${lead}: around ${day}. Estimated: about ${DIGITAL_WINDOW_DAYS} days after the theatrical ` +
      `release, since no digital release date has been announced for this film.`,
  };
}

/**
 * Hover text for the "In Theaters" badge. Theatrical runs have no published
 * end date anywhere, so it says what the badge's own end is, by the same rule
 * isInTheaters uses: the digital release when one is known, else the window.
 */
export function inTheatersHover(dates: AccurateReleaseDates | null | undefined): string {
  const theatricalMs = parseMs(dates?.theatrical);
  if (theatricalMs == null) return "In theaters. Theatrical runs have no published end date.";
  const region = wireSource(dates?.theatricalSource) === "tmdb" ? regionCode(dates?.theatricalRegion) : undefined;
  const since = `In theaters since ${formatReleaseDay(theatricalMs)}${region ? ` (${regionName(region)})` : ""}.`;
  const digitalMs = parseMs(dates?.digital);
  const endMs = inTheatersEnd(theatricalMs, digitalMs);
  const until = digitalMs != null && endMs === digitalMs
    ? `this shows until the digital release on ${formatReleaseDay(digitalMs)}.`
    : digitalMs != null
      ? `this shows until ${formatReleaseDay(endMs)}, a year after release. The digital release is on ${formatReleaseDay(digitalMs)}.`
      : `this shows until about ${IN_THEATERS_WINDOW_DAYS} days after release.`;
  return `${since} Theatrical runs have no published end date; ${until}`;
}
