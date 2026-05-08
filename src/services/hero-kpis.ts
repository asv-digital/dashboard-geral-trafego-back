// Hero KPIs — primarios + secundarios com delta vs periodo anterior.
// Pra Sobral way: hook rate / frequency / CPM / CTR sao tao importantes
// quanto CPA / ROAS. Endpoint unico que entrega todos no mesmo lugar.

import prisma from "../prisma";
import { addBRTDays, startOfBRTDay } from "../lib/tz";

export type HeroKpi = {
  key: string;
  label: string;
  value: number;
  unit: "BRL" | "INT" | "FLOAT" | "PCT" | "RATIO";
  delta: number | null; // % vs periodo anterior
  direction: "up_good" | "down_good" | "neutral";
  hint?: string;
};

export type HeroKpisResult = {
  windowDays: number;
  primary: HeroKpi[];
  secondary: HeroKpi[];
};

async function aggregate(productId: string, since: Date, until: Date) {
  const metrics = await prisma.metricEntry.aggregate({
    where: { productId, date: { gte: since, lt: until } },
    _sum: {
      investment: true,
      impressions: true,
      clicks: true,
      threeSecondViews: true,
      thruplayViews: true,
    },
    _avg: { frequency: true, hookRate: true },
  });

  const sales = await prisma.sale.aggregate({
    where: { productId, status: "approved", date: { gte: since, lt: until } },
    _sum: { amountGross: true, amountNet: true },
    _count: true,
  });

  const spend = metrics._sum.investment || 0;
  const impressions = metrics._sum.impressions || 0;
  const clicks = metrics._sum.clicks || 0;
  const threeSecond = metrics._sum.threeSecondViews || 0;
  const thruplay = metrics._sum.thruplayViews || 0;
  const salesCount = sales._count || 0;
  const grossRevenue = sales._sum.amountGross || 0;
  const netRevenue = sales._sum.amountNet || 0;

  return {
    spend,
    impressions,
    clicks,
    threeSecond,
    thruplay,
    salesCount,
    grossRevenue,
    netRevenue,
    profit: netRevenue - spend,
    cpa: salesCount > 0 ? spend / salesCount : 0,
    roas: spend > 0 ? grossRevenue / spend : 0,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : 0,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    hookRate: metrics._avg.hookRate ?? 0,
    holdRate: threeSecond > 0 ? (thruplay / threeSecond) * 100 : 0,
    frequency: metrics._avg.frequency ?? 0,
  };
}

function pctChange(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null;
  return Math.round(((curr - prev) / Math.abs(prev)) * 1000) / 10;
}

export async function getProductHeroKpis(
  productId: string,
  windowDays = 7,
): Promise<HeroKpisResult> {
  const today = startOfBRTDay();
  const tomorrow = addBRTDays(today, 1);
  const since = addBRTDays(tomorrow, -windowDays);
  const previousSince = addBRTDays(since, -windowDays);

  const [current, previous] = await Promise.all([
    aggregate(productId, since, tomorrow),
    aggregate(productId, previousSince, since),
  ]);

  const primary: HeroKpi[] = [
    {
      key: "spend",
      label: "Gasto",
      value: current.spend,
      unit: "BRL",
      delta: pctChange(current.spend, previous.spend),
      direction: "neutral",
    },
    {
      key: "sales",
      label: "Vendas",
      value: current.salesCount,
      unit: "INT",
      delta: pctChange(current.salesCount, previous.salesCount),
      direction: "up_good",
    },
    {
      key: "cpa",
      label: "CPA",
      value: current.cpa,
      unit: "BRL",
      delta: pctChange(current.cpa, previous.cpa),
      direction: "down_good",
    },
    {
      key: "roas",
      label: "ROAS",
      value: current.roas,
      unit: "RATIO",
      delta: pctChange(current.roas, previous.roas),
      direction: "up_good",
    },
    {
      key: "profit",
      label: "Lucro",
      value: current.profit,
      unit: "BRL",
      delta: pctChange(current.profit, previous.profit),
      direction: "up_good",
    },
    {
      key: "revenue",
      label: "Receita liquida",
      value: current.netRevenue,
      unit: "BRL",
      delta: pctChange(current.netRevenue, previous.netRevenue),
      direction: "up_good",
    },
  ];

  const secondary: HeroKpi[] = [
    {
      key: "hookRate",
      label: "Hook rate",
      value: current.hookRate,
      unit: "PCT",
      delta: pctChange(current.hookRate, previous.hookRate),
      direction: "up_good",
      hint: "% que assistem 3s+ (Sobral #1)",
    },
    {
      key: "holdRate",
      label: "Hold rate",
      value: current.holdRate,
      unit: "PCT",
      delta: pctChange(current.holdRate, previous.holdRate),
      direction: "up_good",
      hint: "thruplay / 3s",
    },
    {
      key: "ctr",
      label: "CTR",
      value: current.ctr,
      unit: "PCT",
      delta: pctChange(current.ctr, previous.ctr),
      direction: "up_good",
    },
    {
      key: "cpm",
      label: "CPM",
      value: current.cpm,
      unit: "BRL",
      delta: pctChange(current.cpm, previous.cpm),
      direction: "down_good",
      hint: "saude do leilao",
    },
    {
      key: "frequency",
      label: "Frequencia",
      value: current.frequency,
      unit: "FLOAT",
      delta: pctChange(current.frequency, previous.frequency),
      direction: "down_good",
      hint: "alvo < 2.5 / fadiga > 3.5",
    },
    {
      key: "impressions",
      label: "Impressoes",
      value: current.impressions,
      unit: "INT",
      delta: pctChange(current.impressions, previous.impressions),
      direction: "up_good",
    },
  ];

  return { windowDays, primary, secondary };
}
