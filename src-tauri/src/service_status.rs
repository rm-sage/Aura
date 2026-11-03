// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Service status: the probes behind the title-bar status chip.
//!
//! One tagged command, `service_status`, with one action today (`check`), so a
//! future action costs no new registration sites. A check answers four
//! questions at once:
//!
//! 1. Is Aura's own server (aura.animasec.dev: OAuth, Aura Cloud sync, release
//!    search) answering? `GET /healthz` -> 200 "ok".
//! 2. Is each installed addon answering? The frontend hands over the addon
//!    BASE URLs it holds (`AddonEntry.url`: `get_synced_addons` and
//!    `addons.rs` strip `/manifest.json`); we append `/manifest.json` the way
//!    every stremio.rs fetch does and time the headers. The bare base is not a
//!    route on most addons (WatchHub, a Torrentio config base and AIOStreams
//!    all answer it 404 while their manifest answers 200). These URLs carry
//!    addon CONFIG TOKENS in their paths, so they are never logged raw
//!    (`redact_sensitive_url`) and never echoed back: the reply is
//!    index-aligned with the request instead. A LOOPBACK addon that refuses
//!    the connection (Stremio's protected "Local Files" addon on
//!    127.0.0.1:11470, which only answers while Stremio's own streaming server
//!    runs) is reported `not_running`, not down: the user cannot uninstall
//!    it, and a red chip for it would be permanent.
//! 3. Is the Watch Together relay answering? The relay Worker answers
//!    `GET /health` with 200 "aura-watch-relay ok".
//! 4. What do the debrid providers the user chose to monitor say about
//!    themselves? Endpoints come from a FIXED table here, never from the
//!    frontend, and are parsed into one normalized state. Only providers with
//!    a verified unauthenticated endpoint are in the table: three publish a
//!    real status page (Better Stack: TorBox, Real-Debrid; Atlassian
//!    Statuspage: put.io), three only an API that can be pinged (AllDebrid,
//!    Premiumize, Debrid-Link), which says "answering" and nothing more, so
//!    those are reported as `reachability_only`. Usenet providers publish
//!    nothing machine-readable at all (researched 2026-11-01).
//!
//! Provider answers are cached 60 s (one entry per table row, so the cache is
//! bounded by construction): opening the panel twice in a minute must not
//! pull TorBox's tens-of-KB status payload twice. A FAILED fetch is cached for
//! 5 s only (`PROVIDER_FAIL_TTL`). Nothing else is cached; the frontend
//! throttles the rest (its throttle state is module-level, so a title-bar
//! remount on every fullscreen exit does not re-probe).
//!
//! LATENCY: what the number means. The first version timed one request to
//! response headers. At a 5 min cadence against a 30 s pool idle timeout that
//! request ALWAYS opened a new connection, so the figure was DNS + TCP + TLS +
//! the request, about four round trips. Measured from the maintainer's machine
//! (2026-11-01): aura.animasec.dev reported 146-175 ms while curl put its TCP
//! handshake at ~51 ms and a request on a kept-alive connection at ~41 ms.
//! The figures now are:
//!
//! - Aura server and relay: `ping` = a SECOND request to the health route on
//!   the connection the first one left open. The route does no work, so this
//!   is one network round trip plus the server's turnaround. The first
//!   request's time is kept as `cold_ms` (what a new connection costs).
//! - Addons: `response` = time to the manifest's response headers on a new
//!   connection. Building a manifest is server work (an aggregator's can take
//!   hundreds of ms), and asking twice would double the requests to someone's
//!   server, so this stays a cold response time and is labelled as one. The
//!   network round trip is measured on its own as one TCP handshake
//!   (`rtt_ms`), so the tooltip can say how much of the response is distance.
//!   The handshake runs BESIDE the manifest request, never in front of it, so
//!   a host that drops SYNs costs one connect timeout, not two. It races the
//!   address families the way the request does, so on a healthy host it ends
//!   about when the request does (see `RTT_TIMEOUT` for when it can outlast it).
//!
//! Every timer starts inside the probe, after the concurrency limiter admitted
//! it, so waiting for a slot is never counted.

use std::collections::HashMap;
use std::future::Future;
use std::pin::pin;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::future::{select, Either};
use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::stremio::{redact_sensitive_url, reqwest_err_for_log};

/// Aura's server health route. The one place this module names the host.
const AURA_HEALTH_URL: &str = "https://aura.animasec.dev/healthz";

