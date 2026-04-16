// Deriva thresholds de automação a partir da economia do produto.
// Nada hardcoded — todo threshold sai desta função.
// Chamado no POST /api/products (criação) pra popular ProductAutomationConfig.

import { getBudgetTier } from "./planner-playbook";

export interface ProductEconomicsInput {
  priceGross: number;
  gatewayFeeRate: number;
  netPerSale: number;
  dailyBudgetTarget: number;
  stage: "launch" | "evergreen" | "escalavel" | "nicho";
}

export interface DerivedThresholds {
  breakevenCPA: number;
  autoScaleCPAThreshold: number;
  autoScaleMaxBudget: number;
  autoScaleMinDays: number;
  cpaPauseThreshold: number;
  budgetCapProspection: number;
  budgetCapRemarketing: number;
  budgetCapASC: number;
  budgetFloorProspection: number;
  budgetFloorRemarketing: number;
  autoPauseSpendLimit: number;
  frequencyLimitProspection: number;
  frequencyLimitRemarketing: number;
  daypartingEnabled: boolean;
  autoScalePercent: number;
  breakevenMinDays: number;
}

export function deriveThresholds(input: ProductEconomicsInput): DerivedThresholds {
  const { netPerSale, dailyBudgetTarget, stage } = input;
  const budgetTier = getBudgetTier(dailyBudgetTarget);

  const breakevenCPA = netPerSale;
  const autoScaleCPAThresholdMultiplier =
    stage === "launch"
      ? 0.45
      : stage === "escalavel"
        ? 0.6
        : stage === "evergreen"
          ? 0.55
          : 0.5;
  const autoScaleCPAThreshold = netPerSale * autoScaleCPAThresholdMultiplier;

  const cpaPauseMultiplier =
    stage === "evergreen"
      ? 1.1
      : stage === "escalavel"
        ? 1.15
        : stage === "launch"
          ? 1.25
          : 1.2;
  const cpaPauseThreshold = netPerSale * cpaPauseMultiplier;

  const autoPauseSpendLimit = Math.max(
    breakevenCPA * (budgetTier === "starter" ? 1.6 : 2),
    stage === "launch" ? 120 : 100
  );

  const breakevenMinDays =
    stage === "launch"
      ? budgetTier === "starter"
        ? 3
        : 2
      : stage === "evergreen"
        ? 3
        : 2;

  const autoScalePercent =
    stage === "escalavel" ? 20 : stage === "launch" ? 15 : stage === "evergreen" ? 12 : 10;

  const autoScaleMinDays =
    stage === "launch" ? 3 : stage === "escalavel" ? 2 : stage === "evergreen" ? 3 : 3;

  const autoScaleMaxBudget =
    dailyBudgetTarget *
    (stage === "escalavel" ? 3 : stage === "evergreen" ? 2.5 : stage === "launch" ? 2 : 2);

  const budgetCapProspection = Math.round(
    dailyBudgetTarget *
      (stage === "nicho" ? 0.7 : stage === "launch" ? 0.65 : stage === "escalavel" ? 0.5 : 0.45)
  );
  const budgetCapRemarketing = Math.round(
    dailyBudgetTarget *
      (stage === "launch" ? 0.2 : stage === "evergreen" ? 0.35 : stage === "escalavel" ? 0.3 : 0.4)
  );
  const budgetCapASC = Math.round(
    dailyBudgetTarget *
      (stage === "nicho" ? 0.25 : stage === "launch" ? 0.45 : stage === "escalavel" ? 0.45 : 0.35)
  );
  const budgetFloorProspection = Math.round(
    dailyBudgetTarget * (stage === "evergreen" ? 0.2 : 0.25)
  );
  const budgetFloorRemarketing = Math.round(
    dailyBudgetTarget * (stage === "launch" ? 0.1 : 0.15)
  );

  const frequencyLimitProspection =
    stage === "launch" ? 3.2 : stage === "escalavel" ? 2.8 : stage === "evergreen" ? 2.6 : 3.0;
  const frequencyLimitRemarketing =
    stage === "launch" ? 8.0 : stage === "escalavel" ? 6.5 : 6.0;

  const daypartingEnabled =
    (stage === "evergreen" || stage === "escalavel") && dailyBudgetTarget >= 350;

  return {
    breakevenCPA,
    autoScaleCPAThreshold,
    autoScaleMaxBudget,
    autoScaleMinDays,
    cpaPauseThreshold,
    budgetCapProspection,
    budgetCapRemarketing,
    budgetCapASC,
    budgetFloorProspection,
    budgetFloorRemarketing,
    autoPauseSpendLimit,
    frequencyLimitProspection,
    frequencyLimitRemarketing,
    daypartingEnabled,
    autoScalePercent,
    breakevenMinDays,
  };
}

// Helper: calcula netPerSale automaticamente a partir de preço + fee
export function computeNetPerSale(priceGross: number, gatewayFeeRate: number): number {
  return Number((priceGross * (1 - gatewayFeeRate)).toFixed(2));
}

// Pisos de qualidade pra liberar scale. Derivados do estágio do produto
// (produto em learning/launch tolera números um pouco mais baixos; produto
// já escalável/evergreen precisa sustentar qualidade pra crescer budget).
// Campanhas de remarketing sempre têm pisos mais relaxados (audiência quente).
export interface QualityFloors {
  hookRate: number;
  outboundCtr: number;
}

export function getQualityFloors(
  stage: ProductEconomicsInput["stage"],
  campaignType: "prospection" | "remarketing" | "asc" | "other"
): QualityFloors {
  const isRemarketing = campaignType === "remarketing";
  const hookBase = isRemarketing ? 2.3 : 3.2;
  const ctrBase = isRemarketing ? 0.65 : 0.85;

  const tightness =
    stage === "escalavel" ? 1.15 : stage === "evergreen" ? 1.05 : stage === "nicho" ? 1 : 0.9;

  return {
    hookRate: Number((hookBase * tightness).toFixed(2)),
    outboundCtr: Number((ctrBase * tightness).toFixed(2)),
  };
}
