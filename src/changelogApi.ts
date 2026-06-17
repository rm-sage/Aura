// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// changelog.ts ───────────────────────────────────────────────────────────────
//
// Fetches Aura's release history from the GitHub Releases API for the in-app
// changelog + the update popup's "View more". GitHub sends CORS headers and
// the app CSP allows https connect-src, so a direct webview fetch works (no
// Rust hop). Pages are cached for the session so re-opening the changelog or
// paging back is instant and stays well under the 60 req/hour unauthenticated
// limit.

const REPO = "rm-sage/Aura";

/** Versions loaded per "View more" click. 10 is convenient and keeps each
 *  GitHub API page small; shared by the changelog and the update popup. */
export const RELEASES_PAGE_SIZE = 10;

export interface ReleaseNote {
  /** Bare version, e.g. "1.0.5". */
  version: string;
  /** Tag, e.g. "v1.0.5". */
  tag: string;
  /** ISO publish date (empty when unknown). */
  date: string;
  /** Raw markdown-ish notes body. */
  notes: string;
}

export interface ReleasePage {
  /** Real releases on this page (prereleases / drafts removed). */
  items: ReleaseNote[];
  /** True when GitHub returned a FULL raw page, so more pages may exist. Based
   *  on the RAW count (not items.length), so a page that contained a
   *  filtered-out prerelease doesn't falsely read as the last page. */
  full: boolean;
}

/** Cache keyed by 1-based page index. */
const _pageCache = new Map<number, ReleasePage>();

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  prerelease: boolean;
  draft: boolean;
}

/** Fetch one page of releases (newest first), filtering out prereleases (the
 *  `runtime-deps` asset host) and drafts. Throws on network / HTTP / rate-limit
 *  failure so the caller can show a retry. Cached per page for the session. */
export async function fetchReleasePage(page: number): Promise<ReleasePage> {
  const cached = _pageCache.get(page);
  if (cached) return cached;

  const url = `https://api.github.com/repos/${REPO}/releases?per_page=${RELEASES_PAGE_SIZE}&page=${page}`;
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(
      res.status === 403
        ? "GitHub rate limit reached — try again in a little while."
        : `GitHub releases request failed (HTTP ${res.status}).`,
    );
  }
  const raw = (await res.json()) as GitHubRelease[];
  const arr = Array.isArray(raw) ? raw : [];
  const items: ReleaseNote[] = arr
    .filter((r) => !r.prerelease && !r.draft)
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ""),
      tag: r.tag_name,
      date: r.published_at ?? "",
      notes: r.body ?? "",
    }));
  const result: ReleasePage = { items, full: arr.length >= RELEASES_PAGE_SIZE };
  _pageCache.set(page, result);
  return result;
}

/** Format an ISO date as a short, locale-aware "Jun 17, 2026". Empty on no date. */
export function formatReleaseDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
