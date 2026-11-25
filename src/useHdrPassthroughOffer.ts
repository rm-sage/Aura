// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The one-time "Send HDR?" bell offer (mounted in App's NotificationsBridge,
// inside NotificationsProvider).
//
// On a device whose display reports HDR supported AND on in Windows while the
// HDR mode is still Convert ("sdr"), raise one bell notice asking whether to
// switch to Send HDR. Its "Turn on" (NotificationsPanel) writes through
// hdrMode.setHdrMode. Rules:
//   - once per device: the device-local flag is set the moment it is raised,
//     so it never repeats, and a choice made by hand or the first-run default
//     (hdrMode.ts) spends it too, so a first-run user never gets it;
//   - never on the landing screen or while the setup wizard is up (the caller
//     passes `eligible` false), and it waits for a first-run default decision
//     or the Off migration still in flight;
//   - bell only while a popup would be held (playback, detail page): the
//     NotificationsContext popup suppression already does that;
//   - once Send HDR is on, by any route, the notice goes away.
// The check runs when the bridge becomes eligible and again on window focus
// (the user may turn on HDR in Windows later), at most once a minute, and
// stops for good once the flag is set. Never polled.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useNotifications } from "./NotificationsContext";
import type { AppSettingsLike } from "./backendSettings";
import {
  HDR_MODE_CHANGED_EVENT,
  HDR_OFFER_DATA_KIND,
  HDR_OFFER_NOTICE_ID,
  displayReadyForHdr,
  hdrModeOf,
  hdrOfferAsked,
  markHdrOfferAsked,
  pendingHdrDecisions,
  probeDisplayHdr,
  type HdrMode,
} from "./hdrMode";

const RECHECK_MIN_MS = 60_000;

export function useHdrPassthroughOffer(eligible: boolean): void {
  const { addNotification, dismissNotification } = useNotifications();

  // Send HDR turned on anywhere (this notice's button, Settings, the
  // wizard): the offer has nothing left to ask.
  useEffect(() => {
    const onMode = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: HdrMode }>).detail?.mode;
      if (mode === "passthrough") dismissNotification(HDR_OFFER_NOTICE_ID);
    };
    window.addEventListener(HDR_MODE_CHANGED_EVENT, onMode);
    return () => window.removeEventListener(HDR_MODE_CHANGED_EVENT, onMode);
  }, [dismissNotification]);

  useEffect(() => {
    if (!eligible) return;
    let alive = true;
    let lastCheck = 0;
    let running = false;
    const check = async () => {
      const now = Date.now();
      if (running || now - lastCheck < RECHECK_MIN_MS) return;
      running = true;
      lastCheck = now;
      try {
        // A first-run default still being decided spends the offer itself,
        // and the Off migration may be about to move the mode to Convert.
        await pendingHdrDecisions();
        if (!alive) return;
        const settings = await invoke<AppSettingsLike>("get_settings").catch(() => null);
        if (!alive || !settings) return;
        const mode = hdrModeOf(settings);
        // Already on Send HDR (switched since a notice was raised, maybe on
        // a launch that never saw the event): clear a leftover notice.
        // Nothing left to offer on this device either.
        if (mode === "passthrough") {
          dismissNotification(HDR_OFFER_NOTICE_ID);
          markHdrOfferAsked();
          return;
        }
        if (hdrOfferAsked() || mode !== "sdr") return;
        const info = await probeDisplayHdr();
        if (!alive || hdrOfferAsked() || !displayReadyForHdr(info)) return;
        markHdrOfferAsked();
        addNotification({
          id: HDR_OFFER_NOTICE_ID,
          kind: "notice",
          title: "Your display has HDR on",
          subtitle: "Send HDR videos to it for brighter highlights and richer colour? Normal videos look the same.",
          data: { kind: HDR_OFFER_DATA_KIND, settingsSection: "sec-video-audio" },
        });
      } finally {
        running = false;
      }
    };
    void check();
    const onFocus = () => { if (!hdrOfferAsked()) void check(); };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [eligible, addNotification, dismissNotification]);
}
