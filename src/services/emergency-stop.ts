// Freio de Mão — botão de emergência que para o agente de mexer na campanha.
// Faz tudo de uma vez:
//   1. seta supervisedMode=true (agente para de fazer pause/scale automatico)
//   2. pausa todas as campanhas whitelisted no Meta Ads (via API)
//   3. log emergency_stop no ActionLog
//   4. dispara WhatsApp critical
//
// Reverter: gestor desliga supervisedMode em /config + ativa campanhas
// manualmente no Meta Ads Manager.

import prisma from "../prisma";
import { logAction } from "./action-log";
import { sendNotification } from "./whatsapp-notifier";
import { pauseCampaign } from "../lib/meta-mutations";

export interface EmergencyStopResult {
  productId: string;
  supervisedModeSet: boolean;
  campaignsPaused: number;
  campaignsFailed: number;
  notificationSent: boolean;
}

export async function executeEmergencyStop(
  productId: string,
  initiatedBy?: string
): Promise<EmergencyStopResult> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw new Error(`product not found: ${productId}`);
  }

  // 1. Liga supervisedMode (impede agente de mexer)
  await prisma.product.update({
    where: { id: productId },
    data: { supervisedMode: true },
  });

  // 2. Pausa todas as campanhas whitelisted ativas no Meta
  const campaigns = await prisma.campaign.findMany({
    where: {
      productId,
      status: "Ativa",
      metaCampaignId: { not: null },
    },
  });
  let paused = 0;
  let failed = 0;
  for (const c of campaigns) {
    if (!c.metaCampaignId) continue;
    try {
      const ok = await pauseCampaign(c.metaCampaignId);
      if (ok) {
        await prisma.campaign.update({
          where: { id: c.id },
          data: { status: "Pausada" },
        });
        paused += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      console.error(`[emergency-stop] pauseCampaign ${c.metaCampaignId} falhou:`, err);
      failed += 1;
    }
  }

  // 3. ActionLog
  await logAction({
    productId,
    action: "manual_emergency_stop",
    entityType: "product",
    entityId: productId,
    entityName: product.name,
    details: `${paused} campanhas pausadas, ${failed} falharam. supervisedMode ON.`,
    reasoning: `Freio de mão acionado pelo gestor${initiatedBy ? ` (${initiatedBy})` : ""}. Agente impedido de fazer pause/scale automatico ate supervisedMode=false. Reverter: ativar campanhas manualmente no Meta + desligar supervisedMode em /config.`,
    inputSnapshot: { campaignsTotal: campaigns.length, paused, failed },
    source: "dashboard",
  });

  // 4. WhatsApp alerta critico
  let notified = false;
  try {
    await sendNotification(
      "alert_critical",
      {
        type: "🛑 FREIO DE MÃO ACIONADO",
        detail: `${product.name}: agente em supervisedMode + ${paused} campanhas pausadas no Meta.`,
        action: "Reverter: ativar campanhas no Meta + desligar supervisedMode em /config.",
      },
      productId
    );
    notified = true;
  } catch (err) {
    console.error(`[emergency-stop] WhatsApp falhou:`, err);
  }

  return {
    productId,
    supervisedModeSet: true,
    campaignsPaused: paused,
    campaignsFailed: failed,
    notificationSent: notified,
  };
}
