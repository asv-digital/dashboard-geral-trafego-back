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

  // 4. Info do APP — se o app esta vinculado a um Business diferente do
  // business onde a Ad Account esta, escritas falham mesmo com SYSTEM_USER.
  const tokenInfoTyped = (out.tokenInfo as Record<string, unknown>) || {};
  const appId = tokenInfoTyped.app_id as string | undefined;
  if (appId) {
    try {
      const r = await fetch(
        `${META_BASE}/${appId}?fields=id,name,namespace,category,company,link,subcategory,migrations,iphone_app_store_id,android_package_name&access_token=${encodeURIComponent(token)}`,
      );
      const j = (await r.json()) as Record<string, unknown> & { error?: { message: string } };
      if (j.error) {
        out.appInfo = { error: j.error.message };
      } else {
        out.appInfo = j;
      }
    } catch (err) {
      out.appInfo = { error: (err as Error).message };
    }

    // Owner do app (business)
    try {
      const r = await fetch(
        `${META_BASE}/${appId}/?fields=business{id,name,verification_status},owner_business{id,name,verification_status}&access_token=${encodeURIComponent(token)}`,
      );
      const j = (await r.json()) as Record<string, unknown> & { error?: { message: string } };
      if (j.error) {
        out.appBusiness = { error: j.error.message };
      } else {
        out.appBusiness = {
          business: j.business,
          owner_business: j.owner_business,
        };
      }
    } catch (err) {
      out.appBusiness = { error: (err as Error).message };
    }
  }

  // 5. Business da Ad Account (pra cruzar com appBusiness)
  try {
    const r = await fetch(
      `${META_BASE}/${account}?fields=business{id,name},business_country_code&access_token=${encodeURIComponent(token)}`,
    );
    const j = (await r.json()) as Record<string, unknown> & { error?: { message: string } };
    if (j.error) {
      out.accountBusiness = { error: j.error.message };
    } else {
      out.accountBusiness = j;
    }
  } catch (err) {
    out.accountBusiness = { error: (err as Error).message };
  }

  // 6. Probes — testa varios endpoints pra mapear capability granular
  const probes: Record<string, unknown> = {};

  async function probe(label: string, url: string, init?: RequestInit) {
    try {
      const r = await fetch(url, init);
      const j = (await r.json()) as Record<string, unknown> & {
        error?: { code: number; message: string; error_subcode?: number; type?: string };
      };
      if (j.error) {
        probes[label] = {
          ok: false,
          code: j.error.code,
          subcode: j.error.error_subcode,
          type: j.error.type,
          message: j.error.message,
        };
      } else {
        probes[label] = { ok: true };
      }
    } catch (err) {
      probes[label] = { error: (err as Error).message };
    }
  }

  // GET endpoints — testar reads
  await probe(
    "read.campaigns",
    `${META_BASE}/${account}/campaigns?limit=1&access_token=${encodeURIComponent(token)}`,
  );
  await probe(
    "read.customaudiences",
    `${META_BASE}/${account}/customaudiences?limit=1&access_token=${encodeURIComponent(token)}`,
  );
  await probe(
    "read.insights",
    `${META_BASE}/${account}/insights?limit=1&access_token=${encodeURIComponent(token)}`,
  );

  // POST endpoints — testar writes
  // POST /campaigns com payload propositalmente invalido pra evitar criar
  // mas suficiente pra revelar capability vs validation
  {
    const body = new URLSearchParams();
    body.set("access_token", token);
    body.set("name", "__diag__");
    body.set("objective", "OUTCOME_TRAFFIC");
    body.set("status", "PAUSED");
    body.set("special_ad_categories", "[]");
    await probe("write.campaigns", `${META_BASE}/${account}/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  // POST /adimages — o caso real do bug
  {
    const body = new URLSearchParams();
    body.set("access_token", token);
    body.set("url", "https://example.com/__diag__.png");
    await probe("write.adimages", `${META_BASE}/${account}/adimages`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  // POST /customaudiences
  {
    const body = new URLSearchParams();
    body.set("access_token", token);
    body.set("name", "__diag__");
    body.set("subtype", "CUSTOM");
    body.set("description", "diagnostic");
    body.set("customer_file_source", "USER_PROVIDED_ONLY");
    await probe("write.customaudiences", `${META_BASE}/${account}/customaudiences`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  out.probes = probes;

  // 7. Diagnostico textual — interpreta resultados pra orientar acao
  const analysis: string[] = [];
  const appBiz = out.appBusiness as { business?: { id?: string; name?: string }; owner_business?: { id?: string; name?: string }; error?: string } | undefined;
  const acctBiz = out.accountBusiness as { business?: { id?: string; name?: string }; error?: string } | undefined;
  const appBizId = appBiz?.business?.id || appBiz?.owner_business?.id;
  const acctBizId = acctBiz?.business?.id;
  if (appBizId && acctBizId && appBizId !== acctBizId) {
    analysis.push(
      `BUSINESS MISMATCH: app esta no business "${appBiz?.business?.name || appBiz?.owner_business?.name}" (${appBizId}) e a Ad Account esta no business "${acctBiz?.business?.name}" (${acctBizId}). System User token nao concede write quando app e ad account estao em business diferentes — precisa app no mesmo business OU passar por App Review com Advanced Access em ads_management.`,
    );
  } else if (appBizId && acctBizId && appBizId === acctBizId) {
    analysis.push(
      `Business OK: app e Ad Account no mesmo business (${appBizId}). Mismatch nao eh a causa do erro #3.`,
    );
  } else if (!appBizId) {
    analysis.push(
      "App SEM Business associado. Pra Marketing API write funcionar com Standard Access, app precisa estar registrado no Business Manager.",
    );
  }

  const writeProbe = probes["write.adimages"] as { code?: number; message?: string } | undefined;
  if (writeProbe?.code === 3) {
    analysis.push(
      "Erro #3 (capability) em writes — app nao tem permissao pra Marketing API write. Solucoes: (a) app no mesmo business da conta + Standard Access habilitado; (b) App Review aprovado com Advanced Access em ads_management.",
    );
  }

  const readCampaigns = probes["read.campaigns"] as { ok?: boolean; code?: number } | undefined;
  if (readCampaigns?.ok) {
    analysis.push("Read funciona normalmente — confirmacao que problema eh write-only.");
  }

  out.analysis = analysis;

  res.json(out);
});

export default router;
