// NotificationConfig routes — global (compartilhado entre produtos).

import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";
import { sendNotification } from "../services/whatsapp-notifier";
import { clearRuntimeConfigCache } from "../lib/runtime-config";

const router = Router();
router.use(requireAuth);

router.get("/config", requireRole("owner"), async (_req: Request, res: Response) => {
  const config = await prisma.notificationConfig.findUnique({
    where: { id: "singleton" },
  });
  res.json({ config });
});

const updateSchema = z.object({
  whatsappProvider: z.string().nullable().optional(),
  whatsappInstanceId: z.string().nullable().optional(),
  whatsappToken: z.string().nullable().optional(),
  whatsappPhone: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  notifyAutoActions: z.boolean().optional(),
  notifyCreativeActions: z.boolean().optional(),
  notifyLearningPhase: z.boolean().optional(),
  notifyAlerts: z.boolean().optional(),
  notifyDailySummary: z.boolean().optional(),
});

function normalizeOptionalString(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

router.put("/config", requireRole("owner"), async (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const data = {
    whatsappProvider: normalizeOptionalString(parsed.data.whatsappProvider),
    whatsappInstanceId: normalizeOptionalString(parsed.data.whatsappInstanceId),
    whatsappToken: normalizeOptionalString(parsed.data.whatsappToken),
    whatsappPhone: normalizeOptionalString(parsed.data.whatsappPhone),
    enabled: parsed.data.enabled,
    notifyAutoActions: parsed.data.notifyAutoActions,
    notifyCreativeActions: parsed.data.notifyCreativeActions,
    notifyLearningPhase: parsed.data.notifyLearningPhase,
    notifyAlerts: parsed.data.notifyAlerts,
    notifyDailySummary: parsed.data.notifyDailySummary,
  };
  const config = await prisma.notificationConfig.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", ...data },
    update: data,
  });
  clearRuntimeConfigCache("notification");
  res.json({ config });
});

router.post("/test", requireRole("owner"), async (_req: Request, res: Response) => {
  const result = await sendNotification("alert_critical", {
    type: "TESTE",
    detail: "Notificação de teste disparada pelo dashboard.",
    action: "Se você recebeu isso, a integração está funcionando.",
  });
  if (result.ok) {
    res.json({ ok: true });
    return;
  }
  res.status(result.skipped ? 412 : 500).json({
    error: result.error || (result.skipped ? "notification_skipped" : "notification_failed"),
  });
});

router.get("/log", requireRole("owner"), async (_req: Request, res: Response) => {
  const logs = await prisma.notificationLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  res.json({ logs });
});

export default router;
