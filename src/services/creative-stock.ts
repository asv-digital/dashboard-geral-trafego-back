// Creative stock watcher product-aware.
// Classifica cada criativo em healthy/declining/exhausted baseado em
// idade + performance. Alerta quando o produto está com estoque crítico
// (≥ 5 exaustos ou ≤ 3 saudáveis). Pausa automática dos exaustos se
// autoRotateCreatives estiver ativado.

import prisma from "../prisma";
import { sendNotification } from "./whatsapp-notifier";
import { logAction } from "./action-log";
import { shouldSendStateAlert, resetStateAlert } from "../lib/alert-dedup";
import { creativeMatchesAdName } from "../lib/creative-matching";
import { getTrackedAdsForCampaigns, pauseAd } from "../lib/meta-mutations";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";
import {
  getBudgetTier,
  getStrategyAssetRecommendations,
  type StrategyStage,
} from "../lib/planner-playbook";

type CreativeHealth = "healthy" | "declining" | "exhausted";

interface CreativeStatus {
  id: string;
  name: string;
  ageDays: number;
  health: CreativeHealth;
  reason: string;
}

export function classifyCreative(c: {
  type: string;
  createdAt: Date;
  hookRate: number | null;
  cpa: number | null;
  ctr: number | null;
  thruplayRate: number | null;
  stage: StrategyStage;
  dailyBudgetTarget: number;
}, cpaPauseThreshold: number): { health: CreativeHealth; reason: string } {
  const ageDays = (Date.now() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24);
  const tier = getBudgetTier(c.dailyBudgetTarget);
  const exhaustedAge =
    c.stage === "escalavel" || c.stage === "evergreen"
      ? tier === "scale"
        ? 18
        : 21
      : tier === "starter"
        ? 30
        : 25;
  const decliningAge = Math.max(10, exhaustedAge - (tier === "starter" ? 10 : 7));

  if (ageDays > exhaustedAge) {
    return { health: "exhausted", reason: `>${ageDays.toFixed(0)}d de idade` };
  }
  if (c.hookRate !== null && c.hookRate < 2.5) {
    return { health: "exhausted", reason: `hook rate ${c.hookRate.toFixed(1)}% < 2.5%` };
  }
  if (c.ctr !== null && c.ctr < 0.8) {
    return { health: "exhausted", reason: `CTR ${c.ctr.toFixed(1)}% < 0.8%` };
  }
  if (c.type === "video" && c.thruplayRate !== null && c.thruplayRate < 15) {
    return {
      health: "exhausted",
      reason: `thruplay ${c.thruplayRate.toFixed(1)}% < 15%`,
    };
  }
  if (c.cpa !== null && c.cpa > cpaPauseThreshold) {
    return {
      health: "exhausted",
      reason: `CPA R$${c.cpa.toFixed(0)} > R$${cpaPauseThreshold.toFixed(0)}`,
    };
  }

  if (ageDays > decliningAge) {
    return { health: "declining", reason: `${ageDays.toFixed(0)}d de idade` };
  }
  if (c.hookRate !== null && c.hookRate < 4) {
    return { health: "declining", reason: `hook rate ${c.hookRate.toFixed(1)}%` };
  }
  if (c.ctr !== null && c.ctr < 1.2) {
    return { health: "declining", reason: `CTR ${c.ctr.toFixed(1)}%` };
  }
  if (c.type === "video" && c.thruplayRate !== null && c.thruplayRate < 22) {
    return { health: "declining", reason: `thruplay ${c.thruplayRate.toFixed(1)}%` };
  }
  if (c.cpa !== null && c.cpa > cpaPauseThreshold * 0.75) {
    return { health: "declining", reason: `CPA R$${c.cpa.toFixed(0)}` };
  }

  return { health: "healthy", reason: "ok" };
}

