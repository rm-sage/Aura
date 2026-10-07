// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/animethemes.rs
//
// The AnimeThemes client behind Layer 1: a cour's OP / ED theme list, and one
// theme's fingerprint (download the .ogg into memory, decode it through
// ffmpeg's stdin, fingerprint it, DISCARD the audio, cache only the
// fingerprint).
//
//   * ONE base-URL const for the API; theme audio is fetched only from a link
//     on an AnimeThemes host (https, `animethemes.moe` or a subdomain), so a
//     tampered list cannot point Aura's client anywhere else.
//   * reqwest with rustls and `https_only(true)`; GET only. Never POSTs.
//   * Paced: every request (API or audio) starts at least 1 s after the
//     previous one (the API allows 90 requests a minute).
//   * Fails closed: a network error yields no list (no Layer 1 result) and is
//     never cached; only an ANSWER (themes, or none) is.
//
// Theme LENGTH is the decoded fingerprint length (codes / 21.53 per second),
// the quantity the parity reference used, never an API field.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::audio;
use super::cache::{self, ThemeFp};
use super::fingerprint::{fingerprint, theme_audible};
use super::themes::{Kind, ThemeMeta};

/// The AnimeThemes API. The only API host skipdetect talks to.
pub const ANIMETHEMES_API: &str = "https://api.animethemes.moe";
/// Minimum spacing between request STARTS (API limit: 90 per minute).
const PACE: Duration = Duration::from_millis(1000);
const TIMEOUT: Duration = Duration::from_secs(45);
/// More themes than any real cour has (One Piece, every OP and ED: 74).
const MAX_THEMES: usize = 200;
/// At most this many sibling cours (sequel / prequel) are tried.
pub const MAX_SIBLINGS: usize = 4;
/// Redirects followed per request (each must stay on an AnimeThemes host).
const MAX_REDIRECTS: usize = 5;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            // The host allowlist must hold across redirects too: a redirect
            // that leaves AnimeThemes is NOT followed. The 3xx itself comes
            // back, which `download` (non-2xx) and `theme_list` (Unavailable,
            // never cached) both treat as a failure.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    attempt.error("too many redirects")
                } else if link_allowed(attempt.url().as_str()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .timeout(TIMEOUT)
            .pool_max_idle_per_host(1)
            .pool_idle_timeout(Duration::from_secs(30))
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " skipdetect"))
            .build()
            .expect("animethemes HTTP client init failed")
    })
}

/// Serialises request starts at least `PACE` apart.
static LAST_REQUEST: tokio::sync::Mutex<Option<Instant>> = tokio::sync::Mutex::const_new(None);

async fn pace() {
    let mut last = LAST_REQUEST.lock().await;
    if let Some(t) = *last {
        let wait = PACE.saturating_sub(t.elapsed());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
    }
    *last = Some(Instant::now());
}

/// One theme audio file, as Layer 1 needs it. One record per distinct audio
/// file, in API order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ThemeRec {
    pub audio_id: u64,
    pub basename: String,
    /// AnimeThemes' public audio link (never a stream URL).
    pub link: String,
    #[serde(default)]
    pub size: u64,
    /// "OP1", "ED2".
    pub slug: String,
    pub op: bool,
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub episodes: Option<String>,
    /// EVERY video using this audio is `Over`. A list cached before the
    /// per-audio rule set this when ANY video of the entry was Over, which
    /// only errs toward excluding an ED (and it re-fetches within a week).
    pub over: bool,
    /// SOME videos using this audio, or another audio of its entry, are
    /// `Over`, and not all of this audio's own (prompt-only, still a
    /// candidate). Absent in lists cached before it existed.
    #[serde(default)]
    pub over_partial: bool,
    /// Every video using this audio is `Transition`.
    pub transition: bool,
}

impl ThemeRec {
    pub fn kind(&self) -> Kind {
        if self.op {
            Kind::Op
        } else {
            Kind::Ed
        }
    }

    /// "OP1" or "ED1v2" for logs and the result.
    pub fn label(&self) -> String {
        match self.version {
            Some(v) if v > 1 => format!("{}v{v}", self.slug),
            _ => self.slug.clone(),
        }
    }

