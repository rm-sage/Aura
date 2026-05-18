# Notification ID Self-Heal (Wistoria) — Implementation Plan (Item 5)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development / superpowers:executing-plans. **BUT** read the "Execution gate" below first — only Task 1 (the 5.0 diagnostic) is cleared for autonomous execution. Tasks 5.1–5.3 are deliberately gated.

**Goal:** Make new-episode notifications fire for library shows whose stored Stremio id is a wrong/junk IMDb id (the missed "Wistoria: Wand and Sword" S02E06), without ever rewriting the wrong show's data incorrectly.

**Architecture:** Staged exactly as the approved spec mandates. **5.0** ships now: read-only DevConsole instrumentation that surfaces each scannable series' exact stored id + name + cloud-signal state, so the user can confirm the precise failing id and the path that wrote it. **5.1–5.3** (canonical-id resolver → use it for release-signal request/scanner keying → self-heal the Stremio *cloud* library record) are designed here but **gated** on the 5.0 runtime findings and explicit user authorization, because 5.3 is an irreversible, outward-facing mutation of the user's Stremio account and the spec made 5.0 gate it.

**Tech Stack:** React 19 + TypeScript. No Rust (TS-only — `pnpm exec tsc --noEmit`; if any task ends up touching Rust, add `cargo check --manifest-path src-tauri/Cargo.toml`). No test framework. `Write` blocked → `Edit`/`Set-Content`. `verify.cjs` auto-runs tsc after each `Edit`.

**Preconditions:** Branch `feat/ui-polish-correctness-batch` (Items 4, 2, 1, 3 shipped; HEAD `d676d77`). Confirm `git rev-parse --abbrev-ref HEAD`. Working tree clean.

---

## ⚠️ Execution gate (read before executing)

The approved spec (`docs/superpowers/specs/2026-05-18-aura-ui-polish-batch-design.md`, Item 5) is explicitly staged: **"5.0 Diagnostic (do first): … Findings can adjust 5.1-5.3."** and 5.3 **"mutates the Stremio cloud library — treat write/remove with the same care as existing `libraryActions`."**

- **Task 1 (5.0)** — read-only console instrumentation. No mutation, no network beyond what already runs. **Cleared for autonomous execution.**
- **Tasks 2–4 (5.1 resolver, 5.2 keying, 5.3 cloud self-heal)** — **NOT cleared for autonomous execution.** They require:
  1. The **5.0 runtime finding from the user** (Wistoria's exact stored id + whether its meta is empty/title-mismatched + the add-to-library path) — this is account-specific data that cannot be obtained without the user running the real app.
  2. Resolution of an **open implementation question**: 5.1's "re-resolve via a catalog search" needs a confirmed client search entry point. No single client search wrapper was found during planning (the Rust commands `global_search`/`search_addon_grouped`/`fetch_search_catalog_expanded` exist per `permissions/player.toml` `allow-global-search`, but the exact TS call site/shape must be confirmed against 5.0's findings before code is written — writing it now would be a placeholder/guess, which this plan refuses to do).
  3. **Explicit user authorization** for 5.3, because rewriting a Stremio cloud library record is irreversible and outward-facing.

Do **not** dispatch implementer subagents for Tasks 2–4 until the controller has the user's 5.0 findings and explicit go-ahead. The design below is precise enough to execute *once unblocked*; it is intentionally not padded with unverifiable code for the search call.

---

### Task 1: 5.0 — read-only diagnostic instrumentation (SHIPPABLE NOW)

**Files:** Modify `src/NotificationsScanner.tsx` (the scan loop where `getReleaseSignal(item.id)` is read)

**Why here:** The scanner iterates the scannable library items with the FULL `LibraryItem` in scope (so `item.name` is available, unlike `reconcileLibraryReleaseSignals` whose `LibraryLikeItem` carries only `id`+`media_type`). Logging at the `getReleaseSignal(item.id)` site shows, per series, the exact stored id, the name, and whether the cloud has a signal — which is precisely what 5.0 needs to confirm (a wrong baked id like `tt15401392` will show `signal=none`).

- [ ] **Step 1: Add the diagnostic log**

Edit `src/NotificationsScanner.tsx`. Replace:

```tsx
          const signal = getReleaseSignal(item.id);
          if (signal === undefined) continue; // store hasn't seen this id yet
          if (signal === null) continue;       // cloud has no record
```

with:

