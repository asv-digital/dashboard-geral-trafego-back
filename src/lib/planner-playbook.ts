export type StrategyStage = "launch" | "evergreen" | "escalavel" | "nicho";
export type StrategyBudgetTier = "starter" | "validated" | "scale";
export type PlannerAudienceKey =
  | "advantage_plus"
  | "broad"
  | "lookalike_1_3"
  | "website_visitors_30d";

type PlannerCampaignType = "Prospecção" | "Remarketing" | "ASC";
type PlannerFunnelStage = "cold" | "warm" | "scale";

export interface PlannerPlaybookCampaign {
  name: string;
  type: PlannerCampaignType;
  dailyBudget: number;
  audience: string;
  targeting: Record<string, unknown>;
  optimizationGoal: string;
  usesAdvantage: boolean;
  budgetWeight?: number;
  priority?: number;
  funnelStage?: PlannerFunnelStage;
  copyAngle?: string;
  objective?: string;
  strategyNote?: string;
  creativeSlotLimit?: number;
}

export interface PlannerAudienceAvailability {
  lookalike?: { id: string; name: string } | null;
  warmAudience?: { id: string; name: string } | null;
}

export interface StrategyAssetRecommendations {
  recommendedMediaAssets: number;
  recommendedTextAssets: number;
  creativeSlotLimit: number;
  notes: string[];
}

function roundTargetBudget(targetBudget: number): number {
  return Math.max(1, Math.round(targetBudget));
}

function allocateBudgets(
  playbook: PlannerPlaybookCampaign[],
  targetBudget: number
): PlannerPlaybookCampaign[] {
  if (playbook.length === 0) return [];

  const roundedTarget = Math.max(playbook.length, roundTargetBudget(targetBudget));
  const totalWeight = playbook.reduce(
    (sum, plan) => sum + (plan.budgetWeight && plan.budgetWeight > 0 ? plan.budgetWeight : 1),
    0
  );

  const rawAllocations = playbook.map(plan => {
    const weight = plan.budgetWeight && plan.budgetWeight > 0 ? plan.budgetWeight : 1;
    const rawBudget = (roundedTarget * weight) / totalWeight;
    return {
      plan,
      rawBudget,
      baseBudget: Math.max(1, Math.floor(rawBudget)),
      fractional: rawBudget - Math.floor(rawBudget),
    };
  });

  let remaining = roundedTarget - rawAllocations.reduce((sum, item) => sum + item.baseBudget, 0);
  const sorted = [...rawAllocations].sort((a, b) => b.fractional - a.fractional);

  for (let i = 0; i < sorted.length && remaining > 0; i++) {
    sorted[i].baseBudget += 1;
    remaining--;
  }

  return playbook.map(plan => {
    const allocation = sorted.find(item => item.plan.name === plan.name && item.plan.type === plan.type);
    return {
      ...plan,
      dailyBudget: allocation?.baseBudget ?? Math.max(1, Math.round(plan.dailyBudget)),
    };
  });
}

function targetingBase(
  ageMin: number,
  ageMax: number,
  usesAdvantage: boolean
): Record<string, unknown> {
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: ["BR"] },
    age_min: ageMin,
    age_max: ageMax,
  };

  // Advantage-style structures keep placements more abertas; the rest stays on FB/IG.
  if (!usesAdvantage) {
    targeting.publisher_platforms = ["facebook", "instagram"];
  }

  return targeting;
}

function coldCampaign(
  name: string,
  weight: number,
  options: {
    ageMin: number;
    ageMax: number;
    copyAngle: string;
    objective: string;
    strategyNote: string;
    creativeSlotLimit: number;
    priority: number;
    usesAdvantage?: boolean;
    audience?: PlannerAudienceKey;
  }
): PlannerPlaybookCampaign {
  const usesAdvantage = options.usesAdvantage ?? false;

  return {
    name,
    type: usesAdvantage ? "ASC" : "Prospecção",
    dailyBudget: 0,
    budgetWeight: weight,
    audience: options.audience || (usesAdvantage ? "advantage_plus" : "broad"),
    targeting: targetingBase(options.ageMin, options.ageMax, usesAdvantage),
    optimizationGoal: "OFFSITE_CONVERSIONS",
    usesAdvantage,
    priority: options.priority,
    funnelStage: usesAdvantage ? "scale" : "cold",
    copyAngle: options.copyAngle,
    objective: options.objective,
    strategyNote: options.strategyNote,
    creativeSlotLimit: options.creativeSlotLimit,
  };
}

