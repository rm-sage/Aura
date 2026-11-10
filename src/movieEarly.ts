// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// movieEarly - a film whose copies are out before its official digital date.
//
// Nolan's The Odyssey leaked on 2026-11-07, ten days before its 2026-11-17 US
// digital release, and Aura kept counting down to the 17th. Nothing changes
// the official date, so a leak is not a new date: it is a fact about the
// streams, recorded here and shown beside the Digital countdown.
//
// The check is the detail page's own stream fetch (no background fan-out:
// the user's call). While it runs for a film whose digital date is ahead, the
// Digital countdown says "Checking"; its answer is classified here and kept,
// so the catalog hover panel can show it without fetching anything.
//
// Evidence, strongest first (RANK):
//   - verified:  AIOStreams' "Early Release" notice (`code: "earlyRelease"`)
//                or a stream it flagged (`streamData.earlyRelease`), with a
//                leak source (leakDetected, leakRecord) or a file that is
//                itself the proof (`evidence: true`, a runtime match).
//   - flagged:   AIOStreams let streams through as an early release without
//                either of those (source "bypass").
//   - home:      no AIOStreams signal, but rows labelled as home releases
//                (WEB-DL, WEBRip, BluRay, REMUX, ...). Unverified: they can
//                be a same-name film's, or another country's real release.
//   - unlabeled: rows with no release type at all.
//   - theater:   only theater recordings (CAM, TS, TC, screeners).
//   - none:      nothing (AIOStreams' Digital Release Filter, or no rows).
// A weaker answer never replaces a current AIOStreams-backed one (verified,
// flagged): a leak does not un-leak because one fetch came back short. Every
// other record is replaced by the next real answer, so a wrong "home" guess
// (a same-name film's files) is not stuck until the digital day. An answer
// that is missing an addon (`failedAddons`) records only an early release.
//
// The check runs against the Digital countdown's day, the +45-day Estimate
// included. Against the Estimate the record carries `estimate` and a find
// reads "Streams available", never "Out early": with no digital date
// announced there is nothing official to be early against, and a film already
// out digitally whose date sources are silent would otherwise read as leaked.
// Readers show a record only for the day AND basis it was checked against
// (`earlyRecordFor`).
//
// How long an answer lasts: until the official digital day, at most
// POSITIVE_MAX_MS for an early release, NEGATIVE_TTL_MS for the rest (a
// re-check is free on the next detail page open, which fetches anyway).
// Device-local, CAP entries, oldest first.
//
// Import-free: a node check loads it directly.
// ---------------------------------------------------------------------------

export type EarlyKind = "verified" | "flagged" | "home" | "unlabeled" | "theater" | "none";

const RANK: Record<EarlyKind, number> = {
  verified: 5, flagged: 4, home: 3, unlabeled: 2, theater: 1, none: 0,
};

/** True for the kinds that mean the film itself is out early. */
export function isOutEarly(kind: EarlyKind | null | undefined): boolean {
  return kind === "verified" || kind === "flagged" || kind === "home";
}

const KEY = "aura:movie-early:v1";
const CAP = 100;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A "nothing yet" (or theater copies only) answer. */
export const NEGATIVE_TTL_MS = 6 * HOUR_MS;
/** An early release, which also ends at the official digital day. */
export const POSITIVE_MAX_MS = 120 * DAY_MS;
/** Release groups kept per record (the hover names a few). */
const GROUPS_KEPT = 8;

export interface MovieEarlyRecord {
  kind: EarlyKind;
  /** When the fetch this came from answered (ms). */
  checkedAt: number;
  /** The digital day this was checked against (ms, local midnight). */
  digitalMs: number;
  /** That day was the +45-day Estimate: no digital date has been announced,
   *  so a find reads "Streams available", not "Out early" (nothing official
   *  to be early against). Absent on records from before this existed. */
  estimate?: boolean;
  /** AIOStreams' source: "leakDetected" | "leakRecord" | "bypass" | other. */
  source?: string;
  /** When AIOStreams detected the release (ms). */
  detectedAt?: number;
  /** Release groups AIOStreams named (the first GROUPS_KEPT). */
  groups?: string[];
  /** How many it named in all. */
  groupCount?: number;
  runtimeMinutes?: number;
  /** Streams AIOStreams marked as the proof (runtime match). */
  evidenceFiles?: number;
  /** Release types seen on the rows that decided the kind ("WEB-DL", "CAM"). */
  labels?: string[];
  /** How many rows decided the kind. */
  rows?: number;
}

