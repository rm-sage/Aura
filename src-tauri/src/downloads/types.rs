// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Wire and persistence types for the download manager.
//!
//! Serde note: NOTHING here carries a `#[serde(rename = "...")]` on a field.
//! Tauri applies a field rename in BOTH directions, so a renamed field would
//! reach React under the wire name instead of the Rust name and every TS
//! interface would read `undefined` (this is the `LibraryItem` bug documented
//! in CLAUDE.md). `#[serde(rename_all)]` on a UNIT-VARIANT enum is a different
//! thing and is safe: it renames variants, not fields.

use serde::{Deserialize, Serialize};

/// Where a job is in its life. `Running` is deliberately NOT persisted: a job
/// found in `Running` when the list is loaded from disk becomes `Paused`,
/// because the process that was running it is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    /// Waiting for a slot. The scheduler promotes these in list order.
    Queued,
    /// A worker owns it right now.
    Running,
    /// Stopped by the user, or by a clean shutdown. The partial is kept.
    Paused,
    /// The origin rejected the link and the frontend is re-querying the addon
    /// for the same source. Rust arms a timeout so a webview reload cannot
    /// wedge a job here forever.
    Relinking,
    /// A relink found nothing. The user can retry from the row.
    NeedsSource,
    Completed,
    Failed,
}

impl DownloadState {
    /// True while the job is something the user would describe as "in
    /// progress". Drives the title-bar count, the taskbar bar and the quit
    /// prompt.
    pub fn is_active(self) -> bool {
        matches!(
            self,
            DownloadState::Queued | DownloadState::Running | DownloadState::Relinking
        )
    }

    /// True when the job will never move again without user action. Used by
    /// "Clear finished".
    pub fn is_finished(self) -> bool {
        matches!(self, DownloadState::Completed | DownloadState::Failed)
    }
}

/// Which transport a job uses. Decided once, at enqueue, and persisted: the
/// admission gate that chose it fetched the playlist, and re-deciding on resume
/// could silently switch modes mid-file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    /// A direct http(s) file. Range-resumable when the origin allows it.
    Http,
    /// HLS where Aura fetches segments itself and ffmpeg remuxes once at the
    /// end. Pause and resume are exact.
    HlsLedger,
    /// HLS where ffmpeg both fetches and remuxes in one pass. NOT pausable;
    /// the row says so.
    HlsPassthrough,
}

impl JobKind {
    /// Mode B cannot be paused. Windows has no SIGSTOP, and suspending the
    /// process is not a pause: the sockets stall and debrid hosts drop idle
    /// connections within tens of seconds, `-seg_max_retry` defaults to 0 so
    /// the job then dies, signed segment URLs expire while suspended, and the
    /// held-open output has no container trailer so quitting leaves an
    /// unopenable file.
    pub fn pausable(self) -> bool {
        !matches!(self, JobKind::HlsPassthrough)
    }
}

/// Everything needed to find this exact source again after the link expires.
///
/// `match_key` is produced by the frontend using `streamMatchKey`
/// (`src/watchTogether/streamMatch.ts:11-14`), the same function the
/// watch-together highlight uses, so the two can never disagree about what
/// "the same source" means. A bespoke hash of the stream title would be
/// unstable: an AIOStreams/TamTaro title carries live cache status and seeder
/// counts that change between calls.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct JobOrigin {
    /// Stremio meta id the stream query was made against (episode id for
    /// series, e.g. `tt0903747:1:5`).
    pub stream_id: String,
    /// `movie` / `series` / `anime`, as sent to `fetch_streams`.
    pub media_type: String,
    /// Addon that served the stream, for display and for preferring the same
    /// source on a re-match.
    pub addon_name: String,
    /// `streamMatchKey(stream)`.
    pub match_key: String,
}

