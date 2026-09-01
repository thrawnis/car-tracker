import { authenticator } from "otplib";
import QRCode from "qrcode";
import crypto from "node:crypto";

authenticator.options = { window: 1 };

export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

export async function generateTotpQrCode(email: string, secret: string): Promise<string> {
  const otpauth = authenticator.keyuri(email, "Car Tracker", secret);
  return QRCode.toDataURL(otpauth);
}

export function verifyTotpToken(secret: string, token: string): boolean {
  try {
    return authenticator.check(token, secret);
  } catch {
    return false;
  }
}

/** Generates N single-use backup codes (plaintext, to show once) and their hashes (to store). */
export function generateBackupCodes(count = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    plain.push(code);
    hashed.push(crypto.createHash("sha256").update(code).digest("hex"));
  }
  return { plain, hashed };
}

export function hashBackupCode(code: string): string {
  return crypto.createHash("sha256").update(code.trim().toLowerCase()).digest("hex");
}
