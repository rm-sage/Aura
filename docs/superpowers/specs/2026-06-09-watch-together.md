# Watch Together (relay rooms + party-leader sync + ready-check) — the reference implementation → Aura port

> **Effort:** XL — relay server + WS client with reconnect machinery + React context + 2 overlays + TitleBar entry + player-sync glue against Aura's event-driven (not poll-driven) playback + optional Cloudflare self-deploy; touches the 5,881-line App.tsx, PlayerOverlay, TitleBar, settings, Rust commands, and the 3-place permission ledger.  
> **Quick-win:** Yes — the relay worker.js is a genuine quick win: a stripped port (rooms + leader-authority handleState/handleCommand + ready-check + ping; drop proxy/cursor/draw/summon/presence) is fully self-contained, has zero dependency on Aura's codebase, and can be written and tested in isolation (wscat/browser console against /r/TEST) to prove the whole sync protocol before any Aura UI exists. Caveat: deploying it needs a Cloudflare account (free-tier Workers + Durable Objects), so it's 'writable now, deployable once the user authorizes a CF account.' A second no-infra quick win: src/together/protocol.ts + colors.ts + the auraSettings.ts togetherRelayUrl field are pure, dependency-free, tsc-checkable additions that can land immediately.  
> **Decisions needed (see end):** 7

# Watch Together — the reference implementation → Aura Porting Spec

Bring the reference implementation's "Watch Together via the reference implementation Relay" into Aura as a greenfield feature, scoped to the four things the user asked for: (1) relay rooms with a "paste a link" entry point near the window controls, (2) a **Party Leader** authority where only the leader broadcasts play/pause/seek, (3) a nickname prompt on join saved locally, (4) a leader-initiated **ready check**. the reference implementation's larger surface (shared cursors, drawing, summon, presence-location, chat, profiles/avatars, Chromecast sync) is explicitly **out of scope** — keep the protocol open so chat could be added later, but do not port those subsystems.

---

## 1. What the reference implementation does (architecture + key files)

### Transport: Cloudflare Worker + Durable Object, WebSocket
- **Relay server** is a single Cloudflare Worker script (`src-tauri/relay/worker.js`, 487 lines, `WORKER_VERSION = 9`). It is `include_str!`-embedded into the Rust binary by `cf_relay.rs`. The Worker:
  - Serves `GET /` and `GET /health` → JSON `{ ok, version, hosts }`.
  - Has a `/proxy` endpoint (torrent-tracker/Cinemeta CORS proxy) — **Aura does NOT need this; drop it entirely** (Aura is addon+Debrid, has its own `:11471` bridge, and a host-allowlist proxy is reference-torrent-specific).
  - WebSocket upgrade on `GET /r/:ROOMCODE` (`ALLOWED_PATH = /^\/r\/([A-Z0-9]{4,8})$/`). Routes to a **Durable Object** `Room` keyed by `env.ROOM.idFromName(roomCode)` — so all peers with the same 6-char code land in the same DO instance (one authoritative in-memory room).
- **`Room` Durable Object** (worker.js:130-487) is the actual sync engine. It holds `peers: Map<WebSocket, peer>`, `syncState`, `hostClientId`, `started`, `lastActivity`. Key handlers:
  - `handleHello` — registers peer, **assigns host to first joiner** (`becameHost = !this.hostClientId`), replies `joined` with full participant list + current `syncState` + `hostClientId` + `started` + `srvAt` (server clock for offset estimation), broadcasts `participant-joined`.
  - `handleState` (worker.js:401-424) — **THE leader-authority gate**: validates the state shape, then `if (this.hostClientId != null && !isHostWrite) return;` — only the host's `state` is accepted/rebroadcast. (Non-host writes are rate-limited+staleness-gated as a fallback when there's no host, but with a host present they're dropped.)
  - `handleCommand` (worker.js:426-439) — guest→host command relay. `if (!this.hostClientId || peer.clientId === this.hostClientId) return;` then forwards the `cmd` **only to the host socket**. The host's client applies it to its own player and the resulting `state` re-broadcasts to everyone. This is how a passive guest can never directly move other peers — only the leader's player is authoritative.
  - `handleReady` — sets `peer.ready`, broadcasts `participant-ready`.
  - `handleStart` — `if hostClientId !== peer.clientId return;` else `started = true`, broadcast `started`. Host-only.
  - `handleClaimHost` — lets a client (re)assert host; `fresh:true` resets `started` + everyone's ready (used when the leader picks a new title).
  - `reassignHost` / `handleLeave` / `onClose` — host migration to earliest `joinedAt` peer when the host drops.
  - `ping`→`pong{srvAt}` for clock-offset (RTT/2) estimation.

