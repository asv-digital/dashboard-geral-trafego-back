// Auto-executor product-aware.
//
// Regras aplicadas por produto:
// R0 — gate: ad account ativa (meta-account)
// R1 — teto de budget diário do produto: se gasto do dia >= target, pausa tudo
// R2 — respeitar learning phase (72h)
// R3 — ASC: regras aplicadas na campanha, não no adset
// R4 — auto-pause sem venda: spend > autoPauseSpendLimit AND sales == 0
// R5 — auto-pause breakeven: CPA > breakevenCPA por breakevenMinDays dias
//      (pula se CPM spike de mercado)
// R6 — auto-scale: CPA < autoScaleCPAThreshold por autoScaleMinDays dias
// R7 — rotação de criativo (aberta no creative-stock)
//
// Tudo respeita automation-coordinator locks + registra ActionLog + notifica.

import prisma from "../prisma";
import { canAutomate, acquireLock } from "./automation-coordinator";
import { logAction } from "./action-log";
import { sendNotification } from "./whatsapp-notifier";
import { getAccountStatus } from "../lib/meta-account";
import { shouldSendStateAlert, resetStateAlert } from "../lib/alert-dedup";
import {
  pauseAdset,
  pauseCampaign,
  updateCampaignBudget,
  updateAdsetBudget,
  getActiveAdsetsForCampaigns,
} from "../lib/meta-mutations";
import { metricMatchesAdset } from "../lib/metric-entry";
import { classifyCampaign } from "./budget-guard";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";
import { addBRTDays, dateStringBRT, startOfBRTDay } from "../lib/tz";
import { getQualityFloors } from "../lib/product-economics";

type ProductStage = "launch" | "evergreen" | "escalavel" | "nicho";

interface AdsetDaily {
  date: Date;
  spend: number;
  sales: number;
  cpa: number;
  revenue: number;
  frequency: number;
  hookRate: number | null;
  outboundCtr: number | null;
}

interface AdsetSnapshot {
  adsetId: string;
  adsetName: string;
  metaCampaignId: string;
  campaignName: string;
  dbCampaignId: string;
  dailyBudget: number;
  isInLearningPhase: boolean;
  // Adset cuja campanha saiu do learning ha menos de POST_LEARNING_GRACE_MS.
  // Nessa janela R4-R7 nao aplicam: dados pos-learning sao curtos e pode
  // pausar/escalar com 1 ponto ruim. Deixa estabilizar.
  inPostLearningGrace: boolean;
  isASC: boolean;
  totalSpend: number;
  totalSales: number;
  daily: AdsetDaily[];
}

const POST_LEARNING_GRACE_MS = 48 * 60 * 60 * 1000;

type ExecutionConfig = {
  autoPauseNoSales: boolean;
  autoPauseSpendLimit: number;
  autoScaleWinners: boolean;
  autoScaleMinDays: number;
  autoScaleCPAThreshold: number;
  autoScaleMaxBudget: number;
  autoScalePercent: number;
  notifyOnAutoAction: boolean;
  frequencyLimitProspection: number;
  frequencyLimitRemarketing: number;
};

type AggregatedAdsetDaily = AdsetDaily & {
  hookRateSum: number;
  hookRateSamples: number;
  outboundCtrSum: number;
  outboundCtrSamples: number;
};

