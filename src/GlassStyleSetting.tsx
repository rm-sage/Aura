// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// The "Material style" and "Cursor glow" rows, shared by Settings (Theme
// section) and the first-run wizard's Look step so the two cannot drift apart.
// The values live in AuraSettings (glassStyle, glassCursorGlow): portable and
// cloud-synced. What is drawn is decided in src/glassStyle.ts (Liquid falls back
// to Frosted while hardware acceleration is off). The stored value "frosted" is
// SHOWN as "Matte" and "liquid" as "Clear" (formerly "Translucent" and
// "Glass"; never show "Frosted"); the ids never change (settings, sync and CSS
// key on them). The search keywords keep every old name (Glass style,
// Translucent, Frosted, Liquid, Glass) so it still finds the rows.
//
// Under Cursor glow (round 11), only where the caller passes `onGlowTune`
// (Settings; the wizard stays simple), greyed out (never unmounted: an
// unmounted row cannot be found by Settings search) while it is off: three
// sliders, Edge highlights, Surface glow and Glow size, plus Reset. The value
// is AuraSettings.glassGlowTune (portable and synced like glassCursorGlow).
// A drag PREVIEWS through glassGlint.ts previewGlassGlow (root custom
// properties, at most once per frame, no React re-render per pointer move);
// release, a key up or blur COMMITS (one save, one sync push).

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_GLASS_GLOW_TUNE,
  GLASS_GLOW_LIMITS,
  type AuraSettings,
  type GlassGlowTune,
} from "./auraSettings";
import { useGlassState } from "./glassStyle";
import { previewGlassGlow } from "./glassGlint";
import { AdvancedTag, AttachedSettings, SegmentedControl, SettingToggle } from "./settingsControls";

const GLASS_OPTIONS: { value: AuraSettings["glassStyle"]; label: string }[] = [
  { value: "frosted", label: "Matte" },
  { value: "liquid", label: "Clear" },
];

export const MATERIAL_STYLE_LABEL = "Material style";
export const MATERIAL_STYLE_DESCRIPTION =
  "How menus, panels, pills and controls look. Both are glass. "
  + "Matte blurs what is behind it under a dark tint. "
  + "Clear stays see-through and bends the light at its edges, and needs hardware acceleration.";
export const CURSOR_GLOW_LABEL = "Cursor glow";
export const CURSOR_GLOW_DESCRIPTION =
  "Glass near the pointer catches a sharp glint along the edge facing it, like light on real glass, with only a faint glow inside. "
  + "Works on both materials, Matte and Clear. Never shown on the High Contrast themes.";

export const GLOW_EDGE_LABEL = "Edge highlights";
export const GLOW_EDGE_DESCRIPTION =
  "How bright the thin line of light along the edge of glass gets near the pointer.";
export const GLOW_SURFACE_LABEL = "Surface glow";
export const GLOW_SURFACE_DESCRIPTION =
  "How much the pointer lights up the glass itself, and the page titles near it.";
export const GLOW_SIZE_LABEL = "Glow size";
export const GLOW_SIZE_DESCRIPTION =
  "How far the light reaches from the pointer.";

const sameTune = (a: GlassGlowTune, b: GlassGlowTune) =>
  a.edge === b.edge && a.surface === b.surface && a.size === b.size;

