// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import { nudgeReleasePoller } from "./releaseSearch";
import { loadAuraSettings } from "./auraSettings";
import type { LibraryItem } from "./types";

// ---------------------------------------------------------------------------
// LibraryRefreshButton — sits to the right of the notifications bell at
// fixed bottom-3 left-[55px]. Same glass / pulse aesthetic as the bell
// (`aura-bell-hover`, matching border + backdrop). Visible across every
// sidebar-rooted view (Home, Library, Calendar, Addons, Settings, etc.)
// because it's mounted in App.tsx body next to the bell, and inherits
// the same `hidden` class during playback for the same reason.
//
// Click semantics, per release-search-spec §6.2 path 3 ("On manual
// library refresh → nudgeReleasePoller(id, type) per item, then
// re-batch after 30s"):
//
//   1. Fire `aura:library-changed` — App.tsx's existing listener
//      re-runs `loadLibrary(session)` which in turn fires the
//      release-signal reconcile effect via the [library, session]
//      dependency.
//   2. For each tt-prefixed library item, fire-and-forget
//      `nudgeReleasePoller`. The cloud's poller picks the rows up on
//      its next 5 s dispatcher tick.
//   3. Schedule a re-batch after 30 s so newly-polled signals
//      propagate into the local store without waiting for the
//      next library mutation.
//
// The button visually disables for ~2 s after a click to prevent
// click-spamming the cloud's per-IP rate limit (30 nudges/min cap
// per §4.3). Tooltip surfaces the function in plain language.
// ---------------------------------------------------------------------------

const COOLDOWN_MS = 2000;

interface Props {
  /** Snapshot of the library at click time. Passed in so this
   *  component doesn't need to thread Stremio session state itself
   *  — App.tsx already has both ready. Empty array is allowed and
   *  results in a no-op (no items to nudge). */
  library: LibraryItem[];
}

export default function LibraryRefreshButton({ library }: Props) {
  const [cooldown, setCooldown] = useState(false);
  const [spinning, setSpinning] = useState(false);

  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown(false), COOLDOWN_MS);
    return () => clearTimeout(t);
  }, [cooldown]);

  const handleClick = useCallback(() => {
    if (cooldown) return;
    setCooldown(true);
    setSpinning(true);
    // Spinner runs for one cooldown cycle — covers the visible delay
    // between the click and the post-refresh signal landing. The
    // actual reconcile happens via the loadLibrary path below.
    setTimeout(() => setSpinning(false), COOLDOWN_MS);

    // Fire library-changed first so loadLibrary kicks off the
    // upstream Stremio pull; release-signal reconcile rides on top
    // of it via App.tsx's [library, session.auth_key] dependency.
    window.dispatchEvent(new CustomEvent("aura:library-changed"));

    // Per-item poller nudges. Only fire when the user has the cloud
    // feature enabled — otherwise we'd be calling the cloud despite
    // their opt-out. Skip non-tt ids because the cloud poller is
    // imdb-keyed (kitsu/mal/anidb addresses go through addon path).
    if (loadAuraSettings().releaseSearchEnabled) {
      for (const it of library) {
        if (!it.id || !it.id.startsWith("tt")) continue;
        const t = (it.media_type ?? "").toLowerCase();
        const mt: "series" | "movie" | undefined =
          t === "movie" ? "movie"
            : (t === "series" || t === "anime") ? "series"
            : undefined;
        if (!mt) continue;
        nudgeReleasePoller(it.id, mt);
      }
      // Schedule a re-batch fetch after 30 s so the cloud's freshly-
      // polled signals propagate into the local store. We do this
      // by firing a benign library-changed again — the existing
      // App.tsx effect re-runs reconcileLibraryReleaseSignals which
      // calls fetchReleaseSignals against the (now-warmer) cloud.
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("aura:library-changed"));
      }, 30_000);
    }
  }, [cooldown, library]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={cooldown}
      title="Refresh library — pulls fresh data from Stremio, then asks Aura Cloud whether any library titles have new episodes."
      aria-label="Refresh library"
      // Anchored to bottom-3 with a left offset that clears the
      // bell's 40px footprint + a 12px gap (3+40+12 = 55). Same
      // z-index as the bell so they share the same stacking
      // context vs the rest of the app body.
      className={[
        "fixed bottom-3 z-30",
        "h-10 w-10 rounded-full",
        "flex items-center justify-center",
        "bg-white/[0.08] hover:bg-white/[0.14] active:bg-white/[0.18]",
        "border border-white/10 hover:border-white/20",
        "backdrop-blur-xl",
        "text-white/80 hover:text-white",
        "transition-colors duration-200",
        "shadow-lg",
        "aura-bell-hover",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        "disabled:hover:bg-white/[0.08] disabled:hover:border-white/10",
      ].filter(Boolean).join(" ")}
      style={{ left: "55px" }}
    >
      <RefreshIcon spinning={spinning} />
    </button>
  );
}

/** Material-style circular-refresh glyph. Rotates 360° while
 *  `spinning` is true to give the user a visible cue that the
 *  request is in flight. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      style={{
        transition: "transform 0.2s ease",
        // CSS-only spin animation (no extra keyframes needed — borrow
        // from the existing aura-bell-pulse rotation envelope by
        // using `animation: spin` if defined globally; otherwise
        // inline a quick rotate). 1.6 s feels brisk enough to read
        // as "working" without distracting.
        animation: spinning ? "aura-refresh-spin 1.2s linear infinite" : "none",
      }}
    >
      <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-8 3.58-8 8s3.58 8 8 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}
