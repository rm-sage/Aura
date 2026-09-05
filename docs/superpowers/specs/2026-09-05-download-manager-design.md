# Download manager: design

Date: 2026-09-05. Status: approved, implementing.

Right-click a stream source on the detail page to download the file. A title-bar
button beside the Aura Cloud icon relays status and opens an anchored panel with
pause / resume / cancel. Download folder configurable in Settings, prompted for
on first use.

Downloads are FILE downloads. Aura does not gain offline playback: `load_video`
(`lib.rs:153-168`) still rejects local paths and that is not relaxed here.

## Decisions

| # | Decision |
|---|---|
| 1 | Scope: direct http(s) files AND HLS via ffmpeg remux. Magnet/infoHash rows show a disabled item with a reason. |
| 2 | Downloads never auto-pause during playback. Cap 2 concurrent; the rest are Queued. |
| 3 | Quitting with jobs in flight prompts, then keeps the partials. |
| 4 | No button in fullscreen (the title bar is unmounted there). Completion and failure still toast at PartyToast's z-index. |
| 5 | Organised layout by default, Settings toggle for flat. |
| 6 | Entry point is the detail page stream list only. |
| 7 | On expiry, silently re-fetch the source, re-match, and continue from the byte offset. |
| 8 | Extras in scope: Reveal, Copy link, free-space preflight, duplicate guard, taskbar progress, speed/ETA, drag-reorder. |
| 9 | HLS Mode B (encrypted / discontinuous playlists) is honestly not pausable and says so. |
| 10 | Four latent bugs found during design are fixed as part of this work. |

## Findings that shape the design

**Aura has no managed state.** `grep -rn "\.manage(\|tauri::State" src-tauri/src/`
returns nothing across 57 files; there are 69 module-level statics instead
(`settings.rs:473`, `scrobble.rs:579`). The engine uses a static, not
`tauri::State`.

**The capability identifier is bare.** `capabilities/default.json:28-30` lists
`"allow-load-video"`, not `"player:allow-load-video"`. The `plugin:` prefix is
for third-party plugins only. Getting this wrong is a silent 401.

**`-ss` resume for HLS silently corrupts.** Measured against the bundled ffmpeg
8.1.1 on a 5 x 6s VOD playlist: `-ss 15` and `-ss 18` produce byte-identical
4,493,012-byte output. On an exact segment boundary ffmpeg lands one whole
segment early. A resume point is always a boundary, so every resume duplicates
one segment mid-file, and the mpegts muxer rebases each run to the same origin
so the damage is invisible downstream. ffmpeg exits 0 with no diagnostic. The
offset is not a constant that can be subtracted: it is 1 segment at boundaries,
0 mid-segment, depends on `#EXT-X-TARGETDURATION`, and is undocumented
behaviour of `hls.c`. Correcting it would need `-copyts` plus `-to`, which is
the documented zero-bytes landmine.

**Rule: no download-job ffmpeg invocation ever passes `-ss`, `-copyts`, `-t` or
`-to`.** Both HLS modes read from byte zero to the end.

**Suspending ffmpeg is not a pause.** `NtSuspendProcess` exists, but the TCP
connections stall and debrid hosts drop idle sockets in tens of seconds;
`-seg_max_retry` defaults to 0, so the job dies on resume. Signed segment URLs
expire while suspended. A suspended process holds the output open with no
container trailer, so quitting leaves an unopenable file.

**Byte-concatenating HLS segments is exact.** Downloading segments 0-2,
remuxing, then appending 3-4 and remuxing again produced a `cmp`-identical
accumulation file and a bit-for-bit identical 30.023000s result. Verified for
fMP4/CMAF too (`#EXT-X-MAP` init segment written at byte 0, 30.023000s, exit 0).
Each HLS media segment is independently decodable and starts on a keyframe, and
MPEG-TS is a byte-concatenable packet stream.

## Four latent bugs, fixed here

