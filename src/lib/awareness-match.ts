// Cruzamento Stages of Awareness × tipo de campanha (audiência) — princípio
// Schwartz aplicado em decisão. Cold (Prospecção) deve ter copy unaware/problem;
// warm (Remarketing) usa solution/product; ASC/most_aware = remarketing-quente.
//
// Mismatch grave = copy product-aware em audiência cold. CPA explode.

export type AwarenessStage =
  | "unaware"
  | "problem"
  | "solution"
  | "product"
  | "most_aware";

export type AudienceType = "Prospecção" | "Remarketing" | "ASC";

export type MatchScore = "ideal" | "ok" | "warn" | "mismatch";

interface MatchResult {
  score: MatchScore;
  reason: string;
}

// Matriz de compatibilidade. Linhas = stage, colunas = audience.
const MATRIX: Record<AwarenessStage, Record<AudienceType, MatchScore>> = {
  unaware: {
    Prospecção: "ideal",      // copy educa, audiência fria
    Remarketing: "warn",       // já viu sua marca, falar de "problema" é regredir
    ASC: "ok",                 // ASC mistura, OK
  },
  problem: {
    Prospecção: "ideal",      // descrever dor pra cold é o sweet spot
    Remarketing: "ok",         // pode ainda servir
    ASC: "ideal",              // problem-aware funciona em qualquer mistura
  },
  solution: {
    Prospecção: "ok",         // já adianta solução pra cold é otimista mas funciona
    Remarketing: "ideal",      // pessoa volta sabendo o problema, mostra solução
    ASC: "ideal",
  },
  product: {
    Prospecção: "mismatch",   // GRAVE: vender produto pra quem não sabe do problema
    Remarketing: "ideal",      // mostrar produto pra quem já é solution-aware = closer
    ASC: "ideal",
  },
  most_aware: {
    Prospecção: "mismatch",   // GRAVE: CTA forte pra cold é desperdício
    Remarketing: "ideal",      // pessoa já comparou, agora fechar
    ASC: "ideal",              // ASC fecha quente
  },
};

const REASONS: Record<MatchScore, string> = {
  ideal: "combinação ideal Schwartz",
  ok: "combinação aceitável",
  warn: "combinação fraca — copy não bate com nível de consciência da audiência",
  mismatch:
    "MISMATCH GRAVE — copy avançada (product/most-aware) em audiência fria. CPA tende a explodir.",
};

export function evaluateAwarenessMatch(
  stage: AwarenessStage | null | undefined,
  audience: AudienceType | string | null | undefined
): MatchResult | null {
  if (!stage || !audience) return null;
  const audienceTyped = (
    ["Prospecção", "Remarketing", "ASC"].includes(audience as string)
      ? audience
      : "Prospecção"
  ) as AudienceType;
  const score = MATRIX[stage]?.[audienceTyped];
  if (!score) return null;
  return { score, reason: REASONS[score] };
}

/**
 * Retorna lista de criativos com mismatch (warn ou mismatch). Usado pelo
 * front pra mostrar alerta "criativo X em audiencia errada".
 */
export interface CreativeMismatch {
  creativeId: string;
  creativeName: string;
  awarenessStage: AwarenessStage;
  audience: AudienceType;
  campaignName: string;
  cpa: number | null;
  hookRate: number | null;
  matchScore: MatchScore;
  reason: string;
}
