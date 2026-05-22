# publicmetadb OP/ED Skip Source + .env.local Secrets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give live-action series a real OP/ED skip database (publicmetadb), add it as a best-effort anime fallback, and consolidate every env-var-shaped secret into the git-ignored `.env.local`.

**Architecture:** A new Rust module (`publicmetadb.rs`) fetches crowd-sourced skip timestamps from publicmetadb's TMDB-keyed API, modelled on `aniskip.rs` (dedicated HTTP client, positive/negative cache, Tauri command). TMDB ids reach it two ways: live-action via AIOMetadata's `_tmdbId` (parsed into `MetaDetail.tmdb_id`); anime best-effort via yuna.moe's `themoviedb` field. The frontend skip assembly in `App.tsx` feeds publicmetadb windows into the existing `finishWithChapters` priority merge as the primary tier, so chapters and the silencedetect heuristic only fill kinds it did not supply. Separately, `build.rs` gains a dotenv parser so app-owned API keys bake from `.env.local` instead of a standalone file.

**Tech Stack:** Rust (Tauri 2 commands, `reqwest`, `serde`), React/TypeScript (`App.tsx`), PowerShell (`release.ps1`), Cargo build script (`build.rs`).

**Testing note:** Per `CLAUDE.md`, this project has **no test framework** — `cargo check --message-format=short` and `pnpm exec tsc --noEmit` are the only correctness gates, plus a manual runtime check. Task verification steps use those gates instead of unit tests. This matches `aniskip.rs` (the module `publicmetadb.rs` is modelled on), which carries no unit tests.

**Implementation-detail note (anime TMDB):** The design doc says to add `themoviedb` to `aniskip.rs`'s shared `YunaIds*` structs. This plan instead implements the anime TMDB lookup as an isolated `resolve_anime_tmdb_id` command inside `publicmetadb.rs`. Rationale: retrofitting `resolve_mal_id` ripples through a cache struct shared with `resolve_mal_id_by_title` (8 construction sites) for a best-effort secondary path; an isolated command leaves `aniskip.rs` untouched and keeps the feature cohesive. This stays within design Decision #3 ("anime TMDB best-effort from yuna.moe's themoviedb") — only the mechanism differs. Flag for review if the shared-struct approach is preferred.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src-tauri/build.rs` | Modify | Dotenv parser; bake `AURA_MDBLIST_KEY` + `AURA_PUBLICMETADB_KEY` from `.env.local` |
| `.env.example` | Modify | Document every env-var-shaped secret (no values) |
| `.env.local` | Modify (local, git-ignored) | Hold the real secret values |
| `.gitignore` | Modify | Drop the retired `src-tauri/mdblist.key` entry |
| `scripts/release.ps1` | Modify | Read `AURA_UPDATER_KEY_PASSWORD` from `.env.local` |
| `src-tauri/mdblist.key` | Delete | Retired — its value moves into `.env.local` |
| `src-tauri/src/stremio.rs` | Modify | Extract `_tmdbId`; add `MetaDetail.tmdb_id` |
| `src/types.ts` | Modify | Add `MetaDetail.tmdb_id` to the TS interface |
| `src-tauri/src/publicmetadb.rs` | Create | publicmetadb fetcher + `resolve_anime_tmdb_id`, cache, two Tauri commands |
| `src-tauri/src/lib.rs` | Modify | `mod publicmetadb;` + register both commands |
| `src-tauri/permissions/player.toml` | Modify | `allow-publicmetadb` permission block |
| `src-tauri/capabilities/default.json` | Modify | Grant `allow-publicmetadb` |
| `src/App.tsx` | Modify | `fetchPublicmetadbWindows` helper + live-action & anime merge wiring |
| `CLAUDE.md` | Modify | Add `[publicmetadb]` to the Rust log-label list |

**Phase dependency:** Phase 1 Task 1 **must** land before Phase 3 — `publicmetadb.rs` uses `env!("AURA_PUBLICMETADB_KEY")`, a compile-time macro that fails to build unless `build.rs` defines that rustc-env first. Phases otherwise run in order.

---

## Phase 1 — Secrets consolidated into `.env.local`

### Task 1: `build.rs` — dotenv parser; bake both app-owned keys

**Files:**
- Modify: `src-tauri/build.rs` (replace whole file)

- [ ] **Step 1: Replace `src-tauri/build.rs` with this**

```rust
use std::collections::HashMap;

/// Parse a dotenv-style file into a key->value map. `KEY=VALUE` lines;
/// `#` comments and blank lines skipped; surrounding quotes/space
/// trimmed. Splits on the FIRST `=` so values may themselves contain
/// `=` (base64 keys, etc.).
fn parse_dotenv(path: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(text) = std::fs::read_to_string(path) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim().to_string();
                let v = v.trim().trim_matches('"').trim_matches('\'').trim().to_string();
                if !k.is_empty() {
                    map.insert(k, v);
                }
            }
        }
    }
    map
}

