import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";
import { computeNetPerSale, deriveThresholds } from "../lib/product-economics";
import { executeEmergencyStop } from "../services/emergency-stop";

const router = Router();

router.use(requireAuth);

const stageEnum = z.enum(["launch", "evergreen", "escalavel", "nicho"]);
const statusEnum = z.enum(["active", "paused", "archived"]);

const createSchema = z.object({
  slug: z.string().min(2).regex(/^[a-z0-9-]+$/, "lowercase letters, numbers, hyphens only"),
  name: z.string().min(1),
  description: z.string().optional(),
  stage: stageEnum.default("launch"),

  priceGross: z.number().positive(),
  gatewayFeeRate: z.number().min(0).max(1).default(0.035),
  netPerSale: z.number().positive().optional(),
  mentoriaUpsellValue: z.number().positive().optional(),
  mentoriaUpsellRate: z.number().min(0).max(1).optional(),

  dailyBudgetTarget: z.number().positive(),
  dailyBudgetFloor: z.number().positive().optional(),
  dailyBudgetCap: z.number().positive().optional(),
  pacingStrategy: z.enum(["even", "front-loaded"]).default("even"),

  metaPixelId: z.string().optional(),
  metaPageId: z.string().optional(),
  metaAudienceBuyersId: z.string().optional(),

  kirvanoProductId: z.string().min(1),

  landingUrl: z.string().url(),
  defaultHeadline: z.string().min(1),
  defaultDescription: z.string().optional(),
  defaultCTA: z.string().default("LEARN_MORE"),
  utmNaming: z.string().optional(),

  supervisedMode: z.boolean().default(false),
  autoActivate: z.boolean().default(false),
});

const updateSchema = createSchema.partial().extend({
  status: statusEnum.optional(),
  supervisedMode: z.boolean().optional(),
  autoActivate: z.boolean().optional(),
});

// GET / — lista todos os produtos (pra sidebar)
router.get("/", async (_req: Request, res: Response) => {
  const products = await prisma.product.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      stage: true,
      dailyBudgetTarget: true,
      supervisedMode: true,
      createdAt: true,
    },
  });
  res.json({ products });
});

// GET /:id — produto completo + automation config
router.get("/:id", async (req: Request, res: Response) => {
  const product = await prisma.product.findUnique({
    where: { id: String(req.params.id) },
    include: { automationConfig: true },
  });
  if (!product) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ product });
});

// POST / — cria produto + deriva automation config a partir da economia
router.post("/", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;

  const netPerSale = data.netPerSale ?? computeNetPerSale(data.priceGross, data.gatewayFeeRate);
  const dailyBudgetFloor = data.dailyBudgetFloor ?? Math.max(data.dailyBudgetTarget * 0.5, 50);
  const dailyBudgetCap = data.dailyBudgetCap ?? data.dailyBudgetTarget * 2;

  const thresholds = deriveThresholds({
    priceGross: data.priceGross,
    gatewayFeeRate: data.gatewayFeeRate,
    netPerSale,
    dailyBudgetTarget: data.dailyBudgetTarget,
    stage: data.stage,
  });

  try {
    const product = await prisma.product.create({
      data: {
        slug: data.slug,
        name: data.name,
        description: data.description,
        stage: data.stage,
        priceGross: data.priceGross,
        gatewayFeeRate: data.gatewayFeeRate,
        netPerSale,
        mentoriaUpsellValue: data.mentoriaUpsellValue,
        mentoriaUpsellRate: data.mentoriaUpsellRate,
        dailyBudgetTarget: data.dailyBudgetTarget,
        dailyBudgetFloor,
        dailyBudgetCap,
        pacingStrategy: data.pacingStrategy,
        metaPixelId: data.metaPixelId,
        metaPageId: data.metaPageId,
        metaAudienceBuyersId: data.metaAudienceBuyersId,
        kirvanoProductId: data.kirvanoProductId,
        landingUrl: data.landingUrl,
        defaultHeadline: data.defaultHeadline,
        defaultDescription: data.defaultDescription,
        defaultCTA: data.defaultCTA,
        utmNaming: data.utmNaming,
        supervisedMode: data.supervisedMode,
        autoActivate: data.autoActivate,
        automationConfig: {
          create: {
            breakevenCPA: thresholds.breakevenCPA,
            autoScaleCPAThreshold: thresholds.autoScaleCPAThreshold,
            autoScaleMinDays: thresholds.autoScaleMinDays,
            autoScaleMaxBudget: thresholds.autoScaleMaxBudget,
            cpaPauseThreshold: thresholds.cpaPauseThreshold,
            budgetCapProspection: thresholds.budgetCapProspection,
            budgetCapRemarketing: thresholds.budgetCapRemarketing,
            budgetCapASC: thresholds.budgetCapASC,
            budgetFloorProspection: thresholds.budgetFloorProspection,
            budgetFloorRemarketing: thresholds.budgetFloorRemarketing,
            autoPauseSpendLimit: thresholds.autoPauseSpendLimit,
            frequencyLimitProspection: thresholds.frequencyLimitProspection,
            frequencyLimitRemarketing: thresholds.frequencyLimitRemarketing,
            daypartingEnabled: thresholds.daypartingEnabled,
            autoScalePercent: thresholds.autoScalePercent,
            breakevenMinDays: thresholds.breakevenMinDays,
          },
        },
      },
      include: { automationConfig: true },
    });
    res.status(201).json({ product });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Unique")) {
      res.status(409).json({ error: "conflict", message });
      return;
    }
    res.status(500).json({ error: "internal", message });
  }
});

