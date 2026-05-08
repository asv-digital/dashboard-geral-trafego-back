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
  kind: "input" | "deduction" | "addition" | "result";
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
  const upsellRevenue = mentoriaCount * (product.mentoriaUpsellValue || 0);
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
    { label: "− CAC (spend Meta)", value: -current.spend, pct: -safePct(current.spend), kind: "deduction" },
    { label: "− Imposto estimado", value: -current.taxEstimate, pct: -safePct(current.taxEstimate), kind: "deduction" },
    { label: "= Contribution margin", value: current.contributionMargin, pct: cmPct, kind: "result" },
  ];

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
