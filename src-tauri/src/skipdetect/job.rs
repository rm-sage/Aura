// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/job.rs
//
// One detect, end to end: result cache -> probe -> HEAD -> TAIL, with the
// AnimeThemes theme list fetched beside the probe and the top-ranked theme of
// each kind prefetched while HEAD decodes. Independent of Tauri (the command
// in mod.rs wraps it), so the ignored runtime test drives exactly this code.
//
// Order and budget (spec "Scheduling, bandwidth, cancellation"):
//   * probe, HEAD and TAIL run strictly one after another, and a process-wide
//     one-permit semaphore guarantees at most ONE detector ffmpeg against the
//     stream at any time, across detects too (mpv's own connection and the
//     hover-thumbnail instance make the rest of the budget; debrid hosts
//     answered 429 above about 5);
//   * TAIL starts the moment HEAD exits (early exit or region end). When HEAD
//     ran to its end, the OP decision (a further theme download, the
//     sibling-cour lookup, Layer 3) runs BESIDE the TAIL pass on a forked
//     `Decider` and publishes the moment it resolves, instead of holding
//     TAIL back by its AnimeThemes round trips;
//   * theme downloads go to AnimeThemes, never the stream host, and overlap.
//
// CPU: each region's fingerprint, RMS meter and incremental matching run on a
// blocking-pool worker fed over a bounded channel; every full-region theme
// evaluation and Layer 3 run in `spawn_blocking`. Nothing runs on the mpv
// engine thread and nothing polls mpv.
//
// Cancellation is the caller's: dropping this future (an aborted task) drops
// the region pass (kill_on_drop kills ffmpeg) and the theme JoinSet (aborts
// in-flight downloads). Stale results are discarded by the caller's
// generation check before anything is published.

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, Semaphore};
use tokio::task::JoinSet;

use super::animethemes::{self, ThemeRec};
use super::audio::{self, RegionPass};
use super::cache::{self, ThemeFp};
use super::continuity::{self, Region, RmsMeter, Silence};
use super::fingerprint::{Fingerprint, Fingerprinter, SR};
use super::matcher::{self, EarlyEvent, EarlyRef, EarlyTracker, MatchSchedule, ThemeMatch};
use super::probe;
use super::themes::{self, Kind, Step, ThemeMeta};

/// At most one detector ffmpeg against the stream, process-wide.
static PASS_GATE: Semaphore = Semaphore::const_new(1);

/// Validated, bounded input of one detect.
#[derive(Clone, Debug, Deserialize)]
pub struct Request {
    /// The stream mpv plays (http / https only).
    pub url: String,
    /// mpv's external audio track, when LoadFile had one: analysed instead.
    #[serde(default)]
    pub audio_url: Option<String>,
    /// Stremio id (`tt14986406:3:1`, `kitsu:...`).
    pub stremio_id: String,
    /// "series", "movie", "anime".
    #[serde(default)]
    pub media_type: Option<String>,
    /// Addon label, for logs only.
    #[serde(default)]
    pub addon: Option<String>,
    /// Release identity: the stream's `behaviorHints.filename`.
    #[serde(default)]
    pub release: Option<String>,
    /// mpv's `duration` (the container duration).
    pub duration: f64,
    /// Cour MAL id and where it came from ("aiometadata", "anilist", "aniskip").
    #[serde(default)]
    pub mal_id: Option<u32>,
    #[serde(default)]
    pub mal_source: Option<String>,
    /// Episode number within the MAL cour (orders themes; never a gate).
    #[serde(default)]
    pub mal_episode: Option<u32>,
    /// The title is anime (drives the "no themes" counter only).
    #[serde(default)]
    pub anime: bool,
    /// Sibling cours to try when the cour's own themes match nothing. None =
    /// resolve sequel / prequel through MyAnimeList relations.
    #[serde(default)]
    pub sibling_mal_ids: Option<Vec<u32>>,
    /// Which kinds the caller wants (HEAD is skipped without OP, TAIL without ED).
    /// On the wire these are `detect_op` / `detect_ed`: the action enum is
    /// tagged `op` (`{op: "detect", ...}`), so a field named `op` could never
    /// arrive (a JS object cannot carry the key twice) and silently defaulted.
    #[serde(default = "yes", rename = "detect_op")]
    pub op: bool,
    #[serde(default = "yes", rename = "detect_ed")]
    pub ed: bool,
}

fn yes() -> bool {
    true
}

impl Request {
    /// Reject anything that is not a plain remote stream and bound the rest.
    pub fn validate(mut self) -> Result<Self, String> {
        fn remote(u: &str) -> bool {
            (u.starts_with("http://") || u.starts_with("https://")) && u.len() <= 8192 && !u.chars().any(char::is_whitespace)
        }
        if !remote(&self.url) {
            return Err("only http(s) streams are analysed".into());
        }
        if let Some(a) = &self.audio_url {
            if !remote(a) {
                return Err("only http(s) audio tracks are analysed".into());
            }
        }
        if !(self.duration.is_finite() && self.duration > 0.0 && self.duration < 6.0 * 3600.0) {
            return Err("duration out of range".into());
        }
        let clean = |s: &str, n: usize| -> String {
            let s: String = s.chars().filter(|c| !c.is_control()).take(n).collect();
            if s.contains("://") {
                "<redacted>".into()
            } else {
                s
            }
        };
        self.stremio_id = clean(&self.stremio_id, 160);
        if self.stremio_id.is_empty() {
            return Err("missing stremio id".into());
        }
        self.media_type = self.media_type.as_deref().map(|m| clean(m, 24));
        self.addon = self.addon.as_deref().map(|m| clean(m, 60));
        self.release = self.release.as_deref().map(|r| r.chars().filter(|c| !c.is_control()).take(300).collect());
        self.mal_source = self.mal_source.as_deref().map(|m| clean(m, 24));
        self.mal_id = self.mal_id.filter(|&m| m > 0);
        self.mal_episode = self.mal_episode.filter(|&e| e > 0 && e < 100_000);
        if let Some(s) = &mut self.sibling_mal_ids {
            s.retain(|&m| m > 0 && Some(m) != self.mal_id);
            s.truncate(animethemes::MAX_SIBLINGS);
        }
        Ok(self)
    }

    /// Release identity for the result cache: the filename, else the URL's
    /// final path segment (no query). None = do not cache.
    pub fn release_identity(&self) -> Option<String> {
        if let Some(r) = self.release.as_deref().map(str::trim).filter(|r| !r.is_empty()) {
            return Some(r.to_string());
        }
        let u = url::Url::parse(self.audio_url.as_deref().unwrap_or(&self.url)).ok()?;
        let seg = u.path_segments()?.rev().find(|s| !s.is_empty())?.to_string();
        (!seg.is_empty()).then_some(seg)
    }

    fn who(&self) -> String {
        format!(
            "{}{}/{}",
            self.addon.as_deref().map(|a| format!("{a} ")).unwrap_or_default(),
            self.media_type.as_deref().unwrap_or("?"),
            self.stremio_id
        )
    }
}

/// Warm the theme caches for a cour BEFORE it plays: the episode Next-Up
/// pre-resolved. Fetches the AnimeThemes list and the top-ranked theme of each
/// wanted kind (exactly what a detect prefetches first), so the next episode's
/// match needs no theme download. Never touches the episode's stream.
#[derive(Clone, Debug, Deserialize)]
pub struct PrefetchRequest {
    pub mal_id: u32,
    /// Episode within the MAL cour (orders themes; never a gate).
    #[serde(default)]
    pub mal_episode: Option<u32>,
    /// Same wire names as Detect (the action enum is tagged `op`).
    #[serde(default = "yes", rename = "detect_op")]
    pub op: bool,
    #[serde(default = "yes", rename = "detect_ed")]
    pub ed: bool,
}

impl PrefetchRequest {
    pub fn validate(mut self) -> Result<Self, String> {
        if self.mal_id == 0 {
            return Err("missing MAL id".into());
        }
        if !(self.op || self.ed) {
            return Err("no kind wanted".into());
        }
        self.mal_episode = self.mal_episode.filter(|&e| e > 0 && e < 100_000);
        Ok(self)
    }
}

/// What a prefetch did, per wanted kind: the theme label and whether it was
/// downloaded (false = already cached), or why there was none.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrefetchOutcome {
    pub themes: Vec<(String, bool)>,
    pub note: Option<String>,
}

/// The theme indices a detect for `(list, ep)` would prefetch first: the
/// top-ranked candidate of each wanted kind.
pub fn prefetch_targets(list: &[ThemeRec], mal: u32, ep: Option<u32>, op: bool, ed: bool) -> Vec<usize> {
    let metas: Vec<ThemeMeta> = list.iter().map(|r| r.meta(mal)).collect();
    let mut out = Vec::new();
    for (want, kind) in [(op, Kind::Op), (ed, Kind::Ed)] {
        if want {
            if let Some(&i) = themes::candidate_order(&metas, kind, ep).first() {
                out.push(i);
            }
        }
    }
    out
}

/// Run one prefetch (theme list + fingerprints; the audio is never kept).
pub async fn prefetch(ffmpeg: &std::ffi::OsStr, data_dir: &std::path::Path, req: &PrefetchRequest) -> PrefetchOutcome {
    let mut out = PrefetchOutcome::default();
    let list = match animethemes::theme_list(Some(data_dir), req.mal_id).await {
        Ok(l) => l,
        Err(e) => {
            out.note = Some(format!("animethemes unavailable ({})", e.0));
            return out;
        }
    };
    if list.is_empty() {
        out.note = Some("no themes listed".into());
        return out;
    }
    for i in prefetch_targets(&list, req.mal_id, req.mal_episode, req.op, req.ed) {
        let rec = &list[i];
        match animethemes::load_theme_fp(ffmpeg, Some(data_dir), rec).await {
            Ok((_, downloaded)) => out.themes.push((rec.label(), downloaded)),
            Err(e) => out.note = Some(format!("{}: {e}", rec.label())),
        }
    }
    out
}

/// Run the REAL detect on the stream Next-Up pre-resolved for the next
/// episode, in the background, so its final result is in the result cache
/// when that episode plays (`prescan`). The same fields and wire names as
/// `Request` minus `duration`: the pre-scan takes it from its own probe
/// (ffmpeg's container `Duration:`), and a live detect of the same file later
/// finds the entry through `lookup_result`'s one-neighbour tolerance.
#[derive(Clone, Debug, Deserialize)]
pub struct PrescanRequest {
    pub url: String,
    pub stremio_id: String,
    #[serde(default)]
    pub media_type: Option<String>,
    #[serde(default)]
    pub addon: Option<String>,
    #[serde(default)]
    pub release: Option<String>,
    #[serde(default)]
    pub mal_id: Option<u32>,
    #[serde(default)]
    pub mal_source: Option<String>,
    #[serde(default)]
    pub mal_episode: Option<u32>,
    #[serde(default)]
    pub anime: bool,
    /// Same wire names as Detect (the action enum is tagged `op`).
    #[serde(default = "yes", rename = "detect_op")]
    pub op: bool,
    #[serde(default = "yes", rename = "detect_ed")]
    pub ed: bool,
}

/// The duration a validated pre-scan carries until its probe answers: any
/// value `Request::validate` accepts (it is replaced before the job runs).
const PRESCAN_PLACEHOLDER_DURATION: f64 = 1.0;

impl PrescanRequest {
    /// `Request`'s rules (http(s) only, bounds, cleaning), plus a MAL id and
    /// at least one kind: a pre-scan without Layer 1 would only spend the
    /// next file's bandwidth on Layer 3. The `Request` it returns carries a
    /// placeholder duration; `prescan` sets the probe's before running.
    pub fn validate(self) -> Result<Request, String> {
        let r = Request {
            url: self.url,
            audio_url: None,
            stremio_id: self.stremio_id,
            media_type: self.media_type,
            addon: self.addon,
            release: self.release,
            duration: PRESCAN_PLACEHOLDER_DURATION,
            mal_id: self.mal_id,
            mal_source: self.mal_source,
            mal_episode: self.mal_episode,
            anime: self.anime,
            sibling_mal_ids: None,
            op: self.op,
            ed: self.ed,
        }
        .validate()?;
        if r.mal_id.is_none() {
            return Err("missing MAL id".into());
        }
        if !(r.op || r.ed) {
            return Err("no kind wanted".into());
        }
        Ok(r)
    }
}

/// How a pre-scan ended. Wire: snake_case (`"done"`, `"cached"`, ...).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrescanOutcome {
    /// Ran to the end (its result is in the cache when it was cacheable).
    Done,
    /// The result cache (or this session's pre-scan record) already answers it.
    Cached,
    /// A live Detect started and aborted it; it may be retried later.
    Preempted,
    /// `prescan_cancel`, a page reload, a storage clear, or a newer pre-scan.
    Cancelled,
    /// A live detect is running: not started.
    Busy,
    /// Could not run (no ffmpeg, no data dir, invalid request, probe failed,
    /// no container duration, no release identity to key a result by).
    Unavailable,
}

/// What `prescan` returns: the outcome, a note (never a URL), the final
/// snapshot when the job ran, and whether that result was written.
#[derive(Clone, Debug)]
pub struct PrescanResult {
    pub outcome: PrescanOutcome,
    pub note: Option<String>,
    pub snapshot: Option<Snapshot>,
    pub stored: bool,
}

/// One pre-scan, end to end: probe once (under the pass gate, at the
/// context's priority), key the request by the probe's container duration,
/// then the unchanged `run` with that probe handed in (`Ctx::pre_probe`), so
/// the stream is opened for the probe exactly once. `req` comes from
/// `PrescanRequest::validate`. The caller's `ctx` should publish nowhere and
/// carry generation 0: nothing a pre-scan finds reaches the player.
/// Cancellation is the caller's, as for `run`: dropping this future releases
/// the gate and kills ffmpeg, and an aborted run writes nothing.
pub async fn prescan(mut ctx: Ctx, mut req: Request) -> PrescanResult {
    let unavailable = |note: String| PrescanResult {
        outcome: PrescanOutcome::Unavailable,
        note: Some(note),
        snapshot: None,
        stored: false,
    };
    // Every log line of the job carries the marker (`who` starts with the addon).
    req.addon = Some(match req.addon.take() {
        Some(a) => format!("prescan {a}"),
        None => "prescan".into(),
    });
    let who = req.who();
    if ctx.data_dir.is_none() {
        return unavailable("no data directory".into());
    }
    if req.release_identity().is_none() {
        return unavailable("no release identity to key a result by".into());
    }
    crate::devlog!(
        info, "skipdetect",
        "{who} next-episode prescan start, mal {} ({}), ep {}",
        req.mal_id.map_or("-".to_string(), |m| m.to_string()),
        req.mal_source.as_deref().unwrap_or("-"),
        req.mal_episode.map_or("-".to_string(), |e| e.to_string()),
    );
    let input = req.audio_url.clone().unwrap_or_else(|| req.url.clone());
    // Tests only: a replay's recorded probe, as `run` uses it.
    #[cfg(test)]
    let replayed = ctx.replay.as_ref().map(|r| r.probe.clone());
    #[cfg(not(test))]
    let replayed: Option<probe::ProbeInfo> = None;
    let probe = match replayed {
        Some(p) => Ok(p),
        None => {
            // Released before `run` starts: its passes take the gate per pass.
            let Ok(_permit) = PASS_GATE.acquire().await else {
                return unavailable("pass gate closed".into());
            };
            audio::run_probe_with(&ctx.ffmpeg, &input, ctx.background).await
        }
    };
    let probe = match probe {
        Ok(p) => p,
        Err(e) => return unavailable(e.note()),
    };
    let Some(c) = probe.container_duration.filter(|c| c.is_finite() && *c > 0.0 && *c < 6.0 * 3600.0) else {
        return unavailable("probe found no container duration".into());
    };
    req.duration = c;
    let req = match req.validate() {
        Ok(r) => r,
        Err(e) => return unavailable(e),
    };
    ctx.pre_probe = Some(probe);
    let (snap, stored) = run_stored(&ctx, &req).await;
    let outcome = if snap.from_cache { PrescanOutcome::Cached } else { PrescanOutcome::Done };
    let note = (outcome == PrescanOutcome::Done && !stored).then(|| "result not cacheable; not stored".to_string());
    PrescanResult { outcome, note, snapshot: Some(snap), stored }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    #[default]
    Idle,
    Running,
    Done,
    Cancelled,
    /// The detect could not run at all (no ffmpeg, bad input).
    Unavailable,
}

/// What Layer 1 (the AnimeThemes theme match) concluded for one kind. The
/// frontend reads it to decide how far to trust the CROWD windows of that kind
/// (AniSkip, IntroDB, PublicMetaDB): it holds them prompt-only while Layer 1 is
/// still `Pending` (a crowd opening at 0-90 s auto-skipped 89 s of JJK S2E10's
/// cold open before the theme match, which placed the real opening at 183 s,
/// could drop it) and keeps them prompt-only after an `Informative` abstain.
/// Structured so no consumer ever parses a note string.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum L1State {
    /// A cached result written before this field existed. Such an entry
    /// answers no request (`cached_serves`): it may also predate the
    /// Transition-only ED rule, so it is detected again instead.
    #[default]
    Unknown,
    /// The kind was not asked for (or the result answers a narrower request).
    NotRequested,
    /// The detect is running and has not decided this kind yet.
    Pending,
    /// A Layer 1 window (any of its sources) stands for the kind.
    Matched,
    /// The cour HAS themes of this kind and none matched this file (every
    /// candidate loaded, and one of the cour's own was really compared): the
    /// kind's crowd windows stay prompt-only, guesses of the kind are dropped.
    Informative,
    /// No theme of this kind to look for (no MAL id, or the cour lists none):
    /// Layer 1 cannot judge the crowd, so it is trusted as before.
    NoThemes,
    /// Layer 1 could not decide (AnimeThemes down, a theme that failed to
    /// load, themes too short for the run gate, the download cap, a failed or
    /// cancelled region, no audio): the crowd is trusted as before.
    Unavailable,
}

