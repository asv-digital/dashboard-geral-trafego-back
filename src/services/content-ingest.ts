// Content ingest: pega um ProductAsset recém-upado e sobe pro Meta
// (como advideo ou adimage), setando metaMediaId pra uso futuro em adcreative.
//
// Fluxo: upload local → R2 → /advideos (video_id) ou /adimages (hash).

import prisma from "../prisma";
import fs from "fs";
import FormData from "form-data";
import { logAction } from "./action-log";
import { ensureAccountActive } from "../lib/meta-account";
import { getResolvedProductMetaSettings } from "../lib/runtime-config";
import { resolveStoredFilePath } from "../lib/storage";

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

async function markPendingMetaSync(assetId: string, error: string): Promise<void> {
  await prisma.productAsset.update({
    where: { id: assetId },
    data: { status: "uploaded", error },
  });
}

export async function uploadAssetToMeta(assetId: string): Promise<{ ok: boolean; metaMediaId?: string; error?: string }> {
  const asset = await prisma.productAsset.findUnique({ where: { id: assetId } });
  if (!asset) return { ok: false, error: "asset_not_found" };
  if (!asset.originalUrl) return { ok: false, error: "no_url" };

  if (asset.metaMediaId) {
    return { ok: true, metaMediaId: asset.metaMediaId };
  }

  const product = await prisma.product.findUnique({
    where: { id: asset.productId },
    select: { metaPixelId: true, metaPageId: true, metaAudienceBuyersId: true },
  });
  const settings = await getResolvedProductMetaSettings(product);
  const token = settings.accessToken;
  const accountId = settings.adAccountId;
  if (!token || !accountId) {
    await markPendingMetaSync(assetId, "pending_meta_sync: meta_not_configured");
    return { ok: false, error: "meta_not_configured" };
  }

  const gate = await ensureAccountActive();
  if (!gate.allowed) {
    await markPendingMetaSync(assetId, `pending_meta_sync: ${gate.reason}`);
    return { ok: false, error: "account_inactive" };
  }

  try {
    if (asset.type === "video") {
      const localPath = asset.r2Key ? resolveStoredFilePath(asset.r2Key) : null;
      let res: Response;
      if (localPath) {
        const body = new FormData();
        body.append("access_token", token);
        body.append("name", asset.name);
        body.append("source", fs.createReadStream(localPath));
        res = await fetch(`${META_BASE}/${accountId}/advideos`, {
          method: "POST",
          headers: body.getHeaders(),
          body: body as any,
        });
      } else {
        const body = new URLSearchParams();
        body.set("file_url", asset.originalUrl);
        body.set("access_token", token);
        body.set("name", asset.name);
        res = await fetch(`${META_BASE}/${accountId}/advideos`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
      }
      const json = (await res.json()) as any;
      if (json.error) {
        await markPendingMetaSync(assetId, json.error.message);
        return { ok: false, error: json.error.message };
      }
      await prisma.productAsset.update({
        where: { id: assetId },
        data: { status: "ready", metaMediaId: json.id, error: null },
      });
      await logAction({
        productId: asset.productId,
        action: "asset_uploaded_to_meta",
        entityType: "asset",
        entityId: assetId,
        entityName: asset.name,
        details: `video_id=${json.id}`,
      });
      return { ok: true, metaMediaId: json.id };
    }

    if (asset.type === "image") {
      const localPath = asset.r2Key ? resolveStoredFilePath(asset.r2Key) : null;
      let res: Response;
      if (localPath) {
        const body = new FormData();
        body.append("access_token", token);
        body.append("bytes", fs.createReadStream(localPath));
        res = await fetch(`${META_BASE}/${accountId}/adimages`, {
          method: "POST",
          headers: body.getHeaders(),
          body: body as any,
        });
      } else {
        const body = new URLSearchParams();
        body.set("url", asset.originalUrl);
        body.set("access_token", token);
        res = await fetch(`${META_BASE}/${accountId}/adimages`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
      }
      const json = (await res.json()) as any;
      if (json.error) {
        await markPendingMetaSync(assetId, json.error.message);
        return { ok: false, error: json.error.message };
      }
      // Meta retorna images: { filename: { hash: "..." } }
      const hash = json.images ? Object.values(json.images)[0] as any : null;
      const metaMediaId = hash?.hash || "";
      await prisma.productAsset.update({
        where: { id: assetId },
        data: { status: "ready", metaMediaId, error: null },
      });
      return { ok: true, metaMediaId };
    }

    // Copy/headline/hook não vão pro Meta diretamente — só ficam no banco
    await prisma.productAsset.update({
      where: { id: assetId },
      data: { status: "ready" },
    });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    await markPendingMetaSync(assetId, msg);
    return { ok: false, error: msg };
  }
}
