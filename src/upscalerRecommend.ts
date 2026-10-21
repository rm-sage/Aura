// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// upscalerRecommend: which upscaler profile the player's Upscaler menu tags
// "Recommended" for what is playing. Import-free, so node can load it.
//
// The rule follows the content and the two resolutions, nothing else (Aura
// cannot measure the GPU, so the heavier "+" chains are never recommended):
//   • a video that already fills the screen needs no upscaler: None;
//   • anime by its resolution, as Anime4K's own guidance pairs them:
//     Mode A for 1080p, Mode B for 720p, Mode C for 480p / DVD;
//   • live action: FSRCNNX, the sharpest of the live-action profiles.
// Profile ids are cinema.rs PROFILES ids, which are stable.
// ---------------------------------------------------------------------------

export const UPSCALER_NONE = 0;
export const UPSCALER_FSRCNNX = 3;
export const ANIME4K_MODE_A = 7;
export const ANIME4K_MODE_B = 8;
export const ANIME4K_MODE_C = 11;

export interface UpscalerRecommendation {
  profileId: number;
  /** One line for the menu's footer: why this one. */
  reason: string;
}

/** The video's resolution class in "p": its height, or for a letterboxed
 *  wide frame (1920x800) the height a 16:9 frame of its width would have. */
export function videoClassP(width: number, height: number): number {
  if (!(height > 0)) return 0;
  const fromWidth = width > 0 ? Math.round((width * 9) / 16) : 0;
  return Math.max(height, fromWidth);
}

export function recommendUpscaler(opts: {
  anime: boolean;
  videoWidth: number;
  videoHeight: number;
  /** The screen's height in physical pixels. */
  screenHeight: number;
}): UpscalerRecommendation | null {
  const p = videoClassP(opts.videoWidth, opts.videoHeight);
  if (!(p > 0) || !(opts.screenHeight > 0)) return null;
  const screen = Math.round(opts.screenHeight);
  // Within 10 % of the screen: an upscaler has almost nothing to add.
  if (p >= screen * 0.9) {
    return {
      profileId: UPSCALER_NONE,
      reason: p > screen * 1.1
        ? `This ${p}p video is already sharper than your ${screen}p screen, so no upscaler is needed.`
        : `This ${p}p video already matches your ${screen}p screen, so no upscaler is needed.`,
    };
  }
  if (opts.anime) {
    const [id, mode] =
      p >= 900 ? [ANIME4K_MODE_A, "Mode A"]
      : p >= 600 ? [ANIME4K_MODE_B, "Mode B"]
      : [ANIME4K_MODE_C, "Mode C"];
    return {
      profileId: id,
      reason: `Recommended for ${p}p anime on your ${screen}p screen: Anime4K ${mode}.`,
    };
  }
  return {
    profileId: UPSCALER_FSRCNNX,
    reason: `Recommended for ${p}p live action on your ${screen}p screen: FSRCNNX (RAVU or FSR if playback stutters).`,
  };
}