function averageMetric(values: Array<number | null | undefined>): number | null {
  const valid = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function getFrequencyLimit(
  campaignName: string,
  cfg: { frequencyLimitProspection: number; frequencyLimitRemarketing: number }
): number {
  return classifyCampaign(campaignName) === "remarketing"
    ? cfg.frequencyLimitRemarketing
    : cfg.frequencyLimitProspection;
}

function evaluateScaleQuality(
  campaignName: string,
  dailyWindow: AdsetDaily[],
  cfg: { frequencyLimitProspection: number; frequencyLimitRemarketing: number },
  stage: ProductStage
): {
  allowed: boolean;
  avgFrequency: number;
  avgHookRate: number | null;
  avgOutboundCtr: number | null;
  blockers: string[];
} {
  const frequencyLimit = getFrequencyLimit(campaignName, cfg);
  const avgFrequency =
    dailyWindow.length > 0
      ? dailyWindow.reduce((sum, day) => sum + day.frequency, 0) / dailyWindow.length
      : 0;
  const avgHookRate = averageMetric(dailyWindow.map(day => day.hookRate));
  const avgOutboundCtr = averageMetric(dailyWindow.map(day => day.outboundCtr));
  const blockers: string[] = [];

  if (avgFrequency > frequencyLimit * 0.85) {
    blockers.push(
      `freq média ${avgFrequency.toFixed(2)} perto do limite ${frequencyLimit.toFixed(2)}`
    );
  }

  const campaignType = classifyCampaign(campaignName);
  const floors = getQualityFloors(stage, campaignType);
  if (avgHookRate !== null && avgHookRate < floors.hookRate) {
    blockers.push(
      `hook rate médio ${avgHookRate.toFixed(2)} abaixo de ${floors.hookRate.toFixed(2)}`
    );
  }
  if (avgOutboundCtr !== null && avgOutboundCtr < floors.outboundCtr) {
    blockers.push(
      `outbound CTR médio ${avgOutboundCtr.toFixed(2)} abaixo de ${floors.outboundCtr.toFixed(2)}`
    );
  }

  return {
    allowed: blockers.length === 0,
    avgFrequency,
    avgHookRate,
    avgOutboundCtr,
    blockers,
  };
}

/** Busca adsets ativos do produto + métricas agregadas dos últimos 7d. */
async function getAdsetSnapshot(productId: string): Promise<AdsetSnapshot[]> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return [];

  const { adAccountId: accountId } = await getResolvedProductMetaSettings(product);
  if (!accountId) return [];

  const dbCampaigns = await prisma.campaign.findMany({
    where: { productId, metaCampaignId: { not: null } },
  });
  if (dbCampaigns.length === 0) return [];

  const trackedIds = dbCampaigns
    .map(c => c.metaCampaignId)
    .filter((id): id is string => id !== null);
  const dbByMetaId = new Map(dbCampaigns.map(c => [c.metaCampaignId!, c]));

  const adsets = await getActiveAdsetsForCampaigns(accountId, trackedIds);
  if (adsets.length === 0) return [];

  // Puxa métricas por adset+dia dos últimos 7d do banco (MetricEntry já tem sales via Kirvano)
  const sevenDaysAgo = addBRTDays(startOfBRTDay(), -6);

  const metrics = await prisma.metricEntry.findMany({
    where: { productId, date: { gte: sevenDaysAgo } },
  });

  // Agrupa por (campaignId DB, adSet)
  const metricsByCampaign = new Map<string, typeof metrics>();
  for (const m of metrics) {
    const k = m.campaignId;
    const arr = metricsByCampaign.get(k) ?? [];
    arr.push(m);
    metricsByCampaign.set(k, arr);
  }

  const snapshots: AdsetSnapshot[] = [];
  for (const a of adsets) {
    if (a.status !== "ACTIVE") continue;
    const dbCamp = dbByMetaId.get(a.campaignId);
    if (!dbCamp) continue;

    const adsetMetrics = (metricsByCampaign.get(dbCamp.id) ?? []).filter(m =>
      metricMatchesAdset(m, a)
    );

    // Agrega por dia
    const byDate = new Map<string, AggregatedAdsetDaily & { freqWeightedSum: number; freqWeightTotal: number }>();
    for (const m of adsetMetrics) {
      const key = dateStringBRT(m.date);
      const existing = byDate.get(key) ?? {
        date: m.date,
        spend: 0,
        sales: 0,
        cpa: 0,
        revenue: 0,
        frequency: 0,
        hookRate: null,
        outboundCtr: null,
        hookRateSum: 0,
        hookRateSamples: 0,
        outboundCtrSum: 0,
        outboundCtrSamples: 0,
        freqWeightedSum: 0,
        freqWeightTotal: 0,
      };
      existing.spend += m.investment;
      // C8: auto-executor decide com salesKirvano (autoritativo via webhook),
      // nunca com Pixel-attributed. Pause/scale em base de Pixel pode tomar
      // decisao com venda atribuida errado (UTM falha, dedup duplicado).
      // m.sales fica disponivel via prisma direto pra dashboard/display.
      existing.sales += m.salesKirvano;
      existing.revenue += m.salesKirvano * product.netPerSale;
      const mFreq = m.frequency || 0;
      if (mFreq > 0 && m.impressions > 0) {
        existing.freqWeightedSum += mFreq * m.impressions;
        existing.freqWeightTotal += m.impressions;
      }
      if (typeof m.hookRate === "number") {
        existing.hookRateSum += m.hookRate;
        existing.hookRateSamples += 1;
      }
      if (typeof m.outboundCtr === "number") {
        existing.outboundCtrSum += m.outboundCtr;
        existing.outboundCtrSamples += 1;
      }
      existing.cpa = existing.sales > 0 ? existing.spend / existing.sales : 0;
      byDate.set(key, existing);
    }
    const daily = Array.from(byDate.values())
      .map(day => ({
        date: day.date,
        spend: day.spend,
        sales: day.sales,
        cpa: day.cpa,
        revenue: day.revenue,
        frequency: day.freqWeightTotal > 0 ? day.freqWeightedSum / day.freqWeightTotal : 0,
        hookRate:
          day.hookRateSamples > 0 ? day.hookRateSum / day.hookRateSamples : null,
        outboundCtr:
          day.outboundCtrSamples > 0
            ? day.outboundCtrSum / day.outboundCtrSamples
            : null,
      }))
      .sort((x, y) => x.date.getTime() - y.date.getTime());

    const totalSpend = daily.reduce((s, d) => s + d.spend, 0);
    const totalSales = daily.reduce((s, d) => s + d.sales, 0);

    const inPostLearningGrace =
      !dbCamp.isInLearningPhase &&
      !!dbCamp.learningPhaseEnd &&
      Date.now() - dbCamp.learningPhaseEnd.getTime() < POST_LEARNING_GRACE_MS;

    snapshots.push({
      adsetId: a.id,
      adsetName: a.name,
      metaCampaignId: a.campaignId,
      campaignName: dbCamp.name,
      dbCampaignId: dbCamp.id,
      dailyBudget: a.dailyBudget,
      isInLearningPhase: dbCamp.isInLearningPhase,
      inPostLearningGrace,
      isASC:
        dbCamp.name.toUpperCase().includes("ASC") ||
        dbCamp.name.toUpperCase().includes("ADVANTAGE"),
      totalSpend,
      totalSales,
      daily,
    });
  }

  return snapshots;
}

