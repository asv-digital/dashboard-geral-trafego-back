// Wrapper pra mutations no Meta (pausar, escalar, ativar).
// Centraliza o fetch pra não repetir em cada service.

import { getResolvedGlobalSettings } from "./runtime-config";

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

interface MetaPagingResponse<T> {
  data?: T[];
  paging?: {
    next?: string;
  };
}

async function metaPost(entityId: string, body: Record<string, any>): Promise<boolean> {
  const { metaAccessToken } = await getResolvedGlobalSettings();
  const t = metaAccessToken;
  if (!t) return false;
  try {
    const url = `${META_BASE}/${entityId}?access_token=${encodeURIComponent(t)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`[meta-mutations] erro em ${entityId}: ${err}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[meta-mutations] fetch falhou em ${entityId}:`, err);
    return false;
  }
}

export async function pauseCampaign(metaCampaignId: string): Promise<boolean> {
  return metaPost(metaCampaignId, { status: "PAUSED" });
}

export async function activateCampaign(metaCampaignId: string): Promise<boolean> {
  return metaPost(metaCampaignId, { status: "ACTIVE" });
}

export async function pauseAdset(adsetId: string): Promise<boolean> {
  return metaPost(adsetId, { status: "PAUSED" });
}

export async function activateAdset(adsetId: string): Promise<boolean> {
  return metaPost(adsetId, { status: "ACTIVE" });
}

export async function pauseAd(adId: string): Promise<boolean> {
  return metaPost(adId, { status: "PAUSED" });
}

export async function updateAdsetBudget(adsetId: string, budgetReais: number): Promise<boolean> {
  return metaPost(adsetId, { daily_budget: Math.round(budgetReais * 100) });
}

export async function updateCampaignBudget(metaCampaignId: string, budgetReais: number): Promise<boolean> {
  return metaPost(metaCampaignId, { daily_budget: Math.round(budgetReais * 100) });
}

// M10 — learning_stage_info: status oficial da Meta sobre learning phase
// do adset. Possiveis valores: LEARNING, LEARNING_LIMITED, SUCCESS.
// Usado pra decisao precisa em vez de inferir so por hora corrida.
export type LearningStage = "LEARNING" | "LEARNING_LIMITED" | "SUCCESS" | "UNKNOWN";

export interface AdsetLearningInfo {
  adsetId: string;
  status: LearningStage;
  exitReason?: string;
  conversions?: number;
}

/** Retorna learning_stage_info de varios adsets em batch. */
export async function getAdsetsLearningInfo(
  adsetIds: string[]
): Promise<Map<string, AdsetLearningInfo>> {
  const result = new Map<string, AdsetLearningInfo>();
  if (adsetIds.length === 0) return result;

  const { metaAccessToken } = await getResolvedGlobalSettings();
  const t = metaAccessToken;
  if (!t) return result;

  // Graph batch: ate 50 IDs em uma request via ?ids=ID1,ID2,...
  const CHUNK = 50;
  for (let i = 0; i < adsetIds.length; i += CHUNK) {
    const chunk = adsetIds.slice(i, i + CHUNK);
    const url = new URL(`${META_BASE}/`);
    url.searchParams.set("ids", chunk.join(","));
    url.searchParams.set("fields", "learning_stage_info");
    url.searchParams.set("access_token", t);

    try {
      const res = await fetch(url.toString());
      if (!res.ok) continue;
      const json = (await res.json()) as Record<
        string,
        { learning_stage_info?: { status?: string; exit_reason?: string; conversions?: number } }
      >;
      for (const [adsetId, info] of Object.entries(json)) {
        const lsi = info.learning_stage_info;
        const raw = (lsi?.status || "UNKNOWN").toUpperCase();
        const status: LearningStage =
          raw === "LEARNING" || raw === "LEARNING_LIMITED" || raw === "SUCCESS"
            ? raw
            : "UNKNOWN";
        result.set(adsetId, {
          adsetId,
          status,
          exitReason: lsi?.exit_reason,
          conversions: lsi?.conversions,
        });
      }
    } catch (err) {
      console.error(
        `[meta-mutations] getAdsetsLearningInfo chunk ${i} falhou: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return result;
}

export async function getActiveAdsetsForCampaigns(
  accountId: string,
  trackedCampaignIds: string[]
): Promise<Array<{ id: string; name: string; campaignId: string; dailyBudget: number; status: string }>> {
  const { metaAccessToken } = await getResolvedGlobalSettings();
  const t = metaAccessToken;
  if (!t || trackedCampaignIds.length === 0) return [];
  const url = new URL(`${META_BASE}/${accountId}/adsets`);
  url.searchParams.set("access_token", t);
  url.searchParams.set("fields", "id,name,daily_budget,campaign_id,effective_status");
  url.searchParams.set(
    "filtering",
    JSON.stringify([{ field: "campaign.id", operator: "IN", value: trackedCampaignIds }])
  );
  url.searchParams.set("limit", "200");

  try {
    const adsets: Array<{ id: string; name: string; campaignId: string; dailyBudget: number; status: string }> = [];
    let nextUrl = url.toString();

    while (nextUrl) {
      const res = await fetch(nextUrl);
      if (!res.ok) return adsets;
      const json = (await res.json()) as MetaPagingResponse<Record<string, string>>;
      adsets.push(
        ...((json.data ?? []) as any[]).map(a => ({
          id: a.id,
          name: a.name || "",
          campaignId: a.campaign_id || "",
          dailyBudget: a.daily_budget ? parseFloat(a.daily_budget) / 100 : 0,
          status: a.effective_status || "",
        }))
      );
      nextUrl = json.paging?.next || "";
    }

    return adsets;
  } catch {
    return [];
  }
}

export async function getTrackedAdsForCampaigns(
  accountId: string,
  trackedCampaignIds: string[]
): Promise<Array<{ id: string; name: string; campaignId: string; adsetId: string; status: string }>> {
  const { metaAccessToken } = await getResolvedGlobalSettings();
  const t = metaAccessToken;
  if (!t || trackedCampaignIds.length === 0) return [];

  const url = new URL(`${META_BASE}/${accountId}/ads`);
  url.searchParams.set("access_token", t);
  url.searchParams.set("fields", "id,name,campaign_id,adset_id,effective_status");
  url.searchParams.set(
    "filtering",
    JSON.stringify([{ field: "campaign.id", operator: "IN", value: trackedCampaignIds }])
  );
  url.searchParams.set("limit", "200");

  try {
    const ads: Array<{ id: string; name: string; campaignId: string; adsetId: string; status: string }> = [];
    let nextUrl = url.toString();

    while (nextUrl) {
      const res = await fetch(nextUrl);
      if (!res.ok) return ads;
      const json = (await res.json()) as MetaPagingResponse<Record<string, string>>;
      ads.push(
        ...((json.data ?? []) as any[]).map(ad => ({
          id: ad.id || "",
          name: ad.name || "",
          campaignId: ad.campaign_id || "",
          adsetId: ad.adset_id || "",
          status: ad.effective_status || "",
        }))
      );
      nextUrl = json.paging?.next || "";
    }

    return ads;
  } catch {
    return [];
  }
}
