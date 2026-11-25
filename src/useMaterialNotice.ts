// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The one-time "New look options" bell notice for installs that existed before
// Material style and Cursor glow (auraSettings.ts decideGlassDefaults owes
// it). Real glass over video is not named: it is shelved (realGlass.ts
// REAL_GLASS_AVAILABLE). Mounted in App's NotificationsBridge beside
// useHdrPassthroughOffer, under the same gate: past landing and the setup
// wizard. Device-local (sync.ts isDeviceLocalNotification). Spent the moment it
// is raised, and dismissed once the user changes either glass setting here.
// ---------------------------------------------------------------------------

import { useEffect } from "react";
import { useNotifications } from "./NotificationsContext";
import {
  MATERIAL_NOTICE_ID,
  materialNoticeOwed,
  settingsChangeIncludes,
  spendMaterialNotice,
  type AuraSettings,
} from "./auraSettings";

const GLASS_KEYS = new Set<keyof AuraSettings>(["glassStyle", "glassCursorGlow"]);

export function useMaterialNotice(eligible: boolean): void {
  const { addNotification, dismissNotification } = useNotifications();

  useEffect(() => {
    if (!eligible || !materialNoticeOwed()) return;
    spendMaterialNotice();
    addNotification({
      id: MATERIAL_NOTICE_ID,
      kind: "notice",
      title: "New look options",
      subtitle: "Try the Clear material and Cursor glow in Settings, under Theme.",
      data: { settingsSection: "sec-appearance" },
    });
  }, [eligible, addNotification]);

  // A choice made by hand (not a cloud pull) answers the notice.
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ keys?: string[]; fromCloud?: boolean }>).detail;
      if (!d || d.fromCloud || !Array.isArray(d.keys)) return;
      if (settingsChangeIncludes(e, GLASS_KEYS)) {
        spendMaterialNotice();
        dismissNotification(MATERIAL_NOTICE_ID);
      }
    };
    window.addEventListener("aura:settings-changed", onChange);
    return () => window.removeEventListener("aura:settings-changed", onChange);
  }, [dismissNotification]);
}
