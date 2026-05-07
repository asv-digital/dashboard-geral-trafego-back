// Notifier WhatsApp — provider Zappfy (com fallback z-api/evolution).
// Log global em NotificationLog. Não bloqueia se config estiver ausente.

import prisma from "../prisma";
import { getResolvedNotificationTransport } from "../lib/runtime-config";
import { shouldSendStateAlert } from "../lib/alert-dedup";

// M6 — dedup de auto_action: mesma acao no mesmo adset/entity nao dispara
// notificacao 2x em 1h. alert-dedup ja cobre alertas de estado estacionario,
// mas auto_action (pause/scale/rebalance) podia floodar quando agente roda
// 4x/dia + multiplos services tocavam o mesmo adset por motivos diferentes.
const AUTO_ACTION_DEDUP_TTL_MS = 60 * 60 * 1000;

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
    case "daily_summary": {
      // M5 — daily summary acionavel: KPIs + delta vs 7d + top adsets + top
      // criativos + top objection. Mantem compactacao pra caber em <2k chars.
      const lines: string[] = [];
      lines.push(`📊 *RESUMO DIÁRIO — ${data.productName || ""}*`);
      lines.push("");
      const fmtDelta = (d: string | null) => (d ? ` (${d} vs 7d)` : "");
      lines.push(`💰 Gasto: R$${data.spend}${fmtDelta(data.deltaSpend)}`);
      lines.push(`🛒 Vendas: ${data.sales}${fmtDelta(data.deltaSales)}`);
      lines.push(`📍 CPA: R$${data.cpa}${fmtDelta(data.deltaCpa)}`);
      lines.push(`📈 ROAS: ${data.roas}`);
      if (Array.isArray(data.topAdsets) && data.topAdsets.length > 0) {
        lines.push("");
        lines.push("🎯 *Top adsets:*");
        for (const a of data.topAdsets) lines.push(`• ${a}`);
      }
      if (Array.isArray(data.topCreatives) && data.topCreatives.length > 0) {
        lines.push("");
        lines.push("🎬 *Top criativos:*");
        for (const c of data.topCreatives) lines.push(`• ${c}`);
      }
      if (data.topObjection) {
        lines.push("");
        lines.push(`💬 Objeção dominante: ${data.topObjection}`);
      }
      lines.push("");
      lines.push(data.alerts ? `⚠️ ${data.alerts}` : "✅ Sem alertas");
      return lines.join("\n");
    }
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

  // M6 — dedup pra auto_action e auto_pause_breakeven (acoes que podem
  // disparar 2x se varios services tocarem o mesmo adset). Daily summary,
  // alert_critical e learning_phase_exit ja sao infrequentes ou edge-triggered.
  if (productId && (type === "auto_action" || type === "auto_pause_breakeven")) {
    const entityRef =
      (typeof data.entityId === "string" && data.entityId) ||
      (typeof data.adset === "string" && data.adset) ||
      (typeof data.entityName === "string" && data.entityName) ||
      "_unknown";
    const actionRef =
      (typeof data.action === "string" && data.action) ||
      (typeof data.type === "string" && data.type) ||
      type;
    const dedupKey = `wa:${type}:${entityRef}:${actionRef}`.slice(0, 200);
    const should = await shouldSendStateAlert(
      productId,
      dedupKey,
      "sent",
      AUTO_ACTION_DEDUP_TTL_MS
    );
    if (!should) {
      return { ok: false, skipped: true, error: "deduped_1h" };
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
