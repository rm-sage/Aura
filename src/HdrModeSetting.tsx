// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The "HDR mode" row, shared by Settings > Video & Audio and the setup
// wizard's Playback step so the two cannot drift apart.
//
// The recommendation is a tag, not label text: a Recommended chip in the
// upscaler menu's look (PlayerMenuChip tone "good") on one option, which a
// native <select> cannot draw, hence the radio rows (ChoiceList). What it
// stems from is shown beside it in the same chip style: what Windows reports
// for the display the window is on (get_display_hdr_info), read on mount and
// whenever the window regains focus (the user may have just flipped "Use HDR"
// in Windows Settings). Never polled.
//
// "Off" is listed only while it is the saved value (the startup migration in
// hdrMode.ts moves it to Convert, so it should be unreachable): nobody new
// can pick it.
// ---------------------------------------------------------------------------

import { useEffect, useId, useState } from "react";
import { ChoiceList, AdvancedTag, type ChoiceOption } from "./settingsControls";
import { PlayerMenuChip } from "./playerMenu";
import {
  probeDisplayHdr,
  recommendedHdrMode,
  type DisplayHdrInfo,
  type HdrMode,
} from "./hdrMode";

/** The window's display, as Windows reports it. Null until the first
 *  answer. Re-read on window focus. */
export function useDisplayHdrInfo(): DisplayHdrInfo | null {
  const [info, setInfo] = useState<DisplayHdrInfo | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => {
      void probeDisplayHdr().then((r) => { if (alive) setInfo(r); });
    };
    read();
    window.addEventListener("focus", read);
    return () => { alive = false; window.removeEventListener("focus", read); };
  }, []);
  return info;
}

const CHIP_SOURCE_TITLE = "What Windows reports for the display Aura is on";

/** The display check, as chips. A good tone only where the display is ready
 *  for Send HDR (supported AND on: the reason the tag sits on it), neutral
 *  otherwise, so no green chip points at Send HDR while the Recommended tag
 *  sits on Convert. */
function DisplayChips({ info }: { info: DisplayHdrInfo | null }) {
  if (info == null) return null;
  const chips: { text: string; good: boolean }[] = !info.detected
    ? [{ text: "HDR status unknown", good: false }]
    : !info.supported
      ? [{ text: "No HDR support", good: false }]
      : [
          { text: "HDR display", good: info.enabled },
          info.enabled
            ? { text: "HDR on in Windows", good: true }
            : { text: "HDR off in Windows", good: false },
        ];
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <span className="text-white/40 text-xs">This display</span>
      {chips.map((c) => (
        <PlayerMenuChip key={c.text} tone={c.good ? "good" : "neutral"} title={CHIP_SOURCE_TITLE}>
          {c.text}
        </PlayerMenuChip>
      ))}
    </div>
  );
}

const BASE_DESCRIPTION =
  "HDR videos carry more brightness and colour than a normal screen can show. "
  + "Convert (tone-mapping) adjusts them to look right on any screen; Send HDR (passthrough) "
  + "passes them to an HDR display for brighter highlights and richer colour. "
  + "Normal (SDR) videos look the same either way.";

/** At most one short sentence of guidance for what the display check found. */
function guidanceFor(info: DisplayHdrInfo | null, value: HdrMode): string {
  if (value === "off") return "Off shows HDR videos without converting them, so bright areas clip to flat white.";
  if (!info || !info.detected) return "";
  if (info.supported && !info.enabled) {
    return value === "passthrough"
      ? "Send HDR needs HDR on in Windows (Settings > System > Display > Use HDR), or HDR videos look washed out."
      : "To use Send HDR, turn on HDR in Windows (Settings > System > Display > Use HDR).";
  }
  if (!info.supported && value === "passthrough") {
    return "This display cannot show HDR, so HDR videos look washed out with Send HDR.";
  }
  return "";
}

export default function HdrModeSetting({
  value, onChange, note,
}: {
  value: HdrMode;
  onChange: (mode: HdrMode) => void;
  /** A muted line under the choices (the wizard's pointer to Settings). */
  note?: string;
}) {
  const info = useDisplayHdrInfo();
  const recommended = recommendedHdrMode(info);
  const descId = useId();
  const description = [BASE_DESCRIPTION, guidanceFor(info, value)].filter(Boolean).join(" ");

  const recTag = (mode: HdrMode) =>
    recommended === mode ? <PlayerMenuChip tone="good">Recommended</PlayerMenuChip> : undefined;
  const options: ChoiceOption<HdrMode>[] = [
    { value: "sdr", label: "Convert HDR to fit this screen", hint: "tone-mapping", tags: recTag("sdr") },
    { value: "passthrough", label: "Send HDR to my HDR display", hint: "passthrough", tags: recTag("passthrough") },
  ];
  if (value === "off") {
    options.push({ value: "off", label: "Off", hint: "no conversion, highlights clip" });
  }

  return (
    <div
      className="space-y-2"
      data-settings-row=""
      data-settings-label="HDR mode"
      data-settings-description={description}
    >
      <div className="space-y-1.5">
        <p className="text-white/75 text-sm font-medium">HDR mode<AdvancedTag /></p>
        <p id={descId} className="text-white/35 text-xs">{description}</p>
        <DisplayChips info={info} />
      </div>
      <ChoiceList
        value={value}
        options={options}
        onChange={onChange}
        ariaLabel="HDR mode"
        ariaDescribedBy={descId}
      />
      {note && <p className="text-white/40 text-xs leading-relaxed">{note}</p>}
    </div>
  );
}
