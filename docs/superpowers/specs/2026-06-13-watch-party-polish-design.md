# Watch-Party Polish — Design

**Date:** 2026-06-13
**Status:** Approved-pending-review
**Area:** Watch-Together (`src/watchTogether/`, `src/WatchTogetherPanel.tsx`, `src/PlayerPartyHud.tsx`, `src/PartyButton.tsx`, `src/AppToast.tsx`, `watch-relay/src/worker.js`, `src/App.tsx`, `src/PlayerOverlay.tsx`)

## 1. Goals

A batch of bug-fixes and feature additions for Watch-Together parties:

1. **Bug** — join toasts fire more than once; make each genuine join toast fire exactly once.
2. **Bug** — leave toasts never appear; make a member's departure reliably toast.
3. **Feature** — restrict synced playback control (play/pause/seek/speed/skip) to the party **leader** only.
4. **Feature** — show the leader with a symbol next to their name in the member list.
5. **Feature** — allow the leader to **transfer** leader status to another member via a button next to that member's name (must not collide with the leader symbol).
6. **Fix** — nudge the "waiting for party" staging banner higher so it clears the player control bar.
7. **Feature/Fix** — room-code join: enforce code requirements (length/charset) and, when no room exists for a typed code, tell the user it doesn't exist and offer to **create** it (instead of silently auto-creating, and instead of hanging on short codes).
8. **Feature** — a **separate** party-activity toast system that spawns from the party icon's side (toward screen interior) and stacks downward, animated — replacing the top-center app toast for party events.
9. **Feature** — in the party panel, replace the raw stream title with **brief meta** (poster + title + year + type + episode) and show the **full rich hover card** on hover.

### Decisions locked with the user
- **Leader = room creator (host)**, with automatic handoff to the longest-present remaining member when the leader leaves, **plus** manual transfer by the current leader.
- **Non-leader transport** controls are **visible but disabled**, with a "Leader controls playback" hint. Local-only controls (volume, subtitles, fullscreen, audio/sub track) stay enabled for everyone.
- **Brief meta** = small poster + title + year + type badge (+ `S1E5` for series); hover opens the existing rich `CatalogHoverCard`.
- **Room-not-found** = relay change (join-vs-create intent) + redeploy via wrangler.

## 2. Architecture overview

Three cross-cutting changes drive most of the work; the rest are localized UI/bug fixes.

### 2.1 Leader becomes a relay-authoritative, movable token

**Today:** leader = the member with the lowest `id` string, derived independently on both client (`store.ts:leaderId()`) and relay (`worker.js:leaderId()`). `ui.isLeader` is a self-only boolean. There is no creator concept and no way to know *which other member* is the leader.

**Change:** the relay owns an explicit, persisted leader token and broadcasts it.

Relay room storage gains one key, `meta = { order: string[], leaderId: string | null }`:
- `order` — cids in **join order** (append a cid the first time it appears; never reorder). Used as the auto-handoff fallback ("longest present").
- `leaderId` — the explicit current-leader cid. Initialized to the **creator** (first member into an empty room), changed by **manual transfer** and by **graceful-leave handoff**.

