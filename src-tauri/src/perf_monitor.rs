// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! The Performance Monitor window's data source (`src/PerfMonitor.tsx`).
//!
//! One tagged command, `perf_monitor`, polled by the window about once a second
//! while it is open. Nothing here runs while it is closed: no thread, no timer,
//! no resident PDH query, and pdh.dll / dxgi.dll are only loaded on the first
//! sample (dynamically, so a user who never opens the window never loads them).
//!
//! WHAT IS MEASURED, and why it is not just "this process": mpv renders inside
//! aura.exe, but the interface is a tree of msedgewebview2.exe children and the
//! detector, subtitle sync and cast transcode run as ffmpeg children. So every
//! figure is summed over the process TREE rooted at this process.
//!
//! - CPU, memory, I/O: `NtQuerySystemInformation(SystemProcessInformation)`, one
//!   call that returns every process without opening any of them. Memory is the
//!   PRIVATE working set, the figure Task Manager's Memory column shows (plain
//!   working set counts each shared page once per process). I/O is the kernel's
//!   read + write transfer counters: files AND pipes, which is why the window
//!   calls it I/O and not disk. Windows has no per-process disk figure short of
//!   ETW, which needs elevation.
//! - GPU, video decode, VRAM: the `GPU Engine` and `GPU Process Memory` PDH
//!   counters. Collecting them is the slow part (tens of ms), so the command runs
//!   on the blocking pool. A machine without them reports `gpu: null`.
//! - Video: published by the mpv engine's own gated cache poll (`publish_video`,
//!   `note_drops`), NEVER by a get_property from here. A read landing in a seek
//!   crashes libmpv (CLAUDE.md landmine 3); the engine thread cannot race itself,
//!   and it already skips loads, seeks and the settle window after them.
//!
//! There is no per-process network counter without elevation either, so the
//! window's Network figure is what Aura can count itself: the playing stream
//! (mpv's input rate, from the same poll) plus the download manager.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Instant;

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum PerfMonitorAction {
    /// Read everything once. Rates are measured since the previous sample.
    Sample,
    /// The window closed: free the PDH query and the engine's extra read.
    Stop,
}

