# Implementation Plan: Aura Media Player MVP

This plan outlines the steps to build the Aura Media Player MVP, following the project's customized TDD and verification workflows.

## Phase 1: Video Player Engine & Spatial Foundation
Focus: Setting up the Tauri 2.0 environment, configuring transparency, and implementing the core media engine.

- [ ] Task: Initialize Tauri 2.0 Project and dependencies
    - [ ] Setup Tauri 2.0 with React (TypeScript) and Vite
    - [ ] Integrate `window-vibrancy` and configure initial transparency
- [ ] Task: Native MPV FFI Bridge & Overlay
    - [ ] Write Tests: FFI command dispatch and overlay transparency
    - [ ] Implement `tauri-plugin-mpv` bridge and transparent UI overlays
- [ ] Task: Hardware Acceleration Verification
    - [ ] Write Tests: First-launch diagnostic logic
    - [ ] Implement MPV hardware verification with software fallback (`vo=gpu-next`)
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Video Player Engine' (Protocol in workflow.md)

## Phase 2: Core Integration & Backend Services
Focus: Integrating content discovery and persistent storage.

- [ ] Task: Implement `stremio-core` Backend Integration
    - [ ] Write Tests: Native module initialization and event mapping
    - [ ] Implement `stremio-core` bridge in Rust
- [ ] Task: Pure-Rust Metadata Store
    - [ ] Write Tests: KV store read/write and caching logic
    - [ ] Implement `sled` or `redb` metadata storage
- [ ] Task: Secure Addon Proxying & Capabilities
    - [ ] Write Tests: Header stripping and Tauri capability whitelisting
    - [ ] Implement Rust-side proxy and whitelist per-module access
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Core Integration' (Protocol in workflow.md)

## Phase 3: Spatial Design System & UI Components
Focus: Realizing the visionOS aesthetic and spatial navigation.

- [ ] Task: Tailwind CSS visionOS Architecture
    - [ ] Setup design tokens for luminous neutrals and backdrop blurs
    - [ ] Implement base Glassmorphism layout components
- [ ] Task: Luminous Tinting Logic
    - [ ] Write Tests: Color extraction and tint application logic
    - [ ] Implement metadata-driven panel tinting
- [ ] Task: Spatial Focus & Z-Axis Interaction
    - [ ] Write Tests: Focus flows and 'lift' animation triggers
    - [ ] Implement spatial focus system and Z-axis hover effects
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Spatial Design System' (Protocol in workflow.md)

## Phase 4: Integration & Advanced Playback
Focus: Connecting backend state to UI and implementing high-fidelity media features.

- [ ] Task: Unidirectional Data Flow (Rust -> UI)
    - [ ] Write Tests: Event listener and state update synchronization
    - [ ] Implement Tauri Event-driven state updates in React
- [ ] Task: High-Fidelity Subtitle Integration
    - [ ] Write Tests: Style preservation and font attachment loading
    - [ ] Implement native ASS/SSA/SRT support via libmpv
- [ ] Task: Ambient Poster Fallback Strategies
    - [ ] Write Tests: Blur fallback application logic
    - [ ] Implement ambient blur treatment for low-res catalog assets
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Integration & UX' (Protocol in workflow.md)

## Phase 5: Testing & Beta Release
Focus: Broad verification and final polishing.

- [ ] Task: Comprehensive Integration Testing
- [ ] Task: Beta Release Preparation
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Broad Testing' (Protocol in workflow.md)
