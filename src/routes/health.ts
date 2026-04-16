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

export default router;
