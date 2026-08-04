// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SubtitleEntry } from "./types";

// ---------------------------------------------------------------------------
// SubtitlePicker — glass overlay floating over the player
//
// 1. Pre-fills the search query with the active title (if any)
// 2. Calls search_subtitles → list
// 3. On Download: calls download_subtitle (returns local path), then
//    add_subtitle_to_mpv to inject via sub-add
// 4. Successful injection auto-closes the panel after 700 ms
//
// Best-effort throughout — every IPC call is wrapped in try/catch so a flaky
// network never crashes the player.
// ---------------------------------------------------------------------------

interface Props {
  open: boolean;
  /** Initial query — usually the active video title. */
  initialQuery?: string;
  initialYear?: number;
  initialImdbId?: string;
  /** Resolved stream URL of the currently-playing file. When present
   *  (and HTTP/HTTPS), the picker computes an OpenSubtitles MovieHash
   *  via two Range GETs before searching, then includes it in the
   *  search payload. Hash-matched entries are frame-accurate to the
   *  exact release and bubble to the top with a "Hash match" badge.
   *  Hash compute failures (Range refused, file too small, non-HTTP
   *  URL) silently fall back to query / IMDB / year matching. */
  streamUrl?: string | null;
  onClose: () => void;
}

const LANG_PRESETS = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "it", label: "Italian" },
];

const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

interface MovieHashCache {
  url: string;
  hash: string | null;     // null when compute failed for this URL
  bytesize: number | null;
}

