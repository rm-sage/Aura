// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PartyButton — a top-level floating affordance (sibling of the account
// button / notifications bell) for the Watch-Together party. Shows party
// status at a glance (member count + a live dot) on every home/browse menu;
// opens the room panel. Hidden during playback like the other body chrome.
// ---------------------------------------------------------------------------

import { useWatchTogether } from "./watchTogether/useWatchTogether";

export default function PartyButton() {
  const w = useWatchTogether();
  const inParty = w.status === "connected" || w.status === "connecting";
  const count = w.members.length;

  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new CustomEvent("aura:open-watch-together"))}
      title={inParty ? `Watch party · ${count} ${count === 1 ? "person" : "people"}` : "Watch Together"}
      aria-label="Watch Together"
      className={[
        "fixed top-[44px] left-16 z-30 w-10 h-10 rounded-full flex items-center justify-center",
        "bg-white/[0.08] hover:bg-white/[0.14] active:bg-white/[0.18]",
        "border border-white/10 hover:border-white/20 backdrop-blur-xl shadow-lg",
        "transition-colors duration-150 aura-bell-hover",
        inParty ? "ring-1 ring-ln-accent/50" : "",
      ].join(" ")}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
           className="text-white/85" aria-hidden>
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      {inParty && count > 0 && (
        <span className="absolute -top-1 -right-1 min-w-[17px] h-[17px] px-1 rounded-full bg-ln-accent
                         text-[10px] font-bold text-black flex items-center justify-center leading-none">
          {count}
        </span>
      )}
      {w.status === "connected" && (
        <span className="absolute bottom-0.5 right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#0b0b0f]" />
      )}
    </button>
  );
}
