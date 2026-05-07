// Webhook Kirvano multi-produto.
// Lookup do produto via kirvanoProductId → atribui Sale, envia CAPI,
// adiciona à custom audience de compradores.
// Idempotente via kirvanoTxId unique.

import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { logAction } from "../services/action-log";
import { sendCapiEvent, addBuyerToCustomAudience } from "../lib/meta-capi";
import {
  getResolvedGlobalSettings,
  getResolvedProductMetaSettings,
} from "../lib/runtime-config";
import {
  timingSafeStringEqual,
  verifyHmacSha256,
  getClientIp,
  isAllowedIp,
  rateLimitWebhook,
} from "../lib/webhook-security";

const router = Router();

function pickString(...candidates: any[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }
  return undefined;
}

function pickNumber(...candidates: any[]): number | undefined {
  for (const c of candidates) {
    if (typeof c === "number" && !isNaN(c)) return c;
    if (typeof c === "string") {
      const n = parseFloat(c);
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}

function pickDate(...candidates: any[]): Date | undefined {
  for (const candidate of candidates) {
    if (candidate instanceof Date && !isNaN(candidate.getTime())) {
      return candidate;
    }
    if (typeof candidate === "number") {
      const millis = candidate > 1_000_000_000_000 ? candidate : candidate * 1000;
      const parsed = new Date(millis);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const numeric = Number(candidate);
      if (!isNaN(numeric) && candidate.trim().match(/^\d+$/)) {
        const millis = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
        const parsed = new Date(millis);
        if (!isNaN(parsed.getTime())) {
          return parsed;
        }
      }
      const parsed = new Date(candidate);
      if (!isNaN(parsed.getTime())) {
        return parsed;
      }
    }
  }
  return undefined;
}

function resolveProductIdFromPayload(payload: any): string | undefined {
  return pickString(
    payload.product_id,
    payload.productId,
    payload.product?.id,
    payload.product?.external_id,
    payload.items?.[0]?.product_id
  );
}

function resolveTxId(payload: any): string | undefined {
  return pickString(
    payload.transaction_id,
    payload.transactionId,
    payload.sale_id,
    payload.saleId,
    payload.id,
    payload.payment?.id
  );
}

function resolveSaleDate(payload: any, txId: string | undefined): Date {
  const resolved = pickDate(
    payload.approved_at,
    payload.approvedAt,
    payload.paid_at,
    payload.paidAt,
    payload.event_time,
    payload.eventTime,
    payload.created_at,
    payload.createdAt,
    payload.purchase_date,
    payload.purchaseDate,
    payload.payment?.approved_at,
    payload.payment?.approvedAt,
    payload.payment?.paid_at,
    payload.payment?.paidAt,
    payload.payment?.created_at,
    payload.payment?.createdAt
  );
  if (resolved) return resolved;
  console.warn(
    `[webhook] Kirvano payload sem data — fallback now() para tx=${txId ?? "(sem txId)"}. Verificar atribuição e relatórios.`
  );
  return new Date();
}

router.post("/kirvano", async (req: Request, res: Response) => {
  const clientIp = getClientIp(req);

  // Camada 1: rate-limit por IP. Kirvano nunca dispara em rajada (>60/min);
  // se passar disso é ataque ou loop. Default 60/min, override via env.
  const rl = rateLimitWebhook(`kirvano:${clientIp}`);
  if (!rl.allowed) {
    console.warn(`[webhook] rate-limit excedido ip=${clientIp}`);
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  // Camada 2: IP allow-list opcional. Se KIRVANO_WEBHOOK_ALLOWED_IPS estiver
  // setado (CSV), só aceita requests vindos desses IPs.
  if (!isAllowedIp(req, process.env.KIRVANO_WEBHOOK_ALLOWED_IPS)) {
    console.warn(`[webhook] IP fora da allow-list: ${clientIp}`);
    res.status(403).json({ error: "forbidden_ip" });
    return;
  }

  const payload = req.body || {};
  const globalSettings = await getResolvedGlobalSettings();

  // Camada 3: HMAC SHA-256 opcional. Se KIRVANO_WEBHOOK_HMAC_SECRET estiver
  // setado, exige header x-kirvano-signature (ou x-hub-signature-256) com
  // assinatura do raw body. Mais forte que token-comparison porque body
  // não pode ser modificado em trânsito.
  const hmacSecret = process.env.KIRVANO_WEBHOOK_HMAC_SECRET;
  if (hmacSecret) {
    const signature =
      (req.headers["x-kirvano-signature"] as string | undefined) ||
      (req.headers["x-hub-signature-256"] as string | undefined);
    const rawBody = (req as any).rawBody as string | undefined;
    if (!signature || !rawBody) {
      console.warn(`[webhook] HMAC habilitado mas request sem signature/rawBody (ip=${clientIp})`);
      res.status(401).json({ error: "missing_signature" });
      return;
    }
    if (!verifyHmacSha256(rawBody, signature, hmacSecret)) {
      console.warn(`[webhook] HMAC invalido ip=${clientIp}`);
      res.status(401).json({ error: "invalid_signature" });
      return;
    }
  }

  // Camada 4: token shared-secret (timing-safe compare).
  // Se não houver token configurado em produção, rejeita. Em dev aceita
  // pra facilitar curl local.
  const expected = globalSettings.kirvanoWebhookToken;
  if (expected) {
    const provided =
      (req.headers["x-kirvano-token"] as string | undefined) ||
      (req.headers["x-webhook-token"] as string | undefined) ||
      (typeof req.query.token === "string" ? req.query.token : undefined);
    if (!provided || !timingSafeStringEqual(provided, expected)) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }
  } else if (process.env.NODE_ENV === "production" && !hmacSecret) {
    // Sem token nem HMAC em produção = porta aberta. Recusa.
    console.error(
      "[webhook] CRITICAL: Kirvano sem token nem HMAC em producao. Configure kirvanoWebhookToken em /settings ou KIRVANO_WEBHOOK_HMAC_SECRET no env."
    );
    res.status(503).json({ error: "webhook_not_configured" });
    return;
  }

  const kirvanoProductId = resolveProductIdFromPayload(payload);
  if (!kirvanoProductId) {
    res.status(400).json({ error: "missing_product_id" });
    return;
  }

  const product = await prisma.product.findUnique({
    where: { kirvanoProductId },
  });
  if (!product) {
    console.warn(`[webhook] produto desconhecido: kirvanoProductId=${kirvanoProductId}`);
    res.status(200).json({ ok: false, warning: "unknown_product", kirvanoProductId });
    return;
  }

  const event = pickString(payload.event, payload.status, payload.type)?.toLowerCase() || "purchase";
  const txId = resolveTxId(payload);
  if (!txId) {
    res.status(400).json({ error: "missing_tx_id" });
    return;
  }

  const parsedAmount = pickNumber(
    payload.amount,
    payload.valor,
    payload.total,
    payload.payment?.amount,
    payload.payment?.total
  );
  if (!parsedAmount) {
    console.warn(
      `[webhook] payload sem amount para tx=${txId}, produto=${product.slug}. Usando priceGross R$${product.priceGross} como fallback.`
    );
  }
  const amountGross = parsedAmount || product.priceGross;

  const customer = payload.customer || payload.comprador || {};
  const tracking = payload.tracking || payload.utm || {};

  const customerEmail = pickString(customer.email, payload.email);
  const customerPhone = pickString(customer.phone, customer.telefone, payload.phone);
  const customerName = pickString(customer.name, customer.nome, payload.name);

  const nameParts = customerName ? customerName.split(" ") : [];
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(" ") || undefined;

  const utmSource = pickString(tracking.utm_source, payload.utm_source);
  const utmMedium = pickString(tracking.utm_medium, payload.utm_medium);
  const utmCampaign = pickString(tracking.utm_campaign, payload.utm_campaign);
  const utmContent = pickString(tracking.utm_content, payload.utm_content);
  const utmTerm = pickString(tracking.utm_term, payload.utm_term);

  const metaCampaignId = pickString(
    tracking.meta_campaign_id,
    tracking.campaign_id,
    payload.meta_campaign_id
  );
  const metaAdsetId = pickString(
    tracking.meta_adset_id,
    tracking.adset_id,
    payload.meta_adset_id
  );
  const metaAdId = pickString(
    tracking.meta_ad_id,
    tracking.ad_id,
    payload.meta_ad_id,
    utmContent
  );

  // Liga ao Campaign do banco se metaCampaignId bate
  let campaignId: string | undefined;
  if (metaCampaignId) {
    const camp = await prisma.campaign.findUnique({
      where: {
        productId_metaCampaignId: {
          productId: product.id,
          metaCampaignId,
        },
      },
    });
    if (camp) campaignId = camp.id;
  }

  const isPurchase =
    event === "purchase" ||
    event === "approved" ||
    event === "approved_payment" ||
    event === "sale_approved" ||
    event === "paid";
  const isPending = event.startsWith("pending") || event === "waiting_payment";
  const isRefund = event === "refund" || event === "refunded";
  const isChargeback = event === "chargeback";

  const amountNet = amountGross * (1 - product.gatewayFeeRate);
  const saleDate = resolveSaleDate(payload, txId);
  const status = isPurchase
    ? "approved"
    : isPending
      ? "pending"
      : isRefund
        ? "refunded"
        : isChargeback
          ? "chargeback"
          : "pending";

  try {
    // Idempotência via kirvanoTxId (unique global)
    const existing = await prisma.sale.findUnique({ where: { kirvanoTxId: txId } });
    if (existing) {
      // atualiza status se mudou (approved→refunded etc)
      if (existing.status !== status) {
        await prisma.sale.update({
          where: { id: existing.id },
          data: {
            status,
            date: saleDate,
            campaignId: campaignId ?? existing.campaignId,
            utmSource: utmSource ?? existing.utmSource,
            utmMedium: utmMedium ?? existing.utmMedium,
            utmCampaign: utmCampaign ?? existing.utmCampaign,
            utmContent: utmContent ?? existing.utmContent,
            utmTerm: utmTerm ?? existing.utmTerm,
            metaCampaignId: metaCampaignId ?? existing.metaCampaignId,
            metaAdsetId: metaAdsetId ?? existing.metaAdsetId,
            metaAdId: metaAdId ?? existing.metaAdId,
          },
        });
        await logAction({
          productId: product.id,
          action: `sale_${status}`,
          entityType: "sale",
          entityId: existing.id,
          details: `${existing.status} → ${status}`,
          source: "webhook",
        });
      }
      res.json({ ok: true, idempotent: true, sale: existing.id });
      return;
    }

    const sale = await prisma.sale.create({
      data: {
        productId: product.id,
        campaignId,
        date: saleDate,
        amountGross,
        amountNet,
        status,
        utmSource,
        utmMedium,
        utmCampaign,
        utmContent,
        utmTerm,
        metaCampaignId,
        metaAdsetId,
        metaAdId,
        customerEmail,
        customerPhone,
        customerName,
        customerFirstName: firstName,
        customerLastName: lastName,
        kirvanoTxId: txId,
        kirvanoCheckoutId: pickString(payload.checkout_id, payload.kirvano_checkout_id),
      },
    });

    await logAction({
      productId: product.id,
      action: `sale_${status}`,
      entityType: "sale",
      entityId: sale.id,
      entityName: customerEmail || txId,
      details: `R$${amountGross.toFixed(2)} — ${utmCampaign || ""}`,
      source: "webhook",
    });

    // CAPI Purchase + custom audience (só em approved)
    if (status === "approved") {
      const productMeta = await getResolvedProductMetaSettings(product);
      const pixelId = productMeta.pixelId;
      if (pixelId) {
        const capiResult = await sendCapiEvent({
          pixelId,
          eventName: "Purchase",
          eventId: sale.id,
          eventTime: saleDate,
          value: amountGross,
          currency: "BRL",
          contentName: product.name,
          user: {
            email: customerEmail,
            phone: customerPhone,
            firstName,
            lastName,
          },
        });
        if (capiResult.ok) {
          await prisma.sale.update({
            where: { id: sale.id },
            data: {
              capiSent: true,
              capiSentAt: new Date(),
              capiEventId: sale.id,
            },
          });
        } else {
          console.error(`[webhook] CAPI falhou: ${capiResult.error}`);
        }
      }

      const audienceId = productMeta.audienceBuyersId;
      if (audienceId && (customerEmail || customerPhone)) {
        await addBuyerToCustomAudience(
          audienceId,
          customerEmail || null,
          customerPhone || null
        );
      }
    }

    res.json({ ok: true, sale: sale.id, status });
  } catch (err) {
    console.error(`[webhook] erro: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: "internal", message: (err as Error).message });
  }
});

export default router;
