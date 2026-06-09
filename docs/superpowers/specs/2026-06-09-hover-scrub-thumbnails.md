# Port the reference implementation's never-stale hover-scrub thumbnail preview into Aura

> **Effort:** M — Option A (ffmpeg backend) ~1 day: ~200-line src-tauri/src/thumbs.rs reusing silencedetect's ffmpeg resolver, 3-place registration, ~40-line frontend (incl. quick-win fallback). Option B (true 1:1 mpv.exe subprocess) is L: adds binary bundling, release-pipeline doc, named-pipe IPC port, and a frontend lifecycle module. Option C is M-L but high-risk on this libmpv build.  
> **Quick-win:** Yes — a genuine quick win exists, implementable NOW with no user input and no new binaries: port the reference implementation's approximate-nearest-cached-frame fallback (thumbCacheNearest) into Aura's existing PlayerOverlay Scrubber. Aura already has thumbCacheRef (Map<sec,dataUrl>); add a 'nearest cached frame within ~30 s, rendered dimmed at opacity-60 behind the loader' so already-visited regions feel instant and the empty-loader flash disappears. ~30 lines, frontend-only (PlayerOverlay.tsx render block ~2703-2716 + a helper), fully reversible, independent of the backend decision. It does NOT fix the stale-frame extraction itself — that requires the backend choice (A/B/C) — but is a safe, immediate UX win.  
> **Decisions needed (see end):** 5

# Porting Spec — the reference implementation's never-stale hover-scrub thumbnail preview → Aura

## 0. TL;DR

the reference implementation's seek-bar thumbnail is never-stale because it drives a **long-lived headless `mpv.exe` subprocess over a named pipe** and gates every screenshot on mpv's **`playback-restart` event** (event-driven seek confirmation), not on polling. Aura's current `extract_thumbnail` uses an **in-process named `"thumb"` libmpv instance** that confirms seeks by **polling `playback-time` ± a frame-step**, which races on remote streams and yields stale/wrong frames + rapid-hover races.

The blocker for a literal 1:1 port: **Aura ships NO `mpv.exe`** — only `libmpv-2.dll` / `mpv.dll` / `libmpv-wrapper.dll` / `ffmpeg.exe` in `src-tauri/lib/`. So the port adapts to one of three backends (see §3). **Recommended: Option A — reuse the already-bundled `lib/ffmpeg.exe` to do a seek-accurate, one-frame-per-hover extraction.** ffmpeg extraction is inherently never-stale (each invocation seeks then decodes exactly the requested frame; there is no shared decoder state to go stale), needs zero new binaries, and matches the user's accepted 2-3 s/hover budget. The user accepts higher latency for always-correct frames, which exactly fits ffmpeg-per-hover.

A genuine quick win (§7) ships independently of the backend choice: port the reference implementation's **approximate-nearest-cached-frame fallback** into Aura's overlay so already-visited regions feel instant and the empty-loader flash disappears.

---

## 1. What the reference implementation does (architecture + key files)

### Files
- **`src-tauri/src/thumbs.rs`** (450 LOC) — the entire backend. Owns a `ThumbsState` Tauri-managed singleton.
- **`src/lib/trickplay.ts`** — frontend store + invoke wrappers (`trickplaySetUrl`, `trickplaySpawnEager`, `trickplayGet`, `trickplayStop`) + an in-memory `thumbCache: Map<bucket, dataUri>` with `thumbCacheGet` / `thumbCacheSet` / `thumbCacheNearest`, and a `useSyncExternalStore`-backed `TrickplayState {active, bufferedOnly}`.
- **`src/views/player/hooks/use-trickplay.ts`** — lifecycle hook: on `src.url`/`enabled` change → `setTrickplayState` → `trickplaySetUrl(url)` then `trickplaySpawnEager()`; cleanup → `setTrickplayState(inactive)` + `trickplayStop()`.
- **`src/components/player/thumb-preview.tsx`** — the hover card (`ThumbPreview`): bucketed lookup, retry-until-ready, nearest-frame fallback rendered dimmed.
- **`src/components/player/transport/seek-bar.tsx`** — wires `hover` → `<ThumbPreview time={hover} dur canFetch>`; `canFetch` is the buffered-window gate for torrent sources.
- **`src/views/player/hooks/use-exit-snapshot.ts`** — reuses `trickplayGet(position)` to capture an exit snapshot (secondary consumer).

