// High Ticket Sales — vendas de high ticket (mentoria) registradas manualmente
// pelo gestor. Vive em painel separado, NAO influencia decisoes automaticas
// do agente de trafego. Cruzamento com Sale (low ticket) via match por email.

import prisma from "../prisma";
import { addBRTDays, startOfBRTDay } from "../lib/tz";

export interface HighTicketSaleInput {
  customerEmail: string;
  amountGross: number;
  saleDate: Date;
  notes?: string;
}

export interface HighTicketSummary {
  windowDays: number;
  spend: number;                  // total gasto Meta no periodo
  lowTickets: { count: number; revenue: number };
  highTickets: { count: number; revenue: number };
  totalRevenue: number;            // low + high
  netProfit: number;               // revenue net (apos fee Kirvano) - spend
  uniqueCustomers: number;
  avgLtvPerCustomer: number;       // total revenue / unique customers
  conversionLowToHigh: number;     // % buyers low que viraram high
  consolidatedROI: number | null;  // (low + high) / spend
  matchedCount: number;
  unmatchedCount: number;
}

export async function listHighTicketSales(productId: string, days = 90) {
  const cutoff = addBRTDays(startOfBRTDay(), -days);
  return prisma.highTicketSale.findMany({
    where: { productId, saleDate: { gte: cutoff } },
    orderBy: { saleDate: "desc" },
    include: {
      matchedSale: {
        select: { id: true, date: true, amountGross: true, customerEmail: true },
      },
    },
  });
}

export async function createHighTicketSale(
  productId: string,
  input: HighTicketSaleInput
) {
  // Cria sem auto-sync — gestor clica "Sincronizar" manualmente quando quiser.
  return prisma.highTicketSale.create({
    data: {
      productId,
      customerEmail: input.customerEmail.toLowerCase().trim(),
      amountGross: input.amountGross,
      saleDate: input.saleDate,
      notes: input.notes ?? null,
    },
  });
}

export async function deleteHighTicketSale(id: string) {
  return prisma.highTicketSale.delete({ where: { id } });
}

/**
 * Match cada HighTicketSale do produto com a Sale low correspondente,
 * buscando por customerEmail (case insensitive). Pega a Sale low MAIS RECENTE
 * antes da data do high (assume que low veio antes do high).
 */
export async function syncHighTicketSales(productId: string): Promise<{
  total: number;
  matched: number;
  unmatched: number;
}> {
  const highs = await prisma.highTicketSale.findMany({
    where: { productId, matchedSaleId: null },
  });
  let matched = 0;
  for (const h of highs) {
    const lowSale = await prisma.sale.findFirst({
      where: {
        productId,
        status: "approved",
        customerEmail: h.customerEmail,
        date: { lte: h.saleDate },
      },
      orderBy: { date: "desc" },
    });
    if (lowSale) {
      await prisma.highTicketSale.update({
        where: { id: h.id },
        data: { matchedSaleId: lowSale.id, syncedAt: new Date() },
      });
      matched += 1;
    }
  }
  // Re-syncs ja matched: refresh syncedAt sem trocar match
  const alreadyMatched = await prisma.highTicketSale.count({
    where: { productId, matchedSaleId: { not: null } },
  });
  return {
    total: highs.length + alreadyMatched,
    matched: matched + alreadyMatched,
    unmatched: highs.length - matched,
  };
}

export async function getHighTicketSummary(
  productId: string,
  days = 90
): Promise<HighTicketSummary> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  const fee = product?.gatewayFeeRate ?? 0.099;
  const cutoff = addBRTDays(startOfBRTDay(), -days);

  const [spendAgg, lowAgg, lowSales, highSales] = await Promise.all([
    prisma.metricEntry.aggregate({
      where: { productId, date: { gte: cutoff } },
      _sum: { investment: true },
    }),
    prisma.sale.aggregate({
      where: { productId, status: "approved", date: { gte: cutoff } },
      _sum: { amountGross: true, amountNet: true },
      _count: true,
    }),
    prisma.sale.findMany({
      where: { productId, status: "approved", date: { gte: cutoff } },
      select: { customerEmail: true },
    }),
    prisma.highTicketSale.findMany({
      where: { productId, saleDate: { gte: cutoff } },
    }),
  ]);

  const spend = spendAgg._sum.investment || 0;
  const lowCount = lowAgg._count || 0;
  const lowRevenue = lowAgg._sum.amountGross || 0;
  const lowNet = lowAgg._sum.amountNet || 0;
  const highCount = highSales.length;
  const highRevenue = highSales.reduce((s, h) => s + h.amountGross, 0);
  // Assume mesma fee Kirvano pra high — gestor pode ajustar dps se for diferente
  const highNet = highRevenue * (1 - fee);
  const totalRevenue = lowRevenue + highRevenue;
  const netRevenue = lowNet + highNet;
  const netProfit = netRevenue - spend;

  const uniqueLowCustomers = new Set(
    lowSales.map(s => s.customerEmail).filter((e): e is string => !!e)
  );
  const uniqueHighCustomers = new Set(
    highSales.map(h => h.customerEmail.toLowerCase())
  );
  const allCustomers = new Set([
    ...uniqueLowCustomers,
    ...uniqueHighCustomers,
  ]);
  // Customers que viraram high (presentes em ambos)
  const convertedToHigh = Array.from(uniqueLowCustomers).filter(e =>
    uniqueHighCustomers.has(e.toLowerCase())
  ).length;
  const conversionLowToHigh =
    uniqueLowCustomers.size > 0
      ? Math.round((convertedToHigh / uniqueLowCustomers.size) * 1000) / 10
      : 0;

  const matched = highSales.filter(h => h.matchedSaleId !== null).length;
  const unmatched = highSales.length - matched;

  const avgLtv = allCustomers.size > 0 ? totalRevenue / allCustomers.size : 0;
  const roi = spend > 0 ? totalRevenue / spend : null;

  return {
    windowDays: days,
    spend: Math.round(spend * 100) / 100,
    lowTickets: { count: lowCount, revenue: Math.round(lowRevenue * 100) / 100 },
    highTickets: { count: highCount, revenue: Math.round(highRevenue * 100) / 100 },
    totalRevenue: Math.round(totalRevenue * 100) / 100,
    netProfit: Math.round(netProfit * 100) / 100,
    uniqueCustomers: allCustomers.size,
    avgLtvPerCustomer: Math.round(avgLtv * 100) / 100,
    conversionLowToHigh,
    consolidatedROI: roi !== null ? Math.round(roi * 100) / 100 : null,
    matchedCount: matched,
    unmatchedCount: unmatched,
  };
}