function warmCampaign(
  name: string,
  weight: number,
  creativeSlotLimit: number,
  copyAngle: string,
  objective: string,
  strategyNote: string
): PlannerPlaybookCampaign {
  return {
    name,
    type: "Remarketing",
    dailyBudget: 0,
    budgetWeight: weight,
    audience: "website_visitors_30d",
    targeting: targetingBase(18, 65, false),
    optimizationGoal: "OFFSITE_CONVERSIONS",
    usesAdvantage: false,
    priority: 4,
    funnelStage: "warm",
    copyAngle,
    objective,
    strategyNote,
    creativeSlotLimit,
  };
}

function lookalikeCampaign(
  name: string,
  weight: number,
  creativeSlotLimit: number,
  copyAngle: string,
  objective: string,
  strategyNote: string
): PlannerPlaybookCampaign {
  return {
    name,
    type: "Prospecção",
    dailyBudget: 0,
    budgetWeight: weight,
    audience: "lookalike_1_3",
    targeting: targetingBase(21, 55, false),
    optimizationGoal: "OFFSITE_CONVERSIONS",
    usesAdvantage: false,
    priority: 3,
    funnelStage: "cold",
    copyAngle,
    objective,
    strategyNote,
    creativeSlotLimit,
  };
}

export function getBudgetTier(dailyBudgetTarget: number): StrategyBudgetTier {
  if (dailyBudgetTarget < 300) return "starter";
  if (dailyBudgetTarget < 800) return "validated";
  return "scale";
}

export function getCreativeSlotLimit(
  stage: StrategyStage,
  dailyBudgetTarget: number
): number {
  const tier = getBudgetTier(dailyBudgetTarget);
  let slots = tier === "starter" ? 2 : tier === "validated" ? 3 : 4;

  if ((stage === "escalavel" || stage === "evergreen") && slots < 5) {
    slots += 1;
  }

  return Math.min(slots, 6);
}

export function getStrategyAssetRecommendations(
  stage: StrategyStage,
  dailyBudgetTarget: number
): StrategyAssetRecommendations {
  const tier = getBudgetTier(dailyBudgetTarget);
  let recommendedMediaAssets = tier === "starter" ? 2 : tier === "validated" ? 4 : 6;
  let recommendedTextAssets = tier === "starter" ? 2 : tier === "validated" ? 3 : 4;

  if (stage === "escalavel" || stage === "evergreen") {
    recommendedMediaAssets = Math.min(6, recommendedMediaAssets + 1);
    recommendedTextAssets += 1;
  }

  return {
    recommendedMediaAssets,
    recommendedTextAssets,
    creativeSlotLimit: getCreativeSlotLimit(stage, dailyBudgetTarget),
    notes: [
      "Comece com poucas estruturas em learning ao mesmo tempo para não fragmentar sinal.",
      "Mantenha variacao real de criativos e angulos de mensagem, nao apenas duplicacao do mesmo video.",
      stage === "escalavel" || stage === "evergreen"
        ? "Escala sustentavel pede camada fria, camada automatizada e camada quente com mensagem de prova/objecao."
        : "Lancamento pede conta simples, criativo forte e validacao antes de pulverizar segmentacao.",
    ],
  };
}

