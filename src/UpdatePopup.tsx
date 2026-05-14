// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// UpdatePopup.tsx ───────────────────────────────────────────────────────────
//
// Centered, screen-dimming "Update Available" modal. Surfaced from
// App.tsx whenever `checkForUpdate()` returns a tag newer than the
// running app version AND that tag has not already been dismissed to the
// notifications bell.
//
// The modal is intentionally NOT focus-trapped — Aura's UI is
// tab-light and a strict trap would break the user's mental model of
// "Esc/click-out to dismiss". We do still mount it with role="dialog"
// + aria-modal="true" so screen readers identify it correctly.
//
// Two ways to dismiss: backdrop click and Esc.  Both call onDismiss,
// which in App.tsx writes the tag to localStorage at the
// "aura:update:dismissed-version" key and dispatches a CustomEvent for
// the (separately-implemented) bell to consume. We do NOT close on the
// "Update" button — the parent handles that after openUrl resolves.
//
// Animations live in App.css (.aura-update-backdrop / .aura-update-card)
// rather than inline styles so we share the @layer-components scoping
// and theme cross-fade behaviour with the rest of the app.

import { useEffect, useMemo, useState } from "react";
import type { UpdateInfo } from "./updaterPlugin";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Props {
  release:        UpdateInfo;
  currentVersion: string;
  /** Primary action — kicks off the in-app signed download + install
   *  via the tauri-plugin-updater. The popup manages its own busy
   *  state during the call. Returns true on success (the app
   *  relaunches automatically, so the success branch typically never
   *  paints) and false on any failure; an error string is rendered
   *  inline when false. */
  onUpdate:       () => Promise<boolean>;
  onDismiss:      () => void;
}

/** CP437 → byte map for the upper-half (0x80–0xEF) range — covers the
 *  characters that show up when UTF-8 box-drawing / accented Latin text
 *  is decoded as CP437 by mistake. Used by `recoverFromCp437Mojibake`
 *  to undo a known-bad encoding chain in pre-v0.6.22 latest.json
 *  manifests (the release script ran on a non-UTF-8 console and
 *  decoded `git`'s stdout as CP437 before encoding the result back
 *  into the manifest as UTF-8). */
const CP437_TO_BYTE: Record<string, number> = {
  "Ç":0x80,"ü":0x81,"é":0x82,"â":0x83,"ä":0x84,"à":0x85,"å":0x86,"ç":0x87,
  "ê":0x88,"ë":0x89,"è":0x8A,"ï":0x8B,"î":0x8C,"ì":0x8D,"Ä":0x8E,"Å":0x8F,
  "É":0x90,"æ":0x91,"Æ":0x92,"ô":0x93,"ö":0x94,"ò":0x95,"û":0x96,"ù":0x97,
  "ÿ":0x98,"Ö":0x99,"Ü":0x9A,"¢":0x9B,"£":0x9C,"¥":0x9D,"₧":0x9E,"ƒ":0x9F,
  "á":0xA0,"í":0xA1,"ó":0xA2,"ú":0xA3,"ñ":0xA4,"Ñ":0xA5,"ª":0xA6,"º":0xA7,
  "¿":0xA8,"⌐":0xA9,"¬":0xAA,"½":0xAB,"¼":0xAC,"¡":0xAD,"«":0xAE,"»":0xAF,
  "░":0xB0,"▒":0xB1,"▓":0xB2,"│":0xB3,"┤":0xB4,"╡":0xB5,"╢":0xB6,"╖":0xB7,
  "╕":0xB8,"╣":0xB9,"║":0xBA,"╗":0xBB,"╝":0xBC,"╜":0xBD,"╛":0xBE,"┐":0xBF,
  "└":0xC0,"┴":0xC1,"┬":0xC2,"├":0xC3,"─":0xC4,"┼":0xC5,"╞":0xC6,"╟":0xC7,
  "╚":0xC8,"╔":0xC9,"╩":0xCA,"╦":0xCB,"╠":0xCC,"═":0xCD,"╬":0xCE,"╧":0xCF,
  "╨":0xD0,"╤":0xD1,"╥":0xD2,"╙":0xD3,"╘":0xD4,"╒":0xD5,"╓":0xD6,"╫":0xD7,
  "╪":0xD8,"┘":0xD9,"┌":0xDA,"█":0xDB,"▄":0xDC,"▌":0xDD,"▐":0xDE,"▀":0xDF,
  "α":0xE0,"ß":0xE1,"Γ":0xE2,"π":0xE3,"Σ":0xE4,"σ":0xE5,"µ":0xE6,"τ":0xE7,
  "Φ":0xE8,"Θ":0xE9,"Ω":0xEA,"δ":0xEB,"∞":0xEC,"φ":0xED,"ε":0xEE,"∩":0xEF,
};

