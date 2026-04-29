import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry } from "../types";
import type { UserSession } from "../LoginView";
import LoginView from "../LoginView";

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
// Search badge
// ---------------------------------------------------------------------------

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

  return (
    <div className="group flex items-start gap-3 px-4 py-3 rounded-xl
                    bg-white/3 border border-white/6 hover:bg-white/5
                    transition-colors">
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-white/85 text-sm font-medium leading-tight">{addon.name}</p>
          {addon.has_search && <SearchBadge />}
        </div>
        <p className="text-white/30 text-xs font-mono truncate">
          {addon.url.replace(/^https?:\/\//, "")}
        </p>
      </div>
      <button
        onClick={handleRemove}
        disabled={removing}
        aria-label={`Remove ${addon.name}`}
        className="opacity-0 group-hover:opacity-100 flex-shrink-0 px-2.5 py-1 rounded-lg
                   text-white/40 hover:text-white/80 hover:bg-white/10 text-xs
                   transition-all disabled:opacity-20"
      >
        {removing ? "…" : "Remove"}
      </button>
    </div>
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
        className="flex-1 overflow-y-auto px-6 py-6 space-y-6"
        style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
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
