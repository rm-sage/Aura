// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/corpus_tests.rs
//
// Parity tests against the skipbench research corpus (31 real episodes, cached
// audio, frame-verified truth). Ignored by default: they need the corpus on
// disk. Run them with
//
//   AURA_SKIPBENCH_DIR=<scratchpad>\skipbench cargo test skipdetect -- --include-ignored --nocapture
//
// They read only cached PCM (`cache/<tag>/{head,tail}.wav`, `themes/<mal>/*.11k.wav`),
// `info.json` silences / origins, and the reference outputs
// (`eval_animethemes.json`, `eval_continuity.json`, `pre_gates.json`,
// `parity/*` from `parity/dump.py`). No network, no ffmpeg, and nothing that
// could carry a URL is printed (themes.json holds audio links; only basenames
// are read from it).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde_json::Value;

use super::continuity::{self, Region, Silence};
use super::fingerprint::{fingerprint, theme_audible, Fingerprint, SR};
use super::matcher::{evaluate_theme, ThemeMatch};
use super::themes::{candidate_order, next_step, Kind, Step, ThemeMeta};

const HEAD_SAMPLES: usize = 600 * SR as usize;

pub(super) fn bench() -> PathBuf {
    let d = std::env::var_os("AURA_SKIPBENCH_DIR")
        .expect("set AURA_SKIPBENCH_DIR to the skipbench directory to run the corpus parity tests");
    PathBuf::from(d)
}

pub(super) fn load_json(p: &Path) -> Value {
    let s = std::fs::read_to_string(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    serde_json::from_str(&s).unwrap_or_else(|e| panic!("parse {}: {e}", p.display()))
}

/// Minimal RIFF reader for the corpus's mono 11025 Hz s16 WAVs.
pub(super) fn read_wav(p: &Path) -> Vec<i16> {
    let b = std::fs::read(p).unwrap_or_else(|e| panic!("read {}: {e}", p.display()));
    assert!(b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE", "{} is not a WAV", p.display());
    let mut i = 12;
    let mut fmt_ok = false;
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let size = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        let body = i + 8;
        if id == b"fmt " {
            let ch = u16::from_le_bytes([b[body + 2], b[body + 3]]);
            let rate = u32::from_le_bytes([b[body + 4], b[body + 5], b[body + 6], b[body + 7]]);
            let bits = u16::from_le_bytes([b[body + 14], b[body + 15]]);
            assert!(ch == 1 && rate == SR && bits == 16, "{}: {ch} ch {rate} Hz {bits} bit", p.display());
            fmt_ok = true;
        } else if id == b"data" {
            assert!(fmt_ok, "{}: data before fmt", p.display());
            let end = (body + size).min(b.len());
            return b[body..end].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        }
        i = body + size + (size & 1);
    }
    panic!("{}: no data chunk", p.display());
}

pub(super) fn tag_of(id: &str) -> String {
    id.replace(':', "_")
}

fn f(v: &Value) -> Option<f64> {
    v.as_f64()
}

pub(super) fn pair(v: &Value) -> Option<(f64, f64)> {
    let a = v.as_array()?;
    Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))
}

fn silences(v: &Value) -> Vec<Silence> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let s = s.as_array()?;
                    Some(Silence { start: s[0].as_f64()?, end: s[1].as_f64()?, dur: s[2].as_f64()? })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Run `work(i)` for i in 0..n on all cores, results in index order.
fn par_map<T: Send>(n: usize, work: impl Fn(usize) -> T + Sync) -> Vec<T> {
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<T>>> = Mutex::new((0..n).map(|_| None).collect());
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(n.max(1));
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= n {
                    break;
                }
                let r = work(i);
                out.lock().unwrap()[i] = Some(r);
            });
        }
    });
    out.into_inner().unwrap().into_iter().map(|x| x.expect("worker result")).collect()
}

// ── fingerprint bit parity ──────────────────────────────────────────────────

fn bits_of(codes: usize) -> u64 {
    32 * codes as u64
}

