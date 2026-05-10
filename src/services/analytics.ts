// Analytics elite-grade (Onda 1 — versao aprofundada).
//
// Mudancas vs versao previa:
//   - Hit rate em 3 niveis (winner/survivor/loser) + min spend + velocity + timeline mensal
//   - Profit waterfall completo (refund/chargeback/comissao/imposto/upsell + delta vs periodo anterior + profit/sale)
//   - Payback cohort por adset E por criativo + status maturity + considera upsell mentoria
//   - LTV cohort com LTV/CAC ratio + survival rate + mentoria conversion
//   - Awareness x audience type (cross-tab Prospeccao/Remarketing/ASC)

import prisma from "../prisma";
import { addBRTDays, startOfBRTDay } from "./../lib/tz";
import { deriveThresholds } from "./../lib/product-economics";
import {
  evaluateAwarenessMatch,
  type AudienceType as AwarenessAudienceType,
  type AwarenessStage as AwarenessStageType,
  type CreativeMismatch,
} from "./../lib/awareness-match";

type Product = NonNullable<Awaited<ReturnType<typeof prisma.product.findUnique>>>;

function thresholdsFor(product: Product) {
  return deriveThresholds({
    priceGross: product.priceGross,
    gatewayFeeRate: product.gatewayFeeRate,
    netPerSale: product.netPerSale,
    dailyBudgetTarget: product.dailyBudgetTarget,
    stage: product.stage as "launch" | "evergreen" | "escalavel" | "nicho",
  });
}

// ════════════════════════════════════════════════════════════════
// 1. HIT RATE — 3 niveis, min spend, velocity, timeline mensal.
// Pedro Sobral way: winner (escala), survivor (mantem), loser (mata).
// ════════════════════════════════════════════════════════════════

export type CreativeBucket =
  | "winner"           // CPA <= scaleThreshold E spend >= minSpend
  | "survivor"         // breakevenCPA < CPA <= scaleThreshold (lucra mas nao escala)
  | "loser"            // CPA > breakevenCPA (queima)
  | "pending_days"     // < 3 dias ativo
  | "pending_spend";   // >= 3 dias mas < min spend (sinal estatistico fraco)

export interface CreativeHitRateItem {
  id: string;
  name: string;
  type: string;
  bucket: CreativeBucket;
  cpa: number | null;
  hookRate: number | null;
  ctr: number | null;
  spendEstimated: number; // soma de MetricEntry.investment desde criacao
  salesEstimated: number;
  velocityPerDay: number; // vendas/dia ativo
  daysActive: number;
}

export interface HitRateResult {
  windowDays: number;
  thresholds: {
    breakevenCPA: number;
    scaleCPA: number;
    minSpendForEval: number;
  };
  totalLaunched: number;
  evaluable: number;
  buckets: {
    winner: number;
    survivor: number;
    loser: number;
    pendingDays: number;
    pendingSpend: number;
  };
  hitRatePct: number; // winners / evaluable
  benchmark: { elite: number; mediano: number };
  monthly: Array<{
    month: string; // YYYY-MM
    launched: number;
    winners: number;
    rate: number;
  }>;
  topWinners: CreativeHitRateItem[];
  worstLosers: CreativeHitRateItem[];
}

