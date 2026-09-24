// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// addonElection - the single definition of "which addons can answer this,
// and in what order".
//
// Stremio has exactly one capability matcher (`Manifest::is_resource_supported`)
// and one priority signal (the order of the user's addon array). This module
// is Aura's copy of both, so every surface that has to pick an addon asks the
// same question and gets the same answer. It replaces a meta election that
// was open-coded at five sites which disagreed with each other: DetailView and
// the hover card put AIOMetadata above the user's pin, Calendar and Airing put
// the pin first and queried one addon with no fallback, and the metaCache walk
// never read the pin at all.
//
// GATES, in order, mirroring `is_resource_supported`:
//   1. resource   `resources` contains the resource (case-insensitive)
//   2. type       resource-specific types (`stream_types` for stream), else
//                 `types` (case-insensitive)
//   3. id prefix  resource-specific prefixes (`stream_id_prefixes` for
//                 stream), else `id_prefixes`. Not applied to catalogs, whose
//                 ids are catalog ids rather than meta ids.
//
// EVERY GATE FAILS OPEN ON AN EMPTY FIELD. Deliberate, and the one real
// divergence from upstream: Stremio evaluates a live manifest, Aura evaluates
// cached AddonEntry fields that are often empty (a bare-string
// `"resources": ["stream"]` leaves stream_types empty; an old addons.json entry
// predates `resources`) and heal only when the user refreshes that addon's
// manifest, which rebuilds the entry (for a signed-in user, only until the next
// launch). Empty means "unknown", and unknown is kept.
//
// ORDER. Every resource except meta comes back in plain addon-array order:
// no tiers, no exemption. The stream-list invariants in CLAUDE.md depend on
// that.
//
// SEARCH is not a gate here. It is a precomputed `has_search` flag that the
// Rust side enforces, so it fails CLOSED instead (see electSearchAddons).
//
// HOME is the catalog resource gate over the whole list (electHomeAddons):
// every addon that may serve catalogs, in array order, which is Stremio's
// board. Which catalogs each one contributes is its live manifest's call.
//
// Meta is ranked in tiers, with array order deciding WITHIN each tier:
//   1 declared        declares meta, has id prefixes, and one matches the id
//   2 primary-exempt  the PRIMARY, kept even though its prefixes miss this
//                     id, when no addon declares a prefix that matches it.
//                     The primary is the user's pinned meta provider if it
//                     declares meta with id prefixes, else the FIRST addon in
//                     array order that does. The real provider under-declares
//                     (AIOMetadata answers ids it does not list), and this
//                     keeps it answering them.
//   3 open-prefix     declares meta with no id prefixes: a catch-all
//   4 open-resource   no resources recorded at all: a stale entry
// Every other addon that declares meta with prefixes that miss is rejected,
// and so is the primary once some addon claims the id: then it is Stremio's
// case, and probing it too would only add a 404 behind the real answer. Why
// tiers: pure order would hand EVERY title to a prefix-less catch-all sitting
// at the top of the list, such as "AI Search", whose meta for a foreign id is
// an empty stub. Stremio would do exactly that; Aura deliberately ranks
// declared providers above catch-alls for meta. That is what put AIOMetadata
// first before, without naming any addon.
//
// The user's "Default Metadata Provider" pin therefore does two things: it
// holds the tier-2 exemption, and applyPrimary hoists it to the front of the
// tiers (see electMetaAddons). Without the first, a Cinemeta sitting above a
// pinned AIOMetadata would take the exemption and the pin could never lead
// for an id only AIOMetadata resolves.
//
// Every election logs one `[election]` line. `#N` in it is the addon's index
// in the Addons list (0-based). See logElection for the dedupe.
// ---------------------------------------------------------------------------

import type { AddonEntry } from "./types";
import { loadAuraSettings, type AuraSettings } from "./auraSettings";

export type ElectResource = "meta" | "stream" | "subtitles" | "catalog" | "addon_catalog";

