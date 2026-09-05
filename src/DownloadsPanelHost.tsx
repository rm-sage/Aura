// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { invoke } from "@tauri-apps/api/core";
import { SIDE_PILL_LEFT_PX, SIDE_PILL_TOP_PX } from "./SidePill";
import Tooltip from "./Tooltip";
import DownloadRow from "./DownloadRow";
import {
  clearFinishedDownloads,
  formatSpeed,
  pauseAllDownloads,
  reorderDownload,
  useDownloads,
} from "./downloadsStore";
import {
  closeDownloadsPanel,
  closeDownloadsPanelImmediate,
  useDownloadsPanelPhase,
} from "./downloadsPanel";

// ---------------------------------------------------------------------------
// DownloadsPanelHost — the anchored overlay under the title-bar button.
//
// PORTALLED TO document.body, and that is not a style choice. ContextMenuHost
// renders its menu INLINE at z-[200] (not through a portal; only its submenu
// portals out), inside .aura-app-shell, which is its own stacking context
// (`position: relative; z-index: 0`). A panel rendered in that same context at
// any z-index paints OVER the menu, so a right-click on a row would raise a
// menu you cannot see, while its hover submenu appeared out of nowhere.
// Portalling to body puts the panel in the root stacking context, above the
// shell entirely, and the dismiss guard then exempts the menu by selector.
//
// It is also mounted OUTSIDE the app-body div, which gets `hidden` the instant
// playback starts. Inside it, the panel would vanish mid-playback.
//
// DISMISSAL. This is the first guard in the tree with a button test, and the
// difference is deliberate: every existing panel (NotificationsBell,
// AccountButton, ContextMenu) closes on bubble-phase mousedown with no
// `e.button` check, so they all close on a right-click. Here a right-click,
// a middle-click and a scroll must all leave the panel open, and so must a
// click anywhere on the title bar. Do not "fix" this back to the house pattern.
// ---------------------------------------------------------------------------