export async function getCreativeHitRate(
  productId: string,
  windowDays = 30
): Promise<HitRateResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product) {
    return {
      windowDays,
      thresholds: { breakevenCPA: 0, scaleCPA: 0, minSpendForEval: 0 },
      totalLaunched: 0,
      evaluable: 0,
      buckets: { winner: 0, survivor: 0, loser: 0, pendingDays: 0, pendingSpend: 0 },
      hitRatePct: 0,
      benchmark: { elite: 25, mediano: 12 },
      monthly: [],
      topWinners: [],
      worstLosers: [],
    };
  }
  const econ = thresholdsFor(product);
  const breakevenCPA = econ.breakevenCPA;
  const scaleCPA = econ.autoScaleCPAThreshold;
  // Regra: precisa de spend >= 1.5x scale CPA pra ter sinal minimo.
  // Abaixo disso, qualquer CPA observado e ruido — vai pra pending_spend.
  const minSpendForEval = scaleCPA * 1.5;

  // Janela maior pra timeline (6m), filtramos windowDays no agregado principal.
  const cutoffWindow = addBRTDays(startOfBRTDay(), -windowDays);
  const cutoffMonthly = addBRTDays(startOfBRTDay(), -180);

  const [creativesWindow, creativesMonthly] = await Promise.all([
    prisma.creative.findMany({
      where: { productId, createdAt: { gte: cutoffWindow } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.creative.findMany({
      where: { productId, createdAt: { gte: cutoffMonthly } },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  // Spend estimado por criativo: soma MetricEntry.investment do mesmo
  // metaAdId (estavel) ou fallback por nome se metaAdId null. Spend e
  // sales sao estimados — fonte autoritativa de venda continua sendo
  // Sale (metaAdId). Aqui usamos pra avaliar BUCKET, nao pra grana.
  const items: CreativeHitRateItem[] = [];
  const buckets = { winner: 0, survivor: 0, loser: 0, pendingDays: 0, pendingSpend: 0 };

  for (const c of creativesWindow) {
    const ageDays = Math.max(
      1,
      Math.floor((Date.now() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24))
    );

    // Spend agregado pelo metaAdId (se tiver) — reflete real exposicao.
    let spendEstimated = 0;
    if (c.metaAdId) {
      const adDiag = await prisma.adDiagnostic.aggregate({
        where: { productId, adId: c.metaAdId, date: { gte: c.createdAt } },
        _sum: { spend: true },
      });
      spendEstimated = adDiag._sum.spend || 0;
    }

    let salesEstimated = 0;
    if (c.metaAdId) {
      const salesAgg = await prisma.sale.count({
        where: {
          productId,
          status: "approved",
          metaAdId: c.metaAdId,
          date: { gte: c.createdAt },
        },
      });
      salesEstimated = salesAgg;
    }

    const cpa = salesEstimated > 0 ? spendEstimated / salesEstimated : c.cpa;
    const velocityPerDay = salesEstimated / ageDays;

    let bucket: CreativeBucket;
    if (ageDays < 3) {
      bucket = "pending_days";
      buckets.pendingDays += 1;
    } else if (spendEstimated < minSpendForEval && (cpa === null || cpa === 0)) {
      bucket = "pending_spend";
      buckets.pendingSpend += 1;
    } else if (cpa !== null && cpa > 0 && cpa <= scaleCPA && spendEstimated >= minSpendForEval) {
      bucket = "winner";
      buckets.winner += 1;
    } else if (cpa !== null && cpa > 0 && cpa <= breakevenCPA) {
      bucket = "survivor";
      buckets.survivor += 1;
    } else {
      bucket = "loser";
      buckets.loser += 1;
    }

    items.push({
      id: c.id,
      name: c.name,
      type: c.type,
      bucket,
      cpa: cpa !== null && cpa > 0 ? Math.round(cpa * 100) / 100 : null,
      hookRate: c.hookRate,
      ctr: c.ctr,
      spendEstimated: Math.round(spendEstimated * 100) / 100,
      salesEstimated,
      velocityPerDay: Math.round(velocityPerDay * 100) / 100,
      daysActive: ageDays,
    });
  }

  // Timeline mensal (180d) — % winners / evaluable por mes
  const monthlyMap = new Map<string, { launched: number; winners: number }>();
  for (const c of creativesMonthly) {
    const month = c.createdAt.toISOString().slice(0, 7);
    const e = monthlyMap.get(month) ?? { launched: 0, winners: 0 };
    e.launched += 1;
    if (c.cpa !== null && c.cpa > 0 && c.cpa <= scaleCPA) e.winners += 1;
    monthlyMap.set(month, e);
  }
  const monthly = Array.from(monthlyMap.entries())
    .sort()
    .map(([month, v]) => ({
      month,
      launched: v.launched,
      winners: v.winners,
      rate: v.launched > 0 ? Math.round((v.winners / v.launched) * 1000) / 10 : 0,
    }));

  const evaluable = buckets.winner + buckets.survivor + buckets.loser;
  const hitRatePct =
    evaluable > 0 ? Math.round((buckets.winner / evaluable) * 1000) / 10 : 0;

  return {
    windowDays,
    thresholds: { breakevenCPA, scaleCPA, minSpendForEval },
    totalLaunched: creativesWindow.length,
    evaluable,
    buckets,
    hitRatePct,
    // Benchmark conservador derivado de literatura de mercado (Tim Burd /
    // Foxwell newsletters citam 20-30% como elite, 10-15% mediano em ecom).
    benchmark: { elite: 25, mediano: 12 },
    monthly,
    topWinners: items
      .filter(i => i.bucket === "winner")
      .sort((a, b) => (a.cpa ?? Infinity) - (b.cpa ?? Infinity))
      .slice(0, 5),
    worstLosers: items
      .filter(i => i.bucket === "loser")
      .sort((a, b) => (b.cpa ?? 0) - (a.cpa ?? 0))
      .slice(0, 5),
  };
}

// ════════════════════════════════════════════════════════════════
// 2. PROFIT WATERFALL — completo, com refund/chargeback/comissao/
// imposto/upsell + delta vs periodo anterior + profit per sale.
// ════════════════════════════════════════════════════════════════

export interface ProfitWaterfallStep {
  label: string;
  value: number;
  pct: number;
  kind: "input" | "deduction" | "addition" | "result" | "projection";
}

export interface ProfitWaterfallResult {
  windowDays: number;
  steps: ProfitWaterfallStep[];
  // Snapshot principal:
  grossRevenue: number;
  refundAmount: number;
  chargebackAmount: number;
  gatewayFee: number;
  netRevenue: number;
  affiliateCommission: number;
  spend: number;
  upsellRevenue: number;
  taxEstimate: number;
  contributionMargin: number;
  contributionMarginPct: number;
  roas: number | null;
  profitPerSale: number | null;
  approvedSales: number;
  // Comparativo vs periodo anterior do mesmo tamanho:
  delta: {
    grossRevenuePct: number | null;
    cmPct: number | null;
    salesPct: number | null;
  };
}

async function aggregateProfit(
  productId: string,
  product: Product,
  from: Date,
  to: Date
) {
  const [salesByStatus, mentoria, metricsAgg] = await Promise.all([
    prisma.sale.groupBy({
      by: ["status"],
      where: { productId, date: { gte: from, lt: to } },
      _sum: { amountGross: true, amountNet: true },
      _count: true,
    }),
    prisma.sale.aggregate({
      where: {
        productId,
        status: "approved",
        date: { gte: from, lt: to },
        convertedToMentoria: true,
      },
      _count: true,
    }),
    prisma.metricEntry.aggregate({
      where: { productId, date: { gte: from, lt: to } },
      _sum: { investment: true },
    }),
  ]);

  const approvedRow = salesByStatus.find(s => s.status === "approved");
  const refundRow = salesByStatus.find(s => s.status === "refunded");
  const chargebackRow = salesByStatus.find(s => s.status === "chargeback");

  const grossRevenue = approvedRow?._sum.amountGross || 0;
  const netRevenueRaw = approvedRow?._sum.amountNet || 0;
  const approvedSales = approvedRow?._count || 0;
  const refundAmount = refundRow?._sum.amountGross || 0;
  const chargebackAmount = chargebackRow?._sum.amountGross || 0;
  const gatewayFee = grossRevenue - netRevenueRaw;
  const affiliateCommission = grossRevenue * (product.affiliateCommissionRate || 0);
  const spend = metricsAgg._sum.investment || 0;
  const mentoriaCount = mentoria._count || 0;
  const upsellValue = product.mentoriaUpsellValue || 0;
  const upsellRevenue = mentoriaCount * upsellValue;
  // Projeção: vendas low NÃO convertidas ainda × rate × valor.
  // Mostra "potencial" do upsell quando histórico real é fino. Quando dado
  // real existe (mentoriaCount > 0), projeção complementa o que sobra.
  const upsellRate = product.mentoriaUpsellRate ?? 0;
  const unconvertedSales = Math.max(0, approvedSales - mentoriaCount);
  const upsellProjected = unconvertedSales * upsellRate * upsellValue;
  // Receita liquida apos refund/chargeback/fee/comissao
  const netRevenue =
    netRevenueRaw - refundAmount - chargebackAmount - affiliateCommission;
  // Imposto estimado sobre receita liquida positiva
  const taxableBase = Math.max(0, netRevenue + upsellRevenue);
  const taxEstimate = taxableBase * (product.taxRate || 0);

  const cm = netRevenue + upsellRevenue - spend - taxEstimate;

  return {
    grossRevenue,
    refundAmount,
    chargebackAmount,
    gatewayFee,
    affiliateCommission,
    netRevenueRaw,
    netRevenue,
    upsellRevenue,
    upsellProjected,
    spend,
    taxEstimate,
    contributionMargin: cm,
    approvedSales,
    mentoriaCount,
  };
}

export async function getProfitWaterfall(
  productId: string,
  windowDays = 7
): Promise<ProfitWaterfallResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return {
      windowDays,
      steps: [],
      grossRevenue: 0,
      refundAmount: 0,
      chargebackAmount: 0,
      gatewayFee: 0,
      netRevenue: 0,
      affiliateCommission: 0,
      spend: 0,
      upsellRevenue: 0,
      taxEstimate: 0,
      contributionMargin: 0,
      contributionMarginPct: 0,
      roas: null,
      profitPerSale: null,
      approvedSales: 0,
      delta: { grossRevenuePct: null, cmPct: null, salesPct: null },
    };
  }
  const now = startOfBRTDay();
  const cutoffNow = addBRTDays(now, -windowDays);
  const cutoffPrev = addBRTDays(now, -2 * windowDays);

  const current = await aggregateProfit(productId, product, cutoffNow, now);
  const previous = await aggregateProfit(productId, product, cutoffPrev, cutoffNow);

  const safePct = (n: number) =>
    current.grossRevenue > 0 ? (n / current.grossRevenue) * 100 : 0;
  const cmPct = current.grossRevenue > 0
    ? (current.contributionMargin / current.grossRevenue) * 100
    : 0;
  const roas = current.spend > 0 ? current.grossRevenue / current.spend : null;
  const profitPerSale =
    current.approvedSales > 0
      ? current.contributionMargin / current.approvedSales
      : null;

  const steps: ProfitWaterfallStep[] = [
    { label: "Receita bruta", value: current.grossRevenue, pct: 100, kind: "input" },
    { label: "− Refund", value: -current.refundAmount, pct: -safePct(current.refundAmount), kind: "deduction" },
    { label: "− Chargeback", value: -current.chargebackAmount, pct: -safePct(current.chargebackAmount), kind: "deduction" },
    { label: "− Gateway fee", value: -current.gatewayFee, pct: -safePct(current.gatewayFee), kind: "deduction" },
    { label: "− Comissão afiliado", value: -current.affiliateCommission, pct: -safePct(current.affiliateCommission), kind: "deduction" },
    { label: "= Receita líquida", value: current.netRevenue, pct: safePct(current.netRevenue), kind: "result" },
    { label: "+ Upsell mentoria", value: current.upsellRevenue, pct: safePct(current.upsellRevenue), kind: "addition" },
  ];
  if (current.upsellProjected > 0) {
    steps.push({
      label: "+ Upsell projetado",
      value: current.upsellProjected,
      pct: safePct(current.upsellProjected),
      kind: "projection",
    });
  }
  steps.push(
    { label: "− CAC (spend Meta)", value: -current.spend, pct: -safePct(current.spend), kind: "deduction" },
    { label: "− Imposto estimado", value: -current.taxEstimate, pct: -safePct(current.taxEstimate), kind: "deduction" },
    { label: "= Contribution margin", value: current.contributionMargin, pct: cmPct, kind: "result" },
  );

  function pctChange(curr: number, prev: number): number | null {
    if (prev === 0) return curr === 0 ? 0 : null;
    return Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
  }

  return {
    windowDays,
    steps,
    grossRevenue: current.grossRevenue,
    refundAmount: current.refundAmount,
    chargebackAmount: current.chargebackAmount,
    gatewayFee: current.gatewayFee,
    netRevenue: current.netRevenue,
    affiliateCommission: current.affiliateCommission,
    spend: current.spend,
    upsellRevenue: current.upsellRevenue,
    taxEstimate: current.taxEstimate,
    contributionMargin: current.contributionMargin,
    contributionMarginPct: Math.round(cmPct * 10) / 10,
    roas: roas ? Math.round(roas * 100) / 100 : null,
    profitPerSale: profitPerSale ? Math.round(profitPerSale * 100) / 100 : null,
    approvedSales: current.approvedSales,
    delta: {
      grossRevenuePct: pctChange(current.grossRevenue, previous.grossRevenue),
      cmPct: pctChange(current.contributionMargin, previous.contributionMargin),
      salesPct: pctChange(current.approvedSales, previous.approvedSales),
    },
  };
}

// ════════════════════════════════════════════════════════════════
// 3. PAYBACK COHORT — agregado + por adset + por criativo + status
// maturity. Inclui upsell mentoria no calculo de revenue cumulativo.
// ════════════════════════════════════════════════════════════════

export type CohortMaturityStatus = "paid" | "in_progress" | "never_paid";

export interface PaybackCohortRow {
  cohortDate: string;
  spend: number;
  cumRevenueD1: number | null; // null = nao maturou ainda
  cumRevenueD7: number | null;
  cumRevenueD14: number | null;
  cumRevenueD30: number | null;
  paybackDay: number | null;
  status: CohortMaturityStatus;
}

export interface PaybackByEntity {
  name: string;
  spend: number;
  revenue: number;
  paybackDay: number | null;
  status: CohortMaturityStatus;
}

export interface PaybackCohortResult {
  windowDays: number;
  rows: PaybackCohortRow[];
  avgPaybackDays: number | null;
  byAdset: PaybackByEntity[];
  byCreative: PaybackByEntity[];
}

interface DailyMoney {
  date: string; // YYYY-MM-DD
  spend: number;
  revenue: number; // amountNet + upsell se mentoria
}

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function getPaybackCohort(
  productId: string,
  windowDays = 30
): Promise<PaybackCohortResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return { windowDays, rows: [], avgPaybackDays: null, byAdset: [], byCreative: [] };
  }
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);
  const now = new Date();
  const upsellValue = product.mentoriaUpsellValue || 0;

  const [metrics, sales, creatives] = await Promise.all([
    prisma.metricEntry.findMany({
      where: { productId, date: { gte: cutoff } },
      select: { date: true, investment: true, adSet: true, campaignId: true },
    }),
    prisma.sale.findMany({
      where: { productId, status: "approved", date: { gte: cutoff } },
      select: {
        date: true,
        amountNet: true,
        metaAdsetId: true,
        metaAdId: true,
        convertedToMentoria: true,
      },
    }),
    prisma.creative.findMany({
      where: { productId },
      select: { id: true, name: true, metaAdId: true },
    }),
  ]);

  const adIdToCreativeName = new Map<string, string>();
  for (const c of creatives) {
    if (c.metaAdId) adIdToCreativeName.set(c.metaAdId, c.name);
  }

  // Dia agregado (produto inteiro)
  const dailyByDate = new Map<string, DailyMoney>();
  for (const m of metrics) {
    const k = dateKey(m.date);
    const e = dailyByDate.get(k) ?? { date: k, spend: 0, revenue: 0 };
    e.spend += m.investment;
    dailyByDate.set(k, e);
  }
  for (const s of sales) {
    const k = dateKey(s.date);
    const e = dailyByDate.get(k) ?? { date: k, spend: 0, revenue: 0 };
    e.revenue += s.amountNet + (s.convertedToMentoria ? upsellValue : 0);
    dailyByDate.set(k, e);
  }

  const allDates = Array.from(dailyByDate.keys()).sort();
  function classifyMaturity(cohortDate: string, paybackDay: number | null): CohortMaturityStatus {
    if (paybackDay !== null) return "paid";
    const cohort = new Date(cohortDate + "T00:00:00.000Z");
    const ageDays = Math.floor((now.getTime() - cohort.getTime()) / (1000 * 60 * 60 * 24));
    return ageDays >= 30 ? "never_paid" : "in_progress";
  }

  function calcCum(cohortDate: string, offsetDays: number): number | null {
    const cohort = new Date(cohortDate + "T00:00:00.000Z");
    const end = new Date(cohort);
    end.setUTCDate(end.getUTCDate() + offsetDays);
    if (end > now) return null; // nao maturou
    let acc = 0;
    for (let d = 0; d <= offsetDays; d++) {
      const date = new Date(cohort);
      date.setUTCDate(date.getUTCDate() + d);
      acc += dailyByDate.get(dateKey(date))?.revenue || 0;
    }
    return Math.round(acc * 100) / 100;
  }

  const rows: PaybackCohortRow[] = [];
  let paybackSum = 0;
  let paybackCount = 0;

  for (const d of allDates) {
    const e = dailyByDate.get(d)!;
    if (e.spend === 0) continue;

    let acc = 0;
    let paybackDay: number | null = null;
    const cohort = new Date(d + "T00:00:00.000Z");
    for (let day = 0; day <= 60; day++) {
      const date = new Date(cohort);
      date.setUTCDate(date.getUTCDate() + day);
      if (date > now) break;
      acc += dailyByDate.get(dateKey(date))?.revenue || 0;
      if (acc >= e.spend) {
        paybackDay = day;
        break;
      }
    }
    if (paybackDay !== null) {
      paybackSum += paybackDay;
      paybackCount += 1;
    }
    rows.push({
      cohortDate: d,
      spend: Math.round(e.spend * 100) / 100,
      cumRevenueD1: calcCum(d, 1),
      cumRevenueD7: calcCum(d, 7),
      cumRevenueD14: calcCum(d, 14),
      cumRevenueD30: calcCum(d, 30),
      paybackDay,
      status: classifyMaturity(d, paybackDay),
    });
  }

  // Por adset
  const adsetMap = new Map<string, { spend: number; revenue: number; firstDate: Date }>();
  for (const m of metrics) {
    const k = m.adSet || "(sem adset)";
    const e = adsetMap.get(k) ?? { spend: 0, revenue: 0, firstDate: m.date };
    e.spend += m.investment;
    if (m.date < e.firstDate) e.firstDate = m.date;
    adsetMap.set(k, e);
  }
  for (const s of sales) {
    if (!s.metaAdsetId) continue;
    // tenta achar nome do adset via MetricEntry
    const sample = metrics.find(m => m.adSet && m.adSet.length > 0);
    const k = sample?.adSet || s.metaAdsetId;
    const e = adsetMap.get(k);
    if (!e) continue;
    e.revenue += s.amountNet + (s.convertedToMentoria ? upsellValue : 0);
  }
  const byAdset: PaybackByEntity[] = Array.from(adsetMap.entries())
    .filter(([, v]) => v.spend > 0)
    .map(([name, v]) => {
      const ageDays = Math.floor((now.getTime() - v.firstDate.getTime()) / (1000 * 60 * 60 * 24));
      const paybackDay = v.revenue >= v.spend ? Math.min(ageDays, 60) : null;
      return {
        name,
        spend: Math.round(v.spend * 100) / 100,
        revenue: Math.round(v.revenue * 100) / 100,
        paybackDay,
        status: (paybackDay !== null
          ? "paid"
          : ageDays >= 30
            ? "never_paid"
            : "in_progress") as CohortMaturityStatus,
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  // Por criativo (via metaAdId)
  const creativeMap = new Map<string, { spend: number; revenue: number; firstDate: Date }>();
  for (const s of sales) {
    if (!s.metaAdId) continue;
    const name = adIdToCreativeName.get(s.metaAdId) || s.metaAdId;
    const e = creativeMap.get(name) ?? { spend: 0, revenue: 0, firstDate: s.date };
    e.revenue += s.amountNet + (s.convertedToMentoria ? upsellValue : 0);
    if (s.date < e.firstDate) e.firstDate = s.date;
    creativeMap.set(name, e);
  }
  // Spend por criativo via AdDiagnostic
  const diags = await prisma.adDiagnostic.findMany({
    where: { productId, date: { gte: cutoff } },
    select: { adId: true, spend: true, date: true },
  });
  for (const d of diags) {
    const name = adIdToCreativeName.get(d.adId) || d.adId;
    const e = creativeMap.get(name) ?? { spend: 0, revenue: 0, firstDate: d.date };
    e.spend += d.spend;
    if (d.date < e.firstDate) e.firstDate = d.date;
    creativeMap.set(name, e);
  }
  const byCreative: PaybackByEntity[] = Array.from(creativeMap.entries())
    .filter(([, v]) => v.spend > 0)
    .map(([name, v]) => {
      const ageDays = Math.floor((now.getTime() - v.firstDate.getTime()) / (1000 * 60 * 60 * 24));
      const paybackDay = v.revenue >= v.spend ? Math.min(ageDays, 60) : null;
      return {
        name,
        spend: Math.round(v.spend * 100) / 100,
        revenue: Math.round(v.revenue * 100) / 100,
        paybackDay,
        status: (paybackDay !== null
          ? "paid"
          : ageDays >= 30
            ? "never_paid"
            : "in_progress") as CohortMaturityStatus,
      };
    })
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);

  return {
    windowDays,
    rows,
    avgPaybackDays:
      paybackCount > 0 ? Math.round((paybackSum / paybackCount) * 10) / 10 : null,
    byAdset,
    byCreative,
  };
}

// ════════════════════════════════════════════════════════════════
// 4. LTV COHORT — LTV/CAC ratio + survival + mentoria conversion.
// ════════════════════════════════════════════════════════════════

export interface LtvCohortRow {
  cohortWeek: string;
  buyers: number;
  cac: number; // spend total da semana / buyers (proxy)
  ltvD7: number;
  ltvD14: number;
  ltvD30: number;
  ltvD60: number;
  ltvCacRatio: number | null; // LTV D60 / CAC
  mentoriaConvPct: number; // % buyers que converteram pra mentoria
  retainedD30: number; // % que recompraram em D30
}

export interface LtvCohortResult {
  windowDays: number;
  rows: LtvCohortRow[];
  rule: "≥3 = saudavel pra escalar, <2 = problema";
}

function isoWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  d.setUTCHours(0, 0, 0, 0);
  return dateKey(d);
}

export async function getLtvCohort(
  productId: string,
  windowDays = 90
): Promise<LtvCohortResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);
  const now = new Date();

  const product = await prisma.product.findUnique({ where: { id: productId } });
  const upsellValue = product?.mentoriaUpsellValue || 0;

  const [sales, metrics] = await Promise.all([
    prisma.sale.findMany({
      where: { productId, status: "approved", date: { gte: cutoff } },
      select: {
        customerEmail: true,
        date: true,
        amountNet: true,
        convertedToMentoria: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma.metricEntry.findMany({
      where: { productId, date: { gte: cutoff } },
      select: { date: true, investment: true },
    }),
  ]);

  // Spend por semana
  const spendByWeek = new Map<string, number>();
  for (const m of metrics) {
    const w = isoWeekStart(m.date);
    spendByWeek.set(w, (spendByWeek.get(w) || 0) + m.investment);
  }

  // Primeira compra de cada customer
  const firstBuyByCustomer = new Map<string, Date>();
  for (const s of sales) {
    if (!s.customerEmail) continue;
    if (!firstBuyByCustomer.has(s.customerEmail)) {
      firstBuyByCustomer.set(s.customerEmail, s.date);
    }
  }

  // Agrupa por cohort week (semana da primeira compra)
  const cohortByWeek = new Map<
    string,
    {
      buyers: Set<string>;
      firstBuyDates: Map<string, Date>;
      mentoriaCustomers: Set<string>;
      retainedByDay: Map<string, Set<number>>; // email -> set of days with new buy
    }
  >();
  for (const [email, firstDate] of firstBuyByCustomer) {
    const w = isoWeekStart(firstDate);
    const e = cohortByWeek.get(w) ?? {
      buyers: new Set<string>(),
      firstBuyDates: new Map<string, Date>(),
      mentoriaCustomers: new Set<string>(),
      retainedByDay: new Map<string, Set<number>>(),
    };
    e.buyers.add(email);
    e.firstBuyDates.set(email, firstDate);
    cohortByWeek.set(w, e);
  }

  // Marca mentoria + retained
  for (const s of sales) {
    if (!s.customerEmail) continue;
    const firstBuy = firstBuyByCustomer.get(s.customerEmail);
    if (!firstBuy) continue;
    const w = isoWeekStart(firstBuy);
    const cohort = cohortByWeek.get(w);
    if (!cohort) continue;
    if (s.convertedToMentoria) cohort.mentoriaCustomers.add(s.customerEmail);
    const offsetDays = Math.floor(
      (s.date.getTime() - firstBuy.getTime()) / (1000 * 60 * 60 * 24)
    );
    if (offsetDays > 0) {
      const days = cohort.retainedByDay.get(s.customerEmail) ?? new Set<number>();
      days.add(offsetDays);
      cohort.retainedByDay.set(s.customerEmail, days);
    }
  }

  const rows: LtvCohortRow[] = [];
  for (const week of Array.from(cohortByWeek.keys()).sort()) {
    const cohort = cohortByWeek.get(week)!;
    const buyers = cohort.buyers.size;
    if (buyers === 0) continue;

    const calcLtv = (offsetDays: number): number => {
      let total = 0;
      for (const email of cohort.buyers) {
        const firstBuy = cohort.firstBuyDates.get(email)!;
        const cutoffEnd = new Date(firstBuy);
        cutoffEnd.setUTCDate(cutoffEnd.getUTCDate() + offsetDays);
        const cap = cutoffEnd > now ? now : cutoffEnd;
        for (const s of sales) {
          if (s.customerEmail !== email) continue;
          if (s.date >= firstBuy && s.date <= cap) {
            total += s.amountNet + (s.convertedToMentoria ? upsellValue : 0);
          }
        }
      }
      return buyers > 0 ? total / buyers : 0;
    };

    const cac = (spendByWeek.get(week) || 0) / buyers;
    const ltvD60 = calcLtv(60);
    const ltvCacRatio = cac > 0 ? Math.round((ltvD60 / cac) * 100) / 100 : null;
    const retainedD30 = Array.from(cohort.retainedByDay.entries()).filter(
      ([, days]) => Array.from(days).some(d => d <= 30)
    ).length;

    rows.push({
      cohortWeek: week,
      buyers,
      cac: Math.round(cac * 100) / 100,
      ltvD7: Math.round(calcLtv(7) * 100) / 100,
      ltvD14: Math.round(calcLtv(14) * 100) / 100,
      ltvD30: Math.round(calcLtv(30) * 100) / 100,
      ltvD60: Math.round(ltvD60 * 100) / 100,
      ltvCacRatio,
      mentoriaConvPct:
        Math.round((cohort.mentoriaCustomers.size / buyers) * 1000) / 10,
      retainedD30: Math.round((retainedD30 / buyers) * 1000) / 10,
    });
  }

  return {
    windowDays,
    rows,
    rule: "≥3 = saudavel pra escalar, <2 = problema",
  };
}

// ════════════════════════════════════════════════════════════════
// 6. CREATIVE VOLUME SCORE (Onda 2.1)
// Score 0-100 cruzando volume de producao, hit rate e idade media
// do pool ativo. Identifica quando o pipeline de criativo parou.
// Tim Burd / Foxwell: elite > 30 launches/mes (~7/semana).
// ════════════════════════════════════════════════════════════════

export interface CreativeVolumeScoreResult {
  windowDays: number;
  launchesLast7d: number;
  launchesLast30d: number;
  poolActive: number;
  poolAvgAgeDays: number;
  hitRatePct: number;
  // sub-scores 0-40/40/20
  volumeScore: number;
  hitRateScore: number;
  freshnessScore: number;
  totalScore: number; // 0-100
  grade: "elite" | "bom" | "mediano" | "critico";
  recommendations: string[];
}

export async function getCreativeVolumeScore(
  productId: string
): Promise<CreativeVolumeScoreResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product) {
    return {
      windowDays: 30,
      launchesLast7d: 0,
      launchesLast30d: 0,
      poolActive: 0,
      poolAvgAgeDays: 0,
      hitRatePct: 0,
      volumeScore: 0,
      hitRateScore: 0,
      freshnessScore: 0,
      totalScore: 0,
      grade: "critico",
      recommendations: ["Produto sem dados."],
    };
  }
  const econ = thresholdsFor(product);
  const scaleCPA = econ.autoScaleCPAThreshold;

  const cutoff7 = addBRTDays(startOfBRTDay(), -7);
  const cutoff30 = addBRTDays(startOfBRTDay(), -30);

  const [c7, c30, active] = await Promise.all([
    prisma.creative.count({
      where: { productId, createdAt: { gte: cutoff7 } },
    }),
    prisma.creative.findMany({
      where: { productId, createdAt: { gte: cutoff30 } },
    }),
    prisma.creative.findMany({
      where: { productId, status: "active" },
      select: { id: true, createdAt: true, cpa: true },
    }),
  ]);

  // Hit rate sobre evaluable (CPA != null com sinal)
  const evaluable = c30.filter(c => c.cpa !== null && c.cpa > 0);
  const winners = evaluable.filter(c => c.cpa! <= scaleCPA);
  const hitRatePct =
    evaluable.length > 0
      ? Math.round((winners.length / evaluable.length) * 1000) / 10
      : 0;

  // Pool age
  const now = Date.now();
  const ageSum = active.reduce(
    (acc, c) => acc + (now - c.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    0
  );
  const poolAvgAgeDays = active.length > 0 ? ageSum / active.length : 0;

  // Sub-scores
  // Volume: target 7/semana (elite). <2 = 0, >=7 = 40, linear.
  const volumeScore = Math.max(0, Math.min(40, ((c7 - 2) / (7 - 2)) * 40));
  // Hit rate: target 25% (elite). <12 = 0, >=25 = 40, linear.
  const hitRateScore = Math.max(0, Math.min(40, ((hitRatePct - 12) / (25 - 12)) * 40));
  // Freshness: ideal <14d media. >30d = 0, <=14d = 20, linear.
  const freshnessScore =
    poolAvgAgeDays <= 14
      ? 20
      : poolAvgAgeDays >= 30
        ? 0
        : Math.max(0, Math.round((1 - (poolAvgAgeDays - 14) / (30 - 14)) * 20));

  const totalScore = Math.round(volumeScore + hitRateScore + freshnessScore);
  const grade: CreativeVolumeScoreResult["grade"] =
    totalScore >= 80
      ? "elite"
      : totalScore >= 60
        ? "bom"
        : totalScore >= 40
          ? "mediano"
          : "critico";

  const recommendations: string[] = [];
  if (c7 < 2) {
    recommendations.push(
      `Pipeline parado: só ${c7} criativo(s) lançado(s) em 7d. Elite ships 5-7/semana.`
    );
  } else if (c7 < 5) {
    recommendations.push(
      `Volume baixo (${c7} em 7d). Aumente pra 5-7/semana pra sustentar hit rate.`
    );
  }
  if (hitRatePct < 12 && evaluable.length >= 5) {
    recommendations.push(
      `Hit rate ${hitRatePct.toFixed(1)}% abaixo de mediano (12%). Revise hooks e Stages of Awareness.`
    );
  }
  if (poolAvgAgeDays > 30) {
    recommendations.push(
      `Pool envelhecido (${poolAvgAgeDays.toFixed(0)}d média). Fadiga iminente — substitua os mais antigos.`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push("Pipeline saudável. Mantenha cadência.");
  }

  return {
    windowDays: 30,
    launchesLast7d: c7,
    launchesLast30d: c30.length,
    poolActive: active.length,
    poolAvgAgeDays: Math.round(poolAvgAgeDays * 10) / 10,
    hitRatePct,
    volumeScore: Math.round(volumeScore),
    hitRateScore: Math.round(hitRateScore),
    freshnessScore,
    totalScore,
    grade,
    recommendations,
  };
}

// ════════════════════════════════════════════════════════════════
// 7. FATIGUE PREDICTIVO (Onda 2.3)
// Linear regression sobre hookRate diario. Se slope negativo, estima
// daysToDeath = (hookRate atual − floor) / |slope|.
// Floor 5% (abaixo disso vira loser puro).
// ════════════════════════════════════════════════════════════════

const HOOK_RATE_FLOOR = 5; // % — abaixo morre como criativo
const FATIGUE_WINDOW_DAYS = 14;

function linearTrend(points: Array<{ x: number; y: number }>): {
  slope: number;
  intercept: number;
  rSquared: number;
} {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: points[0]?.y ?? 0, rSquared: 0 };
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, rSquared: 0 };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  // R² simples (sem covariance ajustada)
  const meanY = sumY / n;
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const ssRes = points.reduce(
    (s, p) => s + (p.y - (slope * p.x + intercept)) ** 2,
    0
  );
  const rSquared = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, rSquared };
}

