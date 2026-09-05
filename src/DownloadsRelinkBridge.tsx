// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { streamQueryAddons } from "./auraSettings";
import { streamMatchKey } from "./watchTogether/streamMatch";
import type { AddonEntry, StreamEntry, StreamFetchResult } from "./types";
import { relinkDownload, relinkFailed, useDownloads } from "./downloadsStore";

// ---------------------------------------------------------------------------
// DownloadsRelinkBridge: answers a job that Rust parked in `relinking`.
//
// Debrid and signed CDN links expire, so a download paused overnight, or a
// partial recovered after a quit, will very likely 401/403 on resume. Rust
// detects that and parks the job; this component re-queries the addons, finds
// the SAME source, and hands back a fresh URL. The transfer then continues
// from the byte offset already on disk.
//
// WHY THIS LIVES IN TYPESCRIPT. `streamQueryAddons` reads `streamAddonUrls`
// from localStorage, which the Rust side cannot see. Re-implementing the
// scoping in Rust is precisely the bug CLAUDE.md documents for auto-advance
// ("auto-advance used to skip that scoping and query addons the user had
// excluded in Settings"), and it would silently query providers the user
// turned off. So Rust owns the state machine and the frontend owns the query.
//
// Rust arms a 20 s timeout on the `relinking` state, so a webview reload
// mid-relink cannot wedge a job in a spinner nothing will ever resolve.
//
// Identity is `streamMatchKey`, the same function the watch-together highlight
// uses. A bespoke hash of the stream title would be unstable: an
// AIOStreams/TamTaro title carries live cache status and seeder counts that
// change between calls, so it would miss every relink in exactly the case the
// fallback exists for.
// ---------------------------------------------------------------------------

export default function DownloadsRelinkBridge({ addons }: { addons: AddonEntry[] }) {
  const { jobs } = useDownloads();
  // Jobs already being worked on, so a re-render mid-flight does not fire a
  // second query for the same one.
  const inFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    const pending = jobs.filter(
      (j) => j.state === "relinking" && !inFlight.current.has(j.id),
    );
    if (pending.length === 0) return;

    for (const job of pending) {
      inFlight.current.add(job.id);
      void (async () => {
        try {
          const queryAddons = streamQueryAddons(addons);
          if (queryAddons.length === 0) {
            await relinkFailed(job.id, "No stream providers are active.");
            return;
          }
          const r = await invoke<StreamFetchResult>("fetch_streams", {
            addons: queryAddons,
            mediaType: job.origin.media_type,
            id: job.origin.stream_id,
          });
          const streams: StreamEntry[] = Array.isArray(r)
            ? (r as StreamEntry[])
            : (r?.streams ?? []);

          // Prefer the same addon, then fall back to any row with the same
          // content identity. Both must have a real url: a magnet-only row is
          // not a substitute for a file that was half-downloaded.
          const sameKey = streams.filter(
            (s) => !!s.url && streamMatchKey(s) === job.origin.match_key,
          );
          const match =
            sameKey.find((s) => s.addon_name === job.origin.addon_name) ?? sameKey[0];

          if (!match?.url) {
            await relinkFailed(
              job.id,
              "That exact source is no longer offered. Start it again from the title's page.",
            );
            return;
          }
          await relinkDownload(job.id, match.url, match.proxy_headers ?? []);
        } catch (e) {
          await relinkFailed(
            job.id,
            e instanceof Error ? e.message : "Could not reach the stream providers.",
          );
        } finally {
          inFlight.current.delete(job.id);
        }
      })();
    }
  }, [jobs, addons]);

  return null;
}
