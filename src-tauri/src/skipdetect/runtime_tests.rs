// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/runtime_tests.rs
//
// Ignored runtime parity tests: the REAL ffmpeg argv against REAL streams of
// skipbench corpus episodes. They need
//
//   AURA_SKIPBENCH_DIR            the skipbench directory (cached WAVs, info.json,
//                                 eval_animethemes.json, themes/)
//   AURA_SKIPDETECT_RT_STREAMS    JSON {"<stremio id>": "<stream url>"}, set for
//                                 the test process only by the research helper
//                                 (it resolves the cached release by filename)
//   AURA_SKIPDETECT_RT_JOB        optional comma list limiting the full-job test
//   AURA_FFMPEG                   optional; default the runtime-deps ffmpeg
//
// Nothing here prints a URL: only ids, numbers and redacted notes.
//
//   skipdetect_runtime_parity  probe -> full HEAD -> TAIL with the production
//       argv: track pick vs info.json, HEAD origin 0 and PCM bit-identical to
//       the cached head.wav (the first-PTS branch must not change the PCM;
//       the PTS-gap release within GAP_CASE_PCM_MISMATCH_MAX samples, plus a
//       second plain-`aresample` decode that reports whether that release
//       still HAS gaps),
//       TAIL origin == S (except the seek-origin case), media end vs the mapped
//       DURATION tag and the cached read, TAIL PCM bit-identical where the
//       production S equals the cached start, theme decode through stdin
//       bit-identical to the cached decode, and Layer 1 windows vs
//       eval_animethemes.json (strict, A_full) within 0.15 s.
//   skipdetect_runtime_detect  the whole job (result cache, probe, HEAD with
//       early exit, TAIL, AnimeThemes over the network, caches in a temp dir)
//       vs eval refined by the published edge rule (`published_expected`)
//       within 0.15 s, then a second run that must come from the
//       result cache. It reports when the early provisional opening and the
//       final OP were published (seconds since the detect started), checks
//       the provisional window against the final one, and that it never
//       reaches the final snapshot or the result cache.
//
// One test here is NOT ignored and needs no stream:
//   skipdetect_region_graph_fills_pts_gaps  a synthetic local file with a 1 s
//       PTS hole, decoded through the production region graph: with
//       `async=1` the hole is filled (sample index == PTS), without it the
//       audio after the hole lands 1 s early. It is the PTS-gap coverage that
//       no longer depends on what a host serves (see GAP_CASE). Skipped, with
//       a note, when no ffmpeg is installed.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::Value;

use super::animethemes::{self, ThemeRec};
use super::audio::{self, RegionPass};
use super::cache::ThemeFp;
use super::corpus_tests::{bench, load_json, pair, read_wav, tag_of};
use super::fingerprint::{fingerprint, SR};
use super::job::{self, Ctx, JobState, Request, Snapshot, EARLY_SOURCE};
use super::matcher;
use super::probe;
use super::themes::{self, Kind, Step};

const TOL: f64 = 0.15;
/// JJK S1E3 (iAHD, DTS-HD MA): a seeked decode need not start at `-ss`, and
/// its audio track has PTS gaps (6.66 s in the first 600 s, the first at
/// 127.5 s). The corpus WAVs and eval were built on the sample clock, which
/// runs EARLY by the summed gaps there, so this case is judged against the
/// frame-verified truth instead of eval, at the corpus "correct" bar (both
/// edges within 2 s: its OP picture starts about 1.8 s before the song on the
/// PTS clock). Gaps under swr's 0.1 s `min_hard_comp` are not filled, so its
/// HEAD length and media end may fall short by up to 0.2 s.
const GAP_CASE: &str = "tt12343534:1:3";
const GAP_CASE_FIRST_GAP_S: f64 = 127.4;
const GAP_CASE_TOL: f64 = 2.0;
const GAP_CASE_RESIDUAL_S: f64 = 0.2;
/// The gap release's HEAD PCM is compared up to its first gap within this many
/// differing samples, not bit-identically. Since 2026-10-07 the host serves a
/// slightly different copy of the same release: the first 600 s now decode to
/// exactly 600.000 s (599.846 s when the corpus was captured) and 159 of the
/// 1,404,034 compared samples differ, with the probe, the argv and the ffmpeg
/// build unchanged and the full detect on the same stream still correct. The
/// cached head.wav is NOT re-captured: the corpus parity tests and both evals
/// were computed from it. 0.1% of the compared span still catches a wrong
/// origin or a different track, each of which changes most samples.
///
/// It CANNOT catch a missing `async=1`: the compare stops at the first gap,
/// and before it the two filters agree sample for sample. Worse, the served
/// copy has no PTS gaps at all any more (2026-10-07: ffprobe finds none over
/// 5 ms in the first 600 s, and HEAD is 600.000 s with or without `async=1`),
/// so this case now only checks the origin and the track. The second decode
/// below says so on every run; the gap path itself is covered by the local
/// `skipdetect_region_graph_fills_pts_gaps`.
const GAP_CASE_PCM_MISMATCH_MAX: usize = 1404;
/// The HEAD cut edge: the corpus head was cut with input `-t`, production
/// with output `-to`, so the resampler flush of the last ~1 ms differs.
const CUT_EDGE_S: f64 = 0.05;

