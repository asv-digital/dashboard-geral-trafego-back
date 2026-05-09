// Comment analyzer product-aware.
//
// 1. Coleta comentários novos de todos os ads das campanhas whitelisted
//    do produto via Meta Graph API
// 2. Classifica cada comentário via Claude (cacheado — um system prompt só)
// 3. Agrega em AdCommentSummary por ad + período
// 4. Alerta se objection_price > 30% ou objection_trust > 20%

import prisma from "../prisma";
import { completeJson, isLLMConfigured } from "../lib/llm";
import { sendNotification } from "./whatsapp-notifier";
import { shouldSendStateAlert } from "../lib/alert-dedup";
import { getResolvedGlobalSettings, getResolvedProductMetaSettings } from "../lib/runtime-config";
import { getTrackedAdsForCampaigns } from "../lib/meta-mutations";
import { addBRTDays, startOfBRTDay } from "../lib/tz";

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

// M7 — throttle Graph: comment-analyzer roda paginacao infinita por ad
// (20+ ads x 200+ comentarios cada = 80+ requests). MetaClient ja throttla
// a ~200ms entre requests, mas usa instancia compartilhada apenas pra
// insights. Aqui replicamos o padrao com closure de modulo + retry
// exponencial pra 429/5xx — sem acoplamento com a classe MetaClient.
const MIN_GRAPH_INTERVAL_MS = 200;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);
let lastGraphFetchAt = 0;

async function throttledGraphFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastGraphFetchAt;
  if (elapsed < MIN_GRAPH_INTERVAL_MS) {
    await new Promise(r => setTimeout(r, MIN_GRAPH_INTERVAL_MS - elapsed));
  }
  lastGraphFetchAt = Date.now();

  let attempt = 0;
  const maxAttempts = 3;
  while (true) {
    const res = await fetch(url);
    if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxAttempts) return res;
    attempt++;
    const backoffMs = Math.pow(2, attempt) * 1000;
    console.warn(
      `[comment-analyzer] graph ${res.status} retry ${attempt}/${maxAttempts} after ${backoffMs}ms`
    );
    await new Promise(r => setTimeout(r, backoffMs));
    lastGraphFetchAt = Date.now();
  }
}

type Sentiment =
  | "positive"
  | "negative"
  | "objection_price"
  | "objection_trust"
  | "question"
  | "tag_friend"
  | "neutral";

interface RawComment {
  id: string;
  message: string;
  from?: { name?: string };
  created_time: string;
}

async function fetchAdComments(adId: string): Promise<RawComment[]> {
  const { metaAccessToken: token } = await getResolvedGlobalSettings();
  if (!token) return [];
  try {
    const comments: RawComment[] = [];
    let url =
      `${META_BASE}/${adId}/comments` +
      `?fields=id,message,from,created_time` +
      `&limit=100` +
      `&access_token=${token}`;

    while (url) {
      const res = await throttledGraphFetch(url);
      if (!res.ok) {
        // 401/403/190: token sem `pages_read_engagement` ou ad deletado/oculto.
        // Antes engolíamos silencioso — agora logamos pra detectar capability gap.
        const bodyTxt = await res.text().catch(() => "");
        console.warn(
          `[comment-analyzer] fetchAdComments adId=${adId} status=${res.status} body=${bodyTxt.slice(0, 200)}`,
        );
        return comments;
      }
      const json = (await res.json()) as {
        data?: RawComment[];
        paging?: { next?: string };
      };
      comments.push(...(json.data ?? []));
      url = json.paging?.next || "";
    }

    return comments;
  } catch (err) {
    console.warn(
      `[comment-analyzer] fetchAdComments adId=${adId} threw: ${(err as Error).message}`,
    );
    return [];
  }
}

async function getTrackedAds(
  product: Awaited<ReturnType<typeof prisma.product.findUnique>>
): Promise<Array<{ id: string; name: string }>> {
  if (!product) return [];

  const { adAccountId: accountId } = await getResolvedProductMetaSettings(product);
  if (!accountId) return [];

  const campaigns = await prisma.campaign.findMany({
    where: { productId: product.id, metaCampaignId: { not: null } },
    select: { metaCampaignId: true },
  });
  const trackedIds = campaigns
    .map(c => c.metaCampaignId)
    .filter((id): id is string => id !== null);
  if (trackedIds.length === 0) return [];

  try {
    const ads = await getTrackedAdsForCampaigns(accountId, trackedIds);
    return ads.map(ad => ({ id: ad.id, name: ad.name }));
  } catch (err) {
    console.warn(
      `[comment-analyzer] getTrackedAds productId=${product.id} threw: ${(err as Error).message}`,
    );
    return [];
  }
}

interface ClassifyResult {
  sentiments: Sentiment[];
  failed: boolean; // true se LLM falhou ou retornou formato inválido
}

