import type { EmbeddingProvider, EmbedResult } from "../types";
import { AIProviderError } from "../types";
import { postJson } from "./http";

/** Anthropic'in önerdiği embedding sağlayıcısı. */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = "voyage";
  constructor(
    private readonly apiKey: string,
    readonly model = "voyage-3.5",
  ) {
    if (!apiKey) throw new AIProviderError("VOYAGE_API_KEY tanımlı değil", "voyage");
  }

  async embed(texts: string[]): Promise<EmbedResult> {
    const res = await postJson<{ data: Array<{ embedding: number[]; index: number }>; model: string; usage?: { total_tokens: number } }>(
      "voyage",
      "https://api.voyageai.com/v1/embeddings",
      { input: texts, model: this.model, input_type: "document" },
      { authorization: `Bearer ${this.apiKey}` },
    );
    return {
      vectors: res.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
      model: res.model ?? this.model,
      inputTokens: res.usage?.total_tokens ?? 0,
    };
  }
}
