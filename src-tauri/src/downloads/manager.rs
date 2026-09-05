// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The job registry and scheduler.
//!
//! State lives in a module-level static, not `tauri::State`. That is the house
//! pattern, not a preference: there is not one `.manage(` call anywhere in
//! `src-tauri/src/` (57 files), and 69 module-level statics instead
//! (`settings.rs:473`, `scrobble.rs:579`).
//!
//! The scheduler is a PUMP, not a `tokio::sync::Semaphore`. A Semaphore hands
//! out permits in wait-arrival order, which would make drag-to-reorder
//! decorative: reordering the list would not change which job starts next.
//! The pump reads the list every time a slot frees, so the order the user sees
//! is the order that runs.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Wry};
use tokio::sync::watch;

use super::types::*;

/// How many transfers run at once. Two, mirroring the house cap precedent in
/// `img_proxy.rs:109-118`: enough to keep a link busy while one job stalls,
/// few enough that a queue of ten does not shred the connection playback is
/// also using.
pub const MAX_CONCURRENT: usize = 2;

/// How long the frontend has to answer a relink before the job gives up. Rust
/// arms this because the webview can be reloaded (F5, the stream-lost modal's
/// Reload button) mid-relink, and without a timeout the job would sit in
/// `Relinking` forever with a spinner nothing will resolve.
pub const RELINK_TIMEOUT: Duration = Duration::from_secs(20);

/// Minimum gap between `downloads-snapshot` emissions while something is
/// running. One coalesced snapshot on a timer, never a per-job progress event:
/// five concurrent 40 GB jobs emitting per chunk would flood IPC, and
/// `runtime-dep-progress` (throttled at 2 MB for a SINGLE job) is not a model
/// that survives N.
const SNAPSHOT_INTERVAL: Duration = Duration::from_millis(500);

/// Sampling window for the speed readout. Long enough that the number does not
/// jitter, short enough to react to a stall.
const SPEED_WINDOW: Duration = Duration::from_millis(1500);

/// A live worker's control channel plus the bookkeeping the snapshot needs.
struct Live {
    stop: watch::Sender<Option<StopReason>>,
    /// (when, bytes) sample used to derive speed without persisting anything.
    sample: Option<(Instant, u64)>,
    speed_bps: Option<u64>,
    /// When the relink request went out, for the timeout.
    relink_since: Option<Instant>,
}

struct State {
    /// Ordered because the order IS the queue, and drag-to-reorder rewrites it.
    jobs: Vec<DownloadJob>,
    live: HashMap<String, Live>,
    /// Paths claimed by a job that has not finished. The duplicate guard alone
    /// is not enough: in flat layout two addon rows commonly carry the same
    /// `behaviorHints.filename`, neither final file exists yet, so both would
    /// enqueue and then write into the same partial at the same time.
    claims: std::collections::HashSet<String>,
    root: String,
}

static STATE: OnceLock<Mutex<State>> = OnceLock::new();
static APP: OnceLock<AppHandle<Wry>> = OnceLock::new();
static PUMPING: AtomicBool = AtomicBool::new(false);
/// Set when a pump request arrives while one is already running. The owner
/// re-scans instead of the request being dropped. See `pump`.
static PUMP_AGAIN: AtomicBool = AtomicBool::new(false);

fn state() -> &'static Mutex<State> {
    STATE.get_or_init(|| {
        Mutex::new(State {
            jobs: Vec::new(),
            live: HashMap::new(),
            claims: std::collections::HashSet::new(),
            root: String::new(),
        })
    })
}

pub fn app() -> Option<&'static AppHandle<Wry>> {
    APP.get()
}

/// Called once from the lib.rs setup hook, after settings have loaded.
pub fn init(handle: AppHandle<Wry>) {
    let _ = APP.set(handle);
    super::store::init(APP.get().expect("just set"));

    let loaded = super::store::load();
    {
        let mut st = state().lock().unwrap();
        for j in &loaded {
            if !j.state.is_finished() {
                st.claims.insert(crate::download_path::duplicate_key(
                    std::path::Path::new(&j.dest_path),
                ));
            }
        }
        st.jobs = loaded;
        st.root = crate::settings::snapshot().download_dir;
    }
    spawn_ticker();
}

// ---------------------------------------------------------------------------
// Read-side
// ---------------------------------------------------------------------------

