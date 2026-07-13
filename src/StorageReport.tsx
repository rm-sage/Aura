// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { bumpImageEpoch } from "./imageCacheBust";

// ---------------------------------------------------------------------------
// StorageReport — Settings → Storage panel.
//
// Surfaces two groups of state:
//
//   1. Disk-side (Rust `get_storage_report`): MPV log, panic log,
//      their .old rotations. Each entry exposes a clear button that
//      calls `clear_storage_item` to delete the file.
//
//   2. Browser-localStorage entries (enumerated client-side): every
//      Aura-prefixed key, plus its blob size in bytes. Clearing here
//      is a direct localStorage.removeItem call.
//
// All clear actions show a single shared confirm/warning toast first
// — caches that are auto-rebuildable (recent searches, library cache,
// scanner state) are safe; the manual-watched store and per-account
// settings are NOT auto-rebuildable and we flag those explicitly.
// ---------------------------------------------------------------------------

interface StorageEntry {
  id: string;
  label: string;
  description: string;
  path: string;
  bytes: number;
  exists: boolean;
}

interface StorageReportPayload {
  entries: StorageEntry[];
  total_bytes: number;
}

interface LocalStorageEntry {
  key: string;
  label: string;
  description: string;
  bytes: number;
  /** True when clearing this entry would lose user-authored data
   *  (manual-watched marks, queue order, settings — not just a cache
   *  that can be re-fetched). The UI shows a stronger warning before
   *  letting the user clear these. */
  destructive: boolean;
}

/** Static catalogue of localStorage keys Aura writes. Key patterns
 *  with `${scope}` suffixes are matched via prefix scan in the
 *  enumeration loop below. */
const LOCAL_STORAGE_CATALOGUE: { prefix: string; label: string; description: string; destructive: boolean }[] = [
  // NOTE: the legacy "Aura settings (UI)" entry was removed because
  // Settings → Backup & Restore → "Reset all settings" already does the
  // same wipe (and resets the backend AppSettings too, which a
  // localStorage-only clear couldn't touch). Keeping both surfaces was
  // a foot-gun: clearing here left a half-reset state where the
  // backend kept its values. The Reset button is now the single canonical
  // entry point for "wipe my preferences".
  {
    prefix:      "aura:manual-state:",
    label:       "Manual watched + queue",
    description: "Per-account watched, in-progress, and planned marks plus the Queue tab's order. Local-only; clearing wipes every manual mark you've ever set.",
    destructive: true,
  },
  {
    prefix:      "aura:notifications:v1",
    label:       "Notifications history",
    description: "Bell-panel notification list. Clearing wipes the history but doesn't affect future scans.",
    destructive: false,
  },
  {
    prefix:      "aura:notifications:scanner-state",
    label:       "Episode scanner seen-ids",
    description: "Per-series record of episode ids the scanner has already seen. Clearing causes the next scan pass to re-seed from current addon state (a one-shot grace that fires no notifications), then resumes normal new-episode detection. Safe.",
    destructive: false,
  },
  {
    prefix:      "aura:library:cache:",
    label:       "Library warm-start cache",
    description: "Snapshot of your last-fetched Stremio library. Used so the Library tab paints immediately on launch. Refetches from Stremio next time you focus the app. Safe to clear.",
    destructive: false,
  },
  {
    prefix:      "aura:meta-cache:v1",
    label:       "Meta detail cache",
    description: "Persisted MetaDetail responses (cast, runtime, episode lists) shared across Home, Calendar, Continue Watching, and Detail. 24 h TTL. Re-fetches lazily on use. Safe to clear.",
    destructive: false,
  },
  {
    prefix:      "aura:ratings-cache:v1",
    label:       "Ratings cache",
    description: "Aggregated ratings (MDBList: IMDb / Rotten Tomatoes / Metacritic / TMDB / Trakt / Letterboxd, plus MAL + AniList for anime). 7-day TTL; scores rarely change. Re-fetches on next detail open after expiry. Safe to clear.",
    destructive: false,
  },
  {
    prefix:      "aura:aniskip-cache:v1",
    label:       "AniSkip op/ed window cache",
    description: "Per-episode opening, ending, and recap skip windows fetched from the AniSkip API. 30-day TTL; windows for an aired episode are immutable once committed. Safe to clear.",
    destructive: false,
  },
  {
    prefix:      "aura:story-arcs:v7",
    label:       "Story arc cache",
    description: "Per-series story arcs (TMDB episode groups, already mapped onto your addon's episode ids). 24-hour TTL because an ongoing show gains an episode every week. Re-fetches on the next detail open. Safe to clear.",
    destructive: false,
  },
  {
    prefix:      "aura:arc-mode:v1",
    label:       "Seasons / Arcs choice",
    description: "Remembers, per series, whether you last browsed it by season or by story arc, and which arc grouping you picked. Clearing just sends every show back to the Seasons default. Safe to clear.",
    destructive: false,
  },
];

