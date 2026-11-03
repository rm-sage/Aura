// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Watch history, owned by Rust, one compact gzip file per scope.
//!
//! WHY IT LEFT localStorage. History is the one per-account store that grows
//! without a natural bound (one row per finished play or skip), and in
//! localStorage it had to be capped at 1000 rows, silently dropping the oldest,
//! while sharing the origin's ~10 MB quota with every cache. A measured real
//! history is 586 bytes per row as JSON, nearly all of it title-level fields
//! (name, poster and background URLs) repeated on every episode. Here there is
//! NO entry cap, and the file is a fraction of that size (see "Format").
//!
//! SHAPE. The frontend keeps its synchronous API (`src/historyStore.ts`) over
//! an in-memory array HYDRATED from `load`; every write updates that array at
//! once and sends the matching small mutation here (`append` / `remove` /
//! `replace` / `clear`), so a finished play never ships the whole history over
//! IPC. The frontend runs every call through one promise chain, so they reach
//! this module in the order they were issued, and it mirrors each op exactly
//! (`apply_append` and friends are the definitions both sides follow).
//!
//! STATE. A module-level static holds at most ONE scope's decoded rows (the
//! active one); a call for another scope flushes and swaps. Writes are
//! coalesced: a mutation marks the resident scope dirty and a single delayed
//! flush (`FLUSH_DELAY`) writes the file atomically (tmp + rename) off the
//! caller's thread; `flush_blocking` runs from the exit path in
//! window_logic.rs so the last second of plays is not lost on a clean quit.
//! Lock order is STATE then WRITES, never the reverse; a write carries the
//! global generation it was encoded at and is skipped when a newer one for the
//! same scope already landed, so a slow background write can never rename an
//! older snapshot over a newer one.
//!
//! DURABLE MEANS LANDED, NOT SNAPSHOTTED. The background writer marks a scope
//! clean when it takes its snapshot, which is before the gzip and the rename,
//! so "clean" alone says nothing about the disk. Every path that must know
//! (the exit flush, a scope swap that drops the rows from memory, the
//! migration's read-back) goes through `make_durable`: it holds WRITES, which
//! waits out a write in flight, and compares the resident generation with the
//! one WRITES recorded as on disk. A swap whose old scope cannot be made
//! durable is REFUSED, so a failing disk keeps the rows in memory instead of
//! dropping them, and the new scope is read with WRITES held, so it never
//! reads a file mid-replace. A play for the new scope arriving meanwhile is
//! PARKED here and applied when that scope becomes resident (the exit flush
//! writes what is still parked), so it survives a page reload as well.
//!
//! A FILE THAT EXISTS BUT CANNOT BE READ IS NEVER AN EMPTY HISTORY. A read
//! error other than "not found" (antivirus, backup software or OneDrive
//! holding the file, an I/O error) makes the scope resident as UNREADABLE:
//! nothing is ever written for it, `load` and every op but `append` fail (the
//! frontend keeps retrying the load), plays appended meanwhile are kept, and
//! the read is retried on every call until it succeeds, when those plays are
//! merged into what the file held. Before this an unreadable file loaded as
//! zero rows and the next play's write replaced the whole history with one
//! row. Those plays are also written, on every append, to a sidecar beside the
//! file (`<scope>.history.pending.gz`), so they survive a scope swap, a quit, a
//! crash and an updater relaunch while the file stays unreadable. It is read
//! back when the scope next becomes resident and removed only by a write of
//! the scope that holds its rows (see "DURABLE MEANS LANDED"); if the sidecar
//! cannot be written either, the rows stay in memory and a swap away is
//! refused. A file that reads but does not DECODE is set aside as `.gz.bad` and
//! the scope starts empty, but only once that rename succeeded (else it is
//! unreadable too), and the load reports `recovered` so sync.ts pulls the
//! cloud copy in full before it lets anything be pushed over it. That latch
//! is persisted (`<scope>.history.recovering`, written before the rename) until
//! a cloud merge has landed on disk or the pull found no cloud copy: a restart
//! or a scope swap before then must not read as a healthy near-empty history
//! whose next push replaces the only copy left. A guest has no cloud to wait
//! for, so its scope gets no marker. Every set-aside, guest included, also
//! records its time (`<scope>.history.setaside`): backup.rs keeps the newest
//! automatic snapshot from before each recorded time, since the snapshots after
//! one hold only what has come back since and would otherwise roll it out. The
//! earlier times stay when the damage recurs, or a second set-aside would move
//! the only pin onto a near-empty snapshot and free the full one.
//!
//! NO FILE IS THE SAME LATCH. A signed-in scope found to have no file sets the
//! marker too, whichever call reads the disk first (a play can get there before
//! the `load` a refused swap failed): the file lives in Roaming and the sync etag
//! in Local, so a deleted or unmigrated file leaves an etag vouching for rows
//! this device does not hold. The pull then answers 304, merges nothing, and the
//! next play would replace the whole cloud copy. The cost is one full pull for
//! such a scope.
//!
//! FORMAT (file, version 1): gzip of
//! `{"v":1,"strings":[...],"shapes":[[...]],"rows":[[shape, v...], ...]}`.
//! Every string value is interned in `strings` (so a poster URL repeated on 50
//! episodes is stored once, with no hard-coded list of "title fields"); a
//! row's field names and value kinds live once in `shapes`; a timestamp is an
//! integer millisecond DELTA from the previous row's value of that field, used
//! only when the string round-trips byte-exactly through the JS
//! `toISOString` form (`played_at` is half of the removal key, so an exact
//! round trip is mandatory, and anything else is stored as a string).
//! Unknown fields, nulls and odd types pass through verbatim. Rows keep their
//! array order. Lossless, pinned by the tests at the bottom.
//!
//! CLOUD. The `history` sync namespace now carries a plain array: the newest
//! rows in plain form, then ONE trailing element
//! `{"v":2,"enc":"gzip-b64","n":N,"data":"<base64 of the same gzip>"}` holding
//! the rest (see "WIRE SHAPE" below for why an older Aura needs the plain
//! head). Built here (`cloud_encode`) and read here (`merge_cloud`, which also
//! still reads the legacy plain array an older Aura pushes). When the blob
//! would not fit the proxy's 1 MiB per-blob limit, the CLOUD copy holds only
//! the newest rows that fit; the local file is never trimmed. See sync.ts for
//! the mixed-version behaviour.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime};

/// Coalescing window for disk writes. A bulk skip of 60 episodes is one call
/// already; this folds a burst of separate plays / removals into one write.
const FLUSH_DELAY: Duration = Duration::from_millis(1500);

/// Version of the on-disk compact form. A file with a newer version is set
/// aside rather than misread.
const FILE_VERSION: u64 = 1;

/// Version tag of the cloud envelope. 1 is reserved for "the legacy plain
/// array", which carries no tag of its own.
const CLOUD_VERSION: u64 = 2;
const CLOUD_ENC: &str = "gzip-b64";

/// Budget for the WHOLE serialized cloud blob. The proxy and sync.rs reject
/// anything over 1 MiB; 64 KiB of headroom covers the envelope keys and any
/// future field without a second trim pass.
const CLOUD_BUDGET_BYTES: usize = 1024 * 1024 - 64 * 1024;

/// Inflate ceilings. A cloud blob is at most 1 MiB of base64, so 64 MiB of
/// JSON is far past any honest payload and stops a gzip bomb. The local file
/// is our own, but a corrupt or hostile file must still not exhaust memory.
/// These bound the TEXT only; what parsing it allocates is charged to the
/// decode budgets below (`json_parse_cost`) before the parse runs.
const MAX_INFLATED_CLOUD: u64 = 64 << 20;
const MAX_INFLATED_LOCAL: u64 = 1 << 30;

/// Ceilings on what a decode MATERIALIZES (`decode_compact`'s estimate: every
/// string copy, plus a fixed overhead per field and per row). The inflate caps
/// above bound only the compact JSON, and interning makes that no bound at
/// all: one 32 MiB entry in `strings` referenced by 1.9M rows `[0,1,2,0]` is
/// 52 MB of compact JSON (under the 64 MiB cap) in a 93 KB blob (under the
/// proxy's 1 MiB), and asks for ~59,000 GiB of copies, which aborts the
/// process on every pull of that account. An honest cloud blob holds at most
/// ~40k rows (the 1 MiB blob limit); an honest local file is uncapped, so its
/// ceiling is generous and exists only so a corrupt or planted file fails
/// instead of exhausting memory. Both budgets cover the parse AND the decode,
/// charged as UPPER bounds on what they really allocate (an object by its
/// B-tree nodes, `MAP_NODE_COST`): an honest row estimates ~3.8 KB of the two
/// together (it really allocates ~2.5 KB), so a full cloud blob uses about
/// 150 MiB of its 256 and 1 GiB still holds some 280k plays. A cloud merge is
/// refused when it would grow the store past what the local budget reads back
/// (`check_merged_file_fits`), so pulls can never grow a file into being set
/// aside.
const MAX_DECODED_CLOUD: u64 = 256 << 20;
const MAX_DECODED_LOCAL: u64 = 1 << 30;
/// Per-row overhead counted by the decode budget (the row's `Value` slot and
/// slack; its fields are charged as B-tree nodes, `map_cost`), and the
/// per-key slack the PARSE estimate adds on top of those nodes.
const DECODE_ROW_COST: u64 = 64;
const DECODE_FIELD_COST: u64 = 48;
/// What one JSON node costs the PARSE that precedes the decode
/// (`json_parse_cost`): a 32-byte `Value`, doubled for the slack a growing Vec
/// keeps. The parse is charged to the same budget as the decode, because both
/// trees are alive at once. Without it 62 MiB of `0,` (85 KB of blob, under
/// both the proxy limit and the inflate cap) parsed to ~1 GiB before any
/// budget was consulted.
const PARSE_NODE_COST: u64 = 64;
/// What every `[` adds on top of its first element's `PARSE_NODE_COST`.
/// serde_json fills an array by pushing onto `Vec::new()`, and a Vec of
/// 32-byte elements jumps straight to 4 slots (128 B) on its first push, so a
/// one-element array really costs 128 B where the per-node charge said 64:
/// chains of `[[[0]]]` peaked at ~2.1x the cloud budget and ~2.6x the local
/// one. With 2 more slots per `[`, an array of n elements is charged 2n + 2
/// slots, which covers both the 4-slot minimum and the doubling growth (a
/// capacity never exceeds max(4, 2(n - 1))).
const ARRAY_OPEN_EXTRA_COST: u64 = 64;
/// What one JSON object's node allocation costs (`map_cost`). serde_json's
/// `Map` is a std `BTreeMap` in this build (`preserve_order` is off), and a
/// B-tree allocates a WHOLE node on its first insert: 11 String keys (24 B)
/// plus 11 `Value`s (32 B) plus the parent link, ~632 B for a leaf, and 12
/// child pointers more (~728 B) for an internal node. Charging an object per
/// FIELD (48 B) instead was the hole a 39 KB cloud blob of `{"":{"":...}}`
/// nests went through: estimated at a few hundred MiB, it allocated ~1.9 GiB,
/// and rows of it passed the per-row cap at ~13x their real size.
const MAP_NODE_COST: u64 = 728;
/// Every B-tree node but the root holds at least this many keys (std's
/// `MIN_LEN`), so an object of n keys has at most 1 + (n - 1) / 5 nodes,
/// whatever order its keys arrive in.
const MAP_NODE_MIN_KEYS: u64 = 5;
/// Ceiling on ONE row's estimated decoded size (`value_cost`). An honest row
/// is ~3.5 KB estimated (its map nodes plus short strings and numbers), so
/// 64 KiB is ~18x that and only a planted or corrupt row is ever dropped: one
/// raw field holding a 33M-element
/// array is 85 KB of blob and ~1 GiB resident. The total budgets above cannot
/// stop that row on the local side (4 GiB) and would let it through the cloud
/// side at up to 256 MiB, after which it is resident, written to the file,
/// shipped to the webview and pushed to every device. Applied wherever rows
/// enter the store (`row_fits`), so such a row never becomes resident.
const MAX_ROW_COST: u64 = 64 * 1024;
/// Deepest nesting a row may have, the row object itself being level 1. Real
/// rows are FLAT (depth 1 across the whole measured corpus; the deepest odd
/// field the tests carry is 3). Without a cap a row nested to serde_json's
/// own limit (127) cost only ~4.7 KB, passed `MAX_ROW_COST`, and was kept,
/// persisted and re-pushed in the cloud copy's PLAIN head, where the IPC
/// envelope that carries a pull adds levels of its own: that parse then went
/// past the 128 limit, so history sync failed on every device of the account
/// for good. 16 leaves the envelopes (a few levels) far under 128 while still
/// passing any honest future field through verbatim.
const MAX_ROW_DEPTH: usize = 16;
/// Ceiling on the rows ONE cloud copy contributes, plain head and envelope
/// together. The encoder never writes more (`cloud_encode_rows_hinted`), so an
/// honest blob is never cut; the 1 MiB blob limit already holds a real one to
/// ~24-32k rows (28k for the test corpus, which compresses better than any
/// real history). Without a count cap the work AFTER the decode (key sets, the
/// merge answer, the resident rows) scaled with whatever a crafted blob
/// declared. A reader keeps the first rows, which are the newest, the same
/// rows the encoder's own trim keeps. Why 48k and not more: at ~3.8 KB of
/// estimate per honest row, 48k rows use ~175 MiB of `MAX_DECODED_CLOUD`,
/// which leaves the merge answer (`merge_cloud`, ~600 B per real row) room
/// to spare inside the same budget; at 64k the two would nearly meet.
const MAX_CLOUD_ROWS: usize = 48_000;
/// Ceiling on the merge answer's JSON text (the `replaced` and `added` rows the
/// frontend replays). A full honest blob answers ~10 MiB (28k test rows into an
/// empty store); `MAX_CLOUD_ROWS` real ones would be ~28 MiB. Built once, from the
/// rows themselves, so the text is the only copy; a merge whose answer would
/// not fit is refused before anything is merged.
const MAX_MERGE_ANSWER_BYTES: usize = 64 << 20;
/// Ceilings on a row's KEY: `id` is a Stremio video id (`tt0903747:1:5`,
/// `kitsu:12345:3`, an addon's own scheme) and `played_at` an ISO timestamp
/// (24 bytes). Honest keys are under 100 bytes, so 2 KiB / 64 B only ever drop
/// a planted row. The value cap (`MAX_ROW_COST`) alone let one 60 KB interned
/// string serve as the id of thousands of rows, and every place that keys rows
/// then held it once more.
const MAX_ID_BYTES: usize = 2048;
const MAX_PLAYED_AT_BYTES: usize = 64;
/// Longest text serde_json writes for a JSON scalar: an f64 (ryu) is at most
/// 24 bytes, an integer 20, `false` 5. Used by `file_cost`.
const NUMBER_TEXT_MAX: u64 = 24;
/// What `decode_file` charges for a compact file beyond its rows: the
/// top-level object, its four keys and three arrays (~2.3 KB), rounded up.
const FILE_FIXED_COST: u64 = 4096;

const FILE_SUFFIX: &str = ".history.gz";
/// Beside the file while a set-aside scope still waits for the cloud copy.
const RECOVERING_SUFFIX: &str = ".history.recovering";
/// Plays held for a file that cannot be read (same format as the file).
const PENDING_SUFFIX: &str = ".history.pending.gz";
/// When a file was set aside: unix ms as text, one per line, oldest first.
const SET_ASIDE_SUFFIX: &str = ".history.setaside";
/// Set-aside times kept per scope, so at most this many snapshots are pinned.
const MAX_SET_ASIDE_TIMES: usize = 3;
const GUEST_SCOPE: &str = "guest";

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

struct Resident {
    /// Sanitized scope (also the file stem).
    scope: String,
    /// Rows exactly as the frontend holds them: newest first by insertion,
    /// each an object with string `id` and `played_at`.
    rows: Vec<Value>,
    /// Global generation of the last mutation, and of the last snapshot taken
    /// for a write. Dirty while they differ.
    gen: u64,
    saved_gen: u64,
    /// The scope has a history of its own: its file was on disk when it was
    /// loaded, or a mutation has been made since (drives the legacy carry-over
    /// in the frontend's migration, which a page reload must not re-run over
    /// rows the user removed).
    existed: bool,
    /// The file exists but could not be read. `rows` then holds only plays
    /// appended since, nothing is written, and the read is retried on every
    /// call (see "A FILE THAT EXISTS" above).
    unreadable: bool,
    /// The file did not decode and was set aside; the scope started empty.
    /// Reported by `load` until a cloud merge lands.
    recovered: bool,
    /// The sidecar's rows are in `rows`, so a write of them may remove it.
    pending_merged: bool,
}

/// What a disk read of one scope produced.
struct Loaded {
    rows: Vec<Value>,
    existed: bool,
    recovered: bool,
}

static STATE: Mutex<Option<Resident>> = Mutex::new(None);
/// Plays for a scope a swap was refused for, oldest first: (sanitized scope, row).
/// A leaf lock. See `park_appends`.
static PARKED: Mutex<Vec<(String, Value)>> = Mutex::new(Vec::new());
/// A play is small and a refused swap is a rare, short window.
const MAX_PARKED: usize = 500;
/// Serialises file writes. Holds, per scope written this session, the
/// generation of the newest snapshot that reached disk. Scopes per install
/// are a handful (guest plus one per account), so this stays tiny.
static WRITES: Mutex<Option<HashMap<String, u64>>> = Mutex::new(None);
static GEN: AtomicU64 = AtomicU64::new(1);
static FLUSH_PENDING: AtomicBool = AtomicBool::new(false);
/// Consecutive failed background writes (see `retry_delay`). Reset by the
/// first write that succeeds.
static FLUSH_FAILURES: AtomicU32 = AtomicU32::new(0);
/// Set by `flush_blocking`. From then on every call writes durably before it
/// returns: a delayed background flush armed during the exit would never run,
/// because the process ends first.
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
static DIR: OnceLock<PathBuf> = OnceLock::new();
/// Rows the last cloud encode included / had, for the Settings line.
static LAST_CLOUD: Mutex<Option<(usize, usize)>> = Mutex::new(None);
/// The scope and envelope row count the last TRIMMED cloud encode settled
/// on: the next push's trim search starts there (`fit_envelope`).
static LAST_FIT: Mutex<Option<(String, usize)>> = Mutex::new(None);

fn next_gen() -> u64 {
    GEN.fetch_add(1, Ordering::Relaxed)
}

fn lock_state() -> std::sync::MutexGuard<'static, Option<Resident>> {
    STATE.lock().unwrap_or_else(|p| p.into_inner())
}

fn lock_writes() -> std::sync::MutexGuard<'static, Option<HashMap<String, u64>>> {
    WRITES.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if DIR.get().is_some() {
        return Ok(());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let _ = DIR.set(dir);
    Ok(())
}

fn dir() -> Result<&'static PathBuf, String> {
    DIR.get().ok_or_else(|| "history store not initialised".to_string())
}

/// Scopes arrive from the frontend ("guest", "user-<id16>"). Anything that
/// could leave the directory is stripped, the same rule backup.rs applies.
fn sanitize_scope(scope: &str) -> String {
    let cleaned: String = scope
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        GUEST_SCOPE.to_string()
    } else {
        cleaned
    }
}

fn file_for(dir: &Path, scope: &str) -> PathBuf {
    dir.join(format!("{scope}{FILE_SUFFIX}"))
}

fn recovering_path(dir: &Path, scope: &str) -> PathBuf {
    dir.join(format!("{scope}{RECOVERING_SUFFIX}"))
}

/// A failed removal only costs one more full pull, so it is just logged.
fn clear_recovering(dir: &Path, scope: &str) {
    if let Err(e) = std::fs::remove_file(recovering_path(dir, scope)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::devlog!(warn, "history", "could not remove the recovery marker of {scope}: {e}");
        }
    }
}

fn pending_path(dir: &Path, scope: &str) -> PathBuf {
    dir.join(format!("{scope}{PENDING_SUFFIX}"))
}

fn set_aside_path(dir: &Path, scope: &str) -> PathBuf {
    dir.join(format!("{scope}{SET_ASIDE_SUFFIX}"))
}

// ---------------------------------------------------------------------------
// Row helpers and the mutation definitions
// ---------------------------------------------------------------------------

fn key_of(v: &Value) -> Option<(&str, &str)> {
    let o = v.as_object()?;
    Some((o.get("id")?.as_str()?, o.get("played_at")?.as_str()?))
}

/// The store-wide validity rule (mirrors the frontend's sanitizer): an object
/// with a string `id` and a string `played_at`.
fn is_row(v: &Value) -> bool {
    key_of(v).is_some()
}

/// Upper bound on the B-tree nodes an object of `len` keys allocates (see
/// `MAP_NODE_COST`). An empty map allocates nothing.
fn map_cost(len: usize) -> u64 {
    if len == 0 {
        0
    } else {
        (1 + (len as u64 - 1) / MAP_NODE_MIN_KEYS).saturating_mul(MAP_NODE_COST)
    }
}

/// Estimated heap bytes `v` holds beyond its own `Value` header: string bytes,
/// plus a `Value` slot per array element (a clone allocates exactly `len`),
/// and for an object its B-tree nodes (which hold the key and value slots)
/// plus the key bytes. The same units as `decode_compact`'s budget, and an
/// upper bound on what cloning `v` allocates. Recursion depth: `parse_capped`
/// holds a file or an envelope to serde_json's 128 levels. The IPC payload and
/// the proxy body are plain `Value` parses, where serde_json's RawValue token
/// can nest deeper (see `PlainValue`; 2640 levels measured in a 1 MiB blob, no
/// overflow on a 1 MiB stack), so kept rows are depth-checked first (`row_fits`).
fn value_cost(v: &Value) -> u64 {
    match v {
        Value::String(s) => s.len() as u64,
        Value::Array(a) => a.iter().fold(0u64, |n, x| n.saturating_add(32 + value_cost(x))),
        Value::Object(o) => o.iter().fold(map_cost(o.len()), |n, (k, x)| {
            n.saturating_add(k.len() as u64 + value_cost(x))
        }),
        _ => 0,
    }
}

/// Whether `v` nests deeper than `limit` levels (a scalar is 0, an array or
/// object one more than its deepest child). Stops descending at the limit, so
/// the walk is cheap and its recursion shallow even for a value nested to
/// serde_json's own 128.
fn nests_deeper_than(v: &Value, limit: usize) -> bool {
    match v {
        Value::Array(a) => limit == 0 || a.iter().any(|x| nests_deeper_than(x, limit - 1)),
        Value::Object(o) => limit == 0 || o.values().any(|x| nests_deeper_than(x, limit - 1)),
        _ => false,
    }
}

/// A row small and shallow enough to keep (see `MAX_ROW_COST` and
/// `MAX_ROW_DEPTH`). The depth is checked first: it is the cheap walk, and it
/// keeps `value_cost`'s recursion shallow too.
fn row_fits(v: &Value) -> bool {
    !nests_deeper_than(v, MAX_ROW_DEPTH) && DECODE_ROW_COST.saturating_add(value_cost(v)) <= MAX_ROW_COST
}

/// A row whose key is within `MAX_ID_BYTES` / `MAX_PLAYED_AT_BYTES`.
fn key_fits(v: &Value) -> bool {
    matches!(key_of(v), Some((id, at)) if id.len() <= MAX_ID_BYTES && at.len() <= MAX_PLAYED_AT_BYTES)
}

/// A row the store accepts: the key rule (with its length caps) plus the
/// size cap.
fn is_keepable_row(v: &Value) -> bool {
    key_fits(v) && row_fits(v)
}

/// The text bytes serde_json writes for `s` as a JSON string, quotes
/// included, as an upper bound: it escapes `"`, `\` and the C0 controls only,
/// none of them to more than 6 bytes.
fn json_str_cost(s: &str) -> u64 {
    2 + s
        .bytes()
        .map(|b| match b {
            b'"' | b'\\' => 2u64,
            0..=0x1f => 6,
            _ => 1,
        })
        .sum::<u64>()
}

