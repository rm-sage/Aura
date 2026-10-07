// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/e2e_tests.rs (tests only)
//
// `skipdetect_e2e_server`: an ignored test that serves the REAL Rust side of
// the skip chain to an out-of-process end-to-end harness (a node port of the
// App.tsx skip chain that imports src/skipWindows.ts and src/nextUpGate.ts).
// One JSON request per stdin line, one reply per stdout line prefixed
// `@@E2E `. Commands are the exact Tauri commands App.tsx invokes, called as
// plain functions, plus `detect`, which runs `job::run` either on a replay of
// cached corpus PCM (`replay.rs`) or on a real stream.
//
//   AURA_E2E_DATA_DIR    skipdetect caches (theme lists and fingerprints are
//                        kept between runs; the RESULT cache is deleted before
//                        every detect, so every detect computes)
//   AURA_E2E_ID_MAP      optional Fribb snapshot (anime-id-map-v2.json) for
//                        resolve_mal_for_aniskip
//   AURA_E2E_STREAMS     real-stream mode only: JSON {"<stremio id>": url},
//                        set for this process by the launcher. Never printed.
//   AURA_FFMPEG          optional ffmpeg path (default: the runtime-deps one)
//
// GET only: the IntroDB action is built here as a Fetch (never Submit), and
// nothing votes or submits anywhere. No URL is ever printed: replies carry
// ids, numbers and snapshots only.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{json, Value};

use super::continuity::Silence;
use super::corpus_tests::read_wav;
use super::job::{self, Ctx, Request, Snapshot};
use super::probe::{self, AudioTrack, ProbeInfo};
use super::replay::{Clock, RegionData, Replay};

fn ffmpeg() -> OsString {
    if let Some(p) = std::env::var_os("AURA_FFMPEG") {
        return p;
    }
    let la = std::env::var_os("LOCALAPPDATA").expect("LOCALAPPDATA");
    PathBuf::from(la).join("com.aura.app").join("runtime").join("ffmpeg.exe").into_os_string()
}

fn reply(id: &Value, r: Result<Value, String>) {
    let v = match r {
        Ok(result) => json!({"id": id, "ok": true, "result": result}),
        Err(e) => json!({"id": id, "ok": false, "error": e}),
    };
    println!("@@E2E {v}");
}

fn s(a: &Value, k: &str) -> Option<String> {
    a.get(k).and_then(Value::as_str).map(String::from)
}
fn u(a: &Value, k: &str) -> Option<u64> {
    a.get(k).and_then(|v| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)))
}
fn f(a: &Value, k: &str) -> Option<f64> {
    a.get(k).and_then(Value::as_f64)
}

