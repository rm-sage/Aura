// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Cast device discovery — mDNS `_googlecast._tcp` (Chromecast family)
//! + SSDP `MediaRenderer` (DLNA), fanned out concurrently and deduped
//! by host with Chromecast taking priority (a Chromecast-with-Google-TV
//! also answers SSDP; the CASTV2 protocol is strictly better when both
//! are available).

use std::collections::HashMap;
use std::time::Duration;

use super::CastDeviceInfo;

/// Whole-discovery wall-clock budget per protocol.
const MDNS_BROWSE_SECS: u64 = 3;

pub async fn discover_all() -> Result<Vec<CastDeviceInfo>, String> {
    let (chromecasts, dlna) = tokio::join!(
        tauri::async_runtime::spawn_blocking(discover_chromecasts_blocking),
        super::dlna::discover(),
    );
    let mut out: Vec<CastDeviceInfo> = Vec::new();
    match chromecasts {
        Ok(list) => out.extend(list),
        Err(e) => crate::devlog!(warn, "cast", "mdns browse task failed: {e}"),
    }
    match dlna {
        Ok(list) => out.extend(list),
        Err(e) => crate::devlog!(warn, "cast", "ssdp discovery failed: {e}"),
    }
    let deduped = dedupe_by_host(out);
    crate::devlog!(info, "cast", "discovery found {} device(s)", deduped.len());
    Ok(deduped)
}

/// Browse `_googlecast._tcp.local.` for MDNS_BROWSE_SECS and collect the
/// resolved services. Blocking (mdns-sd hands results over a flume
/// receiver) — run inside spawn_blocking.
fn discover_chromecasts_blocking() -> Vec<CastDeviceInfo> {
    use mdns_sd::{ServiceDaemon, ServiceEvent};

    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            crate::devlog!(warn, "cast", "mdns daemon init failed: {e}");
            return Vec::new();
        }
    };
    let receiver = match daemon.browse("_googlecast._tcp.local.") {
        Ok(r) => r,
        Err(e) => {
            crate::devlog!(warn, "cast", "mdns browse failed: {e}");
            let _ = daemon.shutdown();
            return Vec::new();
        }
    };

    let mut found: HashMap<String, CastDeviceInfo> = HashMap::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(MDNS_BROWSE_SECS);
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match receiver.recv_timeout(remaining) {
            Ok(ServiceEvent::ServiceResolved(info)) => {
                let host = info
                    .get_addresses()
                    .iter()
                    .find(|a| a.is_ipv4())
                    .map(|a| a.to_string());
                let Some(host) = host else { continue };
                // TXT records: `fn` = friendly name, `md` = model.
                let name = info
                    .get_property_val_str("fn")
                    .map(str::to_string)
                    .unwrap_or_else(|| info.get_fullname().split('.').next().unwrap_or("Chromecast").to_string());
                let model = info.get_property_val_str("md").map(str::to_string);
                let audio_only = model
                    .as_deref()
                    .map(|m| {
                        let ml = m.to_ascii_lowercase();
                        ml.contains("audio") || ml.contains("speaker") || ml.contains("nest mini")
                            || ml.contains("home mini") || ml.contains("nest audio")
                    })
                    .unwrap_or(false);
                found.insert(host.clone(), CastDeviceInfo {
                    id: format!("cc:{host}"),
                    name,
                    host,
                    port: info.get_port(),
                    model,
                    kind: "chromecast".into(),
                    control_url: None,
                    audio_only,
                });
            }
            Ok(_) => {}
            Err(_) => break, // timeout / channel closed
        }
    }
    let _ = daemon.stop_browse("_googlecast._tcp.local.");
    let _ = daemon.shutdown();
    found.into_values().collect()
}

/// Dedupe by host; on collision Chromecast wins over DLNA (a device
/// advertising both is better driven via CASTV2). Output sorted by name
/// for a stable picker.
fn dedupe_by_host(devices: Vec<CastDeviceInfo>) -> Vec<CastDeviceInfo> {
    fn priority(kind: &str) -> u8 {
        match kind {
            "chromecast" => 0,
            "dlna" => 1,
            _ => 9,
        }
    }
    let mut by_host: HashMap<String, CastDeviceInfo> = HashMap::new();
    for d in devices {
        match by_host.get(&d.host) {
            Some(existing) if priority(&existing.kind) <= priority(&d.kind) => {}
            _ => {
                by_host.insert(d.host.clone(), d);
            }
        }
    }
    let mut out: Vec<CastDeviceInfo> = by_host.into_values().collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}
