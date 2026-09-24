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
// cached AddonEntry fields that are often empty and never heal (a bare-string
// `"resources": ["stream"]` leaves stream_types empty; an old addons.json entry
// predates `resources`). Empty means "unknown", and unknown is kept.
//
// ORDER. Every resource except meta comes back in plain addon-array order:
// no tiers, no exemption. The stream-list invariants in CLAUDE.md depend on
// that.
//
// SEARCH is not a gate here. It is a precomputed `has_search` flag that the
// Rust side enforces, so it fails CLOSED instead (see electSearchAddons).
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
import { loadAuraSettings } from "./auraSettings";

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

/** Settings' Catalog Providers picker: addons that surface metadata or wrap
 *  other addons, i.e. what can reasonably feed Home. Keyed on `meta` and
 *  `addon_catalog`, NOT `catalog`: a pure stream addon that ships a catalog
 *  (AIOStreams does) does not belong in it. */
export function isCatalogProvider(addon: AddonEntry): boolean {
  return declaresResource(addon, "meta", "addon_catalog");
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
 *  never gated like one) but logs through the same line. */
type LogSubject = Omit<ElectQuery, "resource"> & { resource: ElectResource | "search" };

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

/** Pins already warned about. A pin is one URL per resource, so this stays
 *  tiny; the clear is only a backstop against a pathological session. */
const warnedPins = new Set<string>();

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
