import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { unwrapDataKey, AccountCipher } from "../crypto/encryption.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
      cipher?: AccountCipher;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    req.userId = user.id;
    req.sessionId = payload.sid;
    req.cipher = new AccountCipher(unwrapDataKey(user.wrappedDataKey));
    next();
  } catch {
    res.status(401).json({ error: "Not authenticated" });
  }
}