/// Number of jobs the user would call "in progress". Read by the quit gate and
/// the tray, both of which run on the main thread and must not block.
pub fn active_count() -> usize {
    state()
        .lock()
        .map(|st| st.jobs.iter().filter(|j| j.state.is_active()).count())
        .unwrap_or(0)
}

pub fn snapshot() -> DownloadsSnapshot {
    let st = state().lock().unwrap();
    build_snapshot(&st)
}

fn build_snapshot(st: &State) -> DownloadsSnapshot {
    let mut total_speed: u64 = 0;
    let mut sized_done: u64 = 0;
    let mut sized_total: u64 = 0;

    let jobs: Vec<DownloadJobDto> = st
        .jobs
        .iter()
        .map(|j| {
            let live = st.live.get(&j.id);
            let speed = live.and_then(|l| l.speed_bps);
            if j.state == DownloadState::Running {
                total_speed += speed.unwrap_or(0);
                if let Some(t) = j.total_bytes {
                    sized_done += j.bytes_done.min(t);
                    sized_total += t;
                }
            }
            let eta = match (speed, j.total_bytes) {
                (Some(s), Some(t)) if s > 0 && t > j.bytes_done => {
                    Some((t - j.bytes_done) / s.max(1))
                }
                _ => None,
            };
            DownloadJobDto {
                job: j.clone(),
                speed_bps: speed,
                eta_secs: eta,
                pausable: j.kind.pausable(),
            }
        })
        .collect();

    DownloadsSnapshot {
        active: st.jobs.iter().filter(|j| j.state.is_active()).count(),
        overall: (sized_total > 0).then(|| sized_done as f64 / sized_total as f64),
        total_speed_bps: total_speed,
        root: st.root.clone(),
        jobs,
    }
}

fn emit(st: &State) {
    if let Some(app) = APP.get() {
        let _ = app.emit("downloads-snapshot", build_snapshot(st));
    }
}

// ---------------------------------------------------------------------------
// Ticker: progress sampling, snapshot cadence, relink timeout
// ---------------------------------------------------------------------------

fn spawn_ticker() {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(SNAPSHOT_INTERVAL).await;
            let mut anything = false;
            {
                let mut st = state().lock().unwrap();

                // Refresh progress from the file on disk. This is why
                // `bytes_done` is never persisted as a moving value: the
                // partial IS the progress record, so a running download does
                // no bookkeeping writes at all.
                let now = Instant::now();
                let mut timed_out: Vec<String> = Vec::new();
                for j in &mut st.jobs {
                    if j.state == DownloadState::Running && j.kind == JobKind::Http {
                        if let Ok(m) = std::fs::metadata(&j.part_path) {
                            j.bytes_done = m.len();
                        }
                    }
                    if j.state.is_active() {
                        anything = true;
                    }
                }
                // Second pass so the borrow of `st.jobs` above has ended.
                let readings: Vec<(String, u64, DownloadState)> = st
                    .jobs
                    .iter()
                    .map(|j| (j.id.clone(), j.bytes_done, j.state))
                    .collect();
                for (id, bytes, state_now) in readings {
                    if let Some(l) = st.live.get_mut(&id) {
                        if state_now == DownloadState::Running {
                            match l.sample {
                                Some((t0, b0)) if now.duration_since(t0) >= SPEED_WINDOW => {
                                    let dt = now.duration_since(t0).as_secs_f64().max(0.001);
                                    let db = bytes.saturating_sub(b0);
                                    l.speed_bps = Some((db as f64 / dt) as u64);
                                    l.sample = Some((now, bytes));
                                }
                                None => l.sample = Some((now, bytes)),
                                _ => {}
                            }
                        } else {
                            l.speed_bps = None;
                            l.sample = None;
                        }
                        if let Some(since) = l.relink_since {
                            if now.duration_since(since) >= RELINK_TIMEOUT {
                                timed_out.push(id.clone());
                            }
                        }
                    }
                }

                for id in timed_out {
                    if let Some(l) = st.live.get_mut(&id) {
                        l.relink_since = None;
                    }
                    if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                        j.state = DownloadState::NeedsSource;
                        j.error = Some("Could not refresh this link in time.".into());
                    }
                    super::store::mark_dirty();
                    anything = true;
                }

                if anything {
                    emit(&st);
                }
                let jobs = st.jobs.clone();
                drop(st);
                super::store::flush_if_dirty(&jobs);
            }
            super::taskbar::update();
        }
    });
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/// Add a job and start it if a slot is free.
///
/// The user-facing duplicate guard lives in `commands`, where the user can
/// override it. This function does NOT re-reject: it did once, and that made
/// "Download again" on the duplicate prompt a no-op that surfaced a raw error.
/// Writing into the same partial is prevented structurally instead, by
/// `claim_part`'s `create_new`, which hands a second job a " (2)" name.
pub fn enqueue(job: DownloadJob) -> Result<DownloadJobDto, String> {
    let dto;
    {
        let mut st = state().lock().unwrap();
        st.claims.insert(crate::download_path::duplicate_key(
            std::path::Path::new(&job.dest_path),
        ));
        st.jobs.push(job.clone());
        super::store::mark_dirty();
        dto = DownloadJobDto {
            job,
            speed_bps: None,
            eta_secs: None,
            pausable: true,
        };
        emit(&st);
        let jobs = st.jobs.clone();
        drop(st);
        super::store::flush(&jobs);
    }
    pump();
    Ok(dto)
}

