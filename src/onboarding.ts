// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// First-run onboarding state — fires after the user makes their first
// Sign In / Continue as Guest choice on LandingView. Runs ONLY on true
// fresh installs (uninstall/reinstall); updates preserve the
// "completed" flag and skip the wizard entirely.
//
// Two localStorage keys split the state:
//   • `aura:onboarding-completed-v1` (boolean-ish): set when the user
//     either finishes the wizard or skips out entirely. Survives auth
//     churn (logout/login). Absent on a fresh install.
//   • `aura:onboarding-progress-v1` (object): per-step state preserved
//     during the wizard so an app-quit mid-onboarding resumes at the
//     same step on next launch. Deleted on completion.
//
// "Reopen onboarding addons" in AddonsView routes through
// `requestReopenAddons()` so the user can revisit just page 3 without
// re-running the whole wizard.
// ---------------------------------------------------------------------------

const COMPLETED_KEY = "aura:onboarding-completed-v1";
const PROGRESS_KEY  = "aura:onboarding-progress-v1";

export interface OnboardingProgress {
  /** 0 = import, 1 = settings, 2 = addons. */
  step: number;
  /** Per-step skip flags so a relaunch knows the user already opted
   *  out of importing / settings setup and lands on the next step. */
  skipped?: { import?: boolean; settings?: boolean };
  /** Partial state from step 2 so a mid-page exit preserves choices.
   *  Free-form bag — each question writes its own key. */
  settingsDraft?: Record<string, unknown>;
  /** Which suggested addons have been installed in this session. URL
   *  list so a relaunch's step-3 view knows what to mark as "done"
   *  vs "available". */
  installedAddons?: string[];
}

const DEFAULT_PROGRESS: OnboardingProgress = {
  step: 0,
  skipped: {},
  settingsDraft: {},
  installedAddons: [],
};

/** True if the wizard has been completed (or fully skipped) on this
 *  install. Reads localStorage; treats absent as not-completed. */
export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persist the completion flag and drop any per-step progress state.
 *  Idempotent — calling on an already-completed install is a no-op. */
export function markOnboardingComplete(): void {
  try {
    localStorage.setItem(COMPLETED_KEY, "true");
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    // localStorage unavailable (private browsing mode / quota error /
    // etc.) — the wizard will re-fire on next launch. Acceptable
    // degradation; the user clicks through it again.
  }
}

/** Read the persisted per-step progress. Returns the default shape
 *  when nothing's stored or the stored value is malformed. */
export function loadOnboardingProgress(): OnboardingProgress {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { ...DEFAULT_PROGRESS };
    const parsed = JSON.parse(raw) as Partial<OnboardingProgress>;
    return {
      step: typeof parsed.step === "number" && parsed.step >= 0 && parsed.step <= 2
        ? parsed.step : 0,
      skipped: parsed.skipped && typeof parsed.skipped === "object"
        ? { import: !!parsed.skipped.import, settings: !!parsed.skipped.settings }
        : {},
      settingsDraft: parsed.settingsDraft && typeof parsed.settingsDraft === "object"
        ? { ...parsed.settingsDraft }
        : {},
      installedAddons: Array.isArray(parsed.installedAddons)
        ? parsed.installedAddons.filter((u): u is string => typeof u === "string")
        : [],
    };
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}

/** Persist the wizard's per-step progress. Called on every navigation
 *  and on every partial-state mutation so a mid-page app-quit doesn't
 *  lose the user's in-progress choices. */
export function saveOnboardingProgress(progress: OnboardingProgress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // See markOnboardingComplete for the degradation contract.
  }
}

/** Reset progress without flipping the completed flag — used when the
 *  user opens the "Reopen onboarding addons" button so step 3 starts
 *  fresh without re-running steps 0 and 1. */
export function clearOnboardingProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    // ignore
  }
}

/** Dispatch a request to reopen the addons step of the wizard from
 *  anywhere (typically the AddonsView "Reopen onboarding addons"
 *  button). App.tsx subscribes and remounts the OnboardingView at
 *  step 2. */
export function requestReopenAddons(): void {
  window.dispatchEvent(new CustomEvent("aura:onboarding-reopen-addons"));
}
