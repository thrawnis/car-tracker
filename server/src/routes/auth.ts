import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import type { User } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import {
  generateTotpSecret,
  generateTotpQrCode,
  verifyTotpToken,
  generateBackupCodes,
  hashBackupCode,
} from "../auth/totp.js";
import {
  createSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  revokeAllSessionsExcept,
  signAccessToken,
  signPurposeToken,
  verifyPurposeToken,
} from "../auth/tokens.js";
import {
  generateVerificationCode,
  hashVerificationCode,
  EMAIL_VERIFICATION_TTL_MINUTES,
} from "../auth/emailVerification.js";
import { generateDataKey, wrapDataKey, unwrapDataKey, AccountCipher, safeCompareB64 } from "../crypto/encryption.js";
import { env } from "../env.js";
import { requireAuth } from "../middleware/auth.js";
import { sendMail } from "../services/mailer.js";

export const authRouter = Router();

// Integration tests exercise far more request volume, from one "IP", than any
// real client would - all rate limiters in this file skip in the test
// environment, but stay on in dev/production.
const skipInTest = () => env.NODE_ENV === "test";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body as { email?: string })?.email ?? ""}`,
  skip: skipInTest,
});

const REFRESH_COOKIE = "car_tracker_refresh";

function setRefreshCookie(res: import("express").Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/api/auth",
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

/** The opaque vault fields a client needs to unwrap its data key - safe to hand back post-auth. */
function vaultFields(user: Pick<User, "vaultSalt" | "vaultKeyWrappedByPassword">) {
  return { vaultSalt: user.vaultSalt, vaultKeyWrappedByPassword: user.vaultKeyWrappedByPassword };
}

/** Unwraps (with the server master key) the per-account key used only to encrypt the TOTP secret. */
async function getOrCreateTotpKey(userId: string, existingWrapped: string | null): Promise<Buffer> {
  if (existingWrapped) return unwrapDataKey(existingWrapped);
  const key = generateDataKey();
  await prisma.user.update({ where: { id: userId }, data: { totpKeyWrapped: wrapDataKey(key) } });
  return key;
}

const opaqueB64 = z.string().min(1).max(2000);
const usernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .max(30, "Username must be at most 30 characters")
  .regex(/^[a-zA-Z0-9_.-]+$/, "Username may only contain letters, numbers, underscores, dots, and dashes");

const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().email(),
  password: z.string().min(12, "Password must be at least 12 characters"),
  // All vault fields are generated and wrapped client-side; the server only ever
  // stores these opaque blobs and can't derive a data key from any of them.
  vaultSalt: opaqueB64,
  vaultKeyWrappedByPassword: opaqueB64,
  vaultKeyWrappedByRecovery: opaqueB64,
  recoveryVerifier: opaqueB64,
});

async function sendVerificationEmail(to: string, code: string): Promise<void> {
  await sendMail({
    to,
    subject: "Verify your Car Tracker email",
    text: `Your verification code is ${code}. It expires in ${EMAIL_VERIFICATION_TTL_MINUTES} minutes.`,
    html: `<p>Your verification code is <strong>${code}</strong>. It expires in ${EMAIL_VERIFICATION_TTL_MINUTES} minutes.</p>`,
  });
}

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { username, email, password, vaultSalt, vaultKeyWrappedByPassword, vaultKeyWrappedByRecovery, recoveryVerifier } =
    parsed.data;

  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findUnique({ where: { email } }),
    prisma.user.findUnique({ where: { username } }),
  ]);
  if (existingEmail) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }
  if (existingUsername) {
    res.status(409).json({ error: "That username is already taken" });
    return;
  }

  const passwordHash = await hashPassword(password);
  const verification = generateVerificationCode();

  const user = await prisma.user.create({
    data: {
      username,
      email,
      passwordHash,
      vaultSalt,
      vaultKeyWrappedByPassword,
      vaultKeyWrappedByRecovery,
      recoveryVerifier,
      emailVerificationCodeHash: verification.hash,
      emailVerificationExpiresAt: verification.expiresAt,
    },
  });

  await sendVerificationEmail(email, verification.code);

  // Email verification, then 2FA, are both mandatory before the account can be
  // used - the same enroll token carries the client through both steps.
  const enrollToken = signPurposeToken(user.id, "enroll");
  res.status(201).json({
    enrollToken,
    // Only ever included in the test environment, so integration tests can
    // exercise verification without needing a real mailbox. NODE_ENV=test is
    // set exclusively by server/test/setup.ts - never in dev or production.
    ...(env.NODE_ENV === "test" ? { emailVerificationCode: verification.code } : {}),
  });
});

authRouter.post("/verify-email", async (req, res) => {
  const parsed = z.object({ enrollToken: z.string(), code: z.string().length(6) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "enrollToken and a 6-digit code are required" });
    return;
  }

  let userId: string;
  try {
    userId = verifyPurposeToken(parsed.data.enrollToken, "enroll");
  } catch {
    res.status(401).json({ error: "Invalid or expired enrollment token" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).end();
    return;
  }
  if (user.emailVerified) {
    res.status(400).json({ error: "Email already verified" });
    return;
  }
  if (
    !user.emailVerificationCodeHash ||
    !user.emailVerificationExpiresAt ||
    user.emailVerificationExpiresAt < new Date() ||
    hashVerificationCode(parsed.data.code) !== user.emailVerificationCodeHash
  ) {
    res.status(400).json({ error: "Invalid or expired code" });
    return;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { emailVerified: true, emailVerificationCodeHash: null, emailVerificationExpiresAt: null },
  });

  res.status(204).end();
});

const resendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
});

authRouter.post("/verify-email/resend", resendLimiter, async (req, res) => {
  const parsed = z.object({ enrollToken: z.string() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "enrollToken is required" });
    return;
  }

  let userId: string;
  try {
    userId = verifyPurposeToken(parsed.data.enrollToken, "enroll");
  } catch {
    res.status(401).json({ error: "Invalid or expired enrollment token" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).end();
    return;
  }
  if (user.emailVerified) {
    res.status(400).json({ error: "Email already verified" });
    return;
  }

  const verification = generateVerificationCode();
  await prisma.user.update({
    where: { id: userId },
    data: { emailVerificationCodeHash: verification.hash, emailVerificationExpiresAt: verification.expiresAt },
  });
  await sendVerificationEmail(user.email, verification.code);

  res.status(204).end();
});

authRouter.post("/totp/setup", async (req, res) => {
  const enrollToken = req.body?.enrollToken as string | undefined;
  if (!enrollToken) {
    res.status(400).json({ error: "enrollToken is required" });
    return;
  }

  let userId: string;
  try {
    userId = verifyPurposeToken(enrollToken, "enroll");
  } catch {
    res.status(401).json({ error: "Invalid or expired enrollment token" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.totpEnabled) {
    res.status(400).json({ error: "TOTP already enabled or account not found" });
    return;
  }
  if (!user.emailVerified) {
    res.status(403).json({ error: "Verify your email before setting up 2FA" });
    return;
  }

  const secret = generateTotpSecret();
  const totpKey = await getOrCreateTotpKey(user.id, user.totpKeyWrapped);
  const cipher = new AccountCipher(totpKey);
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecretEncrypted: cipher.encrypt(secret) },
  });

  const qrCodeDataUrl = await generateTotpQrCode(user.email, secret);
  res.json({ secret, qrCodeDataUrl });
});

const enableTotpSchema = z.object({
  enrollToken: z.string(),
  code: z.string().length(6),
});

authRouter.post("/totp/enable", async (req, res) => {
  const parsed = enableTotpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "enrollToken and 6-digit code are required" });
    return;
  }

  let userId: string;
  try {
    userId = verifyPurposeToken(parsed.data.enrollToken, "enroll");
  } catch {
    res.status(401).json({ error: "Invalid or expired enrollment token" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpSecretEncrypted || !user.totpKeyWrapped) {
    res.status(400).json({ error: "Run /totp/setup first" });
    return;
  }
  if (!user.emailVerified) {
    res.status(403).json({ error: "Verify your email before setting up 2FA" });
    return;
  }

  const cipher = new AccountCipher(unwrapDataKey(user.totpKeyWrapped));
  const secret = cipher.decrypt(user.totpSecretEncrypted);
  if (!secret || !verifyTotpToken(secret, parsed.data.code)) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  const { plain, hashed } = generateBackupCodes();
  await prisma.user.update({
    where: { id: userId },
    data: { totpEnabled: true, totpBackupCodesHashed: hashed },
  });

  const { refreshToken, sessionId } = await createSession(userId, {
    userAgent: req.headers["user-agent"],
    ipAddress: req.ip,
  });
  const accessToken = signAccessToken(userId, sessionId);
  setRefreshCookie(res, refreshToken);

  res.json({ accessToken, backupCodes: plain, ...vaultFields(user) });
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  const passwordOk = user ? await verifyPassword(user.passwordHash, password) : false;

  await prisma.loginAttempt.create({
    data: { userId: user?.id, email, success: passwordOk, ipAddress: req.ip },
  });

  if (!user || !passwordOk) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  // Both branches below also return the (safe, opaque) vaultFields so a client
  // resuming an interrupted enrollment - possibly in a fresh tab/session that
  // never held the data key generated at registration - can re-derive it from
  // the password just entered, rather than being stuck without it.
  if (!user.emailVerified) {
    const enrollToken = signPurposeToken(user.id, "enroll");
    res
      .status(403)
      .json({ error: "Email verification required", enrollToken, needsEmailVerification: true, ...vaultFields(user) });
    return;
  }

  if (!user.totpEnabled) {
    const enrollToken = signPurposeToken(user.id, "enroll");
    res.status(403).json({ error: "2FA setup required", enrollToken, ...vaultFields(user) });
    return;
  }

  const mfaToken = signPurposeToken(user.id, "mfa");
  res.json({ mfaToken });
});

const verifyMfaSchema = z.object({
  mfaToken: z.string(),
  code: z.string().optional(),
  backupCode: z.string().optional(),
});

authRouter.post("/totp/verify", loginLimiter, async (req, res) => {
  const parsed = verifyMfaSchema.safeParse(req.body);
  if (!parsed.success || (!parsed.data.code && !parsed.data.backupCode)) {
    res.status(400).json({ error: "mfaToken and code (or backupCode) are required" });
    return;
  }

  let userId: string;
  try {
    userId = verifyPurposeToken(parsed.data.mfaToken, "mfa");
  } catch {
    res.status(401).json({ error: "Invalid or expired login attempt, please log in again" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpEnabled || !user.totpSecretEncrypted || !user.totpKeyWrapped) {
    res.status(400).json({ error: "2FA is not set up on this account" });
    return;
  }

  const cipher = new AccountCipher(unwrapDataKey(user.totpKeyWrapped));
  let ok = false;

  if (parsed.data.code) {
    const secret = cipher.decrypt(user.totpSecretEncrypted);
    ok = !!secret && verifyTotpToken(secret, parsed.data.code);
  } else if (parsed.data.backupCode) {
    const hashed = hashBackupCode(parsed.data.backupCode);
    if (user.totpBackupCodesHashed.includes(hashed)) {
      ok = true;
      await prisma.user.update({
        where: { id: userId },
        data: { totpBackupCodesHashed: user.totpBackupCodesHashed.filter((h) => h !== hashed) },
      });
    }
  }

  if (!ok) {
    res.status(400).json({ error: "Invalid code" });
    return;
  }

  const { refreshToken, sessionId } = await createSession(userId, {
    userAgent: req.headers["user-agent"],
    ipAddress: req.ip,
  });
  const accessToken = signAccessToken(userId, sessionId);
  setRefreshCookie(res, refreshToken);

  res.json({ accessToken, ...vaultFields(user) });
});

authRouter.post("/refresh", async (req, res) => {
  const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (!token) {
    res.status(401).json({ error: "No refresh token" });
    return;
  }

  const rotated = await rotateSession(token, {
    userAgent: req.headers["user-agent"],
    ipAddress: req.ip,
  });
  if (!rotated) {
    res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
    res.status(401).json({ error: "Session expired, please log in again" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
  if (!user) {
    res.status(401).json({ error: "Session expired, please log in again" });
    return;
  }

  const accessToken = signAccessToken(rotated.userId, rotated.sessionId);
  setRefreshCookie(res, rotated.refreshToken);
  // The vault key itself is never restored here (the server doesn't have it) - this
  // just hands back what the client needs to prompt for a password and re-derive it.
  res.json({ accessToken, ...vaultFields(user) });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  if (req.sessionId) await revokeSession(req.sessionId);
  res.clearCookie(REFRESH_COOKIE, { path: "/api/auth" });
  res.status(204).end();
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user) {
    res.status(404).end();
    return;
  }
  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    timezone: user.timezone,
    reminderEmail: user.reminderEmail,
    reminderLeadDays: user.reminderLeadDays,
    ...vaultFields(user),
  });
});

const updateMeSchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
  reminderEmail: z.string().email().nullable().optional(),
  reminderLeadDays: z.number().int().min(0).max(365).optional(),
});

authRouter.patch("/me", requireAuth, async (req, res) => {
  const parsed = updateMeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const user = await prisma.user.update({ where: { id: req.userId! }, data: parsed.data });
  res.json({
    id: user.id,
    username: user.username,
    email: user.email,
    timezone: user.timezone,
    reminderEmail: user.reminderEmail,
    reminderLeadDays: user.reminderLeadDays,
  });
});

// ---- Change password (logged-in session) ----
//
// Unlike account recovery, this never touches the recovery key at all: the
// client already holds the unwrapped data key (the vault is unlocked in a
// logged-in session), so it just re-wraps that same key with a freshly
// salted, new-password-derived key and sends the result here. The server's
// only job is to verify the current password and swap in the new wrapping.

const changePasswordSchema = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(12, "Password must be at least 12 characters"),
  newVaultSalt: opaqueB64,
  newVaultKeyWrappedByPassword: opaqueB64,
});

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: req.userId! } });
  if (!user || !(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
    res.status(401).json({ error: "Incorrect current password" });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      vaultSalt: parsed.data.newVaultSalt,
      vaultKeyWrappedByPassword: parsed.data.newVaultKeyWrappedByPassword,
    },
  });

  // Log out other devices/sessions, since they were authorized under the old
  // password; keep this session (the one that just proved both passwords).
  if (req.sessionId) await revokeAllSessionsExcept(user.id, req.sessionId);

  res.status(204).end();
});

// ---- Account recovery (forgot password) ----
//
// The server can gate this flow (via recoveryVerifier) without ever being able
// to derive the vault-unwrap key itself: both values are independent HKDF
// outputs of the same recovery key, computed client-side. See
// client/src/crypto/vault.ts for the derivations this pairs with.

const recoveryLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body as { email?: string })?.email ?? ""}`,
  skip: skipInTest,
});

