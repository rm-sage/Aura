// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import Tooltip from "./Tooltip";
import { useIdleGatedInterval } from "./useIdleGate";
import { isWindowHidden } from "./windowVisibility";
import { loadAuraSettings, saveAuraSettings } from "./auraSettings";
import { getRelayUrl } from "./watchTogether/store";
import { openExternalUrl } from "./externalUrl";
import { SIDE_PILL_TOP_PX } from "./SidePill";
import {
  closeDownloadsPanel,
  isPlayerActive,
  keepPanelKeysFromPlayer,
  useDownloadsPanelPhase,
} from "./downloadsPanel";
import {
  STATUS_PROVIDERS,
  addonHost,
  closeStatusPanel,
  closeStatusPanelImmediate,
  getStatusAddons,
  normalizeRelayUrl,
  openStatusPanel,
  statusProvider,
  useStatusAddons,
  useStatusPanelPhase,
} from "./serviceStatusStore";

// ---------------------------------------------------------------------------
// ServiceStatusChip: the title-bar status monitor. It grew out of the old
// Cloud Sync chip and keeps its spot, footprint and colour language, but now
// reports the WORST state across everything Aura depends on:
//
//   • Aura's server (aura.animasec.dev /healthz: OAuth, Aura Cloud, releases)
//   • Aura Cloud sync (the old chip's `sync_status` logic, unchanged)
//   • the Watch Together relay
//   • every installed addon (its manifest, timed; slow = degraded)
//   • the debrid providers the user chose to monitor (their own status feed,
//     from a fixed table in Rust: src-tauri/src/service_status.rs)
//
// The icon carries a distinct glyph per state, so colour is never the only
// signal: check (all good), "!" (degraded), X (down), three dots (first check
// still running), bare cloud (nothing monitored). Click opens a panel listing
// each row; the Cloud sync row keeps the old chip's click-through to Settings.
//
// CADENCE. Services are checked every 5 minutes while the window is visible,
// plus once when the panel opens if the last check is over 20 s old. Addons are
// never probed more often than that (each probe is a real request to someone's
// server), with one exception: a round that reads offline gets one retry about
// a minute later, or a laptop waking before its Wi-Fi is back stays red for 5
// minutes. A 30 s tick tests the due time, measured from the last check's START,
// so a restore or a remount cannot add a round (a chip's own 5 min timer has
// no idea when the last check ran) and a panel check moves the next one. The
// sync status keeps its own 60 s poll and the session / settings listeners it
// always had (a settings burst costs one request); Check again refreshes it too.
// The first check waits for the addon list to settle (or 10 s), so it does not
// run against the empty list every launch starts with. An addon the list gains
// after a check read it (a late settle, a sign-in, an install) gets one
// addons-only probe within seconds; that moves neither the poll nor any other
// addon. The throttle state and the last snapshot are module-level, because the
// title bar (and this chip with it) unmounts in fullscreen: a remount reuses
// them instead of probing.
// ---------------------------------------------------------------------------

// ── Wire types (src-tauri/src/service_status.rs) ────────────────────────────

interface Probe {
  ok: boolean;
  http_status: number | null;
  /** The headline figure; `latency_kind` says what it measured. */
  latency_ms: number | null;
  /** "ping": a second request on the connection the first left open, to a
   *  route that does no work (Aura server, relay). "response": time to the
   *  response headers on a new connection, setup and server work included
   *  (addons: building a manifest is server work). */
  latency_kind?: "ping" | "response" | null;
  /** First request's time to headers (opens the connection when none is). */
  cold_ms?: number | null;
  /** One TCP handshake timed on its own: the network round trip (addons). */
  rtt_ms?: number | null;
  error: string | null;
  /** A loopback addon refused the connection (Stremio's "Local Files" addon
   *  while Stremio's own server is not running). Not an outage. */
  not_running?: boolean;
  /** The probe went to this machine (an addon or relay on a loopback address). */
  loopback?: boolean;
}

type ProviderState =
  | "operational" | "degraded" | "partial_outage" | "major_outage" | "maintenance" | "unknown";

interface ProviderReport {
  id: string;
  state: ProviderState;
  summary: string | null;
  components: string[];
  incidents: string[];
  reachability_only: boolean;
  checked_at: number;
}

interface CheckReply {
  result: "report";
  aura: Probe | null;
  relay: Probe | null;
  addons: Probe[];
  providers: ProviderReport[];
  checked_at: number;
}

interface NamespaceStatus {
  name: string;
  etag: string | null;
  updated_at: number | null;
  size: number | null;
}

interface SyncStatus {
  connected: boolean;
  namespaces: NamespaceStatus[];
  total_size: number;
  quota: number;
}

// ── Local model ─────────────────────────────────────────────────────────────

type SyncState = "guest" | "ok" | "stale" | "error";
/** Row / chip level. `pending` = never checked; `idle` = nothing to judge. */
type Level = "ok" | "warn" | "down" | "idle" | "pending";
type ChipState = "ok" | "warn" | "down" | "idle" | "checking";

interface ServiceSnapshot {
  aura: Probe | null;
  relay: Probe | null;
  /** The relay URL the `relay` probe was made against. */
  relayUrl: string | null;
  /** Keyed by addon base URL, cut to the current list on every answer (so
   *  bounded by MAX_ADDONS). In memory only: these URLs carry config tokens. */
  addons: Map<string, Probe>;
  /** Keyed by provider id; bounded by STATUS_PROVIDERS. */
  providers: Record<string, ProviderReport>;
  /** Unix ms of the last completed full check, null before the first. */
  checkedAt: number | null;
  /** The last full check could not run at all (IPC failure). */
  failed: boolean;
}

const EMPTY_SNAPSHOT: ServiceSnapshot = {
  aura: null, relay: null, relayUrl: null, addons: new Map(), providers: {}, checkedAt: null, failed: false,
};

const SYNC_POLL_MS = 60_000;
const SERVICE_POLL_MS = 5 * 60_000;
/** An opened panel re-checks only when the last check is older than this. */
const OPEN_REFRESH_MIN_MS = 20_000;
/** A round that read offline is retried this long after it ended; the 30 s tick
 *  takes it up to 30 s later. */
const OFFLINE_RETRY_MS = 30_000;
/** A settings event's sync refresh waits this long for its burst to end. */
const SYNC_SETTINGS_DEBOUNCE_MS = 1_000;
/** First check fallback when the addon list is slow to report settled. */
const FIRST_CHECK_FALLBACK_MS = 10_000;
/** A list change waits this long before its new addons are probed: a sign-in
 *  publishes the cached list and then the synced one. */