### Rust backend: `src-tauri/src/cf_relay.rs` (252 lines)
Four `#[tauri::command]`s that let a user **deploy their own relay** to their own Cloudflare account with one click (so there's no central server the reference implementation must pay for):
- `cf_list_accounts(api_token)` → lists CF accounts.
- `cf_deploy_relay(api_token, account_id)` → ensures workers.dev subdomain, PUTs the worker script (multipart: metadata + worker.js) with Durable Object migration `new_sqlite_classes: ["Room"]`, retries on namespace-propagation (error 10065) with backoff, enables the subdomain route. Returns `wss://<your-relay-host>.<subdomain>.workers.dev`.
- `cf_delete_relay`, `cf_relay_status`.
The relay URL is then stored in settings (`settings.togetherRelayUrl`) and shared with friends via invite link.

### Frontend (`src/lib/together/` + `src/components/together-modal*`)
- **`protocol.ts`** — all message types. `ClientMessage` / `ServerMessage` discriminated unions, `SyncState`, `RoomCommand = {action:"play"|"pause"|"seek"; positionSeconds?}`, `Participant {id,name,joinedAt,ready,...}`, room-code alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, no ambiguous chars), `generateRoomCode()` (crypto-random 6 chars), `normalizeRoomCode()`.
- **`client.ts`** (738 lines) — `TogetherClient`: the WebSocket lifecycle manager. Connect/reconnect with exponential backoff+jitter, connect-watchdog (10 s), liveness ping (25 s)/timeout (40 s), out-queue that survives reconnect, name-collision auto-rename (`Name (2)`), server-clock localization (`relayOffset`), terminal-failure detection that probes `/health` to produce a useful error. Emits `RoomEvent`s to listeners. Public API: `join`, `leave`, `retry`, `publishState`, `sendCommand`, `markReady`, `claimHost`, `startRoom`, `setName`, `suppressOutgoingFor`.
- **`provider.tsx`** (577 lines) — `TogetherProvider` React context. Owns the singleton `TogetherClient` (recreated when `relayUrl` changes), persists `clientId` (`aura.together.clientId`) and `name` (`aura.together.name`) in localStorage, exposes `useTogether()`. Parses invite links from the launch URL (`?aura-relay=…&aura-room=…`) and auto-joins.
- **`invite.ts` / `build-invite.ts`** — invite-link build/parse (`aura-relay`, `aura-room` query params), and `buildPlayInvite(meta, episode)`.
- **UI**: `chrome/topbar.tsx` `TogetherButton` (the **"Friends" button** — a `Users` lucide icon next to the window controls; opens a popover) + `components/together-modal.tsx` `TogetherPopover` (start/join, room code, nickname input, participant list, chat, leave). `views/player.tsx` computes `isHost = roomSnapshot.hostClientId === clientId`, `everyoneReady`, `roomFull`; `views/player/hooks/use-room-sync.ts` is the **client-side sync brain** (host heartbeat publishes `state` every `HOST_HEARTBEAT_MS`; host applies incoming `cmd`; guests reconcile to incoming `state` with drift-tolerance/lookahead/catch-up); `views/player/waiting-for-room.tsx` is the **ready-check lobby overlay** ("Waiting for everyone", per-participant ready chips, host "Start anyway").

### Data-flow summary (leader authority)
```
Guest clicks play in their UI ──(blocked locally if guest)──> sendCommand({action:"play"})
  → relay forwards cmd ONLY to host socket
  → host's use-room-sync applies b.play() to host's own MPV
  → host heartbeat publishes state{playing:true,positionSeconds}
  → relay validates host-write, rebroadcasts state to all
  → each guest's use-room-sync reconciles its MPV to that state
```

---

## 2. Aura mapping (exact files to create/modify)

