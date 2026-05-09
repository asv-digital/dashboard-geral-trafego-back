// Rotas admin pra debug/manutencao. Auth via header X-Admin-Key vs env ADMIN_API_KEY.
// Meta Graph API: somente LEITURA. POST de monthly-goal, asset-upload e
// asset-text liberados pra eu (Claude) operar via curl sem cookie.

import { Router, Request, Response } from "express";
import multer from "multer";
import { getResolvedGlobalSettings } from "../lib/runtime-config";
import { uploadBuffer } from "../lib/storage";
import { uploadAssetToMeta } from "../services/content-ingest";
import { generateTextForAsset } from "../services/creative-text-generator";

const router = Router();

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

function adminAuth(req: Request, res: Response, next: () => void): void {
  const key = process.env.ADMIN_API_KEY;
  if (!key) {
    res.status(503).json({ error: "admin_disabled", message: "ADMIN_API_KEY nao configurado" });
    return;
  }
  const provided = req.header("X-Admin-Key") || req.header("x-admin-key");
  if (!provided || provided !== key) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

router.use(adminAuth);

// GET /admin/ping — health check do admin
router.get("/ping", (_req: Request, res: Response) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// GET /admin/meta-graph?path=...&...other_params
// Faz proxy GET pro Meta Graph API com token do banco. Passa adiante todos os
// query params (exceto `path`). Inclui access_token automaticamente.
router.get("/meta-graph", async (req: Request, res: Response) => {
  const path = String(req.query.path || "").trim();
  if (!path) {
    res.status(400).json({ error: "missing_path", hint: "use ?path=me/permissions ou ?path=act_X/campaigns" });
    return;
  }
  if (path.startsWith("/")) {
    res.status(400).json({ error: "invalid_path", hint: "path nao deve comecar com /" });
    return;
  }

  const settings = await getResolvedGlobalSettings();
  const token = settings.metaAccessToken;
  if (!token) {
    res.status(412).json({ error: "no_token", message: "metaAccessToken nao configurado em /settings" });
    return;
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (key === "path") continue;
    if (value == null) continue;
    if (Array.isArray(value)) {
      params.set(key, value.map(String).join(","));
    } else {
      params.set(key, String(value));
    }
  }
  params.set("access_token", token);

  const url = `${META_BASE}/${path}?${params.toString()}`;
  console.log(`[admin] meta-graph GET ${path} (params: ${Array.from(params.keys()).filter(k => k !== "access_token").join(",")})`);

  try {
    const r = await fetch(url);
    const text = await r.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
    res.status(r.status).json(body);
  } catch (err) {
    res.status(502).json({ error: "fetch_failed", message: (err as Error).message });
  }
});

// GET /admin/db-stats — contagens basicas das tabelas pra dar picture do estado do banco
router.get("/db-stats", async (_req: Request, res: Response) => {
  const prisma = (await import("../prisma")).default;
  const [products, campaigns, creatives, sales, actions, assets] = await Promise.all([
    prisma.product.count(),
    prisma.campaign.count(),
    prisma.creative.count(),
    prisma.sale.count(),
    prisma.actionLog.count(),
    prisma.productAsset.count(),
  ]);
  res.json({ products, campaigns, creatives, sales, actions, assets });
});

// POST /admin/monthly-goal — upsert direto (eu uso via curl pra cadastrar
// metas sem precisar de cookie de sessao). Mesmo schema da rota normal.
router.post("/monthly-goal", async (req: Request, res: Response) => {
  const prisma = (await import("../prisma")).default;
  const { productId, month, targetSales, targetCpa, targetRoas, targetProfit } = req.body || {};
  if (!productId || !month || typeof targetSales !== "number") {
    res.status(400).json({ error: "missing_required", required: ["productId", "month", "targetSales"] });
    return;
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: "invalid_month", hint: "YYYY-MM" });
    return;
  }
  try {
    const goal = await prisma.monthlyGoal.upsert({
      where: { productId_month: { productId, month } },
      create: { productId, month, targetSales, targetCpa, targetRoas, targetProfit },
      update: { targetSales, targetCpa, targetRoas, targetProfit },
    });
    res.status(201).json({ goal });
  } catch (err) {
    res.status(500).json({ error: "internal", message: (err as Error).message });
  }
});

