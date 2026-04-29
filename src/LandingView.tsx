import { useState } from "react";
import LoginView, { type UserSession } from "./LoginView";

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
    <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
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

      {/* Center column */}
      <div className="relative z-10 w-full max-w-md mx-auto px-8 flex flex-col gap-8 text-center">
        {/* Brand */}
        <div className="flex flex-col items-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-ln-accent/15 border border-ln-accent/30
                          flex items-center justify-center shadow-glass-edge">
            <span className="text-ln-accent text-2xl font-bold tracking-tight">A</span>
          </div>
          <h1 className="text-white text-3xl font-light tracking-wide">Welcome to Aura</h1>
          <p className="text-white/45 text-sm leading-relaxed max-w-xs">
            A cinematic media player with Stremio addon support, MPV playback,
            and a focus on craft.
          </p>
        </div>

        {/* Action stack */}
        <div className="flex flex-col gap-3 mt-2">
          <button
            onClick={() => setShowLogin(true)}
            className="group relative w-full px-5 py-4 rounded-2xl
                       bg-ln-accent/80 hover:bg-ln-accent active:scale-[0.99]
                       text-white text-sm font-medium transition-all
                       flex items-center justify-center gap-2.5
                       shadow-glass-edge"
          >
            <SyncIcon />
            Sign in to Stremio
          </button>

          <button
            onClick={onContinueGuest}
            className="group w-full px-5 py-4 rounded-2xl
                       bg-white/5 border border-white/10 hover:bg-white/8
                       text-white/75 hover:text-white/90 text-sm
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
          encryption — never in plaintext.
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
