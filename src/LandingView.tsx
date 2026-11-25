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
    <div className="aura-view-enter flex-1 relative flex items-center justify-center overflow-hidden">
      {/* Static glow only: AmbientAura already paints the sweep behind the
          shell on the compositor (and hides it on the high-contrast themes).
          A sweep of our own here animated background-position, a paint
          property, so it re-rastered the whole window every frame. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse at center, rgba(91,164,255,0.06) 0%, rgba(0,0,0,0) 70%)",
        }}
      />

      {/* Center column — wide enough that the title + description don't
          wrap aggressively, but the button stack inside stays modest
          (the buttons themselves size to content, not to the column). */}
      <div className="relative z-10 w-full max-w-[480px] mx-auto px-6 flex flex-col gap-7 text-center">
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
            className="aura-glass-flat aura-glass-press is-cta group relative px-6 py-3 rounded-xl
                       text-ln-accent-ink text-[14px] font-semibold
                       flex items-center justify-center gap-2.5"
          >
            <SyncIcon />
            Sign in to Stremio
          </button>

          <button
            onClick={onContinueGuest}
            className="aura-glass-flat aura-glass-press group px-6 py-3 rounded-xl
                       text-white/80 hover:text-white text-[14px]
                       flex items-center justify-center gap-2.5"
          >
            <GuestIcon />
            Continue as Guest
          </button>
        </div>

        {/* Footnote */}
        <p className="text-white/55 text-xs leading-relaxed">
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
