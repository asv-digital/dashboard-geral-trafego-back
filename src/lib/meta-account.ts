// Single source of truth for Meta ad account status.
// Fonte canônica é a Graph API — NUNCA inferir de budget, spend ou outras
// métricas indiretas. Cache de 60s pra não bater limit.
//
// Compartilhado entre produtos: a conta é a mesma (act_302460482454804) pra
// todos. Se um dia virar multi-ad-account, tornar esta função receber
// accountId como parâmetro.

import { getResolvedGlobalSettings } from "./runtime-config";

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;
const CACHE_TTL_MS = 60 * 1000;

const STATUS_CODES: Record<number, { key: string; active: boolean; message: string }> = {
  1: { key: "active", active: true, message: "Conta ativa e liberada para rodar anúncios." },
  2: { key: "disabled", active: false, message: "Conta desabilitada. Verifique pagamento, faturas ou políticas violadas." },
  3: { key: "unsettled", active: false, message: "Pagamento pendente. Quite a fatura no Meta Billing." },
  7: { key: "pending_risk_review", active: false, message: "Conta em análise de risco pelo Meta." },
  8: { key: "pending_settlement", active: false, message: "Pagamento em processamento." },
  9: { key: "in_grace_period", active: true, message: "Conta em período de carência — ainda roda, mas pagamento pendente." },
  100: { key: "pending_closure", active: false, message: "Conta agendada pra fechar." },
  101: { key: "closed", active: false, message: "Conta fechada." },
  201: { key: "any_active", active: true, message: "Qualquer status ativo." },
  202: { key: "any_closed", active: false, message: "Qualquer status fechado." },
};

export interface AccountStatusResult {
  ok: boolean;
  status_code: number | null;
  status_key: string;
  active: boolean;
  message: string;
  disable_reason?: number | null;
  name?: string | null;
  currency?: string | null;
  checked_at: string;
  source: "meta_api" | "cache" | "error";
  error?: string;
}

let cached: AccountStatusResult | null = null;
let cachedAt = 0;

export function clearAccountStatusCache(): void {
  cached = null;
  cachedAt = 0;
}

export async function getAccountStatus(forceRefresh = false): Promise<AccountStatusResult> {
  const now = Date.now();
  if (!forceRefresh && cached && now - cachedAt < CACHE_TTL_MS) {
    return { ...cached, source: "cache" };
  }

  const settings = await getResolvedGlobalSettings();
  const token = settings.metaAccessToken;
  const account = settings.metaAdAccountId;

  if (!token || !account) {
    const result: AccountStatusResult = {
      ok: false,
      status_code: null,
      status_key: "not_configured",
      active: false,
      message: "Meta access token ou ad account não configurados.",
      checked_at: new Date().toISOString(),
      source: "error",
      error: "missing_env",
    };
    cached = result;
    cachedAt = now;
    return result;
  }

  try {
    const url = `${META_BASE}/${account}?fields=account_status,disable_reason,name,currency&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    const data = (await res.json()) as any;

    if (data.error) {
      const result: AccountStatusResult = {
        ok: false,
        status_code: null,
        status_key: "api_error",
        active: false,
        message: `Meta API error: ${data.error.message}`,
        checked_at: new Date().toISOString(),
        source: "error",
        error: data.error.message,
      };
      cached = result;
      cachedAt = now;
      return result;
    }

    const code = typeof data.account_status === "number" ? data.account_status : null;
    const info = code !== null && STATUS_CODES[code] ? STATUS_CODES[code] : null;

    const result: AccountStatusResult = {
      ok: true,
      status_code: code,
      status_key: info?.key ?? "unknown",
      active: info?.active ?? false,
      message: info?.message ?? `Status desconhecido (code=${code}).`,
      disable_reason: typeof data.disable_reason === "number" ? data.disable_reason : null,
      name: data.name ?? null,
      currency: data.currency ?? null,
      checked_at: new Date().toISOString(),
      source: "meta_api",
    };

    cached = result;
    cachedAt = now;
    return result;
  } catch (err) {
    const result: AccountStatusResult = {
      ok: false,
      status_code: null,
      status_key: "fetch_error",
      active: false,
      message: `Falha ao consultar Meta API: ${(err as Error).message}`,
      checked_at: new Date().toISOString(),
      source: "error",
      error: (err as Error).message,
    };
    cached = result;
    cachedAt = now;
    return result;
  }
}

/**
 * Gate para operações que alteram estado no Meta.
 * Retorna { allowed: false, reason } se a conta não está ativa.
 */
export async function ensureAccountActive(): Promise<{
  allowed: boolean;
  reason?: string;
  status?: AccountStatusResult;
}> {
  const status = await getAccountStatus();
  if (!status.active) {
    return {
      allowed: false,
      reason: `Ad account ${status.status_key}: ${status.message}`,
      status,
    };
  }
  return { allowed: true, status };
}
