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

  if (sales.length < 20) {
    // Sem dados suficientes, usa default 1-7 BRT
    return new Set([1, 2, 3, 4, 5, 6, 7]);
  }

  const byHour = new Map<number, number>();
  for (const s of sales) {
    const h = hourBRTFromDate(s.date);
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }

  // Off-peak = horas com < 50% da média
  const avg = sales.length / 24;
  const offPeak = new Set<number>();
  for (let h = 0; h < 24; h++) {
    if ((byHour.get(h) || 0) < avg * 0.5) offPeak.add(h);
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
