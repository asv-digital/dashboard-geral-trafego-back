import { Router, Request, Response } from "express";
import { requireAuth, requireRole } from "../auth/middleware";
import { planCampaignsForProduct } from "../services/campaign-planner";
import { runDailySummaryNow } from "../services/daily-summary";

const router = Router();
router.use(requireAuth);

router.get("/preview/:productId", async (req: Request, res: Response) => {
  const result = await planCampaignsForProduct(String(req.params.productId), true);
  res.json(result);
});

router.post(
  "/commit/:productId",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const result = await planCampaignsForProduct(String(req.params.productId), false);
    if (!result.ok && (!result.created || result.created.length === 0)) {
      res.status(400).json(result);
      return;
    }
    if (!result.ok) {
      res.status(207).json(result);
      return;
    }
    res.json(result);
  }
);

router.post("/summary/now", requireRole("owner", "editor"), async (_req: Request, res: Response) => {
  await runDailySummaryNow();
  res.json({ ok: true });
});

export default router;