fn ffmpeg() -> OsString {
    if let Some(p) = std::env::var_os("AURA_FFMPEG") {
        return p;
    }
    let la = std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA");
    PathBuf::from(la).join("com.aura.app").join("runtime").join("ffmpeg.exe").into_os_string()
}

fn streams() -> Vec<(String, String)> {
    let raw = std::env::var("AURA_SKIPDETECT_RT_STREAMS")
        .expect("AURA_SKIPDETECT_RT_STREAMS not set: run through the skipbench runtime helper");
    let m: HashMap<String, String> = serde_json::from_str(&raw).expect("AURA_SKIPDETECT_RT_STREAMS is not a JSON object");
    let mut v: Vec<(String, String)> = m.into_iter().collect();
    v.sort();
    assert!(!v.is_empty(), "no streams resolved");
    v
}

struct Ep {
    info: Value,
    row: Value,
    mal: Option<u32>,
    mal_ep: Option<u32>,
}

fn episode(root: &Path, id: &str) -> Ep {
    let info = load_json(&root.join("cache").join(tag_of(id)).join("info.json"));
    let eval = load_json(&root.join("eval_animethemes.json"));
    let row = eval["rows"].as_array().unwrap().iter().find(|r| r["id"] == id).cloned().unwrap_or(Value::Null);
    let num = |v: &Value| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).map(|x| x as u32);
    Ep { mal: num(&row["mal"]), mal_ep: num(&row["mal_ep"]), info, row }
}

/// eval's strict A_full window, clamped like a published one.
fn eval_window(ep: &Ep, slot: &str, media_end: f64) -> Option<(f64, f64)> {
    let (s, e) = pair(&ep.row["eval"]["strict"][slot]["pred"]["A_full"])?;
    Some((s.max(0.0), e.min(media_end)))
}

/// What a slot is judged against: eval within 0.15 s, or for the PTS-gap
/// release the frame-verified truth within 1 s.
fn expected(root: &Path, id: &str, ep: &Ep, slot: &str, media_end: f64) -> (Option<(f64, f64)>, f64, &'static str) {
    if id == GAP_CASE {
        let mut truth = Value::Null;
        for e in std::fs::read_dir(root.join("truth")).unwrap() {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "json") {
                let v = load_json(&p);
                if !v[id].is_null() {
                    truth = v[id].clone();
                }
            }
        }
        return (pair(&truth[slot]), GAP_CASE_TOL, "truth");
    }
    (eval_window(ep, slot, media_end), TOL, "eval")
}

/// The PTS-gap release's PUBLISHED opening (the job's window) against the
/// truth: the edge rule starts it at the theme's audible start, measured
/// 2.28 s after the truth's first frame on the served copy (an under-skip,
/// 0.5 s later than mapping A's 1.78 s), so 2 s no longer holds here.
const GAP_CASE_PUBLISHED_TOL: f64 = 2.5;

/// What the JOB publishes for a slot: eval's strict A_full window refined by
/// the published edge rule (`matcher::refine_edges`), with the theme's
/// audible span from the cached theme decode and the episode's levels from
/// the cached region PCM, re-gridded to the production region origin
/// (`origin`: TAIL's from the snapshot's `ed_region`; HEAD's is the cached
/// one, its PCM is checked bit-identical above). The PTS-gap release is
/// judged against the truth (see GAP_CASE_PUBLISHED_TOL).
fn published_expected(root: &Path, id: &str, ep: &Ep, slot: &str, media_end: f64, origin: Option<f64>) -> (Option<(f64, f64)>, f64, &'static str) {
    if id == GAP_CASE {
        let (w, _, what) = expected(root, id, ep, slot, media_end);
        return (w, GAP_CASE_PUBLISHED_TOL, what);
    }
    let ev = &ep.row["eval"]["strict"][slot];
    let (Some(raw), Some(theme), Some(mal)) = (pair(&ev["pred"]["A_full"]), ev["theme"].as_str(), ep.mal) else {
        return (None, TOL, "eval");
    };
    let tpcm = read_wav(&root.join("themes").join(mal.to_string()).join(format!("{theme}.11k.wav")));
    let reflen = fingerprint(&tpcm, 0.0).duration_s();
    let aud = super::fingerprint::theme_audible(&tpcm);
    let cdir = root.join("cache").join(tag_of(id));
    let which = if slot == "op" { "head" } else { "tail" };
    let pcm = read_wav(&cdir.join(format!("{which}.wav")));
    let t0c = ep.info["passes"][which]["t0"].as_f64().unwrap_or(0.0);
    // Re-grid: the 0.4 s windows start at the production origin.
    let win = super::continuity::RMS_WIN as i64;
    let k = origin.map_or(0, |o| ((o - t0c) * SR as f64).round() as i64).rem_euclid(win) as usize;
    let levels = super::continuity::rms_levels(&pcm[k.min(pcm.len())..]);
    let lv = matcher::RegionLevels { levels: &levels, t0: t0c + k as f64 / SR as f64 };
    let today = (raw.0.max(0.0), raw.1.min(media_end));
    (matcher::refine_edges(raw, today, reflen, true, aud, slot == "ed", Some(lv), media_end), TOL, "eval + edge rule")
}