export interface ElectQuery {
  resource: ElectResource;
  /** "movie" | "series" | ... Omitted or empty skips the type gate. */
  type?: string;
  /** "tt0903747", "kitsu:1234". Omitted or empty skips the prefix gate. */
  id?: string;
}

export type ElectReason =
  | "declared"
  | "open-resource"
  | "open-type"
  | "open-prefix"
  | "primary-exempt";

export interface Elected {
  addon: AddonEntry;
  /** Index in the addons array: the priority. */
  rank: number;
  reason: ElectReason;
}

/** `override` is not a capability gate: it marks a capable addon that the
 *  user's provider list in Settings leaves out, so a narrowed fan-out shows
 *  up in the log instead of reading as a missing capability. */
type Gate = "resource" | "type" | "prefix" | "override";

interface Rejected {
  addon: AddonEntry;
  rank: number;
  gate: Gate;
}

/** Meta tier per reason. An addon whose only open gate is `type` still
 *  declares meta and a matching prefix, so it ranks with the declared. */
const META_TIER: Record<ElectReason, number> = {
  "declared":       1,
  "open-type":      1,
  "primary-exempt": 2,
  "open-prefix":    3,
  "open-resource":  4,
};

function listOf(v: readonly string[] | undefined | null): readonly string[] {
  return Array.isArray(v) ? v : [];
}

function hasCi(list: readonly string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return list.some((v) => typeof v === "string" && v.toLowerCase() === n);
}

/** `AddonEntry.types` is truncated to this many entries on the Rust side
 *  (`collect_wire_types` / `extract_manifest_types` both `take(8)`). A list
 *  AT the cap may have lost the queried type, so it cannot prove absence and
 *  the type gate fails open on a miss, the same as on an empty list. */
const TYPES_CAP = 8;

/** The type list the gate reads, and whether a miss in it is conclusive. */
function typesFor(
  a: AddonEntry,
  resource: ElectResource,
): { types: readonly string[]; exhaustive: boolean } {
  const own = resource === "stream" ? listOf(a.stream_types) : [];
  if (own.length > 0) return { types: own, exhaustive: true };
  const types = listOf(a.types);
  return { types, exhaustive: types.length > 0 && types.length < TYPES_CAP };
}

function prefixesFor(a: AddonEntry, resource: ElectResource): readonly string[] {
  const own = resource === "stream" ? listOf(a.stream_id_prefixes) : [];
  return own.length > 0 ? own : listOf(a.id_prefixes);
}

/** An addon that passed the resource and type gates, before the prefix gate
 *  (and the meta primary exemption) settles whether it is elected. */
interface Passed {
  addon: AddonEntry;
  rank: number;
  openResource: boolean;
  openType: boolean;
  openPrefix: boolean;
  prefixMiss: boolean;
}

/** `pin` only matters for meta: it names the addon that holds the primary
 *  exemption (see the header). Every other resource ignores it. */