/// Source of the early provisional opening: a PROMPT published once the theme's
/// first 12 s matched, replaced by the full match or withdrawn. Never
/// auto-eligible, never cached, and (frontend) never Layer 1: it does not drop
/// other sources' windows.
pub const EARLY_SOURCE: &str = "animethemes-early";

/// A published window. Field names are the wire names (no serde renames).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WindowOut {
    pub start: f64,
    pub end: f64,
    /// "animethemes" (Layer 1), "animethemes-early" (the provisional opening,
    /// EARLY_SOURCE) or "continuity" (Layer 3).
    pub source: String,
    /// False for Layer 3, for an "Over" theme (an OP, or an ED whose audio
    /// also has a clean video) and for a Transition-only ED (see `transition`).
    pub auto_eligible: bool,
    /// Layer 1 ED whose theme is Transition-only in AnimeThemes (every video
    /// using its audio starts over episode content): the matched START is the
    /// song's start, not necessarily the ending's (Cowboy Bebop 13's "Space
    /// Lion" starts 280 s inside the story). The END is trusted. The frontend
    /// stamps it under its own prompt-only source and lets a chapter or crowd
    /// ED whose end agrees outrank it.
    #[serde(default)]
    pub transition: bool,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub run_s: Option<f64>,
    #[serde(default)]
    pub ber: Option<f64>,
    #[serde(default)]
    pub margin: Option<f64>,
    #[serde(default)]
    pub soft42: Option<f64>,
    #[serde(default)]
    pub q35: Option<f64>,
    #[serde(default)]
    pub mrel: Option<f64>,
    /// A Layer 1 window whose edges went through the edge rule WITH its
    /// region's RMS levels (`published_window` after the region finished, or
    /// a cached final result). False for a streaming acceptance, whose end is
    /// still mapping A's: those windows ran up to 1.8 s past the real edge in
    /// the corpora (Bleach (2004) 266's opening, the preview overruns), so the
    /// frontend shows them below its top confidence level until refined.
    #[serde(default)]
    pub refined: bool,
}

/// What a detect knows so far; published on every change and returned at the end.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub generation: u64,
    pub state: JobState,
    pub from_cache: bool,
    pub op: Option<WindowOut>,
    pub ed: Option<WindowOut>,
    /// Why a kind has no window (abstentions are precision, not errors).
    pub op_note: Option<String>,
    pub ed_note: Option<String>,
    /// What Layer 1 concluded per kind (see `L1State`).
    #[serde(default)]
    pub op_l1: L1State,
    #[serde(default)]
    pub ed_l1: L1State,
    /// The audio Layer 1 actually searched for each kind, in media seconds:
    /// HEAD from 0 to the end it decoded (origin + samples / 11025, capped at
    /// `HEAD_SECS`), TAIL from its origin to the final media end. None until
    /// that region has run. The frontend applies a Layer 1 abstain (or a
    /// pending hold) only to crowd rows that overlap this audio: a theme
    /// outside it was never looked for.
    #[serde(default)]
    pub op_region: Option<(f64, f64)>,
    #[serde(default)]
    pub ed_region: Option<(f64, f64)>,
    /// Last decoded audio: TAIL origin + samples / 11025 once TAIL reached EOF
    /// (`media_end_final`), before that the mapped track's DURATION tag, else
    /// the container duration. Never ffmpeg's `time=` line.
    pub media_end: Option<f64>,
    pub media_end_final: bool,
    /// The mapped audio track's mkv DURATION tag, as the probe read it (None
    /// without a tag, e.g. mp4). Matched the final media end within 0.012 s on
    /// every measured release, so the end-of-stream detectors may use it
    /// before (or without) a TAIL read; the container duration never is.
    #[serde(default)]
    pub media_end_probe: Option<f64>,
    /// What the request that produced this result asked for. The result cache
    /// serves an entry only to a request it covers (`cached_serves`): an
    /// OP-only, ED-only or probe-only run, or one made without the cour's MAL
    /// id (no Layer 1 at all), must never answer a later, fuller request.
    /// Entries written before these fields existed read as covering nothing.
    #[serde(default)]
    pub requested_op: bool,
    #[serde(default)]
    pub requested_ed: bool,
    #[serde(default)]
    pub requested_mal: Option<u32>,
    /// The Layer 1 edge rule the windows were published under
    /// (`EDGE_RULE`). A stored result from an older rule answers no kind
    /// (`cached_serves`): it would replay mapping A's edges for a month.
    #[serde(default)]
    pub edge_rule: u32,
    /// The request duration a STORED result was keyed by (set on write; None
    /// on the live snapshots and on entries written before it existed). A
    /// lookup that falls through to the adjacent 0.1 s bucket accepts an
    /// entry only when this is within `cache::NEIGHBOUR_TOL_S` of its own
    /// duration (`lookup_result`); an exact-bucket hit never reads it.
    #[serde(default)]
    pub keyed_duration: Option<f64>,
}

/// The current Layer 1 edge rule: 1 = the audible start and the episode-gated
/// end (`matcher::refine_layer1_window`). 0 (absent) = mapping A.
pub const EDGE_RULE: u32 = 1;

impl Snapshot {
    fn has_window(&self) -> bool {
        self.op.is_some() || self.ed.is_some()
    }
}

/// Whether a stored result may answer `req`: it must have been computed for
/// every kind `req` wants, and, when `req` carries a MAL id, for that same id
/// (a result computed without one, or for another cour, never had the right
/// Layer 1 themes). A result computed WITH a MAL id may answer a request
/// without one: it only knows more.
fn cached_serves(stored: &Snapshot, req: &Request) -> bool {
    (!(req.op || req.ed) || stored.edge_rule == EDGE_RULE)
        && (!req.op || (stored.requested_op && stored.op_l1 != L1State::Unknown))
        && (!req.ed || (stored.requested_ed && stored.ed_l1 != L1State::Unknown))
        && (req.mal_id.is_none() || stored.requested_mal == req.mal_id)
}

/// How long a stored result lives. `cache::RESULT_TTL` when it holds a
/// window and none of its windows is a Layer 3 window standing in for a
/// theme the cour's AnimeThemes list does not have; such a window lives no
/// longer than that list answer (`l3_list_ttl`, per kind): a day after a
/// theme-list MISS (no MAL id, or AnimeThemes listed nothing for the cour,
/// `THEME_LIST_MISS_TTL`), the theme list's own `THEME_LIST_HIT_TTL` when the
/// cour's list answered but has no theme of THAT kind (an airing cour often
/// lists its opening weeks before its ending). When AnimeThemes adds the
/// theme, the next play after that gets Layer 1. No window: the abstention
/// TTL.
fn result_ttl(s: &Snapshot, l3_list_ttl: &HashMap<Kind, u64>) -> u64 {
    if !s.has_window() {
        return cache::RESULT_ABSTAIN_TTL;
    }
    let stand_in = |w: &Option<WindowOut>, k: Kind| {
        w.as_ref().filter(|w| w.source == "continuity").and_then(|_| l3_list_ttl.get(&k).copied())
    };
    [stand_in(&s.op, Kind::Op), stand_in(&s.ed, Kind::Ed)]
        .into_iter()
        .flatten()
        .fold(cache::RESULT_TTL, u64::min)
}

/// How far the region being read has decoded, for the player's theme-match
/// readout. Its own event, never a Snapshot field: every snapshot re-stamps
/// the skip windows, and this ticks up to a hundred times per region.
#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub generation: u64,
    /// The kind whose region is decoding: "op" (HEAD) or "ed" (TAIL).
    pub kind: &'static str,
    /// Share of that region decoded, 0 to 1. 1 only once the region ended
    /// (an early HEAD exit after the opening matched included).
    pub fraction: f64,
    /// Whether the catalogue holds a candidate theme of each kind. A kind with
    /// none is not being theme matched (Layer 3 or nothing at all).
    pub op_themes: bool,
    pub ed_themes: bool,
}

/// What a detect needs from its host.
pub struct Ctx {
    pub ffmpeg: OsString,
    /// `app_data_dir()`; None disables every cache.
    pub data_dir: Option<PathBuf>,
    pub generation: u64,
    /// Called with every changed snapshot (the host filters stale generations).
    pub publish: Arc<dyn Fn(&Snapshot) + Send + Sync>,
    /// Called as a region decodes (see `Progress`).
    pub progress: Arc<dyn Fn(&Progress) + Send + Sync>,
    /// The probe and region ffmpeg run at BELOW_NORMAL priority (the
    /// next-episode pre-scan). False for a live detect.
    pub background: bool,
    /// A probe the caller already ran on this input (the pre-scan probes once
    /// to learn the duration its result is keyed by): returned instead of
    /// probing again. None for a live detect.
    pub pre_probe: Option<probe::ProbeInfo>,
    /// Tests only: replay cached PCM and a recorded probe instead of running
    /// ffmpeg on a stream (`replay.rs`). Everything else is the real job.
    #[cfg(test)]
    pub replay: Option<Arc<super::replay::Replay>>,
    /// Tests only: answer theme loads without the network (the result and a
    /// delay in milliseconds), so the decision's failure paths can be driven.
    #[cfg(test)]
    pub fake_theme_load: Option<FakeThemeLoad>,
}

#[cfg(test)]
pub type FakeThemeLoad = Arc<dyn Fn(&ThemeRec) -> (Result<(Arc<ThemeFp>, bool), String>, u64) + Send + Sync>;

/// A region's PCM source: an ffmpeg pass, or (tests only) a replay of cached
/// PCM through the very same streaming loop.
enum Source {
    Ff(RegionPass),
    #[cfg(test)]
    Replay(super::replay::ReplayPass),
}

impl Source {
    fn samples(&self) -> u64 {
        match self {
            Source::Ff(p) => p.samples(),
            #[cfg(test)]
            Source::Replay(p) => p.samples(),
        }
    }

    fn first_pts(&self) -> Option<f64> {
        match self {
            Source::Ff(p) => p.first_pts(),
            #[cfg(test)]
            Source::Replay(p) => p.first_pts(),
        }
    }

    async fn next_pcm(&mut self) -> std::io::Result<Option<Vec<i16>>> {
        match self {
            Source::Ff(p) => p.next_pcm().await,
            #[cfg(test)]
            Source::Replay(p) => p.next_pcm().await,
        }
    }

    async fn finish(self) -> audio::RegionEnd {
        match self {
            Source::Ff(p) => p.finish().await,
            #[cfg(test)]
            Source::Replay(p) => p.end(false),
        }
    }

    async fn kill(self) -> audio::RegionEnd {
        match self {
            Source::Ff(p) => p.kill().await,
            #[cfg(test)]
            Source::Replay(p) => p.end(true),
        }
    }
}

// ── theme catalogue ─────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
enum ListState {
    /// No MAL id was supplied.
    NoMal,
    /// The AnimeThemes list could not be fetched (fail closed, not cached).
    Unavailable(String),
    Loaded,
}

#[derive(Clone)]
struct Catalog {
    recs: Vec<ThemeRec>,
    metas: Vec<ThemeMeta>,
    primary_len: usize,
    state: ListState,
    siblings_tried: bool,
    /// The sibling-cour lookup could not be completed (MyAnimeList relations or
    /// a sibling's theme list unavailable): "nothing matched" is then not a
    /// stable fact.
    siblings_incomplete: bool,
    ep: Option<u32>,
}

impl Catalog {
    fn push_list(&mut self, mal: u32, list: Vec<ThemeRec>) {
        for r in list {
            self.metas.push(r.meta(mal));
            self.recs.push(r);
        }
    }

    /// Candidate order: the cour's own themes by episode proximity, then
    /// sibling cours' in API order.
    fn order(&self, kind: Kind) -> Vec<usize> {
        let mut o = themes::candidate_order(&self.metas[..self.primary_len], kind, self.ep);
        let sib = themes::candidate_order(&self.metas[self.primary_len..], kind, None);
        o.extend(sib.into_iter().map(|i| i + self.primary_len));
        o
    }

    /// The Layer 3 gate's count: every theme of `kind` the cour's OWN list
    /// holds, "Over" ones included. Not `order()`, which drops an Over ED
    /// before ordering: an Over theme (evaluated and rejected, or never a
    /// candidate) still says the cour HAS a theme of this kind, so a block the
    /// continuity scan would pick is likely story under that song. Sibling
    /// cours do not count: a sibling's themes that did not match say nothing
    /// about whether THIS cour has one (a cour AnimeThemes lists nothing for
    /// still gets Layer 3, prompt-only).
    fn primary_themes_of_kind(&self, kind: Kind) -> usize {
        self.metas[..self.primary_len].iter().filter(|m| m.kind == kind).count()
    }

    /// How long a Layer 3 window decided for a kind this list has no theme
    /// of may be cached (see `result_ttl`): it stands in for that theme, so
    /// it lives no longer than the list answer. A day after a miss (no MAL
    /// id, or AnimeThemes listing nothing for the cour), the list's hit TTL
    /// when the list answered without a theme of that kind (an airing cour
    /// listing its opening before its ending). None: the list was never read.
    fn l3_list_ttl(&self) -> Option<u64> {
        match self.state {
            ListState::NoMal => Some(cache::THEME_LIST_MISS_TTL),
            ListState::Loaded if self.primary_len == 0 => Some(cache::THEME_LIST_MISS_TTL),
            ListState::Loaded => Some(cache::THEME_LIST_HIT_TTL),
            ListState::Unavailable(_) => None,
        }
    }
}

// ── theme loader ────────────────────────────────────────────────────────────

type LoadResult = (usize, Result<(Arc<ThemeFp>, bool), String>);

struct Loader {
    set: JoinSet<LoadResult>,
    pending: HashSet<usize>,
    loaded: HashMap<usize, Arc<ThemeFp>>,
    failed: HashSet<usize>,
    /// Theme loads that cost a network attempt, per kind: every download and
    /// every FAILED load (a cache hit costs nothing). Counted against
    /// `themes::MAX_DOWNLOADS_PER_KIND`: when only successes counted, an
    /// AnimeThemes audio outage walked every candidate, siblings included,
    /// at up to 46 s each.
    downloads: HashMap<Kind, usize>,
    /// Consecutive failed loads per kind (a load that succeeds resets it).
    /// `FAIL_STREAK_ABSTAIN` of them end the kind's decision as undecided.
    fail_streak: HashMap<Kind, usize>,
    /// A fork's `downloads` when it was forked, so `Decider::merge` adds
    /// only what the fork itself spent (empty on the main loader).
    downloads_at_fork: HashMap<Kind, usize>,
}

/// Consecutive theme load failures (download, HTTP error, timeout, decode)
/// after which a kind's Layer 1 decision stops and abstains as UNDECIDED
/// (`L1State::Unavailable`, never cached): the theme audio host is down, and
/// trying every remaining candidate and every sibling cour would hold both
/// kinds `Pending` for minutes.
pub const FAIL_STREAK_ABSTAIN: usize = 2;

impl Loader {
    fn new() -> Self {
        Self {
            set: JoinSet::new(),
            pending: HashSet::new(),
            loaded: HashMap::new(),
            failed: HashSet::new(),
            downloads: HashMap::new(),
            fail_streak: HashMap::new(),
            downloads_at_fork: HashMap::new(),
        }
    }

    /// A loader for a forked decision: what is loaded or failed so far, and
    /// the attempt counts, but no in-flight load. The caller settles the
    /// in-flight loads of the fork's kind first (`Decider::settle_pending`),
    /// so the fork never starts a second download of a theme the main loader
    /// is still fetching.
    fn fork(&self) -> Self {
        Self {
            set: JoinSet::new(),
            pending: HashSet::new(),
            loaded: self.loaded.clone(),
            failed: self.failed.clone(),
            downloads: self.downloads.clone(),
            fail_streak: self.fail_streak.clone(),
            downloads_at_fork: self.downloads.clone(),
        }
    }

