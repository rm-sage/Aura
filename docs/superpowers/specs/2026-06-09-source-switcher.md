# In-Player Source Switcher — swap the streaming source mid-playback without exiting

> **Effort:** M — ~300 LOC overlay + ~120 LOC hook + a small handlePlayStream signature add + one MoreMenu entry + optional cache extraction. Zero Rust; backend is 100% reuse. Most self-contained of the six.  
> **Quick-win:** Genuine quick win exists and is implementable now with no user input: add a 'Switch source' item to PlayerOverlay's MoreMenu (PlayerOverlay.tsx ~3159) that dispatches an aura:open-source-switcher event; App.tsx opens a minimal overlay that calls fetch_streams (dedupedInvoke) for the current activeTarget and renders rows that re-invoke the EXISTING handlePlayStream(stream, target) with startSeconds = current live `time`. Zero Rust, zero new command registration — fetch_streams/resolve_stream/load_video are all already wired in all 3 places. The only code change beyond the new component is an optional `forceStartSeconds` arg on handlePlayStream to bypass the resume prompt. This is the most self-contained of the six features because Aura's play path is already a complete swap primitive.  
> **Decisions needed (see end):** 5

# Porting Spec — In-Player Source Switcher (swap stream source mid-playback)

Bring the reference implementation's "Switch stream" feature into Aura: an in-player overlay that lists alternative
sources for the currently-playing item and swaps to a selected one **in place**, preserving the
playback position — never backing out of the player.

---

## 1. What the reference implementation does (architecture + key files)

the reference implementation lets a user, while a movie/episode is playing, open a "Switch stream" overlay listing every
other source it already knows for that exact item, click one, and have the player re-resolve +
loadfile the new URL at the same time-position — without unmounting the player.

**Key the reference implementation files:**

- `src/components/player/stream-switcher.tsx` (≈680 LOC) — the overlay UI. A `z-[60]` absolute
  modal *inside* the player (not a route). Reads streams from an in-memory **picker cache**
  (`peekPickerCache(meta, episode)` + `subscribePickerCache`), renders filter chips (addon /
  quality / cached-only / preferred-language / show-flagged), and a scrollable list of `SwitcherRow`s.
  Each row shows addon logo + headline + badges; the currently-playing row is marked **"Now Playing"**
  (`isCurrent = s.url === currentUrl`) and disabled; the row that's mid-resolve shows a spinner
  (`resolving = resolvingKey === streamKey(s)`). Calls `onPick(stream)` on click. **No data fetching
  of its own** — purely presentational over the cache.

- `src/views/player/hooks/use-stream-switcher.ts` (≈150 LOC) — the brain. Owns `switcherOpen`,
  `swapResolvingKey`, `liveUrl`/`liveStreamRef` (the live source identity, updated on swap so
  Copy/Cast/etc. follow the swap). Two critical mechanisms:
  - **`pinPickerCache(meta, episode)` on mount / unpin on unmount** — pins this item's streams so
    the 30-min stale sweep can't evict them; without this, opening the switcher after watching a
    while found a cold cache and "bounced the user out to the full picker (which stops playback)".
  - **`onSwitchStream(stream)`** — the swap primitive: abort any prior swap (AbortController), call
    `resolveStream(stream, debrids, signal, /*userCommitted*/ true)`, optionally wrap with a header
    proxy (`registerStreamProxy`), then read **current position** (`getPlaybackPosition()`, with a
    `readResumeMs` fallback), and call `bridge.load({ url, subtitles, notWebReady, startAtSec: resumeAt })`
    + `bridge.play()`. Updates `liveUrl`/`liveStreamRef`, clears resolving, closes the overlay.
  - Comment in the file states the design intent verbatim: *"Always open the in-place switcher
    overlay. NEVER navigate to the full picker from here: that unmounts the player and stops the
    movie, which is the 'switching stream kicked me out of the movie' bug."*

