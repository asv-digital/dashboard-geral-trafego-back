import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";

const router = Router();
router.use(requireAuth);

const productIdSchema = z.object({ productId: z.string().min(1) });

// GET / — lista campanhas de um produto
router.get("/", async (req: Request, res: Response) => {
  const parsed = productIdSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "productId required" });
    return;
  }
  const { productId } = parsed.data;

  const campaigns = await prisma.campaign.findMany({
    where: { productId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { metrics: true, creatives: true, sales: true } },
    },
  });

  // Agregados por campanha
  const enriched = await Promise.all(
    campaigns.map(async c => {
      const agg = await prisma.metricEntry.aggregate({
        where: { campaignId: c.id },
        _sum: { investment: true, impressions: true, clicks: true, sales: true },
      });
      const salesAgg = await prisma.sale.aggregate({
        where: { campaignId: c.id, status: "approved" },
        _sum: { amountNet: true },
        _count: true,
      });
      const totalInvestment = agg._sum.investment || 0;
      const totalSales = salesAgg._count || 0;
      const totalRevenue = salesAgg._sum.amountNet || 0;
      return {
        ...c,
        totalInvestment,
        totalSales,
        totalRevenue,
        cpa: totalSales > 0 ? totalInvestment / totalSales : null,
        roas: totalInvestment > 0 ? totalRevenue / totalInvestment : null,
      };
    })
  );

  res.json({ campaigns: enriched });
});

// GET /:id
router.get("/:id", async (req: Request, res: Response) => {
  const campaign = await prisma.campaign.findUnique({
    where: { id: String(req.params.id) },
    include: {
      metrics: { orderBy: { date: "desc" }, take: 30 },
      creatives: true,
    },
  });
  if (!campaign) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ campaign });
});

const createSchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  audience: z.string().optional(),
  dailyBudget: z.number().positive(),
  startDate: z.string(),
  status: z.enum(["Ativa", "Pausada", "Arquivada"]).default("Ativa"),
  metaCampaignId: z.string().optional(),
});

const updateSchema = createSchema
  .omit({ productId: true })
  .partial()
  .extend({
    startDate: z.string().optional(),
    learningPhaseEnd: z.string().optional(),
    createdInMetaAt: z.string().optional(),
    isInLearningPhase: z.boolean().optional(),
  });

router.post("/", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  try {
    const campaign = await prisma.campaign.create({
      data: {
        ...data,
        startDate: new Date(data.startDate),
      },
    });
    res.status(201).json({ campaign });
  } catch (err) {
    res.status(500).json({ error: "internal", message: (err as Error).message });
  }
});

router.patch("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }

  const data: Record<string, unknown> = { ...parsed.data };
  if (parsed.data.startDate) {
    data.startDate = new Date(parsed.data.startDate);
  }
  if (parsed.data.learningPhaseEnd) {
    data.learningPhaseEnd = new Date(parsed.data.learningPhaseEnd);
  }
  if (parsed.data.createdInMetaAt) {
    data.createdInMetaAt = new Date(parsed.data.createdInMetaAt);
  }

  try {
    const campaign = await prisma.campaign.update({
      where: { id: String(req.params.id) },
      data,
    });
    res.json({ campaign });
  } catch (err) {
    res.status(404).json({ error: "not_found" });
  }
});

router.delete("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  try {
    await prisma.campaign.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: "not_found" });
  }
});

export default router;
