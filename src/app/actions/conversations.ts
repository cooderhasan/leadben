"use server";

import { revalidatePath } from "next/cache";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { addManualReply, draftReply, sendReply } from "@/server/services/conversations";
import { cancelFollowUp } from "@/server/services/followups";
import { manualReplySchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

export async function addReplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const input = parseForm(manualReplySchema, fd);
    await addManualReply(ctx, input);
    revalidatePath(`/leads/${input.leadId}`);
    revalidatePath("/messages");
    return { ok: true, message: "Yanıt eklendi. AI sınıflandırıyor; gerekirse görev ve fırsat oluşturulacak." };
  });
}

export async function draftReplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const id = String(fd.get("conversationId") ?? "");
    await draftReply(ctx, id);
    revalidatePath(`/messages/c/${id}`);
    return { ok: true, message: "Taslak hazır (1 kredi). Kontrol edip onaylayın." };
  });
}

export async function sendReplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await sendReply(ctx, String(fd.get("messageId") ?? ""));
    const conv = fd.get("conversationId");
    if (typeof conv === "string" && conv) revalidatePath(`/messages/c/${conv}`);
    return { ok: true, message: "Gönderim başladı." };
  });
}

export async function cancelFollowUpAction(fd: FormData) {
  const ctx = await requireTenant();
  await cancelFollowUp(ctx, String(fd.get("id")));
  const leadId = fd.get("leadId");
  if (typeof leadId === "string" && leadId) revalidatePath(`/leads/${leadId}`);
  const campaignId = fd.get("campaignId");
  if (typeof campaignId === "string" && campaignId) revalidatePath(`/campaigns/${campaignId}`);
}
