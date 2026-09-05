// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Path safety for the download manager.
//!
//! Downloads are the only place in Aura where ADDON-CONTROLLED text lands in a
//! USER-CHOSEN directory. `behaviorHints.filename` is capped at 512 chars by
//! `stremio::sanitize_stream` and is otherwise whatever the addon sent; show,
//! season and episode titles come from addon metadata too. Everything here
//! exists to make that safe.
//!
//! The governing property, and the one sentence worth remembering:
//!
//!   **This module does not try to model `RtlGetFullPathName_U`. It emits only
//!   paths that are FIXED POINTS of it.**
//!
//! Win32 silently rewrites a path before the kernel sees it: it strips trailing
//! dots and spaces from every component, expands 8.3 short names, and resolves
//! `.` / `..`. A containment check that runs against the pre-rewrite string is
//! therefore checking a path the kernel will never open. Rather than reimplement
//! that rewrite (undocumented in the corners that matter), every component this
//! module emits is already in the form Win32 would rewrite it to, so the check
//! and the open agree by construction. Sound lexical containment, no traversal,
//! and no trailing-strip surprise all fall out of that one property.
//!
//! Supersedes `subtitles::sanitize_filename` (`subtitles.rs:504-520`) for the
//! download path only. That function filters nine characters and truncates, and
//! misses reserved device names, trailing dots and spaces, control characters,
//! bidi and zero-width characters, and returns `".."` unchanged. It is safe
//! where it is used (a fixed, app-owned directory guarded by a canonicalizing
//! containment check at `subtitles.rs:547-585`) and is deliberately left alone;
//! changing a shipped sanitizer for a different surface is unnecessary risk.
//!
//! On Unicode normalization: this module does NOT normalize. NFKC must never be
//! used here because it maps U+FF0F FULLWIDTH SOLIDUS to `/` and U+FF1A
//! FULLWIDTH COLON to `:`, i.e. it MANUFACTURES path separators, which is
//! exactly the transformation everything below exists to prevent. NFC would be
//! safe and would let two spellings of one title collapse to one file, but it
//! needs a new crate for a rare cosmetic gain, so it is skipped. Not
//! normalizing is strictly safer than NFKC and only marginally worse than NFC.

use std::fs::{File, OpenOptions};
use std::path::{Component, Path, PathBuf};

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/// Windows `MAX_PATH` is 260 INCLUDING the NUL terminator, so 259 usable UTF-16
/// units for a file. `windows-app-manifest.xml` deliberately carries no
/// `<longPathAware>`: it is inert without the machine-wide
/// `HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=1` admin
/// opt-in, which Aura cannot and should not set, and a >260-char file is one
/// Explorer and most media players cannot open. Budget and truncate instead.
const MAX_FILE_UTF16: usize = 259;

/// Directories need room for `\` plus a file name inside them.
const MAX_DIR_UTF16: usize = 247;

/// Reserved on top of the final name for the two suffixes this module can
/// append after the budget has already been spent: ` (99)` (5) and
/// `.aurapart` (9), plus one for the separator. Without reserving these up
/// front a name that exactly fits would blow `MAX_PATH` at finalize, i.e.
/// AFTER the whole file has downloaded.
const LEAF_RESERVE_UTF16: usize = 15;

/// A root deeper than this leaves no useful budget for a show folder, a season
/// folder and an episode name. Rejected at Settings save so the failure lands
/// when the user picks the folder, not days later on a long-titled episode.
const MAX_ROOT_UTF16: usize = 180;

/// Longest single component we will emit before the budget squeezes it further.
const MAX_COMPONENT_UTF16: usize = 120;

/// Give up rather than loop forever when 99 files already claim a name.
const MAX_COLLISION_TRIES: u32 = 99;

/// Suffix for the in-progress file. Deliberately not `.part`: `runtime_deps`
/// already uses that for its own single-flight downloads and a shared suffix in
/// a user-visible folder invites confusion.
pub const PART_SUFFIX: &str = "aurapart";

/// Directory name for HLS ledger work, created under the download root.
/// Under the ROOT, never `%TEMP%`: `std::fs::rename` fails with
/// `ERROR_NOT_SAME_DEVICE` across volumes, and a cross-volume copy of an 8 GB
/// file is not an atomic publish.
pub const WORK_DIR: &str = ".aura-incomplete";

// ---------------------------------------------------------------------------
// Character rules
// ---------------------------------------------------------------------------

/// Characters Win32 rejects outright in a file name, plus `:` which is the
/// Alternate Data Stream separator (`name.mkv:evil` writes a hidden stream on
/// NTFS, not a file called `name.mkv:evil`).
const INVALID: &[char] = &['/', '\\', ':', '*', '?', '"', '<', '>', '|'];

/// Reserved DOS device names. Matched on the stem BEFORE the first dot, because
/// `CON.mkv` is just as reserved as `CON`. `COM0` and `LPT0` are included:
/// they are reserved on modern Windows even though the classic list starts at
/// 1. `CONIN$`, `CONOUT$` and `CLOCK$` complete the set.
const RESERVED: &[&str] = &[
    "CON", "PRN", "AUX", "NUL",
    "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    "CONIN$", "CONOUT$", "CLOCK$",
];

