import crypto from "node:crypto";
import { env } from "../env.js";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;

function masterKey(): Buffer {
  return Buffer.from(env.MASTER_ENCRYPTION_KEY, "base64");
}

/** Encrypts `plaintext` with `key`, packing iv + authTag + ciphertext into one base64 string. */
function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

function decryptWithKey(packed: string, key: Buffer): string {
  const buf = Buffer.from(packed, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = buf.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** Generates a fresh random 256-bit data key for a new account. */
export function generateDataKey(): Buffer {
  return crypto.randomBytes(32);
}

/** Wraps (encrypts) an account's data key with the server master key, for storage. */
export function wrapDataKey(dataKey: Buffer): string {
  return encryptWithKey(dataKey.toString("base64"), masterKey());
}

/** Unwraps a stored, wrapped data key back into raw bytes using the server master key. */
export function unwrapDataKey(wrapped: string): Buffer {
  return Buffer.from(decryptWithKey(wrapped, masterKey()), "base64");
}

/**
 * Encrypts/decrypts a single value with an unwrapped key. The only remaining
 * server-side use is the TOTP secret (see totpKeyWrapped on User): an auth
 * credential the server must be able to verify pre-session, not user data.
 * All vehicle/maintenance/fuel field encryption now happens client-side with
 * a key the server never has - see client/src/crypto/vault.ts.
 */
export class AccountCipher {
  constructor(private readonly dataKey: Buffer) {}

  encrypt(plaintext: string | null | undefined): string | null {
    if (plaintext === null || plaintext === undefined || plaintext === "") return null;
    return encryptWithKey(plaintext, this.dataKey);
  }

  decrypt(packed: string | null | undefined): string | null {
    if (!packed) return null;
    try {
      return decryptWithKey(packed, this.dataKey);
    } catch {
      return null;
    }
  }

  encryptInt(value: number | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    return this.encrypt(String(value));
  }

  decryptInt(packed: string | null | undefined): number | null {
    const str = this.decrypt(packed);
    if (str === null) return null;
    const n = Number(str);
    return Number.isFinite(n) ? n : null;
  }
}

/**
 * Constant-time equality check for the recovery-verifier proof submitted during
 * account recovery. Both inputs are base64-encoded HKDF outputs (see
 * client/src/crypto/vault.ts deriveRecoveryVerifier) - never the recovery key
 * or anything that could be used to derive the vault-unwrap key.
 */
export function safeCompareB64(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "base64");
  const bufB = Buffer.from(b, "base64");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
