import "server-only";
import { z } from "zod";
import { env } from "@/server/env";
import { AppError } from "@/lib/errors";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAIEmbeddingProvider, OpenAIProvider } from "./providers/openai";
import { GeminiEmbeddingProvider, GeminiProvider } from "./providers/gemini";
import { VoyageEmbeddingProvider } from "./providers/voyage";
import { parseJsonFromText } from "./json";
import { SAFETY_RULES } from "./guardrails";
import { logAIUsage } from "./usage-log";
import {
  AIProviderError,
  type AIProvider,
  type EmbeddingProvider,
  type GenerateTextInput,
  type GenerateTextResult,
  type ModelTier,
  type ProviderName,
} from "./types";

const DEFAULT_MODELS: Record<ProviderName, Record<ModelTier, string>> = {
  anthropic: { default: "claude-sonnet-5", fast: "claude-haiku-4-5-20251001" },
  openai: { default: "gpt-4.1", fast: "gpt-4.1-mini" },
  gemini: { default: "gemini-2.5-flash", fast: "gemini-2.5-flash-lite" },
};

// ── Test / demo için sağlayıcı enjeksiyonu ──────────────────────────
let providerOverride: AIProvider | null = null;
let embeddingOverride: EmbeddingProvider | null | undefined;

/** Yalnızca testlerde kullanılır. Production kodu bunu çağırmaz. */
export function __setAIProviderForTests(p: AIProvider | null, e?: EmbeddingProvider | null) {
  providerOverride = p;
  embeddingOverride = e;
}

function buildProvider(name: ProviderName): AIProvider {
  const e = env();
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(e.ANTHROPIC_API_KEY ?? "");
    case "openai":
      return new OpenAIProvider(e.OPENAI_API_KEY ?? "", e.OPENAI_BASE_URL?.replace(/\/$/, ""));
    case "gemini":
      return new GeminiProvider(e.GEMINI_API_KEY ?? "");
  }
}

function resolveModel(provider: ProviderName, tier: ModelTier, explicit?: string, isFallback = false): string {
  if (explicit) return explicit;
  const e = env();
  if (isFallback && e.AI_FALLBACK_MODEL) return e.AI_FALLBACK_MODEL;
  if (!isFallback) {
    if (tier === "fast" && e.AI_FAST_MODEL) return e.AI_FAST_MODEL;
    if (tier === "default" && e.AI_MODEL) return e.AI_MODEL;
  }
  return DEFAULT_MODELS[provider][tier];
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  if (embeddingOverride !== undefined) return embeddingOverride;
  const e = env();
  try {
    switch (e.EMBEDDING_PROVIDER) {
      case "openai":
        return new OpenAIEmbeddingProvider(e.OPENAI_API_KEY ?? "", e.EMBEDDING_MODEL);
      case "gemini":
        return new GeminiEmbeddingProvider(e.GEMINI_API_KEY ?? "", e.EMBEDDING_MODEL);
      case "voyage":
        return new VoyageEmbeddingProvider(e.VOYAGE_API_KEY ?? "", e.EMBEDDING_MODEL);
      default:
        return null;
    }
  } catch (err) {
    console.warn("[ai] embedding sağlayıcısı başlatılamadı:", (err as Error).message);
    return null;
  }
}