/// Upper bound on what `json_parse_cost` charges for `v`'s compact text,
/// except the node `v` itself fills (its container's `[` or `,` charges
/// that). Mirrors `json_parse_cost` term by term: an array of n elements is
/// max(n, 1) nodes, its `[` extra and n - 1 commas; an object adds its first
/// B-tree node and, per key, the key charge plus the key's text and `:`.
fn text_cost(v: &Value) -> u64 {
    match v {
        Value::String(s) => json_str_cost(s),
        Value::Array(a) => {
            let n = a.len() as u64;
            a.iter().fold(
                2 + n.saturating_sub(1) + ARRAY_OPEN_EXTRA_COST + PARSE_NODE_COST * n.max(1),
                |c, x| c.saturating_add(text_cost(x)),
            )
        }
        Value::Object(o) => {
            let n = o.len() as u64;
            let per_key = DECODE_FIELD_COST + MAP_NODE_COST.div_ceil(MAP_NODE_MIN_KEYS);
            o.iter().fold(
                2 + n.saturating_sub(1) + MAP_NODE_COST + PARSE_NODE_COST * n.max(1),
                |c, (k, x)| c.saturating_add(per_key + json_str_cost(k) + 1 + text_cost(x)),
            )
        }
        _ => NUMBER_TEXT_MAX,
    }
}

/// Upper bound on what one row adds to `decode_file`'s charge (the parse
/// estimate of the compact text plus `decode_compact`'s charges), as if it
/// shared nothing: its own `strings` entry for every string field and its own
/// shape. The file interns both, so the real charge is lower, often much
/// lower (`compact_file_cost` measures it). The decode part is exact: what
/// `decode_compact` charges for a row is `DECODE_ROW_COST + value_cost(row)`
/// (a timestamp it rebuilds is the same 24 bytes it was encoded from).
fn file_cost(row: &Value) -> u64 {
    let Some(o) = row.as_object() else { return 0 };
    let k = o.len() as u64;
    // Decode: the row, and the shape table's copy of its shape.
    let mut c = DECODE_ROW_COST.saturating_add(value_cost(row)) + 24;
    // Parse: the row array in `rows` (its node, comma and brackets, k + 1
    // element nodes, the shape index's digits).
    c += PARSE_NODE_COST + 3 + k + ARRAY_OPEN_EXTRA_COST + PARSE_NODE_COST * (k + 1) + NUMBER_TEXT_MAX;
    // Parse: its shape in `shapes`, an array of k strings.
    c += PARSE_NODE_COST + 3 + k + ARRAY_OPEN_EXTRA_COST + PARSE_NODE_COST * k.max(1);
    o.iter().fold(c, |c, (name, v)| {
        // The shape field "<kind><name>": decoded (32 + its length) and parsed.
        let field = 33 + name.len() as u64 + json_str_cost(name) + 1;
        let value = match v {
            // An index or a time delta in the row, and (charged either way)
            // the string's own entry in `strings`: node, comma, text.
            Value::String(s) => NUMBER_TEXT_MAX + PARSE_NODE_COST + 1 + json_str_cost(s),
            other => text_cost(other),
        };
        c.saturating_add(field).saturating_add(value)
    })
}

/// Exactly what `decode_file` will charge for the file `rows` encode to, in
/// that order: the compact text's parse estimate (`ParseCost`, fed by
/// serializing, never by allocating the text) plus the decode's charges. As
/// costly as one snapshot (`snapshot_of`), so used only when `file_cost`'s
/// bound is not enough.
fn compact_file_cost(rows: &[&Value]) -> u64 {
    let compact = encode_compact(rows.iter().copied());
    let mut parse = ParseCost::new();
    // Writing to it cannot fail, and the Value always serializes.
    let _ = serde_json::to_writer(&mut parse, &compact);
    let shapes: u64 = compact["shapes"].as_array().map_or(0, |all| {
        all.iter()
            .map(|s| 24 + s.as_array().map_or(0, |fs| fs.iter().map(|f| 32 + f.as_str().map_or(0, str::len) as u64).sum()))
            .sum()
    });
    let decoded = rows
        .iter()
        .filter(|r| r.is_object())
        .fold(0u64, |n, r| n.saturating_add(DECODE_ROW_COST.saturating_add(value_cost(r))));
    parse.total().saturating_add(shapes).saturating_add(decoded)
}

/// `addHistoryEntries`: a row whose (id, played_at) exists is replaced IN
/// PLACE; a new one is unshifted, so the last new row of a batch ends up
/// first. Empty ids / timestamps are refused, as the frontend refuses them.
pub(crate) fn apply_append(rows: &mut Vec<Value>, entries: Vec<Value>) -> usize {
    let fresh: Vec<Value> = entries
        .into_iter()
        .filter(|e| {
            matches!(key_of(e), Some((id, at)) if !id.is_empty() && !at.is_empty()) && is_keepable_row(e)
        })
        .collect();
    if fresh.is_empty() {
        return 0;
    }
    let mut index: HashMap<(String, String), usize> = HashMap::with_capacity(rows.len());
    for (i, r) in rows.iter().enumerate() {
        if let Some((id, at)) = key_of(r) {
            index.entry((id.to_string(), at.to_string())).or_insert(i);
        }
    }
    enum Slot {
        Old(usize),
        New(usize),
    }
    let mut slots: HashMap<(String, String), Slot> = HashMap::new();
    let mut fronts: Vec<Value> = Vec::new();
    for e in fresh {
        let (id, at) = key_of(&e).map(|(a, b)| (a.to_string(), b.to_string())).unwrap();
        let key = (id, at);
        if let Some(slot) = slots.get(&key) {
            match slot {
                Slot::Old(i) => rows[*i] = e,
                Slot::New(i) => fronts[*i] = e,
            }
        } else if let Some(&i) = index.get(&key) {
            rows[i] = e;
            slots.insert(key, Slot::Old(i));
        } else {
            slots.insert(key, Slot::New(fronts.len()));
            fronts.push(e);
        }
    }
    let added = fronts.len();
    if added > 0 {
        fronts.reverse();
        fronts.extend(rows.drain(..));
        *rows = fronts;
    }
    added
}

pub(crate) fn apply_remove(rows: &mut Vec<Value>, keys: &[(String, String)]) -> usize {
    if keys.is_empty() {
        return 0;
    }
    let drop: HashSet<(&str, &str)> = keys.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
    let before = rows.len();
    rows.retain(|r| match key_of(r) {
        Some(k) => !drop.contains(&k),
        None => true,
    });
    before - rows.len()
}

/// Also drops an oversized row (`MAX_ROW_COST`): this is the load path of the
/// file, so a row a build without the cap persisted is shed on the next launch
/// and, with the next write, from the file too.
pub(crate) fn sanitize_rows(entries: Vec<Value>) -> Vec<Value> {
    let before = entries.len();
    let out: Vec<Value> = entries.into_iter().filter(is_keepable_row).collect();
    let dropped = before - out.len();
    if dropped > 0 {
        crate::devlog!(warn, "history", "dropped {dropped} unusable or oversized row(s)");
    }
    out
}

/// Union that keeps what is already here: used by the localStorage
/// migration, where the file (possibly holding plays made since) is the
/// newer truth and the carried rows are older. New rows go at the END, in
/// their own order. Idempotent, which is what makes a migration interrupted
/// by a crash safe to run again.
pub(crate) fn apply_union_keep_existing(rows: &mut Vec<Value>, entries: Vec<Value>) -> usize {
    let mut seen: HashSet<(String, String)> = rows
        .iter()
        .filter_map(key_of)
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    let mut added = 0;
    for e in entries {
        let Some((id, at)) = key_of(&e).map(|(a, b)| (a.to_string(), b.to_string())) else { continue };
        if seen.insert((id, at)) {
            rows.push(e);
            added += 1;
        }
    }
    added
}

/// What merging a cloud copy WILL do, worked out without touching the rows
/// (`plan_cloud_merge`), so the answer can be built from it before the rows
/// are moved in (`commit_cloud_merge`): each server row then exists exactly
/// once, never as a resident copy plus a delta copy.
pub(crate) struct MergePlan {
    /// (local index, server row) for every shared key whose row differs.
    pub replaced: Vec<(usize, Value)>,
    /// Server rows with no local counterpart, in server order.
    pub added: Vec<Value>,
    /// Local rows whose key the cloud copy lacks.
    pub local_only: usize,
}

impl MergePlan {
    fn changes(&self) -> bool {
        !self.replaced.is_empty() || !self.added.is_empty()
    }
}

/// The cloud merge, same semantics as the old `mergeHistory`: a union by
/// (id, played_at) in which the SERVER copy wins a shared key (it may carry
/// enrichment a sparser local row lacks), sorted newest first by `played_at`.
/// Defined so the frontend can reproduce the result from the delta alone:
/// replace the shared keys in place, append the new rows in server order,
/// then a STABLE sort descending by `played_at` (code-unit order, identical to
/// byte order for the ASCII timestamps Aura writes). Nothing changed = no
/// sort and no write. No cap: the old 1000-row slice is gone.
///
/// The key sets BORROW their keys from the rows (one pass decides each server
/// row's fate, a second moves the rows out), so they cost a few words per row
/// whatever the keys hold: copying them was a second full copy of every key a
/// cloud copy carried, outside the decode budget.
pub(crate) fn plan_cloud_merge(rows: &[Value], server: Vec<Value>) -> MergePlan {
    enum Fate {
        Skip,
        Replace(usize),
        Add,
    }
    let (fates, local_only) = {
        let mut index: HashMap<(&str, &str), usize> = HashMap::with_capacity(rows.len());
        for (i, r) in rows.iter().enumerate() {
            if let Some(k) = key_of(r) {
                index.entry(k).or_insert(i);
            }
        }
        let mut seen: HashSet<(&str, &str)> = HashSet::with_capacity(server.len());
        let fates: Vec<Fate> = server
            .iter()
            .map(|s| {
                let Some(k) = key_of(s) else { return Fate::Skip };
                if !seen.insert(k) {
                    return Fate::Skip; // first server occurrence wins, as before
                }
                match index.get(&k) {
                    Some(&i) if rows[i] != *s => Fate::Replace(i),
                    Some(_) => Fate::Skip,
                    None => Fate::Add,
                }
            })
            .collect();
        drop(index);
        // The same count the old code took from the merged list: added rows
        // all carry server keys, so only the local rows can lack one.
        let local_only = rows.iter().filter_map(key_of).filter(|k| !seen.contains(k)).count();
        (fates, local_only)
    };
    let mut replaced = Vec::new();
    let mut added = Vec::new();
    for (s, fate) in server.into_iter().zip(fates) {
        match fate {
            Fate::Replace(i) => replaced.push((i, s)),
            Fate::Add => added.push(s),
            Fate::Skip => {}
        }
    }
    MergePlan { replaced, added, local_only }
}

/// Refuse a merge that would leave the resident rows bigger than the file
/// they are written to can be read back (`file_cap`, `MAX_DECODED_LOCAL` live).
/// Without it a cloud copy could add up to the answer cap per pull with no
/// limit across pulls (crafted rows of a 60 KB interned string each add ~57
/// MiB), until the local file's decode passed its budget: the next launch then
/// set it aside and started the scope EMPTY. `file_cost` bounds it cheaply;
/// only past that bound is the exact charge measured (`compact_file_cost`),
/// which keeps honest capacity where the file's own budget puts it. A merge
/// that does not grow the store is never refused.
fn check_merged_file_fits(rows: &[Value], plan: &MergePlan, file_cap: u64) -> Result<(), String> {
    let before = rows.iter().fold(FILE_FIXED_COST, |n, r| n.saturating_add(file_cost(r)));
    let mut after = before;
    for (i, s) in &plan.replaced {
        after = after.saturating_sub(file_cost(&rows[*i])).saturating_add(file_cost(s));
    }
    let after = plan.added.iter().fold(after, |n, r| n.saturating_add(file_cost(r)));
    if after <= file_cap || after <= before {
        return Ok(());
    }
    // The merged rows in the order `commit_cloud_merge` leaves them (the same
    // stable sort), so the measure is of the very file the next write makes.
    let swaps: HashMap<usize, &Value> = plan.replaced.iter().map(|(i, s)| (*i, s)).collect();
    let mut order: Vec<&Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| swaps.get(&i).copied().unwrap_or(r))
        .chain(plan.added.iter())
        .collect();
    drop(swaps);
    order.sort_by(|a, b| {
        let pa = key_of(a).map(|k| k.1).unwrap_or("");
        let pb = key_of(b).map(|k| k.1).unwrap_or("");
        pb.cmp(pa)
    });
    let exact = compact_file_cost(&order);
    if exact <= file_cap {
        return Ok(());
    }
    Err(format!(
        "cloud history: merging would grow the history file past what it can be read back at ({exact} of {file_cap} bytes estimated); nothing was merged"
    ))
}

/// Apply a plan, MOVING its rows in. Returns whether anything changed.
pub(crate) fn commit_cloud_merge(rows: &mut Vec<Value>, plan: MergePlan) -> bool {
    if !plan.changes() {
        return false;
    }
    for (i, s) in plan.replaced {
        rows[i] = s;
    }
    rows.extend(plan.added);
    sort_newest_first(rows);
    true
}

/// The rows of `(index, row)` pairs, serialized as a plain array of rows.
struct PlanRows<'a>(&'a [(usize, Value)]);

impl serde::Serialize for PlanRows<'_> {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(|(_, v)| v))
    }
}

/// What `merge_cloud` answers the frontend. Serialized straight from the
/// plan's rows, by reference.
#[derive(serde::Serialize)]
struct MergeAnswer<'a> {
    replaced: PlanRows<'a>,
    added: &'a [Value],
    legacy: bool,
    server_count: usize,
    local_only: usize,
    count: usize,
}

/// A writer that only counts, and fails once past `limit`, so the answer's
/// size is known (and refused) before a byte of it is allocated.
struct CountingWriter {
    n: usize,
    limit: usize,
}