/// Containers we are willing to write. The extension is a SECURITY CONTROL, not
/// a suffix: without an allowlist an addon that sets
/// `behaviorHints.filename = "payload.exe"` gets an executable written into the
/// user's chosen folder under a name they half-recognise.
const CONTAINERS: &[&str] = &[
    "mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "m2ts", "mts",
    "wmv", "flv", "mpg", "mpeg", "ogv", "3gp", "vob", "divx", "rmvb",
];

/// Default container when nothing else can be established. `mkv` because it is
/// what an HLS remux produces and what most addon content already is.
pub const DEFAULT_EXT: &str = "mkv";

/// Zero-width, bidi-control and tag characters, which are DELETED outright.
///
/// The bidi overrides are the dangerous ones: U+202E RIGHT-TO-LEFT OVERRIDE
/// makes a name render in Explorer as `episode.mkv` while actually ending
/// `vkm.exe`. Deleting rather than space-mapping is right here, because these
/// carry no width and a substituted space would be a visible change to a name
/// that looked fine.
fn is_deleted_invisible(c: char) -> bool {
    let u = c as u32;
    matches!(u,
        0x00AD            // soft hyphen
        | 0x180E          // Mongolian vowel separator
        | 0x200B..=0x200F // zero-width space/joiners, LRM, RLM
        | 0x202A..=0x202E // LRE, RLE, PDF, LRO, RLO
        | 0x2060..=0x2064 // word joiner, invisible operators
        | 0x2066..=0x2069 // isolates
        | 0xFEFF          // BOM / zero-width no-break space
        | 0xFFF9..=0xFFFB // interlinear annotation
        | 0xE0000..=0xE007F // plane-14 tag block
    )
}

/// C0 and C1 control characters, which are mapped to a SPACE rather than
/// deleted. A tab or newline sits between words far more often than inside
/// one, so `Episode\tOne` should read `Episode One`, not `EpisodeOne`. The
/// whitespace collapse below removes the difference wherever it does not
/// matter.
fn is_control(c: char) -> bool {
    let u = c as u32;
    matches!(u, 0x0000..=0x001F | 0x007F..=0x009F)
}

/// Count UTF-16 code units, which is the unit `MAX_PATH` is measured in. A
/// `String::len()` byte count over-counts CJK (3 bytes, 1 unit) and
/// under-counts emoji (4 bytes, 2 units).
fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

/// Truncate to at most `max` UTF-16 units, always on a char boundary.
/// Byte-slicing a `String` panics at a non-char boundary, and anime titles are
/// exactly the case where that happens.
fn truncate_utf16(s: &str, max: usize) -> String {
    if utf16_len(s) <= max {
        return s.to_string();
    }
    let mut out = String::new();
    let mut used = 0usize;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > max {
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

/// The trailing-strip rule, applied as our OWN normalization rather than left
/// for Win32 to do behind our back.
///
/// Win32 strips trailing dots and spaces from every path component before the
/// kernel sees it. That is what makes `".. "` a traversal: it is not `..`
/// lexically, so a naive containment check passes it, and then Win32 rewrites
/// it to `..` and the kernel walks up a directory. Applying the strip here and
/// re-checking afterwards makes the traversal structurally unrepresentable.
fn strip_trailing_dots_spaces(s: &str) -> &str {
    s.trim_end_matches(|c| c == '.' || c == ' ')
}

/// Sanitize one path component. Returns `None` when nothing usable survives, so
/// the caller can substitute a seeded fallback rather than a shared constant
/// (a shared constant means two unusable names become one file).
pub fn sanitize_component(raw: &str, max_utf16: usize) -> Option<String> {
    // Take only the final segment, so a filename carrying its own path
    // (`../../../Windows/System32/drivers/etc/hosts`) contributes only `hosts`.
    let leaf = Path::new(raw)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(raw);

    let mapped: String = leaf
        .chars()
        .filter(|c| !is_deleted_invisible(*c))
        .map(|c| {
            if INVALID.contains(&c) || is_control(c) {
                ' '
            } else if c == '\u{00A0}' {
                // NBSP folds to a real space so it collapses with its
                // neighbours instead of surviving as an invisible edge.
                ' '
            } else {
                c
            }
        })
        .collect();

    // Collapse runs of whitespace introduced by the mapping above, so
    // `a:::b` reads `a b` rather than `a   b`.
    let collapsed = {
        let mut out = String::with_capacity(mapped.len());
        let mut prev_space = false;
        for c in mapped.chars() {
            let is_space = c == ' ' || c == '\t';
            if is_space {
                if !prev_space {
                    out.push(' ');
                }
            } else {
                out.push(c);
            }
            prev_space = is_space;
        }
        out
    };

    let trimmed = strip_trailing_dots_spaces(collapsed.trim_start()).trim_end();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }

    // Reserved-name check runs on the stem before the FIRST dot, and after the
    // trailing trim, so `CON.` and `CON.mkv` are both caught.
    let stem = trimmed.split('.').next().unwrap_or(trimmed);
    let guarded = if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(stem)) {
        format!("_{trimmed}")
    } else {
        trimmed.to_string()
    };

    // Truncate LAST, then re-apply the trailing rule: a cut can expose a dot or
    // a space that was interior a moment ago.
    let cut = truncate_utf16(&guarded, max_utf16);
    let refinal = strip_trailing_dots_spaces(&cut).trim_end();
    if refinal.is_empty() || refinal == "." || refinal == ".." {
        return None;
    }
    Some(refinal.to_string())
}

