// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// playbackClock: the playhead (mpv `time-pos`, seconds) as a tiny external
// store instead of App state.
//
// mpv reports the position about 30 times a second. Held in App's state, every
// tick re-rendered App and everything it did not explicitly shield (the page
// under the player, the rail, the hosts). Here only what actually shows the
// position subscribes: PlayerOverlay (the scrubber and the clock), the Next-Up
// card's notes, and App's per-tick logic, which runs as a subscription
// (`usePlaybackClock`) and only sets state when its answer changes.
//
// The one writer is usePlayback (App.tsx): every owned `playback-update` tick,
// and 0 on a fresh load. Nothing else writes it.

import { useEffect, useSyncExternalStore } from "react";
import type { DependencyList, ReactNode } from "react";

let current = 0;
const listeners = new Set<() => void>();

/** The current playhead, in seconds. */
export function getPlaybackTime(): number {
  return current;
}

/** Sets the playhead and notifies subscribers (only when it changed). */
export function setPlaybackTime(t: number): void {
  if (t === current || Number.isNaN(t)) return;
  current = t;
  for (const l of [...listeners]) l();
}

export function subscribePlaybackTime(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** A ref-shaped live view of the playhead, for code written against a
 *  `{ current }` mirror. Read-only. */
export const playbackTimeRef: { readonly current: number } = {
  get current() { return current; },
};

/** The playhead as render input: the calling component re-renders on every
 *  tick. Keep it to components that draw the position. */
export function usePlaybackTime(): number {
  return useSyncExternalStore(subscribePlaybackTime, getPlaybackTime);
}

/**
 * Runs `onTime` the way a `useEffect` with the playhead in its deps used to
 * run: once when mounted or when `deps` change, then on every tick that
 * changes the (optionally `map`ped) position. Never re-renders the caller.
 * `onTime` sees the render's other values through its closure, exactly as an
 * effect did; it must not return a cleanup.
 */
export function usePlaybackClock(
  onTime: (t: number) => void,
  deps: DependencyList,
  map?: (t: number) => number,
): void {
  useEffect(() => {
    const read = () => (map ? map(current) : current);
    let last = read();
    onTime(last);
    return subscribePlaybackTime(() => {
      const t = read();
      if (t === last) return;
      last = t;
      onTime(t);
    });
    // The caller's deps ARE the dependency list (as for useEffect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/** Render prop for a piece of a larger component that shows the position:
 *  only this subtree re-renders per tick. */
export function PlaybackTimeView({ children }: { children: (time: number) => ReactNode }) {
  const time = usePlaybackTime();
  return <>{children(time)}</>;
}
