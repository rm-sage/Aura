# Playback-polish dedicated pass — design (2026-06-01)

A single dedicated pass covering three independent playback fixes carried over
from `2026-05-30-playback-polish-findings.md`:

- **Part A** — hover-thumbnail stale frame (correctness)
- **Part B** — subtitle ordering + selection-highlight consistency
- **Part C** — motion-interpolation anime gate

Each part is isolated (no shared state), so they can be built and verified in
any order. Verification gate for every part:
`cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`.
Parts A and B2 (highlight) additionally require on-hardware eyeballing — they
are fragile/timing-sensitive and must not be claimed "done" from a green build
alone.

---

## Part A — Hover-thumbnail stale frame

### Symptom
Hovering 00:48 shows that frame; then hovering 13:44 (≈13 min away) still shows
the 00:48 frame.

### Re-diagnosis (the findings doc was wrong here)
The findings doc blamed keyframe granularity ("the same keyframe for a range of
nearby seconds"). That cannot explain frames ~13 minutes apart — they are far
beyond any GOP. The frontend supersession logic in `PlayerOverlay.tsx`
(`thumbReqRef` request-id + the `thumbUrlSec === hoverIntSec` render gate,
~L2400–2472) is sound: a stale image cannot paint at a different hover position
*unless the Rust side actually returned the stale frame's bytes labelled with
the new timestamp*.

The real bug is in `src-tauri/src/player.rs::extract_thumbnail`
(~L644–697). After `seek absolute+exact`, the confirmation loop only checks that
**`playback-time`** reached the requested target (±0.5 s). But `playback-time`
tracks the **demuxer** position, which can reach the target *before the decoded
frame advances*. `screenshot-to-file ... video` then captures the previously
decoded frame (00:48) while the function reports `at ≈ 824`. That poisons the
frontend cache (`c.set(Math.floor(res.at), …)`) and paints the old image at the
new position — exactly the reported symptom.

### Fix — frame-step + verify (decode-accurate, no perf change)
In the per-attempt body of `extract_thumbnail`, after `playback-time` confirms
the seek target:

1. **Force a decoded frame at the new position.** Issue a `frame-step` command
   on the `"thumb"` instance so libmpv decodes the frame *at* the sought
   position before the screenshot. (The instance is paused with `vo=null`; a
   single `frame-step` advances exactly one decoded frame.)
2. **Verify honesty after the step.** Re-read `playback-time` (format `"double"`
   only — never `"node"`, landmine #3) *after* the frame-step for the returned
   `at`. If it is still outside the ±0.5 s tolerance from the request, treat the
   attempt as not-confirmed and fall through to the next retry (the existing
   `0..6` loop). Only screenshot + return when the post-step time matches.
3. The returned `ThumbResult.at` is this post-step `playback-time` (falls back to
   the requested target if the read fails, as today).

### Explicitly out of scope (perf angle dropped)
The findings doc's "decode at reduced resolution to cut load time" is dropped:

- Output is **already** scaled (`vf scale=320:-2`, `player.rs:594`); that vf runs
  *after* decode, so it cuts screenshot/encode cost, not the 4K-HEVC decode cost.
- The only real decode-time lever is keyframe-snap seeking (`hr-seek=no`), which
  snaps to the nearest keyframe and would **reintroduce frame inaccuracy** — the
  opposite of this fix's goal. Lowres decode is unsupported on HEVC; hwdec is
  deliberately off for predictable headless screenshots.
- User confirmed load time is acceptable. This part changes *which* frame is
  returned, not *how fast*.

### Validation (on hardware)
Temporarily `devlog!` the requested vs. returned `playback-time` per thumb
during testing. Hover far-apart positions on a 4K HEVC remux and confirm each
thumbnail matches its tooltip timestamp. Remove the instrumentation before
commit (or gate behind an existing verbose flag).

### Landmine compliance
- `playback-time` reads stay format `"double"` (never `"node"`).
- The `"thumb"` instance remains serialized under `THUMB`'s mutex, paused,
  `vo=null`, `idle` — landmine #3's seek-race (main instance vs. Lua seeks) does
  not apply.
- No change to observed properties (`frame-step` is a command, not a property).

### Files
- `src-tauri/src/player.rs` — `extract_thumbnail` retry body only.
- No frontend change (the cache/gate logic is already correct).

---

## Part B — Subtitle ordering + selection highlight

### B1 — Ordering

**Root cause.** `src-tauri/src/stremio.rs::fetch_external_subtitles`
(~L3834–3901) fans out per-addon with a `tokio::task::JoinSet` and collects via
`join_next()` — i.e. **network-completion order, non-deterministic**. The
`subDropdownItems` comment in `PlayerOverlay.tsx` (~L1604) claiming the list is
"already addon-installed order" is therefore **false**.

**Desired precedence** (embedded file subs always first, then the externals
group sorted by):
1. **OpenSubtitles bucket** — subs from an installed OpenSubtitles addon float
   to the top *as a group*.
2. **Preferred language** — within and below the bucket, the user's preferred
   subtitle language sorts first.
3. **Addon-installed order** — breaks remaining ties.

Self-gating note: the OS bucket only has members when an OpenSubtitles **addon**
is installed; if none is installed, the result is pure addon-installed order. The
`opensubtitles_api_key` is **not** a gate here — per user, that key only exists
for OpenSubtitles MovieHash matching, not as a subtitle source. No
`openSubtitlesKeySet` prop is introduced.

**Fix — two layers:**

1. **Rust (honest source order).** Replace the `join_next()` completion-order
   collection with index-preserving collection: spawn each addon task tagged
   with its index in the `addons` array, collect into per-index slots, then
   concatenate slots in `addons` order. The dedupe-by-URL (`seen` HashSet) is
   preserved, applied in addon order. Result: `fetch_external_subtitles` returns
   externals in installed-addon order deterministically.

2. **Frontend (bucket + language float).** In `subDropdownItems`
   (`PlayerOverlay.tsx` ~L1640–1730), apply a single **stable** comparator on
   the `externals` group with the key ladder:
   - primary: `isOpenSubtitles(addon_name)` (match `/opensubtitles/i`) — bucket
     to top;
   - secondary: preferred-language match (reuse the existing `preferredSubLang`
     logic, currently a separate `.sort` at ~L1704);
   - tertiary: preserved input order (= addon-installed order from layer 1, since
     `Array.prototype.sort` is stable in V8).

   The existing standalone preferred-language `.sort` is folded into this single
   comparator so the three keys compose correctly (today's separate sort would
   otherwise undo the bucket). Identification uses `ExternalSubtitle.addon_name`,
   already carried on each entry — no new wire field.

**Files**
- `src-tauri/src/stremio.rs` — `fetch_external_subtitles` collection order.
- `src/PlayerOverlay.tsx` — `subDropdownItems` comparator (fold the existing
  preferred-lang sort into one stable ladder).

### B2 — Selection-highlight consistency

**Root cause.** The menu's "selected" indicator derives from `get_tracks`'
per-track `selected` flag → `tracks` → `embeddedSubTracks` → `subDropdownItems`,
refreshed only on the **immediate** `aura:tracks-refresh` event the pick handlers
fire (`PlayerOverlay.tsx` ~L1354–1375, handlers ~L2154–2233). That immediate
re-read races libmpv committing the new `sid`, so the freshly-read `selected`
flags can still reflect the *old* track — the highlight drifts from reality.

**Fix — optimistic local highlight + delayed reconcile** (no new mpv property
reads — respects landmines #3/#4, which forbid observing/polling `sid`):

1. Add local state `selectedSubId: number | null` in PlayerOverlay. On every sub
   pick (embedded id, external negative id resolved to its live id once added,
   or "Off"/null), set `selectedSubId` immediately → the menu highlights the
   chosen row instantly, independent of mpv's commit latency.
2. The menu's "selected" rendering prefers `selectedSubId` when set, falling back
   to the track-list `selected` flag (so unmanaged/auto-selected tracks still
   highlight on first populate).
3. **Reconcile** with authority: fire the `get_tracks` refresh both immediately
   (as today) **and** once more after a short delay (~150 ms) so the second read
   lands after mpv commits the `sid`. When the reconciled track-list disagrees
   with `selectedSubId`, the authoritative track-list wins (clears the optimistic
   value) — so the optimistic value can never get *stuck* wrong.
4. `subsMuted` interaction unchanged: when subs are muted/off, nothing is
   selected (existing `t.selected && !subsMuted` gate is mirrored for
   `selectedSubId` — muting clears it).

**Files**
- `src/PlayerOverlay.tsx` — `selectedSubId` state, pick handlers, the
  `aura:tracks-refresh` effect (add the delayed reconcile), and the selected-row
  rendering in `subDropdownItems` / `TrackMenu`.

---

## Part C — Motion-interpolation anime gate

Frame interpolation ("soap-opera effect") is the defensible default only for
anime; on 24fps live-action it adds judder and extra VO drops (logs showed this
on a 4K movie). Gate it to anime.

**Three coordinated changes:**

1. **Effect gate (authoritative).** At the per-load apply site
   (`src/App.tsx:1348`), `animeFlag` is already computed in scope (L1328).
   Change the apply to:
   ```ts
   invoke("set_motion_interpolation", {
     enabled: !!motionInterpolation && animeFlag,
     tscale: interpolationTscale ?? "mitchell",
   })
   ```
   Interpolation therefore only ever *applies* for anime, regardless of the
   persisted preference.

2. **In-player toggle.** Thread an `isAnime: boolean` prop into PlayerOverlay
   (App computes `isAnimeMeta(activeTarget)` — already done at `App.tsx:3835`)
   down to the three-dots menu component that owns `toggleInterp`
   (`PlayerOverlay.tsx` ~L3160). When `!isAnime`:
   - render the toggle **disabled** (greyed, `aria-disabled`, no pointer toggle);
   - attach a tooltip: *"Anime only — interpolation adds judder/drops on
     live-action."*;
   - `toggleInterp` early-returns (no settings write, no invoke).

3. **Settings toggle.** Keep the global preference **enabled** (it is config, not
   a playback action) and add helper text under it: *"Applies to anime only."*
   Rationale: Settings is usually open when nothing is playing, so disabling it
   on transient playback state would leave it permanently greyed. The effect gate
   (change 1) is what actually enforces "anime only", so a non-anime title with
   the pref on simply no-ops at apply time. *(This intentionally refines the
   findings doc's literal "disable the Settings toggle" — confirmed with user.)*

**Files**
- `src/App.tsx` — one-line apply gate (L1348) + pass `isAnime` prop to
  PlayerOverlay.
- `src/PlayerOverlay.tsx` — accept `isAnime`, disable + tooltip the in-player
  toggle, no-op `toggleInterp` for non-anime.
- `src/views/SettingsView.tsx` — helper text on the motion-interpolation toggle.

---

## Build sequence (suggested)

1. **Part C** (smallest, no fragile code) — apply gate + prop + UI states.
2. **Part B1** (Rust order + frontend comparator) — pure logic, build-verifiable.
3. **Part B2** (highlight) — needs live eyeballing of selection drift.
4. **Part A** (frame-step) — fragile libmpv; do with user available to eyeball.

Each part: `cargo check` + `tsc --noEmit` green before moving on. Parts A and B2
also require an on-hardware pass before being called done.

## Open assumptions (stated, not blocking)
- OpenSubtitles subs reach the picker via an **installed OpenSubtitles addon**
  (the dedicated REST path in `subtitles.rs` is dormant — "UI removed Phase
  6.0.5"). If no OS addon is installed, ordering is pure addon order. Confirmed
  with user.
- `frame-step` on a paused `vo=null` instance advances exactly one decoded frame
  on this libmpv build. To be confirmed during Part A hardware validation; if it
  misbehaves, fall back to a brief post-seek decode wait + screenshot-changed
  check (hash the prior bytes) as the verify mechanism.
