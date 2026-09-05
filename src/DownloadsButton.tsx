// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from "react";
import Tooltip from "./Tooltip";
import { useDownloads } from "./downloadsStore";
import { toggleDownloadsPanel, useDownloadsPanelPhase } from "./downloadsPanel";

// ---------------------------------------------------------------------------
// DownloadsButton — the title-bar affordance, sitting immediately after the
// Aura Cloud sync chip.
//
// Placement is after the chip, not before, and that is load-bearing: the button
// expands to ~200px when something is downloading, and expanding to the LEFT of
// a status icon would shove that icon sideways several times a session. After
// it, the pill grows into the flex-1 spacer and nothing else on the bar moves,
// window controls included.
//
// The title bar is `overflow-hidden`, which rules out two obvious techniques:
// no outer box-shadow glow (it would be clipped at y=0 and y=36, so the alert
// treatment is `inset`), and the panel cannot be a child of this component (it
// would be clipped to 36px), so it mounts at the App root instead.
//
// Status colours are lifted verbatim from SyncStatusChip's COLOR map so the two
// adjacent title-bar status affordances speak one colour language.
// ---------------------------------------------------------------------------

/** Icon completion flourish. Matches aura-dl-land + aura-dl-halo in App.css. */
const DL_FLOURISH_MS = 720;
/** How long "N downloads complete" holds before the pill collapses again. */
const DL_COMPLETE_DWELL_MS = 2400;

const RING_R = 10.5;
/** ceil(2 * pi * 10.5) in viewBox user units. */
const RING_LEN = 66;

type Tone = "idle" | "queued" | "running" | "paused" | "complete" | "error";

