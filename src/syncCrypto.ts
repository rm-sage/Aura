// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// syncCrypto.ts ─────────────────────────────────────────────────────────────
//
// Client-side AES-GCM helpers for the sync blobs that carry third-party
// API keys (OpenSubtitles). Those credentials are categorically
// more sensitive than the rest of synced state — a proxy compromise
// would leak per-user quota tokens for external services. The other
// namespaces are deliberately stored in clear (the proxy already gates
// access by a scope hash the user keeps secret), but API keys get an
// extra encrypt-at-rest layer so the proxy SQLite + its backups can be
// compromised without the keys themselves being readable.
//
// ## Key derivation
//
// We derive a 256-bit AES key via HKDF-SHA256 from the Stremio user
// `_id` (the same stable identifier the post-0.6.9 scope hash is built
// on). user_id was picked over auth_key specifically because it's
// device-stable — Stremio rotates the auth_key per login, so an
// auth_key-derived key would be unable to decrypt blobs encrypted on
// another device. Devices that haven't yet backfilled user_id can't
// encrypt or decrypt and gracefully skip the round-trip.
//
// The HKDF salt/info pair is a fixed app-specific constant ("aura/api-
// keys/v1") so future schema bumps can rotate the derivation without
// breaking decryption of in-flight blobs.
//
// ## Wire format
//
// Encrypted blobs serialise as:
//
//   { v: 1, iv: <base64 12 bytes>, ct: <base64 ciphertext+tag> }
//
// `v` is a schema version. `iv` is a fresh random nonce per encryption
// (CRITICAL: AES-GCM with a reused nonce trivially breaks). `ct` is
// the AES-GCM ciphertext with the 16-byte authentication tag appended
// (WebCrypto's convention — the tag is at the tail).
//
// ## What's NOT encrypted here
//
// The auth_key itself stays in the OS keyring (DPAPI on Windows). It
// never enters this module. The proxy doesn't see it either; what it
// gets is sha256(user_id) as a scope hash.

/** Wire format for an encrypted API-keys blob. */
export interface EncryptedBlob {
  v: 1;
  iv: string; // base64
  ct: string; // base64
}

/** Lightweight type guard for incoming server blobs. */
export function isEncryptedBlob(x: unknown): x is EncryptedBlob {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return o.v === 1 && typeof o.iv === "string" && typeof o.ct === "string";
}

// ── base64 helpers ────────────────────────────────────────────────────────
// Browser-friendly Uint8Array ↔ base64. `btoa`/`atob` only work on
// binary-string-shaped input, so we round-trip through that.

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Key derivation ────────────────────────────────────────────────────────

const HKDF_SALT = new TextEncoder().encode("aura/api-keys/v1/salt");
const HKDF_INFO = new TextEncoder().encode("aura/api-keys/v1/aes-256-gcm");

async function deriveKey(userId: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(userId),
    "HKDF",
    /* extractable */ false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: HKDF_INFO,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

// ── Encrypt / decrypt ─────────────────────────────────────────────────────

/** Encrypt an arbitrary JSON-serialisable plaintext into an
 *  `EncryptedBlob` suitable for inclusion in a sync payload. Caller
 *  is responsible for JSON.stringify if the plaintext is a complex
 *  shape. Throws when WebCrypto refuses (e.g. user_id is empty). */
export async function encryptForCloud(
  plaintext: string,
  userId: string,
): Promise<EncryptedBlob> {
  if (!userId) throw new Error("encryptForCloud: empty userId");
  const key = await deriveKey(userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return {
    v: 1,
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ctBuf)),
  };
}

/** Decrypt an `EncryptedBlob` back to plaintext. Throws on tampered
 *  ciphertext (AES-GCM auth tag mismatch) or wrong key (user_id
 *  derived from a different account). The caller's caller should
 *  catch + log — a decrypt failure usually means "this blob was
 *  written by a different Stremio account" or "the blob predates the
 *  encryption schema", not "the system is broken". */
export async function decryptFromCloud(
  blob: EncryptedBlob,
  userId: string,
): Promise<string> {
  if (!userId) throw new Error("decryptFromCloud: empty userId");
  if (blob.v !== 1) throw new Error(`decryptFromCloud: unsupported schema version ${blob.v}`);
  const key = await deriveKey(userId);
  const iv = fromBase64(blob.iv);
  const ct = fromBase64(blob.ct);
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    ct,
  );
  return new TextDecoder().decode(ptBuf);
}
