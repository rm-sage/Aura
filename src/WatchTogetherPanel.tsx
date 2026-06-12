// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// WatchTogetherPanel — the room UI (create / join / member list / leave).
// Floating glass card, opened from the player's More menu via the
// `aura:open-watch-together` window event (same decoupling as the cast menu /
// source switcher). Playback sync itself lives in src/watchTogether/store.ts;
// this panel only drives the room lifecycle + presence.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useWatchTogether } from "./watchTogether/useWatchTogether";
import {
  createRoom, joinRoom, leaveRoom, setWatchConfig,
  getRelayUrl, getDisplayName, getAppToken,
} from "./watchTogether/store";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function WatchTogetherPanel({ open, onClose }: Props) {
  const w = useWatchTogether();
  const [relayUrl, setRelayUrl] = useState(getRelayUrl());
  const [name, setName] = useState(getDisplayName());
  const [token, setToken] = useState(getAppToken());
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);

  // Keep the local fields in step if the panel re-opens.
  useEffect(() => {
    if (open) {
      setRelayUrl(getRelayUrl());
      setName(getDisplayName());
      setToken(getAppToken());
      setCopied(false);
      setEditingConfig(false);
    }
  }, [open]);

  if (!open) return null;

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
      <div className="fixed inset-0 z-[9998]" onClick={onClose} />
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999]
                   w-[360px] max-w-[92vw] rounded-2xl border border-white/12
                   bg-[rgba(16,16,20,0.98)] backdrop-blur-2xl shadow-glass-edge p-5"
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
            onName={setName}
            onJoinCode={setJoinCode}
            // Persist only the name here — the relay URL defaults to the baked-in
            // Worker unless explicitly overridden in Relay settings, so we avoid
            // pinning localStorage to the current default.
            onCreate={() => { setWatchConfig({ displayName: name }); createRoom(); }}
            onJoin={() => { setWatchConfig({ displayName: name }); joinRoom(joinCode); }}
            onEditRelay={() => setEditingConfig(true)}
          />
        ) : (
          <Room
            code={w.roomCode}
            status={w.status}
            members={w.members}
            selfId={w.selfId}
            roomVideoKey={w.roomVideoKey}
            roomTitle={w.roomTitle}
            inSync={w.inSync}
            isLeader={w.isLeader}
            copied={copied}
            onCopy={copyCode}
            onLeave={leaveRoom}
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
  name, joinCode, onName, onJoinCode, onCreate, onJoin, onEditRelay,
}: {
  name: string; joinCode: string;
  onName: (v: string) => void; onJoinCode: (v: string) => void;
  onCreate: () => void; onJoin: () => void; onEditRelay: () => void;
}) {
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

      <div className="flex gap-2">
        <input
          value={joinCode}
          onChange={(e) => onJoinCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && joinCode.trim() && onJoin()}
          placeholder="Room code"
          maxLength={8}
          className={`${inputCls} flex-1 tracking-[0.2em] font-mono uppercase`}
        />
        <button type="button" onClick={onJoin} disabled={!joinCode.trim()} className={secondaryBtn}>
          Join
        </button>
      </div>

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
  code, status, members, selfId, roomVideoKey, roomTitle, inSync, isLeader,
  copied, onCopy, onLeave,
}: {
  code: string | null; status: string; members: { id: string; name: string; videoKey: string | null }[];
  selfId: string | null; roomVideoKey: string | null; roomTitle: string | null;
  inSync: boolean; isLeader: boolean; copied: boolean;
  onCopy: () => void; onLeave: () => void;
}) {
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
          Waiting for someone to start playing. Whatever the first person plays becomes the party's title.
        </p>
      ) : inSync ? (
        <p className="text-emerald-300/90 text-[12.5px] flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          In sync{isLeader ? " · you're the timing leader" : ""}
        </p>
      ) : (
        <div className="rounded-xl bg-amber-400/[0.08] border border-amber-400/20 px-3 py-2.5">
          <p className="text-amber-200/90 text-[12px] leading-snug">
            The party is watching{roomTitle ? <> <span className="font-semibold">{roomTitle}</span></> : " a title"}.
            Open it and pick a stream to fall into sync.
          </p>
        </div>
      )}

      {/* Members */}
      <div>
        <p className="text-white/40 text-[10px] uppercase tracking-wider mb-1.5">
          In the room · {members.length}
        </p>
        <ul className="space-y-1">
          {members.map((m) => {
            const onTitle = roomVideoKey != null && m.videoKey === roomVideoKey;
            return (
              <li key={m.id} className="flex items-center gap-2 text-[13px]">
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${onTitle ? "bg-emerald-400" : "bg-amber-400/70"}`}
                  title={onTitle ? "Watching the party title" : "On a different title"}
                />
                <span className="text-white/85 truncate">
                  {m.name}{m.id === selfId ? " (you)" : ""}
                </span>
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
