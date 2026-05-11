// Aura — Tauri 2 + libmpv desktop media player.
// Copyright (C) 2026 rm-sage
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
//
// Contact:
//   Electronic mail: contact@animasec.dev
//   Postal mail:     <intentionally omitted>
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { applyReducedMotionAttribute } from "./auraSettings";

// Synchronous reduced-motion gate, fired BEFORE React mounts so the
// initial paint already carries `<html data-reduced-motion="true|false">`.
// Without this, OS-pref users would see the BootSplash ambient sweep
// for ~200ms while JS catches up. Live updates are wired in App.tsx via
// matchMedia + aura:settings-changed subscriptions.
applyReducedMotionAttribute();

// ---------------------------------------------------------------------------
// Sentry — initialised before React mounts ONLY when the user has opted in
// via the first-run consent dialog AND a DSN is configured. Resolution
// order for the DSN:
//   1. Persisted setting `crash_reporting_dsn` (user-editable in Settings)
//   2. Build-time env var `VITE_SENTRY_DSN`
// The Rust side mirrors this for native panic capture (lib.rs::run); the JS
// side here covers React render errors + uncaught exceptions surfaced from
// the WebView2 layer. Both sides are gated on the same consent flag, so
// declining once silences both surfaces — there is no path that ships data
// before the user has explicitly said yes.
// ---------------------------------------------------------------------------
/** Hardcoded production Sentry DSN. Mirror of the constant in
 *  `src-tauri/src/lib.rs::HARDCODED_SENTRY_DSN`. End users never see
 *  or set this — they only choose whether crash reporting fires at
 *  all (via the first-run consent dialog). Developers can override
 *  with `VITE_SENTRY_DSN` at build time or via the (still-present
 *  but no-longer-surfaced) sidecar `dsn` field. */
const HARDCODED_SENTRY_DSN =
  "https://a58c117ea2f8f76c8f3f666be1ef44d8@o4511346738987008.ingest.de.sentry.io/4511346906038352";

async function bootstrapSentry() {
  try {
    const cfg = await invoke<{
      consent?: boolean | null;
      dsn?: string;
    }>("get_crash_reporting");
    if (cfg?.consent !== true) return;
    const persistedDsn = (cfg.dsn ?? "").trim();
    const buildDsn = (import.meta.env.VITE_SENTRY_DSN ?? "").trim();
    const dsn = persistedDsn || buildDsn || HARDCODED_SENTRY_DSN;
    if (!dsn) return;
    Sentry.init({
      dsn,
      // ── Privacy ────────────────────────────────────────────────────
      // SDK-level: no automatic PII attachment.
      // Server-level: pair this with the project-level "Prevent
      // Storing of IP Addresses" toggle in Sentry → Settings →
      // Security & Privacy.
      sendDefaultPii: false,

      // ── Tracing (performance) ─────────────────────────────────────
      // 10 % of events get a transaction trace attached. Tauri's IPC
      // bridge makes most "spans" worth tracing local — set higher if
      // you want to debug a specific UI hot path, or 0 to disable
      // entirely. browserTracingIntegration auto-instruments fetch /
      // history navigations.
      tracesSampleRate: 0.1,
      integrations: [
        Sentry.browserTracingIntegration(),
        Sentry.browserProfilingIntegration(),
        // Replay: records DOM mutations + network metadata so an
        // Issue can be played back as a video. Heavy masking by
        // default (every text node redacted, every input blocked) so
        // a session replay never exfiltrates a real password or
        // stream URL. Tune the sample rates if you want broader
        // coverage; the current 10 % session / 100 % on-error is a
        // common starting point.
        Sentry.replayIntegration({
          maskAllText:  true,
          blockAllMedia: true,
        }),
        // Console capture → Logs surface in Sentry. The integration
        // name in @sentry/react v8 is `captureConsoleIntegration`
        // (Sentry's Logs feature consumes these). Without it, Logs
        // view stays empty even when devs use console.error.
        Sentry.captureConsoleIntegration({
          levels: ["error", "warn", "info", "debug"],
        }),
      ],

      // ── Replay sampling ───────────────────────────────────────────
      // 0.1 = record 10 % of sessions for replay; 1.0 = record EVERY
      // session that produces an error. The on-error rate is the
      // valuable one — it catches the lead-up to a crash even when
      // the user wasn't part of the rolling sample.
      replaysSessionSampleRate: 0.1,
      replaysOnErrorSampleRate: 1.0,

      // ── Profiling sampling ────────────────────────────────────────
      // Conditional on a session being traced (so profilesSampleRate
      // multiplies tracesSampleRate). 1.0 here = "profile every
      // sampled trace"; the effective rate is therefore 10 %.
      profilesSampleRate: 1.0,

      release: import.meta.env.VITE_APP_VERSION as string | undefined,
      beforeSend(event) {
        // Privacy clamp: Sentry's ingest server can derive an IP from
        // the inbound TCP connection independently of the SDK — set
        // ip_address explicitly here so the server has nothing to
        // fall back on. Strip request + geo for the same reason.
        if (event.user) {
          event.user.ip_address = "0.0.0.0";
          delete event.user.email;
          delete event.user.username;
        } else {
          event.user = { ip_address: "0.0.0.0" };
        }
        delete event.request;
        if (event.contexts) {
          delete (event.contexts as Record<string, unknown>).geo;
        }
        return event;
      },
    });
  } catch {
    // Settings load failure is non-fatal — we just don't init Sentry,
    // matching the default-off posture. The Rust side has its own
    // independent gate so this isn't the only safeguard.
  }
}
void bootstrapSentry();