#[test]
#[ignore = "needs AURA_SKIPBENCH_DIR (skipbench corpus)"]
fn skipdetect_fingerprint_bit_parity() {
    let root = bench();
    let pdir = root.join("parity");
    let index = load_json(&pdir.join("index.json"));
    let items = index.as_array().expect("parity/index.json (run parity/dump.py)").clone();
    let res = par_map(items.len(), |k| {
        let it = &items[k];
        let name = it["name"].as_str().unwrap().to_string();
        let samples = it["samples"].as_u64().unwrap() as usize;
        let pcm = read_wav(&root.join(it["wav"].as_str().unwrap()));
        let fp = fingerprint(&pcm[..samples.min(pcm.len())], 0.0);
        let codes: Vec<u32> = std::fs::read(pdir.join(format!("{name}.codes")))
            .unwrap()
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect();
        let valid: Vec<bool> = std::fs::read(pdir.join(format!("{name}.valid"))).unwrap().iter().map(|&b| b != 0).collect();
        (name, fp, codes, valid)
    });
    let (mut tot_bits, mut tot_same, mut tot_vbits, mut tot_vsame) = (0u64, 0u64, 0u64, 0u64);
    for (name, fp, codes, valid) in &res {
        assert_eq!(fp.len(), codes.len(), "{name}: code count");
        let mut same = 0u64;
        let (mut vbits, mut vsame) = (0u64, 0u64);
        let mut mask_agree = 0usize;
        for i in 0..codes.len() {
            let s = 32 - (fp.codes[i] ^ codes[i]).count_ones() as u64;
            same += s;
            if valid[i] && fp.valid[i] {
                vbits += 32;
                vsame += s;
            }
            if valid[i] == fp.valid[i] {
                mask_agree += 1;
            }
        }
        let bits = bits_of(codes.len());
        let p = same as f64 / bits as f64;
        let pv = vsame as f64 / vbits.max(1) as f64;
        let pm = mask_agree as f64 / codes.len() as f64;
        println!(
            "[parity] {name:40} codes {:6} differing bits {:4} bits {:.6} valid-bits {:.6} mask {:.6}",
            codes.len(),
            bits_of(codes.len()) - same,
            p,
            pv,
            pm
        );
        assert!(p >= 0.995, "{name}: bit parity {p}");
        assert!(pv >= 0.995, "{name}: valid-code bit parity {pv}");
        assert!(pm >= 0.995, "{name}: valid-mask agreement {pm}");
        tot_bits += bits;
        tot_same += same;
        tot_vbits += vbits;
        tot_vsame += vsame;
    }
    println!(
        "[parity] overall bits {:.5} valid-bits {:.5} over {} items",
        tot_same as f64 / tot_bits as f64,
        tot_vsame as f64 / tot_vbits as f64,
        res.len()
    );
}

// ── Layer 1 parity ──────────────────────────────────────────────────────────

struct ThemeRow {
    base: String,
    meta: ThemeMeta,
    over_str: bool,
}

fn themes_of(root: &Path, mal: u64) -> Vec<ThemeRow> {
    let p = root.join("themes").join(mal.to_string()).join("themes.json");
    if !p.exists() {
        return Vec::new();
    }
    load_json(&p)
        .as_array()
        .unwrap()
        .iter()
        .map(|t| {
            let kind = if t["type"].as_str().unwrap_or("").eq_ignore_ascii_case("OP") { Kind::Op } else { Kind::Ed };
            let overlap = t["overlap"].as_str().unwrap_or("");
            ThemeRow {
                base: t["audio_basename"].as_str().unwrap().to_string(),
                meta: ThemeMeta {
                    slug: t["slug"].as_str().unwrap_or("").to_string(),
                    kind,
                    episodes: t["episodes"].as_str().map(String::from),
                    over: overlap == "Over",
                    transition: overlap == "Transition",
                },
                over_str: overlap == "Over",
            }
        })
        .collect()
}

/// `at_eval/run.py classify` (correct <= 2 s, near <= 5 s, with the truth's
/// recorded non-story slack).
fn classify(pred: Option<(f64, f64)>, truth: &Value, slot: &str) -> &'static str {
    let tr = pair(&truth[slot]);
    match (pred, tr) {
        (None, None) => "correct-abstain",
        (Some(_), None) => "false-positive",
        (None, Some(_)) => "abstained",
        (Some(p), Some(t)) => {
            let tol = 2.0;
            let (ds, de) = (p.0 - t.0, p.1 - t.1);
            let lo_s = if slot == "ed" { f(&truth["ed_start_min"]) } else { None };
            let hi_e = if slot == "op" { f(&truth["op_end_max"]) } else { None };
            let eds = match lo_s {
                Some(lo) if lo - tol <= p.0 && p.0 <= t.0 + tol => 0.0,
                _ => ds.abs(),
            };
            let ede = match hi_e {
                Some(hi) if t.1 - tol <= p.1 && p.1 <= hi + tol => 0.0,
                _ => de.abs(),
            };
            let m = eds.max(ede);
            if m <= tol {
                "correct"
            } else if m <= 5.0 {
                "near"
            } else {
                "wrong"
            }
        }
    }
}