authRouter.post("/recovery/start", recoveryLimiter, async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "A valid email is required" });
    return;
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // For an unknown email, return a *freshly random* same-shaped blob rather than
  // a fixed placeholder - a constant decoy would let an attacker distinguish
  // "unknown email" (always identical) from "known email" (always unique) just
  // by requesting the same address twice, defeating the point of the decoy.
  const wrapped = user?.vaultKeyWrappedByRecovery ?? crypto.randomBytes(12 + 16 + 32).toString("base64");
  res.json({ vaultKeyWrappedByRecovery: wrapped });
});

const recoveryCompleteSchema = z.object({
  email: z.string().email(),
  recoveryVerifierProof: z.string().min(1).max(200),
  newPassword: z.string().min(12, "Password must be at least 12 characters"),
  newVaultSalt: opaqueB64,
  newVaultKeyWrappedByPassword: opaqueB64,
});

authRouter.post("/recovery/complete", recoveryLimiter, async (req, res) => {
  const parsed = recoveryCompleteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { email, recoveryVerifierProof, newPassword, newVaultSalt, newVaultKeyWrappedByPassword } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !safeCompareB64(recoveryVerifierProof, user.recoveryVerifier)) {
    res.status(400).json({ error: "Invalid recovery key" });
    return;
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash,
      vaultSalt: newVaultSalt,
      vaultKeyWrappedByPassword: newVaultKeyWrappedByPassword,
    },
  });

  // The password (and thus every existing session's implicit trust) just
  // changed via a recovery flow rather than the account holder's own choice
  // of new password from a logged-in session - revoke everything and make
  // them log in fresh.
  await revokeAllSessions(user.id);

  res.status(204).end();
});