// ---------------------------------------------------------------------------
// Native browser features we always want OFF (this is a desktop app, not a
// website):
//   • The default right-click menu — every right-click in Aura should route
//     through our custom <ContextMenuHost />. The component's openContextMenu()
//     is always available; native menus would just be visual noise.
//   • The default text-selection drag highlight on body (handled in CSS).
//
// A capture-phase listener installed BEFORE React mounts guarantees the
// suppression covers React's synthetic events too — by the time a component's
// onContextMenu fires, the native menu has already been preventDefault()'d.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Global error capture — funnels both unhandled exceptions and rejected
// promises into the F12 DevConsole + a separate `aura:fatal-error`
// CustomEvent that downstream components (a future crash-report panel
// or remote telemetry sink) can subscribe to. Without this every
// uncaught error vanishes into the WebView2 console where users will
// never see it. The handlers run BEFORE React mounts so even errors
// during the bootstrap path are captured.
// ---------------------------------------------------------------------------
window.addEventListener("error", (e) => {
  const msg = e.error?.stack ?? e.message ?? String(e);
  console.error(`[fatal] uncaught error: ${msg}`);
  window.dispatchEvent(new CustomEvent("aura:fatal-error", {
    detail: { kind: "error", message: msg },
  }));
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason;
  const msg = reason?.stack ?? reason?.message ?? String(reason);
  console.error(`[fatal] unhandled rejection: ${msg}`);
  window.dispatchEvent(new CustomEvent("aura:fatal-error", {
    detail: { kind: "rejection", message: msg },
  }));
});

window.addEventListener(
  "contextmenu",
  (e) => {
    e.preventDefault();
    // Diagnostic — surfaces every contextmenu fire to the DevConsole so
    // we can verify the event is even reaching the page when "right-click
    // does nothing" is reported. The single capture-phase preventDefault
    // here only stops the BROWSER's native menu — it does NOT stop the
    // event from continuing to bubble through React's synthetic handler
    // layer, so card-level onContextMenu handlers still fire. (This is a
    // common misconception that has caused a few false-flag investigations.)
    const tgt = e.target as Element | null;
    const tag = tgt?.tagName?.toLowerCase() ?? "?";
    const card = tgt?.closest?.("[data-meta-card]")?.getAttribute("data-meta-card") ?? null;
    console.info(`[ctx] contextmenu fire tag=${tag} card=${card ?? "—"}`);
  },
  { capture: true },
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