impl Write for CountingWriter {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.n += b.len();
        if self.n > self.limit {
            return Err(std::io::Error::other("over the size cap"));
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Merge a decoded cloud copy into `rows` and build the answer for the
/// frontend, as ONE JSON text. Post-decode memory is bounded structurally:
/// the server rows are moved (never cloned) into the plan and then into
/// `rows`, and the answer is the only other copy, sized by a counting pass
/// and allocated once at its exact length. Its ceiling is what the decode
/// budget has left after the rows themselves (`MAX_DECODED_CLOUD`, so the
/// decoded rows plus the answer stay inside the budget the decode was held
/// to), and never more than `MAX_MERGE_ANSWER_BYTES`. Too big = refused with
/// `rows` untouched, and so is a merge whose rows would no longer fit the
/// local file's decode budget (`check_merged_file_fits`). Returns (answer,
/// changed).
fn merge_cloud(
    rows: &mut Vec<Value>,
    server: Vec<Value>,
    legacy: bool,
) -> Result<(Box<serde_json::value::RawValue>, bool), String> {
    merge_cloud_within(rows, server, legacy, MAX_DECODED_LOCAL)
}

/// `merge_cloud` against a given file budget, so a test can reach it without
/// a gigabyte of rows.
fn merge_cloud_within(
    rows: &mut Vec<Value>,
    server: Vec<Value>,
    legacy: bool,
    file_cap: u64,
) -> Result<(Box<serde_json::value::RawValue>, bool), String> {
    let server_count = server.len();
    let decoded: u64 = server.iter().map(|r| DECODE_ROW_COST.saturating_add(value_cost(r))).sum();
    let limit = (MAX_DECODED_CLOUD.saturating_sub(decoded) as usize).min(MAX_MERGE_ANSWER_BYTES);
    let plan = plan_cloud_merge(rows, server);
    if plan.changes() {
        check_merged_file_fits(rows, &plan, file_cap)?;
    }
    let count = rows.len() + plan.added.len();
    let answer = MergeAnswer {
        replaced: PlanRows(&plan.replaced),
        added: &plan.added,
        legacy,
        server_count,
        local_only: plan.local_only,
        count,
    };
    let mut counter = CountingWriter { n: 0, limit };
    if serde_json::to_writer(&mut counter, &answer).is_err() {
        return Err(format!(
            "cloud history: the merge answer is over its {limit}-byte cap ({server_count} rows); nothing was merged"
        ));
    }
    let mut text = Vec::with_capacity(counter.n);
    serde_json::to_writer(&mut text, &answer).map_err(|e| e.to_string())?;
    let text = String::from_utf8(text).map_err(|e| e.to_string())?;
    let raw = serde_json::value::RawValue::from_string(text).map_err(|e| e.to_string())?;
    Ok((raw, commit_cloud_merge(rows, plan)))
}

/// The old one-call form, for the tests that pin the merge semantics: the
/// delta's rows are clones, which only a test can afford.
#[cfg(test)]
pub(crate) struct MergeDelta {
    pub replaced: Vec<Value>,
    pub added: Vec<Value>,
}

#[cfg(test)]
pub(crate) fn apply_cloud_merge(rows: &mut Vec<Value>, server: Vec<Value>) -> MergeDelta {
    let plan = plan_cloud_merge(rows, server);
    let delta = MergeDelta {
        replaced: plan.replaced.iter().map(|(_, v)| v.clone()).collect(),
        added: plan.added.clone(),
    };
    commit_cloud_merge(rows, plan);
    delta
}

fn sort_newest_first(rows: &mut [Value]) {
    // Vec::sort_by is stable, like Array.prototype.sort since ES2019.
    rows.sort_by(|a, b| {
        let pa = key_of(a).map(|k| k.1).unwrap_or("");
        let pb = key_of(b).map(|k| k.1).unwrap_or("");
        pb.cmp(pa)
    });
}

// ---------------------------------------------------------------------------
// Timestamps: exact round trip with JS `Date.prototype.toISOString`
// ---------------------------------------------------------------------------

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `new Date(ms).toISOString()` for years 0000-9999 (the only years that form
/// produces without a sign), else None.
pub(crate) fn format_iso_ms(ms: i64) -> Option<String> {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    if !(0..=9999).contains(&y) {
        return None;
    }
    let (h, rem) = (rem / 3_600_000, rem % 3_600_000);
    let (mi, rem) = (rem / 60_000, rem % 60_000);
    let (s, milli) = (rem / 1000, rem % 1000);
    Some(format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z"))
}

/// The millisecond value of `s` ONLY when formatting it back yields `s`
/// byte for byte. Anything else (a second-precision string, an offset, an
/// out-of-range day that would normalize) is not a candidate.
pub(crate) fn parse_iso_ms_exact(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() != 24
        || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':'
        || b[16] != b':' || b[19] != b'.' || b[23] != b'Z'
    {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let mut n = 0i64;
        for &c in &b[from..to] {
            if !c.is_ascii_digit() {
                return None;
            }
            n = n * 10 + (c - b'0') as i64;
        }
        Some(n)
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, sec, milli) = (num(11, 13)?, num(14, 16)?, num(17, 19)?, num(20, 23)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let ms = days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + sec * 1000 + milli;
    (format_iso_ms(ms).as_deref() == Some(s)).then_some(ms)
}

// ---------------------------------------------------------------------------
// Compact form
// ---------------------------------------------------------------------------

const KIND_STR: char = 's'; // interned string: value is an index into `strings`
const KIND_TIME: char = 't'; // exact ISO timestamp: value is a ms delta
const KIND_RAW: char = 'j'; // anything else, verbatim

/// Encode rows (in order) to the compact JSON value.
pub(crate) fn encode_compact<'a, I>(rows: I) -> Value
where
    I: IntoIterator<Item = &'a Value>,
{
    let mut strings: Vec<&'a str> = Vec::new();
    let mut string_ix: HashMap<&'a str, usize> = HashMap::new();
    let mut shapes: Vec<Vec<String>> = Vec::new();
    let mut shape_ix: HashMap<Vec<String>, usize> = HashMap::new();
    let mut prev_t: HashMap<&'a str, i64> = HashMap::new();
    let mut out_rows: Vec<Value> = Vec::new();
    for row in rows {
        let Some(obj) = row.as_object() else { continue };
        let mut shape: Vec<String> = Vec::with_capacity(obj.len());
        let mut vals: Vec<Value> = Vec::with_capacity(obj.len() + 1);
        vals.push(Value::Null); // shape index, filled below
        for (k, v) in obj {
            match v {
                Value::String(s) => {
                    if let Some(ms) = parse_iso_ms_exact(s) {
                        let prev = prev_t.insert(k.as_str(), ms).unwrap_or(0);
                        shape.push(format!("{KIND_TIME}{k}"));
                        vals.push(json!(ms - prev));
                    } else {
                        let ix = *string_ix.entry(s.as_str()).or_insert_with(|| {
                            strings.push(s.as_str());
                            strings.len() - 1
                        });
                        shape.push(format!("{KIND_STR}{k}"));
                        vals.push(json!(ix));
                    }
                }
                other => {
                    shape.push(format!("{KIND_RAW}{k}"));
                    vals.push(other.clone());
                }
            }
        }
        let six = match shape_ix.get(&shape) {
            Some(&i) => i,
            None => {
                shapes.push(shape.clone());
                shape_ix.insert(shape, shapes.len() - 1);
                shapes.len() - 1
            }
        };
        vals[0] = json!(six);
        out_rows.push(Value::Array(vals));
    }
    json!({ "v": FILE_VERSION, "strings": strings, "shapes": shapes, "rows": out_rows })
}

/// Decode the compact form. `budget` bounds the estimated bytes the decoded
/// rows occupy (see `MAX_DECODED_CLOUD`); it is checked BEFORE each string
/// copy, so a hostile blob fails cheaply instead of allocating first.
pub(crate) fn decode_compact(v: &Value, budget: u64) -> Result<Vec<Value>, String> {
    decode_compact_rows(v, budget, usize::MAX)
}

/// `decode_compact` reading at most `max_rows` rows (the first ones, which in
/// a cloud envelope are the newest; see `MAX_CLOUD_ROWS`). A row whose raw
/// field nests past `MAX_ROW_DEPTH`, or alone costs more than `MAX_ROW_COST`,
/// is SKIPPED here without being copied: it could never be kept (`row_fits`),
/// and skipping it, rather than failing the whole decode, keeps one planted
/// row from setting the user's file aside or blocking every cloud merge.
fn decode_compact_rows(v: &Value, budget: u64, max_rows: usize) -> Result<Vec<Value>, String> {
    let ver = v.get("v").and_then(Value::as_u64).ok_or("compact: no version")?;
    if ver != FILE_VERSION {
        return Err(format!("compact: unsupported version {ver}"));
    }
    let strings = v.get("strings").and_then(Value::as_array).ok_or("compact: no strings")?;
    let shapes_v = v.get("shapes").and_then(Value::as_array).ok_or("compact: no shapes")?;
    let rows_v = v.get("rows").and_then(Value::as_array).ok_or("compact: no rows")?;
    let mut spent: u64 = 0;
    let mut charge = |n: u64| -> Result<(), String> {
        spent = spent.saturating_add(n);
        if spent > budget {
            Err(format!("compact: decoded size over the {budget}-byte cap"))
        } else {
            Ok(())
        }
    };
    // The shape table is a second copy of the parsed one (a `(char, String)`
    // slot plus the name per field), alive beside it, so it is charged too.
    let mut shapes: Vec<Vec<(char, String)>> = Vec::with_capacity(shapes_v.len());
    for s in shapes_v {
        let fields = s.as_array().ok_or("compact: bad shape")?;
        charge(24)?;
        let mut out = Vec::with_capacity(fields.len());
        for f in fields {
            let f = f.as_str().ok_or("compact: bad field")?;
            let mut it = f.chars();
            let kind = it.next().ok_or("compact: empty field")?;
            if ![KIND_STR, KIND_TIME, KIND_RAW].contains(&kind) {
                return Err(format!("compact: unknown kind {kind}"));
            }
            charge(32 + f.len() as u64)?;
            out.push((kind, it.as_str().to_string()));
        }
        shapes.push(out);
    }
    let mut prev_t: HashMap<String, i64> = HashMap::new();
    let mut out = Vec::with_capacity(rows_v.len().min(max_rows));
    let mut skipped = 0usize;
    for r in rows_v.iter().take(max_rows) {
        let arr = r.as_array().ok_or("compact: bad row")?;
        let six = arr.first().and_then(Value::as_u64).ok_or("compact: bad shape ref")? as usize;
        let shape = shapes.get(six).ok_or("compact: shape out of range")?;
        if arr.len() != shape.len() + 1 {
            return Err("compact: row length".into());
        }
        // The row's slot in `out` plus the B-tree nodes its fields fill (the
        // nodes hold every key and value slot; `MAP_NODE_COST`).
        charge(DECODE_ROW_COST.saturating_add(map_cost(shape.len())))?;
        let mut obj = Map::new();
        // Cleared by a raw field the row can never keep. The row is still
        // walked to the end: its timestamps are deltas the NEXT rows build on.
        let mut keep = true;
        for ((kind, name), val) in shape.iter().zip(arr.iter().skip(1)) {
            charge(name.len() as u64)?;
            let value = match *kind {
                KIND_STR => {
                    let ix = val.as_u64().ok_or("compact: bad string ref")? as usize;
                    let s = strings.get(ix).and_then(Value::as_str).ok_or("compact: string out of range")?;
                    if !keep {
                        continue;
                    }
                    charge(s.len() as u64)?;
                    Value::String(s.to_string())
                }
                KIND_TIME => {
                    let delta = val.as_i64().ok_or("compact: bad time")?;
                    let prev = prev_t.get(name).copied().unwrap_or(0);
                    let ms = prev.checked_add(delta).ok_or("compact: time overflow")?;
                    prev_t.insert(name.clone(), ms);
                    let iso = format_iso_ms(ms).ok_or("compact: time out of range")?;
                    if !keep {
                        continue;
                    }
                    charge(24)?; // the ISO string it becomes
                    Value::String(iso)
                }
                // Charged by its full size BEFORE the clone: an uncharged raw
                // field was the hole in this budget (a 33M-element array cost
                // 48 bytes plus its name, then cloned ~1 GiB), and so was an
                // object charged per field rather than per B-tree node. The
                // depth is checked before the size: it is the cheap walk, and
                // a too-deep field is never sized or copied at all.
                _ => {
                    if !keep {
                        continue;
                    }
                    if nests_deeper_than(val, MAX_ROW_DEPTH - 1) {
                        keep = false;
                        continue;
                    }
                    let cost = value_cost(val);
                    charge(cost)?;
                    if cost > MAX_ROW_COST {
                        keep = false;
                        continue;
                    }
                    val.clone()
                }
            };
            obj.insert(name.clone(), value);
        }
        if keep {
            out.push(Value::Object(obj));
        } else {
            skipped += 1;
        }
    }
    if skipped > 0 {
        crate::devlog!(warn, "history", "skipped {skipped} row(s) nested too deep or too large to keep");
    }
    Ok(out)
}

fn gzip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = GzEncoder::new(Vec::with_capacity(bytes.len() / 6), Compression::default());
    enc.write_all(bytes).map_err(|e| e.to_string())?;
    enc.finish().map_err(|e| e.to_string())
}

fn gunzip_capped(bytes: &[u8], cap: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    GzDecoder::new(bytes)
        .take(cap + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("inflate: {e}"))?;
    if out.len() as u64 > cap {
        return Err("inflate: over size cap".into());
    }
    Ok(out)
}

/// An upper bound, in the decode budget's units, on what `serde_json` will
/// allocate parsing `raw` into a `Value`, found by one scan that allocates
/// nothing, so a hostile document is refused BEFORE it is parsed. The inflate
/// cap bounds the TEXT only: each 2-byte `0,` becomes a 32-byte `Value`. Every
/// value is the root, follows a `,`, or is the first inside a `[` / `{`, so
/// nodes <= 1 + commas + opening brackets; every object key is followed by a
/// `:`; and string bytes cannot exceed the text. An object's B-tree nodes are
/// charged on top (`map_cost`'s bound split per `{` and per key): its first
/// node with the `{`, every further one spread over the keys that need it.
/// An array's minimum Vec capacity is charged with its `[`
/// (`ARRAY_OPEN_EXTRA_COST`).
pub(crate) fn json_parse_cost(raw: &[u8]) -> u64 {
    let mut p = ParseCost::new();
    p.feed(raw);
    p.total()
}

/// `json_parse_cost`'s scan, fed in pieces: a `Write` sink, so the estimate
/// of a text serde_json is writing is known without the text ever existing
/// (`compact_file_cost`).
struct ParseCost {
    nodes: u64,
    keys: u64,
    objects: u64,
    arrays: u64,
    len: u64,
    in_str: bool,
    esc: bool,
}

impl ParseCost {
    fn new() -> Self {
        ParseCost { nodes: 1, keys: 0, objects: 0, arrays: 0, len: 0, in_str: false, esc: false }
    }

    fn feed(&mut self, raw: &[u8]) {
        self.len = self.len.saturating_add(raw.len() as u64);
        for &b in raw {
            if self.in_str {
                if self.esc {
                    self.esc = false;
                } else if b == b'\\' {
                    self.esc = true;
                } else if b == b'"' {
                    self.in_str = false;
                }
                continue;
            }
            match b {
                b'"' => self.in_str = true,
                b',' => self.nodes += 1,
                b'[' => {
                    self.nodes += 1;
                    self.arrays += 1;
                }
                b'{' => {
                    self.nodes += 1;
                    self.objects += 1;
                }
                b':' => self.keys += 1,
                _ => {}
            }
        }
    }

    fn total(&self) -> u64 {
        let per_key = DECODE_FIELD_COST + MAP_NODE_COST.div_ceil(MAP_NODE_MIN_KEYS);
        self.nodes
            .saturating_mul(PARSE_NODE_COST)
            .saturating_add(self.objects.saturating_mul(MAP_NODE_COST))
            .saturating_add(self.arrays.saturating_mul(ARRAY_OPEN_EXTRA_COST))
            .saturating_add(self.keys.saturating_mul(per_key))
            .saturating_add(self.len)
    }
}

impl Write for ParseCost {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.feed(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A `Value` built here instead of by `Value`'s own `Deserialize`. tauri and
/// axum force serde_json's `raw_value` feature on, and with it `Value`'s visitor
/// treats the key `$serde_json::private::RawValue` as a token and RE-PARSES the
/// string under it. `ParseCost` skips string contents, so a crafted file or
/// envelope expanded far past the budget it was just charged (4.6 GiB from a
/// 174 KB blob against the 256 MiB budget), and each re-parse restarted the
/// recursion limit. Reading keys as plain `String`s never reaches that token.
/// A byte scan for the key would not do: JSON escapes can spell it.
struct PlainValue(Value);

impl<'de> Deserialize<'de> for PlainValue {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = PlainValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("any JSON value")
            }
            fn visit_bool<E>(self, b: bool) -> Result<PlainValue, E> {
                Ok(PlainValue(Value::Bool(b)))
            }
            fn visit_i64<E>(self, n: i64) -> Result<PlainValue, E> {
                Ok(PlainValue(Value::from(n)))
            }
            fn visit_u64<E>(self, n: u64) -> Result<PlainValue, E> {
                Ok(PlainValue(Value::from(n)))
            }
            fn visit_f64<E>(self, n: f64) -> Result<PlainValue, E> {
                Ok(PlainValue(Value::from(n)))
            }
            fn visit_str<E>(self, s: &str) -> Result<PlainValue, E> {
                Ok(PlainValue(Value::String(s.to_owned())))
            }
            fn visit_string<E>(self, s: String) -> Result<PlainValue, E> {
                Ok(PlainValue(Value::String(s)))
            }
            fn visit_unit<E>(self) -> Result<PlainValue, E> {
                Ok(PlainValue(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<PlainValue, A::Error> {
                let mut out = Vec::new();
                while let Some(PlainValue(v)) = seq.next_element()? {
                    out.push(v);
                }
                Ok(PlainValue(Value::Array(out)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<PlainValue, A::Error> {
                let mut out = Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    let PlainValue(v) = map.next_value()?;
                    out.insert(key, v);
                }
                Ok(PlainValue(Value::Object(out)))
            }
        }
        d.deserialize_any(V)
    }
}

/// Parse `raw` only when its estimated tree fits `budget`. Returns the value
/// and what it was charged, so the decode that follows gets the remainder
/// (both trees are alive at once).
fn parse_capped(raw: &[u8], budget: u64) -> Result<(Value, u64), String> {
    let cost = json_parse_cost(raw);
    if cost > budget {
        return Err(format!("parse: estimated size {cost} over the {budget}-byte cap"));
    }
    let PlainValue(v) = serde_json::from_slice(raw).map_err(|e| format!("parse: {e}"))?;
    Ok((v, cost))
}

/// The file bytes for `rows`. The main file's path splits this in two (compact
/// JSON under the lock, gzip after it, see `take_snapshot`).
pub(crate) fn encode_file(rows: &[Value]) -> Result<Vec<u8>, String> {
    let compact = serde_json::to_vec(&encode_compact(rows.iter())).map_err(|e| e.to_string())?;
    gzip(&compact)
}

pub(crate) fn decode_file(bytes: &[u8]) -> Result<Vec<Value>, String> {
    decode_file_within(bytes, MAX_DECODED_LOCAL)
}

/// `decode_file` held to `budget` (parse and decode together).
fn decode_file_within(bytes: &[u8], budget: u64) -> Result<Vec<Value>, String> {
    let raw = gunzip_capped(bytes, MAX_INFLATED_LOCAL)?;
    let (v, spent) = parse_capped(&raw, budget)?;
    drop(raw);
    decode_compact(&v, budget - spent)
}

// ---------------------------------------------------------------------------
// Base64 (standard alphabet, padded). Twenty lines here beat a new crate.
// ---------------------------------------------------------------------------

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | (*chunk.get(1).unwrap_or(&0) as u32) << 8
            | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err("base64: bad character".into()),
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Cloud blob
// ---------------------------------------------------------------------------
//
// WIRE SHAPE: a plain JSON ARRAY, `[row, row, ..., envelope]`. The first rows
// are the newest `CLOUD_HEAD_ROWS` in their plain form, exactly as v2.2.4 and
// older store them; the LAST element is
// `{"v":2,"enc":"gzip-b64","n":N,"data":"..."}` holding the next N rows in
// the compact gzip form. Why not the bare envelope: v2.2.4 pushes its whole
// local list on its first local edit (its launch push is cancelled in the same
// tick, see sync.ts "MIXED VERSIONS"), and its merge reads only an array. Given
// a bare object it merged nothing, so a fresh install replaced the cloud copy
// with its next play alone. Given this array it merges the plain head (the
// envelope element has no string `id` / `played_at`, which its merge skips), so
// its push is at worst its own rows plus the newest head, never just the one
// play. The head costs envelope room (~8k real rows of capacity), the price of
// that floor.

/// The plain head: at most this many rows, and at most this many bytes (or a
/// quarter of the budget, whichever is smaller).
const CLOUD_HEAD_ROWS: usize = 500;
const CLOUD_HEAD_BYTES: usize = 256 * 1024;

fn envelope_for(rows: &[&Value]) -> Result<(Value, usize), String> {
    #[cfg(test)]
    ENCODES.with(|c| c.set(c.get() + 1));
    let compact = serde_json::to_vec(&encode_compact(rows.iter().copied())).map_err(|e| e.to_string())?;
    let data = b64_encode(&gzip(&compact)?);
    let env = json!({ "v": CLOUD_VERSION, "enc": CLOUD_ENC, "n": rows.len(), "data": data });
    let size = serde_json::to_vec(&env).map(|b| b.len()).map_err(|e| e.to_string())?;
    Ok((env, size))
}

#[cfg(test)]
thread_local! {
    /// Envelope encodes on this thread, so a test can pin the search cost.
    static ENCODES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// How close to the exact largest prefix the trim search must get: 0.5% of
/// the rows, at least one. Settling to the exact row took 7-9 full encodes of
/// ~24k rows (1.5-2 s of CPU) on EVERY push of a history past the budget,
/// most of them bisecting a gap of a few hundred rows; the cloud copy losing
/// up to ~120 of its oldest rows to save that is no loss (the local file keeps
/// every row).
fn fit_tolerance(lo: usize) -> usize {
    (lo / 200).max(1)
}

/// The envelope of the longest prefix of `order` that fits `budget`, to
/// within `fit_tolerance` rows. `hint` is the row count the previous search
/// settled on: one new play moves the boundary by about a row, so starting
/// there settles in two encodes instead of a cold search. Returns (envelope,
/// rows included).
fn fit_envelope(order: &[&Value], budget: usize, hint: Option<usize>) -> Result<(Value, usize), String> {
    let total = order.len();
    // A hint inside (0, total) skips the full encode: the last search found
    // the full list too big. A history that shrank since (a remove) is still
    // found: until a probe misses, the search keeps stepping up, to `total`
    // itself if that fits. No hint starts with the full list, which is the
    // only encode a history under the budget needs.
    let mut probe = hint.filter(|&h| h > 0 && h < total).unwrap_or(total);
    // lo fits (0 always does), hi does not (`total + 1`: no miss yet). Their
    // sizes drive the next estimate.
    let (mut lo, mut s_lo) = (0usize, 0usize);
    let (mut hi, mut s_hi) = (total + 1, 0usize);
    let mut best: Option<Value> = None;
    // Fixed at the first miss, from the boundary estimate then, so the stop
    // rule does not drift as `lo` moves. None until a probe has missed.
    let mut tol: Option<usize> = None;
    loop {
        let (e, s) = envelope_for(&order[..probe])?;
        if s <= budget {
            lo = probe;
            s_lo = s;
            best = Some(e);
            if lo == total {
                break;
            }
        } else {
            hi = probe;
            s_hi = s;
            if tol.is_none() {
                // Compression is close to linear in rows.
                tol = Some(fit_tolerance(((probe as f64) * (budget as f64 / s as f64)) as usize));
            }
        }
        let Some(t) = tol else {
            // No miss yet: step up by the remaining proportional headroom, at
            // least a tolerance, so a hint that still fits is confirmed by the
            // next probe missing.
            let up = ((lo as f64) * (budget as f64 / s_lo.max(1) as f64 - 1.0)) as usize;
            probe = (lo + up.max(fit_tolerance(lo))).min(total);
            continue;
        };
        if hi - lo <= t {
            break;
        }
        // Interpolate the boundary between the two bracketing sizes (from 0
        // bytes at 0 rows before anything fitted), then snap: a probe one
        // tolerance under the miss ends the search if it fits, one tolerance
        // over the fit ends it if it misses, so an estimate near either end
        // settles in one more encode.
        let frac = budget.saturating_sub(s_lo) as f64 / s_hi.saturating_sub(s_lo).max(1) as f64;
        let est = (lo as f64 + frac * (hi - lo) as f64) as usize;
        probe = if est + t >= hi {
            hi - t
        } else if est <= lo + t {
            lo + t
        } else {
            est
        };
        if probe <= lo || probe >= hi {
            probe = lo + (hi - lo) / 2;
            if probe <= lo {
                break;
            }
        }
    }
    let env = match best {
        Some(e) => e,
        None => envelope_for(&[])?.0,
    };
    Ok((env, lo))
}

/// The cloud copy: every row when it fits `budget`, else the newest rows that
/// do (by `played_at`, so an old re-imported row cannot crowd out tonight's
/// play). Returns (blob, included, total). The live path is the hinted one.
#[cfg(test)]
pub(crate) fn cloud_encode_rows(rows: &[Value], budget: usize) -> Result<(Value, usize, usize), String> {
    cloud_encode_rows_hinted(rows, budget, None).map(|(b, inc, total, _)| (b, inc, total))
}

/// `cloud_encode_rows` with the previous search's envelope row count as a
/// starting point (see `fit_envelope`). Also returns this search's envelope
/// row count, the next call's hint.
fn cloud_encode_rows_hinted(
    rows: &[Value],
    budget: usize,
    hint: Option<usize>,
) -> Result<(Value, usize, usize, usize), String> {
    let mut order: Vec<&Value> = rows.iter().collect();
    // Stable, so equal timestamps keep the local order.
    order.sort_by(|a, b| {
        let pa = key_of(a).map(|k| k.1).unwrap_or("");
        let pb = key_of(b).map(|k| k.1).unwrap_or("");
        pb.cmp(pa)
    });
    let total = order.len();
    // `[` + `]`, then each head row plus the comma after it (the last comma
    // separates the head from the envelope), so head_bytes + the envelope's
    // size is exactly the serialized blob.
    let head_cap = CLOUD_HEAD_BYTES.min(budget / 4);
    let mut head_bytes = 2usize;
    let mut head = 0usize;
    for r in order.iter().take(CLOUD_HEAD_ROWS) {
        let n = serde_json::to_vec(r).map(|b| b.len()).map_err(|e| e.to_string())? + 1;
        if head_bytes + n > head_cap {
            break;
        }
        head_bytes += n;
        head += 1;
    }
    // Never more rows than a reader keeps (`MAX_CLOUD_ROWS`), so an honest
    // copy is never cut by the reader's cap.
    let cap = total.min(MAX_CLOUD_ROWS);
    let (env, env_rows) = fit_envelope(&order[head..cap], budget.saturating_sub(head_bytes), hint)?;
    let mut blob: Vec<Value> = Vec::with_capacity(head + 1);
    blob.extend(order[..head].iter().map(|v| (*v).clone()));
    blob.push(env);
    Ok((Value::Array(blob), head + env_rows, total, env_rows))
}

/// The compact rows inside one envelope object. A version this build does not
/// know is an error, so a newer client's blob is never overwritten by a merge
/// that could not read it.
fn decode_envelope(obj: &Map<String, Value>, max_rows: usize) -> Result<Vec<Value>, String> {
    let ver = obj.get("v").and_then(Value::as_u64).unwrap_or(0);
    let enc = obj.get("enc").and_then(Value::as_str).unwrap_or("");
    if ver != CLOUD_VERSION || enc != CLOUD_ENC {
        return Err(format!("cloud history: unsupported envelope v={ver} enc={enc}"));
    }
    let b64 = obj.get("data").and_then(Value::as_str).ok_or("cloud history: no data")?;
    let raw = gunzip_capped(&b64_decode(b64)?, MAX_INFLATED_CLOUD)?;
    let (compact, spent) = parse_capped(&raw, MAX_DECODED_CLOUD).map_err(|e| format!("cloud history {e}"))?;
    drop(raw);
    Ok(decode_compact_rows(&compact, MAX_DECODED_CLOUD - spent, max_rows)?
        .into_iter()
        .filter(is_keepable_row)
        .collect())
}

/// An element that is an envelope rather than a row: an object without the
/// row key that carries `v` and `enc`.
fn as_envelope(v: &Value) -> Option<&Map<String, Value>> {
    let o = v.as_object()?;
    (!is_row(v) && o.contains_key("v") && o.contains_key("enc")).then_some(o)
}

/// Read a cloud blob in any shape: the current array with a trailing
/// envelope, the legacy plain array an older Aura pushes, or a bare envelope
/// object (what development builds of this change pushed). Returns
/// (rows, was_legacy). Rows are de-duplicated by (id, played_at), first wins.
/// At most `MAX_CLOUD_ROWS` rows are read, plain head first. Takes the blob
/// by value: the plain rows are MOVED out of the IPC payload, never copied.
pub(crate) fn cloud_decode(data: Value) -> Result<(Vec<Value>, bool), String> {
    let (mut rows, legacy) = match data {
        Value::Array(mut arr) => {
            let env = match arr.last().and_then(as_envelope) {
                Some(_) => match arr.pop() {
                    Some(Value::Object(env)) => Some(env),
                    _ => unreachable!("as_envelope matched an object"),
                },
                None => None,
            };
            // Size- and depth-checked as they are taken, like the envelope's
            // rows, so an unkeepable plain row is never merged or pushed on.
            let mut rows: Vec<Value> =
                arr.into_iter().filter(is_keepable_row).take(MAX_CLOUD_ROWS).collect();
            match env {
                Some(env) => {
                    let room = MAX_CLOUD_ROWS - rows.len();
                    rows.extend(decode_envelope(&env, room)?);
                    (rows, false)
                }
                None => (rows, true),
            }
        }
        Value::Object(obj) => (decode_envelope(&obj, MAX_CLOUD_ROWS)?, false),
        _ => return Err("cloud history: not an array or object".into()),
    };
    // First wins. The set BORROWS its keys from the rows (a keep mask, then
    // the retain), so it never holds a second copy of what the rows carry.
    let keep: Vec<bool> = {
        let mut seen: HashSet<(&str, &str)> = HashSet::with_capacity(rows.len());
        rows.iter().map(|r| key_of(r).is_some_and(|k| seen.insert(k))).collect()
    };
    let mut keep = keep.into_iter();
    // `retain` visits every element once, in order.
    rows.retain(|_| keep.next().unwrap_or(false));
    Ok((rows, legacy))
}

// ---------------------------------------------------------------------------
// Disk
// ---------------------------------------------------------------------------

/// Load a scope's rows from disk. Err means the file EXISTS but could not be
/// used, and the caller must not treat the scope as empty (see "A FILE THAT
/// EXISTS" above). A file that reads but fails to decode is SET ASIDE (one
/// `.bad` per scope, replacing an older one) so a decoder bug or a torn disk
/// never silently becomes an empty history; only once that rename succeeded
/// does the scope start empty, with `recovered` set so the cloud copy is
/// pulled in full before anything is pushed over it. A rename that fails
/// would leave the original under its own name for the next write to
/// replace, so that is an Err as well. `recovered` holds across restarts while
/// the marker exists, whether or not a play has written a new file since. Its
/// write comes first, so no set-aside file ever lacks one (a guest has none:
/// no cloud pull would ever clear it).
fn read_scope(dir: &Path, scope: &str) -> Result<Loaded, String> {
    let path = file_for(dir, scope);
    let recovering = recovering_path(dir, scope);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Loaded { rows: Vec::new(), existed: false, recovered: recovering.exists() });
        }
        Err(e) => {
            crate::devlog!(error, "history", "could not read {scope}: {e} (kept as is; retried on the next call)");
            return Err(format!("the history file for {scope} could not be read: {e}"));
        }
    };
    match decode_file(&bytes) {
        Ok(rows) => Ok(Loaded { rows: sanitize_rows(rows), existed: true, recovered: recovering.exists() }),
        Err(e) => {
            if scope != GUEST_SCOPE {
                if let Err(me) = std::fs::write(&recovering, b"") {
                    crate::devlog!(
                        error, "history",
                        "history file for {scope} is unreadable ({e}) and its recovery marker could not be written ({me}); left in place",
                    );
                    return Err(format!("the history file for {scope} is unreadable and could not be set aside: {me}"));
                }
            }
            let bad = path.with_extension("gz.bad");
            let _ = std::fs::remove_file(&bad);
            if let Err(re) = std::fs::rename(&path, &bad) {
                crate::devlog!(
                    error, "history",
                    "history file for {scope} is unreadable ({e}) and could not be set aside ({re}); left in place, nothing will be written over it",
                );
                return Err(format!("the history file for {scope} is unreadable and could not be set aside: {re}"));
            }
            crate::devlog!(error, "history", "history file for {scope} is unreadable ({e}); set aside as .bad");
            record_set_aside(dir, scope);
            Ok(Loaded { rows: Vec::new(), existed: false, recovered: true })
        }
    }
}

/// Rename attempts before a write gives up (the delays are `RENAME_RETRY_MS`).
const RENAME_ATTEMPTS: usize = 5;
const RENAME_RETRY_MS: [u64; RENAME_ATTEMPTS - 1] = [50, 100, 150, 200];

/// A rename failure that a moment's wait usually cures. On Windows, replacing
/// a file another process holds open without FILE_SHARE_DELETE (an antivirus
/// scan of the freshly closed tmp, the indexer, a backup client) fails with
/// ERROR_ACCESS_DENIED (5) or a sharing / lock violation (32 / 33) until that
/// handle closes; measured here with std::fs::rename, Ok right after it did.
/// cargo and npm retry MoveFileEx the same way.
fn rename_is_transient(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || matches!(e.raw_os_error(), Some(5 | 32 | 33))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("gz.tmp");
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    rename_retrying(&tmp, path)
}

/// Rename `tmp` over `path`, waiting out a transient hold (it sleeps, so never
/// on an async worker). `tmp` is removed when the rename fails for good.
pub(crate) fn rename_retrying(tmp: &Path, path: &Path) -> Result<(), String> {
    let mut attempt = 0;
    loop {
        match std::fs::rename(tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < RENAME_RETRY_MS.len() && rename_is_transient(&e) => {
                std::thread::sleep(Duration::from_millis(RENAME_RETRY_MS[attempt]));
                attempt += 1;
            }
            Err(e) => {
                let _ = std::fs::remove_file(tmp);
                return Err(e.to_string());
            }
        }
    }
}

struct Snapshot {
    scope: String,
    gen: u64,
    compact: Vec<u8>,
    /// These rows include the sidecar's: remove it once they have landed.
    clear_pending: bool,
}

/// Encode the resident rows for a write (call under STATE). The compact JSON
/// is fast; the gzip and the disk write run after STATE is released, or
/// under WRITES on the durable paths.
fn snapshot_of(r: &Resident) -> Result<Snapshot, String> {
    let compact = serde_json::to_vec(&encode_compact(r.rows.iter()))
        .map_err(|e| format!("encode failed for {}: {e}", r.scope))?;
    Ok(Snapshot { scope: r.scope.clone(), gen: r.gen, compact, clear_pending: r.pending_merged })
}

/// The background writer's snapshot: only when dirty, and never for an
/// unreadable scope. `saved_gen` set here means "a writer has it", which is
/// what coalesces a burst into one write; it is NOT "on disk" (see "DURABLE
/// MEANS LANDED").
fn take_snapshot(r: &mut Resident) -> Option<Snapshot> {
    if r.unreadable || r.gen == r.saved_gen {
        return None;
    }
    match snapshot_of(r) {
        Ok(s) => {
            r.saved_gen = r.gen;
            Some(s)
        }
        Err(e) => {
            crate::devlog!(error, "history", "{e}");
            None
        }
    }
}

/// Write a snapshot with WRITES already held. `map` records, per scope, the
/// generation of the newest snapshot that reached disk this session.
fn write_locked(map: &mut HashMap<String, u64>, dir: &Path, snap: Snapshot) -> Result<(), String> {
    if map.get(&snap.scope).is_some_and(|&g| g >= snap.gen) {
        return Ok(()); // a newer snapshot of this scope already landed
    }
    let started = Instant::now();
    let gz = gzip(&snap.compact)?;
    write_atomic(&file_for(dir, &snap.scope), &gz)?;
    map.insert(snap.scope.clone(), snap.gen);
    if snap.clear_pending {
        drop_pending(dir, &snap.scope);
    }
    crate::devlog!(
        debug, "history",
        "wrote {} ({} bytes, {} ms)", snap.scope, gz.len(), started.elapsed().as_millis(),
    );
    Ok(())
}

fn write_snapshot(dir: &Path, snap: Snapshot) -> Result<(), String> {
    let mut writes = lock_writes();
    write_locked(writes.get_or_insert_with(HashMap::new), dir, snap)
}

/// Make the resident's CURRENT state the file's, synchronously (call under
/// STATE, with WRITES held, which has already waited out a background write
/// in flight). A no-op when that generation already landed. A failure leaves
/// the resident dirty for the next flush.
fn make_durable(map: &mut HashMap<String, u64>, dir: &Path, r: &mut Resident) -> Result<(), String> {
    if r.unreadable {
        return Err(format!("the history file for {} could not be read, so nothing was written", r.scope));
    }
    if r.gen <= map.get(&r.scope).copied().unwrap_or(0) {
        return Ok(());
    }
    let snap = snapshot_of(r)?;
    r.saved_gen = r.gen;
    write_locked(map, dir, snap).map_err(|e| {
        r.saved_gen = 0;
        e
    })
}

/// The sidecar's rows, newest first. Err means it exists but could not be used
/// and must not be overwritten. One that does not decode is set aside like the
/// main file, so it cannot block the scope for good.
fn read_pending(dir: &Path, scope: &str) -> Result<Vec<Value>, String> {
    let path = pending_path(dir, scope);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("the held plays of {scope} could not be read: {e}")),
    };
    match decode_file(&bytes) {
        Ok(rows) => Ok(sanitize_rows(rows)),
        Err(e) => {
            crate::devlog!(error, "history", "the held plays of {scope} do not decode ({e}); set aside as .bad");
            let bad = path.with_extension("gz.bad");
            let _ = std::fs::remove_file(&bad);
            std::fs::rename(&path, &bad).map_err(|re| format!("the held plays of {scope} could not be set aside: {re}"))?;
            Ok(Vec::new())
        }
    }
}

/// Union `rows` (newest first) into the sidecar, atomically.
fn write_pending(dir: &Path, scope: &str, rows: &[Value]) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut all = read_pending(dir, scope)?;
    // apply_append puts the LAST row of a batch first.
    apply_append(&mut all, rows.iter().rev().cloned().collect());
    write_atomic(&pending_path(dir, scope), &encode_file(&all)?)
}

/// Put an unreadable scope's rows in the sidecar. A failure leaves them in
/// memory only, which is what the error says.
fn hold_unreadable_rows(dir: &Path, r: &Resident) -> Result<(), String> {
    write_pending(dir, &r.scope, &r.rows).map_err(|e| {
        crate::devlog!(
            error, "history",
            "history file for {} is unreadable and {} play(s) could not be held beside it: {e}",
            r.scope, r.rows.len(),
        );
        e
    })
}

fn drop_pending(dir: &Path, scope: &str) {
    if let Err(e) = std::fs::remove_file(pending_path(dir, scope)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::devlog!(warn, "history", "could not remove the held plays of {scope}: {e}");
        }
    }
}

/// Bring the sidecar's rows into the resident. Idempotent, so a crash before
/// the write that removes the sidecar just repeats it. `existed` stays as the
/// disk said, as in `apply_parked`; both callers have already run the no-file
/// latch, so a file these rows create cannot lack it.
fn merge_pending(dir: &Path, r: &mut Resident) {
    let rows = match read_pending(dir, &r.scope) {
        Ok(rows) => rows,
        Err(e) => {
            r.pending_merged = false;
            crate::devlog!(error, "history", "{e}");
            return;
        }
    };
    r.pending_merged = !rows.is_empty();
    if rows.is_empty() {
        return;
    }
    let n = apply_append(&mut r.rows, rows.into_iter().rev().collect());
    if !r.unreadable {
        let existed = r.existed;
        touch(r);
        r.existed = existed;
    }
    crate::devlog!(info, "history", "{n} play(s) held for an unreadable file brought into {}", r.scope);
}

/// Hold plays for `scope` while the swap to it is refused: the rows never
/// reached a resident, and the frontend's next load replaces its list with
/// Rust's. Same filter as `apply_append`.
fn park_appends(scope: &str, entries: Vec<Value>) -> usize {
    let mut parked = PARKED.lock().unwrap_or_else(|p| p.into_inner());
    for e in entries {
        if matches!(key_of(&e), Some((id, at)) if !id.is_empty() && !at.is_empty()) && is_keepable_row(&e) {
            parked.push((scope.to_string(), e));
        }
    }
    if parked.len() > MAX_PARKED {
        let over = parked.len() - MAX_PARKED;
        crate::devlog!(error, "history", "{over} play(s) waiting for a scope swap were dropped (over the cap)");
        parked.drain(..over);
    }
    parked.iter().filter(|(s, _)| s == scope).count()
}

fn take_parked(scope: &str) -> Vec<Value> {
    let mut parked = PARKED.lock().unwrap_or_else(|p| p.into_inner());
    let (mine, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut *parked).into_iter().partition(|(s, _)| s == scope);
    *parked = rest;
    mine.into_iter().map(|(_, row)| row).collect()
}

/// `scope` just became resident: apply what was parked for it, in arrival order
/// (which is the order the appends would have run in). `existed` stays as the
/// disk said: these rows are not a history of its own for the carry-over in
/// `load`, which may run later or not at all. The caller has already run the
/// no-file latch.
fn apply_parked(dir: &Path, r: &mut Resident) {
    let rows = take_parked(&r.scope);
    if rows.is_empty() {
        return;
    }
    let n = apply_append(&mut r.rows, rows);
    if r.unreadable {
        let _ = hold_unreadable_rows(dir, r);
    } else {
        let existed = r.existed;
        touch(r);
        r.existed = existed;
    }
    crate::devlog!(info, "history", "{n} play(s) held during a refused scope swap applied to {}", r.scope);
}

/// One scope's parked rows onto its file, for the exit path (WRITES held). A
/// file this creates holds only these rows and its `load` never ran, so it sets
/// the same marker `latch_missing_file` would have (see "NO FILE IS THE SAME
/// LATCH"), before the write, so the file never exists without it. A file that
/// cannot be read gets nothing written over it: the rows go to the sidecar.
fn write_parked_rows(map: &mut HashMap<String, u64>, dir: &Path, scope: &str, parked: Vec<Value>) -> Result<(), String> {
    let loaded = match read_scope(dir, scope) {
        Ok(l) => l,
        Err(_) => {
            let newest_first: Vec<Value> = parked.into_iter().rev().collect();
            return write_pending(dir, scope, &newest_first);
        }
    };
    if !loaded.existed && !loaded.recovered && scope != GUEST_SCOPE {
        if let Err(e) = std::fs::write(recovering_path(dir, scope), b"") {
            crate::devlog!(error, "history", "could not write the recovery marker for {scope}: {e}");
        }
    }
    let mut rows = loaded.rows;
    apply_append(&mut rows, parked);
    let compact = serde_json::to_vec(&encode_compact(rows.iter()))
        .map_err(|e| format!("encode failed for {scope}: {e}"))?;
    write_locked(map, dir, Snapshot { scope: scope.to_string(), gen: next_gen(), compact, clear_pending: false })
}

/// Exit: no later swap will place what is still parked.
fn write_all_parked() {
    let Ok(dir) = dir() else { return };
    let parked = std::mem::take(&mut *PARKED.lock().unwrap_or_else(|p| p.into_inner()));
    if parked.is_empty() {
        return;
    }
    let _st = lock_state();
    let mut writes = lock_writes();
    let map = writes.get_or_insert_with(HashMap::new);
    let mut by_scope: HashMap<String, Vec<Value>> = HashMap::new();
    for (scope, row) in parked {
        by_scope.entry(scope).or_default().push(row);
    }
    for (scope, rows) in by_scope {
        let n = rows.len();
        if let Err(e) = write_parked_rows(map, dir, &scope, rows) {
            crate::devlog!(error, "history", "{n} play(s) for {scope} could not be saved at exit: {e}");
        }
    }
}

/// A signed-in scope with no file: its rows are not known to match the cloud
/// copy, whatever etag survives in localStorage (see "NO FILE IS THE SAME LATCH").
/// Cleared by the same paths as a set-aside file. The marker is what holds across
/// a restart: a play made offline creates the file, and the next load reads
/// `existed`.
fn latch_missing_file(dir: &Path, r: &mut Resident, existed: bool) {
    if existed || r.recovered || r.scope == GUEST_SCOPE {
        return;
    }
    if let Err(e) = std::fs::write(recovering_path(dir, &r.scope), b"") {
        crate::devlog!(error, "history", "could not write the recovery marker for {}: {e}", r.scope);
    }
    r.recovered = true;
}

/// A set-aside scope's cloud merge has landed: pushes may resume. The marker
/// goes only once the merged rows are on disk, since a crash before that would
/// otherwise start the next launch on a near-empty history with no latch.
fn finish_recovery(dir: &Path, r: &mut Resident) {
    if !r.recovered {
        return;
    }
    r.recovered = false;
    let landed = {
        let mut writes = lock_writes();
        make_durable(writes.get_or_insert_with(HashMap::new), dir, r)
    };
    match landed {
        Ok(()) => clear_recovering(dir, &r.scope),
        Err(e) => crate::devlog!(error, "history", "recovery write failed for {}: {e}; the next launch pulls again", r.scope),
    }
}

/// A failed background write leaves the resident dirty again, and
/// `schedule_flush_after` re-arms a retry with backoff, so the rows reach the
/// file without waiting for the next play (which can be hours away, and a
/// crash before it would lose them from the file).
fn mark_unsaved(scope: &str, gen: u64) {
    let mut st = lock_state();
    if let Some(r) = st.as_mut() {
        if r.scope == scope && r.saved_gen == gen {
            r.saved_gen = 0;
        }
    }
}

/// The background writer (and nothing else: the paths that must know the
/// disk use `flush_durable`).
fn flush_now() -> Result<(), String> {
    let dir = dir()?;
    let snap = {
        let mut st = lock_state();
        st.as_mut().and_then(take_snapshot)
    };
    if let Some(s) = snap {
        let (scope, gen) = (s.scope.clone(), s.gen);
        if let Err(e) = write_snapshot(dir, s) {
            crate::devlog!(error, "history", "write failed for {scope}: {e}");
            mark_unsaved(&scope, gen);
            return Err(e);
        }
    }
    Ok(())
}

/// Background-write retries after a failure before the scope waits for the
/// next mutation, scope switch or exit flush (each of which also writes): a
/// disk that stays broken should not log an error every minute all session.
const FLUSH_MAX_RETRIES: u32 = 10;

/// Delay before retry `n` (1-based) of a failed background write: doubling
/// from `FLUSH_DELAY`, capped at a minute.
fn retry_delay(n: u32) -> Duration {
    let ms = (FLUSH_DELAY.as_millis() as u64).saturating_mul(1u64 << n.saturating_sub(1).min(16));
    Duration::from_millis(ms.min(60_000))
}

fn schedule_flush() {
    // A new change earns the retry budget back: the cap is for one stuck
    // write, not for every later play.
    FLUSH_FAILURES.store(0, Ordering::Release);
    schedule_flush_after(FLUSH_DELAY);
}

fn schedule_flush_after(delay: Duration) {
    if FLUSH_PENDING.swap(true, Ordering::AcqRel) {
        // A flush is already armed and will write the current state.
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        FLUSH_PENDING.store(false, Ordering::Release);
        match flush_now() {
            Ok(()) => FLUSH_FAILURES.store(0, Ordering::Release),
            Err(_) => {
                let n = FLUSH_FAILURES.fetch_add(1, Ordering::AcqRel) + 1;
                if n <= FLUSH_MAX_RETRIES {
                    schedule_flush_after(retry_delay(n));
                } else {
                    crate::devlog!(
                        error, "history",
                        "background write failed {n} times in a row; waiting for the next change or the exit flush",
                    );
                }
            }
        }
    });
}

/// Put the resident scope on disk NOW and wait for it, including a
/// background write already in flight. With `verify_scope`, also report
/// whether that scope is the resident one and its file reads back exactly as
/// the rows held (the frontend's late removal of a migrated localStorage
/// copy asks this); without, the result is always true on success.
fn flush_durable(verify_scope: Option<&str>) -> Result<bool, String> {
    let dir = dir()?;
    let mut st = lock_state();
    let Some(r) = st.as_mut() else { return Ok(verify_scope.is_none()) };
    if r.unreadable {
        let _ = try_resolve(dir, r);
    }
    if r.unreadable {
        // make_durable refuses below; this retries a sidecar write that failed.
        let _ = hold_unreadable_rows(dir, r);
    }
    {
        let mut writes = lock_writes();
        make_durable(writes.get_or_insert_with(HashMap::new), dir, r)?;
    }
    Ok(match verify_scope {
        Some(s) => r.scope == sanitize_scope(s) && verify_on_disk(dir, r),
        None => true,
    })
}

/// Synchronous flush for the exit path (window_logic.rs CloseRequested):
/// waits out a background write in progress, then writes what is not on
/// disk yet, and from here on every call writes before it returns (an append
/// already on its way when the window closed would otherwise only arm a
/// delayed flush the exiting process never runs).
pub fn flush_blocking() {
    SHUTTING_DOWN.store(true, Ordering::Release);
    if DIR.get().is_some() {
        if let Err(e) = flush_durable(None) {
            crate::devlog!(error, "history", "exit flush failed: {e}");
        }
        write_all_parked();
    }
}

/// Retry the read of an UNREADABLE resident. On success the plays appended
/// meanwhile go on top of what the file held (newest first, as they were
/// made) and the scope is dirty, so they reach disk.
fn try_resolve(dir: &Path, r: &mut Resident) -> Result<(), String> {
    if !r.unreadable {
        return Ok(());
    }
    let l = read_scope(dir, &r.scope)?;
    let pending = std::mem::replace(&mut r.rows, l.rows);
    r.unreadable = false;
    r.existed = l.existed;
    r.recovered = l.recovered;
    // Here, before anything below can create the file, whichever call got to
    // this read first (see "NO FILE IS THE SAME LATCH").
    latch_missing_file(dir, r, l.existed);
    merge_pending(dir, r);
    let n = pending.len();
    if n > 0 {
        // apply_append puts the LAST row of a batch first, so feed the
        // newest-first pending list oldest first.
        apply_append(&mut r.rows, pending.into_iter().rev().collect());
        // `existed` stays as the disk said, as in `apply_parked`.
        let existed = r.existed;
        touch(r);
        r.existed = existed;
    }
    crate::devlog!(info, "history", "history file for {} is readable again ({n} play(s) recorded meanwhile kept)", r.scope);
    Ok(())
}

/// Make `scope` the resident one. Only one scope's rows are ever held in
/// memory, so the previous scope is made DURABLE first (one retry), and the
/// swap is refused when it cannot be: a failing disk then keeps those rows
/// in memory (and the call for the other scope fails) rather than dropping
/// plays that never reached the file. WRITES is held across the swap, so the
/// new scope's file is never read while a write of it is mid-replace (an
/// A -> B -> A switch inside a write's window used to read the older file).
/// For the resident scope, an unreadable file's read is retried; the caller
/// checks `unreadable`.
fn ensure_resident<'a>(st: &'a mut Option<Resident>, dir: &Path, scope: &str) -> Result<&'a mut Resident, String> {
    let switch = st.as_ref().map(|r| r.scope != scope).unwrap_or(true);
    if !switch {
        let r = st.as_mut().unwrap();
        if r.unreadable {
            let _ = try_resolve(dir, r);
        }
        return Ok(r);
    }
    let mut writes = lock_writes();
    let map = writes.get_or_insert_with(HashMap::new);
    if let Some(old) = st.as_mut() {
        if old.unreadable {
            let _ = try_resolve(dir, old);
        }
        if old.unreadable {
            // Nothing can be written over a file that cannot be read, and the
            // scope is leaving memory: the rows live on in the sidecar, or the
            // swap is refused like any other write that failed.
            if let Err(e) = hold_unreadable_rows(dir, old) {
                return Err(format!("could not save the {} history before switching: {e}", old.scope));
            }
        } else {
            let mut res = make_durable(map, dir, old);
            if let Err(e) = &res {
                crate::devlog!(error, "history", "write failed for {} on scope switch (retrying): {e}", old.scope);
                res = make_durable(map, dir, old);
            }
            if let Err(e) = res {
                crate::devlog!(error, "history", "write failed for {} on scope switch; staying on it: {e}", old.scope);
                return Err(format!("could not save the {} history before switching: {e}", old.scope));
            }
        }
    }
    let resident = match read_scope(dir, scope) {
        Ok(l) => Resident {
            scope: scope.to_string(),
            rows: l.rows,
            gen: 0,
            saved_gen: 0,
            existed: l.existed,
            unreadable: false,
            recovered: l.recovered,
            pending_merged: false,
        },
        Err(_) => Resident {
            scope: scope.to_string(),
            rows: Vec::new(),
            gen: 0,
            saved_gen: 0,
            existed: true,
            unreadable: true,
            recovered: false,
            pending_merged: false,
        },
    };
    *st = Some(resident);
    drop(writes);
    let r = st.as_mut().unwrap();
    // Here, not in `load`: any op can be the one that finds no file (an append
    // whose `load` failed on a refused swap), and its touch sets `existed`. An
    // unreadable scope says `existed`, so it does not latch.
    let existed = r.existed;
    latch_missing_file(dir, r, existed);
    merge_pending(dir, r);
    apply_parked(dir, r);
    Ok(r)
}