struct SlotResult {
    theme: Option<String>,
    window: Option<(f64, f64)>,
    soft42: Option<f64>,
    margin: Option<f64>,
    /// Theme the production policy (proximity order + next_step) accepts.
    policy_theme: Option<String>,
    policy_evals: usize,
    /// Accept decision of the pick at a 384-sample decode phase.
    phase384: Option<(bool, Option<(f64, f64)>)>,
    /// Old (30 s floor only) pick, for diagnosing a gate disagreement.
    old_theme: Option<String>,
}

struct EpResult {
    id: String,
    op: SlotResult,
    ed: SlotResult,
    audible_dev: f64,
}

fn pick(cands: &[(usize, &ThemeMatch)]) -> Option<usize> {
    // Python max(key=(longest_run_s, -run_ber)): the FIRST maximal element.
    let mut best: Option<(usize, f64, f64)> = None;
    for &(i, m) in cands {
        let key = (m.longest_run_s, -m.run_ber.unwrap_or(1.0));
        match best {
            Some((_, a, b)) if !(key.0 > a || (key.0 == a && key.1 > b)) => {}
            _ => best = Some((i, key.0, key.1)),
        }
    }
    best.map(|b| b.0)
}

fn slot_eval(
    themes: &[ThemeRow],
    refs: &[(Fingerprint, (f64, f64))],
    q: &Fingerprint,
    q_pcm: &[i16],
    kind: Kind,
    mal_ep: Option<u32>,
) -> SlotResult {
    let idx: Vec<usize> = (0..themes.len())
        .filter(|&i| themes[i].meta.kind == kind && !(kind == Kind::Ed && themes[i].over_str))
        .collect();
    let all_kind: Vec<usize> = (0..themes.len()).filter(|&i| themes[i].meta.kind == kind).collect();
    let mut matches: HashMap<usize, ThemeMatch> = HashMap::new();
    for &i in &all_kind {
        matches.insert(i, evaluate_theme(&refs[i].0, refs[i].1, q));
    }
    let acc: Vec<(usize, &ThemeMatch)> = idx.iter().map(|&i| (i, &matches[&i])).filter(|(_, m)| m.accepted).collect();
    let old: Vec<(usize, &ThemeMatch)> =
        idx.iter().map(|&i| (i, &matches[&i])).filter(|(_, m)| m.raw_window.is_some()).collect();
    let p = pick(&acc);
    let old_p = pick(&old);
    // Production policy over the complete region.
    let metas: Vec<ThemeMeta> = themes.iter().map(|t| t.meta.clone()).collect();
    let order = candidate_order(&metas, kind, mal_ep);
    let mut passed: Vec<Option<bool>> = vec![None; themes.len()];
    let mut evals = 0;
    let policy = loop {
        match next_step(&metas, &order, &passed, evals) {
            Step::Evaluate(i) => {
                passed[i] = Some(matches[&i].accepted);
                evals += 1;
            }
            Step::Accept(i) => break Some(i),
            Step::Exhausted | Step::CapReached => break None,
        }
    };
    let phase384 = p.map(|i| {
        let q2 = fingerprint(&q_pcm[384..], q.t0 + 384.0 / SR as f64);
        let m = evaluate_theme(&refs[i].0, refs[i].1, &q2);
        (m.accepted, m.raw_window)
    });
    SlotResult {
        theme: p.map(|i| themes[i].base.clone()),
        window: p.and_then(|i| matches[&i].raw_window),
        soft42: p.and_then(|i| matches[&i].soft42),
        margin: p.map(|i| matches[&i].margin),
        policy_theme: policy.map(|i| themes[i].base.clone()),
        policy_evals: evals,
        phase384,
        old_theme: old_p.map(|i| themes[i].base.clone()),
    }
}

