// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AddonEntry } from "../types";
import type { UserSession } from "../LoginView";
import LoginView from "../LoginView";
import { openContextMenu } from "../ContextMenu";
import { showAppToast } from "../AppToast";
import Tooltip from "../Tooltip";
import { requestReopenAddons } from "../onboarding";
import { copyTextToClipboard } from "../clipboard";

/** Glass icon-button styling shared by the addon-row action cluster.
 *  ACCENT = Copy/Configure/Refresh (blue accent hover); DESTRUCTIVE =
 *  Remove (rose hover). Extracted so the cluster reads as one set and
 *  the four buttons can't drift apart. */
const ACCENT_ICON_BTN =
  "w-10 h-10 flex items-center justify-center rounded-xl " +
  "bg-white/[0.04] border border-white/10 " +
  "text-white/65 hover:text-ln-accent " +
  "hover:bg-ln-accent/12 hover:border-ln-accent/40 " +
  "hover:shadow-[0_0_0_3px_rgba(91,164,255,0.08),0_4px_14px_-6px_rgba(91,164,255,0.45)] " +
  "transition-all duration-150 " +
  "disabled:opacity-40 disabled:hover:bg-white/[0.04] " +
  "disabled:hover:border-white/10 disabled:hover:shadow-none " +
  "active:scale-95 active:bg-ln-accent/18";
const DESTRUCTIVE_ICON_BTN =
  "w-10 h-10 flex items-center justify-center rounded-xl " +
  "bg-white/[0.04] border border-white/10 " +
  "text-white/65 hover:text-rose-300 " +
  "hover:bg-rose-500/12 hover:border-rose-400/40 " +
  "hover:shadow-[0_0_0_3px_rgba(244,63,94,0.08),0_4px_14px_-6px_rgba(244,63,94,0.45)] " +
  "transition-all duration-150 " +
  "disabled:opacity-40 disabled:hover:bg-white/[0.04] " +
  "disabled:hover:border-white/10 disabled:hover:shadow-none " +
  "active:scale-95 active:bg-rose-500/20";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  addons: AddonEntry[];
  session: UserSession | null;
  onAdd: (entry: AddonEntry) => void;
  onRemove: (url: string) => void;
  /** Persist a new addon ordering. The parent handles optimistic UI
   *  state — this callback fires the cloud / local invoke and is
   *  expected to swallow + toast on failure. */
  onReorder: (urls: string[]) => void;
  onLoginSuccess: (sess: UserSession) => void;
  onLogout: () => void;
  onSessionExpired: () => void;
}


// ---------------------------------------------------------------------------
// Tag pill — distinct color per tag KIND so the eye can quickly tell at a
// glance which addons cover Movies vs Series vs Subtitles, etc.
// ---------------------------------------------------------------------------

const TAG_PALETTE: Record<string, { bg: string; fg: string; border: string }> = {
  // Catalog media types
  movie:     { bg: "bg-blue-500/15",    fg: "text-blue-300",    border: "border-blue-400/30" },
  movies:    { bg: "bg-blue-500/15",    fg: "text-blue-300",    border: "border-blue-400/30" },
  series:    { bg: "bg-purple-500/15",  fg: "text-purple-300",  border: "border-purple-400/30" },
  show:      { bg: "bg-purple-500/15",  fg: "text-purple-300",  border: "border-purple-400/30" },
  anime:     { bg: "bg-pink-500/15",    fg: "text-pink-300",    border: "border-pink-400/30" },
  channel:   { bg: "bg-amber-500/15",   fg: "text-amber-300",   border: "border-amber-400/30" },
  channels:  { bg: "bg-amber-500/15",   fg: "text-amber-300",   border: "border-amber-400/30" },
  tv:        { bg: "bg-amber-500/15",   fg: "text-amber-300",   border: "border-amber-400/30" },
  music:     { bg: "bg-rose-500/15",    fg: "text-rose-300",    border: "border-rose-400/30" },
  // Resources
  catalog:   { bg: "bg-sky-500/15",     fg: "text-sky-300",     border: "border-sky-400/30" },
  meta:      { bg: "bg-cyan-500/15",    fg: "text-cyan-300",    border: "border-cyan-400/30" },
  stream:    { bg: "bg-emerald-500/15", fg: "text-emerald-300", border: "border-emerald-400/30" },
  streams:   { bg: "bg-emerald-500/15", fg: "text-emerald-300", border: "border-emerald-400/30" },
  subtitles: { bg: "bg-yellow-500/15",  fg: "text-yellow-300",  border: "border-yellow-400/30" },
  subtitle:  { bg: "bg-yellow-500/15",  fg: "text-yellow-300",  border: "border-yellow-400/30" },
};

