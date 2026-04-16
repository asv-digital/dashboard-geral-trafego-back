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
  campaignId: z.string().optional(),
});

router.get("/", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { productId, dateFrom, dateTo, campaignId } = parsed.data;

  const where: any = { productId };
  if (campaignId) where.campaignId = campaignId;
  if (dateFrom || dateTo) {
    where.date = brtRangeFromStrings(dateFrom, dateTo);
  }

  const metrics = await prisma.metricEntry.findMany({
    where,
    orderBy: { date: "desc" },
    take: 500,
    include: { campaign: { select: { name: true, type: true } } },
  });

  res.json({ metrics });
});

router.get("/overview", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { productId, dateFrom, dateTo } = parsed.data;

  const where: any = { productId };
  if (dateFrom || dateTo) {
    where.date = brtRangeFromStrings(dateFrom, dateTo);
  }

  const agg = await prisma.metricEntry.aggregate({
    where,
    _sum: { investment: true, impressions: true, clicks: true, sales: true },
    _avg: { frequency: true, hookRate: true, outboundCtr: true },
  });

  const salesWhere: Record<string, unknown> = { productId, status: "approved" };
  if (dateFrom || dateTo) {
    salesWhere.date = brtRangeFromStrings(dateFrom, dateTo);
  }

  const salesAgg = await prisma.sale.aggregate({
    where: salesWhere,
    _sum: { amountNet: true },
    _count: true,
  });

  const totalSales = salesAgg._count || 0;
  const totalSpend = agg._sum.investment || 0;
  const totalRevenue = salesAgg._sum.amountNet || 0;
  const impressions = agg._sum.impressions || 0;
  const clicks = agg._sum.clicks || 0;

  res.json({
    overview: {
      totalSpend,
      totalSales,
      totalRevenue,
      avgCpa: totalSales > 0 ? totalSpend / totalSales : null,
      avgRoas: totalSpend > 0 ? totalRevenue / totalSpend : null,
      avgCtr: impressions > 0 ? (clicks / impressions) * 100 : null,
      avgCpm: impressions > 0 ? (totalSpend / impressions) * 1000 : null,
      avgFrequency: agg._avg.frequency || null,
      hookRate: agg._avg.hookRate || null,
      outboundCtr: agg._avg.outboundCtr || null,
      impressions,
      clicks,
    },
  });
});

export default router;
