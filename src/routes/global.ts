// Rotas globais — agregados cross-product (visão CEO).

import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";
import { clearAccountStatusCache } from "../lib/meta-account";
import { clearRuntimeConfigCache } from "../lib/runtime-config";
import { addBRTDays, startOfBRTDay } from "../lib/tz";

const router = Router();
router.use(requireAuth);

const globalSettingsSchema = z.object({
  metaAccessToken: z.string().nullable().optional(),
  metaTokenCreatedAt: z.string().nullable().optional(),
  metaAdAccountId: z.string().nullable().optional(),
  metaAppId: z.string().nullable().optional(),
  metaAppSecret: z.string().nullable().optional(),
  metaPixelId: z.string().nullable().optional(),
  metaPageId: z.string().nullable().optional(),
  metaAudienceBuyersId: z.string().nullable().optional(),
  metaAudienceWarmId: z.string().nullable().optional(),
  metaAudienceWarmName: z.string().nullable().optional(),
  kirvanoWebhookToken: z.string().nullable().optional(),
  anthropicApiKey: z.string().nullable().optional(),
});

function normalizeOptionalString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

router.get("/settings", requireRole("owner"), async (_req: Request, res: Response) => {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: "singleton" },
  });
  res.json({ settings });
});

router.put("/settings", requireRole("owner"), async (req: Request, res: Response) => {
  const parsed = globalSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }

  const metaTokenCreatedAtRaw = normalizeOptionalString(parsed.data.metaTokenCreatedAt);
  let metaTokenCreatedAt: Date | null | undefined = undefined;
  if (metaTokenCreatedAtRaw !== undefined) {
    metaTokenCreatedAt = metaTokenCreatedAtRaw ? new Date(metaTokenCreatedAtRaw) : null;
    if (metaTokenCreatedAt && Number.isNaN(metaTokenCreatedAt.getTime())) {
      res.status(400).json({ error: "invalid_input", details: ["metaTokenCreatedAt"] });
      return;
    }
  }

  const data = {
    metaAccessToken: normalizeOptionalString(parsed.data.metaAccessToken),
    metaTokenCreatedAt,
    metaAdAccountId: normalizeOptionalString(parsed.data.metaAdAccountId),
    metaAppId: normalizeOptionalString(parsed.data.metaAppId),
    metaAppSecret: normalizeOptionalString(parsed.data.metaAppSecret),
    metaPixelId: normalizeOptionalString(parsed.data.metaPixelId),
    metaPageId: normalizeOptionalString(parsed.data.metaPageId),
    metaAudienceBuyersId: normalizeOptionalString(parsed.data.metaAudienceBuyersId),
    metaAudienceWarmId: normalizeOptionalString(parsed.data.metaAudienceWarmId),
    metaAudienceWarmName: normalizeOptionalString(parsed.data.metaAudienceWarmName),
    kirvanoWebhookToken: normalizeOptionalString(parsed.data.kirvanoWebhookToken),
    anthropicApiKey: normalizeOptionalString(parsed.data.anthropicApiKey),
  };

  const settings = await prisma.globalSettings.upsert({
    where: { id: "singleton" },
    create: {
      id: "singleton",
      ...data,
    },
    update: data,
  });

  clearRuntimeConfigCache("global");
  clearAccountStatusCache();
  res.json({ settings });
});

router.get("/pnl", async (req: Request, res: Response) => {
  const days = Number(req.query.days || 7);
  const since = addBRTDays(startOfBRTDay(), -(Math.max(days, 1) - 1));

  const products = await prisma.product.findMany({
    where: { status: "active" },
    include: {
      _count: { select: { sales: true } },
    },
  });

  const rows = await Promise.all(
    products.map(async p => {
      const metricsAgg = await prisma.metricEntry.aggregate({
        where: { productId: p.id, date: { gte: since } },
        _sum: { investment: true, sales: true },
      });
      const salesAgg = await prisma.sale.aggregate({
        where: {
          productId: p.id,
          status: "approved",
          date: { gte: since },
        },
        _sum: { amountGross: true, amountNet: true },
        _count: true,
      });

      const spend = metricsAgg._sum.investment || 0;
      const salesCount = salesAgg._count || 0;
      const revenue = salesAgg._sum.amountNet || 0;
      const grossRevenue = salesAgg._sum.amountGross || 0;
      const profit = revenue - spend;
      const cpa = salesCount > 0 ? spend / salesCount : 0;
      const roas = spend > 0 ? revenue / spend : 0;

      return {
        productId: p.id,
        slug: p.slug,
        name: p.name,
        status: p.status,
        stage: p.stage,
        dailyBudgetTarget: p.dailyBudgetTarget,
        spend,
        salesCount,
        revenue,
        grossRevenue,
        profit,
        cpa,
        roas,
      };
    })
  );

  const totals = rows.reduce(
    (acc, r) => ({
      spend: acc.spend + r.spend,
      sales: acc.sales + r.salesCount,
      revenue: acc.revenue + r.revenue,
      profit: acc.profit + r.profit,
    }),
    { spend: 0, sales: 0, revenue: 0, profit: 0 }
  );

  res.json({ days, products: rows, totals });
});

router.get("/activity", async (_req: Request, res: Response) => {
  const logs = await prisma.actionLog.findMany({
    orderBy: { executedAt: "desc" },
    take: 50,
    include: { product: { select: { slug: true, name: true } } },
  });
  res.json({ activity: logs });
});

router.get("/heartbeats", async (_req: Request, res: Response) => {
  const heartbeats = await prisma.agentHeartbeat.findMany({
    include: {
      product: {
        select: { id: true, slug: true, name: true, status: true },
      },
    },
  });
  res.json({ heartbeats });
});

export default router;
