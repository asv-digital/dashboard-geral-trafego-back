// Budget rebalancer product-aware.
// Shift budget de losers (ROAS < 1.4) pra winners (ROAS > 2.0) DENTRO
// do mesmo produto, respeitando caps/floors do ProductAutomationConfig.
// Nunca cruza produtos.

import prisma from "../prisma";
import { canAutomate, acquireLock } from "./automation-coordinator";
import { logAction } from "./action-log";
import { sendNotification } from "./whatsapp-notifier";
import {
  canIncreaseBudget,
  canDecreaseBudget,
  classifyCampaign,
} from "./budget-guard";
import { getActiveAdsetsForCampaigns, updateAdsetBudget } from "../lib/meta-mutations";
import { metricMatchesAdset } from "../lib/metric-entry";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";
import { addBRTDays, startOfBRTDay } from "../lib/tz";

const LOSER_ROAS = 1.4;
const WINNER_ROAS = 2.0;
const SHIFT_PERCENT = 0.15; // move 15% do budget do loser

interface AdsetPerf {
  adsetId: string;
  adsetName: string;
  campaignName: string;
  metaCampaignId: string;
  dailyBudget: number;
  spend: number;
  sales: number;
  revenue: number;
  roas: number;
  avgFrequency: number;
  avgHookRate: number | null;
  avgOutboundCtr: number | null;
  isInLearningPhase: boolean;
}

async function collectPerformance(productId: string): Promise<AdsetPerf[]> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product || !product.automationConfig) return [];
  const { adAccountId: accountId } = await getResolvedProductMetaSettings(product);
  if (!accountId) return [];

  const dbCampaigns = await prisma.campaign.findMany({
    where: { productId, metaCampaignId: { not: null } },
  });
  const trackedIds = dbCampaigns
    .map(c => c.metaCampaignId)
    .filter((id): id is string => id !== null);
  if (trackedIds.length === 0) return [];

  const dbByMeta = new Map(dbCampaigns.map(c => [c.metaCampaignId!, c]));
  const adsets = await getActiveAdsetsForCampaigns(accountId, trackedIds);

  const sevenDaysAgo = addBRTDays(startOfBRTDay(), -6);

  const metrics = await prisma.metricEntry.findMany({
    where: { productId, date: { gte: sevenDaysAgo } },
  });

  const perfs: AdsetPerf[] = [];
  for (const a of adsets) {
    if (a.status !== "ACTIVE") continue;
    const dbCamp = dbByMeta.get(a.campaignId);
    if (!dbCamp) continue;

    const adsetMetrics = metrics.filter(
      m => m.campaignId === dbCamp.id && metricMatchesAdset(m, a)
    );
    const spend = adsetMetrics.reduce((s, m) => s + m.investment, 0);
    const sales = adsetMetrics.reduce((s, m) => s + m.sales, 0);
    const revenue = sales * product.netPerSale;
    const roas = spend > 0 ? revenue / spend : 0;
    const avgFrequency =
      adsetMetrics.length > 0
        ? adsetMetrics.reduce((sum, metric) => sum + (metric.frequency || 0), 0) /
          adsetMetrics.length
        : 0;
    const hookRateMetrics = adsetMetrics.filter(
      metric => typeof metric.hookRate === "number"
    );
    const avgHookRate =
      hookRateMetrics.length > 0
        ? hookRateMetrics.reduce((sum, metric) => sum + (metric.hookRate || 0), 0) /
          hookRateMetrics.length
        : null;
    const outboundCtrMetrics = adsetMetrics.filter(
      metric => typeof metric.outboundCtr === "number"
    );
    const avgOutboundCtr =
      outboundCtrMetrics.length > 0
        ? outboundCtrMetrics.reduce(
            (sum, metric) => sum + (metric.outboundCtr || 0),
            0
          ) / outboundCtrMetrics.length
        : null;

    perfs.push({
      adsetId: a.id,
      adsetName: a.name,
      campaignName: dbCamp.name,
      metaCampaignId: a.campaignId,
      dailyBudget: a.dailyBudget,
      spend,
      sales,
      revenue,
      roas,
      avgFrequency,
      avgHookRate,
      avgOutboundCtr,
      isInLearningPhase: dbCamp.isInLearningPhase,
    });
  }
  return perfs;
}

function getPerformanceScore(
  perf: AdsetPerf,
  cfg: { frequencyLimitProspection: number; frequencyLimitRemarketing: number }
): number {
  const campaignType = classifyCampaign(perf.campaignName);
  const frequencyLimit =
    campaignType === "remarketing"
      ? cfg.frequencyLimitRemarketing
      : cfg.frequencyLimitProspection;
  const frequencyHeadroom =
    frequencyLimit > 0
      ? Math.max(0, 1 - perf.avgFrequency / Math.max(frequencyLimit, 0.01))
      : 0;
  const hookScore = perf.avgHookRate === null ? 4 : Math.max(0, Math.min(14, perf.avgHookRate * 2.5));
  const outboundCtrScore =
    perf.avgOutboundCtr === null ? 3 : Math.max(0, Math.min(10, perf.avgOutboundCtr * 6));

  return perf.roas * 40 + perf.sales * 4 + frequencyHeadroom * 18 + hookScore + outboundCtrScore;
}

