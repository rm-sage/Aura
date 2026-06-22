// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// WatchTogetherPanel — the room UI (create / join / member list / leave).
// Floating glass card, opened from the player's More menu via the
// `aura:open-watch-together` window event (same decoupling as the cast menu /
// source switcher). Playback sync itself lives in src/watchTogether/store.ts;
// this panel only drives the room lifecycle + presence.
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from "react";
import { useWatchTogether } from "./watchTogether/useWatchTogether";
import { readPartyAnchor, type PartyAnchor } from "./partyAnchor";
import {
  createRoom, createRoomWithCode, joinRoom, leaveRoom, transferLeader, setWatchConfig,
  openRoomVideo, clearPartyStream, getRelayUrl, getDisplayName, getAppToken,
} from "./watchTogether/store";
import { peekRichestCachedDetailById } from "./metaCache";
import { scheduleHoverOpen, scheduleHoverClose, closeHoverNow } from "./catalogHoverStore";
import type { MetaPreview } from "./types";
import type { MemberStat } from "./watchTogether/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Exit-animation duration — the card stays mounted this long after `open`
// flips false so it can fly back into its button before unmounting. Keep in
// step with the `transform`/`opacity` transition below.
const EXIT_MS = 200;

export default function WatchTogetherPanel({ open, onClose }: Props) {
  const w = useWatchTogether();
  const [relayUrl, setRelayUrl] = useState(getRelayUrl());
  const [name, setName] = useState(getDisplayName());
  const [token, setToken] = useState(getAppToken());
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  // Mount + animation lifecycle. `render` keeps the card alive through the exit
  // animation; `visible` drives the enter/exit transition; `anchor` pins the
  // card next to whichever party button opened it (top-left PartyButton while
  // browsing, top-right presence cluster during playback) so it grows out of
  // that icon — same anchor the PartyToast stack spawns from.
  const [render, setRender] = useState(open);
  const [visible, setVisible] = useState(false);
  const [anchor, setAnchor] = useState<PartyAnchor>({ side: "right", top: 70, right: 16 });

  // Drive the spawn / despawn. On open: snapshot the anchor, mount, then flip
  // `visible` on the next frame so the transition runs from the collapsed
  // state. On close: flip `visible` off and unmount once the exit finishes.
  useEffect(() => {
    if (open) {
      setAnchor(readPartyAnchor());
      setRender(true);
      // Capture BOTH rAF handles: if the panel is closed inside the ~16ms
      // between the two frames, cancelling only the outer would leave the
      // inner to fire setVisible(true) after the close already set it false
      // — popping the card away with no exit animation.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setVisible(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setVisible(false);
    const t = setTimeout(() => setRender(false), EXIT_MS);
    return () => clearTimeout(t);
  }, [open]);

  // Re-pin to the button if the window resizes while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onResize = () => setAnchor(readPartyAnchor());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // Keep the local fields in step if the panel re-opens.
  useEffect(() => {
    if (open) {
      setRelayUrl(getRelayUrl());
      setName(getDisplayName());
      setToken(getAppToken());
      setCopied(false);
      setEditingConfig(false);
    } else {
      // Closing the panel must dismiss any brief-meta hover card it spawned.
      closeHoverNow();
    }
  }, [open]);

  if (!render) return null;

  const reduced = document.documentElement.getAttribute("data-reduced-motion") === "true";
  const horizontal = anchor.side === "left" ? { left: anchor.left } : { right: anchor.right };
  const transformOrigin = anchor.side === "left" ? "top left" : "top right";

  const configured = relayUrl.trim().length > 0;
  const inRoom = w.status === "connected" || w.status === "connecting";
  const showConfig = !configured || editingConfig;

  const persistConfig = () => setWatchConfig({ relayUrl, displayName: name, appToken: token });

  const copyCode = () => {
    if (!w.roomCode) return;
    void navigator.clipboard?.writeText(w.roomCode).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };

  return (
    <>
      {/* Click-catcher. Sits above the player chrome (z below) so an outside
          click during playback closes the panel instead of pausing the video. */}
      <div
        className="fixed inset-0 z-[10040]"
        onClick={onClose}
        style={{
          opacity: visible ? 1 : 0,
          // opacity:0 still hit-tests — without this the catcher stays a
          // full-screen click-trap through the 200ms exit, swallowing the
          // next click (e.g. a play/pause toggle during playback). Only the
          // active (visible) modal layer should capture.
          pointerEvents: visible ? "auto" : "none",
          transition: "opacity 180ms ease",
        }}
      />
      <div
        className="fixed z-[10041] w-[360px] max-w-[92vw] rounded-2xl border border-white/12
                   bg-[rgba(16,16,20,0.98)] backdrop-blur-2xl shadow-glass-edge p-5 overflow-y-auto"
        style={{
          top: anchor.top,
          ...horizontal,
          maxHeight: `calc(100vh - ${anchor.top + 16}px)`,
          transformOrigin,
          opacity: visible ? 1 : 0,
          // Grow out of / collapse back into the party button corner.
          transform: visible
            ? "translateY(0) scale(1)"
            : reduced ? "none" : "translateY(-8px) scale(0.96)",
          transition: reduced
            ? "opacity 160ms ease"
            : "opacity 200ms ease, transform 240ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
        role="dialog"
        aria-label="Watch Together"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white/95 text-[15px] font-semibold flex items-center gap-2">
            <PeopleGlyph /> Watch Together
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.08]"
          >
            ✕
          </button>
        </div>

        {w.error && (
          <p className="text-rose-300/90 text-[12px] mb-3 leading-snug">{w.error}</p>
        )}

        {showConfig ? (
          <ConfigNotice
            firstTime={!configured}
            relayUrl={relayUrl}
            name={name}
            token={token}
            onRelayUrl={setRelayUrl}
            onName={setName}
            onToken={setToken}
            onSave={() => { persistConfig(); setEditingConfig(false); }}
          />
        ) : !inRoom ? (
          <Lobby
            name={name}
            joinCode={joinCode}
            notFoundCode={w.status === "not-found" ? w.pendingCode : null}
            onName={setName}
            onJoinCode={setJoinCode}
            // Persist only the name here — the relay URL defaults to the baked-in
            // Worker unless explicitly overridden in Relay settings, so we avoid
            // pinning localStorage to the current default.
            onCreate={() => { setWatchConfig({ displayName: name }); createRoom(); }}
            onJoin={() => { setWatchConfig({ displayName: name }); joinRoom(joinCode); }}
            onCreateWithCode={(c) => { setWatchConfig({ displayName: name }); createRoomWithCode(c); }}
            onEditRelay={() => setEditingConfig(true)}
          />
        ) : (
          <Room
            code={w.roomCode}
            status={w.status}
            members={w.members}
            selfId={w.selfId}
            leaderId={w.leaderId}
            roomVideoKey={w.roomVideoKey}
            roomMetaId={w.roomMetaId}
            roomMediaType={w.roomMediaType}
            roomTitle={w.roomTitle}
            roomStreamLabel={w.roomStreamLabel}
            staging={w.staging}
            inSync={w.inSync}
            isLeader={w.isLeader}
            copied={copied}
            memberStats={w.memberStats}
            onCopy={copyCode}
            onJoin={() => { openRoomVideo(); onClose(); }}
            onLeave={leaveRoom}
            onClearStream={clearPartyStream}
            onTransfer={transferLeader}
          />
        )}
      </div>
    </>
  );
}

// ── Sub-views ───────────────────────────────────────────────────────────────

function ConfigNotice({
  firstTime, relayUrl, name, token, onRelayUrl, onName, onToken, onSave,
}: {
  firstTime: boolean; relayUrl: string; name: string; token: string;
  onRelayUrl: (v: string) => void; onName: (v: string) => void;
  onToken: (v: string) => void; onSave: () => void;
}) {
  return (
    <div className="space-y-3">
      {firstTime && (
        <p className="text-white/55 text-[12.5px] leading-relaxed">
          Watch Together needs a relay. Deploy the bundled Cloudflare Worker
          (see <span className="text-white/75">watch-relay/README.md</span>), then
          paste its <span className="text-white/75">wss://</span> URL here.
        </p>
      )}
      <Field label="Relay URL">
        <input
          value={relayUrl}
          onChange={(e) => onRelayUrl(e.target.value)}
          placeholder="wss://aura-watch-relay.you.workers.dev"
          className={inputCls}
        />
      </Field>
      <Field label="Your name">
        <input value={name} onChange={(e) => onName(e.target.value)} maxLength={40} className={inputCls} />
      </Field>
      <Field label="App token (optional)">
        <input
          value={token}
          onChange={(e) => onToken(e.target.value)}
          placeholder="must match the Worker's APP_TOKEN"
          className={inputCls}
        />
      </Field>
      <button type="button" onClick={onSave} className={primaryBtn} disabled={!relayUrl.trim()}>
        Save
      </button>
    </div>
  );
}

function Lobby({
  name, joinCode, notFoundCode, onName, onJoinCode, onCreate, onJoin, onCreateWithCode, onEditRelay,
}: {
  name: string; joinCode: string; notFoundCode: string | null;
  onName: (v: string) => void; onJoinCode: (v: string) => void;
  onCreate: () => void; onJoin: () => void; onCreateWithCode: (code: string) => void;
  onEditRelay: () => void;
}) {
  // A code is joinable only at 4–16 chars (the relay's accepted shape) — gate
  // the Join button so a too-short code can't hang on "connecting".
  const cleaned = joinCode.trim().replace(/[^A-Za-z0-9]/g, "");
  const codeValid = cleaned.length >= 4 && cleaned.length <= 16;
  return (
    <div className="space-y-4">
      <Field label="Your name">
        <input value={name} onChange={(e) => onName(e.target.value)} maxLength={40} className={inputCls} />
      </Field>

      <button type="button" onClick={onCreate} className={primaryBtn}>
        Create a room
      </button>

      <div className="flex items-center gap-3 text-white/30 text-[11px] uppercase tracking-wider">
        <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
      </div>

      <div className="space-y-1.5">
        <div className="flex gap-2">
          <input
            value={joinCode}
            onChange={(e) => onJoinCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && codeValid && onJoin()}
            placeholder="Room code"
            maxLength={16}
            className={`${inputCls} flex-1 tracking-[0.2em] font-mono uppercase`}
          />
          <button type="button" onClick={onJoin} disabled={!codeValid} className={secondaryBtn}>
            Join
          </button>
        </div>
        <p className="text-white/30 text-[10.5px] leading-snug">4–16 letters or numbers.</p>
      </div>

      {notFoundCode && (
        <div className="rounded-xl bg-amber-400/[0.08] border border-amber-400/20 px-3 py-2.5 space-y-2">
          <p className="text-amber-200/90 text-[12px] leading-snug">
            No one is hosting room <span className="font-mono font-semibold tracking-[0.15em]">{notFoundCode}</span> right now.
          </p>
          <button type="button" onClick={() => onCreateWithCode(notFoundCode)} className={primaryBtn}>
            Create room {notFoundCode}
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={onEditRelay}
        className="text-white/35 hover:text-white/60 text-[11px] transition-colors"
      >
        Relay settings
      </button>
    </div>
  );
}

function Room({
  code, status, members, selfId, leaderId, roomVideoKey, roomMetaId, roomMediaType,
  roomTitle, roomStreamLabel, staging, inSync, isLeader, copied, memberStats,
  onCopy, onJoin, onLeave, onClearStream, onTransfer,
}: {
  code: string | null; status: string; members: { id: string; name: string; videoKey: string | null }[];
  selfId: string | null; leaderId: string | null; roomVideoKey: string | null;
  roomMetaId: string | null; roomMediaType: string | null; roomTitle: string | null;
  roomStreamLabel: string | null; staging: boolean;
  inSync: boolean; isLeader: boolean; copied: boolean;
  memberStats: Record<string, MemberStat>;
  onCopy: () => void; onJoin: () => void; onLeave: () => void; onClearStream: () => void;
  onTransfer: (id: string) => void;
}) {
  const readyHere = roomVideoKey ? members.filter((m) => m.videoKey === roomVideoKey).length : 0;
  return (
    <div className="space-y-4">
      {/* Room code */}
      <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] border border-white/8 px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="text-white/40 text-[10px] uppercase tracking-wider">Room code</p>
          <p className="text-white text-[20px] font-mono font-semibold tracking-[0.18em] leading-tight">
            {status === "connecting" ? "…" : code}
          </p>
        </div>
        <button type="button" onClick={onCopy} className={secondaryBtn}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Sync status */}
      {status === "connecting" ? (
        <p className="text-white/45 text-[12.5px] flex items-center gap-2">
          <Spinner /> Connecting…
        </p>
      ) : !roomVideoKey ? (
        <p className="text-white/45 text-[12.5px]">
          {isLeader
            ? "You're the host. Play something and it becomes the party's title."
            : "Waiting for the host to start playing."}
        </p>
      ) : inSync ? (
        <div className="rounded-xl bg-emerald-400/[0.07] border border-emerald-400/20 px-3 py-2.5 space-y-1">
          <p className="text-emerald-300/90 text-[12.5px] flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            {staging ? `Waiting for the party · ${readyHere}/${members.length} here` : "In sync"}
            {isLeader ? " · you're the host" : ""}
          </p>
          <PartyMediaCard
            metaId={roomMetaId} mediaType={roomMediaType} videoKey={roomVideoKey}
            title={roomTitle} streamLabel={roomStreamLabel}
          />
        </div>
      ) : (
        <div className="rounded-xl bg-amber-400/[0.08] border border-amber-400/20 px-3 py-2.5">
          <p className="text-amber-200/90 text-[12px] leading-snug">The party is watching:</p>
          <PartyMediaCard
            metaId={roomMetaId} mediaType={roomMediaType} videoKey={roomVideoKey}
            title={roomTitle} streamLabel={roomStreamLabel}
          />
          <button type="button" onClick={onJoin} disabled={!roomVideoKey} className={`${primaryBtn} mt-2.5`}>
            Join &amp; sync
          </button>
        </div>
      )}

      {/* Leader stream control — clear the party's selected stream so the next
          stream the host plays re-establishes it. */}
      {isLeader && roomVideoKey && (
        <button
          type="button"
          onClick={onClearStream}
          className="w-full h-8 rounded-xl text-[12px] font-medium text-white/65 border border-white/10
                     hover:bg-white/[0.06] hover:text-white/90 transition-colors"
        >
          Clear party stream
        </button>
      )}

      {/* Members */}
      <div>
        <p className="text-white/40 text-[10px] uppercase tracking-wider mb-1.5">
          In the room · {members.length}
        </p>
        <ul className="space-y-0.5">
          {members.map((m) => {
            const onTitle = roomVideoKey != null && m.videoKey === roomVideoKey;
            const isHost = m.id === leaderId;
            const canTransfer = isLeader && !isHost && m.id !== selfId;
            return (
              <li
                key={m.id}
                className="group flex items-center gap-2 text-[13px] rounded-lg px-1.5 py-1 -mx-1.5 hover:bg-white/[0.04]"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${onTitle ? "bg-emerald-400" : "bg-amber-400/70"}`}
                  title={onTitle ? "Watching the party title" : "On a different title"}
                />
                <span className="text-white/85 truncate flex items-center gap-1.5 min-w-0">
                  <span className="truncate">{m.name}{m.id === selfId ? " (you)" : ""}</span>
                  {isHost && (
                    <span title="Host" aria-label="Host" className="text-amber-300 text-[12px] flex-shrink-0 leading-none">♛</span>
                  )}
                </span>
                {/* Buffer is the LAST element so it's always flush-right and
                    aligned across every row. "Make host" is `hidden` (zero
                    layout) at rest — so an invisible button never shifts a
                    member's buffer bar — and appears to the LEFT of the buffer
                    on hover, leaving the buffer's right edge fixed. */}
                <div className="ml-auto flex items-center gap-2 flex-shrink-0">
                  {canTransfer && (
                    <button
                      type="button"
                      onClick={() => onTransfer(m.id)}
                      title={`Make ${m.name} the host`}
                      className="flex-shrink-0 hidden group-hover:inline-flex focus:inline-flex
                                 text-[10.5px] px-1.5 py-0.5 rounded-md text-white/55
                                 hover:text-amber-200 hover:bg-white/[0.06] border border-white/10"
                    >
                      Make host
                    </button>
                  )}
                  <MemberBuffer stat={memberStats[m.id]} />
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <button type="button" onClick={onLeave} className={dangerBtn}>
        Leave room
      </button>
    </div>
  );
}

/** Brief meta for the party's selected title (poster + title + facts line),
 *  with the full rich CatalogHoverCard on hover. Meta comes straight from the
 *  shared 24 h cache (no addons needed here) — if it's not cached yet the poster
 *  is a placeholder and the rich card fetches on hover. */
function PartyMediaCard({
  metaId, mediaType, videoKey, title, streamLabel,
}: {
  metaId: string | null; mediaType: string | null; videoKey: string | null;
  title: string | null; streamLabel: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  if (!metaId && !title) return null;

  const detail = metaId ? peekRichestCachedDetailById(metaId) : null;
  const poster = detail?.poster ?? null;
  const typeLabel = mediaType === "series" ? "Series" : mediaType === "movie" ? "Movie" : (mediaType ? cap(mediaType) : null);
  const facts = [detail?.release_info ?? null, typeLabel, episodeLabel(videoKey, mediaType), streamLabel]
    .filter(Boolean).join(" · ");
  const preview: MetaPreview | null = metaId ? {
    id: metaId, name: title ?? detail?.name ?? "", media_type: mediaType ?? "movie",
    poster, background: detail?.background ?? null, fanart: null, backdrop: null,
    logo: detail?.logo ?? null, release_info: detail?.release_info ?? null,
    description: detail?.description ?? null, imdb_rating: detail?.imdb_rating ?? null,
    genres: detail?.genres ?? [],
  } : null;

  return (
    <div
      ref={ref}
      onMouseEnter={() => { if (preview && ref.current) scheduleHoverOpen(preview, ref.current); }}
      onMouseLeave={() => scheduleHoverClose()}
      className="flex items-center gap-2.5 cursor-default"
    >
      {poster ? (
        <img src={poster} alt="" loading="lazy"
             className="w-9 h-[54px] rounded-md object-cover flex-shrink-0 bg-white/5 border border-white/10" />
      ) : (
        <div className="w-9 h-[54px] rounded-md flex-shrink-0 bg-white/[0.06] border border-white/10" />
      )}
      <div className="min-w-0">
        <p className="text-white/90 text-[12.5px] font-medium truncate">{title ?? detail?.name ?? "Untitled"}</p>
        {facts && <p className="text-white/45 text-[11px] truncate">{facts}</p>}
      </div>
    </div>
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Parse "S{season}E{episode}" from a series videoKey like "tt0903747:1:5". */
function episodeLabel(videoKey: string | null, mediaType: string | null): string | null {
  if (!videoKey || mediaType === "movie") return null;
  const parts = videoKey.split(":");
  if (parts.length >= 3) {
    const s = parts[parts.length - 2], e = parts[parts.length - 1];
    if (/^\d+$/.test(s) && /^\d+$/.test(e)) return `S${s}E${e}`;
  }
  return null;
}

/** Per-member buffer readout: a stall pill while paused-for-cache, otherwise a
 *  small readahead bar + seconds ("amount cached in the demuxer"). Driven by the
 *  throttled per-member `stat` frames relayed through the party. */
function MemberBuffer({ stat }: { stat: MemberStat | undefined }) {
  if (!stat) return null;
  if (stat.stalled) {
    return (
      <span
        title="Buffering"
        className="text-[10px] tabular-nums text-amber-300 flex-shrink-0 whitespace-nowrap"
      >
        buffering{stat.pct != null ? ` ${Math.round(stat.pct)}%` : "…"}
      </span>
    );
  }
  if (stat.seconds == null) return null;
  // Health bar relative to a 30s readahead target — full ≈ a comfortable buffer.
  const frac = Math.max(0.04, Math.min(1, stat.seconds / 30));
  return (
    <span
      title={`${stat.seconds.toFixed(0)}s buffered ahead`}
      className="flex items-center gap-1 flex-shrink-0"
    >
      <span className="w-8 h-1 rounded-full bg-white/12 overflow-hidden">
        <span className="block h-full rounded-full bg-emerald-400/70" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="text-[10px] tabular-nums text-white/45">{stat.seconds.toFixed(0)}s</span>
    </span>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-white/40 text-[10px] uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputCls =
  "w-full h-9 px-3 rounded-xl bg-white/5 border border-white/10 text-[13px] text-white/90 " +
  "placeholder:text-white/30 focus:outline-none focus:border-ln-accent/40";
const primaryBtn =
  "w-full h-9 rounded-xl text-[13px] font-medium bg-ln-accent/15 text-ln-accent border border-ln-accent/30 " +
  "hover:bg-ln-accent/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors";
const secondaryBtn =
  "px-3.5 h-9 rounded-xl text-[13px] font-medium bg-white/5 text-white/85 border border-white/10 " +
  "hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0";
const dangerBtn =
  "w-full h-9 rounded-xl text-[13px] font-medium text-rose-300/85 border border-rose-400/20 " +
  "hover:bg-rose-400/10 transition-colors";

function Spinner() {
  return <span className="w-3.5 h-3.5 rounded-full border-2 border-white/15 border-t-ln-accent animate-spin inline-block" />;
}

function PeopleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="text-ln-accent/85" aria-hidden>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
