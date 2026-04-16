import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth } from "../auth/middleware";
import { brtRangeFromStrings } from "../lib/tz";

const router = Router();
router.use(requireAuth);

const querySchema = z.object({
  productId: z.string().min(1),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  status: z.string().optional(),
});

router.get("/", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { productId, dateFrom, dateTo, status } = parsed.data;

  const where: any = { productId };
  if (status) where.status = status;
  if (dateFrom || dateTo) {
    where.date = brtRangeFromStrings(dateFrom, dateTo);
  }

  const sales = await prisma.sale.findMany({
    where,
    orderBy: { date: "desc" },
    take: 500,
  });

  res.json({ sales });
});

router.get("/summary", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { productId, dateFrom, dateTo } = parsed.data;

  const where: any = { productId, status: "approved" };
  if (dateFrom || dateTo) {
    where.date = brtRangeFromStrings(dateFrom, dateTo);
  }

  const agg = await prisma.sale.aggregate({
    where,
    _sum: { amountGross: true, amountNet: true },
    _count: true,
  });

  res.json({
    summary: {
      totalSales: agg._count,
      totalGross: agg._sum.amountGross || 0,
      totalNet: agg._sum.amountNet || 0,
      avgPrice: agg._count > 0 ? (agg._sum.amountGross || 0) / agg._count : 0,
    },
  });
});

export default router;