/// Resolve a build-time secret: a real environment variable of the same
/// name wins (CI), else the `.env.local` value, else empty. An empty
/// string bakes cleanly and the consuming feature no-ops.
fn resolve_secret(env_file: &HashMap<String, String>, name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| env_file.get(name).cloned())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn main() {
    // Bake app-owned API keys into the binary at BUILD time without them
    // ever entering the repo. Source: a real env var of the same name
    // (CI), else `../.env.local` (build scripts run with cwd = the
    // package root, src-tauri/, so the repo-root file is one level up).
    // Empty/missing -> the consuming feature cleanly no-ops. Keys end up
    // only in the compiled binary (same exposure as any client-embedded
    // key — acceptable for free, rate-limited ones), never in source
    // control. `env!("AURA_MDBLIST_KEY")` reads this in ratings.rs;
    // `env!("AURA_PUBLICMETADB_KEY")` in publicmetadb.rs.
    let env_file = parse_dotenv("../.env.local");

    let mdblist_key      = resolve_secret(&env_file, "AURA_MDBLIST_KEY");
    let publicmetadb_key = resolve_secret(&env_file, "AURA_PUBLICMETADB_KEY");

    println!("cargo:rustc-env=AURA_MDBLIST_KEY={mdblist_key}");
    println!("cargo:rustc-env=AURA_PUBLICMETADB_KEY={publicmetadb_key}");
    println!("cargo:rerun-if-changed=../.env.local");
    println!("cargo:rerun-if-env-changed=AURA_MDBLIST_KEY");
    println!("cargo:rerun-if-env-changed=AURA_PUBLICMETADB_KEY");

    tauri_build::build()
}
```

- [ ] **Step 2: Verify the build script compiles and runs**

Run (from repo root): `cd src-tauri ; cargo check --message-format=short ; cd ..`
Expected: completes with no errors. `cargo check` compiles and runs `build.rs`; a syntax error in the script surfaces here. `AURA_PUBLICMETADB_KEY` is now baked (empty for now) but unread — no warning.

- [ ] **Step 3: Commit**

```
git add src-tauri/build.rs
git commit -m "build: parse .env.local; bake AURA_PUBLICMETADB_KEY alongside MDBList key"
```

### Task 2: `.env.example` documentation + `.env.local` population

**Files:**
- Modify: `.env.example`
- Modify (local only, git-ignored — not committed): `.env.local`
- Delete: `src-tauri/mdblist.key`

- [ ] **Step 1: Append the app-owned-key section to `.env.example`**

Add these lines to the end of `.env.example`:

```
# --- Aura app-owned API keys (baked into the binary by src-tauri/build.rs) --
# Free, rate-limited bearer tokens. Baked at build time via
# cargo:rustc-env; an empty/absent value makes the consuming feature
# cleanly no-op. A real environment variable of the same name overrides
# this file (useful for CI).
#
# MDBList — powers the IMDb-keyed ratings branch in src-tauri/src/ratings.rs.
AURA_MDBLIST_KEY=
# publicmetadb (publicmetadb.com) — crowd-sourced OP/ED skip timestamps.
AURA_PUBLICMETADB_KEY=

