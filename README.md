# Aura

A cinematic, glass-morphic desktop media player for Windows, built on
Tauri 2 + React 19 + libmpv. Consumes the Stremio addon ecosystem.

## Status

Active development. See `ROADMAP.md` for the feature pipeline and
`HANDOFF.md` for the running design / forensic notes.

## Building from source

Prerequisites:

- Rust (stable, edition 2021)
- Node.js + pnpm
- Windows 10/11 (primary target — macOS / Linux paths exist for the
  non-Windows-specific code but aren't part of the regular CI lane)

The libmpv DLLs are NOT in the repo (they're > 100 MB). Drop the two
DLLs into `src-tauri/lib/`:

- `libmpv-2.dll` — from <https://github.com/zhongfly/mpv-winbuild>
- `libmpv-wrapper.dll` — from <https://github.com/nini22P/libmpv-wrapper>

Then:

```
pnpm install
pnpm tauri dev
```

### Optional: aura-bridge runtime helper

Aura runs alongside a small companion binary, `aura-bridge`, that
forwards plain-HTTP stream byte ranges. It's distributed as a separate
component and is **not required** for normal use — HTTPS streams bypass
it entirely, and the vast majority of Stremio addons today serve over
HTTPS. If a binary named `aura-bridge.exe` is found next to Aura's
own executable (or anywhere on PATH at app launch), it'll be spawned
automatically; if absent, plain-HTTP streams fail gracefully with a
warning logged to the F12 DevConsole and the rest of the app continues
to work.

## License

This project uses split licensing.

- **Code** is licensed under the **GNU Affero General Public License,
  version 3 or any later version (AGPL-3.0-or-later)** — see
  [`LICENSE`](LICENSE) for the full text. In short: you may
  redistribute and modify the code, but any network-deployed
  modification (or distributed binary) must publish its source under
  the same license.

- **Branding** — the Aura name, the Aura "A" logo (`src/AuraLogoA.tsx`,
  `src-tauri/icons/*`), and any associated wordmark / logotype — is
  licensed separately under **Creative Commons Attribution-
  NonCommercial 4.0 International (CC-BY-NC-4.0)** — see
  [`LICENSE-ASSETS`](LICENSE-ASSETS) for the full text and the exact
  list of paths covered. Forks intending to ship a commercial product
  MUST replace these branding assets with their own.

## Contact

For licensing questions, security reports, or anything else relating
to this project:

- **Electronic mail:** [contact@animasec.dev](mailto:contact@animasec.dev)
- **Postal mail:** *intentionally omitted*
