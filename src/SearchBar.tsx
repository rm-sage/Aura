// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// SearchBar
//
// Interactions:
//   • While the input is focused, a backdrop dims the app and, when the input
//     is empty, a dropdown shows "Recent Searches" persisted in localStorage.
//   • Submitting (Enter) commits the query and saves it to recents.
// ---------------------------------------------------------------------------

interface Props {
  /** Current committed query from the parent — used to keep the input in sync
   *  when the parent clears search externally. */
  committedQuery?: string | null;
  /** Fired on Enter — commits the current input as the active search query.
   *  The dropdown is closed atomically. */
  onSubmit: (query: string) => void;
  /** Fired when the input becomes empty — parent should exit search view. */
  onClear: () => void;
}

const RECENT_KEY  = "aura:recent-searches";
const RECENT_MAX  = 8;

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

const ClockIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" />
  </svg>
);

const CloseSmall = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Recent searches — localStorage helpers
// ---------------------------------------------------------------------------

function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string").slice(0, RECENT_MAX);
  } catch { return []; }
}

function saveRecents(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
    // Notify the cloud sync layer so it can debounce a push to the
    // proxy's `recent-searches` namespace. Wrapped in a try because
    // CustomEvent isn't available in test/SSR contexts.
    try { window.dispatchEvent(new CustomEvent("aura:recent-searches-changed")); } catch {}
  } catch { /* ignore quota errors */ }
}

function pushRecent(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return loadRecents();
  const current = loadRecents().filter((q) => q.toLowerCase() !== trimmed.toLowerCase());
  const next = [trimmed, ...current].slice(0, RECENT_MAX);
  saveRecents(next);
  return next;
}

function clearAllRecents(): string[] {
  saveRecents([]);
  return [];
}

// ---------------------------------------------------------------------------
// SearchBar
// ---------------------------------------------------------------------------

export default function SearchBar({
  committedQuery, onSubmit, onClear,
}: Props) {
  const [query, setQuery]     = useState(committedQuery ?? "");
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<string[]>(loadRecents);

  const containerRef = useRef<HTMLDivElement>(null);

  // Sync from parent — e.g., user clicked a recent search, or external clear.
  // When the parent sets committedQuery to null (Home re-click), clear the
  // input too so the user sees an empty bar instead of stale text.
  useEffect(() => {
    if (committedQuery == null) {
      if (query !== "") setQuery("");
    } else if (committedQuery !== query) {
      setQuery(committedQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedQuery]);

  // Click-outside closes the recents dropdown / overlay.
  useEffect(() => {
    if (!focused) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setFocused(false);
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    return () => window.removeEventListener("mousedown", onMouseDown);
  }, [focused]);

  // Notify parent immediately when the input is cleared.
  useEffect(() => {
    if (query.trim() === "") onClear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  /** Commit handler: fires on Enter. Closes the dropdown atomically. */
  const commitSearch = useCallback(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setRecents(pushRecent(trimmed));
    setFocused(false);
    onSubmit(trimmed);
  }, [query, onSubmit]);

  const showOverlay = focused;
  const showDropdown = focused && query.trim() === "" && recents.length > 0;

  const pickRecent = useCallback((q: string) => {
    setQuery(q);
    setRecents(pushRecent(q));
    setFocused(false);
    onSubmit(q);
  }, [onSubmit]);

  const removeRecent = useCallback((q: string) => {
    const next = loadRecents().filter((x) => x.toLowerCase() !== q.toLowerCase());
    saveRecents(next);
    setRecents(next);
  }, []);

  const onClearRecents = useCallback(() => setRecents(clearAllRecents()), []);

  return (
    <>
      {/* Backdrop dim — covers app behind the input + dropdown when focused */}
      {showOverlay && (
        <div
          className="fixed inset-0 z-30"
          style={{
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            animation: "search-overlay-in 220ms ease-out",
          }}
          aria-hidden
          onMouseDown={() => setFocused(false)}
        />
      )}

      <div ref={containerRef} className="relative z-40">
        <div className="relative">
          <span className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 pointer-events-none">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={query}
            onFocus={() => setFocused(true)}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Empty → close dropdown. Non-empty → clear (which fires
                // onClear via the useEffect and exits search view).
                if (query) setQuery(""); else setFocused(false);
              }
              if (e.key === "Enter") {
                e.preventDefault();
                commitSearch();
              }
            }}
            placeholder="Search all sources…"
            spellCheck={false}
            className={`w-full bg-white/5 border rounded-full pl-10 pr-4 py-2.5 text-sm
                        placeholder:text-white/30 outline-none transition-colors
                        ${focused
                          ? "border-white/30 bg-black/40"
                          : "border-white/10 hover:border-white/20"
                        }`}
            style={{ color: "var(--text-primary)" }}
            aria-label="Global search"
          />
        </div>

        {/* Dropdown: recent searches only (shown when the input is empty) */}
        {showDropdown && (
          <div
            className="absolute left-0 right-0 top-full mt-2 z-40 rounded-2xl
                       glass-panel-elevated shadow-glass-edge overflow-hidden
                       border border-white/12"
            style={{ animation: "search-dropdown-in 220ms ease-out" }}
          >
            <div className="py-2">
              <div className="px-4 pb-1 flex items-center justify-between">
                <p className="text-white/45 text-[10px] font-semibold tracking-[0.18em] uppercase">
                  Recent
                </p>
                <button
                  onClick={onClearRecents}
                  className="text-white/35 hover:text-white/70 text-[10px]"
                >
                  Clear all
                </button>
              </div>
              <div className="space-y-0">
                {recents.map((r) => (
                  <div
                    key={r}
                    className="group w-full flex items-center gap-2 hover:bg-white/8
                               transition-colors"
                  >
                    <button
                      onClick={() => pickRecent(r)}
                      className="flex-1 flex items-center gap-3 px-4 py-2 text-left"
                    >
                      <span className="text-white/35"><ClockIcon /></span>
                      <span className="text-white/80 text-sm truncate">{r}</span>
                    </button>
                    <button
                      aria-label={`Remove ${r}`}
                      onClick={() => removeRecent(r)}
                      className="opacity-0 group-hover:opacity-100 mr-3 w-6 h-6 rounded-full
                                 text-white/40 hover:text-white/80 hover:bg-white/10
                                 flex items-center justify-center"
                    >
                      <CloseSmall />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <style>{`
        @keyframes search-overlay-in {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes search-dropdown-in {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </>
  );
}
