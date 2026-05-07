// Endurecimento de webhooks externos (Kirvano principalmente).
// Camadas (todas opt-in via env, ativadas por variável presente):
//   1. Timing-safe compare do token (sempre que houver token).
//   2. HMAC SHA-256 do raw body (KIRVANO_WEBHOOK_HMAC_SECRET).
//   3. IP allow-list (KIRVANO_WEBHOOK_ALLOWED_IPS — CSV).
//   4. Rate-limit em memória por IP (default 60 req/min, override via env).
//
// Memory-only é ok pra single-process. Se for cluster, trocar por Redis.

import { Request } from "express";
import crypto from "crypto";

export function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // timingSafeEqual exige tamanhos iguais. Se diferentes, ainda gastamos
  // tempo comparando contra um buffer dummy do mesmo tamanho do esperado.
  if (ab.length !== bb.length) {
    const dummy = Buffer.alloc(bb.length);
    crypto.timingSafeEqual(dummy, bb);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Valida HMAC SHA-256 do raw body usando secret. Aceita signature em formato
 * "sha256=<hex>" ou só "<hex>". Retorna true se bate.
 */
export function verifyHmacSha256(
  rawBody: string | Buffer,
  signature: string,
  secret: string
): boolean {
  const cleaned = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return timingSafeStringEqual(cleaned.trim().toLowerCase(), expected.toLowerCase());
}

/**
 * Extrai IP "real" do request, considerando X-Forwarded-For setado por proxy
 * confiável (Coolify/Traefik/Nginx). Retorna o primeiro IP da cadeia.
 */
export function getClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0) {
    return String(xff[0]).split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || "unknown";
}

export function isAllowedIp(req: Request, csvAllowList: string | undefined): boolean {
  if (!csvAllowList || csvAllowList.trim().length === 0) return true; // opt-in
  const allow = csvAllowList
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
  const clientIp = getClientIp(req);
  return allow.includes(clientIp);
}

// Rate-limit token-bucket simples, em memória, por chave (IP).
// 60 req/min default — Kirvano não dispara em rajada.
const buckets: Map<string, { count: number; windowStart: number }> = new Map();
const WINDOW_MS = 60 * 1000;

export function rateLimitWebhook(
  key: string,
  maxPerMinute: number = Number(process.env.WEBHOOK_RATE_LIMIT_PER_MIN || 60)
): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.windowStart >= WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: Math.max(0, maxPerMinute - 1) };
  }
  b.count += 1;
  if (b.count > maxPerMinute) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: Math.max(0, maxPerMinute - b.count) };
}

// Limpa buckets velhos a cada 5min pra não vazar memória.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now - v.windowStart >= WINDOW_MS * 2) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();
