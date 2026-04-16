// Learning phase tracker product-aware.
// Marca campanhas como "isInLearningPhase = false" após learningPhaseHours
// (72h por padrão). Notifica WhatsApp quando sai da fase.

import prisma from "../prisma";
import { logAction } from "./action-log";
import { sendNotification } from "./whatsapp-notifier";
import { getBudgetTier } from "../lib/planner-playbook";

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
    const learningDecision = evaluateLearningPhaseExit({
      hoursSince,
      learningPhaseHours: learningHours,
      approvedSales,
      dailyBudgetTarget: product.dailyBudgetTarget,
    });

    if (learningDecision.shouldExit) {
      await prisma.campaign.update({
        where: { id: c.id },
        data: {
          isInLearningPhase: false,
          learningPhaseEnd: now,
        },
      });
      await logAction({
        productId,
        action: "learning_phase_exit",
        entityType: "campaign",
        entityId: c.id,
        entityName: c.name,
        details: `Saiu da learning phase após ${hoursSince.toFixed(0)}h (${learningDecision.reason})`,
        inputSnapshot: {
          approvedSales,
          minApprovedSales: learningDecision.minApprovedSales,
          maxHoldHours: learningDecision.maxHoldHours,
          learningPhaseHours: learningHours,
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
