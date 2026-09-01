import { describe, it, expect } from "vitest";
import {
  generateDataKey,
  wrapDataKey,
  unwrapDataKey,
  AccountCipher,
  encryptExportPayload,
  decryptExportPayload,
} from "./encryption.js";

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

describe("export/import passphrase encryption", () => {
  it("round-trips an arbitrary payload with the correct passphrase", () => {
    const payload = { vehicles: [{ make: "Honda", model: "Civic" }] };
    const file = encryptExportPayload(payload, "correct horse battery staple");
    expect(decryptExportPayload(file, "correct horse battery staple")).toEqual(payload);
  });

  it("fails to decrypt with the wrong passphrase", () => {
    const file = encryptExportPayload({ a: 1 }, "right passphrase");
    expect(() => decryptExportPayload(file, "wrong passphrase")).toThrow();
  });

  it("rejects a file with an unsupported version", () => {
    const file = encryptExportPayload({ a: 1 }, "pw");
    const tampered = JSON.stringify({ ...JSON.parse(file), v: 99 });
    expect(() => decryptExportPayload(tampered, "pw")).toThrow(/version/i);
  });
});
