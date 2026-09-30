import type { AIProvider, GenerateTextInput, GenerateTextResult } from "../types";
import { AIProviderError } from "../types";
import { postJson } from "./http";

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  stop_reason?: string;
  usage: { input_tokens: number; output_tokens: number };
}

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.anthropic.com",
  ) {
    if (!apiKey) throw new AIProviderError("ANTHROPIC_API_KEY tanımlı değil", "anthropic");
  }

  async generateText(input: GenerateTextInput & { model: string }): Promise<GenerateTextResult> {
    const res = await postJson<AnthropicResponse>(
      "anthropic",
      `${this.baseUrl}/v1/messages`,
      {
        model: input.model,
        max_tokens: input.maxTokens ?? 4096,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.system ? { system: input.system } : {}),
        messages: input.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01" },
      { signal: input.signal },
    );
    return {
      text: res.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join(""),
      provider: this.name,
      model: res.model ?? input.model,
      inputTokens: res.usage?.input_tokens ?? 0,
      outputTokens: res.usage?.output_tokens ?? 0,
      stopReason: res.stop_reason,
    };
  }
}
