# Playback-Polish Dedicated Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three carried-over playback issues in one pass — hover-thumbnail stale frame, subtitle ordering + selection-highlight drift, and motion-interpolation gated to anime.

**Architecture:** Three independent fixes with no shared state. Part C is a small gating change (UI + apply path). Part B reorders the Rust subtitle fan-out and adds a stable frontend comparator + optimistic selection state. Part A makes the headless thumbnail decoder produce an honest frame via `frame-step` + post-step time verification.

**Tech Stack:** Rust (Tauri commands, libmpv via the in-tree wrapper), React 19 + TypeScript, Tailwind.

> **No test framework in this repo.** Per `CLAUDE.md` the only correctness gates are `cargo check` and `tsc --noEmit`. Each task's verification step runs those. Parts A and the Part B2 highlight additionally require **on-hardware eyeballing** — do not claim them done from a green build alone. The full verification cycle is:
>
> ```bash
> cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit
> ```

---

## Build order

Fragile/timing-sensitive work last: **Task 1 (Part C)** → **Task 2 (Part B1 ordering)** → **Task 3 (Part B2 highlight)** → **Task 4 (Part A thumbnail)**.

---

## Task 1: Part C — gate motion interpolation to anime

**Files:**
- Modify: `src/App.tsx:1348` (apply gate) and the `<PlayerOverlay …>` render (~`src/App.tsx:5360`)
- Modify: `src/PlayerOverlay.tsx` — `Props` interface (~L995), component destructure (L1215), `<MoreMenu …>` call (L2273), `MoreMenu` signature (L3108), `toggleInterp` (L3161), interp toggle button (~L3286)
- Modify: `src/views/SettingsView.tsx:4695` (helper text)

- [ ] **Step 1: Gate the per-load apply path in App.tsx**

`animeFlag` is already in scope (computed at `App.tsx:1328`). At `src/App.tsx:1348`, change the invoke so interpolation only ever *applies* for anime:

```ts
          invoke("set_motion_interpolation", {
            enabled: !!motionInterpolation && animeFlag,
            tscale: interpolationTscale ?? "mitchell",
          }).catch(() => {});
```

- [ ] **Step 2: Pass `isAnime` to PlayerOverlay**

In the `<PlayerOverlay …>` JSX (after `activeTarget={activeTarget}` at `src/App.tsx:5361`), add:

```tsx
          isAnime={
            activeTarget
              ? isAnimeMeta({ media_type: activeTarget.media_type, id: activeTarget.id })
              : false
          }
```

(`isAnimeMeta` is already imported at `src/App.tsx:98`.)

- [ ] **Step 3: Add `isAnime` to PlayerOverlay's Props and destructure**

In `src/PlayerOverlay.tsx` `interface Props` (near L995), add after `activeTarget`:

```ts
  /** True when the active target is anime (isAnimeMeta). Gates the
   *  motion-interpolation toggle — interpolation is anime-only. */
  isAnime: boolean;
```

In the component destructure at `src/PlayerOverlay.tsx:1216`, add `isAnime,`:

```tsx
export default function PlayerOverlay({
  activeTarget,
  isAnime,
  time, duration, paused, volume, speed, buffering, bufferPct, firstFrameSeen,
```

- [ ] **Step 4: Forward `isAnime` to MoreMenu**

In the `<MoreMenu …>` call at `src/PlayerOverlay.tsx:2273`, add the prop:

```tsx
            <MoreMenu
              streamUrl={streamUrl}
              onRestart={() => seekAbsolute(0)}
              activeTarget={activeTarget}
              isAnime={isAnime}
              time={time}
              duration={duration}
              skipWindows={skipWindowsForScrub}
            />
```

- [ ] **Step 5: Accept `isAnime` in MoreMenu's signature**

At `src/PlayerOverlay.tsx:3108`, add `isAnime` to the params and the inline type:

```tsx
function MoreMenu({
  streamUrl, onRestart, activeTarget, isAnime, time, duration, skipWindows,
}: {
  streamUrl: string | null;
  onRestart: () => void;
  activeTarget: ActiveScrobbleTarget | null;
  isAnime: boolean;
  time: number;
  duration: number;
  skipWindows: AuraSkipWindow[];
}) {
```

- [ ] **Step 6: No-op `toggleInterp` for non-anime**

At `src/PlayerOverlay.tsx:3161`, guard the toggle:

