import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../env.js";
import { prisma } from "../lib/db.js";

export interface AccessTokenPayload {
  sub: string; // userId
  sid: string; // sessionId
}

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sub: userId, sid: sessionId } satisfies AccessTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
}

export type PurposeTokenPurpose = "enroll" | "mfa";

export interface PurposeTokenPayload {
  sub: string;
  purpose: PurposeTokenPurpose;
}

/** Short-lived, narrowly-scoped tokens for the register->2FA-enroll and login->2FA-verify handshakes. */
export function signPurposeToken(userId: string, purpose: PurposeTokenPurpose): string {
  return jwt.sign({ sub: userId, purpose } satisfies PurposeTokenPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: "10m",
  });
}

export function verifyPurposeToken(token: string, purpose: PurposeTokenPurpose): string {
  const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as PurposeTokenPayload;
  if (payload.purpose !== purpose) throw new Error("Invalid token purpose");
  return payload.sub;
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<{ refreshToken: string; sessionId: string }> {
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const session = await prisma.session.create({
    data: {
      userId,
      refreshTokenHash: hashToken(refreshToken),
      userAgent: meta.userAgent,
      ipAddress: meta.ipAddress,
      expiresAt,
    },
  });

  return { refreshToken, sessionId: session.id };
}

export async function rotateSession(
  oldRefreshToken: string,
  meta: { userAgent?: string; ipAddress?: string },
): Promise<{ refreshToken: string; sessionId: string; userId: string } | null> {
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: hashToken(oldRefreshToken) },
  });

  if (!session || session.revokedAt || session.expiresAt < new Date()) {
    return null;
  }

  await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });

  const next = await createSession(session.userId, meta);
  return { ...next, userId: session.userId };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
