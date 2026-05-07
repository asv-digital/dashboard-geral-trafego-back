// Alertas de saude do sistema (D3 e amigos). Roda 1x/dia junto com daily-summary.
// Mantem WhatsApp informado de coisas que normalmente passariam despercebidas
// ate dar problema concreto.

import prisma from "../prisma";
import { getResolvedGlobalSettings } from "../lib/runtime-config";
import { shouldSendStateAlert } from "../lib/alert-dedup";
import { sendNotification } from "./whatsapp-notifier";

const META_TOKEN_LONG_LIVED_DAYS = 60;
const TOKEN_WARN_THRESHOLD_DAYS = 10;
const TOKEN_CRITICAL_THRESHOLD_DAYS = 3;

/**
 * D3 — alerta quando metaTokenCreatedAt + 60d esta proximo. Token Meta
 * long-lived expira em 60d e nao tem refresh automatico (apenas reissue
 * via Graph). Sem alerta, descobre quando coletor comeca a falhar 401.
 *
 * Edge-triggered:
 *   - Warn: <= 10 dias pra expirar
 *   - Critical: <= 3 dias pra expirar
 *   - Expired: ja venceu
 * Cada estado dispara 1x/24h enquanto persistir.
 */
export async function checkMetaTokenExpiry(): Promise<void> {
  const settings = await getResolvedGlobalSettings();
  if (!settings.metaAccessToken || !settings.metaTokenCreatedAt) return;

  const created = new Date(settings.metaTokenCreatedAt);
  if (isNaN(created.getTime())) return;

  const ageMs = Date.now() - created.getTime();
  const daysSinceCreated = ageMs / (1000 * 60 * 60 * 24);
  const daysToExpire = META_TOKEN_LONG_LIVED_DAYS - daysSinceCreated;

  let state: "ok" | "warn" | "critical" | "expired";
  if (daysToExpire <= 0) state = "expired";
  else if (daysToExpire <= TOKEN_CRITICAL_THRESHOLD_DAYS) state = "critical";
  else if (daysToExpire <= TOKEN_WARN_THRESHOLD_DAYS) state = "warn";
  else state = "ok";

  if (state === "ok") return;

  // Pega 1 produto pra anexar o alert (precisa productId no schema). Usa o
  // primeiro ativo — alert e global mas precisa de FK valida.
  const anyProduct = await prisma.product.findFirst({
    where: { status: "active" },
    select: { id: true },
  });
  if (!anyProduct) return;

  const should = await shouldSendStateAlert(
    anyProduct.id,
    "meta_token_expiry",
    state,
    24 * 60 * 60 * 1000
  );
  if (!should) return;

  const detail =
    state === "expired"
      ? `Token Meta venceu ha ${Math.abs(Math.round(daysToExpire))} dias. Coletor nao funciona ate trocar.`
      : state === "critical"
        ? `Token Meta vence em ${Math.ceil(daysToExpire)} dias. Trocar HOJE.`
        : `Token Meta vence em ${Math.ceil(daysToExpire)} dias.`;

  await sendNotification(
    "alert_critical",
    {
      type: state === "expired" ? "TOKEN META VENCIDO" : "TOKEN META EXPIRANDO",
      detail,
      action: "Gerar novo token long-lived em developers.facebook.com → atualizar em /settings",
    },
    anyProduct.id
  );
}

export async function runSystemHealthChecks(): Promise<void> {
  try {
    await checkMetaTokenExpiry();
  } catch (err) {
    console.error(
      `[system-alerts] checkMetaTokenExpiry falhou: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
