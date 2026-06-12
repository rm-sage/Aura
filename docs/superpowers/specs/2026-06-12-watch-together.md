# Watch-Together — synced playback rooms (v1: sync + presence)

Aura lets a small group watch the same title in lock-step. v1 scope (chosen by
the user): **synced play/pause/seek + presence** (a member list). No chat.

## Decisions (user, 2026-06-12)
- **Relay:** Cloudflare **Workers + Durable Objects** (serverless). Chosen over a
  VPS-port relay because it exposes **no origin IP / no inbound port**, has free
  `wss://` TLS + DDoS at the edge, and a Durable Object per room auto-scales to
  many independent parties. (A VPS-behind-Cloudflare-Tunnel and a LAN-only
  in-app relay were the runners-up.)
- **Scope:** sync + presence. (Chat deferred.)
- **Stream agreement (forced by the model):** debrid URLs are per-user/tokened,
  so peers do **not** share a stream URL. They share the **title** (`videoKey`);
  each peer resolves its own stream. Sync only engages when local `videoKey`
  matches the room's.

## Architecture

```
Aura A ──┐                         ┌── Aura B
         │   wss://…/room/<CODE>   │
         └──►  Cloudflare Worker  ◄─┘
               └─ Durable Object "Room<CODE>"  (holds the members' sockets,
                  broadcasts JSON frames, persists last playback state)
```

Tiny JSON frames only — never video, never the debrid URL, never an IP.

### Relay — `watch-relay/` (deploys separately, like a sidecar used to)
- `src/worker.js` — the Worker `fetch` (routes `/room/<CODE>` to a DO via
  `idFromName(code)`, optional `APP_TOKEN` gate) + the `Room` Durable Object
  using the **WebSocket Hibernation API** (`state.acceptWebSocket`,
  `webSocketMessage/Close/Error`). Member info rides in
  `ws.serializeAttachment`; the room's last playback state is in
  `state.storage`. The DO sleeps while a party is paused/idle.
- `wrangler.toml` — SQLite-backed DO (`new_sqlite_classes`), free-tier eligible.
- `README.md` — `npx wrangler deploy`, then paste the `wss://…workers.dev` URL
  into Aura → Watch Together.

### Client — `src/watchTogether/`
- `store.ts` — module-level pub/sub over one WebSocket. Owns config (relay URL /
  name / token in localStorage), the room lifecycle (create/join/leave +
  bounded auto-reconnect), the protocol, **title-gated** sync, leader-elected
  drift ticks, and a `PlaybackBridge` to read/drive local playback.
- `types.ts` — wire types (mirror the Worker).
- `useWatchTogether.ts` — reactive view of the store.
- `WatchTogetherPanel.tsx` — create/join, member list, sync status, relay config.

### App integration (`App.tsx`)
- Registers a `PlaybackBridge`: `getLocal()` reads refs
  (`wtTimeRef/wtPausedRef/wtTargetRef`); `apply()` seeks + toggles pause via the
  **raw** controls so applying a remote action never re-broadcasts.
- `wtTogglePause / wtSeekAbsolute / wtSeekRelative` wrap the raw control AND call
  `notifyLocalControl({paused,position})` with the **intended next state** (React
  refs lag the action). These wrapped controls are what the on-screen controls +
  the keybinding map call; **programmatic/internal pauses keep the raw controls**
  (no broadcast) — this split is the whole echo-loop defense.
- `notifyLocalVideo()` fires on `activeTarget?.id` change (presence + sync gate).
- The panel opens from PlayerOverlay's More menu (`aura:open-watch-together`).

## Sync protocol (frames)
- `welcome { selfId, serverNow, state, members }` — on join (late joiner gets the
  current state; `serverNow` calibrates the clock offset).