/** Detect & reverse the CP437-mojibake chain that v0.6.21's release
 *  script applied to UTF-8 tag bodies. The trigger is the unmistakable
 *  `Γ<a><b>` triplet pattern — Γ = U+0393 (CP437 byte 0xE2, the leading
 *  byte of every UTF-8 box-drawing character) followed by two more
 *  high-CP437 chars. If we find that pattern, walk every char in the
 *  string, map each to its CP437 byte (ASCII fall-through for chars
 *  already in the 0x00–0x7F range), and decode the resulting byte
 *  array as UTF-8. Any mapping miss or decode failure aborts the
 *  recovery; the original string is returned untouched so we never
 *  destroy a legitimate non-mojibake release note. */
function recoverFromCp437Mojibake(text: string): string {
  if (!/Γ[-∀]{2}/.test(text)) return text;
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
      continue;
    }
    const mapped = CP437_TO_BYTE[ch];
    if (mapped === undefined) return text;
    bytes.push(mapped);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return text;
  }
}

/** Cap the rendered release notes at a generous limit so a runaway
 *  tag body can't make the popup scroll forever. 2200 chars covers a
 *  multi-section changelog with FIXED / ADDED / CHANGED blocks and
 *  still leaves the action row visible without the user having to
 *  scroll. Anything longer truncates with an ellipsis and a hint to
 *  view full notes on GitHub. */
const NOTES_MAX = 2200;
function truncateNotes(body: string): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.length <= NOTES_MAX) return trimmed;
  const slice = trimmed.slice(0, NOTES_MAX);
  const lastBreak = Math.max(
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
  );
  const cut = lastBreak > NOTES_MAX * 0.6 ? slice.slice(0, lastBreak + 1) : slice;
  return cut.trimEnd() + "…";
}

/** Block-level structural parse of the lightweight changelog format
 *  Aura's release tags use:
 *
 *    ════════════════════════════════
 *    SECTION HEADER
 *    ════════════════════════════════
 *
 *      • bullet point one
 *      • bullet point two with
 *        continuation indent
 *
 *    paragraph text
 *
 *  Outputs structured blocks the renderer can layout — proper
 *  headings, bullet lists, and paragraph runs — so the popup reads
 *  like styled content instead of a wall of pre-wrapped monospace.
 *  Lines that don't fit a known pattern fall back to paragraph runs
 *  to preserve content. */
type NoteBlock =
  | { kind: "rule" }
  | { kind: "heading"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "paragraph"; text: string };

const RULE_RE = /^[─━═\-_=]{6,}$/;

