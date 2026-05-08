// Gera copy + headline + hook por criativo via Anthropic Claude.
//
// IMAGEM → Claude vision (analisa visual real)
// VIDEO  → Claude texto-only (so metadata + dados produto). Follow-up V2:
//          extrair frames via ffmpeg.
//
// Sobral way: PT-BR, direto, denso, pattern interrupt no hook,
// problem→solution na copy, beneficio claro na headline.

import { promises as fs } from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
import prisma from "../prisma";
import { getResolvedGlobalSettings } from "../lib/runtime-config";
import { resolveStoredFilePath } from "../lib/storage";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB — limite seguro pra Claude vision
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

export interface GeneratedCreativeText {
  copy: string;
  headline: string;
  hook: string;
}

const SYSTEM_PROMPT = `Voce e Pedro Sobral, gestor de trafego senior em PT-BR. Escreve copy de anuncio Meta (Facebook/Instagram) curto, denso e direto.

Regras absolutas:
1. PT-BR. Sem jargao gringo. Sem floreio.
2. HOOK (3 primeiros segundos do video / primeira linha do anuncio): pattern interrupt. Frase curta (max 60 char) que para o scroll. Pode ser pergunta, dado quebrado de expectativa, ou contradicao. Sem clickbait barato.
3. HEADLINE: max 40 char visiveis. Beneficio claro + objeto especifico. Sem promessa milagrosa. Ex: "57 agentes IA prontos pra agencia" — beneficio (agentes prontos) + objeto (agencia).
4. COPY (primary text): max 125 char antes do "ver mais". Estrutura PROBLEM → SOLUTION → CTA (implicit). Sem ataque a concorrente. Sem promessa de renda.
5. NAO usar emojis. Excecao: 1 emoji estrategico no inicio da copy se fizer sentido visual.
6. Compliance Meta: sem "voce que mora em X", sem antes/depois, sem cura/garantia, sem renda especifica.

Voce VAI receber dado do produto + criativo (imagem ou metadata de video). Use o que for visual pra ancorar a mensagem ao que o usuario VE.

Retorna SO JSON valido sem markdown:
{ "copy": "...", "headline": "...", "hook": "..." }`;

interface ProductContext {
  name: string;
  description: string | null;
  priceGross: number;
  landingUrl: string;
  stage: string;
  defaultHeadline: string;
  defaultDescription: string | null;
}

async function buildProductContext(productId: string): Promise<ProductContext> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw new Error("product_not_found");
  return {
    name: product.name,
    description: product.description,
    priceGross: product.priceGross,
    landingUrl: product.landingUrl,
    stage: product.stage,
    defaultHeadline: product.defaultHeadline,
    defaultDescription: product.defaultDescription,
  };
}

async function readImageBytes(asset: {
  r2Key: string | null;
  originalUrl: string | null;
  sizeBytes: number | null;
}): Promise<{ bytes: Buffer; mimeType: string } | null> {
  if (asset.sizeBytes && asset.sizeBytes > MAX_IMAGE_BYTES) {
    console.warn(`[text-gen] imagem ${asset.sizeBytes} bytes > ${MAX_IMAGE_BYTES}, skipping vision`);
    return null;
  }

  // Tenta ler local primeiro
  if (asset.r2Key) {
    const local = resolveStoredFilePath(asset.r2Key);
    if (local) {
      try {
        const bytes = await fs.readFile(local);
        const ext = path.extname(local).toLowerCase().slice(1);
        const mimeType =
          ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "png"
              ? "image/png"
              : ext === "webp"
                ? "image/webp"
                : ext === "gif"
                  ? "image/gif"
                  : "image/jpeg";
        return { bytes, mimeType };
      } catch (err) {
        console.warn(`[text-gen] falhou ler local: ${(err as Error).message}`);
      }
    }
  }

  // Fallback: fetch URL publica
  if (asset.originalUrl) {
    try {
      const res = await fetch(asset.originalUrl);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) {
        console.warn(`[text-gen] imagem fetched ${buf.length} bytes > limit, skipping vision`);
        return null;
      }
      const mimeType = res.headers.get("content-type") || "image/jpeg";
      return { bytes: buf, mimeType };
    } catch (err) {
      console.warn(`[text-gen] fetch falhou: ${(err as Error).message}`);
    }
  }
  return null;
}

