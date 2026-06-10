// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Minimal CASTV2 (Google Cast) client — exactly the protocol surface
//! Aura's casting needs, hand-rolled instead of pulling `rust_cast`
//! (which hard-depends on openssl-sys and breaks Windows source builds
//! without a system OpenSSL).
//!
//! The wire protocol is simple and stable:
//!   * TLS to port 8009 (devices present self-signed certs — the
//!     connector accepts invalid certs for this LAN hop only).
//!   * Frames are a 4-byte big-endian length + a `CastMessage` protobuf.
//!   * `CastMessage` has six fields Aura cares about — protocol_version
//!     (always 0 = CASTV2_1_0), source_id, destination_id, namespace,
//!     payload_type (always 0 = STRING), payload_utf8 — so the protobuf
//!     is encoded/decoded by hand (~100 lines) rather than via a
//!     protobuf codegen dependency.
//!   * Payloads are JSON, request/response correlated by `requestId`.
//!
//! Namespaces used: `tp.connection` (CONNECT), `tp.heartbeat`
//! (PING/PONG), `receiver` (LAUNCH/STOP/GET_STATUS), `media`
//! (LOAD/PLAY/PAUSE/SEEK/STOP/GET_STATUS).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};

const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";

const SENDER_ID: &str = "sender-aura";
const RECEIVER_0: &str = "receiver-0";

/// Per-call wait for a correlated response frame.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);

pub struct CastConnection {
    stream: native_tls::TlsStream<TcpStream>,
    next_request_id: i64,
}

/// One decoded inbound frame.
pub struct Frame {
    pub namespace: String,
    pub payload: Value,
}

impl CastConnection {
    /// TCP connect + TLS handshake (cert validation off — cast devices
    /// are self-signed) + virtual CONNECT to the platform receiver.
    pub fn connect(host: &str, port: u16) -> Result<Self, String> {
        use std::net::ToSocketAddrs;
        let addr = format!("{host}:{port}");
        let sock_addr = (host, port)
            .to_socket_addrs()
            .map_err(|e| format!("resolve {addr}: {e}"))?
            .next()
            .ok_or_else(|| format!("no address for {addr}"))?;
        let tcp = TcpStream::connect_timeout(&sock_addr, Duration::from_secs(6))
            .map_err(|e| format!("connect {addr}: {e}"))?;
        tcp.set_read_timeout(Some(RESPONSE_TIMEOUT))
            .map_err(|e| e.to_string())?;
        tcp.set_write_timeout(Some(Duration::from_secs(6)))
            .map_err(|e| e.to_string())?;

        let connector = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true)
            .build()
            .map_err(|e| format!("tls connector: {e}"))?;
        let stream = connector
            .connect(host, tcp)
            .map_err(|e| format!("tls handshake with {addr}: {e}"))?;

