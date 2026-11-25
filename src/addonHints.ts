// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// Live-manifest capability hints, per addon url.
//
// A wrapper addon (AIOStreams re-serving AIOMetadata) declares what it wraps
// and which AIOMetadata routes it forwards in its manifest's behaviorHints
// (`wrappedAddons`, `landscapeArt`), and whether it reports the health of the
// addons it wraps (`addonStatus`, read by the service status panel). Those are read from the LIVE manifest
// (`get_addon_manifest`, Rust's 24 h manifest cache, so the same fetch Home
// already makes), never from `AddonEntry`: a signed-in entry is built from
// the manifest stored in the Stremio collection, and stremio-core drops
// unknown behaviorHints whenever an official app re-saves that collection.
//
// Bounded (CAP entries, oldest dropped); a failed read is retried after
// RETRY_MS. `useAddonHints` asks only addons that serve meta (a wrapper of
// AIOMetadata always does); `useAddonHintsFor` asks every url it is given.

import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, WrappedAddon } from "./types";

export interface AddonHints {
  wrapped: WrappedAddon[];
  landscape_art: boolean;
  /** `behaviorHints.addonStatus`: serves `api/status/addons.json`. */
  addon_status: boolean;
}

const CAP = 64;
const RETRY_MS = 10 * 60 * 1000;

const hints = new Map<string, AddonHints>();
const failedAt = new Map<string, number>();
const inFlight = new Set<string>();

let version = 0;
const listeners = new Set<() => void>();
function bump(): void {
  version += 1;
  for (const fn of listeners) fn();
}
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// Addons > Refresh drops Rust's manifest cache for the addon; drop the hints
// read from it too, so the next render reads the fresh manifest.
if (typeof window !== "undefined") {
  window.addEventListener("aura:addon-manifest-refreshed", (e) => {
    const url = (e as CustomEvent<{ url?: unknown }>).detail?.url;
    if (typeof url !== "string") return;
    const hadHints = hints.delete(url);
    const hadFailure = failedAt.delete(url);
    if (hadHints || hadFailure) bump();
  });
}

/** The live hints for an addon url, when they have been read. */
export function addonHints(url: string): AddonHints | undefined {
  return hints.get(url);
}

function remember(url: string, h: AddonHints): void {
  hints.delete(url);
  hints.set(url, h);
  while (hints.size > CAP) {
    const oldest = hints.keys().next().value;
    if (oldest === undefined) break;
    hints.delete(oldest);
  }
}

function wantedUrl(url: string): boolean {
  if (hints.has(url) || inFlight.has(url)) return false;
  const f = failedAt.get(url);
  return f === undefined || Date.now() - f > RETRY_MS;
}

function wanted(a: AddonEntry): boolean {
  return (a.resources ?? []).includes("meta") && wantedUrl(a.url);
}

async function load(url: string): Promise<void> {
  inFlight.add(url);
  try {
    const m = await invoke<Partial<AddonHints>>("get_addon_manifest", { addonUrl: url });
    remember(url, {
      wrapped: Array.isArray(m.wrapped) ? m.wrapped : [],
      landscape_art: m.landscape_art === true,
      addon_status: m.addon_status === true,
    });
    failedAt.delete(url);
    if (failedAt.size > CAP) failedAt.clear();
  } catch {
    failedAt.set(url, Date.now());
  } finally {
    inFlight.delete(url);
    bump();
  }
}

/** Read the live hints of every meta addon in `addons` that has none yet.
 *  Returns the store version, so a caller re-derives when a read lands. */
export function useAddonHints(addons: readonly AddonEntry[] | null | undefined): number {
  const v = useSyncExternalStore(subscribe, () => version);
  useEffect(() => {
    for (const a of addons ?? []) {
      if (wanted(a)) void load(a.url);
    }
  }, [addons, v]);
  return v;
}

/** Read the live hints of every url in `urls` that has none yet, whatever it
 *  serves: the status panel needs `addon_status` from stream-only wrappers too.
 *  Each read is Rust's 24 h manifest cache, so this costs a manifest fetch per
 *  addon per day at most. Returns the store version like `useAddonHints`. */
export function useAddonHintsFor(urls: readonly string[]): number {
  const v = useSyncExternalStore(subscribe, () => version);
  const key = urls.join(" ");
  useEffect(() => {
    for (const u of urls) {
      if (wantedUrl(u)) void load(u);
    }
    // `key` stands for `urls`: a new array with the same urls is no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, v]);
  return v;
}
