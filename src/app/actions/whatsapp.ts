"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { replyWhatsApp, saveWhatsAppSettings, sendWhatsAppTemplate } from "@/server/services/whatsapp";
import type { ActionState } from "@/lib/action-state";

const settingsSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{6,30}$/, "Telefon numarası kimliği (Phone number ID) yalnızca rakam"),
  wabaId: z.string().trim().regex(/^\d{6,30}$/, "WhatsApp Business hesap kimliği yalnızca rakam"),
  accessToken: z.string().trim().max(1000).optional(),
  appSecret: z.string().trim().max(200).optional(),
});

export async function saveWhatsAppAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await saveWhatsAppSettings(ctx, parseForm(settingsSchema, fd));
    revalidatePath("/settings/whatsapp");
    return { ok: true, message: "Bağlantı doğrulandı ve kaydedildi." };
  });
}

export async function replyWhatsAppAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const conversationId = String(fd.get("conversationId") ?? "");
    await replyWhatsApp(ctx, conversationId, String(fd.get("body") ?? ""));
    revalidatePath(`/messages/c/${conversationId}`);
    return { ok: true, message: "Gönderiliyor…" };
  });
}

export async function sendTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let leadId = "";
  const res = await safeAction(async (): Promise<ActionState | void> => {
    const ctx = await requireTenant();
    const [templateName, language] = String(fd.get("template") ?? "").split("|");
    if (!templateName || !language) return { ok: false, error: "Şablon seçin.", fieldErrors: { template: "Seçin" } };
    const params = fd.getAll("param").map((p) => String(p).trim());
    if (params.some((p) => !p)) return { ok: false, error: "Tüm şablon alanlarını doldurun.", fieldErrors: { param: "Boş alan" } };
    await sendWhatsAppTemplate(ctx, { contactId: String(fd.get("contactId") ?? ""), templateName, language, params });
    leadId = String(fd.get("leadId") ?? "");
  });
  if (res.ok && leadId) redirect(`/leads/${leadId}`);
  return res;
}
