// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// WatchTogetherPanel — the room UI (create / join / member list / leave).
// Floating glass card, opened from the player's More menu via the
// `aura:open-watch-together` window event (same decoupling as the cast menu /
// source switcher). Playback sync itself lives in src/watchTogether/store.ts;
// this panel only drives the room lifecycle + presence.
// ---------------------------------------------------------------------------

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useWatchTogether } from "./watchTogether/useWatchTogether";
import { useGlassStyle } from "./glassStyle";
import { readPartyAnchor, type PartyAnchor } from "./partyAnchor";
import { usePopPresence } from "./popPresence";
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
  /** A player is up: the panel floats over the mpv video, which the webview's
   *  backdrop pass cannot sample, so it takes the player MATERIAL
   *  (.aura-glass-player: baked base, no backdrop, no refraction). */
  overPlayer?: boolean;
}

// Exit-animation duration — the card stays mounted this long after `open`
// flips false so it can fly back into its button before unmounting. Keep in
// step with the `transform`/`opacity` transition below.
const EXIT_MS = 200;

/** Eat the click that follows a dismissing press on `scope`, in the window
 *  capture phase so no React handler sees it, plus the rest of the same
 *  multi-click (later clicks and the dblclick with `detail` 2 or more).
 *  The press's own click is the FIRST trusted click after it, however long
 *  the press is held: when that click lands outside `scope` (the press was
 *  dragged off before release), or a new press comes with no click at all,
 *  nothing is eaten and it ends, so a later deliberate click (reopening from
 *  the rail row, pausing the video) always goes through. A new single click
 *  (`detail` 1) ends it too. Self-removing (a 10 s cap bounds a lost
 *  gesture): it outlives the panel's effect, which ends with the close. */
function swallowNextClickIn(scope: Element) {
  let started = false;
  const eat = (e: MouseEvent) => {
    if (!e.isTrusted) return;
    const t = e.target as Node | null;
    if (!t || !scope.contains(t) || (started && e.detail < 2)) { done(); return; }
    started = true;
    e.stopPropagation();
    e.preventDefault();
    clearTimeout(timer);
    timer = setTimeout(done, 1000);
  };
  // Added during the dismissing pointerdown's own dispatch, so it first sees
  // the NEXT press: before the click, that press means the first one made
  // none; after it, it is the second press of a double-click.
  const onDown = (e: PointerEvent) => { if (e.isTrusted && !started) done(); };
  const done = () => {
    window.removeEventListener("click", eat, true);
    window.removeEventListener("dblclick", eat, true);
    window.removeEventListener("pointerdown", onDown, true);
    clearTimeout(timer);
  };
  let timer = setTimeout(done, 10_000);
  window.addEventListener("click", eat, true);
  window.addEventListener("dblclick", eat, true);
  window.addEventListener("pointerdown", onDown, true);
}

// App passes a fresh inline `onClose` on every render, and App re-renders on
// every playback-update tick. Handed straight through, it re-bound the open
// panel's window capture listeners (Escape, outside press) on each tick and
// re-rendered the whole panel. The wrapper passes a stable callback that calls
// the latest prop, and the memoized body renders only when `open`,
// `overPlayer` or the party store changes.
export default function WatchTogetherPanel(props: Props) {
  const latestClose = useRef(props.onClose);
  useLayoutEffect(() => { latestClose.current = props.onClose; });
  const onClose = useCallback(() => latestClose.current(), []);
  return <WatchTogetherPanelBody open={props.open} overPlayer={props.overPlayer} onClose={onClose} />;
}

