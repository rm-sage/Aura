// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Pacing for addon hosts that publish a rate limit.
//!
//! AIOStreams limits each route per IP (Stremio meta: 15 requests per 5 s by
//! upstream's default; the rm-sage fork raised it to 400 per 10 s on
//! 2026-11-16, and an instance can set its own) and says so on every answer (`RateLimit-Limit`,
//! `RateLimit-Remaining`, `RateLimit-Reset`, `RateLimit-Policy: 15;w=5`). Over
//! the limit it does not answer 429: a Stremio route gets HTTP 200 with an
//! error pseudo-meta whose description is "Rate Limit Exceeded". The Calendar
//! asks for every library title's meta at once, so with AIOMetadata wrapped
//! inside AIOStreams 269 of 316 requests were refused in one visit
//! (2026-11-15) and those titles were missing from the month.
//!
//! A bucket per (route kind, host) remembers the last budget the host
//! published; `acquire` spends from it and waits for the window to reset when
//! it is empty, `record` updates it from each answer. A host that publishes no
//! budget never gets a bucket, so nothing else is slowed down. A refusal that
//! slips through anyway (requests already in flight, a window that started
//! earlier on the server) is retried by the caller after `record` marks the
//! bucket empty.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::HeaderMap;

/// Longest reset a host may ask for; anything longer is read as this.
const MAX_RESET: Duration = Duration::from_secs(60);
/// The reset assumed for a refusal that names none.
const DEFAULT_RESET: Duration = Duration::from_secs(5);
/// Buckets kept at most; expired ones go first.
const CAP: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Bucket {
    /// Requests left in the current window, by Aura's count.
    remaining: u32,
    /// When the current window ends.
    reset_at: Instant,
    /// The window's size and budget, to start the next one with. A limit of
    /// 0 is unknown (a refusal from a host that publishes none): such a
    /// bucket is dropped when its window ends.
    limit: u32,
    window: Duration,
}

static BUCKETS: OnceLock<Mutex<HashMap<String, Bucket>>> = OnceLock::new();

fn buckets() -> std::sync::MutexGuard<'static, HashMap<String, Bucket>> {
    BUCKETS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// The bucket key for a route kind ("meta") on an addon url's host.
