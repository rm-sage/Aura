// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { reducedMotionActive } from "./glassStyle";

// ---------------------------------------------------------------------------
// AppToast: global toast surface for non-player surfaces (Settings, Addons,
// Library, OAuth flows, etc.). The PlayerOverlay has its own in-player toast
// (FlyUpToast) anchored at the click location for volume / skip / pause
// feedback; that one is unchanged. This host renders at top-centre of the
// viewport so non-player toasts are immediately visible from any tab, with
// a brief flash + glow on entry to draw the eye.
//
// Trigger from any component via `showAppToast("message")`. The host below
// listens for the matching event and stacks up to MAX_VISIBLE toasts at a
// time. Older ones drop off the bottom as new ones arrive at the top.
//
// A toast that repeats one still on screen (same message, tone and scope)
// never stacks a copy: the visible one restarts its timer, plays a short
// "again" bump (playRepeat) and shows a quiet repeat count (x2, x3).
// ---------------------------------------------------------------------------

const EVENT = "aura:app-toast";
const DISMISS_EVENT = "aura:app-toast-dismiss";
const MAX_VISIBLE = 3;
/** The quick fade a scoped dismiss plays (opacity only, so it is the same
 *  under reduced motion: a fade is not motion). */
const DISMISS_FADE_MS = 150;
/** Default visible duration. Bumped from the original 2.2s so users have
 *  comfortable read time on multi-line messages. The flash + glow on entry
 *  draws attention quickly; the longer dwell prevents a glance-away from
 *  missing the content. */
const DEFAULT_DURATION_MS = 4500;
/** The glass paint rule's own shadow list (App.css GLASS SYSTEM). Every flash
 *  keyframe carries it after the halo, so the halo interpolates and the glass
 *  edge and drop survive the animation's fill. PartyToast and FlyUpToast
 *  carry it in their entry flashes too. */
export const GLASS_SHADOW ="var(--lg-ring), var(--lg-rimlight), var(--lg-edge), var(--lg-drop)";

export type ToastTone = "default" | "success" | "danger";

interface ShowOptions {
  /** Auto-dismiss timeout in ms. Default DEFAULT_DURATION_MS (4500). */
  duration?: number;
  /** Visual tone. Default and success glow in the theme accent on entry and
   *  on a repeat; danger glows red and keeps a faint red hairline. */
  tone?: ToastTone;
  /** The page or feature the toast confirms something on. A toast with a
   *  scope fades out early when `dismissAppToasts(scope)` is called (Settings
   *  calls it when the page is left, so "Settings saved" does not sit over
   *  the next page's search bar). Unscoped toasts are never dismissed early. */
  scope?: string;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
  scope?: string;
  /** Set by a scoped dismiss: the toast is playing its fade-out. */
  leaving?: boolean;
  /** How many times this toast has been raised while visible (1 = once). */
  count?: number;
  /** Host order of the latest raise: eviction drops the stalest toast, so a
   *  just-repeated one is never the one pushed out. */
  shownSeq?: number;
}

let nextId = 1;

/** Trigger a toast from anywhere in the React tree.
 *
 *  Stays available even before AppToastHost mounts: events are fired
 *  immediately, dropped silently if no host is listening yet (which only
 *  happens during the first render of the app shell). */
export function showAppToast(message: string, opts?: ShowOptions) {
  if (!message) return;
  window.dispatchEvent(
    new CustomEvent<ToastEntry>(EVENT, {
      detail: {
        id: nextId++,
        message,
        tone: opts?.tone ?? "default",
        duration: Math.max(800, opts?.duration ?? DEFAULT_DURATION_MS),
        scope: opts?.scope,
      },
    }),
  );
}

/** Fade out, quickly, every visible toast raised with `scope`. Toasts from
 *  other features (other scopes, or none) are untouched. */
export function dismissAppToasts(scope: string) {
  if (!scope) return;
  window.dispatchEvent(new CustomEvent<{ scope: string }>(DISMISS_EVENT, { detail: { scope } }));
}

