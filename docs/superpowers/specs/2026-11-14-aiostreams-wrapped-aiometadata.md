# AIOStreams fork: serve a wrapped AIOMetadata to Aura

Implementation brief for the `rm-sage/AIOStreams` fork. Written 2026-11-14 for the agent making the change.
The Aura half is already built (uncommitted in the Aura repo); this document is the contract both sides
share. Line numbers were read at fork HEAD `9fd63768` and may have drifted; search by the names given.

## Background

The maintainer runs AIOMetadata (their fork, `rm-sage/AIOMetadata`) as a **custom addon inside AIOStreams**
instead of installing it on its own, so AIOStreams-only clients get its catalogs and metadata. AIOStreams
re-serves AIOMetadata's catalogs and metas unchanged (`MetaSchema` / `MetaVideoSchema` are passthrough), so
nearly everything works in Aura. One thing cannot: the Continue Watching cards in Aura use AIOMetadata's
**landscape art route**, which is not a Stremio resource:

```
GET {aiometadata base}/api/art/landscape/{type}/{id}.json      (base = the manifest URL minus /manifest.json)
-> 200 {id, type, landscape, source, hasBakedTitle, logo, poster, dominantColor, ids}
```

It exists only in the AIOMetadata fork (`addon/index.ts` ~6733, resolver `addon/utils/landscapeArt.js`), is
mounted per user at `/stremio/:userUUID/api/art/landscape/:type/:id.json`, and needs that user UUID.
AIOStreams does not forward it, and the AIOMetadata URL (with its UUID) is in AIOStreams' encrypted config,
not anywhere a client can see. Only AIOStreams can bridge it.

## Goal

1. AIOStreams forwards that one art route to the AIOMetadata it wraps, at the same relative path under its
   own manifest base, so Aura calls `{aiostreams base}/api/art/landscape/{type}/{id}.json` exactly as it
   calls AIOMetadata today.
2. AIOStreams' manifest tells clients it does this, and which addons it wraps (ids and names only).
3. Optional: wrapped catalogs keep `showInHome`.

Keep the patches small and mostly in new files: `scripts/update-aiostreams.sh` rebases the fork's commits onto
upstream on every update.

## The contract (Aura already implements this side)

### Manifest hints

In the manifest AIOStreams serves (`routes/stremio/manifest.ts`), inside `behaviorHints`:

```jsonc
"behaviorHints": {
  "configurable": true,
  "configurationRequired": false,
  // NEW. One entry per wrapped addon whose manifest LOADED, in preset order. Manifest id and name only:
  // never a URL, UUID, token or preset option.
  "wrappedAddons": [
    { "id": "aio-metadata", "name": "AIOMetadata (Sage's Fork)" },
    { "id": "com.watchly", "name": "Watchly" }
  ],
  // NEW. true exactly when the art route below has a wrapped AIOMetadata to forward to.
  "landscapeArt": true
}
```

How Aura reads them (`src-tauri/src/addons.rs::wrapped_from_hints`): `wrappedAddons` must be an array of
objects with string `id` / `name` (other entries are skipped, at most 32 kept, each string cut to 128 chars).
`landscapeArt` counts only when it is the boolean `true`. Both are read from the LIVE manifest, so nothing
needs to reach the Stremio account. Stremio's own apps ignore both keys.

### Art route

```
GET /stremio/:uuid/:encryptedPassword/api/art/landscape/:type/:id.json
GET /stremio/:uuid/:encryptedPassword/v/:variantSelector/api/art/landscape/:type/:id.json   (same router)
```

What Aura sends (`src-tauri/src/stremio.rs::fetch_landscape_art`): no body, no special headers, a 10 s
client timeout, `?w=640` appended (AIOMetadata ignores it; forwarding it is harmless). `type` is the library
item's media type (`movie`, `series`, sometimes `anime`); `id` is NOT percent-encoded by Aura (`tt0434665`,
`kitsu:12`, `mal:5114`).

