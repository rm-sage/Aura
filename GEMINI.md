# Aura - Project Context

## Project Overview

**Aura** is a cinematic, glass-morphic desktop media player designed primarily for Windows 10/11. It is built to consume the Stremio addon ecosystem. 

**Core Technologies:**
- **Frontend:** React 19, TypeScript, Vite, Tailwind CSS
- **Desktop Framework:** Tauri 2
- **Backend Language:** Rust (stable, edition 2021)
- **Media Engine:** libmpv

**Key Architecture Notes:**
- **libmpv Integration:** The app requires `libmpv-2.dll` and `libmpv-wrapper.dll` placed in the `src-tauri/lib/` directory to function. These are not included in the repository.
- **Streaming Bridge (in-process):** Aura runs a small loopback proxy on `127.0.0.1:11471` that forwards plain-HTTP stream byte ranges. It's in-process (`src-tauri/src/streaming.rs`, started at setup) — no sidecar binary. HTTPS and HLS bypass it entirely.
- **Tauri Plugins Used:** Opener, clipboard-manager, shell, deep-link, window-state (for persistent bounds), updater (auto-updater).
- **Split Licensing:** AGPL-3.0-or-later for code; CC-BY-NC-4.0 for branding/logos.

## Building and Running

### Prerequisites
- Node.js and `pnpm`
- Rust (stable, 2021 edition)
- Windows 10/11 (macOS/Linux are not part of the primary CI lane)
- External DLLs downloaded to `src-tauri/lib/`

### Key Commands
- **Install Dependencies:**
  ```bash
  pnpm install
  ```
- **Run in Development Mode:**
  ```bash
  pnpm tauri dev
  ```
- **Type Checking:**
  ```bash
  pnpm tsc:check
  ```
- **Build / Release:**
  ```bash
  pnpm build
  pnpm bundle:release
  ```

## Development Conventions & Documentation

The project uses a structured management and documentation system located in the `conductor/` directory.

- **Product & Tech Info:** See `conductor/product.md` and `conductor/tech-stack.md` for high-level architecture and design intents.
- **Workflow & Style Guides:** Refer to `conductor/workflow.md` and `conductor/code_styleguides/` (general, html-css, typescript) for contribution and coding practices.
- **Track Management:** Work is organized into "tracks" (e.g., MVP), with their own plans and specs stored in `conductor/tracks/`.
- **Formatting / Linting:** Ensure TypeScript code compiles without errors via `tsc --noEmit`. Uses PostCSS and Tailwind for styling.
