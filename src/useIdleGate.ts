// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// useIdleGatedInterval — a setInterval that respects the window-hidden state
// from the windowVisibility store, so non-critical pollers stop wasting CPU /
// network while the app is minimized or in the tray.
//
// Behaviour by default: the interval is PAUSED while the window is hidden and
// resumes at its normal cadence on restore (visible-only UI pollers).
//
// For the release / notification cloud pipeline the user explicitly wants
// polling to CONTINUE while hidden (so new releases are caught and ready on
// restore): pass { keepWhileHidden: true, hiddenMs } to run at a slower
// cadence while hidden, and { runOnResume: true } to fire one immediate
// catch-up the moment the window becomes visible again.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { useWindowHidden } from "./windowVisibility";

export interface IdleGateOptions {
  /** Keep firing while hidden (at `hiddenMs`) instead of pausing. */
  keepWhileHidden?: boolean;
  /** Cadence while hidden when `keepWhileHidden` is set. Defaults to `ms`. */
  hiddenMs?: number;
  /** Fire the callback once immediately when the window becomes visible again. */
  runOnResume?: boolean;
}

export function useIdleGatedInterval(
  callback: () => void,
  ms: number,
  opts: IdleGateOptions = {},
): void {
  const { keepWhileHidden = false, hiddenMs, runOnResume = false } = opts;
  const hidden = useWindowHidden();

  // Keep the latest callback without re-arming the interval every render.
  const cbRef = useRef(callback);
  useEffect(() => {
    cbRef.current = callback;
  }, [callback]);

  // Timestamp of the last actual run, so the resume catch-up can't be spammed
  // by rapid minimize -> restore cycles.
  const lastRunRef = useRef(0);
  const run = () => {
    lastRunRef.current = Date.now();
    cbRef.current();
  };

  useEffect(() => {
    // Fully paused while hidden unless we are told to keep going.
    if (hidden && !keepWhileHidden) return;
    const period = hidden ? (hiddenMs ?? ms) : ms;
    const id = window.setInterval(run, period);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, keepWhileHidden, hiddenMs, ms]);

  // Catch-up on the hidden -> visible transition, but ONLY if a normal interval
  // would already be due. A quick minimize -> restore (well under `ms`) leaves
  // lastRun recent, so it won't re-fire the poll — no request spam from
  // flapping the window.
  const wasHiddenRef = useRef(hidden);
  useEffect(() => {
    const wasHidden = wasHiddenRef.current;
    wasHiddenRef.current = hidden;
    if (wasHidden && !hidden && runOnResume && Date.now() - lastRunRef.current >= ms) {
      run();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, runOnResume]);
}
