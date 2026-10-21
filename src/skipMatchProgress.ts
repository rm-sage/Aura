// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The AuraSkip theme match, live: how far the detector has read the region it
// is matching for each kind, and what it concluded. App.tsx feeds it from the
// detect it runs (`skipdetect-progress` for the decode, the snapshots for the
// verdicts); the skip prompt in PlayerOverlay shows it, inside the prompt when
// one is up and in the prompt's slot otherwise, so the top-left stack never
// grows a box of its own for it.
//
// A kind gets a row only when it is really being theme matched: the detector
// has a candidate theme of that kind (Rust's progress event says so), Layer 1
// is still deciding it, and its skip mode is not Off (at the start here; the
// prompt also hides a kind switched Off mid-load). A cached result never
// reports progress, so it shows nothing. Once every row has a verdict they
// linger briefly so the outcome is readable, then the rows go.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

export type SkipMatchKind = "op" | "ed";
/** "waiting": not read yet (the ending waits for the opening's region);
 *  "running": its region is decoding (or done and still deciding);
 *  "found" / "none": matched, or the cour's themes did not match this file;
 *  "failed": the match could not run to a verdict. */
export type SkipMatchState = "waiting" | "running" | "found" | "none" | "failed";
export interface SkipMatchRow {
  kind: SkipMatchKind;
  state: SkipMatchState;
  /** Share of the kind's region decoded, 0 to 1 (0 while waiting). */
  fraction: number;
}

/** Rust `job::Progress`. */
export interface SkipDetectProgress {
  generation: number;
  kind: SkipMatchKind;
  fraction: number;
  op_themes: boolean;
  ed_themes: boolean;
}

/** How long the verdicts stay up once nothing is left to decide. */
const LINGER_MS = 4000;
const KINDS: readonly SkipMatchKind[] = ["op", "ed"];

interface Run {
  generation: number;
  want: Record<SkipMatchKind, boolean>;
  /** The Rust Layer 1 state per kind (wire strings), from the snapshots. */
  l1: Record<SkipMatchKind, string>;
  fraction: Record<SkipMatchKind, number | null>;
  /** Kinds given a row. Once tracked a kind keeps its row, so its verdict
   *  shows; tracked only while its verdict is still pending. */
  tracked: Record<SkipMatchKind, boolean>;
}

let run: Run | null = null;
let rows: readonly SkipMatchRow[] = [];
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function stateOf(r: Run, kind: SkipMatchKind): SkipMatchState {
  switch (r.l1[kind]) {
    case "pending":     return r.fraction[kind] == null ? "waiting" : "running";
    case "matched":     return "found";
    case "informative": return "none";
    case "no_themes":   return "none";
    default:            return "failed";
  }
}

function emit(next: readonly SkipMatchRow[]): void {
  rows = next;
  for (const l of listeners) l();
}

function clearLinger(): void {
  if (lingerTimer != null) clearTimeout(lingerTimer);
  lingerTimer = null;
}

function recompute(): void {
  const r = run;
  if (!r) return;
  const next = KINDS.filter((k) => r.tracked[k]).map((k) => ({
    kind: k,
    state: stateOf(r, k),
    fraction: r.fraction[k] ?? 0,
  }));
  emit(next);
  const settled = next.length > 0 && next.every((x) => x.state !== "waiting" && x.state !== "running");
  // A kind can start being tracked after the others settled (sibling cours
  // merged in by the opening's decision bring the ending its first theme):
  // the linger must not end the run under it.
  if (!settled) clearLinger();
  else if (lingerTimer == null) {
    lingerTimer = setTimeout(() => {
      lingerTimer = null;
      if (run === r) {
        run = null;
        emit([]);
      }
    }, LINGER_MS);
  }
}

/** A detect starts (after its Cancel answered, so `generation` is its own).
 *  `want`: the kinds whose skip mode is on; an ending read only for the Next
 *  Up card is not shown. Replaces whatever the previous detect left. */
export function beginSkipMatch(generation: number, want: Record<SkipMatchKind, boolean>): void {
  clearLinger();
  run = {
    generation,
    want,
    l1: { op: want.op ? "pending" : "not_requested", ed: want.ed ? "pending" : "not_requested" },
    fraction: { op: null, ed: null },
    tracked: { op: false, ed: false },
  };
  emit([]);
}

/** A `skipdetect-progress` event. */
export function skipMatchProgress(p: SkipDetectProgress): void {
  const r = run;
  if (!r || p.generation !== r.generation) return;
  if (p.kind !== "op" && p.kind !== "ed") return;
  const themes: Record<SkipMatchKind, boolean> = { op: p.op_themes, ed: p.ed_themes };
  for (const k of KINDS) {
    if (!r.tracked[k] && r.want[k] && themes[k] && r.l1[k] === "pending") r.tracked[k] = true;
  }
  const f = Number.isFinite(p.fraction) ? Math.min(1, Math.max(0, p.fraction)) : 0;
  r.fraction[p.kind] = Math.max(r.fraction[p.kind] ?? 0, f);
  recompute();
}

/** A snapshot's per-kind Layer 1 states (`op_l1` / `ed_l1`). */
export function skipMatchVerdicts(
  generation: number,
  op: string | null | undefined,
  ed: string | null | undefined,
): void {
  const r = run;
  if (!r || generation !== r.generation) return;
  if (op) r.l1.op = op;
  if (ed) r.l1.ed = ed;
  recompute();
}

/** The detect is over. A run that left a row undecided (superseded, failed)
 *  or that belongs to a load already replaced goes at once; one with every
 *  verdict in lingers as `recompute` scheduled. */
export function endSkipMatch(generation: number, immediately: boolean): void {
  const r = run;
  if (!r || r.generation !== generation) return;
  const pending = KINDS.some((k) => r.tracked[k] && r.l1[k] === "pending");
  if (immediately || pending || !KINDS.some((k) => r.tracked[k])) {
    clearLinger();
    run = null;
    emit([]);
  }
}

/** The load was replaced or playback ended: nothing shown belongs to it. */
export function resetSkipMatch(): void {
  clearLinger();
  run = null;
  if (rows.length > 0) emit([]);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
const getRows = (): readonly SkipMatchRow[] => rows;

/** The rows to show; empty when no theme match is under way. */
export function useSkipMatchRows(): readonly SkipMatchRow[] {
  return useSyncExternalStore(subscribe, getRows, getRows);
}
