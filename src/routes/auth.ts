import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { createSession, deleteSession, verifyPassword, SESSION_COOKIE_NAME } from "../auth/session";
import { requireAuth } from "../auth/middleware";

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const IS_PROD = process.env.NODE_ENV === "production";

function buildCookie(token: string, expiresAt: Date): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Path=/`,
    `Expires=${expiresAt.toUTCString()}`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (IS_PROD) parts.push("Secure");
  return parts.join("; ");
}

function clearCookie(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    `Path=/`,
    `Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `HttpOnly`,
    `SameSite=Lax`,
  ];
  if (IS_PROD) parts.push("Secure");
  return parts.join("; ");
}

router.post("/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "invalid_credentials" });
    return;
  }

  const { token, expiresAt } = await createSession(user.id);
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  res.setHeader("Set-Cookie", buildCookie(token, expiresAt));
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
    expiresAt,
  });
});

router.post("/logout", requireAuth, async (req: Request, res: Response) => {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.split(";").map(c => c.trim()).find(c => c.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (match) {
    const token = decodeURIComponent(match.split("=")[1]);
    await deleteSession(token);
  }
  res.setHeader("Set-Cookie", clearCookie());
  res.json({ ok: true });
});

router.get("/me", requireAuth, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

export default router;
