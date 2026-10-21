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
// status / prefetch) so the three registration sites cover the whole feature. Detect
// awaits the final result; every intermediate change (an OP accepted while
// HEAD is still decoding, the media end at TAIL EOF) is also emitted as a
// `skipdetect-update` event and readable through Status. A module-level
// generation counter (no Tauri managed state) makes each Detect supersede the
// previous one: the old task is aborted (its ffmpeg dies with kill_on_drop,
// its theme JoinSet is dropped) and anything it would still publish is
// discarded as stale.
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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    cancel_generation().1
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
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_all_supersedes_and_aborts_the_running_detect() {
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
    }
}