    /// The policy's view. `mal` namespaces the slug so a sibling cour's "ED1"
    /// is never mistaken for a version of this cour's "ED1".
    pub fn meta(&self, mal: u32) -> ThemeMeta {
        ThemeMeta {
            slug: format!("{mal}:{}", self.slug),
            kind: self.kind(),
            episodes: self.episodes.clone(),
            over: self.over,
            over_partial: self.over_partial,
            transition: self.transition,
        }
    }
}

// ── wire shapes (only what is read) ─────────────────────────────────────────

#[derive(Deserialize, Default)]
struct ApiRoot {
    /// REQUIRED: a 200 body without it (an error page, a changed envelope) is
    /// not "AnimeThemes has nothing for this id" and must not be cached as a
    /// miss; it fails the parse and reads as Unavailable (never cached).
    anime: Vec<ApiAnime>,
}

#[derive(Deserialize, Default)]
struct ApiAnime {
    #[serde(default)]
    animethemes: Vec<ApiTheme>,
}

#[derive(Deserialize, Default)]
struct ApiTheme {
    #[serde(default)]
    slug: Option<String>,
    #[serde(default, rename(deserialize = "type"))]
    kind: Option<String>,
    #[serde(default)]
    animethemeentries: Vec<ApiEntry>,
}

#[derive(Deserialize, Default)]
struct ApiEntry {
    #[serde(default)]
    episodes: Option<String>,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    videos: Vec<ApiVideo>,
}

#[derive(Deserialize, Default)]
struct ApiVideo {
    #[serde(default)]
    overlap: Option<String>,
    #[serde(default)]
    audio: Option<ApiAudio>,
}

#[derive(Deserialize, Default)]
struct ApiAudio {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    basename: Option<String>,
    #[serde(default)]
    link: Option<String>,
    #[serde(default)]
    size: Option<u64>,
}

/// An audio link Aura will download: https on an AnimeThemes host.
pub fn link_allowed(link: &str) -> bool {
    let Ok(u) = url::Url::parse(link) else { return false };
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return false;
    }
    match u.host_str() {
        Some(h) => {
            let h = h.to_ascii_lowercase();
            h == "animethemes.moe" || h.ends_with(".animethemes.moe")
        }
        None => false,
    }
}

