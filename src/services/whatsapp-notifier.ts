// Notifier WhatsApp — provider Zappfy (com fallback z-api/evolution).
// Log global em NotificationLog. Não bloqueia se config estiver ausente.

import prisma from "../prisma";
import { getResolvedNotificationTransport } from "../lib/runtime-config";

export type NotificationType =
  | "alert_critical"
  | "auto_action"
  | "auto_pause_breakeven"
  | "creative"
  | "learning_phase_exit"
  | "daily_summary"
  | "comment_alert";

export interface NotificationPayload {
  [key: string]: any;
}

export interface NotificationDispatchResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

function formatMessage(type: NotificationType, data: NotificationPayload): string {
  switch (type) {
    case "alert_critical":
      return `🚨 *${data.type || "ALERTA"}*\n\n${data.detail || ""}\n\n${data.action ? `➤ ${data.action}` : ""}`;
    case "auto_action":
      return `🤖 *${data.action || "AÇÃO AUTOMÁTICA"}*\n\n${data.adset || ""}\n${data.reason || ""}`;
    case "auto_pause_breakeven":
      return `⚠️ *PAUSA BREAKEVEN*\n\n${data.adset || ""}\nCPA médio R$${data.avg_cpa} > breakeven R$${data.breakeven}\n${data.days} dias consecutivos\nPrejuízo estimado: R$${data.loss}`;
    case "creative":
      return `🎬 *CRIATIVO*\n\n${data.message || ""}`;
    case "learning_phase_exit":
      return `✅ *FASE DE APRENDIZADO FINALIZADA*\n\n${data.campaign || ""}\nCampanha saiu da learning phase.`;
    case "daily_summary":
      return `📊 *RESUMO DIÁRIO — ${data.productName || ""}*\n\nGasto: R$${data.spend}\nVendas: ${data.sales}\nCPA: R$${data.cpa}\nROAS: ${data.roas}x\n\n${data.alerts ? `⚠️ ${data.alerts}` : "Sem alertas"}`;
    case "comment_alert":
      return `💬 *COMENTÁRIOS*\n\n${data.message || ""}`;
    default:
      return JSON.stringify(data);
  }
}

async function getConfig() {
  return prisma.notificationConfig.findUnique({ where: { id: "singleton" } });
}

async function sendViaProvider(message: string): Promise<{ ok: boolean; error?: string }> {
  const transport = await getResolvedNotificationTransport();
  const provider = transport.whatsappProvider;
  const instanceId = transport.whatsappInstanceId;
  const token = transport.whatsappToken;
  const phone = transport.whatsappPhone;

  if (!token || !phone) {
    return { ok: false, error: "whatsapp não configurado" };
  }

  try {
    if (provider === "zappfy") {
      const res = await fetch(`https://api.zappfy.app.br/api/chat/send/text/${instanceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ phone, message }),
      });
      if (!res.ok) return { ok: false, error: `zappfy http ${res.status}` };
      return { ok: true };
    }

    if (provider === "z-api") {
      const res = await fetch(`https://api.z-api.io/instances/${instanceId}/token/${token}/send-text`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, message }),
      });
      if (!res.ok) return { ok: false, error: `z-api http ${res.status}` };
      return { ok: true };
    }

    if (provider === "evolution") {
      const res = await fetch(`${process.env.EVOLUTION_URL || ""}/message/sendText/${instanceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: token },
        body: JSON.stringify({ number: phone, text: message }),
      });
      if (!res.ok) return { ok: false, error: `evolution http ${res.status}` };
      return { ok: true };
    }

    return { ok: false, error: `provider desconhecido: ${provider}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function sendNotification(
  type: NotificationType,
  data: NotificationPayload,
  productId?: string
): Promise<NotificationDispatchResult> {
  const config = await getConfig();
  if (config && !config.enabled) {
    return { ok: false, skipped: true, error: "notifications_disabled" };
  }

  // filtro por tipo
  if (config) {
    if (type === "auto_action" && !config.notifyAutoActions) {
      return { ok: false, skipped: true, error: "auto_actions_disabled" };
    }
    if (type === "creative" && !config.notifyCreativeActions) {
      return { ok: false, skipped: true, error: "creative_notifications_disabled" };
    }
    if (type === "learning_phase_exit" && !config.notifyLearningPhase) {
      return { ok: false, skipped: true, error: "learning_phase_notifications_disabled" };
    }
    if (type === "alert_critical" && !config.notifyAlerts) {
      return { ok: false, skipped: true, error: "alert_notifications_disabled" };
    }
    if (type === "daily_summary" && !config.notifyDailySummary) {
      return { ok: false, skipped: true, error: "daily_summary_disabled" };
    }
  }

  const message = formatMessage(type, data);
  const result = await sendViaProvider(message);

  try {
    await prisma.notificationLog.create({
      data: {
        productId,
        type,
        message,
        channel: "whatsapp",
        status: result.ok ? "sent" : "failed",
        error: result.error,
      },
    });
  } catch (err) {
    console.error("[notifier] falha ao salvar log:", err);
  }

  return {
    ok: result.ok,
    error: result.error,
  };
}
