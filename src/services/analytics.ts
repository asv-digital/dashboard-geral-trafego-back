// Analytics elite-grade: hit rate, profit waterfall, payback cohort,
// LTV cohort, awareness x CPA. Cada funcao retorna estrutura JSON-friendly
// pronta pra UI (sem post-processing no front).

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
// 1. HIT RATE — % de criativos lancados em N dias que viraram winner.
// Winner = CPA <= autoScaleCPAThreshold em pelo menos 3 dias com vendas.
// ════════════════════════════════════════════════════════════════

export interface HitRateResult {
  windowDays: number;
  totalLaunched: number;
  winners: number;
  losers: number;
  pendingEvaluation: number; // criativos lancados mas sem dados suficientes
  hitRatePct: number;
  benchmark: { elite: number; mediano: number }; // 25 / 12 (% mercado)
  topWinners: Array<{
    id: string;
    name: string;
    type: string;
    cpa: number | null;
    hookRate: number | null;
    ctr: number | null;
    daysActive: number;
  }>;
  worstLosers: Array<{
    id: string;
    name: string;
    type: string;
    cpa: number | null;
    hookRate: number | null;
    ctr: number | null;
    daysActive: number;
  }>;
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
      totalLaunched: 0,
      winners: 0,
      losers: 0,
      pendingEvaluation: 0,
      hitRatePct: 0,
      benchmark: { elite: 25, mediano: 12 },
      topWinners: [],
      worstLosers: [],
    };
  }
  const econ = thresholdsFor(product);
  const winnerCPAThreshold = econ.autoScaleCPAThreshold;
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);

  const creatives = await prisma.creative.findMany({
    where: { productId, createdAt: { gte: cutoff } },
    orderBy: { createdAt: "desc" },
  });

  let winners = 0;
  let losers = 0;
  let pending = 0;
  const winnersList: HitRateResult["topWinners"] = [];
  const losersList: HitRateResult["worstLosers"] = [];

  for (const c of creatives) {
    const ageDays = Math.floor(
      (Date.now() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24)
    );
    const item = {
      id: c.id,
      name: c.name,
      type: c.type,
      cpa: c.cpa,
      hookRate: c.hookRate,
      ctr: c.ctr,
      daysActive: ageDays,
    };
    // Pending: < 3 dias ou sem CPA calculado
    if (ageDays < 3 || c.cpa === null) {
      pending += 1;
      continue;
    }
    if (c.cpa > 0 && c.cpa <= winnerCPAThreshold) {
      winners += 1;
      winnersList.push(item);
    } else {
      losers += 1;
      losersList.push(item);
    }
  }

  const total = creatives.length;
  const evaluated = winners + losers;
  const hitRatePct = evaluated > 0 ? (winners / evaluated) * 100 : 0;

  return {
    windowDays,
    totalLaunched: total,
    winners,
    losers,
    pendingEvaluation: pending,
    hitRatePct: Math.round(hitRatePct * 10) / 10,
    benchmark: { elite: 25, mediano: 12 },
    topWinners: winnersList
      .sort((a, b) => (a.cpa ?? Infinity) - (b.cpa ?? Infinity))
      .slice(0, 5),
    worstLosers: losersList
      .sort((a, b) => (b.cpa ?? 0) - (a.cpa ?? 0))
      .slice(0, 5),
  };
}

// ════════════════════════════════════════════════════════════════
// 2. PROFIT WATERFALL — receita -> fee -> spend -> margem.
// Mostra quanto vc levou pra casa, nao ROAS de vaidade.
// ════════════════════════════════════════════════════════════════

export interface ProfitWaterfallResult {
  windowDays: number;
  steps: Array<{ label: string; value: number; pct: number }>;
  contributionMargin: number;
  contributionMarginPct: number;
  roas: number | null;
  spend: number;
  grossRevenue: number;
}