function formatBytes(n: number): string {
  if (n === 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Walk localStorage and bucket each Aura-prefixed key against the
 *  catalogue above. Keys matching the same prefix (e.g. multiple
 *  manual-state scopes) collapse into one entry whose bytes is the
 *  sum across all matches. */
function enumerateLocalStorage(): LocalStorageEntry[] {
  const out: LocalStorageEntry[] = [];
  const acc = new Map<string, { entry: typeof LOCAL_STORAGE_CATALOGUE[number]; bytes: number; matchedKey: string }>();
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith("aura:")) continue;
    const match = LOCAL_STORAGE_CATALOGUE.find((c) =>
      key === c.prefix || key.startsWith(c.prefix),
    );
    if (!match) continue;
    const value = localStorage.getItem(key) ?? "";
    const bytes = new Blob([value]).size;
    const existing = acc.get(match.prefix);
    if (existing) {
      existing.bytes += bytes;
    } else {
      acc.set(match.prefix, { entry: match, bytes, matchedKey: key });
    }
  }
  for (const c of LOCAL_STORAGE_CATALOGUE) {
    const hit = acc.get(c.prefix);
    out.push({
      key:         hit?.matchedKey ?? c.prefix,
      label:       c.label,
      description: c.description,
      bytes:       hit?.bytes ?? 0,
      destructive: c.destructive,
    });
  }
  return out;
}

function clearLocalStoragePrefix(prefix: string): void {
  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (key === prefix || key.startsWith(prefix)) toRemove.push(key);
  }
  for (const k of toRemove) localStorage.removeItem(k);
}

interface PendingClear {
  kind: "disk" | "local" | "images";
  /** disk: storage entry id. local: localStorage prefix. images: unused. */
  target: string;
  label: string;
  destructive: boolean;
}

