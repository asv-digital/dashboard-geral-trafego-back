// Rotas para ações manuais no Meta (pausar/ativar/ajustar budget).
// Sempre escopadas por productId — valida whitelist antes de mutar.

import { Router, Request, Response } from "express";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";
import { ensureAccountActive } from "../lib/meta-account";
import {
  pauseCampaign,
  activateCampaign,
  pauseAdset,
  activateAdset,
  updateAdsetBudget,
  updateCampaignBudget,
} from "../lib/meta-mutations";
import { logAction } from "../services/action-log";
import { getActiveAdsetsForCampaigns } from "../lib/meta-mutations";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";

const router = Router();
router.use(requireAuth);
router.use(requireRole("owner", "editor"));

async function ensureCampaignBelongsTo(
  productId: string,
  metaCampaignId: string
): Promise<boolean> {
  const c = await prisma.campaign.findUnique({
    where: { productId_metaCampaignId: { productId, metaCampaignId } },
  });
  return c !== null;
}

async function ensureAdsetBelongsTo(
  productId: string,
  adsetId: string
): Promise<boolean> {
  const campaigns = await prisma.campaign.findMany({
    where: { productId, metaCampaignId: { not: null } },
    select: { metaCampaignId: true },
  });
  const trackedCampaignIds = campaigns
    .map(c => c.metaCampaignId)
    .filter((id): id is string => id !== null);
  if (trackedCampaignIds.length === 0) {
    return false;
  }

  const { adAccountId: accountId } = await getResolvedProductMetaSettings();
  if (!accountId) {
    return false;
  }

  const adsets = await getActiveAdsetsForCampaigns(accountId, trackedCampaignIds);
  return adsets.some(adset => adset.id === adsetId);
}

const pauseCampaignSchema = z.object({
  productId: z.string(),
  metaCampaignId: z.string(),
});

router.post("/campaigns/pause", async (req: Request, res: Response) => {
  const parsed = pauseCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    res.status(412).json({ error: "account_inactive", reason: gate.reason });
    return;
  }
  const { productId, metaCampaignId } = parsed.data;
  if (!(await ensureCampaignBelongsTo(productId, metaCampaignId))) {
    res.status(403).json({ error: "campaign_not_in_whitelist" });
    return;
  }
  const ok = await pauseCampaign(metaCampaignId);
  if (!ok) {
    res.status(500).json({ error: "meta_failed" });
    return;
  }
  // Sync status no banco — a whitelist usa Campaign.status
  await prisma.campaign.updateMany({
    where: { productId, metaCampaignId },
    data: { status: "Pausada" },
  });
  await logAction({
    productId,
    action: "manual_pause_campaign",
    entityType: "campaign",
    entityId: metaCampaignId,
    source: "dashboard",
    reasoning: "Ação manual do usuário pelo dashboard.",
  });
  res.json({ ok: true });
});

router.post("/campaigns/activate", async (req: Request, res: Response) => {
  const parsed = pauseCampaignSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    res.status(412).json({ error: "account_inactive", reason: gate.reason });
    return;
  }
  const { productId, metaCampaignId } = parsed.data;
  if (!(await ensureCampaignBelongsTo(productId, metaCampaignId))) {
    res.status(403).json({ error: "campaign_not_in_whitelist" });
    return;
  }
  const ok = await activateCampaign(metaCampaignId);
  if (!ok) {
    res.status(500).json({ error: "meta_failed" });
    return;
  }
  await prisma.campaign.updateMany({
    where: { productId, metaCampaignId },
    data: { status: "Ativa" },
  });
  await logAction({
    productId,
    action: "manual_activate_campaign",
    entityType: "campaign",
    entityId: metaCampaignId,
    source: "dashboard",
    reasoning: "Ação manual do usuário pelo dashboard.",
  });
  res.json({ ok: true });
});

const budgetSchema = z.object({
  productId: z.string(),
  metaCampaignId: z.string(),
  dailyBudget: z.number().positive(),
});

router.patch("/campaigns/budget", async (req: Request, res: Response) => {
  const parsed = budgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    res.status(412).json({ error: "account_inactive", reason: gate.reason });
    return;
  }
  const { productId, metaCampaignId, dailyBudget } = parsed.data;
  if (!(await ensureCampaignBelongsTo(productId, metaCampaignId))) {
    res.status(403).json({ error: "campaign_not_in_whitelist" });
    return;
  }
  const ok = await updateCampaignBudget(metaCampaignId, dailyBudget);
  if (!ok) {
    res.status(500).json({ error: "meta_failed" });
    return;
  }
  await logAction({
    productId,
    action: "manual_update_budget",
    entityType: "campaign",
    entityId: metaCampaignId,
    details: `new budget R$${dailyBudget}`,
    source: "dashboard",
  });
  res.json({ ok: true });
});

const adsetPauseSchema = z.object({
  productId: z.string(),
  adsetId: z.string(),
});

router.post("/adsets/pause", async (req: Request, res: Response) => {
  const parsed = adsetPauseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    res.status(412).json({ error: "account_inactive", reason: gate.reason });
    return;
  }
  if (!(await ensureAdsetBelongsTo(parsed.data.productId, parsed.data.adsetId))) {
    res.status(403).json({ error: "adset_not_in_whitelist" });
    return;
  }
  const ok = await pauseAdset(parsed.data.adsetId);
  if (!ok) {
    res.status(500).json({ error: "meta_failed" });
    return;
  }
  await logAction({
    productId: parsed.data.productId,
    action: "manual_pause_adset",
    entityType: "adset",
    entityId: parsed.data.adsetId,
    source: "dashboard",
  });
  res.json({ ok: true });
});

router.post("/adsets/activate", async (req: Request, res: Response) => {
  const parsed = adsetPauseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    res.status(412).json({ error: "account_inactive", reason: gate.reason });
    return;
  }
  if (!(await ensureAdsetBelongsTo(parsed.data.productId, parsed.data.adsetId))) {
    res.status(403).json({ error: "adset_not_in_whitelist" });
    return;
  }
  const ok = await activateAdset(parsed.data.adsetId);
  if (!ok) {
    res.status(500).json({ error: "meta_failed" });
    return;
  }
  await logAction({
    productId: parsed.data.productId,
    action: "manual_activate_adset",
    entityType: "adset",
    entityId: parsed.data.adsetId,
    source: "dashboard",
  });
  res.json({ ok: true });
});

const adsetBudgetSchema = z.object({
  productId: z.string(),
  adsetId: z.string(),
  dailyBudget: z.number().positive(),
});

router.patch("/adsets/budget", async (req: Request, res: Response) => {
  const parsed = adsetBudgetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input" });
    return;
  }
  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    res.status(412).json({ error: "account_inactive", reason: gate.reason });
    return;
  }
  if (!(await ensureAdsetBelongsTo(parsed.data.productId, parsed.data.adsetId))) {
    res.status(403).json({ error: "adset_not_in_whitelist" });
    return;
  }
  const ok = await updateAdsetBudget(parsed.data.adsetId, parsed.data.dailyBudget);
  if (!ok) {
    res.status(500).json({ error: "meta_failed" });
    return;
  }
  await logAction({
    productId: parsed.data.productId,
    action: "manual_update_adset_budget",
    entityType: "adset",
    entityId: parsed.data.adsetId,
    details: `new budget R$${parsed.data.dailyBudget}`,
    source: "dashboard",
  });
  res.json({ ok: true });
});

export default router;
