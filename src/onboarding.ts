// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// First-run setup state (the OnboardingView wizard).
//
// Two localStorage keys:
//   - `aura:onboarding-completed-v1` ("true" once the wizard was finished or
//     skipped). It gates the wizard on launch, so it must NEVER be renamed: a
//     new name would show the wizard again to every existing user. Survives
//     sign-in and sign-out.
//   - `aura:onboarding-progress-v2`: which step a first run is on and which
//     recommended addons it installed, so a quit mid-wizard resumes there.
//     Holds no settings: every choice in the wizard is applied the moment it
//     is made. Removed on completion.
//
// The wizard opens in one of three modes (App.tsx picks it):
//   - "first-run": after Landing on an install that never completed it.
//   - "addons-only": Addons > Suggested addons (`requestReopenAddons`), just
//     the addon list, nothing persisted.
//   - "rerun": Settings > Backup & Restore > Run setup again
//     (`requestRerunOnboarding`), every step again over the live settings.
// ---------------------------------------------------------------------------

const COMPLETED_KEY = "aura:onboarding-completed-v1";
const PROGRESS_KEY = "aura:onboarding-progress-v2";
/** The old progress key (a bare step index plus a settings draft). Read once
 *  to migrate, then removed. */
const LEGACY_PROGRESS_KEY = "aura:onboarding-progress-v1";

export type OnboardingMode = "first-run" | "addons-only" | "rerun";

/** Every step the wizard can show, in order. The wizard filters this list
 *  (the tracking step needs a scrobble service this build can use), and the
 *  stepper, "Step n of N" and navigation all derive from the filtered list. */
export const ONBOARDING_STEP_IDS = ["welcome", "look", "playback", "addons", "tracking"] as const;
export type OnboardingStepId = typeof ONBOARDING_STEP_IDS[number];

function isStepId(value: unknown): value is OnboardingStepId {
  return typeof value === "string" && (ONBOARDING_STEP_IDS as readonly string[]).includes(value);
}

export interface OnboardingProgress {
  v: 2;
  stepId: OnboardingStepId;
  /** Recommended-addon entry ids installed from the wizard (for example
   *  "cinemeta"). Never URLs: a configured manifest URL carries the user's
   *  config token or debrid key. */
  installed: string[];
}

function defaultProgress(): OnboardingProgress {
  return { v: 2, stepId: ONBOARDING_STEP_IDS[0], installed: [] };
}

/** True once the wizard was finished or skipped on this install. Absent (or
 *  unreadable storage) reads as not completed. */
export function isOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(COMPLETED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Set the completion flag and drop saved progress. Returns true only when
 *  this call is the FIRST completion (the flag was not set before), false on
 *  a re-run or a reopen. Callers gate first-run-only side effects on it, like
 *  the scrobble notice. */
export function markOnboardingComplete(): boolean {
  try {
    const wasAlreadyComplete = localStorage.getItem(COMPLETED_KEY) === "true";
    localStorage.setItem(COMPLETED_KEY, "true");
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(LEGACY_PROGRESS_KEY);
    return !wasAlreadyComplete;
  } catch {
    // Storage unavailable: the wizard shows again next launch, which is an
    // acceptable degradation. Count it as a first completion so the notice
    // still fires.
    return true;
  }
}

/** Map an old v1 progress record to v2: step 0 (import) and 1 (settings)
 *  and 2 (addons) land on the step that now holds that content. The old
 *  installed list held URLs and is dropped. */
function migrateLegacy(raw: string): OnboardingProgress {
  const fallback = defaultProgress();
  try {
    const parsed = JSON.parse(raw) as { step?: unknown };
    const byIndex: Record<number, OnboardingStepId> = { 0: "welcome", 1: "look", 2: "addons" };
    const stepId = typeof parsed.step === "number" ? byIndex[parsed.step] : undefined;
    return { ...fallback, stepId: stepId ?? fallback.stepId };
  } catch {
    return fallback;
  }
}

/** The saved progress, or the first step when nothing (or nothing valid) is
 *  stored. Migrates a v1 record once: writes v2 and removes v1. */
export function loadOnboardingProgress(): OnboardingProgress {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) {
      const legacy = localStorage.getItem(LEGACY_PROGRESS_KEY);
      if (!legacy) return defaultProgress();
      const migrated = migrateLegacy(legacy);
      saveOnboardingProgress(migrated);
      localStorage.removeItem(LEGACY_PROGRESS_KEY);
      return migrated;
    }
    const parsed = JSON.parse(raw) as Partial<Record<keyof OnboardingProgress, unknown>>;
    return {
      v: 2,
      stepId: isStepId(parsed.stepId) ? parsed.stepId : ONBOARDING_STEP_IDS[0],
      installed: Array.isArray(parsed.installed)
        ? parsed.installed.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return defaultProgress();
  }
}

/** Persist the wizard's progress. Synchronous, so a quit right after a step
 *  change still round-trips. */
export function saveOnboardingProgress(progress: OnboardingProgress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // See markOnboardingComplete for the degradation contract.
  }
}

/** Drop saved progress without touching the completion flag. */
export function clearOnboardingProgress(): void {
  try {
    localStorage.removeItem(PROGRESS_KEY);
    localStorage.removeItem(LEGACY_PROGRESS_KEY);
  } catch {
    // ignore
  }
}

/** Show just the recommended-addons list again (Addons > Suggested addons).
 *  App.tsx listens and opens the wizard in "addons-only" mode. */
export function requestReopenAddons(): void {
  window.dispatchEvent(new CustomEvent("aura:onboarding-reopen-addons"));
}

/** Run the whole setup again (Settings > Backup & Restore > Run setup
 *  again). Clears any saved step progress so it starts at the first step,
 *  leaves the completed flag set (so finishing it again is not a first
 *  completion), and asks App.tsx to show the wizard in "rerun" mode.
 *  Nothing is reset: every step reads the live settings. */
export function requestRerunOnboarding(): void {
  clearOnboardingProgress();
  window.dispatchEvent(new CustomEvent("aura:onboarding-rerun"));
}
