// Audience builder product-aware.
// Detecta milestones (100, 200, 500, 1000 compradores) e cria
// lookalike audiences no Meta com % 1, 2, 3, 5.

import prisma from "../prisma";
import { logAction } from "./action-log";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

const MILESTONES = [100, 200, 500, 1000];
const BASE_LAL_PERCENTAGES = [1, 2, 3, 5];

export function getLookalikePercentagesForMilestone(milestone: number): number[] {
  if (milestone < 200) return [1, 2];
  if (milestone < 500) return [1, 2, 3];
  return BASE_LAL_PERCENTAGES;
}

async function createLookalikeAudience(
  adAccountId: string,
  sourceAudienceId: string,
  name: string,
  percentage: number
): Promise<{ id: string } | { error: string }> {
  const { accessToken: token } = await getResolvedProductMetaSettings();
  if (!token) return { error: "no_meta_token" };

  try {
    const body = new URLSearchParams();
    body.set("name", name);
    body.set("subtype", "LOOKALIKE");
    body.set("origin_audience_id", sourceAudienceId);
    body.set(
      "lookalike_spec",
      JSON.stringify({
        type: "similarity",
        ratio: percentage / 100,
        country: "BR",
      })
    );
    body.set("access_token", token);

    const res = await fetch(`${META_BASE}/${adAccountId}/customaudiences`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as any;
    if (json.error) {
      console.error(`[audience-builder] erro: ${json.error.message}`);
      return { error: json.error.message || "meta_error" };
    }
    return { id: json.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[audience-builder] fetch falhou: ${msg}`);
    return { error: msg };
  }
}

export async function checkLookalikeForProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return;
  // D6 — supervisedMode: criar LAL e mutation no Meta. Em modo supervised
  // a gente nao toca. User cria audience manualmente.
  if (product.supervisedMode) {
    console.log(`[audience-builder:${product.slug}] supervisedMode ON, pulando`);
    return;
  }

  const metaConfig = await getResolvedProductMetaSettings(product);
  const adAccountId = metaConfig.adAccountId;
  const sourceAudienceId = metaConfig.audienceBuyersId;
  if (!adAccountId || !sourceAudienceId) return;

  const buyerCount = await prisma.sale.count({
    where: { productId, status: "approved" },
  });
  if (buyerCount < MILESTONES[0]) return;

  // Qual milestone atingimos?
  const milestone = MILESTONES.reduce(
    (prev, m) => (buyerCount >= m ? m : prev),
    0
  );
  if (milestone === 0) return;
  const targetPercentages = getLookalikePercentagesForMilestone(milestone);

  // Já temos lookalikes criados pra este milestone?
  const existing = await prisma.lookalikeAudience.findMany({
    where: { productId, buyerCountAtCreation: milestone },
  });
  if (existing.length >= targetPercentages.length) return;

  const existingPercentages = new Set(existing.map(e => e.percentage));

  for (const pct of targetPercentages) {
    if (existingPercentages.has(pct)) continue;

    const name = `[${product.slug}] LAL ${pct}% — ${milestone} buyers`;
    const result = await createLookalikeAudience(
      adAccountId,
      sourceAudienceId,
      name,
      pct
    );

    if ("error" in result) {
      // Persistir tentativa falhada com status="error" pra não retentar
      // sozinho a cada ciclo (e ficar martelando Meta com erro). Gestor
      // resolve manualmente (token, scope, audience source size mínimo).
      await prisma.lookalikeAudience.create({
        data: {
          productId,
          name,
          metaAudienceId: `error_${Date.now()}_${pct}`,
          sourceAudienceId,
          percentage: pct,
          buyerCountAtCreation: milestone,
          status: "error",
        },
      });
      await logAction({
        productId,
        action: "lookalike_failed",
        entityType: "audience",
        entityName: name,
        details: `milestone=${milestone} pct=${pct}% err=${result.error}`,
      });
      continue;
    }

    await prisma.lookalikeAudience.create({
      data: {
        productId,
        name,
        metaAudienceId: result.id,
        sourceAudienceId,
        percentage: pct,
        buyerCountAtCreation: milestone,
        status: "created",
      },
    });

    await logAction({
      productId,
      action: "lookalike_created",
      entityType: "audience",
      entityId: result.id,
      entityName: name,
      details: `milestone=${milestone}, percentage=${pct}%`,
    });
  }
}

export async function checkLookalikeAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await checkLookalikeForProduct(p.id);
    } catch (err) {
      console.error(
        `[audience-builder] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