    fn start(&mut self, i: usize, rec: &ThemeRec, ctx: &Ctx) {
        if self.pending.contains(&i) || self.loaded.contains_key(&i) || self.failed.contains(&i) {
            return;
        }
        self.pending.insert(i);
        #[cfg(test)]
        if let Some(fake) = &ctx.fake_theme_load {
            let (res, delay_ms) = fake(rec);
            self.set.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                (i, res)
            });
            return;
        }
        let (ff, dir, rec) = (ctx.ffmpeg.clone(), ctx.data_dir.clone(), rec.clone());
        self.set.spawn(async move { (i, animethemes::load_theme_fp(&ff, dir.as_deref(), &rec).await) });
    }

    /// Record one finished load; returns its index when it loaded.
    fn absorb(&mut self, r: Result<LoadResult, tokio::task::JoinError>, cat: &Catalog, who: &str) -> Option<usize> {
        let (i, res) = r.ok()?;
        self.pending.remove(&i);
        let rec = &cat.recs[i];
        match res {
            Ok((t, downloaded)) => {
                if downloaded {
                    *self.downloads.entry(rec.kind()).or_default() += 1;
                }
                self.fail_streak.insert(rec.kind(), 0);
                crate::devlog!(
                    debug, "skipdetect",
                    "{who} theme {} ({}) {} {:.1}s",
                    rec.label(),
                    rec.basename,
                    if downloaded { "downloaded" } else { "from cache" },
                    t.fp.duration_s()
                );
                self.loaded.insert(i, t);
                Some(i)
            }
            Err(e) => {
                crate::devlog!(warn, "skipdetect", "{who} theme {} ({}) failed: {e}", rec.label(), rec.basename);
                self.failed.insert(i);
                *self.downloads.entry(rec.kind()).or_default() += 1;
                *self.fail_streak.entry(rec.kind()).or_default() += 1;
                None
            }
        }
    }

    /// Wait until theme `i` is loaded (or failed).
    async fn wait_for(&mut self, i: usize, cat: &Catalog, who: &str) -> Option<Arc<ThemeFp>> {
        loop {
            if let Some(t) = self.loaded.get(&i) {
                return Some(t.clone());
            }
            if self.failed.contains(&i) || !self.pending.contains(&i) {
                return None;
            }
            let r = self.set.join_next().await?;
            self.absorb(r, cat, who);
        }
    }

    fn downloads(&self, kind: Kind) -> usize {
        self.downloads.get(&kind).copied().unwrap_or(0)
    }

    fn fail_streak(&self, kind: Kind) -> usize {
        self.fail_streak.get(&kind).copied().unwrap_or(0)
    }
}

// ── region pass ─────────────────────────────────────────────────────────────

/// A loaded candidate theme handed to the region worker. `early` = the early
/// provisional rule may fire on it (never an "Over" theme, never a Transition
/// version while its full version is a candidate).
struct StreamTheme {
    idx: usize,
    t: Arc<ThemeFp>,
    early: bool,
}

enum WCmd {
    Pcm(Vec<i16>),
    T0(f64),
    Themes(Vec<StreamTheme>),
    /// The full gate accepted: the early tracker has nothing left to do.
    EarlyStop,
    Finish,
}

enum WEvt {
    Matched { decoded_s: f64, results: Vec<(usize, ThemeMatch)> },
    Early { decoded_s: f64, event: EarlyEvent },
    Finished { fp: Fingerprint, levels: Vec<f32> },
}

/// The blocking-pool half of a region: fingerprint + RMS + incremental match,
/// and (HEAD only, `early`) the early provisional-opening tracker.
fn worker_loop(mut rx: mpsc::Receiver<WCmd>, tx: mpsc::UnboundedSender<WEvt>, t0: f64, early: bool) {
    let mut fpr = Fingerprinter::new(t0);
    let mut rms = RmsMeter::new();
    let mut sched = MatchSchedule::default();
    let mut themes: Vec<StreamTheme> = Vec::new();
    let mut tracker = early.then(EarlyTracker::new);
    let mut origin = false;
    while let Some(cmd) = rx.blocking_recv() {
        match cmd {
            WCmd::Pcm(p) => {
                fpr.push(&p);
                rms.push(&p);
            }
            WCmd::T0(t) => {
                fpr.set_t0(t);
                origin = true;
            }
            WCmd::Themes(t) => themes = t,
            WCmd::EarlyStop => tracker = None,
            WCmd::Finish => {
                let _ = tx.send(WEvt::Finished { fp: fpr.finish(), levels: rms.into_levels() });
                return;
            }
        }
        // Match only with the queue drained, so a lagging worker catches up
        // on PCM first instead of matching stale prefixes.
        if origin && !themes.is_empty() && rx.is_empty() {
            let decoded_s = fpr.samples() as f64 / SR as f64;
            if sched.due(decoded_s, false) {
                let q = fpr.fingerprint();
                let results = themes.iter().map(|s| (s.idx, matcher::evaluate_theme(&s.t.fp, s.t.audible, q))).collect();
                if tx.send(WEvt::Matched { decoded_s, results }).is_err() {
                    return;
                }
            }
            if let Some(tr) = tracker.as_mut() {
                let refs: Vec<EarlyRef> = themes
                    .iter()
                    .filter(|s| s.early)
                    .map(|s| EarlyRef { idx: s.idx, fp: &s.t.fp, audible: s.t.audible })
                    .collect();
                if let Some(event) = tr.step(decoded_s, fpr.fingerprint(), &refs) {
                    if tx.send(WEvt::Early { decoded_s, event }).is_err() {
                        return;
                    }
                }
            }
        }
        // Tests only: a replay paces its PCM on what the analysis consumed.
        #[cfg(test)]
        super::replay::worker_progress(fpr.samples());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Which {
    Head,
    Tail,
}

impl Which {
    fn kind(self) -> Kind {
        match self {
            Which::Head => Kind::Op,
            Which::Tail => Kind::Ed,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Which::Head => "HEAD",
            Which::Tail => "TAIL",
        }
    }
}

/// An accepted Layer 1 match.
#[derive(Clone, Debug)]
struct Accepted {
    idx: usize,
    m: ThemeMatch,
}

/// One finished region.
struct RegionOut {
    fp: Arc<Fingerprint>,
    levels: Vec<f32>,
    silences: Vec<Silence>,
    origin: Option<f64>,
    samples: u64,
    /// Ran to its natural end with every check passing.
    complete: bool,
    /// Why it is not complete (None when complete or killed by early exit).
    failed: Option<String>,
    /// A Layer 1 acceptance made while streaming.
    early: Option<Accepted>,
}

enum Decision {
    Window(WindowOut),
    /// No window; `cacheable` false when the abstain is not a stable fact.
    /// `l1` is what the abstain says about Layer 1 (published per kind).
    Abstain { note: String, cacheable: bool, l1: L1State },
    /// Layer 1 has no theme of this kind at all: Layer 3 may run.
    NoThemes { note: String },
}

// ── the decision half ───────────────────────────────────────────────────────

/// The OP decision on a COMPLETE HEAD region, running beside the TAIL pass.
/// It owns a forked `Decider` (no shared `&mut` with the pass) and hands it
/// back with its verdict, to be merged when it resolves.
type SideFut<'a> = Pin<Box<dyn Future<Output = (Decision, Decider<'a>)> + Send + 'a>>;

/// Await the side decision when there is one; never resolves otherwise.
async fn poll_side<'a>(side: &mut Option<SideFut<'a>>) -> (Decision, Decider<'a>) {
    match side.as_mut() {
        Some(f) => f.await,
        None => std::future::pending().await,
    }
}

/// The theme catalogue, the loader and the Layer 1 / Layer 3 decisions. Kept
/// apart from the region pass so the OP decision on a complete HEAD (a theme
/// download, a sibling-cour lookup, Layer 3) can run beside the TAIL pass on a
/// fork instead of holding TAIL back (spec: TAIL starts as soon as HEAD exits).
struct Decider<'a> {
    ctx: &'a Ctx,
    req: &'a Request,
    who: String,
    cat: Catalog,
    loader: Loader,
    cacheable: bool,
    /// Kinds whose Layer 3 window stands in for a theme the cour's list does
    /// not have, with the TTL of that list answer (see `result_ttl`).
    l3_list_ttl: HashMap<Kind, u64>,
}

impl<'a> Decider<'a> {
    /// Absorb loads that already finished, so a fork knows about them and
    /// does not download them again.
    fn drain_finished_loads(&mut self) {
        while let Some(r) = self.loader.set.try_join_next() {
            let who = self.who.clone();
            self.loader.absorb(r, &self.cat, &who);
        }
    }

    /// Wait for every in-flight load of `kind` to land (loaded or failed),
    /// absorbing whatever else finishes meanwhile. Called before a fork, so
    /// the fork inherits the theme instead of downloading it a second time
    /// (and counting one download where two happened). At most one theme
    /// load, which the fork would otherwise have spent re-downloading.
    async fn settle_pending(&mut self, kind: Kind) {
        let mine: Vec<usize> = self.loader.pending.iter().copied().filter(|&i| self.cat.recs[i].kind() == kind).collect();
        let who = self.who.clone();
        for i in mine {
            let _ = self.loader.wait_for(i, &self.cat, &who).await;
        }
    }

    fn fork(&self) -> Decider<'a> {
        Decider {
            ctx: self.ctx,
            req: self.req,
            who: self.who.clone(),
            cat: self.cat.clone(),
            loader: self.loader.fork(),
            cacheable: true,
            l3_list_ttl: HashMap::new(),
        }
    }

    /// Take back what a fork learned. The main catalogue is never changed
    /// while a fork runs (only `load_siblings`, inside a decision, appends to
    /// it, and appends only), so the fork's copy, siblings included, replaces
    /// it and every index the main loader holds stays valid.
    fn merge(&mut self, fork: Decider<'a>) {
        debug_assert!(fork.cat.recs.len() >= self.cat.recs.len());
        self.cat = fork.cat;
        for (i, t) in fork.loader.loaded {
            self.loader.failed.remove(&i);
            self.loader.loaded.entry(i).or_insert(t);
        }
        for i in fork.loader.failed {
            if !self.loader.loaded.contains_key(&i) && !self.loader.pending.contains(&i) {
                self.loader.failed.insert(i);
            }
        }
        // The fork's OWN attempts are added (the main loader kept counting
        // its own loads meanwhile), so every real download counts once.
        for (k, n) in fork.loader.downloads {
            let at_fork = fork.loader.downloads_at_fork.get(&k).copied().unwrap_or(0);
            *self.loader.downloads.entry(k).or_default() += n.saturating_sub(at_fork);
        }
        for (k, n) in fork.loader.fail_streak {
            let e = self.loader.fail_streak.entry(k).or_default();
            *e = (*e).max(n);
        }
        self.cacheable &= fork.cacheable;
        self.l3_list_ttl.extend(fork.l3_list_ttl);
    }

    async fn load_siblings(&mut self) {
        self.cat.siblings_tried = true;
        let Some(mal) = self.req.mal_id else { return };
        let ids = match &self.req.sibling_mal_ids {
            Some(s) => s.clone(),
            None => match animethemes::sibling_mal_ids(mal).await {
                Ok(ids) => ids,
                Err(_) => {
                    // An outage is not "this cour has no sequel / prequel":
                    // whatever follows must not be cached as a fact.
                    crate::devlog!(
                        warn, "skipdetect",
                        "{} sibling cour lookup (MyAnimeList relations) unavailable; result not cached",
                        self.who
                    );
                    self.cacheable = false;
                    self.cat.siblings_incomplete = true;
                    Vec::new()
                }
            },
        };
        for sid in ids {
            match animethemes::theme_list(self.ctx.data_dir.as_deref(), sid).await {
                Ok(list) => {
                    crate::devlog!(info, "skipdetect", "{} sibling cour mal {sid}: {} theme file(s)", self.who, list.len());
                    self.cat.push_list(sid, list);
                }
                Err(e) => {
                    crate::devlog!(warn, "skipdetect", "{} sibling cour mal {sid} unavailable: {}", self.who, e.0);
                    self.cacheable = false;
                    self.cat.siblings_incomplete = true;
                }
            }
        }
    }

    /// Layer 1 over a COMPLETE region, by the stop policy.
    async fn decide_complete(&mut self, kind: Kind, region: &RegionOut, media_end: f64) -> Decision {
        match &self.cat.state {
            ListState::NoMal => return Decision::NoThemes { note: "no MAL id".into() },
            ListState::Unavailable(e) => {
                return Decision::Abstain {
                    note: format!("animethemes unavailable ({e})"),
                    cacheable: false,
                    l1: L1State::Unavailable,
                }
            }
            ListState::Loaded => {}
        }
        let q = region.fp.clone();
        let mut verdict: HashMap<usize, bool> = HashMap::new();
        let mut matches: HashMap<usize, ThemeMatch> = HashMap::new();
        let mut tally = SearchTally::default();
        loop {
            let order = self.cat.order(kind);
            let passed: Vec<Option<bool>> = (0..self.cat.metas.len()).map(|i| verdict.get(&i).copied()).collect();
            match themes::next_step(&self.cat.metas, &order, &passed, self.loader.downloads(kind)) {
                Step::Evaluate(i) => {
                    let rec = self.cat.recs[i].clone();
                    self.loader.start(i, &rec, self.ctx);
                    let who = self.who.clone();
                    let own = i < self.cat.primary_len;
                    let Some(t) = self.loader.wait_for(i, &self.cat, &who).await else {
                        tally.failed += 1;
                        verdict.insert(i, false);
                        let streak = self.loader.fail_streak(kind);
                        if streak >= FAIL_STREAK_ABSTAIN {
                            // The theme audio host is down (or every file is
                            // broken): stop here instead of walking every
                            // candidate and sibling cour at up to 46 s each.
                            // Undecided, so the crowd keeps its trust.
                            return Decision::Abstain {
                                note: format!("theme audio unavailable ({streak} consecutive load failures); layer 1 undecided"),
                                cacheable: false,
                                l1: L1State::Unavailable,
                            };
                        }
                        continue;
                    };
                    if matcher::too_short_to_match(t.audible) {
                        // The 30 s run gate can never pass on a reference this
                        // short (short-form anime): it is no evidence either way.
                        crate::devlog!(
                            info, "skipdetect",
                            "{} {} theme {} audible for {:.1}s: shorter than the {:.0} s run gate, not evaluated",
                            self.who,
                            kind_name(kind),
                            rec.label(),
                            t.audible.1 - t.audible.0,
                            matcher::ACCEPT_LEN_S
                        );
                        if own {
                            tally.short_own += 1;
                        }
                        verdict.insert(i, false);
                        continue;
                    }
                    let q2 = q.clone();
                    let m = match tokio::task::spawn_blocking(move || matcher::evaluate_theme(&t.fp, t.audible, &q2)).await {
                        Ok(m) => m,
                        Err(_) => {
                            tally.failed += 1;
                            verdict.insert(i, false);
                            continue;
                        }
                    };
                    crate::devlog!(
                        info, "skipdetect",
                        "{} {} theme {} ({:.1}s) run {:.1}s ber {:?} best/second {:.3}/{:.3} margin {:.3} soft42 {:?} -> {}",
                        self.who,
                        kind_name(kind),
                        rec.label(),
                        m.ref_len_s,
                        m.longest_run_s,
                        m.run_ber,
                        m.best_ber,
                        m.second_ber,
                        m.margin,
                        m.soft42,
                        m.reject.map_or("accept", |r| r.as_str())
                    );
                    if own {
                        tally.evaluated_own += 1;
                    }
                    verdict.insert(i, m.accepted);
                    matches.insert(i, m);
                }
                Step::Accept(i) => {
                    let m = &matches[&i];
                    let audible = self.loader.loaded.get(&i).map(|t| t.audible);
                    let Some(w) = published_window(m, audible, kind, region, media_end) else {
                        return Decision::Abstain {
                            note: "matched window empty after clamping".into(),
                            cacheable: true,
                            l1: L1State::Unavailable,
                        };
                    };
                    let refined = audible.is_some() && region_refines(region);
                    return Decision::Window(layer1_out(m, &self.cat.recs[i], w, &self.cat.metas[i], refined));
                }
                Step::CapReached => {
                    return Decision::Abstain {
                        note: format!("theme download cap ({}) reached", themes::MAX_DOWNLOADS_PER_KIND),
                        cacheable: false,
                        l1: L1State::Unavailable,
                    }
                }
                Step::Exhausted => {
                    if !self.cat.siblings_tried {
                        self.load_siblings().await;
                        continue;
                    }
                    break;
                }
            }
        }
        // Layer 3 is gated on the cour's OWN themes of this kind (Over ones
        // included). Siblings were already tried first, so the Layer 1 order
        // is unchanged; a sibling theme that did not match does not make this
        // an informative abstain.
        if super::layer3_allowed(self.cat.primary_themes_of_kind(kind)) {
            let sibling_candidates = self.cat.order(kind).into_iter().any(|i| i >= self.cat.primary_len);
            let note = if self.cat.siblings_incomplete {
                "no themes (sibling lookup incomplete)"
            } else if sibling_candidates {
                "no themes (siblings did not match)"
            } else {
                "no themes"
            };
            return Decision::NoThemes { note: note.into() };
        }
        exhausted_abstain(&tally, self.cat.siblings_incomplete)
    }

    /// The whole decision for one kind and region: the streaming acceptance
    /// of an early-exited region, else Layer 1 over the complete region, then
    /// Layer 3 when Layer 1 had no themes of the kind.
    async fn decide_kind(&mut self, kind: Kind, region: &RegionOut, media_end: f64) -> Decision {
        let decision = if !region.complete {
            match &region.early {
                // HEAD killed after acceptance: the streaming window stands,
                // its edges refined with the levels decoded up to the kill.
                Some(a) => match published_window(&a.m, self.loader.loaded.get(&a.idx).map(|t| t.audible), kind, region, media_end) {
                    Some(w) => Decision::Window(layer1_out(
                        &a.m, &self.cat.recs[a.idx], w, &self.cat.metas[a.idx],
                        self.loader.loaded.contains_key(&a.idx) && region_refines(region),
                    )),
                    None => Decision::Abstain {
                        note: "matched window empty after clamping".into(),
                        cacheable: true,
                        l1: L1State::Unavailable,
                    },
                },
                None => Decision::Abstain {
                    note: region.failed.clone().unwrap_or_else(|| "region incomplete".into()),
                    cacheable: false,
                    l1: L1State::Unavailable,
                },
            }
        } else {
            self.decide_complete(kind, region, media_end).await
        };
        match decision {
            Decision::NoThemes { note } => {
                if self.req.anime {
                    // The Layer 2 counter (spec decision 14): how often an
                    // anime play had no Layer 1 themes for a kind.
                    crate::devlog!(info, "skipdetect", "{} layer1 counter {}: {note}", self.who, kind_name(kind));
                }
                let list_ttl = self.cat.l3_list_ttl();
                let d = self.layer3(kind, region, &note).await;
                if let (Some(ttl), Decision::Window(_)) = (list_ttl, &d) {
                    self.l3_list_ttl.insert(kind, ttl);
                }
                d
            }
            d => d,
        }
    }

    /// Layer 3 (prompt-only) over a complete region.
    async fn layer3(&mut self, kind: Kind, region: &RegionOut, why: &str) -> Decision {
        let Some(t0) = region.origin.filter(|_| region.complete) else {
            return Decision::Abstain {
                note: format!("{why}; region incomplete for continuity"),
                cacheable: false,
                l1: L1State::NoThemes,
            };
        };
        let levels = region.levels.clone();
        let sil = region.silences.clone();
        let outcome = tokio::task::spawn_blocking(move || {
            let r = Region { levels: &levels, t0, silences: &sil };
            match kind {
                Kind::Op => continuity::detect_op(&r),
                Kind::Ed => continuity::detect_ed(&r),
            }
        })
        .await;
        let Ok(o) = outcome else {
            return Decision::Abstain { note: format!("{why}; continuity failed"), cacheable: false, l1: L1State::NoThemes };
        };
        crate::devlog!(
            info, "skipdetect",
            "{} {} continuity: {} candidate(s), best {:?}, rival gap {:?}, extended left {:.2}s",
            self.who,
            kind_name(kind),
            o.n_candidates,
            o.best.map(|b| (b.l, b.r, b.q35, b.mrel)),
            o.gap,
            o.extended_left_s
        );
        match (o.window, o.best) {
            (Some((s, e)), Some(b)) => Decision::Window(WindowOut {
                start: s,
                end: e,
                source: "continuity".into(),
                auto_eligible: false,
                transition: false,
                theme: None,
                run_s: None,
                ber: None,
                margin: None,
                soft42: None,
                q35: Some(b.q35),
                mrel: Some(b.mrel),
                refined: false,
            }),
            _ => Decision::Abstain {
                note: format!("{why}; continuity abstains ({})", o.abstain.map_or("no candidate", |a| a.as_str())),
                cacheable: true,
                l1: L1State::NoThemes,
            },
        }
    }
}

