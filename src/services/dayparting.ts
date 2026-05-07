// Dayparting por produto. Reduz budget em horários mortos (1-8 BRT por
// padrão) e restaura em horário de pico. Só ativa se:
//   - product.automationConfig.daypartingEnabled
//   - budget target >= 300
// Usa curva de conversão dos últimos 14 dias pra escolher off-peak real.

import prisma from "../prisma";
import { addBRTDays, currentHourBRT, hourBRTFromDate, startOfBRTDay } from "../lib/tz";
import { canAutomate, acquireLock } from "./automation-coordinator";
import { logAction } from "./action-log";
import { getActiveAdsetsForCampaigns, updateAdsetBudget } from "../lib/meta-mutations";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";

const OFF_PEAK_REDUCTION = 0.5; // reduz pra 50%

// Horas commercial peak no Brasil (11-22 BRT). Volume baixo nessas faixas
// nao prova "hora morta de conversao" — pode ser hora morta de tráfego (gasto
// baixo do adset naquela hora). Sem dados granulares de spend/clicks por hora
// (MetricEntry e diario, nao horario), a regra mais segura e nunca cortar essas
// horas. Protege peak commercial.
//
// Limitação conhecida: ideal seria CR (sales/clicks) ou CPA (spend/sales) por
// hora, mas os dados horarios nao existem hoje. Quando houver coleta horaria,
// trocar este heuristico por CR/CPA-based.
const PROTECTED_PEAK_HOURS = new Set<number>([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);

// Madrugada profunda: comprador BR raramente compra. Sempre off-peak.
const DEFAULT_DEEP_NIGHT = new Set<number>([3, 4, 5]);

// Volume minimo de vendas pra confiar na distribuicao por hora. < 50 = ruido.
const MIN_SALES_FOR_DISTRIBUTION = 50;

// Off-peak so pode incluir horas que pertencem ao bottom da distribuicao
// e estejam abaixo de 60% da mediana — proxy mais conservador que "<50% da media".
// Maximo 6 horas off-peak (nunca cortar mais que 25% do dia).
const MAX_OFF_PEAK_HOURS = 6;

async function getOffPeakHours(productId: string): Promise<Set<number>> {
  // Pega vendas por hora dos últimos 14d
  const fourteenDaysAgo = addBRTDays(startOfBRTDay(), -13);

  const sales = await prisma.sale.findMany({
    where: {
      productId,
      status: "approved",
      date: { gte: fourteenDaysAgo },
    },
    select: { date: true },
  });

  if (sales.length < MIN_SALES_FOR_DISTRIBUTION) {
    // Sem volume confiavel: corta apenas madrugada profunda (3-5 BRT).
    // Antes era 1-7, mas 1, 2, 6, 7 podem ter conversao real em alguns produtos.
    return new Set(DEFAULT_DEEP_NIGHT);
  }

  const byHour = new Map<number, number>();
  for (let h = 0; h < 24; h++) byHour.set(h, 0);
  for (const s of sales) {
    const h = hourBRTFromDate(s.date);
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }

  // Mediana > media: distribuicao de vendas por hora e long-tail (poucas horas
  // concentram muita venda), media puxa cutoff pra cima e marca peak como off.
  const counts = Array.from(byHour.values()).sort((a, b) => a - b);
  const median = counts[Math.floor(counts.length / 2)];
  const ceiling = median * 0.6;

  // Candidatas: nao protegidas, ordenadas crescente por contagem.
  const candidates = Array.from(byHour.entries())
    .filter(([h]) => !PROTECTED_PEAK_HOURS.has(h))
    .sort((a, b) => a[1] - b[1]);

  const offPeak = new Set<number>(DEFAULT_DEEP_NIGHT);
  for (const [h, count] of candidates) {
    if (offPeak.size >= MAX_OFF_PEAK_HOURS) break;
    if (count < ceiling) offPeak.add(h);
  }

  return offPeak;
}

export async function applyDaypartingForProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product || !product.automationConfig?.daypartingEnabled) return;
  if (product.supervisedMode) return;

  const { adAccountId: accountId } = await getResolvedProductMetaSettings(product);
  if (!accountId) return;

  const dbCampaigns = await prisma.campaign.findMany({
    where: { productId, metaCampaignId: { not: null } },
  });
  const trackedIds = dbCampaigns
    .map(c => c.metaCampaignId)
    .filter((id): id is string => id !== null);
  if (trackedIds.length === 0) return;

  const dbByMeta = new Map(dbCampaigns.map(c => [c.metaCampaignId!, c]));
  const adsets = await getActiveAdsetsForCampaigns(accountId, trackedIds);

  const offPeak = await getOffPeakHours(productId);
  const hourBRT = currentHourBRT();
  const isOffPeak = offPeak.has(hourBRT);

  console.log(
    `[dayparting:${product.slug}] hora ${hourBRT} BRT, offPeak=${isOffPeak}, ${adsets.length} adsets`
  );

  for (const a of adsets) {
    if (a.status !== "ACTIVE") continue;
    const dbCamp = dbByMeta.get(a.campaignId);
    if (!dbCamp) continue;

    // ASC não entra em dayparting
    if (
      dbCamp.name.toUpperCase().includes("ASC") ||
      dbCamp.name.toUpperCase().includes("ADVANTAGE")
    ) {
      continue;
    }
    if (product.automationConfig.respectLearningPhase && dbCamp.isInLearningPhase) {
      continue;
    }

    const lock = await canAutomate(productId, "adset", a.id, "dayparting");
    if (!lock.allowed) continue;

    // Lê lock anterior pra saber se esse adset já foi reduzido
    const existingLock = await prisma.automationLock.findUnique({
      where: {
        productId_entityType_entityId: {
          productId,
          entityType: "adset",
          entityId: a.id,
        },
      },
    });

    const wasReduced = existingLock?.lockedBy === "dayparting" && existingLock.action === "daypart_reduce";

    if (isOffPeak && !wasReduced) {
      // Reduzir
      const newBudget = Math.max(10, Math.round(a.dailyBudget * OFF_PEAK_REDUCTION));
      if (await updateAdsetBudget(a.id, newBudget)) {
        await acquireLock(
          productId,
          "adset",
          a.id,
          "dayparting",
          "daypart_reduce",
          String(a.dailyBudget),
          String(newBudget)
        );
        await logAction({
          productId,
          action: "dayparting_reduce",
          entityType: "adset",
          entityId: a.id,
          entityName: a.name,
          details: `Off-peak hora ${hourBRT}. Budget R$${a.dailyBudget} → R$${newBudget}`,
        });
      }
    } else if (!isOffPeak && wasReduced) {
      // Restaurar
      const previous = existingLock?.previousValue
        ? parseFloat(existingLock.previousValue)
        : NaN;
      if (!Number.isFinite(previous) || previous <= 0) {
        // Lock corrompido — limpar pra que no próximo ciclo off-peak o adset
        // seja tratado como "não reduzido" e o fluxo funcione normalmente.
        await prisma.automationLock.delete({
          where: {
            productId_entityType_entityId: {
              productId,
              entityType: "adset",
              entityId: a.id,
            },
          },
        }).catch(() => {});
        await logAction({
          productId,
          action: "dayparting_restore_skipped",
          entityType: "adset",
          entityId: a.id,
          entityName: a.name,
          details: "restore pulado: previousValue ausente/inválido. Lock limpo pra reciclar.",
        });
        continue;
      }
      if (await updateAdsetBudget(a.id, previous)) {
        await acquireLock(
          productId,
          "adset",
          a.id,
          "dayparting",
          "daypart_restore",
          String(a.dailyBudget),
          String(previous)
        );
        await logAction({
          productId,
          action: "dayparting_restore",
          entityType: "adset",
          entityId: a.id,
          entityName: a.name,
          details: `On-peak hora ${hourBRT}. Budget R$${a.dailyBudget} → R$${previous}`,
        });
      }
    }
  }
}

export async function applyDaypartingAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await applyDaypartingForProduct(p.id);
    } catch (err) {
      console.error(
        `[dayparting] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