        let mut conn = CastConnection { stream, next_request_id: 1 };
        conn.send(NS_CONNECTION, RECEIVER_0, &json!({ "type": "CONNECT" }))?;
        Ok(conn)
    }

    /// Open the virtual connection to a transport (the launched app) so
    /// media-namespace messages to it are accepted.
    pub fn connect_transport(&mut self, transport_id: &str) -> Result<(), String> {
        self.send(NS_CONNECTION, transport_id, &json!({ "type": "CONNECT" }))
    }

    fn request_id(&mut self) -> i64 {
        let id = self.next_request_id;
        self.next_request_id += 1;
        id
    }

    pub fn send(
        &mut self,
        namespace: &str,
        destination: &str,
        payload: &Value,
    ) -> Result<(), String> {
        let msg = encode_cast_message(
            SENDER_ID,
            destination,
            namespace,
            &payload.to_string(),
        );
        let mut frame = Vec::with_capacity(4 + msg.len());
        frame.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        frame.extend_from_slice(&msg);
        self.stream
            .write_all(&frame)
            .map_err(|e| format!("cast send: {e}"))?;
        Ok(())
    }

    /// Read one frame. `Err` on socket timeout/close — callers decide
    /// whether a timeout is fatal (request wait) or routine (heartbeat
    /// loop idle tick).
    pub fn read_frame(&mut self) -> Result<Frame, String> {
        let mut len_buf = [0u8; 4];
        self.stream
            .read_exact(&mut len_buf)
            .map_err(|e| format!("cast read: {e}"))?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > 1024 * 1024 {
            return Err(format!("cast frame too large: {len}"));
        }
        let mut buf = vec![0u8; len];
        self.stream
            .read_exact(&mut buf)
            .map_err(|e| format!("cast read body: {e}"))?;
        decode_cast_message(&buf)
    }

    /// Answer a PING (keeps the device from dropping the sender).
    pub fn pong(&mut self) -> Result<(), String> {
        self.send(NS_HEARTBEAT, RECEIVER_0, &json!({ "type": "PONG" }))
    }

    pub fn ping(&mut self) -> Result<(), String> {
        self.send(NS_HEARTBEAT, RECEIVER_0, &json!({ "type": "PING" }))
    }

    /// Send `payload` on `namespace` and wait for a frame of
    /// `expect_type` carrying the same requestId (heartbeats answered
    /// inline; unrelated frames skipped). Returns the payload.
    fn request(
        &mut self,
        namespace: &str,
        destination: &str,
        mut payload: Value,
        expect_type: &str,
    ) -> Result<Value, String> {
        let id = self.request_id();
        payload["requestId"] = json!(id);
        self.send(namespace, destination, &payload)?;

        let deadline = std::time::Instant::now() + RESPONSE_TIMEOUT;
        loop {
            if std::time::Instant::now() > deadline {
                return Err(format!("timed out waiting for {expect_type}"));
            }
            let frame = match self.read_frame() {
                Ok(f) => f,
                Err(e) => return Err(e),
            };
            if frame.namespace == NS_HEARTBEAT {
                if frame.payload["type"] == "PING" {
                    let _ = self.pong();
                }
                continue;
            }
            let ty = frame.payload["type"].as_str().unwrap_or("");
            // Device-side errors share the requestId.
            if frame.payload["requestId"].as_i64() == Some(id) {
                if ty == expect_type {
                    return Ok(frame.payload);
                }
                if ty == "LOAD_FAILED" || ty == "INVALID_REQUEST" || ty == "LAUNCH_ERROR" {
                    return Err(format!(
                        "device rejected the request: {} ({})",
                        ty,
                        frame.payload["reason"].as_str().unwrap_or("unknown"),
                    ));
                }
            }
            // Unsolicited broadcast of the right type also satisfies the
            // wait (some receivers answer GET_STATUS with requestId 0).
            if ty == expect_type {
                return Ok(frame.payload);
            }
        }
    }

    // ── Receiver namespace ────────────────────────────────────────────

    /// LAUNCH an app and return `(transport_id, session_id)` once the
    /// RECEIVER_STATUS shows it running.
    pub fn launch(&mut self, app_id: &str) -> Result<(String, String), String> {
        let status = self.request(
            NS_RECEIVER,
            RECEIVER_0,
            json!({ "type": "LAUNCH", "appId": app_id }),
            "RECEIVER_STATUS",
        )?;
        extract_app(&status, app_id).ok_or_else(|| {
            "receiver did not report the launched app".to_string()
        })
    }

    pub fn stop_app(&mut self, session_id: &str) -> Result<(), String> {
        let _ = self.request(
            NS_RECEIVER,
            RECEIVER_0,
            json!({ "type": "STOP", "sessionId": session_id }),
            "RECEIVER_STATUS",
        )?;
        Ok(())
    }

    // ── Media namespace ───────────────────────────────────────────────

    /// LOAD media on the app's transport. `start_seconds` maps to the
    /// LOAD message's native `currentTime`. Returns the mediaSessionId.
    #[allow(clippy::too_many_arguments)]
    pub fn media_load(
        &mut self,
        transport_id: &str,
        url: &str,
        content_type: &str,
        title: Option<&str>,
        poster: Option<&str>,
        start_seconds: f64,
    ) -> Result<Option<i64>, String> {
        let mut media = json!({
            "contentId": url,
            "contentType": content_type,
            "streamType": "BUFFERED",
        });
        if title.is_some() || poster.is_some() {
            let mut meta = json!({ "metadataType": 0 });
            if let Some(t) = title {
                meta["title"] = json!(t);
            }
            if let Some(p) = poster {
                meta["images"] = json!([{ "url": p }]);
            }
            media["metadata"] = meta;
        }
        let status = self.request(
            NS_MEDIA,
            transport_id,
            json!({
                "type": "LOAD",
                "media": media,
                "autoplay": true,
                "currentTime": start_seconds.max(0.0),
            }),
            "MEDIA_STATUS",
        )?;
        Ok(first_media_session(&status))
    }

    /// PLAY / PAUSE / STOP / SEEK on a media session.
    pub fn media_command(
        &mut self,
        transport_id: &str,
        media_session_id: i64,
        verb: &str,
        seek_to: Option<f64>,
    ) -> Result<(), String> {
        let mut payload = json!({
            "type": verb,
            "mediaSessionId": media_session_id,
        });
        if let Some(t) = seek_to {
            payload["currentTime"] = json!(t.max(0.0));
        }
        let _ = self.request(NS_MEDIA, transport_id, payload, "MEDIA_STATUS")?;
        Ok(())
    }

    /// `(player_state, position_sec, duration_sec, media_session_id)`.
    pub fn media_status(
        &mut self,
        transport_id: &str,
    ) -> Result<(String, f64, Option<f64>, Option<i64>), String> {
        let status = self.request(
            NS_MEDIA,
            transport_id,
            json!({ "type": "GET_STATUS" }),
            "MEDIA_STATUS",
        )?;
        let entry = status["status"]
            .as_array()
            .and_then(|a| a.first())
            .cloned()
            .unwrap_or(Value::Null);
        let state = match entry["playerState"].as_str().unwrap_or("") {
            "PLAYING" => "playing",
            "PAUSED" => "paused",
            "BUFFERING" | "LOADING" => "buffering",
            "IDLE" => "idle",
            _ => "unknown",
        }
        .to_string();
        let pos = entry["currentTime"].as_f64().unwrap_or(0.0);
        let dur = entry["media"]["duration"].as_f64();
        let ms = entry["mediaSessionId"].as_i64();
        Ok((state, pos, dur, ms))
    }
}