/** What classifyMovieStreams decided; noteMovieCheck stamps the times. */
export type MovieEarlyEvidence = Omit<MovieEarlyRecord, "checkedAt" | "digitalMs" | "estimate">;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The StreamEntry fields read here. */
export interface EarlyStreamRow {
  title?: string | null;
  description?: string | null;
  filename?: string | null;
  url?: string | null;
  info_hash?: string | null;
  video_size?: number | null;
  early_release?: { source?: string | null; evidence?: boolean | null } | null;
}

/** The StreamMessage fields read here. */
export interface EarlyNotice {
  title?: string | null;
  description?: string | null;
  code?: string | null;
  early_release?: {
    source?: string | null;
    detected_at?: string | null;
    release_groups?: string[] | null;
    release_group_count?: number | null;
    runtime_minutes?: number | null;
  } | null;
}

/** AIOStreams' "nothing digital yet" notice: by its code, else (an older
 *  AIOStreams) by its wording. */
export function isDigitalReleaseFilterNotice(m: EarlyNotice): boolean {
  if (m.code) return m.code === "digitalReleaseFilter";
  return /digital release filter/i.test(m.title ?? "") || /digital release filter/i.test(m.description ?? "");
}

export function isEarlyReleaseNotice(m: EarlyNotice): boolean {
  return m.code === "earlyRelease";
}

// Theater recordings. The short tokens are matched in capitals only and must
// stand alone between separators, so "DTS" audio, a ".ts" file extension at
// the end of a name and words that merely contain them do not count.
// The end of the text counts as a separator too ("... HDTV.CAM", "2026 CAM"):
// only a LOWERCASE ".ts" extension is ruled out, by the capitals.
const THEATER_SHORT_RX = /(?:^|[\s.\[\](){}〈〉_|,-])(HD-?CAM|CAM|HD-?TS|TS|HD-?TC|TC|PDVD|SCR|DVDSCR)(?=[\s.\[\](){}〈〉_|,-]|$)/;
const THEATER_LONG_RX = /\b(cam-?rip|telesync|telecine|screener|dvd-?scr|hd-?cam|hd-?ts|hd-?tc)\b/i;
// Home releases. HDRip / HC HDRip are web or disc rips too.
const HOME_RX = /\b(web[-. ]?dl|web[-. ]?rip|webrip|blu[-. ]?ray|bd-?rip|br-?rip|bd-?remux|remux|uhd[-. ]?bd|hd-?rip|dvd-?rip|hdtv)\b/i;
// The bare scene tag for a WEB-DL ("The.Odyssey.2026.2160p.WEB.H265-ETHEL"):
// capitals only and standing alone, so the word "web" in a title is not one.
const HOME_SHORT_RX = /(?:^|[\s.\[\](){}〈〉_|,-])(WEB)(?=[\s.\[\](){}〈〉_|,-]|$)/;

function homeLabel(raw: string): string {
  const r = raw.toUpperCase().replace(/[-. ]/g, "");
  if (r === "WEBDL" || r === "WEB") return "WEB-DL";
  if (r === "WEBRIP") return "WEBRip";
  if (r === "BLURAY" || r === "UHDBD") return "BluRay";
  if (r === "REMUX" || r === "BDREMUX") return "REMUX";
  if (r === "BDRIP") return "BDRip";
  if (r === "BRRIP") return "BRRip";
  if (r === "HDRIP") return "HDRip";
  if (r === "DVDRIP") return "DVDRip";
  if (r === "HDTV") return "HDTV";
  return raw;
}

