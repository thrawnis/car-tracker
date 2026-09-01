import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Express } from "express";
import request from "supertest";
import { authenticator } from "otplib";
import { createApp } from "../../src/app.js";
import { resetDb } from "../resetDb.js";
import { createAccount, authedRequest, uniqueEmail } from "../helpers.js";

let app: Express;

beforeAll(() => {
  app = createApp();
});

beforeEach(async () => {
  await resetDb();
});

describe("registration and mandatory 2FA enrollment", () => {
  it("rejects a weak password", async () => {
    const res = await request(app).post("/api/auth/register").send({ email: uniqueEmail(), password: "short" });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate registration for the same email", async () => {
    const email = uniqueEmail();
    await request(app).post("/api/auth/register").send({ email, password: "supersecretpassword123" }).expect(201);
    const res = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "anotherlongpassword123" });
    expect(res.status).toBe(409);
  });

  it("cannot enable 2FA with an incorrect code", async () => {
    const email = uniqueEmail();
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send({ email, password: "supersecretpassword123" })
      .expect(201);
    const enrollToken = registerRes.body.enrollToken as string;

    await request(app).post("/api/auth/totp/setup").send({ enrollToken }).expect(200);
    const res = await request(app).post("/api/auth/totp/enable").send({ enrollToken, code: "000000" });
    expect(res.status).toBe(400);
  });

  it("issues an access token and one-time backup codes once 2FA is enabled", async () => {
    const account = await createAccount(app);
    expect(account.accessToken).toBeTruthy();
    expect(account.backupCodes).toHaveLength(10);
  });

  it("blocks login until 2FA enrollment is completed", async () => {
    const email = uniqueEmail();
    const password = "supersecretpassword123";
    await request(app).post("/api/auth/register").send({ email, password }).expect(201);

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
  });
});

// Sanity check that otplib codes generated in this test file line up with the
// server's own verification, independent of the createAccount() helper.
describe("totp codes generated directly with otplib", () => {
  it("are accepted by the verify endpoint", async () => {
    const email = uniqueEmail();
    const password = "supersecretpassword123";
    const registerRes = await request(app).post("/api/auth/register").send({ email, password }).expect(201);
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
