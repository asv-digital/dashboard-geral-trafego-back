import type { MetaInsight, MetaPaginatedResponse } from "./types";

const API_VERSION = process.env.META_GRAPH_VERSION || "v19.0";
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// Janela de atribuição explícita: 7d post-click + 1d post-view (default Meta
// pós-iOS14, padrão de mercado pra decisões de gestão). Sem isso a conta-nível
// pode estar em "unified" ou outro default e cada conta lê janela diferente —
// auto-pause/scale ficariam decidindo em dado que o gestor não controla.
const ATTRIBUTION_WINDOWS = JSON.stringify(["7d_click", "1d_view"]);

const INSIGHT_FIELDS = [
  "campaign_name",
  "campaign_id",
  "adset_name",
  "adset_id",
  "ad_name",
  "ad_id",
  "spend",
  "impressions",
  "clicks",
  "actions",
  "action_values",
  "cost_per_action_type",
  "cpm",
  "cpc",
  "ctr",
  "frequency",
  "outbound_clicks",
  "video_play_actions",
  "video_thruplay_watched_actions",
  "video_p25_watched_actions",
  "video_p50_watched_actions",
  "video_p75_watched_actions",
  "video_p100_watched_actions",
  "quality_ranking",
  "engagement_rate_ranking",
  "conversion_rate_ranking",
].join(",");

export class MetaClient {
  private token: string;
  private accountId: string;
  private lastRequestTime = 0;
  private minInterval = 200;

  constructor(token: string, accountId: string) {
    this.token = token;
    this.accountId = accountId;
  }

  private async throttledFetch(url: string): Promise<Response> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minInterval) {
      await new Promise(r => setTimeout(r, this.minInterval - elapsed));
    }
    this.lastRequestTime = Date.now();

    let retries = 0;
    const maxRetries = 3;

    const retryableStatuses = new Set([429, 502, 503, 504]);

    while (true) {
      const res = await fetch(url);
      if (retryableStatuses.has(res.status) && retries < maxRetries) {
        retries++;
        const backoff = Math.pow(2, retries) * 1000;
        console.warn(`[MetaClient] ${res.status} — retry ${retries}/${maxRetries} after ${backoff}ms`);
        await new Promise(r => setTimeout(r, backoff));
        this.lastRequestTime = Date.now();
        continue;
      }
      return res;
    }
  }

  /**
   * Busca insights escopados por lista de campaign IDs (whitelist do produto).
   * Se campaignIds for vazio, não faz nada — protege contra coletar dados
   * de campanhas de outros produtos na mesma ad account.
   */
  async getInsightsForCampaigns(
    campaignIds: string[],
    dateFrom: string,
    dateTo: string
  ): Promise<MetaInsight[]> {
    if (campaignIds.length === 0) return [];

    const allInsights: MetaInsight[] = [];
    const filtering = JSON.stringify([
      { field: "campaign.id", operator: "IN", value: campaignIds },
    ]);

    const params = new URLSearchParams({
      fields: INSIGHT_FIELDS,
      time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
      level: "ad",
      time_increment: "1",
      limit: "500",
      filtering,
      action_attribution_windows: ATTRIBUTION_WINDOWS,
      access_token: this.token,
    });

    let url = `${BASE_URL}/${this.accountId}/insights?${params.toString()}`;

    while (url) {
      const res = await this.throttledFetch(url);
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Meta API error ${res.status}: ${err}`);
      }
      const json = (await res.json()) as MetaPaginatedResponse;
      allInsights.push(...json.data);
      url = json.paging?.next ?? "";
    }

    return allInsights;
  }

  /**
   * Insights agregados por placement (publisher_platform + platform_position).
   * Usado pra alimentar PlacementMetric, que vira heatmap no frontend.
   */
  async getInsightsByPlacement(
    campaignIds: string[],
    dateFrom: string,
    dateTo: string
  ): Promise<
    Array<{
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
  > {
    if (campaignIds.length === 0) return [];

    const filtering = JSON.stringify([
      { field: "campaign.id", operator: "IN", value: campaignIds },
    ]);

    const params = new URLSearchParams({
      fields: "campaign_id,adset_id,spend,impressions,clicks,actions,cpm",
      time_range: JSON.stringify({ since: dateFrom, until: dateTo }),
      level: "adset",
      breakdowns: "publisher_platform,platform_position",
      limit: "500",
      filtering,
      action_attribution_windows: ATTRIBUTION_WINDOWS,
      access_token: this.token,
    });

    const rows: Array<{
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
    }> = [];

    let url = `${BASE_URL}/${this.accountId}/insights?${params.toString()}`;
    while (url) {
      const res = await this.throttledFetch(url);
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Meta insights-by-placement ${res.status}: ${err}`);
      }
      const json = (await res.json()) as MetaPaginatedResponse & {
        data?: Array<{
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
        }>;
      };
      rows.push(...(json.data ?? []));
      url = json.paging?.next ?? "";
    }

    return rows;
  }

}

export function getActionValue(
  actions: MetaInsight["actions"],
  actionType: string
): number {
  if (!actions) return 0;
  const found = actions.find(a => a.action_type === actionType);
  return found ? parseFloat(found.value) : 0;
}

export function getCostPerAction(
  costs: MetaInsight["cost_per_action_type"],
  actionType: string
): number | null {
  if (!costs) return null;
  const found = costs.find(a => a.action_type === actionType);
  return found ? parseFloat(found.value) : null;
}

export function getLandingPageViews(actions: MetaInsight["actions"]): number {
  return getActionValue(actions, "landing_page_view");
}

export function getInitiateCheckouts(actions: MetaInsight["actions"]): number {
  return (
    getActionValue(actions, "initiate_checkout") ||
    getActionValue(actions, "offsite_conversion.fb_pixel_initiate_checkout")
  );
}

export function getOutboundClicks(insight: MetaInsight): number {
  if (!insight.outbound_clicks) return 0;
  if (Array.isArray(insight.outbound_clicks)) {
    const found = insight.outbound_clicks.find(
      (a: any) => a.action_type === "outbound_click"
    );
    return found ? parseInt(found.value) : 0;
  }
  return parseInt(String(insight.outbound_clicks)) || 0;
}

export function getVideoPlays(insight: MetaInsight): number {
  if (!insight.video_play_actions) return 0;
  const found = insight.video_play_actions.find(
    (a: any) => a.action_type === "video_view"
  );
  return found ? parseInt(found.value) : 0;
}

export function getThreeSecondViews(insight: MetaInsight): number {
  if (insight.video_thruplay_watched_actions) {
    const found = insight.video_thruplay_watched_actions.find(
      (a: any) => a.action_type === "video_view"
    );
    if (found) return parseInt(found.value);
  }
  if (insight.video_p25_watched_actions) {
    const found = insight.video_p25_watched_actions.find(
      (a: any) => a.action_type === "video_view"
    );
    if (found) return parseInt(found.value);
  }
  return 0;
}
