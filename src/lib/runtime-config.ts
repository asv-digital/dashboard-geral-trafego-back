import prisma from "../prisma";

const CACHE_TTL_MS = 30 * 1000;

export interface ResolvedGlobalSettings {
  metaAccessToken: string;
  metaTokenCreatedAt: string | null;
  metaAdAccountId: string;
  metaAppId: string;
  metaAppSecret: string;
  metaPixelId: string;
  metaPageId: string;
  metaAudienceBuyersId: string;
  metaAudienceWarmId: string;
  metaAudienceWarmName: string;
  kirvanoWebhookToken: string;
  anthropicApiKey: string;
}

export interface ResolvedNotificationTransport {
  whatsappProvider: string;
  whatsappInstanceId: string;
  whatsappToken: string;
  whatsappPhone: string;
}

export interface ProductMetaOverrides {
  metaPixelId?: string | null;
  metaPageId?: string | null;
  metaAudienceBuyersId?: string | null;
}

interface CacheEntry<T> {
  value: T;
  createdAt: number;
}

let globalSettingsCache: CacheEntry<ResolvedGlobalSettings> | null = null;
let notificationTransportCache: CacheEntry<ResolvedNotificationTransport> | null = null;

function clean(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function isFresh(cache: CacheEntry<unknown> | null): boolean {
  return !!cache && Date.now() - cache.createdAt < CACHE_TTL_MS;
}

export function clearRuntimeConfigCache(
  scope: "all" | "global" | "notification" = "all"
): void {
  if (scope === "all" || scope === "global") {
    globalSettingsCache = null;
  }
  if (scope === "all" || scope === "notification") {
    notificationTransportCache = null;
  }
}

/**
 * D8 — Meta exige ad account no formato "act_<numero>". O usuario as vezes
 * salva so o numero ou copia com espaco extra. Normaliza pra evitar 400 do
 * Meta. Se vier vazio retorna vazio (env-check decide se e fatal).
 */
function normalizeAdAccountId(value: string): string {
  const v = (value || "").trim();
  if (!v) return "";
  if (v.startsWith("act_")) return v;
  if (/^\d+$/.test(v)) return `act_${v}`;
  // Formato estranho (e.g. "Account 123") — devolve cru pra usuario ver erro
  // do Meta e corrigir, em vez de mascarar com normalizacao agressiva.
  return v;
}

export async function getResolvedGlobalSettings(
  forceRefresh = false
): Promise<ResolvedGlobalSettings> {
  if (!forceRefresh && isFresh(globalSettingsCache)) {
    return globalSettingsCache!.value;
  }

  const settings = await prisma.globalSettings.findUnique({
    where: { id: "singleton" },
  });

  const resolved: ResolvedGlobalSettings = {
    metaAccessToken: clean(settings?.metaAccessToken) || clean(process.env.META_ACCESS_TOKEN),
    metaTokenCreatedAt:
      settings?.metaTokenCreatedAt?.toISOString() ||
      clean(process.env.META_TOKEN_CREATED_AT) ||
      null,
    metaAdAccountId: normalizeAdAccountId(
      clean(settings?.metaAdAccountId) || clean(process.env.META_AD_ACCOUNT_ID)
    ),
    metaAppId: clean(settings?.metaAppId) || clean(process.env.META_APP_ID),
    metaAppSecret: clean(settings?.metaAppSecret) || clean(process.env.META_APP_SECRET),
    metaPixelId: clean(settings?.metaPixelId) || clean(process.env.META_PIXEL_ID),
    metaPageId: clean(settings?.metaPageId) || clean(process.env.META_PAGE_ID),
    metaAudienceBuyersId:
      clean(settings?.metaAudienceBuyersId) || clean(process.env.META_AUDIENCE_BUYERS_ID),
    metaAudienceWarmId:
      clean(settings?.metaAudienceWarmId) || clean(process.env.META_AUDIENCE_WARM_ID),
    metaAudienceWarmName:
      clean(settings?.metaAudienceWarmName) ||
      clean(process.env.META_AUDIENCE_WARM_NAME) ||
      "Warm audience 30d",
    kirvanoWebhookToken:
      clean(settings?.kirvanoWebhookToken) || clean(process.env.KIRVANO_WEBHOOK_TOKEN),
    anthropicApiKey:
      clean(settings?.anthropicApiKey) || clean(process.env.ANTHROPIC_API_KEY),
  };

  globalSettingsCache = { value: resolved, createdAt: Date.now() };
  return resolved;
}

export async function getResolvedProductMetaSettings(
  product?: ProductMetaOverrides | null
): Promise<{
  accessToken: string;
  tokenCreatedAt: string | null;
  adAccountId: string;
  pixelId: string;
  pageId: string;
  audienceBuyersId: string;
  audienceWarmId: string;
  audienceWarmName: string;
}> {
  const settings = await getResolvedGlobalSettings();

  return {
    accessToken: settings.metaAccessToken,
    tokenCreatedAt: settings.metaTokenCreatedAt,
    adAccountId: settings.metaAdAccountId,
    pixelId: clean(product?.metaPixelId) || settings.metaPixelId,
    pageId: clean(product?.metaPageId) || settings.metaPageId,
    audienceBuyersId:
      clean(product?.metaAudienceBuyersId) || settings.metaAudienceBuyersId,
    audienceWarmId: settings.metaAudienceWarmId,
    audienceWarmName: settings.metaAudienceWarmName,
  };
}

export async function getResolvedNotificationTransport(
  forceRefresh = false
): Promise<ResolvedNotificationTransport> {
  if (!forceRefresh && isFresh(notificationTransportCache)) {
    return notificationTransportCache!.value;
  }

  const config = await prisma.notificationConfig.findUnique({
    where: { id: "singleton" },
  });

  const resolved: ResolvedNotificationTransport = {
    whatsappProvider:
      clean(config?.whatsappProvider) || clean(process.env.WHATSAPP_PROVIDER) || "zappfy",
    whatsappInstanceId:
      clean(config?.whatsappInstanceId) || clean(process.env.WHATSAPP_INSTANCE_ID),
    whatsappToken: clean(config?.whatsappToken) || clean(process.env.WHATSAPP_TOKEN),
    whatsappPhone: clean(config?.whatsappPhone) || clean(process.env.WHATSAPP_PHONE),
  };

  notificationTransportCache = { value: resolved, createdAt: Date.now() };
  return resolved;
}