// ── the job ─────────────────────────────────────────────────────────────────

struct Job<'a> {
    d: Decider<'a>,
    snap: Snapshot,
    /// When the detect started (log timings only).
    started: std::time::Instant,
    /// Early media-end estimate (mapped DURATION tag, else container, else
    /// mpv's duration).
    media_est: f64,
    /// The duration tag was known (tight completeness tolerance).
    tag_known: bool,
}

/// The stored result that answers `req` (keyed by Stremio id, `release` and
/// `req.duration`), and whether ANY entry was found under the keys tried. The
/// exact bucket first; then, when `req.duration` sits within
/// `cache::NEIGHBOUR_TOL_S` of a bucket boundary, the ONE adjacent bucket,
/// whose entry is accepted only when it was keyed within that tolerance of
/// `req.duration` (`Snapshot::keyed_duration`; an entry written before that
/// field existed never answers through a neighbour). Either entry must also
/// cover the request (`cached_serves`). Blocking (reads the JSON cache).
fn lookup_result(dir: &std::path::Path, release: &str, req: &Request) -> (Option<Snapshot>, bool) {
    let mut found = false;
    let exact = cache::get_result::<Snapshot>(dir, &cache::result_key(&req.stremio_id, release, req.duration));
    if let Some(s) = exact {
        found = true;
        if cached_serves(&s, req) {
            return (Some(s), true);
        }
    }
    let Some(nd) = cache::neighbour_duration(req.duration) else { return (None, found) };
    let Some(s) = cache::get_result::<Snapshot>(dir, &cache::result_key(&req.stremio_id, release, nd)) else {
        return (None, found);
    };
    if !s.keyed_duration.is_some_and(|c| (c - req.duration).abs() <= cache::NEIGHBOUR_TOL_S) {
        return (None, found);
    }
    let serves = cached_serves(&s, req);
    (serves.then_some(s), true)
}

/// Run one detect. Returns the final snapshot (state Done or Unavailable).
pub async fn run(ctx: &Ctx, req: &Request) -> Snapshot {
    run_stored(ctx, req).await.0
}

/// `run`, plus whether the final result was written to the result cache.
async fn run_stored(ctx: &Ctx, req: &Request) -> (Snapshot, bool) {
    // A Settings > Storage clear after this point wins over the write below.
    let since = cache::clear_generation();
    let who = req.who();
    crate::devlog!(
        info, "skipdetect",
        "{who} detect start, duration {:.2}s, mal {} ({}), ep {}, kinds {}{}",
        req.duration,
        req.mal_id.map_or("-".to_string(), |m| m.to_string()),
        req.mal_source.as_deref().unwrap_or("-"),
        req.mal_episode.map_or("-".to_string(), |e| e.to_string()),
        if req.op { "op" } else { "-" },
        if req.ed { "+ed" } else { "" },
    );
    let release = req.release_identity();
    let key = release.as_ref().map(|r| cache::result_key(&req.stremio_id, r, req.duration));
    if let (Some(dir), Some(rel)) = (ctx.data_dir.clone(), release.clone()) {
        let r = req.clone();
        let hit = tokio::task::spawn_blocking(move || lookup_result(&dir, &rel, &r)).await.ok().unwrap_or((None, false));
        match hit {
            (Some(mut s), _) => {
                // A fuller entry answers a narrower request with exactly what a
                // fresh run of that request would have produced.
                if !req.op {
                    s.op = None;
                    s.op_note = None;
                    s.op_l1 = L1State::NotRequested;
                    s.op_region = None;
                }
                if !req.ed {
                    s.ed = None;
                    s.ed_note = None;
                    s.ed_l1 = L1State::NotRequested;
                    s.ed_region = None;
                }
                s.generation = ctx.generation;
                s.from_cache = true;
                // Only final decisions are cached, so a stored Layer 1 window's
                // edges are final (an entry written before `refined` existed
                // reads false).
                for w in [s.op.as_mut(), s.ed.as_mut()].into_iter().flatten() {
                    if w.source == "animethemes" {
                        w.refined = true;
                    }
                }
                s.state = JobState::Done;
                let adjacent = s
                    .keyed_duration
                    .is_some_and(|c| cache::duration_bucket(c) != cache::duration_bucket(req.duration));
                crate::devlog!(
                    info, "skipdetect",
                    "{who} result cache hit{}: op {} ed {} media_end {:?}",
                    if adjacent { " (adjacent duration bucket)" } else { "" },
                    fmt_win(&s.op),
                    fmt_win(&s.ed),
                    s.media_end
                );
                (ctx.publish)(&s);
                return (s, false);
            }
            (None, true) => {
                crate::devlog!(debug, "skipdetect", "{who} result cache entry does not cover this request; detecting");
            }
            (None, false) => {}
        }
    }
    let mut job = Job {
        d: Decider {
            ctx,
            req,
            who,
            cat: Catalog {
                recs: Vec::new(),
                metas: Vec::new(),
                primary_len: 0,
                state: ListState::NoMal,
                siblings_tried: false,
                siblings_incomplete: false,
                ep: req.mal_episode,
            },
            loader: Loader::new(),
            cacheable: true,
            l3_list_ttl: HashMap::new(),
        },
        snap: Snapshot {
            generation: ctx.generation,
            state: JobState::Running,
            requested_op: req.op,
            requested_ed: req.ed,
            requested_mal: req.mal_id,
            edge_rule: EDGE_RULE,
            op_l1: if req.op { L1State::Pending } else { L1State::NotRequested },
            ed_l1: if req.ed { L1State::Pending } else { L1State::NotRequested },
            ..Default::default()
        },
        media_est: req.duration,
        tag_known: false,
        started: std::time::Instant::now(),
    };
    job.run().await;
    // Every OP path ends in `apply`, which replaces a provisional window; this
    // only makes sure one can never reach the result cache or the final reply.
    for w in [&mut job.snap.op, &mut job.snap.ed] {
        if w.as_ref().is_some_and(|w| w.source == EARLY_SOURCE) {
            *w = None;
        }
    }
    // A kind the run never decided (the probe failed, no audio track, the
    // region failed before a decision) ends Unavailable, never Pending: the
    // frontend holds a crowd window while Layer 1 is pending, and a final
    // snapshot must release it.
    for l1 in [&mut job.snap.op_l1, &mut job.snap.ed_l1] {
        if *l1 == L1State::Pending {
            *l1 = L1State::Unavailable;
        }
    }
    job.snap.state = JobState::Done;
    (ctx.publish)(&job.snap);
    let mut written = false;
    if job.d.cacheable {
        if let (Some(dir), Some(k)) = (ctx.data_dir.clone(), key) {
            let mut stored = job.snap.clone();
            stored.generation = 0;
            stored.keyed_duration = Some(req.duration);
            let ttl = result_ttl(&stored, &job.d.l3_list_ttl);
            if stored.has_window() && ttl < cache::RESULT_TTL {
                crate::devlog!(
                    info, "skipdetect",
                    "{} continuity window standing in for a theme AnimeThemes does not list: result cached for {} day(s) only",
                    job.d.who,
                    ttl / (24 * 3600)
                );
            }
            written = tokio::task::spawn_blocking(move || cache::put_result_since(&dir, &k, stored, ttl, since))
                .await
                .unwrap_or(false);
        }
    }
    (job.snap, written)
}

fn fmt_win(w: &Option<WindowOut>) -> String {
    match w {
        Some(w) => format!(
            "[{:.2}, {:.2}] {}{}{}",
            w.start,
            w.end,
            w.source,
            w.theme.as_deref().map(|t| format!(" {t}")).unwrap_or_default(),
            if w.auto_eligible { " auto" } else { " prompt" }
        ),
        None => "none".to_string(),
    }
}

/// What an exhausted Layer 1 search (no theme matched, the cour's own list
/// HAS themes of the kind) says about the kind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SearchTally {
    /// Candidates whose load (download, HTTP, timeout, decode) or evaluation
    /// failed, own cour or sibling.
    failed: usize,
    /// The cour's own candidates evaluated against the region.
    evaluated_own: usize,
    /// The cour's own candidates too short for the 30 s run gate.
    short_own: usize,
}

/// The abstain for an exhausted search. `Informative` ("the cour has themes
/// of this kind and none is in this file") only when it is a fact: every
/// candidate loaded and at least one of the cour's own was really compared.
/// A failed load could have been the theme that matches, and a theme too
/// short for the run gate was never comparable, so either leaves the kind
/// UNDECIDED (`Unavailable`): the crowd keeps its trust (an informative
/// abstain holds every crowd opening prompt-only, drops AniSkip endings and
/// single IntroDB rows, and blocks Layer 3). A failure is not cached (the
/// next play retries); an all-short cour is (it stays that way).
fn exhausted_abstain(t: &SearchTally, siblings_incomplete: bool) -> Decision {
    if t.failed > 0 {
        return Decision::Abstain {
            note: format!("themes exist but {} candidate(s) could not be loaded; layer 1 undecided", t.failed),
            cacheable: false,
            l1: L1State::Unavailable,
        };
    }
    if t.evaluated_own == 0 && t.short_own > 0 {
        return Decision::Abstain {
            note: format!(
                "every theme of the kind is shorter than the {:.0} s run gate; layer 1 cannot judge",
                matcher::ACCEPT_LEN_S
            ),
            cacheable: !siblings_incomplete,
            l1: L1State::Unavailable,
        };
    }
    Decision::Abstain {
        note: if siblings_incomplete {
            "themes exist but none matched (informative abstain; sibling lookup incomplete)".into()
        } else {
            "themes exist but none matched (informative abstain)".into()
        },
        cacheable: !siblings_incomplete,
        l1: L1State::Informative,
    }
}

/// The window a Layer 1 match publishes: `matcher::refine_layer1_window`
/// with the theme's audible span and, once the region has finished, its RMS
/// levels (the gated end). Without the theme's audible span (never expected:
/// the theme was loaded to be matched) mapping A stands.
fn published_window(
    m: &ThemeMatch,
    audible: Option<(f64, f64)>,
    kind: Kind,
    region: &RegionOut,
    media_end: f64,
) -> Option<(f64, f64)> {
    let Some(audible) = audible else { return matcher::layer1_window(m, media_end) };
    let levels = region
        .origin
        .filter(|_| !region.levels.is_empty())
        .map(|t0| matcher::RegionLevels { levels: &region.levels, t0 });
    matcher::refine_layer1_window(m, audible, kind == Kind::Ed, levels, media_end)
}

/// Whether `published_window` refines a window in `region` with its RMS
/// levels (its edges are then final): the same test it applies.
fn region_refines(region: &RegionOut) -> bool {
    region.origin.is_some() && !region.levels.is_empty()
}

fn layer1_out(m: &ThemeMatch, rec: &ThemeRec, window: (f64, f64), meta: &ThemeMeta, refined: bool) -> WindowOut {
    WindowOut {
        start: window.0,
        end: window.1,
        source: "animethemes".into(),
        auto_eligible: themes::auto_eligible(meta),
        transition: meta.transition_ed(),
        theme: Some(rec.label()),
        run_s: Some(m.longest_run_s),
        ber: m.run_ber,
        margin: Some(m.margin),
        soft42: m.soft42,
        q35: None,
        mrel: None,
        refined,
    }
}

/// `Some(withdraw_the_opening_too)` when a continuity ENDING overlaps the
/// published opening (see `Job::no_ed_inside_the_opening`), else None.
fn continuity_ed_clash(ed: &WindowOut, op: &WindowOut) -> Option<bool> {
    if ed.source != "continuity" || ed.start.max(op.start) >= ed.end.min(op.end) {
        return None;
    }
    Some(op.source == "continuity")
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Op => "OP",
        Kind::Ed => "ED",
    }
}

impl<'a> Job<'a> {
    fn publish(&self) {
        (self.d.ctx.publish)(&self.snap);
    }

    fn report_progress(&self, which: Which, fraction: f64) {
        (self.d.ctx.progress)(&Progress {
            generation: self.d.ctx.generation,
            kind: match which {
                Which::Head => "op",
                Which::Tail => "ed",
            },
            fraction: fraction.clamp(0.0, 1.0),
            op_themes: !self.d.cat.order(Kind::Op).is_empty(),
            ed_themes: !self.d.cat.order(Kind::Ed).is_empty(),
        });
    }

    fn set_note(&mut self, kind: Kind, note: String) {
        match kind {
            Kind::Op => self.snap.op_note = Some(note),
            Kind::Ed => self.snap.ed_note = Some(note),
        }
    }

    fn set_window(&mut self, kind: Kind, w: Option<WindowOut>) {
        // A full Layer 1 window (a streaming acceptance or a final decision)
        // settles the kind; the early provisional window does not.
        if w.as_ref().is_some_and(|w| w.source == "animethemes") {
            self.set_l1(kind, L1State::Matched);
        }
        match kind {
            Kind::Op => self.snap.op = w,
            Kind::Ed => self.snap.ed = w,
        }
    }

    fn set_l1(&mut self, kind: Kind, l1: L1State) {
        match kind {
            Kind::Op => self.snap.op_l1 = l1,
            Kind::Ed => self.snap.ed_l1 = l1,
        }
    }

