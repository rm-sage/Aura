// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Hls, {
  type LoaderContext,
  type LoaderConfiguration,
  type LoaderCallbacks,
} from "hls.js";
import type { IptvChannel } from "../../iptv/types";

// ---------------------------------------------------------------------------
// MultiView — a 2 / 3 / 2×2 grid of simultaneous live tiles, played with
// hls.js IN THE WEBVIEW (not the native mpv layer — mpv is single-instance).
// Each tile's requests are routed through the in-process bridge so hls.js can
// fetch cross-origin IPTV segments (the bridge adds CORS). One tile carries
// audio at a time; double-click promotes a tile into the main mpv player.
//
// MEMORY (the standing RAM directive): hls.js buffers are deliberately tiny
// (maxBufferLength 12 s, backBuffer 0) since these are live previews, and each
// instance is destroyed on channel change / unmount. Tiles are capped at 4.
// CONNECTIONS: every tile is a separate upstream connection — most IPTV
// accounts cap simultaneous streams, hence the warning banner.
// ---------------------------------------------------------------------------

const BRIDGE = "http://127.0.0.1:11471/proxy/";

type Layout = "2" | "3" | "2x2";
const TILE_COUNT: Record<Layout, number> = { "2": 2, "3": 3, "2x2": 4 };

/** Wrap a URL so hls.js fetches it through the CORS-enabled bridge. */
function bridgeUrl(url: string): string {
  return BRIDGE + encodeURIComponent(url);
}

const VOLUME_KEY = "aura.iptv.multiviewVolume";
function loadVolume(): number {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
}

/** Is this an HLS manifest URL? hls.js only plays HLS — raw `.ts`/`.mp4`
 *  live URLs (Xtream `output=ts`, generic M3U) must not be handed to it. */