export function buildPlannerPlaybook(
  stage: StrategyStage,
  dailyBudgetTarget: number
): PlannerPlaybookCampaign[] {
  const tier = getBudgetTier(dailyBudgetTarget);
  const creativeSlotLimit = getCreativeSlotLimit(stage, dailyBudgetTarget);

  let playbook: PlannerPlaybookCampaign[];

  if (stage === "launch") {
    if (tier === "starter") {
      playbook = [
        coldCampaign("PROSP Broad — Controle", 0.55, {
          ageMin: 21,
          ageMax: 55,
          copyAngle: "dor + mecanismo",
          objective: "validar oferta com audiencia aberta sem pulverizar budget",
          strategyNote:
            "Estrutura compacta para preservar aprendizado e descobrir rapido qual mensagem segura o clique.",
          creativeSlotLimit,
          priority: 3,
        }),
        coldCampaign("ASC — Validacao", 0.45, {
          ageMin: 18,
          ageMax: 65,
          copyAngle: "beneficio direto + prova",
          objective: "dar latitude para a entrega automatizada encontrar compradores",
          strategyNote:
            "Campanha ampla para deixar a IA encontrar bolsos de conversao sem excesso de filtros.",
          creativeSlotLimit,
          priority: 2,
          usesAdvantage: true,
        }),
      ];
    } else if (tier === "validated") {
      playbook = [
        coldCampaign("PROSP Broad — Controle", 0.35, {
          ageMin: 21,
          ageMax: 55,
          copyAngle: "dor + mecanismo",
          objective: "descobrir a mensagem base que mais segura o publico frio",
          strategyNote:
            "Anuncio mais limpo para servir de controle de conta e benchmark de CPA.",
          creativeSlotLimit,
          priority: 4,
        }),
        coldCampaign("PROSP Broad — Prova", 0.3, {
          ageMin: 21,
          ageMax: 55,
          copyAngle: "prova + autoridade",
          objective: "testar prova social/resultado como alavanca de conversao",
          strategyNote:
            "Angulo de prova tende a separar curiosidade de intencao quando a oferta ja tem validacao.",
          creativeSlotLimit,
          priority: 3,
        }),
        coldCampaign("ASC — Validacao", 0.35, {
          ageMin: 18,
          ageMax: 65,
          copyAngle: "beneficio claro + CTA",
          objective: "deixar a entrega automatizada ampliar a descoberta de audiencia",
          strategyNote:
            "Mantem account simplificada e usa automacao para encontrar pockets de compra.",
          creativeSlotLimit,
          priority: 2,
          usesAdvantage: true,
        }),
      ];
    } else {
      playbook = [
        coldCampaign("PROSP Broad — Controle", 0.28, {
          ageMin: 21,
          ageMax: 55,
          copyAngle: "dor + mecanismo",
          objective: "manter referencia de publico frio com mensagem base",
          strategyNote:
            "Conta continua simples, mas ja com espaco para separar angulos de mensagem.",
          creativeSlotLimit,
          priority: 4,
        }),
        coldCampaign("PROSP Broad — Prova", 0.22, {
          ageMin: 21,
          ageMax: 55,
          copyAngle: "prova + resultado",
          objective: "escalar um angulo de prova sem misturar com o controle",
          strategyNote:
            "Prova forte ajuda a transformar um lancamento promissor em conta escalavel.",
          creativeSlotLimit,
          priority: 3,
        }),
        coldCampaign("PROSP Broad — Oferta", 0.15, {
          ageMin: 21,
          ageMax: 55,
          copyAngle: "oferta + CTA",
          objective: "testar resposta a urgencia e oferta ainda no publico frio",
          strategyNote:
            "Usa oferta e CTA para entender sensibilidade de preco e impulso de compra.",
          creativeSlotLimit,
          priority: 2,
        }),
        coldCampaign("ASC — Validacao", 0.35, {
          ageMin: 18,
          ageMax: 65,
          copyAngle: "beneficio amplo + prova",
          objective: "escalar descoberta com automacao sem travar em segmentacao demais",
          strategyNote:
            "A camada automatizada ajuda a capturar bolsos de demanda que o broad manual nao ve.",
          creativeSlotLimit,
          priority: 1,
          usesAdvantage: true,
        }),
      ];
    }

    return allocateBudgets(playbook, dailyBudgetTarget);
  }

  if (stage === "escalavel") {
    playbook = [
      coldCampaign("ASC — Escala", 0.3, {
        ageMin: 18,
        ageMax: 65,
        copyAngle: "beneficio amplo + prova",
        objective: "capturar demanda expandida com automacao e estrutura simplificada",
        strategyNote:
          "A camada automatizada sustenta escala enquanto os outros conjuntos servem de controle e defesa.",
        creativeSlotLimit,
        priority: 1,
        usesAdvantage: true,
      }),
      coldCampaign("PROSP Broad — Controle", 0.28, {
        ageMin: 21,
        ageMax: 55,
        copyAngle: "dor + mecanismo",
        objective: "manter benchmark frio e validar se a escala continua saudavel fora do algoritmo",
        strategyNote:
          "Broad de controle protege a conta contra falsa sensacao de performance so em automacao.",
        creativeSlotLimit,
        priority: 3,
      }),
      lookalikeCampaign(
        "PROSP LAL 1-3% — Compradores",
        0.22,
        creativeSlotLimit,
        "prova + semelhanca",
        "expandir sinal de compradores sem depender so de broad",
        "Usa sinal de compradores para abrir escala com um publico mais qualificado."
      ),
      warmCampaign(
        "RMK Quente — Prova e Objecao",
        0.2,
        creativeSlotLimit,
        "objecao + prova + CTA",
        "recuperar demanda morna/quente com mensagem de fechamento",
        "Remarketing entra como camada de eficiencia: menos descoberta, mais fechamento."
      ),
    ];

    return allocateBudgets(playbook, dailyBudgetTarget);
  }

  if (stage === "evergreen") {
    playbook = [
      coldCampaign("PROSP Broad — Controle", 0.25, {
        ageMin: 23,
        ageMax: 55,
        copyAngle: "dor + mecanismo",
        objective: "manter previsibilidade no topo de funil",
        strategyNote:
          "Conta evergreen precisa de um broad consistente para alimentar aprendizado continuo.",
        creativeSlotLimit,
        priority: 3,
      }),
      coldCampaign("ASC — Sustentacao", 0.25, {
        ageMin: 18,
        ageMax: 65,
        copyAngle: "beneficio direto + prova",
        objective: "aproveitar automacao para ganho marginal sem romper previsibilidade",
        strategyNote:
          "A camada automatizada trabalha como sustentacao e nao como unica fonte de venda.",
        creativeSlotLimit,
        priority: 2,
        usesAdvantage: true,
      }),
      lookalikeCampaign(
        "PROSP LAL 1-3% — Compradores",
        0.2,
        creativeSlotLimit,
        "prova + semelhanca",
        "renovar o frio com publico parecido com comprador",
        "Lookalike entra como camada de expansao controlada para fugir de fadiga do broad."
      ),
      warmCampaign(
        "RMK Quente — Oferta e Urgencia",
        0.3,
        creativeSlotLimit,
        "oferta + urgencia + objecao",
        "transformar visitas e engajamento em caixa com mensagem de fechamento",
        "Warm audience deve falar com prova, objecao e senso de decisao, nao com descoberta."
      ),
    ];

    return allocateBudgets(playbook, dailyBudgetTarget);
  }

  playbook =
    tier === "starter"
      ? [
          coldCampaign("PROSP Nicho — Controle", 0.65, {
            ageMin: 23,
            ageMax: 60,
            copyAngle: "dor especifica + mecanismo",
            objective: "validar narrativa principal num mercado mais especifico sem supersegmentar",
            strategyNote:
              "Mesmo em nicho, a conta precisa manter simplicidade para nao matar entrega cedo.",
            creativeSlotLimit,
            priority: 3,
          }),
          warmCampaign(
            "RMK Quente — Objecao",
            0.35,
            creativeSlotLimit,
            "objecao + prova",
            "fechar quem ja mostrou interesse e travou por duvida",
            "No nicho, remarketing forte costuma fazer diferenca porque a base fria e menor."
          ),
        ]
      : [
          coldCampaign("PROSP Nicho — Controle", 0.4, {
            ageMin: 23,
            ageMax: 60,
            copyAngle: "dor especifica + mecanismo",
            objective: "sustentar topo de funil com mensagem base de nicho",
            strategyNote:
              "Estrutura de nicho precisa clareza de promessa para nao ficar pequena demais.",
            creativeSlotLimit,
            priority: 3,
          }),
          coldCampaign("PROSP Nicho — Prova", 0.25, {
            ageMin: 23,
            ageMax: 60,
            copyAngle: "prova + resultado",
            objective: "testar prova especifica como acelerador de confianca",
            strategyNote:
              "Quando o mercado e mais especifico, prova concreta ajuda muito a destravar clique.",
            creativeSlotLimit,
            priority: 2,
          }),
          warmCampaign(
            "RMK Quente — Objecao",
            0.35,
            creativeSlotLimit,
            "objecao + prova + CTA",
            "recuperar demanda acumulada com mensagem de fechamento",
            "Warm audience fecha a conta de nicho, especialmente quando a objeção e forte.",
          ),
        ];

  return allocateBudgets(playbook, dailyBudgetTarget);
}

