// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unit tests for the watch-together relay's per-install secret verification
// (the cid-binding capability). Run with `npm test` (node --test) from
// watch-relay/. No deps — uses the built-in test runner + WebCrypto (global on
// Node 18+ and Cloudflare Workers, the same runtime the relay targets).

import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256Hex, authorizeCid } from "../src/auth.js";

test("sha256Hex returns the known, stable hex digest", async () => {
  // Canonical SHA-256("hello").
  const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
  assert.equal(await sha256Hex("hello"), expected);
  assert.equal(await sha256Hex("hello"), expected); // deterministic
});

test("sha256Hex differs for different inputs", async () => {
  assert.notEqual(await sha256Hex("alpha"), await sha256Hex("beta"));
});

test("TOFU: first claim WITH a secret is granted and binds its hash", async () => {
  const r = await authorizeCid(null, "s3cr3t-token");
  assert.equal(r.grant, true);
  assert.equal(r.hash, await sha256Hex("s3cr3t-token"));
});

test("TOFU: first claim with NO secret (legacy client) is granted, nothing bound", async () => {
  const r = await authorizeCid(null, "");
  assert.equal(r.grant, true);
  assert.equal(r.hash, null);
});

test("reconnect: bound cid with the CORRECT secret is granted (reclaim, hash unchanged)", async () => {
  const stored = await sha256Hex("s3cr3t-token");
  const r = await authorizeCid(stored, "s3cr3t-token");
  assert.equal(r.grant, true);
  assert.equal(r.hash, stored);
});

test("impostor: bound cid with the WRONG secret is denied", async () => {
  const stored = await sha256Hex("s3cr3t-token");
  const r = await authorizeCid(stored, "not-the-secret");
  assert.equal(r.grant, false);
});

test("impostor: bound cid with NO secret presented is denied (cannot prove ownership)", async () => {
  const stored = await sha256Hex("s3cr3t-token");
  const r = await authorizeCid(stored, "");
  assert.equal(r.grant, false);
});

test("null / undefined secret is treated the same as empty", async () => {
  const stored = await sha256Hex("s3cr3t-token");
  assert.equal((await authorizeCid(stored, null)).grant, false);
  assert.equal((await authorizeCid(stored, undefined)).grant, false);
  // ...but TOFU with no secret still grants (legacy passthrough).
  const tofu = await authorizeCid(null, null);
  assert.equal(tofu.grant, true);
  assert.equal(tofu.hash, null);
});

// Mirrors exactly how worker.js composes authorizeCid against meta.secrets, so a
// future refactor of the relay's connect flow can't silently break the contract.
test("room scenario: bind on first join, reclaim on reconnect, reject impostor", async () => {
  const secrets = {}; // the relay's meta.secrets map
  const cid = "abc12345";
  const ownerSecret = "owner-install-secret";

  // First join: trust-on-first-use binds the cid to the owner's secret.
  let r = await authorizeCid(secrets[cid] ?? null, ownerSecret);
  assert.equal(r.grant, true);
  if (r.grant && r.hash) secrets[cid] = r.hash;
  assert.ok(secrets[cid], "cid should be bound after first join");

  // Owner reconnects with the same secret: reclaims its identity.
  r = await authorizeCid(secrets[cid] ?? null, ownerSecret);
  assert.equal(r.grant, true);

  // Attacker who knows the room code tries the owner's cid with a wrong secret.
  assert.equal((await authorizeCid(secrets[cid] ?? null, "attacker-secret")).grant, false);
  // ...or with no secret at all.
  assert.equal((await authorizeCid(secrets[cid] ?? null, "")).grant, false);

  // The owner's binding is intact after the failed attempts.
  assert.equal(secrets[cid], await sha256Hex(ownerSecret));
});
