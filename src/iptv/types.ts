// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// Live TV data model — per the 2026-06-09 live-tv spec (§1). Pure types,
// no Tauri imports; shared by the m3u/xtream/xmltv parsers and the
// (decision-gated, not-yet-built) LiveView UI.
// ---------------------------------------------------------------------------

export interface IptvChannel {
  /** Stable per-playlist id (derived from url+name when tvg-id absent). */
  id: string;
  /** `tvg-id` — the EPG join key (may be empty). */
  tvgId: string;
  name: string;
  /** `tvg-logo` URL, if any. */
  logo: string | null;
  /** `group-title` (or #EXTGRP) bucket; "Other" when absent. */
  group: string;
  /** The playable stream URL. */
  url: string;
  /** `catchup-source` template for timeshift-capable providers. */
  catchupSource: string | null;
  /** EXTINF duration field (usually -1 for live). */
  durationSec: number;
  /** Every parsed EXTINF attribute, verbatim (lowercased keys). */
  attrs: Record<string, string>;
}

export interface IptvPlaylist {
  id: string;
  name: string;
  url: string;
  /** EPG (XMLTV) url — explicit `url-tvg`/`x-tvg-url` header attr or
   *  derived from an Xtream-style playlist URL. */
  epgUrl: string | null;
  channels: IptvChannel[];
  fetchedAt: number;
  /** Distinct group names in first-appearance order. */
  groups: string[];
  /** Forward-proxy URL this playlist's streams should tunnel through
   *  (mpv `http-proxy`), copied from the source. null = direct. */
  proxyUrl?: string | null;
}

/** A configured playlist source (what the user enters; persisted).
 *  NOTE: the Xtream `password` is NOT persisted in settings — it lives in
 *  the OS keyring keyed by playlist id (`iptv_get/set_xtream_password`).
 *  The persisted `xtream` carries only `{ server, username }`; the store
 *  merges the password back in (optional below) before building fetch
 *  URLs. See the live-tv spec Decision D. */
export interface IptvPlaylistSource {
  id: string;
  name: string;
  url: string;
  epgUrl?: string | null;
  kind?: "m3u" | "xtream" | "epg";
  xtream?: { server: string; username: string; password?: string } | null;
  /** Optional forward-proxy (e.g. `http://host:8888`) every stream from
   *  this playlist tunnels through via mpv's `http-proxy` — changes the
   *  source IP without breaking HLS segment resolution. null/absent =
   *  direct. See the Live TV proxy field in PlaylistForm. */
  proxyUrl?: string | null;
}

export interface EpgProgram {
  channelTvgId: string;
  title: string;
  description: string;
  startMs: number;
  endMs: number;
  category: string | null;
  iconUrl: string | null;
}

export interface EpgIndex {
  /** tvg-id → programs sorted by startMs. */
  byChannel: Map<string, EpgProgram[]>;
  /** normalized `<display-name>` → EPG channel id, for the name-based
   *  fallback join when a channel's tvg-id matches no EPG channel id
   *  (e.g. an iptv-org playlist paired with a differently-keyed EPG).
   *  Names that map to >1 distinct id are dropped (ambiguous). */
  nameToId: Map<string, string>;
  fetchedAt: number;
}