- `src/lib/streams/resolve.ts` — `resolveStream(...)`. For HTTP(S) direct URLs returns immediately;
  for `infoHash` streams iterates debrid providers. **Heavily torrent/debrid-coupled** (tryLocalEngine,
  tryStremioServer, magnetFromHash). Most of this is irrelevant to Aura (no native torrent).

- `src/lib/player/bridge.ts` + `mpv.ts` — `PlayerBridge.load(src: { url, subtitles?, notWebReady?, startAtSec? })`.
  The MPV bridge issues a loadfile with the start position folded into the load (same idea as Aura's
  `load_video(path, startSeconds)`).

- `src-tauri/src/stream_proxy.rs` — axum proxy that registers `{url, headers}` sessions and serves a
  `http://127.0.0.1:<port>/s/<uuid>` URL for streams that need custom request headers / cast / transcode.
  Aura's equivalent is `streaming.rs` + `resolve_stream` (which already proxies HTTP and bypasses HTTPS).

- `src-tauri/src/streams.rs` — only `streams_run_pipeline` / `streams_parse` (the reference implementation's trust+scoring
  engine in Rust). Aura does its scoring/parsing in TS (`streamMeta.ts`) and Rust `fetch_streams`, so
  this file has **no Aura analog to port**.

**the reference implementation data flow:** picker cache (populated when the user first opened the item's stream list)
→ StreamSwitcher reads it → onPick → resolveStream → (proxy) → bridge.load(startAtSec) → play. The
position is preserved by reading the live clock and passing it as the load's start offset.

---

## 2. Aura mapping (exact files to create/modify, conventions)

Aura already has every backend primitive the reference implementation needs. The swap primitive
**`handlePlayStream(stream, target)`** in `App.tsx` (line ~1186) *already does the entire flow*:
resolve_stream → CDN preheat → `load_video(path, startSeconds)` → apply_lang_defaults / subtitle
style / loudnorm / motion-interp / aniskip / thumbnail prewarm. `load_video`'s `start_seconds` arg
is exactly the reference implementation's `startAtSec` and is honored by **both** engines (`lib.rs::load_video` legacy path
and `mpv2::engine::submit_load_file`). So a source-swap is "call handlePlayStream again with the
same `target` but a different `stream`, with `startSeconds` = the current live position."

**Aura counterpart map:**

