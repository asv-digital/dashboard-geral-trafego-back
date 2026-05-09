// Rotas admin pra debug/manutencao. Auth via header X-Admin-Key vs env ADMIN_API_KEY.
// SOMENTE LEITURA do Meta Graph API. POST/DELETE/PATCH ficam com requireAuth normal.
//
// Uso (eu via curl):
//   curl -H "X-Admin-Key: $KEY" "https://trafego.bravy.com.br/api/admin/meta-graph?path=me/permissions"
//   curl -H "X-Admin-Key: $KEY" "https://trafego.bravy.com.br/api/admin/meta-graph?path=act_X/campaigns&fields=id,name,status&limit=10"
//
// O endpoint pega o metaAccessToken do GlobalSettings (mesmo que a dash usa pra
// agente). Nao expoe o token. So permite GET. Path obrigatorio.

import { Router, Request, Response } from "express";
import { getResolvedGlobalSettings } from "../lib/runtime-config";

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

export default router;
