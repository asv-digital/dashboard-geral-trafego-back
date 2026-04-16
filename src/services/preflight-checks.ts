import prisma from "../prisma";
import { getAccountStatus } from "../lib/meta-account";
import {
  getResolvedGlobalSettings,
  getResolvedNotificationTransport,
  getResolvedProductMetaSettings,
} from "../lib/runtime-config";
import { checkStorageHealth, getStorageMode } from "../lib/storage";
import { getSchedulerStatus } from "../agent/scheduler";
import {
  getStrategyAssetRecommendations,
  type StrategyStage,
} from "../lib/planner-playbook";

export interface PreflightCheckItem {
  id: string;
  label: string;
  status: "ok" | "warning" | "error";
  message: string;
  hint?: string;
}

export interface PreflightCheckResult {
  productId: string;
  status: "ok" | "warning" | "error";
  errorCount: number;
  warningCount: number;
  checks: PreflightCheckItem[];
}

export async function runPreflightChecks(
  productId: string
): Promise<PreflightCheckResult | null> {
  const [product, globalSettings, notificationTransport, storageHealth] = await Promise.all([
    prisma.product.findUnique({
      where: { id: productId },
      include: { automationConfig: true },
    }),
    getResolvedGlobalSettings(),
    getResolvedNotificationTransport(),
    checkStorageHealth(),
  ]);
  if (!product) {
    return null;
  }
  const productMeta = await getResolvedProductMetaSettings(product);

  const checks: PreflightCheckItem[] = [];
  const strategyRecommendations = getStrategyAssetRecommendations(
    product.stage as StrategyStage,
    product.dailyBudgetTarget
  );

  checks.push({
    id: "product_status",
    label: "Produto ativo",
    status: product.status === "active" ? "ok" : "error",
    message: product.status,
  });

  checks.push({
    id: "automation_config",
    label: "Automation config",
    status: product.automationConfig ? "ok" : "error",
    message: product.automationConfig ? "presente" : "faltando",
  });

  const economyOk =
    product.priceGross > 0 &&
    product.netPerSale > 0 &&
    product.netPerSale < product.priceGross;
  checks.push({
    id: "economics",
    label: "Economia coerente",
    status: economyOk ? "ok" : "error",
    message: `preço R$${product.priceGross} / net R$${product.netPerSale}`,
  });

  const budgetOk =
    product.dailyBudgetFloor <= product.dailyBudgetTarget &&
    product.dailyBudgetTarget <= product.dailyBudgetCap;
  checks.push({
    id: "budget_range",
    label: "Faixa de budget",
    status: budgetOk ? "ok" : "error",
    message: `${product.dailyBudgetFloor} ≤ ${product.dailyBudgetTarget} ≤ ${product.dailyBudgetCap}`,
  });

  const hasToken = !!globalSettings.metaAccessToken;
  checks.push({
    id: "meta_token",
    label: "Meta access token",
    status: hasToken ? "ok" : "error",
    message: hasToken ? "configurado" : "faltando",
    hint: hasToken ? undefined : "configure o token Meta nas configurações globais",
  });

  if (hasToken && globalSettings.metaTokenCreatedAt) {
    const expires = new Date(globalSettings.metaTokenCreatedAt);
    expires.setDate(expires.getDate() + 60);
    const daysLeft = Math.floor((expires.getTime() - Date.now()) / 86400000);
    checks.push({
      id: "meta_token_expiration",
      label: "Validade token Meta",
      status: daysLeft > 7 ? "ok" : daysLeft > 0 ? "warning" : "error",
      message: `${daysLeft} dias restantes`,
      hint: daysLeft <= 7 ? "renovar token" : undefined,
    });
  }

  const account = await getAccountStatus();
  checks.push({
    id: "ad_account",
    label: "Ad account Meta",
    status: account.active ? "ok" : "error",
    message: `${account.status_key}: ${account.message}`,
    hint: !account.active ? "resolver no Meta Business Settings" : undefined,
  });

  const pixel = productMeta.pixelId;
  checks.push({
    id: "pixel",
    label: "Pixel ID",
    status: pixel ? "ok" : "warning",
    message: pixel || "não configurado",
    hint: pixel ? undefined : "CAPI não vai funcionar",
  });

  const page = productMeta.pageId;
  checks.push({
    id: "page",
    label: "Page ID",
    status: page ? "ok" : "warning",
    message: page || "não configurado",
  });

  checks.push({
    id: "kirvano",
    label: "Kirvano product ID",
    status: product.kirvanoProductId ? "ok" : "error",
    message: product.kirvanoProductId || "faltando",
  });

  checks.push({
    id: "kirvano_webhook",
    label: "Kirvano webhook token",
    status: globalSettings.kirvanoWebhookToken ? "ok" : "warning",
    message: globalSettings.kirvanoWebhookToken ? "configurado" : "aberto (sem validação)",
  });

  checks.push({
    id: "asset_storage",
    label: "Storage de criativos",
    status: storageHealth.ok ? "ok" : "error",
    message: storageHealth.message,
    hint:
      !storageHealth.ok
        ? storageHealth.error
        : getStorageMode() === "r2"
        ? undefined
        : "uploads já funcionam localmente; o backend sobe a mídia direto para o Meta no launch",
  });

  const readyAssets = await prisma.productAsset.findMany({
    where: {
      productId,
      status: { in: ["uploaded", "ready"] },
      type: { in: ["video", "image", "copy", "headline", "hook"] },
    },
    select: {
      id: true,
      type: true,
      status: true,
      originalUrl: true,
      content: true,
      metaMediaId: true,
    },
  });
  const launchableMediaAssets = readyAssets.filter(
    asset => (asset.type === "video" || asset.type === "image") && !!asset.originalUrl
  );
  const readyTextAssets = readyAssets.filter(
    asset =>
      (asset.type === "copy" || asset.type === "headline" || asset.type === "hook") &&
      asset.status === "ready" &&
      !!asset.content
  );
  const readyCopyCount = readyAssets.filter(
    asset => asset.type === "copy" && asset.status === "ready" && !!asset.content
  ).length;
  const readyHeadlineCount = readyAssets.filter(
    asset => asset.type === "headline" && asset.status === "ready" && !!asset.content
  ).length;
  const readyHookCount = readyAssets.filter(
    asset => asset.type === "hook" && asset.status === "ready" && !!asset.content
  ).length;
  checks.push({
    id: "launchable_media_assets",
    label: "Mídias lançáveis",
    status:
      launchableMediaAssets.length >= strategyRecommendations.recommendedMediaAssets
        ? "ok"
        : launchableMediaAssets.length > 0
          ? "warning"
          : "error",
    message:
      launchableMediaAssets.length > 0
        ? `${launchableMediaAssets.length} mídia(s) pronta(s); recomendado para ${product.stage} em R$${product.dailyBudgetTarget}/dia: ${strategyRecommendations.recommendedMediaAssets}`
        : "nenhuma mídia lançável",
    hint:
      launchableMediaAssets.length > 0
        ? launchableMediaAssets.length >= strategyRecommendations.recommendedMediaAssets
          ? undefined
          : `suba mais criativos para evitar fadiga e alimentar até ${strategyRecommendations.creativeSlotLimit} slots por campanha`
        : "suba pelo menos 1 imagem ou vídeo no produto antes do launch",
  });
  checks.push({
    id: "text_asset_inventory",
    label: "Assets textuais",
    status:
      readyTextAssets.length >= strategyRecommendations.recommendedTextAssets
        ? "ok"
        : readyTextAssets.length > 0
          ? "warning"
          : "warning",
    message:
      readyTextAssets.length > 0
        ? `${readyTextAssets.length} asset(s) textual(is) pronto(s); recomendado: ${strategyRecommendations.recommendedTextAssets} (${readyCopyCount} copy, ${readyHeadlineCount} headline, ${readyHookCount} hook)`
        : "nenhum copy/headline/hook pronto",
    hint:
      readyTextAssets.length > 0
        ? readyTextAssets.length >= strategyRecommendations.recommendedTextAssets
          ? undefined
          : "o planner consegue gerar copy, mas escala consistente pede variedade real de hook, headline e corpo"
        : "o planner ainda consegue gerar copy, mas fica melhor com insumo estratégico seu",
  });
  checks.push({
    id: "message_angle_coverage",
    label: "Cobertura de ângulos",
    status:
      readyCopyCount > 0 && readyHeadlineCount > 0 && readyHookCount > 0
        ? "ok"
        : readyTextAssets.length > 0
          ? "warning"
          : "warning",
    message: `${readyCopyCount} copy · ${readyHeadlineCount} headline · ${readyHookCount} hook`,
    hint:
      readyCopyCount > 0 && readyHeadlineCount > 0 && readyHookCount > 0
        ? undefined
        : "deixe pelo menos 1 copy, 1 headline e 1 hook prontos para o agente variar mensagem por estágio do funil",
  });

  if (product.stage !== "launch") {
    const warmAudienceId = productMeta.audienceWarmId;
    checks.push({
      id: "remarketing_audience",
      label: "Audiência quente de remarketing",
      status: warmAudienceId ? "ok" : "warning",
      message: warmAudienceId ? "configurada" : "não configurada",
      hint: warmAudienceId
        ? undefined
        : "sem ela, o planner remove campanhas de remarketing em vez de lançar broad por engano",
    });
  }

  if (product.stage === "escalavel") {
    const lookalikeReady = await prisma.lookalikeAudience.count({
      where: {
        productId,
        status: { in: ["created", "active"] },
        metaAudienceId: { not: null },
        percentage: { lte: 3 },
      },
    });
    checks.push({
      id: "lookalike_inventory",
      label: "Lookalike 1-3% disponível",
      status: lookalikeReady > 0 ? "ok" : "warning",
      message: lookalikeReady > 0 ? `${lookalikeReady} audiência(s)` : "nenhuma pronta",
      hint:
        lookalikeReady > 0
          ? undefined
          : "sem LAL válido, o planner remove essa campanha do playbook",
    });
  }

  const trackedCount = await prisma.campaign.count({
    where: { productId, metaCampaignId: { not: null } },
  });
  checks.push({
    id: "whitelist",
    label: "Campanhas na whitelist",
    status: trackedCount > 0 ? "ok" : "warning",
    message: `${trackedCount} campanhas`,
    hint: trackedCount === 0 ? "crie a primeira campanha via launch" : undefined,
  });

  const heartbeat = await prisma.agentHeartbeat.findUnique({
    where: { productId },
  });
  const hbStatus = !heartbeat
    ? "warning"
    : heartbeat.lastCollectionAt &&
        Date.now() - heartbeat.lastCollectionAt.getTime() < 8 * 60 * 60 * 1000
      ? "ok"
      : "error";
  checks.push({
    id: "heartbeat",
    label: "Heartbeat do agente",
    status: hbStatus,
    message: heartbeat?.lastCollectionAt
      ? `última coleta ${heartbeat.lastCollectionAt.toISOString()}`
      : "nunca coletou",
    hint: hbStatus === "error" ? "agente parado há >8h" : undefined,
  });

  const scheduler = getSchedulerStatus();
  const schedulerStarted = !!scheduler.nextRunAt;
  checks.push({
    id: "scheduler",
    label: "Scheduler global",
    status: schedulerStarted ? (scheduler.lastError ? "warning" : "ok") : "error",
    message: schedulerStarted
      ? scheduler.lastError || `próximo ciclo ${scheduler.nextRunAt}`
      : "não iniciado",
    hint: schedulerStarted
      ? undefined
      : "backend precisa subir com o scheduler ativo para coleta e automações acontecerem",
  });

  const waOk =
    !!notificationTransport.whatsappProvider &&
    !!notificationTransport.whatsappToken &&
    !!notificationTransport.whatsappPhone;
  checks.push({
    id: "whatsapp",
    label: "Notificações WhatsApp",
    status: waOk ? "ok" : "warning",
    message: waOk ? "configurado" : "não configurado",
    hint: waOk ? undefined : "alertas não vão chegar",
  });

  const errorCount = checks.filter(check => check.status === "error").length;
  const warningCount = checks.filter(check => check.status === "warning").length;
  const status: "ok" | "warning" | "error" =
    errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok";

  return {
    productId,
    status,
    errorCount,
    warningCount,
    checks,
  };
}
