// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// The player's top-left stack: the skip prompt (PlayerOverlay), then the Next
// Up card or its standalone tail note (NextUpCta, rendered by App). They live
// in different components, so the prompt publishes where the next slot starts
// as a CSS custom property on <html>, and the card's `top` reads it with the
// prompt's own top as the fallback. No prompt (or a faded one): the card
// takes the prompt's place, and a CSS transition on `top` slides it there.
// ---------------------------------------------------------------------------

const STACK_TOP_VAR = "--aura-player-stack-top";
/** Space between the prompt and whatever stacks under it. */
export const PLAYER_STACK_GAP_PX = 12;
/** One width for every surface in the stack (prompt, card, tail note), so
 *  their edges line up instead of stepping in and out. Capped for a narrow
 *  window. Paired with the same horizontal padding (`px-6`), so the text of
 *  each starts on one line too. */
export const PLAYER_STACK_WIDTH = "min(28rem, calc(100vw - 3rem))";

/** The stack's first slot: clears the "Exit playback / title" header, which
 *  starts at 16 px in fullscreen and 16 + 36 = 52 px windowed and is about
 *  64 px tall. */
export function playerStackBaseTop(isFullscreen: boolean): number {
  return isFullscreen ? 96 : 132;
}

/** `top` for an element under the skip prompt. */
export function playerStackTop(isFullscreen: boolean): string {
  return `var(${STACK_TOP_VAR}, ${playerStackBaseTop(isFullscreen)}px)`;
}

/** Called by the skip prompt: the bottom edge of the visible prompt, or null
 *  when there is none to stack under. */
export function publishPlayerStackTop(promptBottomPx: number | null): void {
  const root = document.documentElement.style;
  if (promptBottomPx == null) root.removeProperty(STACK_TOP_VAR);
  else root.setProperty(STACK_TOP_VAR, `${Math.round(promptBottomPx + PLAYER_STACK_GAP_PX)}px`);
}
