// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openExternalUrl } from "../externalUrl";
import {
  loadOnboardingProgress,
  markOnboardingComplete,
  saveOnboardingProgress,
  type OnboardingProgress,
} from "../onboarding";
import {
  loadAuraSettings,
  saveAuraSettings,
} from "../auraSettings";
import { parseImportInput, type SettingsBlob } from "../settingsTransfer";
import type { UserSession } from "../LoginView";
import type { AddonEntry, ThemeId } from "../types";
import { THEME_LABELS, THEME_DESCRIPTIONS, useTheme } from "../ThemeEngine";

// ---------------------------------------------------------------------------
// OnboardingView — three-step first-run wizard.
//
// Mounted by App.tsx after LandingView dismisses, when `isOnboardingComplete()`
// is false. Persists progress to localStorage so a mid-wizard quit resumes at
// the same step (and the same partial choices) on next launch.
//
// Step 0 (Import) — paste an exported Aura settings string / file; skip
//                   to step 1 for manual setup.
// Step 1 (Setup)  — highest-impact non-addon-dependent questions: theme,
//                   anime audio/sub language preference, scrobble connect.
//                   Skippable per-question; rest stays at defaults and the
//                   user refines via Settings later.
// Step 2 (Addons) — recommended addon set with copy-paste install pattern.
//                   Reopenable from AddonsView's "Reopen onboarding
//                   addons" button (which dispatches the
//                   `aura:onboarding-reopen-addons` event).
// ---------------------------------------------------------------------------

interface Props {
  /** Active Stremio session (null = guest). Drives both the addon
   *  install path (cloud vs local) and the visibility of the Trakt /
   *  AniList scrobble connect step. */
  session: UserSession | null;
  /** Currently-installed addons. Used to mark recommended addons as
   *  already-installed on step 2 + to suppress duplicate adds. */
  addons: AddonEntry[];
  /** Called when an addon install completes successfully so App.tsx
   *  can refresh its addon list. */
  onAddonInstalled: (entry: AddonEntry) => void;
  /** Called when the wizard finishes (Finish or fully-skipped).
   *  Persists the completion flag and unmounts the wizard. */
  onComplete: () => void;
  /** Optional override — when true, the wizard jumps straight to
   *  step 2 (addons). Used by AddonsView's "Reopen onboarding addons"
   *  button so users can revisit just the addon list without
   *  re-running the import / setup steps. */
  startAtAddons?: boolean;
}

interface RecommendedAddon {
  name: string;
  blurb: string;
  /** Marketing / configure URL the user visits in their browser. */
  configureUrl: string;
  /** When non-null, the manifest URL is fixed (no per-user config)
   *  and we can offer a one-click install button. Cinemeta is the
   *  canonical example. */
  fixedManifestUrl?: string;
}

const RECOMMENDED_ADDONS: RecommendedAddon[] = [
  {
    name: "AIOMetadata",
    blurb: "Aggregated metadata from TMDB, TVDB, MyAnimeList, AniList, IMDb, TVmaze, and more. Powers Detail-page ratings, anime metadata, and the calendar.",
    configureUrl: "https://aiometadata.elfhosted.com/configure",
  },
  {
    name: "AIOStreams",
    blurb: "Consolidates multiple stream sources into one configurable super-addon. Pair with your Debrid service of choice.",
    configureUrl: "https://aiostreams.elfhosted.com/configure",
  },
  {
    name: "Cinemeta (fallback)",
    blurb: "Stremio's official catalog and metadata addon. Recommended as a fallback when other meta providers are unreachable.",
    configureUrl: "https://v3-cinemeta.strem.io",
    fixedManifestUrl: "https://v3-cinemeta.strem.io/manifest.json",
  },
  {
    name: "OpenSubtitles v3 PRO",
    blurb: "Subtitle search and download with PRO-tier access. Required for the in-player subtitle picker's hash-matching feature.",
    configureUrl: "https://opensubtitles-v3.strem.io/configure",
  },
];

