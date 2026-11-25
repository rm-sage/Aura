// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openExternalUrl } from "../externalUrl";
import {
  ONBOARDING_STEP_IDS,
  loadOnboardingProgress,
  markOnboardingComplete,
  saveOnboardingProgress,
  type OnboardingMode,
  type OnboardingStepId,
} from "../onboarding";
import { loadAuraSettings, saveAuraSettings, type AuraSettings } from "../auraSettings";
import {
  applySettingsImport,
  importSummaryStatus,
  parseImportInput,
  readImportFile,
} from "../settingsTransfer";
import { patchBackendSettings, type AppSettingsLike } from "../backendSettings";
import { LANGUAGE_OPTIONS, subtitleLanguageOptions } from "../languages";
import { normalizeManifestInput } from "../manifestUrl";
import { SegmentedControl, SettingDropdown, SettingToggle } from "../settingsControls";
import ScrobbleAuthRow from "../ScrobbleAuthRow";
import {
  SCROBBLE_ROW_DESCRIPTIONS,
  SCROBBLE_SERVICES,
  connectedServices,
  knownScrobbleServicesAvailable,
  scrobbleServicesAvailable,
  useScrobbleConnections,
  type ScrobbleService,
} from "../scrobbleConn";
import { showAppToast } from "../AppToast";
import type { UserSession } from "../LoginView";
import type { AddonEntry, ThemeId } from "../types";
import { ADDON_LIST_NOT_LOADED, COLLECTION_CHANGED, accountChangedCopy } from "../types";
import { THEME_DESCRIPTIONS, THEME_LABELS, THEME_SWATCHES, useTheme } from "../ThemeEngine";
import { hasAIOMetadata } from "../aiometadata";
import { useAddonHints } from "../addonHints";
import HdrModeSetting from "../HdrModeSetting";
import { GlassStyleRows } from "../GlassStyleSetting";
import { decideHdrDefaultForNewDevice, hdrModeOf, setHdrMode, type HdrMode } from "../hdrMode";

// ---------------------------------------------------------------------------
// OnboardingView: the first-run setup wizard.
//
// Mounted by App.tsx in the body slot (after LandingView, below the always
// mounted TitleBar) while `onboardingActive` is true. Steps, in order:
//   welcome   Stremio account (a guest can sign in from here) and an optional
//             import of settings exported from another Aura install.
//   look      Theme swatches. A click applies the theme through ThemeEngine.
//             Then the glass material and cursor glow (the same rows as
//             Settings > Theme, GlassStyleSetting.tsx).
//   playback  Audio and subtitle languages, HDR mode, anime opening /
//             ending skips, autoplay of the next episode, and the close
//             button.
//   addons    Recommended addons: one-click Install, or Configure in the
//             browser and paste the manifest URL back.
//   tracking  AniList / Simkl sign-in (only when this build can use one).
//
// Every choice is written the moment it is made, through the same helpers
// Settings uses (patchBackendSettings, saveAuraSettings, setTheme,
// applySettingsImport, ScrobbleAuthRow), so "Skip setup" and Back lose
// nothing, and each step shows the LIVE values (re-read when a cloud pull or
// an import lands mid-wizard).
//
// Modes (see onboarding.ts): "first-run" persists the step so a quit
// resumes there; "rerun" walks every step again without persisting;
// "addons-only" shows only the addons step with no stepper, no Back and a
// "Done" button.
// ---------------------------------------------------------------------------

interface Props {
  /** Active Stremio session (null = guest). Decides the addon install path
   *  (account or local list), the account box and the scrobble scope. */
  session: UserSession | null;
  /** Installed addons, to mark recommended ones as installed. */
  addons: AddonEntry[];
  /** True once the signed-in addon list has loaded from the account this
   *  session (always true for a guest). Until then the addon cards show a
   *  loading state instead of Installed / Install. Render-safe: App mirrors
   *  it into state, unlike `isAddonListSynced`, which starts a sync. */
  addonListReady: boolean;
  /** Called when an addon install lands, so App can add it to its list. */
  onAddonInstalled: (entry: AddonEntry) => void;
  /** App's reload of the signed-in list from the Stremio account, run when
   *  an install is refused as COLLECTION_CHANGED (see AddonsView). */
  onAccountChanged?: () => Promise<boolean>;
  /** Whether this auth key's list has loaded from the Stremio account this
   *  session (App.isAddonListSynced). A false answer also starts a sync, so
   *  it is never asked in render: only when an install is pressed (which
   *  then says ADDON_LIST_NOT_LOADED instead of writing) and from the addons
   *  step's effect or Retry while the list is still loading. */
  isAddonListSynced?: (authKey: string) => boolean;
  /** Called when the wizard closes (Finish, Done or Skip setup). */
  onComplete: () => void;
  mode: OnboardingMode;
}

// ---------------------------------------------------------------------------
// Shared class strings
// ---------------------------------------------------------------------------

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/60";

// Glass buttons (GLASS SYSTEM in App.css, glass-settings.css): the fills,
// rings and hover tints ride the glass hooks so both glass materials draw
// them. Never add bg-* / border-* / shadow-* utilities to these.
const PRIMARY_BUTTON = `aura-glass-flat aura-glass-press is-cta px-5 py-2 rounded-full text-[12.5px]
  font-semibold text-ln-accent-ink disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`;

const SECONDARY_BUTTON = `aura-glass-flat aura-glass-press px-4 py-2 rounded-full text-[12.5px] font-medium
  text-white/70 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed ${FOCUS_RING}`;

const ROW_ACTION_ACCENT = `aura-glass-flat aura-glass-press is-primary px-3 py-1 rounded-lg
  text-[11px] font-medium tracking-wide disabled:opacity-50
  disabled:cursor-not-allowed ${FOCUS_RING}`;

const ROW_ACTION_NEUTRAL = `aura-glass-flat aura-glass-press px-3 py-1 rounded-lg
  text-white/75 text-[11px] font-medium tracking-wide
  disabled:opacity-50 disabled:cursor-not-allowed ${FOCUS_RING}`;

