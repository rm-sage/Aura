// Aura — Tauri 2 + libmpv desktop media player.
// Copyright (C) 2026 rm-sage
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// First-run crash reporting consent dialog.
//
// Mounts at the App root. While the persisted `crash_reporting_consent`
// setting is `null` (the user has never been asked), this component shows
// a one-time modal explaining what gets collected and asking for an
// explicit yes / no. Once the user picks either option, the setting flips
// to `true` or `false` and the dialog never re-opens until they reset it
// from Settings → Crash Reporting.
//
// IMPORTANT: We deliberately do NOT init the Sentry SDK from inside this
// component. Both the Rust side (`lib.rs::init_sentry_if_consented`) and
// the JS side (`main.tsx::bootstrapSentry`) read the consent flag at
// startup. Toggling consent at runtime persists the setting but Sentry
// only picks it up on the next launch — the user is told this in the
// modal copy and via a follow-up toast.
// ---------------------------------------------------------------------------

type Consent = boolean | null | undefined;

interface CrashReportingConfig {
  consent?: Consent;
  dsn?: string;
}

export default function CrashReportingConsent() {
  const [consent, setConsent] = useState<Consent>(undefined);
  const [submitting, setSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const cfg = await invoke<CrashReportingConfig>("get_crash_reporting");
      setConsent(cfg?.consent ?? null);
    } catch {
      setConsent(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Re-read whenever some other surface (Settings page, scope switch
    // after login) writes to the global crash-reporting config —
    // keeps the modal's visibility coherent.
    const onChanged = () => { void refresh(); };
    window.addEventListener("aura:crash-reporting-changed", onChanged);
    // Settings export / reset also touches the sidecar.
    window.addEventListener("aura:settings-changed", onChanged);
    return () => {
      window.removeEventListener("aura:crash-reporting-changed", onChanged);
      window.removeEventListener("aura:settings-changed", onChanged);
    };
  }, [refresh]);

  const submit = useCallback(async (consented: boolean) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await invoke("set_crash_reporting", { consent: consented, dsn: null });
      setConsent(consented);
      window.dispatchEvent(new CustomEvent("aura:player-toast", {
        detail: {
          message: consented
            ? "Crash reporting enabled. Restart Aura to start sending reports."
            : "Crash reporting declined. You can change this in Settings later.",
        },
      }));
      window.dispatchEvent(new CustomEvent("aura:crash-reporting-changed"));
    } catch (e) {
      console.error("Failed to record crash reporting consent", e);
    } finally {
      setSubmitting(false);
    }
  }, [submitting]);

  // Render nothing while we don't know the state, OR if the user has
  // already answered. The dialog is the only thing this component
  // produces — there is no chrome, no border, no "X" button: opt-in or
  // opt-out are the only valid exits.
  if (consent !== null) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="crash-consent-title"
      className="fixed inset-0 z-[2000] flex items-center justify-center"
    >
      {/* Dim + blur on a sibling layer, never the wrapper: an ancestor's
          backdrop-filter (or fading opacity) would blind the card's glass. */}
      <div aria-hidden className="aura-modal-backdrop-in absolute inset-0 bg-black/70 backdrop-blur-md" />
      <div
        className="aura-modal-card-in aura-float-glass relative rounded-2xl max-w-[520px] w-[92%] p-7
                   text-white"
      >
        <h2
          id="crash-consent-title"
          className="text-[18px] font-semibold tracking-tight mb-3"
        >
          Help improve Aura by sending crash reports?
        </h2>

        <p className="text-[13.5px] leading-relaxed text-white/80 mb-3">
          Aura can send anonymised crash reports to the developer when something
          unexpected happens: uncaught errors, panics, and stack traces. This
          helps fix bugs faster and is the same feedback channel most modern
          desktop apps use.
        </p>

        <div className="rounded-xl border border-white/12 bg-white/[0.03] p-4 mb-4 space-y-2">
          <p className="text-[12.5px] text-white/85 font-medium">
            What gets sent
          </p>
          <ul className="text-[12px] text-white/70 leading-relaxed list-disc pl-5 space-y-1">
            <li>The error message and stack trace, plus recent console warnings and errors</li>
            <li>OS version, app version and runtime info, and a random install id</li>
            <li>
              A masked replay of the app window (all text hidden, images blocked) with
              network request details, for sessions with an error and about 1 in 10 others
            </li>
          </ul>
          <p className="text-[12.5px] text-white/85 font-medium pt-2">
            Removed before sending
          </p>
          <ul className="text-[12px] text-white/70 leading-relaxed list-disc pl-5 space-y-1">
            <li>Your account email and system username</li>
            <li>Your IP address and location</li>
          </ul>
          <p className="text-[11.5px] text-white/55 leading-relaxed pt-1">
            The error text itself is kept, so it can include what the failing code was
            handling, such as a title name.
          </p>
        </div>

        <p className="text-[11.5px] text-white/55 leading-relaxed mb-5">
          You can change your answer any time in Settings → Crash Reporting,
          with Show advanced settings turned on.
          Reports only start sending after you restart Aura.
        </p>

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit(false)}
            className="aura-glass-flat aura-glass-press px-4 py-2 rounded-lg text-[13px] font-medium tracking-wide
                       text-white/85 hover:text-white disabled:opacity-50"
          >
            No thanks
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => submit(true)}
            className="aura-glass-flat aura-glass-press is-primary px-4 py-2 rounded-lg text-[13px] font-medium tracking-wide
                       disabled:opacity-50"
          >
            Send crash reports
          </button>
        </div>
      </div>
    </div>
  );
}
