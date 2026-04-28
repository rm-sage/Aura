# Implementation Plan: Aura Media Player MVP

This plan outlines the steps to build the Aura Media Player MVP, following the project's customized TDD and verification workflows.

## Phase 1: Native Foundation & Core Integration
Focus: Setting up the Tauri 2.0 environment and core Rust-side engines.

- [ ] Task: Initialize Tauri 2.0 Project and dependencies
    - [ ] Setup Tauri 2.0 with React (TypeScript) and Vite
    - [ ] Integrate `window-vibrancy` and configure initial transparency
- [ ] Task: Implement `stremio-core` Backend Integration
    - [ ] Write Tests: Native module initialization and event mapping
    - [ ] Implement `stremio-core` bridge in Rust
- [ ] Task: Pure-Rust Metadata Store
    - [ ] Write Tests: KV store read/write and caching logic
    - [ ] Implement `sled` or `redb` metadata storage
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Native Foundation' (Protocol in workflow.md)

## Phase 2: Video Player Engine & Optimization
Focus: Implementing the high-performance media engine and hardware verification.

- [ ] Task: Native MPV FFI Bridge
    - [ ] Write Tests: FFI command dispatch and property observation
    - [ ] Implement `tauri-plugin-mpv` bridge logic
- [ ] Task: Hardware Acceleration Verification
    - [ ] Write Tests: First-launch diagnostic logic
    - [ ] Implement MPV hardware verification with software fallback (`vo=gpu-next`)
- [ ] Task: Secure Addon Proxying
    - [ ] Write Tests: Header stripping and request interception
    - [ ] Implement Rust-side proxy for addon requests
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Video Player Engine' (Protocol in workflow.md)

## Phase 3: Spatial Design System & UI Components
Focus: Realizing the visionOS aesthetic and spatial navigation.

- [ ] Task: Tailwind CSS visionOS Architecture
    - [ ] Setup design tokens for luminous neutrals and backdrop blurs
    - [ ] Implement base Glassmorphism layout components
- [ ] Task: Luminous Tinting Logic
    - [ ] Write Tests: Color extraction and tint application logic
    - [ ] Implement metadata-driven panel tinting
- [ ] Task: Spatial Focus Management
    - [ ] Write Tests: Keyboard/D-Pad navigation focus flows
    - [ ] Implement spatial focus system for UI navigation
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Spatial Design System' (Protocol in workflow.md)

## Phase 4: Integration & Advanced UX
Focus: Connecting the backend state to the UI and polishing the experience.

- [ ] Task: Unidirectional Data Flow (Rust -> UI)
    - [ ] Write Tests: Event listener and state update synchronization
    - [ ] Implement Tauri Event-driven state updates in React
- [ ] Task: Transparent UI Overlay Implementation
    - [ ] Implement non-blocking overlays for player controls
- [ ] Task: Ambient Poster Fallback Strategies
    - [ ] Write Tests: Blur fallback application logic
    - [ ] Implement ambient blur treatment for low-res catalog assets
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Integration & UX' (Protocol in workflow.md)
