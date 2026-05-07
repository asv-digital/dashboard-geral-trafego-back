// Learning phase tracker product-aware.
// Marca campanhas como "isInLearningPhase = false" após learningPhaseHours
// (72h por padrão). Notifica WhatsApp quando sai da fase.

import prisma from "../prisma";
import { logAction } from "./action-log";
import { sendNotification } from "./whatsapp-notifier";
import { getBudgetTier } from "../lib/planner-playbook";
import {
  getActiveAdsetsForCampaigns,
  getAdsetsLearningInfo,
  type AdsetLearningInfo,
} from "../lib/meta-mutations";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";

export function evaluateLearningPhaseExit(input: {
  hoursSince: number;
  learningPhaseHours: number;
  approvedSales: number;
  dailyBudgetTarget: number;
}): { shouldExit: boolean; reason: string; minApprovedSales: number; maxHoldHours: number } {
  const tier = getBudgetTier(input.dailyBudgetTarget);
  const minApprovedSales = tier === "starter" ? 2 : tier === "validated" ? 4 : 6;
  const maxHoldHours = Math.max(input.learningPhaseHours * 2, 96);

  if (input.hoursSince < input.learningPhaseHours) {
    return {
      shouldExit: false,
      reason: "tempo mínimo de learning ainda não atingido",
      minApprovedSales,
      maxHoldHours,
    };
  }

  if (input.approvedSales >= minApprovedSales) {
    return {
      shouldExit: true,
      reason: `sinal mínimo atingido (${input.approvedSales}/${minApprovedSales} vendas aprovadas)`,
      minApprovedSales,
      maxHoldHours,
    };
  }

  if (input.hoursSince >= maxHoldHours) {
    return {
      shouldExit: true,
      reason: `timeout de learning após ${input.hoursSince.toFixed(0)}h sem sinal suficiente`,
      minApprovedSales,
      maxHoldHours,
    };
  }

  return {
    shouldExit: false,
    reason: `aguardando sinal (${input.approvedSales}/${minApprovedSales} vendas aprovadas)`,
    minApprovedSales,
    maxHoldHours,
  };
}

/**
 * M10 — combina time-based + status oficial da Meta. Lê learning_stage_info
 * dos adsets de cada campanha em learning. Reglra de decisao:
 *   - se TODOS adsets retornam SUCCESS → exit imediato (Meta confirma).
 *   - se algum adset em LEARNING → mantem (Meta diz que ainda esta).
 *   - se Meta nao responde / status UNKNOWN → cai pra regra time+vendas.
 *   - se todos em LEARNING_LIMITED → loga aviso (sinal insuficiente) + mantem.
 */
function evaluateMetaLearningStatus(
  infos: AdsetLearningInfo[]
): { decision: "exit_meta" | "keep_meta" | "fallback"; note: string } {
  if (infos.length === 0) return { decision: "fallback", note: "sem adsets ativos" };

  const known = infos.filter(i => i.status !== "UNKNOWN");
  if (known.length === 0) return { decision: "fallback", note: "Meta retornou UNKNOWN p/ todos" };

  const learningCount = known.filter(i => i.status === "LEARNING").length;
  const limitedCount = known.filter(i => i.status === "LEARNING_LIMITED").length;
  const successCount = known.filter(i => i.status === "SUCCESS").length;

  if (learningCount === 0 && successCount > 0) {
    return {
      decision: "exit_meta",
      note: `${successCount}/${known.length} adsets em SUCCESS, ${limitedCount} em LIMITED, 0 em LEARNING`,
    };
  }
  if (learningCount > 0) {
    return {
      decision: "keep_meta",
      note: `${learningCount}/${known.length} adsets ainda em LEARNING (Meta)`,
    };
  }
  // Tudo em LEARNING_LIMITED — Meta diz que terminou learning mas sem volume.
  // Trata como exit (igual a SUCCESS) mas log mais explicito.
  return {
    decision: "exit_meta",
    note: `todos ${known.length} adsets em LEARNING_LIMITED — Meta encerrou learning mas com volume insuficiente`,
  };
}