export async function getProfitWaterfall(
  productId: string,
  windowDays = 7
): Promise<ProfitWaterfallResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
  });
  if (!product) {
    return {
      windowDays,
      steps: [],
      contributionMargin: 0,
      contributionMarginPct: 0,
      roas: null,
      spend: 0,
      grossRevenue: 0,
    };
  }
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);

  const [salesAgg, metricsAgg] = await Promise.all([
    prisma.sale.aggregate({
      where: { productId, status: "approved", date: { gte: cutoff } },
      _sum: { amountGross: true, amountNet: true },
      _count: true,
    }),
    prisma.metricEntry.aggregate({
      where: { productId, date: { gte: cutoff } },
      _sum: { investment: true },
    }),
  ]);

  const grossRevenue = salesAgg._sum.amountGross || 0;
  const netRevenue = salesAgg._sum.amountNet || 0;
  const gatewayFee = grossRevenue - netRevenue;
  const spend = metricsAgg._sum.investment || 0;
  const cm = netRevenue - spend;
  const cmPct = grossRevenue > 0 ? (cm / grossRevenue) * 100 : 0;
  const roas = spend > 0 ? grossRevenue / spend : null;

  const safePct = (n: number) => (grossRevenue > 0 ? (n / grossRevenue) * 100 : 0);
  const steps = [
    { label: "Receita bruta", value: grossRevenue, pct: 100 },
    { label: "− Gateway fee", value: -gatewayFee, pct: -safePct(gatewayFee) },
    { label: "= Receita líquida", value: netRevenue, pct: safePct(netRevenue) },
    { label: "− CAC (spend Meta)", value: -spend, pct: -safePct(spend) },
    {
      label: "= Contribution margin",
      value: cm,
      pct: cmPct,
    },
  ];

  return {
    windowDays,
    steps,
    contributionMargin: cm,
    contributionMarginPct: Math.round(cmPct * 10) / 10,
    roas: roas ? Math.round(roas * 100) / 100 : null,
    spend,
    grossRevenue,
  };
}

// ════════════════════════════════════════════════════════════════
// 3. PAYBACK COHORT — D1 paid → D7/14/30 cumulative.
// Pra cada dia: quanto se gastou e quanto retornou em revenue
// cumulativa do mesmo periodo. Decide ousadia de bid.
// ════════════════════════════════════════════════════════════════

export interface PaybackCohortRow {
  cohortDate: string; // YYYY-MM-DD
  spend: number;
  cumRevenueD1: number;
  cumRevenueD7: number;
  cumRevenueD14: number;
  cumRevenueD30: number;
  paybackDay: number | null; // dia em que cumRevenue >= spend (null = nao pagou ainda)
}

export interface PaybackCohortResult {
  windowDays: number;
  rows: PaybackCohortRow[];
  avgPaybackDays: number | null;
}

