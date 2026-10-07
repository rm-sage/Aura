// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/cache.rs
//
// skipdetect's three disk caches, all under `app_data_dir()`, all bounded,
// all written atomically (sibling `.tmp`, fsync, rename), all evicted oldest
// first:
//
//   animethemes-v1.json  MAL id -> AnimeThemes theme list. Hits 7 d, misses
//                        (the API answered with nothing) 1 d, network errors
//                        never cached. Cap 300 ids.
//   theme-fp/<id>.bin    one theme's fingerprint (codes + valid mask + length
//                        + audible lead / trail), keyed by AnimeThemes audio
//                        id. 90 d, cap 400 files (~10 KB each). The audio
//                        itself is never stored.
//   skipdetect-v1.json   final per-file result keyed by a SHA-256 of (Stremio
//                        id, release identity, duration rounded to 0.1 s).
//                        30 d, cap 2000; a result with no window only 24 h,
//                        and so is a Layer 3 window that stood in for a
//                        theme-list miss. An entry records the kinds and MAL
//                        id it was computed for and answers only requests it
//                        covers (job.rs `cached_serves`).
//                        This cache is the only fix for slow links.
//
// The JSON caches are read and rewritten per detect (a few hundred KB at
// most) rather than mirrored in memory, so `clear_all` (Settings > Storage)
// can never be undone by a stale in-memory copy written back later. One
// process-wide lock serialises every read-modify-write.
//
// None of this is user data: it is not part of a user backup (backup.rs only
// frames the frontend's payload), it is not cloud-synced, and it holds no URL
// of the playing stream (theme lists carry AnimeThemes' own public audio
// links; result keys are hashes).

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::fingerprint::Fingerprint;

pub const THEME_LIST_FILE: &str = "animethemes-v1.json";
pub const THEME_FP_DIR: &str = "theme-fp";
pub const RESULT_FILE: &str = "skipdetect-v1.json";

const DAY: u64 = 24 * 60 * 60;
pub const THEME_LIST_HIT_TTL: u64 = 7 * DAY;
pub const THEME_LIST_MISS_TTL: u64 = DAY;
pub const THEME_LIST_CAP: usize = 300;
pub const THEME_FP_TTL: u64 = 90 * DAY;
pub const THEME_FP_CAP: usize = 400;
pub const RESULT_TTL: u64 = 30 * DAY;
pub const RESULT_ABSTAIN_TTL: u64 = DAY;
pub const RESULT_CAP: usize = 2000;

/// Serialises every cache read-modify-write in the process.
static LOCK: Mutex<()> = Mutex::new(());

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Write `bytes` to `path` atomically: a sibling `.tmp`, fsync, rename.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let written = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    })();
    // A failed write (disk full, a scanner holding the file) must not leave a
    // stray `.tmp` behind: nothing would ever clean it up.
    written.and_then(|()| std::fs::rename(&tmp, path)).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

// ── generic TTL map file ────────────────────────────────────────────────────

#[derive(Serialize, Deserialize)]
struct Entry<T> {
    saved_at: u64,
    /// Seconds this entry lives (hit and miss TTLs differ).
    ttl: u64,
    value: T,
}

fn load_map<T: DeserializeOwned>(path: &Path) -> HashMap<String, Entry<T>> {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<HashMap<String, Entry<T>>>(&b).ok())
        .unwrap_or_default()
}

fn get_entry<T: DeserializeOwned>(path: &Path, key: &str, now: u64) -> Option<T> {
    let _g = LOCK.lock().ok()?;
    let mut map = load_map::<T>(path);
    let e = map.remove(key)?;
    (now.saturating_sub(e.saved_at) < e.ttl).then_some(e.value)
}

fn put_entry<T: Serialize + DeserializeOwned>(path: &Path, key: &str, value: T, ttl: u64, cap: usize, now: u64) {
    let Ok(_g) = LOCK.lock() else { return };
    let mut map = load_map::<T>(path);
    map.retain(|_, e| now.saturating_sub(e.saved_at) < e.ttl);
    map.insert(key.to_string(), Entry { saved_at: now, ttl, value });
    if map.len() > cap {
        let mut by_age: Vec<(String, u64)> = map.iter().map(|(k, e)| (k.clone(), e.saved_at)).collect();
        by_age.sort_by_key(|(_, t)| *t);
        let excess = map.len() - cap;
        for (k, _) in by_age.into_iter().take(excess) {
            map.remove(&k);
        }
    }
    if let Ok(bytes) = serde_json::to_vec(&map) {
        let _ = write_atomic(path, &bytes);
    }
}

// ── theme lists ─────────────────────────────────────────────────────────────

