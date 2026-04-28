# Product Guidelines: Aura

## Design Principles
- **Spatial Presence**: Elements should feel like they occupy physical space. Use shadows, z-axis positioning, and perspective to create depth.
- **Glassmorphism**: UI panels should use high-transparency backgrounds with heavy backdrop blurs (background-blur-3xl) and subtle border highlights.
- **Luminous Neutrals**: Primary text and highlights should use soft, glowing neutral tones that feel emitted rather than reflected.
- **True Black Integration**: Use deep, seamless blacks for video backgrounds to minimize visual borders between content and the application frame.

## User Experience (UX)
- **Fluid Transitions**: All navigation and UI state changes must be smooth and animated.
- **Responsive Overlays**: Control overlays should fade in/out gracefully and never obscure critical content unless necessary.
- **Ambient Feedback**: Use subtle glows and blurs to provide feedback for user interactions (hover, click).

## Performance Standards
- **Frame-Rate Priority**: Media playback must remain stable and stutter-free. Prioritize playback performance over complex UI animations during active video sessions.
- **Asset Handling**: Implement aggressive caching for catalog posters and metadata. Always use ambient blur fallbacks for loading or low-res assets.

## Tone and Voice
- **Minimalist**: Prose within the application should be brief, direct, and helpful.
- **Sophisticated**: Maintain a premium, high-end feel in all user-facing communication.