Aura's architecture is near-identical (Tauri 2 + React 19 + Rust + libmpv), so the protocol/client/provider port almost verbatim. Differences: Aura has no `src/lib/` settings context — it uses `auraSettings.ts` (localStorage + `aura:settings-changed` event) and a backend `settings.json`; the chrome is the custom Win32 `TitleBar.tsx`; the player is `PlayerOverlay.tsx` driven by `App.tsx` state, not a `views/player.tsx`.

### New files (frontend)
- `src/together/protocol.ts` — port of the reference implementation `protocol.ts`, **trimmed** to the in-scope message set (drop cursor/draw/summon/presence-location; KEEP chat in the union as inert future-proofing but don't wire UI). Rename ids: `RoomCode`, `SyncState`, `RoomCommand`, `Participant`, `ClientMessage`, `ServerMessage`, `generateRoomCode`, `normalizeRoomCode`.
- `src/together/client.ts` — port of `TogetherClient` (keep reconnect/watchdog/ping/clock-offset/out-queue/name-collision; **delete** `sendCursor`/`sendDraw`/`sendPresence`/`sendSummon` and their server cases).
- `src/together/TogetherProvider.tsx` — port of `provider.tsx`. localStorage keys → `aura:together:clientId`, `aura:together:nickname`. Relay URL read from `auraSettings` (new field `togetherRelayUrl`) NOT a settings context. Drop avatar/color/profiles (`use-self-identity` → a tiny `nameColor(name)` only, ported from `colors.ts`). Expose `useTogether()`.
- `src/together/invite.ts` — port; query params `aura-relay`, `aura-room`. **See Decision D5** — Aura is a desktop app launched via OS, not a URL; the "paste a link" entry parses a pasted string (the modal already does this in the reference implementation via `handleJoin`), so deep-link-on-launch is optional.
- `src/together/buildInvite.ts` — `buildPlayInvite(meta, episode)` adapted to Aura's `MetaDetail` / `ActiveScrobbleTarget` (see §3).
- `src/together/colors.ts` — `nameColor()` (3 lines, verbatim) for participant chip tinting.
- `src/WatchTogetherButton.tsx` — the **"Friends" entry point**. A `Users`-style glyph button rendered inside `TitleBar.tsx`'s window-controls cluster (`data-no-drag`), opening the modal. Live state (in-room) shows a small participant count / pulsing dot.
- `src/WatchTogetherModal.tsx` — port of `TogetherPopover`, trimmed: nickname field, Start room / Join (code or pasted link), room code + copy, participant list with ready/leader badges, **leader-only "Ready check" button**, Leave. (No chat UI in v1 unless D6 says otherwise.)
- `src/WatchTogetherLobby.tsx` — port of `waiting-for-room.tsx`: the ready-check overlay shown over the player. Leader sees per-participant ready chips + "Start anyway"; guests see "Waiting for host" + **Ready / Not Ready** buttons (the user's explicit requirement — guests answer the check; the initiator is auto-ready).
- `src/useRoomSync.ts` — port of `use-room-sync.ts`, adapted to Aura's player surface (see §3). The single most adaptation-heavy file.

### New files (Rust) — only if D1 = "offer self-deploy"
- `src-tauri/src/cf_relay.rs` — port of the reference implementation's, **dropping the `/proxy` host-allowlist** from the worker. Uses `reqwest` (already a dep — `Cargo.toml:25`).
- `src-tauri/relay/worker.js` — port, **stripped**: remove `handleProxy`/`PROXY_HOSTS`/`RATE_BUCKET`-for-proxy, remove cursor/draw/summon/presence handlers. Keep hello/profile(→rename only)/leave/state/cmd/ready/host-leaving/claim-host/start/ping. Rename `SCRIPT_NAME = "aura-together-relay"`.

### Modified files
- `src/auraSettings.ts` — add `togetherRelayUrl: string | null` to `AuraSettings`, `DEFAULT_AURA_SETTINGS`, and the `readFromStorage` validator (string-or-null guard). This is the **local persistence for the relay URL** (D1).
- `src/TitleBar.tsx` — insert `<WatchTogetherButton />` into the `data-no-drag` window-controls cluster (around line 165, left of Minimize). Must be `pointer-events:auto` and NOT inside the drag layer (landmine #7 — never rely on `data-tauri-drag-region`; the button uses normal onClick).
- `src/App.tsx` — (a) wrap the app tree in `<TogetherProvider>`; (b) mount `<WatchTogetherModal />` + `<WatchTogetherLobby />`; (c) wire `useRoomSync` to the existing `time`/`duration`/`paused` state (App.tsx:457-459) and the `togglePause`/`seekRelative`/`seekAbsolute` handlers it already passes to `PlayerOverlay`; (d) when a leader starts/changes playback, call `publishState` with the `ActiveScrobbleTarget` identity; (e) auto-open the picker/playback when a guest is pulled to the leader's media. Provide `isHost`, `inRoom` to PlayerOverlay so guest controls can be visually gated.
- `src/PlayerOverlay.tsx` — gate the transport controls for **passive guests**: when `inRoom && !isHost`, the play/pause + seek buttons send a `RoomCommand` via context (`sendCommand`) instead of calling the local handler directly, OR are disabled (Decision D3). Add a small "leader" / "watching <Leader>" indicator in the top action bar (offset 36 px in windowed mode per landmine #6).
- `src/views/SettingsView.tsx` — a "Watch Together" section: relay URL field (paste a friend's `wss://…`), and if D1 includes self-deploy, the Cloudflare token → deploy/delete/status flow (port of the reference implementation `relay-panel.tsx`).
- `src-tauri/src/lib.rs` — register the 4 `cf_*` commands in `generate_handler!` (only if D1 includes self-deploy).
- `src-tauri/permissions/player.toml` — add the 4 `cf_*` commands to `commands.allow` (the 3-place registration; skipping this silently 401s).
- `src-tauri/capabilities/default.json` — add the 4 `cf_*` commands.
- `src-tauri/Cargo.toml` — `reqwest` already present with `json`+`rustls-tls`; `multipart` feature must be added for `cf_deploy_relay` (the reference implementation uses `reqwest::multipart`). Verify/append `"multipart"` to reqwest features.

### Conventions to follow
- Rust log label: add `[together]` to the documented label set; use `crate::devlog!(info, "together", …)`.
- serde: any struct flowing Rust→React (e.g. `CfAccount`, `DeployResult`) uses `#[serde(rename(deserialize = "..."))]` only if wire names differ — `DeployResult` here uses snake_case already, fine.
- WebSocket runs **entirely in the webview** (browser `WebSocket` to `wss://…`), so it does **not** touch the `:11471` bridge and is unaffected by the HTTPS-bypass rule. No Rust WS server needed — the relay is remote. (Confirmed: the reference implementation's client.ts uses the browser `WebSocket` global.)
- Tailwind opacity: any `bg-*/NN` must be a real scale step or extended in `tailwind.config.ts` (landmine — `/72`, `/12`, `/97` silently emit nothing). the reference implementation's lobby uses `bg-black/72` → that step is not default; use `bg-black/70` or extend.

---

## 3. Ports 1:1 vs needs-adaptation

### Ports ~1:1 (copy + rename)
- `protocol.ts` (trim message variants), `colors.ts`, `invite.ts` (rename params), `generateRoomCode`/`normalizeRoomCode`.
- `client.ts` `TogetherClient` — the WS lifecycle is environment-agnostic; only delete the out-of-scope `send*` methods + server cases. Reconnect/watchdog/clock-offset logic ports verbatim.
- `cf_relay.rs` + `worker.js` deploy machinery (if D1) — verbatim minus the proxy.
- The **leader-authority gate** in the worker (`handleState` host-only + `handleCommand` guest→host relay) — port verbatim. This IS the user's "only the leader can send play/pause/seek" requirement, implemented server-side so it can't be bypassed by a hacked client.
- The **ready-check** protocol (`ready` / `participant-ready` / `start` / `started` / `claim-host{fresh}`) — port verbatim. Matches the user's spec exactly: leader starts the check (`claimHost(true)` resets everyone to not-ready), guests answer Ready/Not-Ready (`markReady`), leader `startRoom()` when satisfied.

### Needs adaptation
- **`provider.tsx` → `TogetherProvider.tsx`**: the reference implementation reads `useSettings()` (a React context with `update()`); Aura has `loadAuraSettings()`/`saveAuraSettings()` + the `aura:settings-changed` event. Replace the settings hook with: read `togetherRelayUrl` from `loadAuraSettings()`, subscribe to `aura:settings-changed`, recreate the client when it flips. Nickname persistence: the reference implementation stores `name` in its own localStorage key — keep that pattern (`aura:together:nickname`) rather than threading through `auraSettings`, so the join prompt can write it without a settings round-trip. Drop `useSelfIdentity`/avatars/profiles/`participantLocations`/`cursorMap`/`presenceMap`.
- **`use-room-sync.ts` → `useRoomSync.ts`**: the reference implementation's hook talks to a `PlayerBridge` (`b.play()`, `b.pause()`, `b.seek()`, `b.setRate()`) and `getPlaybackPosition()`/`getPlaybackBuffered()` from a `playback-clock` module. Aura's equivalents:
  - Position/duration/paused come from **App.tsx state** (`time`, `duration`, `paused`, set from the MPV event channel at App.tsx:589/612/614). Pass these into `useRoomSync`.
  - Play/pause: Aura has `togglePause` (a `cycle pause`) — but the sync hook needs **absolute** set-pause, not toggle, to converge. Use `invoke("set_property"…)`? **NO** — landmine #1 forbids `command("set_property")`, and the existing setters are toggle-only. **Add two thin Rust commands** `player_set_paused(paused: bool)` and reuse `seek_absolute(time)` (exists, lib.rs:884). `player_set_paused` calls `mpv.set_property("pause", &json!(paused), "main")` (the canonical form already used at lib.rs:386). This is cleaner than toggling and avoids races. (3-place registration for `player_set_paused`.)
  - Seek: reuse existing `seek_absolute`.
  - Speed: reuse existing `set_speed`.
  - **Do NOT add `time-pos`/`pause` polling** — landmines #3/#4. The host heartbeat reads App's already-observed `time`/`paused` state (those ARE in the trimmed observed-property set), so no new `get_property` polling is introduced. This is critical: the reference implementation polls `getPlaybackPosition()` on a clock; Aura must instead read the event-fed `time` ref.
  - Buffer-aware catch-up (`getPlaybackBuffered`) — Aura tracks `bufferPct`/`buffering` (App.tsx). Map `getPlaybackBuffered()` → a seconds estimate from `bufferPct × duration`, or simplify the catch-up to drift-only in v1 (D7).
- **Media identity**: the reference implementation's `SyncState.mediaId`/`episode` come from `src.meta`/`src.episode`. Aura's player identity is `ActiveScrobbleTarget` (`id` = episode id for series, `series_id` = series root, `media_type`, `name`, `episode` tag, `season`, `episode_num`, `logo`). Map `buildPlayInvite`/`publishState` from `ActiveScrobbleTarget`: `mediaId = series_id ?? id`, `episode = {season, episode}` from `season`/`episode_num`. The guest "pull to leader's media" flow opens the picker for `mediaId` and auto-plays (Aura's existing play path from DetailView/SourcePopup) — needs a programmatic "play this id at this episode" entry (D4).
- **TitleBar entry point**: the reference implementation's button lives in a React `topbar.tsx` with a popover anchored below. Aura's `TitleBar.tsx` is 36 px tall Win32 chrome; the popover must render as a **fixed-position overlay** (z above PlayerOverlay's 9999 — TitleBar is z-10000) anchored under the button, NOT a child of the 36 px bar (would clip). Reuse the modal-as-fixed-panel approach.
- **Guest control gating in PlayerOverlay**: the reference implementation disables guest controls inside `views/player.tsx`. Aura must thread `inRoom`/`isHost` into `PlayerOverlay` props and branch `togglePause`/seek to `sendCommand` (D3).

---

## 4. Phased build plan (file-level)

### Phase 0 — Decision gate
Resolve D1 (transport), D3 (guest control UX), D5 (deep-link), D6 (chat in v1), D7 (sync fidelity). Everything below assumes D1 = "paste a friend's relay URL; self-deploy is a later add-on", i.e. **build the client first against a known relay URL**, defer Cloudflare-deploy.

### Phase 1 — Relay server (deployable, testable in isolation)
- Create `src-tauri/relay/worker.js` (stripped port: rooms + leader-authority + ready-check + ping; no proxy/cursor/draw/summon/presence).
- Deploy it once manually (wrangler or the CF dashboard) to get a `wss://…` URL for dev. **Quick-winnable** — see §7.
- Verify with a `wscat`/browser console against `/r/TEST`: hello→joined, two peers, host-only state, guest cmd relay.

### Phase 2 — Protocol + client + provider (no UI)
- `src/together/protocol.ts`, `client.ts`, `colors.ts`, `invite.ts`, `buildInvite.ts`, `TogetherProvider.tsx`.
- Add `togetherRelayUrl` to `src/auraSettings.ts` (type + default + validator).
- Wrap `<App>` tree in `<TogetherProvider>` (App.tsx).
- Gate: `pnpm exec tsc --noEmit` clean.

### Phase 3 — Entry-point UI (Friends button + modal)
- `src/WatchTogetherButton.tsx`, `src/WatchTogetherModal.tsx`.
- Insert button into `TitleBar.tsx` window-controls cluster (`data-no-drag`).
- Nickname field in modal writes `aura:together:nickname` + `setName`; **prompt-on-join** flow (the user's req #3): if no saved nickname, the Start/Join action first surfaces the nickname field; once saved it persists.
- Start room → `generateRoomCode()` + `join`; Join → code or pasted `wss://…?aura-room=` link (port the reference implementation's `handleJoin` URL-parse).
- Gate: tsc clean; manual two-window test of join + participant list + leader badge.

### Phase 4 — Player sync + ready-check lobby
- Add Rust `player_set_paused(paused: bool)` command (lib.rs + player.toml + default.json — **3-place**).
- `src/useRoomSync.ts` adapted to App's `time`/`duration`/`paused` + `seek_absolute`/`player_set_paused`/`set_speed`.
- `src/WatchTogetherLobby.tsx` (ready-check overlay): leader initiates via modal "Ready check" (calls `claimHost(true)` to reset everyone, then shows lobby); guests get Ready/Not-Ready; leader `startRoom()` (or "Start anyway") → `started` → playback begins for all.
- Wire `isHost`/`inRoom` into `PlayerOverlay`; gate guest transport controls per D3.
- App.tsx: leader `publishState` heartbeat on play/pause/seek/episode-change; guest reconcile + "pulled to leader's media" auto-play (D4).
- Gate: `cargo check` + tsc clean; manual two-machine (or two-window) sync test: leader play/pause/seek mirrors to guest within drift tolerance; guest's own controls are passive/relayed; ready-check blocks start until answered.

### Phase 5 (optional, D1) — Self-deploy
- `src-tauri/src/cf_relay.rs` (port minus proxy), register 4 commands (**3-place**), add `reqwest` `multipart` feature.
- `src/together/cfDeploy.ts` + Settings "Watch Together" panel (port `relay-panel.tsx`): CF token → list accounts → deploy → store returned `wss://…` into `togetherRelayUrl`.

### Phase 6 — Polish
- Reconnect UX, terminal-error messaging (port `goTerminal` `/health` probe), invite-link copy button, leader-migration toast, Tailwind opacity audit, DevConsole `[together]` logging.

### 3-place command registrations required
| Command | lib.rs `generate_handler!` | player.toml `commands.allow` | default.json |
|---|---|---|---|
| `player_set_paused` | ✅ | ✅ | ✅ |
| `cf_list_accounts` (P5) | ✅ | ✅ | ✅ |
| `cf_deploy_relay` (P5) | ✅ | ✅ | ✅ |
| `cf_delete_relay` (P5) | ✅ | ✅ | ✅ |
| `cf_relay_status` (P5) | ✅ | ✅ | ✅ |

---

## 5. Decisions the user must make
(mirrored in `decisionsNeeded`)

- **D1 — Transport / relay hosting.** Three options: (a) **Reuse the reference implementation's public relay** if it's open (URL `wss://<your-relay-host>.<sub>.workers.dev`) — fastest, but it's someone else's infra, has a 60-req/min + DO daily-limit ceiling, and ties Aura users to the reference implementation uptime. (b) **Self-host one Aura relay** the user deploys once to their own Cloudflare and bakes the URL in as the default `togetherRelayUrl` — clean, free tier ample, but it's *your* CF account/limits for all users. (c) **Port the one-click self-deploy** (`cf_relay.rs`) so each user deploys their own (the reference implementation's model) — most robust/scalable, most work. Recommendation: ship **(b) as default + (a/paste-a-link) for friends**, defer **(c)** to Phase 5.
- **D2 — Leader authority strictness.** the reference implementation enforces host-only `state` *server-side* (worker rejects non-host writes). Confirm we want that hard guarantee (recommended — a guest literally cannot move the room) vs. a softer client-only gate.
- **D3 — Passive-guest control UX.** When a guest clicks play/pause/seek, do we (a) **relay it as a request** to the leader (the reference implementation's model — guest cmd → leader applies → broadcasts), or (b) **fully disable** guest transport controls (greyed out, "Only <Leader> can control playback")? The user said others are "passive" — (b) is the most literal reading; (a) is friendlier. Recommendation: (b) disabled + a tooltip, with leader badge.
- **D4 — Guest "pull to leader's media".** When the leader starts a title, should a guest who isn't on that media be **auto-navigated + auto-played** (needs a programmatic "play id@episode" entry in App), or just shown a "Join <Leader> watching X" prompt they click? Recommendation: prompt-then-play (less jarring, avoids surprise streams costing Debrid).
- **D5 — Deep-link on launch.** the reference implementation parses `?relay&room` from the launch URL (web build). Aura is desktop-only; do we want OS deep-linking (`aura://join?…` via tauri deep-link plugin) or is **paste-a-link-into-the-modal** sufficient? Recommendation: paste-only for v1 (the user's stated entry point), deep-link later.
- **D6 — Chat in v1?** the reference implementation has room chat. The user didn't ask for it. Keep the `chat` message in the protocol (cheap) but ship no chat UI in v1? Recommendation: yes, defer UI.
- **D7 — Sync fidelity.** Port the reference implementation's full buffer-aware catch-up (lookahead + `catchUp` re-seek + near-EOF handling) or a simpler drift-only v1 (seek if `|drift| > tolerance`, set pause to match)? Recommendation: drift-only v1, port the catch-up refinement in Phase 6 once the basic path is proven on Aura's MPV event timing.

---

## 6. Effort + risks

**Effort: XL.** This is the largest feature in the batch: a relay server, a WS client with full reconnect machinery, a React context, two overlays, a TitleBar entry point, player-sync glue against Aura's event-driven (not poll-driven) playback state, plus optional Cloudflare self-deploy. Even trimmed of the reference implementation's cursor/draw/summon/presence, it touches App.tsx (the 5,881-line core), PlayerOverlay, TitleBar, settings, Rust commands, and the 3-place permission ledger.

**Risks**
- **MPV property-race landmines (#3/#4).** The sync loop must NOT introduce `get_property`/`time-pos`/`pause` polling. It must read App's already-observed `time`/`paused`/`duration` state. A naive port of `getPlaybackPosition()` as a poll would re-introduce the AniSkip-class STATUS_ACCESS_VIOLATION. **Mitigation:** feed the hook from App state refs; add only `player_set_paused` (a `set_property`, safe) and reuse `seek_absolute`.
- **Seek storms / feedback loops.** Leader heartbeat + guest reconcile can ping-pong if `updatedBy` filtering or `suppressOutgoingFor` is mis-ported. the reference implementation's `suppressUntil` + `updatedBy === clientId` guards must port faithfully.
- **Relay availability / cost (D1).** A central relay is a single point of failure + a recurring cost surface; CF free-tier DO/request limits will throttle popular rooms. Self-deploy (c) avoids this but adds the whole `cf_relay.rs` surface.
- **Debrid surprise-streams.** Auto-pulling a guest onto the leader's media can trigger a Debrid stream fetch the guest didn't choose (cost/cache implications). D4 = prompt-first mitigates.
- **Clock drift across machines.** the reference implementation's RTT/2 offset estimation is essential for accurate seek targets; must port `recordPong`/`localizeStateClock` intact.
- **TitleBar 36 px clip + drag landmines (#6/#7).** The Friends popover can't be a child of the 36 px bar; the button must be `data-no-drag` + onClick, never `data-tauri-drag-region`.
- **Tailwind opacity silent-drop.** the reference implementation's lobby/modal use non-scale opacities (`/72`, `/12`); must remap or extend.
- **No tests in Aura** — only `cargo check` + `tsc --noEmit` gate; sync correctness is manual two-window/two-machine verification only.

---

## 7. Genuine quick-win sub-part

**The relay `worker.js` (Phase 1) is a real, self-contained quick win** — it has **zero dependency on Aura's codebase**. A stripped port (rooms + leader-authority `handleState`/`handleCommand` + ready-check + ping; drop proxy/cursor/draw/summon/presence) can be written now and deployed/tested in isolation with `wscat` or a browser console against `/r/TEST`, proving the entire sync protocol before a single line of Aura UI exists. It also de-risks D1: once it's deployed, the rest of the work has a live `wss://…` to build against. **Caveat:** it requires a Cloudflare account to deploy (workers.dev + Durable Objects on the free tier), so it's "implementable now, deployable once the user provides/authorizes a CF account." The protocol *code* itself needs no user input.

Secondary quick win (no infra): `src/together/protocol.ts` + `colors.ts` + the `auraSettings.ts` `togetherRelayUrl` field are pure, dependency-free, tsc-checkable additions that can land immediately.
---

## Decisions needed from the user

1. D1 — Relay transport/hosting: (a) reuse the reference implementation's public relay via paste-a-link, (b) self-host one Aura relay and bake its wss:// URL as the default, or (c) port the reference implementation's one-click Cloudflare self-deploy (cf_relay.rs) so each user deploys their own. Recommend (b)+paste-a-link now, defer (c).
2. D2 — Enforce leader-only play/pause/seek server-side in the worker (host-only state writes, hard guarantee) vs. a softer client-only gate. Recommend server-side (port the reference implementation's handleState/handleCommand gate verbatim).
3. D3 — Passive-guest control UX: relay a guest's play/pause/seek as a request to the leader (the reference implementation model) vs. fully disable guest transport controls with a 'only <Leader> controls playback' tooltip. Recommend disabled.
4. D4 — When the leader starts a title, auto-navigate+auto-play guests onto it, or show a 'Join <Leader> watching X' prompt they click (avoids surprise Debrid stream fetches). Recommend prompt-then-play.
5. D5 — Entry point: OS deep-link (aura://join) on launch, or paste-the-link-into-the-modal only for v1. Recommend paste-only for v1.
6. D6 — Include room chat in v1 (the reference implementation has it; user didn't ask) or keep the chat message in the protocol but ship no chat UI yet. Recommend defer UI.
7. D7 — Sync fidelity: port the reference implementation's full buffer-aware catch-up (lookahead/re-seek/near-EOF) or ship a simpler drift-only v1 and refine later. Recommend drift-only v1.

## Risks

- MPV property-race landmines (#3/#4): the sync loop must NOT poll get_property/time-pos/pause — it must read App's already-observed time/paused/duration state. A naive port of the reference implementation's getPlaybackPosition() poll re-introduces the AniSkip-class STATUS_ACCESS_VIOLATION. Mitigation: feed the hook from App state refs; add only player_set_paused (a safe set_property) and reuse seek_absolute.
- Seek storms / feedback loops between leader heartbeat and guest reconcile if updatedBy filtering and suppressOutgoingFor are mis-ported. the reference implementation's suppressUntil + updatedBy===clientId guards must port faithfully.
- Relay availability/cost (D1): a central relay is a single point of failure plus recurring cost; CF free-tier Durable-Object/request limits throttle popular rooms. Self-deploy avoids it but adds the whole cf_relay.rs surface.
- Debrid surprise-streams: auto-pulling a guest onto the leader's media can trigger an unwanted Debrid stream fetch (cost/cache). D4=prompt-first mitigates.
- Cross-machine clock drift: the reference implementation's RTT/2 offset estimation (recordPong/localizeStateClock) is essential for accurate seek targets and must port intact.
- TitleBar 36px clip + drag landmines (#6/#7): the Friends popover can't be a child of the 36px bar; the button must be data-no-drag + onClick, never data-tauri-drag-region.
- Tailwind opacity silent-drop: the reference implementation's modal/lobby use non-scale opacities (/72, /12, /97) that emit no CSS in Aura — must remap to scale steps or extend theme.extend.opacity.
- No automated tests: only cargo check + tsc --noEmit gate; sync correctness is manual two-window/two-machine verification only.
