---
paths:
  - "src-tauri/src/stremio.rs"
  - "src-tauri/src/streaming.rs"
  - "src/streamMeta.ts"
  - "src/streamFreshness.ts"
  - "src/nextUp.ts"
  - "src/SourceSwitcher.tsx"
  - "src/views/DetailView.tsx"
---

# Stream lists and stream chips

> Moved verbatim out of the root CLAUDE.md (2026-11-17). Path-scoped: Claude Code loads it when a file matching `paths` is read or edited; for anything else, read it before changing: fetch_streams / sanitize_stream in src-tauri/src/stremio.rs, src/nextUp.ts, src/streamFreshness.ts, handlePlayStream in src/App.tsx, src/streamMeta.ts, the stream rows in src/views/DetailView.tsx.

### Two stream-list invariants that auto-advance depends on

The source switcher and the Next-Up pre-resolve issue SEPARATE `fetch_streams` calls for the same
episode, and the user compares them by eye. They must agree, so:

1. **Every `StreamEntry` that reaches the frontend is playable.** `sanitize_stream` filters the url
   for scheme and length BEFORE the "url or infoHash" gate, never after. With the filter below the
   gate, a non-http(s) or over-4096-char url passed the gate and was then nulled, emitting an entry
   with `url == None` AND `info_hash == None`: it rendered as a row in the switcher but could not be
   played (the play path builds `magnet:?xt=urn:btih:null`, which the bridge 501s), and it shifted
   what auto-advance picked. The `unwrap_or_else(|| s.title.clone())` fallback in the dedup key is a
   leftover from that era, not licence to reintroduce it.
2. **`fetch_streams` returns ADDON order, deterministically.** The fan-out tags each task with its
   addon index and sorts before merging, because `JoinSet::join_next` yields COMPLETION order - the
   list would otherwise be ordered by whichever addon answered fastest, differently on every call.

Consequently `pickFirstStreamForEpisode` (`src/nextUp.ts`) takes `streams[0]`, full stop. It must not
filter or re-rank: for AIOStreams users that ordering is the sort criteria they configured, so the top
row IS the answer. It also scopes through `streamQueryAddons` (`src/auraSettings.ts`), the single
definition of "which addons answer a stream query"; auto-advance used to skip that scoping and query
addons the user had excluded in Settings.

**Stale urls (2026-11-13).** An addon url is not a fixed address, so a pick is re-read
before it plays when it is old. AIOStreams' proxy token never expires and re-runs its debrid
lookup (and failover) on EVERY request, so a url held for a day (a Next-Up pick made halfway
through the previous episode, a detail page left open in the tray, an unanswered resume prompt)
served the container header from one release and the packets from another: mpv decoded H.264
under an HEVC header and the load sat on "Loading" forever. Rust stamps `resolved_at_ms` on every
`StreamEntry`; `handlePlayStream` re-reads the source (`sameStreamSource`) when the url is older
than `STREAM_URL_MAX_AGE_MS` (2 h, `src/streamFreshness.ts`; an embedded meta stream carries no read time and is re-read through its meta), and DetailView re-reads a stale
list when the window comes back. While that re-read runs the play is PENDING (`LinkRefreshPending`:
the target id plus `linkRefreshKey`, the addon and source identity; App's `linkRefreshRef` /
`linkRefresh`): the stream row that started it shows a "Refreshing link" pill with a spinner, is
`aria-busy` and takes no clicks, and a repeat `handlePlayStream` of the SAME target and source is
ignored (`repeatsLinkRefresh`, checked before the play request is bumped, so the repeat cannot
supersede the one in flight); every click used to start another full fan-out. Any other play
supersedes it (it clears the pending entry at once and the old re-read stands down on
`playRequestRef`), and the entry is cleared by its owner in a `finally` (success, failure, stand
down) and by exit playback. The in-player source switcher already disables its resolving row; the
Next-Up card is gone the moment it is pressed, so those paths show only the toast. Separately, the engine reports a load that piles up `vd` "Error
while decoding frame" lines with no PLAYBACK_RESTART (`UNDECODABLE_ERRORS`, `playback-undecodable`):
it is treated as broken and the VOD auto-retry re-resolves at once, since re-sending the same url
gets the same bytes. Nothing else fires for such a load (no first frame, no end-file, and the
demuxer keeps "progressing" through packets the decoder rejects).

## Stream chip parsing: split lines into SEGMENTS, never dispatch on the first character

