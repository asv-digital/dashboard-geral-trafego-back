// Env validator que roda no boot.
// FATAL: variáveis sem as quais o servidor não pode subir em produção.
// WARN: variáveis que só degradam funcionalidade (comment analyzer off,
// notificações off, etc) — loga alto mas deixa subir.

const FATAL_DEV = ["DATABASE_URL", "SESSION_SECRET"];

const FATAL_PROD = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "META_ACCESS_TOKEN",
  "META_AD_ACCOUNT_ID",
  "META_PIXEL_ID",
  "META_PAGE_ID",
  "FRONTEND_URL",
];

const WARN_PROD = [
  ["ANTHROPIC_API_KEY", "comment-analyzer + copy generation desligados"],
  ["R2_ENDPOINT", "storage cai em filesystem local (perde arquivos em restart de container)"],
  ["R2_ACCESS_KEY_ID", "storage R2 desativado"],
  ["R2_SECRET_ACCESS_KEY", "storage R2 desativado"],
  ["WHATSAPP_INSTANCE_ID", "notificações WhatsApp desligadas"],
  ["WHATSAPP_TOKEN", "notificações WhatsApp desligadas"],
  ["WHATSAPP_PHONE", "notificações WhatsApp desligadas"],
  ["KIRVANO_WEBHOOK_TOKEN", "webhook Kirvano ACEITA qualquer request (configure token em produção)"],
  ["BACKEND_PUBLIC_URL", "URLs públicas de assets locais usarão http://localhost:PORT"],
] as const;

const DEFAULT_SESSION_SECRETS = new Set([
  "dev_secret_nao_usar_em_producao_troque_por_hex64",
  "troque_por_um_segredo_de_64_chars",
]);

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function validateEnvOrExit(): void {
  const required = isProduction() ? FATAL_PROD : FATAL_DEV;
  const missing: string[] = [];

  for (const key of required) {
    const value = (process.env[key] || "").trim();
    if (!value) missing.push(key);
  }

  const secret = (process.env.SESSION_SECRET || "").trim();
  if (isProduction() && DEFAULT_SESSION_SECRETS.has(secret)) {
    missing.push("SESSION_SECRET (está com valor default de dev — gere com `openssl rand -hex 32`)");
  }
  if (isProduction() && secret.length < 32) {
    missing.push("SESSION_SECRET (precisa ter >= 32 chars em produção)");
  }

  if (missing.length > 0) {
    console.error("\n[env-check] FATAL — variáveis obrigatórias ausentes:");
    for (const m of missing) console.error(`  - ${m}`);
    console.error("\nCorrija o .env e reinicie.\n");
    process.exit(1);
  }

  if (isProduction()) {
    const warnings: string[] = [];
    for (const [key, impact] of WARN_PROD) {
      if (!(process.env[key] || "").trim()) {
        warnings.push(`${key}: ${impact}`);
      }
    }
    if (warnings.length > 0) {
      console.warn("\n[env-check] WARN — vars ausentes em produção (funcionalidade degradada):");
      for (const w of warnings) console.warn(`  - ${w}`);
      console.warn("");
    }
  }

  console.log(
    `[env-check] ok — NODE_ENV=${process.env.NODE_ENV || "development"}, ad_account=${process.env.META_AD_ACCOUNT_ID || "(vazio)"}, storage=${process.env.R2_ENDPOINT ? "r2" : "local"}`
  );
}
