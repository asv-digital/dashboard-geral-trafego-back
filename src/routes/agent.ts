import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";
import { getSchedulerStatus, runCollectionNow } from "../agent/scheduler";
import { collectProduct } from "../agent/collector";
import { getAccountStatus } from "../lib/meta-account";

const router = Router();
router.use(requireAuth);

router.get("/status", (_req: Request, res: Response) => {
  res.json(getSchedulerStatus());
});

router.get("/account", async (_req: Request, res: Response) => {
  const status = await getAccountStatus();
  res.json(status);
});

router.get("/heartbeats", async (_req: Request, res: Response) => {
  const heartbeats = await prisma.agentHeartbeat.findMany({
    include: { product: { select: { id: true, slug: true, name: true, status: true } } },
    orderBy: { updatedAt: "desc" },
  });
  res.json({ heartbeats });
});

router.post("/run", requireRole("owner", "editor"), async (_req: Request, res: Response) => {
  const results = await runCollectionNow();
  res.json({ ok: true, results });
});

router.post(
  "/run/:productId",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const result = await collectProduct(String(req.params.productId));
    res.json({ ok: true, result });
  }
);

export default router;
