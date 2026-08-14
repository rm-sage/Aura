// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PartyButton - the Watch Together control, second in the top pill group.
//
// It was a 40px circle whose only states were "ring" and "no ring": connecting
// and connected looked identical, and an ERROR or a room that no longer exists
// rendered exactly like idle, so a failed join was silently indistinguishable
// from never having tried. A labelled pill has room to say which of those it
// is, so it does.
// ---------------------------------------------------------------------------

import { useWatchTogether } from "./watchTogether/useWatchTogether";
import SidePill, {
  SIDE_PILL_GAP_PX, SIDE_PILL_H_PX, SIDE_PILL_LEFT_PX, SIDE_PILL_TOP_PX,
} from "./SidePill";

export default function PartyButton() {
  const w = useWatchTogether();
  const connected  = w.status === "connected";
  const connecting = w.status === "connecting";
  const failed     = w.status === "error" || w.status === "not-found";
  const inParty    = connected || connecting;
  const count      = w.members.length;

  const title = connected
    ? `Watch party · ${count} ${count === 1 ? "person" : "people"}`
    : connecting ? "Connecting to the watch party…"
    : failed ? "Watch party unavailable. Click to try again."
    : "Watch Together";

  return (
    <div
      className="fixed z-30"
      style={{
        // Stacked directly under the User Panel pill, sharing its left edge
        // and width so the two read as one group.
        top: SIDE_PILL_TOP_PX + SIDE_PILL_H_PX + SIDE_PILL_GAP_PX,
        left: SIDE_PILL_LEFT_PX,
        pointerEvents: "auto",
      }}
    >
      <SidePill
        label="Watch Party"
        title={title}
        ariaLabel={title}
        active={inParty}
        onClick={() => window.dispatchEvent(new CustomEvent("aura:open-watch-together"))}
        // data-party-anchor is a CONTRACT: readPartyAnchor() finds this node
        // by selector and both the room panel and the toast stack seat
        // themselves off its box. Without it they fall back to the corner.
        extraProps={{ "data-party-anchor": true }}
        icon={
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
               className="text-white/85" aria-hidden>
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        }
        trailing={
          connected ? (
            <span className="flex items-center gap-1.5">
              {count > 0 && (
                <span className="min-w-[17px] h-[17px] px-1 rounded-full bg-ln-accent
                                 text-[10px] font-bold text-black flex items-center
                                 justify-center leading-none">
                  {count}
                </span>
              )}
              <span
                aria-hidden
                className="aura-pill-live-dot w-2 h-2 rounded-full bg-emerald-400"
                style={{ boxShadow: "0 0 6px rgba(110,231,183,0.65)" }}
              />
            </span>
          ) : connecting ? (
            // Distinct from connected on purpose: an amber dot that breathes
            // says "working on it" where a green one claims a room it has not
            // actually joined yet.
            <span
              aria-hidden
              className="aura-pill-live-dot w-2 h-2 rounded-full bg-amber-400"
              style={{ boxShadow: "0 0 6px rgba(251,191,36,0.6)" }}
            />
          ) : failed ? (
            <span aria-hidden className="w-2 h-2 rounded-full bg-rose-400"
                  style={{ boxShadow: "0 0 6px rgba(251,113,133,0.6)" }} />
          ) : undefined
        }
      />
    </div>
  );
}
