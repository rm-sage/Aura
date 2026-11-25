// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The "Audio order updated" bell notice, raised once when the one-time audio
// order repair (audioPriorityRepair.ts) changed the list. Mounted in App's
// NotificationsBridge beside useMaterialNotice, under the same gate (past
// landing and the setup wizard). The repair parks the notice; this hook
// raises it when eligible, at once or when the repair's event fires.
// Device-local (sync.ts isDeviceLocalNotification): its data names the
// settings scope, which never leaves the device. Its "Undo"
// (NotificationsPanel) restores the old list; that write, or any change of
// the list made by hand, answers the notice.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { useNotifications } from "./NotificationsContext";
import { AUDIO_ORDER_NOTICE_ID, describeAudioOrderRepair } from "./legacyAudioPriority";
import { AUDIO_ORDER_REPAIRED_EVENT, takePendingAudioOrderNotice } from "./audioPriorityRepair";

export function useAudioOrderNotice(eligible: boolean): void {
  const { addNotification, dismissNotification } = useNotifications();

  useEffect(() => {
    if (!eligible) return;
    const raise = () => {
      const data = takePendingAudioOrderNotice();
      if (!data) return;
      const { title, subtitle } = describeAudioOrderRepair(data.from, data.to);
      addNotification({
        id: AUDIO_ORDER_NOTICE_ID,
        kind: "notice",
        title,
        subtitle,
        data: { ...data, settingsSection: "sec-audio-tracks" },
      });
    };
    raise();
    window.addEventListener(AUDIO_ORDER_REPAIRED_EVENT, raise);
    return () => window.removeEventListener(AUDIO_ORDER_REPAIRED_EVENT, raise);
  }, [eligible, addNotification]);

  // A list set by hand (Undo included, never a cloud pull) answers the notice.
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ keys?: string[]; fromCloud?: boolean }>).detail;
      if (!d || d.fromCloud || !Array.isArray(d.keys)) return;
      if (d.keys.includes("audio_priority")) dismissNotification(AUDIO_ORDER_NOTICE_ID);
    };
    window.addEventListener("aura:backend-settings-changed", onChange);
    return () => window.removeEventListener("aura:backend-settings-changed", onChange);
  }, [dismissNotification]);
}
