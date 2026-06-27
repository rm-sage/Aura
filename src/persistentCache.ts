// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// persistentCache — small wrapper around an in-memory Map that hydrates
// from / writes to localStorage with a TTL and soft size cap.
//
// Used wherever a backend round-trip is expensive enough to be worth
// persisting across app restarts (aggregate ratings, AniSkip windows, hero
// logos, etc.). The metaCache module has a hand-rolled equivalent
// because it predates this helper and uses a slightly different
// shape — leave that one alone.
//
// Trade-off: localStorage I/O is synchronous, so writes are debounced
// (250 ms) so a burst of cache.set calls at startup turns into a
// single serialise+write rather than N. The hydration pass at module
// import is the only synchronous read, and it's bounded by the
// soft size cap.
//
// Storage management UI in Settings → Storage exposes a clear button
// per cache via the `storageKey` field — keep that in sync with
// `LOCAL_STORAGE_CATALOGUE` in StorageReport.tsx when adding a new
// cache.
// ---------------------------------------------------------------------------

import { registerStorageReclaimer, isQuotaError } from "./storageQuota";

interface Entry<V> {
  v: V;
  ts: number;
}

interface Options {
  /** localStorage key. Must be unique per cache. */
  storageKey: string;
  /** Time-to-live in milliseconds. Entries past TTL are dropped on
   *  read AND skipped during hydration. */
  ttlMs: number;
  /** Soft cap on entry count. When exceeded, the oldest 25 % (by
   *  insertion `ts`) are evicted before the next persist. Set
   *  generously — eviction is a stop-gap against the 5 MB
   *  localStorage quota, not a normal mode of operation. */
  maxEntries?: number;
  /** Persist debounce in milliseconds. Default 250 ms. */
  debounceMs?: number;
}

export class PersistentCache<V> {
  private readonly storageKey: string;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly debounceMs: number;
  private map = new Map<string, Entry<V>>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: Options) {
    this.storageKey = opts.storageKey;
    this.ttlMs      = opts.ttlMs;
    this.maxEntries = opts.maxEntries ?? 1000;
    this.debounceMs = opts.debounceMs ?? 250;
    this.hydrate();
    // Disposable cache: when the shared localStorage origin hits quota during
    // ANOTHER tenant's important write, yield room (drop our oldest half) rather
    // than letting that write fail silently. The data re-fetches on next use.
    registerStorageReclaimer(() => this.reclaimSpace());
  }

  private hydrate(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Array<[string, Entry<V>]>;
      if (!Array.isArray(parsed)) return;
      const now = Date.now();
      for (const item of parsed) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [k, e] = item;
        if (typeof k !== "string" || !e || typeof e.ts !== "number") continue;
        if (now - e.ts >= this.ttlMs) continue;
        this.map.set(k, e);
      }
    } catch { /* corrupt blob — start fresh */ }
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persistNow(), this.debounceMs);
  }

  private persistNow(): void {
    this.persistTimer = null;
    try {
      if (this.map.size > this.maxEntries) {
        const sorted = [...this.map.entries()].sort((a, b) => b[1].ts - a[1].ts);
        const keep = sorted.slice(0, Math.floor(this.maxEntries * 0.75));
        this.map.clear();
        for (const [k, v] of keep) this.map.set(k, v);
      }
      localStorage.setItem(this.storageKey, JSON.stringify([...this.map.entries()]));
    } catch (e) {
      // On a quota hit, drop our oldest half and rewrite a smaller blob. A
      // serialization failure is just skipped (in-memory cache keeps working).
      if (isQuotaError(e)) this.reclaimSpace();
    }
  }

  /** Drop the oldest half of this cache and rewrite a smaller blob (or remove
   *  the key if even that won't fit), freeing localStorage. Serves as both this
   *  cache's own quota fallback AND the registered reclaimer other tenants run
   *  when an important write hits the shared origin quota. */
  private reclaimSpace(): void {
    const sorted = [...this.map.entries()].sort((a, b) => b[1].ts - a[1].ts);
    const keep = sorted.slice(0, Math.max(0, Math.floor(sorted.length / 2)));
    this.map.clear();
    for (const [k, v] of keep) this.map.set(k, v);
    try {
      localStorage.setItem(this.storageKey, JSON.stringify([...this.map.entries()]));
    } catch {
      try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
    }
  }

  /** Read; returns undefined for misses and expired entries (also
   *  drops the expired entry on the way out). */
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (Date.now() - hit.ts >= this.ttlMs) {
      this.map.delete(key);
      this.schedulePersist();
      return undefined;
    }
    return hit.v;
  }

  set(key: string, value: V): void {
    this.map.set(key, { v: value, ts: Date.now() });
    this.schedulePersist();
  }

  has(key: string): boolean { return this.get(key) !== undefined; }

  clear(): void {
    this.map.clear();
    try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
  }
}
