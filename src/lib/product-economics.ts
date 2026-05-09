// Deriva thresholds de automação a partir da economia do produto.
// Nada hardcoded — todo threshold sai desta função.
// Chamado no POST /api/products (criação) pra popular ProductAutomationConfig.
//
// CALIBRAÇÃO 2026-05-09: thresholds ajustados com base em dados reais de
// campanhas Sobral way que rodam na conta (top performers Advogados R$52
// CPA / Contadores R$69 / Mirror Winners R$88 / freq tolerada 3.44 /
// adsets rodam 5-7d antes de pause). Versão antiga era teórica conservadora.

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

  // Threshold de scale: dados reais mostram que top performers (Advogados R$52,
  // Contadores R$69) escalam em CPA até ~75% do breakeven. Multiplier 0.45-0.6
  // antigo era teórico demais, deixava agente de fora.
  const autoScaleCPAThresholdMultiplier =
    stage === "launch"
      ? 0.65
      : stage === "escalavel"
        ? 0.8
        : stage === "evergreen"
          ? 0.75
          : 0.7;
  const autoScaleCPAThreshold = netPerSale * autoScaleCPAThresholdMultiplier;

  // Pause de criativo individual: dado real mostra adsets rodando até CPA 1.25×
  // breakeven sem pause humano. Manter agente um pouco mais rígido pra proteger.
  const cpaPauseMultiplier =
    stage === "evergreen"
      ? 1.25
      : stage === "escalavel"
        ? 1.3
        : stage === "launch"
          ? 1.4
          : 1.3;
  const cpaPauseThreshold = netPerSale * cpaPauseMultiplier;

  // Limite de gasto sem venda: dado real mostra adsets sustentando até 2× breakeven
  // (algumas geram lead/IC sem purchase). Subi multiplier.
  const autoPauseSpendLimit = Math.max(
    breakevenCPA * (budgetTier === "starter" ? 2 : 2.5),
    stage === "launch" ? 150 : 130
  );

  // Min dias antes de pause breakeven: adsets reais rodam 5-7d antes de decisão
  // humana. Sobral way: "paciência > ansiedade". Subi de 2-3d → 4-5d.
  const breakevenMinDays =
    stage === "launch"
      ? budgetTier === "starter"
        ? 4
        : 3
      : stage === "evergreen"
        ? 5
        : 4;

  // % scale: Sobral original = +20%. Versão antiga 12% era tímida demais.
  // Mantém learning phase via cooldown 72h.
  const autoScalePercent =
    stage === "escalavel" ? 25 : stage === "launch" ? 20 : stage === "evergreen" ? 20 : 15;

  const autoScaleMinDays =
    stage === "launch" ? 3 : stage === "escalavel" ? 3 : stage === "evergreen" ? 3 : 3;

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

  // Frequency cap: dado real mostra adsets em prospec rodando até 3.44 sem pause
  // (gestor humano tolera). Subi de 2.6-3.2 → 3.0-3.5. Remarketing manter alto.
  const frequencyLimitProspection =
    stage === "launch" ? 3.5 : stage === "escalavel" ? 3.2 : stage === "evergreen" ? 3.0 : 3.3;
  const frequencyLimitRemarketing =
    stage === "launch" ? 8.0 : stage === "escalavel" ? 7.0 : 6.5;

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
