# Account Panel + Email-Pending-Sync Fix — Implementation Plan (Item 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "Email pending sync" stuck state and replace the popover's "Account settings" action with a dedicated read-only Stremio Account panel (email, member-since, account id, sync state, optional premium) plus an external "Manage on Stremio" link.

**Architecture:** A new cached Tauri command `fetch_stremio_account` calls Stremio `/getUser`, parses only fields the API actually returns, and self-heals the keyring session's `email` (the real bug: `/login` can persist an empty email and `backfill_user_id` short-circuits once `user_id` is set, so the email is never re-fetched). A new `AccountPanel` React component renders the fetched data read-only; `AccountButton` opens it from the popover; `App` merges the recovered email into its in-memory session so the popover line self-heals.

**Tech Stack:** Rust (Tauri command, serde_json, OS keyring), React 19 + TypeScript, `@tauri-apps/plugin-opener`. No new dependency.

**Verification model (project-specific — overrides the skill's TDD template):** No test framework/ESLint/Prettier (CLAUDE.md). Gates: `cargo check --manifest-path src-tauri/Cargo.toml --message-format=short` (Rust), `pnpm exec tsc --noEmit` (TS), manual. The `verify.cjs` hook auto-runs `tsc` after every `Edit` (NOT cargo — run cargo explicitly). `Write` is blocked: new files via PowerShell `Set-Content`, edits via `Edit`. Do NOT write tests.

**Tauri command registration — note (2 places, not 3):** CLAUDE.md's "3 places" rule is: `lib.rs` `generate_handler!`, `permissions/player.toml` `commands.allow`, `capabilities/default.json`. Here `capabilities/default.json` grants the **permission-group identifier** `"allow-auth"` (line 34), not per-command entries, and `fetch_stremio_account` joins the existing `allow-auth` group in `player.toml`. So **`default.json` is intentionally NOT modified** — the group grant already covers the new command. Editing it is unnecessary and would be wrong. (Reviewers: this is by design, not a missed step.)

**Spec-reality reconciliation (not a scope change):** The approved spec frames the root cause as "the `/login` parser `unwrap_or("")` + backfill only populated `user_id`." The live code already probes `/result/user/email` then `/result/email` in `/login`, and `backfill_user_id` already backfills email — BUT `backfill_user_id` returns early when `user_id` is non-empty (auth.rs ~L296-300) and `App.tsx` only calls it when `!sess.user_id`, so a session that has a `user_id` but an empty `email` is permanently stuck. The spec's `fetch_stremio_account` command is the correct fix and is implemented as specified; we deliberately do NOT touch `backfill_user_id` (correct for its own purpose) or re-fix the already-correct `/login` path.

**Preconditions:** Branch `feat/ui-polish-correctness-batch` (Items 4, 2, 1 shipped; HEAD `8b16cbd`). Confirm: `git rev-parse --abbrev-ref HEAD`. Working tree clean.

**Dependency order:** T1 (Rust+registration) → T2 (TS interface) → T3 (AccountPanel) → T4 (wire AccountButton/App to open it) → T5 (App self-heal email on restore). Execute in order.

---

### Task 1: Rust — `fetch_stremio_account` command (cached, self-healing) + registration

**Files:** Modify `src-tauri/src/auth.rs` (insert after `get_session`, ~L394; edit `login` end ~L268; edit `logout` ~L274-277); `src-tauri/src/lib.rs` (`generate_handler!`, ~L2021); `src-tauri/permissions/player.toml` (`allow-auth`, L59). **Do NOT modify `capabilities/default.json`** (see header note).

This is one atomic Rust commit — adding a command referenced by `generate_handler!` must compile together. `cargo check` runs once after all edits.

- [ ] **Step 1: Add the struct, cache, and command to `auth.rs`**

Edit `src-tauri/src/auth.rs`. Replace:

```rust
    result
}

/// Fetch the user's installed addon list from the Stremio account API.
```

with:

```rust
    result
}

/// Read-only snapshot of the signed-in Stremio account, surfaced by the
/// Account panel. Serialised to the frontend with these exact field
/// names (snake_case == the TS `StremioAccount` interface), so NO serde
/// rename is needed — Tauri sends Rust field names outward.
#[derive(Debug, Clone, Serialize)]
pub struct StremioAccount {
    pub email: String,
    pub user_id: String,
    /// ISO date string from `/getUser` `dateRegistered`; `None` when the
    /// API omits it (frontend then hides the "Member since" row).
    pub date_registered: Option<String>,
    /// Optional premium-expiry ISO string. Only `Some` when the API
    /// actually returns a non-empty value — the panel never fabricates
    /// a "not active" line.
    pub premium_until: Option<String>,
}

// 24h in-memory cache. One signed-in account at a time, so a single
// slot suffices. Cleared on login/logout (below) so a re-auth always
// re-fetches. Fully-qualified std paths keep auth.rs's import list
// untouched.
static ACCOUNT_CACHE: std::sync::Mutex<Option<(std::time::Instant, StremioAccount)>> =
    std::sync::Mutex::new(None);

fn clear_account_cache() {
    if let Ok(mut g) = ACCOUNT_CACHE.lock() {
        *g = None;
    }
}

/// Fetch the signed-in user's Stremio account via `/getUser`, cached
/// in-memory for 24h. Self-heals the stored session's `email`: the
/// `/login` path can persist an empty email when the API omits it at
/// the probed pointers, and `backfill_user_id` short-circuits once
/// `user_id` is set — so without this a session stays stuck on an
/// empty email. Read-only: only surfaces fields the API returns;
/// never fabricates. Returns `NOT_LOGGED_IN` when there is no session.
#[tauri::command]
pub async fn fetch_stremio_account<R: Runtime>(
    app: AppHandle<R>,
) -> Result<StremioAccount, String> {
    if let Ok(g) = ACCOUNT_CACHE.lock() {
        if let Some((at, acct)) = g.as_ref() {
            if at.elapsed() < std::time::Duration::from_secs(24 * 3600) {
                return Ok(acct.clone());
            }
        }
    }

    let Some(mut session) = load_session(&app)? else {
        return Err("NOT_LOGGED_IN".into());
    };
    if session.auth_key.is_empty() {
        return Err("NOT_LOGGED_IN".into());
    }

    let body = serde_json::json!({ "authKey": session.auth_key });
    let raw = auth_client()
        .post(format!("{STREMIO_API}/getUser"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?
        .text()
        .await
        .map_err(|e| format!("Response read error: {e}"))?;

    let json: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| format!("JSON parse error: {e}\nRaw response: {raw}"))?;

    if let Some(err) = json.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        return Err(stremio_error(err.to_string()));
    }

    let email = json
        .pointer("/result/email")
        .or_else(|| json.pointer("/result/user/email"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let user_id = json
        .pointer("/result/_id")
        .or_else(|| json.pointer("/result/user/_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let date_registered = json
        .pointer("/result/dateRegistered")
        .or_else(|| json.pointer("/result/user/dateRegistered"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    // Defensive premium-expiry probe — surfaced only if a non-empty
    // date string is actually present.
    let premium_until = json
        .pointer("/result/premium_expire")
        .or_else(|| json.pointer("/result/user/premium_expire"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    // Self-heal: persist a recovered email so the ProfilePopover line
    // stops showing "Email pending sync" on the next session read.
    if !email.is_empty() && session.email != email {
        session.email = email.clone();
        store_session(&app, &session)?;
    }

    let acct = StremioAccount { email, user_id, date_registered, premium_until };
    if let Ok(mut g) = ACCOUNT_CACHE.lock() {
        *g = Some((std::time::Instant::now(), acct.clone()));
    }
    Ok(acct)
}

/// Fetch the user's installed addon list from the Stremio account API.
```

- [ ] **Step 2: Clear the cache on login**

In the same file, replace:

```rust
    let session = UserSession { email, auth_key, user_id };
    store_session(&app, &session)?;
    Ok(session)
}
```

with:

```rust
    let session = UserSession { email, auth_key, user_id };
    store_session(&app, &session)?;
    clear_account_cache();
    Ok(session)
}
```

- [ ] **Step 3: Clear the cache on logout**

In the same file, replace:

```rust
#[tauri::command]
pub async fn logout<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    delete_session(&app)
}
```

with:

```rust
#[tauri::command]
pub async fn logout<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    clear_account_cache();
    delete_session(&app)
}
```

- [ ] **Step 4: Register the command in `generate_handler!`**

Edit `src-tauri/src/lib.rs`. Replace:

```rust
            auth::backfill_user_id,
```

with:

```rust
            auth::backfill_user_id,
            auth::fetch_stremio_account,
```

- [ ] **Step 5: Allow the command in `player.toml`**

Edit `src-tauri/permissions/player.toml`. Replace:

```toml
commands.allow = ["login", "logout", "get_session", "get_synced_addons", "backfill_user_id"]
```

with:

```toml
commands.allow = ["login", "logout", "get_session", "get_synced_addons", "backfill_user_id", "fetch_stremio_account"]
```

- [ ] **Step 6: cargo check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml --message-format=short`
Expected: ends `Finished … target(s)`, exit 0. Pre-existing warnings OK; ZERO errors. (`auth_client`, `STREMIO_API`, `stremio_error`, `load_session`, `store_session`, `Runtime`, `AppHandle`, `Serialize`, `serde_json` are all already in scope in `auth.rs` — used by `login`/`backfill_user_id`. The cache uses fully-qualified `std::sync`/`std::time`, so no new `use` lines.)

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/auth.rs src-tauri/src/lib.rs src-tauri/permissions/player.toml
git commit -m "feat(auth): fetch_stremio_account command (cached, self-heals email)"
```

---

### Task 2: TypeScript — `StremioAccount` interface

**Files:** Modify `src/LoginView.tsx` (after the `UserSession` interface, ~L17)

- [ ] **Step 1: Add the interface**

Edit `src/LoginView.tsx`. Replace:

```ts
  user_id?: string | null;
}

interface Props {
  onSuccess: (session: UserSession) => void;
  onGuest: () => void;
}
```

with:

```ts
  user_id?: string | null;
}

/** Read-only Stremio account snapshot from the `fetch_stremio_account`
 *  Tauri command. snake_case mirrors the Rust struct's wire field names
 *  exactly (no serde rename in play). Optional fields are absent when
 *  Stremio's `/getUser` omits them — the panel hides those rows rather
 *  than showing placeholders. */
export interface StremioAccount {
  email: string;
  user_id: string;
  date_registered?: string | null;
  premium_until?: string | null;
}

interface Props {
  onSuccess: (session: UserSession) => void;
  onGuest: () => void;
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/LoginView.tsx
git commit -m "feat(auth): StremioAccount TS interface"
```

---

### Task 3: New `src/AccountPanel.tsx` (read-only modal)

**Files:** Create `src/AccountPanel.tsx`

- [ ] **Step 1: Create the component**

Run this exact PowerShell command (the `Write` tool is blocked; the TSX content has no line equal to the here-string terminator, so the single-quoted here-string is safe):

```powershell
$src = @'
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
'@
Set-Content -Path src/AccountPanel.tsx -Value $src -Encoding utf8
```

Use the literal `©` (matches every other file header, e.g. `src/AccountButton.tsx` line 1). Tailwind note (CLAUDE.md opacity gotcha): every opacity token used here — `/95 /85 /45 /40 /30 /15 /10 /8 /5` — already appears in `src/NavSidebar.tsx`'s `ProfilePopover` (proven to emit CSS in this project's config); `bg-white/[0.06]` / `bg-white/[0.12]` are arbitrary bracket values (always emit, immune to the scale gotcha); `shadow-glass-edge` and `z-[60]` are used elsewhere in the codebase.

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (Exported default component unused for now → fine; `noUnusedLocals` ignores exports.)

