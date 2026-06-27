// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// useCastSession — the casting state machine (per the 2026-06-09 spec's
// use-cast-session port).
//
// Owns: the device-picker open state + discovery results, the active
// session, a 2 s status poll (polls the CAST DEVICE, never libmpv —
// MPV landmines don't apply), and the local-playback handoff:
//   • cast start → pause local MPV (existing engine-gated toggle_pause)
//   • cast stop  → seek local MPV to the device's last position and
//     resume.
//
// Opened via the `aura:open-cast-menu` window event (dispatched from
// PlayerOverlay's MoreMenu — same decoupling pattern as the source
// switcher).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  castFfmpegPresent, castLoad, castPause, castPlay, castSeek, castStatus,
  castStop, discoverCastDevices, needsTransmux,
  type CastDeviceInfo, type CastStatus,
} from "./cast";
import { showAppToast } from "./AppToast";
import { isWindowHidden } from "./windowVisibility";

interface UseCastSessionArgs {
  /** Raw URL of the currently-playing stream (null = nothing playing). */
  streamUrl: string | null;
  /** Display title for the receiver ("Frieren — S01E05"). */
  title: string | null;
  /** Live local playback clock (seconds). */
  currentTime: number;
  /** Local MPV pause state — drives the pause-on-cast handoff. */
  paused: boolean;
}

export interface CastSession {
  menuOpen: boolean;
  closeMenu: () => void;
  devices: CastDeviceInfo[];
  scanning: boolean;
  rescan: () => void;
  /** Device of the ACTIVE cast session (null = not casting). */
  activeDevice: CastDeviceInfo | null;
  /** Device currently mid-connect (spinner in the picker). */
  connectingId: string | null;
  status: CastStatus | null;
  error: string | null;
  pickDevice: (d: CastDeviceInfo) => void;
  stopCasting: () => void;
  togglePlayPause: () => void;
  seekBy: (deltaSec: number) => void;
}

