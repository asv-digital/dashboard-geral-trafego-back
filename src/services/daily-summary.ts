// Daily summary agendado pra 8:00 AM BRT.
// Por produto: calcula KPIs de ontem, conta alertas ativos, envia WhatsApp.
// Usa nextHourBRT(8) pra agendar o próximo disparo.

import prisma from "../prisma";
import { addBRTDays, nextHourBRT, startOfBRTDay } from "../lib/tz";
import { sendNotification } from "./whatsapp-notifier";
import { runSystemHealthChecks } from "./system-alerts";

const SUMMARY_HOUR_BRT = 8;

let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

interface ProductSummary {
  name: string;
  spend: string;
  sales: number;
  cpa: string;
  roas: string;
  alerts: number;
  // M5 — campos acionaveis adicionados na auditoria.
  deltaSpend: string | null; // "+12%" / "-8%" vs media 7d
  deltaSales: string | null;
  deltaCpa: string | null;
  topAdsets: string[];     // ate 3 linhas: "Adset XYZ — 4 vendas / R$45 CPA"
  topCreatives: string[];  // ate 3 linhas: "Creative ABC — hook 38% / CTR 2.1%"
  topObjection: string | null; // "preco (12 menc)" se houver
}

function pct(now: number, baseline: number): string | null {
  if (!baseline || baseline === 0) return null;
  const diff = ((now - baseline) / baseline) * 100;
  if (Math.abs(diff) < 1) return "estável";
  const sign = diff > 0 ? "+" : "";
  return `${sign}${Math.round(diff)}%`;
}

async function buildProductSummary(productId: string): Promise<ProductSummary> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return {
      name: "(?)", spend: "0", sales: 0, cpa: "—", roas: "—", alerts: 0,
      deltaSpend: null, deltaSales: null, deltaCpa: null,
      topAdsets: [], topCreatives: [], topObjection: null,
    };
  }

  // Ontem no fuso BRT
  const todayStart = startOfBRTDay();
  const yesterday = addBRTDays(todayStart, -1);
  const sevenDaysAgo = addBRTDays(todayStart, -7);

  // Ontem
  const yesterdayMetrics = await prisma.metricEntry.findMany({
    where: { productId, date: { gte: yesterday, lt: todayStart } },
  });
  const spend = yesterdayMetrics.reduce((sum, m) => sum + m.investment, 0);

  const salesAgg = await prisma.sale.aggregate({
    where: {
      productId,
      status: "approved",
      date: { gte: yesterday, lt: todayStart },
    },
    _sum: { amountNet: true },
    _count: true,
  });
  const salesCount = salesAgg._count || 0;
  const revenue = salesAgg._sum.amountNet || 0;
  const cpa = salesCount > 0 ? spend / salesCount : 0;
  const roas = spend > 0 ? revenue / spend : 0;

  // Media 7 dias anteriores (excluindo ontem)
  const baselineFrom = sevenDaysAgo;
  const baselineTo = yesterday;
  const baselineMetrics = await prisma.metricEntry.aggregate({
    where: { productId, date: { gte: baselineFrom, lt: baselineTo } },
    _sum: { investment: true },
  });
  const baselineSales = await prisma.sale.aggregate({
    where: {
      productId,
      status: "approved",
      date: { gte: baselineFrom, lt: baselineTo },
    },
    _count: true,
  });
  const baselineSpendAvg = (baselineMetrics._sum.investment || 0) / 6;
  const baselineSalesAvg = (baselineSales._count || 0) / 6;
  const baselineCpaAvg =
    baselineSalesAvg > 0 ? baselineSpendAvg / baselineSalesAvg : 0;

  const deltaSpend = pct(spend, baselineSpendAvg);
  const deltaSales = pct(salesCount, baselineSalesAvg);
  const deltaCpa = pct(cpa, baselineCpaAvg);

  // Top 3 adsets de ontem (vendedores primeiro, depois maior gasto sem venda).
  // Usa salesKirvano (autoritativo) e investment.
  const byAdset = new Map<string, { sales: number; spend: number; }>();
  for (const m of yesterdayMetrics) {
    const k = m.adSet || "(sem adset)";
    const a = byAdset.get(k) ?? { sales: 0, spend: 0 };
    a.sales += m.salesKirvano;
    a.spend += m.investment;
    byAdset.set(k, a);
  }
  const topAdsets = Array.from(byAdset.entries())
    .sort((a, b) => {
      // primeiro vendedores
      if (a[1].sales !== b[1].sales) return b[1].sales - a[1].sales;
      // depois maior gasto (loser do dia)
      return b[1].spend - a[1].spend;
    })
    .slice(0, 3)
    .map(([name, m]) => {
      const cpaA = m.sales > 0 ? `R$${(m.spend / m.sales).toFixed(0)} CPA` : "0 vendas";
      return `${name.length > 28 ? name.slice(0, 25) + "..." : name} — ${m.sales} vd / ${cpaA}`;
    });

  // Top 3 criativos pelo hookRate (creative-performance se rodou).
  const creatives = await prisma.creative.findMany({
    where: { productId, status: "active" },
    orderBy: [{ hookRate: "desc" }],
    take: 3,
  });
  const topCreatives = creatives
    .filter(c => c.hookRate !== null && c.hookRate > 0)
    .map(c => {
      const hook = c.hookRate ? `hook ${c.hookRate.toFixed(1)}%` : "hook —";
      const ctr = c.ctr ? `CTR ${c.ctr.toFixed(1)}%` : "CTR —";
      const name = c.name.length > 28 ? c.name.slice(0, 25) + "..." : c.name;
      return `${name} — ${hook} / ${ctr}`;
    });

  // Top objection do AdCommentSummary mais recente.
  const recentSummary = await prisma.adCommentSummary.findFirst({
    where: { productId, period: "7d" },
    orderBy: { analyzedAt: "desc" },
  });
  const topObjection = recentSummary?.topObjection
    ? `${recentSummary.topObjection} (${recentSummary.objectionPrice + recentSummary.objectionTrust} menc)`
    : null;

  // Conta alertas críticos ativos (edge-triggered ainda em estado ruim)
  const alerts = await prisma.alertDedup.count({
    where: { productId, lastState: "active" },
  });

  return {
    name: product.name,
    spend: spend.toFixed(2),
    sales: salesCount,
    cpa: cpa > 0 ? cpa.toFixed(2) : "—",
    roas: roas > 0 ? `${roas.toFixed(2)}x` : "—",
    alerts,
    deltaSpend,
    deltaSales,
    deltaCpa,
    topAdsets,
    topCreatives,
    topObjection,
  };
}

async function sendDailySummaries(): Promise<void> {
  // System-wide health checks (token expiry, etc) antes do summary por produto.
  await runSystemHealthChecks();

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
          deltaSpend: summary.deltaSpend,
          deltaSales: summary.deltaSales,
          deltaCpa: summary.deltaCpa,
          topAdsets: summary.topAdsets,
          topCreatives: summary.topCreatives,
          topObjection: summary.topObjection,
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
