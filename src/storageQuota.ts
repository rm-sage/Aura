// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// storageQuota — a centralized localStorage.setItem with quota recovery.
//
// Aura's caches all share ONE localStorage origin (metaCache, persistentCache,
// history, manual-watched marks, IPTV playlists/favorites, sync etags, the
// settings-updated-at stamp, ...). Historically each swallowed a
// QuotaExceededError in an empty catch, so once the shared origin filled, the
// FIRST writer past the ceiling silently stopped persisting forever — no
// eviction across tenants, no signal. A failed etag write silently re-pulled
// every sync namespace each launch; a failed watched-mark silently reverted.
//
// safeSetItem fixes the whole class: on a quota error it runs the registered
// "reclaimers" (the disposable caches evict their oldest entries to free space)
// and retries ONCE, so an important write (settings, history, a watched mark, a
// playlist) wins room from a throwaway cache instead of failing silently. It
// returns whether the value is now stored so a user-ACTION caller can surface a
// contextual toast; background writers just get the eviction + a one-shot warn.
// ---------------------------------------------------------------------------

/** A space-reclaimer: frees recoverable localStorage (a pure cache dropping its
 *  oldest entries). Registered by the disposable caches; run on a quota hit. */
type Reclaimer = () => void;
const reclaimers: Reclaimer[] = [];

/** Register a reclaimer that frees localStorage when a write hits the quota.
 *  Pure/disposable caches (metaCache, persistentCache) register here so an
 *  important write can evict THEM rather than fail. Best-effort + idempotent. */
export function registerStorageReclaimer(fn: Reclaimer): void {
  reclaimers.push(fn);
}

/** True for a localStorage quota-exceeded error across Chromium / WebView2 /
 *  Firefox shapes (name OR legacy numeric code). */
export function isQuotaError(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false;
  if (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED") return true;
  // Legacy numeric codes (pre-name browsers). `.code` is deprecated in the lib
  // types but still set; read it off a cast to avoid the deprecation lint.
  const code = (e as { code?: number }).code;
  return code === 22 || code === 1014;
}

let warnedThisSession = false;
function warnOnce(message: string, detail?: unknown): void {
  if (warnedThisSession) return;
  warnedThisSession = true;
  // console.warn is mirrored into the in-app DevConsole, so this is the
  // baseline "not totally silent" signal even for background writers.
  try {
    if (detail !== undefined) console.warn(`[storage] ${message}`, detail);
    else console.warn(`[storage] ${message}`);
  } catch { /* ignore */ }
}

/** localStorage.setItem with quota recovery. NEVER throws. Returns true once the
 *  value is persisted, false if it still could not be written (caller may show a
 *  contextual toast). On a quota hit it evicts from the registered disposable
 *  caches and retries once; on storage-unavailable (private mode / hardened
 *  WebView2 profile) it can't recover and returns false. */
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (!isQuotaError(e)) {
      warnOnce("localStorage write failed (storage disabled / unavailable); data will not persist this session", e);
      return false;
    }
    // Quota hit — let the disposable caches free space, then retry once.
    for (const r of reclaimers) {
      try { r(); } catch { /* one bad reclaimer must not block the others */ }
    }
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      warnOnce("localStorage is full and could not be reclaimed; some data may not persist (clear space in Settings > Storage)");
      return false;
    }
  }
}
