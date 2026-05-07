// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

// ---------------------------------------------------------------------------
// Persistent application settings
//
// One JSON file per "scope" (= signed-in account or "guest"), stored under
//   <app_data_dir>/settings/<scope>.json
// New keys are additive and fall back to defaults via `#[serde(default)]` so
// older settings.<scope>.json files load forward-compatibly.
//
// Two robustness invariants:
//   1. Every save is atomic: write to <scope>.json.tmp, fsync, rename to
//      <scope>.json. A power-loss or crash mid-write leaves the previous
//      good file intact instead of corrupting it.
//   2. Load is non-destructive: if the file exists but FAILS to parse, the
//      bad file is backed up (<scope>.json.bad-<timestamp>) and the
//      in-memory cache is LEFT UNCHANGED. Older code re-read disk in
//      `update_settings` and silently clobbered every user-set field with
//      defaults whenever the file was momentarily unreadable.
//
// Theme is the only setting validated on write; the rest are typed and
// constrained at the wire boundary by serde.
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default = "default_theme")]
    pub theme: String, // "mica" | "glass" | "midnight"

    // ── Playback defaults ──────────────────────────────────────────────────
    // Audio is driven entirely by `audio_priority` now (see below) — the
    // older `global_audio_lang` / `anime_audio_lang` fields were redundant
    // once the priority list could express "original, en" with a per-title
    // fallback.
    //
    // Subtitles still use a single global language preference. We don't
    // split anime vs non-anime any more — both use the same English-by-
    // default fallback, and per-title overrides cover the unusual cases.
    #[serde(default = "default_subtitle_language")]
    pub subtitle_language: String,

    /// Subset of ISO-639-1 codes the subtitle picker should surface.
    /// Empty = show every track regardless of language (the legacy behaviour).
    /// Lower-cased on save so matching is consistent.
    #[serde(default)]
    pub selectable_subtitle_languages: Vec<String>,

    /// Ordered audio language priority, evaluated per-stream by the
    /// scoring algorithm in PlayerOverlay. Tokens are lower-case ISO 639-1
    /// codes ("en", "ja") plus the literal "original", which is replaced
    /// at evaluation time with the meta's `original_language` (if any).
    /// English is always implicitly appended as a final fallback.
    ///
    /// Default: ["original", "en"] — pick the title's original audio when
    /// AIOMetadata exposes it, otherwise English. Power users can re-order.
    #[serde(default = "default_audio_priority")]
    pub audio_priority: Vec<String>,

    /// When true, dub disposition (or "Dub" in the track title) penalises
    /// the track heavily so the scorer strongly prefers original audio
    /// even when the language matches a higher-priority dub.
    #[serde(default)]
    pub avoid_dubs: bool,

    /// Optional ISO 3166-1 alpha-2 region code (e.g. "US", "GB", "MX").
    /// Used as a fall-back regional tiebreak when picking between dialect
    /// variants of the same language and the meta's productionCountries
    /// don't disambiguate. Empty = no preference.
    #[serde(default)]
    pub user_region: String,

    // ── Subtitle styling ──────────────────────────────────────────────────
    // Surfaced live via `apply_subtitle_style` — MPV honours these as
    // per-instance properties so we re-push on every settings change.
    /// Font size in MPV units (typical range 20–80, default 45).
    #[serde(default = "default_sub_font_size")]
    pub subtitle_font_size: u32,
    /// Vertical position (0 = top, 100 = bottom). Default 95 = near-bottom.
    #[serde(default = "default_sub_position")]
    pub subtitle_position: u32,
    /// Outline thickness around glyphs (0–10).
    #[serde(default = "default_sub_border_size")]
    pub subtitle_border_size: u32,
    /// Glyph fill colour. `#RRGGBB` or `#RRGGBBAA`.
    #[serde(default = "default_sub_color")]
    pub subtitle_color: String,
    /// Background-box colour behind glyphs. `#00000000` = no box.
    #[serde(default = "default_sub_back_color")]
    pub subtitle_back_color: String,
    /// Optional font family name. Empty = MPV's default sans.
    #[serde(default)]
    pub subtitle_font: String,

    // ── Discord Rich Presence ──────────────────────────────────────────────
    #[serde(default = "default_true")]
    pub discord_rpc_enabled: bool,
    /// When false, RPC shows only "Watching something on Aura"; titles hidden.
    #[serde(default = "default_true")]
    pub discord_rpc_show_titles: bool,
    /// Per-title hide list (case-insensitive name match). Used even when
    /// show_titles is true: lets users hide *specific* titles.
    #[serde(default)]
    pub discord_rpc_blocked_titles: Vec<String>,
    /// Show RPC for non-playback screens (Home, Library, Settings, etc.).
    /// When false, RPC only lights up while a stream is playing.
    #[serde(default = "default_true")]
    pub discord_rpc_browse_states: bool,

    // ── Window behaviours ──────────────────────────────────────────────────
    #[serde(default = "default_true")]
    pub pause_on_minimize: bool,
    #[serde(default = "default_true")]
    pub pause_on_lost_focus: bool,
    /// When the user closes the window, exit cleanly (no tray persistence).
    #[serde(default = "default_true")]
    pub close_on_exit: bool,
    /// When true, the X button hides the window to a tray icon instead of
    /// exiting. Off by default — without explicit opt-in we exit cleanly.
    #[serde(default)]
    pub minimize_to_tray_on_close: bool,

    // ── Scrobbling ─────────────────────────────────────────────────────────
    /// Optional addon URL exposing /scrobble/{type}/{id}.json (AIOMetadata).
    /// When empty, scrobble events become no-ops.
    #[serde(default)]
    pub scrobble_addon_url: String,
    /// Master switch for outbound scrobble traffic. When false NO request
    /// is sent regardless of `scrobble_addon_url` — user can keep the URL
    /// configured but pause scrobbling without re-entering it later.
    /// Default false on fresh installs; load() migrates pre-existing
    /// settings.json files (which had no toggle but a URL) by inferring
    /// enabled=true so existing scrobble flows aren't silently disabled.
    #[serde(default)]
    pub scrobble_enabled: bool,

    // ── OpenSubtitles ──────────────────────────────────────────────────────
    /// Required for api.opensubtitles.com searches & downloads. Free tier
    /// allows 20 downloads/day. Empty string = subtitle picker disabled.
    /// (Phase 6.0.5 — UI removed, the in-player OpenSubtitles search is no
    /// longer reachable; field kept for forward-compat of existing settings
    /// files.)
    #[serde(default)]
    pub opensubtitles_api_key: String,

    // ── OMDb (Rotten Tomatoes / Metacritic critic scores) ──────────────────
    /// Free-tier key for omdbapi.com. 1,000 req/day per key. Defaults to
    /// EMPTY — release builds no longer ship a shared key (it was an
    /// AGPL-licence muddle and would be revoked the moment users
    /// noticed the rate-limit). Empty string = OMDb lookups disabled
    /// silently (DetailView falls back to addon-supplied ratings + the
    /// new aggregator path). The user can paste their own free key
    /// (omdbapi.com signup is < 30s) into Settings → API Keys; that
    /// key round-trips via settings export so it follows them across
    /// installs.
    #[serde(default)]
    pub omdb_api_key: String,


    // ── Video quality ──────────────────────────────────────────────────────
    /// LEGACY HDR toggle. Pre-`hdr_mode`, this drove the HDR pipeline as a
    /// boolean: `true` switched on `target-colorspace-hint=yes +
    /// hdr-compute-peak=yes + tone-mapping=auto`, which on most SDR
    /// displays manifested as "everything looks 200% brighter while
    /// playing". Kept here only so older settings.json files migrate
    /// cleanly into `hdr_mode` on first read; new code paths read
    /// `hdr_mode` exclusively.
    #[serde(default = "default_true")]
    pub hdr_enabled: bool,

    /// HDR tone-mapping mode. Tri-state replacement for `hdr_enabled`.
    ///
    ///   • "off"          → no HDR pipeline at all (target-colorspace-hint=no,
    ///                      hdr-compute-peak=no, tone-mapping=clip). Best for
    ///                      SDR displays watching SDR content; identical to
    ///                      what users saw on the paused frame in the old
    ///                      "on" mode.
    ///   • "sdr"          → tone-map HDR sources DOWN to SDR (bt.709 / 1886,
    ///                      target-peak=203 cd/m², tone-mapping=mobius,
    ///                      hdr-compute-peak=yes). Best for SDR displays
    ///                      watching HDR content — preserves midtone
    ///                      brightness without the "boosted" look.
    ///   • "passthrough"  → send HDR signal to the display unchanged
    ///                      (target-colorspace-hint=yes, hdr-compute-peak=yes,
    ///                      tone-mapping=auto). Best for HDR-capable displays.
    ///
    /// Default "sdr": most users have SDR displays. The previous default
    /// of "yes/auto/yes" (now equivalent to passthrough) over-brightened
    /// HDR content on those displays — the symptom the user reported.
    #[serde(default = "default_hdr_mode")]
    pub hdr_mode: String,

    // ── Audio ──────────────────────────────────────────────────────────────
    /// WASAPI exclusive mode + bitstream passthrough for AVR/soundbar.
    /// Takes effect on next app restart. Default off so other audio apps
    /// keep their device access.
    #[serde(default)]
    pub audio_passthrough: bool,

    /// Last-used playback volume (0..100). Applied to every newly-loaded
    /// stream so the user's chosen level survives across titles and
    /// across app restarts. Per-title volume was never the right model —
    /// volume is a property of the user's environment, not the content.
    #[serde(default = "default_last_volume")]
    pub last_volume: f64,

    // ── Keybindings ────────────────────────────────────────────────────────
    /// Action → key code (KeyboardEvent.code, e.g. "Space", "ArrowLeft").
    /// Defaults are populated by `default_keybindings`. Users may remap any
    /// action via the Keybindings section in Settings.
    #[serde(default = "default_keybindings")]
    pub keybindings: HashMap<String, String>,

    // ── Next-up CTA ────────────────────────────────────────────────────────
    /// Seconds before episode end at which the "Next Up" CTA appears
    /// during series / anime playback. Anime episodes with detected ED
    /// chapters trigger AT the ED end as well, whichever fires first.
    /// Range clamped to [10, 300] on the frontend; 60 is the de-facto
    /// Stremio default and what the user is used to. Set to 0 to
    /// disable the CTA entirely (the user can still manually pick the
    /// next episode from the detail page).
    #[serde(default = "default_next_up_lead_seconds")]
    pub next_up_lead_seconds: u32,

    // ── Anime OP/ED skip ───────────────────────────────────────────────────
    /// "off" | "prompt" | "auto". Default "auto" — the user explicitly
    /// asked for OP skipping, and the AniSkip data set is curated.
    #[serde(default = "default_skip_op_mode")]
    pub skip_op_mode: String,
    /// "off" | "prompt" | "auto". Default "prompt" — endings often
    /// contain next-episode previews users want to watch.
    #[serde(default = "default_skip_ed_mode")]
    pub skip_ed_mode: String,
    /// "off" | "prompt" | "auto". Default "prompt" — recap segments
    /// are sometimes plot-relevant for first-time viewers.
    #[serde(default = "default_skip_recap_mode")]
    pub skip_recap_mode: String,
    /// When true, AniSkip's `mixed-op` results (recap-bundled openings)
    /// are treated as plain `op`. Default true.
    #[serde(default = "default_true")]
    pub skip_treat_mixed_op_as_op: bool,

    // ── Rendering ──────────────────────────────────────────────────────────
    /// When false, WebView2 launches with `--disable-gpu` via the
    /// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var (read at process
    /// startup in `lib.rs::run`). Default true (GPU on). Surfaced as
    /// a user-facing toggle in Settings → Performance because some
    /// systems show better scroll perf with GPU compositing off
    /// (driver-level frame-pacing issues, transparent-window DWM
    /// interaction, etc.). Restart required to take effect — settings
    /// persistence path writes the value, but the env var has to be
    /// set BEFORE the WebView spawns.
    #[serde(default = "default_true")]
    pub gpu_acceleration: bool,
    // NOTE: crash_reporting_consent + crash_reporting_dsn used to live
    // here but moved to a scope-independent sidecar at
    // `<app_data_dir>/crash-reporting.json` (see crash_reporting.rs).
    // Old settings.json files still containing them are tolerated —
    // serde ignores unknown fields by default — and the legacy values
    // are migrated forward once on first read via
    // `crash_reporting::migrate_from_legacy`.
}