/// Parse an `/anime?...include=animethemes.animethemeentries.videos.audio`
/// answer into one record per distinct audio file (API order).
pub fn parse_theme_list(body: &str) -> Result<Vec<ThemeRec>, String> {
    let root: ApiRoot = serde_json::from_str(body).map_err(|e| format!("animethemes parse: {e}"))?;
    // Pass 1: per audio id, the overlaps of every video that uses it, and
    // whether any entry containing it has an "Over" video.
    let mut overlaps: HashMap<u64, Vec<String>> = HashMap::new();
    let mut entry_over: HashSet<u64> = HashSet::new();
    for an in &root.anime {
        for th in &an.animethemes {
            for en in &th.animethemeentries {
                let any_over = en.videos.iter().any(|v| v.overlap.as_deref() == Some("Over"));
                for v in &en.videos {
                    if let Some(id) = v.audio.as_ref().and_then(|a| a.id) {
                        overlaps.entry(id).or_default().push(v.overlap.clone().unwrap_or_default());
                        if any_over {
                            entry_over.insert(id);
                        }
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for an in &root.anime {
        for th in &an.animethemes {
            let op = match th.kind.as_deref().map(str::to_ascii_uppercase).as_deref() {
                Some("OP") => true,
                Some("ED") => false,
                _ => continue,
            };
            let Some(slug) = th.slug.clone().filter(|s| !s.is_empty() && s.len() <= 32) else { continue };
            for en in &th.animethemeentries {
                for v in &en.videos {
                    let Some(a) = v.audio.as_ref() else { continue };
                    let (Some(id), Some(link)) = (a.id, a.link.as_deref()) else { continue };
                    if !link_allowed(link) || !seen.insert(id) {
                        continue;
                    }
                    if a.size.is_some_and(|s| s as usize > audio::MAX_THEME_BYTES) {
                        continue;
                    }
                    let ov = overlaps.get(&id).map(Vec::as_slice).unwrap_or(&[]);
                    // Over is judged PER AUDIO: fully Over only when every
                    // video using this audio is Over. One clean video (or an
                    // Over video of ANOTHER audio in the entry) makes it
                    // partial: kept, prompt-only.
                    let all_over = !ov.is_empty() && ov.iter().all(|o| o == "Over");
                    let any_over = ov.iter().any(|o| o == "Over") || entry_over.contains(&id);
                    out.push(ThemeRec {
                        audio_id: id,
                        basename: a.basename.clone().unwrap_or_default().chars().take(120).collect(),
                        link: link.to_string(),
                        size: a.size.unwrap_or(0),
                        slug: slug.clone(),
                        op,
                        version: en.version,
                        episodes: en.episodes.clone().map(|e| e.chars().take(64).collect()),
                        over: all_over,
                        over_partial: any_over && !all_over,
                        transition: !ov.is_empty() && ov.iter().all(|o| o == "Transition"),
                    });
                    if out.len() >= MAX_THEMES {
                        return Ok(out);
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Why a theme list could not be had (never cached).
#[derive(Clone, Debug)]
pub struct Unavailable(pub String);

/// A cour's theme list: from the cache, else the API (the answer, empty or
/// not, is cached). `Ok(vec![])` means AnimeThemes has nothing for the id.
pub async fn theme_list(data_dir: Option<&Path>, mal: u32) -> Result<Vec<ThemeRec>, Unavailable> {
    if let Some(d) = data_dir {
        let d = d.to_path_buf();
        let hit = tokio::task::spawn_blocking(move || cache::get_theme_list::<Vec<ThemeRec>>(&d, mal)).await.ok().flatten();
        if let Some(list) = hit {
            return Ok(list.unwrap_or_default());
        }
    }
    let url = format!(
        "{ANIMETHEMES_API}/anime?filter[has]=resources&filter[site]=MyAnimeList&filter[external_id]={mal}\
         &include=animethemes.animethemeentries.videos.audio"
    );
    pace().await;
    let resp = client()
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| Unavailable(crate::stremio::reqwest_err_for_log(&e)))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(Unavailable(format!("HTTP {}", status.as_u16())));
    }
    let body = resp.text().await.map_err(|e| Unavailable(crate::stremio::reqwest_err_for_log(&e)))?;
    let list = parse_theme_list(&body).map_err(Unavailable)?;
    if let Some(d) = data_dir {
        let d = d.to_path_buf();
        let store = (!list.is_empty()).then(|| list.clone());
        let _ = tokio::task::spawn_blocking(move || cache::put_theme_list(&d, mal, store)).await;
    }
    Ok(list)
}

/// Sequel / prequel anime of a cour (MyAnimeList relations via tenrai), at
/// most `MAX_SIBLINGS`, nearest relation types first. `Ok(vec![])` means
/// MyAnimeList answered (no relations, or no entry for the id); an outage is
/// `Unavailable`, so a caller never takes it for "no siblings" and caches it.
pub async fn sibling_mal_ids(mal: u32) -> Result<Vec<u32>, Unavailable> {
    let full = match crate::tenrai::anime_full_checked(mal).await {
        Ok(Some(full)) => full,
        Ok(None) => return Ok(Vec::new()),
        // The error text can carry the tenrai URL; tenrai logs it itself.
        Err(_) => return Err(Unavailable("MyAnimeList relations unavailable".into())),
    };
    let mut out = Vec::new();
    for want in ["Sequel", "Prequel"] {
        for r in &full.relations {
            if !r.relation.as_deref().is_some_and(|x| x.eq_ignore_ascii_case(want)) {
                continue;
            }
            for e in &r.entry {
                let anime = e.kind.as_deref().map_or(true, |k| k.eq_ignore_ascii_case("anime"));
                if anime && e.mal_id != 0 && e.mal_id != mal && !out.contains(&e.mal_id) {
                    out.push(e.mal_id);
                }
            }
        }
    }
    out.truncate(MAX_SIBLINGS);
    Ok(out)
}

async fn download(link: &str) -> Result<Vec<u8>, String> {
    if !link_allowed(link) {
        return Err("theme link not on an AnimeThemes host".into());
    }
    pace().await;
    let mut resp = client().get(link).send().await.map_err(|e| crate::stremio::reqwest_err_for_log(&e))?;
    if !resp.status().is_success() {
        return Err(format!("theme audio HTTP {}", resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|n| n as usize > audio::MAX_THEME_BYTES) {
        return Err("theme audio too large".into());
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| crate::stremio::reqwest_err_for_log(&e))? {
        if out.len() + chunk.len() > audio::MAX_THEME_BYTES {
            return Err("theme audio too large".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Fingerprint decoded theme PCM (CPU: call from a blocking thread).
pub fn theme_fp_from_pcm(rec: &ThemeRec, pcm: &[i16]) -> ThemeFp {
    ThemeFp {
        audio_id: rec.audio_id,
        size: rec.size,
        samples: pcm.len() as u64,
        audible: theme_audible(pcm),
        fp: fingerprint(pcm, 0.0),
    }
}

/// One theme's fingerprint: from `theme-fp/`, else downloaded, decoded and
/// fingerprinted (the audio is dropped here) and cached. The bool says
/// whether a download happened (it counts toward the per-kind cap).
pub async fn load_theme_fp(ffmpeg: &OsStr, data_dir: Option<&Path>, rec: &ThemeRec) -> Result<(Arc<ThemeFp>, bool), String> {
    if let Some(d) = data_dir {
        let (d, id, size) = (d.to_path_buf(), rec.audio_id, rec.size);
        if let Ok(Some(hit)) = tokio::task::spawn_blocking(move || cache::get_theme_fp(&d, id, size)).await {
            if !hit.fp.is_empty() {
                return Ok((Arc::new(hit), false));
            }
        }
    }
    let bytes = download(&rec.link).await?;
    let pcm = audio::decode_theme(ffmpeg, bytes).await?;
    let r = rec.clone();
    let t = tokio::task::spawn_blocking(move || theme_fp_from_pcm(&r, &pcm)).await.map_err(|e| e.to_string())?;
    if t.fp.is_empty() {
        return Err("theme decoded to nothing".into());
    }
    let t = Arc::new(t);
    if let Some(d) = data_dir {
        let (d, t2) = (d.to_path_buf(), t.clone());
        let _ = tokio::task::spawn_blocking(move || cache::put_theme_fp(&d, &t2)).await;
    }
    Ok((t, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"{"anime":[{"id":1,"name":"X","animethemes":[
      {"id":1,"slug":"OP1","type":"OP","animethemeentries":[
        {"episodes":"2-13","version":1,"videos":[
          {"overlap":"None","audio":{"id":10,"basename":"X-OP1.ogg","link":"https://a.animethemes.moe/X-OP1.ogg","size":2000000}},
          {"overlap":"None","audio":{"id":10,"basename":"X-OP1.ogg","link":"https://a.animethemes.moe/X-OP1.ogg","size":2000000}}]}]},
      {"id":2,"slug":"ED1","type":"ED","animethemeentries":[
        {"episodes":"1","version":1,"videos":[{"overlap":"None","audio":{"id":20,"basename":"X-ED1.ogg","link":"https://a.animethemes.moe/X-ED1.ogg"}}]},
        {"episodes":"28","version":3,"videos":[{"overlap":"Transition","audio":{"id":21,"basename":"X-ED1v3.ogg","link":"https://a.animethemes.moe/X-ED1v3.ogg"}}]}]},
      {"id":3,"slug":"ED3","type":"ED","animethemeentries":[
        {"episodes":"13","videos":[
          {"overlap":"None","audio":{"id":30,"basename":"X-ED3.ogg","link":"https://a.animethemes.moe/X-ED3.ogg"}},
          {"overlap":"Over","audio":{"id":31,"basename":"X-ED3-Over.ogg","link":"https://a.animethemes.moe/X-ED3b.ogg"}}]}]},
      {"id":4,"slug":"IN1","type":"IN","animethemeentries":[]},
      {"id":5,"slug":"ED4","type":"ED","animethemeentries":[
        {"videos":[{"overlap":"None","audio":{"id":40,"basename":"evil.ogg","link":"https://evil.example/x.ogg"}},
                   {"overlap":"None","audio":{"id":41,"basename":"plain.ogg","link":"http://a.animethemes.moe/x.ogg"}},
                   {"overlap":"None","audio":{"id":42,"basename":"huge.ogg","link":"https://a.animethemes.moe/h.ogg","size":99999999}}]}]}
    ]}],"links":{},"meta":{}}"#;

    #[test]
    fn parse_one_record_per_audio_with_overlap_rules() {
        let l = parse_theme_list(SAMPLE).unwrap();
        let ids: Vec<u64> = l.iter().map(|t| t.audio_id).collect();
        assert_eq!(ids, vec![10, 20, 21, 30, 31], "deduped, IN skipped, foreign / http / oversize links dropped");
        assert!(l[0].op && l[0].slug == "OP1" && l[0].episodes.as_deref() == Some("2-13") && l[0].size == 2_000_000);
        assert!(!l[1].op && !l[1].over && !l[1].transition);
        assert!(l[2].transition && !l[2].over && l[2].version == Some(3));
        assert_eq!(l[2].label(), "ED1v3");
        // The entry has an Over video: the audio used only by it is fully
        // Over (excluded as an ED), the clean audio of the same entry is
        // partial (prompt-only, still a candidate).
        assert!(l[4].over && !l[4].over_partial);
        assert!(!l[3].over && l[3].over_partial);
        let m = l[2].meta(56784);
        assert_eq!(m.slug, "56784:ED1");
        assert_eq!(m.kind, Kind::Ed);
        assert!(parse_theme_list("{\"anime\":[]}").unwrap().is_empty());
        assert!(parse_theme_list("not json").is_err());
        // A 200 body without `anime` is not an answer: it must fail (and so
        // be Unavailable, never cached as a one-day miss).
        assert!(parse_theme_list("{}").is_err());
        assert!(parse_theme_list("{\"message\":\"Server Error\"}").is_err());
    }

    #[test]
    fn over_is_per_audio() {
        // Pop Team Epic ED3: ONE audio used by an NCBD "None" video and a TV
        // "Over" video. TYBW 1:13 ED3: one audio, only an Over video.
        let body = r#"{"anime":[{"animethemes":[
          {"slug":"ED3","type":"ED","animethemeentries":[{"episodes":"5","videos":[
            {"overlap":"None","audio":{"id":50,"link":"https://a.animethemes.moe/p-ED3.ogg"}},
            {"overlap":"Over","audio":{"id":50,"link":"https://a.animethemes.moe/p-ED3.ogg"}}]}]},
          {"slug":"ED4","type":"ED","animethemeentries":[{"episodes":"13","videos":[
            {"overlap":"Over","audio":{"id":60,"link":"https://a.animethemes.moe/t-ED3.ogg"}}]}]}]}]}"#;
        let l = parse_theme_list(body).unwrap();
        assert_eq!(l.len(), 2);
        assert!(!l[0].over && l[0].over_partial, "a clean video of the same audio makes it partial");
        assert!(l[1].over && !l[1].over_partial, "only Over videos: fully Over");
        // A list cached before the field existed reads it as false.
        let old: ThemeRec = serde_json::from_value(serde_json::json!({
            "audio_id": 1, "basename": "x.ogg", "link": "https://a.animethemes.moe/x.ogg", "size": 0,
            "slug": "ED1", "op": false, "over": true, "transition": false
        }))
        .unwrap();
        assert!(old.over && !old.over_partial);
    }

    #[test]
    fn links() {
        assert!(link_allowed("https://a.animethemes.moe/Bleach2024-OP1.ogg"));
        assert!(link_allowed("https://animethemes.moe/x.ogg"));
        assert!(!link_allowed("http://a.animethemes.moe/x.ogg"));
        assert!(!link_allowed("https://animethemes.moe.evil.example/x.ogg"));
        assert!(!link_allowed("https://evilanimethemes.moe/x.ogg"));
        assert!(!link_allowed("https://u:p@a.animethemes.moe/x.ogg"));
        assert!(!link_allowed("https://a.animethemes.moe:8443/x.ogg"));
        assert!(!link_allowed("file:///c:/x.ogg"));
        assert!(!link_allowed("not a url"));
        // Redirect targets the client's redirect policy must refuse.
        assert!(!link_allowed("https://cdn.evil.example/Bleach2024-OP1.ogg"));
        assert!(!link_allowed("http://a.animethemes.moe/redirected.ogg"));
        assert!(!link_allowed("https://127.0.0.1/x.ogg"));
        assert!(!link_allowed("https://animethemes.moe@evil.example/x.ogg"));
        assert!(link_allowed("https://v.animethemes.moe/x.webm"));
    }

    #[test]
    fn base_url_is_https_and_single() {
        assert!(ANIMETHEMES_API.starts_with("https://") && !ANIMETHEMES_API.ends_with('/'));
    }
}
