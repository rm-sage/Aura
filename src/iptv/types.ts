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
  fetchedAt: number;
}
