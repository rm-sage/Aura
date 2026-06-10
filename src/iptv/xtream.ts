// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Xtream Codes support (Live TV spec §1) — credential extraction, API
// URL building, and the live-channel mapping. The network hop goes
// through the `iptv_fetch_text` Rust command (see ./fetch) so the
// IPTV-client User-Agent and CORS-free fetch happen backend-side.
// ---------------------------------------------------------------------------

import type { IptvChannel } from "./types";
import { iptvFetchText } from "./fetch";

export interface XtreamCreds {
  base: string;
  username: string;
  password: string;
}

/** Extract `{base, username, password}` from any Xtream-shaped URL
 *  (`get.php` / `player_api.php` / `live/u/p/...`). Null when the URL
 *  doesn't look like an Xtream endpoint. */
export function parseXtreamUrl(raw: string): XtreamCreds | null {
  try {
    const u = new URL(raw);
    const base = `${u.protocol}//${u.host}`;
    const qUser = u.searchParams.get("username");
    const qPass = u.searchParams.get("password");
    if (qUser && qPass) return { base, username: qUser, password: qPass };
    // Path-style: /live/<user>/<pass>/<id>.<ext>
    const segs = u.pathname.split("/").filter(Boolean);
    if (segs.length >= 3 && ["live", "movie", "series"].includes(segs[0])) {
      return { base, username: segs[1], password: segs[2] };
    }
    return null;
  } catch {
    return null;
  }
}

/** The playlist + EPG URLs an Xtream credential set implies. */
export function buildXtreamUrls(creds: XtreamCreds): {
  playlist: string;
  epg: string;
} {
  const q = `username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  return {
    playlist: `${creds.base}/get.php?${q}&type=m3u_plus&output=ts`,
    epg: `${creds.base}/xmltv.php?${q}`,
  };
}

interface XtreamCategory {
  category_id: string;
  category_name: string;
}

interface XtreamStream {
  stream_id: number | string;
  name: string;
  stream_icon?: string | null;
  epg_channel_id?: string | null;
  category_id?: string | null;
  tv_archive?: number;
}

/** Fetch live channels via the Xtream player API (categories + streams
 *  in parallel) and map them into Aura's channel shape. */
export async function fetchXtreamLiveChannels(
  creds: XtreamCreds,
): Promise<IptvChannel[]> {
  const q = `username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  const api = `${creds.base}/player_api.php?${q}`;
  const [catsText, streamsText] = await Promise.all([
    iptvFetchText(`${api}&action=get_live_categories`),
    iptvFetchText(`${api}&action=get_live_streams`),
  ]);

  let cats: XtreamCategory[] = [];
  let streams: XtreamStream[] = [];
  try { cats = JSON.parse(catsText) ?? []; } catch { /* tolerated — uncategorised */ }
  try { streams = JSON.parse(streamsText) ?? []; } catch (e) {
    throw new Error(`Xtream get_live_streams returned unparseable JSON: ${e}`);
  }
  if (!Array.isArray(streams)) {
    throw new Error("Xtream get_live_streams did not return a list (bad credentials?)");
  }

  const catName = new Map<string, string>();
  if (Array.isArray(cats)) {
    for (const c of cats) {
      if (c && c.category_id != null) catName.set(String(c.category_id), c.category_name ?? "Other");
    }
  }

  return streams
    .filter((s) => s && s.stream_id != null)
    .map((s) => {
      const tvgId = s.epg_channel_id ?? "";
      const url = `${creds.base}/live/${encodeURIComponent(creds.username)}/${encodeURIComponent(creds.password)}/${s.stream_id}.m3u8`;
      return {
        id: `xt:${s.stream_id}`,
        tvgId,
        name: s.name ?? `Channel ${s.stream_id}`,
        logo: s.stream_icon || null,
        group: (s.category_id != null && catName.get(String(s.category_id))) || "Other",
        url,
        catchupSource: null,
        durationSec: -1,
        attrs: {},
      } satisfies IptvChannel;
    });
}
