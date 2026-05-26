# Aura — publicmetadb OP/ED Skip Source + `.env.local` Secrets Consolidation

Status: APPROVED (2026-05-21). Brainstormed with the user; design approved.
Next step: implementation plan via the writing-plans skill.

## Motivation

Aura's OP/ED auto-skip currently draws from three sources: the AniSkip API
(anime, MyAnimeList-keyed), mpv chapter-list, and the ffmpeg `silencedetect`
heuristic. AniSkip covers anime well, but **live-action series have no
dedicated skip database** — only the silencedetect *guess* and named
chapters. publicmetadb (https://publicmetadb.com) exposes a crowd-sourced
skip-timestamp API — `GET /api/external/skips`, keyed by TMDB id +
media_type + season + episode, returning `intro_*` / `credits_*`
millisecond markers. Adding it as a source gives live-action series a real
skip database and anime a secondary fallback.

Separately, the user wants every env-var-shaped secret consolidated into the
already-git-ignored `.env.local` file.

## Verified findings (2026-05-21)

- AIOMetadata's `/meta/series/{imdb}.json` carries a `_tmdbId` field. On
  live-action series it is correct (The Night Manager `tt1399664` →
  `_tmdbId: "61859"`). On anime it is unreliable — `null` (My Hero
  Academia) or the broken literal string `"[object Object]"` (Daemons of
  the Shadow Realm — an AIOMetadata serialization bug).
- Aura parses no TMDB id today: `stremio.rs::read_numeric_id` extracts only
  `_malId` / `_kitsuId` / `_anidbId`.
- yuna.moe (queried during AniSkip MAL resolution) returns a `themoviedb`
  field that Aura's `YunaIds*` structs currently discard.
- Skip windows are assembled on the frontend in `App.tsx` (`finishWithChapters`),
  written to the mpv `user-data/aura/skip-windows` property, and consumed by
  the reactive `skip-windows.lua` script (which does no networking).
- `aniskip.rs` is the model for an external skip fetcher: dedicated HTTP
  client, positive + negative caching, `SkipWindow` / `PreparedWindow`
  shapes, `set_skip_windows`.
- Secrets today: `src-tauri/mdblist.key` (a standalone file baked by
  `build.rs`), `.env.local` (Sentry upload tokens, read by Vite +
  `release.ps1`), `aura-updater.key` (the minisign signing key + its
  password). `.env` and `.env.local` are already git-ignored.

## Part A — Secrets consolidated into `.env.local`

`.env.local` (already exists, git-ignored, already read by Vite via
`loadEnv(mode, cwd, "")`) becomes the single home for every
env-var-shaped secret:

| Variable | Consumed by | Migrated from |
|---|---|---|
| `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_URL` | Vite + `release.ps1` | already in `.env.local` |
| `AURA_MDBLIST_KEY` | `build.rs` → baked into binary | the standalone `mdblist.key` file (retired) |
| `AURA_PUBLICMETADB_KEY` | `build.rs` → baked into binary | new |
| `AURA_UPDATER_KEY_PASSWORD` | `release.ps1` | ad-hoc env var / `-Password` arg |

Changes:

- **`build.rs`** gains a small dotenv parser (`KEY=VALUE` lines, `#`
  comments and blanks skipped) that reads `../.env.local` (build scripts
  run with cwd = `src-tauri/`). It bakes `AURA_MDBLIST_KEY` and
  `AURA_PUBLICMETADB_KEY` via `cargo:rustc-env`. A real environment
  variable of the same name still overrides the file (for CI). Adds
  `cargo:rerun-if-changed=../.env.local`. A missing/empty key bakes an
  empty string, and the consuming feature cleanly no-ops — preserving
  today's MDBList behaviour.
- The standalone `mdblist.key` file is retired; its `.gitignore` entry is
  kept (harmless) or removed.
- **`release.ps1`** reads `AURA_UPDATER_KEY_PASSWORD` from `.env.local`
  (it already parses `.env.local` for `SENTRY_*`), so the release no
  longer needs the password passed by hand.
- **Vite** already reads `.env.local` — Sentry behaviour is unchanged.
- The `aura-updater.key` minisign key file stays a file (a multi-line key
  is not an env var); only its *password* moves into `.env.local`.
- `.env.local` is created if absent; a tracked `.env.example` documents
  every variable with no values.

## Part B — TMDB-id plumbing

publicmetadb is TMDB-keyed; Aura has no TMDB id today.

- **Live-action (primary path):** extend `stremio.rs::read_numeric_id` (the
  existing `_malId` / `_kitsuId` / `_anidbId` extractor) to also read
  `_tmdbId`. Add `tmdb_id: Option<i64>` to the Rust `MetaDetail` struct and
  the frontend `MetaDetail` type (`src/types.ts`). `_tmdbId` is a JSON
  string ("61859") — parse to a number; the broken `"[object Object]"`
  value parses to `None`.
- **Anime (fallback path):** AIOMetadata's `_tmdbId` is unreliable for
  anime, so capture TMDB from yuna.moe's `themoviedb` field — already
  fetched during AniSkip MAL resolution, merely discarded today. Add
  `themoviedb` to the `YunaIds*` structs. Anime TMDB is therefore
  best-effort: when unavailable, anime keeps AniSkip + silencedetect with
  no publicmetadb fallback — acceptable, since AniSkip already covers anime.
- Rejected: a TMDB `/find` API call (a whole new API + key) and the
  Fribb-list `tmdb` field (redundant second source) — YAGNI.

## Part C — `publicmetadb.rs` fetcher

A new Rust module modelled on `aniskip.rs`:

- `const AURA_PUBLICMETADB_KEY: &str = env!("AURA_PUBLICMETADB_KEY")`. Empty
  key → the module no-ops (mdblist pattern).
- A `fetch_publicmetadb_skips(tmdb_id, media_type, season, episode)` Tauri
  command. Issues `GET https://publicmetadb.com/api/external/skips` with
  `tmdb_id`, `media_type` (`tv` | `movie`), `season`, `episode` query
  params and an `Authorization: Bearer <key>` header. The `source` param
  is omitted (or `streaming`).
- Maps the first `items[]` entry: `intro_start_ms`/`intro_end_ms` → an OP
  skip window, `credits_start_ms`/`credits_end_ms` → an ED skip window
  (milliseconds → seconds; Aura's windows are in seconds).
- Caches per `{tmdb_id}:{media_type}:{season}:{episode}` — positive
  responses cached, 404 / empty `items` negative-cached 24 h. Mirrors
  `aniskip.rs` cache discipline; a dedicated HTTP client keeps publicmetadb
  latency off the addon catalog path.
- Network / HTTP failure or empty `items` → returns no windows; the caller
  falls through to the next source. Never hard-fails.
- The command is registered in all three required places: the
  `tauri::generate_handler!` list in `lib.rs`, `permissions/player.toml`,
  and `capabilities/default.json`.

## Part D — Priority / merge

Wired into the existing skip-assembly in `App.tsx` (`finishWithChapters`).
No changes to `skip-windows.lua`; no new user-facing setting — windows feed
the existing per-kind `op` / `ed` auto / prompt / off modes and are tagged
`source: "publicmetadb"` for DevConsole visibility and the AniSkip-submit
overlap guard.

- **Live-action series** (no MAL id resolves): call
  `fetch_publicmetadb_skips` with `media_type = tv`, the show's `tmdb_id`,
  and season/episode (already known from the `tt…:S:E` stream id).
  publicmetadb is the **primary** source → then chapters → then the
  silencedetect OP heuristic. Each lower source only fills kinds a higher
  one did not supply; the existing `windowOverlapFraction` guard already
  prevents double-stamping.
- **Anime**: AniSkip first (unchanged) → publicmetadb fallback (only when a
  TMDB id resolved) → chapters → silencedetect.

## Security model — what "stored securely" means

- `.env.local` is a build-time **input**. It is never bundled and never
  shipped: git-ignored, and not listed in `tauri.conf.json` `resources` /
  `externalBin`.
- **Runtime keys** (`AURA_MDBLIST_KEY`, `AURA_PUBLICMETADB_KEY`) are
  compiled into the binary via `env!()`. They are not in source control
  and not in a plaintext file on the user's disk, but are extractable from
  the binary by a determined user. That is inherent to any client-embedded
  API key and cannot be avoided without a server-side proxy; it is the
  exact posture MDBList already has. publicmetadb's key is a free,
  rate-limited bearer token — an acceptable exposure profile.
- **Build-only secrets** (`SENTRY_*`, `AURA_UPDATER_KEY_PASSWORD`) are
  consumed by build / release tooling and never enter the shipped binary
  at all.

## Decisions (locked)

1. All env-var-shaped secrets live in the existing `.env.local` — not a
   new `.env` file.
2. The publicmetadb key is app-owned and baked via `build.rs` (the
   `mdblist.key` pattern). The feature is inert when the key is absent.
3. Live-action TMDB id comes from AIOMetadata's `_tmdbId`; anime TMDB id is
   best-effort from yuna.moe's `themoviedb`. No TMDB `/find` API; no Fribb
   `tmdb` field.
4. No new user setting — publicmetadb windows feed the existing
   op/ed auto/prompt/off skip modes.
5. publicmetadb `source` query param: omitted (defaults) or `streaming`.

## Component plan (to be expanded by the implementation plan)

1. **`.env.local` consolidation** — `build.rs` dotenv parser; bake
   `AURA_MDBLIST_KEY` + `AURA_PUBLICMETADB_KEY`; migrate `mdblist.key`
   contents and the updater password into `.env.local`; `release.ps1`
   reads the password from `.env.local`; update `.env.example`; retire the
   `mdblist.key` file.
2. **TMDB-id plumbing** — `stremio.rs` `_tmdbId` extraction +
   `MetaDetail.tmdb_id`; frontend `MetaDetail` type; yuna.moe `themoviedb`
   deserialization in `aniskip.rs`.
3. **`publicmetadb.rs`** — fetcher, cache, Tauri command, three-place
   registration.
4. **`App.tsx` merge wiring** — anime-vs-live-action branch and the
   priority order above.
5. **Verification** — `cargo check` + `tsc --noEmit`; manual run against a
   live-action series with a known publicmetadb entry.

## Out of scope

- Movie credits-skip: Aura's skip feature is series-only (it bails for
  the `movie` type), even though publicmetadb supports `media_type=movie`.
- A publicmetadb submission / contribution UI.
- Per-user publicmetadb API keys — the key is app-owned only.