/** Screen-reader announcements for a toast host: ONE always-mounted live
 *  region (plus an alert region for errors), written on every raise or bump.
 *  A role="status" element inserted with its text already inside is not
 *  reliably read (the NotificationsBell note), so the toasts themselves are
 *  not live regions. Each write clears the region first and sets the text a
 *  beat later, so the same message raised again is announced again. Shared by
 *  AppToastHost, PartyToastHost and FlyUpToastHost; `announce` is stable. */
export function useLiveAnnouncer(): {
  announce: (text: string, urgent?: boolean) => void;
  regions: React.ReactNode;
} {
  const [polite, setPolite] = useState("");
  const [alert, setAlert] = useState("");
  // Per region: the text waiting for its write, so two raises inside the
  // beat are both read (joined) rather than the second replacing the first.
  const pending = useRef<{ polite: string[]; alert: string[] }>({ polite: [], alert: [] });
  const timers = useRef<{ polite: number | null; alert: number | null }>({ polite: null, alert: null });
  useEffect(() => () => {
    for (const t of [timers.current.polite, timers.current.alert]) {
      if (t !== null) window.clearTimeout(t);
    }
  }, []);
  const announce = useCallback((text: string, urgent?: boolean) => {
    const key = urgent ? "alert" : "polite";
    const set = urgent ? setAlert : setPolite;
    pending.current[key].push(text);
    if (timers.current[key] !== null) return;
    set("");
    timers.current[key] = window.setTimeout(() => {
      timers.current[key] = null;
      const lines = pending.current[key];
      pending.current[key] = [];
      set(lines.join(". "));
    }, 60);
  }, []);
  const regions = (
    <>
      <div className="sr-only" role="status" aria-live="polite">{polite}</div>
      <div className="sr-only" role="alert" aria-live="assertive">{alert}</div>
    </>
  );
  return { announce, regions };
}

