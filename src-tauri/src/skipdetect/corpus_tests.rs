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
use super::matcher::{evaluate_theme, EarlyEvent, EarlyRef, EarlyRetract, EarlyTracker, MatchSchedule, ThemeMatch, EARLY_HORIZON_S, EARLY_RUN_S};
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
                    over_partial: false,
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

// ── Layer 1 edge rule ───────────────────────────────────────────────────────

/// The published edge rule (`matcher::refine_layer1_window`, EDGE_RULE 1) on
/// this corpus, per slot: (id, slot, outcome under mapping A, outcome under
/// the edge rule, the rule's window). Recorded deliberately when the rule
/// replaced mapping A as the PUBLISHED window (2026-10-07);
/// `skipdetect_layer1_parity` above still holds mapping A itself to the
/// research reference, unchanged. The test prints mapping A's window beside
/// each row, so old -> new is in its output.
///
/// Old -> new on this corpus (56 slots): every start moves to the theme's
/// audible start, 0.10 to 1.30 s later (Demon Slayer 3:5's OP lands exactly
/// on the truth). ED ends move 0.49 to 0.51 s earlier (a quiet held card) or
/// more: a preview starting inside the theme's fade (Demon Slayer 1:2 1.52 s,
/// TYBW 3:2 1.32 s, TYBW 3:3 1.47 s) or a fade talked over (Demon Slayer 3:5
/// 1.36 s, TYBW 1:1 4.18 s). OP ends stay within 0.01 s, except Demon Slayer
/// 1:2's (147.96 -> 146.60, an onset: it ended inside the scene that follows).
/// The one verdict change is TYBW 1:1's ED, correct -> near: its 1.23 s
/// preview overrun is gone, and its end is now 2.95 s before the truth cut.
/// Every window here equals the measurement's own replay of the rule within
/// 0.01 s, except where the measurement used the real stream (JJK S1E3, whose
/// served copy sits 2.1 s later, and TYBW 3:14, 0.02 s). The full 89-episode
/// measurement is
/// `scratchpad/e2e/edge_mapping.md` (variant REC).
const EDGE_RULE_EXPECT: &[(&str, &str, &str, &str, f64, f64)] = &[
    ("tt0388629:1:1100", "ed", "correct", "correct", 1216.31, 1305.02),
    ("tt0388629:1:1100", "op", "correct", "correct", 11.29, 100.40),
    ("tt12343534:1:3", "ed", "near", "near", 1275.30, 1364.16),
    ("tt12343534:1:3", "op", "near", "near", 192.34, 281.70),
    ("tt12343534:2:10", "ed", "correct", "correct", 1300.48, 1389.25),
    ("tt12343534:2:10", "op", "correct", "correct", 183.52, 272.74),
    ("tt13293588:2:3", "ed", "correct", "correct", 1271.01, 1359.44),
    ("tt13293588:2:3", "op", "correct", "correct", 122.82, 212.00),
    ("tt13706018:1:16", "ed", "correct", "correct", 1350.91, 1438.51),
    ("tt13706018:1:16", "op", "correct", "correct", 108.56, 197.88),
    ("tt13706018:1:2", "op", "correct", "correct", 0.46, 89.68),
    ("tt14986406:1:1", "ed", "correct", "near", 1198.00, 1412.55),
    ("tt14986406:1:13", "ed", "correct", "correct", 1395.13, 1483.76),
    ("tt14986406:1:13", "op", "correct", "correct", 113.11, 202.43),
    ("tt14986406:1:6", "ed", "correct", "correct", 1326.17, 1414.80),
    ("tt14986406:1:6", "op", "correct", "correct", 34.12, 123.44),
    ("tt14986406:2:1", "ed", "correct", "correct", 1326.34, 1414.81),
    ("tt14986406:2:1", "op", "correct", "correct", 69.05, 158.22),
    ("tt14986406:2:7", "ed", "correct", "correct", 1207.77, 1296.24),
    ("tt14986406:2:7", "op", "correct", "correct", 64.50, 153.67),
    ("tt14986406:3:1", "ed", "correct", "correct", 1146.46, 1234.98),
    ("tt14986406:3:1", "op", "correct", "correct", 0.59, 89.81),
    ("tt14986406:3:10", "ed", "correct", "correct", 1262.65, 1351.17),
    ("tt14986406:3:10", "op", "correct", "correct", 258.52, 347.74),
    ("tt14986406:3:11", "ed", "near", "near", 1357.71, 1446.23),
    ("tt14986406:3:11", "op", "correct", "correct", 94.49, 183.71),
    ("tt14986406:3:12", "ed", "near", "near", 1437.32, 1525.84),
    ("tt14986406:3:12", "op", "correct", "correct", 48.43, 137.65),
    ("tt14986406:3:13", "ed", "correct", "correct", 1303.67, 1392.19),
    ("tt14986406:3:13", "op", "correct", "correct", 40.48, 129.70),
    ("tt14986406:3:14", "ed", "correct", "correct", 954.68, 1043.20),
    ("tt14986406:3:14", "op", "correct", "correct", 78.47, 167.69),
    ("tt14986406:3:2", "ed", "correct", "correct", 1325.10, 1412.80),
    ("tt14986406:3:2", "op", "correct", "correct", 159.05, 248.27),
    ("tt14986406:3:3", "ed", "correct", "correct", 1324.79, 1412.34),
    ("tt14986406:3:3", "op", "correct", "correct", 0.59, 89.81),
    ("tt14986406:3:4", "ed", "correct", "correct", 1213.46, 1301.98),
    ("tt14986406:3:4", "op", "correct", "correct", 141.54, 230.76),
    ("tt14986406:3:5", "ed", "correct", "correct", 1377.34, 1465.86),
    ("tt14986406:3:5", "op", "correct", "correct", 139.50, 228.72),
    ("tt14986406:3:6", "ed", "near", "near", 1350.28, 1438.80),
    ("tt14986406:3:6", "op", "correct", "correct", 97.51, 186.73),
    ("tt14986406:3:7", "ed", "correct", "correct", 1325.71, 1414.23),
    ("tt14986406:3:7", "op", "correct", "correct", 82.47, 171.69),
    ("tt14986406:3:8", "ed", "correct", "correct", 1325.73, 1414.25),
    ("tt14986406:3:8", "op", "correct", "correct", 136.48, 225.70),
    ("tt14986406:3:9", "ed", "near", "near", 1357.74, 1446.26),
    ("tt14986406:3:9", "op", "correct", "correct", 144.51, 233.73),
    ("tt22248376:1:2", "ed", "correct", "correct", 1460.27, 1549.39),
    ("tt22248376:1:2", "op", "correct", "correct", 0.75, 89.81),
    ("tt22248376:1:20", "ed", "correct", "correct", 1370.14, 1459.11),
    ("tt22248376:1:20", "op", "near", "near", 104.53, 193.79),
    ("tt9335498:1:2", "ed", "correct", "correct", 1290.63, 1379.40),
    ("tt9335498:1:2", "op", "correct", "correct", 57.83, 146.60),
    ("tt9335498:3:5", "ed", "correct", "correct", 1292.05, 1379.50),
    ("tt9335498:3:5", "op", "correct", "correct", 26.24, 114.85),
];