`src/streamMeta.ts` turns an addon's stream text into the chips in the stream list. It targets
AIOStreams' "TamTaro" formatter, which tags values with leading glyphs (`▣` codec, `✦` HDR,
`♬` audio, `♯` channels, `◈`/`❖` size, `⇄` seeders, `⛿`/`✓` languages, `⛊`/`⛉` VPS proxy).

**TamTaro packs SEVERAL tagged segments onto ONE physical line** - `▣ HEVC ✦ HDR ♬ DD+ ♯ 5.1` is
a single line. The parser therefore splits each line on the glyph set (`splitSegments`) and handles
every segment. An earlier version dispatched on the line's FIRST character and consumed the rest,
which silently dropped everything after the first segment: audio channels and seeders never
populated at all, and visual tags vanished whenever a codec was present. Do not reintroduce
first-character dispatch, and do not let a glyph branch consume past its own segment.

Two related rules:

- **A fallback that fills a field with the WRONG value is worse than an empty field.** When
  TamTaro started emitting `◈ 12.6 / 45.2 GB` (unit stripped off the file size when it matches the
  folder size), the size parse returned null and the `fullBody` regex fallback then re-filled
  `size` with the first size-shaped token in the body - the FOLDER size. The chip showed a
  plausible but wrong number. `parseSizeLine` now inherits the unit across the `/`.
- **Upstream reshuffles this template.** Aura must keep parsing BOTH the current and older shapes,
  since users run whatever AIOStreams version they have and can write custom formatters. Glyphs
  are load-bearing, so pin them by codepoint in comments; `➤` U+27A4 (preloading) and `✓` U+2713
  (languages-with-subtitles) were both added by upstream after the parser shipped. `✓` is generic
  enough that other addons use it for "✓ Verified", so it is accepted as the language glyph only
  when the body actually looks like language codes (`looksLikeLanguageCodes`).

AIOStreams structured facts beat the text where the text is lossy (`applyStreamFacts`, Rust `StreamFacts` from
`streamData`: field names per AIOStreams `ParsedStreamSchema`): release group, indexer and seeders replace the text
(a formatter truncates and joins them: "CiNEPHiLES · The Pirate Ba..." was ONE chip); size, folder size, age and cache
state only fill a gap; the running time (`duration`) exists only there. The facts also untruncate the title line from
`parsedFile.title` (only when it starts the same way), and give the ranked expression names one chip each
(`expressions`; the text runs them together as "WEB T2 WEB T6") plus the expression score (the trailing number, which is
AIOStreams' stream expression score, not a Stremio Enhanced one). An indexer field can list several (`indexerNames`:
"stremthru-corpus,zilean,nyaa", "StremThru|Knaben"). Text rules learned from live output (2026-11-09): small capitals
map a WORD at a time before NFKC (the formatter writes s / x / q plain, so "sᴇᴀᴅᴇx" read "sEADEx"); a subtitle code
keeps its superscript qualifier ("ᴇɴᶠᵒʳᶜᵉᵈ" is "EN forced", not "ENFORCED"); the size line can end in the age
("· 352d"); zero-width joiners are stripped (they sat inside "Web-dl"); a fact's age rounds DOWN like the formatter; a fact's size is DECIMAL units at three significant digits ("6.45 GB"),
as the formatter prints it, and it beats the body-wide size guess (which can be the pack size).

The stream row never wraps a chip line and never clips (user's call; a scrolling marquee was tried and dropped): the
header (badge, stars) and the footer (group, indexer, score, VPS) are IN the flow (an absolute footer grew left over the
quality box), the footer is one line whose group and indexer chips truncate, and each chip line is a `ChipRow`
(DetailView.tsx): one line, a chip that reaches the edge truncates when a useful width is left, anything after it hides
behind a "+N" chip whose hover lists it, and every chip's hover carries its full value. One shared ResizeObserver
re-fits the rows; hidden chips keep their place (visibility only) so a fit never moves anything. The size chip carries
the pack or folder size as a dim tail ("6.45 GB of 159 GB"), the subtitles are ONE chip ("SUB EN · EN forced"), and the
running time sits beside the episode tag. An early release tints the whole row (emerald verified, dashed amber
unverified) with a calendar icon in the title line.

There are no tests here; the practical check is to run the real `parseStream` over hand-rendered
old-format and new-format samples and diff the field sets. Node runs the `.ts` file directly.
