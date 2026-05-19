// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface UserSession {
  email: string;
  auth_key: string;
  /** Stremio user `_id` — stable across logins on every device for
   *  the same Stremio account. Captured at login from
   *  `result.user._id`; null when missing on the wire (older
   *  Stremio API schema) or on legacy keyring blobs before the
   *  backfill runs. Used to derive the Aura Cloud Sync scope hash
   *  so all of a user's devices land in the same proxy bucket. */
  user_id?: string | null;
}

/** Read-only Stremio account snapshot from the `fetch_stremio_account`
 *  Tauri command. snake_case mirrors the Rust struct's wire field names
 *  exactly (no serde rename in play). Optional fields are `null` when
 *  `/getUser` omits them OR returns an empty string (the Rust side
 *  filters non-empty) — the popover hides those rows rather than
 *  showing placeholders. */
export interface StremioAccount {
  email: string;
  user_id: string;
  date_registered?: string | null;
  premium_until?: string | null;
}

interface Props {
  onSuccess: (session: UserSession) => void;
  onGuest: () => void;
}

export default function LoginView({ onSuccess, onGuest }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  // Focus email on mount
  useEffect(() => { emailRef.current?.focus(); }, []);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !loading;

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError(null);
    try {
      const session = await invoke<UserSession>("login", {
        email: email.trim(),
        password,
      });
      setPassword(""); // clear from React state after IPC sends it
      onSuccess(session);
    } catch (err) {
      setPassword("");
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    /* Full-screen dim overlay */
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      {/* Glass card — narrowed from max-w-sm (384) to 320 so the
          inputs feel proportional on ultrawide displays. */}
      <div className="glass-panel-elevated rounded-3xl px-7 py-8 w-full max-w-[320px] mx-4
                      shadow-glass-edge flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-col gap-1.5">
          <h1 className="text-white text-2xl font-light tracking-wide">Sign in to Stremio</h1>
          <p className="text-white/40 text-sm">Sync your addon library across devices.</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-white/45 text-xs font-medium tracking-wide">Email</label>
            <input
              ref={emailRef}
              type="email"
              value={email}
              onChange={(e) => { setEmail(e.target.value); setError(null); }}
              placeholder="you@example.com"
              autoComplete="email"
              disabled={loading}
              className="bg-white/6 border border-white/12 rounded-xl px-4 py-2.5
                         text-white text-sm placeholder:text-white/25 outline-none
                         focus:border-white/30 transition-colors disabled:opacity-40"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-white/45 text-xs font-medium tracking-wide">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
              placeholder="••••••••"
              autoComplete="current-password"
              disabled={loading}
              className="bg-white/6 border border-white/12 rounded-xl px-4 py-2.5
                         text-white text-sm placeholder:text-white/25 outline-none
                         focus:border-white/30 transition-colors disabled:opacity-40"
            />
          </div>

          {/* Error */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
              <p className="text-red-400/90 text-xs leading-relaxed">{error}</p>
            </div>
          )}

          {/* Sign In button */}
          <button
            type="submit"
            disabled={!canSubmit}
            className="mt-1 w-full py-3 rounded-xl font-medium text-sm transition-all
                       bg-ln-accent/80 hover:bg-ln-accent active:scale-95 text-white
                       disabled:opacity-35 disabled:cursor-not-allowed"
          >
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Signing in…
              </span>
            ) : "Sign In"}
          </button>
        </form>

        {/* Guest option */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/8" />
          <span className="text-white/25 text-xs">or</span>
          <div className="flex-1 h-px bg-white/8" />
        </div>

        <button
          onClick={onGuest}
          disabled={loading}
          className="text-white/45 hover:text-white/70 text-sm text-center
                     transition-colors disabled:opacity-40"
        >
          Continue as Guest
        </button>
      </div>
    </div>
  );
}
