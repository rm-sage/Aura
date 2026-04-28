# Technology Stack: Aura

## Frontend
- **Framework**: React (with TypeScript)
- **Styling**: Tailwind CSS (strictly enforcing visionOS design system)
- **Runtime**: Node.js
- **UI Architecture**: Component-based with a focus on glassmorphism and ambient blurs.

## Backend / System Integration
- **Platform**: Tauri 2.0
- **Language**: Rust
- **Media Engine**: `tauri-plugin-mpv` (Defaults: `vo=gpu-next`, `hwdec=auto-safe`).
- **Content Engine**: `stremio-core` integrated directly into the Rust backend.
- **Data Store**: Pure-Rust KV store (`sled` or `redb`) for metadata caching (avoiding C++ dependencies).
- **Vibrancy**: `window-vibrancy` crate for OS-level effects (Mica/Acrylic on Windows).

## State Management & Communication (Unidirectional Data Flow)
- **Single Source of Truth**: **Rust Backend** (`stremio-core`) manages all persistent media and content state.
- **Data Flow**: Rust emits **Tauri Events** to update the React UI.
- **UI Commands**: React sends **Tauri Commands** (IPC) to the backend for actions.
- **Ephemeral State**: Minimal UI-specific state (e.g., component visibility) managed in React.

## Build & Tooling
- **Bundler**: Vite
- **Package Manager**: pnpm (preferred)
- **Native Build**: Cargo (Rust)