function evaluate(
  addons: readonly AddonEntry[],
  q: ElectQuery,
  pin: string | null = null,
): { elected: Elected[]; rejected: Rejected[] } {
  const isMeta = q.resource === "meta";
  const id = q.id ?? "";
  const gatePrefix = id.length > 0 && q.resource !== "catalog" && q.resource !== "addon_catalog";
  const passed: Passed[] = [];
  const rejected: Rejected[] = [];

  addons.forEach((addon, rank) => {
    const resources = listOf(addon.resources);
    const openResource = resources.length === 0;
    if (!openResource && !hasCi(resources, q.resource)) {
      rejected.push({ addon, rank, gate: "resource" });
      return;
    }

    const { types, exhaustive } = typesFor(addon, q.resource);
    const typeHit = !!q.type && hasCi(types, q.type);
    if (q.type && !typeHit && exhaustive) {
      rejected.push({ addon, rank, gate: "type" });
      return;
    }

    const prefixes = gatePrefix ? prefixesFor(addon, q.resource) : [];
    passed.push({
      addon,
      rank,
      openResource,
      openType: !!q.type && !typeHit,
      openPrefix: gatePrefix && prefixes.length === 0,
      prefixMiss: prefixes.length > 0 && !prefixes.some((p) => id.startsWith(p)),
    });
  });

  // The meta primary exemption. Only an addon that DECLARES meta (a stale
  // empty `resources` is not a declaration) with prefixes of its own can hold
  // it: the user's pin when it qualifies, else the first such addon in array
  // order. It is granted only when NO such addon claims this id, so it covers
  // ids nobody declares and never adds a probe behind a provider that does.
  let exempt: Passed | undefined;
  if (isMeta && gatePrefix) {
    const declaring = passed.filter((p) => !p.openResource && !p.openPrefix);
    const primary = declaring.find((p) => pin !== null && p.addon.url === pin) ?? declaring[0];
    if (primary?.prefixMiss && declaring.every((p) => p.prefixMiss)) exempt = primary;
  }

  const elected: Elected[] = [];
  for (const p of passed) {
    if (p.prefixMiss && p !== exempt) {
      rejected.push({ addon: p.addon, rank: p.rank, gate: "prefix" });
      continue;
    }
    const reason: ElectReason =
      p.openResource ? "open-resource"
      : p.openPrefix ? "open-prefix"
      : p === exempt ? "primary-exempt"
      : p.openType   ? "open-type"
      : "declared";
    elected.push({ addon: p.addon, rank: p.rank, reason });
  }

  if (isMeta) {
    elected.sort((a, b) => (META_TIER[a.reason] - META_TIER[b.reason]) || (a.rank - b.rank));
  }
  return { elected, rejected };
}

/** Every addon that can answer `q`, best first. Non-meta resources keep
 *  addon-array order exactly; meta is tiered (see the header). */
export function electAddons(addons: readonly AddonEntry[], q: ElectQuery): Elected[] {
  const { elected, rejected } = evaluate(addons, q);
  logElection(q, addons, elected, rejected, null);
  return elected;
}

/** An explicit provider list from Settings. `null` passes the election
 *  through untouched; an array keeps only the elected addons it names, in
 *  the array's order, so an uninstalled or incapable URL simply drops out,
 *  and `[]` keeps none. Generic over the entry so streamQueryAddons can hand
 *  it an unelected list (the Rust stream gate does that filtering). */
export function applyOverride<T extends Pick<Elected, "addon">>(
  elected: T[],
  urls: readonly string[] | null,
): T[] {
  if (urls === null) return elected;
  const byUrl = new Map<string, T>();
  for (const e of elected) {
    // First wins: array order is the priority, so a URL listed twice in the
    // addons array resolves to the entry the user sees first.
    if (!byUrl.has(e.addon.url)) byUrl.set(e.addon.url, e);
  }
  const out: T[] = [];
  for (const url of urls) {
    const e = byUrl.get(url);
    if (!e) continue;
    out.push(e);
    byUrl.delete(url); // a duplicated URL is queried once
  }
  return out;
}

/** A single "this one leads" pin. Hoists `url` to the front when it is a
 *  candidate and leaves everything else in place as the fallback. A URL
 *  that is not a candidate (not installed, or cannot answer this query) is
 *  ignored. */
export function applyPrimary(elected: Elected[], url: string | null): Elected[] {
  if (!url) return elected;
  const i = elected.findIndex((e) => e.addon.url === url);
  if (i <= 0) return elected;
  return [elected[i], ...elected.slice(0, i), ...elected.slice(i + 1)];
}

/** The meta providers for one title, best first, with the user's Default
 *  Metadata Provider pin applied. The ONE meta election: DetailView, the
 *  hover card, Calendar, Airing, the art retry and both metaCache walks all
 *  call this, so they cannot disagree about who answers. */