export type FatigueStatus = "healthy" | "declining" | "critical" | "no_data";

export interface FatiguePrediction {
  creativeId: string;
  name: string;
  type: string;
  currentHookRate: number | null;
  trendSlope: number; // pontos %/dia
  daysToDeath: number | null;
  status: FatigueStatus;
  rSquared: number;
  pointsAnalyzed: number;
  reason: string;
}

export interface FatigueResult {
  windowDays: number;
  hookRateFloor: number;
  predictions: FatiguePrediction[];
  summary: {
    healthy: number;
    declining: number;
    critical: number;
    noData: number;
  };
}

export async function getFatiguePredictions(
  productId: string
): Promise<FatigueResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -FATIGUE_WINDOW_DAYS);

  const creatives = await prisma.creative.findMany({
    where: { productId, status: "active" },
    select: {
      id: true,
      name: true,
      type: true,
      hookRate: true,
      dailyMetrics: {
        where: { date: { gte: cutoff }, hookRate: { not: null } },
        orderBy: { date: "asc" },
      },
    },
  });

  const predictions: FatiguePrediction[] = [];
  const summary = { healthy: 0, declining: 0, critical: 0, noData: 0 };

  for (const c of creatives) {
    const points = c.dailyMetrics
      .filter(d => typeof d.hookRate === "number")
      .map((d, i) => ({ x: i, y: d.hookRate as number }));

    let status: FatigueStatus = "no_data";
    let trendSlope = 0;
    let rSquared = 0;
    let daysToDeath: number | null = null;
    let reason = "Sem dados suficientes (precisa ≥3 dias com hookRate)";

    if (points.length >= 3) {
      const trend = linearTrend(points);
      trendSlope = Math.round(trend.slope * 100) / 100;
      rSquared = Math.round(trend.rSquared * 100) / 100;

      const currentHook = c.hookRate ?? points[points.length - 1].y;

      if (trendSlope >= -0.5) {
        status = "healthy";
        reason = `hookRate estavel/subindo (slope ${trendSlope.toFixed(2)})`;
      } else if (trendSlope >= -1.5) {
        status = "declining";
        if (trendSlope < 0 && currentHook > HOOK_RATE_FLOOR) {
          daysToDeath = Math.round(
            (currentHook - HOOK_RATE_FLOOR) / Math.abs(trendSlope)
          );
        }
        reason = `hookRate caindo ${Math.abs(trendSlope).toFixed(2)}pp/dia${daysToDeath ? `, ~${daysToDeath}d ate floor ${HOOK_RATE_FLOOR}%` : ""}`;
      } else {
        status = "critical";
        if (trendSlope < 0 && currentHook > HOOK_RATE_FLOOR) {
          daysToDeath = Math.round(
            (currentHook - HOOK_RATE_FLOOR) / Math.abs(trendSlope)
          );
        }
        reason = `hookRate despencando (${Math.abs(trendSlope).toFixed(2)}pp/dia)${daysToDeath ? ` — morte em ~${daysToDeath}d` : ""}`;
      }

      // Confiança baixa se R² ruim
      if (rSquared < 0.3 && status !== "healthy") {
        reason += ` [confiança baixa, R²=${rSquared.toFixed(2)}]`;
      }
    }

    summary[
      status === "no_data"
        ? "noData"
        : (status as "healthy" | "declining" | "critical")
    ] += 1;

    predictions.push({
      creativeId: c.id,
      name: c.name,
      type: c.type,
      currentHookRate: c.hookRate,
      trendSlope,
      daysToDeath,
      status,
      rSquared,
      pointsAnalyzed: points.length,
      reason,
    });
  }

  // Ordena: critical → declining → healthy → no_data, e dentro por daysToDeath asc
  const order: Record<FatigueStatus, number> = {
    critical: 0,
    declining: 1,
    healthy: 2,
    no_data: 3,
  };
  predictions.sort((a, b) => {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    const ad = a.daysToDeath ?? 999;
    const bd = b.daysToDeath ?? 999;
    return ad - bd;
  });

  return {
    windowDays: FATIGUE_WINDOW_DAYS,
    hookRateFloor: HOOK_RATE_FLOOR,
    predictions,
    summary,
  };
}