pub fn key(kind: &str, addon_url: &str) -> String {
    let host = url::Url::parse(addon_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
        .unwrap_or_default();
    format!("{kind} {host}")
}

/// What spending one request from `b` at `now` comes to: `Ok` with the bucket
/// after spending (`None`: the bucket is done with), or `Err` with how long
/// to wait first.
fn spend(b: Bucket, now: Instant) -> Result<Option<Bucket>, Duration> {
    if now >= b.reset_at {
        if b.limit == 0 {
            return Ok(None);
        }
        // A new window: assume it started now with the full budget.
        return Ok(Some(Bucket { remaining: b.limit - 1, reset_at: now + b.window, ..b }));
    }
    if b.remaining > 0 {
        return Ok(Some(Bucket { remaining: b.remaining - 1, ..b }));
    }
    Err(b.reset_at - now)
}

/// Wait until a request fits the bucket's budget, then spend one. `Err` when
/// that wait would pass `deadline` (nothing is spent).
pub async fn acquire(key: &str, deadline: Instant) -> Result<(), Duration> {
    loop {
        let wait = {
            let mut map = buckets();
            let now = Instant::now();
            let Some(b) = map.get(key).copied() else { return Ok(()) };
            match spend(b, now) {
                Ok(next) => {
                    match next {
                        Some(b) => map.insert(key.to_string(), b),
                        None => map.remove(key),
                    };
                    return Ok(());
                }
                Err(wait) => wait,
            }
        };
        // A little past the reset, so the server's window has really ended.
        let wait = wait + Duration::from_millis(150);
        if Instant::now() + wait > deadline {
            return Err(wait);
        }
        tokio::time::sleep(wait).await;
    }
}

/// The budget an answer publishes: (limit, remaining, reset, window).
fn published(headers: &HeaderMap) -> (Option<u32>, Option<u32>, Option<Duration>, Option<Duration>) {
    let num = |names: &[&str]| -> Option<u64> {
        names.iter().find_map(|n| {
            headers.get(*n)?.to_str().ok()?.split([',', ';']).next()?.trim().parse::<u64>().ok()
        })
    };
    let limit = num(&["ratelimit-limit", "x-ratelimit-limit"]).map(|v| v.min(u32::MAX as u64) as u32);
    let remaining = num(&["ratelimit-remaining", "x-ratelimit-remaining"]).map(|v| v.min(u32::MAX as u64) as u32);
    let reset = num(&["ratelimit-reset", "x-ratelimit-reset", "retry-after"]).map(|v| {
        // A delta in seconds; a value that large is an epoch time instead.
        if v > 1_000_000_000 {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Duration::from_secs(v.saturating_sub(now))
        } else {
            Duration::from_secs(v)
        }
    });
    let window = headers
        .get("ratelimit-policy")
        .and_then(|v| v.to_str().ok())
        .and_then(|p| p.split(';').find_map(|part| part.trim().strip_prefix("w=")?.trim().parse::<u64>().ok()))
        .map(Duration::from_secs);
    (limit, remaining, reset, window)
}

/// The `RateLimit-Remaining` an answer publishes, if any. An addon error item
/// that reads as a rate limit is the HOST's refusal only when this is 0 or
/// absent: AIOStreams relays a wrapped addon's own 429 with the same item
/// while its own budget is still open.
pub fn published_remaining(headers: &HeaderMap) -> Option<u32> {
    published(headers).1
}

/// The bucket after an answer: `prev` (if any) updated with what the answer
/// published, `refused` when the host turned the request away.
fn updated(prev: Option<Bucket>, headers: &HeaderMap, refused: bool, now: Instant) -> Option<Bucket> {
    let (limit, remaining, reset, window) = published(headers);
    if prev.is_none() && limit.is_none() && remaining.is_none() && !refused {
        return None; // A host with no published budget is left alone.
    }
    let reset = reset.unwrap_or(DEFAULT_RESET).clamp(Duration::from_secs(1), MAX_RESET);
    let reset_at = now + reset;
    let remaining = if refused { 0 } else { remaining.unwrap_or(u32::MAX) };
    let limit = limit.filter(|&l| l > 0).or(prev.map(|b| b.limit)).unwrap_or(0);
    let window = window.or(prev.map(|b| b.window)).unwrap_or(reset).clamp(Duration::from_secs(1), MAX_RESET);
    let next = Bucket { remaining, reset_at, limit, window };
    Some(match prev {
        // Answers to requests sent together arrive in any order: within one
        // window keep the LOWER count, which also holds what Aura has spent
        // since. A reset more than a second later is a new window.
        Some(p) if now < p.reset_at && reset_at <= p.reset_at + Duration::from_secs(1) => Bucket {
            remaining: p.remaining.min(remaining),
            reset_at: if refused { reset_at.max(p.reset_at) } else { p.reset_at },
            limit,
            window,
        },
        _ => next,
    })
}

/// Record an answer from the host behind `key`.
pub fn record(key: &str, headers: &HeaderMap, refused: bool) {
    let mut map = buckets();
    let now = Instant::now();
    match updated(map.get(key).copied(), headers, refused, now) {
        Some(b) => {
            map.insert(key.to_string(), b);
        }
        None => return,
    }
    if map.len() > CAP {
        map.retain(|_, b| b.reset_at > now);
        while map.len() > CAP {
            let Some(k) = map.keys().next().cloned() else { break };
            map.remove(&k);
        }
    }
}

/// An addon error item's text saying the host refused for its rate limit.
pub fn is_rate_limit_text(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    t.contains("rate limit") || t.contains("too many requests")
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderName, HeaderValue};

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        h
    }

    fn aio(remaining: &str, reset: &str) -> HeaderMap {
        headers(&[
            ("ratelimit-limit", "15"),
            ("ratelimit-remaining", remaining),
            ("ratelimit-reset", reset),
            ("ratelimit-policy", "15;w=5"),
        ])
    }

    #[test]
    fn a_host_without_a_budget_gets_no_bucket() {
        let now = Instant::now();
        assert_eq!(updated(None, &HeaderMap::new(), false, now), None);
        // A refusal with no headers still waits the default reset.
        let b = updated(None, &HeaderMap::new(), true, now).unwrap();
        assert_eq!((b.remaining, b.reset_at), (0, now + DEFAULT_RESET));
        // ... and is dropped once that has passed, rather than pacing for good.
        assert_eq!(spend(b, now + Duration::from_secs(6)), Ok(None));
    }

    #[test]
    fn spends_the_published_budget_then_waits_for_the_reset() {
        let now = Instant::now();
        let mut b = updated(None, &aio("2", "5"), false, now).unwrap();
        assert_eq!((b.remaining, b.limit, b.window), (2, 15, Duration::from_secs(5)));
        b = spend(b, now).unwrap().unwrap();
        b = spend(b, now).unwrap().unwrap();
        assert_eq!(spend(b, now), Err(Duration::from_secs(5)));
        // Past the reset a new window starts with the full budget, one spent.
        let later = now + Duration::from_secs(6);
        let n = spend(b, later).unwrap().unwrap();
        assert_eq!((n.remaining, n.reset_at), (14, later + Duration::from_secs(5)));
    }

    #[test]
    fn out_of_order_answers_keep_the_lower_count() {
        let now = Instant::now();
        let b = updated(None, &aio("3", "5"), false, now).unwrap();
        // An earlier request's answer arrives later with a higher count.
        let b = updated(Some(b), &aio("9", "5"), false, now + Duration::from_millis(100)).unwrap();
        assert_eq!(b.remaining, 3);
        // A refusal empties the bucket.
        let b = updated(Some(b), &aio("0", "4"), true, now + Duration::from_millis(200)).unwrap();
        assert_eq!(b.remaining, 0);
        // A later window replaces the old one.
        let b = updated(Some(b), &aio("14", "5"), false, now + Duration::from_secs(6)).unwrap();
        assert_eq!(b.remaining, 14);
    }

    #[test]
    fn reads_resets_and_refusal_text() {
        let (_, _, reset, _) = published(&headers(&[("retry-after", "120")]));
        assert_eq!(reset, Some(Duration::from_secs(120)));
        let now = Instant::now();
        let b = updated(None, &headers(&[("retry-after", "120")]), true, now).unwrap();
        assert_eq!(b.reset_at, now + MAX_RESET, "a long reset is capped");
        assert!(is_rate_limit_text("Rate Limit Exceeded"));
        assert!(is_rate_limit_text("HTTP 429 Too Many Requests"));
        assert!(!is_rate_limit_text("Failed to parse meta"));
        assert_eq!(key("meta", "https://AIO.example.dev/stremio/u/x"), "meta aio.example.dev");
    }

    #[test]
    fn published_remaining_tells_a_host_refusal_from_a_relayed_one() {
        // The call sites treat None or 0 as the host's own refusal.
        assert_eq!(published_remaining(&headers(&[])), None);
        assert_eq!(published_remaining(&headers(&[("ratelimit-remaining", "0")])), Some(0));
        assert_eq!(published_remaining(&headers(&[("ratelimit-remaining", "380")])), Some(380));
        assert_eq!(published_remaining(&headers(&[("x-ratelimit-remaining", "7")])), Some(7));
    }
}

