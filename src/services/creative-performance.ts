import prisma from "../prisma";
import { getActionValue, getThreeSecondViews } from "../agent/meta-client";
import type { MetaInsight } from "../agent/types";
import { creativeMatchesAdName } from "../lib/creative-matching";
import { endOfBRTDay, parseBRTDateStart } from "../lib/tz";

interface CreativeRollup {
  creativeId: string;
  spend: number;
  impressions: number;
  clicks: number;
  threeSecondViews: number;
  thruplayViews: number;
  metaPurchases: number;
  adIds: Set<string>;
}

// Onda 2.3 — agregacao por (creativeId, date) pra historico diario.
// Alimenta CreativeDailyMetric usado pelo fatigue predictivo.
interface CreativeDayKey {
  creativeId: string;
  date: Date;
}

function dayKeyStr(k: CreativeDayKey): string {
  return `${k.creativeId}|${k.date.toISOString().slice(0, 10)}`;
}

interface DailyRollup {
  creativeId: string;
  date: Date;
  spend: number;
  impressions: number;
  clicks: number;
  threeSecondViews: number;
  thruplayViews: number;
}

export async function syncCreativePerformanceFromInsights(
  productId: string,
  insights: MetaInsight[]
): Promise<void> {
  if (insights.length === 0) return;

  const dbCampaigns = await prisma.campaign.findMany({
    where: { productId, metaCampaignId: { not: null } },
    select: { id: true, metaCampaignId: true },
  });
  if (dbCampaigns.length === 0) return;

  const campaignByMetaId = new Map(
    dbCampaigns.map(campaign => [campaign.metaCampaignId!, campaign.id])
  );
  const creatives = await prisma.creative.findMany({
    where: { productId, status: { not: "exhausted" } },
    select: { id: true, name: true, campaignId: true, metaAdId: true },
  });
  if (creatives.length === 0) return;

  const creativesByCampaign = new Map<string, typeof creatives>();
  // Index por metaAdId pra match O(1) — primario, antes de cair no fallback.
  const creativeByMetaAdId = new Map<string, (typeof creatives)[number]>();
  for (const creative of creatives) {
    if (creative.metaAdId) creativeByMetaAdId.set(creative.metaAdId, creative);
    if (!creative.campaignId) continue;
    const bucket = creativesByCampaign.get(creative.campaignId) ?? [];
    bucket.push(creative);
    creativesByCampaign.set(creative.campaignId, bucket);
  }

  const rollups = new Map<string, CreativeRollup>();
  const dailyRollups = new Map<string, DailyRollup>();
  const matchedAdIds = new Set<string>();
  // Map criativo -> metaAdId pra persistir no fim (evita N updates dentro do loop).
  const metaAdIdToPersist = new Map<string, string>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const row of insights) {
    const dbCampaignId = campaignByMetaId.get(row.campaign_id);
    if (!dbCampaignId) continue;

    // M4 — match: primeiro por metaAdId estavel; depois fallback por nome.
    // Quando o fallback bate, persistimos o metaAdId apos o loop.
    let matchedCreative: (typeof creatives)[number] | undefined;
    if (row.ad_id) {
      matchedCreative = creativeByMetaAdId.get(row.ad_id);
    }
    if (!matchedCreative) {
      const candidates = creativesByCampaign.get(dbCampaignId) ?? [];
      matchedCreative = candidates.find(creative =>
        creativeMatchesAdName(creative.name, row.ad_name || "")
      );
      if (matchedCreative && row.ad_id && !matchedCreative.metaAdId) {
        metaAdIdToPersist.set(matchedCreative.id, row.ad_id);
        // Atualiza index local pra proximas linhas no mesmo loop usarem match O(1).
        creativeByMetaAdId.set(row.ad_id, { ...matchedCreative, metaAdId: row.ad_id });
      }
    }
    if (!matchedCreative) continue;

    const rowDate = parseBRTDateStart(row.date_start);
    if (!rowDate) continue;
    if (!minDate || rowDate < minDate) minDate = rowDate;
    if (!maxDate || rowDate > maxDate) maxDate = rowDate;

    const rollup = rollups.get(matchedCreative.id) ?? {
      creativeId: matchedCreative.id,
      spend: 0,
      impressions: 0,
      clicks: 0,
      threeSecondViews: 0,
      thruplayViews: 0,
      metaPurchases: 0,
      adIds: new Set<string>(),
    };

    rollup.spend += parseFloat(row.spend) || 0;
    rollup.impressions += parseInt(row.impressions) || 0;
    rollup.clicks += parseInt(row.clicks) || 0;
    rollup.threeSecondViews += getThreeSecondViews(row);
    rollup.thruplayViews += getActionValue(
      row.video_thruplay_watched_actions,
      "video_view"
    );
    rollup.metaPurchases += getActionValue(row.actions, "purchase");

    if (row.ad_id) {
      rollup.adIds.add(row.ad_id);
      matchedAdIds.add(row.ad_id);
    }

    rollups.set(matchedCreative.id, rollup);

    // Daily rollup pra fatigue predictivo (Onda 2.3)
    const dKey = { creativeId: matchedCreative.id, date: rowDate };
    const ds = dayKeyStr(dKey);
    const dr =
      dailyRollups.get(ds) ?? {
        creativeId: matchedCreative.id,
        date: rowDate,
        spend: 0,
        impressions: 0,
        clicks: 0,
        threeSecondViews: 0,
        thruplayViews: 0,
      };
    dr.spend += parseFloat(row.spend) || 0;
    dr.impressions += parseInt(row.impressions) || 0;
    dr.clicks += parseInt(row.clicks) || 0;
    dr.threeSecondViews += getThreeSecondViews(row);
    dr.thruplayViews += getActionValue(
      row.video_thruplay_watched_actions,
      "video_view"
    );
    dailyRollups.set(ds, dr);
  }

  if (rollups.size === 0) return;

  const realSalesByAdId = new Map<string, number>();
  if (minDate && maxDate && matchedAdIds.size > 0) {
    const rangeEnd = endOfBRTDay(maxDate);

    const sales = await prisma.sale.findMany({
      where: {
        productId,
        status: "approved",
        metaAdId: { in: Array.from(matchedAdIds) },
        date: { gte: minDate, lte: rangeEnd },
      },
      select: { metaAdId: true },
    });

    for (const sale of sales) {
      if (!sale.metaAdId) continue;
      realSalesByAdId.set(
        sale.metaAdId,
        (realSalesByAdId.get(sale.metaAdId) || 0) + 1
      );
    }
  }

  for (const rollup of rollups.values()) {
    const realSales = Array.from(rollup.adIds).reduce(
      (sum, adId) => sum + (realSalesByAdId.get(adId) || 0),
      0
    );
    const sales = realSales > 0 ? realSales : rollup.metaPurchases;
    const ctr =
      rollup.impressions > 0 ? (rollup.clicks / rollup.impressions) * 100 : null;
    const hookRate =
      rollup.impressions > 0
        ? (rollup.threeSecondViews / rollup.impressions) * 100
        : null;
    const thruplayRate =
      rollup.impressions > 0
        ? (rollup.thruplayViews / rollup.impressions) * 100
        : null;
    const cpa = sales > 0 ? rollup.spend / sales : null;

    const data: { ctr: number | null; hookRate: number | null; thruplayRate: number | null; cpa: number | null; metaAdId?: string } = {
      ctr,
      hookRate,
      thruplayRate,
      cpa,
    };
    const adIdToPersist = metaAdIdToPersist.get(rollup.creativeId);
    if (adIdToPersist) data.metaAdId = adIdToPersist;

    await prisma.creative.update({
      where: { id: rollup.creativeId },
      data,
    });
  }

  // Persiste historico diario (Onda 2.3)
  for (const dr of dailyRollups.values()) {
    const ctr = dr.impressions > 0 ? (dr.clicks / dr.impressions) * 100 : null;
    const hookRate =
      dr.impressions > 0 ? (dr.threeSecondViews / dr.impressions) * 100 : null;
    const thruplayRate =
      dr.impressions > 0 ? (dr.thruplayViews / dr.impressions) * 100 : null;
    // CPA diario nao calculamos aqui pra evitar overlap com Sale dedup.
    try {
      await prisma.creativeDailyMetric.upsert({
        where: {
          creativeId_date: {
            creativeId: dr.creativeId,
            date: dr.date,
          },
        },
        create: {
          creativeId: dr.creativeId,
          date: dr.date,
          spend: dr.spend,
          impressions: dr.impressions,
          clicks: dr.clicks,
          hookRate,
          ctr,
          thruplayRate,
        },
        update: {
          spend: dr.spend,
          impressions: dr.impressions,
          clicks: dr.clicks,
          hookRate,
          ctr,
          thruplayRate,
        },
      });
    } catch (err) {
      console.error(
        `[creative-perf] daily upsert ${dr.creativeId} ${dr.date.toISOString().slice(0, 10)} falhou:`,
        err
      );
    }
  }
}