fn close(a: Option<(f64, f64)>, b: Option<(f64, f64)>, tol: f64) -> (bool, f64) {
    match (a, b) {
        (None, None) => (true, 0.0),
        (Some(a), Some(b)) => {
            let d = (a.0 - b.0).abs().max((a.1 - b.1).abs());
            (d <= tol, d)
        }
        _ => (false, f64::INFINITY),
    }
}

/// The corpus theme files of a MAL id, decoded through the PRODUCTION stdin
/// path and checked bit-identical against the cached file decode.
async fn corpus_themes(root: &Path, mal: u32, ff: &OsString, fails: &mut Vec<String>) -> Vec<(ThemeRec, Arc<ThemeFp>)> {
    let dir = root.join("themes").join(mal.to_string());
    let Ok(text) = std::fs::read_to_string(dir.join("themes.json")) else { return Vec::new() };
    let list: Value = serde_json::from_str(&text).unwrap();
    let mut out = Vec::new();
    for (k, t) in list.as_array().unwrap().iter().enumerate() {
        let base = t["audio_basename"].as_str().unwrap().to_string();
        let overlap = t["overlap"].as_str().unwrap_or("");
        let rec = ThemeRec {
            audio_id: k as u64,
            basename: base.clone(),
            link: String::new(),
            size: 0,
            slug: t["slug"].as_str().unwrap_or("").to_string(),
            op: t["type"].as_str().unwrap_or("").eq_ignore_ascii_case("OP"),
            version: t["version"].as_u64().map(|v| v as u32),
            episodes: t["episodes"].as_str().map(String::from),
            over: overlap == "Over",
            over_partial: false,
            transition: overlap == "Transition",
        };
        let bytes = std::fs::read(dir.join(&base)).unwrap();
        let pcm = audio::decode_theme(ff, bytes).await.unwrap_or_else(|e| panic!("decode {base}: {e}"));
        let cached = read_wav(&dir.join(format!("{base}.11k.wav")));
        if pcm != cached {
            fails.push(format!("theme {base}: stdin decode differs from the cached decode ({} vs {} samples)", pcm.len(), cached.len()));
        }
        let fp = Arc::new(animethemes::theme_fp_from_pcm(&rec, &pcm));
        out.push((rec, fp));
    }
    out
}

/// Layer 1 over a complete region by the production stop policy.
fn layer1(themes_: &[(ThemeRec, Arc<ThemeFp>)], mal: u32, ep: Option<u32>, kind: Kind, q: &super::fingerprint::Fingerprint, media_end: f64) -> Option<(String, (f64, f64))> {
    let metas: Vec<_> = themes_.iter().map(|(r, _)| r.meta(mal)).collect();
    let order = themes::candidate_order(&metas, kind, ep);
    let mut passed = vec![None; metas.len()];
    let mut matches = HashMap::new();
    let mut evals = 0;
    loop {
        match themes::next_step(&metas, &order, &passed, evals) {
            Step::Evaluate(i) => {
                let t = &themes_[i].1;
                let m = matcher::evaluate_theme(&t.fp, t.audible, q);
                passed[i] = Some(m.accepted);
                matches.insert(i, m);
                evals += 1;
            }
            Step::Accept(i) => {
                let w = matcher::layer1_window(&matches[&i], media_end)?;
                return Some((themes_[i].0.label(), w));
            }
            Step::Exhausted | Step::CapReached => return None,
        }
    }
}

struct Pass {
    pcm: Vec<i16>,
    origin: Option<f64>,
    success: bool,
    wall: f64,
}

async fn read_pass(ff: &OsString, args: &[String], rebase: f64) -> Pass {
    let t = Instant::now();
    let mut pass = RegionPass::spawn(ff, args, rebase).expect("spawn ffmpeg");
    let mut pcm = Vec::new();
    loop {
        match pass.next_pcm().await {
            Ok(Some(c)) => pcm.extend(c),
            Ok(None) => break,
            Err(e) => panic!("region read failed: {e}"),
        }
    }
    let end = pass.finish().await;
    Pass { pcm, origin: probe::region_origin(end.first_pts, rebase), success: end.success, wall: t.elapsed().as_secs_f64() }
}

fn mismatches(a: &[i16], b: &[i16]) -> usize {
    a.iter().zip(b).filter(|(x, y)| x != y).count()
}

/// Zero crossings per second and RMS of `pcm[from_s..to_s]` (11025 Hz).
fn tone_at(pcm: &[i16], from_s: f64, to_s: f64) -> (f64, f64) {
    let (a, b) = ((from_s * SR as f64) as usize, ((to_s * SR as f64) as usize).min(pcm.len()));
    let w = &pcm[a.min(b)..b];
    let zc = w.windows(2).filter(|p| (p[0] < 0) != (p[1] < 0)).count() as f64;
    let rms = (w.iter().map(|&x| (x as f64) * (x as f64)).sum::<f64>() / w.len().max(1) as f64).sqrt();
    (zc / (to_s - from_s), rms)
}

