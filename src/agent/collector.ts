// Collector product-aware.
//
// Diferente da v1: roda uma vez por produto. Pra cada produto, busca apenas
// as campanhas cuja metaCampaignId está na whitelist local — NUNCA coleta
// insights de campanhas que o agente não gerencia (mesmo que rodando na
// mesma ad account). Sem isso, o cross-talk entre produtos seria certo.
//
// Preserva tudo que a v1 fazia: consolidação de insights, funil (LPV/IC),
// hook rate, thruplay, outbound, vendas via Kirvano webhook no banco.

import prisma from "../prisma";
import {
  MetaClient,
  getActionValue,
  getLandingPageViews,
  getInitiateCheckouts,
  getOutboundClicks,
  getVideoPlays,
  getThreeSecondViews,
} from "./meta-client";
import type { MetaInsight, ConsolidatedMetric, ProductCollectionResult } from "./types";
import {
  addBRTDays,
  brtRangeFromStrings,
  dateStringBRT,
  endOfBRTDay,
  parseBRTDateStart,
  startOfBRTDay,
} from "../lib/tz";
import { syncCreativePerformanceFromInsights } from "../services/creative-performance";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";

function today(): string {
  return dateStringBRT(startOfBRTDay());
}
function daysAgo(n: number): string {
  return dateStringBRT(addBRTDays(startOfBRTDay(), -n));
}

async function getMetaCredentials(
  product?: Parameters<typeof getResolvedProductMetaSettings>[0]
): Promise<{ token: string; accountId: string } | null> {
  const { accessToken: token, adAccountId: accountId } =
    await getResolvedProductMetaSettings(product);
  if (!token || !accountId) return null;
  return { token, accountId };
}

interface SaleAttributionMaps {
  byAdsetAndDate: Map<string, number>;
  byCampaignAndDate: Map<string, number>;
}

function attributionKey(date: string, entityId: string): string {
  return `${date}|${entityId}`;
}

function buildSaleAttributionMaps(
  sales: Array<{ date: Date; metaAdsetId: string | null; metaCampaignId: string | null }>
): SaleAttributionMaps {
  const byAdsetAndDate = new Map<string, number>();
  const byCampaignAndDate = new Map<string, number>();

  for (const sale of sales) {
    const date = dateStringBRT(sale.date);
    if (sale.metaAdsetId) {
      const key = attributionKey(date, sale.metaAdsetId);
      byAdsetAndDate.set(key, (byAdsetAndDate.get(key) || 0) + 1);
      continue;
    }
    if (sale.metaCampaignId) {
      const key = attributionKey(date, sale.metaCampaignId);
      byCampaignAndDate.set(key, (byCampaignAndDate.get(key) || 0) + 1);
    }
  }

  return { byAdsetAndDate, byCampaignAndDate };
}

