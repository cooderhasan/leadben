"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { CALL_OUTCOME_LABELS, logCall } from "@/server/services/calls";
import { callLogSchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

export async function logCallAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(callLogSchema, fd);
    const res = await logCall(ctx, input);
    revalidatePath("/calls");
    revalidatePath(`/leads/${input.leadId}`);
    revalidatePath("/tasks");
    const when = res.nextCallAt ? ` · tekrar: ${res.nextCallAt.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", dateStyle: "short", timeStyle: "short" })}` : "";
    return { ok: true, message: `Kaydedildi: ${CALL_OUTCOME_LABELS[input.outcome]}${when}` };
  });
}
