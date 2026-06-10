# Render-API Rewrite — Phase 7: Retire the legacy plugin (UNBLOCKED 2026-06-03 — thumb ported)

Status: UNBLOCKED (2026-06-03), ready to execute. Branch `feat/render-api-rewrite`
(stale — main has since absorbed the engine; execute from a fresh branch off `main`).
Was PAUSED 2026-06-02 on the thumb-instance decision; STAGED 2026-05-29.

> **✅ BLOCKER RESOLVED 2026-06-03 — option (b) chosen and implemented.** The
> thumbnail extractor no longer touches `tauri-plugin-libmpv`: it was ported to a
> headless `mpv2` FFI instance (`src-tauri/src/mpv2/thumb.rs`, a self-owned
> `vo=null` `mpv_handle` on a dedicated worker thread; `player.rs::extract_thumbnail`
> now delegates to `mpv2::thumb::extract`). Compile-verified (`cargo check` +
> `tsc`); awaiting HW smoke test of hover thumbnails. With this, the plugin is used
> ONLY by the legacy `--wid` main-playback fallback (`AURA_MPV2=0`), so Phase 7's
> remaining job is exactly the changeset below. **Re-confirm every anchor BY
> CONTENT (line numbers have drifted further) and use the compiler as the worklist
> (remove `MpvExt` imports first → `cargo check` lists every `app.mpv()` site).**
> The BLOCKER note below is retained for history.

> **⚠ BLOCKER found 2026-06-02 — do NOT apply this changeset as-is; it is
> incomplete and would BREAK hover thumbnails.**
>
> 1. `tauri-plugin-libmpv` / `MpvExt` / `app.mpv()` is ALSO used by THREE modules
>    this changeset never lists — `aniskip.rs:11`, `cinema.rs:13`, `subtitles.rs:10`.
>    Those are SAFE (each already has the `enabled() && is_running()` engine gate,
>    so the legacy body deletes cleanly) but MUST be included in the sweep.
> 2. **The real blocker:** `player.rs::extract_thumbnail` (~L581) runs a SEPARATE
>    headless libmpv instance ("thumb") entirely through the plugin
>    (`app.mpv().init(cfg, "thumb")`, `MpvConfig`, command/get_property on "thumb").
>    It has NO engine equivalent — the mpv2 engine is the single MAIN playback
>    instance (one video + render context) and can't extract thumbnails while it
>    is playing the real video. Removing the plugin breaks the hover-thumbnail
>    feature.
>
> **Decision required before applying** (user paused 2026-06-02 to design this):
> (a) keep the plugin ONLY for the thumb instance — remove it from the whole MAIN
> playback path (engine becomes the only playback path; `libmpv-wrapper.dll` still
> needed for thumbs); or (b) port the thumb extractor to a headless `mpv2` FFI
> instance (`mpv_create`/`mpv_initialize`/`mpv_command`/`mpv_get_property`/
> `screenshot-to-file` — no render context) and THEN fully remove the plugin. (b)
> is the clean end-state but adds new unsafe FFI to a point-of-no-return change and
> needs its own HW validation (headless FFI screenshots).
>
> Also: re-confirm every anchor by CONTENT — the line numbers below drifted (many
> commits since 2026-05-29). Use the compiler as the worklist (remove the `MpvExt`
> imports first; `cargo check` then lists every `app.mpv()` site to convert).

This is the ordered changeset that deletes `tauri-plugin-libmpv` + the legacy
`--wid` path and makes the mpv2 render engine the *only* playback path. It is
**not applied yet, by design** — applying it removes the `AURA_MPV2=0`
fallback that the Phase 6 checklist A/B-tests against and relies on as a safety
net. Land it **only after a clean Phase 6 hardware pass**. (Ask me and I'll
execute the whole thing in one pass; `cargo check` + `tsc` after.)

## Point-of-no-return notes

- **This removes the legacy escape hatch.** After Phase 7 there is no
  `AURA_MPV2=0` fallback — if a regression shows up later, the recovery is
  `git revert`, not an env var. That's why it waits for the green pass.
- **`src-tauri/lib/libmpv-wrapper.dll`** is git-ignored (user-managed). Phase 7
  stops *loading/requiring* it; leave the physical file on disk (harmless once
  unreferenced) or delete it manually. Only `libmpv-2.dll` is needed afterward.
- Keep `libloading` in Cargo.toml — `mpv2/ffi.rs` uses it.

## Ordered changeset

### A. `src-tauri/Cargo.toml`
- Delete line 19: `tauri-plugin-libmpv = "0.3"`.