/// The PTS-gap path of the region graph, on a synthetic local file: 10 s of
/// audio (440 Hz to 5 s, then a 1000 Hz marker) with every frame from 5 s on
/// shifted 1 s later, so the track has a 1 s PTS hole at 5-6 s. Through the
/// production graph (`aresample=11025:async=1`) the decode is ~11 s and the
/// marker sits at its PTS (6 s on); with plain `aresample` it is ~10 s and the
/// marker lands at 5 s, 1 s early, which is how JJK S1E3's OP and ED were once
/// placed 1.75 s and 2.2 s early.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn skipdetect_region_graph_fills_pts_gaps() {
    let ff = ffmpeg();
    if !Path::new(&ff).exists() {
        println!("skipped: no ffmpeg at {} (set AURA_FFMPEG)", Path::new(&ff).display());
        return;
    }
    let dir = std::env::temp_dir().join(format!("aura-gap-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("gap.mka");
    let made = std::process::Command::new(&ff)
        .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "lavfi", "-i"])
        .arg(r"aevalsrc=exprs=if(lt(t\,5)\,0.5*sin(2*PI*440*t)\,0.5*sin(2*PI*1000*t)):s=48000:d=10:n=1000")
        .args(["-af", r"asetpts=PTS+if(gte(T\,5)\,1/TB\,0)", "-c:a", "pcm_s16le"])
        .arg(&file)
        .status()
        .expect("spawn ffmpeg");
    assert!(made.success(), "could not build the synthetic gap file");
    // The production argv, reading a local file (the protocol whitelist is the
    // only change: production never opens one).
    let local = |graph: &dyn Fn(String) -> String| -> Vec<String> {
        probe::head_args(file.to_str().unwrap(), 0)
            .into_iter()
            .map(|a| if a.starts_with("http,") { format!("file,{a}") } else { graph(a) })
            .collect()
    };
    let fixed = read_pass(&ff, &local(&|a| a), 0.0).await;
    let plain = read_pass(&ff, &local(&|a| a.replace(":async=1", "")), 0.0).await;
    let _ = std::fs::remove_dir_all(&dir);
    assert!(fixed.success && plain.success, "decode failed");
    let secs = |p: &Pass| p.pcm.len() as f64 / SR as f64;
    println!("[gap] async=1 {:.3}s origin {:?}; plain {:.3}s", secs(&fixed), fixed.origin, secs(&plain));
    assert!(fixed.origin.is_some_and(|o| o.abs() < 0.01), "origin {:?}", fixed.origin);
    assert!((secs(&fixed) - 11.0).abs() < 0.1, "async=1 must fill the 1 s hole: {:.3}s", secs(&fixed));
    assert!((secs(&plain) - 10.0).abs() < 0.1, "plain aresample keeps the hole out: {:.3}s", secs(&plain));
    // 440 Hz = ~880 crossings/s, 1000 Hz = ~2000/s.
    let (zc, _) = tone_at(&fixed.pcm, 4.0, 4.8);
    assert!((zc - 880.0).abs() < 60.0, "440 Hz before the hole: {zc:.0}/s");
    let (_, rms) = tone_at(&fixed.pcm, 5.2, 5.8);
    assert!(rms < 50.0, "the hole is silence at its PTS: rms {rms:.0}");
    let (zc, _) = tone_at(&fixed.pcm, 6.2, 7.0);
    assert!((zc - 2000.0).abs() < 100.0, "marker at its PTS (6 s on): {zc:.0}/s");
    let (zc, _) = tone_at(&plain.pcm, 5.2, 5.8);
    assert!((zc - 2000.0).abs() < 100.0, "without async=1 the marker lands 1 s early: {zc:.0}/s");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs AURA_SKIPBENCH_DIR + AURA_SKIPDETECT_RT_STREAMS (real streams)"]
