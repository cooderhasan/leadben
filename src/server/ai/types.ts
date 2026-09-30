export type ProviderName = "anthropic" | "openai" | "gemini";
export type ModelTier = "default" | "fast";

export interface AIMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateTextInput {
  system?: string;
  messages: AIMessage[];
  /** Belirtilmezse tier'e göre ortam değişkeninden seçilir. */
  model?: string;
  tier?: ModelTier;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerateTextResult {
  text: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason?: string;
}

export interface EmbedResult {
  vectors: number[][];
  model: string;
  inputTokens: number;
}

/**
 * Düşük seviye sağlayıcı sözleşmesi. Her sağlayıcı yalnızca metin üretimi uygular;
 * extract / classify / summarize / score gibi üst seviye işlemler AIService'te
 * sağlayıcıdan bağımsız olarak generateText üzerine kuruludur.
 */
export interface AIProvider {
  readonly name: ProviderName;
  generateText(input: GenerateTextInput & { model: string }): Promise<GenerateTextResult>;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  embed(texts: string[]): Promise<EmbedResult>;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly status?: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