export function electMetaAddons(
  addons: readonly AddonEntry[],
  type: string,
  id: string,
): AddonEntry[] {
  const q: ElectQuery = { resource: "meta", type, id };
  // Read first: the pin decides who holds the primary exemption, not just
  // who leads, so a pinned provider keeps answering ids it under-declares
  // even when another declared meta addon sits above it in the list.
  const pin = loadAuraSettings().defaultMetadataAddonUrl ?? null;
  const { elected, rejected } = evaluate(addons, q, pin);
  // applyPrimary only sees the candidates, so the "installed but cannot
  // serve meta at all" case is told apart here, where the full list is.
  warnIncapablePin(addons, pin, "meta");
  const final = applyPrimary(elected, pin);
  logElection(q, addons, final, rejected, pin);
  return final.map((e) => e.addon);
}

/** The addons a deliberate (Enter) search fans out to: every search
 *  provider in addon-array order, then the user's Search Providers list
 *  (`searchAddonUrls`) through applyOverride. Fails CLOSED, unlike the gates
 *  above: `has_search` is computed from the live manifest at install/sync,
 *  and `search_addon_grouped` returns nothing for an addon without it, so
 *  keeping one here could only add an empty slot to the results. */
export function electSearchAddons(addons: readonly AddonEntry[]): AddonEntry[] {
  const elected: Elected[] = [];
  const rejected: Rejected[] = [];
  addons.forEach((addon, rank) => {
    if (isSearchProvider(addon)) elected.push({ addon, rank, reason: "declared" });
    else rejected.push({ addon, rank, gate: "resource" });
  });
  const final = applyOverride(elected, loadAuraSettings().searchAddonUrls);
  for (const e of elected) {
    if (!final.includes(e)) rejected.push({ addon: e.addon, rank: e.rank, gate: "override" });
  }
  logElection({ resource: "search" }, addons, final, rejected, null);
  return final.map((e) => e.addon);
}

/** The addons whose catalogs make up Home, in row order. Every addon that
 *  may serve catalogs (the fail-open resource gate Discover uses), in
 *  addon-array order, like Stremio's board.
 *
 *  The Settings "Home Catalog Sources" picker is an override on top: its
 *  primary (`defaultHomeAddonUrl`) then `additionalHomeAddonUrls`, through
 *  applyOverride, so a URL listed twice keeps its first position and an
 *  uninstalled one drops out.
 *
 *  An override that names no installed Home source at all DELIBERATELY
 *  behaves as no override: Home shows the automatic board above, with a
 *  one-time `[election]` warning. The old resolver put `addons[0]` in
 *  whenever the primary was unset or uninstalled, so this case stranded the
 *  user on that one addon's catalogs, an arbitrary pick; that substitution is
 *  gone. Nor does Home go empty: the picker lists only installed Home sources
 *  (isHomeSource), so a stale override that matches none of them is invisible
 *  there and the user could not see what to undo. That includes an addon the
 *  older picker allowed (one declaring `meta` or `addon_catalog` but not
 *  `catalog`), which is installed but no longer listed. */
export function electHomeAddons(addons: readonly AddonEntry[]): AddonEntry[] {
  const elected: Elected[] = [];
  const rejected: Rejected[] = [];
  addons.forEach((addon, rank) => {
    if (!isHomeSource(addon)) {
      rejected.push({ addon, rank, gate: "resource" });
      return;
    }
    const reason: ElectReason = listOf(addon.resources).length === 0 ? "open-resource" : "declared";
    elected.push({ addon, rank, reason });
  });

  let final = elected;
  const urls = homeOverrideUrls();
  if (urls !== null) {
    if (namesHomeSource(urls, addons)) {
      final = applyOverride(elected, urls);
      for (const e of elected) {
        if (!final.includes(e)) rejected.push({ addon: e.addon, rank: e.rank, gate: "override" });
      }
    } else {
      warnStaleHomeOverride(urls);
    }
  }
  logElection({ resource: "home" }, addons, final, rejected, null);
  return final.map((e) => e.addon);
}