async function isCPMSpike(
  productId: string
): Promise<{ isSpike: boolean; message: string }> {
  const todayDate = startOfBRTDay();

  const trend = await prisma.cPMTrend.findUnique({
    where: { productId_date: { productId, date: todayDate } },
  });
  if (!trend) return { isSpike: false, message: "sem dados de hoje" };

  const thirtyDaysAgo = addBRTDays(todayDate, -30);

  const last30 = await prisma.cPMTrend.findMany({
    where: { productId, date: { gte: thirtyDaysAgo, lt: todayDate } },
  });
  if (last30.length < 7) return { isSpike: false, message: "<7d histórico" };

  const avg30dCPM = last30.reduce((s, d) => s + d.avgCPM, 0) / last30.length;
  const avg30dCTR = last30.reduce((s, d) => s + d.avgCTR, 0) / last30.length;

  const cpmVar = ((trend.avgCPM - avg30dCPM) / avg30dCPM) * 100;
  const ctrVar = avg30dCTR > 0 ? Math.abs((trend.avgCTR - avg30dCTR) / avg30dCTR) * 100 : 0;

  const isSpike = cpmVar > 20 && ctrVar < 10;
  return {
    isSpike,
    message: isSpike
      ? `CPM +${Math.round(cpmVar)}% vs 30d, CTR estável — mercado, não criativo`
      : `CPM ${cpmVar > 0 ? "+" : ""}${Math.round(cpmVar)}% vs 30d`,
  };
}

