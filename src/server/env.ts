import "server-only";
import { z } from "zod";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL tanımlı değil"),
  // Coolify'ın yeni sürümleri SERVICE_FQDN_* değerini şemasız verir ("lead.ornek.com") → https:// eklenir
  APP_URL: z.preprocess(
    (v) => {
      const s = emptyToUndefined(v);
      return typeof s === "string" && !/^https?:\/\//i.test(s.trim()) ? `https://${s.trim()}` : s;
    },
    z.string().url().default("http://localhost:3000"),
  ),
  /** false → /register kapalı (herkese açık demo sunucusunda AI kredisini korumak için) */
  ALLOW_SIGNUP: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")).transform((v) => v === "true"),
  ENCRYPTION_KEY: optionalString,
  SIGNUP_CREDITS: z.coerce.number().int().min(0).default(500),

  AI_PROVIDER: z.enum(["anthropic", "openai", "gemini"]).default("anthropic"),
  AI_MODEL: optionalString,
  AI_FAST_MODEL: optionalString,
  AI_FALLBACK_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["anthropic", "openai", "gemini"]).optional()),
  AI_FALLBACK_MODEL: optionalString,
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  /** OpenAI uyumlu başka servis (ör. OpenRouter: https://openrouter.ai/api/v1). Boşsa api.openai.com */
  OPENAI_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
  GEMINI_API_KEY: optionalString,

  EMBEDDING_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["none", "openai", "gemini", "voyage"]).default("none")),
  EMBEDDING_MODEL: optionalString,
  VOYAGE_API_KEY: optionalString,

  QUEUE_DRIVER: z.preprocess(emptyToUndefined, z.enum(["inline", "bullmq"]).default("inline")),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  STORAGE_DRIVER: z.preprocess(emptyToUndefined, z.enum(["local", "s3"]).default("local")),
  STORAGE_LOCAL_DIR: z.string().default("./storage"),
  S3_ENDPOINT: optionalString,
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("ai-sales-os"),
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,

  APIFY_TOKEN: optionalString,
  /** Google Haritalar actor kimliği (Apify "kullanıcı~actor" biçimi) */
  APIFY_GOOGLE_MAPS_ACTOR: optionalString,
  /** Google arama sonuçları actor kimliği (web araması kaynağı) */
  APIFY_WEB_SEARCH_ACTOR: optionalString,
  /** Sayfayı tarayıcıda açıp metnini döndüren actor (JavaScript ile yüklenen liste sayfaları için) */
  APIFY_RENDER_ACTOR: optionalString,
  /** Tek aramada en fazla kaç lead toplanır (kredi koruması) */
  LEAD_SEARCH_MAX: z.coerce.number().int().min(1).max(500).default(50),
  /** smtp | resend | brevo — boşsa e-posta gönderimi kapalı (mesaj üretimi ve onay çalışır) */
  EMAIL_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["smtp", "resend", "brevo"]).optional()),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false")).transform((v) => v === "true"),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  RESEND_API_KEY: optionalString,
  BREVO_API_KEY: optionalString,
  /** Şirket başına günlük en fazla gönderim (itibar / spam koruması) */
  EMAIL_DAILY_LIMIT: z.coerce.number().int().min(1).max(5000).default(50),
  /** Ret (unsubscribe) bağlantılarının imza anahtarı. Production'da zorunlu. */
  UNSUBSCRIBE_SECRET: optionalString,
  /** E-posta sağlayıcı webhook'ları için paylaşılan gizli anahtar (?token=…) */
  EMAIL_WEBHOOK_SECRET: optionalString,
  /** Gelen yanıtlar: gönderici posta kutusu IMAP ile salt okunur okunur (boşsa kapalı) */
  IMAP_HOST: optionalString,
  IMAP_PORT: z.coerce.number().int().min(1).max(65535).default(993),
  IMAP_SECURE: z.preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true")).transform((v) => v === "true"),
  IMAP_USER: optionalString,
  IMAP_PASS: optionalString,
  IMAP_MAILBOX: z.preprocess(emptyToUndefined, z.string().default("INBOX")),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Ortam değişkenlerini ilk erişimde doğrular (build sırasında değil). */
export function env(): Env {
  if (!cached) {
    const parsed = schema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      throw new Error(`Geçersiz ortam değişkenleri: ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Testlerde ortam değişkenlerini değiştirdikten sonra çağrılır. */
export function resetEnvCache() {
  cached = undefined;
}
