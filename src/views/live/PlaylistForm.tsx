// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { addPlaylistSource } from "../../iptv/store";

// ---------------------------------------------------------------------------
// PlaylistForm — modal to add a Live TV playlist. Two tabs:
//   • M3U     — paste a full playlist URL.
//   • Xtream  — server + username + password. The password is written to
//               the OS keyring (never persisted in settings); the store
//               merges it back in at fetch time and pulls channels via the
//               Xtream player API. (live-tv spec Decision D + Phase 2.)
// The "Add" action persists through the store (Rust AppSettings) and kicks
// off an immediate fetch; the parent switches to the new source on success.
// ---------------------------------------------------------------------------

type Tab = "m3u" | "xtream";

interface Props {
  onClose: () => void;
  onAdded: (sourceId: string) => void;
}

export default function PlaylistForm({ onClose, onAdded }: Props) {
  const [tab, setTab] = useState<Tab>("m3u");
  const [name, setName] = useState("");
  // M3U
  const [url, setUrl] = useState("");
  // Xtream
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, [tab]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit =
    !saving &&
    (tab === "m3u"
      ? url.trim().length > 0
      : server.trim().length > 0 && username.trim().length > 0 && password.length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      if (tab === "m3u") {
        const u = url.trim();
        if (!/^https?:\/\//i.test(u)) throw new Error("Enter a full http(s):// playlist URL.");
        const source = await addPlaylistSource({
          name: name.trim() || hostnameOf(u) || "Playlist",
          url: u,
          kind: "m3u",
        });
        onAdded(source.id);
      } else {
        const base = normalizeServer(server.trim());
        if (!base) throw new Error("Enter the server URL, e.g. http://line.provider.com:8080");
        const source = await addPlaylistSource(
          {
            name: name.trim() || hostnameOf(base) || "Xtream",
            url: base,
            kind: "xtream",
            xtream: { server: base, username: username.trim() },
          },
          password,
        );
        onAdded(source.id);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't add the playlist.");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Add playlist"
        className="w-[460px] max-w-[92vw] rounded-2xl border border-white/12
                   bg-[rgba(16,16,20,0.98)] backdrop-blur-2xl shadow-glass-edge p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-white/95 text-lg font-semibold">Add playlist</h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-md text-white/40 hover:text-white hover:bg-white/10
                       flex items-center justify-center"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/8 mb-4">
          <TabButton active={tab === "m3u"} onClick={() => setTab("m3u")}>
            M3U URL
          </TabButton>
          <TabButton active={tab === "xtream"} onClick={() => setTab("xtream")}>
            Xtream Login
          </TabButton>
        </div>

        <div className="space-y-3">
          {tab === "m3u" ? (
            <Field label="Playlist URL (M3U / M3U8)">
              <input
                ref={firstFieldRef}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
                placeholder="https://provider.example/get.php?username=…&type=m3u_plus"
                className={inputCls}
              />
            </Field>
          ) : (
            <>
              <Field label="Server URL">
                <input
                  ref={firstFieldRef}
                  value={server}
                  onChange={(e) => setServer(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  placeholder="http://line.provider.com:8080"
                  className={inputCls}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Username">
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    autoComplete="off"
                    className={inputCls}
                  />
                </Field>
                <Field label="Password">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && submit()}
                    autoComplete="off"
                    className={inputCls}
                  />
                </Field>
              </div>
            </>
          )}

          <Field label="Name (optional)">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="My provider"
              className={inputCls}
            />
          </Field>

          {error && <p className="text-red-300/90 text-[12.5px]">{error}</p>}

          <p className="text-white/30 text-[11.5px] leading-relaxed">
            {tab === "xtream"
              ? "Your password is stored in the OS keyring, not in plaintext settings. Channels are fetched through Aura's backend with the IPTV-client User-Agent."
              : "The playlist is fetched through Aura's backend (no CORS limits, IPTV-client User-Agent). Channels stream through the normal player."}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 h-9 rounded-xl text-[13px] font-medium bg-white/5 border border-white/10
                       text-white/70 hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="px-4 h-9 rounded-xl text-[13px] font-medium border transition-colors
                       bg-ln-accent/15 text-ln-accent border-ln-accent/30 hover:bg-ln-accent/25
                       disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Adding…" : "Add playlist"}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full h-10 px-3 rounded-xl bg-white/5 border border-white/10 text-[13px] " +
  "text-white/90 placeholder:text-white/30 focus:outline-none focus:border-ln-accent/40";

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex-1 h-8 rounded-lg text-[12.5px] font-medium transition-colors",
        active ? "bg-ln-accent/20 text-ln-accent" : "text-white/55 hover:text-white/85",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-white/55 text-[11.5px] font-medium mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Normalize an Xtream server entry to a bare `proto://host[:port]` base.
 *  Accepts a full URL or a host:port; returns "" when unusable. */
function normalizeServer(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
}
