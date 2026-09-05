// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { invoke } from "@tauri-apps/api/core";
import type { ContextMenuItem } from "./ContextMenu";
import { showAppToast } from "./AppToast";
import { openDownloadsPanel } from "./downloadsPanel";
import type { StreamEntry } from "./types";
import { streamMatchKey } from "./watchTogether/streamMatch";

// ---------------------------------------------------------------------------
// The stream-row context menu, in ONE place.
//
// Both detail-page row variants (the parsed StreamRow and the raw RawStreamRow)
// used to build this array inline and cast it to
// `Array<{ label; icon?; onClick }>` — a type with no `disabled` and no `hint`,
// so a greyed-out entry was not even expressible. Collapsing them here fixes
// that and guarantees the two rows can never drift apart.
// ---------------------------------------------------------------------------

/** Everything the naming layer needs, assembled where the show, year, season
 *  and episode are actually in scope. A stream row on its own has none of it. */
export interface DownloadNaming {
  media_type: string;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  episode_title: string | null;
}

export interface StreamMenuContext {
  /** Stremio id the streams were fetched for (episode id for series). */
  streamId: string;
  naming: DownloadNaming;
  onCopy: (text: string) => void;
  onPlayExternal: (url: string) => void;
}

interface PlannedPath {
  path: string;
  truncated: boolean;
  duplicate: boolean;
}

/** Sentinels the Rust side returns so the frontend can branch on a CONDITION
 *  rather than pattern-matching English prose, which would break silently the
 *  moment a message was reworded. Mirrors `downloads::commands`. */
const NO_ROOT = "[noroot]";
const DUPLICATE = "[dupe]";

function isHls(url: string): boolean {
  const path = url.split(/[?#]/)[0].toLowerCase();
  return path.endsWith(".m3u8") || path.endsWith(".m3u");
}

/** Ask for a folder, save it, and report the outcome. Returns true when a root
 *  is now configured. */
async function ensureRoot(): Promise<boolean> {
  const picked = await invoke<string | null>("pick_folder").catch(() => null);
  if (!picked) return false;
  try {
    await invoke<string>("downloads_set_root", { path: picked });
    return true;
  } catch (e) {
    showAppToast(e instanceof Error ? e.message : String(e), { tone: "danger" });
    return false;
  }
}

async function enqueue(
  stream: StreamEntry,
  ctx: StreamMenuContext,
  allowDuplicate: boolean,
): Promise<void> {
  const url = stream.url;
  if (!url) return;

  const req = {
    url,
    headers: stream.proxy_headers ?? [],
    title: buildTitle(ctx.naming),
    subtitle: stream.filename ?? stream.addon_name,
    origin: {
      stream_id: ctx.streamId,
      media_type: ctx.naming.media_type,
      addon_name: stream.addon_name,
      match_key: streamMatchKey(stream) ?? url,
    },
    naming: {
      media_type: ctx.naming.media_type,
      title: ctx.naming.title,
      year: ctx.naming.year,
      season: ctx.naming.season,
      episode: ctx.naming.episode,
      episode_title: ctx.naming.episode_title,
      release_name: stream.filename,
      episode_pack: stream.episode_pack === true,
      url,
    },
    // Stamped here rather than read from the system clock in Rust, so the list
    // orders consistently with what the UI shows.
    created_at: Date.now(),
    allow_duplicate: allowDuplicate,
  };

  try {
    await invoke("downloads_enqueue", { req });
    openDownloadsPanel();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    if (msg.startsWith(NO_ROOT)) {
      // First download ever: prompt for a folder, then retry once. Doing this
      // lazily rather than at startup means someone who never downloads is
      // never asked where to put downloads.
      if (await ensureRoot()) await enqueue(stream, ctx, allowDuplicate);
      return;
    }
    if (msg.startsWith(DUPLICATE)) {
      const plain = msg.slice(DUPLICATE.length).trim();
      const { askConfirm } = await import("./ConfirmDialog");
      const again = await askConfirm({
        title: "Download it again?",
        message: plain,
        detail: "The second copy is saved alongside the first with a number appended.",
        confirmLabel: "Download again",
      });
      if (again) await enqueue(stream, ctx, true);
      return;
    }
    showAppToast(msg, { tone: "danger" });
  }
}

/** "Show - S01E07 - Title", or the movie's name. Kept short: the row shows the
 *  release filename underneath. */
function buildTitle(n: DownloadNaming): string {
  if (n.media_type === "movie") {
    return n.year ? `${n.title} (${n.year})` : n.title;
  }
  const parts = [n.title];
  if (n.season != null && n.episode != null) {
    parts.push(`S${String(n.season).padStart(2, "0")}E${String(n.episode).padStart(2, "0")}`);
  } else if (n.episode != null) {
    parts.push(`E${n.episode}`);
  }
  if (n.episode_title) parts.push(n.episode_title);
  return parts.join(" - ");
}

/** Build the full right-click menu for one stream row. */
export function buildStreamMenu(
  stream: StreamEntry,
  ctx: StreamMenuContext,
  externalIcon?: React.ReactNode,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  if (stream.url) {
    items.push({ label: "Copy stream link", onClick: () => ctx.onCopy(stream.url!) });
  }
  if (stream.info_hash) {
    items.push({
      label: "Copy magnet link",
      onClick: () => ctx.onCopy(`magnet:?xt=urn:btih:${stream.info_hash}`),
    });
  }
  if (stream.url) {
    items.push({
      label: "Play externally",
      icon: externalIcon,
      onClick: () => ctx.onPlayExternal(stream.url!),
    });
  }

  items.push({ kind: "divider" });
  items.push(downloadItem(stream, ctx));
  return items;
}

/** The Download entry, greyed out with a reason when the row is not a file. */
function downloadItem(stream: StreamEntry, ctx: StreamMenuContext): ContextMenuItem {
  if (!stream.url) {
    // Magnet / infoHash-only. Aura is Stremio-addon-only with Debrid and has
    // no torrent engine, so there is genuinely no file to fetch.
    return {
      label: "Download",
      disabled: true,
      onClick: () => {},
      hint: "This source is a torrent, not a direct file, so there is nothing to download.",
    };
  }
  if (isHls(stream.url)) {
    return {
      label: "Download",
      icon: <DownloadIcon />,
      onClick: () => void enqueue(stream, ctx, false),
      hint: "This is a streaming playlist, so Aura will reassemble it into one file. That can take longer than a direct download.",
    };
  }
  return {
    label: "Download",
    icon: <DownloadIcon />,
    onClick: () => void enqueue(stream, ctx, false),
  };
}

/** Ask Rust where a file would land, for a hover preview. Returns null when no
 *  root is set yet, which is not an error worth surfacing on hover. */
export async function planDownloadPath(
  stream: StreamEntry,
  ctx: StreamMenuContext,
): Promise<PlannedPath | null> {
  try {
    return await invoke<PlannedPath>("downloads_plan_path", {
      input: {
        media_type: ctx.naming.media_type,
        title: ctx.naming.title,
        year: ctx.naming.year,
        season: ctx.naming.season,
        episode: ctx.naming.episode,
        episode_title: ctx.naming.episode_title,
        release_name: stream.filename,
        episode_pack: stream.episode_pack === true,
        url: stream.url,
      },
    });
  } catch {
    return null;
  }
}

function DownloadIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 4v11M8 12l4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}
