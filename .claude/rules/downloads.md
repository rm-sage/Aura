---
paths:
  - "src-tauri/src/downloads/**"
  - "src-tauri/src/download_path.rs"
  - "src/Download*.tsx"
  - "src/downloads*.{ts,tsx}"
---

# Downloads

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: src-tauri/src/downloads/*, src-tauri/src/download_path.rs, src/Downloads*.tsx, src/downloads*.ts, src/DownloadRow.tsx.

### Downloads: two landmines and one governing rule

`src-tauri/src/downloads/` (engine) plus `src-tauri/src/download_path.rs` (path
safety) plus `src/Downloads*.tsx` / `src/downloads*.ts`. Right-click a source on
the DETAIL PAGE to download it; a title-bar button beside the service status chip
(`ServiceStatusChip.tsx`, formerly the Aura Cloud chip) opens the panel. Downloads are FILE downloads only: `load_video` still refuses
local paths and offline playback is not in scope.

Rust is authoritative; the React store is a projection that rehydrates from
`downloads_list`, because F5 and the stream-lost modal's Reload must not lose a
40 GB transfer. Two concurrent, promoted by a PUMP rather than a
`tokio::sync::Semaphore` (a Semaphore hands out permits in wait-arrival order,
which would make drag-to-reorder decorative). The control primitive is a
`watch` channel read in a **`biased`** select against the body read: without
`biased`, a pause issued while the body is stalled waits on a dead network
future, and a stalled body is the most common debrid failure.

**LANDMINE 1: never use `-ss` to resume an HLS download.** Measured against the
bundled ffmpeg 8.1.1 on a 5 x 6.000 s VOD playlist, `-ss 15` and `-ss 18`
produce BYTE-IDENTICAL output: on a mid-segment value ffmpeg lands on the start
of the containing segment, but on an exact segment BOUNDARY it lands one whole
segment early. A resume point is always a boundary, so the error is every
resume, not some, and the mpegts muxer rebases each run to the same origin so
the duplicated segment is invisible downstream. ffmpeg exits 0 with no
diagnostic. The offset is not a constant you can subtract (1 segment at
boundaries, 0 mid-segment, dependent on `#EXT-X-TARGETDURATION`, undocumented
`hls.c` behaviour), and correcting it needs `-copyts` plus `-to`, which is the
documented zero-bytes landmine. **No download-job ffmpeg invocation may pass
`-ss`, `-copyts`, `-t` or `-to`.** Mode A therefore fetches segments in Rust and
lets ffmpeg do exactly one local remux at the end; pause is byte-exact
(verified `cmp`-identical, including fMP4/CMAF). Mode B (encrypted or
discontinuous playlists) is a single ffmpeg pass and is genuinely NOT pausable,
so it says so; `JobKind` is written back once the admission gate has run,
because a job that lies about being pausable turns a Pause press into a silent
cancel.

**LANDMINE 2: a body that ends early looks exactly like success.** `chunk()`
returning `None` is not proof of completion (this is the mpv truncated-stream
bug from v2.0.1, in a different costume). Completion requires the byte count to
match what the origin promised. Likewise, when a host sends neither `ETag` nor
`Last-Modified` (common for debrid), a resume compares a 64 KiB tail hash before
appending: without it a rotated link answers 206 at the stored offset and two
different releases get spliced into one file that reports no error at all. Same
rule for a ranged HLS segment: a 200 to a `Range` request is the WHOLE resource,
and appending it yields K concatenated copies that ffmpeg remuxes happily.

**The governing rule in `download_path.rs`:** it does not try to model
`RtlGetFullPathName_U`, it emits only paths that are FIXED POINTS of it. Win32
strips trailing dots and spaces from every component before the kernel sees it,
which is why `".. "` is a traversal that passes a naive containment check.
Applying that strip ourselves, then re-validating, makes the traversal
structurally unrepresentable, and sound lexical containment follows. The module
also covers reserved device names (`CON.mkv` included), bidi and zero-width
spoofs, an extension ALLOWLIST (without it `payload.exe` lands), UTF-16 MAX_PATH
budgeting, and `create_new` collision claims. It does NOT normalize: NFKC maps
U+FF0F to `/` and U+FF1A to `:`, i.e. it manufactures path separators. 17 tests,
plus 10 for the HLS parser and relink guard.

`download_dir` is machine-local and is stripped from the cloud blob in BOTH
directions in `sync.ts`. Being absent from `PORTABLE_*_FIELDS` is NOT sufficient:
those gate file export/import, while `update_settings` shallow-merges whatever
the cloud sends. The `screenshot_dir` comment used to claim an exclusion it did
not have; it does now. `gpu_acceleration` ("Hardware acceleration") is
machine-local the same way and is not exported either: its one home is
`render.json` beside the settings dir (`settings.rs`), which every save writes,
every scope load reads back and the launch alone reads, so the switch shown is
what the next launch does (the settings cache starts from render.json too, so a
scope with no settings file cannot show or save the default). The HDR settings
(`hdr_mode`, `hdr_enabled`, `hdr_target_peak_nits`) share render.json and the
same sync / export exclusions (optional there: a file without them leaves the
scope's values until the next save writes them). It reaches WebView2
as browser arguments on the webview builders (`lib.rs::webview_browser_args`);
wry ignores the `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` variable. Every webview
sharing the main user data folder needs the SAME arguments (WebView2 refuses a
second environment with different options), so `SourcePopup.tsx` builds every
popup, OAuth or not, through the Rust `open_oauth_popup_webview` command, never
the JS `new Webview()` API.

Full design: `docs/superpowers/specs/2026-09-05-download-manager-design.md`.
