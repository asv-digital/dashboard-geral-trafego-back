import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";

const router = Router();
router.use(requireAuth);

router.get("/", async (req: Request, res: Response) => {
  const productId = String(req.query.productId || "");
  if (!productId) {
    res.status(400).json({ error: "productId required" });
    return;
  }
  const creatives = await prisma.creative.findMany({
    where: { productId },
    orderBy: { updatedAt: "desc" },
    include: { campaign: { select: { name: true } } },
  });
  res.json({ creatives });
});

const awarenessSchema = z
  .enum(["unaware", "problem", "solution", "product", "most_aware"])
  .nullable()
  .optional();

const createSchema = z.object({
  productId: z.string(),
  campaignId: z.string().optional(),
  name: z.string(),
  type: z.string(),
  status: z.string().default("active"),
  awarenessStage: awarenessSchema,
});

const updateSchema = z.object({
  campaignId: z.string().nullable().optional(),
  name: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  ctr: z.number().nullable().optional(),
  hookRate: z.number().nullable().optional(),
  cpa: z.number().nullable().optional(),
  thruplayRate: z.number().nullable().optional(),
  awarenessStage: awarenessSchema,
});

router.post("/", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const creative = await prisma.creative.create({ data: parsed.data });
  res.status(201).json({ creative });
});

router.patch("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }

  try {
    const creative = await prisma.creative.update({
      where: { id: String(req.params.id) },
      data: parsed.data,
    });
    res.json({ creative });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

router.delete("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  try {
    await prisma.creative.delete({ where: { id: String(req.params.id) } });
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

export default router;
