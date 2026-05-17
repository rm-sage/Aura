// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadAuraSettings } from "./auraSettings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OsdStats {
  frame_drops: number;
  video_width: number;
  video_height: number;
  display_fps: number;
  container_fps: number;
  estimated_vf_fps: number;
  shader_profile: string;
  /** "v=H264 hw a=AAC" style summary (codecs from container headers). */
  video_codec: string;
  audio_codec: string;
  /** Color / HDR primaries (e.g. "bt2020-ncl/PQ" / "bt709"). */
  video_format: string;
  /** Hardware decoder name when active ("d3d11va", "dxva2", etc.) — empty
   *  string when software decoding. */
  hwdec: string;
  /** Bitrate in bits per second (mpv reports as bytes/sec*8 = bits/sec). */
  video_bitrate: number;
  audio_bitrate: number;
  /** A/V sync delta in seconds (negative = audio leading video). */
  avsync: number;
  /** Cache: forward seconds + bytes used; total seconds the demuxer has
   *  buffered. Streaming-relevant. */
  cache_secs: number;
  cache_demuxer_secs: number;
  cache_used_bytes: number;
  /** Demuxer fill, expressed as a 0..100 % of the configured ceiling
   *  (`cache-secs` is 180 — so 60 s buffered = 33 %). Derived from
   *  cache_secs to give the user a single glanceable indicator of how
   *  much headroom they have before the next rebuffer. */
  buffer_fill_pct: number;
  /** True while paused-for-cache (i.e. underflow/initial buffer). */
  paused_for_cache: boolean;
  /** Network speed (bytes/sec) reported by demuxer over the last window. */
  network_bps: number;
  /** Audio output device name string. */
  audio_device: string;
  /** Active audio + subtitle track ids and language tags. */
  audio_track: string;
  sub_track: string;
  /** Composite signal label: "SDR", "HDR10", "HLG", "Dolby Vision · P5".
   *  Empty when no video params are available yet (pre-loadfile). */
  signal_kind: string;
  /** Active tone-mapping mode currently driving render output ("clip",
   *  "auto", "mobius", "hable", …). Read from the live `tone-mapping`
   *  property so the user sees the effective value (which differs from
   *  the persisted Settings → HDR mode the moment Settings flips it
   *  before MPV finishes the change-list). */
  tone_mapping: string;
  /** Source pixel format ("yuv420p10", "yuv420p", "p010", …).
   *  Useful diagnostic — tells the user whether the source is 8-bit or
   *  10-bit, which affects what HDR signalling means in practice. */
  pixel_format: string;
}

// ---------------------------------------------------------------------------
// Performance OSD — toggled globally by the backtick (`) key
// ---------------------------------------------------------------------------

function fmtBitrate(bps: number): string {
  if (!bps || bps <= 0) return "n/a";
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  if (bps >= 1_000)     return `${(bps / 1_000).toFixed(0)} Kbps`;
  return `${bps.toFixed(0)} bps`;
}

function fmtBytes(n: number): string {
  if (!n || n <= 0) return "n/a";
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024)        return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024)               return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtSecs(n: number): string {
  if (!n || n <= 0) return "n/a";
  if (n >= 60) return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;
  return `${n.toFixed(1)} s`;
}

/** Single row in the OSD. Muted label + value column. */
function StatRow({ label, value, valueClass }: {
  label: string; value: React.ReactNode; valueClass?: string;
}) {
  return (
    <div className="flex justify-between gap-8">
      <span className="text-white/40">{label}</span>
      <span className={valueClass ?? ""}>{value}</span>
    </div>
  );
}

/** Section header — small mono caps to break the OSD into logical
 *  groups (Video / Audio / Network / Decode). */
function StatSection({ label }: { label: string }) {
  return (
    <div className="text-white/30 text-[9.5px] font-mono uppercase tracking-[0.18em] pt-1.5 pb-0.5
                    border-t border-white/8 first:border-0 first:pt-0">
      {label}
    </div>
  );
}