// ════════════════════════════════════════════════════════════════
// 8. CPA ELASTICITY (Onda 2.4)
// Detecta o "knee" do scale: ponto onde aumentar budget faz CPA
// disparar. Lê ActionLog de auto_scale + MetricEntry pre/post.
// ════════════════════════════════════════════════════════════════

export interface ElasticityPoint {
  date: string;
  budgetBefore: number;
  budgetAfter: number;
  cpaBefore: number | null;
  cpaAfter: number | null;
  cpaDelta: number | null; // %
  budgetDelta: number; // %
}

export interface AdsetElasticity {
  adsetId: string;
  adsetName: string;
  events: ElasticityPoint[];
  kneeBudget: number | null; // budget acima do qual CPA disparou
  signal: "stable" | "knee_detected" | "no_signal";
  note: string;
}

export interface ElasticityResult {
  windowDays: number;
  adsets: AdsetElasticity[];
}

export async function getCpaElasticity(
  productId: string,
  windowDays = 60
): Promise<ElasticityResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);

  const scaleEvents = await prisma.actionLog.findMany({
    where: {
      productId,
      action: "auto_scale",
      entityType: "adset",
      executedAt: { gte: cutoff },
    },
    orderBy: { executedAt: "asc" },
  });

  if (scaleEvents.length === 0) {
    return { windowDays, adsets: [] };
  }

  // Agrupa por adset
  const byAdset = new Map<string, typeof scaleEvents>();
  for (const ev of scaleEvents) {
    if (!ev.entityId) continue;
    const arr = byAdset.get(ev.entityId) ?? [];
    arr.push(ev);
    byAdset.set(ev.entityId, arr);
  }

  const adsets: AdsetElasticity[] = [];
  for (const [adsetId, events] of byAdset) {
    const sortedEvents = events.sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());
    const adsetName = sortedEvents[0]?.entityName ?? adsetId;

    const points: ElasticityPoint[] = [];
    for (const ev of sortedEvents) {
      const snap = ev.inputSnapshot as Record<string, unknown> | null;
      const budgetBefore = typeof snap?.currentBudget === "number" ? snap.currentBudget : 0;
      const budgetAfter = typeof snap?.newBudget === "number" ? snap.newBudget : 0;

      // Janela 3d antes/depois pra CPA
      const dateBeforeStart = new Date(ev.executedAt.getTime() - 3 * 24 * 60 * 60 * 1000);
      const dateAfterEnd = new Date(ev.executedAt.getTime() + 3 * 24 * 60 * 60 * 1000);
      const dateAfterStart = new Date(ev.executedAt.getTime());

      const [pre, post] = await Promise.all([
        prisma.metricEntry.aggregate({
          where: {
            productId,
            adSet: adsetName,
            date: { gte: dateBeforeStart, lt: ev.executedAt },
          },
          _sum: { investment: true, salesKirvano: true },
        }),
        prisma.metricEntry.aggregate({
          where: {
            productId,
            adSet: adsetName,
            date: { gte: dateAfterStart, lte: dateAfterEnd },
          },
          _sum: { investment: true, salesKirvano: true },
        }),
      ]);

      const cpaBefore =
        (pre._sum.salesKirvano || 0) > 0
          ? (pre._sum.investment || 0) / pre._sum.salesKirvano!
          : null;
      const cpaAfter =
        (post._sum.salesKirvano || 0) > 0
          ? (post._sum.investment || 0) / post._sum.salesKirvano!
          : null;

      const cpaDelta =
        cpaBefore !== null && cpaAfter !== null && cpaBefore > 0
          ? Math.round(((cpaAfter - cpaBefore) / cpaBefore) * 1000) / 10
          : null;
      const budgetDelta =
        budgetBefore > 0
          ? Math.round(((budgetAfter - budgetBefore) / budgetBefore) * 1000) / 10
          : 0;

      points.push({
        date: ev.executedAt.toISOString().slice(0, 10),
        budgetBefore,
        budgetAfter,
        cpaBefore: cpaBefore !== null ? Math.round(cpaBefore * 100) / 100 : null,
        cpaAfter: cpaAfter !== null ? Math.round(cpaAfter * 100) / 100 : null,
        cpaDelta,
        budgetDelta,
      });
    }

    // Knee detection: primeiro ponto onde cpaDelta > 30% (CPA piorou >30%)
    const kneePoint = points.find(p => p.cpaDelta !== null && p.cpaDelta > 30);
    let signal: AdsetElasticity["signal"];
    let note: string;
    let kneeBudget: number | null = null;
    if (kneePoint) {
      signal = "knee_detected";
      kneeBudget = kneePoint.budgetBefore;
      note = `Em ${kneePoint.date}: budget ${kneePoint.budgetBefore}→${kneePoint.budgetAfter} (+${kneePoint.budgetDelta}%) e CPA ${kneePoint.cpaBefore}→${kneePoint.cpaAfter} (+${kneePoint.cpaDelta}%). Knee em R$${kneePoint.budgetBefore}.`;
    } else if (points.some(p => p.cpaDelta !== null)) {
      signal = "stable";
      note = `${points.length} scale(s) sem knee detectado. Pode escalar mais.`;
    } else {
      signal = "no_signal";
      note = `${points.length} scale(s) mas sem CPA pre/post calculavel ainda.`;
    }

    adsets.push({ adsetId, adsetName, events: points, kneeBudget, signal, note });
  }

  return { windowDays, adsets };
}