1. **`handleVideoMouseDown` eats a left-click.** `PlayerOverlay.tsx:2144` takes
   no event and never tests `e.button`. React's `onMouseDown` fires for the
   secondary button; `onClick` does not, and `main.tsx` suppresses `contextmenu`.
   So a right-click while a menu is open arms `dismissNextClickRef` that no
   `click` ever consumes, and the user's next left-click on the video is
   silently swallowed. Latent today via `subsOpen`; reachable every session once
   right-click is a first-class gesture over the panel.
2. **`behaviorHints.proxyHeaders` is dropped.** `sanitize_stream`
   (`stremio.rs:3861-3939`) reads `url`, `infoHash`, `behaviorHints.filename`
   and `streamData.episodePack`, never `proxyHeaders` or `videoSize`. mpv sends
   its own Lavf UA and CLAUDE.md's HLS-bypass note exists because provider
   User-Agent gating is real. A stream that plays fine would 403 on download.
3. **The DetailView menu casts have no `disabled`.** `DetailView.tsx:5284` and
   `:5393` cast to `Array<{ label; icon?; onClick }>`, so a greyed-out magnet
   item is a `tsc --noEmit` failure.
4. **`screenshot_dir`'s doc comment is wrong.** `settings.rs:312-318` claims a
   cloud-sync exclusion that does not exist: `sync.ts:599-618` ships the whole
   `get_settings` object opaquely and `update_settings` (`settings.rs:850`)
   shallow-merges rather than whitelisting.

## Architecture

### Rust

`src-tauri/src/downloads/` with `mod`, `types`, `manager`, `http`, `hls`,
`store`, `space`, `taskbar`, `commands`, plus `src-tauri/src/download_path.rs`
as a standalone path-safety module.

State lives in a module-level `static MANAGER: OnceLock<Manager>` per house
style. The registry is a `Mutex<IndexMap<String, DownloadJob>>` (IndexMap is
already a dependency and preserves queue order for drag-reorder).

**Control primitive** is `tokio::sync::watch::Sender<Option<StopReason>>`, read
in a `biased` select against the body read:

```rust
tokio::select! { biased;
    _ = ctrl.changed() => return Ok(Outcome::Stopped(*ctrl.borrow())),
    chunk = resp.chunk() => { /* ... */ }
}
```

`biased` is load-bearing. Without it a pause during a stalled 60s read waits on
a dead network future, and the row sits at "Downloading" with a dead Pause
button. Stalled bodies are the single most common debrid failure mode.

**Scheduler** is a pump, not `tokio::sync::Semaphore`. A Semaphore is FIFO by
wait arrival, which would make drag-to-reorder theatre.

**Concurrency cap** 2, mirroring the house cap precedent at
`img_proxy.rs:109-118`.

### State machine

```rust
#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadState {
    Queued, Running, Paused, Relinking, Completed, Failed, NeedsSource,
}
```

`rename_all` on a unit-variant enum is safe: it is not a field rename, so the
`LibraryItem` hazard does not apply. No struct field in this subsystem carries
a rename of any kind.

`Running` is never a persisted state. A job loaded from disk in `Running`
becomes `Paused`.

| From | To | Trigger |
|---|---|---|
| - | `Queued` | enqueue passes duplicate, scheme and root checks |
| `Queued` | `Running` | pump sees `running < 2` |
| `Running` | `Paused` | user pause, or engine shutdown |
| `Running` | `Relinking` | worker reports expiry (401/403/404/410) |
| `Relinking` | `Running` | frontend re-matched the source |
| `Relinking` | `NeedsSource` | no match, or the 20s Rust-side timeout fired |
| `Paused` | `Queued` | resume |
| `Running` | `Completed` | worker finished and the length check passed |
| `Running` | `Failed` | terminal error |
| any | removed | cancel (worker deletes its own `.part`) |

### HTTP worker

One request, not a probe: `GET` with `Range` and `If-Range`. `total_bytes`,
`resumable` and the validator are learned from the response. No HEAD, because
some debrid hosts 405 on it, some signed links are single-use, and a HEAD/GET
`Content-Length` disagreement is a classic.