fn default_theme() -> String { "mica".into() }
fn default_subtitle_language() -> String { "en".into() }
fn default_true() -> bool { true }
fn default_last_volume() -> f64 { 50.0 }
fn default_sub_font_size() -> u32 { 45 }
fn default_sub_position() -> u32 { 95 }
fn default_sub_border_size() -> u32 { 3 }
fn default_sub_color() -> String { "#FFFFFFFF".into() }
fn default_sub_back_color() -> String { "#00000000".into() }
fn default_audio_priority() -> Vec<String> { vec!["original".into(), "en".into()] }
fn default_skip_op_mode() -> String { "auto".into() }
fn default_skip_ed_mode() -> String { "prompt".into() }
fn default_skip_recap_mode() -> String { "prompt".into() }
/// Default to active SDR tone-mapping. The pre-mode default ("on" with
/// target-colorspace-hint=yes + tone-mapping=auto) brightened HDR
/// sources on SDR displays; "sdr" mode performs the same compute-peak
/// detection but compresses highlights via mobius so midtones stay
/// natural. Users with HDR displays can pick "passthrough" in Settings.
fn default_hdr_mode() -> String { "sdr".into() }
/// 60 s matches Stremio's Next-Up timing — empirically this gives
/// users enough time to react during the credits without being so
/// early it covers the climax of the episode body.
fn default_next_up_lead_seconds() -> u32 { 45 }

