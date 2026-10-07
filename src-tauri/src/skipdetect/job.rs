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
use super::matcher::{self, MatchSchedule, ThemeMatch};
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

/// A published window. Field names are the wire names (no serde renames).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WindowOut {
    pub start: f64,
    pub end: f64,
    /// "animethemes" (Layer 1) or "continuity" (Layer 3).
    pub source: String,
    /// False for Layer 3 and for an "Over" OP theme.
    pub auto_eligible: bool,
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
}

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
    (!req.op || stored.requested_op)
        && (!req.ed || stored.requested_ed)
        && (req.mal_id.is_none() || stored.requested_mal == req.mal_id)
}

/// Whether a stored result earns the long TTL (`cache::RESULT_TTL`): it holds a
/// window, and none of its windows is a Layer 3 window decided while the cour's
/// theme list was a miss (no MAL id, or AnimeThemes listed nothing for the
/// cour). Such a miss is cached for a day only (`THEME_LIST_MISS_TTL`), so a
/// continuity window standing in for it must not outlive it: when AnimeThemes
/// adds the cour, the next play after a day gets Layer 1.
fn result_lasts(s: &Snapshot, l3_after_miss: &HashSet<Kind>) -> bool {
    let from_miss = |w: &Option<WindowOut>, k: Kind| {
        w.as_ref().is_some_and(|w| w.source == "continuity" && l3_after_miss.contains(&k))
    };
    s.has_window() && !from_miss(&s.op, Kind::Op) && !from_miss(&s.ed, Kind::Ed)
}

/// What a detect needs from its host.
pub struct Ctx {
    pub ffmpeg: OsString,
    /// `app_data_dir()`; None disables every cache.
    pub data_dir: Option<PathBuf>,
    pub generation: u64,
    /// Called with every changed snapshot (the host filters stale generations).
    pub publish: Arc<dyn Fn(&Snapshot) + Send + Sync>,
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
}

// ── theme loader ────────────────────────────────────────────────────────────

type LoadResult = (usize, Result<(Arc<ThemeFp>, bool), String>);

struct Loader {
    set: JoinSet<LoadResult>,
    pending: HashSet<usize>,
    loaded: HashMap<usize, Arc<ThemeFp>>,
    failed: HashSet<usize>,
    downloads: HashMap<Kind, usize>,
}

impl Loader {
    fn new() -> Self {
        Self {
            set: JoinSet::new(),
            pending: HashSet::new(),
            loaded: HashMap::new(),
            failed: HashSet::new(),
            downloads: HashMap::new(),
        }
    }

    /// A loader for a forked decision: what is loaded or failed so far, and
    /// the download counts, but no in-flight load (a load still pending here
    /// is started again by the fork if it needs it).
    fn fork(&self) -> Self {
        Self {
            set: JoinSet::new(),
            pending: HashSet::new(),
            loaded: self.loaded.clone(),
            failed: self.failed.clone(),
            downloads: self.downloads.clone(),
        }
    }