# --- Release signing (release builds only) ---------------------------------
# Password for the minisign updater key (aura-updater.key). Consumed by
# scripts/release.ps1; never baked into the shipped binary.
AURA_UPDATER_KEY_PASSWORD=
```

- [ ] **Step 2: Populate `.env.local` with the real values (MANUAL — local only)**

`.env.local` is git-ignored; this step is not committed. Append to `.env.local`:
- `AURA_MDBLIST_KEY=` followed by the current contents of `src-tauri/mdblist.key` (open that file and copy its single-line value).
- `AURA_UPDATER_KEY_PASSWORD=` followed by the minisign updater-key password (the value currently passed to `release.ps1` by hand / via the env var).
- `AURA_PUBLICMETADB_KEY=` followed by a publicmetadb API key obtained from publicmetadb.com. If no key is available yet, leave it blank — the feature ships inert and can be enabled later by filling this in and rebuilding.

- [ ] **Step 3: Delete the retired standalone key file**

Run: `Remove-Item src-tauri/mdblist.key`
(`src-tauri/mdblist.key` is git-ignored, so this is not a tracked change.)

- [ ] **Step 4: Verify MDBList still resolves from the new source**

Run (from repo root): `cd src-tauri ; cargo check --message-format=short ; cd ..`
Expected: no errors. `build.rs` now sources `AURA_MDBLIST_KEY` from `.env.local`; a clean check confirms the rustc-env still bakes. (Full ratings verification happens at Phase 5.)

- [ ] **Step 5: Commit**

```
git add .env.example
git commit -m "chore(secrets): document app-owned keys + updater password in .env.example"
```

### Task 3: `.gitignore` — drop the retired `mdblist.key` entry

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Remove the `mdblist.key` ignore lines**

Delete these three lines from `.gitignore` (currently lines 91-93):

```
# MDBList API key — secret, baked into the build by src-tauri/build.rs
# (cargo:rustc-env). Never commit; the binary embeds it, the repo must not.
src-tauri/mdblist.key
```

Leave the `.env` / `.env.local` ignore block (lines 28-32) untouched — `.env.local` must stay git-ignored.

- [ ] **Step 2: Verify `.env.local` is still ignored**

Run: `git check-ignore .env.local`
Expected: prints `.env.local` (confirms it is still ignored).

- [ ] **Step 3: Commit**

```
git add .gitignore
git commit -m "chore(secrets): drop retired src-tauri/mdblist.key from .gitignore"
```

### Task 4: `release.ps1` — read `AURA_UPDATER_KEY_PASSWORD` from `.env.local`

**Files:**
- Modify: `scripts/release.ps1`

- [ ] **Step 1: Add a `Read-DotEnv` helper and call it up front**

In `scripts/release.ps1`, immediately after the line `Set-Location $repoRoot` (inside the "Sanity checks" section), insert:

```powershell
# Parse .env.local (KEY=VALUE; `#` comments and blank lines skipped)
# once, up front — it now backs both the updater-key password and the
# Sentry upload vars.
function Read-DotEnv {
    param([string]$Path)
    $map = @{}
    if (Test-Path $Path) {
        foreach ($line in Get-Content $Path) {
            if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
                $map[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'").Trim()
            }
        }
    }
    return $map
}
$dotenv = Read-DotEnv (Join-Path $repoRoot ".env.local")
```

- [ ] **Step 2: Add `.env.local` as a password source**

Replace the existing password-resolution block (the `if (-not $Password) { if ($env:AURA_UPDATER_KEY_PASSWORD) { ... } else { ...error... exit 1 } }`) with:

```powershell
if (-not $Password) {
    if ($env:AURA_UPDATER_KEY_PASSWORD) {
        $Password = $env:AURA_UPDATER_KEY_PASSWORD
    } elseif ($dotenv["AURA_UPDATER_KEY_PASSWORD"]) {
        $Password = $dotenv["AURA_UPDATER_KEY_PASSWORD"]
        Write-Host "[release] updater-key password loaded from .env.local"
    } else {
        Write-Host ""
        Write-Host "ERROR: -Password not provided, AURA_UPDATER_KEY_PASSWORD not set," -ForegroundColor Red
        Write-Host "       and no AURA_UPDATER_KEY_PASSWORD line in .env.local." -ForegroundColor Red
        Write-Host ""
        Write-Host "Pass -Password '<key-password>', export AURA_UPDATER_KEY_PASSWORD,"
        Write-Host "or add an AURA_UPDATER_KEY_PASSWORD= line to .env.local."
        Write-Host ""
        exit 1
    }
}
```

- [ ] **Step 3: Reuse `$dotenv` for the Sentry vars**

In the "Sentry debug-info upload" section, delete the now-redundant re-parse — the lines from `$envLocal = Join-Path $repoRoot ".env.local"` through the `foreach`/`if` block that builds `$sentryEnv` — and replace the four `$sentry*` assignments so they read from `$dotenv` instead of `$sentryEnv`:

```powershell
$sentryAuth    = $dotenv["SENTRY_AUTH_TOKEN"]
$sentryOrg     = $dotenv["SENTRY_ORG"]
$sentryProject = $dotenv["SENTRY_PROJECT"]
$sentryUrl     = if ($dotenv["SENTRY_URL"]) { $dotenv["SENTRY_URL"] } else { "https://sentry.io/" }
```

- [ ] **Step 4: Verify the script parses**

Run: `pwsh -NoProfile -Command "$null = [ScriptBlock]::Create((Get-Content -Raw scripts/release.ps1)); 'release.ps1 parses OK'"`
Expected: prints `release.ps1 parses OK` (a syntax error throws instead).

- [ ] **Step 5: Commit**

```
git add scripts/release.ps1
git commit -m "build(release): read AURA_UPDATER_KEY_PASSWORD from .env.local"
```

---

## Phase 2 — TMDB id plumbing

### Task 5: `stremio.rs` — extract `_tmdbId`; add `MetaDetail.tmdb_id`

**Files:**
- Modify: `src-tauri/src/stremio.rs`

- [ ] **Step 1: Add the `tmdb_id` field to the `MetaDetail` struct**

In `src-tauri/src/stremio.rs`, in the `pub struct MetaDetail` definition, immediately after the `pub anidb_id: Option<u32>,` field (and before `pub season_credits: ...`), insert:

```rust
    /// The Movie Database (TMDB) numeric id when the addon stamps one.
    /// Sourced from AIOMetadata's `_tmdbId` — correct on live-action
    /// series, unreliable for anime (null, or the broken literal
    /// "[object Object]"). Drives the publicmetadb OP/ED skip lookup.
    pub tmdb_id: Option<i64>,
```

- [ ] **Step 2: Extract `_tmdbId` next to the existing anime ids**

In the same file, find the block that computes `mal_id` / `kitsu_id` / `anidb_id` (the three `read_numeric_id(...)` calls inside `build_meta_detail`). Immediately after the `let anidb_id = read_numeric_id(meta, &["_anidbId", "anidbId", "anidb_id"]);` line, insert:

```rust
    // TMDB id — AIOMetadata's `_tmdbId` (a JSON string like "61859" on
    // live-action series; null or the broken literal "[object Object]"
    // on anime — both yield None, since read_numeric_id's str branch
    // does a numeric parse). Widened to i64 for the publicmetadb lookup.
    let tmdb_id = read_numeric_id(meta, &["_tmdbId", "tmdbId", "tmdb_id"])
        .map(i64::from);
```

Then update the very next `crate::devlog!` line (the one logging `anime ids: mal=... kitsu=... anidb=...`) to also report `tmdb`:

```rust
    crate::devlog!(
        info, "meta",
        "[{}] anime ids: mal={mal_id:?} kitsu={kitsu_id:?} anidb={anidb_id:?} tmdb={tmdb_id:?}",
        label,
    );
```

- [ ] **Step 3: Add `tmdb_id` to the `MetaDetail` struct literal**

In the same `build_meta_detail` function, find the `Ok(MetaDetail { ... })` constructor at the end. Immediately after the `anidb_id,` line, insert:

```rust
        tmdb_id,
```

- [ ] **Step 4: Verify**

Run (from repo root): `cd src-tauri ; cargo check --message-format=short ; cd ..`
Expected: no errors. (A missing struct field, a missing literal field, or a type mismatch would all fail here.)

- [ ] **Step 5: Commit**

```
git add src-tauri/src/stremio.rs
git commit -m "feat(meta): parse AIOMetadata _tmdbId into MetaDetail.tmdb_id"
```

### Task 6: `src/types.ts` — add `MetaDetail.tmdb_id`

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add the field to the TS `MetaDetail` interface**

In `src/types.ts`, in `export interface MetaDetail`, immediately after the `anidb_id: number | null;` line, insert:

```ts
  /** The Movie Database (TMDB) numeric id when the addon stamps one.
   *  Reliable for live-action series (AIOMetadata `_tmdbId`); usually
   *  null for anime. Drives the publicmetadb OP/ED skip lookup. */
  tmdb_id: number | null;
