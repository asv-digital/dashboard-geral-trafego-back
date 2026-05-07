// Campaign planner product-aware.
//
// Fluxo:
//   1. valida preflight + conta ativa + assets suficientes
//   2. escolhe estrutura baseada em product.stage (playbook)
//   3. opcionalmente gera variações de copy via Claude (se ANTHROPIC_API_KEY)
//   4. cria Campaign → AdSet → AdCreative → Ad no Meta
//   5. salva Campaign no banco com metaCampaignId (whitelist) + isInLearningPhase
//   6. registra AgentDecision com reasoning completo
//
// Nunca cria automaticamente — este é o ponto de partida manual:
// frontend tem botão "planejar campanhas" que chama esta função.

import prisma from "../prisma";
import { ensureAccountActive } from "../lib/meta-account";
import {
  createCampaign,
  createAdset,
  createAdCreative,
  createAd,
} from "../lib/meta-create";
import {
  activateCampaign,
  activateAdset,
  pauseAdset,
  pauseCampaign,
} from "../lib/meta-mutations";
import {
  buildPlannerPlaybook,
  resolvePlaybookAudienceTargets,
  type PlannerPlaybookCampaign,
  type StrategyStage,
} from "../lib/planner-playbook";
import { logAction } from "./action-log";
import { uploadAssetToMeta } from "./content-ingest";
import { complete, isLLMConfigured } from "../lib/llm";
import {
  getResolvedGlobalSettings,
  getResolvedProductMetaSettings,
} from "../lib/runtime-config";
import type { PreflightCheckResult } from "./preflight-checks";
import { runPreflightChecks } from "./preflight-checks";

type PlannedCampaign = PlannerPlaybookCampaign;
interface LaunchMediaAsset {
  id: string;
  type: string;
  name: string;
  metaMediaId: string | null;
  originalUrl: string | null;
}

async function resolvePlaybookAudiences(
  productId: string,
  playbook: PlannedCampaign[],
  targetBudget: number
): Promise<{ planned: PlannedCampaign[]; warnings: string[] }> {
  const globalSettings = await getResolvedGlobalSettings();
  const availableLookalikes = await prisma.lookalikeAudience.findMany({
    where: {
      productId,
      status: { in: ["created", "active"] },
      metaAudienceId: { not: null },
      percentage: { lte: 3 },
    },
    orderBy: [{ buyerCountAtCreation: "desc" }, { percentage: "asc" }],
  });

  const selectedLookalike = availableLookalikes.find(item => !!item.metaAudienceId);
  const warmAudienceId = globalSettings.metaAudienceWarmId;
  const warmAudienceName = globalSettings.metaAudienceWarmName;

  return resolvePlaybookAudienceTargets(
    playbook,
    {
      lookalike: selectedLookalike?.metaAudienceId
        ? { id: selectedLookalike.metaAudienceId, name: selectedLookalike.name }
        : null,
      warmAudience: warmAudienceId
        ? { id: warmAudienceId, name: warmAudienceName }
        : null,
    },
    targetBudget
  );
}

function pickTextAsset(
  assets: Array<{ content: string | null }>,
  index: number
): string | null {
  if (assets.length === 0) return null;
  return assets[index % assets.length]?.content?.trim() || null;
}

