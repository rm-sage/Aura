// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import type React from "react";
import { holdLensForMorph } from "./liquidGlass";
import { useListDroplet } from "./glassListDroplet";

// ---------------------------------------------------------------------------
// SearchBar
//
// Interactions:
//   • While the input is focused, a backdrop dims (no blur) the app and, when the input
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

// memo: the one caller (HomeView) passes state plus [] -deps callbacks, so
// this only skips renders whose props did not change. Everything else the bar
// shows comes from its own state, effects and window listeners.
export default memo(function SearchBar({
  committedQuery, onSubmit, onClear,
}: Props) {
  const [query, setQuery]     = useState(committedQuery ?? "");
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<string[]>(loadRecents);

  const containerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLLabelElement>(null);
  const droplet = useListDroplet();
  const morphPrimed = useRef(false);

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
    // Focus on a recents button, or fallen to the body when the focused button
    // removed itself. The input keeps its own Esc (clear first, then close).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.target instanceof HTMLInputElement && containerRef.current?.contains(e.target)) return;
      setFocused(false);
    };
    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
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

  // The dim overlay outlives the focus by its exit fade: the bar refracts it,
  // so unmounting it at once made everything behind the bar jump from dimmed
  // to bright while the bar was still contracting. Derived during render (not
  // in an effect), so there is never a frame with the overlay unmounted.
  const [overlayOn, setOverlayOn] = useState(false);
  if (focused && !overlayOn) setOverlayOn(true);
  const showOverlay = focused || overlayOn;
  // Safety net for the exit: animationend never fires if the animation is
  // suppressed, and a stuck overlay would leave the page dimmed.
  useEffect(() => {
    if (focused || !overlayOn) return;
    const t = window.setTimeout(() => setOverlayOn(false), 420);
    return () => window.clearTimeout(t);
  }, [focused, overlayOn]);
  // The dim's fade, in and out, through the Web Animations API from the
  // CURRENT opacity: refocusing during the exit reverses from where the fade
  // is (a CSS animation-name swap restarted the in-fade from 0, so the page
  // flashed bright under the widening bar). Base opacity is 0 and the fade
  // fills forwards, so a fresh mount reads 0 and fades in.
  const overlayRef = useRef<HTMLDivElement>(null);
  const overlayAnim = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const el = overlayRef.current;
    if (!el) { overlayAnim.current = null; return; }
    const from = Number.parseFloat(getComputedStyle(el).opacity) || 0;
    overlayAnim.current?.cancel();
    const a = el.animate([{ opacity: from }, { opacity: focused ? 1 : 0 }], {
      duration: focused ? 220 : 340,
      easing: "ease-out",
      fill: "forwards",
    });
    overlayAnim.current = a;
    if (!focused) a.onfinish = () => setOverlayOn(false);
  }, [focused, showOverlay]);
  const showDropdown = focused && query.trim() === "" && recents.length > 0;
  // Tell the rail's notification bubble the dim is up or gone (it waits
  // retracted while it is up: NotificationsBell useSearchDim). The dim carries
  // `data-aura-search-dim="on"` while focused; this event is the change signal.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("aura:search-dim"));
  }, [focused]);
  useEffect(() => () => { window.dispatchEvent(new CustomEvent("aura:search-dim")); }, []);

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

  // The bar widens to the full column on focus and narrows back on close
  // (.aura-search-shell.is-open, App.css .aura-glass-morph-w). In Liquid the
  // bar's lens is the sliced SVG filter that covers every width of its height
  // (liquidGlass.ts MORPH_SELECTOR), so it stays bound through the transition
  // and holdLensForMorph is a no-op; only a bar not yet on that filter draws
  // its CSS face for the transition and binds at rest. Layout effect: before
  // the paint that starts the width transition. No layout read, nothing per
  // frame.
  useLayoutEffect(() => {
    if (!morphPrimed.current) { morphPrimed.current = true; return; }
    const shell = shellRef.current;
    if (shell) holdLensForMorph(shell, 0, 0);
  }, [focused]);

  // A recents list that changes under the pointer (a removal, a clear)
  // leaves the droplet over a stale row: drop it.
  const hideDroplet = droplet.hide;
  useEffect(() => { hideDroplet(); }, [recents, showDropdown, hideDroplet]);

  return (
    <>
      {/* Backdrop dim — covers app behind the input + dropdown when focused */}
      {showOverlay && (
        <div
          ref={overlayRef}
          data-aura-search-dim={focused ? "on" : "off"}
          className="fixed inset-0 z-30"
          style={{
            background: "rgba(0,0,0,0.7)",
            // A dim only, no blur: a blur here pre-smeared the page the bar
            // refracts (and cost a full-viewport backdrop pass while focused).
            // Faded by the layout effect above: in over 220 ms, out over the
            // bar's contraction (340 ms, the 360 ms width spring), so the
            // backdrop the bar refracts brightens as it narrows.
            opacity: 0,
            pointerEvents: focused ? undefined : "none",
          }}
          aria-hidden
          onMouseDown={() => setFocused(false)}
        />
      )}

      <div
        ref={containerRef}
        className="aura-search-float relative z-40"
        // Tabbing out. A null relatedTarget is not "outside": it is also an
        // Alt+Tab or a press on the dropdown's plain text.
        onBlur={(e) => {
          const next = e.relatedTarget;
          if (next instanceof Node && !containerRef.current?.contains(next)) setFocused(false);
        }}
      >
        {/* The glass shell is a <label>, so a press anywhere on it (the icon,
            the padding) focuses the bare input inside. Floating CONTROL tier
            (aura-glass-control): in Liquid the milky refracting face, in
            Frosted the same float glass as before. Its hover and focus edges
            are hooks in src/styles/glass-search.css (never border-* utilities:
            they would override both materials). data-glass-base: poster
            titles scroll under it, so in Liquid it stacks the solid base
            under its blur (App.css, liquidGlass.ts BASE_SELECTOR).
            data-glass-bleed: the Home hero's ambient bleed is cut out under
            it and drawn in its face instead (HeroBleed.tsx), so the bleed
            never bands under its blur. */}
        <label
          ref={shellRef}
          data-glass-base=""
          data-glass-bleed=""
          className={`aura-float-glass aura-glass-control aura-glass-morph-w aura-search-shell
                      relative flex items-center gap-2.5 rounded-full pl-4 pr-4 cursor-text
                      ${focused ? "is-open" : ""}`}
        >
          <span className="text-white/55 pointer-events-none flex-shrink-0 flex">
            <SearchIcon />
          </span>
          <input
            type="search"
            value={query}
            onFocus={() => setFocused(true)}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Empty → close dropdown and give the keys back to the page.
                // Non-empty → clear (which fires onClear via the useEffect and
                // exits search view).
                if (query) setQuery("");
                else {
                  setFocused(false);
                  e.currentTarget.blur();
                }
              }
              if (e.key === "Enter") {
                e.preventDefault();
                commitSearch();
              }
            }}
            placeholder="Search all sources…"
            data-aura-search
            spellCheck={false}
            className="flex-1 min-w-0 bg-transparent border-0 py-2.5 text-sm
                       placeholder:text-white/75 outline-none"
            style={{ color: "var(--text-primary)" }}
            aria-label="Global search"
          />
        </label>

        {/* Dropdown: recent searches only (shown when the input is empty) */}
        {showDropdown && (
          <div
            // aura-float-glass (the MENU tier), never glass-panel-elevated:
            // that composites --ln-glass-3, which is TINTED per theme and
            // pushed the whole panel toward orange on the warm themes. This
            // surface carries a neutral dark base instead. It grows out of the
            // bar above it (aura-glass-pop-in, origin at the top centre).
            className="aura-float-glass aura-glass-pop-in absolute left-0 right-0 top-full mt-2 z-40
                       rounded-2xl overflow-hidden"
            style={{ "--lg-origin": "50% 0" } as React.CSSProperties}
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
              {/* Rows: .aura-glass-row (Frosted hover fill). In Liquid one
                  shared droplet slides between them instead (useListDroplet). */}
              <div className="relative" {...droplet.listProps}>
                <span ref={droplet.ref} aria-hidden className="aura-glass-hl aura-glass-hl-inset" />
                {recents.map((r) => (
                  <div
                    key={r}
                    className="aura-glass-row relative group w-full flex items-center gap-2"
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
    </>
  );
});