### Data flow / why it never shows stale frames
1. **Per-stream shadow process.** `thumbs_set_url(url)` tears down any existing shadow, sets a fresh UUID `session`, clears the cache. `spawn_shadow` launches a **separate `mpv.exe`** with: `--input-ipc-server=<pipe>`, `--no-config --no-audio --no-sub --vo=null --pause=yes --keep-open=yes --idle=yes --load-scripts=no --ytdl=no --cache=yes --demuxer-max-bytes=32MiB --vf=scale=240:-2 --screenshot-format=jpg --screenshot-jpeg-quality=72 --screenshot-tag-colorspace=no --hr-seek=no <url>`. Pipe name on Windows: `\\.\pipe\aura-thumbs-<session>`.
2. **Named-pipe IPC.** `spawn_ipc` connects a `tokio::net::windows::named_pipe::ClientOptions` client (retry 40× / 100 ms), spawns a reader task that line-splits JSON events and a writer task draining an `mpsc<Value>` of commands.
3. **Event-gated seek (the anti-stale core).** `thumbs_get(time_sec)`:
   - Buckets time to `round(time/2.0)`; cache hit → return immediately.
   - Arms a `tokio::sync::Notify` (`seek_notify`), sends `{"command":["seek", target, "absolute", "keyframes"]}`, then **awaits the Notify** (timeout `SEEK_WAIT_MS=2500`). The reader fires `seek_notify.notify_waiters()` on the **`playback-restart` event** — i.e. it waits for mpv to *actually finish the seek + first-frame decode* before screenshotting. This is the key difference from Aura's poll.
   - Then sends `{"command":["screenshot-to-file", path, "video"], "request_id": id}` and awaits a `oneshot` keyed in a `pending: HashMap<u64, oneshot::Sender>` map, resolved when the reader sees the matching `request_id` reply with `error == "success"` (timeout `REQUEST_TIMEOUT_MS=12000`).
   - Reads the JPEG file, base64-encodes to a `data:image/jpeg` URI, caches by bucket, deletes the temp file.