```

- [ ] **Step 2: Verify**

Run (from repo root): `pnpm exec tsc --noEmit`
Expected: no errors. (Tauri serialises the Rust `MetaDetail` with its field names verbatim; `tmdb_id` now lines up on both sides.)

- [ ] **Step 3: Commit**

```
git add src/types.ts
git commit -m "feat(meta): add tmdb_id to the MetaDetail TS interface"
```

---

## Phase 3 — `publicmetadb.rs` fetcher

### Task 7: create `src-tauri/src/publicmetadb.rs` + declare the module

**Files:**
- Create: `src-tauri/src/publicmetadb.rs`
- Modify: `src-tauri/src/lib.rs` (module declaration only)

- [ ] **Step 1: Create `src-tauri/src/publicmetadb.rs` with this exact content**

```rust
// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// publicmetadb skip-timestamp client.
//
// Endpoint:
//   GET https://publicmetadb.com/api/external/skips
//       ?tmdb_id={id}&media_type={tv|movie}&season={n}&episode={n}
//   Header: Authorization: Bearer <AURA_PUBLICMETADB_KEY>
//
// Response (the fields we consume):
//   { "items": [ { "intro_start_ms": …, "intro_end_ms": …,
//                   "credits_start_ms": …, "credits_end_ms": … }, … ] }
//
// publicmetadb is a crowd-sourced skip database — Aura's PRIMARY skip
// source for live-action series (which AniSkip does not cover) and a
// best-effort SECONDARY source for anime. The key is app-owned, baked
// at build time by build.rs (the mdblist.key pattern); an empty key
// makes the whole module cleanly no-op.
//
// A dedicated HTTP client + cache keep publicmetadb latency off the
// addon catalog path — same discipline as aniskip.rs.
// ---------------------------------------------------------------------------

const PUBLICMETADB_URL: &str = "https://publicmetadb.com/api/external/skips";
const AURA_PUBLICMETADB_KEY: &str = env!("AURA_PUBLICMETADB_KEY");
const NEGATIVE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// One skip row from publicmetadb's `items[]`. Every field is optional —
/// a row may carry only an intro, only credits, or neither.
#[derive(Debug, Clone, Deserialize)]
struct ApiSkipItem {
    #[serde(default)] intro_start_ms:   Option<f64>,
    #[serde(default)] intro_end_ms:     Option<f64>,
    #[serde(default)] credits_start_ms: Option<f64>,
    #[serde(default)] credits_end_ms:   Option<f64>,
}

#[derive(Debug, Clone, Deserialize)]
struct ApiResponse {
    #[serde(default)]
    items: Vec<ApiSkipItem>,
}

/// One normalized skip window. Shape mirrors `aniskip::SkipWindow`
/// minus `skip_id` (publicmetadb rows carry no per-row vote identity).
/// `kind` is "op" (from intro_*) or "ed" (from credits_*); `start` /
/// `end` are SECONDS — the API gives milliseconds, converted on the
/// way out.
#[derive(Debug, Clone, Serialize)]
pub struct PublicmetadbWindow {
    pub kind:   String,
    pub start:  f64,
    pub end:    f64,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PublicmetadbSkips {
    /// True when at least one usable window was produced.
    pub found:   bool,
    pub windows: Vec<PublicmetadbWindow>,
}

// ---------------------------------------------------------------------------
// Cache — positive results kept indefinitely (skip data for a given
// episode is stable once submitted); 404 / empty negatives expire after
// 24 h. Keyed by tmdb_id:media_type:season:episode.
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CacheEntry {
    payload:   PublicmetadbSkips,
    cached_at: Instant,
}

static CACHE: OnceLock<Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, CacheEntry>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_key(tmdb_id: i64, media_type: &str, season: u32, episode: u32) -> String {
    format!("{tmdb_id}:{media_type}:{season}:{episode}")
}

// ---------------------------------------------------------------------------
// HTTP client — dedicated, so publicmetadb latency / errors don't bleed
// into the addon catalog path. Mirrors aniskip.rs's client config.
// ---------------------------------------------------------------------------

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .https_only(true)
            .timeout(Duration::from_secs(8))
            .tcp_nodelay(true)
            .tcp_keepalive(Duration::from_secs(60))
            .user_agent(concat!("Aura/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("publicmetadb client init failed")
    })
}