function GlowSlider({
  label, description, value, min, max, step, format, onInput, onCommit,
}: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onInput: (v: number) => void;
  onCommit: () => void;
}) {
  const frac = Math.max(0, Math.min(1, (value - min) / Math.max(1e-9, max - min)));
  return (
    <div
      className="space-y-1.5"
      data-settings-row=""
      data-settings-label={label}
      data-settings-description={`${description} Cursor glow, light, highlight, rim.`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-white/75 text-sm font-medium">{label}</p>
        <span className="text-white/65 text-[12px] font-mono tabular-nums">{format(value)}</span>
      </div>
      <p className="text-white/35 text-xs -mt-0.5">{description}</p>
      <input
        type="range"
        aria-label={label}
        aria-valuetext={format(value)}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onInput(Number(e.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        className="aura-slider w-full"
        style={{
          ["--val" as never]: `${(frac * 100).toFixed(2)}%`,
          ["--val-frac" as never]: frac.toFixed(3),
        }}
      />
    </div>
  );
}

/** Edge highlights, Surface glow, Glow size and Reset (see the header). */
function GlowTuneRows({ tune, onTune, disabled = false }: {
  tune: GlassGlowTune;
  onTune: (t: GlassGlowTune) => void;
  /** Cursor glow is off: shown greyed out so Settings search still finds the rows. */
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(tune);
  const draftRef = useRef(tune);
  // A stored change from anywhere else (an import, a cloud pull) wins. Keyed
  // on the VALUES: Settings rebuilds its settings object on any outside
  // settings event, and an identity key would drop a drag's draft mid-drag
  // (the commit then saw nothing to save and the preview stuck on <html>).
  // A real outside change also cancels any pending preview.
  useEffect(() => {
    if (!sameTune(draftRef.current, tune)) previewGlassGlow(null);
    draftRef.current = tune;
    setDraft(tune);
  }, [tune.edge, tune.surface, tune.size]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving with an uncommitted preview puts the stored tune back.
  const tuneRef = useRef(tune);
  tuneRef.current = tune;
  useEffect(() => () => {
    if (!sameTune(draftRef.current, tuneRef.current)) previewGlassGlow(null);
  }, []);
  const input = (k: keyof GlassGlowTune) => (v: number) => {
    const next = { ...draftRef.current, [k]: v };
    draftRef.current = next;
    setDraft(next);
    previewGlassGlow(next);
  };
  const commit = () => {
    if (!sameTune(draftRef.current, tuneRef.current)) onTune(draftRef.current);
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const isDefault = sameTune(draft, DEFAULT_GLASS_GLOW_TUNE);
  return (
    <fieldset disabled={disabled} className={`min-w-0 ${disabled ? "opacity-40" : ""}`}>
    <AttachedSettings>
      <GlowSlider
        label={GLOW_EDGE_LABEL}
        description={GLOW_EDGE_DESCRIPTION}
        value={draft.edge}
        min={GLASS_GLOW_LIMITS.edge[0]}
        max={GLASS_GLOW_LIMITS.edge[1]}
        step={0.05}
        format={pct}
        onInput={input("edge")}
        onCommit={commit}
      />
      <GlowSlider
        label={GLOW_SURFACE_LABEL}
        description={GLOW_SURFACE_DESCRIPTION}
        value={draft.surface}
        min={GLASS_GLOW_LIMITS.surface[0]}
        max={GLASS_GLOW_LIMITS.surface[1]}
        step={0.05}
        format={pct}
        onInput={input("surface")}
        onCommit={commit}
      />
      <GlowSlider
        label={GLOW_SIZE_LABEL}
        description={GLOW_SIZE_DESCRIPTION}
        value={draft.size}
        min={GLASS_GLOW_LIMITS.size[0]}
        max={GLASS_GLOW_LIMITS.size[1]}
        step={10}
        format={(v) => `${v} px`}
        onInput={input("size")}
        onCommit={commit}
      />
      <div className="flex justify-end">
        <button
          type="button"
          disabled={disabled || isDefault}
          onClick={() => {
            const d = { ...DEFAULT_GLASS_GLOW_TUNE };
            draftRef.current = d;
            setDraft(d);
            previewGlassGlow(d);
            onTune(d);
          }}
          className="aura-glass-flat px-3 py-1 rounded-full text-xs text-white/80 disabled:opacity-40 disabled:cursor-default"
        >
          Reset
        </button>
      </div>
    </AttachedSettings>
    </fieldset>
  );
}

export function GlassStyleRows({
  glassStyle, cursorGlow, onGlassStyle, onCursorGlow, glowTune, onGlowTune,
}: {
  glassStyle: AuraSettings["glassStyle"];
  cursorGlow: boolean;
  onGlassStyle: (v: AuraSettings["glassStyle"]) => void;
  onCursorGlow: (v: boolean) => void;
  /** The Cursor glow tuning; its rows show only with both props, greyed out while the glow is off. */
  glowTune?: GlassGlowTune;
  onGlowTune?: (t: GlassGlowTune) => void;
}) {
  const glass = useGlassState();
  const fallback = glassStyle === "liquid" && glass.gpuOff;
  return (
    <>
      <div
        className="flex items-start justify-between gap-4"
        data-settings-row=""
        data-settings-label={MATERIAL_STYLE_LABEL}
        data-settings-description={`${MATERIAL_STYLE_DESCRIPTION} Glass style, Material, Matte, Clear, Translucent, Frosted, Liquid, Glass, refraction.`}
      >
        <div className="flex-1 min-w-0">
          <p className="text-white/75 text-sm font-medium">{MATERIAL_STYLE_LABEL}<AdvancedTag /></p>
          <p className="text-white/35 text-xs mt-0.5">{MATERIAL_STYLE_DESCRIPTION}</p>
          {fallback && (
            <p className="text-amber-300/80 text-xs mt-1.5">
              Hardware acceleration is off, so Clear shows as Matte. Turn it back on under
              Performance (shown with Show advanced settings) and restart Aura to see Clear.
            </p>
          )}
        </div>
        <SegmentedControl
          ariaLabel={MATERIAL_STYLE_LABEL}
          value={glassStyle}
          options={GLASS_OPTIONS}
          onChange={onGlassStyle}
        />
      </div>
      <SettingToggle
        label={CURSOR_GLOW_LABEL}
        description={CURSOR_GLOW_DESCRIPTION}
        value={cursorGlow}
        onChange={onCursorGlow}
      />
      {glowTune && onGlowTune && <GlowTuneRows tune={glowTune} onTune={onGlowTune} disabled={!cursorGlow} />}
    </>
  );
}