function isHlsUrl(url: string): boolean {
  return /\.m3u8?(\?|#|$)/i.test(url);
}

/** hls.js loader that fetches every request through the CORS-enabled bridge,
 *  but reports the ORIGINAL (unwrapped) URL back to hls.js as the response
 *  URL. Critical: hls.js resolves child URIs (segments, variants, keys)
 *  against the response URL — if we let that be the bridge-wrapped URL, a
 *  relative or absolute-path segment resolves against 127.0.0.1 and then gets
 *  wrapped AGAIN (double-wrapped → the bridge fetches itself → 400). Restoring
 *  the original URL makes children resolve against the real origin, so each is
 *  wrapped exactly once. */
class BridgeProxyLoader extends Hls.DefaultConfig.loader {
  load(
    context: LoaderContext,
    config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    const original = context.url;
    if (original) context.url = bridgeUrl(original);
    const realOnSuccess = callbacks.onSuccess;
    callbacks.onSuccess = (response, stats, ctx, networkDetails) => {
      if (original) {
        response.url = original;
        if (ctx) ctx.url = original;
      }
      realOnSuccess(response, stats, ctx, networkDetails);
    };
    super.load(context, config, callbacks);
  }
}

interface Props {
  /** Group + search filtered channels to pick tiles from. */
  channels: IptvChannel[];
  /** Promote a tile into the main mpv player (double-click). */
  onPlayChannel: (channel: IptvChannel) => void;
  /** True when the main player is active (covering Live TV). All tiles
   *  suspend so they stop holding provider connections / MSE buffers. */
  suspended?: boolean;
}

export default function MultiView({ channels, onPlayChannel, suspended }: Props) {
  const [layout, setLayout] = useState<Layout>("2x2");
  const count = TILE_COUNT[layout];
  // Tile slots; resized (preserving existing assignments) when layout changes.
  const [tiles, setTiles] = useState<(IptvChannel | null)[]>(() => Array(4).fill(null));
  const [audioTile, setAudioTile] = useState(0);
  const [picking, setPicking] = useState<number | null>(null);
  const [volume, setVolume] = useState(loadVolume);
  const changeVolume = (v: number) => {
    setVolume(v);
    try { localStorage.setItem(VOLUME_KEY, String(v)); } catch { /* ignore */ }
  };

  const slots = useMemo(() => tiles.slice(0, count), [tiles, count]);

  const setTile = (i: number, ch: IptvChannel | null) => {
    setTiles((prev) => {
      const next = [...prev];
      next[i] = ch;
      return next;
    });
  };

  const clearAll = () => {
    setTiles(Array(4).fill(null));
    setAudioTile(0);
    setPicking(null);
  };

  const gridCls =
    layout === "2"
      ? "grid-cols-2 grid-rows-1"
      : layout === "3"
        ? "grid-cols-3 grid-rows-1"
        : "grid-cols-2 grid-rows-2";

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Controls: layout selector + clear all */}
      <div className="px-6 pt-1 pb-2 flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 p-1 rounded-xl bg-white/5 border border-white/8">
          {(["2", "3", "2x2"] as const).map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLayout(l)}
              className={[
                "px-3 h-7 rounded-lg text-[12px] font-medium transition-colors",
                layout === l ? "bg-ln-accent/20 text-ln-accent" : "text-white/55 hover:text-white/85",
              ].join(" ")}
            >
              {l === "2x2" ? "2×2" : l}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={clearAll}
          className="px-3 h-9 rounded-xl text-[12.5px] font-medium bg-white/5 border border-white/10
                     text-white/65 hover:bg-white/10 hover:text-white/90"
        >
          Clear all
        </button>

        {/* Volume for the audio-focused tile (others stay muted). Persisted.
            Grouped next to the controls (not pushed right) for visibility. */}
        <div className="flex items-center gap-2 ml-1 pl-2 border-l border-white/10">
          <button
            type="button"
            onClick={() => changeVolume(volume > 0 ? 0 : 0.5)}
            aria-label={volume > 0 ? "Mute" : "Unmute"}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10 flex-shrink-0"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">
              {volume === 0 ? (
                <path d="M3 10v4h4l5 5V5L7 10H3zm13.59 2 2.7-2.7-1.41-1.41L15.17 10.6 12.46 7.9 11.05 9.3 13.76 12l-2.71 2.7 1.41 1.41 2.71-2.7 2.71 2.7 1.41-1.41z" />
              ) : volume < 0.5 ? (
                <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" />
              ) : (
                <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z" />
              )}
            </svg>
          </button>
          <VolumeSlider value={volume} onChange={changeVolume} />
          <span className="text-[11.5px] text-white/60 tabular-nums w-7 text-right">
            {Math.round(volume * 100)}
          </span>
        </div>
      </div>

      {/* Simultaneous-stream warning (kept per the user's request). */}
      <div className="px-6 pb-2">
        <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/[0.06]
                        px-3.5 py-2 text-[12px] text-amber-200/80">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" className="mt-0.5 flex-shrink-0 opacity-80">
            <path d="M12 2 1 21h22L12 2zm0 14a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm1-7-.25 5.5h-1.5L11 9h2z" />
          </svg>
          <span>
            Most IPTV providers cap simultaneous streams per account (commonly 1–2). If a tile drops to
            "Stream offline" while others play, your provider may be throttling — close a stream and retry.
          </span>
        </div>
      </div>

      {/* Tile grid */}
      <div className="flex-1 min-h-0 px-6 pb-6">
        <div className={["grid gap-2 h-full", gridCls].join(" ")}>
          {slots.map((ch, i) => (
            <Tile
              key={i}
              channel={ch}
              audio={i === audioTile}
              volume={volume}
              suspended={!!suspended}
              onFocusAudio={() => setAudioTile(i)}
              onPick={() => setPicking(i)}
              onClear={() => {
                setTile(i, null);
                if (picking === i) setPicking(null);
              }}
              onExpand={() => ch && onPlayChannel(ch)}
            />
          ))}
        </div>
      </div>

      {/* Channel picker overlay */}
      {picking !== null && (
        <ChannelPicker
          channels={channels}
          onClose={() => setPicking(null)}
          onPick={(ch) => {
            setTile(picking, ch);
            setAudioTile(picking); // newest pick takes audio focus
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom volume slider — themed fill (ln-accent) + draggable thumb. The native
// range input rendered as an invisible track + a stray dot; this matches the
// app's aesthetic and is theme-coloured.
// ---------------------------------------------------------------------------

function VolumeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const setFromX = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange(Math.max(0, Math.min(1, (clientX - r.left) / r.width)));
  };
  const pct = Math.round(value * 100);
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Multiview volume"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        setFromX(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons) setFromX(e.clientX);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(Math.max(0, value - 0.05));
        else if (e.key === "ArrowRight") onChange(Math.min(1, value + 0.05));
      }}
      className="group relative w-28 h-1.5 rounded-full bg-white/15 cursor-pointer flex-shrink-0
                 focus:outline-none focus-visible:ring-2 focus-visible:ring-ln-accent/40"
    >
      <span
        className="absolute inset-y-0 left-0 rounded-full bg-ln-accent"
        style={{ width: `${pct}%` }}
      />
      <span
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white shadow"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tile — one hls.js <video>, or an empty "add channel" slot.
// ---------------------------------------------------------------------------

const Tile = memo(function Tile({
  channel,
  audio,
  volume,
  suspended,
  onFocusAudio,
  onPick,
  onClear,
  onExpand,
}: {
  channel: IptvChannel | null;
  audio: boolean;
  volume: number;
  suspended: boolean;
  onFocusAudio: () => void;
  onPick: () => void;
  onClear: () => void;
  onExpand: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "playing" | "error" | "unsupported">("idle");

  // (Re)attach hls.js whenever the tile's channel changes. Suspended (main
  // player active) tears the instance down so it stops streaming.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !channel || suspended) {
      setStatus("idle");
      return;
    }
    // hls.js only plays HLS — a raw .ts/.mp4 channel can't preview in the grid
    // (it still opens fine in the main player on double-click).
    if (!isHlsUrl(channel.url)) {
      setStatus("unsupported");
      return;
    }
    setStatus("loading");

    if (!Hls.isSupported()) {
      setStatus("error");
      return;
    }
    let recoverCount = 0;
    const hls = new Hls({
      // Tiny live buffer — these are previews, keep RAM bounded.
      maxBufferLength: 12,
      maxMaxBufferLength: 20,
      backBufferLength: 0,
      liveSyncDurationCount: 3,
      enableWorker: true,
      // Route every request through the CORS-enabled bridge so cross-origin
      // IPTV segments load in the webview.
      loader: BridgeProxyLoader,
    });
    let cancelled = false;
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (cancelled) return;
      video.play().then(() => setStatus("playing")).catch(() => {/* autoplay quirks */});
    });
    hls.on(Hls.Events.FRAG_BUFFERED, () => !cancelled && setStatus("playing"));
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (cancelled) return;
      if (data.fatal) {
        // Cap media-error recovery (hls.js doesn't self-limit it) so a
        // persistently broken stream can't loop forever pinning CPU.
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoverCount < 2) {
          recoverCount++;
          hls.recoverMediaError();
        } else {
          setStatus("error");
        }
      }
    });
    hls.loadSource(channel.url);
    hls.attachMedia(video);

    return () => {
      cancelled = true;
      hls.destroy();
    };
  }, [channel, suspended]);

  // Mute everything except the audio-focused tile; apply the shared volume.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !audio;
    v.volume = volume;
  }, [audio, volume, status]);

  if (!channel) {
    return (
      <button
        type="button"
        onClick={onPick}
        className="relative rounded-xl border border-dashed border-white/12 bg-white/[0.02]
                   hover:bg-white/[0.05] hover:border-white/20 transition-colors
                   flex flex-col items-center justify-center gap-2 text-white/40 hover:text-white/70"
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" /></svg>
        <span className="text-[12px] font-medium">Add channel</span>
      </button>
    );
  }

  return (
    <div
      onClick={onFocusAudio}
      onDoubleClick={onExpand}
      title={`${channel.name}\nClick: audio · Double-click: open in player`}
      className={[
        "group relative rounded-xl overflow-hidden bg-black cursor-pointer border transition-colors",
        audio ? "border-ln-accent/60" : "border-white/10 hover:border-white/25",
      ].join(" ")}
    >
      <video ref={videoRef} className="w-full h-full object-contain bg-black" playsInline autoPlay muted />

      {/* Status overlays */}
      {status === "loading" && (
        <span className="absolute inset-0 flex items-center justify-center text-white/55 text-[12px]">
          Connecting…
        </span>
      )}
      {status === "error" && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white/55 text-[12px] px-3 text-center">
          <span className="text-red-300/80 font-medium">Stream offline</span>
          <span className="text-white/35 text-[11px]">Provider may be throttling — try another channel.</span>
        </span>
      )}
      {status === "unsupported" && (
        <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-white/55 text-[12px] px-3 text-center">
          <span className="text-white/70 font-medium">Not previewable here</span>
          <span className="text-white/35 text-[11px]">This stream isn't HLS — double-click to open it in the player.</span>
        </span>
      )}

      {/* Top bar: name + audio badge + clear */}
      <div className="absolute inset-x-0 top-0 flex items-center gap-1.5 px-2 py-1.5
                      bg-gradient-to-b from-black/70 to-transparent">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 flex-shrink-0"
              style={{ boxShadow: "0 0 5px rgba(239,68,68,0.7)" }} />
        <span className="text-[11.5px] text-white/90 font-medium truncate flex-1">{channel.name}</span>
        {audio ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-ln-accent flex-shrink-0">
            <path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-white/35 flex-shrink-0">
            <path d="M3 10v4h4l5 5V5L7 10H3z" />
          </svg>
        )}
        <button
          type="button"
          aria-label="Remove"
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          className="w-5 h-5 rounded flex items-center justify-center text-white/50 hover:text-white hover:bg-white/15 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
        </button>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Channel picker — searchable overlay to assign a channel to a tile.
