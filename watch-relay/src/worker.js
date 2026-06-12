// Aura Watch-Together relay — Cloudflare Worker + Durable Object.
// © 2026 rm-sage. AGPL-3.0-or-later.
//
// A stateless message relay for Aura's Watch-Together rooms. Each room is a
// Durable Object instance (addressed by room code) that holds its members'
// WebSocket connections via the Hibernation API and broadcasts small JSON
// control/presence frames between them — it never sees video, only
// play/pause/seek/title state. One Worker handles unlimited independent
// rooms; the DO sleeps (hibernates) while a party is paused/idle.
//
// Deploy: see ../README.md (wrangler deploy). Aura connects to
//   wss://<your-worker-host>/room/<CODE>?name=<n>&video=<key>&t=<token>
//
// Optional access control: set an APP_TOKEN secret (wrangler secret put
// APP_TOKEN) and the same value in Aura's Watch-Together settings; the Worker
// then rejects any socket whose `t` query param doesn't match. Room codes are
// the primary gate — you need the code to address a room — but APP_TOKEN keeps
// randoms who find the open Worker URL from opening rooms at all.

/** @typedef {{ paused: boolean, position: number, videoKey: string|null,
 *             title: string|null, updatedAt: number, driverId: string|null }} RoomState */

const MAX_MEMBERS = 12; // a watch party, not a broadcast — keep rooms small

/** Coerce + length-cap a peer-supplied string (defence against a member
 *  flooding the room state / attachment with a huge or non-string value). */
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
const MAX_VIDEOKEY = 512;
const MAX_TITLE = 300;
const MAX_NAME = 40;

export default {
  /** @param {Request} request @param {{ ROOM: DurableObjectNamespace, APP_TOKEN?: string }} env */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("aura-watch-relay ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    // /room/<code> — tight match on the generated code shape (4-16 alnum).
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{4,16})$/);
    if (!m) return new Response("not found", { status: 404 });

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // Optional shared-token gate (only Aura clients that know APP_TOKEN connect).
    if (env.APP_TOKEN && url.searchParams.get("t") !== env.APP_TOKEN) {
      return new Response("unauthorized", { status: 401 });
    }

    const code = m[1].toUpperCase();
    const id = env.ROOM.idFromName(code);
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  },
};

export class Room {
  /** @param {DurableObjectState} state */
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);

    if (this.state.getWebSockets().length >= MAX_MEMBERS) {
      return new Response("room full", { status: 503 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Stable per-install id (cid) so a reconnect reclaims the same roster slot
    // + leader-election ordering; fall back to a random id if absent.
    const cid = (url.searchParams.get("cid") || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 16);
    const member = {
      id: cid || crypto.randomUUID().slice(0, 8),
      name: str(url.searchParams.get("name"), MAX_NAME) || "Guest",
      videoKey: str(url.searchParams.get("video"), MAX_VIDEOKEY),
    };
    // Attachment survives hibernation — the roster is rebuilt from live sockets.
    server.serializeAttachment(member);

    this.state.acceptWebSocket(server);

    // Hand the joiner the current playback state + roster, then tell the room.
    const stateNow = await this.loadState();
    server.send(JSON.stringify({
      t: "welcome",
      selfId: member.id,
      serverNow: Date.now(),
      state: stateNow,
      members: this.roster(),
    }));
    this.broadcastMembers();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** @param {WebSocket} ws @param {string|ArrayBuffer} raw */
  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return; // ignore malformed frames
    }
    const me = ws.deserializeAttachment() || {};

    // All peer input is length-capped/coerced; a malformed or oversized frame
    // degrades to a no-op instead of bloating storage or throwing in this
    // hibernatable handler.
    try {
      switch (msg.t) {
        case "hello": {
          // Update name / current video, then refresh the roster for everyone.
          if (typeof msg.name === "string") me.name = str(msg.name, MAX_NAME) || me.name;
          if ("videoKey" in msg) me.videoKey = str(msg.videoKey, MAX_VIDEOKEY);
          ws.serializeAttachment(me);
          this.broadcastMembers();
          break;
        }
        case "control": {
          // A user play/pause/seek. Drop frames with a non-finite position
          // (a garbage position would yank every viewer to 0).
          const pos = Number(msg.position);
          if (!Number.isFinite(pos)) break;
          const next = {
            paused: !!msg.paused,
            position: pos,
            videoKey: str(msg.videoKey, MAX_VIDEOKEY) ?? me.videoKey ?? null,
            title: str(msg.title, MAX_TITLE),
            updatedAt: Date.now(),
            driverId: me.id ?? null,
          };
          await this.saveState(next);
          this.broadcast({ t: "control", ...next }, ws);
          break;
        }
        case "tick": {
          const pos = Number(msg.position);
          if (!Number.isFinite(pos)) break;
          // Leader drift correction — relay only (no persistence needed).
          this.broadcast({ t: "tick", position: pos, paused: !!msg.paused, driverId: me.id }, ws);
          break;
        }
        case "video": {
          // A member switched what they're watching.
          me.videoKey = str(msg.videoKey, MAX_VIDEOKEY);
          ws.serializeAttachment(me);
          this.broadcast(
            { t: "video", from: me.id, videoKey: me.videoKey, title: str(msg.title, MAX_TITLE) },
            ws,
          );
          this.broadcastMembers();
          break;
        }
        default:
          break;
      }
    } catch {
      /* malformed/oversized frame — ignore, keep the room alive */
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* already closing */ }
    this.broadcastMembers();
  }

  async webSocketError(ws) {
    this.broadcastMembers();
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  roster() {
    // getWebSockets() can still include a socket in the CLOSING state (even
    // after ws.close()), so a member that just left would otherwise linger as
    // a ghost in everyone's roster — and could keep being elected leader,
    // silently stalling drift correction. Filter to OPEN (readyState === 1).
    return this.state.getWebSockets()
      .filter((s) => s.readyState === 1)
      .map((s) => {
        const a = s.deserializeAttachment() || {};
        return { id: a.id, name: a.name, videoKey: a.videoKey ?? null };
      });
  }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const s of this.state.getWebSockets()) {
      if (s === except) continue;
      try { s.send(data); } catch { /* socket gone — close handler cleans up */ }
    }
  }

  broadcastMembers() {
    this.broadcast({ t: "members", members: this.roster() });
  }

  /** @returns {Promise<RoomState>} */
  async loadState() {
    const s = await this.state.storage.get("state");
    return s || { paused: true, position: 0, videoKey: null, title: null, updatedAt: Date.now(), driverId: null };
  }

  /** @param {RoomState} s */
  async saveState(s) {
    await this.state.storage.put("state", s);
  }
}
