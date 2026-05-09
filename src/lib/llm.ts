// LLM wrapper com suporte multi-provider.
//
// Providers suportados:
// - anthropic (Claude Sonnet 4.6) — API paga, com prompt caching
// - gemini (Google Gemini 1.5 Flash) — free tier 1500 req/dia, com vision
//
// Selecao via env LLM_PROVIDER=anthropic|gemini (default: gemini se houver
// GOOGLE_AI_API_KEY, senao anthropic).

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { getResolvedGlobalSettings } from "./runtime-config";

const ANTHROPIC_DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
const GEMINI_DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-1.5-flash";

type Provider = "anthropic" | "gemini";

let anthropicClient: Anthropic | null = null;
let anthropicApiKeyCached = "";
let geminiClient: GoogleGenerativeAI | null = null;
let geminiApiKeyCached = "";

async function resolveProvider(): Promise<{ provider: Provider; apiKey: string }> {
  const explicit = (process.env.LLM_PROVIDER || "").toLowerCase();
  const settings = await getResolvedGlobalSettings();
  const anthropicKey = settings.anthropicApiKey || "";
  const geminiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY || "";

  if (explicit === "gemini" && geminiKey) return { provider: "gemini", apiKey: geminiKey };
  if (explicit === "anthropic" && anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };

  // Auto: prefere Gemini se configurado (porque user nao tem credit Anthropic)
  if (geminiKey) return { provider: "gemini", apiKey: geminiKey };
  if (anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };

  throw new Error("Nenhum provider LLM configurado (GOOGLE_AI_API_KEY ou anthropicApiKey)");
}

async function getAnthropicClient(apiKey: string): Promise<Anthropic> {
  if (!anthropicClient || anthropicApiKeyCached !== apiKey) {
    anthropicClient = new Anthropic({ apiKey });
    anthropicApiKeyCached = apiKey;
  }
  return anthropicClient;
}

function getGeminiClient(apiKey: string): GoogleGenerativeAI {
  if (!geminiClient || geminiApiKeyCached !== apiKey) {
    geminiClient = new GoogleGenerativeAI(apiKey);
    geminiApiKeyCached = apiKey;
  }
  return geminiClient;
}

export async function isLLMConfigured(): Promise<boolean> {
  try {
    await resolveProvider();
    return true;
  } catch {
    return false;
  }
}

interface CompleteInput {
  system: string;
  user: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

export async function complete(input: CompleteInput): Promise<string> {
  const { provider, apiKey } = await resolveProvider();
  if (provider === "gemini") return completeGemini(apiKey, input);
  return completeAnthropic(apiKey, input);
}

async function completeAnthropic(apiKey: string, input: CompleteInput): Promise<string> {
  const c = await getAnthropicClient(apiKey);
  const res = await c.messages.create({
    model: input.model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: input.maxTokens || 1024,
    temperature: input.temperature ?? 0.7,
    system: [
      {
        type: "text",
        text: input.system,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{ role: "user", content: input.user }],
  });
  return res.content
    .filter(block => block.type === "text")
    .map(block => (block as { type: "text"; text: string }).text)
    .join("\n");
}

async function completeGemini(apiKey: string, input: CompleteInput): Promise<string> {
  const c = getGeminiClient(apiKey);
  const model = c.getGenerativeModel({
    model: input.model || GEMINI_DEFAULT_MODEL,
    systemInstruction: input.system,
    generationConfig: {
      maxOutputTokens: input.maxTokens || 1024,
      temperature: input.temperature ?? 0.7,
    },
  });
  const res = await model.generateContent(input.user);
  return res.response.text();
}

// completeWithImage — versao com input de imagem (vision). Funciona pra
// Anthropic e Gemini. Imagem em base64 + mimeType.
export interface ImageInput {
  base64: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
}

export async function completeWithImage(
  input: CompleteInput & { image: ImageInput },
): Promise<string> {
  const { provider, apiKey } = await resolveProvider();
  if (provider === "gemini") {
    const c = getGeminiClient(apiKey);
    const model = c.getGenerativeModel({
      model: input.model || GEMINI_DEFAULT_MODEL,
      systemInstruction: input.system,
      generationConfig: {
        maxOutputTokens: input.maxTokens || 1024,
        temperature: input.temperature ?? 0.7,
      },
    });
    const parts: Part[] = [
      { inlineData: { data: input.image.base64, mimeType: input.image.mimeType } },
      { text: input.user },
    ];
    const res = await model.generateContent(parts);
    return res.response.text();
  }
  // Anthropic vision
  const c = await getAnthropicClient(apiKey);
  const res = await c.messages.create({
    model: input.model || ANTHROPIC_DEFAULT_MODEL,
    max_tokens: input.maxTokens || 1024,
    temperature: input.temperature ?? 0.7,
    system: [{ type: "text", text: input.system, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: input.image.mimeType, data: input.image.base64 },
          },
          { type: "text", text: input.user },
        ],
      },
    ],
  });
  return res.content
    .filter(b => b.type === "text")
    .map(b => (b as { type: "text"; text: string }).text)
    .join("\n");
}

interface JsonCompleteInput<T> extends CompleteInput {
  parser?: (text: string) => T;
  image?: ImageInput;
}

export async function completeJson<T = unknown>(input: JsonCompleteInput<T>): Promise<T> {
  const system =
    input.system +
    "\n\nRESPONDA APENAS COM JSON VÁLIDO. Não use markdown code fences. Apenas o objeto JSON cru.";
  const text = input.image
    ? await completeWithImage({ ...input, system, image: input.image, temperature: input.temperature ?? 0.3 })
    : await complete({ ...input, system, temperature: input.temperature ?? 0.3 });

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  if (input.parser) return input.parser(cleaned);
  try {
    return JSON.parse(cleaned) as T;
  } catch (err) {
    console.error("[llm] json parse falhou:", cleaned.slice(0, 200));
    throw new Error(`LLM retornou JSON inválido: ${(err as Error).message}`);
  }
}