function limitText(value: string | null | undefined, max: number): string {
  return (value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function prepareMediaAssetsForLaunch(
  candidates: LaunchMediaAsset[],
  warnings: string[],
  limit = 3
): Promise<LaunchMediaAsset[]> {
  const prepared: LaunchMediaAsset[] = [];

  for (const candidate of candidates) {
    let current = candidate;
    if (!current.metaMediaId) {
      const sync = await uploadAssetToMeta(current.id);
      const refreshed = await prisma.productAsset.findUnique({
        where: { id: current.id },
        select: {
          id: true,
          type: true,
          name: true,
          metaMediaId: true,
          originalUrl: true,
        },
      });

      if (!sync.ok || !refreshed?.metaMediaId) {
        warnings.push(
          `${candidate.name}: mídia ainda não sincronizou com o Meta (${sync.error || "erro desconhecido"}).`
        );
        continue;
      }

      current = refreshed;
    }

    prepared.push(current);
    if (prepared.length >= limit) break;
  }

  return prepared;
}

async function generateCopyVariations(
  product: {
    name: string;
    defaultHeadline: string;
    defaultDescription: string | null;
    defaultCTA: string;
  },
  plan: PlannedCampaign
): Promise<{ headline: string; primaryText: string; description: string } | null> {
  if (!(await isLLMConfigured())) return null;
  try {
    const system = `Você é um copywriter de Meta Ads focado em resposta direta. Escreva em português brasileiro, sem clickbait, com promessa especifica, clareza de beneficio, prova quando fizer sentido e CTA objetivo. Diferencie mensagem de publico frio vs remarketing.`;
    const user = `Produto: "${product.name}".
Campanha: "${plan.name}".
Tipo: ${plan.type}.
Funil: ${plan.funnelStage || "cold"}.
Angulo de copy: ${plan.copyAngle || "beneficio + CTA"}.
Objetivo estratégico: ${plan.objective || "vender com clareza"}.
Nota estratégica: ${plan.strategyNote || "sem nota adicional"}.
Headline base atual: "${product.defaultHeadline}".
${product.defaultDescription ? `Descricao base atual: "${product.defaultDescription}".` : ""}
CTA padrao: ${product.defaultCTA}.

Regras:
- Se for publico frio, use gancho claro, dor/problema ou mecanismo e beneficio concreto.
- Se for remarketing, use prova, objecao, urgencia leve ou fechamento.
- Se for ASC/escala, mantenha a mensagem simples, ampla e forte.
- Nao use claims milagrosas, clickbait ou promessas vagas.
- Retorne so 1 variacao concisa e usavel em anuncio.

Retorne APENAS um JSON (sem markdown) com os campos:
{"headline": "<até 40 chars>", "primaryText": "<até 125 chars>", "description": "<até 30 chars>"}`;
    const text = await complete({ system, user, maxTokens: 400, temperature: 0.8 });
    const cleaned = text.trim().replace(/^```json\s*/, "").replace(/^```\s*/, "").replace(/\s*```$/, "");
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("[campaign-planner] geração de copy falhou:", err);
    return null;
  }
}

export interface PlanResult {
  ok: boolean;
  dryRun: boolean;
  planned: PlannedCampaign[];
  created?: Array<{
    name: string;
    metaCampaignId: string;
    dbCampaignId: string;
    status: "Ativa" | "Pausada";
    adsCreated: number;
  }>;
  failed?: Array<{ name: string; reason: string; metaCampaignId?: string }>;
  warnings?: string[];
  preflight?: PreflightCheckResult;
  error?: string;
}

/**
 * Planeja campanhas para um produto baseado no stage.
 * Se dryRun=true, apenas retorna o plano sem criar no Meta.
 */
export async function planCampaignsForProduct(
  productId: string,
  dryRun = true
): Promise<PlanResult> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { automationConfig: true },
  });
  if (!product) return { ok: false, dryRun, planned: [], error: "product_not_found" };
  const preflight = await runPreflightChecks(productId);

  const readyAssets = await prisma.productAsset.findMany({
    where: {
      productId,
      status: { in: ["uploaded", "ready"] },
      type: { in: ["video", "image", "copy", "headline", "hook"] },
    },
  });
  const mediaAssetCandidates = readyAssets.filter(
    asset =>
      (asset.type === "video" || asset.type === "image") && !!asset.originalUrl
  );
  const readyCopyAssets = readyAssets.filter(
    asset => asset.type === "copy" && asset.status === "ready" && !!asset.content
  );
  const readyHeadlineAssets = readyAssets.filter(
    asset => asset.type === "headline" && asset.status === "ready" && !!asset.content
  );
  const readyHookAssets = readyAssets.filter(
    asset => asset.type === "hook" && asset.status === "ready" && !!asset.content
  );

  if (mediaAssetCandidates.length === 0) {
    return {
      ok: false,
      dryRun,
      planned: [],
      error: "no_ready_assets",
      preflight: preflight || undefined,
    };
  }

  const stage = product.stage as StrategyStage;
  const resolved = await resolvePlaybookAudiences(
    productId,
    buildPlannerPlaybook(stage, product.dailyBudgetTarget),
    product.dailyBudgetTarget
  );
  const playbook = resolved.planned;
  const playbookWarnings = [...resolved.warnings];
  const pendingMediaSync = mediaAssetCandidates.filter(asset => !asset.metaMediaId).length;
  if (pendingMediaSync > 0) {
    playbookWarnings.push(
      `${pendingMediaSync} mídia(s) ainda sem metaMediaId; o launch vai tentar sincronizar automaticamente antes de criar os anúncios.`
    );
  }

  if (playbook.length === 0) {
    return {
      ok: false,
      dryRun,
      planned: [],
      warnings: playbookWarnings,
      preflight: preflight || undefined,
      error: "no_launchable_playbook",
    };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      planned: playbook,
      warnings: playbookWarnings,
      preflight: preflight || undefined,
    };
  }

  if (preflight?.status === "error") {
    return {
      ok: false,
      dryRun: false,
      planned: playbook,
      preflight,
      error: "preflight_failed",
    };
  }

  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    return {
      ok: false,
      dryRun,
      planned: playbook,
      preflight: preflight || undefined,
      error: `account_${gate.status?.status_key}: ${gate.reason}`,
    };
  }

  // Cria tudo no Meta
  const metaConfig = await getResolvedProductMetaSettings(product);
  const adAccountId = metaConfig.adAccountId;
  const pixelId = metaConfig.pixelId;
  const pageId = metaConfig.pageId;
  if (!adAccountId || !pixelId || !pageId) {
    return {
      ok: false,
      dryRun: false,
      planned: playbook,
      preflight: preflight || undefined,
      error: "missing_meta_config",
    };
  }

  const created: Array<{
    name: string;
    metaCampaignId: string;
    dbCampaignId: string;
    status: "Ativa" | "Pausada";
    adsCreated: number;
  }> = [];
  const failed: Array<{ name: string; reason: string; metaCampaignId?: string }> = [];
  const warnings: string[] = [...playbookWarnings];

  for (const plan of playbook) {
    let metaCampaignId: string | undefined;
    let metaAdsetId: string | undefined;
    let dbCampaignId: string | undefined;
    const fullName = `[${product.slug.toUpperCase()}] ${plan.name} — ${new Date()
      .toISOString()
      .slice(0, 10)}`;
    try {
      // 1. Campaign — ASC nativo quando playbook marca usesAdvantage.
      // Sem smart_promotion_type, "ASC" era so OUTCOME_SALES com placements
      // automaticos (heuristica frouxa). Agora Meta cria campanha gerida por
      // IA (audiencia + criativo + placement automatizados).
      const camp = await createCampaign({
        adAccountId,
        name: fullName,
        objective: "OUTCOME_SALES",
        status: "PAUSED",
        smartPromotionType: plan.usesAdvantage ? "AUTOMATED_SHOPPING_ADS" : undefined,
      });
      metaCampaignId = camp.id;

      // M3 — exclusion automatica de buyers em prospeccao/remarketing
      // (ASC ja gerencia "existing customer cap" sozinho). Sem isso, o
      // agente paga pra reentregar pra quem ja comprou.
      const buyersAudienceId = metaConfig.audienceBuyersId;
      const existingExclusions =
        ((plan.targeting as Record<string, unknown>).excluded_custom_audiences as
          | Array<{ id: string }>
          | undefined) || [];
      const targetingWithExclusion =
        buyersAudienceId && !plan.usesAdvantage
          ? {
              ...plan.targeting,
              excluded_custom_audiences: [
                ...existingExclusions.filter(e => e.id !== buyersAudienceId),
                { id: buyersAudienceId },
              ],
            }
          : plan.targeting;

      // 2. AdSet
      const adset = await createAdset({
        adAccountId,
        campaignId: camp.id,
        name: `${plan.name} — adset`,
        dailyBudgetReais: plan.dailyBudget,
        targeting: targetingWithExclusion,
        optimizationGoal: plan.optimizationGoal,
        pixelId,
        customEventType: "PURCHASE",
        status: "PAUSED",
      });
      metaAdsetId = adset.id;

      // 3. AdCreatives — limita diversidade sem fragmentar demais a aprendizagem.
      const assetsToUse = await prepareMediaAssetsForLaunch(
        mediaAssetCandidates,
        warnings,
        plan.creativeSlotLimit || 3
      );
      const generatedCopy =
        readyCopyAssets.length > 0 || readyHeadlineAssets.length > 0 || readyHookAssets.length > 0
          ? null
          : await generateCopyVariations(product, plan);
      const launchedCreatives: Array<{ asset: typeof assetsToUse[number]; creativeName: string }> = [];

      for (let i = 0; i < assetsToUse.length; i++) {
        const asset = assetsToUse[i];
        if (!asset.metaMediaId) continue;
        const creativeName = `${plan.name} — creative ${i + 1}`;
        const assetHeadline =
          pickTextAsset(readyHeadlineAssets, i) || generatedCopy?.headline || product.defaultHeadline;
        const assetBody =
          pickTextAsset(readyCopyAssets, i) ||
          generatedCopy?.primaryText ||
          product.defaultDescription ||
          product.defaultHeadline;
        const assetHook = pickTextAsset(readyHookAssets, i);
        const headline = limitText(assetHeadline, 40) || product.defaultHeadline;
        const primaryText =
          limitText([assetHook, assetBody].filter(Boolean).join(" "), 220) ||
          product.defaultHeadline;
        const description = limitText(
          generatedCopy?.description || product.defaultDescription || "",
          60
        );

        const creative = await createAdCreative({
          adAccountId,
          name: creativeName,
          pageId,
          linkUrl: product.landingUrl,
          headline,
          primaryText,
          description,
          ctaType: product.defaultCTA,
          videoId: asset.type === "video" ? asset.metaMediaId : undefined,
          imageHash: asset.type === "image" ? asset.metaMediaId : undefined,
        });

        await createAd({
          adAccountId,
          name: `${plan.name} — ad ${i + 1}`,
          adsetId: adset.id,
          creativeId: creative.id,
          status: "PAUSED",
        });

        // Marca o asset como linkado a este creative
        await prisma.productAsset.update({
          where: { id: asset.id },
          data: { metaCreativeId: creative.id },
        });

        launchedCreatives.push({ asset, creativeName });
      }

      if (launchedCreatives.length === 0) {
        throw new Error("no_ads_created");
      }

      // 4. Auto-activate se o produto pediu
      let finalStatus: "Ativa" | "Pausada" = "Pausada";
      if (product.autoActivate) {
        const adsetActivated = await activateAdset(adset.id);
        const campaignActivated = await activateCampaign(camp.id);
        if (adsetActivated && campaignActivated) {
          finalStatus = "Ativa";
        } else {
          warnings.push(`${fullName}: autoActivate falhou, campanha ficou pausada.`);
        }
      }

      // 5. Salva no banco com whitelist + learning phase
      const learningHours = product.automationConfig?.learningPhaseHours || 72;
      const dbCampaign = await prisma.campaign.create({
        data: {
          productId,
          name: fullName,
          type: plan.type,
          isASC: !!plan.usesAdvantage,
          audience: plan.audience,
          dailyBudget: plan.dailyBudget,
          startDate: new Date(),
          status: finalStatus,
          metaCampaignId: camp.id,
          createdInMetaAt: new Date(),
          learningPhaseEnd: new Date(Date.now() + learningHours * 60 * 60 * 1000),
          isInLearningPhase: true,
        },
      });
      dbCampaignId = dbCampaign.id;

      for (const launched of launchedCreatives) {
        try {
          await prisma.creative.create({
            data: {
              productId,
              campaignId: dbCampaign.id,
              name: launched.creativeName,
              type: launched.asset.type,
              status: "active",
            },
          });
        } catch (creativeErr) {
          warnings.push(
            `${fullName}: criativo "${launched.creativeName}" foi criado no Meta, mas o vínculo local falhou.`
          );
          console.error("[planner] falha ao salvar creative local:", creativeErr);
        }
      }

      created.push({
        name: fullName,
        metaCampaignId: camp.id,
        dbCampaignId: dbCampaign.id,
        status: finalStatus,
        adsCreated: launchedCreatives.length,
      });

      try {
        await logAction({
          productId,
          action: "campaign_planned",
          entityType: "campaign",
          entityId: camp.id,
          entityName: fullName,
          details: `playbook=${stage} tipo=${plan.type} budget=R$${plan.dailyBudget} assets=${assetsToUse.length} status=${finalStatus}`,
          source: "system",
          reasoning: `Playbook "${stage}" para produto no estágio ${stage}: criou ${plan.type} com budget R$${plan.dailyBudget}/dia (${Math.round((plan.dailyBudget / product.dailyBudgetTarget) * 100)}% do target). Objetivo: ${plan.objective || "gerar vendas com eficiência"}. Ângulo de copy: ${plan.copyAngle || "benefício + CTA"}. Nota estratégica: ${plan.strategyNote || "sem nota adicional"}. Usou ${assetsToUse.length} criativo(s) de mídia e ${readyCopyAssets.length + readyHeadlineAssets.length + readyHookAssets.length} asset(s) textuais como insumo. ${finalStatus === "Ativa" ? "Ativada automaticamente (autoActivate=true)." : "Pausada — humano revisa antes de ativar."}`,
          inputSnapshot: {
            stage,
            dailyBudgetTarget: product.dailyBudgetTarget,
            plan,
            assetsUsed: assetsToUse.length,
            textAssetsUsed:
              readyCopyAssets.length + readyHeadlineAssets.length + readyHookAssets.length,
            autoActivate: product.autoActivate,
          },
        });
      } catch (logErr) {
        warnings.push(`${fullName}: campanha criada, mas o log detalhado do launch falhou.`);
        console.error("[planner] falha ao registrar campaign_planned:", logErr);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[planner] falha em ${plan.name}:`, err);

      if (metaAdsetId) {
        const pausedAdset = await pauseAdset(metaAdsetId);
        if (!pausedAdset) {
          warnings.push(`${fullName}: falha ao pausar o adset parcial no Meta após erro.`);
        }
      }

      if (metaCampaignId) {
        const pausedCampaign = await pauseCampaign(metaCampaignId);
        if (!pausedCampaign) {
          warnings.push(`${fullName}: falha ao pausar a campanha parcial no Meta após erro.`);
        }

        try {
          if (dbCampaignId) {
            await prisma.campaign.update({
              where: { id: dbCampaignId },
              data: {
                status: "Arquivada",
                isInLearningPhase: false,
                learningPhaseEnd: null,
              },
            });
          } else {
            const failedCampaign = await prisma.campaign.create({
              data: {
                productId,
                name: `${fullName} [FAILED LAUNCH]`,
                type: plan.type,
                audience: plan.audience,
                dailyBudget: plan.dailyBudget,
                startDate: new Date(),
                status: "Arquivada",
                metaCampaignId,
                createdInMetaAt: new Date(),
                isInLearningPhase: false,
              },
            });
            dbCampaignId = failedCampaign.id;
          }

          warnings.push(
            `${fullName}: launch falhou e a campanha parcial foi arquivada para auditoria.`
          );
        } catch (trackingErr) {
          warnings.push(
            `${fullName}: launch falhou e não consegui registrar a campanha parcial no banco.`
          );
          console.error("[planner] falha ao rastrear campanha parcial:", trackingErr);
        }
      }

      failed.push({
        name: plan.name,
        reason,
        metaCampaignId,
      });
      await logAction({
        productId,
        action: "campaign_plan_failed",
        entityType: "campaign",
        entityName: plan.name,
        details: reason,
        source: "system",
        reasoning: `Tentou criar ${plan.type} mas o fluxo não concluiu: ${reason}`,
      });
    }
  }

  return {
    ok: failed.length === 0,
    dryRun: false,
    planned: playbook,
    created,
    failed: failed.length > 0 ? failed : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    preflight: preflight || undefined,
    error: failed.length > 0 && created.length === 0 ? "planner_failed" : undefined,
  };
}
