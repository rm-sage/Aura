// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";

// ---------------------------------------------------------------------------
// SourcePopup — in-app modal that hosts a Tauri child Webview loading an
// external URL (IMDb / RT / AniList / etc). Visually styled to match the
// CalendarView day-overlay so it reads as part of Aura instead of a
// detached OS window.
//
// Architecture: a child Tauri Webview is attached to the main
// WebviewWindow ("main") and positioned over a transparent placeholder
// div inside our React modal. We watch the placeholder's geometry with
// a ResizeObserver and call setPosition / setSize on the webview each
// frame the layout changes — so the loaded page tracks the modal as
// the user resizes the main window or transitions in/out.
//
// We pick child-webview over WebviewWindow specifically because:
//   • it doesn't open a separate OS window (no native chrome)
//   • we control the surrounding chrome with React (matching theme)
//   • ESC keydown on the main window can close it without
//     globalShortcut plumbing (foreign window keys would never reach us)
//
// Pages with `X-Frame-Options: DENY` work fine here — the child
// webview is its own browsing context, not an iframe.
// ---------------------------------------------------------------------------

const POPUP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const FIRST_POPUP_TOAST_KEY = "aura:popup-first-open-shown";
const POPUP_FIRST_HINT_EVENT = "aura:popup-first-open-hint";
const OPEN_EVENT = "aura:open-source-popup";

interface SourceState {
  url: string;
  title: string;
}

let _setActive: ((s: SourceState | null) => void) | null = null;

/** Open `url` inside the in-app popup. Title appears in the modal's
 *  header bar. Replaces any popup currently open (only one is visible
 *  at a time — keeps the chrome from stacking). */
export function openSourcePopup(url: string, title: string): void {
  if (!_setActive) {
    console.warn("[source-popup] openSourcePopup called but no host is mounted");
    return;
  }
  _setActive({ url, title });
}

export function closeSourcePopup(): void {
  if (_setActive) _setActive(null);
}

