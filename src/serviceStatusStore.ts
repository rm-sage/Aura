// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// serviceStatusStore: what the title-bar service monitor (ServiceStatusChip)
// checks, and the provider catalogue it offers.
//
// The installed addon list lives in App.tsx state and the title bar is a
// sibling far from it, so App PUBLISHES the list here (one effect) instead of
// threading a prop through TitleBar. Only `{ name, url }` is kept: the chip
// needs nothing else, and the url is handed straight to Rust, never logged or
// rendered (addon URLs carry config tokens in their paths; the panel shows
// the host only).
//
// `settled` mirrors App's `addonsSettled`: the monitor waits for it before its
// first check, because an empty list before the first load means "not loaded
// yet", not "none installed", and a check run then would probe no addon at all.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";

export interface StatusAddon {
  name: string;
  url: string;
}

interface Snapshot {
  addons: StatusAddon[];
  settled: boolean;
}

let snapshot: Snapshot = { addons: [], settled: false };
const subs = new Set<() => void>();

/** Called by App whenever its addon list (or its settled flag) changes. Skips
 *  the emit when nothing the monitor reads changed, so a refresh that
 *  rebuilds identical entries does not re-render the title bar. */
export function publishStatusAddons(
  addons: ReadonlyArray<{ name: string; url: string }>,
  settled: boolean,
): void {
  const next = addons.map((a) => ({ name: a.name, url: a.url }));
  const same =
    settled === snapshot.settled &&
    next.length === snapshot.addons.length &&
    next.every((a, i) => a.url === snapshot.addons[i].url && a.name === snapshot.addons[i].name);
  if (same) return;
  snapshot = { addons: next, settled };
  for (const cb of subs) cb();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}

export function getStatusAddons(): Snapshot {
  return snapshot;
}

export function useStatusAddons(): Snapshot {
  return useSyncExternalStore(subscribe, getStatusAddons, getStatusAddons);
}

/** Host for display ("comet.example.com"). Never the path: that is where an
 *  addon's config token lives. */
export function addonHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}

/** The relay address as Watch Together connects to it: the same scheme handling
 *  as buildUrl in watchTogether/store.ts, which saves the field free-form and
 *  treats a bare host as wss://. Checked by string prefix on purpose:
 *  "localhost:8787" parses as a URL whose scheme is "localhost". */
export function normalizeRelayUrl(raw: string): string {
  const b = raw.trim();
  if (!b) return "";
  if (b.startsWith("https://")) return "wss://" + b.slice(8);
  if (b.startsWith("http://")) return "ws://" + b.slice(7);
  if (b.startsWith("ws://") || b.startsWith("wss://")) return b;
  return "wss://" + b;
}

// ---------------------------------------------------------------------------
// Panel phase
//
// Module scope, like downloadsPanel.ts and for the same reason: App has to feed
// PlayerOverlay's anyMenuOpen, so a click on the video that dismisses the panel
// does not also toggle pause, and the chip is a leaf far from it. "closing" is
// still painted and still swallows that click. It lasts one macrotask under
// reduced motion: the close runs in a capture listener, and React can flush
// "closed" in the microtask before the video layer's mousedown reads the flag.
// ---------------------------------------------------------------------------

export type StatusPanelPhase = "closed" | "open" | "closing";

/** Matches the panel's CSS exit animation (aura-dl-panel-out). */
const STATUS_PANEL_EXIT_MS = 180;

let panelPhase: StatusPanelPhase = "closed";
let panelTimer: ReturnType<typeof setTimeout> | null = null;
const panelSubs = new Set<() => void>();

function setPanelPhase(next: StatusPanelPhase): void {
  if (next === panelPhase) return;
  panelPhase = next;
  for (const cb of panelSubs) cb();
}

function clearPanelTimer(): void {
  if (panelTimer != null) clearTimeout(panelTimer);
  panelTimer = null;
}

function subscribePanel(cb: () => void): () => void {
  panelSubs.add(cb);
  return () => { panelSubs.delete(cb); };
}

const getPanelPhase = (): StatusPanelPhase => panelPhase;

export function useStatusPanelPhase(): StatusPanelPhase {
  return useSyncExternalStore(subscribePanel, getPanelPhase, getPanelPhase);
}

export function openStatusPanel(): void {
  clearPanelTimer();
  setPanelPhase("open");
}

export function closeStatusPanel(): void {
  if (panelPhase !== "open") return;
  const reduced =
    typeof document !== "undefined" &&
    document.documentElement.getAttribute("data-reduced-motion") === "true";
  setPanelPhase("closing");
  panelTimer = setTimeout(() => {
    panelTimer = null;
    setPanelPhase("closed");
  }, reduced ? 0 : STATUS_PANEL_EXIT_MS);
}

/** No exit animation: the chip is unmounting (fullscreen), and a phase left set
 *  would swallow the next video click and pin the controls visible. */
export function closeStatusPanelImmediate(): void {
  clearPanelTimer();
  setPanelPhase("closed");
}

// ---------------------------------------------------------------------------
// Provider catalogue
//
// Mirrors the FIXED endpoint table in src-tauri/src/service_status.rs (the ids
// must match; Rust ignores an id it does not know, and the endpoints live only
// there). Researched 2026-11-01: only TorBox, Real-Debrid and put.io publish a
// real status feed; AllDebrid, Premiumize and Debrid-Link have only an API
// that can be pinged, which says "answering" and nothing about torrents or
// hosters. Offcloud has no unauthenticated endpoint at all, and no usenet
// provider publishes anything machine-readable, so they are not offered.
// ---------------------------------------------------------------------------

export interface StatusProvider {
  id: string;
  name: string;
  /** Human status page, when the provider has one. */
  statusPage: string | null;
  /** "status" = a real status page feed; "ping" = API reachability only. */
  source: "status" | "ping";
}

export const STATUS_PROVIDERS: readonly StatusProvider[] = [
  { id: "torbox",      name: "TorBox",      statusPage: "https://status.torbox.app",      source: "status" },
  { id: "real-debrid", name: "Real-Debrid", statusPage: "https://status.real-debrid.com", source: "status" },
  { id: "putio",       name: "put.io",      statusPage: "https://status.put.io",          source: "status" },
  { id: "alldebrid",   name: "AllDebrid",   statusPage: null,                             source: "ping" },
  { id: "premiumize",  name: "Premiumize",  statusPage: null,                             source: "ping" },
  { id: "debrid-link", name: "Debrid-Link", statusPage: null,                             source: "ping" },
];

export function statusProvider(id: string): StatusProvider | undefined {
  return STATUS_PROVIDERS.find((p) => p.id === id);
}