function tagColors(tag: string): { bg: string; fg: string; border: string } {
  return (
    TAG_PALETTE[tag.toLowerCase()] ?? {
      bg: "bg-white/8", fg: "text-white/70", border: "border-white/15",
    }
  );
}

function TagPill({ label }: { label: string }) {
  const c = tagColors(label);
  return (
    <span
      className={`text-[9px] font-semibold tracking-wide uppercase px-1.5 py-0.5 rounded border
                  ${c.bg} ${c.fg} ${c.border}`}
    >
      {label}
    </span>
  );
}

function SearchBadge() {
  return (
    <span className="text-[9px] font-semibold tracking-wide uppercase px-1.5 py-0.5 rounded
                     bg-ln-accent/20 text-ln-accent border border-ln-accent/30">
      Search
    </span>
  );
}

// ---------------------------------------------------------------------------
// Auth status card
// ---------------------------------------------------------------------------

function AuthCard({
  session,
  onLoginClick,
  onLogout,
}: {
  session: UserSession | null;
  onLoginClick: () => void;
  onLogout: () => void;
}) {
  if (session) {
    return (
      <div className="flex items-center justify-between px-4 py-3 rounded-xl
                      bg-white/5 border border-white/10">
        <div className="flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
          <div>
            <p className="text-white/80 text-sm font-medium">{session.email}</p>
            <p className="text-white/35 text-xs">Synced to Stremio cloud</p>
          </div>
        </div>
        <button
          onClick={onLogout}
          className="text-white/35 hover:text-white/60 text-xs transition-colors px-2 py-1
                     rounded-lg hover:bg-white/8"
        >
          Sign Out
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-4 py-3 rounded-xl
                    bg-white/4 border border-white/8">
      <div className="flex items-center gap-2.5">
        <span className="w-2 h-2 rounded-full bg-white/20 flex-shrink-0" />
        <div>
          <p className="text-white/60 text-sm font-medium">Guest Mode</p>
          <p className="text-white/30 text-xs">Addons saved locally</p>
        </div>
      </div>
      <button
        onClick={onLoginClick}
        className="text-ln-accent/80 hover:text-ln-accent text-xs font-medium
                   transition-colors px-2 py-1 rounded-lg hover:bg-ln-accent/10"
      >
        Sign In →
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add form
// ---------------------------------------------------------------------------

function AddAddonForm({
  session,
  onAdd,
  onSessionExpired,
}: {
  session: UserSession | null;
  onAdd: (entry: AddonEntry) => void;
  onSessionExpired: () => void;
}) {
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async () => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setAdding(true);
    setError(null);
    try {
      let entry: AddonEntry;
      if (session?.auth_key) {
        entry = await invoke<AddonEntry>("cloud_add_addon", { authKey: session.auth_key, url: trimmed });
      } else {
        entry = await invoke<AddonEntry>("add_addon", { url: trimmed });
      }
      onAdd(entry);
      setUrl("");
    } catch (e) {
      const msg = String(e);
      if (msg === "SESSION_EXPIRED") { onSessionExpired(); return; }
      setError(msg);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
            if (e.key === "Escape") { setUrl(""); setError(null); }
          }}
          placeholder="https://…/manifest.json"
          spellCheck={false}
          disabled={adding}
          className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5
                     text-white/85 text-sm font-mono placeholder:text-white/20 outline-none
                     focus:border-white/25 transition-colors disabled:opacity-40"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !url.trim()}
          className="px-5 py-2.5 rounded-xl text-sm font-medium transition-all flex-shrink-0
                     bg-ln-accent/70 hover:bg-ln-accent/90 text-white
                     disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </div>
      {session && (
        <p className="text-white/25 text-xs">Added addons will sync to your Stremio cloud.</p>
      )}
      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2.5">
          <p className="text-red-400/80 text-xs leading-relaxed break-all">{error}</p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Addon row
// ---------------------------------------------------------------------------

function AddonRow({
  addon,
  session,
  onRemove,
  onSessionExpired,
  reorderEnabled,
}: {
  addon: AddonEntry;
  session: UserSession | null;
  onRemove: (url: string) => void;
  onSessionExpired: () => void;
  /** False collapses the drag handle to a non-interactive spacer so
   *  single-addon lists keep a stable leading-edge width. */
  reorderEnabled: boolean;
}) {
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  // dnd-kit sortable binding — keyed by addon URL (unique + stable).
  // `listeners` go on the drag handle, NOT the row, so the action
  // buttons (Copy/Configure/Refresh/Remove) stay clickable without
  // accidentally lifting the row. `attributes` carry ARIA roles for
  // keyboard accessibility (KeyboardSensor handles Space-to-lift,
  // arrows-to-move, Space-to-drop).
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: addon.url, disabled: !reorderEnabled });

  const rowStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    // Lift the row above its siblings while dragging so the dnd-kit
    // transform doesn't appear to slide UNDER neighbouring rows.
    zIndex: isDragging ? 10 : "auto",
  };

  // The manifest URL is the install URL with /manifest.json appended;
  // Stremio "Configure" pages live at <base>/configure. Computed once
  // here so the icon buttons AND the right-click context menu share a
  // single source of truth.
  const manifestUrl = addon.url.endsWith("/manifest.json")
    ? addon.url
    : `${addon.url.replace(/\/$/, "")}/manifest.json`;
  const configureUrl = addon.url.endsWith("/manifest.json")
    ? addon.url.replace(/\/manifest\.json$/, "/configure")
    : `${addon.url.replace(/\/$/, "")}/configure`;

  const handleRemove = async () => {
    setRemoving(true);
    try {
      if (session?.auth_key) {
        await invoke("cloud_remove_addon", { authKey: session.auth_key, url: addon.url });
      } else {
        await invoke("remove_addon", { url: addon.url });
      }
      onRemove(addon.url);
    } catch (e) {
      if (String(e) === "SESSION_EXPIRED") onSessionExpired();
      setRemoving(false);
    }
  };

  // Force a fresh manifest fetch (bypassing the 24-hour MANIFEST_CACHE
  // TTL). Surfaces newly-added catalogs on self-hosted AIOMetadata
  // without forcing a remove + re-add cycle. Toast on success with the
  // catalog count so the user gets concrete feedback; toast + shake on
  // error so a network blip is obvious without burying the chip.
  // Dispatches `aura:addon-manifest-refreshed` so HomeView re-bootstraps
  // its catalog rows against the new manifest without waiting for an
  // unrelated settings change to bump its settingsTick.
  const handleRefresh = async (silent = false) => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const manifest = await invoke<{ catalogs: unknown[]; name?: string }>(
        "refresh_addon_manifest",
        { addonUrl: addon.url },
      );
      const count = Array.isArray(manifest.catalogs) ? manifest.catalogs.length : 0;
      window.dispatchEvent(new CustomEvent("aura:addon-manifest-refreshed", {
        detail: { url: addon.url, catalogCount: count },
      }));
      if (!silent) {
        showAppToast(`Refreshed ${addon.name} — ${count} catalog${count === 1 ? "" : "s"}`, { duration: 2500 });
      }
    } catch (e) {
      if (!silent) {
        showAppToast(`Couldn't refresh ${addon.name}: ${String(e)}`, { duration: 4000 });
      }
    } finally {
      setRefreshing(false);
    }
  };

  // Configure handler — opens the addon's /configure page in the user's
  // default browser, then schedules a silent manifest refresh on the
  // next window-focus event (capped at 30 min). This is the "user
  // toggles catalogs on AIOMetadata's UI, comes back to Aura, expects
  // to see them" workflow: without auto-refresh, Aura would hold the
  // pre-configure manifest until the 24h TTL elapses or the user
  // manually clicks Refresh. The focus-listener is one-shot per
  // configure click so it can't accumulate across rapid re-clicks.
  const handleConfigure = () => {
    openUrl(configureUrl).catch(() => {});
    let fired = false;
    const cleanup = () => {
      window.removeEventListener("focus", onFocus);
      clearTimeout(expiry);
    };
    const onFocus = () => {
      if (fired) return;
      fired = true;
      cleanup();
      // Brief delay so the manifest fetch doesn't race with whatever
      // tail-end network requests the addon's configure submit kicked
      // off (AIOMetadata persists config server-side before the page
      // re-renders).
      setTimeout(() => { void handleRefresh(true); }, 750);
    };
    const expiry = setTimeout(cleanup, 30 * 60 * 1000);
    window.addEventListener("focus", onFocus);
  };

  const handleCopyManifest = async () => {
    const ok = await copyTextToClipboard(manifestUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      showAppToast("Couldn't copy manifest URL", { duration: 3000 });
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={rowStyle}
      className="group relative flex items-center gap-3 px-4 py-3 rounded-xl
                 bg-white/3 border border-white/6 hover:bg-white/5
                 transition-colors"
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          {
            label: "Configure addon",
            onClick: handleConfigure,
          },
          {
            label: "Open manifest URL",
            onClick: () => openUrl(manifestUrl).catch(() => {}),
          },
          {
            label: "Copy manifest URL",
            onClick: () => { void copyTextToClipboard(manifestUrl); },
          },
          {
            label: "Remove addon",
            onClick: handleRemove,
            danger: true,
          },
        ]);
      }}
    >
      <DragHandle
        enabled={reorderEnabled}
        ariaLabel={`Drag ${addon.name} to reorder`}
        listeners={listeners}
        attributes={attributes}
      />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-white/85 text-sm font-medium leading-tight">{addon.name}</p>
          {addon.has_search && <SearchBadge />}
        </div>
        <p className="text-white/30 text-xs font-mono truncate">
          {addon.url.replace(/^https?:\/\//, "")}
        </p>
        {(addon.types?.length || addon.resources?.length) ? (
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            {(addon.types ?? []).map((t) => <TagPill key={`t:${t}`} label={t} />)}
            {(addon.resources ?? [])
              // Hide the implicit `catalog` resource if the addon already has
              // catalog types listed — it's redundant noise.
              .filter((r) => !(r.toLowerCase() === "catalog" && (addon.types ?? []).length > 0))
              .map((r) => <TagPill key={`r:${r}`} label={r} />)}
          </div>
        ) : null}
      </div>
      {/* Paired icon buttons — Copy, optional Configure, Refresh,
          Remove. Larger glass-styled targets, vertically centred,
          persistent (no hover-to-reveal). Copy/Configure reuse the
          Refresh button's exact accent styling so the cluster reads as
          one set; Remove uses rose hover for destructive intent. */}
      <div className="flex-shrink-0 flex items-center gap-2 self-center">
        <Tooltip text={copied ? "Copied ✓" : "Copy manifest URL"} pos="bottom">
          <button
            type="button"
            onClick={handleCopyManifest}
            aria-label={`Copy ${addon.name} manifest URL`}
            className={ACCENT_ICON_BTN}
          >
            <CopyIcon copied={copied} />
          </button>
        </Tooltip>
        {addon.configurable && (
          <Tooltip text="Configure addon" pos="bottom">
            <button
              type="button"
              onClick={handleConfigure}
              aria-label={`Configure ${addon.name}`}
              className={ACCENT_ICON_BTN}
            >
              <ConfigureIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip text={refreshing ? "Refreshing…" : "Refresh manifest"} pos="bottom">
          <button
            type="button"
            onClick={() => { void handleRefresh(); }}
            disabled={refreshing || removing}
            aria-label={`Refresh ${addon.name}`}
            className={ACCENT_ICON_BTN}
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        </Tooltip>
        <Tooltip text={removing ? "Removing…" : "Remove addon"} pos="bottom">
          <button
            type="button"
            onClick={handleRemove}
            disabled={removing || refreshing}
            aria-label={`Remove ${addon.name}`}
            className={DESTRUCTIVE_ICON_BTN}
          >
            {removing ? <SpinnerDot /> : <CloseIcon />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** Refresh glyph — circular arrow that rotates while a refresh is in
 *  flight. Stroke-based so it inherits text colour from the parent
 *  button's hover/focus state. */
function RefreshIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        animation: spinning ? "addon-refresh-spin 0.9s linear infinite" : "none",
        transformOrigin: "center",
      }}
      aria-hidden
    >
      <path d="M3 12a9 9 0 0 1 15.4-6.36L21 8" />
      <polyline points="21 3 21 8 16 8" />
      <path d="M21 12a9 9 0 0 1-15.4 6.36L3 16" />
      <polyline points="3 21 3 16 8 16" />
    </svg>
  );
}

/** Close (X) glyph used as the redesigned Remove icon. */
function CloseIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

/** Single-dot spinner shown in the Remove button while a removal is
 *  in flight — distinct from the Refresh spinner so the user knows
 *  which action is mid-air if they trigger one then the other. */
function SpinnerDot() {
  return (
    <div
      className="w-2 h-2 rounded-full bg-current"
      style={{ animation: "addon-spinner-pulse 0.9s ease-in-out infinite" }}
      aria-hidden
    />
  );
}

/** Copy glyph — swaps to a checkmark for ~1.5 s after a successful
 *  copy. Stroke-based so it inherits the button's hover text colour,
 *  matching RefreshIcon / CloseIcon. */
function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg
        width="17" height="17" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Six-dot grip glyph rendered inside the drag handle. Stroke-based
 *  so it inherits text colour from the parent — fades from /35 → /85
 *  on row hover via the `group-hover:` rule. */
function GripIcon() {
  return (
    <svg
      width="14" height="16" viewBox="0 0 12 16" fill="currentColor"
      aria-hidden
    >
      <circle cx="3" cy="3" r="1.3" />
      <circle cx="3" cy="8" r="1.3" />
      <circle cx="3" cy="13" r="1.3" />
      <circle cx="9" cy="3" r="1.3" />
      <circle cx="9" cy="8" r="1.3" />
      <circle cx="9" cy="13" r="1.3" />
    </svg>
  );
}

/** Drag handle — sole drag initiator. Sits at the leading edge of the
 *  row. The dnd-kit `listeners` (pointerdown / keydown) attach here
 *  ONLY, so the trailing action buttons stay clickable without
 *  accidentally lifting the row. `attributes` carry the ARIA roles for
 *  keyboard reorder (Space lifts, arrows move, Space drops). Native
 *  HTML5 drag isn't used because Tauri 2's window `dragDropEnabled`
 *  default intercepts the events for OS file-drop handling, which
 *  fights `preventDefault()` inside the webview and produces a 🚫
 *  cursor on every drop target. dnd-kit is pointer-event-based and
 *  sidesteps that entire conflict — the same library backs the Queue
 *  reorder, which already works for the same reason. */
function DragHandle({
  enabled,
  ariaLabel,
  listeners,
  attributes,
}: {
  enabled: boolean;
  ariaLabel: string;
  listeners: ReturnType<typeof useSortable>["listeners"];
  attributes: ReturnType<typeof useSortable>["attributes"];
}) {
  if (!enabled) {
    return <span className="w-5 flex-shrink-0" aria-hidden />;
  }
  return (
    <span
      aria-label={ariaLabel}
      {...attributes}
      {...listeners}
      className="flex-shrink-0 w-5 h-8 flex items-center justify-center
                 text-white/35 group-hover:text-white/70 active:text-white/85
                 cursor-grab active:cursor-grabbing select-none touch-none
                 transition-colors outline-none focus-visible:text-ln-accent"
    >
      <GripIcon />
    </span>
  );
}

/** Configure glyph (sliders) — shown only for addons whose manifest
 *  declares `behaviorHints.configurable`. */
function ConfigureIcon() {
  return (
    <svg
      width="17" height="17" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// AddonsView
// ---------------------------------------------------------------------------

export default function AddonsView({
  addons,
  session,
  onAdd,
  onRemove,
  onReorder,
  onLoginSuccess,
  onLogout,
  onSessionExpired,
}: Props) {
  const [showLogin, setShowLogin] = useState(false);

  // dnd-kit sensors. 6 px pointer activation threshold matches QueueView
  // so a user clicking the handle for any other reason (focus, context
  // menu) doesn't accidentally start a drag. KeyboardSensor enables
  // Space-to-lift / arrow-keys-to-move / Space-to-drop on the focused
  // handle for accessibility.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = addons.findIndex((a) => a.url === String(active.id));
    const newIdx = addons.findIndex((a) => a.url === String(over.id));
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(addons, oldIdx, newIdx);
    onReorder(next.map((a) => a.url));
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="flex-1 overflow-y-auto px-6 py-6"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        {/* Centred reading column — caps the page width on ultrawide
            displays so rows don't sprawl across the entire viewport.
            Inline maxWidth because tailwind.config.ts strips all
            max-w-* utilities (Aura targets fluid ultrawide layouts by
            default), and the Settings page uses the same inline-style
            pattern for its own column. min(960px, 92%) keeps the
            column wide enough for long manifest URLs while still
            sitting centred on a 21:9 / 32:9 display. */}
        <div
          className="mx-auto w-full space-y-6"
          style={{ maxWidth: "min(960px, 92%)" }}
        >
        {/* Page header */}
        <div>
          <h1 className="text-white/85 text-xl font-light tracking-wide">Addons</h1>
          <p className="text-white/35 text-sm mt-1">
            Manage your Stremio-compatible addon sources.
          </p>
        </div>

        {/* Auth status */}
        <AuthCard
          session={session}
          onLoginClick={() => setShowLogin(true)}
          onLogout={onLogout}
        />

        {/* Add new */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-white/40 text-xs font-semibold tracking-[0.1em] uppercase">
              Add Addon
            </h2>
            {/* Lets users revisit just the recommended-addons step of
                the first-run wizard without re-running import / settings.
                Fires `aura:onboarding-reopen-addons`; App.tsx remounts
                OnboardingView at step 2. */}
            <button
              type="button"
              onClick={() => requestReopenAddons()}
              className="text-[10px] font-medium tracking-wide uppercase
                         text-white/45 hover:text-ln-accent
                         transition-colors px-2 py-1 rounded
                         hover:bg-ln-accent/10"
              title="Reopen the recommended-addons step of the first-run wizard"
            >
              Suggested addons
            </button>
          </div>
          <AddAddonForm
            session={session}
            onAdd={onAdd}
            onSessionExpired={onSessionExpired}
          />
        </section>

        {/* Installed addons */}
        <section className="space-y-3">
          <h2 className="text-white/40 text-xs font-semibold tracking-[0.1em] uppercase">
            Installed · {addons.length}
          </h2>
          {addons.length === 0 ? (
            <p className="text-white/25 text-sm">No addons installed yet.</p>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={addons.map((a) => a.url)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-2">
                  {addons.map((addon) => (
                    <AddonRow
                      key={addon.url}
                      addon={addon}
                      session={session}
                      onRemove={onRemove}
                      onSessionExpired={onSessionExpired}
                      reorderEnabled={addons.length > 1}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </section>
        </div>
      </div>

      {/* Login modal */}
      {showLogin && (
        <LoginView
          onSuccess={(sess) => { onLoginSuccess(sess); setShowLogin(false); }}
          onGuest={() => setShowLogin(false)}
        />
      )}
    </div>
  );
}
