// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Xtream Codes support (Live TV spec §1) — credential extraction, API
// URL building, and the live-channel mapping. The network hop goes
// through the `iptv_fetch_text` Rust command (see ./fetch) so the
// IPTV-client User-Agent and CORS-free fetch happen backend-side.
//
// ROBUSTNESS: the primary path is the player API (`player_api.php`), but
// many panels disable it while still serving the M3U export (`get.php?
// type=m3u_plus`). So `fetchXtreamLiveChannels` falls back to parsing that
// export when the player API errors or returns zero streams — otherwise a
// perfectly good account reads as "nothing loads". Each attempt logs a
// concise (credential-redacted) diagnostic to the DevConsole.
// ---------------------------------------------------------------------------

import type { IptvChannel } from "./types";
import { iptvFetchText } from "./fetch";
import { parseM3u } from "./m3u";

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

/** Fetch live channels for an Xtream account. Tries the player API first
 *  (categories + streams, mapped into Aura's channel shape); on any failure
 *  OR an empty result, falls back to the M3U export. Throws only when BOTH
 *  paths yield nothing, with a message that points at the likely cause. */
export async function fetchXtreamLiveChannels(
  creds: XtreamCreds,
): Promise<IptvChannel[]> {
  // 1) Player API.
  try {
    const channels = await fetchViaPlayerApi(creds);
    if (channels.length > 0) {
      console.info(`[iptv] xtream player_api → ${channels.length} channels (${redactBase(creds.base)})`);
      return channels;
    }
    console.warn(`[iptv] xtream player_api returned 0 streams — trying M3U export (${redactBase(creds.base)})`);
  } catch (e) {
    console.warn(`[iptv] xtream player_api failed (${errStr(e)}) — trying M3U export (${redactBase(creds.base)})`);
  }

  // 2) M3U export fallback (get.php?type=m3u_plus). Panels that disable the
  //    player API almost always still serve this.
  try {
    const { playlist } = buildXtreamUrls(creds);
    const body = await iptvFetchText(playlist);
    if (body.includes("#EXTINF")) {
      const { channels } = parseM3u(body, playlist);
      if (channels.length > 0) {
        console.info(`[iptv] xtream m3u export → ${channels.length} channels (${redactBase(creds.base)})`);
        return channels;
      }
    } else {
      console.warn(`[iptv] xtream m3u export had no #EXTINF entries (${redactBase(creds.base)})`);
    }
  } catch (e) {
    console.warn(`[iptv] xtream m3u export failed (${errStr(e)}) (${redactBase(creds.base)})`);
  }

  throw new Error(
    "Couldn't load any channels from this Xtream login. The provider's player API and M3U export both returned nothing — usually wrong server/port, expired credentials, or a disabled account.",
  );
}

/** Player-API path: categories + live streams in parallel, mapped to
 *  Aura's channel shape. Distinguishes the auth-failure object response
 *  ({user_info:{auth:0}}) from a genuine empty list. */
async function fetchViaPlayerApi(creds: XtreamCreds): Promise<IptvChannel[]> {
  const q = `username=${encodeURIComponent(creds.username)}&password=${encodeURIComponent(creds.password)}`;
  const api = `${creds.base}/player_api.php?${q}`;
  const [catsText, streamsText] = await Promise.all([
    iptvFetchText(`${api}&action=get_live_categories`),
    iptvFetchText(`${api}&action=get_live_streams`),
  ]);

  let cats: XtreamCategory[] = [];
  let streams: unknown;
  try { cats = JSON.parse(catsText) ?? []; } catch { /* tolerated — uncategorised */ }
  try {
    streams = JSON.parse(streamsText);
  } catch (e) {
    throw new Error(
      `player_api returned non-JSON (${errStr(e)}; first bytes: ${snippet(streamsText)})`,
    );
  }

  // Auth failure / error surface as an object, not a list.
  if (!Array.isArray(streams)) {
    const auth = (streams as { user_info?: { auth?: number } })?.user_info?.auth;
    if (auth === 0) throw new Error("provider rejected the credentials (auth=0)");
    throw new Error(`player_api get_live_streams was not a list (${snippet(streamsText)})`);
  }

  const catName = new Map<string, string>();
  if (Array.isArray(cats)) {
    for (const c of cats) {
      if (c && c.category_id != null) catName.set(String(c.category_id), c.category_name ?? "Other");
    }
  }

  return (streams as XtreamStream[])
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

/** `proto//host` with no credentials — safe to log. */
function redactBase(base: string): string {
  try {
    return new URL(base).host;
  } catch {
    return "provider";
  }
}

function errStr(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** First ~120 chars of a body, single-lined, for diagnostics. Never used
 *  on URLs (which carry credentials) — only on response bodies. */
function snippet(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 120);
}