// GET /admin/products — lista basica pra eu pegar productId quando precisar
router.get("/products", async (_req: Request, res: Response) => {
  const prisma = (await import("../prisma")).default;
  const products = await prisma.product.findMany({
    select: { id: true, slug: true, name: true, status: true, stage: true, kirvanoProductId: true, supervisedMode: true },
    orderBy: { createdAt: "desc" },
  });
  res.json({ products });
});

// POST /admin/upload-asset — upload multipart de criativo (imagem/video).
// Replica o flow de /api/assets sem precisar de cookie. Eu uso pra subir
// criativos do Matheus em massa. Dispara uploadAssetToMeta em background.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });
router.post("/upload-asset", upload.single("file"), async (req: Request, res: Response) => {
  const productId = String(req.body.productId || "");
  const type = String(req.body.type || "");
  const name = String(req.body.name || "");
  if (!productId || (type !== "image" && type !== "video")) {
    res.status(400).json({ error: "missing_fields", required: ["productId", "type=image|video", "file"] });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "missing_file" });
    return;
  }
  const prisma = (await import("../prisma")).default;
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    res.status(404).json({ error: "product_not_found" });
    return;
  }
  try {
    const uploaded = await uploadBuffer(productId, req.file.originalname, req.file.buffer, req.file.mimetype);
    const asset = await prisma.productAsset.create({
      data: {
        productId,
        type,
        name: name || req.file.originalname,
        status: "uploaded",
        originalUrl: uploaded.url,
        r2Key: uploaded.key,
        mimeType: req.file.mimetype,
        sizeBytes: uploaded.size,
        uploadedBy: "admin-curl",
      },
    });
    // Background: tenta sync pro Meta. Se falhar, asset fica com status=uploaded
    // e o erro fica no campo error.
    uploadAssetToMeta(asset.id).catch(err =>
      console.error(`[admin] upload-asset meta sync ${asset.id}:`, err),
    );
    res.status(201).json({ asset });
  } catch (err) {
    res.status(500).json({ error: "internal", message: (err as Error).message });
  }
});

// PATCH /admin/settings/global — atualiza GlobalSettings (apenas campos meta-related)
router.patch("/settings/global", async (req: Request, res: Response) => {
  const prisma = (await import("../prisma")).default;
  const allowedFields = [
    "metaAdAccountId", "metaPixelId", "metaPageId",
    "metaAudienceBuyersId", "metaAudienceWarmId", "metaAudienceWarmName",
  ] as const;
  const data: Record<string, string | null | undefined> = {};
  for (const k of allowedFields) {
    if (k in req.body) data[k] = req.body[k] === "" ? null : req.body[k];
  }
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "no_fields", allowed: allowedFields });
    return;
  }
  try {
    const settings = await prisma.globalSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...data },
      update: data,
    });
    // Invalida cache
    const { clearRuntimeConfigCache } = await import("../lib/runtime-config");
    clearRuntimeConfigCache("global");
    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: "internal", message: (err as Error).message });
  }
});

// PATCH /admin/settings/product/:id — atualiza campos meta do produto
router.patch("/settings/product/:id", async (req: Request, res: Response) => {
  const prisma = (await import("../prisma")).default;
  const allowedFields = [
    "metaPixelId", "metaPageId", "metaAudienceBuyersId",
  ] as const;
  const data: Record<string, string | null | undefined> = {};
  for (const k of allowedFields) {
    if (k in req.body) data[k] = req.body[k] === "" ? null : req.body[k];
  }
  if (Object.keys(data).length === 0) {
    res.status(400).json({ error: "no_fields", allowed: allowedFields });
    return;
  }
  try {
    const product = await prisma.product.update({
      where: { id: String(req.params.id) },
      data,
      select: {
        id: true, slug: true, name: true,
        metaPixelId: true, metaPageId: true, metaAudienceBuyersId: true,
      },
    });
    res.json({ product });
  } catch (err) {
    res.status(404).json({ error: "not_found_or_internal", message: (err as Error).message });
  }
});

// POST /admin/asset/:assetId/auto-text — gera copy/headline/hook via Anthropic
router.post("/asset/:assetId/auto-text", async (req: Request, res: Response) => {
  const assetId = String(req.params.assetId);
  const prisma = (await import("../prisma")).default;
  const asset = await prisma.productAsset.findUnique({ where: { id: assetId } });
  if (!asset) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  try {
    const generated = await generateTextForAsset(asset.productId, assetId);
    res.json({ generated });
  } catch (err) {
    const code = err instanceof Error ? err.message : "internal";
    res.status(500).json({ error: code });
  }
});

export default router;
