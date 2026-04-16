// A/B test resolver product-aware.
// Finaliza testes cujo minDays passou E minSpendPerVariant foi atingido.
// Decide winner por CPA real em nível de adId e pausa o anúncio perdedor.

import prisma from "../prisma";
import { canAutomate, acquireLock } from "./automation-coordinator";
import { logAction } from "./action-log";
import { sendNotification } from "./whatsapp-notifier";
import { pauseAd } from "../lib/meta-mutations";

interface VariantStats {
  metaAdId: string;
  id: string;
  name: string;
  spend: number;
  sales: number;
  cpa: number;
}

interface CreativeVariantRef {
  id?: unknown;
  name?: unknown;
  adId?: unknown;
  metaAdId?: unknown;
}

function parseVariant(variant: unknown): { name: string; metaAdId: string | null } {
  if (!variant || typeof variant !== "object") {
    return { name: "variant", metaAdId: null };
  }

  const ref = variant as CreativeVariantRef;
  const name =
    (typeof ref.name === "string" && ref.name) ||
    (typeof ref.id === "string" && ref.id) ||
    "variant";
  const metaAdId =
    (typeof ref.metaAdId === "string" && ref.metaAdId) ||
    (typeof ref.adId === "string" && ref.adId) ||
    (typeof ref.id === "string" && ref.id) ||
    null;

  return { name, metaAdId };
}

async function computeVariantStats(
  productId: string,
  startDate: Date,
  variant: { name: string; metaAdId: string | null }
): Promise<VariantStats | null> {
  if (!variant.metaAdId) {
    return null;
  }

  const [spendAgg, salesAgg] = await Promise.all([
    prisma.adDiagnostic.aggregate({
      where: {
        productId,
        adId: variant.metaAdId,
        date: { gte: startDate },
      },
      _sum: { spend: true },
    }),
    prisma.sale.aggregate({
      where: {
        productId,
        status: "approved",
        metaAdId: variant.metaAdId,
        date: { gte: startDate },
      },
      _count: true,
    }),
  ]);

  const spend = spendAgg._sum.spend || 0;
  const sales = salesAgg._count || 0;

  return {
    metaAdId: variant.metaAdId,
    id: variant.name,
    name: variant.name,
    spend,
    sales,
    cpa: sales > 0 ? spend / sales : 0,
  };
}

export function pickWinner(
  a: VariantStats,
  b: VariantStats
): { winner: VariantStats; loser: VariantStats; confidence: number } | null {
  if (a.sales >= 2 && b.sales === 0 && b.spend > 0) {
    return {
      winner: a,
      loser: b,
      confidence: Math.min(0.95, 0.8 + Math.min(0.15, b.spend / Math.max(a.spend, 1) / 10)),
    };
  }

  if (b.sales >= 2 && a.sales === 0 && a.spend > 0) {
    return {
      winner: b,
      loser: a,
      confidence: Math.min(0.95, 0.8 + Math.min(0.15, a.spend / Math.max(b.spend, 1) / 10)),
    };
  }

  if (a.sales < 2 || b.sales < 2) return null;
  if (a.cpa === 0 || b.cpa === 0) return null;

  const diff = Math.abs(a.cpa - b.cpa) / Math.max(a.cpa, b.cpa);
  const confidence = Math.min(0.99, diff * 5);
  if (confidence < 0.75 || diff < 0.15) return null;

  return a.cpa < b.cpa
    ? { winner: a, loser: b, confidence }
    : { winner: b, loser: a, confidence };
}

export async function resolveActiveTestsForProduct(productId: string): Promise<void> {
  const tests = await prisma.creativeTest.findMany({
    where: {
      productId,
      status: "running",
    },
  });
  const now = new Date();

  for (const t of tests) {
    const daysSinceStart = (now.getTime() - t.startDate.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceStart < t.minDays) continue;

    const variantA = parseVariant(t.variantA);
    const variantB = parseVariant(t.variantB);
    const aStats = await computeVariantStats(productId, t.startDate, variantA);
    const bStats = await computeVariantStats(productId, t.startDate, variantB);
    if (!aStats || !bStats) continue;

    if (aStats.spend < t.minSpendPerVariant || bStats.spend < t.minSpendPerVariant) continue;

    const result = pickWinner(aStats, bStats);
    if (!result) continue;

    const lock = await canAutomate(productId, "adset", t.adsetId, "ab_resolver");
    if (!lock.allowed) continue;

    await prisma.creativeTest.update({
      where: { id: t.id },
      data: {
        status: "concluded",
        winner: result.winner.name,
        confidence: result.confidence,
        endDate: now,
        decidedAt: now,
      },
    });
    await pauseAd(result.loser.metaAdId);
    await acquireLock(
      productId,
      "adset",
      t.adsetId,
      "ab_resolver",
      "ab_concluded",
      "running",
      result.winner.name
    );
    await logAction({
      productId,
      action: "ab_test_concluded",
      entityType: "adset",
      entityId: t.adsetId,
      entityName: t.name,
      details: `Winner: ${result.winner.name} (loser pausado: ${result.loser.name})`,
    });
    await sendNotification(
      "auto_action",
      {
        action: "A/B TEST DECIDIDO",
        adset: t.name,
        reason: `winner=${result.winner.name}, loser=${result.loser.name}, confiança ${(result.confidence * 100).toFixed(0)}%`,
      },
      productId
    );
  }
}

export async function resolveActiveTestsAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await resolveActiveTestsForProduct(p.id);
    } catch (err) {
      console.error(
        `[ab-resolver] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