function theaterLabel(raw: string): string {
  const r = raw.toUpperCase().replace(/[-. ]/g, "");
  if (r === "HDCAM" || r === "CAMRIP" || r === "CAM") return "CAM";
  if (r === "HDTS" || r === "TS" || r === "TELESYNC" || r === "PDVD") return "TS";
  if (r === "HDTC" || r === "TC" || r === "TELECINE") return "TC";
  return "Screener";
}

/** "home" | "theater" | null for one row, read from its file name, title and
 *  description. A theater token wins: "HDCAM ... WEB-DL audio" is a CAM. */
export function rowReleaseType(row: EarlyStreamRow): { type: "home" | "theater"; label: string } | null {
  const text = [row.filename, row.title, row.description].filter(Boolean).join(" | ");
  if (!text) return null;
  const t = THEATER_SHORT_RX.exec(text) ?? THEATER_LONG_RX.exec(text);
  if (t) return { type: "theater", label: theaterLabel(t[1]) };
  const h = HOME_RX.exec(text) ?? HOME_SHORT_RX.exec(text);
  if (h) return { type: "home", label: homeLabel(h[1]) };
  return null;
}

/** A row that names a release: a torrent hash, or a url with a file name or a
 *  size. An addon's status row ("Invalid config") carries a url and neither. */
function namesRelease(s: EarlyStreamRow): boolean {
  const hash = typeof s.info_hash === "string" && s.info_hash.length > 0;
  const named = typeof s.url === "string" && s.url.length > 0
    && ((typeof s.filename === "string" && s.filename.trim().length > 0)
      || (typeof s.video_size === "number" && s.video_size > 0));
  return hash || named;
}

const LEAK_SOURCES = new Set(["leakDetected", "leakRecord"]);

/** Whether one stream's AIOStreams flag is verified: a proof file, or a leak
 *  source. The stream row's chip and classifyMovieStreams use this one rule. */
export function isVerifiedFlag(f: { source?: string | null; evidence?: boolean | null } | null | undefined): boolean {
  return !!f && (f.evidence === true || (f.source != null && LEAK_SOURCES.has(f.source)));
}

