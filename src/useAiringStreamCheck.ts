// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// useAiringStreamCheck - runs airingCheck.ts's pass over the library: the
// stream addons are asked about an airing show's next episode once its listed
// air date is within a day, and an answer with streams marks it out
// (availableEarly.ts). Paused while the window is hidden and while anything
// plays; the rules and their reasons are in airingCheck.ts. DevConsole label
// `[airing-check]`.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry, LibraryItem, StreamFetchResult } from "./types";
import { streamQueryAddons } from "./auraSettings";
import { getMetaDetailFallback, peekCachedDetailsById } from "./metaCache";
import { getReleaseSignal } from "./releaseSignalStore";
import { libraryItemSeriesId } from "./libraryNormalize";
import { availableEarlyAt, countEpisodeEvidence, noteStreamsFound } from "./availableEarly";
import { useIdleGatedInterval } from "./useIdleGate";
import { isWindowHidden } from "./windowVisibility";
import {
  FIRST_PASS_DELAY_MS, PASS_INTERVAL_MS, runCheckPass, type CheckItem,
} from "./airingCheck";

/** Per-episode last check, for the session (bounded by the pass's prune). */
const lastCheck = new Map<string, number>();

function toCheckItem(item: LibraryItem): CheckItem {
  const timeOffset = item.state?.timeOffset;
  return {
    id: libraryItemSeriesId(item.id) || item.id,
    media_type: item.media_type,
    removed: item.removed,
    temp: item.temp,
    inContinueWatching: typeof timeOffset === "number" && timeOffset > 0,
  };
}

export function useAiringStreamCheck({ library, addons, playing }: {
  library: LibraryItem[];
  addons: AddonEntry[];
  /** A file is loaded (or casting): no stream query beside the playing stream. */
  playing: boolean;
}): void {
  const libraryRef = useRef(library);
  const addonsRef = useRef(addons);
  const playingRef = useRef(playing);
  libraryRef.current = library;
  addonsRef.current = addons;
  playingRef.current = playing;
  const runningRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const pass = () => {
    // Hidden too: the first-pass timer is not gated like the interval, and a
    // restore runs a catch-up pass anyway.
    if (runningRef.current || playingRef.current || isWindowHidden()) return;
    const queryAddons = streamQueryAddons(addonsRef.current);
    if (queryAddons.length === 0 || libraryRef.current.length === 0) return;
    runningRef.current = true;
    void runCheckPass({
      nowMs: Date.now(),
      items: libraryRef.current.map(toCheckItem),
      // Every addon's episode list, as one: an episode is picked when ANY
      // addon lists it in the window (the late one is what Continue Watching
      // may be reading), and the record is keyed by its id for every reader.
      peekVideos: (id) => {
        const lists = peekCachedDetailsById(id).map((d) => d.videos ?? []).filter((v) => v.length > 0);
        return lists.length > 0 ? lists.flat() : null;
      },
      fetchVideos: async (item) =>
        (await getMetaDetailFallback(addonsRef.current, item.media_type, item.id).catch(() => null))?.videos ?? null,
      cloudNextMs: (id) => {
        const next = getReleaseSignal(id)?.next_aired;
        if (!next || next.season === 0 || !next.aired_at) return null;
        const t = Date.parse(next.aired_at);
        return Number.isFinite(t) ? t : null;
      },
      fetchStreamCount: async (item, video) => {
        const r = await invoke<StreamFetchResult | StreamFetchResult["streams"]>("fetch_streams", {
          addons: queryAddons,
          mediaType: item.media_type,
          id: video.id,
        });
        return countEpisodeEvidence(Array.isArray(r) ? r : r?.streams ?? []);
      },
      isKnownOut: (id) => availableEarlyAt(id) != null,
      noteFound: (video, count) => noteStreamsFound(video, count),
      lastCheck,
      stillWanted: () => aliveRef.current && !playingRef.current && !isWindowHidden(),
      log: (line) => console.info(line),
    }).finally(() => { runningRef.current = false; });
  };

  // Every PASS_INTERVAL_MS while visible, with a catch-up on restore.
  useIdleGatedInterval(pass, PASS_INTERVAL_MS, { runOnResume: true });

  // A first pass shortly after the library and addons are in, and again after
  // playback ends (passes are skipped while it runs).
  const ready = library.length > 0 && addons.length > 0;
  useEffect(() => {
    if (!ready || playing) return;
    const id = window.setTimeout(pass, FIRST_PASS_DELAY_MS);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, playing]);
}