function consolidateInsights(
  insights: MetaInsight[],
  saleAttribution: SaleAttributionMaps,
  netPerSale: number
): ConsolidatedMetric[] {
  const grouped = new Map<string, MetaInsight[]>();
  for (const row of insights) {
    const key = `${row.campaign_id}|${row.adset_id}|${row.date_start}`;
    const arr = grouped.get(key) ?? [];
    arr.push(row);
    grouped.set(key, arr);
  }

  const metrics: ConsolidatedMetric[] = [];
  const adsetCountByCampaignDate = new Map<string, number>();

  for (const [, rows] of grouped) {
    const first = rows[0];
    const key = attributionKey(first.date_start, first.campaign_id);
    adsetCountByCampaignDate.set(key, (adsetCountByCampaignDate.get(key) || 0) + 1);
  }

  for (const [, rows] of grouped) {
    const first = rows[0];
    const date = first.date_start;

    let investment = 0;
    let impressions = 0;
    let clicks = 0;
    let linkClicks = 0;
    let metaPurchases = 0;
    let frequencyWeightedSum = 0;
    let frequencyWeightTotal = 0;
    let videoViews3s = 0;
    let videoImpressions = 0;
    let landingPageViews = 0;
    let initiateCheckouts = 0;
    let outboundClicks = 0;
    let threeSecondViews = 0;
    let videoPlays = 0;

    for (const row of rows) {
      const rowImpressions = parseInt(row.impressions) || 0;
      investment += parseFloat(row.spend) || 0;
      impressions += rowImpressions;
      clicks += parseInt(row.clicks) || 0;
      linkClicks += getActionValue(row.actions, "link_click");
      metaPurchases += getActionValue(row.actions, "purchase");
      const rowFreq = parseFloat(row.frequency) || 0;
      if (rowFreq > 0 && rowImpressions > 0) {
        frequencyWeightedSum += rowFreq * rowImpressions;
        frequencyWeightTotal += rowImpressions;
      }
      landingPageViews += getLandingPageViews(row.actions);
      initiateCheckouts += getInitiateCheckouts(row.actions);
      outboundClicks += getOutboundClicks(row);
      videoPlays += getVideoPlays(row);
      threeSecondViews += getThreeSecondViews(row);

      const v25 = getActionValue(row.video_p25_watched_actions, "video_view");
      if (v25 > 0) {
        videoViews3s += v25;
        videoImpressions += parseInt(row.impressions) || 0;
      }
    }

    // Atribuicao de vendas em 2 fontes separadas (gap C8 da auditoria):
    //   - salesKirvano: autoritativo, vem do webhook com UTM/scoped IDs.
    //     Adset-level se disponivel; campanha-level so quando ha 1 adset no
    //     dia (heuristica segura). NUNCA fallback pra Pixel.
    //   - salesPixel: observabilidade, vem do "purchase" do Insights API.
    //     Pode duplicar entre adsets ou atribuir errado quando UTM falha.
    // sales = melhor estimativa (kirvano > pixel fallback) pra dashboard;
    // auto-executor decide com salesKirvano apenas.
    const adsetScopedSales =
      saleAttribution.byAdsetAndDate.get(attributionKey(date, first.adset_id)) ?? 0;
    const campaignScopedSales =
      saleAttribution.byCampaignAndDate.get(attributionKey(date, first.campaign_id)) ?? 0;
    const adsetsInCampaignDay =
      adsetCountByCampaignDate.get(attributionKey(date, first.campaign_id)) ?? 0;
    const salesKirvano =
      adsetScopedSales > 0
        ? adsetScopedSales
        : campaignScopedSales > 0 && adsetsInCampaignDay === 1
          ? campaignScopedSales
          : 0;
    const salesPixel = metaPurchases;
    const sales = salesKirvano > 0 ? salesKirvano : salesPixel;

    const revenue = sales * netPerSale;
    const hookRate =
      impressions > 0 && threeSecondViews > 0
        ? (threeSecondViews / impressions) * 100
        : videoImpressions > 0
          ? (videoViews3s / videoImpressions) * 100
          : null;
    const outboundCtr =
      impressions > 0 && outboundClicks > 0 ? (outboundClicks / impressions) * 100 : null;
    const costPerLpv = landingPageViews > 0 ? investment / landingPageViews : null;

    metrics.push({
      date,
      campaignName: first.campaign_name,
      campaignId: first.campaign_id,
      adSetName: first.adset_name,
      adSetId: first.adset_id,
      investment,
      impressions,
      clicks: linkClicks > 0 ? linkClicks : clicks,
      linkClicks,
      sales,
      salesKirvano,
      salesPixel,
      revenue,
      cpm: impressions > 0 ? (investment / impressions) * 1000 : 0,
      cpc: clicks > 0 ? investment / clicks : 0,
      ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
      cpa: sales > 0 ? investment / sales : null,
      roas: investment > 0 ? revenue / investment : null,
      frequency: frequencyWeightTotal > 0 ? frequencyWeightedSum / frequencyWeightTotal : 0,
      hookRate,
      landingPageViews,
      initiateCheckouts,
      outboundClicks,
      outboundCtr,
      threeSecondViews,
      videoPlays,
      costPerLandingPageView: costPerLpv,
    });
  }

  return metrics.sort((a, b) => a.date.localeCompare(b.date));
}