/// Default action → binding-spec mapping for the player. Action names are
/// stable identifiers consumed by `useKeybindings.ts`; values follow the
/// chord grammar `[Modifier+]*Code` (e.g. "Space", "Ctrl+Digit1").
/// Modifier-less entries are plain `KeyboardEvent.code` values for full
/// back-compat with previously-saved settings.json files.
pub fn default_keybindings() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("toggle-pause".into(),    "Space".into());
    m.insert("seek-back".into(),       "ArrowLeft".into());
    m.insert("seek-forward".into(),    "ArrowRight".into());
    m.insert("volume-up".into(),       "ArrowUp".into());
    m.insert("volume-down".into(),     "ArrowDown".into());
    m.insert("toggle-osd".into(),      "Backquote".into());
    m.insert("cycle-shader".into(),    "KeyS".into());
    m.insert("toggle-subtitles".into(),"KeyV".into());
    m.insert("fullscreen".into(),      "KeyF".into());
    // Panscan toggle (off ↔ 1.0). 1.0 = zoom-and-crop the video to fill
    // the viewport on its constrained axis — what ultrawide users want
    // for 16:9 content and 16:9 users want for 21:9 content. KeyZ is
    // unused by other defaults and matches the convention used by
    // standalone mpv's input.conf for "zoom-style" toggles.
    m.insert("toggle-panscan".into(),  "KeyZ".into());
    // Anime4K v4 chord defaults — match the Stremio Community v5
    // bindings the user is migrating from. Ctrl+0 disables upscaling
    // entirely (sets profile 0 / "None").
    m.insert("anime4k-a".into(),       "Ctrl+Digit1".into());
    m.insert("anime4k-b".into(),       "Ctrl+Digit2".into());
    m.insert("anime4k-c".into(),       "Ctrl+Digit3".into());
    m.insert("anime4k-aa".into(),      "Ctrl+Digit4".into());
    m.insert("anime4k-bb".into(),      "Ctrl+Digit5".into());
    m.insert("anime4k-cc".into(),      "Ctrl+Digit6".into());
    m.insert("anime4k-none".into(),    "Ctrl+Digit0".into());
    m
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme:                       default_theme(),
            subtitle_language:           default_subtitle_language(),
            selectable_subtitle_languages: Vec::new(),
            discord_rpc_enabled:         true,
            discord_rpc_show_titles:     true,
            discord_rpc_blocked_titles:  Vec::new(),
            discord_rpc_browse_states:   true,
            pause_on_minimize:           true,
            pause_on_lost_focus:         true,
            close_on_exit:               true,
            minimize_to_tray_on_close:   false,
            scrobble_addon_url:          String::new(),
            scrobble_enabled:            false,
            opensubtitles_api_key:       String::new(),
            omdb_api_key:                String::new(),
            hdr_enabled:                 true,
            hdr_mode:                    default_hdr_mode(),
            next_up_lead_seconds:        default_next_up_lead_seconds(),
            audio_passthrough:           false,
            last_volume:                 default_last_volume(),
            subtitle_font_size:          default_sub_font_size(),
            subtitle_position:           default_sub_position(),
            subtitle_border_size:        default_sub_border_size(),
            subtitle_color:              default_sub_color(),
            subtitle_back_color:         default_sub_back_color(),
            subtitle_font:               String::new(),
            audio_priority:              default_audio_priority(),
            avoid_dubs:                  false,
            user_region:                 String::new(),
            keybindings:                 default_keybindings(),
            skip_op_mode:                default_skip_op_mode(),
            skip_ed_mode:                default_skip_ed_mode(),
            skip_recap_mode:             default_skip_recap_mode(),
            skip_treat_mixed_op_as_op:   true,
            gpu_acceleration:            true,
        }
    }
}