// ---------------------------------------------------------------------------

function ChannelPicker({
  channels,
  onClose,
  onPick,
}: {
  channels: IptvChannel[];
  onClose: () => void;
  onPick: (ch: IptvChannel) => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const base = needle ? channels.filter((c) => c.name.toLowerCase().includes(needle)) : channels;
    return base.slice(0, 300);
  }, [channels, q]);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[460px] max-w-[92vw] max-h-[70vh] flex flex-col rounded-2xl border border-white/12
                   bg-[rgba(16,16,20,0.98)] backdrop-blur-2xl shadow-glass-edge p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search channels to add…"
          className="h-10 px-3 mb-3 rounded-xl bg-white/5 border border-white/10 text-[13px]
                     text-white/90 placeholder:text-white/30 focus:outline-none focus:border-ln-accent/40"
        />
        <div className="flex-1 overflow-y-auto -mx-1 px-1" style={{ scrollbarWidth: "thin" }}>
          {list.length === 0 ? (
            <p className="text-white/40 text-sm py-8 text-center">No channels match.</p>
          ) : (
            list.map((ch) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => onPick(ch)}
                className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left hover:bg-white/[0.06]"
              >
                {ch.logo ? (
                  <img src={ch.logo} alt="" loading="lazy" className="w-7 h-7 object-contain flex-shrink-0"
                       onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                ) : (
                  <span className="w-7 h-7 flex-shrink-0" />
                )}
                <span className="text-[13px] text-white/85 truncate">{ch.name}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