```tsx
          const signal = getReleaseSignal(item.id);
          // 5.0 diagnostic (Item 5): surface every scannable series'
          // EXACT stored id + name + cloud-signal state so a
          // missed-notification id (e.g. a wrong baked `tt…` id that
          // the cloud has no data for) is visible in the F12
          // DevConsole. Read-only — no mutation, no extra network.
          console.info(
            `[release-signals] scannable id=${item.id} ` +
            `name=${JSON.stringify(item.name)} type=${item.media_type} ` +
            `signal=${signal === undefined ? "unseen" : signal === null ? "none" : "present"}`,
          );
          if (signal === undefined) continue; // store hasn't seen this id yet
          if (signal === null) continue;       // cloud has no record
```

(Anchor is the exact 3-line block currently in the scan loop. `item` is the full `LibraryItem` here, so `item.name`/`item.media_type` are in scope. `console.info` is the established TS diagnostic pattern in this module — `reconcileLibraryReleaseSignals` already uses `console.warn("[release-signals] …")`, and the F12 DevConsole captures `console.*`.)

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/NotificationsScanner.tsx
git commit -m "diag(release-signals): log scannable id/name/signal state (Item 5 · 5.0)"
```

- [ ] **Step 4: Hand the diagnostic to the user (controller action, not a subagent)**

After this ships, the user must, on a real Windows build with their Stremio account: open F12 DevConsole, let the scanner run (or trigger a library refresh), and read the `[release-signals] scannable …` lines. The line for `name="Wistoria: Wand and Sword"` reveals its **exact stored id** and whether `signal=none` (confirming the wrong-baked-id hypothesis). That finding (plus: is the addon it was added from still installed? does `…/meta/series/<thatId>.json` return empty/another show?) is the input that unblocks Tasks 2–4.

---

## GATED FOLLOW-UP — Tasks 2–4 (5.1 / 5.2 / 5.3) — DO NOT AUTO-EXECUTE

Execute these only after: (a) the user reports the 5.0 finding, (b) the catalog-search client entry point is confirmed against that finding, (c) the user explicitly authorizes the 5.3 cloud-library mutation. The design is precise; the one deliberately-unwritten piece (the search call) is called out, not faked.

### Task 2 (5.1): canonical-id resolver — `src/canonicalReleaseId.ts` (NEW)

**Responsibility:** one module owning a persistent `{ badId → goodId }` map and the suspect-detection + re-resolution that populates it. Pure-local (localStorage); reversible; no cloud writes.

- **Sync API:** `canonicalReleaseId(item: { id: string }): string` → returns the mapped goodId if present, else `item.id` (so behavior is unchanged until a confident remap exists).
- **Async API:** `resolveSuspectIds(library: LibraryItem[], addons: AddonEntry[]): Promise<void>` — for each scannable `tt`-series not already mapped/checked:
  - Fetch meta via the existing `getMetaDetailFallback(addons, mediaType, item.id)` (signature confirmed: `(addons: AddonEntry[], mediaType: string, id: string) => Promise<MetaDetail | null>`).
  - **Suspect** iff meta is `null` (empty/404) **OR** `normalizeTitle(meta.name) !== normalizeTitle(item.name)`.
  - For a suspect id: re-resolve via a catalog search by `item.name` (+ year, + media_type), accept ONLY a strict `normalizeTitle` exact match of the same media_type → that match's id is `goodId`; persist `{ [item.id]: goodId }`.  **OPEN (resolve with 5.0 findings): the exact client search call.** Candidates: a TS wrapper over the `global_search` / `search_addon_grouped` / `fetch_search_catalog_expanded` Tauri commands (declared in `permissions/player.toml` `allow-global-search`). The 5.0 finding (which addon Wistoria came from, whether that addon exposes catalog/search) determines whether the search targets the default metadata addon or the origin addon. Code for this sub-step is intentionally NOT written until that is confirmed — fabricating an unverified `invoke("…")` signature would violate the no-placeholder rule.
  - Persisted map: localStorage key `aura:canonical-release-id:v1`, value `Record<string,string>`; also persist a "checked, clean" sentinel set so a clean id isn't re-probed every reconcile.
- **Cap/guard:** only `tt`-prefixed, series-ish, non-removed items; strict normalized-title equality; never map when the candidate's title doesn't exactly match — leave unmapped (fall back to stored id) rather than risk a wrong remap.

### Task 3 (5.2): use the canonical id (request + scanner keying)

Two precise integration points (both confirmed verbatim during planning):

- `src/releaseSignalStore.ts` `reconcileLibraryReleaseSignals` — the `items` builder loop (currently `items.push({ id: it.id, type: t })`): push `{ id: canonicalReleaseId(it), type: t }` so the request + the store key use the canonical id. Call `resolveSuspectIds(...)` (best-effort, non-blocking) so the map is populated for next reconcile; never block or throw (consistent with the existing `try/catch` + epoch-guard there).
- `src/NotificationsScanner.tsx` — every `item.id` used as a release-signal/store key (`getReleaseSignal(item.id)` and the scanner-state map `state[item.id]`, plus the seen/notify keys at the lines confirmed via grep: ~329, 342, 369, 462, 547, 600) must read through `canonicalReleaseId(item)`. The notification payload's user-facing ids stay as-is; only the cloud-lookup/state key changes. Fall back to `item.id` when unmapped (unchanged behavior).

This stage is local-only (changes which id the client *requests* + a localStorage map) — reversible, no outward mutation. It is the part that actually makes the Wistoria notification fire (the cloud has data under the correct id).

### Task 4 (5.3): self-heal the Stremio cloud library record — IRREVERSIBLE, USER-GATED

Reuses the confirmed `libraryActions.ts` pattern: writes go through `invoke("library_put", { authKey, changes })` (see `libraryWriteProgress` ~L116-181 and `libraryRemoveAll` ~L264-300 for the exact `change` object shape — `_id`, `type`, `name`, `removed`, `mtime`, carried `state`, etc.). Self-heal = build TWO changes: (1) a new record under `goodId` carrying the old record's `state`/progress/`ctime`/metadata, (2) the old `badId` record with `removed: true`; `invoke("library_put", { authKey, changes:[good, removedBad] })`; dispatch `aura:library-changed`.

**Guards (all required):** only when `canonicalReleaseId` produced a confident remap from a *clearly-junk* stored id (old id meta was empty/404 OR strict title-mismatch — never a mere "different"); only for `tt`-series; gated behind `releaseSearchEnabled`; **gated behind an explicit user opt-in** (a new `AuraSettings` flag defaulting OFF, surfaced in Settings, OR a one-time confirm — to be decided WITH the user); never runs unattended on launch without that opt-in. The 5.0 diagnostic must have confirmed the exact failing record first.

---

## Self-Review

**Spec coverage (Item 5):**
- 5.0 diagnostic "do first; findings can adjust 5.1-5.3" → Task 1 (concrete, shippable, read-only) + Step 4 hand-off. The spec's staging is honored: 5.0 genuinely gates the rest.
- 5.1 canonical-id resolver (suspect = empty/404 OR title-mismatch; re-resolve via search; persist `{bad→good}`) → Task 2 design; suspect-detection fully specified; the search call is honestly flagged as the one piece pending 5.0 confirmation (not faked).
- 5.2 use canonical id for request + scanner keying, fall back to stored id → Task 3, exact integration points verbatim-confirmed.
- 5.3 guarded Stremio-cloud rewrite reusing `libraryActions` patterns; only clearly-junk; gated behind `releaseSearchEnabled` → Task 4, plus an explicit user-opt-in gate added because the spec's "treat with the same care" + the irreversible/outward-facing nature + the absence of 5.0 ground truth demand it.

**Placeholder scan:** Task 1 is fully concrete (no placeholders). Tasks 2–4 are *design*, not no-placeholder implementation steps — this is deliberate and disclosed: the spec itself gates them on 5.0, and the single unknown (the search client call) is explicitly identified rather than papered over with an unverified `invoke`. Per the writing-plans no-placeholder rule, the *shippable* task (Task 1) has complete code; the gated tasks are honestly marked contingent rather than fabricated.

**Type consistency:** `canonicalReleaseId(item) → string` and `resolveSuspectIds(library, addons) → Promise<void>` are used consistently in Tasks 3's two integration points; `getMetaDetailFallback(addons, mediaType, id) → Promise<MetaDetail|null>` matches `src/metaCache.ts:146`. `ReleaseSignalItem` = `{ id: string; type: ReleaseMediaType }` (`releaseSearch.ts:82`) — Task 3's `{ id: canonicalReleaseId(it), type: t }` conforms.

**Scope/safety check:** Task 1 is independently valuable, reversible, and ships now. Tasks 2–4 correctly do NOT auto-execute; 5.3's irreversible cloud mutation is gated on user authorization + 5.0 ground truth + a resolved search API — matching the spec's deliberate staging and the project's care standard for `libraryActions`.