// ---------------------------------------------------------------------------
// In-memory cache so high-traffic readers (window event handlers) don't have
// to hit disk. The cache is the source of truth during a session; disk is
// only used to persist on writes.
// ---------------------------------------------------------------------------

static CACHE: OnceLock<Arc<Mutex<AppSettings>>> = OnceLock::new();

fn cache() -> &'static Arc<Mutex<AppSettings>> {
    CACHE.get_or_init(|| Arc::new(Mutex::new(AppSettings::default())))
}

pub fn snapshot() -> AppSettings {
    cache().lock().unwrap().clone()
}

// ---------------------------------------------------------------------------
// Active scope ("guest" or a per-account identifier).
//
// The scope decides which `<scope>.json` file is the source of truth at any
// given time. It changes on login / logout / guest-mode entry — the
// frontend invokes `set_settings_scope` after auth state changes; the
// backend startup hook also seeds it from the persisted session so MPV
// init doesn't pick up the wrong config on first paint.
// ---------------------------------------------------------------------------

const GUEST_SCOPE: &str = "guest";

static ACTIVE_SCOPE: OnceLock<Mutex<String>> = OnceLock::new();

fn scope_lock() -> &'static Mutex<String> {
    ACTIVE_SCOPE.get_or_init(|| Mutex::new(GUEST_SCOPE.to_string()))
}