function buildUserText(product: ProductContext, asset: { type: string; name: string }): string {
  return [
    `PRODUTO: ${product.name}`,
    product.description ? `DESCRICAO: ${product.description}` : null,
    `PRECO: R$ ${product.priceGross.toFixed(2)}`,
    `LANDING: ${product.landingUrl}`,
    `STAGE: ${product.stage}`,
    `HEADLINE DEFAULT (referencia): ${product.defaultHeadline}`,
    product.defaultDescription ? `DESCRICAO DEFAULT (referencia): ${product.defaultDescription}` : null,
    "",
    `CRIATIVO: ${asset.type === "image" ? "imagem (anexada)" : `video — filename "${asset.name}"`}`,
    "",
    "Gere os 3 textos otimizados pra esse criativo especifico. Retorna JSON cru.",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseJsonResponse(raw: string): GeneratedCreativeText {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");
  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // Tenta achar primeiro { ... } no texto
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("llm_returned_invalid_json");
    obj = JSON.parse(match[0]);
  }
  if (!obj || typeof obj !== "object") throw new Error("llm_returned_invalid_shape");
  const o = obj as Record<string, unknown>;
  const copy = typeof o.copy === "string" ? o.copy.trim() : "";
  const headline = typeof o.headline === "string" ? o.headline.trim() : "";
  const hook = typeof o.hook === "string" ? o.hook.trim() : "";
  if (!copy || !headline || !hook) throw new Error("llm_missing_fields");
  return { copy, headline, hook };
}

export async function generateTextForAsset(
  productId: string,
  assetId: string,
): Promise<GeneratedCreativeText> {
  const { anthropicApiKey } = await getResolvedGlobalSettings();
  if (!anthropicApiKey) {
    throw new Error("anthropic_not_configured");
  }

  const asset = await prisma.productAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.productId !== productId) {
    throw new Error("asset_not_found");
  }
  if (asset.type !== "image" && asset.type !== "video") {
    throw new Error("asset_type_not_supported");
  }

  const product = await buildProductContext(productId);
  const userText = buildUserText(product, { type: asset.type, name: asset.name });

  const client = new Anthropic({ apiKey: anthropicApiKey });

  const userContent: Anthropic.Messages.ContentBlockParam[] = [];

  // Vision so para imagem
  if (asset.type === "image") {
    const img = await readImageBytes(asset);
    if (img) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mimeType as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
          data: img.bytes.toString("base64"),
        },
      });
    } else {
      console.warn(`[text-gen] sem visual para asset ${assetId}, fallback metadata-only`);
    }
  }

  userContent.push({ type: "text", text: userText });

  const res = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 700,
    temperature: 0.5,
    system: [
      {
        type: "text",
        text: SYSTEM_PROMPT,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: userContent }],
  });

  const text = res.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("\n");

  const parsed = parseJsonResponse(text);

  await prisma.productAsset.update({
    where: { id: assetId },
    data: {
      generatedCopy: parsed.copy,
      generatedHeadline: parsed.headline,
      generatedHook: parsed.hook,
      textGeneratedAt: new Date(),
    },
  });

  return parsed;
}

export async function updateAssetText(
  productId: string,
  assetId: string,
  patch: { copy?: string; headline?: string; hook?: string },
): Promise<void> {
  const asset = await prisma.productAsset.findUnique({ where: { id: assetId } });
  if (!asset || asset.productId !== productId) {
    throw new Error("asset_not_found");
  }
  const data: { generatedCopy?: string; generatedHeadline?: string; generatedHook?: string } = {};
  if (patch.copy !== undefined) data.generatedCopy = patch.copy;
  if (patch.headline !== undefined) data.generatedHeadline = patch.headline;
  if (patch.hook !== undefined) data.generatedHook = patch.hook;
  if (Object.keys(data).length === 0) return;

  await prisma.productAsset.update({ where: { id: assetId }, data });
}