// PATCH /:id — atualiza produto (automation config sobrescrita manual é rota separada depois)
router.patch("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }
  try {
    const product = await prisma.product.update({
      where: { id: String(req.params.id) },
      data: parsed.data,
      include: { automationConfig: true },
    });
    res.json({ product });
  } catch (err) {
    res.status(404).json({ error: "not_found" });
  }
});

// PATCH /:id/automation-config — editar thresholds manualmente
const automationConfigSchema = z
  .object({
    autoPauseNoSales: z.boolean(),
    autoPauseSpendLimit: z.number().positive(),
    autoPauseBreakeven: z.boolean(),
    breakevenCPA: z.number().positive(),
    breakevenMinDays: z.number().int().min(1),
    autoScaleWinners: z.boolean(),
    autoScaleCPAThreshold: z.number().positive(),
    autoScalePercent: z.number().positive(),
    autoScaleMinDays: z.number().int().min(1),
    autoScaleMaxBudget: z.number().positive(),
    respectLearningPhase: z.boolean(),
    learningPhaseHours: z.number().int().min(1),
    autoRotateCreatives: z.boolean(),
    cpaPauseThreshold: z.number().positive(),
    notifyOnAutoAction: z.boolean(),
    autoPauseFrequency: z.boolean(),
    frequencyLimitProspection: z.number().positive(),
    frequencyLimitRemarketing: z.number().positive(),
    budgetCapProspection: z.number().positive(),
    budgetCapRemarketing: z.number().positive(),
    budgetCapASC: z.number().positive(),
    budgetFloorProspection: z.number().positive(),
    budgetFloorRemarketing: z.number().positive(),
    daypartingEnabled: z.boolean(),
  })
  .partial();

router.patch(
  "/:id/automation-config",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const parsed = automationConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
      return;
    }
    try {
      const cfg = await prisma.productAutomationConfig.update({
        where: { productId: String(req.params.id) },
        data: parsed.data,
      });
      res.json({ automationConfig: cfg });
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  }
);

// DELETE /:id — arquiva (soft delete via status)
router.delete("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  try {
    await prisma.product.update({
      where: { id: String(req.params.id) },
      data: { status: "archived" },
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: "not_found" });
  }
});

// POST /:id/emergency-stop — Freio de Mão.
// Liga supervisedMode + pausa todas campanhas whitelisted no Meta + log + WhatsApp.
router.post(
  "/:id/emergency-stop",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    try {
      const result = await executeEmergencyStop(
        String(req.params.id),
        req.user?.email
      );
      res.json(result);
    } catch (err) {
      console.error(`[products] emergency-stop falhou:`, err);
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  }
);

export default router;
