import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { authenticator } from "otplib";
import { createApp } from "../../src/app.js";
import { resetDb } from "../resetDb.js";
import { createAccount, authedRequest, uniqueEmail } from "../helpers.js";
import { prisma } from "../../src/lib/db.js";
import {
  generateDataKey,
  generateSaltB64,
  deriveKeyFromPassword,
  wrapKey,
  unwrapKey,
  generateRecoveryKey,
  deriveRecoveryUnwrapKey,
  deriveRecoveryVerifier,
  keysAreEqual,
} from "../../../client/src/crypto/vault.js";

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDb();
});

/** Builds a valid set of client-side-computed vault fields for a /register call. */
async function registerVaultFields(password: string) {
  const dataKey = await generateDataKey();
  const vaultSalt = generateSaltB64();
  const vaultKeyWrappedByPassword = await wrapKey(dataKey, await deriveKeyFromPassword(password, vaultSalt));
  const recovery = generateRecoveryKey();
  const vaultKeyWrappedByRecovery = await wrapKey(dataKey, await deriveRecoveryUnwrapKey(recovery.raw));
  const recoveryVerifier = await deriveRecoveryVerifier(recovery.raw);
  return { dataKey, recovery, vaultSalt, vaultKeyWrappedByPassword, vaultKeyWrappedByRecovery, recoveryVerifier };
}

describe("registration and mandatory 2FA enrollment", () => {
  it("rejects a weak password", async () => {
    const fields = await registerVaultFields("short");
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: uniqueEmail(), password: "short", ...fields });
    expect(res.status).toBe(400);
  });

  it("rejects registration missing vault fields (a real client always computes these)", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email: uniqueEmail(), password: "supersecretpassword123" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate registration for the same email", async () => {
    const email = uniqueEmail();
    const password = "supersecretpassword123";
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, ...(await registerVaultFields(password)) })
      .expect(201);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "anotherlongpassword123", ...(await registerVaultFields(password)) });
    expect(res.status).toBe(409);
  });

  it("stores only opaque vault blobs for a new account - never anything resembling the password", async () => {
    const password = "supersecretpassword123";
    const fields = await registerVaultFields(password);
    const email = uniqueEmail();
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, ...fields })
      .expect(201);

    const row = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.vaultSalt).toBe(fields.vaultSalt);
    expect(row.vaultKeyWrappedByPassword).toBe(fields.vaultKeyWrappedByPassword);
    expect(row.vaultKeyWrappedByRecovery).toBe(fields.vaultKeyWrappedByRecovery);
    for (const stored of [row.vaultSalt, row.vaultKeyWrappedByPassword, row.vaultKeyWrappedByRecovery]) {
      expect(stored).not.toContain(password);
    }
  });

  it("cannot enable 2FA with an incorrect code", async () => {
    const email = uniqueEmail();
    const password = "supersecretpassword123";
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send({ email, password, ...(await registerVaultFields(password)) })
      .expect(201);
    const enrollToken = registerRes.body.enrollToken as string;

    await request(app).post("/api/auth/totp/setup").send({ enrollToken }).expect(200);
    const res = await request(app).post("/api/auth/totp/enable").send({ enrollToken, code: "000000" });
    expect(res.status).toBe(400);
  });

  it("issues an access token, backup codes, and vault-unwrap fields once 2FA is enabled", async () => {
    const account = await createAccount(app);
    expect(account.accessToken).toBeTruthy();
    expect(account.backupCodes).toHaveLength(10);
  });

  it("blocks login until 2FA enrollment is completed", async () => {
    const email = uniqueEmail();
    const password = "supersecretpassword123";
    await request(app)
      .post("/api/auth/register")
      .send({ email, password, ...(await registerVaultFields(password)) })
      .expect(201);

    const res = await request(app).post("/api/auth/login").send({ email, password });
    expect(res.status).toBe(403);
    expect(res.body.enrollToken).toBeTruthy();
  });
});