export default function StorageReport() {
  const [diskReport, setDiskReport]     = useState<StorageReportPayload | null>(null);
  const [localEntries, setLocalEntries] = useState<LocalStorageEntry[]>([]);
  const [busy, setBusy]                 = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState<PendingClear | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const r = await invoke<StorageReportPayload>("get_storage_report");
      setDiskReport(r);
      setLocalEntries(enumerateLocalStorage());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const performClear = useCallback(async (pending: PendingClear) => {
    setPendingClear(null);
    if (pending.kind === "images") {
      // Bump the image epoch → every ImageLoader refetches its src with a fresh
      // cache key, pulling posters/backdrops/logos from source at the current
      // size. Nothing on disk is deleted; the webview evicts the old entries.
      bumpImageEpoch();
      return;
    }
    if (pending.kind === "disk") {
      setBusy(true);
      try {
        await invoke("clear_storage_item", { id: pending.target });
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    } else {
      clearLocalStoragePrefix(pending.target);
      setLocalEntries(enumerateLocalStorage());
    }
  }, [refresh]);

  return (
    <div className="space-y-6">
      <div className="text-white/55 text-xs leading-relaxed">
        Aura keeps a small set of files on disk for crash diagnostics and a few
        localStorage entries for fast UI startup. Most are safe to clear and
        will rebuild on use; entries flagged "user data" wipe content you've
        authored (manual marks, queue order, settings) and aren't recoverable.
      </div>

      {error && (
        <div className="text-rose-300 text-xs px-3 py-2 rounded-md bg-rose-500/10 border border-rose-400/20">
          {error}
        </div>
      )}

      {/* ── Disk files (Rust) ── */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="text-white/85 text-sm font-semibold tracking-wide">Disk files</p>
          <p className="text-white/45 text-xs font-mono tabular-nums">
            {diskReport ? `Total: ${formatBytes(diskReport.total_bytes)}` : ""}
          </p>
        </div>
        <div className="divide-y divide-white/8 rounded-md border border-white/10 overflow-hidden">
          {(diskReport?.entries ?? []).map((e) => (
            <div key={e.id} className="flex items-start gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-white/90 text-[13px] font-medium leading-tight">{e.label}</p>
                <p className="text-white/40 text-[11px] mt-0.5 leading-snug">{e.description}</p>
                <p className="text-white/30 text-[10px] mt-1 font-mono break-all">{e.path}</p>
              </div>
              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <span className={`text-[11px] font-mono tabular-nums ${e.exists ? "text-white/85" : "text-white/35"}`}>
                  {formatBytes(e.bytes)}
                </span>
                {e.exists && (
                  <ClearButton
                    busy={busy}
                    onClick={() => setPendingClear({
                      kind: "disk",
                      target: e.id,
                      label: e.label,
                      destructive: false,
                    })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── localStorage entries (browser) ── */}
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <p className="text-white/85 text-sm font-semibold tracking-wide">Browser storage</p>
          <button
            type="button"
            onClick={refresh}
            disabled={busy}
            className="text-[11px] px-2 py-1 rounded-md text-white/55 hover:text-white/85 hover:bg-white/8 transition-colors disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
        <div className="divide-y divide-white/8 rounded-md border border-white/10 overflow-hidden">
          {localEntries.map((e) => (
            <div key={e.key} className="flex items-start gap-3 px-3 py-2.5">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-white/90 text-[13px] font-medium leading-tight">{e.label}</p>
                  {e.destructive && (
                    <span className="text-[9px] uppercase tracking-[0.18em] text-amber-300/80 font-mono">user data</span>
                  )}
                </div>
                <p className="text-white/40 text-[11px] mt-0.5 leading-snug">{e.description}</p>
              </div>
              <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                <span className={`text-[11px] font-mono tabular-nums ${e.bytes > 0 ? "text-white/85" : "text-white/35"}`}>
                  {formatBytes(e.bytes)}
                </span>
                {e.bytes > 0 && (
                  <ClearButton
                    busy={false}
                    destructive={e.destructive}
                    onClick={() => setPendingClear({
                      kind: "local",
                      target: e.key,
                      label: e.label,
                      destructive: e.destructive,
                    })}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Cached images (webview HTTP cache) ── */}
      <div className="space-y-2">
        <p className="text-white/85 text-sm font-semibold tracking-wide">Cached images</p>
        <div className="divide-y divide-white/8 rounded-md border border-white/10 overflow-hidden">
          <div className="flex items-start gap-3 px-3 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-white/90 text-[13px] font-medium leading-tight">Cached posters &amp; images</p>
              <p className="text-white/40 text-[11px] mt-0.5 leading-snug">
                Posters, backdrops, and logos are cached on disk by the webview, keyed by URL — so if an
                image's source or size changed on the server, the old one keeps showing for the same URL.
                Reloading re-downloads every image from source at the current size. Uses bandwidth; nothing
                is deleted.
              </p>
            </div>
            <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
              <button
                type="button"
                onClick={() => setPendingClear({ kind: "images", target: "", label: "cached posters & images", destructive: false })}
                className="text-[10px] px-2 py-1 rounded-md transition-colors
                           text-white/60 hover:text-white hover:bg-white/8 border border-white/10"
              >
                Reload
              </button>
            </div>
          </div>
        </div>
      </div>

      {pendingClear && (
        <ClearConfirmModal
          pending={pendingClear}
          onCancel={() => setPendingClear(null)}
          onConfirm={() => performClear(pendingClear)}
        />
      )}
    </div>
  );
}

/** Single-click button that arms the parent's confirm popup. The
 *  popup is the actual confirmation surface, so this just looks like
 *  a regular destructive action button. */
function ClearButton({
  busy, destructive, onClick,
}: {
  busy: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={`text-[10px] px-2 py-1 rounded-md transition-colors
                  ${destructive
                    ? "text-rose-200/80 hover:text-rose-200 hover:bg-rose-500/15 border border-rose-300/20"
                    : "text-white/60 hover:text-white hover:bg-white/8 border border-white/10"}`}
    >
      Clear
    </button>
  );
}

/** Centred modal popup confirming a Clear action. Mirrors the
 *  confirm-modal pattern in SettingsView so destructive surfaces feel
 *  consistent across the page. Esc + click-outside cancel. */
function ClearConfirmModal({
  pending, onCancel, onConfirm,
}: {
  pending: PendingClear;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const isImages = pending.kind === "images";
  const accent = pending.destructive
    ? { ring: "ring-rose-400/40", btn: "border-rose-300/60 bg-rose-500/30 text-rose-50 hover:bg-rose-500/45", icon: "text-rose-300" }
    : { ring: "ring-amber-400/40", btn: "border-amber-300/60 bg-amber-500/30 text-amber-50 hover:bg-amber-500/45", icon: "text-amber-300" };

  const node = (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`max-w-[400px] w-full rounded-2xl bg-zinc-900/95 border border-white/15 ${accent.ring}
                    shadow-glass-edge ring-1 p-6 space-y-4`}
      >
        <div className="flex items-start gap-3">
          <span className={`flex-shrink-0 mt-0.5 text-2xl leading-none ${accent.icon}`} aria-hidden>
            {pending.destructive ? "⚠" : "ⓘ"}
          </span>
          <div className="flex-1 min-w-0 space-y-1.5">
            <h3 className="text-white font-semibold text-[15px] leading-tight">
              {pending.destructive ? "Wipe user data?" : isImages ? "Reload posters?" : "Clear cache?"}
            </h3>
            <p className="text-white/70 text-[13px] leading-relaxed">
              {pending.destructive
                ? `This will permanently erase your ${pending.label.toLowerCase()}. The data is local-only and not recoverable from cloud sync.`
                : isImages
                  ? "Aura will re-download every poster, backdrop, and logo from source at the current size. Uses bandwidth; nothing is deleted. Use this after a poster source or size change."
                  : `Clear ${pending.label.toLowerCase()}? Aura will rebuild it on next use; this only frees storage.`
              }
            </p>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/80 text-[12px] font-medium hover:bg-white/10 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className={`px-4 py-1.5 rounded-lg border text-[12px] font-medium transition-colors ${accent.btn}`}
          >
            {pending.destructive ? "Yes, wipe" : isImages ? "Reload" : "Clear"}
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}
