// Analytics elite-grade endpoints. Todos exigem auth.
// Funcoes em src/services/analytics.ts.

import { Router, Request, Response } from "express";
import { requireAuth } from "../auth/middleware";
import {
  getCreativeHitRate,
  getProfitWaterfall,
  getPaybackCohort,
  getLtvCohort,
  getAwarenessAnalytics,
} from "../services/analytics";

const router = Router();
router.use(requireAuth);

function parseDays(value: unknown, fallback: number, max = 180): number {
  const n = typeof value === "string" ? parseInt(value, 10) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(1, Math.floor(n)), max);
}

router.get("/hit-rate/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 30);
  const result = await getCreativeHitRate(String(req.params.productId), days);
  res.json(result);
});

router.get("/profit-waterfall/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 7, 90);
  const result = await getProfitWaterfall(String(req.params.productId), days);
  res.json(result);
});

router.get("/payback-cohort/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 30, 90);
  const result = await getPaybackCohort(String(req.params.productId), days);
  res.json(result);
});

router.get("/ltv-cohort/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 90, 180);
  const result = await getLtvCohort(String(req.params.productId), days);
  res.json(result);
});

router.get("/awareness/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 30, 90);
  const result = await getAwarenessAnalytics(String(req.params.productId), days);
  res.json(result);
});

export default router;
