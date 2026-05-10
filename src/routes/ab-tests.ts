// Rotas A/B test manuais. Permite gestor abrir teste explícito entre 2 ads
// (variantA, variantB) num adset. Resolver automatizado roda no scheduler
// (services/ab-test-resolver.ts).

import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";

const router = Router();
router.use(requireAuth);

const variantSchema = z.object({
  name: z.string().min(1).max(80),
  metaAdId: z.string().min(1),
});

const createSchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(3).max(120),
  adsetId: z.string().min(1),
  variantA: variantSchema,
  variantB: variantSchema,
  minDays: z.number().int().min(1).max(30).default(5),
  minSpendPerVariant: z.number().positive().default(100),
});

// GET /ab-tests?productId=...&status=running
router.get("/", async (req: Request, res: Response) => {
  const productId = String(req.query.productId || "");
  if (!productId) {
    res.status(400).json({ error: "missing_productId" });
    return;
  }
  const status = req.query.status ? String(req.query.status) : undefined;
  const tests = await prisma.creativeTest.findMany({
    where: { productId, ...(status ? { status } : {}) },
    orderBy: { startDate: "desc" },
    take: 100,
  });
  res.json({ tests });
});

// POST /ab-tests — abre novo teste
router.post("/", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", issues: parsed.error.format() });
    return;
  }
  const data = parsed.data;
  if (data.variantA.metaAdId === data.variantB.metaAdId) {
    res.status(400).json({ error: "variants_must_differ" });
    return;
  }
  // Sanity: produto existe?
  const product = await prisma.product.findUnique({ where: { id: data.productId } });
  if (!product) {
    res.status(404).json({ error: "product_not_found" });
    return;
  }
  // Sanity: já tem teste running pro mesmo adset?
  const existing = await prisma.creativeTest.findFirst({
    where: { productId: data.productId, adsetId: data.adsetId, status: "running" },
  });
  if (existing) {
    res.status(409).json({ error: "test_already_running", existingId: existing.id });
    return;
  }
  const test = await prisma.creativeTest.create({
    data: {
      productId: data.productId,
      name: data.name,
      adsetId: data.adsetId,
      variantA: data.variantA,
      variantB: data.variantB,
      minDays: data.minDays,
      minSpendPerVariant: data.minSpendPerVariant,
      startDate: new Date(),
      status: "running",
    },
  });
  res.status(201).json({ test });
});

// DELETE /ab-tests/:id — cancela teste (sem decidir winner)
router.delete("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const test = await prisma.creativeTest.findUnique({ where: { id } });
  if (!test) {
    res.status(404).json({ error: "test_not_found" });
    return;
  }
  await prisma.creativeTest.update({
    where: { id },
    data: { status: "cancelled", endDate: new Date() },
  });
  res.json({ ok: true });
});

export default router;
