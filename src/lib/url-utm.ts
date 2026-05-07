// D4 — UTM auto-append no link do adcreative.
//
// Meta Ads suporta URL parameters dinamicos que sao substituidos em runtime
// quando o user clica:
//   {{placement}}      → "Facebook_Mobile_Feed", "instagram_reels", etc
//   {{campaign.id}}    → ID numerico da campanha
//   {{campaign.name}}  → nome
//   {{adset.id}}       → ID numerico do adset
//   {{adset.name}}
//   {{ad.id}}          → ID numerico do anuncio
//   {{ad.name}}
//   {{site_source_name}}  → "fb", "ig", "an", "msg"
//
// Padrao Pedro Sobral: usar IDs em utm_content/utm_term pra match perfeito
// no webhook (hoje webhook ja le utmContent/utmTerm e tenta map em metaAdId/
// metaAdsetId — com placeholders, match e exato).
//
// Preserva UTMs ja presentes no landingUrl (user pode ter setado intencional).

const DEFAULT_DYNAMIC_UTMS: Record<string, string> = {
  utm_source: "meta",
  utm_medium: "{{placement}}",
  utm_campaign: "{{campaign.id}}",
  utm_content: "{{ad.id}}",
  utm_term: "{{adset.id}}",
  // bonus pra debug humano:
  campaign_name: "{{campaign.name}}",
  ad_name: "{{ad.name}}",
};

export function appendDynamicUtms(baseUrl: string): string {
  if (!baseUrl) return baseUrl;
  try {
    const url = new URL(baseUrl);
    for (const [key, value] of Object.entries(DEFAULT_DYNAMIC_UTMS)) {
      // Nao sobrescreve — user pode ter UTM custom intencional.
      if (!url.searchParams.has(key)) {
        url.searchParams.set(key, value);
      }
    }
    // URLSearchParams encoda "{" e "}" como "%7B"/"%7D" — Meta nao substitui
    // placeholders codificados. Reverte na string final.
    return url.toString().replace(/%7B%7B/g, "{{").replace(/%7D%7D/g, "}}");
  } catch {
    return baseUrl;
  }
}