export default function OnboardingView({
  session, addons, onAddonInstalled, onComplete, startAtAddons,
}: Props) {
  // Hydrate progress from localStorage on mount so a relaunch picks
  // up at the saved step. startAtAddons (from AddonsView's reopen
  // button) wins over the persisted cursor.
  const [progress, setProgress] = useState<OnboardingProgress>(() => {
    const loaded = loadOnboardingProgress();
    return startAtAddons ? { ...loaded, step: 2 } : loaded;
  });

  // Mirror persisted state on every change. Persistence is sync to
  // localStorage so an immediate app-quit (e.g. user closing the
  // window) reliably round-trips.
  useEffect(() => {
    saveOnboardingProgress(progress);
  }, [progress]);

  const setStep = useCallback((next: number) => {
    setProgress((p) => ({ ...p, step: Math.max(0, Math.min(2, next)) }));
  }, []);

  const skipStep = useCallback((kind: "import" | "settings") => {
    setProgress((p) => ({
      ...p,
      skipped: { ...p.skipped, [kind]: true },
      step: kind === "import" ? 1 : 2,
    }));
  }, []);

  const handleFinish = useCallback(() => {
    // markOnboardingComplete returns true only on the very FIRST
    // completion (not on reopen-addons flows). Use that signal to
    // fire a one-time scrobble-discovery notification — the in-wizard
    // "Track what you watch" section was removed because users
    // routinely skipped past it; surfacing the hint as a bell-badge
    // entry after onboarding finishes gets discovered more reliably.
    const wasFirstCompletion = markOnboardingComplete();
    if (wasFirstCompletion && session?.auth_key) {
      window.dispatchEvent(new CustomEvent("aura:notify-scrobble-onboarding"));
    }
    onComplete();
  }, [onComplete, session]);

  // Animated step transitions — fade + slight slide. Honors the
  // reduced-motion gate via the existing `data-reduced-motion`
  // attribute on <html> (managed by main.tsx + App.tsx). Tailwind's
  // transition utilities respect prefers-reduced-motion in
  // tailwind.config.ts when the user has it enabled.

  return (
    <div className="flex-1 relative flex items-center justify-center overflow-hidden">
      {/* Atmospheric backdrop — same Aura sweep used by LandingView so
          the transition into onboarding feels continuous. */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="aura-sweep" aria-hidden style={{ animationDuration: "60s", opacity: 0.5 }} />
        <div className="absolute inset-0"
             style={{ background: "radial-gradient(120% 80% at 50% 60%, transparent 30%, rgba(0,0,0,0.55) 95%)" }} />
      </div>

      <div
        className="relative z-10 w-full px-6 py-8 space-y-6"
        style={{ maxWidth: "min(640px, 92%)" }}
      >
        {/* Top bar — progress dots + skip-all on the right */}
        <div className="flex items-center justify-between">
          <StepDots step={progress.step} />
          <button
            type="button"
            onClick={handleFinish}
            className="text-white/45 hover:text-white/85 text-xs font-medium tracking-wide
                       transition-colors"
          >
            Skip all →
          </button>
        </div>

        {/* Step body */}
        <div className="glass-panel-elevated rounded-2xl p-6 space-y-5 shadow-glass-edge">
          {progress.step === 0 && (
            <ImportStep
              onImport={(blob) => {
                // Apply the blob's aura settings (additive merge),
                // then advance.
                const current = loadAuraSettings();
                const next = { ...current };
                if (blob.aura) {
                  for (const [k, v] of Object.entries(blob.aura)) {
                    // Whitelist guard handled by saveAuraSettings's
                    // readFromStorage parser on next load; we just
                    // patch the in-memory shape here.
                    (next as Record<string, unknown>)[k] = v;
                  }
                }
                saveAuraSettings(next);
                // Backend settings + provider lists from the blob are
                // ignored at this stage — we don't have a backend
                // settings handle and providers depend on installed
                // addons (which step 2 handles). Users can re-import
                // a full blob via Settings → Backup & Restore later
                // if they need backend-side preservation.
                setStep(1);
              }}
              onSkip={() => skipStep("import")}
            />
          )}
          {progress.step === 1 && (
            <SettingsStep
              draft={progress.settingsDraft ?? {}}
              onDraftChange={(draft) => setProgress((p) => ({ ...p, settingsDraft: draft }))}
              onBack={() => setStep(0)}
              onSkip={() => skipStep("settings")}
              onContinue={() => setStep(2)}
            />
          )}
          {progress.step === 2 && (
            <AddonsStep
              addons={addons}
              installedInThisSession={progress.installedAddons ?? []}
              session={session}
              onMarkInstalled={(url, entry) => {
                setProgress((p) => ({
                  ...p,
                  installedAddons: Array.from(new Set([...(p.installedAddons ?? []), url])),
                }));
                onAddonInstalled(entry);
              }}
              onBack={() => setStep(1)}
              onFinish={handleFinish}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepDots — visual progress indicator (3 dots, current step accent-tinted).
// ---------------------------------------------------------------------------

function StepDots({ step }: { step: number }) {
  return (
    <div className="flex items-center gap-2" aria-label={`Step ${step + 1} of 3`}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden
          className={`block h-1 rounded-full transition-all duration-300
                      ${i === step
                        ? "w-8 bg-ln-accent"
                        : i < step
                          ? "w-2 bg-ln-accent/60"
                          : "w-2 bg-white/20"
                      }`}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 0 — Import an existing Aura settings export
// ---------------------------------------------------------------------------

function ImportStep({
  onImport, onSkip,
}: {
  onImport: (blob: SettingsBlob) => void;
  onSkip: () => void;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleImport = () => {
    const blob = parseImportInput(text);
    if (!blob) {
      setError("Couldn't parse. Paste a valid export string or JSON.");
      return;
    }
    onImport(blob);
  };

  return (
    <>
      <header className="space-y-1">
        <p className="text-white/45 text-[10px] font-mono uppercase tracking-[0.22em]">
          Step 1 of 3
        </p>
        <h2 className="text-white text-xl font-light tracking-wide">Import existing settings?</h2>
        <p className="text-white/55 text-sm leading-relaxed">
          Already used Aura on another device? Paste your settings export string
          (or drag the JSON file in) to bring everything over. Skip to set up manually.
        </p>
      </header>

      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
        placeholder="Paste your Aura settings export string here…"
        spellCheck={false}
        rows={5}
        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3
                   text-xs font-mono placeholder:text-white/25 outline-none resize-none
                   focus:border-white/25 transition-colors text-white/85"
      />
      {error && <p className="text-rose-300/85 text-xs">{error}</p>}

      <footer className="flex items-center justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={onSkip}
          className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                     text-white/75 text-[12px] font-medium hover:bg-white/10
                     transition-colors"
        >
          Skip — set up manually
        </button>
        <button
          type="button"
          onClick={handleImport}
          disabled={!text.trim()}
          className="px-3 py-1.5 rounded-lg border border-ln-accent/45 bg-ln-accent/15
                     text-ln-accent text-[12px] font-semibold hover:bg-ln-accent/25
                     disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Import & continue →
        </button>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Headline settings (no-addon-dependent options only)
// ---------------------------------------------------------------------------

interface SettingsDraft {
  theme?: ThemeId;
  anime_audio_lang?: string;
  anime_sub_lang?: string;
  audio_lang?: string;
  sub_lang?: string;
}

const LANG_OPTIONS = [
  { code: "en", label: "English" },
  { code: "ja", label: "Japanese" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese" },
  { code: "pt", label: "Portuguese" },
  { code: "ru", label: "Russian" },
  { code: "it", label: "Italian" },
];

function SettingsStep({
  draft, onDraftChange, onBack, onSkip, onContinue,
}: {
  draft: Record<string, unknown>;
  onDraftChange: (next: Record<string, unknown>) => void;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  // Typed view onto the free-form draft bag.
  const typed = draft as SettingsDraft;
  const patch = (k: keyof SettingsDraft, v: unknown) => onDraftChange({ ...draft, [k]: v });
  // Live theme application — pick a theme and Aura swaps the live
  // ThemeEngine immediately so the user can preview before committing.
  // Persisted to backend on Continue (see commitToBackend).
  const { setTheme } = useTheme();
  const pickTheme = (t: ThemeId) => { setTheme(t); patch("theme", t); };

  const commitToBackend = async () => {
    // Anime language defaults + global defaults → backend AppSettings
    // via update_settings. Empty values leave the defaults intact.
    const patchBackend: Record<string, unknown> = {};
    if (typed.audio_lang)       patchBackend.audio_priority      = [typed.audio_lang];
    if (typed.sub_lang)         patchBackend.sub_priority        = [typed.sub_lang];
    if (typed.anime_audio_lang) patchBackend.audio_priority_anime = [typed.anime_audio_lang];
    if (typed.anime_sub_lang)   patchBackend.sub_priority_anime   = [typed.anime_sub_lang];
    if (Object.keys(patchBackend).length > 0) {
      try {
        await invoke("update_settings", { patch: patchBackend });
      } catch {
        // Non-fatal — user can refine in Settings later.
      }
    }
    // Theme rides on the same update — backend tracks the active
    // theme id so it survives across launches.
    if (typed.theme) {
      try {
        await invoke("set_theme", { theme: typed.theme });
      } catch {
        // Same fallback contract.
      }
    }
  };

  const handleContinue = async () => {
    await commitToBackend();
    onContinue();
  };

  const themes = useMemo(() => Object.keys(THEME_LABELS) as ThemeId[], []);

  return (
    <>
      <header className="space-y-1">
        <p className="text-white/45 text-[10px] font-mono uppercase tracking-[0.22em]">
          Step 2 of 3
        </p>
        <h2 className="text-white text-xl font-light tracking-wide">Pick your defaults</h2>
        <p className="text-white/55 text-sm leading-relaxed">
          A few high-impact preferences. Everything's adjustable later from Settings,
          and you can skip any question — defaults are sensible.
        </p>
      </header>

      <div className="space-y-4 max-h-[44vh] overflow-y-auto pr-2"
           style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.10) transparent" }}>

        {/* Theme picker */}
        <div className="space-y-2">
          <p className="text-white/75 text-sm font-medium">Theme</p>
          <p className="text-white/35 text-xs">
            Visual style. Cross-fades on switch; pick whichever looks right tonight.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {themes.map((t) => {
              const active = typed.theme === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => pickTheme(t)}
                  className={`px-3 py-2 rounded-lg text-[11.5px] font-medium tracking-wide
                              border transition-colors text-left
                              ${active
                                ? "bg-ln-accent/20 text-ln-accent border-ln-accent/40"
                                : "bg-white/5 text-white/70 border-white/10 hover:bg-white/10"
                              }`}
                  title={THEME_DESCRIPTIONS[t]}
                >
                  {THEME_LABELS[t]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="h-px bg-white/6" />

        {/* Anime language preference — the biggest sub-vs-dub UX question */}
        <div className="space-y-2">
          <p className="text-white/75 text-sm font-medium">Anime preferences</p>
          <p className="text-white/35 text-xs">
            Sub vs. dub. We'll auto-select the matching audio + subtitle tracks
            when an anime loads. Skip and Aura uses Japanese audio + English subs.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <LangPicker
              label="Audio language"
              value={typed.anime_audio_lang ?? "ja"}
              onChange={(v) => patch("anime_audio_lang", v)}
            />
            <LangPicker
              label="Subtitle language"
              value={typed.anime_sub_lang ?? "en"}
              onChange={(v) => patch("anime_sub_lang", v)}
            />
          </div>
        </div>

        <div className="h-px bg-white/6" />

        {/* Global language preference */}
        <div className="space-y-2">
          <p className="text-white/75 text-sm font-medium">Global language preference</p>
          <p className="text-white/35 text-xs">
            Audio + subtitle preference for non-anime content (movies, series).
            Skip and Aura uses English audio + no subtitles.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <LangPicker
              label="Audio language"
              value={typed.audio_lang ?? "en"}
              onChange={(v) => patch("audio_lang", v)}
            />
            <LangPicker
              label="Subtitle language"
              value={typed.sub_lang ?? "off"}
              onChange={(v) => patch("sub_lang", v)}
              includeOff
            />
          </div>
        </div>

        {/* Scrobble hint was previously surfaced as an in-wizard
            section ("Track what you watch") with a button that jumped
            to Settings. Replaced by a post-completion notification
            (see App.tsx's onboarding-finish listener) so first-run
            users discover scrobbling without it cluttering the
            settings step. */}
      </div>

      <footer className="flex items-center justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                     text-white/75 text-[12px] font-medium hover:bg-white/10
                     transition-colors"
        >
          ← Back
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                       text-white/75 text-[12px] font-medium hover:bg-white/10
                       transition-colors"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={handleContinue}
            className="px-3 py-1.5 rounded-lg border border-ln-accent/45 bg-ln-accent/15
                       text-ln-accent text-[12px] font-semibold hover:bg-ln-accent/25
                       transition-colors"
          >
            Continue →
          </button>
        </div>
      </footer>
    </>
  );
}

function LangPicker({
  label, value, onChange, includeOff,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  includeOff?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-white/55 text-[11px] uppercase font-mono tracking-wider">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2
                   text-[12.5px] outline-none focus:border-white/25
                   appearance-none cursor-pointer transition-colors"
        style={{
          color: "var(--text-primary)",
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='rgba(255,255,255,0.3)'%3E%3Cpath d='M7 10l5 5 5-5z'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 10px center",
          paddingRight: "28px",
        }}
      >
        {includeOff && <option value="off">Off</option>}
        {LANG_OPTIONS.map((l) => (
          <option key={l.code} value={l.code}>{l.label}</option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Recommended addons
// ---------------------------------------------------------------------------

function AddonsStep({
  addons, installedInThisSession, session, onMarkInstalled, onBack, onFinish,
}: {
  addons: AddonEntry[];
  installedInThisSession: string[];
  session: UserSession | null;
  onMarkInstalled: (url: string, entry: AddonEntry) => void;
  onBack: () => void;
  onFinish: () => void;
}) {
  const [pasteFor, setPasteFor] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  const handleQuickInstall = useCallback(async (entry: RecommendedAddon) => {
    if (!entry.fixedManifestUrl) return;
    setInstalling(true);
    setError(null);
    try {
      const cmd = session?.auth_key ? "cloud_add_addon" : "add_addon";
      const args: Record<string, unknown> = { url: entry.fixedManifestUrl };
      if (session?.auth_key) args.authKey = session.auth_key;
      const result = await invoke<AddonEntry>(cmd, args);
      onMarkInstalled(entry.fixedManifestUrl, result);
    } catch (e) {
      setError(`Install failed: ${String(e)}`);
    } finally {
      setInstalling(false);
    }
  }, [session, onMarkInstalled]);

  const handlePasteInstall = useCallback(async () => {
    if (!pasteFor || !pasteText.trim() || installing) return;
    setInstalling(true);
    setError(null);
    try {
      const cmd = session?.auth_key ? "cloud_add_addon" : "add_addon";
      const args: Record<string, unknown> = { url: pasteText.trim() };
      if (session?.auth_key) args.authKey = session.auth_key;
      const result = await invoke<AddonEntry>(cmd, args);
      onMarkInstalled(pasteText.trim(), result);
      setPasteFor(null);
      setPasteText("");
    } catch (e) {
      setError(`Install failed: ${String(e)}`);
    } finally {
      setInstalling(false);
    }
  }, [pasteFor, pasteText, session, installing, onMarkInstalled]);

  return (
    <>
      <header className="space-y-1">
        <p className="text-white/45 text-[10px] font-mono uppercase tracking-[0.22em]">
          Step 3 of 3
        </p>
        <h2 className="text-white text-xl font-light tracking-wide">Recommended addons</h2>
        <p className="text-white/55 text-sm leading-relaxed">
          A starter set that pairs well with Aura. Click "Configure" on any card to
          open the addon's setup page in your browser, then paste the resulting
          manifest URL back here to install.
        </p>
        <p className="text-white/40 text-[11.5px] italic">
          You can reopen this page anytime from Addons → "Reopen onboarding addons".
        </p>
      </header>

      <div className="space-y-2 max-h-[44vh] overflow-y-auto pr-2"
           style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.10) transparent" }}>
        {RECOMMENDED_ADDONS.map((entry) => {
          // Match by fixedManifestUrl OR by name-fuzzy against installed
          // names so a user who's previously installed an AIOMetadata
          // instance (with their own host) is recognised as having that
          // entry covered.
          const fixedAlready = entry.fixedManifestUrl
            && (addons.some((a) => a.url === entry.fixedManifestUrl)
                || installedInThisSession.includes(entry.fixedManifestUrl));
          const nameSlug = entry.name.toLowerCase().split(/\W+/)[0];
          const nameAlready = nameSlug && addons.some((a) =>
            a.name.toLowerCase().includes(nameSlug));
          const installed = fixedAlready || nameAlready;
          return (
            <div
              key={entry.name}
              className="rounded-lg border border-white/8 bg-white/3 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-white/85 text-sm font-medium leading-tight">{entry.name}</p>
                  <p className="text-white/45 text-xs mt-1 leading-snug">{entry.blurb}</p>
                </div>
                {installed && (
                  <span className="flex-shrink-0 px-1.5 py-0.5 rounded text-[9px] font-mono
                                   font-semibold uppercase tracking-wider
                                   bg-emerald-500/15 text-emerald-300/95
                                   border border-emerald-400/30">
                    Installed
                  </span>
                )}
              </div>
              {!installed && (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openExternalUrl(entry.configureUrl)}
                    className="px-2.5 py-1 rounded-md text-[11px] font-medium
                               bg-white/5 text-white/75 border border-white/10
                               hover:bg-white/10 transition-colors"
                  >
                    Configure ↗
                  </button>
                  {entry.fixedManifestUrl ? (
                    <button
                      type="button"
                      onClick={() => handleQuickInstall(entry)}
                      disabled={installing}
                      className="px-2.5 py-1 rounded-md text-[11px] font-medium
                                 bg-ln-accent/15 text-ln-accent border border-ln-accent/35
                                 hover:bg-ln-accent/25 transition-colors
                                 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      Install
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setPasteFor(entry.name); setPasteText(""); setError(null); }}
                      className="px-2.5 py-1 rounded-md text-[11px] font-medium
                                 bg-ln-accent/15 text-ln-accent border border-ln-accent/35
                                 hover:bg-ln-accent/25 transition-colors"
                    >
                      I have my manifest URL →
                    </button>
                  )}
                </div>
              )}
              {pasteFor === entry.name && !installed && (
                <div className="space-y-1.5 pt-1">
                  <input
                    type="text"
                    value={pasteText}
                    onChange={(e) => { setPasteText(e.target.value); if (error) setError(null); }}
                    placeholder="https://…/manifest.json"
                    spellCheck={false}
                    autoComplete="off"
                    className="w-full bg-white/5 border border-white/10 rounded-md px-2.5 py-1.5
                               text-xs font-mono placeholder:text-white/25 outline-none
                               focus:border-white/25 transition-colors text-white/85"
                  />
                  <div className="flex items-center gap-1.5 justify-end">
                    <button
                      type="button"
                      onClick={() => { setPasteFor(null); setPasteText(""); }}
                      className="px-2 py-1 rounded text-[10.5px] text-white/65
                                 hover:text-white transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handlePasteInstall}
                      disabled={!pasteText.trim() || installing}
                      className="px-2 py-1 rounded text-[10.5px] font-semibold
                                 bg-ln-accent/15 text-ln-accent border border-ln-accent/35
                                 hover:bg-ln-accent/25 disabled:opacity-40 disabled:cursor-not-allowed
                                 transition-colors"
                    >
                      {installing ? "Installing…" : "Install"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {error && <p className="text-rose-300/85 text-xs">{error}</p>}
      </div>

      <footer className="flex items-center justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="px-3 py-1.5 rounded-lg border border-white/15 bg-white/5
                     text-white/75 text-[12px] font-medium hover:bg-white/10
                     transition-colors"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onFinish}
          className="px-3 py-1.5 rounded-lg border border-ln-accent/45 bg-ln-accent/15
                     text-ln-accent text-[12px] font-semibold hover:bg-ln-accent/25
                     transition-colors"
        >
          Finish
        </button>
      </footer>
    </>
  );
}