/// Convert a millisecond start/end pair into a seconds-based window when
/// both are present, finite, and form a positive interval. Malformed
/// rows collapse to None and are dropped.
fn window_from_ms(
    kind: &str,
    start_ms: Option<f64>,
    end_ms: Option<f64>,
) -> Option<PublicmetadbWindow> {
    let (s, e) = (start_ms?, end_ms?);
    if !s.is_finite() || !e.is_finite() {
        return None;
    }
    let (start, end) = (s / 1000.0, e / 1000.0);
    if end <= start || start < 0.0 {
        return None;
    }
    Some(PublicmetadbWindow {
        kind:   kind.to_string(),
        start,
        end,
        source: "publicmetadb".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Command — fetch_publicmetadb_skips(tmdb_id, media_type, season, episode)
//
// Returns the OP/ED windows for one episode. Network / HTTP / parse
// failure and "no data" all collapse to `found: false, windows: []` —
// the caller falls through to the next skip source. Never hard-fails.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fetch_publicmetadb_skips(
    tmdb_id:    i64,
    media_type: String,
    season:     u32,
    episode:    u32,
) -> Result<PublicmetadbSkips, String> {
    let empty = PublicmetadbSkips { found: false, windows: vec![] };

    // No key baked → feature inert (the mdblist.key pattern).
    if AURA_PUBLICMETADB_KEY.trim().is_empty() {
        return Ok(empty);
    }

    // The API only knows `tv` / `movie`; anything else is coerced to tv.
    let mt = match media_type.as_str() {
        "movie" => "movie",
        _       => "tv",
    };
    let key = cache_key(tmdb_id, mt, season, episode);

    // Cache hit? Positive kept forever; negative expires after 24 h.
    {
        let lock = cache().lock().unwrap();
        if let Some(entry) = lock.get(&key) {
            let stale = !entry.payload.found
                && entry.cached_at.elapsed() >= NEGATIVE_TTL;
            if !stale {
                crate::devlog!(
                    info, "publicmetadb",
                    "cache hit {key} found={} ({} window(s))",
                    entry.payload.found, entry.payload.windows.len(),
                );
                return Ok(entry.payload.clone());
            }
        }
    }

    crate::devlog!(
        info, "publicmetadb",
        "GET {PUBLICMETADB_URL} tmdb={tmdb_id} type={mt} s={season} e={episode}",
    );

    let resp = match client()
        .get(PUBLICMETADB_URL)
        .query(&[
            ("tmdb_id",    tmdb_id.to_string()),
            ("media_type", mt.to_string()),
            ("season",     season.to_string()),
            ("episode",    episode.to_string()),
        ])
        .bearer_auth(AURA_PUBLICMETADB_KEY)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            // Network-class failure — don't cache, so a transient blip
            // retries on the next episode load.
            crate::devlog!(warn, "publicmetadb", "request failed: {e}");
            return Ok(empty);
        }
    };

    let status = resp.status();
    if !status.is_success() {
        crate::devlog!(
            warn, "publicmetadb",
            "HTTP {} for {key}", status.as_u16(),
        );
        // 404 = "no data for this episode" — negative-cache it. Other
        // HTTP errors (5xx, 429) are transient — don't cache.
        if status == reqwest::StatusCode::NOT_FOUND {
            cache().lock().unwrap().insert(key, CacheEntry {
                payload: empty.clone(), cached_at: Instant::now(),
            });
        }
        return Ok(empty);
    }

    let raw = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            crate::devlog!(warn, "publicmetadb", "read error: {e}");
            return Ok(empty);
        }
    };
    let parsed: ApiResponse = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            crate::devlog!(
                warn, "publicmetadb",
                "JSON parse error: {e} body_len={}", raw.len(),
            );
            return Ok(empty);
        }
    };

    // A 200 with no items is a genuine "no skip data" answer — but it's
    // ALSO what a wire-shape mismatch (field names != this struct) looks
    // like, since every field is #[serde(default)]. Dump the raw body
    // (truncated) so a mismatch is diagnosable from the DevConsole.
    if parsed.items.is_empty() {
        crate::devlog!(
            info, "publicmetadb",
            "200 OK, items empty for {key} — body: {}",
            raw.chars().take(300).collect::<String>(),
        );
    }

    // Map the FIRST item: intro_* → an OP window, credits_* → an ED
    // window. ms → seconds; malformed pairs are dropped by window_from_ms.
    let mut windows: Vec<PublicmetadbWindow> = Vec::new();
    if let Some(item) = parsed.items.first() {
        if let Some(w) = window_from_ms("op", item.intro_start_ms, item.intro_end_ms) {
            windows.push(w);
        }
        if let Some(w) = window_from_ms("ed", item.credits_start_ms, item.credits_end_ms) {
            windows.push(w);
        }
    }

    let payload = PublicmetadbSkips { found: !windows.is_empty(), windows };

    // Cache positive AND "200-but-empty" results — an empty 200 is a
    // genuine "no skip data" answer; the 24 h negative TTL applies to it.
    cache().lock().unwrap().insert(key.clone(), CacheEntry {
        payload:   payload.clone(),
        cached_at: Instant::now(),
    });

    crate::devlog!(
        info, "publicmetadb",
        "resolved {key} found={} windows={}",
        payload.found, payload.windows.len(),
    );
    Ok(payload)
}

// ---------------------------------------------------------------------------
// resolve_anime_tmdb_id — best-effort kitsu/anidb/anilist → TMDB id.
//
// publicmetadb is TMDB-keyed. Live-action series get their TMDB id from
// AIOMetadata's `_tmdbId` (see stremio.rs::build_meta_detail). For anime
// that id is unreliable, so the anime publicmetadb fallback resolves a
// TMDB id from yuna.moe's relations API instead — the same API the
// AniSkip MAL resolver already uses, which returns a `themoviedb` field.
//
// Isolated as its own command + cache here (rather than retrofitting
// aniskip.rs::resolve_mal_id) so the change is contained. yuna.moe
// mappings are static — positives cached forever, negatives 24 h.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
struct YunaTmdbResponse {
    #[serde(default)]
    themoviedb: Option<serde_json::Value>,
}

#[derive(Clone)]
struct TmdbResolveEntry {
    tmdb_id:   Option<i64>,
    cached_at: Instant,
}

static TMDB_RESOLVE_CACHE: OnceLock<Mutex<HashMap<String, TmdbResolveEntry>>> = OnceLock::new();