// ════════════════════════════════════════════════════════════════
// 9. DECISION QUEUE (Onda 2.2)
// Cruza tudo pra gerar top N acoes priorizadas hoje. Cada acao tem
// reasoning + impacto estimado + entidade alvo.
// ════════════════════════════════════════════════════════════════

export type DecisionAction =
  | "pause_creative"
  | "scale_winner"
  | "replace_copy_awareness_mismatch"
  | "produce_creatives"
  | "watch_fatigue"
  | "reduce_budget"
  | "investigate_payback"
  | "tag_assets";

export interface DecisionItem {
  priority: number; // 1 = top
  action: DecisionAction;
  title: string;
  reasoning: string;
  entity?: { type: "creative" | "adset" | "product"; id?: string; name?: string };
  estimatedImpact?: string;
}

export interface DecisionQueueResult {
  generatedAt: string;
  items: DecisionItem[];
}

export async function getDecisionQueue(
  productId: string
): Promise<DecisionQueueResult> {
  const items: DecisionItem[] = [];

  // Roda analytics em paralelo. Volume, Awareness, Mismatches sao baratos.
  const [hitRate, fatigue, volume, awareness, waterfall, mismatches] = await Promise.all([
    getCreativeHitRate(productId, 30),
    getFatiguePredictions(productId),
    getCreativeVolumeScore(productId),
    getAwarenessAnalytics(productId, 30),
    getProfitWaterfall(productId, 7),
    getAwarenessMismatches(productId, 30),
  ]);

  // 1. Pause losers (top 3 piores por CPA)
  hitRate.worstLosers.slice(0, 3).forEach((loser, i) => {
    items.push({
      priority: 10 + i,
      action: "pause_creative",
      title: `Pausar criativo "${loser.name}"`,
      reasoning: `Loser há ${loser.daysActive}d com CPA ${
        loser.cpa ? `R$${loser.cpa}` : "—"
      } > breakeven. Gasto R$${loser.spendEstimated.toFixed(0)} sem retorno.`,
      entity: { type: "creative", id: loser.id, name: loser.name },
      estimatedImpact: `economiza ~R$${(loser.spendEstimated / Math.max(1, loser.daysActive)).toFixed(0)}/dia`,
    });
  });

  // 2. Scale winners (top 3)
  hitRate.topWinners.slice(0, 3).forEach((winner, i) => {
    items.push({
      priority: 20 + i,
      action: "scale_winner",
      title: `Escalar criativo "${winner.name}"`,
      reasoning: `Winner ${winner.daysActive}d, CPA R$${winner.cpa?.toFixed(0)} (≤ scale). Velocity ${winner.velocityPerDay.toFixed(2)} venda/dia.`,
      entity: { type: "creative", id: winner.id, name: winner.name },
      estimatedImpact: "+20% budget pode dobrar volume com mesmo CPA",
    });
  });

  // 3. Fatigue critical
  fatigue.predictions
    .filter(p => p.status === "critical" || p.status === "declining")
    .slice(0, 3)
    .forEach((p, i) => {
      items.push({
        priority: p.status === "critical" ? 5 + i : 30 + i,
        action: "watch_fatigue",
        title: `${p.status === "critical" ? "URGENTE: " : ""}Fadiga em "${p.name}"`,
        reasoning: p.reason,
        entity: { type: "creative", id: p.creativeId, name: p.name },
        estimatedImpact: p.daysToDeath
          ? `~${p.daysToDeath}d até virar loser. Substitua agora.`
          : undefined,
      });
    });

  // 4. Volume baixo
  if (volume.launchesLast7d < 5) {
    items.push({
      priority: 15,
      action: "produce_creatives",
      title: `Pipeline de criativo em ${volume.launchesLast7d}/sem`,
      reasoning: `Elite ships 5-7/semana. Pool age ${volume.poolAvgAgeDays.toFixed(0)}d. Score ${volume.totalScore}/100 (${volume.grade}).`,
      entity: { type: "product" },
      estimatedImpact: "evitar vácuo quando atuais fadigarem",
    });
  }

  // 5. Awareness mismatch (worst pair com count >= 5)
  if (awareness.worstPair && awareness.worstPair.winnerRate < 12) {
    items.push({
      priority: 25,
      action: "replace_copy_awareness_mismatch",
      title: `Mismatch ${awareness.worstPair.stage} × ${awareness.worstPair.audience}`,
      reasoning: `Combinação tem winner rate ${awareness.worstPair.winnerRate.toFixed(0)}% (abaixo de mediano 12%). Schwartz: copy ${awareness.worstPair.stage} não bate com audiência ${awareness.worstPair.audience}.`,
      entity: { type: "product" },
      estimatedImpact: "trocar copy dessa combinação ou mover criativo pra audiência certa",
    });
  }

  // 5b. Mismatches por criativo individual (Item 1 roadmap Sobral).
  // Lista criativos especificos em audiência errada. Top 3 mais graves.
  const graveMismatches = mismatches.items
    .filter(m => m.matchScore === "mismatch")
    .slice(0, 3);
  graveMismatches.forEach((m, i) => {
    items.push({
      priority: 12 + i,
      action: "replace_copy_awareness_mismatch",
      title: `Criativo "${m.creativeName}" em audiência errada`,
      reasoning: `${m.reason} Stage ${m.awarenessStage} em ${m.audience}. CPA atual ${m.cpa ? `R$${m.cpa.toFixed(0)}` : "—"}.`,
      entity: { type: "creative", id: m.creativeId, name: m.creativeName },
      estimatedImpact: "mover criativo pra Remarketing/ASC ou trocar copy pra problem/solution-aware",
    });
  });

  // 6. Untagged dominante
  if (awareness.untaggedCount > awareness.taggedCount * 2 && awareness.untaggedCount >= 5) {
    items.push({
      priority: 50,
      action: "tag_assets",
      title: `Tagear ${awareness.untaggedCount} assets sem awareness`,
      reasoning: `${awareness.untaggedCount} criativos sem stage Schwartz. Sem tag, não dá pra cruzar copy × audiência.`,
      entity: { type: "product" },
      estimatedImpact: "permite recomendações automáticas de mismatch",
    });
  }

  // 7. CM negativo
  if (waterfall.contributionMargin < 0 && waterfall.spend > 0) {
    items.push({
      priority: 1,
      action: "reduce_budget",
      title: `URGENTE: CM negativo (R$${waterfall.contributionMargin.toFixed(0)} em ${waterfall.windowDays}d)`,
      reasoning: `Receita não cobre CAC + custos. ROAS ${waterfall.roas?.toFixed(2)}x, profit/venda ${waterfall.profitPerSale ? `R$${waterfall.profitPerSale}` : "—"}.`,
      entity: { type: "product" },
      estimatedImpact: "cortar 50% do budget e revisar oferta+criativo antes de continuar",
    });
  }

  // Ordena por prioridade e limita top 10
  items.sort((a, b) => a.priority - b.priority);
  return {
    generatedAt: new Date().toISOString(),
    items: items.slice(0, 10),
  };
}

// ════════════════════════════════════════════════════════════════
// 10. TIMESERIES — pra graficos Recharts.
// Retorna serie temporal de uma metrica em N dias.
// ════════════════════════════════════════════════════════════════

export type TimeseriesMetric = "cpa" | "roas" | "sales" | "spend" | "cm" | "hookRate";

export interface TimeseriesPoint {
  date: string; // YYYY-MM-DD
  value: number | null;
}

export interface TimeseriesResult {
  metric: TimeseriesMetric;
  windowDays: number;
  points: TimeseriesPoint[];
  current: number | null;
  previous: number | null;
  deltaPct: number | null;
}