/// Is this destination already claimed by a live job?
pub fn is_claimed(dest: &std::path::Path) -> bool {
    let key = crate::download_path::duplicate_key(dest);
    state().lock().map(|st| st.claims.contains(&key)).unwrap_or(false)
}

pub fn set_root(root: String) {
    let mut st = state().lock().unwrap();
    st.root = root;
    emit(&st);
}

/// Promote queued jobs into free slots, newest list order first.
///
/// Concurrent callers are collapsed by `PUMPING`, but a collapsed request is
/// DEFERRED, never dropped. Dropping it was a lost wakeup: enqueue, resume,
/// retry and relink all mutate state under their own lock and then pump, so a
/// pump that landed inside another one's window would leave a job Queued with
/// both slots free and nothing remaining to start it.
pub fn pump() {
    if PUMPING.swap(true, Ordering::AcqRel) {
        PUMP_AGAIN.store(true, Ordering::Release);
        return;
    }
    loop {
        PUMP_AGAIN.store(false, Ordering::Release);
        pump_once();
        // Release the guard, then check once more: a request that arrived
        // between the last scan and the store would otherwise be lost in
        // exactly the same way.
        PUMPING.store(false, Ordering::Release);
        if !PUMP_AGAIN.load(Ordering::Acquire) {
            return;
        }
        if PUMPING.swap(true, Ordering::AcqRel) {
            // Someone else took ownership and will do the re-scan for us.
            return;
        }
    }
}

fn pump_once() {
    let mut to_start: Vec<DownloadJob> = Vec::new();
    {
        let mut st = state().lock().unwrap();
        let running = st.jobs.iter().filter(|j| j.state == DownloadState::Running).count();
        let free = MAX_CONCURRENT.saturating_sub(running);
        if free > 0 {
            let ids: Vec<String> = st
                .jobs
                .iter()
                .filter(|j| j.state == DownloadState::Queued)
                .take(free)
                .map(|j| j.id.clone())
                .collect();
            for id in ids {
                if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                    j.state = DownloadState::Running;
                    j.error = None;
                    to_start.push(j.clone());
                }
            }
            if !to_start.is_empty() {
                super::store::mark_dirty();
                emit(&st);
            }
        }
    }
    for job in to_start {
        spawn_worker(job);
    }
}

fn spawn_worker(job: DownloadJob) {
    let (tx, rx) = watch::channel(None);
    {
        let mut st = state().lock().unwrap();
        st.live.insert(
            job.id.clone(),
            Live { stop: tx, sample: None, speed_bps: None, relink_since: None },
        );
    }
    let id = job.id.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = match job.kind {
            JobKind::Http => super::http::run(&job, rx).await,
            JobKind::HlsLedger | JobKind::HlsPassthrough => super::hls::run(&job, rx).await,
        };
        finish(&id, outcome);
    });
}