    async fn run(&mut self) {
        let req = self.d.req;
        let ctx = self.d.ctx;
        let input = req.audio_url.clone().unwrap_or_else(|| req.url.clone());
        // Probe and theme list in parallel.
        let probe_fut = async {
            #[cfg(test)]
            if let Some(r) = &ctx.replay {
                return Some(Ok(r.probe.clone()));
            }
            if let Some(p) = &ctx.pre_probe {
                return Some(Ok(p.clone()));
            }
            let _permit = PASS_GATE.acquire().await.ok()?;
            Some(audio::run_probe_with(&ctx.ffmpeg, &input, ctx.background).await)
        };
        let list_fut = async {
            match req.mal_id {
                Some(m) => Some(animethemes::theme_list(ctx.data_dir.as_deref(), m).await),
                None => None,
            }
        };
        let (probe_res, list_res) = tokio::join!(probe_fut, list_fut);
        match list_res {
            None => {
                self.d.cat.state = ListState::NoMal;
            }
            Some(Ok(list)) => {
                let mal = req.mal_id.unwrap_or(0);
                crate::devlog!(info, "skipdetect", "{} animethemes mal {mal}: {} theme file(s)", self.d.who, list.len());
                self.d.cat.push_list(mal, list);
                self.d.cat.primary_len = self.d.cat.recs.len();
                self.d.cat.state = ListState::Loaded;
            }
            Some(Err(e)) => {
                crate::devlog!(warn, "skipdetect", "{} animethemes unavailable: {}", self.d.who, e.0);
                self.d.cat.state = ListState::Unavailable(e.0);
                self.d.cacheable = false;
            }
        }
        // Prefetch the top-ranked theme of each wanted kind.
        for (want, kind) in [(req.op, Kind::Op), (req.ed, Kind::Ed)] {
            if want {
                if let Some(&i) = self.d.cat.order(kind).first() {
                    let rec = self.d.cat.recs[i].clone();
                    self.d.loader.start(i, &rec, ctx);
                }
            }
        }
        let probe = match probe_res {
            Some(Ok(p)) => p,
            Some(Err(e)) => {
                let note = e.note();
                crate::devlog!(warn, "skipdetect", "{} {note}; abstaining", self.d.who);
                self.d.cacheable = false;
                self.set_note(Kind::Op, note.clone());
                self.set_note(Kind::Ed, note);
                return;
            }
            None => {
                // The pass gate closed: the region was never read, so this is
                // no fact about the file (never cached as an empty result).
                self.d.cacheable = false;
                return;
            }
        };
        let Some((n, why)) = probe::pick_track(&probe.audio) else {
            // No audio track to analyse: undecided, never cached (an entry
            // with both kinds Unavailable would answer every play for a day).
            self.d.cacheable = false;
            return;
        };
        let track = &probe.audio[n];
        let tag = track.duration_tag;
        self.tag_known = tag.is_some();
        self.media_est = probe::early_media_end(tag, probe.container_duration).unwrap_or(req.duration);
        crate::devlog!(
            info, "skipdetect",
            "{} track 0:a:{n} ({}, {}), {} audio track(s); container {:?} start {:.3} tag {:?}; early media end {:.3}",
            self.d.who,
            track.lang.as_deref().unwrap_or("und"),
            why.as_str(),
            probe.audio.len(),
            probe.container_duration,
            probe.start,
            tag,
            self.media_est
        );
        self.snap.media_end = Some(self.media_est);
        self.snap.media_end_probe = tag.filter(|t| t.is_finite() && *t > 0.0);
        self.publish();

        // The OP decision on a complete HEAD (theme search, sibling lookup,
        // Layer 3) runs beside TAIL when there is a TAIL, so TAIL starts the
        // moment HEAD exits; it publishes as soon as it resolves.
        let mut side: Option<SideFut<'a>> = None;
        if req.op {
            let args = probe::head_args(&input, n);
            let region = self.stream_region(Which::Head, args, 0.0, 0.0, &mut side).await;
            let media_end = self.media_end_now();
            if let Some(o) = region.origin.filter(|_| region.failed.is_none()) {
                let end = (o + region.samples as f64 / SR as f64).min(probe::HEAD_SECS);
                self.snap.op_region = Some((0.0, end));
            }
            if region.complete && req.ed {
                self.d.drain_finished_loads();
                // A theme of the OP still downloading (the prefetch, on a
                // short file or a slow AnimeThemes) lands here first, so the
                // fork never fetches it a second time.
                self.d.settle_pending(Kind::Op).await;
                let mut fork = self.d.fork();
                side = Some(Box::pin(async move {
                    let d = fork.decide_kind(Kind::Op, &region, media_end).await;
                    (d, fork)
                }));
            } else {
                let d = self.d.decide_kind(Kind::Op, &region, media_end).await;
                self.apply(Kind::Op, d);
            }
        }
        if req.ed {
            let s = probe::tail_start(probe.container_duration, tag).unwrap_or((req.duration - probe::TAIL_SECS).max(0.0));
            let args = probe::tail_args(&input, n, s);
            let region = self.stream_region(Which::Tail, args, probe.start, s, &mut side).await;
            if let Some(o) = region.origin {
                if (o - s).abs() > 0.05 {
                    crate::devlog!(info, "skipdetect", "{} TAIL origin {o:.3} differs from -ss {s:.3} by {:.3}s", self.d.who, o - s);
                }
                if region.complete {
                    let end = probe::media_end(o, region.samples);
                    crate::devlog!(
                        info, "skipdetect",
                        "{} media end {end:.3} (early estimate {:.3}, container {:?})",
                        self.d.who,
                        self.media_est,
                        probe.container_duration
                    );
                    self.snap.media_end = Some(end);
                    self.snap.media_end_final = true;
                    self.snap.ed_region = Some((o, end));
                }
            }
            // The OP decision, if it is still running, finishes first: the ED
            // decision must see its catalogue (sibling cours) and loads.
            if let Some(f) = side.take() {
                let (d, fork) = f.await;
                self.join_fork(Kind::Op, d, fork);
                // TAIL's last progress event predates the merge: re-send it so
                // an ending whose only candidates came from sibling cours gets
                // its row before the ED decision.
                self.report_progress(Which::Tail, 1.0);
            }
            let d = self.d.decide_kind(Kind::Ed, &region, self.media_end_now()).await;
            self.apply(Kind::Ed, d);
        }
    }

    /// An ending can never share audio with the opening. On a file shorter
    /// than TAIL's 480 s, TAIL re-reads HEAD's audio (S clamps to 0), and Layer
    /// 3 then found the SAME in-story block as both kinds (Kaiju No. 8's 224 s
    /// Narumi special: 34.8-117 s as OP and as ED). A continuity ED that
    /// overlaps the published opening is withdrawn; when that opening is a
    /// continuity window too, it goes as well, since one loudness block
    /// claimed by both kinds is evidence for neither (precision first). A
    /// Layer 1 opening stands. Runs on the ED decision, after the OP's.
    fn no_ed_inside_the_opening(&mut self, kind: Kind, decision: Decision) -> Decision {
        let Decision::Window(w) = &decision else { return decision };
        if kind != Kind::Ed {
            return decision;
        }
        let Some(op) = self.snap.op.clone() else { return decision };
        let Some(with_op) = continuity_ed_clash(w, &op) else { return decision };
        crate::devlog!(
            info, "skipdetect",
            "{} ED continuity [{:.2}, {:.2}] overlaps the opening [{:.2}, {:.2}] {}: withdrawn{}",
            self.d.who,
            w.start,
            w.end,
            op.start,
            op.end,
            op.source,
            if with_op { " with the opening" } else { "" }
        );
        if with_op {
            self.set_window(Kind::Op, None);
            self.set_note(Kind::Op, "continuity window shared with the ending's; withdrawn".into());
        }
        Decision::Abstain {
            note: "continuity ending overlaps the opening; withdrawn".into(),
            cacheable: true,
            l1: L1State::NoThemes,
        }
    }

    /// Merge a forked decision back and publish its verdict.
    fn join_fork(&mut self, kind: Kind, d: Decision, fork: Decider<'a>) {
        self.d.merge(fork);
        self.apply(kind, d);
    }

    /// The kind's candidates usable while streaming: loaded themes in order.
    /// `early` (HEAD) marks the ones the early provisional rule may fire on.
    fn streaming_themes(&self, kind: Kind, early: bool) -> Vec<StreamTheme> {
        self.d
            .cat
            .order(kind)
            .into_iter()
            .filter_map(|i| {
                let t = self.d.loader.loaded.get(&i)?.clone();
                let early = early && !self.d.cat.metas[i].any_over() && !self.transition_blocked(kind, i);
                Some(StreamTheme { idx: i, t, early })
            })
            .collect()
    }

    /// Publish the early provisional window (prompt-only, its own source).
    fn publish_early(&mut self, kind: Kind, idx: usize, run: &matcher::Run, margin: f64, window: (f64, f64), decoded_s: f64) {
        // Same start rule as the full match: the theme's audible start.
        let lead = self.d.loader.loaded.get(&idx).map_or(0.0, |t| t.audible.0);
        let start = matcher::early_audible_start(run, lead, window.0);
        let Some((s, e)) = super::clamp_to_media_end(start, window.1, self.media_end_now()) else { return };
        let label = self.d.cat.recs[idx].label();
        crate::devlog!(
            info, "skipdetect",
            "{} {} early prompt {} after {decoded_s:.1}s of region (t+{:.1}s): [{s:.2}, {e:.2}] run {:.1}s ber {:.3} margin {:.3}",
            self.d.who,
            kind_name(kind),
            label,
            self.started.elapsed().as_secs_f64(),
            run.len_s,
            run.ber,
            margin
        );
        let out = WindowOut {
            start: s,
            end: e,
            source: EARLY_SOURCE.into(),
            auto_eligible: false,
            transition: false,
            theme: Some(label),
            run_s: Some(run.len_s),
            ber: Some(run.ber),
            margin: Some(margin),
            soft42: None,
            q35: None,
            mrel: None,
            refined: false,
        };
        self.set_window(kind, Some(out));
        self.publish();
    }

    /// Withdraw the early provisional window, if that is what the kind holds.
    fn withdraw_early(&mut self, kind: Kind, why: &str) {
        if !self.holds_early(kind) {
            return;
        }
        crate::devlog!(
            info, "skipdetect",
            "{} {} early prompt withdrawn (t+{:.1}s): {why}",
            self.d.who,
            kind_name(kind),
            self.started.elapsed().as_secs_f64()
        );
        self.set_window(kind, None);
        self.publish();
    }

    /// A Transition version must not stop the search while a full version of
    /// the same slug is a candidate.
    fn transition_blocked(&self, kind: Kind, i: usize) -> bool {
        let cat = &self.d.cat;
        let m = &cat.metas[i];
        m.transition && cat.order(kind).into_iter().any(|j| j != i && cat.metas[j].slug == m.slug && !cat.metas[j].transition)
    }

    fn media_end_now(&self) -> f64 {
        self.snap.media_end.unwrap_or(self.media_est)
    }

    /// The kind currently holds the early provisional window.
    fn holds_early(&self, kind: Kind) -> bool {
        match kind {
            Kind::Op => self.snap.op.as_ref(),
            Kind::Ed => self.snap.ed.as_ref(),
        }
        .is_some_and(|w| w.source == EARLY_SOURCE)
    }

    /// Publish (or refine) a streaming acceptance. Returns the window.
    fn accept_streaming(&mut self, kind: Kind, a: &Accepted, decoded_s: f64, first: bool) -> Option<(f64, f64)> {
        // The audible start now; the end stays mapping A's until the region
        // has finished and its levels can gate it (`published_window`).
        let w = match self.d.loader.loaded.get(&a.idx) {
            Some(t) => matcher::refine_layer1_window(&a.m, t.audible, kind == Kind::Ed, None, self.media_end_now())?,
            None => matcher::layer1_window(&a.m, self.media_end_now())?,
        };
        let out = layer1_out(&a.m, &self.d.cat.recs[a.idx], w, &self.d.cat.metas[a.idx], false);
        let prev = match kind {
            Kind::Op => self.snap.op.clone(),
            Kind::Ed => self.snap.ed.clone(),
        };
        // A provisional window with the very same edges must still be
        // replaced: the source (and auto-eligibility) is what changes.
        let changed = prev.as_ref().map_or(true, |p| {
            p.source != out.source || (p.start - out.start).abs() > 0.005 || (p.end - out.end).abs() > 0.005
        });
        if first {
            crate::devlog!(
                info, "skipdetect",
                "{} {} {} accepted after {decoded_s:.0}s of region: [{:.2}, {:.2}] run {:.1}s ber {:?} margin {:.3} soft42 {:?}",
                self.d.who,
                kind_name(kind),
                self.d.cat.recs[a.idx].label(),
                w.0,
                w.1,
                a.m.longest_run_s,
                a.m.run_ber,
                a.m.margin,
                a.m.soft42
            );
        }
        if changed {
            self.set_window(kind, Some(out));
            self.publish();
        }
        Some(w)
    }