/// A deterministic stem derived from the job's own identity, used when
/// sanitization leaves nothing. Seeded rather than constant so two different
/// unusable names cannot collide into one file.
pub fn fallback_stem(seed: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(seed.as_bytes());
    format!("download-{}", hex::encode(&digest[..6]))
}

// ---------------------------------------------------------------------------
// Extension election
// ---------------------------------------------------------------------------

/// Where the container came from. Ordering matters at refine time: a header
/// arriving mid-flight may upgrade a `Default`, but must never override a
/// container the addon or the URL stated explicitly.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ExtSource {
    Filename,
    UrlPath,
    ContentType,
    Default,
}

fn allowlisted(candidate: &str) -> Option<String> {
    let lower = candidate.trim().trim_start_matches('.').to_ascii_lowercase();
    CONTAINERS.contains(&lower.as_str()).then_some(lower)
}

/// Elect the output container, in confidence order.
///
/// `content_type` is consulted only for specific video types; `application/
/// octet-stream` is what most debrid hosts send and carries no information.
pub fn choose_extension(
    filename: Option<&str>,
    url: Option<&str>,
    content_type: Option<&str>,
) -> (String, ExtSource) {
    if let Some(name) = filename {
        if let Some(ext) = Path::new(name).extension().and_then(|e| e.to_str()) {
            if let Some(ok) = allowlisted(ext) {
                return (ok, ExtSource::Filename);
            }
        }
    }
    if let Some(u) = url {
        // Take the path only: a query string routinely contains a filename that
        // is not the file being served.
        let path_only = u.split(['?', '#']).next().unwrap_or(u);
        if let Some(ext) = Path::new(path_only).extension().and_then(|e| e.to_str()) {
            if let Some(ok) = allowlisted(ext) {
                return (ok, ExtSource::UrlPath);
            }
        }
    }
    if let Some(ct) = content_type {
        let base = ct.split(';').next().unwrap_or(ct).trim().to_ascii_lowercase();
        let mapped = match base.as_str() {
            "video/x-matroska" => Some("mkv"),
            "video/mp4" => Some("mp4"),
            "video/webm" => Some("webm"),
            "video/quicktime" => Some("mov"),
            "video/mp2t" => Some("ts"),
            "video/x-msvideo" => Some("avi"),
            _ => None,
        };
        if let Some(m) = mapped {
            return (m.to_string(), ExtSource::ContentType);
        }
    }
    (DEFAULT_EXT.to_string(), ExtSource::Default)
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/// A relative layout: zero or more directory components followed by a file
/// stem. The extension is carried separately so the budget can be computed
/// without re-parsing.
#[derive(Clone, Debug)]
pub struct Layout {
    pub dirs: Vec<String>,
    pub stem: String,
    pub ext: String,
}

/// `<Show (Year)>/<Season NN>/<Show - SxxEyy - Title>.<ext>`
///
/// `season == None` emits NO season directory and an `E1076`-style stem.
/// Long-running anime is routinely delivered with a null season and a
/// four-digit absolute episode; inventing `Season 01` for it would be a
/// fiction, and inventing `Season 54` would be a different one.
/// `season == Some(0)` is a special and lands in `Specials`.
pub fn organised_series(
    show: &str,
    year: Option<i32>,
    season: Option<i32>,
    episode: Option<i32>,
    episode_title: Option<&str>,
    ext: &str,
    fallback: &str,
) -> Layout {
    let show_c = sanitize_component(show, MAX_COMPONENT_UTF16)
        .unwrap_or_else(|| fallback.to_string());
    let show_dir = match year {
        Some(y) => sanitize_component(&format!("{show_c} ({y})"), MAX_COMPONENT_UTF16)
            .unwrap_or_else(|| show_c.clone()),
        None => show_c.clone(),
    };

    let mut dirs = vec![show_dir];
    match season {
        Some(0) => dirs.push("Specials".to_string()),
        Some(s) => dirs.push(format!("Season {s:02}")),
        None => {}
    }

    // Episode marker. `S00E03` is kept for specials so the file still says what
    // it is even though the folder already grouped it.
    let marker = match (season, episode) {
        (Some(s), Some(e)) => Some(format!("S{s:02}E{e:02}")),
        (None, Some(e)) => Some(format!("E{e}")),
        _ => None,
    };

    let mut parts = vec![show_c];
    if let Some(m) = marker {
        parts.push(m);
    }
    if let Some(t) = episode_title.and_then(|t| sanitize_component(t, MAX_COMPONENT_UTF16)) {
        parts.push(t);
    }
    let stem = sanitize_component(&parts.join(" - "), MAX_COMPONENT_UTF16)
        .unwrap_or_else(|| fallback.to_string());

    Layout { dirs, stem, ext: ext.to_string() }
}

/// `<Title (Year)>/<Title (Year)>.<ext>`, or `<Title>/<Title>.<ext>` when no
/// year is known. Never emits empty parentheses.
pub fn organised_movie(title: &str, year: Option<i32>, ext: &str, fallback: &str) -> Layout {
    let base = sanitize_component(title, MAX_COMPONENT_UTF16)
        .unwrap_or_else(|| fallback.to_string());
    let named = match year {
        Some(y) => sanitize_component(&format!("{base} ({y})"), MAX_COMPONENT_UTF16)
            .unwrap_or_else(|| base.clone()),
        None => base,
    };
    Layout { dirs: vec![named.clone()], stem: named, ext: ext.to_string() }
}

/// A season pack is one file containing many episodes, so it must never be
/// named as a single episode. Multi-season packs belong to no single season and
/// go in `Packs`.
pub fn organised_pack(
    show: &str,
    year: Option<i32>,
    season: Option<i32>,
    release: Option<&str>,
    multi_season: bool,
    ext: &str,
    fallback: &str,
) -> Layout {
    let show_c = sanitize_component(show, MAX_COMPONENT_UTF16)
        .unwrap_or_else(|| fallback.to_string());
    let show_dir = match year {
        Some(y) => sanitize_component(&format!("{show_c} ({y})"), MAX_COMPONENT_UTF16)
            .unwrap_or_else(|| show_c.clone()),
        None => show_c.clone(),
    };
    let mut dirs = vec![show_dir];
    match (multi_season, season) {
        (true, _) => dirs.push("Packs".to_string()),
        (false, Some(s)) => dirs.push(format!("Season {s:02}")),
        (false, None) => dirs.push("Packs".to_string()),
    }

    // The release name is the only honest label for a pack, so it is kept
    // whole (minus its own extension) rather than reduced to an episode marker.
    let rel = release
        .map(|r| Path::new(r).file_stem().and_then(|s| s.to_str()).unwrap_or(r).to_string())
        .and_then(|r| sanitize_component(&r, MAX_COMPONENT_UTF16));
    let stem = match rel {
        Some(r) => sanitize_component(&format!("{show_c} - {r}"), MAX_COMPONENT_UTF16)
            .unwrap_or_else(|| fallback.to_string()),
        None => show_c,
    };
    Layout { dirs, stem, ext: ext.to_string() }
}

/// Flat mode: the raw release filename straight into the root.
///
/// The raw name is only trusted when sanitizing it changes nothing structural,
/// i.e. it was already a bare leaf. Anything else falls through to the caller's
/// organised stem so a traversal attempt does not silently become a plausible
/// file in the root.
pub fn flat(release: Option<&str>, organised_stem: &str, ext: &str, fallback: &str) -> Layout {
    if let Some(raw) = release {
        let is_bare_leaf = Path::new(raw)
            .file_name()
            .and_then(|s| s.to_str())
            .map(|leaf| leaf == raw)
            .unwrap_or(false);
        if is_bare_leaf {
            let stem_src = Path::new(raw).file_stem().and_then(|s| s.to_str()).unwrap_or(raw);
            if let Some(clean) = sanitize_component(stem_src, MAX_COMPONENT_UTF16) {
                return Layout { dirs: Vec::new(), stem: clean, ext: ext.to_string() };
            }
        }
    }
    let stem = sanitize_component(organised_stem, MAX_COMPONENT_UTF16)
        .unwrap_or_else(|| fallback.to_string());
    Layout { dirs: Vec::new(), stem, ext: ext.to_string() }
}

// ---------------------------------------------------------------------------
// Root validation
// ---------------------------------------------------------------------------

/// Why a configured download root is unusable. Distinguished from a generic
/// error because `Missing` parks a job as RESUMABLE (a pulled USB drive comes
/// back) while the others are configuration faults the user must fix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RootError {
    Unset,
    Missing(String),
    NotADirectory(String),
    NotWritable(String),
    TooDeep(usize),
}