fn tmdb_resolve_cache() -> &'static Mutex<HashMap<String, TmdbResolveEntry>> {
    TMDB_RESOLVE_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn resolve_anime_tmdb_id(source: String, id: u32) -> Option<i64> {
    let src = match source.to_lowercase().as_str() {
        "kitsu"   => "kitsu",
        "anidb"   => "anidb",
        "anilist" => "anilist",
        _         => return None,
    };
    let key = format!("{src}:{id}");

    {
        let lock = tmdb_resolve_cache().lock().unwrap();
        if let Some(entry) = lock.get(&key) {
            let stale = entry.tmdb_id.is_none()
                && entry.cached_at.elapsed() >= NEGATIVE_TTL;
            if !stale {
                return entry.tmdb_id;
            }
        }
    }

    let url = format!("https://relations.yuna.moe/api/ids?source={src}&id={id}");
    let tmdb_id: Option<i64> = async {
        let resp = client().get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let parsed: YunaTmdbResponse = resp.json().await.ok()?;
        // yuna.moe returns themoviedb as a number or null.
        parsed.themoviedb.as_ref().and_then(|v| v.as_i64())
    }
    .await;

    tmdb_resolve_cache().lock().unwrap().insert(key, TmdbResolveEntry {
        tmdb_id,
        cached_at: Instant::now(),
    });
    crate::devlog!(
        info, "publicmetadb",
        "resolve_anime_tmdb_id {src}={id} → {tmdb_id:?}",
    );
    tmdb_id
}
```

- [ ] **Step 2: Declare the module in `lib.rs`**

In `src-tauri/src/lib.rs`, in the block of `mod ...;` declarations near the top of the file, add a new line immediately after `mod player;`:

```rust
mod publicmetadb;
```

- [ ] **Step 3: Verify**

Run (from repo root): `cd src-tauri ; cargo check --message-format=short ; cd ..`
Expected: no errors. `cargo check` now compiles `publicmetadb.rs`. `env!("AURA_PUBLICMETADB_KEY")` resolves because Task 1 made `build.rs` bake it. Warnings that `fetch_publicmetadb_skips` / `resolve_anime_tmdb_id` are never used are expected here — they clear in Task 8 when the commands are registered.

- [ ] **Step 4: Commit**

```
git add src-tauri/src/publicmetadb.rs src-tauri/src/lib.rs
git commit -m "feat(publicmetadb): skip-timestamp fetcher + anime TMDB resolver"
```

### Task 8: register both commands (handler + permissions + capability + docs)

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/permissions/player.toml`
- Modify: `src-tauri/capabilities/default.json`
- Modify: `CLAUDE.md`

A Tauri command silently 401s at runtime unless it is registered in all three places (`generate_handler!`, the permission file, the capability file) — see `CLAUDE.md`. All three are required.

- [ ] **Step 1: Add both commands to `generate_handler!` in `lib.rs`**

In `src-tauri/src/lib.rs`, inside the `tauri::generate_handler![ ... ]` list, immediately after the `silencedetect::detect_outro_boundary,` line, insert:

```rust
            // ── publicmetadb (OP/ED skip source: live-action + anime) ──
            publicmetadb::fetch_publicmetadb_skips,
            publicmetadb::resolve_anime_tmdb_id,
```

- [ ] **Step 2: Add the `allow-publicmetadb` permission block to `player.toml`**

In `src-tauri/permissions/player.toml`, immediately after the `allow-aniskip` permission block (the `[[permission]]` whose `identifier = "allow-aniskip"`), add:

```toml
# ── publicmetadb (crowd-sourced OP/ED skip source) ──────────────────────────
[[permission]]
identifier = "allow-publicmetadb"
description = "Allows the frontend to fetch crowd-sourced OP/ED skip windows from publicmetadb and to resolve an anime TMDB id for that lookup"
commands.allow = ["fetch_publicmetadb_skips", "resolve_anime_tmdb_id"]
```

- [ ] **Step 3: Grant the permission in `capabilities/default.json`**

In `src-tauri/capabilities/default.json`, in the `"permissions"` array, immediately after the `"allow-aniskip",` entry, add:

```json
    "allow-publicmetadb",
```

- [ ] **Step 4: Add the `[publicmetadb]` log label to `CLAUDE.md`**

In `CLAUDE.md`, find the `- Rust log labels:` bullet under the Conventions section. In that line, change the `` `[scrobble]` `` entry to `` `[scrobble]`, `[publicmetadb]` `` (insert `[publicmetadb]` as a new label at the end of the comma-separated list, before the ` — grep these…` tail).

- [ ] **Step 5: Verify**

Run (from repo root): `cd src-tauri ; cargo check --message-format=short ; cd ..`
Expected: no errors and no `never used` warnings for `fetch_publicmetadb_skips` / `resolve_anime_tmdb_id` — registering them in `generate_handler!` is what marks them used.

- [ ] **Step 6: Commit**

```
git add src-tauri/src/lib.rs src-tauri/permissions/player.toml src-tauri/capabilities/default.json CLAUDE.md
git commit -m "feat(publicmetadb): register fetch + tmdb-resolve commands"
```

---

## Phase 4 — `App.tsx` merge wiring

The skip assembly lives in an async IIFE inside the play handler in `src/App.tsx`. It resolves a MAL id; on failure it is live-action, on success anime. `finishWithChapters(prepared, …)` stamps `prepared` (the primary tier), then `mergeChapterSkipWindows` adds chapter / heuristic windows that do not overlap `prepared` (the `windowOverlapFraction` guard), then a silencedetect pass fills a missing OP. Feeding publicmetadb windows in as `prepared` therefore makes them the primary source automatically — no change to `mergeChapterSkipWindows` or `skip-windows.lua` is needed.

### Task 9: `fetchPublicmetadbWindows` helper + live-action branch

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add the `fetchPublicmetadbWindows` helper**