/// Severity of a classify() outcome for the "never worse" check.
fn outcome_rank(o: &str) -> u8 {
    match o {
        "correct" | "correct-abstain" => 0,
        "near" => 1,
        "abstained" => 2,
        _ => 3, // wrong, false-positive
    }
}

#[test]
#[ignore = "needs AURA_SKIPBENCH_DIR (skipbench corpus)"]
fn skipdetect_layer1_edge_rule_corpus() {
    use super::continuity::rms_levels;
    use super::matcher::{refine_edges, RegionLevels};
    let root = bench();
    let eval = load_json(&root.join("eval_animethemes.json"));
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
    // Per row: [(slot, theme, A window, refined window)].
    type Slot = (&'static str, String, (f64, f64), Option<(f64, f64)>);
    let results: Vec<(String, Vec<Slot>)> = par_map(rows.len(), |k| {
        let r = &rows[k];
        let id = r["id"].as_str().unwrap().to_string();
        let mal = r["mal"].as_u64().or_else(|| r["mal"].as_str().and_then(|s| s.parse().ok()));
        let cdir = root.join("cache").join(tag_of(&id));
        let info = load_json(&cdir.join("info.json"));
        let mut head = read_wav(&cdir.join("head.wav"));
        head.truncate(HEAD_SAMPLES);
        let tail = read_wav(&cdir.join("tail.wav"));
        let h0 = info["passes"]["head"]["t0"].as_f64().unwrap();
        let t0 = info["passes"]["tail"]["t0"].as_f64().unwrap();
        let (hq, tq) = (fingerprint(&head, h0), fingerprint(&tail, t0));
        let (hl, tl) = (rms_levels(&head), rms_levels(&tail));
        let Some(mal) = mal else { return (id, Vec::new()) };
        let themes = themes_of(&root, mal);
        let refs: Vec<(Fingerprint, (f64, f64))> = themes
            .iter()
            .map(|t| {
                let pcm = read_wav(&root.join("themes").join(mal.to_string()).join(format!("{}.11k.wav", t.base)));
                (fingerprint(&pcm, 0.0), theme_audible(&pcm))
            })
            .collect();
        let mut out = Vec::new();
        for (slot, kind, q, lv, origin) in [("op", Kind::Op, &hq, &hl, h0), ("ed", Kind::Ed, &tq, &tl, t0)] {
            let idx: Vec<usize> = (0..themes.len())
                .filter(|&i| themes[i].meta.kind == kind && !(kind == Kind::Ed && themes[i].over_str))
                .collect();
            let ms: Vec<(usize, ThemeMatch)> = idx.iter().map(|&i| (i, evaluate_theme(&refs[i].0, refs[i].1, q))).collect();
            let acc: Vec<(usize, &ThemeMatch)> = ms.iter().filter(|(_, m)| m.accepted).map(|(i, m)| (*i, m)).collect();
            let Some(p) = pick(&acc) else { continue };
            let m = acc.iter().find(|(i, _)| *i == p).unwrap().1;
            let raw = m.raw_window.unwrap();
            let today = (raw.0.max(0.0), raw.1);
            let levels = Some(RegionLevels { levels: lv, t0: origin });
            let rec = refine_edges(raw, today, m.ref_len_s, m.chained <= 1, refs[p].1, kind == Kind::Ed, levels, f64::INFINITY);
            out.push((slot, themes[p].base.clone(), raw, rec));
        }
        (id, out)
    });
    let mut got: Vec<(String, &'static str, &'static str, &'static str, f64, f64)> = Vec::new();
    let mut worse = Vec::new();
    let (mut moved_s, mut moved_e) = (0.0f64, 0.0f64);
    for (id, slots) in &results {
        let tr = &truth[id];
        for (slot, theme, a, rec) in slots {
            let oa = classify(Some(*a), tr, slot);
            let or = classify(*rec, tr, slot);
            let t = pair(&tr[*slot]);
            println!(
                "[edges] {id:18} {slot} {theme:28} A [{:.2}, {:.2}] {oa:8} -> rule {} {or:8} truth {:?}",
                a.0,
                a.1,
                rec.map_or("none".to_string(), |w| format!("[{:.2}, {:.2}]", w.0, w.1)),
                t
            );
            if let Some(w) = rec {
                moved_s = moved_s.max(w.0 - a.0.max(0.0));
                moved_e = moved_e.max(a.1 - w.1);
                assert!(w.0 >= a.0.max(0.0) - 1e-9 && w.1 <= a.1 + 1e-9, "{id} {slot}: the rule widened mapping A");
            }
            // The bar: no slot becomes wrong or a false positive, and none
            // loses its window. A correct edge becoming "near" is the recorded
            // cost (an under-skip; EDGE_RULE_EXPECT pins each one).
            if outcome_rank(or) >= 2 && outcome_rank(or) > outcome_rank(oa) {
                worse.push(format!("{id} {slot}: {oa} -> {or}"));
            }
            let w = rec.unwrap_or((f64::NAN, f64::NAN));
            got.push((id.clone(), slot, oa, or, w.0, w.1));
        }
    }
    println!("[edges] {} slots; start moved up to {moved_s:.2} s later, end up to {moved_e:.2} s earlier", got.len());
    let changed: Vec<_> = got.iter().filter(|g| g.2 != g.3).collect();
    for c in &changed {
        println!("[edges] verdict change {} {}: {} -> {}", c.0, c.1, c.2, c.3);
    }
    assert!(worse.is_empty(), "the edge rule made slots worse:\n{}", worse.join("\n"));
    let key = |a: &(String, &str, &str, &str, f64, f64)| (a.0.clone(), a.1.to_string());
    let mut want: Vec<(String, &str, &str, &str, f64, f64)> =
        EDGE_RULE_EXPECT.iter().map(|e| (e.0.to_string(), e.1, e.2, e.3, e.4, e.5)).collect();
    want.sort_by_key(key);
    got.sort_by_key(key);
    let same = want.len() == got.len()
        && want.iter().zip(&got).all(|(w, g)| {
            (&w.0, w.1, w.2, w.3) == (&g.0, g.1, g.2, g.3) && (w.4 - g.4).abs() <= 0.02 && (w.5 - g.5).abs() <= 0.02
        });
    if !same {
        let lit: Vec<String> = got
            .iter()
            .map(|g| format!("    (\"{}\", \"{}\", \"{}\", \"{}\", {:.2}, {:.2}),", g.0, g.1, g.2, g.3, g.4, g.5))
            .collect();
        panic!("edge rule outcomes differ from EDGE_RULE_EXPECT; current:\n{}", lit.join("\n"));
    }
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

// ── early provisional opening (matcher::EarlyTracker) ───────────────────────
//
// The early rule over the WHOLE corpus, through the production tracker:
//   * every Layer 1 slot (truth window + a strict eval theme): the rule must
//     fire at the truth location, within a few seconds of the theme's start,
//     with a window matching eval's final Layer 1 window; and once it fired it
//     must not be withdrawn before the full gate (simulated at the production
//     cadence) accepts, so a correct prompt never flickers;
//   * every theme of the corpus (108) against every head and tail, with NO
//     horizon (stricter than production): zero fires away from a truth
//     location, "Over" themes reported separately (production never offers
//     them to the early rule), plus the named traps;
//   * the decode-phase robustness of every zero-start opening (384 samples);
//   * the CPU cost of the tracker next to the streaming full matcher.

struct CorpusTheme {
    mal: u64,
    base: String,
    meta: ThemeMeta,
    fp: Fingerprint,
    audible: (f64, f64),
}

fn all_corpus_themes(root: &Path) -> Vec<CorpusTheme> {
    let mut mals: Vec<u64> = std::fs::read_dir(root.join("themes"))
        .unwrap()
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .collect();
    mals.sort();
    let rows: Vec<(u64, ThemeRow)> = mals.iter().flat_map(|&m| themes_of(root, m).into_iter().map(move |t| (m, t))).collect();
    par_map(rows.len(), |k| {
        let (mal, t) = &rows[k];
        let pcm = read_wav(&root.join("themes").join(mal.to_string()).join(format!("{}.11k.wav", t.base)));
        CorpusTheme { mal: *mal, base: t.base.clone(), meta: t.meta.clone(), fp: fingerprint(&pcm, 0.0), audible: theme_audible(&pcm) }
    })
}

/// Codes of a fingerprint that exist once `decoded_s` of its region decoded
/// (frame f needs samples up to f * HOP + FRAME; code i needs frame i + 1).
fn codes_at(decoded_s: f64) -> usize {
    use super::fingerprint::{FRAME, HOP};
    let samples = (decoded_s * SR as f64).round() as i64;
    ((samples - FRAME as i64).max(0) / HOP as i64) as usize
}

/// Feed a region's fingerprint to an early tracker as it would decode, one
/// step per second of audio. Returns the events and the tracker CPU time.
fn simulate_early(full: &Fingerprint, region_s: f64, refs: &[EarlyRef], horizon: f64) -> (Vec<(f64, EarlyEvent)>, std::time::Duration) {
    simulate_early_every(full, region_s, refs, horizon, 1.0)
}

/// `simulate_early` with the worker getting a turn only every `every`
/// seconds of decoded audio (a decoder far faster than the analysis: the
/// worker matches only with its queue drained).
fn simulate_early_every(
    full: &Fingerprint,
    region_s: f64,
    refs: &[EarlyRef],
    horizon: f64,
    every: f64,
) -> (Vec<(f64, EarlyEvent)>, std::time::Duration) {
    let mut q = Fingerprint { codes: Vec::with_capacity(full.len()), valid: Vec::with_capacity(full.len()), t0: full.t0 };
    let mut tr = EarlyTracker::with_horizon(horizon);
    let mut out = Vec::new();
    let mut spent = std::time::Duration::ZERO;
    let mut s = every.max(1.0);
    while s <= region_s + 1e-9 {
        let n = codes_at(s).min(full.len());
        let have = q.len();
        q.codes.extend_from_slice(&full.codes[have..n.max(have)]);
        q.valid.extend_from_slice(&full.valid[have..n.max(have)]);
        let t = std::time::Instant::now();
        let e = tr.step(s, &q, refs);
        spent += t.elapsed();
        if let Some(e) = e {
            out.push((s, e));
        }
        s += every;
    }
    (out, spent)
}

/// Decoded seconds at which the streaming full gate (MatchSchedule cadence)
/// first accepts theme `r` in this region. None = never.
fn full_gate_accept(r: &Fingerprint, aud: (f64, f64), full: &Fingerprint, region_s: f64) -> Option<f64> {
    let mut sched = MatchSchedule::default();
    let mut s = 1.0;
    while s <= region_s + 1e-9 {
        if sched.due(s, false) {
            let n = codes_at(s).min(full.len());
            let q = Fingerprint { codes: full.codes[..n].to_vec(), valid: full.valid[..n].to_vec(), t0: full.t0 };
            if evaluate_theme(r, aud, &q).accepted {
                return Some(s);
            }
        }
        s += 1.0;
    }
    None
}

const FRANCHISES: [&[u64]; 4] = [&[41467, 53998, 56784], &[40748, 51009], &[50265, 50602], &[38000, 47778]];

fn same_family(a: u64, b: u64) -> bool {
    a == b || FRANCHISES.iter().any(|f| f.contains(&a) && f.contains(&b))
}

struct EarlyReg {
    id: String,
    which: &'static str,
    fp: Fingerprint,
    pcm: Vec<i16>,
    secs: f64,
}

/// One early fire at a truth location: decoded s, absolute time, theme index,
/// window, and the withdrawal that followed (if any).
type TrueFire = (f64, f64, usize, (f64, f64), Option<(f64, EarlyRetract)>);

#[test]
#[ignore = "needs AURA_SKIPBENCH_DIR (skipbench corpus)"]
fn skipdetect_early_rule_corpus() {
    let root = bench();
    let eval = load_json(&root.join("eval_animethemes.json"));
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
    let num = |v: &Value| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()));
    let themes = all_corpus_themes(&root);
    println!("[early] {} episodes, {} themes", rows.len(), themes.len());

    let regs: Vec<EarlyReg> = par_map(rows.len() * 2, |k| {
        let r = &rows[k / 2];
        let id = r["id"].as_str().unwrap().to_string();
        let cdir = root.join("cache").join(tag_of(&id));
        let info = load_json(&cdir.join("info.json"));
        let (which, mut pcm, t0) = if k % 2 == 0 {
            ("head", read_wav(&cdir.join("head.wav")), info["passes"]["head"]["t0"].as_f64().unwrap())
        } else {
            ("tail", read_wav(&cdir.join("tail.wav")), info["passes"]["tail"]["t0"].as_f64().unwrap())
        };
        if which == "head" {
            pcm.truncate(HEAD_SAMPLES);
        }
        let secs = pcm.len() as f64 / SR as f64;
        EarlyReg { id, which, fp: fingerprint(&pcm, t0), pcm, secs }
    });

    // ── 1. every theme x every region, no horizon ──
    let jobs: Vec<(usize, usize)> = (0..regs.len()).flat_map(|g| (0..themes.len()).map(move |t| (g, t))).collect();
    let t_sweep = std::time::Instant::now();
    let sweep = par_map(jobs.len(), |k| {
        let (g, t) = jobs[k];
        let th = &themes[t];
        let refs = [EarlyRef { idx: t, fp: &th.fp, audible: th.audible }];
        simulate_early(&regs[g].fp, regs[g].secs, &refs, f64::INFINITY)
    });
    let slot_kind = |which: &str| if which == "head" { Kind::Op } else { Kind::Ed };
    let slot_name = |which: &str| if which == "head" { "op" } else { "ed" };
    let mut false_fires = Vec::new();
    let mut over_fires = Vec::new();
    let mut true_fires: HashMap<(String, &'static str), Vec<TrueFire>> = HashMap::new();
    let mut cpu_total = std::time::Duration::ZERO;
    for (k, (events, spent)) in sweep.iter().enumerate() {
        cpu_total += *spent;
        let (g, t) = jobs[k];
        let (reg, th) = (&regs[g], &themes[t]);
        let tr = &truth[&reg.id];
        let slot = slot_name(reg.which);
        for (i, &(s, e)) in events.iter().enumerate() {
            let EarlyEvent::Fire { window, run, .. } = e else { continue };
            let retract = events.get(i + 1).and_then(|(rs, re)| match re {
                EarlyEvent::Retract { why, .. } => Some((*rs, *why)),
                _ => None,
            });
            let ref0 = run.ref0_s;
            let at_truth = th.meta.kind == slot_kind(reg.which)
                && pair(&tr[slot]).is_some_and(|w| (ref0.max(0.0) - w.0).abs() <= 4.0 || (ref0 + th.audible.0 - w.0).abs() <= 4.0);
            let abs = reg.fp.t0 + s;
            let line = format!(
                "{:18} {} {:42} fired at {:7.2}s (window [{:.2}, {:.2}], run {:.1}s ber {:.3}) {}",
                reg.id,
                reg.which,
                th.base,
                abs,
                window.0,
                window.1,
                run.len_s,
                run.ber,
                retract.map_or("never withdrawn".to_string(), |(rs, why)| format!(
                    "withdrawn at {:.2}s ({})",
                    reg.fp.t0 + rs,
                    why.as_str()
                ))
            );
            if at_truth {
                true_fires.entry((reg.id.clone(), slot)).or_default().push((s, abs, t, window, retract));
            } else if th.meta.over {
                over_fires.push(line);
            } else {
                false_fires.push(line);
            }
        }
    }
    println!(
        "[early] sweep: {} theme x region pairings in {:.0}s, {} fires at a truth location, {} false (non-Over), {} Over-theme fires; tracker CPU {:.1}s total",
        jobs.len(),
        t_sweep.elapsed().as_secs_f64(),
        true_fires.values().map(Vec::len).sum::<usize>(),
        false_fires.len(),
        over_fires.len(),
        cpu_total.as_secs_f64()
    );
    for l in &over_fires {
        println!("[early] OVER (production never offers it to the early rule): {l}");
    }
    for l in &false_fires {
        println!("[early] FALSE FIRE {l}");
    }

    // Named traps, reported one by one (all are inside the sweep above).
    let theme_idx = |base: &str| themes.iter().position(|t| t.base == base).unwrap_or_else(|| panic!("theme {base}"));
    let traps: [(&str, &str, &str, &str); 7] = [
        ("tt14986406:1:13", "tail", "Bleach2022-ED3.ogg", "Over insert song (fired at 8 s in research)"),
        ("tt14986406:1:1", "head", "Bleach2022-ED3.ogg", "the ED song heard inside the HEAD at 359 s"),
        ("tt13293588:2:3", "tail", "MushokuTenseiS2-ED2.ogg", "Over ending of the same cour"),
        ("tt22248376:1:2", "tail", "SousouNoFrieren-ED1-TV-NCBD1080.ogg", "TV version of the ending"),
        ("tt22248376:1:20", "tail", "SousouNoFrieren-ED1v3.ogg", "Transition version of the ending"),
        ("tt12343534:2:10", "head", "JujutsuKaisenS2-OP2-NCBD1080.ogg", "OP at 183 s after a cold open (crowd said 0-90)"),
        ("tt9335498:1:2", "tail", "KimetsuNoYaiba-ED2.ogg", "Transition version of the ending"),
    ];
    for (id, which, base, what) in traps {
        let t = theme_idx(base);
        let g = regs.iter().position(|r| r.id == id && r.which == which).unwrap();
        let ev = &sweep[g * themes.len() + t].0;
        let desc = if ev.is_empty() {
            "no fire".to_string()
        } else {
            ev.iter()
                .map(|(s, e)| match e {
                    EarlyEvent::Fire { window, .. } => format!("fire at {:.1}s [{:.2}, {:.2}]", regs[g].fp.t0 + s, window.0, window.1),
                    EarlyEvent::Retract { why, .. } => format!("withdrawn at {:.1}s ({})", regs[g].fp.t0 + s, why.as_str()),
                })
                .collect::<Vec<_>>()
                .join(", ")
        };
        println!("[early] trap {id} {which} {base} ({what}): {desc}");
    }

    // ── 2. every Layer 1 slot ──
    let mut fails = Vec::new();
    let mut rel_op = Vec::new();
    let mut rel_ed = Vec::new();
    let mut zero_op_abs = Vec::new();
    let mut gains = Vec::new();
    let mut max_win_dev: f64 = 0.0;
    let mut missed = Vec::new();
    let mut app_level = (0, 0);
    for r in &rows {
        let id = r["id"].as_str().unwrap().to_string();
        let mal = num(&r["mal"]);
        let mal_ep = num(&r["mal_ep"]).map(|x| x as u32);
        let tr = &truth[&id];
        for (slot, which) in [("op", "head"), ("ed", "tail")] {
            let Some(tw) = pair(&tr[slot]) else { continue };
            let Some(strict) = r["eval"]["strict"][slot]["theme"].as_str() else { continue };
            let eval_win = pair(&r["eval"]["strict"][slot]["pred"]["A_full"]).unwrap();
            let reg = regs.iter().find(|x| x.id == id && x.which == which).unwrap();
            // Rule level: an own-family theme of the kind fired at the truth
            // (the earliest; the strict theme first on a tie).
            let fires: Vec<TrueFire> = true_fires
                .get(&(id.clone(), slot))
                .map(|v| v.iter().filter(|f| mal.is_some_and(|m| same_family(themes[f.2].mal, m))).cloned().collect())
                .unwrap_or_default();
            let Some(&(s, abs, t, window, retract)) =
                fires.iter().min_by(|a, b| a.0.total_cmp(&b.0).then((themes[a.2].base != strict).cmp(&(themes[b.2].base != strict))))
            else {
                missed.push(format!("{id} {slot}"));
                println!("[early] {id:18} {slot} NO EARLY FIRE (strict theme {strict})");
                continue;
            };
            let rel = abs - tw.0;
            let media_end = reg.fp.t0 + reg.secs;
            let cap = if slot == "ed" { media_end } else { f64::INFINITY };
            let win = (window.0, window.1.min(cap));
            let ev_win = (eval_win.0.max(0.0), eval_win.1.min(cap));
            let dev = (win.0 - ev_win.0).abs().max((win.1 - ev_win.1).abs());
            if themes[t].base == strict {
                max_win_dev = max_win_dev.max(dev);
            }
            let outcome = classify(Some(win), tr, slot);
            // The full gate at the production cadence, same theme.
            let th = &themes[t];
            let full = full_gate_accept(&th.fp, th.audible, &reg.fp, reg.secs);
            let mut line = format!(
                "[early] {id:18} {slot} {:40} fired {rel:5.2}s after the truth start (at {abs:.2}s), window [{:.2}, {:.2}] {outcome} (eval [{:.2}, {:.2}] dev {dev:.3}); full gate {}",
                th.base,
                win.0,
                win.1,
                ev_win.0,
                ev_win.1,
                full.map_or("never".into(), |fs| format!("at {:.2}s ({:.1}s later)", reg.fp.t0 + fs, fs - s))
            );
            if let Some(fs) = full {
                gains.push(fs - s);
            }
            if slot == "op" {
                rel_op.push(rel);
                if tw.0 <= 0.5 {
                    zero_op_abs.push(abs);
                }
            } else {
                rel_ed.push(rel);
            }
            let mut bad = false;
            if !(0.0..=EARLY_RUN_S + 6.0).contains(&rel) {
                bad = true;
                line += " LATE OR EARLY FIRE";
            }
            if outcome == "wrong" {
                bad = true;
                line += " WRONG WINDOW";
            }
            if themes[t].base == strict && dev > 0.5 {
                bad = true;
                line += " WINDOW DEV vs eval";
            }
            if let Some((rs, why)) = retract {
                line += &format!(" withdrawn at {:.2}s ({})", reg.fp.t0 + rs, why.as_str());
                if full.is_none_or(|fs| rs < fs) {
                    bad = true;
                    line += " WITHDRAWN BEFORE THE FULL GATE";
                }
            }
            println!("{line}");
            if bad {
                fails.push(line);
            }
            // Production level: the top-ranked own-cour candidate (the theme
            // the job prefetches, so the one loaded while HEAD streams).
            if let Some(m) = mal {
                let own: Vec<usize> = (0..themes.len()).filter(|&i| themes[i].mal == m).collect();
                let metas: Vec<ThemeMeta> = own.iter().map(|&i| themes[i].meta.clone()).collect();
                let kind = if slot == "op" { Kind::Op } else { Kind::Ed };
                if let Some(&top) = candidate_order(&metas, kind, mal_ep).first() {
                    let ti = own[top];
                    app_level.1 += 1;
                    if fires.iter().any(|f| f.2 == ti) && !themes[ti].meta.over {
                        app_level.0 += 1;
                    } else {
                        println!("[early] {id} {slot}: the top-ranked candidate {} does not fire early (the full gate still decides)", themes[ti].base);
                    }
                }
            }
        }
    }
    let stats = |v: &mut Vec<f64>| {
        v.sort_by(f64::total_cmp);
        if v.is_empty() {
            return "none".to_string();
        }
        format!("n {} min {:.2} median {:.2} max {:.2}", v.len(), v[0], v[v.len() / 2], v[v.len() - 1])
    };
    println!("[early] OP fire, seconds of the theme decoded: {}", stats(&mut rel_op));
    println!("[early] ED fire, seconds of the theme decoded: {}", stats(&mut rel_ed));
    println!("[early] zero-start openings fire at absolute {zero_op_abs:?}");
    println!("[early] the full gate accepts this much later (decoded seconds): {}", stats(&mut gains));
    println!(
        "[early] max window deviation vs eval (same theme): {max_win_dev:.3}s; top-ranked candidate fires on {}/{} slots",
        app_level.0, app_level.1
    );
    println!("[early] slots with no early fire: {missed:?}");

    // ── 3. decode phase: every zero-start opening shifted by 384 samples ──
    for r in &rows {
        let id = r["id"].as_str().unwrap();
        let Some(tw) = pair(&truth[id]["op"]) else { continue };
        if tw.0 > 0.5 {
            continue;
        }
        let Some(strict) = r["eval"]["strict"]["op"]["theme"].as_str() else { continue };
        let reg = regs.iter().find(|x| x.id == id && x.which == "head").unwrap();
        let th = &themes[theme_idx(strict)];
        let q2 = fingerprint(&reg.pcm[384..], reg.fp.t0 + 384.0 / SR as f64);
        let refs = [EarlyRef { idx: 0, fp: &th.fp, audible: th.audible }];
        let (ev, _) = simulate_early(&q2, reg.secs - 384.0 / SR as f64, &refs, EARLY_HORIZON_S);
        let fire = ev.iter().find_map(|(s, e)| match e {
            EarlyEvent::Fire { window, .. } => Some((*s, *window)),
            _ => None,
        });
        println!("[early] phase 384 {id} {}: {:?}", th.base, fire);
        match fire {
            Some((s, w)) if s <= EARLY_RUN_S + 6.0 && w.0 <= 1.0 => {}
            other => fails.push(format!("{id}: phase-shifted zero-start opening {other:?}")),
        }
    }

    // ── 4. CPU: the tracker next to the streaming full matcher ──
    // Per 600 s HEAD: (a) a theme that is NOT in the episode (the common
    // case, run detection mostly skipped), (b) the episode's own opening (the
    // tracker fires, then follows that one theme to the full gate).
    let mut cpu = [std::time::Duration::ZERO; 3];
    let mut n_cpu = 0u32;
    for r in rows.iter().take(31) {
        let id = r["id"].as_str().unwrap();
        let Some(strict) = r["eval"]["strict"]["op"]["theme"].as_str() else { continue };
        let reg = regs.iter().find(|x| x.id == id && x.which == "head").unwrap();
        let own = &themes[theme_idx(strict)];
        let other = themes.iter().find(|t| t.meta.kind == Kind::Op && !same_family(t.mal, own.mal)).unwrap();
        cpu[0] += simulate_early(&reg.fp, reg.secs, &[EarlyRef { idx: 0, fp: &other.fp, audible: other.audible }], EARLY_HORIZON_S).1;
        cpu[1] += simulate_early(&reg.fp, reg.secs, &[EarlyRef { idx: 0, fp: &own.fp, audible: own.audible }], EARLY_HORIZON_S).1;
        let mut sched = MatchSchedule::default();
        let mut s = 1.0;
        while s <= reg.secs + 1e-9 {
            if sched.due(s, false) {
                let n = codes_at(s).min(reg.fp.len());
                let q = Fingerprint { codes: reg.fp.codes[..n].to_vec(), valid: reg.fp.valid[..n].to_vec(), t0: reg.fp.t0 };
                let t = std::time::Instant::now();
                let _ = evaluate_theme(&own.fp, own.audible, &q);
                cpu[2] += t.elapsed();
            }
            s += 1.0;
        }
        n_cpu += 1;
    }
    let ms = |d: std::time::Duration| d.as_secs_f64() * 1000.0 / n_cpu.max(1) as f64;
    println!(
        "[early] CPU per 600 s HEAD and theme, this (unoptimised test) build, {n_cpu} heads: early tracker {:.0} ms (absent theme) / {:.0} ms (own opening, followed to the end), streaming full matcher {:.0} ms",
        ms(cpu[0]),
        ms(cpu[1]),
        ms(cpu[2])
    );

    assert!(false_fires.is_empty(), "{} false early fires:\n{}", false_fires.len(), false_fires.join("\n"));
    // Research: 28/28 openings, 27/28 endings (JJK S1E3's ending, the PTS-gap release, is the miss).
    assert_eq!(rel_op.len(), 28, "every corpus opening must fire early");
    assert!(rel_ed.len() >= 27, "endings that fire early: {}", rel_ed.len());
    assert!(missed.iter().all(|m| m == "tt12343534:1:3 ed"), "unexpected misses {missed:?}");
    assert!(fails.is_empty(), "{} early-rule failures:\n{}", fails.len(), fails.join("\n"));
    // The timing the matcher.rs comment quotes (OP 12.3-14.1 s, ED 12.4-14.6 s
    // after the theme starts), with a little headroom, so the comment and the
    // implementation cannot drift apart silently.
    let max_of = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    assert!(max_of(&rel_op) <= 14.5, "an opening fired late: {rel_op:?}");
    assert!(max_of(&rel_ed) <= 15.0, "an ending fired late: {rel_ed:?}");
    assert!(app_level.0 == app_level.1, "top-ranked candidate fires on {}/{} slots", app_level.0, app_level.1);
}

/// The early rule when the analysis lags the decoder: the region worker only
/// analyses with its queue drained, so on a fast link it may get a turn only
/// every few seconds of audio. Every corpus opening and ending (own theme, at
/// its truth) must still fire with the same window, and never be withdrawn
/// before the streaming full gate accepts it.
#[test]
#[ignore = "needs AURA_SKIPBENCH_DIR (skipbench corpus)"]
fn skipdetect_early_rule_lagging_analysis() {
    let root = bench();
    let eval = load_json(&root.join("eval_animethemes.json"));
    let rows = eval["rows"].as_array().unwrap().clone();
    let themes = all_corpus_themes(&root);
    let mut jobs = Vec::new();
    for r in &rows {
        let id = r["id"].as_str().unwrap().to_string();
        for (slot, which) in [("op", "head"), ("ed", "tail")] {
            let Some(strict) = r["eval"]["strict"][slot]["theme"].as_str() else { continue };
            let win = pair(&r["eval"]["strict"][slot]["pred"]["A_full"]).unwrap();
            jobs.push((id.clone(), which, strict.to_string(), win));
        }
    }
    let res = par_map(jobs.len(), |k| {
        let (id, which, strict, win) = &jobs[k];
        let cdir = root.join("cache").join(tag_of(id));
        let info = load_json(&cdir.join("info.json"));
        let mut pcm = read_wav(&cdir.join(format!("{which}.wav")));
        if *which == "head" {
            pcm.truncate(HEAD_SAMPLES);
        }
        let t0 = info["passes"][*which]["t0"].as_f64().unwrap();
        let fp = fingerprint(&pcm, t0);
        let secs = pcm.len() as f64 / SR as f64;
        let th = themes.iter().find(|t| &t.base == strict).unwrap();
        let refs = [EarlyRef { idx: 0, fp: &th.fp, audible: th.audible }];
        let full = full_gate_accept(&th.fp, th.audible, &fp, secs);
        let mut lines = Vec::new();
        let mut bad = Vec::new();
        for every in [2.5, 4.0, 7.0] {
            let (ev, _) = simulate_early_every(&fp, secs, &refs, f64::INFINITY, every);
            let fire = ev.iter().find_map(|(s, e)| match e {
                EarlyEvent::Fire { window, .. } => Some((*s, *window)),
                _ => None,
            });
            let retract = ev.iter().find_map(|(s, e)| match e {
                EarlyEvent::Retract { why, .. } => Some((*s, *why)),
                _ => None,
            });
            lines.push(format!("every {every}s: fire {fire:?} retract {retract:?}"));
            match fire {
                None if id == "tt12343534:1:3" && *which == "tail" => {}
                None => bad.push(format!("{id} {which} every {every}s: no fire")),
                Some((_, w)) => {
                    let d = (w.0 - win.0.max(0.0)).abs().max((w.1 - win.1).abs());
                    if d > 0.5 && !(*which == "tail" && w.1 > t0 + secs) {
                        bad.push(format!("{id} {which} every {every}s: window {w:?} vs eval {win:?}"));
                    }
                }
            }
            if let (Some((rs, why)), Some(fs)) = (retract, full) {
                if rs < fs {
                    bad.push(format!("{id} {which} every {every}s: withdrawn at {rs} ({}) before the full gate at {fs}", why.as_str()));
                }
            }
        }
        (format!("[early-lag] {id:18} {which} {strict}: {}", lines.join("; ")), bad)
    });
    let mut fails = Vec::new();
    for (line, bad) in res {
        println!("{line}");
        fails.extend(bad);
    }
    assert!(fails.is_empty(), "{} lagging-analysis failures:\n{}", fails.len(), fails.join("\n"));
}