function OsdOverlay({ stats, topPx }: { stats: OsdStats; topPx: number }) {
  const fpsValue = stats.display_fps > 0
    ? stats.display_fps.toFixed(2)
    : (stats.estimated_vf_fps > 0 ? stats.estimated_vf_fps.toFixed(2) : "n/a");
  const containerFps = stats.container_fps > 0 ? stats.container_fps.toFixed(2) : null;
  return (
    <div
      className="fixed right-4 z-50 pointer-events-none
                 bg-black/70 backdrop-blur-md rounded-xl px-4 py-3
                 border border-white/10 font-mono text-[11px] text-white/75
                 space-y-1 min-w-[260px] max-w-[320px]"
      style={{ top: topPx }}
    >
      <StatSection label="Render" />
      <StatRow label="Shader profile" value={stats.shader_profile} valueClass="text-ln-accent" />
      <StatRow
        label="Decoder"
        value={stats.hwdec ? `${stats.hwdec} (HW)` : "software"}
        valueClass={stats.hwdec ? "text-emerald-300" : "text-amber-300"}
      />
      <StatRow
        label="Frame drops"
        value={stats.frame_drops}
        valueClass={stats.frame_drops > 0 ? "text-red-400" : "text-emerald-400"}
      />

      <StatSection label="Video" />
      <StatRow
        label="Resolution"
        value={stats.video_width > 0 ? `${stats.video_width}×${stats.video_height}` : "n/a"}
      />
      <StatRow label="Codec" value={stats.video_codec || "n/a"} />
      <StatRow label="Format" value={stats.video_format || "n/a"} />
      <StatRow
        label="FPS (display)"
        value={containerFps && containerFps !== fpsValue
          ? `${fpsValue} → ${containerFps}`
          : fpsValue}
      />
      {/* SVP Tier 1 status. Read fresh from auraSettings each OSD
          re-render (≤2 s poll), so toggling from the player menu
          reflects here without extra wiring. When on, the
          estimated-vf-fps readout (already polled, safe `double`
          format) shows the effective interpolated output rate. */}
      {(() => {
        const interpOn = !!loadAuraSettings().motionInterpolation;
        return (
          <StatRow
            label="Interpolation"
            value={interpOn
              ? (stats.estimated_vf_fps > 0
                  ? `On · ~${stats.estimated_vf_fps.toFixed(0)} fps`
                  : "On")
              : "Off"}
            valueClass={interpOn ? "text-ln-accent" : "text-white/45"}
          />
        );
      })()}
      <StatRow label="Bitrate" value={fmtBitrate(stats.video_bitrate)} />

      <StatSection label="Audio" />
      <StatRow label="Track" value={stats.audio_track || "n/a"} />
      <StatRow label="Codec" value={stats.audio_codec || "n/a"} />
      <StatRow label="Bitrate" value={fmtBitrate(stats.audio_bitrate)} />
      <StatRow label="Device" value={stats.audio_device || "n/a"} />
      {stats.sub_track && (
        <StatRow label="Subtitle" value={stats.sub_track} />
      )}

      <StatSection label="Sync" />
      <StatRow
        label="A/V delta"
        value={`${stats.avsync >= 0 ? "+" : ""}${stats.avsync.toFixed(3)} s`}
        valueClass={Math.abs(stats.avsync) > 0.05 ? "text-amber-300" : ""}
      />

      <StatSection label="Network" />
      <StatRow label="Speed" value={fmtBitrate(stats.network_bps * 8)} />
      <StatRow label="Cache (fwd)" value={fmtSecs(stats.cache_secs)} />
      <StatRow label="Demuxer" value={fmtSecs(stats.cache_demuxer_secs)} />
      <StatRow label="Cache size" value={fmtBytes(stats.cache_used_bytes)} />
      {/* Buffer fill % — derived from demuxer-cache-duration vs the
          180 s ceiling. Always shown so the user has a quick "how much
          headroom is there before rebuffer?" signal. Colours: red
          when paused-for-cache (active stall), amber when below 20 %
          (close to underrun), emerald otherwise. */}
      <StatRow
        label="Buffer fill"
        value={`${stats.buffer_fill_pct.toFixed(0)} %`}
        valueClass={
          stats.paused_for_cache
            ? "text-red-400"
            : stats.buffer_fill_pct < 20
              ? "text-amber-300"
              : "text-emerald-400"
        }
      />
      {stats.paused_for_cache && (
        <StatRow label="State" value="BUFFERING" valueClass="text-amber-300" />
      )}

      {/* HDR / Dolby Vision section — surfaced ONLY when MPV has
          resolved video params (signal_kind is empty during loadfile).
          Combines source signal kind with the active tone-mapping
          mode so the user can see at a glance what the pipeline is
          actually doing: e.g. "HDR10 → mobius" means HDR10 source
          being tone-mapped to SDR; "HDR10 → auto" with passthrough
          means MPV is sending the signal straight to an HDR display. */}
      {stats.signal_kind && (
        <>
          <StatSection label="HDR / Dolby Vision" />
          <StatRow
            label="Signal"
            value={stats.signal_kind}
            valueClass={
              stats.signal_kind.startsWith("Dolby")
                ? "text-violet-300"
                : stats.signal_kind === "HDR10" || stats.signal_kind === "HLG" || stats.signal_kind.startsWith("HDR")
                  ? "text-amber-200"
                  : "text-white/65"
            }
          />
          {stats.tone_mapping && (
            <StatRow label="Tone-map" value={stats.tone_mapping} />
          )}
          {stats.pixel_format && (
            <StatRow label="Pixel fmt" value={stats.pixel_format} />
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CinemaSuite — mounts once, lives for the app lifetime.
//
// OSD stats are polled via get_property (only while the OSD panel is open)
// rather than observed. Observed properties on this libmpv build can silently
// kill the ENTIRE event channel if any format is unsupported — polling is the
// safe fallback.
// ---------------------------------------------------------------------------

export default function CinemaSuite({ isFullscreen = false }: { isFullscreen?: boolean }) {
  const [osdVisible, setOsdVisible] = useState(false);
  const [osdStats, setOsdStats] = useState<OsdStats>({
    frame_drops: 0,
    video_width: 0,
    video_height: 0,
    display_fps: 0,
    container_fps: 0,
    estimated_vf_fps: 0,
    shader_profile: "None",
    video_codec: "",
    audio_codec: "",
    video_format: "",
    hwdec: "",
    video_bitrate: 0,
    audio_bitrate: 0,
    avsync: 0,
    cache_secs: 0,
    cache_demuxer_secs: 0,
    cache_used_bytes: 0,
    buffer_fill_pct: 0,
    paused_for_cache: false,
    network_bps: 0,
    audio_device: "",
    audio_track: "",
    sub_track: "",
    signal_kind: "",
    tone_mapping: "",
    pixel_format: "",
  });

  const pollOsd = useCallback(async () => {
    try {
      // Parallel-fetch every property the OSD wants. Each call is a
      // single Tauri invoke against `get_property`; misses default
      // safely. Runs every 2 s while the OSD is open, never otherwise.
      const num = (name: string, format: "int64" | "double") =>
        invoke<number>("get_property", { name, format }).catch(() => 0);
      const str = (name: string) =>
        invoke<string | null>("get_property", { name, format: "string" })
          .then((v) => (typeof v === "string" ? v : ""))
          .catch(() => "");
      const flag = (name: string) =>
        invoke<boolean | null>("get_property", { name, format: "flag" })
          .then((v) => v === true)
          .catch(() => false);

      const [
        drops, dw, dh, fps, containerFps, estVfFps, shader,
        videoCodec, audioCodec, videoFormat, hwdecCurrent,
        videoBitrate, audioBitrate, avsync,
        cacheSecs, demuxerSecs, cacheUsedBytes, pausedForCache, networkSpeed,
        audioDevice, audioId, audioLang, subId, subLang,
        videoGamma, videoPrimaries, dvProfile, toneMapping, pixelFmt,
      ] = await Promise.all([
        num("frame-drop-count",          "int64"),
        num("dwidth",                    "int64"),
        num("dheight",                   "int64"),
        num("display-fps",               "double"),
        num("container-fps",             "double"),
        num("estimated-vf-fps",          "double"),
        invoke<number | string>("get_shader_profile").catch(() => "None"),
        str("video-codec"),
        str("audio-codec"),
        str("video-format"),
        str("hwdec-current"),
        num("video-bitrate",             "double"),
        num("audio-bitrate",             "double"),
        num("avsync",                    "double"),
        num("cache-secs",                "double"),
        num("demuxer-cache-duration",    "double"),
        num("demuxer-cache-state/total-bytes", "int64"),
        flag("paused-for-cache"),
        num("demuxer-cache-state/raw-input-rate", "double"),
        str("audio-device"),
        str("aid"),
        str("audio-params/lang"),
        str("sid"),
        str("sub-params/lang"),
        // HDR / Dolby Vision signal probes. All read via STRING format
        // (the only one CLAUDE.md landmine #4 considers safe on this
        // libmpv build). `video-params/gamma` returns "bt.1886" for
        // SDR sources, "pq" for HDR10 (PQ), "hlg" for HLG, etc.
        // `video-params/primaries` reports "bt.709" / "bt.2020" /
        // "dci-p3". `video-params/dolby-vision-profile` exists only
        // when the active stream carries a DV layer; it returns the
        // numeric profile id ("5", "7", "8") as a string.
        str("video-params/gamma"),
        str("video-params/primaries"),
        str("video-params/dolby-vision-profile"),
        str("tone-mapping"),
        str("video-params/pixelformat"),
      ]);

      const audioTrackLabel = audioId
        ? (audioLang ? `${audioId} · ${audioLang}` : `${audioId}`)
        : "";
      const subTrackLabel = subId && subId !== "no"
        ? (subLang ? `${subId} · ${subLang}` : `${subId}`)
        : "";

      // Composite signal classifier. Dolby Vision wins precedence —
      // any DV layer is reported as DV regardless of base gamma.
      // Otherwise the gamma curve is the source of truth: PQ → HDR10,
      // HLG → HLG, anything else → SDR (or empty if mpv hasn't
      // resolved video params yet, e.g. during loadfile).
      const gamma = (videoGamma || "").toLowerCase();
      const prims = (videoPrimaries || "").toLowerCase();
      const dv = (dvProfile || "").toString().trim();
      let signalKind = "";
      if (dv) {
        signalKind = `Dolby Vision · P${dv}`;
      } else if (gamma === "pq" || gamma === "smpte2084") {
        // BT.2020 + PQ is canonical HDR10. Without the BT.2020
        // primaries we still call it HDR10 (some encodes mislabel
        // primaries) — peak detection will figure it out.
        signalKind = prims.startsWith("bt.2020") ? "HDR10" : "HDR (PQ)";
      } else if (gamma === "hlg" || gamma === "arib-std-b67") {
        signalKind = "HLG";
      } else if (gamma) {
        signalKind = "SDR";
      }

      // Buffer fill % — the demuxer-cache-duration vs the configured
      // 180 s ceiling from player.rs. Clamped 0..100 so a momentarily
      // over-filled queue (mpv occasionally over-shoots) doesn't
      // render "112 %".
      const CACHE_CEILING_SECS = 180;
      const fillRaw = (demuxerSecs as number) / CACHE_CEILING_SECS * 100;
      const buffer_fill_pct = Math.max(0, Math.min(100, isFinite(fillRaw) ? fillRaw : 0));

      setOsdStats({
        frame_drops:        drops as number,
        video_width:        dw as number,
        video_height:       dh as number,
        display_fps:        fps as number,
        container_fps:      containerFps as number,
        estimated_vf_fps:   estVfFps as number,
        shader_profile:     String(shader ?? "None"),
        video_codec:        videoCodec,
        audio_codec:        audioCodec,
        video_format:       videoFormat,
        hwdec:              hwdecCurrent && hwdecCurrent !== "no" ? hwdecCurrent : "",
        video_bitrate:      videoBitrate as number,
        audio_bitrate:      audioBitrate as number,
        avsync:             avsync as number,
        cache_secs:         cacheSecs as number,
        cache_demuxer_secs: demuxerSecs as number,
        cache_used_bytes:   cacheUsedBytes as number,
        buffer_fill_pct,
        paused_for_cache:   pausedForCache,
        network_bps:        networkSpeed as number,
        audio_device:       audioDevice,
        audio_track:        audioTrackLabel,
        sub_track:          subTrackLabel,
        signal_kind:        signalKind,
        tone_mapping:       toneMapping || "",
        pixel_format:       pixelFmt || "",
      });
    } catch {}
  }, []);

  // Poll only while the OSD panel is visible — zero overhead otherwise.
  useEffect(() => {
    if (!osdVisible) return;
    pollOsd();
    const id = setInterval(pollOsd, 2000);
    return () => clearInterval(id);
  }, [osdVisible, pollOsd]);

  // Toggle via the central keybindings system (App.tsx dispatches the event).
  useEffect(() => {
    const onToggle = () => setOsdVisible((v) => !v);
    window.addEventListener("aura:toggle-osd", onToggle);
    return () => window.removeEventListener("aura:toggle-osd", onToggle);
  }, []);

  // Push the OSD below the 36 px Aura title bar in windowed mode so its
  // top row isn't clipped behind it. In fullscreen there's no title bar,
  // so go back to the original 16 px inset.
  const topPx = isFullscreen ? 16 : 48;

  return osdVisible ? <OsdOverlay stats={osdStats} topPx={topPx} /> : null;
}