- [ ] **Step 3: Commit**

```bash
git add src/AccountPanel.tsx
git commit -m "feat(account): read-only AccountPanel component"
```

---

### Task 4: Wire the popover "Account settings" → AccountPanel

**Files:** Modify `src/AccountButton.tsx` (Props ~L24-37; component body); `src/App.tsx` (AccountButton call ~L4252-4258)

`AccountButton`'s popover button currently calls `onOpenSettings` → `App` routes it to `setActiveView("settings")`. Repurpose it to open the new `AccountPanel`. Aura's app Settings stays reachable via the nav sidebar (unchanged). `onOpenSettings` becomes unused → remove it from the prop chain (else `noUnusedLocals` errors).

- [ ] **Step 1: AccountButton — drop `onOpenSettings`, own the panel**

Edit `src/AccountButton.tsx`. Replace:

```tsx
import { useEffect, useState } from "react";
import { ProfilePopover } from "./NavSidebar";
import AuraLogoA from "./AuraLogoA";
```

with:

```tsx
import { useEffect, useState } from "react";
import { ProfilePopover } from "./NavSidebar";
import AuraLogoA from "./AuraLogoA";
import AccountPanel from "./AccountPanel";
```

Then replace:

```tsx
  nickname?: string | null;
  onOpenSettings: () => void;
  onLoginRequest?: () => void;
  onLogout?: () => void;
}

export default function AccountButton({
  loggedIn, email, nickname, onOpenSettings, onLoginRequest, onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
```

