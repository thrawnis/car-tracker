/**
 * Zero-knowledge vault crypto. Everything in this file runs in the browser
 * (Web Crypto API). The plaintext data key produced here, and every plaintext
 * field it decrypts, never leaves this module except into React state held in
 * memory for the current tab - it is never sent to the server, and the
 * server has no key that could reconstruct it.
 *
 * Envelope format: base64(12-byte IV || AES-GCM ciphertext-with-appended-tag).
 * This format is internal to the client (the server only ever stores/returns
 * these strings verbatim), so it doesn't need to match any server-side format.
 */

const PBKDF2_ITERATIONS = 600_000;
const IV_LENGTH = 12;
const AES_KEY_LENGTH = 256;

// TS 5.7+ made Uint8Array generic over its backing buffer type, which the DOM
// lib's BufferSource unions don't uniformly accept back (see
// microsoft/TypeScript#59417). All the arrays here are plain, non-shared
// buffers; this is a type-level cast only, not a runtime copy.
function buf(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function generateSaltB64(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(16)));
}

/** Derives an AES-GCM key from a password + salt. Never leaves the browser. */
export async function deriveKeyFromPassword(password: string, saltB64: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: buf(fromBase64(saltB64)), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Generates a fresh, extractable (so it can be wrapped) AES-256-GCM data key. */
export function generateDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: AES_KEY_LENGTH }, true, ["encrypt", "decrypt"]);
}

async function aesEncrypt(plaintext: Uint8Array, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(plaintext));
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(packed);
}

async function aesDecrypt(packedB64: string, key: CryptoKey): Promise<Uint8Array> {
  const packed = fromBase64(packedB64);
  const iv = packed.slice(0, IV_LENGTH);
  const ciphertext = packed.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(ciphertext));
  return new Uint8Array(plaintext);
}

/** Wraps (encrypts) `keyToWrap` with `wrappingKey`, for storage/transport. */
export async function wrapKey(keyToWrap: CryptoKey, wrappingKey: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", keyToWrap);
  return aesEncrypt(new Uint8Array(raw), wrappingKey);
}

/** Unwraps a key produced by wrapKey(). Throws if `wrappingKey` is wrong (auth tag fails). */
export async function unwrapKey(wrappedB64: string, wrappingKey: CryptoKey): Promise<CryptoKey> {
  const raw = await aesDecrypt(wrappedB64, wrappingKey);
  return crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
}

/** True if two CryptoKeys wrap the same raw key material (used to detect a same-account backup). */
export async function keysAreEqual(a: CryptoKey, b: CryptoKey): Promise<boolean> {
  const [rawA, rawB] = await Promise.all([crypto.subtle.exportKey("raw", a), crypto.subtle.exportKey("raw", b)]);
  const bytesA = new Uint8Array(rawA);
  const bytesB = new Uint8Array(rawB);
  if (bytesA.length !== bytesB.length) return false;
  return bytesA.every((byte, i) => byte === bytesB[i]);
}

export function encryptField(plaintext: string, dataKey: CryptoKey): Promise<string> {
  return aesEncrypt(new TextEncoder().encode(plaintext), dataKey);
}

export async function decryptField(packedB64: string, dataKey: CryptoKey): Promise<string> {
  const bytes = await aesDecrypt(packedB64, dataKey);
  return new TextDecoder().decode(bytes);
}

export async function encryptOptionalField(
  plaintext: string | null | undefined,
  dataKey: CryptoKey,
): Promise<string | null> {
  if (!plaintext) return null;
  return encryptField(plaintext, dataKey);
}

export async function decryptOptionalField(
  packedB64: string | null | undefined,
  dataKey: CryptoKey,
): Promise<string | null> {
  if (!packedB64) return null;
  try {
    return await decryptField(packedB64, dataKey);
  } catch {
    return null;
  }
}

export async function encryptInt(value: number | null | undefined, dataKey: CryptoKey): Promise<string | null> {
  if (value === null || value === undefined) return null;
  return encryptField(String(value), dataKey);
}

export async function decryptInt(packedB64: string | null | undefined, dataKey: CryptoKey): Promise<number | null> {
  const str = await decryptOptionalField(packedB64, dataKey);
  if (str === null) return null;
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

// ---- Recovery key ----
//
// A single 256-bit random value shown to the user once at signup. Two
// independent values are derived from it via HKDF with different `info`
// labels: one never leaves the browser (unwraps the vault key), the other is
// sent to the server as a proof-of-possession for the account-recovery flow.
// Because HKDF outputs for different `info` labels are computationally
// independent, the server learning the verifier reveals nothing about the
// unwrap key.

const RECOVERY_KEY_BYTES = 32;
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(encoded: string): Uint8Array {
  const clean = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

function formatRecoveryKey(encoded: string): string {
  return encoded.match(/.{1,5}/g)!.join("-");
}

export function generateRecoveryKey(): { raw: Uint8Array; display: string } {
  const raw = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  return { raw, display: formatRecoveryKey(base32Encode(raw)) };
}

export function parseRecoveryKey(display: string): Uint8Array {
  return base32Decode(display);
}

async function hkdf(rawKeyMaterial: Uint8Array, info: string, byteLength: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey("raw", buf(rawKeyMaterial), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buf(new Uint8Array(0)),
      info: buf(new TextEncoder().encode(info)),
    },
    keyMaterial,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

export async function deriveRecoveryUnwrapKey(recoveryRaw: Uint8Array): Promise<CryptoKey> {
  const keyBytes = await hkdf(recoveryRaw, "car-tracker:vault-unwrap:v1", AES_KEY_LENGTH / 8);
  return crypto.subtle.importKey("raw", buf(keyBytes), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function deriveRecoveryVerifier(recoveryRaw: Uint8Array): Promise<string> {
  const bytes = await hkdf(recoveryRaw, "car-tracker:recovery-verifier:v1", 32);
  return toBase64(bytes);
}
