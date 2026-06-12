// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// PartyVotesOverlay — the "Vote to Watch" chrome. A right-edge stack of:
//   • active polls (poster + title + Yes/No + a depleting 60 s countdown ring),
//   • won polls (pinned, dismissable, click → the title's details page, with a
//     theme-accent color burst on arrival),
//   • a transient error toast (3-vote cap / duplicate).
// Mounted app-level beside PartyButton; renders nothing unless in a party with
// something to show. Navigation reuses the existing `aura:open-meta` event.
// ---------------------------------------------------------------------------

import { useEffect, useReducer } from "react";
import { useWatchTogether } from "./watchTogether/useWatchTogether";
import {
  castVote, dismissWonVote, haveVoted, voteRemainingMs, VOTE_TOTAL_MS,
} from "./watchTogether/store";
import type { VotePoll } from "./watchTogether/types";

export default function PartyVotesOverlay() {
  const w = useWatchTogether();
  const [, tick] = useReducer((n: number) => n + 1, 0);

  // The relay expires polls lazily (only on the next message), so a quiet room
  // can leave a dead poll in the list — hide any whose deadline has passed.
  const activeLive = w.activeVotes.filter((v) => voteRemainingMs(v) > 0);

  // Drive the countdown rings — only while a poll is open (no idle churn).
  const hasActive = activeLive.length > 0;
  useEffect(() => {
    if (!hasActive) return;
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [hasActive]);

  if (w.status !== "connected") return null;
  if (activeLive.length === 0 && w.wonVotes.length === 0 && !w.voteError) return null;

  return (
    <div
      className="fixed right-3 top-20 z-[10000] flex flex-col items-end gap-3 w-[300px] max-w-[85vw]
                 pointer-events-none"
      aria-live="polite"
    >
      {w.wonVotes.map((v) => <WonCard key={v.id} vote={v} />)}
      {activeLive.map((v) => (
        <ActiveCard key={v.id} vote={v} memberCount={w.members.length} />
      ))}
      {w.voteError && (
        <div className="pointer-events-auto w-full rounded-xl bg-rose-500/15 border border-rose-400/30
                        px-3 py-2 text-rose-100 text-[12px] backdrop-blur-xl shadow-lg">
          {w.voteError}
        </div>
      )}
    </div>
  );
}

function Poster({ src }: { src: string | null }) {
  return (
    <div className="w-10 h-[60px] flex-shrink-0 rounded-lg overflow-hidden bg-white/8 border border-white/10">
      {src
        ? <img src={src} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
        : <div className="w-full h-full flex items-center justify-center text-white/25 text-[18px]">🎬</div>}
    </div>
  );
}

function ActiveCard({ vote, memberCount }: { vote: VotePoll; memberCount: number }) {
  const remaining = voteRemainingMs(vote);
  const secs = Math.ceil(remaining / 1000);
  const frac = Math.max(0, Math.min(1, remaining / VOTE_TOTAL_MS));
  const voted = haveVoted(vote);
  const urgent = secs <= 10;

  // Countdown ring geometry (r=15 in a 36-box).
  const R = 15;
  const C = 2 * Math.PI * R;

  return (
    <div className="pointer-events-auto w-full rounded-2xl bg-black/80 backdrop-blur-xl border border-white/12
                    shadow-[0_8px_30px_rgba(0,0,0,0.6)] p-3 flex gap-3 items-start aura-vote-won-pop">
      <Poster src={vote.poster} />
      <div className="flex-1 min-w-0">
        <p className="text-white/45 text-[9.5px] uppercase tracking-[0.12em] font-semibold">Vote to watch</p>
        <p className="text-white text-[13px] font-semibold leading-tight line-clamp-2 mt-0.5">{vote.title}</p>
        <p className="text-white/45 text-[11px] mt-0.5 truncate">
          {vote.proposedByName} · <span className="text-ln-accent/90 tabular-nums">{Math.min(vote.yes, memberCount)}/{memberCount}</span> yes
        </p>
        {!voted ? (
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              onClick={() => castVote(vote.id, "yes")}
              className="px-3 h-7 rounded-lg text-[12px] font-semibold bg-ln-accent text-black
                         hover:brightness-110 active:brightness-95 transition-[filter]"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={() => castVote(vote.id, "no")}
              className="px-3 h-7 rounded-lg text-[12px] font-semibold bg-white/8 text-white/75
                         border border-white/12 hover:bg-white/14 transition-colors"
            >
              No
            </button>
          </div>
        ) : (
          <p className="text-ln-accent text-[11px] mt-2 font-medium">You voted · waiting…</p>
        )}
      </div>
      {/* Depleting countdown ring */}
      <div className="relative w-9 h-9 flex-shrink-0">
        <svg width="36" height="36" viewBox="0 0 36 36" className={urgent ? "text-amber-400" : "text-ln-accent"}>
          <circle cx="18" cy="18" r={R} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="3" />
          <circle
            cx="18" cy="18" r={R} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - frac)}
            transform="rotate(-90 18 18)" style={{ transition: "stroke-dashoffset 250ms linear" }}
          />
        </svg>
        <span className="absolute inset-0 flex items-center justify-center text-white text-[11px] font-semibold tabular-nums">
          {secs}
        </span>
      </div>
    </div>
  );
}

function WonCard({ vote }: { vote: VotePoll }) {
  const open = () =>
    window.dispatchEvent(new CustomEvent("aura:open-meta", {
      detail: { metaId: vote.metaId, mediaType: vote.mediaType ?? undefined },
    }));
  return (
    <div
      className="pointer-events-auto relative w-full overflow-hidden rounded-2xl cursor-pointer aura-vote-won-pop
                 bg-gradient-to-br from-ln-accent/25 to-ln-accent/5 border border-ln-accent/40
                 shadow-[0_8px_30px_rgba(91,164,255,0.25)] p-3 flex gap-3 items-start
                 hover:from-ln-accent/30 transition-colors"
      onClick={open}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter") open(); }}
      title="Open details"
    >
      <VoteBurst />
      <Poster src={vote.poster} />
      <div className="flex-1 min-w-0">
        <p className="text-ln-accent text-[9.5px] uppercase tracking-[0.12em] font-bold flex items-center gap-1">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
          </svg>
          Party agreed!
        </p>
        <p className="text-white text-[13px] font-semibold leading-tight line-clamp-2 mt-0.5">{vote.title}</p>
        <p className="text-white/55 text-[11px] mt-0.5">Tap to open details</p>
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); dismissWonVote(vote.id); }}
        aria-label="Dismiss"
        className="flex-shrink-0 w-6 h-6 rounded-lg flex items-center justify-center text-white/50
                   hover:text-white hover:bg-white/12 transition-colors text-[12px]"
      >
        ✕
      </button>
    </div>
  );
}

// Theme-accent color burst — a flash + radial particles, plays once on mount.
function VoteBurst() {
  const N = 14;
  return (
    <div className="aura-vote-burst" aria-hidden>
      <span className="flash" />
      {Array.from({ length: N }).map((_, i) => (
        <span key={i} className="p" style={{ "--a": `${(360 / N) * i}deg` } as React.CSSProperties} />
      ))}
    </div>
  );
}