#[derive(Debug, Default, Clone, Copy, Serialize, PartialEq)]
pub struct ByGroup {
    /// aura.exe itself: the Rust host and mpv (decode, render, demuxer cache),
    /// plus the crash reporter, a second aura.exe, when crash reporting is on.
    pub core: f64,
    /// msedgewebview2.exe and its children.
    pub ui: f64,
    /// Everything else below Aura: ffmpeg, ffprobe, yt-dlp.
    pub helpers: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct GpuSample {
    /// The busiest engine, as Task Manager's GPU column reads it, 0-100.
    pub util: f64,
    /// The busiest video decode engine, 0-100.
    pub decode: f64,
    pub vram_used: f64,
    /// Dedicated memory of the adapter Aura uses most. Null when unknown.
    pub vram_total: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoSample {
    /// The video's own frame rate, from its frame timestamps (`estimated-vf-fps`).
    /// Not a presentation rate: the drop counts are the health signal. Null when
    /// mpv has none yet.
    pub fps: Option<f64>,
    /// Bytes per second mpv is reading from the source.
    pub stream_bps: Option<f64>,
    /// Seconds buffered ahead of the playhead.
    pub cache_secs: Option<f64>,
    /// How many seconds mpv is trying to buffer: the engine's live `cache-secs`.
    pub cache_target_secs: Option<f64>,
    /// Bytes held by the demuxer cache.
    pub cache_bytes: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PerfSample {
    /// % of the whole machine, so 100 means every core is busy.
    pub cpu: ByGroup,
    /// Whole-machine CPU %, so a stutter can be told apart from Aura's own load.
    pub system_cpu: Option<f64>,
    /// Private working set, bytes.
    pub mem: ByGroup,
    pub mem_total: f64,
    pub io_read_bps: f64,
    pub io_write_bps: f64,
    /// Processes in Aura's tree, itself included.
    pub processes: u32,
    pub gpu: Option<GpuSample>,
    /// False on the first sample after opening: there is no interval yet, so the
    /// rates (CPU, GPU utilisation, decode, I/O) are not measurements.
    pub primed: bool,
    /// A file is loaded, whether or not the engine's poll is reporting on it.
    pub media_loaded: bool,
    /// Null unless a file is loaded and the engine's poll is reporting.
    pub video: Option<VideoSample>,
    /// Since the last load or seek (mpv zeroes both on a seek). 0 when mpv has no
    /// counter, as with nothing loaded or an audio-only stream.
    pub drops_vo: i64,
    pub drops_decoder: i64,
}

// ---------------------------------------------------------------------------
// Published by the mpv engine thread
// ---------------------------------------------------------------------------

/// Set while the window is sampling: the engine does its one extra read only
/// then, so a closed window costs playback nothing.
static ACTIVE: AtomicBool = AtomicBool::new(false);
static VIDEO_FPS: AtomicU64 = AtomicU64::new(NO_VALUE);
static STREAM_BPS: AtomicU64 = AtomicU64::new(NO_VALUE);
static CACHE_SECS: AtomicU64 = AtomicU64::new(NO_VALUE);
static CACHE_TARGET_SECS: AtomicU64 = AtomicU64::new(NO_VALUE);
static CACHE_BYTES: AtomicU64 = AtomicU64::new(NO_VALUE);
/// `clock_ms()` of the last publish, 0 for never.
static VIDEO_AT: AtomicU64 = AtomicU64::new(0);
static DROPS_VO: AtomicI64 = AtomicI64::new(0);
static DROPS_DECODER: AtomicI64 = AtomicI64::new(0);

/// A NaN bit pattern no real reading produces: "no value".
const NO_VALUE: u64 = u64::MAX;
/// The poll runs every 500 ms, and stops during a seek or load. Past this the
/// figures are stale, and the window shows none rather than a frozen one.
const VIDEO_STALE_MS: u64 = 2500;

fn clock_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    // +1 so a publish in the first millisecond is not mistaken for "never".
    START.get_or_init(Instant::now).elapsed().as_millis() as u64 + 1
}

fn store(slot: &AtomicU64, v: Option<f64>) {
    let bits = v.filter(|x| x.is_finite() && *x >= 0.0).map_or(NO_VALUE, f64::to_bits);
    slot.store(bits, Ordering::Relaxed);
}

fn load(slot: &AtomicU64) -> Option<f64> {
    match slot.load(Ordering::Relaxed) {
        NO_VALUE => None,
        bits => Some(f64::from_bits(bits)),
    }
}

/// Should the engine read and publish its extra figures?
#[inline]
pub fn is_active() -> bool {
    ACTIVE.load(Ordering::Relaxed)
}

/// From the engine thread's gated cache poll.
pub fn publish_video(
    fps: Option<f64>,
    stream_bps: Option<f64>,
    cache_secs: Option<f64>,
    cache_target_secs: Option<f64>,
    cache_bytes: Option<f64>,
) {
    store(&VIDEO_FPS, fps);
    store(&STREAM_BPS, stream_bps);
    store(&CACHE_SECS, cache_secs);
    store(&CACHE_TARGET_SECS, cache_target_secs);
    store(&CACHE_BYTES, cache_bytes);
    VIDEO_AT.store(clock_ms(), Ordering::Relaxed);
}

/// From the engine's property events. Always on: it is one atomic store, on an
/// event mpv only fires when the count changes, and a window opened mid-file
/// should still read the current count. An unavailable counter (None) reads 0,
/// or the last file's drops would show as current.
pub fn note_drops(decoder: bool, count: Option<i64>) {
    let slot = if decoder { &DROPS_DECODER } else { &DROPS_VO };
    slot.store(count.unwrap_or(0), Ordering::Relaxed);
}

fn read_video() -> Option<VideoSample> {
    let at = VIDEO_AT.load(Ordering::Relaxed);
    if at == 0 || clock_ms().saturating_sub(at) > VIDEO_STALE_MS {
        return None;
    }
    Some(VideoSample {
        fps: load(&VIDEO_FPS),
        stream_bps: load(&STREAM_BPS),
        cache_secs: load(&CACHE_SECS),
        cache_target_secs: load(&CACHE_TARGET_SECS),
        cache_bytes: load(&CACHE_BYTES),
    })
}

// ---------------------------------------------------------------------------
// The process tree (pure, so it can be tested without a real process list)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
enum Group {
    Core,
    Ui,
    Helper,
}

#[derive(Debug, Clone)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct ProcRow {
    pid: usize,
    parent: usize,
    /// 100 ns FILETIME.
    create_time: i64,
    /// User + kernel, 100 ns.
    cpu_time: i64,
    private_ws: u64,
    io_read: i64,
    io_write: i64,
    /// Lowercase image name.
    name: String,
}

/// The rows at or below `root`. A process keeps the id of a parent that has
/// exited, and Windows reuses ids, so a "child" older than its supposed parent
/// belongs to an unrelated process that happens to hold a recycled id.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn tree_of(rows: &[ProcRow], root: usize) -> Vec<(usize, Group)> {
    let Some(root_row) = rows.iter().find(|r| r.pid == root) else {
        return Vec::new();
    };
    let mut out = vec![(root, Group::Core)];
    let mut frontier = vec![(root, root_row.create_time, Group::Core)];
    while let Some((pid, created, group)) = frontier.pop() {
        for r in rows {
            if r.parent != pid || r.pid == pid || r.create_time < created {
                continue;
            }
            if out.iter().any(|(seen, _)| *seen == r.pid) {
                continue;
            }
            // A WebView2 browser process's children are WebView2 whatever their
            // name, so the group is inherited once it has been entered. A child
            // running Aura's own image is the crash reporter, resident for the
            // whole session, not a helper that comes and goes.
            let g = if group == Group::Ui || r.name == "msedgewebview2.exe" {
                Group::Ui
            } else if group == Group::Core && r.name == root_row.name {
                Group::Core
            } else {
                Group::Helper
            };
            out.push((r.pid, g));
            frontier.push((r.pid, r.create_time, g));
        }
    }
    out
}

/// `pid_1234_luid_0x00000000_0x0000FD19_phys_0_eng_3_engtype_VideoDecode` ->
/// (1234, "0x00000000_0x0000FD19", "phys_0_eng_3", "VideoDecode"). The memory
/// counter's instances stop after `phys_0`, so the last two are optional.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_gpu_instance(name: &str) -> Option<(usize, &str, &str, &str)> {
    let rest = name.strip_prefix("pid_")?;
    let (pid, rest) = rest.split_once("_luid_")?;
    let pid = pid.parse().ok()?;
    let (luid, rest) = match rest.find("_phys_") {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    let (engine, engtype) = rest.split_once("_engtype_").unwrap_or((rest, ""));
    Some((pid, luid, engine, engtype))
}