/** The Home Catalog Sources override as one list, the primary first, or
 *  `null` when it is unset. Unset means both halves empty, the rule the old
 *  Home resolver used, so a primary alone or additionals alone each count. */
function homeOverrideUrls(): string[] | null {
  const { defaultHomeAddonUrl: primary, additionalHomeAddonUrls } = loadAuraSettings();
  const additional = additionalHomeAddonUrls ?? [];
  if (primary == null && additional.length === 0) return null;
  return primary != null ? [primary, ...additional] : additional;
}

/** Whether the Home override is in force: it names at least one installed
 *  addon the Home picker can show, i.e. one it could be edited back from. */
function namesHomeSource(urls: readonly string[], addons: readonly AddonEntry[]): boolean {
  return urls.some((url) => addons.some((a) => a.url === url && isHomeSource(a)));
}

// ── Empty elections ───────────────────────────────────────────────────────
// Under automatic election an empty result usually means nothing INSTALLED
// can do the job, which Settings cannot fix; only the Addons page can. A
// provider override is the cause only when it is in force and leaves out an
// installed addon that could have done the job. NoProvidersWarning routes on
// this, so it sends the user to Settings only when there is something there
// to undo.

export type ProviderJob = "home" | "search" | "streams";

/** The job's provider list from Settings while it is in force, else `null`.
 *  Search and Streams are in force whenever set, `[]` included. Home only
 *  while it names an installed Home source: electHomeAddons ignores a stale
 *  one. */
function overrideInForce(addons: readonly AddonEntry[], job: ProviderJob): readonly string[] | null {
  switch (job) {
    case "home": {
      const home = homeOverrideUrls();
      return home !== null && namesHomeSource(home, addons) ? home : null;
    }
    case "search":
      return loadAuraSettings().searchAddonUrls;
    case "streams":
      return loadAuraSettings().streamAddonUrls;
  }
}

/** Why `job` has no provider: "override" when its Settings override is the
 *  cause, else "addons". Call it only once the job is known to be empty. */
export function emptyElectionCause(
  addons: readonly AddonEntry[],
  job: ProviderJob,
): "addons" | "override" {
  const urls = overrideInForce(addons, job);
  if (urls === null) return "addons";
  const capable = job === "home" ? isHomeSource : job === "search" ? isSearchProvider : isStreamProvider;
  const listed = new Set(urls);
  return addons.some((a) => capable(a) && !listed.has(a.url)) ? "override" : "addons";
}

/** A job whose provider the user can override in Settings, behind "Show
 *  advanced settings": the three provider lists plus the Default Metadata
 *  Provider pin. */
export type OverridableJob = ProviderJob | "meta";

/** Every job whose Settings override is in force, in Settings page order.
 *  For the Addons page, which says that addon order alone does not decide
 *  these. The meta pin counts while it names an installed addon that may
 *  serve meta: one that is not installed is never a candidate for
 *  applyPrimary, and one that serves no meta is ignored (warnIncapablePin). */
export function overriddenJobs(addons: readonly AddonEntry[]): OverridableJob[] {
  const pin = loadAuraSettings().defaultMetadataAddonUrl ?? null;
  const metaPinned = pin !== null && addons.some((a) => a.url === pin && mayServe(a, "meta"));
  const out: OverridableJob[] = [];
  if (overrideInForce(addons, "home") !== null) out.push("home");
  if (metaPinned) out.push("meta");
  if (overrideInForce(addons, "streams") !== null) out.push("streams");
  if (overrideInForce(addons, "search") !== null) out.push("search");
  return out;
}

/** The AuraSettings keys `overriddenJobs` reads, for a view that re-renders
 *  on a change (a cloud pull can land while it is open). */
