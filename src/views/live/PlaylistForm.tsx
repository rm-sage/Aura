// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { addPlaylistSource } from "../../iptv/store";

// ---------------------------------------------------------------------------
// PlaylistForm — modal to add a Live TV playlist. Phase 1: M3U (name + URL).
// Phase 2 adds an Xtream tab (server / username / password → OS keyring).
// The "Add" action persists through the store (Rust AppSettings) and kicks
// off an immediate fetch; the parent switches to the new source on success.
// ---------------------------------------------------------------------------

interface Props {
  onClose: () => void;
  onAdded: (sourceId: string) => void;
}

export default function PlaylistForm({ onClose, onAdded }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    urlRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSubmit = url.trim().length > 0 && !saving;

  const submit = async () => {
    const u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) {
      setError("Enter a full http(s):// playlist URL.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const derivedName = name.trim() || hostnameOf(u) || "Playlist";
      const source = await addPlaylistSource({ name: derivedName, url: u, kind: "m3u" });
      onAdded(source.id);
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
        className="w-[440px] max-w-[92vw] rounded-2xl border border-white/12
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

        <div className="space-y-3">
          <Field label="Playlist URL (M3U / M3U8)">
            <input
              ref={urlRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canSubmit && submit()}
              placeholder="https://provider.example/get.php?username=…&type=m3u_plus"
              className="w-full h-10 px-3 rounded-xl bg-white/5 border border-white/10
                         text-[13px] text-white/90 placeholder:text-white/30
                         focus:outline-none focus:border-ln-accent/40"
            />
          </Field>
          <Field label="Name (optional)">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && canSubmit && submit()}
              placeholder="My provider"
              className="w-full h-10 px-3 rounded-xl bg-white/5 border border-white/10
                         text-[13px] text-white/90 placeholder:text-white/30
                         focus:outline-none focus:border-ln-accent/40"
            />
          </Field>

          {error && <p className="text-red-300/90 text-[12.5px]">{error}</p>}

          <p className="text-white/30 text-[11.5px] leading-relaxed">
            The playlist is fetched through Aura's backend (no CORS limits, with the
            IPTV-client User-Agent). Channels stream through the normal player.
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