const WatchTogetherPanelBody = memo(function WatchTogetherPanelBody({ open, onClose, overPlayer = false }: Props) {
  const w = useWatchTogether();
  const glass = useGlassStyle();
  const [relayUrl, setRelayUrl] = useState(getRelayUrl());
  const [name, setName] = useState(getDisplayName());
  const [token, setToken] = useState(getAppToken());
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [editingConfig, setEditingConfig] = useState(false);
  // Mount + animation lifecycle (usePopPresence). `render` keeps the card alive
  // through the exit animation; `visible` drives the enter/exit transition;
  // `anchor` pins the card next to whichever party button opened it (top-left
  // PartyButton while browsing, top-right presence cluster during playback) so
  // it grows out of that icon, same anchor the PartyToast stack spawns from.
  const [anchor, setAnchor] = useState<PartyAnchor>({ side: "right", top: 70, right: 16 });
  // Snapshot the anchor on open. A layout effect declared BEFORE the presence
  // hook, so setAnchor batches with its mount into one sync render.
  useLayoutEffect(() => {
    if (open) setAnchor(readPartyAnchor());
  }, [open]);
  const pop = usePopPresence<HTMLDivElement>(open, EXIT_MS);
  const { render, visible } = pop;

  // Re-pin to the button if the window resizes while the panel is open.
  useEffect(() => {
    if (!open) return;
    const onResize = () => setAnchor(readPartyAnchor());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open]);

  // Escape dismisses, matching the notifications panel and the profile popover.
  // The close button was dropped on the grounds that this panel "dismisses on
  // an outside click and on Escape" - but no Escape handler existed, so the
  // second half of that was not true, and during WINDOWED playback Escape
  // reached App's app-wide ladder and tore playback down instead of closing
  // the panel. CAPTURE phase + stopPropagation is what shields that ladder,
  // mirroring CastMenu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Outside press closes, and the press still lands (2026-11-22, the user: the
  // first click after opening "will always just close the panel instead of
  // closing it and clicking on whatever was focused; hovering things doesn't
  // work either"). This was a full-window click-catcher (fixed inset-0 under
  // the card), which ate that click and every hover while the panel was up.
  // Now a window CAPTURE press, as the Downloads panel: left button only,
  // and not on the panel itself, a context menu raised over it, the
  // Performance Monitor, the title bar (dragging the window keeps it open) or
  // the hover card below. POINTERDOWN, not mousedown: a control that cancels
  // its pointerdown (the player's seek bar) suppresses the mousedown, so a
  // press there seeked and left the panel open; and a touch or pen tap closes
  // at contact, before its click.
  // Two presses close WITHOUT their click going through:
  //  - a party trigger (`data-party-anchor`: the rail row, the player's party
  //    pill, the party toasts): it only ever OPENS the panel, so its click would
  //    reopen what the press just closed; eaten, the trigger toggles;
  //  - the player's bare video (`data-player-click-layer`): that click pauses,
  //    and the catcher existed so a dismissing click over playback would not.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const t = e.target as Element | null;
      if (!t || !t.closest) return;
      if (pop.ref.current?.contains(t)) return;
      // The hover card the party's video row raises is part of the panel too
      // (now reachable: the catcher used to cover it).
      if (t.closest("[data-aura-context-menu], [data-perf-monitor], [data-aura-titlebar], [data-hover-panel]")) return;
      const eat = t.closest("[data-party-anchor], [data-player-click-layer]");
      if (eat) swallowNextClickIn(eat);
      onClose();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open, onClose, pop.ref]);

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
  // Liquid grows the card out of its trigger like a droplet: squashed toward
  // the button, then a springy overshoot that settles (the same curve as the
  // glass pop morph). Frosted keeps the short slide and scale.
  const liquid = glass === "liquid";
  const hiddenTransform = reduced ? "none"
    : liquid ? "translateY(-8px) scale(0.88, 0.66)" : "translateY(-8px) scale(0.96)";
  const openTransition = reduced
    ? "opacity 160ms ease"
    : liquid
      ? "opacity 200ms ease, transform var(--aura-spring-bouncy-dur) var(--aura-spring-bouncy)"
      : "opacity 200ms ease, transform 240ms cubic-bezier(0.16, 1, 0.3, 1)";
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
      <div
        ref={pop.ref}
        className={`fixed z-[10041] w-[360px] max-w-[92vw] rounded-2xl p-5 overflow-y-auto ${
          overPlayer ? "aura-glass-player" : "aura-float-glass"}`}
        data-liquid={overPlayer ? "off" : undefined}
        // Liquid: no lens build until the pop settles (holdLensDuringPop; a lens
        // already built for its size binds from the first frame).
        data-lg-pop=""
        style={{
          top: anchor.top,
          ...horizontal,
          maxHeight: `calc(100vh - ${anchor.top + 16}px)`,
          transformOrigin,
          opacity: visible ? 1 : 0,
          // Click-through while it collapses, so the 200 ms exit never eats
          // the press on whatever sits under it.
          pointerEvents: visible ? undefined : "none",
          // Grow out of / collapse back into the party button corner.
          transform: visible ? "translateY(0) scale(1)" : hiddenTransform,
          transition: openTransition,
        }}
        role="dialog"
        aria-label="Watch Party"
      >
        {/* No close button, matching the notifications panel and the profile
            popover: all three dismiss on an outside click and on Escape, and a
            panel offering both plus an X offers three ways to do one thing.
            The title row is the player dialogs' (playerMenu.tsx): 16 px at
            full white over a hairline, bled to the card edges. */}
        <div className="-mx-5 -mt-1 px-5 pb-3 mb-4 border-b border-white/8">
          <h2 className="text-white text-[16px] font-semibold tracking-tight flex items-center gap-2">
            <PeopleGlyph /> Watch Party
          </h2>
        </div>

        {w.error && (
          <p className="text-rose-300/90 text-[12.5px] mb-3 leading-snug">{w.error}</p>
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
});

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
        <p className="text-white/60 text-[12.5px] leading-relaxed">
          Aura ships with a default relay, so you normally only need a room
          code. Point this at your own deployed Cloudflare Worker (see{" "}
          <span className="text-white/85">watch-relay/README.md</span>) if you
          would rather not use the shared one.
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
  // A code is joinable only at 4 to 16 chars (the relay's accepted shape):
  // gate the Join button so a too-short code can't hang on "connecting".
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

      <div className="flex items-center gap-3 text-white/55 text-[11px] font-semibold uppercase tracking-wider">
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
        <p className="text-white/55 text-[11.5px] leading-snug">4 to 16 letters or numbers.</p>
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
        className="text-white/55 hover:text-white/85 text-[12px] transition-colors"
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
          <p className="text-white/55 text-[11px] font-semibold uppercase tracking-wider">Room code</p>
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
        <p className="text-white/65 text-[13px] flex items-center gap-2">
          <Spinner /> Connecting…
        </p>
      ) : !roomVideoKey ? (
        <p className="text-white/65 text-[13px] leading-snug">
          {isLeader
            ? "You're the host. Play something and it becomes the party's title."
            : "Waiting for the host to start playing."}
        </p>
      ) : inSync ? (
        <div className="rounded-xl bg-emerald-400/[0.07] border border-emerald-400/20 px-3 py-2.5 space-y-1">
          <p className="text-emerald-300/90 text-[13px] flex items-center gap-2">
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
          <p className="text-amber-200/90 text-[12.5px] leading-snug">The party is watching:</p>
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
          className="aura-glass-flat w-full h-8 rounded-xl text-[12.5px] font-medium text-white/90
                     hover:text-white"
        >
          Clear party stream
        </button>
      )}

      {/* Members */}
      <div>
        <p className="text-white/55 text-[11px] font-semibold uppercase tracking-wider mb-1.5">
          In the room · {members.length}
        </p>
        <ul className="space-y-0.5">
          {members.map((m) => {
            const onTitle = roomVideoKey != null && m.videoKey === roomVideoKey;
            const isHost = m.id === leaderId;
            // Only offer the crown to a member who is ON the party title (or when
            // no party stream is established yet). Handing it to an off-title
            // member lets their first play/pause overwrite the party's stream
            // identity (broadcastControl owns=isLeader) and yank everyone to a
            // title nobody picked — a one-click accidental party hijack.
            const canTransfer = isLeader && !isHost && m.id !== selfId && (roomVideoKey == null || onTitle);
            return (
              <li
                key={m.id}
                className="aura-glass-row group flex items-center gap-2 text-[13.5px] rounded-xl px-2 py-1.5 -mx-2"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${onTitle ? "bg-emerald-400" : "bg-amber-400/70"}`}
                  title={onTitle ? "Watching the party title" : "On a different title"}
                />
                <span className="text-white/90 truncate flex items-center gap-1.5 min-w-0">
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
                      className="aura-glass-flat flex-shrink-0 hidden group-hover:inline-flex focus:inline-flex
                                 text-[11.5px] font-medium px-2 py-0.5 rounded-md text-white/85
                                 hover:text-white"
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
        <p className="text-white/90 text-[13px] font-medium leading-snug truncate">{title ?? detail?.name ?? "Untitled"}</p>
        {facts && <p className="text-white/60 text-[11.5px] leading-snug truncate">{facts}</p>}
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
        className="text-[10.5px] tabular-nums text-amber-300 flex-shrink-0 whitespace-nowrap"
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
      <span className="text-[10.5px] tabular-nums text-white/60">{stat.seconds.toFixed(0)}s</span>
    </span>
  );
}

// ── Bits ─────────────────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-white/55 text-[11px] font-semibold uppercase tracking-wider">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

// Glass classes carry the fill, border and hover (GLASS SYSTEM in App.css), so
// no bg / border utilities here: a direct one would override both materials.
const inputCls =
  "aura-glass-field w-full h-9 px-3 rounded-xl text-[13.5px] text-white/90 " +
  "placeholder:text-white/40 focus:outline-none";
const primaryBtn =
  "aura-glass-flat is-primary w-full h-9 rounded-xl text-[13.5px] font-medium " +
  "disabled:opacity-40 disabled:cursor-not-allowed";
const secondaryBtn =
  "aura-glass-flat px-3.5 h-9 rounded-xl text-[13.5px] font-medium text-white/90 " +
  "hover:text-white disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0";
const dangerBtn =
  "aura-glass-flat is-danger w-full h-9 rounded-xl text-[13.5px] font-medium";

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