export async function rebalanceForProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product || !product.automationConfig || product.supervisedMode) return;

  const perfs = await collectPerformance(productId);
  if (perfs.length < 2) return;
  const minimumSpend = Math.max(product.netPerSale, 50);

  const losers = perfs.filter(
    p => p.spend >= minimumSpend && p.roas > 0 && p.roas < LOSER_ROAS && !p.isInLearningPhase
  );
  const winners = perfs.filter(
    p => p.spend >= minimumSpend && p.roas > WINNER_ROAS && !p.isInLearningPhase
  );

  if (losers.length === 0 || winners.length === 0) {
    console.log(
      `[rebalance:${product.slug}] nada a fazer (losers=${losers.length}, winners=${winners.length})`
    );
    return;
  }

  // Winners fortes recebem verba primeiro considerando ROAS + qualidade de entrega.
  winners.sort(
    (a, b) =>
      getPerformanceScore(b, product.automationConfig!) -
      getPerformanceScore(a, product.automationConfig!)
  );
  losers.sort(
    (a, b) =>
      getPerformanceScore(a, product.automationConfig!) -
      getPerformanceScore(b, product.automationConfig!)
  );

  for (const loser of losers) {
    const decAmount = Math.round(loser.dailyBudget * SHIFT_PERCENT);
    if (decAmount < 10) continue;

    const canDec = await canDecreaseBudget(productId, loser.campaignName, decAmount);
    if (!canDec.allowed) {
      console.log(`[rebalance:${product.slug}] loser ${loser.adsetName}: ${canDec.reason}`);
      continue;
    }

    // Lock do loser
    const lockLoser = await canAutomate(
      productId,
      "adset",
      loser.adsetId,
      "budget_rebalancer"
    );
    if (!lockLoser.allowed) continue;

    // Encontra winner do mesmo tipo (prospection/remarketing/asc) se possível
    const loserType = classifyCampaign(loser.campaignName);
    const sameType = winners.find(w => classifyCampaign(w.campaignName) === loserType);
    const winner = sameType || winners[0];
    if (!winner || winner.adsetId === loser.adsetId) continue;

    const canInc = await canIncreaseBudget(
      productId,
      winner.campaignName,
      canDec.maxDecrease
    );
    if (!canInc.allowed || canInc.maxIncrease <= 0) {
      console.log(
        `[rebalance:${product.slug}] winner ${winner.adsetName}: ${canInc.reason}`
      );
      continue;
    }

    const shift = Math.min(canDec.maxDecrease, canInc.maxIncrease);
    if (shift < 10) continue;

    const newLoserBudget = Math.round(loser.dailyBudget - shift);
    const newWinnerBudget = Math.round(winner.dailyBudget + shift);

    const lockWinner = await canAutomate(
      productId,
      "adset",
      winner.adsetId,
      "budget_rebalancer"
    );
    if (!lockWinner.allowed) continue;

    const okLoser = await updateAdsetBudget(loser.adsetId, newLoserBudget);
    const okWinner = await updateAdsetBudget(winner.adsetId, newWinnerBudget);

    if (okLoser && okWinner) {
      await acquireLock(
        productId,
        "adset",
        loser.adsetId,
        "budget_rebalancer",
        "budget_decrease",
        String(loser.dailyBudget),
        String(newLoserBudget)
      );
      await acquireLock(
        productId,
        "adset",
        winner.adsetId,
        "budget_rebalancer",
        "budget_increase",
        String(winner.dailyBudget),
        String(newWinnerBudget)
      );
      await logAction({
        productId,
        action: "budget_rebalance",
        entityType: "adset",
        entityId: `${loser.adsetId}→${winner.adsetId}`,
        entityName: `${loser.adsetName} → ${winner.adsetName}`,
        details: `shift R$${shift} (loser ROAS ${loser.roas.toFixed(1)} → winner ROAS ${winner.roas.toFixed(1)})`,
        reasoning: `Rebalance priorizou score de performance e saude de entrega. Loser score ${getPerformanceScore(loser, product.automationConfig!).toFixed(1)} com freq ${loser.avgFrequency.toFixed(2)}${loser.avgHookRate !== null ? ` / hook ${loser.avgHookRate.toFixed(2)}` : ""}. Winner score ${getPerformanceScore(winner, product.automationConfig!).toFixed(1)} com freq ${winner.avgFrequency.toFixed(2)}${winner.avgHookRate !== null ? ` / hook ${winner.avgHookRate.toFixed(2)}` : ""}.`,
      });
      await sendNotification(
        "auto_action",
        {
          action: `REBALANCE (${product.slug})`,
          adset: `${loser.adsetName} → ${winner.adsetName}`,
          reason: `R$${shift} shift (ROAS ${loser.roas.toFixed(1)}→${winner.roas.toFixed(1)})`,
        },
        productId
      );
    }
  }
}

export async function rebalanceAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await rebalanceForProduct(p.id);
    } catch (err) {
      console.error(
        `[rebalance] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
