// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/ ──────────────────────────────────────────────────────────────
//
// Layered automatic OP / ED detection.
//
//   fingerprint  Haitsma-Kalker sub-fingerprints, streaming (Layer 1 input).
//   matcher      Layer 1: an AnimeThemes theme located in a region, the accept
//                gates (30 s run, BER 0.35, margin 0.15, soft42 0.85) and the
//                chained window. HIGH trust.
//   themes       Candidate order (episode-range proximity, "Over" handling),
//                the Transition rule and the 8-download cap.
//   continuity   Layer 3: loudness continuity between silences. LOW trust,
//                prompt-only, runs only when Layer 1 had no themes of a kind.
//   probe        argv builders and stderr parsers for the three ffmpeg opens.
//   audio        the ffmpeg processes: probe (retry once), one region pass
//                with stdout / stderr drained concurrently, theme decode.
//   animethemes  the AnimeThemes client (one base URL, rustls, https only,
//                GET only, paced) and theme fingerprints.
//   cache        animethemes-v1.json, theme-fp/, skipdetect-v1.json (bounded,
//                atomic, oldest first, under app_data_dir).
//   job          one detect end to end (probe -> HEAD -> TAIL).
//
// One Tauri command, `skip_detect`, takes a tagged action (detect / cancel /
// status / prefetch / prescan / prescan_cancel) so the three registration
// sites cover the whole feature. Detect
// awaits the final result; every intermediate change (an OP accepted while
// HEAD is still decoding, the media end at TAIL EOF) is also emitted as a
// `skipdetect-update` event and readable through Status. A module-level
// generation counter (no Tauri managed state) makes each Detect supersede the
// previous one: the old task is aborted (its ffmpeg dies with kill_on_drop,
// its theme JoinSet is dropped) and anything it would still publish is
// discarded as stale.
//
// The next-episode pre-scan (`prescan`) runs the same job on the stream
// Next-Up pre-resolved, in its OWN slot (never GENERATION / RUNNING / LATEST),
// publishing nowhere, so its final result lands in the result cache before
// that episode plays. A live Detect always wins: it aborts a running
// pre-scan before anything else (`live_begin`), so the pre-scan never makes
// it wait on the pass gate, and no pre-scan starts while one is running.
//
// Layer 2 (blind pairing against earlier episodes) is deliberately NOT here:
// the spec's decision 14 defers it (it changed no final answer on the corpus).
// A `[skipdetect] layer1 counter` line is logged instead.
//
// Invariants (spec "Rules that are NOT negotiable"):
//   * an ED window ends at the matched theme end (Layer 1, cut back inside
//     the theme's trailing fade by the episode's own loudness) or a silence
//     (Layer 3), clamped to MEDIA end, never the container duration;
//   * nothing auto-advances before end of stream (the frontend's job; this
//     module never asks for a "skip to next" of any kind);
//   * every threshold miss abstains (a missing window beats a wrong one);
//   * all CPU work runs off the async runtime (blocking pool), never on the
//     mpv engine thread, and nothing here polls mpv;
//   * logs carry the addon label and `{type}/{id}`, never a URL.
//
// Reference implementation and evidence: the skipbench research corpus
// (31 real episodes with frame-verified truth). The ignored tests in
// `corpus_tests.rs` and `runtime_tests.rs` hold this port to it.

pub mod animethemes;
pub mod audio;
pub mod cache;
pub mod continuity;
pub mod fingerprint;
pub mod job;
pub mod matcher;
pub mod probe;
pub mod themes;

#[cfg(test)]
mod corpus_tests;
#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
pub(crate) mod replay;
#[cfg(test)]
mod runtime_tests;

use std::path::PathBuf;
use std::collections::VecDeque;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

pub use job::{JobState, Request, Snapshot};

/// Event carrying every snapshot change of the CURRENT detect.
pub const UPDATE_EVENT: &str = "skipdetect-update";
/// Event carrying the current detect's decode progress (`job::Progress`).
pub const PROGRESS_EVENT: &str = "skipdetect-progress";

/// Bumped by every Detect and Cancel; a job publishes only while it is current.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The running detect: its generation and abort handle.
static RUNNING: Mutex<Option<(u64, tokio::task::AbortHandle)>> = Mutex::new(None);
/// The latest snapshot of the current generation (for Status).
static LATEST: Mutex<Option<Snapshot>> = Mutex::new(None);

fn is_current(generation: u64) -> bool {
    GENERATION.load(Ordering::SeqCst) == generation
}

fn store_latest(s: &Snapshot) {
    if let Ok(mut l) = LATEST.lock() {
        *l = Some(s.clone());
    }
}

/// Abort the running detect, if any. True when one was running.
fn abort_running() -> bool {
    if let Ok(mut r) = RUNNING.lock() {
        if let Some((_, h)) = r.take() {
            h.abort();
            return true;
        }
    }
    false
}

/// Supersede every detect: bump the generation (anything a detect still
/// publishes is dropped as stale), abort the running one (its ffmpeg dies
/// with kill_on_drop) and forget the latest snapshot. What the Cancel action
/// does, and what a main-page reload calls (lib.rs `on_page_load`): a reload
/// stops playback, so a detect must not keep reading the stream. Returns
/// whether a detect was running. Never blocks.
pub fn cancel_all() -> bool {
    let was_running = cancel_generation().1;
    // The page that asked for a pre-scan is gone too.
    let _ = abort_prescan(WHY_CANCELLED);
    was_running
}

