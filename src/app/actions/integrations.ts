"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireTenant } from "@/server/tenancy/context";
import { parseForm, safeAction } from "@/server/actions/safe-action";
import { createApiKey, createWebhook, deleteWebhook, revokeApiKey, sendTestWebhook } from "@/server/services/integrations";
import type { ActionState } from "@/lib/action-state";

const keySchema = z.object({ name: z.string().trim().min(2, "Ad girin").max(100), scope: z.enum(["read", "write"]) });

/** Başarıda `message` alanı tam anahtarı taşır — ekranda bir kez gösterilir, saklanmaz. */
export async function createApiKeyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const { key } = await createApiKey(ctx, parseForm(keySchema, fd));
    revalidatePath("/settings/api");
    return { ok: true, message: key };
  });
}

export async function revokeApiKeyAction(fd: FormData) {
  const ctx = await requireTenant();
  await revokeApiKey(ctx, String(fd.get("id")));
  revalidatePath("/settings/api");
}

const webhookSchema = z.object({
  url: z.string().trim().min(8, "Adres girin").max(1000),
  events: z.preprocess((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]), z.array(z.string()).min(1, "En az bir olay seçin")),
});

/** Başarıda `message` alanı imza anahtarını taşır — bir kez gösterilir. */
export async function createWebhookAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    const { secret } = await createWebhook(ctx, parseForm(webhookSchema, fd));
    revalidatePath("/settings/api");
    return { ok: true, message: secret };
  });
}

export async function deleteWebhookAction(fd: FormData) {
  const ctx = await requireTenant();
  await deleteWebhook(ctx, String(fd.get("id")));
  revalidatePath("/settings/api");
}

export async function testWebhookAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return safeAction(async () => {
    const ctx = await requireTenant();
    await sendTestWebhook(ctx, String(fd.get("id")));
    revalidatePath("/settings/api");
    return { ok: true, message: "Test olayı gönderildi; sonucu birkaç saniye içinde listede görürsünüz." };
  });
}