impl std::fmt::Display for RootError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RootError::Unset => write!(f, "No download folder is set yet."),
            RootError::Missing(p) => write!(
                f,
                "The download folder is not available right now: {p}. If it is on a removable or network drive, reconnect it and resume."
            ),
            RootError::NotADirectory(p) => write!(f, "The download folder is not a directory: {p}"),
            RootError::NotWritable(p) => write!(f, "Aura cannot write to the download folder: {p}"),
            RootError::TooDeep(n) => write!(
                f,
                "That folder is {n} characters deep, which leaves no room for file names inside it. Windows caps a full path at 260. Pick a shorter path."
            ),
        }
    }
}

/// Windows `canonicalize` returns a `\\?\`-prefixed verbatim path. Verbatim
/// paths are handed to the kernel WITHOUT the usual rewrite, which means `..`
/// is taken literally, and they also break `revealItemInDir` and read as
/// gibberish in the UI. Strip the prefix and keep the long form.
fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p.to_path_buf()
}

/// Resolve and prove a configured root is usable RIGHT NOW.
///
/// Called at Settings save, at job creation, and again on every resume, because
/// all three can be separated by hours and a removable drive.
pub fn validate_root(configured: &str) -> Result<PathBuf, RootError> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        return Err(RootError::Unset);
    }
    let raw = PathBuf::from(trimmed);

    // canonicalize also resolves 8.3 short names (`DOWNLO~1`), without which a
    // containment prefix comparison against the long form is a false negative.
    let canon = std::fs::canonicalize(&raw)
        .map_err(|_| RootError::Missing(trimmed.to_string()))?;
    let root = strip_verbatim(&canon);

    if !root.is_dir() {
        return Err(RootError::NotADirectory(root.display().to_string()));
    }
    let depth = utf16_len(&root.to_string_lossy());
    if depth > MAX_ROOT_UTF16 {
        return Err(RootError::TooDeep(depth));
    }

    // Probe rather than trust metadata: a read-only attribute, an ACL and a
    // disconnected share all fail differently and only a write tells the truth.
    let probe = root.join(".aura-write-probe");
    match OpenOptions::new().write(true).create(true).truncate(true).open(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
        }
        Err(_) => return Err(RootError::NotWritable(root.display().to_string())),
    }
    Ok(root)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/// A planned destination. Nothing has touched the disk at this point.
