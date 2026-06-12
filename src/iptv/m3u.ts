// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// M3U / M3U8 playlist parser (Live TV spec §1). Line-based #EXTINF
// parsing with quoted-attribute tokenization, #EXTGRP support, and
// decorative-row filtering. Pure functions — no Tauri imports.
//
// Anatomy of an entry:
//   #EXTINF:-1 tvg-id="bbc1.uk" tvg-logo="http://…/l.png" group-title="UK",BBC One
//   http://provider/live/u/p/123.m3u8
// ---------------------------------------------------------------------------

import type { IptvChannel } from "./types";

/** Parsed #EXTINF line: duration, attribute map, display title. */
export function parseExtinf(line: string): {
  durationSec: number;
  attrs: Record<string, string>;
  title: string;
} {
  // Strip the directive; the rest is `<duration> <attrs…>,<title>`.
  const body = line.slice("#EXTINF:".length);

  // Duration = leading signed number (often -1 for live).
  const durMatch = body.match(/^\s*(-?\d+(?:\.\d+)?)/);
  const durationSec = durMatch ? Number(durMatch[1]) : -1;

  // Attributes: key="value" pairs (keys may contain letters/digits/-_.).
  // Values may contain commas, so the title split below must ignore
  // commas inside quotes.
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z0-9_.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(body)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }

  // Display title = everything after the LAST comma that sits outside
  // quotes. (Titles themselves may contain commas only when the
  // provider quotes nothing after them — last-unquoted-comma is the
  // de-facto convention every IPTV player uses.)
  const title = body.slice(lastUnquotedComma(body) + 1).trim();
  return { durationSec, attrs, title };
}

/** Index of the last comma outside double quotes, or -1. */
function lastUnquotedComma(s: string): number {
  let inQuotes = false;
  let last = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) last = i;
  }
  return last;
}

/** Separator / ASCII-art rows some providers inject as fake channels
 *  ("──── SPORTS ────", "*** UK ***", "═══ NEWS ═══"). */
export function isDecorativeRow(name: string): boolean {
  const t = name.trim();
  if (!t) return true;
  // Strip every letter/digit; if nothing but decoration remains AND
  // decoration dominates the row, treat it as a separator.
  const alnum = t.replace(/[^\p{L}\p{N}]/gu, "");
  if (alnum.length === 0) return true;
  const decoCount = (t.match(/[─━═*#~\-=•◆◇►▼▲|]/g) ?? []).length;
  return decoCount >= 6 && decoCount > alnum.length;
}

/** Parse a whole M3U document into channels (+ the header's EPG hint). */
export function parseM3u(text: string, playlistUrl: string): {
  channels: IptvChannel[];
  epgUrl: string | null;
} {
  const lines = text.split(/\r?\n/);
  const channels: IptvChannel[] = [];
  let epgUrl: string | null = null;

  let pending: { durationSec: number; attrs: Record<string, string>; title: string } | null = null;
  let pendingGroup: string | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTM3U")) {
      // Header may carry `url-tvg="…"` / `x-tvg-url="…"` EPG pointers.
      const tvg = line.match(/(?:url-tvg|x-tvg-url)\s*=\s*"([^"]+)"/i);
      if (tvg) epgUrl = tvg[1].split(",")[0].trim() || null;
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pending = parseExtinf(line);
      continue;
    }
    if (line.startsWith("#EXTGRP:")) {
      pendingGroup = line.slice("#EXTGRP:".length).trim() || null;
      continue;
    }
    // Player/option directives we deliberately ignore.
    if (line.startsWith("#EXTVLCOPT") || line.startsWith("#KODIPROP")) continue;
    if (line.startsWith("#")) continue;

    // A non-comment line is the URL for the pending EXTINF (or a bare
    // URL with no metadata — still playable).
    const url = line;
    const meta = pending ?? { durationSec: -1, attrs: {}, title: "" };
    pending = null;

    const name = meta.title || meta.attrs["tvg-name"] || url;
    if (isDecorativeRow(name)) {
      pendingGroup = null;
      continue;
    }
    const group =
      meta.attrs["group-title"] || pendingGroup || "Other";
    pendingGroup = null;

    const tvgId = meta.attrs["tvg-id"] ?? "";
    channels.push({
      id: tvgId || `${hashString(url)}:${hashString(name)}`,
      tvgId,
      name,
      logo: meta.attrs["tvg-logo"] || null,
      group,
      url,
      catchupSource: meta.attrs["catchup-source"] || null,
      durationSec: meta.durationSec,
      attrs: meta.attrs,
    });
  }

  if (!epgUrl) epgUrl = deriveEpgUrls(playlistUrl)[0] ?? null;
  return { channels, epgUrl };
}

/** Bucket channels by group, preserving first-appearance order. */
export function groupChannels(channels: IptvChannel[]): Map<string, IptvChannel[]> {
  const out = new Map<string, IptvChannel[]>();
  for (const ch of channels) {
    const list = out.get(ch.group);
    if (list) list.push(ch);
    else out.set(ch.group, [ch]);
  }
  return out;
}

/** Infer XMLTV EPG URLs from an Xtream-style playlist URL
 *  (`…/get.php?username=u&password=p…` → `…/xmltv.php?username=u&password=p`). */
export function deriveEpgUrls(playlistUrl: string): string[] {
  try {
    const u = new URL(playlistUrl);
    const path = u.pathname.toLowerCase();
    if (!path.endsWith("/get.php") && !path.endsWith("/player_api.php")) return [];
    const username = u.searchParams.get("username");
    const password = u.searchParams.get("password");
    if (!username || !password) return [];
    const base = `${u.protocol}//${u.host}`;
    return [
      `${base}/xmltv.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
      `${base}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=epg`,
    ];
  } catch {
    return [];
  }
}

/** Tiny non-crypto string hash for synthetic channel ids. */
function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