fn cancel_generation() -> (u64, bool) {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let was_running = abort_running();
    if let Ok(mut l) = LATEST.lock() {
        *l = None;
    }
    (generation, was_running)
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum SkipDetectAction {
    /// Start a detect for the loaded file (supersedes any running one) and
    /// await its final result.
    Detect(Request),
    /// Stop the running detect (stop / file change). Idempotent.
    Cancel,
    /// The current detect's latest snapshot.
    Status,
    /// Warm the theme caches for the cour of the episode Next-Up pre-resolved
    /// (theme list + top-ranked fingerprints, never episode audio). Returns at
    /// once; at most one runs at a time and it is not cancelled by a Detect.
    Prefetch(job::PrefetchRequest),
    /// Run the full detect on the stream Next-Up pre-resolved for the next
    /// episode, in the background, so its result is cached when it plays.
    /// `{op: "prescan", url, stremio_id, media_type?, addon?, release?,
    /// mal_id, mal_source?, mal_episode?, anime?, detect_op, detect_ed}`: no
    /// duration (the probe's is used). Awaits the end; preempted by any Detect.
    Prescan(job::PrescanRequest),
    /// Abort the running pre-scan, if any. Idempotent. Cancel does NOT stop a
    /// pre-scan (exit playback lets it finish), this does.
    PrescanCancel,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum SkipDetectReply {
    /// The final snapshot of a detect (`superseded` when a newer Detect or a
    /// Cancel replaced it: the caller must ignore it).
    Detected { snapshot: Snapshot, superseded: bool },
    Cancelled { generation: u64 },
    Status { snapshot: Option<Snapshot> },
    /// `started` false: another prefetch is running, no ffmpeg, or the
    /// request was invalid (nothing to do; never an error for the caller).
    Prefetch { started: bool },
    /// `{result: "prescan", outcome, note}`: outcome is one of "done",
    /// "cached", "preempted", "cancelled", "busy", "unavailable"
    /// (`job::PrescanOutcome`); `note` is a short reason or null, never a URL.
    Prescan { outcome: job::PrescanOutcome, note: Option<String> },
    /// `{result: "prescan_cancelled", was_running}`.
    PrescanCancelled { was_running: bool },
}

/// `app_data_dir()`, created on demand.
pub fn data_dir(app: &AppHandle) -> Option<PathBuf> {
    let d = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

#[tauri::command]
pub async fn skip_detect(app: AppHandle, action: SkipDetectAction) -> Result<SkipDetectReply, String> {
    match action {
        SkipDetectAction::Status => Ok(SkipDetectReply::Status {
            snapshot: LATEST.lock().ok().and_then(|l| l.clone()).filter(|s| is_current(s.generation)),
        }),
        SkipDetectAction::Cancel => {
            let (generation, _) = cancel_generation();
            crate::devlog!(debug, "skipdetect", "cancel (generation {generation})");
            Ok(SkipDetectReply::Cancelled { generation })
        }
        SkipDetectAction::Detect(req) => detect(app, req).await,
        SkipDetectAction::Prefetch(req) => Ok(SkipDetectReply::Prefetch { started: start_prefetch(app, req).await }),
        SkipDetectAction::Prescan(req) => Ok(prescan(app, req).await),
        SkipDetectAction::PrescanCancel => {
            let was_running = abort_prescan(WHY_CANCELLED);
            crate::devlog!(debug, "skipdetect", "prescan cancel (was running: {was_running})");
            Ok(SkipDetectReply::PrescanCancelled { was_running })
        }
    }
}

// -- next-episode pre-scan slot ----------------------------------------------

/// Live detects in flight (`detect` holds a `LiveGuard` for its whole run).
static LIVE_ACTIVE: AtomicUsize = AtomicUsize::new(0);
/// The running pre-scan: its id, abort handle and the reason it was aborted.
static PRESCAN: Mutex<Option<PrescanSlot>> = Mutex::new(None);
static PRESCAN_SEQ: AtomicU64 = AtomicU64::new(0);
/// Bumped (under the `PRESCAN` lock) by every cancel, slot empty or not. A
/// pre-scan reads it on entry and refuses to install once it moved, so a
/// cancel sent while the pre-scan was still awaiting the ffmpeg check (before
/// it reached the slot) is not lost. A preemption needs no bump: LIVE_ACTIVE
/// covers it.
static PRESCAN_CANCEL_EPOCH: AtomicU64 = AtomicU64::new(0);

const WHY_NONE: u8 = 0;
const WHY_PREEMPTED: u8 = 1;
const WHY_CANCELLED: u8 = 2;

struct PrescanSlot {
    id: u64,
    abort: tokio::task::AbortHandle,
    /// Set before `abort`, read by the awaiting command to word its outcome.
    why: Arc<AtomicU8>,
}

/// Held by a live detect; decrements `LIVE_ACTIVE` on every exit (unwind
/// included).
struct LiveGuard;

impl Drop for LiveGuard {
    fn drop(&mut self) {
        LIVE_ACTIVE.fetch_sub(1, Ordering::SeqCst);
    }
}

/// A live detect begins: count it FIRST, then abort the running pre-scan (its
/// future drops: the pass-gate permit is released, ffmpeg is killed, its theme
/// JoinSet goes), so the live passes never queue behind it. A pre-scan that
/// installs itself after this count reads it and steps back (`install_prescan`).
fn live_begin() -> LiveGuard {
    LIVE_ACTIVE.fetch_add(1, Ordering::SeqCst);
    let guard = LiveGuard;
    if abort_prescan(WHY_PREEMPTED) {
        crate::devlog!(info, "skipdetect", "next-episode prescan preempted by a live detect");
    }
    guard
}

fn live_active() -> bool {
    LIVE_ACTIVE.load(Ordering::SeqCst) > 0
}

/// Abort the running pre-scan, recording why. True when one was running.
fn abort_prescan(why: u8) -> bool {
    let Ok(mut slot) = PRESCAN.lock() else { return false };
    if why == WHY_CANCELLED {
        PRESCAN_CANCEL_EPOCH.fetch_add(1, Ordering::SeqCst);
    }
    match slot.take() {
        Some(p) => {
            p.why.store(why, Ordering::SeqCst);
            p.abort.abort();
            true
        }
        None => false,
    }
}

/// Install a pre-scan task in the slot, superseding (cancelling) a running
/// one. Busy when a live detect is in flight, checked before AND after the
/// install: a detect that began in between may have found the slot without
/// this task and could not abort it, so the task steps back itself. Cancelled
/// when a cancel came after the pre-scan read `epoch` (checked under the lock
/// `abort_prescan` takes, so a cancel either lands before this check or finds
/// the task in the slot).
fn install_prescan(abort: tokio::task::AbortHandle, epoch: u64) -> Result<(u64, Arc<AtomicU8>), job::PrescanOutcome> {
    if live_active() {
        return Err(job::PrescanOutcome::Busy);
    }
    let id = PRESCAN_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let why = Arc::new(AtomicU8::new(WHY_NONE));
    {
        let Ok(mut slot) = PRESCAN.lock() else { return Err(job::PrescanOutcome::Busy) };
        if PRESCAN_CANCEL_EPOCH.load(Ordering::SeqCst) != epoch {
            return Err(job::PrescanOutcome::Cancelled);
        }
        if let Some(old) = slot.take() {
            old.why.store(WHY_CANCELLED, Ordering::SeqCst);
            old.abort.abort();
        }
        *slot = Some(PrescanSlot { id, abort, why: why.clone() });
    }
    if live_active() {
        clear_prescan(id);
        return Err(job::PrescanOutcome::Busy);
    }
    Ok((id, why))
}

/// Empty the slot when it still holds pre-scan `id`.
fn clear_prescan(id: u64) {
    if let Ok(mut slot) = PRESCAN.lock() {
        if slot.as_ref().is_some_and(|p| p.id == id) {
            *slot = None;
        }
    }
}

/// Run `work` in the pre-scan slot and await it. The task waits for a go
/// signal sent only once it is installed, so a pre-scan refused as Busy never
/// opened anything. Err carries the outcome of a run that did not finish.
/// `epoch` is `PRESCAN_CANCEL_EPOCH` as the caller read it on entry.
async fn run_in_prescan_slot<F>(work: F, epoch: u64) -> Result<F::Output, job::PrescanOutcome>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    let (go_tx, go_rx) = tokio::sync::oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        go_rx.await.ok()?;
        Some(work.await)
    });
    let (id, why) = match install_prescan(task.abort_handle(), epoch) {
        Ok(x) => x,
        Err(o) => {
            task.abort();
            return Err(o);
        }
    };
    let _ = go_tx.send(());
    let res = task.await;
    clear_prescan(id);
    match res {
        Ok(Some(v)) => Ok(v),
        Ok(None) => Err(job::PrescanOutcome::Cancelled),
        Err(e) if e.is_cancelled() => Err(if why.load(Ordering::SeqCst) == WHY_PREEMPTED {
            job::PrescanOutcome::Preempted
        } else {
            job::PrescanOutcome::Cancelled
        }),
        Err(_) => Err(job::PrescanOutcome::Unavailable),
    }
}