async function classifyComments(
  productName: string,
  productPrice: number,
  comments: string[]
): Promise<ClassifyResult> {
  if (!(await isLLMConfigured()) || comments.length === 0) {
    return {
      sentiments: comments.map(() => "neutral" as Sentiment),
      failed: !(await isLLMConfigured()) && comments.length > 0,
    };
  }

  // System prompt é marcado com cache_control no wrapper.
  const system = `Você é um classificador de comentários de anúncios de produtos digitais. Sua função é classificar cada comentário em exatamente UMA das categorias:

- positive: elogio, interesse positivo, entusiasmo
- negative: reclamação, crítica, hostilidade sem ser sobre preço/confiança
- objection_price: questiona o preço, acha caro, pede desconto
- objection_trust: desconfiança, suspeita de golpe, pede prova
- question: pergunta genuína sobre o produto, dúvida de compra
- tag_friend: marca outra pessoa sem outro conteúdo
- neutral: não cabe nas outras

Seja conservador — se tiver dúvida, use neutral.`;

  const user = `Produto: "${productName}" (R$${productPrice})

Classifique cada comentário abaixo. Retorne um array JSON com N sentimentos, na mesma ordem dos comentários. Sem explicação, sem markdown — apenas um array JSON com strings.

Comentários:
${comments.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;

  try {
    const result = await completeJson<Sentiment[]>({
      system,
      user,
      maxTokens: 2000,
    });
    if (!Array.isArray(result) || result.length !== comments.length) {
      console.warn(
        `[comment-analyzer] LLM retornou formato inválido (esperado array length=${comments.length})`,
      );
      return { sentiments: comments.map(() => "neutral"), failed: true };
    }
    return { sentiments: result, failed: false };
  } catch (err) {
    console.error("[comment-analyzer] classificação falhou:", err);
    return { sentiments: comments.map(() => "neutral"), failed: true };
  }
}

export async function analyzeCommentsForProduct(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) return;

  const ads = await getTrackedAds(product);
  if (ads.length === 0) return;

  for (const ad of ads) {
    const raw = await fetchAdComments(ad.id);
    if (raw.length === 0) continue;

    // Só classifica comentários novos (ainda não no banco)
    const existingIds = new Set(
      (
        await prisma.adComment.findMany({
          where: { productId, adId: ad.id },
          select: { commentId: true },
        })
      ).map(c => c.commentId)
    );
    const newOnes = raw.filter(r => !existingIds.has(r.id));
    if (newOnes.length === 0) continue;

    const { sentiments, failed } = await classifyComments(
      product.name,
      product.priceGross,
      newOnes.map(c => c.message)
    );

    for (let i = 0; i < newOnes.length; i++) {
      const c = newOnes[i];
      try {
        await prisma.adComment.create({
          data: {
            productId,
            adId: ad.id,
            adName: ad.name,
            commentId: c.id,
            message: c.message,
            authorName: c.from?.name,
            sentiment: sentiments[i],
            // Quando classificador falha, marca analyzedAt=null pra distinguir
            // "neutral real" de "neutral fallback". AdCommentSummary deve
            // ignorar registros com analyzedAt=null no rate de objection.
            analyzedAt: failed ? null : new Date(),
          },
        });
      } catch {
        // duplicate commentId (unique constraint) — skip
      }
    }
  }

  // Agrega summaries 7d
  const sevenDaysAgo = addBRTDays(startOfBRTDay(), -6);

  const allAds = await prisma.adComment.groupBy({
    by: ["adId", "adName"],
    where: { productId, createdAt: { gte: sevenDaysAgo } },
    _count: true,
  });

  for (const adGroup of allAds) {
    const adComments = await prisma.adComment.findMany({
      where: { productId, adId: adGroup.adId, createdAt: { gte: sevenDaysAgo } },
      select: { sentiment: true },
    });

    const counts: Record<Sentiment, number> = {
      positive: 0,
      negative: 0,
      objection_price: 0,
      objection_trust: 0,
      question: 0,
      tag_friend: 0,
      neutral: 0,
    };
    for (const c of adComments) {
      const s = (c.sentiment as Sentiment) || "neutral";
      counts[s] = (counts[s] || 0) + 1;
    }

    const total = adComments.length;
    const pricePct = total > 0 ? (counts.objection_price / total) * 100 : 0;
    const trustPct = total > 0 ? (counts.objection_trust / total) * 100 : 0;

    let topObjection: string | null = null;
    let recommendation: string | null = null;
    if (pricePct > 30) {
      topObjection = "preço";
      recommendation = "Reforçar valor entregue, ancoragem, comparação com alternativas caras.";
    } else if (trustPct > 20) {
      topObjection = "confiança";
      recommendation = "Adicionar social proof: depoimentos, prints, casos reais, garantia explícita.";
    }

    await prisma.adCommentSummary.upsert({
      where: {
        productId_adId_period: { productId, adId: adGroup.adId, period: "7d" },
      },
      create: {
        productId,
        adId: adGroup.adId,
        adName: adGroup.adName || undefined,
        period: "7d",
        totalComments: total,
        positive: counts.positive,
        negative: counts.negative,
        objectionPrice: counts.objection_price,
        objectionTrust: counts.objection_trust,
        questions: counts.question,
        tagFriend: counts.tag_friend,
        neutral: counts.neutral,
        topObjection,
        recommendation,
      },
      update: {
        totalComments: total,
        positive: counts.positive,
        negative: counts.negative,
        objectionPrice: counts.objection_price,
        objectionTrust: counts.objection_trust,
        questions: counts.question,
        tagFriend: counts.tag_friend,
        neutral: counts.neutral,
        topObjection,
        recommendation,
        analyzedAt: new Date(),
      },
    });

    // Alerta se objection predominante (edge-triggered)
    if (topObjection) {
      const key = `comment_objection:${adGroup.adId}`;
      const shouldAlert = await shouldSendStateAlert(productId, key, topObjection);
      if (shouldAlert) {
        await sendNotification(
          "comment_alert",
          {
            message: `${product.name} — ad ${adGroup.adName || adGroup.adId}: objeção "${topObjection}" em ${Math.max(pricePct, trustPct).toFixed(0)}% dos comentários. Recomendação: ${recommendation}`,
          },
          productId
        );
      }
    }
  }
}

export async function analyzeCommentsAll(): Promise<void> {
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { id: true },
  });
  for (const p of products) {
    try {
      await analyzeCommentsForProduct(p.id);
    } catch (err) {
      console.error(
        `[comment-analyzer] produto ${p.id} erro: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