fn silences(v: &Value) -> Vec<Silence> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| Some(Silence::new(p.get(0)?.as_f64()?, p.get(1)?.as_f64()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// The replay's probe: a recorded production probe's stderr (parsed by the
/// production parser), else the explicit ProbeInfo the harness built.
fn replay_probe(spec: &Value) -> Result<(ProbeInfo, &'static str), String> {
    if let Some(p) = s(spec, "probe_text") {
        let text = std::fs::read_to_string(&p).map_err(|e| format!("probe text: {e}"))?;
        let info = probe::parse_probe(&text);
        if !info.audio.is_empty() {
            return Ok((info, "recorded probe"));
        }
    }
    let p = spec.get("probe").ok_or("no probe in the replay spec")?;
    let audio = p["audio"]
        .as_array()
        .ok_or("probe.audio")?
        .iter()
        .enumerate()
        .map(|(rel, t)| AudioTrack {
            rel,
            abs: u(t, "abs").unwrap_or(rel as u64) as usize,
            lang: s(t, "lang"),
            dispositions: t["dispositions"]
                .as_array()
                .map(|d| d.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            duration_tag: f(t, "duration_tag"),
            title: s(t, "title"),
        })
        .collect();
    Ok((
        ProbeInfo { container_duration: f(p, "container_duration"), start: f(p, "start").unwrap_or(0.0), audio },
        "synthesized probe",
    ))
}

fn region(spec: &Value) -> Option<RegionData> {
    let wav = s(spec, "wav")?;
    let pcm = read_wav(std::path::Path::new(&wav));
    Some(RegionData { pcm: Arc::new(pcm), t0: f(spec, "t0").unwrap_or(0.0), silences: silences(&spec["silences"]) })
}

async fn detect(args: &Value, data_dir: &PathBuf) -> Result<Value, String> {
    let mode = s(args, "mode").unwrap_or_else(|| "replay".into());
    let mut rv = args.get("request").cloned().ok_or("no request")?;
    let id = s(&rv, "stremio_id").ok_or("no stremio_id")?;
    let replay = if mode == "replay" {
        let spec = args.get("replay").ok_or("no replay spec")?;
        let (p, probe_src) = replay_probe(spec)?;
        rv["url"] = json!(format!("https://replay.invalid/{}.mkv", super::corpus_tests::tag_of(&id)));
        Some((
            Arc::new(Replay {
                probe: p,
                head: spec.get("head").and_then(region),
                tail: spec.get("tail").and_then(region),
                head_first_pts: f(spec, "head_first_pts").unwrap_or(0.0),
                keep_up: spec.get("keep_up").and_then(Value::as_bool).unwrap_or(true),
                pace_head: f(spec, "pace_head").unwrap_or(0.0),
                pace_tail: f(spec, "pace_tail").unwrap_or(0.0),
                startup_s: f(spec, "startup_s").unwrap_or(0.0),
                clock: Arc::new(Mutex::new(Clock::default())),
                notes: Mutex::new(Vec::new()),
            }),
            probe_src,
        ))
    } else {
        let raw = std::env::var("AURA_E2E_STREAMS").map_err(|_| "AURA_E2E_STREAMS not set")?;
        let m: HashMap<String, String> = serde_json::from_str(&raw).map_err(|_| "AURA_E2E_STREAMS is not a JSON object")?;
        let url = m.get(&id).ok_or_else(|| format!("no stream for {id}"))?;
        rv["url"] = json!(url);
        None
    };
    let req: Request = serde_json::from_value(rv).map_err(|e| format!("request: {e}"))?;
    let req = req.validate()?;
    // Every detect computes: the result cache would answer a re-run.
    let _ = std::fs::remove_file(data_dir.join(super::cache::RESULT_FILE));
    let t = Instant::now();
    let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let (seen2, clock) = (seen.clone(), replay.as_ref().map(|(r, _)| r.clock.clone()));
    let ctx = Ctx {
        ffmpeg: ffmpeg(),
        data_dir: Some(data_dir.clone()),
        generation: 1,
        publish: Arc::new(move |snap: &Snapshot| {
            let c = clock.as_ref().and_then(|c| c.lock().ok().map(|c| c.clone())).unwrap_or_default();
            seen2.lock().unwrap().push(json!({
                "wall": t.elapsed().as_secs_f64(),
                "region": c.region,
                "pos": c.pos_s,
                "delivered": c.delivered_s,
                "head_total": c.head_total_s,
                "snap": snap,
            }));
        }),
        replay: replay.as_ref().map(|(r, _)| r.clone()),
    };
    let fin = job::run(&ctx, &req).await;
    let wall = t.elapsed().as_secs_f64();
    let timeline = std::mem::take(&mut *seen.lock().unwrap());
    let (notes, probe_src, probe_info) = match &replay {
        Some((r, src)) => (
            r.notes.lock().map(|n| n.clone()).unwrap_or_default(),
            *src,
            json!({
                "container_duration": r.probe.container_duration,
                "start": r.probe.start,
                "audio": r.probe.audio.iter().map(|a| json!({
                    "rel": a.rel, "abs": a.abs, "lang": a.lang, "dispositions": a.dispositions,
                    "duration_tag": a.duration_tag
                })).collect::<Vec<_>>(),
                "picked": probe::pick_track(&r.probe.audio).map(|(n, why)| json!({"rel": n, "abs": r.probe.audio[n].abs, "why": why.as_str()})),
            }),
        ),
        None => (Vec::new(), "real stream", Value::Null),
    };
    Ok(json!({"final": fin, "timeline": timeline, "wall": wall, "notes": notes, "probe_src": probe_src, "probe": probe_info}))
}

async fn handle(cmd: &str, a: &Value, data_dir: &PathBuf) -> Result<Value, String> {
    let to = |v: Result<Value, serde_json::Error>| v.map_err(|e| e.to_string());
    match cmd {
        "resolve_mal_id" => {
            let r = crate::aniskip::resolve_mal_id(s(a, "source").unwrap_or_default(), u(a, "id").unwrap_or(0) as u32).await?;
            Ok(json!(r))
        }
        "resolve_mal_for_aniskip" => Ok(json!(
            crate::aniskip::resolve_mal_for_aniskip(
                s(a, "targetId").unwrap_or_default(),
                s(a, "seriesImdb"),
                u(a, "season").map(|x| x as u32),
                s(a, "title"),
            )
            .await
        )),
        "resolve_mal_id_by_title" => {
            let r = crate::aniskip::resolve_mal_id_by_title(s(a, "title").unwrap_or_default(), u(a, "year").map(|x| x as u32)).await?;
            Ok(json!(r))
        }
        "fetch_skip_windows" => to(serde_json::to_value(
            crate::aniskip::fetch_skip_windows(
                u(a, "malId").unwrap_or(0) as u32,
                u(a, "episode").unwrap_or(0) as u32,
                f(a, "episodeLength").unwrap_or(0.0),
                a.get("treatMixedOpAsOp").and_then(Value::as_bool).unwrap_or(true),
            )
            .await?,
        )),
        "fetch_neighbour_skip_profile" => to(serde_json::to_value(
            crate::aniskip::fetch_neighbour_skip_profile(
                u(a, "malId").unwrap_or(0) as u32,
                u(a, "episode").unwrap_or(0) as u32,
                f(a, "duration").unwrap_or(0.0),
                a.get("treatMixedOpAsOp").and_then(Value::as_bool).unwrap_or(true),
            )
            .await?,
        )),
        "fetch_publicmetadb_skips" => to(serde_json::to_value(
            crate::publicmetadb::fetch_publicmetadb_skips(
                a.get("tmdbId").and_then(Value::as_i64).unwrap_or(0),
                s(a, "mediaType").unwrap_or_else(|| "tv".into()),
                u(a, "season").unwrap_or(0) as u32,
                u(a, "episode").unwrap_or(0) as u32,
                u(a, "courMalId").map(|x| x as u32),
            )
            .await?,
        )),
        "resolve_anime_tmdb_id" => Ok(json!(
            crate::publicmetadb::resolve_anime_tmdb_id(s(a, "source").unwrap_or_default(), u(a, "id").unwrap_or(0) as u32).await
        )),
        "introdb_fetch" => {
            // Always a Fetch: this harness never submits.
            let action = crate::introdb::IntroDbAction::Fetch {
                imdb_id: s(a, "imdb_id").unwrap_or_default(),
                season: u(a, "season").map(|x| x as u32),
                episode: u(a, "episode").map(|x| x as u32),
                duration: f(a, "duration"),
            };
            to(serde_json::to_value(crate::introdb::introdb(action).await?))
        }
        "detect" => detect(a, data_dir).await,
        "ping" => Ok(json!("pong")),
        other => Err(format!("unknown command {other}")),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "end-to-end harness server: driven over stdin by scratchpad e2e/harness.ts"]
async fn skipdetect_e2e_server() {
    // Not a check of its own: without the harness's environment (an
    // `--include-ignored` run of the corpus tests) there is nothing to serve.
    let Some(dir) = std::env::var_os("AURA_E2E_DATA_DIR") else {
        println!("skipped: AURA_E2E_DATA_DIR not set (run through the e2e harness)");
        return;
    };
    let data_dir = PathBuf::from(dir);
    std::fs::create_dir_all(&data_dir).unwrap();
    if let Ok(p) = std::env::var("AURA_E2E_ID_MAP") {
        let text = std::fs::read_to_string(&p).expect("id map");
        let n = crate::anime_id_map::install_snapshot_for_test(&text);
        eprintln!("[e2e] Fribb id map: {n} imdb ids");
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(l) = line else { break };
            if tx.send(l).is_err() {
                break;
            }
        }
    });
    println!("@@E2E {}", json!({"id": "ready"}));
    let data_dir = Arc::new(data_dir);
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = rx.recv().await {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        let cmd = v["cmd"].as_str().unwrap_or("").to_string();
        if cmd == "quit" {
            break;
        }
        let dd = data_dir.clone();
        tasks.spawn(async move {
            let r = handle(&cmd, &v["args"], &dd).await;
            reply(&v["id"], r);
        });
    }
    while tasks.join_next().await.is_some() {}
}