async function syncToDatabase(
  productId: string,
  metrics: ConsolidatedMetric[]
): Promise<void> {
  // Agrupa por metaCampaignId — precisamos achar a Campaign correspondente no nosso banco
  const byMetaCampaign = new Map<string, ConsolidatedMetric[]>();
  for (const m of metrics) {
    const arr = byMetaCampaign.get(m.campaignId) ?? [];
    arr.push(m);
    byMetaCampaign.set(m.campaignId, arr);
  }

  for (const [metaCampaignId, campaignMetrics] of byMetaCampaign) {
    // Whitelist: só processa se a campanha existir no banco pra ESTE produto
    const campaign = await prisma.campaign.findUnique({
      where: { productId_metaCampaignId: { productId, metaCampaignId } },
    });
    if (!campaign) {
      console.log(
        `  [!] campanha ${metaCampaignId} não pertence ao produto ${productId}, pulando`
      );
      continue;
    }

    for (const m of campaignMetrics) {
      const date = parseBRTDateStart(m.date);
      if (!date) {
        console.error(`  [x] data inválida em metric ${m.date} / ${m.adSetName}`);
        continue;
      }
      try {
        await prisma.metricEntry.upsert({
          where: {
            productId_campaignId_date_adSet: {
              productId,
              campaignId: campaign.id,
              date,
              adSet: m.adSetName,
            },
          },
          create: {
            productId,
            campaignId: campaign.id,
            date,
            adSet: m.adSetName,
            investment: m.investment,
            impressions: m.impressions,
            clicks: m.clicks,
            sales: m.sales,
            salesKirvano: m.salesKirvano,
            salesPixel: m.salesPixel,
            frequency: m.frequency,
            hookRate: m.hookRate,
            landingPageViews: m.landingPageViews || null,
            initiateCheckouts: m.initiateCheckouts || null,
            outboundClicks: m.outboundClicks || null,
            outboundCtr: m.outboundCtr,
            threeSecondViews: m.threeSecondViews || null,
            videoPlays: m.videoPlays || null,
            costPerLandingPageView: m.costPerLandingPageView,
            clickToPageViewRate:
              m.landingPageViews > 0 && m.clicks > 0
                ? (m.landingPageViews / m.clicks) * 100
                : null,
            pageViewToCheckout:
              m.initiateCheckouts > 0 && m.landingPageViews > 0
                ? (m.initiateCheckouts / m.landingPageViews) * 100
                : null,
            checkoutToSaleRate:
              m.sales > 0 && m.initiateCheckouts > 0
                ? (m.sales / m.initiateCheckouts) * 100
                : null,
            observations: `[auto] metaCampaignId=${metaCampaignId} adset=${m.adSetId}`,
          },
          update: {
            investment: m.investment,
            impressions: m.impressions,
            clicks: m.clicks,
            sales: m.sales,
            salesKirvano: m.salesKirvano,
            salesPixel: m.salesPixel,
            frequency: m.frequency,
            hookRate: m.hookRate,
            landingPageViews: m.landingPageViews || null,
            initiateCheckouts: m.initiateCheckouts || null,
            outboundClicks: m.outboundClicks || null,
            outboundCtr: m.outboundCtr,
            threeSecondViews: m.threeSecondViews || null,
            videoPlays: m.videoPlays || null,
            costPerLandingPageView: m.costPerLandingPageView,
          },
        });
      } catch (err) {
        console.error(
          `  [x] erro ao salvar metric ${m.date} / ${m.adSetName}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }
}

async function saveAdDiagnostics(
  productId: string,
  insights: MetaInsight[]
): Promise<void> {
  let saved = 0;
  for (const row of insights) {
    if (!row.ad_id || !row.quality_ranking || row.quality_ranking === "UNKNOWN") continue;

    const spend = parseFloat(row.spend) || 0;
    const purchases = row.actions?.find(
      a =>
        a.action_type === "purchase" ||
        a.action_type === "offsite_conversion.fb_pixel_purchase"
    );
    const sales = purchases ? parseFloat(purchases.value) : 0;
    const cpa = sales > 0 ? spend / sales : null;
    const date = parseBRTDateStart(row.date_start);
    if (!date) continue;

    try {
      await prisma.adDiagnostic.upsert({
        where: { productId_date_adId: { productId, date, adId: row.ad_id } },
        create: {
          productId,
          date,
          adId: row.ad_id,
          adName: row.ad_name || "",
          adsetId: row.adset_id || "",
          campaignId: row.campaign_id || "",
          qualityRanking: row.quality_ranking || "UNKNOWN",
          engagementRanking: row.engagement_rate_ranking || "UNKNOWN",
          conversionRanking: row.conversion_rate_ranking || "UNKNOWN",
          spend,
          cpa,
        },
        update: {
          qualityRanking: row.quality_ranking || "UNKNOWN",
          engagementRanking: row.engagement_rate_ranking || "UNKNOWN",
          conversionRanking: row.conversion_rate_ranking || "UNKNOWN",
          spend,
          cpa,
        },
      });
      saved++;
    } catch {
      // skip
    }
  }
  if (saved > 0) console.log(`  [+] ${saved} ad diagnostics salvos`);
}

async function saveDailySnapshot(productId: string): Promise<void> {
  const todayDate = startOfBRTDay();
  const todayEnd = endOfBRTDay(todayDate);

  const agg = await prisma.metricEntry.aggregate({
    where: { productId, date: { gte: todayDate, lte: todayEnd } },
    _sum: { investment: true, impressions: true, clicks: true, sales: true },
    _avg: { frequency: true, hookRate: true, outboundCtr: true },
  });

  const totalSpend = agg._sum.investment || 0;
  const totalSales = agg._sum.sales || 0;
  const impressions = agg._sum.impressions || 0;
  const clicks = agg._sum.clicks || 0;

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return;

  const revenue = totalSales * product.netPerSale;
  const avgCpa = totalSales > 0 ? totalSpend / totalSales : null;
  const avgRoas = totalSpend > 0 ? revenue / totalSpend : null;
  const avgCtr = impressions > 0 ? (clicks / impressions) * 100 : null;
  const avgCpm = impressions > 0 ? (totalSpend / impressions) * 1000 : null;

  await prisma.dailySnapshot.upsert({
    where: { productId_date: { productId, date: todayDate } },
    create: {
      productId,
      date: todayDate,
      totalSpend,
      totalSales,
      totalRevenue: revenue,
      avgCpa,
      avgRoas,
      avgCtr,
      avgCpm,
      avgFrequency: agg._avg.frequency || null,
      hookRate: agg._avg.hookRate || null,
      outboundCtr: agg._avg.outboundCtr || null,
    },
    update: {
      totalSpend,
      totalSales,
      totalRevenue: revenue,
      avgCpa,
      avgRoas,
      avgCtr,
      avgCpm,
      avgFrequency: agg._avg.frequency || null,
      hookRate: agg._avg.hookRate || null,
      outboundCtr: agg._avg.outboundCtr || null,
      collectedAt: new Date(),
    },
  });
}

async function savePlacementMetrics(
  productId: string,
  rows: Array<{
    campaign_id: string;
    adset_id: string;
    publisher_platform: string;
    platform_position: string;
    spend: string;
    impressions: string;
    clicks: string;
    actions?: Array<{ action_type: string; value: string }>;
    cpm: string;
    date_start: string;
  }>
): Promise<void> {
  if (rows.length === 0) return;

  for (const r of rows) {
    const spend = parseFloat(r.spend) || 0;
    const impressions = parseInt(r.impressions) || 0;
    const clicks = parseInt(r.clicks) || 0;
    const cpm = parseFloat(r.cpm) || (impressions > 0 ? (spend / impressions) * 1000 : 0);

    const purchaseAction = (r.actions || []).find(
      a =>
        a.action_type === "purchase" ||
        a.action_type === "offsite_conversion.fb_pixel_purchase"
    );
    const conversions = purchaseAction ? parseInt(purchaseAction.value) : 0;
    const cpa = conversions > 0 ? spend / conversions : null;

    const date = parseBRTDateStart(r.date_start);
    if (!date) continue;

    try {
      await prisma.placementMetric.create({
        data: {
          productId,
          date,
          campaignId: r.campaign_id,
          adsetId: r.adset_id,
          platform: r.publisher_platform,
          position: r.platform_position,
          impressions,
          spend,
          cpm,
          clicks,
          conversions,
          cpa,
        },
      });
    } catch {
      // skip — placement metrics são append-only sem unique constraint
    }
  }
}

async function saveCPMTrend(productId: string): Promise<void> {
  const todayDate = startOfBRTDay();
  const todayEnd = endOfBRTDay(todayDate);

  const agg = await prisma.metricEntry.aggregate({
    where: { productId, date: { gte: todayDate, lte: todayEnd } },
    _sum: { investment: true, impressions: true, clicks: true, sales: true },
  });

  const spend = agg._sum.investment || 0;
  const impressions = agg._sum.impressions || 0;
  const clicks = agg._sum.clicks || 0;
  const sales = agg._sum.sales || 0;
  if (impressions === 0) return;

  const avgCPM = (spend / impressions) * 1000;
  const avgCTR = clicks / impressions;
  const avgCPA = sales > 0 ? spend / sales : 0;

  const thirtyDaysAgo = addBRTDays(todayDate, -30);
  const last30 = await prisma.cPMTrend.findMany({
    where: { productId, date: { gte: thirtyDaysAgo, lt: todayDate } },
  });
  const avg30dCPM =
    last30.length > 0 ? last30.reduce((s, d) => s + d.avgCPM, 0) / last30.length : avgCPM;
  const cpmVariation = avg30dCPM > 0 ? ((avgCPM - avg30dCPM) / avg30dCPM) * 100 : 0;

  let note: string | null = null;
  if (cpmVariation > 25) note = `CPM +${cpmVariation.toFixed(0)}% vs 30d — competição alta`;
  if (cpmVariation < -20) note = `CPM ${cpmVariation.toFixed(0)}% vs 30d — oportunidade`;

  await prisma.cPMTrend.upsert({
    where: { productId_date: { productId, date: todayDate } },
    create: {
      productId,
      date: todayDate,
      avgCPM: parseFloat(avgCPM.toFixed(2)),
      avgCTR: parseFloat(avgCTR.toFixed(6)),
      avgCPA: parseFloat(avgCPA.toFixed(2)),
      totalSpend: parseFloat(spend.toFixed(2)),
      totalImpressions: impressions,
      note,
    },
    update: {
      avgCPM: parseFloat(avgCPM.toFixed(2)),
      avgCTR: parseFloat(avgCTR.toFixed(6)),
      avgCPA: parseFloat(avgCPA.toFixed(2)),
      totalSpend: parseFloat(spend.toFixed(2)),
      totalImpressions: impressions,
      note,
    },
  });
}

/**
 * Coleta de UM produto: busca insights das campanhas desse produto,
 * consolida, salva métricas, diagnostics, snapshot diário, heartbeat.
 */
export async function collectProduct(productId: string): Promise<ProductCollectionResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    return {
      productId,
      productName: "(unknown)",
      totalInvestment: 0,
      totalSales: 0,
      totalRevenue: 0,
      cpa: 0,
      roas: 0,
      metricsCount: 0,
      alerts: ["produto não encontrado"],
      error: "product_not_found",
    };
  }

  const creds = await getMetaCredentials(product);
  if (!creds) {
    return {
      productId,
      productName: product.name,
      totalInvestment: 0,
      totalSales: 0,
      totalRevenue: 0,
      cpa: 0,
      roas: 0,
      metricsCount: 0,
      alerts: ["META_ACCESS_TOKEN/META_AD_ACCOUNT_ID não configurados"],
      error: "meta_not_configured",
    };
  }

  // Whitelist: só campanhas deste produto com metaCampaignId setado
  const ourCampaigns = await prisma.campaign.findMany({
    where: {
      productId,
      metaCampaignId: { not: null },
      status: { not: "Arquivada" },
    },
    select: { id: true, metaCampaignId: true },
  });
  const campaignIds = ourCampaigns
    .map(c => c.metaCampaignId)
    .filter((id): id is string => id !== null);
  const trackedDbCampaignIds = ourCampaigns.map(c => c.id);

  if (campaignIds.length === 0) {
    console.log(`[collector:${product.slug}] nenhuma campanha whitelisted, pulando meta api`);
    // Ainda registra heartbeat "ok sem trabalho"
    await prisma.agentHeartbeat.upsert({
      where: { productId },
      create: { productId, lastCollectionAt: new Date(), consecutiveFailures: 0 },
      update: { lastCollectionAt: new Date(), consecutiveFailures: 0, lastError: null },
    });
    return {
      productId,
      productName: product.name,
      totalInvestment: 0,
      totalSales: 0,
      totalRevenue: 0,
      cpa: 0,
      roas: 0,
      metricsCount: 0,
      alerts: ["nenhuma campanha whitelisted"],
    };
  }

  const dateFrom = daysAgo(7);
  const dateTo = today();
  console.log(
    `[collector:${product.slug}] período ${dateFrom}→${dateTo}, ${campaignIds.length} campanhas whitelisted`
  );

  try {
    const client = new MetaClient(creds.token, creds.accountId);
    const insights = await client.getInsightsForCampaigns(campaignIds, dateFrom, dateTo);
    console.log(`[collector:${product.slug}] ${insights.length} insights`);

    // Vendas reais via webhooks Kirvano no banco
    const saleDateWindow = brtRangeFromStrings(dateFrom, dateTo);
    const salesRows = await prisma.sale.findMany({
      where: {
        productId,
        status: "approved",
        date: saleDateWindow,
      },
      select: {
        date: true,
        metaAdsetId: true,
        metaCampaignId: true,
      },
    });
    if (saleDateWindow.gte && saleDateWindow.lte) {
      await prisma.metricEntry.deleteMany({
        where: {
          productId,
          campaignId: { in: trackedDbCampaignIds },
          date: { gte: saleDateWindow.gte, lte: saleDateWindow.lte },
        },
      });
      await prisma.adDiagnostic.deleteMany({
        where: {
          productId,
          campaignId: { in: campaignIds },
          date: { gte: saleDateWindow.gte, lte: saleDateWindow.lte },
        },
      });
    }
    const saleAttribution = buildSaleAttributionMaps(salesRows);
    const consolidated = consolidateInsights(insights, saleAttribution, product.netPerSale);
    await syncToDatabase(productId, consolidated);
    await saveAdDiagnostics(productId, insights);
    await syncCreativePerformanceFromInsights(productId, insights);
    await saveDailySnapshot(productId);
    await saveCPMTrend(productId);

    // Placement breakdown — alimenta PlacementMetric (heatmap no frontend)
    try {
      const placements = await client.getInsightsByPlacement(
        campaignIds,
        dateFrom,
        dateTo
      );
      const placementDateWindow = brtRangeFromStrings(dateFrom, dateTo);
      if (placementDateWindow.gte && placementDateWindow.lte) {
        await prisma.placementMetric.deleteMany({
          where: {
            productId,
            date: {
              gte: placementDateWindow.gte,
              lte: placementDateWindow.lte,
            },
          },
        });
      }
      await savePlacementMetrics(productId, placements);
    } catch (pErr) {
      console.error(`[collector:${product.slug}] placement falhou: ${(pErr as Error).message}`);
    }

    const totalInvestment = consolidated.reduce((s, m) => s + m.investment, 0);
    const totalSales = salesRows.length;
    const totalRevenue = totalSales * product.netPerSale;
    const cpa = totalSales > 0 ? totalInvestment / totalSales : 0;
    const roas = totalInvestment > 0 ? totalRevenue / totalInvestment : 0;

    await prisma.agentHeartbeat.upsert({
      where: { productId },
      create: { productId, lastCollectionAt: new Date(), consecutiveFailures: 0 },
      update: { lastCollectionAt: new Date(), consecutiveFailures: 0, lastError: null },
    });

    return {
      productId,
      productName: product.name,
      totalInvestment,
      totalSales,
      totalRevenue,
      cpa,
      roas,
      metricsCount: consolidated.length,
      alerts: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[collector:${product.slug}] erro: ${msg}`);

    const updated = await prisma.agentHeartbeat.upsert({
      where: { productId },
      create: { productId, consecutiveFailures: 1, lastError: msg },
      update: { consecutiveFailures: { increment: 1 }, lastError: msg },
    });

    // D7 — alerta automatico apos 3 falhas consecutivas. Edge-triggered via
    // alert-dedup pra nao floodar (so dispara quando passa de 2→3 e ai cada
    // 24h enquanto continuar travado). Sem isso, o coletor podia parar de
    // funcionar silenciosamente e ninguem perceber ate o gasto fugir.
    if (updated.consecutiveFailures >= 3) {
      const { sendNotification } = await import("../services/whatsapp-notifier");
      const { shouldSendStateAlert } = await import("../lib/alert-dedup");
      const should = await shouldSendStateAlert(
        productId,
        "collector_failing",
        `failures:${updated.consecutiveFailures >= 5 ? "5+" : updated.consecutiveFailures}`,
        24 * 60 * 60 * 1000
      );
      if (should) {
        await sendNotification(
          "alert_critical",
          {
            type: "COLETOR FALHANDO",
            detail: `${product.name}: ${updated.consecutiveFailures} falhas consecutivas. Ultimo erro: ${msg.slice(0, 200)}`,
            action: "Verificar Meta token / ad account / rede do servidor",
          },
          productId
        );
      }
    }

    return {
      productId,
      productName: product.name,
      totalInvestment: 0,
      totalSales: 0,
      totalRevenue: 0,
      cpa: 0,
      roas: 0,
      metricsCount: 0,
      alerts: [`erro coleta: ${msg}`],
      error: msg,
    };
  }
}

/** Coleta todos os produtos ativos em sequência (1 loop). */
export async function collectAllProducts(): Promise<ProductCollectionResult[]> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  const results: ProductCollectionResult[] = [];
  for (const p of products) {
    results.push(await collectProduct(p.id));
  }
  return results;
}
