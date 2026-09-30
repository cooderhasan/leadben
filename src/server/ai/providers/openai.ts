import type { AIProvider, EmbeddingProvider, EmbedResult, GenerateTextInput, GenerateTextResult } from "../types";
import { AIProviderError } from "../types";
import { postJson } from "./http";

interface ChatResponse {
  model: string;
  choices: Array<{ message: { content: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface EmbeddingResponse {
  model: string;
  data: Array<{ embedding: number[]; index: number }>;
  usage?: { prompt_tokens: number };
}

export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.openai.com/v1",
  ) {
    if (!apiKey) throw new AIProviderError("OPENAI_API_KEY tanımlı değil", "openai");
  }

  async generateText(input: GenerateTextInput & { model: string }): Promise<GenerateTextResult> {
    const messages = [
      ...(input.system ? [{ role: "system", content: input.system }] : []),
      ...input.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const res = await postJson<ChatResponse>(
      "openai",
      `${this.baseUrl}/chat/completions`,
      {
        model: input.model,
        messages,
        max_completion_tokens: input.maxTokens ?? 4096,
        // OpenAI uyumlu diğer servisler (OpenRouter vb.) max_tokens okur
        ...(this.baseUrl.includes("api.openai.com") ? {} : { max_tokens: input.maxTokens ?? 4096 }),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      },
      { authorization: `Bearer ${this.apiKey}` },
      { signal: input.signal },
    );
    return {
      text: res.choices[0]?.message.content ?? "",
      provider: this.name,
      model: res.model ?? input.model,
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      stopReason: res.choices[0]?.finish_reason,
    };
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  constructor(
    private readonly apiKey: string,
    readonly model = "text-embedding-3-small",
  ) {
    if (!apiKey) throw new AIProviderError("OPENAI_API_KEY tanımlı değil", "openai");
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const res = await postJson<EmbeddingResponse>(
      "openai",
      "https://api.openai.com/v1/embeddings",
      { model: this.model, input: texts },
      { authorization: `Bearer ${this.apiKey}` },
    );
    return {
      vectors: res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
      model: res.model ?? this.model,
      inputTokens: res.usage?.prompt_tokens ?? 0,
    };
  }
}
