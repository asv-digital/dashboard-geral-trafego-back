// A/B test resolver product-aware.
// Finaliza testes cujo minDays passou E minSpendPerVariant foi atingido.
// Decide winner por CPA real em nível de adId e pausa o anúncio perdedor.
//
// Testes são criados via POST /api/ab-tests (UI: /product/[id]/ab-tests).

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

// M1 — significancia estatistica via Z-test 2-proporcoes (pooled variance)
// substitui o heuristico antigo "confidence = diff * 5". Mais robusto pra
// declarar winner em A/B com cuidado: nao pausa loser por sorte de poucos
// dias. Min 20 conversoes por variante (regra classica adaptada pra BR
// ticket alto — clientes web geralmente usam 30+).
const MIN_CONVERSIONS_PER_VARIANT = 20;
const Z_CONFIDENCE_THRESHOLD = 0.95; // 95% bicaudal

/** CDF da normal padrao via aproximacao Hastings (erro < 7.5e-8). */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  let p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * Z-test 2-proporcoes pooled. Retorna z + p-value bicaudal.
 * k1/k2 = conversoes; n1/n2 = "trials" (proxy = spend em reais).
 */
function zTestTwoProp(
  k1: number,
  n1: number,
  k2: number,
  n2: number
): { z: number; pValue: number } {
  if (n1 <= 0 || n2 <= 0) return { z: 0, pValue: 1 };
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const pPool = (k1 + k2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p1 - p2) / se;
  // bicaudal
  const pValue = 2 * (1 - normCdf(Math.abs(z)));
  return { z, pValue };
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
  // 1. Early winner por aniquilacao: um lado vende, outro queima sem vender.
  // Mantido pra ad obviamente quebrado nao continuar gastando ate atingir
  // MIN_CONVERSIONS no vencedor. Threshold subiu de 2 pra 5 vendas pra
  // diminuir falso-positivo por sorte.
  if (a.sales >= 5 && b.sales === 0 && b.spend > 0) {
    // confidence proxy proporcional a quanto B gastou em relacao a A
    const proxy = Math.min(0.95, 0.85 + Math.min(0.1, b.spend / Math.max(a.spend, 1) / 10));
    return { winner: a, loser: b, confidence: proxy };
  }
  if (b.sales >= 5 && a.sales === 0 && a.spend > 0) {
    const proxy = Math.min(0.95, 0.85 + Math.min(0.1, a.spend / Math.max(b.spend, 1) / 10));
    return { winner: b, loser: a, confidence: proxy };
  }

  // 2. Z-test 2-proporcoes. Exige amostra minima por variante.
  if (a.sales < MIN_CONVERSIONS_PER_VARIANT || b.sales < MIN_CONVERSIONS_PER_VARIANT) {
    return null;
  }
  if (a.spend <= 0 || b.spend <= 0) return null;

  // N (trials proxy) = spend em reais. Cada R$1 = 1 "trial".
  // Limitação: ideal seria clicks/impressions, mas AdDiagnostic so tem spend.
  // Quando houver coleta de clicks por adId no banco, trocar n1/n2 por
  // a.clicks/b.clicks pro teste ser estatisticamente correto.
  const n1 = Math.round(a.spend);
  const n2 = Math.round(b.spend);
  const { z, pValue } = zTestTwoProp(a.sales, n1, b.sales, n2);
  const confidence = 1 - pValue;
  if (confidence < Z_CONFIDENCE_THRESHOLD) return null;

  // Winner = maior CR (sales/spend). CPA e o inverso, mas usamos CR pro test.
  const crA = a.sales / n1;
  const crB = b.sales / n2;
  if (crA === crB) return null;

  return crA > crB
    ? { winner: a, loser: b, confidence }
    : { winner: b, loser: a, confidence };
}

export async function resolveActiveTestsForProduct(productId: string): Promise<void> {
  // D6 — supervisedMode: ab-test-resolver pausa ad loser via Meta API,
  // que e mutation. Em modo supervised o agente so coleta+sugere; nao mexe.
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { supervisedMode: true, slug: true },
  });
  if (product?.supervisedMode) {
    console.log(`[ab-resolver:${product.slug}] supervisedMode ON, pulando`);
    return;
  }

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
  // Short-circuit barato quando não há testes rodando: 1 count vs 1 findMany
  // por produto. Quando há testes, prossegue com loop por produto ativo.
  const runningCount = await prisma.creativeTest.count({
    where: { status: "running" },
  });
  if (runningCount === 0) return;

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