export async function getPaybackCohort(
  productId: string,
  windowDays = 30
): Promise<PaybackCohortResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);
  const now = new Date();

  // Spend por dia (de MetricEntry)
  const metrics = await prisma.metricEntry.findMany({
    where: { productId, date: { gte: cutoff } },
    select: { date: true, investment: true },
  });
  const spendByDate = new Map<string, number>();
  for (const m of metrics) {
    const k = m.date.toISOString().slice(0, 10);
    spendByDate.set(k, (spendByDate.get(k) || 0) + m.investment);
  }

  // Sales por dia (only approved)
  const sales = await prisma.sale.findMany({
    where: { productId, status: "approved", date: { gte: cutoff } },
    select: { date: true, amountNet: true },
  });
  const salesByDate = new Map<string, number>();
  for (const s of sales) {
    const k = s.date.toISOString().slice(0, 10);
    salesByDate.set(k, (salesByDate.get(k) || 0) + s.amountNet);
  }

  const rows: PaybackCohortRow[] = [];
  const allDates = Array.from(
    new Set([...spendByDate.keys(), ...salesByDate.keys()])
  ).sort();

  let paybackSum = 0;
  let paybackCount = 0;

  for (const cohortDate of allDates) {
    const spend = spendByDate.get(cohortDate) || 0;
    if (spend === 0) continue;

    const cohort = new Date(cohortDate + "T00:00:00.000Z");
    const calcCum = (offsetDays: number): number => {
      const end = new Date(cohort);
      end.setUTCDate(end.getUTCDate() + offsetDays);
      if (end > now) return Number.NaN; // nao maturou ainda
      let acc = 0;
      for (let d = 0; d <= offsetDays; d++) {
        const date = new Date(cohort);
        date.setUTCDate(date.getUTCDate() + d);
        acc += salesByDate.get(date.toISOString().slice(0, 10)) || 0;
      }
      return acc;
    };

    const cumD1 = calcCum(1);
    const cumD7 = calcCum(7);
    const cumD14 = calcCum(14);
    const cumD30 = calcCum(30);

    // Dia em que payback ocorreu
    let paybackDay: number | null = null;
    let acc = 0;
    for (let d = 0; d <= 60; d++) {
      const date = new Date(cohort);
      date.setUTCDate(date.getUTCDate() + d);
      if (date > now) break;
      acc += salesByDate.get(date.toISOString().slice(0, 10)) || 0;
      if (acc >= spend) {
        paybackDay = d;
        break;
      }
    }
    if (paybackDay !== null) {
      paybackSum += paybackDay;
      paybackCount += 1;
    }

    rows.push({
      cohortDate,
      spend: Math.round(spend * 100) / 100,
      cumRevenueD1: Number.isNaN(cumD1) ? 0 : Math.round(cumD1 * 100) / 100,
      cumRevenueD7: Number.isNaN(cumD7) ? 0 : Math.round(cumD7 * 100) / 100,
      cumRevenueD14: Number.isNaN(cumD14) ? 0 : Math.round(cumD14 * 100) / 100,
      cumRevenueD30: Number.isNaN(cumD30) ? 0 : Math.round(cumD30 * 100) / 100,
      paybackDay,
    });
  }

  return {
    windowDays,
    rows,
    avgPaybackDays:
      paybackCount > 0 ? Math.round((paybackSum / paybackCount) * 10) / 10 : null,
  };
}

// ════════════════════════════════════════════════════════════════
// 4. LTV COHORT — agrupado por semana de aquisicao.
// Cada semana: # buyers, revenue cumulativa em N janelas.
// ════════════════════════════════════════════════════════════════

export interface LtvCohortRow {
  cohortWeek: string; // ISO week start (YYYY-MM-DD da segunda)
  buyers: number;
  ltvD7: number;
  ltvD14: number;
  ltvD30: number;
  ltvD60: number;
}

export interface LtvCohortResult {
  windowDays: number;
  rows: LtvCohortRow[];
}