fn current_scope() -> String {
    scope_lock().lock().unwrap().clone()
}

/// Derive a stable per-account scope id from a Stremio auth_key. We hash
/// the prefix so the resulting filename never leaks the credential into
/// the user's filesystem; 12 hex chars is plenty to collision-proof
/// realistic install bases.
pub fn scope_from_auth_key(auth_key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    auth_key.hash(&mut hasher);
    format!("user-{:016x}", hasher.finish())
}

// ---------------------------------------------------------------------------
// Pre-init load — reads settings WITHOUT an AppHandle. Used by `lib.rs::run`
// before the Tauri builder runs (e.g. to pick up the `gpu_acceleration`
// flag and stamp the WebView2 launch env var). Falls back to defaults on
// any error since we're running before our normal logging is up — losing a
// pre-init read here just means the app starts with default settings,
// which is the same as a fresh install.
//
// Walks every scope file under `%APPDATA%\com.aura.app\settings\*.json`
// and OR's the gpu_acceleration flag across them: if ANY scope has it
// off, treat the launch as off. GPU acceleration is a hardware-level
// setting that doesn't make sense to vary per Stremio account, so a
// conservative "any-user-said-no" approach is appropriate.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn pre_init_settings_root() -> Option<PathBuf> {
    let appdata = std::env::var("APPDATA").ok()?;
    Some(PathBuf::from(appdata).join("com.aura.app").join("settings"))
}

