# Aura — End-of-Stream "Next-Up Spotlight" + Hover Episode Panel

Status: APPROVED (2026-05-19), implementing on branch `feat/ui-polish-correctness-batch`.
Frontend-only (the Rust `playback-end` event already distinguishes reasons — no Rust change).
No test framework — gates: `pnpm exec tsc --noEmit` (+ `cargo check` only if Rust is touched, which it should NOT be). The repo verify.cjs hook runs tsc after every Edit.

## Problem
At true end-of-stream Aura shows a FALSE "Stream connection lost" modal: mpv stops emitting
`time-pos`, and the 8s stale-heartbeat detector (App.tsx:580-594) fires. The real EOF signal
(`playback-end` with `reason:"eof"`, Rust lib.rs:1852-1908) is currently ignored by the
frontend (App.tsx:611 only handles `reason==="error"`). The dead `eof` state + its two dead
effects (App.tsx:3651, :1880) never fire because Rust never sets `PlaybackState.eof`.

## Decisions (locked)
1. Direction A — "Next-Up Spotlight": full-screen, dark blurred scrim, one focused next-up card.
2. Always show the EOS screen; a graceful END-CARD variant when there is no next episode
   (movie finished / series finale / last-aired with later season unaired). Uniformly removes
   the false popup for movies too.
3. In-playback episode list = hover-RIGHT-EDGE slide-in drawer (thin edge handle, ~150ms
   open-intent delay, ~300ms leave-grace, `useMenuOpenSync` so it freezes the control-bar
   auto-hide and swallows the dismiss click). SAME component opened by the Spotlight's
   "Episodes" button.
4. EOS detection = clean mpv EOF event OR playback halts within ~5s of duration (≈last 1%).
   Earlier halts = genuine break → EXISTING Reload/recovery modal unchanged.
5. NO settings — the EOS screen and the hover panel are hardcoded ON. Countdown reuses
   existing `autoAdvanceNextEpisode` / `autoAdvanceDelaySeconds`.
6. Spotlight next-episode thumbnail: if `blurUnwatchedThumbnails` is ON and the next episode
   is unwatched, show the SERIES art (poster/background) instead of a large blurred still.
   Synopsis still respects `blurEpisodeSynopsis` (blur + click-to-reveal).

## Components / changes

### Phase 1 — EOS detection + false-popup suppression (App.tsx)
- Repurpose the dead `eof`/EOS path into an `eosActive` state (or revive `eof` as the carrier).
- Add a `reason === "eof"` branch to the `playback-end` listener (App.tsx:611) → set eosActive.
- In the 8s stale-heartbeat detector (App.tsx:580-594): if `time>0 && duration>0 &&
  (duration - time) <= 5` → enter EOS (set eosActive) instead of `setStreamBroken(true)`.
- Remove/replace the dead `eof`→handleExitPlayback auto-exit effect (App.tsx:3651) and the
  dead "Hard EOF" NextUp forcer (App.tsx:1880) — the Spotlight now owns the EOS screen.
- Clear eosActive on `notifyNewLoad`/new `load_video` and on handleExitPlayback.
- Genuine break (>5s before end) path UNCHANGED (App.tsx:580-623 streamBroken → modal 4423-4487).

### Phase 2 — `src/EosSpotlight.tsx` (new) + App wiring
- App-level overlay sibling (like NextUpCta / the broken modal), gated `eosActive &&
  isPlayerActive`, `z-[10300]` (above PlayerOverlay 9999 / NextUpCta 10001, below the
  recovery modal 10500). Dark scrim consistent with the broken modal
  (`bg-black/75 backdrop-blur-md` family); MPV is a separate child window so scrim, do not
  CSS-blur the video.
- Mounting it hides the small `NextUpCta` (set `nextUpDismissedFor`/visibility — mutual
  exclusion). Reuse `resolveNextEpisode`/`pickFirstStreamForEpisode`/`nextUp.ts`.
- NEXT-UP state: thumbnail (series-art fallback per Decision 6), S/E tag (`formatEpisodeTag`),
  title, spoiler-gated synopsis, primary "▶ Play Next" (countdown ring iff
  `autoAdvanceNextEpisode`, seconds = clamp(`autoAdvanceDelaySeconds`,5,30), cancels on any
  pointer/key/wheel — reuse NextUpCta's countdown pattern), "Replay" (reload current @0),
  "Exit" (handleExitPlayback), "Episodes ▾" (opens shared EpisodePanel). Play Next →
  existing `onNextUpPlay` (App.tsx:1909). "no streams" → mirror NextUpCta `noStream` hint.
- END-CARD state (resolveNextEpisode → none): "You've finished {title}" (series: season note;
  "Caught up — S{n+1} not yet aired" when applicable), buttons Replay / Episodes (series) /
  Exit-Back. No countdown.

### Phase 3 — extract `SeasonSelect`, spoiler helper, build `src/EpisodePanel.tsx`
- Extract `SeasonSelect` (DetailView.tsx:1980, already prop-only `{seasons,value,onChange}`)
  → `src/SeasonSelect.tsx`; update DetailView to import it; behavior must be byte-identical.
- Create `src/episodeSpoilers.ts` — pure helpers mirroring DetailView's gate
  (`blurUnwatchedThumbnails`/`blurEpisodeSynopsis` + watched-state). LOW RISK: do not rewrite
  DetailView's internals; DetailView may keep its current logic (or use the helper only if a
  trivial swap). EpisodePanel MUST use the helper.
- `src/EpisodePanel.tsx`: right-side glass drawer using `.aura-glass-menu` + the universal
  text-shadow lift (App.css:374-416). Header = `SeasonSelect` + count; scrollable episode
  list from `MetaDetail.videos`, current/next highlighted, click → play (handlePlayStream /
  the stream-pick path). Spoiler parity with DetailView (same keys), scrim a touch stronger
  for legibility over bright video. Wire the Spotlight "Episodes" button to open it.

### Phase 4 — hover-right-edge trigger (PlayerOverlay.tsx)
- Mount EpisodePanel inside the overlay tree (pointer-events-auto, z-[10000] like other
  submenus). Thin always-present right-edge handle (~8px + chevron); hover/click expands;
  ~150ms open-intent delay, ~300ms leave-grace; `useMenuOpenSync(open)` for auto-hide
  coordination + dismiss-click swallow (same pattern as AniSkipMenu/SubtitlePicker).

### Phase 5 — REMOVED (no settings, per Decision 5).

## Edge cases / non-regression
- Genuine break >5s from end → existing recovery/Reload modal unchanged.
- Next-stream fetch fail → Play Next becomes a "no source" hint; Replay/Exit/Episodes work.
- Exit→handleExitPlayback, Play Next→onNextUpPlay — both already carry this pass's
  History/scrobble fixes; reload-survival invariant untouched.
- Constraint: project hooks block the Write tool — create NEW files via PowerShell
  Set-Content (UTF8); edit existing files via Edit. Honor CLAUDE.md (no Rust/MPV changes
  expected here).

## Verification matrix (manual)
clean-EOF: series-with-next / finale / movie. near-end stall ≤5s (→Spotlight) vs early
stall >5s (→recovery modal still shows). auto-advance on/off (countdown). hover panel
open/close not fighting auto-hide; edge handle not a hair-trigger. spoiler parity with
DetailView incl. the series-art thumbnail fallback. NextUpCta suppressed under Spotlight.
Gate: `pnpm exec tsc --noEmit` clean.

## Build order
1 → 2 → 3 → 4 (sequential; 5 removed).
