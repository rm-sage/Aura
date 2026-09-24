# Addon election by order, and Advanced settings

Date: 2026-09-11
Status: approved, ready for an implementation plan

## Problem

Setting Aura up for the first time is harder than it should be, and the worst part
is the manual per-function provider selection: the user must decide which addons
answer meta, which answer search, and which answer streams, in three separate
Settings pickers, before the app behaves well.

That system is also quietly broken in ways the user cannot see:

1. **Addon order is already the only honest priority signal, and nothing says so.**
   `streamQueryAddons` (`src/auraSettings.ts:614`) returns the addon array verbatim
   when `streamAddonUrls` is `null`, and `fetch_streams` re-sorts its `JoinSet`
   results back to the caller's index (`src-tauri/src/stremio.rs:3634`). So for a
   user who has never touched Settings, position 0 already decides. The Addons page
   has drag-to-reorder (`src/views/AddonsView.tsx:791`) that persists through
   `reorder_addons` / `cloud_reorder_addons`, and not one word of UI copy explains
   what reordering does. The drag handle's `aria-label` ("Drag {name} to reorder")
   is the only order-related string on the page.

2. **Editing any picker freezes an allowlist.** `effectiveStreamUrls` /
   `effectiveSearchUrls` (`src/views/SettingsView.tsx:4643`, `:4648`) project `null`
   as "everything currently eligible is selected", so the first drag commits a
   concrete snapshot. Every addon installed afterwards is silently never queried
   again, and every addon uninstalled leaves a dead URL that `streamQueryAddons`
   drops without comment. Nothing prunes these lists: `AddonsView` calls
   `remove_addon` and never touches `auraSettings`.

3. **Meta election is open-coded five times and the copies disagree.** DetailView
   (`src/views/DetailView.tsx:1036`) and CatalogHoverCard (`src/CatalogHoverCard.tsx:244`)
   put AIOMetadata above the user's pinned metadata provider; CalendarView
   (`src/views/CalendarView.tsx:165`) and AiringView (`src/views/AiringView.tsx:81`)
   put the pin first, query exactly one addon and have no fallback or capability
   filter at all; `getMetaDetailFallback` (`src/metaCache.ts:233`) never reads
   `defaultMetadataAddonUrl`. The "Default Metadata Provider" dropdown therefore
   only decides anything when AIOMetadata is not installed.

4. **Home discards the user's order outright.** `resolveHomeAddons`
   (`src/views/HomeView.tsx:103`) and `resolveSearchAddons` (`:154`) substitute a
   hardcoded manifest-id table (`DEFAULT_HOME_ORDER`, `DEFAULT_SEARCH_ORDER`)
   whenever the user has set nothing.

## What upstream actually does

Verified against `stremio-core` and `stremio-web` rather than assumed.

`Profile.addons` is a plain ordered `Vec<Descriptor>` and **that vector's index order
is the only priority signal in the entire system**. There is no priority field, no
score, no per-addon weight, and no per-resource preference anywhere: the complete
user `Settings` struct (`src/types/profile/settings.rs:8-53`, 38 fields) contains
nothing about addon selection.

One function does all capability matching,
`Manifest::is_resource_supported` (`src/types/addon/manifest.rs:108-148`), with
exactly two occurrences in the crate (the definition and one call at
`src/types/addon/request.rs:361`). For non-catalog resources it checks resource
name, then type, then id prefix, where a missing or empty `idPrefixes` means all
ids (`id_prefixes.map_or(true, |p| p.is_empty() || ...)`). Catalogs are exempt from
`resources` and `idPrefixes` entirely and match on exact `(type, id)` plus
`is_extra_supported`.