**Validator fallback.** When the host sends neither `ETag` nor `Last-Modified`
(common for debrid), compare a 64 KiB tail hash of the existing `.part` against
the same range re-fetched from the origin before appending. Without it a
rotated link answers 206 at the stored offset and two different releases get
spliced into one file.

**Truncation.** A `bytes_stream` that ends early looks exactly like success.
Completion requires `written == expected_len` when a length is known; otherwise
the job retries with a Range resume rather than renaming. `attempt` resets
after 1 MiB of progress, so a link that drops thirty times but advances is
healthy while one that dies at the same byte is dead.

`bytes_done` is derived from `fs::metadata(part).len()` and never persisted, so
steady state is zero disk writes for progress.

### HLS

Two modes, chosen by an admission gate evaluated at enqueue.

**Mode A, `hls-ledger` (primary).** Aura fetches segments serially with reqwest
into an accumulation file; ffmpeg does exactly one local `-c copy` remux at the
end. Pause is exact and byte-identical, resume is a segment index plus
`set_len` truncate, cancel deletes the work dir with no child running, progress
is exact from the `#EXTINF` sum. Peak disk 2.1x final size. ffmpeg is needed
only at the end.

**Mode B, `hls-passthrough` (fallback).** ffmpeg fetches and remuxes in one
pass. Not pausable: Pause is disabled with a reason. Cancel is `q` then
`taskkill /F /T`. Progress is `-progress pipe:1` `out_time_us` over the
`#EXTINF` sum. Peak disk 1.1x.

Admission gate, all must hold for Mode A:

| # | Condition | On failure |
|---|---|---|
| 0 | `#EXT-X-ENDLIST` present | **Refuse the job.** A live stream has no end to download. |
| 1 | No `#EXT-X-KEY` with `METHOD` other than `NONE` | Mode B (no AES crate in the graph) |
| 2 | No `AUDIO=` / `SUBTITLES=` rendition group | Mode B (demuxed renditions need a real mux) |
| 3 | No `#EXT-X-DISCONTINUITY` | Mode B (per-discontinuity timestamp offsets are not a byte concat) |
| 4 | 1..=20000 segments, every URI http(s) | Mode B |
| 5 | Body <= 4 MiB, not itself a master | Fail with reason |

`#EXT-X-BYTERANGE` is supported in Mode A as a `Range:` header plus a ledger
offset. `#EXT-X-MAP` is supported, init segment at byte 0. A master playlist
resolves exactly one level, picking the highest `BANDWIDTH`.

Relative URI resolution uses the `url` crate (already in `Cargo.lock:6354` via
reqwest/tauri). Hand-rolling RFC 3986 is a bug farm and a resolution bug means
downloading the wrong bytes.

Work dir is `<download_root>/.aura-incomplete/<job_id>/`, **under the user's
root, not `%TEMP%`**: `std::fs::rename` fails `ERROR_NOT_SAME_DEVICE` across
volumes and a cross-volume copy of an 8 GB file is not an atomic publish. No
file with the user-visible name exists until the final rename.

### Path safety (`download_path.rs`)

Supersedes `subtitles.rs:504-520` for downloads. That function filters
`/ \ : * ? " < > |` and caps at 180 chars, and misses: reserved device names,
trailing dots and spaces, control chars, bidi and zero-width characters,
normalization, and the `".."` return at `:509`.

The governing property: **the module does not model `RtlGetFullPathName_U`, it
emits only paths that are fixed points of it.** Sound lexical containment, no
traversal, and no trailing-strip surprise are all corollaries.

- NFC, **never NFKC**: NFKC maps U+FF0F FULLWIDTH SOLIDUS to `/` and U+FF1A to
  `:`, manufacturing path separators.
- 27 reserved stems including `COM0`, `LPT0`, `CONIN$`, `CLOCK$` and superscript
  aliases, matched on the pre-first-dot stem after its own trailing trim.
- Control chars `0x00-0x1F` and `0x7F-0x9F` mapped to spaces; 23 bidi /
  zero-width / plane-14 tag ranges deleted.
- Empty after sanitize falls back to a SHA-256 stem seeded on the job's own
  identity, so two unusable names cannot become one file.
