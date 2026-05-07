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
    // Estados:
    //   ok=true  → sucesso total → 200 + result
    //   ok=false sem nada criado → falha total → 400 + result
    //   ok=false com algo criado → partial → 200 + { ...result, partial: true }
    // (M9: trocado 207 Multi-Status por 200+partial flag — frontends genericos
    //  presumem 2xx=ok e 4xx=fail; 207 caia silenciosamente em sucesso.)
    if (!result.ok && (!result.created || result.created.length === 0)) {
      res.status(400).json(result);
      return;
    }
    if (!result.ok) {
      res.json({ ...result, partial: true });
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
