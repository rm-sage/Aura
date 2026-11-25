---
paths:
  - "src/App.css"
  - "src/styles/glass-*.css"
  - "src/glassStyle.ts"
  - "src/glassGlint.ts"
  - "src/liquidGlass.ts"
  - "src/glassListDroplet.ts"
  - "src/popPresence.ts"
  - "src/GlassStyleSetting.tsx"
  - "src/AccentColorSetting.tsx"
  - "src/accentColor.ts"
  - "src/themeAccent.ts"
  - "src/useMaterialNotice.ts"
  - "src/auraSettings.ts"
  - "src/ContextMenu.tsx"
  - "src/Tooltip.tsx"
  - "src/*Panel*.tsx"
  - "src/*Toast*.tsx"
  - "src/NotificationsBell.tsx"
  - "src/NavSidebar.tsx"
  - "src/RailRow.tsx"
  - "src/railLayout.ts"
  - "src/HeroCarousel.tsx"
  - "src/heroSource.ts"
  - "src/HeroBleed.tsx"
  - "src/bleedTint.ts"
  - "src/heroAmbient.ts"
  - "src/cardGlow.ts"
  - "src/ImageLoader.tsx"
  - "public/aura-glass-rim.js"
  - "src/CinemaRows.tsx"
  - "src/WatchedBadge.tsx"
  - "src/glassSheet.ts"
  - "src/views/*.tsx"
  - "src/views/live/GuideView.tsx"
  - "src/LoginView.tsx"
  - "src/LandingView.tsx"
  - "src/playerMenu.tsx"
  - "src/DetailHud.tsx"
  - "src/AnimeExtrasOverlay.tsx"
  - "src/PersonGrid.tsx"
  - "src/ArcGrid.tsx"
  - "src/HeroBackdropPicker.tsx"
  - "src/SourcePopup.tsx"
  - "src/PlayerOverlay.tsx"
  - "src/SourceSwitcher.tsx"
  - "src/AniSkipMenu.tsx"
  - "src/ResumePrompt.tsx"
  - "src/EosSpotlight.tsx"
  - "src/NextUpCta.tsx"
  - "src/SubtitlePicker.tsx"
  - "src/PlayerPartyHud.tsx"
  - "src/AccountButton.tsx"
  - "src/settingsControls.tsx"
  - "src/FilterBar.tsx"
  - "src/mediaTypePills.tsx"
---

# Floating surfaces and the glass system

> Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything
> else, read it before changing any tooltip, menu, popover, panel, dialog, pill, search box or
> Settings control.

## Two materials, one set of classes

Aura draws every glass surface in one of two materials, chosen in Settings > Theme > "Material style"
(and on the onboarding Look step). Both are glass, so the shown names say how they differ (round 13,
the user: "translucent & glass ... are both pretty much glass styles"): Matte diffuses what is behind
it, Clear shows through and bends the light at its edges. Settings search still finds the row by
every old name (Translucent, Frosted, Liquid, Glass, Glass style).