#[cfg(not(target_os = "windows"))]
fn pre_init_settings_root() -> Option<PathBuf> {
    // Best-effort cross-platform fallback. dirs crate would be nicer
    // but we don't depend on it; the gpu-acceleration toggle is
    // primarily for Windows where the WebView2 / DWM compositor
    // interaction is the main culprit.
    if cfg!(target_os = "macos") {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join("Library").join("Application Support").join("com.aura.app").join("settings"))
    } else {
        let home = std::env::var("HOME").ok()?;
        Some(PathBuf::from(home).join(".config").join("com.aura.app").join("settings"))
    }
}

/// Load the most permissive settings snapshot we can without an
/// AppHandle. Walks every *.json under the settings dir; if ANY
/// declares gpu_acceleration=false, returns a snapshot with that
/// flag off. Used for pre-WebView env var setup only — runtime
/// reads still go through the AppHandle-aware `load()`.
pub fn load_pre_init() -> Result<AppSettings, String> {
    let root = pre_init_settings_root().ok_or("settings dir unresolvable")?;
    if !root.exists() {
        return Ok(AppSettings::default());
    }
    let mut any_gpu_off = false;
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(parsed) = serde_json::from_str::<AppSettings>(&text) {
                    if !parsed.gpu_acceleration {
                        any_gpu_off = true;
                        break;
                    }
                }
            }
        }
    }
    let mut s = AppSettings::default();
    if any_gpu_off {
        s.gpu_acceleration = false;
    }
    Ok(s)
}

// ---------------------------------------------------------------------------
// Filesystem layout
// ---------------------------------------------------------------------------

fn settings_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("settings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let scope = current_scope();
    Ok(settings_dir(app)?.join(format!("{scope}.json")))
}