/// What this process already pre-scanned to a cached result: (Stremio id,
/// release identity, MAL id) plus the kinds. Bounded, oldest out. A repeat
/// request it covers answers `cached` without probing the stream again.
const PRESCANNED_CAP: usize = 64;
/// A record never outlives the shortest result TTL it could stand for
/// (`cache::RESULT_ABSTAIN_TTL`, a day; Aura runs for days from the tray):
/// past this it reads as absent and the job's own result lookup decides.
const PRESCANNED_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(3600);
/// Bumped by `forget_prescanned` under the `PRESCANNED` lock: a pre-scan that
/// read an older value (it finished around a Storage clear) records nothing.
static PRESCANNED_EPOCH: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
struct PrescanKey {
    base: String,
    op: bool,
    ed: bool,
}

static PRESCANNED: Mutex<VecDeque<(PrescanKey, std::time::Instant)>> = Mutex::new(VecDeque::new());

fn prescan_key(req: &Request) -> Option<PrescanKey> {
    let rel = req.release_identity()?;
    Some(PrescanKey {
        base: format!("{}\u{0}{}\u{0}{}", req.stremio_id, rel, req.mal_id.unwrap_or(0)),
        op: req.op,
        ed: req.ed,
    })
}

/// A recorded pre-scan of the same file and cour that asked for every kind
/// `k` wants.
fn prescanned_covers(k: &PrescanKey) -> bool {
    PRESCANNED
        .lock()
        .map(|mut v| {
            v.retain(|(_, at)| at.elapsed() < PRESCANNED_MAX_AGE);
            v.iter().any(|(p, _)| p.base == k.base && (p.op || !k.op) && (p.ed || !k.ed))
        })
        .unwrap_or(false)
}