/// Task Manager's reading of a GPU: sum the processes on each engine, then the
/// busiest engine is the figure. Summing across engines would call a card with
/// 3D and Copy both at 50% "100% busy". Returns (busiest, busiest decode).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn gpu_utilisation<'a>(rows: impl Iterator<Item = (&'a str, &'a str, &'a str, f64)>) -> (f64, f64) {
    let mut engines: Vec<(&str, &str, &str, f64)> = Vec::new();
    for (luid, engine, engtype, v) in rows {
        match engines.iter_mut().find(|e| e.0 == luid && e.1 == engine) {
            Some(e) => e.3 += v,
            None => engines.push((luid, engine, engtype, v)),
        }
    }
    let mut busiest = 0f64;
    let mut decode = 0f64;
    for (_, _, engtype, v) in &engines {
        busiest = busiest.max(*v);
        let t = engtype.to_ascii_lowercase();
        // NVIDIA and Intel say VideoDecode; other drivers name a shared codec
        // engine instead, which is still where a hardware decode runs.
        if t.contains("decode") || t.contains("codec") {
            decode = decode.max(*v);
        }
    }
    (busiest.min(100.0), decode.min(100.0))
}

// ---------------------------------------------------------------------------
// Windows sampling
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod sys {
    use super::*;
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::sync::Mutex;
    use windows::core::{s, w, Interface, PCSTR, PCWSTR};
    use windows::Win32::Foundation::{FreeLibrary, HMODULE};
    use windows::Win32::Graphics::Dxgi::IDXGIFactory1;
    use windows::Win32::System::LibraryLoader::{
        GetModuleHandleW, GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
    };
    use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

    const SYSTEM_PROCESS_INFORMATION_CLASS: u32 = 5;
    const STATUS_INFO_LENGTH_MISMATCH: i32 = 0xC000_0004u32 as i32;
    /// A runaway machine should not make this allocate without limit.
    const MAX_BUFFER: usize = 64 * 1024 * 1024;
    /// The window skips sampling while hidden. An interval longer than this spans
    /// such a stretch, and its average is not the current load: the sample only
    /// sets a new baseline.
    const MAX_INTERVAL_S: f64 = 5.0;

    /// Stable since Vista: it is the layout every process viewer reads, and the
    /// documented header in winternl.h only hides these fields behind Reserved.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct RawProcess {
        next_entry_offset: u32,
        number_of_threads: u32,
        working_set_private: i64,
        hard_fault_count: u32,
        threads_high_watermark: u32,
        cycle_time: u64,
        create_time: i64,
        user_time: i64,
        kernel_time: i64,
        image_name_length: u16,
        image_name_max: u16,
        image_name_buffer: *const u16,
        base_priority: i32,
        unique_process_id: usize,
        parent_process_id: usize,
        handle_count: u32,
        session_id: u32,
        unique_process_key: usize,
        peak_virtual: usize,
        virtual_size: usize,
        page_fault_count: u32,
        peak_working_set: usize,
        working_set: usize,
        quota_peak_paged: usize,
        quota_paged: usize,
        quota_peak_nonpaged: usize,
        quota_nonpaged: usize,
        pagefile: usize,
        peak_pagefile: usize,
        private_pages: usize,
        read_ops: i64,
        write_ops: i64,
        other_ops: i64,
        read_transfer: i64,
        write_transfer: i64,
        other_transfer: i64,
    }

    type NtQuerySystemInformationFn =
        unsafe extern "system" fn(u32, *mut c_void, u32, *mut u32) -> i32;

    /// Every process on the machine, plus the Idle process's CPU time (pid 0,
    /// whose "kernel time" is how long the cores sat idle).
    pub(super) fn read_processes(buf: &mut Vec<u8>) -> Option<(Vec<ProcRow>, i64)> {
        static NT_QUERY: OnceLock<Option<NtQuerySystemInformationFn>> = OnceLock::new();
        let query = (*NT_QUERY.get_or_init(|| unsafe {
            let ntdll = GetModuleHandleW(w!("ntdll.dll")).ok()?;
            let p = GetProcAddress(ntdll, s!("NtQuerySystemInformation"))?;
            Some(std::mem::transmute_copy::<_, NtQuerySystemInformationFn>(&p))
        }))?;

        loop {
            let mut needed = 0u32;
            let status = unsafe {
                query(
                    SYSTEM_PROCESS_INFORMATION_CLASS,
                    buf.as_mut_ptr().cast(),
                    buf.len() as u32,
                    &mut needed,
                )
            };
            if status == STATUS_INFO_LENGTH_MISMATCH {
                // Slack, since the list can grow between the two calls.
                let next = (needed as usize + 64 * 1024).max(buf.len() * 2);
                if next > MAX_BUFFER {
                    return None;
                }
                buf.resize(next, 0);
                continue;
            }
            if status < 0 {
                return None;
            }
            break;
        }

        let base = buf.as_ptr() as usize;
        let end = base + buf.len();
        let mut rows = Vec::with_capacity(512);
        let mut idle = 0i64;
        let mut at = base;
        loop {
            if at + std::mem::size_of::<RawProcess>() > end {
                break;
            }
            // SAFETY: bounds checked above; read_unaligned has no alignment need.
            let p = unsafe { std::ptr::read_unaligned(at as *const RawProcess) };
            let name_at = p.image_name_buffer as usize;
            let name_bytes = p.image_name_length as usize;
            // The name lives inside the same buffer. Checked, not assumed.
            let name = if name_bytes > 0 && name_at >= base && name_at + name_bytes <= end {
                let wide: Vec<u16> = buf[name_at - base..name_at - base + name_bytes]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                String::from_utf16_lossy(&wide).to_ascii_lowercase()
            } else {
                String::new()
            };
            if p.unique_process_id == 0 {
                idle = p.kernel_time;
            }
            rows.push(ProcRow {
                pid: p.unique_process_id,
                parent: p.parent_process_id,
                create_time: p.create_time,
                cpu_time: p.user_time.saturating_add(p.kernel_time),
                private_ws: p.working_set_private.max(0) as u64,
                io_read: p.read_transfer,
                io_write: p.write_transfer,
                name,
            });
            if p.next_entry_offset == 0 {
                break;
            }
            at += p.next_entry_offset as usize;
        }
        Some((rows, idle))
    }

    // ── PDH, loaded by hand ─────────────────────────────────────────────────

    const PDH_FMT_DOUBLE: u32 = 0x0000_0200;
    /// A GPU counter legitimately sums past 100 across processes before the
    /// engine-level clamp, and PDH would otherwise cap each one.
    const PDH_FMT_NOCAP100: u32 = 0x0000_8000;
    const PDH_MORE_DATA: u32 = 0x8000_07D2;
    const PDH_CSTATUS_VALID_DATA: u32 = 0;
    const PDH_CSTATUS_NEW_DATA: u32 = 1;
    const ERROR_SUCCESS: u32 = 0;

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct PdhItem {
        name: *const u16,
        status: u32,
        _pad: u32,
        value: f64,
    }

    type OpenQuery = unsafe extern "system" fn(PCWSTR, usize, *mut isize) -> u32;
    type AddCounter = unsafe extern "system" fn(isize, PCWSTR, usize, *mut isize) -> u32;
    type Collect = unsafe extern "system" fn(isize) -> u32;
    type GetArray = unsafe extern "system" fn(isize, u32, *mut u32, *mut u32, *mut PdhItem) -> u32;
    type CloseQuery = unsafe extern "system" fn(isize) -> u32;

    pub(super) struct Pdh {
        module: HMODULE,
        query: isize,
        engine: isize,
        memory: isize,
        collect: Collect,
        get_array: GetArray,
        close: CloseQuery,
        /// u64 for PDH's 8-byte fields; the rows and their names share it.
        items: Vec<u64>,
    }

    // SAFETY: the handles are process-wide and PDH serialises on them; every use
    // is behind the STATE mutex.
    unsafe impl Send for Pdh {}

    impl Drop for Pdh {
        fn drop(&mut self) {
            unsafe {
                (self.close)(self.query);
                let _ = FreeLibrary(self.module);
            }
        }
    }

    unsafe fn sym<T: Copy>(module: HMODULE, name: PCSTR) -> Option<T> {
        let p = GetProcAddress(module, name)?;
        Some(std::mem::transmute_copy(&p))
    }

    impl Pdh {
        pub(super) fn open() -> Option<Pdh> {
            unsafe {
                let module =
                    LoadLibraryExW(w!("pdh.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32).ok()?;
                let open = || -> Option<Pdh> {
                    let open_query: OpenQuery = sym(module, s!("PdhOpenQueryW"))?;
                    let add: AddCounter = sym(module, s!("PdhAddEnglishCounterW"))?;
                    let collect: Collect = sym(module, s!("PdhCollectQueryData"))?;
                    let get_array: GetArray = sym(module, s!("PdhGetFormattedCounterArrayW"))?;
                    let close: CloseQuery = sym(module, s!("PdhCloseQuery"))?;
                    let mut query = 0isize;
                    if open_query(PCWSTR::null(), 0, &mut query) != ERROR_SUCCESS {
                        return None;
                    }
                    let (mut engine, mut memory) = (0isize, 0isize);
                    let a = add(query, w!("\\GPU Engine(*)\\Utilization Percentage"), 0, &mut engine);
                    let b = add(query, w!("\\GPU Process Memory(*)\\Dedicated Usage"), 0, &mut memory);
                    if a != ERROR_SUCCESS || b != ERROR_SUCCESS {
                        close(query);
                        return None;
                    }
                    Some(Pdh { module, query, engine, memory, collect, get_array, close, items: Vec::new() })
                };
                let pdh = open();
                if pdh.is_none() {
                    let _ = FreeLibrary(module);
                }
                pdh
            }
        }

        /// Calls `f(instance name, value)` for each valid row of `counter`.
        fn read(&mut self, counter: isize, mut f: impl FnMut(&str, f64)) {
            let (mut size, mut count) = (0u32, 0u32);
            let fmt = PDH_FMT_DOUBLE | PDH_FMT_NOCAP100;
            let first = unsafe {
                (self.get_array)(counter, fmt, &mut size, &mut count, std::ptr::null_mut())
            };
            if first != PDH_MORE_DATA || size == 0 {
                return;
            }
            let words = (size as usize).div_ceil(8);
            if self.items.len() < words {
                self.items.resize(words, 0);
            }
            let status = unsafe {
                (self.get_array)(counter, fmt, &mut size, &mut count, self.items.as_mut_ptr().cast())
            };
            if status != ERROR_SUCCESS {
                return;
            }
            let base = self.items.as_ptr();
            let mut name = String::new();
            for i in 0..count as usize {
                // SAFETY: PDH wrote `count` items at the head of a buffer of the
                // size it asked for. Names point later into that same buffer.
                let item = unsafe { *(base as *const PdhItem).add(i) };
                if item.status != PDH_CSTATUS_VALID_DATA && item.status != PDH_CSTATUS_NEW_DATA {
                    continue;
                }
                name.clear();
                let mut p = item.name;
                if p.is_null() {
                    continue;
                }
                unsafe {
                    while *p != 0 && name.len() < 256 {
                        // Instance names are plain ASCII.
                        name.push(char::from_u32(*p as u32).unwrap_or('?'));
                        p = p.add(1);
                    }
                }
                f(&name, item.value);
            }
        }

        /// (busiest engine %, busiest decode %, VRAM used, that adapter's luid)
        pub(super) fn sample(
            &mut self,
            is_ours: impl Fn(usize) -> bool,
        ) -> Option<(f64, f64, f64, Option<String>)> {
            if unsafe { (self.collect)(self.query) } != ERROR_SUCCESS {
                return None;
            }
            let mut engines: Vec<(String, String, String, f64)> = Vec::new();
            let engine = self.engine;
            self.read(engine, |name, v| {
                if let Some((pid, luid, eng, ty)) = parse_gpu_instance(name) {
                    if is_ours(pid) {
                        engines.push((luid.to_owned(), eng.to_owned(), ty.to_owned(), v));
                    }
                }
            });
            let (util, decode) = gpu_utilisation(
                engines.iter().map(|(l, e, t, v)| (l.as_str(), e.as_str(), t.as_str(), *v)),
            );
            let mut by_luid: HashMap<String, f64> = HashMap::new();
            let memory = self.memory;
            self.read(memory, |name, v| {
                if let Some((pid, luid, _, _)) = parse_gpu_instance(name) {
                    if is_ours(pid) {
                        *by_luid.entry(luid.to_owned()).or_default() += v;
                    }
                }
            });
            let top = by_luid.into_iter().max_by(|a, b| a.1.total_cmp(&b.1));
            let (luid, used) = top.map_or((None, 0.0), |(l, v)| (Some(l), v));
            Some((util, decode, used, luid))
        }
    }

    // ── Adapter memory ──────────────────────────────────────────────────────

    /// `0x00000000_0x0000FD19` (high_low, as PDH prints a LUID) -> dedicated bytes.
    /// Read once: a card does not change its memory while Aura runs, and loading
    /// dxgi.dll by hand keeps it out of the import table of a run that never opens
    /// the window.
    pub(super) fn adapter_memory(luid: &str) -> Option<f64> {
        static ADAPTERS: OnceLock<Vec<(String, f64)>> = OnceLock::new();
        let list = ADAPTERS.get_or_init(|| unsafe {
            type CreateFactory = unsafe extern "system" fn(*const windows::core::GUID, *mut *mut c_void) -> windows::core::HRESULT;
            let mut out = Vec::new();
            let Ok(module) = LoadLibraryExW(w!("dxgi.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) else {
                return out;
            };
            if let Some(create) = sym::<CreateFactory>(module, s!("CreateDXGIFactory1")) {
                let mut raw: *mut c_void = std::ptr::null_mut();
                if create(&IDXGIFactory1::IID, &mut raw).is_ok() && !raw.is_null() {
                    let factory = IDXGIFactory1::from_raw(raw);
                    let mut i = 0u32;
                    while let Ok(adapter) = factory.EnumAdapters1(i) {
                        i += 1;
                        if i > 16 {
                            break;
                        }
                        if let Ok(d) = adapter.GetDesc1() {
                            let key = format!(
                                "0x{:08X}_0x{:08X}",
                                d.AdapterLuid.HighPart as u32, d.AdapterLuid.LowPart,
                            );
                            out.push((key, d.DedicatedVideoMemory as f64));
                        }
                    }
                }
            }
            // Deliberately not freed: the factory's vtable lives in the module
            // and mpv's own d3d11 context keeps dxgi loaded anyway.
            out
        });
        list.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(luid))
            .map(|(_, v)| *v)
            .filter(|v| *v > 0.0)
    }

    /// Logical processors across every processor group. Idle and process CPU
    /// times cover all groups, while available_parallelism can stop at the
    /// current group's 64.
    pub(super) fn logical_processors() -> f64 {
        type GetActiveProcessorCount = unsafe extern "system" fn(u16) -> u32;
        const ALL_PROCESSOR_GROUPS: u16 = 0xFFFF;
        let all = unsafe {
            GetModuleHandleW(w!("kernel32.dll"))
                .ok()
                .and_then(|m| sym::<GetActiveProcessorCount>(m, s!("GetActiveProcessorCount")))
                .map_or(0, |count| count(ALL_PROCESSOR_GROUPS))
        };
        if all > 0 {
            all as f64
        } else {
            std::thread::available_parallelism().map_or(1.0, |n| n.get() as f64)
        }
    }

    pub(super) fn total_memory() -> f64 {
        let mut m = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        if unsafe { GlobalMemoryStatusEx(&mut m) }.is_ok() {
            m.ullTotalPhys as f64
        } else {
            0.0
        }
    }

    // ── One sample ──────────────────────────────────────────────────────────

    #[derive(Clone, Copy)]
    struct Prev {
        cpu_time: i64,
        io_read: i64,
        io_write: i64,
        create_time: i64,
    }

    pub(super) struct Sampler {
        buf: Vec<u8>,
        prev: HashMap<usize, Prev>,
        prev_idle: i64,
        prev_at: Option<Instant>,
        /// 100 ns FILETIME of the previous sample's newest process; a process
        /// created after it started during the interval.
        prev_newest: i64,
        pdh: Option<Pdh>,
        pdh_tried: bool,
        mem_total: f64,
        ncpu: f64,
    }

    impl Sampler {
        fn new() -> Self {
            Sampler {
                buf: vec![0; 512 * 1024],
                prev: HashMap::new(),
                prev_idle: 0,
                prev_at: None,
                prev_newest: 0,
                pdh: None,
                pdh_tried: false,
                mem_total: total_memory(),
                ncpu: logical_processors(),
            }
        }

        #[cfg(test)]
        pub(super) fn backdate_last_sample(&mut self, secs: u64) {
            self.prev_at = Instant::now().checked_sub(std::time::Duration::from_secs(secs));
        }

        pub(super) fn sample(&mut self, root: usize) -> Result<PerfSample, String> {
            let (rows, idle) =
                read_processes(&mut self.buf).ok_or("could not read the process list")?;
            let now = Instant::now();
            let elapsed = self
                .prev_at
                .map(|t| now.duration_since(t).as_secs_f64())
                .filter(|s| *s <= MAX_INTERVAL_S);
            let tree = tree_of(&rows, root);
            let groups: HashMap<usize, Group> = tree.iter().copied().collect();

            let mut cpu = ByGroup::default();
            let mut mem = ByGroup::default();
            let (mut io_read, mut io_write) = (0i64, 0i64);
            let mut next: HashMap<usize, Prev> = HashMap::with_capacity(tree.len());
            let mut newest = self.prev_newest;
            for r in rows.iter() {
                newest = newest.max(r.create_time);
                let Some(group) = groups.get(&r.pid).copied() else { continue };
                let prev = self.prev.get(&r.pid).filter(|p| p.create_time == r.create_time).copied();
                // A process new since the last sample: everything it has done so
                // far happened inside this interval. On the first sample there
                // is no interval, so nothing counts.
                let is_new = prev.is_none() && self.prev_at.is_some() && r.create_time > self.prev_newest;
                let since = |now: i64, then: fn(&Prev) -> i64| match prev.as_ref() {
                    Some(p) => (now - then(p)).max(0),
                    None if is_new => now,
                    None => 0,
                };
                let cpu_delta = since(r.cpu_time, |p| p.cpu_time);
                io_read = io_read.saturating_add(since(r.io_read, |p| p.io_read));
                io_write = io_write.saturating_add(since(r.io_write, |p| p.io_write));
                if let Some(secs) = elapsed.filter(|s| *s > 0.0) {
                    let pct = cpu_delta as f64 / (secs * 1e7 * self.ncpu) * 100.0;
                    match group {
                        Group::Core => cpu.core += pct,
                        Group::Ui => cpu.ui += pct,
                        Group::Helper => cpu.helpers += pct,
                    }
                }
                match group {
                    Group::Core => mem.core += r.private_ws as f64,
                    Group::Ui => mem.ui += r.private_ws as f64,
                    Group::Helper => mem.helpers += r.private_ws as f64,
                }
                next.insert(r.pid, Prev {
                    cpu_time: r.cpu_time,
                    io_read: r.io_read,
                    io_write: r.io_write,
                    create_time: r.create_time,
                });
            }
            let per_second = |bytes: i64| elapsed.filter(|s| *s > 0.0).map_or(0.0, |s| bytes as f64 / s);
            let io_read_bps = per_second(io_read);
            let io_write_bps = per_second(io_write);

            let system_cpu = elapsed.filter(|s| *s > 0.0).map(|s| {
                let idle_pct = (idle - self.prev_idle).max(0) as f64 / (s * 1e7 * self.ncpu) * 100.0;
                (100.0 - idle_pct).clamp(0.0, 100.0)
            });

            if !self.pdh_tried {
                self.pdh_tried = true;
                self.pdh = Pdh::open();
                if self.pdh.is_none() {
                    crate::devlog!(warn, "perf", "GPU counters unavailable: the window will show no GPU figures");
                }
            }
            let gpu = self.pdh.as_mut().and_then(|p| p.sample(|pid| groups.contains_key(&pid))).map(
                |(util, decode, vram_used, luid)| GpuSample {
                    util,
                    decode,
                    vram_used,
                    vram_total: luid.as_deref().and_then(adapter_memory),
                },
            );

            let processes = tree.len() as u32;
            let media_loaded = crate::window_logic::media_loaded();
            self.prev = next;
            self.prev_idle = idle;
            self.prev_newest = newest;
            self.prev_at = Some(now);

            Ok(PerfSample {
                cpu,
                system_cpu,
                mem,
                mem_total: self.mem_total,
                io_read_bps,
                io_write_bps,
                processes,
                gpu,
                primed: elapsed.is_some_and(|s| s > 0.0),
                media_loaded,
                video: read_video().filter(|_| media_loaded),
                drops_vo: DROPS_VO.load(Ordering::Relaxed),
                drops_decoder: DROPS_DECODER.load(Ordering::Relaxed),
            })
        }
    }

    static STATE: Mutex<Option<Sampler>> = Mutex::new(None);

    pub(super) fn sample_now() -> Result<PerfSample, String> {
        let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
        g.get_or_insert_with(Sampler::new).sample(std::process::id() as usize)
    }

    pub(super) fn drop_state() {
        let mut g = STATE.lock().unwrap_or_else(|e| e.into_inner());
        *g = None;
    }

    #[cfg(test)]
    pub(super) fn fresh_sampler() -> Sampler {
        Sampler::new()
    }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// Release everything the window was holding. Also called for a page reload,
/// when no window is left to say so.
pub fn stop() {
    ACTIVE.store(false, Ordering::Relaxed);
    #[cfg(target_os = "windows")]
    sys::drop_state();
}

#[tauri::command]
pub async fn perf_monitor(action: PerfMonitorAction) -> Result<Option<PerfSample>, String> {
    // Blocking pool: the GPU counters take tens of ms to collect, and the command
    // must never sit on a runtime thread the bridge or the addon fan-out needs.
    tauri::async_runtime::spawn_blocking(move || match action {
        PerfMonitorAction::Stop => {
            stop();
            Ok(None)
        }
        PerfMonitorAction::Sample => {
            ACTIVE.store(true, Ordering::Relaxed);
            #[cfg(target_os = "windows")]
            {
                sys::sample_now().map(Some)
            }
            #[cfg(not(target_os = "windows"))]
            {
                Err("The performance monitor is only available on Windows".to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: usize, parent: usize, create_time: i64, name: &str) -> ProcRow {
        ProcRow {
            pid,
            parent,
            create_time,
            cpu_time: 0,
            private_ws: 0,
            io_read: 0,
            io_write: 0,
            name: name.into(),
        }
    }

    #[test]
    fn tree_groups_the_webview_and_its_children_as_ui() {
        let rows = vec![
            row(1, 0, 1, "explorer.exe"),
            row(10, 1, 5, "aura.exe"),
            row(11, 10, 6, "msedgewebview2.exe"),
            row(12, 11, 7, "msedgewebview2.exe"),
            row(13, 12, 8, "crashpad.exe"),
            row(14, 10, 9, "ffmpeg.exe"),
            row(15, 14, 10, "conhost.exe"),
            row(20, 1, 11, "notepad.exe"),
        ];
        let mut got = tree_of(&rows, 10);
        got.sort_by_key(|(p, _)| *p);
        assert_eq!(
            got,
            vec![
                (10, Group::Core),
                (11, Group::Ui),
                (12, Group::Ui),
                (13, Group::Ui),
                (14, Group::Helper),
                (15, Group::Helper),
            ]
        );
    }

    #[test]
    fn the_crash_reporter_is_core_but_not_under_a_helper() {
        let rows = vec![
            row(10, 1, 5, "aura.exe"),
            row(16, 10, 6, "aura.exe"),
            row(17, 10, 7, "ffmpeg.exe"),
            // Under a helper the same name is not the reporter.
            row(18, 17, 8, "aura.exe"),
        ];
        let mut got = tree_of(&rows, 10);
        got.sort_by_key(|(p, _)| *p);
        assert_eq!(
            got,
            vec![
                (10, Group::Core),
                (16, Group::Core),
                (17, Group::Helper),
                (18, Group::Helper),
            ]
        );
    }

    #[test]
    fn a_recycled_parent_id_does_not_adopt_an_older_process() {
        // Pid 10 exited, a long-running process kept it as its parent id, and
        // Windows then gave the id to Aura. It is not Aura's child.
        let rows = vec![row(10, 1, 100, "aura.exe"), row(30, 10, 50, "someoneelse.exe")];
        assert_eq!(tree_of(&rows, 10), vec![(10, Group::Core)]);
    }

    #[test]
    fn a_parent_id_cycle_terminates() {
        let rows = vec![row(10, 11, 5, "aura.exe"), row(11, 10, 5, "x.exe")];
        assert_eq!(tree_of(&rows, 10).len(), 2);
    }

    #[test]
    fn a_missing_root_is_an_empty_tree() {
        assert!(tree_of(&[row(1, 0, 1, "x.exe")], 99).is_empty());
    }

    #[test]
    fn gpu_instance_names_parse() {
        assert_eq!(
            parse_gpu_instance("pid_1234_luid_0x00000000_0x0000FD19_phys_0_eng_3_engtype_VideoDecode"),
            Some((1234, "0x00000000_0x0000FD19", "phys_0_eng_3", "VideoDecode")),
        );
        assert_eq!(
            parse_gpu_instance("pid_55_luid_0x00000000_0x0000FD19_phys_0"),
            Some((55, "0x00000000_0x0000FD19", "phys_0", "")),
        );
        assert_eq!(parse_gpu_instance("_Total"), None);
        assert_eq!(parse_gpu_instance("pid_x_luid_1"), None);
    }

    #[test]
    fn gpu_utilisation_is_the_busiest_engine_summed_over_processes() {
        let rows = vec![
            // Two processes on one 3D engine add up...
            ("a", "phys_0_eng_0", "3D", 30.0),
            ("a", "phys_0_eng_0", "3D", 25.0),
            // ...and a second engine does not add to it.
            ("a", "phys_0_eng_1", "Copy", 40.0),
            ("a", "phys_0_eng_3", "VideoDecode", 12.0),
        ];
        assert_eq!(gpu_utilisation(rows.into_iter()), (55.0, 12.0));
        assert_eq!(
            gpu_utilisation(vec![("a", "e", "3D", 180.0)].into_iter()),
            (100.0, 0.0),
        );
    }

    #[test]
    fn a_stale_publish_reads_as_no_video() {
        VIDEO_AT.store(0, Ordering::Relaxed);
        assert!(read_video().is_none());
        publish_video(Some(23.976), Some(1e6), Some(12.0), Some(30.0), None);
        let v = read_video().expect("just published");
        assert_eq!(v.fps, Some(23.976));
        assert_eq!(v.cache_target_secs, Some(30.0));
        assert_eq!(v.cache_bytes, None);
        store(&VIDEO_FPS, Some(f64::NAN));
        assert_eq!(load(&VIDEO_FPS), None);
    }

    #[test]
    fn an_unavailable_drop_counter_reads_zero() {
        note_drops(false, Some(50));
        note_drops(true, Some(7));
        assert_eq!(DROPS_VO.load(Ordering::Relaxed), 50);
        assert_eq!(DROPS_DECODER.load(Ordering::Relaxed), 7);
        note_drops(false, None);
        note_drops(true, None);
        assert_eq!(DROPS_VO.load(Ordering::Relaxed), 0);
        assert_eq!(DROPS_DECODER.load(Ordering::Relaxed), 0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_first_sample_is_not_primed() {
        let mut s = sys::fresh_sampler();
        let root = std::process::id() as usize;
        assert!(!s.sample(root).expect("first").primed);
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(s.sample(root).expect("second").primed);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn a_sample_after_a_hidden_stretch_is_a_new_baseline() {
        let mut s = sys::fresh_sampler();
        let root = std::process::id() as usize;
        s.sample(root).expect("first");
        s.backdate_last_sample(600);
        let after = s.sample(root).expect("after the stretch");
        assert!(!after.primed);
        assert_eq!(after.system_cpu, None);
        assert_eq!(after.io_read_bps, 0.0);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let next = s.sample(root).expect("next");
        assert!(next.primed);
        assert!(next.system_cpu.is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn the_processor_count_covers_at_least_this_group() {
        let here = std::thread::available_parallelism().unwrap().get() as f64;
        assert!(sys::logical_processors() >= here);
    }

    /// Against the real machine: a child that burns one core must show up as
    /// roughly one core's share under Helpers, and the tree's memory must be
    /// plausible. `cargo test --lib perf_monitor -- --ignored --nocapture`
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore]
    fn live_sample_sees_a_busy_child() {
        let mut child = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", "while($true){$x=[math]::Sqrt(2)}"])
            .spawn()
            .expect("spawn");
        let mut s = sys::fresh_sampler();
        let root = std::process::id() as usize;
        let t0 = Instant::now();
        s.sample(root).expect("first");
        std::thread::sleep(std::time::Duration::from_secs(1));
        let mut last = None;
        for _ in 0..4 {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            let a = Instant::now();
            let got = s.sample(root).expect("sample");
            println!("sample took {:?}: {got:#?}", a.elapsed());
            last = Some(got);
        }
        let _ = child.kill();
        let got = last.unwrap();

        // The GPU counters' adapter ids must be spelled the way adapter_memory
        // keys them, or VRAM has no total. Any process on the machine will do.
        let mut pdh = sys::Pdh::open().expect("GPU counters");
        pdh.sample(|_| true);
        std::thread::sleep(std::time::Duration::from_secs(1));
        let (util, decode, used, luid) = pdh.sample(|_| true).expect("gpu sample");
        let luid = luid.expect("some process has GPU memory");
        let total = sys::adapter_memory(&luid);
        println!("machine gpu {util:.1}% decode {decode:.1}% used {used} on {luid}, total {total:?}");
        assert!(total.is_some(), "no adapter matches {luid}");

        let one_core = 100.0 / sys::logical_processors();
        println!("elapsed {:?}, one core = {one_core:.1}%", t0.elapsed());
        assert!(got.processes >= 2, "child not found in the tree");
        assert!(
            got.cpu.helpers > one_core * 0.5 && got.cpu.helpers < one_core * 1.5,
            "helpers cpu {} vs one core {one_core}",
            got.cpu.helpers,
        );
        assert!(got.mem.core > 1e6 && got.mem.helpers > 1e6);
        assert!(got.cpu.core + got.cpu.ui + got.cpu.helpers < 100.0);
        assert!(got.mem_total > 1e9);
        assert!(got.system_cpu.is_some());
    }
}
