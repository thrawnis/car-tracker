import { describe, it, expect } from "vitest";
import { authenticator } from "otplib";
import {
  generateTotpSecret,
  generateTotpQrCode,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCode,
} from "./totp.js";

describe("TOTP secrets and verification", () => {
  it("generates a secret that produces verifiable codes", () => {
    const secret = generateTotpSecret();
    const code = authenticator.generate(secret);
    expect(verifyTotpToken(secret, code)).toBe(true);
  });

  it("rejects an incorrect code", () => {
    const secret = generateTotpSecret();
    const validCode = authenticator.generate(secret);
    const wrongCode = validCode === "000000" ? "111111" : "000000";
    expect(verifyTotpToken(secret, wrongCode)).toBe(false);
  });

  it("rejects a code generated from a different secret", () => {
    const secretA = generateTotpSecret();
    const secretB = generateTotpSecret();
    const codeFromB = authenticator.generate(secretB);
    expect(verifyTotpToken(secretA, codeFromB)).toBe(false);
  });

  it("does not throw on garbage input", () => {
    expect(verifyTotpToken("not-a-real-secret!!", "abcdef")).toBe(false);
  });

  it("produces a scannable QR code data URL", async () => {
    const secret = generateTotpSecret();
    const qr = await generateTotpQrCode("user@example.com", secret);
    expect(qr).toMatch(/^data:image\/png;base64,/);
  });
});

describe("backup codes", () => {
  it("generates the requested number of unique codes with matching hashes", () => {
    const { plain, hashed } = generateBackupCodes(10);
    expect(plain).toHaveLength(10);
    expect(new Set(plain).size).toBe(10);
    plain.forEach((code, i) => {
      expect(hashBackupCode(code)).toBe(hashed[i]);
    });
  });

  it("hashes are case- and whitespace-insensitive to match user input", () => {
    const { plain, hashed } = generateBackupCodes(1);
    const code = plain[0]!;
    expect(hashBackupCode(` ${code.toUpperCase()} `)).toBe(hashed[0]);
  });
});
