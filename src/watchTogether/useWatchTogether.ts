// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useReducer } from "react";
import { subscribeWatch, getWatchState, type WatchUiState } from "./store";

/** Reactive view of the watch-together store. Actions (createRoom, joinRoom,
 *  leaveRoom, openRoomVideo, setWatchConfig…) are imported directly from
 *  ./store. */
export function useWatchTogether(): WatchUiState {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeWatch(force), []);
  return getWatchState();
}