export function resolvePlaybookAudienceTargets(
  playbook: PlannerPlaybookCampaign[],
  availability: PlannerAudienceAvailability,
  targetBudget?: number
): { planned: PlannerPlaybookCampaign[]; warnings: string[] } {
  const planned: PlannerPlaybookCampaign[] = [];
  const warnings: string[] = [];

  for (const plan of playbook) {
    if (plan.audience === "lookalike_1_3") {
      if (!availability.lookalike?.id) {
        warnings.push(
          `${plan.name}: lookalike 1-3% indisponivel; budget sera redistribuido entre as estruturas restantes.`
        );
        continue;
      }

      planned.push({
        ...plan,
        audience: availability.lookalike.name,
        targeting: {
          ...plan.targeting,
          custom_audiences: [{ id: availability.lookalike.id }],
        },
      });
      continue;
    }

    if (plan.audience === "website_visitors_30d") {
      if (!availability.warmAudience?.id) {
        warnings.push(
          `${plan.name}: audiencia quente de remarketing nao configurada; budget sera redistribuido entre as estruturas restantes.`
        );
        continue;
      }

      planned.push({
        ...plan,
        audience: availability.warmAudience.name,
        targeting: {
          ...plan.targeting,
          custom_audiences: [{ id: availability.warmAudience.id }],
        },
      });
      continue;
    }

    planned.push(plan);
  }

  const resolvedTargetBudget =
    targetBudget ?? playbook.reduce((sum, plan) => sum + plan.dailyBudget, 0);
  const normalized = allocateBudgets(planned, resolvedTargetBudget);

  if (warnings.length > 0 && normalized.length > 0) {
    warnings.push(
      `Playbook reequilibrado para manter o budget em ${normalized.length} estrutura(s) vivas sem pulverizar aprendizagem.`
    );
  }

  return { planned: normalized, warnings };
}