function parseNoteBlocks(notes: string): NoteBlock[] {
  const lines = notes.split(/\r?\n/);
  const blocks: NoteBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    if (RULE_RE.test(trimmed)) {
      // Rule. If the next non-empty line is short + uppercase, treat
      // the rule + that line as a heading (and skip the closing rule
      // if it's there too). Otherwise emit a plain rule.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const candidate = j < lines.length ? lines[j].trim() : "";
      const isHeading =
        candidate.length > 0 &&
        candidate.length <= 60 &&
        candidate === candidate.toUpperCase() &&
        !RULE_RE.test(candidate);
      if (isHeading) {
        blocks.push({ kind: "heading", text: candidate });
        i = j + 1;
        // Swallow a closing rule if it immediately follows.
        while (i < lines.length && !lines[i].trim()) i += 1;
        if (i < lines.length && RULE_RE.test(lines[i].trim())) i += 1;
        continue;
      }
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }
    // Bullet block — runs of lines whose first non-space token is a
    // bullet glyph. Continuation lines (indented but no bullet) fold
    // into the previous item.
    if (/^\s*[•·●▪■▶►*-]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const curTrim = cur.trim();
        if (!curTrim) {
          i += 1;
          // Blank line between bullets is fine — keep collecting.
          if (i < lines.length && /^\s*[•·●▪■▶►*-]\s+/.test(lines[i])) {
            continue;
          }
          break;
        }
        const bullet = cur.match(/^\s*[•·●▪■▶►*-]\s+(.*)$/);
        if (bullet) {
          items.push(bullet[1]);
          i += 1;
          continue;
        }
        // Continuation line — append to the previous item.
        if (items.length > 0 && /^\s+/.test(cur)) {
          items[items.length - 1] = items[items.length - 1] + " " + curTrim;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ kind: "bullets", items });
      continue;
    }
    // Paragraph — collect consecutive non-bullet, non-rule lines into
    // one block; preserves intentional line-breaks via space-join so
    // hard-wrapped tag prose reads like flowing text.
    const para: string[] = [trimmed];
    i += 1;
    while (i < lines.length) {
      const cur = lines[i];
      const curTrim = cur.trim();
      if (!curTrim) break;
      if (RULE_RE.test(curTrim)) break;
      if (/^\s*[•·●▪■▶►*-]\s+/.test(cur)) break;
      para.push(curTrim);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") });
  }
  return blocks;
}