/// The ops that need the file's rows refuse an unreadable scope. Only `append`
/// is accepted, and its rows wait in the sidecar until the file can be read.
fn require_readable(r: &Resident) -> Result<(), String> {
    if r.unreadable {
        Err(format!("the history file for {} could not be read; try again shortly", r.scope))
    } else {
        Ok(())
    }
}

/// A mutation: dirty, and the scope now has a history of its own (so a page
/// reload's `load` does not carry the legacy copy over rows removed since).
fn touch(r: &mut Resident) {
    r.gen = next_gen();
    r.existed = true;
    schedule_flush();
}

/// Make the resident durable now (the migration paths, which read it back).
/// touch() has armed the background flush too, which retries a failure.
fn write_now(dir: &Path, r: &mut Resident, what: &str) {
    let mut writes = lock_writes();
    if let Err(e) = make_durable(writes.get_or_insert_with(HashMap::new), dir, r) {
        crate::devlog!(error, "history", "{what} write failed for {}: {e}", r.scope);
    }
}

/// Read the file back and check it holds exactly the resident rows. Used by
/// the migration before the frontend may delete the localStorage copy.
fn verify_on_disk(dir: &Path, r: &Resident) -> bool {
    let Ok(bytes) = std::fs::read(file_for(dir, &r.scope)) else { return false };
    match decode_file(&bytes) {
        Ok(rows) => rows.len() == r.rows.len() && rows == r.rows,
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Public helpers for other modules
// ---------------------------------------------------------------------------

/// What Settings > Storage shows for watch history.
pub struct HistoryUsage {
    pub dir: String,
    /// Bytes on disk across EVERY scope's file (the real footprint).
    pub total_bytes: u64,
    /// The part of `total_bytes` that is NOT the resident (in use) scope's
    /// file: other accounts on this device, or the guest history while signed
    /// in. Storage's Clear goes through the frontend store, which empties only
    /// the scope in use, so this part can never be cleared from that row.
    pub other_bytes: u64,
    /// Whether the scope in use holds any rows, i.e. whether Clear would do
    /// anything. None when no scope is resident yet or its file cannot be
    /// read (the caller then falls back to the file size).
    pub active_has_rows: Option<bool>,
}

/// Watch history's disk usage (Settings > Storage).
pub fn storage_usage<R: Runtime>(app: &AppHandle<R>) -> HistoryUsage {
    let _ = init(app);
    let Ok(d) = dir() else {
        return HistoryUsage { dir: String::new(), total_bytes: 0, other_bytes: 0, active_has_rows: None };
    };
    // The resident scope is the one the frontend has loaded, i.e. the one its
    // Clear empties. Read under STATE briefly; no file I/O while holding it.
    let (active_scope, active_has_rows) = {
        let st = lock_state();
        match st.as_ref() {
            Some(r) => (Some(r.scope.clone()), (!r.unreadable).then_some(!r.rows.is_empty())),
            None => (None, None),
        }
    };
    let (total, active_bytes) = bytes_on_disk(d, active_scope.as_deref());
    let other_bytes = if active_scope.is_some() { total - active_bytes } else { 0 };
    HistoryUsage { dir: d.to_string_lossy().into_owned(), total_bytes: total, other_bytes, active_has_rows }
}

/// (every scope's bytes, `active`'s part of them). A scope's sidecar counts with
/// its file: it is history on this disk, and its Clear removes both.
fn bytes_on_disk(dir: &Path, active: Option<&str>) -> (u64, u64) {
    let mut total = 0;
    let mut active_bytes = 0;
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let Some(stem) = name.strip_suffix(FILE_SUFFIX).or_else(|| name.strip_suffix(PENDING_SUFFIX)) else {
                continue;
            };
            let len = e.metadata().map(|m| m.len()).unwrap_or(0);
            total += len;
            if active == Some(stem) {
                active_bytes += len;
            }
        }
    }
    (total, active_bytes)
}

