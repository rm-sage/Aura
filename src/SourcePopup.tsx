// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

// Cadence for polling the popup webview's live URL to keep the address
// bar in sync with in-page navigation. 400ms reads snappy to the eye
// without meaningful cost — each tick is a single WebView2 `Source` read
// behind one IPC call, and only runs while a non-OAuth popup is visible.
const URL_POLL_MS = 400;

// Grace window after a user-typed Go/Enter navigation during which the
// poll ignores a `Source` that still reports the page we're leaving.
// Navigating goes through an eval'd `location.assign`, so there's a lag
// where `Source` hasn't moved yet; without this the bar would flicker
// back to the previous URL mid-load. The window self-ends as soon as
// `Source` actually moves off the old page, so this is only a safety cap
// for slow / failed loads.
const SUBMIT_GRACE_MS = 2500;

interface SourceState {
  url: string;
  title: string;
  /** OAuth-mode descriptor. When set, the popup:
   *
   *    • spawns the child webview from Rust (so we can register an
   *      `on_navigation` handler that intercepts `interceptPrefix`
   *      navigations and re-emits them as `deep-link` events — see
   *      `open_oauth_popup_webview` in scrobble_auth.rs); and
   *    • auto-closes when `aura:scrobble-auth-changed` fires, so the
   *      user doesn't have to manually dismiss the popup after auth
   *      succeeds (whether by deep-link interception for AniList or
   *      by device-flow polling for Trakt).
   *
   *  Omitting `interceptPrefix` (Trakt's case) skips navigation
   *  interception and lets the device-flow polling drive auth
   *  detection — the popup is just a convenient in-app browser tab
   *  for entering the user_code on trakt.tv/activate.
   *
   *  `userCode` is the device-flow code surfaced as a copyable chip
   *  in the popup header AND in the minimized floating pill, so the
   *  user can always see what to paste into trakt.tv/activate
   *  without having to dismiss or minimize the popup first. */
  oauth?: {
    interceptPrefix?: string;
    userCode?: string;
  };
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

/** Open `url` inside the popup in OAuth mode. The popup self-closes on
 *  `aura:scrobble-auth-changed`; pass `interceptPrefix` (e.g.
 *  `aura://oauth/anilist`) to also intercept navigations to that scheme
 *  and re-emit them as `deep-link` events instead of letting WebView2
 *  hand them off to the OS scheme handler. Trakt callers can omit
 *  `interceptPrefix` — device-flow polling drives auth detection
 *  separately. */
export function openOAuthPopup(
  url: string,
  title: string,
  opts: { interceptPrefix?: string; userCode?: string } = {},
): void {
  if (!_setActive) {
    console.warn("[source-popup] openOAuthPopup called but no host is mounted");
    return;
  }
  _setActive({
    url,
    title,
    oauth: { interceptPrefix: opts.interceptPrefix, userCode: opts.userCode },
  });
}

export function closeSourcePopup(): void {
  if (_setActive) _setActive(null);
}

export default function SourcePopupHost() {
  const [active, setActive] = useState<SourceState | null>(null);
  const [opening, setOpening] = useState(false);
  // Live host of the page currently rendered inside the OAuth popup.
  // Only set in OAuth mode (the Rust spawn emits `popup-nav:<label>`
  // events on every top-level navigation). The non-OAuth flow leaves
  // this null and the header just shows the static title.
  const [navHost, setNavHost] = useState<string | null>(null);
  // Address-bar state for the chrome strip. `urlInput` is what the user
  // is typing; `currentUrl` is the last-known committed URL of the child
  // webview (initial URL, what the user typed + submitted, or — via the
  // URL poll effect below — the page they clicked through to inside the
  // webview). The JS `Webview` class exposes no navigation event, so we
  // poll the Rust `popup_webview_current_url` command (a pure read of
  // WebView2's live `Source`) on a short interval while the popup is
  // open. That `Source` tracks in-page link clicks, form submits, AND
  // SPA client-side route changes — history.pushState/replaceState to a
  // new URL, e.g. AniList's Vue router moving from a title page to
  // /home — so the bar stays honest like a real browser's. The
  // `editingRef` below suppresses the auto-sync while the user is typing
  // in the bar so a poll tick can't clobber their input mid-edit.
  const [urlInput, setUrlInput] = useState("");
  const [currentUrl, setCurrentUrl] = useState("");
  // True while the address-bar input is focused (user is editing). Kept
  // as a ref so toggling it doesn't restart the poll effect's interval.
  const editingRef = useRef(false);
  // Minimized — collapses the backdrop+card to a floating pill at
  // bottom-right while keeping the child webview alive offscreen so
  // OAuth flow state (cookies, in-progress page, etc) doesn't reset
  // when the user looks at something underneath. The user_code
  // banner in SettingsView (and the user_code chip in the pill
  // below) is the typical reason — Trakt's device flow expects the
  // code to be visible alongside trakt.tv/activate.
  const [minimized, setMinimized] = useState(false);
  // Reset minimized whenever the popup re-opens, otherwise a stale
  // `minimized: true` could persist across an open/close cycle and
  // hide the next popup behind nothing.
  useEffect(() => { if (!active) setMinimized(false); }, [active]);

  // Mirror active.url into the address-bar input + committed-URL state on
  // every (re)open. Keyed on the whole `active` object (not `active?.url`)
  // so re-opening to the SAME url after the user has navigated inside the
  // popup still resets the bar to the freshly-respawned page instead of
  // leaving it showing wherever they'd browsed to. Also clears the
  // post-submit grace stamp and seeds the live-URL tracker so a new
  // session starts clean.
  useEffect(() => {
    if (!active) {
      setUrlInput("");
      setCurrentUrl("");
      lastSubmitRef.current = { leaving: "", ts: 0 };
      liveUrlRef.current = "";
      return;
    }
    setUrlInput(active.url);
    setCurrentUrl(active.url);
    lastSubmitRef.current = { leaving: "", ts: 0 };
    liveUrlRef.current = active.url;
  }, [active]);
  const placeholderRef = useRef<HTMLDivElement>(null);
  // The address-bar <input>, so submitUrl can blur it (browser-omnibox
  // behaviour: focus leaves the bar on navigate, which also lets the poll
  // resume syncing the bar to the actual landing URL).
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks the most recently OBSERVED webview URL (every poll tick), even
  // when we suppress repainting the bar. submitUrl reads this as the page
  // we're "leaving" so the grace window below knows which stale value to
  // ignore during the navigation lag.
  const liveUrlRef = useRef("");
  // Stamp set by submitUrl: the page we navigated away from + when. The
  // poll ignores a polled URL equal to `leaving` until SUBMIT_GRACE_MS
  // elapses or `Source` moves elsewhere, whichever comes first.
  const lastSubmitRef = useRef<{ leaving: string; ts: number }>({ leaving: "", ts: 0 });
  const webviewRef = useRef<Webview | null>(null);
  const activeLabelRef = useRef<string | null>(null);
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
        detail: { message: "Source loaded inside Aura. Press Esc or click outside the panel to close." },
      }),
    );
  }, [active]);

  // Spawn / tear down the child webview. We do this in a layout effect
  // so the placeholder's geometry is final before we measure.
  //
  // OAuth mode takes a different spawn path: the JS `new Webview()` API
  // can't register an `on_navigation` handler, so we delegate to the
  // Rust `open_oauth_popup_webview` command which builds the child
  // webview with the navigation interceptor wired up. We then attach a
  // JS-side handle via `Webview.getByLabel()` so the same
  // setPosition/setSize/close machinery downstream works for both
  // spawn paths uniformly.
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
    activeLabelRef.current = label;
    setNavHost(null);
    const rect = placeholder.getBoundingClientRect();
    const x = rect.left;
    const y = rect.top;
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    let captured: Webview | null = null;

    if (active.oauth) {
      invoke("open_oauth_popup_webview", {
        label,
        url: active.url,
        x,
        y,
        width,
        height,
        interceptPrefix: active.oauth.interceptPrefix ?? null,
      })
        .then(async () => {
          if (cancelled) return;
          // Adopt a JS-side handle so the resize observer + close path
          // below work the same way as the JS-spawned popup.
          const wv = await Webview.getByLabel(label);
          if (cancelled || !wv) return;
          webviewRef.current = wv;
          captured = wv;
        })
        .catch((err) => {
          console.warn(`[source-popup] oauth spawn failed: ${String(err)}`);
          if (!cancelled) setActive(null);
        });
    } else {
      const wv = new Webview(main, label, {
        url: active.url,
        x,
        y,
        width,
        height,
        userAgent: POPUP_USER_AGENT,
      });
      webviewRef.current = wv;
      captured = wv;

      wv.once("tauri://error", (e) => {
        console.warn(`[source-popup] webview error: ${JSON.stringify(e.payload)}`);
        if (!cancelled) setActive(null);
      });
    }

    return () => {
      cancelled = true;
      // Close the live ref AND the variable we captured at spawn time.
      // Different events trigger different orderings; either ref might
      // already be null by the time cleanup runs. For OAuth spawns the
      // adoption is async, so `captured` may still be null when we
      // unmount fast — fall back to a fresh getByLabel lookup so an
      // orphaned child webview doesn't survive the modal close.
      const live = webviewRef.current;
      webviewRef.current = null;
      activeLabelRef.current = null;
      const target = live ?? captured;
      if (target) {
        target.close().catch(() => {});
      } else {
        Webview.getByLabel(label)
          .then((wv) => wv?.close().catch(() => {}))
          .catch(() => {});
      }
    };
  }, [active]);

  // OAuth mode — subscribe to the per-popup `popup-nav:<label>` event
  // emitted by the Rust spawn on every allowed top-level navigation.
  // We only resolve the host (no path / query), so the OAuth state
  // token in the proxy's start URL never crosses the bridge here. The
  // header renders this as a "currently on: <host>" security chip so
  // the user can spot a mid-flow phishing redirect that they couldn't
  // see otherwise (the popup webview has no URL bar of its own).
  useEffect(() => {
    if (!active?.oauth) return;
    const label = activeLabelRef.current;
    if (!label) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    listen<string>(`popup-nav:${label}`, (e) => {
      if (cancelled) return;
      setNavHost(e.payload || null);
    })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      setNavHost(null);
    };
  }, [active]);

  // OAuth mode auto-close — fires whether AniList's deep-link intercept
  // landed a token or Trakt's device-flow poll did. We dispatch the
  // close on the next animation frame so the toast that the connect
  // flow shows isn't immediately covered by the popup teardown
  // animation; small touch but reads better.
  useEffect(() => {
    if (!active?.oauth) return;
    const onAuth = () => {
      requestAnimationFrame(() => setActive(null));
    };
    window.addEventListener("aura:scrobble-auth-changed", onAuth);
    return () => window.removeEventListener("aura:scrobble-auth-changed", onAuth);
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
      // When minimized, push the webview far off-screen with a 1×1
      // size so it can't receive clicks or paint over the floating
      // pill, but still keep its DOM state (cookies, in-progress
      // OAuth page) alive for when the user restores. setPosition +
      // setSize are both LogicalPosition/LogicalSize so DPI scaling
      // is consistent with the in-card path below.
      if (minimized) {
        wv.setPosition(new LogicalPosition(-10000, -10000)).catch(() => {});
        wv.setSize(new LogicalSize(1, 1)).catch(() => {});
        return;
      }
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
  }, [active, minimized]);

  // Keep the address bar in sync with navigation that happens inside the
  // webview. The child webview fires no JS-side navigation event, so we
  // poll its live URL (WebView2 `Source`, surfaced by the Rust command)
  // while the popup is open and visible. Excluded:
  //   • OAuth popups — they deliberately expose only the host via the
  //     navHost chip (the full start URL carries a device-flow / CSRF
  //     state token we don't want echoed into a UI field), and have no
  //     address bar to update.
  //   • Minimized state — the bar isn't visible and the webview is
  //     parked offscreen; nothing to repaint.
  // We use a self-rescheduling timeout (not setInterval) so a slow IPC
  // round-trip can never let ticks pile up on top of each other.
  useEffect(() => {
    if (!active || active.oauth || minimized) return;
    const label = activeLabelRef.current;
    if (!label) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const url = await invoke<string>("popup_webview_current_url", { label });
        if (cancelled) return;
        // Ignore transient about:blank / non-http states during load so a
        // half-spawned webview can't blank out the bar.
        if (url && /^https?:/i.test(url)) {
          // During the grace window right after a user-typed navigate,
          // the webview's Source can still report the page we left while
          // the eval'd location.assign is in flight. Hold the bar on the
          // user's target until Source actually moves off the old page
          // (or the window expires) so it doesn't flicker backwards.
          const g = lastSubmitRef.current;
          const inGrace = g.ts !== 0 && Date.now() - g.ts < SUBMIT_GRACE_MS;
          if (inGrace && url === g.leaving) {
            liveUrlRef.current = url; // keep tracking what's loaded…
            return;                   // …but don't repaint the bar yet.
          }
          // Navigation has moved (or the window expired): end the grace
          // so subsequent ticks sync normally.
          if (g.ts !== 0) lastSubmitRef.current = { leaving: "", ts: 0 };
          liveUrlRef.current = url;
          setCurrentUrl((prev) => (prev === url ? prev : url));
          // Don't fight the user while they're editing the bar.
          if (!editingRef.current) {
            setUrlInput((prev) => (prev === url ? prev : url));
          }
        }
      } catch {
        // Popup not attached yet, or torn down mid-poll — retry next tick.
      } finally {
        if (!cancelled) timer = setTimeout(tick, URL_POLL_MS);
      }
    };
    // Give the spawn layout-effect a beat to attach the webview first.
    timer = setTimeout(tick, URL_POLL_MS);
    return () => {
      cancelled = true;
      if (timer != null) clearTimeout(timer);
    };
  }, [active, minimized]);

  const close = useCallback(() => setActive(null), []);
  /** Minimize: collapse the modal to a floating pill, keep the
   *  webview alive offscreen. The sync useEffect re-runs on the
   *  `minimized` dep so the webview snaps to the offscreen rect
   *  immediately, no animation frame wait. */
  const minimize = useCallback(() => setMinimized(true), []);
  /** Restore from the pill — same sync re-run brings the webview
   *  back to the placeholder's geometry. */
  const restore  = useCallback(() => setMinimized(false), []);

  // ── Navigation helpers (non-OAuth chrome strip) ──
  // The JS Webview class doesn't expose eval — Rust commands
  // (popup_webview_back/forward/reload/navigate) bridge the gap. Each
  // looks up the popup by label on the Rust side and dispatches a
  // single fixed eval. Failure is silent: most "failures" here are
  // "no history to go back to" / "page hasn't loaded yet" which the
  // user resolves by retrying.
  const invokePopupCmd = useCallback((command: string, extra?: Record<string, unknown>) => {
    const label = activeLabelRef.current;
    if (!label) return;
    invoke(command, { label, ...(extra ?? {}) }).catch(() => {});
  }, []);
  const goBack    = useCallback(() => invokePopupCmd("popup_webview_back"),    [invokePopupCmd]);
  const goForward = useCallback(() => invokePopupCmd("popup_webview_forward"), [invokePopupCmd]);
  const refresh   = useCallback(() => invokePopupCmd("popup_webview_reload"),  [invokePopupCmd]);

  /** Sanitise + commit a user-typed URL. Refuses anything that isn't
   *  plain http(s) — `javascript:`, `data:`, `file:`, `tauri:`, and
   *  scheme-less inputs are silently corrected (prefixing https:// for
   *  a bare host) or rejected outright. The Rust command re-validates
   *  the scheme so a stray non-http(s) URL can't smuggle past this
   *  guard either. */
  const submitUrl = useCallback(() => {
    const raw = urlInput.trim();
    if (!raw) return;
    let candidate = raw;
    if (!/^https?:\/\//i.test(candidate)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return; // any other scheme
      candidate = `https://${candidate}`;
    }
    let parsed: URL;
    try { parsed = new URL(candidate); }
    catch { return; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    const target = parsed.toString();
    setCurrentUrl(target);
    setUrlInput(target);
    // Stamp the page we're leaving so the poll's grace window can ignore
    // the stale Source during the navigation lag (see SUBMIT_GRACE_MS).
    lastSubmitRef.current = { leaving: liveUrlRef.current, ts: Date.now() };
    // Release the editing lock and drop focus — like a real browser's
    // omnibox, focus leaves the bar on navigate, which also lets the poll
    // resync the bar to wherever the page actually lands (redirects, SSO
    // bounces, post-load SPA routing).
    editingRef.current = false;
    inputRef.current?.blur();
    invokePopupCmd("popup_webview_navigate", { url: target });
  }, [urlInput, invokePopupCmd]);

  if (!active) return null;

  return (
    <>
    {/* Backdrop + card — kept mounted while minimized (so the child
        webview's placeholder rect stays measurable), made invisible
        and click-through via opacity:0 / pointer-events:none. The
        webview itself is moved offscreen in the sync function so
        clicks on the underlying UI pass through cleanly. */}
    <div
      className="fixed inset-0 z-[260] flex items-center justify-center p-6"
      style={{
        backgroundColor: opening ? "transparent" : "rgba(0,0,0,0.78)",
        backdropFilter: opening ? "blur(0px)" : "blur(8px)",
        transition: "background-color 200ms ease, backdrop-filter 200ms ease",
        opacity: minimized ? 0 : 1,
        pointerEvents: minimized ? "none" : "auto",
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
        {/* Header — title + chips + minimize + close. In OAuth mode
            we surface the live host (anti-phishing) AND the device-
            flow user_code (so it's visible alongside trakt.tv/activate
            without having to dismiss the popup). The popup webview
            has no URL bar of its own, so the header is the only
            place the user can see what site they're entering
            credentials into. */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 shrink-0
                        border-b border-white/8">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 min-w-0">
              <h2 className="text-white/90 text-lg font-semibold tracking-tight truncate">
                {active.title}
              </h2>
              {active.oauth?.userCode ? (
                <span
                  className="text-[12px] font-mono tracking-[0.18em] px-2.5 py-1
                             rounded-md bg-amber-500/10 text-amber-200 border border-amber-400/25
                             shrink-0 select-all"
                  title="Enter this code in the loaded page to authorize Aura."
                >
                  {active.oauth.userCode}
                </span>
              ) : null}
              {active.oauth && navHost ? (
                <span
                  className="text-[11px] font-mono uppercase tracking-wider px-2 py-0.5
                             rounded-md bg-white/8 text-white/60 border border-white/10
                             shrink-0"
                  title="Current page host. Verify this matches the OAuth provider before entering credentials."
                >
                  {navHost}
                </span>
              ) : null}
            </div>
            {/* OAuth mode keeps the static start-URL preview suppressed
                (the URL carries a device-flow state token; the navHost
                chip is the anti-phishing surface for that flow). The
                non-OAuth chrome strip below provides the URL surface
                for regular popups. */}
          </div>
          <button
            onClick={minimize}
            aria-label="Minimize"
            title="Minimize — keep the popup running, see what's underneath. Click the floating pill at bottom-right to restore."
            className="w-8 h-8 rounded-full glass-panel flex items-center justify-center
                       text-white/55 hover:text-white transition-colors shrink-0 mr-1"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="5" y="14" width="14" height="2" rx="1" />
            </svg>
          </button>
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

        {/* Chrome strip — Back / Forward / Refresh + editable address bar.
            Non-OAuth popups only. OAuth flows deliberately omit the
            address bar because the navHost chip in the header is the
            anti-phishing surface, and offering an editable URL there
            would let the user paste a phishing URL into a half-loaded
            OAuth window where credentials are about to be entered. */}
        {!active.oauth && (
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/8 shrink-0
                          bg-white/[0.02]">
            <button
              type="button"
              onClick={goBack}
              aria-label="Back"
              title="Back"
              className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center
                         text-white/55 hover:text-white hover:bg-white/8 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={goForward}
              aria-label="Forward"
              title="Forward"
              className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center
                         text-white/55 hover:text-white hover:bg-white/8 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={refresh}
              aria-label="Refresh"
              title="Refresh"
              className="w-8 h-8 shrink-0 rounded-md flex items-center justify-center
                         text-white/55 hover:text-white hover:bg-white/8 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12a9 9 0 0 1 15.4-6.36L21 8" />
                <polyline points="21 3 21 8 16 8" />
                <path d="M21 12a9 9 0 0 1-15.4 6.36L3 16" />
                <polyline points="3 21 3 16 8 16" />
              </svg>
            </button>
            <input
              ref={inputRef}
              type="text"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); submitUrl(); }
              }}
              onFocus={() => { editingRef.current = true; }}
              onBlur={() => { editingRef.current = false; }}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="Enter URL (http or https only)"
              title={currentUrl || urlInput}
              className="flex-1 min-w-0 h-8 px-3 rounded-md
                         bg-white/[0.04] border border-white/10
                         text-white/85 text-[12px] font-mono
                         placeholder-white/30
                         focus:outline-none focus:border-ln-accent/50
                         focus:bg-white/[0.06]"
            />
            <button
              type="button"
              onClick={submitUrl}
              aria-label="Go"
              title="Go"
              className="h-8 px-3 shrink-0 rounded-md
                         bg-white/[0.05] border border-white/10
                         text-white/75 hover:text-white hover:bg-white/[0.10]
                         text-[12px] font-medium tracking-wide
                         transition-colors"
            >
              Go
            </button>
          </div>
        )}

        {/* Webview placeholder — the child Tauri Webview overlays this
            div via setPosition/setSize. The bg-black underneath is what
            shows briefly before the page paints, and again behind any
            transparent areas of the loaded site. */}
        <div ref={placeholderRef} className="flex-1 bg-black rounded-b-2xl" />
      </div>
    </div>

    {/* Floating pill — visible only when minimized. Bottom-right of
        the viewport, above everything else. Click anywhere on the
        pill body to restore the popup; the inline X button closes
        without restoring (so the user can finish the OAuth flow
        out-of-band and just dismiss the leftover popup). */}
    {minimized && (
      <button
        type="button"
        onClick={restore}
        aria-label="Restore popup"
        className="fixed bottom-4 right-4 z-[270] glass-panel-elevated
                   rounded-full px-4 py-2.5 flex items-center gap-3
                   text-left shadow-glass-edge hover:bg-white/[0.06]
                   transition-colors max-w-[min(420px,80vw)]"
      >
        <span className="text-white/85 text-sm font-medium truncate">
          {active.title}
        </span>
        {active.oauth?.userCode && (
          <span
            className="text-[12px] font-mono tracking-[0.18em] px-2 py-0.5
                       rounded-md bg-amber-500/15 text-amber-200 border border-amber-400/30
                       shrink-0 select-all"
            onClick={(e) => e.stopPropagation()}
            title="Device-flow code. Click the pill to restore the popup; this chip stays selectable so you can copy without expanding."
          >
            {active.oauth.userCode}
          </span>
        )}
        <span
          role="button"
          aria-label="Close"
          onClick={(e) => { e.stopPropagation(); close(); }}
          className="w-6 h-6 rounded-full flex items-center justify-center
                     text-white/55 hover:text-white hover:bg-white/10 shrink-0 cursor-pointer"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </span>
      </button>
    )}
    </>
  );
}