const TEXT_BUTTON = `text-white/45 hover:text-white/80 text-xs font-medium
  transition-colors rounded ${FOCUS_RING}`;

// ---------------------------------------------------------------------------
// Step metadata
// ---------------------------------------------------------------------------

const STEP_META: Record<OnboardingStepId, { label: string; title: string; lead: string }> = {
  welcome: {
    label: "Welcome",
    title: "Welcome to Aura",
    lead: "A few quick choices to make Aura yours. Each one applies right away, and everything can be changed later in Settings.",
  },
  look: {
    label: "Look",
    title: "Pick a look",
    lead: "Themes set the accent colour, and the material style sets how menus and panels look. Click one to try it.",
  },
  playback: {
    label: "Playback",
    title: "Playback",
    lead: "Which audio and subtitles Aura picks, how HDR videos are shown, and what it does around openings, endings and the close button.",
  },
  addons: {
    label: "Addons",
    title: "Recommended addons",
    lead: "Aura plays what your Stremio addons find. This starter set works well with it: Configure opens an addon's setup page in your browser, then paste the manifest URL it gives you here.",
  },
  tracking: {
    label: "Tracking",
    title: "Track what you watch",
    lead: "Connect a tracker and Aura updates it as you finish things. Optional: you can connect later in Settings > Scrobbling.",
  },
};

/** The index of `stepId` in `steps`. A step that is not in the list (the
 *  tracking step once the build turns out to have no scrobble service) falls
 *  back to the nearest step before it in the canonical order. */
function resolveStepIndex(steps: readonly OnboardingStepId[], stepId: OnboardingStepId): number {
  const exact = steps.indexOf(stepId);
  if (exact >= 0) return exact;
  const rank = ONBOARDING_STEP_IDS.indexOf(stepId);
  let best = 0;
  steps.forEach((id, i) => {
    if (ONBOARDING_STEP_IDS.indexOf(id) <= rank) best = i;
  });
  return best;
}

// ---------------------------------------------------------------------------
// OnboardingView
// ---------------------------------------------------------------------------

