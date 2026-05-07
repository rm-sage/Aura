-- Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
-- SPDX-License-Identifier: AGPL-3.0-or-later

-- ---------------------------------------------------------------------------
-- skip-windows.lua — Aura's anime-OP skipper.
--
-- Reactive only: this script does NO networking. The Rust side fetches
-- AniSkip windows + computes per-window auto/prompt flags from the
-- user's settings, then writes the resulting JSON to mpv's
-- `user-data/aura/skip-windows` property whenever a video loads.
-- This script just observes time-pos and triggers seeks / prompts.
--
-- Payload schema (set on user-data/aura/skip-windows):
--   {
--     "windows": [
--       { "type": "op",  "start": 152.4, "end": 242.8,
--         "source": "aniskip", "auto": true },
--       { "type": "ed",  "start": 1335.0, "end": 1410.0,
--         "source": "chapter", "auto": false }
--     ]
--   }
--
-- Empty / null payload → script does nothing (graceful degraded mode
-- when AniSkip has no data, the meta isn't anime, or the user
-- disabled all skip types).
-- ---------------------------------------------------------------------------

local utils   = require 'mp.utils'
local options = require 'mp.options'

local opts = {
  -- How long the OSD message stays up after an auto-skip.
  toast_duration = 2,
  -- How long the prompt-style "Press X to skip" message lingers.
  prompt_duration = 5,
  -- Hotkey for accepting a prompt (lowercase = plain key, no Shift).
  prompt_key = 'x',
  -- Hotkey for force-skipping the current OR upcoming-within-30s
  -- window unconditionally. Uppercase = Shift+x. Always active.
  force_skip_key = 'X',
}
options.read_options(opts, 'skip-windows')

-- State per loaded file.
local windows = {}
-- Per-window "have we already fired this one this load?" — prevents
-- re-skipping on a backwards seek into a previously-handled window.
local fired = {}
-- Active prompt-key binding label, if any. Cleared when playback
-- leaves the window OR when the file changes.
local active_prompt_label  = nil
-- Window the active prompt belongs to. Used by the time-pos observer
-- to decide when to release the binding (playback past `end`, or
-- a backward seek before `start`).
local active_prompt_window = nil

local function clear_prompt()
  if active_prompt_label ~= nil then
    mp.remove_key_binding(active_prompt_label)
    active_prompt_label = nil
  end
  active_prompt_window = nil
end

-- Reset everything tied to a freshly-loaded payload — used by the
-- user-data observer when a new payload arrives. NOT used by the
-- file-loaded handler (that one only clears per-playback state — see
-- the handler comment).
local function reset_state()
  windows = {}
  fired = {}
  clear_prompt()
end

-- Apply a skip — seek to the window's end and toast. The seek uses
-- mpv's 'seek' command with 'absolute exact' (mpv default --hr-seek=auto
-- can land 1-2 s short of the keyframe target on a typical OP-skip
-- distance, leaving a flash of credits behind). Costs ~100 ms of
-- decode time but produces a clean cut.
local function do_skip(w)
  mp.commandv('seek', tostring(w['end']), 'absolute', 'exact')
  -- React's SkipController.fireToast renders the "Skipped X" feedback
  -- toast in the WebView layer, so we deliberately do NOT call
  -- mp.osd_message here — the WebView toast and the OSD message
  -- displayed simultaneously, and the OSD layer (which mpv paints on
  -- top of the video) overlapped the React title bar above it.
  local _ = w
end

-- Returns true when t falls inside [start, end). The reserved word
-- `end` in Lua needs bracket-syntax access on the table.
local function in_window(t, w)
  return t >= w.start and t < w['end']
end

-- ---------------------------------------------------------------------------
-- Payload reader — parses the JSON from user-data/aura/skip-windows.
-- mpv stores user-data values as native Lua tables when possible;
-- when it stores them as strings (which it does for JSON-encoded
-- payloads written via property/set_property), we parse here.
-- ---------------------------------------------------------------------------