What Aura accepts: any 2xx with a JSON object of the shape above (camelCase). Every non-2xx, timeout or
non-JSON body is "no art" (the card falls back to the item's own background), so error bodies are free-form
JSON. Aura caches the result in memory for 24 h.

Required behaviour:

| Case | Answer |
| --- | --- |
| A wrapped AIOMetadata answered 2xx with a JSON object | 200, that body verbatim (`Content-Type: application/json`; copy `Cache-Control` if present) |
| Wrapped AIOMetadata answered non-2xx | the same status, JSON `{ "error": "..." }` |
| No wrapped AIOMetadata in the config (or its manifest failed to load) | 404 `{ "error": "no AIOMetadata addon" }` |
| Upstream timeout | 504 `{ "error": "..." }` |
| Bad `type` / `id` | 400 `{ "error": "..." }` |
| User / password / config failures | whatever `userDataMiddleware` already does for non-resource paths (JSON `APIError`) |

Never answer this route with a 200 pseudo-item (no `createErrorMeta`, no `aiostreamserror.` objects).

## Changes

### 1. Find the wrapped AIOMetadata (core)

`ctx` is private on the `AIOStreams` class (`packages/core/src/main/index.ts` ~42-84; type in
`main/types.ts` ~79-85: `manifests: Record<string, Manifest | null>`, `addons: Addon[]`). Add one public
accessor next to `getAddon` / `getFailedAddons` (~179-193), for example:

```ts
/** Wrapped addons whose manifest loaded, in preset order. */
public getLoadedAddons(): { addon: Addon; manifest: Manifest }[] {
  return this.ctx.addons.flatMap((addon) => {
    const manifest = this.ctx.manifests[addon.instanceId!];
    return manifest ? [{ addon, manifest }] : [];
  });
}
```

Identify AIOMetadata by its manifest, not by preset: there is no AIOMetadata preset, it is added through the
generic `custom` preset (`packages/core/src/presets/custom.ts`). Current AIOMetadata builds serve manifest id
`aio-metadata` (configured) or `com.aio.metadata` (unconfigured); older ones `com.aiometadata`. Match any of
the three, or the name against `/aio[\s-]?metadata/i`. The first match in preset order is the one used.
Put this predicate in one small helper (e.g. `packages/core/src/main/aiometadata.ts`) used by both changes
below.

### 2. Manifest hints (server + schema)

- `packages/core/src/db/schemas.ts` ~1295-1304: `ManifestSchema.behaviorHints` is a plain (stripping)
  `z.object`. Add
  `wrappedAddons: z.array(z.object({ id: z.string(), name: z.string() })).optional()` and
  `landscapeArt: z.boolean().optional()`, or the server literal will not type-check.
  Adding them to the shared schema also stops them being stripped from a WRAPPED addon's manifest by
  `Wrapper.getManifest` (`wrapper.ts` ~226). That is harmless: AIOStreams builds its own hints and never copies
  a wrapped addon's.
- `packages/server/src/routes/stremio/manifest.ts` ~59-64: after `initialise()` (the route already
  constructs `new AIOStreams(config, { skipFailedAddons: true })`), add
  `wrappedAddons: aio.getLoadedAddons().map(({ manifest }) => ({ id: manifest.id, name: manifest.name }))`
  and `landscapeArt: aio.getLoadedAddons().some(isAIOMetadata)`. When there is no config
  (`configurationRequired`), emit neither.

### 3. Art forwarding route (server)

- `packages/server/src/middlewares/userData.ts` ~27-35: the middleware only decrypts the config when
  `req.path` matches `RESOURCE_REGEX` (built from `VALID_RESOURCES`); any other path reaches the router with
  NO `req.userData`. Add a token for this route (e.g. `'api'`) to `VALID_RESOURCES`. Check what the
  middleware then does for a non-`constants.RESOURCES` token: it should run the same decrypt / variant /
  `validateConfig` steps it runs for `meta` (lines ~129-214) and report failures through `next(APIError)`
  (JSON), never `createDynamicError`. Adjust the resource-specific branches if `'api'` would hit one.
- New file `packages/server/src/routes/stremio/art.ts` exporting an Express router with
  `router.get('/landscape/:type/:id.json', ...)` (the Express 5 pattern `routes/stremio/meta.ts` uses):
  1. Validate: `type` matches `^[a-z][a-z0-9.]{0,31}$`; `id` is 1-256 chars with no `/`, `\`, `?`, `#`.
  2. `const aio = new AIOStreams(req.userData!); await aio.initialise();` then pick the first loaded
     AIOMetadata (change 1). None: 404.
  3. Build the upstream URL the way `Wrapper.buildResourceUrl` builds resource URLs (`wrapper.ts` ~864-873):
     the wrapped addon's manifest URL with `stremio://` replaced by `https://` and `/manifest.json` removed,
     plus `/api/art/landscape/${type}/${encodeURIComponent(id)}.json`, carrying the manifest URL's own query
     string, plus `w` when the client sent it.
  4. Fetch with the existing helper so the addon's User-Agent, forwarded IP, proxy rules and recursion guard
     apply: `new Wrapper(addon).makeRequest(url, { timeout: 8000 })` (`wrapper.ts` ~580-586; options in
     `utils/http.ts` ~99-112). 8 s keeps the answer inside Aura's 10 s client timeout.
  5. Map the result per the table above. Parse the body as JSON and require a plain object before
     answering 200; do not forward upstream headers other than `Cache-Control`.
  Do not add an AIOStreams-side cache: AIOMetadata already caches every result (7 d hit, 1 h miss) and
  sets `Cache-Control`.
- `packages/server/src/app.ts` ~191-213: on `stremioAuthRouter`, add
  `stremioAuthRouter.use('/api', artLimiter)` BEFORE `stremioAuthRouter.use(userDataMiddleware)` (~198), so
  a request that fails to decrypt is still charged, and `stremioAuthRouter.use('/api/art', artRouter)` after
  it. Both mounts of `stremioAuthRouter` (with and without `/v/:variantSelector`) then serve the route.
- Rate limit: a new limiter rather than the meta one (15 per 5 s per IP), because a Continue Watching row
  fires art and meta requests together. Follow `lazyLimiter(() => appConfig.rateLimits.<new>, 'stremio-art')`
  in `packages/server/src/middlewares/ratelimit.ts` (~209-232) with a config entry beside the others in
  `packages/core/src/config/schema/rate-limits.ts` (~139-144); about 60 per 10 s per IP is ample (Aura
  requests one per Continue Watching card, cached 24 h).

Only this one path is forwarded. Do not add a generic `/api/*` pass-through to wrapped addons.

### 4. Optional: keep `showInHome` on wrapped catalogs

`ManifestCatalogSchema` (`schemas.ts` ~1231-1239) is a stripping `z.object`, so AIOMetadata's `showInHome`
is lost. Adding `showInHome: z.boolean().optional()` keeps it through `buildResources`' catalog copy
(`setup.ts` ~506-512). Where the user's "only on Discover" modification is applied (`setup.ts` ~639-657,
which adds or prepends a required `genre` extra with option `"None"`), also set `showInHome: false`.
Aura already treats a lone `"None"` option as hidden, so this only makes the signal explicit for clients that
honour `showInHome`. Skip it if it complicates the rebase.

