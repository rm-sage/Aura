// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import type { KeybindAction } from "./types";

// ---------------------------------------------------------------------------
// useKeybindings — single global keydown listener that maps a binding spec
// to user-bound actions.
//
// Binding spec grammar:
//
//   <binding> ::= [<modifier> "+"]* <code>
//   <modifier> ::= "Ctrl" | "Alt" | "Shift" | "Meta"
//   <code>     ::= a `KeyboardEvent.code` value (e.g. "Space", "Digit1")
//
// Examples: "Space", "Ctrl+Digit1", "Ctrl+Shift+KeyS", "Alt+ArrowLeft".
//
// Modifier matching is STRICT — `Space` only fires when no modifier is held,
// and `Ctrl+Digit1` only fires when exactly Ctrl is held. This avoids the
// classic "binding fires unexpectedly while user holds Alt for something
// else" footgun.
//
// We key on `event.code` (US-layout-independent) rather than `event.key`
// (locale-dependent). The Settings UI captures the same spec, persists it,
// and feeds it back here as a `bindings` map.
//
// Inputs are short-circuited when typed into form controls (input, textarea,
// contenteditable) so power-user keys don't interfere with the search bar.
// ---------------------------------------------------------------------------

type Handlers = Partial<Record<KeybindAction, () => void>>;

interface Options {
  /** Action → binding spec (e.g. "Space", "Ctrl+Digit1"). */
  bindings: Record<string, string>;
  handlers: Handlers;
  /** When false, all key handling is disabled (e.g. during a binding capture). */
  enabled?: boolean;
}

interface ParsedChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  code: string;
}

const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight",
  "ControlLeft", "ControlRight",
  "AltLeft", "AltRight",
  "MetaLeft", "MetaRight",
  "OSLeft", "OSRight",
]);

/** Parse a binding spec into structured form. Returns null for an empty / malformed spec. */
export function parseBinding(spec: string): ParsedChord | null {
  if (!spec) return null;
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const code = parts.pop() as string;
  let ctrl = false, alt = false, shift = false, meta = false;
  for (const part of parts) {
    switch (part) {
      case "Ctrl":  ctrl  = true; break;
      case "Alt":   alt   = true; break;
      case "Shift": shift = true; break;
      case "Meta":  meta  = true; break;
      default: return null;
    }
  }
  return { ctrl, alt, shift, meta, code };
}

/** Build a normalized binding spec from a chord. Modifier order is canonical
 *  (Ctrl → Alt → Shift → Meta) so equivalent bindings serialize identically. */
export function formatBinding(chord: ParsedChord): string {
  const segs: string[] = [];
  if (chord.ctrl)  segs.push("Ctrl");
  if (chord.alt)   segs.push("Alt");
  if (chord.shift) segs.push("Shift");
  if (chord.meta)  segs.push("Meta");
  segs.push(chord.code);
  return segs.join("+");
}

function chordMatches(chord: ParsedChord, e: KeyboardEvent): boolean {
  return chord.ctrl === e.ctrlKey
      && chord.alt === e.altKey
      && chord.shift === e.shiftKey
      && chord.meta === e.metaKey
      && chord.code === e.code;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

export function useKeybindings({ bindings, handlers, enabled = true }: Options) {
  // Keep latest bindings/handlers in a ref so we don't need to rebind the
  // window listener on every state change — saves a teardown per render.
  const ref = useRef({ bindings, handlers, enabled });
  ref.current = { bindings, handlers, enabled };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { bindings, handlers, enabled } = ref.current;
      if (!enabled) return;
      if (isTypingTarget(e.target)) return;
      // Ignore modifier-key presses themselves — they only fire chords
      // in combination with a non-modifier keypress.
      if (MODIFIER_CODES.has(e.code)) return;

      // Resolve the action whose binding matches this event. We iterate
      // every binding rather than building a precomputed lookup map
      // because binding sets are tiny (<20 entries) and bindings can
      // mutate at runtime when the user remaps in Settings.
      for (const [action, spec] of Object.entries(bindings)) {
        const chord = parseBinding(spec);
        if (!chord) continue;
        if (!chordMatches(chord, e)) continue;
        const fn = handlers[action as KeybindAction];
        if (!fn) return;
        e.preventDefault();
        e.stopPropagation();
        fn();
        return;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

// ---------------------------------------------------------------------------
// Pretty-print a binding spec for the Settings UI
// ---------------------------------------------------------------------------

const PRETTY: Record<string, string> = {
  Space:        "Space",
  ArrowLeft:    "←",
  ArrowRight:   "→",
  ArrowUp:      "↑",
  ArrowDown:    "↓",
  Backquote:    "`",
  Escape:       "Esc",
  Enter:        "Enter",
  Comma:        ",",
  Period:       ".",
  Slash:        "/",
  Semicolon:    ";",
  Quote:        "'",
  BracketLeft:  "[",
  BracketRight: "]",
  Backslash:    "\\",
  Minus:        "-",
  Equal:        "=",
  Tab:          "Tab",
};

/** Render an individual KeyboardEvent.code to a single-glyph label. */
export function prettyKey(code: string): string {
  if (PRETTY[code]) return PRETTY[code];
  if (code.startsWith("Key"))    return code.slice(3);
  if (code.startsWith("Digit"))  return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  if (code.startsWith("F") && /^F\d+$/.test(code)) return code;
  return code;
}

/** Render a full binding spec ("Ctrl+Digit1") in compact form ("Ctrl+1"). */
export function prettyBinding(spec: string): string {
  const chord = parseBinding(spec);
  if (!chord) return "—";
  const segs: string[] = [];
  if (chord.ctrl)  segs.push("Ctrl");
  if (chord.alt)   segs.push("Alt");
  if (chord.shift) segs.push("Shift");
  if (chord.meta)  segs.push("Meta");
  segs.push(prettyKey(chord.code));
  return segs.join("+");
}