export function isAIConfigured(): boolean {
  if (providerOverride) return true;
  const e = env();
  const key = { anthropic: e.ANTHROPIC_API_KEY, openai: e.OPENAI_API_KEY, gemini: e.GEMINI_API_KEY }[e.AI_PROVIDER];
  return Boolean(key);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AICallContext {
  /** Maliyet ve izolasyon için zorunlu. Platform işlemlerinde null. */
  companyId: string | null;
  /** Loglarda görünen işlem adı, ör. "website.analyze" */
  operation: string;
}

export interface ExtractInput<T extends z.ZodTypeAny> {
  schema: T;
  /** Beklenen JSON yapısının modele anlatımı (alanlar + açıklamalar). */
  shape: string;
  instructions: string;
  input: string;
  tier?: ModelTier;
  maxTokens?: number;
}

/**
 * Uygulamanın kullandığı tek AI giriş noktası.
 * - Güvenlik kurallarını her sistem prompt'una ekler
 * - Retry (exponential backoff) + fallback sağlayıcı
 * - Her çağrıyı AIUsageLog'a yazar (companyId, model, token, tahmini maliyet)
 */
/**
 * Sağlayıcı hatasını kullanıcıya anlaşılır Türkçe nedene çevirir. Yapılandırma hataları (geçersiz anahtar,
 * bakiye yok, model erişimi) "birkaç dakika sonra deneyin" ile gizlenmez; ne yapılacağı söylenir.
 */
export function describeProviderError(err: unknown): string {
  const status = err instanceof AIProviderError ? err.status : undefined;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (/credit balance|insufficient.?(credit|quota|funds)|billing/i.test(msg)) {
    return "AI sağlayıcı hesabında kullanılabilir bakiye yok. console.anthropic.com → Billing'den bakiye yükleyin (Claude.ai aboneliği API bakiyesi sayılmaz).";
  }
  if (status === 401 || /invalid.?x-api-key|authentication_error|invalid api key/i.test(msg)) {
    return "AI API anahtarı geçersiz. Yöneticiniz ANTHROPIC_API_KEY değerini kontrol etmeli (console.anthropic.com → API Keys; başında/sonunda boşluk olmamalı).";
  }
  if (status === 404 || /not_found_error|model.*not found/i.test(msg)) {
    return "Seçili AI modeline erişim yok. Yöneticiniz AI_MODEL / AI_FAST_MODEL ayarını hesabın erişebildiği bir modelle değiştirmeli.";
  }
  if (status === 403 || /permission_error/i.test(msg)) {
    return "AI API anahtarının bu işlem için yetkisi yok (anahtarın ait olduğu çalışma alanını kontrol edin).";
  }
  if (status === 429) return "AI kullanım sınırına ulaşıldı. Birkaç dakika sonra tekrar deneyin.";
  if (status === 400) return `AI isteği reddedildi: ${msg.replace(/^\w+ 400: /, "").slice(0, 200)}`;
  return "AI servisine şu an ulaşılamıyor. Lütfen birkaç dakika sonra tekrar deneyin.";
}

export class AIService {
  constructor(private readonly ctx: AICallContext) {}

  async generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
    const e = env();
    const tier = input.tier ?? "default";
    const system = [SAFETY_RULES, input.system].filter(Boolean).join("\n\n");

    const attempts: Array<{ provider: AIProvider; model: string }> = [];
    if (providerOverride) {
      attempts.push({ provider: providerOverride, model: input.model ?? "test-model" });
    } else {
      if (!isAIConfigured()) {
        throw new AppError(
          "AI_UNAVAILABLE",
          "AI sağlayıcısı yapılandırılmamış. Yöneticiniz .env dosyasına API anahtarını eklemeli.",
        );
      }
      attempts.push({ provider: buildProvider(e.AI_PROVIDER), model: resolveModel(e.AI_PROVIDER, tier, input.model) });
      if (e.AI_FALLBACK_PROVIDER && e.AI_FALLBACK_PROVIDER !== e.AI_PROVIDER) {
        try {
          attempts.push({
            provider: buildProvider(e.AI_FALLBACK_PROVIDER),
            model: resolveModel(e.AI_FALLBACK_PROVIDER, tier, undefined, true),
          });
        } catch {
          // fallback anahtarı yoksa yok say
        }
      }
    }

    let lastError: unknown;
    for (const { provider, model } of attempts) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = Date.now();
        try {
          const result = await provider.generateText({ ...input, system, model });
          await logAIUsage({
            companyId: this.ctx.companyId,
            provider: result.provider,
            model: result.model,
            operation: this.ctx.operation,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs: Date.now() - started,
            success: true,
          });
          return result;
        } catch (err) {
          lastError = err;
          await logAIUsage({
            companyId: this.ctx.companyId,
            provider: provider.name,
            model,
            operation: this.ctx.operation,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: Date.now() - started,
            success: false,
            error: (err as Error).message,
          });
          const retryable = err instanceof AIProviderError && err.retryable;
          if (!retryable) break;
          await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250);
        }
      }
    }

    console.error("[ai] tüm denemeler başarısız", this.ctx.operation, lastError);
    throw new AppError("AI_UNAVAILABLE", describeProviderError(lastError));
  }

  /**
   * Yapılandırılmış veri çıkarma. Çıktı zod şemasıyla doğrulanır; geçersizse
   * hatayı modele gösterip bir kez düzeltme ister.
   */
  async extract<T extends z.ZodTypeAny>(input: ExtractInput<T>): Promise<{ data: z.infer<T>; raw: GenerateTextResult }> {
    const system = `${input.instructions}

ÇIKTI BİÇİMİ: Yalnızca geçerli bir JSON döndür. Açıklama, markdown veya kod bloğu ekleme.
Beklenen yapı:
${input.shape}`;

    const first = await this.generateText({
      system,
      tier: input.tier,
      maxTokens: input.maxTokens ?? 4096,
      temperature: 0,
      messages: [{ role: "user", content: input.input }],
    });

    const tryParse = (text: string) => {
      try {
        return input.schema.safeParse(parseJsonFromText(text));
      } catch (err) {
        return { success: false as const, error: err as Error };
      }
    };

    const parsed = tryParse(first.text);
    if (parsed.success) return { data: parsed.data, raw: first };

    const repair = await this.generateText({
      system,
      tier: input.tier,
      maxTokens: input.maxTokens ?? 4096,
      temperature: 0,
      messages: [
        { role: "user", content: input.input },
        { role: "assistant", content: first.text },
        {
          role: "user",
          content: `Yanıtın beklenen JSON yapısına uymuyor: ${String(parsed.error?.message ?? parsed.error).slice(0, 1500)}\nYalnızca düzeltilmiş JSON'u döndür.`,
        },
      ],
    });
    const second = tryParse(repair.text);
    if (second.success) return { data: second.data, raw: repair };
    throw new AppError("AI_UNAVAILABLE", "AI geçerli bir sonuç üretemedi. Lütfen tekrar deneyin.");
  }

  async summarize(text: string, instruction = "Metni 3-4 cümlede Türkçe özetle.", tier: ModelTier = "fast"): Promise<string> {
    const r = await this.generateText({ tier, system: instruction, maxTokens: 800, messages: [{ role: "user", content: text }] });
    return r.text.trim();
  }

  async classify<L extends string>(
    text: string,
    labels: readonly L[],
    instruction: string,
  ): Promise<{ label: L; confidence: number; reason: string }> {
    const schema = z.object({
      label: z.enum(labels as unknown as [L, ...L[]]),
      confidence: z.number().min(0).max(1),
      reason: z.string(),
    });
    const { data } = await this.extract({
      schema,
      tier: "fast",
      instructions: instruction,
      shape: `{"label": one of ${JSON.stringify(labels)}, "confidence": 0..1, "reason": "kısa gerekçe"}`,
      input: text,
    });
    return data as { label: L; confidence: number; reason: string };
  }

  async embed(texts: string[]): Promise<{ vectors: number[][]; model: string } | null> {
    const provider = getEmbeddingProvider();
    if (!provider || texts.length === 0) return null;
    const started = Date.now();
    try {
      const r = await provider.embed(texts);
      await logAIUsage({
        companyId: this.ctx.companyId,
        provider: provider.name,
        model: r.model,
        operation: `${this.ctx.operation}.embed`,
        inputTokens: r.inputTokens,
        outputTokens: 0,
        durationMs: Date.now() - started,
        success: true,
      });
      return { vectors: r.vectors, model: r.model };
    } catch (err) {
      await logAIUsage({
        companyId: this.ctx.companyId,
        provider: provider.name,
        model: provider.model,
        operation: `${this.ctx.operation}.embed`,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: Date.now() - started,
        success: false,
        error: (err as Error).message,
      });
      // Embedding olmadan tam metin araması çalışmaya devam eder
      console.warn("[ai] embedding başarısız, tam metin aramasına düşülüyor:", (err as Error).message);
      return null;
    }
  }
}

export function ai(ctx: AICallContext): AIService {
  return new AIService(ctx);
}
