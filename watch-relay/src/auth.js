// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-install secret verification for watch-together rooms — a seamless,
// password-free "trust on first use" (TOFU) bearer capability that binds a cid
// to the install that owns it, so a peer can't connect claiming someone else's
// cid (impersonation / crown-theft).
//
// The client generates a high-entropy secret once per install (stored locally,
// never shown to the user) and sends it alongside its cid. The relay records a
// HASH of the secret the first time it sees a cid; later connects with that cid
// must present the matching secret or they get a fresh random identity instead.
//
// Isomorphic: uses globalThis.crypto.subtle, present in BOTH Cloudflare Workers
// (the relay's runtime) and Node 18+ (the unit-test runtime). No imports — safe
// to bundle into the Worker, and the same code the tests exercise.

/** Lowercase hex SHA-256 of a UTF-8 string. */
export async function sha256Hex(s) {
  const data = new TextEncoder().encode(String(s));
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decide whether a connecting client may claim its cid, given the room's stored
 * secret hash for that cid (null if never bound) and the secret it presented.
 *
 *   - never bound (storedHash falsy):
 *       secret present -> grant + bind   (hash = H(secret))
 *       secret absent  -> grant, nothing to bind (legacy client; hash = null)
 *   - bound (storedHash set):
 *       secret matches the stored hash -> grant (reclaim; hash unchanged)
 *       wrong or absent secret         -> deny (caller assigns a fresh random id)
 *
 * @param {string|null|undefined} storedHash  prior H(secret) for this cid, or null
 * @param {string|null|undefined} presentedSecret  the secret the client sent
 * @returns {Promise<{ grant: boolean, hash: string|null }>}
 */
export async function authorizeCid(storedHash, presentedSecret) {
  const secret = typeof presentedSecret === "string" ? presentedSecret : "";
  if (!storedHash) {
    return secret ? { grant: true, hash: await sha256Hex(secret) } : { grant: true, hash: null };
  }
  if (secret && (await sha256Hex(secret)) === storedHash) {
    return { grant: true, hash: storedHash };
  }
  return { grant: false, hash: null };
}
