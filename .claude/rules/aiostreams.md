---
paths:
  - "src-tauri/src/stremio.rs"
  - "src-tauri/src/addon_rate.rs"
  - "src-tauri/src/service_status.rs"
  - "src/addonHints.ts"
  - "src/aiometadata.ts"
  - "src/nestedAddonStatus.ts"
  - "src/ServiceStatusChip.tsx"
  - "src/views/HomeView.tsx"
  - "src/views/SearchView.tsx"
---

# AIOMetadata wrapped inside AIOStreams

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: src-tauri/src/stremio.rs (is_addon_error_item, catalog_is_hidden_from_home, search), src-tauri/src/addon_rate.rs, src/addonHints.ts, src/aiometadata.ts, src/views/HomeView.tsx catalog filters, src-tauri/src/service_status.rs nested status.

### AIOMetadata wrapped inside AIOStreams

A supported setup (the AIOStreams Android/TV clients want one addon): AIOMetadata added to AIOStreams as a
custom addon instead of installed on its own. AIOStreams' meta and video schemas are passthrough, so every
field Aura reads (per-video `_malId` / `_malEpisode`, AniList pairs, filler / recap, logo, app_extras, ...)
arrives unchanged (measured on 7 metas, 2026-11-14); only `poster` (its RPDB redirect, the original in the
`fallback` query) and `stremio:///discover` links change. That holds while AIOStreams is the ELECTED meta
provider: it declares meta with no idPrefixes (a tier-3 catch-all), so an addon declaring `tt` outranks it
unless it is the pinned Default Metadata Provider. Five rules:

- **Error pseudo-metas are not titles.** AIOStreams answers ANY wrapped-addon failure, a plain not-found
  (`{meta:null}`) included, with HTTP 200 and `{id: "aiostreamserror.<json>", name: "[❌] <addon>"}`;
  `hideErrors` does not suppress it for meta. It has a name, so metaCache would store it as the title (7 d
  for a movie) over a good copy. `is_addon_error_item` (stremio.rs) turns it into an error in
  `fetch_meta_detail` and drops it from catalog arrays (`parse_meta_array`).
- **Hidden from Home has a sentinel.** Upstream AIOStreams strips `showInHome` from wrapped catalogs (the
  rm-sage fork passes it through, and Rust reads it as authoritative when present); what survives upstream
  is the required extra whose ONLY option is `"None"` (AIOMetadata's own hide encoding, and AIOStreams'
  "only on Discover"). `catalog_is_hidden_from_home` treats that as hidden. Wrapped catalog ids carry a
  7-hex instance prefix (`2fce3b0.calendar-videos`); `isDenylistedCatalog` (HomeView) strips it.
- **Capability hints come from the LIVE manifest.** A wrapper declares `behaviorHints.wrappedAddons`
  (`[{id, name}]`, never a URL) and `behaviorHints.landscapeArt` (it forwards AIOMetadata's
  `/api/art/landscape` route, the CW card art). `src/addonHints.ts` reads them through
  `get_addon_manifest` (the Rust manifest cache), NOT from `AddonEntry.wrapped` / `landscape_art`: a
  signed-in entry is built from the manifest stored in the Stremio collection, and stremio-core's
  `ManifestBehaviorHints` has no catch-all, so an official app re-saving the collection drops both keys.
  Aura's refresh writes a manifest verbatim, but only when it differs in stremio-core terms, so a change to
  these hints alone writes nothing. Rust's on-disk manifest cache is versioned for the same reason (v2
  keeps both keys, v3 adds `addonStatus`): an older entry was written with them thrown away. `findLandscapeArtAddon`
  prefers an AIOMetadata installed on its own. Without the hints (upstream AIOStreams) AIOMetadata's
  Stremio data still works; only the CW art falls back to the item's background.
- **Meta requests are paced to the host's published budget.** AIOStreams limits each route per IP (meta:
  15 per 5 s by upstream's default; the rm-sage fork raised its Stremio limits on 2026-11-16 to meta 400 per 10 s,
  catalog 200 per 10 s, stream 30 per 15 s, landscape art 400 per 10 s) and over it answers HTTP 200 with an error item whose description is "Rate Limit
  Exceeded", not a 429; every answer carries `RateLimit-Limit` / `-Remaining` / `-Reset` / `-Policy`. The
  Calendar's fan-out over the library had 269 of 316 metas refused in one visit (2026-11-15).
  `addon_rate.rs` keeps a bucket per (route kind, host) from those headers; `fetch_meta_detail` waits for a
  slot and retries a refusal after the reset (3 attempts, 30 s in all), then fails with "Meta rate
  limited". An error item that reads as a rate limit counts as the HOST's refusal only when that answer's own
  `RateLimit-Remaining` is 0 or absent (`addon_rate::published_remaining`): AIOStreams relays a wrapped
  addon's own 429 with the same item while its budget is still open, and that is treated as a plain addon
  error (not retried, bucket untouched). A host that publishes no budget gets no bucket. Live-checked: 40 metas, 8 at a time, all
  answered in 15.5 s. Board catalogs are not gated (upstream 30 per 5 s, no refusals seen). Search catalogs are: a
  search asks at most 12 of one addon's catalogs at once (`SEARCH_CATALOG_CONCURRENCY`, requests in
  flight), each one waits for a slot in the host's "catalog" bucket, and a refusal is retried once after
  the reset and logged (a few quick searches against upstream's budget would otherwise read as empty
  catalogs; the same `published_remaining` rule decides whether a refusal is the host's). A catalog
  still refused after that retry, or one that did not answer (send error, non-2xx, bad JSON, no slot
  within 12 s), is FAILED, not empty: `search_one_catalog` returns `Err` and the progress message
  carries `failed: true` (an addon whose manifest cannot be read fails the whole call, "Addon did not
  answer"). The Search view (`src/views/SearchView.tsx`) shows a failed catalog as a one-line
  "<catalog> did not answer" row with a Retry that calls `search_addon_grouped` with `only: {
  media_type, catalog_id }`: that ONE catalog, through the same `addon_rate` bucket and the same
  one-retry refusal rule, and the call itself fails when the catalog fails. An answer with zero items
  (or only non-rate-limit error items) still reads as empty and collapses. A Retry's answer is dropped
  once a newer search started (`genRef`). Catalogs still searching hold their place with a one-line
  placeholder (not a poster row), so one that comes back empty moves the rows below by about a line. Nothing in Aura hard-codes a budget: the
  pacing reads the live `RateLimit-*` headers, so a host's new limits apply on its next answer.
- **AIOMetadata's manifest id is `aio-metadata`** (`com.aio.metadata` unconfigured), not
  `com.aiometadata`; `isAIOMetadataAddon` accepts all three plus the name / url regex. `wrapsAIOMetadata`
  (labels only) also infers a wrapper from the `anime.series` / `anime.movie` types only AIOMetadata serves.

The AIOStreams-fork half (art forwarding route, the two hints, `showInHome` passthrough) is specified in
`docs/superpowers/specs/2026-11-14-aiostreams-wrapped-aiometadata.md`. The status panel's view INTO a
wrapper (the addons inside AIOStreams, each checked by AIOStreams from its server) is a third hint,
`behaviorHints.addonStatus`, plus a per-user `api/status/addons.json` route:
`docs/superpowers/specs/2026-11-15-aiostreams-nested-addon-status.md`. Aura's side is built and stays
inert until a manifest declares the hint (written 2026-11-15; the fork side was not built yet then).
