# Addon Copy + Configure Buttons — Implementation Plan (Item 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an always-visible "Copy manifest URL" icon button and a conditional "Configure" icon button (shown only when the addon's manifest declares `behaviorHints.configurable`) to each row in the Addons page, styled identically to the existing Refresh/Remove buttons.

**Architecture:** Rust learns one new manifest fact: `behaviorHints.configurable` is parsed into `WireManifest`, persisted as `AddonEntry.configurable: bool` at the three existing `AddonEntry` construction sites (local add, cloud add, cloud-sync), and `#[serde(default)]` keeps old `addons.json` loading. The TS `AddonEntry` gains `configurable?: boolean`. `AddonsView` renders the two new buttons, reusing the exact Refresh-button styling and a robust clipboard helper; the existing right-click context menu is refactored to share the same URL computation.

**Tech Stack:** Rust (serde, Tauri commands), React 19 + TypeScript, Tailwind. No new Tauri command (the new field rides existing add/sync commands; the buttons are pure frontend), so the 3-place command-registration rule does **not** apply here.

**Verification model (project-specific — overrides the skill's TDD template):** Repo has NO test framework/ESLint/Prettier (CLAUDE.md). Gates: `cargo check --manifest-path src-tauri/Cargo.toml --message-format=short` for Rust, `pnpm exec tsc --noEmit` for TS, plus manual acceptance. A repo hook (`verify.cjs`) auto-runs `tsc` after every `Edit` (it does NOT run cargo — run cargo explicitly). The `Write` tool is blocked; modify existing files with `Edit`. Do NOT write tests.

**Preconditions:** Branch `feat/ui-polish-correctness-batch` (Item 4 already shipped). Confirm: `git rev-parse --abbrev-ref HEAD` → `feat/ui-polish-correctness-batch`. Working tree clean (`git status --porcelain` empty).

---

### Task 1: Rust — parse, persist & propagate `configurable`

**Files:**
- Modify: `src-tauri/src/addons.rs` (AddonEntry struct, ~L52)
- Modify: `src-tauri/src/stremio.rs` (WireManifest ~L165-186; add_addon ~L1024-1036; cloud_add_addon ~L1742-1754; new helper near the `extract_manifest_*` block ~L3297)
- Modify: `src-tauri/src/auth.rs` (cloud-sync AddonEntry literal ~L463-499)

Rust will NOT compile until all of Steps 1-6 are applied (adding a non-defaulted struct field breaks every `AddonEntry { … }` literal). Therefore Steps 1-6 are one atomic commit; `cargo check` runs once after Step 6.

- [ ] **Step 1: Add the `configurable` field to the persisted `AddonEntry`**

Edit `src-tauri/src/addons.rs`. Replace:

```rust
    /// Per-resource override of `idPrefixes` for the stream resource (the
    /// stricter of the two wins inside fetch_streams).
    #[serde(default)]
    pub stream_id_prefixes: Vec<String>,
}
```

with:

```rust
    /// Per-resource override of `idPrefixes` for the stream resource (the
    /// stricter of the two wins inside fetch_streams).
    #[serde(default)]
    pub stream_id_prefixes: Vec<String>,
    /// Whether the addon manifest declares `behaviorHints.configurable =
    /// true` — i.e. it hosts a `/configure` page. Drives the conditional
    /// "Configure" button in the Addons UI; Cinemeta and other
    /// non-configurable addons have this `false` so no button shows.
    /// `#[serde(default)]` (=> `false`) keeps older `addons.json` files —
    /// and addons whose manifest predates this capture — loading
    /// forward-compatibly; the value is (re)populated whenever the entry
    /// is rebuilt (local add, cloud add, or the launch-time cloud sync).
    #[serde(default)]
    pub configurable: bool,
}
```

- [ ] **Step 2: Parse `behaviorHints.configurable` into `WireManifest`**

Edit `src-tauri/src/stremio.rs`. Replace:

```rust
    #[serde(default, rename = "idPrefixes")]
    id_prefixes: Vec<String>,
}