fn extract_app(receiver_status: &Value, app_id: &str) -> Option<(String, String)> {
    let apps = receiver_status["status"]["applications"].as_array()?;
    let app = apps
        .iter()
        .find(|a| a["appId"].as_str() == Some(app_id))
        .or_else(|| apps.first())?;
    Some((
        app["transportId"].as_str()?.to_string(),
        app["sessionId"].as_str()?.to_string(),
    ))
}

fn first_media_session(media_status: &Value) -> Option<i64> {
    media_status["status"]
        .as_array()?
        .first()?
        .get("mediaSessionId")?
        .as_i64()
}

// ---------------------------------------------------------------------------
// CastMessage protobuf (hand-rolled)
//
// message CastMessage {
//   required ProtocolVersion protocol_version = 1;  // enum, 0
//   required string source_id = 2;
//   required string destination_id = 3;
//   required string namespace = 4;
//   required PayloadType payload_type = 5;          // enum, 0 = STRING
//   optional string payload_utf8 = 6;
//   optional bytes payload_binary = 7;              // unused by Aura
// }
// ---------------------------------------------------------------------------

fn put_varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let byte = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(byte);
            break;
        }
        out.push(byte | 0x80);
    }
}

fn put_tag(out: &mut Vec<u8>, field: u32, wire_type: u8) {
    put_varint(out, ((field as u64) << 3) | wire_type as u64);
}

fn put_string(out: &mut Vec<u8>, field: u32, s: &str) {
    put_tag(out, field, 2);
    put_varint(out, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

fn put_enum(out: &mut Vec<u8>, field: u32, value: u64) {
    put_tag(out, field, 0);
    put_varint(out, value);
}

fn encode_cast_message(
    source: &str,
    destination: &str,
    namespace: &str,
    payload_utf8: &str,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(64 + payload_utf8.len());
    put_enum(&mut out, 1, 0); // protocol_version = CASTV2_1_0
    put_string(&mut out, 2, source);
    put_string(&mut out, 3, destination);
    put_string(&mut out, 4, namespace);
    put_enum(&mut out, 5, 0); // payload_type = STRING
    put_string(&mut out, 6, payload_utf8);
    out
}

fn read_varint(buf: &[u8], pos: &mut usize) -> Option<u64> {
    let mut value: u64 = 0;
    let mut shift = 0u32;
    loop {
        let byte = *buf.get(*pos)?;
        *pos += 1;
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
}

fn decode_cast_message(buf: &[u8]) -> Result<Frame, String> {
    let mut pos = 0usize;
    let mut namespace = String::new();
    let mut payload = String::new();

    while pos < buf.len() {
        let tag = read_varint(buf, &mut pos).ok_or("bad protobuf tag")?;
        let field = (tag >> 3) as u32;
        // CastMessage has 7 fields; anything implausibly large means a
        // truncated/corrupt frame masquerading as valid protobuf.
        if field == 0 || field > 127 {
            return Err(format!("implausible protobuf field number {field}"));
        }
        let wire = (tag & 0x7) as u8;
        match wire {
            0 => {
                let _ = read_varint(buf, &mut pos).ok_or("bad varint")?;
            }
            2 => {
                let len = read_varint(buf, &mut pos).ok_or("bad length")? as usize;
                let end = pos.checked_add(len).filter(|e| *e <= buf.len())
                    .ok_or("length out of bounds")?;
                let bytes = &buf[pos..end];
                pos = end;
                match field {
                    4 => namespace = String::from_utf8_lossy(bytes).into_owned(),
                    6 => payload = String::from_utf8_lossy(bytes).into_owned(),
                    _ => {}
                }
            }
            5 => pos += 4, // fixed32 (unused)
            1 => pos += 8, // fixed64 (unused)
            other => return Err(format!("unsupported protobuf wire type {other}")),
        }
    }

    let payload_json: Value =
        serde_json::from_str(&payload).unwrap_or(Value::Null);
    Ok(Frame { namespace, payload: payload_json })
}
