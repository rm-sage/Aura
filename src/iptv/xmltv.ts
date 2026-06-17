// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// XMLTV EPG parser (Live TV spec §1). Hand-rolled scanning over the
// document string — no DOMParser (EPGs reach tens of MB; building a DOM
// doubles the peak). The Rust fetch command enforces the size cap, so
// this parser works on a bounded in-memory string. The reference design
// streamed chunks off the network; that refinement can come with the UI
// phase if real EPGs prove too large for the cap.
//
// We extract exactly what the guide needs from each <programme> block:
// start/stop attrs, channel attr, <title>, <desc>, first <category>,
// <icon src>.
// ---------------------------------------------------------------------------

import type { EpgIndex, EpgProgram } from "./types";

/** `YYYYMMDDHHMMSS [±HHMM]` → epoch ms. Null on malformed input. */
export function parseXmltvTime(raw: string): number | null {
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, tzh, tzm] = m;
  let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (sign && tzh && tzm) {
    const offsetMin = (+tzh * 60 + +tzm) * (sign === "-" ? -1 : 1);
    ms -= offsetMin * 60_000;
  }
  return Number.isFinite(ms) ? ms : null;
}

/** Parse every `<programme>` block. Tolerant: malformed blocks are
 *  skipped, not fatal.
 *
 *  When `relevant` is provided, programmes whose `channel` (EPG id) is not in
 *  the set are skipped BEFORE the expensive title/desc extraction. The set is
 *  the exact id space the resolver can ever resolve to (playlist tvg-ids plus
 *  name-fallback ids), so this is a LOSSLESS memory cut: a global playlist
 *  paired with a regional EPG would otherwise index hundreds of thousands of
 *  programmes for channels the user can never watch. Pass `undefined` to keep
 *  everything. */
export function parseXmltv(xml: string, relevant?: Set<string>): EpgProgram[] {
  const out: EpgProgram[] = [];
  let from = 0;
  for (;;) {
    const open = xml.indexOf("<programme", from);
    if (open === -1) break;
    const openEnd = xml.indexOf(">", open);
    if (openEnd === -1) break;
    const close = xml.indexOf("</programme>", openEnd);
    if (close === -1) break;
    from = close + "</programme>".length;

    const tag = xml.slice(open, openEnd + 1);

    const start = attrValue(tag, "start").map(parseXmltvTime).find((v) => v != null) ?? null;
    const stop = attrValue(tag, "stop").map(parseXmltvTime).find((v) => v != null) ?? null;
    const channel = attrValue(tag, "channel")[0] ?? "";
    if (start == null || stop == null || !channel || stop <= start) continue;
    // Skip channels this playlist can never resolve — before the slice +
    // entity-decode work below, so filtering also saves parse CPU.
    if (relevant && !relevant.has(channel)) continue;

    const body = xml.slice(openEnd + 1, close);

    out.push({
      channelTvgId: channel,
      title: childText(body, "title") ?? "",
      description: childText(body, "desc") ?? "",
      startMs: start,
      endMs: stop,
      category: childText(body, "category"),
      iconUrl: attrOfChild(body, "icon", "src"),
    });
  }
  return out;
}

/** Programs grouped by tvg-id, each list sorted by start time. The optional
 *  `nameToId` (from `parseXmltvChannelNames`) is folded in for the resolver's
 *  name-based fallback; pass an empty map when not building one. */
export function indexProgramsByChannel(
  programs: EpgProgram[],
  nameToId?: Map<string, string>,
): EpgIndex {
  const byChannel = new Map<string, EpgProgram[]>();
  for (const p of programs) {
    const list = byChannel.get(p.channelTvgId);
    if (list) list.push(p);
    else byChannel.set(p.channelTvgId, [p]);
  }
  for (const list of byChannel.values()) {
    list.sort((a, b) => a.startMs - b.startMs);
  }
  return { byChannel, nameToId: nameToId ?? new Map(), fetchedAt: Date.now() };
}

/** Full EPG build: name index → relevant-id set → filtered programme index.
 *  Pure (no DOM / Tauri), so it runs identically in the off-main-thread
 *  worker (epgWorker.ts) and as the main-thread fallback. `channels` carries
 *  just the join fields. `rawHasPrograms` lets the caller tell "the EPG body
 *  had no <programme> at all" (a broken feed → surface an error) apart from
 *  "had programmes but none matched this playlist" (fine → empty index, no
 *  now/next). */
export function buildEpgIndex(
  body: string,
  channels: ReadonlyArray<{ tvgId: string; name: string }>,
): { index: EpgIndex; rawHasPrograms: boolean } {
  const nameToId = parseXmltvChannelNames(body);
  // The exact id space the resolver can resolve to: each channel's tvg-id
  // plus, when its name maps to an EPG display-name, that mapped id.
  const relevant = new Set<string>();
  for (const ch of channels) {
    const id = ch.tvgId.trim();
    if (id) relevant.add(id);
    const nk = normalizeChannelName(ch.name);
    const mapped = nk ? nameToId.get(nk) : undefined;
    if (mapped) relevant.add(mapped);
  }
  const rawHasPrograms = body.includes("<programme");
  const programs = parseXmltv(body, relevant);
  return { index: indexProgramsByChannel(programs, nameToId), rawHasPrograms };
}