/// Apply a worker's outcome and free its slot.
fn finish(id: &str, outcome: Outcome) {
    {
        let mut st = state().lock().unwrap();
        let Some(idx) = st.jobs.iter().position(|j| j.id == id) else {
            st.live.remove(id);
            return;
        };

        let mut drop_claim: Option<String> = None;
        let mut remove_job = false;
        let mut cancelled: Option<DownloadJob> = None;

        {
            let j = &mut st.jobs[idx];
            match outcome {
                Outcome::Finished(final_path) => {
                    j.state = DownloadState::Completed;
                    j.error = None;
                    j.attempt = 0;
                    j.dest_path = final_path;
                    if let Ok(m) = std::fs::metadata(&j.dest_path) {
                        // The file on disk is the last word on its own size.
                        j.bytes_done = m.len();
                        j.total_bytes = Some(m.len());
                    } else if let Some(t) = j.total_bytes {
                        j.bytes_done = t;
                    }
                    crate::devlog!(info, "downloads", "completed {}", j.dest_path);
                }
                Outcome::Stopped(StopReason::Pause) => {
                    j.state = DownloadState::Paused;
                }
                Outcome::Stopped(StopReason::Cancel) => {
                    drop_claim = Some(crate::download_path::duplicate_key(
                        std::path::Path::new(&j.dest_path),
                    ));
                    // Delete HERE, not in the worker and not in `control`: the
                    // worker has just dropped its file handle (Windows refuses
                    // to unlink an open file), and `control` only reaches the
                    // not-running case. Without this a cancelled transfer left
                    // its .aurapart on disk with nothing pointing at it.
                    cancelled = Some(j.clone());
                    remove_job = true;
                }
                Outcome::Expired(msg) => {
                    // Do NOT fail. Hand it to the frontend, which is the only
                    // side that can re-query the addons the user actually has
                    // enabled (streamQueryAddons reads localStorage).
                    j.state = DownloadState::Relinking;
                    j.error = None;
                    crate::devlog!(info, "downloads", "link expired for {}: {msg}", j.title);
                }
                Outcome::Transient(msg) => {
                    j.attempt = j.attempt.saturating_add(1);
                    if j.attempt >= 5 {
                        j.state = DownloadState::Failed;
                        j.error = Some(msg);
                    } else {
                        // Back into the queue; the pump will retry it behind
                        // anything else that is waiting.
                        j.state = DownloadState::Queued;
                        j.error = Some(msg);
                    }
                }
                Outcome::Fatal(msg) => {
                    j.state = DownloadState::Failed;
                    j.error = Some(msg);
                }
            }
        }

        if let Some(k) = drop_claim {
            st.claims.remove(&k);
        }
        if let Some(j) = cancelled {
            super::cleanup_partial(&j);
        }
        if remove_job {
            st.jobs.remove(idx);
        } else if st.jobs[idx].state.is_finished() {
            // A finished job keeps its claim so a second enqueue of the same
            // destination is still caught by the duplicate guard.
        }

        // Mark the relink clock only once the state actually says Relinking.
        let now_relinking = !remove_job && st.jobs[idx].state == DownloadState::Relinking;
        if let Some(l) = st.live.get_mut(id) {
            l.speed_bps = None;
            l.sample = None;
            l.relink_since = now_relinking.then(Instant::now);
        }
        if !now_relinking {
            st.live.remove(id);
        }

        super::store::mark_dirty();
        emit(&st);
        let jobs = st.jobs.clone();
        drop(st);
        super::store::flush(&jobs);
    }
    super::taskbar::update();
    pump();
}

/// Signal a running worker. Returns false when nothing is listening, which is
/// the normal case for a Queued or Paused job.
fn signal(id: &str, reason: StopReason) -> bool {
    let st = state().lock().unwrap();
    match st.live.get(id) {
        Some(l) => l.stop.send(Some(reason)).is_ok(),
        None => false,
    }
}