4. **Frontend retry + nearest fallback.** `ThumbPreview` debounces `SETTLE_MS=130`, retries `MAX_ATTEMPTS=8 × RETRY_MS=300` (covers the ~2-3 s cold decode), and **never blanks**: while the exact bucket loads it renders `thumbCacheNearest(bucket, 30)` at `opacity-60` (dimmed "approximate") so the card always shows *something plausible*, and supersedes via `liveBucketRef` (ignores any resolution whose bucket no longer matches the live hover — the reference implementation's rapid-hover race guard).
5. **`bufferedOnly` gate.** For torrent sources (url starts with the stremio-server origin) only buckets inside the buffered window are fetchable. **Not relevant to Aura** (no torrents — Stremio-addon + Debrid only).

**Net:** correctness comes from (a) a *dedicated* decoder with no shared state to corrupt, and (b) **waiting for the `playback-restart` event** rather than polling a position property.

---

## 2. Aura mapping (exact files to create/modify + conventions)

### Current Aura implementation (what we're replacing/fixing)
- **`src-tauri/src/player.rs` lines 511-723** — `extract_thumbnail(app, url, at_seconds) -> Option<ThumbResult{data_url, at}>`. Uses `app.mpv()` (the tauri-plugin-libmpv shared handle) with a named `"thumb"` instance behind a `OnceLock<Mutex<ThumbState>>`. Init opts: `vo=null, audio=false, pause=true, idle=yes, hwdec=no, hr-seek=yes, vf=scale=320:-2, screenshot jpg q80`. Per request: `loadfile` on URL change (+450 ms sleep), then a 6-attempt loop of `seek absolute+exact` → **poll `playback-time` ±0.5 s** → `frame-step` → re-poll `±1.0 s` → `screenshot-to-file` → read+b64. Inline `b64_encode`.
- **`src/PlayerOverlay.tsx`** — the consumer. `thumbnailAt` prop (line 2059) calls `invoke("extract_thumbnail", {url: streamUrl, atSeconds: sec})`. The `Scrubber` sub-component (lines ~2365-2520) owns: `hoverIntSec` (integer-second bucket dep), a 220 ms debounce, `thumbReqRef` single-flight/supersession, `thumbCacheRef: Map<number,string>`, `thumbUrl`/`thumbUrlSec` render-gate (`thumbUrlSec === hoverIntSec`), `thumbBusy` loader. **All the frontend race-guarding the reference implementation has, Aura already has** — Aura's stale-frame problem is in the *Rust extraction*, not the React layer.
- **Registration (already done for `extract_thumbnail`):** `lib.rs` generate_handler line 2430; `permissions/player.toml` line 19 (in `allow-player-controls`); `capabilities/default.json` references `allow-player-controls` (group-level — no per-command entry, contrary to the literal CLAUDE.md 3-place rule; the group is the third place here).

### Reusable Aura patterns to follow (conventions)
- **ffmpeg resolver + spawn:** `src-tauri/src/silencedetect.rs::ffmpeg_bin(app)` (lines 53-81) resolves `AURA_FFMPEG` env → `<resource_dir>/lib/ffmpeg.exe` → `<exe_dir>/lib/ffmpeg.exe` → `<CARGO_MANIFEST_DIR>/lib/ffmpeg.exe` → PATH `ffmpeg`. `ffmpeg_command(app)` (lines 91-101) sets `CREATE_NO_WINDOW = 0x08000000`. **Reuse these verbatim** (either `pub(crate)` them or copy the resolver into the new module).
- **Security guard:** silencedetect rejects non-`http(s)` URLs and passes `-protocol_whitelist http,https,tcp,tls,crypto`. Mirror this in the thumb extractor.
- **HTTPS bypass:** pass `streamUrl` directly (the same URL the main player uses). Do NOT route through `127.0.0.1:11471` — TLS cert mismatch breaks it (CLAUDE.md streaming-bridge constraint).
- **devlog labels:** use `crate::devlog!(…, "player", …)` or a new `[thumbs]` label (add to the labels list in CLAUDE.md/HANDOFF if introducing it).
- **Logging/log-leak:** the bundled-binary + URL-in-logs caveats apply (truncate URL in logs like silencedetect does: `url.chars().take(80)`).
- **Frontend store pattern:** if adopting the reference implementation's lifecycle commands, mirror `src/lib/trickplay.ts` as a new `src/trickplay.ts` (Aura keeps flat `src/*.ts` helpers, e.g. `streamMeta.ts`, `libraryActions.ts`) — but match Aura's existing `useState`/`useRef` overlay style rather than introducing `useSyncExternalStore` unless desired.

### Files to CREATE / MODIFY (Option A — recommended)
| Action | File | Change |
|---|---|---|
| CREATE | `src-tauri/src/thumbs.rs` | New module. ffmpeg-per-hover extractor (see §4). Reuses `silencedetect::ffmpeg_command`. Exposes `extract_thumbnail` (reimplemented) + optionally `thumbs_set_url`/`thumbs_stop` for cache lifecycle. |
| MODIFY | `src-tauri/src/lib.rs` | `mod thumbs;` near other `mod` decls (~line 49 cluster); move `extract_thumbnail` out of `player::` into `thumbs::` in `generate_handler!` (line 2430 area); register any new lifecycle commands; `.manage(thumbs::ThumbsState::new())` in setup if using a state singleton for the cache. |
| MODIFY | `src-tauri/src/player.rs` | DELETE lines 511-723 (`ThumbState`, `THUMB`, `b64_encode`, `extract_thumbnail`, `ThumbResult`). `b64_encode` → move to thumbs.rs (or use the `base64` crate the reference implementation uses; check if already a dep). |
| MODIFY | `src-tauri/permissions/player.toml` | If renaming/adding commands, update `allow-player-controls` `commands.allow` (line 12-37). `extract_thumbnail` stays; add `thumbs_set_url`/`thumbs_stop` if introduced. |
| MODIFY (optional) | `src/PlayerOverlay.tsx` | Add nearest-cached-frame fallback (quick win, §7). If adopting lifecycle commands, call set-url/stop on stream change. The `thumbnailAt` prop signature can stay identical. |
| CREATE (optional) | `src/trickplay.ts` | Only if adopting the reference implementation's lifecycle/cache module. Otherwise PlayerOverlay's existing `thumbCacheRef` suffices. |

---

## 3. Ports 1:1 vs needs-adaptation

| the reference implementation element | Verdict | Notes |
|---|---|---|
| `playback-restart`-event-gated seek (anti-stale core) | **Adapt** | The *principle* (confirm seek by event, not poll) ports. The *mechanism* (named-pipe mpv event stream) only ports under Option B. Under Option A, ffmpeg's per-invocation seek is inherently confirmed (the single decoded frame IS the sought frame) — no event needed. |
| Long-lived `mpv.exe` subprocess + named pipe | **Needs adaptation / decision** | Aura ships no `mpv.exe`. Option B requires bundling it (~repeat the ffmpeg.exe inert-binary gotcha). Option A drops the subprocess entirely. |
| `ThumbsState` singleton, `thumbs_set_url/spawn_eager/get/stop` command surface | **Port (optional)** | Cleaner per-stream cache lifecycle than Aura's per-stream-implicit cache. Additive; recommended but not required. |
| 2.0 s bucket cache | **Port** | Trivial; Aura currently buckets per-integer-second (1 s). Either is fine; 2 s halves extraction count. |
| `thumbCacheNearest(bucket, 30)` dimmed approximate fallback | **Port 1:1** | Pure UX win, backend-agnostic. **This is the quick win.** |
| `liveBucketRef` rapid-hover supersession | **Already in Aura** | `thumbReqRef` + `thumbUrlSec === hoverIntSec` gate already does this. No port needed. |
| `SETTLE_MS=130` / `MAX_ATTEMPTS=8` / `RETRY_MS=300` retry | **Already in Aura (different shape)** | Aura debounces 220 ms + 6-attempt Rust retry. Keep Aura's; ffmpeg won't need the warm-up retry (no cold-decode warmup needed per-call). |
| `bufferedOnly` torrent gate | **Drop** | Aura has no torrents. |
| `--vf=scale=240:-2`, jpg q72, `screenshot-tag-colorspace=no` | **Adapt to ffmpeg** | ffmpeg equivalent: `-vf scale=240:-2 -frames:v 1 -q:v <2..5>`. For HDR add a tonemap (see risks). Aura currently uses 320 px / q80 — keep ~240-320 px. |
| `base64` crate | **Check** | the reference implementation uses the `base64` crate; Aura currently has an inline `b64_encode`. Reuse the inline one (no new dep) or add `base64` if already transitively present. |

---

## 4. Phased build plan (file-level)

### Option A (recommended): ffmpeg-per-hover backend

**Phase A1 — Rust module `src-tauri/src/thumbs.rs`**
1. Make `silencedetect::ffmpeg_command` and `ffmpeg_bin` `pub(crate)` (or copy the resolver). Add a `[thumbs]` devlog label.
2. Implement:
   ```rust
   #[derive(serde::Serialize)]
   pub struct ThumbResult { pub data_url: String, pub at: f64 }

   #[tauri::command]
   pub async fn extract_thumbnail(app: AppHandle, url: String, at_seconds: f64)
       -> Result<Option<ThumbResult>, String>
   ```
   - Guard: empty url / non-finite / <0 → `Ok(None)`. Reject non-`http(s)` (mirror silencedetect) → `Ok(None)`.
   - Build `ffmpeg_command(&app)` with: `-hide_banner -nostdin -protocol_whitelist http,https,tcp,tls,crypto -ss <at_seconds> -i <url> -frames:v 1 -vf scale=320:-2 -q:v 4 -f image2 -` (write JPEG to **stdout**, captured to a `Vec<u8>` — avoids temp-file churn; the reference implementation used a file only because mpv's screenshot-to-file has no pixel return path, ffmpeg can pipe). `.stdout(Stdio::piped()).stderr(Stdio::null()).stdin(Stdio::null()).kill_on_drop(true)`.
   - `-ss` BEFORE `-i` = fast keyframe-snapped input seek (the reference implementation accepts keyframe snapping via `seek ... "keyframes"`). The decoded frame is exactly the frame ffmpeg lands on → **never stale by construction**.
   - Cap with a timeout (e.g. `tokio::time::timeout(12 s)`); on timeout/empty → `Ok(None)` (graceful — overlay falls back to timestamp tooltip).
   - base64-encode stdout bytes → `data:image/jpeg;base64,…`. Report `at = at_seconds` (keyframe-snap drift is acceptable per the reference implementation; OR add `-vf showinfo` parse for true PTS — see decisions).
   - `kill_on_drop(true)` + the frontend supersession means rapid hovers don't pile up (superseded children are dropped/killed).
3. (Optional) Add a `ThumbsState` with a per-`(url)` `Mutex<HashMap<bucket, String>>` cache so re-hovers don't re-spawn ffmpeg even across component remounts; + `thumbs_set_url(url)` (clears cache) / `thumbs_stop()`. Aura's PlayerOverlay already caches in-memory, so this is optional belt-and-suspenders.

**Phase A2 — wiring (the 3-place registration)**
1. `lib.rs`: add `mod thumbs;`. In `generate_handler![…]` replace `player::extract_thumbnail` with `thumbs::extract_thumbnail` (+ `thumbs::thumbs_set_url`, `thumbs::thumbs_stop` if added). If using `ThumbsState`, `.manage(thumbs::ThumbsState::new())` in `setup`.
2. `permissions/player.toml`: `extract_thumbnail` already in `allow-player-controls`; add `thumbs_set_url`/`thumbs_stop` to the same `commands.allow` list if introduced.
3. `capabilities/default.json`: no change needed — `allow-player-controls` is already in `permissions`. (For brand-new permission *groups* you'd add them here; reusing the existing group needs nothing.)
4. Delete `player.rs` lines 511-723.

**Phase A3 — frontend**
1. `PlayerOverlay.tsx`: `thumbnailAt` prop unchanged (still `invoke("extract_thumbnail", {url, atSeconds})`). 
2. Add nearest-cached-frame fallback to the Scrubber (the quick win, §7).
3. (Optional) If lifecycle commands added: on `streamUrl` change call `invoke("thumbs_set_url", {url})`; on overlay close `invoke("thumbs_stop")`.

**Phase A4 — verify**
`cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`. HW smoke: hover-scrub a known HTTPS stream (stremthru.animasec.dev), confirm frames match position and never show a wrong/old frame; confirm first hover ≤ ~3 s, warm re-hover instant.

### Option B (true 1:1): long-lived headless mpv.exe subprocess
Port `thumbs.rs` ~verbatim (it's already cross-platform-guarded and Windows-correct: `\\.\pipe\…`, `CREATE_NO_WINDOW`, named-pipe client). Additional work vs A:
1. **Bundle `mpv.exe`** into `src-tauri/lib/` (git-ignored like the DLLs; add to `.gitignore` + document in the release pipeline; the `resources: ["lib/**/*"]` glob already ships it). Adapt `locate_mpv()` to prefer `<resource_dir>/lib/mpv.exe` using the silencedetect resolver pattern (the reference implementation only searches PATH — Aura must prefer bundled).
2. Replace the reference implementation's `uuid` session id if `uuid` isn't a dep (Aura may not have it — check Cargo.toml; can use a counter/timestamp instead).
3. Port `src/lib/trickplay.ts` → `src/trickplay.ts`; port `use-trickplay.ts` lifecycle into PlayerOverlay's stream-change effect; map `thumbnailAt` onto `thumbs_get`.
4. 3-place registration for `thumbs_set_url/spawn_eager/get/stop`.
This is the literal the reference implementation design but adds installer weight + the inert-binary gotcha. Choose only if you specifically want the warm-decoder low-latency profile.

### Option C: keep in-process libmpv "thumb" instance, make it event-driven
Replace the `playback-time` poll in `player.rs` with an mpv property-observe / event wait for the seek to land before screenshotting. **Risk:** the mpv2/tauri-plugin-libmpv event channel on this build is fragile (CLAUDE.md landmine #4 — adding observed properties breaks the whole channel; landmine #3 — get_property during seek crit-section crashes). This is the highest-risk option and least aligned with "the reference implementation's method." Not recommended.

---

## 5. Decisions the user must make
1. **Backend:** A (ffmpeg-per-hover, recommended — no new binary, never-stale, ~1-3 s/hover) vs B (the reference implementation's exact mpv.exe subprocess — needs bundling mpv.exe ~50-100 MB) vs C (in-process libmpv, event-driven — highest risk on this build).
2. **Command surface:** keep `extract_thumbnail` only, or add the reference implementation's `thumbs_set_url`/`thumbs_stop` lifecycle for explicit cache invalidation + (B-only) eager warmup.
3. **Cache + approximate fallback:** adopt the reference implementation's 2 s bucket + nearest-within-30 dimmed approximate frame (recommended), or keep per-integer-second with no approximate fallback.
4. **(B only)** Accept bundling `mpv.exe` into the installer + the git-ignored/inert-binary release gotcha?
5. **Settings toggle:** always-on (current Aura) vs a Settings switch (the reference implementation exposes one) + a kill-switch env var.

---

## 6. Effort + risks

**Effort:** Option A = **M** (~1 day: ~200-line thumbs.rs + 3-place wiring + ~40-line frontend). Option B = **L** (adds bundling, release-pipeline doc, named-pipe IPC, frontend lifecycle module). Option C = **M-L** but high-risk.

**Risks:**
- **First-hover latency (A):** cold TLS/DNS + open + keyframe seek on a remote debrid stream can exceed 2-3 s on the *first* hover; ffmpeg is one-shot so there's no warm decoder. Acceptable per user but higher than the reference implementation's warm subprocess.
- **Seek accuracy tradeoff:** `-ss` before `-i` = fast but keyframe-snapped (off by up to a GOP). `-ss` after `-i` = exact but decodes from 0 (too slow). the reference implementation accepts keyframe snapping; replicate that and either trust the requested bucket or parse true PTS via `showinfo`.
- **(B) No mpv.exe shipped today** — bundling repeats the ffmpeg.exe "absent ⇒ feature ships inert" gotcha; +installer size.
- **Concurrency / rapid-scrub:** every backend must single-flight + supersede. Frontend already does (`thumbReqRef`). Rust must drop/kill superseded work (`kill_on_drop` on the ffmpeg child / the reference implementation's `pending` map) or CPU piles up.
- **HDR tonemapping:** ffmpeg without a tonemap filter renders HDR thumbnails grey/washed vs the live gpu-next output. Low severity (tiny thumbs); add `zscale/tonemap` only if it looks bad.
- **Bridge bypass:** pass the direct `streamUrl` to ffmpeg/mpv; never the `:11471` proxy (TLS mismatch). Apply the `-protocol_whitelist` guard.
- **Landmines untouched:** Option A/B run *outside* the main mpv2 render instance — they don't touch observed-properties, the main seek crit-section, or WASAPI, so landmines #2/#3/#4 don't apply. Option C re-enters that danger zone.

---

## 7. Quick win (ships NOW, no user input, no new binaries)

**Port the reference implementation's approximate-nearest-cached-frame fallback into Aura's Scrubber** (`PlayerOverlay.tsx`, the `thumbCacheRef` block around lines 2453-2520 + the render around 2703-2716). Today Aura shows an empty loader whenever the exact `hoverIntSec` isn't cached. Add the reference implementation's `thumbCacheNearest`:

- Helper: search `thumbCacheRef.current` for the entry whose key is closest to `hoverIntSec` within a window (e.g. 30 s); if found and the exact one is missing/in-flight, render it at `opacity-60` ("approximate") behind the loader.
- This removes the empty-flash on already-visited regions and makes scrubbing across a watched stretch feel instant, **independent of which backend you pick** and fully reversible (~30 lines, frontend-only). It does NOT fix the stale-frame extraction bug (that needs the backend decision) but is a strict, safe UX win to land immediately.

---

## 8. Concrete reference anchors
- Aura current backend to replace: `src-tauri/src/player.rs:511-723` (`extract_thumbnail`, `ThumbState`, `b64_encode`, `ThumbResult`).
- Aura frontend consumer: `src/PlayerOverlay.tsx:2059-2067` (prop wiring) + `:2437-2523` (debounce/cache/supersession) + `:2703-2716` (render gate).
- ffmpeg resolver to reuse: `src-tauri/src/silencedetect.rs:53-101` (`ffmpeg_bin`, `ffmpeg_command`) + `:174-189` (arg pattern + `-protocol_whitelist` + `kill_on_drop`).
- Registration: `src-tauri/src/lib.rs:2430` (handler), `src-tauri/permissions/player.toml:12-37` (`allow-player-controls`), `src-tauri/capabilities/default.json:30` (`allow-player-controls` group — already present).
- Bundling proof: `src-tauri/tauri.conf.json:36` (`resources: ["lib/**/*", "shaders/**/*"]`) ships everything in `lib/`; `lib/` already holds `ffmpeg.exe` + `libmpv-2.dll` + `mpv.dll` + `libmpv-wrapper.dll` but **no `mpv.exe`**.
- the reference implementation backend: `src-tauri/src/thumbs.rs` (the `playback-restart`→`Notify` gate at lines 183-202 + 297-300 is the anti-stale mechanism). the reference implementation frontend: `src/lib/trickplay.ts`, `src/components/player/thumb-preview.tsx`, `src/views/player/hooks/use-trickplay.ts`, `src/components/player/transport/seek-bar.tsx`.
---

## Decisions needed from the user

1. Extraction backend: (A) ffmpeg-per-hover using the already-bundled lib/ffmpeg.exe (recommended — zero new binaries, inherently seek-accurate/never-stale, ~1-3 s/hover) vs (B) the reference implementation's exact design — a long-lived headless mpv.exe subprocess over a named pipe with event-driven seek confirmation (requires BUNDLING mpv.exe ~50-100 MB into src-tauri/lib/, which Aura does NOT currently ship) vs (C) keep the current in-process "thumb" libmpv instance but make it event-driven instead of poll-based (highest risk on this libmpv build per landmines #3/#4). Pick A unless you specifically want the warm-decoder mpv.exe subprocess.
2. Command surface: keep just extract_thumbnail (swap backend in place) OR add the reference implementation's lifecycle commands (thumbs_set_url / thumbs_stop, plus thumbs_spawn_eager for option B) for explicit per-stream cache invalidation + eager warmup. Recommendation: add the lifecycle commands; they're additive and extract_thumbnail can ride on top.
3. Cache granularity + approximate fallback: adopt the reference implementation's 2.0 s bucket + nearest-cached-within-30 dimmed approximate frame (strict UX win, recommended), or keep Aura's per-integer-second cache with no approximate fallback.
4. (Option B only) Are you willing to bundle mpv.exe into the installer (git-ignored in lib/ + release-pipeline doc + the documented 'binary absent ⇒ feature ships inert' gotcha that already applies to ffmpeg.exe), adding ~50-100 MB?
5. Settings gating: keep the thumbnail engine always-on (current Aura behavior) or add a Settings toggle (the reference implementation exposes a player-layout 'trickplay/thumbnail' setting) + a kill-switch env var. Recommendation: always-on + env kill-switch.

## Risks

- First-hover latency (Option A): cold TLS/DNS + open + keyframe seek on a remote debrid stream can exceed the accepted 2-3 s on the FIRST hover; ffmpeg is one-shot so there's no persistent warm decoder. Warm re-hovers are instant (cache). Acceptable per user but inherently slower-cold than the reference implementation's warm mpv subprocess.
- Seek-accuracy tradeoff: '-ss before -i' is fast but keyframe-snapped (off by up to one GOP, ~2-10 s on some remuxes); '-ss after -i' is exact but decodes from 0 (too slow). the reference implementation accepts keyframe snapping (seek ... "keyframes"). Replicate that and either trust the requested bucket for the label or parse true PTS via an ffmpeg showinfo filter.
- (Option B) Aura ships NO mpv.exe today — only DLLs + ffmpeg.exe. Bundling mpv.exe repeats the documented ffmpeg.exe 'git-ignored ⇒ feature ships inert' gotcha and adds ~50-100 MB to the installer. Named-pipe path and CREATE_NO_WINDOW are Windows-correct but untested on this build.
- Concurrency: every backend MUST single-flight + supersede rapid hovers. Aura's frontend already does (thumbReqRef + thumbUrlSec===hoverIntSec gate). The Rust side must also drop/kill superseded extractions (kill_on_drop on the ffmpeg child, or the reference implementation's request-id pending map) or stale CPU piles up during fast scrubbing.
- HDR streams: ffmpeg/mpv without a tonemap filter renders HDR thumbnails grey/washed vs the live mpv2 gpu-next output. the reference implementation sets screenshot-tag-colorspace=no; ffmpeg needs an explicit zscale/tonemap filter or HDR thumbs look dark. Low severity (thumbnails are tiny) but visible — add tonemap only if it looks bad.
- Bridge bypass: do NOT route the extraction URL through Aura's 127.0.0.1:11471 bridge for HTTPS (same TLS-cert-mismatch that breaks main playback). Pass the direct streamUrl exactly as the main player receives it, and apply the same -protocol_whitelist http,https,tcp,tls,crypto guard silencedetect uses.
- Option A/B run OUTSIDE the main mpv2 render instance, so landmines #2 (WASAPI exclusive), #3 (get_property during seek crit-section), #4 (observed-property channel break) do NOT apply. Only Option C re-enters that danger zone — a strong reason to avoid C.
