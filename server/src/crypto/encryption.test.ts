import { describe, it, expect } from "vitest";
import { generateDataKey, wrapDataKey, unwrapDataKey, AccountCipher, safeCompareB64 } from "./encryption.js";

describe("data key wrapping", () => {
  it("round-trips a data key through wrap/unwrap", () => {
    const key = generateDataKey();
    const wrapped = wrapDataKey(key);
    expect(wrapped).not.toEqual(key.toString("base64"));
    expect(unwrapDataKey(wrapped)).toEqual(key);
  });

  it("produces different ciphertext each time (random IV) even for the same key", () => {
    const key = generateDataKey();
    expect(wrapDataKey(key)).not.toEqual(wrapDataKey(key));
  });
});

describe("AccountCipher", () => {
  const cipher = new AccountCipher(generateDataKey());

  it("round-trips plaintext strings", () => {
    const encrypted = cipher.encrypt("1HGCM82633A004352");
    expect(encrypted).not.toBeNull();
    expect(encrypted).not.toContain("1HGCM82633A004352");
    expect(cipher.decrypt(encrypted)).toBe("1HGCM82633A004352");
  });

  it("treats null, undefined, and empty string as no value", () => {
    expect(cipher.encrypt(null)).toBeNull();
    expect(cipher.encrypt(undefined)).toBeNull();
    expect(cipher.encrypt("")).toBeNull();
    expect(cipher.decrypt(null)).toBeNull();
    expect(cipher.decrypt(undefined)).toBeNull();
  });

  it("round-trips integers via encryptInt/decryptInt", () => {
    const encrypted = cipher.encryptInt(4500);
    expect(cipher.decryptInt(encrypted)).toBe(4500);
    expect(cipher.encryptInt(null)).toBeNull();
    expect(cipher.decryptInt(null)).toBeNull();
  });

  it("cannot be decrypted with a different account's key", () => {
    const otherCipher = new AccountCipher(generateDataKey());
    const encrypted = cipher.encrypt("secret notes");
    expect(otherCipher.decrypt(encrypted)).toBeNull();
  });

  it("returns null instead of throwing on corrupted ciphertext", () => {
    const encrypted = cipher.encrypt("some value")!;
    const tampered = encrypted.slice(0, -4) + "abcd";
    expect(cipher.decrypt(tampered)).toBeNull();
  });
});

describe("safeCompareB64", () => {
  it("returns true for identical base64 values", () => {
    const value = Buffer.from("some verifier bytes").toString("base64");
    expect(safeCompareB64(value, value)).toBe(true);
  });

  it("returns false for different values, including different lengths", () => {
    const a = Buffer.from("verifier-a").toString("base64");
    const b = Buffer.from("verifier-b").toString("base64");
    const shorter = Buffer.from("short").toString("base64");
    expect(safeCompareB64(a, b)).toBe(false);
    expect(safeCompareB64(a, shorter)).toBe(false);
  });
});
