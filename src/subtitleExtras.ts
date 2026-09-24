// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// subtitleExtras - what Aura knows about the PLAYING FILE, for Stremio's
// subtitle request extras (`filename`, `videoHash`, `videoSize`) and for the
// OpenSubtitles v1 search (`moviehash`, `moviebytesize`).
//
// The hash and the size come from ONE `compute_opensubtitles_hash` call (two
// ranged GETs; the size is the Content-Range total, exact to the byte), which
// App runs once per stream url, when either consumer will read it, and hands to
// both. The filename is
// nearly free: the addon's `behaviorHints.filename`, else the url's last path
// segment.
//
// None of it is ever a gate. The addon fan-out fires without extras first and
// again with them once they are known (the effect in App.tsx): when the hash
// lands, or at once with the filename alone for a url that can never be hashed.
// On a host that refuses Range the hash fails, the second request never
// happens, and the first list simply stays.
// ---------------------------------------------------------------------------

import type { ExternalSubtitle, StreamEntry } from "./types";

/** The OpenSubtitles hash of one stream url. `hash` and `bytesize` are null
 *  when the compute failed (a host that refuses Range, a file under 128 KB) or
 *  was never attempted (HLS, a non-https url). Readers must check `url` against
 *  the url they hold: the state outlives a source switch by one round trip. */
export interface StreamHash {
  url: string;
  hash: string | null;
  bytesize: number | null;
}

/** The extras one addon subtitle request carries, as `fetch_external_subtitles`
 *  takes them. All optional: the Rust side omits an absent or unusable value
 *  (`subtitle_extra_segment`), and with none the request is the bare url. */
export interface SubtitleRequestExtras {
  videoHash?: string;
  videoSize?: number | null;
  filename?: string | null;
}

/** Whether hashing `url` can yield the FILE's hash. https only: the hash
 *  command's client is `https_only` (subtitles.rs), so a plain-http url fails
 *  every time, and CLAUDE.md forbids a plaintext fallback. A playlist is not the
 *  file either: hashing an `.m3u8` would hash the manifest text and report its
 *  size, a plausible wrong value, which is worse than none. */
export function isHashableStreamUrl(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  const path = url.split(/[?#]/)[0].toLowerCase();
  return !(path.endsWith(".m3u8") || path.endsWith(".m3u"));
}

/** Extensions a url's last path segment must end in before it is trusted as a
 *  file name. */
const VIDEO_EXTENSIONS = new Set([
  "mkv", "mp4", "m4v", "avi", "mov", "webm", "ts", "m2ts", "mts", "wmv", "flv",
  "mpg", "mpeg", "ogv", "ogm", "3gp", "divx", "vob", "rmvb", "asf",
]);

/** The release filename of the playing file, or null. The addon's
 *  `behaviorHints.filename` wins. Otherwise the url's last path segment,
 *  percent-decoded the way stremio-video derives it (`fetchVideoParams.js`),
 *  with two differences: the query string and fragment are stripped first, and
 *  a segment that does not end in a video extension is ignored. Most debrid
 *  links end in the real release name, but some end in an opaque id
 *  (`/dl/9f2c41`), and that must not go out as a filename. */
export function playingFilename(stream: StreamEntry | null, url: string | null): string | null {
  const hinted = stream?.filename?.trim();
  if (hinted) return hinted;
  if (!url) return null;
  let path: string;
  try { path = new URL(url).pathname; } catch { return null; }
  let name: string;
  try {
    name = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)).trim();
  } catch {
    return null; // a malformed escape: not a name we can vouch for
  }
  // An encoded separator decodes into a path, not a file name.
  if (/[\\/]/.test(name)) return null;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return VIDEO_EXTENSIONS.has(name.slice(dot + 1).toLowerCase()) ? name : null;
}

/** The subtitle list's session identity for one playing stream: the SOURCE, not
 *  its url. A stream-lost re-resolve mints a fresh debrid url for the same file,
 *  and keying on the url emptied the menu and refetched both requests for a file
 *  whose filename and hash had not changed. Built from the fields
 *  `sameStreamSource` (SourceSwitcher.tsx) compares, in the same precedence, so
 *  every real source switch (which that predicate gates) still yields a new key.
 *  The url is the last resort, for a stream that carries neither identity. */
export function streamSourceKey(stream: StreamEntry | null, url: string | null): string {
  if (stream?.info_hash) return `ih:${stream.info_hash}`;
  const name = stream?.filename ?? stream?.title ?? null;
  if (stream?.addon_name && name) return `af:${stream.addon_name}::${name}`;
  return `url:${url ?? ""}`;
}

/** One addon's answer to one subtitle request. `subs` is empty both when the
 *  addon failed and when it had nothing: the Rust fan-out cannot tell them
 *  apart, so neither can the merge. */
export interface AddonSubtitleAnswer {
  addonUrl: string;
  subs: ExternalSubtitle[];
}

/** The list the menu shows, from the answers to request 0 (bare) and request 1
 *  (with extras), either of which may still be in flight (null). Request 1
 *  replaces request 0 PER ADDON, and only where that addon answered it with
 *  something: an addon that comes back empty on request 1 keeps its request 0
 *  entries. Replacing the whole list instead meant one addon hitting a 429 or a
 *  timeout on the second of two requests seconds apart silently lost every
 *  subtitle it had already listed. Extras rank results, they never admit them,
 *  so "some, then none" is a failure far more often than an answer. Addon order
 *  is request 1's once it has landed; urls are deduped in that order, first
 *  wins. */
export function mergeSubtitleAnswers(
  bare: AddonSubtitleAnswer[] | null,
  withExtras: AddonSubtitleAnswer[] | null,
): ExternalSubtitle[] {
  const bareByAddon = new Map((bare ?? []).map((a) => [a.addonUrl, a.subs]));
  const seen = new Set<string>();
  const out: ExternalSubtitle[] = [];
  for (const { addonUrl, subs } of withExtras ?? bare ?? []) {
    const pick = subs.length > 0 ? subs : bareByAddon.get(addonUrl) ?? [];
    for (const s of pick) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      out.push(s);
    }
  }
  return out;
}
