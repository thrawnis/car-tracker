import type { Express } from "express";
import request from "supertest";
import { authenticator } from "otplib";
import {
  generateDataKey,
  generateSaltB64,
  deriveKeyFromPassword,
  wrapKey,
  generateRecoveryKey,
  deriveRecoveryUnwrapKey,
  deriveRecoveryVerifier,
  encryptOptionalField,
  decryptOptionalField,
} from "../../client/src/crypto/vault.js";

// Test helpers act as a stand-in "browser": they perform the exact same
// client-side crypto the real frontend does (imported directly from the
// client package, not reimplemented here) so integration tests exercise the
// real protocol - the server never sees a password-derived key, a data key,
// or plaintext for any encrypted field.

export interface TestAccount {
  email: string;
  password: string;
  accessToken: string;
  refreshCookie: string;
  backupCodes: string[];
  dataKey: CryptoKey;
  recoveryKeyDisplay: string;
}

let counter = 0;
export function uniqueEmail(): string {
  counter += 1;
  return `user${Date.now()}${counter}@example.com`;
}

/** Registers a brand-new account, completes mandatory TOTP enrollment, and returns a logged-in session. */
export async function createAccount(app: Express, password = "supersecretpassword123"): Promise<TestAccount> {
  const email = uniqueEmail();

  const dataKey = await generateDataKey();
  const vaultSalt = generateSaltB64();
  const vaultKeyWrappedByPassword = await wrapKey(dataKey, await deriveKeyFromPassword(password, vaultSalt));

  const recovery = generateRecoveryKey();
  const vaultKeyWrappedByRecovery = await wrapKey(dataKey, await deriveRecoveryUnwrapKey(recovery.raw));
  const recoveryVerifier = await deriveRecoveryVerifier(recovery.raw);

  const registerRes = await request(app)
    .post("/api/auth/register")
    .send({ email, password, vaultSalt, vaultKeyWrappedByPassword, vaultKeyWrappedByRecovery, recoveryVerifier })
    .expect(201);
  const enrollToken = registerRes.body.enrollToken as string;

  const setupRes = await request(app).post("/api/auth/totp/setup").send({ enrollToken }).expect(200);
  const secret = setupRes.body.secret as string;
  const code = authenticator.generate(secret);

  const enableRes = await request(app).post("/api/auth/totp/enable").send({ enrollToken, code }).expect(200);

  const refreshCookie = extractRefreshCookie(enableRes.headers["set-cookie"]);

  return {
    email,
    password,
    accessToken: enableRes.body.accessToken as string,
    refreshCookie,
    backupCodes: enableRes.body.backupCodes as string[],
    dataKey,
    recoveryKeyDisplay: recovery.display,
  };
}

function extractRefreshCookie(setCookie: string[] | string | undefined): string {
  const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const refresh = cookies.find((c) => c.startsWith("car_tracker_refresh="));
  if (!refresh) throw new Error("No refresh cookie set in response");
  return refresh.split(";")[0]!;
}

export function authedRequest(app: Express, account: Pick<TestAccount, "accessToken" | "refreshCookie">) {
  return {
    get: (url: string) =>
      request(app).get(url).set("Authorization", `Bearer ${account.accessToken}`).set("Cookie", account.refreshCookie),
    post: (url: string) =>
      request(app)
        .post(url)
        .set("Authorization", `Bearer ${account.accessToken}`)
        .set("Cookie", account.refreshCookie),
    patch: (url: string) =>
      request(app)
        .patch(url)
        .set("Authorization", `Bearer ${account.accessToken}`)
        .set("Cookie", account.refreshCookie),
    delete: (url: string) =>
      request(app)
        .delete(url)
        .set("Authorization", `Bearer ${account.accessToken}`)
        .set("Cookie", account.refreshCookie),
  };
}

/** Encrypts a plaintext value the way the real client would, for building test request bodies. */
export function encryptField(value: string | null, dataKey: CryptoKey): Promise<string | null> {
  return encryptOptionalField(value, dataKey);
}

/** Decrypts a value the way the real client would, for asserting on API responses in tests. */
export function decryptField(value: string | null, dataKey: CryptoKey): Promise<string | null> {
  return decryptOptionalField(value, dataKey);
}