/// Live: a burst of metas against a rate-limited addon all come back.
/// `AURA_LIVE_META_ADDON=<addon base url> cargo test --lib live_meta_burst -- --ignored --nocapture`
#[cfg(test)]
mod live_tests {
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_meta_burst_is_paced_not_refused() {
        let Ok(base) = std::env::var("AURA_LIVE_META_ADDON") else { return };
        let ids = [
            "tt0388629", "tt0903747", "tt0944947", "tt2560140", "tt0877057", "tt1355642", "tt0434706",
            "tt9335498", "tt9813792", "tt2098220", "tt0213338", "tt0409591", "tt0988824", "tt1528406",
            "tt3398540", "tt5626028", "tt4508902", "tt6111130", "tt10233448", "tt12343534", "tt0108778",
            "tt0386676", "tt1520211", "tt2442560", "tt1475582", "tt2085059", "tt0098904", "tt0121955",
            "tt0475784", "tt1190634", "tt2861424", "tt3032476", "tt5180504", "tt7366338", "tt8111088",
            "tt9140554", "tt9064858", "tt9288030", "tt9319668", "tt7772588",
        ];
        let started = std::time::Instant::now();
        let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
        let mut set = tokio::task::JoinSet::new();
        for id in ids {
            let (base, sem) = (base.clone(), sem.clone());
            set.spawn(async move {
                let _p = sem.acquire().await.unwrap();
                let r = crate::stremio::fetch_meta_detail(base, "series".into(), id.into(), Some("live".into())).await;
                (id, r.map(|_| ()).map_err(|e| e))
            });
        }
        let (mut ok, mut limited, mut other) = (0, 0, Vec::new());
        while let Some(r) = set.join_next().await {
            match r.unwrap() {
                (_, Ok(())) => ok += 1,
                (_, Err(e)) if e.contains("rate limited") => limited += 1,
                (id, Err(e)) => other.push(format!("{id}: {e}")),
            }
        }
        eprintln!("ok {ok}, rate limited {limited}, other {other:?}, {:.1} s", started.elapsed().as_secs_f64());
        assert_eq!(limited, 0);
    }
}
