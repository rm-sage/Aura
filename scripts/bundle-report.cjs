#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scripts/bundle-report.cjs — minimal post-build bundle inspector.
//
// Walks dist/assets/, prints each file's size + a running total, and
// flags anything over a soft warning threshold. Useful before a release
// to spot bundle creep without pulling in a full visualizer dep.
//
// Usage: pnpm build:analyze
// ---------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "../dist/assets");
const SOFT_LIMIT = 600 * 1024; // matches vite.config.ts chunkSizeWarningLimit

function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function colourise(name, size) {
  if (size > SOFT_LIMIT) return `\x1b[31m${name}\x1b[0m`; // red
  if (size > SOFT_LIMIT * 0.7) return `\x1b[33m${name}\x1b[0m`; // yellow
  return name;
}

if (!fs.existsSync(DIST)) {
  console.error(`[bundle-report] no dist/assets/ at ${DIST} — run 'pnpm build' first`);
  process.exit(1);
}

const files = fs.readdirSync(DIST).map((f) => {
  const full = path.join(DIST, f);
  const stat = fs.statSync(full);
  return { name: f, size: stat.size };
}).sort((a, b) => b.size - a.size);

console.log("\n[bundle-report] dist/assets contents:");
console.log("-".repeat(72));
let total = 0;
let cssTotal = 0;
let jsTotal = 0;
let otherTotal = 0;
for (const { name, size } of files) {
  console.log(`  ${colourise(name.padEnd(48), size)}  ${fmt(size).padStart(10)}`);
  total += size;
  if (name.endsWith(".js"))      jsTotal += size;
  else if (name.endsWith(".css")) cssTotal += size;
  else                            otherTotal += size;
}
console.log("-".repeat(72));
console.log(`  ${"JS".padEnd(48)}  ${fmt(jsTotal).padStart(10)}`);
console.log(`  ${"CSS".padEnd(48)}  ${fmt(cssTotal).padStart(10)}`);
console.log(`  ${"Other".padEnd(48)}  ${fmt(otherTotal).padStart(10)}`);
console.log("-".repeat(72));
console.log(`  ${"TOTAL".padEnd(48)}  ${fmt(total).padStart(10)}`);
console.log("");
console.log(`Soft per-file ceiling: ${fmt(SOFT_LIMIT)} (yellow ≥ ${fmt(SOFT_LIMIT * 0.7)})`);
console.log("");