- MAX_PATH budget: 259 file, 247 directory, 15 reserved for the ` (99)` and
  `.aurapart` suffixes, 180 root. Truncation is UTF-16 counted and cut on a char
  boundary, then re-validated. Byte-slicing a `String` at a non-char boundary
  panics, which is the common case for anime titles.
- Extension is an 18-container allowlist, not a suffix. It is a security
  control: without it `payload.exe` lands.
- Collisions use `create_new` as an atomic claim plus a ` (n)` walk, giving up
  at 99. NTFS is case-insensitive, so an `exists()` test misses `dune.mkv` vs
  `Dune.mkv`.
- `validate_root` canonicalizes (resolving 8.3 short names) and strips the
  `\\?\` verbatim prefix, which otherwise leaks into the UI and breaks
  `revealItemInDir`.
- Root liveness is revalidated at Settings save, at job creation, and at every
  resume. A pulled USB drive parks the job as resumable, not failed.

`windows-app-manifest.xml` gets **no** `longPathAware`. It is inert without the
machine-wide `LongPathsEnabled=1` admin opt-in, which Aura cannot set, and a
>260-char file is one Explorer and most players cannot open. A header comment
records this so it is not re-litigated.

Ordering constraints that will otherwise be got wrong: containment is proved
before any directory is created, so a rejected job leaves no stray folder; and
the final claim re-walks from `n = 1` rather than reusing the part's suffix,
because 40 minutes elapsed and `Dune.mkv` may have been freed.

### IPC

Five commands, not fourteen. Each needs all three registration sites.

| Command | Signature |
|---|---|
| `downloads_list` | `() -> Vec<DownloadJobDto>` |
| `downloads_enqueue` | `(req: EnqueueRequest) -> Result<DownloadJobDto, String>` |
| `downloads_control` | `(action: ControlAction) -> Result<Vec<DownloadJobDto>, String>` |
| `downloads_plan_path` | `(input: NameInput) -> Result<PlannedPath, String>` |
| `downloads_set_root` | `(path: String) -> Result<String, String>` |

`ControlAction` is one tagged enum (`Pause`, `Resume`, `Cancel`, `Retry`,
`Relink`, `Reorder`, `ClearFinished`, `PauseAll`) returning a fresh snapshot, so
the store never holds optimistic state.

Progress is **one coalesced snapshot on a timer**, never per-job events. Five
concurrent 40 GB jobs emitting per-chunk would flood IPC; `runtime-dep-progress`
is a global event throttled at 2 MB for a *single* job and is not a model to
copy at N.

Events: `downloads-snapshot` (the whole list, throttled to ~500 ms while
anything is running, immediate on a state transition).

### Identity and relink

Reuse `streamMatchKey` (`watchTogether/streamMatch.ts:11-14`,
`info_hash || filename || title.split("\n")[0]`) verbatim, so the download row
and the party highlight cannot disagree about "the same source". A bespoke
`sha256(filename ?? title)` would hash TamTaro's live cache-status and seeder
counts, which change between calls, and would miss every relink in exactly the
case the fallback exists for.

**Relink runs in TypeScript.** `streamQueryAddons` (`auraSettings.ts:614-620`)
reads `streamAddonUrls` from localStorage, which Rust cannot see.
Re-implementing the scoping in Rust is the exact bug CLAUDE.md documents for
auto-advance ("auto-advance used to skip that scoping and query addons the user
had excluded in Settings"). Rust marks the job `Relinking` and arms a 20s
timeout so a webview reload cannot wedge it.

A re-matched stream is accepted only when the match key is equal and, where a
length is known, `Content-Length` agrees. Otherwise the job goes to
`NeedsSource` with a Refresh action.

### Frontend

| File | Purpose |
|---|---|
| `src/downloadsStore.ts` | job list projection, mirrors `scrobbleRun.ts` |
| `src/downloadsPanel.ts` | open flag, three phases so the exit animation still owns Escape |
| `src/DownloadsButton.tsx` | the title-bar pill |
| `src/DownloadsPanelHost.tsx` | always-on mount, owns the dismiss listener |
| `src/DownloadRow.tsx` | one job row |
| `src/downloadsMenu.tsx` | one menu builder shared by both stream-row variants |

**The panel portals to `document.body`.** `ContextMenuHost` renders **inline**
at `z-[200]` (`ContextMenu.tsx:141`, `:279`) inside `.aura-app-shell`, which is
its own stacking context (`App.css:1111-1115`, `position: relative; z-index: 0`).
A panel at any z-index in that context buries its own row menus. Worse, the
*submenu* does portal out (`ContextMenu.tsx:391-400`), so a hover submenu would
appear while its parent menu is invisible.

Panel `z-[10047]`, clearing `AccountButton`'s open-state `z-[10046]`
(`AccountButton.tsx:95`). Anchored at `SIDE_PILL_TOP_PX = 44` (`SidePill.tsx:32`).

**Dismiss guard** is the first in the tree with a button test. Every existing
one (`NotificationsBell.tsx:99-105`, `AccountButton.tsx:52-57`,
`ContextMenu.tsx:236-242`) closes on right-click, which is the opposite of the
requirement, so the difference is commented in place.

```
if (e.button !== 0) return;
if (t.closest('[data-downloads-panel]')) return;
if (t.closest('[data-downloads-trigger]')) return;
if (t.closest('[data-aura-titlebar]')) return;
if (t.closest('[data-aura-context-menu]')) return;
close();
```

`data-aura-titlebar` goes on the title-bar root (`TitleBar.tsx:278`) because the
bar's clickable surface is mostly the anonymous full-bleed drag layer, which has
no identity of its own. `data-aura-context-menu` is added to the menu root
(`ContextMenu.tsx:276-279`) because a menu raised from a panel row is not a DOM
descendant of the panel.

**Do not pause the video** is one line: `PlayerOverlay.tsx:1327` becomes
`openMenuCount > 0 || subsOpen || downloadsOpen`, threaded exactly like
`subsOpen` (`App.tsx:9322-9323`). `useMenuOpenSync` is a dead end here:
`MenuTrackerCtx.Provider` is opened at `PlayerOverlay.tsx:2184` and a panel
rendered from App's overlay region resolves it to `null`, making
`menuTracker.ts:34` a silent no-op.

Entering fullscreen unmounts the anchor, so the panel closes immediately with no
exit animation rather than animating out from a control that is gone.

### Settings

Two backend fields beside `screenshot_dir`: `download_dir: String` (empty =
unset) and `download_organise: bool` (default true).

**The sync carve-out is mandatory and needs both directions.** `sync.ts:599-618`
ships the whole backend object opaquely and `update_settings` shallow-merges, so
a `D:\` root would sync to a laptop with no D drive. The `airingGroupBy`
carve-out at `sync.ts:648-668` is the wrong template: it operates on the
frontend blob read from localStorage. This needs a `readBackendSettings()`
round-trip inside `writeSettingsBlob` plus a delete in `readSettingsBlob`, and
covers `screenshot_dir` at the same time.

`download_organise` goes in `PORTABLE_BACKEND_FIELDS`. `download_dir` goes in
neither list.

## Build order

Each stage ends green on `cd src-tauri && cargo check --message-format=short`
and `pnpm exec tsc --noEmit`.

1. `download_path.rs` with its `#[cfg(test)]` adversarial table.
2. Engine core: types, manager, store, HTTP worker, commands, registration.
3. Settings fields, sync carve-out, quit gate, `sanitize_stream` extensions.
4. Frontend store, panel, button, row, App/TitleBar/PlayerOverlay wiring.
5. Detail-page context menu, Settings rows.
6. HLS Mode A ledger and Mode B passthrough.
7. Motion, taskbar progress, drag-reorder.

## Deliberately out of scope

Offline playback of downloaded files. Season-pack expansion into per-episode
files. Downloading a whole season in one action. AES-128 HLS decryption in
Mode A. Bandwidth throttling. A Storage-panel entry for the downloads folder
(`storage.rs:60-91` is a hard-coded four-entry list of `%USERPROFILE%`-relative
filenames and cannot represent a directory).