/// Addon list cap. A Stremio account with more than this many addons exists,
/// but a status panel listing them all would not be readable anyway, and each
/// probe is a real request to someone's server.
const MAX_ADDONS: usize = 40;
/// Longest relay URL accepted from the frontend.
const MAX_URL_LEN: usize = 2048;
/// Longest addon manifest URL probed. Well above `MAX_URL_LEN` because an
/// encrypted or base64 config lives in the path, and `fetch_streams` sends the
/// same URL to the same host uncapped: a healthy addon must not read as down.
/// `isCheckable` (ServiceStatusChip.tsx) mirrors this, so a longer one shows as
/// "Not checkable" and the rejection in `probe_addon` is only a defence.
const MAX_ADDON_URL_LEN: usize = 16 * 1024;
/// Parallel addon probes. Matches the "do not hammer" spirit of the addon
/// fan-out: a 40-addon account takes ~10 waves, still well inside a poll.
const ADDON_CONCURRENCY: usize = 4;
/// Per-addon timeout. A self-hosted addon on a sleepy box can take a few
/// seconds to wake; past this it is reported as not answering.
const ADDON_TIMEOUT: Duration = Duration::from_secs(6);
/// Aura server / relay / provider timeout.
const STRICT_TIMEOUT: Duration = Duration::from_secs(10);
/// Provider answer lifetime.
const PROVIDER_TTL: Duration = Duration::from_secs(60);
/// Lifetime of a provider fetch that FAILED (no answer, a 5xx, an unreadable
/// body). Short, because a failure here is as often this machine's network as
/// the provider: a Wi-Fi drop during one check cached "AllDebrid: major
/// outage" for the full 60 s, so a "Check again" after the network came back
/// still painted the chip red while every other row was green. The 60 s
/// cache exists for TorBox's large payload, and a failed fetch pulled none.
const PROVIDER_FAIL_TTL: Duration = Duration::from_secs(5);
/// Body cap for a status page. TorBox's Better Stack payload is tens of KB
/// (90 days of history per resource); this leaves an order of magnitude of
/// room and still bounds a misbehaving server.
const STATUS_BODY_CAP: usize = 4 * 1024 * 1024;
/// Prefix read for a reachability ping: the success marker is at the head of
/// every one of these bodies, and Premiumize's full answer is a large
/// capability list we have no use for.
const PING_BODY_CAP: usize = 4 * 1024;
/// Health route body cap. Aura's is "ok", the relay's "aura-watch-relay ok";
/// a body that fills this was not read to its end (see `probe_health`).
const HEALTH_BODY_CAP: usize = 256;
/// Cap on each step (the lookup, each handshake attempt) of the separate
/// round-trip measure. A handshake slower than this is a SYN retransmit, not
/// a round trip, so its figure would be wrong anyway. Worst case is one lookup,
/// the stagger and one attempt, 3.3 s, still under the request's own 5 s
/// connect timeout, so it adds nothing beside a request that hangs. Beside one
/// that answered fast it can outlast the answer only through a slow lookup or
/// dropped SYNs on the path the request took.
const RTT_TIMEOUT: Duration = Duration::from_millis(1500);
/// Head start of the first resolved address over the other family: hyper's
/// happy-eyeballs default, so the measure reaches a working family about when
/// the request does.
const RTT_FAMILY_STAGGER: Duration = Duration::from_millis(300);
/// Caps on what goes back to the frontend per provider.
const MAX_ITEMS: usize = 6;
const MAX_TEXT: usize = 100;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ServiceStatusAction {
    Check {
        /// Probe Aura's own server.
        #[serde(default = "default_true")]
        aura: bool,
        /// The Watch Together relay URL as configured (`wss://...`), if any.
        #[serde(default)]
        relay: Option<String>,
        /// Installed addons' base URLs (or manifest URLs), in display order.
        #[serde(default)]
        addons: Vec<String>,
        /// Provider ids from the table below. Unknown ids are ignored.
        #[serde(default)]
        providers: Vec<String>,
    },
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
pub struct Probe {
    pub ok: bool,
    pub http_status: Option<u16>,
    /// The headline figure. What it measures is `latency_kind`.
    pub latency_ms: Option<u64>,
    /// "ping": a request on an already open connection to a route that does
    /// no work (one round trip plus turnaround). "response": time to response
    /// headers on a NEW connection, setup and server work included.
    pub latency_kind: Option<&'static str>,
    /// Time to response headers on a new connection (DNS, TCP and TLS setup
    /// included). Equal to `latency_ms` when the kind is "response".
    pub cold_ms: Option<u64>,
    /// One TCP handshake to the host, timed on its own: the network round
    /// trip. Absent when it could not be measured (a refusal, a timeout) or
    /// would time a path the request does not take (an env proxy applies).
    pub rtt_ms: Option<u64>,
    /// Short, URL-free reason when not ok.
    pub error: Option<String>,
    /// A loopback address refused the connection: a local server that is not
    /// running, which says nothing about whether anything is broken.
    pub not_running: bool,
    /// The probe went to this machine, so whatever it found, answering or
    /// not, says nothing about the network (the frontend's offline test).
    pub loopback: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderReport {
    pub id: String,
    /// operational | degraded | partial_outage | major_outage | maintenance | unknown
    pub state: &'static str,
    /// One line for the row, e.g. "Status page did not answer".
    pub summary: Option<String>,
    /// Components not operational, "API (degraded)".
    pub components: Vec<String>,
    /// Active incident / in-progress maintenance titles.
    pub incidents: Vec<String>,
    /// True when the only signal is an API ping, not a status page.
    pub reachability_only: bool,
    /// Unix ms the answer was fetched (older than now when from the cache).
    pub checked_at: u64,
}

#[derive(Debug, Serialize)]
#[serde(tag = "result", rename_all = "snake_case")]
pub enum ServiceStatusReply {
    Report {
        aura: Option<Probe>,
        relay: Option<Probe>,
        /// Index-aligned with the request's `addons` (truncated at the cap).
        /// A rejected URL gets a probe with `error` and no request made.
        addons: Vec<Probe>,
        providers: Vec<ProviderReport>,
        checked_at: u64,
    },
}

// ---------------------------------------------------------------------------
// Provider table
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
enum Parser {
    /// Better Stack JSON:API status page (`index.json`). The list names the
    /// resources (`public_name`, compared case-insensitively) whose downtime
    /// IS the outage for an Aura user: streams resolve through the provider's
    /// API, so "API down, website up" is a full outage, not a partial one.
    BetterStack(&'static [&'static str]),
    /// Atlassian Statuspage v2 (`summary.json`).
    Statuspage,
    /// API ping: 200 plus this marker (whitespace stripped) in the body head.
    Ping(&'static str),
}

struct ProviderDef {
    id: &'static str,
    endpoint: &'static str,
    parser: Parser,
}

/// The ONLY endpoints this module fetches for providers. The frontend names a
/// provider by id; it can never supply a URL.
const PROVIDERS: &[ProviderDef] = &[
    // Critical names read off the live pages (2026-11-01). TorBox lists 28
    // resources, 18 of them CDN regions; "API" and the "Database" behind it
    // are what every debrid resolve goes through. "Web Downloads API" serves
    // hoster links only, so its loss stays a partial outage like a CDN region.
    ProviderDef {
        id: "torbox",
        endpoint: "https://status.torbox.app/index.json",
        parser: Parser::BetterStack(&["API", "Database"]),
    },
    // `/index.json` 302s to `/en/index.json`; ask for the target directly.
    // Two resources only, "Website" and "API" (its 2026-10-21 "API is down"
    // report left the website up).
    ProviderDef {
        id: "real-debrid",
        endpoint: "https://status.real-debrid.com/en/index.json",
        parser: Parser::BetterStack(&["API"]),
    },
    ProviderDef { id: "putio", endpoint: "https://status.put.io/api/v2/summary.json", parser: Parser::Statuspage },
    ProviderDef { id: "alldebrid", endpoint: "https://api.alldebrid.com/v4/ping", parser: Parser::Ping("\"pong\"") },
    ProviderDef { id: "premiumize", endpoint: "https://www.premiumize.me/api/services/list", parser: Parser::Ping("\"status\":\"success\"") },
    ProviderDef { id: "debrid-link", endpoint: "https://debrid-link.com/api/v2/downloader/hosts", parser: Parser::Ping("\"success\":true") },
];

/// One entry per table row: (fetched at, lifetime, answer). The lifetime is
/// stored with the entry because a failed fetch lives shorter than an answer.
type ProviderCache = HashMap<&'static str, (Instant, Duration, ProviderReport)>;

static PROVIDER_CACHE: OnceLock<Mutex<ProviderCache>> = OnceLock::new();

fn provider_cache() -> &'static Mutex<ProviderCache> {
    PROVIDER_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

static STRICT_CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();
static ADDON_CLIENT: OnceLock<Option<reqwest::Client>> = OnceLock::new();

/// Aura server + provider status pages: https only, like every account /
/// service client in the crate.
fn strict_client() -> Option<&'static reqwest::Client> {
    STRICT_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .https_only(true)
                .timeout(STRICT_TIMEOUT)
                .connect_timeout(Duration::from_secs(6))
                .redirect(reqwest::redirect::Policy::limited(3))
                .pool_max_idle_per_host(1)
                .pool_idle_timeout(Duration::from_secs(30))
                .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " status"))
                .build()
                .ok()
        })
        .as_ref()
}

