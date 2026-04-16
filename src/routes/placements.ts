import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth } from "../auth/middleware";
import { addBRTDays, dateStringBRT, startOfBRTDay } from "../lib/tz";

const router = Router();
router.use(requireAuth);

const querySchema = z.object({
  productId: z.string().min(1),
  days: z.coerce.number().default(7),
});

router.get("/", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { productId, days } = parsed.data;
  const since = addBRTDays(startOfBRTDay(), -(Math.max(days, 1) - 1));

  // Agrega por (platform, position)
  const rows = await prisma.placementMetric.findMany({
    where: { productId, date: { gte: since } },
  });

  const latestBySlice = new Map<
    string,
    {
      createdAt: Date;
      platform: string;
      position: string;
      impressions: number;
      spend: number;
      clicks: number;
      conversions: number;
      cpm: number;
      cpa: number | null;
      ctr: number | null;
    }
  >();

  for (const r of rows) {
    const key = `${dateStringBRT(r.date)}|${r.campaignId || ""}|${r.adsetId || ""}|${r.platform || ""}|${r.position || ""}`;
    const existing = latestBySlice.get(key);
    if (existing && existing.createdAt >= r.createdAt) {
      continue;
    }
    latestBySlice.set(key, {
      createdAt: r.createdAt,
      platform: r.platform || "unknown",
      position: r.position || "unknown",
      impressions: r.impressions,
      spend: r.spend,
      clicks: r.clicks,
      conversions: r.conversions,
      cpm: r.cpm || 0,
      cpa: r.cpa,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : null,
    });
  }

  const byKey = new Map<
    string,
    {
      platform: string;
      position: string;
      impressions: number;
      spend: number;
      clicks: number;
      conversions: number;
      cpm: number;
      cpa: number | null;
      ctr: number | null;
    }
  >();

  for (const r of latestBySlice.values()) {
    const key = `${r.platform}|${r.position}`;
    const existing = byKey.get(key) ?? {
      platform: r.platform,
      position: r.position,
      impressions: 0,
      spend: 0,
      clicks: 0,
      conversions: 0,
      cpm: 0,
      cpa: null,
      ctr: null,
    };
    existing.impressions += r.impressions;
    existing.spend += r.spend;
    existing.clicks += r.clicks;
    existing.conversions += r.conversions;
    byKey.set(key, existing);
  }

  const placements = Array.from(byKey.values()).map(p => ({
    ...p,
    cpm: p.impressions > 0 ? (p.spend / p.impressions) * 1000 : 0,
    cpa: p.conversions > 0 ? p.spend / p.conversions : null,
    ctr: p.impressions > 0 ? (p.clicks / p.impressions) * 100 : null,
  }));

  res.json({ placements });
});

export default router;
