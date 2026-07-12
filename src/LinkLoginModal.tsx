// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UserSession } from "./LoginView";

// ---------------------------------------------------------------------------
// LinkLoginModal - "Sign in with Facebook / Apple" for a Stremio account.
//
// Aura is a third-party client and cannot mint a Facebook access token or
// an Apple identity token that Stremio's `authWithFacebook` /
// `authWithApple` endpoints would accept (those tokens are bound to
// Stremio's OWN app IDs). So instead of a native OAuth button, we use
// Stremio's device-link code flow, exactly the way Stremio's own TV and
// console apps do it:
//
//   1. Ask the backend (`stremio_link_create`) for a short code + a link
//      URL + a QR image.
//   2. The user opens that link in their real browser (where their
//      Facebook / Apple sessions already live) or scans the QR on their
//      phone, and signs in with Facebook, Apple, or email on Stremio's
//      own hosted login page.
//   3. We poll (`stremio_link_poll`) until Stremio exchanges the code for
//      an `authKey`. Aura only ever receives the final session key, never
//      a password or a provider token.
//
// Because the provider choice happens on Stremio's page, this flow is
// provider-agnostic: it keeps working if Stremio adds or drops providers.
// The `provider` prop only tailors the copy; both providers open the same
// universal page.
// ---------------------------------------------------------------------------

/** Mirrors the Rust `LinkCode` struct (field names match the wire, so no
 *  serde rename is in play). */
interface LinkCode {
  code: string;
  link: string;
  qrcode: string;
}

type Provider = "facebook" | "apple";

interface Props {
  /** Tailors the header + hint copy. Both providers use the same flow. */
  provider: Provider;
  onSuccess: (session: UserSession) => void;
  onCancel: () => void;
}

// Poll cadence. The read endpoint is a single cheap GET; ~2 s reads
// responsive without hammering Stremio.
const POLL_MS = 2000;
// Client-owned give-up window. A not-yet-consumed code and a genuinely
// expired code both read as the same "pending" error server-side, so the
// client decides when to stop. 5 min is comfortably longer than a signed-
// in user needs to click a provider button.
const TIMEOUT_MS = 5 * 60 * 1000;

const PROVIDER_LABEL: Record<Provider, string> = {
  facebook: "Facebook",
  apple: "Apple",
};

const FacebookGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M22 12.06C22 6.5 17.52 2 12 2S2 6.5 2 12.06c0 5 3.66 9.15 8.44 9.94v-7.03H7.9v-2.9h2.54V9.85c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.9h-2.34V22c4.78-.79 8.44-4.94 8.44-9.94z" />
  </svg>
);
const AppleGlyph = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M17.05 12.54c-.03-2.6 2.12-3.85 2.22-3.91-1.21-1.77-3.09-2.02-3.76-2.05-1.6-.16-3.12.94-3.93.94-.81 0-2.06-.92-3.39-.9-1.74.03-3.35 1.01-4.25 2.57-1.81 3.14-.46 7.79 1.3 10.34.86 1.25 1.89 2.65 3.24 2.6 1.3-.05 1.79-.84 3.36-.84 1.57 0 2.01.84 3.39.81 1.4-.02 2.29-1.27 3.15-2.53.99-1.45 1.4-2.85 1.42-2.93-.03-.01-2.72-1.04-2.75-4.13zM14.6 4.7c.72-.87 1.2-2.08 1.07-3.28-1.03.04-2.28.69-3.02 1.55-.66.77-1.24 2-1.09 3.18 1.15.09 2.32-.58 3.04-1.45z" />
  </svg>
);

