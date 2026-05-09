// POST /api/checkout-prep — chamada PUBLICA (browser do user, sem session)
// que o front da landing dispara antes do redirect pro gateway de pagamento.
// Captura fbc/fbp/IP/UA + email/phone parciais pra que o webhook posterior
// faca match e enriqueca o Sale + CAPI. Aumenta match quality CAPI de 4-5
// pra 7-9 e habilita dedup confiavel com Pixel browser.
//
// Fluxo:
//  1. User clica anuncio → cookie _fbc/_fbp setado pelo Pixel.
//  2. User chega na landing → JS captura cookies + sessionId UUID.
//  3. Antes do redirect, JS chama POST /api/checkout-prep.
//  4. Quando webhook Kirvano chega, route /webhooks/kirvano busca CheckoutPrep
//     mais recente por (productId, email) e enriquece a Sale.
//  5. CAPI dispara com fbc/fbp/IP/UA → match quality alto.
//
// Sem auth (publico). Rate-limit por IP. Dados expiram em 1h.

import { Router, Request, Response } from "express";
import prisma from "../prisma";
import { getClientIp, rateLimitWebhook } from "../lib/webhook-security";

const router = Router();

const PREP_TTL_MS = 60 * 60 * 1000; // 1h — checkouts finalizam dentro

router.post("/", async (req: Request, res: Response) => {
  const clientIp = getClientIp(req);

  // Rate-limit: 30/min por IP (pessoa nao deveria chamar isso 30x/min nem em
  // dev). Reusa o limiter do webhook pra simplicidade — chave separada.
  const rl = rateLimitWebhook(`checkout-prep:${clientIp}`, 30);
  if (!rl.allowed) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }

  const body = req.body || {};
  const productSlug = typeof body.productSlug === "string" ? body.productSlug.trim() : "";
  const productId = typeof body.productId === "string" ? body.productId.trim() : "";
  if (!productSlug && !productId) {
    res.status(400).json({ error: "missing_product" });
    return;
  }

  const product = productId
    ? await prisma.product.findUnique({ where: { id: productId } })
    : await prisma.product.findUnique({ where: { slug: productSlug } });
  if (!product || product.status !== "active") {
    // Não revela se produto existe (anti-enum), mas o JS da landing precisa
    // saber que o prep não foi capturado pra logar/alertar/decidir fallback.
    // captured=false é sinal pro front; reason é genérico pra não diferenciar
    // produto-não-existe de produto-pausado externamente.
    console.warn(
      `[checkout-prep] silent_drop slug=${productSlug || "?"} id=${productId || "?"} ip=${clientIp}`,
    );
    res.json({ ok: true, captured: false, reason: "product_unavailable" });
    return;
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (!sessionId || sessionId.length < 8 || sessionId.length > 128) {
    res.status(400).json({ error: "invalid_session_id" });
    return;
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
  const phone = typeof body.phone === "string" ? body.phone.trim() : null;
  const fbc = typeof body.fbc === "string" ? body.fbc.trim() : null;
  const fbp = typeof body.fbp === "string" ? body.fbp.trim() : null;
  const landingUrl = typeof body.landingUrl === "string" ? body.landingUrl.trim() : null;
  const ua = (req.headers["user-agent"] as string | undefined)?.slice(0, 500) || null;

  try {
    await prisma.checkoutPrep.create({
      data: {
        productId: product.id,
        sessionId,
        email: email || null,
        phone: phone || null,
        fbc: fbc || null,
        fbp: fbp || null,
        clientIp,
        clientUserAgent: ua,
        landingUrl: landingUrl || null,
        expiresAt: new Date(Date.now() + PREP_TTL_MS),
      },
    });
    res.json({ ok: true, captured: true });
  } catch (err) {
    console.error(`[checkout-prep] erro: ${err instanceof Error ? err.message : String(err)}`);
    res.status(500).json({ error: "internal" });
  }
});

// Limpa preps expirados a cada 30min — single-process ok pra MVP.
setInterval(
  async () => {
    try {
      const result = await prisma.checkoutPrep.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      if (result.count > 0) {
        console.log(`[checkout-prep] limpou ${result.count} preps expirados`);
      }
    } catch (err) {
      console.error(
        `[checkout-prep] erro ao limpar: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
  30 * 60 * 1000
).unref();

export default router;
