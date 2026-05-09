// Rotas de assets: upload de criativos (vídeo/imagem/copy) pro produto.
// Upload multipart → R2 → disparar ingest pro Meta em background.

import { Router, Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import prisma from "../prisma";
import { requireAuth, requireRole } from "../auth/middleware";
import { checkStorageHealth, deleteObject, uploadBuffer, isStorageConfigured } from "../lib/storage";
import { uploadAssetToMeta } from "../services/content-ingest";
import { logAction } from "../services/action-log";
import { generateTextForAsset, updateAssetText } from "../services/creative-text-generator";

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// GET /?productId= — lista assets do produto
router.get("/", async (req: Request, res: Response) => {
  const productId = String(req.query.productId || "");
  if (!productId) {
    res.status(400).json({ error: "productId required" });
    return;
  }
  const assets = await prisma.productAsset.findMany({
    where: { productId, status: { not: "retired" } },
    orderBy: { createdAt: "desc" },
  });
  res.json({ assets });
});

// POST / — upload de arquivo (multipart) OU texto (copy/headline/hook)
router.post(
  "/",
  requireRole("owner", "editor"),
  upload.single("file"),
  async (req: Request, res: Response) => {
  const productId = String(req.body.productId || "");
  const type = String(req.body.type || "");
  const name = String(req.body.name || "");
  const tags = req.body.tags ? String(req.body.tags) : undefined;
  // Stages of Awareness (Schwartz). Opcional, validacao explicita.
  const VALID_STAGES = ["unaware", "problem", "solution", "product", "most_aware"];
  const awarenessRaw = req.body.awarenessStage ? String(req.body.awarenessStage) : null;
  const awarenessStage =
    awarenessRaw && VALID_STAGES.includes(awarenessRaw) ? awarenessRaw : null;

  if (!productId || !type || !name) {
    res.status(400).json({ error: "missing fields" });
    return;
  }

  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    res.status(404).json({ error: "product_not_found" });
    return;
  }

  // Texto: salva direto
  if (type === "copy" || type === "headline" || type === "hook") {
    const text = String(req.body.text || "");
    if (!text) {
      res.status(400).json({ error: "text required for text assets" });
      return;
    }
    const asset = await prisma.productAsset.create({
      data: {
        productId,
        type,
        name,
        tags,
        awarenessStage,
        status: "ready",
        originalUrl: null,
        content: text.slice(0, 10000),
        uploadedBy: req.user?.id,
      },
    });
    await logAction({
      productId,
      action: "asset_upload_text",
      entityType: "asset",
      entityId: asset.id,
      entityName: name,
      details: `${type}`,
    });
    res.status(201).json({ asset });
    return;
  }

  // Mídia: upload pro storage ativo (R2 ou fallback local)
  if (!req.file) {
    res.status(400).json({ error: "file required" });
    return;
  }
  if (!isStorageConfigured()) {
    res.status(500).json({ error: "storage_not_configured" });
    return;
  }
  const storageHealth = await checkStorageHealth();
  if (!storageHealth.ok) {
    res.status(500).json({ error: "storage_unavailable", message: storageHealth.error });
    return;
  }

  try {
    const uploaded = await uploadBuffer(
      productId,
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype
    );

    const asset = await prisma.productAsset.create({
      data: {
        productId,
        type,
        name,
        tags,
        awarenessStage,
        status: "uploaded",
        originalUrl: uploaded.url,
        r2Key: uploaded.key,
        mimeType: req.file.mimetype,
        sizeBytes: uploaded.size,
        uploadedBy: req.user?.id,
        error: null,
      },
    });

    // Dispara ingest pro Meta em background (fire and forget)
    uploadAssetToMeta(asset.id).catch(err =>
      console.error(`[assets] ingest falhou ${asset.id}:`, err)
    );

    await logAction({
      productId,
      action: "asset_uploaded",
      entityType: "asset",
      entityId: asset.id,
      entityName: name,
      details: `${type} ${uploaded.size} bytes`,
    });

    res.status(201).json({ asset });
  } catch (err) {
    res.status(500).json({ error: "upload_failed", message: (err as Error).message });
  }
  }
);

// PATCH /:id — edita campos do asset (awarenessStage por enquanto).
const patchSchema = z.object({
  awarenessStage: z
    .enum(["unaware", "problem", "solution", "product", "most_aware"])
    .nullable()
    .optional(),
  name: z.string().min(1).optional(),
  tags: z.string().nullable().optional(),
});
router.patch("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
    return;
  }
  try {
    const asset = await prisma.productAsset.update({
      where: { id: String(req.params.id) },
      data: parsed.data,
    });
    res.json({ asset });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

// POST /:id/auto-text — gera copy + headline + hook via Anthropic
router.post(
  "/:id/auto-text",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const assetId = String(req.params.id);
    const asset = await prisma.productAsset.findUnique({ where: { id: assetId } });
    if (!asset) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      const generated = await generateTextForAsset(asset.productId, assetId);
      await logAction({
        productId: asset.productId,
        action: "asset_text_generated",
        entityType: "asset",
        entityId: assetId,
        entityName: asset.name,
        source: "manual",
        details: `copy ${generated.copy.length}c · headline ${generated.headline.length}c · hook ${generated.hook.length}c`,
      });
      res.json({ generated });
    } catch (err) {
      const code = err instanceof Error ? err.message : "internal";
      const status =
        code === "llm_not_configured" || code === "anthropic_not_configured"
          ? 412
          : code === "asset_not_found"
            ? 404
            : code === "asset_type_not_supported"
              ? 400
              : 500;
      res.status(status).json({ error: code });
    }
  },
);

// PATCH /:id/text — edita manualmente { copy?, headline?, hook? }
const textPatchSchema = z
  .object({
    copy: z.string().optional(),
    headline: z.string().optional(),
    hook: z.string().optional(),
  })
  .strict();
router.patch(
  "/:id/text",
  requireRole("owner", "editor"),
  async (req: Request, res: Response) => {
    const parsed = textPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_input", details: parsed.error.issues });
      return;
    }
    const assetId = String(req.params.id);
    const asset = await prisma.productAsset.findUnique({ where: { id: assetId } });
    if (!asset) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    try {
      await updateAssetText(asset.productId, assetId, parsed.data);
      const updated = await prisma.productAsset.findUnique({ where: { id: assetId } });
      res.json({ asset: updated });
    } catch (err) {
      const code = err instanceof Error ? err.message : "internal";
      res.status(code === "asset_not_found" ? 404 : 500).json({ error: code });
    }
  },
);

router.delete("/:id", requireRole("owner", "editor"), async (req: Request, res: Response) => {
  try {
    const asset = await prisma.productAsset.update({
      where: { id: String(req.params.id) },
      data: { status: "retired" },
    });
    if (asset.r2Key) {
      deleteObject(asset.r2Key).catch(err =>
        console.error(`[assets] delete storage failed ${asset.id}:`, err)
      );
    }
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: "not_found" });
  }
});

export default router;
