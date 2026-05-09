// Resolve `outcome` de ActionLog 24h após a ação ter sido executada.
//
// Antes este job não existia: ActionLog.outcome ficava sempre null e o
// trading journal entregava só reasoning, sem efeito real medido.
//
// Heurística simples (suficiente pra MVP):
//   • auto_pause_*: spend evitado = média_diária_7d_anterior × dias_desde_pause
//     (limitado a 7d pra não inflar demais; baseline volátil)
//   • auto_scale (up): cpa_pos_24h vs cpa_pre_7d → ratio (delta de eficiência)
//   • auto_scale_down / auto_scale_skipped_cooldown: igual scale
//
// Janela: pega ações com outcome=null E executedAt entre [agora-7d, agora-24h].
// Limita 100 por execução. Idempotente (só preenche se outcome=null ainda).

import { Prisma } from "@prisma/client";
import prisma from "../prisma";
import { attachOutcome } from "./action-log";

const HOURS_24 = 24 * 60 * 60 * 1000;
const DAYS_7 = 7 * 24 * 60 * 60 * 1000;

const PAUSE_ACTIONS = new Set([
  "auto_pause_no_sales",
  "auto_pause_breakeven",
  "auto_pause_frequency",
  "auto_pause_asc",
  "emergency_budget_pause",
  "soft_budget_pause",
]);

const SCALE_ACTIONS = new Set(["auto_scale", "auto_scale_down"]);

export async function resolvePendingOutcomes(): Promise<{
  resolved: number;
  errors: number;
}> {
  const now = Date.now();
  const minAge = new Date(now - HOURS_24);
  const maxAge = new Date(now - DAYS_7);

  const pending = await prisma.actionLog.findMany({
    where: {
      outcome: { equals: Prisma.JsonNull },
      executedAt: { gte: maxAge, lte: minAge },
      action: { in: [...PAUSE_ACTIONS, ...SCALE_ACTIONS] },
    },
    take: 100,
    orderBy: { executedAt: "asc" },
  });

  let resolved = 0;
  let errors = 0;

  for (const a of pending) {
    try {
      const outcome = PAUSE_ACTIONS.has(a.action)
        ? await measurePauseOutcome(a)
        : await measureScaleOutcome(a);
      if (outcome) {
        await attachOutcome(a.id, outcome);
        resolved++;
      }
    } catch (err) {
      errors++;
      console.warn(
        `[outcome-resolver] action=${a.id} falhou: ${(err as Error).message}`,
      );
    }
  }

  if (resolved > 0) {
    console.log(`[outcome-resolver] ${resolved} outcomes preenchidos`);
  }
  return { resolved, errors };
}

async function measurePauseOutcome(action: { productId: string; executedAt: Date }) {
  const before7d = new Date(action.executedAt.getTime() - DAYS_7);
  const agg = await prisma.metricEntry.aggregate({
    where: {
      productId: action.productId,
      date: { gte: before7d, lt: action.executedAt },
    },
    _avg: { investment: true },
    _sum: { investment: true },
  });
  const dailyAvgBefore = agg._avg.investment ?? 0;
  const totalBefore = agg._sum.investment ?? 0;
  const hoursSince = (Date.now() - action.executedAt.getTime()) / (60 * 60 * 1000);
  const daysCounted = Math.min(7, hoursSince / 24);
  const savedSpendBRL = Math.round(dailyAvgBefore * daysCounted * 100) / 100;
  return {
    type: "pause",
    measuredAfterHours: Math.round(hoursSince),
    dailyAvgBefore: Math.round(dailyAvgBefore * 100) / 100,
    totalBefore: Math.round(totalBefore * 100) / 100,
    savedSpendBRL,
  };
}

async function measureScaleOutcome(action: { productId: string; executedAt: Date }) {
  const before7d = new Date(action.executedAt.getTime() - DAYS_7);
  const after24h = new Date(action.executedAt.getTime() + HOURS_24);

  const [aggBefore, aggAfter] = await Promise.all([
    prisma.metricEntry.aggregate({
      where: {
        productId: action.productId,
        date: { gte: before7d, lt: action.executedAt },
      },
      _sum: { investment: true, sales: true },
    }),
    prisma.metricEntry.aggregate({
      where: {
        productId: action.productId,
        date: { gte: action.executedAt, lt: after24h },
      },
      _sum: { investment: true, sales: true },
    }),
  ]);

  const spendBefore = aggBefore._sum.investment ?? 0;
  const salesBefore = aggBefore._sum.sales ?? 0;
  const spendAfter = aggAfter._sum.investment ?? 0;
  const salesAfter = aggAfter._sum.sales ?? 0;

  const cpaBefore = salesBefore > 0 ? spendBefore / salesBefore : null;
  const cpaAfter = salesAfter > 0 ? spendAfter / salesAfter : null;

  let cpaDeltaPct: number | null = null;
  if (cpaBefore && cpaBefore > 0 && cpaAfter !== null) {
    cpaDeltaPct = Math.round(((cpaAfter - cpaBefore) / cpaBefore) * 1000) / 10;
  }

  return {
    type: "scale",
    measuredAfterHours: 24,
    cpaBefore: cpaBefore ? Math.round(cpaBefore * 100) / 100 : null,
    cpaAfter: cpaAfter ? Math.round(cpaAfter * 100) / 100 : null,
    cpaDeltaPct,
    salesAfter,
    spendAfter: Math.round(spendAfter * 100) / 100,
  };
}
