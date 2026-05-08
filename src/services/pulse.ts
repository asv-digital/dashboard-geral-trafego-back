// Pulse: 1 frase que resume estado do produto em 5 segundos.
// Combina waterfall + pacing + fatigue + mismatches + supervised mode.

import prisma from "../prisma";
import { getProfitWaterfall, getFatiguePredictions, getAwarenessMismatches } from "./analytics";
import { getMonthlyPace } from "../lib/monthly-pace";

export type PulseTone = "success" | "warning" | "danger" | "info" | "muted";

export type PulseResult = {
  tone: PulseTone;
  message: string;
  detail: string;
  signals: {
    profit: number;
    cpa: number;
    sales: number;
    paceRatio: number;
    paceStatus: string;
    fatiguedCreatives: number;
    mismatches: number;
    supervisedMode: boolean;
  };
};

export async function getProductPulse(productId: string, days = 7): Promise<PulseResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return {
      tone: "muted",
      message: "Sem dados",
      detail: "produto nao encontrado",
      signals: {
        profit: 0,
        cpa: 0,
        sales: 0,
        paceRatio: 0,
        paceStatus: "unknown",
        fatiguedCreatives: 0,
        mismatches: 0,
        supervisedMode: false,
      },
    };
  }

  const [waterfall, pace, fatigue, mismatches] = await Promise.all([
    getProfitWaterfall(productId, days).catch(() => null),
    getMonthlyPace(productId).catch(() => null),
    getFatiguePredictions(productId).catch(() => null),
    getAwarenessMismatches(productId, 30).catch(() => null),
  ]);

  const profit = waterfall?.contributionMargin ?? 0;
  const sales = waterfall?.approvedSales ?? 0;
  const cpa = sales > 0 && waterfall ? waterfall.spend / sales : 0;
  const dailySales = sales / Math.max(days, 1);
  const paceRatio = pace?.paceRatio ?? 0;
  const paceStatus = pace?.status ?? "unknown";
  const fatiguedCreatives = fatigue?.predictions?.filter(p => p.status === "declining" || p.status === "critical").length ?? 0;
  const mismatchCount = mismatches?.bySeverity?.mismatch ?? 0;
  const supervisedMode = !!product.supervisedMode;

  // Decisao de tom — pior sinal vence
  let tone: PulseTone = "success";
  let message = "Saudavel";
  const reasons: string[] = [];

  if (supervisedMode) {
    tone = "info";
    message = "Modo supervisionado ativo";
    reasons.push("agente nao executa acoes automaticamente");
  }

  if (profit < 0) {
    tone = "danger";
    message = "Risco — lucro negativo";
    reasons.push(`R$ ${profit.toFixed(0)} no periodo`);
  } else if (paceStatus === "critical") {
    tone = "danger";
    message = "Risco — pacing critico";
    reasons.push(`${(paceRatio * 100).toFixed(0)}% da meta mensal`);
  } else if (fatiguedCreatives >= 3) {
    tone = "warning";
    message = "Atencao — fadiga em multiplos criativos";
    reasons.push(`${fatiguedCreatives} criativos com sinal alto/critico`);
  } else if (paceStatus === "behind") {
    tone = "warning";
    message = "Atencao — abaixo do pacing";
    reasons.push(`${(paceRatio * 100).toFixed(0)}% da meta mensal`);
  } else if (mismatchCount > 0) {
    tone = "warning";
    message = "Atencao — mismatch awareness x audiencia";
    reasons.push(`${mismatchCount} criativos fora do encaixe`);
  } else if (fatiguedCreatives >= 1) {
    tone = "info";
    message = "Saudavel — atencao em fadiga emergente";
    reasons.push(`${fatiguedCreatives} criativo com sinal de fadiga`);
  }

  // Resumo numerico sempre adicionado
  const numericDetail = [
    `${dailySales.toFixed(1)} vendas/d`,
    cpa > 0 ? `CPA R$ ${cpa.toFixed(0)}` : null,
    paceStatus !== "unknown" ? `pacing ${(paceRatio * 100).toFixed(0)}%` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const detail = reasons.length > 0 ? `${reasons.join(" · ")} · ${numericDetail}` : numericDetail;

  return {
    tone,
    message,
    detail,
    signals: {
      profit,
      cpa,
      sales,
      paceRatio,
      paceStatus,
      fatiguedCreatives,
      mismatches: mismatchCount,
      supervisedMode,
    },
  };
}
