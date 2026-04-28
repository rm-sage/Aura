# Specification: Aura Media Player MVP

## 1. Overview
Aura is a high-fidelity, spatial media player built with Tauri 2.0. It integrates `stremio-core` for content and `tauri-plugin-mpv` for playback, adopting a visionOS-inspired design language.

## 2. Core Architecture
### 2.1 Backend (Rust)
- **Content Engine**: `stremio-core` integration for managing addons and metadata.
- **Media Engine**: `tauri-plugin-mpv` with customized FFI bridge.
- **State Persistence**: Pure-Rust KV store (`sled` or `redb`) for caching.
- **Security**: Rust-side proxy for addon requests to strip headers and prevent tracking.
- **Hardware Verification**: First-launch diagnostic for MPV hardware acceleration with software fallback.

### 2.2 Frontend (React + TypeScript)
- **UI System**: Tailwind CSS with custom utilities for backdrop-blur, glassmorphism, and luminous neutrals.
- **Data Flow**: Unidirectional (Rust Events -> UI) to ensure backend-driven state.
- **Focus Management**: Spatial focus system for Keyboard/D-Pad navigation.

## 3. Technical Requirements

### 3.1 stremio-core Integration
- Implement a dedicated Rust module to handle `stremio-core` initialization.
- Map core events to Tauri Events for real-time UI updates.
- Use `sled` for persistent metadata caching to avoid C++ build dependencies.

### 3.2 tauri-plugin-mpv FFI Bridge
- **Transparency**: Configure Tauri window with transparency and `window-vibrancy` (Mica/Acrylic/Vibrancy).
- **FFI Layer**: Robust Rust FFI bridge to handle MPV commands and property observations.
- **UI Overlay**: Implementation of transparent overlays that don't interrupt native MPV rendering performance.

### 3.3 visionOS Design Language
- **Luminous Tinting**: Logic to extract primary colors from metadata posters and apply them as subtle tints to glass panels.
- **Backdrop Blur**: Global utility for `backdrop-blur-3xl` and soft luminous neutrals.
- **Seamless Blacks**: `vo=gpu-next` and true-black backgrounds to eliminate borders during video playback.

### 3.4 Fallback & Performance
- **Ambient Blurs**: Heavily blur low-resolution poster assets into backgrounds instead of cropping or stretching.
- **MPV Optimization**: `vo=gpu-next`, `hwdec=auto-safe` for premium efficiency.

## 4. Security
- **Header Stripping**: Rust-side interceptor for all outbound addon requests.
- **Local Privacy**: No telemetry or third-party tracking in the core architecture.
