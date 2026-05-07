// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// updater.ts ────────────────────────────────────────────────────────────────
//
// Lightweight GitHub Releases poller. Aura does NOT ship the
// tauri-plugin-updater (we have no signing keys and don't bundle delta
// patches). Instead, we hit the public GitHub Releases API for the latest
// tag and — if it's strictly newer than the running app's package.json
// version — surface a popup that, on confirmation, opens the release page
// in the user's default browser via `@tauri-apps/plugin-opener`.
//
// All errors are swallowed. The check returns `null` for any non-success
// outcome (network failure, no releases yet, malformed JSON, older or equal
// tag). The check must NEVER throw — the caller fires it from a useEffect
// in App.tsx and unhandled rejections during boot would surface as red
// console noise on every Home visit.
//
// `tag_name` is normalised by stripping a single leading "v" (so `v0.6.7`
// and `0.6.7` compare equally). Pre-release suffixes (e.g. `0.7.0-beta.1`)
// are stripped from the comparison — we compare only the numeric
// MAJOR.MINOR.PATCH triplet. Any non-numeric segment is treated as 0 so a
// pure-rubbish tag never appears "newer".

export interface ReleaseInfo {
  tagName:     string;
  htmlUrl:     string;
  body:        string;
  publishedAt: string;
}

const GITHUB_LATEST_RELEASE_URL =
  "https://api.github.com/repos/rm-sage/Aura/releases/latest";

/** Strip any leading "v"/"V" from a tag and any pre-release / build
 *  metadata suffix (`-beta.1`, `+sha.abcd`). Returns the bare numeric
 *  triplet portion (or as much of it as exists). */
function normalizeVersion(raw: string): string {
  let v = String(raw ?? "").trim();
  if (v.startsWith("v") || v.startsWith("V")) v = v.slice(1);
  // Cut off pre-release / build metadata at the first non-numeric/dot char
  // (semver pre-release starts with `-`, build metadata with `+`).
  const cut = v.search(/[^0-9.]/);
  if (cut !== -1) v = v.slice(0, cut);
  return v;
}

/** Parse a normalised version string into a [major, minor, patch] tuple.
 *  Missing segments default to 0 (so "1" → [1, 0, 0]). NaN becomes 0. */
function parseVersionTriplet(v: string): [number, number, number] {
  const parts = v.split(".").map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** Strict "is `a` newer than `b`?" check on MAJOR.MINOR.PATCH triplets.
 *  Both inputs may carry a leading "v" or pre-release suffix; both are
 *  normalised before comparison. Equal triplets return false. */
export function isNewer(a: string, b: string): boolean {
  const [aM, am, ap] = parseVersionTriplet(normalizeVersion(a));
  const [bM, bm, bp] = parseVersionTriplet(normalizeVersion(b));
  if (aM !== bM) return aM > bM;
  if (am !== bm) return am > bm;
  return ap > bp;
}

/** Hit the GitHub Releases API and resolve to a ReleaseInfo when the
 *  latest published tag is strictly newer than `currentVersion`.
 *
 *  Returns `null` for ANY of:
 *   - Network error / fetch rejection
 *   - Non-200 response (404 fires when the repo has zero releases)
 *   - Missing or malformed `tag_name` field
 *   - Tag is older than or equal to the current version
 *
 *  Never throws. */
export async function checkForUpdate(
  currentVersion: string,
): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
      // GitHub recommends sending an Accept header; without it the API
      // sometimes responds with HTML for clients it can't identify.
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      tag_name?:     unknown;
      html_url?:     unknown;
      body?:         unknown;
      published_at?: unknown;
    };

    const tagName = typeof data.tag_name === "string" ? data.tag_name : "";
    if (!tagName) return null;

    if (!isNewer(tagName, currentVersion)) return null;

    return {
      tagName,
      htmlUrl:     typeof data.html_url     === "string" ? data.html_url     : "",
      body:        typeof data.body         === "string" ? data.body         : "",
      publishedAt: typeof data.published_at === "string" ? data.published_at : "",
    };
  } catch {
    return null;
  }
}
