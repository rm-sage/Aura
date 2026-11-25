---
paths:
  - "src/metaCache.ts"
  - "src/persistentCache.ts"
  - "src/historyStore.ts"
  - "src/sync.ts"
  - "src/watchedSync.ts"
  - "src/userDataBackup.ts"
  - "src/releaseDates.ts"
  - "src/movieEarly.ts"
  - "src/availableEarly.ts"
  - "src/airingCheck.ts"
  - "src/useAiringStreamCheck.ts"
  - "src/scrobbledStore.ts"
  - "src/heroBackdrop.ts"
  - "src/sessionRoute.ts"
  - "src/views/AddonsView.tsx"
  - "src-tauri/src/history_store.rs"
  - "src-tauri/src/sync.rs"
  - "src-tauri/src/backup.rs"
  - "src-tauri/src/release_dates.rs"
  - "src-tauri/src/addons.rs"
  - "src-tauri/src/stremio.rs"
---

# Caching boundaries (full)

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: any cache, persisted store, history_store.rs / historyStore.ts, sync.ts, backup.rs, addon manifest refresh and Stremio collection writes.

## Caching boundaries

Bound every cache (see "Performance and memory" in the root CLAUDE.md).

- **Library**: localStorage warm-start in `App.loadLibrary` (keyed by `auth_key.slice(0, 12)`), plus
  a 5-minute focus-refetch debounce, plus a 5-minute `recentlyCleared` overlay that re-zeroes
  `state.timeOffset` for ids cleared in the last window (Stremio's `datastoreGet` is eventually
  consistent on `_mtime`, so a fresh fetch within the window can return stale non-zero state).
  The library snapshot is NEVER the source of a Rewind write: `aura:cw-clear` (the CW X, Reset
  Progress) re-reads the account with `library_get` first and hands `libraryClearProgress` that
  title's fresh RAW records (milliseconds untouched). No record left (removed elsewhere; library_get
  omits removed rows) drops the title locally and writes nothing; a failed or empty read writes
  nothing and rolls back. `libraryClearProgress` itself never writes without a raw record.
- **metaCache.ts** (`aura:meta-cache:v2`): TTL 4 h series/anime, 7 d movies, 90 s nulls; cap ~800
  entries (~1.5 MB); 500 ms write debounce; null entries not persisted. A meta whose videos embed
  their own streams lives 3 min (`TTL_EMBEDDED_STREAMS_MS`) and is never persisted.
- **persistentCache.ts**: generic TTL + size-capped store (AniSkip uses it at 3 days / 600 entries,
  dropping the oldest 25% on overflow; negative misses are never cached).
- **IntroDB** (`aura:introdb-cache:v1`, `src/introdb.ts`): positive answers only, 3 days / 600
  entries, keyed `${imdb}:${season}:${episode}` per numbering asked. Rust (`introdb.rs`) keeps an
  in-memory map capped at 400 (oldest quarter evicted): hits 3 days, "no data" 30 minutes,
  network / 429 / 5xx never cached. A successful submit drops that key on both sides. Segments are
  cached WITHOUT the per-file duration check; `fitCrowdToDuration` (`src/skipWindows.ts`) applies it to every crowd source inside
  `mergeChapterSkipWindows` once the duration is known (and again in `finishWithChapters` when mpv
  reports the duration only after the chapter poll gave up: the crowd rows are re-fitted and the
  chapter windows re-derived against it).
- **Skip detection** (Rust, under `app_data_dir()`, atomic writes, oldest first, one process lock):
  `animethemes-v1.json` (MAL -> theme list; hits 7 d, misses 1 d, network errors never cached, cap
  300), `theme-fp/<audio_id>.bin` (fingerprint + valid mask + length + audible lead / trail, never
  the audio; 90 d, cap 400) and `skipdetect-v1.json` (the final per-file result keyed by Stremio id,
  release identity and duration to 0.1 s, a duration within 0.03 s of a bucket boundary also
  reading the ONE adjacent bucket, accepted only when that entry was keyed within the same 0.03 s
  (`cache::neighbour_duration`, `Snapshot::keyed_duration`); 30 d, an abstention 24 h; a Layer 3 window standing in for
  a theme the cour's list does not have lives no longer than that list answer: 24 h after a list miss,
  7 d when the list answered without a theme of that kind; cap 2000). An entry records the kinds and MAL id it was computed
  for and answers only a request it covers. The result cache is the only fix for a slow link. No in-memory mirror of results, so Settings > Storage's "Skip detection cache"
  clear cannot be undone by a stale copy; the one in-memory state is the pre-scan's `PRESCANNED`
  session record (what was pre-scanned, never results), which the clear empties through
  `forget_prescanned`; any new path that deletes `skipdetect-v1.json` must call it too. A result
  write from a job that started before a clear is refused (`cache::put_result_since`, the clear
  generation checked under the cache lock), so a write already in flight cannot refill it. Excluded from backups by construction.