export async function getTimeseries(
  productId: string,
  metric: TimeseriesMetric,
  windowDays = 14
): Promise<TimeseriesResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return { metric, windowDays, points: [], current: null, previous: null, deltaPct: null };
  }
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);

  // Carrega metrics e sales agregados por dia
  const [metrics, sales] = await Promise.all([
    prisma.metricEntry.findMany({
      where: { productId, date: { gte: cutoff } },
      select: { date: true, investment: true, salesKirvano: true, hookRate: true, impressions: true, threeSecondViews: true },
    }),
    prisma.sale.findMany({
      where: { productId, status: "approved", date: { gte: cutoff } },
      select: { date: true, amountGross: true, amountNet: true },
    }),
  ]);

  // Mapa por dia
  const byDate = new Map<
    string,
    { spend: number; sales: number; revenueGross: number; revenueNet: number; impressions: number; threeSec: number; hookRateSum: number; hookRateCount: number }
  >();
  for (let i = 0; i < windowDays; i++) {
    const d = addBRTDays(startOfBRTDay(), -i);
    const k = dateKey(d);
    byDate.set(k, { spend: 0, sales: 0, revenueGross: 0, revenueNet: 0, impressions: 0, threeSec: 0, hookRateSum: 0, hookRateCount: 0 });
  }
  for (const m of metrics) {
    const k = dateKey(m.date);
    const e = byDate.get(k);
    if (!e) continue;
    e.spend += m.investment;
    e.sales += m.salesKirvano;
    e.impressions += m.impressions;
    e.threeSec += m.threeSecondViews ?? 0;
    if (typeof m.hookRate === "number") {
      e.hookRateSum += m.hookRate;
      e.hookRateCount += 1;
    }
  }
  for (const s of sales) {
    const k = dateKey(s.date);
    const e = byDate.get(k);
    if (!e) continue;
    e.revenueGross += s.amountGross;
    e.revenueNet += s.amountNet;
  }

  const points: TimeseriesPoint[] = Array.from(byDate.entries())
    .sort()
    .map(([date, e]) => {
      let value: number | null = null;
      if (metric === "spend") value = Math.round(e.spend * 100) / 100;
      else if (metric === "sales") value = e.sales;
      else if (metric === "cpa")
        value = e.sales > 0 ? Math.round((e.spend / e.sales) * 100) / 100 : null;
      else if (metric === "roas")
        value = e.spend > 0 ? Math.round((e.revenueGross / e.spend) * 100) / 100 : null;
      else if (metric === "cm")
        value = Math.round((e.revenueNet - e.spend) * 100) / 100;
      else if (metric === "hookRate")
        value = e.hookRateCount > 0 ? Math.round((e.hookRateSum / e.hookRateCount) * 10) / 10 : null;
      return { date, value };
    });

  // Current vs previous (ultimo dia vs media dos ultimos 7d)
  const last = points[points.length - 1]?.value ?? null;
  const prev7 = points.slice(-8, -1).filter(p => p.value !== null).map(p => p.value!);
  const previous =
    prev7.length > 0 ? prev7.reduce((a, b) => a + b, 0) / prev7.length : null;
  const deltaPct =
    last !== null && previous !== null && previous !== 0
      ? Math.round(((last - previous) / Math.abs(previous)) * 1000) / 10
      : null;

  return {
    metric,
    windowDays,
    points,
    current: last,
    previous: previous !== null ? Math.round(previous * 100) / 100 : null,
    deltaPct,
  };
}

// ════════════════════════════════════════════════════════════════
// 11. BRIEFING CEO — gerado por LLM cruzando os outros analytics.
// ════════════════════════════════════════════════════════════════

export interface BriefingResult {
  productId: string;
  generatedAt: string;
  briefing: string; // markdown
  cached: boolean;
}

// Cache simples em memoria por productId, TTL 30min.
const briefingCache = new Map<string, { value: BriefingResult; expiresAt: number }>();
const BRIEFING_TTL_MS = 30 * 60 * 1000;

export async function getBriefing(
  productId: string,
  forceRefresh = false
): Promise<BriefingResult> {
  if (!forceRefresh) {
    const cached = briefingCache.get(productId);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.value, cached: true };
    }
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return {
      productId,
      generatedAt: new Date().toISOString(),
      briefing: "Produto não encontrado.",
      cached: false,
    };
  }

  const [waterfall, hitRate, fatigue, decisions, volume] = await Promise.all([
    getProfitWaterfall(productId, 7),
    getCreativeHitRate(productId, 30),
    getFatiguePredictions(productId),
    getDecisionQueue(productId),
    getCreativeVolumeScore(productId),
  ]);

  // Snapshot estruturado pro LLM
  const snapshot = {
    produto: product.name,
    stage: product.stage,
    janela: "ultimos 7 dias",
    economia: {
      receitaBruta: waterfall.grossRevenue,
      contributionMargin: waterfall.contributionMargin,
      cmPct: waterfall.contributionMarginPct,
      vendas: waterfall.approvedSales,
      profitPerSale: waterfall.profitPerSale,
      roas: waterfall.roas,
      deltaReceita: waterfall.delta.grossRevenuePct,
      deltaCm: waterfall.delta.cmPct,
      deltaVendas: waterfall.delta.salesPct,
    },
    criativos: {
      hitRate: hitRate.hitRatePct,
      winners: hitRate.buckets.winner,
      survivors: hitRate.buckets.survivor,
      losers: hitRate.buckets.loser,
      pending: hitRate.buckets.pendingDays + hitRate.buckets.pendingSpend,
      benchmarkElite: hitRate.benchmark.elite,
    },
    poolCriativo: {
      score: volume.totalScore,
      grade: volume.grade,
      launchesUltSemana: volume.launchesLast7d,
      idadeMediaDias: volume.poolAvgAgeDays,
    },
    fadiga: {
      criticos: fatigue.summary.critical,
      emQueda: fatigue.summary.declining,
      saudaveis: fatigue.summary.healthy,
    },
    proximasAcoes: decisions.items.slice(0, 5).map(d => ({
      acao: d.action,
      titulo: d.title,
      reasoning: d.reasoning,
    })),
  };

  // Tenta gerar via LLM. Se Anthropic não tá configurado, fallback determinístico.
  let briefing: string;
  try {
    const { complete, isLLMConfigured } = await import("../lib/llm");
    if (await isLLMConfigured()) {
      const system = `Voce e um gestor de trafego senior estilo Pedro Sobral, escrevendo briefing executivo em PT-BR pra dono do negocio.

REGRA DE FORMATACAO CRITICA:
- Escreva em CAPITALIZACAO NORMAL (frase maiuscula no inicio, resto minusculo). NUNCA em CAIXA ALTA.
- Markdown leve: ## pra titulo de secao, **palavra** pra negrito pontual, listas com "- ".
- Sem TODO o texto em maiusculas. Sem nomes inteiros em CAPS.

Estrutura obrigatoria (com EXATAMENTE essas 3 secoes):

## Situacao atual
2-3 linhas. Como o produto esta hoje. Foque em margem de contribuicao, ROAS e tendencia.

## O que o agente esta fazendo
2-3 linhas. Resumo das proximas 3 acoes automaticas. Explique o porque de cada uma.

## Proximos 7 dias
2-3 linhas. Projecao realista + 1 alerta se houver.

REGRAS:
- NAO usar jargao gringo sem explicar. Ex: se mencionar "knee", explique.
- Se algum dado esta zerado/imaturo, escreva "ainda sem dado suficiente" — NAO invente numero.
- Direto, denso, sem floreio. Frases curtas. Numero quando relevante.
- Tom de gestor experiente conversando com dono, nao manual tecnico.`;
      const user = `Snapshot do produto:\n\n${JSON.stringify(snapshot, null, 2)}`;
      briefing = await complete({ system, user, maxTokens: 700, temperature: 0.4 });
    } else {
      briefing = fallbackBriefing(snapshot);
    }
  } catch (err) {
    console.error(
      `[briefing] LLM falhou: ${err instanceof Error ? err.message : String(err)}`
    );
    briefing = fallbackBriefing(snapshot);
  }

  const result: BriefingResult = {
    productId,
    generatedAt: new Date().toISOString(),
    briefing,
    cached: false,
  };
  briefingCache.set(productId, { value: result, expiresAt: Date.now() + BRIEFING_TTL_MS });
  return result;
}

function fallbackBriefing(s: {
  economia: { contributionMargin: number; cmPct: number; vendas: number; roas: number | null; deltaCm: number | null };
  criativos: { hitRate: number; winners: number; losers: number; benchmarkElite: number };
  fadiga: { criticos: number; emQueda: number };
  proximasAcoes: Array<{ titulo: string; reasoning: string }>;
}): string {
  const cm = s.economia.contributionMargin;
  const status = cm > 0 ? "lucrativo" : cm === 0 ? "no zero a zero" : "no prejuizo";
  const lines: string[] = [];
  lines.push("## Situacao atual");
  lines.push(
    `Produto ${status} nos ultimos 7d (CM R$${cm.toFixed(0)}, ROAS ${s.economia.roas?.toFixed(2) ?? "—"}x, ${s.economia.vendas} vendas)${s.economia.deltaCm !== null ? ` — ${s.economia.deltaCm > 0 ? "+" : ""}${s.economia.deltaCm.toFixed(0)}% CM vs janela anterior` : ""}.`
  );
  lines.push("");
  lines.push("## O agente esta fazendo");
  if (s.proximasAcoes.length === 0) {
    lines.push("Sem acoes priorizadas no momento (pipeline saudavel ou sem dado suficiente).");
  } else {
    lines.push("Top acoes:");
    for (const a of s.proximasAcoes.slice(0, 3)) {
      lines.push(`- **${a.titulo}**: ${a.reasoning}`);
    }
  }
  lines.push("");
  lines.push("## Proximos 7 dias");
  lines.push(
    `Hit rate ${s.criativos.hitRate.toFixed(0)}% (elite ${s.criativos.benchmarkElite}%), ${s.criativos.winners} winners ativos, ${s.criativos.losers} losers a pausar. Fadiga: ${s.fadiga.criticos} criticos / ${s.fadiga.emQueda} em queda. ${s.fadiga.criticos > 0 ? "**Alerta**: substituir criativos criticos antes do CPA explodir." : "Sem alerta urgente."}`
  );
  return lines.join("\n");
}

// ════════════════════════════════════════════════════════════════
// 14. CEO REPORT — markdown executivo cruzando tudo (Onda Visual 3).
// ════════════════════════════════════════════════════════════════

export interface CeoReportResult {
  productId: string;
  productName: string;
  windowDays: number;
  generatedAt: string;
  markdown: string;
}