describe("login and 2FA verification", () => {
  it("rejects an incorrect password", async () => {
    const account = await createAccount(app);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: "wrong-password" });
    expect(res.status).toBe(401);
  });

  it("requires a second mfa step even with the correct password", async () => {
    const account = await createAccount(app);
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);
    expect(res.body.mfaToken).toBeTruthy();
    expect(res.body.accessToken).toBeUndefined();
  });

  it("rejects an invalid TOTP code at the verify step", async () => {
    const account = await createAccount(app);
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);

    const res = await request(app)
      .post("/api/auth/totp/verify")
      .send({ mfaToken: loginRes.body.mfaToken, code: "000000" });
    expect(res.status).toBe(400);
  });

  it("returns vault-unwrap fields on verify that let the real client recover its data key", async () => {
    const account = await createAccount(app);
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);

    const verifyRes = await request(app)
      .post("/api/auth/totp/verify")
      .send({ mfaToken: loginRes.body.mfaToken, backupCode: account.backupCodes[0] })
      .expect(200);

    expect(verifyRes.body.vaultSalt).toBeTruthy();
    expect(verifyRes.body.vaultKeyWrappedByPassword).toBeTruthy();

    const wrappingKey = await deriveKeyFromPassword(account.password, verifyRes.body.vaultSalt);
    const recoveredDataKey = await unwrapKey(verifyRes.body.vaultKeyWrappedByPassword, wrappingKey);
    expect(await keysAreEqual(recoveredDataKey, account.dataKey)).toBe(true);
  });

  it("allows logging in with a backup code, and consumes it (single use)", async () => {
    const account = await createAccount(app);
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);
    const backupCode = account.backupCodes[0]!;

    const firstUse = await request(app)
      .post("/api/auth/totp/verify")
      .send({ mfaToken: loginRes.body.mfaToken, backupCode });
    expect(firstUse.status).toBe(200);
    expect(firstUse.body.accessToken).toBeTruthy();

    const loginRes2 = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);
    const secondUse = await request(app)
      .post("/api/auth/totp/verify")
      .send({ mfaToken: loginRes2.body.mfaToken, backupCode });
    expect(secondUse.status).toBe(400);
  });
});

describe("sessions", () => {
  it("rejects requests with no token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("rejects a malformed/garbage bearer token", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("refreshes an access token using the refresh cookie and rotates it", async () => {
    const account = await createAccount(app);

    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .set("Cookie", account.refreshCookie)
      .expect(200);
    expect(refreshRes.body.accessToken).toBeTruthy();
    expect(refreshRes.body.accessToken).not.toBe(account.accessToken);
    expect(refreshRes.body.vaultSalt).toBeTruthy();

    // The old refresh token was rotated out and must no longer work.
    const reuseRes = await request(app).post("/api/auth/refresh").set("Cookie", account.refreshCookie);
    expect(reuseRes.status).toBe(401);
  });

  it("revokes the session on logout so the refresh cookie stops working", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);

    await authed.post("/api/auth/logout").expect(204);

    const res = await request(app).post("/api/auth/refresh").set("Cookie", account.refreshCookie);
    expect(res.status).toBe(401);
  });
});

describe("account preferences", () => {
  it("updates and persists reminder preferences", async () => {
    const account = await createAccount(app);
    const authed = authedRequest(app, account);

    await authed
      .patch("/api/auth/me")
      .send({ reminderEmail: "reminders@example.com", reminderLeadDays: 14 })
      .expect(200);

    const me = await authed.get("/api/auth/me").expect(200);
    expect(me.body.reminderEmail).toBe("reminders@example.com");
    expect(me.body.reminderLeadDays).toBe(14);
    expect(me.body.vaultSalt).toBeTruthy();
    expect(me.body.vaultKeyWrappedByPassword).toBeTruthy();
  });
});

