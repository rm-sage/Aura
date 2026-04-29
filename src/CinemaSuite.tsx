import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OsdStats {
  frame_drops: number;
  video_width: number;
  video_height: number;
  display_fps: number;
  shader_profile: string;
}

// ---------------------------------------------------------------------------
// Performance OSD — toggled globally by the backtick (`) key
// ---------------------------------------------------------------------------

function OsdOverlay({ stats }: { stats: OsdStats }) {
  return (
    <div className="fixed top-4 right-4 z-50 pointer-events-none
                    bg-black/70 backdrop-blur-md rounded-xl px-4 py-3
                    border border-white/10 font-mono text-[11px] text-white/75
                    space-y-1 min-w-[210px]">
      <div className="flex justify-between gap-8">
        <span className="text-white/40">Profile</span>
        <span className="text-ln-accent">{stats.shader_profile}</span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-white/40">Resolution</span>
        <span>
          {stats.video_width > 0 ? `${stats.video_width}×${stats.video_height}` : "—"}
        </span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-white/40">Display FPS</span>
        <span>{stats.display_fps > 0 ? stats.display_fps.toFixed(2) : "—"}</span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-white/40">Frame Drops</span>
        <span className={stats.frame_drops > 0 ? "text-red-400" : "text-green-400"}>
          {stats.frame_drops}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CinemaSuite — mounts once, lives for the app lifetime
// Renders: the backtick-toggled OSD overlay.
// The shader profile picker lives in the video control bar (App.tsx).
// ---------------------------------------------------------------------------

export default function CinemaSuite() {
  const [osdVisible, setOsdVisible] = useState(false);
  const [osdStats, setOsdStats] = useState<OsdStats>({
    frame_drops: 0,
    video_width: 0,
    video_height: 0,
    display_fps: 0,
    shader_profile: "None",
  });

  useEffect(() => {
    const p = listen<OsdStats>("osd-update", ({ payload }) => setOsdStats(payload));
    return () => { p.then((fn) => fn()); };
  }, []);

  const handleKey = useCallback((e: KeyboardEvent) => {
    if (e.key === "`" || e.key === "~") {
      e.preventDefault();
      setOsdVisible((v) => !v);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  return osdVisible ? <OsdOverlay stats={osdStats} /> : null;
}