export const OVERRIDE_SETTING_KEYS = new Set<keyof AuraSettings>([
  "defaultHomeAddonUrl",
  "additionalHomeAddonUrls",
  "defaultMetadataAddonUrl",
  "streamAddonUrls",
  "searchAddonUrls",
]);

// ── Capability predicates ─────────────────────────────────────────────────
// "Can this addon do X at all", for the lists that are not a per-title
// election: Discover's addon picker and the three Settings provider pickers.
// Each view used to carry a private copy, and they disagreed on casing.
// Resource matching is case-insensitive here, like the gates above.

/** True when the cached `resources` names any of `resources`. Strict: an
 *  empty list declares nothing, so a stale entry is not listed under every
 *  provider heading in Settings. */
function declaresResource(addon: AddonEntry, ...resources: ElectResource[]): boolean {
  const list = listOf(addon.resources);
  return resources.some((r) => hasCi(list, r));
}

/** The resource gate on its own, failing open on an empty list like every
 *  gate here: could this addon serve `resource`? */
export function mayServe(addon: AddonEntry, resource: ElectResource): boolean {
  const list = listOf(addon.resources);
  return list.length === 0 || hasCi(list, resource);
}

/** Home eligibility: every addon that may serve catalogs, AIOStreams
 *  included, since the automatic board shows its catalogs. electHomeAddons
 *  and Settings' Home Catalog Sources picker both use this, so the override
 *  can name any addon the default board would draw on. Fail-open like the
 *  election it mirrors, unlike the two strict pickers below. */
export function isHomeSource(addon: AddonEntry): boolean {
  return mayServe(addon, "catalog");
}

/** Settings' Stream Providers picker. Strict like the Rust stream gate,
 *  which also refuses an addon whose `resources` does not name `stream`. */
export function isStreamProvider(addon: AddonEntry): boolean {
  return declaresResource(addon, "stream");
}

/** Search capability: the flat `has_search` flag the manifest probe set at
 *  install/sync time. Fail-closed; see electSearchAddons. */
export function isSearchProvider(addon: AddonEntry): boolean {
  return addon.has_search === true;
}

// ── Observability ─────────────────────────────────────────────────────────
// The CW poster warm, the hover cards and Calendar elect meta for dozens of
// titles in a burst, and re-elect the same ones on every re-render (Calendar
// and Airing re-walk the WHOLE library on every revisit). The same
// (resource, type, id, addon list, pin, outcome) is therefore logged at most
// once per LOG_WINDOW_MS, for up to LOG_CAP distinct keys inside one window.
// The cap sits well above a realistic library, because a cyclic pass over
// more keys than the cap evicts each one before its next use and re-logs all
// of them. Expired keys are pruned first, so the map stays small in steady
// state; a burst of more than LOG_CAP distinct keys falls back to
// oldest-first eviction and can re-log. Keys are short strings plus a hash,
// so even a full map is a few hundred KB at most.

const LOG_WINDOW_MS = 60_000;
const LOG_CAP = 2000;
const lastLogged = new Map<string, number>();

/** FNV-1a, so the dedupe key carries the addon list without holding every
 *  (token-bearing) addon URL in memory once per logged title. */
function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function shouldLog(key: string): boolean {
  const now = Date.now();
  const prev = lastLogged.get(key);
  if (prev !== undefined && now - prev < LOG_WINDOW_MS) return false;
  // Re-insert at the tail so eviction below stays oldest-first.
  lastLogged.delete(key);
  // A key is only (re)inserted when it is logged, so Map order is log-time
  // order and every expired key sits at the head.
  for (const [k, t] of lastLogged) {
    if (now - t < LOG_WINDOW_MS) break;
    lastLogged.delete(k);
  }
  lastLogged.set(key, now);
  if (lastLogged.size > LOG_CAP) {
    const oldest = lastLogged.keys().next().value;
    if (oldest !== undefined) lastLogged.delete(oldest);
  }
  return true;
}

