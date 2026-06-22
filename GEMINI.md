# Aura - Project Context (Gemini)

The canonical, always-current project context for this repository lives in
**`CLAUDE.md`** at the repo root. Read `CLAUDE.md` in full before working in this
codebase: it covers the architecture, the single direct-FFI libmpv engine, the
in-process streaming bridge, the MPV stability landmines, Win32 fullscreen, the
caching and performance rules, the Tailwind theme-scale gotchas, and the
conventions (including the no-em-dash style rule).

This file deliberately defers to `CLAUDE.md` rather than duplicating it, so the
two can never drift apart. Shipped feature-design history is indexed in
`docs/ARCHIVE.md`; the live contracts are `docs/release-search-spec.md` and
`docs/AURA_PROXY_V2_SPEC.md`.
