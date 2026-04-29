import { useState, useEffect, useRef, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

import NavSidebar, { type NavView } from "./NavSidebar";
import CinemaSuite from "./CinemaSuite";
import HomeView from "./views/HomeView";
import LibraryView from "./views/LibraryView";
import AddonsView from "./views/AddonsView";
import CalendarView from "./views/CalendarView";
import SettingsView from "./views/SettingsView";
import ThemeEngine from "./ThemeEngine";
import TitleBar from "./TitleBar";
import LandingView from "./LandingView";
import LoginView from "./LoginView";
import { useScrobble, type ActiveScrobbleTarget } from "./useScrobble";
import type { AddonEntry, LibraryItem } from "./types";
import type { UserSession } from "./LoginView";
import "./App.css";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fmt(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const SESSION_EXPIRED = "SESSION_EXPIRED";

// ---------------------------------------------------------------------------
// useAutoHide
// ---------------------------------------------------------------------------

function useAutoHide(delayMs = 3000): boolean {
  const [visible, setVisible] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const wake = () => {
      setVisible(true);
      document.documentElement.style.cursor = "";
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setVisible(false);
        document.documentElement.style.cursor = "none";
      }, delayMs);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("mousedown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("mousedown", wake);
      window.removeEventListener("keydown", wake);
      if (timer.current) clearTimeout(timer.current);
      document.documentElement.style.cursor = "";
    };
  }, [delayMs]);

  return visible;
}

// ---------------------------------------------------------------------------
// usePlayback
// ---------------------------------------------------------------------------

function usePlayback() {
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(100);

  useEffect(() => {
    const p = listen<{ time: number; duration: number; paused: boolean }>(
      "playback-update",
      ({ payload }) => {
        setTime(payload.time);
        setDuration(payload.duration);
        setPaused(payload.paused);
      }
    );
    return () => { p.then((fn) => fn()); };
  }, []);

  const togglePause = useCallback(() => invoke("toggle_pause"), []);
  const seekRelative = useCallback((s: number) => invoke("seek_relative", { seconds: s }), []);
  const commitVolume = useCallback((v: number) => {
    setVolume(v);
    invoke("set_volume", { volume: v });
  }, []);

  return { time, duration, paused, volume, togglePause, seekRelative, commitVolume };
}

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------

const PlayIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M8 5v14l11-7z" /></svg>
);
const PauseIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
);
const ReplayIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" /></svg>
);
const ForwardIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ transform: "scaleX(-1)" }}><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z" /></svg>
);
const VolumeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" /></svg>
);
const ShaderIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9-4.03-9-9-9zm0 16c-3.86 0-7-3.14-7-7s3.14-7 7-7 7 3.14 7 7-3.14 7-7 7zm-1-11h2v6h-2zm0 8h2v2h-2z" />
  </svg>
);

function IconButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="flex items-center justify-center w-10 h-10 rounded-full
                 text-white/75 hover:text-white hover:bg-white/10 active:bg-white/20
                 transition-all duration-150 flex-shrink-0">
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// ShaderPicker — dropdown in the control bar
// ---------------------------------------------------------------------------

interface ShaderProfileInfo {
  id: number;
  name: string;
  requires_file: string | null;
}