#[derive(Clone, Deserialize)]
struct WireCatalogEntry {
```

with:

```rust
    #[serde(default, rename = "idPrefixes")]
    id_prefixes: Vec<String>,
    /// Stremio `behaviorHints` — we only need `configurable` (does the
    /// addon host a `/configure` page?). `#[serde(default)]` tolerates a
    /// missing object; nested `#[serde(default)]` tolerates a missing
    /// `configurable` key.
    #[serde(default, rename = "behaviorHints")]
    behavior_hints: WireBehaviorHints,
}

#[derive(Clone, Default, Deserialize)]
struct WireBehaviorHints {
    #[serde(default)]
    configurable: bool,
}

#[derive(Clone, Deserialize)]
struct WireCatalogEntry {
```

- [ ] **Step 3: Add a public `extract_manifest_configurable` helper**

Edit `src-tauri/src/stremio.rs`. Replace:

```rust
/// Manifest-level `idPrefixes` from a raw manifest JSON.
pub fn extract_manifest_id_prefixes(manifest: &serde_json::Value) -> Vec<String> {
    manifest
        .get("idPrefixes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| cap(s.into(), 32))).collect())
        .unwrap_or_default()
}
```

with:

```rust
/// Manifest-level `idPrefixes` from a raw manifest JSON.
pub fn extract_manifest_id_prefixes(manifest: &serde_json::Value) -> Vec<String> {
    manifest
        .get("idPrefixes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| cap(s.into(), 32))).collect())
        .unwrap_or_default()
}

/// Public helper — whether the manifest declares
/// `behaviorHints.configurable == true` (the addon hosts a `/configure`
/// page). Consumed by `cloud_add_addon` and `auth.rs` cloud-sync, which
/// build `AddonEntry` from a raw manifest JSON rather than `WireManifest`.
pub fn extract_manifest_configurable(manifest: &serde_json::Value) -> bool {
    manifest
        .get("behaviorHints")
        .and_then(|v| v.get("configurable"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}
```

- [ ] **Step 4: Set `configurable` in `add_addon` (local / guest)**

Edit `src-tauri/src/stremio.rs`. Replace:

```rust
    let types       = collect_wire_types(&wire);
    let resources   = collect_wire_resources(&wire);
    let id_prefixes = collect_wire_id_prefixes(&wire);
    let (stream_types, stream_id_prefixes) = collect_wire_stream_resource_info(&wire);

    let entry = AddonEntry {
        url: base,
        name: wire.name,
        manifest_id: wire.id,
        has_search,
        types,
        resources,
        stream_types,
        id_prefixes,
        stream_id_prefixes,
    };
```

with:

```rust
    let types       = collect_wire_types(&wire);
    let resources   = collect_wire_resources(&wire);
    let id_prefixes = collect_wire_id_prefixes(&wire);
    let (stream_types, stream_id_prefixes) = collect_wire_stream_resource_info(&wire);
    let configurable = wire.behavior_hints.configurable;

    let entry = AddonEntry {
        url: base,
        name: wire.name,
        manifest_id: wire.id,
        has_search,
        types,
        resources,
        stream_types,
        id_prefixes,
        stream_id_prefixes,
        configurable,
    };
```

- [ ] **Step 5: Set `configurable` in `cloud_add_addon` (logged-in add)**

Edit `src-tauri/src/stremio.rs`. Replace:

```rust
    let types       = extract_manifest_types(&manifest_json);
    let resources   = extract_manifest_resources(&manifest_json);
    let id_prefixes = extract_manifest_id_prefixes(&manifest_json);
    let (stream_types, stream_id_prefixes) = extract_stream_resource_info(&manifest_json);

    Ok(AddonEntry {
        url: base,
        name,
        manifest_id,
        has_search,
        types,
        resources,
        stream_types,
        id_prefixes,
        stream_id_prefixes,
    })
}
```

with:

```rust
    let types       = extract_manifest_types(&manifest_json);
    let resources   = extract_manifest_resources(&manifest_json);
    let id_prefixes = extract_manifest_id_prefixes(&manifest_json);
    let (stream_types, stream_id_prefixes) = extract_stream_resource_info(&manifest_json);
    let configurable = extract_manifest_configurable(&manifest_json);

    Ok(AddonEntry {
        url: base,
        name,
        manifest_id,
        has_search,
        types,
        resources,
        stream_types,
        id_prefixes,
        stream_id_prefixes,
        configurable,
    })
}
```

- [ ] **Step 6: Set `configurable` in the cloud-sync builder (`auth.rs`)**

Edit `src-tauri/src/auth.rs`. Replace:

```rust
            let (stream_types, stream_id_prefixes) =
                crate::stremio::extract_stream_resource_info(manifest);
            let manifest_id = manifest
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
```

with:

```rust
            let (stream_types, stream_id_prefixes) =
                crate::stremio::extract_stream_resource_info(manifest);
            let configurable = crate::stremio::extract_manifest_configurable(manifest);
            let manifest_id = manifest
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
```

Then, in the same file, replace:

```rust
                Some(AddonEntry {
                    url: base_url,
                    name,
                    manifest_id,
                    has_search,
                    types,
                    resources,
                    stream_types,
                    id_prefixes,
                    stream_id_prefixes,
                })
```

with:

```rust
                Some(AddonEntry {
                    url: base_url,
                    name,
                    manifest_id,
                    has_search,
                    types,
                    resources,
                    stream_types,
                    id_prefixes,
                    stream_id_prefixes,
                    configurable,
                })
```

- [ ] **Step 7: Type-check Rust**

Run: `cargo check --manifest-path src-tauri/Cargo.toml --message-format=short`
Expected: ends with `Finished … target(s)` and exit code 0. Pre-existing warnings are fine; there must be NO errors. If you see `missing field 'configurable' in initializer of 'AddonEntry'`, a construction site in Step 4/5/6 was missed — `git grep -n "AddonEntry {" src-tauri/src` lists exactly the three (`stremio.rs` ×2, `auth.rs` ×1); fix the missed one.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/addons.rs src-tauri/src/stremio.rs src-tauri/src/auth.rs
git commit -m "feat(addons): parse & persist manifest behaviorHints.configurable"
```

---

### Task 2: TypeScript — add `configurable` to the `AddonEntry` interface

**Files:**
- Modify: `src/types.ts` (AddonEntry interface ~L4-24)

- [ ] **Step 1: Add the optional field**

Edit `src/types.ts`. Replace:

```ts
  /** Per-resource override of `idPrefixes` for the stream resource. */
  stream_id_prefixes?: string[];
}
```

with:

```ts
  /** Per-resource override of `idPrefixes` for the stream resource. */
  stream_id_prefixes?: string[];
  /** Manifest `behaviorHints.configurable` — true when the addon hosts a
   *  `/configure` page. Drives the conditional Configure button in the
   *  Addons UI. Optional for back-compat with any cached pre-field shape;
   *  the Rust side now always emits it (default `false`). */
  configurable?: boolean;
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(addons): add configurable to AddonEntry TS type"
```

---

### Task 3: AddonsView — Copy + conditional Configure buttons

**Files:**
- Modify: `src/views/AddonsView.tsx` (helper after imports ~L13; AddonRow ~L223-376; icon components after `SpinnerDot` ~L437)

Edits are ordered so the file is type-valid after each (the `verify.cjs` hook auto-runs `tsc` after every `Edit`): icons and the clipboard helper are added first (unused top-level functions do not trip `noUnusedLocals`), then `AddonRow` is replaced wholesale so every new symbol it references already exists and every new local it introduces is used in the same edit.

- [ ] **Step 1: Add the `CopyIcon` and `ConfigureIcon` glyphs**

Edit `src/views/AddonsView.tsx`. Replace:

```tsx
function SpinnerDot() {
  return (
    <div
      className="w-2 h-2 rounded-full bg-current"
      style={{ animation: "addon-spinner-pulse 0.9s ease-in-out infinite" }}
      aria-hidden
    />
  );
}

// ---------------------------------------------------------------------------
// AddonsView
```

with:

```tsx
function SpinnerDot() {
  return (
    <div
      className="w-2 h-2 rounded-full bg-current"
      style={{ animation: "addon-spinner-pulse 0.9s ease-in-out infinite" }}
      aria-hidden
    />
  );
}

/** Copy glyph — swaps to a checkmark for ~1.5 s after a successful
 *  copy. Stroke-based so it inherits the button's hover text colour,
 *  matching RefreshIcon / CloseIcon. */
function CopyIcon({ copied }: { copied: boolean }) {
  if (copied) {
    return (
      <svg
        width="17" height="17" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round"
        strokeLinejoin="round" aria-hidden
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg
      width="16" height="16" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** Configure glyph (sliders) — shown only for addons whose manifest
 *  declares `behaviorHints.configurable`. */
function ConfigureIcon() {
  return (
    <svg
      width="17" height="17" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" aria-hidden
    >
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// AddonsView
```

- [ ] **Step 2: Add the robust `copyText` clipboard helper**

Edit `src/views/AddonsView.tsx`. Replace:

```tsx
import { requestReopenAddons } from "../onboarding";

// ---------------------------------------------------------------------------
// Types
```

with:

```tsx
import { requestReopenAddons } from "../onboarding";

/** Copy text to the clipboard. Prefers the Tauri clipboard plugin
 *  (reliable on every WebView2 build), falling back to the browser
 *  Clipboard API. Mirrors the helper in PlayerOverlay.tsx (proven to
 *  compile — the plugin is a declared dependency). */
async function copyText(text: string): Promise<boolean> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
```

- [ ] **Step 3: Replace the entire `AddonRow` function**

Edit `src/views/AddonsView.tsx`. Replace the whole current `AddonRow` function (from `function AddonRow({` through its closing `}` immediately before the `/** Refresh glyph …` comment) with the version below. This single edit adds the `copied` state, lifts `manifestUrl`/`configureUrl` to the top of the component (so the buttons AND the context menu share one computation), upgrades the context-menu "Copy" to the robust helper, and inserts the Copy + conditional Configure buttons before Refresh. Refresh/Remove are byte-unchanged.

Old string — the exact current function:

```tsx
function AddonRow({
  addon,
  session,
  onRemove,
  onSessionExpired,
}: {
  addon: AddonEntry;
  session: UserSession | null;
  onRemove: (url: string) => void;
  onSessionExpired: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const handleRemove = async () => {
    setRemoving(true);
    try {
      if (session?.auth_key) {
        await invoke("cloud_remove_addon", { authKey: session.auth_key, url: addon.url });
      } else {
        await invoke("remove_addon", { url: addon.url });
      }
      onRemove(addon.url);
    } catch (e) {
      if (String(e) === "SESSION_EXPIRED") onSessionExpired();
      setRemoving(false);
    }
  };

  // Force a fresh manifest fetch (bypassing the 5-min MANIFEST_CACHE
  // TTL). Surfaces newly-added catalogs on self-hosted AIOMetadata
  // without forcing a remove + re-add cycle. Toast on success with the
  // catalog count so the user gets concrete feedback; toast + shake on
  // error so a network blip is obvious without burying the chip.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const manifest = await invoke<{ catalogs: unknown[]; name?: string }>(
        "refresh_addon_manifest",
        { addonUrl: addon.url },
      );
      const count = Array.isArray(manifest.catalogs) ? manifest.catalogs.length : 0;
      showAppToast(`Refreshed ${addon.name} — ${count} catalog${count === 1 ? "" : "s"}`, { duration: 2500 });
    } catch (e) {
      showAppToast(`Couldn't refresh ${addon.name}: ${String(e)}`, { duration: 4000 });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div
      className="group flex items-center gap-3 px-4 py-3 rounded-xl
                 bg-white/3 border border-white/6 hover:bg-white/5
                 transition-colors"
      onContextMenu={(e) => {
        e.preventDefault();
        // The manifest URL is the install URL with /manifest.json appended.
        const manifestUrl = addon.url.endsWith("/manifest.json")
          ? addon.url
          : `${addon.url.replace(/\/$/, "")}/manifest.json`;
        // Stremio addon "Configure" pages live at <base>/configure
        const configureUrl = addon.url.endsWith("/manifest.json")
          ? addon.url.replace(/\/manifest\.json$/, "/configure")
          : `${addon.url.replace(/\/$/, "")}/configure`;
        openContextMenu(e.clientX, e.clientY, [
          {
            label: "Configure addon",
            onClick: () => openUrl(configureUrl).catch(() => {}),
          },
          {
            label: "Open manifest URL",
            onClick: () => openUrl(manifestUrl).catch(() => {}),
          },
          {
            label: "Copy manifest URL",
            onClick: () => navigator.clipboard.writeText(manifestUrl).catch(() => {}),
          },
          {
            label: "Remove addon",
            onClick: handleRemove,
            danger: true,
          },
        ]);
      }}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-white/85 text-sm font-medium leading-tight">{addon.name}</p>
          {addon.has_search && <SearchBadge />}
        </div>
        <p className="text-white/30 text-xs font-mono truncate">
          {addon.url.replace(/^https?:\/\//, "")}
        </p>
        {(addon.types?.length || addon.resources?.length) ? (
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            {(addon.types ?? []).map((t) => <TagPill key={`t:${t}`} label={t} />)}
            {(addon.resources ?? [])
              // Hide the implicit `catalog` resource if the addon already has
              // catalog types listed — it's redundant noise.
              .filter((r) => !(r.toLowerCase() === "catalog" && (addon.types ?? []).length > 0))
              .map((r) => <TagPill key={`r:${r}`} label={r} />)}
          </div>
        ) : null}
      </div>
      {/* Paired icon buttons — Refresh + Remove. Larger glass-styled
          targets, vertically centred against the row, persistent (no
          hover-to-reveal) so the affordances are always discoverable.
          Refresh uses the accent palette to match Aura's primary
          actions; Remove uses rose hover for the destructive intent. */}
      <div className="flex-shrink-0 flex items-center gap-2 self-center">
        <Tooltip text={refreshing ? "Refreshing…" : "Refresh manifest"} pos="bottom">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || removing}
            aria-label={`Refresh ${addon.name}`}
            className="w-10 h-10 flex items-center justify-center rounded-xl
                       bg-white/[0.04] border border-white/10
                       text-white/65 hover:text-ln-accent
                       hover:bg-ln-accent/12 hover:border-ln-accent/40
                       hover:shadow-[0_0_0_3px_rgba(91,164,255,0.08),0_4px_14px_-6px_rgba(91,164,255,0.45)]
                       transition-all duration-150
                       disabled:opacity-40 disabled:hover:bg-white/[0.04]
                       disabled:hover:border-white/10 disabled:hover:shadow-none
                       active:scale-95 active:bg-ln-accent/18"
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        </Tooltip>
        <Tooltip text={removing ? "Removing…" : "Remove addon"} pos="bottom">
          <button
            type="button"
            onClick={handleRemove}
            disabled={removing || refreshing}
            aria-label={`Remove ${addon.name}`}
            className="w-10 h-10 flex items-center justify-center rounded-xl
                       bg-white/[0.04] border border-white/10
                       text-white/65 hover:text-rose-300
                       hover:bg-rose-500/12 hover:border-rose-400/40
                       hover:shadow-[0_0_0_3px_rgba(244,63,94,0.08),0_4px_14px_-6px_rgba(244,63,94,0.45)]
                       transition-all duration-150
                       disabled:opacity-40 disabled:hover:bg-white/[0.04]
                       disabled:hover:border-white/10 disabled:hover:shadow-none
                       active:scale-95 active:bg-rose-500/20"
          >
            {removing ? <SpinnerDot /> : <CloseIcon />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
```

New string — the replacement function:

```tsx
function AddonRow({
  addon,
  session,
  onRemove,
  onSessionExpired,
}: {
  addon: AddonEntry;
  session: UserSession | null;
  onRemove: (url: string) => void;
  onSessionExpired: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  // The manifest URL is the install URL with /manifest.json appended;
  // Stremio "Configure" pages live at <base>/configure. Computed once
  // here so the icon buttons AND the right-click context menu share a
  // single source of truth.
  const manifestUrl = addon.url.endsWith("/manifest.json")
    ? addon.url
    : `${addon.url.replace(/\/$/, "")}/manifest.json`;
  const configureUrl = addon.url.endsWith("/manifest.json")
    ? addon.url.replace(/\/manifest\.json$/, "/configure")
    : `${addon.url.replace(/\/$/, "")}/configure`;

  const handleRemove = async () => {
    setRemoving(true);
    try {
      if (session?.auth_key) {
        await invoke("cloud_remove_addon", { authKey: session.auth_key, url: addon.url });
      } else {
        await invoke("remove_addon", { url: addon.url });
      }
      onRemove(addon.url);
    } catch (e) {
      if (String(e) === "SESSION_EXPIRED") onSessionExpired();
      setRemoving(false);
    }
  };

  // Force a fresh manifest fetch (bypassing the 5-min MANIFEST_CACHE
  // TTL). Surfaces newly-added catalogs on self-hosted AIOMetadata
  // without forcing a remove + re-add cycle. Toast on success with the
  // catalog count so the user gets concrete feedback; toast + shake on
  // error so a network blip is obvious without burying the chip.
  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const manifest = await invoke<{ catalogs: unknown[]; name?: string }>(
        "refresh_addon_manifest",
        { addonUrl: addon.url },
      );
      const count = Array.isArray(manifest.catalogs) ? manifest.catalogs.length : 0;
      showAppToast(`Refreshed ${addon.name} — ${count} catalog${count === 1 ? "" : "s"}`, { duration: 2500 });
    } catch (e) {
      showAppToast(`Couldn't refresh ${addon.name}: ${String(e)}`, { duration: 4000 });
    } finally {
      setRefreshing(false);
    }
  };

  const handleCopyManifest = async () => {
    const ok = await copyText(manifestUrl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      showAppToast("Couldn't copy manifest URL", { duration: 3000 });
    }
  };

  return (
    <div
      className="group flex items-center gap-3 px-4 py-3 rounded-xl
                 bg-white/3 border border-white/6 hover:bg-white/5
                 transition-colors"
      onContextMenu={(e) => {
        e.preventDefault();
        openContextMenu(e.clientX, e.clientY, [
          {
            label: "Configure addon",
            onClick: () => openUrl(configureUrl).catch(() => {}),
          },
          {
            label: "Open manifest URL",
            onClick: () => openUrl(manifestUrl).catch(() => {}),
          },
          {
            label: "Copy manifest URL",
            onClick: () => { void copyText(manifestUrl); },
          },
          {
            label: "Remove addon",
            onClick: handleRemove,
            danger: true,
          },
        ]);
      }}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-white/85 text-sm font-medium leading-tight">{addon.name}</p>
          {addon.has_search && <SearchBadge />}
        </div>
        <p className="text-white/30 text-xs font-mono truncate">
          {addon.url.replace(/^https?:\/\//, "")}
        </p>
        {(addon.types?.length || addon.resources?.length) ? (
          <div className="flex items-center gap-1.5 flex-wrap pt-1">
            {(addon.types ?? []).map((t) => <TagPill key={`t:${t}`} label={t} />)}
            {(addon.resources ?? [])
              // Hide the implicit `catalog` resource if the addon already has
              // catalog types listed — it's redundant noise.
              .filter((r) => !(r.toLowerCase() === "catalog" && (addon.types ?? []).length > 0))
              .map((r) => <TagPill key={`r:${r}`} label={r} />)}
          </div>
        ) : null}
      </div>
      {/* Paired icon buttons — Copy, optional Configure, Refresh,
          Remove. Larger glass-styled targets, vertically centred,
          persistent (no hover-to-reveal). Copy/Configure reuse the
          Refresh button's exact accent styling so the cluster reads as
          one set; Remove uses rose hover for destructive intent. */}
      <div className="flex-shrink-0 flex items-center gap-2 self-center">
        <Tooltip text={copied ? "Copied ✓" : "Copy manifest URL"} pos="bottom">
          <button
            type="button"
            onClick={handleCopyManifest}
            aria-label={`Copy ${addon.name} manifest URL`}
            className="w-10 h-10 flex items-center justify-center rounded-xl
                       bg-white/[0.04] border border-white/10
                       text-white/65 hover:text-ln-accent
                       hover:bg-ln-accent/12 hover:border-ln-accent/40
                       hover:shadow-[0_0_0_3px_rgba(91,164,255,0.08),0_4px_14px_-6px_rgba(91,164,255,0.45)]
                       transition-all duration-150
                       disabled:opacity-40 disabled:hover:bg-white/[0.04]
                       disabled:hover:border-white/10 disabled:hover:shadow-none
                       active:scale-95 active:bg-ln-accent/18"
          >
            <CopyIcon copied={copied} />
          </button>
        </Tooltip>
        {addon.configurable && (
          <Tooltip text="Configure addon" pos="bottom">
            <button
              type="button"
              onClick={() => openUrl(configureUrl).catch(() => {})}
              aria-label={`Configure ${addon.name}`}
              className="w-10 h-10 flex items-center justify-center rounded-xl
                         bg-white/[0.04] border border-white/10
                         text-white/65 hover:text-ln-accent
                         hover:bg-ln-accent/12 hover:border-ln-accent/40
                         hover:shadow-[0_0_0_3px_rgba(91,164,255,0.08),0_4px_14px_-6px_rgba(91,164,255,0.45)]
                         transition-all duration-150
                         disabled:opacity-40 disabled:hover:bg-white/[0.04]
                         disabled:hover:border-white/10 disabled:hover:shadow-none
                         active:scale-95 active:bg-ln-accent/18"
            >
              <ConfigureIcon />
            </button>
          </Tooltip>
        )}
        <Tooltip text={refreshing ? "Refreshing…" : "Refresh manifest"} pos="bottom">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing || removing}
            aria-label={`Refresh ${addon.name}`}
            className="w-10 h-10 flex items-center justify-center rounded-xl
                       bg-white/[0.04] border border-white/10
                       text-white/65 hover:text-ln-accent
                       hover:bg-ln-accent/12 hover:border-ln-accent/40
                       hover:shadow-[0_0_0_3px_rgba(91,164,255,0.08),0_4px_14px_-6px_rgba(91,164,255,0.45)]
                       transition-all duration-150
                       disabled:opacity-40 disabled:hover:bg-white/[0.04]
                       disabled:hover:border-white/10 disabled:hover:shadow-none
                       active:scale-95 active:bg-ln-accent/18"
          >
            <RefreshIcon spinning={refreshing} />
          </button>
        </Tooltip>
        <Tooltip text={removing ? "Removing…" : "Remove addon"} pos="bottom">
          <button
            type="button"
            onClick={handleRemove}
            disabled={removing || refreshing}
            aria-label={`Remove ${addon.name}`}
            className="w-10 h-10 flex items-center justify-center rounded-xl
                       bg-white/[0.04] border border-white/10
                       text-white/65 hover:text-rose-300
                       hover:bg-rose-500/12 hover:border-rose-400/40
                       hover:shadow-[0_0_0_3px_rgba(244,63,94,0.08),0_4px_14px_-6px_rgba(244,63,94,0.45)]
                       transition-all duration-150
                       disabled:opacity-40 disabled:hover:bg-white/[0.04]
                       disabled:hover:border-white/10 disabled:hover:shadow-none
                       active:scale-95 active:bg-rose-500/20"
          >
            {removing ? <SpinnerDot /> : <CloseIcon />}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no output, exit 0. (If "Cannot find name 'CopyIcon'/'ConfigureIcon'/'copyText'", Step 1 or 2 was skipped/mismatched.)

- [ ] **Step 5: Manual acceptance check**

Run `pnpm tauri dev` (or `pnpm dev` if the shell is already up). In the app → Addons:
1. Every addon row shows, left→right: **Copy**, (Configure only on configurable addons), **Refresh**, **Remove** — all four glyphs the same size/glass style.
2. Click **Copy** → icon flips to a checkmark, tooltip reads "Copied ✓" for ~1.5 s, and the manifest URL is in the clipboard (paste to verify).
3. **Cinemeta** shows **no** Configure button. An addon known to be configurable (e.g. a configurable AIOMetadata / Torrentio-style addon) shows the Configure button; clicking it opens `<base>/configure` in the default browser.
   - Note: a guest-mode addon added BEFORE this change keeps `configurable:false` until removed+re-added; a logged-in account picks it up on the next launch-time cloud sync. Test configurability with a freshly-added addon.
4. Right-click a row → context menu still has Configure / Open / Copy / Remove and all still work.
Expected: all four hold.

- [ ] **Step 6: Commit**

```bash
git add src/views/AddonsView.tsx
git commit -m "feat(addons): copy-manifest + conditional configure buttons"
```

---

## Self-Review

**Spec coverage (Item 2 of `docs/superpowers/specs/2026-05-18-aura-ui-polish-batch-design.md`):**
- "Copy manifest button (always shown), robust clipboard, transient Copied ✓" → Task 3 (`copyText` w/ plugin→navigator fallback; `copied` state flips icon + tooltip 1.5 s).
- "Configure button, conditional, opens `<base>/configure` via plugin-opener, Cinemeta shows nothing" → Task 3 (`{addon.configurable && …}`, `openUrl(configureUrl)`).
- "Buttons styled exactly like Refresh/Remove" → Task 3 reuses the Refresh button's exact class string verbatim for both.
- "Supplement, not replace, the context menu" → context menu retained; only its duplicated URL math is lifted and its Copy upgraded to the shared helper.
- "Add behavior_hints.configurable to WireManifest; persist configurable:bool on AddonEntry (Rust+TS); populate at the existing construction sites; serde default for legacy" → Tasks 1-2 (WireBehaviorHints, all 3 literals, `#[serde(default)]`, TS `configurable?`).
- "3-place command registration if a command is added" → N/A and stated: no new command (field rides existing add/sync; buttons are pure frontend).
- Gates → cargo check (Task 1) + tsc (Tasks 2-3) + manual (Task 3).

**Spec-wording clarification (not a gap):** The spec said "populated at install/refresh/cloud-sync". In the actual code, `refresh_addon_manifest` rebuilds NO `AddonEntry` field (types/id_prefixes/etc. are equally only set at add/cloud-add/cloud-sync). This plan stays consistent with that existing behavior rather than adding a bespoke refresh-time persistence path for one field (out of scope, inconsistent). User-facing outcome still holds and matches the spec's own "no forced migration; launch-time sync covers most": configurable addons get the button on (re)add or, for logged-in users, the next launch-time cloud sync. The manual-check note in Task 3 Step 5 makes this explicit.

**Placeholder scan:** none. Every code step has complete old/new code; every command has an expected result.

**Type consistency:** Rust `AddonEntry.configurable: bool` (`#[serde(default)]`, no rename → serializes as `"configurable"`, satisfying CLAUDE.md's deserialize-only rename rule since no rename is used) ↔ TS `configurable?: boolean` ↔ JSX `addon.configurable` (truthy guard tolerates `undefined`). `WireBehaviorHints` derives `Clone, Default, Deserialize` (Default required by the field's `#[serde(default)]`). `extract_manifest_configurable(&serde_json::Value) -> bool` is `pub`, called as `crate::stremio::extract_manifest_configurable` from `auth.rs` (mirrors the sibling `extract_manifest_*` already called there) and unqualified within `stremio.rs`. `copyText(text: string): Promise<boolean>` defined once; `CopyIcon({copied:boolean})` / `ConfigureIcon()` names match their JSX use sites.