`AggrRequest::plan()` (`request.rs:168`) filters that vector preserving order. Meta,
streams and subtitles use `AllOfResource`; Home and Search use `AllCatalogs`, one row
per `(addon, catalog)` pair. Meta elects one winner at the display layer ("first
Ready, else first error, else loading", `serialize_meta_details.rs:101-118`) over a
completed concurrent fan-out. Streams and subtitles are kept as one bucket per addon
with no dedup anywhere.

**Official Stremio has no reorder UI.** Install appends
(`update_profile.rs:281`), uninstall removes by index (`:190`). Grep-negative for
`reorder|move_addon|addon_order|swap_addon` across `stremio-core/src/`, and for
`draggable|sortable|order` across `stremio-web`'s Addons route. The drag-to-reorder
people associate with Stremio is the third-party Stremio Addon Manager rewriting the
array through `addonCollectionSet`. Community v5 tracks it as "Planned"
(Discussion #123).

So Aura is already past upstream: it has the lever Stremio lacks. The lever is just
wired to nothing.

## Design

### 1. One election module

New file `src/addonElection.ts`. It is the single definition of "which addons can
answer this, and in what order".

```ts
export type ElectResource = "meta" | "stream" | "subtitles" | "catalog" | "addon_catalog";

export interface ElectQuery {
  resource: ElectResource;
  type?: string;   // "movie" | "series" | ...
  id?: string;     // "tt0903747", "kitsu:1234"
}

export interface Elected {
  addon: AddonEntry;
  rank: number;    // index in the addons array; the priority
  reason: "declared" | "open-resource" | "open-type" | "open-prefix" | "primary-exempt";
}

export function electAddons(addons: AddonEntry[], q: ElectQuery): Elected[];
export function electSearchAddons(addons: AddonEntry[]): Elected[];
export function applyOverride(elected: Elected[], urls: string[] | null): Elected[];
export function applyPrimary(elected: Elected[], url: string | null): Elected[];
// The one meta election every meta surface calls: the meta election with
// defaultMetadataAddonUrl holding the tier-2 exemption, then
// applyPrimary(..., defaultMetadataAddonUrl), as AddonEntry[].
export function electMetaAddons(addons: AddonEntry[], type: string, id: string): AddonEntry[];
```

Gates, in order, mirroring `is_resource_supported`:

1. **Resource.** `resources` must contain the resource, case-insensitively.
2. **Type.** Resource-specific first (`stream_types` for `stream`), else `types`.
3. **Id prefix.** Resource-specific first (`stream_id_prefixes`), else `id_prefixes`.

**Every gate fails open on an empty field.** This is required, not sloppy, and it is
the single most important difference from upstream. Stremio evaluates a live
manifest; Aura evaluates cached `AddonEntry` fields that are frequently empty and
can never heal:

- `stream_types` and `stream_id_prefixes` are structurally empty for the extremely
  common bare-string manifest form `"resources": ["stream"]`, because
  `extract_stream_resource_info` only matches `Value::Object`
  (`src-tauri/src/stremio.rs:4127-4147`).
- `types` is empty for a catalog-less stream-only addon that omits manifest-level
  `types`.
- Capability fields are written at exactly three construction sites
  (`stremio.rs:1506` add_addon, `stremio.rs:2185` cloud_add_addon, `auth.rs:918`
  get_synced_addons) and never afterwards. `refresh_addon_manifest`
  (`stremio.rs:1382`) evicts caches and refetches but never calls `addons::save`, so
  an addon that gains a resource after install reads stale-empty until it is removed
  and re-added.

Fail-open turns every one of those into "considered eligible", which is the safe
direction. Aura's existing consumers already do this (`metaCache.ts:274`,
`DetailView.tsx:1093`, `DiscoverView.tsx:115`, `libraryArtRetry.ts:57`), so this
formalises a convention rather than inventing one.

One more empty-equivalent case, found during implementation: `types` is truncated to
8 entries on the Rust side (`collect_wire_types` and `extract_manifest_types` both
`take(8)`), so a list at the cap cannot prove a type is absent. The type gate fails
open on a miss in a list at the cap, the same as on an empty one. AIOMetadata's
manifest alone declares 7 types plus catalog types, so this is not hypothetical.

4. **Order, for every resource except meta.** Output is in `addons` array order. No
   tiers, no sort, no exemption, no ranking table. The stream-list invariants in
   CLAUDE.md depend on this.

5. **Order for meta: tiers, with array order deciding within each tier.** Amended
   after reading a real user's addon list, which overrides the pure-order wording
   this section originally had for meta. That list, in order, is: AI Search
   (`catalog, meta, stream`, empty `idPrefixes`), AIOMetadata (`catalog, meta`,
   prefixes `tmdb: tt tvdb: mal: tvmaze: kitsu:`), three subtitle addons, Cinemeta
   (`catalog, addon_catalog` only), three AIOStreams instances. Pure order with
   fail-open prefixes elects AI Search, a prefix-less catch-all whose meta for a
   foreign id is an empty stub, as the meta provider for every title. A catch-all at
   the top would win in Stremio too; Aura deliberately ranks declared providers above
   catch-alls for meta instead:

   | Tier | Reason | Rule |
   |---|---|---|
   | 1 | `declared` | declares `meta`, has non-empty id prefixes, and one matches the id (`open-type` ranks here too) |
   | 2 | `primary-exempt` | the PRIMARY, when it failed ONLY the prefix gate and no addon declares a prefix matching the id. The primary is the user's `defaultMetadataAddonUrl` pin if it declares `meta` with non-empty prefixes and passes the resource and type gates, else the FIRST addon in array order that does |
   | 3 | `open-prefix` | declares `meta` with empty prefixes (a catch-all such as AI Search) |
   | 4 | `open-resource` | `resources` empty (a stale cached entry), fail-open |

   An addon that declares `meta` with non-empty prefixes that miss is rejected,
   and so is the primary once any addon claims the id (probing it then only adds a
   404 behind the real answer). The type gate applies to every tier. Tier 2 is the
   primary exemption: it generalises the AIOMetadata carve-out at
   `metaCache.ts:250-256` from "AIOMetadata always answers, even for ids it
   under-declares" to "the pinned, else the first declared, meta provider answers
   ids nobody declares", which keeps ids such as `anidb:` and `anilist:` resolving.
   It is meta-only; no other resource gets an exemption.

   The pin must be able to claim the exemption, not just lead. Found in review: in
   Stremio's default order (Cinemeta, `meta` with prefix `tt`, at index 0), a
   first-declared-only rule hands the exemption to Cinemeta, so a pinned AIOMetadata
   was rejected by prefix for an `anidb:` id and `applyPrimary`, which only hoists
   existing candidates, could not bring it back. Without a pin that order still
   elects Cinemeta alone for such an id; the pin is the fix.

   For the list above this reproduces the old behaviour exactly (AIOMetadata first,
   AI Search last) without naming any addon. The user's `defaultMetadataAddonUrl`
   pin holds the tier-2 exemption and is then hoisted to the front of the tiers by
   `applyPrimary`, so a pin still leads.

Search keeps its own entry point because `has_search` is fail-**closed** on the Rust
side (`search_addon_grouped` returns `Ok(vec![])` for `!addon.has_search`), so
fail-open logic would be wrong. `electSearchAddons` is `addons.filter(a => a.has_search)`
in array order.

### 2. Overrides

Overrides are the only thing that may disturb order, and they are now the exception
rather than the mechanism.

- `applyOverride(elected, urls)`: `null` passes through untouched; an array filters
  and reorders by that array, dropping uninstalled URLs. This is today's
  `streamQueryAddons` body, generalised.
- `applyPrimary(elected, url)`: hoists one URL to the front, keeping the rest as
  fallback. This is the right shape for `defaultMetadataAddonUrl`, which is a single
  "this one leads" pin rather than an allowlist.

`streamQueryAddons` stays as a thin wrapper so its five direct call sites
(`nextUp.ts:219`, `App.tsx:7244`, `App.tsx:8055`, `DetailView.tsx:1352`,
`DownloadsRelinkBridge.tsx:53`) need no edit.

### 3. Observability

Meta election happens entirely on the frontend and is currently invisible:
`src/metaCache.ts` has zero console calls, `src/views/HomeView.tsx` zero, and
`src/views/DetailView.tsx` two, neither of which names the elected addon. On the Rust
side `fetch_meta_detail` passes an empty name into `log_label` (`stremio.rs:2276`) so
the DevConsole prints a redacted raw URL instead of an addon name.

`electAddons` emits one line per decision naming the winner, its rank, its reason,
and each rejected candidate with the gate that rejected it. `fetch_meta_detail` gains
an optional `addon_name` parameter (the caller always holds the `AddonEntry`) so its
existing log line prints a name. Two related lies get fixed in the same pass: the
manifest gate's else branch at `stremio.rs:3495-3500` reports "has no stream resource"
for what is really a type or prefix mismatch whenever `stream_types` is empty, and the
subtitle fan-out's two silent exits at `:4201` and `:4203-4205` leave no trace at all.

### 4. What collapses into the module

| Site | Change |
|---|---|
| `metaCache.getMetaDetailFallback` (`:233`) | forcedUrl/rank block replaced by `applyPrimary(electAddons(meta), defaultMetadataAddonUrl)`; the sequential first-usable walk is unchanged |
| `metaCache.getRichestMetaDetail` (`:356`) | same candidate list; gains the id-prefix gate it lacks, which is the 404 probing its sibling's gate exists to stop |
| `DetailView` memo (`:1036-1058`) and inline chain (`:1077-1090`) | both replaced by the shared call |
| `CatalogHoverCard` (`:229-250`) | same call; the "must agree with DetailView" constraint at `:238` becomes structural instead of a copy-paste comment |
| `CalendarView` (`:165-170`), `AiringView` (`:81-85`) | same call; gain the meta-resource filter and the fallback they do not have |
| `libraryArtRetry` (`:56`, loop `:82-86`) | same call, routed through `metaCache` for the TTL cache and single-flight it currently bypasses |
| `HomeView.resolveHomeAddons` (`:103`) | deleted, replaced by catalog-level row building (section 5) |
| `HomeView.resolveSearchAddons` (`:154`) | moved into `addonElection.ts` as `electSearchAddons`, fixing its module-private problem |
| `SearchView` second `has_search` filter (`:81`) | deleted; redundant, and it silently ignores the override |
| `App.tsx:3950` subtitles | `electAddons(addons, { resource: "subtitles", type, id })` instead of the raw unfiltered array |
| `DiscoverView` (`:114`) | shared catalog predicate, fixing its case-sensitive `resources.includes("catalog")` |
| `SettingsView` predicates (`:640-663`) | imported from `addonElection.ts`; the fourth capability vocabulary dies |

`HOME_RELEVANT_SETTING_KEYS` (`src/auraSettings.ts:554-561`) gains `searchAddonUrls`.
Its omission means editing Search Providers does not take effect until an unrelated
home key changes or HomeView remounts.

### 5. Home becomes catalog-level

Rows are built from every installed addon in array order, then each addon's manifest
catalogs in manifest order, keeping the three existing programmatic filters
(`is_search_only`, `is_hidden_from_home`, `CATALOG_ID_DENYLIST`). The sources come
from `electHomeAddons` in `addonElection.ts`: every addon the fail-open catalog
resource gate (`mayServe(addon, "catalog")`) keeps, in array order, logged as one
`[election] home` line. `DEFAULT_HOME_ORDER` and `resolveDefaultUrls` are deleted.

**Superseded: `hiddenHomeCatalogs`.** An earlier draft of this section added a
`hiddenHomeCatalogs: string[]` setting (keyed `${addonUrl}|${type}|${id}`) with a
per-row hide control. At implementation time the maintainer chose "full parity plus
windowing" over the option with a hide control, so there is no such setting and no
hide-row UI. The default Home is exactly Stremio's board: every home-eligible catalog
of every catalog addon. Narrowing it is the job of the existing Home override below.

This takes Home from roughly 5 to 15 rows to roughly 30 to 80. Three things become
mandatory rather than optional:

**Windowing.** `useRowWindow` with `cols: 1`. The hook already accepts an external
`scrollRef` and Home already has a single scroll container at `HomeView.tsx:651`; rows
are uniform height. Today the hook is used in exactly one place, the View-all popup
(`CinemaRows.tsx:1598`), and never on the home grid. Without it, `ImageLoader` calls
`observer.disconnect()` on first intersect (`ImageLoader.tsx:175`) and never unmounts
the `<img>`, so scrolling once to the bottom of 40 rows permanently retains around 400
decoded posters at roughly 0.78 MB each. That is the same GPU and decode memory
failure already documented for Library.

**Throttled, windowed fetch.** The flat `await Promise.all(initial.map(...))` at
`HomeView.tsx:379-405` issues every catalog request simultaneously with no semaphore
and a 20 s per-request timeout each (`stremio.rs:1627`). At 40 rows that is 40
concurrent invokes, often 20 or more against a single self-hosted AIOMetadata
instance. Replace with in-order fetching driven by the row window, a small
concurrency limit (4 to 6), and results that persist so scrolling back does not
refetch.

**Per-row error state.** A failing catalog currently writes `items: []` and
`DiscoveryRow` returns `null` (`CinemaRows.tsx:1311`), so the row silently vanishes.
Tolerable at 5 rows, invisible data loss at 40. Add a per-row error state with a retry
affordance, and an `<ErrorBoundary scope="Home">`, which Home lacks entirely.

As built (Phase 2): rows are made exactly uniform rather than roughly so. DiscoveryRow's
`uniformHeight` gives every card the fixed title block the View-all popup already uses
and makes the skeleton and failed states reserve it, so the hook's one measured row is
the stride for all of them. That block is the tightest fit for its content, not a
round number: two 19 px `leading-tight` title lines (47.5 px), the year's 2 px margin
and one 15.5 px year line at the inherited 1.5 (23.25 px) make 72.75 px, reserved as
`h-[4.55rem]` (72.8 px; measured in Chromium at 100 to 200% scaling, nothing clips).
The popup shares the block, so it tightens by the same 11 px. The header is made uniform
the same way: every state lays out the loaded row's "View all" button, invisible and
inert where there is none, because its line box, baseline-aligned against the row
title's, reaches 0.5 px below it. Without that, a skeleton or failed row was 0.5 px
shorter than a loaded one (386.55 against 387.05 px in Edge 153, the WebView2 engine,
at 100 to 200% scaling); with it all three measure 387.05 px.

The queue keeps 4 requests in flight and walks the row window plus 2 rows past its
end in row order; a row that scrolls away keeps its items. It starts only rows of the
current build generation, stamped on each row, so a pass that runs between a rebuild
and the new list landing cannot mark the old list's keys as started. Past the window it
goes for one reason: with no hero catalog pinned, the hero is the first row with items,
and that must not depend on the window. While no row has items, a slot the rows near
the window do not need goes to the next pending row past it, in row order, at the same
concurrency, until one row has items or every row has been tried. So a first addon
whose catalogs all fail still gets a hero from the first healthy row further down, as
it did when every row was fetched at once. Otherwise a row the window has not reached
is not requested. A row this walk tried outside the window that fails is not marked
failed, since the user never asked for it and its addon may be back by the time they
scroll there: it goes back to pending, the walk passes over it from then on (so the walk
stays one pass over the list), and the window fetches it the ordinary way when it comes
near.

A failed request keeps its row, with a Retry pill that refetches that row alone. The
retry passes `fetch_catalog`'s optional `force`, which skips Rust's 30 s per-catalog
soft-fail cooldown for that one request (every other caller omits it and keeps the
cooldown): a timeout or connect failure arms that cooldown, and without `force` the
retry would be refused unsent until it drained. The outcome is still recorded, a
failure re-stamping the cooldown and a success lifting it. An empty catalog still
hides its row, and when that row sat above the viewport the scroll offset is
compensated so the page does not jump. A row whose View-all popup is open stays
mounted while the window moves (keyboard scrolling reaches Home underneath the popup).
Only that one row is added: it joins the window's rows in the same keyed list, so the
popup keeps its state, and one spacer of `k * stride - gap` stands in for the k rows
between it and the window, so it still sits at exactly `index * stride`. Stretching the
mounted range to reach it instead would mount every row in between, most of Home after
an End, for as long as the popup is open.

The Advanced Home override (`defaultHomeAddonUrl` plus `additionalHomeAddonUrls`) still
works: when set it restricts to those addons, in that order, before the catalog
flatten. The primary comes first, then the additionals in order; a URL listed twice
keeps its first position (`applyOverride`); an uninstalled URL drops out. There is no
migration, so a user whose override names installed addons sees exactly the rows they
saw before. It is NOT identical to before when the override has gone stale, and that is
deliberate. The old resolver substituted `addons[0]` whenever the primary was unset or
not installed. Two things follow from dropping that substitution. First, an uninstalled
primary now simply drops out. Second, an override that names no installed addon at all
behaves as no override: Home shows the automatic default board, with a one-time
`[election]` warning. Before, it stranded the user on `addons[0]`'s catalogs, which was
itself an arbitrary fallback. Home does not go empty either, because the picker lists
only installed addons, so a stale override that matches nothing is invisible there.

### 6. AIOMetadata

The forcing at `metaCache.ts:256` does two jobs from one constant. Inside the filter it
is a capability carve-out (exempt from the id-prefix gate); inside `rank` it is pure
ranking. They are separable and are separated here: the ranking is deleted, and the
carve-out is generalised into the primary exemption in section 1.

Two AIOMetadata uses are not ranking at all and are deliberately left alone:

- **Hero logos** (`HomeView.tsx:531`) address the AIO addon directly and early-return
  when it is absent. Already a silent nothing today for non-AIO users.
- **Landscape art** (`CinemaRows.tsx:835` into `landscapeArt.ts:101`) hits
  `/api/art/landscape`, a proprietary route that exists on no other addon. No amount
  of re-ranking can produce it.

Both are field-scoped second calls addressed at a specific addon, independent of who
wins meta election. `landscapeArt.ts` is the proven shape: its own bounded cache (200
entries, 24 h), its own single-flight through `dedupedInvoke`, and an explicit addon
argument.

The two AIOMetadata identity definitions get unified. `src/aiometadata.ts:224` uses a
name-or-URL regex `/aio[\s-]?metadata/i` while `src/addonDefaults.ts:36` uses
`AIOMETADATA_MANIFEST_ID = "com.aiometadata"`. They disagree in real cases (empty
`manifest_id` on legacy `addons.json` entries, renamed self-hosted instances, forks),
and that disagreement is part of why Calendar and DetailView can elect different
providers for the same title.

### 7. Advanced settings

New `showAdvancedSettings: boolean` in `AuraSettings`, default `false`, added to
`PORTABLE_AURA_FIELDS`. Cloud sync is automatic (`readSettingsBlob` ships the whole
object, `sync.ts:626`). It must be excluded from the "Settings saved" toast, because it
is a view preference rather than a setting and `hydratedRef` (`SettingsView.tsx:4520`)
only suppresses the hydration case.

There is no existing pattern to copy. A case-insensitive grep of `SettingsView.tsx` for
`advanced|show more|collapse|expanded|<details` finds only `AutoAdvanceDelayRow` and
the comment at `:3456-3457` recording that a collapsing UX was tried and removed
("Every leaf is visible at once"). This establishes the pattern, so it should stay
close to the conditional-render idiom already in the file rather than introducing an
accordion.

An `<AdvancedOnly>` wrapper composes with any row and preserves the `data-settings-row`
/ `data-settings-label` / `data-settings-description` search contract. The toggle lives
in the page header beside the search box.

Three mechanics are required or the page breaks:

- **Empty sections hide in lockstep with their TOC entry.** `TOC_GROUPS`
  (`:3334-3396`) drives both the table of contents and the scrollspy; a section whose
  every child is advanced must disappear from both, or the TOC links to an invisible
  anchor and highlights nothing. `sec-api-keys` (`:5758-5771`) hits this.
- **Settings search reveals.** A query matching a hidden advanced row auto-reveals
  Advanced rather than returning nothing. A settings search that cannot find "API key"
  is worse than the toggle.
- **Deep links reveal.** `aura:open-settings` (`:4667-4708`) targeting a section that
  is hidden auto-reveals. This matters immediately: `NoProvidersWarning`'s three call
  sites (`HomeView.tsx:711`, `SearchView.tsx:181`, `DetailView.tsx:5130`) deep-link to
  `sec-catalog`, `sec-search` and `sec-streams`, all of which now contain advanced rows.

Behind the toggle:

- The five provider controls: Home Catalog Sources (`:4882-4892`), Default Metadata
  Provider (`:4893-4899`), Hero Carousel Source (`:4901-4906`), Active Stream Providers
  (`:4916-4934`), On Submit search picker (`:4950-4968`). `useAuraStreamFormatter`
  (`:4936-4941`) shares `sec-streams` and stays visible.
- Forward buffer seconds (`:5216-5229`), forward buffer memory cap (`:5230-5242`),
  audio passthrough (`:5174-5185`), hardware acceleration (`:5809-5814`), motion
  interpolation and kernel (`:5278-5313`).
- OpenSubtitles and TMDB API keys (`:5759-5770`), automatic skip detection
  (`:5481-5487`), treat mixed-OP as OP (`:5474-5479`), screenshot folder (`:5243-5275`).
- Cloud Sync namespace table with Push / Pull / Clear (`:5730`, clear at `:2306-2312`),
  reset all settings (`:1300-1330`), storage report (`:5822-5824`), optional components
  (`:5829-5831`), crash reporting (`:5782-5787`).

Staying visible by explicit decision: **HDR mode and HDR display peak nits**
(`:5091-5133`), and **Backup and Restore export / import** (`:1161-1274`).

### 8. No migration

Stored provider lists keep being honoured as overrides. There is no upgrade-time code,
no version key, and no reorder offer.

The consequence is real and is mitigated in copy rather than in logic: a user with a
frozen allowlist has an addon order that does nothing, and the explanation is now behind
Advanced. So the Addons page line (section 9) is conditional. When every override is
`null` it states the rule; when any override is non-null it additionally says that some
providers are overridden in Settings and links there.

### 9. Addons page copy

One line under "Installed · {count}" (`AddonsView.tsx:783-789`) stating that the topmost
addon able to do a job does it, and that dragging changes that. Today the page says
nothing: the header is "Manage your Stremio-compatible addon sources", the list header
has no subtitle, and the sentence that does explain ordering lives on the Settings page
attached to a different list.

This is the highest-value copy change in the whole piece, because the mechanism is
invisible today.

## Stremio parity gaps

Both are genuine divergences found during this work, and both are in scope.

### Embedded per-video streams

The SDK spec says a Video object may carry `streams`, and that passing it means Stremio
will not request streams from other addons for that video. The spec's "will not request"
is true of the UI and false of the wire: `streams_update`
(`stremio-core/src/models/meta_details.rs:728-748`) issues its fan-out unconditionally
with no reference to `meta_streams`, and exclusivity happens in four lines of the wasm
serializer (`serialize_meta_details.rs:120-124`), which picks `meta_streams` when
non-empty and `streams` otherwise. So the behaviour to copy is **wholesale replacement at
the presentation layer**, not a merge and not a prepend.

Aura has none of it: `VideoEntry` (`src-tauri/src/stremio.rs:769-819`) has no `streams`
field and `extract_videos` (`:2844-2962`) never reads the key.

Implementation:

1. Add `#[serde(default)] pub streams: Vec<StreamEntry>` to `VideoEntry` and parse it in
   `extract_videos`, accepting the singular `stream` alias and a bare object as well as an
   array (stremio-core uses `OneOrMany<_, PreferMany>`, `meta_item.rs:338-355`). Cap at 80
   per video. `sanitize_stream` (`:3878-3997`) is reusable verbatim: it is pure and
   synchronous, and its load-bearing ordering (scheme and length filter before the
   url-or-infoHash gate) is internal, so stream-list invariant 1 survives automatically.
   Do not route these through `partition_aio_pseudo_streams` (`:3584`), which is an
   AIOStreams artifact.
2. No `#[serde(rename)]`. `StreamEntry` carries no rename attributes on any field, so the
   CLAUDE.md deserialize-only-rename trap does not apply.
3. One line in `src/types.ts` after `:250`.
4. Short-circuit in exactly two places: `DetailView.tsx` after `:1342` and before
   `setStreamsLoading(true)` at `:1349`, guarding on `activeVideo?.streams?.length` with a
   `detail?.videos.find(...)` fallback because the other id sources are bare strings; and
   `nextUp.ts:212-217`, widened to accept the `VideoEntry`. Four of the five
   `pickFirstStreamForEpisode` callers already hold one; `App.tsx:7107` passes `firstEp`,
   which is `undefined` for movies and degrades correctly.
5. **Explicitly do not short-circuit** at `App.tsx:8057` (stream-lost auto-retry
   re-resolve) or `DownloadsRelinkBridge.tsx:58` (expired download relink). Both exist
   *because a URL has expired*; App.tsx's own comment at `:8016-8022` says re-resolving is
   the only move with a chance because it mints a fresh token. An embedded stream URL is
   static and baked into the meta response, so serving it there re-serves the dead link and
   burns the last retry. Leave a comment at both sites.
6. The in-player source switcher (`App.tsx:7245`) **merges** rather than replaces, because
   showing alternatives is that panel's entire job.

Two decisions, both taken here:

- **Addon name.** `extract_videos` has no addon identity (its signature is
  `fn extract_videos(meta: &serde_json::Value)`), and `sanitize_stream` needs one. Rather
  than threading a host-derived label or adding a manifest fetch, `fetch_meta_detail` gains
  an optional `addon_name` parameter. The caller always holds the `AddonEntry`. This is
  free, keeps the sanitising invariant on the Rust side, and fixes the separate
  observability complaint that `fetch_meta_detail` passes `""` into `log_label` so the
  DevConsole shows a raw URL.
- **Do not persist embedded streams.** `metaCache` writes whole `MetaDetail` objects,
  and therefore every `VideoEntry`, to `aura:meta-cache:v1` with a 4 h episodic / 7 d movie
  TTL and no field stripping. Persisting embedded streams would promote expiring debrid and
  signed URLs into a multi-hour store, which is precisely what DetailView's in-memory-only
  3 minute cache exists to avoid (its comment at `:55-60` says so). A 1000-episode anime
  with 5 streams per video would also blow the 800-entry / ~1.5 MB budget and trigger the
  25 % reclaim, evicting unrelated metas. Strip `streams` in the persist path. The cost is
  honest and accepted: the short-circuit fires on a live meta fetch and not on a warm start.
- Do not `streamCachePut` the synthesized result, or the Refresh button's
  `force` -> `streamCacheDelete` path cannot clear it and looks broken.
- Do not port stremio-core's `yt_id:` synthetic-YouTube behaviour (`stream.rs:117-133`);
  it suppresses the entire addon stream list for any video id with that prefix.

### Subtitle request extras

URL shape is `/{resource}/{type}/{id}/{extra}.json`
(`stremio-core/src/addon_transport/http_transport/http_transport.rs:48-63`). Each key and
each value is percent-encoded individually with the `encodeURIComponent` set, joined
`key=value` with a literal `&`, and spliced raw into the path segment. The separators are
not encoded. The SDK does the exact inverse and documents why
(`stremio-addon-sdk/src/getRouter.js:51-57`).

The keys are `videoHash`, `videoSize` and **`filename`**. There is no `videoFilename` on
the wire: the stremio-core constant is named `VIDEO_FILENAME_EXTRA_PROP` but the string it
carries is `"filename"` (`constants.rs:108-125`), and `defineSubtitlesHandler.md` agrees.
Unknown values are omitted entirely rather than sent empty. Ignore
`stremio-addon-sdk/docs/protocol.md:22`, which claims the subtitles `id` is the hash; it is
stale and contradicted by the SDK's own handler docs, by stremio-core, and by the live
addon.

Aura builds the URL bare at `src-tauri/src/stremio.rs:4208` and the caller at
`src/App.tsx:3950-3954` sends only `{ addons, mediaType, id }`.

**Aura can compute all three extras.** `compute_opensubtitles_hash`
(`src-tauri/src/subtitles.rs:88-191`) already produces the OSDb hash from a remote URL over
two ranged GETs, parsing the exact file size out of the `Content-Range` total, with no
filesystem access. The comment at `:101-105` records that ranged GET was chosen over HEAD
*because* some debrid hosts refuse HEAD. It is registered at `lib.rs:2471` and already
called from `SubtitlePicker.tsx:106` against `activeStreamUrl`.

Implementation:

1. Widen `fetch_external_subtitles` (`:4182-4186`) with `video_hash: Option<String>`,
   `video_size: Option<u64>`, `filename: Option<String>`. Build the extras segment by
   percent-encoding each key and each value individually and joining with `&`; do not
   encode the joined string a second time. When no extras are known, emit the current bare
   URL unchanged, so there is no regression. Give each value its own cap (the existing
   `safe_id` cap of 128 is for the id; a release filename legitimately runs longer). No new
   registration: `player.toml:251` already allows the command and added parameters cost
   nothing.
2. Ship `filename` first. It is nearly free and is the extra the SDK explicitly nags addon
   authors about (`getRouter.js:94-98`). Source it from `currentStream.filename`, else the
   last path segment of the URL the way stremio-video does
   (`fetchVideoParams.js:143`), which for debrid URLs is usually the real release name.
3. Then `videoSize` and `videoHash` together, from one `compute_opensubtitles_hash` call:
   they arrive from the same request pair, so splitting them buys nothing. Prefer the size
   from `Content-Range` over `StreamEntry.video_size`, which is parsed
   (`stremio.rs:3974-3981`) and declared (`types.ts:310`) but read by no code anywhere, so
   its real-world accuracy is unmeasured.
4. Lift the hash out of `SubtitlePicker` into App.tsx state keyed by `activeStreamUrl`, have
   the picker read it rather than compute it, and **fire the subtitle fetch without extras
   first, then re-fire with extras once the hash lands**. A host that refuses `Range`
   returns an error rather than a degraded result (`subtitles.rs:114-119`), so this is what
   stops such a host costing the user their subtitle list. It stays a plain async Tauri
   command on the tokio runtime, never on the mpv engine thread (CLAUDE.md landmine 11).
5. **Fix the guard that would otherwise eat the feature.** The effect at
   `App.tsx:3924-3958` has `currentStream` and `activeStreamUrl` in closure scope but
   neither in its dep array at `:3958`, and its once-per-target ref guard at `:3932-3934`
   keys on `` `${media_type}:${id}` `` only. Switching source for the same episode changes
   the filename and hash but not the key, so the guard suppresses exactly the refetch that
   matters. Widen the key to include stream identity.
6. Do not read file size from mpv. The observed property set
   (`mpv/engine.rs:1817-1833`) is the seven that landmine 4 pins and has no size property,
   and `demuxer-cache-state.total-bytes` is cache occupancy, not file size.

**Do not adopt Stremio's "skip the fan-out when no extras are known" gate.** The evidence
is stronger than expected and points three ways:

- It is a request-deduplication guard, not a precision gate. It was added in
  `f06e5d30ce`, titled "fix: multiple requests to sub addons", in the same hunk that
  downgraded `force_request` to `request`. It suppresses an early param-less call that
  Aura does not make, because Aura's effect already has a once-per-target ref guard.
- It has four `&&`-joined conditions, not three (`player.rs:1298-1367`), and the fourth is
  `video_params.is_none()`. stremio-video's `withVideoParams` returns a non-null object for
  any non-null stream with the fields themselves null
  (`withVideoParams.js:48-57`), so core holds `Some(VideoParams { all None })`, the
  condition is false, and the fan-out fires with zero extras. Stremio ships the request the
  gate would suppress.
- Direct measurement: four-way A/B against the live Stremio-operated
  `opensubtitles-v3.strem.io` on `series/tt0903747:1:1` (no extras, `filename=`, a bogus
  extra, and `videoHash=&videoSize=`) returned 89 subtitles and byte-identical bodies with
  the same MD5 all four times. Its manifest declares no `extra` block at all. The hash is a
  ranking input for addons that choose to use it, never an admission ticket.

Stremio itself once hard-gated on `VideoParams` being present and removed it in 2023 as a
bug (`9a17813fe8`, "fix video params logic").

Carried honestly: because the one testable addon ignores all three extras, the payoff for
`videoHash` depends on which subtitle addons users install. Subsource could not be verified
(`subsource.strem.io/manifest.json` did not resolve; `subs.strem.io` is behind an anti-bot
interstitial). `filename` ships unconditionally; hash and size ship because they are nearly
free given the existing command, not because a target addon is known to use them.

## Cleanup in the same pass

- `DEFAULT_STREAM_ORDER` (`addonDefaults.ts:70`, an empty array) and
  `resolveStoredOrDefault` (`:119`) are dead: repo-wide grep returns only their own
  definitions. Delete.
- `DEFAULT_HOME_ORDER`, `DEFAULT_SEARCH_ORDER`, `DEFAULT_META_ORDER`, `resolveDefaultUrls`
  and `resolveDefaultMetaUrl` become vestigial under order election. Delete.
- `refresh_addon_manifest` (`stremio.rs:1382`) starts persisting a rebuilt `AddonEntry`
  through `addons::save`. Capability fields become load-bearing under this model and are
  currently frozen at install forever.
- Unify the `has_search` rule. `add_addon` (`stremio.rs:1181-1191`) ORs a catalogs-extra
  check with a `resources` scan; `cloud_add_addon` and `get_synced_addons`
  (`stremio.rs:2141-2154`, `auth.rs:875-889`) check catalogs only, so an addon declaring
  `"resources": ["search"]` with no search extra reads `true` locally and `false` when
  signed in. Unify on the OR.
- Four stale comments: `stremio.rs:1375` and `DiscoverView.tsx:146-148` both claim a
  5 minute manifest TTL when `MANIFEST_TTL` is 86 400 s; `addons.rs:23-25` promises a heal
  "until the next manifest refresh" that does not exist; `auraSettings.ts:606-607` says a
  provider list means "in the order they were installed" when the body uses the array's own
  order.
- `NotificationsScanner`'s `addons` prop (`:236`, stored in a ref at `:274`, never read).

## Out of scope

- Aura's stream dedup on `url ?? info_hash ?? title` (`stremio.rs:3638-3642`). Stremio
  does not dedup at all; Aura's behaviour is better and is kept.
- Simkl scrobbling. Separate project, separate spec, blocked on app registration.

## Verification

`cd src-tauri && cargo check --message-format=short && cd .. && pnpm exec tsc --noEmit`
after every phase. There are no tests in this project; those two are the correctness gates.

Runtime checks per phase, since most of this is behavioural and neither gate catches it:

1. Election: DevConsole `[election]` lines agree with the Addons page order. Reorder an
   addon, confirm the detail page and the hover card elect the same provider and that it
   changed. Confirm a `kitsu:` id still resolves with the top addon not declaring the prefix.
2. Home: row count matches the sum of home-eligible catalogs; scrolling to the bottom and
   back does not refetch; a deliberately broken addon shows a row-level error instead of
   vanishing; memory does not climb monotonically while scrolling.
3. Advanced: toggle survives restart; the TOC has no dead anchors in either state;
   searching "API key" with Advanced off reveals it; the three `NoProvidersWarning`
   deep links land on a visible control.
4. Parity: an addon that embeds `video.streams` short-circuits on the detail page and in
   Next-Up, and does **not** short-circuit on a stream-lost retry; subtitle requests carry
   `filename` and the fan-out still returns results against a `Range`-refusing host.

## Phases

1. Election module, consolidation of the twelve sites, observability, the `has_search`
   unification, and the dead-code deletions.
2. Home catalog-level rows, windowing, throttled fetch, per-row errors, ErrorBoundary.
3. Advanced settings toggle, the three reveal mechanics, TOC lockstep.
4. The two parity gaps, plus the Addons page copy.

Each phase is independently shippable and independently verifiable.