/// Addons and the relay. NOT https-only on purpose: a local or LAN addon
/// (`http://127.0.0.1:...`) and a `ws://` dev relay are legitimate installs,
/// and these are the same URLs Aura already fetches for catalogs and streams.
fn addon_client() -> Option<&'static reqwest::Client> {
    ADDON_CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(ADDON_TIMEOUT)
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::limited(3))
                .pool_max_idle_per_host(1)
                .pool_idle_timeout(Duration::from_secs(30))
                .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION"), " status"))
                .build()
                .ok()
        })
        .as_ref()
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn service_status(action: ServiceStatusAction) -> Result<ServiceStatusReply, String> {
    match action {
        ServiceStatusAction::Check { aura, relay, addons, providers } => {
            let aura_fut = async {
                if aura { Some(probe_aura().await) } else { None }
            };
            let relay_fut = async {
                match relay.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    Some(r) => Some(probe_relay(r).await),
                    None => None,
                }
            };
            let addons_fut = probe_addons(addons);
            let providers_fut = check_providers(providers);
            let (aura, relay, addons, providers) =
                tokio::join!(aura_fut, relay_fut, addons_fut, providers_fut);
            Ok(ServiceStatusReply::Report { aura, relay, addons, providers, checked_at: now_ms() })
        }
    }
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

fn failed(error: &str) -> Probe {
    Probe {
        ok: false,
        http_status: None,
        latency_ms: None,
        latency_kind: None,
        cold_ms: None,
        rtt_ms: None,
        error: Some(error.to_string()),
        not_running: false,
        loopback: false,
    }
}

/// A probe that got an HTTP answer. `latency` is the headline figure, `kind`
/// says what it measured.
fn answered(status: reqwest::StatusCode, ok: bool, latency: u64, kind: &'static str, cold: u64) -> Probe {
    Probe {
        ok,
        http_status: Some(status.as_u16()),
        latency_ms: Some(latency),
        latency_kind: Some(kind),
        cold_ms: Some(cold),
        rtt_ms: None,
        error: if ok { None } else { Some(format!("HTTP {}", status.as_u16())) },
        not_running: false,
        loopback: false,
    }
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

/// URL-free reason for the UI. The detailed form goes to the log only.
fn short_reason(e: &reqwest::Error) -> &'static str {
    if e.is_timeout() {
        "timed out"
    } else if e.is_connect() {
        "could not connect"
    } else if e.is_redirect() {
        "too many redirects"
    } else {
        "request failed"
    }
}

async fn probe_aura() -> Probe {
    let Some(client) = strict_client() else { return failed("client unavailable") };
    let Ok(url) = reqwest::Url::parse(AURA_HEALTH_URL) else { return failed("not a URL") };
    // Only the real server says "ok": a captive portal or a parked domain
    // answers 200 too.
    probe_health(client, url, Some("ok"), "aura server").await
}

/// Health-route probe for Aura's server and the relay. The first request opens
/// a connection and its time (`cold_ms`) carries DNS, TCP and TLS setup; the
/// SECOND, on the connection the first left open, is the ping. Timing only the
/// first is what made the old figure about four round trips long.
async fn probe_health(
    client: &reqwest::Client,
    url: reqwest::Url,
    expect_body: Option<&str>,
    label: &str,
) -> Probe {
    let start = Instant::now();
    let resp = match client.get(url.clone()).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(info, "status", "{} {}: {}",
                label, redact_sensitive_url(url.as_str()), reqwest_err_for_log(&e));
            return failed(short_reason(&e));
        }
    };
    let cold = elapsed_ms(start);
    let status = resp.status();
    // A server that closes after answering gives the second request a new
    // connection too, which would be timed and mislabelled as a ping.
    let closes = resp
        .headers()
        .get(reqwest::header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("close"));
    // Read the body to its END: hyper hands a connection back to the pool only
    // once its body is fully consumed. These bodies are a few bytes; one that
    // fills the cap was not drained, so it gets no warm request either.
    let body = read_capped(resp, HEALTH_BODY_CAP).await.ok();
    let drained = body.as_ref().is_some_and(|b| b.len() < HEALTH_BODY_CAP);
    let body_ok = match expect_body {
        Some(marker) => body.as_ref().is_some_and(|b| String::from_utf8_lossy(b).trim() == marker),
        None => true,
    };
    let ok = status.is_success() && body_ok;
    if !ok {
        crate::devlog!(info, "status", "{} {} answered HTTP {}",
            label, redact_sensitive_url(url.as_str()), status.as_u16());
        return answered(status, false, cold, "response", cold);
    }
    if closes || !drained {
        return answered(status, true, cold, "response", cold);
    }
    let warm_start = Instant::now();
    match client.get(url).send().await {
        Ok(r) if r.status().is_success() => {
            let warm = elapsed_ms(warm_start);
            // Drained too, so the connection is not torn down mid-body.
            let _ = read_capped(r, HEALTH_BODY_CAP).await;
            answered(status, true, warm, "ping", cold)
        }
        // The service answered once already: a failed second request makes
        // the figure less precise, not the service down.
        _ => answered(status, true, cold, "response", cold),
    }
}

/// `wss://host[:port]/anything` -> `https://host[:port]/health`. The Worker
/// answers `/` and `/health` alike; `/health` says what we mean.
fn relay_health_url(raw: &str) -> Option<reqwest::Url> {
    if raw.len() > MAX_URL_LEN {
        return None;
    }
    let u = reqwest::Url::parse(raw).ok()?;
    let scheme = match u.scheme() {
        "wss" | "https" => "https",
        "ws" | "http" => "http",
        _ => return None,
    };
    let host = u.host_str()?;
    if !u.username().is_empty() || u.password().is_some() {
        return None;
    }
    let base = match u.port() {
        Some(p) => format!("{scheme}://{host}:{p}/health"),
        None => format!("{scheme}://{host}/health"),
    };
    reqwest::Url::parse(&base).ok()
}

