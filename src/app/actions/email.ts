"use server";

import { revalidatePath } from "next/cache";
import type { CommunicationBasis, SuppressionType } from "@prisma/client";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { runSenderDomainCheck, saveSenderSettings } from "@/server/services/email-settings";
import { addSuppressionByUser, removeSuppression, reviewComplianceRecord } from "@/server/services/compliance";
import { sendTestEmail } from "@/server/services/campaign-send";
import { senderSettingsSchema } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import type { ActionState } from "@/lib/action-state";

const SUPPRESSION_TYPES: SuppressionType[] = ["EMAIL", "DOMAIN", "PHONE"];
const BASES: CommunicationBasis[] = ["B2B_TRADER_ADDRESS", "EXPLICIT_CONSENT", "EXISTING_RELATIONSHIP", "INBOUND_REQUEST"];

export async function saveSenderAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await saveSenderSettings(ctx, parseForm(senderSettingsSchema, fd));
    revalidatePath("/settings/email");
    return { ok: true, message: "Gönderici bilgileri kaydedildi." };
  });
}

export async function checkDomainAction(_: ActionState): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const dns = await runSenderDomainCheck(ctx);
    revalidatePath("/settings/email");
    return dns.spf === "pass" && dns.dmarc === "pass"
      ? { ok: true, message: "SPF ve DMARC kayıtları bulundu." }
      : { ok: false, error: dns.notes.slice(0, 2).join(" ") };
  });
}

export async function sendTestEmailAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const res = await sendTestEmail(ctx, String(fd.get("to") ?? ""));
    return { ok: true, message: `Test e-postası ${res.to} adresine gönderildi. Gelen kutusunu ve spam klasörünü kontrol edin (birkaç dakika sürebilir).` };
  });
}

export async function addSuppressionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const type = String(fd.get("type")) as SuppressionType;
    if (!SUPPRESSION_TYPES.includes(type)) throw new AppError("VALIDATION", "Geçersiz tür.");
    const res = await addSuppressionByUser(ctx, { type, value: String(fd.get("value") ?? ""), reason: String(fd.get("reason") ?? "") || null });
    revalidatePath("/settings/email");
    return { ok: true, message: `Engel listesine eklendi${res.cancelled ? `; ${res.cancelled} bekleyen mesaj iptal edildi` : ""}.` };
  });
}

export async function removeSuppressionAction(fd: FormData) {
  const ctx = await requireTenant();
  await removeSuppression(ctx, String(fd.get("id")));
  revalidatePath("/settings/email");
}

export async function reviewComplianceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const basis = String(fd.get("basis")) as CommunicationBasis;
    if (!BASES.includes(basis)) throw new AppError("VALIDATION", "İletişim dayanağı seçin.", { basis: "Seçin" });
    const rec = await reviewComplianceRecord(ctx, String(fd.get("id")), basis);
    const leadId = fd.get("leadId");
    if (typeof leadId === "string" && leadId) revalidatePath(`/leads/${leadId}`);
    const campaignId = fd.get("campaignId");
    if (typeof campaignId === "string" && campaignId) revalidatePath(`/campaigns/${campaignId}`);
    return { ok: true, message: rec?.status === "SENDABLE" ? "Adres gönderilebilir olarak işaretlendi." : `Durum: ${rec?.reasons[0] ?? "güncellendi"}` };
  });
}
