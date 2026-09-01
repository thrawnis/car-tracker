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
 * Per-account field encryption. Instantiate with a user's unwrapped data key
 * (derived once per request from the authenticated session) and use to
 * encrypt/decrypt sensitive fields before persisting/reading them.
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

// ---- Passphrase-based encryption for account export/import files ----

const EXPORT_SCRYPT_N = 16384;
const EXPORT_SALT_LENGTH = 16;

function deriveExportKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32, { N: EXPORT_SCRYPT_N, r: 8, p: 1 });
}

/** Encrypts an arbitrary JSON-serializable export payload with a user-chosen passphrase. */
export function encryptExportPayload(payload: unknown, passphrase: string): string {
  const salt = crypto.randomBytes(EXPORT_SALT_LENGTH);
  const key = deriveExportKey(passphrase, salt);
  const body = encryptWithKey(JSON.stringify(payload), key);
  const envelope = { v: 1, salt: salt.toString("base64"), body };
  return JSON.stringify(envelope);
}

export function decryptExportPayload<T = unknown>(file: string, passphrase: string): T {
  const envelope = JSON.parse(file) as { v: number; salt: string; body: string };
  if (envelope.v !== 1) throw new Error("Unsupported export file version");
  const salt = Buffer.from(envelope.salt, "base64");
  const key = deriveExportKey(passphrase, salt);
  const json = decryptWithKey(envelope.body, key);
  return JSON.parse(json) as T;
}
