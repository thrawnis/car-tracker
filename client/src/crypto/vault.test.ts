import { describe, it, expect } from "vitest";
import {
  generateSaltB64,
  deriveKeyFromPassword,
  generateDataKey,
  wrapKey,
  unwrapKey,
  keysAreEqual,
  encryptField,
  decryptField,
  encryptOptionalField,
  decryptOptionalField,
  encryptInt,
  decryptInt,
  generateRecoveryKey,
  parseRecoveryKey,
  deriveRecoveryUnwrapKey,
  deriveRecoveryVerifier,
} from "./vault";

describe("password-derived key wrapping", () => {
  it("wraps and unwraps a data key with the correct password", async () => {
    const salt = generateSaltB64();
    const wrappingKey = await deriveKeyFromPassword("correct horse battery staple", salt);
    const dataKey = await generateDataKey();

    const wrapped = await wrapKey(dataKey, wrappingKey);
    const unwrapped = await unwrapKey(wrapped, wrappingKey);

    expect(await keysAreEqual(dataKey, unwrapped)).toBe(true);
  });

  it("fails to unwrap with the wrong password", async () => {
    const salt = generateSaltB64();
    const wrappingKey = await deriveKeyFromPassword("right password", salt);
    const wrongKey = await deriveKeyFromPassword("wrong password", salt);
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(dataKey, wrappingKey);

    await expect(unwrapKey(wrapped, wrongKey)).rejects.toThrow();
  });

  it("fails to unwrap with the right password but wrong salt", async () => {
    const wrappingKey = await deriveKeyFromPassword("a password", generateSaltB64());
    const otherKey = await deriveKeyFromPassword("a password", generateSaltB64());
    const dataKey = await generateDataKey();
    const wrapped = await wrapKey(dataKey, wrappingKey);

    await expect(unwrapKey(wrapped, otherKey)).rejects.toThrow();
  });

  it("produces different wrapped output each time (random IV)", async () => {
    const wrappingKey = await deriveKeyFromPassword("password", generateSaltB64());
    const dataKey = await generateDataKey();
    expect(await wrapKey(dataKey, wrappingKey)).not.toEqual(await wrapKey(dataKey, wrappingKey));
  });
});

describe("field encryption", () => {
  it("round-trips plaintext strings", async () => {
    const dataKey = await generateDataKey();
    const encrypted = await encryptField("1HGCM82633A004352", dataKey);
    expect(encrypted).not.toContain("1HGCM82633A004352");
    expect(await decryptField(encrypted, dataKey)).toBe("1HGCM82633A004352");
  });

  it("cannot be decrypted with a different data key", async () => {
    const dataKey = await generateDataKey();
    const otherKey = await generateDataKey();
    const encrypted = await encryptField("secret notes", dataKey);
    await expect(decryptField(encrypted, otherKey)).rejects.toThrow();
  });

  it("optional-field helpers treat null/undefined/empty as no value", async () => {
    const dataKey = await generateDataKey();
    expect(await encryptOptionalField(null, dataKey)).toBeNull();
    expect(await encryptOptionalField(undefined, dataKey)).toBeNull();
    expect(await encryptOptionalField("", dataKey)).toBeNull();
    expect(await decryptOptionalField(null, dataKey)).toBeNull();
    expect(await decryptOptionalField(undefined, dataKey)).toBeNull();
  });

  it("decryptOptionalField returns null instead of throwing on corrupted ciphertext", async () => {
    const dataKey = await generateDataKey();
    const encrypted = (await encryptOptionalField("some value", dataKey))!;
    const tampered = encrypted.slice(0, -4) + "abcd";
    expect(await decryptOptionalField(tampered, dataKey)).toBeNull();
  });

  it("round-trips integers via encryptInt/decryptInt", async () => {
    const dataKey = await generateDataKey();
    const encrypted = await encryptInt(4500, dataKey);
    expect(await decryptInt(encrypted, dataKey)).toBe(4500);
    expect(await encryptInt(null, dataKey)).toBeNull();
    expect(await decryptInt(null, dataKey)).toBeNull();
  });
});

describe("recovery key", () => {
  it("round-trips through display formatting", () => {
    const { raw, display } = generateRecoveryKey();
    // Groups of 5 chars, dash-separated; the final group may be shorter (256 bits
    // doesn't divide evenly into 5-bit base32 symbols).
    expect(display).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5})*(-[A-Z2-7]{1,4})?$/);
    expect(parseRecoveryKey(display)).toEqual(raw);
  });

  it("is tolerant of case and stray whitespace when parsed back", () => {
    const { raw, display } = generateRecoveryKey();
    const messy = ` ${display.toLowerCase().replace(/-/g, " ")} `;
    expect(parseRecoveryKey(messy)).toEqual(raw);
  });

  it("derives independent unwrap-key and verifier values from the same recovery key", async () => {
    const { raw } = generateRecoveryKey();
    const unwrapKeyMaterial = await deriveRecoveryUnwrapKey(raw);
    const verifier = await deriveRecoveryVerifier(raw);

    expect(unwrapKeyMaterial).toBeInstanceOf(CryptoKey);
    expect(typeof verifier).toBe("string");
    expect(verifier.length).toBeGreaterThan(0);
  });

  it("the verifier is deterministic for the same recovery key but differs across keys", async () => {
    const a = generateRecoveryKey();
    const b = generateRecoveryKey();
    expect(await deriveRecoveryVerifier(a.raw)).toBe(await deriveRecoveryVerifier(a.raw));
    expect(await deriveRecoveryVerifier(a.raw)).not.toBe(await deriveRecoveryVerifier(b.raw));
  });

  it("unwraps a vault key wrapped with the recovery key, and fails with a different one", async () => {
    const { raw } = generateRecoveryKey();
    const wrongRecovery = generateRecoveryKey();
    const recoveryUnwrapKey = await deriveRecoveryUnwrapKey(raw);
    const wrongUnwrapKey = await deriveRecoveryUnwrapKey(wrongRecovery.raw);
    const dataKey = await generateDataKey();

    const wrapped = await wrapKey(dataKey, recoveryUnwrapKey);
    const unwrapped = await unwrapKey(wrapped, recoveryUnwrapKey);
    expect(await keysAreEqual(dataKey, unwrapped)).toBe(true);

    await expect(unwrapKey(wrapped, wrongUnwrapKey)).rejects.toThrow();
  });
});