/** Names, never URLs: an addon URL routinely embeds the user's config
 *  token, and these lines are exported with the DevConsole log. */
function nameOf(a: AddonEntry): string {
  return a.name || "(unnamed addon)";
}

/** What an election line is about. Search is not an ElectResource (it is
 *  never gated like one) and Home is a catalog election with its own
 *  override, but both log through the same line. */
type LogSubject = Omit<ElectQuery, "resource"> & { resource: ElectResource | "search" | "home" };

function logElection(
  q: LogSubject,
  addons: readonly AddonEntry[],
  final: Elected[],
  rejected: Rejected[],
  pin: string | null,
): void {
  // The outcome is part of the key, so a Settings override that changes the
  // answer (search) logs again inside the window instead of being deduped.
  const key = [
    q.resource, q.type ?? "", q.id ?? "",
    hashOf(`${addons.map((a) => a.url).join("\n")}\n${pin ?? ""}`),
    final.map((e) => e.rank).join(","),
  ].join("|");
  if (!shouldLog(key)) return;

  const pinTag = (a: AddonEntry) => (pin && a.url === pin ? " pinned" : "");
  const describe = (e: Elected) => `${nameOf(e.addon)} #${e.rank} ${e.reason}${pinTag(e.addon)}`;
  const [winner, ...rest] = final;
  const parts = [winner ? `-> ${describe(winner)}` : "-> none"];
  if (rest.length > 0) parts.push(`then ${rest.map(describe).join(", ")}`);
  for (const gate of ["resource", "type", "prefix", "override"] as const) {
    const hit = rejected.filter((r) => r.gate === gate);
    if (hit.length === 0) continue;
    parts.push(`rejected by ${gate}: ${hit.map((r) => `${nameOf(r.addon)} #${r.rank}${pinTag(r.addon)}`).join(", ")}`);
  }
  const subject = [q.resource, q.type, q.id].filter(Boolean).join(" ");
  console.info(`[election] ${subject} ${parts.join("; ")}`);
}

/** Pins (and stale Home overrides, by hash) already warned about. A pin is
 *  one URL per resource, so this stays tiny; the clear is only a backstop
 *  against a pathological session. */
const warnedPins = new Set<string>();

/** Warn ONCE per override value when the Home override names no installed
 *  addon and electHomeAddons falls back to every catalog addon. Hashed, like
 *  the log dedupe, so no token-bearing URL is held. */
function warnStaleHomeOverride(urls: readonly string[]): void {
  const key = `home:${hashOf(urls.join("\n"))}`;
  if (warnedPins.has(key)) return;
  if (warnedPins.size >= 16) warnedPins.clear();
  warnedPins.add(key);
  console.warn(
    `[election] home sources override ignored: none of its ${urls.length} addon(s) ` +
      "is an installed catalog source, so Home shows every catalog addon",
  );
}

/** Warn ONCE when the pinned addon is installed but does not declare the
 *  resource at all. That pin can never lead, so it is ignored, and silently
 *  ignoring a setting the user chose is the failure this log exists for. A
 *  pin that serves the resource but misses one id's prefix is not this case:
 *  it shows up per title as a rejected candidate in the election line. */
function warnIncapablePin(
  addons: readonly AddonEntry[],
  pin: string | null,
  resource: ElectResource,
): void {
  if (!pin || warnedPins.has(pin)) return;
  const pinned = addons.find((a) => a.url === pin);
  if (!pinned) return;
  const resources = listOf(pinned.resources);
  if (resources.length === 0 || hasCi(resources, resource)) return;
  if (warnedPins.size >= 16) warnedPins.clear();
  warnedPins.add(pin);
  console.warn(
    `[election] ${resource} pin ${nameOf(pinned)} ignored: it does not serve ` +
      `${resource} (declares ${resources.join(", ")})`,
  );
}
