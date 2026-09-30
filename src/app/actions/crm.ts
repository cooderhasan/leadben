"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { createOpportunity, createTaskByUser, setTaskStatus, updateOpportunity } from "@/server/services/crm";
import { opportunityUpdateSchema, taskCreateSchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

export async function updateOpportunityAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await updateOpportunity(ctx, parseForm(opportunityUpdateSchema, fd));
    revalidatePath("/pipeline");
    return { ok: true, message: "Kaydedildi." };
  });
}

export async function createOpportunityAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const leadId = String(fd.get("leadId") ?? "");
    await createOpportunity(ctx, { leadId });
    revalidatePath("/pipeline");
    revalidatePath(`/leads/${leadId}`);
    return { ok: true, message: "Fırsat oluşturuldu." };
  });
}

export async function createTaskAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(taskCreateSchema, fd);
    await createTaskByUser(ctx, input);
    revalidatePath("/tasks");
    if (input.leadId) revalidatePath(`/leads/${input.leadId}`);
    return { ok: true, message: "Görev eklendi." };
  });
}

export async function setTaskStatusAction(fd: FormData) {
  const ctx = await requireTenant();
  const status = String(fd.get("status"));
  await setTaskStatus(ctx, String(fd.get("id")), status === "DONE" ? "DONE" : status === "CANCELLED" ? "CANCELLED" : "OPEN");
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
}