local function load_payload(value)
  reset_state()
  if value == nil or value == '' then return end

  local decoded = value
  if type(value) == 'string' then
    local ok, parsed = pcall(utils.parse_json, value)
    if not ok or parsed == nil then return end
    decoded = parsed
  end

  if type(decoded) ~= 'table' or type(decoded.windows) ~= 'table' then
    return
  end

  for _, w in ipairs(decoded.windows) do
    if type(w) == 'table'
       and type(w.start) == 'number'
       and type(w['end']) == 'number'
       and w['end'] > w.start
    then
      table.insert(windows, {
        type   = w.type or 'op',
        start  = w.start,
        ['end']= w['end'],
        source = w.source or 'aniskip',
        auto   = w.auto == true,
      })
    end
  end

  if #windows > 0 then
    mp.msg.info(string.format('skip-windows: loaded %d window(s)', #windows))
  end
end

-- ---------------------------------------------------------------------------
-- time-pos observer — fires whenever the position changes. Linear scan
-- over a typical 2-4 windows is negligible.
-- ---------------------------------------------------------------------------

local function on_time(_, t)
  if t == nil then return end

  -- Release the prompt binding once playback leaves the window it was
  -- bound to (either past the end, or a backward seek before the
  -- start). The toast itself fades after `prompt_duration`, but the
  -- key binding now stays alive for the entire window — so the user
  -- can press it 10s, 30s, or 60s into the OP, not just within the
  -- toast's 5s lifetime.
  if active_prompt_window ~= nil
     and (t >= active_prompt_window['end'] or t < active_prompt_window.start) then
    clear_prompt()
  end

  if #windows == 0 then return end

  -- A backwards seek out of a previously-fired window should clear its
  -- fired flag so the user can re-trigger the prompt on a deliberate
  -- re-watch. We only clear when the user has moved fully BEFORE the
  -- window (not just back into it from after).
  for i, w in ipairs(windows) do
    if fired[i] and t < w.start then
      fired[i] = nil
    end
  end

  for i, w in ipairs(windows) do
    if not fired[i] and in_window(t, w) then
      fired[i] = true
      -- Midpoint grace: if the user is resuming/seeking already past
      -- the middle of the window, they're engaged with whatever
      -- content is playing — yanking them forward into the post-OP
      -- scene would be jarring. Set fired[i]=true above first so we
      -- don't re-evaluate every tick while sitting past the midpoint.
      -- Force-skip (Shift+X) intentionally bypasses this check.
      local span = w['end'] - w.start
      if (t - w.start) > span * 0.5 then
        return
      end
      if w.auto then
        do_skip(w)
      else
        clear_prompt()
        local label = 'aura-skip-prompt-' .. tostring(i)
        active_prompt_label  = label
        active_prompt_window = w

        -- React's SkipPromptToast renders the "Press X to skip the
        -- Ending" notification box in the WebView layer. We used to
        -- ALSO emit a giant mp.osd_message("Skip ending? Press X")
        -- from here, but the OSD layer paints on top of the video
        -- frame and visually overlapped the React title bar (the
        -- "Frieren — Aversion to One's Own Kind" header). The toast
        -- is now the sole prompt UI; we keep the Lua-side keybind
        -- so the X press lands reliably inside mpv's input chain.
        mp.add_forced_key_binding(opts.prompt_key, label, function()
          do_skip(w)
          clear_prompt()
        end)
        -- The binding's lifetime is governed by the time-pos observer
        -- above (it clears once t leaves the window). We deliberately
        -- DO NOT use mp.add_timeout(prompt_duration, clear) here —
        -- that was the bug Fix 4 addresses.
      end
      return
    end
  end
end

-- file-loaded clears ONLY per-playback state (fired + active prompt) —
-- not `windows`. `windows` is owned by the user-data property
-- observer; on a rewatch with AniSkip's positive-forever cache, the
-- React host can write the payload BEFORE file-loaded fires. The old
-- reset_state() in this handler used to wipe those freshly-loaded
-- windows, so the skip would silently fail on the second watch of any
-- episode. Leave reset_state() available — load_payload still uses it
-- when a fresh payload arrives.
mp.register_event('file-loaded', function()
  fired = {}
  clear_prompt()
end)

-- Watch the user-data property — every time the host updates it, we
-- replace our window list. native-format ensures Lua sees a table
-- when mpv stored one, or a string when it didn't.
mp.observe_property('user-data/aura/skip-windows', 'native', function(_, value)
  load_payload(value)
end)

mp.observe_property('time-pos', 'number', on_time)

-- Force-skip binding (Shift+X by default). Always active — bypasses
-- the auto/prompt mode AND the midpoint grace. If the user is inside
-- a window, that window is skipped immediately. Otherwise, if a
-- window starts within 30 s, that window's content is pre-skipped
-- (useful as a "I see the OP coming, just take me past it" gesture).
mp.add_forced_key_binding(opts.force_skip_key, 'aura-skip-force', function()
  local t = mp.get_property_number('time-pos')
  if t == nil then return end

  for i, w in ipairs(windows) do
    if t >= w.start and t < w['end'] then
      fired[i] = true
      do_skip(w)
      clear_prompt()
      return
    end
  end

  for i, w in ipairs(windows) do
    if w.start > t and (w.start - t) <= 30 then
      fired[i] = true
      do_skip(w)
      return
    end
  end

  -- React's SkipController fires the equivalent "No skip window
  -- nearby" toast in the WebView layer, so we don't emit an OSD
  -- message here either — same overlay-collision concern as above.
end)