- `members { members }` — presence (name + each member's `videoKey`).
- `control { paused, position, videoKey, title, updatedAt, driverId }` — a user
  play/pause/seek; the DO persists it as room state + relays it.
- `tick { position, paused, driverId }` — the **leader** (lowest member id) emits
  every 4 s while playing the room title; followers re-seek only past a 1.5 s
  drift threshold.
- `video { videoKey, title }` — a member switched titles (presence).

## Echo-loop defense (the critical invariant)
Broadcasts happen **only** in the `wt*` wrapped handlers (user clicks/keys).
Applying a remote action uses the **raw** controls (no broadcast) + an
`applyingUntil` suppression window. So a remote pause → local raw pause → no
re-broadcast.

## Known v1 limits / deferred
- Two near-simultaneous controls can leave members paused a sub-second apart;
  resolved on the next play (which carries a position). Acceptable.
- No auto-open of the party's title — the panel shows what's playing; members
  open it themselves (auto-navigation deferred to avoid fragile metaId
  threading + DetailView navigation).
- No chat, no voice (scope = sync + presence).
- `APP_TOKEN` + room codes are the access control. Room members can drive each
  other's playback — that's the point of a watch party.

## v2 — top-level party (2026-06-12)

Promoted from a player-tucked panel to a first-class feature:

- **Top-level access** — a floating `PartyButton` (app shell, next to the
  account button, hidden during playback) shows party status (member count +
  live dot) on every home/browse menu and opens the panel. The player More-menu
  entry stays as the in-playback access (the top-level button is hidden then).
- **In-player presence** — `PlayerPartyHud` renders a presence cluster
  (top-right: member avatars + green/amber sync dots) + the staging banner.
- **Stream sharing** — the host's chosen stream is broadcast: the `control`
  frame / `RoomState` gained `metaId`, `mediaType`, `streamLabel`, `streamKey`
  (`streamMatch.ts`: key = info_hash/filename, label = addon · filename).
  Members get a one-tap **Join & sync** (`bridge.openVideo` → `setSelectedMeta`
  + `setOpenInStreamsMode`) landing on the title's stream picker, where the
  matching row is highlighted ("Party pick" — `DetailView` `partyStreamKey`
  threaded `UnifiedPanel → StreamsPanel → StreamRow`).
- **Wait-for-party staging** — when the host (the leader) starts a NEW party
  stream, `handlePlayStream` arms `wtPendingStageRef`; on `firstFrameSeen` an
  effect pauses the host + `startPartyStream()` (localStaging=true; broadcasts
  staging + the stream id). Members who Join become "ready" on becoming in-sync
  (snap to room state via `notifyLocalVideo`). It **auto-starts** once
  `everyoneReady()`, or the host hits **Start now** (`wtStartParty` → clear
  staging + unpause + broadcast play). Symmetric control is preserved; only the
  leader establishes/stages.

Store mechanics: `broadcastControl()` mirrors the sent state into the local
`ui.room*` (we never receive our own frames). New helpers: `startPartyStream`,
`amStagingHost`, `setLocalStaging`, `everyoneReady`, `readyCount`,
`openRoomVideo`. Relay carries the new fields (length-capped).

## v3 — Vote to Watch + leader-only delegation (2026-06-12)

- **Leader-only stream delegation.** Only the party LEADER (lowest member id)
  may establish or change the party stream now. `notifyLocalControl` gates on
  `isLeader || matches` (followers can still drive play/pause/seek on the shared
  title); `startPartyStream` requires `isLeader`. Client-advisory under the
  private room-code model (the relay does not enforce leadership for `control`
  frames — documented).

- **Vote to Watch.** Any member right-clicks a catalog item (every surface —
  home/library/queue/calendar/discover/catalog/search/hero — routes through
  App's `aura:card-context` menu) → "Vote to Watch" (shown only in a party).
  - ≤3 concurrent polls, 60 s each. Proposer auto-casts yes. **Unanimous yes**
    (every current roster member casts yes) WINS; any **no** fails; the TTL
    expires undecided. A 4th proposal → `vote-error` toast.
  - `PartyVotesOverlay` (app-level, right-edge stack): active polls (poster +
    Yes/No + a depleting 60 s countdown ring) and won polls (pinned,
    dismissable, click → the title's details via `aura:open-meta`) with a
    theme-accent (`--ln-accent`) color burst on win.
  - **Relay** (`watch-relay/worker.js`, the DO is authoritative): `vote-start` /
    `vote-cast` handlers; storage key `votes` (≤3, lazy TTL sweep); frames
    `votes` (full active list), `vote-won`, `vote-error`. Win/fail evaluated by
    **roster membership** (`roster.every(m => voters.includes(m.id))`), not a raw
    count, so join/leave can't false-win or deadlock. New joiners are **seeded**
    with the active votes on `welcome` (else their silent presence deadlocks
    unanimity — the key review-caught blocker). Empty-room storage is cleared.
  - Won votes are a NAVIGATION suggestion, not an auto-room-state change: the
    group picks the title, then the LEADER delegates the actual stream.

Wire types added (`types.ts`): `VotePoll` + `votes` / `vote-won` / `vote-error`
ServerMsg frames. Store: `activeVotes` / `wonVotes` / `voteError` + `startVote` /
`castVote` / `dismissWonVote` / `voteRemainingMs` / `haveVoted`. Client guards
(cap/dup/render) ignore client-expired-but-unswept polls.

## v4 — polish from user testing (2026-06-12)

- **Single vote winner.** Only one won-vote card is pinned at a time; a new
  winner overwrites the old (`vote-won` replaces `ui.wonVotes`).
- **Vote overlay suppressed** on detail pages + during playback (`suppressed`
  prop = `!!selectedMeta || isPlayerActive`) so it never overlaps the
  stream/episode selector or the player; moved to `right-5` to clear the
  scrollbar; the countdown tick pauses while hidden.
- **Staging reconnect fix.** A long idle WebSocket drop set `status="connecting"`
  (the banner is gated on `connected`, so it vanished) while the pause-gate read
  the still-true `ui.staging`. `ws.onclose` now clears `ui.staging`+`inSync`; on
  reconnect an owner-leader re-asserts its local state and `ingestRoomState`
  runs with `drive=false`, so a host who started playing during the drop isn't
  snapped back to the relay's stale paused snapshot (no leader-paused /
  party-playing desync, no stale re-block).
- **Live TV fully excluded.** `bridge.getLocal()` reports null identity for live
  (`media_type === "tv"` / `id.startsWith("iptv:")`); `establishingParty` gated
  on `!isLive`; and `notifyLocalControl`/`broadcastControl` short-circuit on a
  null local `videoKey` — closing the leak where a leader on live would
  resurrect the prior VOD party via the relay's `?? prev` fallback.
- **Leader clear-stream.** `clearPartyStream()` (leader-only) → relay
  `clear-stream` writes an explicit blank (bypassing `?? prev`), **server-
  enforced leader-only** (lowest member id). "Clear party stream" button in the
  panel. The next leader play re-establishes the stream.
- **Join/leave toasts** (`showAppToast`, diffed by stable id, never self/welcome).
  The "left" toast is DEFERRED 6 s and cancelled if the member returns, so a
  reconnect blip doesn't flash "left" → "joined" on bystanders.

## Not hardware/multi-client tested at build time — needs the relay deployed +
two clients to validate end-to-end. (v3/v4: REDEPLOY the relay — `cd watch-relay;
npx wrangler deploy` — for votes + stream-sharing + clear-stream to work.)
