export interface MetaInsight {
  campaign_name: string;
  campaign_id: string;
  adset_name: string;
  adset_id: string;
  ad_name: string;
  ad_id: string;
  spend: string;
  impressions: string;
  clicks: string;
  cpm: string;
  cpc: string;
  ctr: string;
  frequency: string;
  actions?: Array<{ action_type: string; value: string }>;
  action_values?: Array<{ action_type: string; value: string }>;
  cost_per_action_type?: Array<{ action_type: string; value: string }>;
  outbound_clicks?: any;
  outbound_ctr?: string;
  video_play_actions?: Array<{ action_type: string; value: string }>;
  video_thruplay_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p25_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p50_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p75_watched_actions?: Array<{ action_type: string; value: string }>;
  video_p100_watched_actions?: Array<{ action_type: string; value: string }>;
  quality_ranking?: string;
  engagement_rate_ranking?: string;
  conversion_rate_ranking?: string;
  date_start: string;
  date_stop: string;
}

export interface MetaPaginatedResponse {
  data: MetaInsight[];
  paging?: {
    cursors?: { before: string; after: string };
    next?: string;
  };
}

export interface ConsolidatedMetric {
  date: string;
  campaignName: string;
  campaignId: string;
  adSetName: string;
  adSetId: string;
  investment: number;
  impressions: number;
  clicks: number;
  linkClicks: number;
  sales: number;
  revenue: number;
  cpm: number;
  cpc: number;
  ctr: number;
  cpa: number | null;
  roas: number | null;
  frequency: number;
  hookRate: number | null;
  landingPageViews: number;
  initiateCheckouts: number;
  outboundClicks: number;
  outboundCtr: number | null;
  threeSecondViews: number;
  videoPlays: number;
  costPerLandingPageView: number | null;
}

export interface ProductCollectionResult {
  productId: string;
  productName: string;
  totalInvestment: number;
  totalSales: number;
  totalRevenue: number;
  cpa: number;
  roas: number;
  metricsCount: number;
  alerts: string[];
  error?: string;
}
