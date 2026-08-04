// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { cancelScrobbleRun, useScrobbleRun } from "./scrobbleRun";

// ---------------------------------------------------------------------------
// ScrobbleClosePrompt — "you're closing mid-scrobble, what do you want to do?"
//
// Rust's CloseRequested handler refuses the close while a bulk run is in flight
// (scrobble::scrobble_run_active) and emits `aura:scrobble-close-request`. This
// component answers it. Every exit path MUST clear the Rust flag before
// re-issuing the close, or the guard would refuse that one too and the window
// would become unclosable.
//
// Three ways out:
//   • Finish first  — keep the run going, show its progress HERE (the usual
//     floating bar is suppressed while this is up), close automatically the
//     moment it completes.
//   • Stop and close — interrupt the run and close immediately.
//   • Keep Aura open — dismiss; the floating bar comes back.
// ---------------------------------------------------------------------------

/** Clear the Rust guard, then close for real. Without the clear, CloseRequested
 *  would just bounce us straight back to this prompt. */
async function releaseAndClose(): Promise<void> {
  try {
    await invoke("set_scrobble_run_active", { active: false });
  } catch {
    // If the mirror call fails the guard may still be set and the close would be
    // refused. Fall through and try anyway — a destroy() bypasses CloseRequested.
  }
  try {
    await getCurrentWindow().close();
  } catch {
    await getCurrentWindow().destroy();
  }
}

export default function ScrobbleClosePrompt({
  onOpenChange,
}: {
  /** Lets App suppress the floating progress bar while this prompt owns the screen. */
  onOpenChange: (open: boolean) => void;
}) {
  const run = useScrobbleRun();
  const [open, setOpen] = useState(false);
  /** The user chose "finish first" — close as soon as the run ends. */
  const [waiting, setWaiting] = useState(false);
  const waitingRef = useRef(false);

  useEffect(() => { onOpenChange(open); }, [open, onOpenChange]);

  useEffect(() => {
    const un = listen("aura:scrobble-close-request", () => setOpen(true));
    return () => { void un.then((f) => f()); };
  }, []);

  // The run finished while the user was waiting on it — honour the close.
  useEffect(() => {
    if (waitingRef.current && !run.running) {
      waitingRef.current = false;
      void releaseAndClose();
    }
  }, [run.running]);

  // If the run ends on its own while the prompt is up but the user hasn't chosen
  // anything, there is nothing left to warn about: just dismiss.
  useEffect(() => {
    if (open && !run.running && !waitingRef.current) setOpen(false);
  }, [open, run.running]);

  const finishFirst = useCallback(() => {
    waitingRef.current = true;
    setWaiting(true);
  }, []);

  const stopAndClose = useCallback(() => {
    cancelScrobbleRun();
    void releaseAndClose();
  }, []);

  const keepOpen = useCallback(() => {
    waitingRef.current = false;
    setWaiting(false);
    setOpen(false);
    // Backing out must also disarm any pending FORCE QUIT. This prompt can be
    // raised by a press-and-hold on the close button (a deliberate "quit even
    // though tray mode is on"), and Rust keeps that flag armed across the
    // prompt so the "finish" / "stop and close" paths still quit rather than
    // silently hiding. Cancelling here is what stops the flag leaking into the
    // NEXT ordinary X click, which would then quit instead of minimising.
    void invoke("cancel_quit").catch(() => {});
  }, []);

  if (!open) return null;

  const pct = Math.round((run.done / Math.max(1, run.total)) * 100);

  return (
    <div className="aura-modal-backdrop-in fixed inset-0 z-[400] flex items-center justify-center
                    bg-black/70 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Scrobble in progress"
        className="aura-modal-card-in glass-panel-elevated rounded-3xl px-7 py-6 w-full max-w-[460px] mx-4
                   shadow-glass-edge flex flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-lg font-semibold tracking-tight">
            Still scrobbling
          </h2>
          <p className="text-white/70 text-sm leading-relaxed">
            {waiting
              ? "Finishing up — Aura will close as soon as this is done."
              : "A scrobble is still running. Closing now would leave it half-finished."}
          </p>
        </div>

        {/* This prompt owns the progress readout while it is up; the floating bar
            is suppressed so there are never two of them on screen. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs font-mono tabular-nums">
            <span className="text-white/85">
              {run.backingOff ? "Rate limited — retrying" : "Scrobbling"} {run.done}/{run.total}
            </span>
            <span className="text-white/40">
              {run.failed > 0 ? `${run.failed} failed` : `${pct}%`}
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full transition-[width] duration-200 ${run.backingOff ? "bg-amber-400" : "bg-ln-accent"}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 flex-wrap">
          {!waiting && (
            <button
              type="button"
              onClick={keepOpen}
              className="px-4 py-1.5 rounded-full text-xs font-medium
                         bg-white/5 text-white/70 border border-white/15
                         hover:bg-white/12 hover:text-white transition-colors"
            >
              Keep Aura open
            </button>
          )}
          <button
            type="button"
            onClick={stopAndClose}
            className="px-4 py-1.5 rounded-full text-xs font-medium
                       bg-white/5 text-white/70 border border-white/15
                       hover:bg-rose-500/20 hover:text-rose-200 hover:border-rose-300/40
                       transition-colors"
          >
            Stop and close
          </button>
          {!waiting && (
            <button
              type="button"
              autoFocus
              onClick={finishFirst}
              className="px-4 py-1.5 rounded-full text-xs font-semibold border
                         bg-ln-accent text-black border-ln-accent
                         hover:brightness-110 transition-all"
            >
              Finish, then close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
