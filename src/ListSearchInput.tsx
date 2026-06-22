// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// ---------------------------------------------------------------------------
// ListSearchInput — a compact, always-visible filter box for in-memory lists
// (Library, Queue). UNLIKE the global SearchBar, this NEVER hits the network:
// it just drives a parent-held query string that the page uses to filter the
// already-loaded items via `looseMatch`. Search icon on the left, a clear (×)
// affordance on the right once there's text, Esc clears.
// ---------------------------------------------------------------------------

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

const ClearIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Extra classes for the outer wrapper (width / alignment). */
  className?: string;
  ariaLabel?: string;
}

export default function ListSearchInput({
  value, onChange, placeholder, className, ariaLabel,
}: Props) {
  return (
    <div className={`relative ${className ?? ""}`}>
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/35 pointer-events-none">
        <SearchIcon />
      </span>
      <input
        // `text`, not `search` — Chromium's native `search` clear glyph would
        // collide with our own × button below.
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange("");
          }
        }}
        placeholder={placeholder ?? "Filter…"}
        spellCheck={false}
        aria-label={ariaLabel ?? placeholder ?? "Filter list"}
        className="w-full bg-white/5 border border-white/10 rounded-full
                   pl-8 pr-8 py-1.5 text-xs text-white/85
                   placeholder:text-white/30 outline-none transition-colors
                   hover:border-white/20 focus:border-white/30 focus:bg-black/30"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear filter"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full
                     text-white/40 hover:text-white/80 hover:bg-white/10
                     flex items-center justify-center transition-colors"
        >
          <ClearIcon />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// looseMatch — lenient, case/diacritic/punctuation-insensitive matcher with
// "a little leeway" so the filter isn't brittle:
//
//   1. Normalize both sides: lowercase, strip diacritics (NFD then drop the
//      combining marks U+0300–U+036F), collapse every run of non-alphanumerics
//      to a single space.
//   2. Token-AND: every whitespace-separated query token must appear as a
//      substring of the text. ORDER-INDEPENDENT, matches partial words —
//      "stone dr" and "dr sto" both match "Dr. Stone".
//   3. Space/punctuation-insensitive contiguous fallback: the whole query
//      with separators removed appears contiguously in the de-separated text —
//      so "drstone" still matches "Dr. Stone".
//
// Deliberately NOT a full subsequence/typo matcher: that over-matches on
// short queries (every "the" hits half a library). Token + de-spaced
// contiguous is the sweet spot between exact-substring and noise.
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  const decomposed = s.toLowerCase().normalize("NFD");
  let out = "";
  for (const ch of decomposed) {
    const c = ch.codePointAt(0) ?? 0;
    // Combining diacritical marks → drop (the base letter survived NFD).
    if (c >= 0x300 && c <= 0x36f) continue;
    // a-z or 0-9 survive; everything else becomes a separator space.
    out += ((c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39)) ? ch : " ";
  }
  return out.replace(/ +/g, " ").trim();
}

export function looseMatch(query: string, text: string): boolean {
  const q = normalize(query);
  if (!q) return true;            // empty query matches everything
  const t = normalize(text);
  if (!t) return false;

  const tokens = q.split(" ");
  if (tokens.every((tok) => t.includes(tok))) return true;

  const qc = q.replace(/ /g, "");
  const tc = t.replace(/ /g, "");
  return tc.includes(qc);
}