/// When this scope's history file was set aside as undecodable (unix ms, oldest
/// first), for backup.rs's pruning. Empty when it never was, or the user has
/// since cleared or restored the history.
pub fn set_aside_times<R: Runtime>(app: &AppHandle<R>, scope: &str) -> Vec<u64> {
    if init(app).is_err() {
        return Vec::new();
    }
    dir().map(|d| read_set_aside(d, &sanitize_scope(scope))).unwrap_or_default()
}

/// A marker that cannot be read, or a line that does not parse, reads as no time.
fn read_set_aside(dir: &Path, scope: &str) -> Vec<u64> {
    let Ok(text) = std::fs::read_to_string(set_aside_path(dir, scope)) else { return Vec::new() };
    text.lines().filter_map(|l| l.trim().parse().ok()).take(MAX_SET_ASIDE_TIMES).collect()
}

/// Add this set-aside's time. Over the cap the second-oldest goes: the oldest pin
/// holds the history from before any of the damage, the newest the latest state.
fn record_set_aside(dir: &Path, scope: &str) {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut times = read_set_aside(dir, scope);
    times.push(now_ms);
    if times.len() > MAX_SET_ASIDE_TIMES {
        times.remove(1);
    }
    let text = times.iter().map(u64::to_string).collect::<Vec<_>>().join("\n");
    if let Err(e) = std::fs::write(set_aside_path(dir, scope), text) {
        crate::devlog!(warn, "history", "could not record the set-aside time of {scope}: {e}");
    }
}

fn clear_set_aside(dir: &Path, scope: &str) {
    if let Err(e) = std::fs::remove_file(set_aside_path(dir, scope)) {
        if e.kind() != std::io::ErrorKind::NotFound {
            crate::devlog!(warn, "history", "could not remove the set-aside time of {scope}: {e}");
        }
    }
}

/// A scope's rows as the JSON array string backups have always carried under
/// `values.history`, so a new snapshot reads in every Aura that reads one.
/// Built here so a large history never crosses IPC for an auto-snapshot.
/// Fails for an unreadable file: a snapshot holding only the plays made
/// since would roll the good snapshots out of the auto bucket. A set-aside
/// file's near-empty scope does not fail (that would stop snapshots of the
/// other stores for as long as it stays so); `set_aside_times` pins the good
/// snapshots instead.
pub fn backup_json<R: Runtime>(app: &AppHandle<R>, scope: &str) -> Result<String, String> {
    init(app)?;
    let dir = dir()?;
    let scope = sanitize_scope(scope);
    let mut st = lock_state();
    let r = ensure_resident(&mut st, dir, &scope)?;
    require_readable(r)?;
    serde_json::to_string(&r.rows).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct RemoveKey {
    id: String,
    played_at: String,
}

/// One command, tagged by `op` (each command costs three registration sites).
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HistoryAction {
    /// Hydrate. `local` is the scope's localStorage copy when one still
    /// exists (the migration); `legacy_scope` names the pre-user_id scope
    /// whose FILE is carried over when this scope has none.
    Load {
        scope: String,
        #[serde(default)]
        local: Option<Vec<Value>>,
        #[serde(default)]
        legacy_scope: Option<String>,
    },
    /// Carry the legacy scope's localStorage rows in (second migration step).
    Migrate { scope: String, entries: Vec<Value> },
    Append { scope: String, entries: Vec<Value> },
    Remove { scope: String, keys: Vec<RemoveKey> },
    Replace { scope: String, entries: Vec<Value> },
    Clear { scope: String },
    MergeCloud { scope: String, data: Value },
    /// The pull found no cloud copy, so a set-aside scope has nothing to wait for.
    CloudAbsent { scope: String },
    CloudEncode { scope: String },
    /// Write now and wait for it (before an updater relaunch, which skips the
    /// exit path). With `scope`, the answer's `verified` says that scope's
    /// file reads back exactly as held: the frontend's retry of a migration
    /// whose first write failed removes the localStorage copy only on it.
    Flush {
        #[serde(default)]
        scope: Option<String>,
    },
}

/// A command's answer: a `Value` for the small ones, and ready JSON text for
/// the ones carrying rows (load, carry-over, cloud merge), which would otherwise
/// be copied into a `Value` and then serialized into a second copy (see
/// `merge_cloud`). Untagged, so both reach the frontend as the same plain JSON.
#[derive(serde::Serialize)]
#[serde(untagged)]
pub enum Answer {
    Value(Value),
    Raw(Box<serde_json::value::RawValue>),
}

/// `load`'s answer, serialized straight from the resident rows.
#[derive(serde::Serialize)]
struct LoadAnswer<'a> {
    entries: &'a [Value],
    existed: bool,
    verified: bool,
    want_legacy_local: bool,
    recovered: bool,
}

/// The carry-over's answer, likewise.
#[derive(serde::Serialize)]
struct MigrateAnswer<'a> {
    entries: &'a [Value],
    verified: bool,
}

fn raw_answer(text: String) -> Result<Answer, String> {
    serde_json::value::RawValue::from_string(text).map(Answer::Raw).map_err(|e| e.to_string())
}

fn run(action: HistoryAction) -> Result<Answer, String> {
    let out = run_action(action);
    if SHUTTING_DOWN.load(Ordering::Acquire) {
        // The window is closing (flush_blocking ran): the delayed flush this
        // call may have armed would never run, so write before returning.
        if let Err(e) = flush_durable(None) {
            crate::devlog!(error, "history", "flush during exit failed: {e}");
        }
        write_all_parked();
    }
    out
}

fn run_action(action: HistoryAction) -> Result<Answer, String> {
    let dir = dir()?.clone();
    match action {
        HistoryAction::Flush { scope } => {
            let verified = flush_durable(scope.as_deref())?;
            Ok(Answer::Value(json!({ "verified": verified })))
        }
        HistoryAction::Load { scope, local, legacy_scope } => {
            let scope = sanitize_scope(&scope);
            let mut st = lock_state();
            let r = ensure_resident(&mut st, &dir, &scope)?;
            // Fail the load rather than answer an empty list for a file that
            // exists: the frontend retries, and nothing it does can then be
            // written over the real history.
            require_readable(r)?;
            let existed = r.existed;
            latch_missing_file(&dir, r, existed);
            let mut migrated = 0usize;
            let had_local = local.is_some();
            if let Some(rows) = local {
                migrated += apply_union_keep_existing(&mut r.rows, sanitize_rows(rows));
            }
            // The carry-over rule, unchanged in spirit: only for a scope with
            // NO history of its own (no file, no localStorage copy, and no
            // mutation this session, which `touch` records in `existed`).
            let mut want_legacy_local = false;
            if !existed && !had_local {
                if let Some(legacy) = legacy_scope.as_deref().map(sanitize_scope).filter(|l| *l != scope) {
                    match read_scope(&dir, &legacy) {
                        Ok(l) if l.existed => migrated += apply_union_keep_existing(&mut r.rows, l.rows),
                        Ok(_) => want_legacy_local = true,
                        // Unreadable: carry nothing now. `existed` stays false,
                        // so the next load tries again.
                        Err(_) => {}
                    }
                }
            }
            let mut verified = true;
            if had_local || migrated > 0 {
                // Write NOW and read it back: the frontend deletes the
                // localStorage copy only on `verified` (or on a later
                // `flush` with this scope that verifies).
                touch(r);
                write_now(&dir, r, "migration");
                verified = verify_on_disk(&dir, r);
                crate::devlog!(
                    info, "history",
                    "migrated {migrated} row(s) into {scope} ({} total, verified={verified})", r.rows.len(),
                );
            }
            let text = serde_json::to_string(&LoadAnswer {
                entries: &r.rows,
                existed,
                verified,
                want_legacy_local,
                recovered: r.recovered,
            })
            .map_err(|e| e.to_string())?;
            drop(st);
            raw_answer(text)
        }
        HistoryAction::Migrate { scope, entries } => {
            let scope = sanitize_scope(&scope);
            let mut st = lock_state();
            let r = ensure_resident(&mut st, &dir, &scope)?;
            require_readable(r)?;
            let added = apply_union_keep_existing(&mut r.rows, sanitize_rows(entries));
            if added > 0 {
                touch(r);
                write_now(&dir, r, "carry-over");
            }
            let verified = added == 0 || verify_on_disk(&dir, r);
            crate::devlog!(info, "history", "carried {added} legacy row(s) into {scope} (verified={verified})");
            let text = serde_json::to_string(&MigrateAnswer { entries: &r.rows, verified })
                .map_err(|e| e.to_string())?;
            drop(st);
            raw_answer(text)
        }
        HistoryAction::Append { scope, entries } => {
            let scope = sanitize_scope(&scope);
            let mut st = lock_state();
            let r = match ensure_resident(&mut st, &dir, &scope) {
                Ok(r) => r,
                // The only Err is a refused swap: the play is safe, so no error.
                Err(e) => {
                    let n = park_appends(&scope, entries);
                    crate::devlog!(warn, "history", "{n} play(s) held for {scope}: {e}");
                    return Ok(Answer::Value(json!({ "count": n })));
                }
            };
            if r.unreadable {
                // Kept and merged in when the file reads again (try_resolve);
                // never written over the unread file. The sidecar is written now,
                // not at exit, because a crash or an updater relaunch has no exit.
                apply_append(&mut r.rows, entries);
                let _ = hold_unreadable_rows(&dir, r);
                return Ok(Answer::Value(json!({ "count": r.rows.len() })));
            }
            // Counted as a change even when every row replaced one in place:
            // a replacement can carry new fields.
            if entries.iter().any(|e| matches!(key_of(e), Some((a, b)) if !a.is_empty() && !b.is_empty())) {
                apply_append(&mut r.rows, entries);
                touch(r);
            }
            Ok(Answer::Value(json!({ "count": r.rows.len() })))
        }
        HistoryAction::Remove { scope, keys } => {
            let scope = sanitize_scope(&scope);
            let keys: Vec<(String, String)> = keys.into_iter().map(|k| (k.id, k.played_at)).collect();
            let mut st = lock_state();
            let r = ensure_resident(&mut st, &dir, &scope)?;
            require_readable(r)?;
            if apply_remove(&mut r.rows, &keys) > 0 {
                touch(r);
            }
            Ok(Answer::Value(json!({ "count": r.rows.len() })))
        }
        HistoryAction::Replace { scope, entries } => {
            let scope = sanitize_scope(&scope);
            let mut st = lock_state();
            let r = ensure_resident(&mut st, &dir, &scope)?;
            require_readable(r)?;
            r.rows = sanitize_rows(entries);
            touch(r);
            clear_set_aside(&dir, &scope);
            Ok(Answer::Value(json!({ "count": r.rows.len() })))
        }
        HistoryAction::Clear { scope } => {
            let scope = sanitize_scope(&scope);
            let mut st = lock_state();
            let r = ensure_resident(&mut st, &dir, &scope)?;
            require_readable(r)?;
            if !r.rows.is_empty() {
                r.rows.clear();
                touch(r);
            }
            // Not left to the next write: a sidecar this scope could not read
            // has rows `rows` never held, and they must not come back.
            drop_pending(&dir, &scope);
            clear_set_aside(&dir, &scope);
            Ok(Answer::Value(json!({ "count": 0 })))
        }
        HistoryAction::MergeCloud { scope, data } => {
            // Decode BEFORE taking the lock: inflating a 1 MiB blob is the
            // slow part and needs no state. The blob is consumed: its plain
            // rows move into the decode, and nothing of it outlives this.
            let (server, legacy) = cloud_decode(data)?;
            let scope = sanitize_scope(&scope);
            let mut st = lock_state();
            let r = ensure_resident(&mut st, &dir, &scope)?;
            require_readable(r)?;
            // The answer's `local_only` counts the rows this device holds that
            // the cloud copy lacks. After a LEGACY pull that means an older
            // Aura overwrote the blob with its own (smaller) array, and the
            // caller pushes promptly to restore it.
            let (answer, changed) = merge_cloud(&mut r.rows, server, legacy)?;
            if changed {
                touch(r);
                // The frontend persists this blob's etag next: never let it get
                // ahead of the rows it vouches for (a crash inside the flush
                // delay would leave an older file and a current etag).
                write_now(&dir, r, "cloud merge");
            }
            // A set-aside file's scope has now taken back what the cloud held.
            finish_recovery(&dir, r);
            Ok(Answer::Raw(answer))
        }
        HistoryAction::CloudAbsent { scope } => {
            let scope = sanitize_scope(&scope);
            let mut st = lock_state();
            if let Some(r) = st.as_mut().filter(|r| r.scope == scope) {
                r.recovered = false;
            }
            clear_recovering(&dir, &scope);
            Ok(Answer::Value(json!({})))
        }
        HistoryAction::CloudEncode { scope } => {
            let scope = sanitize_scope(&scope);
            let started = Instant::now();
            // Encoding (gzip, maybe several passes) runs on a CLONE so the
            // lock is not held through it. The clone is the price of letting
            // a play land while a 100k-row cloud trim is computed.
            let rows = {
                let mut st = lock_state();
                let r = ensure_resident(&mut st, &dir, &scope)?;
                require_readable(r)?;
                r.rows.clone()
            };
            let hint = LAST_FIT
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .as_ref()
                .filter(|(s, _)| *s == scope)
                .map(|&(_, n)| n);
            let (env, included, total, env_rows) = cloud_encode_rows_hinted(&rows, CLOUD_BUDGET_BYTES, hint)?;
            *LAST_CLOUD.lock().unwrap_or_else(|p| p.into_inner()) = Some((included, total));
            *LAST_FIT.lock().unwrap_or_else(|p| p.into_inner()) =
                (included < total).then(|| (scope.clone(), env_rows));
            if included < total {
                crate::devlog!(
                    info, "sync",
                    "history cloud copy holds the newest {included} of {total} entries (1 MiB blob limit; the local file keeps all of them) [{} ms]",
                    started.elapsed().as_millis(),
                );
            }
            Ok(Answer::Value(json!({ "payload": env, "included": included, "total": total })))
        }
    }
}

