// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// ConfirmDialog — Aura's own confirmation modal.
//
// Replaces the native `window.confirm()`, which renders the WebView2 chrome
// dialog ("localhost:1420 says ..."): un-themable, anchored to the top of the
// window rather than centred, and a dead giveaway that the app is a webview.
//
// `useConfirm` keeps the imperative call shape of `confirm()` so the callers
// read the same way:
//
//     const { ask, dialog } = useConfirm();
//     if (!(await ask({ title: "...", message: "..." }))) return;
//     ...
//     return (<>{...}{dialog}</>);
//
// Escape / backdrop-click cancel; Enter confirms. The confirm button takes
// focus on open so a keyboard user can just hit Enter or Escape.
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  /** Primary line. The question being asked. */
  message?: string;
  /** Secondary line, for the arithmetic / caveats behind the question. */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button red — use it for anything destructive. */
  tone?: "accent" | "danger";
}

export function useConfirm(): {
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  dialog: React.ReactNode;
} {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  // The pending promise's resolver. Held in a ref rather than in state so that
  // settling it is never a side effect inside a state updater (which React may
  // invoke twice in StrictMode).
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  const ask = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        // A second ask while one is open would strand the first promise
        // forever; resolve it as a cancel before taking over.
        resolveRef.current?.(false);
        resolveRef.current = resolve;
        setOpts(o);
      }),
    [],
  );

  const close = useCallback((value: boolean) => {
    setOpts(null);
    const resolve = resolveRef.current;
    resolveRef.current = null;
    resolve?.(value);
  }, []);

  // A component that unmounts with a dialog open must not leave its awaiter
  // hanging.
  useEffect(() => () => resolveRef.current?.(false), []);

  const dialog = opts ? (
    <ConfirmDialog
      {...opts}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;

  return { ask, dialog };
}

// ---------------------------------------------------------------------------
// Singleton form — for callers that are not React components.
//
// `useConfirm` is a hook, so it cannot be reached from a context-menu item's
// onClick, an event-listener closure, or any other plain function. Those get
// `askConfirm()` instead, answered by the one <ConfirmDialogHost /> mounted
// near the app root. Same module-level global-setter shape as
// ContextMenu.tsx's `openContextMenu`, and for the same reason: the alternative
// is threading a prop through every level of the tree.
// ---------------------------------------------------------------------------

type HostState = { opts: ConfirmOptions; resolve: (v: boolean) => void };

let _confirmSetter: ((s: HostState | null) => void) | null = null;

/** Imperative confirm for non-component callers. Resolves false when no host
 *  is mounted, so a missing host degrades to "the user said no" rather than
 *  hanging the caller forever. */
export function askConfirm(opts: ConfirmOptions): Promise<boolean> {
  if (!_confirmSetter) {
    console.warn("[confirm] askConfirm called but no ConfirmDialogHost is mounted");
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    _confirmSetter?.({ opts, resolve });
  });
}

/** Mount once near the app root. */
export function ConfirmDialogHost() {
  const [state, setState] = useState<HostState | null>(null);

  useEffect(() => {
    _confirmSetter = setState;
    return () => {
      if (_confirmSetter === setState) _confirmSetter = null;
    };
  }, []);

  // Unmounting with a question open must not strand its awaiter.
  const pending = useRef<HostState | null>(null);
  pending.current = state;
  useEffect(() => () => pending.current?.resolve(false), []);

  if (!state) return null;
  const settle = (v: boolean) => {
    setState(null);
    state.resolve(v);
  };
  return (
    <ConfirmDialog
      {...state.opts}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}

function ConfirmDialog({
  title, message, detail, confirmLabel = "Confirm", cancelLabel = "Cancel",
  tone = "accent", onConfirm, onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      } else if (e.key === "Enter") {
        e.preventDefault();
        onConfirm();
      }
    };
    // Capture phase: the player overlay and other surfaces bind their own
    // window-level key handlers, and a modal question must win over them.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel]);

  const confirmCls =
    tone === "danger"
      ? "bg-rose-500/85 text-white border-rose-300/50 hover:bg-rose-500"
      : "bg-ln-accent text-black border-ln-accent hover:brightness-110";

  return (
    <div
      className="aura-modal-backdrop-in fixed inset-0 z-[300] flex items-center justify-center
                 bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="aura-modal-card-in glass-panel-elevated rounded-3xl px-7 py-6 w-full max-w-[430px] mx-4
                   shadow-glass-edge flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-lg font-semibold tracking-tight">{title}</h2>
          {message && (
            <p className="text-white/70 text-sm leading-relaxed">{message}</p>
          )}
          {detail && (
            <p className="text-white/40 text-[12.5px] leading-relaxed">{detail}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-1.5 rounded-full text-xs font-medium
                       bg-white/5 text-white/70 border border-white/15
                       hover:bg-white/12 hover:text-white transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`px-4 py-1.5 rounded-full text-xs font-semibold border
                        transition-all ${confirmCls}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