with:

```tsx
  nickname?: string | null;
  onLoginRequest?: () => void;
  onLogout?: () => void;
}

export default function AccountButton({
  loggedIn, email, nickname, onLoginRequest, onLogout,
}: Props) {
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
```

Then replace:

```tsx
      {open && (
        <ProfilePopover
          loggedIn={loggedIn}
          email={email}
          nickname={nickname}
          onClose={() => setOpen(false)}
          onSettings={() => { setOpen(false); onOpenSettings(); }}
          onLogin={() => { setOpen(false); onLoginRequest?.(); }}
          onLogout={() => { setOpen(false); onLogout?.(); }}
        />
      )}
    </div>
  );
}
```

with:

```tsx
      {open && (
        <ProfilePopover
          loggedIn={loggedIn}
          email={email}
          nickname={nickname}
          onClose={() => setOpen(false)}
          onSettings={() => { setOpen(false); setAccountOpen(true); }}
          onLogin={() => { setOpen(false); onLoginRequest?.(); }}
          onLogout={() => { setOpen(false); onLogout?.(); }}
        />
      )}
      {accountOpen && (
        <AccountPanel
          loggedIn={loggedIn}
          sessionEmail={email ?? null}
          onClose={() => setAccountOpen(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: App.tsx — stop passing `onOpenSettings` to AccountButton**

Edit `src/App.tsx`. Replace:

```tsx
      <AccountButton
        loggedIn={!!session?.auth_key}
        email={session?.email ?? null}
        onOpenSettings={() => setActiveView("settings")}
        onLoginRequest={() => setShowLogin(true)}
        onLogout={handleLogout}
      />