const NEW_ADDON_DEBOUNCE_MS = 2_000;
/** Mirrors Rust's MAX_ADDONS; extra addons show as not checked. */
const MAX_ADDONS = 40;

/** Mirrors Rust's MAX_ADDON_URL_LEN (bytes of the manifest URL). */
const MAX_ADDON_URL_BYTES = 16 * 1024;
const utf8 = new TextEncoder();

/** Only a web address Rust will accept can be probed. Anything else is shown as
 *  "not checkable" rather than sent to Rust and painted red. The length is
 *  measured on the URL as Rust's addon_manifest_url builds it. */
function isCheckable(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const base = url.trim().replace(/\/+$/, "");
  const manifest = base.endsWith("/manifest.json") ? base : `${base}/manifest.json`;
  return utf8.encode(manifest).length <= MAX_ADDON_URL_BYTES;
}
/** Over this, a service that answered is still reported as degraded: a
 *  stream query waits on the slowest addon it fans out to. */
const SLOW_MS = 2_500;
/** Cadence for the relative-time readouts. `formatAgo`'s finest unit is a
 *  minute, so 30 s is a 2x oversample and "N min ago" is never a whole unit
 *  behind. */
const TICK_INTERVAL_MS = 30_000;
/** One arrow-key step of the panel's list, the browser's own step for a focused scroller. */
const ARROW_SCROLL_PX = 40;
/** Treat the sync as "stale" when the most recent namespace update is older
 *  than this. One week matches the AniList token warn window. */
const STALE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const COLOR: Record<Level | ChipState, string> = {
  idle:     "rgba(255,255,255,0.6)",
  pending:  "rgba(255,255,255,0.6)",
  checking: "rgba(255,255,255,0.6)",
  ok:       "rgb(110, 231, 183)", // emerald-300
  warn:     "rgb(252, 211, 77)",  // amber-300
  down:     "rgb(251, 113, 133)", // rose-400
};

const RANK: Record<Level, number> = { pending: 0, idle: 1, ok: 2, warn: 3, down: 4 };

function probeLevel(p: Probe | null | undefined): Level {
  if (!p) return "pending";
  // A local server that is not running is not broken, and the protected
  // Local Files addon cannot be uninstalled: red here would be permanent.
  if (p.not_running) return "idle";
  if (!p.ok) return "down";
  if (p.latency_ms != null && p.latency_ms > SLOW_MS) return "warn";
  return "ok";
}

function providerLevel(r: ProviderReport | undefined): Level {
  if (!r) return "pending";
  switch (r.state) {
    case "operational": return "ok";
    case "degraded":
    case "partial_outage":
    case "maintenance": return "warn";
    case "major_outage": return "down";
    // A status page that did not answer says nothing about the service, so it
    // must not turn the chip red.
    default: return "idle";
  }
}

const PROVIDER_WORD: Record<ProviderState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  partial_outage: "Partial outage",
  major_outage: "Major outage",
  maintenance: "Maintenance",
  unknown: "Unknown",
};

const SYNC_LEVEL: Record<SyncState, Level> = { guest: "idle", ok: "ok", stale: "warn", error: "down" };