export default function OnboardingView({
  session, addons, addonListReady, onAddonInstalled, onAccountChanged,
  isAddonListSynced, onComplete, mode,
}: Props) {
  const [stepId, setStepId] = useState<OnboardingStepId>(() => {
    if (mode === "addons-only") return "addons";
    if (mode === "first-run") return loadOnboardingProgress().stepId;
    return ONBOARDING_STEP_IDS[0];
  });
  // Recommended-addon ids installed from the wizard (never URLs).
  const [installed, setInstalled] = useState<string[]>(
    () => (mode === "first-run" ? loadOnboardingProgress().installed : []),
  );

  // Which scrobble services this build can use: decides whether the
  // tracking step exists. Unknown (null) reads as available until answered,
  // the same as scrobbleConn's failure semantic.
  const [scrobbleAvailable, setScrobbleAvailable] = useState<ReadonlySet<ScrobbleService> | null>(
    () => knownScrobbleServicesAvailable(),
  );
  useEffect(() => {
    let live = true;
    void scrobbleServicesAvailable().then((set) => { if (live) setScrobbleAvailable(set); });
    return () => { live = false; };
  }, []);
  const trackingServices = useMemo(
    () => SCROBBLE_SERVICES.filter((s) => scrobbleAvailable?.has(s) ?? true),
    [scrobbleAvailable],
  );

  const steps = useMemo<OnboardingStepId[]>(() => {
    if (mode === "addons-only") return ["addons"];
    return ONBOARDING_STEP_IDS.filter((id) => id !== "tracking" || trackingServices.length > 0);
  }, [mode, trackingServices]);
  const index = resolveStepIndex(steps, stepId);
  const currentId = steps[index];
  const isLast = index === steps.length - 1;

  // First run on this device (a new device of an existing account too: the
  // completion flag is device-local): default the HDR mode to the recommended
  // one for this display. Never over a choice made by hand; see hdrMode.ts.
  useEffect(() => {
    if (mode === "first-run") void decideHdrDefaultForNewDevice();
  }, [mode]);

  // First run only: a quit resumes at this step. A rerun or a reopen starts
  // fresh and leaves nothing behind.
  useEffect(() => {
    if (mode !== "first-run") return;
    saveOnboardingProgress({ v: 2, stepId: currentId, installed });
  }, [mode, currentId, installed]);

  // Whether the tracking step was ever on screen, for the bell notice.
  const trackingSeenRef = useRef(false);
  useEffect(() => {
    if (currentId === "tracking") trackingSeenRef.current = true;
  }, [currentId]);

  // Focus the step heading on every step change so a screen reader announces
  // it (the heading is keyed on the step, so this lands on a fresh node).
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [currentId]);

  const scrobbleConn = useScrobbleConnections();
  const handleFinish = useCallback(() => {
    if (mode === "addons-only") {
      onComplete();
      return;
    }
    const firstCompletion = markOnboardingComplete();
    // One bell notice about scrobbling, for a first run that never reached
    // the tracking step and has nothing connected. Guests included: they
    // scrobble under the "guest" scope. App dismisses it once anything
    // connects (a sign-in still pending here may land after Finish).
    const anyAvailable = trackingServices.length > 0;
    if (
      firstCompletion
      && !trackingSeenRef.current
      && anyAvailable
      && connectedServices(scrobbleConn).length === 0
    ) {
      window.dispatchEvent(new CustomEvent("aura:notify-scrobble-onboarding"));
    }
    onComplete();
  }, [mode, onComplete, trackingServices, scrobbleConn]);

  const goTo = useCallback((i: number) => {
    const next = steps[Math.max(0, Math.min(steps.length - 1, i))];
    if (next) setStepId(next);
  }, [steps]);

  const markInstalled = useCallback((id: string, entry: AddonEntry) => {
    setInstalled((prev) => (prev.includes(id) ? prev : [...prev, id]));
    onAddonInstalled(entry);
  }, [onAddonInstalled]);

  const meta = STEP_META[currentId];
  const addonsOnly = mode === "addons-only";

  // "Suggested addons" opens from the Addons page as a full view with no rail,
  // so Escape goes back the way Done does. Only in that mode: in the first run
  // or a rerun, Escape quitting the whole wizard would surprise. Registered
  // before the paste field's own listener (capture listeners on window run in
  // registration order), so it yields to every nested layer by looking for it.
  useEffect(() => {
    if (!addonsOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector(
        "[data-aura-context-menu], [data-onboarding-paste], [aria-modal=\"true\"]",
      )) return;
      e.preventDefault();
      e.stopPropagation();
      handleFinish();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [addonsOnly, handleFinish]);

  return (
    <div className="aura-view-enter flex-1 min-h-0 relative flex items-center justify-center p-6 overflow-hidden">
      {/* Static vignette only: AmbientAura already paints the sweep behind
          the shell (and hides it on the high-contrast themes). */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ background: "radial-gradient(120% 80% at 50% 60%, transparent 30%, rgba(0,0,0,0.55) 95%)" }}
      />

      <div
        className="relative z-10 w-full max-h-full flex flex-col gap-4"
        style={{ maxWidth: "min(760px, 100%)" }}
      >
        {!addonsOnly && (
          <div className="flex items-center justify-between gap-4">
            <Stepper steps={steps} index={index} />
            <button type="button" onClick={handleFinish} className={`flex-shrink-0 ${TEXT_BUTTON}`}>
              Skip setup
            </button>
          </div>
        )}

        <div className="aura-float-glass rounded-3xl flex flex-col min-h-0">
          <header className="px-7 pt-6 pb-4 border-b border-white/8 space-y-1">
            <p className="text-white/40 text-xs font-semibold tracking-[0.1em] uppercase">
              {addonsOnly ? "Suggested addons" : `Step ${index + 1} of ${steps.length}`}
            </p>
            <h2
              key={currentId}
              ref={headingRef}
              tabIndex={-1}
              className="aura-row-title text-2xl font-semibold tracking-tight focus:outline-none"
            >
              {meta.title}
            </h2>
            <p className="text-white/55 text-sm leading-relaxed">{meta.lead}</p>
          </header>

          <div
            key={currentId}
            className="aura-header-swap aura-page-scroller flex-1 min-h-0 overflow-y-auto px-7 py-5 space-y-5"
          >
            {currentId === "welcome" && <WelcomeStep session={session} addons={addons} />}
            {currentId === "look" && <LookStep />}
            {currentId === "playback" && <PlaybackStep />}
            {currentId === "addons" && (
              <AddonsStep
                session={session}
                addons={addons}
                addonListReady={addonListReady}
                onAccountChanged={onAccountChanged}
                isAddonListSynced={isAddonListSynced}
                onInstalled={markInstalled}
              />
            )}
            {currentId === "tracking" && (
              <TrackingStep session={session} services={trackingServices} />
            )}
          </div>

          <footer className="px-7 py-4 border-t border-white/8 flex items-center justify-between gap-3">
            {!addonsOnly && index > 0 ? (
              <button type="button" onClick={() => goTo(index - 1)} className={SECONDARY_BUTTON}>
                Back
              </button>
            ) : <span />}
            <button
              type="button"
              onClick={() => (addonsOnly || isLast ? handleFinish() : goTo(index + 1))}
              className={PRIMARY_BUTTON}
            >
              {addonsOnly ? "Done" : isLast ? "Finish" : "Continue"}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function Stepper({ steps, index }: { steps: readonly OnboardingStepId[]; index: number }) {
  return (
    <ol className="flex items-center gap-2 min-w-0 flex-wrap" aria-label="Setup steps">
      {steps.map((id, i) => {
        const state = i === index ? "current" : i < index ? "done" : "todo";
        return (
          <li
            key={id}
            aria-current={state === "current" ? "step" : undefined}
            className="flex items-center gap-2"
          >
            {i > 0 && <span aria-hidden className="h-px w-5 bg-white/10" />}
            <span
              aria-hidden
              className={`h-6 w-6 rounded-full grid place-items-center text-[11px] font-semibold border
                          ${state === "current"
                            ? "bg-ln-accent text-ln-accent-ink border-ln-accent"
                            : state === "done"
                              ? "bg-white/[0.06] text-[color:var(--ln-accent-mark-text)] border-white/15"
                              : "bg-white/5 text-white/45 border-white/10"}`}
            >
              {state === "done" ? <CheckGlyph /> : i + 1}
            </span>
            <span
              className={`text-[12px] font-medium ${state === "current" ? "text-white/80" : "text-white/45"}`}
            >
              {STEP_META[id].label}
              {state === "done" && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

/** A Settings-style section box, with an optional group label above it. */
function StepGroup({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      {label && (
        <h3 className="text-white/55 text-xs font-semibold tracking-[0.1em] uppercase">{label}</h3>
      )}
      <div className="aura-content-panel space-y-5 rounded-2xl px-5 py-5">
        {children}
      </div>
    </section>
  );
}

function Divider() {
  return <div className="h-px bg-white/6" />;
}

function MutedNote({ children }: { children: React.ReactNode }) {
  return <p className="text-white/40 text-xs leading-relaxed">{children}</p>;
}

// ---------------------------------------------------------------------------
// Step: welcome (account + optional import)
// ---------------------------------------------------------------------------

function WelcomeStep({ session, addons }: { session: UserSession | null; addons: AddonEntry[] }) {
  return (
    <>
      <StepGroup label="Stremio account">
        {session ? (
          <p className="text-white/75 text-sm leading-relaxed">
            Signed in to Stremio. Your addons, library and settings sync with your account.
          </p>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <p className="flex-1 min-w-0 text-white/75 text-sm leading-relaxed">
              You're using Aura without a Stremio account. Sign in to sync your addons,
              library and settings across devices.
            </p>
            <button
              type="button"
              onClick={() => window.dispatchEvent(new CustomEvent("aura:show-login"))}
              className={`flex-shrink-0 ${ROW_ACTION_ACCENT}`}
            >
              Sign in
            </button>
          </div>
        )}
      </StepGroup>
      <CrashReportsGroup />
      <ImportBox signedIn={!!session} addons={addons} />
    </>
  );
}

type CrashChoice = "send" | "off";

const CRASH_CHOICE_OPTIONS: { value: CrashChoice; label: string }[] = [
  { value: "send", label: "Send crash reports" },
  { value: "off", label: "Don't send" },
];

/** The crash-reporting question, asked inline here instead of by the root
 *  CrashReportingConsent dialog (App holds that one off while the wizard is
 *  up). Same command and event as the dialog and Settings, so all three
 *  agree. A wizard closed without an answer leaves consent null, and the
 *  dialog asks afterwards. Nothing here starts the reporter: it reads the
 *  consent at launch. */
function CrashReportsGroup() {
  // undefined: not read yet; null: never answered.
  const [consent, setConsent] = useState<boolean | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Changed in this visit: the reporter reads consent only at launch, so
  // either direction takes effect after a restart.
  const [changedHere, setChangedHere] = useState(false);

  useEffect(() => {
    let live = true;
    const refresh = () => {
      invoke<{ consent?: boolean | null }>("get_crash_reporting")
        .then((cfg) => { if (live) setConsent(cfg?.consent ?? null); })
        .catch(() => { if (live) setConsent(null); });
    };
    refresh();
    window.addEventListener("aura:crash-reporting-changed", refresh);
    window.addEventListener("aura:settings-changed", refresh);
    return () => {
      live = false;
      window.removeEventListener("aura:crash-reporting-changed", refresh);
      window.removeEventListener("aura:settings-changed", refresh);
    };
  }, []);

  const choose = useCallback(async (v: CrashChoice) => {
    const next = v === "send";
    if (busy || consent === next) return;
    setBusy(true);
    try {
      await invoke("set_crash_reporting", { consent: next, dsn: null });
      setConsent(next);
      setChangedHere(true);
      window.dispatchEvent(new CustomEvent("aura:crash-reporting-changed"));
    } catch (e) {
      console.error("Failed to record crash reporting consent", e);
      showAppToast("Couldn't save the crash report choice. Try again.", { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }, [busy, consent]);

  const value: CrashChoice | null = consent === true ? "send" : consent === false ? "off" : null;

  return (
    <StepGroup label="Crash reports">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-white/75 text-sm font-medium">Help fix bugs faster</p>
            <p className="text-white/35 text-xs mt-0.5 leading-relaxed">
              When something goes wrong, Aura can send an anonymised report to the developer:
              the error and stack trace, recent console warnings and errors, your OS and app
              version, a random install id, and a masked replay of the app window (text hidden,
              images blocked) with network request details, for sessions with an error and about
              1 in 10 others. Your account email, IP address
              and location are removed. The error text itself is kept, so it can include what
              the failing code was handling.
            </p>
          </div>
          <SegmentedControl
            value={value}
            options={CRASH_CHOICE_OPTIONS}
            ariaLabel="Crash reports"
            onChange={(v) => { void choose(v); }}
          />
        </div>
        <MutedNote>
          {consent === undefined
            ? "Checking your current choice..."
            : consent === null
              ? "No choice yet. Change it any time in Settings > Crash Reporting, with Show advanced settings turned on."
              : consent
                ? `Sending is on.${changedHere ? " Reports start after you restart Aura." : ""} Change it any time in Settings > Crash Reporting, with Show advanced settings turned on.`
                : `Sending is off.${changedHere ? " This takes effect after you restart Aura." : ""} Change it any time in Settings > Crash Reporting, with Show advanced settings turned on.`}
        </MutedNote>
      </div>
    </StepGroup>
  );
}

type ImportStatus = { kind: "idle" } | { kind: "ok" | "error"; message: string };

function ImportBox({ signedIn, addons }: { signedIn: boolean; addons: AddonEntry[] }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ImportStatus>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const applyText = useCallback(async (raw: string) => {
    const blob = parseImportInput(raw);
    if (!blob) {
      setStatus({ kind: "error", message: "Couldn't parse. Paste a valid export string or JSON." });
      return;
    }
    setBusy(true);
    try {
      const summary = await applySettingsImport(blob, addons, (patch) => patchBackendSettings(patch));
      const line = importSummaryStatus(summary);
      setStatus(summary.unresolved > 0
        ? { ...line, message: `${line.message} Install those addons in the Addons step, then import again to bring over the addon choices.` }
        : line);
    } catch (e) {
      setStatus({ kind: "error", message: `Import failed: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  }, [addons]);

  const onPickFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // so picking the same file again fires onChange
    if (!file) return;
    try {
      await applyText(await readImportFile(file));
    } catch (err) {
      setStatus({ kind: "error", message: `Couldn't read file: ${String(err)}` });
    }
  }, [applyText]);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={TEXT_BUTTON}>
        Import settings from another Aura install
      </button>
    );
  }

  return (
    <StepGroup label="Import settings">
      <div className="space-y-3">
        <p className="text-white/35 text-xs leading-relaxed">
          Paste the export string from Settings &gt; Backup &amp; Restore on your other install,
          or pick the exported file. Addon choices apply to the addons you have installed.
        </p>
        {signedIn && (
          <MutedNote>
            Signed-in settings already sync, so this is only needed to bring over a guest
            setup or an export.
          </MutedNote>
        )}
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); if (status.kind === "error") setStatus({ kind: "idle" }); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim() && !busy) {
              e.preventDefault();
              void applyText(text);
            }
          }}
          placeholder="Paste an export string here"
          spellCheck={false}
          className="aura-glass-field w-full h-28 rounded-xl px-4 py-3
                     text-[11.5px] font-mono placeholder:text-white/25 outline-none
                     resize-none break-all"
          style={{ color: "var(--text-primary)" }}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={!text.trim() || busy}
            onClick={() => void applyText(text)}
            className={PRIMARY_BUTTON}
          >
            {busy ? "Importing…" : "Import"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className={SECONDARY_BUTTON}
          >
            Import from file…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json,.txt"
            onChange={onPickFile}
            className="hidden"
          />
        </div>
        {status.kind !== "idle" && (
          <p className={`text-xs leading-relaxed ${status.kind === "ok" ? "text-emerald-300/85" : "text-rose-300/85"}`}>
            {status.message}
          </p>
        )}
      </div>
    </StepGroup>
  );
}

// ---------------------------------------------------------------------------
// Step: look (theme swatches)
// ---------------------------------------------------------------------------

const THEME_IDS = Object.keys(THEME_LABELS) as ThemeId[];

function LookStep() {
  const { theme, setTheme } = useTheme();
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // The glass rows write AuraSettings directly, like Settings does; re-read on
  // any settings change (an import or a cloud pull mid-wizard).
  const [aura, setAura] = useState<AuraSettings>(() => loadAuraSettings());
  useEffect(() => {
    const reread = () => setAura(loadAuraSettings());
    window.addEventListener("aura:settings-changed", reread);
    return () => window.removeEventListener("aura:settings-changed", reread);
  }, []);
  const patchAura = <K extends keyof AuraSettings>(key: K, value: AuraSettings[K]) => {
    saveAuraSettings({ ...loadAuraSettings(), [key]: value });
  };

  // Radio-group arrows: move to the neighbouring tile and pick it.
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1
      : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = (i + delta + THEME_IDS.length) % THEME_IDS.length;
    setTheme(THEME_IDS[next]);
    tileRefs.current[next]?.focus();
  };

  return (
    <>
    <StepGroup label="Theme">
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 lg:grid-cols-4 gap-2">
        {THEME_IDS.map((id, i) => {
          const active = theme === id;
          const [name, subtitle] = THEME_LABELS[id].split(" · ");
          const swatch = THEME_SWATCHES[id];
          return (
            <button
              key={id}
              ref={(el) => { tileRefs.current[i] = el; }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => { if (id !== theme) setTheme(id); }}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={`aura-glass-flat aura-glass-choice rounded-xl p-2.5 text-left ${FOCUS_RING}`}
            >
              <span
                aria-hidden
                className="block h-7 rounded-md mb-2 relative overflow-hidden border border-white/8"
                style={{ background: swatch.base }}
              >
                <span
                  className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full"
                  style={{ background: `rgb(${swatch.accent})` }}
                />
              </span>
              <span className="aura-glass-choice-label block text-white/85 text-[12.5px] font-medium truncate">{name}</span>
              {subtitle && <span className="block text-white/40 text-[11px] truncate">{subtitle}</span>}
            </button>
          );
        })}
      </div>
      <p className="text-white/35 text-xs leading-relaxed">{THEME_DESCRIPTIONS[theme]}</p>
    </StepGroup>
    <StepGroup label="Material">
      <GlassStyleRows
        glassStyle={aura.glassStyle}
        cursorGlow={aura.glassCursorGlow}
        onGlassStyle={(v) => patchAura("glassStyle", v)}
        onCursorGlow={(v) => patchAura("glassCursorGlow", v)}
      />
    </StepGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step: playback
// ---------------------------------------------------------------------------

/** The backend fields this step shows, read defensively from get_settings. */
interface PlaybackBackend {
  audio_priority: string[];
  avoid_dubs: boolean;
  subtitle_language: string;
  skip_op_mode: string;
  skip_ed_mode: string;
  minimize_to_tray_on_close: boolean;
  hdr_mode: HdrMode;
}

function readPlaybackBackend(s: AppSettingsLike): PlaybackBackend {
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);
  return {
    audio_priority: Array.isArray(s.audio_priority)
      ? s.audio_priority.filter((x): x is string => typeof x === "string")
      : ["original", "en"],
    avoid_dubs: s.avoid_dubs === true,
    subtitle_language: str(s.subtitle_language, "en"),
    skip_op_mode: str(s.skip_op_mode, "prompt"),
    skip_ed_mode: str(s.skip_ed_mode, "prompt"),
    minimize_to_tray_on_close: s.minimize_to_tray_on_close === true,
    hdr_mode: hdrModeOf(s),
  };
}

const AUDIO_ORIGINAL = "original";
const AUDIO_CUSTOM = "custom";

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The audio dropdown's choice for a stored priority list: one of the
 *  presets, else "custom" (a list edited in Settings, left untouched). */
function audioChoiceFor(priority: readonly string[]): string {
  if (sameList(priority, [AUDIO_ORIGINAL, "en"])) return AUDIO_ORIGINAL;
  const match = LANGUAGE_OPTIONS.find((l) => sameList(priority, [l.value, AUDIO_ORIGINAL]));
  return match ? match.value : AUDIO_CUSTOM;
}

function priorityForAudioChoice(choice: string): string[] {
  return choice === AUDIO_ORIGINAL ? [AUDIO_ORIGINAL, "en"] : [choice, AUDIO_ORIGINAL];
}

type SkipMode = "off" | "prompt" | "auto";
const SKIP_MODE_OPTIONS: { value: SkipMode; label: string }[] = [
  { value: "off", label: "Off" },
  // The names Settings and the player's AuraSkip menu use for these values.
  { value: "prompt", label: "Prompt" },
  { value: "auto", label: "Auto" },
];

/** The step's live values: get_settings and the Aura settings, read on mount
 *  and again whenever either changes underneath (a cloud pull, an import, a
 *  sign-in swapping the settings scope). Latest read wins. */
function useLivePlaybackSettings() {
  const [backend, setBackend] = useState<PlaybackBackend | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [aura, setAura] = useState<AuraSettings>(() => loadAuraSettings());
  const genRef = useRef(0);

  const reload = useCallback(() => {
    const gen = ++genRef.current;
    setAura(loadAuraSettings());
    invoke<AppSettingsLike>("get_settings")
      .then((s) => {
        if (gen !== genRef.current) return;
        setBackend(readPlaybackBackend(s));
        setLoadFailed(false);
      })
      .catch(() => { if (gen === genRef.current) setLoadFailed(true); });
  }, []);

  useEffect(() => {
    reload();
    const events = ["aura:backend-settings-changed", "aura:settings-changed", "aura:session-changed"];
    for (const ev of events) window.addEventListener(ev, reload);
    return () => { for (const ev of events) window.removeEventListener(ev, reload); };
  }, [reload]);

  /** Write backend fields now. Shown optimistically; a failed write says so
   *  and re-reads the real values. */
  const patchBackend = useCallback((patch: Partial<PlaybackBackend>) => {
    setBackend((prev) => (prev ? { ...prev, ...patch } : prev));
    patchBackendSettings(patch).catch(() => {
      showAppToast("Couldn't save that setting. You can change it later in Settings.", { tone: "danger" });
      reload();
    });
  }, [reload]);

  const patchAura = useCallback(<K extends keyof AuraSettings>(key: K, value: AuraSettings[K]) => {
    saveAuraSettings({ ...loadAuraSettings(), [key]: value });
    setAura(loadAuraSettings());
  }, []);

  /** The HDR mode goes through hdrMode.ts (write plus player apply), and a
   *  pick here is a choice made by hand: no default or offer overrides it. */
  const setHdr = useCallback((mode: HdrMode) => {
    setBackend((prev) => (prev ? { ...prev, hdr_mode: mode } : prev));
    setHdrMode(mode, { byUser: true }).catch(() => {
      showAppToast("Couldn't save that setting. You can change it later in Settings.", { tone: "danger" });
      reload();
    });
  }, [reload]);

  return { backend, loadFailed, aura, patchBackend, patchAura, setHdr };
}

function PlaybackStep() {
  const { backend, loadFailed, aura, patchBackend, patchAura, setHdr } = useLivePlaybackSettings();

  if (!backend) {
    return (
      <MutedNote>
        {loadFailed
          ? "Couldn't read your settings. You can set these later in Settings."
          : "Loading your settings…"}
      </MutedNote>
    );
  }

  const audioChoice = audioChoiceFor(backend.audio_priority);
  const audioOptions = [
    { value: AUDIO_ORIGINAL, label: "Original language (recommended)" },
    ...LANGUAGE_OPTIONS.map((l) => ({ value: l.value, label: `${l.label} when available` })),
    ...(audioChoice === AUDIO_CUSTOM ? [{ value: AUDIO_CUSTOM, label: "Custom order (edit in Settings)" }] : []),
  ];
  // Off is a normal choice, as in Settings. A stored value the list does not
  // hold (a code typed into an older build, say) is shown as itself rather
  // than as the first option.
  const subtitleOptions = subtitleLanguageOptions(backend.subtitle_language);
  const skipModesDiffer = backend.skip_op_mode !== backend.skip_ed_mode;
  const skipValue = !skipModesDiffer && SKIP_MODE_OPTIONS.some((o) => o.value === backend.skip_op_mode)
    ? backend.skip_op_mode as SkipMode
    : null;

  return (
    <>
      <StepGroup label="Audio and subtitles">
        <SettingDropdown
          label="Audio"
          description="Original language plays each title in the language it was made in; anime falls back to Japanese. Works best with AIOMetadata."
          value={audioChoice}
          options={audioOptions}
          required
          onChange={(v) => {
            if (!v || v === AUDIO_CUSTOM || v === audioChoice) return;
            patchBackend({ audio_priority: priorityForAudioChoice(v) });
          }}
        />
        <Divider />
        <SettingToggle
          label="Avoid dubs"
          description="Prefers the original audio over tracks titled as dubs, even when a dub matches your language list."
          value={backend.avoid_dubs}
          onChange={(v) => patchBackend({ avoid_dubs: v })}
        />
        <Divider />
        <SettingDropdown
          label="Subtitle language"
          description="Loaded automatically when subtitles are available. Off starts titles with no subtitles, forced ones included, unless you picked a language for that title in the player. You can still turn them on from the player's Subtitles menu."
          value={backend.subtitle_language}
          options={subtitleOptions}
          required
          onChange={(v) => {
            if (v && v !== backend.subtitle_language) patchBackend({ subtitle_language: v });
          }}
        />
      </StepGroup>

      <StepGroup label="Video">
        {/* The peak brightness for Send HDR stays in Settings: it is a fix
            for a few OLED modes, not a first-run choice. */}
        <HdrModeSetting
          value={backend.hdr_mode}
          onChange={(mode) => { if (mode !== backend.hdr_mode) setHdr(mode); }}
          note={backend.hdr_mode === "passthrough"
            ? "The display's peak brightness for Send HDR can be set in Settings > Video & Audio."
            : undefined}
        />
      </StepGroup>

      <StepGroup label="Episodes">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-white/75 text-sm font-medium">Openings and endings</p>
              <p className="text-white/35 text-xs mt-0.5">
                Prompt shows a "Press X to skip" prompt. Auto skips by itself when Aura is
                sure of the timing, and still prompts when it is not. Applies to live action too.
              </p>
            </div>
            <SegmentedControl
              value={skipValue}
              options={SKIP_MODE_OPTIONS}
              ariaLabel="Openings and endings"
              onChange={(v) => {
                if (v === skipValue) return;
                patchBackend({ skip_op_mode: v, skip_ed_mode: v });
              }}
            />
          </div>
          {skipModesDiffer && (
            <MutedNote>
              Openings and endings are set separately in Settings. Pick one here to use it for both.
            </MutedNote>
          )}
        </div>
        <Divider />
        <SettingToggle
          label="Play the next episode automatically"
          description="Starts the next episode after a countdown on the end screen. Any mouse, key or scroll input cancels it."
          value={aura.autoAdvanceNextEpisode}
          onChange={(v) => patchAura("autoAdvanceNextEpisode", v)}
        />
      </StepGroup>

      <StepGroup label="Window">
        <SettingToggle
          label="Close button keeps Aura in the tray"
          description="Closing hides Aura to the tray instead of quitting. Click the tray icon to reopen it, or right-click it for Quit. Hold the close button for a second to quit anyway."
          value={backend.minimize_to_tray_on_close}
          onChange={(v) => patchBackend({ minimize_to_tray_on_close: v })}
        />
      </StepGroup>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step: recommended addons
// ---------------------------------------------------------------------------

type RecommendedAddonId = "aiometadata" | "aiostreams" | "cinemeta" | "opensubtitles";

interface RecommendedAddon {
  id: RecommendedAddonId;
  name: string;
  blurb: string;
  /** The addon's setup page, for an addon whose manifest URL is per user. */
  configureUrl?: string;
  /** A fixed manifest URL: one-click Install, nothing to configure. */
  fixedManifestUrl?: string;
  isInstalled: (addons: readonly AddonEntry[]) => boolean;
}

const CINEMETA_URL = "https://v3-cinemeta.strem.io/manifest.json";
const OPENSUBTITLES_URL = "https://opensubtitles-v3.strem.io/manifest.json";

const RECOMMENDED_ADDONS: RecommendedAddon[] = [
  {
    id: "aiometadata",
    name: "AIOMetadata",
    blurb: "Rich metadata from TMDB, TVDB, MyAnimeList, AniList and more. Lets Aura pick each title's original audio, skip filler and recaps, and scrobble split-season anime correctly. Also works when added inside AIOStreams.",
    configureUrl: "https://aiometadata.elfhosted.com/configure",
    isInstalled: (addons) => hasAIOMetadata(addons),
  },
  {
    id: "aiostreams",
    name: "AIOStreams",
    blurb: "Consolidates multiple stream sources into one configurable super-addon. Pair it with your debrid service.",
    configureUrl: "https://aiostreams.elfhosted.com/configure",
    isInstalled: (addons) => addons.some((a) =>
      a.manifest_id?.toLowerCase().includes("aiostreams")
      || a.url.toLowerCase().includes("aiostreams")
      || a.name.toLowerCase().includes("aiostreams")),
  },
  {
    id: "cinemeta",
    name: "Cinemeta",
    blurb: "Stremio's official catalogs and metadata for movies and series. A dependable fallback when other metadata addons are unreachable.",
    fixedManifestUrl: CINEMETA_URL,
    isInstalled: (addons) => addons.some((a) =>
      a.manifest_id === "com.linvo.cinemeta" || a.url === CINEMETA_URL),
  },
  {
    id: "opensubtitles",
    name: "OpenSubtitles v3",
    blurb: "Subtitles for movies and series in the player's subtitle menu, matched to the exact file when possible.",
    fixedManifestUrl: OPENSUBTITLES_URL,
    isInstalled: (addons) => addons.some((a) =>
      a.manifest_id === "org.stremio.opensubtitlesv3" || a.url === OPENSUBTITLES_URL),
  },
];

/** An install error, safe to show: a pasted manifest URL carries the user's
 *  config token or debrid key, and a fetch error can echo it back. */
function installErrorCopy(e: unknown): string {
  const text = String(e).replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "(addon URL hidden)");
  return `Install failed: ${text}`;
}

function AddonsStep({
  session, addons, addonListReady, onAccountChanged, isAddonListSynced, onInstalled,
}: {
  session: UserSession | null;
  addons: AddonEntry[];
  addonListReady: boolean;
  onAccountChanged?: () => Promise<boolean>;
  isAddonListSynced?: (authKey: string) => boolean;
  onInstalled: (id: RecommendedAddonId, entry: AddonEntry) => void;
}) {
  // Re-render when a wrapper's live manifest says it wraps AIOMetadata.
  useAddonHints(addons);
  const [pasteFor, setPasteFor] = useState<RecommendedAddonId | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [installing, setInstalling] = useState<RecommendedAddonId | null>(null);
  const [error, setError] = useState<{ id: RecommendedAddonId; message: string } | null>(null);

  const closePaste = useCallback(() => {
    setPasteFor(null);
    setPasteText("");
  }, []);

  // Esc closes the paste field, and only that: a capture listener with
  // stopPropagation (App's own Escape listener runs on window too), present
  // only while the field is open, yielding to an open context menu.
  useEffect(() => {
    if (!pasteFor) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector("[data-aura-context-menu]")) return;
      e.preventDefault();
      e.stopPropagation();
      closePaste();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pasteFor, closePaste]);

  const authKeyNow = session?.auth_key ?? null;
  const listLoading = !!authKeyNow && !addonListReady;

  // The cards hide every install press while the list loads, and a press was
  // what started another sync after a failed one (offline at launch, a VPN
  // still connecting). So ask once when the step shows the loading state
  // (it joins a sync already running), and offer a quiet Retry if it is
  // still loading a few seconds later. From an effect, never in render:
  // isAddonListSynced starts a sync.
  const [retryTick, setRetryTick] = useState(0);
  const [retryShown, setRetryShown] = useState(false);
  useEffect(() => {
    setRetryShown(false);
    if (!authKeyNow || addonListReady) return;
    isAddonListSynced?.(authKeyNow);
    const t = window.setTimeout(() => setRetryShown(true), 5000);
    return () => window.clearTimeout(t);
  }, [authKeyNow, addonListReady, isAddonListSynced, retryTick]);

  const install = useCallback(async (entry: RecommendedAddon, url: string) => {
    if (installing) return;
    const authKey = session?.auth_key;
    // Signed in, an install sends the list as shown as `expectedUrls`, which
    // guards nothing until that list has loaded from the account. Asked at
    // press time (never in render): a false answer also starts a sync.
    if (authKey && !isAddonListSynced?.(authKey)) {
      setError({ id: entry.id, message: ADDON_LIST_NOT_LOADED });
      return;
    }
    setInstalling(entry.id);
    setError(null);
    try {
      // A pasted stremio:// Install link is the https manifest url.
      const args: Record<string, unknown> = { url: normalizeManifestInput(url) };
      if (authKey) {
        args.authKey = authKey;
        // The list as shown: Rust refuses to push from a read that lacks any.
        args.expectedUrls = addons.map((a) => a.url);
      }
      const result = await invoke<AddonEntry>(authKey ? "cloud_add_addon" : "add_addon", args);
      onInstalled(entry.id, result);
      if (pasteFor === entry.id) closePaste();
    } catch (e) {
      // A cloud install refused because the account no longer holds the list
      // shown: App reloads it, and the message says whether it could.
      const message = String(e) === COLLECTION_CHANGED && onAccountChanged
        ? accountChangedCopy(await onAccountChanged(), "Try the install again.")
        : installErrorCopy(e);
      setError({ id: entry.id, message });
    } finally {
      setInstalling(null);
    }
  }, [installing, session, isAddonListSynced, addons, onInstalled, pasteFor, closePaste, onAccountChanged]);

  return (
    <>
      <MutedNote>You can reopen this list any time from Addons &gt; Suggested addons.</MutedNote>
      {listLoading && retryShown && (
        <div className="flex items-center gap-3">
          <MutedNote>Your addon list has not loaded from your account yet.</MutedNote>
          <button
            type="button"
            onClick={() => setRetryTick((n) => n + 1)}
            className={`flex-shrink-0 ${TEXT_BUTTON}`}
          >
            Retry
          </button>
        </div>
      )}
      <div className="space-y-2.5">
        {RECOMMENDED_ADDONS.map((entry) => (
          <AddonCard
            key={entry.id}
            entry={entry}
            installed={entry.isInstalled(addons)}
            loading={listLoading}
            guestNeedsIt={!session && entry.id === "cinemeta"}
            installing={installing === entry.id}
            busy={installing !== null}
            pasteOpen={pasteFor === entry.id}
            pasteText={pasteText}
            error={error?.id === entry.id ? error.message : null}
            onOpenPaste={() => { setPasteFor(entry.id); setPasteText(""); setError(null); }}
            onClosePaste={closePaste}
            onPasteTextChange={(v) => { setPasteText(v); if (error?.id === entry.id) setError(null); }}
            onInstall={(url) => void install(entry, url)}
          />
        ))}
      </div>
    </>
  );
}

function InstalledPill() {
  return (
    <span className="flex-shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full
                     text-[10px] font-semibold uppercase tracking-wider
                     bg-emerald-500/15 text-emerald-300 border border-emerald-400/30">
      <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
      Installed
    </span>
  );
}

function AddonCard({
  entry, installed, loading, guestNeedsIt, installing, busy, pasteOpen, pasteText, error,
  onOpenPaste, onClosePaste, onPasteTextChange, onInstall,
}: {
  entry: RecommendedAddon;
  installed: boolean;
  loading: boolean;
  guestNeedsIt: boolean;
  installing: boolean;
  busy: boolean;
  pasteOpen: boolean;
  pasteText: string;
  error: string | null;
  onOpenPaste: () => void;
  onClosePaste: () => void;
  onPasteTextChange: (v: string) => void;
  onInstall: (url: string) => void;
}) {
  const showActions = !loading && !installed;
  return (
    <div className="aura-content-panel rounded-xl p-3.5 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-white/85 text-sm font-medium leading-tight">
            {entry.name}
            {guestNeedsIt && !installed && !loading && (
              <span className="ml-2 text-amber-300/90 text-[11px] font-medium">Needed for catalogs</span>
            )}
          </p>
          <p className="text-white/45 text-xs mt-1 leading-snug">{entry.blurb}</p>
        </div>
        {loading ? (
          <span className="flex-shrink-0 text-white/40 text-[11px]">Loading your addons…</span>
        ) : installed ? (
          <InstalledPill />
        ) : null}
      </div>

      {showActions && (
        <div className="flex items-center gap-2">
          {entry.fixedManifestUrl ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => onInstall(entry.fixedManifestUrl!)}
              className={ROW_ACTION_ACCENT}
            >
              {installing ? "Installing…" : "Install"}
            </button>
          ) : (
            <>
              {entry.configureUrl && (
                <button
                  type="button"
                  onClick={() => openExternalUrl(entry.configureUrl!)}
                  className={ROW_ACTION_NEUTRAL}
                >
                  Configure ↗
                </button>
              )}
              {!pasteOpen && (
                <button type="button" onClick={onOpenPaste} className={ROW_ACTION_ACCENT}>
                  Paste manifest URL
                </button>
              )}
            </>
          )}
        </div>
      )}

      {showActions && pasteOpen && (
        <div className="space-y-2">
          <input
            type="text"
            autoFocus
            value={pasteText}
            onChange={(e) => onPasteTextChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && pasteText.trim() && !busy) {
                e.preventDefault();
                onInstall(pasteText.trim());
              }
            }}
            placeholder="https://…/manifest.json"
            aria-label={`${entry.name} manifest URL`}
            // OnboardingView's addons-only Escape yields while this is open.
            data-onboarding-paste=""
            spellCheck={false}
            autoComplete="off"
            className="aura-glass-field w-full rounded-xl px-4 py-2.5
                       text-sm font-mono placeholder:text-white/25 outline-none"
            style={{ color: "var(--text-primary)" }}
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={onClosePaste} className={ROW_ACTION_NEUTRAL}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!pasteText.trim() || busy}
              onClick={() => onInstall(pasteText.trim())}
              className={ROW_ACTION_ACCENT}
            >
              {installing ? "Installing…" : "Install"}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-rose-300/85 text-xs leading-relaxed">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step: tracking (scrobble sign-in)
// ---------------------------------------------------------------------------

function TrackingStep({
  session, services,
}: {
  session: UserSession | null;
  services: readonly ScrobbleService[];
}) {
  // ScrobbleAuthRow owns the whole sign-in (scope stash, browser loopback
  // with the in-app fallback, waiting timeout, revoke before reconnect). A
  // sign-in still pending at Finish completes through App's deep-link
  // handler after the wizard closes, so nothing here waits for it.
  const authKey = session?.auth_key ?? null;
  return (
    <>
      <StepGroup>
        {services.map((service, i) => (
          <div key={service} className="space-y-5">
            {i > 0 && <Divider />}
            <ScrobbleAuthRow
              service={service}
              authKey={authKey}
              description={SCROBBLE_ROW_DESCRIPTIONS[service]}
            />
          </div>
        ))}
      </StepGroup>
      <MutedNote>
        Aura marks a movie or episode as watched once you're 80% through and have watched at
        least 5 minutes.
      </MutedNote>
      {!session && (
        <MutedNote>
          Saved for Guest mode. If you sign in to Stremio later, connect again from
          Settings &gt; Scrobbling.
        </MutedNote>
      )}
    </>
  );
}