export async function getCeoReport(
  productId: string,
  windowDays = 7
): Promise<CeoReportResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return {
      productId,
      productName: "(?)",
      windowDays,
      generatedAt: new Date().toISOString(),
      markdown: "Produto não encontrado.",
    };
  }

  const [waterfall, hitRate, fatigue, decisions, volume, briefing, mismatches] =
    await Promise.all([
      getProfitWaterfall(productId, windowDays),
      getCreativeHitRate(productId, 30),
      getFatiguePredictions(productId),
      getDecisionQueue(productId),
      getCreativeVolumeScore(productId),
      getBriefing(productId, false),
      getAwarenessMismatches(productId, 30),
    ]);
  const { getMonthlyPace } = await import("../lib/monthly-pace");
  const pace = await getMonthlyPace(productId);

  const lines: string[] = [];
  const fmt = (v: number) =>
    new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
  const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(0)}%`);

  // 1. Cabecalho
  lines.push(`# Relatório CEO — ${product.name}`);
  lines.push("");
  lines.push(`**Período:** últimos ${windowDays} dias · **Stage:** ${product.stage}`);
  lines.push(`**Gerado:** ${new Date().toLocaleString("pt-BR")}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // 2. Resumo financeiro
  lines.push("## 1. Resumo financeiro");
  lines.push("");
  lines.push(`| Métrica | Valor | Δ vs período anterior |`);
  lines.push(`|---|---|---|`);
  lines.push(
    `| Receita bruta | ${fmt(waterfall.grossRevenue)} | ${pct(waterfall.delta.grossRevenuePct)} |`
  );
  lines.push(
    `| Receita líquida | ${fmt(waterfall.netRevenue)} | — |`
  );
  lines.push(
    `| Spend Meta | ${fmt(waterfall.spend)} | — |`
  );
  lines.push(
    `| **Contribution margin** | **${fmt(waterfall.contributionMargin)} (${waterfall.contributionMarginPct.toFixed(1)}%)** | ${pct(waterfall.delta.cmPct)} |`
  );
  lines.push(`| Vendas | ${waterfall.approvedSales} | ${pct(waterfall.delta.salesPct)} |`);
  lines.push(
    `| Profit/venda | ${waterfall.profitPerSale !== null ? fmt(waterfall.profitPerSale) : "—"} | — |`
  );
  lines.push(
    `| ROAS | ${waterfall.roas !== null ? `${waterfall.roas.toFixed(2)}x` : "—"} | — |`
  );
  lines.push("");

  // Detalhe waterfall
  lines.push("**Waterfall detalhado:**");
  lines.push("");
  for (const step of waterfall.steps) {
    const prefix = step.kind === "result" ? "**" : "";
    lines.push(`- ${prefix}${step.label}: ${fmt(step.value)} (${step.pct.toFixed(0)}%)${prefix}`);
  }
  lines.push("");

  // 3. Pacing mensal
  if (pace.status !== "no_goal" && pace.targetSales !== null) {
    const statusLabel: Record<string, string> = {
      ahead: "🟢 ADIANTE",
      on_track: "🔵 NO RITMO",
      behind: "🟡 ATRÁS",
      critical: "🔴 CRÍTICO",
    };
    lines.push("## 2. Pacing mensal");
    lines.push("");
    lines.push(`**Status:** ${statusLabel[pace.status] ?? pace.status}`);
    lines.push("");
    lines.push(`- Meta: ${pace.targetSales} vendas em ${pace.daysInMonth} dias`);
    lines.push(
      `- Realizado até hoje (D${pace.dayOfMonth}): ${pace.currentSales} vendas (${Math.round((pace.currentSales / pace.targetSales) * 100)}%)`
    );
    lines.push(
      `- Pace projetado linear: ${pace.pace ?? "—"} vendas (${pace.paceRatio !== null ? Math.round(pace.paceRatio * 100) : "—"}% da meta)`
    );
    if (pace.requiredDailySales !== null) {
      lines.push(
        `- Necessário: ${pace.requiredDailySales} vendas/dia nos próximos ${pace.daysLeft} dias`
      );
    }
    if (pace.scaleThresholdAdjust !== 1.0) {
      lines.push(
        `- **Agente ajustou threshold de scale em ×${pace.scaleThresholdAdjust.toFixed(2)}** (${pace.scaleThresholdAdjust > 1 ? "mais agressivo" : "mais conservador"})`
      );
    }
    lines.push("");
  }

  // 4. Saúde do pool de criativo
  lines.push(`## ${pace.status !== "no_goal" ? "3" : "2"}. Saúde do pool criativo`);
  lines.push("");
  lines.push(
    `**Score:** ${volume.totalScore}/100 · **Grade:** ${volume.grade.toUpperCase()}`
  );
  lines.push("");
  lines.push(`- Lançamentos últimos 7d: **${volume.launchesLast7d}** (ideal 5-7)`);
  lines.push(`- Lançamentos últimos 30d: ${volume.launchesLast30d} (ideal 20-30)`);
  lines.push(`- Pool ativo: ${volume.poolActive} criativos`);
  lines.push(`- Idade média: **${volume.poolAvgAgeDays.toFixed(1)} dias**`);
  lines.push(`- Hit rate 30d: ${hitRate.hitRatePct.toFixed(1)}% (elite ${hitRate.benchmark.elite}% / mediano ${hitRate.benchmark.mediano}%)`);
  lines.push("");
  if (volume.recommendations.length > 0) {
    lines.push("**Recomendações pipeline:**");
    for (const r of volume.recommendations) lines.push(`- ${r}`);
    lines.push("");
  }

  // 5. Buckets criativo
  lines.push("**Distribuição:**");
  lines.push("");
  lines.push(`- 🏆 Winners: **${hitRate.buckets.winner}**`);
  lines.push(`- ✅ Survivors (lucram mas não escalam): ${hitRate.buckets.survivor}`);
  lines.push(`- 💀 Losers: ${hitRate.buckets.loser}`);
  lines.push(`- ⏳ Pending (sem dado suficiente): ${hitRate.buckets.pendingDays + hitRate.buckets.pendingSpend}`);
  lines.push("");

  // Top winners + losers
  if (hitRate.topWinners.length > 0) {
    lines.push("**Top winners:**");
    for (const w of hitRate.topWinners.slice(0, 3)) {
      lines.push(
        `- ${w.name} — CPA ${w.cpa ? fmt(w.cpa) : "—"}, ${w.salesEstimated} vendas, ${w.velocityPerDay.toFixed(2)}/d, ${w.daysActive}d ativo`
      );
    }
    lines.push("");
  }
  if (hitRate.worstLosers.length > 0) {
    lines.push("**Piores losers (pausar):**");
    for (const l of hitRate.worstLosers.slice(0, 3)) {
      lines.push(
        `- ${l.name} — CPA ${l.cpa ? fmt(l.cpa) : "—"}, queimou ${fmt(l.spendEstimated)} em ${l.daysActive}d sem retorno`
      );
    }
    lines.push("");
  }

  // 6. Fadiga
  if (fatigue.summary.critical > 0 || fatigue.summary.declining > 0) {
    lines.push(`## ${pace.status !== "no_goal" ? "4" : "3"}. Fadiga predictiva`);
    lines.push("");
    lines.push(
      `🔴 ${fatigue.summary.critical} críticos · 🟡 ${fatigue.summary.declining} em queda · 🟢 ${fatigue.summary.healthy} saudáveis`
    );
    lines.push("");
    const urgent = fatigue.predictions
      .filter(p => p.status === "critical" || p.status === "declining")
      .slice(0, 5);
    if (urgent.length > 0) {
      for (const p of urgent) {
        const emoji = p.status === "critical" ? "🔴" : "🟡";
        lines.push(`- ${emoji} **${p.name}** — ${p.reason}${p.daysToDeath ? ` · morte em ~${p.daysToDeath}d` : ""}`);
      }
      lines.push("");
    }
  }

  // 7. Awareness mismatches
  if (mismatches.bySeverity.mismatch > 0 || mismatches.bySeverity.warn > 0) {
    const sec = pace.status !== "no_goal" ? 5 : 4;
    lines.push(`## ${sec}. Awareness × Audiência (Schwartz)`);
    lines.push("");
    lines.push(
      `🔴 ${mismatches.bySeverity.mismatch} mismatches graves · 🟡 ${mismatches.bySeverity.warn} fracos · ✅ ${mismatches.bySeverity.ideal} ideais · ⚪ ${mismatches.bySeverity.untagged} sem tag`
    );
    lines.push("");
    const grave = mismatches.items.filter(m => m.matchScore === "mismatch").slice(0, 3);
    for (const m of grave) {
      lines.push(`- 🔴 **${m.creativeName}** — stage ${m.awarenessStage} em ${m.audience} (${m.cpa ? fmt(m.cpa) : "CPA —"})`);
    }
    if (grave.length > 0) lines.push("");
  }

  // 8. Decisões priorizadas
  const sec2 = pace.status !== "no_goal" ? 6 : 5;
  lines.push(`## ${sec2}. Top 5 ações priorizadas pelo agente`);
  lines.push("");
  if (decisions.items.length === 0) {
    lines.push("Nenhuma ação urgente.");
  } else {
    decisions.items.slice(0, 5).forEach((d, i) => {
      lines.push(`${i + 1}. **${d.title}**`);
      lines.push(`   - ${d.reasoning}`);
      if (d.estimatedImpact) lines.push(`   - Impacto: ${d.estimatedImpact}`);
      lines.push("");
    });
  }

  // 9. Briefing IA
  const sec3 = pace.status !== "no_goal" ? 7 : 6;
  lines.push(`## ${sec3}. Briefing executivo (IA)`);
  lines.push("");
  lines.push(briefing.briefing);
  lines.push("");

  // 10. Footer
  lines.push("---");
  lines.push("");
  lines.push("_Gerado pelo agente Pedro Sobral integrado · Bravy Dashboard de Tráfego_");

  return {
    productId,
    productName: product.name,
    windowDays,
    generatedAt: new Date().toISOString(),
    markdown: lines.join("\n"),
  };
}

// ════════════════════════════════════════════════════════════════
// 13. AWARENESS MISMATCH — Item 1 do roadmap Sobral.
// Cruza Creative.awarenessStage × Campaign.type. Lista criativos em
// audiencia errada. Princípio Schwartz aplicado em decisao.
// ════════════════════════════════════════════════════════════════

export interface AwarenessMismatchResult {
  productId: string;
  total: number;
  bySeverity: { mismatch: number; warn: number; ok: number; ideal: number; untagged: number };
  items: CreativeMismatch[];
}

export async function getAwarenessMismatches(
  productId: string,
  windowDays = 30
): Promise<AwarenessMismatchResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);

  const creatives = await prisma.creative.findMany({
    where: { productId, status: "active", createdAt: { gte: cutoff } },
    include: { campaign: { select: { name: true, type: true } } },
  });

  const bySeverity = { mismatch: 0, warn: 0, ok: 0, ideal: 0, untagged: 0 };
  const items: CreativeMismatch[] = [];

  for (const c of creatives) {
    if (!c.awarenessStage) {
      bySeverity.untagged += 1;
      continue;
    }
    if (!c.campaign?.type) continue;

    const match = evaluateAwarenessMatch(
      c.awarenessStage as AwarenessStageType,
      c.campaign.type
    );
    if (!match) continue;

    bySeverity[match.score] += 1;

    // So expoe items com problema (warn ou mismatch). Ideal/ok nao precisa
    // mostrar — sao expectativa.
    if (match.score === "warn" || match.score === "mismatch") {
      items.push({
        creativeId: c.id,
        creativeName: c.name,
        awarenessStage: c.awarenessStage as AwarenessStageType,
        audience: c.campaign.type as AwarenessAudienceType,
        campaignName: c.campaign.name,
        cpa: c.cpa,
        hookRate: c.hookRate,
        matchScore: match.score,
        reason: match.reason,
      });
    }
  }

  // Ordena por gravidade (mismatch primeiro, warn depois) + maior CPA primeiro.
  items.sort((a, b) => {
    if (a.matchScore !== b.matchScore) {
      return a.matchScore === "mismatch" ? -1 : 1;
    }
    return (b.cpa ?? 0) - (a.cpa ?? 0);
  });

  return {
    productId,
    total: creatives.length,
    bySeverity,
    items: items.slice(0, 20),
  };
}