export default function LinkLoginModal({ provider, onSuccess, onCancel }: Props) {
  const [linkCode, setLinkCode] = useState<LinkCode | null>(null);
  const [phase, setPhase] = useState<"creating" | "waiting" | "expired" | "error">("creating");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Bumped on every Retry so the create/poll effect re-runs cleanly.
  const [attempt, setAttempt] = useState(0);

  const label = PROVIDER_LABEL[provider];

  // Always call the latest onSuccess without making it an effect dep - a
  // fresh inline closure from the parent must not re-run the create/poll
  // effect (which would mint a new code mid-flow). The effect keys only
  // on `attempt`, so exactly one code is created per attempt.
  const onSuccessRef = useRef(onSuccess);
  useEffect(() => { onSuccessRef.current = onSuccess; }, [onSuccess]);

  // Create a code, then poll until it is consumed or the client timeout
  // elapses. A self-rescheduling timeout (not setInterval) guarantees a
  // slow IPC round-trip can never let polls stack. Every exit path clears
  // the pending timer (CLAUDE.md: every timer in an effect returns a
  // cleanup). This is a plain network poll, so none of the mpv
  // get_property state-transition landmines apply.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    setPhase("creating");
    setError(null);

    const clearTimer = () => {
      if (timer != null) { clearTimeout(timer); timer = null; }
    };

    invoke<LinkCode>("stremio_link_create")
      .then((code) => {
        if (cancelled) return;
        setLinkCode(code);
        setPhase("waiting");
        const deadline = Date.now() + TIMEOUT_MS;

        const poll = async () => {
          if (cancelled) return;
          if (Date.now() >= deadline) {
            setPhase("expired");
            return;
          }
          try {
            const session = await invoke<UserSession | null>("stremio_link_poll", {
              code: code.code,
            });
            if (cancelled) return;
            if (session) {
              onSuccessRef.current(session);
              return; // stop polling - success is terminal
            }
          } catch {
            // Transient network/transport failure - keep polling within
            // the timeout window rather than giving up on one blip.
          }
          if (!cancelled) timer = setTimeout(poll, POLL_MS);
        };
        timer = setTimeout(poll, POLL_MS);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(String(err));
        setPhase("error");
      });

    return () => {
      cancelled = true;
      clearTimer();
    };
  }, [attempt]);

  const openStremio = useCallback(() => {
    if (linkCode) openUrl(linkCode.link).catch(() => {});
  }, [linkCode]);

  const copyCode = useCallback(() => {
    if (!linkCode) return;
    navigator.clipboard?.writeText(linkCode.code).then(
      () => { setCopied(true); window.setTimeout(() => setCopied(false), 1500); },
      () => {},
    );
  }, [linkCode]);

  const retry = useCallback(() => {
    setLinkCode(null);
    setAttempt((a) => a + 1);
  }, []);

  const Glyph = provider === "facebook" ? FacebookGlyph : AppleGlyph;

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass-panel-elevated rounded-3xl px-7 py-8 w-full max-w-[380px] mx-4
                      shadow-glass-edge flex flex-col gap-6">
        {/* Header */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span className="text-white/85"><Glyph /></span>
            <h1 className="text-white text-xl font-light tracking-wide">
              Continue with {label}
            </h1>
          </div>
          <p className="text-white/40 text-sm leading-relaxed">
            To keep your account secure, you finish signing in on Stremio's own
            page. Aura never sees your {label} password.
          </p>
        </div>

        {/* Body - one block per phase */}
        {phase === "creating" && (
          <div className="flex items-center justify-center py-8 gap-3 text-white/50 text-sm">
            <span className="w-4 h-4 border-2 border-white/25 border-t-white/70 rounded-full animate-spin" />
            Preparing a secure code…
          </div>
        )}

        {phase === "waiting" && linkCode && (
          <div className="flex flex-col gap-5">
            {/* Step 1 - open Stremio */}
            <button
              onClick={openStremio}
              className="w-full py-3 rounded-xl font-medium text-sm transition-all
                         bg-ln-accent/80 hover:bg-ln-accent active:scale-[0.99] text-white
                         flex items-center justify-center gap-2.5 shadow-glass-edge"
            >
              <Glyph />
              Open Stremio to sign in
            </button>

            {/* QR + code - for signing in on a phone, where Apple / Facebook
                app sessions usually already exist. */}
            <div className="flex items-center gap-4">
              {linkCode.qrcode ? (
                <img
                  src={linkCode.qrcode}
                  alt="Scan to sign in on your phone"
                  width={92}
                  height={92}
                  className="w-[92px] h-[92px] rounded-lg bg-white p-1 shrink-0"
                  draggable={false}
                />
              ) : null}
              <div className="flex flex-col gap-1.5 min-w-0">
                <span className="text-white/40 text-xs">
                  Or go to link.stremio.com and enter:
                </span>
                <button
                  onClick={copyCode}
                  title="Click to copy"
                  className="self-start font-mono text-2xl tracking-[0.3em] text-white
                             px-3 py-1.5 rounded-lg bg-white/6 border border-white/12
                             hover:border-white/25 transition-colors select-all"
                >
                  {linkCode.code}
                </button>
                <span className="text-white/30 text-xs h-3">
                  {copied ? "Copied" : ""}
                </span>
              </div>
            </div>

            {/* Live status */}
            <div className="flex items-center gap-2.5 text-white/45 text-xs">
              <span className="w-3.5 h-3.5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
              Waiting for you to sign in with {label} or email…
            </div>
          </div>
        )}

        {phase === "expired" && (
          <div className="flex flex-col gap-4">
            <div className="bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5">
              <p className="text-amber-200/90 text-xs leading-relaxed">
                This sign-in code expired before it was used. Generate a fresh one
                to try again.
              </p>
            </div>
            <button
              onClick={retry}
              className="w-full py-3 rounded-xl font-medium text-sm transition-all
                         bg-ln-accent/80 hover:bg-ln-accent active:scale-[0.99] text-white"
            >
              Get a new code
            </button>
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-4">
            <div className="bg-red-500/10 border border-red-500/20 rounded-xl px-3 py-2.5">
              <p className="text-red-400/90 text-xs leading-relaxed break-words">
                {error || "Could not reach Stremio. Check your connection and try again."}
              </p>
            </div>
            <button
              onClick={retry}
              className="w-full py-3 rounded-xl font-medium text-sm transition-all
                         bg-ln-accent/80 hover:bg-ln-accent active:scale-[0.99] text-white"
            >
              Try again
            </button>
          </div>
        )}

        {/* Cancel - always available */}
        <button
          onClick={onCancel}
          className="text-white/45 hover:text-white/70 text-sm text-center transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