export default function SubtitlePicker({
  open, initialQuery, initialYear, initialImdbId, streamUrl, onClose,
}: Props) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [language, setLanguage] = useState("en");
  const [results, setResults] = useState<SubtitleEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  // Per-URL hash cache. Computing the hash requires two Range GETs
  // against the stream URL (first 64 KB + last 64 KB); we don't want
  // to refire those on every keystroke / language change. Cached by
  // URL so an episode change naturally invalidates.
  const [hashCache, setHashCache] = useState<MovieHashCache | null>(null);

  // Prefill query when activeTarget changes
  useEffect(() => {
    if (open) setQuery(initialQuery ?? "");
  }, [open, initialQuery]);

  // Compute the OpenSubtitles MovieHash when the picker opens against
  // a fresh stream. Best-effort: Range-refused / non-HTTP / small-file
  // URLs all surface as cache.hash=null, which the search path then
  // skips silently.
  useEffect(() => {
    if (!open) return;
    if (!streamUrl) return;
    if (hashCache?.url === streamUrl) return;
    // Bail early on non-http URLs so we don't churn a network round
    // trip for magnets / file:// (the latter would actually work for
    // local files Task #19's local-file work would route through MPV's
    // path, but that's out of scope here).
    if (!streamUrl.startsWith("http://") && !streamUrl.startsWith("https://")) {
      setHashCache({ url: streamUrl, hash: null, bytesize: null });
      return;
    }
    let cancelled = false;
    invoke<{ hash: string; bytesize: number }>("compute_opensubtitles_hash", { url: streamUrl })
      .then((res) => {
        if (cancelled) return;
        setHashCache({ url: streamUrl, hash: res.hash, bytesize: res.bytesize });
      })
      .catch((e) => {
        // Range refused / file too small / non-200 → silently disable
        // hash matching for this URL. The search still works via
        // query / IMDB / year.
        console.info("[subtitles] OS hash compute skipped:", String(e));
        if (cancelled) return;
        setHashCache({ url: streamUrl, hash: null, bytesize: null });
      });
    return () => { cancelled = true; };
  }, [open, streamUrl, hashCache]);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResults([]);
    try {
      const r = await invoke<SubtitleEntry[]>("search_subtitles", {
        query: query.trim() || null,
        year: initialYear ?? null,
        imdbId: initialImdbId ?? null,
        languages: language,
        moviehash: hashCache?.url === streamUrl ? hashCache?.hash : null,
        moviebytesize: hashCache?.url === streamUrl ? hashCache?.bytesize : null,
      });
      setResults(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [query, language, initialYear, initialImdbId, hashCache, streamUrl]);

  // Auto-search on open or language change
  useEffect(() => {
    if (!open) return;
    if (!query.trim() && !initialImdbId) return; // wait for query
    const t = setTimeout(() => { search(); }, 250);
    return () => clearTimeout(t);
  }, [open, query, language, initialImdbId, search]);

  const handleDownload = async (entry: SubtitleEntry) => {
    setDownloading(entry.file_id);
    setError(null);
    setSuccess(null);
    try {
      const path = await invoke<string>("download_subtitle", { fileId: entry.file_id });
      await invoke("add_subtitle_to_mpv", { path });
      setSuccess(entry.release || "Subtitle loaded");
      // Auto-close briefly after a successful injection
      setTimeout(() => { onClose(); setSuccess(null); }, 700);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading(null);
    }
  };

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-40 flex items-end justify-center p-6 pointer-events-none">
      <div
        className="aura-sheet-in glass-panel-elevated rounded-2xl shadow-glass-edge w-full max-w-[42rem]
                   pointer-events-auto flex flex-col max-h-[60vh] overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/8 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-white/55"><SearchIcon /></span>
            <h2 className="text-white/85 text-sm font-semibold tracking-wide">External Subtitles</h2>
            <span className="text-white/30 text-xs">· OpenSubtitles</span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-full text-white/50 hover:text-white hover:bg-white/8
                       flex items-center justify-center transition-colors"
          >
            <CloseIcon />
          </button>
        </div>

        {/* Query + language row */}
        <div className="flex items-center gap-2 px-5 py-3 border-b border-white/6 flex-shrink-0">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Title, episode, or filename…"
            spellCheck={false}
            className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2
                       text-sm placeholder:text-white/25 outline-none focus:border-white/25
                       transition-colors"
            style={{ color: "var(--text-primary)" }}
          />
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className="bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm
                       outline-none focus:border-white/25 transition-colors cursor-pointer"
            style={{ color: "var(--text-primary)" }}
          >
            {LANG_PRESETS.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
        </div>

        {/* Status bar */}
        {(loading || error || success) && (
          <div className="px-5 py-2 flex-shrink-0 text-xs">
            {loading && <span className="text-white/45">Searching…</span>}
            {error && (
              <span className="text-red-400/85 break-all">{error}</span>
            )}
            {success && <span className="text-green-400/85">Loaded: {success}</span>}
          </div>
        )}

        {/* Results */}
        <div
          className="flex-1 min-h-0 overflow-y-auto px-3 py-2"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}
        >
          {!loading && !error && results.length === 0 && (
            <div className="text-white/35 text-xs px-3 py-6 text-center">
              {query.trim() || initialImdbId
                ? "No subtitles found."
                : "Enter a title to search."}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.file_id}
              onClick={() => handleDownload(r)}
              disabled={downloading !== null}
              className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-lg
                         hover:bg-white/8 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-white/85 text-sm font-medium truncate leading-tight">
                    {r.release || r.feature_title || "Untitled subtitle"}
                  </p>
                  {/* Hash-match badge — OpenSubtitles flagged this
                      entry as a MovieHash match against the played
                      file. Frame-accurate to that exact release. */}
                  {r.moviehash_match && (
                    <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono
                                     font-semibold uppercase tracking-wider
                                     bg-emerald-500/18 text-emerald-300
                                     border border-emerald-400/35">
                      Hash match
                    </span>
                  )}
                </div>
                <p className="text-white/35 text-xs mt-0.5 truncate">
                  {r.language?.toUpperCase()} {r.fps ? `· ${r.fps.toFixed(2)} fps` : ""}
                  {r.download_count ? ` · ${r.download_count.toLocaleString()} downloads` : ""}
                  {r.hearing_impaired ? " · CC" : ""}
                </p>
              </div>
              <span className="flex-shrink-0 text-xs text-ln-accent">
                {downloading === r.file_id ? "Loading…" : "Use"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