#[tauri::command]
pub async fn history_store<R: Runtime>(app: AppHandle<R>, action: HistoryAction) -> Result<Answer, String> {
    init(&app)?;
    tauri::async_runtime::spawn_blocking(move || run(action))
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// A row in the real corpus's shape, with deliberate oddities layered on.
    fn row(i: usize) -> Value {
        let show = i % 17;
        let mut v = json!({
            "id": format!("tt{:07}:1:{}", 1_000_000 + show, i),
            "parent_id": format!("tt{:07}", 1_000_000 + show),
            "name": format!("Show {show}"),
            "media_type": "series",
            "poster": format!("https://example.invalid/poster/{show}.jpg?w=342"),
            "background": if show % 5 == 0 { Value::Null } else { json!(format!("https://example.invalid/bg/{show}.jpg")) },
            "season": 1,
            "episode": i,
            "episode_title": format!("Episode {i}"),
            "played_at": format_iso_ms(1_793_000_000_000 - (i as i64) * 2_712_345).unwrap(),
            "duration": 1370.04 + i as f64 * 0.001,
            "watched_seconds": 1096.012,
            "anilist_id": 161645,
            "anilist_episode": i,
        });
        let o = v.as_object_mut().unwrap();
        match i % 9 {
            0 => { o.insert("skipped".into(), json!(true)); o.remove("watched_seconds"); o.remove("duration"); }
            1 => { o.insert("episode_released".into(), json!("2023-12-23T11:00:00.000Z")); }
            2 => { o.insert("anilist_id".into(), Value::Null); o.insert("anilist_episode".into(), Value::Null); }
            3 => { o.remove("background"); } // missing title field on one row
            4 => { o.insert("poster".into(), json!("https://example.invalid/other-cut.jpg")); } // per-row override
            5 => { o.insert("x_future".into(), json!({ "nested": [1, "two", null, 3.25] })); } // unknown field
            6 => { o.insert("played_at".into(), json!("2026-10-31T11:29:46Z")); } // no millis: not exact
            7 => { o.insert("played_at".into(), json!("2026-02-30T00:00:00.000Z")); } // invalid day
            _ => { o.insert("episode_title".into(), json!("$1 \"quoted\" \u{1F600} t")); }
        }
        v
    }

    fn corpus(n: usize) -> Vec<Value> {
        (0..n).map(row).collect()
    }

    /// `cloud_decode` of a blob the test keeps.
    fn cloud_decode_ref(v: &Value) -> Result<(Vec<Value>, bool), String> {
        cloud_decode(v.clone())
    }

    #[test]
    fn iso_round_trip_is_exact_or_refused() {
        for s in ["2026-10-31T11:29:46.668Z", "1970-01-01T00:00:00.000Z", "0000-03-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z", "1969-12-31T23:59:59.999Z"] {
            let ms = parse_iso_ms_exact(s).expect(s);
            assert_eq!(format_iso_ms(ms).as_deref(), Some(s));
        }
        for s in ["2026-10-31T11:29:46Z", "2026-02-30T00:00:00.000Z", "2026-10-31T11:29:46.668+00:00", "2026-1-31T11:29:46.668Z", "", "x"] {
            assert!(parse_iso_ms_exact(s).is_none(), "{s}");
        }
        // Spot check against a value JS produces: new Date(1793525457534).toISOString()
        assert_eq!(format_iso_ms(1_793_525_457_534).as_deref(), Some("2026-11-01T09:30:57.534Z"));
    }

    #[test]
    fn compact_round_trip_is_lossless() {
        let rows = corpus(500);
        let bytes = encode_file(&rows).unwrap();
        let back = decode_file(&bytes).unwrap();
        assert_eq!(back, rows);
        // Empty, and a single odd row.
        assert_eq!(decode_file(&encode_file(&[]).unwrap()).unwrap(), Vec::<Value>::new());
        let odd = vec![json!({ "id": "", "played_at": "", "n": 1e300, "neg": -0.5, "b": false, "a": [] })];
        assert_eq!(decode_file(&encode_file(&odd).unwrap()).unwrap(), odd);
    }

    #[test]
    fn cloud_blob_round_trips_and_reads_every_shape() {
        let rows = corpus(300);
        let (blob, inc, total) = cloud_encode_rows(&rows, CLOUD_BUDGET_BYTES).unwrap();
        assert_eq!((inc, total), (300, 300));
        let arr = blob.as_array().expect("the blob is a plain array");
        assert!(as_envelope(arr.last().unwrap()).is_some(), "it ends with the envelope");
        let (back, legacy) = cloud_decode_ref(&blob).unwrap();
        assert!(!legacy);
        let mut want = rows.clone();
        sort_newest_first(&mut want);
        assert_eq!(back, want);
        // A plain array with no envelope is what an older Aura pushes.
        let (back, legacy) = cloud_decode_ref(&Value::Array(rows.clone())).unwrap();
        assert!(legacy);
        assert_eq!(back, rows);
        // The bare envelope object development builds pushed still reads.
        let (env, _) = envelope_for(&rows.iter().collect::<Vec<_>>()).unwrap();
        let (back, legacy) = cloud_decode_ref(&env).unwrap();
        assert!(!legacy);
        assert_eq!(back, rows);
        // A version this build does not know is refused in both positions.
        let future = json!({ "v": 9, "enc": "zz", "data": "" });
        assert!(cloud_decode_ref(&future).is_err());
        assert!(cloud_decode_ref(&json!([rows[0].clone(), future])).is_err());
    }

    /// v2.2.4's `mergeHistory` keeps only elements with a string `id` and a
    /// string `played_at`. Through that filter the blob must yield the newest
    /// rows (so its push always carries the newest head) and nothing else.
    #[test]
    fn an_older_aura_reads_the_newest_head() {
        let rows = corpus(2000);
        let (blob, _, _) = cloud_encode_rows(&rows, CLOUD_BUDGET_BYTES).unwrap();
        let old_view: Vec<&Value> = blob
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e.get("id").is_some_and(Value::is_string) && e.get("played_at").is_some_and(Value::is_string))
            .collect();
        let head = blob.as_array().unwrap().len() - 1;
        assert!(head > 0 && head <= CLOUD_HEAD_ROWS);
        let mut want = rows.clone();
        sort_newest_first(&mut want);
        assert_eq!(old_view.into_iter().cloned().collect::<Vec<_>>(), want[..head].to_vec());
    }

    #[test]
    fn cloud_trim_keeps_the_newest_that_fit() {
        let rows = corpus(3000);
        let (_, full) = envelope_for(&rows.iter().collect::<Vec<_>>()).unwrap();
        let budget = full / 3;
        let (blob, inc, total) = cloud_encode_rows(&rows, budget).unwrap();
        assert_eq!(total, 3000);
        assert!(inc > 0 && inc < total);
        let size = serde_json::to_vec(&blob).unwrap().len();
        assert!(size <= budget, "{size} > {budget}");
        let (back, _) = cloud_decode_ref(&blob).unwrap();
        assert_eq!(back.len(), inc);
        let mut order: Vec<&Value> = rows.iter().collect();
        order.sort_by(|a, b| key_of(b).unwrap().1.cmp(key_of(a).unwrap().1));
        // What is there is the newest.
        let newest: Vec<Value> = order[..inc].iter().map(|v| (*v).clone()).collect();
        assert_eq!(back, newest);
        // And the search stopped within its tolerance of the largest prefix:
        // that many more envelope rows would not have fitted.
        let arr = blob.as_array().unwrap();
        let head = arr.len() - 1;
        let env_size = serde_json::to_vec(arr.last().unwrap()).unwrap().len();
        let head_bytes = size - env_size;
        let more = (inc + fit_tolerance(inc - head) + 2).min(total);
        assert!(envelope_for(&order[head..more]).unwrap().1 > budget - head_bytes);
    }

    /// A push of a history past the budget used to re-run the whole trim
    /// search (7-9 full encodes) every time; from the previous answer it is
    /// two, and the answer is as good.
    #[test]
    fn a_hinted_trim_settles_in_a_couple_of_encodes() {
        let rows = corpus(4000);
        let (_, full) = envelope_for(&rows.iter().collect::<Vec<_>>()).unwrap();
        let budget = full / 3;
        let (_, inc, total, env_rows) = cloud_encode_rows_hinted(&rows, budget, None).unwrap();
        assert!(inc < total);
        // One new play on top, as the next push sees it.
        let mut more = rows.clone();
        let mut fresh = row(0);
        fresh["played_at"] = json!("2030-01-01T00:00:00.000Z");
        fresh["id"] = json!("tt9999999:1:1");
        apply_append(&mut more, vec![fresh]);
        ENCODES.with(|c| c.set(0));
        let (blob, inc2, total2, _) = cloud_encode_rows_hinted(&more, budget, Some(env_rows)).unwrap();
        let encodes = ENCODES.with(|c| c.get());
        assert!(encodes <= 3, "{encodes} encodes");
        assert_eq!(total2, total + 1);
        assert!(serde_json::to_vec(&blob).unwrap().len() <= budget);
        // As good as a cold search of the same rows, to within the tolerance.
        let (_, cold, _, _) = cloud_encode_rows_hinted(&more, budget, None).unwrap();
        assert!(inc2.abs_diff(cold) <= fit_tolerance(cold) + 1, "{inc2} vs {cold}");
        // A hint that no longer applies (the history shrank under the budget)
        // still finds every row.
        let few = corpus(50);
        let (_, inc3, total3, _) = cloud_encode_rows_hinted(&few, budget, Some(env_rows)).unwrap();
        assert_eq!(inc3, total3);
    }

    /// One huge interned string referenced by many rows: tiny on the wire,
    /// enormous decoded. Must fail before it allocates, not abort the process.
    #[test]
    fn an_interning_bomb_is_refused() {
        let big = "x".repeat(1 << 20);
        let rows: Vec<Value> = (0..600).map(|_| json!([0, 1, 2, 0])).collect();
        let compact = json!({
            "v": FILE_VERSION,
            "strings": [big, "id", "2026-01-01T00:00:00.000Z"],
            "shapes": [["sid", "splayed_at", "sposter"]],
            "rows": rows,
        });
        let data = b64_encode(&gzip(&serde_json::to_vec(&compact).unwrap()).unwrap());
        assert!(data.len() < 64 * 1024, "the wire blob stays small");
        let blob = json!([{ "v": CLOUD_VERSION, "enc": CLOUD_ENC, "n": 600, "data": data }]);
        let err = cloud_decode_ref(&blob).unwrap_err();
        assert!(err.contains("cap"), "{err}");
        assert!(decode_compact(&compact, MAX_DECODED_CLOUD).is_err());
        // The same shape at an honest size decodes.
        assert_eq!(decode_compact(&compact, 1 << 30).unwrap().len(), 600);
    }

    fn envelope_blob(compact: &Value) -> Value {
        let data = b64_encode(&gzip(&serde_json::to_vec(compact).unwrap()).unwrap());
        json!([{ "v": CLOUD_VERSION, "enc": CLOUD_ENC, "n": 1, "data": data }])
    }

    /// A raw field holding a huge array: tiny on the wire, and it used to be
    /// charged as one field. The PARSE is refused before it allocates the tree.
    #[test]
    fn a_raw_array_bomb_is_refused_before_the_parse() {
        let n = 5_000_000;
        let mut text = String::with_capacity(n * 2 + 128);
        text.push_str(r#"{"v":1,"strings":["id","2026-01-01T00:00:00.000Z"],"shapes":[["sid","splayed_at","jx"]],"rows":[[0,0,1,["#);
        for i in 0..n {
            text.push_str(if i == 0 { "0" } else { ",0" });
        }
        text.push_str("]]]}");
        let data = b64_encode(&gzip(text.as_bytes()).unwrap());
        assert!(data.len() < 64 * 1024, "the wire blob stays small: {}", data.len());
        assert!(json_parse_cost(text.as_bytes()) > MAX_DECODED_CLOUD);
        let blob = json!([{ "v": CLOUD_VERSION, "enc": CLOUD_ENC, "n": 1, "data": data }]);
        let err = cloud_decode_ref(&blob).unwrap_err();
        assert!(err.contains("cap"), "{err}");
    }

    /// Under the parse budget, a raw field is charged by its size in the
    /// decode, and a row past the per-row cap is dropped on every way in:
    /// cloud envelope, cloud plain head, append, and the file load.
    #[test]
    fn an_oversized_row_never_enters_the_store() {
        let big: Vec<u32> = vec![0; 100_000];
        let fat = json!({ "id": "fat", "played_at": "2026-01-01T00:00:00.000Z", "x": big });
        assert!(!row_fits(&fat));
        // Every honest row fits with a wide margin.
        assert!(corpus(200).iter().all(|r| value_cost(r) * 10 < MAX_ROW_COST));

        // The envelope: the raw field is charged, so a tight budget refuses it.
        let compact = encode_compact([&fat, &row(1)]);
        assert!(decode_compact(&compact, 64 * 1024).is_err());
        let (back, _) = cloud_decode_ref(&envelope_blob(&compact)).unwrap();
        assert_eq!(back, vec![row(1)], "the fat row is dropped, the honest one kept");

        // The plain head an older Aura pushes, and a legacy plain array.
        let env_only = envelope_blob(&encode_compact(std::iter::empty::<&Value>()));
        let mut head = vec![fat.clone(), row(2)];
        head.push(env_only.as_array().unwrap()[0].clone());
        let (back, _) = cloud_decode_ref(&Value::Array(head)).unwrap();
        assert_eq!(back, vec![row(2)]);
        let (back, legacy) = cloud_decode_ref(&json!([fat.clone(), row(3)])).unwrap();
        assert!(legacy);
        assert_eq!(back, vec![row(3)]);

        // Append and the file load path.
        let mut rows = Vec::new();
        assert_eq!(apply_append(&mut rows, vec![fat.clone(), row(4)]), 1);
        assert_eq!(rows, vec![row(4)]);
        assert_eq!(sanitize_rows(vec![fat, row(5)]), vec![row(5)]);
    }

    #[test]
    fn the_parse_estimate_is_an_upper_bound() {
        // Commas and brackets inside strings are not nodes.
        assert_eq!(json_parse_cost(br#""a,[{""#), PARSE_NODE_COST + 6);
        assert_eq!(json_parse_cost(br#""\",""#), PARSE_NODE_COST + 5);
        // Five values in two arrays: the bound counts 1 + 2 opens + 3 commas.
        // Plus each `[`'s minimum Vec capacity (`ARRAY_OPEN_EXTRA_COST`).
        assert_eq!(json_parse_cost(b"[1,[2,3],4]"), 6 * PARSE_NODE_COST + 2 * ARRAY_OPEN_EXTRA_COST + 11);
        // An honest file's estimate leaves the decode most of the budget.
        let compact = serde_json::to_vec(&encode_compact(corpus(2000).iter())).unwrap();
        assert!(json_parse_cost(&compact) < 8 << 20, "{}", json_parse_cost(&compact));
        let bytes = encode_file(&corpus(2000)).unwrap();
        assert_eq!(decode_file(&bytes).unwrap(), corpus(2000));
    }

    use super::alloc_probe::measured;

    /// The node bound holds for serde_json's real `Map`, whatever order the
    /// keys arrive in, and one key already costs a whole node.
    #[test]
    fn map_cost_bounds_the_real_btree() {
        for n in 1..=300usize {
            for reversed in [false, true] {
                let mut keys: Vec<String> = (0..n).map(|i| format!("k{i:05}")).collect();
                if reversed {
                    keys.reverse();
                }
                let (m, peak, _) = measured(move || {
                    let mut m = Map::new();
                    for k in keys {
                        m.insert(k, Value::Null);
                    }
                    m
                });
                assert!(peak as u64 <= map_cost(n), "n={n} rev={reversed}: {peak} > {}", map_cost(n));
                drop(m);
            }
        }
        let (_, one, _) = measured(|| {
            let mut m = Map::new();
            m.insert(String::new(), Value::Null);
            m
        });
        assert!(one >= 500, "a one-key map allocates a whole node: {one}");
    }

    /// Text of `depth` nested one-key objects around a 0.
    fn nested(depth: usize) -> String {
        format!("{}0{}", r#"{"":"#.repeat(depth), "}".repeat(depth))
    }

    fn envelope_of_text(text: &str) -> Value {
        let data = b64_encode(&gzip(text.as_bytes()).unwrap());
        assert!(data.len() < 1 << 20, "under the proxy's 1 MiB: {}", data.len());
        json!([{ "v": CLOUD_VERSION, "enc": CLOUD_ENC, "n": 1, "data": data }])
    }

    /// Object-heavy cloud blobs (the BTreeMap decode bomb): tiny on the wire,
    /// each `{"":` costs a ~632 B node to parse and another to clone. Every
    /// one is refused or decodes within its budget, and none leaves an
    /// oversized row behind.
    #[test]
    fn an_object_bomb_stays_within_the_budget() {
        let head = r#"{"v":1,"strings":["id","2026-01-01T00:00:00.000Z"],"shapes":[["sid","splayed_at","jz"]],"rows":["#;
        // (name, text, decodes): each shape once under the budget (it decodes
        // and its rows are dropped) and once past it (refused at the parse).
        let mut cases: Vec<(&str, String, bool)> = Vec::new();
        // An ignored key holding many one-key objects.
        for (n, ok) in [(150_000usize, true), (1_000_000, false)] {
            let items = vec![r#"{"":0}"#; n].join(",");
            cases.push(("ignored", format!(r#"{{"v":1,"strings":[],"shapes":[],"rows":[],"z":[{items}]}}"#), ok));
        }
        // Rows whose raw field is objects nested 100 deep.
        for (n, ok) in [(800usize, true), (3000, false)] {
            let rows = vec![format!("[0,0,0,{}]", nested(100)); n].join(",");
            cases.push(("deep", format!("{head}{rows}]}}"), ok));
        }
        // Rows whose raw field is an array of 13 such nests: each row's real
        // size is ~1 MB, ~13x what the old per-field charge said, which kept
        // 1240 of them (~1 GiB) from a 39 KB blob.
        for (n, ok) in [(100usize, true), (1240, false)] {
            let field = format!("[{}]", vec![nested(100); 13].join(","));
            let rows = vec![format!("[0,0,0,{field}]"); n].join(",");
            cases.push(("wide", format!("{head}{rows}]}}"), ok));
        }
        for (name, text, ok) in &cases {
            let blob = envelope_of_text(text);
            let owned = blob.clone();
            let (res, peak, live) = measured(move || cloud_decode(owned));
            assert_eq!(res.is_ok(), *ok, "{name} ({} B): {:?}", text.len(), res.as_ref().err());
            // The inflated text (and its base64 source) is alive beside the
            // parse but bounded by its own cap; the TREES are what the budget
            // bounds.
            let bound = MAX_DECODED_CLOUD as i64 + 3 * text.len() as i64;
            assert!(peak <= bound, "{name} ({} B): peak {peak} over {bound}", text.len());
            if let Ok((rows, _)) = &res {
                assert!(rows.is_empty(), "{name}: no oversized row is kept");
            }
            assert!(live < 1 << 20, "{name}: {live} B left resident");
        }
    }

    /// The tighter accounting still decodes a FULL honest cloud blob, and an
    /// honest file decode stays under its estimate.
    #[test]
    fn a_full_honest_blob_still_decodes() {
        // corpus() reuses 17 titles, so it compresses far better than a real
        // history: more rows per MiB than any real blob, the worst case.
        let rows = corpus(60_000);
        let (blob, inc, _) = cloud_encode_rows(&rows, CLOUD_BUDGET_BYTES).unwrap();
        let (back, legacy) = cloud_decode_ref(&blob).unwrap();
        assert!(!legacy);
        let env = blob.as_array().unwrap().last().unwrap()["data"].as_str().unwrap().to_string();
        let text = gunzip_capped(&b64_decode(&env).unwrap(), MAX_INFLATED_CLOUD).unwrap();
        assert_eq!(back.len(), inc);
        // ~28k rows estimate ~105 MiB: room for a real history's ~40k rows.
        let est: u64 = json_parse_cost(&text) + back.iter().map(|r| DECODE_ROW_COST + value_cost(r)).sum::<u64>();
        assert!(est < MAX_DECODED_CLOUD / 2, "{} rows estimate {est}", back.len());
        // Every honest row is far under the per-row cap.
        assert!(rows.iter().all(|r| value_cost(r) * 10 < MAX_ROW_COST));
        let file = encode_file(&rows[..5000]).unwrap();
        let raw = gunzip_capped(&file, MAX_INFLATED_LOCAL).unwrap();
        let (v, parse_peak, _) = measured(|| serde_json::from_slice::<Value>(&raw).unwrap());
        assert!(parse_peak as u64 <= json_parse_cost(&raw), "{parse_peak} > {}", json_parse_cost(&raw));
        let est: u64 = rows[..5000].iter().map(|r| DECODE_ROW_COST + value_cost(r)).sum();
        let (_, dec_peak, _) = measured(|| decode_compact(&v, MAX_DECODED_LOCAL).unwrap());
        assert!(dec_peak as u64 <= est, "{dec_peak} > {est}");
    }

    /// `depth` nested one-element arrays around a 0: the shape whose Vecs
    /// serde_json allocates at 4 slots for 1 element.
    fn chain(depth: usize) -> String {
        format!("{}0{}", "[".repeat(depth), "]".repeat(depth))
    }

    /// The parse estimate is a TRUE upper bound for one-element-array chains
    /// (they peaked at ~2.1x the cloud budget and ~2.6x the local one when a
    /// `[` was charged one 64 B node). Both paths share the estimate, so
    /// holding the parse to it holds both.
    #[test]
    fn array_chains_parse_within_the_estimate() {
        for depth in [1usize, 2, 3, 8, 60, 120] {
            let text = format!("[{}]", vec![chain(depth); 20_000].join(","));
            let est = json_parse_cost(text.as_bytes());
            let (v, peak, _) = measured(|| serde_json::from_slice::<Value>(text.as_bytes()).unwrap());
            drop(v);
            assert!(peak as u64 <= est, "depth {depth}: peak {peak} > estimate {est}");
        }
        // Arrays of every small length, where the 4-slot minimum and the
        // doubling growth bite.
        for n in 0..=40usize {
            let inner = vec!["0"; n].join(",");
            let text = format!("[{}]", vec![format!("[{inner}]"); 2000].join(","));
            let est = json_parse_cost(text.as_bytes());
            let (v, peak, _) = measured(|| serde_json::from_slice::<Value>(text.as_bytes()).unwrap());
            drop(v);
            assert!(peak as u64 <= est, "len {n}: peak {peak} > estimate {est}");
        }
    }

    /// The reproduced cloud attack: an ignored key full of depth-120 chains,
    /// sized so its (old) estimate just fit the cloud budget, with and
    /// without a padding string. The whole decode stays inside the bound the
    /// object bomb test states.
    #[test]
    fn a_chain_bomb_stays_within_the_cloud_budget() {
        fn doc(n: usize, pad: usize) -> String {
            let c = chain(120);
            format!(
                r#"{{"v":1,"strings":[],"shapes":[],"rows":[],"p":"{}","z":[{}]}}"#,
                "a".repeat(pad),
                vec![c.as_str(); n].join(","),
            )
        }
        for pad in [0usize, 25 << 20] {
            // The largest n the estimate accepts (it is linear in n).
            let (c1, c2) = (json_parse_cost(doc(1, pad).as_bytes()), json_parse_cost(doc(2, pad).as_bytes()));
            let n = 1 + ((MAX_DECODED_CLOUD - c1) / (c2 - c1)) as usize;
            let text = doc(n, pad);
            assert!(json_parse_cost(text.as_bytes()) <= MAX_DECODED_CLOUD);
            let blob = envelope_of_text(&text);
            let (res, peak, live) = measured(move || cloud_decode(blob));
            assert_eq!(res.map(|(r, _)| r.len()), Ok(0), "pad {pad}");
            let bound = MAX_DECODED_CLOUD as i64 + 3 * text.len() as i64;
            assert!(peak <= bound, "pad {pad}: peak {peak} over {bound}");
            assert!(live < 1 << 20, "pad {pad}: {live} B left resident");
        }
    }

    /// A value nested `depth` levels (`depth` arrays around a 0).
    fn deep(depth: usize) -> Value {
        serde_json::from_str(&chain(depth)).unwrap()
    }

    fn keyed(id: &str, at: &str) -> Value {
        json!({ "id": id, "played_at": at })
    }

    /// Rows nested to serde_json's own limit used to pass the size cap, be
    /// kept, persisted and re-pushed in the PLAIN head, where the IPC
    /// envelope of the next pull went past 128 levels: history sync then
    /// failed on every device for good. Such a row is dropped on every way
    /// in; an honest odd field passes.
    #[test]
    fn a_deep_row_never_enters_the_store() {
        let at = "2026-01-01T00:00:00.000Z";
        let mut evil = keyed("evil", at);
        evil["z"] = deep(124);
        assert!(value_cost(&evil) < MAX_ROW_COST, "the size cap alone let it through");
        assert!(!row_fits(&evil));
        // The boundary: the row object is level 1.
        let mut edge = keyed("edge", at);
        edge["z"] = deep(MAX_ROW_DEPTH - 1);
        assert!(row_fits(&edge));
        let mut over = keyed("over", at);
        over["z"] = deep(MAX_ROW_DEPTH);
        assert!(!row_fits(&over));
        // Honest rows, odd fields included, all pass.
        assert!(corpus(200).iter().all(row_fits));

        // The reproduced attack: the deep row inside the envelope.
        let text = format!(
            r#"{{"v":1,"strings":["evil"],"shapes":[["sid","tplayed_at","jz"]],"rows":[[0,0,253402300799999,{}]]}}"#,
            chain(124)
        );
        let (back, _) = cloud_decode(envelope_of_text(&text)).unwrap();
        assert!(back.is_empty(), "the deep row is not decoded");

        // Inside a compact form beside honest rows: skipped without copying,
        // and the timestamps of the rows after it (deltas) stay exact.
        let rows = vec![row(1), evil.clone(), row(2), over.clone(), row(3), edge.clone()];
        let want = vec![row(1), row(2), row(3), edge.clone()];
        let compact = encode_compact(rows.iter());
        assert_eq!(decode_compact(&compact, MAX_DECODED_CLOUD).unwrap(), want);
        assert_eq!(decode_file(&encode_file(&rows).unwrap()).unwrap(), want, "the file keeps the rest");
        let (back, _) = cloud_decode(envelope_blob(&compact)).unwrap();
        assert_eq!(back, want);

        // The plain head, a legacy array, append, migrate / replace / load.
        let env_only = envelope_blob(&encode_compact(std::iter::empty::<&Value>()));
        let blob = json!([evil.clone(), row(4), env_only[0].clone()]);
        assert_eq!(cloud_decode(blob).unwrap().0, vec![row(4)]);
        assert_eq!(cloud_decode(json!([over.clone(), row(5)])).unwrap().0, vec![row(5)]);
        let mut held = Vec::new();
        assert_eq!(apply_append(&mut held, vec![evil.clone(), row(6)]), 1);
        assert_eq!(held, vec![row(6)]);
        assert_eq!(sanitize_rows(vec![evil, row(7), over]), vec![row(7)]);

        // What this device pushes next still parses inside an IPC envelope
        // (the failure was serde_json's recursion limit on that parse).
        let (pushed, _, _) = cloud_encode_rows(&[row(8), edge], CLOUD_BUDGET_BYTES).unwrap();
        let ipc = serde_json::to_string(&json!({ "action": { "op": "merge_cloud", "scope": "s", "data": pushed } })).unwrap();
        assert!(serde_json::from_str::<Value>(&ipc).is_ok());
    }

    /// A cloud copy is read up to `MAX_CLOUD_ROWS` rows (the first, newest
    /// ones), and the encoder never writes more, so an honest copy is never
    /// cut by the reader.
    #[test]
    fn a_cloud_copy_is_held_to_the_row_cap() {
        // The reproduced shape: 230k two-field rows from a few-KB blob.
        let n = 230_000usize;
        let mut text = String::from(r#"{"v":1,"strings":["a"],"shapes":[["sid","tplayed_at"]],"rows":["#);
        for i in 0..n {
            text.push_str(if i == 0 { "[0,0,1600000000000]" } else { ",[0,0,-1]" });
        }
        text.push_str("]}");
        let (rows, _) = cloud_decode(envelope_of_text(&text)).unwrap();
        assert_eq!(rows.len(), MAX_CLOUD_ROWS);
        assert_eq!(key_of(&rows[0]), Some(("a", "2020-09-13T12:26:40.000Z")), "the first rows are kept");

        // Distinct rows: the plain head and the envelope share the cap.
        let many: Vec<Value> = (0..MAX_CLOUD_ROWS + 5000)
            .map(|i| keyed(&format!("i{i}"), &format_iso_ms(1_700_000_000_000 - i as i64 * 1000).unwrap()))
            .collect();
        let (blob, inc, total) = cloud_encode_rows(&many, 256 << 20).unwrap();
        assert_eq!((inc, total), (MAX_CLOUD_ROWS, many.len()), "the encoder stops at the cap");
        let (back, _) = cloud_decode_ref(&blob).unwrap();
        assert_eq!(back.len(), MAX_CLOUD_ROWS, "and a reader keeps every row it wrote");
        assert_eq!(back[..], many[..MAX_CLOUD_ROWS]);
        // A crafted blob over the cap: head rows first, then the envelope's
        // newest, never more than the cap in all.
        let env = envelope_for(&many[1000..].iter().collect::<Vec<_>>()).unwrap().0;
        let mut crafted: Vec<Value> = many[..1000].to_vec();
        crafted.push(env);
        let (back, _) = cloud_decode(Value::Array(crafted)).unwrap();
        assert_eq!(back[..], many[..MAX_CLOUD_ROWS]);
    }

    /// The merge answer is the old one, field for field.
    #[test]
    fn the_merge_answer_matches_the_delta() {
        let local = vec![keyed("a", "2026-01-02"), keyed("b", "2026-01-01"), keyed("l", "2026-01-00")];
        let server = vec![
            json!({"id":"b","played_at":"2026-01-01","poster":"p"}),
            keyed("c", "2026-01-03"),
            json!({"id":"c","played_at":"2026-01-03","dupe":true}),
            keyed("a", "2026-01-02"),
        ];
        let mut rows = local.clone();
        let (answer, changed) = merge_cloud(&mut rows, server.clone(), true).unwrap();
        assert!(changed);
        let answer: Value = serde_json::from_str(answer.get()).unwrap();
        assert_eq!(answer, json!({
            "replaced": [{"id":"b","played_at":"2026-01-01","poster":"p"}],
            "added": [{"id":"c","played_at":"2026-01-03"}],
            "legacy": true,
            "server_count": 4,
            "local_only": 1,
            "count": 4,
        }));
        let mut want = local.clone();
        apply_cloud_merge(&mut want, server.clone());
        assert_eq!(rows, want);
        // The same copy again changes nothing.
        let (answer, changed) = merge_cloud(&mut rows, server, false).unwrap();
        assert!(!changed);
        let answer: Value = serde_json::from_str(answer.get()).unwrap();
        assert_eq!((answer["replaced"].as_array().unwrap().len(), answer["added"].as_array().unwrap().len()), (0, 0));
    }

    /// What the command does with a pulled blob, end to end: decode, merge
    /// into `rows`, and the copy Tauri makes when it serializes the answer.
    fn merge_end_to_end(rows: &mut Vec<Value>, blob: Value) -> Result<usize, String> {
        let (server, legacy) = cloud_decode(blob)?;
        let (answer, _) = merge_cloud(rows, server, legacy)?;
        let ipc = serde_json::to_string(&Answer::Raw(answer)).map_err(|e| e.to_string())?;
        Ok(ipc.len())
    }

    /// The reproduced MergeCloud attack: a 458-byte blob of 4200 rows sharing
    /// one 60 KB interned string, each under the per-row cap, decodes to just
    /// under the budget. It used to be copied 4-5 more times after the
    /// decode (~1.2 GiB peak, 243 MiB left resident); the answer now counts
    /// against what the decode left of the budget, so it is refused with
    /// nothing merged. A smaller one that fits is merged within the budget.
    #[test]
    fn a_merge_bomb_stays_within_the_cloud_budget() {
        fn crafted(n: usize) -> (Value, usize) {
            let big = "x".repeat(60_000);
            let rows: Vec<String> =
                (0..n).map(|i| format!("[0,0,{},1]", if i == 0 { 1_700_000_000_000i64 } else { 1000 })).collect();
            let text = format!(
                r#"{{"v":1,"strings":["id-a","{big}"],"shapes":[["sid","tplayed_at","sz"]],"rows":[{}]}}"#,
                rows.join(",")
            );
            (envelope_of_text(&text), text.len())
        }
        let (blob, text_len) = crafted(4200);
        assert!(serde_json::to_vec(&blob).unwrap().len() < 1024, "a tiny blob");
        let mut rows = vec![row(1)];
        let (res, peak, live) = measured(|| merge_end_to_end(&mut rows, blob));
        println!("merge bomb (4200 rows): peak {} MiB, resident {} KiB", peak >> 20, live >> 10);
        assert!(res.unwrap_err().contains("cap"));
        assert_eq!(rows, vec![row(1)], "nothing merged");
        let bound = MAX_DECODED_CLOUD as i64 + 3 * text_len as i64;
        assert!(peak <= bound, "peak {peak} over {bound}");
        assert!(live < 1 << 20, "{live} B left resident");

        // 600 such rows (~36 MB decoded) fit: merged, and the whole path,
        // Tauri's copy of the answer included, stays inside the budget.
        let (blob, _) = crafted(600);
        let mut rows = Vec::new();
        let (res, peak, live) = measured(|| merge_end_to_end(&mut rows, blob));
        println!("merge bomb (600 rows): peak {} MiB, resident {} MiB", peak >> 20, live >> 20);
        assert!(res.is_ok());
        assert_eq!(rows.len(), 600);
        assert!(peak <= MAX_DECODED_CLOUD as i64, "peak {peak}");
        assert!(live <= (600 * 64 * 1024) as i64, "resident {live}");
    }

    /// The same bomb with the 60 KB interned string as the KEY. The key sets
    /// used to copy every id, so the 4300-row blob peaked at ~495 MiB (the
    /// decoded rows plus a second copy of every id). The key cap drops every
    /// such row now, and the 1000-row blob that used to be MERGED (57 MiB
    /// resident) merges nothing.
    #[test]
    fn a_key_bomb_is_dropped_within_the_cloud_budget() {
        fn crafted(n: usize) -> (Value, usize) {
            let big = "x".repeat(60_000);
            let rows: Vec<String> =
                (0..n).map(|i| format!("[0,0,{}]", if i == 0 { 1_700_000_000_000i64 } else { 1000 })).collect();
            let text = format!(
                r#"{{"v":1,"strings":["{big}"],"shapes":[["sid","tplayed_at"]],"rows":[{}]}}"#,
                rows.join(",")
            );
            (envelope_of_text(&text), text.len())
        }
        for n in [4300usize, 1000] {
            let (blob, text_len) = crafted(n);
            assert!(serde_json::to_vec(&blob).unwrap().len() < 1024, "a tiny blob");
            let mut rows = vec![row(1)];
            let (res, peak, live) = measured(|| merge_end_to_end(&mut rows, blob));
            println!("key bomb ({n} rows): peak {} MiB, resident {} KiB", peak >> 20, live >> 10);
            assert!(res.is_ok(), "{n}: {:?}", res.err());
            assert_eq!(rows, vec![row(1)], "{n}: nothing merged");
            let bound = MAX_DECODED_CLOUD as i64 + 3 * text_len as i64;
            assert!(peak <= bound, "{n}: peak {peak} over {bound}");
            assert!(live < 1 << 20, "{n}: {live} B left resident");
        }
    }

    /// The key caps, at their edges, on every way in.
    #[test]
    fn an_overlong_key_never_enters_the_store() {
        let at = "2026-01-01T00:00:00.000Z";
        let edge = keyed(&"i".repeat(MAX_ID_BYTES), at);
        let long_id = keyed(&"i".repeat(MAX_ID_BYTES + 1), at);
        let long_at = keyed("a", &"t".repeat(MAX_PLAYED_AT_BYTES + 1));
        assert!(is_keepable_row(&edge));
        assert!(!is_keepable_row(&long_id));
        assert!(!is_keepable_row(&long_at));
        assert!(corpus(200).iter().all(is_keepable_row));
        let (back, _) = cloud_decode(json!([long_id.clone(), edge.clone(), long_at.clone()])).unwrap();
        assert_eq!(back, vec![edge.clone()]);
        let (back, _) = cloud_decode(envelope_blob(&encode_compact([&long_id, &edge, &long_at]))).unwrap();
        assert_eq!(back, vec![edge.clone()]);
        let mut held = Vec::new();
        assert_eq!(apply_append(&mut held, vec![long_id.clone(), long_at.clone(), edge.clone()]), 1);
        assert_eq!(held, vec![edge.clone()]);
        assert_eq!(sanitize_rows(vec![long_id, edge.clone(), long_at]), vec![edge]);
    }

    /// The dedupe in `cloud_decode` and the key sets in `plan_cloud_merge`
    /// borrow their keys: 2000 rows of 2 KB ids (4 MB of keys) cost them a
    /// fraction of that.
    #[test]
    fn the_merge_key_sets_borrow_their_keys() {
        let id = |i: usize| format!("{i:05}{}", "k".repeat(MAX_ID_BYTES - 5));
        let at = |i: usize| format_iso_ms(1_700_000_000_000 - i as i64 * 1000).unwrap();
        let server: Vec<Value> = (0..2000).map(|i| keyed(&id(i), &at(i))).collect();
        let local: Vec<Value> = (1000..3000).map(|i| keyed(&id(i), &at(i))).collect();
        let keys = 2000 * MAX_ID_BYTES as i64;

        // The legacy plain array, every row twice: first wins.
        let mut doubled = server.clone();
        doubled.extend(server.iter().cloned());
        let blob = Value::Array(doubled);
        let (res, peak, _) = measured(move || cloud_decode(blob));
        let (back, legacy) = res.unwrap();
        assert!(legacy);
        assert_eq!(back, server);
        assert!(peak < keys / 4, "cloud_decode peak {peak}");

        let s = server.clone();
        let (plan, peak, _) = measured(|| plan_cloud_merge(&local, s));
        assert_eq!((plan.replaced.len(), plan.added.len(), plan.local_only), (0, 1000, 1000));
        assert!(peak < keys / 4, "plan_cloud_merge peak {peak}");
    }

    /// Rows of odd shapes: control characters and quotes (escaped on write),
    /// nested raw fields, empty containers, extreme numbers, non-ASCII.
    fn odd_rows() -> Vec<Value> {
        (0..300)
            .map(|i| {
                let mut v = keyed(&format!("odd\u{1}\"{i}\\"), &format_iso_ms(1_600_000_000_000 + i as i64).unwrap());
                let o = v.as_object_mut().unwrap();
                match i % 6 {
                    0 => { o.insert("c".into(), json!("\u{0}\u{1f}\n\t\"\\ é \u{1F600}")); }
                    1 => { o.insert("a".into(), json!([[], {}, [[]], [{}], null, true, -1.7976931348623157e308])); }
                    2 => { o.insert("o".into(), json!({ "": {}, "k\u{2}": [1, 2, 3], "n": u64::MAX, "m": i64::MIN })); }
                    3 => { o.insert("e".into(), json!("")); o.insert("\u{3}k".into(), json!(2.2250738585072014e-308)); }
                    4 => { o.insert("played_at2".into(), json!("2026-02-30T00:00:00.000Z")); }
                    _ => { o.insert("z".into(), deep(MAX_ROW_DEPTH - 2)); }
                }
                v
            })
            .collect()
    }

    /// `file_cost` is an upper bound on what `decode_file` charges for a
    /// file, and `compact_file_cost` is that charge exactly.
    #[test]
    fn file_cost_bounds_what_the_file_decode_charges() {
        let big = "y".repeat(20_000);
        let interned: Vec<Value> = (0..50)
            .map(|i| {
                let mut v = keyed(&format!("i{i}"), &format_iso_ms(1_700_000_000_000 + i as i64).unwrap());
                v["z"] = json!(big);
                v
            })
            .collect();
        for (name, rows) in [("corpus", corpus(2000)), ("odd", odd_rows()), ("interned", interned), ("empty", vec![])] {
            assert!(rows.iter().all(is_keepable_row), "{name}");
            let bytes = encode_file(&rows).unwrap();
            let bound = rows.iter().fold(FILE_FIXED_COST, |n, r| n + file_cost(r));
            let refs: Vec<&Value> = rows.iter().collect();
            let exact = compact_file_cost(&refs);
            assert!(exact <= bound, "{name}: exact {exact} > bound {bound}");
            assert_eq!(decode_file_within(&bytes, exact).unwrap(), rows, "{name}");
            assert!(decode_file_within(&bytes, exact - 1).is_err(), "{name}: {exact} is not the exact charge");
            if name == "corpus" {
                println!(
                    "honest rows: bound {} B / row, exact {} B / row",
                    bound / rows.len() as u64,
                    exact / rows.len() as u64
                );
            }
        }
    }

    /// The reproduced growth: crafted copies, each fine on its own, pulled
    /// one after another. The store never grows past what its file can be
    /// read back at; a refused merge changes nothing.
    #[test]
    fn cloud_merges_never_outgrow_the_file() {
        let mut rows = corpus(200);
        let refs: Vec<&Value> = rows.iter().collect();
        let cap = compact_file_cost(&refs) + (3 << 20);
        let (mut accepted, mut refused) = (0, 0);
        for pull in 0..12i64 {
            let text = format!(
                r#"{{"v":1,"strings":["id-{pull}","{}"],"shapes":[["sid","tplayed_at","sz"]],"rows":[{}]}}"#,
                "x".repeat(50_000),
                (0..20)
                    .map(|i| format!("[0,0,{},1]", if i == 0 { 1_700_000_000_000 + pull * 100_000 } else { 1000 }))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            let (server, legacy) = cloud_decode(envelope_of_text(&text)).unwrap();
            assert_eq!(server.len(), 20);
            let before = rows.clone();
            match merge_cloud_within(&mut rows, server, legacy, cap) {
                Ok(_) => accepted += 1,
                Err(e) => {
                    assert!(e.contains("read back"), "{e}");
                    assert_eq!(rows, before, "a refused merge changes nothing");
                    refused += 1;
                }
            }
            assert!(decode_file_within(&encode_file(&rows).unwrap(), cap).is_ok(), "pull {pull}");
        }
        assert!(accepted > 0 && refused > 0, "{accepted} accepted, {refused} refused");

        // Near the cap the exact measure decides, not the per-row bound: an
        // honest merge that lands exactly on the cap is accepted.
        let mut merged = corpus(300);
        apply_cloud_merge(&mut merged, corpus(600));
        let refs: Vec<&Value> = merged.iter().collect();
        let exact = compact_file_cost(&refs);
        let bound = merged.iter().fold(FILE_FIXED_COST, |n, r| n + file_cost(r));
        assert!(bound > exact, "the bound alone would refuse it");
        let mut rows = corpus(300);
        assert!(merge_cloud_within(&mut rows, corpus(600), false, exact - 1).is_err());
        assert_eq!(rows, corpus(300));
        assert!(merge_cloud_within(&mut rows, corpus(600), false, exact).is_ok());
        assert_eq!(rows, merged);
        // A merge that does not grow the store is never refused, even over
        // the cap: here one row comes back slimmer.
        let mut slim = rows[0].clone();
        slim.as_object_mut().unwrap().remove("poster");
        let (_, changed) = merge_cloud_within(&mut rows, vec![slim.clone()], false, 0).unwrap();
        assert!(changed);
        assert_eq!(rows[0], slim);
    }

    /// The HONEST worst case end to end: a full 1 MiB blob (corpus() packs
    /// more rows per MiB than any real history) merged into an empty store.
    #[test]
    fn a_full_honest_merge_stays_well_inside_the_budget() {
        let rows = corpus(60_000);
        let (blob, inc, _) = cloud_encode_rows(&rows, CLOUD_BUDGET_BYTES).unwrap();
        drop(rows);
        let mut store = Vec::new();
        let (res, peak, live) = measured(|| merge_end_to_end(&mut store, blob));
        let ipc = res.unwrap();
        assert_eq!(store.len(), inc);
        println!(
            "honest merge: {inc} rows, answer {} MiB, peak {} MiB, resident {} MiB",
            ipc >> 20, peak >> 20, live >> 20,
        );
        assert!(peak < (MAX_DECODED_CLOUD / 2) as i64, "peak {peak}");
    }

    #[test]
    fn retries_back_off_to_a_minute() {
        assert_eq!(retry_delay(1), FLUSH_DELAY);
        assert_eq!(retry_delay(2), FLUSH_DELAY * 2);
        assert_eq!(retry_delay(3), FLUSH_DELAY * 4);
        assert_eq!(retry_delay(10), Duration::from_secs(60));
        assert_eq!(retry_delay(u32::MAX), Duration::from_secs(60));
    }

    #[cfg(windows)]
    #[test]
    fn a_locked_target_is_a_transient_rename_failure() {
        assert!(rename_is_transient(&std::io::Error::from_raw_os_error(5)));
        assert!(rename_is_transient(&std::io::Error::from_raw_os_error(32)));
        assert!(!rename_is_transient(&std::io::Error::from_raw_os_error(2)));
    }

    // -- Disk safety. These use their own directory and scope names, and a
    // local resident slot rather than STATE, so they run beside each other.

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aura-history-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn resident(scope: &str, rows: Vec<Value>) -> Resident {
        Resident { scope: scope.into(), rows, gen: next_gen(), saved_gen: 0, existed: true, unreadable: false, recovered: false, pending_merged: false }
    }

    fn play(id: &str) -> Value {
        json!({ "id": id, "played_at": "2026-11-01T00:00:00.000Z" })
    }

    /// The Append op on an unreadable resident.
    fn append_unreadable(dir: &Path, r: &mut Resident, row: Value) {
        assert!(r.unreadable);
        apply_append(&mut r.rows, vec![row]);
        let _ = hold_unreadable_rows(dir, r);
    }

    /// The file vanishes while unreadable, with a play held: whichever call
    /// reads it next, the marker is on disk and the scope answers recovered, so
    /// the pull merges before the next push. Order one: Load resolves it.
    #[test]
    fn a_file_gone_while_unreadable_latches_when_load_resolves_it() {
        let dir = scratch("gone-load");
        let scope = "t-gone-load";
        std::fs::create_dir_all(file_for(&dir, scope)).unwrap();
        let mut st: Option<Resident> = None;
        append_unreadable(&dir, ensure_resident(&mut st, &dir, scope).unwrap(), play("p"));
        std::fs::remove_dir_all(file_for(&dir, scope)).unwrap();
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(!r.unreadable && r.recovered);
        assert!(recovering_path(&dir, scope).exists());
        assert_eq!(r.rows, vec![play("p")]);
        assert!(!r.existed, "the carry-over rule still sees no file");
        assert_ne!(r.gen, r.saved_gen, "the play is dirty");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Order two: an Append resolves it, and its touch runs before any Load.
    #[test]
    fn a_file_gone_while_unreadable_latches_when_append_resolves_it() {
        let dir = scratch("gone-append");
        let scope = "t-gone-append";
        std::fs::create_dir_all(file_for(&dir, scope)).unwrap();
        let mut st: Option<Resident> = None;
        append_unreadable(&dir, ensure_resident(&mut st, &dir, scope).unwrap(), play("p"));
        std::fs::remove_dir_all(file_for(&dir, scope)).unwrap();
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        apply_append(&mut r.rows, vec![play("q")]);
        touch(r);
        assert!(r.existed);
        assert!(r.recovered && recovering_path(&dir, scope).exists());
        // What the Load that follows reads, and a restart after the write.
        let existed = r.existed;
        latch_missing_file(&dir, r, existed);
        assert!(r.recovered);
        let mut map = HashMap::new();
        make_durable(&mut map, &dir, r).unwrap();
        let l = read_scope(&dir, scope).unwrap();
        assert!(l.existed && l.recovered);
        // A guest has no cloud to wait for.
        std::fs::create_dir_all(file_for(&dir, GUEST_SCOPE)).unwrap();
        let mut st: Option<Resident> = None;
        append_unreadable(&dir, ensure_resident(&mut st, &dir, GUEST_SCOPE).unwrap(), play("g"));
        std::fs::remove_dir_all(file_for(&dir, GUEST_SCOPE)).unwrap();
        let g = ensure_resident(&mut st, &dir, GUEST_SCOPE).unwrap();
        assert!(!g.recovered && !recovering_path(&dir, GUEST_SCOPE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Plays made while the file cannot be read survive a swap away and a
    /// restart, keep their order, reach the file when it reads again, and only
    /// then does the sidecar go.
    #[test]
    fn plays_held_for_an_unreadable_file_survive_a_swap_and_a_restart() {
        let dir = scratch("held");
        let (scope, other) = ("t-held", "t-held-other");
        let path = file_for(&dir, scope);
        std::fs::create_dir_all(&path).unwrap();
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        append_unreadable(&dir, r, play("p1"));
        append_unreadable(&dir, r, play("p2"));
        assert!(pending_path(&dir, scope).exists());
        assert!(path.is_dir(), "nothing written over the unread file");

        // A swap away and back: still unreadable, rows back from the sidecar.
        assert!(!ensure_resident(&mut st, &dir, other).unwrap().unreadable);
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(r.unreadable);
        assert_eq!(r.rows, vec![play("p2"), play("p1")]);
        assert_eq!(r.gen, r.saved_gen, "nothing is written over an unread file");

        // A restart (no exit path ran), another play on top.
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        append_unreadable(&dir, r, play("p3"));
        assert_eq!(read_pending(&dir, scope).unwrap(), vec![play("p3"), play("p2"), play("p1")]);

        // The file reads again: its rows, with the plays on top.
        std::fs::remove_dir_all(&path).unwrap();
        std::fs::write(&path, encode_file(&[play("old")]).unwrap()).unwrap();
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(!r.unreadable && r.existed);
        let want = vec![play("p3"), play("p2"), play("p1"), play("old")];
        assert_eq!(r.rows, want);
        assert!(pending_path(&dir, scope).exists(), "not until the rows have landed");

        // A crash before that write: the next launch repeats an idempotent union.
        let mut again: Option<Resident> = None;
        let r2 = ensure_resident(&mut again, &dir, scope).unwrap();
        assert_eq!(r2.rows.iter().filter(|x| **x == play("p1")).count(), 1);
        assert_ne!(r2.gen, r2.saved_gen);

        let r = st.as_mut().unwrap();
        let mut map = HashMap::new();
        make_durable(&mut map, &dir, r).unwrap();
        assert!(!pending_path(&dir, scope).exists());
        assert_eq!(decode_file(&std::fs::read(&path).unwrap()).unwrap(), want);
        // The next launch has nothing to bring in.
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert_eq!(r.rows, want);
        assert!(!r.pending_merged && r.gen == r.saved_gen);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The background writer takes the same path, snapshot then write, and a
    /// write of rows that never held the sidecar's leaves it alone.
    #[test]
    fn only_a_write_holding_the_held_rows_removes_them() {
        let dir = scratch("held-write");
        let scope = "t-held-write";
        std::fs::write(file_for(&dir, scope), encode_file(&[play("old")]).unwrap()).unwrap();
        write_pending(&dir, scope, &[play("p")]).unwrap();
        let mut map = HashMap::new();
        // The exit path's parked rows for this scope: the file, not the sidecar.
        write_parked_rows(&mut map, &dir, scope, vec![play("q")]).unwrap();
        assert!(pending_path(&dir, scope).exists());
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert_eq!(r.rows, vec![play("p"), play("q"), play("old")]);
        let snap = take_snapshot(r).unwrap();
        assert!(snap.clear_pending);
        write_snapshot(&dir, snap).unwrap();
        assert!(!pending_path(&dir, scope).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Rows still parked at exit for a file that cannot be read go to the
    /// sidecar, on top of a previous session's.
    #[test]
    fn parked_rows_for_an_unreadable_file_are_held_at_exit() {
        let dir = scratch("parked-held");
        let scope = "t-parked-held";
        std::fs::create_dir_all(file_for(&dir, scope)).unwrap();
        let mut map = HashMap::new();
        write_parked_rows(&mut map, &dir, scope, vec![play("a"), play("b")]).unwrap();
        write_parked_rows(&mut map, &dir, scope, vec![play("c")]).unwrap();
        assert_eq!(read_pending(&dir, scope).unwrap(), vec![play("c"), play("b"), play("a")]);
        assert!(file_for(&dir, scope).is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// When the sidecar cannot be written either, the rows stay in memory and
    /// the swap is refused rather than dropping them.
    #[test]
    fn a_swap_is_refused_while_held_rows_cannot_be_written() {
        let dir = scratch("held-refused");
        let (scope, other) = ("t-held-refused", "t-held-refused-other");
        std::fs::create_dir_all(file_for(&dir, scope)).unwrap();
        let tmp = pending_path(&dir, scope).with_extension("gz.tmp");
        std::fs::create_dir_all(&tmp).unwrap(); // the write cannot happen
        let mut st: Option<Resident> = None;
        append_unreadable(&dir, ensure_resident(&mut st, &dir, scope).unwrap(), play("p"));
        assert!(!pending_path(&dir, scope).exists());
        assert!(ensure_resident(&mut st, &dir, other).is_err());
        let kept = st.as_ref().unwrap();
        assert_eq!((kept.scope.as_str(), kept.rows.len()), (scope, 1));
        // Once the sidecar can be written, the swap writes it and goes through.
        std::fs::remove_dir_all(&tmp).unwrap();
        assert_eq!(ensure_resident(&mut st, &dir, other).unwrap().scope, other);
        assert_eq!(read_pending(&dir, scope).unwrap(), vec![play("p")]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A sidecar that does not decode is set aside and nothing else is lost; one
    /// that cannot be read is never overwritten.
    #[test]
    fn a_bad_sidecar_never_blocks_the_scope_or_gets_overwritten() {
        let dir = scratch("held-bad");
        let scope = "t-held-bad";
        let path = pending_path(&dir, scope);
        std::fs::write(&path, b"not gzip").unwrap();
        assert!(read_pending(&dir, scope).unwrap().is_empty());
        assert!(!path.exists() && path.with_extension("gz.bad").exists());
        std::fs::create_dir_all(&path).unwrap(); // a read of a directory fails
        assert!(read_pending(&dir, scope).is_err());
        assert!(write_pending(&dir, scope, &[play("p")]).is_err());
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(!r.pending_merged);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Storage counts a scope's sidecar with its file, and nothing else there.
    #[test]
    fn the_storage_row_counts_the_sidecar_with_its_scope() {
        let dir = scratch("held-usage");
        std::fs::write(file_for(&dir, "a"), [0u8; 10]).unwrap();
        std::fs::write(pending_path(&dir, "a"), [0u8; 5]).unwrap();
        std::fs::write(file_for(&dir, "b"), [0u8; 7]).unwrap();
        std::fs::write(pending_path(&dir, "b"), [0u8; 2]).unwrap();
        std::fs::write(recovering_path(&dir, "a"), [0u8; 100]).unwrap();
        std::fs::write(set_aside_path(&dir, "a"), [0u8; 100]).unwrap();
        assert_eq!(bytes_on_disk(&dir, Some("a")), (24, 15));
        assert_eq!(bytes_on_disk(&dir, None), (24, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Every set-aside records its time, guest included; a rename that failed
    /// set nothing aside; a later one adds to the times, and the oldest stays.
    #[test]
    fn a_set_aside_records_its_time_for_the_backup_pin() {
        let dir = scratch("set-aside");
        let scope = "t-set-aside";
        let path = file_for(&dir, scope);
        std::fs::write(&path, b"not gzip").unwrap();
        let bad = path.with_extension("gz.bad");
        std::fs::create_dir_all(bad.join("x")).unwrap();
        assert!(read_scope(&dir, scope).is_err());
        assert!(read_set_aside(&dir, scope).is_empty());
        std::fs::remove_dir_all(&bad).unwrap();
        read_scope(&dir, scope).unwrap();
        let first = read_set_aside(&dir, scope);
        assert_eq!(first.len(), 1);
        assert!(first[0] > 1_700_000_000_000);
        // A later one keeps the earlier time (a lone number is a list of one).
        std::fs::write(set_aside_path(&dir, scope), b"5").unwrap();
        std::fs::write(&path, b"not gzip").unwrap();
        read_scope(&dir, scope).unwrap();
        let two = read_set_aside(&dir, scope);
        assert_eq!((two.len(), two[0]), (2, 5));
        assert!(two[1] >= first[0]);
        // Over the cap the oldest and the newest stay.
        std::fs::write(set_aside_path(&dir, scope), b"5\n6\n7").unwrap();
        std::fs::write(&path, b"not gzip").unwrap();
        read_scope(&dir, scope).unwrap();
        let capped = read_set_aside(&dir, scope);
        assert_eq!((capped.len(), capped[0], capped[1]), (MAX_SET_ASIDE_TIMES, 5, 7));
        assert!(capped[2] >= first[0]);
        // A line that does not parse is no time, and no more than the cap is read.
        std::fs::write(set_aside_path(&dir, scope), b"junk\n9\n1\n2\n3").unwrap();
        assert_eq!(read_set_aside(&dir, scope), vec![9, 1, 2]);
        // A guest, which has no recovery marker, gets one too.
        std::fs::write(file_for(&dir, GUEST_SCOPE), b"not gzip").unwrap();
        read_scope(&dir, GUEST_SCOPE).unwrap();
        assert_eq!(read_set_aside(&dir, GUEST_SCOPE).len(), 1);
        // A file that merely went missing lost nothing to pin for.
        let fresh = "t-set-aside-fresh";
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, fresh).unwrap();
        latch_missing_file(&dir, r, false);
        assert!(read_set_aside(&dir, fresh).is_empty());
        clear_set_aside(&dir, scope);
        assert!(read_set_aside(&dir, scope).is_empty());
        clear_set_aside(&dir, scope); // already gone: not an error
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unreadable_file_is_never_an_empty_history() {
        let dir = scratch("unreadable");
        let scope = "t-unreadable";
        // A directory where the file should be: a read error that is not
        // NotFound, like a sharing violation.
        std::fs::create_dir_all(file_for(&dir, scope)).unwrap();
        assert!(read_scope(&dir, scope).is_err());
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(r.unreadable);
        assert!(require_readable(r).is_err());
        assert!(take_snapshot(r).is_none(), "nothing is ever written over it");
        let mut map = HashMap::new();
        assert!(make_durable(&mut map, &dir, r).is_err());
        // A play recorded meanwhile is kept.
        apply_append(&mut r.rows, vec![json!({"id":"new","played_at":"2026-11-01T00:00:00.000Z"})]);
        // The file becomes readable: its rows come back with the play on top.
        std::fs::remove_dir_all(file_for(&dir, scope)).unwrap();
        let old = vec![json!({"id":"a","played_at":"2026-10-02T00:00:00.000Z"}), json!({"id":"b","played_at":"2026-10-01T00:00:00.000Z"})];
        std::fs::write(file_for(&dir, scope), encode_file(&old).unwrap()).unwrap();
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(!r.unreadable && r.existed);
        assert_eq!(r.rows.len(), 3);
        assert_eq!(key_of(&r.rows[0]), Some(("new", "2026-11-01T00:00:00.000Z")));
        assert!(r.gen > r.saved_gen, "the merged play is dirty, so it reaches disk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_file_is_set_aside_only_when_the_rename_works() {
        let dir = scratch("corrupt");
        let scope = "t-corrupt";
        let path = file_for(&dir, scope);
        std::fs::write(&path, b"not gzip").unwrap();
        // The set-aside slot is a non-empty directory: the rename fails, so
        // the original must stay readable-later rather than be overwritten.
        let bad = path.with_extension("gz.bad");
        std::fs::create_dir_all(bad.join("x")).unwrap();
        assert!(read_scope(&dir, scope).is_err());
        assert!(path.exists());
        std::fs::remove_dir_all(&bad).unwrap();
        let l = read_scope(&dir, scope).unwrap();
        assert!(l.recovered && !l.existed && l.rows.is_empty());
        assert!(!path.exists() && bad.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The latch outlives the launch that set the file aside: a restart with no
    /// file, a play's new file and a scope swap all still report it, until the
    /// marker goes. A guest has no cloud to clear one, so it never gets one.
    #[test]
    fn a_set_aside_scope_stays_recovering_across_restarts() {
        let dir = scratch("recovering");
        let scope = "t-recovering";
        let path = file_for(&dir, scope);
        std::fs::write(&path, b"not gzip").unwrap();
        assert!(read_scope(&dir, scope).unwrap().recovered);
        assert!(recovering_path(&dir, scope).exists() && !path.exists());
        // Next launch: no file at all.
        let l = read_scope(&dir, scope).unwrap();
        assert!(l.recovered && !l.existed);
        // A play in the first launch wrote a valid file.
        let rows = vec![json!({"id":"p","played_at":"2026-11-01T00:00:00.000Z"})];
        std::fs::write(&path, encode_file(&rows).unwrap()).unwrap();
        let l = read_scope(&dir, scope).unwrap();
        assert!(l.recovered && l.existed);
        assert_eq!(l.rows, rows);
        // A -> B -> A inside the launch rebuilds the resident from the marker.
        let mut st: Option<Resident> = None;
        let other = "t-recovering-other";
        std::fs::write(file_for(&dir, other), encode_file(&rows).unwrap()).unwrap();
        assert!(ensure_resident(&mut st, &dir, scope).unwrap().recovered);
        assert!(!ensure_resident(&mut st, &dir, other).unwrap().recovered);
        assert!(ensure_resident(&mut st, &dir, scope).unwrap().recovered);
        clear_recovering(&dir, scope);
        assert!(!read_scope(&dir, scope).unwrap().recovered);
        clear_recovering(&dir, scope); // already gone: not an error

        let guest = file_for(&dir, GUEST_SCOPE);
        std::fs::write(&guest, b"not gzip").unwrap();
        assert!(read_scope(&dir, GUEST_SCOPE).unwrap().recovered);
        assert!(!recovering_path(&dir, GUEST_SCOPE).exists());
        assert!(!read_scope(&dir, GUEST_SCOPE).unwrap().recovered);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The marker goes only with the merged rows on disk: a failed write keeps
    /// it, so the next launch pulls the cloud copy again.
    #[test]
    fn the_recovery_marker_goes_only_after_the_merge_landed() {
        let dir = scratch("finish-recovery");
        let scope = "t-finish-recovery";
        std::fs::write(recovering_path(&dir, scope), b"").unwrap();
        let rows = vec![json!({"id":"c","played_at":"2026-11-01T00:00:00.000Z"})];
        let tmp = file_for(&dir, scope).with_extension("gz.tmp");
        std::fs::create_dir_all(&tmp).unwrap(); // the write cannot happen
        let mut r = resident(scope, rows.clone());
        r.recovered = true;
        finish_recovery(&dir, &mut r);
        assert!(!r.recovered, "this session holds the merged rows");
        assert!(recovering_path(&dir, scope).exists());
        std::fs::remove_dir_all(&tmp).unwrap();
        r.recovered = true;
        finish_recovery(&dir, &mut r);
        assert!(!recovering_path(&dir, scope).exists());
        assert_eq!(decode_file(&std::fs::read(file_for(&dir, scope)).unwrap()).unwrap(), rows);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// serde_json's RawValue token is an ordinary key on this path, whichever
    /// way it is spelled, so its string is never re-parsed.
    #[test]
    fn the_raw_value_token_stays_a_plain_key() {
        for text in [
            r#"{"x":{"$serde_json::private::RawValue":"[0]"}}"#,
            r#"{"x":{"\u0024serde_json::private::RawValue":"[0]"}}"#,
        ] {
            let (v, _) = parse_capped(text.as_bytes(), 1 << 20).unwrap();
            assert_eq!(v["x"]["$serde_json::private::RawValue"], json!("[0]"), "{text}");
        }
        // serde_json's own recursion limit holds on this path.
        assert!(parse_capped(nested(200).as_bytes(), 1 << 20).is_err());
        assert!(parse_capped(nested(100).as_bytes(), 1 << 20).is_ok());
    }

    /// A crafted envelope: nearly free to charge, because `ParseCost` skips
    /// strings, so its string must stay a string rather than expand.
    #[test]
    fn a_raw_value_envelope_allocates_no_expanded_nodes() {
        let inner = format!("[{}]", vec![r#"{"a":0}"#; 200_000].join(","));
        let token = serde_json::to_string(&inner).unwrap();
        let text = format!(
            r#"{{"v":1,"strings":[],"shapes":[],"rows":[],"x":{{"$serde_json::private::RawValue":{token}}}}}"#
        );
        let blob = envelope_of_text(&text);
        let (res, peak, _) = measured(move || cloud_decode(blob));
        assert!(res.unwrap().0.is_empty());
        // Expanded, 200k one-key objects would be well over 100 MiB.
        assert!(peak < 16 << 20, "peak {peak} for {} B of text", text.len());
    }

    /// `PlainValue` builds exactly what `Value` does for every honest document.
    #[test]
    fn parse_capped_matches_a_plain_value_parse() {
        let text = r#"{"a":[1,-2,3.25,1096.012,1e300,18446744073709551615,-9223372036854775808],
            "b":null,"c":true,"d":false,"e":"s\"\n\u00e9","f":{"":[],"g":{}},"h":[[],{}],"a2":0,"a2":1}"#;
        let (v, _) = parse_capped(text.as_bytes(), 1 << 20).unwrap();
        assert_eq!(v, serde_json::from_str::<Value>(text).unwrap());
        let rows = corpus(50);
        assert_eq!(decode_file(&encode_file(&rows).unwrap()).unwrap(), rows);
    }

    /// The answers built as text read back as what `json!` used to build.
    #[test]
    fn load_answers_are_plain_json() {
        let rows = corpus(3);
        let text = serde_json::to_string(&LoadAnswer {
            entries: &rows,
            existed: true,
            verified: false,
            want_legacy_local: true,
            recovered: true,
        })
        .unwrap();
        let answer = raw_answer(text).unwrap();
        assert!(matches!(answer, Answer::Raw(_)));
        let through = serde_json::to_string(&answer).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&through).unwrap(),
            json!({ "entries": rows, "existed": true, "verified": false, "want_legacy_local": true, "recovered": true }),
        );
    }

    #[test]
    fn a_scope_swap_writes_the_old_scope_or_refuses() {
        let dir = scratch("swap");
        let (a, b) = ("t-swap-a", "t-swap-b");
        let rows = vec![json!({"id":"x","played_at":"2026-11-01T00:00:00.000Z"})];
        // Snapshotted (saved_gen == gen) but never written: the state a
        // background write is in while it runs. The swap must not trust it.
        let mut ra = resident(a, rows.clone());
        ra.saved_gen = ra.gen;
        let mut st = Some(ra);
        let r = ensure_resident(&mut st, &dir, b).unwrap();
        assert_eq!(r.scope, b);
        assert_eq!(decode_file(&std::fs::read(file_for(&dir, a)).unwrap()).unwrap(), rows);
        // A write that cannot happen (the tmp path is a directory) keeps the
        // old scope resident and fails the call for the new one.
        let c = "t-swap-c";
        std::fs::create_dir_all(file_for(&dir, b).with_extension("gz.tmp")).unwrap();
        st.as_mut().unwrap().rows = rows.clone();
        st.as_mut().unwrap().gen = next_gen();
        assert!(ensure_resident(&mut st, &dir, c).is_err());
        let kept = st.as_ref().unwrap();
        assert_eq!((kept.scope.as_str(), kept.rows.len()), (b, 1));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A play recorded while the swap to its scope is refused reaches the rows,
    /// and the disk, once the swap goes through.
    #[test]
    fn an_append_during_a_refused_swap_is_kept() {
        let dir = scratch("parked");
        let (a, b) = ("t-parked-a", "t-parked-b");
        let row = json!({"id":"p","played_at":"2026-11-01T00:00:00.000Z"});
        let mut st = Some(resident(a, vec![json!({"id":"x","played_at":"2026-10-01T00:00:00.000Z"})]));
        let tmp = file_for(&dir, a).with_extension("gz.tmp");
        std::fs::create_dir_all(&tmp).unwrap(); // the write cannot happen
        assert!(ensure_resident(&mut st, &dir, b).is_err());
        assert_eq!(park_appends(b, vec![row.clone(), json!({"id":"","played_at":"nope"})]), 1);
        std::fs::remove_dir_all(&tmp).unwrap();
        let r = ensure_resident(&mut st, &dir, b).unwrap();
        assert_eq!(r.rows, vec![row.clone()]);
        assert_ne!(r.gen, r.saved_gen, "dirty, so it reaches the file");
        assert!(!r.existed, "the disk had no file: the load's rules still apply");
        assert!(r.recovered && recovering_path(&dir, b).exists());
        assert!(take_parked(b).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The Load failed on a refused swap, then a play is the first call to find
    /// no file. Its touch sets `existed`, so a latch left to the retried Load
    /// would never fire and the next push would replace the cloud copy.
    #[test]
    fn a_missing_file_latches_when_an_append_is_the_first_to_read_it() {
        let dir = scratch("missing-append");
        let (a, b) = ("t-missing-append-a", "t-missing-append-b");
        let mut st = Some(resident(a, vec![json!({"id":"x","played_at":"2026-10-01T00:00:00.000Z"})]));
        let tmp = file_for(&dir, a).with_extension("gz.tmp");
        std::fs::create_dir_all(&tmp).unwrap(); // the write cannot happen
        assert!(ensure_resident(&mut st, &dir, b).is_err());
        assert!(!recovering_path(&dir, b).exists(), "a refused swap read nothing");
        std::fs::remove_dir_all(&tmp).unwrap();
        let row = json!({"id":"p","played_at":"2026-11-01T00:00:00.000Z"});
        let r = ensure_resident(&mut st, &dir, b).unwrap();
        apply_append(&mut r.rows, vec![row.clone()]);
        touch(r);
        assert!(r.existed);
        assert!(r.recovered && recovering_path(&dir, b).exists());
        // What the retried Load reads, and a restart once the play is written.
        let existed = r.existed;
        latch_missing_file(&dir, r, existed);
        assert!(r.recovered);
        let mut map = HashMap::new();
        make_durable(&mut map, &dir, r).unwrap();
        let l = read_scope(&dir, b).unwrap();
        assert!(l.existed && l.recovered);
        assert_eq!(l.rows, vec![row.clone()]);
        // A scope with a file of its own does not latch, nor does a guest.
        let mut st = Some(resident(a, Vec::new()));
        let own = "t-missing-append-own";
        std::fs::write(file_for(&dir, own), encode_file(&[row]).unwrap()).unwrap();
        assert!(!ensure_resident(&mut st, &dir, own).unwrap().recovered);
        assert!(!recovering_path(&dir, own).exists());
        assert!(!ensure_resident(&mut st, &dir, GUEST_SCOPE).unwrap().recovered);
        assert!(!recovering_path(&dir, GUEST_SCOPE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A swap into an unreadable file keeps the parked rows with the appends
    /// made since, and writes nothing.
    #[test]
    fn parked_rows_follow_an_unreadable_file() {
        let dir = scratch("parked-unreadable");
        let scope = "t-parked-unreadable";
        let path = file_for(&dir, scope);
        std::fs::create_dir_all(&path).unwrap(); // a read of a directory fails
        let row = json!({"id":"p","played_at":"2026-11-01T00:00:00.000Z"});
        park_appends(scope, vec![row.clone()]);
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(r.unreadable);
        assert_eq!(r.rows, vec![row]);
        assert_eq!(r.gen, r.saved_gen, "nothing is written over an unread file");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Still parked at exit: unioned onto the scope's file.
    #[test]
    fn parked_rows_reach_the_file_at_exit() {
        let dir = scratch("parked-exit");
        let scope = "t-parked-exit";
        let old = json!({"id":"x","played_at":"2026-10-01T00:00:00.000Z"});
        let new = json!({"id":"p","played_at":"2026-11-01T00:00:00.000Z"});
        std::fs::write(file_for(&dir, scope), encode_file(&[old.clone()]).unwrap()).unwrap();
        let mut map = HashMap::new();
        write_parked_rows(&mut map, &dir, scope, vec![new.clone()]).unwrap();
        let rows = decode_file(&std::fs::read(file_for(&dir, scope)).unwrap()).unwrap();
        assert_eq!(rows, vec![new.clone(), old]);
        // Its own file: no latch.
        assert!(!recovering_path(&dir, scope).exists());
        // No file: the row lands, and the next launch must not trust the etag.
        let bare = "t-parked-exit-bare";
        write_parked_rows(&mut map, &dir, bare, vec![new.clone()]).unwrap();
        let l = read_scope(&dir, bare).unwrap();
        assert!(l.existed && l.recovered);
        assert_eq!(l.rows, vec![new.clone()]);
        // A guest has no cloud to wait for.
        write_parked_rows(&mut map, &dir, GUEST_SCOPE, vec![new]).unwrap();
        assert!(!recovering_path(&dir, GUEST_SCOPE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No file for a signed-in scope: the etag cannot be trusted, across a
    /// restart too, even once a play has created the file.
    #[test]
    fn a_missing_file_latches_until_a_cloud_merge() {
        let dir = scratch("missing-file");
        let scope = "t-missing-file";
        let mut st: Option<Resident> = None;
        let r = ensure_resident(&mut st, &dir, scope).unwrap();
        assert!(!r.existed && r.recovered);
        assert!(recovering_path(&dir, scope).exists());
        // Offline play, restart: the file exists, the marker still holds.
        let rows = vec![json!({"id":"p","played_at":"2026-11-01T00:00:00.000Z"})];
        std::fs::write(file_for(&dir, scope), encode_file(&rows).unwrap()).unwrap();
        let l = read_scope(&dir, scope).unwrap();
        assert!(l.recovered && l.existed);
        clear_recovering(&dir, scope);
        // A file of its own, no marker: nothing to latch.
        let l = read_scope(&dir, scope).unwrap();
        let mut r = resident(scope, l.rows);
        latch_missing_file(&dir, &mut r, l.existed);
        assert!(!r.recovered && !recovering_path(&dir, scope).exists());
        // A guest has no cloud to wait for.
        let mut g = resident(GUEST_SCOPE, Vec::new());
        latch_missing_file(&dir, &mut g, false);
        assert!(!g.recovered && !recovering_path(&dir, GUEST_SCOPE).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_mirrors_the_frontend() {
        let mut rows = vec![json!({"id":"a","played_at":"1"}), json!({"id":"b","played_at":"2"})];
        let added = apply_append(&mut rows, vec![
            json!({"id":"c","played_at":"3"}),
            json!({"id":"a","played_at":"1","x":1}),
            json!({"id":"d","played_at":"4"}),
            json!({"id":"c","played_at":"3","y":2}),
            json!({"id":"","played_at":"9"}),
        ]);
        assert_eq!(added, 2);
        assert_eq!(rows, vec![
            json!({"id":"d","played_at":"4"}),
            json!({"id":"c","played_at":"3","y":2}),
            json!({"id":"a","played_at":"1","x":1}),
            json!({"id":"b","played_at":"2"}),
        ]);
        assert_eq!(apply_remove(&mut rows, &[("c".into(), "3".into()), ("zz".into(), "1".into())]), 1);
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn cloud_merge_is_a_server_wins_union() {
        let mut rows = vec![json!({"id":"a","played_at":"2026-01-02"}), json!({"id":"b","played_at":"2026-01-01"})];
        let delta = apply_cloud_merge(&mut rows, vec![
            json!({"id":"b","played_at":"2026-01-01","poster":"p"}),
            json!({"id":"c","played_at":"2026-01-03"}),
            json!({"id":"c","played_at":"2026-01-03","dupe":true}),
        ]);
        assert_eq!(delta.replaced.len(), 1);
        assert_eq!(delta.added.len(), 1);
        assert_eq!(rows, vec![
            json!({"id":"c","played_at":"2026-01-03"}),
            json!({"id":"a","played_at":"2026-01-02"}),
            json!({"id":"b","played_at":"2026-01-01","poster":"p"}),
        ]);
        // Same server again: nothing changes.
        let delta = apply_cloud_merge(&mut rows.clone(), rows.clone());
        assert!(delta.added.is_empty() && delta.replaced.is_empty());
    }

    #[test]
    fn migration_union_is_idempotent() {
        let mut rows = vec![json!({"id":"new","played_at":"9"})];
        let carried = vec![json!({"id":"old","played_at":"1"}), json!({"id":"new","played_at":"9","stale":1})];
        assert_eq!(apply_union_keep_existing(&mut rows, carried.clone()), 1);
        assert_eq!(apply_union_keep_existing(&mut rows, carried), 0);
        assert_eq!(rows, vec![json!({"id":"new","played_at":"9"}), json!({"id":"old","played_at":"1"})]);
    }

    #[test]
    fn base64_round_trip() {
        for n in 0..10 {
            let data: Vec<u8> = (0..n * 7 + 1).map(|i| (i * 37 % 256) as u8).collect();
            assert_eq!(b64_decode(&b64_encode(&data)).unwrap(), data);
        }
        assert_eq!(b64_encode(b"Man"), "TWFu");
        assert_eq!(b64_encode(b"Ma"), "TWE=");
    }

    /// Measurement against a real backup (never committed). Run with
    /// `AURA_HISTORY_CORPUS=<backup.json> cargo test --lib history_store -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn measure_real_corpus() {
        let Ok(path) = std::env::var("AURA_HISTORY_CORPUS") else { return };
        let body: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let hist = body["payload"]["values"]["history"].as_str().unwrap();
        let base: Vec<Value> = serde_json::from_str(hist).unwrap();
        // Exact round trip of the real rows first.
        assert_eq!(decode_file(&encode_file(&base).unwrap()).unwrap(), base);
        for &n in &[base.len(), 10_000, 100_000] {
            // Synthesize n rows: every block of the real corpus becomes a new
            // set of TITLES (ids, names and art URLs suffixed per block) placed
            // further back in time, so the title table grows like a real
            // multi-year history instead of re-using 17 shows.
            let mut rows = Vec::with_capacity(n);
            let mut block = 0i64;
            'fill: loop {
                for e in &base {
                    if rows.len() == n { break 'fill; }
                    let mut e = e.clone();
                    if block > 0 {
                        let o = e.as_object_mut().unwrap();
                        for f in ["id", "parent_id", "name", "poster", "background"] {
                            if let Some(Value::String(s)) = o.get_mut(f) {
                                s.push_str(&format!("~b{block:04}x{:08x}", (block as u64).wrapping_mul(0x9E37_79B9) as u32));
                            }
                        }
                        if let Some(Value::String(p)) = o.get_mut("played_at") {
                            let ms = parse_iso_ms_exact(p).unwrap() - block * 60 * 86_400_000;
                            *p = format_iso_ms(ms).unwrap();
                        }
                    }
                    rows.push(e);
                }
                block += 1;
            }
            let plain = serde_json::to_vec(&rows).unwrap().len();
            let plain_gz = gzip(&serde_json::to_vec(&rows).unwrap()).unwrap().len();
            let compact = serde_json::to_vec(&encode_compact(rows.iter())).unwrap().len();
            let t = Instant::now();
            let file = encode_file(&rows).unwrap();
            let save_ms = t.elapsed().as_millis();
            let t = Instant::now();
            let back = decode_file(&file).unwrap();
            let load_ms = t.elapsed().as_millis();
            assert_eq!(back.len(), rows.len());
            let t = Instant::now();
            let (_, inc, total) = cloud_encode_rows(&rows, CLOUD_BUDGET_BYTES).unwrap();
            let cloud_ms = t.elapsed().as_millis();
            let ipc = serde_json::to_vec(&back).unwrap().len();
            println!(
                "n={n}: plain JSON {plain} B, plain gzip {plain_gz} B, compact {compact} B, FILE {} B; encode+gzip {save_ms} ms, inflate+decode {load_ms} ms; load IPC JSON {ipc} B; cloud {inc}/{total} rows in {cloud_ms} ms",
                file.len(),
            );
        }
    }
}

/// Allocation accounting for tests (this module and backup.rs). A
/// pass-through allocator that, on a thread that asked for it, tracks the
/// bytes live and their peak, so a test can hold the decode estimates to what
/// serde_json and the decode REALLY allocate. Thread-local, so tests running
/// beside each other do not mix. Test builds only: the shipped binary keeps
/// the system allocator untouched.
#[cfg(test)]
pub(crate) mod alloc_probe {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    struct Counting;

    thread_local! {
        static TRACK: Cell<bool> = const { Cell::new(false) };
        static LIVE: Cell<i64> = const { Cell::new(0) };
        static PEAK: Cell<i64> = const { Cell::new(0) };
    }

    fn note(delta: i64) {
        let _ = TRACK.try_with(|t| {
            if t.get() {
                let v = LIVE.with(|l| {
                    l.set(l.get() + delta);
                    l.get()
                });
                PEAK.with(|p| p.set(p.get().max(v)));
            }
        });
    }

    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let p = unsafe { System.alloc(l) };
            if !p.is_null() {
                note(l.size() as i64);
            }
            p
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            let p = unsafe { System.alloc_zeroed(l) };
            if !p.is_null() {
                note(l.size() as i64);
            }
            p
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            unsafe { System.dealloc(p, l) };
            note(-(l.size() as i64));
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
            let q = unsafe { System.realloc(p, l, new) };
            if !q.is_null() {
                note(new as i64 - l.size() as i64);
            }
            q
        }
    }

    #[global_allocator]
    static COUNTING: Counting = Counting;

    /// Runs `f` and returns its result with (peak, still live) bytes it
    /// allocated on this thread.
    pub(crate) fn measured<T>(f: impl FnOnce() -> T) -> (T, i64, i64) {
        LIVE.with(|l| l.set(0));
        PEAK.with(|p| p.set(0));
        TRACK.with(|t| t.set(true));
        let out = f();
        TRACK.with(|t| t.set(false));
        (out, PEAK.with(Cell::get), LIVE.with(Cell::get))
    }
}
