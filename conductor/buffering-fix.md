# Buffering Screen Bug Fix Plan

## Objective
Fix a bug where the loading/buffering overlay remains stuck indefinitely on screen after a stream starts to play.

## Key Files & Context
- `src/App.tsx`: Manages the global `usePlayback` state, including `buffering` and `firstFrameSeen`.

## Proposed Solution
When the first frame is rendered (indicated by `payload.time > 0` in the `playback-update` event), the `usePlayback` hook currently sets `firstFrameSeen` to true. However, because the old cache polling mechanism was removed to fix a crash, the `buffering` state (which is initialized as `true` during a new load) never gets reset to `false`. Because `BufferingOverlay` remains visible when either `!firstFrameSeen` OR `buffering` is true, the screen gets stuck.

We will update the `playback-update` listener in `src/App.tsx` to explicitly set `buffering` to `false` when the first frame is seen, ensuring the loading screen correctly dismisses.

## Implementation Steps
1. Modify `src/App.tsx`.
2. Locate the `playback-update` listener inside the `usePlayback` hook.
3. Inside the `if (payload.time > 0)` block where `setFirstFrameSeen(true)` is called, add `setBuffering(false);`.

## Verification & Testing
- Start the application and load any video stream.
- Observe the loading screen.
- Verify that the loading screen disappears completely as soon as the video frames start rendering.
- Verify that no regressions were introduced to playback controls.