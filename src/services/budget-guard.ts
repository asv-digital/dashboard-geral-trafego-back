// Budget guard por produto. Usa ProductAutomationConfig pra caps/pisos
// derivados da economia do produto. Nada hardcoded.

import prisma from "../prisma";
import { getActiveAdsetsForCampaigns } from "../lib/meta-mutations";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";

const BUDGET_SAFETY_MARGIN = 0.95;

export type CampaignType = "prospection" | "remarketing" | "asc" | "other";

export function classifyCampaign(name: string): CampaignType {
  const upper = (name || "").toUpperCase();
  if (upper.includes("RMK") || upper.includes("REMARKETING") || upper.includes("RETARGETING")) return "remarketing";
  if (upper.includes("ASC") || upper.includes("ADVANTAGE")) return "asc";
  if (upper.includes("PROSP") || upper.includes("PROSPECCAO") || upper.includes("BROAD") || upper.includes("LAL")) return "prospection";
  return "other";
}

export interface BudgetAllocation {
  prospection: number;
  remarketing: number;
  asc: number;
  total: number;
  reserve: number;
}

export async function getCurrentAllocation(productId: string): Promise<BudgetAllocation> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  const { adAccountId: accountId } = await getResolvedProductMetaSettings(product);
  if (!product || !accountId) {
    return { prospection: 0, remarketing: 0, asc: 0, total: 0, reserve: 0 };
  }

  const campaigns = await prisma.campaign.findMany({
    where: { productId, metaCampaignId: { not: null } },
    select: { metaCampaignId: true, name: true },
  });
  if (campaigns.length === 0) {
    return {
      prospection: 0,
      remarketing: 0,
      asc: 0,
      total: 0,
      reserve: product.dailyBudgetTarget,
    };
  }
  const trackedIds = campaigns
    .map(c => c.metaCampaignId)
    .filter((id): id is string => id !== null);
  const nameById = new Map(campaigns.map(c => [c.metaCampaignId!, c.name]));

  const adsets = await getActiveAdsetsForCampaigns(accountId, trackedIds);
  const alloc: BudgetAllocation = {
    prospection: 0,
    remarketing: 0,
    asc: 0,
    total: 0,
    reserve: 0,
  };
  for (const a of adsets) {
    if (a.status !== "ACTIVE") continue;
    const type = classifyCampaign(nameById.get(a.campaignId) || "");
    if (type === "remarketing") alloc.remarketing += a.dailyBudget;
    else if (type === "asc") alloc.asc += a.dailyBudget;
    else alloc.prospection += a.dailyBudget;
  }
  alloc.total = alloc.prospection + alloc.remarketing + alloc.asc;
  alloc.reserve = Math.max(0, product.dailyBudgetTarget - alloc.total);
  return alloc;
}

async function getCaps(productId: string) {
  const cfg = await prisma.productAutomationConfig.findUnique({
    where: { productId },
  });
  if (!cfg) {
    // Loud-fail em vez de silenciosamente retornar tudo 0.
    // Retornar 0 significa "não deixa aumentar nada e remove tudo", o que
    // quebra budget-rebalancer sem dar sinal. Melhor explodir na origem.
    throw new Error(
      `[budget-guard] produto ${productId} sem ProductAutomationConfig — rode o seed ou crie o produto via POST /api/products (que deriva thresholds via product-economics).`
    );
  }
  return {
    capProspection: cfg.budgetCapProspection,
    capRemarketing: cfg.budgetCapRemarketing,
    capASC: cfg.budgetCapASC,
    floorProspection: cfg.budgetFloorProspection,
    floorRemarketing: cfg.budgetFloorRemarketing,
  };
}

export async function canIncreaseBudget(
  productId: string,
  campaignName: string,
  increaseAmount: number
): Promise<{ allowed: boolean; maxIncrease: number; reason?: string }> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return { allowed: false, maxIncrease: 0, reason: "produto não existe" };

  const alloc = await getCurrentAllocation(productId);
  const caps = await getCaps(productId);
  const type = classifyCampaign(campaignName);

  const currentForType =
    type === "remarketing" ? alloc.remarketing : type === "asc" ? alloc.asc : alloc.prospection;
  const capForType =
    type === "remarketing" ? caps.capRemarketing : type === "asc" ? caps.capASC : caps.capProspection;

  const availableForType = Math.max(0, capForType - currentForType);
  const maxTotal = product.dailyBudgetTarget * BUDGET_SAFETY_MARGIN;
  const availableTotal = Math.max(0, maxTotal - alloc.total);
  const available = Math.min(availableForType, availableTotal);

  if (available <= 0) {
    return {
      allowed: false,
      maxIncrease: 0,
      reason:
        availableForType <= 0
          ? `teto ${type}: R$${currentForType.toFixed(0)}/R$${capForType}`
          : `total ${alloc.total.toFixed(0)}/R$${product.dailyBudgetTarget}`,
    };
  }

  if (increaseAmount <= available) return { allowed: true, maxIncrease: increaseAmount };

  return {
    allowed: true,
    maxIncrease: available,
    reason: `limitado a R$${available.toFixed(0)}`,
  };
}

export async function canDecreaseBudget(
  productId: string,
  campaignName: string,
  decreaseAmount: number
): Promise<{ allowed: boolean; maxDecrease: number; reason?: string }> {
  const alloc = await getCurrentAllocation(productId);
  const caps = await getCaps(productId);
  const type = classifyCampaign(campaignName);

  const currentForType =
    type === "remarketing" ? alloc.remarketing : type === "asc" ? alloc.asc : alloc.prospection;
  const floorForType =
    type === "remarketing" ? caps.floorRemarketing : type === "asc" ? 0 : caps.floorProspection;

  const canRemove = Math.max(0, currentForType - floorForType);
  if (canRemove <= 0) {
    return {
      allowed: false,
      maxDecrease: 0,
      reason: `${type} já no piso: R$${currentForType.toFixed(0)}/R$${floorForType}`,
    };
  }
  return { allowed: true, maxDecrease: Math.min(decreaseAmount, canRemove) };
}