- **Episodes available early** (`aura:available-early:v1`, `src/availableEarly.ts`, cap 200, device-local):
  an episode whose stream fetch (detail page, Next-Up pre-resolve) returned streams while its listed
  `released` was still ahead, by at most 4 days. `releasedMs` (the date every aired / next-to-air read
  goes through: `isVideoAired`, `nextAiringEpisode`, `airingInfo`, Next-Up, the CW countdown) then
  counts it aired from that moment; an entry is dropped once its listed date passes. Why: AIOMetadata
  dated TYBW S4E10 1.5 days after Cinemeta, and CW counted down to an episode the user could play.
  Read new aired checks through `releasedMs`, never a bare `Date.parse(v.released)`.
  The airing check (`src/airingCheck.ts` pass, `src/useAiringStreamCheck.ts` hook in App.tsx) feeds it
  without the user opening anything: every 10 min while visible, never while playing or hidden, a library
  series whose next main-run episode is LISTED within 24 h gets one `fetch_streams` for it, at most once
  an hour per episode, 6 queries and 10 meta fetches per pass (a show without a cached detail is fetched
  only when it is in Continue Watching or the cloud's next_aired is in the window). Each query is a full
  stream-addon fan-out (debrid checks included): keep those caps. DevConsole `[airing-check]`.
  During playback (a binge, when the check is paused) `resolveNextEpisode` covers it: caught up, it probes
  the next episode listed within 24 h (`probeListedNext`, at most every 5 min per episode, so the early
  pre-scan lookup, the 50 % retry and the end screen each get one) and hands the stream it picked on, so a
  hit costs one fan-out, not two. The end screen never waits on it: it shows its caught-up card from the
  cached meta (`{ probe: false }`), then runs `probeNextEpisode` and swaps in the Next-Up card on a hit.
  The cloud's `next_aired` ids follow the cloud's own source's numbering, not the local meta addon's, so "is the cloud's next episode already out" goes through `cloudNextIsOut`
  (by id, else by date against a recorded local episode), never a bare `availableEarlyAt(sig.id)`.
- **Calendar meta**: 24-hour module-level `Map` keyed by `${addonUrl}::${type}::${id}`.
- **Movie release dates** (`src-tauri/src/release_dates.rs`, `src/releaseDates.ts`, `src/movieRelease.ts`): the
  frontend caches per IMDb id (cap 500): 5 min for an all-null answer or one whose TMDB lookup FAILED (`tmdb:
  "failed"`), 6 h otherwise. Rust has no cache. The source order is TMDB's per-country release_dates for the
  Windows "Country or region" (`GetUserGeoID` + `GetGeoInfoW`, else the locale's country, else US; NEVER
  `GetUserDefaultGeoName`, a Win10 1709+ load-time import that stops aura.exe starting on older Win10), then US, then the
  earliest country, then MDBList, then the +45-day estimate. MDBList is the LAST source on purpose: it gave Nolan's
  The Odyssey a digital date of 2026-11-07 against TMDB's and Universal's 2026-11-17, and Aura then showed the film
  as already digital. Never let a failed TMDB answer be cached long: it is answered from MDBList alone. The film is
  found by `/find` on the IMDb id only, never the addon meta's `tmdb_id` (it can be a SERIES id). Re-release rows
  and rows over 730 days after the first of their kind are not the release; another country's digital date before
  the user's OWN theatrical run is dropped. Dates are local calendar days (local midnight), not UTC instants. Every
  date shows its basis: Confirmed (a TMDB row), Reported (MDBList or the addon), Estimate. "In Theaters" lasts
  until a known digital date (365 days at most), else 120 days; no source publishes a run's end, and its hover
  says so. Devlog label `[release-dates]`.
- **Movies out early** (`aura:movie-early:v1`, `src/movieEarly.ts`, cap 100, device-local): a film whose copies are
  out before its official digital date (Nolan's The Odyssey leaked 2026-11-07, ten days before its US digital day).
  A leak never moves the official date; the Digital countdown shows "Out early" beside it. The check is the DETAIL
  PAGE's own movie stream fetch (user's call: no background fan-out); the Digital countdown says "Checking for early
  copies" while it runs, and the hover panel only reads what it left. Evidence, strongest first: AIOStreams' "Early
  Release" notice (`streamData.code: "earlyRelease"` + `data`) or a stream it flagged (`streamData.earlyRelease =
  { source, evidence }`, Rust `StreamEntry.early_release`) is Verified with source leakDetected / leakRecord or a
  proof file (`evidence: true`, a runtime match), else (source "bypass") Unverified; without AIOStreams, home-release
  rows (WEB-DL, BluRay, REMUX, ...) are Unverified (a same-name film's files or another country's real release look
  the same, so the bare scene tag WEB counts), theater rows (CAM, TS, TC) and unlabelled rows are notes. Only an
  AIOStreams-backed record (Verified, Unverified-by-bypass) holds against a weaker answer; a guessed one is replaced
  by the next real answer. An answer missing an addon that was asked (`StreamMetadata.failed_addons`: send error,
  non-2xx, bad JSON, a panic; such failures leave no message) records only an early release. The check runs once the
  dates have landed, against the Digital countdown day; on the +45-day Estimate (no digital date announced) the record
  carries `estimate` and a find reads "Streams available", never "Out early" (nothing official to be early against).
  Readers show a record only for the same day AND basis it was checked against (`earlyRecordFor`), and a hold applies
  only within one. The hover panel shows a quiet "Not checked for early copies yet" ("... for streams yet" on the Estimate) line under the
  Digital countdown for a film it could show a check for and has none; each countdown has its own line there and on the
  detail page (under the facts row), so a countdown never shares a wrapped line with another. The stream-list note describes the list shown, not the stored record. The dedup in
  `fetch_streams` carries a dropped duplicate's `early_release` onto the kept row. An early release lasts until the
  official day (at most 120 days); anything else 6 h. AIOStreams
  sends `streamData` only with PROVIDE_STREAM_DATA on (or to an "AIO" User-Agent). Notices are matched by
  `StreamMessage.code` ("digitalReleaseFilter", "earlyRelease"), never by wording, except an older AIOStreams with
  no code (`isDigitalReleaseFilterNotice`). A pseudo-stream with a code and no address is a notice whatever its
  `type`; one with an address stays a stream.
- **sessionRoute.ts** (`sessionStorage`): active nav tab + open detail target so Ctrl+R/F5 restores
  the page you were on; cleared on app close (cold start opens Home).
- **Notifications** (`aura:notifications:v1`): ring buffer capped at 200 entries.
- **Watch history** (`history_store.rs` + `src/historyStore.ts`): user data, NOT a cache, and
  deliberately UNCAPPED. One gzip file per scope, `app_data_dir()/history/<scope>.history.gz`:
  a versioned compact form (every string interned once, field names and kinds stored once per
  row shape, an ISO timestamp kept as a ms delta ONLY when it round-trips byte-exactly through
  JS `toISOString`, else as a string, since `played_at` is half of the removal key), measured
  25.8 KB for the real 650-row history (380 KB as JSON), 229 KB at 10k rows, 2.2 MB at 100k.
  Rust owns the file and holds ONE scope resident; writes are coalesced (1.5 s) and atomic, with
  a synchronous flush on exit (`flush_blocking`, CloseRequested) and before an updater install.
  "Durable" means LANDED, not snapshotted: the exit flush, a scope swap and the migration go
  through `make_durable` (holds WRITES, so it waits out a write in flight, then compares the
  resident generation with the one on disk), a swap whose old scope cannot be written is
  REFUSED rather than dropping its rows, and after `flush_blocking` every call writes before
  returning. A file that EXISTS but cannot be read (AV / backup / OneDrive holding it, an I/O
  error) is never an empty history: the scope is resident as unreadable, nothing is written
  for it, `load` and every op but `append` fail (the frontend retries forever, 30 s apart after
  three quick tries, and the History view says so), and appends are kept and also written on
  every append to a sidecar, `<scope>.history.pending.gz` (a crash or updater relaunch has no exit
  path), merged where the scope next becomes resident and removed only by a landed write holding
  its rows. A play whose scope swap was refused is parked in Rust (`PARKED`, cap 500) until the
  swap or the exit flush. A file that does not decode is set aside as `.gz.bad` only if that rename
  works (else unreadable), and the load reports `recovered`: sync.ts then pulls history with no
  If-None-Match and nothing is pushed until a cloud merge (or a 404) lands. That latch is persisted
  (`<scope>.history.recovering` beside the file, written before the rename, none for a guest): a
  restart or scope swap reports it again, even once a play has written a new file, and it goes only
  when the merged rows are on disk or the pull found no cloud copy (`cloud_absent`). A signed-in
  scope with NO file takes the same latch at discovery, on whichever op reads first, because a
  persisted etag vouches for a file that is gone (`latch_missing_file`). MergeCloud writes
  synchronously when rows changed, so an etag never gets ahead of its rows. Each set-aside records
  its time in `<scope>.history.setaside` (guests too, up to 3), and backup.rs `prune_dir` keeps the
  newest auto snapshot older than each time, so snapshots of a near-empty history cannot roll out
  the last good one. A history Clear PUBLISHES the empty list and takes a snapshot first
  (`clearHistoryChecked`, which aborts without one); the Storage clears of manual-state, skip-marks
  and notifications stay local.
  The frontend keeps the synchronous API over an array hydrated by `load` and sends only small
  mutations, all through ONE promise chain; while a load / carry-over / cloud merge is in flight
  later writes are logged and replayed onto its result (do not "simplify" that away: it is what
  keeps a play made during startup or a pull). Anything that treats the list as authoritative
  (cloud push or merge, backups) awaits `historyReady()`; an empty pre-hydration list must never
  be pushed. Migration: the first load sends the scope's old localStorage copy
  (`aura:history:<scope>`), Rust unions it in, writes, reads back, and only on `verified` is the
  key removed (idempotent, so a crash just repeats it); if that write did not verify, a scoped
  `flush` is retried (and right after every remove / clear) and the key goes once it verifies,
  because a key left for the next launch would union back every row removed meanwhile. Cloud
  `history` blob: a JSON ARRAY of the newest rows in plain form (<= 500 / 256 KiB) followed by
  ONE element `{"v":2,"enc":"gzip-b64","n":N,"data":...}` holding the rest, built and read in
  Rust (history_store.rs "WIRE SHAPE"); legacy plain arrays and a bare envelope still read. The
  plain head is load-bearing: v2.2.4 pushes its whole list on its first local edit and merges
  only arrays, so a bare envelope let a fresh old install replace the cloud copy with its next
  play alone. That needs it to take a 200, so the history etag is stored under its own field
  (`history:v2` in `aura:sync:etags:<scope>`, read from nowhere else; a `history` there is v2.2.4's
  and is stripped on load, never adopted), at the cost of one full pull after upgrading. A push with
  a null If-Match overwrites unconditionally, so history sends one only when the last pull answered
  404 (`historyCloudAbsent`): an etag-less device whose pull failed or whose merge threw holds the
  push with the unpushed marker set, and a double 412 keeps the etag of the copy it merged, so the
  next attempt merges again. A guest never encodes. When
  the blob would pass the 1 MiB limit the CLOUD copy keeps the newest rows that fit (~24k of
  real rows) and the local file keeps all (Settings > Cloud Sync says so, from
  `aura:sync:history-trim:<scope>`, written when a push lands); a newer client that
  pulls an old client's plain array unions it and re-publishes (sync.ts "MIXED VERSIONS"). A
  pull merges history only into the history scope captured BEFORE its fetch, and every pull or
  push drops what it fetched once the account changed (`accountGen`, bumped by
  `clearSyncEtags`). Change events carry a `reason`; only `"mutation"` pushes or snapshots.
  The envelope and the file parse through `PlainValue` (`parse_capped`), never `Value`'s own
  `Deserialize`: tauri and axum force serde_json's `raw_value` on, which makes `Value` re-parse the
  string under the key `$serde_json::private::RawValue`, past the budget the text was charged.
  Backups get history from the store in Rust (`historyFromStore`, same JSON-array string under
  `values.history`; with the file unreadable an automatic snapshot is skipped rather than roll good
  ones out, and a user-initiated one is written without history and flagged `historyUnavailable`,
  so restoring it leaves history untouched). A Restore reads its target first, then takes the
  pre-restore snapshot with `protect` naming the target (still counted in the bucket's cap so its
  own prune cannot delete it), and stops if that snapshot fails. Snapshot writes remove their tmp on
  failure, and a prune sweeps tmp files older than an hour (younger ones may be in flight), and
  backup bodies are now gzipped under their OWN suffix `.aura-backup.json.gz` (readers accept
  both suffixes and both bodies): an older Aura's prune reads a gzipped body as text, finds no
  reason and would delete manual snapshots as auto, and its suffix filter skips `.gz`. `serde_json`'s `float_roundtrip` feature is
  on so floats survive the Rust round trip exactly; the migration's read-back depends on it.
  `scrobbledStore.ts`'s mark cap follows the history size (floor 4500, ceiling 30k, orphans
  evicted first).
- **EPG** (`src/iptv/epgStore.ts`): localStorage, ~4-week retention, parsed off-thread in a worker.
- **Story arcs**: `aura:story-arcs:v8` (24 h TTL, cap 60) holds the joined arcs per series; the TTL is
  short deliberately because an ongoing show gains an episode weekly and a stale arc would be missing
  it. `aura:arc-mode:v1` (cap 200) remembers the Seasons/Arcs choice per series. Rust side:
  `arcs-cache-v1.json` (TMDB payloads, 24 h, cap 40) and `arc-art-v3.json` (Fandom art, cap 60, keyed
  per show AND arc-name set so each grouping gets its own map; a hit lives 30 d, an empty map is a
  cached MISS honoured for only 24 h, because it is ambiguous between "this wiki has no arc art" and
  "Fandom was down when we asked"; so is a hit whose arc-title probe went unanswered, since that
  falls back to the similarity match the probe replaces). A show in the curated wiki table is not
  proof it HAS arc art.
  Bleach was taken off the art path for that reason (it is back in the table as `chapters_only`,
  for its episode pages): it never produced any art (no arc category, and 9 of 21 arc names
  redirect to one generic Episodes page), and the names that do reach a real page land on event
  pages whose lead images are episode screenshots, some of them spoilers. `arc-art-v3.json` entries
  also carry each arc's resolved PAGE (`pages`, for manga chapter ranges); an entry written before
  that field existed is recomputed on the first page lookup.
- **Manga chapters**: `manga-chapters-v1.json` (Rust, one file, per-entry TTL, cap 5000, oldest
  first): MangaUpdates series matches 7 d (misses 1 d), arc-page infobox ranges and episode pages
  30 d (misses 1 d; an episode that aired in the last 60 days is kept only a day, because new pages
  are created before their chapter field is filled). Frontend `mangaChapters.ts` holds at most 24
  series in memory for the session and nothing on disk.
- **Hero backdrop choice**: `aura:hero-backdrop:v1` (365 d TTL, cap 300) holds the backdrop URL the
  user picked for a title's detail hero (`heroBackdrop.ts`), validated on read, and forgets one whose
  image failed to load on two opens in a row (the count is stored with it). Device-local like
  `aura:arc-mode:v1`: not cloud-synced, not in settings export/import. Settings > Storage clears it
  through `clearPersistentCache` (every `PersistentCache` registers by storage key), because a bare `removeItem` under a live `PersistentCache` is written
  back, cleared entries included, by the cache's next save.
- **Addon manifest fields**: `AddonEntry`'s capability fields (`resources`, `types`, `id_prefixes`,
  `stream_types`, `stream_id_prefixes`, `has_search`) are populated at install/sync time and REBUILT
  by a manifest refresh (`refresh_addon_manifest`: the Refresh button, or the silent refresh after
  Configure), with the same builder `add_addon` uses. The rebuild is persisted to `addons.json` for
  guests. For a signed-in user (AddonsView passes `authKey`) the refresh also writes the manifest,
  VERBATIM as the addon served it (never an Aura struct), into that addon's entry of the Stremio
  collection, the snapshot the official apps and `get_synced_addons` read. The maintainer's condition
  is "definitely accurate and not potentially harmful", so a guard in doubt refuses (harmless: the
  rebuild then lasts the session only, and the stored snapshot wins again at the next launch). The
  guards (`write_refreshed_manifest`, `apply_refreshed_manifest`): the collection is re-read under the
  lock and must hold every url the addon list shows, exactly one entry must match, not `protected` and
  at the literal url fetched, and the manifest must parse in stremio-core within 32 levels of nesting
  and 1 MiB (`check_collection_manifest`; ONE unparseable entry locks the user's list in every
  official app), keep the stored `id`, not declare `configurationRequired`, differ from the stored
  one, and take nothing away (`manifest_reduction`: no resource, type, catalog, addon catalog or
  manifest-level idPrefix dropped, no resource serving fewer types or ids, no catalog or addon
  catalog kept by id and type that loses an extra name, gains a required extra or empties a required
  extra's options, no manifest-level ids narrowed from every id to a list, no lower semver), with
  both of those last compares made in stremio-core terms on BOTH sides (`stremio_core_manifest`),
  because the official apps store entries re-serialized and AIOMetadata stamps a per-request
  `_timestamp` into every manifest. A resource is read as stremio-core's `is_resource_supported`
  reads it: short form takes the manifest's `types` / `idPrefixes`, full form only its own (no
  `types` is none; null or [] ids is every id), and only the FIRST resource of a name counts. A
  catalog's extras are read as `ManifestExtra::iter` yields them (short form: the `extraSupported`
  names, required when `extraRequired` also names them, no options), because `is_extra_supported`
  stops sending a request whose extra is gone or whose required extra is missing, and a required
  extra with no options leaves `default_required_extra` nothing to send, so the Board drops the
  catalog. The no-reduction rule exists because an addon that wraps others (AIOStreams) answers 200
  with the same id while an upstream is down, and it declares types and ids per resource only, so
  the loss often shows up nowhere but a stream resource's `idPrefixes` (or, for an addon deriving
  its extras from an upstream, a catalog's extras); reinstalling the addon is how a user makes a
  reduction stick. Only that entry's `manifest` changes, and the silent post-Configure refresh
  passes `report: false` so it never waits for the write. All four collection writers (add, remove,
  reorder, this one) hold one `COLLECTION_WRITE_LOCK` from read to push and refuse with "Your
  Stremio account changed; reload the addon list and try again" when the read lacks a url the
  frontend shows (`check_collection_read`: a partial read pushed back deletes the rest on every
  device, and `addonCollectionGet` has returned one); add, remove and reorder also refuse an EMPTY
  read whatever the list says (a real collection keeps Stremio's protected defaults). An expected
  url is compared exactly as Rust handed it to the frontend, never normalized a second time, and an
  addon Aura itself removed in the last 60 s (`RECENT_REMOVALS`) is excused, so a write queued
  behind Aura's own remove is not refused. Remove and reorder likewise match a url EXACTLY before
  normalizing it (an entry at `.../manifest.json/manifest.json` reaches the frontend as
  `.../manifest.json`, its sibling's address), and so does the frontend's reorder, so neither
  entry of such a pair is removed, merged or dropped in the other's place; remove never tries the
  normalized form for an entry Aura itself just removed (a second remove of that row writes
  nothing, where the fallback would have reached the sibling). The partial-read guard
  is only as good as the list the frontend sends, so THAT LIST IS NEVER SHRUNK BY AN UNCONFIRMED
  READ: no signed-in collection write is issued until a `get_synced_addons` has answered this
  session and left a non-empty list shown (`App.isAddonListSynced`; before that add, remove and
  reorder say so and do nothing, a refresh writes no account, and the check itself starts a
  re-sync so a later press goes through), and both paths that replace the list from a read, the
  sign-in / restore sync (`App.syncAddonList`) and the reload that answers a refusal
  (`App.handleAccountChanged`), follow one rule: never adopt an empty read over a shown list,
  adopt a read holding every shown url at once, adopt one lacking any only when a second read
  1.5 s later is non-empty and identical, and adopt nothing if the list changed locally meanwhile
  (`addonsGenRef`, which sign-in and sign-out also move) or a drag's write has not settled
  (`reorderInFlightRef`); otherwise the shown list stays, which only makes the guard stricter. The
  reload exists because nothing else re-reads the account mid-session. Add also runs the parse guard and refuses
  `configurationRequired`, remove refuses a `protected` entry, and reorder is a pure permutation
  that refuses a url matching nothing.
  `account_api_error` reads the API's object-shaped `{ error: { message, code } }` as well as a bare
  string, so "Session does not exist" signs out instead of reading as a failed write.
  One cap differs between the builders: the live one keeps the first 16 manifest-level
  `id_prefixes` (`GUEST_ID_PREFIXES_CAP`), the cloud ones keep all of them. The entry a refresh
  hands back keeps all of them, so a refresh never SHORTENS a signed-in user's list (the prefix gates
  treat a non-empty list as complete, so a cut list rejects real ids); only what it saves for a guest
  keeps the cap. `has_search` follows ONE rule on every path (`manifest_declares_search` in `stremio.rs`:
  a catalog `search` extra OR a `search` resource); the cloud paths used to check the extra only.
  `fetch_streams` and `src/addonElection.ts` read these fields directly and never re-fetch
  manifests per request (a transient failure during that re-probe used to kill all stream lookups).
