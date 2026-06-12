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

## Not hardware/multi-client tested at build time — needs the relay deployed +
two clients to validate end-to-end.