```tsx
  const toggleInterp = () => {
    if (!isAnime) return; // anime-only — interpolation hurts live-action
    const next = !interp;
    setInterp(next);
    const current = loadAuraSettings();
    saveAuraSettings({ ...current, motionInterpolation: next });
    invoke("set_motion_interpolation", {
      enabled: next,
      tscale: loadAuraSettings().interpolationTscale ?? "mitchell",
    }).catch(() => {});
    showFlash(next ? "Motion interpolation on" : "Motion interpolation off");
  };
```

- [ ] **Step 7: Disable + tooltip the interp toggle button for non-anime**

Replace the interp `<button …>` opening tag (currently at `src/PlayerOverlay.tsx:3286-3296`, the `onClick={toggleInterp}` button) with a disabled-aware version. Replace from `<button` through the closing `>` of the opening tag:

```tsx
          <button
            type="button"
            onClick={toggleInterp}
            disabled={!isAnime}
            title={
              isAnime
                ? undefined
                : "Anime only — interpolation adds judder/drops on live-action"
            }
            className={`w-full flex items-center gap-3 px-4 py-2 text-left text-[13px]
                       transition-colors
                       ${isAnime
                         ? "text-white/85 hover:text-white hover:bg-white/[0.16]"
                         : "text-white/35 cursor-not-allowed"}`}
            role="switch"
            aria-checked={interp && isAnime}
            aria-disabled={!isAnime}
          >
```

