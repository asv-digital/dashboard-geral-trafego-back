// Classificador automatico de Stages of Awareness (Eugene Schwartz, 1966).
// Le ProductAsset/Creative sem awarenessStage setado e classifica via Claude.
//
// Regra Schwartz:
//   unaware    — copy nao menciona problema nem solucao (educa)
//   problem    — copy descreve dor mas nao apresenta solucao
//   solution   — copy aponta tipo de solucao mas nao o produto
//   product    — copy menciona o produto especifico/marca
//   most_aware — copy assume que ja conhece e oferece (CTA forte, preço, garantia)

import prisma from "../prisma";
import { completeJson, isLLMConfigured } from "../lib/llm";

const VALID_STAGES = [
  "unaware",
  "problem",
  "solution",
  "product",
  "most_aware",
] as const;
type Stage = (typeof VALID_STAGES)[number];

interface ClassifyInput {
  productName: string;
  productDescription?: string | null;
  copy: string;
  type: string; // copy | headline | hook
}

interface ClassifyOutput {
  stage: Stage;
  confidence: number; // 0-1
  reason: string;
}

const SYSTEM_PROMPT = `Voce classifica copy de marketing direto em UMA das 5 Stages of Awareness (Eugene Schwartz, "Breakthrough Advertising" 1966):

- unaware: nao menciona problema nem solucao. Educacional, abre curiosidade ou choca.
- problem: descreve a dor especifica, mas nao apresenta solucao.
- solution: aponta tipo de solucao (categoria), nao o produto especifico.
- product: menciona o produto/marca especifico ou caracteristicas exclusivas.
- most_aware: assume conhecimento. CTA direto, preco, garantia, urgencia.

Seja conservador. Quando duvidoso entre 2 niveis, escolha o mais COLD (unaware > problem > solution > product > most_aware).

Retorne JSON puro: {"stage": "...", "confidence": 0.0-1.0, "reason": "..."}.`;

async function classifyOne(input: ClassifyInput): Promise<ClassifyOutput | null> {
  const user = `Produto: ${input.productName}${input.productDescription ? ` — ${input.productDescription}` : ""}
Tipo do asset: ${input.type}

Copy:
"""
${input.copy.slice(0, 2000)}
"""

Classifique em qual Stage of Awareness esta copy fala.`;

  try {
    const result = await completeJson<ClassifyOutput>({
      system: SYSTEM_PROMPT,
      user,
      maxTokens: 300,
      temperature: 0.1,
    });
    if (
      result &&
      typeof result.stage === "string" &&
      VALID_STAGES.includes(result.stage as Stage)
    ) {
      return result;
    }
    return null;
  } catch (err) {
    console.error(
      `[awareness-classifier] LLM falhou: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

export interface ClassifyProductResult {
  productId: string;
  totalAssets: number;
  classified: number;
  skippedNoLlm: number;
  skippedNoCopy: number;
  failed: number;
  byStage: Record<Stage, number>;
}

export async function classifyAwarenessForProduct(
  productId: string
): Promise<ClassifyProductResult> {
  const result: ClassifyProductResult = {
    productId,
    totalAssets: 0,
    classified: 0,
    skippedNoLlm: 0,
    skippedNoCopy: 0,
    failed: 0,
    byStage: { unaware: 0, problem: 0, solution: 0, product: 0, most_aware: 0 },
  };

  if (!(await isLLMConfigured())) {
    return { ...result, skippedNoLlm: -1 };
  }

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { name: true, description: true, defaultHeadline: true },
  });
  if (!product) return result;

  // Pega assets sem awarenessStage E que tem texto pra classificar
  // (type copy/headline/hook OU mídia com content/name explicativo).
  const assets = await prisma.productAsset.findMany({
    where: {
      productId,
      awarenessStage: null,
      status: { not: "retired" },
      OR: [
        { type: "copy" },
        { type: "headline" },
        { type: "hook" },
      ],
    },
  });
  result.totalAssets = assets.length;

  for (const asset of assets) {
    const copy = asset.content?.trim() || asset.name?.trim() || "";
    if (!copy) {
      result.skippedNoCopy += 1;
      continue;
    }

    const classification = await classifyOne({
      productName: product.name,
      productDescription: product.description,
      copy,
      type: asset.type,
    });

    if (!classification) {
      result.failed += 1;
      continue;
    }

    try {
      await prisma.productAsset.update({
        where: { id: asset.id },
        data: { awarenessStage: classification.stage },
      });
      result.classified += 1;
      result.byStage[classification.stage] += 1;
    } catch (err) {
      console.error(
        `[awareness-classifier] update ${asset.id} falhou:`,
        err instanceof Error ? err.message : err
      );
      result.failed += 1;
    }
  }

  // Tambem propaga pra Creative quando o nome do creative bate com algum asset
  // tagueado. Isso e um bonus — usuario ainda pode marcar manual em Creative.
  const taggedAssets = await prisma.productAsset.findMany({
    where: { productId, awarenessStage: { not: null } },
    select: { name: true, awarenessStage: true },
  });
  if (taggedAssets.length > 0) {
    const creativesUntagged = await prisma.creative.findMany({
      where: { productId, awarenessStage: null },
      select: { id: true, name: true },
    });
    for (const c of creativesUntagged) {
      // Match heuristico: nome do creative contem nome do asset (ou vice-versa).
      const match = taggedAssets.find(
        a =>
          c.name.toLowerCase().includes(a.name.toLowerCase()) ||
          a.name.toLowerCase().includes(c.name.toLowerCase())
      );
      if (match?.awarenessStage) {
        await prisma.creative
          .update({
            where: { id: c.id },
            data: { awarenessStage: match.awarenessStage },
          })
          .catch(() => {});
      }
    }
  }

  return result;
}

export async function classifyAwarenessAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true, slug: true },
  });
  for (const p of products) {
    try {
      const r = await classifyAwarenessForProduct(p.id);
      console.log(
        `[awareness-classifier] ${p.slug}: ${r.classified}/${r.totalAssets} classificados`
      );
    } catch (err) {
      console.error(
        `[awareness-classifier] ${p.slug} erro:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
