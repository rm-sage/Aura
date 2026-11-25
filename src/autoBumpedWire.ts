// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// autoBumpedWire: the auto-bumped set's stored and synced shapes, and its
// cloud merge. Import-free (node can check it with hand-written cases).
//
// The set is PER ACCOUNT (autoBumped.ts). Each entry is a series id with a
// signed time: positive = bumped at that ms, negative = cleared at that ms (a
// tombstone). The newer of two entries wins, so clearing a series on one
// device clears it on the others; with plain union semantics (up to v2.3.2) a
// clear never propagated and the other device's pull put it straight back.
//
// The cloud blob stays a JSON array of strings, because an older Aura on
// another device merges this namespace by spreading both sides into a Set: an
// object would throw there. The array is `[WIRE_V2, "+<ms>|<id>", "-<ms>|<id>",
// ...]`. An older Aura unions those strings in as if they were ids (no series
// has such an id, so they hide nothing) and pushes back its own bare ids,
// which this side ignores. An array with no WIRE_V2 is a pre-v2 blob: the
// device-wide set every account's blob was union-merged with, so it is NOT
// this account's and is ignored rather than merged (see `mergeAutoBumpedWire`).

export const WIRE_V2 = "aura:auto-bumped:v2";

/** id -> signed ms (positive bumped, negative cleared). */
export type AutoBumpedEntries = Record<string, number>;

/** Tombstones older than this are dropped: long enough for every device to
 *  have pulled the clear. */
export const TOMBSTONE_TTL_MS = 180 * 86_400_000;
/** Hard cap on entries; tombstones go first, oldest first. */
export const MAX_ENTRIES = 2000;

function isEntryValue(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v !== 0;
}

/** Parses the stored value. Accepts the per-account object
 *  `{ v: 2, e: { id: ms } }` and a plain id array (a pre-v2 snapshot or the
 *  old device-wide key), whose ids count as bumped long ago (`legacyAt`), so
 *  any dated entry beats them. */
export function parseStored(raw: string | null, legacyAt = 1): AutoBumpedEntries {
  const out: AutoBumpedEntries = {};
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === "string" && id && !id.startsWith("aura:") && !/^[+-]\d+\|/.test(id)) out[id] = legacyAt;
      }
      return out;
    }
    if (parsed && typeof parsed === "object") {
      const e = (parsed as { e?: unknown }).e;
      if (e && typeof e === "object") {
        for (const [id, v] of Object.entries(e as Record<string, unknown>)) {
          if (id && isEntryValue(v)) out[id] = v;
        }
      }
    }
  } catch { /* unreadable: empty */ }
  return out;
}

export function serializeStored(entries: AutoBumpedEntries): string {
  return JSON.stringify({ v: 2, e: entries });
}

/** The series ids currently bumped. */
export function activeIds(entries: AutoBumpedEntries): string[] {
  return Object.keys(entries).filter((id) => entries[id] > 0);
}

/** Drops old tombstones and enforces MAX_ENTRIES (tombstones first, then the
 *  oldest bumps). Returns a new object. */
export function pruneEntries(entries: AutoBumpedEntries, now: number): AutoBumpedEntries {
  const kept = Object.entries(entries).filter(
    ([, v]) => v > 0 || now - -v < TOMBSTONE_TTL_MS,
  );
  if (kept.length > MAX_ENTRIES) {
    // Tombstones before bumps, each oldest first.
    kept.sort((a, b) => {
      const ta = a[1] < 0, tb = b[1] < 0;
      if (ta !== tb) return ta ? -1 : 1;
      return Math.abs(a[1]) - Math.abs(b[1]);
    });
    kept.splice(0, kept.length - MAX_ENTRIES);
  }
  return Object.fromEntries(kept);
}

export function toWire(entries: AutoBumpedEntries): string[] {
  const out = [WIRE_V2];
  for (const [id, v] of Object.entries(entries)) {
    out.push(`${v > 0 ? "+" : "-"}${Math.abs(Math.round(v))}|${id}`);
  }
  return out;
}

/** Reads a cloud blob. A pre-v2 blob (no WIRE_V2) yields nothing: it is the
 *  old device-wide union, not this account's. Bare ids an older Aura pushed
 *  into a v2 blob are ignored for the same reason. */
export function fromWire(wire: unknown): AutoBumpedEntries {
  const out: AutoBumpedEntries = {};
  if (!Array.isArray(wire) || !wire.includes(WIRE_V2)) return out;
  for (const s of wire) {
    if (typeof s !== "string") continue;
    const m = /^([+-])(\d+)\|(.+)$/.exec(s);
    if (!m) continue;
    const ms = Number(m[2]);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    const v = m[1] === "+" ? ms : -ms;
    const id = m[3];
    const prev = out[id];
    if (prev === undefined || newer(v, prev)) out[id] = v;
  }
  return out;
}

/** True when `a` should replace `b`: the later time wins; on a tie the clear
 *  wins (it only lets a show back into Continue Watching). */
function newer(a: number, b: number): boolean {
  const ta = Math.abs(a), tb = Math.abs(b);
  return ta > tb || (ta === tb && a < 0 && b > 0);
}

/** Per-id newest-wins merge of two entry sets. */
export function mergeEntries(a: AutoBumpedEntries, b: AutoBumpedEntries): AutoBumpedEntries {
  const out: AutoBumpedEntries = { ...a };
  for (const [id, v] of Object.entries(b)) {
    const prev = out[id];
    if (prev === undefined || newer(v, prev)) out[id] = v;
  }
  return out;
}

/** The sync MergeFn: both sides are wire arrays. `local` is always v2 (read
 *  from this account's store); a pre-v2 `server` contributes nothing, and the
 *  merged result is pushed over it. */
export function mergeAutoBumpedWire(local: unknown, server: unknown, now: number): string[] {
  return toWire(pruneEntries(mergeEntries(fromWire(local), fromWire(server)), now));
}
