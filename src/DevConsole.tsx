// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// DevConsole — F12-toggled terminal-style log viewer.
//
// Sources:
//   • Rust         → `dev-log` Tauri events (devlog::log on the backend)
//   • React        → console.log/info/warn/error/debug overrides
//   • App-internal → `aura:dev-log` CustomEvents (e.g. ErrorBoundary)
//
// All three feed the same in-memory ring buffer (1k entries by default).
// Filter pills toggle visibility per-level. Optional auto-scroll keeps the
// tail in view; a "pause" button halts the stream so the user can read.
// ---------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

interface LogEntry {
  id: number;
  ts: number;
  level: LogLevel;
  source: string;
  message: string;
  /** Optional stack trace (from console.error / ErrorBoundary). */
  stack?: string | null;
}

const LEVELS: LogLevel[] = ["trace", "debug", "info", "warn", "error"];
/** Hard cap on retained log entries. Bumped from 1k to 10k per user
 *  request — at ~150 bytes per entry that's ~1.5 MB of memory, which
 *  is negligible. Render-side we cap the visible DOM to MAX_RENDERED
 *  to keep scrolling smooth on extreme histories. */
const MAX_ENTRIES = 10000;
/** Cap on rendered DOM rows. Anything beyond is held in memory but
 *  hidden from the DOM until the user filters down or scrolls past
 *  the boundary; React's per-row cost (≈ 4 spans + className recalc)
 *  starts to slow scroll fps past ~3000 rows on a mid-tier laptop. */
const MAX_RENDERED = 2500;

const LEVEL_STYLE: Record<LogLevel, { fg: string; bg: string; border: string; tag: string }> = {
  trace: { fg: "text-white/40",     bg: "bg-white/4",       border: "border-white/10",        tag: "TRACE" },
  debug: { fg: "text-cyan-300/85",  bg: "bg-cyan-500/10",   border: "border-cyan-400/20",     tag: "DEBUG" },
  info:  { fg: "text-blue-300/85",  bg: "bg-blue-500/10",   border: "border-blue-400/20",     tag: "INFO " },
  warn:  { fg: "text-amber-300",    bg: "bg-amber-500/12",  border: "border-amber-400/30",    tag: "WARN " },
  error: { fg: "text-red-300",      bg: "bg-red-500/15",    border: "border-red-400/35",      tag: "ERROR" },
};

// ---------------------------------------------------------------------------
// console hook — install once per session. Re-entrant safe (idempotent).
// ---------------------------------------------------------------------------

let consoleHooked = false;

function installConsoleHook(push: (e: Omit<LogEntry, "id">) => void) {
  if (consoleHooked) return;
  consoleHooked = true;
  const originals = {
    log:   console.log.bind(console),
    info:  console.info.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };
  const fmt = (args: unknown[]) =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
        if (typeof a === "string") return a;
        try { return JSON.stringify(a); } catch { return String(a); }
      })
      .join(" ");

  const wrap =
    (orig: (...args: any[]) => void, level: LogLevel) =>
    (...args: any[]) => {
      try {
        const stackArg = args.find((a) => a instanceof Error) as Error | undefined;
        push({
          ts: Date.now(),
          level,
          source: "react",
          message: fmt(args),
          stack: stackArg?.stack ?? null,
        });
      } catch {
        // Never let our hook crash the app's logger.
      }
      orig(...args);
    };

  console.log   = wrap(originals.log,   "info");
  console.info  = wrap(originals.info,  "info");
  console.warn  = wrap(originals.warn,  "warn");
  console.error = wrap(originals.error, "error");
  console.debug = wrap(originals.debug, "debug");
}

// ---------------------------------------------------------------------------
// handleLogCopy — collapse per-row flex-child newlines so a copied log line
// lands on the clipboard as a SINGLE contiguous string, not split across
// timestamp / level / scope / message blocks.
//
// Why this is needed: each Row is `flex items-start gap-3 …` with four
// inline children (time, level pill, source, message). Flex items are
// block boxes for selection purposes, so the browser inserts a newline
// between every child when the user copies. Selecting one log row therefore
// produces 4+ lines of text on the clipboard — annoying when pasting into a
// chat or bug report.
//
// Strategy: detect which rows intersect the selection (each row carries
// `data-log-row`), reduce each row's text content to one line (newlines →
// spaces, then collapse multi-spaces), and join multiple rows with a single
// `\n`. Partial selection inside a single row also gets cleaned up.
// ---------------------------------------------------------------------------

function handleLogCopy(e: React.ClipboardEvent<HTMLDivElement>) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

  const range = sel.getRangeAt(0);
  const root  = e.currentTarget;

  const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-log-row]"))
    .filter((row) => range.intersectsNode(row));

  // Selection is purely within a single row's content (didn't cross a row
  // boundary). Drop into a simpler "collapse newlines in the literal
  // selection" path so partial-line copies (e.g. just the message text)
  // still respect the user's selection bounds.
  if (rows.length === 0) {
    const text = sel.toString().replace(/\r?\n/g, " ").replace(/ {2,}/g, " ").trim();
    if (text.length === 0) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    return;
  }

  // Selection touches at least one row boundary. Emit each touched row as
  // its own single-line entry. NOTE: this copies the FULL row even on a
  // partial selection that crosses into it — that matches the user's
  // expressed intent ("select one log line, copy a clean log line").
  const lines = rows
    .map((row) => (row.innerText || row.textContent || "")
      .replace(/\r?\n/g, " ")
      .replace(/ {2,}/g, " ")
      .trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return;
  e.clipboardData.setData("text/plain", lines.join("\n"));
  e.preventDefault();
}