#[test]
#[ignore = "needs AURA_SKIPBENCH_DIR (skipbench corpus)"]
fn skipdetect_layer1_parity() {
    let root = bench();
    let eval = load_json(&root.join("eval_animethemes.json"));
    let pre = load_json(&root.join("pre_gates.json"));
    let mut truth: HashMap<String, Value> = HashMap::new();
    for e in std::fs::read_dir(root.join("truth")).unwrap() {
        let p = e.unwrap().path();
        if p.extension().is_some_and(|x| x == "json") {
            if let Value::Object(m) = load_json(&p) {
                truth.extend(m);
            }
        }
    }
    let rows = eval["rows"].as_array().unwrap().clone();
    let results: Vec<EpResult> = par_map(rows.len(), |k| {
        let r = &rows[k];
        let id = r["id"].as_str().unwrap().to_string();
        let mal = r["mal"].as_u64().or_else(|| r["mal"].as_str().and_then(|s| s.parse().ok()));
        let mal_ep = r["mal_ep"].as_u64().or_else(|| r["mal_ep"].as_str().and_then(|s| s.parse().ok())).map(|x| x as u32);
        let cdir = root.join("cache").join(tag_of(&id));
        let info = load_json(&cdir.join("info.json"));
        let mut head = read_wav(&cdir.join("head.wav"));
        head.truncate(HEAD_SAMPLES);
        let tail = read_wav(&cdir.join("tail.wav"));
        let h0 = info["passes"]["head"]["t0"].as_f64().unwrap();
        let t0 = info["passes"]["tail"]["t0"].as_f64().unwrap();
        let (hq, tq) = (fingerprint(&head, h0), fingerprint(&tail, t0));
        let themes = mal.map(|m| themes_of(&root, m)).unwrap_or_default();
        let tj = mal.map(|m| load_json(&root.join("themes").join(m.to_string()).join("themes.json")));
        let mut audible_dev: f64 = 0.0;
        let refs: Vec<(Fingerprint, (f64, f64))> = themes
            .iter()
            .enumerate()
            .map(|(i, t)| {
                let pcm = read_wav(&root.join("themes").join(mal.unwrap().to_string()).join(format!("{}.11k.wav", t.base)));
                let aud = theme_audible(&pcm);
                if let Some(py) = tj.as_ref().and_then(|j| pair(&j[i]["audible"])) {
                    audible_dev = audible_dev.max((py.0 - aud.0).abs()).max((py.1 - aud.1).abs());
                }
                (fingerprint(&pcm, 0.0), aud)
            })
            .collect();
        EpResult {
            op: slot_eval(&themes, &refs, &hq, &head, Kind::Op, mal_ep),
            ed: slot_eval(&themes, &refs, &tq, &tail, Kind::Ed, mal_ep),
            id,
            audible_dev,
        }
    });

    // soft42 reference for the strict picks.
    let mut pre_soft: HashMap<(String, String, String), f64> = HashMap::new();
    for g in pre["part1_corpus"].as_array().unwrap() {
        if g["strict_pick"].as_bool() == Some(true) {
            let slot = if g["where"] == "head" { "op" } else { "ed" };
            if let Some(s) = g["soft42"].as_f64() {
                pre_soft.insert(
                    (g["id"].as_str().unwrap().into(), slot.into(), g["theme"].as_str().unwrap().into()),
                    s,
                );
            }
        }
    }

    let mut fails = Vec::new();
    let mut tallies: HashMap<(String, &'static str), i64> = HashMap::new();
    let mut max_dev: f64 = 0.0;
    let mut n_compared = 0;
    let (mut policy_same, mut policy_total) = (0, 0);
    let mut phase_same = 0;
    let mut phase_total = 0;
    let mut phase_spread: f64 = 0.0;
    let mut audible_dev: f64 = 0.0;
    let (mut soft_n, mut soft_dev) = (0, 0.0f64);
    for (r, res) in rows.iter().zip(&results) {
        let id = &res.id;
        audible_dev = audible_dev.max(res.audible_dev);
        let tr = &truth[id];
        for (slot, s) in [("op", &res.op), ("ed", &res.ed)] {
            let ev = &r["eval"]["strict"][slot];
            let ev_theme = ev["theme"].as_str().map(String::from);
            let ev_win = pair(&ev["pred"]["A_full"]);
            let outcome = classify(s.window, tr, slot);
            *tallies.entry((slot.to_string(), outcome)).or_default() += 1;
            let ev_outcome = ev["judge"]["A_full"]["outcome"].as_str().unwrap_or("?");
            let mut line = format!(
                "[layer1] {id:18} {slot} rust {:?} {:?} {outcome} | eval {:?} {:?} {ev_outcome} | margin {:?} soft42 {:?}",
                s.theme, s.window, ev_theme, ev_win, s.margin, s.soft42.map(|x| (x * 1000.0).round() / 1000.0)
            );
            let mut bad = false;
            if s.theme != ev_theme {
                bad = true;
                line += &format!(" THEME MISMATCH (old pick {:?})", s.old_theme);
            }
            match (s.window, ev_win) {
                (Some(a), Some(b)) => {
                    n_compared += 1;
                    let d = (a.0 - b.0).abs().max((a.1 - b.1).abs());
                    max_dev = max_dev.max(d);
                    if d > 0.15 {
                        bad = true;
                        line += &format!(" WINDOW DEV {d:.3}");
                    } else if d > 0.0 {
                        line += &format!(" dev {d:.3}");
                    }
                }
                (None, None) => {}
                _ => {
                    bad = true;
                    line += " PRESENCE MISMATCH";
                }
            }
            if outcome != ev_outcome {
                bad = true;
                line += " OUTCOME MISMATCH";
            }
            if let (Some(t), Some(sf)) = (&s.theme, s.soft42) {
                if let Some(&py) = pre_soft.get(&(id.clone(), slot.to_string(), t.clone())) {
                    let d = (py - sf).abs();
                    soft_n += 1;
                    soft_dev = soft_dev.max(d);
                    if d > 0.01 {
                        bad = true;
                        line += &format!(" SOFT42 DEV {d:.3} (py {py})");
                    }
                }
            }
            if s.theme.is_some() {
                policy_total += 1;
                if s.policy_theme == s.theme {
                    policy_same += 1;
                } else {
                    line += &format!(" policy picked {:?}", s.policy_theme);
                }
                line += &format!(" evals {}", s.policy_evals);
            }
            if let Some((acc, w)) = s.phase384 {
                phase_total += 1;
                if acc {
                    phase_same += 1;
                } else {
                    bad = true;
                    line += " PHASE384 REJECTED";
                }
                if let (Some(a), Some(b)) = (w, s.window) {
                    phase_spread = phase_spread.max((a.0 - b.0).abs().max((a.1 - b.1).abs()));
                }
            }
            println!("{line}");
            if bad {
                fails.push(line);
            }
        }
    }
    // Totals vs the reference summary.
    let summ = &eval["summary"];
    let mut totals_ok = true;
    for slot in ["op", "ed"] {
        let key = format!("strict|A_full|overall|{slot}");
        let refs = &summ[&key];
        let mut line = format!("[layer1] totals {slot}:");
        for o in ["correct", "near", "wrong", "abstained", "correct-abstain", "false-positive"] {
            let mine = tallies.get(&(slot.to_string(), o)).copied().unwrap_or(0);
            let theirs = refs[o].as_i64().unwrap_or(0);
            line += &format!(" {o} {mine}/{theirs}");
            if mine != theirs {
                totals_ok = false;
            }
        }
        println!("{line}");
    }
    println!(
        "[layer1] windows compared {n_compared}, max edge deviation {max_dev:.3} s; policy order picks the strict theme \
         {policy_same}/{policy_total}; phase 384 accepted {phase_same}/{phase_total} (max window shift {phase_spread:.3} s); \
         max audible lead/trail deviation {audible_dev:.3} s; soft42 vs pre_gates.json on {soft_n} picks, max dev {soft_dev:.4}"
    );
    assert_eq!(soft_n, n_compared, "every pick should have a pre_gates.json soft42 row");
    assert!(totals_ok, "Layer 1 totals differ from eval_animethemes.json");
    assert!(fails.is_empty(), "{} Layer 1 deviations:\n{}", fails.len(), fails.join("\n"));
    assert_eq!(policy_same, policy_total, "proximity policy disagrees with the strict pick");
}

// ── Layer 3 parity ──────────────────────────────────────────────────────────

/// `cont/method.py judge` outcome (with the truth's recorded slack).
fn judge_l3(pred: Option<(f64, f64)>, truth: &Value, kind: &str) -> &'static str {
    let tr = pair(&truth[kind]);
    match (pred, tr) {
        (None, None) => "correct-abstain",
        (None, Some(_)) => "abstained",
        (Some(_), None) => "wrong",
        (Some(p), Some(t)) => {
            let (mut ds, mut de) = (p.0 - t.0, p.1 - t.1);
            if kind == "op" {
                if let Some(hi) = f(&truth["op_end_max"]) {
                    if t.1 <= p.1 && p.1 <= hi {
                        de = 0.0;
                    }
                }
            }
            if kind == "ed" {
                if let Some(lo) = f(&truth["ed_start_min"]) {
                    if lo <= p.0 && p.0 <= t.0 {
                        ds = 0.0;
                    }
                }
            }
            let m = ds.abs().max(de.abs());
            if m <= 2.0 {
                "correct"
            } else if m <= 5.0 {
                "near"
            } else {
                "wrong"
            }
        }
    }
}

