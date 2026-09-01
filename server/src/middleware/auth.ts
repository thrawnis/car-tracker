import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/db.js";
import { verifyAccessToken } from "../auth/tokens.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      sessionId?: string;
    }
  }
}

// Deliberately no per-account cipher here: the server has no key that can
// decrypt vehicle/maintenance/fuel data (see prisma/schema.prisma User model
// and client/src/crypto/vault.ts). All routes below this middleware treat
// "*Encrypted" fields as opaque blobs the client encrypted and will decrypt.
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
    next();
  } catch {
    res.status(401).json({ error: "Not authenticated" });
  }
}
