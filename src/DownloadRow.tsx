// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import Tooltip from "./Tooltip";
import { openContextMenu, type ContextMenuItem } from "./ContextMenu";
import { showAppToast } from "./AppToast";
import {
  cancelDownload,
  jobProgress,
  jobStatusLine,
  pauseDownload,
  resumeDownload,
  retryDownload,
  type DownloadJob,
} from "./downloadsStore";

// ---------------------------------------------------------------------------
// DownloadRow — one job.
//
// Right-clicking a row opens the app's singleton context menu. That menu
// renders at z-[200] INSIDE .aura-app-shell's stacking context, while this
// panel is portalled to document.body above it, which is why the panel's
// dismiss guard has to exempt the menu root explicitly: otherwise clicking
// "Copy link" would close the panel out from under the menu.
// ---------------------------------------------------------------------------

interface Props {
  job: DownloadJob;
  /** Queued jobs can be dragged to change what runs next. Anything already
   *  running, paused or finished is not reorderable: its position no longer
   *  decides anything. */
  sortable?: boolean;
}

export default function DownloadRow({ job, sortable = false }: Props) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: job.id, disabled: !sortable });
  const p = jobProgress(job);
  const isActive = job.state === "running" || job.state === "queued" || job.state === "relinking";

  const reveal = useCallback(async () => {
    try {
      await revealItemInDir(job.dest_path);
    } catch {
      showAppToast("Could not open that folder.", { tone: "danger" });
    }
  }, [job.dest_path]);

  const copyLink = useCallback(async () => {
    try {
      await writeText(job.url);
      showAppToast("Link copied.", { tone: "success" });
    } catch {
      showAppToast("Could not copy the link.", { tone: "danger" });
    }
  }, [job.url]);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const items: ContextMenuItem[] = [];

      if (job.state === "running") {
        items.push({
          label: "Pause",
          onClick: () => void pauseDownload(job.id),
          disabled: !job.pausable,
          hint: job.pausable
            ? undefined
            : "This one is being remuxed in a single pass, so it cannot be paused. Cancel it instead.",
        });
      } else if (job.state === "paused") {
        items.push({ label: "Resume", onClick: () => void resumeDownload(job.id) });
      } else if (job.state === "failed" || job.state === "needs_source") {
        items.push({ label: "Try again", onClick: () => void retryDownload(job.id) });
      }

      if (job.state === "completed") {
        items.push({ label: "Show in folder", onClick: () => void reveal() });
      }
      items.push({ label: "Copy link", onClick: () => void copyLink() });

      if (job.state !== "completed") {
        items.push({ kind: "divider" });
        items.push({
          label: "Cancel download",
          tone: "danger",
          onClick: () => void cancelDownload(job.id),
          hint: "Removes the job and deletes the partly-downloaded file.",
        });
      } else {
        items.push({ kind: "divider" });
        items.push({
          label: "Remove from list",
          onClick: () => void cancelDownload(job.id),
          hint: "The downloaded file stays on disk.",
        });
      }
      openContextMenu(e.clientX, e.clientY, items);
    },
    [job, reveal, copyLink],
  );

  return (
    <div
      ref={sortable ? setNodeRef : undefined}
      style={
        sortable
          ? { transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 1 : undefined }
          : undefined
      }
      className={[
        "aura-dl-row group relative px-3 py-2.5 rounded-xl transition-colors",
        "hover:bg-white/[0.06]",
        isDragging ? "opacity-60" : "",
      ].filter(Boolean).join(" ")}
      onContextMenu={onContextMenu}
      {...(sortable ? attributes : {})}
      {...(sortable ? listeners : {})}
    >
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <p
            className="text-[12.5px] text-white/85 leading-snug truncate"
            title={job.truncated ? `${job.title}\nName shortened to fit the Windows path limit.` : job.title}
          >
            {job.title}
          </p>
          {job.subtitle && (
            <p className="text-[11px] text-white/40 leading-snug truncate mt-0.5">
              {job.subtitle}
            </p>
          )}
        </div>
        <div className="flex-shrink-0 flex items-center gap-1 opacity-0 group-hover:opacity-100
                        focus-within:opacity-100 transition-opacity">
          {job.state === "running" && (
            <Tooltip
              text={
                job.pausable
                  ? "Pause"
                  : "Cannot be paused: this stream is remuxed in a single pass"
              }
              pos="bottom"
            >
              <IconBtn
                onClick={() => void pauseDownload(job.id)}
                disabled={!job.pausable}
                label="Pause"
              >
                <PauseIcon />
              </IconBtn>
            </Tooltip>
          )}
          {job.state === "paused" && (
            <Tooltip text="Resume" pos="bottom">
              <IconBtn onClick={() => void resumeDownload(job.id)} label="Resume">
                <PlayIcon />
              </IconBtn>
            </Tooltip>
          )}
          {(job.state === "failed" || job.state === "needs_source") && (
            <Tooltip text="Try again" pos="bottom">
              <IconBtn onClick={() => void retryDownload(job.id)} label="Try again">
                <RetryIcon />
              </IconBtn>
            </Tooltip>
          )}
          {job.state === "completed" && (
            <Tooltip text="Show in folder" pos="bottom">
              <IconBtn onClick={() => void reveal()} label="Show in folder">
                <FolderIcon />
              </IconBtn>
            </Tooltip>
          )}
          <Tooltip
            text={job.state === "completed" ? "Remove from list" : "Cancel"}
            pos="bottom"
          >
            <IconBtn
              onClick={() => void cancelDownload(job.id)}
              label={job.state === "completed" ? "Remove from list" : "Cancel"}
              danger
            >
              <CloseIcon />
            </IconBtn>
          </Tooltip>
        </div>
      </div>

      {/* Progress track. Rendered for anything unfinished, so a paused job
          still shows how far it got rather than collapsing to a bare line. */}
      {job.state !== "completed" && (
        <div className="mt-2 h-[3px] rounded-full bg-white/10 overflow-hidden">
          <div
            className={[
              "aura-dl-bar h-full rounded-full",
              p == null && isActive ? "is-indeterminate" : "",
              job.state === "failed" || job.state === "needs_source" ? "is-error" : "",
              job.state === "paused" ? "is-paused" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={p != null ? { width: `${(p * 100).toFixed(1)}%` } : undefined}
          />
        </div>
      )}

      <p
        className={[
          "mt-1.5 text-[11px] leading-snug truncate",
          job.state === "failed" || job.state === "needs_source"
            ? "text-rose-300/80"
            : job.state === "completed"
              ? "text-emerald-300/70"
              : "text-white/45",
        ].join(" ")}
      >
        {jobStatusLine(job)}
      </p>
    </div>
  );
}

function IconBtn({
  onClick,
  label,
  children,
  danger,
  disabled,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        "w-6 h-6 rounded-md flex items-center justify-center transition-colors",
        disabled
          ? "text-white/20 cursor-not-allowed"
          : danger
            ? "text-white/50 hover:text-rose-300 hover:bg-rose-400/10"
            : "text-white/55 hover:text-white hover:bg-white/10",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

const S = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const PauseIcon = () => (
  <svg {...S}>
    <path d="M9 5v14M15 5v14" />
  </svg>
);
const PlayIcon = () => (
  <svg {...S}>
    <path d="M7 4.5v15l12-7.5z" />
  </svg>
);
const RetryIcon = () => (
  <svg {...S}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 5v6h-6" />
  </svg>
);
const FolderIcon = () => (
  <svg {...S}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
const CloseIcon = () => (
  <svg {...S}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