#[test]
#[ignore = "needs AURA_SKIPBENCH_DIR (skipbench corpus)"]
fn skipdetect_layer3_parity() {
    let root = bench();
    let ev = load_json(&root.join("eval_continuity.json"));
    let eps = ev["episodes"].as_array().unwrap().clone();
    let res = par_map(eps.len(), |k| {
        let e = &eps[k];
        let id = e["id"].as_str().unwrap().to_string();
        let cdir = root.join("cache").join(tag_of(&id));
        let info = load_json(&cdir.join("info.json"));
        let mut head = read_wav(&cdir.join("head.wav"));
        head.truncate(HEAD_SAMPLES);
        let tail = read_wav(&cdir.join("tail.wav"));
        let (hl, tl) = (continuity::rms_levels(&head), continuity::rms_levels(&tail));
        let hs: Vec<Silence> =
            silences(&info["passes"]["head"]["silences"]["jpn"]).into_iter().filter(|s| s.start < 600.0).collect();
        let ts = silences(&info["passes"]["tail"]["silences"]["jpn"]);
        let h0 = info["passes"]["head"]["t0"].as_f64().unwrap();
        let t0 = info["passes"]["tail"]["t0"].as_f64().unwrap();
        let op = continuity::detect_op(&Region { levels: &hl, t0: h0, silences: &hs });
        let ed = continuity::detect_ed(&Region { levels: &tl, t0, silences: &ts });
        (id, op, ed)
    });
    let mut fails = Vec::new();
    let mut tallies: HashMap<(&'static str, &'static str), i64> = HashMap::new();
    let mut max_dev: f64 = 0.0;
    for (e, (id, op, ed)) in eps.iter().zip(&res) {
        let truth = &e["truth"];
        for (kind, o) in [("op", op), ("ed", ed)] {
            let rec = &e[kind]["recommended"];
            let py = pair(&rec["pred"]);
            let outcome = judge_l3(o.window, truth, kind);
            *tallies.entry((kind, outcome)).or_default() += 1;
            let mut line = format!(
                "[layer3] {id:18} {kind} rust {:?} {outcome} ({}) | eval {:?} {}",
                o.window,
                o.abstain.map_or("pick", |a| a.as_str()),
                py,
                rec["outcome"].as_str().unwrap_or("?")
            );
            let mut bad = false;
            match (o.window, py) {
                (Some(a), Some(b)) => {
                    let d = (a.0 - b.0).abs().max((a.1 - b.1).abs());
                    max_dev = max_dev.max(d);
                    if d > 0.2 {
                        bad = true;
                        line += &format!(" WINDOW DEV {d:.3}");
                    }
                }
                (None, None) => {}
                _ => {
                    bad = true;
                    line += " PRESENCE MISMATCH";
                }
            }
            if Some(outcome) != rec["outcome"].as_str() {
                bad = true;
                line += " OUTCOME MISMATCH";
            }
            println!("{line}");
            if bad {
                fails.push(line);
            }
        }
    }
    let mut totals_ok = true;
    for kind in ["op", "ed"] {
        let refs = &ev["totals"][kind]["recommended"]["overall"];
        let mut line = format!("[layer3] totals {kind}:");
        for o in ["correct", "near", "wrong", "abstained", "correct-abstain"] {
            let mine = tallies.get(&(kind, o)).copied().unwrap_or(0);
            let theirs = refs[o].as_i64().unwrap_or(0);
            line += &format!(" {o} {mine}/{theirs}");
            totals_ok &= mine == theirs;
        }
        println!("{line}");
    }
    println!("[layer3] max edge deviation {max_dev:.3} s over {} episodes", res.len());
    assert!(totals_ok, "Layer 3 totals differ from eval_continuity.json");
    assert!(fails.is_empty(), "{} Layer 3 deviations:\n{}", fails.len(), fails.join("\n"));
}