- **Matte** (shown name, formerly "Translucent"; stored value and code name "frosted", the default
  for installs from before the material choice, style A of the glass study): a baked dark gradient
  plus blur and saturate, a lit top hairline (the border's top side, one pixel: round 14, see "The
  rim is a hairline" under the cursor light), a dark bottom one and a drop shadow. Internally (code,
  CSS, comments) the material is still called Frosted, but the UI never shows "Frosted" (user's call).
- **Clear** (shown name, formerly "Glass"; stored value and code name "liquid", internally still called Liquid, the
  default for new installs, style B): one uniform translucent body for menus (no lit edge band, see
  "The menu body" below); on floating controls (the rail, the search bar, pills) the round 9
  "Obsidian" A face (a neutral 0.30 tint, an even 0.02 white lift, blur 20 / saturate 130%, no milky
  sheen, no dark pool, no dark ring; see "The A control tier" below) edged by the idle rim of the
  cursor light system; a thin specular rim on in-page flat controls (iOS 26 style, see "The specular
  rim" below); and an SVG `feDisplacementMap` refraction concentrated at the rim. Morphs: the rail's active pill and segmented
  indicators slide and stretch on a spring, menus grow from their trigger, search bars widen on
  focus (on a sliced, width-independent lens that stays bound while they move).

The choice is `AuraSettings.glassStyle` (`"frosted" | "liquid"`) plus `glassCursorGlow` (shown as
"Cursor glow", default on): ONE device-wide blob (`aura:settings:v1`; only the sync stamp
`aura:settings-updated-at:<scope>` is per scope), cloud-synced, and portable
(`PORTABLE_AURA_FIELDS`), like the theme. What is DRAWN is decided only in `src/glassStyle.ts`,
which stamps `<html data-glass="frosted|liquid">` and `<html data-glass-glint-mode="on|off">`
synchronously before React mounts (`main.tsx`). Under Cursor glow (Settings
only, not the wizard; the rows grey out while Cursor glow is off, in a disabled fieldset, never
unmounting, so Settings search still finds them) `glassGlowTune` (`{ edge, surface, size }`: Edge highlights 0 to 200%, Surface glow
0 to 250%, Glow size 200 to 420 px, plus Reset; `GlassStyleSetting.tsx` `GlowTuneRows`) rides the same
blob: portable (`PORTABLE_AURA_FIELDS`) and synced, `writeSettingsBlob` keeping the local value when an
incoming blob has no key, `sanitizeGlassGlowTune` clamping every read. See "The cursor light" below.

Defaults: `auraSettings.ts` `decideGlassDefaults` runs once per install at module load (marker
`aura:glass-defaults:v1`): an install whose onboarding is complete keeps `LEGACY_GLASS` (frosted, glow
off) and owes the device-local "New look options" bell notice (`useMaterialNotice.ts`, id
`notice:material-style`, in sync.ts `isDeviceLocalNotification`, deep link `sec-appearance`); a new
install gets liquid + glow on. It writes localStorage directly, never `saveAuraSettings` (that would
stamp the sync clock). A blob missing either key reads as `LEGACY_GLASS`. A cloud pull whose blob
lacks a glass key keeps the local value, or takes `LEGACY_GLASS` when this account never synced on
this machine (stamp 0) (`writeSettingsBlob`). `aura:glass-defaults:v1` and `aura:material-notice:v1`
are device-local and never synced.

What is drawn depends on:

- Hardware acceleration off (backend `gpu_acceleration: false`): Liquid falls back to Frosted
  (displacement on software rendering costs whole frames). Read once per launch, and the last
  answer is remembered in localStorage (`aura-glass-gpu-off`, machine-local) so the first frame
  already draws the right material. The Material style row says so (Clear shows as Matte).
- Zero-blur themes (`--ln-blur-elev: 0px`: midnight, contrast, contrast-azure): the attribute stays
  as chosen, glass goes OPAQUE on `--ln-panel-solid` (Liquid keeps its face shading over it) and the
  refraction binder stands down. No theme id is named in JS; the facts are read back from the
  computed root style.
- High Contrast themes set `--lg-glint-off: 1`: no cursor glint, and an `!important` 0.35 white
  edge on every glass class in every state (an accessibility floor, not a look).
- `prefers-reduced-motion` / the Settings override (`data-reduced-motion`): pops become fades, the
  spring tokens collapse (springs snap), presses do not scale, the droplet does not grow.

## Which class

All in the GLASS SYSTEM block of `src/App.css`; per-surface rules in `src/styles/glass-*.css`
(loaded after App.css by `main.tsx`).

| Class | Use | Liquid |
|-------|-----|--------|
| `.aura-float-glass` | Menus, context menus, popovers, panels, dialogs, hover cards | menu tier (densest), refracted |
| `.aura-float-glass.aura-glass-control` | Floating controls on art: the left rail (`.aura-rail`, one surface), Home search bar, hero arrows, detail floating buttons, HUD tabs | control tier (the A face), refracted, idle rim |
| `.aura-float-glass.aura-glass-tip` | Tooltips, toasts, transient bars | menu chain with lighter tokens, NEVER refracted (cheap) |
| `.aura-glass-sheet` (via `glassSheet.ts` `sheet()`) | In-page sections and cards ON a page: Settings sections and TOC, empty / error states, Calendar cells, the Live TV group rail, the Addons list and account box | the A control face with NO backdrop pass, never refracted, never lifts; idle rim + cursor light as a panel ("In-page sheets and pages" below) |
| `.aura-glass-flat` | In-page buttons, selects (`+ .aura-glass-select`), chips (`+ .aura-filter-chip`); tones `.is-primary` / `.is-danger` / `.is-warning` (`+ .is-strong`) | luminous face + specular rim (`--lg-spec`) on a faint lit ring (`--lg-spec-ring`), no backdrop pass |
| `.aura-glass-field` | Text fields (an `<input>` or a wrapper holding one) | shallow sunken well, lit lower lip |
| `.aura-glass-player` | ANYTHING over the mpv video (player menus, bars, panels, party HUD, OSD, the stream-lost modal, the cast bar) | material only, no backdrop: the A face at a 0.86 tint with the idle rim and cursor light (`styles/glass-player.css`, "The player A face" below) |
| `.aura-glass-item` / `.aura-glass-row` | Tabs / nav-like items and rows inside menus; selected = `aria-selected` / `aria-current` / `aria-pressed` / `aria-checked` true or `.is-selected` | raised face + accent label |
| `.aura-content-group` / `.aura-content-row` | CONTENT on a page: Settings lists (sortable addon sources and Available, Keybindings, ChoiceList), any list or table inside a page card. NOT glass: no backdrop, no hooks, no glint, never in the glass reset / paint rule / `GLINT_SELECTOR` / liquidGlass discovery | identical in both materials; fill `--ln-glass-1`, hairlines `--ln-rim-subtle`; states `.is-capturing`, `.is-dragging`, `.aura-keybind-lost` |
| `SegmentedControl` (`settingsControls.tsx`) | Every segmented control (Settings, onboarding, the episode grouping toggle, Airing, Live, the playlist form's tabs via `fill`, the AuraSkip menu's skip modes over the video): never hand-roll one | rim-lit field-tier track, sliding raised thumb on `--lg-springy` ("Segmented control and switch" below) |
| `ToggleSwitch` (`settingsControls.tsx`), drawing `.aura-glass-toggle` + `.aura-glass-knob` | Every on/off switch, never hand-rolled markup: a button, or `decorative` inside a row or pill that carries `role="switch"` (filter menu, Library, Queue, Detail, player menus); sizes md 40 x 24 / sm 36 x 20 / xs 32 x 18 | rim-lit sunken track, glass-bead knob with the Liquid stretch, accent fill when on |

Tips and toasts (`.aura-glass-tip`) are LIGHTER than menus in both materials: the menu face kept
about a quarter to a third of the backdrop plus almost no lift, so a toast over the dark page read
darker than the page itself (bare-page face 17 Liquid / 22 Frosted against a page of 31; "the
settings saved toast looks a little too dark"). The tip face is about 0.25 x backdrop + 37 (Frosted:
its own `--lg-face` with a white layer under the dark one; Liquid: the menu chain and face retuned
through the `--lg-menu-*` tokens on the tip itself, never `--lg-face` / `--lg-backdrop`, so the
zero-blur rule still wins): bare-page face about 44 (Liquid) / 47 (Frosted). White 0.9 text keeps at
least 4.5:1 even over a pure white backdrop (measured 5.27 Liquid, 4.71 Frosted; about 11.5 over the
page). Re-measure that worst case before lightening a tip further.

Glass is the navigation and control layer. A list, table or form row on a page is content and never
takes `.aura-glass-flat` / `-item` / `-choice`; a control INSIDE a content row (a Remove button, a
select) stays glass. A toggle row inside a glass popover is an `.aura-glass-row` (`role=switch`), never
a raised `.aura-glass-flat` (glass on glass).

A card that opens with an inline CSS transition driven by React state uses `usePopPresence`
(`src/popPresence.ts`): never a double rAF started in the effect that requests the mount (React can
batch the mount and the flip into one commit and skip the transition). An anchor snapshot goes in a
layout effect declared before the hook.

The player's top-left stack (skip prompt, Next-Up card, tail pill) is
`.aura-glass-player.aura-stack-surface` (round 11): the player A face at a denser 0.9 tint, so the
prompt's large type reads over any frame (the old black 0.9 fill, white 0.3 border and 40 px backdrop
blur are gone). DevConsole is out of scope. The title block above the stack is NOT a stack surface
since 2026-11-22 (the user's call): see "The top bar" under "The player A face" below.

**Never `.glass-panel-elevated` / `.glass-panel` for a floating surface.** They composite
`--ln-glass-3`, which is TINTED PER THEME (the warm themes push it toward orange); over a wide
element on bright key art that reads as an accent-coloured fill.

### Motion tokens

`--aura-spring-snappy` (+ `--aura-spring-snappy-dur`, 320 ms: k600/c38, 2% overshoot) and
`--aura-spring-bouncy` (+ `--aura-spring-bouncy-dur`, 480 ms: k420/c24, 10% overshoot) are `linear()`
curves sampled from real damped springs (App.css `:root`). Use them only on transform, translate,
scale and sizes, NEVER on opacity: they pass 1, and opacity would clamp or flicker. A pop is therefore
two animations, `aura-glass-pop-fade` beside the shape (`aura-glass-pop-shape` in Liquid,
`aura-glass-pop-frost-shape` in Frosted). The notifications side sheet and arrival bubble grow out of
the rail on their own transitions (see "Notifications" below).
`--lg-springy` stays on the search-bar widths (the maintainer likes it as is). Under reduced motion the
tokens collapse to `linear(0, 1)` / 1 ms; fades keep their durations. The Liquid hover droplet grows
from `scale(0.94, 0.8)` on the bouncy spring.

A pop anchored AT THE POINTER (the context menu and its submenu, `ContextMenu.tsx`) must never
translate across its anchor: it sets `--lg-pop-dy: 0px` (the pop shapes' opening lift, default -4 px
Frosted / -8 px Liquid) and only grows away from the click corner. With the lift, the Liquid menu slid
up over the stationary pointer for about 70 ms; Chromium's layout-driven hover re-test then unhovered
the card under it (`.card-grow` dropped 1.02 to 0.94, read as a "shrink") and lit the menu's first row,
and both flipped back as the spring settled. Hover droplets (`useMenuDroplet`, `useListDroplet`) are
armed by the first real `pointermove`: a `pointerover` with no move (a menu opening or clamped under a
still pointer) never lights a row. That first move lights the row under the pointer; after it,
`pointerover` drives row changes.

Never scale or translate a TEXT-bearing glass element on hover (`.aura-glass-press`, `.nav-tap`, rail
rows, the detail Back button, small chips): the compositor resamples one raster of the label for the
whole transition, so it reads soft and then snaps crisp. Hover feedback is `--lg-lift` plus the glint;
press squashes (`:active`) are fine.

NavPill (the left rail, see "The left rail" below) renders two twin `.aura-rail-pill`, shown by `.is-on`
(opacity plus delayed visibility). A pointer click on the row under the Liquid hover droplet hands
off: the spare twin snaps to the clicked row and fades in while the droplet and the old pill fade out.
Keyboard and programmatic route changes still slide; a re-layout (a breakpoint) snaps.

### Customising a glass element: set the hooks, never the properties

The paint rule sets `background`, `border`, `box-shadow` and `backdrop-filter` from custom
properties. A `bg-*` / `border-*` / `shadow-*` / `ring-*` / `backdrop-blur-*` utility on a glass
element either loses to it or overrides BOTH materials, so drop the utility and set a hook:

- `--lg-lift` (0..0.1): a white lift over the face (hover / selected; registered, animatable).
- `--lg-ring`: an extra box-shadow first in the list (tone hairlines: `.aura-glass-tone-danger`,
  `-warning`, `-success`, `-accent`).
- `--lg-deco`: one extra background layer (the select chevron, a tone wash).
- `--lg-origin`: where `.aura-glass-pop-in` grows from (the trigger side, `50% 50%` for a dialog).

An animation on a glass element that touches `box-shadow` must carry the glass list
(`var(--lg-ring), var(--lg-rimlight), var(--lg-edge), var(--lg-drop)`) in every keyframe (see
`AppToast.tsx`, `styles/glass-chrome.css`), or its fill erases the edge and meniscus. `--lg-rimlight`
is registered with no initial value, so a box-shadow that names it on an element outside the glass
`:where` reset is invalid and renders no shadow.

App toasts never stack a duplicate: `showAppToast` with the same message, tone and scope as a visible,
non-leaving toast restarts that toast's timer, bumps its count (a quiet `×N` badge at the right edge,
with equal padding on both sides so the centred text never moves, plus an sr-only "N times" so the
live region re-announces) and plays `playRepeat` (`AppToast.tsx`): a WAAPI 360 ms scale 1 to 1.035
settling on `--aura-spring-bouncy`, a `--lg-lift` flash to 0.08 and a faint halo carrying the
glass list. Reduced motion keeps the lift and halo only; a repeat during the entry flash skips the
scale. Toast colour is the THEME accent, never a fixed blue: the entry flash keyframes use
`rgb(var(--ln-accent-rgb) / a)` and `playRepeat` reads `--ln-accent-rgb` off the toast when the bump
starts (`haloRgb`), so a theme switch is honoured; only a `danger` toast glows red. Default and
success toasts carry NO coloured hairline (no `.aura-glass-tone-accent` / `-success`): the accent
ring read as a persistent line of theme colour round the toast ("would look better if it weren't
there"; measured on Ember, Frosted outer ring 99,62,29 over a page of 16,12,8, Liquid inset ring
91,70,51 against a 45 neutral rim), and the neutral glass edge already defines the shape. A
`danger` toast keeps its faint red `.aura-glass-tone-danger` hairline (semantic, not the accent).
The same holds for every toast-like surface (round 8): `PartyToast.tsx` and `FlyUpToast.tsx` carry no
accent or green ring on a default or success toast and play an entry flash in the theme accent
(`aura-party-toast-flash`, 560 ms, beside the slide; `aura-flyup-flash`, 960 ms, peaking with the pop
at about 290 ms), keyframes in `rgb(var(--ln-accent-rgb) / a)` carrying `GLASS_SHADOW` (exported by
`AppToast.tsx`) in every frame; a FlyUp error keeps its red hairline and flashes red, a party host
change (`leader`) keeps its faint amber `.aura-glass-tone-warning` hairline (the crown's colour) and
flashes amber. A FlyUp success keeps its `text-emerald-100` label. The in-player party pill's "stream
selected" pulse (`aura-party-attention`, `PlayerPartyHud.tsx`) swells an accent halo and 1 px ring
from a NEUTRAL rest (no accent border) and carries the glass list; it stays `.aura-glass-player`
(material only). `.aura-glass-tone-accent` / `-success` (`styles/glass-misc.css`) are now unused and
kept only for a surface that needs a persistent tone ring. Never a hard-coded `rgb(91 164 255)` (the
Mica accent) for a toast glow: read the token. The host keeps its list in a synchronous model (two raises in one tick still merge) and
evicts a leaving toast first, else the stalest raise, clearing its timer.
Screen readers: AppToast, PartyToast and FlyUpToast are NOT live regions themselves. Each host renders
an always-mounted sr-only `role="status"` region (plus a `role="alert"` one for danger) through
`useLiveAnnouncer` (AppToast.tsx), even with no toast showing, and writes it on every raise and bump
("message, N times"): cleared, then written 60 ms later, raises inside that beat joined so none is lost.

Box-shadow lists keep ONE shape in every state, so state changes interpolate: a bound element's
`--lg-edge` is `--lg-meniscus-clear` (the meniscus at zero alpha, App.css `:root`), never `0 0 #0000`.
A state ring must have the same inset / outer shape as its rest value (the Liquid search shell and
`.aura-glass-field` rest at `inset 0 0 0 1px rgb(255 255 255 / 0)`). An inset entry against an outer
one does not interpolate and snaps. The twin keeps the list shape, but the bind / unbind swap itself
is SNAPPED, never faded: the filter's meniscus, caustic and hairline change in one `url()` swap, so
`liquidGlass.ts` `snapEdge` (called by `clearFilter` and `bindEntry` on every swap) finishes the
box-shadow and border-color transitions the swap starts. Faded, an unbind showed a flat, too bright
face for about 100 ms and a rebind a doubled, too dark meniscus for about 150 ms (the "bottom
highlight vanishes during the animation" report: every motion unbinds on purpose).

The Liquid CSS face's 1px border ring on FLOATING glass (`.aura-float-glass`, `.aura-glass-control`) is
`--lg-face-ring` (four sides, darkest at the bottom), never transparent (flat in-page controls are never
bound and take `--lg-spec-ring` instead, see "The specular rim" below): inset box-shadows paint only inside the padding box, so a transparent ring showed the
bare face as a crisp bright line along the bottom, about +100 levels over the bound edge on a light
page, permanent on the never-bound flat pills and smeared by their press spring. A bound element
keeps `--lg-border-c: transparent` (the filter draws its own hairline); that rule sits after the
Liquid selected / choice rules so no state brings the ring back while bound. A new Liquid state
rule that sets `--lg-border-c` uses `var(--lg-face-ring)` on floating glass and `var(--lg-spec-ring)`
on a flat control, never `transparent`. The paint rule sets
`border-width` / `border-style` / `border-color` as longhands because the `border` shorthand cannot
take a four-colour var. A face with the ring takes `--lg-meniscus-ringed` (the meniscus with its 0.5px
inset hairline at zero alpha), never `--lg-meniscus`: the ring IS the filter's one outer hairline
pixel, and the inset hairline drew a second dark line one pixel inside it, about 20 levels darker
than the bound face, which snapped away at every rebind (the search bar's "sudden change at the top
half" after its shrink). `--lg-meniscus` with the hairline was only on the borderless nav pill
(`.aura-glow`), which the left rail replaced (round 9); nothing paints it now.

### The specular rim (Liquid controls, the iOS 26 look)

Liquid in-page controls once read as dark rubber slabs ("buttons like this still don't quite hit the
mark", 2026-11-19, the Settings "Default Metadata Provider" select): a dark face ring and meniscus gave
them a dark bottom OUTLINE (19 against a face of 40 on a Haze Settings card) and no light at the edge,
and over a lighter page the face sat below its surroundings (69 vs 71, bottom edge 38). iOS 26 Liquid
Glass is the opposite: a luminous, low-tint face, a crisp specular rim brightest on the top-left and
bottom-right arcs, a soft inner glow, a soft wide drop. So, Liquid only (Matte is pixel-identical,
measured):

- `--lg-spec` (`html[data-glass="liquid"]`, App.css) is TWO inset entries offset in opposite diagonals
  (`0.6px 1.1px` white 0.36, `-0.6px -1px` white 0.20, blur 0.5, spread -0.25). A band offset (dx, dy)
  is `dx*|cos| + dy*|sin|` thick around a curve, so the light peaks on the top-left / bottom-right arcs,
  runs along the top and the bottom, is dimmer on the sides and fades to nothing on the top-right /
  bottom-left arcs. Keep it two entries: every list that holds it keeps one shape in every state.
- Flat (`.aura-glass-flat`, pill dropdowns, chips, the select): `--lg-edge` = `--lg-spec` + a soft
  inner glow (`inset 0 0 8px -2px` white 0.07) + a faint low pool (black 0.10): four entries, like the
  meniscus it replaced. Face: sheen `--lg-flat-sheen-top` / `-bottom` over tint 0.26 to 0.34, so it
  rises over a dark page (round 6: sheen 0.125 to 0.105, Haze card: face 47 vs 22 around, top rim 94;
  light stand-in: 78 vs 71). Round 13 (the user: the Theme dropdown and accent chip greys are "just
  slightly too light") darkened the sheen to 0.083 to 0.069 (App.css `html[data-glass="liquid"]`, also
  read by a checked `.aura-glass-choice`): the dropdown face L* 19.6 to 15.5 on Haze (-21%), 24.7 to
  21.0 on Mica (-15%), 18.2 to 13.9 on Ember (-24%); hover still lifts it about 2.3 L*, white 0.55
  text keeps 5.0:1 or more. Matte unchanged (scratchpad `r13/surfaces`, `flat.cjs`). Every flat
  control shares the tokens (buttons, selects, chips, tone variants), so it stays one tier; the field
  well and segmented track were already darker than the sheet and are untouched.
  Border `--lg-spec-ring`: a faint lit ring, a touch dark at the bottom. Drop `0 1px 2px` 0.16 +
  `0 6px 18px -6px` 0.30 (two entries). A checked `.aura-glass-choice` restates the same face and ring.
- Floating controls (`.aura-glass-control`) no longer take `--lg-spec` (round 9): their face is the A
  control tier (next section) and their edge the idle rim. Menus get no spec rim either.
- Tinted tones: an even wash and a faint pool (`--lg-ring` pool 0.30, hairline 0.14-0.16, was 0.7-0.8
  and 0.18-0.2) for `.is-primary`, `.is-danger`, `.is-warning`, `.aura-chrome-warn`; their labels are
  lifted toward white in Liquid (primary accent 60% + white, danger `rgb(254 194 201)`, a selected chip
  accent 70% + white), because the lighter face dropped an accent label's contrast on a light page.
  An idle chip's `text-white/55` is white 0.70 in Liquid (a `:where` rule, so a hover utility wins).
- `.is-cta` / `.is-cta-danger` take the rim but KEEP the old meniscus's two dark insets: white on a
  light accent is already under 4.5:1 (Haze about 3.2, a pre-existing gap) and the lighter flat edge
  lowered it further (3.24 to 2.92). Every `.is-cta` label is `text-ln-accent-ink` (ConfirmDialog,
  DownloadsClosePrompt, ScrobbleClosePrompt, LinkLoginModal, UpdatePopup, AddonsView), never white or
  `text-black`; `.is-cta-danger` keeps white.
- `.aura-glass-field` stays a sunken well, shallower (black 0.18 to 0.12, top inset 0.30) with the
  bottom-right half of the rim on its lower lip.
- Contrast, measured at the face beside the label (probe in the session scratchpad: Haze, Amethyst,
  Ember and a light lavender stand-in page of about 71): every label at or above its old value except
  neutral text, which stays at 6.1:1 or more (the select 11.7 to 10.6 on Haze, 7.0 to 6.3 on the light
  page). Re-measure on a light page before lightening the flat face further; accent labels are the
  first to fall.
- High Contrast keeps its `!important` 0.35 edge over `--lg-spec-ring`.

### The A control tier (round 9, the user's "Obsidian" pick)

The user compared the round 8 mockup's directions and dialed Direction A with "your iOS 26" tokens:
tint 0.30 (neutral rgb 14 16 22), blur 20 px, saturate 130%, an EVEN white lift of 0.02, shadows
`inset 0 0 22px` white 0.012, `0 1px 2px` black 0.3, `0 18px 48px` black 0.55, no milky vertical sheen,
no dark bottom pool. In Aura that is the Liquid CONTROL tier (`.aura-glass-control`: the rail, the Home
search bar, hero arrows, detail floating buttons, HUD tabs), in the tokens liquidGlass.ts bakes, so bound
and unbound match:

- `--lg-ctl-blur` 20px, `--lg-ctl-sat` 1.3, `--lg-ctl-bright` 1, `--lg-ctl-sheen-top` / `-bottom` 0.02,
  `--lg-ctl-tint-rgb` 14 16 22 at `--lg-ctl-tint-top` / `-bottom` 0.30.
- `--lg-ctl-meniscus-k` 0 (no baked meniscus) and `--lg-ctl-hairline-k` 0 (no baked dark outer hairline;
  liquidGlass.ts reads the hairline strength per tier now, falling back to `--lg-meniscus-k`).
- NO lensed rim band since round 16 (the caustic pickup; "The A face is flat to the hairline" below):
  `--lg-ctl-rim` 0 (round 9: 0.3, an even band all round with `--lg-ctl-rim-pool` 0; round 5: 0.55 pooled
  low) and `--lg-ctl-pickup-blur` 20px, the tier blur (round 9: 12px, 0.6 x the tier blur, the mockup's
  rim blur), so the whole 20 px blur runs in the CSS chain and the filter adds no blur pass.
  `--lg-ctl-rim-pool` stays (1 pools a band along the bottom, 0 keeps it even; it shapes only a band a
  nonzero rim would draw).
- CSS face: `--lg-face-ring: transparent` on controls (no meniscus left for a bare border pixel to
  contradict), `--lg-edge` = the one inner glow entry bound AND unbound, at ZERO alpha since round 17 (was
  white 0.012: "The A face is flat to the hairline" below), `--lg-drop` the A pair plus a zero
  third entry (the three-entry shape).
- Edge definition is the idle rim (the cursor light, below), which stays with Cursor glow off.
- Menus keep the round 8 uniform body (it does not fight A); tips keep their own tokens; flat in-page
  controls keep the round 6 specular rim.

Overrides of earlier approvals, all the user's round 9 pick: round 5/6 control tokens (blur 10, sat 1.6,
bright 0.9, sheen 0.125 to 0.06 over tint 0.10 to 0.26, pickup 7px, the 0.55 pooled caustic), the round 6
`--lg-spec` rim and meniscus on floating controls, the dark `--lg-face-ring` on controls, and the softer
control drop. The search bar keeps its solid base (`data-glass-base`) and its sliced lens; text behind it
now blurs at 20px. It takes NO hover or focus lift in Liquid (`--lg-lift: 0`, glass-search.css): the
generic control hover lift brightened its whole face evenly, even 300 px from the pointer, and the
mockup's A face never lifts; the cursor light and the focus hairline are the feedback. Its placeholder
is white 0.75 (Layout A; 0.40 measured about 3.2:1 against the face).
Its contact shadow is pulled in from the ends (2026-11-23; the user: "a feint black line on the left
side of the bar", seen after unfocus but present at rest too): the tier's `0 1px 2px` black 0.30
lay just outside the whole outline, so beside the rounded ends it was a thin dark line, up to 15
levels under the page, two device px on whichever end a 125% layer offset favoured (ablated: the
entry alone; the bleed hole and corner patch changed nothing). glass-search.css sets
`0 3px 2px -2px` black 0.30 (same three-entry list): the straight bottom is pixel for pixel the old
underline at 100 / 125 / 150% on a mica and a light page, the ends match no contact shadow within
0.5. The bottom arcs keep a lighter crescent and the rail, arrows and other controls keep the tier
shadow; the user left the curved sections as they are (zeroing the entry, or capping the hero
vignette at 0.45 past 70%, would clear them, at a cost to the look). Scripts: session scratchpad
`h/` (`abl.cjs`, `bot.py`, `blur2.cjs`, `prof.py`). That was only the line at rest at a 1600 px
window; the brief one right after unfocus at other window widths was HeroBleed's cut during the
width morph (see "The corner patch" under the hero bleed, 2026-11-24).

THE A FACE IS FLAT TO THE HAIRLINE (round 16; the user, Clear only: "the same light band in most of the
glass elements on the clear style specifically, especially against lighter background colors, like in
this arrow of the hero item and around the menu bar"). The band was the control tier's caustic pickup:
a raw sample of the backdrop at the 12 px pickup blur, saturated 1.6, lifted 1.25 and softclipped, laid
at 0.3 over the face in a band from the edge to about 29 px in (full from about 10 px). The body under
it is tinted and blurred further, so the band was lighter and more saturated than the face exactly
where the face meets the hairline, and the lighter the page, the brighter it read. Measured (scratchpad
`r16/band`: Home with the warm hero art and its bleed, pointer out of the window, surface contents
hidden, luma per device pixel inward from the left and right edges; RISE = the peak 3 to 28 px in minus
the first pixel inside the hairline; pages Mica, Ember, a bright stand-in (Ember with `--ln-bg` rgb 150
112 96) and a light one (Mica with rgb 196 184 178), at 100% and 125%), before / after:
  - Rail: rise +5 to +6 Mica, +13 bright, +9 to +10 light, 0 Ember (its page is too dark to show it) /
    0.4 or less everywhere. Bound minus its CSS face (unbound, `data-liquid="off"`): +1.6 to +3.5 /
    within 0.7.
  - Home search bar: +4 to +6 Mica, +12 bright, +9 to +10 light / 1.7 or less. The band covered the
    whole 42 px bar, so its bound face sat +4 to +10 over its CSS face / within 1.0 (the old bind /
    unbind lower-half shift went with it).
  - Hero arrows (44 px circles over the art): +4 to +6 and a saturated ring (chroma |R-Y| + |B-Y| +20
    to +26) / no rise, chroma +3 or less.
  - Notifications sheet (menu tier, no pickup since round 8): no light band before or after, unchanged.
Ablated one at a time (bright page, bound): `--lg-ctl-rim: 0` alone removed the whole band (rail right
side 96 at 1 px, 108 at 8 px, 95 at 27 px became 95 to 96 flat; equal to the unbound face).
`data-liquid="rim"` (no displacement) and `--lg-refract` near 0 changed nothing, nor did removing the
bleed cut-out under the rail (the blur sampling the lighter page past the edge is not a visible term).
The `--lg-bleed` face layer moves the whole face evenly (-4 without it), the 22 px inner glow under 1
level, the idle rim only its hairline pixel; the drop shadow darkens only the page OUTSIDE (the dark
line beside the hairline). Refraction, the blur, the bleed face, the idle rim and the cursor light are
untouched. Overrides the user's round 9 A pick for exactly two tokens (App.css): `--lg-ctl-rim` 0.3 to
0 and `--lg-ctl-pickup-blur` 12px to 20px. (Round 16's metric called anything under 2 levels "no band";
round 17 below found the rest.) Never give the control tier a pickup back, as for menus: any
raw backdrop sample along the edge reads as a light band over a light page. Performance: each control
filter falls from 13 primitives to 6 (the sliced search bar 30 to 23: no pickup branch, no in-filter
blur; the same images, so the per-frame image cost is unchanged); interleaved A/B on Home with the
pointer sweeping the hero, 76 / 90 / 89 fps against 68 / 77 / 85 with the old tokens (`perf.cjs`).

ROUND 17: NO INNER GLOW EITHER (the user, Clear, after round 16: "I still notice the clear light band in
the app on some surfaces, primarily the menu bar, settings panels, and the search bar. Is it not
possible to get rid of it entirely without compromising some of the glass effect?"). The strict metric
now: any monotonic edge-to-interior ramp of 0.5 level or more, in luma OR any one channel, over 3 or
more device pixels, from the first pixel inside the hairline to the centre (round 16 counted only rises
over 2 levels). Ground truth, the user's screenshot of the Home search bar (45.png, 100%, after round
16; profiles averaged over 26 rows / 800 columns): every side's face falls from the hairline to the
centre, left cap 52.9 to 51.0 over 16 px, right cap 53.3 to 51.4 over about 30 px (B 83.2 to 79.8),
bottom 52.0 to 50.5 over 15 px, top 50.8 to 50.3, all three channels at once (a white lift, not a hue
shift). The band was the A tier's `inset 0 0 22px` white 0.012 inner glow (round 9's A pick): it lifts
the face by 0.006 x (255 - face) at the hairline (about 0.009 on a pill's rounded cap, where more of
the blur lies outside) and fades over about 20 px, and the 8-bit composite turns it into a +1 level step
(+2 where two sides add, in the corners) about 10 CSS px inside every edge of every control-tier face:
the rail, the Home search bar, the hero arrows, the Detail floating buttons, the HUD tabs, every SHEET
(they are the A face with no backdrop pass, so the Settings sections had it too) and the player face.
The rail's active pill and every copy of its face (the selected sheet, History, Detail, HUD tab and
player rows) had the same in small: `inset 0 0 12px` white 0.015, +1 to +2 over the first 5 px.
Measured (scratchpad `r17/band`: `cap.cjs` captures, `ana.py` / `band.py` / `dsum.py` per side and per
channel averaged over every row or column clear of the corners, surface contents hidden; headless
Chromium on the real D3D11 GPU (ANGLE, hardware compositing: the WebView2 path); Mica, Ember-like
red-brown rgb 62 40 42 (the user's rail page), bright rgb 150 112 96 and light rgb 196 184 178 pages;
100% and 125%; pointer out of the window, in the window about 400 px away, and near), before / after:
  - Settings rail and pill on a uniform page: +1.0 over 10 px (100%) / 12 to 13 px (125%) on all four
    sides, all channels / 0.0 from the first pixel inside the hairline.
  - Settings sheets: +1 (G, B) over 12 to 13 px / no ramp (a +-0.3 to 0.8 alternation that runs the
    whole depth is the 8-bit rounding of the translucent face, not an edge term).
  - Hero arrows: 1.4 to 1.6 over 3 (100%) to 12 px (125%) / 0.2 to 0.4, none past the hairline.
  - Home rail and search bar on a uniform page (the hero bleed off): rail 0.0 / 0.0 except the
    hairline's antialiased second pixel at 125%; the bar's residual +-1 code above and below its
    centre is the hero art under its lower half and the title-bar region, through the blur (it is
    there unbound and with no displacement, and it is not symmetric).
  - Pointer in the window but out of reach: identical to out (the idle rim's 0.62 dimming touches only
    the hairline). Pointer near: the cursor light (the interior radial spilling in from the near edge,
    the lit rim, its halo and blue fringe), unchanged and by design.
Ablated one at a time (Home, red-brown, 125%; then cumulatively on Settings): the glow is the ONLY term
whose interior shape depends on the distance to the edge. The rest, each under 0.5 inside the hairline:
refraction (`data-liquid="rim"`: 0.0 on the rail), bound vs unbound (a constant under 0.6, no edge
shape past the hairline pixel), the bleed cut-out on straight sides (`clip-path: none`: a constant shift, no edge shape; NOT on rounded ends, below), the `--lg-bleed` face
layer (the bleed image's own large-scale gradient, the same 60 to 90 px deep inside and outside the
glass), saturate 1.3 vs 1, the drop shadow (outside only; it touches the antialiased hairline pixel at
125%), the base flood, the idle rim (the hairline pixel and, at 125%, the next one). The BLUR'S EDGE is
not a term: a white block 2 px outside the rail's right edge changed no pixel inside it, bound or
unbound, so Chromium's backdrop blur never samples past the border box. But it DOES sample the whole
rectangular border box, and the bleed's cut-out is rounded like the element, so on a rounded surface
over the Home hero bleed the box corners outside the round still hold the page bleed, and the blur
pulls it into the ends. Left open by round 17 (its review, scratchpad `r17/verify`): the Home search
bar's rounded ends lifted +1.2 to +1.5 luma at 100% (+0.6 to +1.0 at 125%) over about 20 px, +2.5 to
+4 in blue, and the rail's corners up to +3.7 (R) / -2.9 (B) along the diagonal. FIXED in round 18
(the bleed's hole is the box, the element paints the corners back: "Banding under fixed glass", the
corner patch, below). Away
from the bleed (Settings, every sheet, the hero arrows, the rail's straight sides) the face is flat to
the hairline now, and nothing of the glass is given up: the blur,
saturation, tint, lift, refraction, base, bleed, drop shadow, idle rim hairline and cursor light are
untouched; what goes is a sub-2-level brightening inside the edge, which read only as the band. Both
entries keep their place at zero alpha (`inset 0 0 22px rgb(255 255 255 / 0)` in App.css, bound and
unbound; `inset 0 0 22px 0 ... / 0` as the first of the player face's four; `inset 0 0 12px ... / 0` in
the pill rules), so every list and keyframe that holds them keeps its shape. Overrides the user's
round 9 A pick for exactly these values: the control tier's `--lg-edge` white 0.012 to 0, the player
face's first `--lg-edge` entry white 0.012 to 0, and the mockup pill's inner glow white 0.015 to 0
(glass-rail.css, glass-pages.css x2, glass-detail.css x2, glass-player.css). Matte is pixel-identical
inside every glass surface (old vs new CSS through the harness's `?old=1` switch, 24 frames, Home and
Settings, three pages, 100% and 125%, pointer out and near: 0 pixels differ). Not changed (deliberate,
their own approved recipes, not A faces): the flat controls' `inset 0 0 8px -2px` white 0.07 glow of the
specular rim, the segmented thumb's `inset 0 0 10px` white 0.02, the faux frost badges'
`inset 0 0 8px` white 0.03 (both materials), and the menu tier's 0.35 meniscus.

### SELECTION in Liquid

Never an underglow, an accent ring, an accent border, an outer glow or a pulse. A slightly brighter
raised glass face (the hover material, a touch stronger) with the accent on the icon and label only.
Toggles that are on: a near-even theme-accent tint in the track (accent 0.34 to 0.44 under a faint
sheen, scaled by the registered `--lg-toggle-on` so it fades over 200 ms while the knob springs) and a
brighter neutral knob; never a full accent fill, an underglow or an outer glow. The toggle is not a
paint-rule element: its box-shadow is its own three-inset list in both states (never name
`--lg-rimlight` on it). Keyboard focus on a toggle is the `.aura-glass-toggle:focus-visible` outline
(a ring utility loses to the toggle box-shadow). Frosted keeps its accent ring / wash. Keyboard
focus on a Liquid row or item is an OUTLINE (the selection box-shadow would beat a
`focus-visible:ring` utility). The segmented thumb is the one exception to "accent on the label": its
label is WHITE and its accent is a faint accent-mark rim (next section).

### Segmented control and switch (round 12, `settingsControls.tsx`, App.css "Segmented control" / "Toggle switch")

The user's ask (screenshot of the Translucent | Glass toggle, now Matte | Clear): "Redesign toggles like these so that
they're more cohesive with the style of the glass style and interact with the cursor glow etc."

- SEGMENTED CONTROL: ONE shared component, `SegmentedControl`. Track `.aura-glass-seg` = the field
  tier's sunken well in Liquid (black 0.20 to 0.13, `inset 0 2px 5px` black 0.32, the lower-lip half of
  the specular rim, a 0.5 px white 0.05 hairline) with an idle rim 0.08 / 0.02 / 0.14 (lower right, a
  lit lip); Frosted a white 0.05 face and a white 0.10 inset hairline. Thumb `.aura-glass-seg-ind
  .aura-seg-thumb` = a raised droplet: Liquid white 0.13 to 0.095, the rail pill's idle rim 0.30 / 0.04
  / 0.16, a two-entry soft drop and a faint `--ln-accent-mark` 22% inset rim (the ONLY accent);
  Frosted the rail pill's accent wash (0.22 to 0.10) and accent 0.32 hairline. Labels: selected white,
  the rest white 0.62 (0.88 on hover). Concentric A radii from the markup: md track 12 / padding 3 /
  thumb 9 (buttons 26 px), sm 10 / 2 / 8 (24 px buttons); `--seg-pad` / `--seg-thumb-r` carry them to
  the thumb (their defaults, a 2 px pill, are a fallback only: every copy is `SegmentedControl`).
- Both track and thumb carry `data-glass-light="rim"`, so the cursor light rings them like any glass
  edge (rim only, no interior image). EVERY `var(--lg-rim-layer)` in these rules has a transparent
  fallback (`var(--lg-rim-layer, linear-gradient(transparent, transparent))`): the property is
  registered with no initial value and defined only on a light surface; every copy carries the
  attribute now, but without the fallback a copy that lost it would drop its whole background. Use
  the `background` SHORTHAND for a layer list holding it (its value carries `border-box`, invalid in
  `background-image`).
- MOTION: the thumb is CSS-sprung, translate + width on `380ms var(--lg-springy)` in both materials
  (measured: about 3% overshoot, 95% at about 150 to 180 ms), `SegmentedControl` writing inline
  `translate` / `width` from the selected button's `offsetLeft` / `offsetWidth`. The first placement,
  a ResizeObserver re-layout and a re-show SNAP (transition off for one style flush). Liquid adds a
  squash-and-settle keyframe (`.is-stretching`, scale 1.05 x 0.84 at 34%, 380 ms, restarted per
  move). Reduced motion: the existing `.aura-glass-seg-ind` entry in the reduced-motion list snaps it
  and drops the squash. Every thumb is a `.aura-seg-thumb` (AniSkipMenu's old `animateSpan` copy is
  gone); the bare `.aura-glass-seg-ind` rules are fallbacks only.
- KEYBOARD: `role="radiogroup"` with `role="radio"` / `aria-checked` buttons and a roving tab stop
  (the selected option, else the first enabled one); Arrow keys, Home and End move AND select,
  skipping disabled options. Focus is an inset outline (2 px, `--ln-accent-mark` 75%, offset -2 px,
  inside the track so nothing clips it); white on High Contrast. `fill` stretches the group to its
  parent with equal segments (the playlist form's M3U URL | Xtream Login tabs, which were hand-rolled
  `.aura-glass-item` buttons).
- SWITCH: `.aura-glass-toggle` keeps its approved look and state colours (Liquid accent tint scaled by
  `--lg-toggle-on`; Frosted white 0.15 off / accent 0.8 on, now with a white 0.06 hairline) with the
  ring layer first and, in Liquid, the well's idle rim 0.08 / 0.02 / 0.14. The Liquid knob is a glass bead: a small specular highlight
  up and left (radial 60% x 48% at 36% 24%) over the milky body, its four-entry shadow list in both
  states, and when on the lower inner shade takes the accent (0.34: light through the tinted track),
  fading with a 200 ms box-shadow transition. Frosted knob unchanged.
- ONE SWITCH COMPONENT (round 12 follow-up; the user: "Ensure the glass toggles and switches ... also
  apply to the rest of the app"). Every switch is `ToggleSwitch`; no file hand-rolls
  `.aura-glass-toggle` markup (the copies had drifted: no knob stretch, no focus ring, one with no
  light). `size`: md 40 x 24 (Settings), sm 36 x 20 (menu rows: the player menus' `PlayerMenuToggle`,
  the Detail stream formatting popover), xs 32 x 18 with a 14 px knob travel (`.aura-toggle-xs`,
  glass-misc.css: the filter menu's "Currently airing only", Library's auto-remove rows, Queue's
  "Remove started series" pill; the filter menu's was a 32 x 16 one-off). `decorative`: an
  aria-hidden span for a switch drawn inside a row or pill that already carries `role="switch"` and
  `aria-checked` (the owner keeps the click, Space / Enter and its row look; roles never nest). Every
  copy carries `data-glass-light="rim"`, over the video too (the player is material only: the track
  has no backdrop pass, the light is a ring). Keyboard focus on the owner rings the SWITCH
  (`[role="switch"]:focus-visible > .aura-toggle-deco`, the Settings outline) and drops the owner's
  own outline and ring utility (`:root [role="switch"]:has(> .aura-toggle-deco):focus-visible`), so a
  switch row shows one focus mark, the same as a Settings switch. AniSkipMenu's skip modes are
  `SegmentedControl` (md) inside the player face: glass-player.css already gives its labels the
  player colours. Verified in the harness (scratchpad `r12f/switches`), both materials, pointer near
  (every track lit) and keyboard focus; Space / Enter flip the owner and restart the knob stretch,
  Arrow / Home move the AuraSkip thumb. Review pass (scratchpad `r12f/review`) over a WHITE frame:
  player switch row labels about 10:1, AuraSkip row labels about 10:1 and its idle segment labels
  5.2 to 6.8:1 in both materials (a disabled row's segments sit near 3:1 at the disabled 0.6
  opacity, as before); no element nests an interactive role inside a `role="switch"`.
- NOT switches (left as they are, swept 2026-11-22): the checkboxes (History's `SelectBox`, the
  service status provider rows, Settings > Backup's native "Include my API keys"), the `aria-pressed`
  chip sets (`.aura-filter-chip`: FilterBar status / sort / year, `MediaTypePills`, ArcGrid's
  wrapping grouping switcher, the hero backdrop picker, the accent swatches, the Perf Monitor's line
  chips, AniSkipMenu's vote arrows), CatalogPicker's scrolling catalog pills, the player bar's Fill
  Screen button, the onboarding theme grid and stepper, the Detail HUD tab bar (`role="tablist"`).
- High Contrast: track and switch keep the 0.35 white inset; the thumb takes a 1.5 px white 0.70 inset
  so it stands out of its track; idle rims are 0 there by `--lg-idle-k`. The Matte (Frosted) ON knob
  takes an inset 1.5 px black 0.75 edge (a white knob on the yellow / cyan track measured 1.5 to 2:1);
  the Liquid knob is unchanged (its on-track is a dim tint, and a three-entry list would snap its 200 ms
  box-shadow transition).
- A very light CUSTOM accent (WCAG luminance 0.6 and up, `isLightAccent` in `accentColor.ts`;
  `themeAccent.ts` sets `<html data-accent-light>`, index.html's pre-paint script too from the cache's
  `l` flag): the Matte ON knob takes an inset 1 px black 0.65 edge (App.css, beside the Frosted switch
  rules). Measured (scratchpad `r14/knob`): a white knob on the Matte track was 1.64 to 1.99:1 for
  #f5f5f0, #fff3a0, #ffff00, #e0e0e0, #fde68a, #a7f3d0 (the lightest built-in, Ocean, is 2.65:1); the
  edge is 3.3 to 4.1:1 against the track at 100% and 150% scale. 0.6 sits above every built-in accent
  outside High Contrast (Ocean 0.53) and below the two High Contrast accents (0.61, 0.75), which already
  had their edge. The attribute is never set for a theme's own accent: every built-in, both
  materials, stayed byte-identical in the harness. On High Contrast the stronger 1.5 px 0.75 rule wins
  (same specificity, later). Liquid needs nothing: its on-track is a dim tint over a dark well, so the
  knob measured 4.1 to 4.6:1 there with the same accents, and it is unchanged.
- Cost: each switch and each segmented track and thumb is a rim-only light candidate (about 0.03 ms of
  recalc each when lit). Settings mounts about 60 switches; only those within reach of the pointer are
  lit (at most 64 surfaces), and the transparent-skip keeps a hidden thumb (opacity 0) out.

## Backdrop roots: the dialog trap

An element with `backdrop-filter` samples only up to its nearest Backdrop Root. ANY ancestor with
`backdrop-filter`, `filter`, `opacity < 1`, a mask or a clip-path is one. A glass card inside a
`bg-black/60 backdrop-blur-sm` scrim wrapper therefore blurs and bends a flat black image. Dialogs
render the dim + blur as a SIBLING layer (`<div aria-hidden className="aura-modal-backdrop-in
absolute inset-0 bg-black/60 backdrop-blur-sm" />`), keep the centring wrapper free of filters and
opacity animation, and fade the sibling. `ConfirmDialog.tsx` is the reference. The same applies to a
glass button nested inside a glass panel: use `.aura-glass-flat` there (no backdrop pass).
The Home search focus dim (`SearchBar.tsx`) is a 0.7 black dim with NO blur, so the bar refracts the
real page.

A FINISHED opacity animation that still fills (`both` / `forwards`) keeps its element a Backdrop Root
forever, even at opacity 1. `.aura-view-enter` (the wrapper of every view) once held `both`: every
glass surface in every page then sampled only the view's own pixels, never the opaque `--ln-bg`
behind them, and over that transparent backdrop the blur came out mostly transparent with the crisp
page showing through it. Poster titles (text on nothing) read sharp through the Home search bar while
the opaque posters blurred (measured: max luminance swing from the titles under the bar 164 levels
held, 44 with `backwards`). An enter animation on a wrapper that holds glass fills `backwards`; its
`to` frame is the base style, so nothing visible changes.

## The solid base under the blur (Liquid, over page content only)

The window is transparent, and Chromium draws a backdrop-filter's filtered result OVER the
unfiltered content behind the element. Wherever the page behind a glass surface is see-through
(Mica: `--ln-bg` transparent; Haze: alpha 0.45), a see-through blur let the CRISP page show through
it: poster titles read sharp through the Home search bar while the opaque posters blurred. Measured
with `omitBackground` (max per-pixel gradient of the titles' contribution under the bar): Mica 130,
Haze 29, against about 15 over an opaque page. So Liquid glass that page content can move under
stacks an OPAQUE base INSIDE its backdrop filter: `url(#aura-glass-base)` right after the tier blur
in its `--lg-backdrop` chain (App.css), and the same two floods baked into its `liquidGlass.ts`
filter at the same point (after the body blur, before displacement, saturate and brightness), so
bound and unbound match (measured within 2.2 levels top / bottom on the search bar). The filter
(`glassStyle.ts` `installGlassBaseFilter` / `glassBaseNodes`, installed before React mounts whatever
the material) floods `--lg-base-under` (the window estimate `--lg-window-est`, dark Mica `#202020`),
then `--lg-base-page` (`--ln-bg`) over it, then merges the blurred backdrop on top. After it: Mica
15, Haze 18, posters still blur through (mean change under the bar 46 levels, soft), opaque themes
pixel-identical.

WHICH surfaces take it (an explicit opt-in; App.css chains and `liquidGlass.ts` `BASE_SELECTOR`,
part of the filter key, must match exactly):

- The Liquid menu tier, always: every `.aura-float-glass` that is not a control (menus, context
  menus, popovers, dropdowns, panels, dialogs, tips and toasts all open over page content).
- A Liquid control ONLY with `data-glass-base` (`.aura-glass-control[data-glass-base]`): today the
  Home search bar (`SearchBar.tsx`), the detail page's floating Back / Close (`DetailView.tsx`) and
  SourcePopup's fixed restore pill. A new control that page content scrolls under (sticky or fixed
  over a scroller) adds the attribute; `liquidGlass.ts` watches it (MutationObserver filter).
- NOT the left rail (`.aura-rail`: page content never scrolls under it), hero
  arrows, HUD tabs, detail toggles or any other chrome or control on static art: nothing moves under
  them, and the base only swapped the real Mica for the estimate (reported "a bit dark especially on
  lighter themes"; measured on a lighter Mica stand-in: pill 44.9 against 45.6 around it with the
  base, 58.6 without, so it now follows the backdrop).
- NEVER Frosted (Matte): its chain is the plain `blur(--ln-blur-elev) saturate(1.6)` again,
  measured identical to the pre-base run (so titles show through the Frosted search bar on Mica
  again, crisp metric 63 as before: the user's call, the base is a Clear-only look).
- Not `.aura-glass-player` (no backdrop).

Rules:

- NEVER a CSS background for this: it paints ABOVE the filter output and would hide the blurred
  posters as well. The base must be a filter step.
- The colours are CSS `flood-color: var(...)` on the in-DOM filter, and Chromium repaints every
  referencing backdrop when the tokens change (measured, bound and unbound), so the filter registry
  is not keyed by theme. A missing filter element degrades to the old see-through blur.
- The estimate: lib.rs applies DARK Mica on every theme, and dark Mica's luminosity layer pins its
  brightness near its `#202020` tint whatever the wallpaper (only the hue follows the wallpaper), so
  `--lg-window-est` stays one value. It only shows on Mica and Haze: every other theme's `--ln-bg` is
  opaque and covers it (measured pixel identical with and without the base). A theme with a
  see-through `--ln-bg` over some other backdrop sets its own `--lg-window-est`.
- Accepted cost: the wallpaper / Mica hue no longer shows inside those surfaces.
- `html.playing-video` sets both `--lg-base-*` tokens transparent: the page is hidden then and every
  surface left (toasts, tooltips, menus) floats over the mpv video, which the base would cover with a
  grey slab. A new state where glass floats over something that must show through does the same.
- A new Liquid surface over page content that sets its own `backdrop-filter` (not through
  `--lg-backdrop`) needs the `url(#aura-glass-base)` step after its blur, or titles read through it on
  Mica.

## Liquid refraction: the filter registry (`src/liquidGlass.ts`)

Runs ONLY while Liquid is drawn on a blurring theme; switching to Frosted disconnects everything,
unbinds every element and drops every filter.

- Discovery: one MutationObserver on `<body>` (childList + `class` / `data-liquid` /
  `data-glass-base`) finds
  `.aura-float-glass` (not tips, not player) and `.aura-glass-control` (`.aura-glow` in
  `BIND_SELECTOR` is a dead entry since the rail; the rail pill is never bound); one
  ResizeObserver sizes them (`borderBoxSize`, no layout reads). `data-liquid="off"` opts an element
  out (it keeps the CSS face, just no lens: CatalogHoverCard, a page-wide History bar, the Watch Party
  panel over the player), `data-liquid="rim"` keeps the face (plus a pickup on a tier whose rim is above 0: none today) without displacement, any other
  `data-liquid` opts an element in.
- One SVG filter per (tier, lens, base, size rounded up to 2 px, radius), shared by every same-size
  element. Each bakes the body (blur to the tier blur, displace, saturate, brightness), the face
  (tint, sheen, meniscus) and, on a tier whose `--lg-<tier>-rim` is above 0, the caustic pickup (the raw
  sample at the tier's pickup blur; saturate 1.6, softclip, masked by the rim band). NEITHER tier has one
  today: the menu tier since round 8 ("The menu body"), the control tier since round 16 ("The A
  control tier"; it had 12 px since round 9, 7 px before). All of it goes into the element's one `backdrop-filter`, because a second backdrop layer inside the
  element would only sample the element. The caustic rim band fades on a rounded distance
  (`sdRRSoft`): on the plain rounded-rect distance it has a cusp on the centre line of any element
  thinner than band * 3.2, which read as a faint dark line through the search bar and nav pill. The
  body blurs on from the pickup blur to the tier blur in quadrature (ctl 20 px: 12 + 16 in round 9, round 5 10 px: 7 + 7.1; since round 16 the control tier's pickup blur is its tier blur too; the menu
  tier's `--lg-menu-pickup-blur` IS its tier blur, 22 px, so its filter adds no blur pass), and that
  blur is used as is: NEVER composite it `over` SourceGraphic. An over adds the
  alpha of two copies of the backdrop, so over Haze's see-through page (`--ln-bg` alpha 0.45) a bound
  surface came out more opaque than its CSS face (menu alpha 0.934 vs 0.879, search bar 0.893 vs
  0.789): every menu read clearly darker once its pop settled and bound. Over an opaque backdrop it
  changed no pixel, even at the viewport edge (Chromium feeds the filter the backdrop beyond the box,
  so the blur never fades out at the border). Test a filter change over a SEMI-TRANSPARENT backdrop
  (screenshot with `omitBackground`), not only an opaque one. HISTORY (round 5; the current control tier is
  20 px, the user's round 9 A pick, with no pickup since round 16, see "The A control tier"): the control tier was 10 px, MEASURED (word-shape band energy of poster titles under the
  Home search bar, relative to the bar's own placeholder): at 5 px / 4 px pickup it was 0.23 to 0.30,
  so known titles stayed readable by word shape; at 10 / 7 it is 0.07 to 0.10 (soft coloured blobs)
  and the rim still bends colour; 16 px smeared the bend away (do not go there; 12 / 8 is the
  fallback). A sharper pickup brings the detail back (it sits under the placeholder's lower half), and
  a darker veil, a stronger sheen or `--lg-refract` 3 measured no gain. GPU frame cost was flat from
  5 to 16 px (Skia downsamples large blurs); menus stay dense at 22 px. Matte (frosted 64/96
  px) is unchanged.
- Cache: hard cap `CACHE_CAP` (40), LRU, only unreferenced filters evicted, at most `KEEP_BIG` idle
  large ones kept. Elements over `MAX_AREA` (360k px) or `MAX_SIDE` are never bound (CSS face), except
  a width-morphing box that takes a sliced filter (next bullets): its canvas is only 2E + 1 wide, so
  its width is bounded by `SLICE_MAX_W` (4096) and `MAX_AREA` instead.
- Builds never run in a ResizeObserver callback: a new size is queued and built in idle callbacks
  (one per callback minimum, then while idle time remains); maps over `RES_AREA` are built at half
  resolution. A job nobody waits for is dropped. Until bound, App.css draws the same face in CSS (with
  the `--lg-face-ring` border standing in for the filter's outer pixel), so binding is an upgrade,
  never a pop from nothing. The caustic band has NO CSS stand-in and cannot have one: it is a sample
  of the backdrop (a CSS background cannot sample it, and a CSS-chain step would sit under the face),
  so a swap between the CSS face and the lens on a VISIBLE, still surface shows as its lower half
  shifting (measured over a bright page: search bar lower half 8 to 12 levels mean; the old menu lower
  half 6, its last 30 rows 14; top halves within 1.5). Menus have no caustic any more, so their swap is
  within 1 level (0.7 to 0.8 mean, last 30 rows 0.7, outer pixel within 1.8 per side); nor have controls
  since round 16 (bound minus CSS face within 1.0 on the rail, search bar and hero arrows). Visible surfaces
  therefore avoid the swap rather than hide it: a width morph keeps a sliced filter bound (next bullet), a pop binds an already-built
  filter from its first frame (`holdLensDuringPop` below).
- Sliced filters (width-morphing glass only, `MORPH_SELECTOR` = `.aura-glass-morph-w`, today the Home
  search bar): ONE filter per (tier, lens, base, height, radius) that covers every width from
  `sliceMinW` (2 x (E + `CAP_PAD`) + 2, so the caps never overlap) up to `SLICE_MAX_W`, so the bar
  stays bound through its width spring and `holdLensForMorph` is a no-op on
  it. Built from a 2E + 1 wide map (`sliceSpan`: past E from either end every map and shade pixel
  depends on the row only) cut into THREE pieces per image (round 11, `slicePieces`): the left cap
  (columns 0..E, then the middle column `CAP_PAD` 4 more times) pinned to the box's left edge with
  `xMinYMin meet`, the right cap pinned right with `xMaxYMin meet` (never scaled: the explicit height is
  the image's own; the filter region's x / width are the border box, `objectBoundingBox` 0 / 1, and an
  feImage with no x / width takes them), and the 1 px middle column stretched across (`none`). They are
  summed with disjoint weights that add to 1: the map caps' ALPHA is the weight (1 over the cap, then
  1, 1, 0.5, 0 over the pad; the map is opaque, so its alpha was free), each cap is taken `in` it, the
  middle `out` of both, and the shade uses the same map-cap alphas. The hand-over happens only inside
  pixels that are the same column in every piece, and a cap's inner image edge sits where its weight is
  already 0, so it draws nothing on a fractional device pixel. That is the edge rule: NEVER an image
  edge inside the box WHERE THE IMAGE STILL HAS WEIGHT (a cap pinned on its own at width - E, any cap
  under a scale transform or a 125% display, drew a bright line along the caustic, about 6 levels at
  fractional widths). In a backdrop-filter a percent subregion draws nothing and `objectBoundingBox`
  primitive units scale the blurs with the width (both measured), so edge pinning is the only way.
  Measured against the old two-piece slice (search bar crops at rest, focused and at a forced
  fractional width; 1600 x 900, 2575 x 1038, 3440 x 1380 and 2060 x 830 at 125%): within the 2-level
  run-to-run noise everywhere. WHY (round 11, performance): a backdrop-filter's reference filter is
  re-sent to the GPU process with EVERY frame the page draws, its feImage bitmaps included, so its cost
  is per image pixel per frame (microbenchmark: about 0.37 ms of renderer compositor time and 0.43 ms
  in viz per 100k image pixels per frame). The old slice was four 1536 x 42 images (258k px) for the
  Home search bar: about 3 ms + 1.5 ms of every frame, which alone held an otherwise idle Home at 120
  fps on a 240 Hz display. The caps are 46 x 42. Keep every bound filter's images small; the same
  per-frame cost applies to each visible bound element (the rail's half-resolution maps are 2 x 102 x
  365, about 1.2 ms). NEVER cap a slice (or the box it
  serves) at `MAX_SIDE`: the bar's focus width is `--hero-max-w`, up to 1773 px, so on a large window
  (2560 x 1380: rest 1206, focus 1773) a `MAX_SIDE` cap unbound it for the whole focus and rebound it
  at the end of the shrink, the very bottom-half shift the slice removes (measured: 206 of 212 focus
  frames unbound before the fix, 0 after; seams at 1206 to 1880 px as clean as at 800).
- Tunables are CSS custom properties on `:root` (`--lg-ctl-*`, `--lg-menu-*`, `--lg-refract`,
  `--lg-rim`, `--lg-rim-lift`, `--lg-meniscus-k`, `--lg-ctl-pickup-blur`, `--lg-menu-pickup-blur`).
  After editing them live, run `window.__auraLiquidRetune()` in the DevConsole to rebuild the
  filters.
- The caustic pickup's opacity is per tier: `--lg-<tier>-rim`, falling back to `--lg-rim` (0.55). Both
  tiers set 0: the menu tier's `--lg-menu-rim` since round 8, the control tier's `--lg-ctl-rim` since
  round 16 (0.3 in round 9), and at 0 `makeFilter` leaves the pickup branch out. Never give either a
  pickup back ("The menu body" below, "The A face is flat to the hairline" above).
- Per tier also: `--lg-<tier>-tone` (a tone map after the brightness, `none` for none) and
  `--lg-<tier>-meniscus-k` (the baked meniscus strength, falling back to `--lg-meniscus-k`; the outer
  hairline keeps the global strength).
- `animateSpan` (two springs, leading edge fast, trailing slow) moves sliding indicators. It writes
  the individual `translate` property plus width / height inline, never `transform`, so any CSS
  transition on a span target names `translate`. In Liquid a span target transitions NO translate,
  width or height (the springs write every frame): a flight leaves the inline `transition` alone,
  because blanking it would cancel the target's running opacity / scale transitions (the droplet's
  grow) and jump them to their end. Options: `snap`, and `spring: "hover"` (the
  snappier, bouncier pair for hover droplets: lead k900/c36, trail k560/c32). The rail pill and
  segmented thumbs keep the default pair. A MOVING bound element is UNBOUND (CSS face) for the flight
  and rebinds the exact size at rest. Never hold a lens on a larger map: the map and shade sit at the
  element's top-left at the map's size, so the far edge loses its rim, meniscus and pooled colour and
  they pop back in one `url()` swap. `holdLensForMorph` (a CSS width transition, 380 ms; a no-op on a
  sliced filter) and `holdLensDuringPop` (an opening panel, 500 ms) share that one unbound hold.
  `holdLensDuringPop` is called from `bind()` for `.aura-glass-pop-in`, `[data-lg-pop]` and the chrome
  panels' entrance classes (`POP_SELECTOR`: `.aura-dl-panel-in`; the notifications sheet and bubble
  are `[data-lg-pop]` since round 10; a new keyframe-popped panel class is added there):
  nothing is BUILT mid-pop. When a filter for the panel's size is already built (a menu reopened at
  the same size), the first ResizeObserver callback (before the first frame) binds it and it stays
  bound through the pop (a per-size filter under the pop's scale draws cleanly); otherwise the panel
  stays on its CSS face (also if it resizes mid-pop to a size with no built filter) and binds at the
  settled size when the hold ends. A panel animated by an inline transition sets `data-lg-pop`. `useListDroplet` (`glassListDroplet.ts`) is the shared hover droplet
  for a row list (`data-glass-droplet` on the list); a droplet's hide cancels its spring first so the
  fade runs. Every span is cancelled on unmount.

### The menu body: one uniform material (Liquid menu tier)

"There is still a quite noticeable area around the outer edge of the menu that is noticeably more
translucent than the inner area" (Notifications and Watch Together panels, 2026-11-19; the user leaned
to the translucent look for the whole menu). The cause was the caustic pickup: a raw, saturated,
lifted sample of the backdrop along the sides and bottom (`--lg-menu-rim`, 0.55 then 0.28) over a body
darkened to about 0.26 x backdrop + 5. Even at 0.28, measured with the panel's own CSS face (no
meniscus, no lens) as the reference so backdrop variation cancels out: bottom band +20 and sides +6
over the interior on a cream block, +19 / +3 over the Home posters (raw: interior 27, bottom band 72),
mid lavender page +16 / +5. The displacement, the base and the bezel width were not involved (the
bezel samples inward, and the base floods the whole filter region). So, for every menu-tier surface
(panels, popovers, menus, context menus, dropdowns, dialogs, hover cards; tips pin their old values):

- No pickup (`--lg-menu-rim: 0`), so no edge band at all; the refraction bezel and the outer hairline
  are the only edge cues left.
- The body IS the translucent look: `saturate(--lg-menu-sat)` then a tone map on LUMINANCE that keeps
  the hue (`--lg-menu-tone: <slope> <cap>`, `glassStyle.ts` `readToneTable` / `glassToneNodes`): RGB
  times a gain of luma (up to `TONE_GAIN_K` 2, stored halved in the table), T(y) = cap (1 - exp(-slope
  y / cap)). The CSS face applies it through `--lg-menu-tone-step` (`url(#aura-glass-menu-tone)`, an
  in-DOM filter `glassStyle.ts` installs next to the base and fills from the token; `liquidGlass.ts`
  re-syncs it on every activation, so `__auraLiquidRetune()` reaches it) and the lens bakes the same
  primitives at the same point, so bound and unbound match. A per-channel curve is wrong here: near
  its cap it greys out every bright colour. The arithmetic multiply scales ALPHA by `TONE_GAIN_K` too,
  so it runs on an opaque copy of the input and the input's alpha is put back with `in`: multiplied
  directly, every half-clear layer behind a menu over the mpv video (`html.playing-video`, base
  transparent) came out twice as opaque (a black 0.4 layer: panel alpha 0.95 vs 0.85 with no tone).
- Legibility is the cap: white 0.55 text (row subtitles, "No notifications", the party helper text)
  keeps 4.5:1 over a cream block (face 56, 4.77; was 68, 3.97) and a light lavender one (4.91; was
  4.46 to 4.84); white 0.9 at 9.8 or more. Over dark and mid backdrops the gain lifts the body (mid
  lavender page 31 to 41, Home posters interior 27 to 37) so their colour shows the way it once did
  only in the edge band. Re-measure on a white poster before raising the cap.
- The tint stays dense (0.58 flat, the old mid value): under `html.playing-video` the base is
  transparent, the body samples nothing over the mpv video, and the tint is the whole veil (measured:
  interior over a white frame 113.9, was 114.9). A lighter tint with a stronger gain would turn every
  menu clear over the video.
- Flat face (no top-to-bottom tint or sheen gradient) and `--lg-menu-meniscus-k` 0.35 (the CSS face's
  menu meniscus scales its alphas by the same token): every edge band within 1 level of the interior
  over a uniform backdrop (was 10 to 21). The menu CSS face ring is its own
  (`rgb(0 0 0 / 0.15 0.16 0.24 0.16)` per side), matched to the lighter bound edge pixel (the shared
  ring's 0.55 bottom was 18 levels too dark).
- The darker variant is a token flip (App.css comment above `--lg-menu-sat`): `--lg-menu-sat: 1.4;
  --lg-menu-bright: 0.62; --lg-menu-tone: none; --lg-menu-tint-top / -bottom: 0.62`: the old body,
  uniform, the same contrast over a white poster (4.55) and darker over dark and mid backdrops (mid
  lavender 28).
- Tips and toasts (`.aura-glass-tip`) set `--lg-menu-tone-step: brightness(1)`, `--lg-menu-sat: 1.4`
  and `--lg-menu-meniscus-k: 1` on themselves, so they keep their own look.

## Custom accent colour (`src/accentColor.ts`, `src/themeAccent.ts`, `src/AccentColorSetting.tsx`)

Any theme can take a user-picked accent: `AuraSettings.themeAccents` (theme id -> `"#rrggbb"`, default
empty), edited by Settings > Theme > "Accent colour" for the CURRENT theme. It rides the AuraSettings
blob, so it is portable (`PORTABLE_AURA_FIELDS`) and cloud-synced; `sync.ts` `writeSettingsBlob` keeps
the local map when an incoming blob has no `themeAccents` key (a build from before it). Every read
validates it (`sanitizeThemeAccents`: plain object, theme-id-shaped keys, hex values normalized to
lower-case 6 digits, at most `MAX_THEME_ACCENTS` 32 entries). An id this build does not know is KEPT
(a newer build's theme, so this build does not delete it on its next push) and never applied.

- What is drawn: ONLY `src/themeAccent.ts` writes it, as three INLINE custom properties on `<html>`
  (`--ln-accent`, `--ln-accent-rgb`, `--ln-accent-ink-rgb`), which beat every `:root[data-theme]`
  block; no override, no inline properties. A very light override (luminance 0.6 and up) also sets
  `<html data-accent-light>` (the Matte switch knob's dark edge, "Toggle switch" above); the pre-paint
  cache carries it as `l: 1`. `applyThemeAccent` runs from ThemeEngine's `applyTheme`
  (before it caches the splash accent), from `installThemeAccent` (main.tsx, before React mounts) and on
  every `aura:settings-changed` naming `themeAccents` (a pick, a reset, an import, a cloud pull).
- Cold start: `themeAccent.ts` caches the token set as `aura:accent-vars` (`{ t, v }`, one entry,
  device-local, derived, never synced) and index.html's pre-paint script applies it when `t` matches
  `aura:theme`, so the first frame already has the custom accent; `aura:accent-rgb` (splash glow) is
  refreshed from the computed triplet after every apply.
- Every OTHER accent token is DERIVED from the triplet once, on `:root` in App.css (`--ln-accent-glow`,
  `--ln-accent-hover` 84% + white, `--ln-accent-press` 80% + black, `--ln-accent-on-glass` 60% + white),
  never restated per theme with a literal: a literal would ignore the override.
- MARKS (round 10): a small accent mark on dark glass (an unread dot, the rail's count badges, the
  notification sweep, chip and washes) uses `--ln-accent-mark`, the accent with its OKLCH lightness
  floored at 0.66 (relative colour syntax, `@supports`-guarded, falling back to on-glass); accent TEXT
  on glass (a chip label) uses `--ln-accent-mark-text` (on-glass floored at 0.8, 4.5:1 on menu glass);
  text on a mark is `--ln-accent-mark-ink-rgb` (dark). Every built-in accent is lighter than both
  floors (0.676 and up), so only a dark custom accent changes: #1a2050's raw dot measured 1.04:1 on the
  sheet. They live in their own `:root` block AFTER the first one, whose `:root[data-theme="mica"]`
  half would outrank a plain `:root` override (a token added there never took the `@supports` value). Tailwind
  `ln-accent-hover` / `-press` / `-dim` read those (`-dim` was a fixed `#3D7FCC`).
  Selected and checked LABEL text on dark glass (a selected `.aura-glass-item` / `-row`, a selected
  Liquid control, checked choice labels, `.aura-glass-flat.is-selected`, the Matte rail's lit row, and
  `.is-primary` at 78% into white) uses `--ln-accent-mark`, never the raw accent; so do ChoiceList's
  selected ring and dot (`settingsControls.tsx`). Washes, hairlines and backgrounds keep the raw
  accent. Built-ins are unchanged (all above the floor).
- Text on a SOLID accent fill is `text-ln-accent-ink` (`--ln-accent-ink-rgb`), never `text-black`: black
  for every built-in accent (all light, so nothing changed for them), and for a custom accent black or
  white by WCAG contrast (`inkFor`). A colour literal that means "the accent" (a `rgba(91,164,255,...)`
  shadow) is a bug: use `rgb(var(--ln-accent-rgb) / a)`. Brand marks (the Aura logo glows, the
  spectral `aura-bar-glow`) stay literal on purpose.
- The picker: `.aura-float-glass` popover portalled to `document.body`, Escape in a window capture
  listener (stopped), outside press closes except on `[data-aura-context-menu]` / `[data-perf-monitor]`,
  a wheel elsewhere closes. Saturation / brightness square and hue slider (`role="slider"`, arrows,
  Shift x10, Home / End, PageUp / PageDown), hex field (Enter or blur commits), the theme default plus
  every other theme's accent as swatches. Dragging PREVIEWS (`previewAccent`: inline variables at most
  once per frame, React state only inside the popover); release, key-up, a swatch, Enter COMMIT (one
  save, one sync push). Closing with an uncommitted preview re-applies the stored value; committing
  the theme's own default stores nothing (the entry is removed). The SV square and hue gradients are
  full-range colour fields (about one code per pixel), so they need no dither.
- Contrast: against the theme's base (`THEME_SWATCHES.base`). Below 3:1 the row and the picker WARN
  (never block); on the High Contrast themes (`useGlassState().contrastFloor`, the `--lg-glint-off`
  fact, no theme id named) the floor is 4.5:1, because their accent also colours small labels, and
  only swatches that clear it are suggested. The picker's own Done / Reset are neutral, so a bad pick
  never makes the way out unreadable.
- Accent-keyed caches follow by themselves (the cursor light is white since round 9 and reads no
  accent), toasts read `--ln-accent-rgb` when a bump starts, the History heat map when it opens.
  `aura:accent-changed` (`detail.preview`) fires after every apply and preview frame for anything that
  must re-read sooner.

## The cursor light (`src/glassGlint.ts`, `public/aura-glass-rim.js`, round 9)

The user's round 9 pick (the A direction of the round 8 mockup), replacing round 7's accent "rolling
hill" Gaussian on the hovered element only. Both materials, gated by Cursor glow (`glassCursorGlow`)
and never on High Contrast (`<html data-glass-glint-mode>`).

- REACH: every light surface within `--lg-rim-r` (300 px) of the pointer is lit (the distance to its
  box), not only the hovered one. With hardware acceleration off (`<html data-glass-gpu="off">`,
  stamped by glassStyle.ts from the same gpuOff fact as the Liquid fallback) only surfaces whose box
  holds the pointer light, and there is no dispersion.
- INTERIOR light (glass panels and controls; never rim-only surfaces): a WHITE radial of radius
  `--lg-rim-r` at the pointer, peak `--lg-light-peak-ctl` / `--lg-light-peak-panel` (both 3.5%), falling
  linearly to 10.7% of the peak at 0.6 R and to 0 at R. `--lg-glint-c` is `#fff` (round 7's 60% accent
  mix is gone). The pointer may be outside the element, so the light spills in from the near edge.
- RIM light: the `aura-rim` CSS paint worklet (`public/aura-glass-rim.js`, plain JS in `public/`
  because the CSP allows worklet modules from `'self'` only; glassGlint.ts registers it). Round 12 (the
  user, 39.png: passing over nav items or the search bar "can feel slightly like a bright hover
  highlight ... keep the interior fill very restrained and let the thin outer rim catch a crisp,
  directional specular glint while internal glass remains cool, dark, and refractive"): three lights,
  everything x `--lg-rim-peak` (0.46; 0.36 until 2026-11-24) x `--lg-glow-edge-k` (Edge highlights, default 1.25) x the fade.
  - The GLINT: a tight radial (`CORE_R` 0.2 R, 36 to 84 px; `CORE_PROFILE` 1, 0.78 at 18%, 0.32 at 45%,
    0.08 at 75%, 0) centred on the rim point NEAREST the pointer (projected onto the rounded outline,
    arcs included), so it slides along the edge facing the pointer and stays crisp at any distance;
    strength (1 - d / R)^2 with the pointer's distance d to that point. With the pointer INSIDE the box
    it is centred on the pointer, radius grown by d: every edge equally near catches it (both long edges
    of the search bar, not whichever side won a tie) and it fades deep inside a big panel (both agree at
    d = 0). Cool white (232 241 255). Its soft inner side is a HALO at 12% (`HALO`, none on a box under
    12 px) on the one device pixel right inside the hairline (round 14; it was a 1 px ring 2 px in, beside
    the 1.5 px band, see "The rim is a hairline" below).
  - The TAIL: round 11's radial at the pointer (radius R, `TAIL` 0.34 of the peak, `TAIL_PROFILE` 1, 0.5
    at 0.3 R, 0.2 at 0.6 R, 0 at R; 240 245 255), and the BOUNCE at the mirrored point (0.7 R, `BOUNCE`
    0.24, 0 at 70%).
  - Chromatic dispersion (`--lg-disp`, inherited, 0 with the GPU off): a red (255 70 90) and a blue
    (70 150 255) copy of the GLINT only, at `DISP` 0.805 (0.7 until 2026-11-24), offset one device pixel (round 14; was 1.6 px,
    which put the fringe 2 and 3 px in) either way along the pointer
    direction (`--gnx` / `--gny`), under the white one: BLUE inward on the lit side, red outward. A
    background cannot paint outside the border box, so only the inward copy shows on each side (the
    mockup's drop-shadow also fringed outward); with red inward the lit edge read magenta-white where the
    mockup's reads blue (review round 9).
  BUMP (2026-11-24; the user: "the edge glow got toned down a bit during one of the last couple passes
  and the chromatic lensing isn't as visible / at all visible anymore", without the light band back).
  No strength had changed since round 12: the loss was geometric (round 12's 60 px glint, round 14's
  one-pixel hairline, which halved the summed light at 150%) and the blue copy sitting under the white
  on the outer pixel. Peak 0.36 to 0.46 and DISP 0.7 to 0.805, LIT terms only. Measured (harness,
  search bar, rail, a Settings sheet, the bar with the pointer inside; mica and a light page; 100 and
  125%; scratchpad `h/rimtune.cjs` + `rimtune.py`, tables in `h/rimtune/`): glint +20 on mica (+89..104
  to +111..125), +9 on light; blue B-R about 1.8x (mica) and 2.1x (light); still 2 device px, nothing
  2+ px in; px1 (blue + halo) +38 on straight edges, +41 on the mica sheet at 100%, under half of px0;
  idle identical on every shot. Rejected, measured: dispersion at 1.4x (px1 +44 to +48, over round 14's
  +40 band level), the copies drawn OVER the white (strongest colour, but the light-page glint fell from
  +40 to +15..28) and a 2 device px offset (a third lit pixel: round 12's fringe back). Blue on px1
  always brightens it (the blue's luma is about 140), so peak x DISP-share of about 0.53 is the ceiling
  within two pixels. "Chromatic lensing" here is this fringe: the lens refraction displaces every
  channel by one map (no colour split), and the coloured caustic pickup WAS the light band (round 16).
  Measured (harness, dark Mica stand-in, before = round 11 at its 1 / 1 tune, after = round 12 at the new
  defaults, luma): the rail's right edge with the pointer on the Library row 109 to 99, and 89 to 69 at
  120 px along (the light concentrates where the pointer is); the search bar with the pointer inside it
  top / bottom rim 144 / 147 to 145 / 150 near the pointer (both long edges now) and a darker rim
  elsewhere; the rail pill shows a crisp glint on its edge nearest the pointer instead of a lit outline.
  CORNERS (round 12, the user: "the bottom corners of some panels are missing the edge highlight", the
  Settings sheets and the hero, 33.png / 37.png): a 1 px stroke along a corner arc is split by
  antialiasing over two pixels and stippled by the raster, and the background's own rounded clip cuts
  the outer pixel, so every arc drew at about a third of a straight edge's light (Settings sheet,
  pointer 18 px left of its bottom-left corner: 22 levels over the face at the arc's 45 degree point,
  65 on the left edge). The top corners hid it under the idle rim's top-left radial; the bottom ones
  showed a lit edge stopping dead at each arc. Every surface kind was affected (it is the worklet), so
  the fix is there: the rings that carry the rim (idle, tail, glint) are 1.5 px wide (band 0 to 1.5 px
  in; the straight edge keeps its crisp outer pixel, the next one gets half). After: 60 levels at that
  arc (Frosted 7 to 37), all four corners lit on sheets, the hero bezel, the rail and cards; test boxes
  at 10, 18 and 28 px radii read even with the straight edges (2 px read heavier). The faint rings
  (halo, dispersion, bounce) stay 1 px. Before reading a corner, check it is not a harness artefact: an
  HMR reload mid-capture (other agents editing the tree) gave false "notched" corners in round 12, so
  run the harness with `hmr: false`.
  THE RIM IS A HAIRLINE (round 14; the user: "a faint, thick translucent light band ... along the
  inside of the top and left rounded edges rather than a crisp 1px edge highlight", the Settings
  CONTENTS card and the Home Catalog Sources card, "across all themes"). The 1.5 px band above WAS that
  band: on a straight edge it lit the outer pixel and the next one at about 60%, and the top-left idle
  radial put it on exactly the top and left edges near the corner. Measured (harness, Settings, luma
  over the face, top-left region, pointer out of the window): Haze Clear +24 +13 before, +24 +1 after;
  at 150% display scale (1.5 CSS px = 2.25 device px) +23 +23 +6 before, +23 -1 after; lit (pointer
  30 px left of the card) the left edge was three pixels, +67 +40 +11 at 100% and +66 +67 +22 +16 at
  150%, now +74 +16 and +74 +15 (the second pixel is the blue fringe and the halo). Same on Mica, Ember,
  Midnight (within 2 levels of Haze), High Contrast unchanged (no idle rim, its 0.35 border). Every
  ring that carries the rim (idle, tail, glint, bounce, the dispersion copies) is now the band from ONE
  DEVICE PIXEL OUTSIDE the border box to one inside it (`rim` in the worklet: one `roundRect` stroke
  centred ON the outline, width 2 x H). Outside the box the stroke is cut by the canvas on a straight
  edge (so the edge lights its outer device pixel and nothing else) and by the rounded background
  clip on an arc, so an arc loses only to the clip's antialiasing, not the stroke's as well: the lit
  bottom-left arc reads 70 levels at 45 degrees against 90 on the left edge (round 12's plain 1 px
  stroke: a third). The halo and the blue copy sit on the device pixel right inside, so a lit rim is
  at most two pixels. H = max(1, floor(dpr)) / dpr CSS px (one device pixel up to 200%, two from
  there); the worklet reads the ratio from `--lg-dpr`, which glassGlint.ts `trackDevicePixelRatio`
  writes inline on `<html>` (only when it is not 1, and again only when a `(resolution)` media query
  says it changed): a worklet's own `devicePixelRatio` reads 1 in Chromium at any scale (measured at
  150%), though its canvas IS device resolution. Known trade-off: a box at a FRACTIONAL device position
  (common at 125%, where only multiples of 4 CSS px land on a device pixel) has every edge
  antialiased over two pixels, its 1 px border included; the hairline there reads as one soft line at
  about half strength (sticky Settings TOC at 125%: +24 +12 before, +12 +0 after), never a band. The
  Home card bezels (scaled 0.94) read crisper and their lit outer pixel brighter (+90 / +139 against
  +73 / +116 at the bottom-left, one pixel instead of two or three). Matte (Frosted) had its own
  two-row top: a 0.12 border plus an `inset 0 1px 0` white 0.14 row under it (+27 +30, the second row
  the brighter). Its lit top is now the BORDER's top side, white 0.20 (sides 0.12), one pixel (+44
  then the face); the inset entry stays at zero alpha so the two-entry `--lg-edge` keeps its shape
  (App.css Frosted float recipe; the Frosted player face in glass-player.css the same, 0.19). A
  Frosted state rule that sets one `--lg-border-c` colour (hover, tones) now lights all four sides
  evenly, as before minus the extra top row. The A tier's `inset 0 0 22px` white 0.012 inner glow
  stayed here (it moved the edge by 1 level over 10 px, then judged not a visible band); round 17 found
  that very step was the band the user still saw and zeroed it ("The A control tier"). Audit (harness, every
  glass surface of 80 x 36 or more on Settings, Home, Calendar, Addons and Library with the
  notifications sheet open, five themes, both materials, 215 each): surfaces whose lit edge was 2 px
  wide, Clear 157 to 8, Matte 210 to 5; the rest are deliberate 1 px INSET rings (the Calendar's today
  cell, the field well), crisp themselves. Scripts: scratchpad `r15/halo` (`prof.cjs`, `corner.cjs`,
  `audit.cjs`, `frac.cjs`, `card.cjs`, `table.py`).
  THICKER GLINT (2026-11-24; the user: the lit edge "has been pretty thin since the clear light band fix",
  asked for it "a few pixels thicker ... without reintroducing the same issue"). Only the GLINT widens, to four
  device pixels, outside in: white (the hairline), white at `BODY` 0.6 of the glint, the blue dispersion copy
  (now shifted 2 device px inward, so it sits on the third pixel instead of under the second), and the `HALO`
  on the fourth. The idle rim and the tail stay one device pixel: they run along whole edges, and round 14's
  band was the IDLE rim's second pixel (pointer out of the window). The glint is the tight 36 to 84 px radial
  at the rim point nearest the pointer, so the wider light never lies along a whole edge. Not yet measured in
  the harness: re-measure (scratchpad `h/rimtune`) before raising `BODY` or widening further. Surfaces the
  pointer can never be over opt out of the light with `data-glass-glint="off"` (the player scrubber's hover
  popover: frame preview, time chip, skip-segment card; the user found the lit edge there distracting).
  HOW it draws (round 11, performance): every ring is ONE `roundRect` STROKE centred lw / 2 inside
  (the rim rings, round 14: centred on the outline, half of it outside and cut),
  which covers exactly the band between the outer rounded rect and the one lw inside it: the raster's
  rrect fast path. It used to clip to that ring (two rounded rects, evenodd) and fill the whole box, ten
  times per lit surface; GPU raster has no fast path for such a clip, so each was a box-sized coverage
  mask (in-page A/B, pointer moving over Home at 2575 x 1038: 100 fps with the clip, 122 stroked). Never
  go back to clip + fill, and never add subpaths to a ring: round 12 first stroked the corner arcs as an
  extra path per ring and lost 13% of the pointer-move frames on Home (97 against 111 fps headless); the
  1.5 px rrect stroke costs nothing measurable (108 against round 11's 107). A lit surface strokes six
  rings (dispersion 2, bounce, tail, glint, halo; round 11 eight) plus its idle ones.
- IDLE rim (same worklet): two corner-anchored radials, top-left `--lg-idle-tl` fading to `--lg-idle-mid`
  and bottom-right `--lg-idle-br` fading to 0, each over --rc = clamp(0.9 x the short side, 24 px, 96 px),
  times `--lg-idle-k` (inherited; 1 idle, 0.62 while `<html data-glass-light-live>`, 0 on High Contrast).
  Liquid floating glass except tips: 0.18 / 0.03 / 0.11 (the A face's only edge); the hero bezel 0.15 /
  0.06 / 0.12. Frosted glass and flat controls have none (their own hairline / spec rim). It is static
  edge definition, so it stays with Cursor glow off (decision, round 9).
- IDLE MID per theme darkness (round 13; the user: "On the darker themes like haze when using the
  Glass style, I notice a thin lighter band of color around the edges of most panels"). Measured in
  the harness (transparent window over a #202020 Mica stand-in, glow off and on with the pointer far,
  100 / 125 / 150%; scratchpad `r13/surfaces`, `edge.cjs`): the band was the floating-glass idle
  rim's MID term, the (then 1.5 px, now hairline) white 0.03 ring along every side beyond the corner radials, +6 to +10
  levels on a face of 15 to 22 (Haze sheet 20 to 30; `--lg-idle-k: 0` took it to +0 / +1). Ruled out
  by ablation, each under 1 level at the edge: the `#aura-glass-base` flood, the 22 px inner glow,
  the lens edge (bound vs unbound alike). So the panel rule's mid is
  `calc(0.03 * var(--lg-idle-mid-k, 1))` and `:root[data-theme]:not([data-theme="mica"])` sets
  `--lg-idle-mid-k: 0.34` (the dark-page themes, page luma 0 to 17): +2 / +3 now, Haze sides +2 to
  +5 at 100 to 150%. Mica keeps 1: its face sits level with the page (32 vs 32) and that ring is the
  only thing that draws a sheet's sides there. The corner glints (tl / br), every other surface's idle
  values (rail pill, selected rows, bezels, frost badges, the player face) and the lit rim are untouched.
- LIVE vs idle: the pointer is live while it is over the window, moving OR resting (the mockup the user
  tuned keeps the light under a resting pointer; a 1 s still timeout, as first built, faded it there).
  Out of the window (`pointerleave` on `<html>`) or with the window blurred for `IDLE_MS` (1 s), it goes
  idle: every light fades out and the idle rim returns to full. A resting pointer runs nothing (the rAF
  sleeps once the light settles). The 0.62 / 1 switch is a snap on an INHERITED root token, so it
  restyles the document and repaints every rim surface once: that is why it flips only on leave / enter,
  never on a pointer pause.
- The ring is the TOP background layer (`--lg-rim-layer`, `paint(aura-rim) border-box`, set by the
  `@supports (background-image: paint(aura-rim))` rule on lit surfaces and idle-rim surfaces; elsewhere
  an empty layer). The paint rule's list is now rim, glint, deco, lift, `--lg-bleed`, face.
  `--lg-rimlight` (the old box-shadow catch-light) is a constant zero-alpha inset kept only so every
  box-shadow list and keyframe that names it keeps its shape.

- USER TUNING (round 11, `AuraSettings.glassGlowTune`, Settings > Theme under Cursor glow):
  glassGlint.ts `applyGlowTune` writes `--lg-glow-edge-k` (Edge highlights, the ring and halo),
  `--lg-glow-surface-k` (Surface glow: both interior peaks, baked into the light image, and the text
  light) and `--lg-rim-r` (Glow size: radius AND reach) INLINE on `<html>`, each only when it differs
  from its default (`DEFAULT_GLASS_GLOW_TUNE`; App.css `:root` holds the same 1.25 / 0.25 / 300px, keep
  them equal), and only on a settings change naming
  `glassGlowTune` or a slider preview. A root write restyles the document once; never per frame.
  The sliders PREVIEW through `previewGlassGlow` (at most one write per frame, no React re-render per
  move; `null` restores the stored tune) and COMMIT on pointer up, key up or blur. A change re-reads
  the tunables and rewrites the image of every surface lit right now. The image cache keys on R and
  the peak, so it follows the tune (IMG_CAP 8, an evicted url revoked once nothing shows it); a zero
  peak builds no image.
- DEFAULTS (round 12, the user's pick): Edge highlights 125%, Surface glow 25%, Glow size 300 px, for
  both materials (one setting, and the same brief applies to Matte: a restrained interior with
  the rim carrying the light; its corners and rim measured the same way, see above). Was 1 / 1 / 300. MIGRATION: the tune carries `rev: 2`; `sanitizeGlassGlowTune` reads a tune
  with no `rev` that equals the old defaults exactly (an untouched install, an old cloud blob, an old
  export: those builds always stored the default object) as the new defaults, keeps any other value,
  and stamps `rev: 2` on everything it returns, so every tune this build writes is trusted as is and a
  deliberate later pick of 100% / 100% survives. No marker key, idempotent, and it rides storage, cloud
  sync and import alike (all three go through `readFromStorage`). Older builds drop `rev` (they pick
  the three fields) and clamp nothing (1.25 and 0.25 are in range). Reset goes to the new defaults (the
  Settings rows compare against `DEFAULT_GLASS_GLOW_TUNE`).
- HOVER FILLS (round 12, same feedback): the interior light is the 25% default; the Liquid rail's hover
  droplet is white 0.028 to 0.016 (was 0.035 to 0.02) and Frosted's per-row rail hover fill 0.06 (was
  0.08). The search bar and the rail never lift on hover in Liquid (round 9), so the rim carries the
  hover there.

**Contract for other surfaces** (the Home cards, badges): put `data-glass-light="rim"` on an element
whose background can carry the ring, typically an overlay (`position: absolute; inset: 0;
border-radius: inherit; pointer-events: none`) above the art. A non-glass `[data-glass-light]` gets
`background: var(--lg-rim-layer)` at zero specificity; an element that sets its OWN background must
put `var(--lg-rim-layer)` first in it (`background: var(--lg-rim-layer), <its fill>`), or the ring is
lost. Optional idle strengths per element: `--lg-idle-tl` / `-mid` / `-br` (registered numbers, default
0). `data-glass-light="panel" | "control"` on a glass element picks its interior tier; without it the
menu tier and boxes at least 150 x 300 are panels. Any `[data-glass-light]` is measured and lit by the
same registry; nothing else to wire.

**Text surfaces** (round 11): `data-glass-light="text"` on a text element gets the same position writes
(`--gx` / `--gy` / `--gnx` / `--gny`) and fade (`--lg-glint-a`) and NO image; like a rim surface it does
not count against the 12 full glass surfaces. It is on every Home row title AND every page title (the
`.aura-row-title` h1 of Library, Queue, Airing and its section heads, Discover, Catalog, Search,
Calendar, History, Live TV, Addons; review round 11: only Home's reacted, which broke the cohesion the
user asked for). Only Home's take the bleed tint (no bleed elsewhere). Its own CSS draws the light: today only `.aura-row-title`
(App.css "Row and page titles"), a white radial of 0.62 x `--lg-rim-r` at the pointer (1, 0.5 at 38%,
0.14 at 70%, x the fade x min(1, 4 x Surface glow)) over the title's fill, `background-clip: text`, so
the glyphs near the pointer brighten to white (harness: +41 levels under the pointer, +12 on the far
word). The text factor is its own (`--lg-title-light-k`, round 12 review): the new 25% Surface glow
default would otherwise have cut the titles' light to a quarter; at 25% and above they read as in
round 11, and 0% still turns them off. Use
`background-image` / `-color` LONGHANDS on such an element: a `background` shorthand resets the clip
(the whole title box painted white in the first build). Glyph-masked, so no dither is needed.

**Banding: every large soft light is a dithered IMAGE, never a CSS gradient.** The webview composites
at 8 bits with no dither, so a 3.5% light over a dark surface is a staircase of 1-code rings, and a
grain on its OWN layer cannot fix it (each layer rounds on its own; measured in round 7). `lightImage`
builds an SVG with the profile at FULL range (a radial gradient, 20 stops) and a near-white
`feTurbulence` (fractalNoise 0.7, sd 0.108) summed in ONE arithmetic `feComposite` (`k2` = peak, `k3` =
`--lg-glint-dither` 0.014, `k4` = -dither / 2), so the one 8-bit rounding is dithered. ONE 2R x 2R image
serves every surface, as a SHORT `blob:` url (`svgImageUrl`): the glass `background` is a
var()-substituted shorthand re-tokenised on every style recalc, and a multi-KB `data:` url in it made
each lit element's recalc dearer. Blob urls are revoked once nothing shows them (`releaseSvgImage`).
Measured (harness, round 9): the lit rail's interior row has no run of identical pixels longer than 6
px. A 1 px ring needs no dither.

Mechanics and cost:

- ONE passive `pointermove` listener and ONE rAF callback (`tick`: the light, then the fades), reads
  first and writes after, so a frame does one style recalc. Never two callbacks per frame: a fade
  started inside the tick reuses the scheduled one (a duplicate once multiplied the work per frame).
- A registry of candidates (`LIGHT_SELECTOR`: the glass classes plus `[data-glass-light]`), re-queried at
  most every 100 ms after a DOM change that can change it (one MutationObserver on `<body>` that only sets
  a flag, and only for a node added or removed that is or holds a candidate, a class change on an element
  that is or becomes a candidate, or a `data-glass-light` / `data-glass-glint` change: the rail droplet's
  and pill's `is-on`, toasts and hovers flip classes constantly, and a full re-query plus a rect per
  candidate on each ran at 10 Hz during ordinary movement); their
  rects re-read only after a scroll, a resize, a lit element resizing (ResizeObserver, real size changes
  only) or every 500 ms while the pointer moves. A frame is then a distance test per candidate plus up
  to four writes per lit element, skipped when unchanged (whole pixels for `--gx` / `--gy`).
- At most 64 surfaces lit, of them at most 12 full glass surfaces (the nearest): a glass element's
  recalc re-resolves its var()-built background, box-shadow and backdrop-filter, about 0.2 ms each per
  frame (headless measurement), a rim-only card overlay about 0.03 ms. Measured per pointer move over
  Home with 80 rim cards (26 lit): script 0.5 ms, style 3 ms; glow off 0 / 0; idle (still pointer)
  nothing runs.
- During a user-driven scroll (`<html data-aura-scrolling>`) the lights hold still and catch up when it
  settles; any other scroll re-measures and re-lights (lights follow the content). The hold covers a
  pointer moving DURING the scroll too (round 12): `onMove` only stores the point and `tick` skips the
  light while the attribute is set. Before, a moving pointer kept the light running, and since every
  scroll step dirties the rects it re-read about 50 rects a frame and repainted every lit surface:
  moving while scrolling ran at 64 fps on Home at 2575 x 1038 against 141 for scrolling alone.
- PERFORMANCE RULES (round 12, the user: keep a high frame rate while scrolling and moving the pointer
  with Cursor glow on). Every light frame repaints each lit surface, and a repaint re-rasters every
  tile under it (the card art, a sheet's text) plus every other paint-worklet image in those tiles,
  and re-runs the backdrop pass of a lit or underlying frost badge. So the light touches as few
  surfaces as it can, as rarely as it can, without a visible change:
  - VISIBLE only: an IntersectionObserver (implicit root, so clipped by every scroller) marks each
    candidate in or out of sight; one out of sight is never lit, and one scrolled out while lit (or
    fading) is dropped at once. The reach is a distance to the BOX, so the poster row under the fold
    was lit and repainted on every pointer frame while the pointer crossed the CW row (Home, 2575:
    pointer sweep 59 to 98 fps, moving slowly 76 to 137, from this alone). The observer ignores
    OCCLUSION, so a candidate under a `[data-glass-covered]` ancestor is never lit: App.tsx marks the
    view wrapper and the rail's aside (NavSidebar `covered`) while a Detail page is open
    (`selectedMeta && !isPlayerActive`, so the page lights again during the exit fade). The
    `[data-rail-popups]` host is NOT marked (the notifications sheet sits above the Detail page). The
    body MutationObserver watches the attribute.
  - LEVEL OF DETAIL: positions are whole pixels within `LOD_NEAR` (0.25) of the reach, then coarser
    steps up to `LOD_MAX_STEP` (10 px) at its edge, where the glint is 6% of its peak or less (a slow
    pointer repaints far surfaces a few times less often; moving slowly 159 to 176).
  - PACING: the light (and its fades) skips a frame that comes under `LIGHT_MIN_MS` (4.5 ms) after the
    last light frame: every frame up to about 220 Hz, every other frame at 240 Hz (120 light frames a
    second). The frames between do nothing. The floor sits away from every common refresh interval
    (round 12 review: a 5.5 ms floor sat on the 170 to 180 Hz intervals, 5.56 to 5.88 ms, so rAF
    jitter flipped between running and skipping).
    The position is smoothed over 70 ms anyway, so a step sits inside the light's own trail; this is
    the one deliberate trade (the light's cadence, not its look). Home 2575 at 240 Hz: pointer sweep
    102 to 134, moving slowly 158 to 179, over the rail 124 to 139.
  - The worklet skips a ring whose brightest point on the rim stays under `VIS` (0.003 alpha, under one
    8-bit level): pixel-identical in three captures, pointer sweep 106 to 113.
  - SHEETS draw the light on an overlay layer (see "In-page sheets and pages", R2): Settings 103 to 219.
  - Measured and rejected: promoting lit card bezels to their own layer (`will-change` while lit). It
    doubled the 1600 x 900 slow-pointer rate, but cards sit at `scale(0.94)` and a composited bezel is
    resampled: the lit edge spread over two pixels and the corner arc read about 16 levels dimmer
    (pixel diff up to 34). An integer-positioned, unscaled surface (the hero bezel) composited
    pixel-identically, so the cause is the scale, not the layer. Promoting frost badges also
    re-rendered their text (grayscale AA). Splitting the idle rim into its own worklet image was
    slower (more worklet images per tile). A `Path2D` reused across rings changed nothing.
- Fades: 260 ms ease-out cubic in, 600 ms in-out sine out, written inline as `--lg-glint-a` (never WAAPI
  or a CSS transition: a box-shadow transition's base style cannot see an animated value). A hidden
  document drops every light at once.
- `--gx`, `--gy`, `--gr`, `--gw`, `--gh`, `--gnx`, `--gny`, `--lg-glint-a`, `--lg-glint`, `--lg-glint-img`,
  `--lg-rimlight`, `--lg-rim-layer`, `--lg-bleed` and `--lg-idle-tl` / `-mid` / `-br` are
  `@property`-registered NON-INHERITING: a write restyles the element alone. `--lg-idle-k` and
  `--lg-disp` inherit (set on the root, changed rarely).
- A TRANSPARENT surface is never lit (round 11): the registry keeps each candidate's own computed
  opacity / visibility (`shown`, reset with the rects and on every `pointerover`, since a reveal is
  usually a `:hover` rule) and skips one at opacity 0 or `visibility: hidden`. It is read LAZILY, only
  for a candidate already within reach: read for every candidate on every pointerover, a dense page
  (Settings' controls and sheets, Library's 80 poster bezels, the Calendar's cells) paid a computed-style
  read per candidate several times a second while the pointer crossed elements. The Home hero arrows and
  the CW remove buttons are `opacity-0` until hovered, and lit anyway they were repainted and
  re-rastered on every pointer frame for nothing.
- `<html>` must never match a light selector (a write there restyles the whole document);
  `data-glass-glint="off"` opts one element out; a real-glass player surface is skipped.

## The Home hero (`HeroCarousel.tsx`, `HeroBleed.tsx`, `heroAmbient.ts`, `styles/glass-hero.css`, round 9)

Both materials (it is layout, not material). Every large soft gradient here is a dithered SVG image
(`heroAmbient.ts`, the same full-range-plus-noise-in-one-composite technique as the cursor light), held
as a blob url and revoked when dropped.

- SOURCE AND SLIDES (`src/heroSource.ts`, HomeView, 2026-11-22; the user: on loading or returning to
  Home "the hero banner rapidly cycles/flickers through multiple slides in quick succession before
  settling", art and bleed jumping). The carousel never stepped its index on load: it was REMOUNTED,
  each time at a new slide 0 with its own palette, bleed and underglow, because HomeView took "the
  first row with items" on every render and keyed the carousel on it. Rows answer in completion order
  (four requests in flight), so row 2 then row 1 then row 0 each took the hero in turn; every row
  rebuild (`addons` is a new array at warm start and again after the account sync, a manifest
  refresh, a settings tick) set the rows to `[]`, unmounting the hero and its bleed, then mounted it
  again; and a pinned hero catalog showed the first row's items until its own answer came. The rules
  now (node-checked, `settledHeroRow` / `nextHeroSource`):
  - The default source is the first row with items, decided only once every row BEFORE it has
    answered (a walked row counts), or `HERO_SETTLE_MS` (1.2 s) after the build's first row with
    items, whichever is first. Most loads decide at once (row 0 answers first).
  - One build, one hero: a later answer in the same build never replaces the latched source (a slow
    row 0 that answers after the grace does NOT take the hero over).
  - A rebuild keeps the hero up (and its bleed) until the new build decides; the same row with the same
    title ids keeps the very same object, so the carousel neither remounts nor re-renders. Only a
    build that settles on ANOTHER source (a Home Catalog Sources change) remounts it, once.
  - A pinned catalog shows nothing until its own answer (tagged with the catalog it answers, so a newly
    pinned catalog never shows the previous pin's slides); the first row never stands in for it.
  - Returning to Home: `HERO_SOURCE_MEMO` (the last source, one entry) puts the hero up on the first
    frame, and HeroCarousel's `lastSlide` (one entry, by source) starts on the slide it was on.
  - The first slide is the carousel's INITIAL state, so it mounts at full opacity with no cross-fade
    (`prevIndexRef` starts on it); only a later index change fades. The bleed and underglow follow the
    shown slide only.
  - Auto-advance (22 s) runs only while Home is seen: not hovered, window not hidden, and not
    `paused` (App passes `heroPaused` while a Detail page is open or playback is active; HomeView
    stays mounted under both).
- 18 px corners (`rounded-[18px]`) and a BEZEL instead of the old 1px white border: `.aura-hero-bezel`, a
  rim-only light surface over the art (idle 0.15 / 0.06 / 0.12, lit by the cursor light).
- ONE CLIP FOR THE GROUP (`.aura-hero-box`, `clip-path: inset(0 round 18px)`, round 19; the user: "the
  corner of the hero item also appears to have a feint black outline", 48.png). The box's rounded
  overflow clip rounds each child on its own, and the art, the slide vignette (0.78 at the edge), the
  bottom gradient (0.7) and the legibility ramp (0.55) each cover an antialiased corner pixel by the
  same fraction, so the page under that pixel was multiplied down once per layer: a ring darker than
  both the page and the rim. The clip-path composites the group first and clips it once. Measured
  (outer antialiasing band, 0 to 1 device px outside the 18 px arc, minus the page with the hero
  hidden, mean / worst): -3.7 to -10.6 / -18 to -40 before at every corner, both scales, pointer out
  or near; -0.2 to -1.3 / -1 to -10 after. Nothing more than 1.5 device px inside the edge changes (0
  levels: art, scrims, bezel, rim); the straight edges are identical at 100% and only the partly
  covered edge row lightens at 125% (-2.6 to -1.0 on the transparent window); the arrows (their own
  backdrop pass inside the clip) are unchanged. Keep any new dark layer inside the hero under this
  one clip.
- Dominant colours (`heroPalette`): the current slide's art read back through the loopback resize proxy.
  The art is cross-origin, so it is read from `http://127.0.0.1:11471/img`, which now reflects the
  WebView's own origin in `Access-Control-Allow-Origin` on the image bytes (`img_proxy.rs` through
  `streaming::add_cors`; the degrade redirect never carries it). Fetched at the SAME url the hero shows
  (the proxy's disk cache answers; nothing goes upstream twice) with `cache: "no-store"` (the `<img>`'s
  cached copy has no CORS header), shrunk by `createImageBitmap` off the main thread to 60 x 24 and
  averaged on the mockup's 15 x 6 grid: left, centre, right, top (made vivid: saturation at least 0.55)
  and the raw middle. LRU of 32 urls. A url that is not the proxy's (or a read that fails) gives no palette:
  no bleed, a neutral contact shadow. The carousel keeps the previous slide's palette only while the new
  read is pending, then clears it on a null (never the last slide's colours on an unreadable one).
- UNDERGLOW (`useUnderglow` in HeroCarousel.tsx): a contact shadow (raw middle x 0.22, alpha 0.55, a box
  inset 14 px at the sides, 24 px from the top, 20 px past the bottom, sigma 26) plus a coloured halo (the
  vivid centre, alpha min(0.3, bleed x 1.4) = 0.28, the hero box at sigma 62), one image, behind the hero
  at `z-index: -1` (so it is under the rows below too), reaching 110 px past each edge, less where the
  page scroller's clip box is closer. EVERY side fades to 0 at the image edge (round 11): a side with
  the full pad over its outer 0.6 x pad (`FADE_K`, smoothstep, the look within 44 px of the hero
  unchanged), a side short of the pad over all of its room. The halo (sigma 62) is still about 4% of its
  peak at 110 px (1.8 sigma), so a plain image edge there drew a hard 1 to 2 level line in the soft
  light: vertical in the gap between the rail and the hero, horizontal between the row cards under it
  (the round 11 "slight bit of banding just next to the hero" report; measured on the user's screenshot
  and in the harness at 2575 x 1038 DPR 1, 2060 x 830 DPR 1.25 and 3456 x 1393: a 1 level red step
  across the whole hero height before, none after). The dither was never the problem there (noise at
  device resolution at both DPRs, median identical-pixel run 4 px). A soft image that ends inside the
  page must reach 0 at its own edge, never stop at a fixed pad. The same function draws the Home cards'
  hover glow, so it got the fade too (accepted: on a card the fade starts 26 px out, where the halo is
  already under a quarter of its peak; before it, the card glow ended in the same hard 66 px line).
  If a per-caller fade is ever wanted, pass a fraction instead of the shared `FADE_K`. Two
  layers crossfade on a slide change (CSS animations on mount, no state flip).
- AMBIENT BLEED (`HeroBleed.tsx`, the user's 20%): up to six large soft glows (centre, left under the
  rail, top, right, and a flank glow each side when the hero leaves more than 200 px: the mockup's
  `bleedGlows`), ONE viewport-sized image (the glows are SUMMED, `mix-blend-mode:
  plus-lighter` inside the filtered group, as the mockup's straight sum; over-compositing read 10 to 15%
  weak where they overlap), in a fixed layer portalled into `.aura-app-shell` as its LOWEST layer
  (`z-index: -2` in the shell's stacking context: under the title bar, the rail, the page and the hero
  underglow at -1; the shell itself stays transparent). VISIBLE ON EVERY THEME since 2026-11-22 (the
  user's call): it used to be portalled to `<body>` at -40, where the opaque `--ln-bg` that html,
  body and #root paint covered it on every theme but Mica (Haze showed about 30% of it through its
  0.45 page), while the rail and search bar crops and the row-title tint still showed it: the rail
  read teal on a brown Ember page. Measured (harness, 1600 x 900, Liquid, gap between the rail and
  the hero, luma shown minus hidden): Mica +27 (unchanged), Haze +9 to +31, Midnight 0 to +35, every
  tinted theme 0 to +31 to +32; above the hero +16 (Mica) / +19 to +21; no banding (identical-pixel
  runs 3 to 4 px, Midnight included); Home pixel-identical otherwise. One strength for every theme:
  Aura has no light theme, and on the darker pages the result stays below Mica's absolute level
  (gap rgb 30,54,57 Ember, 18,46,52 Midnight, against 43,71,81 Mica). Two layers crossfade (900 ms, the `ease` curve) on a slide change,
  each layer's opacity written by HeroBleed from ONE clock that also drives the corner patch (round 19:
  a CSS transition here against a script-timed patch differed by up to 4.5 levels mid-fade); the
  layers' opacity also carries the scroll fade, which falls to 30% as the hero scrolls away (0.02 steps, about 35 writes per long
  scroll). Hidden under `html.playing-video` and on High Contrast; exists only while the Home hero
  does. While a bleed image shows, the app-wide spectral sweep (`.aura-ambient`, AmbientAura) is dimmed
  to 30% (`.is-under-bleed`, a class on the one sweep element, 900 ms fade): at full strength it turned
  the A rail violet-grey (measured, review round 9); the bleed is Home's ambient colour.
  LEAVING HOME (2026-11-24; the user: the switch back to the theme colour was jarring): the bleed no
  longer vanishes with the page. HeroBleed's layout-effect cleanup copies its root into the shell beside
  the original BEFORE React removes it (so a passive cleanup flushed after a paint shows no gap), and the
  passive cleanup fades the copy out over `LEAVE_MS` (900 ms, `ease`, the sweep's own return curve) by
  scaling only the scroll-fade factor, so the page layers, the rail's face crop and its patch move
  together; holes are re-cut for the rail alone. A StrictMode re-run (original still connected), reduced
  motion and the player drop it at once. A new HeroBleed (back to Home mid-fade, or the carousel
  remounted on a new source in the same commit, counted by `mounted`) takes the shared state over BEFORE
  its first build (`handOver`: the old teardown runs then, never later), and the copy keeps fading only
  its own two layers under the new bleed. Never let an old instance's teardown run after a new one
  painted: it clears the rail's face, every patch, the tint and the sweep dim (review 2026-11-24).
- Banding under fixed glass: a glass surface over the bleed blurs its dither away and rounds the smooth
  result again (measured with no cut: runs of identical pixels 180 px inside the rail, 120 to 250 px in
  the search bar). So, as the mockup: the bleed is CUT OUT (holes in the bleed layer's mask, one per
  element: rectangular since round 18, see the corner patch below) under every fixed glass surface marked `[data-glass-bleed]` (the Home search bar) and the rail
  (`[data-aura-rail]`), and the same image is drawn in that surface's face instead: its `--lg-bleed`
  background layer (`background-attachment: fixed`, so it lines up with the bleed around it),
  cross-faded to `--lg-bleed-face` (Liquid 0.7, Frosted 0.33: about 1 - tint) x the scroll fade x 0.3
  while a `[data-glass-bleed]` surface holds focus (the search bar rises over the search dim, so the
  bleed around it is dimmed). The RAIL never takes the 0.3: it sits under that dim. Keyed on
  `:focus-within` alone, a click on a rail row (it focuses the row) dropped the rail's crop to 0.3 until a
  click elsewhere blurred it: the rail went darker and lost the hero tint (interior 66,53,53 to 47,44,50
  Liquid; the round 11 report). Through a slide change the crop is TWO layers, the new image over the
  old (new at a x m, old at a (1 - m) / (1 - a m): exactly the cross-fade's mix), NEVER one
  `-webkit-cross-fade(old, new)` (2026-11-24; the user: the menu and search bars "flash occasionally,
  quite consistently, when the hero item is being switched"). Chromium paints a cross-fade as NOTHING
  while either image is not ready, and every bleed image is a fresh blob url, not ready on its first
  frame (a minimal page: 0 against 140, ten of ten; decoding it first through an `Image` fixed that
  test but the async swap it needs reproduced the flash in the harness, two of six). So the rail and the
  search bar lost the whole bleed for a frame or two and showed the bare face over their hole (both at
  the same luma, 41 / 43 against 57 to 65, in the user's 3440 x 1392 video). As layers, an image that is
  not ready empties only its own layer, near 0 at the start of a fade (scratchpad `h/flash.cjs` +
  `flashana.py`, `h/xf2.cjs`, `h/xf3.cjs`). The page layers and the corner patch were always layers.
  A NEW IMAGE WHILE A FADE RUNS WAITS for the fade to end (only the newest one is kept, the others
  released), never replaces a layer mid-fade (2026-11-24; the user: "a sudden shift in color instead of
  a gradual fade-in", every time on Avengers: Endgame, whose palette landed a moment after the slide:
  its logo arrived late too). With two layers the new image went on the back one, which early in a fade
  is the OUTGOING image, still mostly shown, so it was swapped in place: in the user's video 26 to 29
  levels in one frame about 0.75 s after the slide changed; harness, two changes 150 ms apart, one frame
  carried 24.7 of a 32.8 level shift (rail 18.6), 300 ms 13.7; after, the largest step at any gap is 5
  (rail 3.5), an ordinary fade frame (scratchpad `h/jump.cjs` + `jumpana.py`). While an image waits,
  the running fade FINISHES WITHIN `HURRY_MS` (200 ms, linear from where it is): waiting out the whole
  fade made the bleed trail the slides by up to 0.9 s each when clicking through them (the user: "the
  delay seems to still be happening, somewhat inconsistently"). Harness: two clicks 150 / 300 ms apart
  and five 400 ms apart settle 0.89 to 1.02 s after the LAST click (one fade), largest frame step 6 to
  8.6 at the screencast's rate (scratchpad `h/rapid.cjs` + `rapidana.py`).
  THE NEIGHBOURS' PALETTES AND LOGOS ARE READ AHEAD (HeroCarousel.tsx, on every slide change, both
  neighbours; 2026-11-24, the user: on Endgame the bleed "seems to be pausing to wait for the logo to load
  before applying"). The palette was read only once a slide was current, from its art fetched again then
  (`no-store`), so a slide whose art was slow kept the LAST slide's bleed until it arrived (the video:
  about 0.5 s, released with the art and the logo, which was also fetched only then). Harness, art
  delayed 800 ms: Next to a warmed neighbour starts the bleed in 9 to 29 ms, a dot jump to a slide never
  next to the current one 830 ms (scratchpad `h/lat.cjs`, `ART_DELAY` in `h/common.cjs`). A dot jump
  still waits for its art.
  HERO LOGOS ARE LOADED AT THEIR SHOWN SIZE (`sizedLogo`, posterSize.ts: the TMDB `wNNN` rung covering
  440 CSS px x the display scale, w500 up to 1.5x that, `original` only past it; never the resize proxy,
  which re-encodes to JPEG and would lose the alpha). That, not the palette, was the rest of the Endgame
  lag: its TMDB `original` logo is a 7795 x 2877 PNG (10.7 MB, 22.4 Mpx) shown 96 px tall, and decoding
  it held the first frame after its slide change 327 to 344 ms with the main thread IDLE (long animation
  frame: `blocking 0`, about 30 ms of script; every other slide 9 to 46 ms), worst from two slides away
  (its decode had been dropped). Its w500 is 500 x 185 RGBA, 159 KB; the user confirmed the lag gone.
  Diagnosis notes for next time: timing logs printed straight to the DevConsole made IT re-render and
  scroll inside the measured task (buffer them and print later), and a DevTools recording missed the
  stall entirely (switching to DevTools also fires the focus library reload, about 277 ms of whole-app
  render in dev, a separate cost). Measured with the cut: rail 12 px, search 9 to 15 px, the open
  bleed 6 px, the underglow 4 to 5 px. Holes follow the elements (ResizeObserver, resize); a menu that
  opens over the bleed is not cut (accepted).
  HOLES FOLLOW POSITION, NOT ONLY SIZE (round 17; the user: "this weird black section of the search bar
  that appears sometimes ... it disappears when the hero item switches, and going back to the item it
  occured on does not make it appear again", 45.png: a dark crescent past the bar's rounded right end).
  A hole is cut from the element's rect and re-cut only on a window resize, a marked element resizing,
  the marked set changing or a slide build. The Home search bar can MOVE at the same size: its column is
  capped at `--hero-max-w` and centred (`mx-auto`) inside a container whose right padding is 36 + the page
  scrollbar's width (HomeView), so when the rows fill the page and the 10 px scrollbar appears, the bar
  slides 5 px left. The hole stayed where it was cut, and the strip between the bar's real end and the
  hole's end showed the window behind (no bleed there, and no glass either: it is OUTSIDE the bar's
  border box, so the sliced lens was never involved). Any slide change re-cut it, so going back to the
  same slide showed nothing. The order that leaves the right-end crescent is the common one: the first
  palette arrives (hole cut) before the rows make the page scroll. Fix (`HeroBleed.tsx`): the
  ResizeObserver also observes every ANCESTOR of each marked element up to the bleed's host
  (`.aura-app-shell`), content box, so a padding change fires: whatever moves a marked element without
  resizing it resizes one of them. Measured (scratchpad `r17/hole`: `repro2.cjs` cuts the holes with
  the scrollbar hidden, then lets it appear; Playwright's `--hide-scrollbars` default dropped, or the
  scrollbar is 0 px; 1600 x 900, 100% and 125%): hole minus bar 5 px on both sides and a 5 px dark strip
  (luma 31 to 35 against a page of 57 to 58, on black as the transparent window shows it) before; 0 px
  and no strip after. Cost: nothing new (`cost.cjs`, clip-path changes: idle 0, wheel scroll 0, pointer
  sweep 0, focus morph and blur 94 against 97 before, the bar's own per-frame resize). A new surface
  marked `[data-glass-bleed]` that can move by a TRANSFORM (which no ResizeObserver sees) must re-cut
  the holes itself.
  THE CORNER PATCH (round 18, reworked in round 19; the user, after round 17: "I still notice the clear
  light band in the app on some surfaces, primarily the menu bar, settings panels, and the search bar. Is
  it not possible to get rid of it entirely without compromising some of the glass effect?"). The last of
  the band on Home was the HOLE's shape: rounded like the element, while backdrop-filter reads the
  element's whole rectangular border box, so the bleed in the four box corners outside the radius (+16
  to +17 there) was in the backdrop and the 20 px blur pulled it into the ends (removing the page bleed
  or the bar's backdrop-filter made it flat; removing its face copy of the bleed or the refraction did
  not). A plain rectangular hole would show the transparent window in those corners. So
  (`HeroBleed.tsx` cutHoles, `glass-hero.css` "The corner patch"):
  - The hole is rectangular, and the element paints the bleed back itself where its face does not cover
    the hole (an element's own painting is never in its backdrop): two empty CHILDREN HeroBleed puts
    first in the element, z-index -1, `.aura-bleed-patch` (the same fixed image at the page's strength,
    its box the hole, masked to the four corners outside the radius, with the edge's own one device px
    antialiasing ramp, and a band per side out to the hole's edge) and over it `.aura-bleed-drop`, the
    element's drop shadow, so it still lies OVER the bleed there (the element's own `box-shadow` keeps
    its insets and `--lg-ring`). Their values are their own inline styles, written only on change.
    Shown only while HeroBleed marks the element (`data-bleed-patch`: ANY page layer still showing, so
    through a fade OUT to no bleed too; clearing it on that fade's first frame left the box corners and
    band black for 0.8 s, -27 levels; a fade in from no bleed runs the same eased clock, never at once) and not on
    High Contrast or over the video, where the element paints exactly as before, shadow included.
  - The patch image is the page bleed's two layers, stacked as the page stacks them, each at the very
    opacity the page layer has (crossfade times scroll fade), from the one clock above. The search
    bar's patch follows the search dim with `filter: brightness(0.3)` on `.is-open` (same 220 / 340 ms
    ease-out as the dim): brightness keeps the alpha, so patch over the dimmed page equals the dim over
    the bleed (opacity left the page's share undimmed: +8 to +10).
  - THE PAGE BLEED'S MASK IS A UNION OF PLAIN RECTANGLES (mask layers add as source-over): the layer
    minus each hole, as bands between the holes' edges. Never a hole EXCLUDED from a full-layer image
    (round 18): Chromium composites that mask soft and a fraction of a pixel wide at 125%, 26% of the
    bleed missing from the device column just outside the rail's hole (-6.3 levels on the transparent
    window, -3.8 mica, +3.9 light, the round 19 audit) and 3% from the row outside every top and left
    edge. A clip-path is softer still (75 / 25% edge rows, a quarter pixel off). Rectangles on whole
    device pixels come out exact.
  - Its hard part runs from the painted box out to at least 1 CSS px past it (the blur also reads a
    partly covered edge pixel and, at 125%, one more: +1.4 to +2 levels with the hole on the box's outer
    pixel), on a grid whole in CSS and device px (`pixelGrid`); each band runs from the hole's edge to
    the INNER of the CSS px and device px snap of the box. (The first round 18 cut ended on the box's
    outer pixel with no band: the rail's top is at 103.5 px and painted from 104, so row 103 was painted
    by no one, a BLACK LINE along the rail's top on the transparent window, -26 to -30, the user's 47.png.)
  - At 100% and 200% the page bleed and the patch meet on a HARD edge: both land on the same device
    pixels (measured with both painted white: they never overlap and never leave a gap) and nothing
    outside the shape changes. At 125%, 150% and 175% the element's composited layer has a fractional
    origin (its drop shadow's reach decides it, a whole number of CSS px) and is drawn resampled a
    fraction of a pixel off: a hard edge there left a -7 to -15 level row (the patch's first row).
    So there the two cross-fade over 4 px (`FEATHER`), one ramp per axis across the whole hole box
    (the patch's two intersected, fx x fy; the page's two added, 1 - fx x fy, exactly its complement):
    two pieces of the patch meeting inside the ramp left a -4 row where they met. Moving the layer onto
    whole pixels would sharpen the element's own face and border too, which it has always been drawn
    without, so it stays.
  - Cost: CHILDREN, NOT ::before / ::after. Round 18's pseudo pair cost +54 ms of style per focus and
    blur cycle and +25 to +35% at idle, on a pointer sweep and on a slide change: a pseudo-element is
    styled again whenever its element is (the cursor light writes the rail's and the bar's inline style
    about 24 times a second; the bar's width morph every frame), and every pseudo-element here is costly
    (the `*, ::before, ::after` base rules); even with `content: none` the cost stayed. Children are
    restyled only when the element's INHERITED style changes. And NOTHING in them may say `inherit`
    (the drop shadow's radius is written as a value): one child inheriting a non-inherited property makes
    Blink restyle every child of the element whenever the element restyles (+30% per focus and blur;
    the input's inner editor restyled every frame). The geometry is written only when a value changes,
    and not while only the width moves FAST (the focus morph: the patch keeps its reach and the hole
    follows it, on whole device px; an exact cut 150 ms after the last frame); the page mask is written
    only when its string changes. Two rules from the user's "black line at the left side of the search
    field when unfocused" (2026-11-24, a video: -7 levels in the column beside the left rim for about
    170 ms after the bar came to rest, -25 on its first frame): (1) the cheap cut's hole is rounded to
    whole device px (a fractional hole edge left a column the page's rectangles only partly cover: a
    seam beside the end, -3.8 mean at a 1366 px window, 125%); (2) once the left edge moves under 1 CSS
    px between frames (the spring's tail, about 100 ms that reads as still) each frame takes the exact
    cut, or the patch keeps the corner arcs cut for the open bar (the line at a 1280 px window). After:
    outside the bar within 0.5 of rest, two frames after `transitionend` (1280 / 1366 / 1440 / 1500,
    mica / transparent / light). It shows only when the open and closed bar sit on different 4 px grid
    phases at 125%: at 1600 the column is such that they match and nothing differs (scratchpad
    `h/tend.cjs` + `tcmp.py` / `tout.py`, `h/tl.cjs` for the per-frame timeline).
  Measured (round 19, scratchpad `r20`: `cap.cjs` + `ana.py`, `cov2.cjs`, `abl.cjs`, `ext.cjs`, `ext2.cjs`
  + `slideana.py` / `blurana.py`, `hc.cjs` + `hcana.py`, `heroring2.cjs`, `costq.cjs` / `focabl.cjs` /
  `trace.cjs`; Home, contents hidden; mica on a transparent window, mica, red-brown, bright, light; 100%
  and 125%; pointer out, far, near the bar, near the rail, bar focused; Liquid and Matte; against the
  pre-round-18 code and the round 18 tree):
  - Leak (shot minus the page bleed hidden, inside): 0 on the rail and the bar's ends and corners at both
    scales in every pointer state, Liquid and Matte (before round 18 up to +5.6 R); the bar's top and
    bottom sides keep their pre-existing +0.6 to +1.6 (the same before round 18).
  - Outside the shape (shot minus no hole and no patch): at 100% the straight sides 1 to 14 px out are 0
    (round 18's feather: -0.5 to -2.3); the corners and the first row past the bar's box single pixels of
    +-2 to 3 (+-1 to 2 along a side); the rail's top edge row -1.2 (pre-round-18 -13.3, the half row). At
    125%: the round 18 column at the rail hole's right edge gone (-6.3 to -1.2 or better on every page);
    the feather a smooth -2 at most on the transparent window, -1.5 on opaque pages; the first row past
    the rail's top -5.2 (pre-round-18 -13.4); the first row past the bar's top -8.0 (-7.1, pre-existing
    pixel snapping); Matte the same within 1.
  - High Contrast at 125% (round 18: the rail's top rows 16 / 77 / 30 -> 0 / 93 / 30): identical to the
    pre-round-18 rows and top corners on Home and Settings, Liquid and Matte; Settings identical (2 at
    most) on every page; the rail's top corners on Home differ by +0.6 to +1.6 mean, the dark fringe the
    old rounded hole left there (the patch fills the half row).
  - Slide change (the patch's corner minus the page, each frame against its settled value): within
    +-1.3 at both scales (pre-round-18 +-1.2; round 18 -4.8 on the first frame, +-3.5 mid-fade).
  - Focus morph: hole and patch within 0.016 px of each other in every frame; against pre-round-18
    outside the bar at most +-3.6 at 100%, -5.7 / +5.5 at 125% from t0 to t80 (round 18 the same),
    settled by 250 ms; blur morph (dim timer held) within 0.4 of pre-round-18 in every frame. The
    round 17 crescent (5 px slide) and window resizes: holes and patch follow, mismatch 0.
  Interleaved cost (`costq.cjs`, 4 rounds, style ms, pre-round-18 / round 18 / round 19): idle 3 s 92 /
  126 / 91, wheel 266 / 282 / 274, pointer sweep 245 / 321 / 254, focus and blur x3 177 / 369 / 198
  (task 1096 / 1224 / 1180), two slide changes 277 / 474 / 236 (task 939 / 1177 / 784: the crossfade now
  writes the patch once per frame on two small children instead of restyling the elements twice).

## The Home cards (`CinemaRows.tsx`, `cardGlow.ts`, `styles/glass-cards.css`, round 9)

CatalogCard (Home rows, Search rows, the View-all popup) and ContinueWatchingCard (Home CW, the Airing
page). Cards are CONTENT (the user's round 2 call): no backdrop pass on a card, ever. Both materials.

- BEZEL: `.aura-card-bezel`, a rim-only light surface (`data-glass-light="rim"`) laid over the art box
  (absolute, inset 0, radius inherited, z 25, pointer-events none). Idle rim 0.18 / 0.06 / 0.10; lit by
  the cursor light like any rim surface (nearby reach, bounce, dispersion). It REPLACES the art box's
  old 1px white/0.08 border (the box keeps its outer size: aspect-ratio applies to the border box, so
  the row stride is unchanged). No paint worklet: an inset 1px white/0.08 hairline; High Contrast: an
  inset 1px white/0.35 (its idle rim is off).
- FROST on the art (the user's pick, the mockup's `.fr` with `data-badge=real`): `.aura-frost` is a
  rgb(15 17 22 / 0.45) fill, a white 0.15 hairline, `backdrop-filter: blur(12px) saturate(140%)`, idle
  rim 0.30 / 0.04 / 0.16, and is a rim-only light surface, so its `background` starts with
  `var(--lg-rim-layer)`. Used by the SxxEyy badge (radius 7, 8 px in), the countdown pill (bottom 28),
  the CW remove button (`.aura-frost-btn`, hover only), the watch mark (below) and every progress
  track (`.aura-frost-track`: a pill 8 px in from the sides and 7 px up, 3 px padding round a rounded
  `.aura-frost-bar`, 5 px, 4 px on posters (`is-thin`); empty part white 0.12). The season bar's
  segments round only their first and last ends; the pill takes the bar's hover. Hardware acceleration off (`<html data-glass-gpu="off">`):
  FAUX frost, no backdrop (rgb(26 29 38 / 0.66), hairline 0.13, inset 8 px white 0.03). Cost: one small
  backdrop pass per badge (about 21 on a Home with 6 CW cards and a few marked posters); the badges sit in
  the card, so the art is their whole backdrop.
  CONTINUE WATCHING takes the FAUX frost since round 12 (`.aura-cw-card`, the CW card root: SxxEyy,
  countdown, tracks, remove button; the user: "get rid of the real frost on the continue watching badges
  if it will gain a lot of FPS"). Each CW frost element was a 12 px backdrop pass re-run whenever its card
  repainted (the cursor light on the bezel or on the badge itself). In-page A/B on Home at 2575 x 1038,
  Cursor glow on, with the round 12 light fixes in: pointer sweeping the CW row 96 to 107 fps, wheel
  scrolling 178 to 214, moving while scrolling 174 to 215 (all frost faux: 115 / 219 / 225, so the
  poster marks and tracks, few and small, keep the real frost the user picked). Side by side the faux
  badge is a touch denser (the art behind S01E08 shows a little less); the Airing grid already used it.
  ONE LIT SURFACE PER CW CARD (round 12 review): the bezel takes the cursor light; the progress track
  (all three bar kinds), the SxxEyy badge and the countdown pill keep their idle rim but carry
  `data-glass-glint="off"`. Each lit one repainted its whole card on every light frame, so the cost
  grew with every visible CW card. In-page A/B on Home, pointer sweeping the CW row: 184 to 215 fps
  (2575 x 1038), 184 to 214 (1600 x 900); moving slowly 201 to 224 and 203 to 234. The remove button
  stays lit (it shows only on the hovered card).
- HOVER UNDERGLOW (`cardGlow.ts`): the hovered card's art-tinted contact shadow plus halo, the hero's
  `underglowImage` at `scale` 0.6 (sigmas 15.6 / 37, pad 66 px; contact shadow = the art's raw middle x
  0.22 at 0.55, halo = its vivid centre at 0.22; neutral black shadow only when the art is not proxied),
  ONE dithered image (measured in the gaps beside the card: runs of identical pixels 4 to 6 px; with no
  palette, aH 0, the contact shadow carries the dither itself, at the same total amplitude). It
  replaces the old hover `drop-shadow(0 6px 22px)` filter on cards inside a glow host (that blur banded,
  and the filter made the card a backdrop root). Each row `<section data-card-glow-host>` renders two empty
  `.aura-card-glow` slots as its FIRST children, so the glow paints under every card of the row (it shows
  in the gaps and around the row, never over a neighbour's art); the two crossfade when the hover moves.
  One delegated `pointerover` on the document, a 90 ms hover intent, no React state; geometry is laid out
  for the hovered scale (1.02) about the card's centre whatever the transition has reached; the halo fades
  instead of being cut where the page scroller's clip box is closer than the pad (left / right). Palettes
  come from `heroPalette` (LRU 32, shared with the hero); images from an LRU of 12 blob urls, revoked on
  eviction. A card the pointer rests on while the page scrolls glows once the scroll settles (unless it is
  `data-hover-held`, which glows at once). Outside a host (Airing page, View-all popup) and on High
  Contrast the old drop-shadow stays and no glow is drawn; hidden under `html.playing-video`.
- TYPE: the hovered card's title (`.aura-card-title`) takes the chrome's selection colour, accent 34% into
  white (the rail's active label); restored while a scroll carries cards under the pointer. Sizes are
  unchanged (19 / 15.5 mono posters, 17 / 14 mono CW), so the fixed title block and stride hold.
- ROW HEADER: title (round 11, next bullet), CW's mono "N in progress", and "View all" as a small
  flat glass control (`.aura-glass-flat.aura-row-viewall`, `data-glass-light="control"`: 30 px pill, mono
  13 px, accent chevron that springs 2 px right on hover), so the cursor light reaches it. The header is
  `items-center`, 32 px in every row state (the reserved invisible button keeps the same markup).
- ROW TITLES (`.aura-row-title`, round 11; the user: they should "react to the bleeding colour around
  them and the cursor glow primarily", the animated accent gradient "should probably go"). The 20 s
  accent shimmer is GONE everywhere the class is used (Home rows and every page title), with its
  scrolling / idle / user-idle pause entries and reduced-motion entries (the hero title keeps its own).
  One static fill: a near-white base (white 238 / 240 / 244; 222 / 225 / 232 on lit-capable titles
  while Cursor glow is on, so the light has room) mixed in oklab with `--lg-bleed-tint` at
  `--lg-bleed-tint-k` x 42%, a dark 1 px contact shadow and an 8 px glow in the tint (k x 20%) instead
  of the accent halo. No accent anywhere (decision: "Continue Watching" no longer has an accent second
  word; the theme accent stays on the rail, the toggles and the card hover title). Home row titles
  (CW and DiscoveryRow, CinemaRows.tsx) carry `data-glass-light="text"` (the cursor light, above) and
  `ref={bleedTitleRef}` (`src/bleedTint.ts`): HeroBleed hands over its glows and scroll fade, and each
  title takes the glow-weighted colour of the bleed AT ITS OWN POSITION, k = fade x summed alpha / the
  bleed strength (harness: CW title 0.75, the next row 0.3, the third 0.05; after the hero scrolls away
  0.2 to 0.4 near the top glow). Both registered NON-INHERITING (`<color>`, `<number>`), written per
  title, never on an ancestor, quantised (k 0.05, channels 6) and written only on change; transitioned
  900 / 700 ms (none under reduced motion). Updates run on a slide change, a registration and a
  settled scroll: during a user-driven scroll (`data-aura-scrolling`) they wait (one observer on
  `<html>` while one is pending). No bleed (no palette, another page) writes nothing: neutral. High
  Contrast: plain white, `--lg-bleed-tint-k: 0 !important` beats the inline write. Contrast: the tinted
  fill on the teal test art measured rgb(175 206 218) on a page of about 40.
- WATCH MARK (round 12, `WatchedBadge material="frost"`, `.aura-frost.aura-watch-mark.is-<state>`): the
  user asked whether the queue icon got smaller. The disc did not (22 px since before round 9), but round
  9 swapped the SOLID disc (white glyph on an 85% accent fill) for a dark frost disc with only the glyph
  coloured, so the coloured mass shrank from a 22 px disc to an 8 x 10 px bookmark, and the in-progress
  mark was a bare 8 px dot. Now every state is ONE size: a 26 px disc, a 15 px glyph (`MarkGlyph`, shared
  with the solid badge, a 1-unit stroke in the fill colour thickens the check), 8 px in (`top-2 left-2`)
  on CatalogCard, Library, Queue, Discover and the catalog page. In progress is a half-filled ring (same
  size as the check, reads "partly done" by shape). The disc carries a 0.14 wash of the state's colour
  (`--wm-rgb`: emerald, purple, amber, the accent for planned) and a 0.42 tinted hairline over a 0.72 dark
  base (0.82 with no backdrop: GPU off and the page grids' faux frost); glyphs emerald-300 / purple-300
  / amber-300 / `--ln-accent-mark`. At 0.62 the check read weak on a white sky. The SOLID badge (detail
  episode rows, the CW title suffix) is likewise one 22 px disc with a 13 px glyph for every state (in
  progress was a 14 px dot): amber with a dark glyph, planned's glyph in `text-ln-accent-ink`.
- POSTER TRACK over rating chips (round 12, `PosterProgressTrack` in CinemaRows.tsx, `.aura-frost-track.is-poster`):
  rating posters (RPDB, AIOMetadata `/poster`) bake their chips into the bottom of the image (measured on
  the user's posters: the bottom 8.1% of the art), so the 7 px-up track sat across them. On EVERY poster
  the track sits at `bottom: calc(8.5% + 4px)` (a percentage bottom is a share of the art height, so it
  scales: about 5 to 7 px clear above the chips). Not per url: any host can serve a rating poster and a
  failed RPDB url falls back to a plain one; one height keeps a row's bars in line. CatalogCard (Home,
  Search) and the catalog page's poster card (which now also carries the watch mark and the track).
- CW BAR TINTS (round 12): the latest-aired caret (a bobbing green chevron above the bar) is GONE, with
  its keyframes and its scrolling / idle / reduced-motion entries: it clipped into the countdown pill. The
  bar says what has aired by tint alone, the detail page's Your Progress tokens exactly (DetailView.tsx
  `SEG_CLASS`): skipped purple-400, watched (manual or implied) emerald-400, in progress amber-400, aired
  white/70, not aired white/15. The long-runner (continuous) bar draws white/70 up to the last aired
  episode over a white/15 track, under its fill. The countdown pill (bottom 28) clears the track (top at
  20 px) by 8 px.
- RESET PROGRESS (round 12, App.tsx card menu): any card whose library record has `state.timeOffset > 0`
  (catalog, poster, Library, Queue, Discover, Airing) offers "Reset Progress" after the divider, with a
  hint that the title leaves Continue Watching. It dispatches the same `aura:cw-clear` as the CW card's X
  (optimistic zero in `library` and the raw snapshot, then a FRESH `library_get` and
  `libraryClearProgress` on that title's fresh raw records: Stremio's Rewind, timeOffset only; never the
  up-to-5-minute-old snapshot, which could bring back a title another device removed. With no record
  left on the account the title is dropped locally and nothing is written). Not on a CW card, whose "Remove from Continue Watching" is the same act.
  The menu item asks first (round 12, user's call): `askConfirm` with a `points` list (position cleared
  and the bar goes, or the watched check when the saved position was finished and no hand-set watched
  mark holds it; it leaves Continue Watching; the write reaches the Stremio account, so official apps and
  other devices follow; for a series, watched episodes and the `video_id` place are kept), `tone:
  "danger"` and `defaultFocus: "cancel"`, and dispatches only on confirm. Every line states what
  `libraryClearProgress` really does: change one and that function together. The CW X stays unprompted.
  A failed fresh read (or an empty one) or a failed `libraryClearProgress` writes nothing more and rolls back: SESSION_EXPIRED signs out when the key is still current,
  and an account change drops the result. Otherwise the id leaves `recentlyCleared`, the offset comes
  back where it is still the optimistic zero, a danger toast 'Could not reset progress for "<name>"'
  shows, and `aura:library-changed` re-reads the row.
- CONFIRM DIALOG options (`ConfirmDialog.tsx`): `points` draws a short bulleted list between `message`
  and `detail` (white 0.70; `detail` is white 0.55, the glass text floor). `defaultFocus: "cancel"`
  focuses Cancel. In BOTH modes Enter presses the FOCUSED button (with neither focused it falls back to
  `defaultFocus`: confirm, or cancel under `"cancel"`), so a stray Enter on a Cancel-first question never
  acts; Tab to the confirm button, then Enter, confirms once. Tab / Shift+Tab wrap between the two
  buttons; Escape / Enter / Tab are stopped in the capture listener, so App's Escape ladder never also
  closes the page underneath; a second `askConfirm` resolves the pending one as false. Focus is set once
  per opening, never on a re-render. Use it for any question whose confirm writes to the account or loses data.
- The CW countdown pill never wraps (`whitespace-nowrap`) and is DROPPED on a card under 150 px of art
  (`.aura-cw-countdown` is a width container; a 900 px window gives about 85 px): there it wrapped to two
  lines over the SxxEyy badge and was clipped by the card top.
- Real-frost cost: one 12 px backdrop pass per frost element, bounded by the row virtualization; the
  conventions rule "small card controls take no backdrop-blur" names this as its one exception.
  Measured round 11 (RTX 4090, 240 Hz, 2575 x 1038, 17 frost elements on the harness Home): turning
  every frost backdrop off took wheel scrolling from about 180 to 215 fps and pointer movement from
  about 153 to 190 (the progress tracks are about half of it). Round 12 pulled that lever for the CW
  cards only (above); poster marks and tracks keep it.
- `cardGlow.ts` reads High Contrast from `getGlassState().contrastFloor` (the `--lg-glint-off` fact),
  never a theme id.
- Library, Queue, Discover, Catalog and Airing have their own poster components; since round 11 they
  carry the bezel and FAUX frost badges (no backdrop pass, no card underglow): see "In-page sheets and
  pages" R4.

## Home performance (round 11)

The user: "FPS also seems a bit lower than before on the homepage and while scrolling it" (their
Performance Monitor: about 63 fps / 16 ms on a 240 Hz display, interface CPU 14%). Measured in a Vite
harness rendering the real Home (rail, search bar, hero with bleed and underglow, CW row with frost,
two catalog rows) in headed Chromium on the maintainer's RTX 4090 at 240 Hz, with DevTools tracing for
the per-thread breakdown. The Performance Monitor's frame figure is the rAF rate, so it reads how long
a frame takes when frames are drawn, and on an idle Home something always drew one.

Causes, largest first (each confirmed by turning it off alone):

1. The Liquid search bar's sliced lens: its feImage bitmaps (four 1536 x 42) are re-sent with EVERY
   frame (see "Sliced filters" above), about 4.5 ms of every frame across the renderer compositor and
   viz. Fixed: two 46 x 42 caps and a 1 px column, same pixels.
2. Decorative loops forcing a full redraw every display frame: the title-bar sweep and AURA wordmark
   (`background-position`, main-thread paint) and the window-wide ambient sweep (a compositor transform,
   but it damages the whole window). Every damaged frame redrew every backdrop pass (about 23: the 17
   frost elements, the rail, the search bar, the hero chip and arrows), about 4 to 5 ms of GPU-process
   time. Fixed: `steps()` at 30 updates a second (`.aura-sweep` / `.aura-title` `steps(600)` over 20 s,
   `.aura-ambient::before` `steps(1080)` over 36 s); a step moves a soft low-alpha gradient by a few
   pixels (under a third of a level), so nothing visible changed, and the 210 frames a second in between
   have no damage. RULE: a slow decorative drift runs at about 30 steps a second, never per display frame.
3. Image skeletons below the fold shimmering forever (the page scroller clips them, so ImageLoader's
   observer never fires until they scroll into view): about 3 ms of GPU time per frame with two rows
   parked. Fixed: `data-skeleton-parked` holds the shimmer still until the tile is in view.
4. Pointer movement: the rim worklet's clip + fill (see "The cursor light", now stroked) and lighting
   transparent surfaces (now skipped).

Before / after (fps = the rAF rate the Performance Monitor shows, two runs each, Liquid; rest = pointer
still over the CW row, move = pointer sweeping the hero and CW row, scroll = smooth-wheel notches):

| Window | rest | pointer moving | wheel scrolling |
|--------|------|----------------|-----------------|
| 1600 x 900 | 86-91 to 168-172 | 47-49 to 66-70 | 100-101 to 142-146 |
| 2575 x 1038 | 73-79 to 178 | 56-58 to 95-97 | 80 to 130-135 |
| 3440 x 1380 | 70-73 to 163-185 | 64 to 96-101 | 67-70 to 124-129 |

Frosted (Matte), 2575 x 1038: rest 172 to 240, move 100 to 161, scroll 224 to 230.

Left as is (measured, look-changing or legitimate): the real frost passes (above); the lit hero bezel
(1450 x 620, about 12% of the pointer-move frame while the pointer is over the hero); the hero arrows
while the hero is hovered (bound Liquid controls over the art); the CW latest-aired caret bob (a small
compositor loop, about 7 passes a frame, under 1 ms; removed in round 12 with the caret). Run-to-run variance between fresh launches is 10
to 20% here: compare variants inside one page load (alternating CSS overrides), not across launches.

### Round 12: Glass with Cursor glow on

The user: "prioritizing keeping a high framerate during actions like scrolling and mouse movement with
cursor glow on, without compromising the overall look". Same harness (headed Chromium, RTX 4090, 240 Hz)
plus Settings and the Detail page, a time-based pointer path (a brisk sweep peaking near 1900 px/s, a
slow one near 400 px/s), and every variant A/B'd inside one page load: the light's JS behaviours behind
flags in a harness copy of glassGlint.ts, the CSS as overrides, the worklet served from a copy with
draw modes. With Cursor glow OFF Home already held 220 to 240 fps in every scenario: the light was
the whole cost, and of it the GPU raster (each lit surface re-rasters the tiles under it and every
paint-worklet image in them, about 0.5 to 1.5 ms of GPU-process time per raster task).

Causes, largest first:

1. Lighting surfaces nobody can see (the row under the fold, within 300 px of the CW row). Fixed:
   IntersectionObserver visibility ("The cursor light", PERFORMANCE RULES).
2. The light running during a scroll whenever the pointer also moved (it only held for scroll-only
   frames). Fixed: the hold covers pointer moves and the tick.
3. Settings sheets repainting all their content with their light. Fixed: the overlay layer (R2).
4. Real frost on the CW badges re-blurred on every light frame. Fixed: faux frost on CW cards.
5. 240 light frames a second. Fixed: pacing to at most about 166 (every other frame at 240 Hz).
6. Faint far surfaces repainting per pixel of motion and invisible rings being stroked. Fixed: level of
   detail and the worklet's `VIS` skip.
7. (review) Several lit surfaces per CW card (bezel, track, SxxEyy badge, countdown), so a full CW row
   cost far more than the 6-card harness row. Fixed: only the bezel lights on a CW card ("The Home
   cards"). The poster watch marks and poster tracks keep real frost (the user's round 9 pick; the
   round 12 brief named only the CW badges): a review A/B measured about +15% on the pointer sweep with
   their backdrop off too, which is the next lever if the user wants it.

Before / after (fps = the rAF rate, median of 3 to 4 alternating runs in one page load; before = round
12 as the other agents left it, after = this round; Cursor glow off for reference):

| Page, window | rest | pointer sweep | pointer slow | over rail | over hero | wheel scroll | move + scroll |
|---|---|---|---|---|---|---|---|
| Home 2575 x 1038 | 232 to 239 | 61 to 134 | 63 to 177 | 99 to 147 | 105 to 187 | 141 to 221 | 64 to 212 |
| (glow off) | 240 | 237 | 236 | 234 | 239 | 226 | 220 |
| Home 1600 x 900 | 238 to 240 | 61 to 70 | 68 to 78 | 86 to 107 | | 158 to 215 | 62 to 220 |
| Settings 2575 x 1038 | | 103 to 219 | 133 to 234 | | | 232 to 235 | 89 to 236 |

FINAL, after the review fixes (CW single lit surface, pacing floor 4.5 ms), the reviewer's harness (8
CW cards, poster marks), headed, one session, median of 3 (glow off in brackets; this session's machine
ran faster than the perf pass's, so compare within a row only): Home 2575 x 1038 pointer sweep 199
(239), slow 212 (238), over the rail 203 (239), over the hero 232 (239), wheel scroll 232 (233), move +
scroll 229 (231); Home 1600 x 900 sweep 202 (239), slow 229 (240), scroll 233 (232), move + scroll 232
(234); Settings 2575 x 1038 sweep 238, slow 240, move + scroll 240 (240 each).

The Detail page (episodes panel, overview) already ran at 225 to 240 with the light on and did not
change. Still open, measured (before the review's CW fix, which took the 1600 x 900 sweep over the
cards to about 200): Home at 1600 x 900 with the pointer moving over the cards. The CW and
poster card bezels (rim-only worklet surfaces at `scale(0.94)`) are the cost: with their rim off the
slow sweep goes 73 to 183, and with the worklet drawing nothing at all 66 to 110. Each lit bezel
re-rasters its row's tile, with every other bezel's and badge's worklet image in it. The fix that
worked (a layer per lit bezel) resamples the scaled bezel (see "Measured and rejected" in "The cursor
light"); a next attempt would need the bezel off the scaled card or a cheaper idle rim than a
worklet image.

## Over the video: material only

The video is a native mpv child window UNDER the WebView2, so `backdrop-filter` samples nothing
there. Every surface over playback uses `.aura-glass-player` (baked dark base, the material's
shading, the glint, no backdrop pass) and is never refracted. A panel that can open both in the app
and over the player switches class or sets `data-liquid="off"` while a player is active (see
`WatchTogetherPanel.tsx` and `SeasonSelect`'s `overPlayer` prop).

### The player A face (round 11, `styles/glass-player.css`)

The user asked whether the player could use the rail's look. What is NOT possible without the
shelved shader: any live blur of the video (a backdrop-filter over the player samples only the
transparent webview, and still costs a GPU pass, so none is ever added). What IS possible, and is
built: everything in the A language that is not the blur.

- Face: Liquid the rail's neutral tint (rgb 14 16 22) plus the even 0.02 white lift, but at 0.86
  instead of 0.30 because nothing behind is blurred; no border ring (the idle rim is the edge), the A
  inner glow at zero alpha since round 17 (`inset 0 0 22px` white 0.012 before, the band of "The A
  control tier"; still four inset entries so state changes interpolate) and the A drop (`0 1px 2px` 0.3, `0 18px 48px` 0.55, a zero third entry). Frosted: the Frosted float
  recipe (rgb 12 14 19 at 0.86 plus a 0.025 lift, white 0.12 ring, lit top / dark bottom hairlines).
  FLAT faces in both (a vertical ramp across the 1100 px bar would step at 8 bits).
- 0.86 is measured: the lightest tint that keeps white 0.55 at 4.5:1 over a pure white frame (face
  about 52 over white, 4.9:1; white 0.6 about 5.5:1). The top-left stack is 0.9; High Contrast 0.95
  plus the 0.35 white edge floor (App.css's floor lists only the page classes).
- Idle rim (Liquid, 0.18 / 0.03 / 0.11, the rail's) on every player surface, ring layer always on;
  the cursor light already lit `.aura-glass-player` (glassGlint's selector), so the rim light,
  dispersion and the 3.5% interior light reach the bar, menus and dialogs.
- Text: one tight shadow (`0 1px 1px` black 0.35) instead of the 2 px + 1 px pair; the stack, toast and
  party HUD inline shadows were tightened to match. Small grey text is white 0.6 or more in every
  player file (was 0.35 to 0.5 in places), the time separator 0.5. Accent TEXT inside a player surface
  is `--ln-accent-mark-text` (a CSS remap of `.text-ln-accent` and its /80 /85 /90 inside
  `.aura-glass-player`, so Cast and the subtitle sync panel follow); the raw Mica accent measured 2.1 to
  2.6:1 on a menu over a white frame.
- Selected rows (`.is-selected`, `aria-current`, `aria-selected`; never an on switch): the rail's lit
  label (Liquid accent 34% into white, Frosted the mark text) and, in Liquid, the rail's active-pill
  face (white 0.075, `var(--lg-rim-layer)` first, idle 0.30 / 0.04 / 0.16, inset glow, `0 2px 8px`
  drop). `PlayerMenuRow` puts `data-glass-light="rim"` on its selected row so the cursor light draws
  that rim. Segmented labels inside the player: idle white 0.62, Liquid selected in the lit colour.
- Hover: one sliding droplet per list in Liquid (`useListDroplet`, `.aura-glass-hl.aura-player-hl`: 6 px
  in, 12 px corners, the rail's faint fill white 0.05 to 0.035, no rim): every `PlayerMenuPanel` body,
  Switch source (`.aura-glass-item` rows, 8 px in) and the subtitle search list. Direct row children
  of a droplet list inside a player surface sit at `z-index: 1` over the droplet.
- Radii: docked menus 18 px (12 px rows 6 px in: concentric), the bar 22 px (the rail's), dialogs and
  the stack 20 px, End of stream 24 px, the scrubber tooltip and thumbnail 10 px, the time chip 7 px.
- Measured (round 11 harness: the overlay and every player surface rendered over a pure white and a
  bright busy image where the video sits, text hidden, 5th-percentile contrast of each text box): every
  enabled text in the bar, speed, audio, subtitles, subtitle style, upscaler, More, Switch source,
  AuraSkip, Resume, Next-Up stack and End of stream at 4.5:1 or more in both materials, both frames
  (lowest about 4.7, the selected upscaler row). Only disabled controls (opacity 0.4) stay under.
- The top bar (PlayerOverlay, 2026-11-22, the user: "getting rid of the glass around the
  title/SxxEyy info will help, as well as changing the exit playback button to simply contain a back
  arrow icon with no text, keeping the glass style"):
  - Back button: icon only (the Material back arrow DetailView uses), a 40 px `.aura-glass-player`
    disc (`.aura-player-back`, the material, no backdrop), `aria-label` "Exit playback", the app
    Tooltip "Exit playback" with the `Esc` hint only while windowed (in fullscreen Esc leaves
    fullscreen first), a 2 px white 0.8 `outline` focus ring (an outline, so the material's
    box-shadow stack cannot hide it).
  - Title block (series title, SxxEyy, episode title, chapter range): NO surface. The 4.5:1
    surface rule above is waived for this block ONLY (the user's explicit override); every other
    player text still sits on a player surface. It is plain text vertically centred on the button,
    and the row's `left-6` is the stack's own inset, so the button's edge and the skip card's edge
    line up (it was `left-4`, 8 px off). `playerStackBaseTop` is 84 / 120 (fs / windowed): the
    51 px header plus a 16 px gap. The faded top row takes no pointer events (`pointerEvents` follows
    `controlsVisible`), so a blind click while hidden reaches the video, and an open tooltip hides
    with the controls (`html.aura-cursor-hidden [role="tooltip"]`, App.css).
  - Legibility (`glass-player.css` "The top bar"): the top scrim (`.aura-player-top-scrim`, 0.68 /
    0.55 at 40% / 0.2 at 72% / 0, 10rem; windowed it starts under the 36 px TitleBar), a soft corner
    shade behind the title only (its `::after`, radial 0.22 to 0 over about 760 x 130 px, no edge),
    and a dense tight shadow (two 1 px black rings, a 2 px 0.9 ring, a `0 1px 3px` 0.6 drop; never a
    wide halo). The SxxEyy code is the accent on-glass colour floored at oklch l 0.88 (not 0.8: it
    sits on the bare video), so a dark custom accent stays readable.
  - Measured (r13 harness, both materials, windowed and fullscreen; white text against the
    95th-percentile pixel 1 to 3 px outside the glyphs, then against the bare background with no
    shadow): pure white frame title 7.9 / 7.0, episode title 5.3 / 4.7, SxxEyy 4.8 to 4.9 / 4.1 to
    4.3; bright busy frame title 9.0 / 8.0, episode title 6.0 / 5.3, SxxEyy 5.5 to 5.7 / 4.8 to 5.1;
    a dark navy custom accent SxxEyy 4.7 / 4.0 on white. Before (the old scrim, the one-ring shadow,
    no surface) the episode line measured 2.0 to 2.7 on white, so the scrim and shade are needed, not
    only the shadow. Re-measure before thinning any of the three.
- Unchanged: every behaviour, shortcut, auto-hide timing, the 36 px windowed top-bar offset, the
  vignette and its preceding-sibling rule, and the shelved real-glass rules (they sit at higher
  specificity and still win when the flag returns).

**Real glass is SHELVED** (2026-11-18): `REAL_GLASS_AVAILABLE = false` in `src/realGlass.ts` hides
its Settings row, keeps it out of the "New look options" notice, and never sets `data-real-glass="on"`
(nor sends `player_glass`), so every rule below is dormant: each one is scoped to that attribute (the
vignette through `:has(~ * .aura-player-bar[data-real-glass="on"])`), and the `glassGlint.ts` guard
never matches. Over the video every surface keeps its normal baked fill. Why it was shelved and how
to bring it back: `.claude/rules/mpv.md` "Real glass over video". The notes below describe it as it
would be with the flag on.

Under real glass (`data-real-glass="on"`, `mpv/glass.rs`) the player face is a flat faint tint in
Frosted and only a flat white sheen with a lit rim in Liquid (`glass-misc.css`; a vertical ramp
banded over the smooth blur) with a TIGHT text / icon shadow (one `0 1px 2px` text shadow, no wide
halo: a wide dark halo or drop shadow reads as a dark pill or disc on the lifted glass), NO cursor
glint on the surface or anything inside it (`glassGlint.ts` `usable()` skips `[data-real-glass="on"]`
and the CSS blanks `--lg-glint` / `--lg-rimlight` there: an 8-bit light over the blur banded into
rings), lighter nested Liquid controls (flat buttons get a white sheen with no dark tint or drop and
a transparent border instead of the dark `--lg-face-ring`, which only stands in for the page filter, the
upscaler pill a lit top with no dark pool, `.aura-glass-field` and `.aura-glass-seg` shallower wells;
the Liquid toggle is untouched), the bar's dim time text (`.aura-player-time-dim`) brightened to
white 0.8, and PlayerOverlay's
bottom vignette (`.aura-player-vignette`, an eased smoothstep ramp scaled by `--aura-vignette-a`) drops
to 0 while the bar (`.aura-player-bar`) is marked; the vignette must stay a preceding sibling of the
bar's wrapper. Tuned together with `glass::look` (`.claude/rules/mpv.md`).

Nothing in CSS can soften what sits UNDER a player surface: subtitles are mpv overlays drawn after the
real-glass OUTPUT hook (`blend-subtitles` is never set), so under real glass subtitles beneath an open
player menu stay near full contrast. The only lever is the face's own opacity (a partial dark veil on
docked menus under `[data-real-glass="on"]`, retuned jointly with `glass::look`).

### The buffering overlay (`PlayerOverlay.tsx` BufferingOverlay, App.css "BufferingOverlay legibility" / "size")

Not glass, but it sits on the video, so the 8-bit no-dither rule governs it: no scrim, NO GLOW. A
coloured or dark `drop-shadow` wider than about 3 px is the silhouette blurred, so it hugs the letter
or logo shape and reads as a blob outline (user report 2026-11-19; the old 10 px / 6 px dark halos and
14 px / 16 px accent glows measured a 19 to 29 px coloured band, now 3 to 7 px and no colour), and a
shape-independent ambient light would be a large slow gradient over video, which bands. Legibility is
a tight dark edge only (title: 1 px + 1.5 px outline + 2.5 px contact shadow, same edge darkness on a
white frame as before; logo: 1 px + 2 px). The pulse is opacity-only and the title keeps its 16 s sweep.

Size is about 30% over the old `max-h-32` / `text-5xl` / 12.5 px and scales with the window. The
logo box is sized from the logo's ASPECT RATIO (read on load, `--aura-logo-ar`, `--aura-logo-k` =
ar^-0.2), never from its natural pixels: `max-h-32 w-auto` only capped the height, so a logo served at
420 x 72 rendered 72 px tall. A logo that fails every retry falls back to the text title.

The logo comes from the play target, in the detail page's own order: DetailView's `targetForPlay`
passes the hero's LATCHED logo (`heroArtLatch.logo`, else `detail.logo`, else the preview's), and
`handlePlayStream` falls back to the active target's logo for the same title (Next-Up, retry, source
switch, party sync), then the richest cached meta detail, then the catalog preview (same title only)
and the library row. Never resolve it from the catalog preview first: a catalog row often has no
`logo` while the meta detail does (The Odyssey through AIOMetadata showed its text title).

## The left rail (`NavSidebar.tsx`, `styles/glass-rail.css`, round 9)

Direction A ("Obsidian rail") of the round 8 mockup, picked by the user. It replaced the bare centred
nav, its `.aura-glow` pill, the three `SidePill` controls (User Panel and Watch Party fixed top-left,
Notifications fixed bottom-left) and the under-800px `.aura-nav-rail` padding hack.

- ONE glass surface: `<aside class="aura-rail aura-float-glass aura-glass-control" data-aura-rail
  data-glass-light="panel">`, the shared control-tier material in both materials (Frosted draws
  Frosted), so material tokens reach it like any floating control; it never lifts on hover
  (glass-rail.css). 204 px wide, 22 px corners, padding 10. It is an IN-FLOW flex item of the app
  body (`flex gap-3 p-3`, App.tsx), `align-self: center`, `max-height: 100%`: it hugs its content,
  centres under the 36 px title bar and the page column starts at 12 + 204 + 12 = 228 px with no page
  reserving space by hand (nothing scrolls under it, so no `data-glass-base`). It hides with the body
  during playback and is absent on landing / onboarding.
- Top to bottom (round 12, the user moved Notifications to the very top): `.aura-rail-sec` with
  Notifications (`NotificationsBell`), a hairline, `.aura-rail-sec` (User Panel = `AccountButton`,
  Watch Party = `PartyButton`), a hairline, and `<nav class="aura-rail-nav">` with ONE
  `.aura-rail-list` (Home, Library, Queue and Airing sub-rows, Discover, Live TV, Calendar, History, a
  divider, Addons, Settings). Rows (`RailRow` for the section rows,
  `NavRow` for the nav) are LIST ROWS on the one surface, never glass pills: transparent, `.aura-nav-row
  .nav-tap` (press squash, Liquid's droplet rule), label colours in glass-rail.css.
- Lit state: nav row `aria-current="page"`, Library `data-parent-lit` while Queue / Airing is the page,
  a section row `.is-active` (its panel open, in a party). Frosted: the accent. Liquid:
  `color-mix(accent 34%, white)`. A section row also takes a faint wash (it has no pill).
- The active pill `.aura-rail-pill` (`data-glass-light="rim"`) is a NESTED inner pill with no backdrop
  pass (inside the rail it would sample only the rail: Backdrop Root). Liquid: white 0.075, `inset 0 0
  12px` white 0 (0.015 until round 17: a +1 to +2 band inside the pill, "The A control tier"), `0 2px
  8px` black 0.28, 13 px corners, no accent; the cursor-light system draws its
  rim, so both pill rules put `var(--lg-rim-layer)` FIRST in their `background` (a pill face set alone
  replaced the ring: no lit or idle rim); Liquid idle strengths 0.30 / 0.04 / 0.16 (the mockup's pill).
  Frosted: the old style A accent wash and inset hairline, glow cut to 12 px (the nav scroller clips
  it). The rail's count badges (`.aura-rail-count`, `.aura-rail-unread`) fill with the accent MARK
  (`--ln-accent-mark`, see "Custom accent colour") and take `--ln-accent-mark-ink-rgb` (dark: a mark is
  always light); a raw dark custom accent fill vanished on the rail (review round 10). The User Panel
  monogram (`.aura-rail-monogram`, the account initials) is coloured with the same `--ln-accent-mark`
  (round 11; built-in accents draw exactly as before, #1a2050 went from 1.3:1 to 3.7:1 on the Liquid
  rail face). The profile popover's 48 px identity circle shows the SAME initials
  (`.aura-rail-monogram.aura-profile-monogram`, one `monogramFor` helper in AccountButton.tsx, reading the
  same prop email first) instead of the Aura "A" (kept for guests), and its glow reads
  `--ln-accent-rgb`, not the Mica literal. The pill is NOT in `BIND_SELECTOR`, the glass reset or `GLINT_SELECTOR`.
- Pill geometry is MEASURED (`offsetTop` / `offsetHeight` of `[data-nav-id]`), never derived from row
  constants: a ResizeObserver on the list and its scroller bumps a layout generation and the pill
  snaps. A route change slides (animateSpan), a click on the droplet's row hands off (above).
- Hover: ONE droplet for the whole rail (`.aura-glass-hl.aura-rail-hl`, Liquid only, NavSidebar
  `useRailDroplet`), so it slides between ANY two rows across both hairlines and the divider, both
  ways. Round 11 had one per list (`useNavDroplet` for the nav, `useListDroplet` per section): crossing
  a hairline left one list (its droplet faded out) and entered another (its droplet snapped in), so
  History <-> Addons slid while Settings <-> Notifications did not. The droplet is the rail's first
  child inside `.aura-rail-hlclip` (absolute, inset 0, `border-radius: inherit`, `overflow: hidden`:
  a long slide on the hover spring overshoots its row by up to about 26 px, which poked out past the
  rail's top). `translate` + `height` through animateSpan, `left` + `width` inline from the row's rect
  (a nav row narrows while the nav shows a scrollbar); a nav row's span is CLAMPED to the nav
  scroller's box and follows its row while the nav scrolls (a row scrolled fully out hides it).
  Native listeners on the rail (pointermove, pointerleave, click; scroll on the nav), never React
  handlers: the rows' popups are React children portalled out of the rail, and React bubbles their
  events and computes pointerleave through the React tree (the pointer on the sheet would still be
  "in the rail"). Pointermove only, so a re-layout under a still pointer never lights a row. Over
  the active nav row it slides there and fades out under the pill, then slides out to the next row;
  a click fades it in place (on its own nav row: the pill hand-off) and the next row slides from
  there; leaving the rail fades it where it is and the next entry snaps. In the rail it is a faint
  fill (white 0.028 to 0.016 since round 12, see "HOVER FILLS"), no rim, no meniscus. Frosted rows
  keep a white 0.06 hover fill.
  Measured (harness, 1600 x 900): Settings to Notifications passes through every row between in
  about 160 ms and settles by about 450 ms; 900 x 500 with the nav scrolled, the droplet on a half
  hidden Settings row is cut at the scroller's bottom (462..487).
- Short windows: row tokens step down at `max-height: 800px` (40 / 34 / 38) and `680px` (36 / 30 / 34,
  padding 6), so 900 x 600 fits (rail 517 px of 540). Below that only `.aura-rail-nav` scrolls
  (`min-height: 0`, 6 px padding cancelled by a negative margin so the pill's drop is not clipped) and
  the pill keeps the active row scrolled into view; the section rows above it stay put.
- Popups opened from rows never render INSIDE the rail (its backdrop-filter makes it the containing
  block of a fixed descendant and its Backdrop Root). `RailPopup` (RailRow.tsx) portals them into
  `[data-rail-popups]`, a `display: contents` host NavSidebar renders beside the rail INSIDE the body:
  so they keep the body's stacking (the notification bubble is `z-[31]`, under the detail page; the host sits
  BEFORE the main content, so at z-30 it lost the tie to the Home search focus dim) and its `hidden` during playback. Not `document.body`: none of these hosts a context menu,
  and a body portal would float the bubble over the detail page.
- Anchors: popups open BESIDE the rail (`railLayout.ts` `railAnchorFor`: left = rail right + 10).
  The profile popover, the Watch Party panel (`WatchTogetherPanel.tsx`; every user-visible string says
  "Watch Party" since round 11, while code identifiers, events, storage keys and relay fields keep
  `watchTogether` / `watch-together`) and the party toasts hang level with their row's top
  (`partyAnchor.ts` `anchorFromElement`, used by `readPartyAnchor`, measured at open, so the rows
  that moved down in round 12 still get their popups beside them); the notifications side sheet
  and arrival bubble sit flush with the RAIL's top (`railTop` through `railPopupTop`; the sheet
  down to the rail's bottom, `railBottom`) and grow DOWNWARD out of the Notifications row's top
  (`useRailAnchor`, measured only while one is up, re-measured on resize; see "Notifications"). The `data-profile-trigger`, `data-party-anchor` and
  `data-notifications-bell` attributes are still the contracts the guards and anchors find.
- Attention states: the Notifications row's arrival sweep, static unread wash and badge pop are in
  `styles/glass-notify.css` (see "Notifications" below; nothing on that row loops since round 10);
  `.aura-pill-live-dot` breathes the party status dot (App.css "Left rail row states").
- `railLayout.ts` also holds `CHROME_TOP_PX` / `CHROME_LEFT_PX` (44 / 20), the top-left seat of the
  Downloads panel and the service status popover (they were `SIDE_PILL_*`).

## Notifications (`NotificationsBell.tsx`, `NotificationsPanel.tsx`, `styles/glass-notify.css`, round 10)

Redesigned for the rail placement (round 10): both surfaces GROW OUT of the rail's Notifications row,
portalled through `RailPopup`, left edge at rail right + 10. Round 12 moved the row to the rail's very
top, so both now sit with their TOP FLUSH with the rail's top (`railPopupTop(anchor)`: `railTop`,
unrounded so a half-pixel rail edge does not miss by one, never above `CHROME_TOP_PX`) and grow
DOWNWARD: `transform-origin` on the rail's edge level with the row's TOP, measured from the popup's
top (`railOrigin(anchor, top)`; 1600 x 900: `-10px 11.5px`). Round 12 review: from the row's middle
(`33.5px`) the 72 px bubble grew about as far up as down; from the row's top it grows 9 px up and 48
px down. The light bridge stays at the row's middle (`rowMidY`).

- SIDE SHEET (`NotificationsPanel`): plain `.aura-float-glass` (Liquid menu tier with the idle rim and
  the cursor light, `data-glass-light="panel"`; Frosted in Matte), 372 px wide, 20 px corners,
  z 10045. DOCKED: top flush with the rail's top, its height the rail's (`sheetHeight(anchor, top)`):
  1600 x 900 103.5..832.5, 900 x 600 59.5..576.5. A content-driven height missed the rail's ends by 12
  to 25 px (read as a mistake). Grown from the top row, the spring's overshoot runs DOWN past the rail's
  bottom for about 100 ms (sampled up to about 846 at 1600 x 900, 13.5 px, inside the window), never up
  into the title bar. Kept (round 12 review): it is `--lg-springy`'s own overshoot (about 3% of the
  0.36 to 1 travel), the same the bottom-anchored sheet showed upward in rounds 10 and 11; removing it
  means a different curve for the sheet.
  A short list leaves glass below; the empty state centres. Header: title, a mono
  "N new" chip (`--ln-accent-mark-text` on a mark 0.16 wash), Refresh and "Clear all" as small
  `.aura-glass-flat` pills. Body: day groups (Today, Yesterday, This week, Earlier; mono 10 px caps),
  items as CONTENT rows (`.aura-notif-item`, never glass) under the shared Liquid hover droplet
  (`useListDroplet(".aura-notif-item")`, `.aura-notif-hl` inset 6 px; Frosted rows a white 0.06 fill),
  hairlines between rows hidden next to a hovered one. A row: an accent-mark unread dot in the left
  gutter, a 34 x 51 poster thumb with the card bezel (`.aura-card-bezel`, rim-only light) or the kind's
  icon on a toned tile, the title, a mono relative time, a 2-line second line (the subtitle, else
  `notifDetail`, so a poster row is never a lone title over empty space), the inline actions
  (Reconnect, Turn on Send HDR); the dismiss X replaces the time on hover or keyboard focus
  (`:focus-visible`, so a row the sheet focused for a pointer user keeps its time). Small grey text:
  time white 0.56; Frosted lifts time to 0.62 and the second line to 0.66 (over bright page blocks
  the Liquid values measured 3.1:1 / 4.1:1 there). Scrolled, the list fades out under the header over
  12 px (`data-scrolled` mask, set only when the state flips). Day groups re-run on the 30 s tick, so
  they roll over at midnight.
- Unread in the sheet: opening is still a global mark-read (the badge clears at once), so the bell
  snapshots the ids that were unread at open (`newIds`) and the sheet marks those.
- Copy: the scanner writes `title` = the name and `subtitle` = "Now available" (release) or the SxxEyy
  label (episode, else "New episode"), no dash. `notifTitle` / `notifDetail` split a LEGACY combined
  title (a release / episode with no subtitle) on its em-dash separator at render time (sheet row,
  bubble, the bell's live region).
- Posters: the scanner stamps `data.poster` on release / episode notifications; older entries look up
  `data.metaId` in the library (a Map built only while a surface is up). Only http(s) urls of at most
  2048 chars (`safeNotifPoster`, NotificationsContext.tsx, applied at WRITE time too, so nothing else
  reaches the persisted, cloud-synced list), through `shrinkPoster(url, 96)`.
- Motion: `usePopPresence` (inline-style flip, so no pop-in race; a reopen mid-close reverses).
  Collapsed: the bubble `translateX(-8px) scale(0.42, 0.2)`, the sheet `scale(0.6, 0.36)` with no
  offset (at 0.42 x 0.2 its text was squashed 1.7x sideways mid-grow and the card overlapped the rail);
  open `transform 460ms var(--lg-springy)` + a 150 ms fade, close 200 ms accelerate. Each surface's
  content fades in about 100 ms after its shape (`.aura-notif-fadein` on the sheet's header and list).
  Reduced motion: fades only. Both surfaces carry `data-lg-pop` (liquidGlass holds the lens until the
  pop settles).
- Keyboard and focus: the sheet focuses itself on open (or the landed item) and wraps Tab inside
  itself (Tab from the last tabbable goes to the first, Shift+Tab from the first or the sheet to the
  last); arrows / Home / End move between items, Enter / Space act, Delete dismisses (never an `update`), focus lands on the next row
  after a dismiss; Escape (window capture, stopped) closes and returns focus to the row; the search
  chord (Ctrl+F) closes it and is NOT stopped (the closed sheet is click-through before searchHotkey's
  bubble listener looks for the box it may cover); outside mousedown closes except on the row, the
  sheet or `[data-aura-context-menu]`. The landing re-arms on every close, so a reopen during the close
  transition (same instance) still focuses the sheet or the bubble's item.
- Toasts: while the sheet is mounted `.aura-app-toast-host` lifts to z 10050
  (`:root:has(.aura-notif-sheet)`, glass-notify.css): the sheet's own actions raise app toasts, and at
  900 x 600 the toast lane (56..96) lay under the sheet.
- LIGHT BRIDGE (`RailBridge`, the ARRIVAL BUBBLE only: the side sheet's bridge was dropped in round 17,
  user's call): a 12 px wide element over the 10 px gap at the row's middle, the row's
  height less 6 px (at most 44, inline), so its posts never reach past the row: a 1 px lit point on the
  rail's edge (origin) and on the popup's edge (end), vertical fades, and ONE 2 px beam between, white
  with 40% of the accent mark. Opening in step with the popup's grow (full size about 225 ms in): the
  origin lights at 40 to 120 ms, the beam draws out of it (scaleX on the beam only, 70 to 260 ms, landing
  as the spring peaks), the end point flashes once as it lands (peak about 300 ms) and settles by 650 ms;
  one shot, no loop. Closing, it fades first. Nothing else in the gap: a full-height seam
  (haze, scan lines, long edge lines) was tried and dropped as clutter (user's call, 2026-11-22).
  Hidden on High Contrast. Too small to band.
- ARRIVAL BUBBLE (`ArrivalBubble`): when a popup arrives with the sheet closed, a 304 px menu-tier
  card (16 px corners, z 31: over the Home search focus dim z 30, under the detail page z 60) grows out
  of the row to the right and down, top flush with the rail's top (1600 x 900: 103.5..175.5 beside a
  row at 115..159; same motion, its content fading in a beat later). On a narrow window (900 px) it
  overlaps the left part of the Home search box for its 5 s hold (the box's right part stays
  clickable; focusing it raises the dim, which retracts the bubble): poster thumb, title, one
  detail line (`notifDetail`: the subtitle, else the kind), a dismiss X. Holds 5 s (10 s until round 17; paused while
  hovered OR focused, tracked separately so a blur under the pointer does not start the retract, then
  3 s; a merge restarts the full 5 s), then retracts into the row and clears the popup. Clicking
  opens the sheet AT that item (scrolled to the middle, focused, one accent wash fades over 1.6 s).
  Escape with focus in it, or its X, retracts it and hands focus to the row first (an unmounting
  bubble dropped it on `<body>`). While the sheet is open no bubble shows and every pending one is
  dropped (`dismissPopup({ pending: true })`). While the Home search focus dim is up
  (`data-aura-search-dim="on"`, change signal `aura:search-dim`, SearchBar.tsx; `useSearchDim` also reads the attribute synchronously at render, so a popup arriving
  under the dim never shows a first frame) the bubble waits
  retracted (`suspended`) and grows, with a fresh hold and the row sweep, when it clears.
  Screen readers: the bubble is a plain `role="group"`; the arrival is written into ONE persistent
  `sr-only` live region the bell always renders (a status region inserted already filled is not
  read), on every arrival or merge.
- MERGE, never stack: `NotificationsContext` counts the arrivals behind the current popup
  (`popupCount`: a coalesced batch, a suppressed backlog, an arrival while the bubble is up). The
  bubble shows the latest item, a mono "N new" chip, restarts its hold, revives if retracting and plays
  AppToast's `playRepeat` (exported) for the bump. `dismissPopup()` (the retract's end) clears ONLY
  the popup on screen: an arrival pending behind it (the 150 ms coalesce timer, the boot grace, the
  suppression queue) and its count survive, so one landing in the retract's last 150 ms still shows.
- The row: on each arrival (a new popup id or count) ONE accent light sweep crosses it (`::after`,
  a band about a third of the row wide moving 84% to 16% of a 300% background, 1.1 s, once; a merge
  during it does not restart it; none under reduced motion) and the badge pops (WAAPI scale on the
  bouncy spring, skipped while its mount pop runs and under reduced motion). While a dismissable item
  is unread the row keeps a STATIC accent 0.04 wash (`.aura-notif-unread`). The round 9 breathing wash,
  the 5 s bell ring and badge bounce, the icon double-pop and the old bubble breathe are gone (and out
  of the scrolling / idle / reduced-motion lists).
- Accent: only through the mark tokens (`--ln-accent-mark` for the dot, badge, sweep, washes and
  bridge tint; `--ln-accent-mark-text` for the chip and the notice icon; the badge text
  `--ln-accent-mark-ink-rgb`), so a dark custom accent still reads. Measured with #22d3a6 and
  #1a2050 (dot `oklch(0.66 ...)`, badge visible).

## The Detail page (`styles/glass-detail.css`, round 11)

- PANELS: the info panel (`#aura-hud-panel`, DetailHud) and the episodes / streams panel (UnifiedPanel)
  are plain `.aura-float-glass.aura-detail-panel` (the notifications sheet recipe: Liquid menu tier,
  Frosted in Matte), 20 px corners, `data-liquid="off"` (both are over MAX_AREA and must match
  each other), `data-glass-light="panel"`. The old `.aura-hud-surface` 0.80 baked face is gone (and its
  App.css rules, with `.aura-hud-tab`). The HUD scrolls in an INNER `.aura-detail-scroll` (a mask on the
  glass itself would fade its face) with the sheet's 12 px `data-scrolled` fade. Dim text inside either
  panel is floored in TWO tiers by `:where` rules (so hover utilities still win): `text-white/30` to
  `/40` at white 0.56, `/45` and `/50` at 0.64 (one 0.58 value, the first build, flattened meta, tags
  and ranges into one grey). Measured with the single 0.58 floor: every text in both panels and the tab
  bar at 4.5:1 or more over a white and a bright busy poster, both materials (lowest 4.65); 0.56 stays
  above the notifications sheet's 0.55 floor. The scroll cost of the menu tone step on these panels
  measured nil (headed GPU, 40 streams and 120 episodes: mean 4.6 to 5.8 ms, p95 8.4 ms with or without
  it), so `--lg-menu-tone-step` stays.
- HUD TAB BAR: ONE `.aura-float-glass.aura-glass-control.aura-hud-tabbar` (`data-glass-light="control"`,
  `data-liquid="off"`) with transparent `.aura-hud-tabbtn` buttons (11 px mono caps, white 0.76, tight
  shadow; selected: Frosted the mark text, Liquid accent 34% into white) and ONE `.aura-hud-tabpill`
  (`data-glass-light="rim"`, the `.aura-rail-pill` recipe with `var(--lg-rim-layer)` first). It replaced
  up to seven per-tab control pills (seven backdrop passes, seven lenses). The pill is measured from the
  selected tab (`offsetLeft` / `offsetWidth`, `top` / `height` inline) and moved with `animateSpan("x")`;
  the first placement, a ResizeObserver re-layout and a change of line SNAP; `cancelSpan` on unmount.
  The bar WRAPS in a narrow column (seven anime tabs need about 630 px, the column is about 420 at 900 x
  600), never a hidden horizontal scroll. In Liquid it takes the A face at a 0.58 tint
  (`--lg-ctl-tint-top/-bottom` on the element; CSS face only, since the lens bakes the :root tokens): at
  the rail's 0.30 its labels measured 2.6 to 3.0:1 over a white poster. Never lifts on hover.
- ROWS: episode rows (`.aura-ep-row` in `.aura-ep-item` wrappers) and stream rows (`.aura-stream-row`)
  are CONTENT rows: no card, border or hover glow (the rotating `.hover-glow` is deleted), one Liquid
  droplet per list (`useListDroplet`, `.aura-glass-hl.aura-detail-hl` with inline left / right = the
  list's side padding), Frosted a white 0.06 hover fill, a white 0.06 hairline in the gap between rows
  hidden next to a hovered / focused / selected one (no `:has`: the episode list is not virtualized).
  Lists are `relative flex flex-col gap-*` (not `space-y`: the droplet is the first child). Selected
  (the active episode, the party's stream pick) = the rail pill face (Liquid white 0.075 + rim layer,
  idle 0.30 / 0.04 / 0.16; Frosted accent wash 0.12 + inset 0.30; High Contrast inset white 0.35) with
  `data-glass-light="rim"` on that one row; the episode number takes the lit label colour. A
  notification deep link is `.is-target`: one accent-mark wash fading over 1.6 s (never a persistent
  ring). Episode thumbs: a static white 0.08 hairline overlay (`.aura-ep-thumb::after`), NOT a bezel
  (One Piece is about 1100 rows; every `[data-glass-light]` is a light-registry candidate).
  Early-release streams: `.is-early-ok` (3 px emerald bar + emerald 0.06 wash) / `.is-early-maybe`
  (3 px dashed amber edge + amber 0.04). The quality box is a borderless well (`.aura-stream-quality`,
  white 0.045, 10 px). "Party pick" and the episode progress fill are the accent MARK with its ink. The
  chip lines (ChipRow / fitChipRows / measureChipRow) are untouched.
- Because the lists are `relative`, they are their rows' offsetParent: landing code measures from rects
  (`rowOffsetIn` in DetailView, ArcGrid's land), never `row.offsetTop - list.offsetTop`. Both scale the
  rect delta by `offsetHeight / rect height`: the page opens under a scale transform and the landing
  runs during it (the translation cancels in the delta).
- HEADER (`PanelHeader`): `.aura-detail-head` (rail hairline white 0.09, no strip fill), back =
  `.aura-glass-flat.aura-glass-press` 28 px pill radius 10, accent bar `.aura-detail-headbar`
  (`--ln-accent-mark`, no glow), counts `.aura-detail-count` (mono, white 0.06 wash; `.is-accent` = mark
  text on a mark 0.14 wash, the episode count chip), icon buttons `.aura-detail-iconbtn` (white 0.66,
  hover wash).
- ART (R4): cast / character / related / trailer tiles, arc cards and the backdrop picker's thumbs carry
  `.aura-card-bezel` as the last child of the art box (no border, no hover ring), the hovered tile's
  name (`.aura-tile` / `.aura-tile-name`) takes accent 34% into white. Badges on art inside a panel or the
  arc grid are `.aura-frost` made FAUX by `:is(.aura-detail-panel, .aura-arc-grid) .aura-frost` (no
  backdrop: inside a glass panel a real one samples only the panel, and there can be dozens). The hero's
  Anime / type / In Theaters chips (`.aura-hero-chip`, 7 px, tone inset hairlines) and the AIOStreams
  notice badges (`.aura-notice-badge.is-<kind>`, kind colour on glyph and count only) are REAL frost:
  bounded (2 to 3 and 0 to 4) and on the key art. The notice cluster (StreamMetaBadges, portalled) sits
  in the GUTTER between the two panels, 38 px left of the aside (the left section's 48 px right padding
  plus the aside's 12 px): at 48 px it sat on the info panel's rounded corner and rim.
- ArcGrid's grouping switcher is `.aura-glass-flat.aura-filter-chip` buttons with `aria-pressed` (a
  wrapping group cannot be a SegmentedControl).
- The in-player Episodes drawer (EpisodePanel) keeps `.aura-glass-item` rows so the player's
  selected-row face applies (glass-player.css), plus `useListDroplet` with `.aura-player-hl` (12 px in)
  like Switch source; rows `flex-none` in the flex list; no backdrop blur on the pending overlay.
- Copy: no dashes in UI strings (the synopsis subline is `SxxEyy · title`, a season's air range is
  `Aug 2026 to Nov 2026`).

## In-page sheets and pages (round 11, `src/glassSheet.ts`, `styles/glass-pages.css`)

The user's ask: "ensure the new glass look (e.g. the sidebar/search bar look) ... is applied to all
other relevant areas of the app ... I want the whole app to feel cohesive and consistent." Every page
outside Home and the detail page now uses four recipes. glass-pages.css is unlayered and loads after
App.css, so it beats App.css `@layer components` (`.glass-panel`, `.cal-today`) without editing it.

- R1 PANEL over art (dense, text-bearing): plain `.aura-float-glass` (the notifications sheet recipe),
  20 px corners, `data-liquid="off"` on very large panels. Used by the detail group; dialogs and
  popovers already conform.
- R2 SHEET, an in-page section or card ON a page (not over art): `sheet(classes, { tone? })` from
  `glassSheet.ts` spreads `className="aura-float-glass aura-glass-control aura-glass-sheet ..."`,
  `data-liquid="off"` and `data-glass-light="panel"`. The A control face with `--lg-backdrop: none`
  (rule `html[data-glass] .aura-float-glass.aura-glass-sheet`, specificity over the Liquid control
  tier). WHY no backdrop: behind a page there is only Mica (already blurred by DWM) or the ambient
  sweep (already soft), so a 20 px blur changed almost nothing, while a backdrop-filter over the
  animated sweep re-filters every frame and every scroll frame (the Calendar alone had about 44
  `.glass-panel` passes). Liquid: never lifts on hover (`--lg-lift: 0`, like the rail), a softer
  three-entry drop (`0 1px 2px` 0.30, `0 12px 32px -6px` 0.45, zero third) because sheets stack.
  Frosted: a FLAT face (white 0.035 over rgb 10 12 16 / 0.22; a large unblurred vertical gradient
  bands) and a short drop. `.is-danger` adds a red 0.22 inset ring (error states; never a
  `border-red-*` utility). It inherits the idle rim, the lit rim and interior light, the zero-blur
  themes' opaque `--ln-panel-solid` rule and the High Contrast 0.35 edge for free. Glass inside a
  sheet is no Backdrop Root problem (the sheet has no filter), but rows inside stay content.
  The cursor light on a sheet is an OVERLAY (round 12 performance, glass-pages.css "PERFORMANCE"):
  while lit (and fading) the sheet's own ring, interior light and border go empty and a `::after`
  (inset -1px, radius inherited, `will-change: transform`) draws them: `paint(aura-rim)`, the
  interior image, then the sheet's `--lg-border-c` border on top, as the sheet painted them (rim
  under the border). It inherits the light's per-element tokens EXPLICITLY (`--gx: inherit` and so
  on: they are registered non-inheriting). A sheet's background repaint re-rasters everything it
  holds; on its own layer only the light does (Settings 2575 x 1038, pointer moving over the rows:
  103 to 219 fps). The overlay paints above the sheet's content (a stacking context on the sheet would
  trap the `fixed` z-[200] dialogs a Settings section renders under the next section), which only
  adds the sub-1% interior wash over the rows. That wash is CAPPED at the round 11 strength (round 12
  review): the overlay's cross-fade amount is divided by `max(1, --lg-glow-surface-k)`, so Surface glow
  acts on sheets from 0 to 100% and stops there (at 250% the uncapped wash peaked near 8.75% white,
  a film over the rows' text and controls). Every sheet is `position: relative` for it, except
  `absolute` / `fixed` / `sticky` ones; the scrolling sheets (`.aura-toc-scroll`, `.aura-live-rail`)
  keep the old in-background light (an absolute overlay would scroll with their content). Pixel
  check against the old drawing: within 5 levels inside a lit sheet; at a lit CORNER the composited
  overlay draws the blue dispersion fringe round the arc like the straight edges (up to about 50
  levels on about 50 pixels; the in-background drawing lost it on the arc), and at 125% scale
  within 12 levels.
  Measured in the harness (1600 x 900, both materials): backdrop passes outside the rail are 0 on
  Settings, Calendar (was about 44), Library, Queue, Discover, Live TV and Addons, and 1 on History
  (its sticky bar, unchanged).
- R3 ROWS inside a panel or sheet: content rows under ONE sliding droplet per list
  (`useListDroplet(".aura-sheet-row")`, `<span className="aura-glass-hl aura-sheet-hl">` as the list's
  FIRST child, the list `position: relative`; use `flex flex-col gap-*`, never `space-y-*`, on such a
  list: the absolute droplet is the first child and `space-y` pushes a margin onto row 1). The droplet
  is a faint fill of its own (white 0.035 to 0.02, no shadow: the rail's round 11 value, which the rail
  lowered in round 12 and sheets kept); Frosted rows keep a white 0.06 hover fill.
  Selected row (`.is-selected`, plus `data-glass-light="rim"` while selected, because the face puts
  `var(--lg-rim-layer)` first and that var is only defined on a light surface) = the rail pill face:
  Liquid white 0.075, `inset 0 0 12px` white 0 (0.015 until round 17), `0 2px 8px` black 0.28, idle
  0.30 / 0.04 / 0.16,
  label `color-mix(accent 34%, white)`, no accent fill, ring or glow; Frosted an accent 0.12 wash, an
  accent 0.30 inset hairline and the label in `--ln-accent-mark-text`. The sheet droplet is full width,
  so it grows in HEIGHT only (`scale: 1 0.8` while hidden, round 12): the shared grow from 0.94 on the
  bouncy spring overshot the list's width by about 1 px for a few frames, and in the Settings TOC (a
  scroller with only `overflow-y` set, so x computed to auto) that flashed a horizontal scrollbar on
  hover (reported round 12; measured 6 to 22 overflowing frames per pass over the TOC in Liquid, 0
  after). Both TOC scrollers (the aside and its inner list) also take `.aura-toc-scroll`
  (`overflow-x: hidden`, glass-pages.css): a scroller on a page that must never scroll sideways says
  so explicitly. Used by the Settings TOC (rows
  full width, leaves indented by padding, no left guide line) and the Live TV group rail (the
  Favorites row keeps its amber label and a hairline under it). Lists whose rows dnd-kit moves (Addons,
  Downloads) get NO droplet (the transforms would desync it): Addons is one sheet holding
  `.aura-content-row` rows (`.aura-sheet-list`: white 0.07 hairlines hidden next to a hovered row, a
  white 0.04 hover fill).
- R4 ART: a poster or thumb gets `<span aria-hidden className="aura-card-bezel" data-glass-light="rim" />`
  as the LAST child of its `overflow-hidden rounded-*` art box (it replaces `border border-white/8`),
  the title `.aura-poster-title` (hovered card: accent 34% into white, frozen under
  `data-aura-scrolling` unless `data-hover-held`; hover hosts `.aura-lib-card`, `.aura-poster-card`,
  `.aura-content-card.is-live`). Grids: Library (`.aura-lib-grid`), Queue, Discover and Catalog
  (`.aura-poster-grid`), Airing (`.aura-airing-grid`, CSS only, CinemaRows untouched). Badges on that
  art are FAUX frost (the gpu-off recipe, no backdrop pass) through the grid scope: `WatchedBadge
  material="frost"` and the remove button `aura-frost aura-frost-btn is-remove` (a rose wash on hover).
  Real frost stays Home-only (bounded by its row virtualization). No card underglow (cardGlow) on these
  grids (scroll FPS). Live TV channel cards (up to 400 mounted) take a STATIC white 0.07 hairline, not
  a bezel: every `[data-glass-light]` is a light-registry candidate re-measured after each scroll.
- CONTENT cards (History entries, the Calendar day overlay, Live TV channels): `.aura-content-card`
  (white 0.03, hover 0.06 when `.is-live`, no border); History's selected card = the selected face
  (Liquid: white 0.075 with a white 0.10 inset hairline; Frosted: accent 0.10 + accent 0.55 hairline).
  A grouped box inside a glass card (Onboarding) is `.aura-content-panel` (the content-group look).
- Calendar: cells are sheets `is-cell` (radius 14, a lighter drop, hover `--lg-lift` 0.035 only when it
  has releases: never a scale (it scaled the date text) or an accent ring); outside-month cells
  `is-dim` (opacity 0.45); today `is-today` = a brighter face (lift 0.05) with a white 0.12 inset
  hairline (Frosted: accent 0.10 wash + accent 0.35 hairline) and the day number on an accent-MARK disc
  (`.aura-cal-today-num`, mark ink). The old `.cal-today` accent ring, 16 px accent glow and 30 px
  violet bloom (a large soft unblurred glow that banded) are gone. Counts use `.aura-mark-chip` (mono,
  mark text on a mark 0.16 wash). A busy day's hidden-posters popout widens (up to ceil(n / rows))
  before it shrinks posters (60 px floor, `POPOUT_MIN_POSTER_H`), then shows a same-size '+N' tile, so it
  always fits inside the window. The DayOverlay's dim + blur is a SIBLING layer, never the wrapper.
- History: the sticky bar's selection wash `.aura-history-select-wash` is an accent-mark 0.06 wash in
  Liquid (no accent border, the Liquid selection rule); Frosted keeps the accent 0.45 border.
- Accent text on dark glass reads `--ln-accent-mark-text` (`text-[color:var(--ln-accent-mark-text)]`)
  and fills `--ln-accent-mark`; a solid accent CTA is `aura-glass-flat aura-glass-press is-cta` with
  `text-ln-accent-ink` (Login, Landing, Onboarding: white or black on a custom accent failed contrast).
  Hand-rolled accent buttons became `aura-glass-flat is-primary`.
- Legibility floor on these pages: secondary text at least white 0.55 (was 0.25 to 0.45 in places).
  Inside a sheet the floor is CSS (glass-pages.css, the Detail panels' two tiers: `text-white/30` to
  `/40` at 0.56, `/45` and `/50` at 0.64, `:where` so hovers win), so every Settings description is
  covered; `settingsControls.tsx` descriptions and the page subtitles (Library, Queue, Airing, Discover,
  Catalog, Calendar, History) are white 0.55 at the source (they measured 3.0:1 at 0.35). Small 10 px
  labels (FilterBar, Discover's Addon / Catalog pills, Addons' "Suggested addons") are white 0.6; a
  filter chip's count is opacity 0.85 of its label; a selected filter chip's label in Matte is
  `--ln-accent-mark-text` (the raw accent on its 0.18 wash put the count at 2.67:1).
- Guide (Live TV): the sticky header lost its `backdrop-blur-sm` (0.96 opaque already; it re-filtered
  on every grid scroll frame).
- Dead CSS removed from App.css (round 11 cleanup): `.cal-today`, `.hover-glow` (its keyframes and its
  reduced-motion, scrolling and idle list entries), `.aura-hud-surface`, `.aura-hud-tab`. `.glass-panel`
  and `.glass-panel-elevated` stay defined in `@layer components` (no markup uses them, so Tailwind
  never emits them): never reach for them.

## Portals and the context menu

**`ContextMenuHost` renders its menu INLINE at `z-[200]`, not through a portal** (only its hover
SUBMENU portals, to `document.body`), and it sits inside `.aura-app-shell`, which is its own stacking
context (`position: relative; z-index: 0`). A floating panel rendered in that same context at any
z-index therefore paints OVER any right-click menu raised from its own rows, while that menu's
submenu appears from nowhere. Portal the panel to `document.body` and exempt
`[data-aura-context-menu]` from its outside-click guard (see `DownloadsPanelHost.tsx`).

A surface portalled to `document.body` from inside the detail page (HeroBackdropPicker,
StreamMetaBadges, NoticePopover) sits outside the root that fades on close, so it must react to
DetailView's `closing` flag itself (close, or fade and go click-through).