function formatLatency(ms: number | null): string {
  if (ms == null) return "";
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Secondary text for a plain probe row. The figure carries its kind, because
 *  a ping and a response time are different quantities: calling a cold
 *  response "ping" is what made the first version's numbers look inflated. */
function probeDetail(p: Probe | null | undefined, checking: boolean): string {
  if (!p) return checking ? "Checking..." : "Not checked yet";
  if (p.not_running) return "Not running (local addon)";
  if (!p.ok) return p.http_status != null ? `Error, HTTP ${p.http_status}` : `Not answering (${p.error ?? "failed"})`;
  const lat = formatLatency(p.latency_ms);
  const fig = lat ? `${lat} ${p.latency_kind === "ping" ? "ping" : "response"}` : "";
  const word = probeLevel(p) === "warn" ? "Slow" : "OK";
  return fig ? `${word}, ${fig}` : word;
}

/** Tooltip lines that say what the row's number measured. Empty when the
 *  probe has no figure (not answering, not checked). */
function latencyLines(p: Probe | null | undefined): string[] {
  if (!p || p.latency_ms == null || p.not_running) return [];
  const out: string[] = [];
  if (p.latency_kind === "ping") {
    out.push(`Ping ${formatLatency(p.latency_ms)}: one request on an open connection`);
    if (p.cold_ms != null) {
      out.push(`First request ${formatLatency(p.cold_ms)}, opening the connection if none was open`);
    }
  } else {
    out.push(`Response ${formatLatency(p.latency_ms)}: time to answer on a new connection, setup and server work included`);
  }
  if (p.rtt_ms != null) out.push(`Network round trip ${formatLatency(p.rtt_ms)}`);
  return out;
}

function readReducedMotion(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.reducedMotion === "true";
}

// ── Service state: MODULE level, not per chip instance ─────────────────────
// App.tsx renders `{!isFullscreen && <TitleBar/>}`, so the chip unmounts on
// every fullscreen entry and mounts again on exit. With this state in the
// component, each exit started over from an empty snapshot and a zero
// "last checked" time and probed every addon, the Aura server and the relay
// at once (10 fullscreen toggles = 10 full rounds), breaking the 5 min rule
// above, showing "Not checked yet" after every exit, and running beside a
// check the old instance had left in flight. Here the snapshot, the in-flight
// guard and the timestamps survive a remount; the mount itself only checks
// when the 5 min poll is due. Bounded: one snapshot, whose addon map is
// cut to the current list on each answer.

interface ServiceState {
  svc: ServiceSnapshot;
  checking: boolean;
}

let serviceState: ServiceState = { svc: EMPTY_SNAPSHOT, checking: false };
const serviceSubs = new Set<() => void>();
/** A full check is running (across every chip instance). */
let fullInFlight = false;
/** Unix ms a full check last finished (0 = never). */
let lastFullAt = 0;
/** Unix ms a full check last STARTED (0 = never). The poll measures from here:
 *  from the finish, 40 hung addons (over a minute) would push it a round late. */
let lastFullStartedAt = 0;
/** The launch-time first check has been taken (or deferred to the resume
 *  catch-up while hidden). */
let firstCheckDone = false;
/** Addon urls asked about with no answer yet since the last full check: in
 *  flight, or lost to an IPC failure, which must wait for the next full check
 *  rather than be retried by every list change and tick. */
const addonUrlsAsked = new Set<string>();
/** The next full check is the retry of a round that read offline, so it does
 *  not earn another one. */
let offlineRetryPending = false;

function setServiceState(patch: Partial<ServiceState>): void {
  serviceState = { ...serviceState, ...patch };
  for (const cb of serviceSubs) cb();
}

function updateSvc(fn: (s: ServiceSnapshot) => ServiceSnapshot): void {
  setServiceState({ svc: fn(serviceState.svc) });
}

/** Every network probe failed without an HTTP answer: that is this machine
 *  being offline, not a dozen services failing at once. A loopback probe,
 *  answering or refused, is no evidence about the network, so it does not
 *  count. With nothing else to judge by this reads false, the safe side. */
function readsOffline(svc: ServiceSnapshot): boolean {
  if (!svc.aura || svc.aura.ok || svc.aura.http_status != null) return false;
  const probes = [...svc.addons.values()];
  if (svc.relay) probes.push(svc.relay);
  const remote = probes.filter((p) => !p.loopback);
  return remote.length > 0 && remote.every((p) => !p.ok && p.http_status == null);
}

function fullCheckDue(): boolean {
  return Date.now() - lastFullStartedAt >= SERVICE_POLL_MS;
}

function subscribeService(cb: () => void): () => void {
  serviceSubs.add(cb);
  return () => { serviceSubs.delete(cb); };
}

function getServiceState(): ServiceState {
  return serviceState;
}

/** The addon urls a check may ask about, in row order. */
function checkableAddonUrls(): string[] {
  return getStatusAddons().addons
    .map((a) => a.url)
    .filter(isCheckable)
    .slice(0, MAX_ADDONS);
}

/** Merge a reply against the list as it stands NOW: an addon removed meanwhile
 *  goes, and an answer that arrived from another check stays. */
function mergeAddonProbes(
  current: Map<string, Probe>,
  urls: string[],
  probes: Probe[],
): Map<string, Probe> {
  const answers = new Map<string, Probe>();
  urls.forEach((u, i) => { if (probes[i]) answers.set(u, probes[i]); });
  const merged = new Map<string, Probe>();
  for (const u of checkableAddonUrls()) {
    const p = answers.get(u) ?? current.get(u);
    if (p) merged.set(u, p);
  }
  return merged;
}

async function runFullCheck(): Promise<void> {
  if (fullInFlight) return;
  fullInFlight = true;
  lastFullStartedAt = Date.now();
  const isOfflineRetry = offlineRetryPending;
  offlineRetryPending = false;
  setServiceState({ checking: true });
  const urls = checkableAddonUrls();
  addonUrlsAsked.clear();
  for (const u of urls) addonUrlsAsked.add(u);
  const relay = normalizeRelayUrl(getRelayUrl()) || null;
  const providers = loadAuraSettings().monitoredProviders;
  try {
    const r = await invoke<CheckReply>("service_status", {
      action: { op: "check", aura: true, relay, addons: urls, providers },
    });
    for (const u of urls) addonUrlsAsked.delete(u);
    // MERGE providers against the list as it stands NOW, not the one this
    // check read before its await: a provider ticked while the addon probes
    // ran has its answer from runProviderCheck already in `s.providers`, and
    // replacing the record would drop it to "Not checked yet" until the next
    // poll. Unticked ids are dropped, so the record stays bounded by the
    // monitored list.
    const nowMonitored = loadAuraSettings().monitoredProviders;
    updateSvc((s) => {
      const merged: Record<string, ProviderReport> = {};
      for (const id of nowMonitored) {
        const kept = r.providers.find((p) => p.id === id) ?? s.providers[id];
        if (kept) merged[id] = kept;
      }
      return {
        aura: r.aura, relay: r.relay, relayUrl: relay,
        addons: mergeAddonProbes(s.addons, urls, r.addons),
        providers: merged, checkedAt: r.checked_at, failed: false,
      };
    });
    // Every host failing at once points at this machine, not at load on any
    // addon, so one early round is within the reason for the 5 min rule. Not a
    // loop: the retry earns none. The tick picks it up.
    if (!isOfflineRetry && readsOffline(serviceState.svc)) {
      offlineRetryPending = true;
      lastFullStartedAt = Date.now() - SERVICE_POLL_MS + OFFLINE_RETRY_MS;
    }
  } catch (e) {
    console.warn("[status] service_status failed:", e);
    updateSvc((s) => ({ ...s, checkedAt: Date.now(), failed: true }));
  } finally {
    fullInFlight = false;
    lastFullAt = Date.now();
    setServiceState({ checking: false });
  }
}

/** Providers only, for a provider the user just switched on: the Rust side
 *  caches provider answers for 60 s, so this is cheap, and it touches no
 *  addon. */
async function runProviderCheck(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const r = await invoke<CheckReply>("service_status", {
      action: { op: "check", aura: false, relay: null, addons: [], providers: ids },
    });
    updateSvc((s) => {
      const providers = { ...s.providers };
      for (const p of r.providers) providers[p.id] = p;
      return { ...s, providers };
    });
  } catch (e) {
    console.warn("[status] provider check failed:", e);
  }
}

/** Addons only, for urls the list gained after a check read it. Probes just
 *  those: a full round per list change would break the "never more often than
 *  the poll" rule for every other addon, and this leaves the poll's clock alone. */
async function probeNewAddons(): Promise<void> {
  const known = serviceState.svc.addons;
  const fresh = checkableAddonUrls().filter((u) => !known.has(u) && !addonUrlsAsked.has(u));
  if (fresh.length === 0) return;
  for (const u of fresh) addonUrlsAsked.add(u);
  try {
    const r = await invoke<CheckReply>("service_status", {
      action: { op: "check", aura: false, relay: null, addons: fresh, providers: [] },
    });
    for (const u of fresh) addonUrlsAsked.delete(u);
    updateSvc((s) => ({ ...s, addons: mergeAddonProbes(s.addons, fresh, r.addons) }));
  } catch (e) {
    console.warn("[status] new addon check failed:", e);
  }
}

