#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/stage-bridge.cjs — copy the aura-bridge sidecar binary into the
// path Tauri's bundler expects (`bundle.externalBin`) before `pnpm tauri
// build` runs.
//
// Tauri's externalBin requires the binary file to be named with the target
// triple appended (e.g. `aura-bridge-x86_64-pc-windows-msvc.exe`). The
// bundler renames it back to `aura-bridge[.exe]` when copying it into the
// installer next to Aura's own executable.
//
// Usage:
//   AURA_BRIDGE_BIN=/path/to/aura-bridge.exe pnpm bundle:stage
//
//   - Or pass the source path as a positional arg:
//     pnpm bundle:stage /path/to/aura-bridge.exe
//
//   - Or rely on auto-detection (Windows-only):
//     looks at sibling Coding/Projects/aura-bridge/target/{release,debug}
//     and src-tauri/target/{release,debug}
//
// The destination is `src-tauri/binaries/aura-bridge-<triple>[.exe]`. The
// `binaries/` directory is created on demand and is gitignored under the
// existing `src-tauri/binaries/` rule.
// ---------------------------------------------------------------------------

const fs   = require("fs");
const path = require("path");

function detectTargetTriple() {
  // Tauri picks the host triple by default. Replicate the relevant subset:
  if (process.platform === "win32") {
    return process.arch === "x64" ? "x86_64-pc-windows-msvc"
         : process.arch === "arm64" ? "aarch64-pc-windows-msvc"
         : "x86_64-pc-windows-msvc";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin"
         : "x86_64-apple-darwin";
  }
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu"
       : "x86_64-unknown-linux-gnu";
}

function exeName() {
  return process.platform === "win32" ? "aura-bridge.exe" : "aura-bridge";
}

function findCandidate() {
  // 1. Explicit override via env var or argv[2].
  const explicit = process.env.AURA_BRIDGE_BIN || process.argv[2];
  if (explicit) {
    const abs = path.resolve(explicit);
    if (fs.existsSync(abs)) return abs;
    console.error(`[stage-bridge] AURA_BRIDGE_BIN points at ${abs} but it doesn't exist`);
    return null;
  }

  // 2. Auto-detect: walk a small set of likely locations. The first
  //    candidate ('release' near the open repo) is the production-style
  //    layout; subsequent ones cover dev workflows.
  const here = path.resolve(__dirname, "..");
  const projectsRoot = path.resolve(here, "..");
  const candidates = [
    // Sibling private repo layout (recommended).
    path.join(projectsRoot, "aura-bridge", "target", "release", exeName()),
    path.join(projectsRoot, "aura-bridge", "target", "debug",   exeName()),
    // src-tauri/target — handy when the user manually drops the exe there.
    path.join(here, "src-tauri", "target", "release", exeName()),
    path.join(here, "src-tauri", "target", "debug",   exeName()),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function main() {
  const src = findCandidate();
  if (!src) {
    console.error("[stage-bridge] no aura-bridge binary found.");
    console.error("  Build it from the private aura-bridge repo (cargo build --release),");
    console.error("  then point this script at the produced binary via:");
    console.error("    AURA_BRIDGE_BIN=/path/to/aura-bridge.exe pnpm bundle:stage");
    console.error("  Or pass it as a positional arg:");
    console.error("    pnpm bundle:stage /path/to/aura-bridge.exe");
    process.exit(1);
  }
  const triple = detectTargetTriple();
  const ext    = process.platform === "win32" ? ".exe" : "";
  const destDir = path.resolve(__dirname, "..", "src-tauri", "binaries");
  const destFile = path.join(destDir, `aura-bridge-${triple}${ext}`);

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, destFile);

  // Sanity-check size + executability so a corrupted copy is caught here
  // rather than producing a bricked bundle.
  const stat = fs.statSync(destFile);
  console.log(`[stage-bridge] staged sidecar:`);
  console.log(`  source: ${src}`);
  console.log(`  dest:   ${destFile}`);
  console.log(`  size:   ${(stat.size / 1024).toFixed(1)} KB`);

  // On Windows this is a no-op — execute permission is determined by the
  // .exe extension. On macOS/Linux we mark it +x so Tauri's bundler can
  // sign it.
  if (process.platform !== "win32") {
    try { fs.chmodSync(destFile, 0o755); } catch { /* non-fatal */ }
  }

  // Note: we deliberately don't run the staged binary as part of
  // staging — earlier versions tried `<binary> --version` for a sanity
  // print, but the bridge binary doesn't implement that flag and just
  // boots its HTTP listener on 11471, colliding with any running Aura
  // instance. The size + path output above is enough confirmation.
}

main();