/// Record `k`, unless the record was forgotten since the pre-scan read
/// `epoch` (`PRESCANNED_EPOCH`).
fn record_prescanned(k: PrescanKey, epoch: u64) {
    if let Ok(mut v) = PRESCANNED.lock() {
        if PRESCANNED_EPOCH.load(Ordering::SeqCst) != epoch {
            return;
        }
        v.retain(|(p, at)| p != &k && at.elapsed() < PRESCANNED_MAX_AGE);
        v.push_back((k, std::time::Instant::now()));
        while v.len() > PRESCANNED_CAP {
            v.pop_front();
        }
    }
}

fn forget_prescanned() {
    if let Ok(mut v) = PRESCANNED.lock() {
        PRESCANNED_EPOCH.fetch_add(1, Ordering::SeqCst);
        v.clear();
    }
}

fn prescan_reply(outcome: job::PrescanOutcome, note: Option<String>) -> SkipDetectReply {
    SkipDetectReply::Prescan { outcome, note }
}

fn outcome_name(o: job::PrescanOutcome) -> String {
    serde_json::to_value(o).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default()
}

async fn prescan(app: AppHandle, req: job::PrescanRequest) -> SkipDetectReply {
    use job::PrescanOutcome as O;
    // First, before any await: a cancel from here on is never lost.
    let cancel_epoch = PRESCAN_CANCEL_EPOCH.load(Ordering::SeqCst);
    let record_epoch = PRESCANNED_EPOCH.load(Ordering::SeqCst);
    let req = match req.validate() {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(debug, "skipdetect", "next-episode prescan rejected: {e}");
            return prescan_reply(O::Unavailable, Some(e));
        }
    };
    // Never a URL: the media type and Stremio id only.
    let who = format!("prescan {}/{}", req.media_type.as_deref().unwrap_or("?"), req.stremio_id);
    if live_active() {
        crate::devlog!(debug, "skipdetect", "{who}: next-episode prescan busy (a live detect is running)");
        return prescan_reply(O::Busy, None);
    }
    let Some(key) = prescan_key(&req) else {
        return prescan_reply(O::Unavailable, Some("no release identity to key a result by".into()));
    };
    if prescanned_covers(&key) {
        crate::devlog!(debug, "skipdetect", "{who}: next-episode prescan already done this session");
        return prescan_reply(O::Cached, Some("already pre-scanned this session".into()));
    }
    let Some(dir) = data_dir(&app) else {
        return prescan_reply(O::Unavailable, Some("no data directory".into()));
    };
    // Never downloads ffmpeg for this.
    if !crate::silencedetect::ffmpeg_is_available(&app).await {
        return prescan_reply(O::Unavailable, Some("ffmpeg unavailable".into()));
    }
    let ctx = job::Ctx {
        ffmpeg: crate::silencedetect::ffmpeg_bin(&app),
        data_dir: Some(dir),
        generation: 0,
        publish: Arc::new(|_: &Snapshot| {}),
        progress: Arc::new(|_: &job::Progress| {}),
        background: true,
        pre_probe: None,
        #[cfg(test)]
        replay: None,
        #[cfg(test)]
        fake_theme_load: None,
    };
    let t = std::time::Instant::now();
    let (outcome, note, states) = match run_in_prescan_slot(job::prescan(ctx, req), cancel_epoch).await {
        Ok(r) => {
            if r.outcome == O::Cached || r.stored {
                record_prescanned(key, record_epoch);
            }
            let states = r.snapshot.as_ref().map(|s| format!(" [op {:?}, ed {:?}]", s.op_l1, s.ed_l1));
            (r.outcome, r.note, states)
        }
        Err(o) => (o, None, None),
    };
    crate::devlog!(
        info, "skipdetect",
        "{who}: next-episode prescan {} in {:.1}s{}{}",
        outcome_name(outcome),
        t.elapsed().as_secs_f64(),
        states.unwrap_or_default(),
        note.as_deref().map(|n| format!(" ({n})")).unwrap_or_default()
    );
    prescan_reply(outcome, note)
}

/// One prefetch at a time, process-wide (they are rare: one per Next-Up
/// pre-resolve). A detect does not wait for it: theme downloads go to
/// AnimeThemes, never the stream host, and are paced there.
static PREFETCHING: AtomicBool = AtomicBool::new(false);

/// Releases `PREFETCHING` when dropped: on normal completion and on unwind.
struct PrefetchLatch;

impl Drop for PrefetchLatch {
    fn drop(&mut self) {
        PREFETCHING.store(false, Ordering::SeqCst);
    }
}