| the reference implementation | Aura |
|---|---|
| `picker-cache.ts` (pin/peek/subscribe) | `streamCache` Map inside `src/views/DetailView.tsx` (module-level, **not exported**, keyed `streams:${media_type}:${targetId}:${addonUrls}`) — must be lifted into a shared module so the player can read it. |
| `use-stream-switcher.ts` | NEW `src/useSourceSwitcher.ts` hook (or fold state into App.tsx near `activeTarget`/`activeStreamUrl`). |
| `stream-switcher.tsx` | NEW `src/SourceSwitcher.tsx` overlay component. |
| `bridge.load({startAtSec})` | existing `invoke("load_video", { path, startSeconds })` — reuse via `handlePlayStream`. |
| `getPlaybackPosition()` | the `time` value already lifted in App.tsx (the live `usePlayback` clock feeding PlayerOverlay's `time` prop). |
| `resolveStream` (debrid loop) | existing `resolve_stream` Tauri command — already does HTTP-proxy / HTTPS-bypass. No new resolve logic. |
| `registerStreamProxy` (headers) | Aura's `resolve_stream` + `streaming.rs` already handle header-bearing HTTP. No new command needed for v1 (Aura's stream rows don't surface per-stream request headers today). |
| `StreamEntry` shape | Aura's `types.ts::StreamEntry` (`title, addon_name, url, info_hash, file_idx, description, filename`). Reuse — **do NOT** invent the reference implementation's `ScoredStream`. |
| `streamMeta.ts` (parse) | existing `src/streamMeta.ts` (`parseStream`, `chipStyleFor`) — reuse for quality/resolution badges + filtering. |

**Conventions to honor:**

- Aura uses **window CustomEvents** to decouple cross-component triggers (`aura:streams-refresh`,
  `aura:ed-start-time`, `aura:open-source-popup`). The switcher's open trigger should follow this:
  dispatch `aura:open-source-switcher` from PlayerOverlay's MoreMenu, listen in App.tsx (or the hook).
- In-player glass panels use `.aura-glass-menu` / `.aura-glass-bar` (App.css), z-index **above**
  PlayerOverlay's `z-[9999]`. EpisodePanel (`src/EpisodePanel.tsx`) is the exact structural precedent:
  a right-side in-player drawer, offset `top: isFullscreen ? 0 : 36` (CLAUDE.md landmine #6 — the 36px
  Win32 title bar stays visible in windowed playback).
- `dedupedInvoke(key, factory)` (`src/invokeDedupe.ts`) wraps any `fetch_streams` re-fetch.
- All new Rust commands (if any) need the **3-place registration**: `lib.rs generate_handler![]` +
  `permissions/player.toml commands.allow` + a capability set referenced in `capabilities/default.json`.
  **For v1 NO new Rust command is required** — `fetch_streams`, `resolve_stream`, `load_video`,
  `seek_absolute` are all already registered.

---

## 3. Ports 1:1 vs needs-adaptation

**Ports ~1:1 (concept, re-skinned to Aura's design system):**
- The overlay shell: header ("Switch stream", "N sources available"), scrollable rows, footer hint
  ("Click any source to swap in place" / "Esc to close"), Escape-to-close (capture-phase listener),
  click-backdrop-to-close, "Now Playing" badge on the current row, per-row resolving spinner.
- The swap-in-place philosophy and the **pin-the-cache** insight (Aura has the identical eviction
  risk: DetailView's `streamCache` has a 3-min TTL + 32-entry LRU cap, so a long watch would evict
  the streams and the switcher would find nothing).
- `liveUrl` tracking so Copy-link / External-player / thumbnail-prewarm follow the swapped source
  (Aura: update `activeStreamUrl` — `handlePlayStream` already does `setActiveStreamUrl(stream.url)`).

**Needs adaptation:**
- **Stream source of truth.** the reference implementation's picker cache is a standalone subscribable module; Aura's
  `streamCache` lives inside DetailView and isn't exported. **Adaptation:** extract it to a new
  `src/streamCache.ts` (move the Map + put/get/delete + add `peek(key)` and a `keyFor(...)` helper),
  re-import in DetailView (no behavior change), and read it from the switcher. Alternatively (simpler,
  recommended) **the switcher fetches its own list via `fetch_streams`** on open (deduped), keyed on
  `activeTarget` — this sidesteps the whole cache-lifting + key-mismatch problem and matches Aura's
  existing pattern where `fetch_streams` is the one true source. The 3-min cache then naturally serves
  the open if the user just came from DetailView.
- **Resolve loop.** Drop the reference implementation's debrid/torrent iteration entirely. Aura calls `resolve_stream(rawUrl)`
  where `rawUrl = stream.url ?? magnet:?xt=urn:btih:<info_hash>`. The swap reuses `handlePlayStream`,
  which contains the canonical resolve+preheat+load+post-load-setup sequence — so the swap inherits
  AniSkip re-stamp, loudnorm, motion-interp, subtitle-style re-apply, and thumbnail prewarm **for free**
  and stays consistent with a normal play.
- **Position capture.** the reference implementation reads `getPlaybackPosition()`. Aura already has the live `time` in
  App.tsx. Pass `startSeconds = time` into the swap. (the reference implementation's `current > 5 ? current : saved` guard
  is worth keeping: if the live clock is < ~5s, fall back to the library `state.timeOffset`.)
- **Filters.** the reference implementation's rich filter bar (quality/addon/cached/lang/flagged) leans on its `ScoredStream`
  fields and debrid `cached` map — Aura has neither. v1 should ship a **minimal** filter set derived
  from `streamMeta.parseStream()` (addon name + resolution), or no filters at all. Full parity filters
  are a v2 nicety, not a port blocker.
- **Header-proxy on swap.** the reference implementation's `registerStreamProxy` path handles streams with custom request
  headers. Aura's `StreamEntry` doesn't currently carry `behaviorHints.proxyHeaders`, and `resolve_stream`
  already routes HTTP through the bridge. **No adaptation needed for v1**; note as a gap if a future
  addon needs per-stream headers.

---

## 4. Phased build plan (file-level)

### Phase 0 — Verify primitives (no code) [~10 min]
Confirm `load_video` honors `start_seconds` on the active engine (`AURA_MPV2` default = mpv2):
`mpv2/engine.rs:1684` builds `loadfile … replace` and appends `start=<sec>` from `start_seconds`.
Legacy path: `lib.rs:399`. Both confirmed present. **No Rust changes for v1.**

### Phase 1 — Switcher overlay + hook (frontend only) [the bulk]

**CREATE `src/SourceSwitcher.tsx`** — port of `stream-switcher.tsx`, re-skinned:
- Props: `{ open, onClose, onPick(stream: StreamEntry), resolvingKey: string | null, currentUrl: string | null, streams: StreamEntry[], loading: boolean }`.
- Root: `z-[10001]` (above PlayerOverlay `z-[9999]`, sibling to it like EpisodePanel/NextUp CTA),
  `.aura-glass-menu` panel, centered modal OR right-drawer (decision below). Offset `top: isFullscreen ? 0 : 36`.
- Rows: reuse `parseStream(stream)` from `streamMeta.ts` for resolution/rip/codec/HDR badges +
  `chipStyleFor`. Headline = `stream.title`/`stream.addon_name`; sub-line = `stream.description`/`filename`.
- `isCurrent = stream.url != null && stream.url === currentUrl` → "Now Playing" pill, row disabled.
- `resolving = resolvingKey === streamKey(stream)` where `streamKey = info_hash ?? url ?? addon_name:title` → spinner.
- Escape (capture-phase) + backdrop click close. Empty/loading states ("Finding other sources…",
  "No other sources available").

**CREATE `src/useSourceSwitcher.ts`** — port of `use-stream-switcher.ts`:
- State: `open`, `resolvingKey`, `streams`, `loading`.
- On open: `fetch_streams` via `dedupedInvoke` keyed on `activeTarget` (movies → `activeTarget.id`;
  series → the episode id). Reuses DetailView's 3-min cache if shared module is adopted (Phase 3),
  else just refetches (cheap if warm).
- `onPick(stream)`: set `resolvingKey`, capture `startSeconds = currentTime > 5 ? currentTime : (libRow.state.timeOffset ?? 0)`,
  then call the provided `swap(stream, startSeconds)` (which is `handlePlayStream` with the existing
  `activeTarget` and an injected start position — see Phase 2), clear resolving, close.
- Abort guard: an AbortController/generation counter so a second pick supersedes the first.

### Phase 2 — Wire swap to handlePlayStream (App.tsx) [small]

`handlePlayStream` currently derives `startSeconds` only from the resume-prompt flow. For a swap we
want to **bypass the resume prompt** and force `startSeconds = <live position>`. Two clean options:

- **(Recommended) Add an optional 3rd arg** `opts?: { forceStartSeconds?: number; skipResumePrompt?: boolean }`
  to `handlePlayStream`. When `forceStartSeconds` is set: skip the resume-prompt block, skip
  `notifyNewLoad`-induced "start over" semantics ambiguity, set `resumeAt = forceStartSeconds`. Everything
  else (resolve_stream, preheat, load_video, post-load setup) runs unchanged. The switcher calls
  `handlePlayStream(pickedStream, currentActiveTargetAsPlayTarget, { forceStartSeconds, skipResumePrompt: true })`.
- (Alt) A thin `swapSource(stream, startSeconds)` wrapper that inlines the resolve→preheat→load_video
  subset. Rejected: duplicates the post-load setup and risks drift from the canonical path.

Reconstruct the `target` for the swap from `activeTarget` (it carries `id, series_id, media_type,
name, episode, episode_title, season, episode_num, genres, original_language, production_countries`)
— map back into the `target` shape `handlePlayStream` expects (the `scoring` sub-object from the
flat fields). `activeStreamUrl` is updated inside `handlePlayStream` already, so Copy/External/thumb
follow the swap automatically.

Mount the hook + overlay near the PlayerOverlay render (App.tsx ~5395):
```
const switcher = useSourceSwitcher({ activeTarget, addons, currentTime: time, library, swap: handlePlayStream });
…
{activeTarget && <SourceSwitcher open={switcher.open} onClose={switcher.close}
   onPick={switcher.onPick} resolvingKey={switcher.resolvingKey}
   currentUrl={activeStreamUrl} streams={switcher.streams} loading={switcher.loading}
   isFullscreen={isFullscreen} />}
```

### Phase 3 — Entry point + cache sharing [small]

- **Entry point:** add a "Switch source" item to PlayerOverlay's **MoreMenu** (the three-dots/gear
  menu, `PlayerOverlay.tsx` ~3159; it already has Copy link / Download / External / Restart). The
  click dispatches `window.dispatchEvent(new CustomEvent("aura:open-source-switcher"))`; App.tsx (or
  the hook) listens and opens. Optionally also add a keybinding later. (the reference implementation surfaces it via a pill
  + hotkey; MoreMenu is the lowest-friction Aura home and matches the existing menu pattern.)
- **Cache sharing (optional but recommended):** extract DetailView's `streamCache` Map + helpers into
  `src/streamCache.ts`, export `streamCacheGet/Put/Delete` + a `streamCacheKey(mediaType, targetId, addonUrls)`
  helper. DetailView imports them (zero behavior change). The hook reuses the same key so a user who
  played from DetailView gets an instant switcher open. This mirrors the reference implementation's pinned-cache intent
  without a separate pin/sweep system (Aura's TTL is short but the switcher's own `fetch_streams`
  fallback covers a cold cache — so explicit "pinning" is unnecessary).

### Phase 4 — Polish / edge cases [small]
- Mark switcher-open as a "menu open" so PlayerOverlay's auto-hide/keep-controls logic treats it like
  the other menus (`useMenuOpenSync` pattern referenced at `PlayerOverlay.tsx:32`).
- Don't offer the switcher for live/channel media types (the reference implementation gates `iptv:`); Aura: gate on
  `media_type` not in {movie, series, anime}.
- On successful swap, re-fire the post-load `refresh_video` (handlePlayStream already does at +150ms).
- Guard against picking the already-playing row (disabled in UI + `if stream.url === activeStreamUrl return`).

### 3-place command registration
**None required for v1.** All commands used (`fetch_streams`, `resolve_stream`, `load_video`,
`seek_absolute`, `extract_thumbnail`, `apply_lang_defaults`) are already in `generate_handler!`,
`permissions/player.toml`, and covered by the `allow-player-controls`/`allow-load-video`/etc. sets in
`capabilities/default.json`. Only revisit this if a v2 adds a per-stream header-proxy command.

---

## 5. Decisions the user must make
1. **Entry point UI:** "Switch source" in the three-dots MoreMenu only, or also a dedicated pill /
   keybinding (the reference implementation uses a pill + hotkey)? Recommend MoreMenu for v1, keybinding later.
2. **Overlay shape:** centered modal (the reference implementation) vs right-side glass drawer (matches Aura's EpisodePanel
   precedent). Recommend centered modal for v1 — it's a transient pick-and-go, not a persistent drawer.
3. **Stream source:** refetch via `fetch_streams` on open (simplest, recommended) vs lift+share
   DetailView's `streamCache` for instant opens. Recommend: share the cache *and* fall back to fetch.
4. **Filter chips in v1?** None, or minimal (addon + resolution from `streamMeta`)? Recommend none for
   v1; add addon/resolution filters in v2.
5. **Position semantics on swap:** always resume at the live position (recommended), or honor the
   resume-prompt rules? Recommend: silent resume at live position (no prompt) — that's the whole point.

---

## 6. Effort + risks

**Effort: M.** ~1 new overlay component (~300 LOC re-skinned), ~1 hook (~120 LOC), a small
`handlePlayStream` signature addition, one MoreMenu entry, optional cache extraction. Zero Rust.
Backend is 100% reuse — this is the most self-contained of the six features.

**Risks:**
- **MPV swap stability** — a swap is a fresh `load_video`/loadfile while a file is already playing.
  This is the same operation a per-episode change already performs (EOS "Play episode" → `onEosPlayEpisode`
  → handlePlayStream), so it's a proven path. Must still respect landmine #3 (no `get_property` polling
  during the loadfile critical section) — handlePlayStream already gates its post-load work behind the
  +1500ms timer, so reusing it inherits that safety.
