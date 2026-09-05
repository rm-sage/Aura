// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pauseAllDownloads, useDownloads } from "./downloadsStore";

// ---------------------------------------------------------------------------
// DownloadsClosePrompt: "you are closing with downloads running".
//
// Rust's CloseRequested handler refuses the close while any job is active and
// emits `aura:downloads-close-request`. Modelled on ScrobbleClosePrompt, which
// answers the same shape of gate.
//
// TWO things here are load-bearing and were both got wrong first time round:
//
// 1. EVERY dismiss path must call `cancel_quit`. The Rust gate deliberately
//    leaves FORCE_QUIT armed when it refuses (a force-quit's follow-up close
//    has to still quit rather than fall back to hiding), so it relies on this
//    prompt to disarm it. Backing out without disarming means the NEXT ordinary
//    click on the X fully exits instead of minimising to tray, long after the
//    downloads have finished and with no prompt to explain it.
//
// 2. Quitting has to reach a state where `active_count()` is ZERO, or the
//    re-issued close is refused again and the window cannot be closed at all.
//    A single-pass HLS remux cannot be paused, so for it "stop" can only mean
//    cancel; the copy below says so rather than promising to keep work it is
//    about to destroy.
// ---------------------------------------------------------------------------

interface CloseRequest {
  active: number;
  unpausable: number;
}

/** Disarm the force-quit the gate left armed, then dismiss. */
async function keepOpen(): Promise<void> {
  try {
    await invoke("cancel_quit");
  } catch {
    // Nothing useful to do: the flag lives in Rust and a failed clear only
    // means the next close behaves as a quit. Not worth a dialog.
  }
}

async function closeForReal(): Promise<void> {
  try {
    await getCurrentWindow().close();
  } catch {
    await getCurrentWindow().destroy();
  }
}

export default function DownloadsClosePrompt() {
  const [open, setOpen] = useState(false);
  const [req, setReq] = useState<CloseRequest>({ active: 0, unpausable: 0 });
  const [busy, setBusy] = useState(false);
  const { active } = useDownloads();

  useEffect(() => {
    const un = listen<CloseRequest | number>("aura:downloads-close-request", (e) => {
      const p = e.payload;
      setReq(
        typeof p === "number"
          ? { active: p, unpausable: 0 }
          : { active: p?.active ?? 0, unpausable: p?.unpausable ?? 0 },
      );
      // A re-fired request means a previous attempt did not get us out. Clear
      // `busy` so the buttons work again rather than staying disabled with the
      // primary stuck reading "Stopping".
      setBusy(false);
      setOpen(true);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const dismiss = useCallback(() => {
    setBusy(false);
    setOpen(false);
    void keepOpen();
  }, []);

  const quit = useCallback(async () => {
    setBusy(true);
    // Park everything first. A worker stops at its next select, so this is a
    // matter of one chunk, not one file. Anything that cannot be paused is
    // cancelled, because the alternative is a window that will not close.
    await pauseAllDownloads();
    await closeForReal();
    // Only reached if the close was refused anyway. Re-enable rather than
    // leaving the user staring at two dead buttons.
    setBusy(false);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open || busy) return;
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, busy, dismiss]);

  if (!open) return null;

  const n = req.active || active;
  const noun = n === 1 ? "download is" : "downloads are";
  const lost = req.unpausable;

  return (
    <div
      className="aura-modal-backdrop-in fixed inset-0 z-[10600] flex items-center justify-center
                 bg-black/60 backdrop-blur-sm"
      onClick={() => !busy && dismiss()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Downloads in progress"
        className="aura-modal-card-in glass-panel-elevated rounded-3xl px-7 py-6 w-full
                   max-w-[460px] mx-4 shadow-glass-edge flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-lg font-semibold tracking-tight">
            {n} {noun} still running
          </h2>
          <p className="text-white/70 text-sm leading-relaxed">
            {lost > 0
              ? `Quitting pauses them and keeps what has downloaded so far, except for ${
                  lost === 1 ? "one that is" : `${lost} that are`
                } being reassembled in a single pass and cannot be paused. ${
                  lost === 1 ? "That one" : "Those"
                } will be cancelled.`
              : "Quitting now pauses them and keeps what has downloaded so far."}
          </p>
          <p className="text-white/40 text-[12.5px] leading-relaxed">
            Paused downloads will be waiting the next time you open Aura. Links
            from some sources expire, and Aura refreshes those on its own when
            you resume.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={dismiss}
            className="px-4 py-1.5 rounded-full text-xs font-medium
                       bg-white/5 text-white/70 border border-white/15
                       hover:bg-white/12 hover:text-white transition-colors
                       disabled:opacity-50"
          >
            Keep Aura open
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void quit()}
            className={`px-4 py-1.5 rounded-full text-xs font-semibold border
                        transition-all disabled:opacity-60 ${
                          lost > 0
                            ? "bg-rose-500/85 text-white border-rose-300/50 hover:bg-rose-500"
                            : "bg-ln-accent text-black border-ln-accent hover:brightness-110"
                        }`}
          >
            {busy ? "Stopping" : lost > 0 ? "Stop and quit" : "Pause and quit"}
          </button>
        </div>
      </div>
    </div>
  );
}
