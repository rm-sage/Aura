// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import LinkLoginModal from "./LinkLoginModal";

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
  // When set, the device-link modal ("Continue with Facebook/Apple") is
  // open for that provider. Both providers use Stremio's hosted login
  // page under the hood; the value only tailors the copy.
  const [linkProvider, setLinkProvider] = useState<"facebook" | "apple" | null>(null);
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

        {/* Social sign-in - Facebook / Apple. Aura can't mint a provider
            token Stremio would accept, so these open a device-link flow:
            the user finishes signing in on Stremio's own page (with their
            existing Facebook / Apple session) and Aura polls for the
            resulting session key. See LinkLoginModal. */}
        <div className="flex items-center gap-3">
          <div className="flex-1 h-px bg-white/8" />
          <span className="text-white/25 text-xs">or continue with</span>
          <div className="flex-1 h-px bg-white/8" />
        </div>

        <div className="flex gap-2.5">
          <button
            onClick={() => setLinkProvider("facebook")}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl bg-white/6 border border-white/12
                       hover:bg-white/10 hover:border-white/20 text-white/85 text-sm
                       transition-all flex items-center justify-center gap-2
                       disabled:opacity-40"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.9h-2.34V22c4.78-.79 8.44-4.94 8.44-9.94z" />
            </svg>
            Facebook
          </button>
          <button
            onClick={() => setLinkProvider("apple")}
            disabled={loading}
            className="flex-1 py-2.5 rounded-xl bg-white/6 border border-white/12
                       hover:bg-white/10 hover:border-white/20 text-white/85 text-sm
                       transition-all flex items-center justify-center gap-2
                       disabled:opacity-40"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M17.05 12.54c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.09-2.02-3.76-2.05-1.6-.16-3.12.94-3.93.94-.81 0-2.06-.92-3.39-.9-1.74.03-3.35 1.01-4.25 2.57-1.81 3.14-.46 7.79 1.3 10.34.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.39.81 1.4-.02 2.29-1.27 3.15-2.53.99-1.45 1.4-2.85 1.42-2.93-.03-.01-2.72-1.04-2.75-4.13zM14.6 4.7c.72-.87 1.2-2.08 1.07-3.28-1.03.04-2.28.69-3.02 1.55-.66.77-1.24 2-1.09 3.18 1.15.09 2.32-.58 3.04-1.45z" />
            </svg>
            Apple
          </button>
        </div>

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

      {/* Device-link flow for Facebook / Apple. Reuses the SAME onSuccess
          callback as email/password login, so App.tsx's post-login
          pipeline (settings scope, addon sync, library load) runs
          identically regardless of how the session was obtained. */}
      {linkProvider && (
        <LinkLoginModal
          provider={linkProvider}
          onSuccess={(sess) => { setLinkProvider(null); onSuccess(sess); }}
          onCancel={() => setLinkProvider(null)}
        />
      )}
    </div>
  );
}