```

with:

```tsx
      <AccountButton
        loggedIn={!!session?.auth_key}
        email={session?.email ?? null}
        onLoginRequest={() => setShowLogin(true)}
        onLogout={handleLogout}
      />
```

(`setActiveView("settings")` is still used elsewhere in App.tsx — the nav sidebar Settings entry — so removing it here does not orphan it. Confirm with `grep -n 'setActiveView("settings")' src/App.tsx` → still ≥1 other hit.)

- [ ] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (If "`onOpenSettings` is declared but never read" → Step 1 prop removal incomplete. If "Cannot find name AccountPanel" → import missing.)

- [ ] **Step 4: Commit**

```bash
git add src/AccountButton.tsx src/App.tsx
git commit -m "feat(account): popover Account settings opens the read-only panel"
```

---

### Task 5: App — self-heal the in-memory session email on restore

**Files:** Modify `src/App.tsx` (session-restore effect, ~L2855)

The Rust command backfills the keyring, but the popover reads `App`'s in-memory `session.email`. After restoring a session, best-effort fetch the account and merge a recovered email so the popover line self-heals this launch (no relogin needed). Non-fatal — the panel still works without it.

- [ ] **Step 1: Add the best-effort fetch+merge after `setSession(sess)`**

Edit `src/App.tsx`. Replace:

```tsx
          await applySettingsScope(sess);
          setSession(sess);
          setLandingDismissed(true); // bypass landing on cached credentials
          await Promise.all([loadSyncedAddons(sess), loadLibrary(sess)]);
