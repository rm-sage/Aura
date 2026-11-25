# AIOStreams fork: report the health of wrapped addons to Aura

Implementation brief for the `rm-sage/AIOStreams` fork. Written 2026-11-15 for the agent making the change.
The Aura half is already built (uncommitted in the Aura repo) and stays inert until the manifest hint below
appears; this document is the contract both sides share. Names were read at fork HEAD `dcd8deb`; search by
name if lines have drifted. Same ground rules as `2026-11-14-aiostreams-wrapped-aiometadata.md`: small
patches, mostly in new files, because `scripts/update-aiostreams.sh` rebases the fork onto upstream.

## Background

Aura's title-bar status panel probes every installed addon's `/manifest.json` and shows a row per addon. The
maintainer now installs most addons INSIDE AIOStreams (Torrentio, Comet, MediaFusion, AIOMetadata, ...), so
Aura sees one addon, AIOStreams, and its row stays green while a wrapped addon is down: AIOStreams skips a
failed addon and serves the rest. Aura cannot probe the wrapped addons itself. Their URLs (with config tokens,
UUIDs and debrid keys) live in AIOStreams' encrypted config and must never reach a client. Only AIOStreams can
check them.

AIOStreams cannot answer this from what it already has:
- `AIOStreams.initialise()` fetches every wrapped manifest, but through `manifestCache` (and
  `manifestFailureCache`), so a manifest that loaded hours ago still reads as loaded.
- `ctx.addonInitialisationErrors` records failures only for the request being served.
- `statistics.ts` builds per-request stream statistics and keeps nothing.

So the route below makes its own fresh, timed request per addon, caches the answer briefly, and returns names
and verdicts only.

## The contract (Aura already implements this side)

### Manifest hint

In `routes/stremio/manifest.ts`, inside `behaviorHints`, beside `wrappedAddons` / `landscapeArt`:

```jsonc
"addonStatus": true     // only when `config` is present (a configured user manifest)
```

Aura reads it from the LIVE manifest (as it does `wrappedAddons`), and only an addon declaring it gets the
status request. Upstream AIOStreams never declares it, so Aura never sends the request there.

### Status route

```
GET {aiostreams base}/api/status/addons.json
    (base = the manifest URL minus /manifest.json; also reached through the /stremio/u/<alias>/ path,
     Aura follows the alias redirect as it does for the art route)

200 application/json
{
  "checkedAt": 1763222400000,            // unix ms the probes ran (older than now when served from cache)
  "addons": [
    { "name": "Torrentio",   "id": "com.stremio.torrentio.addon", "state": "ok",
      "httpStatus": 200, "latencyMs": 412, "error": null },
    { "name": "Comet",       "id": null, "state": "down",
      "httpStatus": 503, "latencyMs": 92,  "error": "HTTP 503" },
    { "name": "MediaFusion", "id": null, "state": "down",
      "httpStatus": null, "latencyMs": null, "error": "timeout" },
    { "name": "StremThru Store", "id": null, "state": "skipped",
      "httpStatus": null, "latencyMs": null, "error": "disabled on this instance" },
    { "name": "Knaben",      "id": "...", "state": "ok", "httpStatus": 200, "latencyMs": 35, "error": null,
      "lastRequest": { "ok": false, "at": 1763222100000, "resource": "stream", "error": "timeout" } }
  ]
}

404 {"error":"no configuration"}      when there is no userData
429                                     over the rate limit (express-rate-limit's normal answer)
```

Field rules (Aura validates all of them and drops what does not fit):

| Field | Rule |
|---|---|
| `name` | `getAddonName(addon)` (or the preset name for a preset that produced no addon). At most 100 chars. |
| `id` | The manifest `id` when this probe parsed one, else `null`. |
| `state` | `ok`: 2xx and the body parsed as a manifest. `down`: no answer, a non-2xx, or a body that is not a manifest. `skipped`: never requested because AIOStreams would not use it anyway (removed / disabled addon or host per `FeatureControl`, the self-scraping guard, a preset that failed to apply). |
| `httpStatus` | The upstream status when one arrived, else `null`. |
| `latencyMs` | Time to the response HEADERS of this probe, else `null`. |
| `error` | `null` when ok, else ONE of these short categories, never upstream text (an upstream message can echo a URL with tokens in it): `timeout`, `unreachable`, `HTTP <code>`, `invalid manifest`, `invalid response` (added 2026-11-16, `lastRequest` only: an HTTP 2xx whose body is not a Stremio answer for that resource), `disabled on this instance`, `configuration error`, `request loop`. Aura shows a category it does not know as it came, clamped to 40 characters, so a new one needs no Aura change. |
| `lastRequest` | OPTIONAL, see "Optional: last real request" below. Omit the key when unknown. |

Never in the answer: a URL or host, a uuid, an `instanceId`, options, headers, or the request IP.

Order: config order (`ctx.addons` after preset expansion), with presets that failed to apply in their place.
Entries whose `manifestUrl` is identical are ONE entry (service wrapping can expand a preset into several
addons sharing a manifest URL). At most 40 entries.

### How to probe