function isoMs(s: string | null | undefined): number | undefined {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * What a film's stream answer says about an early release. `notices` is every
 * StreamMessage of the answer (all four buckets). Null when the answer proves
 * nothing:
 *   - an addon was asked and did not answer (`failedAddons`): only an early
 *     release is evidence then, since the missing addon may be the one that
 *     would have reported it, so "theater", "unlabeled" and "none" are not;
 *   - no rows and an addon error notice (`hadErrors`): never "none".
 */
export function classifyMovieStreams(
  streams: EarlyStreamRow[] | null | undefined,
  notices: EarlyNotice[] | null | undefined,
  opts: { hadErrors?: boolean; failedAddons?: number } = {},
): MovieEarlyEvidence | null {
  const incomplete = (opts.failedAddons ?? 0) > 0;
  const rows = (streams ?? []).filter(Boolean);
  const msgs = (notices ?? []).filter(Boolean);

  // 1) AIOStreams said so.
  const notice = msgs.find(isEarlyReleaseNotice);
  const flagged = rows.filter((r) => r.early_release);
  if (notice || flagged.length > 0) {
    const data = notice?.early_release ?? null;
    const source = data?.source ?? flagged.find((r) => r.early_release?.source)?.early_release?.source ?? undefined;
    const evidenceFiles = flagged.filter((r) => r.early_release?.evidence === true).length;
    const verified = isVerifiedFlag({ source }) || flagged.some((r) => isVerifiedFlag(r.early_release));
    const groups = (data?.release_groups ?? []).filter((g) => typeof g === "string" && g.length > 0);
    const runtime = data?.runtime_minutes;
    return {
      kind: verified ? "verified" : "flagged",
      source: source || undefined,
      detectedAt: isoMs(data?.detected_at),
      groups: groups.length > 0 ? groups.slice(0, GROUPS_KEPT) : undefined,
      groupCount: groups.length > 0 ? Math.max(groups.length, data?.release_group_count ?? 0) : undefined,
      runtimeMinutes: typeof runtime === "number" && runtime > 0 ? runtime : undefined,
      evidenceFiles: evidenceFiles || undefined,
      rows: flagged.length || undefined,
    };
  }

  // 2) Read the rows themselves.
  const releases = rows.filter(namesRelease);
  const typed = releases.map(rowReleaseType);
  const home = typed.filter((t) => t?.type === "home") as { label: string }[];
  if (home.length > 0) {
    return { kind: "home", labels: uniq(home.map((t) => t.label)), rows: home.length };
  }
  const theater = typed.filter((t) => t?.type === "theater") as { label: string }[];
  if (incomplete) return null;
  if (theater.length > 0) {
    return { kind: "theater", labels: uniq(theater.map((t) => t.label)), rows: theater.length };
  }
  if (releases.length > 0) return { kind: "unlabeled", rows: releases.length };

  // 3) Nothing. Only an answer that really came back says "none": the Digital
  // Release Filter did, and so did a clean empty list.
  if (msgs.some(isDigitalReleaseFilterNotice)) return { kind: "none" };
  return opts.hadErrors ? null : { kind: "none" };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

function expired(r: MovieEarlyRecord, nowMs: number): boolean {
  if (nowMs >= r.digitalMs) return true;
  // Checked "in the future" (a clock set ahead, then corrected, or a corrupt
  // entry): its age cannot be known, so it is not kept.
  if (r.checkedAt > nowMs + 60_000) return true;
  const ttl = isOutEarly(r.kind) ? POSITIVE_MAX_MS : NEGATIVE_TTL_MS;
  return nowMs - r.checkedAt > ttl;
}

const KINDS = new Set<string>(Object.keys(RANK));

function sane(v: unknown): MovieEarlyRecord | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  if (typeof r.kind !== "string" || !KINDS.has(r.kind)) return null;
  if (typeof r.checkedAt !== "number" || !Number.isFinite(r.checkedAt)) return null;
  if (typeof r.digitalMs !== "number" || !Number.isFinite(r.digitalMs)) return null;
  const strs = (x: unknown) => Array.isArray(x)
    ? x.filter((s): s is string => typeof s === "string").slice(0, GROUPS_KEPT)
    : undefined;
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) ? x : undefined;
  return {
    kind: r.kind as EarlyKind,
    checkedAt: r.checkedAt,
    digitalMs: r.digitalMs,
    estimate: r.estimate === true ? true : undefined,
    source: typeof r.source === "string" ? r.source.slice(0, 32) : undefined,
    detectedAt: num(r.detectedAt),
    groups: strs(r.groups),
    groupCount: num(r.groupCount),
    runtimeMinutes: num(r.runtimeMinutes),
    evidenceFiles: num(r.evidenceFiles),
    labels: strs(r.labels),
    rows: num(r.rows),
  };
}

let records: Map<string, MovieEarlyRecord> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): Map<string, MovieEarlyRecord> {
  if (records) return records;
  records = new Map();
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(KEY) : null;
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      const now = Date.now();
      for (const e of parsed) {
        if (!Array.isArray(e) || typeof e[0] !== "string") continue;
        const r = sane(e[1]);
        if (r && !expired(r, now)) records.set(e[0], r);
      }
    }
  } catch { /* unreadable: start empty */ }
  return records;
}

function save(map: Map<string, MovieEarlyRecord>): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify([...map]));
  } catch { /* quota or storage off: the session map still holds it */ }
}

/**
 * Record a film's stream answer, checked against its digital day `digitalMs`
 * (still ahead, else nothing is kept); `estimate` says that day is the
 * +45-day Estimate. A weaker answer does not replace a stronger current one
 * checked against the same day; an equal or stronger one does.
 */
