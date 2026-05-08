// Pacing mensal (Pedro Sobral): "estamos no dia 20, meta 100 vendas, fizemos 55 —
// preciso de 45 em 10 dias = 4.5/dia". O agente usa pra ajustar threshold de
// scale dinamicamente: atrás da meta = relaxa (escala mais cedo), adiante = aperta.
//
// MonthlyGoal já existe no schema; este lib agrega current vs target por mes.

import prisma from "../prisma";

export interface MonthlyPace {
  month: string;            // YYYY-MM
  dayOfMonth: number;        // 1-31
  daysInMonth: number;       // 28-31
  daysLeft: number;          // daysInMonth - dayOfMonth
  // Meta:
  targetSales: number | null;
  targetProfit: number | null;
  targetCpa: number | null;
  targetRoas: number | null;
  // Atual:
  currentSales: number;
  currentProfit: number;
  currentSpend: number;
  // Pacing:
  pace: number | null;             // projecao linear (currentSales / dayOfMonth) * daysInMonth
  paceRatio: number | null;        // pace / targetSales
  requiredDailySales: number | null; // pra fechar a meta nos dias restantes
  status: "no_goal" | "ahead" | "on_track" | "behind" | "critical";
  scaleThresholdAdjust: number;    // multiplier pra autoScaleCPAThreshold (1.0 default)
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
}
function startOfNextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0);
}

export async function getMonthlyPace(productId: string): Promise<MonthlyPace> {
  const now = new Date();
  const monthStr = now.toISOString().slice(0, 7);
  const dayOfMonth = now.getDate();
  const monthStart = startOfMonth(now);
  const nextMonthStart = startOfNextMonth(now);
  const daysInMonth = Math.round(
    (nextMonthStart.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)
  );
  const daysLeft = daysInMonth - dayOfMonth;

  const [goal, salesAgg, metricsAgg] = await Promise.all([
    prisma.monthlyGoal.findUnique({
      where: { productId_month: { productId, month: monthStr } },
    }),
    prisma.sale.aggregate({
      where: {
        productId,
        status: "approved",
        date: { gte: monthStart, lt: nextMonthStart },
      },
      _sum: { amountNet: true },
      _count: true,
    }),
    prisma.metricEntry.aggregate({
      where: { productId, date: { gte: monthStart, lt: nextMonthStart } },
      _sum: { investment: true },
    }),
  ]);

  const currentSales = salesAgg._count || 0;
  const currentRevenue = salesAgg._sum.amountNet || 0;
  const currentSpend = metricsAgg._sum.investment || 0;
  const currentProfit = currentRevenue - currentSpend;

  if (!goal) {
    return {
      month: monthStr,
      dayOfMonth,
      daysInMonth,
      daysLeft,
      targetSales: null,
      targetProfit: null,
      targetCpa: null,
      targetRoas: null,
      currentSales,
      currentProfit,
      currentSpend,
      pace: null,
      paceRatio: null,
      requiredDailySales: null,
      status: "no_goal",
      scaleThresholdAdjust: 1.0,
    };
  }

  // Pace linear: assume velocidade atual ate fim do mes.
  const pace =
    dayOfMonth > 0 ? Math.round((currentSales / dayOfMonth) * daysInMonth) : null;
  const paceRatio =
    pace !== null && goal.targetSales > 0 ? pace / goal.targetSales : null;
  const remainingSales = Math.max(0, goal.targetSales - currentSales);
  const requiredDailySales =
    daysLeft > 0 ? Math.ceil((remainingSales / daysLeft) * 100) / 100 : null;

  // Status:
  //   critical: < 60% do pace ou < 50% da meta no dia 25+
  //   behind: 60-85%
  //   on_track: 85-115%
  //   ahead: > 115%
  let status: MonthlyPace["status"];
  if (paceRatio === null) status = "no_goal";
  else if (paceRatio >= 1.15) status = "ahead";
  else if (paceRatio >= 0.85) status = "on_track";
  else if (paceRatio >= 0.6) status = "behind";
  else status = "critical";

  // Ajuste do threshold de scale do auto-executor:
  // - critical/behind: subir threshold (escalar mais cedo, aceitar CPA mais alto)
  // - ahead: descer threshold (apertar, conservar capital)
  // - on_track / no_goal: manter
  // Boundary: nunca aumentar > 1.20x ou diminuir < 0.85x (evita over-correction).
  const scaleThresholdAdjust =
    status === "critical"
      ? 1.20
      : status === "behind"
        ? 1.10
        : status === "ahead"
          ? 0.90
          : 1.0;

  return {
    month: monthStr,
    dayOfMonth,
    daysInMonth,
    daysLeft,
    targetSales: goal.targetSales,
    targetProfit: goal.targetProfit,
    targetCpa: goal.targetCpa,
    targetRoas: goal.targetRoas,
    currentSales,
    currentProfit: Math.round(currentProfit * 100) / 100,
    currentSpend: Math.round(currentSpend * 100) / 100,
    pace,
    paceRatio: paceRatio !== null ? Math.round(paceRatio * 100) / 100 : null,
    requiredDailySales,
    status,
    scaleThresholdAdjust,
  };
}