/** Build a normalized-display-name → channel-id map from every `<channel>`
 *  block. A name that resolves to more than one distinct channel id is
 *  dropped (ambiguous) so the fallback never guesses between collisions. */
export function parseXmltvChannelNames(xml: string): Map<string, string> {
  const nameToId = new Map<string, string>();
  const ambiguous = new Set<string>();
  let from = 0;
  for (;;) {
    const open = xml.indexOf("<channel", from);
    if (open === -1) break;
    const openEnd = xml.indexOf(">", open);
    if (openEnd === -1) break;
    // Self-closing <channel .../> has no body — without this guard, `close`
    // below would jump to the NEXT channel's </channel>, swallowing it and
    // mis-attributing its display-names to this id.
    if (xml[openEnd - 1] === "/") {
      from = openEnd + 1;
      continue;
    }
    const close = xml.indexOf("</channel>", openEnd);
    if (close === -1) break;
    from = close + "</channel>".length;

    const tag = xml.slice(open, openEnd + 1);
    const body = xml.slice(openEnd + 1, close);
    const id = attrValue(tag, "id")[0] ?? "";
    if (!id) continue;
    for (const dn of childTexts(body, "display-name")) {
      const key = normalizeChannelName(dn);
      if (!key) continue;
      const existing = nameToId.get(key);
      if (existing === undefined) nameToId.set(key, id);
      else if (existing !== id) ambiguous.add(key);
    }
  }
  for (const key of ambiguous) nameToId.delete(key);
  return nameToId;
}

/** Normalize a channel display-name for fuzzy EPG joining: lowercase, drop
 *  common quality/format tags, strip all non-alphanumerics. Digits are kept
 *  so "ESPN 2" ("espn2") never collapses onto "ESPN" ("espn"). Shared by the
 *  index builder and the resolver — they MUST normalize identically.
 *
 *  The strip-set is intentionally limited to UNAMBIGUOUS quality/codec tags.
 *  Words like "raw"/"feed"/"backup" are NOT stripped: they're substantive
 *  parts of real names ("WWE Raw", "NFL RedZone Feed"), so stripping them
 *  collapsed distinct channels onto the wrong EPG id. */
export function normalizeChannelName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(fhd|uhd|hd|sd|4k|8k|hevc|h\.?265|h\.?264)\b/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Binary-search the on-air program at `nowMs` (lists are start-sorted). */
export function findCurrent(
  programs: EpgProgram[] | undefined,
  nowMs: number,
): EpgProgram | null {
  if (!programs || programs.length === 0) return null;
  let lo = 0;
  let hi = programs.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (programs[mid].startMs <= nowMs) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === -1) return null;
  const p = programs[candidate];
  return p.endMs > nowMs ? p : null;
}

// ── Tiny scanning helpers ──────────────────────────────────────────────

/** All values of `name="…"` inside an opening tag (usually 0 or 1). */
function attrValue(tag: string, name: string): string[] {
  const re = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "g");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out.push(m[1]);
  return out;
}

/** Text of the FIRST `<tag …>…</tag>` child, CDATA + entities decoded. */
function childText(body: string, tag: string): string | null {
  const open = body.indexOf(`<${tag}`);
  if (open === -1) return null;
  const openEnd = body.indexOf(">", open);
  if (openEnd === -1) return null;
  // Self-closing (<icon src="…"/>) has no text.
  if (body[openEnd - 1] === "/") return null;
  const close = body.indexOf(`</${tag}>`, openEnd);
  if (close === -1) return null;
  let text = body.slice(openEnd + 1, close).trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return decodeEntities(text).trim() || null;
}

/** Text of EVERY `<tag …>…</tag>` child (CDATA + entities decoded). Used
 *  for `<display-name>`, which can repeat within one `<channel>` block. */
function childTexts(body: string, tag: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const open = body.indexOf(`<${tag}`, from);
    if (open === -1) break;
    const openEnd = body.indexOf(">", open);
    if (openEnd === -1) break;
    if (body[openEnd - 1] === "/") {
      from = openEnd + 1;
      continue;
    }
    const close = body.indexOf(`</${tag}>`, openEnd);
    if (close === -1) break;
    let text = body.slice(openEnd + 1, close).trim();
    const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
    if (cdata) text = cdata[1];
    const dec = decodeEntities(text).trim();
    if (dec) out.push(dec);
    from = close + `</${tag}>`.length;
  }
  return out;
}

/** Attribute of the first `<tag …>` child (e.g. `<icon src="…"/>`). */
function attrOfChild(body: string, tag: string, attr: string): string | null {
  const open = body.indexOf(`<${tag}`);
  if (open === -1) return null;
  const openEnd = body.indexOf(">", open);
  if (openEnd === -1) return null;
  return attrValue(body.slice(open, openEnd + 1), attr)[0] ?? null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeFromCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeFromCode(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeFromCode(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}
