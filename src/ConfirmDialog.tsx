// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useEffect, useRef, useState } from "react";

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
// Escape / backdrop-click cancel. Enter presses the FOCUSED button, so a
// user who tabbed to Cancel cancels; with neither button focused it falls
// back to the default (confirm, or cancel under `defaultFocus: "cancel"`).
// The confirm button takes focus on open so a keyboard user can just hit
// Enter or Escape; Tab wraps between the two buttons, never onto the page
// behind the modal. A question where a stray Enter must not act passes
// `defaultFocus: "cancel"`: Cancel takes focus instead.
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: string;
  /** Primary line. The question being asked. */
  message?: string;
  /** A short list of plain consequences, drawn between `message` and
   *  `detail` (one sentence each). For a question whose effects reach past
   *  what the title says (an account write, a list a title leaves). */
  points?: string[];
  /** Secondary line, for the arithmetic / caveats behind the question. */
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` paints the confirm button red — use it for anything destructive. */
  tone?: "accent" | "danger";
  /** Which button takes focus on open (default `confirm`). Enter always
   *  presses the FOCUSED button; this decides which one is focused at first
   *  and what Enter does with neither focused. `cancel` is for a question
   *  where a stray Enter must never act: the user has to Tab to the confirm
   *  button (or click it) to go ahead. */
  defaultFocus?: "confirm" | "cancel";
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
function ConfirmDialogHostImpl() {
  const [state, setState] = useState<HostState | null>(null);

  // Unmounting with a question open must not strand its awaiter.
  const pending = useRef<HostState | null>(null);
  pending.current = state;
  useEffect(() => () => pending.current?.resolve(false), []);

  useEffect(() => {
    // A second question while one is open would strand the first awaiter
    // forever (same guard as useConfirm): answer it as a cancel first.
    const setter = (s: HostState | null) => {
      const prev = pending.current;
      if (prev && prev !== s) prev.resolve(false);
      pending.current = s;
      setState(s);
    };
    _confirmSetter = setter;
    return () => {
      if (_confirmSetter === setter) _confirmSetter = null;
    };
  }, []);

  if (!state) return null;
  const settle = (v: boolean) => {
    pending.current = null;
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
  title, message, points, detail, confirmLabel = "Confirm", cancelLabel = "Cancel",
  tone = "accent", defaultFocus = "confirm", onConfirm, onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus once per opening, never on a re-render: re-running this with the
  // key effect below would yank focus back from a button the user tabbed to.
  useEffect(() => {
    (defaultFocus === "cancel" ? cancelRef : confirmRef).current?.focus();
  }, [defaultFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // stopPropagation: App's Escape ladder (a window bubble listener) would
      // otherwise also close the detail or catalog page under the dialog.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      } else if (e.key === "Enter") {
        // preventDefault also stops the focused button's own Enter click, so
        // each Enter settles the question exactly once. Enter answers for the
        // FOCUSED button: Shift+Tab to Cancel then Enter must cancel.
        e.preventDefault();
        e.stopPropagation();
        const a = document.activeElement;
        if (a === cancelRef.current) onCancel();
        else if (a === confirmRef.current) onConfirm();
        else if (defaultFocus === "cancel") onCancel();
        else onConfirm();
      } else if (e.key === "Tab") {
        // Keep focus on the two buttons: the page behind an aria-modal card
        // is not reachable.
        e.preventDefault();
        e.stopPropagation();
        const next =
          document.activeElement === confirmRef.current ? cancelRef.current : confirmRef.current;
        next?.focus();
      }
    };
    // Capture phase: the player overlay and other surfaces bind their own
    // window-level key handlers, and a modal question must win over them.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onConfirm, onCancel, defaultFocus]);

  // Solid call-to-action fills ride the glass hooks (glass-settings.css), so
  // both glass materials draw them; the text colour stays a utility.
  const confirmCls =
    tone === "danger"
      ? "is-cta-danger text-white"
      : "is-cta text-ln-accent-ink";

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center"
      onClick={onCancel}
    >
      {/* The dim + blur is a SIBLING layer, not the wrapper: a backdrop-filter
          (or a fading opacity) on an ancestor would blind the card's own glass. */}
      <div aria-hidden className="aura-modal-backdrop-in absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="aura-modal-card-in aura-float-glass relative rounded-3xl px-7 py-6 w-full max-w-[430px] mx-4
                   flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col gap-2">
          <h2 className="text-white text-lg font-semibold tracking-tight">{title}</h2>
          {message && (
            <p className="text-white/70 text-sm leading-relaxed">{message}</p>
          )}
          {points && points.length > 0 && (
            <ul className="flex flex-col gap-1.5 mt-0.5">
              {points.map((p, i) => (
                <li key={i} className="flex gap-2.5 text-white/70 text-[13px] leading-relaxed">
                  <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-white/50" />
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          )}
          {detail && (
            <p className="text-white/55 text-[12.5px] leading-relaxed">{detail}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2.5">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="aura-glass-flat aura-glass-press px-4 py-1.5 rounded-full text-xs font-medium
                       text-white/70 hover:text-white"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            className={`aura-glass-flat aura-glass-press ${confirmCls} px-4 py-1.5 rounded-full text-xs font-semibold`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Memoized: App renders this host with no props (or only primitives / its own
// stable state) and re-renders on every playback-update tick. The host is
// driven by its own state and store subscriptions, so skipping those renders
// changes nothing on screen.
export const ConfirmDialogHost = memo(ConfirmDialogHostImpl);