export default function UpdatePopup({
  release,
  currentVersion,
  onUpdate,
  onDismiss,
}: Props) {
  /** True while the plugin is downloading + verifying + installing.
   *  Disables the action buttons and swaps the Install label for
   *  "Installing…". Success branch typically never paints because
   *  the plugin relaunches the app on completion. */
  const [installing, setInstalling] = useState(false);
  /** Non-null when the download/install path failed (signature
   *  mismatch, network outage, write permission, etc). Surfaced
   *  inline above the action row so the user has a recovery hint
   *  before falling back to the GitHub release page. */
  const [installError, setInstallError] = useState<string | null>(null);

  // Esc handler — mounted only while this popup is up, so we don't have
  // to coordinate with the global keybinding system in useKeybindings.
  // While installing, Esc is suppressed so the user can't accidentally
  // dismiss mid-download (the plugin holds open file handles that we'd
  // rather see finish).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (installing) return;
        e.stopPropagation();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onDismiss, installing]);

  // Run mojibake recovery BEFORE truncation so the heuristic gets the
  // full string to work on — truncating first could split a 3-char
  // mojibake triplet across the boundary and leave us unable to undo
  // it. The recovery is no-op when the body is clean.
  const noteBlocks = useMemo(() => {
    const raw = release.body ?? "";
    const recovered = recoverFromCp437Mojibake(raw);
    const truncated = truncateNotes(recovered);
    return parseNoteBlocks(truncated);
  }, [release.body]);
  // Plugin's UpdateInfo carries a bare version like "0.6.9"; surface
  // it with the conventional "v" prefix to match the GitHub release
  // page and the user's mental model of release tags.
  const targetTag = `v${release.version}`;
  const releasePageUrl = `https://github.com/rm-sage/Aura/releases/tag/${targetTag}`;

  const handleInstall = async () => {
    if (installing) return;
    setInstallError(null);
    setInstalling(true);
    try {
      const ok = await onUpdate();
      if (!ok) {
        setInstallError("Install failed — the signed download or signature check didn't succeed. Use \"View on GitHub\" to download the installer manually.");
      }
    } catch (e) {
      setInstallError(String(e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aura-update-title"
      className="aura-update-backdrop fixed inset-0 z-[60] flex items-center
                 justify-center bg-black/60 backdrop-blur-md"
      onClick={(e) => {
        if (installing) return;
        if (e.target === e.currentTarget) onDismiss();
      }}
    >
      <div
        className="aura-update-card glass-panel-elevated rounded-2xl
                   px-8 py-7 w-full max-w-[680px] mx-4 shadow-glass-edge
                   flex flex-col gap-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-col gap-1">
          <h2
            id="aura-update-title"
            className="text-[var(--text-primary)] text-xl font-medium
                       tracking-wide flex items-center gap-2"
          >
            <span className="text-[color:rgb(91,164,255)]">Update Available</span>
          </h2>
          <p className="text-white/55 text-xs tracking-wide">
            Aura {currentVersion}
            <span className="px-1.5 text-white/35">→</span>
            <span className="text-white/85 font-medium">{targetTag}</span>
          </p>
        </div>

        {/* Release notes — block-parsed (headings / bullets / rules /
            paragraphs) so a multi-section changelog reads as styled
            content instead of monospace pre-wrapped text. Scrolls when
            the body exceeds the height cap (~half-viewport). */}
        {noteBlocks.length > 0 && (
          <div
            className="bg-white/[0.03] border border-white/[0.08] rounded-xl
                       px-5 py-4 max-h-[50vh] overflow-y-auto"
          >
            <div className="text-white/75 text-[13px] leading-relaxed space-y-3">
              {noteBlocks.map((block, idx) => {
                switch (block.kind) {
                  case "rule":
                    return (
                      <hr
                        key={idx}
                        className="border-0 border-t border-white/10 my-1"
                      />
                    );
                  case "heading":
                    return (
                      <h3
                        key={idx}
                        className="text-[color:rgb(91,164,255)] text-[11px]
                                   font-semibold tracking-[0.2em] uppercase
                                   pt-1"
                      >
                        {block.text}
                      </h3>
                    );
                  case "bullets":
                    return (
                      <ul key={idx} className="space-y-2 pl-1">
                        {block.items.map((item, j) => (
                          <li
                            key={j}
                            className="flex gap-2.5 text-white/75"
                          >
                            <span className="text-[color:rgb(91,164,255)]/70 mt-[2px] shrink-0">
                              •
                            </span>
                            <span className="flex-1">{item}</span>
                          </li>
                        ))}
                      </ul>
                    );
                  case "paragraph":
                    return (
                      <p key={idx} className="text-white/75">
                        {block.text}
                      </p>
                    );
                }
              })}
            </div>
          </div>
        )}

        {/* Inline error — rendered between notes and actions so the
            user sees the failure context before deciding whether to
            retry or fall back to the browser. */}
        {installError && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/8 px-3 py-2">
            <p className="text-red-200/90 text-[11px] leading-snug">{installError}</p>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button"
            onClick={() => openUrl(releasePageUrl).catch(() => {})}
            disabled={installing}
            className="px-3 py-2 rounded-xl text-[11px] text-white/45
                       hover:text-white/75 hover:bg-white/[0.04]
                       disabled:opacity-40 disabled:cursor-not-allowed
                       transition-colors"
          >
            View on GitHub
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onDismiss}
              disabled={installing}
              className="px-4 py-2 rounded-xl text-sm text-white/60
                         hover:text-white/90 hover:bg-white/[0.05]
                         disabled:opacity-40 disabled:cursor-not-allowed
                         transition-colors"
            >
              Dismiss
            </button>
            <button
              type="button"
              onClick={handleInstall}
              disabled={installing}
              className="px-4 py-2 rounded-xl text-sm font-medium text-white
                         bg-ln-accent/80 hover:bg-ln-accent active:scale-95
                         disabled:opacity-60 disabled:cursor-progress
                         transition-all shadow-accent-glow"
            >
              {installing ? "Installing…" : "Install"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
