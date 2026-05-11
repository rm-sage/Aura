// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AddonEntry } from "../types";
import type { UserSession } from "../LoginView";
import LoginView from "../LoginView";
import { openContextMenu } from "../ContextMenu";
import { showAppToast } from "../AppToast";
import Tooltip from "../Tooltip";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Props {
  addons: AddonEntry[];
  session: UserSession | null;
  onAdd: (entry: AddonEntry) => void;
  onRemove: (url: string) => void;
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
}: {
  addon: AddonEntry;
  session: UserSession | null;
  onRemove: (url: string) => void;
  onSessionExpired: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

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

  // Force a fresh manifest fetch (bypassing the 5-min MANIFEST_CACHE
  // TTL). Surfaces newly-added catalogs on self-hosted AIOMetadata
  // without forcing a remove + re-add cycle. Toast on success with the
  // catalog count so the user gets concrete feedback; toast + shake on
  // error so a network blip is obvious without burying the chip.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const manifest = await invoke<{ catalogs: unknown[]; name?: string }>(
        "refresh_addon_manifest",
        { addonUrl: addon.url },
      );
      const count = Array.isArray(manifest.catalogs) ? manifest.catalogs.length : 0;
      showAppToast(`Refreshed ${addon.name} — ${count} catalog${count === 1 ? "" : "s"}`, { duration: 2500 });
    } catch (e) {
      showAppToast(`Couldn't refresh ${addon.name}: ${String(e)}`, { duration: 4000 });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      className="group flex items-center gap-3 px-4 py-3 rounded-xl
                 bg-white/3 border border-white/6 hover:bg-white/5
                 transition-colors"
      onContextMenu={(e) => {
        e.preventDefault();
        // The manifest URL is the install URL with /manifest.json appended.
        const manifestUrl = addon.url.endsWith("/manifest.json")
          ? addon.url
          : `${addon.url.replace(/\/$/, "")}/manifest.json`;
        // Stremio addon "Configure" pages live at <base>/configure
        const configureUrl = addon.url.endsWith("/manifest.json")
          ? addon.url.replace(/\/manifest\.json$/, "/configure")
          : `${addon.url.replace(/\/$/, "")}/configure`;
        openContextMenu(e.clientX, e.clientY, [
          {
            label: "Configure addon",
            onClick: () => openUrl(configureUrl).catch(() => {}),
          },
          {
            label: "Open manifest URL",
            onClick: () => openUrl(manifestUrl).catch(() => {}),
          },
          {
            label: "Copy manifest URL",
            onClick: () => navigator.clipboard.writeText(manifestUrl).catch(() => {}),
          },
          {
            label: "Remove addon",
            onClick: handleRemove,
            danger: true,
          },
        ]);
      }}
    >
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
      {/* Paired icon buttons — Refresh + Remove. Larger glass-styled
          targets, vertically centred against the row, persistent (no
          hover-to-reveal) so the affordances are always discoverable.
          Refresh uses the accent palette to match Aura's primary
          actions; Remove uses rose hover for the destructive intent. */}
      <div className="flex-shrink-0 flex items-center gap-2 self-center">
        <Tooltip text={refreshing ? "Refreshing…" : "Refresh manifest"} pos="bottom">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || removing}
            aria-label={`Refresh ${addon.name}`}
            className="w-10 h-10 flex items-center justify-center rounded-xl
                       bg-white/[0.04] border border-white/10
                       text-white/65 hover:text-ln-accent
                       hover:bg-ln-accent/12 hover:border-ln-accent/40
                       hover:shadow-[0_0_0_3px_rgba(91,164,255,0.08),0_4px_14px_-6px_rgba(91,164,255,0.45)]
                       transition-all duration-150
                       disabled:opacity-40 disabled:hover:bg-white/[0.04]
                       disabled:hover:border-white/10 disabled:hover:shadow-none
                       active:scale-95 active:bg-ln-accent/18"
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
            className="w-10 h-10 flex items-center justify-center rounded-xl
                       bg-white/[0.04] border border-white/10
                       text-white/65 hover:text-rose-300
                       hover:bg-rose-500/12 hover:border-rose-400/40
                       hover:shadow-[0_0_0_3px_rgba(244,63,94,0.08),0_4px_14px_-6px_rgba(244,63,94,0.45)]
                       transition-all duration-150
                       disabled:opacity-40 disabled:hover:bg-white/[0.04]
                       disabled:hover:border-white/10 disabled:hover:shadow-none
                       active:scale-95 active:bg-rose-500/20"
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

// ---------------------------------------------------------------------------
// AddonsView
// ---------------------------------------------------------------------------

export default function AddonsView({
  addons,
  session,
  onAdd,
  onRemove,
  onLoginSuccess,
  onLogout,
  onSessionExpired,
}: Props) {
  const [showLogin, setShowLogin] = useState(false);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      <div
        className="flex-1 overflow-y-auto px-6 py-6"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
      >
        {/* Centred reading column — caps the page width on ultrawide
            displays so rows don't sprawl across the entire viewport.
            Matches the Settings page's column treatment for a
            consistent "configuration surface" feel across the app. */}
        <div className="mx-auto w-full max-w-3xl space-y-6">
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
          <h2 className="text-white/40 text-xs font-semibold tracking-[0.1em] uppercase">
            Add Addon
          </h2>
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
            <div className="space-y-2">
              {addons.map((addon) => (
                <AddonRow
                  key={addon.url}
                  addon={addon}
                  session={session}
                  onRemove={onRemove}
                  onSessionExpired={onSessionExpired}
                />
              ))}
            </div>
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