    fn start(&mut self, i: usize, rec: &ThemeRec, ctx: &Ctx) {
        if self.pending.contains(&i) || self.loaded.contains_key(&i) || self.failed.contains(&i) {
            return;
        }
        self.pending.insert(i);
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
}

// ── region pass ─────────────────────────────────────────────────────────────

enum WCmd {
    Pcm(Vec<i16>),
    T0(f64),
    Themes(Vec<(usize, Arc<ThemeFp>)>),
    Finish,
}

enum WEvt {
    Matched { decoded_s: f64, results: Vec<(usize, ThemeMatch)> },
    Finished { fp: Fingerprint, levels: Vec<f32> },
}

/// The blocking-pool half of a region: fingerprint + RMS + incremental match.
fn worker_loop(mut rx: mpsc::Receiver<WCmd>, tx: mpsc::UnboundedSender<WEvt>, t0: f64) {
    let mut fpr = Fingerprinter::new(t0);
    let mut rms = RmsMeter::new();
    let mut sched = MatchSchedule::default();
    let mut themes: Vec<(usize, Arc<ThemeFp>)> = Vec::new();
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
                let results = themes.iter().map(|(i, t)| (*i, matcher::evaluate_theme(&t.fp, t.audible, q))).collect();
                if tx.send(WEvt::Matched { decoded_s, results }).is_err() {
                    return;
                }
            }
        }
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
    Abstain { note: String, cacheable: bool },
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
    /// Kinds whose Layer 3 window was decided while the cour's theme list was
    /// a miss (see `result_lasts`).
    l3_after_miss: HashSet<Kind>,
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

    fn fork(&self) -> Decider<'a> {
        Decider {
            ctx: self.ctx,
            req: self.req,
            who: self.who.clone(),
            cat: self.cat.clone(),
            loader: self.loader.fork(),
            cacheable: true,
            l3_after_miss: HashSet::new(),
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
        for (k, n) in fork.loader.downloads {
            let e = self.loader.downloads.entry(k).or_default();
            *e = (*e).max(n);
        }
        self.cacheable &= fork.cacheable;
        self.l3_after_miss.extend(fork.l3_after_miss);
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
    async fn decide_complete(&mut self, kind: Kind, q: Arc<Fingerprint>, media_end: f64) -> Decision {
        match &self.cat.state {
            ListState::NoMal => return Decision::NoThemes { note: "no MAL id".into() },
            ListState::Unavailable(e) => {
                return Decision::Abstain { note: format!("animethemes unavailable ({e})"), cacheable: false }
            }
            ListState::Loaded => {}
        }
        let mut verdict: HashMap<usize, bool> = HashMap::new();
        let mut matches: HashMap<usize, ThemeMatch> = HashMap::new();
        let mut uncertain = false;
        loop {
            let order = self.cat.order(kind);
            let passed: Vec<Option<bool>> = (0..self.cat.metas.len()).map(|i| verdict.get(&i).copied()).collect();
            match themes::next_step(&self.cat.metas, &order, &passed, self.loader.downloads(kind)) {
                Step::Evaluate(i) => {
                    let rec = self.cat.recs[i].clone();
                    self.loader.start(i, &rec, self.ctx);
                    let who = self.who.clone();
                    let Some(t) = self.loader.wait_for(i, &self.cat, &who).await else {
                        uncertain = true;
                        verdict.insert(i, false);
                        continue;
                    };
                    let q2 = q.clone();
                    let m = match tokio::task::spawn_blocking(move || matcher::evaluate_theme(&t.fp, t.audible, &q2)).await {
                        Ok(m) => m,
                        Err(_) => {
                            uncertain = true;
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
                    verdict.insert(i, m.accepted);
                    matches.insert(i, m);
                }
                Step::Accept(i) => {
                    let m = &matches[&i];
                    let Some(w) = matcher::layer1_window(m, media_end) else {
                        return Decision::Abstain { note: "matched window empty after clamping".into(), cacheable: true };
                    };
                    return Decision::Window(layer1_out(m, &self.cat.recs[i], w, &self.cat.metas[i]));
                }
                Step::CapReached => {
                    return Decision::Abstain {
                        note: format!("theme download cap ({}) reached", themes::MAX_DOWNLOADS_PER_KIND),
                        cacheable: false,
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
        let incomplete = self.cat.siblings_incomplete;
        Decision::Abstain {
            note: if incomplete {
                "themes exist but none matched (informative abstain; sibling lookup incomplete)".into()
            } else {
                "themes exist but none matched (informative abstain)".into()
            },
            cacheable: !uncertain && !incomplete,
        }
    }

    /// The whole decision for one kind and region: the streaming acceptance
    /// of an early-exited region, else Layer 1 over the complete region, then
    /// Layer 3 when Layer 1 had no themes of the kind.
    async fn decide_kind(&mut self, kind: Kind, region: &RegionOut, media_end: f64) -> Decision {
        let decision = if !region.complete {
            match &region.early {
                // HEAD killed after acceptance: the streaming window stands.
                Some(a) => match matcher::layer1_window(&a.m, media_end) {
                    Some(w) => Decision::Window(layer1_out(&a.m, &self.cat.recs[a.idx], w, &self.cat.metas[a.idx])),
                    None => Decision::Abstain { note: "matched window empty after clamping".into(), cacheable: true },
                },
                None => Decision::Abstain {
                    note: region.failed.clone().unwrap_or_else(|| "region incomplete".into()),
                    cacheable: false,
                },
            }
        } else {
            self.decide_complete(kind, region.fp.clone(), media_end).await
        };
        match decision {
            Decision::NoThemes { note } => {
                if self.req.anime {
                    // The Layer 2 counter (spec decision 14): how often an
                    // anime play had no Layer 1 themes for a kind.
                    crate::devlog!(info, "skipdetect", "{} layer1 counter {}: {note}", self.who, kind_name(kind));
                }
                // A theme-list miss (no MAL id, or AnimeThemes listing nothing
                // for the cour itself) is only cached for a day.
                let list_miss = match self.cat.state {
                    ListState::NoMal => true,
                    ListState::Loaded => self.cat.primary_len == 0,
                    ListState::Unavailable(_) => false,
                };
                let d = self.layer3(kind, region, &note).await;
                if list_miss && matches!(d, Decision::Window(_)) {
                    self.l3_after_miss.insert(kind);
                }
                d
            }
            d => d,
        }
    }

    /// Layer 3 (prompt-only) over a complete region.
    async fn layer3(&mut self, kind: Kind, region: &RegionOut, why: &str) -> Decision {
        let Some(t0) = region.origin.filter(|_| region.complete) else {
            return Decision::Abstain { note: format!("{why}; region incomplete for continuity"), cacheable: false };
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
            return Decision::Abstain { note: format!("{why}; continuity failed"), cacheable: false };
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
                theme: None,
                run_s: None,
                ber: None,
                margin: None,
                soft42: None,
                q35: Some(b.q35),
                mrel: Some(b.mrel),
            }),
            _ => Decision::Abstain {
                note: format!("{why}; continuity abstains ({})", o.abstain.map_or("no candidate", |a| a.as_str())),
                cacheable: true,
            },
        }
    }
}

// ── the job ─────────────────────────────────────────────────────────────────

struct Job<'a> {
    d: Decider<'a>,
    snap: Snapshot,
    /// Early media-end estimate (mapped DURATION tag, else container, else
    /// mpv's duration).
    media_est: f64,
    /// The duration tag was known (tight completeness tolerance).
    tag_known: bool,
}

/// Run one detect. Returns the final snapshot (state Done or Unavailable).
pub async fn run(ctx: &Ctx, req: &Request) -> Snapshot {
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
    let key = req.release_identity().map(|r| cache::result_key(&req.stremio_id, &r, req.duration));
    if let (Some(dir), Some(k)) = (ctx.data_dir.clone(), key.clone()) {
        let hit = tokio::task::spawn_blocking(move || cache::get_result::<Snapshot>(&dir, &k)).await.ok().flatten();
        match hit {
            Some(mut s) if cached_serves(&s, req) => {
                // A fuller entry answers a narrower request with exactly what a
                // fresh run of that request would have produced.
                if !req.op {
                    s.op = None;
                    s.op_note = None;
                }
                if !req.ed {
                    s.ed = None;
                    s.ed_note = None;
                }
                s.generation = ctx.generation;
                s.from_cache = true;
                s.state = JobState::Done;
                crate::devlog!(
                    info, "skipdetect",
                    "{who} result cache hit: op {} ed {} media_end {:?}",
                    fmt_win(&s.op),
                    fmt_win(&s.ed),
                    s.media_end
                );
                (ctx.publish)(&s);
                return s;
            }
            Some(_) => {
                crate::devlog!(debug, "skipdetect", "{who} result cache entry does not cover this request; detecting");
            }
            None => {}
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
            l3_after_miss: HashSet::new(),
        },
        snap: Snapshot {
            generation: ctx.generation,
            state: JobState::Running,
            requested_op: req.op,
            requested_ed: req.ed,
            requested_mal: req.mal_id,
            ..Default::default()
        },
        media_est: req.duration,
        tag_known: false,
    };
    job.run().await;
    job.snap.state = JobState::Done;
    (ctx.publish)(&job.snap);
    if job.d.cacheable {
        if let (Some(dir), Some(k)) = (ctx.data_dir.clone(), key) {
            let mut stored = job.snap.clone();
            stored.generation = 0;
            let lasts = result_lasts(&stored, &job.d.l3_after_miss);
            if stored.has_window() && !lasts {
                crate::devlog!(
                    info, "skipdetect",
                    "{} continuity window after a theme-list miss: result cached for a day only",
                    job.d.who
                );
            }
            let _ = tokio::task::spawn_blocking(move || cache::put_result(&dir, &k, stored, lasts)).await;
        }
    }
    job.snap
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

fn layer1_out(m: &ThemeMatch, rec: &ThemeRec, window: (f64, f64), meta: &ThemeMeta) -> WindowOut {
    WindowOut {
        start: window.0,
        end: window.1,
        source: "animethemes".into(),
        auto_eligible: themes::auto_eligible(meta),
        theme: Some(rec.label()),
        run_s: Some(m.longest_run_s),
        ber: m.run_ber,
        margin: Some(m.margin),
        soft42: m.soft42,
        q35: None,
        mrel: None,
    }
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

    fn set_note(&mut self, kind: Kind, note: String) {
        match kind {
            Kind::Op => self.snap.op_note = Some(note),
            Kind::Ed => self.snap.ed_note = Some(note),
        }
    }

    fn set_window(&mut self, kind: Kind, w: Option<WindowOut>) {
        match kind {
            Kind::Op => self.snap.op = w,
            Kind::Ed => self.snap.ed = w,
        }
    }

    async fn run(&mut self) {
        let req = self.d.req;
        let ctx = self.d.ctx;
        let input = req.audio_url.clone().unwrap_or_else(|| req.url.clone());
        // Probe and theme list in parallel.
        let probe_fut = async {
            let _permit = PASS_GATE.acquire().await.ok()?;
            Some(audio::run_probe(&ctx.ffmpeg, &input).await)
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
            None => return,
        };
        let Some((n, why)) = probe::pick_track(&probe.audio) else { return };
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
            if region.complete && req.ed {
                self.d.drain_finished_loads();
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
                }
            }
            // The OP decision, if it is still running, finishes first: the ED
            // decision must see its catalogue (sibling cours) and loads.
            if let Some(f) = side.take() {
                let (d, fork) = f.await;
                self.join_fork(Kind::Op, d, fork);
            }
            let d = self.d.decide_kind(Kind::Ed, &region, self.media_end_now()).await;
            self.apply(Kind::Ed, d);
        }
    }

    /// Merge a forked decision back and publish its verdict.
    fn join_fork(&mut self, kind: Kind, d: Decision, fork: Decider<'a>) {
        self.d.merge(fork);
        self.apply(kind, d);
    }

    /// The kind's candidates usable while streaming: loaded themes in order.
    fn streaming_themes(&self, kind: Kind) -> Vec<(usize, Arc<ThemeFp>)> {
        self.d
            .cat
            .order(kind)
            .into_iter()
            .filter_map(|i| self.d.loader.loaded.get(&i).map(|t| (i, t.clone())))
            .collect()
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

    /// Publish (or refine) a streaming acceptance. Returns the window.
    fn accept_streaming(&mut self, kind: Kind, a: &Accepted, decoded_s: f64, first: bool) -> Option<(f64, f64)> {
        let w = matcher::layer1_window(&a.m, self.media_end_now())?;
        let out = layer1_out(&a.m, &self.d.cat.recs[a.idx], w, &self.d.cat.metas[a.idx]);
        let prev = match kind {
            Kind::Op => self.snap.op.clone(),
            Kind::Ed => self.snap.ed.clone(),
        };
        let changed = prev.as_ref().map_or(true, |p| (p.start - out.start).abs() > 0.005 || (p.end - out.end).abs() > 0.005);
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
        let mut pass = match RegionPass::spawn(&self.d.ctx.ffmpeg, &args, rebase) {
            Ok(p) => p,
            Err(e) => {
                out.failed = Some(format!("{} spawn failed: {}", which.name(), e.kind()));
                return out;
            }
        };
        let (cmd_tx, cmd_rx) = mpsc::channel::<WCmd>(32);
        let (evt_tx, mut evt_rx) = mpsc::unbounded_channel::<WEvt>();
        let worker = tokio::task::spawn_blocking(move || worker_loop(cmd_rx, evt_tx, expect_origin));
        let mut sent_themes: Vec<usize> = Vec::new();
        let mut origin: Option<f64> = None;
        // HEAD exits once decoded >= the accepted OP's end + 10 s.
        let mut op_end: Option<f64> = None;
        let mut killed = false;
        let mut accepted: Option<Accepted> = None;

        enum Ev<'s> {
            Evt(Option<WEvt>),
            Load(Option<Result<LoadResult, tokio::task::JoinError>>),
            Pcm(std::io::Result<Option<Vec<i16>>>),
            Side((Decision, Decider<'s>)),
        }

        loop {
            // Theme set for incremental matching.
            let now: Vec<(usize, Arc<ThemeFp>)> = self.streaming_themes(kind);
            let ids: Vec<usize> = now.iter().map(|(i, _)| *i).collect();
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
                        if let Some(w) = self.accept_streaming(kind, &a, decoded_s, true) {
                            if which == Which::Head {
                                op_end = Some(w.1);
                            }
                            accepted = Some(a);
                        }
                    }
                }
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
                }
                Ev::Pcm(Ok(None)) => break,
                Ev::Pcm(Err(e)) => {
                    out.failed = Some(format!("{} read failed: {e}", which.name()));
                    break;
                }
            }
        }
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
        match decision {
            Decision::Window(mut w) => {
                // Rule 1: a window ends at the matched end clamped to the MEDIA
                // end (the final one once TAIL reached EOF), never the container.
                match super::clamp_to_media_end(w.start, w.end, self.media_end_now()) {
                    Some((_, e)) => w.end = e,
                    None => {
                        self.set_window(kind, None);
                        self.set_note(kind, "window empty after clamping to media end".into());
                        self.publish();
                        return;
                    }
                }
                crate::devlog!(info, "skipdetect", "{} {name} final {}", self.d.who, fmt_win(&Some(w.clone())));
                self.set_window(kind, Some(w));
                match kind {
                    Kind::Op => self.snap.op_note = None,
                    Kind::Ed => self.snap.ed_note = None,
                }
            }
            Decision::Abstain { note, cacheable } => {
                crate::devlog!(info, "skipdetect", "{} {name} abstains: {note}", self.d.who);
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

    fn stored(op: bool, ed: bool, mal: Option<u32>) -> Snapshot {
        Snapshot { requested_op: op, requested_ed: ed, requested_mal: mal, ..Default::default() }
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
    }

    #[test]
    fn continuity_after_list_miss_gets_the_short_ttl() {
        let l3 = WindowOut { start: 0.0, end: 89.0, source: "continuity".into(), ..Default::default() };
        let l1 = WindowOut { start: 0.0, end: 89.0, source: "animethemes".into(), auto_eligible: true, ..Default::default() };
        let snap = |op: Option<WindowOut>, ed: Option<WindowOut>| Snapshot { op, ed, ..Default::default() };
        let none: HashSet<Kind> = HashSet::new();
        let op_miss: HashSet<Kind> = [Kind::Op].into_iter().collect();
        // Layer 3 with themes simply absent for the kind (the list answered):
        // a stable fact, the long TTL.
        assert!(result_lasts(&snap(Some(l3.clone()), None), &none));
        // Layer 3 standing in for a theme-list miss: no longer than the miss.
        assert!(!result_lasts(&snap(Some(l3.clone()), None), &op_miss));
        assert!(!result_lasts(&snap(Some(l3.clone()), Some(l1.clone())), &op_miss));
        // A Layer 1 window is never shortened by another kind's flag.
        assert!(result_lasts(&snap(Some(l1.clone()), None), &op_miss));
        // No window: the abstention TTL as before.
        assert!(!result_lasts(&snap(None, None), &none));
    }
}