// ---------------------------------------------------------------------------
// Bulk-export helpers — used by the Copy / Download toolbar buttons. Mirrors
// what the Row component renders: HH:MM:SS.mmm  LEVEL  source  message,
// with the stack (if any) appended on a separate indented line.
// ---------------------------------------------------------------------------

function formatEntryLine(entry: LogEntry): string {
  const d = new Date(entry.ts);
  const time =
    `${String(d.getHours()).padStart(2, "0")}:` +
    `${String(d.getMinutes()).padStart(2, "0")}:` +
    `${String(d.getSeconds()).padStart(2, "0")}.` +
    `${String(d.getMilliseconds()).padStart(3, "0")}`;
  const tag = LEVEL_STYLE[entry.level].tag.trim().padEnd(5);
  let line = `${time}  ${tag}  ${entry.source.padEnd(10)}  ${entry.message}`;
  if (entry.stack) line += `\n${entry.stack}`;
  return line;
}

function buildExportText(entries: LogEntry[]): string {
  const now = new Date();
  const header =
    `# Aura DevConsole export\n` +
    `# Generated: ${now.toISOString()}\n` +
    `# Entries: ${entries.length}\n\n`;
  return header + entries.map(formatEntryLine).join("\n") + "\n";
}

function defaultExportFilename(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `aura-devlogs-${yyyy}-${mm}-${dd}_${hh}${mi}${ss}.log`;
}

// ---------------------------------------------------------------------------
// Command prompt — types + helpers
// ---------------------------------------------------------------------------

/**
 * Side-effect handles a command can use. Bundled into one object so each
 * command's `run` stays small (no individual setter prop drilling) and so
 * the COMMANDS table can live at module scope without capturing component
 * state.
 */
interface CommandContext {
  /** Append a synthetic log entry to the buffer. */
  push: (e: Omit<LogEntry, "id">) => void;
  /** Replace the entries buffer (clear, restore, etc.). */
  setEntries: React.Dispatch<React.SetStateAction<LogEntry[]>>;
  /** Toggle pause / resume. */
  setPaused: React.Dispatch<React.SetStateAction<boolean>>;
  /** Update the level filter map. */
  setEnabled: React.Dispatch<React.SetStateAction<Record<LogLevel, boolean>>>;
  /** Update the search filter. */
  setSearch: React.Dispatch<React.SetStateAction<string>>;
}

interface DevCommand {
  /** Primary keyword used to invoke. Lowercase, no spaces. */
  name: string;
  /** Short usage line shown in autocomplete. e.g. "throw [message]". */
  usage: string;
  /** One-line description shown in autocomplete. */
  description: string;
  /** Implementation. `args` is the raw string after the command name (may be ""). */
  run: (args: string, ctx: CommandContext) => void | Promise<void>;
}