async fn probe_relay(raw: &str) -> Probe {
    let Some(url) = relay_health_url(raw) else { return failed("not a relay URL") };
    let Some(client) = addon_client() else { return failed("client unavailable") };
    let loopback = is_loopback(&url);
    Probe { loopback, ..probe_health(client, url, None, "relay").await }
}

async fn probe_addons(urls: Vec<String>) -> Vec<Probe> {
    let urls: Vec<String> = urls.into_iter().take(MAX_ADDONS).collect();
    let mut out: Vec<(usize, Probe)> = stream::iter(urls.into_iter().enumerate())
        .map(|(i, u)| async move { (i, probe_addon(&u).await) })
        // `buffer_unordered` over index-tagged probes, then a sort: the reply
        // stays index-aligned with the request (which is what lets it carry
        // no URLs back) without `buffered`'s head-of-line wait. `buffered`
        // counts a finished probe still queued behind an unfinished head as
        // holding its slot, so every addon that hung to ADDON_TIMEOUT froze
        // all new probes for its full 6 s: 40 addons with 4 such hosts took
        // ~25 s instead of ~9 s, and the whole reply (Aura server, relay,
        // providers) waited with it. The `map` builds each future lazily,
        // when a slot frees, and `probe_addon` starts its timers inside:
        // waiting for a slot is never timed.
        .buffer_unordered(ADDON_CONCURRENCY)
        .collect()
        .await;
    out.sort_unstable_by_key(|(i, _)| *i);
    out.into_iter().map(|(_, p)| p).collect()
}

/// Base URL -> manifest URL, the same shape stremio.rs fetches
/// (`format!("{base}/manifest.json")` after its `normalize_addon_url`). A URL
/// that already names the manifest is kept, so either form probes the same
/// resource.
fn addon_manifest_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.ends_with("/manifest.json") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/manifest.json")
    }
}