async fn start_prefetch(app: AppHandle, req: job::PrefetchRequest) -> bool {
    let req = match req.validate() {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(debug, "skipdetect", "prefetch skipped: {e}");
            return false;
        }
    };
    let Some(dir) = data_dir(&app) else { return false };
    // Never downloads ffmpeg for this: without it a detect is inert anyway.
    if !crate::silencedetect::ffmpeg_is_available(&app).await {
        return false;
    }
    if PREFETCHING.swap(true, Ordering::SeqCst) {
        crate::devlog!(debug, "skipdetect", "prefetch mal {} skipped: another is running", req.mal_id);
        return false;
    }
    // Owns the PREFETCHING claim from here on and releases it on drop, so a
    // panic anywhere below (the spawned task included) cannot leave the latch
    // set and disable prefetch for the rest of the process.
    let latch = PrefetchLatch;
    let ff = crate::silencedetect::ffmpeg_bin(&app);
    tokio::spawn(async move {
        let latch = latch;
        let t = std::time::Instant::now();
        let out = job::prefetch(&ff, &dir, &req).await;
        drop(latch);
        crate::devlog!(
            info, "skipdetect",
            "prefetch mal {} ep {}: {}{} in {:.1}s",
            req.mal_id,
            req.mal_episode.map_or("-".to_string(), |e| e.to_string()),
            if out.themes.is_empty() {
                "no theme".to_string()
            } else {
                out.themes
                    .iter()
                    .map(|(l, d)| format!("{l} {}", if *d { "downloaded" } else { "already cached" }))
                    .collect::<Vec<_>>()
                    .join(", ")
            },
            out.note.map(|n| format!(" ({n})")).unwrap_or_default(),
            t.elapsed().as_secs_f64()
        );
    });
    true
}

async fn detect(app: AppHandle, req: Request) -> Result<SkipDetectReply, String> {
    // FIRST: a live detect preempts any running pre-scan, on every path below.
    let _live = live_begin();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = abort_running();
    let unavailable = |note: String| {
        let s = Snapshot {
            generation,
            state: JobState::Unavailable,
            op_note: Some(note.clone()),
            ed_note: Some(note),
            ..Default::default()
        };
        store_latest(&s);
        Ok(SkipDetectReply::Detected { snapshot: s, superseded: false })
    };
    let req = match req.validate() {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "skipdetect", "detect rejected: {e}");
            return unavailable(e);
        }
    };
    if !crate::silencedetect::ffmpeg_is_available(&app).await {
        crate::devlog!(info, "skipdetect", "ffmpeg unavailable; detection inert");
        return unavailable("ffmpeg unavailable".into());
    }
    let publish_app = app.clone();
    let progress_app = app.clone();
    let ctx = job::Ctx {
        ffmpeg: crate::silencedetect::ffmpeg_bin(&app),
        data_dir: data_dir(&app),
        generation,
        publish: Arc::new(move |s: &Snapshot| {
            if !is_current(s.generation) {
                return;
            }
            store_latest(s);
            let _ = publish_app.emit(UPDATE_EVENT, s);
        }),
        progress: Arc::new(move |p: &job::Progress| {
            if is_current(p.generation) {
                let _ = progress_app.emit(PROGRESS_EVENT, p);
            }
        }),
        background: false,
        pre_probe: None,
        #[cfg(test)]
        replay: None,
        #[cfg(test)]
        fake_theme_load: None,
    };
    let task = tokio::spawn(async move { job::run(&ctx, &req).await });
    if let Ok(mut r) = RUNNING.lock() {
        // A Detect or Cancel that raced in after ours already bumped the
        // generation: never install a stale handle over its newer one.
        if is_current(generation) {
            *r = Some((generation, task.abort_handle()));
        } else {
            task.abort_handle().abort();
        }
    }
    let res = task.await;
    if let Ok(mut r) = RUNNING.lock() {
        if r.as_ref().is_some_and(|(g, _)| *g == generation) {
            *r = None;
        }
    }
    match res {
        Ok(snapshot) => {
            let superseded = !is_current(generation);
            Ok(SkipDetectReply::Detected { snapshot, superseded })
        }
        Err(e) if e.is_cancelled() => {
            let snapshot = Snapshot { generation, state: JobState::Cancelled, ..Default::default() };
            Ok(SkipDetectReply::Detected { snapshot, superseded: true })
        }
        Err(_) => Err("skip detection failed".into()),
    }
}

/// Settings > Storage: where skipdetect's caches live and their size.
pub fn storage_usage(app: &AppHandle) -> (String, u64) {
    match data_dir(app) {
        Some(d) => (d.display().to_string(), cache::total_bytes(&d)),
        None => (String::new(), 0),
    }
}

/// Settings > Storage: delete skipdetect's caches.
pub fn storage_clear(app: &AppHandle) -> Result<(), String> {
    // Stop the running pre-scan (and one about to install), and forget the
    // session record so it cannot answer "cached" for an entry that is gone;
    // a pre-scan finishing around the clear records nothing (PRESCANNED_EPOCH).
    // A result write already in flight, live or pre-scan, is refused by the
    // cache's clear generation (`cache::put_result_since`).
    let _ = abort_prescan(WHY_CANCELLED);
    forget_prescanned();
    let Some(d) = data_dir(app) else { return Ok(()) };
    cache::clear_all(&d).map_err(|e| format!("delete failed: {e}"))
}