const TONE_COLOR: Record<Tone, string> = {
  // Matches SyncStatusChip's guest grey exactly.
  idle: "rgba(255,255,255,0.6)",
  queued: "var(--ln-accent)",
  running: "var(--ln-accent)",
  paused: "rgba(255,255,255,0.75)",
  complete: "rgb(110, 231, 183)", // emerald-300, as the sync chip's "ok"
  error: "rgb(251, 113, 133)", // rose-400, as the sync chip's "error"
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export default function DownloadsButton() {
  const { jobs, active, overall } = useDownloads();
  const phase = useDownloadsPanelPhase();
  const panelOpen = phase !== "closed";
  const [hovered, setHovered] = useState(false);

  const counts = useMemo(() => {
    let running = 0;
    let queued = 0;
    let paused = 0;
    let failed = 0;
    for (const j of jobs) {
      if (j.state === "running" || j.state === "relinking") running += 1;
      else if (j.state === "queued") queued += 1;
      else if (j.state === "paused") paused += 1;
      else if (j.state === "failed" || j.state === "needs_source") failed += 1;
    }
    return { running, queued, paused, failed };
  }, [jobs]);

  // A completion flourish fires when the last active job finishes, not when
  // any single one does: on a queue of eight, eight flourishes is a strobe.
  const [flourish, setFlourish] = useState(false);
  const [dwelling, setDwelling] = useState(false);
  const prevActive = useRef(active);
  useEffect(() => {
    const fell = prevActive.current > 0 && active === 0;
    prevActive.current = active;
    if (!fell) return;
    const anyCompleted = jobs.some((j) => j.state === "completed");
    if (!anyCompleted) return;
    setFlourish(true);
    setDwelling(true);
    const a = setTimeout(() => setFlourish(false), DL_FLOURISH_MS);
    const b = setTimeout(() => setDwelling(false), DL_FLOURISH_MS + DL_COMPLETE_DWELL_MS);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [active, jobs]);

  // A new download starting inside the dwell cancels it, so the pill never
  // collapses only to re-expand a moment later.
  useEffect(() => {
    if (active > 0 && dwelling) setDwelling(false);
  }, [active, dwelling]);

  const tone: Tone = useMemo(() => {
    // Precedence: a failure the user has not seen outranks everything, but a
    // live transfer outranks a stale failure once the panel has been opened.
    if (counts.failed > 0 && !panelOpen) return "error";
    if (counts.running > 0) return "running";
    if (counts.queued > 0) return "queued";
    if (counts.paused > 0) return "paused";
    if (counts.failed > 0) return "error";
    if (dwelling) return "complete";
    return "idle";
  }, [counts, panelOpen, dwelling]);

  const label = useMemo(() => {
    if (tone === "error") return plural(counts.failed, "download") + " failed";
    if (tone === "running") return plural(counts.running, "download") + " in progress";
    if (tone === "queued") return plural(counts.queued, "download") + " queued";
    if (tone === "paused") return plural(counts.paused, "download") + " paused";
    if (tone === "complete") {
      const done = jobs.filter((j) => j.state === "completed").length;
      return done === 1 ? "Download complete" : `${done} downloads complete`;
    }
    return "";
  }, [tone, counts, jobs]);

  const expanded =
    active > 0 || counts.failed > 0 || counts.paused > 0 || panelOpen || hovered || dwelling;

  const tooltip = label || (jobs.length ? "Downloads" : "Downloads (nothing yet)");

  // Indeterminate whenever any running job has no known size: a fraction
  // derived from a partial denominator would be a number that means nothing.
  const indeterminate =
    counts.running > 0 &&
    (overall == null || jobs.some((j) => j.state === "running" && !j.total_bytes));

  const cls = [
    "aura-dl-btn relative flex items-center h-full px-2",
    "text-[12px] font-medium leading-none whitespace-nowrap",
    expanded ? "is-expanded" : "",
    panelOpen ? "is-open" : "",
    flourish ? "is-complete" : "",
    tone === "error" && !panelOpen ? "aura-dl-alert" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tooltip text={tooltip} pos="bottom">
      <button
        type="button"
        data-no-drag
        data-downloads-trigger
        aria-label={tooltip}
        aria-expanded={panelOpen}
        onClick={toggleDownloadsPanel}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cls}
        style={{ color: TONE_COLOR[tone], opacity: tone === "idle" && !jobs.length ? 0.45 : 0.85 }}
      >
        <span className="relative flex-shrink-0 w-4 h-4 flex items-center justify-center">
          <DownloadGlyph
            progress={overall ?? 0}
            indeterminate={indeterminate}
            active={counts.running > 0 || counts.paused > 0 || counts.queued > 0}
          />
          {active > 0 && (
            <span
              aria-hidden
              // 14px, not the 18px the notifications bell uses: that badge
              // lives on a 40px pill, and at 18px in a 36px bar its top edge
              // would touch the bar's border.
              className="absolute -top-1 -right-1.5 min-w-[14px] h-[14px] px-[3px]
                         rounded-full flex items-center justify-center
                         text-[9px] font-semibold leading-none
                         bg-ln-accent text-black aura-bell-badge-pop"
            >
              {active > 9 ? "9+" : active}
            </span>
          )}
        </span>
        <span className="aura-dl-label">
          {/* Arbitrary max-width on purpose: tailwind.config.ts replaces the
              maxWidth scale, so max-w-xs and friends emit no CSS at all. */}
          <span className="truncate max-w-[240px]">{label}</span>
        </span>
      </button>
    </Tooltip>
  );
}

function DownloadGlyph({
  progress,
  indeterminate,
  active,
}: {
  progress: number;
  indeterminate: boolean;
  active: boolean;
}) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* Completion halo as an SVG circle rather than a box-shadow: the title
          bar is overflow-hidden, so an expanding outer shadow would be clipped
          top and bottom. */}
      <circle
        className="aura-dl-halo-ring"
        cx="12"
        cy="12"
        r={RING_R}
        stroke="rgb(110,231,183)"
        strokeWidth="1.6"
      />
      {active && (
        <>
          <circle
            cx="12"
            cy="12"
            r={RING_R}
            stroke="currentColor"
            strokeOpacity="0.18"
            strokeWidth="1.8"
          />
          <circle
            className={indeterminate ? "aura-dl-ring is-indeterminate" : "aura-dl-ring"}
            cx="12"
            cy="12"
            r={RING_R}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            style={
              indeterminate
                ? undefined
                : { strokeDashoffset: RING_LEN * (1 - Math.max(0, Math.min(1, progress))) }
            }
          />
        </>
      )}
      <g
        className="aura-dl-glyph"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 6.5v7.5M9 11.5l3 3 3-3" />
        <path d="M7.5 17h9" />
      </g>
    </svg>
  );
}
