# Initial Concept
use library /stremio-core
use library /tauri-plugin-mpv

Generate a highly detailed technical SPEC.md and write it to the local file. Include:
1. Rust backend integration logic mapping for stremio-core (handling addon fetching and state).
2. The exact Rust FFI bridge requirements for tauri-plugin-mpv, emphasizing window transparency for UI overlays.
3. A Tailwind CSS architectural guide strictly enforcing a visionOS design language: soft luminous neutrals, deep true-black seamless backgrounds, heavy backdrop-blur utilities, and floating glassmorphism panels.
4. Strict fallback UI strategies for Stremio catalog constraints (e.g., heavily blurring low-res poster assets into ambient backgrounds instead of cropping).

---

# Product Guide: Aura

## Overview
Aura is a high-fidelity media player built with Tauri 2.0 that adopts the sleek, immersive design language of visionOS. It leverages `stremio-core` for content discovery and `tauri-plugin-mpv` for high-performance media playback. The application provides a modern, spatial-inspired entertainment experience across supported desktop platforms.

## Core Features
- **Stremio Integration**: Full integration with `stremio-core` to manage addons, content catalogs, and user state.
- **High-Performance Playback**: Utilizing `tauri-plugin-mpv` with custom Rust FFI bridges for stable, hardware-accelerated media playback.
- **High-Fidelity Subtitles**: Native support for ASS/SSA/SRT formats via libmpv, preserving complex styling and font attachments.
- **Spatial UI Design**: A desktop interface featuring floating glassmorphism panels, backdrop blurs, and luminous neutral tones inspired by spatial computing.
- **Z-Axis Interaction**: Interactive elements utilize 'lift' and active edge-lighting on hover to emphasize spatial depth.
- **Luminous Aesthetics**: UI overlays designed with transparency and true-black backgrounds to provide a premium, modern feel.
- **Ambient Poster Treatment**: Smart fallback strategies for low-resolution assets, blurring them into ambient background environments.
- **Security Auditability**: Explicit use of Tauri's capability system to strictly whitelist file and network access per module, brokered by the Rust backend.


## Technical Goals
- **Rust Backend**: Efficient handling of `stremio-core` logic and media state management.
- **Spatial Design System**: A Tailwind CSS-based architectural guide for spatial UI elements.
- **FFI Integration**: Robust communication between the Tauri frontend and the native MPV core.