const COMMANDS: DevCommand[] = [
  {
    name: "help",
    usage: "help",
    description: "List every DevConsole command",
    run: (_args, ctx) => {
      const lines = ["Aura DevConsole commands:"];
      for (const c of COMMANDS) lines.push(`  ${c.usage.padEnd(28)} ${c.description}`);
      ctx.push({ ts: Date.now(), level: "info", source: "console", message: lines.join("\n") });
    },
  },
  {
    name: "clear",
    usage: "clear",
    description: "Clear the log buffer",
    run: (_args, ctx) => { ctx.setEntries([]); },
  },
  {
    name: "pause",
    usage: "pause",
    description: "Stop appending new log entries (buffered until resume)",
    run: (_args, ctx) => { ctx.setPaused(true); },
  },
  {
    name: "resume",
    usage: "resume",
    description: "Resume appending log entries and flush the buffer",
    run: (_args, ctx) => { ctx.setPaused(false); },
  },
  {
    name: "search",
    usage: "search <query>",
    description: "Filter visible entries by message / source substring",
    run: (args, ctx) => { ctx.setSearch(args.trim()); },
  },
  {
    name: "unfilter",
    usage: "unfilter",
    description: "Clear the search filter and re-enable every log level",
    run: (_args, ctx) => {
      ctx.setSearch("");
      ctx.setEnabled({ trace: true, debug: true, info: true, warn: true, error: true });
    },
  },
  {
    name: "level",
    usage: "level <name> on|off",
    description: "Toggle a single log level (e.g. `level trace on`)",
    run: (args, ctx) => {
      const m = args.trim().match(/^(trace|debug|info|warn|error)\s+(on|off)$/i);
      if (!m) {
        ctx.push({
          ts: Date.now(), level: "warn", source: "console",
          message: "Usage: level <trace|debug|info|warn|error> <on|off>",
        });
        return;
      }
      const name = m[1].toLowerCase() as LogLevel;
      const on = m[2].toLowerCase() === "on";
      ctx.setEnabled((p) => ({ ...p, [name]: on }));
    },
  },
  {
    name: "info",
    usage: "info <message>",
    description: "Append a synthetic INFO log entry",
    run: (args, ctx) => {
      ctx.push({ ts: Date.now(), level: "info", source: "console", message: args || "(empty)" });
    },
  },
  {
    name: "warn",
    usage: "warn <message>",
    description: "Append a synthetic WARN log entry",
    run: (args, ctx) => {
      ctx.push({ ts: Date.now(), level: "warn", source: "console", message: args || "(empty)" });
    },
  },
  {
    name: "error",
    usage: "error <message>",
    description: "Append a synthetic ERROR log entry (does NOT throw)",
    run: (args, ctx) => {
      ctx.push({ ts: Date.now(), level: "error", source: "console", message: args || "(empty)" });
    },
  },
  {
    name: "debug",
    usage: "debug <message>",
    description: "Append a synthetic DEBUG log entry",
    run: (args, ctx) => {
      ctx.push({ ts: Date.now(), level: "debug", source: "console", message: args || "(empty)" });
    },
  },
  {
    name: "throw",
    usage: "throw [message]",
    description: "Throw an unhandled Error to verify frontend Sentry capture",
    run: (args, ctx) => {
      const msg = args.trim() || "DevConsole-triggered error (Sentry test)";
      ctx.push({
        ts: Date.now(), level: "info", source: "console",
        message: `Throwing test error → expect a [fatal] log entry below this line and an Issue in Sentry within ~30 s.`,
      });
      // setTimeout so the throw escapes React's event handler boundary
      // and lands as a true `window.onerror` event — same path Sentry
      // and main.tsx::onerror are watching.
      setTimeout(() => { throw new Error(msg); }, 0);
    },
  },
  {
    name: "panic",
    usage: "panic [message]",
    description: "Force a Rust panic to verify backend Sentry capture (app may exit)",
    run: async (args, ctx) => {
      const msg = args.trim();
      ctx.push({
        ts: Date.now(), level: "warn", source: "console",
        message: `Forcing Rust panic. Aura may exit. Open Sentry → Issues to verify.`,
      });
      try {
        await invoke("dev_force_panic", { message: msg.length > 0 ? msg : null });
      } catch (e) {
        // Expected — the worker thread panic surfaces as a JoinError
        // that we re-emit as a Tauri command error string.
        ctx.push({
          ts: Date.now(), level: "error", source: "console",
          message: `panic raised: ${String(e)}`,
        });
      }
    },
  },
  {
    name: "version",
    usage: "version",
    description: "Print the Aura build version",
    run: (_args, ctx) => {
      const v = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? "(unknown)";
      ctx.push({ ts: Date.now(), level: "info", source: "console", message: `Aura ${v}` });
    },
  },
  {
    name: "scrobble",
    usage: "scrobble",
    description: "Fire a test scrobble against the current stream (Trakt + AniList per same gates as scrobble_end). Requires an active stream — works the moment the player is open, no warmup wait.",
    run: async (_args, ctx) => {
      // Dispatch an event App.tsx listens for; the listener has the
      // current activeTarget + playback snapshot in scope and runs
      // the actual invoke. Returns a Promise via the event detail so
      // we can await the result and print it here. This indirection
      // lets the DevConsole live as a leaf component without prop-
      // threading activeTarget through every parent.
      type Result = {
        ok: boolean;
        message: string;
        level: "info" | "warn" | "error";
      };
      try {
        const result = await new Promise<Result>((resolve) => {
          // 5s timeout in case App.tsx isn't mounted (e.g. console
          // opened mid-tear-down). The listener clears the timeout
          // on its own resolve; we clear it on response.
          const timeout = setTimeout(() => resolve({
            ok: false,
            level: "error",
            message: "scrobble test timed out (App.tsx listener didn't respond)",
          }), 5000);
          window.dispatchEvent(new CustomEvent("aura:devlogs-scrobble-test", {
            detail: {
              respond: (r: Result) => { clearTimeout(timeout); resolve(r); },
            },
          }));
        });
        ctx.push({
          ts: Date.now(),
          level: result.level,
          source: "console",
          message: result.message,
        });
      } catch (e) {
        ctx.push({
          ts: Date.now(), level: "error", source: "console",
          message: `scrobble test failed: ${String(e)}`,
        });
      }
    },
  },
  {
    name: "notifytest",
    usage: "notifytest <imdb_id>",
    description: "Force a notifications-system test for one library series. Clears Aura's local 'seen episodes' record for the id, fetches the fresh cloud release signal, and triggers a library refresh — the scanner should then see cloud's last_aired as newer than its local state and fire a notification. Per release-search-spec § notification-test guide.",
    run: async (args, ctx) => {
      const imdbId = args.trim();
      if (!imdbId) {
        ctx.push({
          ts: Date.now(), level: "warn", source: "console",
          message: "Usage: notifytest <imdb_id>  (e.g. notifytest tt22248376)",
        });
        return;
      }
      if (!imdbId.startsWith("tt")) {
        ctx.push({
          ts: Date.now(), level: "warn", source: "console",
          message: `notifytest: id ${imdbId} doesn't look like an IMDb id (expected tt-prefix)`,
        });
        return;
      }
      const SCANNER_STATE_KEY = "aura:notifications:scanner-state";
      // Step 1 — clear the scanner's seen-episodes record for this id
      // so the next scan treats every video in the addon's feed as
      // "first contact" and re-evaluates against the recent-release
      // window. The localStorage shape is documented in
      // NotificationsScanner.tsx.
      let cleared = false;
      try {
        const raw = localStorage.getItem(SCANNER_STATE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Record<string, { lastChecked: number; seenVideoIds: string[] }>;
          if (parsed && typeof parsed === "object" && parsed[imdbId]) {
            delete parsed[imdbId];
            localStorage.setItem(SCANNER_STATE_KEY, JSON.stringify(parsed));
            cleared = true;
          }
        }
      } catch (e) {
        ctx.push({
          ts: Date.now(), level: "warn", source: "console",
          message: `notifytest: failed to clear scanner state — ${String(e)}`,
        });
      }
      ctx.push({
        ts: Date.now(), level: "info", source: "console",
        message: cleared
          ? `notifytest: cleared scanner state for ${imdbId}`
          : `notifytest: no prior scanner state for ${imdbId} (will treat as first scan)`,
      });

      // Step 2 — fetch the cloud release signal so we can log what
      // cloud thinks the latest episode is. This also seeds the
      // release-signal store so any consumer that reads from it sees
      // fresh data immediately.
      try {
        const { fetchReleaseSignal } = await import("./releaseSearch");
        const signal = await fetchReleaseSignal(imdbId);
        if (!signal) {
          ctx.push({
            ts: Date.now(), level: "warn", source: "console",
            message: `notifytest: cloud has no signal for ${imdbId} (queued or not yet polled — try nudging via library refresh first)`,
          });
        } else {
          const la = signal.last_aired;
          const na = signal.next_aired;
          ctx.push({
            ts: Date.now(), level: "info", source: "console",
            message:
              `notifytest cloud(${imdbId}): ` +
              `last_aired=${la ? `${la.id} aired ${la.aired_at}` : "(none)"} ` +
              `next_aired=${na ? `${na.id} aired ${na.aired_at}` : "(none)"} ` +
              `polled_at=${signal.polled_at} ` +
              `episode_kinds.length=${signal.episode_kinds.length}`,
          });
        }
      } catch (e) {
        ctx.push({
          ts: Date.now(), level: "error", source: "console",
          message: `notifytest: cloud fetch failed — ${String(e)}`,
        });
      }

      // Step 3 — kick the library refresh. App.tsx listens for
      // aura:library-changed → loadLibrary → reconcileLibraryReleaseSignals.
      // The scanner separately polls on a 30-min timer; we also fire
      // its own change listener so it re-evaluates right now rather
      // than waiting for the next tick.
      window.dispatchEvent(new CustomEvent("aura:library-changed"));
      ctx.push({
        ts: Date.now(), level: "info", source: "console",
        message: "notifytest: fired aura:library-changed — watch for a notification in the bell within ~10s.",
      });
      ctx.push({
        ts: Date.now(), level: "info", source: "console",
        message:
          "If nothing fires: (a) confirm the cloud signal above shows a last_aired the scanner hasn't seen, " +
          "(b) confirm the title is in your library AND tt-prefixed (cloud is imdb-keyed; kitsu/mal/anidb library entries won't fire), " +
          "(c) confirm `releaseSearchEnabled` is on in Settings — Cloud Sync section.",
      });
    },
  },
  {
    name: "eval",
    usage: "eval <expression>",
    description: "Evaluate a JavaScript expression (power user; runs in app context)",
    run: (args, ctx) => {
      if (!args.trim()) {
        ctx.push({
          ts: Date.now(), level: "warn", source: "console",
          message: "Usage: eval <expression>",
        });
        return;
      }
      try {
        // indirect eval keeps the call out of strict scope so the
        // expression has access to globals (window.invoke et al)
        // rather than DevConsole's closure. Result stringified for
        // the log row — Errors and objects round-trip via JSON.
        // eslint-disable-next-line no-eval
        const result = (0, eval)(args);
        const formatted =
          result instanceof Error
            ? `${result.message}\n${result.stack ?? ""}`
            : typeof result === "string"
              ? result
              : (() => { try { return JSON.stringify(result, null, 2); } catch { return String(result); } })();
        ctx.push({
          ts: Date.now(), level: "info", source: "console",
          message: `→ ${formatted}`,
        });
      } catch (e) {
        ctx.push({
          ts: Date.now(), level: "error", source: "console",
          message: `eval threw: ${String(e)}`,
        });
      }
    },
  },
];

