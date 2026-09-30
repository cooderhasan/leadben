import "server-only";
import { rawDb } from "@/server/db";
import { estimateCostUsd } from "./pricing";

export interface AIUsageEntry {
  companyId: string | null;
  provider: string;
  model: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

/** Her AI çağrısını loglar (spec §99). Log hatası ana işlemi durdurmaz. */
export async function logAIUsage(e: AIUsageEntry): Promise<void> {
  try {
    await rawDb.aIUsageLog.create({
      data: {
        companyId: e.companyId,
        provider: e.provider,
        model: e.model,
        operation: e.operation,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        estimatedCostUsd: estimateCostUsd(e.model, e.inputTokens, e.outputTokens),
        durationMs: e.durationMs,
        success: e.success,
        error: e.error?.slice(0, 1000),
      },
    });
  } catch (err) {
    console.error("[ai-usage] yazılamadı", err);
  }
}
