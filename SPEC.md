# Aura: Cinematic Media Player Specification

## Tech Stack
- **Platform:** Tauri 2.0 (Rust backend, React + TS frontend)
- **Media Engine:** libmpv via `tauri-plugin-mpv` (vo=gpu-next, hwdec=auto-safe)
- **Content Engine:** `stremio-core` (Rust-integrated)
- **Persistence:** `redb` (Pure-Rust KV store)
- **Vibrancy:** `window-vibrancy` (Native Mica/Acrylic/Vibrant effects)

## Design System (visionOS / Apple TV+ Aesthetic)
- **Background:** Seamless, deep cinematic true-black.
- **Surfaces:** Floating glass panels, heavy backdrop-blur, 1px luminous borders.
- **Luminous Tinting:** Panels inherit subtle tints from metadata colors.
- **Spatial UI:** Z-axis 'lift' and edge-lighting on hover/focus.

## Functional & Security
- **Addon Proxying:** Requests brokered by Rust to strip headers/tracking.
- **Subtitles:** Native ASS/SSA/SRT support via libmpv.
- **Scalability:** Fluid layout for ultrawide displays.

## Roadmap Priorities
1. Native FFI Bridge & MPV Initialization
2. Transparent UI Overlay & Vibrancy
3. Stremio-core Addon Integration
4. Spatial UI & Catalog Redesign