#[derive(Clone, Debug)]
pub struct PathPlan {
    /// Directory the file will live in, absolute, long form, no verbatim prefix.
    pub dir: PathBuf,
    pub stem: String,
    pub ext: String,
    /// The full intended path, before collision resolution.
    pub planned: PathBuf,
    /// True when the budget forced a name to be shortened. Surfaced as a row
    /// tooltip only: a toast per download on a long-titled series is noise, and
    /// the file is still correct.
    pub truncated: bool,
}

/// Turn a relative `Layout` into an absolute plan under `root`, spending the
/// `MAX_PATH` budget and proving lexical containment. Never touches the disk,
/// so a rejected job leaves no stray directory behind.
pub fn plan(root: &Path, layout: Layout) -> Result<PathPlan, String> {
    let root_len = utf16_len(&root.to_string_lossy());
    let mut truncated = false;

    // Directories first: each one is squeezed to what is left after the ones
    // before it, keeping room for a file inside.
    let mut dir = root.to_path_buf();
    let mut used = root_len;
    for d in &layout.dirs {
        let avail = MAX_DIR_UTF16.saturating_sub(used + 1);
        if avail == 0 {
            return Err(format!(
                "The download folder path is too long to create '{d}' inside it."
            ));
        }
        let squeezed = truncate_utf16(d, avail.min(MAX_COMPONENT_UTF16));
        let cleaned = sanitize_component(&squeezed, avail.min(MAX_COMPONENT_UTF16))
            .ok_or_else(|| format!("Folder name became empty after cleaning: '{d}'"))?;
        if utf16_len(&cleaned) < utf16_len(d) {
            truncated = true;
        }
        used += 1 + utf16_len(&cleaned);
        dir.push(cleaned);
    }

    // What is left for `<stem>.<ext>`, minus the suffixes finalize may append.
    let ext_units = 1 + utf16_len(&layout.ext);
    let budget = MAX_FILE_UTF16
        .saturating_sub(used + 1 + ext_units + LEAF_RESERVE_UTF16);
    if budget == 0 {
        return Err(
            "That download folder is too deep for this title. Pick a shorter folder.".into(),
        );
    }
    let squeezed = truncate_utf16(&layout.stem, budget);
    if utf16_len(&squeezed) < utf16_len(&layout.stem) {
        truncated = true;
    }
    let stem = sanitize_component(&squeezed, budget)
        .ok_or_else(|| "File name became empty after cleaning.".to_string())?;

    let planned = dir.join(format!("{stem}.{}", layout.ext));
    assert_lexically_inside(root, &planned)?;

    Ok(PathPlan { dir, stem, ext: layout.ext, planned, truncated })
}

/// Lexical containment. Sound ONLY because every component was emitted by
/// `sanitize_component`, so the path is already a fixed point of Win32's
/// rewrite and cannot grow a `..` on the way to the kernel.
fn assert_lexically_inside(root: &Path, candidate: &Path) -> Result<(), String> {
    if !candidate.starts_with(root) {
        return Err("Refusing to write outside the download folder.".into());
    }
    // Belt and braces: no component may be a traversal or a prefix/root escape.
    for c in candidate.strip_prefix(root).unwrap_or(candidate).components() {
        match c {
            Component::Normal(_) => {}
            _ => return Err("Refusing to write outside the download folder.".into()),
        }
    }
    Ok(())
}