export default function SourcePopupHost() {
  const [active, setActive] = useState<SourceState | null>(null);
  const [opening, setOpening] = useState(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const webviewRef = useRef<Webview | null>(null);
  // Each spawn gets a unique label so a quick re-open doesn't reuse a
  // half-torn-down webview.
  const labelCounterRef = useRef(0);

  // Wire the global setter on mount so the helper above can dispatch.
  useEffect(() => {
    _setActive = setActive;
    return () => { _setActive = null; };
  }, []);

  // Cross-component event bridge — keeps callers (App.tsx, anywhere
  // else) from needing to import the JS helper directly. Same pattern
  // as ContextMenu.openContextMenu vs the OPEN_EVENT bridge.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<SourceState>).detail;
      if (detail?.url) setActive(detail);
    };
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOpen);
  }, []);

  // ESC closes — global keydown so it works whether focus is on the
  // main webview or has bounced. Inside the child popup webview the
  // page itself receives ESC and we can't intercept; the user can
  // still close via the X button.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  // Backdrop entry animation — same pattern as CalendarView's DayOverlay.
  useEffect(() => {
    if (!active) { setOpening(false); return; }
    setOpening(true);
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => setOpening(false)),
    );
    return () => cancelAnimationFrame(id);
  }, [active]);

  // First-open orientation toast (once per install).
  useEffect(() => {
    if (!active) return;
    if (localStorage.getItem(FIRST_POPUP_TOAST_KEY)) return;
    try { localStorage.setItem(FIRST_POPUP_TOAST_KEY, "1"); } catch {}
    window.dispatchEvent(
      new CustomEvent(POPUP_FIRST_HINT_EVENT, {
        detail: { message: "Source loaded inside Aura · press ESC or click outside the panel to close." },
      }),
    );
  }, [active]);

  // Spawn / tear down the child webview. We do this in a layout effect
  // so the placeholder's geometry is final before we measure.
  useLayoutEffect(() => {
    let cancelled = false;
    if (!active) {
      const wv = webviewRef.current;
      webviewRef.current = null;
      if (wv) wv.close().catch(() => {});
      return;
    }
    const placeholder = placeholderRef.current;
    if (!placeholder) return;

    const main = getCurrentWindow();
    const label = `aura-source-popup-${++labelCounterRef.current}-${Date.now()}`;
    const rect = placeholder.getBoundingClientRect();

    const wv = new Webview(main, label, {
      url: active.url,
      x: rect.left,
      y: rect.top,
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
      userAgent: POPUP_USER_AGENT,
    });
    webviewRef.current = wv;

    wv.once("tauri://error", (e) => {
      console.warn(`[source-popup] webview error: ${JSON.stringify(e.payload)}`);
      if (!cancelled) setActive(null);
    });

    return () => {
      cancelled = true;
      // Close the live ref AND the variable we captured at spawn time.
      // Different events trigger different orderings; either ref might
      // already be null by the time cleanup runs.
      const live = webviewRef.current;
      webviewRef.current = null;
      const target = live ?? wv;
      if (target) target.close().catch(() => {});
    };
  }, [active]);

  // Track the placeholder's geometry: any time the modal resizes (user
  // drags the main window edges, sidebar collapses, etc.) we push the
  // child webview to match. Without this the webview drifts off-screen
  // or covers neighbouring chrome.
  useEffect(() => {
    if (!active) return;
    const placeholder = placeholderRef.current;
    if (!placeholder) return;

    let raf: number | null = null;
    const sync = () => {
      const wv = webviewRef.current;
      if (!wv) return;
      const r = placeholder.getBoundingClientRect();
      wv.setPosition(new LogicalPosition(r.left, r.top)).catch(() => {});
      wv.setSize(new LogicalSize(Math.max(1, r.width), Math.max(1, r.height))).catch(() => {});
    };
    const schedule = () => {
      if (raf != null) return;
      raf = requestAnimationFrame(() => { raf = null; sync(); });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(placeholder);
    window.addEventListener("resize", schedule);
    // First sync — give the spawn effect above a frame to attach.
    schedule();
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [active]);

  const close = useCallback(() => setActive(null), []);

  if (!active) return null;

  return (
    // Backdrop — full viewport, dim + blur. Click closes.
    <div
      className="fixed inset-0 z-[260] flex items-center justify-center p-6"
      style={{
        backgroundColor: opening ? "transparent" : "rgba(0,0,0,0.78)",
        backdropFilter: opening ? "blur(0px)" : "blur(8px)",
        transition: "background-color 200ms ease, backdrop-filter 200ms ease",
      }}
      onClick={close}
    >
      {/* Modal card — matches CalendarView's DayOverlay. Click-through
          stops propagation so the backdrop click only fires when the
          user actually clicks outside the card. */}
      <div
        className="glass-panel rounded-2xl flex flex-col overflow-hidden"
        style={{
          width: "min(1280px, 92vw)",
          height: "min(820px, 88vh)",
          opacity: opening ? 0 : 1,
          transform: opening ? "scale(0.92)" : "scale(1)",
          transition:
            "opacity 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1), " +
            "transform 280ms 60ms cubic-bezier(0.2, 0.8, 0.2, 1)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — title + close button. Matches DayOverlay's header
            so the two modals feel like the same component. */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 shrink-0
                        border-b border-white/8">
          <h2 className="text-white/90 text-lg font-semibold tracking-tight truncate">
            {active.title}
          </h2>
          <button
            onClick={close}
            aria-label="Close"
            className="w-8 h-8 rounded-full glass-panel flex items-center justify-center
                       text-white/55 hover:text-white transition-colors shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        {/* Webview placeholder — the child Tauri Webview overlays this
            div via setPosition/setSize. The bg-black underneath is what
            shows briefly before the page paints, and again behind any
            transparent areas of the loaded site. */}
        <div ref={placeholderRef} className="flex-1 bg-black rounded-b-2xl" />
      </div>
    </div>
  );
}