1. Build the user's addon list without fetching manifests: the preset expansion half of `initialise()`
   (`setup.ts`, the loop before `fetchManifests`). Do NOT call `fetchManifests` or `Wrapper.getManifest`:
   they read and write `manifestCache` / `manifestFailureCache`, and a status check must neither be answered
   from those caches nor change how streams behave afterwards.
2. For each addon, run `validateAddon(ctx, addon)` first. If it throws, the entry is `skipped` with the
   matching category (`disabled on this instance` for FeatureControl, `request loop` for self-scraping) and no
   request is made.
3. Otherwise `new Wrapper(addon).makeRequest(addon.manifestUrl, { timeout: 5000 })` (the art route's pattern;
   it applies the addon's headers, forwarded IP and builtin routing). Time to headers. Read the body capped at
   1 MiB and check it parses as JSON with a string `id`; that is the manifest test, not the full
   `ManifestSchema`.
4. At most 6 probes at once. The whole route answers within 9 s: anything unfinished then is `down` /
   `timeout`, so Aura (which waits 12 s) always gets an answer.
5. Map errors to the categories above: `isTimeout(err)` (art.ts) to `timeout`,
   `PossibleRecursiveRequestError` to `request loop`, a fetch/connect error to `unreachable`.

### Caching and limits

- Cache the full answer per user (key on `userData.uuid`, or on a hash of the config for an anonymous one)
  for 60 s, bounded (e.g. 500 users, oldest out). A request inside the window gets the cached answer with its
  original `checkedAt`. Send `Cache-Control: private, max-age=60`.
- Rate limit: add `stremioStatus` to `config/schema/rate-limits.ts` (`envPrefix: 'STREMIO_STATUS'`,
  window 60 s, max 10) and mount it on `/api/status` BEFORE `userDataMiddleware`, the way `stremioArt` is
  mounted on `/api` (the `/api` art limiter applies too; that is fine). Aura asks once per 5 min plus when
  the user opens the panel and the last check is over 20 s old.
- Log at debug level with addon names and categories only (`makeUrlLogSafe` if a URL must appear at all).

### Optional: last real request

A manifest that answers does not prove the addon serves streams (a scraper can be rate limited, a debrid
lookup can fail). If it is cheap to add, keep a small in-memory record of the most recent REAL request per
(user, addon instance), set where `Wrapper` already logs a request outcome for stream / meta / catalog /
subtitles:

```jsonc
"lastRequest": { "ok": false, "at": 1763222100000, "resource": "stream", "error": "timeout" }
```

`error` uses the same categories (plus `no results` is NOT an error: an empty answer is `ok: true`, and so is
a meta addon's `{ "meta": null }`, `{ "meta": {} }` or `{}` for an id it does not have). A body that is not a
Stremio answer is `invalid response`; a connection dropped part-way through the answer is `unreachable`.
Bound it (e.g. 500 users x 40 addons, oldest out, entries older than 6 h dropped). Aura shows a failed
`lastRequest` from the last 30 minutes as a warning on that addon's row even when the probe is ok. Skip this
section entirely if it means touching hot paths in more than one place; the probe alone is useful.

## Changes

1. `packages/server/src/routes/stremio/status.ts` (new): the route above. Export it from
   `routes/stremio/index.ts`, mount it in `app.ts` as `stremioAuthRouter.use('/api/status', status)` beside
   `/api/art`.
2. `packages/core`: if the addon-list-without-manifests step needs a public entry point on `AIOStreams`
   (e.g. `listConfiguredAddons(): { addon, presetError? }[]`), add it next to `getLoadedAddons` /
   `getFailedAddons` in `main/index.ts`.
3. `routes/stremio/manifest.ts`: `addonStatus: true` in `behaviorHints` when `config` is present.
4. `db/schemas.ts`: allow `addonStatus` in the manifest `behaviorHints` schema the way `landscapeArt` is
   (`z.boolean().optional().catch(undefined)`).
5. `config/schema/rate-limits.ts` + `middlewares/ratelimit.ts`: the `stremioStatus` limiter.
6. Tests beside `aiometadata.test.ts`: the error-category mapping, the dedupe by manifest URL, and that no
   URL / uuid / instanceId appears in a serialized answer (feed it addons whose URLs contain a marker string
   and assert the marker is absent from the JSON).

### Not wanted

- No new UI in AIOStreams' own frontend.
- No status for addons the user has disabled in their config (they are not in `ctx.addons`).
- No probing of debrid services: Aura already watches those through their public status pages.

## Verification

```bash
# the hint
curl -sL "$BASE/manifest.json" | jq '.behaviorHints.addonStatus'                 # true
# the report (names and categories only)
curl -sL "$BASE/api/status/addons.json" | jq '.addons[] | {name, state, latencyMs, error}'
# no secrets: none of these may match
curl -sL "$BASE/api/status/addons.json" | grep -Ei 'https?://|[0-9a-f]{8}-[0-9a-f]{4}-|instanceId'
# cached: two calls inside 60 s carry the same checkedAt
```

`$BASE` is the user's manifest URL minus `/manifest.json`. Do not paste a real one into logs or commits.

## After deploying

Tell the maintainer. In Aura, Addons > Refresh on AIOStreams (or waiting out the 24 h manifest cache) picks up
the hint, and the status panel then lists the wrapped addons under the AIOStreams row.
