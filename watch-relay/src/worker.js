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
// Cap the persisted join-order list so a high-churn room (many different cids
// cycling through) can't grow storage unbounded. Pruned to currently-open
// members + the explicit leader when exceeded.
const MAX_ORDER = 64;

/** Coerce + length-cap a peer-supplied string (defence against a member
 *  flooding the room state / attachment with a huge or non-string value). */
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
/** Coerce a peer-supplied playback speed to a sane multiplier (0.25x–4x).
 *  Falls back to `prev` (then 1) so a missing/garbage value never desyncs the
 *  room or strands followers at the wrong speed. */
const speedOf = (v, prev) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0.25 && n <= 4 ? n : (typeof prev === "number" ? prev : 1);
};
const MAX_VIDEOKEY = 512;
const MAX_TITLE = 300;
const MAX_NAME = 40;
const MAX_POSTER = 1024;

// "Vote to Watch": at most MAX_VOTES concurrent polls, each living VOTE_TTL_MS.
// A poll WINS on unanimous yes (every current member has cast yes), FAILS on
// any no, and EXPIRES after the TTL with no decision. The relay is the
// authority for the tally; clients only render + cast.
const MAX_VOTES = 3;
const VOTE_TTL_MS = 60 * 1000;

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
    // Leader bookkeeping, lazily loaded from storage (survives hibernation).
    //   order    — cids in join order (append-only); the auto-handoff fallback.
    //   leaderId — the explicit current-leader cid (creator → transfer → bye-handoff).
    /** @type {{ order: string[], leaderId: string|null } | null} */
    this.meta = null;
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    await this.ensureMeta();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // A `join`-intent connect to a room NObody is currently hosting must NOT
    // auto-create — tell the client so it can offer "create it instead". Accept
    // the socket transiently OUTSIDE the hibernation roster (server.accept, not
    // state.acceptWebSocket) so there are zero side effects (no roster slot, no
    // webSocketClose, no state/meta mutation), deliver the frame, and close.
    // A missing intent (old client) keeps the legacy auto-create behaviour.
    const openCount = this.state.getWebSockets().filter((s) => s.readyState === 1).length;
    if (url.searchParams.get("intent") === "join" && openCount === 0) {
      const codeMatch = url.pathname.match(/\/room\/([A-Za-z0-9]{4,16})/);
      server.accept();
      // Belt: send a frame for clients that read it. Suspenders: close with the
      // app code 4404 — the frame might not flush before close, but the close
      // CODE always reaches the browser's onclose (event.code), so the client
      // reliably distinguishes "nobody hosting this code" from a transport drop
      // (1006) without depending on frame delivery.
      try { server.send(JSON.stringify({ t: "room-not-found", code: codeMatch ? codeMatch[1].toUpperCase() : "" })); } catch { /* closing */ }
      try { server.close(4404, "room not found"); } catch { /* already closing */ }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (this.state.getWebSockets().length >= MAX_MEMBERS) {
      return new Response("room full", { status: 503 });
    }

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

    // Track join order (append-only) and seed the creator as the first leader.
    if (!this.meta.order.includes(member.id)) {
      this.meta.order.push(member.id);
      // GC only ever needs ONE pass: the filtered set is (open members + the
      // leader), and MAX_MEMBERS=12 caps concurrent open sockets — so the result
      // is ≤13 entries, always well under MAX_ORDER. No re-check loop needed.
      if (this.meta.order.length > MAX_ORDER) {
        const open = new Set(this.roster().map((m) => m.id));
        this.meta.order = this.meta.order.filter((c) => open.has(c) || c === this.meta.leaderId);
      }
    }
    if (!this.meta.leaderId) this.meta.leaderId = member.id; // first member into an empty room = host
    await this.saveMeta();

    // Hand the joiner the current playback state + roster, then tell the room.
    const stateNow = await this.loadState();
    server.send(JSON.stringify({
      t: "welcome",
      selfId: member.id,
      serverNow: Date.now(),
      state: stateNow,
      members: this.roster(),
      leaderId: this.effectiveLeader(),
    }));
    // Seed the joiner with any open votes — without this they can't see or cast,
    // and (since unanimity counts the whole roster) their silent presence would
    // deadlock every pending poll until the 60 s TTL.
    const votesNow = await this.getVotes();
    if (votesNow.length > 0) {
      server.send(JSON.stringify({ t: "votes", votes: votesNow }));
    }
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
    await this.ensureMeta(); // leader gating + transfer need the meta loaded

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
          // ONLY the leader drives the party's playback (play/pause/seek and
          // the stream identity). A non-leader control frame is dropped — the
          // server-authoritative half of "leader controls playback".
          if (!this.isLeader(me.id)) break;
          // A user play/pause/seek. Drop frames with a non-finite position
          // (a garbage position would yank every viewer to 0).
          const pos = Number(msg.position);
          if (!Number.isFinite(pos)) break;
          // The stream IDENTITY (which title + which stream pick) belongs to
          // whoever established the party stream. The client already re-sends it
          // verbatim from non-owners, but fall back to the stored state here too
          // so a frame that omits identity (an old/minimal client) can't null
          // out the party's stream pick for everyone.
          const prev = await this.loadState();
          const next = {
            paused: !!msg.paused,
            position: pos,
            speed: speedOf(msg.speed, prev.speed),
            videoKey: str(msg.videoKey, MAX_VIDEOKEY) ?? me.videoKey ?? prev.videoKey ?? null,
            metaId: str(msg.metaId, MAX_VIDEOKEY) ?? prev.metaId ?? null,
            mediaType: str(msg.mediaType, 32) ?? prev.mediaType ?? null,
            title: str(msg.title, MAX_TITLE) ?? prev.title ?? null,
            streamLabel: str(msg.streamLabel, MAX_TITLE) ?? prev.streamLabel ?? null,
            streamKey: str(msg.streamKey, MAX_VIDEOKEY) ?? prev.streamKey ?? null,
            staging: !!msg.staging,
            updatedAt: Date.now(),
            driverId: me.id ?? null,
          };
          await this.saveState(next);
          this.broadcast({ t: "control", ...next }, ws);
          break;
        }
        case "tick": {
          if (!this.isLeader(me.id)) break; // drift ticks come from the leader only
          const pos = Number(msg.position);
          if (!Number.isFinite(pos)) break;
          // Leader drift correction — relay only (no persistence needed).
          this.broadcast({ t: "tick", position: pos, paused: !!msg.paused, speed: speedOf(msg.speed, 1), driverId: me.id }, ws);
          break;
        }
        case "clear-stream": {
          // Leader-only, server-enforced (a destructive room-wide reset). The
          // leader is the lowest member id — the same rule the client uses.
          if (!this.isLeader(me.id)) break;
          // Leader resets the party stream to blank so the next leader play
          // re-establishes it. Written EXPLICITLY (not via the control case,
          // whose `?? prev` fallback would resurrect the old identity).
          const blank = {
            paused: true, position: 0, speed: 1, videoKey: null, metaId: null, mediaType: null,
            title: null, streamLabel: null, streamKey: null, staging: false,
            updatedAt: Date.now(), driverId: me.id ?? null,
          };
          await this.saveState(blank);
          this.broadcast({ t: "control", ...blank }, ws);
          break;
        }
        case "set-leader": {
          // Manual transfer — only the current leader may hand the crown to
          // another CONNECTED member.
          if (!this.isLeader(me.id)) break;
          const target = (str(msg.target, 16) || "").replace(/[^A-Za-z0-9]/g, "");
          const open = new Set(this.roster().map((m) => m.id));
          if (!target || !open.has(target)) break;
          this.meta.leaderId = target;
          await this.saveMeta();
          this.broadcastMembers(); // carries the new leaderId to everyone
          break;
        }
        case "bye": {
          // Graceful leave: if the leader is leaving, hand off PERMANENTLY to the
          // longest-present remaining member before their socket drops (so a
          // deliberate Leave is a one-way handoff, unlike a transient drop). The
          // socket close follows and re-broadcasts the roster.
          if (this.isLeader(me.id)) {
            const open = this.roster().map((m) => m.id);
            const next = this.meta.order.find((c) => c !== me.id && open.includes(c))
              ?? open.find((c) => c !== me.id) ?? null;
            this.meta.leaderId = next;
            await this.saveMeta();
            this.broadcastMembers();
          }
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
        case "stat": {
          // A member's buffer telemetry — validated/capped then forwarded to the
          // OTHER peers (no persistence, no roster rebuild) for the per-member
          // buffer readout. Numeric caps guard against a garbage/malicious payload.
          if (!me.id) break;
          const pct = (typeof msg.pct === "number" && Number.isFinite(msg.pct))
            ? Math.max(0, Math.min(100, msg.pct)) : null;
          const seconds = (typeof msg.seconds === "number" && Number.isFinite(msg.seconds))
            ? Math.max(0, Math.min(86_400, msg.seconds)) : null;
          this.broadcast({ t: "stat", from: me.id, pct, seconds, stalled: !!msg.stalled }, ws);
          break;
        }
        case "vote-start": {
          // Any member proposes a title; the proposer auto-casts yes.
          if (!me.id) break; // no stable id ⇒ can't dedup a voter; reject
          const metaId = str(msg.metaId, MAX_VIDEOKEY);
          if (!metaId) break;
          const votes = await this.getVotes();
          if (votes.length >= MAX_VOTES) {
            ws.send(JSON.stringify({ t: "vote-error", reason: `Only ${MAX_VOTES} votes can run at once.` }));
            break;
          }
          if (votes.some((v) => v.metaId === metaId)) {
            ws.send(JSON.stringify({ t: "vote-error", reason: "There's already a vote for that title." }));
            break;
          }
          const now = Date.now();
          const vote = {
            id: `${me.id || "?"}-${now}-${Math.floor(Math.random() * 1e6)}`,
            metaId,
            mediaType: str(msg.mediaType, 32),
            title: str(msg.title, MAX_TITLE) || "Untitled",
            poster: str(msg.poster, MAX_POSTER),
            proposedBy: me.id || "?",
            proposedByName: me.name || "Someone",
            startedAt: now,
            expiresAt: now + VOTE_TTL_MS,
            yes: 1,
            no: 0,
            voters: [me.id || "?"], // proposer auto-yes
          };
          votes.push(vote);
          await this.resolveAndBroadcast(votes, vote); // solo party → instant win
          break;
        }
        case "vote-cast": {
          if (!me.id) break;
          const voteId = str(msg.voteId, 128);
          const choice = msg.choice === "no" ? "no" : "yes";
          const votes = await this.getVotes();
          const vote = votes.find((v) => v.id === voteId);
          if (!vote) break;
          if (vote.voters.includes(me.id)) break; // one vote per member
          vote.voters.push(me.id);
          if (choice === "yes") vote.yes += 1; else vote.no += 1;
          await this.resolveAndBroadcast(votes, vote);
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
    await this.ensureMeta();
    try { ws.close(); } catch { /* already closing */ }
    // effectiveLeader() recomputes here: a departed leader (graceful bye already
    // moved leaderId; an ungraceful drop falls through to the longest-present
    // remaining member) is reflected in the leaderId this carries.
    this.broadcastMembers();
    // A departure can complete a pending vote (the lone hold-out left). Await it
    // so the read-modify-write finishes inside this event's input gate.
    try { await this.reevaluateVotes(); } catch { /* keep the room alive */ }
    // Last member out — drop the room's persisted blobs so an abandoned code
    // doesn't leave storage resident forever.
    if (this.roster().length === 0) {
      try { await this.state.storage.delete(["state", "votes", "meta"]); } catch { /* ignore */ }
      this.meta = { order: [], leaderId: null };
    }
  }

  async webSocketError(ws) {
    await this.ensureMeta();
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
    this.broadcast({ t: "members", members: this.roster(), leaderId: this.effectiveLeader() });
  }

  /** Lazy-load the leader bookkeeping (survives hibernation; a fresh DO
   *  instance after wake has this.meta === null until first touched). */
  async ensureMeta() {
    if (!this.meta) {
      this.meta = (await this.state.storage.get("meta")) || { order: [], leaderId: null };
    }
    return this.meta;
  }

  async saveMeta() {
    if (this.meta) await this.state.storage.put("meta", this.meta);
  }

  /** The room's current leader. The explicit leaderId (creator → manual
   *  transfer → graceful-leave handoff) wins while that member is connected;
   *  otherwise the longest-present remaining member (first open cid in join
   *  order) — which preserves reconnect behaviour (a cid is stable, so a
   *  blipped leader reclaims the crown on return). Assumes ensureMeta() ran. */
  effectiveLeader() {
    const meta = this.meta || { order: [], leaderId: null };
    const open = new Set(this.roster().map((m) => m.id));
    if (meta.leaderId && open.has(meta.leaderId)) return meta.leaderId;
    for (const cid of meta.order) if (open.has(cid)) return cid;
    const first = this.roster()[0];
    return first ? first.id : null;
  }

  isLeader(id) {
    return typeof id === "string" && id === this.effectiveLeader();
  }

  /** @returns {Promise<RoomState>} */
  async loadState() {
    const s = await this.state.storage.get("state");
    return s || {
      paused: true, position: 0, speed: 1, videoKey: null, metaId: null, mediaType: null,
      title: null, streamLabel: null, streamKey: null, staging: false,
      updatedAt: Date.now(), driverId: null,
    };
  }

  /** @param {RoomState} s */
  async saveState(s) {
    await this.state.storage.put("state", s);
  }

  // ── Vote to Watch ──────────────────────────────────────────────────────────

  /** Load active votes, sweeping any past their deadline (lazy expiry — the
   *  client also hides them visually at the deadline, so a quiet room doesn't
   *  need a DO alarm; the next message reconciles storage). */
  async getVotes() {
    const votes = (await this.state.storage.get("votes")) || [];
    const now = Date.now();
    const live = votes.filter((v) => v.expiresAt > now);
    if (live.length !== votes.length) await this.state.storage.put("votes", live);
    return live;
  }

  async saveVotes(votes) {
    await this.state.storage.put("votes", votes);
  }

  /** Persist + broadcast the active-vote list after a cast. If the vote is now
   *  decided — unanimous yes (every CURRENT member has cast) wins, any no fails
   *  — drop it from the active list and (on a win) fire vote-won so every
   *  client persists a dismissable winner card. Evaluating by roster membership
   *  (not a raw yes count) keeps "unanimous" correct when a member leaves. */
  async resolveAndBroadcast(votes, vote) {
    const roster = this.roster();
    const failed = vote.no > 0;
    const won = !failed && roster.length > 0 && roster.every((m) => vote.voters.includes(m.id));
    if (failed || won) {
      const next = votes.filter((v) => v.id !== vote.id);
      await this.saveVotes(next);
      if (won) this.broadcast({ t: "vote-won", vote });
      this.broadcast({ t: "votes", votes: next });
    } else {
      await this.saveVotes(votes);
      this.broadcast({ t: "votes", votes });
    }
  }

  /** A member leaving can make a pending vote unanimous (the only non-yes
   *  member is gone). Re-check on disconnect. */
  async reevaluateVotes() {
    const votes = await this.getVotes();
    if (votes.length === 0) return;
    const roster = this.roster();
    const won = [];
    const remaining = [];
    for (const v of votes) {
      if (v.no === 0 && roster.length > 0 && roster.every((m) => v.voters.includes(m.id))) won.push(v);
      else remaining.push(v);
    }
    if (won.length === 0) return;
    await this.saveVotes(remaining);
    for (const v of won) this.broadcast({ t: "vote-won", vote: v });
    this.broadcast({ t: "votes", votes: remaining });
  }
}
