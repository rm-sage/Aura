// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import LoginView, { type UserSession } from "./LoginView";
import auraIcon from "./assets/aura-icon.png";

// ---------------------------------------------------------------------------
// LandingView — first-run / signed-out entry experience
//
// Two choices: sign into Stremio (cloud sync) or continue as a guest. Selecting
// "Sign In" mounts the existing LoginView modal; "Continue as Guest" simply
// signals upstream that the user opted out of auth for this session.
//
// Bypass logic lives in App.tsx: when the keyring already holds a session we
// skip the landing entirely (Tauri's keyring crate uses DPAPI on Windows /
// Keychain on macOS / Secret Service on Linux — i.e. encrypted at rest).
// ---------------------------------------------------------------------------

interface Props {
  onSignedIn: (sess: UserSession) => void;
  onContinueGuest: () => void;
}

const SyncIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46A7.93 7.93 0 0 0 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74A7.93 7.93 0 0 0 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
  </svg>
);
const GuestIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
  </svg>
);

export default function LandingView({ onSignedIn, onContinueGuest }: Props) {
  const [showLogin, setShowLogin] = useState(false);

  return (
    <div className="flex-1 relative flex items-center justify-center overflow-hidden">
      {/* Atmospheric background — uses the same Aura sweep concept, but
          full-screen, super slow, very subtle. */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="aura-sweep"
          aria-hidden
          style={{ animationDuration: "60s", opacity: 0.7 }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at center, rgba(91,164,255,0.06) 0%, rgba(0,0,0,0) 70%)",
          }}
        />
      </div>

      {/* Center column — narrow on purpose so buttons + copy don't
          stretch across an ultrawide display. 320 px keeps the action
          stack feeling like a focused dialog rather than a banner. */}
      <div className="relative z-10 w-full max-w-[320px] mx-auto px-6 flex flex-col gap-7 text-center">
        {/* Brand */}
        <div className="flex flex-col items-center gap-5">
          {/* Big glass-morphism A — refracts the moving spectral
              backdrop. Wrapped in a soft glow ring so it reads as a
              luminous mark even on extremely dark themes. */}
          <div className="relative flex items-center justify-center w-24 h-24">
            <span
              aria-hidden
              className="absolute inset-0 rounded-3xl"
              style={{
                background: "radial-gradient(circle at center, rgba(91,164,255,0.18) 0%, rgba(0,0,0,0) 65%)",
                filter: "blur(8px)",
              }}
            />
            <img
              src={auraIcon}
              alt="Aura"
              width={92}
              height={92}
              className="relative drop-shadow-[0_4px_18px_rgba(91,164,255,0.45)]"
              draggable={false}
            />
          </div>

          {/* "Welcome to Aura" — hero treatment using the same gradient-
              fill clipping as the title-bar wordmark. A separate
              `aura-hero-title` class keeps the size + spacing distinct. */}
          <h1 className="aura-hero-title">Welcome to Aura</h1>

          <p className="text-white/55 text-[13.5px] leading-relaxed font-light">
            A cinematic media player for the Stremio ecosystem with addon
            support, native MPV playback, and many custom features.
          </p>
        </div>

        {/* Action stack — buttons size to content + a comfortable
            click target rather than the column width. */}
        <div className="flex flex-col items-center gap-2.5 mt-1">
          <button
            onClick={() => setShowLogin(true)}
            className="group relative px-5 py-2.5 rounded-xl
                       bg-ln-accent/80 hover:bg-ln-accent active:scale-[0.99]
                       text-white text-[13px] font-medium transition-all
                       flex items-center justify-center gap-2.5
                       shadow-glass-edge"
          >
            <SyncIcon />
            Sign in to Stremio
          </button>

          <button
            onClick={onContinueGuest}
            className="group px-5 py-2.5 rounded-xl
                       bg-white/5 border border-white/10 hover:bg-white/8
                       text-white/75 hover:text-white/90 text-[13px]
                       transition-all flex items-center justify-center gap-2.5"
          >
            <GuestIcon />
            Continue as Guest
          </button>
        </div>

        {/* Footnote */}
        <p className="text-white/25 text-xs leading-relaxed">
          Signing in syncs your addons and library across devices.
          Tokens are stored using your OS keyring with platform-native
          encryption.
        </p>
      </div>

      {/* Login modal — mounted on demand */}
      {showLogin && (
        <LoginView
          onSuccess={(sess) => { setShowLogin(false); onSignedIn(sess); }}
          onGuest={() => { setShowLogin(false); onContinueGuest(); }}
        />
      )}
    </div>
  );
}
