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
  signAccessToken,
  signPurposeToken,
  verifyPurposeToken,
} from "../auth/tokens.js";
import { generateDataKey, wrapDataKey, unwrapDataKey, AccountCipher, safeCompareB64 } from "../crypto/encryption.js";
import { env } from "../env.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${(req.body as { email?: string })?.email ?? ""}`,
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

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(12, "Password must be at least 12 characters"),
  // All vault fields are generated and wrapped client-side; the server only ever
  // stores these opaque blobs and can't derive a data key from any of them.
  vaultSalt: opaqueB64,
  vaultKeyWrappedByPassword: opaqueB64,
  vaultKeyWrappedByRecovery: opaqueB64,
  recoveryVerifier: opaqueB64,
});

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    return;
  }
  const { email, password, vaultSalt, vaultKeyWrappedByPassword, vaultKeyWrappedByRecovery, recoveryVerifier } =
    parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: "An account with that email already exists" });
    return;
  }

  const passwordHash = await hashPassword(password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      vaultSalt,
      vaultKeyWrappedByPassword,
      vaultKeyWrappedByRecovery,
      recoveryVerifier,
    },
  });

  // 2FA is mandatory: the account cannot be used until TOTP enrollment finishes.
  const enrollToken = signPurposeToken(user.id, "enroll");
  res.status(201).json({ enrollToken });
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

  if (!user.totpEnabled) {
    const enrollToken = signPurposeToken(user.id, "enroll");
    res.status(403).json({ error: "2FA setup required", enrollToken });
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
    email: user.email,
    timezone: user.timezone,
    reminderEmail: user.reminderEmail,
    reminderLeadDays: user.reminderLeadDays,
  });
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
