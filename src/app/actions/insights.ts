"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/server/tenancy/context";
import { safeAction } from "@/server/actions/safe-action";
import { askAssistant, dismissInsight, generateReport, type ChatTurn } from "@/server/services/insights";
import type { ActionState } from "@/lib/action-state";

export async function generateReportAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const period = [7, 30, 90].includes(Number(fd.get("period"))) ? Number(fd.get("period")) : 30;
    const res = await generateReport(ctx, period);
    revalidatePath("/reports");
    return {
      ok: true,
      message: `${res.created} içgörü oluşturuldu${res.dropped ? `; verilerle doğrulanamayan ${res.dropped} içgörü atıldı` : ""}.`,
    };
  });
}

export async function dismissInsightAction(fd: FormData) {
  const ctx = await requireTenant();
  await dismissInsight(ctx, String(fd.get("id")));
  revalidatePath("/reports");
}

export async function askAssistantAction(
  question: string,
  history: ChatTurn[],
): Promise<{ ok: true; answer: string; warning: string | null } | { ok: false; error: string }> {
  let out: { answer: string; warning: string | null } | null = null;
  const res = await safeAction(async () => {
    const ctx = await requireTenant();
    const safeHistory = (Array.isArray(history) ? history : [])
      .filter((t) => (t?.role === "user" || t?.role === "assistant") && typeof t.content === "string")
      .slice(-6);
    out = await askAssistant(ctx, String(question ?? ""), safeHistory);
  });
  if (!res.ok || !out) return { ok: false, error: res.error ?? "Beklenmeyen bir hata oluştu." };
  const { answer, warning } = out;
  return { ok: true, answer, warning };
}
