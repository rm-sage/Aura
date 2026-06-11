// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MouseEvent } from "react";
import { openContextMenu, type ContextMenuItem } from "../ContextMenu";
import { copyTextToClipboard } from "../clipboard";
import { toggleFavorite, isFavorite } from "./favoritesStore";
import type { IptvChannel } from "./types";

// ---------------------------------------------------------------------------
// Live TV channel right-click menu — shared by the grid cards, favourites,
// guide rows, and multiview tiles. Built on the app's singleton ContextMenu
// (openContextMenu) + the Tauri clipboard helper.
// ---------------------------------------------------------------------------

export function openChannelMenu(
  e: MouseEvent,
  opts: { channel: IptvChannel; sourceId: string; sourceName: string; onPlay: () => void },
): void {
  e.preventDefault();
  e.stopPropagation();
  const { channel, sourceId, sourceName, onPlay } = opts;
  const fav = isFavorite(sourceId, channel.id);

  const items: ContextMenuItem[] = [
    { label: "Play", icon: <PlayGlyph />, onClick: onPlay },
    { kind: "divider" },
    {
      label: fav ? "Remove from favorites" : "Add to favorites",
      icon: <StarGlyph filled={fav} />,
      onClick: () => toggleFavorite(sourceId, sourceName, channel),
    },
    { kind: "divider" },
    {
      label: "Copy stream link",
      icon: <LinkGlyph />,
      onClick: () => void copyTextToClipboard(channel.url),
    },
    { label: "Copy channel name", onClick: () => void copyTextToClipboard(channel.name) },
  ];
  if (channel.tvgId) {
    items.push({
      label: "Copy EPG id (tvg-id)",
      onClick: () => void copyTextToClipboard(channel.tvgId),
    });
  }
  if (channel.logo) {
    items.push({ label: "Copy logo URL", onClick: () => void copyTextToClipboard(channel.logo!) });
  }

  openContextMenu(e.clientX, e.clientY, items);
}

const PlayGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
);
const LinkGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z" />
  </svg>
);
const StarGlyph = ({ filled }: { filled: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"}
       stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.7 1.2 6.6L12 18.6 6.1 21.8l1.2-6.6L2.5 9.5l6.6-.9z" />
  </svg>
);
