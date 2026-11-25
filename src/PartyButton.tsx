// Aura - © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PartyButton - the rail's "Watch Party" row, second in its top section
// (NavSidebar). The Watch Party panel and the party toasts open beside the
// rail, level with this row (partyAnchor `readPartyAnchor`).
//
// It was once a 40px circle whose only states were "ring" and "no ring":
// connecting and connected looked identical, and an ERROR or a room that no
// longer exists rendered exactly like idle. The row says which of those it is:
// a member count and a green live dot when connected, a breathing amber dot
// while connecting, a rose dot after a failure.
// ---------------------------------------------------------------------------

import { useWatchTogether } from "./watchTogether/useWatchTogether";
import RailRow from "./RailRow";

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
    : "Watch Party";
  // The accessible name STARTS with the visible label (WCAG 2.5.3), so voice
  // control finds the row by its text in every state.
  const ariaLabel = connected
    ? `Watch Party, ${count} ${count === 1 ? "person" : "people"}`
    : connecting ? "Watch Party, connecting"
    : failed ? "Watch Party, unavailable. Click to try again."
    : "Watch Party";

  return (
    <RailRow
      label="Watch Party"
      title={title}
      ariaLabel={ariaLabel}
      active={inParty}
      onClick={() => window.dispatchEvent(new CustomEvent("aura:open-watch-together"))}
      // data-party-anchor is a CONTRACT: readPartyAnchor() finds this node
      // by selector and both the room panel and the toast stack seat
      // themselves off its box. Without it they fall back to the corner.
      extraProps={{ "data-party-anchor": true }}
      icon={
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
             aria-hidden>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      }
      tail={
        connected ? (
          <>
            {count > 0 && <span className="aura-rail-count">{count}</span>}
            <span
              aria-hidden
              className="aura-pill-live-dot w-[7px] h-[7px] rounded-full bg-emerald-400"
              style={{ boxShadow: "0 0 6px rgba(110,231,183,0.65)" }}
            />
          </>
        ) : connecting ? (
          // Distinct from connected on purpose: an amber dot that breathes
          // says "working on it" where a green one claims a room it has not
          // actually joined yet.
          <span
            aria-hidden
            className="aura-pill-live-dot w-[7px] h-[7px] rounded-full bg-amber-400"
            style={{ boxShadow: "0 0 6px rgba(251,191,36,0.6)" }}
          />
        ) : failed ? (
          <span aria-hidden className="w-[7px] h-[7px] rounded-full bg-rose-400"
                style={{ boxShadow: "0 0 6px rgba(251,113,133,0.6)" }} />
        ) : undefined
      }
    />
  );
}
