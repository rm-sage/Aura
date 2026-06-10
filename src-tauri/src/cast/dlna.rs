// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! DLNA / UPnP-AV renderer support — SSDP M-SEARCH discovery plus the
//! SOAP/AVTransport verbs (SetAVTransportURI + DIDL-Lite, Play, Pause,
//! Stop, Seek, GetPositionInfo/GetTransportInfo). Pure reqwest +
//! hand-rolled XML (string scanning) — UPnP device descriptions are
//! shallow enough that a full XML parser dependency isn't warranted.

use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

use super::CastDeviceInfo;

const SSDP_ADDR: &str = "239.255.255.250:1900";
const SSDP_ST: &str = "urn:schemas-upnp-org:device:MediaRenderer:1";
/// Collection window after the M-SEARCH bursts.
const SSDP_COLLECT_SECS: u64 = 3;

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(6))
            .user_agent("Aura/1.0 UPnP/1.0")
            // Device descriptions + control URLs are plain-HTTP LAN
            // endpoints (TVs don't carry public certs) — the crate-wide
            // https_only posture doesn't apply to this client.
            .build()
            .expect("DLNA HTTP client init failed")
    })
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// SSDP M-SEARCH for MediaRenderer devices: 2 bursts, then collect
/// responses for SSDP_COLLECT_SECS, fetch each device description, and
/// keep only those exposing an AVTransport service.
pub async fn discover() -> Result<Vec<CastDeviceInfo>, String> {
    use tokio::net::UdpSocket;

    let sock = UdpSocket::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("ssdp bind: {e}"))?;
    let msearch = format!(
        "M-SEARCH * HTTP/1.1\r\nHOST: {SSDP_ADDR}\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {SSDP_ST}\r\n\r\n",
    );
    for _ in 0..2 {
        let _ = sock.send_to(msearch.as_bytes(), SSDP_ADDR).await;
        tokio::time::sleep(Duration::from_millis(120)).await;
    }

    // Collect unique LOCATION headers.
    let mut locations: HashSet<String> = HashSet::new();
    let mut buf = [0u8; 4096];
    let deadline = tokio::time::Instant::now() + Duration::from_secs(SSDP_COLLECT_SECS);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, _from))) => {
                let text = String::from_utf8_lossy(&buf[..n]);
                if let Some(loc) = header_value(&text, "location") {
                    locations.insert(loc);
                }
            }
            _ => break,
        }
    }

    // Fetch descriptions concurrently (bounded by the small set size).
    let mut tasks = Vec::new();
    for loc in locations {
        tasks.push(tokio::spawn(async move { describe_renderer(&loc).await }));
    }
    let mut out = Vec::new();
    for t in tasks {
        if let Ok(Some(dev)) = t.await.map_err(|e| e.to_string()) {
            out.push(dev);
        }
    }
    Ok(out)
}