export async function checkCreativeStockForProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product || !product.automationConfig) return;
  // D6 — supervisedMode bloqueia mutations Meta (pauseAd em criativos exaustos).
  if (product.supervisedMode) {
    console.log(`[creative-stock:${product.slug}] supervisedMode ON, pulando rotacao`);
    return;
  }

  const creatives = await prisma.creative.findMany({
    where: { productId, status: { not: "exhausted" } },
  });
  if (creatives.length === 0) return;

  const threshold = product.automationConfig.cpaPauseThreshold;
  const strategyInventory = getStrategyAssetRecommendations(
    product.stage as StrategyStage,
    product.dailyBudgetTarget
  );
  const statuses: CreativeStatus[] = creatives.map(c => {
    const classification = classifyCreative(
      {
        ...c,
        stage: product.stage as StrategyStage,
        dailyBudgetTarget: product.dailyBudgetTarget,
      },
      threshold
    );
    const ageDays = (Date.now() - c.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    return {
      id: c.id,
      name: c.name,
      ageDays,
      health: classification.health,
      reason: classification.reason,
    };
  });

  const exhausted = statuses.filter(s => s.health === "exhausted");
  const declining = statuses.filter(s => s.health === "declining");
  const healthy = statuses.filter(s => s.health === "healthy");

  // Rotação automática dos exaustos
  if (product.automationConfig.autoRotateCreatives) {
    const { adAccountId: accountId } = await getResolvedProductMetaSettings(product);
    const trackedCampaigns = await prisma.campaign.findMany({
      where: { productId, metaCampaignId: { not: null } },
      select: { id: true, metaCampaignId: true },
    });
    const campaignByDbId = new Map(
      trackedCampaigns.map(campaign => [campaign.id, campaign.metaCampaignId!])
    );
    const trackedAds =
      accountId && trackedCampaigns.length > 0
        ? await getTrackedAdsForCampaigns(
            accountId,
            trackedCampaigns.map(campaign => campaign.metaCampaignId!)
          )
        : [];

    for (const ex of exhausted) {
      const creative = creatives.find(item => item.id === ex.id);
      const metaCampaignId = creative?.campaignId
        ? campaignByDbId.get(creative.campaignId)
        : undefined;

      // Match prioritário por metaAdId estável (creative-performance popula).
      // Fallback por nome só se metaAdId ainda não foi atribuído. Antes
      // tudo era por nome — adId renomeado no Meta UI quebrava match e
      // creative ficava marcado "exhausted" no DB enquanto o ad seguia
      // queimando budget.
      let matchingAds: typeof trackedAds = [];
      if (creative?.metaAdId) {
        matchingAds = trackedAds.filter(
          ad => ad.id === creative.metaAdId && ad.status === "ACTIVE",
        );
      }
      if (matchingAds.length === 0 && metaCampaignId) {
        matchingAds = trackedAds.filter(
          ad =>
            ad.campaignId === metaCampaignId &&
            creativeMatchesAdName(ex.name, ad.name) &&
            ad.status === "ACTIVE",
        );
      }

      let pausedAds = 0;
      for (const ad of matchingAds) {
        if (await pauseAd(ad.id)) pausedAds++;
      }

      await prisma.creative.update({
        where: { id: ex.id },
        data: { status: "exhausted" },
      });
      await logAction({
        productId,
        action: "creative_retire",
        entityType: "creative",
        entityId: ex.id,
        entityName: ex.name,
        details:
          pausedAds > 0
            ? `${ex.reason}. ${pausedAds} anúncio(s) pausado(s) no Meta.`
            : `${ex.reason}. Nenhum anúncio ativo correspondente foi encontrado no Meta (metaAdId=${creative?.metaAdId ?? "null"}).`,
      });
    }
  }

  // Alerta de estoque crítico (edge-triggered)
  const criticalHealthyFloor = Math.max(2, strategyInventory.recommendedMediaAssets - 1);
  const stockLevel =
    healthy.length < criticalHealthyFloor || exhausted.length >= strategyInventory.recommendedMediaAssets
      ? "critical"
      : "ok";
  const shouldAlert = await shouldSendStateAlert(productId, "creative_stock", stockLevel);
  if (shouldAlert && stockLevel === "critical") {
    await sendNotification(
      "creative",
      {
        message: `${product.name}: estoque crítico — ${exhausted.length} exaustos, ${declining.length} declinando, ${healthy.length} saudáveis. Recomendado para este estágio: pelo menos ${criticalHealthyFloor} criativos saudáveis.`,
      },
      productId
    );
  } else if (stockLevel === "ok") {
    await resetStateAlert(productId, "creative_stock");
  }
}

export async function checkCreativeStockAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await checkCreativeStockForProduct(p.id);
    } catch (err) {
      console.error(
        `[creative-stock] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