In `src/App.tsx`, immediately after the `mergeChapterSkipWindows` function definition ends (its closing `}`) and before the `// ----` banner comment for `usePlayback`, insert:

```ts
// ---------------------------------------------------------------------------
// publicmetadb skip windows — crowd-sourced OP/ED timestamps from the
// publicmetadb skip database (TMDB-keyed). Aura's PRIMARY skip source
// for live-action series; a best-effort fallback for anime. Maps the
// Rust `PublicmetadbSkips` payload into `PreparedWindow`s, dropping any
// kind the user has switched off. Network / parse failure → empty list
// (the caller falls through to chapters / silencedetect).
// ---------------------------------------------------------------------------
async function fetchPublicmetadbWindows(
  tmdbId:    number,
  mediaType: "tv" | "movie",
  season:    number,
  episode:   number,
  modeFor:   (kind: string) => "off" | "prompt" | "auto",
): Promise<PreparedWindow[]> {
  try {
    const res = await invoke<{
      found:   boolean;
      windows: { kind: string; start: number; end: number; source: string }[];
    }>("fetch_publicmetadb_skips", {
      tmdbId,
      mediaType,
      season,
      episode,
    });
    if (!res.found || res.windows.length === 0) return [];
    return res.windows
      .filter((w) => modeFor(w.kind) !== "off")
      .map((w) => ({
        type:   w.kind,
        start:  w.start,
        end:    w.end,
        source: w.source, // "publicmetadb"
        auto:   modeFor(w.kind) === "auto",
      }));
  } catch (e) {
    console.warn(`[publicmetadb] lookup failed: ${String(e)}`);
    return [];
  }
}
```

- [ ] **Step 2: Wire publicmetadb into the live-action branch**

In the skip-assembly IIFE, find the `if (!malId) { … }` block whose body currently logs `[aniskip] no mal_id for … — chapter-only skip path` and calls `await finishWithChapters([], { silenceUrl: stream.url ?? null });`. Replace the **entire** `if (!malId) { … }` block with:

```ts
            if (!malId) {
              // Live-action, or anime we couldn't resolve to a MAL id.
              // publicmetadb is the PRIMARY skip source here — keyed by
              // the show's TMDB id + season/episode. It feeds
              // finishWithChapters as `prepared`, so chapters and the
              // silencedetect heuristic only fill kinds it did not
              // supply. No publicmetadb data → empty list, and the
              // chapter path still runs so chaptered live-action keeps
              // producing windows.
              let pmdbWindows: PreparedWindow[] = [];
              const laTmdb = detail?.tmdb_id ?? null;
              const laSegs = target.id.split(":");
              const laSeason = Number.isFinite(target.season as number)
                ? (target.season as number)
                : Number(laSegs[laSegs.length - 2]);
              const laEpisode = Number.isFinite(target.episode_num as number)
                ? (target.episode_num as number)
                : Number(laSegs[laSegs.length - 1]);
              if (laTmdb != null && Number.isFinite(laSeason) && Number.isFinite(laEpisode)) {
                pmdbWindows = await fetchPublicmetadbWindows(
                  laTmdb, "tv", laSeason, laEpisode, modeFor,
                );
                console.info(
                  `[publicmetadb] no mal_id for ${seriesId} — ` +
                  `tmdb=${laTmdb} s${laSeason}e${laEpisode} → ${pmdbWindows.length} window(s)`,
                );
              } else {
                console.info(
                  `[publicmetadb] no mal_id for ${seriesId} — skipped ` +
                  `(tmdb=${laTmdb} season=${laSeason} episode=${laEpisode}); chapter-only`,
                );
              }
              await finishWithChapters(pmdbWindows, { silenceUrl: stream.url ?? null });
              return;
            }
```

- [ ] **Step 3: Verify**

Run (from repo root): `pnpm exec tsc --noEmit`
Expected: no errors. (`detail.tmdb_id` is typed from Task 6; `fetchPublicmetadbWindows` is now called by the live-action branch so it is not flagged unused.)

- [ ] **Step 4: Commit**

```
git add src/App.tsx
git commit -m "feat(skip): publicmetadb as the primary skip source for live-action series"
```

### Task 10: anime branch — publicmetadb as the AniSkip fallback

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Insert the anime publicmetadb fallback**

In the skip-assembly IIFE, find the AniSkip lookup block — the `let prepared: PreparedWindow[] = [];` followed by the `try { … } catch (err) { … console.warn(`[aniskip] lookup failed…`); }` that builds `prepared` from `fetch_skip_windows`. Immediately after that `catch` block's closing `}`, and **before** the `// ALWAYS augment with chapters …` comment and its `await finishWithChapters(prepared, { silenceUrl: stream.url ?? null });` call, insert:

```ts
            // publicmetadb anime fallback — best-effort SECONDARY source.
            // Fires only when AniSkip left an OP or ED gap. The TMDB id
            // is resolved from yuna.moe's `themoviedb` (anime `_tmdbId`
            // from AIOMetadata is unreliable) using whichever anime id
            // we have. Fills ONLY the kinds AniSkip didn't supply. NOTE:
            // for multi-cour anime the MAL-local episode may not align
            // with TMDB numbering — that mis-key is the accepted
            // "best-effort" cost (AniSkip remains anime's primary source).
            try {
              const haveOp = prepared.some((w) => w.type === "op" || w.type === "mixed-op");
              const haveEd = prepared.some((w) => w.type === "ed");
              if ((!haveOp || !haveEd) && Number.isFinite(episodeNum)) {
                let animeTmdb: number | null = detail?.tmdb_id ?? null;
                const tmdbSources: ["kitsu" | "anidb" | "anilist", number | null | undefined][] = [
                  ["kitsu",   detail?.kitsu_id],
                  ["anidb",   detail?.anidb_id],
                  ["anilist", (detail as { anilist_id?: number | null } | null)?.anilist_id],
                ];
                for (const [src, sid] of tmdbSources) {
                  if (animeTmdb != null) break;
                  if (sid == null) continue;
                  try {
                    animeTmdb = await invoke<number | null>(
                      "resolve_anime_tmdb_id", { source: src, id: sid },
                    );
                  } catch { /* best-effort — leave null */ }
                }
                if (animeTmdb != null) {
                  const pmdb = await fetchPublicmetadbWindows(
                    animeTmdb, "tv", target.season ?? 1, episodeNum, modeFor,
                  );
                  for (const w of pmdb) {
                    if (w.type === "op" && !haveOp) prepared.push(w);
                    if (w.type === "ed" && !haveEd) prepared.push(w);
                  }
                  if (pmdb.length > 0) {
                    console.info(
                      `[publicmetadb] anime fallback: tmdb=${animeTmdb} → ${pmdb.length} window(s)`,
                    );
                  }
                }
              }
            } catch (e) {
              console.warn(`[publicmetadb] anime fallback failed: ${String(e)}`);
            }
```

- [ ] **Step 2: Verify**

Run (from repo root): `pnpm exec tsc --noEmit`
Expected: no errors. (`prepared` is `PreparedWindow[]`; `episodeNum`, `detail`, `target`, `modeFor` are all in scope at this point in the IIFE.)

- [ ] **Step 3: Commit**

```
git add src/App.tsx
git commit -m "feat(skip): publicmetadb fallback for anime when AniSkip has gaps"
```

---

## Phase 5 — Verification

### Task 11: full verification + manual runtime check

**Files:** none (verification only).

- [ ] **Step 1: Full static check**

Run (from repo root): `cd src-tauri ; cargo check --message-format=short ; cd .. ; pnpm exec tsc --noEmit`
Expected: both complete with no errors.

- [ ] **Step 2: Verify the release-script env wiring**

Run (from repo root): `pwsh -File scripts/release.ps1 -SkipBuild`
Expected: prints `[release] -SkipBuild set — env wiring validated, exiting.` with no password prompt and no error — confirming `release.ps1` picked up `AURA_UPDATER_KEY_PASSWORD` from `.env.local` (Task 4). If it errors that no password was found, `.env.local` is missing the `AURA_UPDATER_KEY_PASSWORD=` line (Task 2 Step 2).

- [ ] **Step 3: Manual runtime — live-action publicmetadb**

Build and run (`pnpm tauri dev`). Play an episode of a live-action series that has known publicmetadb skip data. Open the DevConsole (F12) and filter for `[publicmetadb]`. Expected: a `GET https://publicmetadb.com/... → N window(s)` line, and an OP/ED skip prompt or auto-skip firing per the user's skip settings. Requires `AURA_PUBLICMETADB_KEY` to be populated in `.env.local` (Task 2 Step 2) — with a blank key the module no-ops by design and this step cannot be exercised.

- [ ] **Step 4: Manual runtime — no regressions**

Confirm: (a) MDBList ratings still populate on a `tt`-keyed title's detail page (the MDBList key now sources from `.env.local`); (b) anime AniSkip OP/ED still fires on an anime episode (its path is unchanged); (c) a live-action series with NO publicmetadb data still gets chapter / heuristic skip windows (the `finishWithChapters` chapter path still runs).

- [ ] **Step 5: No commit** — this task only verifies; it produces no code change.

---

## Risks & notes for the implementer

- **publicmetadb wire shape.** The `ApiSkipItem` / `ApiResponse` field names (`items[]`, `intro_start_ms`, `intro_end_ms`, `credits_start_ms`, `credits_end_ms`) follow the design doc. Every field uses `#[serde(default)]`, so a *field-name* mismatch parses successfully but yields zero windows — silently. The "200 OK but no items" devlog in `fetch_publicmetadb_skips` dumps the raw body so Task 11 Step 3 can catch a shape mismatch. If the live API differs, adjust `ApiSkipItem` / `ApiResponse` and re-verify.
- **Anime episode/season alignment.** The anime fallback passes the MAL-cour-local `episodeNum` and `target.season ?? 1` to a TMDB-keyed API. For single-season anime these coincide; for multi-cour shows they may not, producing a wrong-episode lookup. This is the accepted "best-effort" cost per design Decision #3 — AniSkip remains anime's primary source.
- **Phase ordering.** Task 1 (build.rs) MUST precede Task 7 — `publicmetadb.rs`'s `env!("AURA_PUBLICMETADB_KEY")` is a compile-time macro that fails the build unless `build.rs` has defined that rustc-env.
- **Inert-by-default.** With `AURA_PUBLICMETADB_KEY` blank, `fetch_publicmetadb_skips` returns no windows and the feature ships dormant — exactly the MDBList posture. Populating the key in `.env.local` and rebuilding enables it; no code change required.
- **Anime-TMDB mechanism.** This plan resolves anime TMDB via an isolated `resolve_anime_tmdb_id` command rather than retrofitting `aniskip.rs::resolve_mal_id` (see the header note). If reviewers prefer the shared-struct approach, Task 7's `resolve_anime_tmdb_id` and Task 10's resolution loop are the only pieces that change.
- **Phase 1 is independently shippable.** Tasks 1–4 (the `.env.local` consolidation) form a self-contained unit that can land and ship on its own; Phase 3 onward depends on it only for the `AURA_PUBLICMETADB_KEY` bake.