fn header_value(response: &str, name: &str) -> Option<String> {
    for line in response.lines() {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(name) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Fetch + parse a device-description XML; None when it isn't a usable
/// MediaRenderer (no AVTransport control URL).
async fn describe_renderer(location: &str) -> Option<CastDeviceInfo> {
    let resp = http().get(location).send().await.ok()?;
    let base = resp.url().clone();
    let xml = resp.text().await.ok()?;

    let friendly = tag_text(&xml, "friendlyName").unwrap_or_else(|| "DLNA device".into());
    let model = tag_text(&xml, "modelName");

    // Find the AVTransport service block and its controlURL.
    let control_rel = find_avtransport_control_url(&xml)?;
    let control_url = absolutize(&base, &control_rel)?;

    let host = base.host_str()?.to_string();
    let port = base.port_or_known_default().unwrap_or(80);

    Some(CastDeviceInfo {
        id: format!("dlna:{host}"),
        name: friendly,
        host,
        port,
        model,
        kind: "dlna".into(),
        control_url: Some(control_url),
        audio_only: false,
    })
}

/// The AVTransport `<service>` block's `<controlURL>` value. Anchors on
/// the full serviceType URN (not the bare word "AVTransport", which can
/// legitimately appear in friendlyName / vendor serviceIds and would
/// make the scan grab a different service's controlURL).
fn find_avtransport_control_url(xml: &str) -> Option<String> {
    let mut search_from = 0usize;
    while let Some(rel_idx) =
        xml[search_from..].find("urn:schemas-upnp-org:service:AVTransport")
    {
        let idx = search_from + rel_idx;
        // controlURL appears inside the same <service> element — scan
        // forward to the closing </service> and look inside the slice
        // (UPnP puts serviceType first in the service block).
        let service_end = xml[idx..].find("</service>").map(|e| idx + e)?;
        if let Some(url) = tag_text(&xml[idx..service_end], "controlURL") {
            return Some(url);
        }
        search_from = service_end;
    }
    None
}

fn tag_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    let v = xml[start..end].trim();
    if v.is_empty() { None } else { Some(xml_unescape(v)) }
}

fn absolutize(base: &reqwest::Url, rel: &str) -> Option<String> {
    base.join(rel).ok().map(|u| u.to_string())
}

// ---------------------------------------------------------------------------
// SOAP / AVTransport control
// ---------------------------------------------------------------------------

async fn soap(
    control_url: &str,
    action: &str,
    body_args: &str,
) -> Result<String, String> {
    let envelope = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:{action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      {body_args}
    </u:{action}>
  </s:Body>
</s:Envelope>"#,
    );
    let resp = http()
        .post(control_url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header(
            "SOAPACTION",
            format!("\"urn:schemas-upnp-org:service:AVTransport:1#{action}\""),
        )
        .body(envelope)
        .send()
        .await
        .map_err(|e| format!("DLNA {action}: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("DLNA {action} failed: HTTP {status} {}", text.chars().take(300).collect::<String>()));
    }
    Ok(text)
}

/// SetAVTransportURI (with minimal DIDL-Lite metadata) followed by Play.
pub async fn load(
    control_url: &str,
    media_url: &str,
    content_type: &str,
    title: Option<&str>,
) -> Result<(), String> {
    let title_esc = xml_escape(title.unwrap_or("Aura"));
    let url_esc = xml_escape(media_url);
    // DLNA.ORG_OP=01 advertises byte-range seek support (the proxy
    // forwards Range), DLNA.ORG_CI=0 = not converted.
    let didl = format!(
        r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>{title_esc}</dc:title><upnp:class>object.item.videoItem.movie</upnp:class><res protocolInfo="http-get:*:{content_type}:DLNA.ORG_OP=01;DLNA.ORG_CI=0">{url_esc}</res></item></DIDL-Lite>"#,
    );
    let didl_esc = xml_escape(&didl);

    // Pre-stop quiets renderers (notably Sony) that reject a new URI
    // while a previous transport is mid-state. Best-effort.
    let _ = soap(control_url, "Stop", "").await;

    soap(
        control_url,
        "SetAVTransportURI",
        &format!(
            "<CurrentURI>{url_esc}</CurrentURI><CurrentURIMetaData>{didl_esc}</CurrentURIMetaData>",
        ),
    )
    .await?;
    play(control_url).await
}

pub async fn play(control_url: &str) -> Result<(), String> {
    soap(control_url, "Play", "<Speed>1</Speed>").await.map(|_| ())
}

pub async fn pause(control_url: &str) -> Result<(), String> {
    soap(control_url, "Pause", "").await.map(|_| ())
}

pub async fn stop(control_url: &str) -> Result<(), String> {
    soap(control_url, "Stop", "").await.map(|_| ())
}

pub async fn seek(control_url: &str, position_sec: f64) -> Result<(), String> {
    let target = hhmmss(position_sec);
    soap(
        control_url,
        "Seek",
        &format!("<Unit>REL_TIME</Unit><Target>{target}</Target>"),
    )
    .await
    .map(|_| ())
}

/// `(player_state, position_sec, duration_sec)` from GetTransportInfo +
/// GetPositionInfo.
pub async fn status(control_url: &str) -> Result<(String, f64, Option<f64>), String> {
    let transport = soap(control_url, "GetTransportInfo", "").await?;
    let state_raw = tag_text(&transport, "CurrentTransportState").unwrap_or_default();
    let state = match state_raw.as_str() {
        "PLAYING" => "playing",
        "PAUSED_PLAYBACK" | "PAUSED_RECORDING" => "paused",
        "TRANSITIONING" => "buffering",
        "STOPPED" | "NO_MEDIA_PRESENT" => "idle",
        _ => "unknown",
    }
    .to_string();

    let position = soap(control_url, "GetPositionInfo", "").await?;
    let pos = tag_text(&position, "RelTime")
        .and_then(|t| parse_hhmmss(&t))
        .unwrap_or(0.0);
    let dur = tag_text(&position, "TrackDuration").and_then(|t| parse_hhmmss(&t));
    Ok((state, pos, dur))
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn hhmmss(sec: f64) -> String {
    let s = sec.max(0.0) as u64;
    format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}

/// "1:23:45" / "01:23:45" / "0:00:00.000" → seconds. None for the
/// "NOT_IMPLEMENTED" placeholder some renderers return.
fn parse_hhmmss(t: &str) -> Option<f64> {
    let t = t.trim();
    if t.is_empty() || t.eq_ignore_ascii_case("not_implemented") {
        return None;
    }
    let mut parts = t.split(':').collect::<Vec<_>>();
    parts.reverse();
    let mut total = 0.0;
    let mut mult = 1.0;
    for p in parts.iter().take(3) {
        total += p.parse::<f64>().ok()? * mult;
        mult *= 60.0;
    }
    Some(total)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