/// A cached theme list. `None` = the API answered with no usable theme.
pub fn get_theme_list<T: DeserializeOwned>(dir: &Path, mal: u32) -> Option<Option<T>> {
    get_entry::<Option<T>>(&dir.join(THEME_LIST_FILE), &mal.to_string(), now_secs())
}

pub fn put_theme_list<T: Serialize + DeserializeOwned>(dir: &Path, mal: u32, list: Option<T>) {
    let ttl = if list.is_some() { THEME_LIST_HIT_TTL } else { THEME_LIST_MISS_TTL };
    put_entry(&dir.join(THEME_LIST_FILE), &mal.to_string(), list, ttl, THEME_LIST_CAP, now_secs());
}

// ── results ─────────────────────────────────────────────────────────────────

/// Result-cache key: SHA-256 of (Stremio id, release identity, duration to
/// 0.1 s). Hashed so no filename or path segment is stored in clear.
pub fn result_key(stremio_id: &str, release: &str, duration: f64) -> String {
    let mut h = Sha256::new();
    h.update(stremio_id.as_bytes());
    h.update([0u8]);
    h.update(release.as_bytes());
    h.update([0u8]);
    h.update(format!("{:.1}", duration).as_bytes());
    hex::encode(&h.finalize()[..16])
}

pub fn get_result<T: DeserializeOwned>(dir: &Path, key: &str) -> Option<T> {
    get_entry::<T>(&dir.join(RESULT_FILE), key, now_secs())
}

/// `ttl` in seconds, chosen by the job (`job::result_ttl`): `RESULT_TTL` for
/// a result holding a window, `RESULT_ABSTAIN_TTL` for an abstention, and no
/// longer than the theme-list answer for a Layer 3 window standing in for a
/// theme AnimeThemes does not list. Capped at `RESULT_TTL`.
pub fn put_result<T: Serialize + DeserializeOwned>(dir: &Path, key: &str, value: T, ttl: u64) {
    put_entry(&dir.join(RESULT_FILE), key, value, ttl.min(RESULT_TTL), RESULT_CAP, now_secs());
}

// ── theme fingerprints ──────────────────────────────────────────────────────

const FP_MAGIC: &[u8; 8] = b"AURAFP01";
const FP_HEADER: usize = 8 + 8 + 8 + 8 + 8 + 8 + 8 + 4;
/// No theme has more codes than 10 minutes of audio.
const FP_MAX_CODES: usize = 600 * 22;

/// One theme's fingerprint and the facts Layer 1 needs about it.
#[derive(Clone, Debug, PartialEq)]
pub struct ThemeFp {
    pub audio_id: u64,
    /// The AnimeThemes file size it was computed from (0 = unknown); a
    /// replaced file under the same id is refetched.
    pub size: u64,
    /// Decoded 11025 Hz samples.
    pub samples: u64,
    /// Audible lead / trail (s), `theme_audible`.
    pub audible: (f64, f64),
    /// Codes from t = 0.
    pub fp: Fingerprint,
}

fn fp_path(dir: &Path, audio_id: u64) -> PathBuf {
    dir.join(THEME_FP_DIR).join(format!("{audio_id}.bin"))
}

pub fn encode_fp(t: &ThemeFp, written_at: u64) -> Vec<u8> {
    let n = t.fp.codes.len();
    let mut b = Vec::with_capacity(FP_HEADER + n * 4 + n.div_ceil(8));
    b.extend_from_slice(FP_MAGIC);
    b.extend_from_slice(&written_at.to_le_bytes());
    b.extend_from_slice(&t.audio_id.to_le_bytes());
    b.extend_from_slice(&t.size.to_le_bytes());
    b.extend_from_slice(&t.samples.to_le_bytes());
    b.extend_from_slice(&t.audible.0.to_le_bytes());
    b.extend_from_slice(&t.audible.1.to_le_bytes());
    b.extend_from_slice(&(n as u32).to_le_bytes());
    for c in &t.fp.codes {
        b.extend_from_slice(&c.to_le_bytes());
    }
    let mut packed = vec![0u8; n.div_ceil(8)];
    for (i, &v) in t.fp.valid.iter().enumerate() {
        if v {
            packed[i / 8] |= 1 << (i % 8);
        }
    }
    b.extend_from_slice(&packed);
    b
}