    /// Stream one region. `side` is a forked decision running beside this
    /// pass (the OP decision during TAIL): it is polled with the pass and,
    /// when it resolves, merged and published at once. One left unresolved is
    /// the caller's to await.
    async fn stream_region(
        &mut self,
        which: Which,
        args: Vec<String>,
        rebase: f64,
        expect_origin: f64,
        side: &mut Option<SideFut<'a>>,
    ) -> RegionOut {
        let kind = which.kind();
        let mut out = RegionOut {
            fp: Arc::new(Fingerprint::default()),
            levels: Vec::new(),
            silences: Vec::new(),
            origin: None,
            samples: 0,
            complete: false,
            failed: None,
            early: None,
        };
        let Ok(_permit) = PASS_GATE.acquire().await else {
            out.failed = Some("pass gate closed".into());
            return out;
        };
        let started = std::time::Instant::now();
        let spawned = {
            #[cfg(test)]
            {
                match &self.d.ctx.replay {
                    Some(r) => Ok(Source::Replay(r.pass(which == Which::Head, &args))),
                    None => RegionPass::spawn_with(&self.d.ctx.ffmpeg, &args, rebase, self.d.ctx.background).map(Source::Ff),
                }
            }
            #[cfg(not(test))]
            {
                RegionPass::spawn_with(&self.d.ctx.ffmpeg, &args, rebase, self.d.ctx.background).map(Source::Ff)
            }
        };
        let mut pass = match spawned {
            Ok(p) => p,
            Err(e) => {
                out.failed = Some(format!("{} spawn failed: {}", which.name(), e.kind()));
                return out;
            }
        };
        let (cmd_tx, cmd_rx) = mpsc::channel::<WCmd>(32);
        let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<WEvt>();
        // The early provisional opening is a HEAD feature: TAIL decodes far
        // ahead of the playhead, so its full gate is in time on its own.
        let early = which == Which::Head;
        let worker = tokio::task::spawn_blocking(move || worker_loop(cmd_rx, evt_tx, expect_origin, early));
        let mut sent_themes: Vec<usize> = Vec::new();
        let mut origin: Option<f64> = None;
        // HEAD exits once decoded >= the accepted OP's end + 10 s.
        let mut op_end: Option<f64> = None;
        let mut killed = false;
        let mut accepted: Option<Accepted> = None;
        // Progress against what the region should hold (the same span the
        // early-end check below expects), reported per whole percent and held
        // under 100 until the region has ended.
        let span = match which {
            Which::Head => probe::HEAD_SECS.min(self.media_est),
            Which::Tail => self.media_est - expect_origin,
        }
        .max(1.0);
        let mut reported_pct = 0u32;
        self.report_progress(which, 0.0);

        enum Ev<'s> {
            Evt(Option<WEvt>),
            Load(Option<Result<LoadResult, tokio::task::JoinError>>),
            Pcm(std::io::Result<Option<Vec<i16>>>),
            Side((Decision, Decider<'s>)),
        }

        loop {
            // Theme set for incremental matching.
            let now: Vec<StreamTheme> = self.streaming_themes(kind, early);
            let ids: Vec<usize> = now.iter().map(|s| s.idx).collect();
            if ids != sent_themes {
                sent_themes = ids;
                let _ = cmd_tx.send(WCmd::Themes(now)).await;
            }
            if origin.is_none() {
                if let Some(o) = probe::region_origin(pass.first_pts(), rebase) {
                    origin = Some(o);
                    let _ = cmd_tx.send(WCmd::T0(o)).await;
                }
            }
            if let (Some(end), Some(o)) = (op_end, origin) {
                if matcher::head_exit_ready(o + pass.samples() as f64 / SR as f64, end) {
                    killed = true;
                    break;
                }
            }
            let has_loads = !self.d.loader.set.is_empty();
            let side_pending = side.is_some();
            let ev = tokio::select! {
                biased;
                e = evt_rx.recv() => Ev::Evt(e),
                l = self.d.loader.set.join_next(), if has_loads => Ev::Load(l),
                s = poll_side(side), if side_pending => Ev::Side(s),
                p = pass.next_pcm() => Ev::Pcm(p),
            };
            match ev {
                Ev::Evt(Some(WEvt::Matched { decoded_s, results })) => {
                    let order = self.d.cat.order(kind);
                    let mut results = results;
                    results.sort_by_key(|(i, _)| order.iter().position(|j| j == i).unwrap_or(usize::MAX));
                    if let Some(cur) = accepted.clone() {
                        // Refine the published window with more data (same theme).
                        if let Some((_, m)) = results.into_iter().find(|(i, m)| *i == cur.idx && m.accepted) {
                            let a = Accepted { idx: cur.idx, m };
                            if let Some(w) = self.accept_streaming(kind, &a, decoded_s, false) {
                                if which == Which::Head {
                                    op_end = Some(w.1);
                                }
                            }
                            accepted = Some(a);
                        }
                    } else if let Some((idx, m)) =
                        results.into_iter().find(|(i, m)| m.accepted && !self.transition_blocked(kind, *i))
                    {
                        let a = Accepted { idx, m };
                        let had_early = self.holds_early(kind);
                        if let Some(w) = self.accept_streaming(kind, &a, decoded_s, true) {
                            if which == Which::Head {
                                op_end = Some(w.1);
                            }
                            accepted = Some(a);
                            if early {
                                // The full gate settled it: the early tracker stops.
                                let _ = cmd_tx.send(WCmd::EarlyStop).await;
                                if had_early {
                                    crate::devlog!(
                                        info, "skipdetect",
                                        "{} {} early prompt replaced by the full match (t+{:.1}s)",
                                        self.d.who,
                                        kind_name(kind),
                                        self.started.elapsed().as_secs_f64()
                                    );
                                }
                            }
                        }
                    }
                }
                Ev::Evt(Some(WEvt::Early { decoded_s, event })) => match event {
                    // A full acceptance always wins over the provisional rule.
                    EarlyEvent::Fire { idx, run, margin, window } if accepted.is_none() => {
                        self.publish_early(kind, idx, &run, margin, window, decoded_s);
                    }
                    EarlyEvent::Fire { .. } => {}
                    EarlyEvent::Retract { why, .. } => {
                        self.withdraw_early(kind, why.as_str());
                    }
                },
                Ev::Evt(Some(WEvt::Finished { .. })) | Ev::Evt(None) => {
                    out.failed = Some("analysis worker stopped".into());
                    break;
                }
                Ev::Load(Some(r)) => {
                    let who = self.d.who.clone();
                    self.d.loader.absorb(r, &self.d.cat, &who);
                }
                Ev::Load(None) => {}
                Ev::Side((d, fork)) => {
                    *side = None;
                    self.join_fork(Kind::Op, d, fork);
                }
                Ev::Pcm(Ok(Some(pcm))) => {
                    if cmd_tx.send(WCmd::Pcm(pcm)).await.is_err() {
                        out.failed = Some("analysis worker stopped".into());
                        break;
                    }
                    let decoded = pass.samples() as f64 / SR as f64
                        + if which == Which::Head { origin.unwrap_or(0.0) } else { 0.0 };
                    let pct = ((decoded / span) * 100.0).clamp(0.0, 99.0) as u32;
                    if pct > reported_pct {
                        reported_pct = pct;
                        self.report_progress(which, pct as f64 / 100.0);
                    }
                }
                Ev::Pcm(Ok(None)) => break,
                Ev::Pcm(Err(e)) => {
                    out.failed = Some(format!("{} read failed: {e}", which.name()));
                    break;
                }
            }
        }
        // A provisional window the full gate never confirmed while streaming
        // goes now; the region's own decision (published right after) is the
        // answer.
        self.withdraw_early(kind, "region ended without a full match");
        self.report_progress(which, 1.0);
        let samples = pass.samples();
        let end = if killed || out.failed.is_some() { pass.kill().await } else { pass.finish().await };
        // A first-PTS line that arrived after the last PCM byte still counts.
        if origin.is_none() {
            if let Some(o) = probe::region_origin(end.first_pts, rebase) {
                origin = Some(o);
                let _ = cmd_tx.send(WCmd::T0(o)).await;
            }
        }
        let _ = cmd_tx.send(WCmd::Finish).await;
        drop(cmd_tx);
        let mut fin = None;
        while let Some(e) = evt_rx.recv().await {
            if let WEvt::Finished { fp, levels } = e {
                fin = Some((fp, levels));
                break;
            }
        }
        let _ = worker.await;
        if let Some((fp, levels)) = fin {
            out.fp = Arc::new(fp);
            out.levels = levels;
        }
        out.silences = end.silences;
        out.origin = origin;
        out.samples = samples;
        out.early = accepted;
        let decoded_s = samples as f64 / SR as f64;
        if out.failed.is_none() && !killed {
            if !end.success {
                out.failed = Some(format!(
                    "{} ffmpeg exit {:?}{}",
                    which.name(),
                    end.exit_code,
                    end.tail.last().map(|l| format!(": {l}")).unwrap_or_default()
                ));
            } else if origin.is_none() {
                out.failed = Some(format!("{}: no first-PTS line, region abstains", which.name()));
            } else {
                // A body that ends early looks exactly like success: check the
                // decoded span against what the region should hold.
                let o = origin.unwrap_or(0.0);
                let tol = if self.tag_known { 2.0 } else { 35.0 };
                let want_end = match which {
                    Which::Head => probe::HEAD_SECS.min(self.media_est),
                    Which::Tail => self.media_est,
                };
                if o + decoded_s + tol < want_end {
                    out.failed = Some(format!(
                        "{} ended early at {:.1}s (expected about {:.1}s)",
                        which.name(),
                        o + decoded_s,
                        want_end
                    ));
                } else {
                    out.complete = true;
                }
            }
        }
        crate::devlog!(
            info, "skipdetect",
            "{} {} {:.1}s decoded from origin {}{} in {:.1}s, {} silences{}{}",
            self.d.who,
            which.name(),
            decoded_s,
            origin.map_or("?".to_string(), |o| format!("{o:.3}")),
            if which == Which::Tail { format!(" (-ss {expect_origin:.3})") } else { String::new() },
            started.elapsed().as_secs_f64(),
            out.silences.len(),
            if killed { ", early exit" } else { "" },
            out.failed.as_deref().map(|f| format!(", {f}")).unwrap_or_default()
        );
        if out.failed.is_some() {
            self.d.cacheable = false;
        }
        out
    }

    /// Apply one kind's decision to the snapshot and publish it.
    fn apply(&mut self, kind: Kind, decision: Decision) {
        let name = kind_name(kind);
        let decision = self.no_ed_inside_the_opening(kind, decision);
        match decision {
            Decision::Window(mut w) => {
                // Rule 1: a window ends at the matched end clamped to the MEDIA
                // end (the final one once TAIL reached EOF), never the container.
                match super::clamp_to_media_end(w.start, w.end, self.media_end_now()) {
                    Some((_, e)) => w.end = e,
                    None => {
                        self.set_window(kind, None);
                        self.set_l1(kind, L1State::Unavailable);
                        self.set_note(kind, "window empty after clamping to media end".into());
                        self.publish();
                        return;
                    }
                }
                crate::devlog!(info, "skipdetect", "{} {name} final {}", self.d.who, fmt_win(&Some(w.clone())));
                // A continuity window is Layer 3: it only runs when Layer 1 had
                // no theme of the kind.
                if w.source != "animethemes" {
                    self.set_l1(kind, L1State::NoThemes);
                }
                self.set_window(kind, Some(w));
                match kind {
                    Kind::Op => self.snap.op_note = None,
                    Kind::Ed => self.snap.ed_note = None,
                }
            }
            Decision::Abstain { note, cacheable, l1 } => {
                crate::devlog!(info, "skipdetect", "{} {name} abstains: {note}", self.d.who);
                self.set_l1(kind, l1);
                if !cacheable {
                    self.d.cacheable = false;
                }
                // A streaming acceptance on a region that later failed keeps
                // its window only via the !complete branch in decide_kind.
                self.set_window(kind, None);
                self.set_note(kind, note);
            }
            Decision::NoThemes { note } => {
                self.set_window(kind, None);
                self.set_l1(kind, L1State::NoThemes);
                self.set_note(kind, note);
            }
        }
        self.publish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(url: &str) -> Request {
        serde_json::from_value(serde_json::json!({
            "url": url, "stremio_id": "tt14986406:3:1", "duration": 1436.24,
            "media_type": "series", "addon": "AIOStreams", "release": "BLEACH.S03E01.mkv",
            "mal_id": 56784, "mal_source": "aiometadata", "mal_episode": 1, "anime": true
        }))
        .unwrap()
    }

    #[test]
    fn request_defaults_and_validation() {
        let r = req("https://host.invalid/a/b/file.mkv?token=x").validate().unwrap();
        assert!(r.op && r.ed);
        assert_eq!(r.release_identity().as_deref(), Some("BLEACH.S03E01.mkv"));
        let mut r2 = r.clone();
        r2.release = None;
        assert_eq!(r2.release_identity().as_deref(), Some("file.mkv"), "final path segment, never the query");
        assert!(!r.who().contains("host.invalid"));
        assert!(req("file:///c:/x.mkv").validate().is_err());
        assert!(req("C:\\x.mkv").validate().is_err());
        assert!(req("https://x/ y").validate().is_err());
        let mut bad = req("https://x/y");
        bad.duration = f64::NAN;
        assert!(bad.validate().is_err());
        let mut sneaky = req("https://x/y");
        sneaky.addon = Some("https://evil/addon/manifest.json".into());
        assert_eq!(sneaky.validate().unwrap().addon.as_deref(), Some("<redacted>"));
        let mut a = req("https://x/y");
        a.audio_url = Some("ftp://x".into());
        assert!(a.validate().is_err());
    }

    #[test]
    fn snapshot_wire_names() {
        let s = Snapshot {
            generation: 3,
            state: JobState::Running,
            op: Some(WindowOut { start: 1.0, end: 2.0, source: "animethemes".into(), auto_eligible: true, ..Default::default() }),
            media_end: Some(1436.255),
            ..Default::default()
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["state"], "running");
        assert_eq!(v["op"]["auto_eligible"], true);
        assert_eq!(v["media_end_final"], false);
        let back: Snapshot = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
    }

    fn rec(slug: &str, op: bool, over: bool, transition: bool) -> ThemeRec {
        ThemeRec {
            audio_id: 1,
            basename: format!("{slug}.ogg"),
            link: "https://a.animethemes.moe/x.ogg".into(),
            size: 0,
            slug: slug.into(),
            op,
            version: None,
            episodes: None,
            over,
            over_partial: false,
            transition,
        }
    }

    fn catalog(ep: Option<u32>) -> Catalog {
        Catalog {
            recs: vec![],
            metas: vec![],
            primary_len: 0,
            state: ListState::Loaded,
            siblings_tried: false,
            siblings_incomplete: false,
            ep,
        }
    }

    #[test]
    fn catalog_order_siblings_after_primary_and_layer3_gate() {
        let mut c = catalog(Some(3));
        c.push_list(10, vec![rec("ED3", false, true, false), rec("OP1", true, false, false)]);
        c.primary_len = c.recs.len();
        assert_eq!(c.order(Kind::Ed), Vec::<usize>::new(), "the Over ED is never a candidate");
        // ...but it still counts as "Layer 1 had an ED theme": no Layer 3.
        assert_eq!(c.primary_themes_of_kind(Kind::Ed), 1);
        assert!(!super::super::layer3_allowed(c.primary_themes_of_kind(Kind::Ed)));
        c.push_list(11, vec![rec("ED1", false, false, false), rec("OP1", true, false, false)]);
        assert_eq!(c.order(Kind::Ed), vec![2]);
        assert_eq!(c.order(Kind::Op), vec![1, 3]);
        assert_eq!(c.primary_themes_of_kind(Kind::Ed), 1, "sibling themes never count");
        // Same slug in two cours is not "a version of the same theme".
        assert_ne!(c.metas[1].slug, c.metas[3].slug);

        // An Over-only OP list: evaluated (prompt-only at most) and, when it
        // is rejected, an informative abstain, never Layer 3.
        let mut o = catalog(Some(1));
        o.push_list(12, vec![rec("OP1", true, true, false)]);
        o.primary_len = o.recs.len();
        assert_eq!(o.order(Kind::Op), vec![0]);
        assert_eq!(o.primary_themes_of_kind(Kind::Op), 1);
        assert!(!super::super::layer3_allowed(o.primary_themes_of_kind(Kind::Op)));
    }

    #[test]
    fn layer3_gate_ignores_sibling_themes() {
        // The cour's own list is empty; a sibling cour has one ED that did not
        // match. The gate reads the cour's own count (0), not the candidate
        // count (1): Layer 3 runs (prompt-only), it is not an informative
        // abstain.
        let mut c = catalog(Some(5));
        c.primary_len = 0;
        c.push_list(99, vec![rec("ED1", false, false, false)]);
        assert_eq!(c.order(Kind::Ed), vec![0], "the sibling ED is still a Layer 1 candidate");
        assert_eq!(c.primary_themes_of_kind(Kind::Ed), 0);
        assert!(super::super::layer3_allowed(c.primary_themes_of_kind(Kind::Ed)));
    }

    /// Broadband seeded "music" (noise under a beat envelope plus a chirp), as
    /// in the matcher tests: every fingerprint bit carries signal.
    fn tone(secs: f64, seed: u64) -> Vec<f64> {
        let sr = SR as f64;
        let mut x = seed;
        let mut ph = 0.0f64;
        (0..(secs * sr) as usize)
            .map(|i| {
                x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let r = (x >> 11) as f64 / (1u64 << 53) as f64;
                let t = i as f64 / sr;
                let f = 300.0 * 10f64.powf((t % 2.3) / 2.3);
                ph += 2.0 * std::f64::consts::PI * f / sr;
                let env = 0.6 + 0.4 * (2.0 * std::f64::consts::PI * t / 0.45).sin();
                0.5 * env * (r * 2.0 - 1.0) + 0.3 * ph.sin()
            })
            .collect()
    }

    fn pcm(x: &[f64], gain: f64) -> Vec<i16> {
        x.iter().map(|v| (v * gain * 32767.0).clamp(-32768.0, 32767.0) as i16).collect()
    }

    /// Drive the real region worker with an opening at 0:00 and collect what it
    /// reports. `stop_after_s` = decoded seconds after which the job would
    /// send EarlyStop (its full gate accepted).
    fn run_worker(early_region: bool, early_theme: bool, stop_after_s: Option<f64>) -> Vec<(f64, EarlyEvent)> {
        let th = tone(70.0, 5);
        let th_pcm = pcm(&th, 0.8);
        let fp = Arc::new(animethemes::theme_fp_from_pcm(&rec("OP1", true, false, false), &th_pcm));
        let mut ep: Vec<f64> = tone(160.0, 9).iter().map(|v| v * 0.1).collect();
        for (i, v) in th.iter().enumerate() {
            ep[i] += v * 0.8;
        }
        let ep = pcm(&ep, 0.9);
        let (cmd_tx, cmd_rx) = mpsc::channel::<WCmd>(4);
        let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<WEvt>();
        let worker = std::thread::spawn(move || worker_loop(cmd_rx, evt_tx, 0.0, early_region));
        cmd_tx.blocking_send(WCmd::T0(0.0)).unwrap();
        cmd_tx.blocking_send(WCmd::Themes(vec![StreamTheme { idx: 0, t: fp, early: early_theme }])).unwrap();
        let chunk = SR as usize / 2;
        let mut stopped = false;
        for (k, c) in ep.chunks(chunk).enumerate() {
            cmd_tx.blocking_send(WCmd::Pcm(c.to_vec())).unwrap();
            // Let the worker drain the queue so it analyses (it only matches
            // with the queue empty), like a decoder slower than the analysis.
            while cmd_tx.capacity() < cmd_tx.max_capacity() {
                std::thread::yield_now();
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
            let decoded = ((k + 1) * chunk) as f64 / SR as f64;
            if !stopped && stop_after_s.is_some_and(|s| decoded >= s) {
                cmd_tx.blocking_send(WCmd::EarlyStop).unwrap();
                stopped = true;
            }
        }
        cmd_tx.blocking_send(WCmd::Finish).unwrap();
        worker.join().unwrap();
        let mut out = Vec::new();
        while let Ok(e) = evt_rx.try_recv() {
            if let WEvt::Early { decoded_s, event } = e {
                out.push((decoded_s, event));
            }
        }
        out
    }

    #[test]
    fn region_worker_publishes_the_early_opening_and_stops_on_request() {
        // The worker reports its progress to replay.rs' process-wide counter:
        // never beside a replayed job, whose pacing reads it.
        let _g = replay_lock();
        // HEAD with an eligible theme: fires about 12 s in.
        let ev = run_worker(true, true, Some(60.0));
        let Some(&(at, EarlyEvent::Fire { window, .. })) = ev.first() else { panic!("no early fire: {ev:?}") };
        // Never before EARLY_RUN_S of matched audio, and before the full gate
        // accepts at 60 s. HOW soon after 12 s depends on how far the worker
        // thread lags the feeder, which is scheduler timing under a parallel
        // test run (a 4 s bound failed 2 runs in 8 with all tests running,
        // firing at 16.5 and 19.5 s). Exact fire times under a lagging
        // analysis are covered deterministically by the ignored corpus test
        // skipdetect_early_rule_lagging_analysis.
        assert!((matcher::EARLY_RUN_S..60.0).contains(&at), "fired after {at} s");
        assert!(window.0 < 0.1, "{window:?}");
        // The full gate "accepted" at 60 s: nothing after it, no withdrawal.
        assert!(ev.iter().all(|(s, e)| matches!(e, EarlyEvent::Fire { .. }) || *s < 60.0), "{ev:?}");
        assert_eq!(ev.len(), 1, "{ev:?}");
        // Never told to stop: the whole theme decodes without a full accept
        // reaching the tracker, so it withdraws itself.
        let ev = run_worker(true, true, None);
        assert!(matches!(ev.last(), Some((_, EarlyEvent::Retract { why: matcher::EarlyRetract::Unconfirmed, .. }))), "{ev:?}");
        // TAIL (no tracker) and an ineligible theme ("Over"): nothing at all.
        assert!(run_worker(false, true, None).is_empty());
        assert!(run_worker(true, false, None).is_empty());
    }

    #[test]
    fn prefetch_targets_match_what_a_detect_loads_first() {
        let mut op1 = rec("OP1", true, false, false);
        op1.episodes = Some("1-12".into());
        let mut op2 = rec("OP2", true, false, false);
        op2.episodes = Some("13-24".into());
        let ed_over = rec("ED2", false, true, false);
        let mut ed1 = rec("ED1", false, false, false);
        ed1.episodes = Some("1-24".into());
        let list = vec![op1, op2, ed_over, ed1];
        // Episode 14: OP2 by range proximity, and ED1 (an Over ED is never a candidate).
        assert_eq!(prefetch_targets(&list, 7, Some(14), true, true), vec![1, 3]);
        assert_eq!(prefetch_targets(&list, 7, Some(2), true, false), vec![0]);
        assert_eq!(prefetch_targets(&list, 7, Some(2), false, true), vec![3]);
        // The same pick as the job's own prefetch (Catalog::order on the cour's list).
        let mut c = catalog(Some(14));
        c.push_list(7, list.clone());
        c.primary_len = c.recs.len();
        assert_eq!(c.order(Kind::Op).first(), Some(&1));
        assert_eq!(c.order(Kind::Ed).first(), Some(&3));
        assert!(prefetch_targets(&[], 7, Some(1), true, true).is_empty());
    }

    fn stored(op: bool, ed: bool, mal: Option<u32>) -> Snapshot {
        let l1 = |asked: bool| if asked { L1State::Matched } else { L1State::NotRequested };
        Snapshot {
            requested_op: op,
            requested_ed: ed,
            requested_mal: mal,
            op_l1: l1(op),
            ed_l1: l1(ed),
            edge_rule: EDGE_RULE,
            ..Default::default()
        }
    }

    #[test]
    fn result_cache_serves_only_covered_requests() {
        let full = req("https://x/y").validate().unwrap(); // op + ed, mal 56784
        let mut ed_only = full.clone();
        ed_only.op = false;
        let mut op_only = full.clone();
        op_only.ed = false;
        let mut probe_only = full.clone();
        probe_only.op = false;
        probe_only.ed = false;
        let mut no_mal = full.clone();
        no_mal.mal_id = None;
        let mut other_mal = full.clone();
        other_mal.mal_id = Some(1);

        // A different kind set.
        assert!(cached_serves(&stored(true, true, Some(56784)), &full));
        assert!(cached_serves(&stored(true, true, Some(56784)), &ed_only), "a full entry answers ED-only");
        assert!(!cached_serves(&stored(false, true, Some(56784)), &full), "an ED-only entry never answers OP+ED");
        assert!(!cached_serves(&stored(true, false, Some(56784)), &ed_only));
        assert!(cached_serves(&stored(true, false, Some(56784)), &op_only));
        assert!(cached_serves(&stored(false, false, Some(56784)), &probe_only));
        assert!(!cached_serves(&stored(false, false, Some(56784)), &op_only), "a probe-only entry answers no kind");
        // mal_id None vs Some.
        assert!(!cached_serves(&stored(true, true, None), &full), "a MAL-less result never answers a request with one");
        assert!(cached_serves(&stored(true, true, Some(56784)), &no_mal));
        assert!(cached_serves(&stored(true, true, None), &no_mal));
        assert!(!cached_serves(&stored(true, true, Some(56784)), &other_mal));
        // An entry written before the fields existed covers nothing.
        let legacy: Snapshot = serde_json::from_value(serde_json::json!({
            "generation": 0, "state": "done", "from_cache": false, "op": null, "ed": null,
            "op_note": null, "ed_note": null, "media_end": 1436.24, "media_end_final": true
        }))
        .unwrap();
        assert!(!cached_serves(&legacy, &full) && !cached_serves(&legacy, &ed_only));
        assert_eq!(legacy.media_end_probe, None);
        // Written with the request fields but before the Layer 1 states: it
        // may predate the Transition-only ED rule, so it answers no kind (a
        // probe-only request still takes it).
        let mut pre_l1 = stored(true, true, Some(56784));
        pre_l1.op_l1 = L1State::Unknown;
        pre_l1.ed_l1 = L1State::Unknown;
        assert!(!cached_serves(&pre_l1, &full) && !cached_serves(&pre_l1, &op_only) && !cached_serves(&pre_l1, &ed_only));
        assert!(cached_serves(&pre_l1, &probe_only));
        let back: Snapshot = serde_json::from_str(&serde_json::to_string(&stored(true, true, None)).unwrap()).unwrap();
        assert_eq!((back.op_l1, back.ed_l1), (L1State::Matched, L1State::Matched), "the states survive the cache");
    }

    #[test]
    fn a_continuity_ending_never_shares_the_openings_audio() {
        let w = |s: f64, e: f64, src: &str| WindowOut { start: s, end: e, source: src.into(), ..Default::default() };
        // Kaiju No. 8 Narumi (224 s): TAIL re-read HEAD, one block as both kinds.
        assert_eq!(continuity_ed_clash(&w(34.8, 117.0, "continuity"), &w(34.8, 117.0, "continuity")), Some(true));
        // A Layer 1 opening stands; only the ending goes.
        assert_eq!(continuity_ed_clash(&w(60.0, 120.0, "continuity"), &w(0.0, 89.0, "animethemes")), Some(false));
        // Apart (touching edges included): no clash.
        assert_eq!(continuity_ed_clash(&w(1300.0, 1390.0, "continuity"), &w(0.0, 89.0, "continuity")), None);
        assert_eq!(continuity_ed_clash(&w(89.0, 150.0, "continuity"), &w(0.0, 89.0, "continuity")), None);
        // A Layer 1 ending is never withdrawn by this rule.
        assert_eq!(continuity_ed_clash(&w(34.8, 117.0, "animethemes"), &w(34.8, 117.0, "continuity")), None);
    }

    #[test]
    fn a_stand_in_continuity_window_lives_no_longer_than_the_list_answer() {
        let l3 = WindowOut { start: 0.0, end: 89.0, source: "continuity".into(), ..Default::default() };
        let l1 = WindowOut { start: 0.0, end: 89.0, source: "animethemes".into(), auto_eligible: true, ..Default::default() };
        let snap = |op: Option<WindowOut>, ed: Option<WindowOut>| Snapshot { op, ed, ..Default::default() };
        let none: HashMap<Kind, u64> = HashMap::new();
        let op_miss: HashMap<Kind, u64> = [(Kind::Op, cache::THEME_LIST_MISS_TTL)].into_iter().collect();
        let ed_unlisted: HashMap<Kind, u64> = [(Kind::Ed, cache::THEME_LIST_HIT_TTL)].into_iter().collect();
        // Layer 3 with no stand-in recorded: the long TTL.
        assert_eq!(result_ttl(&snap(Some(l3.clone()), None), &none), cache::RESULT_TTL);
        // Layer 3 standing in for a theme-list miss: a day.
        assert_eq!(result_ttl(&snap(Some(l3.clone()), None), &op_miss), cache::THEME_LIST_MISS_TTL);
        assert_eq!(result_ttl(&snap(Some(l3.clone()), Some(l1.clone())), &op_miss), cache::THEME_LIST_MISS_TTL);
        // An OP-only list (an airing cour) and a continuity ED: never the
        // 30-day RESULT_TTL, the list's own 7 days, so an ED AnimeThemes adds
        // later reaches Layer 1 within a week.
        assert_eq!(result_ttl(&snap(Some(l1.clone()), Some(l3.clone())), &ed_unlisted), cache::THEME_LIST_HIT_TTL);
        assert!(result_ttl(&snap(None, Some(l3.clone())), &ed_unlisted) < cache::RESULT_TTL);
        // A Layer 1 window is never shortened by another kind's flag.
        assert_eq!(result_ttl(&snap(Some(l1.clone()), None), &op_miss), cache::RESULT_TTL);
        // No window: the abstention TTL as before.
        assert_eq!(result_ttl(&snap(None, None), &none), cache::RESULT_ABSTAIN_TTL);
    }

    #[test]
    fn the_layer3_list_ttl_is_per_kind() {
        // The cour's list answered with an OP only: a Layer 3 ED stands in
        // for an ED AnimeThemes may still add, for the list's 7 days.
        let mut c = catalog(Some(1));
        c.push_list(10, vec![rec("OP1", true, false, false)]);
        c.primary_len = c.recs.len();
        assert_eq!(c.primary_themes_of_kind(Kind::Ed), 0);
        assert_eq!(c.l3_list_ttl(), Some(cache::THEME_LIST_HIT_TTL));
        // AnimeThemes listed nothing for the cour, or no MAL id: a day.
        let mut empty = catalog(Some(1));
        empty.primary_len = 0;
        assert_eq!(empty.l3_list_ttl(), Some(cache::THEME_LIST_MISS_TTL));
        empty.state = ListState::NoMal;
        assert_eq!(empty.l3_list_ttl(), Some(cache::THEME_LIST_MISS_TTL));
        empty.state = ListState::Unavailable("down".into());
        assert_eq!(empty.l3_list_ttl(), None);
    }

    #[test]
    fn a_result_from_an_older_edge_rule_answers_no_kind() {
        let full = req("https://x/y").validate().unwrap();
        let mut probe_only = full.clone();
        probe_only.op = false;
        probe_only.ed = false;
        let mut old = stored(true, true, Some(56784));
        old.edge_rule = 0;
        assert!(!cached_serves(&old, &full), "mapping A windows must not be replayed");
        assert!(cached_serves(&old, &probe_only), "its media end still answers a probe-only request");
        old.edge_rule = EDGE_RULE;
        assert!(cached_serves(&old, &full));
        let back: Snapshot = serde_json::from_str(&serde_json::to_string(&stored(true, true, None)).unwrap()).unwrap();
        assert_eq!(back.edge_rule, EDGE_RULE, "the rule survives the cache");
    }

    // ── the decision's failure paths, driven through a fake theme loader ──

    /// An episode region (noise, no theme in it) and a matching level track.
    fn region_without_themes(secs: f64) -> RegionOut {
        let ep = pcm(&tone(secs, 77), 0.4);
        RegionOut {
            fp: Arc::new(super::super::fingerprint::fingerprint(&ep, 0.0)),
            levels: super::super::continuity::rms_levels(&ep),
            silences: Vec::new(),
            origin: Some(0.0),
            samples: ep.len() as u64,
            complete: true,
            failed: None,
            early: None,
        }
    }

    fn theme_of(secs: f64, seed: u64) -> Arc<ThemeFp> {
        Arc::new(animethemes::theme_fp_from_pcm(&rec("X", true, false, false), &pcm(&tone(secs, seed), 0.8)))
    }

    struct Harness {
        ctx: Ctx,
        req: Request,
        calls: Arc<std::sync::atomic::AtomicUsize>,
    }

    /// `answer(slug)` = (load result, delay ms). Sibling cours are pinned to
    /// none, so nothing here touches the network.
    fn harness(answer: impl Fn(&str) -> (Result<(Arc<ThemeFp>, bool), String>, u64) + Send + Sync + 'static) -> Harness {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let c2 = calls.clone();
        let ctx = Ctx {
            ffmpeg: OsString::from("ffmpeg-not-used"),
            data_dir: None,
            generation: 1,
            publish: Arc::new(|_: &Snapshot| {}),
            progress: Arc::new(|_: &Progress| {}),
            background: false,
            pre_probe: None,
            replay: None,
            fake_theme_load: Some(Arc::new(move |r: &ThemeRec| {
                c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                answer(&r.slug)
            })),
        };
        let mut req = req("https://x/y").validate().unwrap();
        req.sibling_mal_ids = Some(Vec::new());
        Harness { ctx, req, calls }
    }

    fn decider<'a>(h: &'a Harness, list: Vec<ThemeRec>) -> Decider<'a> {
        let mut cat = catalog(None);
        cat.push_list(56784, list);
        cat.primary_len = cat.recs.len();
        Decider {
            ctx: &h.ctx,
            req: &h.req,
            who: "test".into(),
            cat,
            loader: Loader::new(),
            cacheable: true,
            l3_list_ttl: HashMap::new(),
        }
    }

    fn abstain_of(d: Decision) -> (L1State, bool, String) {
        match d {
            Decision::Abstain { l1, cacheable, note } => (l1, cacheable, note),
            Decision::Window(w) => panic!("unexpected window {w:?}"),
            Decision::NoThemes { note } => panic!("unexpected NoThemes ({note})"),
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap()
    }

    #[test]
    fn a_theme_audio_outage_ends_undecided_after_two_failures() {
        let h = harness(|_| (Err("HTTP 503".into()), 0));
        let list = vec![
            rec("OP1", true, false, false),
            rec("OP2", true, false, false),
            rec("OP3", true, false, false),
            rec("OP4", true, false, false),
        ];
        let region = region_without_themes(120.0);
        let (d, siblings, downloads) = rt().block_on(async {
            let mut d = decider(&h, list);
            let out = d.decide_complete(Kind::Op, &region, 1400.0).await;
            (out, d.cat.siblings_tried, d.loader.downloads(Kind::Op))
        });
        let (l1, cacheable, note) = abstain_of(d);
        assert_eq!(l1, L1State::Unavailable, "{note}");
        assert!(!cacheable, "an outage is never cached");
        assert_eq!(h.calls.load(std::sync::atomic::Ordering::SeqCst), FAIL_STREAK_ABSTAIN, "stops after the streak");
        assert!(!siblings, "no sibling cour is looked up during an outage");
        assert_eq!(downloads, FAIL_STREAK_ABSTAIN, "every failed attempt counts against the cap");
    }

    #[test]
    fn a_failed_candidate_never_makes_an_informative_abstain() {
        // OP1 (the top candidate, possibly the right one) fails to load; OP2
        // loads and is rejected. Nothing says the file has no theme.
        let other = theme_of(70.0, 5);
        let h = harness(move |slug| if slug == "OP1" { (Err("timed out".into()), 0) } else { (Ok((other.clone(), true)), 0) });
        let region = region_without_themes(120.0);
        let d = rt().block_on(async {
            let mut d = decider(&h, vec![rec("OP1", true, false, false), rec("OP2", true, false, false)]);
            d.decide_complete(Kind::Op, &region, 1400.0).await
        });
        let (l1, cacheable, note) = abstain_of(d);
        assert_eq!(l1, L1State::Unavailable, "{note}");
        assert!(!cacheable);
        assert_eq!(h.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn every_theme_loaded_and_rejected_is_informative() {
        let other = theme_of(70.0, 5);
        let h = harness(move |_| (Ok((other.clone(), true)), 0));
        let region = region_without_themes(120.0);
        let d = rt().block_on(async {
            let mut d = decider(&h, vec![rec("OP1", true, false, false), rec("OP2", true, false, false)]);
            d.decide_complete(Kind::Op, &region, 1400.0).await
        });
        let (l1, cacheable, note) = abstain_of(d);
        assert_eq!(l1, L1State::Informative, "{note}");
        assert!(cacheable);
    }

    #[test]
    fn themes_shorter_than_the_run_gate_leave_the_kind_undecided() {
        // A short-form cour: its only OP reference is 20 s of audio, and it IS
        // in the episode. The 30 s run gate can never pass, so it says nothing
        // about the crowd's windows.
        let th = tone(20.0, 5);
        let short = Arc::new(animethemes::theme_fp_from_pcm(&rec("OP1", true, false, false), &pcm(&th, 0.8)));
        assert!(matcher::too_short_to_match(short.audible));
        let mut ep: Vec<f64> = tone(120.0, 9).iter().map(|v| v * 0.1).collect();
        for (i, v) in th.iter().enumerate() {
            ep[i + 11025 * 10] += v * 0.8;
        }
        let ep = pcm(&ep, 0.9);
        let region = RegionOut {
            fp: Arc::new(super::super::fingerprint::fingerprint(&ep, 0.0)),
            levels: super::super::continuity::rms_levels(&ep),
            silences: Vec::new(),
            origin: Some(0.0),
            samples: ep.len() as u64,
            complete: true,
            failed: None,
            early: None,
        };
        let s2 = short.clone();
        let h = harness(move |_| (Ok((s2.clone(), true)), 0));
        let d = rt().block_on(async {
            let mut d = decider(&h, vec![rec("OP1", true, false, false)]);
            d.decide_complete(Kind::Op, &region, 1400.0).await
        });
        let (l1, cacheable, note) = abstain_of(d);
        assert_eq!(l1, L1State::Unavailable, "{note}");
        assert!(cacheable, "a short theme stays short");
        // A short theme beside a full one that was really compared: informative.
        let t = SearchTally { failed: 0, evaluated_own: 1, short_own: 1 };
        assert!(matches!(exhausted_abstain(&t, false), Decision::Abstain { l1: L1State::Informative, .. }));
    }

    #[test]
    fn a_fork_inherits_an_in_flight_theme_instead_of_downloading_it_again() {
        let th = theme_of(70.0, 5);
        let h = harness(move |_| (Ok((th.clone(), true)), 150));
        let list = vec![rec("OP1", true, false, false), rec("ED1", false, false, false)];
        let (fork_loaded, calls_after, main_dl) = rt().block_on(async {
            let mut d = decider(&h, list);
            // The prefetch of the top OP (and the ED) is still downloading
            // when HEAD completes.
            let r0 = d.cat.recs[0].clone();
            let r1 = d.cat.recs[1].clone();
            d.loader.start(0, &r0, &h.ctx);
            d.loader.start(1, &r1, &h.ctx);
            d.drain_finished_loads();
            assert!(d.loader.pending.contains(&0), "still in flight");
            d.settle_pending(Kind::Op).await;
            let mut fork = d.fork();
            // The fork's decision asks for the same theme: no second download.
            fork.loader.start(0, &r0, &h.ctx);
            let loaded = fork.loader.wait_for(0, &fork.cat, "fork").await.is_some();
            let calls = h.calls.load(std::sync::atomic::Ordering::SeqCst);
            d.merge(fork);
            (loaded, calls, d.loader.downloads(Kind::Op))
        });
        assert!(fork_loaded);
        assert_eq!(calls_after, 2, "OP1 and ED1 were each loaded once");
        assert_eq!(main_dl, 1, "one real OP download, counted once");
    }

    #[test]
    fn merge_adds_the_forks_own_attempts() {
        let h = harness(|_| (Err("x".into()), 0));
        let mut d = decider(&h, vec![rec("OP1", true, false, false)]);
        d.loader.downloads.insert(Kind::Op, 1);
        let mut fork = d.fork();
        // The main loader keeps counting its own loads while the fork runs.
        d.loader.downloads.insert(Kind::Op, 2);
        fork.loader.downloads.insert(Kind::Op, 3);
        fork.loader.fail_streak.insert(Kind::Op, 2);
        d.merge(fork);
        assert_eq!(d.loader.downloads(Kind::Op), 4, "2 (main) + 2 spent by the fork");
        assert_eq!(d.loader.fail_streak(Kind::Op), 2);
    }

    #[test]
    fn published_windows_use_the_audible_start_and_the_gated_end() {
        // A 70 s ending theme inside a TAIL region, then 3 s of quiet card and
        // a LOUD preview: the end is cut before the preview's first sound.
        let th = tone(70.0, 5);
        let mut th_pcm = pcm(&th, 0.8);
        // 2 s of lead silence and 4 s of trailing fade in the theme FILE.
        for v in th_pcm.iter_mut().take(2 * 11025) {
            *v = 0;
        }
        let n = th_pcm.len();
        for v in th_pcm.iter_mut().skip(n - 4 * 11025) {
            *v = 0;
        }
        let tfp = Arc::new(animethemes::theme_fp_from_pcm(&rec("ED1", false, false, false), &th_pcm));
        assert!((tfp.audible.0 - 2.0).abs() < 0.06 && (tfp.audible.1 - 66.0).abs() < 0.06, "{:?}", tfp.audible);
        let origin = 1000.0;
        let at = 30.0; // the theme file starts 30 s into the region
        let mut ep: Vec<f64> = vec![0.0; 11025 * 160];
        for (i, &v) in th_pcm.iter().enumerate() {
            ep[i + 11025 * at as usize] += v as f64 / 32767.0;
        }
        // The preview starts 1.5 s after the theme's audible end (inside the fade).
        let onset = at + 66.0 + 1.5;
        for (i, v) in tone(40.0, 11).iter().enumerate() {
            ep[(onset * 11025.0) as usize + i] += v * 0.5;
        }
        let ep = pcm(&ep, 1.0);
        let q = super::super::fingerprint::fingerprint(&ep, origin);
        let m = matcher::evaluate_theme(&tfp.fp, tfp.audible, &q);
        assert!(m.accepted, "{:?}", m.reject);
        let region = RegionOut {
            fp: Arc::new(q),
            levels: super::super::continuity::rms_levels(&ep),
            silences: Vec::new(),
            origin: Some(origin),
            samples: ep.len() as u64,
            complete: true,
            failed: None,
            early: None,
        };
        let (s, e) = published_window(&m, Some(tfp.audible), Kind::Ed, &region, 2000.0).unwrap();
        let (s_a, e_a) = matcher::layer1_window(&m, 2000.0).unwrap();
        assert!((s - (origin + at + 2.0)).abs() < 0.1, "audible start: {s} (mapping A {s_a})");
        assert!((e - (origin + onset - matcher::ONSET_CUT_S)).abs() < 0.45, "cut before the onset: {e} (mapping A {e_a})");
        assert!(e < e_a);
        // While streaming (no levels yet): mapping A's end, the audible start.
        let mut streaming = region;
        streaming.levels.clear();
        let (s2, e2) = published_window(&m, Some(tfp.audible), Kind::Ed, &streaming, 2000.0).unwrap();
        assert_eq!((s2, e2), (s, e_a));
    }

    // ── the result cache's duration tolerance and the next-episode pre-scan ──

    /// Serialises the tests below: they drive the real job over a replay (one
    /// replayed region at a time: replay.rs' worker counter and the pass gate
    /// are process-wide) and one of them asserts the gate is free.
    static REPLAY_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn replay_lock() -> std::sync::MutexGuard<'static, ()> {
        REPLAY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn tmp_dir() -> PathBuf {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "aura-skipdetect-job-test-{}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_lookup_reads_one_neighbour_bucket_only_for_an_entry_keyed_within_tolerance() {
        let dir = tmp_dir();
        let rel = "BLEACH.S03E01.mkv";
        let mut q = req("https://x/y").validate().unwrap();
        let put = |c: f64, keyed: Option<f64>| {
            let mut s = stored(true, true, Some(56784));
            s.keyed_duration = keyed;
            cache::put_result(&dir, &cache::result_key(&q.stremio_id, rel, c), s, cache::RESULT_TTL);
        };
        // The pre-scan wrote under ffmpeg's 1430.15 ("1430.2").
        put(1430.15, Some(1430.15));
        q.duration = 1430.15;
        assert!(lookup_result(&dir, rel, &q).0.is_some(), "exact key");
        // mpv's 1430.148 keys "1430.1": served from the adjacent bucket.
        q.duration = 1430.148;
        assert!(lookup_result(&dir, rel, &q).0.is_some(), "neighbour, keyed 2 ms away");
        // ...but only for a request that entry covers.
        let mut other = q.clone();
        other.mal_id = Some(1);
        assert_eq!(lookup_result(&dir, rel, &other), (None, true));
        // Far from a boundary: the neighbour is never read.
        q.duration = 1430.11;
        assert_eq!(lookup_result(&dir, rel, &q), (None, false));
        // Same neighbour bucket, keyed 0.092 s away: rejected.
        let _ = std::fs::remove_file(dir.join(cache::RESULT_FILE));
        put(1430.24, Some(1430.24));
        q.duration = 1430.148;
        assert_eq!(lookup_result(&dir, rel, &q), (None, false));
        // An entry with no keyed duration (written before it existed) never
        // answers through a neighbour, but still answers its own bucket.
        let _ = std::fs::remove_file(dir.join(cache::RESULT_FILE));
        put(1430.15, None);
        q.duration = 1430.148;
        assert_eq!(lookup_result(&dir, rel, &q), (None, false));
        q.duration = 1430.16;
        assert!(lookup_result(&dir, rel, &q).0.is_some(), "an old entry still answers its exact bucket");
        let _ = std::fs::remove_dir_all(&dir);
    }

    const PRESCAN_MAL: u32 = 41_000;

    /// A 200 s episode: an opening theme at 10 s, an ending theme at 120 s,
    /// over low noise. Returns the episode PCM and the two themes' fingerprints.
    fn synthetic_episode() -> (Arc<Vec<i16>>, Arc<ThemeFp>, Arc<ThemeFp>) {
        let op = tone(70.0, 5);
        let ed = tone(70.0, 21);
        let mut ep: Vec<f64> = tone(200.0, 9).iter().map(|v| v * 0.1).collect();
        for (i, v) in op.iter().enumerate() {
            ep[i + 11025 * 10] += v * 0.8;
        }
        for (i, v) in ed.iter().enumerate() {
            ep[i + 11025 * 120] += v * 0.8;
        }
        let (op_rec, ed_rec) = theme_recs();
        let op_fp = Arc::new(animethemes::theme_fp_from_pcm(&op_rec, &pcm(&op, 0.8)));
        let ed_fp = Arc::new(animethemes::theme_fp_from_pcm(&ed_rec, &pcm(&ed, 0.8)));
        (Arc::new(pcm(&ep, 0.9)), op_fp, ed_fp)
    }

    fn theme_recs() -> (ThemeRec, ThemeRec) {
        let mut op = rec("OP1", true, false, false);
        op.audio_id = 901;
        let mut ed = rec("ED1", false, false, false);
        ed.audio_id = 902;
        (op, ed)
    }

    /// A replay of the synthetic episode: the probe reports `container`
    /// (ffmpeg's printed `Duration:`) and a DURATION tag of the PCM length.
    fn replay_of(ep: &Arc<Vec<i16>>, container: f64, audio: bool, pace_head: f64) -> Arc<super::super::replay::Replay> {
        use super::super::probe::{AudioTrack, ProbeInfo};
        use super::super::replay::{Clock, RegionData, Replay};
        let tag = ep.len() as f64 / SR as f64;
        let region = || Some(RegionData { pcm: ep.clone(), t0: 0.0, silences: Vec::new() });
        Arc::new(Replay {
            probe: ProbeInfo {
                container_duration: Some(container),
                start: 0.0,
                audio: if audio {
                    vec![AudioTrack {
                        rel: 0,
                        abs: 1,
                        lang: Some("jpn".into()),
                        dispositions: vec!["default".into()],
                        duration_tag: Some(tag),
                        title: None,
                    }]
                } else {
                    Vec::new()
                },
            },
            head: region(),
            tail: region(),
            head_first_pts: 0.0,
            keep_up: true,
            pace_head,
            pace_tail: 0.0,
            startup_s: 0.0,
            clock: Arc::new(std::sync::Mutex::new(Clock::default())),
            notes: std::sync::Mutex::new(Vec::new()),
        })
    }

    /// A context on `dir` whose theme loads answer from memory (no network).
    fn ctx_on(dir: &std::path::Path, replay: Option<Arc<super::super::replay::Replay>>, op: Arc<ThemeFp>, ed: Arc<ThemeFp>) -> Ctx {
        Ctx {
            ffmpeg: OsString::from("ffmpeg-not-used"),
            data_dir: Some(dir.to_path_buf()),
            generation: 0,
            publish: Arc::new(|_: &Snapshot| {}),
            progress: Arc::new(|_: &Progress| {}),
            background: true,
            pre_probe: None,
            replay,
            fake_theme_load: Some(Arc::new(move |r: &ThemeRec| {
                (Ok((if r.op { op.clone() } else { ed.clone() }, false)), 0)
            })),
        }
    }

    /// What the frontend sends (`op: "prescan"`), validated, with sibling
    /// cours pinned to none so no MyAnimeList lookup is made.
    fn prescan_template(mal: u32) -> Request {
        let p: PrescanRequest = serde_json::from_value(serde_json::json!({
            "url": "https://replay.invalid/Show.S01E02.mkv", "stremio_id": "tt0000001:1:2", "media_type": "series",
            "addon": "AIOStreams", "release": "Show.S01E02.mkv", "mal_id": mal, "mal_source": "aiometadata",
            "mal_episode": 2, "anime": true, "detect_op": true, "detect_ed": true
        }))
        .unwrap();
        let mut r = p.validate().unwrap();
        r.sibling_mal_ids = Some(Vec::new());
        r
    }

    /// The live Detect for the same episode later: mpv's duration `d`.
    fn live_req(d: f64, mal: u32, op: bool, ed: bool) -> Request {
        let mut r = prescan_template(mal);
        r.duration = d;
        r.op = op;
        r.ed = ed;
        r.validate().unwrap()
    }

    fn seed_theme_lists(dir: &std::path::Path) {
        let (op, ed) = theme_recs();
        cache::put_theme_list(dir, PRESCAN_MAL, Some(vec![op, ed]));
    }

    #[test]
    fn a_prescan_result_answers_the_live_detect_across_a_bucket_boundary() {
        let _g = replay_lock();
        // Its stored write must not race a parallel test's clear.
        let _c = cache::clear_test_lock();
        let dir = tmp_dir();
        seed_theme_lists(&dir);
        // A different cour, listed with nothing (cached miss): no network.
        cache::put_theme_list::<Vec<ThemeRec>>(&dir, PRESCAN_MAL + 1, None);
        let (ep, op_fp, ed_fp) = synthetic_episode();
        let c = 200.15;
        let rt = rt();
        let pre = rt.block_on(prescan(
            ctx_on(&dir, Some(replay_of(&ep, c, true, 0.0)), op_fp.clone(), ed_fp.clone()),
            prescan_template(PRESCAN_MAL),
        ));
        assert_eq!(pre.outcome, PrescanOutcome::Done, "{:?}", pre.note);
        assert!(pre.stored, "{:?}", pre.note);
        let fin = pre.snapshot.clone().unwrap();
        assert!(!fin.from_cache);
        // What the cache holds: the same snapshot through JSON (serde_json's
        // float parse may move a value by one ULP, the same way every time).
        let fin: Snapshot = serde_json::from_str(&serde_json::to_string(&fin).unwrap()).unwrap();
        assert!(fin.op.as_ref().is_some_and(|w| w.source == "animethemes"), "opening matched: {:?}", fin.op_note);
        assert!(fin.ed.as_ref().is_some_and(|w| w.source == "animethemes"), "ending matched: {:?}", fin.ed_note);
        assert!(fin.media_end_final);
        // mpv's duration within 4 ms of ffmpeg's, on the OTHER side of a
        // bucket boundary (the case the exact key missed).
        let d = [c - 0.004, c + 0.004]
            .into_iter()
            .find(|d| cache::duration_bucket(*d) != cache::duration_bucket(c))
            .expect("c sits within 4 ms of a boundary");
        // What a cache hit does to a stored Layer 1 window (its edges are final).
        let refined = |w: &Option<WindowOut>| {
            w.clone().map(|mut w| {
                if w.source == "animethemes" {
                    w.refined = true;
                }
                w
            })
        };
        // The live run has no replay: a cache miss would try to probe and fail.
        let live = |r: Request| {
            let ctx = ctx_on(&dir, None, op_fp.clone(), ed_fp.clone());
            rt.block_on(async move { run(&ctx, &r).await })
        };
        let s = live(live_req(d, PRESCAN_MAL, true, true));
        assert!(s.from_cache, "the live detect is served by the pre-scan's entry");
        assert_eq!(s.op, refined(&fin.op));
        assert_eq!(s.ed, refined(&fin.ed));
        assert_eq!((s.op_l1, s.ed_l1), (fin.op_l1, fin.ed_l1));
        assert_eq!((s.op_region, s.ed_region), (fin.op_region, fin.ed_region));
        assert_eq!((s.media_end, s.media_end_final), (fin.media_end, fin.media_end_final));
        // OP-only and ED-only live requests are served too.
        let s = live(live_req(d, PRESCAN_MAL, true, false));
        assert!(s.from_cache && s.ed.is_none() && s.ed_l1 == L1State::NotRequested);
        assert_eq!((s.op, s.op_l1, s.op_region), (refined(&fin.op), fin.op_l1, fin.op_region));
        let s = live(live_req(d, PRESCAN_MAL, false, true));
        assert!(s.from_cache && s.op.is_none() && s.op_l1 == L1State::NotRequested);
        assert_eq!((s.ed, s.ed_l1, s.ed_region), (refined(&fin.ed), fin.ed_l1, fin.ed_region));
        // Another cour's request is not.
        let s = live(live_req(d, PRESCAN_MAL + 1, true, true));
        assert!(!s.from_cache);
        // A second pre-scan of the same file is answered by the cache.
        let again = rt.block_on(prescan(
            ctx_on(&dir, Some(replay_of(&ep, c, true, 0.0)), op_fp.clone(), ed_fp.clone()),
            prescan_template(PRESCAN_MAL),
        ));
        assert_eq!(again.outcome, PrescanOutcome::Cached);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_aborted_prescan_writes_nothing_and_frees_the_pass_gate() {
        let _g = replay_lock();
        let dir = tmp_dir();
        seed_theme_lists(&dir);
        let (ep, op_fp, ed_fp) = synthetic_episode();
        let c = 200.15;
        // HEAD paced at 20 ms per audio second: about 4 s for the region.
        let replay = replay_of(&ep, c, true, 0.02);
        let clock = replay.clock.clone();
        let rt = rt();
        rt.block_on(async {
            let task = tokio::spawn(prescan(ctx_on(&dir, Some(replay), op_fp, ed_fp), prescan_template(PRESCAN_MAL)));
            let t = std::time::Instant::now();
            loop {
                let (region, delivered) = clock.lock().map(|c| (c.region, c.delivered_s)).unwrap();
                if region == "head" && delivered >= 20.0 {
                    break;
                }
                assert!(t.elapsed().as_secs() < 60, "HEAD never started");
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        });
        assert!(PASS_GATE.try_acquire().is_ok(), "the aborted pass released the gate");
        let key = cache::result_key("tt0000001:1:2", "Show.S01E02.mkv", c);
        assert!(cache::get_result::<Snapshot>(&dir, &key).is_none(), "nothing written");
        assert!(!dir.join(cache::RESULT_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_probe_with_no_audio_track_is_never_cached() {
        let _g = replay_lock();
        let dir = tmp_dir();
        seed_theme_lists(&dir);
        let (ep, op_fp, ed_fp) = synthetic_episode();
        let c = 200.15;
        let r = live_req(c, PRESCAN_MAL, true, true);
        let ctx = ctx_on(&dir, Some(replay_of(&ep, c, false, 0.0)), op_fp, ed_fp);
        let (s, written) = rt().block_on(async { run_stored(&ctx, &r).await });
        assert!(!written, "an undecided run is not a fact about the file");
        assert_eq!((s.op_l1, s.ed_l1), (L1State::Unavailable, L1State::Unavailable));
        assert!(!dir.join(cache::RESULT_FILE).exists());
        // Through the pre-scan entry point: ran, nothing stored.
        let ctx = ctx_on(&dir, Some(replay_of(&ep, c, false, 0.0)), theme_of(70.0, 5), theme_of(70.0, 6));
        let pre = rt().block_on(prescan(ctx, prescan_template(PRESCAN_MAL)));
        assert_eq!(pre.outcome, PrescanOutcome::Done);
        assert!(!pre.stored && pre.note.is_some());
        assert!(!dir.join(cache::RESULT_FILE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_prescan_request_needs_a_mal_id_and_a_kind() {
        let base = serde_json::json!({"url": "https://x.invalid/a.mkv", "stremio_id": "tt1:1:2", "mal_id": 5});
        let parse = |v: serde_json::Value| serde_json::from_value::<PrescanRequest>(v).unwrap().validate();
        let r = parse(base.clone()).unwrap();
        assert!(r.op && r.ed && r.mal_id == Some(5));
        let mut v = base.clone();
        v["mal_id"] = serde_json::json!(0);
        assert!(parse(v).is_err());
        let mut v = base.clone();
        v.as_object_mut().unwrap().remove("mal_id");
        assert!(parse(v).is_err());
        let mut v = base.clone();
        v["detect_op"] = serde_json::json!(false);
        v["detect_ed"] = serde_json::json!(false);
        assert!(parse(v).is_err());
        let mut v = base.clone();
        v["url"] = serde_json::json!("file:///c:/a.mkv");
        assert!(parse(v).is_err());
        // The probe's duration replaces the placeholder; a wire duration is ignored.
        let mut v = base;
        v["duration"] = serde_json::json!(1400.0);
        assert_eq!(parse(v).unwrap().duration, PRESCAN_PLACEHOLDER_DURATION);
    }
}