export function noteMovieCheck(
  id: string | null | undefined,
  digitalMs: number | null | undefined,
  evidence: MovieEarlyEvidence | null | undefined,
  nowMs: number = Date.now(),
  estimate = false,
): void {
  if (!id || !evidence || digitalMs == null || !Number.isFinite(digitalMs) || digitalMs <= nowMs) return;
  const map = load();
  const prev = map.get(id);
  // Only an AIOStreams-backed record holds against a weaker answer, and only
  // one checked against the same day: a record for another date (the
  // Estimate before a date was announced) says nothing about this one.
  const held = prev && !expired(prev, nowMs) && (prev.kind === "verified" || prev.kind === "flagged")
    && sameDay(prev.digitalMs, digitalMs) && !!prev.estimate === estimate;
  if (held && RANK[prev.kind] > RANK[evidence.kind]) return;
  for (const [k, r] of map) if (expired(r, nowMs)) map.delete(k);
  map.delete(id); // re-insert at the end: the order is the eviction order
  while (map.size >= CAP) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
  const rec: MovieEarlyRecord = { ...evidence, checkedAt: nowMs, digitalMs, ...(estimate ? { estimate: true } : {}) };
  map.set(id, rec);
  save(map);
  if (!prev || prev.kind !== rec.kind || !!prev.estimate !== estimate) {
    console.info(
      `[release-dates] ${id}: early-release check says ${rec.kind}${rec.source ? ` (${rec.source})` : ""}` +
      (estimate ? " (no digital date announced: against the Estimate)" : ""),
    );
  }
  version += 1;
  for (const l of listeners) l();
}

/** The current record for a film, or null. */
export function movieEarlyRecord(id: string | null | undefined, nowMs: number = Date.now()): MovieEarlyRecord | null {
  if (!id) return null;
  const r = load().get(id);
  return r && !expired(r, nowMs) ? r : null;
}

function sameDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** `r` when it was checked against the day `targetMs` names (the Digital
 *  countdown it would decorate) on the same basis (`estimate`: that day is
 *  the Estimate), else null: a record checked against another date says
 *  nothing about this one. */
export function earlyRecordFor(
  r: MovieEarlyRecord | null | undefined,
  targetMs: number,
  estimate = false,
): MovieEarlyRecord | null {
  if (!r) return null;
  return sameDay(r.digitalMs, targetMs) && !!r.estimate === estimate ? r : null;
}