/** Resolve `input` against the command table for autocomplete. Returns
 *  the suggestions to render and a flag for whether the typed text is
 *  itself a complete command name (which suppresses suggestions for
 *  the second token onwards — e.g. once you've typed "throw " the
 *  dropdown should stop offering "throw / throws" as completions). */
function resolveSuggestions(input: string): { suggestions: DevCommand[]; insideArgs: boolean } {
  const trimmed = input.trimStart();
  // Empty input → no dropdown. Showing the full command list on plain
  // focus felt noisy; suggestions now only appear once the user has
  // typed at least one character. `help` covers the discovery case.
  if (trimmed === "") return { suggestions: [], insideArgs: false };
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace >= 0) {
    // User has moved past the command name into the args region.
    return { suggestions: [], insideArgs: true };
  }
  const q = trimmed.toLowerCase();
  return {
    suggestions: COMMANDS.filter((c) => c.name.startsWith(q)),
    insideArgs: false,
  };
}

// ---------------------------------------------------------------------------
// DevConsole component
// ---------------------------------------------------------------------------

export default function DevConsole() {
  const [open, setOpen]      = useState(false);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [enabled, setEnabled] = useState<Record<LogLevel, boolean>>({
    trace: false, debug: true, info: true, warn: true, error: true,
  });
  const [paused, setPaused]   = useState(false);
  const [search, setSearch]   = useState("");
  /** Brief "copied" / "saved" toast surfaced on the Copy / Download
   *  buttons after a successful action. Auto-clears after ~1.4 s. */
  const [exportStatus, setExportStatus] = useState<"copied" | "saved" | "error" | null>(null);

  const idRef          = useRef(0);
  const tailRef        = useRef<HTMLDivElement>(null);
  const pendingRef     = useRef<LogEntry[]>([]);
  const pausedRef      = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // ── Command prompt state ─────────────────────────────────────────────
  // `input`           — current text in the prompt
  // `suggestionIdx`   — selected row in the autocomplete dropdown
  // `historyRef`      — recent commands (most recent last); cap 50
  // `historyCursor`   — index into historyRef when navigating with Up/Down;
  //                     `null` when not currently navigating history
  const [input, setInput] = useState("");
  const [suggestionIdx, setSuggestionIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);

  // Auto-scroll suspends the moment the user scrolls UP from the tail.
  // It re-arms automatically once they scroll back to within ~20 px of
  // the bottom — that gives us a snap-resume gesture without an
  // explicit "resume" button.
  const [autoScroll, setAutoScroll] = useState(true);

  // Stable push function — buffers when paused so we can release later.
  const push = useMemo(() => {
    return (e: Omit<LogEntry, "id">) => {
      const next: LogEntry = { ...e, id: ++idRef.current };
      if (pausedRef.current) {
        pendingRef.current.push(next);
        return;
      }
      setEntries((prev) => {
        const merged = [...prev, ...pendingRef.current, next];
        pendingRef.current = [];
        // Trim to MAX_ENTRIES from the head
        return merged.length > MAX_ENTRIES ? merged.slice(-MAX_ENTRIES) : merged;
      });
    };
  }, []);

  // Install console hook once.
  useEffect(() => {
    installConsoleHook(push);
  }, [push]);

  // Listen for Rust dev-log events.
  useEffect(() => {
    const promise = listen<{ level: LogLevel; source: string; message: string; ts: number }>(
      "dev-log",
      ({ payload }) => {
        push({
          ts: payload.ts || Date.now(),
          level: payload.level,
          source: `rust:${payload.source}`,
          message: payload.message,
        });
      },
    );
    return () => { promise.then((fn) => fn()).catch(() => {}); };
  }, [push]);

  // Listen for `aura:dev-log` custom events (ErrorBoundary etc.).
  useEffect(() => {
    const onDevLog = (e: Event) => {
      const detail = (e as CustomEvent<{
        level: LogLevel; source: string; message: string; stack?: string;
      }>).detail;
      push({
        ts: Date.now(),
        level: detail.level ?? "info",
        source: detail.source ?? "react",
        message: detail.message ?? "",
        stack: detail.stack ?? null,
      });
    };
    window.addEventListener("aura:dev-log", onDevLog);
    return () => window.removeEventListener("aura:dev-log", onDevLog);
  }, [push]);

  // F12 toggles. Esc closes when open — registered in CAPTURE phase
  // and stops propagation so the player overlay's own Esc handler
  // doesn't get a chance to react first (otherwise Esc was being
  // swallowed by the fullscreen / overlay exits and the DevConsole
  // never closed via keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F12") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Use the LATEST `open` from a setter callback so this listener
      // stays correct without re-installing on every open toggle.
      setOpen((isOpen) => {
        if (!isOpen) return isOpen;
        e.preventDefault();
        e.stopPropagation();
        return false;
      });
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onKeyCapture, /* capture */ true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onKeyCapture, /* capture */ true);
    };
  }, []);

  // Auto-scroll to tail when entries grow (and not paused, and the
  // user hasn't manually scrolled up). Manual scroll-up is detected
  // by the body's onScroll handler below, which flips `autoScroll`
  // off and back on at the bottom-snap threshold.
  useEffect(() => {
    if (paused || !open || !autoScroll) return;
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight });
  }, [entries, paused, open, autoScroll]);

  // Resume from pause flushes pending entries.
  useEffect(() => {
    if (paused) return;
    if (pendingRef.current.length === 0) return;
    setEntries((prev) => {
      const merged = [...prev, ...pendingRef.current];
      pendingRef.current = [];
      return merged.length > MAX_ENTRIES ? merged.slice(-MAX_ENTRIES) : merged;
    });
  }, [paused]);

  // ── Command execution ────────────────────────────────────────────────
  // Builds the CommandContext fresh per call so each command sees the
  // latest state setters (closures captured at COMMANDS-table-build time
  // would be stale if the parent re-rendered with new setters — though
  // in practice React's setters are stable, the indirection keeps the
  // command table movable to module scope without coupling).
  const executeCommand = useCallback(async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    // Echo to the log so the user has a record of what they ran.
    push({ ts: Date.now(), level: "trace", source: "console", message: `> ${trimmed}` });
    // Append to history; dedupe consecutive duplicates.
    const hist = historyRef.current;
    if (hist[hist.length - 1] !== trimmed) hist.push(trimmed);
    if (hist.length > 50) hist.splice(0, hist.length - 50);

    const firstSpace = trimmed.indexOf(" ");
    const name = (firstSpace >= 0 ? trimmed.slice(0, firstSpace) : trimmed).toLowerCase();
    const args = firstSpace >= 0 ? trimmed.slice(firstSpace + 1) : "";
    const cmd = COMMANDS.find((c) => c.name === name);
    if (!cmd) {
      push({
        ts: Date.now(), level: "error", source: "console",
        message: `Unknown command: "${name}". Type \`help\` for the list.`,
      });
      return;
    }
    try {
      await cmd.run(args, { push, setEntries, setPaused, setEnabled, setSearch });
    } catch (e) {
      push({
        ts: Date.now(), level: "error", source: "console",
        message: `Command \`${name}\` threw: ${String(e)}`,
      });
    }
  }, [push]);

  // Recompute autocomplete suggestions whenever the input changes. Reset
  // the selection cursor each time the dropdown shape changes so a fresh
  // dropdown opens on the first row instead of an out-of-range index.
  const { suggestions, insideArgs } = useMemo(() => resolveSuggestions(input), [input]);
  useEffect(() => { setSuggestionIdx(0); }, [input]);

  const acceptSuggestion = useCallback((cmd: DevCommand) => {
    setInput(cmd.name + " ");
    inputRef.current?.focus();
  }, []);

  const onPromptKey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Tab / Enter handle suggestion + execute. Up/Down navigate either
    // the dropdown (when open) or the command history (when closed).
    const dropdownOpen = !insideArgs && suggestions.length > 0;
    if (e.key === "Tab") {
      e.preventDefault();
      if (dropdownOpen && suggestions[suggestionIdx]) {
        acceptSuggestion(suggestions[suggestionIdx]);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // If the dropdown has a NARROWER suggestion than what's typed
      // (e.g. user typed "thr" and the only match is "throw"), accept
      // it and require a second Enter to execute. Once the typed text
      // is itself a complete command name, Enter executes immediately.
      if (
        dropdownOpen &&
        suggestions.length === 1 &&
        suggestions[0].name !== input.trim().toLowerCase()
      ) {
        acceptSuggestion(suggestions[0]);
        return;
      }
      void executeCommand(input);
      setInput("");
      setHistoryCursor(null);
      return;
    }
    if (e.key === "Escape") {
      // Two-stage Escape: first press clears input + dropdown; second
      // closes the DevConsole entirely (handled by the existing window
      // capture listener). Stop propagation here only when there is
      // input to clear so the second press still bubbles.
      if (input.length > 0) {
        e.stopPropagation();
        setInput("");
        setHistoryCursor(null);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (dropdownOpen) {
        setSuggestionIdx((i) => Math.min(i + 1, suggestions.length - 1));
      } else if (historyCursor != null) {
        // Walking forward through history towards "blank again".
        const next = historyCursor + 1;
        if (next >= historyRef.current.length) {
          setHistoryCursor(null);
          setInput("");
        } else {
          setHistoryCursor(next);
          setInput(historyRef.current[next]);
        }
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (dropdownOpen) {
        setSuggestionIdx((i) => Math.max(i - 1, 0));
      } else if (historyRef.current.length > 0) {
        const cursor = historyCursor == null
          ? historyRef.current.length - 1
          : Math.max(historyCursor - 1, 0);
        setHistoryCursor(cursor);
        setInput(historyRef.current[cursor]);
      }
      return;
    }
  }, [acceptSuggestion, executeCommand, historyCursor, input, insideArgs, suggestionIdx, suggestions]);

  // Focus the prompt whenever the DevConsole opens — fast triage path
  // for "F12 → type command → Enter" without a click in between.
  useEffect(() => {
    if (!open) return;
    // Defer one frame so the input element has mounted into the DOM.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Filter
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (!enabled[e.level]) return false;
      if (!q) return true;
      return (
        e.message.toLowerCase().includes(q) ||
        e.source.toLowerCase().includes(q)
      );
    });
    // Render at most MAX_RENDERED rows — older entries stay in `entries`
    // memory and become visible again as soon as newer rows are evicted
    // or the filter narrows. Keeps DOM weight bounded at the 10k buffer.
    if (filtered.length > MAX_RENDERED) {
      return filtered.slice(filtered.length - MAX_RENDERED);
    }
    return filtered;
  }, [entries, enabled, search]);
  const truncatedCount = entries.length - visible.length;

  // Bulk-export handlers — operate on the FULL entries buffer, not the
  // filtered/rendered subset, so the user always gets a complete log
  // regardless of what's currently visible.
  const flashStatus = useCallback((kind: "copied" | "saved" | "error") => {
    setExportStatus(kind);
    window.setTimeout(() => setExportStatus(null), 1400);
  }, []);

  const handleCopyLogs = useCallback(async () => {
    if (entries.length === 0) return;
    const text = buildExportText(entries);
    try {
      await navigator.clipboard.writeText(text);
      flashStatus("copied");
    } catch (err) {
      console.error("[devconsole] copy failed:", err);
      flashStatus("error");
    }
  }, [entries, flashStatus]);

  const handleDownloadLogs = useCallback(async () => {
    if (entries.length === 0) return;
    const text = buildExportText(entries);
    try {
      const path = await invoke<string | null>("save_text_with_dialog", {
        content: text,
        defaultName: defaultExportFilename(),
      });
      if (path) flashStatus("saved");
    } catch (err) {
      console.error("[devconsole] download failed:", err);
      flashStatus("error");
    }
  }, [entries, flashStatus]);

  if (!open) return null;

  return (
    <div
      className="dev-console fixed inset-x-0 bottom-0 z-[9999] h-[40vh] min-h-[280px]
                 flex flex-col font-mono"
      style={{
        background: "linear-gradient(180deg, rgba(0,0,0,0.92), rgba(0,0,0,0.96))",
        borderTop: "1px solid rgba(255,255,255,0.15)",
        boxShadow: "0 -20px 60px -10px rgba(0,0,0,0.7)",
        backdropFilter: "blur(24px)",
        WebkitBackdropFilter: "blur(24px)",
      }}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-white/10 flex-shrink-0">
        <span className="w-1.5 h-3 bg-ln-accent rounded-sm" aria-hidden />
        <h2 className="text-white/85 text-[10px] tracking-[0.22em] uppercase font-semibold">
          Aura DevConsole
        </h2>
        <span className="text-white/30 text-[10px] tracking-wider">
          {entries.length} entries
          {truncatedCount > 0 && (
            <span className="text-white/45"> · {truncatedCount} older hidden</span>
          )}
          {" · F12 toggle · Esc closes"}
        </span>

        <div className="flex-1" />

        {/* Level filters */}
        <div className="flex items-center gap-1">
          {LEVELS.map((l) => {
            const s = LEVEL_STYLE[l];
            const active = enabled[l];
            return (
              <button
                key={l}
                onClick={() => setEnabled((p) => ({ ...p, [l]: !p[l] }))}
                className={`px-2 py-0.5 rounded-sm text-[9.5px] font-semibold tracking-[0.18em] uppercase
                            border transition-colors
                            ${active
                              ? `${s.bg} ${s.fg} ${s.border}`
                              : "bg-transparent text-white/30 border-white/10 hover:bg-white/5"
                            }`}
              >
                {l}
              </button>
            );
          })}
        </div>

        <div className="w-px h-4 bg-white/10 mx-1" aria-hidden />

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="filter…"
          spellCheck={false}
          className="bg-black/40 border border-white/10 rounded-sm px-2 py-0.5
                     text-[11px] outline-none focus:border-white/25 transition-colors w-40
                     text-white/85"
        />

        <button
          onClick={() => setPaused((p) => !p)}
          title={paused ? "Resume" : "Pause"}
          className={`px-2 py-0.5 rounded-sm text-[9.5px] font-semibold tracking-[0.18em] uppercase
                      border ${paused
                        ? "bg-amber-500/15 text-amber-300 border-amber-400/30"
                        : "bg-white/5 text-white/55 border-white/10 hover:bg-white/10"
                      }`}
        >
          {paused ? "▶ resume" : "⏸ pause"}
        </button>
        <button
          onClick={handleCopyLogs}
          disabled={entries.length === 0}
          title={`Copy all ${entries.length} log entries to the clipboard`}
          className={`px-2 py-0.5 rounded-sm text-[9.5px] font-semibold tracking-[0.18em] uppercase
                      border transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                      ${exportStatus === "copied"
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30"
                        : exportStatus === "error"
                          ? "bg-red-500/15 text-red-300 border-red-400/30"
                          : "bg-white/5 text-white/55 border-white/10 hover:bg-white/10"
                      }`}
        >
          {exportStatus === "copied" ? "copied" : "copy"}
        </button>
        <button
          onClick={handleDownloadLogs}
          disabled={entries.length === 0}
          title={`Download all ${entries.length} log entries to a file (you'll be prompted for the save location)`}
          className={`px-2 py-0.5 rounded-sm text-[9.5px] font-semibold tracking-[0.18em] uppercase
                      border transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                      ${exportStatus === "saved"
                        ? "bg-emerald-500/15 text-emerald-300 border-emerald-400/30"
                        : exportStatus === "error"
                          ? "bg-red-500/15 text-red-300 border-red-400/30"
                          : "bg-white/5 text-white/55 border-white/10 hover:bg-white/10"
                      }`}
        >
          {exportStatus === "saved" ? "saved" : "download"}
        </button>
        <button
          onClick={() => setEntries([])}
          className="px-2 py-0.5 rounded-sm text-[9.5px] font-semibold tracking-[0.18em] uppercase
                     bg-white/5 text-white/55 border border-white/10 hover:bg-white/10"
        >
          clear
        </button>
        <button
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="w-6 h-6 rounded-sm text-white/55 hover:text-white hover:bg-white/10
                     flex items-center justify-center"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={tailRef}
          onCopy={handleLogCopy}
          onScroll={(e) => {
            const el = e.currentTarget;
            // 24 px hysteresis around the tail — prevents the auto-
            // scroll re-arming from flickering when a fresh log line
            // grows the scrollHeight by a couple of pixels right at
            // the boundary.
            const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
            const atBottom = distFromBottom <= 24;
            setAutoScroll((prev) => (prev === atBottom ? prev : atBottom));
          }}
          className="absolute inset-0 overflow-y-auto px-3 py-2 text-[11.5px] leading-[1.5]"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.10) transparent" }}
        >
          {visible.length === 0 ? (
            <div className="text-white/30 italic px-2 py-6 text-center">
              No log entries match the current filter.
            </div>
          ) : (
            visible.map((e) => <Row key={e.id} entry={e} />)
          )}
        </div>

        {/* Auto-scroll-paused toast — surfaces only when the user has
            scrolled away from the tail. Click jumps to the bottom AND
            re-arms auto-scroll. Inline so it floats above the log
            stream without grabbing keyboard focus. */}
        {!autoScroll && (
          <button
            type="button"
            onClick={() => {
              const el = tailRef.current;
              if (!el) return;
              el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              setAutoScroll(true);
            }}
            className="absolute bottom-3 left-1/2 -translate-x-1/2
                       px-3 py-1.5 rounded-full
                       bg-ln-accent/85 text-black text-[11px] font-semibold
                       tracking-wide shadow-[0_8px_24px_-6px_rgba(0,0,0,0.75)]
                       hover:bg-ln-accent transition-colors
                       border border-white/20"
          >
            ↓ Resume autoscroll
          </button>
        )}
      </div>

      {/* ── Command prompt ──────────────────────────────────────────────
          A REPL-style input pinned at the bottom of the DevConsole. The
          autocomplete dropdown floats ABOVE the input (via absolute
          positioning + bottom-full) so it doesn't shift the log body
          when it appears. The input takes focus on every F12-open so
          the user can type immediately. */}
      <div className="relative flex-shrink-0 border-t border-white/10">
        {/* Autocomplete dropdown — only when there's something to suggest
            and the user hasn't moved past the command name yet.
            Suppressed in production builds since the prompt input is
            also gone there. */}
        {!import.meta.env.PROD && suggestions.length > 0 && !insideArgs && (
          <div
            role="listbox"
            aria-label="Command suggestions"
            className="absolute bottom-full left-0 right-0 max-h-[40vh]
                       overflow-y-auto border-t border-white/10
                       bg-black/95 backdrop-blur-xl text-[11.5px]"
            style={{ scrollbarWidth: "thin" }}
          >
            {suggestions.map((c, i) => {
              const active = i === suggestionIdx;
              return (
                <button
                  key={c.name}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseDown={(e) => {
                    // mousedown so the click lands BEFORE the input's
                    // blur fires; using onClick would race with focus
                    // moving away and either close the dropdown or
                    // require an extra click.
                    e.preventDefault();
                    acceptSuggestion(c);
                  }}
                  className={`w-full text-left px-4 py-1.5 flex items-baseline gap-3
                              transition-colors
                              ${active
                                ? "bg-ln-accent/15"
                                : "hover:bg-white/[0.06]"}`}
                >
                  <span className={`font-mono font-semibold tracking-wide
                                    ${active ? "text-ln-accent" : "text-white/85"}`}>
                    {c.name}
                  </span>
                  <span className={`font-mono text-[10.5px]
                                    ${active ? "text-ln-accent/65" : "text-white/40"}`}>
                    {c.usage.slice(c.name.length).trim() || " "}
                  </span>
                  <span className={`flex-1 text-[10.5px] truncate
                                    ${active ? "text-white/85" : "text-white/55"}`}>
                    {c.description}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {/* Production builds ship the DevConsole as a read-only log
            viewer. The command prompt is dev-only because several
            commands deliberately trigger crashes / panics / native
            errors for telemetry verification (`throw`, `panic`,
            `dev_force_panic`, `eval`); leaving them reachable in a
            shipped binary lets curious users generate spurious Sentry
            events and break their own session for fun. Vite stamps
            `import.meta.env.PROD` at build time so this whole branch
            tree-shakes out of release bundles. */}
        {import.meta.env.PROD ? (
          <div className="flex items-center gap-2 px-4 py-2 bg-black/30">
            <span aria-hidden className="text-white/30 text-[13px] font-mono leading-none">›</span>
            <span className="flex-1 text-[11.5px] font-mono text-white/35 italic select-none">
              Read-only in release builds. Commands are available in
              development.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-2 px-4 py-2 bg-black/30">
            <span aria-hidden className="text-ln-accent text-[13px] font-mono leading-none">›</span>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => { setInput(e.target.value); setHistoryCursor(null); }}
              onKeyDown={onPromptKey}
              placeholder="type a command, e.g. `help`, `throw`, or `panic`"
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              className="flex-1 bg-transparent border-0 outline-none
                         text-[12px] font-mono text-white/90 placeholder:text-white/30"
            />
            {historyRef.current.length > 0 && (
              <span className="text-[10px] text-white/30 tabular-nums select-none">
                ↑ history ({historyRef.current.length})
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: LogEntry }) {
  const s = LEVEL_STYLE[entry.level];
  // Local-clock HH:MM:SS.mmm — matches what the user reads off the
  // OS clock. Was toISOString().slice(11, 23) which fixed the
  // display to UTC and required mental offset to correlate with
  // outside-app timestamps (logs from the cloud, OS notifications,
  // etc.). The arithmetic locale-padding is more verbose than
  // `toLocaleTimeString` but guarantees consistent HH:MM:SS.mmm
  // formatting regardless of the system locale (some locales pad
  // to e.g. "13:05:07 PM" with AM/PM).
  const d = new Date(entry.ts);
  const time =
    `${String(d.getHours()).padStart(2, "0")}:` +
    `${String(d.getMinutes()).padStart(2, "0")}:` +
    `${String(d.getSeconds()).padStart(2, "0")}.` +
    `${String(d.getMilliseconds()).padStart(3, "0")}`;

  return (
    <div data-log-row className="flex items-start gap-3 py-0.5 border-b border-white/4">
      <span className="flex-shrink-0 text-white/30 tabular-nums select-all">{time}</span>
      <span className={`flex-shrink-0 px-1.5 py-0 rounded-sm border ${s.bg} ${s.fg} ${s.border}
                        text-[9.5px] font-semibold tracking-[0.14em] uppercase`}>
        {s.tag}
      </span>
      <span className="flex-shrink-0 text-white/45 select-all">{entry.source}</span>
      <span className="flex-1 min-w-0 text-white/85 break-words whitespace-pre-wrap">
        {entry.message}
        {entry.stack && (
          <pre className="text-white/35 text-[10.5px] mt-1 overflow-x-auto">
            {entry.stack}
          </pre>
        )}
      </span>
    </div>
  );
}
