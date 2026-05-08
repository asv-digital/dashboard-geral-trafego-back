import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { getAccountStatus } from "../lib/meta-account";
import {
  getResolvedGlobalSettings,
  getResolvedNotificationTransport,
} from "../lib/runtime-config";
import { checkStorageHealth } from "../lib/storage";
import { getSchedulerStatus } from "../agent/scheduler";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const startTime = Date.now();
  const components: Record<string, Record<string, unknown>> = {};
  const [globalSettings, notificationTransport, storageHealth] = await Promise.all([
    getResolvedGlobalSettings(),
    getResolvedNotificationTransport(),
    checkStorageHealth(),
  ]);

  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    components.database = { status: "ok", latency_ms: Date.now() - dbStart };
  } catch (err) {
    components.database = { status: "error", error: (err as Error).message };
  }

  const metaToken = globalSettings.metaAccessToken;
  const metaCreatedAt = globalSettings.metaTokenCreatedAt;
  let tokenDaysRemaining = -1;
  if (metaCreatedAt) {
    const expires = new Date(metaCreatedAt);
    expires.setDate(expires.getDate() + 60);
    tokenDaysRemaining = Math.floor((expires.getTime() - Date.now()) / 86400000);
  }
  components.meta_api = {
    status: metaToken
      ? tokenDaysRemaining > 7
        ? "ok"
        : tokenDaysRemaining > 0
          ? "warning"
          : "error"
      : "not_configured",
    token_expires_in_days: tokenDaysRemaining,
  };

  const account = await getAccountStatus();
  components.ad_account = {
    status: account.active ? "ok" : "error",
    status_key: account.status_key,
    message: account.message,
  };

  components.kirvano_webhook = {
    status: globalSettings.kirvanoWebhookToken ? "ok" : "not_configured",
  };

  components.anthropic = {
    status: globalSettings.anthropicApiKey ? "ok" : "not_configured",
  };

  components.whatsapp = {
    status:
      notificationTransport.whatsappToken && notificationTransport.whatsappPhone
        ? "ok"
        : "not_configured",
  };

  const scheduler = getSchedulerStatus();
  const schedulerLastRunAt = scheduler.lastRunAt ? new Date(scheduler.lastRunAt) : null;
  const schedulerStaleMs = scheduler.runIntervalMinutes * 2 * 60 * 1000;
  components.scheduler = {
    status: !scheduler.nextRunAt
      ? "error"
      : scheduler.lastError
        ? "warning"
        : schedulerLastRunAt && Date.now() - schedulerLastRunAt.getTime() > schedulerStaleMs
          ? "error"
          : "ok",
    message: !scheduler.nextRunAt
      ? "scheduler não iniciado"
      : scheduler.lastError
        ? scheduler.lastError
        : scheduler.lastRunAt
          ? `último ciclo ${scheduler.lastRunAt}`
          : `aguardando primeiro ciclo; próximo em ${scheduler.nextRunAt}`,
  };

  components.storage = {
    status: storageHealth.ok ? "ok" : "error",
    message: storageHealth.message,
    error: storageHealth.error,
  };

  const overallStatus = Object.values(components).some(c => c.status === "error")
    ? "critical"
    : Object.values(components).some(c => c.status === "warning")
      ? "degraded"
      : "healthy";

  res.json({
    status: overallStatus,
    components,
    uptime_ms: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    version: "v2-phase-0",
  });
});

// /health/meta-diagnose
// Diagnostico profundo do token Meta. Retorna scopes, status da conta,
// pessoas com acesso, e se token consegue escrever (POST). Nao expoe o token.
const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

router.get("/meta-diagnose", async (_req: Request, res: Response) => {
  const settings = await getResolvedGlobalSettings();
  const token = settings.metaAccessToken;
  const account = settings.metaAdAccountId;
  if (!token || !account) {
    res.status(412).json({ error: "missing_token_or_account" });
    return;
  }

  const out: Record<string, unknown> = {
    accountId: account,
    tokenLength: token.length,
    tokenPrefix: token.slice(0, 8),
  };

  // 1. Token info via debug_token (precisa de app_token, mas funciona com user_token tb)
  try {
    const r = await fetch(
      `${META_BASE}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
    );
    const j = (await r.json()) as { data?: Record<string, unknown>; error?: { message: string } };
    if (j.error) {
      out.tokenInfo = { error: j.error.message };
    } else if (j.data) {
      out.tokenInfo = {
        type: j.data.type,
        app_id: j.data.app_id,
        application: j.data.application,
        user_id: j.data.user_id,
        is_valid: j.data.is_valid,
        expires_at: j.data.expires_at,
        scopes: j.data.scopes,
      };
    }
  } catch (err) {
    out.tokenInfo = { error: (err as Error).message };
  }

  // 2. Permissions via /me/permissions
  try {
    const r = await fetch(`${META_BASE}/me/permissions?access_token=${encodeURIComponent(token)}`);
    const j = (await r.json()) as { data?: Array<{ permission: string; status: string }>; error?: { message: string } };
    if (j.error) {
      out.permissions = { error: j.error.message };
    } else {
      const granted = (j.data ?? []).filter(p => p.status === "granted").map(p => p.permission);
      const declined = (j.data ?? []).filter(p => p.status !== "granted").map(p => p.permission);
      out.permissions = {
        granted,
        declined,
        hasAdsRead: granted.includes("ads_read"),
        hasAdsManagement: granted.includes("ads_management"),
        hasBusinessManagement: granted.includes("business_management"),
        hasPagesManageAds: granted.includes("pages_manage_ads"),
      };
    }
  } catch (err) {
    out.permissions = { error: (err as Error).message };
  }

  // 3. Conta — read
  try {
    const r = await fetch(
      `${META_BASE}/${account}?fields=account_status,name,currency,disable_reason,users{id,name,role}&access_token=${encodeURIComponent(token)}`,
    );
    const j = (await r.json()) as Record<string, unknown> & { error?: { message: string } };
    if (j.error) {
      out.accountRead = { error: j.error.message };
    } else {
      out.accountRead = {
        ok: true,
        account_status: j.account_status,
        name: j.name,
        currency: j.currency,
        disable_reason: j.disable_reason,
        users: j.users,
      };
    }
  } catch (err) {
    out.accountRead = { error: (err as Error).message };
  }

  // 4. Tenta WRITE — POST /adimages com payload invalido. Se erro for de
  // permissao retorna 100 ou 200; se for de bytes faltando, retorna 100 com
  // outro codigo. A diferenca expoe se eh write-permission ou nao.
  try {
    const body = new URLSearchParams();
    body.set("access_token", token);
    body.set("url", "https://example.com/__diagnostic_test__.png");
    const r = await fetch(`${META_BASE}/${account}/adimages`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = (await r.json()) as Record<string, unknown> & {
      error?: { code: number; message: string; error_subcode?: number; type?: string };
    };
    if (j.error) {
      out.writeProbe = {
        ok: false,
        code: j.error.code,
        type: j.error.type,
        subcode: j.error.error_subcode,
        message: j.error.message,
      };
    } else {
      out.writeProbe = { ok: true, raw: j };
    }
  } catch (err) {
    out.writeProbe = { error: (err as Error).message };
  }

  res.json(out);
});

export default router;