/// Layer 3 may run for a kind only when Layer 1 found NO themes of that kind
/// in the cour's own AnimeThemes list ("Over" themes included; a sibling
/// cour's themes do not count). Themes that were tried and failed are an
/// informative abstain.
pub fn layer3_allowed(layer1_themes_of_kind: usize) -> bool {
    layer1_themes_of_kind == 0
}

/// Clamp a window end to the media end (last decoded audio). The container
/// duration is never an input here: it can be ~29 s longer than the media.
/// None when nothing of the window is left.
pub fn clamp_to_media_end(start: f64, end: f64, media_end: f64) -> Option<(f64, f64)> {
    let end = end.min(media_end);
    (end > start).then_some((start, end))
}

/// Serialises the tests that touch the process-wide slots (RUNNING,
/// PRESCAN, LIVE_ACTIVE, PRESCANNED): `cancel_all` reaches all of them.
/// Crate-visible so the runtime tests take it too.
#[cfg(test)]
pub(crate) fn slot_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static SLOT_TEST_LOCK: Mutex<()> = Mutex::new(());
    SLOT_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn slot_lock() -> std::sync::MutexGuard<'static, ()> {
        slot_test_lock()
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn slot_id() -> Option<u64> {
        PRESCAN.lock().unwrap().as_ref().map(|p| p.id)
    }

    /// The cancel epoch as a pre-scan reads it on entry.
    fn ep() -> u64 {
        PRESCAN_CANCEL_EPOCH.load(Ordering::SeqCst)
    }

    /// The record epoch as a pre-scan reads it on entry.
    fn rec() -> u64 {
        PRESCANNED_EPOCH.load(Ordering::SeqCst)
    }

    /// Wait until the slot holds a pre-scan other than `prev`.
    async fn installed_after(prev: Option<u64>) -> u64 {
        for _ in 0..10_000 {
            if let Some(id) = slot_id().filter(|id| Some(*id) != prev) {
                return id;
            }
            tokio::task::yield_now().await;
        }
        panic!("the pre-scan was never installed");
    }

    #[test]
    fn a_live_detect_preempts_the_prescan_and_a_prescan_never_starts_beside_one() {
        use job::PrescanOutcome as O;
        let _g = slot_lock();
        rt().block_on(async {
            let h = tokio::spawn(run_in_prescan_slot(std::future::pending::<()>(), ep()));
            installed_after(None).await;
            // A live detect starts: the pre-scan is aborted at once.
            let live = live_begin();
            assert_eq!(h.await.unwrap(), Err(O::Preempted));
            assert_eq!(slot_id(), None);
            // While it runs, a pre-scan is refused and its work never starts.
            let started = Arc::new(AtomicBool::new(false));
            let s2 = started.clone();
            assert_eq!(run_in_prescan_slot(async move { s2.store(true, Ordering::SeqCst) }, ep()).await, Err(O::Busy));
            tokio::task::yield_now().await;
            assert!(!started.load(Ordering::SeqCst), "a refused pre-scan opened nothing");
            assert_eq!(slot_id(), None);
            // Two live detects: busy until BOTH ended.
            let live2 = live_begin();
            drop(live);
            assert_eq!(run_in_prescan_slot(async { 1 }, ep()).await, Err(O::Busy));
            drop(live2);
            assert!(!live_active());
            assert_eq!(run_in_prescan_slot(async { 7 }, ep()).await, Ok(7));
            assert_eq!(slot_id(), None, "a finished pre-scan leaves the slot empty");
        });
        // The guard is released on unwind too.
        let r = std::panic::catch_unwind(|| {
            let _live = live_begin();
            panic!("detect panicked");
        });
        assert!(r.is_err());
        assert!(!live_active());
    }

    #[test]
    fn a_newer_prescan_supersedes_and_cancel_all_aborts_it_but_cancel_does_not() {
        use job::PrescanOutcome as O;
        let _g = slot_lock();
        rt().block_on(async {
            let a = tokio::spawn(run_in_prescan_slot(std::future::pending::<()>(), ep()));
            let id_a = installed_after(None).await;
            let b = tokio::spawn(run_in_prescan_slot(std::future::pending::<()>(), ep()));
            installed_after(Some(id_a)).await;
            assert_eq!(a.await.unwrap(), Err(O::Cancelled), "superseded by the newer pre-scan");
            // The Cancel action (every load, exit playback) leaves it running.
            let _ = cancel_generation();
            for _ in 0..50 {
                tokio::task::yield_now().await;
            }
            assert!(!b.is_finished(), "Cancel never stops a pre-scan");
            assert!(slot_id().is_some());
            // A page reload does.
            let _ = cancel_all();
            assert_eq!(b.await.unwrap(), Err(O::Cancelled));
            assert_eq!(slot_id(), None);
            // prescan_cancel: idempotent, says whether one was running.
            let c = tokio::spawn(run_in_prescan_slot(std::future::pending::<()>(), ep()));
            installed_after(None).await;
            assert!(abort_prescan(WHY_CANCELLED));
            assert!(!abort_prescan(WHY_CANCELLED));
            assert_eq!(c.await.unwrap(), Err(O::Cancelled));
        });
    }

    #[test]
    fn a_cancel_before_the_prescan_reaches_its_slot_is_not_lost() {
        use job::PrescanOutcome as O;
        let _g = slot_lock();
        rt().block_on(async {
            // The pre-scan read the epoch on entry, then awaited (the ffmpeg
            // check); a prescan_cancel lands while the slot is still empty.
            let epoch = ep();
            assert!(!abort_prescan(WHY_CANCELLED), "nothing was in the slot");
            let started = Arc::new(AtomicBool::new(false));
            let s2 = started.clone();
            assert_eq!(run_in_prescan_slot(async move { s2.store(true, Ordering::SeqCst) }, epoch).await, Err(O::Cancelled));
            tokio::task::yield_now().await;
            assert!(!started.load(Ordering::SeqCst), "a cancelled pre-scan opened nothing");
            assert_eq!(slot_id(), None);
            // A preemption does not count as a cancel: only LIVE_ACTIVE gates it.
            let epoch = ep();
            drop(live_begin());
            assert_eq!(run_in_prescan_slot(async { 3 }, epoch).await, Ok(3));
        });
    }

    #[test]
    fn a_prescan_finishing_around_a_storage_clear_records_nothing() {
        let _g = slot_lock();
        forget_prescanned();
        let p: job::PrescanRequest = serde_json::from_value(serde_json::json!({
            "url": "https://x.invalid/a.mkv", "stremio_id": "tt7:1:1", "release": "Show.S01E01.mkv",
            "mal_id": 5, "detect_op": true, "detect_ed": true
        }))
        .unwrap();
        let k = prescan_key(&p.validate().unwrap()).unwrap();
        let epoch = rec();
        forget_prescanned();
        record_prescanned(k.clone(), epoch);
        assert!(!prescanned_covers(&k), "the clear came after the pre-scan started");
        record_prescanned(k.clone(), rec());
        assert!(prescanned_covers(&k));
        // A record past its age reads as absent and is dropped.
        PRESCANNED.lock().unwrap()[0].1 = std::time::Instant::now() - PRESCANNED_MAX_AGE;
        assert!(!prescanned_covers(&k));
        assert!(PRESCANNED.lock().unwrap().is_empty());
    }

    #[test]
    fn the_session_record_answers_a_covered_prescan_and_is_bounded() {
        let _g = slot_lock();
        forget_prescanned();
        let req = |id: &str, op: bool, ed: bool| {
            let p: job::PrescanRequest = serde_json::from_value(serde_json::json!({
                "url": "https://x.invalid/a.mkv", "stremio_id": id, "release": "Show.S01E02.mkv",
                "mal_id": 5, "detect_op": op, "detect_ed": ed
            }))
            .unwrap();
            p.validate().unwrap()
        };
        let full = prescan_key(&req("tt1:1:2", true, true)).unwrap();
        assert!(!prescanned_covers(&full));
        record_prescanned(full.clone(), rec());
        assert!(prescanned_covers(&full));
        assert!(prescanned_covers(&prescan_key(&req("tt1:1:2", true, false)).unwrap()), "OP+ED covers OP-only");
        assert!(!prescanned_covers(&prescan_key(&req("tt1:1:3", true, true)).unwrap()));
        let op_only = prescan_key(&req("tt1:1:4", true, false)).unwrap();
        record_prescanned(op_only, rec());
        assert!(!prescanned_covers(&prescan_key(&req("tt1:1:4", true, true)).unwrap()), "OP-only never covers OP+ED");
        for i in 0..(PRESCANNED_CAP + 5) {
            record_prescanned(prescan_key(&req(&format!("tt9:1:{i}"), true, true)).unwrap(), rec());
        }
        assert_eq!(PRESCANNED.lock().unwrap().len(), PRESCANNED_CAP);
        assert!(!prescanned_covers(&full), "oldest out");
        forget_prescanned();
        assert!(PRESCANNED.lock().unwrap().is_empty());
    }

    #[test]
    fn cancel_all_supersedes_and_aborts_the_running_detect() {
        let _g = slot_lock();
        // A detect "running" at the current generation (a parked task).
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let g0 = GENERATION.load(Ordering::SeqCst);
            let task = tokio::spawn(std::future::pending::<()>());
            *RUNNING.lock().unwrap() = Some((g0, task.abort_handle()));
            store_latest(&Snapshot { generation: g0, ..Default::default() });
            assert!(cancel_all(), "a running detect was reported");
            assert!(!is_current(g0), "its snapshots are stale from now on");
            assert!(RUNNING.lock().unwrap().is_none());
            assert!(LATEST.lock().unwrap().is_none());
            let err = task.await.unwrap_err();
            assert!(err.is_cancelled(), "the task was aborted");
            // Idempotent: nothing running, still a new generation.
            let g1 = GENERATION.load(Ordering::SeqCst);
            assert!(!cancel_all());
            assert!(GENERATION.load(Ordering::SeqCst) > g1);
        });
    }

    #[test]
    fn layer3_gate() {
        assert!(layer3_allowed(0));
        assert!(!layer3_allowed(1));
    }

    #[test]
    fn ed_end_never_past_media_end() {
        let media_end = 1450.93;
        let container = 1480.02;
        let (_, e) = clamp_to_media_end(1400.0, 1460.0, media_end).unwrap();
        assert_eq!(e, media_end);
        assert!(e < container);
        assert!(clamp_to_media_end(1451.0, 1460.0, media_end).is_none());
    }

    #[test]
    fn action_wire_shape() {
        let a: SkipDetectAction = serde_json::from_value(serde_json::json!({
            "op": "detect", "url": "https://x.invalid/a.mkv", "stremio_id": "tt1:1:1", "duration": 1400.0
        }))
        .unwrap();
        assert!(matches!(a, SkipDetectAction::Detect(ref r) if r.op && r.ed && r.mal_id.is_none()));
        // The kind switches travel as detect_op / detect_ed: `op` is the tag.
        let a: SkipDetectAction = serde_json::from_value(serde_json::json!({
            "op": "detect", "url": "https://x.invalid/a.mkv", "stremio_id": "tt1:1:1", "duration": 1400.0,
            "detect_op": false, "detect_ed": true
        }))
        .unwrap();
        assert!(matches!(a, SkipDetectAction::Detect(ref r) if !r.op && r.ed));
        let c: SkipDetectAction = serde_json::from_value(serde_json::json!({"op": "cancel"})).unwrap();
        assert!(matches!(c, SkipDetectAction::Cancel));
        let r = serde_json::to_value(SkipDetectReply::Cancelled { generation: 4 }).unwrap();
        assert_eq!(r, serde_json::json!({"result": "cancelled", "generation": 4}));
        // Prefetch: same kind switches as Detect, validated before anything runs.
        let p: SkipDetectAction = serde_json::from_value(serde_json::json!({
            "op": "prefetch", "mal_id": 56784, "mal_episode": 3, "detect_op": true, "detect_ed": false
        }))
        .unwrap();
        let SkipDetectAction::Prefetch(p) = p else { panic!("not a prefetch") };
        let p = p.validate().unwrap();
        assert!(p.op && !p.ed && p.mal_episode == Some(3));
        let bad: SkipDetectAction = serde_json::from_value(serde_json::json!({"op": "prefetch", "mal_id": 0})).unwrap();
        let SkipDetectAction::Prefetch(bad) = bad else { panic!() };
        assert!(bad.validate().is_err());
        let none: SkipDetectAction =
            serde_json::from_value(serde_json::json!({"op": "prefetch", "mal_id": 5, "detect_op": false, "detect_ed": false})).unwrap();
        let SkipDetectAction::Prefetch(none) = none else { panic!() };
        assert!(none.validate().is_err());
        let r = serde_json::to_value(SkipDetectReply::Prefetch { started: true }).unwrap();
        assert_eq!(r, serde_json::json!({"result": "prefetch", "started": true}));
        // Prescan: the Detect fields minus duration, validated before anything runs.
        let p: SkipDetectAction = serde_json::from_value(serde_json::json!({
            "op": "prescan", "url": "https://x.invalid/a.mkv", "stremio_id": "tt1:1:2", "media_type": "series",
            "addon": "AIOStreams", "release": "Show.S01E02.mkv", "mal_id": 56784, "mal_source": "aiometadata",
            "mal_episode": 2, "anime": true, "detect_op": true, "detect_ed": false
        }))
        .unwrap();
        let SkipDetectAction::Prescan(p) = p else { panic!("not a prescan") };
        let r = p.validate().unwrap();
        assert!(r.op && !r.ed && r.mal_id == Some(56784) && r.mal_episode == Some(2) && r.anime);
        assert_eq!(r.release_identity().as_deref(), Some("Show.S01E02.mkv"));
        assert_eq!(r.addon.as_deref(), Some("AIOStreams"));
        let bad: SkipDetectAction = serde_json::from_value(serde_json::json!({
            "op": "prescan", "url": "https://x.invalid/a.mkv", "stremio_id": "tt1:1:2", "mal_id": null
        }))
        .unwrap();
        let SkipDetectAction::Prescan(bad) = bad else { panic!() };
        assert!(bad.validate().is_err(), "a pre-scan needs a MAL id");
        let c: SkipDetectAction = serde_json::from_value(serde_json::json!({"op": "prescan_cancel"})).unwrap();
        assert!(matches!(c, SkipDetectAction::PrescanCancel));
        use job::PrescanOutcome as O;
        for (o, name) in [
            (O::Done, "done"),
            (O::Cached, "cached"),
            (O::Preempted, "preempted"),
            (O::Cancelled, "cancelled"),
            (O::Busy, "busy"),
            (O::Unavailable, "unavailable"),
        ] {
            let r = serde_json::to_value(SkipDetectReply::Prescan { outcome: o, note: None }).unwrap();
            assert_eq!(r, serde_json::json!({"result": "prescan", "outcome": name, "note": null}));
            assert_eq!(outcome_name(o), name);
        }
        let r = serde_json::to_value(SkipDetectReply::Prescan { outcome: O::Unavailable, note: Some("ffmpeg unavailable".into()) }).unwrap();
        assert_eq!(r, serde_json::json!({"result": "prescan", "outcome": "unavailable", "note": "ffmpeg unavailable"}));
        let r = serde_json::to_value(SkipDetectReply::PrescanCancelled { was_running: true }).unwrap();
        assert_eq!(r, serde_json::json!({"result": "prescan_cancelled", "was_running": true}));
    }
}