export default function ServiceStatusChip() {
  // ── Cloud sync (the old chip, logic unchanged) ────────────────────────────
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [syncErrored, setSyncErrored] = useState(false);
  // Tick so the relative readouts refresh without waiting for a poll.
  const [tickNow, setTickNow] = useState(() => Date.now());

  // Guards a late reply landing after unmount. Set on mount (not just at
  // declaration) so a StrictMode double-mount re-arms it.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // Only the newest request's reply is applied, so a late answer (a stale
  // failure, the account before a switch) cannot overwrite a newer one.
  const syncSeqRef = useRef(0);
  const syncInFlightRef = useRef(0);
  const refreshSync = useCallback(async () => {
    const seq = ++syncSeqRef.current;
    syncInFlightRef.current += 1;
    try {
      const s = await invoke<SyncStatus>("sync_status");
      if (!aliveRef.current || seq !== syncSeqRef.current) return;
      setSyncStatus(s);
      setSyncErrored(false);
    } catch {
      if (!aliveRef.current || seq !== syncSeqRef.current) return;
      setSyncErrored(true);
    } finally {
      syncInFlightRef.current -= 1;
    }
  }, []);

  // ── Services ──────────────────────────────────────────────────────────────
  // Module-level (see "Service state" above), so a remount keeps it.
  const { svc, checking } = useSyncExternalStore(subscribeService, getServiceState, getServiceState);
  const [monitored, setMonitored] = useState<string[]>(() => loadAuraSettings().monitoredProviders);
  const providersRef = useRef(svc.providers);
  providersRef.current = svc.providers;
  const { addons, settled } = useStatusAddons();

  // A finished check moves the relative readouts at once, not at the next tick.
  useEffect(() => {
    if (svc.checkedAt != null) setTickNow(Date.now());
  }, [svc.checkedAt]);

  useEffect(() => {
    void refreshSync();
    // Session transitions refresh the sync half at once; without the listener
    // it would lag up to a poll after sign-in. Settings changes (an account
    // switch dispatches one) refresh it too, but coalesced: a slider sweep
    // dispatches one per input event, and each overlapping request is its own
    // TLS connection. A change to the monitored providers checks just the
    // newly added ones.
    let debounce: number | null = null;
    const cancelDebounce = () => {
      if (debounce != null) window.clearTimeout(debounce);
      debounce = null;
    };
    const scheduleSyncRefresh = () => {
      cancelDebounce();
      // A reply to a request made before this event may describe the old
      // account, and a newer request is now guaranteed to follow.
      syncSeqRef.current += 1;
      debounce = window.setTimeout(() => {
        debounce = null;
        if (syncInFlightRef.current > 0) scheduleSyncRefresh();
        else void refreshSync();
      }, SYNC_SETTINGS_DEBOUNCE_MS);
    };
    const onSession = () => {
      cancelDebounce();
      void refreshSync();
    };
    const onSettings = (e: Event) => {
      scheduleSyncRefresh();
      const keys = (e as CustomEvent<{ keys?: string[] }>).detail?.keys;
      if (keys && !keys.includes("monitoredProviders")) return;
      const next = loadAuraSettings().monitoredProviders;
      setMonitored((prev) =>
        prev.length === next.length && prev.every((id, i) => id === next[i]) ? prev : next);
      const fresh = next.filter((id) => !providersRef.current[id]);
      if (fresh.length > 0 && !isWindowHidden()) void runProviderCheck(fresh);
    };
    window.addEventListener("aura:settings-changed", onSettings);
    window.addEventListener("aura:session-changed", onSession);
    return () => {
      cancelDebounce();
      window.removeEventListener("aura:settings-changed", onSettings);
      window.removeEventListener("aura:session-changed", onSession);
    };
  }, [refreshSync]);

  // First check: once the addon list has settled, or after a fallback delay.
  // Skipped while hidden (launch to tray): the interval's resume catch-up
  // covers it the moment the window shows.
  useEffect(() => {
    if (firstCheckDone) {
      // A REMOUNT (the title bar comes back after fullscreen): the module
      // still holds the last snapshot, so the poll's tick below decides. Only
      // a check already overdue goes now rather than a tick from now.
      if (!isWindowHidden() && fullCheckDue()) void runFullCheck();
      return;
    }
    const go = () => {
      if (firstCheckDone) return;
      firstCheckDone = true;
      if (!isWindowHidden()) void runFullCheck();
    };
    if (settled) { go(); return; }
    const id = window.setTimeout(go, FIRST_CHECK_FALLBACK_MS);
    return () => window.clearTimeout(id);
  }, [settled]);

  // A list that changed after a check read it: the list settling late, a
  // sign-in, an install. Runs after the effect above, so a settle has already
  // taken the first check. Unprobed rows produce no issue, so without this the
  // chip reads all clear with the new addons unchecked until the next poll.
  // Hidden: the tick below picks it up on resume.
  useEffect(() => {
    if (!firstCheckDone) return;
    const id = window.setTimeout(() => {
      if (!isWindowHidden()) void probeNewAddons();
    }, NEW_ADDON_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [addons]);

  // The chip is invisible while minimized, so everything pauses there, and
  // `runOnResume` snaps each one current on the way back in.
  useIdleGatedInterval(() => { void refreshSync(); }, SYNC_POLL_MS, { runOnResume: true });
  useIdleGatedInterval(() => {
    setTickNow(Date.now());
    // Not before the first check: that one waits for the addon list to settle.
    if (!firstCheckDone) return;
    if (fullCheckDue()) void runFullCheck();
    else void probeNewAddons();
  }, TICK_INTERVAL_MS, { runOnResume: true });

  // ── Derived: sync ─────────────────────────────────────────────────────────
  const lastSyncMs = useMemo(() => {
    if (!syncStatus?.namespaces?.length) return null;
    const max = syncStatus.namespaces.reduce(
      (acc, ns) => (ns.updated_at && ns.updated_at > acc ? ns.updated_at : acc),
      0,
    );
    return max > 0 ? max * 1000 : null;
  }, [syncStatus]);

  const syncState: SyncState = useMemo(() => {
    // Alone, with no `connected` test: a guest is answered Ok by Rust, so a
    // failure proves a session, including one whose last reply predates it.
    if (syncErrored) return "error";
    if (!syncStatus || !syncStatus.connected) return "guest";
    if (lastSyncMs != null && tickNow - lastSyncMs > STALE_WINDOW_MS) return "stale";
    return "ok";
  }, [syncErrored, syncStatus, lastSyncMs, tickNow]);

  const syncLine = useMemo(() => {
    if (syncState === "guest") return "Cloud sync off: sign in to Stremio to enable";
    if (syncState === "error") return "Cloud sync: last status check failed";
    if (lastSyncMs) return `Cloud sync: last activity ${formatAgo(tickNow - lastSyncMs)}`;
    return "Cloud sync: connected (no data yet)";
  }, [syncState, lastSyncMs, tickNow]);

  // ── Derived: rows, overall state, summary ─────────────────────────────────
  const relayUrl = svc.relayUrl ?? normalizeRelayUrl(getRelayUrl());
  const monitoredDefs = useMemo(
    () => monitored.map((id) => statusProvider(id)).filter((p): p is NonNullable<typeof p> => !!p),
    [monitored],
  );

  const issues = useMemo(() => {
    const out: { level: Level; text: string }[] = [];
    const auraLv = probeLevel(svc.aura);
    if (auraLv === "down") out.push({ level: auraLv, text: "Aura server unreachable" });
    else if (auraLv === "warn") out.push({ level: auraLv, text: "Aura server slow" });
    const syncLv = SYNC_LEVEL[syncState];
    if (syncLv === "down") out.push({ level: syncLv, text: "Cloud sync check failed" });
    else if (syncLv === "warn") out.push({ level: syncLv, text: "Cloud sync idle for over a week" });
    const relayLv = probeLevel(svc.relay);
    if (relayLv === "down") out.push({ level: relayLv, text: "Watch Together relay unreachable" });
    else if (relayLv === "warn") out.push({ level: relayLv, text: "Watch Together relay slow" });
    for (const a of addons) {
      const lv = probeLevel(svc.addons.get(a.url));
      if (lv === "down") out.push({ level: lv, text: `${a.name}: not answering` });
      else if (lv === "warn") out.push({ level: lv, text: `${a.name}: slow` });
    }
    for (const def of monitoredDefs) {
      const r = svc.providers[def.id];
      const lv = providerLevel(r);
      if ((lv === "down" || lv === "warn") && r) out.push({ level: lv, text: `${def.name}: ${PROVIDER_WORD[r.state].toLowerCase()}` });
    }
    // Worst first, so the tooltip leads with what matters.
    return out.sort((a, b) => RANK[b.level] - RANK[a.level]);
  }, [svc, syncState, addons, monitoredDefs]);

  const anyOk = useMemo(() => {
    if (probeLevel(svc.aura) === "ok" || probeLevel(svc.relay) === "ok" || syncState === "ok") return true;
    if (addons.some((a) => probeLevel(svc.addons.get(a.url)) === "ok")) return true;
    return monitoredDefs.some((d) => providerLevel(svc.providers[d.id]) === "ok");
  }, [svc, syncState, addons, monitoredDefs]);

  const offline = useMemo(() => readsOffline(svc), [svc]);

  const chipState: ChipState = useMemo(() => {
    const worst = issues[0]?.level;
    if (worst === "down") return "down";
    if (svc.checkedAt == null) return "checking";
    if (svc.failed) return "warn";
    if (worst === "warn") return "warn";
    return anyOk ? "ok" : "idle";
  }, [issues, svc.checkedAt, svc.failed, anyOk]);

  const summary = useMemo(() => {
    if (offline) return "Could not reach any service: check your connection";
    if (chipState === "checking") return "Checking services...";
    if (svc.failed) return "Service check could not run";
    if (issues.length === 0) return anyOk ? "All services operational" : "Nothing to monitor yet";
    if (issues.length === 1) return issues[0].text;
    const head = issues.slice(0, 2).map((i) => i.text).join(", ");
    const rest = issues.length - 2;
    return `${issues.length} issues: ${head}${rest > 0 ? `, +${rest} more` : ""}`;
  }, [offline, chipState, svc.failed, issues, anyOk]);

  // ── Panel ─────────────────────────────────────────────────────────────────
  const phase = useStatusPanelPhase();
  const downloadsPhase = useDownloadsPanelPhase();
  const [anchorLeft, setAnchorLeft] = useState(8);
  // Providers section edit mode: every supported provider as a toggle row.
  const [editingProviders, setEditingProviders] = useState(false);
  const firstToggleRef = useRef<HTMLButtonElement>(null);
  // Set by the empty-state button, which unmounts as edit mode starts: focus
  // would otherwise fall to <body> and a keyboard user would lose their place.
  const focusToggleRef = useRef(false);
  // The reverse transition: Done with nothing ticked hides the header button
  // (the empty-state row replaces it), so the focused Done unmounts and focus
  // goes to the button that took its job.
  const emptyStateRef = useRef<HTMLButtonElement>(null);
  const focusEmptyRef = useRef(false);
  useEffect(() => {
    if (editingProviders && focusToggleRef.current) {
      focusToggleRef.current = false;
      firstToggleRef.current?.focus();
    } else if (!editingProviders && focusEmptyRef.current) {
      focusEmptyRef.current = false;
      emptyStateRef.current?.focus();
    }
  }, [editingProviders]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The panel's scrolling list. The arrow keys scroll it from outside it too:
  // see the panel root's onKeyDown.
  const listRef = useRef<HTMLDivElement>(null);
  // Set by a KEYBOARD open, read once the panel has rendered: focus moves INTO
  // the dialog. It is portalled to the end of <body>, so without this a keyboard
  // user's next Tab went to the Downloads button and then through the whole
  // app before reaching "Check again". The frame's wait is no longer needed (the
  // Tooltip around the trigger only blurs after a mouse press) but is harmless.
  // Never for a mouse open: focus on the panel takes the player's volume keys,
  // and Escape would hand it to the trigger, whose Tooltip then opens and stays.
  const focusPanelRef = useRef(false);
  // The last thing done inside the panel was a mouse press (Tab clears it), so
  // the focus in there is not a keyboard user's place to hand back on Escape.
  const pointerInPanelRef = useRef(false);
  useEffect(() => {
    if (phase !== "open" || !focusPanelRef.current) return;
    focusPanelRef.current = false;
    const id = requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, [phase]);

  const closePanel = useCallback((opts?: { restoreFocus?: boolean }) => {
    // Escape: hand focus back to the trigger BEFORE the panel unmounts, or the
    // focused control goes with it and focus falls to <body>. Only when focus
    // is inside the panel and got there by keyboard, so a close never pulls focus
    // from elsewhere; an outside click leaves focus where that click put it.
    if (opts?.restoreFocus && !pointerInPanelRef.current && panelRef.current?.contains(document.activeElement)) {
      triggerRef.current?.focus({ preventScroll: true });
    }
    closeStatusPanel();
  }, []);

  // The panel goes with the chip when the title bar unmounts for fullscreen.
  useEffect(() => () => closeStatusPanelImmediate(), []);

  // Both panels open at the same spot. openPanel closes Downloads itself; this
  // is the other direction, for what opens it with no click to dismiss this one
  // (a source's right-click Download, the Downloads button from the keyboard).
  useEffect(() => {
    if (downloadsPhase === "open" && phase === "open") closePanel();
  }, [downloadsPhase, phase, closePanel]);

  const openPanel = useCallback((fromKeyboard: boolean) => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setAnchorLeft(Math.max(8, Math.round(rect.left) - 4));
    // Every open starts on the status view: edit mode is a moment's task, and
    // reopening the panel into a list of checkboxes would hide the statuses.
    setEditingProviders(false);
    focusPanelRef.current = fromKeyboard;
    pointerInPanelRef.current = false;
    // Both panels open at the same spot, and the Downloads guard exempts the
    // whole title bar, so it would stay open underneath this one.
    closeDownloadsPanel();
    openStatusPanel();
    void refreshSync();
    if (Date.now() - lastFullAt >= OPEN_REFRESH_MIN_MS) void runFullCheck();
  }, [refreshSync]);

  const togglePanel = (e: ReactMouseEvent) => {
    if (phase === "open") closePanel();
    // detail is the click count: 0 for Enter / Space on the focused button.
    else openPanel(e.detail === 0);
  };

  useEffect(() => {
    if (phase !== "open") return;
    const onMouseDown = (e: MouseEvent) => {
      // Left button only: a right-click or a middle-click is not a dismissal
      // gesture anywhere else in the app (same rule as the Downloads panel).
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest("[data-service-status-panel]")) return;
      if (t.closest("[data-service-status-trigger]")) return;
      if (t.closest("[data-aura-context-menu]")) return;
      // The Performance Monitor floats over the app, it is not part of the page.
      if (t.closest("[data-perf-monitor]")) return;
      closePanel();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // A card's menu takes this Esc. Not stopped: its own capture listener runs
      // next, closes the menu and keeps the key from App.
      if (document.querySelector("[data-aura-context-menu]")) return;
      e.stopPropagation();
      closePanel({ restoreFocus: true });
    };
    // Capture phase, but that alone does not save a dismissing click on the
    // video from toggling pause: App feeds this panel's phase into
    // PlayerOverlay's anyMenuOpen, and "closing" holds it through the click.
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    const releaseKeys = keepPanelKeysFromPlayer("[data-service-status-panel]");
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      releaseKeys();
    };
  }, [phase, closePanel]);

  // Settings cannot open during playback: the page would switch under the
  // player and the detail page the user came from would be closed.
  const inPlayback = isPlayerActive();

  const openSettingsCloudSync = () => {
    closePanel();
    window.dispatchEvent(new CustomEvent("aura:open-settings", {
      detail: { section: "sec-cloud-sync" },
    }));
  };

  const toggleProvider = (id: string) => {
    const s = loadAuraSettings();
    const set = new Set(s.monitoredProviders);
    if (set.has(id)) set.delete(id); else set.add(id);
    // Catalogue order, so the rows never reshuffle as the user ticks boxes.
    const next = STATUS_PROVIDERS.map((p) => p.id).filter((pid) => set.has(pid));
    saveAuraSettings({ ...s, monitoredProviders: next });
  };

  const tooltipContent = (
    <span className="flex flex-col gap-0.5">
      <span>{summary}</span>
      <span className="text-white/55">{syncLine}</span>
    </span>
  );

  return (
    <>
      <Tooltip text={`${summary}. ${syncLine}`} content={tooltipContent} pos="bottom">
        <button
          ref={triggerRef}
          type="button"
          onClick={togglePanel}
          aria-label={`Service status: ${summary}`}
          aria-haspopup="dialog"
          aria-expanded={phase === "open"}
          data-no-drag
          data-service-status-trigger
          className="flex items-center justify-center w-8 h-full transition-opacity hover:opacity-100"
          style={{
            color: COLOR[chipState],
            opacity: phase === "open" ? 1 : chipState === "idle" ? 0.45 : chipState === "checking" ? 0.55 : 0.78,
            pointerEvents: "auto",
          }}
        >
          <CloudIcon state={chipState} />
        </button>
      </Tooltip>
      {phase !== "closed" && createPortal(
        <div
          ref={panelRef}
          data-service-status-panel
          role="dialog"
          aria-label="Service status"
          // Focusable by script only (a keyboard open), so the dialog itself
          // takes focus and Tab continues into its controls. A click on bare
          // panel content lands here too. No ring: it is a landing spot, not a
          // control.
          tabIndex={-1}
          className={[
            "outline-none",
            // aura-dl-panel's entry / exit keyframes are generic (a short drop
            // and scale from the top-left) and already honour reduced motion.
            "aura-dl-panel aura-float-glass fixed z-[10048] flex flex-col",
            // Arbitrary values on purpose: tailwind.config.ts replaces the
            // maxWidth scale, so every named token emits nothing.
            "w-[360px] max-w-[calc(100vw-24px)] max-h-[min(560px,calc(100vh-72px))]",
            "rounded-2xl overflow-hidden",
            phase === "closing" ? "aura-dl-panel-out pointer-events-none" : "aura-dl-panel-in",
          ].join(" ")}
          style={{ top: SIDE_PILL_TOP_PX, left: anchorLeft }}
          // Never reaches the player's window-level volume wheel. The list
          // still scrolls: this stops propagation, not the default.
          onWheel={(e) => e.stopPropagation()}
          onMouseDownCapture={() => { pointerInPanelRef.current = true; }}
          onKeyDown={(e) => {
            if (e.key === "Tab") pointerInPanelRef.current = false;
            // keepPanelKeysFromPlayer keeps Up / Down from the volume everywhere
            // in the panel. Inside the list the browser scrolls it; from the
            // root and the header it would not, because the browser walks UP
            // from the focused node and the list is not above those.
            if (e.code !== "ArrowUp" && e.code !== "ArrowDown") return;
            if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
            const list = listRef.current;
            if (!list || list.contains(e.target as Node)) return;
            e.preventDefault();
            list.scrollBy({ top: e.code === "ArrowUp" ? -ARROW_SCROLL_PX : ARROW_SCROLL_PX });
          }}
        >
          <header className="flex items-center gap-2 px-3.5 pt-3 pb-2.5 border-b border-white/8">
            <div className="flex-1 min-w-0">
              <h2 className="text-[13px] font-semibold text-white/85 truncate">Service status</h2>
              <p className="text-[11px] text-white/45 truncate">
                {checking
                  ? "Checking..."
                  : svc.checkedAt
                    ? `${offline ? "Offline? " : ""}Checked ${formatAgo(tickNow - svc.checkedAt)}`
                    : "Not checked yet"}
              </p>
            </div>
            <Tooltip text="Check again" pos="bottom">
              <button
                type="button"
                // aria-disabled, not disabled: a focused button that goes disabled
                // can drop focus to <body>, where the next key reaches the player.
                onClick={() => { if (!checking) { void refreshSync(); void runFullCheck(); } }}
                aria-disabled={checking}
                aria-label="Check again"
                className={`w-7 h-7 flex items-center justify-center rounded-md text-white/55
                           hover:text-white hover:bg-white/10 transition-colors${checking ? " opacity-40" : ""}`}
              >
                <RefreshIcon spinning={checking && !readReducedMotion()} />
              </button>
            </Tooltip>
          </header>

          <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-2 py-2">
            <Section title="Aura">
              <Row
                level={probeLevel(svc.aura)}
                label="Aura server"
                detail={probeDetail(svc.aura, checking)}
                hint={["Sign-in links, Aura Cloud and release search", ...latencyLines(svc.aura)]}
              />
              <Row
                level={SYNC_LEVEL[syncState]}
                label="Cloud sync"
                detail={syncState === "guest" ? "Off: sign in to Stremio" : syncLine.replace(/^Cloud sync: /, "")}
                onClick={inPlayback ? undefined : openSettingsCloudSync}
                hint={inPlayback ? "Available after playback" : "Open Cloud Sync settings"}
              />
              {relayUrl && (
                <Row
                  level={probeLevel(svc.relay)}
                  label="Watch Together relay"
                  detail={`${addonHost(relayUrl)} · ${probeDetail(svc.relay, checking)}`}
                  hint={latencyLines(svc.relay)}
                />
              )}
            </Section>

            <Section
              title="Providers"
              action={
                // Hidden with nothing monitored: the empty-state row below is
                // the one way in then, and two buttons for it would be noise.
                monitoredDefs.length > 0 || editingProviders ? (
                  <button
                    type="button"
                    onClick={() => {
                      // Ref, not state: only read by the effect after this
                      // render. Same test as the empty-state branch below.
                      if (editingProviders && monitoredDefs.length === 0) focusEmptyRef.current = true;
                      setEditingProviders((v) => !v);
                    }}
                    aria-expanded={editingProviders}
                    // The accessible name starts with the visible word (WCAG
                    // 2.5.3), so a voice-control "click Edit" finds it.
                    aria-label={editingProviders ? "Done choosing providers" : "Edit monitored providers"}
                    className="text-[10.5px] font-medium px-1.5 py-0.5 rounded-md text-white/50
                               hover:text-white hover:bg-white/10 transition-colors"
                  >
                    {editingProviders ? "Done" : "Edit"}
                  </button>
                ) : undefined
              }
            >
              {editingProviders ? (
                <>
                  {STATUS_PROVIDERS.map((def, i) => {
                    const on = monitored.includes(def.id);
                    const r = on ? svc.providers[def.id] : undefined;
                    const kind = def.source === "status" ? "Status page" : "API check only";
                    return (
                      <ProviderToggleRow
                        key={def.id}
                        ref={i === 0 ? firstToggleRef : undefined}
                        on={on}
                        label={def.name}
                        detail={r ? `${kind} · ${PROVIDER_WORD[r.state]}` : kind}
                        hint={def.source === "ping"
                          ? "No status page: this only checks that the API answers"
                          : "Reads the provider's own status page"}
                        onToggle={() => toggleProvider(def.id)}
                      />
                    );
                  })}
                  <p className="px-2 pt-1 pb-0.5 text-[10.5px] leading-snug text-white/40">
                    Offcloud and usenet providers publish no status feed Aura can read.
                  </p>
                </>
              ) : monitoredDefs.length === 0 ? (
                <button
                  ref={emptyStateRef}
                  type="button"
                  onClick={() => { focusToggleRef.current = true; setEditingProviders(true); }}
                  className="flex items-center gap-2.5 w-full text-left px-2 py-1.5 rounded-lg
                             text-[12px] text-white/60 hover:text-white hover:bg-white/8 transition-colors"
                >
                  <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"
                       strokeLinecap="round" aria-hidden className="shrink-0">
                    <path d="M12 4v16M4 12h16" />
                  </svg>
                  Choose debrid services to monitor
                </button>
              ) : (
                monitoredDefs.map((def) => {
                  const r = svc.providers[def.id];
                  const lv = providerLevel(r);
                  const detail = !r
                    ? (checking ? "Checking..." : "Not checked yet")
                    : r.reachability_only
                      ? (r.state === "operational" ? "API answering" : (r.summary ?? PROVIDER_WORD[r.state]))
                      : [PROVIDER_WORD[r.state], r.summary].filter(Boolean).join(": ");
                  const extra = r ? [...r.incidents, ...r.components] : [];
                  return (
                    <Row
                      key={def.id}
                      level={lv}
                      label={def.name}
                      detail={detail}
                      hint={r?.reachability_only ? "No status page: this only checks that the API answers" : undefined}
                      extra={extra}
                      trailing={def.statusPage ? (
                        <button
                          type="button"
                          onClick={() => openExternalUrl(def.statusPage!)}
                          className="shrink-0 text-[11px] px-1.5 py-0.5 rounded-md text-white/50
                                     hover:text-white hover:bg-white/10 transition-colors"
                        >
                          Status page
                        </button>
                      ) : undefined}
                    />
                  );
                })
              )}
            </Section>

            <Section title={`Addons${addons.length ? ` (${addons.length})` : ""}`}>
              {addons.length === 0 ? (
                <p className="px-2 py-1.5 text-[11.5px] text-white/45">No addons installed.</p>
              ) : (
                addons.map((a, i) => {
                  const p = svc.addons.get(a.url);
                  return (
                    <Row
                      key={`${i}:${a.url}`}
                      level={p ? probeLevel(p) : isCheckable(a.url) ? "pending" : "idle"}
                      label={a.name || "Unnamed addon"}
                      detail={`${addonHost(a.url)} · ${isCheckable(a.url) ? probeDetail(p, checking) : "Not checkable"}`}
                      hint={latencyLines(p)}
                    />
                  );
                })
              )}
            </Section>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-1.5 last:mb-0">
      {/* Fixed height, so the header does not jump when the action appears or
          its label changes. */}
      <div className="flex items-center gap-2 h-6 px-2">
        <h3 className="flex-1 min-w-0 truncate text-[10.5px] font-semibold uppercase tracking-wider text-white/40">
          {title}
        </h3>
        {action}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({
  level, label, detail, hint, onClick, trailing, extra,
}: {
  level: Level;
  label: string;
  detail: string;
  /** One line, or several (rendered one per line in the tooltip). */
  hint?: string | string[];
  onClick?: () => void;
  trailing?: ReactNode;
  extra?: string[];
}) {
  const body = (
    <>
      <StatusDot level={level} />
      <span className="flex-1 min-w-0">
        <span className="block text-[12.5px] text-white/85 truncate">{label}</span>
        <span className="block text-[11px] text-white/50 truncate">{detail}</span>
        {extra && extra.length > 0 && (
          <span className="block mt-0.5">
            {extra.map((x, i) => (
              <span key={i} className="block text-[11px] leading-snug truncate" style={{ color: COLOR[level] }}>
                {x}
              </span>
            ))}
          </span>
        )}
      </span>
    </>
  );
  const cls = "flex items-start gap-2.5 w-full text-left px-2 py-1.5 rounded-lg";
  const row = onClick ? (
    <button type="button" onClick={onClick} className={`${cls} hover:bg-white/8 transition-colors`}>
      {body}
      {trailing}
    </button>
  ) : (
    <div className={cls}>
      {body}
      {trailing}
    </div>
  );
  const lines = hint == null ? [] : Array.isArray(hint) ? hint : [hint];
  if (lines.length === 0) return row;
  return (
    <Tooltip
      text={lines.join(". ")}
      content={lines.length > 1 ? (
        <span className="flex flex-col gap-0.5">
          {lines.map((l, i) => <span key={i} className={i === 0 ? undefined : "text-white/60"}>{l}</span>)}
        </span>
      ) : undefined}
      pos="right"
      className="w-full"
    >
      {row}
    </Tooltip>
  );
}

function StatusDot({ level }: { level: Level }) {
  // Filled for a judged state, a hollow ring for "not judged": the state word
  // in the row's detail line carries the meaning too, so colour is never the
  // only signal.
  const hollow = level === "idle" || level === "pending";
  return (
    <span
      aria-hidden
      className="mt-[5px] shrink-0 w-2 h-2 rounded-full"
      style={hollow
        ? { boxShadow: `inset 0 0 0 1.5px ${COLOR[level]}` }
        : { background: COLOR[level], boxShadow: `0 0 6px ${COLOR[level]}` }}
    />
  );
}

/** Edit-mode row of the Providers section: the same geometry as `Row`, with a
 *  checkbox where the status dot sits, so switching modes does not move the
 *  names. Toggling saves at once; the settings-changed listener checks a newly
 *  ticked provider. */
function ProviderToggleRow({
  ref, on, label, detail, hint, onToggle,
}: {
  ref?: Ref<HTMLButtonElement>;
  on: boolean;
  label: string;
  detail: string;
  hint: string;
  onToggle: () => void;
}) {
  return (
    <Tooltip text={hint} pos="right" className="w-full">
      <button
        ref={ref}
        type="button"
        role="checkbox"
        aria-checked={on}
        onClick={onToggle}
        className="flex items-start gap-2.5 w-full text-left px-2 py-1.5 rounded-lg hover:bg-white/8 transition-colors"
      >
        <span
          aria-hidden
          // The dot is 8 px at mt-[5px]; this box is 12 px, so it starts 2 px
          // higher to share the dot's centre line.
          className="mt-[3px] w-3 h-3 shrink-0 rounded-[3px] flex items-center justify-center"
          style={{
            boxShadow: on ? undefined : "inset 0 0 0 1.5px rgba(255,255,255,0.35)",
            background: on ? "var(--ln-accent)" : "transparent",
          }}
        >
          {on && (
            <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="#000" strokeWidth="4"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12.5l4.5 4.5L19 7.5" />
            </svg>
          )}
        </span>
        <span className="flex-1 min-w-0">
          <span className={`block text-[12.5px] truncate ${on ? "text-white/85" : "text-white/60"}`}>{label}</span>
          <span className="block text-[11px] text-white/45 truncate">{detail}</span>
        </span>
      </button>
    </Tooltip>
  );
}

/** Compact relative-time formatter. Deliberately NO seconds bucket: the
 *  clock behind this advances every TICK_INTERVAL_MS, so a "42s ago" reading
 *  would be wrong the instant after it rendered and would sit frozen until the
 *  next tick; "just now" is true for the whole sub-minute window. Matches
 *  SettingsView's formatAgo. If you ever want real seconds here, the tick has
 *  to drop to 1 s with it (same rule as releaseCountdown.ts::showsSeconds). */
function formatAgo(diffMs: number): string {
  if (diffMs < 0) return "just now";
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(diffMs / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(diffMs / 3_600_000);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(diffMs / 86_400_000);
  if (day < 30) return `${day}d ago`;
  const mon = Math.round(diffMs / (86_400_000 * 30));
  if (mon < 12) return `${mon}mo ago`;
  const yr = Math.round(diffMs / (86_400_000 * 365));
  return `${yr}y ago`;
}

function CloudIcon({ state }: { state: ChipState }) {
  // Cloud silhouette (continuity with the old sync chip: these are all
  // network services) with a mark per state, so a glance reads the status
  // without parsing colour alone.
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M17 18a4 4 0 0 0 0-8 6 6 0 0 0-11.7-1.5A4 4 0 0 0 6 18h11Z" />
      {state === "ok"       && <path d="M9 13.5l2 2 4-4" />}
      {state === "warn"     && <path d="M12 11v3M12 16v0.1" />}
      {state === "down"     && <path d="M9.5 12l5 4M14.5 12l-5 4" />}
      {state === "checking" && <path d="M9 14h0.1M12 14h0.1M15 14h0.1" strokeWidth="2.2" />}
    </svg>
  );
}

function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={spinning ? "animate-spin" : undefined}
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}