/// A single download, as persisted and as sent to the frontend.
///
/// Field names are the wire names. See the serde note at the top of the file.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DownloadJob {
    pub id: String,
    pub state: DownloadState,
    pub kind: JobKind,

    /// The URL currently being fetched. Replaced wholesale by a relink.
    pub url: String,
    /// Headers the addon said are required (`behaviorHints.proxyHeaders`).
    /// Without these a stream that plays fine can 403 on download: mpv sends
    /// its own Lavf User-Agent and reqwest would not.
    #[serde(default)]
    pub headers: Vec<(String, String)>,

    /// What the user sees in the row.
    pub title: String,
    /// Secondary line: the release name, or the addon.
    #[serde(default)]
    pub subtitle: Option<String>,

    /// Absolute final destination, decided at enqueue and never recomputed
    /// (except for a one-time extension refinement on the first response).
    pub dest_path: String,
    /// Absolute in-progress file. For the HLS ledger this is the work dir.
    pub part_path: String,

    /// Total size once known. `None` for a chunked response or an HLS job
    /// before the playlist is parsed.
    #[serde(default)]
    pub total_bytes: Option<u64>,
    /// Bytes on disk. Derived from `metadata(part).len()` at snapshot time for
    /// HTTP jobs, so a running download performs no extra disk writes just to
    /// record progress.
    #[serde(default)]
    pub bytes_done: u64,

    /// Whether the origin honoured `Range`. Learned from the first real
    /// response, never from a separate probe.
    #[serde(default)]
    pub resumable: bool,
    /// `ETag` or `Last-Modified`, whichever the origin gave, used as the
    /// `If-Range` validator on resume.
    #[serde(default)]
    pub validator: Option<String>,

    pub origin: JobOrigin,

    /// Consecutive failed attempts. Reset once a run makes real progress, so a
    /// link that drops thirty times but advances is healthy while one that dies
    /// at the same byte is dead.
    #[serde(default)]
    pub attempt: u32,
    /// User-facing failure text. Never a raw error chain.
    #[serde(default)]
    pub error: Option<String>,

    /// Unix millis. Passed in from the frontend at enqueue rather than read
    /// from the system clock here, so the whole list orders consistently with
    /// what the UI shows.
    pub created_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,

    /// True when the planned name had to be shortened to fit the Windows path
    /// limit. Surfaced as a row tooltip only.
    #[serde(default)]
    pub truncated: bool,
}

/// Live, non-persisted numbers computed at snapshot time.
#[derive(Clone, Debug, Serialize)]
pub struct DownloadJobDto {
    #[serde(flatten)]
    pub job: DownloadJob,
    /// Bytes per second over the last sampling window, or `None` when not
    /// running or not yet measurable.
    pub speed_bps: Option<u64>,
    /// Seconds remaining at the current rate.
    pub eta_secs: Option<u64>,
    /// False for a Mode B HLS job, so the row can disable Pause with a reason
    /// instead of offering a control that cannot work.
    pub pausable: bool,
}

/// The whole list plus the aggregate the title-bar button renders.
#[derive(Clone, Debug, Serialize)]
pub struct DownloadsSnapshot {
    pub jobs: Vec<DownloadJobDto>,
    pub active: usize,
    /// Aggregate fraction across jobs with a known size, 0.0 to 1.0, or `None`
    /// when nothing running has a size yet.
    pub overall: Option<f64>,
    pub total_speed_bps: u64,
    /// Configured root, resolved, or empty when unset.
    pub root: String,
}

/// What the frontend sends to start a download.
#[derive(Clone, Debug, Deserialize)]
pub struct EnqueueRequest {
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    pub origin: JobOrigin,
    pub naming: NameInput,
    pub created_at: i64,
    /// Set after the user confirms an "already downloaded" prompt.
    #[serde(default)]
    pub allow_duplicate: bool,
}

/// Everything the naming layer needs. Assembled on the detail page, where the
/// show, year, season, episode and title are all in hand; a stream row on its
/// own has none of them.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct NameInput {
    /// `movie` or `series` (anime is named like a series).
    pub media_type: String,
    pub title: String,
    #[serde(default)]
    pub year: Option<i32>,
    #[serde(default)]
    pub season: Option<i32>,
    #[serde(default)]
    pub episode: Option<i32>,
    #[serde(default)]
    pub episode_title: Option<String>,
    /// `behaviorHints.filename`, raw.
    #[serde(default)]
    pub release_name: Option<String>,
    /// `StreamEntry.episode_pack`.
    #[serde(default)]
    pub episode_pack: bool,
    /// Source URL, used only to elect the container.
    #[serde(default)]
    pub url: Option<String>,
}

/// Result of planning a destination without creating anything.
#[derive(Clone, Debug, Serialize)]
pub struct PlannedPath {
    pub path: String,
    pub truncated: bool,
    /// True when a file is already there or a job already targets it.
    pub duplicate: bool,
}

/// One tagged action, so the whole control surface is a single command rather
/// than eight near-identical ones (each of which would need three registration
/// sites).
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ControlAction {
    Pause { id: String },
    Resume { id: String },
    Cancel { id: String },
    Retry { id: String },
    /// The frontend found a fresh URL for an expired job.
    Relink { id: String, url: String, #[serde(default)] headers: Vec<(String, String)> },
    /// The frontend could not re-match the source.
    RelinkFailed { id: String, #[serde(default)] reason: Option<String> },
    /// Move a queued job to a new index in the list.
    Reorder { id: String, to_index: usize },
    ClearFinished,
    PauseAll,
}

/// Why a worker was asked to stop. The distinction decides the fate of the
/// partial file: a pause keeps it, a cancel deletes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    Pause,
    Cancel,
}

/// How a worker finished.
#[derive(Debug)]
pub enum Outcome {
    Completed,
    Stopped(StopReason),
    /// The origin rejected the link. Triggers the relink flow rather than a
    /// plain failure.
    Expired(String),
    /// Retryable transport problem, including a body that ended early.
    Transient(String),
    /// Terminal. The row shows this text.
    Fatal(String),
}