### B. `src-tauri/src/lib.rs`
- Delete `use tauri_plugin_libmpv::MpvExt;` (line 65).
- Delete the plugin registration `.plugin(tauri_plugin_libmpv::init())` (line 1891).
- **Startup (~2062–2103):** drop the `mpv2_active` branch. The engine is the
  only path now, so always spawn it; delete the `if !mpv2_active { player::init_mpv(...) } else {...}` block and the legacy init log. Keep the `mpv2_main_hwnd` resolution (the engine still needs a parent); if it's 0, log a hard error (no playback) — there's no legacy to fall back to anymore.
- Delete the legacy `init_mpv` re-init call inside `load_video` (line ~375).
- **The ~23 command handlers** (each currently `if mpv2::engine::enabled() && is_running() { return engine_call() } <legacy app.mpv()…>`): for each, **delete the legacy `app.mpv()` body** and convert the gate to an engine-or-error guard:
  ```rust
  // before
  if mpv2::engine::enabled() && mpv2::engine::is_running() { return engine_call(); }
  let mpv = app.mpv(); /* …legacy… */
  // after
  if !mpv2::engine::is_running() { return Err("mpv2 engine not running".into()); }
  return engine_call();
  ```
  Anchors (legacy `app.mpv()` lines to remove): 383, 449, 464, 498, 526, 580, 687, 726, 784, 852, 872, 894, 959, 988, 1014, 1039, 1064, 1123, 1213, 1324, 1398, 1458, 1530, 1608. (The `mpv2::engine::*` routing already present above each stays.)

### C. `src-tauri/src/mpv2/engine.rs`
- `enabled()` / `ENV_VAR` are moot without a legacy path. Either (recommended) **delete both** and drop the `enabled() &&` from every caller (handlers + window_logic), leaving `is_running()` as the only guard; or hardcode `enabled() -> true` to minimize churn. Update `start_if_requested` to no longer early-return on `!enabled()`.
- Leave the FSO fix + keep-display-awake (uncommitted) intact.

### D. `src-tauri/src/player.rs`
- Delete `use tauri_plugin_libmpv::{MpvConfig, MpvExt};` (line 6).
- Delete `init_mpv` (line 182 → end of fn) and its wrapper-workaround commentary.
- `check_mpv_dll` (line 118): remove the `libmpv-wrapper.dll` probe (lines 148–156); keep only the `libmpv-2.dll` probe (157–166). Update the doc comment (116–117) to drop the wrapper line.
- Prune anything else in player.rs that only existed for the legacy instance.

### E. `src-tauri/src/window_logic.rs`
- Delete `use tauri_plugin_libmpv::MpvExt;` (line 14).
- `pause_mpv` (line 295): delete the legacy `app.mpv().set_property(...)` branch (line ~316); keep only the engine path; `enabled() &&` → `is_running()`.
- Delete `shutdown_mpv_sync` (line 331) and its call at line 502 — the close path uses `mpv2::engine::shutdown_if_running()` only (already called).
- `enabled()` gates at 388, 443 → `is_running()` (or remove per C).

### F. Docs
- **README.md** (line 132): remove the `libmpv-wrapper.dll` requirement; state only `libmpv-2.dll` is needed.
- **HANDOFF.md**: line 16 (host owns "tauri-plugin-libmpv" → "direct libmpv-2.dll FFI via `mpv2`"); line 47 (player.rs row → drop wrapper probe + `init_mpv`, now mpv2 engine); lines 182 + 188 (the "consider migrating to mpv_render_context" / "plugin 0.3.2 pinned" notes → mark DONE / remove).
- **CLAUDE.md**: line 40 (`--wid` architecture → render-context engine, Aura-owned child HWND); line 75 (landmine #1 set_property-vs-command → now N/A under direct FFI; mark resolved); line 113 (DLLs → only `libmpv-2.dll`, drop the wrapper). Annotate the wrapper-fragility landmines (#3/#4) as legacy-era / re-validated under mpv2.

### G. Optional
- `mpv2/hello.rs` (Phase-1 scaffolding): keep behind `AURA_MPV2_HELLO` (cheap) or remove. Recommend keep.

## Verify (this is the legacy point-of-no-return — be thorough)
1. `cd src-tauri && cargo check --message-format=short` → 0.
2. `pnpm exec tsc --noEmit` → 0 (frontend untouched, but confirm).
3. `pnpm tauri build` → succeeds (confirms the dep removal + bundle).
4. Launch + quick playback sanity (engine is now the only path): play, seek, fullscreen, track switch, clean close.

## Commit
`feat(render-api): Phase 7 — retire tauri-plugin-libmpv + legacy --wid path`
(Co-author trailer per repo convention.)