function AppToastHost() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const { announce, regions } = useLiveAnnouncer();

  useEffect(() => {
    // The host's own model, updated synchronously by every event and timer
    // and published to React as a copy. Two raises in the same tick (before
    // a render) still see each other, so a repeat can never stack a copy.
    let live: ToastEntry[] = [];
    let seq = 0;
    const commit = () => setToasts(live.slice());
    // One removal timer per toast id: its auto-dismiss (restarted by a
    // repeat), or replaced by the short fade timer on a scoped dismiss. An
    // evicted toast's timer is cleared with it. All cleared on unmount.
    const timers = new Map<number, number>();
    const clearTimer = (id: number) => {
      const old = timers.get(id);
      if (old !== undefined) window.clearTimeout(old);
      timers.delete(id);
    };
    const removeLater = (id: number, ms: number) => {
      clearTimer(id);
      timers.set(id, window.setTimeout(() => {
        timers.delete(id);
        live = live.filter((t) => t.id !== id);
        commit();
      }, ms));
    };
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<ToastEntry>).detail;
      if (!detail) return;
      // Same message, tone and scope, and not already fading out: bump the
      // visible one instead of stacking a copy. A toast mid scoped-dismiss
      // is left to finish its fade and a fresh one is raised.
      const same = live.find((t) => !t.leaving
        && t.message === detail.message && t.tone === detail.tone && t.scope === detail.scope);
      if (same) {
        const bumped: ToastEntry = {
          ...same,
          duration: detail.duration,
          count: (same.count ?? 1) + 1,
          shownSeq: ++seq,
        };
        live = live.map((t) => (t.id === same.id ? bumped : t));
        commit();
        removeLater(same.id, detail.duration);
        announce(`${detail.message}, ${bumped.count} times`, detail.tone === "danger");
        return;
      }
      live = [...live, { ...detail, count: 1, shownSeq: ++seq }];
      announce(detail.message, detail.tone === "danger");
      // Over the cap: drop a fading toast first, else the stalest raise.
      while (live.length > MAX_VISIBLE) {
        let drop = live[0];
        for (const t of live) {
          const rank = (x: ToastEntry) => (x.leaving ? -1 : x.shownSeq ?? 0);
          if (rank(t) < rank(drop)) drop = t;
        }
        clearTimer(drop.id);
        live = live.filter((t) => t.id !== drop.id);
      }
      commit();
      // Auto-remove after the toast's own duration.
      removeLater(detail.id, detail.duration);
    };
    const onDismiss = (e: Event) => {
      const scope = (e as CustomEvent<{ scope: string }>).detail?.scope;
      if (!scope) return;
      const ids = live.filter((t) => t.scope === scope && !t.leaving).map((t) => t.id);
      if (ids.length === 0) return;
      const fading = new Set(ids);
      live = live.map((t) => (fading.has(t.id) ? { ...t, leaving: true } : t));
      commit();
      for (const id of ids) removeLater(id, DISMISS_FADE_MS);
    };
    window.addEventListener(EVENT, onShow);
    window.addEventListener(DISMISS_EVENT, onDismiss);
    return () => {
      window.removeEventListener(EVENT, onShow);
      window.removeEventListener(DISMISS_EVENT, onDismiss);
      for (const t of timers.values()) window.clearTimeout(t);
      timers.clear();
    };
  }, [announce]);

  if (toasts.length === 0) return <>{regions}</>;

  return (
    <>
    {regions}
    <div
      className="aura-app-toast-host fixed left-1/2 -translate-x-1/2 z-[300] flex flex-col items-center gap-2 pointer-events-none"
      style={{
        // Top-centre, sat below the title bar (36px) with a small
        // gutter. Player overlay's FlyUpToast tracks the cursor so
        // they don't collide; if both happen to render together,
        // FlyUpToast at z-[250] sits behind this z-[300] surface.
        // While the rail's Notifications sheet is open the host lifts
        // over it (styles/glass-notify.css): its own actions raise toasts.
        top: 56,
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
      <style>{`
        @keyframes aura-app-toast-out {
          from { opacity: 1; }
          to   { opacity: 0; }
        }
        /* The entry flash glows in the THEME accent (default and success
           toasts): var() in keyframes resolves on the toast itself, so a
           theme switch is honoured. Only an error toast flashes red. */
        @keyframes aura-app-toast-flash {
          0%   { opacity: 0; transform: translateY(-12px) scale(0.94);
                 box-shadow: 0 0 0 0 rgb(var(--ln-accent-rgb) / 0), 0 0 0 0 rgb(var(--ln-accent-rgb) / 0), ${GLASS_SHADOW}; }
          18%  { opacity: 1; transform: translateY(0)     scale(1.04);
                 box-shadow: 0 8px 24px -4px rgb(var(--ln-accent-rgb) / 0.55),
                             0 0 0 6px rgb(var(--ln-accent-rgb) / 0.18), ${GLASS_SHADOW}; }
          32%  { transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgb(var(--ln-accent-rgb) / 0.40),
                             0 0 0 0 rgb(var(--ln-accent-rgb) / 0), ${GLASS_SHADOW}; }
          100% { opacity: 1; transform: translateY(0) scale(1);
                 box-shadow: 0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 0 rgba(0, 0, 0, 0), ${GLASS_SHADOW}; }
        }
        @keyframes aura-app-toast-flash-danger {
          0%   { opacity: 0; transform: translateY(-12px) scale(0.94);
                 box-shadow: 0 0 0 0 rgba(251, 113, 133, 0), 0 0 0 0 rgba(251, 113, 133, 0), ${GLASS_SHADOW}; }
          18%  { opacity: 1; transform: translateY(0)     scale(1.04);
                 box-shadow: 0 8px 24px -4px rgba(251, 113, 133, 0.55),
                             0 0 0 6px rgba(251, 113, 133, 0.18), ${GLASS_SHADOW}; }
          32%  { transform: translateY(0) scale(1);
                 box-shadow: 0 8px 24px -4px rgba(251, 113, 133, 0.40),
                             0 0 0 0 rgba(251, 113, 133, 0), ${GLASS_SHADOW}; }
          100% { opacity: 1; transform: translateY(0) scale(1);
                 box-shadow: 0 0 0 0 rgba(0, 0, 0, 0), 0 0 0 0 rgba(0, 0, 0, 0), ${GLASS_SHADOW}; }
        }
        /* The repeat count: a fade beside a spring pop (a spring token is
           never put on opacity). Under reduced motion the spring tokens
           collapse, so it only fades. Keyed by the count, so each repeat
           replays it. */
        @keyframes aura-app-toast-count-fade { from { opacity: 0; } }
        @keyframes aura-app-toast-count-pop { from { scale: 0.55; } }
        .aura-app-toast-count {
          animation:
            aura-app-toast-count-fade 160ms ease-out backwards,
            aura-app-toast-count-pop var(--aura-spring-bouncy-dur) var(--aura-spring-bouncy) backwards;
        }
      `}</style>
    </div>
    </>
  );
}

/** The repeat bump's length: a quick rise, then the bouncy spring settles. */
const REPEAT_MS = 360;
/** An error toast's halo (the entry flash's red). */
const DANGER_RGB = "251 113 133";
/** The base theme's accent, if a theme somehow leaves the token unset. */
const FALLBACK_ACCENT_RGB = "91 164 255";

/** The halo colour as an "r g b" triplet: red for an error toast, else the
 *  CURRENT theme accent (`--ln-accent-rgb`), read when the bump starts so a
 *  theme switch between repeats is honoured. Resolved to concrete numbers
 *  rather than handed to WAAPI as var(), so the keyframes never depend on
 *  how the engine substitutes a custom property inside an animated value. */
function haloRgb(el: HTMLElement, tone: ToastTone): string {
  if (tone === "danger") return DANGER_RGB;
  const v = getComputedStyle(el).getPropertyValue("--ln-accent-rgb").trim();
  return /^\d{1,3}\s+\d{1,3}\s+\d{1,3}$/.test(v) ? v : FALLBACK_ACCENT_RGB;
}

/** The "it happened again" cue on a visible toast: a small spring bump
 *  (scale 1 to 1.035 and back, landing on the bouncy spring), a brief white
 *  lift through the glass `--lg-lift` hook and a faint halo in the theme
 *  accent (red for an error toast, see haloRgb), together
 *  360 ms. Reduced motion keeps only the lift and halo (brightness, no
 *  motion). While the entry flash still runs the bump is skipped (the entry
 *  is already scaling). Every box-shadow frame carries the glass list.
 *  Returns the animations so the caller can cancel them. */
/** The repeat bump, also played by the notification arrival bubble on a merge
 *  (NotificationsBell.tsx). */
export function playRepeat(el: HTMLElement, tone: ToastTone): Animation[] {
  if (typeof el.animate !== "function") return [];
  const rgb = haloRgb(el, tone);
  const rest = `0 0 0 0 rgb(${rgb} / 0), 0 0 0 0 rgb(${rgb} / 0), ${GLASS_SHADOW}`;
  const peak = `0 8px 24px -4px rgb(${rgb} / 0.40), 0 0 0 4px rgb(${rgb} / 0.14), ${GLASS_SHADOW}`;
  const anims: Animation[] = [];
  try {
    anims.push(el.animate([
      { boxShadow: rest, "--lg-lift": 0, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)" },
      { boxShadow: peak, "--lg-lift": 0.08, offset: 0.22, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
      { boxShadow: rest, "--lg-lift": 0 },
    ], { duration: REPEAT_MS }));
    const entering = el.getAnimations().some((a) => "animationName" in a && a.playState === "running");
    if (!reducedMotionActive() && !entering) {
      const spring = getComputedStyle(document.documentElement)
        .getPropertyValue("--aura-spring-bouncy").trim() || "cubic-bezier(0.34, 1.4, 0.64, 1)";
      const frames = (settle: string): Keyframe[] => [
        { scale: "1", easing: "cubic-bezier(0.3, 0.7, 0.4, 1)" },
        { scale: "1.035", offset: 0.2, easing: settle },
        { scale: "1" },
      ];
      try {
        anims.push(el.animate(frames(spring), { duration: REPEAT_MS }));
      } catch {
        // An easing this engine cannot parse: a plain overshoot instead.
        anims.push(el.animate(frames("cubic-bezier(0.34, 1.4, 0.64, 1)"), { duration: REPEAT_MS }));
      }
    }
  } catch {
    // No WAAPI support for a value: the count badge still marks the repeat.
  }
  return anims;
}

function ToastItem({ toast }: { toast: ToastEntry }) {
  const elRef = useRef<HTMLDivElement>(null);
  const count = toast.count ?? 1;
  // Each repeat replays the bump; a newer repeat cancels the running one
  // first (the cleanup), and unmounting cancels it too.
  useEffect(() => {
    const el = elRef.current;
    if (!el || count < 2 || toast.leaving) return;
    const anims = playRepeat(el, toast.tone);
    return () => {
      for (const a of anims) a.cancel();
    };
    // Only a new count replays: a scoped dismiss mid-bump lets it finish
    // under the fade instead of snapping the halo away.
  }, [count]);

  // No persistent coloured hairline on a default or success toast: the
  // accent ring read as a line of theme colour round the edge for the whole
  // dwell ("would look better if it weren't there"), and the neutral glass
  // edge already defines the shape. The colour lives only in the entry
  // flash and the repeat halo. An error keeps its red hairline (semantic,
  // through the glass ring hook, src/styles/glass-settings.css).
  const toneRing = toast.tone === "danger" ? "aura-glass-tone-danger" : "";
  const animName = toast.tone === "danger" ? "aura-app-toast-flash-danger" : "aura-app-toast-flash";

  return (
    <div
      ref={elRef}
      // Not a live region: the host announces through useLiveAnnouncer.
      // The tooltip tier of the shared glass: cheap, never refracted.
      className={`aura-float-glass aura-glass-tip ${toneRing} ${toast.leaving ? "pointer-events-none" : "pointer-events-auto"} relative px-4 py-2.5 rounded-xl
                  text-white/90 text-[13px] tracking-wide leading-snug
                  min-w-[260px] max-w-[440px] text-center`}
      style={{
        // Flash entry: 520ms total. Longer than the old 220ms so the
        // glow halo registers; ramps to a quiet drop-shadow afterward
        // so multiple stacked toasts don't strobe. A scoped dismiss swaps
        // it for a short opacity-only fade (the host removes the toast
        // when the fade ends). The fill mode lives IN the shorthand: a
        // separate animationFillMode is reset to "none" when React rewrites
        // the shorthand on that swap, and the faded toast flashed back to
        // full opacity for the frames before its removal.
        animation: toast.leaving
          ? `aura-app-toast-out ${DISMISS_FADE_MS}ms ease-out both`
          : `${animName} 520ms cubic-bezier(0.22, 1, 0.36, 1) both`,
        // With a count, equal padding on BOTH sides makes room for the badge
        // at the right edge, so the centred message never shifts sideways
        // (a short one sits inside the min width and the toast keeps its size).
        ...(count > 1 ? { paddingInline: 40 } : null),
      }}
    >
      {toast.message}
      {count > 1 && (
        <>
          <span
            key={count}
            aria-hidden
            className="aura-app-toast-count absolute right-3.5 top-1/2 -translate-y-1/2 text-[11px] font-semibold tracking-normal tabular-nums text-white/55"
          >
            {"×"}{count}
          </span>
          <span className="sr-only">{`, ${count} times`}</span>
        </>
      )}
    </div>
  );
}

// Memoized: App renders this host with no props (or only primitives / its own
// stable state) and re-renders on every playback-update tick. The host is
// driven by its own state and store subscriptions, so skipping those renders
// changes nothing on screen.
export default memo(AppToastHost);