pub fn control(action: ControlAction) -> Result<DownloadsSnapshot, String> {
    match action {
        ControlAction::Pause { id } => {
            let kind = {
                let st = state().lock().unwrap();
                st.jobs.iter().find(|j| j.id == id).map(|j| (j.kind, j.state))
            };
            let Some((kind, cur)) = kind else { return Err("No such download.".into()) };
            if !kind.pausable() {
                return Err(
                    "This one cannot be paused: it is being remuxed in a single pass. Cancel it instead."
                        .into(),
                );
            }
            if cur == DownloadState::Running {
                signal(&id, StopReason::Pause);
            } else {
                let mut st = state().lock().unwrap();
                if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                    j.state = DownloadState::Paused;
                }
                super::store::mark_dirty();
                emit(&st);
            }
        }
        ControlAction::Resume { id } => {
            {
                let mut st = state().lock().unwrap();
                if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                    if matches!(j.state, DownloadState::Paused | DownloadState::Failed) {
                        j.state = DownloadState::Queued;
                        j.error = None;
                    }
                }
                super::store::mark_dirty();
                emit(&st);
            }
            pump();
        }
        ControlAction::Cancel { id } => {
            if !signal(&id, StopReason::Cancel) {
                // Not running: tear it down here, including the partial.
                let mut st = state().lock().unwrap();
                if let Some(idx) = st.jobs.iter().position(|j| j.id == id) {
                    let j = st.jobs.remove(idx);
                    st.claims.remove(&crate::download_path::duplicate_key(
                        std::path::Path::new(&j.dest_path),
                    ));
                    super::cleanup_partial(&j);
                }
                st.live.remove(&id);
                super::store::mark_dirty();
                emit(&st);
                let jobs = st.jobs.clone();
                drop(st);
                super::store::flush(&jobs);
                // Cancelling frees a slot, so something queued may now start.
                pump();
            }
        }
        ControlAction::Retry { id } => {
            {
                let mut st = state().lock().unwrap();
                if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                    // Gated like Resume. Without this a double-click on the
                    // Try again button demoted a job that was already Running,
                    // and the pump then started a SECOND worker on the same
                    // .aurapart while the first still held it open.
                    if matches!(
                        j.state,
                        DownloadState::Failed
                            | DownloadState::NeedsSource
                            | DownloadState::Paused
                    ) {
                        j.state = DownloadState::Queued;
                        j.attempt = 0;
                        j.error = None;
                    }
                }
                super::store::mark_dirty();
                emit(&st);
            }
            pump();
        }
        ControlAction::Relink { id, url, headers } => {
            {
                let mut st = state().lock().unwrap();
                if let Some(l) = st.live.get_mut(&id) {
                    l.relink_since = None;
                }
                st.live.remove(&id);
                if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                    if j.state != DownloadState::Relinking {
                        return Err("That download is not waiting for a link.".into());
                    }
                    j.url = url;
                    j.headers = headers;
                    j.state = DownloadState::Queued;
                    j.attempt = 0;
                    j.error = None;
                    // The old validator described the old link. Keeping it
                    // would make the next If-Range compare against a file the
                    // new origin has never heard of.
                    j.validator = None;
                }
                super::store::mark_dirty();
                emit(&st);
            }
            pump();
        }
        ControlAction::RelinkFailed { id, reason } => {
            let mut st = state().lock().unwrap();
            st.live.remove(&id);
            if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                j.state = DownloadState::NeedsSource;
                j.error = Some(
                    reason.unwrap_or_else(|| "That source is no longer available.".into()),
                );
            }
            super::store::mark_dirty();
            emit(&st);
        }
        ControlAction::Reorder { id, to_index } => {
            let mut st = state().lock().unwrap();
            if let Some(from) = st.jobs.iter().position(|j| j.id == id) {
                let j = st.jobs.remove(from);
                let to = to_index.min(st.jobs.len());
                st.jobs.insert(to, j);
            }
            super::store::mark_dirty();
            emit(&st);
        }
        ControlAction::ClearFinished => {
            let mut st = state().lock().unwrap();
            let gone: Vec<String> = st
                .jobs
                .iter()
                .filter(|j| j.state.is_finished())
                .map(|j| crate::download_path::duplicate_key(std::path::Path::new(&j.dest_path)))
                .collect();
            for k in gone {
                st.claims.remove(&k);
            }
            st.jobs.retain(|j| !j.state.is_finished());
            super::store::mark_dirty();
            emit(&st);
            let jobs = st.jobs.clone();
            drop(st);
            super::store::flush(&jobs);
        }
        ControlAction::PauseAll => {
            // Every active job must end up NOT active, or the quit gate (which
            // tests active_count() > 0) refuses the re-issued close forever and
            // the window becomes unclosable. A single-pass HLS remux cannot be
            // paused, so for it "stop" can only mean cancel; `stoppable_summary`
            // lets the UI say so BEFORE the user commits.
            let targets: Vec<(String, bool)> = {
                let st = state().lock().unwrap();
                st.jobs
                    .iter()
                    .filter(|j| j.state.is_active())
                    .map(|j| (j.id.clone(), j.kind.pausable()))
                    .collect()
            };
            for (id, pausable) in targets {
                let reason = if pausable { StopReason::Pause } else { StopReason::Cancel };
                if !signal(&id, reason) {
                    // Not running (Queued or Relinking): settle it here.
                    let mut st = state().lock().unwrap();
                    if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
                        j.state = DownloadState::Paused;
                    }
                }
            }
            let st = state().lock().unwrap();
            super::store::mark_dirty();
            emit(&st);
        }
    }
    super::taskbar::update();
    Ok(snapshot())
}

