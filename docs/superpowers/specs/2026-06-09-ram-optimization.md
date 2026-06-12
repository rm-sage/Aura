# RAM optimization — audit findings, applied changes, and backlog (2026-06-09)

A 4-dimension memory audit (frontend caches, image memory, Rust/MPV buffers, React leaks)
found **17 safe wins, 3 medium-risk, 0 high-risk**. The codebase was already disciplined
(every interval/listener has cleanup; most caches are bounded). This branch applies the safe,
non-visual wins; visual-surface and landmine-adjacent wins are documented below for you to
apply + smoke-test (they can't be verified without running the app).

Both gates green after the applied changes (`cargo check` + `tsc --noEmit`).

---

## ✅ Applied on this branch (`feat/ram-opt-and-feature-specs`)

### 1. MPV demuxer cache ceiling — the single biggest lever (~875 MB peak on 4K)
`src-tauri/src/player.rs:302-303` (legacy `--wid`) **and** `src-tauri/src/mpv2/engine.rs:1457-1458`
(render engine) both set **1.5 GiB forward / 256 MiB back**. On an ~80 Mbps 4K remux the 120 s
read-ahead fills ~1.0-1.2 GB of that — the dominant host-RAM consumer. **Lowered to 768 MiB /
128 MiB** on both (kept in sync). `demuxer-readahead-secs=120` is the usual binding constraint;
768 MiB still holds ~75-90 s forward at 80 Mbps (far above `cache-pause-wait=4 s`) and the full
120 s at ≤50 Mbps, so re-buffering is unchanged for the vast majority of streams. **Revert lever:**
bump both constants back to 1.5 GiB/256 MiB if 4K-remux mid-playback underruns reappear.

### 2. ~~Headless thumbnail libmpv instance — torn down on stop~~ (SUPERSEDED — removed)
This branch originally added `player::stop_thumb()` (called from `stop_video`) to unload the old
plugin-backed `"thumb"` libmpv instance on stop and free its 2nd-libmpv buffers. It has been
**removed**: the hover-thumbnail work (`feat/hover-thumbnails`) replaces that old plugin instance
entirely with the warm `mpv2::thumb` FFI engine, whose own `mpv2::thumb::shutdown()` (called from
`stop_video`) provides the same free-RAM-on-stop teardown. Keeping `stop_thumb` would reference
code the hover-thumbnail branch deletes once the two land together — so it's dropped here, with no
loss of the RAM win.

### 3. Rust catalog caches — opportunistic eviction (`stremio.rs`)
`CATALOG_OK_CACHE` (up to ~100 `MetaPreview` per entry) and `ADDON_FAIL_CACHE` were never swept —
every catalog browsed in a session stayed resident until exit. Added `cache.retain(... elapsed <
TTL)` before each insert, bounding both to the last-10-min / 30-s working set. Zero UX (stale
entries were never served).

### 4. metaCache — smaller cap + index co-eviction (`src/metaCache.ts`)
`MAX_ENTRIES 1500 → 800` (a media player rarely needs >few-hundred live detail records; halves the
persisted localStorage blob ~3 MB → ~1.5 MB and the hydrate parse spike). Also **co-evict + clear
`idYearIndex`** (previously never pruned and not cleared by the Storage→clear button — a slow
monotonic `{year,ts}` leak): rebuilt from surviving entries on eviction + `idYearIndex.clear()` in
`clearMetaCache()`.

### 5. Three unbounded session Maps → bounded LRU
- `aggRatingsCache` (`CatalogHoverCard.tsx`) → LRU **400** (was uncapped; grew per hovered card).
- `catalogPaginationCache` (`CinemaRows.tsx`, was commented "never cleared") → LRU **16** catalogs.
- `thumbCacheRef` scrubber data-URLs (`PlayerOverlay.tsx`) → LRU **100** (was 240 + full `clear()`;
  LRU keeps warmth near the cursor at ~2-3× lower RAM).

---

## 📋 Recommended next (NOT applied — need a HW/visual smoke test or carry higher risk)

### A. Hero carousel: window backdrop layers — ~38 MB  [visual]
`src/HeroCarousel.tsx:208` renders **all** up-to-10 full 21:9 backdrops (`items.map`) so cross-fade
works (~5 MB each decoded). Render only `{index-1, index, index+1}` (mod length) — cross-fade only
needs the outgoing+incoming layer, and auto-advance is +1 so the outgoing is always the windowed
`index-1`. **Deferred because** a windowing bug could flash/blank the hero during transitions, which
is unverifiable without running the app.

### B. Window the 100-item grids — ~30-60 MB  [visual]
Discover/CatalogPageView/View-all-popup (`DiscoverView.tsx:256`, `views/CatalogPageView.tsx:137`,
`CinemaRows.tsx:1361`) mount all ~100 posters with no windowing. **Reuse the already-shipping
`useLibraryRowWindow`/`LIB_BUFFER_ROWS` row-virtualization from LibraryView** so only visible+overscan
rows mount their `<img>`. Proven mechanism, but porting to 3 surfaces needs scroll/layout verification.

### C. Unmount the browse tree during playback — largest steady-state frontend win  [LANDMINE #6]
`App.tsx:5216` keeps the entire app body React-mounted and only `display:none`-s it while playing —
`display:none` does NOT free decoded poster bitmaps, detach listeners, or stop the HeroCarousel
timer, so HomeView + every DiscoveryRow poster stays resident for the whole (multi-hour) session.
Replacing `hidden` with `{!isPlayerActive && (<body/>)}` frees all of it — **but** risks the
documented landmine #6 (an opaque repaint flashing over the MPV child before the first frame). Must
keep `TitleBar` mounted + `.aura-app-shell` transparent and **HW-smoke-test** that no opaque flash
occurs. Safer partial: unmount only HomeView/HeroCarousel (heaviest image consumers) via the existing
`resetKey` remount path.

### D. Warm-start library blob — slim the persisted projection  [medium risk]
`App.tsx:2666` persists the FULL `LibraryItem[]` (incl. `state.genres`) on every `library_get`.
Persisting only first-paint fields (id/name/media_type/poster/background/logo + timeOffset/video_id)
shrinks the second-largest localStorage tenant. **Deferred because** CinemaRows reads `state.genres`
for anime gating; dropping it from the *warm-start* copy could mis-gate anime until the fresh
`library_get` lands. Verify the gating re-seeds before slimming.

### E. Small / lower-priority (safe, low impact)
- **Sentry** (`main.tsx`): set `maxBreadcrumbs: 30` and consider lowering `replaysOnErrorSampleRate`
  for a multi-hour media session — one-line config, behind the existing consent gate, release-only.
- **reqwest clients** (`stremio.rs:21` + ~10 others): add `.pool_max_idle_per_host(1)` +
  `.pool_idle_timeout(30s)` to reclaim idle TLS buffers; point the transient per-call builders
  (aniskip/scrobble/anilist) at their module's pooled `OnceLock` client. Do NOT merge the
  `https_only(true)` clients with the permissive stremio CLIENT.
- **anime_id_map** (`anime_id_map.rs`): tightly scope the raw JSON `String` + transient
  `Vec<FribbEntry>` so both drop before the map lock (removes a ~3-4 MB startup spike); drop the
  never-read `kitsu_id`/`anidb_id` fields from `AnimeIdRow` (32→16 bytes/row).
- **DevConsole** (`DevConsole.tsx`): accumulate log entries in a ref and only mirror into React
  state when the console is open — eliminates per-log re-renders during playback when F12 is closed.
- **DetailView `streamCache`**: optionally lower `STREAM_CACHE_MAX 32 → 12` (TTL already reclaims it).

---

---

## ✅ Applied 2026-06-12 (branch `feat/ram-backlog`) — the safe, gate-verifiable batch

A 9-agent re-audit + 4-agent adversarial review of the backlog above. The items that
could be implemented **and** fully verified with `cargo check` + `tsc` + `vite build`
alone (no visual / playback smoke test) were applied; the visual / landmine-adjacent
ones stay deferred (see "Still deferred" below).

- **E1 — Sentry `maxBreadcrumbs: 30`** (`src/main.tsx`). Was unset → SDK default ~100
  breadcrumbs retained per session; 30 keeps crash lead-up context without the
  multi-hour bloat. Inside the existing consent gate. (~8–12 MB.)
- **E3 — `anime_id_map.rs` row slim + parse-spike trim.** Dropped the never-read
  `kitsu_id`/`anidb_id` from `AnimeIdRow` (4→2 `Option<u64>`, 32→16 B/row across
  ~10–15k rows). The Fribb **inclusion filter is unchanged** (still gates on all four
  ids via `FribbEntry`), so multi-season `entries[season-1]` Vec alignment is identical.
  Plus `install()` now takes `Vec<FribbEntry>` by value + `drop(entries)` before the
  lock and the callers `drop(text)` after parse — trims the ~3–4 MB startup overlap.
- **E4 — DevConsole closed-buffer** (`src/DevConsole.tsx`). When F12 is closed the
  component renders `null`, yet every log line was calling `setEntries` (a render on
  nothing). Now logs accumulate in a **bounded** `closedBufferRef` while closed and
  drain into `entries` on open (a `useLayoutEffect` syncs `openRef` synchronously both
  directions; reopen-while-paused routes into the pause buffer to keep the view frozen).
  **Closed is the outermost gate** so the paused+closed combo can't leak into the
  unbounded pause buffer. (~15–20 MB of avoided render churn during playback.)
- **E5 — `STREAM_CACHE_MAX` 32 → 12** (`src/views/DetailView.tsx`). TTL already
  reclaims; smaller cap trims the steady-state working set, eviction-timing only.
- **E2 (additive subset) — reqwest idle-pool tuning.** Added
  `.pool_max_idle_per_host(1)` + `.pool_idle_timeout(30s)` to the rarely-used pooled
  clients (stremio `CLIENT`/`ACCOUNT_CLIENT`, auth, aniskip, ratings, publicmetadb,
  scrobble, scrobble_anilist, sync, subtitles). Caps **idle** retention, not in-flight
  concurrency, so addon fan-out is unaffected. **Deliberately NOT done** (the part the
  audit flagged unsafe-to-apply-blind): the transient-builder→shared-pool consolidation
  (credential-isolation risk) and the long-lived streaming/iptv/cast clients. No
  `https_only` client was merged or weakened.

## ✅ Applied 2026-06-12 (branch `feat/party-votes-and-ram-ab`, merged to main + pushed) — A + B

- **A — HeroCarousel backdrop windowing** (~38 MB). Only the backdrops the cross-fade
  needs mount: `{prev, current, next}` + the slide being faded FROM. The outgoing slide
  is derived during RENDER (from `prevIndexRef`, which still holds the old index on the
  post-jump commit) — not a post-paint effect — so even a non-adjacent dot jump mounts
  it in the same frame and its fade-OUT fires (no hard cut, no wasted re-decode). A
  freshly-mounted non-adjacent target appears at full opacity (no fade-IN) — accepted.
- **B — Window the 100-item grids** (Discover / CatalogPage / CinemaRows "View all"
  popup). New shared `src/useRowWindow.ts` (a faithful generalization of LibraryView's
  private `useLibraryRowWindow` — Library left untouched) + a fixed-height title block on
  each card (`h-14` for the 13 px Discover/Catalog cards; `h-[5.25rem]` for the 19 px
  popup card, sized for a 2-line title + year). Popup column count read from
  `--catalog-popup-cols` via a stable module-level `resolveCols`; scroll resets on
  filter/catalog change; the hook clamps the window so a shrinking list can't blank the
  grid. `CatalogCard`'s `fixedTitle` is opt-in so the non-windowed home rows stay
  byte-identical. **NEEDS A VISUAL PASS** on the three grids (1080p + ultrawide).

## ❌ Dropped indefinitely (2026-06-12, user decision — low gain, higher risk)

- **C — Unmount the browse tree during playback** (~5–8 MB). Landmine #6 zone (opaque
  flash over the MPV child). Not worth the regression risk vs the modest win.
- **D — Slim the warm-start library blob** (~8–12 MB). Risks mis-gating IMDb-id anime in
  the ~1–2 s window before the fresh `library_get` re-seeds. Not worth it.

## Standing rule
See CLAUDE.md → "Performance & memory": every new feature ships with bounded caches, resized images,
idle-native-resource teardown, listener/timer cleanup, and conscious buffer caps.
