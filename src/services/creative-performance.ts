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
    select: { id: true, name: true, campaignId: true },
  });
  if (creatives.length === 0) return;

  const creativesByCampaign = new Map<string, typeof creatives>();
  for (const creative of creatives) {
    if (!creative.campaignId) continue;
    const bucket = creativesByCampaign.get(creative.campaignId) ?? [];
    bucket.push(creative);
    creativesByCampaign.set(creative.campaignId, bucket);
  }

  const rollups = new Map<string, CreativeRollup>();
  const matchedAdIds = new Set<string>();
  let minDate: Date | null = null;
  let maxDate: Date | null = null;

  for (const row of insights) {
    const dbCampaignId = campaignByMetaId.get(row.campaign_id);
    if (!dbCampaignId) continue;

    const candidates = creativesByCampaign.get(dbCampaignId) ?? [];
    const matchedCreative = candidates.find(creative =>
      creativeMatchesAdName(creative.name, row.ad_name || "")
    );
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

    await prisma.creative.update({
      where: { id: rollup.creativeId },
      data: { ctr, hookRate, thruplayRate, cpa },
    });
  }
}