```

with:

```tsx
          await applySettingsScope(sess);
          setSession(sess);
          setLandingDismissed(true); // bypass landing on cached credentials
          // Self-heal a stuck/empty email: /login can persist an empty
          // address and backfill_user_id short-circuits once user_id is
          // set, so the popover would show "Email pending sync"
          // forever. fetch_stremio_account re-derives it from /getUser
          // (cached 24h) and rewrites the keyring; merge the result
          // into the in-memory session so the line updates without a
          // relogin. Best-effort — failure leaves the prior behaviour.
          invoke<import("./LoginView").StremioAccount>("fetch_stremio_account")
            .then((acct) => {
              if (acct?.email) {
                setSession((s) => (s && s.email !== acct.email ? { ...s, email: acct.email } : s));
              }
            })
            .catch(() => {});
          await Promise.all([loadSyncedAddons(sess), loadLibrary(sess)]);
```

(The inline `import("./LoginView").StremioAccount` type-only import avoids touching App.tsx's top import block. `invoke` and `setSession` are already in scope here. `setSession((s) => …)` is the functional updater — safe against the surrounding `await`s reordering state.)

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 3: Manual acceptance (human runs the Win32/WebView2 GUI; subagent confirms code only)**

Static self-check (subagent): the fetch is best-effort (`.catch(() => {})`), uses the functional `setSession` updater, and only merges when `acct.email` is non-empty and differs.

Human GUI checklist (report as PENDING, human-only):
1. Signed in with a session that showed "Email pending sync" → after launch the popover shows the real email (self-heal), no relogin.
2. Popover → "Account settings" opens the AccountPanel (NOT the app Settings view); it shows email, "Member since …" (if the API returns `dateRegistered`), truncated Account id, "Synced to Stremio cloud"; NO "Stremio Premium" row unless `/getUser` returned a premium expiry; "Manage on Stremio" opens `https://www.stremio.com/acc-settings` in the default browser; Esc / backdrop click / × close it.
3. Aura's app Settings is still reachable from the nav sidebar (unchanged).
4. Guest mode: popover unchanged; AccountPanel not reachable (no "Account settings" path while logged out shows it — verify it degrades gracefully if opened: "Couldn't load account").

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(account): self-heal in-memory session email on restore"
```

---

## Self-Review

**Spec coverage (Item 3 of `docs/superpowers/specs/2026-05-18-aura-ui-polish-batch-design.md`):**
- New cached `fetch_stremio_account` Tauri command, `/getUser`, parses email/_id/dateRegistered/(defensive premium), ~24h cache, refreshed on login (cache cleared on login/logout) → T1.
- Backfills `session.email` into the keyring so the popover self-heals → T1 (keyring write) + T5 (in-memory merge so it shows this launch).
- 3-place registration → T1 (lib.rs + player.toml; default.json intentionally unchanged — group grant, documented in header & task).
- "Account settings" opens a NEW dedicated read-only panel; only confidently-parsed fields; NO fake Premium; "Manage on Stremio" → `https://www.stremio.com/acc-settings`; Aura app Settings unchanged/reachable elsewhere → T3 + T4.
- Rust→React struct uses no serde rename (snake_case field names == TS interface) — satisfies CLAUDE.md's deserialize-only-rename rule by not renaming at all → T1 + T2.
- Gates: cargo check (T1) + tsc (T2-T5) + manual (T5).

**Spec-reality note (documented, not a gap):** the `/login` parser + `backfill_user_id` are already partially correct; the genuine stuck-email path is `backfill_user_id`'s `user_id`-present short-circuit. The new command fixes it without disturbing those working paths — captured in the header's "Spec-reality reconciliation".

**Placeholder scan:** none. Every code step is complete; the only non-literal is the deliberate `©`-glyph instruction in T3 (Set-Content here-strings carry it fine in this environment, as proven in Items 3/4's shared-module tasks).

**Type consistency:** Rust `StremioAccount { email:String, user_id:String, date_registered:Option<String>, premium_until:Option<String> }` (Serialize, no rename) ↔ TS `StremioAccount { email:string; user_id:string; date_registered?:string|null; premium_until?:string|null }` ↔ `AccountPanel` reads `acct.email/.user_id/.date_registered/.premium_until` ↔ `invoke<StremioAccount>("fetch_stremio_account")`. `AccountPanel` props `{loggedIn:boolean, sessionEmail:string|null, onClose:()=>void}` match the `AccountButton` call site. `AccountButton` Props no longer has `onOpenSettings`; the App.tsx call site drops it in the same task (T4) — no dangling reference. Command name `fetch_stremio_account` identical in auth.rs / lib.rs / player.toml / both invoke sites.