/// localhost, 127.0.0.0/8 and ::1. Only these get the `not_running` reading:
/// a refused LAN or internet address is a real outage.
fn is_loopback(url: &reqwest::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// True when an environment proxy would carry a request to `url`. The addon
/// client follows ALL_PROXY / HTTP(S)_PROXY (reqwest's env matcher; the
/// Windows registry proxy is not compiled in: `client-proxy-system` is off in
/// the dependency graph), while `tcp_rtt` always connects direct, so with one
/// set the handshake would time a path the request never takes. NO_PROXY is
/// deliberately not modelled: erring toward "proxied" only loses the figure.
fn env_proxy_applies(url: &reqwest::Url) -> bool {
    let set = |names: &[&str]| {
        names
            .iter()
            .any(|n| std::env::var_os(n).is_some_and(|v| !v.is_empty()))
    };
    let scheme_vars: &[&str] = if url.scheme() == "https" {
        &["HTTPS_PROXY", "https_proxy"]
    } else {
        &["HTTP_PROXY", "http_proxy"]
    };
    set(&["ALL_PROXY", "all_proxy"]) || set(scheme_vars)
}

/// One TCP handshake to the URL's host, timed on its own: the network round
/// trip, with no TLS and no server work in it. Resolved first and outside the
/// timer, so DNS is not counted either. None when it cannot be measured (a
/// refusal, a timeout). Never fails the probe.
///
/// The first resolved address and the first of the OTHER family race, staggered
/// (`first_success`): on a machine with blackholed IPv6 the AAAA record often
/// comes first, and the request itself falls back to IPv4 (hyper's happy
/// eyeballs). Trying that address alone measured nothing on every probe of a
/// healthy addon; trying them in turn held the probe's slot 1.5 s past the answer.
async fn tcp_rtt(url: &reqwest::Url) -> Option<u64> {
    let host = match url.host()? {
        url::Host::Domain(d) => d.to_string(),
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
    };
    let port = url.port_or_known_default()?;
    let addrs: Vec<std::net::SocketAddr> =
        tokio::time::timeout(RTT_TIMEOUT, tokio::net::lookup_host((host.as_str(), port)))
            .await
            .ok()?
            .ok()?
            .collect();
    let first = *addrs.first()?;
    let other = addrs.iter().copied().find(|a| a.is_ipv4() != first.is_ipv4());
    first_success(timed_connect(first), other.map(timed_connect), RTT_FAMILY_STAGGER).await
}

/// One handshake with its own timer, so the figure is that attempt's alone.
async fn timed_connect(addr: std::net::SocketAddr) -> Option<u64> {
    let start = Instant::now();
    let stream = tokio::time::timeout(RTT_TIMEOUT, tokio::net::TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;
    let ms = elapsed_ms(start);
    drop(stream);
    Some(ms)
}

/// `first` runs alone for `stagger`; `second` then starts beside it (at once if
/// `first` already failed). The first attempt to succeed answers and the other
/// is dropped, which cancels its connect.
async fn first_success<A, B>(first: A, second: Option<B>, stagger: Duration) -> Option<u64>
where
    A: Future<Output = Option<u64>>,
    B: Future<Output = Option<u64>>,
{
    let mut first = pin!(first);
    let Some(second) = second else { return first.await };
    match tokio::time::timeout(stagger, &mut first).await {
        Ok(Some(ms)) => return Some(ms),
        Ok(None) => return second.await,
        Err(_) => {}
    }
    let second = pin!(second);
    match select(first, second).await {
        Either::Left((Some(ms), _)) | Either::Right((Some(ms), _)) => Some(ms),
        Either::Left((None, rest)) => rest.await,
        Either::Right((None, rest)) => rest.await,
    }
}

/// True when the error chain holds a real connection refusal. `is_connect` is
/// not enough: every connector failure reads as one, a TLS handshake included.
fn is_connection_refused(e: &(dyn std::error::Error + 'static)) -> bool {
    let mut cur = Some(e);
    while let Some(err) = cur {
        if err
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused)
        {
            return true;
        }
        cur = err.source();
    }
    false
}

async fn probe_addon(raw: &str) -> Probe {
    let manifest = addon_manifest_url(raw);
    if manifest.len() > MAX_ADDON_URL_LEN {
        return failed("URL too long");
    }
    let Ok(url) = reqwest::Url::parse(&manifest) else { return failed("not a URL") };
    if url.scheme() != "http" && url.scheme() != "https" {
        return failed("not a web address");
    }
    let loopback = is_loopback(&url);
    let Some(client) = addon_client() else {
        return Probe { loopback, ..failed("client unavailable") };
    };
    // The round trip runs BESIDE the request, not in front of it: awaited
    // first, a host that drops SYNs paid the handshake's timeout and then the
    // request's connect timeout on top, holding a `buffered` slot the whole
    // time. The response figure therefore includes the lookup, which is what
    // a "response on a new connection" means (`cold_ms` says so too); Aura
    // fetches these hosts for every catalog and stream, so the OS resolver
    // cache usually answers it. A loopback address has no network to
    // measure, and under an env proxy the direct handshake is the wrong path.
    let measure_rtt = !loopback && !env_proxy_applies(&url);
    let rtt_fut = async {
        if measure_rtt { tcp_rtt(&url).await } else { None }
    };
    let req_fut = async {
        let start = Instant::now();
        let res = client.get(url.clone()).header("accept", "application/json").send().await;
        // Taken the moment the headers arrive, inside this future, so a
        // slower handshake beside it cannot stretch the figure.
        (res, elapsed_ms(start))
    };
    let (rtt, (res, latency)) = tokio::join!(rtt_fut, req_fut);
    match res {
        Ok(resp) => {
            // Headers are the answer: the manifest body itself can be large
            // (an aggregator's catalog list) and is never read. Dropping the
            // response closes that connection, which is fine at this cadence,
            // and is why this stays a cold "response" figure (module doc): a
            // warm second request would double the load on the addon.
            let status = resp.status();
            let ok = status.is_success();
            if !ok {
                crate::devlog!(info, "status", "addon {} answered HTTP {}",
                    redact_sensitive_url(raw), status.as_u16());
            }
            Probe { rtt_ms: rtt, loopback, ..answered(status, ok, latency, "response", latency) }
        }
        Err(e) => {
            crate::devlog!(info, "status", "addon {}: {}",
                redact_sensitive_url(raw), reqwest_err_for_log(&e));
            // Only a refusal: a loopback server that accepted and then hung,
            // or failed the TLS handshake, is running and broken, a real "down".
            if loopback && is_connection_refused(&e) {
                return Probe { not_running: true, loopback, ..failed("not running") };
            }
            Probe { loopback, ..failed(short_reason(&e)) }
        }
    }
}

async fn read_capped(mut resp: reqwest::Response, cap: usize) -> Result<Vec<u8>, reqwest::Error> {
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await? {
        let room = cap.saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if buf.len() >= cap {
            break;
        }
    }
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async fn check_providers(ids: Vec<String>) -> Vec<ProviderReport> {
    // Resolve against the table and de-duplicate, keeping the caller's order.
    let mut defs: Vec<&'static ProviderDef> = Vec::new();
    for id in ids.iter().take(PROVIDERS.len() * 2) {
        if let Some(def) = PROVIDERS.iter().find(|p| p.id == id.as_str()) {
            if !defs.iter().any(|d| d.id == def.id) {
                defs.push(def);
            }
        }
    }
    let futs = defs.into_iter().map(check_provider);
    futures_util::future::join_all(futs).await
}

/// How long a fetch result may be served from the cache.
fn provider_ttl(fetch_failed: bool) -> Duration {
    if fetch_failed { PROVIDER_FAIL_TTL } else { PROVIDER_TTL }
}

async fn check_provider(def: &'static ProviderDef) -> ProviderReport {
    if let Ok(cache) = provider_cache().lock() {
        if let Some((at, ttl, report)) = cache.get(def.id) {
            if at.elapsed() < *ttl {
                return report.clone();
            }
        }
    }
    let (report, fetch_failed) = fetch_provider(def).await;
    if let Ok(mut cache) = provider_cache().lock() {
        // One key per table row: bounded by PROVIDERS.len().
        cache.insert(def.id, (Instant::now(), provider_ttl(fetch_failed), report.clone()));
    }
    report
}

fn report(def: &ProviderDef, state: &'static str, summary: Option<String>) -> ProviderReport {
    ProviderReport {
        id: def.id.to_string(),
        state,
        summary,
        components: Vec::new(),
        incidents: Vec::new(),
        reachability_only: matches!(def.parser, Parser::Ping(_)),
        checked_at: now_ms(),
    }
}

/// The report, and whether the fetch itself FAILED (no usable answer: a
/// transport error, a non-success status, an unreadable body). A failure is
/// cached only briefly (`provider_ttl`), since it can be this machine's
/// network rather than the provider. A real answer that says "down" is not a
/// failure and keeps the full lifetime.
async fn fetch_provider(def: &'static ProviderDef) -> (ProviderReport, bool) {
    let Some(client) = strict_client() else {
        return (report(def, "unknown", Some("Client unavailable".into())), true);
    };
    let resp = match client.get(def.endpoint).header("accept", "application/json").send().await {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(info, "status", "provider {}: {}", def.id, reqwest_err_for_log(&e));
            let r = match def.parser {
                // A ping that does not answer IS the signal: the API is down
                // (or this machine is offline, which the frontend detects by
                // every other probe failing alongside it).
                Parser::Ping(_) => report(def, "major_outage", Some("API not answering".into())),
                // A status page that does not answer says nothing about the
                // service it describes.
                _ => report(def, "unknown", Some("Status page did not answer".into())),
            };
            return (r, true);
        }
    };
    let status = resp.status();
    if !status.is_success() {
        crate::devlog!(info, "status", "provider {} answered HTTP {}", def.id, status.as_u16());
        let r = match def.parser {
            Parser::Ping(_) if status.is_server_error() => {
                report(def, "major_outage", Some(format!("API answered HTTP {}", status.as_u16())))
            }
            _ => report(def, "unknown", Some(format!("HTTP {}", status.as_u16()))),
        };
        return (r, true);
    }
    match def.parser {
        Parser::Ping(marker) => match read_capped(resp, PING_BODY_CAP).await {
            Ok(body) => ping_report(def, marker, Some(&body)),
            Err(e) => {
                crate::devlog!(info, "status", "provider {} body: {}", def.id, reqwest_err_for_log(&e));
                ping_report(def, marker, None)
            }
        },
        Parser::BetterStack(_) | Parser::Statuspage => {
            let body = match read_capped(resp, STATUS_BODY_CAP).await {
                Ok(b) => b,
                Err(e) => {
                    crate::devlog!(info, "status", "provider {} body: {}", def.id, reqwest_err_for_log(&e));
                    return (report(def, "unknown", Some("Status page did not answer".into())), true);
                }
            };
            // TorBox serves its JSON as text/html, so the header is ignored.
            let Ok(v) = serde_json::from_slice::<Value>(&body) else {
                return (report(def, "unknown", Some("Status page unreadable".into())), true);
            };
            let mut r = report(def, "unknown", None);
            match def.parser {
                Parser::BetterStack(critical) => parse_better_stack(&v, now_ms(), critical, &mut r),
                _ => parse_statuspage(&v, &mut r),
            }
            (r, false)
        }
    }
}

/// A ping that answered 200, judged by its body. `None` = the body could not be
/// read: not an answer about the API (it can be this machine's network), so it
/// counts as a failed fetch and judges nothing.
fn ping_report(def: &ProviderDef, marker: &str, body: Option<&[u8]>) -> (ProviderReport, bool) {
    let Some(body) = body else {
        return (report(def, "unknown", Some("API answer was cut off".into())), true);
    };
    let compact: String = String::from_utf8_lossy(body).chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains(marker) {
        (report(def, "operational", Some("API answering".into())), false)
    } else {
        (report(def, "degraded", Some("API answered unexpectedly".into())), false)
    }
}

fn clip(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= MAX_TEXT {
        t.to_string()
    } else {
        let mut out: String = t.chars().take(MAX_TEXT - 3).collect();
        out.push_str("...");
        out
    }
}

/// Push with the item cap, folding the overflow into a trailing "+N more".
fn push_capped(list: &mut Vec<String>, items: Vec<String>) {
    let extra = items.len().saturating_sub(MAX_ITEMS);
    list.extend(items.into_iter().take(MAX_ITEMS));
    if extra > 0 {
        list.push(format!("+{extra} more"));
    }
}

/// Better Stack JSON:API. Page `aggregate_state` already folds in active
/// incidents, so it decides the state; resources and reports only explain it,
/// except that a `critical` resource in downtime makes a "downtime" page a
/// major outage whatever else is still up.
fn parse_better_stack(v: &Value, now: u64, critical: &[&str], out: &mut ProviderReport) {
    let empty = Vec::new();
    let included = v.get("included").and_then(Value::as_array).unwrap_or(&empty);
    let attr = |item: &Value, key: &str| -> Option<String> {
        item.get("attributes")?.get(key)?.as_str().map(str::to_string)
    };

    let mut any_operational = false;
    let mut critical_down = false;
    let mut bad_components = Vec::new();
    let mut incidents = Vec::new();
    for item in included {
        match item.get("type").and_then(Value::as_str) {
            Some("status_page_resource") => {
                let status = attr(item, "status").unwrap_or_default();
                match status.as_str() {
                    "operational" => any_operational = true,
                    "not_monitored" | "" => {}
                    other => {
                        let name = attr(item, "public_name").unwrap_or_else(|| "Component".into());
                        if other == "downtime"
                            && critical.iter().any(|c| c.eq_ignore_ascii_case(name.trim()))
                        {
                            critical_down = true;
                        }
                        let label = if other == "downtime" { "down" } else { other };
                        bad_components.push(clip(&format!("{name} ({label})")));
                    }
                }
            }
            Some("status_report") => {
                let state = attr(item, "aggregate_state").unwrap_or_default();
                if state == "resolved" || state.is_empty() {
                    continue;
                }
                // `ends_at` is null even on resolved manual reports, so it
                // only ever narrows a MAINTENANCE window, never marks one live.
                if attr(item, "report_type").as_deref() == Some("maintenance") {
                    let starts = attr(item, "starts_at").and_then(|s| parse_rfc3339_ms(&s));
                    let ends = attr(item, "ends_at").and_then(|s| parse_rfc3339_ms(&s));
                    if starts.is_some_and(|s| s > now) || ends.is_some_and(|e| e <= now) {
                        continue;
                    }
                }
                if let Some(title) = attr(item, "title") {
                    incidents.push(clip(&title));
                }
            }
            _ => {}
        }
    }

    let agg = v
        .get("data")
        .and_then(|d| d.get("attributes"))
        .and_then(|a| a.get("aggregate_state"))
        .and_then(Value::as_str)
        .unwrap_or("");
    out.state = match agg {
        "operational" => "operational",
        "degraded" => "degraded",
        // Better Stack has one "downtime" word for "one CDN region is down"
        // and "everything is down"; the resources tell the two apart. "Is
        // anything still up" alone cannot: Real-Debrid's website stays up
        // while its API is down, and that is a full outage for every addon
        // resolving through it, so a critical resource decides first.
        "downtime" => if critical_down || !any_operational { "major_outage" } else { "partial_outage" },
        "maintenance" => "maintenance",
        _ => "unknown",
    };
    if out.state == "unknown" {
        out.summary = Some("Status page unreadable".into());
    }
    push_capped(&mut out.components, bad_components);
    push_capped(&mut out.incidents, incidents);
}

/// Atlassian Statuspage v2 `summary.json`. `incidents[]` there holds only
/// unresolved incidents.
fn parse_statuspage(v: &Value, out: &mut ProviderReport) {
    let indicator = v
        .get("status")
        .and_then(|s| s.get("indicator"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let empty = Vec::new();

    let mut bad_components = Vec::new();
    for c in v.get("components").and_then(Value::as_array).unwrap_or(&empty) {
        if c.get("group").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let status = c.get("status").and_then(Value::as_str).unwrap_or("");
        if status.is_empty() || status == "operational" {
            continue;
        }
        let name = c.get("name").and_then(Value::as_str).unwrap_or("Component");
        bad_components.push(clip(&format!("{name} ({})", status.replace('_', " "))));
    }

    let mut incidents = Vec::new();
    for i in v.get("incidents").and_then(Value::as_array).unwrap_or(&empty) {
        if i.get("status").and_then(Value::as_str) == Some("resolved") {
            continue;
        }
        if let Some(name) = i.get("name").and_then(Value::as_str) {
            incidents.push(clip(name));
        }
    }
    let mut in_maintenance = false;
    for m in v.get("scheduled_maintenances").and_then(Value::as_array).unwrap_or(&empty) {
        let st = m.get("status").and_then(Value::as_str).unwrap_or("");
        if st == "in_progress" || st == "verifying" {
            in_maintenance = true;
            if let Some(name) = m.get("name").and_then(Value::as_str) {
                incidents.push(clip(&format!("Maintenance: {name}")));
            }
        }
    }

    out.state = match indicator {
        "none" if in_maintenance => "maintenance",
        "none" => "operational",
        "minor" => "degraded",
        "major" => "partial_outage",
        "critical" => "major_outage",
        "maintenance" => "maintenance",
        _ => "unknown",
    };
    if out.state == "unknown" {
        out.summary = Some("Status page unreadable".into());
    }
    push_capped(&mut out.components, bad_components);
    push_capped(&mut out.incidents, incidents);
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM|-HH:MM)` -> unix ms. Only what Better
/// Stack emits needs to parse; anything else returns None, which leaves a
/// maintenance report counted as live (the safe direction: shown, not hidden).
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut i = 19;
    let mut frac_ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let digits = &s[start..i];
        let first3: String = digits.chars().chain("000".chars()).take(3).collect();
        frac_ms = first3.parse().ok()?;
    }
    let offset_s: i64 = match b.get(i) {
        Some(b'Z') | Some(b'z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let oh = s.get(i + 1..i + 3)?.parse::<i64>().ok()?;
            let om = s.get(i + 4..i + 6)?.parse::<i64>().ok()?;
            let off = oh * 3600 + om * 60;
            if sign == b'+' { off } else { -off }
        }
        _ => return None,
    };
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec - offset_s;
    let ms = secs.checked_mul(1000)?.checked_add(frac_ms)?;
    u64::try_from(ms).ok()
}

/// Howard Hinnant's days-from-civil (proleptic Gregorian, 1970-01-01 = 0).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_parses_better_stack_shape() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2026-10-31T14:18:13.512Z"), Some(1_793_456_293_512));
        assert_eq!(parse_rfc3339_ms("2026-11-01T09:47:04.758+03:00"), Some(1_793_515_624_758));
        assert_eq!(parse_rfc3339_ms("not a date"), None);
    }

    #[test]
    fn relay_url_maps_to_health() {
        assert_eq!(
            relay_health_url("wss://aura-watch-relay.example.workers.dev").map(|u| u.to_string()),
            Some("https://aura-watch-relay.example.workers.dev/health".into())
        );
        assert_eq!(
            relay_health_url("ws://127.0.0.1:8787/room/ABCD").map(|u| u.to_string()),
            Some("http://127.0.0.1:8787/health".into())
        );
        assert!(relay_health_url("file:///C:/x").is_none());
    }

    #[test]
    fn addon_base_maps_to_manifest() {
        // The base form AddonEntry.url carries: the bare base answers 404 on
        // most addons, so the probe must ask for the manifest.
        assert_eq!(
            addon_manifest_url("https://torrentio.strem.fun/providers=yts"),
            "https://torrentio.strem.fun/providers=yts/manifest.json"
        );
        assert_eq!(
            addon_manifest_url("https://watchhub.strem.io/"),
            "https://watchhub.strem.io/manifest.json"
        );
        // Already a manifest URL: not doubled.
        assert_eq!(
            addon_manifest_url("http://127.0.0.1:11470/local-addon/manifest.json"),
            "http://127.0.0.1:11470/local-addon/manifest.json"
        );
    }

    #[test]
    fn loopback_hosts_only() {
        let lb = |s: &str| is_loopback(&reqwest::Url::parse(s).unwrap());
        assert!(lb("http://127.0.0.1:11470/local-addon/manifest.json"));
        assert!(lb("http://127.4.5.6/manifest.json"));
        assert!(lb("http://localhost:7000/manifest.json"));
        assert!(lb("http://[::1]:7000/manifest.json"));
        assert!(!lb("http://192.168.1.10:7000/manifest.json"));
        assert!(!lb("https://torrentio.strem.fun/manifest.json"));
    }

    #[test]
    fn better_stack_downtime_splits_partial_and_major() {
        let v: Value = serde_json::from_str(r#"{
            "data":{"attributes":{"aggregate_state":"downtime"}},
            "included":[
              {"type":"status_page_resource","attributes":{"public_name":"API","status":"operational"}},
              {"type":"status_page_resource","attributes":{"public_name":"WEUR CDN","status":"downtime"}},
              {"type":"status_report","attributes":{"title":"CDN outage","report_type":"manual","aggregate_state":"downtime","starts_at":"2026-10-31T14:18:13.512Z","ends_at":null}},
              {"type":"status_report","attributes":{"title":"Old","report_type":"manual","aggregate_state":"resolved"}}
            ]}"#).unwrap();
        let def = &PROVIDERS[0];
        let mut r = report(def, "unknown", None);
        parse_better_stack(&v, now_ms(), &["API", "Database"], &mut r);
        assert_eq!(r.state, "partial_outage");
        assert_eq!(r.components, vec!["WEUR CDN (down)".to_string()]);
        assert_eq!(r.incidents, vec!["CDN outage".to_string()]);
    }

    /// Real-Debrid's 2026-10-21 "API is down": only the API resource in
    /// downtime, the website still operational. Before the critical list this
    /// read as an amber partial outage.
    #[test]
    fn better_stack_critical_resource_down_is_major() {
        let v: Value = serde_json::from_str(r#"{
            "data":{"attributes":{"aggregate_state":"downtime"}},
            "included":[
              {"type":"status_page_resource","attributes":{"public_name":"Website","status":"operational"}},
              {"type":"status_page_resource","attributes":{"public_name":"API","status":"downtime"}},
              {"type":"status_report","attributes":{"title":"API is down","report_type":"automatic","aggregate_state":"downtime","starts_at":"2026-10-21T08:06:38Z","ends_at":null}}
            ]}"#).unwrap();
        let def = PROVIDERS.iter().find(|p| p.id == "real-debrid").unwrap();
        let Parser::BetterStack(critical) = def.parser else { panic!("real-debrid is Better Stack") };
        let mut r = report(def, "unknown", None);
        parse_better_stack(&v, now_ms(), critical, &mut r);
        assert_eq!(r.state, "major_outage");
        assert_eq!(r.components, vec!["API (down)".to_string()]);
        assert_eq!(r.incidents, vec!["API is down".to_string()]);

        // TorBox: the API down while the CDN regions stay up is major too.
        let tb = PROVIDERS.iter().find(|p| p.id == "torbox").unwrap();
        let Parser::BetterStack(tb_critical) = tb.parser else { panic!("torbox is Better Stack") };
        let v: Value = serde_json::from_str(r#"{
            "data":{"attributes":{"aggregate_state":"downtime"}},
            "included":[
              {"type":"status_page_resource","attributes":{"public_name":"API","status":"downtime"}},
              {"type":"status_page_resource","attributes":{"public_name":"WEUR CDN","status":"operational"}}
            ]}"#).unwrap();
        let mut r = report(tb, "unknown", None);
        parse_better_stack(&v, now_ms(), tb_critical, &mut r);
        assert_eq!(r.state, "major_outage");
    }

    #[test]
    fn failed_provider_fetch_is_cached_briefly() {
        assert_eq!(provider_ttl(false), PROVIDER_TTL);
        assert_eq!(provider_ttl(true), PROVIDER_FAIL_TTL);
        assert!(PROVIDER_FAIL_TTL < PROVIDER_TTL);
    }

    /// The reply must stay index-aligned with the request even though the
    /// probes now finish out of order. Rejected URLs answer without a request,
    /// so this needs no network.
    #[tokio::test]
    async fn addon_probes_stay_index_aligned() {
        let long = format!("https://example.com/{}", "a".repeat(MAX_ADDON_URL_LEN));
        let got = probe_addons(vec![
            long,
            "ftp://example.com".into(),
            "not a url".into(),
        ])
        .await;
        let errs: Vec<_> = got.iter().map(|p| p.error.clone().unwrap_or_default()).collect();
        assert_eq!(errs, vec!["URL too long", "not a web address", "not a URL"]);
    }

    fn alldebrid() -> &'static ProviderDef {
        PROVIDERS.iter().find(|p| p.id == "alldebrid").unwrap()
    }

    #[test]
    fn ping_body_read_failure_is_a_failed_fetch() {
        let (r, failed) = ping_report(alldebrid(), "\"pong\"", None);
        assert_eq!(r.state, "unknown");
        assert!(failed);
        assert_eq!(provider_ttl(failed), PROVIDER_FAIL_TTL);
    }

    #[test]
    fn ping_body_is_judged_by_its_marker() {
        let (r, failed) = ping_report(alldebrid(), "\"pong\"", Some(b"{ \"data\": \"pong\" }"));
        assert_eq!((r.state, failed), ("operational", false));
        let (r, failed) = ping_report(alldebrid(), "\"pong\"", Some(b"<html>portal</html>"));
        assert_eq!((r.state, failed), ("degraded", false));
    }

    /// A port with nothing listening: the listener is gone when this returns.
    fn closed_local_port() -> u16 {
        std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
    }

    /// Past the relay's 2048 too: a long config URL gets a real probe, not
    /// "URL too long". The refusal has to survive reqwest's error chain.
    #[tokio::test]
    async fn loopback_refusal_is_not_running() {
        let url = format!("http://127.0.0.1:{}/{}", closed_local_port(), "a".repeat(MAX_URL_LEN + 1));
        let p = probe_addon(&url).await;
        assert!(p.not_running, "{:?}", p.error);
        assert!(p.loopback);
    }

    /// An answering local addon says nothing about the network either: the
    /// offline test leaves it out, or it would hide a dropped connection.
    #[tokio::test]
    async fn answering_loopback_addon_is_marked_loopback() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                // Read the request first: closing over unread bytes is a reset.
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n").await;
            }
        });
        let p = probe_addon(&format!("http://127.0.0.1:{port}")).await;
        assert!(p.ok, "{:?}", p.error);
        assert!(p.loopback);
        assert!(!p.not_running);
    }

    #[tokio::test]
    async fn loopback_relay_is_marked_and_a_rejected_url_is_not() {
        let p = probe_relay(&format!("ws://127.0.0.1:{}", closed_local_port())).await;
        assert!(!p.ok);
        assert!(p.loopback);
        assert!(!probe_addon("not a url").await.loopback);
    }

    /// A server that fails the TLS handshake is running, so it is a real "down".
    #[tokio::test]
    async fn loopback_tls_failure_is_down_not_not_running() {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let _ = sock.write_all(b"HTTP/1.1 400 not tls\r\n\r\n").await;
            }
        });
        let p = probe_addon(&format!("https://127.0.0.1:{port}")).await;
        assert!(!p.ok);
        assert!(!p.not_running);
        assert!(p.loopback);
    }

    #[tokio::test]
    async fn rtt_race_answers_from_the_other_family_without_waiting_out_the_first() {
        let start = Instant::now();
        let got = first_success(
            async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                None
            },
            Some(async { Some(7) }),
            Duration::from_millis(20),
        )
        .await;
        assert_eq!(got, Some(7));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn rtt_race_starts_the_other_family_at_once_when_the_first_fails() {
        let start = Instant::now();
        let got = first_success(async { None }, Some(async { Some(7) }), Duration::from_secs(5)).await;
        assert_eq!(got, Some(7));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn rtt_race_never_starts_the_other_family_after_a_fast_first() {
        let started = std::sync::atomic::AtomicBool::new(false);
        let got = first_success(
            async { Some(3) },
            Some(async {
                started.store(true, std::sync::atomic::Ordering::SeqCst);
                Some(7)
            }),
            Duration::from_millis(200),
        )
        .await;
        assert_eq!(got, Some(3));
        assert!(!started.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[tokio::test]
    async fn rtt_race_waits_for_the_survivor_and_reports_total_failure() {
        let slow_first = async {
            tokio::time::sleep(Duration::from_millis(60)).await;
            Some(9)
        };
        let got = first_success(slow_first, Some(async { None }), Duration::from_millis(10)).await;
        assert_eq!(got, Some(9));
        let got = first_success(async { None }, Some(async { None }), Duration::from_millis(10)).await;
        assert_eq!(got, None);
        let got = first_success(async { None }, None::<std::future::Ready<Option<u64>>>, Duration::from_millis(10)).await;
        assert_eq!(got, None);
    }

    #[test]
    fn statuspage_maps_indicator() {
        let v: Value = serde_json::from_str(r#"{
            "status":{"indicator":"minor"},
            "components":[{"name":"Streaming","status":"degraded_performance"},{"name":"Files","status":"operational"}],
            "incidents":[{"name":"Slow streams","status":"investigating"}],
            "scheduled_maintenances":[]}"#).unwrap();
        let def = &PROVIDERS[2];
        let mut r = report(def, "unknown", None);
        parse_statuspage(&v, &mut r);
        assert_eq!(r.state, "degraded");
        assert_eq!(r.components, vec!["Streaming (degraded performance)".to_string()]);
        assert_eq!(r.incidents, vec!["Slow streams".to_string()]);
    }

    /// Live numbers, to set against curl's breakdown from the same machine
    /// (`curl -w "tcp=%{time_connect} tls=%{time_appconnect} ttfb=..."`).
    /// Network dependent, so ignored: `cargo test --lib service_status --
    /// --ignored --nocapture`.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn live_latency_breakdown() {
        for _ in 0..3 {
            let p = probe_aura().await;
            println!("aura: {:?} {:?} cold {:?}", p.latency_ms, p.latency_kind, p.cold_ms);
        }
        for _ in 0..3 {
            let p = probe_addon("https://torrentio.strem.fun").await;
            println!("torrentio: {:?} {:?} rtt {:?}", p.latency_ms, p.latency_kind, p.rtt_ms);
        }
    }
}
