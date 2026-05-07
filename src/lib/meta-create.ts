// Helpers para criar entidades no Meta (campaign, adset, adcreative, ad).

import { getResolvedGlobalSettings } from "./runtime-config";

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

async function post(endpoint: string, params: Record<string, any>): Promise<any> {
  const { metaAccessToken } = await getResolvedGlobalSettings();
  if (!metaAccessToken) {
    throw new Error("Meta access token não configurado");
  }
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") body.set(k, v);
    else body.set(k, JSON.stringify(v));
  }
  body.set("access_token", metaAccessToken);

  const res = await fetch(`${META_BASE}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(`Meta API ${endpoint}: ${json.error.message}`);
  return json;
}

export interface CreateCampaignInput {
  adAccountId: string;
  name: string;
  objective: "OUTCOME_SALES" | "OUTCOME_TRAFFIC" | "OUTCOME_ENGAGEMENT";
  buyingType?: "AUCTION";
  status?: "ACTIVE" | "PAUSED";
  // M2 — flag pra ASC nativo (Advantage+ Shopping Campaigns). Quando setado,
  // Meta criar campanha gerenciada por IA (audiencia/placements/criativos
  // automatizados). Sem isso, mesmo nomeando "ASC" e setando publisher_platforms
  // = vazio, e so OUTCOME_SALES manual com placements automaticos.
  smartPromotionType?: "AUTOMATED_SHOPPING_ADS";
}

export async function createCampaign(input: CreateCampaignInput): Promise<{ id: string }> {
  const params: Record<string, any> = {
    name: input.name,
    objective: input.objective,
    buying_type: input.buyingType || "AUCTION",
    special_ad_categories: [],
    status: input.status || "PAUSED",
  };
  if (input.smartPromotionType) {
    params.smart_promotion_type = input.smartPromotionType;
  }
  return post(`${input.adAccountId}/campaigns`, params);
}

export interface CreateAdsetInput {
  adAccountId: string;
  campaignId: string;
  name: string;
  dailyBudgetReais: number;
  targeting: any;
  optimizationGoal?: string;
  billingEvent?: string;
  pixelId?: string;
  customEventType?: string;
  status?: "ACTIVE" | "PAUSED";
}

export async function createAdset(input: CreateAdsetInput): Promise<{ id: string }> {
  const promotedObject: any = {};
  if (input.pixelId) promotedObject.pixel_id = input.pixelId;
  if (input.customEventType) promotedObject.custom_event_type = input.customEventType;

  return post(`${input.adAccountId}/adsets`, {
    name: input.name,
    campaign_id: input.campaignId,
    daily_budget: Math.round(input.dailyBudgetReais * 100),
    billing_event: input.billingEvent || "IMPRESSIONS",
    optimization_goal: input.optimizationGoal || "OFFSITE_CONVERSIONS",
    targeting: input.targeting,
    promoted_object: Object.keys(promotedObject).length > 0 ? promotedObject : undefined,
    status: input.status || "PAUSED",
  });
}

export interface CreateAdCreativeInput {
  adAccountId: string;
  name: string;
  pageId: string;
  linkUrl: string;
  headline: string;
  primaryText: string;
  description?: string;
  ctaType?: string;
  videoId?: string;
  imageHash?: string;
}

export async function createAdCreative(
  input: CreateAdCreativeInput
): Promise<{ id: string }> {
  const objectStorySpec: any = { page_id: input.pageId };
  if (input.videoId) {
    objectStorySpec.video_data = {
      video_id: input.videoId,
      message: input.primaryText,
      title: input.headline,
      description: input.description || "",
      call_to_action: {
        type: input.ctaType || "LEARN_MORE",
        value: { link: input.linkUrl },
      },
      link: input.linkUrl,
    };
  } else if (input.imageHash) {
    objectStorySpec.link_data = {
      image_hash: input.imageHash,
      message: input.primaryText,
      name: input.headline,
      description: input.description || "",
      link: input.linkUrl,
      call_to_action: { type: input.ctaType || "LEARN_MORE" },
    };
  } else {
    throw new Error("adcreative requer videoId ou imageHash");
  }

  return post(`${input.adAccountId}/adcreatives`, {
    name: input.name,
    object_story_spec: objectStorySpec,
  });
}

export interface CreateAdInput {
  adAccountId: string;
  name: string;
  adsetId: string;
  creativeId: string;
  status?: "ACTIVE" | "PAUSED";
}

export async function createAd(input: CreateAdInput): Promise<{ id: string }> {
  return post(`${input.adAccountId}/ads`, {
    name: input.name,
    adset_id: input.adsetId,
    creative: { creative_id: input.creativeId },
    status: input.status || "PAUSED",
  });
}