export function useCastSession({
  streamUrl, title, currentTime, paused,
}: UseCastSessionArgs): CastSession {
  const [menuOpen, setMenuOpen] = useState(false);
  const [devices, setDevices] = useState<CastDeviceInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [activeDevice, setActiveDevice] = useState<CastDeviceInfo | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [status, setStatus] = useState<CastStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs so event handlers / intervals read live values without
  // re-subscribing on every clock tick.
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const urlRef = useRef(streamUrl);
  urlRef.current = streamUrl;
  const titleRef = useRef(title);
  titleRef.current = title;
  // Generation counter: a stop/new-pick supersedes in-flight loads.
  const genRef = useRef(0);

  const rescan = useCallback(() => {
    setScanning(true);
    setError(null);
    discoverCastDevices()
      .then((list) => setDevices(list))
      .catch((e) => setError(String(e)))
      .finally(() => setScanning(false));
  }, []);

  // Open via the window event (PlayerOverlay MoreMenu / future buttons).
  useEffect(() => {
    const onOpen = () => {
      if (!urlRef.current) return;
      setMenuOpen(true);
      rescan();
    };
    window.addEventListener("aura:open-cast-menu", onOpen);
    return () => window.removeEventListener("aura:open-cast-menu", onOpen);
  }, [rescan]);

  // Actually begin a session. (pickDevice wraps this with the Chromecast
  // FFmpeg pre-flight below.)
  const startCast = useCallback((device: CastDeviceInfo, url: string) => {
    const gen = ++genRef.current;
    // Capture the pause state at INVOCATION time — castLoad can take a
    // second or two, and a user toggling local playback meanwhile must
    // not make the post-load handoff re-toggle the wrong way.
    const pausedAtPick = pausedRef.current;
    setConnectingId(device.id);
    setError(null);
    castLoad({
      device,
      url,
      title: titleRef.current,
      startSeconds: timeRef.current > 1 ? timeRef.current : 0,
    })
      .then(() => {
        if (genRef.current !== gen) return;
        setActiveDevice(device);
        setMenuOpen(false);
        // Hand off: quiet the local player while the TV plays.
        if (!pausedAtPick) {
          invoke("toggle_pause").catch(() => {});
        }
      })
      .catch((e) => {
        if (genRef.current !== gen) return;
        setError(String(e));
      })
      .finally(() => {
        if (genRef.current === gen) setConnectingId(null);
      });
  }, []);

  const pickDevice = useCallback((device: CastDeviceInfo) => {
    const url = urlRef.current;
    if (!url) return;
    // Pre-flight FFmpeg gate. A Chromecast Default Media Receiver cannot
    // open MKV/AVI/... containers; Aura transmuxes them to HLS via the
    // on-demand ffmpeg component (see cast/mod.rs cast_load). If ffmpeg is
    // absent the Rust side silently direct-plays an undecodable container
    // and the bar sits on "buffering" forever — so probe first and surface
    // an actionable error, staying on local playback, instead of starting
    // a doomed session. DLNA + HLS are unaffected.
    if (device.kind === "chromecast" && needsTransmux(url)) {
      setConnectingId(device.id);
      setError(null);
      castFfmpegPresent()
        .then((present) => {
          if (present) {
            startCast(device, url);
          } else {
            setConnectingId(null);
            setError(
              "This file needs the FFmpeg component to cast to Chromecast. " +
                "Install it in Settings > Components, or cast to a DLNA TV.",
            );
          }
        })
        // Probe itself failed: fall through and let the backend try (it may
        // still cope, or report its own error).
        .catch(() => startCast(device, url));
      return;
    }
    startCast(device, url);
  }, [startCast]);

  const stopCasting = useCallback(() => {
    genRef.current++;
    setActiveDevice(null);
    setStatus(null);
    castStop()
      .then((lastPos) => {
        // Resume locally where the TV left off.
        if (Number.isFinite(lastPos) && lastPos > 1) {
          invoke("seek_absolute", { time: lastPos }).catch(() => {});
        }
        if (pausedRef.current) {
          invoke("toggle_pause").catch(() => {});
        }
      })
      .catch(() => {});
  }, []);

  const togglePlayPause = useCallback(() => {
    const playing = status?.player_state === "playing";
    (playing ? castPause() : castPlay()).catch((e) => setError(String(e)));
  }, [status?.player_state]);

  const seekBy = useCallback((deltaSec: number) => {
    const pos = (status?.position_sec ?? 0) + deltaSec;
    castSeek(Math.max(0, pos)).catch((e) => setError(String(e)));
  }, [status?.position_sec]);

  // 2 s device-status poll while a session is active, with two auto-recovery
  // guards. Both route through stopCasting() — which tears down the Rust
  // session / heartbeat / media-server proxy AND resumes local playback where
  // the device left off — then surface a transient toast. Without this a
  // dropped or never-started device leaves the cast bar lingering while local
  // MPV stays paused with no controls and native resources leak (recovery used
  // to require an app restart).
  useEffect(() => {
    if (!activeDevice) return;
    const device = activeDevice;
    let failures = 0;
    let nonLivePolls = 0;
    let becameLive = false;
    let ended = false;

    const recover = (msg: string) => {
      if (ended) return;
      ended = true;
      stopCasting();
      showAppToast(msg, { tone: "danger" });
    };

    const id = window.setInterval(() => {
      if (ended) return;
      // Skip the device-status IPC while minimized/tray; the cast keeps running
      // on the device + Rust media server, and the UI catches up on restore.
      // Counting only polls we actually run also means a long minimize can't
      // trip the never-started timeout below.
      if (isWindowHidden()) return;
      castStatus()
        .then((s) => {
          failures = 0;
          setStatus(s);
          const live =
            s.player_state === "playing" ||
            s.player_state === "paused" ||
            s.player_state === "buffering";
          if (live) {
            becameLive = true;
          } else if (!becameLive) {
            // A receiver-side media error answers cast_status SUCCESSFULLY (so
            // `failures` never climbs) but the device never leaves idle/unknown.
            // After ~18 s of live polling, give up and return to local rather
            // than latching "connecting..." / a stale 0:00 forever.
            nonLivePolls += 1;
            if (nonLivePolls >= 9) {
              recover(`${device.name} didn't start playing - resumed local playback`);
            }
          }
        })
        .catch(() => {
          // Device powered off / dropped wifi: cast_status stops answering.
          failures += 1;
          if (failures >= 4) {
            recover(`Lost connection to ${device.name} - resumed local playback`);
          }
        });
    }, 2000);
    return () => window.clearInterval(id);
  }, [activeDevice, stopCasting]);

  return {
    menuOpen,
    closeMenu: () => setMenuOpen(false),
    devices,
    scanning,
    rescan,
    activeDevice,
    connectingId,
    status,
    error,
    pickDevice,
    stopCasting,
    togglePlayPause,
    seekBy,
  };
}