/// Create the destination directory and re-prove containment CANONICALLY.
///
/// The lexical check in `plan` cannot see a junction: a user who linked
/// `Downloads\Anime` to another drive has a path that is lexically inside the
/// root and physically is not. Fail visible rather than write somewhere the
/// user cannot see, and name the resolved target so the diagnosis is one glance.
pub fn prepare_dir(root: &Path, plan: &PathPlan) -> Result<(), String> {
    std::fs::create_dir_all(&plan.dir)
        .map_err(|e| format!("Could not create '{}': {e}", plan.dir.display()))?;

    let canon_root = std::fs::canonicalize(root)
        .map_err(|e| format!("Download folder is unavailable: {e}"))?;
    let canon_dir = std::fs::canonicalize(&plan.dir)
        .map_err(|e| format!("Could not resolve '{}': {e}", plan.dir.display()))?;
    if !canon_dir.starts_with(&canon_root) {
        return Err(format!(
            "'{}' resolves to '{}', which is outside the download folder. A folder link or junction is redirecting it.",
            plan.dir.display(),
            strip_verbatim(&canon_dir).display()
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Claiming and finalizing
// ---------------------------------------------------------------------------

fn nth_name(stem: &str, ext: &str, n: u32) -> String {
    if n == 0 {
        format!("{stem}.{ext}")
    } else {
        format!("{stem} ({n}).{ext}")
    }
}

/// Atomically reserve the in-progress file and return the open handle.
///
/// `create_new` is the claim: it fails if anything is already there, which is
/// the only race-free test on Windows. An `exists()` check would both TOCTOU
/// against the other concurrent worker and miss `dune.mkv` when asking about
/// `Dune.mkv`, because NTFS is case-insensitive.
pub fn claim_part(dir: &Path, stem: &str, ext: &str) -> Result<(PathBuf, File), String> {
    for n in 0..=MAX_COLLISION_TRIES {
        let name = format!("{}.{PART_SUFFIX}", nth_name(stem, ext, n));
        let candidate = dir.join(&name);
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(f) => return Ok((candidate, f)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create '{}': {e}", candidate.display())),
        }
    }
    Err("Too many files already share that name in the download folder.".into())
}

/// Publish a completed download: claim a free final name, then rename onto it.
///
/// The claim matters because `std::fs::rename` CLOBBERS on Windows. Claiming
/// first means the thing it clobbers is our own zero-byte reservation rather
/// than a file the user cares about.
///
/// The walk restarts at `n = 0` rather than reusing the suffix `claim_part`
/// settled on: forty minutes elapsed, and `Dune.mkv` may have been freed since.
pub fn finalize(dir: &Path, stem: &str, ext: &str, part: &Path) -> Result<PathBuf, String> {
    for n in 0..=MAX_COLLISION_TRIES {
        let candidate = dir.join(nth_name(stem, ext, n));
        match OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(f) => {
                drop(f);
                std::fs::rename(part, &candidate).map_err(|e| {
                    // Put the reservation back rather than leaving a stray
                    // zero-byte file next to a still-valid .aurapart.
                    let _ = std::fs::remove_file(&candidate);
                    format!("Could not finish '{}': {e}", candidate.display())
                })?;
                return Ok(candidate);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create '{}': {e}", candidate.display())),
        }
    }
    Err("Too many files already share that name in the download folder.".into())
}

/// Key used by the duplicate guard. Case-insensitive because NTFS is.
pub fn duplicate_key(planned: &Path) -> String {
    planned.to_string_lossy().to_lowercase()
}

// ---------------------------------------------------------------------------
// Free space
// ---------------------------------------------------------------------------

/// Bytes available to THIS user on the volume holding `dir`.
///
/// `lpFreeBytesAvailableToCaller`, not the volume total: on a quota-managed
/// share the two differ and only the former is what we can actually write.
#[cfg(target_os = "windows")]
pub fn free_bytes_for(dir: &Path) -> Option<u64> {
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide = HSTRING::from(dir.as_os_str());
    let mut free_to_caller: u64 = 0;
    unsafe {
        GetDiskFreeSpaceExW(&wide, Some(&mut free_to_caller), None, None).ok()?;
    }
    Some(free_to_caller)
}

#[cfg(not(target_os = "windows"))]
pub fn free_bytes_for(_dir: &Path) -> Option<u64> {
    None
}

/// Headroom kept free so a download never fills the volume to zero, which is
/// its own class of Windows misery.
pub const FREE_SPACE_SLACK: u64 = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn s(raw: &str) -> Option<String> {
        sanitize_component(raw, MAX_COMPONENT_UTF16)
    }

    #[test]
    fn strips_path_separators_and_traversal() {
        // The whole point: an addon filename carrying a path contributes only
        // its leaf, and a bare traversal is unrepresentable.
        assert_eq!(
            s("../../../../Windows/System32/drivers/etc/hosts").as_deref(),
            Some("hosts")
        );
        assert_eq!(s(".."), None);
        assert_eq!(s("."), None);
        // ".. " is the interesting one: lexically not "..", but Win32 strips
        // the trailing space and makes it one.
        assert_eq!(s(".. "), None);
        assert_eq!(s("..  "), None);
        assert_eq!(s("..."), None);
    }

    #[test]
    fn reserved_device_names_are_defused() {
        assert_eq!(s("CON").as_deref(), Some("_CON"));
        assert_eq!(s("con.mkv").as_deref(), Some("_con.mkv"));
        assert_eq!(s("COM1.mkv").as_deref(), Some("_COM1.mkv"));
        assert_eq!(s("LPT0").as_deref(), Some("_LPT0"));
        assert_eq!(s("CLOCK$.mkv").as_deref(), Some("_CLOCK$.mkv"));
        // Not reserved, must be left alone.
        assert_eq!(s("CONTACT.mkv").as_deref(), Some("CONTACT.mkv"));
        assert_eq!(s("COM10.mkv").as_deref(), Some("COM10.mkv"));
    }

    #[test]
    fn trailing_dots_and_spaces_never_survive() {
        assert_eq!(s("episode.mkv.").as_deref(), Some("episode.mkv"));
        assert_eq!(s("episode.mkv   ").as_deref(), Some("episode.mkv"));
        assert_eq!(s("episode.mkv. . ").as_deref(), Some("episode.mkv"));
    }

    #[test]
    fn ads_separator_and_invalid_chars_become_spaces() {
        // `name.mkv:evil` would otherwise write an NTFS alternate data stream.
        assert_eq!(s("name.mkv:evil").as_deref(), Some("name.mkv evil"));
        assert_eq!(s("a<b>c|d?e*f\"g").as_deref(), Some("a b c d e f g"));
    }

    #[test]
    fn invisible_and_bidi_characters_are_removed() {
        // RLO spoof: renders as "...vkm.exe" while being an executable.
        assert_eq!(s("episode\u{202E}vkm.exe").as_deref(), Some("episodevkm.exe"));
        assert_eq!(s("a\u{200B}b").as_deref(), Some("ab"));
        assert_eq!(s("a\u{FEFF}b").as_deref(), Some("ab"));
        // A C0 control becomes a space, not nothing: a tab sits between words
        // far more often than inside one.
        assert_eq!(s("a\u{000B}b").as_deref(), Some("a b"));
        assert_eq!(s("Episode\tOne").as_deref(), Some("Episode One"));
        // NBSP folds to a real space rather than surviving as an invisible edge.
        assert_eq!(s("a\u{00A0}b").as_deref(), Some("a b"));
    }

    #[test]
    fn fullwidth_separators_are_left_alone() {
        // The NFKC hazard, asserted as a non-event: these must NOT become
        // `/` and `:`. If someone adds NFKC normalization this test fails.
        assert_eq!(s("a\u{FF0F}b\u{FF1A}c").as_deref(), Some("a\u{FF0F}b\u{FF1A}c"));
    }

    #[test]
    fn truncation_is_utf16_counted_and_char_safe() {
        // Byte-slicing here would panic; CJK is 3 bytes but 1 UTF-16 unit.
        let long = "\u{3042}".repeat(400);
        let out = sanitize_component(&long, 10).unwrap();
        assert_eq!(utf16_len(&out), 10);
        // Emoji are 2 UTF-16 units, so an odd budget must not split one.
        let emoji = "\u{1F600}".repeat(20);
        let out2 = sanitize_component(&emoji, 5).unwrap();
        assert_eq!(utf16_len(&out2), 4);
    }

    #[test]
    fn truncation_reapplies_the_trailing_rule() {
        // Cutting "abc.  def" at 5 exposes a trailing space+dot that was
        // interior a moment earlier.
        let out = sanitize_component("abcd. def", 6).unwrap();
        assert!(!out.ends_with(' ') && !out.ends_with('.'), "got {out:?}");
    }

    #[test]
    fn empty_after_cleaning_is_none_not_a_shared_constant() {
        assert_eq!(s("   "), None);
        assert_eq!(s("\u{200B}\u{200B}"), None);
        assert_eq!(s("///"), None);
        // Two different unusable names must not become one file.
        assert_ne!(fallback_stem("a"), fallback_stem("b"));
    }

    #[test]
    fn extension_is_allowlisted_not_trusted() {
        assert_eq!(
            choose_extension(Some("payload.exe"), None, None),
            ("mkv".into(), ExtSource::Default)
        );
        assert_eq!(
            choose_extension(Some("Show.S01E01.mkv"), None, None),
            ("mkv".into(), ExtSource::Filename)
        );
        // A query string is not the file being served.
        assert_eq!(
            choose_extension(None, Some("https://h/dl/x.mp4?name=y.exe"), None),
            ("mp4".into(), ExtSource::UrlPath)
        );
        // octet-stream carries no information and must not win.
        assert_eq!(
            choose_extension(None, Some("https://h/requestdl"), Some("application/octet-stream")),
            ("mkv".into(), ExtSource::Default)
        );
        assert_eq!(
            choose_extension(None, Some("https://h/requestdl"), Some("video/mp4; codecs=avc1")),
            ("mp4".into(), ExtSource::ContentType)
        );
    }

    #[test]
    fn organised_series_shapes() {
        let fb = "download-000000";
        let l = organised_series("Severance", Some(2022), Some(2), Some(7), Some("Chikhai Bardo"), "mkv", fb);
        assert_eq!(l.dirs, vec!["Severance (2022)", "Season 02"]);
        assert_eq!(l.stem, "Severance - S02E07 - Chikhai Bardo");

        // Season 0 is a special, and keeps its marker in the file name.
        let sp = organised_series("Frieren", Some(2023), Some(0), Some(3), Some("Nachwort"), "mkv", fb);
        assert_eq!(sp.dirs, vec!["Frieren (2023)", "Specials"]);
        assert_eq!(sp.stem, "Frieren - S00E03 - Nachwort");

        // Null season: no invented season folder, absolute episode number.
        let op = organised_series("One Piece", Some(1999), None, Some(1076), Some("Wano"), "mkv", fb);
        assert_eq!(op.dirs, vec!["One Piece (1999)"]);
        assert_eq!(op.stem, "One Piece - E1076 - Wano");

        // A colon in the show title must not become an ADS separator.
        let c = organised_series("Mission: Impossible", None, Some(1), Some(1), None, "mkv", fb);
        assert_eq!(c.dirs, vec!["Mission Impossible", "Season 01"]);
        assert_eq!(c.stem, "Mission Impossible - S01E01");
    }

    #[test]
    fn organised_movie_omits_empty_parens() {
        let fb = "download-000000";
        assert_eq!(organised_movie("Dune", Some(2021), "mkv", fb).stem, "Dune (2021)");
        let noyear = organised_movie("Aftersun", None, "mp4", fb);
        assert_eq!(noyear.stem, "Aftersun");
        assert_eq!(noyear.dirs, vec!["Aftersun"]);
    }

    #[test]
    fn packs_are_never_named_as_one_episode() {
        let fb = "download-000000";
        let single = organised_pack("Arcane", Some(2021), Some(2), Some("Arcane.S02.2160p.NF.WEB-DL.mkv"), false, "mkv", fb);
        assert_eq!(single.dirs, vec!["Arcane (2021)", "Season 02"]);
        assert!(single.stem.contains("S02"), "got {}", single.stem);
        assert!(!single.stem.contains("E04"));

        let multi = organised_pack("Breaking Bad", Some(2008), Some(3), Some("Breaking.Bad.S01-S05.COMPLETE.mkv"), true, "mkv", fb);
        assert_eq!(multi.dirs, vec!["Breaking Bad (2008)", "Packs"]);
    }

    #[test]
    fn flat_rejects_a_release_name_carrying_a_path() {
        let fb = "download-000000";
        let ok = flat(Some("Show.S01E01.1080p.mkv"), "Show - S01E01", "mkv", fb);
        assert_eq!(ok.stem, "Show.S01E01.1080p");
        assert!(ok.dirs.is_empty());

        // A traversal must fall through to the organised stem, not become a
        // plausible file sitting in the root.
        let bad = flat(Some("../../../../Windows/System32/config/SAM"), "Show - S01E01", "mkv", fb);
        assert_eq!(bad.stem, "Show - S01E01");
    }

    #[test]
    fn plan_rejects_paths_that_escape_the_root() {
        let root = Path::new(r"D:\Media");
        let l = Layout {
            dirs: vec!["Show".into()],
            stem: "Episode".into(),
            ext: "mkv".into(),
        };
        let p = plan(root, l).unwrap();
        assert_eq!(p.planned, Path::new(r"D:\Media\Show\Episode.mkv"));
        assert!(!p.truncated);
    }

    #[test]
    fn plan_budgets_against_max_path() {
        // A deep root plus a long title must produce a path that still fits,
        // including the suffixes finalize may append.
        let root = PathBuf::from(format!(r"D:\{}", "x".repeat(150)));
        let l = Layout {
            dirs: vec!["S".repeat(60)],
            stem: "T".repeat(200),
            ext: "mkv".into(),
        };
        let p = plan(&root, l).unwrap();
        let total = utf16_len(&p.planned.to_string_lossy());
        assert!(
            total + LEAF_RESERVE_UTF16 <= MAX_FILE_UTF16,
            "planned path is {total} units, no room for the finalize suffixes"
        );
        assert!(p.truncated);
    }

    #[test]
    fn nth_name_shape() {
        assert_eq!(nth_name("Dune (2021)", "mkv", 0), "Dune (2021).mkv");
        assert_eq!(nth_name("Dune (2021)", "mkv", 2), "Dune (2021) (2).mkv");
    }
}

#[cfg(test)]
mod tmp_probe {
    use super::*;

    #[test]
    fn probe_reserved_after_truncation() {
        // 1. The primitive, in isolation, as the reviewer describes it.
        println!("prim CONTACT@3   = {:?}", sanitize_component("CONTACT", 3));
        println!("prim Con Air@3   = {:?}", sanitize_component("Con Air - S01E01", 3));

        // 2. What `plan` actually does: pre-truncate to the SAME budget, then sanitize.
        for budget in 1usize..10 {
            let squeezed = truncate_utf16("Con Air - S01E01 - Pilot", budget);
            println!(
                "plan-shape budget={budget} squeezed={squeezed:?} -> {:?}",
                sanitize_component(&squeezed, budget)
            );
        }

        // 3. End-to-end through plan(), with a root deep enough to squeeze the stem.
        for rootlen in [150usize, 160, 170, 176, 178, 179, 180] {
            let root = PathBuf::from(format!(r"D:\{}", "x".repeat(rootlen)));
            let l = Layout {
                dirs: vec!["Con Air (1997)".into(), "Season 01".into()],
                stem: "Con Air - S01E01 - Pilot".into(),
                ext: "mkv".into(),
            };
            match plan(&root, l) {
                Ok(p) => println!(
                    "plan rootlen={rootlen} ({} u) stem={:?} planned_leaf={:?}",
                    utf16_len(&root.to_string_lossy()),
                    p.stem,
                    p.planned.file_name().unwrap()
                ),
                Err(e) => println!("plan rootlen={rootlen} ERR {e}"),
            }
        }

        // 4. Same, with the dir components eating the budget the way the repro wants.
        for rootlen in [140usize, 150, 155, 158, 160, 165, 170] {
            let root = PathBuf::from(format!(r"D:\{}", "x".repeat(rootlen)));
            let l = Layout {
                dirs: vec!["Contact The Very Long Show Name Here (1997)".into(), "Season 01".into()],
                stem: "Contact - S01E01 - Some Episode Title".into(),
                ext: "mkv".into(),
            };
            match plan(&root, l) {
                Ok(p) => println!(
                    "plan2 rootlen={rootlen} dirs_last={:?} stem={:?}",
                    p.dir.file_name().unwrap(),
                    p.stem
                ),
                Err(e) => println!("plan2 rootlen={rootlen} ERR {e}"),
            }
        }
    }
}
