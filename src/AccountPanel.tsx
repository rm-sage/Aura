// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// AccountPanel — read-only Stremio account modal. Opened from the
// profile popover's "Account settings" action. Surfaces only data the
// Stremio API actually returns (fetch_stremio_account → /getUser):
// email, member-since, truncated account id, optional premium expiry,
// and Aura's own sync state. Account mutation (password / email / plan)
// is not exposed by a third-party client — a "Manage on Stremio"
// button deep-links to stremio.com instead. Aura's app Settings view
// is unaffected and still reached from the nav sidebar.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { StremioAccount } from "./LoginView";
import AuraLogoA from "./AuraLogoA";

/** ISO date → "Apr 2021"; null when absent/unparseable so the caller
 *  can omit the row entirely. */
function monthYear(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-white/40">{label}</span>
      <span className={`text-white/85 text-right truncate max-w-[62%] ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

export default function AccountPanel({
  loggedIn, sessionEmail, onClose,
}: {
  loggedIn: boolean;
  sessionEmail: string | null;
  onClose: () => void;
}) {
  const [acct, setAcct] = useState<StremioAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    invoke<StremioAccount>("fetch_stremio_account")
      .then((a) => { if (!cancelled) { setAcct(a); setLoading(false); } })
      .catch(() => { if (!cancelled) { setFailed(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fetchedEmail = acct?.email && acct.email.length > 0 ? acct.email : null;
  const sessEmail = sessionEmail && sessionEmail.length > 0 ? sessionEmail : null;
  const email = fetchedEmail ?? sessEmail;
  const since = monthYear(acct?.date_registered);
  const premium = monthYear(acct?.premium_until);
  const id = acct?.user_id ?? "";
  const acctId = id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : (id || null);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ backgroundColor: "rgba(0,0,0,0.66)", backdropFilter: "blur(6px)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Stremio account"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="w-[380px] max-w-[92vw] rounded-2xl border border-white/15
                   bg-[rgba(12,12,16,0.97)] backdrop-blur-2xl shadow-glass-edge px-5 py-5"
      >
        <div className="flex items-center gap-3 pb-4 border-b border-white/8">
          <span className="flex items-center justify-center w-11 h-11 rounded-full
                           bg-white/5 border border-white/10">
            <AuraLogoA size={30} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-white/95 text-sm font-semibold leading-tight">Stremio account</p>
            <p className="text-white/45 text-[11px] mt-0.5 truncate font-mono selectable">
              {loading
                ? "Loading…"
                : (email ?? (failed ? "Couldn't load account" : "Email unavailable"))}
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="w-7 h-7 rounded-md text-white/40 hover:text-white
                       hover:bg-white/10 flex items-center justify-center text-base"
          >
            ×
          </button>
        </div>

        <div className="py-3 space-y-2 text-[12.5px]">
          {since && <Row label="Member since" value={since} />}
          {acctId && <Row label="Account" value={acctId} mono />}
          {premium && <Row label="Stremio Premium" value={`until ${premium}`} />}
          <div className="flex items-center gap-2 pt-1">
            <span
              className={`w-2 h-2 rounded-full ${loggedIn ? "bg-emerald-400" : "bg-white/30"}`}
              style={{ boxShadow: loggedIn ? "0 0 6px rgba(110,231,183,0.7)" : undefined }}
            />
            <p className="text-white/85">
              {loggedIn ? "Synced to Stremio cloud" : "Not signed in"}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => { openUrl("https://www.stremio.com/acc-settings").catch(() => {}); }}
          className="w-full mt-2 px-3 py-2 rounded-xl text-[12.5px] font-medium
                     bg-white/[0.06] hover:bg-white/[0.12] border border-white/10
                     text-white/85 hover:text-white transition-colors
                     flex items-center justify-center gap-2"
        >
          Manage on Stremio
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7z" />
          </svg>
        </button>
        <p className="text-white/30 text-[10.5px] mt-2 text-center leading-snug">
          Password, email, and plan changes are managed on Stremio's site.
        </p>
      </div>
    </div>
  );
}
