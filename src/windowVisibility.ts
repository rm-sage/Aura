// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// windowVisibility — single source of truth for the window's focus + hidden
// state, used to drive the idle/tray power-down (pause polls, throttle work,
// suspend decorative animations) without every consumer wiring its own
// listeners.
//
// Two distinct signals, deliberately separate:
//   • hidden  — the window is MINIMIZED or otherwise not visible
//               (document.hidden OR Tauri is_minimized). This is the signal
//               for AGGRESSIVE power-down: slow/pause non-critical polls,
//               throttle background work. It is NOT set by mere unfocus, so
//               an unfocused-but-visible Aura keeps running normally (Aura no
//               longer pauses on focus loss).
//   • focused — the OS window has focus. Used (with hidden) only to suspend
//               purely-decorative CSS animations via `data-aura-idle`.
//
// Tauri is authoritative for minimize on Windows: a borderless WebView2 does
// not always fire `visibilitychange` on minimize, so we also poll
// `is_minimized()` on every resize. Listeners are process-lifetime (singleton
// store) so they are never torn down.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

let docHidden = typeof document !== "undefined" ? document.hidden : false;
let minimized = false;
let focused = typeof document !== "undefined" ? document.hasFocus() : true;
let hidden = docHidden || minimized;

const subscribers = new Set<() => void>();

function emit(): void {
  for (const cb of subscribers) cb();
}

function recomputeHidden(): void {
  const next = docHidden || minimized;
  if (next !== hidden) {
    hidden = next;
    emit();
  }
}

function setFocused(next: boolean): void {
  if (next !== focused) {
    focused = next;
    emit();
  }
}

let inited = false;
function ensureInit(): void {
  if (inited || typeof window === "undefined") return;
  inited = true;

  document.addEventListener("visibilitychange", () => {
    docHidden = document.hidden;
    recomputeHidden();
  });
  window.addEventListener("blur", () => setFocused(false));
  window.addEventListener("focus", () => setFocused(true));

  // Tauri window events (authoritative for a borderless WebView2 on Windows).
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      // Last-request-wins guard. Close-to-tray used to fire NO resize events
      // at all; now that the hide leaves the window minimized it fires at least
      // two in quick succession (minimize on the way out, restore on the way
      // back), each starting its own isMinimized() IPC. If the minimize-time
      // response resolves AFTER the restore-time one, `minimized` latches true
      // while the window is plainly visible and `hidden` never clears again.
      // That failure is silent and total: countdowns stop ticking, the sync
      // pull stops, cast polling stops, auto-advance freezes.
      let minSeq = 0;
      const syncMinimized = () => {
        const seq = ++minSeq;
        w.isMinimized()
          .then((m) => {
            if (seq !== minSeq) return;
            minimized = m;
            recomputeHidden();
          })
          .catch(() => {});
      };
      void w.onResized(syncMinimized).catch(() => {});
      // Focus changes resync as well. Nothing else re-polls the minimize state,
      // so a single dropped resize event would leave `hidden` latched with no
      // self-healing path. A restore delivers its focus change after the
      // restore has landed, which makes this a reliable backstop.
      void w
        .onFocusChanged(({ payload }) => {
          setFocused(!!payload);
          syncMinimized();
        })
        .catch(() => {});
      syncMinimized();
    })
    .catch(() => {});
}

/** True when the window is minimized / not visible (NOT merely unfocused).
 *  The signal for aggressive power-down. Safe to call from non-React code. */
export function isWindowHidden(): boolean {
  ensureInit();
  return hidden;
}

/** True when the OS window has focus. */
export function isWindowFocused(): boolean {
  ensureInit();
  return focused;
}

/** Subscribe to any focus/hidden change. Returns an unsubscribe fn. */
export function subscribeWindowVisibility(cb: () => void): () => void {
  ensureInit();
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Re-renders the caller when the hidden (minimized) state changes. */
export function useWindowHidden(): boolean {
  return useSyncExternalStore(subscribeWindowVisibility, isWindowHidden, isWindowHidden);
}

/** Re-renders the caller when window focus changes. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribeWindowVisibility, isWindowFocused, isWindowFocused);
}