function ShaderPicker() {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ShaderProfileInfo[]>([]);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    invoke<ShaderProfileInfo[]>("list_shader_profiles").then(setProfiles).catch(() => {});
    invoke<number>("get_shader_profile").then(setActive).catch(() => {});
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", handler);
    return () => window.removeEventListener("mousedown", handler);
  }, [open]);

  const select = async (id: number) => {
    try {
      await invoke("set_shader_profile", { profile: id });
      setActive(id);
    } catch {}
    setOpen(false);
  };

  const activeName = profiles.find((p) => p.id === active)?.name ?? "None";

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Upscaling / Shader Profile"
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                    transition-all duration-150 border
                    ${open || active !== 0
                      ? "bg-ln-accent/20 text-ln-accent border-ln-accent/30"
                      : "bg-white/5 text-white/45 border-white/10 hover:bg-white/10 hover:text-white/70"
                    }`}
      >
        <ShaderIcon />
        {activeName}
      </button>

      {open && profiles.length > 0 && (
        <div className="absolute bottom-full mb-2 right-0 min-w-[160px]
                        glass-panel-elevated rounded-2xl py-1.5 shadow-glass-edge z-50
                        border border-white/10">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => select(p.id)}
              className={`w-full text-left px-4 py-2 text-sm transition-colors
                          ${p.id === active
                            ? "text-ln-accent bg-ln-accent/10"
                            : "text-white/65 hover:text-white/90 hover:bg-white/8"
                          }`}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const controlsVisible = useAutoHide(3000);
  const { time, duration, paused, volume, togglePause, seekRelative, commitVolume } = usePlayback();

  // Scrub state
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  const timeRef = useRef(0);
  useEffect(() => { timeRef.current = time; }, [time]);
  const displayTime = scrubValue ?? time;
  const progress = duration > 0 ? (displayTime / duration) * 100 : 0;

  // ── Nav state ──
  const [activeView, setActiveView] = useState<NavView>("home");

  // ── Auth state ──
  const [session, setSession] = useState<UserSession | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  /** True once the user has either signed in OR explicitly chosen guest mode. */
  const [landingDismissed, setLandingDismissed] = useState(false);
  /** Controls the LoginView modal independently of the landing screen. */
  const [showLogin, setShowLogin] = useState(false);

  // ── Addons ──
  const [addons, setAddons] = useState<AddonEntry[]>([]);

  // ── Library (Continue Watching + Calendar source) ──
  const [library, setLibrary] = useState<LibraryItem[]>([]);

  // ── Active scrobble / RPC target — set when the user starts watching a meta.
  // Until the detail-view → load_stream pipeline lands (Phase 3.3) this is
  // null, which makes scrobble/RPC pipelines safely no-op.
  const [activeTarget /*, setActiveTarget */] = useState<ActiveScrobbleTarget | null>(null);

  const loadLibrary = useCallback(async (sess: UserSession | null) => {
    if (!sess?.auth_key) { setLibrary([]); return; }
    try {
      const items = await invoke<LibraryItem[]>("library_get", { authKey: sess.auth_key });
      setLibrary(items);
    } catch (err) {
      if (String(err) === SESSION_EXPIRED) {
        await invoke("logout").catch(() => {});
        setSession(null);
        setLibrary([]);
      }
      // Other errors silently leave library empty — calendar/Continue Watching
      // will just show empty states.
    }
  }, []);

  // ── Session expired ──
  const handleSessionExpired = useCallback(async () => {
    await invoke("logout").catch(() => {});
    setSession(null);
    setLibrary([]);
    invoke<AddonEntry[]>("list_addons").then(setAddons).catch(() => setAddons([]));
  }, []);

  // ── Load synced or local addons ──
  const loadSyncedAddons = useCallback(async (sess: UserSession) => {
    try {
      const synced = await invoke<AddonEntry[]>("get_synced_addons", { authKey: sess.auth_key });
      setAddons(synced);
    } catch (err) {
      if (String(err) === SESSION_EXPIRED) await handleSessionExpired();
    }
  }, [handleSessionExpired]);

  const loadLocalAddons = useCallback(() => {
    invoke<AddonEntry[]>("list_addons").then(setAddons).catch(() => {});
  }, []);

  // ── Startup: restore session ──
  // Tokens live in the OS keyring (DPAPI / Keychain / Secret Service), encrypted
  // at rest. If a session exists, we bypass the LandingView entirely.
  useEffect(() => {
    invoke<UserSession | null>("get_session")
      .then(async (sess) => {
        if (sess) {
          setSession(sess);
          setLandingDismissed(true); // bypass landing on cached credentials
          await Promise.all([loadSyncedAddons(sess), loadLibrary(sess)]);
        } else {
          loadLocalAddons();
        }
      })
      .catch(() => loadLocalAddons())
      .finally(() => setAuthChecked(true));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auth handlers ──
  const handleLoginSuccess = useCallback(async (sess: UserSession) => {
    setSession(sess);
    setLandingDismissed(true);
    await Promise.all([loadSyncedAddons(sess), loadLibrary(sess)]);
  }, [loadSyncedAddons, loadLibrary]);

  const handleContinueGuest = useCallback(() => {
    setLandingDismissed(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await invoke("logout").catch(() => {});
    setSession(null);
    setLibrary([]);
    loadLocalAddons();
  }, [loadLocalAddons]);

  /** NavSidebar profile-button click. Logged-in: jump to settings. Guest: open login. */
  const handleProfileClick = useCallback(() => {
    if (session) setActiveView("settings");
    else         setShowLogin(true);
  }, [session]);

  // ── Addon list handlers (passed to AddonsView) ──
  const handleAddonAdded = useCallback((entry: AddonEntry) => {
    setAddons((prev) => [...prev, entry]);
  }, []);

  const handleAddonRemoved = useCallback((url: string) => {
    setAddons((prev) => prev.filter((a) => a.url !== url));
  }, []);

  // ── Scrobble lifecycle (no-ops while activeTarget is null) ──
  useScrobble({ active: activeTarget, playback: { time, duration, paused } });

  // ── Discord Rich Presence ──
  // Set presence whenever we have an active target with a non-zero duration;
  // clear when nothing is playing. Backend handles privacy / blocked titles.
  const presenceStartedAt = useRef<number | null>(null);
  useEffect(() => {
    if (activeTarget && duration > 0) {
      // Capture start time once per session
      if (presenceStartedAt.current == null) {
        presenceStartedAt.current = Math.floor(Date.now() / 1000);
      }
      invoke("discord_set_presence", {
        presence: {
          title: activeTarget.name,
          subtitle: activeTarget.episode ?? null,
          started_at: presenceStartedAt.current,
        },
      }).catch(() => {});
    } else {
      presenceStartedAt.current = null;
      invoke("discord_clear_presence").catch(() => {});
    }
  }, [activeTarget, duration]);

  if (!authChecked) return null;

  // Show landing when no session AND user hasn't yet chosen guest mode.
  const showLanding = !session && !landingDismissed;

  return (
    <ThemeEngine>
    <div className="h-screen w-screen overflow-hidden flex flex-col bg-black/20">
      {/* ── Custom title bar (always on top) ── */}
      <TitleBar />

      {/* ── Body ── */}
      {showLanding ? (
        <LandingView
          onSignedIn={handleLoginSuccess}
          onContinueGuest={handleContinueGuest}
        />
      ) : (
      <div className="flex-1 flex min-h-0">
      {/* ── Nav sidebar ── */}
      <NavSidebar
        active={activeView}
        onNavigate={setActiveView}
        userEmail={session?.email ?? null}
        onProfileClick={handleProfileClick}
      />

      {/* ── Main content area ── */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {activeView === "home" && (
          <HomeView addons={addons} session={session} library={library} />
        )}
        {activeView === "library" && (
          <LibraryView />
        )}
        {activeView === "addons" && (
          <AddonsView
            addons={addons}
            session={session}
            onAdd={handleAddonAdded}
            onRemove={handleAddonRemoved}
            onLoginSuccess={handleLoginSuccess}
            onLogout={handleLogout}
            onSessionExpired={handleSessionExpired}
          />
        )}
        {activeView === "calendar" && (
          <CalendarView library={library} addons={addons} />
        )}
        {activeView === "settings" && (
          <SettingsView addons={addons} />
        )}
      </div>

      {/* ── Player control bar — only while a video is active ── */}
      {duration > 0 && (
        <div
          className="absolute inset-x-0 bottom-8 flex justify-center px-6
                     pointer-events-none transition-opacity duration-500 ease-in-out"
          style={{ opacity: controlsVisible ? 1 : 0 }}
        >
          <div className="glass-panel-elevated rounded-full px-4 py-3
                          flex items-center gap-2 w-full max-w-3xl shadow-glass-edge pointer-events-auto">
            <IconButton onClick={() => seekRelative(-10)} label="Skip back 10 seconds"><ReplayIcon /></IconButton>
            <IconButton onClick={togglePause} label={paused ? "Play" : "Pause"}>
              {paused ? <PlayIcon /> : <PauseIcon />}
            </IconButton>
            <IconButton onClick={() => seekRelative(10)} label="Skip forward 10 seconds"><ForwardIcon /></IconButton>

            <div className="w-px h-5 bg-white/15 flex-shrink-0 mx-1" />

            <div className="flex-1 flex items-center gap-3 min-w-0">
              <input type="range" min={0} max={duration || 1} step={0.25} value={displayTime}
                onChange={(e) => setScrubValue(parseFloat(e.target.value))}
                onPointerUp={(e) => {
                  const val = parseFloat((e.target as HTMLInputElement).value);
                  seekRelative(val - timeRef.current);
                  setScrubValue(null);
                }}
                className="progress-range flex-1"
                style={{ "--progress": `${progress}%` } as React.CSSProperties}
                aria-label="Playback position" />
              <span className="text-white/55 text-xs font-mono tabular-nums flex-shrink-0 w-[80px] text-right">
                {fmt(displayTime)}&nbsp;/&nbsp;{fmt(duration)}
              </span>
            </div>

            <div className="w-px h-5 bg-white/15 flex-shrink-0 mx-1" />

            <div className="flex items-center gap-2 flex-shrink-0">
              <span className="text-white/55"><VolumeIcon /></span>
              <input type="range" min={0} max={100} step={1} value={volume}
                onChange={(e) => commitVolume(parseInt(e.target.value, 10))}
                className="volume-range w-20" aria-label="Volume" />
            </div>

            <div className="w-px h-5 bg-white/15 flex-shrink-0 mx-1" />

            {/* Shader picker */}
            <ShaderPicker />
          </div>
        </div>
      )}

      {/* ── CinemaSuite: performance OSD overlay ── */}
      <CinemaSuite />
      </div>
      )}

      {/* Standalone login modal — used when a guest clicks the profile avatar */}
      {showLogin && !showLanding && (
        <LoginView
          onSuccess={(sess) => { setShowLogin(false); handleLoginSuccess(sess); }}
          onGuest={() => setShowLogin(false)}
        />
      )}
    </div>
    </ThemeEngine>
  );
}