/** Roda todas as automações pra UM produto. */
export async function executeAutomationsForProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product || !product.automationConfig) return;
  if (product.supervisedMode) {
    console.log(`[auto:${product.slug}] supervisedMode ON, pulando execuções`);
    return;
  }

  // R0 — gate de ad account
  const account = await getAccountStatus();
  if (!account.active) {
    console.log(`[auto:${product.slug}] skip — account ${account.status_key}`);
    const alertKey = `agent_skipped`;
    const shouldAlert = await shouldSendStateAlert(productId, alertKey, account.status_key);
    if (shouldAlert) {
      await sendNotification(
        "alert_critical",
        {
          type: "AGENTE SKIPADO",
          detail: `Ad account ${account.status_key}: ${account.message}`,
          action: "Resolver no Meta Business Settings",
        },
        productId
      );
    }
    return;
  }
  await resetStateAlert(productId, `agent_skipped`);

  const cfg = product.automationConfig;
  const snapshots = await getAdsetSnapshot(productId);
  if (snapshots.length === 0) {
    console.log(`[auto:${product.slug}] nenhum adset ativo`);
    return;
  }

  // R1 — teto diário do produto
  const todayStart = startOfBRTDay();
  const todayAgg = await prisma.metricEntry.aggregate({
    where: { productId, date: { gte: todayStart } },
    _sum: { investment: true },
  });
  const todaySpend = todayAgg._sum.investment || 0;
  if (todaySpend >= product.dailyBudgetTarget) {
    console.log(
      `[auto:${product.slug}] teto diário atingido: R$${todaySpend.toFixed(0)} >= R$${product.dailyBudgetTarget}`
    );
    let paused = 0;
    for (const s of snapshots) {
      if (await pauseAdset(s.adsetId)) paused++;
    }
    await logAction({
      productId,
      action: "emergency_budget_pause",
      entityType: "product",
      entityId: productId,
      entityName: product.name,
      details: `Gasto R$${todaySpend.toFixed(0)} >= teto R$${product.dailyBudgetTarget}. ${paused} adsets pausados.`,
    });
    await sendNotification(
      "alert_critical",
      {
        type: "TETO DIÁRIO ATINGIDO",
        detail: `${product.name}: R$${todaySpend.toFixed(0)} / R$${product.dailyBudgetTarget}`,
        action: `${paused} adsets pausados`,
      },
      productId
    );
    return;
  }

  console.log(`[auto:${product.slug}] avaliando ${snapshots.length} adsets`);

  for (const s of snapshots) {
    // R2 — learning phase
    if (cfg.respectLearningPhase && s.isInLearningPhase) {
      console.log(`[auto:${product.slug}] ${s.adsetName} — em learning phase`);
      continue;
    }

    // R3 — ASC: campanha-level
    if (s.isASC) {
      await handleAsc(productId, s, cfg, product.stage as ProductStage);
      continue;
    }

    // R3.5 — post-learning grace 48h. Adset cuja campanha acabou de sair do
    // learning nao recebe pause/scale automatico por 48h. Antes do gap o
    // R4 (no-sales) e o R5/R6 podiam disparar com 1 ponto ruim em janela
    // curta de dados pos-learning, queimando adset que ainda nao estabilizou.
    if (s.inPostLearningGrace) {
      console.log(`[auto:${product.slug}] ${s.adsetName} — post-learning grace 48h`);
      continue;
    }

    // R4 — auto-pause sem venda. Cobre 2 cenarios:
    //  (a) lifetime never sold: totalSales==0 e gasto > limit (loser desde o lancamento)
    //  (b) streak seco: vendeu antes mas zerou — N dias consecutivos sem venda
    //      com gasto acumulado > limit (loser que vendeu 1× e morreu)
    // O cenario (b) era o gap antes: o totalSales 7d agregado mascara dias
    // recentes secos quando ha 1 venda antiga na janela.
    if (cfg.autoPauseNoSales && s.totalSpend > cfg.autoPauseSpendLimit) {
      // Contagem do streak seco do mais recente pra tras.
      let drySpend = 0;
      let dryDays = 0;
      for (let i = s.daily.length - 1; i >= 0; i--) {
        const d = s.daily[i];
        if (d.sales > 0) break;
        if (d.spend > 0) {
          drySpend += d.spend;
          dryDays += 1;
        }
      }
      const neverSold = s.totalSales === 0;
      // Streak: pelo menos 2 dias de gasto sem venda E gasto acumulado > limit.
      const streakDry = drySpend > cfg.autoPauseSpendLimit && dryDays >= 2;
      const shouldPause = neverSold || streakDry;

      if (shouldPause) {
        const pendingSales = await prisma.sale.count({
          where: {
            productId,
            status: { startsWith: "pending" },
            OR: [{ metaAdsetId: s.adsetId }, { metaCampaignId: s.metaCampaignId }],
            createdAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
          },
        });
        if (pendingSales > 0) {
          const oldest = await prisma.sale.findFirst({
            where: {
              productId,
              status: { startsWith: "pending" },
              OR: [{ metaAdsetId: s.adsetId }, { metaCampaignId: s.metaCampaignId }],
            },
            orderBy: { createdAt: "asc" },
          });
          const hoursWaiting = oldest
            ? (Date.now() - oldest.createdAt.getTime()) / (1000 * 60 * 60)
            : 0;
          if (hoursWaiting < 48) {
            await logAction({
              productId,
              action: "pause_delayed_pending_sales",
              entityType: "adset",
              entityId: s.adsetId,
              entityName: s.adsetName,
              details: `R$${s.totalSpend.toFixed(0)} sem vendas confirmadas, ${pendingSales} boletos pendentes <48h`,
            });
            continue;
          }
        }

        const lock = await canAutomate(productId, "adset", s.adsetId, "auto_executor");
        if (!lock.allowed) continue;

        const cause = neverSold ? "lifetime_no_sales" : "dry_streak";
        const detailLine = neverSold
          ? `R$${s.totalSpend.toFixed(0)} gastos, 0 vendas. Limite: R$${cfg.autoPauseSpendLimit}`
          : `Streak ${dryDays}d sem venda, R$${drySpend.toFixed(0)} gastos no streak. Limite: R$${cfg.autoPauseSpendLimit}`;
        const reasoningLine = neverSold
          ? `Adset gastou R$${s.totalSpend.toFixed(0)} (acima do limite R$${cfg.autoPauseSpendLimit}) sem nenhuma venda aprovada na janela. Regra R4-A (lifetime_no_sales) disparou. Fora da learning phase, nao e ASC, sem boletos pendentes <48h.`
          : `Adset vendeu antes mas esta em streak de ${dryDays} dias consecutivos sem venda, com R$${drySpend.toFixed(0)} gastos nesse streak (acima do limite R$${cfg.autoPauseSpendLimit}). Regra R4-B (dry_streak) disparou: 1 venda antiga na janela mascarava o problema, agora o agente pausa por degradacao recente.`;

        if (await pauseAdset(s.adsetId)) {
          await acquireLock(
            productId,
            "adset",
            s.adsetId,
            "auto_executor",
            "pause",
            String(s.dailyBudget),
            "0"
          );
          await logAction({
            productId,
            action: "auto_pause_no_sales",
            entityType: "adset",
            entityId: s.adsetId,
            entityName: s.adsetName,
            details: detailLine,
            reasoning: reasoningLine,
            inputSnapshot: {
              cause,
              totalSpend: s.totalSpend,
              totalSales: s.totalSales,
              drySpend,
              dryDays,
              spendLimit: cfg.autoPauseSpendLimit,
              dailyBudget: s.dailyBudget,
              days: s.daily.length,
            },
          });
          if (cfg.notifyOnAutoAction) {
            await sendNotification(
              "auto_action",
              {
                action: `PAUSADO (${product.slug})`,
                adset: s.adsetName,
                reason: neverSold
                  ? `R$${s.totalSpend.toFixed(0)} sem venda`
                  : `${dryDays}d sem venda, R$${drySpend.toFixed(0)} no streak`,
              },
              productId
            );
          }
        }
        continue;
      }
    }

    // R5 — auto-pause por frequência saturada
    if (cfg.autoPauseFrequency) {
      const frequencyWindow = s.daily.filter(d => d.spend > 0).slice(-2);
      const campaignType = classifyCampaign(s.campaignName);
      const frequencyLimit = getFrequencyLimit(s.campaignName, cfg);
      const allAboveLimit =
        frequencyWindow.length > 0 &&
        frequencyWindow.every(day => day.frequency > frequencyLimit);
      const noRecentSales = frequencyWindow.length > 0 && frequencyWindow.every(day => day.sales === 0);
      const avgRecentCpa =
        frequencyWindow.length > 0
          ? frequencyWindow.reduce((sum, day) => sum + day.cpa, 0) / frequencyWindow.length
          : 0;

      if (
        allAboveLimit &&
        (noRecentSales || avgRecentCpa > cfg.breakevenCPA)
      ) {
        const lock = await canAutomate(productId, "adset", s.adsetId, "auto_executor");
        if (!lock.allowed) continue;

        if (await pauseAdset(s.adsetId)) {
          await acquireLock(
            productId,
            "adset",
            s.adsetId,
            "auto_executor",
            "pause_frequency",
            String(s.dailyBudget),
            "0"
          );
          await logAction({
            productId,
            action: "auto_pause_frequency",
            entityType: "adset",
            entityId: s.adsetId,
            entityName: s.adsetName,
            details: `Freq ${frequencyWindow
              .map(day => day.frequency.toFixed(2))
              .join(" / ")} > limite ${frequencyLimit.toFixed(2)}`,
            reasoning: `Adset saturou frequência acima do limite ${frequencyLimit.toFixed(
              2
            )} para ${campaignType}. A janela recente trouxe ${
              noRecentSales
                ? "0 vendas"
                : `CPA médio R$${avgRecentCpa.toFixed(2)} acima do breakeven`
            }, então o agente pausou por exaustão de entrega.`,
            inputSnapshot: {
              campaignType,
              frequencyLimit,
              recent: frequencyWindow.map(day => ({
                frequency: day.frequency,
                spend: day.spend,
                sales: day.sales,
                cpa: day.cpa,
              })),
            },
          });
          if (cfg.notifyOnAutoAction) {
            await sendNotification(
              "auto_action",
              {
                action: `PAUSADO POR FREQ (${product.slug})`,
                adset: s.adsetName,
                reason: `freq > ${frequencyLimit.toFixed(2)}`,
              },
              productId
            );
          }
        }
        continue;
      }
    }

    // R6 — auto-pause breakeven
    if (cfg.autoPauseBreakeven) {
      const lastN = s.daily.slice(-cfg.breakevenMinDays);
      const allAboveBreakeven =
        lastN.length >= cfg.breakevenMinDays &&
        lastN.every(d => d.sales > 0 && d.cpa > cfg.breakevenCPA);
      if (allAboveBreakeven) {
        const cpm = await isCPMSpike(productId);
        if (cpm.isSpike) {
          await logAction({
            productId,
            action: "breakeven_skip_cpm_spike",
            entityType: "adset",
            entityId: s.adsetId,
            entityName: s.adsetName,
            details: cpm.message,
          });
          continue;
        }
        const lock = await canAutomate(productId, "adset", s.adsetId, "auto_executor");
        if (!lock.allowed) continue;

        const avgCPA = lastN.reduce((sum, d) => sum + d.cpa, 0) / lastN.length;
        const loss = lastN.reduce((sum, d) => sum + (d.spend - d.revenue), 0);

        if (await pauseAdset(s.adsetId)) {
          await acquireLock(
            productId,
            "adset",
            s.adsetId,
            "auto_executor",
            "pause",
            String(s.dailyBudget),
            "0"
          );
          await logAction({
            productId,
            action: "auto_pause_breakeven",
            entityType: "adset",
            entityId: s.adsetId,
            entityName: s.adsetName,
            details: `CPA médio R$${avgCPA.toFixed(0)} > breakeven R$${cfg.breakevenCPA.toFixed(2)} por ${cfg.breakevenMinDays}d. Prejuízo: R$${Math.max(0, loss).toFixed(0)}`,
            reasoning: `Nos últimos ${cfg.breakevenMinDays} dias, CPA ficou em R$${avgCPA.toFixed(2)}, acima do breakeven R$${cfg.breakevenCPA.toFixed(2)}. Prejuízo estimado R$${Math.max(0, loss).toFixed(2)}. CPM não está em spike de mercado (verificado via CPMTrend 30d), então o problema é o adset e não o leilão. Regra R5 (auto_pause_breakeven) disparou.`,
            inputSnapshot: {
              avgCPA,
              breakevenCPA: cfg.breakevenCPA,
              loss,
              minDays: cfg.breakevenMinDays,
              daily: lastN.map(d => ({ spend: d.spend, sales: d.sales, cpa: d.cpa })),
            },
          });
          if (cfg.notifyOnAutoAction) {
            await sendNotification(
              "auto_pause_breakeven",
              {
                adset: s.adsetName,
                avg_cpa: avgCPA.toFixed(0),
                breakeven: cfg.breakevenCPA.toFixed(2),
                days: cfg.breakevenMinDays,
                loss: Math.max(0, loss).toFixed(0),
              },
              productId
            );
          }
        }
        continue;
      }
    }

    // R7 — auto-scale winners
    if (cfg.autoScaleWinners) {
      const lastN = s.daily.slice(-cfg.autoScaleMinDays);
      const allBelowThreshold =
        lastN.length >= cfg.autoScaleMinDays &&
        lastN.every(d => d.sales > 0 && d.cpa > 0 && d.cpa < cfg.autoScaleCPAThreshold);
      const qualityGate = evaluateScaleQuality(s.campaignName, lastN, cfg, product.stage as ProductStage);
      if (allBelowThreshold && qualityGate.allowed && s.dailyBudget < cfg.autoScaleMaxBudget) {
        // Cooldown 72h: regra de mercado "+20% no máximo a cada 3 dias".
        // O AutomationLock do auto_executor expira em 4h (rotina de pause/scale geral),
        // mas escalar adset 2× em 72h reseta a learning phase no Meta. Por isso
        // checamos o ActionLog: se houve auto_scale do mesmo adset há menos de 72h, pula.
        const SCALE_COOLDOWN_MS = 72 * 60 * 60 * 1000;
        const lastScale = await prisma.actionLog.findFirst({
          where: {
            productId,
            action: "auto_scale",
            entityType: "adset",
            entityId: s.adsetId,
            executedAt: { gt: new Date(Date.now() - SCALE_COOLDOWN_MS) },
          },
          orderBy: { executedAt: "desc" },
        });
        if (lastScale) {
          const hoursSince = (Date.now() - lastScale.executedAt.getTime()) / 3_600_000;
          await logAction({
            productId,
            action: "auto_scale_skipped_cooldown",
            entityType: "adset",
            entityId: s.adsetId,
            entityName: s.adsetName,
            details: `Cooldown 72h ativo: último scale há ${hoursSince.toFixed(1)}h`,
            reasoning: `Adset preenche os critérios pra escalar (CPA < R$${cfg.autoScaleCPAThreshold} por ${cfg.autoScaleMinDays}d, qualidade ok), mas houve auto_scale há ${hoursSince.toFixed(1)}h. Escalar de novo dentro de 72h reseta a learning phase do Meta. Aguardando completar 72h pro próximo scale.`,
            inputSnapshot: {
              lastScaleAt: lastScale.executedAt,
              hoursSinceLastScale: hoursSince,
              cooldownHours: 72,
            },
          });
          continue;
        }

        const lock = await canAutomate(productId, "adset", s.adsetId, "auto_executor");
        if (!lock.allowed) continue;

        const desired = Math.min(
          Math.round(s.dailyBudget * (1 + cfg.autoScalePercent / 100)),
          cfg.autoScaleMaxBudget
        );
        if (await updateAdsetBudget(s.adsetId, desired)) {
          await acquireLock(
            productId,
            "adset",
            s.adsetId,
            "auto_executor",
            "scale",
            String(s.dailyBudget),
            String(desired)
          );
          await logAction({
            productId,
            action: "auto_scale",
            entityType: "adset",
            entityId: s.adsetId,
            entityName: s.adsetName,
            details: `CPA < R$${cfg.autoScaleCPAThreshold} por ${cfg.autoScaleMinDays}d. Budget R$${s.dailyBudget} → R$${desired}`,
            reasoning: `Adset bateu CPA < R$${cfg.autoScaleCPAThreshold} em ${cfg.autoScaleMinDays} dias seguidos com vendas reais. A qualidade recente sustentou o scale: frequência média ${qualityGate.avgFrequency.toFixed(2)}${qualityGate.avgHookRate !== null ? `, hook rate médio ${qualityGate.avgHookRate.toFixed(2)}` : ""}${qualityGate.avgOutboundCtr !== null ? `, outbound CTR médio ${qualityGate.avgOutboundCtr.toFixed(2)}` : ""}. Budget aumenta ${cfg.autoScalePercent}% (de R$${s.dailyBudget} pra R$${desired}), respeitando teto de R$${cfg.autoScaleMaxBudget}.`,
            inputSnapshot: {
              currentBudget: s.dailyBudget,
              newBudget: desired,
              scaleThreshold: cfg.autoScaleCPAThreshold,
              minDays: cfg.autoScaleMinDays,
              maxBudget: cfg.autoScaleMaxBudget,
              qualityGate,
              daily: lastN.map(d => ({ spend: d.spend, sales: d.sales, cpa: d.cpa })),
            },
          });
          if (cfg.notifyOnAutoAction) {
            await sendNotification(
              "auto_action",
              {
                action: `ESCALADO (${product.slug})`,
                adset: s.adsetName,
                reason: `budget R$${s.dailyBudget} → R$${desired}`,
              },
              productId
            );
          }
        }
      }
    }
  }
}