(The toggle pill inside still reads `interp`; that's fine — when non-anime the button is greyed and non-interactive, and the apply path never enables it.)

- [ ] **Step 8: Add "anime only" helper text to the Settings toggle**

At `src/views/SettingsView.tsx:4695`, append to the `description` string of the Motion-interpolation `SettingToggle` (keep the toggle enabled — it's a global preference):

```tsx
                description="mpv's built-in GPU frame interpolation (video-sync=display-resample). Smooths low-frame-rate content (24 fps film, anime) on a high-refresh display. GPU-cheap. Tune the look with the kernel dropdown below. Applies to anime only — it is skipped on live-action, where it adds judder."
```

- [ ] **Step 9: Verify**

Run: `cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`
Expected: both succeed, no errors. (No Rust change in this task, but run the full cycle for consistency.)

- [ ] **Step 10: Commit**

```bash
git add src/App.tsx src/PlayerOverlay.tsx src/views/SettingsView.tsx
git commit -m "feat(player): gate motion interpolation to anime only

Effect gate at the per-load apply site (enabled && animeFlag), in-player
toggle disabled+tooltip for non-anime, Settings toggle kept as a global
pref with 'anime only' helper text."
```

---

## Task 2: Part B1 — deterministic subtitle ordering

**Files:**
- Modify: `src-tauri/src/stremio.rs` — `fetch_external_subtitles` collection (~L3845-3900)
- Modify: `src/PlayerOverlay.tsx` — `subDropdownItems` externals sort (~L1675-1711)

- [ ] **Step 1: Preserve addon order in the Rust fan-out**

The current collection uses `JoinSet::join_next()` (completion order). Replace the spawn loop **and** the collection block in `src-tauri/src/stremio.rs::fetch_external_subtitles`.

Change the JoinSet type and tag each task with its addon index. Replace:

```rust
    let mut set: tokio::task::JoinSet<Vec<ExternalSubtitle>> = tokio::task::JoinSet::new();
    for addon in addons {
        let media_type = safe_type.clone();
        let id         = safe_id.clone();
        set.spawn(async move {
```

with:

```rust
    let slot_len = addons.len();
    let mut set: tokio::task::JoinSet<(usize, Vec<ExternalSubtitle>)> = tokio::task::JoinSet::new();
    for (idx, addon) in addons.into_iter().enumerate() {
        let media_type = safe_type.clone();
        let id         = safe_id.clone();
        set.spawn(async move {
```

Then change the task's final expression from `kept` to `(idx, kept)`. The current last lines of the async block are:

```rust
            crate::devlog!(info, "subtitles", "[{}] → {} subtitle(s)", label, kept.len());
            kept
        });
    }
```

Change to:

```rust
            crate::devlog!(info, "subtitles", "[{}] → {} subtitle(s)", label, kept.len());
            (idx, kept)
        });
    }
```

(There is also an early `return vec![];` on every failure path inside the async block — change each of those to `return (idx, vec![]);`. There are six: manifest-fetch fail, no subtitle resource, request fail, HTTP error, JSON parse fail, and no `subtitles` array. `idx` is `usize` (Copy) and in scope. Tip: `grep -n "return vec!\[\];" src-tauri/src/stremio.rs` to find them all.)

Then replace the collection block:

```rust
    let mut all: Vec<ExternalSubtitle> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    while let Some(task_result) = set.join_next().await {
        if let Ok(items) = task_result {
            for s in items {
                if seen.insert(s.url.clone()) {
                    all.push(s);
                }
            }
        }
    }

    Ok(all)
```

with index-preserving collection:

```rust
    // Collect into per-addon slots so the merged list follows installed-addon
    // order regardless of which network task finished first. JoinSet yields in
    // completion order — relying on that scrambled the subtitle list (the
    // ordering bug). Dedupe-by-URL is applied in addon order.
    let mut slots: Vec<Vec<ExternalSubtitle>> =
        std::iter::repeat_with(Vec::new).take(slot_len).collect();
    while let Some(task_result) = set.join_next().await {
        if let Ok((idx, items)) = task_result {
            if idx < slots.len() {
                slots[idx] = items;
            }
        }
    }

    let mut all: Vec<ExternalSubtitle> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for slot in slots {
        for s in slot {
            if seen.insert(s.url.clone()) {
                all.push(s);
            }
        }
    }

    Ok(all)
```

- [ ] **Step 2: Verify the Rust change compiles**

Run: `cd src-tauri && cargo check --message-format=short`
Expected: success, no errors.

- [ ] **Step 3: Add the stable externals comparator in the frontend**

In `src/PlayerOverlay.tsx::subDropdownItems`, two edits.

First, sort the **source** array before mapping (it carries `addon_name`, which the mapped `TrackEntry` does not). Replace the externals map header at L1675:

```tsx
    const externals: TrackEntry[] = externalSubs.map((s, idx) => {
```

with a pre-sorted source. Insert this block immediately **before** that line, then map `sortedSource`:

```tsx
    // Externals ordering: OpenSubtitles bucket → preferred-language →
    // addon-installed order. Array.sort is stable in V8, so equal-key pairs
    // keep the addon order the Rust fan-out now guarantees. OpenSubtitles is
    // self-gating: the bucket only has members when an OpenSubtitles addon is
    // installed (the API key is unrelated — it's only for MovieHash matching).
    const isOpenSubs = (s: ExternalSubtitle) => /opensubtitles/i.test(s.addon_name);
    const prefLang = preferredSubLang ? preferredSubLang.toLowerCase() : null;
    const sortedSource = [...externalSubs].sort((a, b) => {
      const aOs = isOpenSubs(a) ? 0 : 1;
      const bOs = isOpenSubs(b) ? 0 : 1;
      if (aOs !== bOs) return aOs - bOs;
      if (prefLang) {
        const aPref = (a.lang ?? "").toLowerCase().startsWith(prefLang) ? 0 : 1;
        const bPref = (b.lang ?? "").toLowerCase().startsWith(prefLang) ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
      }
      return 0; // preserve addon order (stable sort)
    });

    const externals: TrackEntry[] = sortedSource.map((s, idx) => {
```

Second, **delete** the now-redundant standalone preferred-language sort block (currently at L1704-1711):

```tsx
    if (preferredSubLang) {
      const pref = preferredSubLang.toLowerCase();
      externals.sort((a, b) => {
        const aPref = (a.lang ?? "").toLowerCase().startsWith(pref) ? 0 : 1;
        const bPref = (b.lang ?? "").toLowerCase().startsWith(pref) ? 0 : 1;
        return aPref - bPref;
      });
    }
```

Remove that entire block — its logic is now folded into `sortedSource`.

- [ ] **Step 4: Verify**

Run: `cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/stremio.rs src/PlayerOverlay.tsx
git commit -m "fix(subtitles): deterministic ordering — addon order + OpenSubtitles bucket

fetch_external_subtitles now collects into per-addon slots (was JoinSet
completion order, non-deterministic). Frontend folds the preferred-lang
sort into one stable comparator: OpenSubtitles bucket -> preferred-lang ->
addon order."
```

---

## Task 3: Part B2 — subtitle selection-highlight consistency

**Files:**
- Modify: `src/PlayerOverlay.tsx` — new `selectedSubId` state, the `aura:tracks-refresh` effect (~L1354-1375), the sub-pick handlers (~L2140-2233), and the `subDropdownItems` return (~L1713-1730)

- [ ] **Step 1: Add `selectedSubId` state and a per-file reset**

Add near the other subtitle state in `PlayerOverlay` (e.g. just above `embeddedSubTracks` at `src/PlayerOverlay.tsx:1425`):

```tsx
  // Optimistic subtitle selection. mpv's track-list `selected` flag lags a
  // switch by a beat, so the menu highlight drifted from reality right after
  // a pick. We record the user's intent here for instant feedback; the
  // delayed get_tracks reconcile (below) is authoritative. Reset per file so
  // a stale id can't match a different track after an episode change.
  const [selectedSubId, setSelectedSubId] = useState<number | null>(null);
  useEffect(() => {
    setSelectedSubId(null);
  }, [activeTarget?.id, streamUrl]);
```

- [ ] **Step 2: Add a delayed reconcile to the tracks-refresh effect**

In the effect at `src/PlayerOverlay.tsx:1354`, change the `onRefresh` handler so a track-mutating event triggers both an immediate read and a ~150 ms follow-up (after mpv commits the new `sid`). Replace:

```tsx
    const onRefresh = () => { if (!cancelled) refresh(); };
```

with:

```tsx
    const onRefresh = () => {
      if (cancelled) return;
      refresh();
      // Reconcile after mpv commits the new sid — the immediate read can
      // still report the OLD selected track. selectedSubId covers the gap.
      setTimeout(() => { if (!cancelled) refresh(); }, 150);
    };
```

- [ ] **Step 3: Set `selectedSubId` on every sub pick**

In the Subtitles `TrackMenu` handlers (`src/PlayerOverlay.tsx:2140-2233`):

In `onOff` (after `setSubsMuted(true);` at L2145), add:
```tsx
                  setSelectedSubId(null);
```

In `onPick`, the `id == null` branch (after L2161 `if (id == null) {`), add as the first line of the branch:
```tsx
                  setSelectedSubId(null);
```

In the external `matching` sub-branch (after `await invoke("set_subtitle_track", { track: matching.id });` at L2185), add:
```tsx
                      setSelectedSubId(matching.id);
```

In the external add branch (after `await invoke("add_subtitle_to_mpv", …)` resolves, just after the dispatch at L2210), add:
```tsx
                    setSelectedSubId(id); // negative menu id until the refresh swaps in the live track
```

In the embedded branch (after `await invoke("set_subtitle_track", { track: id });` at L2223), add:
```tsx
                  setSelectedSubId(id);
```

- [ ] **Step 4: Apply the optimistic highlight in `subDropdownItems`**

At the end of `subDropdownItems`, just before `return merged;` (`src/PlayerOverlay.tsx:1729`), insert:

```tsx
    // Optimistic override: when the user just picked a track, force its row
    // selected immediately. Guarded on the id still matching a visible row —
    // once an external is sub-added and swapped to its live (positive) id, the
    // negative selectedSubId no longer matches and we fall back to the
    // authoritative track-list `selected` flag. subsMuted = nothing selected.
    if (selectedSubId != null && !subsMuted && merged.some((t) => t.id === selectedSubId)) {
      merged = merged.map((t) => ({ ...t, selected: t.id === selectedSubId }));
    }
```

Add `selectedSubId` and `subsMuted` to the `useMemo` dependency array at `src/PlayerOverlay.tsx:1730` (subsMuted is already present — add `selectedSubId`):

```tsx
  }, [embeddedSubTracks, externalSubs, preferredSubLang, subsMuted, selectableSubLangs, selectedSubId]);
```

- [ ] **Step 5: Verify (build)**

Run: `pnpm exec tsc --noEmit`
Expected: success.

- [ ] **Step 6: Verify (on hardware)**

Launch (`pnpm tauri dev`), play a series episode with multiple addon subs. Switch subtitle tracks rapidly and confirm the highlighted row always matches the active track immediately, including switching an external (negative-id) entry that then becomes live. Confirm "Off" clears the highlight. This is the bug's actual surface — a green build is not sufficient.

- [ ] **Step 7: Commit**

```bash
git add src/PlayerOverlay.tsx
git commit -m "fix(subtitles): selection highlight reflects active track immediately

Optimistic selectedSubId on pick + a 150ms get_tracks reconcile after the
immediate one (mpv's track-list selected flag lags the switch). Override is
guarded so a stale id can never clobber the authoritative track-list."
```

---

## Task 4: Part A — hover-thumbnail honest frame (frame-step + verify)

**Files:**
- Modify: `src-tauri/src/player.rs` — `extract_thumbnail` retry body (~L668-696)

- [ ] **Step 1: Force a decoded frame and re-verify before screenshotting**

In `src-tauri/src/player.rs::extract_thumbnail`, replace the block from `if !confirmed { continue; }` (L668) through the end of the `if let Ok(bytes) = std::fs::read(&path) { … }` return (L696):

```rust
            if !confirmed { continue; } // try seek again

            // Force a decoded frame AT the sought position before grabbing it.
            // `playback-time` tracks the DEMUXER position, which can reach the
            // target before the decoder advances its OUTPUT frame — so a
            // screenshot here can capture the PREVIOUSLY decoded frame while we
            // report the new timestamp. That is the stale-thumbnail bug: a
            // far-away hover (e.g. 13:44) showed the old frame (e.g. 00:48).
            // A single frame-step on the paused, vo=null instance decodes
            // exactly one fresh frame at/near the target.
            let no_args: Vec<serde_json::Value> = vec![];
            let _ = mpv.command("frame-step", &no_args, "thumb");
            std::thread::sleep(std::time::Duration::from_millis(40));

            // Post-step playback-time is the honest timestamp of the frame we
            // are about to capture (frame-step nudges ~1 frame past target, so
            // allow 1.0 s). If it drifted further, retry the seek rather than
            // return a mislabelled frame. Format "double" only (never "node",
            // landmine #3).
            let actual_at = match mpv
                .get_property("playback-time".into(), "double".into(), "thumb")
                .ok()
                .and_then(|v| v.as_f64())
            {
                Some(pt) if (pt - at_seconds).abs() <= 1.0 => pt,
                _ => continue,
            };

            let _ = std::fs::remove_file(&path);
            mpv.command(
                "screenshot-to-file",
                &vec![serde_json::json!(path_fwd.clone()), serde_json::json!("video")],
                "thumb",
            )
            .map_err(|e| format!("thumb screenshot: {e}"))?;
            std::thread::sleep(std::time::Duration::from_millis(50));

            if let Ok(bytes) = std::fs::read(&path) {
                if !bytes.is_empty() {
                    let _ = std::fs::remove_file(&path);
                    return Ok(Some(ThumbResult {
                        data_url: format!("data:image/jpeg;base64,{}", b64_encode(&bytes)),
                        at:       actual_at,
                    }));
                }
            }
```

- [ ] **Step 2: Verify (build)**

Run: `cd src-tauri && cargo check --message-format=short`
Expected: success, no errors.

- [ ] **Step 3: Verify (on hardware) — temporary instrumentation**

Add a temporary devlog just before the `return Ok(Some(ThumbResult …))` to log requested vs. returned time:

```rust
                    crate::devlog!(info, "player", "thumb req={:.1} got={:.1}", at_seconds, actual_at);
```

Launch (`pnpm tauri dev`), play a 4K HEVC remux, and hover **far-apart** scrubber positions (e.g. 00:48 then 13:44). Confirm via DevConsole (`[player]`) that `got ≈ req` each time and the displayed thumbnail visibly matches its tooltip timestamp — no stale far-away frame. Then **remove the temporary devlog line** before committing.

- [ ] **Step 4: Fallback if `frame-step` misbehaves on this libmpv build**

If on-hardware testing shows `frame-step` does not advance/decode reliably (frame still stale, or `playback-time` doesn't move), switch the verify mechanism: hash the prior screenshot bytes and require the new screenshot to differ before returning; on no-change, `continue` the retry loop. Keep the seek-confirmation poll. (Only do this if Step 3 fails — the frame-step path is preferred.)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/player.rs
git commit -m "fix(thumbnails): return the frame at the sought position, not a stale one

extract_thumbnail now frame-steps after seek-confirm to force a fresh decode
at the target, then re-verifies playback-time before screenshotting. Fixes a
far-away hover showing a much earlier frame (playback-time/demuxer reaching
the target before the decoder advanced its output frame)."
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** Task 1 = Part C, Task 2 = Part B1, Task 3 = Part B2, Task 4 = Part A. All four spec parts mapped.
- **Type/name consistency:** `isAnime` (prop) is threaded App → Props → destructure → MoreMenu call → MoreMenu signature → `toggleInterp`/button. `selectedSubId` / `setSelectedSubId` used consistently in Task 3. `slot_len` captured before `addons.into_iter()` in Task 2. `actual_at` is the single source for the returned `ThumbResult.at` in Task 4 (the old second `get_property` read is removed).
- **Landmines respected:** all `playback-time` reads stay format `"double"`; no new observed/polled mpv properties (`selectedSubId` is React state, not an mpv `sid` poll); the `"thumb"` instance stays serialized/paused/`vo=null`.