### 5. Unrelated one-liner: round sub-day ages

`formatHours` (`packages/core/src/formatters/utils.ts` ~322) returns `${hours}h` for `hours < 24` without
rounding, so a formatter template using the age prints e.g. `16.89044138888889h`. Make it
`${Math.floor(hours)}h` (and `<1h` below one hour if you like), matching the `Math.floor` the day branch
already uses. Aura now rounds such text itself, but every other client shows the raw float.

### Not wanted

- Do not change how meta failures become `aiostreamserror.` pseudo-metas. Aura now rejects them itself, and
  upstream deliberately shows them in Stremio.
- No URL, UUID, encrypted password, API key or preset option may appear in the manifest hints or in any
  art-route error body.

## Verification

Type gate: `pnpm -F core run build` and `pnpm -F server run build` (`tsc`; core and server have no lint).
Tests: core runs `tsx --test` (node:test) for some files and vitest for others (27 of 41 import vitest; run
those with `pnpm -F core exec vitest run <file>`). Add unit tests for the AIOMetadata predicate (the three
ids, the name regex, a non-match) and the type / id validation.

Against a deployed instance, where `BASE` is the user's AIOStreams manifest URL minus `/manifest.json` (it
contains credentials: do not paste it into logs, commits or issue text):

```bash
curl -s "$BASE/manifest.json" | jq '.behaviorHints'
#   wrappedAddons lists AIOMetadata by id and name, no URLs; landscapeArt is true
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/art/landscape/series/tt0434665.json?w=640"   # 200
curl -s "$BASE/api/art/landscape/series/tt0434665.json" | jq '{source, hasBakedTitle, landscape}'
#   the same answer as the direct AIOMetadata route (Bleach: source "fanart-thumb", hasBakedTitle true)
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/art/landscape/series/..%2Fx.json"            # 400
```

With AIOMetadata removed from the config: the manifest has no `landscapeArt`, and the art route answers
404.

## After deploying

Aura reads the hints from its manifest cache (24 h). Use Addons > Refresh on the AIOStreams entry, or wait
a day, and the Continue Watching cards switch back to AIOMetadata's art.
