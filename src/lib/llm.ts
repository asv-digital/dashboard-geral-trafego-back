// Claude wrapper com prompt caching.
//
// Sempre marca o system prompt com cache_control ephemeral — economiza
// tokens quando o mesmo contexto é reusado em múltiplas chamadas
// (comment-analyzer roda centenas de vezes por ciclo com o mesmo system).
//
// Default: Sonnet 4.6. Override via ANTHROPIC_MODEL env.

import Anthropic from "@anthropic-ai/sdk";
import { getResolvedGlobalSettings } from "./runtime-config";

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";

let client: Anthropic | null = null;
let clientApiKey = "";

async function getClient(): Promise<Anthropic> {
  const { anthropicApiKey } = await getResolvedGlobalSettings();
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY não configurado");
  }
  if (!client || clientApiKey !== anthropicApiKey) {
    client = new Anthropic({ apiKey: anthropicApiKey });
    clientApiKey = anthropicApiKey;
  }
  return client;
}

export async function isLLMConfigured(): Promise<boolean> {
  const { anthropicApiKey } = await getResolvedGlobalSettings();
  return !!anthropicApiKey;
}

interface CompleteInput {
  system: string; // system prompt — vai com cache_control
  user: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

export async function complete(input: CompleteInput): Promise<string> {
  const c = await getClient();
  const res = await c.messages.create({
    model: input.model || DEFAULT_MODEL,
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

  const text = res.content
    .filter(block => block.type === "text")
    .map(block => (block as any).text)
    .join("\n");
  return text;
}

interface JsonCompleteInput<T> extends CompleteInput {
  parser?: (text: string) => T;
}

export async function completeJson<T = any>(input: JsonCompleteInput<T>): Promise<T> {
  const system =
    input.system +
    "\n\nRESPONDA APENAS COM JSON VÁLIDO. Não use markdown code fences. Apenas o objeto JSON cru.";
  const text = await complete({ ...input, system, temperature: input.temperature ?? 0.3 });

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "");

  if (input.parser) return input.parser(cleaned);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("[llm] json parse falhou:", cleaned.slice(0, 200));
    throw new Error(`LLM retornou JSON inválido: ${(err as Error).message}`);
  }
}
