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
  castLoad, castPause, castPlay, castSeek, castStatus, castStop,
  discoverCastDevices,
  type CastDeviceInfo, type CastStatus,
} from "./cast";

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

  const pickDevice = useCallback((device: CastDeviceInfo) => {
    const url = urlRef.current;
    if (!url) return;
    const gen = ++genRef.current;
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
        if (!pausedRef.current) {
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

  // 2 s device-status poll while a session is active. Consecutive
  // failures end the session (device powered off / app dismissed).
  useEffect(() => {
    if (!activeDevice) return;
    let failures = 0;
    const id = window.setInterval(() => {
      castStatus()
        .then((s) => {
          failures = 0;
          setStatus(s);
        })
        .catch(() => {
          failures += 1;
          if (failures >= 4) {
            setActiveDevice(null);
            setStatus(null);
          }
        });
    }, 2000);
    return () => window.clearInterval(id);
  }, [activeDevice]);

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