async fn skipdetect_runtime_parity() {
    let root = bench();
    let ff = ffmpeg();
    let mut fails: Vec<String> = Vec::new();
    for (id, url) in streams() {
        let ep = episode(&root, &id);
        let cdir = root.join("cache").join(tag_of(&id));
        println!("[rt] ===== {id} ({})", ep.info["release"]["name"].as_str().unwrap_or("?"));

        // Probe and the track rule.
        let p = audio::run_probe(&ff, &url).await.unwrap_or_else(|e| panic!("{id}: {}", e.note()));
        let (n, why) = probe::pick_track(&p.audio).expect("audio track");
        let tr = &p.audio[n];
        let want_abs = ep.info["analysis_audio_stream"].as_u64().unwrap() as usize;
        println!(
            "[rt] {id} probe: container {:?} start {:.3} track 0:a:{n} abs {} ({:?}, {}) tag {:?}",
            p.container_duration,
            p.start,
            tr.abs,
            tr.lang,
            why.as_str(),
            tr.duration_tag
        );
        if tr.abs != want_abs {
            fails.push(format!("{id}: mapped stream #{} but the corpus analysed #{want_abs}", tr.abs));
        }
        let cached_dur = ep.info["duration"].as_f64().unwrap();
        if let Some(c) = p.container_duration {
            if (c - cached_dur).abs() > 0.011 {
                fails.push(format!("{id}: container {c} vs cached {cached_dur} (release changed?)"));
            }
        }

        // HEAD: production argv, full 600 s.
        let head = read_pass(&ff, &probe::head_args(&url, n), 0.0).await;
        let head_wav = read_wav(&cdir.join("head.wav"));
        let lim = (600 * SR as usize).min(head_wav.len());
        // Exclude the cut edge; on the gap release compare only up to its first gap.
        let upto = if id == GAP_CASE { (GAP_CASE_FIRST_GAP_S * SR as f64) as usize } else { lim };
        let cmp = head.pcm.len().min(upto).saturating_sub((CUT_EDGE_S * SR as f64) as usize);
        let mm = mismatches(&head.pcm[..cmp], &head_wav[..cmp]);
        println!(
            "[rt] {id} HEAD origin {:?} samples {} ({:.3}s) vs cached {} ({:.3}s): {mm} of {cmp} compared differ, {:.1}s wall",
            head.origin,
            head.pcm.len(),
            head.pcm.len() as f64 / SR as f64,
            lim,
            lim as f64 / SR as f64,
            head.wall
        );
        if !head.success {
            fails.push(format!("{id}: HEAD exit not clean"));
        }
        match head.origin {
            Some(o) if o.abs() <= 0.05 => {}
            o => fails.push(format!("{id}: HEAD origin {o:?}, expected 0")),
        }
        let len_tol = if id == GAP_CASE { GAP_CASE_RESIDUAL_S } else { CUT_EDGE_S };
        let mm_max = if id == GAP_CASE { GAP_CASE_PCM_MISMATCH_MAX } else { 0 };
        if mm > mm_max || (head.pcm.len() as i64 - (600 * SR) as i64).abs() > (len_tol * SR as f64) as i64 {
            fails.push(format!("{id}: HEAD PCM not bit-identical ({mm} samples differ, {} vs {lim})", head.pcm.len()));
        }
        if id == GAP_CASE {
            // Does the served copy still have PTS gaps? Without `async=1` a
            // gapped track decodes SHORTER (the holes are not filled). The
            // gap-free copy is accepted (the host decides what it serves), so
            // this is a note, not a failure: the gap path is covered by
            // `skipdetect_region_graph_fills_pts_gaps` instead.
            let plain: Vec<String> =
                probe::head_args(&url, n).into_iter().map(|a| a.replace(":async=1", "")).collect();
            let head_plain = read_pass(&ff, &plain, 0.0).await;
            let (a, b) = (head.pcm.len() as f64 / SR as f64, head_plain.pcm.len() as f64 / SR as f64);
            if (a - b).abs() <= 0.1 {
                println!(
                    "[rt] {id} NOTE: GAP_CASE no longer has PTS gaps ({a:.3}s with async=1, {b:.3}s without): \
                     this case covers origin and track only; re-select a gap release to test gaps on a real stream"
                );
            } else {
                println!("[rt] {id} PTS gaps present: {a:.3}s with async=1, {b:.3}s without");
            }
        }

        // TAIL: production S.
        let s = probe::tail_start(p.container_duration, tr.duration_tag).unwrap();
        let tail = read_pass(&ff, &probe::tail_args(&url, n, s), p.start).await;
        let o = tail.origin.unwrap_or(f64::NAN);
        let media_end = probe::media_end(o, tail.pcm.len() as u64);
        let t0_cached = ep.info["tail_offset"].as_f64().unwrap();
        let tail_wav = read_wav(&cdir.join("tail.wav"));
        let cached_end = t0_cached + tail_wav.len() as f64 / SR as f64;
        println!(
            "[rt] {id} TAIL S {s:.3} origin {o:.3} (delta {:+.3}) media_end {media_end:.3} (tag {:?}, cached read {cached_end:.3}, cached t0 {t0_cached:.3}), {:.1}s wall",
            o - s,
            tr.duration_tag,
            tail.wall
        );
        if !tail.success {
            fails.push(format!("{id}: TAIL exit not clean"));
        }
        if !o.is_finite() {
            fails.push(format!("{id}: TAIL first-PTS line missing"));
            continue;
        }
        if id != GAP_CASE && (o - s).abs() > 0.05 {
            fails.push(format!("{id}: TAIL origin {o:.3} vs S {s:.3}"));
        }
        if let Some(tag) = tr.duration_tag {
            let tol = if id == GAP_CASE { GAP_CASE_RESIDUAL_S } else { 0.05 };
            if (media_end - tag).abs() > tol {
                fails.push(format!("{id}: media end {media_end:.3} vs DURATION tag {tag:.3}"));
            }
        }
        if id != GAP_CASE && (media_end - cached_end).abs() > TOL {
            fails.push(format!("{id}: media end {media_end:.3} vs cached read {cached_end:.3}"));
        }
        // Tail PCM: bit-identical where the production start is the cached one.
        let lag = (o - t0_cached) * SR as f64;
        if id != GAP_CASE && (lag - lag.round()).abs() < 1e-6 && lag >= 0.0 {
            let lag = lag.round() as usize;
            let a = &tail.pcm;
            let b = &tail_wav[lag.min(tail_wav.len())..];
            let k = a.len().min(b.len());
            let mm = mismatches(&a[..k], &b[..k]);
            println!("[rt] {id} TAIL PCM vs cached at lag {lag}: {mm} of {k} differ");
            if mm != 0 {
                fails.push(format!("{id}: TAIL PCM not bit-identical ({mm} differ)"));
            }
        } else {
            println!("[rt] {id} TAIL PCM: production S is not sample-aligned with the cached read; windows compared instead");
        }

        // Layer 1 on the real regions vs eval.
        let Some(mal) = ep.mal else {
            println!("[rt] {id} no MAL id in eval; Layer 1 skipped");
            continue;
        };
        let th = corpus_themes(&root, mal, &ff, &mut fails).await;
        let hq = fingerprint(&head.pcm[..head.pcm.len().min(600 * SR as usize)], head.origin.unwrap_or(0.0));
        let tq = fingerprint(&tail.pcm, o);
        let est = probe::early_media_end(tr.duration_tag, p.container_duration).unwrap_or(cached_dur);
        for (slot, kind, q, me) in [("op", Kind::Op, &hq, est), ("ed", Kind::Ed, &tq, media_end)] {
            let got = layer1(&th, mal, ep.mal_ep, kind, q, me);
            let (want, tol, what) = expected(&root, &id, &ep, slot, me);
            let (ok, d) = close(got.as_ref().map(|g| g.1), want, tol);
            println!(
                "[rt] {id} {slot}: got {:?} want {what} {:?} dev {d:.3} (eval {:?}) {}",
                got,
                want,
                eval_window(&ep, slot, me),
                if ok { "ok" } else { "FAIL" }
            );
            if !ok {
                fails.push(format!("{id} {slot}: {got:?} vs {what} {want:?} (dev {d:.3})"));
            }
            if let (Some((_, w)), Kind::Ed) = (&got, kind) {
                if w.1 > media_end + 1e-9 {
                    fails.push(format!("{id}: ED end {} past media end {media_end}", w.1));
                }
            }
        }
    }
    for f in &fails {
        println!("[rt] FAIL {f}");
    }
    assert!(fails.is_empty(), "{} runtime parity failure(s)", fails.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "needs AURA_SKIPBENCH_DIR + AURA_SKIPDETECT_RT_STREAMS (real streams, AnimeThemes GETs)"]
async fn skipdetect_runtime_detect() {
    let root = bench();
    let ff = ffmpeg();
    let only: Option<Vec<String>> =
        std::env::var("AURA_SKIPDETECT_RT_JOB").ok().map(|s| s.split(',').map(|x| x.trim().to_string()).collect());
    let dir = std::env::temp_dir().join(format!("aura-skipdetect-rt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut fails: Vec<String> = Vec::new();
    for (id, url) in streams() {
        if only.as_ref().is_some_and(|o| !o.contains(&id)) {
            continue;
        }
        let ep = episode(&root, &id);
        let info = &ep.info;
        let req: Request = serde_json::from_value(serde_json::json!({
            "url": url,
            "stremio_id": id,
            "media_type": "series",
            "addon": "runtime-test",
            "release": info["release"]["filename"],
            "duration": info["duration"],
            "mal_id": ep.mal,
            "mal_source": "eval",
            "mal_episode": ep.mal_ep,
            "anime": true,
        }))
        .unwrap();
        let req = req.validate().unwrap();
        for round in 0..2u64 {
            let t = Instant::now();
            let seen: Arc<Mutex<Vec<(f64, Snapshot)>>> = Arc::new(Mutex::new(Vec::new()));
            let seen2 = seen.clone();
            let ctx = Ctx {
                ffmpeg: ff.clone(),
                data_dir: Some(dir.clone()),
                generation: 1 + round,
                publish: Arc::new(move |s: &Snapshot| seen2.lock().unwrap().push((t.elapsed().as_secs_f64(), s.clone()))),
                replay: None,
                fake_theme_load: None,
            };
            let s = job::run(&ctx, &req).await;
            let wall = t.elapsed().as_secs_f64();
            let is_early = |s: &Snapshot| s.op.as_ref().is_some_and(|w| w.source == EARLY_SOURCE);
            let first_op = seen
                .lock()
                .unwrap()
                .iter()
                .find(|(_, s)| s.op.is_some() && !is_early(s))
                .map(|(t, s)| (*t, s.ed.is_some()));
            // The early provisional opening: first publish, its window, and
            // how often it was withdrawn (op went from early to none).
            let (early, withdrawn) = {
                let v = seen.lock().unwrap();
                let early = v.iter().find(|(_, s)| is_early(s)).map(|(t, s)| (*t, s.op.clone().unwrap()));
                let mut withdrawn = 0;
                for w in v.windows(2) {
                    if is_early(&w[0].1) && w[1].1.op.is_none() {
                        withdrawn += 1;
                    }
                }
                (early, withdrawn)
            };
            let me = s.media_end.unwrap_or(f64::NAN);
            println!(
                "[rt-job] {id} round {round}: {:.1}s, cache {}, op {:?} ed {:?} media_end {me:.3} final {} notes {:?}/{:?}; first OP publish {:?}",
                wall,
                s.from_cache,
                s.op.as_ref().map(|w| (w.start, w.end, w.theme.clone(), w.auto_eligible)),
                s.ed.as_ref().map(|w| (w.start, w.end, w.theme.clone(), w.auto_eligible)),
                s.media_end_final,
                s.op_note,
                s.ed_note,
                first_op
            );
            println!(
                "[rt-job] {id} round {round}: early prompt {}; final OP {}; withdrawn {withdrawn} time(s)",
                early.as_ref().map_or("none".to_string(), |(t, w)| format!(
                    "at {t:.1}s [{:.2}, {:.2}] {} run {:?}",
                    w.start,
                    w.end,
                    w.theme.as_deref().unwrap_or("?"),
                    w.run_s
                )),
                first_op.map_or("none".to_string(), |(t, _)| format!("at {t:.1}s"))
            );
            if is_early(&s) || s.ed.as_ref().is_some_and(|w| w.source == EARLY_SOURCE) {
                fails.push(format!("{id} round {round}: the final snapshot holds the provisional window"));
            }
            if let Some((te, w)) = &early {
                if w.auto_eligible {
                    fails.push(format!("{id}: provisional window marked auto-eligible"));
                }
                if round == 1 {
                    fails.push(format!("{id}: a result-cache hit published a provisional window"));
                }
                match (&s.op, first_op) {
                    (Some(fin), Some((tf, _))) => {
                        // Same start rule; the final END may be cut earlier
                        // than the provisional one (the edge rule's onset cut
                        // needs the finished region), never later.
                        let d = (fin.start - w.start).abs().max(fin.end - w.end);
                        if d > 0.5 {
                            fails.push(format!("{id}: provisional [{:.2}, {:.2}] vs final [{:.2}, {:.2}]", w.start, w.end, fin.start, fin.end));
                        }
                        if *te > tf {
                            fails.push(format!("{id}: provisional published after the final window"));
                        }
                    }
                    _ => println!("[rt-job] {id}: provisional window with no final OP (withdrawn {withdrawn})"),
                }
            }
            if s.state != JobState::Done {
                fails.push(format!("{id} round {round}: state {:?}", s.state));
            }
            // The final snapshot settles every kind it was asked for, and a
            // Layer 1 window always reads as matched.
            for (slot, l1, w) in [("op", s.op_l1, &s.op), ("ed", s.ed_l1, &s.ed)] {
                if matches!(l1, super::job::L1State::Pending | super::job::L1State::Unknown) {
                    fails.push(format!("{id} round {round} {slot}: layer 1 state {l1:?} in the final snapshot"));
                }
                if w.as_ref().is_some_and(|w| w.source == "animethemes") && l1 != super::job::L1State::Matched {
                    fails.push(format!("{id} round {round} {slot}: Layer 1 window but state {l1:?}"));
                }
            }
            if round == 1 && !s.from_cache {
                fails.push(format!("{id}: second run did not come from the result cache"));
            }
            if !s.media_end_final {
                fails.push(format!("{id} round {round}: media end not final"));
            }
            for (slot, w) in [("op", &s.op), ("ed", &s.ed)] {
                let origin = if slot == "ed" { s.ed_region.map(|r| r.0) } else { None };
                let (want, tol, what) = published_expected(&root, &id, &ep, slot, me, origin);
                let got = w.as_ref().map(|w| (w.start, w.end));
                let (ok, d) = close(got, want, tol);
                if !ok {
                    fails.push(format!("{id} round {round} {slot}: {got:?} vs {what} {want:?} (dev {d:.3})"));
                }
                if let Some(w) = w {
                    // A Transition-only ending is prompt-only by design.
                    if w.source == "animethemes" && !w.auto_eligible && !w.transition {
                        fails.push(format!("{id} {slot}: Layer 1 window not auto-eligible"));
                    }
                }
            }
            if let Some(ed) = &s.ed {
                if ed.end > me + 1e-9 {
                    fails.push(format!("{id}: ED end {} past media end {me}", ed.end));
                }
            }
            if round == 0 {
                if let (Some((t_op, ed_known)), Some(op)) = (first_op, &s.op) {
                    // Published while HEAD was still running: before any ED.
                    if ed_known {
                        fails.push(format!("{id}: OP first published together with the ED (no early publish)"));
                    }
                    println!("[rt-job] {id} OP [{:.2}, {:.2}] first published at {t_op:.1}s of {wall:.1}s", op.start, op.end);
                }
            }
        }
    }
    // Layer 3 through the real job: the same streams without a MAL id (no
    // AnimeThemes) for the ids in AURA_SKIPDETECT_RT_L3, vs eval_continuity's
    // recommended picks within 0.2 s. Prompt-only, never auto.
    let l3: Vec<String> = std::env::var("AURA_SKIPDETECT_RT_L3")
        .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
        .unwrap_or_default();
    let cont = load_json(&root.join("eval_continuity.json"));
    for (id, url) in streams() {
        if !l3.contains(&id) {
            continue;
        }
        let ep = episode(&root, &id);
        let req: Request = serde_json::from_value(serde_json::json!({
            "url": url,
            "stremio_id": id,
            "media_type": "series",
            "addon": "runtime-test",
            "release": format!("{}#layer3", ep.info["release"]["filename"].as_str().unwrap_or("")),
            "duration": ep.info["duration"],
            "anime": true,
        }))
        .unwrap();
        let req = req.validate().unwrap();
        let ctx = Ctx { ffmpeg: ff.clone(), data_dir: Some(dir.clone()), generation: 9, publish: Arc::new(|_: &Snapshot| {}), replay: None, fake_theme_load: None };
        let t = Instant::now();
        let s = job::run(&ctx, &req).await;
        let row = cont["episodes"].as_array().unwrap().iter().find(|r| r["id"] == id.as_str()).cloned().unwrap_or(Value::Null);
        println!(
            "[rt-l3] {id}: {:.1}s op {:?} ed {:?} notes {:?}/{:?}",
            t.elapsed().as_secs_f64(),
            s.op.as_ref().map(|w| (w.start, w.end, w.source.clone(), w.auto_eligible)),
            s.ed.as_ref().map(|w| (w.start, w.end, w.source.clone(), w.auto_eligible)),
            s.op_note,
            s.ed_note
        );
        for (slot, w) in [("op", &s.op), ("ed", &s.ed)] {
            let want = pair(&row[slot]["recommended"]["pred"]);
            let got = w.as_ref().map(|w| (w.start, w.end));
            let (ok, d) = close(got, want, 0.2);
            println!("[rt-l3] {id} {slot}: got {got:?} want {want:?} dev {d:.3} {}", if ok { "ok" } else { "FAIL" });
            if !ok {
                fails.push(format!("{id} layer3 {slot}: {got:?} vs eval_continuity {want:?} (dev {d:.3})"));
            }
            if let Some(w) = w {
                if w.source != "continuity" || w.auto_eligible {
                    fails.push(format!("{id} layer3 {slot}: {} auto {}", w.source, w.auto_eligible));
                }
            }
        }
    }
    let fps = std::fs::read_dir(dir.join(super::cache::THEME_FP_DIR)).map(|d| d.count()).unwrap_or(0);
    println!("[rt-job] caches: {} theme fingerprint(s), {} bytes total", fps, super::cache::total_bytes(&dir));
    if fps == 0 {
        fails.push("no theme fingerprint cached".into());
    }
    let _ = std::fs::remove_dir_all(&dir);
    for f in &fails {
        println!("[rt-job] FAIL {f}");
    }
    assert!(fails.is_empty(), "{} runtime detect failure(s)", fails.len());
}

/// The Next-Up theme prefetch against the real AnimeThemes API (GET only,
/// paced; no stream involved): the list and the top-ranked theme of each kind
/// land in a temp cache, and a second prefetch finds them all cached.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs network (AnimeThemes GETs) and ffmpeg"]
async fn skipdetect_runtime_prefetch() {
    let ff = ffmpeg();
    let dir = std::env::temp_dir().join(format!("aura-skipdetect-prefetch-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let req: job::PrefetchRequest =
        serde_json::from_value(serde_json::json!({"mal_id": 56784, "mal_episode": 2})).unwrap();
    let req = req.validate().unwrap();
    let t = Instant::now();
    let first = job::prefetch(&ff, &dir, &req).await;
    println!("[rt-prefetch] first: {:?} in {:.1}s", first, t.elapsed().as_secs_f64());
    let t = Instant::now();
    let second = job::prefetch(&ff, &dir, &req).await;
    println!("[rt-prefetch] second: {:?} in {:.1}s", second, t.elapsed().as_secs_f64());
    let fps = std::fs::read_dir(dir.join(super::cache::THEME_FP_DIR)).map(|d| d.count()).unwrap_or(0);
    let tmp_left = std::fs::read_dir(&dir)
        .unwrap()
        .chain(std::fs::read_dir(dir.join(super::cache::THEME_FP_DIR)).unwrap())
        .filter_map(|e| e.ok())
        .any(|e| e.path().extension().is_some_and(|x| x == "tmp"));
    let bytes = super::cache::total_bytes(&dir);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(first.themes.len(), 2, "one OP and one ED: {first:?}");
    assert!(first.themes.iter().all(|(_, downloaded)| *downloaded), "{first:?}");
    assert_eq!(second.themes.len(), 2);
    assert!(second.themes.iter().all(|(_, downloaded)| !*downloaded), "the second prefetch must be all cache: {second:?}");
    assert_eq!(fps, 2, "two fingerprints cached");
    assert!(!tmp_left, "a .tmp was left behind");
    println!("[rt-prefetch] cache {bytes} bytes (fingerprints only, no audio)");
    assert!(bytes < 200_000, "the cache holds fingerprints, never audio ({bytes} bytes)");
}