export function subscribeMovieEarly(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getMovieEarlyVersion(): number {
  return version;
}

/** Forget every record (node checks). */
export function clearMovieEarly(): void {
  records = new Map();
  try { if (typeof localStorage !== "undefined") localStorage.removeItem(KEY); } catch { /* ignore */ }
  version += 1;
  for (const l of listeners) l();
}

// ---------------------------------------------------------------------------
// Wording. Plain sentences, no dashes.
// ---------------------------------------------------------------------------

/** The chip's look (ReleaseBasisTag.tsx's EarlyReleaseTag). */
export type EarlyTagTone = "verified" | "unverified" | "note" | "checking";

/**
 * The chip beside the Digital countdown: the record's, else "Checking" while
 * `checking` (the detail page's stream fetch is out), else none. An early
 * release keeps its chip through a re-check.
 */
export function earlyTag(
  r: MovieEarlyRecord | null | undefined,
  checking: boolean,
  estimate = false,
): { tone: EarlyTagTone; label: string } | null {
  if (r?.kind === "verified") return { tone: "verified", label: "Verified" };
  if (r && isOutEarly(r.kind)) return { tone: "unverified", label: "Unverified" };
  if (checking) return { tone: "checking", label: estimate ? "Checking for streams" : "Checking for early copies" };
  if (r?.kind === "theater") return { tone: "note", label: "Theater copies" };
  if (r?.kind === "unlabeled") return { tone: "note", label: "Unlabeled copies" };
  return null;
}

/** Hover text while the check runs. */
export const EARLY_CHECKING_HOVER =
  "Checking your stream addons for copies that are out before the digital release.";
/** The same, against the Estimate (no digital date announced). The hover
 *  joins the Estimate's own text, which already says no date is announced. */
export const EARLY_CHECKING_HOVER_ESTIMATE =
  "Checking your stream addons for copies of this film.";

/** The hover panel's quiet line where a film can be checked and has not been
 *  (only the detail page checks). */
export function earlyUncheckedLabel(estimate: boolean): string {
  return estimate ? "Not checked for streams yet" : "Not checked for early copies yet";
}

/** Its hover text (joined after the countdown's own). */
export function earlyUncheckedHover(estimate: boolean): string {
  return estimate
    ? "No check for streams of this film is on record. Opening the film's page checks your stream addons (an answer that missed one of them is not kept)."
    : "No check for copies out before the digital release is on record for this film. Opening the film's page checks your stream addons (an answer that missed one of them is not kept).";
}

export interface EarlyWording {
  /** Replaces the countdown value when the film is out ("Out early"). */
  value: string | null;
  /** Hover text, added to the Digital countdown's own. */
  hover: string;
  /** One line for the top of the stream list (null: none). */
  banner: string | null;
}

function list(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** "at 3:12 PM", or "yesterday at 11:40 PM" (a negative answer lives 6 h). */
function checkedWhen(ms: number, nowMs: number = Date.now()): string {
  const t = new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const a = new Date(ms);
  const b = new Date(nowMs);
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return sameDay ? `at ${t}` : `yesterday at ${t}`;
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/**
 * The words for a record. `official` names the official digital release, as
 * "Tue, Nov 17, 2026 in the United States" (movieRelease's formatting).
 */
/** AIOStreams' facts for a verified / flagged record: " 12 release groups
 *  have files (A, B, C and 9 more) matching the 173 min runtime. Detected
 *  Nov 8, 2026." (each part only when known). */
function aioFacts(r: MovieEarlyRecord): string {
  const facts: string[] = [];
  if (r.groupCount && r.groups?.length) {
    const named = r.groups.slice(0, 3);
    const more = r.groupCount > named.length ? `${named.join(", ")} and ${r.groupCount - named.length} more` : list(named);
    facts.push(`${r.groupCount} release group${r.groupCount === 1 ? " has" : "s have"} files (${more})`);
  }
  // The runtime match is the verification; a flagged (unchecked) release
  // never claims it.
  if (r.kind === "verified" && r.runtimeMinutes && facts.length) facts.push(`matching the ${r.runtimeMinutes} min runtime`);
  const detail = facts.length ? ` ${facts.join(" ")}.` : "";
  const when = r.detectedAt ? ` Detected ${day(r.detectedAt)}.` : "";
  return detail + when;
}

/** The words for a record checked against the Estimate: no digital date has
 *  been announced, so nothing is "early". Streams that are out read as
 *  "Streams available", whatever they turn out to be. */
function describeEstimated(r: MovieEarlyRecord): EarlyWording {
  if (r.kind === "verified" || r.kind === "flagged") {
    const how = r.kind === "verified"
      ? r.source === "leakRecord"
        ? "AIOStreams has them on record as a leak"
        : r.evidenceFiles && !r.groupCount
          ? `AIOStreams verified them: ${r.evidenceFiles} file${r.evidenceFiles === 1 ? "'s" : "s'"} length matches the film's runtime`
          : "AIOStreams verified them as copies of this film"
      : "AIOStreams let them through as an early release, without a leak check behind it";
    return {
      value: r.kind === "verified" ? "Streams available" : "Streams available?",
      hover: `Streams of this film are already out. ${how}.${aioFacts(r)}`,
      banner: r.kind === "verified"
        ? "Streams available: no digital release date has been announced, and AIOStreams verified these as copies of this film."
        : "No digital release date has been announced. AIOStreams flagged these streams as an early release but did not verify them.",
    };
  }
  if (r.kind === "home") {
    const kinds = r.labels?.length ? list(r.labels) : "home release";
    return {
      value: "Streams available?",
      hover:
        `${kinds} copies were found, so the film may already be out digitally somewhere, or leaked. ` +
        `Nothing has verified that they are this film rather than another with the same name.`,
      banner:
        `No digital release date has been announced, but ${kinds} copies are out. The film may already be out ` +
        `digitally somewhere, or they may be leaks; nothing has verified that they are this film.`,
    };
  }
  if (r.kind === "theater") {
    const kinds = r.labels?.length ? list(r.labels) : "theater";
    return {
      value: null,
      hover: `Only theater recordings (${kinds}) were found when Aura checked ${checkedWhen(r.checkedAt)}.`,
      banner: `Only theater recordings (${kinds}) are out so far. No digital release date has been announced.`,
    };
  }
  if (r.kind === "unlabeled") {
    return {
      value: null,
      hover: `Streams were found, but none says what it was ripped from (checked ${checkedWhen(r.checkedAt)}).`,
      banner: "These streams do not say what they were ripped from, and no digital release date has been announced. They may be theater recordings, leaks or a digital release.",
    };
  }
  return {
    value: null,
    hover: `No streams were found when Aura checked ${checkedWhen(r.checkedAt)}.`,
    banner: null,
  };
}

export function describeMovieEarly(r: MovieEarlyRecord, official: string): EarlyWording {
  if (r.estimate) return describeEstimated(r);
  if (r.kind === "verified" || r.kind === "flagged") {
    const how = r.kind === "verified"
      ? r.source === "leakRecord"
        ? "AIOStreams has this leak on record"
        : r.evidenceFiles && !r.groupCount
          ? `AIOStreams verified it: ${r.evidenceFiles} file${r.evidenceFiles === 1 ? "'s" : "s'"} length matches the film's runtime`
          : "AIOStreams verified it"
      : "AIOStreams let these streams through as an early release, without a leak check behind it";
    const hover = r.kind === "verified"
      ? `Out before the official digital release. ${how}.${aioFacts(r)} ` +
        `Copies this early are leaked; the official date has not changed.`
      : `Streams were found before the official digital release. ${how}.${aioFacts(r)} ` +
        `The official date has not changed.`;
    return {
      value: r.kind === "verified" ? "Out early" : "Out early?",
      hover,
      banner: r.kind === "verified"
        ? `Out early: these streams appeared before the official digital release on ${official}, so they are leaked copies. Verified by AIOStreams.`
        : `These streams appeared before the official digital release on ${official}. AIOStreams flagged them as an early release but did not verify the leak.`,
    };
  }
  if (r.kind === "home") {
    const kinds = r.labels?.length ? list(r.labels) : "home release";
    return {
      value: "Out early?",
      hover:
        `${kinds} copies were found before the official digital release. ` +
        `They are most likely leaked, or released digitally somewhere else first. Nothing has verified ` +
        `that they are this film rather than another with the same name.`,
      banner:
        `${kinds} copies are out before the official digital release on ${official}. They may be leaked, ` +
        `and nothing has verified that they are this film.`,
    };
  }
  if (r.kind === "theater") {
    const kinds = r.labels?.length ? list(r.labels) : "theater";
    return {
      value: null,
      hover: `Only theater recordings (${kinds}) were found when Aura checked ${checkedWhen(r.checkedAt)}.`,
      banner: `Only theater recordings (${kinds}) are out so far. The digital release is on ${official}.`,
    };
  }
  if (r.kind === "unlabeled") {
    return {
      value: null,
      hover: `Streams were found before the digital release, but none says what it was ripped from (checked ${checkedWhen(r.checkedAt)}).`,
      banner: `These streams appeared before the digital release on ${official} and do not say what they were ripped from. They may be theater recordings or leaks.`,
    };
  }
  return {
    value: null,
    hover: `No early copies were found when Aura checked ${checkedWhen(r.checkedAt)}.`,
    banner: null,
  };
}
