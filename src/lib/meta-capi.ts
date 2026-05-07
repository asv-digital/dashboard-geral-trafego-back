// Conversions API (CAPI) — envia Purchase events pro Meta.
// Event ID = sale.id pra deduplicar com pixel do browser.

import crypto from "crypto";
import { getResolvedGlobalSettings } from "./runtime-config";

const META_BASE = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || "v19.0"}`;

function sha256Lower(value: string): string {
  return crypto.createHash("sha256").update(value.toLowerCase().trim()).digest("hex");
}

interface CapiUserData {
  email?: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  // C5 — enrichment fields. Sem fbc/fbp/IP/UA, match quality cai pra 4-5 e
  // dedup com Pixel browser falha. Esses fields vem do CheckoutPrep capturado
  // no front da landing antes do redirect pro gateway.
  fbc?: string;             // _fbc cookie ("fb.1.<ts>.<fbclid>")
  fbp?: string;             // _fbp cookie
  clientIpAddress?: string; // IP do user (nao do webhook)
  clientUserAgent?: string;
  externalId?: string;      // ID estavel do customer no nosso sistema
}

interface CapiEventInput {
  pixelId: string;
  eventName: "Purchase" | "InitiateCheckout" | "AddToCart" | "ViewContent";
  eventId: string;
  eventTime: Date;
  value: number;
  currency?: string;
  contentName?: string;
  user: CapiUserData;
  // URL onde o evento ocorreu (top-level field do CAPI). Top of funnel:
  // landing URL. Bottom: checkout URL. Meta usa pra ranking de qualidade.
  eventSourceUrl?: string;
}

export async function sendCapiEvent(input: CapiEventInput): Promise<{ ok: boolean; error?: string }> {
  const { metaAccessToken } = await getResolvedGlobalSettings();
  const token = metaAccessToken;
  if (!token) return { ok: false, error: "no_token" };
  if (!input.pixelId) return { ok: false, error: "no_pixel" };

  // user_data: Meta espera valores hashed (em/ph/fn/ln/external_id) e raw
  // (client_ip_address/client_user_agent/fbc/fbp). Documentado em
  // developers.facebook.com/docs/marketing-api/conversions-api/parameters
  const userData: Record<string, string> = {};
  if (input.user.email) userData.em = sha256Lower(input.user.email);
  if (input.user.phone) userData.ph = sha256Lower(input.user.phone.replace(/\D/g, ""));
  if (input.user.firstName) userData.fn = sha256Lower(input.user.firstName);
  if (input.user.lastName) userData.ln = sha256Lower(input.user.lastName);
  if (input.user.externalId) userData.external_id = sha256Lower(input.user.externalId);
  if (input.user.clientIpAddress) userData.client_ip_address = input.user.clientIpAddress;
  if (input.user.clientUserAgent) userData.client_user_agent = input.user.clientUserAgent;
  if (input.user.fbc) userData.fbc = input.user.fbc;
  if (input.user.fbp) userData.fbp = input.user.fbp;

  const eventData: Record<string, unknown> = {
    event_name: input.eventName,
    event_time: Math.floor(input.eventTime.getTime() / 1000),
    event_id: input.eventId,
    action_source: "website",
    user_data: userData,
    custom_data: {
      currency: input.currency || "BRL",
      value: input.value,
      content_name: input.contentName,
    },
  };
  if (input.eventSourceUrl) eventData.event_source_url = input.eventSourceUrl;

  const payload = { data: [eventData] };

  try {
    const res = await fetch(`${META_BASE}/${input.pixelId}/events?access_token=${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `capi http ${res.status}: ${err}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function addBuyerToCustomAudience(
  audienceId: string,
  email: string | null,
  phone: string | null
): Promise<{ ok: boolean; error?: string }> {
  const { metaAccessToken } = await getResolvedGlobalSettings();
  const token = metaAccessToken;
  if (!token || !audienceId) return { ok: false, error: "no_audience" };

  const users: string[][] = [];
  const schema: string[] = [];
  if (email) {
    schema.push("EMAIL_SHA256");
    users.push([sha256Lower(email)]);
  }
  if (phone) {
    if (schema.length === 0) {
      schema.push("PHONE_SHA256");
      users.push([sha256Lower(phone.replace(/\D/g, ""))]);
    } else {
      schema.push("PHONE_SHA256");
      users[0].push(sha256Lower(phone.replace(/\D/g, "")));
    }
  }
  if (users.length === 0) return { ok: false, error: "no_user_data" };

  try {
    const res = await fetch(
      `${META_BASE}/${audienceId}/users?access_token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payload: { schema, data: users } }),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      return { ok: false, error: `audience http ${res.status}: ${err}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