export default function DownloadsPanelHost({ isFullscreen }: { isFullscreen: boolean }) {
  const phase = useDownloadsPanelPhase();
  const { jobs, active, total_speed_bps: speed, root } = useDownloads();

  // Entering fullscreen unmounts TitleBar, so the anchor this panel points at
  // is gone. Animating out from a control that is no longer on screen reads as
  // a glitch, so close instantly instead.
  useEffect(() => {
    if (isFullscreen) closeDownloadsPanelImmediate();
  }, [isFullscreen]);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeDownloadsPanel();
    }
  }, []);

  useEffect(() => {
    if (phase === "closed") return;

    const onMouseDown = (e: MouseEvent) => {
      // LEFT BUTTON ONLY. A right-click is how you reach a row's own menu,
      // and a middle-click is not a dismissal gesture anywhere else in the app.
      if (e.button !== 0) return;
      const t = e.target as HTMLElement | null;
      if (!t) return;
      // Inside the panel, or on its own trigger (which toggles).
      if (t.closest("[data-downloads-panel]")) return;
      if (t.closest("[data-downloads-trigger]")) return;
      // The title bar is the panel's own furniture: clicking it, including the
      // drag region, must not dismiss.
      if (t.closest("[data-aura-titlebar]")) return;
      // A menu raised FROM a row is not a DOM descendant of the panel, because
      // the singleton menu host lives elsewhere in the tree.
      if (t.closest("[data-aura-context-menu]")) return;
      closeDownloadsPanel();
    };

    // Capture phase, so a click on the video surface reaches this before
    // PlayerOverlay's own mousedown handler. Deliberately NOT listening for
    // wheel or contextmenu: scrolling and right-clicking must leave the panel
    // alone.
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [phase, onKeyDown]);

  // Matches AddonsView's sensor setup, including the 6px activation distance
  // that keeps a plain click on a row's buttons from starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      // The engine's scheduler reads the list in order every time a slot
      // frees, so moving a row here genuinely changes what runs next. (A
      // tokio Semaphore would have made this decorative: it hands out permits
      // in wait-arrival order, not list order.)
      const toIndex = jobs.findIndex((j) => j.id === String(over.id));
      if (toIndex >= 0) void reorderDownload(String(active.id), toIndex);
    },
    [jobs],
  );

  const grouped = useMemo(() => {
    const activeJobs = jobs.filter(
      (j) => j.state !== "completed" && j.state !== "failed",
    );
    const doneJobs = jobs.filter((j) => j.state === "completed" || j.state === "failed");
    return { activeJobs, doneJobs };
  }, [jobs]);

  if (phase === "closed" || isFullscreen) return null;

  const body = (
    <div
      data-downloads-panel
      role="dialog"
      aria-label="Downloads"
      className={[
        "aura-dl-panel aura-float-glass fixed z-[10047] flex flex-col",
        // Arbitrary values on purpose: tailwind.config.ts replaces the maxWidth
        // scale, so every named token emits nothing.
        "w-[420px] max-w-[calc(100vw-40px)] max-h-[min(560px,calc(100vh-72px))]",
        "rounded-2xl overflow-hidden",
        phase === "closing" ? "aura-dl-panel-out" : "aura-dl-panel-in",
      ].join(" ")}
      style={{ top: SIDE_PILL_TOP_PX, left: SIDE_PILL_LEFT_PX }}
    >
      <header className="flex items-center gap-2 px-3.5 pt-3 pb-2.5 border-b border-white/8">
        <h2 className="text-[13px] font-semibold text-white/85 flex-1 min-w-0 truncate">
          Downloads
          {active > 0 && (
            <span className="ml-2 text-[11px] font-normal text-white/45">
              {active} active{speed > 0 ? ` · ${formatSpeed(speed)}` : ""}
            </span>
          )}
        </h2>
        {active > 0 && (
          <Tooltip text="Pause everything" pos="bottom">
            <button
              type="button"
              onClick={() => void pauseAllDownloads()}
              className="text-[11px] px-2 py-1 rounded-md text-white/55 hover:text-white
                         hover:bg-white/10 transition-colors"
            >
              Pause all
            </button>
          </Tooltip>
        )}
        {grouped.doneJobs.length > 0 && (
          <Tooltip text="Clear finished downloads from this list" pos="bottom">
            <button
              type="button"
              onClick={() => void clearFinishedDownloads()}
              className="text-[11px] px-2 py-1 rounded-md text-white/55 hover:text-white
                         hover:bg-white/10 transition-colors"
            >
              Clear
            </button>
          </Tooltip>
        )}
        <button
          type="button"
          aria-label="Close downloads"
          onClick={closeDownloadsPanel}
          className="w-6 h-6 rounded-md flex items-center justify-center text-white/50
                     hover:text-white hover:bg-white/10 transition-colors"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-1.5 py-1.5">
        {jobs.length === 0 ? (
          <Empty root={root} />
        ) : (
          <>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={onDragEnd}
            >
              <SortableContext
                items={grouped.activeJobs.map((j) => j.id)}
                strategy={verticalListSortingStrategy}
              >
                {grouped.activeJobs.map((j, i) => (
                  <div
                    key={j.id}
                    className="aura-dl-row-in"
                    style={{ animationDelay: `${Math.min(i, 6) * 28}ms` }}
                  >
                    <DownloadRow job={j} sortable={j.state === "queued"} />
                  </div>
                ))}
              </SortableContext>
            </DndContext>
            {grouped.doneJobs.length > 0 && grouped.activeJobs.length > 0 && (
              <div className="mx-3 my-1.5 h-px bg-white/8" />
            )}
            {grouped.doneJobs.map((j, i) => (
              <div
                key={j.id}
                className="aura-dl-row-in"
                style={{ animationDelay: `${Math.min(i + grouped.activeJobs.length, 6) * 28}ms` }}
              >
                <DownloadRow job={j} />
              </div>
            ))}
          </>
        )}
      </div>

      <footer className="px-3.5 py-2 border-t border-white/8 flex items-center gap-2">
        <p className="flex-1 min-w-0 text-[11px] text-white/35 truncate" title={root || undefined}>
          {root || "No download folder set yet"}
        </p>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent("aura:open-settings", { detail: { section: "sec-downloads" } }),
            );
            closeDownloadsPanel();
          }}
          className="text-[11px] px-2 py-1 rounded-md text-white/50 hover:text-white
                     hover:bg-white/10 transition-colors flex-shrink-0"
        >
          Settings
        </button>
      </footer>
    </div>
  );

  return createPortal(body, document.body);
}

function Empty({ root }: { root: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-[12.5px] text-white/50">Nothing downloading.</p>
      <p className="text-[11px] text-white/30 mt-1.5 leading-relaxed">
        Right-click a source on a title's page and choose Download.
      </p>
      {!root && (
        <button
          type="button"
          onClick={async () => {
            const picked = await invoke<string | null>("pick_folder").catch(() => null);
            if (picked) await invoke("downloads_set_root", { path: picked }).catch(() => {});
          }}
          className="mt-3 text-[11.5px] px-3 py-1.5 rounded-lg text-white/80
                     bg-white/[0.08] hover:bg-white/[0.14] border border-white/10
                     transition-colors"
        >
          Choose a download folder
        </button>
      )}
    </div>
  );
}