**Effective leader** (the value broadcast + used for gating) is resolved as:
```
effectiveLeader():
  open = set of cids with an OPEN socket
  if meta.leaderId is set AND open contains it      → meta.leaderId   // present leader (incl. reconnected)
  else first cid in meta.order that is in open       → that cid        // longest-present remaining
  else first open member / null
```
This preserves the **existing reconnect behavior** (a cid is stable, so a leader who blips and returns reclaims the crown; during the gap the next-senior member is the effective leader — exactly what lowest-id derivation did when the leader's socket dropped) while adding creator-as-leader and manual transfer.

**Permanent handoff on graceful leave:** the client sends `{t:"bye"}` before closing when the user clicks **Leave room**. On `bye` from the current effective leader, the relay promotes the next longest-present member into `meta.leaderId` (so a deliberate leave is a one-way handoff). A non-graceful drop (window close / crash) does **not** send `bye`; effective-leader resolution still keeps the room led by the next-senior member, and the stale `leaderId` is harmless (it only matches once that cid is open again).

**Manual transfer:** the client sends `{t:"set-leader", target:<cid>}`. The relay accepts it only from the current effective leader and only when `target` is an open member; it sets `meta.leaderId = target` and re-broadcasts the roster.

`meta` is cleared alongside `state`/`votes` when the room empties (`webSocketClose`, roster length 0). `order` is capped (drop departed cids past a 64-entry cap) to bound storage on high-churn rooms.

The relay broadcasts the effective leader in the `welcome` and `members` frames (`leaderId` field). The client stores it as `ui.leaderId`; `ui.isLeader = selfId === ui.leaderId`. A fallback to the old lowest-id derivation is kept for the brief window before the first leader-bearing frame (and against an un-redeployed relay).

### 2.2 Leader-only playback control

**Client choke point** — `notifyLocalControl()` becomes leader-only: after the existing `status`/`bridge`/`videoKey==null` guards, `if (!ui.isLeader) return;`. The previous "follower in-sync may also drive" path is removed. (Establishing/clearing the party stream is already leader-only.)

**Relay enforcement** — the `control` and `tick` handlers drop frames whose sender is not the effective leader (`if (me.id !== effectiveLeader()) break;`). This makes the server authoritative against a non-leader client that bypasses the UI.

**Player UI** — in `PlayerOverlay`, the synced transport affordances (play/pause, seek bar, ±skip, speed) and their keyboard shortcuts are disabled when `party.status === "connected" && !party.isLeader`, with a "Leader controls playback" tooltip. Followers stay glued to the leader via the existing remote-apply/drift path; their local-only controls (volume, subtitle/audio track, fullscreen) remain live. Disabling the local transport also prevents a follower from desyncing themselves (a local pause that no longer broadcasts).

### 2.3 Room join-vs-create + room-not-found

**Today:** `connect(code)` opens `wss://…/room/<code>?…`; the DO is addressed by `idFromName(code)` and auto-created on first access. Codes under 4 chars fail the relay's `/^/room/([A-Za-z0-9]{4,16})$/` regex → the WS upgrade fails → the client hangs in "connecting". There is no way to distinguish "nobody hosting this code" from a transport failure.

**Change:**
- **Client validation** in `joinRoom()` *before* connecting: normalize to `A-Z0-9`, require length 4–16; otherwise surface `"Room codes are 4–16 letters or numbers."` and don't connect. (`genCode()` already produces a valid 6-char code.)
- **Intent param** — `connect(code, intent)` adds `&intent=join|create`. `joinRoom` → `join`; `createRoom`/`createRoomWithCode` → `create`; **reconnects use `create`** (an established participant re-establishing presence must never be bounced as not-found when they're the last one standing).
- **Relay** — on a `join` intent where the room currently has **zero open sockets**, the DO does *not* auto-create. It accepts the socket transiently (`server.accept()`, outside the hibernation roster so there are no side effects), sends `{t:"room-not-found", code}`, and closes. This check runs *before* any `meta`/state mutation, so a not-found probe leaves no residue.
- **Client** — a `room-not-found` frame sets `ui.status = "not-found"` and `ui.pendingCode = code`, sets a runtime flag so `onclose` does **not** trigger the reconnect loop, and tears down. The Lobby renders: *"No one is hosting room `ABCD`."* with a **Create room `ABCD`** button → `createRoomWithCode(code)` (validates + connects with `intent=create`).

`WatchStatus` gains `"not-found"`. Places that check `status === "connected"` are unaffected; the Lobby/PartyButton handle the new state.

## 3. Wire-protocol additions

`src/watchTogether/types.ts`:
- `welcome` and `members` server frames gain `leaderId: string | null`.
- New server frame: `{ t: "room-not-found"; code: string }`.
- Client→server frames added (sent ad-hoc by the store, no union change required, but documented): `{t:"set-leader", target}`, `{t:"bye"}`, and `intent` is a connect query param.

`watch-relay/src/worker.js` message switch gains `case "set-leader"` and `case "bye"`; `control`/`tick` gain the leader gate; `welcome`/`broadcastMembers` include `leaderId`; `fetch` gains the intent/room-not-found branch; storage gains the `meta` key and clears it on empty.

## 4. Component-level changes

### 4.1 `src/watchTogether/store.ts`
- `WatchUiState`: add `leaderId: string | null`; add `pendingCode: string | null`; `WatchStatus` += `"not-found"`.
- `welcome`/`members` handlers: set `ui.leaderId = msg.leaderId ?? null` then `recomputeLeader()`.
- `recomputeLeader()`: `ui.isLeader = selfId != null && (ui.leaderId ?? leaderId()) === selfId`; start/stop leader timer as before.
- `applyTick`: driver check compares to `ui.leaderId ?? leaderId()`.
- `notifyLocalControl`: leader-only gate (§2.2).
- New exports: `transferLeader(targetId)` (guards `ui.isLeader`, sends `set-leader`), `createRoomWithCode(code)` (validate + `connect(code,"create")`).
- `joinRoom`: 4–16 charset/length validation (§2.3).
- `connect(code, intent)`: thread `intent` into `buildUrl`; reconnect path passes `"create"`.
- `leaveRoom`: `send({t:"bye"})` when connected, before `teardown()`.
- `handleMessage`: add `room-not-found` case (sets `not-found` status + `pendingCode`, sets a `roomNotFound` runtime flag consulted by `onclose` to skip reconnect, tears down).
- **Join/leave toast rework** (§5) + route through `showPartyToast` instead of `showAppToast`.

### 4.2 `src/PartyToast.tsx` (new)
- `showPartyToast(message, opts?)` fires `aura:party-toast` CustomEvent (mirrors `showAppToast`'s API/dedup-by-id, default ~4s, tone).
- `PartyToastHost` (mounted once in App, `z-[10050]`, `pointer-events-none`): on each toast, reads the visible party anchor via `document.querySelector('[data-party-anchor]')` (added to both `PartyButton` and the `PlayerPartyHud` presence cluster — exactly one is visible at a time). Computes anchor rect → toasts are positioned just below the anchor and **animate horizontally out of the anchor toward screen interior** (icon on left half → slide in from the left edge growing rightward; icon on right half → slide in from the right edge growing leftward), stacking downward with a gap. New CSS keyframes `aura-party-toast-in-left` / `-right` (translateX ±16px + fade + slight scale). Emerging toward the interior keeps the right-side stack clear of the top-right `PartyVotesOverlay` column.
- Fallback: if no anchor is found (edge timing), render top-right.

### 4.3 `src/WatchTogetherPanel.tsx`
- `Room` receives `leaderId`, `roomMetaId`, `roomMediaType`, and an `onTransfer(id)` callback (wired to `transferLeader`).
- **Member list**: crown glyph when `m.id === leaderId` (left, by the name). When `isLeader && m.id !== leaderId && m.id !== selfId`, a subtle right-aligned **"Make host"** icon-button that is **revealed only on row hover** (Tailwind `group`/`group-hover:opacity-100` with `opacity-0` + a short transition; also reveal on keyboard focus for accessibility). The row uses `justify-between`; the crown is left, the transfer button is far-right, so they never collide. Clicking calls `onTransfer(m.id)`.
- **Brief meta** (§9): replace the `roomTitle · roomStreamLabel` lines (both the in-sync emerald block and the out-of-sync amber block) with a `<PartyMediaCard>` sub-component: small poster (server-resized width hint) + title + `year · Type · S1E5`, fetched from the meta cache (`peekRichestCachedDetailById` synchronously, then `getRichestMetaDetail` to fill). On `mouseenter`/`mouseleave`, drive `catalogHoverStore.scheduleHoverOpen/scheduleHoverClose` with a synthesized `MetaPreview` ({id: roomMetaId, type: roomMediaType, name: roomTitle, poster}) so the existing rich `CatalogHoverCard` shows on hover. Verify `CatalogHoverHost` z-index sits above the panel's `z-[9999]`; if not, bump it (or render a local instance scoped to the panel).
- **Lobby**: room-not-found create affordance (§2.3) driven by `w.status === "not-found"` + `w.pendingCode`; show a charset/length hint under the code input.

### 4.4 `src/PlayerPartyHud.tsx`
- Staging banner: raise `bottom` (windowed `120 → ~150`, fullscreen `96 → ~120`) to clear the control bar (final values tuned during verification).
- Presence cluster: `data-party-anchor` attribute; small crown badge overlaid on the leader's avatar (`m.id === w.leaderId`).

### 4.5 `src/PartyButton.tsx`
- Add `data-party-anchor` attribute (the home/browse toast origin).

### 4.6 `src/App.tsx`
- Mount `<PartyToastHost />` once (near `AppToastHost`).
- Pass `leaderId`/`roomMetaId`/`roomMediaType` and `onTransfer` into `WatchTogetherPanel`.
- Transport gating: the `wtTogglePause`/`wtSeek`/`wtNudge` wrappers and the player's transport handlers consult `reactiveParty.isLeader` (when in a party) to disable; pass an `isPartyFollower` flag into `PlayerOverlay`.

### 4.7 `src/PlayerOverlay.tsx`
- Accept a follower flag; disable synced transport controls + their keyboard shortcuts with the "Leader controls playback" tooltip when set. Leave local-only controls active.

## 5. Bug fixes — join/leave toasts

**Join multi-fire (root cause):** the diff fires a toast for any roster member absent from `previousMemberIds` (unless a pending-leave timer exists). An unstable peer that drops and re-joins on a cadence crossing the 6 s leave window (reconnect backoff is `1.5 s × attempts`, up to ~15 s) produces repeated "left"→"joined" cycles, and any path that surfaces the same member as "new" across frames re-toasts. **Fix:** add a `toastedMembers: Set<string>` of members already announced as present. A join toasts only if the member is genuinely new **and** not already in `toastedMembers`; add on toast. Remove from `toastedMembers` when their leave toast actually fires. This makes joins idempotent regardless of frame cadence.

**Leave never shows (root cause):** the deferred (6 s) leave toast is cancelled by `clearPendingLeaves()` inside `teardown()` whenever *this* client (re)connects, and is gated on `ui.status === "connected"` at fire time; a non-graceful peer departure (window close) also relies on Cloudflare reaping the dead socket, which is not prompt. **Fix:** (a) the graceful `{t:"bye"}` (§2.1) makes the relay broadcast the updated roster immediately on a deliberate leave, so the departure is detected promptly; (b) keep the 6 s defer (it correctly hides reconnect blips) but ensure the timer fires the toast via `showPartyToast` and updates `toastedMembers`; (c) keep clearing pending leaves on *this* client's own reconnect (correct), accepting that a member leaving exactly while you are reconnecting is re-seeded silently (rare edge).

Both toasts now route through the new party-toast channel (§4.2).

## 6. Error handling

- Invalid code → inline Lobby error, no connection attempt.
- Room-not-found → distinct `not-found` state + create affordance; no reconnect loop.
- `set-leader`/`bye` from a non-leader, or `set-leader` to an absent target → relay no-ops (defensive; the client only enables transfer for the leader).
- Non-leader control/tick frames → relay drops them (defense in depth behind the client gate).
- Meta fetch failure for brief meta → fall back to title-only text (no poster), hover simply doesn't populate.

## 7. Testing / verification

- `cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit` (no Rust change expected here; tsc is the real gate). Lint the relay JS by `node --check watch-relay/src/worker.js`.
- Manual 2-client (and ideally 3-client) party test, **after redeploying the relay**:
  - join fires once; leave fires once (graceful Leave button, and window-close).
  - follower transport disabled + tooltip; leader controls drive everyone.
  - crown on the host; "Make host" transfers; old leader's controls disable, new leader's enable; handoff on leader leave.
  - typing a non-existent code → "doesn't exist, create it?" → create works; `<4` char code → inline error, no hang.
  - party toasts spawn from the icon side and stack; brief meta + hover render.
  - staging banner clears the control bar (windowed + fullscreen).

## 8. Deployment

The relay changes (`watch-relay/src/worker.js`) require `wrangler deploy` from `watch-relay/`. The desktop changes are backward compatible with the old relay except for the new features that depend on the relay (leader broadcast, transfer, room-not-found) — those activate once redeployed; the lowest-id fallback keeps leadership sane in the meantime.

## 9. Out of scope / accepted quirks

- A crashed/force-closed former leader whose cid later reconnects while the room is still alive reclaims leadership (explicit token still points at them once open). Accepted — graceful leave hands off permanently; this only affects ungraceful drops + same-install return.
- Transferring leadership to an off-title member is allowed (deliberate host action); that member then controls the party and may re-establish the party stream.
- The graceful-leave `bye` is best-effort (only sent when the socket is OPEN). If a leader leaves while a reconnect is mid-flight (CONNECTING), `bye` is skipped, but the relay's `webSocketClose` still resolves the next effective leader — only the explicit permanent promotion is missed, which is moot since a deliberate leaver sets `userLeft` and won't reconnect to reclaim.
- room-not-found is signalled BOTH by a `room-not-found` frame and a `4404` WebSocket close code; the close code is the reliable fallback if the frame doesn't flush before the relay closes the transient probe socket.
- Exact banner offsets and party-toast transform/timing are tuned during verification, not pinned here.
