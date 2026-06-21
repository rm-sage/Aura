// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// releaseNotesRender.tsx ─────────────────────────────────────────────────────
//
// Shared renderer for Aura's lightweight changelog format (the `## Section` /
// `- bullet` / `**bold**` / `═══` rule prose our release tags use). Used by the
// UpdatePopup AND the Settings changelog so notes look identical everywhere.
//
// Extracted from UpdatePopup.tsx — the CP437 mojibake recovery (for pre-v0.6.22
// manifests) is a no-op on clean text, so it's safe to run on GitHub-API note
// bodies too.

import { useMemo, type ReactNode } from "react";

/** CP437 → byte map for the upper-half (0x80–0xEF) range — covers the
 *  characters that show up when UTF-8 box-drawing / accented Latin text was
 *  decoded as CP437 by mistake (a pre-v0.6.22 release-script bug). */
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

/** Detect & reverse the CP437-mojibake chain that v0.6.21's release script
 *  applied to UTF-8 tag bodies. No-op on clean strings. */
export function recoverFromCp437Mojibake(text: string): string {
  if (!/Γ[-∀]{2}/.test(text)) return text;
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) { bytes.push(cp); continue; }
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

/** Cap rendered notes so a runaway body can't scroll forever. Cuts on a clean
 *  sentence/paragraph boundary when possible. Pass `Infinity` to disable. */
export function truncateNotes(body: string, max = 2200): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  const slice = trimmed.slice(0, max);
  const lastBreak = Math.max(
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
  );
  const cut = lastBreak > max * 0.6 ? slice.slice(0, lastBreak + 1) : slice;
  return cut.trimEnd() + "…";
}

type NoteBlock =
  | { kind: "rule" }
  | { kind: "heading"; text: string; level: 1 | 2 }
  | { kind: "lead"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "paragraph"; text: string };

const RULE_RE = /^[─━═\-_=]{6,}$/;
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*#*$/;

/** Render `**bold**` inline; everything else passes through. */
function renderInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+?\*\*)/g).map((part, i) => {
    const m = /^\*\*([^*]+?)\*\*$/.exec(part);
    return m
      ? <strong key={i} className="text-white font-semibold">{m[1]}</strong>
      : <span key={i}>{part}</span>;
  });
}

export function parseNoteBlocks(notes: string): NoteBlock[] {
  const lines = notes.split(/\r?\n/);
  const blocks: NoteBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { i += 1; continue; }
    const h = HEADING_RE.exec(trimmed);
    if (h) {
      blocks.push({ kind: "heading", text: h[2].trim(), level: h[1].length <= 1 ? 1 : 2 });
      i += 1;
      continue;
    }
    if (RULE_RE.test(trimmed)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      const candidate = j < lines.length ? lines[j].trim() : "";
      const isHeading =
        candidate.length > 0 && candidate.length <= 60 &&
        candidate === candidate.toUpperCase() && !RULE_RE.test(candidate);
      if (isHeading) {
        blocks.push({ kind: "heading", text: candidate, level: 2 });
        i = j + 1;
        while (i < lines.length && !lines[i].trim()) i += 1;
        if (i < lines.length && RULE_RE.test(lines[i].trim())) i += 1;
        continue;
      }
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }
    if (/^\s*[•·●▪■▶►*-]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const curTrim = cur.trim();
        if (!curTrim) {
          i += 1;
          if (i < lines.length && /^\s*[•·●▪■▶►*-]\s+/.test(lines[i])) continue;
          break;
        }
        const bullet = cur.match(/^\s*[•·●▪■▶►*-]\s+(.*)$/);
        if (bullet) { items.push(bullet[1]); i += 1; continue; }
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
    // Plain (non-markdown) section header: a short title that immediately
    // precedes a bullet list and isn't prose. Lets notes authored as
    // "Watch Trailer\n- …" get the SAME accent-bar heading treatment as the
    // `## Section` and ALL-CAPS-with-rule forms — so plain-format release notes
    // render consistently without re-authoring. Trailing sentence punctuation
    // (`.`/`:` …) excludes a real lead-in sentence (e.g. the 1.0.6 lead).
    if (trimmed.length <= 60 && !/[.:,;!?]$/.test(trimmed)) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j < lines.length && /^\s*[•·●▪■▶►*-]\s+/.test(lines[j])) {
        blocks.push({ kind: "heading", text: trimmed, level: 2 });
        i += 1;
        continue;
      }
    }
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
    blocks.push(
      blocks.length === 0
        ? { kind: "lead", text: para.join(" ") }
        : { kind: "paragraph", text: para.join(" ") },
    );
  }
  return blocks;
}

/** Render parsed release notes as styled blocks (headings / bullets / rules /
 *  paragraphs). `max` truncates (default 2200; pass Infinity for full text). */
export function ReleaseNotesBody({ notes, max = 2200 }: { notes: string; max?: number }) {
  const blocks = useMemo(() => {
    const recovered = recoverFromCp437Mojibake(notes ?? "");
    // The GitHub release `.body` (from `gh release create --notes-from-tag`)
    // begins with the tag's "Aura vX.Y.Z" subject line. The version is already
    // shown as the entry header, so strip that leading duplicate before
    // parsing. (latest.json notes use the tag BODY only and have no such line,
    // so the regex is a no-op there — both surfaces stay correct.)
    const deduped = recovered.replace(/^\s*Aura\s+v?\d+(?:\.\d+)*\s*(?:\r?\n|$)/, "");
    return parseNoteBlocks(truncateNotes(deduped, max));
  }, [notes, max]);

  return (
    <div className="text-white/75 text-[13px] leading-relaxed space-y-3">
      {blocks.map((block, idx) => {
        switch (block.kind) {
          case "rule":
            return <hr key={idx} className="border-0 border-t border-white/10 my-1" />;
          case "heading":
            return block.level === 1 ? (
              <h3 key={idx} className="flex items-center gap-2.5 text-white text-[15px] font-semibold tracking-tight pt-1">
                <span className="w-1.5 h-1.5 rounded-full bg-ln-accent shadow-accent-glow" />
                {block.text}
              </h3>
            ) : (
              <h4 key={idx} className="flex items-center gap-2 pt-2">
                <span className="w-[3px] h-[13px] rounded-full bg-ln-accent/70 shrink-0" />
                <span className="text-[color:rgb(91,164,255)] text-[11px] font-bold tracking-[0.16em] uppercase">
                  {block.text}
                </span>
              </h4>
            );
          case "lead":
            return <p key={idx} className="text-white/90 text-[13.5px] leading-relaxed">{renderInline(block.text)}</p>;
          case "bullets":
            return (
              <ul key={idx} className="space-y-1.5 pl-1">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-2.5 text-white/75">
                    <span className="text-[color:rgb(91,164,255)]/70 mt-[2px] shrink-0">•</span>
                    <span className="flex-1">{renderInline(item)}</span>
                  </li>
                ))}
              </ul>
            );
          case "paragraph":
            return <p key={idx} className="text-white/75">{renderInline(block.text)}</p>;
        }
      })}
    </div>
  );
}