function isoWeekStart(date: Date): string {
  const d = new Date(date);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

export async function getLtvCohort(
  productId: string,
  windowDays = 90
): Promise<LtvCohortResult> {
  const cutoff = addBRTDays(startOfBRTDay(), -windowDays);
  const now = new Date();

  // Acha primeira venda de cada email/customer (cohort week)
  const sales = await prisma.sale.findMany({
    where: { productId, status: "approved", date: { gte: cutoff } },
    select: { customerEmail: true, date: true, amountNet: true },
    orderBy: { date: "asc" },
  });

  // Map customer → primeiro buy date
  const firstBuyByCustomer = new Map<string, Date>();
  for (const s of sales) {
    if (!s.customerEmail) continue;
    if (!firstBuyByCustomer.has(s.customerEmail)) {
      firstBuyByCustomer.set(s.customerEmail, s.date);
    }
  }

  // Agrupa customers por cohortWeek (semana da primeira compra)
  const cohortByWeek = new Map<
    string,
    { buyers: Set<string>; firstBuyDates: Map<string, Date> }
  >();
  for (const [email, firstDate] of firstBuyByCustomer) {
    const week = isoWeekStart(firstDate);
    const entry = cohortByWeek.get(week) ?? {
      buyers: new Set<string>(),
      firstBuyDates: new Map<string, Date>(),
    };
    entry.buyers.add(email);
    entry.firstBuyDates.set(email, firstDate);
    cohortByWeek.set(week, entry);
  }

  // Pra cada cohort, soma revenue desses customers nos D+N days
  const rows: LtvCohortRow[] = [];
  const sortedWeeks = Array.from(cohortByWeek.keys()).sort();

  for (const week of sortedWeeks) {
    const cohort = cohortByWeek.get(week)!;
    const buyers = cohort.buyers.size;
    const calcLtv = (offsetDays: number): number => {
      let total = 0;
      for (const email of cohort.buyers) {
        const firstBuy = cohort.firstBuyDates.get(email)!;
        const cutoffEnd = new Date(firstBuy);
        cutoffEnd.setUTCDate(cutoffEnd.getUTCDate() + offsetDays);
        if (cutoffEnd > now) {
          // Cohort ainda nao maturou pra essa janela — soma so o que existe
        }
        for (const s of sales) {
          if (s.customerEmail !== email) continue;
          if (s.date >= firstBuy && s.date <= cutoffEnd) {
            total += s.amountNet;
          }
        }
      }
      return buyers > 0 ? total / buyers : 0;
    };

    rows.push({
      cohortWeek: week,
      buyers,
      ltvD7: Math.round(calcLtv(7) * 100) / 100,
      ltvD14: Math.round(calcLtv(14) * 100) / 100,
      ltvD30: Math.round(calcLtv(30) * 100) / 100,
      ltvD60: Math.round(calcLtv(60) * 100) / 100,
    });
  }

  return { windowDays, rows };
}

// ════════════════════════════════════════════════════════════════
// 5. AWARENESS x CPA — cruzamento copy stage × performance.
// ════════════════════════════════════════════════════════════════

export interface AwarenessRow {
  stage: string;
  creativeCount: number;
  avgCpa: number | null;
  avgHookRate: number | null;
  winnerRate: number; // % desses criativos que viraram winner
}

export interface AwarenessResult {
  rows: AwarenessRow[];
  taggedCount: number;
  untaggedCount: number;
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
    return { rows: [], taggedCount: 0, untaggedCount: 0 };
  }
  const econ = thresholdsFor(product);
  const winnerCPAThreshold = econ.autoScaleCPAThreshold;

  const creatives = await prisma.creative.findMany({
    where: { productId, createdAt: { gte: cutoff } },
  });

  const byStage = new Map<
    string,
    { count: number; cpas: number[]; hookRates: number[]; winners: number }
  >();
  let untagged = 0;

  for (const c of creatives) {
    const stage = c.awarenessStage || "untagged";
    if (stage === "untagged") untagged += 1;
    const entry = byStage.get(stage) ?? {
      count: 0,
      cpas: [],
      hookRates: [],
      winners: 0,
    };
    entry.count += 1;
    if (c.cpa !== null && c.cpa > 0) entry.cpas.push(c.cpa);
    if (c.hookRate !== null) entry.hookRates.push(c.hookRate);
    if (c.cpa !== null && c.cpa > 0 && c.cpa <= winnerCPAThreshold) {
      entry.winners += 1;
    }
    byStage.set(stage, entry);
  }

  const stagesOrder = ["unaware", "problem", "solution", "product", "most_aware", "untagged"];
  const rows: AwarenessRow[] = [];
  for (const stage of stagesOrder) {
    const entry = byStage.get(stage);
    if (!entry || entry.count === 0) continue;
    const avgCpa =
      entry.cpas.length > 0
        ? entry.cpas.reduce((a, b) => a + b, 0) / entry.cpas.length
        : null;
    const avgHookRate =
      entry.hookRates.length > 0
        ? entry.hookRates.reduce((a, b) => a + b, 0) / entry.hookRates.length
        : null;
    rows.push({
      stage,
      creativeCount: entry.count,
      avgCpa: avgCpa !== null ? Math.round(avgCpa * 100) / 100 : null,
      avgHookRate: avgHookRate !== null ? Math.round(avgHookRate * 10) / 10 : null,
      winnerRate:
        entry.count > 0 ? Math.round((entry.winners / entry.count) * 1000) / 10 : 0,
    });
  }

  return {
    rows,
    taggedCount: creatives.length - untagged,
    untaggedCount: untagged,
  };
}