export async function updateLearningPhaseForProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product || !product.automationConfig) return;
  if (!product.automationConfig.respectLearningPhase) return;

  const learningHours = product.automationConfig.learningPhaseHours;
  const now = new Date();

  const inLearning = await prisma.campaign.findMany({
    where: {
      productId,
      isInLearningPhase: true,
      createdInMetaAt: { not: null },
    },
  });
  if (inLearning.length === 0) return;

  // Busca adsets das campanhas em learning + learning_stage_info em batch.
  const { adAccountId: accountId } = await getResolvedProductMetaSettings(product);
  const trackedMetaIds = inLearning
    .map(c => c.metaCampaignId)
    .filter((id): id is string => !!id);
  const adsetsByCampaign = new Map<string, string[]>();
  let learningInfoByAdset = new Map<string, AdsetLearningInfo>();
  if (accountId && trackedMetaIds.length > 0) {
    try {
      const adsets = await getActiveAdsetsForCampaigns(accountId, trackedMetaIds);
      for (const a of adsets) {
        if (a.status !== "ACTIVE") continue;
        const arr = adsetsByCampaign.get(a.campaignId) ?? [];
        arr.push(a.id);
        adsetsByCampaign.set(a.campaignId, arr);
      }
      const allAdsetIds = adsets.filter(a => a.status === "ACTIVE").map(a => a.id);
      learningInfoByAdset = await getAdsetsLearningInfo(allAdsetIds);
    } catch (err) {
      console.error(
        `[learning-phase] erro ao buscar Meta status: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  for (const c of inLearning) {
    if (!c.createdInMetaAt) continue;
    const hoursSince = (now.getTime() - c.createdInMetaAt.getTime()) / (1000 * 60 * 60);
    const campaignFilters: Array<{ campaignId?: string; metaCampaignId?: string }> = [
      { campaignId: c.id },
    ];
    if (c.metaCampaignId) {
      campaignFilters.push({ metaCampaignId: c.metaCampaignId });
    }
    const approvedSales = await prisma.sale.count({
      where: {
        productId,
        status: "approved",
        date: { gte: c.createdInMetaAt },
        OR: campaignFilters,
      },
    });

    // Time-based fallback decision (regra anterior, mantida como red queen).
    const timeBasedDecision = evaluateLearningPhaseExit({
      hoursSince,
      learningPhaseHours: learningHours,
      approvedSales,
      dailyBudgetTarget: product.dailyBudgetTarget,
    });

    // Meta-based decision (M10).
    const adsetIds = c.metaCampaignId ? adsetsByCampaign.get(c.metaCampaignId) ?? [] : [];
    const metaInfos = adsetIds
      .map(id => learningInfoByAdset.get(id))
      .filter((i): i is AdsetLearningInfo => !!i);
    const metaEval = evaluateMetaLearningStatus(metaInfos);

    let shouldExit = false;
    let reason = "";
    let source: "meta" | "time" = "time";
    if (metaEval.decision === "exit_meta") {
      shouldExit = true;
      reason = `Meta: ${metaEval.note}`;
      source = "meta";
    } else if (metaEval.decision === "keep_meta") {
      // Meta diz que ainda esta em LEARNING — respeita Meta sobre time.
      shouldExit = false;
      reason = `Meta: ${metaEval.note}`;
      source = "meta";
    } else {
      // fallback time-based
      shouldExit = timeBasedDecision.shouldExit;
      reason = `time-fallback: ${timeBasedDecision.reason}`;
      source = "time";
    }

    if (shouldExit) {
      await prisma.campaign.update({
        where: { id: c.id },
        data: { isInLearningPhase: false, learningPhaseEnd: now },
      });
      await logAction({
        productId,
        action: "learning_phase_exit",
        entityType: "campaign",
        entityId: c.id,
        entityName: c.name,
        details: `Saiu da learning phase após ${hoursSince.toFixed(0)}h — ${reason}`,
        reasoning: `Decisao baseada em ${source}. ${reason}. Adsets ativos: ${adsetIds.length} (Meta retornou status pra ${metaInfos.length}). Vendas aprovadas: ${approvedSales}.`,
        inputSnapshot: {
          source,
          approvedSales,
          hoursSince,
          minApprovedSales: timeBasedDecision.minApprovedSales,
          maxHoldHours: timeBasedDecision.maxHoldHours,
          learningPhaseHours: learningHours,
          metaInfos: metaInfos.map(i => ({ adsetId: i.adsetId, status: i.status, exitReason: i.exitReason })),
        },
      });
      await sendNotification(
        "learning_phase_exit",
        { campaign: c.name },
        productId
      );
    }
  }
}

export async function updateLearningPhaseAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await updateLearningPhaseForProduct(p.id);
    } catch (err) {
      console.error(
        `[learning-phase] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
