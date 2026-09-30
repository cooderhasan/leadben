"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import {
  approveCampaign,
  approveMessages,
  approveStrategy,
  archiveCampaign,
  cancelMessage,
  createCampaign,
  pauseCampaign,
  removeCampaignLead,
  startMessageGeneration,
  startSending,
  startStrategyGeneration,
  updateMessage,
} from "@/server/services/campaigns";
import { campaignCreateSchema, messageEditSchema } from "@/lib/validation";
import type { ActionState } from "@/lib/action-state";

const idOf = (fd: FormData, key = "id") => String(fd.get(key) ?? "");

export async function createCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const result = await safeAction(async () => {
    const ctx = await requireTenant();
    const c = await createCampaign(ctx, parseForm(campaignCreateSchema, fd));
    id = c.id;
    revalidatePath("/campaigns");
  });
  if (result.ok && id) redirect(`/campaigns/${id}`);
  return result;
}

export async function generateStrategyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await startStrategyGeneration(ctx, idOf(fd));
    revalidatePath(`/campaigns/${idOf(fd)}`);
    return { ok: true, message: "Strateji hazırlanıyor." };
  });
}

export async function approveStrategyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const text = (k: string) => {
      const v = fd.get(k);
      return typeof v === "string" && v.trim() ? v.trim().slice(0, 600) : undefined;
    };
    await approveStrategy(ctx, idOf(fd), { valueProposition: text("valueProposition"), callToAction: text("callToAction"), tone: text("tone") });
    revalidatePath(`/campaigns/${idOf(fd)}`);
    return { ok: true, message: "Strateji onaylandı." };
  });
}

export async function generateMessagesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const res = await startMessageGeneration(ctx, idOf(fd));
    revalidatePath(`/campaigns/${idOf(fd)}`);
    return { ok: true, message: res.count > 0 ? `${res.count} mesaj üretiliyor (${res.cost} kredi).` : "Mesaj üretimi zaten sürüyor." };
  });
}

export async function saveMessageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const q = await updateMessage(ctx, parseForm(messageEditSchema, fd));
    revalidatePath("/messages");
    const campaignId = fd.get("campaignId");
    if (typeof campaignId === "string" && campaignId) revalidatePath(`/campaigns/${campaignId}`);
    return q.blocked
      ? { ok: false, error: "Kaydedildi, ancak engelleyici sorun var: " + q.issues.filter((i) => i.severity === "block").map((i) => i.text).join(" ") }
      : { ok: true, message: `Kaydedildi. Kalite puanı: ${q.score}.` };
  });
}

export async function approveMessagesAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const ids = fd.getAll("messageId").filter((v): v is string => typeof v === "string" && v.length > 0);
    const res = await approveMessages(ctx, ids);
    revalidatePath("/messages");
    const campaignId = fd.get("campaignId");
    if (typeof campaignId === "string" && campaignId) revalidatePath(`/campaigns/${campaignId}`);
    if (res.approved === 0 && res.rejected.length > 0) return { ok: false, error: res.rejected[0]!.reason };
    return { ok: true, message: `${res.approved} mesaj onaylandı${res.rejected.length ? `, ${res.rejected.length} mesaj düzenleme bekliyor` : ""}.` };
  });
}

export async function cancelMessageAction(fd: FormData) {
  const ctx = await requireTenant();
  await cancelMessage(ctx, idOf(fd));
  revalidatePath("/messages");
  const campaignId = fd.get("campaignId");
  if (typeof campaignId === "string" && campaignId) revalidatePath(`/campaigns/${campaignId}`);
}

export async function removeCampaignLeadAction(fd: FormData) {
  const ctx = await requireTenant();
  await removeCampaignLead(ctx, idOf(fd), idOf(fd, "leadId"));
  revalidatePath(`/campaigns/${idOf(fd)}`);
}

export async function approveCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await approveCampaign(ctx, idOf(fd));
    revalidatePath(`/campaigns/${idOf(fd)}`);
    return { ok: true, message: "Kampanya onaylandı. Gönderimi başlatabilirsiniz." };
  });
}

export async function startSendingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await startSending(ctx, idOf(fd));
    revalidatePath(`/campaigns/${idOf(fd)}`);
    return { ok: true, message: "Gönderim başladı." };
  });
}

export async function pauseCampaignAction(fd: FormData) {
  const ctx = await requireTenant();
  await pauseCampaign(ctx, idOf(fd));
  revalidatePath(`/campaigns/${idOf(fd)}`);
}

export async function archiveCampaignAction(fd: FormData) {
  const ctx = await requireTenant();
  await archiveCampaign(ctx, idOf(fd));
  revalidatePath("/campaigns");
  redirect("/campaigns");
}