fn legacy_settings_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    // The pre-scope layout: a single settings.json at the app_data root.
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/// Load the active scope's settings into the cache. Returns the resolved
/// settings.
///
/// Failure modes:
///   • file missing            → use defaults (first-run, no migration).
///   • file empty              → use defaults (treat zero-byte as missing).
///   • file present, bad JSON  → BACKUP the bad file with a timestamped
///                                suffix, KEEP the existing cache. Returning
///                                defaults here would let the next save
///                                overwrite the (recoverable) file with
///                                defaults — exactly the bug that caused
///                                user-set fields to reset under the old
///                                layout.
pub fn load<R: Runtime>(app: &AppHandle<R>) -> AppSettings {
    let Ok(path) = settings_path(app) else {
        return snapshot();
    };

    // ── One-time migration from legacy single-file layout. ──
    // If the per-scope file doesn't exist BUT the legacy settings.json
    // does, copy it forward into the current scope so the user keeps
    // their settings on first run after this refactor.
    if !path.exists() {
        if let Ok(legacy) = legacy_settings_path(app) {
            if legacy.exists() {
                if let Ok(text) = std::fs::read_to_string(&legacy) {
                    let _ = std::fs::write(&path, &text);
                }
            }
        }
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            // No file (first run for this scope) — keep cache at defaults
            // unless something else is already loaded for it.
            return snapshot();
        }
    };

    if raw.trim().is_empty() {
        return snapshot();
    }

    match serde_json::from_str::<AppSettings>(&raw) {
        Ok(mut parsed) => {
            // Merge any newly-added default keybinding actions into
            // the user's saved map. `#[serde(default = ...)]` only
            // applies when the field is MISSING from JSON; if the
            // user's settings.json predates a new action (e.g. the
            // anime4k-a..cc / anime4k-none entries we added later),
            // the field exists but is missing those keys. Without
            // this merge, users had to manually rebind every new
            // action — the symptom that surfaced "Anime4K shader
            // binds don't have a default set."
            //
            // Only ADDS missing keys; never overwrites a user's
            // existing binding. If we filled any in, persist the
            // settings so subsequent loads see the merged map and
            // the user's settings.json reflects what they're using.
            let defaults = default_keybindings();
            let mut merged_any = false;
            for (action, default_spec) in defaults {
                if !parsed.keybindings.contains_key(&action) {
                    parsed.keybindings.insert(action, default_spec);
                    merged_any = true;
                }
            }

            // Scrobble enabled-flag migration: pre-existing settings.json
            // files predate the toggle and have no `scrobble_enabled` key.
            // Serde's #[serde(default)] gives us `false` for both "field
            // absent" and "field explicitly false", so we re-parse the
            // raw JSON as a Value to distinguish them. If the field was
            // genuinely absent AND a URL is configured, infer enabled=true
            // so existing scrobble flows aren't silently disabled by the
            // upgrade. Save the inferred value so future loads see it.
            let raw_value: serde_json::Value =
                serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
            let scrobble_enabled_explicit =
                raw_value.get("scrobble_enabled").is_some();
            if !scrobble_enabled_explicit
                && !parsed.scrobble_addon_url.trim().is_empty()
                && !parsed.scrobble_enabled
            {
                parsed.scrobble_enabled = true;
                merged_any = true;
            }

            *cache().lock().unwrap() = parsed.clone();
            if merged_any {
                let _ = save(app, &parsed);
            }
            parsed
        }
        Err(e) => {
            crate::devlog!(
                warn, "settings",
                "failed to parse {} ({e}); preserving in-memory cache",
                path.display()
            );
            // Backup the bad file so the user / a later session can recover
            // by hand. The destination filename is stamped by the system
            // clock so concurrent failures don't overwrite each other.
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = path.with_extension(format!("json.bad-{stamp}"));
            let _ = std::fs::rename(&path, &backup);
            snapshot()
        }
    }
}

/// Atomic save: write to <path>.tmp, fsync, rename onto <path>. A crash
/// or power loss between any two steps leaves the previous good file
/// intact instead of corrupting it.
pub fn save<R: Runtime>(app: &AppHandle<R>, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    *cache().lock().unwrap() = settings.clone();
    Ok(())
}

// ---------------------------------------------------------------------------
// Scope switching
// ---------------------------------------------------------------------------

