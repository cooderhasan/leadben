import type { AIProvider, EmbeddingProvider, EmbedResult, GenerateTextInput, GenerateTextResult } from "../types";
import { AIProviderError } from "../types";
import { postJson } from "./http";

const BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  modelVersion?: string;
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini" as const;
  constructor(private readonly apiKey: string) {
    if (!apiKey) throw new AIProviderError("GEMINI_API_KEY tanımlı değil", "gemini");
  }

  async generateText(input: GenerateTextInput & { model: string }): Promise<GenerateTextResult> {
    const res = await postJson<GeminiResponse>(
      "gemini",
      `${BASE}/models/${encodeURIComponent(input.model)}:generateContent`,
      {
        ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
        contents: input.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          maxOutputTokens: input.maxTokens ?? 4096,
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        },
      },
      { "x-goog-api-key": this.apiKey },
      { signal: input.signal },
    );
    const cand = res.candidates?.[0];
    return {
      text: cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "",
      provider: this.name,
      model: res.modelVersion ?? input.model,
      inputTokens: res.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      stopReason: cand?.finishReason,
    };
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = "gemini";
  constructor(
    private readonly apiKey: string,
    readonly model = "gemini-embedding-001",
  ) {
    if (!apiKey) throw new AIProviderError("GEMINI_API_KEY tanımlı değil", "gemini");
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const res = await postJson<{ embeddings: Array<{ values: number[] }> }>(
      "gemini",
      `${BASE}/models/${encodeURIComponent(this.model)}:batchEmbedContents`,
      {
        requests: texts.map((t) => ({
          model: `models/${this.model}`,
          content: { parts: [{ text: t }] },
          outputDimensionality: 1536,
        })),
      },
      { "x-goog-api-key": this.apiKey },
    );
    return { vectors: res.embeddings.map((e) => e.values), model: this.model, inputTokens: 0 };
  }
}