/// Decode a fingerprint file: `(written_at, ThemeFp)`, or None when malformed.
pub fn decode_fp(b: &[u8]) -> Option<(u64, ThemeFp)> {
    if b.len() < FP_HEADER || &b[..8] != FP_MAGIC {
        return None;
    }
    let u64_at = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let f64_at = |o: usize| f64::from_le_bytes(b[o..o + 8].try_into().unwrap());
    let written_at = u64_at(8);
    let audio_id = u64_at(16);
    let size = u64_at(24);
    let samples = u64_at(32);
    let audible = (f64_at(40), f64_at(48));
    let n = u32::from_le_bytes(b[56..60].try_into().unwrap()) as usize;
    if n > FP_MAX_CODES || b.len() != FP_HEADER + n * 4 + n.div_ceil(8) {
        return None;
    }
    if !(audible.0.is_finite() && audible.1.is_finite()) {
        return None;
    }
    let codes: Vec<u32> = b[FP_HEADER..FP_HEADER + n * 4]
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let packed = &b[FP_HEADER + n * 4..];
    let valid: Vec<bool> = (0..n).map(|i| packed[i / 8] & (1 << (i % 8)) != 0).collect();
    Some((written_at, ThemeFp { audio_id, size, samples, audible, fp: Fingerprint { codes, valid, t0: 0.0 } }))
}

/// A cached theme fingerprint, when present, fresh, and computed from a file
/// of `size` bytes (0 skips the size check).
pub fn get_theme_fp(dir: &Path, audio_id: u64, size: u64) -> Option<ThemeFp> {
    let p = fp_path(dir, audio_id);
    let b = std::fs::read(&p).ok()?;
    match decode_fp(&b) {
        Some((at, t))
            if t.audio_id == audio_id
                && now_secs().saturating_sub(at) < THEME_FP_TTL
                && (size == 0 || t.size == 0 || t.size == size) =>
        {
            Some(t)
        }
        _ => {
            let _ = std::fs::remove_file(&p);
            None
        }
    }
}

/// Store a theme fingerprint, then trim the directory to `THEME_FP_CAP`
/// files (oldest modification first).
pub fn put_theme_fp(dir: &Path, t: &ThemeFp) {
    let Ok(_g) = LOCK.lock() else { return };
    let p = fp_path(dir, t.audio_id);
    if write_atomic(&p, &encode_fp(t, now_secs())).is_err() {
        return;
    }
    trim_dir(&dir.join(THEME_FP_DIR), THEME_FP_CAP);
}

fn trim_dir(d: &Path, cap: usize) {
    let Ok(rd) = std::fs::read_dir(d) else { return };
    let mut files: Vec<(PathBuf, SystemTime)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "bin"))
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .collect();
    if files.len() <= cap {
        return;
    }
    files.sort_by_key(|(_, m)| *m);
    let excess = files.len() - cap;
    for (p, _) in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(p);
    }
}

// ── Settings > Storage ──────────────────────────────────────────────────────

/// Bytes on disk across every skipdetect cache.
pub fn total_bytes(dir: &Path) -> u64 {
    let file = |n: &str| std::fs::metadata(dir.join(n)).map(|m| m.len()).unwrap_or(0);
    let fps = std::fs::read_dir(dir.join(THEME_FP_DIR))
        .map(|rd| rd.filter_map(|e| e.ok()?.metadata().ok()).map(|m| m.len()).sum())
        .unwrap_or(0);
    file(THEME_LIST_FILE) + file(RESULT_FILE) + fps
}

