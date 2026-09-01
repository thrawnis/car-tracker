import crypto from "node:crypto";

export const EMAIL_VERIFICATION_TTL_MINUTES = 15;

/** Generates a 6-digit numeric code (plaintext, to email) and its hash (to store). */
export function generateVerificationCode(): { code: string; hash: string; expiresAt: Date } {
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
  return {
    code,
    hash: hashVerificationCode(code),
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MINUTES * 60 * 1000),
  };
}

export function hashVerificationCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim()).digest("hex");
}
