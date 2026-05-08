// Analytics elite-grade endpoints. Todos exigem auth.
// Funcoes em src/services/analytics.ts.

import { Router, Request, Response } from "express";
import { requireAuth, requireRole } from "../auth/middleware";
import {
  getCreativeHitRate,
  getProfitWaterfall,
  getPaybackCohort,
  getLtvCohort,
  getAwarenessAnalytics,
  getCreativeVolumeScore,
  getFatiguePredictions,
  getCpaElasticity,
  getDecisionQueue,
  getTimeseries,
  getBriefing,
  getGlobalOverview,
  getAwarenessMismatches,
  getCeoReport,
  type TimeseriesMetric,
} from "../services/analytics";
import { getMonthlyPace } from "../lib/monthly-pace";
import { classifyAwarenessForProduct } from "../services/awareness-classifier";

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

// Onda 2 — endpoints elite-grade
router.get("/volume-score/:productId", async (req: Request, res: Response) => {
  const result = await getCreativeVolumeScore(String(req.params.productId));
  res.json(result);
});

router.get("/fatigue/:productId", async (req: Request, res: Response) => {
  const result = await getFatiguePredictions(String(req.params.productId));
  res.json(result);
});

router.get("/elasticity/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 60, 180);
  const result = await getCpaElasticity(String(req.params.productId), days);
  res.json(result);
});

router.get("/decisions/:productId", async (req: Request, res: Response) => {
  const result = await getDecisionQueue(String(req.params.productId));
  res.json(result);
});

router.post(
  "/classify-awareness/:productId",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const result = await classifyAwarenessForProduct(String(req.params.productId));
    res.json(result);
  }
);

// Onda Visual 1
router.get("/timeseries/:productId", async (req: Request, res: Response) => {
  const validMetrics: TimeseriesMetric[] = ["cpa", "roas", "sales", "spend", "cm", "hookRate"];
  const metric = String(req.query.metric || "spend") as TimeseriesMetric;
  if (!validMetrics.includes(metric)) {
    res.status(400).json({ error: "invalid_metric", validMetrics });
    return;
  }
  const days = parseDays(req.query.days, 14, 90);
  const result = await getTimeseries(String(req.params.productId), metric, days);
  res.json(result);
});

router.get("/briefing/:productId", async (req: Request, res: Response) => {
  const force = req.query.refresh === "true";
  const result = await getBriefing(String(req.params.productId), force);
  res.json(result);
});

router.get("/global-overview", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 7, 90);
  const result = await getGlobalOverview(days);
  res.json(result);
});

// Onda Roadmap Sobral
router.get("/monthly-pace/:productId", async (req: Request, res: Response) => {
  const result = await getMonthlyPace(String(req.params.productId));
  res.json(result);
});

router.get("/awareness-mismatches/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 30, 90);
  const result = await getAwarenessMismatches(String(req.params.productId), days);
  res.json(result);
});

router.get("/report-ceo/:productId", async (req: Request, res: Response) => {
  const days = parseDays(req.query.days, 7, 90);
  const result = await getCeoReport(String(req.params.productId), days);
  res.json(result);
});

export default router;