/// Delete every skipdetect cache. Missing files are not an error.
pub fn clear_all(dir: &Path) -> std::io::Result<()> {
    let _g = LOCK.lock().map_err(|_| std::io::Error::other("cache lock poisoned"))?;
    for f in [THEME_LIST_FILE, RESULT_FILE] {
        match std::fs::remove_file(dir.join(f)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    match std::fs::remove_dir_all(dir.join(THEME_FP_DIR)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        // A per-process counter as well as the clock: two tests running in
        // parallel can read the same timestamp on Windows, share one folder,
        // and the cap test's eviction then deletes the other test's files.
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "aura-skipdetect-cache-test-{}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn theme(id: u64, n: usize) -> ThemeFp {
        ThemeFp {
            audio_id: id,
            size: 2_114_859,
            samples: 991_297,
            audible: (0.5, 89.3),
            fp: Fingerprint {
                codes: (0..n as u32).map(|i| i.wrapping_mul(2_654_435_761)).collect(),
                valid: (0..n).map(|i| i % 3 != 0).collect(),
                t0: 0.0,
            },
        }
    }

    #[test]
    fn fp_round_trip_and_rejects_garbage() {
        let t = theme(13533, 1937);
        let b = encode_fp(&t, 42);
        let (at, back) = decode_fp(&b).unwrap();
        assert_eq!(at, 42);
        assert_eq!(back, t);
        assert!(decode_fp(&b[..b.len() - 1]).is_none());
        let mut bad = b.clone();
        bad[0] = b'X';
        assert!(decode_fp(&bad).is_none());
        assert!(decode_fp(&[]).is_none());
    }

    #[test]
    fn fp_store_size_check_and_cap() {
        let d = tmp();
        let t = theme(7, 100);
        put_theme_fp(&d, &t);
        assert_eq!(get_theme_fp(&d, 7, t.size), Some(t.clone()));
        assert_eq!(get_theme_fp(&d, 7, 0), Some(t.clone()));
        // A different file size under the same id: stale, removed.
        assert_eq!(get_theme_fp(&d, 7, t.size + 1), None);
        assert_eq!(get_theme_fp(&d, 7, t.size), None);
        // Cap: never more than THEME_FP_CAP files.
        let fpd = d.join(THEME_FP_DIR);
        for id in 0..(THEME_FP_CAP as u64 + 5) {
            std::fs::create_dir_all(&fpd).unwrap();
            // Retried: a scanner can hold a just-created file for a moment
            // (seen once in 3 release-profile corpus runs).
            let f = fpd.join(format!("{}.bin", 10_000 + id));
            let mut tries = 0;
            while let Err(e) = std::fs::write(&f, b"x") {
                tries += 1;
                assert!(tries < 20, "scratch write kept failing: {e}");
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }
        put_theme_fp(&d, &theme(8, 10));
        let n = std::fs::read_dir(&fpd).unwrap().count();
        assert!(n <= THEME_FP_CAP, "{n} files");
        assert!(total_bytes(&d) > 0);
        clear_all(&d).unwrap();
        assert_eq!(total_bytes(&d), 0);
        clear_all(&d).unwrap();
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ttl_cap_and_atomic_json() {
        let d = tmp();
        let p = d.join(RESULT_FILE);
        put_entry(&p, "a", 1u32, 100, 3, 1000);
        assert_eq!(get_entry::<u32>(&p, "a", 1050), Some(1));
        assert_eq!(get_entry::<u32>(&p, "a", 1100), None, "expired at saved_at + ttl");
        for (i, k) in ["b", "c", "d", "e"].iter().enumerate() {
            put_entry(&p, k, i as u32, 10_000, 3, 2000 + i as u64);
        }
        // Cap 3, oldest first: "a" expired and dropped, "b" evicted.
        let m = load_map::<u32>(&p);
        assert_eq!(m.len(), 3);
        assert!(m.contains_key("c") && m.contains_key("d") && m.contains_key("e"));
        assert!(!d.join(format!("{RESULT_FILE}.tmp")).exists(), "no tmp left behind");
        // Theme lists: a miss is cached distinctly from absence.
        put_theme_list::<Vec<u32>>(&d, 5, None);
        assert_eq!(get_theme_list::<Vec<u32>>(&d, 5), Some(None));
        put_theme_list(&d, 6, Some(vec![1u32, 2]));
        assert_eq!(get_theme_list::<Vec<u32>>(&d, 6), Some(Some(vec![1, 2])));
        assert_eq!(get_theme_list::<Vec<u32>>(&d, 7), None);
        // A corrupt file reads as empty and is replaced on the next write.
        std::fs::write(d.join(THEME_LIST_FILE), b"{not json").unwrap();
        assert_eq!(get_theme_list::<Vec<u32>>(&d, 6), None);
        put_theme_list(&d, 6, Some(vec![3u32]));
        assert_eq!(get_theme_list::<Vec<u32>>(&d, 6), Some(Some(vec![3])));
        clear_all(&d).unwrap();
        assert!(!d.join(THEME_LIST_FILE).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn failed_write_leaves_no_tmp() {
        let d = tmp();
        // The target is a non-empty directory: the final rename fails.
        let target = d.join("blocked.json");
        std::fs::create_dir_all(target.join("inner")).unwrap();
        assert!(write_atomic(&target, b"{}").is_err());
        assert!(!d.join("blocked.json.tmp").exists(), "stray .tmp after a failed write");
        // A JSON cache write that fails the same way leaves nothing behind either.
        let p = d.join(RESULT_FILE);
        std::fs::create_dir_all(p.join("inner")).unwrap();
        put_entry(&p, "a", 1u32, 100, 3, 1000);
        assert!(!d.join(format!("{RESULT_FILE}.tmp")).exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn result_keys() {
        let a = result_key("tt14986406:3:1", "BLEACH.S03E01.mkv", 1436.24);
        assert_eq!(a.len(), 32);
        assert_eq!(a, result_key("tt14986406:3:1", "BLEACH.S03E01.mkv", 1436.2449));
        assert_ne!(a, result_key("tt14986406:3:1", "BLEACH.S03E01.mkv", 1436.36));
        assert_ne!(a, result_key("tt14986406:3:1", "OTHER.mkv", 1436.24));
        assert!(!a.contains("BLEACH"));
    }
}