/// Switch the active scope. Flushes the current cache to the OLD scope's
/// file (so any unsaved changes survive) before swapping `ACTIVE_SCOPE`
/// and loading the new scope's settings into the cache.
///
/// Idempotent: if the requested scope is already active, returns a fresh
/// snapshot without re-touching disk.
pub fn set_active_scope<R: Runtime>(
    app: &AppHandle<R>,
    new_scope: &str,
) -> Result<AppSettings, String> {
    let new_scope = if new_scope.trim().is_empty() {
        GUEST_SCOPE.to_string()
    } else {
        new_scope.to_string()
    };

    {
        let mut active = scope_lock().lock().unwrap();
        if *active == new_scope {
            return Ok(snapshot());
        }

        // Persist the cache under the OLD scope so the user's last edits
        // survive the swap. Best-effort: a failure here means the OLD
        // scope keeps whatever the previous save wrote, which is still
        // safer than losing what's in memory silently.
        let old_path = settings_dir(app)?.join(format!("{}.json", *active));
        let cache_snapshot = cache().lock().unwrap().clone();
        if let Ok(text) = serde_json::to_string_pretty(&cache_snapshot) {
            let tmp = old_path.with_extension("json.tmp");
            if let Ok(mut f) = std::fs::File::create(&tmp) {
                use std::io::Write;
                if f.write_all(text.as_bytes()).is_ok() && f.sync_all().is_ok() {
                    let _ = std::fs::rename(&tmp, &old_path);
                }
            }
        }

        *active = new_scope.clone();
    }

    Ok(load(app))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn get_settings<R: Runtime>(app: AppHandle<R>) -> AppSettings {
    load(&app)
}

/// Validates and persists the theme. Unknown themes are rejected so the
/// frontend can't drift the stored value to something the CSS won't render.
#[tauri::command]
pub async fn set_theme<R: Runtime>(app: AppHandle<R>, theme: String) -> Result<(), String> {
    if !matches!(theme.as_str(), "mica" | "glass" | "midnight") {
        return Err(format!("Unknown theme: {theme}"));
    }
    let mut s = snapshot();
    s.theme = theme;
    save(&app, &s)
}

/// Patch any subset of settings — used by the Settings page.
///
/// CRITICAL: the base for the merge is the in-memory CACHE, never a fresh
/// disk re-read. The legacy implementation re-loaded from disk for every
/// patch and silently fell back to `AppSettings::default()` when the file
/// was momentarily unreadable (post-crash, mid-rename, etc.) — so the
/// next save would clobber every user-set field with defaults except for
/// the keys in the current patch. The cache is always coherent because
/// every successful save writes through it.
#[tauri::command]
pub async fn update_settings<R: Runtime>(
    app: AppHandle<R>,
    patch: serde_json::Value,
) -> Result<AppSettings, String> {
    let mut current =
        serde_json::to_value(snapshot()).map_err(|e| e.to_string())?;

    if let (Some(target), Some(updates)) = (current.as_object_mut(), patch.as_object()) {
        for (k, v) in updates {
            target.insert(k.clone(), v.clone());
        }
    }

    let next: AppSettings =
        serde_json::from_value(current).map_err(|e| format!("Invalid settings patch: {e}"))?;

    if !matches!(next.theme.as_str(), "mica" | "glass" | "midnight") {
        return Err(format!("Unknown theme: {}", next.theme));
    }

    save(&app, &next)?;
    Ok(next)
}

/// Reset every backend setting to its defaults — wipes theme, audio /
/// subtitle prefs, keybindings, Discord toggles, skip-mode toggles,
/// scrobble URL, etc. Persists the cleared `AppSettings` to disk and
/// returns the new (default) snapshot. Frontend should also clear its
/// own localStorage-backed AuraSettings to fully reset; the backend
/// can't reach that side from here.
#[tauri::command]
pub async fn reset_settings<R: Runtime>(
    app: AppHandle<R>,
) -> Result<AppSettings, String> {
    let next = AppSettings::default();
    save(&app, &next)?;
    Ok(next)
}

/// Switch which "scope" the settings file is stored under. Called by the
/// frontend after any auth state change — login (scope = derived from
/// auth_key), logout (scope = "guest"), guest-mode entry from the
/// landing screen (scope = "guest").
#[tauri::command]
pub async fn set_settings_scope<R: Runtime>(
    app: AppHandle<R>,
    auth_key: Option<String>,
) -> Result<AppSettings, String> {
    let scope = match auth_key {
        Some(k) if !k.trim().is_empty() => scope_from_auth_key(&k),
        _ => GUEST_SCOPE.to_string(),
    };
    crate::devlog!(info, "settings", "switching scope → {scope}");
    set_active_scope(&app, &scope)
}
