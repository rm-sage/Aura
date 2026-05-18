// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// useHoverCardActivation — the single source of truth for how a catalog
// card activates the mini-meta panel.
//
//   • Hover mode (default): reproduces the historical
//     onMouseEnter/onMouseLeave hover-intent behaviour exactly.
//   • Bind mode (AuraSettings.metaPanelBindEnabled): hover never opens;
//     the panel opens when the configured mouse button is pressed on a
//     card and a second press toggles it shut. In bind mode the panel
//     does NOT close on card mouse-leave (there is no hover intent to
//     bridge card→panel) — it closes via the bound-button toggle,
//     click-outside / Esc (CatalogHoverHost), or scroll-out (store
//     re-anchor). preventDefault on the bound button's pointerdown
//     suppresses middle-click autoscroll / back-forward navigation.
//
// Spread the returned handlers on the card's root element; the card
// keeps its own onClick / onContextMenu — this hook owns ONLY
// hover/bind activation. Reacts live to settings changes via the
// `aura:settings-changed` event (saveAuraSettings busts the settings
// cache before dispatching it, so the re-read is fresh).
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import type { MetaPreview } from "./types";
import { loadAuraSettings } from "./auraSettings";
import {
  scheduleHoverOpen,
  cancelHoverOpen,
  scheduleHoverClose,
  toggleHoverNow,
} from "./catalogHoverStore";

export interface HoverCardActivation {
  onMouseEnter?: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
  onAuxClick?: (e: React.MouseEvent<HTMLElement>) => void;
}

function readBindSettings(): { enabled: boolean; button: number } {
  const a = loadAuraSettings();
  return { enabled: a.metaPanelBindEnabled, button: a.metaPanelBindButton };
}

export function useHoverCardActivation(meta: MetaPreview): HoverCardActivation {
  const [bind, setBind] = useState(readBindSettings);

  useEffect(() => {
    const sync = () => setBind(readBindSettings());
    window.addEventListener("aura:settings-changed", sync);
    return () => window.removeEventListener("aura:settings-changed", sync);
  }, []);

  if (!bind.enabled) {
    return {
      onMouseEnter: (e) => scheduleHoverOpen(meta, e.currentTarget),
      onMouseLeave: () => { cancelHoverOpen(); scheduleHoverClose(); },
    };
  }

  return {
    onPointerDown: (e) => { if (e.button === bind.button) e.preventDefault(); },
    onAuxClick: (e) => {
      if (e.button !== bind.button) return;
      e.preventDefault();
      toggleHoverNow(meta, e.currentTarget);
    },
  };
}
