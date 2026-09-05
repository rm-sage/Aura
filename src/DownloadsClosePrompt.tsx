// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pauseAllDownloads, useDownloads } from "./downloadsStore";

// ---------------------------------------------------------------------------
// DownloadsClosePrompt — "you are closing with downloads running".
//
// Rust's CloseRequested handler refuses the close while any job is active and
// emits `aura:downloads-close-request` with the count. Modelled on
// ScrobbleClosePrompt, which answers the same shape of gate.
//
// The release mechanism is the pleasant part: the Rust gate tests
// `downloads::active_count() > 0`, and pausing everything drives that to zero,
// so the re-issued close simply passes. There is no separate override flag to
// set and therefore none to leak, which is the failure mode that would make
// the window unclosable.
//
// Quitting keeps the partial files and the job list, so the next launch shows
// each one Paused and one click from resuming.
// ---------------------------------------------------------------------------

async function closeForReal(): Promise<void> {
  try {
    await getCurrentWindow().close();
  } catch {
    await getCurrentWindow().destroy();
  }
}

export default function DownloadsClosePrompt() {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const { active } = useDownloads();

  useEffect(() => {
    const un = listen<number>("aura:downloads-close-request", (e) => {
      setCount(typeof e.payload === "number" ? e.payload : 0);
      setOpen(true);
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);

  const quit = useCallback(async () => {
    setBusy(true);
    // Park everything first. A worker stops at its next select, so this is a
    // matter of one chunk, not one file.
    await pauseAllDownloads();
    await closeForReal();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!open) return;
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;

  const n = count || active;
  const noun = n === 1 ? "download is" : "downloads are";

  return (
    <div
      className="aura-modal-backdrop-in fixed inset-0 z-[10600] flex items-center justify-center
                 bg-black/60 backdrop-blur-sm"
      onClick={() => !busy && setOpen(false)}
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
            Quitting now pauses them and keeps what has downloaded so far.
          </p>
          <p className="text-white/40 text-[12.5px] leading-relaxed">
            They will be waiting, paused, the next time you open Aura. Links from
            some sources expire, and Aura will refresh those on its own when you
            resume.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => setOpen(false)}
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
            className="px-4 py-1.5 rounded-full text-xs font-semibold border
                       bg-ln-accent text-black border-ln-accent
                       hover:brightness-110 transition-all disabled:opacity-60"
          >
            {busy ? "Pausing…" : "Pause and quit"}
          </button>
        </div>
      </div>
    </div>
  );
}