async function handleAsc(
  productId: string,
  s: AdsetSnapshot,
  cfg: ExecutionConfig,
  stage: ProductStage
): Promise<void> {
  if (
    cfg.autoPauseNoSales &&
    s.totalSpend > cfg.autoPauseSpendLimit &&
    s.totalSales === 0
  ) {
    const lock = await canAutomate(productId, "campaign", s.metaCampaignId, "auto_executor");
    if (!lock.allowed) return;
    if (await pauseCampaign(s.metaCampaignId)) {
      await acquireLock(
        productId,
        "campaign",
        s.metaCampaignId,
        "auto_executor",
        "pause",
        String(s.dailyBudget),
        "0"
      );
      await logAction({
        productId,
        action: "auto_pause_asc",
        entityType: "campaign",
        entityId: s.metaCampaignId,
        entityName: s.campaignName,
        details: `ASC: R$${s.totalSpend.toFixed(0)} gastos, 0 vendas`,
      });
      if (cfg.notifyOnAutoAction) {
        await sendNotification(
          "auto_action",
          {
            action: "PAUSADO (ASC)",
            adset: s.campaignName,
            reason: `R$${s.totalSpend.toFixed(0)} sem venda`,
          },
          productId
        );
      }
    }
    return;
  }

  if (cfg.autoScaleWinners) {
    const lastN = s.daily.slice(-cfg.autoScaleMinDays);
    const allBelow =
      lastN.length >= cfg.autoScaleMinDays &&
      lastN.every(d => d.sales > 0 && d.cpa > 0 && d.cpa < cfg.autoScaleCPAThreshold);
    const qualityGate = evaluateScaleQuality(s.campaignName, lastN, cfg, stage);
    if (allBelow && qualityGate.allowed && s.dailyBudget < cfg.autoScaleMaxBudget) {
      const lock = await canAutomate(productId, "campaign", s.metaCampaignId, "auto_executor");
      if (!lock.allowed) return;
      const desired = Math.min(
        Math.round(s.dailyBudget * (1 + cfg.autoScalePercent / 100)),
        cfg.autoScaleMaxBudget
      );
      if (await updateCampaignBudget(s.metaCampaignId, desired)) {
        await acquireLock(
          productId,
          "campaign",
          s.metaCampaignId,
          "auto_executor",
          "scale",
          String(s.dailyBudget),
          String(desired)
        );
        await logAction({
          productId,
          action: "auto_scale_asc",
          entityType: "campaign",
          entityId: s.metaCampaignId,
          entityName: s.campaignName,
          details: `ASC budget R$${s.dailyBudget} → R$${desired}`,
          reasoning: `ASC escalou com qualidade recente preservada: frequência média ${qualityGate.avgFrequency.toFixed(2)}${qualityGate.avgHookRate !== null ? `, hook rate médio ${qualityGate.avgHookRate.toFixed(2)}` : ""}${qualityGate.avgOutboundCtr !== null ? `, outbound CTR médio ${qualityGate.avgOutboundCtr.toFixed(2)}` : ""}.`,
          inputSnapshot: {
            currentBudget: s.dailyBudget,
            newBudget: desired,
            qualityGate,
            daily: lastN.map(d => ({ spend: d.spend, sales: d.sales, cpa: d.cpa })),
          },
        });
      }
    }
  }
}

/** Roda auto-executor pra todos os produtos ativos. */
export async function executeAllAutomations(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await executeAutomationsForProduct(p.id);
    } catch (err) {
      console.error(
        `[auto] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
