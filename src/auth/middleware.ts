import { Request, Response, NextFunction } from "express";
import { SESSION_COOKIE_NAME, getSessionByToken } from "./session";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string; role: string };
    }
  }
}

function parseCookies(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const pair of raw.split(";")) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    try {
      map.set(key, decodeURIComponent(val));
    } catch {
      map.set(key, val);
    }
  }
  return map;
}

function readTokenFromRequest(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7);
  }
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== "string") return null;
  return parseCookies(cookieHeader).get(SESSION_COOKIE_NAME) || null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readTokenFromRequest(req);
  if (!token) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const session = await getSessionByToken(token);
  if (!session) {
    res.status(401).json({ error: "invalid or expired session" });
    return;
  }
  req.user = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: session.user.role,
  };
  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    next();
  };
}