/// Stop every worker and write the list. Called synchronously from the
/// `CloseRequested` handler, where the process is about to go away.
pub fn shutdown() {
    let ids: Vec<(String, bool)> = {
        let st = state().lock().unwrap();
        st.jobs
            .iter()
            .filter(|j| j.state == DownloadState::Running)
            .map(|j| (j.id.clone(), j.kind.pausable()))
            .collect()
    };
    for (id, pausable) in &ids {
        signal(id, if *pausable { StopReason::Pause } else { StopReason::Cancel });
    }
    let mut st = state().lock().unwrap();
    for j in &mut st.jobs {
        if j.state == DownloadState::Running {
            j.state = DownloadState::Paused;
        }
    }
    let jobs = st.jobs.clone();
    drop(st);
    super::store::flush(&jobs);
    crate::devlog!(info, "downloads", "shutdown: parked {} running job(s)", ids.len());
}

/// How many active jobs cannot be paused, and therefore would be cancelled by
/// a "stop everything" action. The quit prompt reads this so it can warn
/// honestly instead of promising to keep work it is about to destroy.
pub fn unpausable_active() -> usize {
    state()
        .lock()
        .map(|st| {
            st.jobs
                .iter()
                .filter(|j| j.state.is_active() && !j.kind.pausable())
                .count()
        })
        .unwrap_or(0)
}

/// Record the transport mode actually chosen, which for HLS is only known once
/// the playlist has been fetched and the admission gate has run.
pub fn record_kind(id: &str, kind: JobKind) {
    let mut st = state().lock().unwrap();
    let changed = match st.jobs.iter_mut().find(|j| j.id == id) {
        Some(j) if j.kind != kind => {
            j.kind = kind;
            true
        }
        _ => false,
    };
    if changed {
        super::store::mark_dirty();
        emit(&st);
    }
}

/// Apply a learned fact from the first response: total size, whether the origin
/// honours Range, and its validator.
pub fn record_probe(
    id: &str,
    total: Option<u64>,
    resumable: bool,
    validator: Option<String>,
) {
    let mut st = state().lock().unwrap();
    if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
        if total.is_some() {
            j.total_bytes = total;
        }
        j.resumable = resumable;
        if validator.is_some() {
            j.validator = validator;
        }
    }
    super::store::mark_dirty();
    emit(&st);
}

/// Record progress for job kinds whose partial is not a single growing file
/// (the HLS ledger), where `metadata(part).len()` says nothing useful.
pub fn record_progress(id: &str, done: u64, total: Option<u64>) {
    let mut st = state().lock().unwrap();
    if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
        j.bytes_done = done;
        if total.is_some() {
            j.total_bytes = total;
        }
    }
}

/// Clear the consecutive-failure counter because the last run made real
/// progress. Without this a link that drops every 30 seconds but advances a
/// gigabyte each time would exhaust its retries and be declared dead.
pub fn reset_attempt(id: &str) {
    let mut st = state().lock().unwrap();
    if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
        j.attempt = 0;
    }
}

/// Replace a job's destination after the container was refined by a response
/// header. Only ever narrows `ExtSource::Default` to something real.
pub fn record_dest(id: &str, dest: String, part: String) {
    let mut st = state().lock().unwrap();
    let old_key = st
        .jobs
        .iter()
        .find(|j| j.id == id)
        .map(|j| crate::download_path::duplicate_key(std::path::Path::new(&j.dest_path)));
    if let Some(k) = old_key {
        st.claims.remove(&k);
    }
    st.claims
        .insert(crate::download_path::duplicate_key(std::path::Path::new(&dest)));
    if let Some(j) = st.jobs.iter_mut().find(|j| j.id == id) {
        j.dest_path = dest;
        j.part_path = part;
    }
    super::store::mark_dirty();
}
