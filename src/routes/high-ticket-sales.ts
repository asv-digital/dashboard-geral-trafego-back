import { Router, Request, Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware";
import {
  listHighTicketSales,
  createHighTicketSale,
  deleteHighTicketSale,
  syncHighTicketSales,
  getHighTicketSummary,
} from "../services/high-ticket-sales";

const router = Router();
router.use(requireAuth);

const createSchema = z.object({
  customerEmail: z.string().email(),
  amountGross: z.number().positive(),
  saleDate: z.string().datetime().or(z.string().refine(s => !isNaN(Date.parse(s)))),
  notes: z.string().max(500).optional(),
});

// GET /api/products/:productId/high-ticket-sales?days=90
router.get("/:productId/high-ticket-sales", async (req: Request, res: Response) => {
  const days = parseDaysParam(req.query.days, 90);
  const items = await listHighTicketSales(String(req.params.productId), days);
  res.json({ items });
});

router.get(
  "/:productId/high-ticket-sales/summary",
  async (req: Request, res: Response) => {
    const days = parseDaysParam(req.query.days, 90);
    const summary = await getHighTicketSummary(String(req.params.productId), days);
    res.json(summary);
  }
);

// POST /api/products/:productId/high-ticket-sales
router.post(
  "/:productId/high-ticket-sales",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
      return;
    }
    try {
      const sale = await createHighTicketSale(String(req.params.productId), {
        customerEmail: parsed.data.customerEmail,
        amountGross: parsed.data.amountGross,
        saleDate: new Date(parsed.data.saleDate),
        notes: parsed.data.notes,
      });
      res.status(201).json(sale);
    } catch (err) {
      console.error(`[high-ticket-sales] create error:`, err);
      res.status(500).json({ error: "internal" });
    }
  }
);

// DELETE /api/products/:productId/high-ticket-sales/:id
router.delete(
  "/:productId/high-ticket-sales/:id",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    try {
      await deleteHighTicketSale(String(req.params.id));
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: "not_found" });
    }
  }
);

// POST /api/products/:productId/high-ticket-sales/sync
router.post(
  "/:productId/high-ticket-sales/sync",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const result = await syncHighTicketSales(String(req.params.productId));
    res.json(result);
  }
);

function parseDaysParam(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), 365);
}

export default router;