describe("account recovery (forgot password)", () => {
  it("returns the account's wrapped-by-recovery blob for a known email", async () => {
    const account = await createAccount(app);
    const res = await request(app).post("/api/auth/recovery/start").send({ email: account.email }).expect(200);
    expect(res.body.vaultKeyWrappedByRecovery).toBeTruthy();
  });

  it("returns a plausible (but useless) decoy for an unknown email, rather than 404ing", async () => {
    const res = await request(app)
      .post("/api/auth/recovery/start")
      .send({ email: uniqueEmail() })
      .expect(200);
    expect(typeof res.body.vaultKeyWrappedByRecovery).toBe("string");
  });

  it("lets the client recover its data key from the recovery key alone", async () => {
    const account = await createAccount(app);
    const startRes = await request(app).post("/api/auth/recovery/start").send({ email: account.email }).expect(200);

    // This is exactly what ForgotPasswordPage does client-side: parse the
    // recovery key the user re-enters, derive the unwrap key from it, and
    // unwrap - all without the server ever being involved in the crypto.
    const { parseRecoveryKey, deriveRecoveryUnwrapKey: deriveUnwrap } = await import(
      "../../../client/src/crypto/vault.js"
    );
    const raw = parseRecoveryKey(account.recoveryKeyDisplay);
    const unwrapKeyMaterial = await deriveUnwrap(raw);
    const recoveredDataKey = await unwrapKey(startRes.body.vaultKeyWrappedByRecovery, unwrapKeyMaterial);
    expect(await keysAreEqual(recoveredDataKey, account.dataKey)).toBe(true);
  });

  it("completes a full recovery: resets the password and lets the new password unwrap the same data key", async () => {
    const account = await createAccount(app);
    const startRes = await request(app).post("/api/auth/recovery/start").send({ email: account.email }).expect(200);

    const raw = (await import("../../../client/src/crypto/vault.js")).parseRecoveryKey(account.recoveryKeyDisplay);
    const unwrapKeyMaterial = await deriveRecoveryUnwrapKey(raw);
    const recoveredDataKey = await unwrapKey(startRes.body.vaultKeyWrappedByRecovery, unwrapKeyMaterial);
    const recoveryVerifierProof = await deriveRecoveryVerifier(raw);

    const newPassword = "brand-new-password-123";
    const newVaultSalt = generateSaltB64();
    const newVaultKeyWrappedByPassword = await wrapKey(
      recoveredDataKey,
      await deriveKeyFromPassword(newPassword, newVaultSalt),
    );

    await request(app)
      .post("/api/auth/recovery/complete")
      .send({
        email: account.email,
        recoveryVerifierProof,
        newPassword,
        newVaultSalt,
        newVaultKeyWrappedByPassword,
      })
      .expect(204);

    // Old password no longer works; new one does, and unwraps the SAME data key.
    await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(401);

    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: account.email, password: newPassword })
      .expect(200);
    const verifyRes = await request(app)
      .post("/api/auth/totp/verify")
      .send({ mfaToken: loginRes.body.mfaToken, backupCode: account.backupCodes[0] })
      .expect(200);

    const wrappingKey = await deriveKeyFromPassword(newPassword, verifyRes.body.vaultSalt);
    const dataKeyAfterRecovery = await unwrapKey(verifyRes.body.vaultKeyWrappedByPassword, wrappingKey);
    expect(await keysAreEqual(dataKeyAfterRecovery, account.dataKey)).toBe(true);
  });

  it("revokes existing sessions when a password is reset via recovery", async () => {
    const account = await createAccount(app);
    const startRes = await request(app).post("/api/auth/recovery/start").send({ email: account.email }).expect(200);
    const raw = (await import("../../../client/src/crypto/vault.js")).parseRecoveryKey(account.recoveryKeyDisplay);
    const unwrapKeyMaterial = await deriveRecoveryUnwrapKey(raw);
    const recoveredDataKey = await unwrapKey(startRes.body.vaultKeyWrappedByRecovery, unwrapKeyMaterial);
    const recoveryVerifierProof = await deriveRecoveryVerifier(raw);
    const newVaultSalt = generateSaltB64();
    const newVaultKeyWrappedByPassword = await wrapKey(
      recoveredDataKey,
      await deriveKeyFromPassword("brand-new-password-123", newVaultSalt),
    );

    await request(app)
      .post("/api/auth/recovery/complete")
      .send({
        email: account.email,
        recoveryVerifierProof,
        newPassword: "brand-new-password-123",
        newVaultSalt,
        newVaultKeyWrappedByPassword,
      })
      .expect(204);

    const res = await request(app).post("/api/auth/refresh").set("Cookie", account.refreshCookie);
    expect(res.status).toBe(401);
  });

  it("rejects recovery completion with an incorrect recovery-key proof", async () => {
    const account = await createAccount(app);
    const wrongRecovery = generateRecoveryKey();
    const wrongProof = await deriveRecoveryVerifier(wrongRecovery.raw);

    const res = await request(app).post("/api/auth/recovery/complete").send({
      email: account.email,
      recoveryVerifierProof: wrongProof,
      newPassword: "brand-new-password-123",
      newVaultSalt: generateSaltB64(),
      newVaultKeyWrappedByPassword: "irrelevant",
    });
    expect(res.status).toBe(400);
  });
});

// Sanity check that otplib codes generated in this test file line up with the
// server's own verification, independent of the createAccount() helper.
describe("totp codes generated directly with otplib", () => {
  it("are accepted by the verify endpoint", async () => {
    const email = uniqueEmail();
    const password = "supersecretpassword123";
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send({ email, password, ...(await registerVaultFields(password)) })
      .expect(201);
    const enrollToken = registerRes.body.enrollToken as string;
    const setupRes = await request(app).post("/api/auth/totp/setup").send({ enrollToken }).expect(200);
    const secret = setupRes.body.secret as string;

    await request(app)
      .post("/api/auth/totp/enable")
      .send({ enrollToken, code: authenticator.generate(secret) })
      .expect(200);

    const loginRes = await request(app).post("/api/auth/login").send({ email, password }).expect(200);
    const verifyRes = await request(app)
      .post("/api/auth/totp/verify")
      .send({ mfaToken: loginRes.body.mfaToken, code: authenticator.generate(secret) });
    expect(verifyRes.status).toBe(200);
  });
});
