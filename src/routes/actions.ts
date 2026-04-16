// Actions log — feed de decisões do agente por produto.
// Isso é o "trading journal" que o user audita.

import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth } from "../auth/middleware";
import { addBRTDays, startOfBRTDay } from "../lib/tz";

const router = Router();
router.use(requireAuth);

const querySchema = z.object({
  productId: z.string().min(1),
  action: z.string().optional(),
  entityType: z.string().optional(),
  limit: z.coerce.number().default(100),
  offset: z.coerce.number().default(0),
});

router.get("/", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { productId, action, entityType, limit, offset } = parsed.data;

  const where: any = { productId };
  if (action) where.action = { contains: action };
  if (entityType) where.entityType = entityType;

  const [logs, total] = await Promise.all([
    prisma.actionLog.findMany({
      where,
      orderBy: { executedAt: "desc" },
      skip: offset,
      take: Math.min(limit, 500),
    }),
    prisma.actionLog.count({ where }),
  ]);

  res.json({ actions: logs, total });
});

// Agregados por tipo de ação (pros charts)
router.get("/summary", async (req: Request, res: Response) => {
  const productId = String(req.query.productId || "");
  if (!productId) {
    res.status(400).json({ error: "productId required" });
    return;
  }
  const days = Number(req.query.days || 7);
  const since = addBRTDays(startOfBRTDay(), -(Math.max(days, 1) - 1));

  const grouped = await prisma.actionLog.groupBy({
    by: ["action"],
    where: { productId, executedAt: { gte: since } },
    _count: true,
    orderBy: { _count: { action: "desc" } },
  });

  res.json({ summary: grouped.map(g => ({ action: g.action, count: g._count })) });
});

export default router;