// ════════════════════════════════════════════════════════════════
// 12. GLOBAL OVERVIEW — agregado multi-produto pra /global.
// ════════════════════════════════════════════════════════════════

export interface GlobalOverviewProduct {
  productId: string;
  slug: string;
  name: string;
  stage: string;
  spend: number;
  sales: number;
  revenue: number;
  cm: number;
  cpa: number | null;
  roas: number | null;
  alerts: number;
  health: "elite" | "bom" | "mediano" | "critico";
}

export interface GlobalOverviewResult {
  windowDays: number;
  totals: { spend: number; sales: number; revenue: number; cm: number; cpa: number | null; roas: number | null };
  products: GlobalOverviewProduct[];
  topAlerts: Array<{ productSlug: string; type: string; detail: string }>;
}

export async function getGlobalOverview(windowDays = 7): Promise<GlobalOverviewResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);

  const products = await prisma.product.findMany({
    where: { status: "active" },
    orderBy: { createdAt: "desc" },
  });

  const productResults: GlobalOverviewProduct[] = [];
  const totals = { spend: 0, sales: 0, revenue: 0, cm: 0 };

  for (const p of products) {
    const [metricsAgg, salesAgg, alerts] = await Promise.all([
      prisma.metricEntry.aggregate({
        where: { productId: p.id, date: { gte: cutoff } },
        _sum: { investment: true },
      }),
      prisma.sale.aggregate({
        where: { productId: p.id, status: "approved", date: { gte: cutoff } },
        _sum: { amountGross: true, amountNet: true },
        _count: true,
      }),
      prisma.alertDedup.count({ where: { productId: p.id, lastState: "active" } }),
    ]);

    const spend = metricsAgg._sum.investment || 0;
    const sales = salesAgg._count || 0;
    const revenue = salesAgg._sum.amountGross || 0;
    const netRevenue = salesAgg._sum.amountNet || 0;
    const cm = netRevenue - spend;
    const cpa = sales > 0 ? Math.round((spend / sales) * 100) / 100 : null;
    const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : null;

    let health: GlobalOverviewProduct["health"];
    if (cm <= 0 && spend > 0) health = "critico";
    else if (roas !== null && roas >= 2.5) health = "elite";
    else if (roas !== null && roas >= 1.6) health = "bom";
    else health = "mediano";

    totals.spend += spend;
    totals.sales += sales;
    totals.revenue += revenue;
    totals.cm += cm;

    productResults.push({
      productId: p.id,
      slug: p.slug,
      name: p.name,
      stage: p.stage,
      spend: Math.round(spend * 100) / 100,
      sales,
      revenue: Math.round(revenue * 100) / 100,
      cm: Math.round(cm * 100) / 100,
      cpa,
      roas,
      alerts,
      health,
    });
  }

  // Top alertas globais
  const recentAlerts = await prisma.alertDedup.findMany({
    where: { lastState: "active" },
    include: { product: { select: { slug: true } } },
    orderBy: { lastSentAt: "desc" },
    take: 10,
  });
  const topAlerts = recentAlerts.map(a => ({
    productSlug: a.product?.slug || "?",
    type: a.key,
    detail: a.lastState,
  }));

  productResults.sort((a, b) => b.cm - a.cm); // ranking por profit

  return {
    windowDays,
    totals: {
      spend: Math.round(totals.spend * 100) / 100,
      sales: totals.sales,
      revenue: Math.round(totals.revenue * 100) / 100,
      cm: Math.round(totals.cm * 100) / 100,
      cpa: totals.sales > 0 ? Math.round((totals.spend / totals.sales) * 100) / 100 : null,
      roas: totals.spend > 0 ? Math.round((totals.revenue / totals.spend) * 100) / 100 : null,
    },
    products: productResults,
    topAlerts,
  };
}

// ════════════════════════════════════════════════════════════════
// 5. AWARENESS x AUDIENCE TYPE — cross-tab (Schwartz).
// ════════════════════════════════════════════════════════════════

const AUDIENCE_TYPES = ["Prospecção", "Remarketing", "ASC"] as const;
type AudienceType = (typeof AUDIENCE_TYPES)[number];
const STAGES_ORDER = [
  "unaware",
  "problem",
  "solution",
  "product",
  "most_aware",
  "untagged",
] as const;

export interface AwarenessCell {
  count: number;
  avgCpa: number | null;
  avgHookRate: number | null;
  winners: number;
  winnerRate: number;
}

export interface AwarenessRowGrouped {
  stage: string;
  cells: Record<AudienceType, AwarenessCell>;
  total: AwarenessCell;
}

export interface AwarenessResult {
  audienceTypes: readonly AudienceType[];
  rows: AwarenessRowGrouped[];
  taggedCount: number;
  untaggedCount: number;
  bestPair: { stage: string; audience: AudienceType; winnerRate: number } | null;
  worstPair: { stage: string; audience: AudienceType; winnerRate: number } | null;
}

export async function getAwarenessAnalytics(
  productId: string,
  windowDays = 30
): Promise<AwarenessResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);

  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product) {
    return {
      audienceTypes: AUDIENCE_TYPES,
      rows: [],
      taggedCount: 0,
      untaggedCount: 0,
      bestPair: null,
      worstPair: null,
    };
  }
  const econ = thresholdsFor(product);
  const winnerCPAThreshold = econ.autoScaleCPAThreshold;

  const creatives = await prisma.creative.findMany({
    where: { productId, createdAt: { gte: cutoff } },
    include: { campaign: { select: { type: true } } },
  });

  function emptyCell(): AwarenessCell {
    return { count: 0, avgCpa: null, avgHookRate: null, winners: 0, winnerRate: 0 };
  }
  function emptyRow(stage: string): AwarenessRowGrouped {
    return {
      stage,
      cells: {
        Prospecção: emptyCell(),
        Remarketing: emptyCell(),
        ASC: emptyCell(),
      },
      total: emptyCell(),
    };
  }

  const rowsMap = new Map<string, AwarenessRowGrouped>();
  for (const stage of STAGES_ORDER) rowsMap.set(stage, emptyRow(stage));

  // Acumuladores temporarios (somas para average)
  const sums = new Map<
    string,
    Record<AudienceType | "total", { cpaSum: number; cpaCount: number; hookSum: number; hookCount: number }>
  >();
  function getSums(stage: string) {
    let s = sums.get(stage);
    if (!s) {
      s = {
        Prospecção: { cpaSum: 0, cpaCount: 0, hookSum: 0, hookCount: 0 },
        Remarketing: { cpaSum: 0, cpaCount: 0, hookSum: 0, hookCount: 0 },
        ASC: { cpaSum: 0, cpaCount: 0, hookSum: 0, hookCount: 0 },
        total: { cpaSum: 0, cpaCount: 0, hookSum: 0, hookCount: 0 },
      };
      sums.set(stage, s);
    }
    return s;
  }

  let untagged = 0;
  for (const c of creatives) {
    const stage = c.awarenessStage || "untagged";
    if (!c.awarenessStage) untagged += 1;
    const audienceRaw = c.campaign?.type || "Prospecção";
    const audience: AudienceType = AUDIENCE_TYPES.includes(audienceRaw as AudienceType)
      ? (audienceRaw as AudienceType)
      : "Prospecção";

    const row = rowsMap.get(stage) || emptyRow(stage);
    rowsMap.set(stage, row);

    row.cells[audience].count += 1;
    row.total.count += 1;

    const ss = getSums(stage);
    if (c.cpa !== null && c.cpa > 0) {
      ss[audience].cpaSum += c.cpa;
      ss[audience].cpaCount += 1;
      ss.total.cpaSum += c.cpa;
      ss.total.cpaCount += 1;
      const isWinner = c.cpa <= winnerCPAThreshold;
      if (isWinner) {
        row.cells[audience].winners += 1;
        row.total.winners += 1;
      }
    }
    if (c.hookRate !== null) {
      ss[audience].hookSum += c.hookRate;
      ss[audience].hookCount += 1;
      ss.total.hookSum += c.hookRate;
      ss.total.hookCount += 1;
    }
  }

  // Calcula averages e winnerRate
  for (const [stage, row] of rowsMap) {
    const ss = sums.get(stage);
    if (!ss) continue;
    for (const audience of AUDIENCE_TYPES) {
      const cell = row.cells[audience];
      const a = ss[audience];
      cell.avgCpa = a.cpaCount > 0 ? Math.round((a.cpaSum / a.cpaCount) * 100) / 100 : null;
      cell.avgHookRate = a.hookCount > 0 ? Math.round((a.hookSum / a.hookCount) * 10) / 10 : null;
      cell.winnerRate = cell.count > 0 ? Math.round((cell.winners / cell.count) * 1000) / 10 : 0;
    }
    const total = row.total;
    const t = ss.total;
    total.avgCpa = t.cpaCount > 0 ? Math.round((t.cpaSum / t.cpaCount) * 100) / 100 : null;
    total.avgHookRate = t.hookCount > 0 ? Math.round((t.hookSum / t.hookCount) * 10) / 10 : null;
    total.winnerRate =
      total.count > 0 ? Math.round((total.winners / total.count) * 1000) / 10 : 0;
  }

  // best/worst pair (so com count >= 3 pra evitar ruido)
  let bestPair: AwarenessResult["bestPair"] = null;
  let worstPair: AwarenessResult["worstPair"] = null;
  for (const row of rowsMap.values()) {
    if (row.stage === "untagged") continue;
    for (const audience of AUDIENCE_TYPES) {
      const cell = row.cells[audience];
      if (cell.count < 3) continue;
      if (!bestPair || cell.winnerRate > bestPair.winnerRate) {
        bestPair = { stage: row.stage, audience, winnerRate: cell.winnerRate };
      }
      if (!worstPair || cell.winnerRate < worstPair.winnerRate) {
        worstPair = { stage: row.stage, audience, winnerRate: cell.winnerRate };
      }
    }
  }

  const rows = STAGES_ORDER.map(s => rowsMap.get(s)!).filter(r => r.total.count > 0);
  return {
    audienceTypes: AUDIENCE_TYPES,
    rows,
    taggedCount: creatives.length - untagged,
    untaggedCount: untagged,
    bestPair,
    worstPair,
  };
}
