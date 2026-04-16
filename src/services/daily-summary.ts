// Daily summary agendado pra 8:00 AM BRT.
// Por produto: calcula KPIs de ontem, conta alertas ativos, envia WhatsApp.
// Usa nextHourBRT(8) pra agendar o próximo disparo.

import prisma from "../prisma";
import { addBRTDays, nextHourBRT, startOfBRTDay } from "../lib/tz";
import { sendNotification } from "./whatsapp-notifier";

const SUMMARY_HOUR_BRT = 8;

let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

async function buildProductSummary(productId: string): Promise<{
  name: string;
  spend: string;
  sales: number;
  cpa: string;
  roas: string;
  alerts: number;
}> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return { name: "(?)", spend: "0", sales: 0, cpa: "—", roas: "—", alerts: 0 };
  }

  // Ontem no fuso BRT
  const todayStart = startOfBRTDay();
  const yesterday = addBRTDays(todayStart, -1);

  const metricsAgg = await prisma.metricEntry.aggregate({
    where: { productId, date: { gte: yesterday, lt: todayStart } },
    _sum: { investment: true },
  });
  const salesAgg = await prisma.sale.aggregate({
    where: {
      productId,
      status: "approved",
      date: { gte: yesterday, lt: todayStart },
    },
    _sum: { amountNet: true },
    _count: true,
  });

  const spend = metricsAgg._sum.investment || 0;
  const salesCount = salesAgg._count || 0;
  const revenue = salesAgg._sum.amountNet || 0;
  const cpa = salesCount > 0 ? spend / salesCount : 0;
  const roas = spend > 0 ? revenue / spend : 0;

  // Conta alertas críticos ativos (edge-triggered ainda em estado ruim)
  const alerts = await prisma.alertDedup.count({
    where: {
      productId,
      lastState: "active",
    },
  });

  return {
    name: product.name,
    spend: spend.toFixed(2),
    sales: salesCount,
    cpa: cpa > 0 ? cpa.toFixed(2) : "—",
    roas: roas > 0 ? `${roas.toFixed(2)}x` : "—",
    alerts,
  };
}

async function sendDailySummaries(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      const summary = await buildProductSummary(p.id);
      await sendNotification(
        "daily_summary",
        {
          productName: summary.name,
          spend: summary.spend,
          sales: summary.sales,
          cpa: summary.cpa,
          roas: summary.roas,
          alerts: summary.alerts > 0 ? `${summary.alerts} alerta(s) ativos` : null,
        },
        p.id
      );
    } catch (err) {
      console.error(
        `[daily-summary] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

function scheduleNextSummary(): void {
  const next = nextHourBRT(SUMMARY_HOUR_BRT);
  const delay = next.getTime() - Date.now();
  console.log(
    `[daily-summary] próximo disparo em ${next.toISOString()} (${Math.round(delay / 1000 / 60)}min)`
  );
  timeoutHandle = setTimeout(async () => {
    try {
      await sendDailySummaries();
    } catch (err) {
      console.error("[daily-summary] erro:", err);
    }
    scheduleNextSummary();
  }, delay);
}

export function startDailySummary(): void {
  if (timeoutHandle) return;
  scheduleNextSummary();
}

export function stopDailySummary(): void {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle);
    timeoutHandle = null;
  }
}

export async function runDailySummaryNow(): Promise<void> {
  await sendDailySummaries();
}