- **Cache key mismatch** if sharing DetailView's `streamCache` — the key is `${media_type}:${targetId}:${addonUrls}`
  and the switcher must reconstruct `targetId` (episode id for series) identically from `activeTarget`.
  The "refetch fallback" mitigates a miss.
- **Stale debrid URLs** — a stream cached from DetailView minutes ago may have an expired debrid link;
  `resolve_stream` + the existing preheat/validate path surfaces the failure, but v1 should show a
  toast on swap failure (the reference implementation logs `[player] stream swap failed: <code>`). Aura: `fireToast`.
- **`activeStreamUrl` reconstruction** — the "Now Playing" highlight depends on `stream.url === activeStreamUrl`.
  `activeStreamUrl` is the *raw* url (pre-resolve), and `StreamEntry.url` is also raw — so they match.
  Confirm this holds for magnet/info_hash-only rows (both null url → won't match → no false "Now Playing").

---

## 7. Genuine quick-win sub-part

**Yes — the entire v1 is quick-win-adjacent, and one slice is a true standalone quick win:** adding a
**"Switch source" entry to PlayerOverlay's MoreMenu that re-fetches `fetch_streams` for the current
`activeTarget` and renders a minimal in-player list whose rows call `handlePlayStream(stream, target,
{forceStartSeconds: time})`**. This needs no Rust, no new command registration, and reuses the fully-
proven resolve→load→post-setup path. The only required App.tsx change is the optional `forceStartSeconds`
arg on `handlePlayStream`. Everything else (filters, cache sharing, drawer styling, keybinding) is
incremental polish on top.
---

## Decisions needed from the user

1. Entry point: 'Switch source' in the three-dots MoreMenu only (recommended for v1), or also a dedicated pill / keybinding like the reference implementation?
2. Overlay shape: centered modal (the reference implementation) vs right-side glass drawer matching Aura's EpisodePanel? Recommend centered modal for v1.
3. Stream source of truth: refetch via fetch_streams on open (simplest), or lift+share DetailView's module-level streamCache for instant opens? Recommend share-with-refetch-fallback.
4. Filter chips in v1: none (recommended) or minimal addon+resolution filters derived from streamMeta.parseStream?
5. Position semantics on swap: silently resume at the live position with no prompt (recommended — that's the point), or honor the existing resume-prompt rules?

## Risks

- MPV swap = fresh load_video while a file plays; proven via the EOS 'Play episode' path, but must keep landmine #3 (no get_property polling during the loadfile critical section) — inherited safely because handlePlayStream gates post-load work behind its +1500ms timer.
- If sharing DetailView's streamCache, the key (media_type:targetId:addonUrls) must reconstruct targetId (episode id for series) identically from activeTarget; the refetch fallback mitigates a miss.
- Cached debrid URLs can expire between DetailView open and the swap — resolve_stream surfaces the failure; v1 must show a fireToast on swap failure (the reference implementation logs the code).
- 'Now Playing' highlight relies on stream.url === activeStreamUrl (both raw URLs, so they match); verify magnet/info_hash-only rows (null url) don't false-match.
- Reconstructing the handlePlayStream `target` from the flat ActiveScrobbleTarget fields (re-nesting genres/original_language/production_countries into the `scoring` sub-object) must be exact or scrobble anime-detection drifts on swapped sources.
